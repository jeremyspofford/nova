// The agent browser of one computer (FR-092, FR-096, FR-098, FR-086, FR-087, FR-208, FR-194;
// docs/11 §4, §10): the open page (title, address, session state, the tools the page registered),
// a crash and how often it restarted, its latest frame from the Hub, pending private sign-ins, what
// the page logged (console and network), the recorded actions with before/after screenshots,
// taking over the page (the agent waits until control is returned) and closing the session. Page
// titles and addresses come from the web: shown as text, never as links or HTML. Mounted on a
// computer's page. M7.5 (FR-209): a note says when the agent works on a connected computer's
// browser (the local fallback).
import { useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { BrowserSessionView, BrowserStatusView, ScreenTakeoverView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { FallbackSessionNote } from '../browserdevice/FallbackTrace.tsx';
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
import { BROWSER_TEXT, sessionChip } from './format.ts';
import { PendingSignins } from './PendingSignins.tsx';
import '../workspace.css';
import '../screen/screen.css';
import './browser.css';

/** A computer's agent browser. Page titles, addresses and the Hub's reasons are data. */
export const PANEL_TEXT = defineMessages('browser.panel', {
  loadFailed: 'Could not load the agent browser.',
  closed: 'The agent browser is closed.',
  closedToast: 'Browser closed.',
  alreadyClosed: 'The browser was already closed.',
  /** Toasts; {reason} is the Hub's own words (English, D9). */
  closeFailed: 'Could not close the browser: {reason}',
  takeoverAnnounce: 'You have the agent browser. The agent waits until you return control.',
  takeoverFailed: 'Could not take over the browser: {reason}',
  returnedAnnounce: 'Control returned. The agent continues in the browser.',
  returnedToast: 'Control returned to the agent.',
  returnFailed: 'Could not return control: {reason}',
  heading: 'Browser',
  loading: 'Loading the agent browser',
  untitled: 'Untitled page',
  pausedByYou: 'Paused: you have the page',
  paused: 'Paused',
  keepsCookies: 'Keeps its cookies between sessions',
  clearsCookies: 'Cookies are cleared when it closes',
  /** {when} is a time, such as "5 minutes ago". */
  lastAction: 'Last action {when}',
  restarts:
    '{n, plural, one {Restarted after a crash once} other {Restarted after a crash # times}}',
  /** {reason} is the crash reason as the browser reported it (English). */
  crashed:
    'The browser crashed {when}: {reason} It restarts on the agent’s next action and reopens the page if the site is still allowed. Steps on page elements are not repeated.',
  pageTools:
    'This page offers tools to the agent. Each call is checked like any change on the site, and what they return is treated as untrusted.',
  pageToolsList: 'Tools from this page',
  takeover: 'Takeover',
  youHaveIt: 'You have the agent browser.',
  agentWaits: 'The agent waits until you return control.',
  returnControl: 'Return control',
  cannotShow: 'The page cannot be shown right now.',
  /** The live frame's text alternative; {title} is the page's title. */
  frameAlt: 'The agent browser showing {title}',
  frameAltNoTitle: 'The agent browser showing a page',
  refreshView: 'Refresh view',
  takeOver: 'Take over the browser',
  desktopTakeover:
    'You have this computer’s desktop. Return control there to take over the browser.',
  close: 'Close browser',
  notOpen: 'The browser is not open',
  /** {reason} is the Hub's own words (English, D9). */
  unavailable: 'The agent browser cannot run on this Hub: {reason}',
  opensWhenUsed: 'It opens when an agent uses the browser on this computer.',
  closeTitle: 'Close the agent browser?',
  closeKeeps: 'The open page closes. Its cookies are kept, so sign-ins last until they expire.',
  closeClears: 'The open page closes and its cookies are cleared, so the agent must sign in again.',
});

export function BrowserSessionChip({ session }: { session: BrowserSessionView | null }) {
  const c = sessionChip(session ? session.state : null);
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
      (err: unknown) => alive && setError(errorMessage(err, PANEL_TEXT.loadFailed)),
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

  const S = PANEL_TEXT;
  const close = async () => {
    setConfirmClose(false);
    setBusy(true);
    try {
      await api.closeBrowserSession(computerId);
      setSession(null);
      announce(S.closed);
      toast.show(S.closedToast, { tone: 'success' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setSession(null);
        toast.show(S.alreadyClosed);
      } else toast.show(S.closeFailed({ reason: errorMessage(err) }), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const takeOver = async () => {
    setBusy(true);
    try {
      setTakeover(await screenApi.startTakeover(computerId, 'browser'));
      announce(S.takeoverAnnounce);
    } catch (err) {
      toast.show(S.takeoverFailed({ reason: sentence(errorMessage(err)) }), { tone: 'error' });
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
      announce(S.returnedAnnounce);
      toast.show(S.returnedToast, { tone: 'success' });
    } catch (err) {
      toast.show(S.returnFailed({ reason: sentence(errorMessage(err)) }), { tone: 'error' });
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const heading = (
    <header className="ws-section-header">
      <h2 id={headingId}>{S.heading}</h2>
      {loaded ? <BrowserSessionChip session={session} /> : null}
    </header>
  );

  if (error)
    return (
      <section className="brw-panel" aria-labelledby={headingId}>
        {heading}
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{BROWSER_TEXT.retry}</Button>
        </div>
      </section>
    );
  if (!loaded)
    return (
      <section className="brw-panel" aria-labelledby={headingId}>
        {heading}
        <Spinner label={S.loading} />
      </section>
    );

  const browserTakeover = takeover?.surface === 'browser';
  const desktopTakeover = takeover?.surface === 'desktop';

  return (
    <section className="brw-panel" aria-labelledby={headingId}>
      {heading}
      {/* M7.5 (FR-209): while the agent works on a connected computer's browser. */}
      <FallbackSessionNote computerId={computerId} />
      <PendingSignins computerId={computerId} />
      {session ? (
        <>
          <div className="brw-page">
            {/* The page's title and address are untrusted text from the web. */}
            <p className="brw-title" dir="auto">
              {session.title || S.untitled}
            </p>
            {session.url ? (
              <p className="muted brw-url" dir="ltr">
                {session.url}
              </p>
            ) : null}
            <p className="muted ws-row-meta">
              {session.pausedBy ? (
                <span>{session.pausedBy === 'user' ? S.pausedByYou : S.paused}</span>
              ) : null}
              <span>{session.persistCookies ? S.keepsCookies : S.clearsCookies}</span>
              <span>{S.lastAction({ when: formatWhen(session.lastActionAt) })}</span>
              {session.restarts > 0 ? <span>{S.restarts({ n: session.restarts })}</span> : null}
            </p>
            {session.crash ? (
              <p className="ws-warning brw-crash" role="status">
                <Icon name="alert" />
                <span>
                  {S.crashed({
                    when: formatWhen(session.crash.at),
                    reason: sentence(session.crash.reason),
                  })}
                </span>
              </p>
            ) : null}
            {session.pageTools.length ? (
              <div className="brw-page-tools">
                <p className="ws-flush">{S.pageTools}</p>
                <ul className="ws-plain-list" aria-label={S.pageToolsList}>
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
            <div className="scr-banner" data-tone="user" role="group" aria-label={S.takeover}>
              <Icon name="hand" />
              <p>
                <strong>{S.youHaveIt}</strong> {S.agentWaits}
              </p>
              <Button variant="primary" onClick={() => void giveBack()} disabled={busy}>
                {S.returnControl}
              </Button>
            </div>
          ) : null}
          {browserTakeover ? (
            <LiveView key="browser-control" computerId={computerId} surface="browser" control />
          ) : (
            <figure className="brw-frame">
              {frameFailed === nonce ? (
                <p className="muted">{S.cannotShow}</p>
              ) : (
                <img
                  src={screenApi.screenFrameUrl(computerId, 'browser', nonce)}
                  alt={session.title ? S.frameAlt({ title: session.title }) : S.frameAltNoTitle}
                  onError={() => setFrameFailed(nonce)}
                />
              )}
              <figcaption className="row">
                <Button variant="ghost" onClick={() => setNonce((n) => n + 1)}>
                  <Icon name="refresh" /> {S.refreshView}
                </Button>
              </figcaption>
            </figure>
          )}
          <div className="row">
            {!takeover ? (
              <Button variant="primary" onClick={() => void takeOver()} disabled={busy}>
                <Icon name="hand" /> {S.takeOver}
              </Button>
            ) : null}
            {desktopTakeover ? <p className="muted">{S.desktopTakeover}</p> : null}
            <Button variant="ghost" onClick={() => setConfirmClose(true)} disabled={busy}>
              <Icon name="close" /> {S.close}
            </Button>
          </div>
        </>
      ) : (
        <EmptyState
          level={3}
          icon="external"
          title={S.notOpen}
          description={
            status && !status.available
              ? S.unavailable({ reason: sentence(status.detail) })
              : S.opensWhenUsed
          }
        />
      )}
      {session && hasCapture ? <PageCapture computerId={computerId} /> : null}
      <BrowserTrace computerId={computerId} />
      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title={S.closeTitle}
        description={session?.persistCookies ? S.closeKeeps : S.closeClears}
        footer={
          <>
            <Button onClick={() => setConfirmClose(false)}>{BROWSER_TEXT.cancel}</Button>
            <Button variant="danger" onClick={() => void close()}>
              {S.close}
            </Button>
          </>
        }
      />
    </section>
  );
}
