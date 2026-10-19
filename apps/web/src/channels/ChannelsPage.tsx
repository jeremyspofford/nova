// Settings → Channels (FR-088, FR-110, FR-100; docs/13 §4, docs/18 J7 step 3): the channels
// agents can be messaged from (Slack, Teams, Telegram, email, webhooks, in-app), with kind,
// audience, agent, status and last message; add one per kind the Hub offers; send a test, connect
// or disconnect at once, open its thread, read its message log, change its settings and
// credentials (write-only), delete it. Also the share decisions waiting on the owner, the people
// agents answer, the private-to-shared policy and the public address external services reach the
// Hub at. Live through channel events.
import { useCallback, useEffect, useId, useState } from 'react';
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
import { chatPath, navigate } from '../router.ts';
import { useSettings } from '../settings.tsx';
import { MANAGED, formatWhen } from '../settings/common.ts';
import { AddChannelDialog } from './AddChannelDialog.tsx';
import { useChannelsApi } from './api.ts';
import { BindingSettings } from './BindingSettings.tsx';
import { CHANNEL_EVENTS, useChannelEvents, useDebouncedCallback } from './events.ts';
import { BINDING_STATUS, KIND_TEXT, publicBase } from './format.ts';
import { MessageLog } from './MessageLog.tsx';
import { Chip } from './parts.tsx';
import { PeopleSection } from './PeopleSection.tsx';
import { ChannelShareAsks } from './ShareAsks.tsx';
import '../workspace.css';
import './channels.css';

export const TRIGGERS_PATH = '/settings/triggers';
export const CHANNELS_PATH = '/settings/channels';

type Policy = 'ask' | 'allow' | 'deny';

export function ChannelsPage() {
  const api = useChannelsApi();
  const toast = useToast();
  const settings = useSettings();
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load channels.')),
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
            ? `${next.label} is on, but: ${next.statusDetail}`
            : `${next.label} connected.`
          : `${next.label} disconnected. No messages go in or out.`,
        { tone: connect && next.statusDetail ? 'error' : 'success' },
      );
    } catch (err) {
      toast.show(`Could not ${connect ? 'connect' : 'disconnect'}: ${errorMessage(err)}`, {
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
      toast.show(`${b.label} deleted.`, { tone: 'success' });
    } catch (err) {
      toast.show(`Could not delete ${b.label}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const agentName = (agentId: string | null) => {
    if (!agentId) return 'No agent';
    return agents?.find((a) => a.id === agentId)?.name ?? 'An agent';
  };
  const items = data?.items ?? [];
  const labelOf = (bid: string | null) => items.find((x) => x.id === bid)?.label ?? null;

  return (
    <div className="settings-page">
      <h2>Channels</h2>
      <p className="muted ws-flush">
        Message your agents from Slack, Teams, Telegram, email, a webhook or Nova itself. Each
        channel keeps its own thread; an agent&apos;s memory is shared across its channels. Messages
        from channels are never treated as your instructions.
      </p>
      {data ? <ChannelShareAsks bindings={data.items} /> : null}
      <section className="settings-section" aria-labelledby="ch-list">
        <h3 id="ch-list">Your channels</h3>
        <div className="row">
          <Button variant="primary" disabled={!data} onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add channel
          </Button>
        </div>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{error}</p>
            <Button onClick={reload}>Retry</Button>
          </div>
        ) : null}
        {data === null && !error ? <Spinner label="Loading channels" /> : null}
        {data?.items.length === 0 ? (
          <EmptyState
            level={3}
            icon="chat"
            title="No channels yet"
            description="Add Slack, Teams, Telegram, email or a webhook to message an agent from there."
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add channel
              </Button>
            }
          />
        ) : null}
        {data?.items.length ? (
          <ul className="ws-list" aria-label="Channels">
            {data.items.map((b) => {
              const expanded = open.has(b.id);
              const panelId = `ch-panel-${b.id}`;
              const logOpen = logs.has(b.id);
              const logId = `ch-log-${b.id}`;
              return (
                <li key={b.id} className="ws-list-row ch-binding" aria-label={b.label}>
                  <div className="ws-source-main">
                    <strong className="ws-source-name">{b.label}</strong>
                    <span className="ws-row-meta">
                      <span className="ws-badge">{KIND_TEXT[b.kind]}</span>
                      <span className="ws-badge">
                        {b.audience === 'private' ? 'Private' : 'Shared'}
                      </span>
                      <Chip spec={BINDING_STATUS[b.status]} />
                    </span>
                    <span className="muted ws-row-meta">
                      <span>{agentName(b.agentId)}</span>
                      <span>
                        {b.lastMessageAt
                          ? `Last message ${formatWhen(b.lastMessageAt)}`
                          : 'No messages yet'}
                      </span>
                    </span>
                    {b.statusDetail ? (
                      <p className="ws-warning">
                        <Icon name="alert" /> {b.statusDetail}
                      </p>
                    ) : null}
                  </div>
                  <div className="row ws-row-actions">
                    {b.threadId ? (
                      <Button
                        variant="ghost"
                        aria-label={`Open the thread of ${b.label}`}
                        onClick={() => navigate(chatPath(b.threadId))}
                      >
                        Open thread
                      </Button>
                    ) : null}
                    {b.kind !== 'inapp' ? (
                      <Button
                        variant="ghost"
                        disabled={b.status === 'disconnected'}
                        title={
                          b.status === 'disconnected' ? 'Connect the channel first.' : undefined
                        }
                        aria-label={`Send a test to ${b.label}`}
                        onClick={() => setTesting(b)}
                      >
                        Send test
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      disabled={busy.has(b.id)}
                      aria-label={`${b.status === 'disconnected' ? 'Connect' : 'Disconnect'} ${b.label}`}
                      onClick={() => void toggleConnected(b)}
                    >
                      {b.status === 'disconnected' ? 'Connect' : 'Disconnect'}
                    </Button>
                    {b.kind !== 'inapp' ? (
                      <Button
                        variant="ghost"
                        aria-expanded={logOpen}
                        aria-controls={logId}
                        aria-label={`Messages of ${b.label}`}
                        onClick={() =>
                          setLogs((s) => {
                            const next = new Set(s);
                            if (logOpen) next.delete(b.id);
                            else next.add(b.id);
                            return next;
                          })
                        }
                      >
                        Messages
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      aria-label={`Settings of ${b.label}`}
                      onClick={() =>
                        setOpen((s) => {
                          const next = new Set(s);
                          if (expanded) next.delete(b.id);
                          else next.add(b.id);
                          return next;
                        })
                      }
                    >
                      Settings
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Delete ${b.label}`}
                      onClick={() => setDeleting(b)}
                    >
                      Delete
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
          Joining a channel never makes an agent watch it. To start work from what is said there,
          add a channel watch in{' '}
          <a
            href={TRIGGERS_PATH}
            onClick={(e) => {
              e.preventDefault();
              navigate(TRIGGERS_PATH);
            }}
          >
            Triggers
          </a>
          .
        </p>
      </section>
      <PeopleSection />
      <PolicySection />
      <PublicAddressSection />
      {data ? (
        <AddChannelDialog
          open={adding}
          onClose={() => setAdding(false)}
          adapters={data.adapters}
          agents={agents}
          bindings={data.items}
          publicUrl={publicUrl}
          onCreated={replace}
        />
      ) : null}
      {testing ? <TestDialog binding={testing} onClose={() => setTesting(null)} /> : null}
      <Dialog
        open={deleting !== null}
        title={deleting ? `Delete ${deleting.label}?` : 'Delete this channel?'}
        description="Messages from it stop at once and its triggers lose their source. Its thread stays in your chats."
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}

/** Send a test message: it goes to the external conversation, so it is confirmed first. */
function TestDialog({ binding, onClose }: { binding: ChannelBindingViewM7; onClose: () => void }) {
  const api = useChannelsApi();
  const toast = useToast();
  const [text, setText] = useState('Nova is connected to this conversation.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const t = text.trim();
    if (!t) {
      setError('Enter a message.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.testChannel(binding.id, { text: t });
      toast.show(`Test sent to ${binding.label}.`, { tone: 'success' });
      onClose();
    } catch (err) {
      setError(errorMessage(err, 'Could not send the test.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={`Send a test to ${binding.label}?`}
      description={
        binding.kind === 'email'
          ? `It is emailed to ${binding.externalRef}.`
          : binding.audience === 'shared'
            ? 'Everyone in this conversation will see it.'
            : 'It is posted to this conversation.'
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void send()}>
            {busy ? 'Sending…' : 'Send test'}
          </Button>
        </>
      }
    >
      <TextField
        label="Message"
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
  return (
    <section className="settings-section" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>Private details in shared channels</h3>
      <p className="muted">
        When a reply in a shared channel would use something from your private chats, private
        channels or private memory.
      </p>
      <RadioGroup
        legend="When a reply would share a private detail"
        name={`${id}-policy`}
        value={value}
        locked={entry.locked}
        hint={entry.locked ? MANAGED : undefined}
        onChange={(v) =>
          void settings
            .set('channels.privateToShared', v as Policy)
            .catch((err: unknown) =>
              toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' }),
            )
        }
        options={[
          {
            value: 'ask',
            label: 'Ask me',
            description: 'The reply waits until you decide. No answer means it is not sent.',
          },
          { value: 'allow', label: 'Allow', description: 'Send it without asking.' },
          {
            value: 'deny',
            label: 'Never share',
            description: 'Hold the reply back; the agent does not post it.',
          },
        ]}
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
        setError('Enter a full address, like https://nova.example.com.');
        return;
      }
    }
    setError(null);
    try {
      await settings.set('channels.publicUrl', next);
      toast.show(next ? 'Public address saved.' : 'Public address cleared.', { tone: 'success' });
    } catch (err) {
      setError(errorMessage(err, 'Could not save the address.'));
    }
  };
  const trimmed = value.trim().replace(/\/+$/, '');
  const dirty = (trimmed || null) !== entry.value;
  return (
    <section className="settings-section" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>Public address</h3>
      <p className="muted">
        The address Slack, Teams, Telegram (in webhook mode), webhooks and MCP servers use to reach
        this Hub. Inbound addresses are shown with it. Now:{' '}
        <code className="ws-code-inline">{publicBase(entry.value)}</code>
      </p>
      <form
        className="stack ch-address"
        noValidate
        aria-label="Public address"
        onSubmit={(e) => {
          e.preventDefault();
          void save(trimmed || null);
        }}
      >
        <TextField
          label="Public address"
          type="url"
          value={value}
          placeholder="https://nova.example.com"
          spellCheck={false}
          autoComplete="off"
          disabled={entry.locked}
          hint={entry.locked ? MANAGED : 'Leave empty to use the Hub’s own address.'}
          error={error ?? undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="row">
          <Button type="submit" disabled={entry.locked || !dirty}>
            Save
          </Button>
          {entry.value && !entry.locked ? (
            <Button variant="ghost" onClick={() => void save(null)}>
              Clear
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
