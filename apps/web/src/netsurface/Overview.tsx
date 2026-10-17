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
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { MODE_TEXT } from '../computers/format.ts';
import { formatWhen, plural } from '../settings/common.ts';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { followLink } from '../work/nav.tsx';
import { useDebounced } from '../work/events.ts';
import { useNetworkSurfaceApi, type NetworkPanel } from './api.ts';
import { OVERVIEW_EVENTS, primaryChange, useNetworkEvents } from './events.ts';
import {
  EGRESS_SETTINGS_PATH,
  TRANSPORT_HELP,
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
  transportLabel,
  transportStatusChip,
  trustModeLabel,
  uptimeText,
  type FixAction,
} from './format.ts';
import { NetworkSettingsForm, SETTINGS_ANCHOR } from './NetworkSettings.tsx';
import { Chip, ConfirmDialog, Fact, LoadError, useLoad } from './parts.tsx';

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
          announce(
            primary
              ? `${transportLabel(primary)} is now the primary transport.`
              : 'No transport passes its check.',
          );
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
          ? `Checked: ${plural(r.advertised.length, 'endpoint')} advertised, ${transportLabel(r.primary)} first.`
          : 'Checked: no endpoint passes its test.',
      );
      data.reload();
    } catch (err) {
      setTestError(netErrorMessage(err, 'Could not test the endpoints.'));
    } finally {
      setTesting(false);
    }
  };

  if (!data.data) {
    return data.error ? (
      <LoadError error={data.error} fallback="Could not load the network." onRetry={data.reload} />
    ) : (
      <Spinner label="Loading the network" />
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
        <LoadError
          error={data.error}
          fallback="Could not refresh the network."
          onRetry={data.reload}
        />
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
        title="Roll back the last change?"
        description={
          last ? (
            <>
              <strong>{last.summary}</strong> ({changeKindLabel(last.kind)},{' '}
              {formatWhen(last.createdAt)}) is undone and what it replaced comes back.
            </>
          ) : (
            'There is nothing to roll back.'
          )
        }
        confirmLabel="Roll back"
        danger
        onClose={() => setRollingBack(false)}
        onConfirm={async () => {
          const r = await api.rollbackNetworkChange();
          setRollingBack(false);
          toast.show(`Rolled back: ${r.change.summary}`, { tone: 'success' });
          announce(`Rolled back: ${r.change.summary}`);
          data.reload();
        }}
      >
        {last?.kind === 'trust.mode' ? (
          <p className="muted ws-flush">
            A switch between HTTP and HTTPS applies when the Hub next starts.
          </p>
        ) : last?.kind === 'network.setup.step' ? (
          <p className="muted ws-flush">
            Nova runs the step&apos;s undo commands on the Hub; this needs host changes on.
          </p>
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
        <h2 id={headingId}>How clients reach this Hub</h2>
        <Button onClick={onTest} disabled={testing || !panel.listener}>
          {testing ? <Spinner /> : <Icon name="refresh" />} Test now
        </Button>
      </div>
      <dl className="net-facts">
        <Fact term="Primary transport">
          {diag.primary ? (
            <Chip spec={{ text: transportLabel(diag.primary), tone: 'ready', icon: 'check' }} />
          ) : (
            <Chip spec={{ text: 'None', tone: 'blocked', icon: 'alert' }} />
          )}
        </Fact>
        <Fact term="Last checked">
          {checkedAt ? formatWhen(checkedAt) : 'Not yet'} (every {panel.healthCheckSeconds} s)
        </Fact>
        <Fact term="Listening on">
          {panel.listener ? (
            <code className="ws-code-inline">
              {panel.listener.protocol}://{panel.listener.host}:{panel.listener.port}
            </code>
          ) : (
            'Not reported yet'
          )}
        </Fact>
      </dl>
      {!panel.listener ? (
        <p className="muted ws-flush">
          Testing starts once the Hub reports where it listens, a moment after it starts.
        </p>
      ) : null}
      {testError ? (
        <p role="alert" className="nv-field-error">
          {testError}
        </p>
      ) : null}
      <div className="stack net-tight">
        <h3 className="ws-subhead">What clients are told, best first</h3>
        <p className="muted ws-flush">
          Only endpoints that pass their reachability test are advertised. One that fails is
          withdrawn until it passes again.
        </p>
        {advertised.length ? (
          <ol className="net-advertised" aria-label="Advertised endpoints">
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
            <Icon name="alert" />{' '}
            {checkedAt
              ? 'Nothing passes its test, so clients are told no endpoint.'
              : 'Nothing is advertised until the first test.'}
          </p>
        )}
      </div>
    </section>
  );
}

// ---- problems ------------------------------------------------------------------------------------

const ACTION_LABEL: Record<FixAction, string> = {
  test: 'Test now',
  rollback: 'Roll back the last change',
  setup: 'Open Setup',
  trust: 'Open Trust',
  relay: 'Open Relay',
  settings: 'Edit settings',
};

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
        <Icon name="check" /> No problems found.
      </p>
    );
  }
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Problems</h2>
      <ul className="ws-list" aria-label="Problems">
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
                      {ACTION_LABEL[a]}
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
      <h2 id={headingId}>Transports</h2>
      <p className="muted">
        Clients try them in this order: LAN, then Mesh, then Relay, then Direct public.
      </p>
      <ul className="net-transports" aria-label="Transports">
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
                  <Chip spec={{ text: 'Primary', tone: 'ready', icon: 'pin' }} />
                ) : null}
                {best !== null ? <span className="muted">{latencyText(best)}</span> : null}
              </div>
              <p className="muted ws-flush net-small">{TRANSPORT_HELP[t.transport] ?? ''}</p>
              {t.status === 'off' ? (
                <p className="muted ws-flush net-small">Off: not advertised to clients.</p>
              ) : t.status !== 'up' && t.detail ? (
                <p className="ws-flush net-small">{capital(t.detail)}</p>
              ) : null}
              {t.endpoints.length ? (
                <ul className="net-endpoints" aria-label={`${label} endpoints`}>
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
        {c.checkedAt ? <span>checked {formatWhen(c.checkedAt)}</span> : null}
        {uptime ? <span>{uptime}</span> : null}
        {c.health === 'ok' && c.detail ? <span>from {c.detail}</span> : null}
      </span>
      {c.health === 'failing' ? (
        <span className="net-why">Why: {c.detail ?? 'it did not answer'}</span>
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
        <h2 id={headingId}>Changes</h2>
        {last ? (
          <Button variant="danger" onClick={onRollBack}>
            <Icon name="undo" /> Roll back the last change
          </Button>
        ) : null}
      </div>
      <p className="muted">
        Every change to transports, trust or the mesh is recorded. Rolling back undoes the newest
        change that is still applied.
      </p>
      {changes.length ? (
        <ul className="ws-list" aria-label="Network changes">
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
                  {c.rolledBackAt ? <span>rolled back {formatWhen(c.rolledBackAt)}</span> : null}
                </span>
                {c.error ? (
                  <span className="net-why">The last rollback failed: {c.error}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted ws-flush">No changes yet.</p>
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
      <h2 id={headingId}>Recent transport events</h2>
      {lines.length ? (
        <>
          <ul className="net-events" aria-label="Transport events">
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
                Show all {lines.length}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="muted ws-flush">
          Nothing yet. When a transport fails its check or comes back, it shows here.
        </p>
      )}
    </section>
  );
}

// ---- devices -----------------------------------------------------------------------------------

function DeviceReachability({ devices }: { devices: DeviceReachabilityView[] }) {
  const headingId = useId();
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Devices</h2>
      {devices.length ? (
        <ul className="ws-list" aria-label="Device reachability">
          {devices.map((d) => (
            <li key={d.deviceId} className="ws-list-row" aria-label={d.name}>
              <div className="net-row-main">
                <div className="net-row-head">
                  <span className="net-strong">{d.name}</span>
                  {d.reachable ? (
                    <Chip spec={{ text: 'Reachable', tone: 'ready', icon: 'check' }} />
                  ) : (
                    <Chip
                      spec={{
                        text: d.status === 'revoked' ? 'Revoked' : 'Not reachable',
                        tone: d.status === 'revoked' ? 'blocked' : 'needs_input',
                        icon: d.status === 'revoked' ? 'stop' : 'alert',
                      }}
                    />
                  )}
                  {d.relayPaired ? (
                    <Chip
                      spec={{ text: 'Paired through the Relay', tone: 'neutral', icon: 'shield' }}
                    />
                  ) : null}
                </div>
                <span className="muted ws-row-meta">
                  <span>{d.kind}</span>
                  <span>
                    {d.lastSeenAt ? `last seen ${formatWhen(d.lastSeenAt)}` : 'not seen yet'}
                  </span>
                </span>
                {d.endpoints.length ? (
                  <ul className="net-paths" aria-label={`Paths to ${d.name}`}>
                    {d.endpoints.map((e) => (
                      <li key={e.url}>
                        <span className="net-transport-name">{transportLabel(e.transport)}</span>
                        <code className="ws-code-inline">{e.url}</code>
                        <span className="muted">
                          {e.healthy ? latencyText(e.latencyMs) : 'not answering'}
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
          title="No devices yet"
          level={3}
          icon="server"
          description="Devices you add show here with the paths the Hub can reach them on."
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
  link?: { path: string; label: string };
  children: ReactNode;
}) {
  return (
    <div className="ws-card ws-diag-card">
      <h3 className="ws-subhead">{title}</h3>
      {children}
      {link ? (
        <a href={link.path} onClick={(e) => followLink(e, link.path)}>
          {link.label}
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
      <h2 id={headingId}>Certificates, mesh and Relay</h2>
      <div className="ws-diag-grid">
        <StatusCard title="Certificates" link={{ path: networkPath('trust'), label: 'Open Trust' }}>
          {trust ? (
            <dl className="ws-dl">
              <dt>Mode</dt>
              <dd>{trustModeLabel(trust.mode)}</dd>
              {trust.leafNotAfter ? (
                <>
                  <dt>Hub certificate</dt>
                  <dd>expires {new Date(trust.leafNotAfter).toLocaleDateString()}</dd>
                </>
              ) : null}
              {trust.meshCert ? (
                <>
                  <dt>Mesh certificate</dt>
                  <dd>
                    {trust.meshCert.host}, expires{' '}
                    {new Date(trust.meshCert.notAfter).toLocaleDateString()}
                  </dd>
                </>
              ) : null}
              {trust.problems.length ? (
                <>
                  <dt>Problems</dt>
                  <dd>{trust.problems.length}</dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p className="muted ws-flush">Not available yet.</p>
          )}
        </StatusCard>
        <StatusCard
          title="Mesh access rules"
          link={{ path: networkPath('setup'), label: 'Open Setup' }}
        >
          {!mesh ? (
            <p className="muted ws-flush">No mesh set up.</p>
          ) : text(mesh.error) ? (
            <p className="muted ws-flush">Could not read them: {text(mesh.error)}</p>
          ) : mesh.source === 'none' ? (
            <p className="muted ws-flush">{text(mesh.detail) ?? 'No access rules to read.'}</p>
          ) : (
            <dl className="ws-dl">
              <dt>Provider</dt>
              <dd>{text(mesh.provider) ?? 'Unknown'}</dd>
              <dt>Rules</dt>
              <dd>{num(mesh.rules) ?? 0}</dd>
              {strings(mesh.tags).length ? (
                <>
                  <dt>This Hub&apos;s tags</dt>
                  <dd>{strings(mesh.tags).join(', ')}</dd>
                </>
              ) : null}
              {strings(mesh.groups).length ? (
                <>
                  <dt>Groups</dt>
                  <dd>{strings(mesh.groups).join(', ')}</dd>
                </>
              ) : null}
            </dl>
          )}
        </StatusCard>
        <StatusCard title="Relay" link={{ path: networkPath('relay'), label: 'Open Relay' }}>
          {!relay ? (
            <p className="muted ws-flush">Not available.</p>
          ) : text(relay.error) ? (
            <p className="muted ws-flush">Could not read it: {text(relay.error)}</p>
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
          title="Sandbox network rules"
          link={{ path: EGRESS_SETTINGS_PATH, label: 'Settings → Network' }}
        >
          <p className="muted ws-flush">
            How sandboxes and agent computers reach the internet:{' '}
            {(MODE_TEXT as Record<string, { label: string } | undefined>)[panel.egress.mode]
              ?.label ?? panel.egress.mode}
            .
          </p>
        </StatusCard>
      </div>
    </section>
  );
}
