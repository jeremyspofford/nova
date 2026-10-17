// The Dev servers pane of a Code session (FR-097, FR-067, docs/10 §7): the dev servers Nova
// detected in the session folder (package.json scripts, manage.py, Rails, Go, .nova/launch.json),
// Start for each, and the running ones with their address and status, Stop, and Stop all. Open
// preview opens the address in a new browser tab for now; the agent's browser pane takes it over
// when the browser area wires its opener. `code.devserver.*` events keep it current.
import { useCallback, useEffect, useState } from 'react';
import type { DevServerCandidateView, DevServerView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useCodeM6Api } from './api-m6.ts';
import { useCoalesced } from './events.ts';
import {
  SERVER_ICON,
  SERVER_TEXT,
  SERVER_TONE,
  errorDetails,
  errorReason,
  isLive,
  safeHttpUrl,
} from './m6-format.ts';
import { Badge, ErrorBanner } from './parts.tsx';

/** Opens a dev server's address; a new tab until the browser pane can take it. */
export type PreviewOpener = (url: string) => void;

export const openInNewTab: PreviewOpener = (url) => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

interface StartFailure {
  message: string;
  output: string | null;
}

export function DevServersPane({
  sessionId,
  visible,
  version,
  unavailable,
  openPreview = openInNewTab,
  onChanged,
}: {
  sessionId: string;
  visible: boolean;
  /** Bumped by the session view on each `code.devserver.*` event for this session. */
  version: number;
  /** Why dev servers cannot run for this session, if they cannot. */
  unavailable: string | null;
  openPreview?: PreviewOpener;
  /** After a start or stop here (the session header counts the running servers). */
  onChanged?: () => void;
}) {
  const m6 = useCodeM6Api();
  const toast = useToast();
  const announce = useAnnounce();
  const [candidates, setCandidates] = useState<DevServerCandidateView[] | null>(null);
  const [servers, setServers] = useState<DevServerView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [failure, setFailure] = useState<StartFailure | null>(null);

  const load = useCallback(
    () =>
      m6.listDevServers(sessionId).then(
        (r) => {
          setCandidates(r.candidates);
          setServers(r.items);
          setError(null);
        },
        (err: unknown) => setError(errorMessage(err, 'Could not load the dev servers.')),
      ),
    [m6, sessionId],
  );
  const reload = useCoalesced(load);
  useEffect(() => {
    if (visible && !unavailable) reload();
  }, [reload, unavailable, visible, version]);

  const mark = (key: string, on: boolean) =>
    setBusy((s) => {
      const n = new Set(s);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });
  const upsert = (v: DevServerView) =>
    setServers((list) =>
      list.some((x) => x.id === v.id) ? list.map((x) => (x.id === v.id ? v : x)) : [...list, v],
    );

  const start = async (c: DevServerCandidateView) => {
    mark(c.id, true);
    setFailure(null);
    try {
      const v = await m6.startDevServer(sessionId, { candidateId: c.id });
      upsert(v);
      onChanged?.();
      announce(`${c.label} is ${SERVER_TEXT[v.status].toLowerCase()}.`);
    } catch (err) {
      const reason = errorReason(err);
      const d = errorDetails(err);
      const server = d.server as DevServerView | undefined;
      if (server && typeof server.id === 'string') upsert(server);
      setFailure({
        message:
          reason === 'dev_server_exited'
            ? `${c.label} stopped as soon as it started.`
            : reason === 'too_many_dev_servers'
              ? 'At most 4 dev servers run per session. Stop one first.'
              : err instanceof ApiError && err.body.code === 'sandbox_unavailable'
                ? 'No sandbox is available on the Hub, so dev servers cannot run.'
                : errorMessage(err, `Could not start ${c.label}.`),
        output: typeof d.output === 'string' && d.output ? d.output : null,
      });
    } finally {
      mark(c.id, false);
    }
  };

  const stop = async (s: DevServerView) => {
    mark(s.id, true);
    try {
      upsert(await m6.stopDevServer(sessionId, s.id));
      onChanged?.();
      announce(`${s.label} stopped.`);
    } catch (err) {
      toast.show(`Could not stop ${s.label}: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      mark(s.id, false);
    }
  };

  const stopAll = async () => {
    mark('all', true);
    try {
      const { items } = await m6.stopAllDevServers(sessionId);
      for (const v of items) upsert(v);
      onChanged?.();
      announce('All dev servers stopped.');
    } catch (err) {
      toast.show(`Could not stop the dev servers: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      mark('all', false);
    }
  };

  if (unavailable)
    return (
      <section className="code-servers" aria-label="Dev servers">
        <EmptyState
          level={3}
          title="Dev servers are not available here"
          description={unavailable}
        />
      </section>
    );

  const live = servers.filter(isLive);
  const shown = [...servers].sort((a, b) => Number(isLive(b)) - Number(isLive(a)));

  return (
    <section className="code-servers" aria-label="Dev servers">
      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {candidates === null && !error ? <Spinner label="Looking for dev servers" /> : null}
      {failure ? (
        <div className="code-callout" data-tone="danger" role="alert">
          <p>
            <Icon name="alert" /> {failure.message}
          </p>
          {failure.output ? <pre className="ws-log">{failure.output}</pre> : null}
        </div>
      ) : null}

      {shown.length ? (
        <section className="code-server-group" aria-label="Started">
          <div className="code-subhead">
            <h3>Started</h3>
            {live.length ? (
              <Button disabled={busy.has('all')} onClick={() => void stopAll()}>
                <Icon name="stop" /> Stop all
              </Button>
            ) : null}
          </div>
          <ul className="ws-list" aria-label="Started dev servers">
            {shown.map((s) => {
              const url = safeHttpUrl(s.url);
              return (
                <li key={s.id} className="ws-list-row code-server" aria-label={s.label}>
                  <div className="code-env-main">
                    <div className="code-row-title">
                      <span className="code-env-name">{s.label}</span>
                      <Badge tone={SERVER_TONE[s.status]} icon={SERVER_ICON[s.status]}>
                        {SERVER_TEXT[s.status]}
                      </Badge>
                    </div>
                    <code className="code-cmd">{s.command}</code>
                    <span className="muted code-row-meta">
                      {url && isLive(s) ? <span className="code-path">{url}</span> : null}
                      {s.port ? <span>Port {s.port}</span> : null}
                      <span>Started {formatWhen(s.startedAt)}</span>
                      {s.exitCode !== null ? <span>Exit code {s.exitCode}</span> : null}
                    </span>
                  </div>
                  {isLive(s) ? (
                    <div className="ws-row-actions code-actions">
                      <Button
                        disabled={!url || s.status !== 'running'}
                        title={url ? undefined : 'No address yet.'}
                        onClick={() => {
                          if (url) openPreview(url);
                        }}
                      >
                        <Icon name="external" /> Open preview
                      </Button>
                      <Button disabled={busy.has(s.id)} onClick={() => void stop(s)}>
                        <Icon name="stop" /> Stop
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="muted ws-flush">
            The address is on the Hub. It opens in a new tab, which loads only when this browser can
            reach the Hub at that address.
          </p>
        </section>
      ) : null}

      {candidates?.length === 0 && !shown.length ? (
        <EmptyState
          level={3}
          title="No dev server found"
          description="Nova looks for a dev script in package.json, manage.py, Rails, a Go main package, or .nova/launch.json in the session folder."
        />
      ) : null}
      {candidates?.length ? (
        <section className="code-server-group" aria-label="Detected">
          <h3>Detected in this folder</h3>
          <ul className="ws-list" aria-label="Detected dev servers">
            {candidates.map((c) => {
              const running = servers.find((s) => s.candidateId === c.id && isLive(s));
              return (
                <li key={c.id} className="ws-list-row" aria-label={c.label}>
                  <div className="code-env-main">
                    <div className="code-row-title">
                      <span className="code-env-name">{c.label}</span>
                      <span className="code-kind">{c.framework}</span>
                    </div>
                    <code className="code-cmd">{c.command}</code>
                    <span className="muted code-row-meta">
                      <span>From {c.source}</span>
                      {c.cwd ? <span className="code-path">in {c.cwd}</span> : null}
                      {c.port ? <span>Usually port {c.port}</span> : null}
                    </span>
                  </div>
                  <div className="ws-row-actions code-actions">
                    <Button
                      variant="primary"
                      disabled={busy.has(c.id) || !!running}
                      title={running ? 'Already started.' : undefined}
                      onClick={() => void start(c)}
                    >
                      {busy.has(c.id) ? <Spinner /> : null} Start
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
