import { useEffect, useState } from 'react'
import { Share2 } from 'lucide-react'
import { Button, Input } from '../../components/ui'
import { AgentCommands } from '../../components/SetupPanel'
import { currentPlatform, type DevicePlatform } from '../../lib/devicePlatform'
import { getAgentManifest as apiGetAgentManifest, type AgentManifest, type OsKey } from '../../lib/api'
import { AGENT_STEPS, fillCode, OS_KEYS, parseCodeFragment } from '../../lib/setupSteps'
import { PublicShell } from './PublicShell'

type Share = (data: { title: string; url: string }) => Promise<void>

function browserShare(): Share | undefined {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return undefined
  return navigator.share.bind(navigator)
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type ManifestState =
  | { status: 'loading' }
  | { status: 'ready'; manifest: AgentManifest }
  | { status: 'error'; reason: string }

/** Every OS line filled with this one code — null until the manifest is in
 *  and there is something to fill. Filled in the BROWSER (S42b D3): fillCode
 *  itself refuses anything but a canonical code. */
function fillCommands(commands: Record<OsKey, string> | null, code: string | null): Record<OsKey, string> | null {
  if (!commands || !code) return null
  const out = {} as Record<OsKey, string>
  for (const key of OS_KEYS) out[key] = fillCode(commands[key], code)
  return out
}

/**
 * /add (S47, S42b): the page a machine setup's QR code opens. The code rides
 * the URL fragment and is never sent anywhere. It makes ONE request, and
 * only once a code is on the page: the public manifest (the one-liners with
 * a {CODE} slot), which never carries the code — the code is filled in here
 * and never sent anywhere. It picks its steps from the device that opened
 * it — the command on a computer, "open this on the computer" (and Share,
 * where the browser can) on a phone.
 */
export function AddPage({
  platform = currentPlatform(),
  hash = window.location.hash,
  origin = window.location.origin,
  share = browserShare(),
  getManifest = apiGetAgentManifest,
}: {
  platform?: DevicePlatform
  hash?: string
  origin?: string
  share?: Share
  getManifest?: () => Promise<AgentManifest>
}) {
  const [typed, setTyped] = useState('')
  const fromLink = parseCodeFragment(hash)
  const code = fromLink ?? parseCodeFragment(typed)
  const link = code ? `${origin}/add#${code}` : null

  const [manifestState, setManifestState] = useState<ManifestState>({ status: 'loading' })
  useEffect(() => {
    if (code === null) return
    let live = true
    setManifestState({ status: 'loading' })
    getManifest()
      .then(manifest => {
        if (live) setManifestState({ status: 'ready', manifest })
      })
      .catch(err => {
        if (live) setManifestState({ status: 'error', reason: reasonOf(err) })
      })
    return () => {
      live = false
    }
  }, [code, getManifest])

  const filled =
    manifestState.status === 'ready' ? fillCommands(manifestState.manifest.commands, code) : null

  return (
    <PublicShell title="Add a machine to Nova">
      {code === null ? (
        <div className="space-y-2">
          <p>
            {hash && hash !== '#' ? 'That link carries no code Nova can read.' : 'This page adds a machine to Nova.'}{' '}
            Type the code Nova showed you.
          </p>
          <Input
            label="The code Nova showed you"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            placeholder="ABCD-2345"
            autoComplete="off"
            autoCapitalize="characters"
          />
        </div>
      ) : (
        <>
          <p>
            Code{' '}
            <span data-testid="add-code" className="font-mono text-content-primary">
              {code}
            </span>{' '}
            works once, and expires ten minutes after Nova made it.
          </p>
          {platform.phone && (
            <div className="space-y-2">
              <p>{AGENT_STEPS.phone}</p>
              {share && link && (
                <Button
                  variant="secondary"
                  icon={<Share2 size={14} />}
                  onClick={() => {
                    // Cancelling the native share sheet is a normal action,
                    // not a failure: navigator.share() rejects (usually with
                    // an AbortError) when the owner backs out of it, and
                    // nothing here should surface that as an error.
                    share({ title: 'Add a machine to Nova', url: link }).catch(() => {})
                  }}
                >
                  Share this link
                </Button>
              )}
              <p>{AGENT_STEPS.phoneSelf}</p>
            </div>
          )}
          <AgentCommands
            commands={filled}
            reason={manifestState.status === 'error' ? manifestState.reason : null}
            walks={manifestState.status === 'ready' ? manifestState.manifest.walks : null}
            notes={manifestState.status === 'ready' ? manifestState.manifest.notes : null}
            platform={platform}
          />
        </>
      )}
    </PublicShell>
  )
}
