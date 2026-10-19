// The agent browser's recorded actions on a computer (FR-098, FR-095, FR-194; docs/11 §4, §9, §10),
// newest first as the Hub returns them, a page at a time (`nextCursor` continues the list): what
// was done, on which site, the result, why a write was flagged or refused, and the before/after
// screenshots. Crash and restart rows say what happened to the browser itself. Refusals because a
// page came from an external AI agent are called out above the list, and finished downloads are
// listed with where they went. Targets, URLs and errors are page-derived text: shown as text,
// never as links or HTML. M7.5 (FR-209): a row recorded on a connected computer's browser (the
// local fallback) is marked with that computer and the profile.
import { useEffect, useId, useRef, useState } from 'react';
import type { BrowserActionView } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { FallbackMark, useFallbackDeviceNames } from '../browserdevice/FallbackTrace.tsx';
import { fallbackMarkOf, whereText } from '../browserdevice/format.ts';
import { timeOf } from '../screen/format.ts';
import { useDebounced } from '../work/events.ts';
import { useBrowserApi } from './api.ts';
import { eventComputerId, useHubEvents } from './events.ts';
import {
  actionChip,
  browserActionText,
  externalAgentName,
  isDownload,
  isExternalAgentNotice,
  isLifecycle,
} from './format.ts';

/** The Hub answers at most this many per page. */
export const BROWSER_TRACE_LIMIT = 500;
/** Actions per page: the first load and each "Show older". */
export const BROWSER_TRACE_PAGE = 30;

/** `older` appended after `list`, without the ones already there. */
function appendOlder(list: BrowserActionView[], older: BrowserActionView[]): BrowserActionView[] {
  const seen = new Set(list.map((a) => a.id));
  return [...list, ...older.filter((a) => !seen.has(a.id))];
}

export function BrowserTrace({ computerId }: { computerId: string }) {
  const api = useBrowserApi();
  const headingId = useId();
  const [items, setItems] = useState<BrowserActionView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // A refresh reloads as many as are shown, so older pages stay open.
  const loaded = useRef(BROWSER_TRACE_PAGE);
  const deviceNames = useFallbackDeviceNames();

  useEffect(() => {
    let alive = true;
    const limit = Math.min(BROWSER_TRACE_LIMIT, Math.max(BROWSER_TRACE_PAGE, loaded.current));
    api.listBrowserActions({ computerId, limit }).then(
      (page) => {
        if (!alive) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        loaded.current = Math.max(BROWSER_TRACE_PAGE, page.items.length);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the browser actions.')),
    );
    return () => {
      alive = false;
    };
  }, [api, computerId, attempt]);

  const showOlder = async () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await api.listBrowserActions({
        computerId,
        limit: BROWSER_TRACE_PAGE,
        cursor,
      });
      setItems((list) => {
        const next = appendOlder(list ?? [], page.items);
        loaded.current = next.length;
        return next;
      });
      setCursor(page.nextCursor);
    } catch (err) {
      setOlderError(errorMessage(err, 'Could not load older actions.'));
    } finally {
      setLoadingOlder(false);
    }
  };

  const reload = useDebounced(() => setAttempt((n) => n + 1), 300);
  useHubEvents(['browser.action'], (env) => {
    if (eventComputerId(env) === computerId) reload();
  });

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const external = (items ?? []).filter(isExternalAgentNotice);
  const downloads = (items ?? []).filter(isDownload);

  return (
    <section className="ws-section brw-trace" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>Browser actions</h3>
        <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
          <Icon name="refresh" /> Refresh
        </Button>
      </div>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label="Loading browser actions" /> : null}
      {external.length ? (
        <div className="ws-callout brw-external" role="note">
          <Icon name="shield" />
          <div>
            <p>
              <strong>Pages written by another AI agent.</strong> Their requests are not tasks from
              you, so Nova did not act on them or send them anything.
            </p>
            <ul className="ws-plain-list" aria-label="Refused for an external agent">
              {external.map((a) => {
                const name = externalAgentName(a.error);
                return (
                  <li key={a.id}>
                    {timeOf(a.createdAt)}: {browserActionText(a)} on {a.host ?? 'a page'}
                    {name ? ` (from “${name}”)` : ''}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
      {downloads.length ? (
        <div className="brw-downloads">
          <h4 className="ws-subhead">Downloads</h4>
          <p className="muted ws-flush">Saved in this computer’s files, in the Downloads folder.</p>
          <ul className="ws-plain-list" aria-label="Downloads">
            {downloads.map((a) => (
              <li key={a.id}>
                {a.target ?? 'A file'} from {a.host ?? 'a page'} at {timeOf(a.createdAt)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {items?.length === 0 ? (
        <p className="muted">
          Nothing done in this browser yet. Every page the agent opens and every click or entry is
          recorded here with screenshots.
        </p>
      ) : null}
      {items?.length ? (
        <ol className="activity-list brw-trace-list" aria-label="Browser actions">
          {items.map((a) => {
            const chip = actionChip(a);
            const label = browserActionText(a);
            const expanded = open.has(a.id);
            const life = isLifecycle(a);
            const mark = fallbackMarkOf(a);
            const deviceName = mark ? (deviceNames.get(mark.deviceId) ?? null) : null;
            return (
              <li
                key={a.id}
                className="activity-item"
                data-result={a.result}
                data-kind={life ? 'lifecycle' : undefined}
                data-local-fallback={mark ? mark.profile : undefined}
              >
                <button
                  type="button"
                  className="scr-trace-step"
                  aria-expanded={expanded}
                  onClick={() => toggle(a.id)}
                >
                  <span className="activity-title">
                    {life ? <Icon name={a.tool === 'browser.crash' ? 'stop' : 'refresh'} /> : null}
                    {label}
                    {a.target ? (
                      <span className="muted"> {life ? `(${a.target})` : a.target}</span>
                    ) : null}
                    {a.host ? <span className="muted"> on {a.host}</span> : null}
                  </span>
                  {a.classification?.flagged ? (
                    <span className="ws-badge" data-tone="warn">
                      <Icon name="alert" /> Flagged
                    </span>
                  ) : null}
                  {mark ? <FallbackMark mark={mark} deviceName={deviceName} /> : null}
                  <span className="nv-chip" data-status={chip.tone ?? undefined}>
                    <Icon name={chip.icon} />
                    <span>{chip.text}</span>
                  </span>
                  <time className="muted activity-time" dateTime={a.createdAt}>
                    {timeOf(a.createdAt)}
                  </time>
                </button>
                {expanded ? (
                  <div className="scr-trace-detail">
                    <dl className="ws-dl">
                      {mark ? (
                        <>
                          <dt>Where</dt>
                          <dd>{whereText(mark, deviceName)}</dd>
                        </>
                      ) : null}
                      {a.url ? (
                        <>
                          <dt>Page</dt>
                          <dd className="brw-url">{a.url}</dd>
                        </>
                      ) : null}
                      {a.error ? (
                        <>
                          <dt>Why</dt>
                          <dd>{a.error}</dd>
                        </>
                      ) : null}
                      {a.classification?.reasons.length ? (
                        <>
                          <dt>Safety check</dt>
                          <dd>{a.classification.reasons.join('; ')}</dd>
                        </>
                      ) : null}
                      {a.classification?.handoff ? (
                        <>
                          <dt>Your step</dt>
                          <dd>This step needs you (for example a CAPTCHA or a code).</dd>
                        </>
                      ) : null}
                      {a.approvalId ? (
                        <>
                          <dt>Approval</dt>
                          <dd>Asked you first</dd>
                        </>
                      ) : null}
                      <dt>Time</dt>
                      <dd>{new Date(a.createdAt).toLocaleString()}</dd>
                    </dl>
                    {a.before || a.after ? (
                      <div className="scr-shots">
                        {a.before ? (
                          <figure>
                            <img
                              src={api.browserShotUrl(a.id, 'before')}
                              alt={`Before: ${label}`}
                              loading="lazy"
                            />
                            <figcaption>Before</figcaption>
                          </figure>
                        ) : null}
                        {a.after ? (
                          <figure>
                            <img
                              src={api.browserShotUrl(a.id, 'after')}
                              alt={`After: ${label}`}
                              loading="lazy"
                            />
                            <figcaption>After</figcaption>
                          </figure>
                        ) : null}
                      </div>
                    ) : (
                      <p className="muted ws-flush">
                        No screenshots: none were taken, or they are past the retention.
                      </p>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {olderError ? (
        <div className="ws-error" role="alert">
          <p>{olderError}</p>
          <Button onClick={() => void showOlder()}>Retry</Button>
        </div>
      ) : null}
      {items && cursor ? (
        <div className="row">
          <Button onClick={() => void showOlder()} disabled={loadingOlder}>
            {loadingOlder ? <Spinner /> : null} Show older
          </Button>
        </div>
      ) : null}
    </section>
  );
}
