import { useCallback, useEffect, useState } from 'react'
import { Copy, Laptop, Plus, RefreshCw } from 'lucide-react'
import { Badge, Button, EmptyState, Input, Modal, Section, Skeleton, StatusDot } from '../../components/ui'
import {
  listDevices as apiListDevices,
  mintPairingCode as apiMintPairingCode,
  renameDevice as apiRenameDevice,
  revokeDevice as apiRevokeDevice,
  type Device,
  type PairingCode,
} from '../../lib/api'
import { deviceLiveness, enrollCommand } from './devicesFormat'

/**
 * Settings → Devices (S5-T4): the machines Nova can act on. Each tile is a
 * device you paired; its liveness is DERIVED from `last_seen` freshness (a
 * heartbeat bumps it to core's clock — see devicesFormat.deviceLiveness), NOT
 * from the REST `connected` field, which is always false on this route by
 * design (controller ruling R2). A never-seen device reads "never connected",
 * never a green dot (DoD item 5). A light poll (default 15s) refetches while
 * mounted so a reconnected device turns green with no operator action.
 *
 * Pairing is the whole of what a device is allowed: there is no grants editor
 * here because there is no grant (owner ruling 2026-09-03) — a paired device
 * does everything the user novad runs as can do, and the two controls that
 * remain are a name and Revoke, which ends the pairing.
 *
 * `api` is the same dependency-injection seam ActivityPage uses: production
 * binds the real lib/api calls; tests inject fakes. `pollIntervalMs` is
 * injectable so a test can drive the refresh, like ChatPage's poll knobs.
 */
interface DevicesApi {
  listDevices: typeof apiListDevices
  mintPairingCode: typeof apiMintPairingCode
  renameDevice: typeof apiRenameDevice
  revokeDevice: typeof apiRevokeDevice
}

const DEFAULT_API: DevicesApi = {
  listDevices: apiListDevices,
  mintPairingCode: apiMintPairingCode,
  renameDevice: apiRenameDevice,
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
      description="Machines Nova can act on. Each is a key you paired, and a paired device can do everything you can — revoke it to end that."
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
          description="Pair a computer to let Nova read from it and act on it — a paired device can do everything you can."
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

  // Revoke
  const [confirmingRevoke, setConfirmingRevoke] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)

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
