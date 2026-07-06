import { useState } from 'react'
import { Shield, ChevronDown, ChevronUp, Lock } from 'lucide-react'
import { Section, Badge } from '../../components/ui'
import { useConfigValue, type ConfigSectionProps } from './shared'
import { getPods, updatePod } from '../../api'

// ── Tier definitions ────────────────────────────────────────────────────────

type TierValue = 'workspace' | 'home' | 'isolated'

const TIERS: {
  value: TierValue
  label: string
  tagline: string
  bullets: string[]
  ring: string
  dot: string
}[] = [
  {
    value: 'workspace',
    label: 'Workspace',
    tagline: 'Project-scoped access',
    bullets: [
      'Read & write files in the configured workspace',
      'Shell commands scoped to the workspace',
      'Git operations scoped to the workspace',
      'Bind-mount isolated from your host filesystem',
    ],
    ring: 'ring-emerald-500/60',
    dot: 'bg-emerald-500',
  },
  {
    value: 'home',
    label: 'Home',
    tagline: 'Home directory access',
    bullets: [
      'Read & write files anywhere in your home directory',
      'Shell commands scoped to your home',
      'Git operations on any repo in your home',
      'Admin opt-in required — off by default',
    ],
    ring: 'ring-sky-500/60',
    dot: 'bg-sky-500',
  },
  {
    value: 'isolated',
    label: 'Isolated',
    tagline: 'Pure reasoning mode',
    bullets: [
      'No filesystem access',
      'No shell commands',
      'No git operations',
      'Text responses only',
    ],
    ring: 'ring-stone-400/60 dark:ring-stone-500/60',
    dot: 'bg-stone-400 dark:bg-stone-500',
  },
]

// ── Capability comparison table ─────────────────────────────────────────────

const CAPABILITY_ROWS: { label: string; values: Record<TierValue, string> }[] = [
  { label: 'Filesystem scope', values: { workspace: '/workspace', home: '~ (home dir)', isolated: 'None' } },
  { label: 'File read & write', values: { workspace: 'Scoped', home: 'Scoped', isolated: 'Blocked' } },
  { label: 'Shell commands', values: { workspace: 'Scoped', home: 'Scoped', isolated: 'Blocked' } },
  { label: 'Git operations', values: { workspace: 'Scoped', home: 'Scoped', isolated: 'Blocked' } },
  { label: 'Host fs exposure', values: { workspace: 'None', home: 'Your home dir', isolated: 'None' } },
  { label: 'Best for', values: { workspace: 'Project work', home: 'Multi-project', isolated: 'Reasoning' } },
]

function cellColor(value: string): string {
  if (value === 'Blocked' || value === 'None') return 'text-red-600 dark:text-red-400'
  if (value === 'Your home dir') return 'text-amber-600 dark:text-amber-400'
  if (value === 'Scoped') return 'text-emerald-600 dark:text-emerald-400'
  return 'text-content-secondary'
}

// ── Component ───────────────────────────────────────────────────────────────

export function SandboxSection({ entries, onSave, saving }: ConfigSectionProps) {
  const current = useConfigValue(entries, 'shell.sandbox', 'workspace') as TierValue
  const selfModRaw = useConfigValue(entries, 'nova.self_modification', 'false')
  const selfMod = selfModRaw === 'true'
  const homeEnabledRaw = useConfigValue(entries, 'sandbox.home_enabled', 'false')
  const homeEnabled = homeEnabledRaw === 'true'
  const [saved, setSaved] = useState(false)
  const [showTable, setShowTable] = useState(false)

  const handleSelect = async (value: TierValue) => {
    // Block home selection if the admin hasn't opted in. Backend also
    // enforces this (see _get_sandbox_tier in orchestrator/app/router.py),
    // but surfacing it in the UI avoids a confusing silent downgrade.
    if (value === 'home' && !homeEnabled) return

    // Save global platform config (used by Chat API path)
    onSave('shell.sandbox', JSON.stringify(value))

    // Also sync to all pods so the pipeline executor picks it up.
    try {
      const pods = await getPods()
      await Promise.all(pods.map((pod) => updatePod(pod.id, { sandbox: value })))
    } catch {
      // Pod sync failed — global config still saved, executor fallback handles it
    }

    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <Section
      icon={Shield}
      title="Agent Sandbox"
      description="Control what Nova's agents can access on the filesystem. Changes apply to new messages immediately."
    >
      {/* ── Mode cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {TIERS.map((tier) => {
          const isSelected = current === tier.value
          const locked = tier.value === 'home' && !homeEnabled
          return (
            <button
              key={tier.value}
              onClick={() => handleSelect(tier.value)}
              disabled={saving || locked}
              className={
                'relative rounded-md border p-3 text-left transition-all ' +
                (locked
                  ? 'border-border bg-surface-card opacity-60 cursor-not-allowed'
                  : isSelected
                    ? `ring-2 ${tier.ring} border-transparent bg-surface-elevated`
                    : 'border-border bg-surface-card hover:bg-surface-card-hover')
              }
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${tier.dot}`} />
                <span className="text-compact font-semibold text-content-primary">{tier.label}</span>
                {isSelected && !locked && <Badge color="success" size="sm">Active</Badge>}
                {locked && <Lock className="ml-auto h-3 w-3 text-content-tertiary" />}
              </div>
              <p className="mb-2 text-caption text-content-tertiary">{tier.tagline}</p>
              <ul className="space-y-1">
                {tier.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-1.5 text-caption text-content-secondary">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-content-tertiary" />
                    {b}
                  </li>
                ))}
              </ul>
              {locked && (
                <p className="mt-2 text-caption text-content-tertiary italic">
                  Enable "Home tier access" below to unlock.
                </p>
              )}
            </button>
          )
        })}
      </div>

      {saved && (
        <p className="mt-2 text-caption text-emerald-600 dark:text-emerald-400">
          Sandbox tier saved. New messages will use this setting.
        </p>
      )}

      {/* ── Comparison table toggle ────────────────────────────────── */}
      <button
        onClick={() => setShowTable(!showTable)}
        className="mt-4 flex items-center gap-1.5 text-caption font-medium text-content-tertiary hover:text-content-secondary transition-colors"
      >
        {showTable ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        Compare all capabilities
      </button>

      {showTable && (
        <div className="mt-2 overflow-x-auto rounded-md border border-border">
          <table className="w-full text-caption">
            <thead>
              <tr className="border-b border-border bg-surface-elevated">
                <th className="px-3 py-2 text-left font-medium text-content-tertiary">Capability</th>
                {TIERS.map((t) => (
                  <th
                    key={t.value}
                    className={
                      'px-3 py-2 text-center font-medium ' +
                      (current === t.value ? 'text-accent' : 'text-content-tertiary')
                    }
                  >
                    <span className="flex items-center justify-center gap-1.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
                      {t.label}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPABILITY_ROWS.map((row, i) => (
                <tr key={row.label} className={i % 2 === 0 ? '' : 'bg-surface-elevated/50'}>
                  <td className="px-3 py-1.5 font-medium text-content-secondary whitespace-nowrap">{row.label}</td>
                  {TIERS.map((t) => {
                    const val = row.values[t.value]
                    return (
                      <td
                        key={t.value}
                        className={
                          'px-3 py-1.5 text-center whitespace-nowrap ' +
                          cellColor(val) +
                          (current === t.value ? ' bg-accent/5' : '')
                        }
                      >
                        {val}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Home-tier opt-in (SEC-001) ─────────────────────────────── */}
      <div className="mt-6 pt-4 border-t border-border-subtle">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-compact font-medium text-content-primary">Home tier access</div>
            <div className="text-caption text-content-tertiary mt-0.5">
              Let agents read anywhere in your home directory. Off by default — enabling this
              widens the blast radius of prompt injection. Writing additionally requires{' '}
              <span className="font-mono">NOVA_HOME_MOUNT=rw</span> in .env (the mount is
              read-only by default) and a restart.
            </div>
          </div>
          <button
            onClick={() => onSave('sandbox.home_enabled', homeEnabled ? 'false' : 'true')}
            disabled={saving}
            className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${
              homeEnabled ? 'bg-amber-500' : 'bg-stone-700'
            }`}
            aria-label={homeEnabled ? 'Disable home tier' : 'Enable home tier'}
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              homeEnabled ? 'translate-x-5' : ''
            }`} />
          </button>
        </div>
      </div>

      {/* ── Self-modification toggle ──────────────────────────────── */}
      <div className="mt-4 pt-4 border-t border-border-subtle">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-compact font-medium text-content-primary">Self-Modification</div>
            <div className="text-caption text-content-tertiary mt-0.5">
              Allow Nova to read and modify its own source code and work in a dedicated workspace.
              Independent of the sandbox tier above.
            </div>
          </div>
          <button
            onClick={() => onSave('nova.self_modification', selfMod ? 'false' : 'true')}
            disabled={saving}
            className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${
              selfMod ? 'bg-amber-500' : 'bg-stone-700'
            }`}
            aria-label={selfMod ? 'Disable self-modification' : 'Enable self-modification'}
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              selfMod ? 'translate-x-5' : ''
            }`} />
          </button>
        </div>
        {selfMod && (
          <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <p className="text-caption text-amber-600 dark:text-amber-400">
              Nova can modify its own services, configuration, and pipelines.
              Changes are made in <code className="text-mono-sm bg-surface-elevated px-1 rounded">nova/</code> and{' '}
              <code className="text-mono-sm bg-surface-elevated px-1 rounded">nova/workspace/</code>.
            </p>
          </div>
        )}
      </div>
    </Section>
  )
}
