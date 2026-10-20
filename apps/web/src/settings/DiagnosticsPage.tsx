// Settings → Diagnostics (FR-118, FR-119, FR-043, FR-104; docs/16 §1): a health snapshot of the
// Hub and its parts, each with a Test action (providers, MCP servers, the sandbox, storage,
// updates), the redacted log viewer with level and module filters, and the audit log with an
// integrity check of its hash chain; each entry shows its redacted detail (M7.5: a change as
// "before → after"). Exports are redacted by the Hub.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { defineMessages, messageFor } from '@nova/i18n';
import type {
  AuditEntryView,
  AuditVerifyResult,
  DiagnosticsSnapshot,
  LogEntryView,
} from '@nova/shared';
import { Button, Icon, SelectField, Spinner, useToast } from '@nova/ui';
import { ApiError, errorMessage, type ApiErrorBody } from '../api.ts';
import { useServices } from '../services.tsx';
import { formatWhen, useInterval } from './common.ts';
import { SwitchField } from './controls.tsx';
import { MCP_STATUS } from './policy-text.ts';
import '../workspace.css';

export const DIAGNOSTICS_TEXT = defineMessages('settings.diagnostics', {
  uptime: {
    days: '{d} d {h} h',
    hours: '{h} h {m} min',
    minutes: '{m} min',
    seconds: '{s} s',
  },
  testStatus: { ok: 'Passed', warning: 'Warning', error: 'Failed', unavailable: 'Not available' },
  testFailed: 'The test could not run.',
  statusLabel: '{status}:',
  checks: 'Checks',
  check: '{name}: {status}. {detail}',
  testName: 'Test {name}',
  test: 'Test',
  title: 'Diagnostics',
  loadFailed: 'Could not load diagnostics.',
  health: 'Health',
  refresh: 'Refresh',
  retry: 'Retry',
  loading: 'Loading diagnostics',
  warnings: 'Warnings',
  noWarnings: 'No warnings.',
  hub: 'Hub',
  version: 'Version',
  runningFor: 'Running for',
  dataFolder: 'Data folder',
  encryption: 'Encryption at rest',
  blobs: 'Files and backups',
  blobsEncrypted: 'Encrypted with the Hub key',
  notEncrypted: 'Not encrypted',
  volume: 'Data volume',
  encrypted: 'Encrypted',
  cannotTell: 'Cannot tell',
  secrets: 'Secrets',
  keychain: 'System keychain',
  vault: 'Encrypted vault',
  memoryOnly: 'Memory only (lost on restart)',
  sandbox: 'Sandbox',
  available: 'Available',
  availableOn: 'Available ({substrate})',
  notAvailable: 'Not available',
  theSandbox: 'the sandbox',
  storage: 'Storage',
  storageHint: 'Writes, reads and deletes a test file in the data folder and checks the database.',
  theStorage: 'storage',
  updates: 'Updates',
  versionN: 'Version {version}',
  theUpdates: 'updates',
  providers: 'Providers',
  noProviders: 'No providers connected.',
  providerStatus: {
    active: 'active',
    expired: 'expired',
    revoked: 'revoked',
    error: 'needs attention',
  },
  nodes: 'Compute nodes',
  noNodes: 'No compute nodes.',
  nodeStatus: {
    active: 'active',
    pending: 'waiting for first contact',
    unreachable: 'unreachable',
    revoked: 'revoked',
  },
  mcp: 'MCP servers',
  noMcp: 'No MCP servers.',
  logsFailed: 'Could not load the logs.',
  logs: 'Logs',
  logsHint:
    'Recent Hub logs. Keys, tokens and other secrets are removed before they are shown or ' +
    'exported.',
  level: 'Level',
  allLevels: 'All levels',
  infoUp: 'Info and above',
  warnUp: 'Warnings and errors',
  errorsOnly: 'Errors only',
  module: 'Module',
  allModules: 'All modules',
  exportLogs: 'Export logs',
  autoRefresh: 'Refresh automatically',
  autoRefreshHint: 'Every 5 seconds while this page is open.',
  loadingLogs: 'Loading logs',
  noLogs: 'No log entries match.',
  logEntries: 'Log entries',
  value: { none: 'none', on: 'on', off: 'off' },
  truncated:
    'The details are too long to show here ({n, plural, one {# character} other {# characters}}); the export has them.',
  changedTo: 'changed to',
  confirmed: 'Confirmed',
  details: 'Details',
  auditFailed: 'Could not load the audit log.',
  moreFailed: 'Could not load more: {error}',
  verifyFailed: 'Could not check the audit log: {error}',
  audit: 'Audit log',
  auditHint:
    'A tamper-evident record of approvals, policy decisions, tool calls and setting changes.',
  verify: 'Verify integrity',
  exportAudit: 'Export audit log',
  intact: 'The audit log is intact ({n, plural, one {# entry} other {# entries}} checked).',
  broken:
    'The audit log was changed: the chain breaks at entry {at} ({n, plural, one {# entry} other {# entries}} checked).',
  unknown: 'unknown',
  loadingAudit: 'Loading the audit log',
  auditEmpty: 'The audit log is empty.',
  auditEntries: 'Audit entries',
  by: 'By {actor}',
  on: 'On {resource}',
  decision: 'Decision: {decision}',
  result: 'Result: {result}',
  loadMore: 'Load more',
});
const S = DIAGNOSTICS_TEXT;

export const LOG_POLL_MS = 5000;
export const LOG_LIMIT = 200;
export const AUDIT_PAGE = 50;

export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return S.uptime.days({ d, h });
  if (h) return S.uptime.hours({ h, m });
  if (m) return S.uptime.minutes({ m });
  return S.uptime.seconds({ s });
}

// ---- component tests (FR-119) -------------------------------------------------------------------

export type DiagnosticComponent = 'provider' | 'mcp' | 'sandbox' | 'storage' | 'update';
export type DiagnosticStatus = 'ok' | 'warning' | 'error' | 'unavailable';

/** POST /api/v1/diagnostics/test (apps/hub/src/ops.ts); proposed for @nova/shared. */
export interface DiagnosticTestResult {
  component: DiagnosticComponent;
  ref: string | null;
  status: DiagnosticStatus;
  detail: string;
  checks: { name: string; ref: string | null; status: DiagnosticStatus; detail: string }[];
  durationMs: number;
  testedAt: string;
}

/**
 * Run one component's test. The Hub client has no method for this route yet, so the page calls
 * it the way the client does (same-origin session cookie, JSON in and out).
 */
export async function postDiagnosticTest(body: {
  component: DiagnosticComponent;
  ref?: string;
}): Promise<DiagnosticTestResult> {
  const res = await fetch('/api/v1/diagnostics/test', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: ApiErrorBody };
  if (!res.ok)
    throw new ApiError(
      res.status,
      data.error ?? { code: 'server_error', message: res.statusText, retryable: true },
    );
  return data as DiagnosticTestResult;
}

export const TEST_STATUS_TEXT = S.testStatus;

interface TestState {
  running: boolean;
  result: DiagnosticTestResult | null;
  error: string | null;
}

type RunTest = (component: DiagnosticComponent, ref?: string) => Promise<void>;

function useDiagnosticTests(onDone: (component: DiagnosticComponent) => void) {
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const run: RunTest = useCallback(
    async (component, ref) => {
      const key = `${component}:${ref ?? ''}`;
      setTests((t) => ({
        ...t,
        [key]: { running: true, result: t[key]?.result ?? null, error: null },
      }));
      try {
        const result = await postDiagnosticTest(ref ? { component, ref } : { component });
        setTests((t) => ({ ...t, [key]: { running: false, result, error: null } }));
        onDone(component);
      } catch (err) {
        setTests((t) => ({
          ...t,
          [key]: {
            running: false,
            result: null,
            error: errorMessage(err, S.testFailed),
          },
        }));
      }
    },
    [onDone],
  );
  const state = (component: DiagnosticComponent, ref?: string): TestState =>
    tests[`${component}:${ref ?? ''}`] ?? { running: false, result: null, error: null };
  return { run, state };
}

function TestResult({ state }: { state: TestState }) {
  const r = state.result;
  return (
    <div role="status" className="ws-diag-result">
      {state.error ? (
        <p className="ws-warning ws-flush">
          <Icon name="alert" /> {state.error}
        </p>
      ) : r ? (
        <>
          <p
            className={
              r.status === 'ok'
                ? 'ws-ok ws-flush'
                : r.status === 'unavailable'
                  ? 'muted ws-flush'
                  : 'ws-warning ws-flush'
            }
            data-status={r.status}
          >
            <Icon name={r.status === 'ok' ? 'check' : 'alert'} />{' '}
            <span>
              <strong>{S.statusLabel({ status: TEST_STATUS_TEXT[r.status] })}</strong> {r.detail}
            </span>
          </p>
          {r.checks.length > 1 ? (
            <ul className="ws-plain-list" aria-label={S.checks}>
              {r.checks.map((c) => (
                <li key={`${c.name}-${c.ref ?? ''}`}>
                  {S.check({ name: c.name, status: TEST_STATUS_TEXT[c.status], detail: c.detail })}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function TestControl({
  label,
  component,
  refId,
  tests,
}: {
  label: string;
  component: DiagnosticComponent;
  refId?: string;
  tests: ReturnType<typeof useDiagnosticTests>;
}) {
  const state = tests.state(component, refId);
  return (
    <div className="ws-diag-test">
      <Button
        variant="ghost"
        aria-label={S.testName({ name: label })}
        disabled={state.running}
        onClick={() => void tests.run(component, refId)}
      >
        {state.running ? <Spinner /> : <Icon name="refresh" />} {S.test}
      </Button>
      <TestResult state={state} />
    </div>
  );
}

export function DiagnosticsPage() {
  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <SnapshotSection />
      <LogsSection />
      <AuditSection />
    </div>
  );
}

// ---- snapshot -------------------------------------------------------------------------------------

function Card({ id: slug, title, children }: { id: string; title: string; children: ReactNode }) {
  const id = `diag-${slug}`;
  return (
    <section className="ws-card ws-diag-card" aria-labelledby={id}>
      <h4 id={id}>{title}</h4>
      {children}
    </section>
  );
}

function SnapshotSection() {
  const { api } = useServices();
  const [snap, setSnap] = useState<DiagnosticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // A provider test refreshes the account's status, so the snapshot reloads after one.
  const refreshAfter = useCallback((component: DiagnosticComponent) => {
    if (component === 'provider') setVersion((v) => v + 1);
  }, []);
  const tests = useDiagnosticTests(refreshAfter);

  useEffect(() => {
    let alive = true;
    api.diagnostics().then(
      (s) => {
        if (!alive) return;
        setSnap(s);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const enc = snap?.hub.encryptedAtRest;
  return (
    <section className="settings-section" aria-labelledby="diag-health">
      <div className="ws-section-header">
        <h3 id="diag-health">{S.health}</h3>
        <Button variant="ghost" onClick={() => setVersion((v) => v + 1)}>
          <Icon name="refresh" /> {S.refresh}
        </Button>
      </div>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {snap === null && !error ? <Spinner label={S.loading} /> : null}
      {snap ? (
        <>
          {snap.warnings.length ? (
            <div className="contrast-warning" role="group" aria-label={S.warnings}>
              <Icon name="alert" />
              <ul>
                {snap.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted">{S.noWarnings}</p>
          )}
          <div className="ws-diag-grid">
            <Card id="hub" title={S.hub}>
              <dl className="ws-dl">
                <dt>{S.version}</dt>
                <dd>{snap.hub.version}</dd>
                <dt>{S.runningFor}</dt>
                <dd>{formatUptime(snap.hub.uptimeSeconds)}</dd>
                <dt>{S.dataFolder}</dt>
                <dd>
                  <code className="ws-code-inline" dir="ltr">
                    {snap.hub.dataDir}
                  </code>
                </dd>
              </dl>
            </Card>
            <Card id="encryption-at-rest" title={S.encryption}>
              <dl className="ws-dl">
                <dt>{S.blobs}</dt>
                <dd>{enc?.blobs ? S.blobsEncrypted : S.notEncrypted}</dd>
                <dt>{S.volume}</dt>
                <dd>
                  {enc?.volume === 'encrypted'
                    ? S.encrypted
                    : enc?.volume === 'unencrypted'
                      ? S.notEncrypted
                      : S.cannotTell}
                </dd>
              </dl>
            </Card>
            <Card id="secrets" title={S.secrets}>
              <p className="ws-flush">
                {snap.secrets.backend === 'keychain'
                  ? S.keychain
                  : snap.secrets.backend === 'vault'
                    ? S.vault
                    : S.memoryOnly}
              </p>
              <p className="muted ws-flush">{snap.secrets.detail}</p>
            </Card>
            <Card id="sandbox" title={S.sandbox}>
              <p className="ws-flush">
                {snap.sandbox.available
                  ? snap.sandbox.substrate
                    ? S.availableOn({ substrate: snap.sandbox.substrate.replace('_', ' ') })
                    : S.available
                  : S.notAvailable}
              </p>
              <p className="muted ws-flush">{snap.sandbox.detail}</p>
              <TestControl label={S.theSandbox} component="sandbox" tests={tests} />
            </Card>
            <Card id="storage" title={S.storage}>
              <p className="muted ws-flush">{S.storageHint}</p>
              <TestControl label={S.theStorage} component="storage" tests={tests} />
            </Card>
            <Card id="updates" title={S.updates}>
              <p className="ws-flush">{S.versionN({ version: snap.hub.version })}</p>
              <TestControl label={S.theUpdates} component="update" tests={tests} />
            </Card>
            <Card id="providers" title={S.providers}>
              <NamedStatuses
                items={snap.providers.map((p) => ({
                  id: p.id,
                  name: p.label,
                  status: messageFor(S.providerStatus, p.status) ?? p.status,
                }))}
                empty={S.noProviders}
                action={(i) => (
                  <TestControl label={i.name} component="provider" refId={i.id} tests={tests} />
                )}
              />
            </Card>
            <Card id="compute-nodes" title={S.nodes}>
              <NamedStatuses
                items={snap.nodes.map((n) => ({
                  ...n,
                  status: messageFor(S.nodeStatus, n.status) ?? n.status,
                }))}
                empty={S.noNodes}
              />
            </Card>
            <Card id="mcp-servers" title={S.mcp}>
              <NamedStatuses
                items={snap.mcp.map((m) => ({
                  id: m.id,
                  name: m.name,
                  status: MCP_STATUS[m.status].text,
                  detail: m.lastError,
                }))}
                empty={S.noMcp}
                action={(i) => (
                  <TestControl label={i.name} component="mcp" refId={i.id} tests={tests} />
                )}
              />
            </Card>
          </div>
        </>
      ) : null}
    </section>
  );
}

interface NamedStatus {
  id: string;
  name: string;
  status: string;
  detail?: string | null;
}

function NamedStatuses({
  items,
  empty,
  action,
}: {
  items: NamedStatus[];
  empty: string;
  /** A control under each item (the Test action, FR-119). */
  action?: (item: NamedStatus) => ReactNode;
}) {
  if (!items.length) return <p className="muted ws-flush">{empty}</p>;
  return (
    <ul className="ws-plain-list">
      {items.map((i) => (
        <li key={i.id}>
          <strong>{i.name}</strong>: {i.status}
          {i.detail ? <span className="muted"> ({i.detail})</span> : null}
          {action?.(i)}
        </li>
      ))}
    </ul>
  );
}

// ---- logs (FR-118) -----------------------------------------------------------------------------------

function LogsSection() {
  const { api } = useServices();
  const [level, setLevel] = useState('');
  const [module, setModule] = useState('');
  const [modules, setModules] = useState<string[]>([]);
  const [entries, setEntries] = useState<LogEntryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .logs({
        limit: LOG_LIMIT,
        ...(level ? { level } : {}),
        ...(module ? { module } : {}),
      })
      .then(
        ({ items }) => {
          if (!alive) return;
          setEntries(items);
          setError(null);
          // Remember every module seen, so filtering by one keeps the others choosable.
          setModules((known) => {
            const next = new Set(known);
            for (const e of items) next.add(e.module);
            return next.size === known.length ? known : [...next].sort();
          });
        },
        (err: unknown) => alive && setError(errorMessage(err, S.logsFailed)),
      );
    return () => {
      alive = false;
    };
  }, [api, level, module, version]);
  useInterval(() => setVersion((v) => v + 1), LOG_POLL_MS, auto);

  return (
    <section className="settings-section" aria-labelledby="diag-logs">
      <h3 id="diag-logs">{S.logs}</h3>
      <p className="muted">{S.logsHint}</p>
      <div className="ws-toolbar">
        <SelectField
          label={S.level}
          value={level}
          onChange={setLevel}
          options={[
            { value: '', label: S.allLevels },
            { value: 'info', label: S.infoUp },
            { value: 'warn', label: S.warnUp },
            { value: 'error', label: S.errorsOnly },
          ]}
        />
        <SelectField
          label={S.module}
          value={module}
          onChange={setModule}
          options={[
            { value: '', label: S.allModules },
            ...modules.map((m) => ({ value: m, label: m })),
          ]}
        />
        <Button variant="ghost" onClick={() => setVersion((v) => v + 1)}>
          <Icon name="refresh" /> {S.refresh}
        </Button>
        <a className="nv-btn" data-variant="ghost" href={api.logsExportUrl()} download>
          <Icon name="download" /> {S.exportLogs}
        </a>
      </div>
      <SwitchField
        label={S.autoRefresh}
        description={S.autoRefreshHint}
        checked={auto}
        onChange={setAuto}
      />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {entries === null && !error ? <Spinner label={S.loadingLogs} /> : null}
      {entries?.length === 0 ? <p className="muted">{S.noLogs}</p> : null}
      {entries?.length ? (
        // Log lines are the Hub's own words: never translated, always left to right.
        <ol
          className="ws-log ws-log-list"
          aria-label={S.logEntries}
          tabIndex={0}
          dir="ltr"
          translate="no"
        >
          {entries.map((e, i) => (
            <li key={`${e.ts}-${i}`} data-level={e.level}>
              <span className="ws-log-ts">{e.ts}</span>{' '}
              <span className="ws-log-level">{e.level.toUpperCase()}</span>{' '}
              <span className="ws-log-module">{e.module}</span> <span>{e.msg}</span>
              {Object.keys(e.fields).length ? (
                <span className="muted"> {JSON.stringify(e.fields)}</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

// ---- audit (FR-104 partial) ------------------------------------------------------------------------

/** One value of an audit change, short: on/off for switches, `none`, the text, or compact JSON. */
export function auditValue(v: unknown): string {
  if (v === null || v === undefined) return S.value.none;
  if (typeof v === 'boolean') return v ? S.value.on : S.value.off;
  if (typeof v === 'number') return String(v);
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/**
 * The change a settings or device entry records (M7.5: the Hub's detail carries the values
 * before and after), or null when it records none.
 */
export function auditChange(
  e: AuditEntryView,
): { before: string; after: string; confirmed: boolean } | null {
  const d = e.detail;
  if (!d || (e.kind !== 'settings' && e.kind !== 'device')) return null;
  if (!('before' in d) || !('after' in d)) return null;
  return {
    before: auditValue(d.before),
    after: auditValue(d.after),
    confirmed: d.confirmed === true,
  };
}

/** An entry's detail: "before → after" for a change, else the redacted JSON behind a toggle. */
function AuditDetail({ entry }: { entry: AuditEntryView }) {
  const d = entry.detail;
  if (!d || !Object.keys(d).length) return null;
  if (d.truncated === true && typeof d.chars === 'number')
    return <span className="muted">{S.truncated({ n: d.chars })}</span>;
  const change = auditChange(entry);
  if (change)
    return (
      <span className="ws-row-meta ws-audit-change">
        <span>
          {change.before} <span aria-hidden="true">→</span>
          <span className="nv-vh"> {S.changedTo} </span> {change.after}
        </span>
        {change.confirmed ? <span className="ws-badge">{S.confirmed}</span> : null}
      </span>
    );
  return (
    <details className="ws-advanced ws-audit-detail">
      <summary>{S.details}</summary>
      <pre className="ws-log">{JSON.stringify(d, null, 2)}</pre>
    </details>
  );
}

function AuditSection() {
  const { api } = useServices();
  const toast = useToast();
  const [entries, setEntries] = useState<AuditEntryView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [more, setMore] = useState(false);
  const [verify, setVerify] = useState<AuditVerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    let alive = true;
    api.listAudit({ limit: AUDIT_PAGE }).then(
      (page) => {
        if (!alive) return;
        setEntries(page.items);
        setCursor(page.nextCursor);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.auditFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const page = await api.listAudit({ limit: AUDIT_PAGE, cursor });
      setEntries((list) => [...(list ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      toast.show(S.moreFailed({ error: errorMessage(err) }), { tone: 'error' });
    } finally {
      setMore(false);
    }
  };

  const check = async () => {
    setVerifying(true);
    setVerify(null);
    try {
      setVerify(await api.verifyAudit());
    } catch (err) {
      toast.show(S.verifyFailed({ error: errorMessage(err) }), { tone: 'error' });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="diag-audit">
      <h3 id="diag-audit">{S.audit}</h3>
      <p className="muted">{S.auditHint}</p>
      <div className="row">
        <Button disabled={verifying} onClick={() => void check()}>
          {verifying ? <Spinner /> : <Icon name="shield" />} {S.verify}
        </Button>
        <a className="nv-btn" data-variant="ghost" href={api.auditExportUrl()} download>
          <Icon name="download" /> {S.exportAudit}
        </a>
      </div>
      <div role="status">
        {verify ? (
          verify.ok ? (
            <p className="ws-ok ws-flush">
              <Icon name="check" /> {S.intact({ n: verify.checked })}
            </p>
          ) : (
            <p className="ws-warning ws-flush">
              <Icon name="alert" />{' '}
              {S.broken({ at: verify.brokenAt ?? S.unknown, n: verify.checked })}
            </p>
          )
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {entries === null && !error ? <Spinner label={S.loadingAudit} /> : null}
      {entries?.length === 0 ? <p className="muted">{S.auditEmpty}</p> : null}
      {entries?.length ? (
        <ul className="ws-list" aria-label={S.auditEntries}>
          {entries.map((e) => (
            <li key={e.id} className="ws-list-row ws-audit" aria-label={`${e.kind}: ${e.action}`}>
              <div className="ws-source-main">
                <span className="ws-row-meta">
                  <span className="ws-badge">{e.kind}</span>
                  <strong>{e.action}</strong>
                </span>
                <span className="muted ws-row-meta">
                  <span>{S.by({ actor: e.actor })}</span>
                  {e.resource ? <span>{S.on({ resource: e.resource })}</span> : null}
                  {e.decision ? <span>{S.decision({ decision: e.decision })}</span> : null}
                  {e.result ? <span>{S.result({ result: e.result })}</span> : null}
                  <span>{formatWhen(e.createdAt)}</span>
                </span>
                <AuditDetail entry={e} />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {cursor ? (
        <div className="row">
          <Button disabled={more} onClick={() => void loadMore()}>
            {more ? <Spinner /> : null} {S.loadMore}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
