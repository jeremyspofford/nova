// The network decision log (FR-102, FR-193, docs/12 §8): every request the egress proxy allowed
// or blocked, newest first, read from the audit log (kind `network`), without bodies or full
// URLs. Filter by host and decision; why a request was blocked is said in plain words; a host
// blocked only because it is not allowed can be allowed from here (docs/11 §10, one click,
// audited), for every sandbox or only for the agent, run or session that asked.
import { useEffect, useId, useState } from 'react';
import { checkHostPattern, type EgressScopeView, type NetworkDecisionView } from '@nova/shared';
import {
  Button,
  Dialog,
  Icon,
  RadioGroup,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useComputersApi } from '../computers/api.ts';
import { isNetworkAudit, useHubEvents } from '../computers/events.ts';
import {
  MODE_TEXT,
  causeText,
  formatBytes,
  formatDateTime,
  normalizeHost,
} from '../computers/format.ts';
import { useSettings } from '../settings.tsx';
import { useDebounced } from '../work/events.ts';
import { isRuleScope } from './scopes.ts';

export const PAGE_SIZE = 50;

const ADDRESS_TEXT: Record<string, string> = {
  private: 'Private address',
  loopback: 'Loopback address',
  link_local: 'Link-local address',
  cgnat: 'Carrier-grade NAT address',
  unique_local: 'Unique-local address',
  multicast: 'Multicast address',
  unspecified: 'Unspecified address',
  reserved: 'Reserved address',
};

function hostPort(d: NetworkDecisionView): string {
  if (!d.host) return 'unknown host';
  return d.port && d.port !== 80 && d.port !== 443 ? `${d.host}:${d.port}` : d.host;
}

export function DecisionLog({
  scopes,
  label,
  onPolicyChanged,
}: {
  scopes: EgressScopeView[];
  label: (kind: string, id: string) => string;
  /** A host was allowed from the log (reload the egress view). */
  onPolicyChanged: () => void;
}) {
  const api = useComputersApi();
  const headingId = useId();
  const [decision, setDecision] = useState<'' | 'allow' | 'deny'>('');
  const [hostDraft, setHostDraft] = useState('');
  const [host, setHost] = useState('');
  const [items, setItems] = useState<NetworkDecisionView[] | null>(null);
  /** The Hub's cursor for the next older page; null when there is none. */
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [allowing, setAllowing] = useState<NetworkDecisionView | null>(null);
  // The query the shown items answer; a newer one is loading while they differ.
  const key = `${decision}|${host}|${attempt}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = loadedKey !== key;

  useEffect(() => {
    let alive = true;
    api
      .listNetworkDecisions({
        ...(decision ? { decision } : {}),
        ...(host ? { host } : {}),
        limit: PAGE_SIZE,
      })
      .then(
        ({ items: list, nextCursor }) => {
          if (!alive) return;
          setItems(list);
          setNext(nextCursor);
          setError(null);
        },
        (err: unknown) => alive && setError(errorMessage(err, 'Could not load the decision log.')),
      )
      .finally(() => alive && setLoadedKey(key));
    return () => {
      alive = false;
    };
  }, [api, decision, host, attempt, key]);

  const showMore = () => {
    if (!next) return;
    setLoadingMore(true);
    api
      .listNetworkDecisions({
        ...(decision ? { decision } : {}),
        ...(host ? { host } : {}),
        limit: PAGE_SIZE,
        before: next,
      })
      .then(
        ({ items: older, nextCursor }) => {
          setItems((cur) => [...(cur ?? []), ...older]);
          setNext(nextCursor);
          setError(null);
        },
        (err: unknown) => setError(errorMessage(err, 'Could not load older decisions.')),
      )
      .finally(() => setLoadingMore(false));
  };

  // Every proxy decision is an audit entry of kind `network`; follow them without flooding.
  const reload = useDebounced(() => setAttempt((n) => n + 1), 1000);
  useHubEvents(['audit.appended'], (env) => {
    if (isNetworkAudit(env)) reload();
  });

  const filtered = !!(decision || host);
  const more = items !== null && next !== null;

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Decision log</h3>
      <p className="muted">
        Every request a sandbox made through the proxy, allowed or blocked, newest first. Bodies and
        full addresses are not kept.
      </p>
      <form
        className="ws-toolbar network-filters"
        role="search"
        aria-label="Filter the decision log"
        onSubmit={(e) => {
          e.preventDefault();
          setHost(normalizeHost(hostDraft));
        }}
      >
        <TextField
          label="Host"
          value={hostDraft}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder="api.example.com"
          onChange={(e) => setHostDraft(e.target.value)}
        />
        <SelectField
          label="Decision"
          value={decision}
          onChange={(v) => {
            setDecision(v === 'allow' || v === 'deny' ? v : '');
          }}
          options={[
            { value: '', label: 'All' },
            { value: 'allow', label: 'Allowed' },
            { value: 'deny', label: 'Blocked' },
          ]}
        />
        <Button type="submit">Filter</Button>
        {filtered ? (
          <Button
            variant="ghost"
            onClick={() => {
              setHostDraft('');
              setHost('');
              setDecision('');
            }}
          >
            Clear filters
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
          <Icon name="refresh" /> Refresh
        </Button>
      </form>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label="Loading the decision log" /> : null}
      {items?.length === 0 ? (
        <p className="ws-flush">
          {filtered
            ? 'No decisions match these filters.'
            : 'No requests yet. Requests appear here when agents or commands use the network.'}
        </p>
      ) : null}
      {items?.length ? (
        <ol className="network-log" aria-label="Network decisions">
          {items.map((d) => {
            const allowed = d.decision === 'allow';
            const why = causeText(d);
            const canAllow =
              !allowed && d.cause === 'allowlist' && !!d.host && !checkHostPattern(d.host);
            return (
              <li key={d.id} className="network-decision" data-decision={d.decision}>
                <div className="network-decision-head">
                  <span className="ws-badge" data-tone={allowed ? 'ok' : 'danger'}>
                    <Icon name={allowed ? 'check' : 'stop'} /> {allowed ? 'Allowed' : 'Blocked'}
                  </span>
                  <code className="network-request">
                    {d.method ? `${d.method} ` : ''}
                    {hostPort(d)}
                  </code>
                  <time className="muted network-time" dateTime={d.createdAt}>
                    {formatDateTime(d.createdAt)}
                  </time>
                </div>
                {why ? <p className="network-cause">{why}</p> : null}
                <span className="muted ws-row-meta">
                  {d.scope ? <span>{label(d.scope.kind, d.scope.id)}</span> : null}
                  {d.mode ? <span>{MODE_TEXT[d.mode].label}</span> : null}
                  {d.status !== null ? <span>HTTP {d.status}</span> : null}
                  {d.inspected ? <span>HTTPS inspected</span> : null}
                  {d.addressClass && d.addressClass !== 'public' ? (
                    <span>{ADDRESS_TEXT[d.addressClass] ?? 'Non-public address'}</span>
                  ) : null}
                  {d.bytesIn || d.bytesOut ? (
                    <span>
                      {formatBytes(d.bytesIn)} in, {formatBytes(d.bytesOut)} out
                    </span>
                  ) : null}
                </span>
                {canAllow ? (
                  <div>
                    <Button onClick={() => setAllowing(d)}>Allow {d.host}</Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {more ? (
        <div>
          <Button disabled={loading || loadingMore} onClick={showMore}>
            {loadingMore ? <Spinner /> : null} Show more
          </Button>
        </div>
      ) : null}
      {allowing?.host ? (
        <AllowHostDialog
          host={allowing.host}
          scope={allowing.scope}
          scopes={scopes}
          label={label}
          onClose={() => setAllowing(null)}
          onDone={() => {
            setAllowing(null);
            onPolicyChanged();
          }}
        />
      ) : null}
    </section>
  );
}

/** Allow a blocked host for every sandbox (global list) or for the scope that asked. */
function AllowHostDialog({
  host,
  scope,
  scopes,
  label,
  onClose,
  onDone,
}: {
  host: string;
  scope: NetworkDecisionView['scope'];
  scopes: EgressScopeView[];
  label: (kind: string, id: string) => string;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useComputersApi();
  const settings = useSettings();
  const toast = useToast();
  const id = useId();
  const global = settings.get('network.egressAllow');
  const own = scope && isRuleScope(scope.kind) ? { kind: scope.kind, id: scope.id } : null;
  const [where, setWhere] = useState<'global' | 'scope'>(own ? 'scope' : 'global');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const h = normalizeHost(host);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (where === 'scope' && own) {
        const cur = scopes.find((s) => s.kind === own.kind && s.id === own.id);
        await api.putEgressScope(own.kind, own.id, {
          mode: cur?.mode ?? null,
          allow: [...new Set([...(cur?.allow ?? []), h])],
          deny: cur?.deny ?? [],
          hooks: cur?.hooks ?? [],
          allowLocalBinding: cur?.allowLocalBinding ?? false,
        });
        toast.show(`Allowed ${h} for ${label(own.kind, own.id)}.`, { tone: 'success' });
      } else {
        await settings.set('network.egressAllow', [...new Set([...global.value, h])]);
        toast.show(`Allowed ${h} for every sandbox.`, { tone: 'success' });
      }
      onDone();
    } catch (err) {
      setError(errorMessage(err, 'Could not allow the host.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={`Allow ${h}?`}
      description="Commands can then reach this host through the proxy. A blocked host stays blocked, and read-only access still allows only GET, HEAD and OPTIONS."
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {own ? (
          <RadioGroup
            legend="Allow it for"
            name={`${id}-where`}
            value={where}
            options={[
              { value: 'scope', label: `Only ${label(own.kind, own.id)}` },
              { value: 'global', label: 'Every sandbox' },
            ]}
            onChange={(v) => setWhere(v === 'global' ? 'global' : 'scope')}
          />
        ) : (
          <p className="ws-flush">It is added to the allowed hosts for every sandbox.</p>
        )}
        {where === 'global' && global.locked ? (
          <p className="nv-field-error" role="alert">
            The allowed hosts are managed by your organization.
          </p>
        ) : null}
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || (where === 'global' && global.locked)}
          >
            {busy ? <Spinner /> : null} Allow host
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
