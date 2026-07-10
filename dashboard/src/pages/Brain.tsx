import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Brain as BrainIcon, MessageSquare, Pencil, Sparkles, Trash2 } from 'lucide-react'
import { apiFetch, getCortexDrives, getGoals } from '../api'
import {
  BrainMode, Camera, CATS, MemGraph, Retrieval, RetrievalEvent, Scene,
  applyRetrieval, buildScene, heartOf, panWorld, relaxStep, resetRelax,
  resultCentroid, sceneCentroid, startRetrieval, tickNodes, Projected,
} from '../brain/engine'
import { createSingularity, drawGalaxy, drawOrrery, FrameCtx, Singularity } from '../brain/renderers'
import { createGraph2D, Graph2D } from '../brain/graph2d'
import { Badge, Button, ConfirmDialog, Input, Modal, Textarea } from '../components/ui'
import { BrainChat } from '../brain/BrainChat'

type ViewKind = 'graph' | 'galaxy' | 'orrery' | 'singularity'

interface MemoryItem {
  memory_id: string
  title: string
  type: string
  frontmatter: Record<string, unknown>
  content: string
}

const VIEWS: { key: ViewKind; label: string }[] = [
  { key: 'graph', label: 'Graph' },
  { key: 'galaxy', label: 'Galaxy' },
  { key: 'orrery', label: 'Orrery' },
  { key: 'singularity', label: 'Singularity' },
]

const ls = {
  get: (k: string, d: string) => localStorage.getItem(k) ?? d,
  set: (k: string, v: string) => localStorage.setItem(k, v),
}

const chip = (on: boolean) =>
  `px-3 py-1.5 rounded-full border font-mono text-[11px] transition-colors cursor-pointer ${
    on
      ? 'text-teal-300 border-teal-400/50 bg-teal-950/60 shadow-[0_0_12px_rgba(36,201,184,0.25)]'
      : 'text-content-secondary border-border hover:text-content-primary hover:border-content-tertiary'
  }`

export function Brain() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const reduceMotion = useMemo(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])

  const graphQuery = useQuery({
    queryKey: ['memory-graph'],
    queryFn: () => apiFetch<MemGraph>('/mem/api/v1/memory/graph'),
    staleTime: 60_000,
  })

  // live state for the soul's satellites (read-only overlay, never blocks)
  const drivesQ = useQuery({
    queryKey: ['brain-drives'], queryFn: getCortexDrives,
    refetchInterval: 10_000, staleTime: 5_000, retry: 1,
  })
  const goalsQ = useQuery({
    queryKey: ['brain-goals-active'], queryFn: () => getGoals('active'),
    refetchInterval: 30_000, staleTime: 15_000, retry: 1,
  })

  // ── UI state (mirrored into refs for the render loop) ──────────────────
  const [view, setView] = useState<ViewKind>(() => ls.get('brain.view', 'graph') as ViewKind)
  const [colorByType, setColorByType] = useState(() => ls.get('brain.colorByType', '0') === '1')
  const [showLabels, setShowLabels] = useState(() => ls.get('brain.labels', '0') === '1')
  const [showJournals, setShowJournals] = useState(() => ls.get('brain.journals', '1') === '1')
  const [search, setSearch] = useState('')
  const [drift, setDrift] = useState(() => !reduceMotion && ls.get('brain.drift', '1') === '1')
  const [modeUi, setModeUi] = useState<BrainMode>('idle')
  const [lastQuery, setLastQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [detailFull, setDetailFull] = useState(false)
  const [chatOpen, setChatOpen] = useState(() => ls.get('brain.chat', '0') === '1')
  const [chatWidth, setChatWidth] = useState(() => {
    const w = Number(ls.get('brain.chatWidth', '400'))
    return Number.isFinite(w) ? Math.max(320, Math.min(720, w)) : 400
  })
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<Scene | null>(null)
  const camRef = useRef<Camera>({ yaw: 0.6, pitch: 0.32, dist: 300, fov: 640, auto: true, cx: 0, cy: 0, ox: 0, tx: 0, ty: 0, tz: 0 })
  const viewRef = useRef(view)
  const modeRef = useRef<BrainMode>('idle')
  const retrievalRef = useRef<Retrieval | null>(null)
  const centroidRef = useRef<{ x: number; y: number; z: number } | null>(null)
  const flagsRef = useRef({ colorByType, showLabels, drift, showJournals })
  const selectedRef = useRef(-1)
  const hoveredRef = useRef(-1)
  const simTRef = useRef(0)
  const rotTRef = useRef(0)
  const projRef = useRef<(Projected | null)[]>([])
  const singRef = useRef<Singularity | null>(null)
  const graphRef = useRef<Graph2D | null>(null)
  const respondTimer = useRef<ReturnType<typeof setTimeout>>()
  const respondAmpRef = useRef(0)

  viewRef.current = view
  flagsRef.current = { colorByType, showLabels, drift, showJournals }
  const searchQRef = useRef('')
  searchQRef.current = search
  const searchStateRef = useRef<{ q: string; scene: Scene | null; set: Set<number> | null }>(
    { q: '', scene: null, set: null })
  const searchInputRef = useRef<HTMLInputElement>(null)
  const driveMapRef = useRef<Map<string, number>>(new Map())
  driveMapRef.current = new Map((drivesQ.data?.drives ?? []).map(d => [d.name, d.urgency]))
  const chatOpenRef = useRef(chatOpen)
  chatOpenRef.current = chatOpen
  const chatWidthRef = useRef(chatWidth)
  chatWidthRef.current = chatWidth
  const pannedRef = useRef(false)
  selectedRef.current = selectedIdx

  // build scene when the graph arrives, or when the live-node SET changes
  // (urgency refreshes are applied in place — no rebuild)
  const driveKey = (drivesQ.data?.drives ?? []).map(d => d.name).sort().join('|')
  const goalKey = (goalsQ.data ?? []).map(g => g.id).join('|')
  useEffect(() => {
    if (!graphQuery.data) return
    resetRelax()
    sceneRef.current = buildScene(graphQuery.data, {
      drives: (drivesQ.data?.drives ?? []).map(d => ({ name: d.name, urgency: d.urgency })),
      goals: (goalsQ.data ?? []).map(g => ({ id: g.id, title: g.title })),
    })
    pannedRef.current = false
    setSelectedIdx(-1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphQuery.data, driveKey, goalKey])

  const transition = useCallback((m: BrainMode) => {
    modeRef.current = m
    setModeUi(m)
    clearTimeout(respondTimer.current)
    if (m === 'respond') {
      respondTimer.current = setTimeout(() => transition('idle'), 9000)
    }
    if (m === 'idle') {
      retrievalRef.current = null
      // centroid persists — the respond envelope fades the glow out smoothly
    }
  }, [])

  // ── Live cognition feed: memory-service SSE ────────────────────────────
  useEffect(() => {
    const es = new EventSource('/mem/api/v1/memory/events')
    es.addEventListener('retrieval', (e: MessageEvent) => {
      const scene = sceneRef.current
      if (!scene) return
      try {
        const ev: RetrievalEvent = JSON.parse(e.data)
        setLastQuery(ev.query)
        const r = startRetrieval(scene, ev.surfaced, ev.query, simTRef.current)
        if (r) {
          retrievalRef.current = r
          transition('retrieve')
        }
      } catch { /* malformed line — skip */ }
    })
    return () => es.close()
  }, [transition])

  // "/" focuses search from anywhere on the page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/') return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      e.preventDefault()
      searchInputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // "Pulse" fires a REAL retrieval through the pipe — the SSE echo lights it
  const pulse = useMutation({
    mutationFn: () => apiFetch('/mem/api/v1/memory/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'recent work, decisions and preferences', session_id: 'brain-pulse' }),
    }),
  })

  // ── Render loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let W = 0, H = 0
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      W = wrap.clientWidth; H = wrap.clientHeight
      canvas.width = W * dpr; canvas.height = H * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      singRef.current?.reset()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    if (!singRef.current) singRef.current = createSingularity()
    if (!graphRef.current) graphRef.current = createGraph2D()

    let raf = 0
    let last = performance.now()
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.05, (t - last) / 1000)
      last = t
      simTRef.current += dt
      const simT = simTRef.current
      const scene = sceneRef.current
      const cam = camRef.current
      const v = viewRef.current
      const flags = flagsRef.current

      if (flags.drift && !reduceMotion) {
        if (v === 'galaxy') cam.yaw += dt * (modeRef.current === 'respond' ? 0.016 : 0.05)
        if (v === 'orrery') rotTRef.current += dt
      }
      // keep the scene centered in the space the chat drawer leaves free
      cam.ox += ((chatOpenRef.current ? -chatWidthRef.current / 2 : 0) - cam.ox) * Math.min(1, dt * 6)
      // respond envelope: ease in fast, fade out slow — no visible reset
      const ampTarget = modeRef.current === 'respond' ? 1 : 0
      const ampRate = ampTarget > respondAmpRef.current ? 3.5 : 0.8
      respondAmpRef.current += (ampTarget - respondAmpRef.current) * Math.min(1, dt * ampRate)

      // recompute search hits when the query or scene changes (loop-owned so
      // it always sees the freshly built scene)
      const q = searchQRef.current.trim().toLowerCase()
      const ss = searchStateRef.current
      if (ss.q !== q || ss.scene !== scene) {
        ss.q = q; ss.scene = scene
        if (!q || !scene) ss.set = null
        else {
          const hits = new Set<number>()
          for (const n of scene.nodes) {
            if (n.title.toLowerCase().includes(q) || n.label.toLowerCase().includes(q)
              || n.description.toLowerCase().includes(q) || n.type.toLowerCase().includes(q)
              || n.tags.some(t => t.toLowerCase().includes(q))) hits.add(n.idx)
          }
          ss.set = hits
        }
      }

      if (scene) {
        if (!scene.relaxDone) relaxStep(scene, 12)
        // rest the orbit pivot on the soul when there is one (it holds the
        // origin), else the layout's centre of mass — until the user pans;
        // rotation then spins around the current view centre
        if (!pannedRef.current && (v === 'galaxy' || v === 'orrery')) {
          const c = v === 'orrery' || scene.soulIdx >= 0
            ? { x: 0, y: 0, z: 0 } : sceneCentroid(scene)
          const e = Math.min(1, dt * 2.5)
          cam.tx += (c.x - cam.tx) * e
          cam.ty += (c.y - cam.ty) * e
          cam.tz += (c.z - cam.tz) * e
        }
        // live urgency onto drive satellites — applied in place, no rebuild
        for (const n of scene.nodes) {
          if (n.satKind === 'drive') n.satHot = driveMapRef.current.get(n.title) ?? n.satHot
        }
        const r = retrievalRef.current
        if (r && applyRetrieval(scene, r, simT)) {
          centroidRef.current = resultCentroid(scene, r)
          retrievalRef.current = null
          transition('respond')
        }
        tickNodes(scene, dt, modeRef.current, centroidRef.current)
      }

      const f: FrameCtx = {
        W, H, dt, simT,
        mode: modeRef.current,
        retrieval: retrievalRef.current,
        colorByType: flags.colorByType,
        showLabels: flags.showLabels,
        selected: selectedRef.current,
        hovered: hoveredRef.current,
        reduceMotion,
        rotT: rotTRef.current,
        respondAmp: respondAmpRef.current,
        hideJournals: !flags.showJournals,
        search: searchStateRef.current.set,
      }

      if (v === 'singularity') {
        singRef.current!.draw(ctx, f, cam, flags.drift)
      } else if (v === 'graph' && scene) {
        graphRef.current!.draw(ctx, scene, f, flags.drift, chatOpenRef.current ? -chatWidthRef.current / 2 : 0)
      } else if (scene) {
        if (projRef.current.length !== scene.nodes.length) {
          projRef.current = new Array(scene.nodes.length).fill(null)
        }
        if (v === 'galaxy') drawGalaxy(ctx, scene, cam, f, projRef.current)
        else drawOrrery(ctx, scene, cam, f, projRef.current)
      } else {
        ctx.clearRect(0, 0, W, H)
      }

    }
    raf = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [reduceMotion, transition])

  // ── Pointer: orbit, hover, pick ─────────────────────────────────────────
  const dragState = useRef({ dragging: false, moved: 0, px: 0, py: 0, button: 0 })

  const pick = (mx: number, my: number): number => {
    const scene = sceneRef.current
    if (!scene || viewRef.current === 'singularity') return -1
    let best = -1, bd = 18
    for (let i = 0; i < scene.nodes.length; i++) {
      const p = projRef.current[i]
      if (!p) continue
      const r = Math.max(8, (2.1 + Math.log2(1 + scene.nodes[i].degree) * 1.5) * p.s * 1.4)
      const d = Math.hypot(p.sx - mx, p.sy - my)
      if (d < r && d < bd) { bd = d; best = i }
    }
    return best
  }

  const localXY = (e: React.PointerEvent | React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    dragState.current = { dragging: true, moved: 0, px: e.clientX, py: e.clientY, button: e.button }
    canvasRef.current?.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const ds = dragState.current
    const v = viewRef.current
    if (ds.dragging) {
      const dx = e.clientX - ds.px, dy = e.clientY - ds.py
      ds.px = e.clientX; ds.py = e.clientY
      ds.moved += Math.abs(dx) + Math.abs(dy)
      if (v === 'graph') {
        // flat view: any drag pans (no rotation)
        graphRef.current?.pan(dx, dy)
        return
      }
      const cam = camRef.current
      if (ds.button === 2 || ds.button === 1) {
        // right (or middle) drag: pan. The singularity pans in screen space;
        // the world views move the orbit target so the rotation pivot always
        // follows the current view centre.
        if (v === 'singularity') {
          cam.cx += dx
          cam.cy += dy
        } else {
          panWorld(cam, dx, dy)
          pannedRef.current = true
        }
      } else {
        // left drag: free rotation — no pitch stops, flip right over the poles
        cam.yaw += dx * 0.005
        cam.pitch += dy * 0.004
      }
      if (v === 'singularity') singRef.current?.stir()
    } else {
      const { x, y } = localXY(e)
      hoveredRef.current = v === 'graph' ? (graphRef.current?.pick(x, y) ?? -1) : pick(x, y)
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const ds = dragState.current
    ds.dragging = false
    if (ds.moved < 6 && ds.button === 0) {
      const { x, y } = localXY(e)
      const i = viewRef.current === 'graph' ? (graphRef.current?.pick(x, y) ?? -1) : pick(x, y)
      // satellites are live state, not memory: deep-link instead of the modal
      const node = i >= 0 ? sceneRef.current?.nodes[i] : undefined
      if (node?.satKind) { navigate(node.link ?? '/goals'); return }
      setSelectedIdx(i)
      if (i >= 0) setDetailFull(false)
    }
  }
  const onWheel = (e: React.WheelEvent) => {
    const { x, y } = localXY(e)
    if (viewRef.current === 'graph') {
      graphRef.current?.zoomAt(x, y, e.deltaY)
      return
    }
    const cam = camRef.current
    // proportional zoom that can fly all the way through the nodes
    cam.dist = Math.max(12, Math.min(900, cam.dist + e.deltaY * (0.1 + cam.dist * 0.0015)))
    if (viewRef.current === 'singularity') singRef.current?.stir()
  }

  // ── Selected item: detail + edit + delete ───────────────────────────────
  const scene = sceneRef.current
  const selNode = selectedIdx >= 0 && scene ? scene.nodes[selectedIdx] : null

  const itemQuery = useQuery({
    queryKey: ['memory-item', selNode?.id],
    queryFn: () => apiFetch<MemoryItem>(`/mem/api/v1/memory/item/${selNode!.id}`),
    enabled: !!selNode,
  })

  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editTags, setEditTags] = useState('')
  const [editBody, setEditBody] = useState('')

  const openEdit = () => {
    if (!selNode) return
    setEditTitle(selNode.title)
    setEditDesc(selNode.description)
    setEditTags(selNode.tags.join(', '))
    setEditBody(itemQuery.data?.content ?? '')
    setEditOpen(true)
  }

  const saveEdit = useMutation({
    mutationFn: () => apiFetch(`/mem/api/v1/memory/item/${selNode!.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        frontmatter: {
          title: editTitle.trim() || selNode!.title,
          description: editDesc.trim() || null,
          tags: editTags.split(',').map(t => t.trim()).filter(Boolean),
        },
        content: editBody,
      }),
    }),
    onSuccess: () => {
      setEditOpen(false)
      qc.invalidateQueries({ queryKey: ['memory-graph'] })
      qc.invalidateQueries({ queryKey: ['memory-item', selNode?.id] })
    },
  })

  const deleteItem = useMutation({
    mutationFn: () => apiFetch(`/mem/api/v1/memory/item/${selNode!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteOpen(false)
      setSelectedIdx(-1)
      qc.invalidateQueries({ queryKey: ['memory-graph'] })
    },
  })

  const setViewPersist = (v: ViewKind) => {
    setView(v); ls.set('brain.view', v)
    singRef.current?.reset()
    if (v === 'graph') graphRef.current?.requestFit()
  }

  const stats = graphQuery.data
  const legendCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const n of sceneRef.current?.nodes ?? []) {
      if (n.satKind) continue // live-state nodes aren't memories
      counts[n.cat.key] = (counts[n.cat.key] ?? 0) + 1
    }
    return counts
  }, [graphQuery.data]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-[#0C0A09]">
      {/* explicit CSS size: a replaced element with inset-0 alone renders at
          its intrinsic bitmap size (W×dpr) and overflows on hi-DPI displays */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full cursor-grab active:cursor-grabbing"
        aria-label={view === 'graph'
          ? "Nova's memory as a 2D graph. Drag to pan, scroll to zoom, click a node to inspect the memory."
          : "Nova's memory as an interactive 3D graph. Left-drag rotates, right-drag pans, scroll zooms. Click a node to inspect the memory."}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={e => e.preventDefault()}
      />

      {/* ── Top HUD ── */}
      <div className="absolute top-0 inset-x-0 z-20 flex flex-wrap items-center gap-3 px-4 py-2.5
                      bg-[rgba(8,45,42,0.30)] backdrop-blur-xl border-b border-white/[0.06]">
        <div className="font-mono text-[11px] font-semibold tracking-[0.14em] uppercase text-content-secondary">
          <span className="text-teal-400">Nova</span> · Brain
        </div>
        <div className="flex gap-1.5" role="group" aria-label="View">
          {VIEWS.map(v => (
            <button key={v.key} className={chip(view === v.key)} onClick={() => setViewPersist(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
        {view !== 'singularity' && (
          <input
            ref={searchInputRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { setSearch(''); e.currentTarget.blur() }
              if (e.key === 'Enter') {
                const hits = searchStateRef.current.set
                const scene = sceneRef.current
                if (!hits?.size || !scene) return
                let best = -1, bd = -1 // open the best-connected hit
                for (const i of hits) if (scene.nodes[i].degree > bd) { bd = scene.nodes[i].degree; best = i }
                if (best >= 0) { setSelectedIdx(best); setDetailFull(false) }
              }
            }}
            placeholder="search  /"
            aria-label="Search memories"
            className="h-7 w-44 rounded-full border border-border bg-black/30 px-3 font-mono text-[11px]
                       text-content-primary placeholder:text-content-tertiary outline-none transition-colors
                       focus:border-teal-400/50 focus:shadow-[0_0_12px_rgba(36,201,184,0.25)]"
          />
        )}
        <div className="flex-1" />
        <div className="flex gap-1.5 items-center">
          {view !== 'singularity' && (
            <>
              <button className={chip(colorByType)} onClick={() => { setColorByType(!colorByType); ls.set('brain.colorByType', colorByType ? '0' : '1') }}>
                Color by type
              </button>
              <button className={chip(showLabels)} onClick={() => { setShowLabels(!showLabels); ls.set('brain.labels', showLabels ? '0' : '1') }}>
                Labels
              </button>
              <button className={chip(showJournals)} onClick={() => { setShowJournals(!showJournals); ls.set('brain.journals', showJournals ? '0' : '1') }}>
                Journals
              </button>
            </>
          )}
          <button className={chip(drift)} onClick={() => { setDrift(!drift); ls.set('brain.drift', drift ? '0' : '1') }}>
            Drift
          </button>
          <Button
            size="sm"
            icon={<Sparkles size={14} />}
            loading={pulse.isPending}
            onClick={() => pulse.mutate()}
            title="Run a real retrieval through memory — watch it think"
          >
            Pulse
          </Button>
          <Button
            size="sm"
            variant={chatOpen ? 'primary' : 'ghost'}
            icon={<MessageSquare size={14} />}
            onClick={() => { setChatOpen(!chatOpen); ls.set('brain.chat', chatOpen ? '0' : '1') }}
            title="Chat here — the graph lights up as it retrieves"
          >
            Chat
          </Button>
        </div>
      </div>

      {/* ── Stats / activity ── */}
      <div className="absolute left-4 bottom-4 z-10 min-w-[210px] rounded-xl border border-white/[0.08]
                      bg-[rgba(12,10,9,0.88)] backdrop-blur-lg px-3.5 py-3 font-mono text-[11px]">
        <div className="flex justify-between gap-4 text-content-secondary py-0.5">
          <span>memories</span><b className="font-medium text-content-primary">{stats?.nodes.length ?? '—'}</b>
        </div>
        <div className="flex justify-between gap-4 text-content-secondary py-0.5">
          <span>links</span><b className="font-medium text-content-primary">{stats?.edges.length ?? '—'}</b>
        </div>
        <div className="flex justify-between gap-4 text-content-secondary py-0.5">
          <span>activity</span>
          <b className={modeUi === 'idle' ? 'text-content-primary' : 'text-amber-400'}>
            {modeUi === 'idle' ? 'idle' : modeUi === 'retrieve' ? 'retrieving' : 'responding'}
          </b>
        </div>
        {lastQuery && (
          <div className="mt-1 pt-1 border-t border-white/[0.08] text-content-tertiary truncate max-w-[240px]"
               title={lastQuery}>
            “{lastQuery}”
          </div>
        )}
        {colorByType && view !== 'singularity' && (
          <div className="mt-2 pt-2 border-t border-white/[0.08] space-y-0.5">
            {Object.values(CATS).map(c => (
              <div key={c.key} className="flex items-center gap-2 text-content-secondary">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color }} />
                {c.label}
                <span className="ml-auto text-content-tertiary">{legendCounts[c.key] ?? 0}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Empty / loading states ── */}
      {graphQuery.isLoading && (
        <div className="absolute inset-0 z-10 grid place-items-center pointer-events-none">
          <div className="font-mono text-compact text-content-tertiary animate-pulse">waking the brain…</div>
        </div>
      )}
      {stats && stats.nodes.length < 3 && view !== 'singularity' && (
        <div className="absolute inset-x-0 top-1/3 z-10 grid place-items-center pointer-events-none px-6">
          <div className="max-w-md text-center space-y-2">
            <BrainIcon className="mx-auto h-8 w-8 text-teal-400/60" />
            <p className="text-compact text-content-secondary">
              Memory is young — {stats.nodes.length} {stats.nodes.length === 1 ? 'file' : 'files'} so far.
              The graph grows as Nova journals, and links appear when nightly curation distills
              journals into connected topics.
            </p>
          </div>
        </div>
      )}
      {stats && stats.nodes.length >= 3 && stats.edges.length === 0 && view !== 'singularity' && (
        <div className="absolute inset-x-0 bottom-20 z-10 grid place-items-center pointer-events-none px-6">
          <p className="max-w-md text-center text-caption text-content-tertiary">
            {stats.nodes.length} memories, no links yet — connections appear when nightly curation
            distills journals into topics that link back to their sources.
          </p>
        </div>
      )}

      <BrainChat
        open={chatOpen}
        width={chatWidth}
        onWidthChange={w => { setChatWidth(w); ls.set('brain.chatWidth', String(w)) }}
        onClose={() => { setChatOpen(false); ls.set('brain.chat', '0') }}
      />

      {/* ── Memory modal: click = summary, "All details" = everything ── */}
      <Modal
        open={!!selNode && !editOpen}
        onClose={() => { setSelectedIdx(-1); setDetailFull(false) }}
        title={selNode?.title ?? ''}
        size={detailFull ? 'lg' : 'md'}
        footer={
          detailFull ? (
            <>
              <Button variant="ghost" onClick={() => setDetailFull(false)}>Back</Button>
              <Button variant="ghost" className="text-danger" icon={<Trash2 size={13} />}
                      onClick={() => setDeleteOpen(true)}>
                Delete
              </Button>
              <Button icon={<Pencil size={13} />} onClick={openEdit}>Edit</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => { setSelectedIdx(-1); setDetailFull(false) }}>Close</Button>
              <Button onClick={() => setDetailFull(true)}>All details</Button>
            </>
          )
        }
      >
        {selNode && (
          <div className="space-y-4">
            <div className="flex items-center gap-2.5">
              <span
                className="shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: selNode.cat.color, borderColor: selNode.cat.color + '66' }}
              >
                {selNode.type}
              </span>
              <span className="min-w-0 truncate font-mono text-[11px] text-content-tertiary">memory/{selNode.id}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] text-content-tertiary">
                <Activity size={11} /> {selNode.degree} links
              </span>
            </div>

            {selNode.description && (
              <p className="text-compact leading-relaxed text-content-secondary">{selNode.description}</p>
            )}
            {selNode.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selNode.tags.map(t => <Badge key={t} color="accent" size="sm">{t}</Badge>)}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 font-mono text-[11px] text-content-secondary">
              <div><div className="text-[10px] uppercase tracking-wider text-content-tertiary">source</div>{selNode.source_kind ?? '—'}</div>
              <div><div className="text-[10px] uppercase tracking-wider text-content-tertiary">trust</div>{selNode.trust != null ? selNode.trust.toFixed(2) : '—'}</div>
              <div><div className="text-[10px] uppercase tracking-wider text-content-tertiary">created</div>{selNode.created ? selNode.created.slice(0, 10) : '—'}</div>
            </div>

            {selNode.out.length > 0 && scene && (
              <div>
                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-content-tertiary">
                  Linked memories
                </div>
                <div className="space-y-1">
                  {(detailFull ? selNode.out : selNode.out.slice(0, 4)).map(j => {
                    const m = scene.nodes[j]
                    return (
                      <button
                        key={j}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px]
                                   text-content-secondary hover:bg-white/[0.05] hover:text-content-primary"
                        onClick={() => { setSelectedIdx(j); setDetailFull(false) }}
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: m.cat.color }} />
                        <span className="truncate">{m.title}</span>
                        <span className="ml-auto font-mono text-[11px] text-content-tertiary">→</span>
                      </button>
                    )
                  })}
                  {!detailFull && selNode.out.length > 4 && (
                    <p className="px-2 text-caption text-content-tertiary">
                      +{selNode.out.length - 4} more in all details
                    </p>
                  )}
                </div>
              </div>
            )}

            {detailFull && (
              <>
                <div>
                  <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-content-tertiary">
                    Frontmatter (everything in the file)
                  </div>
                  {itemQuery.isLoading
                    ? <p className="text-caption text-content-tertiary">loading…</p>
                    : (
                      <div className="rounded-lg border border-white/[0.07] bg-black/40 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed">
                        {Object.entries(itemQuery.data?.frontmatter ?? {}).map(([k, v]) => (
                          <div key={k} className="flex gap-2">
                            <span className="shrink-0 text-teal-400">{k}:</span>
                            <span className="min-w-0 break-words text-stone-300">
                              {Array.isArray(v) ? `[${v.join(', ')}]` : String(v ?? '')}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                </div>
                <div>
                  <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-content-tertiary">
                    Content
                  </div>
                  {itemQuery.isLoading
                    ? <p className="text-caption text-content-tertiary">loading…</p>
                    : <pre className="custom-scrollbar max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg
                                      border border-white/[0.07] bg-black/40 px-3 py-2.5 font-mono text-[11.5px]
                                      leading-relaxed text-stone-300">
                        {itemQuery.data?.content?.trim() || '(empty)'}
                      </pre>}
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* ── Edit modal ── */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={`Edit ${selNode?.title ?? ''}`}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={() => saveEdit.mutate()} loading={saveEdit.isPending} disabled={saveEdit.isPending}>
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label="Title" value={editTitle} onChange={e => setEditTitle(e.target.value)} />
          <Input label="Description" value={editDesc} onChange={e => setEditDesc(e.target.value)} />
          <Input label="Tags (comma-separated)" value={editTags} onChange={e => setEditTags(e.target.value)} />
          <div>
            <label className="mb-1 block text-caption font-medium text-content-secondary">Content (markdown)</label>
            <Textarea rows={12} value={editBody} onChange={e => setEditBody(e.target.value)} className="font-mono text-[12px]" />
          </div>
          {saveEdit.isError && <p className="text-caption text-danger">{String(saveEdit.error)}</p>}
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete Memory"
        description={`Delete "${selNode?.title}"? The markdown file is removed from the bundle (git history is your undo).`}
        confirmLabel="Delete"
        onConfirm={() => deleteItem.mutate()}
        destructive
      />
    </div>
  )
}
