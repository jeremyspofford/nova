import { useQuery } from '@tanstack/react-query'
import {
  GitPullRequest, ExternalLink,
  AlertTriangle, CheckCircle,
} from 'lucide-react'
import { getSelfModStatus, getSelfModPRs, type SelfModPR } from '../../api'
import { Section, Skeleton } from '../../components/ui'

// ── Status Banner ────────────────────────────────────────────────────────────

function StatusBanner() {
  const { data: status, isLoading } = useQuery({
    queryKey: ['selfmod-status'],
    queryFn: getSelfModStatus,
    staleTime: 5000,
    retry: 1,
  })

  if (isLoading) return <Skeleton lines={2} />

  if (!status) {
    return (
      <div className="rounded-lg border border-border-subtle bg-surface-card p-4">
        <p className="text-compact text-content-tertiary">
          Unable to load self-modification status.
        </p>
      </div>
    )
  }

  const usagePercent = status.rate_limit_per_hour > 0
    ? Math.round((status.prs_this_hour / status.rate_limit_per_hour) * 100)
    : 0

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        {/* Enabled / Disabled */}
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${
            status.enabled ? 'bg-emerald-500' : 'bg-amber-500'
          }`} />
          <span className="text-compact font-medium text-content-primary">
            {status.enabled ? 'Self-modification enabled' : 'Self-modification disabled'}
          </span>
        </div>

        {/* PAT status */}
        <div className="flex items-center gap-1.5">
          {status.pat_configured ? (
            <>
              <CheckCircle size={14} className="text-emerald-500" />
              <span className="text-caption text-content-secondary">PAT configured</span>
            </>
          ) : (
            <>
              <AlertTriangle size={14} className="text-amber-500" />
              <span className="text-caption text-content-secondary">No PAT configured</span>
            </>
          )}
        </div>
      </div>

      {/* Rate limit bar */}
      <div className="flex items-center gap-3">
        <span className="text-caption text-content-tertiary whitespace-nowrap">
          {status.prs_this_hour}/{status.rate_limit_per_hour} PRs this hour
        </span>
        <div className="flex-1 max-w-48 h-1.5 rounded-full bg-stone-700/40 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              usagePercent >= 80 ? 'bg-amber-500' : 'bg-teal-500'
            }`}
            style={{ width: `${Math.min(usagePercent, 100)}%` }}
          />
        </div>
      </div>

      {!status.enabled && (
        <p className="text-caption text-content-tertiary">
          Enable in <code className="bg-surface-card px-1 py-0.5 rounded text-mono-sm">.env</code> or
          via the Recovery console.
        </p>
      )}
    </div>
  )
}

// ── PR Status / CI Badges ────────────────────────────────────────────────────

function CIBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  if (s === 'success' || s === 'passed') {
    return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro font-medium bg-emerald-500/15 text-emerald-400">success</span>
  }
  if (s === 'failure' || s === 'failed') {
    return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro font-medium bg-red-500/15 text-red-400">failure</span>
  }
  return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro font-medium bg-amber-500/15 text-amber-400">pending</span>
}

function PRStatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  if (s === 'merged') {
    return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro font-medium bg-purple-500/15 text-purple-400">merged</span>
  }
  if (s === 'closed') {
    return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro font-medium bg-stone-500/15 text-stone-400">closed</span>
  }
  return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro font-medium bg-teal-500/15 text-teal-400">open</span>
}

// ── PR History Table ─────────────────────────────────────────────────────────

function PRHistoryTable() {
  const { data: status } = useQuery({
    queryKey: ['selfmod-status'],
    queryFn: getSelfModStatus,
    staleTime: 5000,
    retry: 1,
  })

  const { data: prs, isLoading } = useQuery({
    queryKey: ['selfmod-prs'],
    queryFn: getSelfModPRs,
    staleTime: 5000,
    retry: 1,
  })

  if (isLoading) return <Skeleton lines={4} />

  if (!prs || prs.length === 0) {
    return (
      <div className="rounded-lg border border-border-subtle bg-surface-card p-6 text-center">
        <GitPullRequest size={24} className="mx-auto text-content-tertiary mb-2" />
        <p className="text-compact text-content-tertiary">
          No pull requests yet. Nova will create PRs here when it modifies its own code.
        </p>
      </div>
    )
  }

  // Construct GitHub base URL from repo config
  const repoUrl = status?.repo ? `https://github.com/${status.repo}` : null

  return (
    <div className="overflow-x-auto rounded-lg border border-border-subtle">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-border-subtle bg-surface-card">
            <th className="px-3 py-2 text-caption font-medium text-content-tertiary">PR#</th>
            <th className="px-3 py-2 text-caption font-medium text-content-tertiary">Title</th>
            <th className="px-3 py-2 text-caption font-medium text-content-tertiary hidden sm:table-cell">Branch</th>
            <th className="px-3 py-2 text-caption font-medium text-content-tertiary">CI</th>
            <th className="px-3 py-2 text-caption font-medium text-content-tertiary hidden md:table-cell">Created</th>
            <th className="px-3 py-2 text-caption font-medium text-content-tertiary">Status</th>
          </tr>
        </thead>
        <tbody>
          {prs.map((pr: SelfModPR) => (
            <tr key={pr.id} className="border-b border-border-subtle last:border-0 hover:bg-surface-card/50">
              <td className="px-3 py-2 text-compact font-mono">
                {repoUrl ? (
                  <a
                    href={`${repoUrl}/pull/${pr.pr_number}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-teal-400 hover:text-teal-300 inline-flex items-center gap-1"
                  >
                    #{pr.pr_number}
                    <ExternalLink size={11} />
                  </a>
                ) : (
                  <span className="text-content-primary">#{pr.pr_number}</span>
                )}
              </td>
              <td className="px-3 py-2 text-compact text-content-primary max-w-xs truncate">
                {pr.title}
              </td>
              <td className="px-3 py-2 text-mono-sm text-content-secondary hidden sm:table-cell max-w-40 truncate">
                {pr.branch_name}
              </td>
              <td className="px-3 py-2">
                <CIBadge status={pr.ci_status} />
              </td>
              <td className="px-3 py-2 text-caption text-content-tertiary hidden md:table-cell whitespace-nowrap">
                {new Date(pr.created_at).toLocaleDateString()}
              </td>
              <td className="px-3 py-2">
                <PRStatusBadge status={pr.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Main Section ─────────────────────────────────────────────────────────────

export function SelfModSection() {
  return (
    <Section
      icon={GitPullRequest}
      title="Self-Modification"
      description="Nova can modify its own codebase by creating pull requests. All changes go through CI and require approval."
    >
      <div className="space-y-6">
        <StatusBanner />

        <div>
          <h4 className="text-compact font-semibold text-content-primary mb-3">Pull Request History</h4>
          <PRHistoryTable />
        </div>

        {/* Safety rules have ONE home (Behavior → Rules) — no duplicate list
            here to drift out of sync with the real enforcement config. */}
        <p className="text-caption text-content-tertiary">
          Self-modification is constrained by the system safety rules (no-force-push,
          no-push-main, workspace-boundary, …) enforced on every tool call. Manage them
          under <a href="#rules" className="text-accent hover:underline">Behavior → Rules</a>.
        </p>
      </div>
    </Section>
  )
}
