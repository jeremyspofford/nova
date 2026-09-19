import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Server } from 'lucide-react'
import { Badge, Button, Section, Skeleton, Toggle } from '../../components/ui'
import { getMachines as apiGetMachines, setMachineServing as apiSetMachineServing, type Machine } from '../../lib/api'
import type { SemanticColor } from '../../lib/design-tokens'
import { formatBytes } from '../../lib/pullStream'
import { lifecycleLabel, machineStateLabel, readBackMismatch } from './machinesFormat'

/**
 * Settings → Models → Machines (S40): where Nova's models run. In S40 that
 * is one machine, the bundled engine `hub`. The tile states what the
 * gateway observed: its state (with the reason when it is not ready), its
 * compute identity (shown raw; null is said, never guessed), its runtime,
 * and the models it holds.
 *
 * The one control is the owner's switch (`engines.serving`). It is NOT
 * optimistic: the tile shows the row core read back after the write, and a
 * read-back that disagrees with the request is said in words. `api` is
 * DevicesSection's injection seam.
 *
 * The section's description words only what the gateway enforces: the
 * switch is read by the role walk alone (S40 T3's decision, carried as G6).
 * A request with no role (an eval or a model_read naming its model) is
 * still served on a switched-off machine, and a role with no other link
 * gets a stated 503, so "sent no model calls" would be a claim, not a fact.
 */
interface MachinesApi {
  getMachines: typeof apiGetMachines
  setMachineServing: typeof apiSetMachineServing
}

const DEFAULT_API: MachinesApi = { getMachines: apiGetMachines, setMachineServing: apiSetMachineServing }

const bannerClass = 'rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger'

/** The text colour of a state that is written out as a line, not a badge. */
const STATE_TEXT: Record<SemanticColor, string> = {
  neutral: 'text-content-secondary',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function MachinesSection({ api = DEFAULT_API }: { api?: MachinesApi } = {}) {
  const [machines, setMachines] = useState<Machine[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // An answer with no list is a failure, never "no machines": an empty box
  // and a broken read must not look the same.
  const apply = useCallback((body: { machines?: Machine[] } | null | undefined) => {
    if (!Array.isArray(body?.machines)) throw new Error('the answer carried no list of machines')
    setMachines(body.machines)
    setLoadError(null)
  }, [])

  useEffect(() => {
    let live = true
    api
      .getMachines()
      .then(body => {
        if (live) apply(body)
      })
      .catch(err => {
        if (live) setLoadError(reasonOf(err))
      })
    return () => {
      live = false
    }
  }, [api, apply])

  // Refresh looks again: a button that re-reads the gateway's cached
  // reading would say "checked" about a check it did not make.
  const refresh = useCallback(async () => {
    try {
      apply(await api.getMachines({ live: true }))
    } catch (err) {
      setLoadError(reasonOf(err))
    }
  }, [api, apply])

  const onStored = useCallback((row: Machine) => {
    setMachines(prev => (prev ? prev.map(m => (m.name === row.name ? row : m)) : prev))
  }, [])

  return (
    <Section
      icon={Server}
      title="Machines"
      description="Where Nova's models run. Routing passes over a machine that is switched off: the next link in the role's chain answers instead, and a role with no other link fails and says why. A call that names its model directly is still served there."
    >
      {loadError && (
        <div role="alert" className={bannerClass}>
          Could not read the machines: {loadError}
        </div>
      )}
      {machines === null ? (
        !loadError && (
          <div data-testid="machines-skeleton">
            <Skeleton lines={3} />
          </div>
        )
      ) : machines.length === 0 ? (
        <p className="text-caption text-content-secondary" data-testid="machines-none">
          No machine runs models for Nova right now.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-caption text-content-tertiary">
              {machines.length} {machines.length === 1 ? 'machine' : 'machines'}
            </span>
            <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void refresh()}>
              Refresh
            </Button>
          </div>
          <div className="divide-y divide-border-subtle">
            {machines.map(m => (
              <MachineTile key={m.name} machine={m} api={api} onStored={onStored} />
            ))}
          </div>
        </>
      )}
    </Section>
  )
}

function MachineTile({ machine, api, onStored }: { machine: Machine; api: MachinesApi; onStored: (row: Machine) => void }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = machineStateLabel(machine)
  // A reason can be a sentence with a URL in it. A badge is one fixed line
  // and cannot wrap, so a label that carries one gets a line of its own.
  const carriesReason = !!machine.reason && state.text.includes(machine.reason)

  async function setServing(asked: boolean) {
    setSaving(true)
    setError(null)
    try {
      const stored = await api.setMachineServing(machine.name, asked)
      onStored(stored) // what the machine READ BACK, never `asked`
      setError(readBackMismatch(machine.name, asked, stored))
    } catch (err) {
      setError(`Could not change ${machine.name}: ${reasonOf(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="py-3 space-y-2 min-w-0" data-testid={`machine-${machine.name}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-content-primary">{machine.name}</span>
        {!carriesReason && (
          <span data-testid={`machine-${machine.name}-state`}>
            <Badge size="sm" color={state.color} dot={state.color === 'success'}>
              {state.text}
            </Badge>
          </span>
        )}
        <span className="text-caption text-content-tertiary">{lifecycleLabel(machine.lifecycle)}</span>
        {machine.runtime && (
          <span className="font-mono text-micro text-content-tertiary" data-testid={`machine-${machine.name}-runtime`}>
            {machine.runtime}
          </span>
        )}
      </div>
      {carriesReason && (
        <p className={`text-caption break-words ${STATE_TEXT[state.color]}`} data-testid={`machine-${machine.name}-state`}>
          {state.text}
        </p>
      )}
      <p className="font-mono text-micro text-content-secondary break-all" data-testid={`machine-${machine.name}-compute`}>
        {machine.compute ?? 'compute not identified'}
      </p>
      {machine.models.length > 0 ? (
        <ul className="space-y-0.5 text-caption text-content-secondary" data-testid={`machine-${machine.name}-models`}>
          {machine.models.map(model => (
            <li key={model.name} className="flex flex-wrap gap-x-2 min-w-0">
              <span className="font-mono break-all">{model.name}</span>
              {model.size_bytes !== null && <span className="text-content-tertiary">{formatBytes(model.size_bytes)}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-caption text-content-tertiary">No models listed.</p>
      )}
      <Toggle
        id={`machine-serving-${machine.name}`}
        label="This machine runs chat models"
        checked={machine.serving}
        disabled={saving}
        onChange={value => void setServing(value)}
        className="min-h-[44px]"
      />
      {error && (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
