import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, X, ChevronRight, Network, Settings, Palette, Trash2 } from 'lucide-react'
import { apiFetch, deleteEngram } from '../api'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { useNovaIdentity } from '../hooks/useNovaIdentity'
import { useToast } from '../components/ToastProvider'
import { BrainChat } from '../components/BrainChat'
import { ForceGraph3D } from '../components/ForceGraph3D'
import type { ForceGraph3DHandle } from '../components/ForceGraph3D'
import type { ActivityStep } from '../stores/chat-store'

// ── Types ────────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string
  type: string
  importance: number
  cluster_id?: number
  cluster_label?: string
  // Full fields — only present from full endpoint or detail fetch
  content?: string
  activation?: number
  access_count?: number
  confidence?: number
  source_type?: string
  superseded?: boolean
  created_at?: string | null
}

interface GraphEdge {
  source: string
  target: string
  weight: number
  relation?: string
}

interface ClusterInfo {
  id: number
  label: string
  count: number
}

interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  clusters?: ClusterInfo[]
  node_count: number
  edge_count: number
}

// ── Constants ────────────────────────────────────────────────────────────────

// Single clustered layout — topic clustering force handles spatial grouping

const TYPE_COLORS: Record<string, string> = {
  fact:       '#60a5fa',
  entity:     '#2dd4bf',
  preference: '#34d399',
  procedure:  '#a1a1aa',
  self_model: '#818cf8',
  episode:    '#fbbf24',
  schema:     '#f87171',
  goal:       '#c084fc',
}

const TYPE_FILTER_CLASSES: Record<string, string> = {
  fact: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  entity: 'bg-teal-500/20 text-teal-300 border-teal-500/30',
  preference: 'bg-green-500/20 text-green-300 border-green-500/30',
  procedure: 'bg-stone-500/20 text-stone-300 border-stone-500/30',
  self_model: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  episode: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  schema: 'bg-red-500/20 text-red-300 border-red-500/30',
  goal: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
}

const TYPE_DESCRIPTIONS: Record<string, string> = {
  fact:       'Objective knowledge or information Nova has learned',
  self_model: "Nova's self-knowledge and identity traits",
  procedure:  'How-to knowledge and learned workflows',
  entity:     'Named people, systems, or concepts',
  preference: 'User preferences and communication style',
  episode:    'Specific past interactions or events',
  schema:     'Patterns extracted from repeated experiences',
  goal:       'Objectives or intentions Nova is tracking',
}

const CLUSTER_COLORS = [
  '#818cf8', '#60a5fa', '#2dd4bf', '#34d399', '#fbbf24',
  '#f87171', '#c084fc', '#fb923c', '#a3e635', '#22d3ee',
  '#e879f9', '#f472b6', '#38bdf8', '#4ade80', '#facc15',
  '#a78bfa', '#67e8f9', '#fca5a5', '#86efac', '#fde68a',
]

const SCORE_TOOLTIPS: Record<string, string> = {
  Activation: 'How "hot" this memory is — rises when accessed, decays over time.',
  Importance: 'How critical for decisions — affects retrieval frequency.',
  Confidence: 'How certain Nova is this memory is accurate.',
}

// ── Score bar (glass-styled for overlay) ─────────────────────────────────────

function ScoreBar({ value, label, color }: { value: number; label: string; color: string }) {
  const pct = Math.round(Math.min(Math.max(value, 0), 1) * 100)
  return (
    <div className="flex items-center gap-2" title={SCORE_TOOLTIPS[label] ?? `${label}: ${pct}%`}>
      <span className="text-[11px] text-stone-500 w-[4.5rem] shrink-0">{label}</span>
      <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="text-[10px] text-stone-600 w-7 text-right">{pct}%</span>
    </div>
  )
}

// ── Component ────────────────────────────────────────────────────────────────

export default function Brain({ hidden = false }: { hidden?: boolean }) {
  const graphRef = useRef<ForceGraph3DHandle>(null)
  const { avatarUrl } = useNovaIdentity()
  const [sidebarCollapsed] = useLocalStorage('nova-sidebar-collapsed', false)

  const qc = useQueryClient()
  const { addToast } = useToast()

  // UI state
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [confirmingForget, setConfirmingForget] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const layout = 'clustered'
  const [searchQuery, setSearchQuery] = useState('')
  const [searchActive, setSearchActive] = useState(false)
  const [focusCluster, setFocusCluster] = useState<{ id: number; ts: number } | null>(null)
  const [expandedClusterId, setExpandedClusterId] = useState<number | null>(null)
  const [focusNode, setFocusNode] = useState<{ id: string; ts: number } | null>(null)
  const [showBgStars, setShowBgStars] = useLocalStorage('brain.showBgStars', true)
  const [showNebulae, setShowNebulae] = useLocalStorage('brain.showNebulae', true)
  const [showEdges, setShowEdges] = useLocalStorage('brain.showEdges', false)
  const [showCelestialObjects, setShowCelestialObjects] = useLocalStorage('brain.showCelestialObjects', true)
  const [showClusterGalaxies, setShowClusterGalaxies] = useLocalStorage('brain.showClusterGalaxies', false)
  const [showMilkyWay, setShowMilkyWay] = useLocalStorage('brain.showMilkyWay', true)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [colorBy, setColorBy] = useState<'type' | 'source'>(() => {
    try { return (localStorage.getItem('nova_brain_color_by') as 'type' | 'source') || 'type' } catch { return 'type' }
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [topicsOpen, setTopicsOpen] = useState(false)
  const [rawBloom, setBloomStrength] = useLocalStorage('brain.bloomStrength', 0.2)
  const bloomStrength = Math.min(rawBloom, 1.0)
  const [nodeLimit, setNodeLimit] = useLocalStorage('brain.nodeLimit', 500)

  const { data: engramStats } = useQuery<{
    total_engrams: number
    total_edges: number
    total_archived: number
    by_type: Record<string, { total: number; superseded: number }>
  }>({
    queryKey: ['engram-stats'],
    queryFn: () => apiFetch('/mem/api/v1/engrams/stats'),
    staleTime: 30_000,
  })

  // Graph data — include superseded engrams when requesting more than 5k (i.e., "All")
  const includeAll = nodeLimit > 5000
  const { data: graph } = useQuery<GraphData>({
    queryKey: ['brain-graph', nodeLimit, includeAll],
    queryFn: () => apiFetch(`/mem/api/v1/engrams/graph/lightweight?max_nodes=${nodeLimit}${includeAll ? '&include_superseded=true' : ''}`),
    staleTime: 30_000,
    retry: 1,
  })

  // Search-filtered graph
  const { data: searchGraph } = useQuery<GraphData>({
    queryKey: ['brain-graph-search', searchQuery],
    queryFn: () => apiFetch(`/mem/api/v1/engrams/graph?query=${encodeURIComponent(searchQuery)}&depth=2&max_nodes=200`),
    enabled: searchActive && searchQuery.length > 2,
    staleTime: 10_000,
  })

  const activeGraph = searchActive && searchGraph ? searchGraph : graph

  // Progressive enhancement — cap expensive effects at high node counts
  const nodeCount = activeGraph?.nodes.length ?? 0
  const perf = useMemo(() => {
    if (nodeCount > 1000) return {
      showEdges,
      bloomStrength: Math.min(bloomStrength, 1.0),
      particlesAlways: false,
    }
    if (nodeCount > 500) return {
      showEdges,
      bloomStrength: Math.min(bloomStrength, 1.0),
      particlesAlways: false,
    }
    return {
      showEdges,
      bloomStrength,
      particlesAlways: true,
    }
  }, [nodeCount, showEdges, bloomStrength])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        setChatOpen(o => !o)
      }
      if (e.key === 'Escape') {
        if (settingsOpen) setSettingsOpen(false)
        else if (topicsOpen) setTopicsOpen(false)
        else if (chatOpen) setChatOpen(false)
        else if (selectedNode) setSelectedNode(null)
        else if (searchActive) { setSearchActive(false); setSearchQuery('') }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [chatOpen, searchActive, selectedNode, settingsOpen, topicsOpen])

  // Activity step handler — highlights actual retrieved engrams when IDs are available
  const handleActivityStep = useCallback((_step: ActivityStep) => {
    if (_step.step === 'memory' && _step.state === 'running') {
      graphRef.current?.pulseAll(1500)
    }
    if (_step.step === 'memory' && _step.state === 'done') {
      let nodesToHighlight: string[] = []

      // Prefer real engram IDs if available
      if (_step.engram_ids?.length && activeGraph?.nodes) {
        const graphNodeIds = new Set(activeGraph.nodes.map(n => n.id))
        nodesToHighlight = _step.engram_ids.filter(id => graphNodeIds.has(id))
      }

      // Fallback: random nodes for visual effect
      if (nodesToHighlight.length === 0 && activeGraph?.nodes?.length) {
        const shuffled = [...activeGraph.nodes].sort(() => Math.random() - 0.5)
        nodesToHighlight = shuffled.slice(0, Math.min(25, shuffled.length)).map(n => n.id)
      }

      if (nodesToHighlight.length > 0) {
        // Fire nodes in staggered cascade — looks like neurons firing
        const batch1 = nodesToHighlight.slice(0, 8)
        const batch2 = nodesToHighlight.slice(8, 16)
        const batch3 = nodesToHighlight.slice(16)

        graphRef.current?.highlightNodes(batch1)
        if (batch2.length > 0) {
          setTimeout(() => graphRef.current?.highlightNodes(batch2), 300)
        }
        if (batch3.length > 0) {
          setTimeout(() => graphRef.current?.highlightNodes(batch3), 600)
        }
      }
    }
    if (_step.step === 'generating' && _step.state === 'running') {
      graphRef.current?.pulseAll(2000)
    }
  }, [activeGraph])

  // No-op: don't invalidate graph on stream complete to keep the view stable
  const handleStreamComplete = useCallback(() => {}, [])

  // Track previous node IDs for fade-in animation
  const prevNodeIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!activeGraph?.nodes) return
    const currentIds = new Set(activeGraph.nodes.map(n => n.id))
    if (prevNodeIdsRef.current.size > 0) {
      const newIds = activeGraph.nodes
        .filter(n => !prevNodeIdsRef.current.has(n.id))
        .map(n => n.id)
      if (newIds.length > 0) {
        graphRef.current?.fadeInNodes(newIds)
      }
    }
    prevNodeIdsRef.current = currentIds
  }, [activeGraph])

  // Selected node data (graph has truncated content)
  const selectedNodeBasic = selectedNode
    ? activeGraph?.nodes.find(n => n.id === selectedNode) ?? null
    : null

  const { data: routerStatus } = useQuery<{ observation_count: number }>({
    queryKey: ['engram-router-status'],
    queryFn: () => apiFetch('/mem/api/v1/engrams/router-status'),
    staleTime: 30_000,
  })

  // Fetch full engram detail (untruncated content) when a node is selected
  const { data: selectedNodeFull } = useQuery({
    queryKey: ['engram-detail', selectedNode],
    queryFn: () => apiFetch<GraphNode>(`/mem/api/v1/engrams/engrams/${selectedNode}`),
    enabled: !!selectedNode,
    staleTime: 60_000,
  })

  const forgetMutation = useMutation({
    mutationFn: deleteEngram,
    onSuccess: () => {
      addToast({ variant: 'success', message: 'Engram forgotten' })
      setSelectedNode(null)
      setConfirmingForget(false)
      qc.invalidateQueries({ queryKey: ['brain-graph'] })
      qc.invalidateQueries({ queryKey: ['brain-graph-search'] })
      qc.invalidateQueries({ queryKey: ['engram-stats'] })
    },
    onError: (err) => {
      addToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to forget engram',
      })
    },
  })

  // Reset confirmation when navigating to a different node
  useEffect(() => {
    setConfirmingForget(false)
  }, [selectedNode])

  // Merge: overlay full detail fields onto graph node data
  const selectedNodeData = selectedNodeBasic
    ? { ...selectedNodeBasic, ...selectedNodeFull }
    : null

  // Handle search submit
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (searchQuery.trim().length > 2) {
      setSearchActive(true)
    }
  }

  const clearSearch = () => {
    setSearchActive(false)
    setSearchQuery('')
  }

  // Mark the highest-importance node in each cluster as the "representative"
  // for topic labels in the 3D graph. Max 20 labels to keep it clean.
  const graphWithClusterReps = useMemo(() => {
    if (!activeGraph?.nodes) return activeGraph
    const bestPerCluster = new Map<number, { id: string; importance: number }>()
    for (const node of activeGraph.nodes) {
      if (node.cluster_id == null || !node.cluster_label) continue
      const current = bestPerCluster.get(node.cluster_id)
      if (!current || node.importance > current.importance) {
        bestPerCluster.set(node.cluster_id, { id: node.id, importance: node.importance })
      }
    }
    // Keep only top 20 clusters by importance of their representative
    const topReps = new Set(
      [...bestPerCluster.values()]
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 20)
        .map(r => r.id)
    )
    const annotatedNodes = activeGraph.nodes.map(n => ({
      ...n,
      _isClusterRep: topReps.has(n.id),
    }))
    return { ...activeGraph, nodes: annotatedNodes }
  }, [activeGraph])

  const filteredGraphData = useMemo(() => {
    if (!graphWithClusterReps || !typeFilter) return graphWithClusterReps
    const filteredNodes = graphWithClusterReps.nodes.filter(n => n.type === typeFilter)
    const nodeIds = new Set(filteredNodes.map(n => n.id))
    const filteredEdges = graphWithClusterReps.edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))
    return { ...graphWithClusterReps, nodes: filteredNodes, edges: filteredEdges }
  }, [graphWithClusterReps, typeFilter])

  // Freeze graph data while hidden — prevents ForceGraph3D from re-initializing
  // (and losing camera position) when React Query refetches in the background.
  const frozenGraphRef = useRef(filteredGraphData)
  if (!hidden) frozenGraphRef.current = filteredGraphData
  if (!frozenGraphRef.current) frozenGraphRef.current = filteredGraphData
  const displayGraph = frozenGraphRef.current

  // Loading state — stays true until ForceGraph3D has actually rendered a frame
  const [graphReady, setGraphReady] = useState(false)
  const handleGraphReady = useCallback(() => setGraphReady(true), [])

  // Navigate to node (explore from here)
  const exploreNode = (nodeId: string) => {
    setFocusNode({ id: nodeId, ts: Date.now() })
  }

  // Connections for selected node
  const selectedConnections = selectedNodeData && activeGraph
    ? activeGraph.edges.filter(e => e.source === selectedNodeData.id || e.target === selectedNodeData.id)
    : []

  const nodeColor = selectedNodeData
    ? TYPE_COLORS[selectedNodeData.type] ?? '#71717a'
    : '#71717a'

  return (
    <div className="relative w-full h-screen overflow-hidden bg-black pt-[52px]">
      {/* Full-viewport graph */}
      <ForceGraph3D
        ref={graphRef}
        nodes={displayGraph?.nodes ?? []}
        edges={displayGraph?.edges ?? []}
        clusters={displayGraph?.clusters}
        selectedId={selectedNode}
        onSelectNode={setSelectedNode}
        onBackgroundClick={() => setSelectedNode(null)}
        focusClusterId={focusCluster?.id ?? null}
        focusClusterTs={focusCluster?.ts}
        focusNodeId={focusNode?.id ?? null}
        focusNodeTs={focusNode?.ts}
        autoSpin={false}
        paused={hidden}
        onReady={handleGraphReady}
        bgColor="galaxy"
        layoutPreset={layout}
        neuralMode={{
          enabled: true,
          breathingRate: 0.02,
          breathingAmplitude: 0.05,
          bloomStrength: perf.bloomStrength,
          particlesAlways: perf.particlesAlways,
        }}
        showBackgroundStars={showBgStars}
        showInnerStars={false}
        showNebulae={showNebulae}
        showEdges={perf.showEdges}
        showCelestialObjects={showCelestialObjects}
        showClusterGalaxies={showClusterGalaxies}
        showMilkyWay={showMilkyWay}
        showAsteroids={false}
        showSolarSystems={false}
        colorBy={colorBy}
        className="w-full h-full"
      />

      {/* ── Loading overlay ─────────────────────────────────────────── */}
      {!graphReady && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black">
          <div className="relative w-20 h-20">
            <div className="absolute inset-0 rounded-full border border-teal-500/20" />
            <div
              className="absolute inset-0 rounded-full border-t-2 border-teal-400/60 animate-spin"
              style={{ animationDuration: '2s' }}
            />
            <div className="absolute inset-3 rounded-full border border-teal-500/10" />
            <div
              className="absolute inset-3 rounded-full border-t border-teal-300/40 animate-spin"
              style={{ animationDuration: '3s', animationDirection: 'reverse' }}
            />
            <div className="absolute inset-7 rounded-full bg-teal-500/15 animate-pulse" />
          </div>
          <p className="mt-6 text-stone-600 text-xs tracking-wider uppercase">Initializing Brain</p>
        </div>
      )}

      {/* ── HUD: Glass top bar ──────────────────────────────────────── */}
      <div className="fixed top-0 left-0 right-0 z-10 h-[52px] flex items-center px-5 glass-overlay border-b border-white/[0.12] border-t-white/[0.20]">
        {/* Logo mark */}
        <img src={avatarUrl} alt="Nova" className="w-7 h-7 rounded-full object-cover mr-2 shrink-0" />
        <span className="text-base font-semibold text-stone-200 shrink-0">Brain</span>

        {/* Center stats */}
        <div className="flex-1 text-center text-xs font-mono text-stone-400 truncate px-4">
          {engramStats ? (
            <>
              {activeGraph && activeGraph.nodes.length < engramStats.total_engrams
                ? <>{activeGraph.nodes.length.toLocaleString()} <span className="text-stone-600">of</span> {engramStats.total_engrams.toLocaleString()} memories</>
                : <>{engramStats.total_engrams.toLocaleString()} memories</>
              }
              {' \u00b7 '}{engramStats.total_edges.toLocaleString()} edges
              {' \u00b7 '}{activeGraph?.clusters?.length ?? 0} topics
              {engramStats.total_archived > 0 && <> {' \u00b7 '}{engramStats.total_archived} archived</>}
              {routerStatus && routerStatus.observation_count > 0 && <> {' \u00b7 '}{routerStatus.observation_count} router obs</>}
            </>
          ) : (
            <span className="text-stone-600">loading...</span>
          )}
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setTopicsOpen(v => !v)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors duration-150
              ${topicsOpen
                ? 'bg-teal-500 text-white'
                : 'bg-stone-800 text-stone-400 hover:text-stone-300'}`}
          >
            Explore
          </button>
          <button
            onClick={() => setChatOpen(c => !c)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors duration-150 ${
              chatOpen
                ? 'bg-teal-500 text-white'
                : 'bg-stone-800 text-stone-400 hover:text-stone-300'
            }`}
          >
            Chat
          </button>
          <div className="w-px h-5 bg-white/10 mx-0.5" />
          <button
            onClick={() => {
              const next = colorBy === 'type' ? 'source' : 'type'
              setColorBy(next)
              try { localStorage.setItem('nova_brain_color_by', next) } catch {}
            }}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors duration-150 ${
              colorBy === 'source'
                ? 'text-teal-400 bg-teal-500/15'
                : 'text-stone-500 hover:text-stone-300 hover:bg-white/5'
            }`}
            title={`Color by: ${colorBy}`}
          >
            <Palette size={15} />
          </button>
          <button
            onClick={() => setSettingsOpen(v => !v)}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors duration-150 ${
              settingsOpen
                ? 'text-teal-400 bg-teal-500/15'
                : 'text-stone-500 hover:text-stone-300 hover:bg-white/5'
            }`}
            title="Display settings"
          >
            <Settings size={15} />
          </button>
        </div>
      </div>


      {/* ── Overlay: Topics & Search ───────────────────────────────── */}
      {topicsOpen && (
          <div className="fixed top-[72px] w-[440px] max-h-[calc(100vh-92px)]
                          z-20 rounded-2xl glass-overlay
                          border border-white/[0.12] border-t-white/[0.20]
                          p-5 overflow-y-auto scrollbar-thin
                          animate-[scaleIn_150ms_ease-out]"
               style={{ left: sidebarCollapsed ? 76 : 256 }}>
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-stone-400">
                Memory Explorer
              </span>
              <button
                onClick={() => setTopicsOpen(false)}
                className="w-6 h-6 rounded-md flex items-center justify-center
                           text-stone-500 hover:text-stone-200 hover:bg-white/10 transition-all duration-150"
              >
                <X size={13} />
              </button>
            </div>

            {/* Search */}
            <form onSubmit={handleSearch} className="flex items-center gap-2
                          bg-[rgba(250,250,249,0.04)] border border-[rgba(68,64,60,0.5)]
                          focus-within:border-teal-500/50 focus-within:bg-[rgba(250,250,249,0.06)]
                          rounded-xl px-3 py-2 mb-5 transition-all duration-150">
              <Search size={14} className="text-stone-500 shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); if (!e.target.value) clearSearch() }}
                placeholder="Search memories..."
                className="bg-transparent text-[13px] text-stone-200 placeholder:text-stone-600 outline-none flex-1"
              />
              {searchActive && (
                <button type="button" onClick={clearSearch}
                        className="text-stone-500 hover:text-stone-200 transition-colors">
                  <X size={12} />
                </button>
              )}
            </form>

            {/* Type distribution filter */}
            {engramStats?.by_type && (
              <div className="mb-4 pb-4 border-b border-[rgba(68,64,60,0.3)]">
                <p className="text-[10px] uppercase tracking-widest text-stone-500 mb-2.5 font-medium">Filter by type</p>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => setTypeFilter(null)}
                    className={`text-[10px] font-medium px-2.5 py-1 rounded-lg border transition-all duration-150 ${
                      !typeFilter
                        ? 'border-teal-500/30 text-teal-300 bg-teal-500/15 shadow-[0_0_8px_rgba(25,168,158,0.1)]'
                        : 'border-[rgba(68,64,60,0.4)] text-stone-500 hover:text-stone-300 hover:border-[rgba(68,64,60,0.6)]'
                    }`}
                  >
                    All
                  </button>
                  {Object.entries(engramStats.by_type).map(([type, { total }]) => (
                    <button
                      key={type}
                      onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                      className={`text-[10px] font-medium px-2.5 py-1 rounded-lg border transition-all duration-150 ${
                        typeFilter === type
                          ? TYPE_FILTER_CLASSES[type] ?? 'border-teal-500/30 text-teal-300 bg-teal-500/15'
                          : typeFilter
                            ? 'border-[rgba(68,64,60,0.3)] text-stone-600 hover:text-stone-400'
                            : 'border-[rgba(68,64,60,0.4)] text-stone-400 hover:text-stone-200 hover:border-[rgba(68,64,60,0.6)]'
                      }`}
                    >
                      {type === 'self_model' ? 'self model' : type} ({total})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Topic/cluster list */}
            {activeGraph && activeGraph.clusters && activeGraph.clusters.length > 0 ? (
              <>
                <div className="text-[10px] text-stone-500 uppercase tracking-widest font-medium pb-2 mb-2 border-b border-[rgba(68,64,60,0.3)]">
                  {activeGraph.clusters.length} topics
                </div>
                <div className="space-y-0.5">
                {activeGraph.clusters.slice(0, 30).map(cluster => {
                  const color = CLUSTER_COLORS[cluster.id % CLUSTER_COLORS.length]
                  const isExpanded = expandedClusterId === cluster.id
                  const isFocused = focusCluster?.id === cluster.id
                  return (
                    <div key={cluster.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setFocusCluster({ id: cluster.id, ts: Date.now() })
                          setExpandedClusterId(isExpanded ? null : cluster.id)
                        }}
                        className={`flex items-center gap-2 w-full text-left text-[11px] rounded-lg px-2.5 py-1.5 transition-all duration-150 ${
                          isFocused
                            ? 'bg-[rgba(250,250,249,0.08)] shadow-[inset_0_0_0_1px_rgba(250,250,249,0.06)]'
                            : 'hover:bg-[rgba(250,250,249,0.04)]'
                        }`}
                      >
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}40` }}
                        />
                        <span className="text-stone-200 truncate flex-1 font-medium" title={cluster.label}>
                          {cluster.label}
                        </span>
                        <span className="text-stone-500 text-[10px] font-mono shrink-0">{cluster.count}</span>
                        <ChevronRight
                          size={11}
                          className={`text-stone-500 shrink-0 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
                        />
                      </button>
                      {isExpanded && (
                        <div className="pl-6 pr-1 py-1 space-y-0.5 ml-1 border-l border-[rgba(68,64,60,0.3)]">
                          {activeGraph.nodes
                            .filter(n => n.cluster_id === cluster.id)
                            .sort((a, b) => b.importance - a.importance)
                            .slice(0, 12)
                            .map(node => (
                              <button
                                key={node.id}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setSelectedNode(node.id)
                                  setFocusNode({ id: node.id, ts: Date.now() })
                                }}
                                className="block w-full text-left text-[10px] text-stone-400 hover:text-stone-100
                                           truncate rounded-md px-2 py-1 hover:bg-[rgba(250,250,249,0.06)] transition-all duration-150"
                                title={node.content ?? node.type}
                              >
                                {node.content ?? `${node.type} · ${(node.importance * 100).toFixed(0)}%`}
                              </button>
                            ))}
                          {activeGraph.nodes.filter(n => n.cluster_id === cluster.id).length > 12 && (
                            <div className="text-[10px] text-stone-600 px-1 pt-0.5">
                              +{activeGraph.nodes.filter(n => n.cluster_id === cluster.id).length - 12} more
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
                </div>
                {activeGraph.clusters.length > 30 && (
                  <div className="text-[10px] text-stone-500 px-2.5 pt-2 mt-1 border-t border-[rgba(68,64,60,0.3)]">
                    +{activeGraph.clusters.length - 30} smaller clusters
                  </div>
                )}
              </>
            ) : activeGraph ? (
              <>
                <div className="text-[10px] text-stone-500 uppercase tracking-widest font-medium pb-2 mb-2 border-b border-[rgba(68,64,60,0.3)]">
                  Types
                </div>
                {Array.from(new Set(activeGraph.nodes.map(n => n.type))).map(type => (
                  <div key={type} className="flex items-center gap-2 text-[11px] px-1.5 py-0.5">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: TYPE_COLORS[type] ?? '#71717a', boxShadow: `0 0 6px ${TYPE_COLORS[type] ?? '#71717a'}` }}
                    />
                    <span className="text-stone-400" title={TYPE_DESCRIPTIONS[type]}>
                      {type === 'self_model' ? 'self model' : type}
                    </span>
                  </div>
                ))}
              </>
            ) : null}
          </div>
      )}

      {/* ── Overlay: Display Settings ──────────────────────────────── */}
      {settingsOpen && (
          <div className="absolute top-[60px] right-3 w-[240px] z-20
                          glass-overlay border border-white/[0.12] border-t-white/[0.20] rounded-2xl
                          p-5 space-y-4">
            <button
              onClick={() => setSettingsOpen(false)}
              className="absolute top-3 right-3 text-stone-600 hover:text-stone-300 transition-colors"
            >
              <X size={12} />
            </button>

            <div>
              <div className="text-[10px] text-stone-500 uppercase tracking-wider">Display</div>
              {nodeCount > 500 && (
                <div className="text-[9px] text-amber-500/60 mt-1">
                  Auto-adjusted for {nodeCount.toLocaleString()} nodes
                </div>
              )}
            </div>

            {/* Node limit */}
            <div className="space-y-2">
              <div className="text-[10px] text-stone-600">Memories shown</div>
              <div className="flex flex-wrap gap-1">
                {[
                  { label: '1', value: 1 },
                  { label: '200', value: 200 },
                  { label: '500', value: 500 },
                  { label: '1k', value: 1000 },
                  { label: '2k', value: 2000 },
                  { label: '5k', value: 5000 },
                  { label: 'All', value: engramStats?.total_engrams ?? 99999 },
                ].map(({ label, value }) => (
                  <button
                    key={label}
                    onClick={() => setNodeLimit(value)}
                    className={`relative text-[10px] font-medium px-2 py-1 rounded transition-colors ${
                      nodeLimit === value
                        ? 'text-teal-400 bg-teal-500/15 border border-teal-500/30'
                        : 'text-stone-500 hover:text-stone-300 border border-transparent hover:border-white/10'
                    }`}
                  >
                    {label}
                    {value === 500 && (
                      <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-teal-400" title="Recommended" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Bloom strength */}
            <div className="space-y-1.5">
              <div className="text-[10px] text-stone-600">Bloom</div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={bloomStrength}
                  onChange={(e) => setBloomStrength(parseFloat(e.target.value))}
                  className="flex-1 h-1 accent-teal-500 bg-white/10 rounded-full appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-teal-400 [&::-webkit-slider-thumb]:appearance-none"
                />
                <span className="text-[10px] text-stone-500 w-6 text-right">{bloomStrength.toFixed(1)}</span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-[10px] text-stone-600 mb-1">Graph</div>
              <button
                onClick={() => setShowEdges((v: boolean) => !v)}
                className={`block w-full text-left text-[11px] px-2 py-1 rounded transition-colors ${
                  showEdges
                    ? 'text-teal-400 bg-teal-500/10'
                    : 'text-stone-600 hover:text-stone-400'
                }`}
              >
                Connections
              </button>
            </div>

            <div className="space-y-2">
              <div className="text-[10px] text-stone-600 mb-1">Background</div>
              {[
                { label: 'Stars', value: showBgStars, set: setShowBgStars },
                { label: 'Milky Way', value: showMilkyWay, set: setShowMilkyWay },
                { label: 'Clouds', value: showNebulae, set: setShowNebulae },
                { label: 'Celestial Objects', value: showCelestialObjects, set: setShowCelestialObjects },
                { label: 'Galaxy Halos', value: showClusterGalaxies, set: setShowClusterGalaxies },
              ].map(({ label, value, set }) => (
                <button
                  key={label}
                  onClick={() => set((v: boolean) => !v)}
                  className={`block w-full text-left text-[11px] px-2 py-1 rounded transition-colors ${
                    value
                      ? 'text-teal-400 bg-teal-500/10'
                      : 'text-stone-600 hover:text-stone-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
      )}

      {/* ── Memory Detail Modal ─────────────────────────────────────────── */}
      {selectedNodeData && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center"
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedNode(null) }}
        >
          <div className="w-[480px] max-h-[70vh] overflow-y-auto glass-overlay border border-white/[0.12] border-t-white/[0.20] rounded-xl scrollbar-thin" style={{ background: 'rgba(5, 23, 22, 0.80)' }}>
            {/* Header */}
            <div className="sticky top-0 bg-stone-950/95 border-b border-white/[0.08] px-5 py-3.5 flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="text-[11px] px-1.5 py-0.5 rounded font-medium shrink-0"
                  style={{
                    backgroundColor: `${nodeColor}20`,
                    color: nodeColor,
                  }}
                >
                  {selectedNodeData.type === 'self_model' ? 'self model' : selectedNodeData.type}
                </span>
                {selectedNodeData.superseded && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 shrink-0">
                    superseded
                  </span>
                )}
              </div>
              <button
                onClick={() => setSelectedNode(null)}
                className="text-stone-600 hover:text-stone-300 transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Content */}
              <p className="text-sm text-stone-300 leading-relaxed">{selectedNodeData.content ?? selectedNodeData.type}</p>

              {/* Scores */}
              <div className="space-y-2 pt-3 border-t border-white/5">
                <div className="text-[10px] text-stone-600 uppercase tracking-wider">Scores</div>
                <ScoreBar value={selectedNodeData.activation ?? 0} label="Activation" color="#f59e0b" />
                <ScoreBar value={selectedNodeData.importance} label="Importance" color="#14b8a6" />
                <ScoreBar value={selectedNodeData.confidence ?? 0} label="Confidence" color="#818cf8" />
              </div>

              {/* Metadata */}
              <div className="pt-3 border-t border-white/5">
                <div className="text-[10px] text-stone-600 uppercase tracking-wider mb-2">Metadata</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <div>
                    <div className="text-[10px] text-stone-600">Source</div>
                    <div className="text-[11px] text-stone-300">{selectedNodeData.source_type || 'unknown'}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-stone-600">Recalled</div>
                    <div className="text-[11px] text-stone-300">{(selectedNodeData.access_count ?? 0).toLocaleString()} times</div>
                  </div>
                  {selectedNodeData.created_at && (
                    <div>
                      <div className="text-[10px] text-stone-600">Created</div>
                      <div className="text-[11px] text-stone-300">{new Date(selectedNodeData.created_at).toLocaleDateString()}</div>
                    </div>
                  )}
                </div>
                <div className="font-mono text-[9px] text-stone-700 break-all mt-2">{selectedNodeData.id}</div>
              </div>

              {/* Explore from here */}
              <button
                onClick={() => exploreNode(selectedNodeData.id)}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-teal-400 bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/20 rounded-md py-1.5 transition-colors"
              >
                <Network size={12} />
                Explore from here
              </button>

              {/* Connections */}
              <div className="pt-3 border-t border-white/5">
                <div className="text-[10px] text-stone-600 uppercase tracking-wider mb-2">
                  Connections ({selectedConnections.length})
                </div>
                {selectedConnections.length > 0 ? (
                  <div className="space-y-1">
                    {selectedConnections.map((edge, i) => {
                      const otherId = edge.source === selectedNodeData.id ? edge.target : edge.source
                      const otherNode = activeGraph?.nodes.find(n => n.id === otherId)
                      const isOutgoing = edge.source === selectedNodeData.id
                      return (
                        <button
                          key={i}
                          type="button"
                          className="flex items-center gap-1.5 w-full text-left text-[11px] p-1.5 rounded hover:bg-white/5 transition-colors"
                          onClick={() => {
                            setSelectedNode(otherId)
                            setFocusNode({ id: otherId, ts: Date.now() })
                          }}
                        >
                          <span className="text-stone-600 shrink-0">{isOutgoing ? '\u2192' : '\u2190'}</span>
                          <span className="text-stone-400 font-medium shrink-0">{(edge.relation ?? '').replace(/_/g, ' ')}</span>
                          <span className="flex-1 truncate text-stone-500">
                            {otherNode?.content ?? otherId.slice(0, 8)}
                          </span>
                          <span className="text-stone-700 text-[10px] shrink-0" title="Connection strength">
                            {edge.weight.toFixed(2)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-[11px] text-stone-600">No connections in this subgraph</p>
                )}
              </div>

              {/* Forget */}
              <div className="pt-3 border-t border-white/5">
                {confirmingForget ? (
                  <div className="space-y-2">
                    <p className="text-[11px] text-red-300 leading-relaxed">
                      Permanently forget this engram? Its edges will be removed. This cannot be undone.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={forgetMutation.isPending}
                        onClick={() => forgetMutation.mutate(selectedNodeData.id)}
                        className="flex-1 flex items-center justify-center gap-1.5 text-xs text-white bg-red-600/80 hover:bg-red-600 disabled:opacity-50 rounded-md py-1.5 transition-colors"
                      >
                        <Trash2 size={12} />
                        {forgetMutation.isPending ? 'Forgetting…' : 'Confirm forget'}
                      </button>
                      <button
                        type="button"
                        disabled={forgetMutation.isPending}
                        onClick={() => setConfirmingForget(false)}
                        className="flex-1 text-xs text-stone-400 hover:text-stone-200 bg-white/5 hover:bg-white/10 rounded-md py-1.5 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingForget(true)}
                    className="w-full flex items-center justify-center gap-1.5 text-xs text-red-400 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-md py-1.5 transition-colors"
                  >
                    <Trash2 size={12} />
                    Forget this engram
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Chat Panel ────────────────────────────────────────────────────── */}
      {chatOpen && (
        <BrainChat
          onClose={() => setChatOpen(false)}
          onActivityStep={handleActivityStep}
          onStreamComplete={handleStreamComplete}
        />
      )}
    </div>
  )
}
