// Settings → Diagnostics (FR-118, FR-043, FR-104 partial; docs/16 §1): a health snapshot of the
// Hub and its parts, the redacted log viewer with level and module filters, and the audit log
// with an integrity check of its hash chain. Exports are redacted by the Hub.
import { useEffect, useState, type ReactNode } from 'react';
import type {
  AuditEntryView,
  AuditVerifyResult,
  DiagnosticsSnapshot,
  LogEntryView,
} from '@nova/shared';
import { Button, Icon, SelectField, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { formatWhen, plural, useInterval } from './common.ts';
import { SwitchField } from './controls.tsx';
import { MCP_STATUS } from './policy-text.ts';
import '../workspace.css';

export const LOG_POLL_MS = 5000;
export const LOG_LIMIT = 200;
export const AUDIT_PAGE = 50;

export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${s} s`;
}

export function DiagnosticsPage() {
  return (
    <div className="settings-page">
      <h2>Diagnostics</h2>
      <SnapshotSection />
      <LogsSection />
      <AuditSection />
    </div>
  );
}

// ---- snapshot -------------------------------------------------------------------------------------

function Card({ title, children }: { title: string; children: ReactNode }) {
  const id = `diag-${title.toLowerCase().replace(/\W+/g, '-')}`;
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

  useEffect(() => {
    let alive = true;
    api.diagnostics().then(
      (s) => {
        if (!alive) return;
        setSnap(s);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load diagnostics.')),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const enc = snap?.hub.encryptedAtRest;
  return (
    <section className="settings-section" aria-labelledby="diag-health">
      <div className="ws-section-header">
        <h3 id="diag-health">Health</h3>
        <Button variant="ghost" onClick={() => setVersion((v) => v + 1)}>
          <Icon name="refresh" /> Refresh
        </Button>
      </div>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
        </div>
      ) : null}
      {snap === null && !error ? <Spinner label="Loading diagnostics" /> : null}
      {snap ? (
        <>
          {snap.warnings.length ? (
            <div className="contrast-warning" role="group" aria-label="Warnings">
              <Icon name="alert" />
              <ul>
                {snap.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted">No warnings.</p>
          )}
          <div className="ws-diag-grid">
            <Card title="Hub">
              <dl className="ws-dl">
                <dt>Version</dt>
                <dd>{snap.hub.version}</dd>
                <dt>Running for</dt>
                <dd>{formatUptime(snap.hub.uptimeSeconds)}</dd>
                <dt>Data folder</dt>
                <dd>
                  <code className="ws-code-inline">{snap.hub.dataDir}</code>
                </dd>
              </dl>
            </Card>
            <Card title="Encryption at rest">
              <dl className="ws-dl">
                <dt>Files and backups</dt>
                <dd>{enc?.blobs ? 'Encrypted with the Hub key' : 'Not encrypted'}</dd>
                <dt>Data volume</dt>
                <dd>
                  {enc?.volume === 'encrypted'
                    ? 'Encrypted'
                    : enc?.volume === 'unencrypted'
                      ? 'Not encrypted'
                      : 'Cannot tell'}
                </dd>
              </dl>
            </Card>
            <Card title="Secrets">
              <p className="ws-flush">
                {snap.secrets.backend === 'keychain'
                  ? 'System keychain'
                  : snap.secrets.backend === 'vault'
                    ? 'Encrypted vault'
                    : 'Memory only (lost on restart)'}
              </p>
              <p className="muted ws-flush">{snap.secrets.detail}</p>
            </Card>
            <Card title="Sandbox">
              <p className="ws-flush">
                {snap.sandbox.available
                  ? `Available${snap.sandbox.substrate ? ` (${snap.sandbox.substrate.replace('_', ' ')})` : ''}`
                  : 'Not available'}
              </p>
              <p className="muted ws-flush">{snap.sandbox.detail}</p>
            </Card>
            <Card title="Providers">
              <NamedStatuses
                items={snap.providers.map((p) => ({ id: p.id, name: p.label, status: p.status }))}
                empty="No providers connected."
              />
            </Card>
            <Card title="Compute nodes">
              <NamedStatuses items={snap.nodes} empty="No compute nodes." />
            </Card>
            <Card title="MCP servers">
              <NamedStatuses
                items={snap.mcp.map((m) => ({
                  id: m.id,
                  name: m.name,
                  status: MCP_STATUS[m.status].text,
                  detail: m.lastError,
                }))}
                empty="No MCP servers."
              />
            </Card>
          </div>
        </>
      ) : null}
    </section>
  );
}

function NamedStatuses({
  items,
  empty,
}: {
  items: { id: string; name: string; status: string; detail?: string | null }[];
  empty: string;
}) {
  if (!items.length) return <p className="muted ws-flush">{empty}</p>;
  return (
    <ul className="ws-plain-list">
      {items.map((i) => (
        <li key={i.id}>
          <strong>{i.name}</strong>: {i.status}
          {i.detail ? <span className="muted"> ({i.detail})</span> : null}
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
        (err: unknown) => alive && setError(errorMessage(err, 'Could not load the logs.')),
      );
    return () => {
      alive = false;
    };
  }, [api, level, module, version]);
  useInterval(() => setVersion((v) => v + 1), LOG_POLL_MS, auto);

  return (
    <section className="settings-section" aria-labelledby="diag-logs">
      <h3 id="diag-logs">Logs</h3>
      <p className="muted">
        Recent Hub logs. Keys, tokens and other secrets are removed before they are shown or
        exported.
      </p>
      <div className="ws-toolbar">
        <SelectField
          label="Level"
          value={level}
          onChange={setLevel}
          options={[
            { value: '', label: 'All levels' },
            { value: 'info', label: 'Info and above' },
            { value: 'warn', label: 'Warnings and errors' },
            { value: 'error', label: 'Errors only' },
          ]}
        />
        <SelectField
          label="Module"
          value={module}
          onChange={setModule}
          options={[
            { value: '', label: 'All modules' },
            ...modules.map((m) => ({ value: m, label: m })),
          ]}
        />
        <Button variant="ghost" onClick={() => setVersion((v) => v + 1)}>
          <Icon name="refresh" /> Refresh
        </Button>
        <a className="nv-btn" data-variant="ghost" href={api.logsExportUrl()} download>
          <Icon name="download" /> Export logs
        </a>
      </div>
      <SwitchField
        label="Refresh automatically"
        description="Every 5 seconds while this page is open."
        checked={auto}
        onChange={setAuto}
      />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
        </div>
      ) : null}
      {entries === null && !error ? <Spinner label="Loading logs" /> : null}
      {entries?.length === 0 ? <p className="muted">No log entries match.</p> : null}
      {entries?.length ? (
        <ol className="ws-log ws-log-list" aria-label="Log entries" tabIndex={0}>
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the audit log.')),
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
      toast.show(`Could not load more: ${errorMessage(err)}`, { tone: 'error' });
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
      toast.show(`Could not check the audit log: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="diag-audit">
      <h3 id="diag-audit">Audit log</h3>
      <p className="muted">
        A tamper-evident record of approvals, policy decisions, tool calls and setting changes.
      </p>
      <div className="row">
        <Button disabled={verifying} onClick={() => void check()}>
          {verifying ? <Spinner /> : <Icon name="shield" />} Verify integrity
        </Button>
        <a className="nv-btn" data-variant="ghost" href={api.auditExportUrl()} download>
          <Icon name="download" /> Export audit log
        </a>
      </div>
      <div role="status">
        {verify ? (
          verify.ok ? (
            <p className="ws-ok ws-flush">
              <Icon name="check" /> The audit log is intact (
              {plural(verify.checked, 'entry', 'entries')} checked).
            </p>
          ) : (
            <p className="ws-warning ws-flush">
              <Icon name="alert" /> The audit log was changed: the chain breaks at entry{' '}
              {verify.brokenAt ?? 'unknown'} ({plural(verify.checked, 'entry', 'entries')} checked).
            </p>
          )
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
        </div>
      ) : null}
      {entries === null && !error ? <Spinner label="Loading the audit log" /> : null}
      {entries?.length === 0 ? <p className="muted">The audit log is empty.</p> : null}
      {entries?.length ? (
        <ul className="ws-list" aria-label="Audit entries">
          {entries.map((e) => (
            <li key={e.id} className="ws-list-row ws-audit" aria-label={`${e.kind}: ${e.action}`}>
              <div className="ws-source-main">
                <span className="ws-row-meta">
                  <span className="ws-badge">{e.kind}</span>
                  <strong>{e.action}</strong>
                </span>
                <span className="muted ws-row-meta">
                  <span>By {e.actor}</span>
                  {e.resource ? <span>On {e.resource}</span> : null}
                  {e.decision ? <span>Decision: {e.decision}</span> : null}
                  {e.result ? <span>Result: {e.result}</span> : null}
                  <span>{formatWhen(e.createdAt)}</span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {cursor ? (
        <div className="row">
          <Button disabled={more} onClick={() => void loadMore()}>
            {more ? <Spinner /> : null} Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
