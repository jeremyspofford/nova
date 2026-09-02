import { useCallback, useEffect, useState } from 'react'
import { Copy, Laptop, Plus, RefreshCw } from 'lucide-react'
import { Badge, Button, Checkbox, EmptyState, Input, Modal, Section, Skeleton, StatusDot } from '../../components/ui'
import { InlineSave, type SaveMessage } from './shared'
import {
  listDevices as apiListDevices,
  mintPairingCode as apiMintPairingCode,
  renameDevice as apiRenameDevice,
  setGrants as apiSetGrants,
  revokeDevice as apiRevokeDevice,
  type Device,
  type PairingCode,
} from '../../lib/api'
import { CAPABILITY_GROUPS, deviceLiveness, enrollCommand, fsRootRefusal, grantsRefusal } from './devicesFormat'

/**
 * Settings → Devices (S5-T4): the machines Nova can act on. Each tile is a
 * device you paired; its liveness is DERIVED from `last_seen` freshness (a
 * heartbeat bumps it to core's clock — see devicesFormat.deviceLiveness), NOT
 * from the REST `connected` field, which is always false on this route by
 * design (controller ruling R2). A never-seen device reads "never connected",
 * never a green dot (DoD item 5). A light poll (default 15s) refetches while
 * mounted so a reconnected device turns green with no operator action.
 *
 * `api` is the same dependency-injection seam AutonomySection uses: production
 * binds the real lib/api calls; tests inject fakes. `pollIntervalMs` is
 * injectable so a test can drive the refresh, like ChatPage's poll knobs.
 */
interface DevicesApi {
  listDevices: typeof apiListDevices
  mintPairingCode: typeof apiMintPairingCode
  renameDevice: typeof apiRenameDevice
  setGrants: typeof apiSetGrants
  revokeDevice: typeof apiRevokeDevice
}

const DEFAULT_API: DevicesApi = {
  listDevices: apiListDevices,
  mintPairingCode: apiMintPairingCode,
  renameDevice: apiRenameDevice,
  setGrants: apiSetGrants,
  revokeDevice: apiRevokeDevice,
}

const POLL_INTERVAL_MS = 15_000

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const bannerClass =
  'rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger'

export function DevicesSection({
  api = DEFAULT_API,
  pollIntervalMs = POLL_INTERVAL_MS,
}: { api?: DevicesApi; pollIntervalMs?: number } = {}) {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pairingOpen, setPairingOpen] = useState(false)

  const applyRows = useCallback((rows: Device[]) => {
    setDevices(rows)
    setLoadError(null)
  }, [])

  const refresh = useCallback(async () => {
    try {
      applyRows(await api.listDevices())
    } catch (err) {
      setLoadError(reasonOf(err))
    }
  }, [api, applyRows])

  useEffect(() => {
    let live = true
    // Initial load surfaces a failure; a later poll failure keeps the last
    // known list rather than wiping it — a transient blip is not "no devices".
    api
      .listDevices()
      .then(rows => {
        if (live) applyRows(rows)
      })
      .catch(err => {
        if (live) setLoadError(reasonOf(err))
      })
    const id = setInterval(() => {
      api
        .listDevices()
        .then(rows => {
          if (live) applyRows(rows)
        })
        .catch(() => {})
    }, pollIntervalMs)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [api, applyRows, pollIntervalMs])

  const onDeviceUpdated = useCallback((updated: Device) => {
    setDevices(prev => (prev ? prev.map(d => (d.id === updated.id ? updated : d)) : prev))
  }, [])

  const closePairing = useCallback(() => {
    setPairingOpen(false)
    // A freshly enrolled device shows up on the next list read — not by
    // auto-polling for it, just by refetching once the modal closes.
    void refresh()
  }, [refresh])

  return (
    <Section
      icon={Laptop}
      title="Devices"
      description="Machines Nova can act on. Each is a key you paired; grant only what you want it to do."
    >
      {loadError && (
        <div role="alert" className={bannerClass}>
          Could not load devices: {loadError}
        </div>
      )}

      {devices === null ? (
        !loadError && (
          <div data-testid="devices-skeleton">
            <Skeleton lines={3} />
          </div>
        )
      ) : devices.length === 0 ? (
        <EmptyState
          icon={Laptop}
          title="No devices paired"
          description="Pair a computer to let Nova read from it or act on it — you decide exactly what."
          action={{ label: 'Pair a device', onClick: () => setPairingOpen(true) }}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-caption text-content-tertiary">
              {devices.length} {devices.length === 1 ? 'device' : 'devices'}
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void refresh()}>
                Refresh
              </Button>
              <Button size="sm" icon={<Plus size={12} />} onClick={() => setPairingOpen(true)}>
                Pair a device
              </Button>
            </div>
          </div>
          <div className="divide-y divide-border-subtle">
            {devices.map(device => (
              <DeviceTile key={device.id} device={device} api={api} onUpdated={onDeviceUpdated} />
            ))}
          </div>
        </>
      )}

      <PairingModal open={pairingOpen} onClose={closePairing} api={api} />
    </Section>
  )
}

// ── one device ─────────────────────────────────────────────────────────────

function DeviceTile({
  device,
  api,
  onUpdated,
}: {
  device: Device
  api: DevicesApi
  onUpdated: (device: Device) => void
}) {
  const live = deviceLiveness(device)
  const revoked = live.state === 'revoked'

  // Rename
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(device.name)
  const [renameSaving, setRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  // Grants (capability set + fs roots), edited from a draft echoed off the row.
  const [grantsOpen, setGrantsOpen] = useState(false)
  const capsKey = device.capabilities.slice().sort().join(',')
  const rootsKey = device.fs_roots.join('\n')
  const [draftCaps, setDraftCaps] = useState<Set<string>>(() => new Set(device.capabilities))
  const [draftRoots, setDraftRoots] = useState<string[]>(() => device.fs_roots)
  const [newRoot, setNewRoot] = useState('')
  const [rootError, setRootError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<SaveMessage | null>(null)

  // Resync the draft only when the SAVED grant actually changes (keyed on its
  // content, not the object identity) — so the 15s poll handing us a fresh but
  // identical row does not wipe an in-progress edit.
  useEffect(() => {
    setDraftCaps(new Set(device.capabilities))
    setDraftRoots(device.fs_roots)
    setSaveMsg(null)
    setRootError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capsKey, rootsKey])

  // Revoke
  const [confirmingRevoke, setConfirmingRevoke] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  const draftCapsKey = Array.from(draftCaps).sort().join(',')
  const draftRootsKey = draftRoots.join('\n')
  const dirty = draftCapsKey !== capsKey || draftRootsKey !== rootsKey

  async function saveName() {
    const next = nameDraft.trim()
    if (next === '' || next === device.name) {
      setRenaming(false)
      return
    }
    setRenameSaving(true)
    setRenameError(null)
    try {
      onUpdated(await api.renameDevice(device.id, next))
      setRenaming(false)
    } catch (err) {
      setRenameError(reasonOf(err))
    } finally {
      setRenameSaving(false)
    }
  }

  function toggleCap(token: string, checked: boolean) {
    setDraftCaps(prev => {
      const next = new Set(prev)
      if (checked) next.add(token)
      else next.delete(token)
      return next
    })
  }

  function addRoot() {
    const refusal = fsRootRefusal(newRoot)
    if (refusal) {
      setRootError(refusal)
      return
    }
    const trimmed = newRoot.trim()
    if (draftRoots.includes(trimmed)) {
      setRootError('That path is already in the list.')
      return
    }
    setDraftRoots([...draftRoots, trimmed])
    setNewRoot('')
    setRootError(null)
  }

  function addSuggestedRoot(root: string) {
    if (!draftRoots.includes(root)) setDraftRoots([...draftRoots, root])
    setRootError(null)
    setSaveMsg(null)
  }

  async function saveGrants() {
    // An fs.* capability with no root is a dead grant — core refuses it (400)
    // with these same words; refusing here first is the fast feedback, and the
    // PUT is never made for a save that could only be refused.
    const refusal = grantsRefusal(draftCaps, draftRoots, device.home_dir)
    if (refusal) {
      setSaveMsg({ kind: 'err', text: refusal })
      return
    }
    // The draft is seeded from the device's CURRENT capabilities, so saving the
    // whole set (sorted for a stable payload) PRESERVES any capability the row
    // holds that this UI doesn't render — never filter to a hardcoded 8, or a
    // capability added server-side would be silently stripped on the next save.
    const capabilities = Array.from(draftCaps).sort()
    setSaving(true)
    setSaveMsg(null)
    try {
      onUpdated(await api.setGrants(device.id, { capabilities, fs_roots: draftRoots }))
      setSaveMsg({ kind: 'ok', text: 'Saved' })
    } catch (err) {
      setSaveMsg({ kind: 'err', text: reasonOf(err) })
    } finally {
      setSaving(false)
    }
  }

  async function doRevoke() {
    setRevoking(true)
    setRevokeError(null)
    try {
      onUpdated(await api.revokeDevice(device.id))
    } catch (err) {
      setRevokeError(reasonOf(err))
    } finally {
      setRevoking(false)
      setConfirmingRevoke(false)
    }
  }

  return (
    <div className="py-3" data-testid={`device-${device.id}`}>
      <div className="flex items-center gap-3 flex-wrap">
        <LivenessIndicator state={live.state} label={live.label} pulse={live.pulse} />

        {renaming ? (
          <span className="flex items-center gap-2">
            <Input
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              className="h-7"
              aria-label="Device name"
            />
            <Button size="sm" loading={renameSaving} onClick={saveName}>
              Save name
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRenaming(false)
                setNameDraft(device.name)
                setRenameError(null)
              }}
            >
              Cancel
            </Button>
          </span>
        ) : (
          <span className="flex items-center gap-2 min-w-0">
            <span className={revoked ? 'font-medium text-content-tertiary line-through' : 'font-medium text-content-primary'}>
              {device.name}
            </span>
            {!revoked && (
              <Button size="sm" variant="ghost" onClick={() => { setNameDraft(device.name); setRenaming(true) }}>
                Rename
              </Button>
            )}
          </span>
        )}

        <span className="font-mono text-micro text-content-tertiary truncate">
          {device.platform} · {device.hostname}
        </span>

        {!revoked && (
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setGrantsOpen(open => !open)}>
              Grants
            </Button>
            {confirmingRevoke ? (
              <>
                <Button size="sm" variant="danger" loading={revoking} onClick={doRevoke}>
                  Confirm revoke
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmingRevoke(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setConfirmingRevoke(true)}>
                Revoke
              </Button>
            )}
          </span>
        )}
      </div>

      {renameError && <p className="mt-2 text-caption text-danger">Could not rename: {renameError}</p>}
      {revokeError && <p className="mt-2 text-caption text-danger">Could not revoke: {revokeError}</p>}

      {grantsOpen && !revoked && (
        <div className="mt-3 pl-1 space-y-4">
          {CAPABILITY_GROUPS.map(group => (
            <div key={group.title}>
              <p className="mb-1.5 text-caption font-medium text-content-secondary">{group.title}</p>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {group.caps.map(cap => (
                  <Checkbox
                    key={cap.token}
                    // Device-scoped id: ui/Checkbox otherwise derives the id
                    // from the label, so the SAME id would repeat across every
                    // tile and a label click would toggle the FIRST tile's box,
                    // silently granting the wrong machine.
                    id={`${device.id}-${cap.token}`}
                    checked={draftCaps.has(cap.token)}
                    onChange={checked => toggleCap(cap.token, checked)}
                    label={`${cap.label} (${cap.token})`}
                  />
                ))}
              </div>
            </div>
          ))}

          <div>
            <p className="mb-1.5 text-caption font-medium text-content-secondary">
              Filesystem roots (fs.* is scoped to these)
            </p>
            {draftRoots.length === 0 ? (
              <p className="text-caption text-content-tertiary italic">
                No roots yet — fs.read/list/write can reach nothing until you add one.
              </p>
            ) : (
              <ul className="space-y-1">
                {draftRoots.map(root => (
                  <li key={root} className="flex items-center gap-2">
                    <code className="font-mono text-mono-sm text-content-primary">{root}</code>
                    <button
                      type="button"
                      aria-label={`Remove ${root}`}
                      className="text-content-tertiary hover:text-danger"
                      onClick={() => setDraftRoots(draftRoots.filter(r => r !== root))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {device.home_dir !== null && !draftRoots.includes(device.home_dir) && (
              // The root the operator almost always wants: the machine's own
              // home, as the daemon reported it. Offered, never pre-added — a
              // device reporting its home must not widen its own grant.
              <p className="mt-1.5 flex items-center gap-2 text-caption text-content-secondary">
                <span>
                  Suggested root:{' '}
                  <code className="font-mono text-mono-sm text-content-primary">{device.home_dir}</code>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="Add suggested root"
                  onClick={() => addSuggestedRoot(device.home_dir as string)}
                >
                  Add
                </Button>
              </p>
            )}
            <div className="mt-2 flex items-start gap-2">
              <div className="flex-1">
                <Input
                  value={newRoot}
                  onChange={e => setNewRoot(e.target.value)}
                  placeholder="/absolute/path"
                  error={rootError ?? undefined}
                  aria-label="New filesystem root"
                />
              </div>
              <Button size="sm" variant="secondary" onClick={addRoot}>
                Add root
              </Button>
            </div>
          </div>

          <InlineSave
            dirty={dirty}
            saving={saving}
            onSave={saveGrants}
            onReset={() => {
              setDraftCaps(new Set(device.capabilities))
              setDraftRoots(device.fs_roots)
              setNewRoot('')
              setRootError(null)
              setSaveMsg(null)
            }}
            message={saveMsg}
          />
        </div>
      )}
    </div>
  )
}

function LivenessIndicator({ state, label, pulse }: { state: string; label: string; pulse: boolean }) {
  if (state === 'online') {
    return (
      <Badge size="sm" color="success" dot>
        online
      </Badge>
    )
  }
  if (state === 'revoked') {
    return (
      <Badge size="sm" color="neutral">
        revoked
      </Badge>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-content-tertiary">
      <StatusDot status="neutral" pulse={pulse} size="sm" />
      <span>{label}</span>
    </span>
  )
}

// ── pairing modal ────────────────────────────────────────────────────────

type PairingState =
  | { status: 'minting' }
  | { status: 'error'; reason: string }
  | { status: 'ready'; code: PairingCode }

function PairingModal({
  open,
  onClose,
  api,
}: {
  open: boolean
  onClose: () => void
  api: DevicesApi
}) {
  const [state, setState] = useState<PairingState>({ status: 'minting' })

  useEffect(() => {
    if (!open) return
    let live = true
    setState({ status: 'minting' })
    api
      .mintPairingCode()
      .then(code => {
        if (live) setState({ status: 'ready', code })
      })
      .catch(err => {
        if (live) setState({ status: 'error', reason: reasonOf(err) })
      })
    return () => {
      live = false
    }
  }, [open, api])

  const oneLiner =
    state.status === 'ready' ? enrollCommand(window.location.origin, state.code.code) : ''

  return (
    <Modal open={open} onClose={onClose} size="md" title="Pair a device">
      <div role="dialog" aria-label="Pair a device" className="space-y-4">
        {state.status === 'minting' && <Skeleton lines={3} />}
        {state.status === 'error' && (
          <div role="alert" className={bannerClass}>
            Could not create a pairing code: {state.reason}
          </div>
        )}
        {state.status === 'ready' && (
          <>
            <p className="text-caption text-content-secondary">
              On the machine you want to pair, run novad with this code. The code
              is shown once and expires — mint a new one if it lapses.
            </p>
            <div className="text-center">
              <div className="font-mono text-h1 tracking-[0.2em] text-content-primary">
                {state.code.code}
              </div>
              <p className="mt-1 text-caption text-content-tertiary">
                Expires at {new Date(state.code.expires_at).toLocaleTimeString()}
              </p>
            </div>
            <div>
              <p className="mb-1.5 text-caption font-medium text-content-secondary">
                Run this on the device
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-sm bg-surface-elevated px-3 py-2 font-mono text-mono-sm text-content-primary">
                  {oneLiner}
                </code>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Copy size={12} />}
                  onClick={() => void navigator.clipboard?.writeText(oneLiner)}
                >
                  Copy
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
