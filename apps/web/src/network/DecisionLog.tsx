// The network decision log (FR-102, FR-193, docs/12 §8): every request the egress proxy allowed
// or blocked, newest first, read from the audit log (kind `network`), without bodies or full
// URLs. Filter by host and decision; why a request was blocked is said in plain words; a host
// blocked only because it is not allowed can be allowed from here (docs/11 §10, one click,
// audited), for every sandbox or only for the agent, run or session that asked.
import { useEffect, useId, useState } from 'react';
import { fmt, messageFor } from '@nova/i18n';
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
import { MODE_TEXT, causeText, normalizeHost } from '../computers/format.ts';
import { useSettings } from '../settings.tsx';
import { useDebounced } from '../work/events.ts';
import { isRuleScope } from './scopes.ts';
import { EGRESS_TEXT, LOG_TEXT as S } from './strings.ts';

export const PAGE_SIZE = 50;

function hostPort(d: NetworkDecisionView): string {
  if (!d.host) return S.unknownHost;
  return d.port && d.port !== 80 && d.port !== 443 ? `${d.host}:${d.port}` : d.host;
}

/** When the proxy decided, in the active locale (the Hub's text when it is not a date). */
function decidedAt(iso: string): string {
  if (Number.isNaN(Date.parse(iso))) return iso;
  return fmt.dateTime(iso, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
        (err: unknown) => alive && setError(errorMessage(err, S.loadError)),
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
        (err: unknown) => setError(errorMessage(err, S.olderError)),
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
      <h3 id={headingId}>{S.heading}</h3>
      <p className="muted">{S.intro}</p>
      <form
        className="ws-toolbar network-filters"
        role="search"
        aria-label={S.filter}
        onSubmit={(e) => {
          e.preventDefault();
          setHost(normalizeHost(hostDraft));
        }}
      >
        <TextField
          label={S.host}
          value={hostDraft}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder={S.hostPlaceholder}
          onChange={(e) => setHostDraft(e.target.value)}
        />
        <SelectField
          label={S.decision}
          value={decision}
          onChange={(v) => {
            setDecision(v === 'allow' || v === 'deny' ? v : '');
          }}
          options={[
            { value: '', label: S.all },
            { value: 'allow', label: S.allowed },
            { value: 'deny', label: S.blocked },
          ]}
        />
        <Button type="submit">{S.filterButton}</Button>
        {filtered ? (
          <Button
            variant="ghost"
            onClick={() => {
              setHostDraft('');
              setHost('');
              setDecision('');
            }}
          >
            {S.clearFilters}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
          <Icon name="refresh" /> {S.refresh}
        </Button>
      </form>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{EGRESS_TEXT.retry}</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? <p className="ws-flush">{filtered ? S.noMatch : S.empty}</p> : null}
      {items?.length ? (
        <ol className="network-log" aria-label={S.list}>
          {items.map((d) => {
            const allowed = d.decision === 'allow';
            const why = causeText(d);
            const canAllow =
              !allowed && d.cause === 'allowlist' && !!d.host && !checkHostPattern(d.host);
            return (
              <li key={d.id} className="network-decision" data-decision={d.decision}>
                <div className="network-decision-head">
                  <span className="ws-badge" data-tone={allowed ? 'ok' : 'danger'}>
                    <Icon name={allowed ? 'check' : 'stop'} /> {allowed ? S.allowed : S.blocked}
                  </span>
                  <code className="network-request" dir="ltr">
                    {d.method ? `${d.method} ` : ''}
                    {hostPort(d)}
                  </code>
                  <time className="muted network-time" dateTime={d.createdAt}>
                    {decidedAt(d.createdAt)}
                  </time>
                </div>
                {why ? <p className="network-cause">{why}</p> : null}
                <span className="muted ws-row-meta">
                  {d.scope ? <span>{label(d.scope.kind, d.scope.id)}</span> : null}
                  {d.mode ? <span>{MODE_TEXT[d.mode].label}</span> : null}
                  {d.status !== null ? <span>{S.http({ status: String(d.status) })}</span> : null}
                  {d.inspected ? <span>{S.inspected}</span> : null}
                  {d.addressClass && d.addressClass !== 'public' ? (
                    <span>{messageFor(S.address, d.addressClass) ?? S.addressOther}</span>
                  ) : null}
                  {d.bytesIn || d.bytesOut ? (
                    <span>
                      {S.traffic({
                        received: fmt.bytes(d.bytesIn ?? 0),
                        sent: fmt.bytes(d.bytesOut ?? 0),
                      })}
                    </span>
                  ) : null}
                </span>
                {canAllow ? (
                  <div>
                    <Button onClick={() => setAllowing(d)}>
                      {S.allowHost({ host: d.host ?? '' })}
                    </Button>
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
            {loadingMore ? <Spinner /> : null} {S.showMore}
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
        toast.show(S.allowedFor({ host: h, scope: label(own.kind, own.id) }), {
          tone: 'success',
        });
      } else {
        await settings.set('network.egressAllow', [...new Set([...global.value, h])]);
        toast.show(S.allowedEvery({ host: h }), { tone: 'success' });
      }
      onDone();
    } catch (err) {
      setError(errorMessage(err, S.allowError));
      setBusy(false);
    }
  };

  return (
    <Dialog open title={S.allowTitle({ host: h })} description={S.allowBody} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {own ? (
          <RadioGroup
            legend={S.allowFor}
            name={`${id}-where`}
            value={where}
            options={[
              { value: 'scope', label: S.onlyScope({ scope: label(own.kind, own.id) }) },
              { value: 'global', label: EGRESS_TEXT.everySandbox },
            ]}
            onChange={(v) => setWhere(v === 'global' ? 'global' : 'scope')}
          />
        ) : (
          <p className="ws-flush">{S.addedEvery}</p>
        )}
        {where === 'global' && global.locked ? (
          <p className="nv-field-error" role="alert">
            {S.managed}
          </p>
        ) : null}
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{EGRESS_TEXT.cancel}</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || (where === 'global' && global.locked)}
          >
            {busy ? <Spinner /> : null} {S.allowButton}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
