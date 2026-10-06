import { useEffect, useState } from 'react'
import { Modal, Skeleton } from '../../components/ui'
import { SetupPanel } from '../../components/SetupPanel'
import {
  getAgentManifest as apiGetAgentManifest,
  getNetworkAddress as apiGetNetworkAddress,
  mintPairingCode as apiMintPairingCode,
  mintRepairCode as apiMintRepairCode,
  type NetworkAddress,
  type OsKey,
  type PairingCode,
} from '../../lib/api'
import { fillCode, isMachineSetup, OS_KEYS, SETUP_TITLES, type SetupKind } from '../../lib/setupSteps'

/**
 * One setup, opened from Settings (S47). It reads the derived address every time
 * it opens and mints a code only for a machine setup — the same calls, in the
 * same order, whichever button opened it ("Pair a device" or a tile).
 *
 * S42b: a machine setup ALSO reads the public agent manifest (the one-liners
 * with a {CODE} slot) alongside the address/code calls. A manifest failure
 * becomes the PANEL's "no command" reason, not the whole modal's error state
 * — the QR code and pairing still work even when the hub has no build.
 */
export interface SetupModalApi {
  getNetworkAddress: typeof apiGetNetworkAddress
  mintPairingCode: typeof apiMintPairingCode
  getAgentManifest: typeof apiGetAgentManifest
  mintRepairCode: typeof apiMintRepairCode
}

export const DEFAULT_SETUP_API: SetupModalApi = {
  getNetworkAddress: apiGetNetworkAddress,
  mintPairingCode: apiMintPairingCode,
  getAgentManifest: apiGetAgentManifest,
  mintRepairCode: apiMintRepairCode,
}

/** The manifest half of the loaded state — a structural subset of
 *  AgentManifest that ALSO fits the shape a failed fetch is downgraded to
 *  (walks/notes null rather than thrown), so the panel always has something
 *  to read regardless of which branch produced it. */
interface ManifestState {
  commands: Record<OsKey, string> | null
  commands_reason: string | null
  walks: Record<OsKey, string> | null
  notes: Record<OsKey, string> | null
}

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; reason: string }
  | { status: 'ready'; address: NetworkAddress; code: PairingCode | null; manifest: ManifestState | null }

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Every OS line filled with this one code — null when there is nothing to
 *  fill (no command, or no live code yet). Filled in the BROWSER (S42b D3):
 *  fillCode itself refuses anything but a canonical code. */
function fillCommands(commands: Record<OsKey, string> | null, code: string | undefined): Record<OsKey, string> | null {
  if (!commands || !code) return null
  const out = {} as Record<OsKey, string>
  for (const key of OS_KEYS) out[key] = fillCode(commands[key], code)
  return out
}

export function SetupModal({
  setup,
  onClose,
  api = DEFAULT_SETUP_API,
  repair = null,
}: {
  setup: SetupKind | null
  onClose: () => void
  api?: SetupModalApi
  /** Re-pair ONE machine (S42b decision 4) rather than minting a fresh
   *  pairing: the code is bound to `repair.id` and the title names it. */
  repair?: { id: string; name: string } | null
}) {
  const [state, setState] = useState<Loaded>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (setup === null) return
    let live = true
    setState({ status: 'loading' })
    const manifest = isMachineSetup(setup)
      ? api.getAgentManifest().catch(err => ({
          version: '',
          commands: null,
          commands_reason: reasonOf(err),
          walks: null,
          notes: null,
        }))
      : Promise.resolve(null)
    Promise.all([
      api.getNetworkAddress(),
      isMachineSetup(setup) ? (repair ? api.mintRepairCode(repair.id) : api.mintPairingCode()) : Promise.resolve(null),
      manifest,
    ])
      .then(([address, code, manifest]) => {
        if (live) setState({ status: 'ready', address, code, manifest })
      })
      .catch(err => {
        if (live) setState({ status: 'error', reason: reasonOf(err) })
      })
    return () => {
      live = false
    }
  }, [setup, api, attempt, repair])

  const title = repair ? `Re-pair ${repair.name}` : setup ? SETUP_TITLES[setup] : ''
  return (
    <Modal open={setup !== null} onClose={onClose} size="md" title={title}>
      <div role="dialog" aria-label={title} className="space-y-4">
        {state.status === 'loading' && <Skeleton lines={3} />}
        {state.status === 'error' && (
          <div role="alert" className="rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-caption text-danger">
            Could not prepare this: {state.reason}
          </div>
        )}
        {state.status === 'ready' && setup !== null && (
          <SetupPanel
            setup={setup}
            address={state.address.address}
            reason={state.address.reason}
            code={state.code?.code ?? null}
            expiresAt={state.code?.expires_at ?? null}
            fallbackOrigin={window.location.origin}
            onNewCode={() => setAttempt(n => n + 1)}
            commands={fillCommands(state.manifest?.commands ?? null, state.code?.code)}
            commandsReason={state.manifest?.commands_reason ?? null}
            walks={state.manifest?.walks ?? null}
            notes={state.manifest?.notes ?? null}
          />
        )}
      </div>
    </Modal>
  )
}
