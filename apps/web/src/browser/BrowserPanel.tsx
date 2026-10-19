// The agent browser of one computer (FR-092, FR-096, FR-098, FR-086, FR-087, FR-208, FR-194;
// docs/11 §4, §10): the open page (title, address, session state, the tools the page registered),
// a crash and how often it restarted, its latest frame from the Hub, pending private sign-ins, what
// the page logged (console and network), the recorded actions with before/after screenshots,
// taking over the page (the agent waits until control is returned) and closing the session. Page
// titles and addresses come from the web: shown as text, never as links or HTML. Mounted on a
// computer's page.
import { useEffect, useId, useState } from 'react';
import type { BrowserSessionView, BrowserStatusView, ScreenTakeoverView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { useScreenApi } from '../screen/api.ts';
import { sentence } from '../screen/format.ts';
import { LiveView } from '../screen/LiveView.tsx';
import { useAnnounce } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { useBrowserApi } from './api.ts';
import { useHasBrowserCapture } from './api-m7.ts';
import { BrowserTrace } from './BrowserTrace.tsx';
import { PageCapture } from './PageCapture.tsx';
import { BROWSER_PAGE_EVENTS, eventComputerId, useHubEvents } from './events.ts';
import { SESSION_CHIP } from './format.ts';
import { PendingSignins } from './PendingSignins.tsx';
import '../workspace.css';
import '../screen/screen.css';
import './browser.css';

export function BrowserSessionChip({ session }: { session: BrowserSessionView | null }) {
  const c = session
    ? SESSION_CHIP[session.state]
    : { text: 'Not open', icon: 'slash' as const, tone: null };
  return (
    <span className="nv-chip" data-status={c.tone ?? undefined}>
      <Icon name={c.icon} />
      <span>{c.text}</span>
    </span>
  );
}

export function BrowserPanel({ computerId }: { computerId: string }) {
  const api = useBrowserApi();
  const hasCapture = useHasBrowserCapture();
  const screenApi = useScreenApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [session, setSession] = useState<BrowserSessionView | null>(null);
  const [status, setStatus] = useState<BrowserStatusView | null>(null);
  const [takeover, setTakeover] = useState<ScreenTakeoverView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [nonce, setNonce] = useState(1);
  const [frameFailed, setFrameFailed] = useState<number | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.listBrowserSessions(),
      api.browserStatus(),
      // A computer the screen area does not know has no takeover.
      screenApi.getTakeover(computerId).catch(() => ({ takeover: null })),
    ]).then(
      ([{ items }, st, t]) => {
        if (!alive) return;
        setSession(items.find((s) => s.computerId === computerId) ?? null);
        setStatus(st);
        setTakeover(t.takeover);
        setLoaded(true);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the agent browser.')),
    );
    return () => {
      alive = false;
    };
  }, [api, screenApi, computerId, attempt]);

  const reload = useDebounced(() => {
    setAttempt((n) => n + 1);
    setNonce((n) => n + 1);
  }, 400);
  useHubEvents(BROWSER_PAGE_EVENTS, (env) => {
    if (eventComputerId(env) === computerId) reload();
  });

  const close = async () => {
    setConfirmClose(false);
    setBusy(true);
    try {
      await api.closeBrowserSession(computerId);
      setSession(null);
      announce('The agent browser is closed.');
      toast.show('Browser closed.', { tone: 'success' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setSession(null);
        toast.show('The browser was already closed.');
      } else toast.show(`Could not close the browser: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const takeOver = async () => {
    setBusy(true);
    try {
      setTakeover(await screenApi.startTakeover(computerId, 'browser'));
      announce('You have the agent browser. The agent waits until you return control.');
    } catch (err) {
      toast.show(`Could not take over the browser: ${sentence(errorMessage(err))}`, {
        tone: 'error',
      });
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const giveBack = async () => {
    setBusy(true);
    try {
      await screenApi.endTakeover(computerId);
      setTakeover(null);
      setNonce((n) => n + 1);
      announce('Control returned. The agent continues in the browser.');
      toast.show('Control returned to the agent.', { tone: 'success' });
    } catch (err) {
      toast.show(`Could not return control: ${sentence(errorMessage(err))}`, { tone: 'error' });
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const heading = (
    <header className="ws-section-header">
      <h2 id={headingId}>Browser</h2>
      {loaded ? <BrowserSessionChip session={session} /> : null}
    </header>
  );

  if (error)
    return (
      <section className="brw-panel" aria-labelledby={headingId}>
        {heading}
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      </section>
    );
  if (!loaded)
    return (
      <section className="brw-panel" aria-labelledby={headingId}>
        {heading}
        <Spinner label="Loading the agent browser" />
      </section>
    );

  const browserTakeover = takeover?.surface === 'browser';
  const desktopTakeover = takeover?.surface === 'desktop';

  return (
    <section className="brw-panel" aria-labelledby={headingId}>
      {heading}
      <PendingSignins computerId={computerId} />
      {session ? (
        <>
          <div className="brw-page">
            {/* The page's title and address are untrusted text from the web. */}
            <p className="brw-title">{session.title || 'Untitled page'}</p>
            {session.url ? <p className="muted brw-url">{session.url}</p> : null}
            <p className="muted ws-row-meta">
              {session.pausedBy ? (
                <span>{session.pausedBy === 'user' ? 'Paused: you have the page' : 'Paused'}</span>
              ) : null}
              <span>
                {session.persistCookies
                  ? 'Keeps its cookies between sessions'
                  : 'Cookies are cleared when it closes'}
              </span>
              <span>Last action {formatWhen(session.lastActionAt)}</span>
              {session.restarts > 0 ? (
                <span>
                  Restarted after a crash{' '}
                  {session.restarts === 1 ? 'once' : `${session.restarts} times`}
                </span>
              ) : null}
            </p>
            {session.crash ? (
              <p className="ws-warning brw-crash" role="status">
                <Icon name="alert" />
                <span>
                  The browser crashed {formatWhen(session.crash.at)}:{' '}
                  {sentence(session.crash.reason)} It restarts on the agent’s next action and
                  reopens the page if the site is still allowed. Steps on page elements are not
                  repeated.
                </span>
              </p>
            ) : null}
            {session.pageTools.length ? (
              <div className="brw-page-tools">
                <p className="ws-flush">
                  This page offers tools to the agent. Each call is checked like any change on the
                  site, and what they return is treated as untrusted.
                </p>
                <ul className="ws-plain-list" aria-label="Tools from this page">
                  {session.pageTools.map((t) => (
                    <li key={t}>
                      <code>{t}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          {browserTakeover ? (
            <div className="scr-banner" data-tone="user" role="group" aria-label="Takeover">
              <Icon name="hand" />
              <p>
                <strong>You have the agent browser.</strong> The agent waits until you return
                control.
              </p>
              <Button variant="primary" onClick={() => void giveBack()} disabled={busy}>
                Return control
              </Button>
            </div>
          ) : null}
          {browserTakeover ? (
            <LiveView key="browser-control" computerId={computerId} surface="browser" control />
          ) : (
            <figure className="brw-frame">
              {frameFailed === nonce ? (
                <p className="muted">The page cannot be shown right now.</p>
              ) : (
                <img
                  src={screenApi.screenFrameUrl(computerId, 'browser', nonce)}
                  alt={`The agent browser showing ${session.title || 'a page'}`}
                  onError={() => setFrameFailed(nonce)}
                />
              )}
              <figcaption className="row">
                <Button variant="ghost" onClick={() => setNonce((n) => n + 1)}>
                  <Icon name="refresh" /> Refresh view
                </Button>
              </figcaption>
            </figure>
          )}
          <div className="row">
            {!takeover ? (
              <Button variant="primary" onClick={() => void takeOver()} disabled={busy}>
                <Icon name="hand" /> Take over the browser
              </Button>
            ) : null}
            {desktopTakeover ? (
              <p className="muted">
                You have this computer’s desktop. Return control there to take over the browser.
              </p>
            ) : null}
            <Button variant="ghost" onClick={() => setConfirmClose(true)} disabled={busy}>
              <Icon name="close" /> Close browser
            </Button>
          </div>
        </>
      ) : (
        <EmptyState
          level={3}
          icon="external"
          title="The browser is not open"
          description={
            status && !status.available
              ? `The agent browser cannot run on this Hub: ${sentence(status.detail)}`
              : 'It opens when an agent uses the browser on this computer.'
          }
        />
      )}
      {session && hasCapture ? <PageCapture computerId={computerId} /> : null}
      <BrowserTrace computerId={computerId} />
      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="Close the agent browser?"
        description={
          session?.persistCookies
            ? 'The open page closes. Its cookies are kept, so sign-ins last until they expire.'
            : 'The open page closes and its cookies are cleared, so the agent must sign in again.'
        }
        footer={
          <>
            <Button onClick={() => setConfirmClose(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => void close()}>
              Close browser
            </Button>
          </>
        }
      />
    </section>
  );
}
