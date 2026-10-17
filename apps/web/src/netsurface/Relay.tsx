// Network → Relay (FR-137; docs/22 §3, §3.1): a content-blind server the Hub and its clients both
// connect out to, so phones reach the Hub from anywhere. On or off, your own Relay or the hosted
// one, its address, the connection's state and latency, a test, and the clients paired through it
// (device name, platform, relay client id, last seen, status) with Revoke, which asks first.
// Turning the Relay on connects the Hub out, so it asks first too.
import { useId, useState } from 'react';
import {
  RELAY_HOSTED_URL,
  relayUrlSchema,
  type RelayConfigView,
  type RelayPairedClientView,
  type RelayTestView,
} from '@nova/shared';
import { Button, EmptyState, Icon, RadioGroup, Spinner, TextField, useToast } from '@nova/ui';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { useDebounced } from '../work/events.ts';
import { useNetworkSurfaceApi, type RelayPatchBody } from './api.ts';
import { RELAY_EVENTS, useNetworkEvents } from './events.ts';
import {
  ADD_DEVICE_PATH,
  latencyText,
  netErrorMessage,
  relayClientChip,
  relayStateChip,
} from './format.ts';
import { Chip, ConfirmDialog, Fact, LoadError, useLoad } from './parts.tsx';

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
      <LoadError error={relay.error} fallback="Could not load the Relay." onRetry={relay.reload} />
    ) : (
      <Spinner label="Loading the Relay" />
    );
  return (
    <div className="stack net-section">
      {relay.error ? (
        <LoadError
          error={relay.error}
          fallback="Could not refresh the Relay."
          onRetry={relay.reload}
        />
      ) : null}
      <p className="muted ws-flush net-first">
        The Relay forwards sealed messages between the Hub and its clients when there is no direct
        path. It sees only routing ids and ciphertext, never what you send. Phones away from home
        use it, and it wakes the apps for notifications.
      </p>
      <Status r={r} onChanged={(next) => relay.setData(() => next)} />
      <RelaySettings r={r} onSaved={(next) => relay.setData(() => next)} />
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
      announce(t.ok ? 'The Relay answers.' : 'The Relay test did not pass.');
      onChanged({
        ...r,
        status: { ...r.status, state: t.state, latencyMs: t.latencyMs ?? r.status.latencyMs },
      });
    } catch (err) {
      setFailure(netErrorMessage(err, 'Could not test the Relay.'));
    } finally {
      setTesting(false);
    }
  };
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>Connection</h2>
        {r.effectiveUrl ? (
          <Button onClick={() => void test()} disabled={testing}>
            {testing ? <Spinner /> : <Icon name="refresh" />} Test
          </Button>
        ) : null}
      </div>
      <dl className="net-facts">
        <Fact term="State">
          <Chip spec={relayStateChip(s.state)} />
        </Fact>
        <Fact term="Relay">
          {r.effectiveUrl ? (
            <code className="ws-code-inline net-break">{r.effectiveUrl}</code>
          ) : (
            'None chosen'
          )}
        </Fact>
        <Fact term="Latency">{latencyText(s.latencyMs)}</Fact>
        <Fact term="Since">{formatWhen(s.since)}</Fact>
        <Fact term="Paired clients">
          {r.clients.active} active{r.clients.pending ? `, ${r.clients.pending} waiting` : ''}
        </Fact>
      </dl>
      {s.detail ? (
        <p className="muted ws-flush">{s.detail.charAt(0).toUpperCase() + s.detail.slice(1)}</p>
      ) : null}
      {!r.effectiveUrl ? <p className="muted ws-flush">Choose a Relay below to test it.</p> : null}
      {failure ? (
        <p role="alert" className="nv-field-error">
          {failure}
        </p>
      ) : null}
      {result ? (
        <div className="net-notice" data-tone={result.ok ? 'ok' : 'bad'} role="status">
          <Icon name={result.ok ? 'check' : 'alert'} />
          <p>
            {result.reachable
              ? `The Relay answers${result.latencyMs !== null ? ` in ${latencyText(result.latencyMs)}` : ''}${
                  result.version ? ` (version ${result.version})` : ''
                }.`
              : 'The Relay does not answer.'}{' '}
            {result.ok
              ? r.enabled
                ? 'The Hub is connected to it.'
                : 'Turn the Relay on to connect.'
              : result.detail
                ? result.detail.charAt(0).toUpperCase() + result.detail.slice(1) + '.'
                : ''}
          </p>
        </div>
      ) : null}
    </section>
  );
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
      setError(
        'Enter a wss://, ws://, https:// or http:// address without a user name, query or fragment.',
      );
      return false;
    }
    if (d.enabled && !target) {
      setError('Enter the address of your Relay, or use the hosted one.');
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
      toast.show('Relay settings saved.', { tone: 'success' });
      announce(next.enabled ? 'The Relay is on.' : 'Relay settings saved.');
    } catch (err) {
      setFailure(netErrorMessage(err, 'Could not save the Relay settings.'));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Settings</h2>
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
          label="Use a Relay"
          description="Off: nothing is contacted, and clients reach the Hub on the LAN or the mesh only."
          checked={d.enabled}
          onChange={(v) => set({ enabled: v })}
        />
        <RadioGroup
          legend="Which Relay"
          name="net-relay-kind"
          value={d.selfHosted ? 'self' : 'hosted'}
          options={[
            {
              value: 'self',
              label: 'My own Relay',
              description: 'A small server you run, for example on a VPS or in a container.',
            },
            {
              value: 'hosted',
              label: 'The hosted Relay',
              description: `${RELAY_HOSTED_URL}, unless you enter another address below.`,
            },
          ]}
          onChange={(v) => set({ selfHosted: v === 'self' })}
        />
        <TextField
          label="Relay address"
          hint={
            d.selfHosted
              ? 'For example wss://relay.example.com.'
              : 'Leave empty to use the hosted Relay.'
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
            {busy ? <Spinner /> : null} Save
          </Button>
          {draft ? (
            <Button
              onClick={() => {
                setDraft(null);
                setError(undefined);
                setFailure(null);
              }}
            >
              Reset
            </Button>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        title="Connect this Hub to the Relay?"
        description={`The Hub connects out to ${target} and stays connected. The Relay sees only routing ids and sealed messages; clients you pair through it can then reach the Hub from anywhere.`}
        confirmLabel="Connect"
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          await save();
          setConfirming(false);
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
          <span>{c.kind === 'native' ? 'Nova app' : 'Web browser'}</span>
          <span>{c.lastSeenAt ? `last seen ${formatWhen(c.lastSeenAt)}` : 'not seen yet'}</span>
          <span>paired {formatWhen(c.createdAt)}</span>
          {c.revokedAt ? <span>revoked {formatWhen(c.revokedAt)}</span> : null}
        </span>
        <span className="muted net-small">
          Relay client id <code className="ws-code-inline net-break">{c.id}</code>
        </span>
      </div>
      {c.status === 'active' || c.status === 'pending' ? (
        <Button variant="danger" aria-label={`Revoke ${c.name}`} onClick={() => setRevoking(c)}>
          Revoke
        </Button>
      ) : null}
    </li>
  );
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Paired clients</h2>
      {error ? (
        <LoadError error={error} fallback="Could not load the paired clients." onRetry={onRetry} />
      ) : null}
      {loading ? <Spinner label="Loading paired clients" /> : null}
      {items && live.length === 0 ? (
        <EmptyState
          title="No clients paired through the Relay"
          level={3}
          icon="shield"
          description="Add a phone or a browser from Devices and choose the Relay, so it reaches the Hub away from home."
          action={<Button onClick={() => navigate(ADD_DEVICE_PATH)}>Add a device</Button>}
        />
      ) : null}
      {live.length ? (
        <ul className="ws-list" aria-label="Paired clients">
          {live.map(row)}
        </ul>
      ) : null}
      {past.length ? (
        <details className="ws-advanced">
          <summary>Revoked and denied ({past.length})</summary>
          <ul className="ws-list" aria-label="Revoked and denied clients">
            {past.map(row)}
          </ul>
        </details>
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        title={revoking ? `Revoke ${revoking.name}?` : 'Revoke this client?'}
        description="It loses access at once: the Relay drops its route, the Hub refuses its messages and its device is signed out. To use it again, pair it again."
        confirmLabel="Revoke"
        danger
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          const { client } = await api.revokeRelayClient(revoking.id);
          setRevoking(null);
          onRevoked(client);
          toast.show(`${client.name} revoked.`, { tone: 'success' });
          announce(`${client.name} revoked.`);
        }}
      />
    </section>
  );
}
