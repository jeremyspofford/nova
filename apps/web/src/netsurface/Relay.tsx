// Network → Relay (FR-137; docs/22 §3, §3.1): a content-blind server the Hub and its clients both
// connect out to, so phones reach the Hub from anywhere. On or off, your own Relay or the hosted
// one, its address, the connection's state and latency, a test, and the clients paired through it
// (device name, platform, relay client id, last seen, status) with Revoke, which asks first.
// Turning the Relay on connects the Hub out, so it asks first too. M7: the registration token a
// private Relay may ask for, write-only (set or not set, replace, remove after asking).
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import {
  RELAY_HOSTED_URL,
  relayRegistrationTokenSchema,
  relayUrlSchema,
  type RelayConfigView,
  type RelayPairedClientView,
  type RelayTestView,
} from '@nova/shared';
import { Button, EmptyState, Icon, RadioGroup, Spinner, TextField, useToast } from '@nova/ui';
import { formatWhen } from '../settings/common.ts';
import { embed } from '../settings/embed.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { useDebounced } from '../work/events.ts';
import { useNetworkSurfaceApi, type RelayPatchBody } from './api.ts';
import { useRelayTokenApi } from './api-m7.ts';
import { RELAY_EVENTS, useNetworkEvents } from './events.ts';
import {
  ADD_DEVICE_PATH,
  latencyText,
  netErrorMessage,
  relayClientChip,
  relayStateChip,
} from './format.ts';
import { Chip, ConfirmDialog, Fact, LoadError, useLoad } from './parts.tsx';

const S = defineMessages('netsurface.relay', {
  loadFailed: 'Could not load the Relay.',
  loading: 'Loading the Relay',
  refreshFailed: 'Could not refresh the Relay.',
  intro:
    'The Relay forwards sealed messages between the Hub and its clients when there is no direct path. It sees only routing ids and ciphertext, never what you send. ' +
    'Phones away from home use it, and it wakes the apps for notifications.',
  status: {
    title: 'Connection',
    test: 'Test',
    answers: 'The Relay answers.',
    answersIn: 'The Relay answers in {latency}.',
    answersVersion: 'The Relay answers (version {version}).',
    answersInVersion: 'The Relay answers in {latency} (version {version}).',
    noAnswer: 'The Relay does not answer.',
    connected: 'The Hub is connected to it.',
    turnOn: 'Turn the Relay on to connect.',
    notPassed: 'The Relay test did not pass.',
    testFailed: 'Could not test the Relay.',
    state: 'State',
    relay: 'Relay',
    noneChosen: 'None chosen',
    latency: 'Latency',
    since: 'Since',
    clients: 'Paired clients',
    clientsActive: '{active, plural, other {# active}}',
    clientsWaiting: '{active, plural, other {# active}}, {pending, plural, other {# waiting}}',
    chooseFirst: 'Choose a Relay below to test it.',
  },
  settings: {
    title: 'Settings',
    badUrl:
      'Enter a wss://, ws://, https:// or http:// address without a user name, query or fragment.',
    needUrl: 'Enter the address of your Relay, or use the hosted one.',
    saved: 'Relay settings saved.',
    isOn: 'The Relay is on.',
    saveFailed: 'Could not save the Relay settings.',
    use: 'Use a Relay',
    useHelp: 'Off: nothing is contacted, and clients reach the Hub on the LAN or the mesh only.',
    which: 'Which Relay',
    own: 'My own Relay',
    ownHelp: 'A small server you run, for example on a VPS or in a container.',
    hosted: 'The hosted Relay',
    hostedHelp: '{url}, unless you enter another address below.',
    address: 'Relay address',
    addressOwn: 'For example {url}.',
    addressHosted: 'Leave empty to use the hosted Relay.',
    save: 'Save',
    reset: 'Reset',
    confirmTitle: 'Connect this Hub to the Relay?',
    confirmText:
      'The Hub connects out to {url} and stays connected. The Relay sees only routing ids and sealed messages; clients you pair through it can then reach the Hub from anywhere.',
    connect: 'Connect',
  },
  token: {
    title: 'Registration token',
    help: 'Only for your own Relay, when it asks Hubs for a token before they register (its {variable}). The hosted Relay needs none. The token is kept in the Hub’s vault and never shown again.',
    bad: 'Use 8 to 512 characters, without spaces.',
    saved: 'Registration token saved. The Hub registers with the Relay again.',
    savedShort: 'Registration token saved.',
    saveFailed: 'Could not save the token.',
    isSet: 'Set',
    notSet: 'Not set',
    newLabel: 'New registration token',
    save: 'Save token',
    cancel: 'Cancel',
    replace: 'Replace token',
    set: 'Set a token',
    remove: 'Remove token',
    removeTitle: 'Remove the registration token?',
    removeText:
      'A Relay that asks for a token refuses this Hub until you set one again, so phones away from home lose their path to the Hub.',
    removeConfirm: 'Remove',
    removed: 'Registration token removed.',
  },
  clients: {
    title: 'Paired clients',
    app: 'Nova app',
    browser: 'Web browser',
    lastSeen: 'last seen {when}',
    notSeen: 'not seen yet',
    paired: 'paired {when}',
    revokedAt: 'revoked {when}',
    clientId: 'Relay client id {id}',
    revoke: 'Revoke',
    revokeName: 'Revoke {name}',
    loadFailed: 'Could not load the paired clients.',
    loading: 'Loading paired clients',
    empty: 'No clients paired through the Relay',
    emptyHelp:
      'Add a phone or a browser from Devices and choose the Relay, so it reaches the Hub away from home.',
    addDevice: 'Add a device',
    past: 'Revoked and denied ({n})',
    pastList: 'Revoked and denied clients',
    revokeTitle: 'Revoke {name}?',
    revokeThis: 'Revoke this client?',
    revokeText:
      'It loses access at once: the Relay drops its route, the Hub refuses its messages and its device is signed out. To use it again, pair it again.',
    revoked: '{name} revoked.',
  },
});

export function RelaySection() {
  const api = useNetworkSurfaceApi();
  const relay = useLoad(() => api.getRelay(), 'relay');
  const clients = useLoad(() => api.listRelayClients().then((r) => r.items), 'relay-clients');
  const reloadRelay = useDebounced(relay.reload, 150);
  const reloadClients = useDebounced(clients.reload, 150);
  useNetworkEvents(
    RELAY_EVENTS,
    (env) => {
      reloadRelay();
      if (env.name !== 'relay.status.changed') reloadClients();
    },
    () => {
      reloadRelay();
      reloadClients();
    },
  );
  const r = relay.data;
  if (!r)
    return relay.error ? (
      <LoadError error={relay.error} fallback={S.loadFailed} onRetry={relay.reload} />
    ) : (
      <Spinner label={S.loading} />
    );
  return (
    <div className="stack net-section">
      {relay.error ? (
        <LoadError error={relay.error} fallback={S.refreshFailed} onRetry={relay.reload} />
      ) : null}
      <p className="muted ws-flush net-first">{S.intro}</p>
      <Status r={r} onChanged={(next) => relay.setData(() => next)} />
      <RelaySettings r={r} onSaved={(next) => relay.setData(() => next)} />
      <RegistrationToken r={r} onSaved={(next) => relay.setData(() => next)} />
      <Clients
        items={clients.data}
        error={clients.error}
        loading={clients.loading}
        onRetry={clients.reload}
        onRevoked={(c) =>
          clients.setData((prev) => prev?.map((x) => (x.id === c.id ? c : x)) ?? null)
        }
      />
    </div>
  );
}

function Status({ r, onChanged }: { r: RelayConfigView; onChanged: (r: RelayConfigView) => void }) {
  const api = useNetworkSurfaceApi();
  const announce = useAnnounce();
  const headingId = useId();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<RelayTestView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const s = r.status;
  const test = async () => {
    setTesting(true);
    setFailure(null);
    try {
      const t = await api.testRelay();
      setResult(t);
      announce(t.ok ? S.status.answers : S.status.notPassed);
      onChanged({
        ...r,
        status: { ...r.status, state: t.state, latencyMs: t.latencyMs ?? r.status.latencyMs },
      });
    } catch (err) {
      setFailure(netErrorMessage(err, S.status.testFailed));
    } finally {
      setTesting(false);
    }
  };
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>{S.status.title}</h2>
        {r.effectiveUrl ? (
          <Button onClick={() => void test()} disabled={testing}>
            {testing ? <Spinner /> : <Icon name="refresh" />} {S.status.test}
          </Button>
        ) : null}
      </div>
      <dl className="net-facts">
        <Fact term={S.status.state}>
          <Chip spec={relayStateChip(s.state)} />
        </Fact>
        <Fact term={S.status.relay}>
          {r.effectiveUrl ? (
            <code className="ws-code-inline net-break">{r.effectiveUrl}</code>
          ) : (
            S.status.noneChosen
          )}
        </Fact>
        <Fact term={S.status.latency}>{latencyText(s.latencyMs)}</Fact>
        <Fact term={S.status.since}>{formatWhen(s.since)}</Fact>
        <Fact term={S.status.clients}>
          {r.clients.pending
            ? S.status.clientsWaiting({ active: r.clients.active, pending: r.clients.pending })
            : S.status.clientsActive({ active: r.clients.active })}
        </Fact>
      </dl>
      {s.detail ? (
        <p className="muted ws-flush">{s.detail.charAt(0).toUpperCase() + s.detail.slice(1)}</p>
      ) : null}
      {!r.effectiveUrl ? <p className="muted ws-flush">{S.status.chooseFirst}</p> : null}
      {failure ? (
        <p role="alert" className="nv-field-error">
          {failure}
        </p>
      ) : null}
      {result ? (
        <div className="net-notice" data-tone={result.ok ? 'ok' : 'bad'} role="status">
          <Icon name={result.ok ? 'check' : 'alert'} />
          <p>
            {answerText(result)}{' '}
            {result.ok
              ? r.enabled
                ? S.status.connected
                : S.status.turnOn
              : result.detail
                ? result.detail.charAt(0).toUpperCase() + result.detail.slice(1) + '.'
                : ''}
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** What the Relay test found, in one sentence. */
function answerText(result: RelayTestView): string {
  if (!result.reachable) return S.status.noAnswer;
  const latency = result.latencyMs !== null ? latencyText(result.latencyMs) : null;
  const version = result.version || null;
  if (latency !== null && version !== null) return S.status.answersInVersion({ latency, version });
  if (latency !== null) return S.status.answersIn({ latency });
  if (version !== null) return S.status.answersVersion({ version });
  return S.status.answers;
}

function RelaySettings({
  r,
  onSaved,
}: {
  r: RelayConfigView;
  onSaved: (r: RelayConfigView) => void;
}) {
  const api = useNetworkSurfaceApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [draft, setDraft] = useState<{ enabled: boolean; selfHosted: boolean; url: string } | null>(
    null,
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const d = draft ?? { enabled: r.enabled, selfHosted: r.selfHosted, url: r.url };
  const body: RelayPatchBody = {
    ...(d.enabled !== r.enabled ? { enabled: d.enabled } : {}),
    ...(d.selfHosted !== r.selfHosted ? { selfHosted: d.selfHosted } : {}),
    ...(d.url.trim() !== r.url ? { url: d.url.trim() } : {}),
  };
  const dirty = Object.keys(body).length > 0;
  const target = d.url.trim() || (d.selfHosted ? '' : RELAY_HOSTED_URL);
  const set = (patch: Partial<typeof d>) => {
    setDraft({ ...d, ...patch });
    setError(undefined);
    setFailure(null);
  };

  const check = (): boolean => {
    if (!relayUrlSchema.safeParse(d.url).success) {
      setError(S.settings.badUrl);
      return false;
    }
    if (d.enabled && !target) {
      setError(S.settings.needUrl);
      return false;
    }
    return true;
  };

  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const next = await api.updateRelay(body);
      setDraft(null);
      onSaved(next);
      toast.show(S.settings.saved, { tone: 'success' });
      announce(next.enabled ? S.settings.isOn : S.settings.saved);
    } catch (err) {
      setFailure(netErrorMessage(err, S.settings.saveFailed));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.settings.title}</h2>
      <form
        className="stack net-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!dirty || !check()) return;
          // Turning it on connects the Hub out to a server: ask first.
          if (body.enabled === true) setConfirming(true);
          else void save().catch(() => undefined);
        }}
      >
        <SwitchField
          label={S.settings.use}
          description={S.settings.useHelp}
          checked={d.enabled}
          onChange={(v) => set({ enabled: v })}
        />
        <RadioGroup
          legend={S.settings.which}
          name="net-relay-kind"
          value={d.selfHosted ? 'self' : 'hosted'}
          options={[
            { value: 'self', label: S.settings.own, description: S.settings.ownHelp },
            {
              value: 'hosted',
              label: S.settings.hosted,
              description: S.settings.hostedHelp({ url: RELAY_HOSTED_URL }),
            },
          ]}
          onChange={(v) => set({ selfHosted: v === 'self' })}
        />
        <TextField
          label={S.settings.address}
          hint={
            d.selfHosted
              ? S.settings.addressOwn({ url: 'wss://relay.example.com' })
              : S.settings.addressHosted
          }
          value={d.url}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => set({ url: e.target.value })}
          error={error}
        />
        {failure ? (
          <p role="alert" className="nv-field-error">
            {failure}
          </p>
        ) : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={!dirty || busy}>
            {busy ? <Spinner /> : null} {S.settings.save}
          </Button>
          {draft ? (
            <Button
              onClick={() => {
                setDraft(null);
                setError(undefined);
                setFailure(null);
              }}
            >
              {S.settings.reset}
            </Button>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        title={S.settings.confirmTitle}
        description={S.settings.confirmText({ url: target })}
        confirmLabel={S.settings.connect}
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          await save();
          setConfirming(false);
        }}
      />
    </section>
  );
}

/** The Relay's setting that names the token (code, not words). */
const TOKEN_VARIABLE = 'NOVA_RELAY_REGISTRATION_TOKEN';

/**
 * The token a private Relay asks Hubs for when they register (its `NOVA_RELAY_REGISTRATION_TOKEN`).
 * Write-only: the Hub keeps it in its vault and only says whether one is set.
 */
function RegistrationToken({
  r,
  onSaved,
}: {
  r: RelayConfigView;
  onSaved: (r: RelayConfigView) => void;
}) {
  const api = useRelayTokenApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const isSet = r.registrationToken === true;

  const save = async () => {
    if (!relayRegistrationTokenSchema.safeParse({ token: value }).success) {
      setError(S.token.bad);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.setRelayRegistrationToken(value);
      onSaved(next);
      setValue('');
      setEditing(false);
      toast.show(S.token.saved, { tone: 'success' });
      announce(S.token.savedShort);
    } catch (err) {
      setError(netErrorMessage(err, S.token.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.token.title}</h2>
      <p className="muted ws-flush">
        {embed(S.token.help, {
          variable: <code className="ws-code-inline">{TOKEN_VARIABLE}</code>,
        })}
      </p>
      <p className="ws-flush">
        <Chip
          spec={
            isSet
              ? { text: S.token.isSet, icon: 'check', tone: 'ready' }
              : { text: S.token.notSet, icon: 'slash', tone: 'neutral' }
          }
        />
      </p>
      {editing ? (
        <form
          className="stack net-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <TextField
            label={isSet ? S.token.newLabel : S.token.title}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={value}
            autoFocus
            maxLength={512}
            error={error}
            onChange={(e) => {
              setValue(e.target.value);
              setError(undefined);
            }}
          />
          <div className="row">
            <Button type="submit" variant="primary" disabled={busy || !value}>
              {busy ? <Spinner /> : null} {S.token.save}
            </Button>
            <Button
              onClick={() => {
                setEditing(false);
                setValue('');
                setError(undefined);
              }}
            >
              {S.token.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <div className="row">
          <Button onClick={() => setEditing(true)}>{isSet ? S.token.replace : S.token.set}</Button>
          {isSet ? (
            <Button variant="danger" onClick={() => setRemoving(true)}>
              {S.token.remove}
            </Button>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={removing}
        title={S.token.removeTitle}
        description={S.token.removeText}
        confirmLabel={S.token.removeConfirm}
        danger
        onClose={() => setRemoving(false)}
        onConfirm={async () => {
          const next = await api.setRelayRegistrationToken(null);
          setRemoving(false);
          onSaved(next);
          toast.show(S.token.removed, { tone: 'success' });
          announce(S.token.removed);
        }}
      />
    </section>
  );
}

function Clients({
  items,
  error,
  loading,
  onRetry,
  onRevoked,
}: {
  items: RelayPairedClientView[] | null;
  error: unknown;
  loading: boolean;
  onRetry: () => void;
  onRevoked: (c: RelayPairedClientView) => void;
}) {
  const api = useNetworkSurfaceApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [revoking, setRevoking] = useState<RelayPairedClientView | null>(null);
  const live = items?.filter((c) => c.status === 'active' || c.status === 'pending') ?? [];
  const past = items?.filter((c) => c.status !== 'active' && c.status !== 'pending') ?? [];
  const row = (c: RelayPairedClientView) => (
    <li key={c.id} className="ws-list-row" aria-label={c.name}>
      <div className="net-row-main">
        <div className="net-row-head">
          <span className="net-strong">{c.name}</span>
          <Chip spec={relayClientChip(c.status)} />
        </div>
        <span className="muted ws-row-meta">
          <span>{c.platform}</span>
          <span>{c.kind === 'native' ? S.clients.app : S.clients.browser}</span>
          <span>
            {c.lastSeenAt
              ? S.clients.lastSeen({ when: formatWhen(c.lastSeenAt) })
              : S.clients.notSeen}
          </span>
          <span>{S.clients.paired({ when: formatWhen(c.createdAt) })}</span>
          {c.revokedAt ? (
            <span>{S.clients.revokedAt({ when: formatWhen(c.revokedAt) })}</span>
          ) : null}
        </span>
        <span className="muted net-small">
          {embed(S.clients.clientId, {
            id: <code className="ws-code-inline net-break">{c.id}</code>,
          })}
        </span>
      </div>
      {c.status === 'active' || c.status === 'pending' ? (
        <Button
          variant="danger"
          aria-label={S.clients.revokeName({ name: c.name })}
          onClick={() => setRevoking(c)}
        >
          {S.clients.revoke}
        </Button>
      ) : null}
    </li>
  );
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.clients.title}</h2>
      {error ? <LoadError error={error} fallback={S.clients.loadFailed} onRetry={onRetry} /> : null}
      {loading ? <Spinner label={S.clients.loading} /> : null}
      {items && live.length === 0 ? (
        <EmptyState
          title={S.clients.empty}
          level={3}
          icon="shield"
          description={S.clients.emptyHelp}
          action={<Button onClick={() => navigate(ADD_DEVICE_PATH)}>{S.clients.addDevice}</Button>}
        />
      ) : null}
      {live.length ? (
        <ul className="ws-list" aria-label={S.clients.title}>
          {live.map(row)}
        </ul>
      ) : null}
      {past.length ? (
        <details className="ws-advanced">
          <summary>{S.clients.past({ n: past.length })}</summary>
          <ul className="ws-list" aria-label={S.clients.pastList}>
            {past.map(row)}
          </ul>
        </details>
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        title={revoking ? S.clients.revokeTitle({ name: revoking.name }) : S.clients.revokeThis}
        description={S.clients.revokeText}
        confirmLabel={S.clients.revoke}
        danger
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          const { client } = await api.revokeRelayClient(revoking.id);
          setRevoking(null);
          onRevoked(client);
          toast.show(S.clients.revoked({ name: client.name }), { tone: 'success' });
          announce(S.clients.revoked({ name: client.name }));
        }}
      />
    </section>
  );
}
