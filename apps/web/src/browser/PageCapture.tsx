// What the agent browser's page logged (FR-092, FR-103; docs/11 §4 "Observation"): its console
// messages and uncaught errors, and the requests it made, as the agent reads them. The Hub keeps
// the latest 300 of each in memory while the browser is open and masks cookies, sign-in headers
// and secret-looking values; request bodies are never kept. Everything here is page content:
// shown as text (never HTML, never a link), and never treated as an instruction.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type {
  BrowserCaptureView,
  BrowserConsoleEntryView,
  BrowserNetworkEntryView,
} from '@nova/shared';
import { Button, Icon, SelectField, Spinner, Tabs, TextField } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { timeOf } from '../screen/format.ts';
import { useDebounced } from '../work/events.ts';
import { useBrowserM7Api } from './api-m7.ts';
import { eventComputerId, useHubEvents } from './events.ts';
import {
  BODY_OMITTED_TEXT,
  CONSOLE_LEVEL_CHIP,
  durationText,
  requestFailed,
  requestOutcome,
  sizeText,
} from './format.ts';

/** The Hub keeps at most this many entries of each kind per browser. */
export const CAPTURE_LIMIT = 300;

/** Events after which the page may have logged or requested more. */
const CAPTURE_EVENTS = ['browser.navigated', 'browser.action', 'browser.session.changed'] as const;

type Tab = 'console' | 'network';
type ConsoleFilter = 'all' | 'problems' | 'errors';

type Loaded<T> =
  | { state: 'loading' }
  | { state: 'closed' }
  | { state: 'error'; message: string }
  | { state: 'ready'; view: BrowserCaptureView<T> };

/** Loads a capture buffer, again on `version` changes and on the page's events. */
function useCapture<T>(
  computerId: string,
  load: () => Promise<BrowserCaptureView<T>>,
  version: number,
  fallback: string,
): [Loaded<T>, () => void] {
  const [data, setData] = useState<Loaded<T>>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => loadRef.current())
      .then(
        (view) => alive && setData({ state: 'ready', view }),
        (err: unknown) => {
          if (!alive) return;
          if (err instanceof ApiError && err.status === 404) setData({ state: 'closed' });
          else setData({ state: 'error', message: errorMessage(err, fallback) });
        },
      );
    return () => {
      alive = false;
    };
  }, [computerId, version, attempt, fallback]);
  const reload = useDebounced(() => setAttempt((n) => n + 1), 400);
  useHubEvents(CAPTURE_EVENTS, (env) => {
    if (eventComputerId(env) === computerId) reload();
  });
  return [data, () => setAttempt((n) => n + 1)];
}

export function PageCapture({ computerId }: { computerId: string }) {
  const headingId = useId();
  const [tab, setTab] = useState<Tab>('console');
  const [version, setVersion] = useState(0);
  return (
    <section className="ws-section brw-capture" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>What the page logged</h3>
        <Button variant="ghost" onClick={() => setVersion((n) => n + 1)}>
          <Icon name="refresh" /> Refresh
        </Button>
      </div>
      <p className="muted ws-flush">
        The page’s console and the requests it made, as the agent reads them. This is page content:
        it is shown as text and never followed. Cookies, sign-in headers and values that look secret
        are masked, and request bodies are never kept.
      </p>
      <Tabs
        label="Page capture"
        value={tab}
        onChange={(id) => setTab(id === 'network' ? 'network' : 'console')}
        items={[
          {
            id: 'console',
            label: 'Console',
            panel: <ConsoleLog computerId={computerId} version={version} />,
          },
          {
            id: 'network',
            label: 'Network',
            panel: <NetworkLog computerId={computerId} version={version} />,
          },
        ]}
      />
    </section>
  );
}

function Closed() {
  return (
    <p className="muted ws-flush">
      The browser is not open, so there is nothing to show. It is kept only while the browser runs.
    </p>
  );
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="ws-error" role="alert">
      <p>{message}</p>
      <Button onClick={onRetry}>Retry</Button>
    </div>
  );
}

function Dropped({ n, what }: { n: number; what: string }) {
  if (n <= 0) return null;
  return (
    <p className="muted ws-flush">
      {n} older {what} {n === 1 ? 'was' : 'were'} dropped: the browser keeps the latest{' '}
      {CAPTURE_LIMIT}.
    </p>
  );
}

const CONSOLE_FILTERS: Record<ConsoleFilter, (e: BrowserConsoleEntryView) => boolean> = {
  all: () => true,
  problems: (e) => e.level === 'error' || e.level === 'warning',
  errors: (e) => e.level === 'error',
};

function ConsoleLog({ computerId, version }: { computerId: string; version: number }) {
  const api = useBrowserM7Api();
  const [filter, setFilter] = useState<ConsoleFilter>('all');
  const [data, retry] = useCapture(
    computerId,
    () => api.browserConsole(computerId, CAPTURE_LIMIT),
    version,
    'Could not load the console.',
  );
  if (data.state === 'loading') return <Spinner label="Loading the console" />;
  if (data.state === 'closed') return <Closed />;
  if (data.state === 'error') return <Failed message={data.message} onRetry={retry} />;
  const all = data.view.items;
  const shown = [...all].reverse().filter(CONSOLE_FILTERS[filter]);
  return (
    <div className="stack brw-capture-body">
      <div className="ws-toolbar">
        <SelectField
          label="Show"
          value={filter}
          onChange={(v) => setFilter(v === 'problems' || v === 'errors' ? v : 'all')}
          options={[
            { value: 'all', label: 'Every message' },
            { value: 'problems', label: 'Errors and warnings' },
            { value: 'errors', label: 'Errors only' },
          ]}
        />
      </div>
      <Dropped n={data.view.dropped} what="messages" />
      {all.length === 0 ? (
        <p className="muted ws-flush">The page has not written anything to its console.</p>
      ) : shown.length === 0 ? (
        <p className="muted ws-flush">No message matches.</p>
      ) : (
        <ol className="ws-list brw-log" aria-label="Console messages, newest first">
          {shown.map((e) => {
            const chip = CONSOLE_LEVEL_CHIP[e.level];
            return (
              <li key={e.seq} className="ws-list-row brw-log-row" data-level={e.level}>
                <div className="brw-log-head">
                  <span className="nv-chip" data-status={chip.tone ?? undefined}>
                    <Icon name={chip.icon} />
                    <span>{chip.text}</span>
                  </span>
                  {e.source === 'pageerror' ? (
                    <span className="ws-badge">Uncaught error</span>
                  ) : null}
                  <time className="muted" dateTime={e.at}>
                    {timeOf(e.at)}
                  </time>
                </div>
                <pre className="brw-log-text">{e.text}</pre>
                {e.url ? (
                  <span className="muted brw-url">
                    {e.url}
                    {e.line !== null ? `:${e.line}` : ''}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function NetworkLog({ computerId, version }: { computerId: string; version: number }) {
  const api = useBrowserM7Api();
  const [failedOnly, setFailedOnly] = useState(false);
  const [contains, setContains] = useState('');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [data, retry] = useCapture(
    computerId,
    () => api.browserNetwork(computerId, CAPTURE_LIMIT),
    version,
    'Could not load the requests.',
  );
  if (data.state === 'loading') return <Spinner label="Loading the requests" />;
  if (data.state === 'closed') return <Closed />;
  if (data.state === 'error') return <Failed message={data.message} onRetry={retry} />;
  const all = data.view.items;
  const needle = contains.trim().toLowerCase();
  const shown = [...all]
    .reverse()
    .filter(
      (r) => (!failedOnly || requestFailed(r)) && (!needle || r.url.toLowerCase().includes(needle)),
    );
  const toggle = (seq: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  return (
    <div className="stack brw-capture-body">
      <div className="ws-toolbar brw-net-filters">
        <TextField
          label="Address contains"
          type="search"
          value={contains}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setContains(e.target.value)}
        />
        <label className="brw-check">
          <input
            type="checkbox"
            checked={failedOnly}
            onChange={(e) => setFailedOnly(e.target.checked)}
          />
          <span>Only failed or blocked</span>
        </label>
      </div>
      <Dropped n={data.view.dropped} what="requests" />
      {all.length === 0 ? (
        <p className="muted ws-flush">The page has not made any requests yet.</p>
      ) : shown.length === 0 ? (
        <p className="muted ws-flush">No request matches.</p>
      ) : (
        <ol className="ws-list brw-log" aria-label="Requests, newest first">
          {shown.map((r) => (
            <NetworkRow
              key={r.seq}
              r={r}
              expanded={open.has(r.seq)}
              onToggle={() => toggle(r.seq)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function Headers({ title, headers }: { title: string; headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  return (
    <>
      <dt>{title}</dt>
      <dd>
        {entries.length ? (
          <dl className="brw-headers">
            {entries.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          'None'
        )}
      </dd>
    </>
  );
}

function NetworkRow({
  r,
  expanded,
  onToggle,
}: {
  r: BrowserNetworkEntryView;
  expanded: boolean;
  onToggle: () => void;
}) {
  const outcome = requestOutcome(r);
  const size = sizeText(r.size);
  const took = durationText(r.durationMs);
  return (
    <li className="ws-list-row brw-log-row" data-failed={requestFailed(r) || undefined}>
      <button type="button" className="brw-net-summary" aria-expanded={expanded} onClick={onToggle}>
        <span className="brw-log-head">
          <code className="ws-code-inline">{r.method}</code>
          <span className="nv-chip" data-status={outcome.tone ?? undefined}>
            <Icon name={outcome.icon} />
            <span>{outcome.text}</span>
          </span>
          {r.navigation ? <span className="ws-badge">Page load</span> : null}
          <time className="muted" dateTime={r.at}>
            {timeOf(r.at)}
          </time>
        </span>
        <span className="brw-url">{r.url}</span>
        <span className="muted ws-row-meta">
          <span>{r.resourceType}</span>
          {r.mimeType ? <span>{r.mimeType}</span> : null}
          {size ? <span>{size}</span> : null}
          {took ? <span>{took}</span> : null}
        </span>
      </button>
      {expanded ? (
        <dl className="ws-dl brw-net-detail">
          {r.failure ? (
            <>
              <dt>Failure</dt>
              <dd>{r.failure}</dd>
            </>
          ) : null}
          {r.blocked ? (
            <>
              <dt>Blocked</dt>
              <dd>The site is not on the allow list, so the browser did not send it.</dd>
            </>
          ) : null}
          <Headers title="Request headers" headers={r.requestHeaders} />
          <Headers title="Response headers" headers={r.responseHeaders} />
          <dt>Response body</dt>
          <dd>
            {r.body !== null ? (
              <pre className="brw-log-text">{r.body}</pre>
            ) : (
              BODY_OMITTED_TEXT[r.bodyOmitted ?? 'none']
            )}
          </dd>
        </dl>
      ) : null}
    </li>
  );
}
