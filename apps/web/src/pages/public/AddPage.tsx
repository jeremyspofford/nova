import { useEffect, useState } from 'react'
import { Share2 } from 'lucide-react'
import { Button, Input } from '../../components/ui'
import { AgentCommands } from '../../components/SetupPanel'
import { currentPlatform, type DevicePlatform } from '../../lib/devicePlatform'
import { getAgentManifest as apiGetAgentManifest, reasonOf, type AgentManifest } from '../../lib/api'
import { AGENT_STEPS, fillCommands, parseCodeFragment } from '../../lib/setupSteps'
import { PublicShell } from './PublicShell'

type Share = (data: { title: string; url: string }) => Promise<void>

function browserShare(): Share | undefined {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return undefined
  return navigator.share.bind(navigator)
}

type ManifestState =
  | { status: 'loading' }
  | { status: 'ready'; manifest: AgentManifest }
  | { status: 'error'; reason: string }

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

  // S42b K3/K5: the one shared fill helper, not a local copy of it.
  const filled = manifestState.status === 'ready' ? fillCommands(manifestState.manifest.commands, code) : { commands: null, reason: null }
  // S42b K2: core's own commands_reason (no address to download from) is
  // never dropped once the manifest answers — only overridden by a fill
  // problem of this page's own (the code itself was not canonical).
  const reason =
    manifestState.status === 'error'
      ? manifestState.reason
      : manifestState.status === 'ready'
        ? filled.reason ?? manifestState.manifest.commands_reason
        : null

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
          {manifestState.status === 'loading' ? (
            // S42b K1: a quiet line, never the "No command" alert — nothing
            // has failed, Nova just hasn't answered yet, and a screen reader
            // must not announce a failure that is not one.
            <p className="text-caption text-content-tertiary">Asking Nova for the command…</p>
          ) : (
            <AgentCommands
              commands={filled.commands}
              reason={reason}
              walks={manifestState.status === 'ready' ? manifestState.manifest.walks : null}
              notes={manifestState.status === 'ready' ? manifestState.manifest.notes : null}
              platform={platform}
            />
          )}
        </>
      )}
    </PublicShell>
  )
}
