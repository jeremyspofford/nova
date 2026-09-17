import { useState } from 'react'
import { Link, useInRouterContext } from 'react-router-dom'
import { Radar } from 'lucide-react'
import { Input, Section, Toggle } from '../../components/ui'
import { putSetting as apiPutSetting, type SettingWritten } from '../../lib/api'
import { InlineSave, type SaveMessage } from './shared'

/**
 * Settings → Proactive (S11): the three settings the proactive engine is
 * turned on and shaped by — `proactive.enabled`, `proactive.digest_at` and
 * `proactive.max_notices_per_day`. Until this section existed the slice had
 * landed in core with no way to switch it on from the app.
 *
 * Two rules run through the whole section:
 *
 * 1. Core is the only validator. Nothing here re-implements
 *    `_digest_at_problem` or `_max_notices_problem`: the field sends what was
 *    typed and a refusal is shown in core's own words, verbatim. A second,
 *    friendlier parser written in the browser is how a value gets accepted
 *    here and refused there — the exact trap settings_store.py names.
 * 2. A write is shown as done only when the answer says what was STORED.
 *    Every field re-renders from `written.value` — never from the value the
 *    operator typed — and a response that carries no stored value is a
 *    failure with a reason, not a success (an optimistic echo is how a
 *    refused write ends up looking like it took).
 *
 * `note` is core's sentence about what the write DID: writing the digest hour
 * re-times the digest beat inside the same request, and the note says where
 * it landed, that it is paused, or why it could not be moved. It is shown
 * because it is the only account of that move — and it is rendered as words,
 * never parsed.
 *
 * `api` is the dependency-injection seam the other sections use: production
 * binds the real lib/api call, tests inject a fake.
 */
export interface ProactiveApi {
  putSetting: typeof apiPutSetting
}

const DEFAULT_API: ProactiveApi = { putSetting: apiPutSetting }

export const ENABLED_KEY = 'proactive.enabled'
export const DIGEST_AT_KEY = 'proactive.digest_at'
export const MAX_NOTICES_KEY = 'proactive.max_notices_per_day'

/** What turning it on actually means, in the decisions that were made — not
 * a summary of them. Every clause here is a thing she will do without being
 * asked again, so it is stated before the switch is flipped, not after. */
const MEANING =
  'On: she checks the stack every hour by herself, and nobody has to ask. She may act on ' +
  'anything her tools already allow and tells you afterwards — she does not ask first. What ' +
  'she finds waits for one digest a day, at the time below; nothing pings you as it happens. ' +
  'The one exception is the stack being down — that reaches you at any hour. Off: a beat still ' +
  'fires on its schedule but runs no check, records nothing and delivers nothing, and says so.'

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The stored value out of a settings write, or a refusal that says why it
 * cannot be shown as stored. There is deliberately no fallback to the value
 * that was sent: a write that cannot state what it stored has not been
 * verified, and rendering the typed value would report a success nobody
 * checked.
 */
function storedFrom(written: SettingWritten, key: string): { value: unknown; note?: string } {
  if (written === null || typeof written !== 'object' || !('value' in written)) {
    throw new Error(
      `the write of ${key} returned no stored value, so what is stored is unknown — reload the page`,
    )
  }
  if (written.key !== key) {
    throw new Error(`the write of ${key} answered about ${String(written.key)} instead`)
  }
  return { value: written.value, note: written.note }
}

/** A link that still renders as a link when the section is mounted outside a
 * router (the RoutingSection idiom). */
function PageLink({ to, children }: { to: string; children: React.ReactNode }) {
  const className = 'text-accent hover:underline'
  return useInRouterContext() ? (
    <Link to={to} className={className}>
      {children}
    </Link>
  ) : (
    <a href={to} className={className}>
      {children}
    </a>
  )
}

export function ProactiveSection({
  enabled,
  digestAt,
  maxNoticesPerDay,
  onChanged,
  api = DEFAULT_API,
}: {
  /** proactive.enabled as the server holds it. */
  enabled: boolean
  /** proactive.digest_at as the server holds it, "HH:MM". */
  digestAt: string
  /** proactive.max_notices_per_day as the server holds it. */
  maxNoticesPerDay: number
  /** Hands the parent the value CORE stored, so the page re-renders from it. */
  onChanged: (key: string, value: unknown) => void
  api?: ProactiveApi
}) {
  // Drafts are seeded once: SettingsPage renders its sections only after the
  // one settings fetch resolved, so these props are already the server's
  // values at mount, and a re-seeding effect would fight the operator's
  // typing on every parent render.
  const [digestDraft, setDigestDraft] = useState(digestAt)
  const [maxDraft, setMaxDraft] = useState(String(maxNoticesPerDay))
  const [saving, setSaving] = useState<string | null>(null)
  // Keyed by setting: core's refusal for that field, and core's note about
  // what its write did. Both are core's words, held per key rather than in
  // one banner so a refused hour cannot look like a refused cap.
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const [notes, setNotes] = useState<Record<string, string | null>>({})
  const [messages, setMessages] = useState<Record<string, SaveMessage | null>>({})

  const set = (
    setter: React.Dispatch<React.SetStateAction<Record<string, string | null>>>,
    key: string,
    value: string | null,
  ) => setter(prev => ({ ...prev, [key]: value }))

  /** One write: PUT, then read back what core says it stored. Returns the
   * stored value, or `null` when the write was refused (the reason is on
   * screen by then, in core's words). */
  const write = async (
    key: string,
    value: boolean | string | number,
  ): Promise<{ stored: unknown } | null> => {
    setSaving(key)
    set(setErrors, key, null)
    set(setNotes, key, null)
    setMessages(prev => ({ ...prev, [key]: null }))
    try {
      const written = await api.putSetting(key, value)
      const { value: stored, note } = storedFrom(written, key)
      set(setNotes, key, note ?? null)
      onChanged(key, stored)
      return { stored }
    } catch (err) {
      set(setErrors, key, reasonOf(err))
      return null
    } finally {
      setSaving(null)
    }
  }

  // The switch follows what core stored, never the click: it moves when the
  // parent re-renders this section with the new `enabled`, so a refused write
  // leaves it exactly where it was.
  const toggle = async (next: boolean) => {
    await write(ENABLED_KEY, next)
  }

  const digestDirty = digestDraft !== digestAt
  const saveDigest = async () => {
    const result = await write(DIGEST_AT_KEY, digestDraft)
    // Refused: the field keeps what was typed so it can be corrected, and
    // core's reason is under it. Accepted: the field shows the STORED hour.
    if (result === null) return
    setDigestDraft(String(result.stored))
    setMessages(prev => ({
      ...prev,
      [DIGEST_AT_KEY]: { kind: 'ok', text: `Saved — stored as ${String(result.stored)}` },
    }))
  }

  const maxDirty = maxDraft !== String(maxNoticesPerDay)
  const saveMax = async () => {
    // Sent as typed. A number goes as a number (so core can say "expects int,
    // got float"), anything else goes as the text (so core can say "expects
    // int, got str"). Nothing is refused here — core is the one validator,
    // and its sentence is the one the operator should read.
    const typed = maxDraft.trim()
    const asNumber = Number(typed)
    const payload = typed !== '' && Number.isFinite(asNumber) ? asNumber : typed
    const result = await write(MAX_NOTICES_KEY, payload)
    if (result === null) return
    setMaxDraft(String(result.stored))
    setMessages(prev => ({
      ...prev,
      [MAX_NOTICES_KEY]: { kind: 'ok', text: `Saved — stored as ${String(result.stored)}` },
    }))
  }

  const fieldNote = (key: string, testid: string) =>
    notes[key] ? (
      <p data-testid={testid} className="text-caption text-content-secondary">
        {notes[key]}
      </p>
    ) : null

  const fieldError = (key: string, testid: string, lead: string) =>
    errors[key] ? (
      <div
        role="alert"
        data-testid={testid}
        className="rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
      >
        {lead} {errors[key]}
      </div>
    ) : null

  return (
    <Section
      icon={Radar}
      title="Proactive"
      description="Whether Nova looks for herself, and when she says what she found."
    >
      <div className="space-y-2">
        <Toggle
          label="Let Nova check on her own"
          checked={enabled}
          disabled={saving === ENABLED_KEY}
          onChange={toggle}
        />
        <p data-testid="proactive-meaning" className="text-caption text-content-secondary">
          {MEANING}
        </p>
        {fieldNote(ENABLED_KEY, 'proactive-enabled-note')}
        {fieldError(ENABLED_KEY, 'proactive-enabled-error', 'Could not save that switch:')}
      </div>

      {!enabled && (
        <div
          data-testid="proactive-off"
          className="rounded-sm border border-warning/30 bg-warning-dim px-3 py-2 text-caption text-content-primary"
        >
          The engine is off — she checks nothing and delivers nothing. The two settings below are
          still stored while it is off: set them the way you want them, then switch it on.
        </div>
      )}

      <div className="space-y-2">
        <Input
          label="Daily digest at"
          type="time"
          value={digestDraft}
          disabled={saving === DIGEST_AT_KEY}
          error={errors[DIGEST_AT_KEY] ? 'Not saved — the stored hour stands.' : undefined}
          description="Local time (HH:MM, 24-hour) on the clock set in General. Saving it re-times the digest beat right away."
          onChange={e => {
            setDigestDraft(e.target.value)
            set(setErrors, DIGEST_AT_KEY, null)
            set(setNotes, DIGEST_AT_KEY, null)
            setMessages(prev => ({ ...prev, [DIGEST_AT_KEY]: null }))
          }}
        />
        {fieldNote(DIGEST_AT_KEY, 'proactive-digest-note')}
        {fieldError(DIGEST_AT_KEY, 'proactive-digest-error', 'Could not save the digest time:')}
        <InlineSave
          dirty={digestDirty}
          saving={saving === DIGEST_AT_KEY}
          onSave={saveDigest}
          onReset={() => {
            setDigestDraft(digestAt)
            set(setErrors, DIGEST_AT_KEY, null)
            set(setNotes, DIGEST_AT_KEY, null)
            setMessages(prev => ({ ...prev, [DIGEST_AT_KEY]: null }))
          }}
          message={messages[DIGEST_AT_KEY]}
        />
      </div>

      <div className="space-y-2">
        <Input
          label="Most findings in one digest"
          type="number"
          value={maxDraft}
          disabled={saving === MAX_NOTICES_KEY}
          error={errors[MAX_NOTICES_KEY] ? 'Not saved — the stored number stands.' : undefined}
          description="A backstop under the one-message-a-day rule, so a bad hour reads as a message and not a log."
          onChange={e => {
            setMaxDraft(e.target.value)
            set(setErrors, MAX_NOTICES_KEY, null)
            set(setNotes, MAX_NOTICES_KEY, null)
            setMessages(prev => ({ ...prev, [MAX_NOTICES_KEY]: null }))
          }}
        />
        <p data-testid="proactive-overflow" className="text-caption text-content-secondary">
          What does not fit is not dropped: it is still owed, and it is in the next day&rsquo;s
          digest.
        </p>
        {fieldNote(MAX_NOTICES_KEY, 'proactive-max-note')}
        {fieldError(MAX_NOTICES_KEY, 'proactive-max-error', 'Could not save that number:')}
        <InlineSave
          dirty={maxDirty}
          saving={saving === MAX_NOTICES_KEY}
          onSave={saveMax}
          onReset={() => {
            setMaxDraft(String(maxNoticesPerDay))
            set(setErrors, MAX_NOTICES_KEY, null)
            set(setNotes, MAX_NOTICES_KEY, null)
            setMessages(prev => ({ ...prev, [MAX_NOTICES_KEY]: null }))
          }}
          message={messages[MAX_NOTICES_KEY]}
        />
      </div>

      <div className="space-y-1 text-caption text-content-secondary">
        <p data-testid="proactive-inbox-link">
          <PageLink to="/inbox">Inbox</PageLink> — what she has noticed.
        </p>
        <p data-testid="proactive-schedules-link">
          <PageLink to="/schedules">Schedules</PageLink> — the watch and digest beats live here:
          pause or retime them.
        </p>
      </div>
    </Section>
  )
}
