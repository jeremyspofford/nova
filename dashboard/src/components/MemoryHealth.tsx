import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle, Info } from 'lucide-react'
import { apiFetch } from '../api'
import { Card, Skeleton } from './ui'

interface HealthData {
  outcome_feedback: {
    engrams_with_outcomes: number
    avg_outcome_score: number | null
    max_observations: number
    recalibration: { boost_eligible: number; demote_eligible: number; recalibrated_total: number }
  }
  activation: { full: number; mid: number; low: number; floor: number }
  co_activations: { edges_strengthened: number; max_co_activations: number }
  consolidation: {
    living_topics: number; superseded_topics: number; supersession_rate: number
    last_run: string | null
    last_run_stats: { topics_created: number; engrams_merged: number; edges_pruned: number } | null
  }
  retrieval_observations: number
  self_improving: boolean
  issues: string[]
}

// Map technical issues to plain-English explanations
function humanizeIssue(issue: string): { text: string; severity: 'warning' | 'info' } {
  if (issue.includes('Co-activations never increment')) {
    return { text: 'Nova hasn\'t connected related memories yet. This happens automatically as you have more conversations.', severity: 'info' }
  }
  if (issue.includes('Activation decay hasn\'t kicked in')) {
    return { text: 'Memory fading hasn\'t started yet. Unused memories will naturally fade after 30 days to keep retrieval focused.', severity: 'info' }
  }
  if (issue.includes('Outcome feedback is not flowing')) {
    return { text: 'Nova isn\'t learning which memories are useful. Chat with Nova to generate learning data.', severity: 'warning' }
  }
  if (issue.includes('No engrams have been recalibrated')) {
    return { text: 'Memory importance hasn\'t been adjusted yet. Nova needs more conversations to know which memories matter most.', severity: 'info' }
  }
  if (issue.includes('supersession rate')) {
    return { text: 'Memory consolidation is creating too many duplicate topics. This may slow down retrieval.', severity: 'warning' }
  }
  return { text: issue, severity: 'warning' }
}

function StatCard({ label, value, description, ok }: { label: string; value: string | number; description: string; ok?: boolean }) {
  return (
    <Card className="p-3">
      <div className="flex items-center justify-between">
        <span className="text-compact font-medium text-content-primary">{label}</span>
        {ok !== undefined && (
          <div className={`w-2 h-2 rounded-full ${ok ? 'bg-success' : 'bg-warning'}`} />
        )}
      </div>
      <p className="text-display text-content-primary mt-1">{value}</p>
      <p className="text-micro text-content-tertiary mt-0.5">{description}</p>
    </Card>
  )
}

export function MemoryHealth() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['memory-health'],
    queryFn: () => apiFetch<HealthData>('/mem/api/v1/engrams/health'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Card className="p-4"><Skeleton lines={2} /></Card>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="p-3"><Skeleton lines={2} /></Card>
          ))}
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <Card className="p-4">
        <p className="text-compact text-danger">Failed to load memory health data</p>
      </Card>
    )
  }

  const h = data
  const totalMemories = h.activation.full + h.activation.mid + h.activation.low + h.activation.floor
  const humanIssues = h.issues.map(humanizeIssue)
  const warnings = humanIssues.filter(i => i.severity === 'warning')
  const infos = humanIssues.filter(i => i.severity === 'info')

  return (
    <div className="space-y-4">
      {/* Overall status */}
      <div className={`flex items-center gap-3 p-3 rounded-lg border ${
        h.self_improving
          ? 'bg-success-dim border-success/30'
          : warnings.length > 0 ? 'bg-warning-dim border-warning/30' : 'bg-success-dim border-success/30'
      }`}>
        {h.self_improving || warnings.length === 0
          ? <CheckCircle size={18} className="text-success" />
          : <AlertTriangle size={18} className="text-warning" />}
        <div>
          <span className="text-compact text-content-primary font-medium">
            {h.self_improving ? 'Nova is learning from conversations' : warnings.length > 0 ? 'Some learning features need attention' : 'Nova is learning from conversations'}
          </span>
          <p className="text-micro text-content-tertiary">
            Nova tracks which memories are useful, fades unused ones, and strengthens connections between related facts.
          </p>
        </div>
      </div>

      {/* Warnings (real problems) */}
      {warnings.length > 0 && (
        <div className="space-y-1">
          {warnings.map((issue, i) => (
            <div key={i} className="flex items-start gap-2 text-compact text-warning">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{issue.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Stats grid — plain language */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard
          label="Memories Scored"
          value={h.outcome_feedback.engrams_with_outcomes}
          description="Memories that Nova has rated as useful or not, based on how conversations went."
          ok={h.outcome_feedback.engrams_with_outcomes > 0}
        />
        <StatCard
          label="Importance Adjusted"
          value={h.outcome_feedback.recalibration.recalibrated_total}
          description={
            h.outcome_feedback.recalibration.boost_eligible > 0
              ? `${h.outcome_feedback.recalibration.boost_eligible} memories ready to be boosted based on conversation quality.`
              : 'Memories that had their priority raised or lowered based on how useful they were.'
          }
          ok={h.outcome_feedback.recalibration.boost_eligible > 0 || h.outcome_feedback.recalibration.recalibrated_total > 0}
        />
        <StatCard
          label="Active Memories"
          value={totalMemories.toLocaleString()}
          description={`${h.activation.full} at full strength. Unused memories gradually fade to keep retrieval focused.`}
        />
      </div>

      {/* How retrieval works */}
      <Card className="p-3">
        <h4 className="text-compact font-medium text-content-primary mb-2">How Nova Retrieves Memories</h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-micro text-content-secondary">
          <div>
            <p className="text-content-tertiary uppercase font-semibold tracking-wider mb-0.5">Topics Organized</p>
            <p className="text-compact text-content-primary">{h.consolidation.living_topics}</p>
            <p>Clusters of related memories that help Nova find the right context.</p>
          </div>
          <div>
            <p className="text-content-tertiary uppercase font-semibold tracking-wider mb-0.5">Retrieval Signal</p>
            <p className="text-compact text-content-primary">{h.retrieval_observations.toLocaleString()} retrievals logged</p>
            <p>Nova records which memories it surfaces and which get used to improve future ranking.</p>
          </div>
          <div>
            <p className="text-content-tertiary uppercase font-semibold tracking-wider mb-0.5">Memory Connections</p>
            <p className="text-compact text-content-primary">{h.co_activations.edges_strengthened} strengthened</p>
            <p>When memories appear together in good conversations, Nova connects them for faster recall.</p>
          </div>
        </div>
      </Card>

      {/* Last maintenance */}
      {h.consolidation.last_run && h.consolidation.last_run_stats && (
        <Card className="p-3">
          <h4 className="text-compact font-medium text-content-primary mb-1">Last Memory Maintenance</h4>
          <p className="text-micro text-content-tertiary">{new Date(h.consolidation.last_run).toLocaleString()}</p>
          <div className="flex gap-4 mt-1 text-micro text-content-secondary">
            <span>{h.consolidation.last_run_stats.topics_created} new topics</span>
            <span>{h.consolidation.last_run_stats.engrams_merged} duplicates merged</span>
          </div>
        </Card>
      )}

      {/* Info notes (expected states, not problems) */}
      {infos.length > 0 && (
        <div className="space-y-1">
          {infos.map((issue, i) => (
            <div key={i} className="flex items-start gap-2 text-micro text-content-tertiary">
              <Info size={12} className="mt-0.5 shrink-0" />
              <span>{issue.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
