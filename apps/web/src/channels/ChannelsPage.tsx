// Settings → Channels (FR-088, FR-110, FR-100; docs/13 §4, docs/18 J7 step 3): the channels
// agents can be messaged from (Slack, Teams, Telegram, email, webhooks, in-app), with kind,
// audience, agent, status and last message; add one per kind the Hub offers; send a test, connect
// or disconnect at once, open its thread, read its message log, change its settings and
// credentials (write-only), delete it. Also the share decisions waiting on the owner, the people
// agents answer, the private-to-shared policy and the public address external services reach the
// Hub at. Live through channel events. M8: an email channel that signs in with OAuth says when its
// mailbox needs authorizing (Authorize in its row; the provider sends the browser back here), and a
// member sees their own channels and people while the owner's parts say who sets them.
import { useCallback, useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { AgentView, ChannelAdapterViewM7, ChannelBindingViewM7 } from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  RadioGroup,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { errorMessage } from '../api.ts';
import { rich } from '../i18n/rich.tsx';
import { chatPath, navigate } from '../router.ts';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { MemberNote, OwnerSets, useMemberAccess } from '../team/access.tsx';
import { MEMBER_MODE_TEXT } from '../team/format.ts';
import { AddChannelDialog } from './AddChannelDialog.tsx';
import { useChannelsApi } from './api.ts';
import { BindingSettings } from './BindingSettings.tsx';
import { CHANNEL_EVENTS, useChannelEvents, useDebouncedCallback } from './events.ts';
import { BINDING_STATUS, KIND_TEXT, publicBase } from './format.ts';
import { MailOAuthRowAction, mailOAuthRowNote, useChannelOAuthReturn } from './MailOAuth.tsx';
import { MessageLog } from './MessageLog.tsx';
import { Chip } from './parts.tsx';
import { PeopleSection } from './PeopleSection.tsx';
import { ChannelShareAsks } from './ShareAsks.tsx';
import '../workspace.css';
import './channels.css';

export const TRIGGERS_PATH = '/settings/triggers';
export const CHANNELS_PATH = '/settings/channels';

type Policy = 'ask' | 'allow' | 'deny';

/** An example of a public address (a URL, not translated). */
const EXAMPLE_URL = 'https://nova.example.com';

/** Settings → Channels' words (FR-016). Channel names, addresses and Hub errors are data. */
export const CHANNELS_PAGE_TEXT = defineMessages('channels.page', {
  title: 'Channels',
  intro:
    "Message your agents from Slack, Teams, Telegram, email, a webhook or Nova itself. Each channel keeps its own thread; an agent's memory is shared across its channels. Messages from channels are never treated as your instructions.",
  loadFailed: 'Could not load channels.',
  isOnBut: '{name} is on, but: {detail}',
  connected: '{name} connected.',
  disconnected: '{name} disconnected. No messages go in or out.',
  connectFailed: 'Could not connect: {error}',
  disconnectFailed: 'Could not disconnect: {error}',
  deleted: '{name} deleted.',
  deleteFailed: 'Could not delete {name}: {error}',
  noAgent: 'No agent',
  anAgent: 'An agent',
  yourChannels: 'Your channels',
  add: 'Add channel',
  retry: 'Retry',
  loading: 'Loading channels',
  emptyTitle: 'No channels yet',
  emptyDescription:
    'Add Slack, Teams, Telegram, email or a webhook to message an agent from there.',
  list: 'Channels',
  private: 'Private',
  shared: 'Shared',
  lastMessage: 'Last message {when}',
  noMessages: 'No messages yet',
  openThreadOf: 'Open the thread of {name}',
  openThread: 'Open thread',
  connectFirst: 'Connect the channel first.',
  sendTestTo: 'Send a test to {name}',
  sendTest: 'Send test',
  connectName: 'Connect {name}',
  disconnectName: 'Disconnect {name}',
  connect: 'Connect',
  disconnect: 'Disconnect',
  messagesOf: 'Messages of {name}',
  messages: 'Messages',
  settingsOf: 'Settings of {name}',
  settings: 'Settings',
  deleteName: 'Delete {name}',
  delete: 'Delete',
  watchNote:
    'Joining a channel never makes an agent watch it. To start work from what is said there, add a channel watch in {triggers}.',
  triggers: 'Triggers',
  deleteTitle: 'Delete {name}?',
  deleteThis: 'Delete this channel?',
  deleteWhat:
    'Messages from it stop at once and its triggers lose their source. Its thread stays in your chats.',
  cancel: 'Cancel',
  test: {
    text: 'Nova is connected to this conversation.',
    enterMessage: 'Enter a message.',
    sent: 'Test sent to {name}.',
    failed: 'Could not send the test.',
    title: 'Send a test to {name}?',
    emailed: 'It is emailed to {address}.',
    shared: 'Everyone in this conversation will see it.',
    posted: 'It is posted to this conversation.',
    sending: 'Sending…',
    message: 'Message',
  },
  policy: {
    title: 'Private details in shared channels',
    intro:
      'When a reply in a shared channel would use something from your private chats, private channels or private memory.',
    legend: 'When a reply would share a private detail',
    saveFailed: 'Could not save: {error}',
    ask: {
      label: 'Ask me',
      description: 'The reply waits until you decide. No answer means it is not sent.',
    },
    allow: { label: 'Allow', description: 'Send it without asking.' },
    deny: { label: 'Never share', description: 'Hold the reply back; the agent does not post it.' },
  },
  address: {
    title: 'Public address',
    intro:
      'The address Slack, Teams, Telegram (in webhook mode), webhooks and MCP servers use to reach this Hub. Inbound addresses are shown with it. Now: {address}',
    invalid: 'Enter a full address, like {example}.',
    saved: 'Public address saved.',
    cleared: 'Public address cleared.',
    saveFailed: 'Could not save the address.',
    hint: 'Leave empty to use the Hub’s own address.',
    save: 'Save',
    clear: 'Clear',
  },
});

export function ChannelsPage() {
  const S = CHANNELS_PAGE_TEXT;
  const api = useChannelsApi();
  const toast = useToast();
  const settings = useSettings();
  const access = useMemberAccess();
  useChannelOAuthReturn();
  const publicUrl = settings.get('channels.publicUrl').value;
  const [data, setData] = useState<{
    items: ChannelBindingViewM7[];
    adapters: ChannelAdapterViewM7[];
  } | null>(null);
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [logs, setLogs] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<ChannelBindingViewM7 | null>(null);
  const [testing, setTesting] = useState<ChannelBindingViewM7 | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    api.listChannels().then(
      (res) => {
        if (!alive) return;
        setData(res);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, CHANNELS_PAGE_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  useEffect(() => {
    let alive = true;
    api.listChannelAgents().then(
      ({ items }) => alive && setAgents(items),
      () => alive && setAgents(null),
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const debounced = useDebouncedCallback(reload, 150);
  useChannelEvents(
    CHANNEL_EVENTS.filter((n) => n.startsWith('channel.')),
    () => debounced(),
    reload,
  );

  const replace = (b: ChannelBindingViewM7) =>
    setData((d) =>
      d
        ? {
            ...d,
            items: d.items.some((x) => x.id === b.id)
              ? d.items.map((x) => (x.id === b.id ? b : x))
              : [...d.items, b],
          }
        : d,
    );

  const mark = (bid: string, on: boolean) =>
    setBusy((s) => {
      const next = new Set(s);
      if (on) next.add(bid);
      else next.delete(bid);
      return next;
    });

  const toggleConnected = async (b: ChannelBindingViewM7) => {
    const connect = b.status === 'disconnected';
    mark(b.id, true);
    try {
      const next = connect ? await api.connectChannel(b.id) : await api.disconnectChannel(b.id);
      replace(next);
      toast.show(
        connect
          ? next.statusDetail
            ? S.isOnBut({ name: next.label, detail: next.statusDetail })
            : S.connected({ name: next.label })
          : S.disconnected({ name: next.label }),
        { tone: connect && next.statusDetail ? 'error' : 'success' },
      );
    } catch (err) {
      const error = errorMessage(err);
      toast.show(connect ? S.connectFailed({ error }) : S.disconnectFailed({ error }), {
        tone: 'error',
      });
    } finally {
      mark(b.id, false);
    }
  };

  const remove = async (b: ChannelBindingViewM7) => {
    setDeleting(null);
    try {
      await api.deleteChannel(b.id);
      setData((d) => (d ? { ...d, items: d.items.filter((x) => x.id !== b.id) } : d));
      toast.show(S.deleted({ name: b.label }), { tone: 'success' });
    } catch (err) {
      toast.show(S.deleteFailed({ name: b.label, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const agentName = (agentId: string | null) => {
    if (!agentId) return S.noAgent;
    return agents?.find((a) => a.id === agentId)?.name ?? S.anAgent;
  };
  const items = data?.items ?? [];
  const labelOf = (bid: string | null) => items.find((x) => x.id === bid)?.label ?? null;

  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <p className="muted ws-flush">{S.intro}</p>
      <MemberNote access={access}>{MEMBER_MODE_TEXT.channels}</MemberNote>
      {data ? <ChannelShareAsks bindings={data.items} /> : null}
      <section className="settings-section" aria-labelledby="ch-list">
        <h3 id="ch-list">{S.yourChannels}</h3>
        <div className="row">
          <Button variant="primary" disabled={!data} onClick={() => setAdding(true)}>
            <Icon name="plus" /> {S.add}
          </Button>
        </div>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{error}</p>
            <Button onClick={reload}>{S.retry}</Button>
          </div>
        ) : null}
        {data === null && !error ? <Spinner label={S.loading} /> : null}
        {data?.items.length === 0 ? (
          <EmptyState
            level={3}
            icon="chat"
            title={S.emptyTitle}
            description={S.emptyDescription}
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                {S.add}
              </Button>
            }
          />
        ) : null}
        {data?.items.length ? (
          <ul className="ws-list" aria-label={S.list}>
            {data.items.map((b) => {
              const expanded = open.has(b.id);
              const panelId = `ch-panel-${b.id}`;
              const logOpen = logs.has(b.id);
              const logId = `ch-log-${b.id}`;
              return (
                <li key={b.id} className="ws-list-row ch-binding" aria-label={b.label}>
                  <div className="ws-source-main">
                    <strong className="ws-source-name" dir="auto">
                      {b.label}
                    </strong>
                    <span className="ws-row-meta">
                      <span className="ws-badge">{KIND_TEXT[b.kind]}</span>
                      <span className="ws-badge">
                        {b.audience === 'private' ? S.private : S.shared}
                      </span>
                      <Chip spec={BINDING_STATUS[b.status]} />
                    </span>
                    <span className="muted ws-row-meta">
                      <span>{agentName(b.agentId)}</span>
                      <span>
                        {b.lastMessageAt
                          ? S.lastMessage({ when: formatWhen(b.lastMessageAt) })
                          : S.noMessages}
                      </span>
                    </span>
                    {b.statusDetail ? (
                      <p className="ws-warning">
                        <Icon name="alert" /> {b.statusDetail}
                      </p>
                    ) : null}
                    {mailOAuthRowNote(b) ? (
                      <p className="ws-warning">
                        <Icon name="alert" /> {mailOAuthRowNote(b)}
                      </p>
                    ) : null}
                  </div>
                  <div className="row ws-row-actions">
                    <MailOAuthRowAction binding={b} />
                    {b.threadId ? (
                      <Button
                        variant="ghost"
                        aria-label={S.openThreadOf({ name: b.label })}
                        onClick={() => navigate(chatPath(b.threadId))}
                      >
                        {S.openThread}
                      </Button>
                    ) : null}
                    {b.kind !== 'inapp' ? (
                      <Button
                        variant="ghost"
                        disabled={b.status === 'disconnected'}
                        title={b.status === 'disconnected' ? S.connectFirst : undefined}
                        aria-label={S.sendTestTo({ name: b.label })}
                        onClick={() => setTesting(b)}
                      >
                        {S.sendTest}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      disabled={busy.has(b.id)}
                      aria-label={
                        b.status === 'disconnected'
                          ? S.connectName({ name: b.label })
                          : S.disconnectName({ name: b.label })
                      }
                      onClick={() => void toggleConnected(b)}
                    >
                      {b.status === 'disconnected' ? S.connect : S.disconnect}
                    </Button>
                    {b.kind !== 'inapp' ? (
                      <Button
                        variant="ghost"
                        aria-expanded={logOpen}
                        aria-controls={logId}
                        aria-label={S.messagesOf({ name: b.label })}
                        onClick={() =>
                          setLogs((s) => {
                            const next = new Set(s);
                            if (logOpen) next.delete(b.id);
                            else next.add(b.id);
                            return next;
                          })
                        }
                      >
                        {S.messages}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      aria-label={S.settingsOf({ name: b.label })}
                      onClick={() =>
                        setOpen((s) => {
                          const next = new Set(s);
                          if (expanded) next.delete(b.id);
                          else next.add(b.id);
                          return next;
                        })
                      }
                    >
                      {S.settings}
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={S.deleteName({ name: b.label })}
                      onClick={() => setDeleting(b)}
                    >
                      {S.delete}
                    </Button>
                  </div>
                  {logOpen ? (
                    <div id={logId} className="ch-panel">
                      <MessageLog binding={b} />
                    </div>
                  ) : null}
                  {expanded ? (
                    <div id={panelId} className="ch-panel">
                      <BindingSettings
                        binding={b}
                        publicUrl={publicUrl}
                        sharedWithLabel={labelOf(b.sharesCredentialsWith)}
                        onSaved={replace}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        <p className="muted ws-flush">
          {rich(S.watchNote, {
            triggers: (
              <a
                href={TRIGGERS_PATH}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(TRIGGERS_PATH);
                }}
              >
                {S.triggers}
              </a>
            ),
          })}
        </p>
      </section>
      <PeopleSection />
      {access.hubSettings ? (
        <>
          <PolicySection />
          <PublicAddressSection />
        </>
      ) : (
        <OwnerSets heading={MEMBER_MODE_TEXT.channelsOwnerHeading}>
          {MEMBER_MODE_TEXT.channelsOwner}
        </OwnerSets>
      )}
      {data ? (
        <AddChannelDialog
          open={adding}
          onClose={() => setAdding(false)}
          adapters={data.adapters}
          agents={agents}
          bindings={data.items}
          publicUrl={publicUrl}
          onCreated={replace}
          mailHint={access.privateAddresses ? undefined : MEMBER_MODE_TEXT.mailAddresses}
        />
      ) : null}
      {testing ? <TestDialog binding={testing} onClose={() => setTesting(null)} /> : null}
      <Dialog
        open={deleting !== null}
        title={deleting ? S.deleteTitle({ name: deleting.label }) : S.deleteThis}
        description={S.deleteWhat}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{S.cancel}</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              {S.delete}
            </Button>
          </>
        }
      />
    </div>
  );
}

/** Send a test message: it goes to the external conversation, so it is confirmed first. */
function TestDialog({ binding, onClose }: { binding: ChannelBindingViewM7; onClose: () => void }) {
  const T = CHANNELS_PAGE_TEXT.test;
  const api = useChannelsApi();
  const toast = useToast();
  const [text, setText] = useState(() => T.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const t = text.trim();
    if (!t) {
      setError(T.enterMessage);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.testChannel(binding.id, { text: t });
      toast.show(T.sent({ name: binding.label }), { tone: 'success' });
      onClose();
    } catch (err) {
      setError(errorMessage(err, T.failed));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={T.title({ name: binding.label })}
      description={
        binding.kind === 'email'
          ? T.emailed({ address: binding.externalRef })
          : binding.audience === 'shared'
            ? T.shared
            : T.posted
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{CHANNELS_PAGE_TEXT.cancel}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void send()}>
            {busy ? T.sending : CHANNELS_PAGE_TEXT.sendTest}
          </Button>
        </>
      }
    >
      <TextField
        label={T.message}
        value={text}
        maxLength={2000}
        error={error ?? undefined}
        onChange={(e) => setText(e.target.value)}
      />
    </Dialog>
  );
}

/** `channels.privateToShared` (docs/13 §4): ask the owner (default), allow or never share. */
function PolicySection() {
  const settings = useSettings();
  const toast = useToast();
  const id = useId();
  const entry = settings.get('channels.privateToShared');
  const value: Policy = entry.value;
  const P = CHANNELS_PAGE_TEXT.policy;
  return (
    <section className="settings-section" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>{P.title}</h3>
      <p className="muted">{P.intro}</p>
      <RadioGroup
        legend={P.legend}
        name={`${id}-policy`}
        value={value}
        locked={entry.locked}
        setting="channels.privateToShared"
        onChange={(v) =>
          void settings
            .set('channels.privateToShared', v as Policy)
            .catch((err: unknown) =>
              toast.show(P.saveFailed({ error: errorMessage(err) }), { tone: 'error' }),
            )
        }
        options={(['ask', 'allow', 'deny'] as const).map((v) => ({
          value: v,
          label: P[v].label,
          description: P[v].description,
        }))}
      />
    </section>
  );
}

/** `channels.publicUrl`: where Slack, Teams, webhooks and MCP servers reach the Hub. */
function PublicAddressSection() {
  const settings = useSettings();
  const toast = useToast();
  const id = useId();
  const entry = settings.get('channels.publicUrl');
  const A = CHANNELS_PAGE_TEXT.address;
  const [value, setValue] = useState(entry.value ?? '');
  const [base, setBase] = useState(entry.value);
  const [error, setError] = useState<string | null>(null);
  if (base !== entry.value) {
    setBase(entry.value);
    setValue(entry.value ?? '');
  }
  const save = async (next: string | null) => {
    if (next !== null) {
      try {
        const u = new URL(next);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
      } catch {
        setError(A.invalid({ example: EXAMPLE_URL }));
        return;
      }
    }
    setError(null);
    try {
      await settings.set('channels.publicUrl', next);
      toast.show(next ? A.saved : A.cleared, { tone: 'success' });
    } catch (err) {
      setError(errorMessage(err, A.saveFailed));
    }
  };
  const trimmed = value.trim().replace(/\/+$/, '');
  const dirty = (trimmed || null) !== entry.value;
  return (
    <section className="settings-section" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>{A.title}</h3>
      <p className="muted">
        {rich(A.intro, {
          address: (
            <code className="ws-code-inline" dir="ltr">
              {publicBase(entry.value)}
            </code>
          ),
        })}
      </p>
      <form
        className="stack ch-address"
        noValidate
        aria-label={A.title}
        onSubmit={(e) => {
          e.preventDefault();
          void save(trimmed || null);
        }}
      >
        <TextField
          label={A.title}
          type="url"
          value={value}
          placeholder={EXAMPLE_URL}
          spellCheck={false}
          autoComplete="off"
          locked={entry.locked}
          setting="channels.publicUrl"
          hint={A.hint}
          error={error ?? undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="row">
          <Button type="submit" disabled={entry.locked || !dirty}>
            {A.save}
          </Button>
          {entry.value && !entry.locked ? (
            <Button variant="ghost" onClick={() => void save(null)}>
              {A.clear}
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
