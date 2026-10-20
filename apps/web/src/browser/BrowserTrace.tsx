// The agent browser's recorded actions on a computer (FR-098, FR-095, FR-194; docs/11 §4, §9, §10),
// newest first as the Hub returns them, a page at a time (`nextCursor` continues the list): what
// was done, on which site, the result, why a write was flagged or refused, and the before/after
// screenshots. Crash and restart rows say what happened to the browser itself. Refusals because a
// page came from an external AI agent are called out above the list, and finished downloads are
// listed with where they went. Targets, URLs and errors are page-derived text: shown as text,
// never as links or HTML. M7.5 (FR-209): a row recorded on a connected computer's browser (the
// local fallback) is marked with that computer and the profile.
import { useEffect, useId, useRef, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { BrowserActionView } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { FallbackMark, useFallbackDeviceNames } from '../browserdevice/FallbackTrace.tsx';
import { fallbackMarkOf, whereText } from '../browserdevice/format.ts';
import { rich } from '../i18n/rich.tsx';
import { timeOf } from '../screen/format.ts';
import { useDebounced } from '../work/events.ts';
import { useBrowserApi } from './api.ts';
import { eventComputerId, useHubEvents } from './events.ts';
import {
  BROWSER_TEXT,
  actionChip,
  browserActionText,
  externalAgentName,
  isDownload,
  isExternalAgentNotice,
  isLifecycle,
} from './format.ts';

/**
 * The browser's recorded actions. Targets, sites, addresses, agent names and the Hub's reasons
 * are data from the page or the Hub.
 */
export const TRACE_TEXT = defineMessages('browser.trace', {
  loadFailed: 'Could not load the browser actions.',
  olderFailed: 'Could not load older actions.',
  heading: 'Browser actions',
  loading: 'Loading browser actions',
  externalTitle: 'Pages written by another AI agent.',
  externalBody:
    'Their requests are not tasks from you, so Nova did not act on them or send them anything.',
  externalList: 'Refused for an external agent',
  /** A refused step: "12:00 PM: Click on shop.example.com". {site} is missing for a page without one. */
  refused: '{onSite, select, yes {{time}: {action} on {site}} other {{time}: {action} on a page}}',
  /** As `refused`, with the name the page gave the other agent. */
  refusedFrom:
    '{onSite, select, yes {{time}: {action} on {site} (from “{name}”)} other {{time}: {action} on a page (from “{name}”)}}',
  downloads: 'Downloads',
  downloadsHint: 'Saved in this computer’s files, in the Downloads folder.',
  /** A finished download: what, from which site, when. */
  download:
    '{onSite, select, yes {{file} from {site} at {time}} other {{file} from a page at {time}}}',
  aFile: 'A file',
  empty:
    'Nothing done in this browser yet. Every page the agent opens and every click or entry is recorded here with screenshots.',
  /** A step's title: what the agent did, what on and on which site (each part may be missing). */
  title: {
    target: '{action} {target}',
    host: '{action} on {host}',
    both: '{action} {target} on {host}',
    /** A crash or restart row with its detail. */
    life: '{action} ({target})',
    lifeHost: '{action} ({target}) on {host}',
  },
  flagged: 'Flagged',
  where: 'Where',
  page: 'Page',
  why: 'Why',
  safety: 'Safety check',
  yourStep: 'Your step',
  needsYou: 'This step needs you (for example a CAPTCHA or a code).',
  approval: 'Approval',
  askedFirst: 'Asked you first',
  time: 'Time',
  /** A screenshot's text alternative: "Before: Click". */
  beforeAlt: 'Before: {action}',
  afterAlt: 'After: {action}',
  before: 'Before',
  after: 'After',
  noShots: 'No screenshots: none were taken, or they are past the retention.',
  older: 'Show older',
});

/** A step's title line: the action, its target and its site in the order the locale wants. */
function StepTitle({ a, label, life }: { a: BrowserActionView; label: string; life: boolean }) {
  const T = TRACE_TEXT.title;
  const target = a.target ? (
    <span className="muted" dir="auto">
      {a.target}
    </span>
  ) : null;
  const host = a.host ? (
    <span className="muted" dir="ltr">
      {a.host}
    </span>
  ) : null;
  if (target && life)
    return host
      ? rich(T.lifeHost, { action: label, target, host })
      : rich(T.life, { action: label, target });
  if (target && host) return rich(T.both, { action: label, target, host });
  if (target) return rich(T.target, { action: label, target });
  if (host) return rich(T.host, { action: label, host });
  return label;
}

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
      (err: unknown) => alive && setError(errorMessage(err, TRACE_TEXT.loadFailed)),
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
      setOlderError(errorMessage(err, TRACE_TEXT.olderFailed));
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
  const S = TRACE_TEXT;

  return (
    <section className="ws-section brw-trace" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>{S.heading}</h3>
        <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
          <Icon name="refresh" /> {BROWSER_TEXT.refresh}
        </Button>
      </div>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{BROWSER_TEXT.retry}</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={S.loading} /> : null}
      {external.length ? (
        <div className="ws-callout brw-external" role="note">
          <Icon name="shield" />
          <div>
            <p>
              <strong>{S.externalTitle}</strong> {S.externalBody}
            </p>
            <ul className="ws-plain-list" aria-label={S.externalList}>
              {external.map((a) => {
                const name = externalAgentName(a.error);
                const p = {
                  onSite: a.host ? 'yes' : 'no',
                  time: timeOf(a.createdAt),
                  action: browserActionText(a),
                  site: a.host ?? '',
                };
                return <li key={a.id}>{name ? S.refusedFrom({ ...p, name }) : S.refused(p)}</li>;
              })}
            </ul>
          </div>
        </div>
      ) : null}
      {downloads.length ? (
        <div className="brw-downloads">
          <h4 className="ws-subhead">{S.downloads}</h4>
          <p className="muted ws-flush">{S.downloadsHint}</p>
          <ul className="ws-plain-list" aria-label={S.downloads}>
            {downloads.map((a) => (
              <li key={a.id}>
                {S.download({
                  onSite: a.host ? 'yes' : 'no',
                  file: a.target ?? S.aFile,
                  site: a.host ?? '',
                  time: timeOf(a.createdAt),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {items?.length === 0 ? <p className="muted">{S.empty}</p> : null}
      {items?.length ? (
        <ol className="activity-list brw-trace-list" aria-label={S.heading}>
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
                    <StepTitle a={a} label={label} life={life} />
                  </span>
                  {a.classification?.flagged ? (
                    <span className="ws-badge" data-tone="warn">
                      <Icon name="alert" /> {S.flagged}
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
                          <dt>{S.where}</dt>
                          <dd>{whereText(mark, deviceName)}</dd>
                        </>
                      ) : null}
                      {a.url ? (
                        <>
                          <dt>{S.page}</dt>
                          <dd className="brw-url" dir="ltr">
                            {a.url}
                          </dd>
                        </>
                      ) : null}
                      {a.error ? (
                        <>
                          <dt>{S.why}</dt>
                          <dd>{a.error}</dd>
                        </>
                      ) : null}
                      {a.classification?.reasons.length ? (
                        <>
                          <dt>{S.safety}</dt>
                          <dd>{a.classification.reasons.join('; ')}</dd>
                        </>
                      ) : null}
                      {a.classification?.handoff ? (
                        <>
                          <dt>{S.yourStep}</dt>
                          <dd>{S.needsYou}</dd>
                        </>
                      ) : null}
                      {a.approvalId ? (
                        <>
                          <dt>{S.approval}</dt>
                          <dd>{S.askedFirst}</dd>
                        </>
                      ) : null}
                      <dt>{S.time}</dt>
                      <dd>
                        {fmt.dateTime(a.createdAt, { dateStyle: 'medium', timeStyle: 'medium' })}
                      </dd>
                    </dl>
                    {a.before || a.after ? (
                      <div className="scr-shots">
                        {a.before ? (
                          <figure>
                            <img
                              src={api.browserShotUrl(a.id, 'before')}
                              alt={S.beforeAlt({ action: label })}
                              loading="lazy"
                            />
                            <figcaption>{S.before}</figcaption>
                          </figure>
                        ) : null}
                        {a.after ? (
                          <figure>
                            <img
                              src={api.browserShotUrl(a.id, 'after')}
                              alt={S.afterAlt({ action: label })}
                              loading="lazy"
                            />
                            <figcaption>{S.after}</figcaption>
                          </figure>
                        ) : null}
                      </div>
                    ) : (
                      <p className="muted ws-flush">{S.noShots}</p>
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
          <Button onClick={() => void showOlder()}>{BROWSER_TEXT.retry}</Button>
        </div>
      ) : null}
      {items && cursor ? (
        <div className="row">
          <Button onClick={() => void showOlder()} disabled={loadingOlder}>
            {loadingOlder ? <Spinner /> : null} {S.older}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
