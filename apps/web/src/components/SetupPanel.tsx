import { useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import clsx from 'clsx'
import { Button, Tabs } from './ui'
import { QrCode } from './QrCode'
import { NATIVE_APP_LINKS } from '../lib/nativeApp'
import { currentPlatform, type DevicePlatform } from '../lib/devicePlatform'
import {
  AGENT_STEPS,
  MODEL_SERVER_NOTE,
  NOVAD_README,
  OS_KEYS,
  OS_LABELS,
  TAILSCALE_DOWNLOAD,
  TAILSCALE_STEP,
  defaultOs,
  formatCode,
  isMachineSetup,
  setupLink,
  type OsKey,
  type SetupKind,
} from '../lib/setupSteps'

/**
 * One setup's QR code and steps (S47) — the same panel in Settings and in her
 * chat card. The QR code only ever encodes `address`, the derived address core
 * states; `fallbackOrigin` (this browser's own origin) may appear in a COMMAND
 * for a machine that reaches the same page, never in a QR code.
 */
export interface SetupPanelProps {
  setup: SetupKind
  address: string | null
  reason?: string | null
  /** A machine setup's live code. Absent on a reloaded card: a code is shown once. */
  code?: string | null
  expiresAt?: string | null
  /** This browser's own origin. Since S42b it affects wording only (the
   *  QR-less case, below) — the one-liners themselves always come from
   *  `commands`, never derived from an origin in the browser. */
  fallbackOrigin?: string | null
  compact?: boolean
  onNewCode?: () => void
  clock?: () => Date
  /** S42b: the one command per OS (Task 19/28), each already filled with the
   *  live code — null (with its reason) when core could not make one. */
  commands?: Record<OsKey, string> | null
  commandsReason?: string | null
  walks?: Partial<Record<OsKey, string>> | null
  notes?: Partial<Record<OsKey, string>> | null
  /** Which OS this card is FOR (a WSL machine's card is 'windows') — decides
   *  the tab it opens on, before this browser's own OS is even considered. */
  forOs?: string | null
  /** The paired machine's name. Accepted for callers (the chat card passes
   *  it) but not read here — only forOs decides the open tab — and kept out
   *  of the destructured props below to avoid shadowing the `machine`
   *  boolean (isMachineSetup(setup)) the render logic already uses. */
  machine?: string | null
}

const systemClock = () => new Date()

function useNow(enabled: boolean, clock: () => Date): Date {
  const [now, setNow] = useState(() => clock())
  useEffect(() => {
    setNow(clock())
    if (!enabled) return
    const id = window.setInterval(() => setNow(clock()), 1000)
    return () => window.clearInterval(id)
  }, [enabled, clock])
  return now
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function remaining(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A command with a Copy button that says whether the copy happened. No button
 *  where the browser has no clipboard (an http page): a button that cannot work
 *  is not shown. `/add` uses it too (Task 9). */
export function CopyLine({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-sm bg-surface-elevated px-3 py-2 font-mono text-mono-sm text-content-primary">
        {value}
      </code>
      {clipboard && (
        <Button
          size="sm"
          variant="secondary"
          icon={<Copy size={12} />}
          aria-label={`Copy ${label}`}
          onClick={() => clipboard.writeText(value).then(() => setState('copied'), () => setState('failed'))}
        >
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
        </Button>
      )}
    </div>
  )
}

export function SetupPanel({
  setup,
  address,
  reason,
  code,
  expiresAt,
  fallbackOrigin,
  compact = false,
  onNewCode,
  clock = systemClock,
  commands,
  commandsReason,
  walks,
  notes,
  forOs,
}: SetupPanelProps) {
  const machine = isMachineSetup(setup)
  const live = machine && Boolean(code)
  const now = useNow(live && Boolean(expiresAt), clock)
  const expired = Boolean(expiresAt) && new Date(expiresAt as string).getTime() <= now.getTime()
  const link = address ? setupLink(setup, address, live ? code : null) : null
  const phoneSetup = setup === 'install_pwa' || setup === 'get_app'
  const hasApp = Boolean(NATIVE_APP_LINKS.ios || NATIVE_APP_LINKS.android)
  return (
    <div
      data-testid="setup-panel"
      data-setup={setup}
      className={clsx('space-y-3 text-content-secondary', compact ? 'text-caption' : 'text-compact')}
    >
      {phoneSetup && (
        <p>
          {TAILSCALE_STEP}{' '}
          <a className="text-accent underline" href={TAILSCALE_DOWNLOAD} target="_blank" rel="noreferrer">
            Get Tailscale
          </a>
        </p>
      )}
      {address === null && (
        <p role="alert" className="rounded-sm border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-warning">
          No QR code: {reason ?? 'Nova has no address another device can reach.'}
          {fallbackOrigin && machine && ` This page is open directly at ${fallbackOrigin}.`}
        </p>
      )}
      {machine && !live && (
        <p data-testid="setup-shown-once">
          {expiresAt
            ? `The code was shown once and ${expired ? 'expired' : 'expires'} at ${clockTime(expiresAt)}. Ask Nova for a new one.`
            : 'The code was shown once. Ask Nova for a new one.'}
        </p>
      )}
      {link && (!machine || (live && !expired)) && <QrCode link={link} size={compact ? 160 : 208} />}
      {setup === 'install_pwa' && link && (
        <p>Scan this with the phone, or open the link on it. The page shows that phone’s own steps.</p>
      )}
      {setup === 'get_app' && link && (
        <p>
          {hasApp
            ? 'Scan this with a phone: it opens that phone’s app store.'
            : 'There’s no Nova app yet. Scanning this with a phone opens the web app’s install steps instead.'}
        </p>
      )}
      {live && code && (
        <div className="space-y-2">
          <div className="text-center">
            <div
              data-testid="setup-code"
              className={clsx('font-mono tracking-[0.2em] text-content-primary', compact ? 'text-h2' : 'text-h1')}
            >
              {formatCode(code)}
            </div>
            {/* Spec §10: a lapsed code has a way forward. Settings passes
                onNewCode (the New code button below); her chat card cannot
                mint one, so it says where the next code comes from. */}
            {expiresAt && (
              <p className="mt-1 text-caption text-content-tertiary">
                {expired
                  ? `Expired at ${clockTime(expiresAt)}.${onNewCode ? '' : ' Ask Nova for a new card.'}`
                  : `Works once. Expires at ${clockTime(expiresAt)} (${remaining(new Date(expiresAt).getTime() - now.getTime())} left).`}
              </p>
            )}
            {expired && onNewCode && (
              <Button size="sm" variant="secondary" onClick={onNewCode} className="mt-2">
                New code
              </Button>
            )}
          </div>
          {!expired && <AgentCommands commands={commands} reason={commandsReason} walks={walks} notes={notes} forOs={forOs} />}
          <p className="text-caption">
            What it installs:{' '}
            <a className="text-accent underline" href={NOVAD_README} target="_blank" rel="noreferrer">
              novad’s README
            </a>
          </p>
        </div>
      )}
      {setup === 'add_model_server' && <p>{MODEL_SERVER_NOTE}</p>}
    </div>
  )
}

/** One command per OS (S42b P18), each with where it was walked and its one
 *  note. Exported so `/add` (which has no QR, no code-reload story — just a
 *  code and a target OS) draws the exact same thing. */
export function AgentCommands({
  commands,
  reason,
  walks,
  notes,
  forOs,
  platform = currentPlatform(),
}: {
  commands?: Record<OsKey, string> | null
  reason?: string | null
  walks?: Partial<Record<OsKey, string>> | null
  notes?: Partial<Record<OsKey, string>> | null
  forOs?: string | null
  platform?: DevicePlatform
}) {
  const [active, setActive] = useState<OsKey>(() => defaultOs(platform, forOs))
  if (!commands) {
    return (
      <p role="alert" className="rounded-sm border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-warning">
        {AGENT_STEPS.noCommand} {reason ?? 'Nova could not make one just now.'}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-caption font-medium">{AGENT_STEPS.command}</p>
      <Tabs tabs={OS_KEYS.map(key => ({ id: key, label: OS_LABELS[key] }))} activeTab={active} onChange={id => setActive(id as OsKey)} />
      <CopyLine value={commands[active]} label={`the ${OS_LABELS[active]} command`} />
      {walks?.[active] && <p className="text-caption text-content-tertiary">{walks[active]}</p>}
      {notes?.[active] && <p className="text-caption">{notes[active]}</p>}
      {active === 'windows' && <p className="text-caption">{AGENT_STEPS.wsl}</p>}
    </div>
  )
}
