import { useState } from 'react'
import { Share2 } from 'lucide-react'
import { Button, Input } from '../../components/ui'
import { CopyLine } from '../../components/SetupPanel'
import { currentPlatform, type DevicePlatform } from '../../lib/devicePlatform'
import { AGENT_STEPS, NOVAD_README, parseCodeFragment } from '../../lib/setupSteps'
import { enrollCommand } from '../settings/devicesFormat'
import { PublicShell } from './PublicShell'

type Share = (data: { title: string; url: string }) => Promise<void>

function browserShare(): Share | undefined {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return undefined
  return navigator.share.bind(navigator)
}

/**
 * /add (S47): the page a machine setup's QR code opens. The code rides the URL
 * fragment and is never sent anywhere: this page makes no request, so it cannot
 * be used to test whether a guessed code is real. It picks its steps from the
 * device that opened it — the command on a computer, "open this on the
 * computer" (and Share, where the browser can) on a phone.
 */
export function AddPage({
  platform = currentPlatform(),
  hash = window.location.hash,
  origin = window.location.origin,
  share = browserShare(),
}: {
  platform?: DevicePlatform
  hash?: string
  origin?: string
  share?: Share
}) {
  const [typed, setTyped] = useState('')
  const fromLink = parseCodeFragment(hash)
  const code = fromLink ?? parseCodeFragment(typed)
  const link = code ? `${origin}/add#${code}` : null
  const agentUnsupported = platform.os === 'windows' || platform.os === 'mac'
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
                  onClick={() => void share({ title: 'Add a machine to Nova', url: link })}
                >
                  Share this link
                </Button>
              )}
              <p>{AGENT_STEPS.phoneSelf}</p>
            </div>
          )}
          {agentUnsupported && <p>{AGENT_STEPS.unsupported}</p>}
          <ol className="list-decimal space-y-3 pl-5">
            <li>
              {AGENT_STEPS.install.text}{' '}
              <a className="text-accent underline" href={NOVAD_README} target="_blank" rel="noreferrer">
                novad’s README
              </a>
            </li>
            <li className="space-y-1">
              <p>{AGENT_STEPS.enroll}</p>
              <CopyLine value={enrollCommand(origin, code)} label="the command" />
            </li>
            <li>{AGENT_STEPS.run}</li>
          </ol>
        </>
      )}
    </PublicShell>
  )
}
