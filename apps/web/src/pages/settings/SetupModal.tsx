import { useEffect, useState } from 'react'
import { Modal, Skeleton } from '../../components/ui'
import { SetupPanel } from '../../components/SetupPanel'
import {
  getNetworkAddress as apiGetNetworkAddress,
  mintPairingCode as apiMintPairingCode,
  type NetworkAddress,
  type PairingCode,
} from '../../lib/api'
import { isMachineSetup, SETUP_TITLES, type SetupKind } from '../../lib/setupSteps'

/**
 * One setup, opened from Settings (S47). It reads the derived address every time
 * it opens and mints a code only for a machine setup — the same two calls, in
 * the same order, whichever button opened it ("Pair a device" or a tile).
 */
export interface SetupModalApi {
  getNetworkAddress: typeof apiGetNetworkAddress
  mintPairingCode: typeof apiMintPairingCode
}

export const DEFAULT_SETUP_API: SetupModalApi = {
  getNetworkAddress: apiGetNetworkAddress,
  mintPairingCode: apiMintPairingCode,
}

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; reason: string }
  | { status: 'ready'; address: NetworkAddress; code: PairingCode | null }

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function SetupModal({
  setup,
  onClose,
  api = DEFAULT_SETUP_API,
}: {
  setup: SetupKind | null
  onClose: () => void
  api?: SetupModalApi
}) {
  const [state, setState] = useState<Loaded>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (setup === null) return
    let live = true
    setState({ status: 'loading' })
    Promise.all([api.getNetworkAddress(), isMachineSetup(setup) ? api.mintPairingCode() : Promise.resolve(null)])
      .then(([address, code]) => {
        if (live) setState({ status: 'ready', address, code })
      })
      .catch(err => {
        if (live) setState({ status: 'error', reason: reasonOf(err) })
      })
    return () => {
      live = false
    }
  }, [setup, api, attempt])

  const title = setup ? SETUP_TITLES[setup] : ''
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
          />
        )}
      </div>
    </Modal>
  )
}
