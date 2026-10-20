// Network → Overview (FR-135, FR-139; docs/22 §2, §6, §10): how clients reach this Hub. The
// primary transport and what clients are told (only endpoints that pass their reachability test
// are advertised), "Test now", problems with guided fixes, each transport with its endpoints,
// latency and 24-hour checks, the change list with one-click rollback, the fallback log, every
// device's reachability, the certificate, mesh access-rule and Relay status, and the settings.
import { useId, useState, type ReactNode } from 'react';
import type {
  DeviceReachabilityView,
  EndpointCandidate,
  NetworkChangeView,
  NetworkDiagnosticsView,
  NetworkTestResult,
  NetworkTransportView,
} from '@nova/shared';
import { defineMessages, fmt } from '@nova/i18n';
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { MODE_TEXT } from '../computers/format.ts';
import { formatWhen } from '../settings/common.ts';
import { embed } from '../settings/embed.tsx';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { followLink } from '../work/nav.tsx';
import { useDebounced } from '../work/events.ts';
import { useNetworkSurfaceApi, type NetworkPanel } from './api.ts';
import { OVERVIEW_EVENTS, primaryChange, useNetworkEvents } from './events.ts';
import {
  EGRESS_SETTINGS_PATH,
  NET_TEXT,
  actorText,
  changeChip,
  changeKindLabel,
  endpointHealthChip,
  eventLines,
  guideFor,
  lastApplied,
  latencyText,
  netErrorMessage,
  networkPath,
  relayStateChip,
  transportHelp,
  transportLabel,
  transportStatusChip,
  trustModeLabel,
  uptimeText,
  valuesText,
  type FixAction,
} from './format.ts';
import { NetworkSettingsForm, SETTINGS_ANCHOR } from './NetworkSettings.tsx';
import { Chip, ConfirmDialog, Fact, LoadError, useLoad } from './parts.tsx';

const S = defineMessages('netsurface.overview', {
  nowPrimary: '{transport} is now the primary transport.',
  noPrimary: 'No transport passes its check.',
  checked:
    'Checked: {n, plural, one {# endpoint} other {# endpoints}} advertised, {transport} first.',
  checkedNone: 'Checked: no endpoint passes its test.',
  testFailed: 'Could not test the endpoints.',
  loadFailed: 'Could not load the network.',
  loading: 'Loading the network',
  refreshFailed: 'Could not refresh the network.',
  rollback: {
    title: 'Roll back the last change?',
    what: '{summary} ({kind}, {when}) is undone and what it replaced comes back.',
    nothing: 'There is nothing to roll back.',
    confirm: 'Roll back',
    done: 'Rolled back: {summary}',
    trust: 'A switch between HTTP and HTTPS applies when the Hub next starts.',
    setup: "Nova runs the step's undo commands on the Hub; this needs host changes on.",
  },
  summary: {
    title: 'How clients reach this Hub',
    primary: 'Primary transport',
    lastChecked: 'Last checked',
    lastCheckedValue: '{when} (every {interval})',
    notYet: 'Not yet',
    listening: 'Listening on',
    notReported: 'Not reported yet',
    waiting: 'Testing starts once the Hub reports where it listens, a moment after it starts.',
    told: 'What clients are told, best first',
    toldHelp:
      'Only endpoints that pass their reachability test are advertised. One that fails is withdrawn until it passes again.',
    advertised: 'Advertised endpoints',
    nothingPasses: 'Nothing passes its test, so clients are told no endpoint.',
    nothingYet: 'Nothing is advertised until the first test.',
  },
  action: {
    test: 'Test now',
    rollback: 'Roll back the last change',
    setup: 'Open Setup',
    trust: 'Open Trust',
    relay: 'Open Relay',
    settings: 'Edit settings',
  },
  noProblems: 'No problems found.',
  problems: 'Problems',
  transports: {
    title: 'Transports',
    order: 'Clients try them in this order: LAN, then Mesh, then Relay, then Direct public.',
    primary: 'Primary',
    off: 'Off: not advertised to clients.',
    endpoints: '{transport} endpoints',
    checked: 'checked {when}',
    from: 'from {detail}',
    why: 'Why: {reason}',
    noAnswer: 'it did not answer',
  },
  changes: {
    title: 'Changes',
    help: 'Every change to transports, trust or the mesh is recorded. Rolling back undoes the newest change that is still applied.',
    list: 'Network changes',
    rolledBack: 'rolled back {when}',
    rollbackFailed: 'The last rollback failed: {error}',
    none: 'No changes yet.',
  },
  events: {
    title: 'Recent transport events',
    list: 'Transport events',
    showAll: 'Show all {n}',
    none: 'Nothing yet. When a transport fails its check or comes back, it shows here.',
  },
  devices: {
    title: 'Devices',
    list: 'Device reachability',
    reachable: 'Reachable',
    revoked: 'Revoked',
    notReachable: 'Not reachable',
    relayPaired: 'Paired through the Relay',
    lastSeen: 'last seen {when}',
    notSeen: 'not seen yet',
    paths: 'Paths to {name}',
    notAnswering: 'not answering',
    none: 'No devices yet',
    noneHelp: 'Devices you add show here with the paths the Hub can reach them on.',
  },
  other: {
    title: 'Certificates, mesh and Relay',
    certificates: 'Certificates',
    mode: 'Mode',
    hubCert: 'Hub certificate',
    expires: 'expires {date}',
    meshCert: 'Mesh certificate',
    meshCertValue: '{host}, expires {date}',
    problems: 'Problems',
    notYet: 'Not available yet.',
    meshRules: 'Mesh access rules',
    noMesh: 'No mesh set up.',
    readThemFailed: 'Could not read them: {error}',
    noRules: 'No access rules to read.',
    provider: 'Provider',
    unknown: 'Unknown',
    rules: 'Rules',
    tags: "This Hub's tags",
    groups: 'Groups',
    relay: 'Relay',
    notAvailable: 'Not available.',
    readItFailed: 'Could not read it: {error}',
    sandbox: 'Sandbox network rules',
    egressLink: 'Settings → Network',
    sandboxMode: 'How sandboxes and agent computers reach the internet: {mode}.',
  },
});

interface OverviewData {
  panel: NetworkPanel;
  diag: NetworkDiagnosticsView;
}

export function OverviewSection() {
  const api = useNetworkSurfaceApi();
  const toast = useToast();
  const announce = useAnnounce();
  const data = useLoad<OverviewData>(
    () =>
      Promise.all([api.getNetworkPanel(), api.getNetworkDiagnostics()]).then(([panel, diag]) => ({
        panel,
        diag,
      })),
    'overview',
  );
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<NetworkTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const reload = useDebounced(data.reload, 150);
  useNetworkEvents(
    OVERVIEW_EVENTS,
    (env) => {
      if (env.name === 'network.transport.changed') {
        const { primary, previous } = primaryChange(env);
        if (primary !== previous)
          announce(primary ? S.nowPrimary({ transport: transportLabel(primary) }) : S.noPrimary);
      }
      reload();
    },
    reload,
  );

  const test = async () => {
    setTesting(true);
    setTestError(null);
    try {
      const r = await api.testNetwork();
      setTested(r);
      announce(
        r.primary
          ? S.checked({ n: r.advertised.length, transport: transportLabel(r.primary) })
          : S.checkedNone,
      );
      data.reload();
    } catch (err) {
      setTestError(netErrorMessage(err, S.testFailed));
    } finally {
      setTesting(false);
    }
  };

  if (!data.data) {
    return data.error ? (
      <LoadError error={data.error} fallback={S.loadFailed} onRetry={data.reload} />
    ) : (
      <Spinner label={S.loading} />
    );
  }

  const { panel, diag } = data.data;
  const last = lastApplied(diag.changes) ?? panel.lastChange;
  const act = (a: FixAction) => {
    if (a === 'test') void test();
    else if (a === 'rollback') setRollingBack(true);
    else if (a === 'settings') {
      const el = document.querySelector<HTMLElement>(`[data-anchor="${SETTINGS_ANCHOR}"]`);
      el?.scrollIntoView?.({ block: 'start' });
      el?.focus();
    } else navigate(networkPath(a));
  };

  return (
    <div className="stack net-section">
      {data.error ? (
        <LoadError error={data.error} fallback={S.refreshFailed} onRetry={data.reload} />
      ) : null}
      <Summary
        panel={panel}
        diag={diag}
        testing={testing}
        tested={tested}
        testError={testError}
        onTest={() => void test()}
      />
      <Problems problems={diag.problems} canRollBack={last !== null} onAction={act} />
      <Transports transports={diag.transports} diag={diag} primary={diag.primary} />
      <Changes changes={diag.changes} last={last} onRollBack={() => setRollingBack(true)} />
      <EventLog diag={diag} />
      <DeviceReachability devices={diag.devices} />
      <OtherStatus panel={panel} diag={diag} />
      <NetworkSettingsForm panel={panel} onSaved={() => data.reload()} />
      <ConfirmDialog
        open={rollingBack}
        title={S.rollback.title}
        description={
          last
            ? embed(S.rollback.what, {
                summary: <strong>{last.summary}</strong>,
                kind: changeKindLabel(last.kind),
                when: formatWhen(last.createdAt),
              })
            : S.rollback.nothing
        }
        confirmLabel={S.rollback.confirm}
        danger
        onClose={() => setRollingBack(false)}
        onConfirm={async () => {
          const r = await api.rollbackNetworkChange();
          setRollingBack(false);
          toast.show(S.rollback.done({ summary: r.change.summary }), { tone: 'success' });
          announce(S.rollback.done({ summary: r.change.summary }));
          data.reload();
        }}
      >
        {last?.kind === 'trust.mode' ? (
          <p className="muted ws-flush">{S.rollback.trust}</p>
        ) : last?.kind === 'network.setup.step' ? (
          <p className="muted ws-flush">{S.rollback.setup}</p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

// ---- summary -------------------------------------------------------------------------------------

function Summary({
  panel,
  diag,
  testing,
  tested,
  testError,
  onTest,
}: {
  panel: NetworkPanel;
  diag: NetworkDiagnosticsView;
  testing: boolean;
  tested: NetworkTestResult | null;
  testError: string | null;
  onTest: () => void;
}) {
  const headingId = useId();
  const advertised = panel.advertised;
  const checkedAt = tested?.checkedAt ?? diag.checkedAt;
  return (
    <section className="ws-section net-first" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>{S.summary.title}</h2>
        <Button onClick={onTest} disabled={testing || !panel.listener}>
          {testing ? <Spinner /> : <Icon name="refresh" />} {S.action.test}
        </Button>
      </div>
      <dl className="net-facts">
        <Fact term={S.summary.primary}>
          {diag.primary ? (
            <Chip spec={{ text: transportLabel(diag.primary), tone: 'ready', icon: 'check' }} />
          ) : (
            <Chip spec={{ text: NET_TEXT.transport.none, tone: 'blocked', icon: 'alert' }} />
          )}
        </Fact>
        <Fact term={S.summary.lastChecked}>
          {S.summary.lastCheckedValue({
            when: checkedAt ? formatWhen(checkedAt) : S.summary.notYet,
            interval: fmt.duration(panel.healthCheckSeconds * 1000),
          })}
        </Fact>
        <Fact term={S.summary.listening}>
          {panel.listener ? (
            <code className="ws-code-inline">
              {panel.listener.protocol}://{panel.listener.host}:{panel.listener.port}
            </code>
          ) : (
            S.summary.notReported
          )}
        </Fact>
      </dl>
      {!panel.listener ? <p className="muted ws-flush">{S.summary.waiting}</p> : null}
      {testError ? (
        <p role="alert" className="nv-field-error">
          {testError}
        </p>
      ) : null}
      <div className="stack net-tight">
        <h3 className="ws-subhead">{S.summary.told}</h3>
        <p className="muted ws-flush">{S.summary.toldHelp}</p>
        {advertised.length ? (
          <ol className="net-advertised" aria-label={S.summary.advertised}>
            {advertised.map((c) => (
              <li key={c.url}>
                <span className="net-transport-name">{transportLabel(c.transport)}</span>
                <code className="ws-code-inline">{c.url}</code>
                <span className="muted">{latencyText(c.latencyMs)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="ws-warning" role="note">
            <Icon name="alert" /> {checkedAt ? S.summary.nothingPasses : S.summary.nothingYet}
          </p>
        )}
      </div>
    </section>
  );
}

// ---- problems ------------------------------------------------------------------------------------

function Problems({
  problems,
  canRollBack,
  onAction,
}: {
  problems: string[];
  canRollBack: boolean;
  onAction: (a: FixAction) => void;
}) {
  const headingId = useId();
  if (!problems.length) {
    return (
      <p className="ws-ok ws-flush" role="status">
        <Icon name="check" /> {S.noProblems}
      </p>
    );
  }
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.problems}</h2>
      <ul className="ws-list" aria-label={S.problems}>
        {problems.map((p, i) => {
          const g = guideFor(p);
          const actions = g.actions.filter((a) => a !== 'rollback' || canRollBack);
          return (
            <li key={`${i}-${p}`} className="net-problem">
              <p className="net-problem-text">
                <Icon name="alert" /> <span>{g.text}</span>
              </p>
              <p className="muted ws-flush">{g.fix}</p>
              {actions.length ? (
                <div className="row">
                  {actions.map((a) => (
                    <Button
                      key={a}
                      variant={a === 'rollback' ? 'danger' : 'default'}
                      onClick={() => onAction(a)}
                    >
                      {S.action[a]}
                    </Button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---- transports -----------------------------------------------------------------------------------

function Transports({
  transports,
  diag,
  primary,
}: {
  transports: NetworkTransportView[];
  diag: NetworkDiagnosticsView;
  primary: string | null;
}) {
  const headingId = useId();
  const uptime = new Map(diag.endpoints.map((e) => [e.url, e.uptime24h]));
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.transports.title}</h2>
      <p className="muted">{S.transports.order}</p>
      <ul className="net-transports" aria-label={S.transports.title}>
        {transports.map((t) => {
          const label = transportLabel(t.transport);
          const best = t.endpoints
            .filter((c) => c.health === 'ok')
            .reduce<number | null>(
              (m, c) =>
                c.latencyMs === null ? m : m === null ? c.latencyMs : Math.min(m, c.latencyMs),
              null,
            );
          return (
            <li key={t.transport} className="net-transport" aria-label={label}>
              <div className="net-transport-head">
                <h3>{label}</h3>
                <Chip spec={transportStatusChip(t.status)} />
                {primary === t.transport ? (
                  <Chip spec={{ text: S.transports.primary, tone: 'ready', icon: 'pin' }} />
                ) : null}
                {best !== null ? <span className="muted">{latencyText(best)}</span> : null}
              </div>
              <p className="muted ws-flush net-small">{transportHelp(t.transport)}</p>
              {t.status === 'off' ? (
                <p className="muted ws-flush net-small">{S.transports.off}</p>
              ) : t.status !== 'up' && t.detail ? (
                <p className="ws-flush net-small">{capital(t.detail)}</p>
              ) : null}
              {t.endpoints.length ? (
                <ul
                  className="net-endpoints"
                  aria-label={S.transports.endpoints({ transport: label })}
                >
                  {t.endpoints.map((c) => (
                    <Endpoint key={c.url} c={c} uptime={uptimeText(uptime.get(c.url))} />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function Endpoint({ c, uptime }: { c: EndpointCandidate; uptime: string | null }) {
  return (
    <li className="net-endpoint">
      <div className="net-endpoint-head">
        <code className="ws-code-inline">{c.url}</code>
        <Chip spec={endpointHealthChip(c.health)} />
      </div>
      <span className="muted ws-row-meta">
        {c.latencyMs !== null ? <span>{latencyText(c.latencyMs)}</span> : null}
        {c.checkedAt ? (
          <span>{S.transports.checked({ when: formatWhen(c.checkedAt) })}</span>
        ) : null}
        {uptime ? <span>{uptime}</span> : null}
        {c.health === 'ok' && c.detail ? (
          <span>{S.transports.from({ detail: c.detail })}</span>
        ) : null}
      </span>
      {c.health === 'failing' ? (
        <span className="net-why">
          {S.transports.why({ reason: c.detail ?? S.transports.noAnswer })}
        </span>
      ) : null}
    </li>
  );
}

// ---- changes ------------------------------------------------------------------------------------

function Changes({
  changes,
  last,
  onRollBack,
}: {
  changes: NetworkChangeView[];
  last: NetworkChangeView | null;
  onRollBack: () => void;
}) {
  const headingId = useId();
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>{S.changes.title}</h2>
        {last ? (
          <Button variant="danger" onClick={onRollBack}>
            <Icon name="undo" /> {S.action.rollback}
          </Button>
        ) : null}
      </div>
      <p className="muted">{S.changes.help}</p>
      {changes.length ? (
        <ul className="ws-list" aria-label={S.changes.list}>
          {changes.map((c) => (
            <li key={c.id} className="ws-list-row net-change" aria-label={c.summary}>
              <div className="net-row-main">
                <div className="net-row-head">
                  <span className="net-strong">{c.summary}</span>
                  <Chip spec={changeChip(c)} />
                </div>
                <span className="muted ws-row-meta">
                  <span>{changeKindLabel(c.kind)}</span>
                  <span>{actorText(c.actor)}</span>
                  <span>{formatWhen(c.createdAt)}</span>
                  {c.rolledBackAt ? (
                    <span>{S.changes.rolledBack({ when: formatWhen(c.rolledBackAt) })}</span>
                  ) : null}
                </span>
                {c.error ? (
                  <span className="net-why">{S.changes.rollbackFailed({ error: c.error })}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted ws-flush">{S.changes.none}</p>
      )}
    </section>
  );
}

// ---- the fallback log ---------------------------------------------------------------------------

function EventLog({ diag }: { diag: NetworkDiagnosticsView }) {
  const headingId = useId();
  const [all, setAll] = useState(false);
  const lines = eventLines(diag.events);
  const shown = all ? lines : lines.slice(0, 8);
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.events.title}</h2>
      {lines.length ? (
        <>
          <ul className="net-events" aria-label={S.events.list}>
            {shown.map((l) => (
              <li key={l.id} data-tone={l.tone}>
                <Icon
                  name={l.tone === 'good' ? 'check' : l.tone === 'bad' ? 'alert' : 'activity'}
                />
                <div>
                  <span>{l.text}</span>
                  {l.detail ? <span className="muted net-small"> {capital(l.detail)}</span> : null}
                  <span className="muted net-small net-when">{formatWhen(l.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
          {lines.length > shown.length ? (
            <div>
              <Button variant="ghost" onClick={() => setAll(true)}>
                {S.events.showAll({ n: lines.length })}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="muted ws-flush">{S.events.none}</p>
      )}
    </section>
  );
}

// ---- devices -----------------------------------------------------------------------------------

function DeviceReachability({ devices }: { devices: DeviceReachabilityView[] }) {
  const headingId = useId();
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.devices.title}</h2>
      {devices.length ? (
        <ul className="ws-list" aria-label={S.devices.list}>
          {devices.map((d) => (
            <li key={d.deviceId} className="ws-list-row" aria-label={d.name}>
              <div className="net-row-main">
                <div className="net-row-head">
                  <span className="net-strong">{d.name}</span>
                  {d.reachable ? (
                    <Chip spec={{ text: S.devices.reachable, tone: 'ready', icon: 'check' }} />
                  ) : (
                    <Chip
                      spec={{
                        text: d.status === 'revoked' ? S.devices.revoked : S.devices.notReachable,
                        tone: d.status === 'revoked' ? 'blocked' : 'needs_input',
                        icon: d.status === 'revoked' ? 'stop' : 'alert',
                      }}
                    />
                  )}
                  {d.relayPaired ? (
                    <Chip spec={{ text: S.devices.relayPaired, tone: 'neutral', icon: 'shield' }} />
                  ) : null}
                </div>
                <span className="muted ws-row-meta">
                  <span>{d.kind}</span>
                  <span>
                    {d.lastSeenAt
                      ? S.devices.lastSeen({ when: formatWhen(d.lastSeenAt) })
                      : S.devices.notSeen}
                  </span>
                </span>
                {d.endpoints.length ? (
                  <ul className="net-paths" aria-label={S.devices.paths({ name: d.name })}>
                    {d.endpoints.map((e) => (
                      <li key={e.url}>
                        <span className="net-transport-name">{transportLabel(e.transport)}</span>
                        <code className="ws-code-inline">{e.url}</code>
                        <span className="muted">
                          {e.healthy ? latencyText(e.latencyMs) : S.devices.notAnswering}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title={S.devices.none}
          level={3}
          icon="server"
          description={S.devices.noneHelp}
        />
      )}
    </section>
  );
}

// ---- certificates, mesh access rules, Relay, sandbox egress (FR-139) ----------------------------

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function StatusCard({
  title,
  link,
  children,
}: {
  title: string;
  link?: { path: string; text: string };
  children: ReactNode;
}) {
  return (
    <div className="ws-card ws-diag-card">
      <h3 className="ws-subhead">{title}</h3>
      {children}
      {link ? (
        <a href={link.path} onClick={(e) => followLink(e, link.path)}>
          {link.text}
        </a>
      ) : null}
    </div>
  );
}

function OtherStatus({ panel, diag }: { panel: NetworkPanel; diag: NetworkDiagnosticsView }) {
  const headingId = useId();
  const trust = diag.trust;
  const mesh = rec(diag.mesh);
  const relay = rec(diag.relay);
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.other.title}</h2>
      <div className="ws-diag-grid">
        <StatusCard
          title={S.other.certificates}
          link={{ path: networkPath('trust'), text: S.action.trust }}
        >
          {trust ? (
            <dl className="ws-dl">
              <dt>{S.other.mode}</dt>
              <dd>{trustModeLabel(trust.mode)}</dd>
              {trust.leafNotAfter ? (
                <>
                  <dt>{S.other.hubCert}</dt>
                  <dd>{S.other.expires({ date: fmt.date(trust.leafNotAfter) })}</dd>
                </>
              ) : null}
              {trust.meshCert ? (
                <>
                  <dt>{S.other.meshCert}</dt>
                  <dd>
                    {S.other.meshCertValue({
                      host: trust.meshCert.host,
                      date: fmt.date(trust.meshCert.notAfter),
                    })}
                  </dd>
                </>
              ) : null}
              {trust.problems.length ? (
                <>
                  <dt>{S.other.problems}</dt>
                  <dd>{fmt.number(trust.problems.length)}</dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p className="muted ws-flush">{S.other.notYet}</p>
          )}
        </StatusCard>
        <StatusCard
          title={S.other.meshRules}
          link={{ path: networkPath('setup'), text: S.action.setup }}
        >
          {!mesh ? (
            <p className="muted ws-flush">{S.other.noMesh}</p>
          ) : text(mesh.error) ? (
            <p className="muted ws-flush">
              {S.other.readThemFailed({ error: text(mesh.error) ?? '' })}
            </p>
          ) : mesh.source === 'none' ? (
            <p className="muted ws-flush">{text(mesh.detail) ?? S.other.noRules}</p>
          ) : (
            <dl className="ws-dl">
              <dt>{S.other.provider}</dt>
              <dd>{text(mesh.provider) ?? S.other.unknown}</dd>
              <dt>{S.other.rules}</dt>
              <dd>{fmt.number(num(mesh.rules) ?? 0)}</dd>
              {strings(mesh.tags).length ? (
                <>
                  <dt>{S.other.tags}</dt>
                  <dd>{valuesText(strings(mesh.tags))}</dd>
                </>
              ) : null}
              {strings(mesh.groups).length ? (
                <>
                  <dt>{S.other.groups}</dt>
                  <dd>{valuesText(strings(mesh.groups))}</dd>
                </>
              ) : null}
            </dl>
          )}
        </StatusCard>
        <StatusCard
          title={S.other.relay}
          link={{ path: networkPath('relay'), text: S.action.relay }}
        >
          {!relay ? (
            <p className="muted ws-flush">{S.other.notAvailable}</p>
          ) : text(relay.error) ? (
            <p className="muted ws-flush">
              {S.other.readItFailed({ error: text(relay.error) ?? '' })}
            </p>
          ) : (
            <div className="stack net-tight">
              <Chip spec={relayStateChip(text(relay.state) ?? 'unknown')} />
              {text(relay.url) ? <code className="ws-code-inline">{text(relay.url)}</code> : null}
              {num(relay.latencyMs) !== null ? (
                <span className="muted net-small">{latencyText(num(relay.latencyMs))}</span>
              ) : null}
              {text(relay.detail) ? (
                <span className="muted net-small">{capital(text(relay.detail) ?? '')}</span>
              ) : null}
            </div>
          )}
        </StatusCard>
        <StatusCard
          title={S.other.sandbox}
          link={{ path: EGRESS_SETTINGS_PATH, text: S.other.egressLink }}
        >
          <p className="muted ws-flush">
            {S.other.sandboxMode({
              mode:
                (MODE_TEXT as Record<string, { label: string } | undefined>)[panel.egress.mode]
                  ?.label ?? panel.egress.mode,
            })}
          </p>
        </StatusCard>
      </div>
    </section>
  );
}
