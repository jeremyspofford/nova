import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Plus, Trash2, Webhook } from 'lucide-react'
import { Badge, Button, Input, Section, Skeleton, Toggle, Banner } from '../../components/ui'
import {
  addEventSender as apiAddEventSender,
  deleteEventSender as apiDeleteEventSender,
  listEventSenders as apiListEventSenders,
  putSetting as apiPutSetting,
  reasonOf,
  revealEventSenderToken as apiRevealEventSenderToken,
  setEventSenderEnabled as apiSetEventSenderEnabled,
  type EventSender,
  type EventSenderDeleted,
  type SettingDef,
} from '../../lib/api'
import { InlineSave, storedFrom, type SaveMessage } from './shared'
import { addedByWords, isBuiltIn, senderAbout, senderTitle, sentWords } from './eventsFormat'

/**
 * Settings → Events (S37c, spec §2.1): the programs that can start her look.
 *
 * A sender of his calls Nova with its own key; the two built-ins are her own
 * monitoring and GitHub CI read every 5 minutes. A key is shown ONCE — core
 * keeps only its hash, so once this page lets go of it, nothing can show it
 * again. A key Nova made for him waits, unseen by her, until he asks for it
 * here. Nothing on this page is an approval: switching a sender off or
 * deleting it is his configuration, stated back as core stored it.
 *
 * It reads plainly (owner, 2026-10-13): names, "last sent 5 minutes ago",
 * on or off — never a role key, a kind, an id, JSON or a raw timestamp.
 */

export const CI_REPOS_KEY = 'events.github_ci.repos'

export type EventsApi = {
  listEventSenders: typeof apiListEventSenders
  addEventSender: typeof apiAddEventSender
  revealEventSenderToken: typeof apiRevealEventSenderToken
  setEventSenderEnabled: typeof apiSetEventSenderEnabled
  deleteEventSender: typeof apiDeleteEventSender
  putSetting: typeof apiPutSetting
}

const DEFAULT_API: EventsApi = {
  listEventSenders: apiListEventSenders,
  addEventSender: apiAddEventSender,
  revealEventSenderToken: apiRevealEventSenderToken,
  setEventSenderEnabled: apiSetEventSenderEnabled,
  deleteEventSender: apiDeleteEventSender,
  putSetting: apiPutSetting,
}

/** The key on screen: which sender it opens, and the only copy of it. */
type ShownKey = { name: string; token: string }

/** What a delete did, in a sentence: how many waiting events will not be
 *  read, and a routing removal that failed. */
export function deletedWords(result: EventSenderDeleted, title: string): string {
  const parts = [`Deleted ${title}.`]
  const n = result.failed_events
  if (n > 0) parts.push(`${n} ${n === 1 ? 'event that was' : 'events that were'} still waiting will not be read.`)
  if (!result.route.registered) parts.push(`Its model order on Routing was not removed — ${result.route.detail}.`)
  return parts.join(' ')
}

export function EventsSection({
  api = DEFAULT_API,
  ciRepos,
  onSettingChanged = () => {},
  now = () => new Date(),
}: {
  api?: EventsApi
  /** events.github_ci.repos as core listed it; null draws no field (a core
   *  that does not list it would refuse the write by name). */
  ciRepos: SettingDef | null
  /** Hands the parent the value CORE stored, so the field shows storage. */
  onSettingChanged?: (key: string, value: unknown) => void
  now?: () => Date
}) {
  const [senders, setSenders] = useState<EventSender[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [shownKey, setShownKey] = useState<ShownKey | null>(null)

  const load = useCallback(async () => {
    try {
      setSenders(await api.listEventSenders())
      setLoadError(null)
    } catch (err) {
      setLoadError(reasonOf(err))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (work: () => Promise<void>) => {
    setActionError(null)
    setOutcome(null)
    try {
      await work()
    } catch (err) {
      setActionError(reasonOf(err))
    }
  }

  const switchSender = (sender: EventSender, on: boolean) =>
    act(async () => {
      const stored = await api.setEventSenderEnabled(sender.name, on)
      // The row shows what core stored, not the click.
      setSenders(prev => (prev ? prev.map(s => (s.name === stored.name ? stored : s)) : prev))
    })

  const deleteSender = (sender: EventSender) =>
    act(async () => {
      const result = await api.deleteEventSender(sender.name)
      if (shownKey?.name === sender.name) setShownKey(null)
      setOutcome(deletedWords(result, senderTitle(sender)))
      await load()
    })

  const revealKey = (sender: EventSender) =>
    act(async () => {
      const revealed = await api.revealEventSenderToken(sender.name)
      setShownKey({ name: revealed.name, token: revealed.token })
      await load()
    })

  return (
    <Section
      id="events"
      icon={Webhook}
      title="Events"
      description="Programs that can start her look. Each one calls Nova with its own key; she reads what it sends as data, works out what happened, and your Inbox says what she found."
    >
      <div className="space-y-3" data-testid="events-section">
        {loadError && <Banner>Could not read the senders: {loadError}</Banner>}
        {actionError && <Banner>{actionError}</Banner>}
        {outcome && (
          <Banner tone="info" data-testid="events-outcome">
            {outcome}
          </Banner>
        )}
        {shownKey && <KeyPanel shown={shownKey} onDone={() => setShownKey(null)} />}
        {senders === null && !loadError ? (
          <Skeleton lines={3} />
        ) : (
          <div className="space-y-3" data-testid="events-list">
            {(senders ?? []).map(sender => (
              <SenderRow
                key={sender.name}
                sender={sender}
                now={now()}
                onSwitch={on => switchSender(sender, on)}
                onDelete={() => deleteSender(sender)}
                onReveal={() => revealKey(sender)}
              />
            ))}
          </div>
        )}
        {ciRepos && (
          <CiRepos def={ciRepos} api={api} onSettingChanged={onSettingChanged} />
        )}
        {senders === null && !loadError ? null : !adding ? (
          <Button variant="secondary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
            Add a sender
          </Button>
        ) : (
          <AddSenderForm
            api={api}
            onAdded={async added => {
              setAdding(false)
              setOutcome(null)
              setShownKey(added)
              await load()
            }}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
    </Section>
  )
}

function SenderRow({
  sender,
  now,
  onSwitch,
  onDelete,
  onReveal,
}: {
  sender: EventSender
  now: Date
  onSwitch: (on: boolean) => Promise<void>
  onDelete: () => Promise<void>
  onReveal: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const title = senderTitle(sender)
  const builtIn = isBuiltIn(sender)
  const added = addedByWords(sender.added_by)
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-md border border-border p-3" data-testid={`event-sender-${sender.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-content-primary">{title}</span>
        {builtIn && (
          <Badge size="sm" color="neutral">
            built in
          </Badge>
        )}
        <span className="ml-auto">
          <Toggle
            id={`event-sender-${sender.name}-switch`}
            checked={sender.enabled}
            disabled={busy}
            label={sender.enabled ? 'On' : 'Off'}
            onChange={on => void run(() => onSwitch(on))}
          />
        </span>
      </div>
      <p className="mt-1 text-caption text-content-secondary">{senderAbout(sender)}</p>
      <p className="mt-1 text-caption text-content-tertiary">
        {sentWords(sender.last_sent_at, now)}
        {added ? ` · ${added}` : ''}
        {sender.enabled ? '' : builtIn ? ' · off: it sends nothing' : ' · off: calls from it are refused'}
      </p>
      {(sender.token_waiting || !builtIn) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {sender.token_waiting && (
            <Button
              variant="secondary"
              size="sm"
              icon={<KeyRound size={12} />}
              loading={busy}
              onClick={() => void run(onReveal)}
            >
              Show its key
            </Button>
          )}
          {!builtIn && !confirming && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 size={12} />}
              onClick={() => setConfirming(true)}
              aria-label={`Delete ${sender.name}`}
            >
              Delete
            </Button>
          )}
        </div>
      )}
      {sender.token_waiting && (
        <p className="mt-1 text-caption text-content-tertiary">
          Nova made a key for it. Only you can see it, once.
        </p>
      )}
      {confirming && (
        // In the row, not a modal: on a phone a dialog over the list hides
        // which sender is about to go (pages, not modals).
        <div className="mt-2 space-y-2 rounded-sm border border-danger/30 p-2" data-testid={`event-sender-${sender.name}-confirm`}>
          <p className="text-caption text-content-primary">
            Delete {title}? Calls with its key will be refused from now on, and anything it sent that she has
            not read yet will not be read. What she already did stays on the record.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              onClick={() => {
                setConfirming(false)
                void run(onDelete)
              }}
            >
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** The key, once: a copy button, a plain warning, and how a program sends
 *  with it. Gone from the page when he says he has it. */
function KeyPanel({ shown, onDone }: { shown: ShownKey; onDone: () => void }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const address = `${window.location.origin}/api/v1/events/${shown.name}`
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(shown.token)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }
  return (
    // The shared warning box: the key is the one thing on this page he must act on now.
    <Banner tone="warning" className="space-y-2" data-testid="event-key">
      <p className="text-compact font-medium text-content-primary">The key for {shown.name}</p>
      <p className="text-caption text-content-primary">
        Copy it now: it will not be shown again. Nova keeps only a fingerprint of it, so if it is lost, delete
        the sender and add it again.
      </p>
      <code className="block break-all rounded-xs bg-surface-selected px-2 py-1 font-mono text-mono-sm text-content-primary">
        {shown.token}
      </code>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => void doCopy()}>
          Copy the key
        </Button>
        {copy === 'copied' && <span className="text-caption text-success">Copied</span>}
        {copy === 'failed' && (
          <span className="text-caption text-danger">Could not copy — select it and copy it by hand.</span>
        )}
      </div>
      <p className="text-caption text-content-secondary">How the program sends something:</p>
      <code className="block break-all rounded-xs bg-surface-selected px-2 py-1 font-mono text-mono-sm text-content-secondary">
        curl -X POST -H "Authorization: Bearer {shown.token}" --data "what happened" {address}
      </code>
      <Button size="sm" onClick={onDone}>
        Done, I saved it
      </Button>
    </Banner>
  )
}

function AddSenderForm({
  api,
  onAdded,
  onCancel,
}: {
  api: EventsApi
  onAdded: (key: ShownKey) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const added = await api.addEventSender(name.trim())
      await onAdded({ name: added.name, token: added.token })
    } catch (err) {
      setError(reasonOf(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={event => void submit(event)} className="space-y-3 rounded-md border border-border p-3" data-testid="event-sender-form">
      <Input
        label="Name"
        value={name}
        onChange={event => setName(event.target.value)}
        placeholder="backups"
        description="Lowercase letters and underscores, starting with a letter. It is part of the address the program calls."
        required
      />
      {error && <Banner>{error}</Banner>}
      <div className="flex gap-2">
        <Button type="submit" loading={saving}>
          Add
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** The repos GitHub CI reads: core's setting, shown as core stored it. */
function CiRepos({
  def,
  api,
  onSettingChanged,
}: {
  def: SettingDef
  api: EventsApi
  onSettingChanged: (key: string, value: unknown) => void
}) {
  const stored = typeof def.value === 'string' ? def.value : String(def.default ?? '')
  const [draft, setDraft] = useState(stored)
  const [draftOf, setDraftOf] = useState(stored)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<SaveMessage | null>(null)
  // The draft follows what core stored whenever that changes (reset during
  // render against the value it was taken from, as Routing's chains do).
  if (draftOf !== stored) {
    setDraftOf(stored)
    setDraft(stored)
  }

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const { value } = storedFrom(await api.putSetting(CI_REPOS_KEY, draft), CI_REPOS_KEY, 'string')
      onSettingChanged(CI_REPOS_KEY, value)
      setMessage({ kind: 'ok', text: 'Saved' })
    } catch (err) {
      setMessage({ kind: 'err', text: reasonOf(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="events-ci-repos">
      <Input
        label="Repos GitHub CI watches"
        value={draft}
        onChange={event => {
          setDraft(event.target.value)
          setMessage(null)
        }}
        placeholder="owner/repo, owner/other"
        description="owner/repo names, separated by commas or spaces. It reads them with the GitHub connection's key."
      />
      {stored.trim() === '' && (
        <p className="text-caption text-content-tertiary">No repos are listed, so nothing is read.</p>
      )}
      <InlineSave
        dirty={draft !== stored}
        saving={saving}
        saveLabel="Save repos"
        onSave={() => void save()}
        onReset={() => {
          setDraft(stored)
          setMessage(null)
        }}
        message={message}
      />
    </div>
  )
}
