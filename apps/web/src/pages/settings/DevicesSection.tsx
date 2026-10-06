import { useCallback, useEffect, useState } from 'react'
import { Laptop, Plus, RefreshCw } from 'lucide-react'
import { Badge, Button, EmptyState, Input, Section, Skeleton, StatusDot } from '../../components/ui'
import {
  getAgentManifest as apiGetAgentManifest,
  getNetworkAddress as apiGetNetworkAddress,
  listDevices as apiListDevices,
  mintPairingCode as apiMintPairingCode,
  mintRepairCode as apiMintRepairCode,
  renameDevice as apiRenameDevice,
  revokeDevice as apiRevokeDevice,
  updateDevice as apiUpdateDevice,
  type Device,
} from '../../lib/api'
import {
  deviceLiveness,
  deviceSubtitle,
  lastUpdateLine,
  revokedToggleLabel,
  splitDevicesByRevoked,
  updateSaid,
  wslNote,
} from './devicesFormat'
import { SetupModal } from './SetupModal'

/** S42b E2 (Task 17/22's ruling, "the door is not identity"): anything that
 *  reaches the hub machine's own loopback door comes in as `hub` — a relay
 *  there (the owner's tunnel, an ssh -L) comes in the same way. So the
 *  badge never claims identity on that alone: it reads "Hub's door", and
 *  this is both its hover title and its accessible name. Core says the same
 *  fact the same way (services/core/app/network.py's door_of). */
const HUB_DOOR_TITLE =
  "Came in through the hub machine's own door — a tunnel or ssh -L on the hub comes in the same way."

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
 * does everything the user novad runs as can do. The controls that remain are
 * a name, Re-pair (mint a code bound to this one machine, S42b decision 4),
 * Update (only when its agent is behind the hub's build) and Revoke, which
 * ends the pairing — none of them is a grant.
 *
 * Revoked devices are hidden from the list by default (owner ruling
 * 2026-09-28) behind a "Show revoked (N)" toggle — display only; the API
 * still returns them and history/audit records are untouched. See
 * devicesFormat.splitDevicesByRevoked.
 *
 * "Pair a device" opens the S47 machine setup (SetupModal, setup="add_machine"):
 * the same QR code, code and command on Nova's derived address that the
 * Add-to-Nova tile opens, so there is exactly one pairing UI in this app.
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
  getNetworkAddress: typeof apiGetNetworkAddress
  getAgentManifest: typeof apiGetAgentManifest
  mintRepairCode: typeof apiMintRepairCode
  updateDevice: typeof apiUpdateDevice
}

const DEFAULT_API: DevicesApi = {
  listDevices: apiListDevices,
  mintPairingCode: apiMintPairingCode,
  renameDevice: apiRenameDevice,
  revokeDevice: apiRevokeDevice,
  getNetworkAddress: apiGetNetworkAddress,
  getAgentManifest: apiGetAgentManifest,
  mintRepairCode: apiMintRepairCode,
  updateDevice: apiUpdateDevice,
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
  const [showRevoked, setShowRevoked] = useState(false)
  // S42b decision 4: a code bound to ONE live machine, re-minted only when
  // `repair.id` changes (SetupModal's effect keys on it) — never while the
  // owner is sitting on the card typing it in, since nothing here re-sets
  // this to an equal-but-new object on every poll tick.
  const [repairing, setRepairing] = useState<{ id: string; name: string } | null>(null)

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

  // Re-pair (S42b decision 4): mint a code bound to THIS one machine rather
  // than a fresh pairing — the same SetupModal, keyed differently.
  const onRepair = useCallback((device: Device) => {
    setRepairing({ id: device.id, name: device.name })
  }, [])

  const closeSetup = useCallback(() => {
    setPairingOpen(false)
    setRepairing(null)
    // A freshly enrolled (or re-paired) device shows up on the next list
    // read — not by auto-polling for it, just by refetching once the modal
    // closes.
    void refresh()
  }, [refresh])

  const { live: liveDevices, revoked: revokedDevices } = splitDevicesByRevoked(devices ?? [])

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
      ) : liveDevices.length === 0 && revokedDevices.length === 0 ? (
        <EmptyState
          icon={Laptop}
          title="No devices paired"
          description="Pair a computer to let Nova read from it and act on it — a paired device can do everything you can."
          action={{ label: 'Pair a device', onClick: () => setPairingOpen(true) }}
        />
      ) : liveDevices.length === 0 ? (
        <div className="flex flex-col items-center gap-3">
          <EmptyState
            icon={Laptop}
            title="No devices paired"
            description="Pair a computer to let Nova read from it and act on it — a paired device can do everything you can."
            action={{ label: 'Pair a device', onClick: () => setPairingOpen(true) }}
          />
          <RevokedToggle
            count={revokedDevices.length}
            shown={showRevoked}
            onToggle={() => setShowRevoked(v => !v)}
            className="-mt-4"
          />
          {showRevoked && (
            <div className="w-full divide-y divide-border-subtle">
              {revokedDevices.map(device => (
                <DeviceTile
                  key={device.id}
                  device={device}
                  api={api}
                  onUpdated={onDeviceUpdated}
                  onRepair={onRepair}
                  onRefresh={refresh}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-caption text-content-tertiary">
                {liveDevices.length} {liveDevices.length === 1 ? 'device' : 'devices'}
              </span>
              {revokedDevices.length > 0 && (
                <RevokedToggle
                  count={revokedDevices.length}
                  shown={showRevoked}
                  onToggle={() => setShowRevoked(v => !v)}
                />
              )}
            </div>
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
            {liveDevices.map(device => (
              <DeviceTile
                key={device.id}
                device={device}
                api={api}
                onUpdated={onDeviceUpdated}
                onRepair={onRepair}
                onRefresh={refresh}
              />
            ))}
            {showRevoked &&
              revokedDevices.map(device => (
                <DeviceTile
                  key={device.id}
                  device={device}
                  api={api}
                  onUpdated={onDeviceUpdated}
                  onRepair={onRepair}
                  onRefresh={refresh}
                />
              ))}
          </div>
        </>
      )}

      <SetupModal
        setup={pairingOpen || repairing ? 'add_machine' : null}
        repair={repairing}
        onClose={closeSetup}
        api={api}
      />
    </Section>
  )
}

// ── one device ─────────────────────────────────────────────────────────────

function DeviceTile({
  device,
  api,
  onUpdated,
  onRepair,
  onRefresh,
}: {
  device: Device
  api: DevicesApi
  onUpdated: (device: Device) => void
  /** Opens the S47 setup modal re-pairing THIS machine (S42b decision 4). */
  onRepair: (device: Device) => void
  /** Re-reads the whole device list — what a `not_known_yet` update outcome
   *  needs (S42b E4): whether it reached the agent is genuinely unknown
   *  here, so the next poll's own facts are what can say more. */
  onRefresh: () => void
}) {
  const live = deviceLiveness(device)
  const revoked = live.state === 'revoked'
  const note = wslNote(device)

  // Rename
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(device.name)
  const [renameSaving, setRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  // Revoke
  const [confirmingRevoke, setConfirmingRevoke] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  // Update (S42b decision 2)
  const [updating, setUpdating] = useState(false)
  const [updateSaidText, setUpdateSaidText] = useState<string | null>(null)

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

  async function doUpdate() {
    setUpdating(true)
    setUpdateSaidText(null)
    try {
      const out = await api.updateDevice(device.id)
      setUpdateSaidText(updateSaid(out))
      // A cannot that names the owner's one step opens the re-pair card
      // directly (P12: she names the step, never sends the card herself).
      if (out.needs_card) onRepair(device)
      // S42b E4: whether a `not_known_yet` update reached the agent is
      // genuinely unknown here — re-read the list so the next poll's own
      // facts (build_state, last_update) can say more than this reply can.
      if (out.outcome === 'not_known_yet') onRefresh()
    } catch (err) {
      setUpdateSaidText(`Could not update: ${reasonOf(err)}`)
    } finally {
      setUpdating(false)
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
            {device.hub && (
              <span title={HUB_DOOR_TITLE} aria-label={HUB_DOOR_TITLE}>
                <Badge size="sm" color="accent">Hub’s door</Badge>
              </span>
            )}
            {!revoked && (
              <Button size="sm" variant="ghost" onClick={() => { setNameDraft(device.name); setRenaming(true) }}>
                Rename
              </Button>
            )}
          </span>
        )}

        <span className="font-mono text-micro text-content-tertiary min-w-0 break-words">
          {deviceSubtitle(device)}
        </span>

        {!revoked && (
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => onRepair(device)}>
              Re-pair
            </Button>
            {device.build_state === 'behind' && (
              <Button size="sm" variant="secondary" loading={updating} onClick={doUpdate}>
                Update
              </Button>
            )}
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
      {note && <p className="mt-2 text-caption text-content-secondary">{note}</p>}
      {device.starts && <p className="mt-2 text-caption text-content-secondary">Starts {device.starts}</p>}
      {device.last_update && (
        <p className="mt-2 text-caption text-content-secondary">{lastUpdateLine(device.last_update)}</p>
      )}
      {updateSaidText && <p className="mt-2 text-caption text-content-secondary">{updateSaidText}</p>}
    </div>
  )
}

/**
 * "Show revoked (N)" / "Hide revoked" — a real button (not a checkbox, per
 * the ConfirmDialog/Section idiom of state-via-aria-pressed/aria-expanded on
 * a plain <button>) so it is keyboard-reachable without extra label wiring.
 */
function RevokedToggle({
  count,
  shown,
  onToggle,
  className,
}: {
  count: number
  shown: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <Button size="sm" variant="ghost" aria-pressed={shown} onClick={onToggle} className={className}>
      {revokedToggleLabel(count, shown)}
    </Button>
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
