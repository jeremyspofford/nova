// The recorded screen actions of a computer (FR-098; docs/11 §5): every input Nova sent or tried
// to send, and the user's own input during a takeover, newest first, with the before and after
// screenshots the Hub kept. Typed text is shown only as its length. Screenshots past the retention
// are gone; the row stays.
import { useCallback, useEffect, useId, useState } from 'react';
import type { ScreenActionView } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { defineMessages, fmt } from '@nova/i18n';
import { errorMessage } from '../api.ts';
import { rich } from '../i18n/rich.tsx';
import { useDebounced } from '../work/events.ts';
import { useScreenApi } from './api.ts';
import { eventComputerId, useHubEvents } from './events.ts';
import {
  ACTION_STATUS,
  TIER_TEXT,
  actorText,
  screenActionText,
  sentence,
  timeOf,
} from './format.ts';

export const SCREEN_ACTIONS_PAGE = 50;

export const ACTIONS_TEXT = defineMessages('screen.actions', {
  title: 'Screen actions',
  loadFailed: 'Could not load the screen actions.',
  olderFailed: 'Could not load older actions.',
  refresh: 'Refresh',
  retry: 'Retry',
  loading: 'Loading screen actions',
  empty:
    'No screen actions yet. Each click, keystroke or scroll Nova sends is recorded here with a screenshot before and after.',
  /** An action and the app it was in: "Click at (120, 40) in Spreadsheet". */
  inApp: '{step} in {app}',
  who: 'Who',
  window: 'Window',
  level: 'Level',
  why: 'Why',
  time: 'Time',
  before: 'Before',
  after: 'After',
  beforeAlt: 'Before: {step}',
  afterAlt: 'After: {step}',
  noShotsRefused: 'Nothing was sent, so there are no screenshots.',
  noShots: 'No screenshots: they were not taken or are past the retention.',
  older: 'Show older',
});
const S = ACTIONS_TEXT;

/** A recorded action's full date and time (what `toLocaleString()` showed). */
function fullTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : fmt.dateTime(d, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      });
}

const newestFirst = (a: ScreenActionView, b: ScreenActionView) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

export function ScreenActions({ computerId }: { computerId: string }) {
  const api = useScreenApi();
  const headingId = useId();
  const [items, setItems] = useState<ScreenActionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  // The newest page; merged into what is shown, so older pages stay.
  useEffect(() => {
    let alive = true;
    api.listScreenActions(computerId, { limit: SCREEN_ACTIONS_PAGE }).then(
      ({ items: fresh }) => {
        if (!alive) return;
        setItems((old) => {
          const ids = new Set(fresh.map((a) => a.id));
          return [...fresh, ...(old ?? []).filter((a) => !ids.has(a.id))].sort(newestFirst);
        });
        setMore((m) => m || fresh.length >= SCREEN_ACTIONS_PAGE);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, computerId, attempt]);

  const reload = useDebounced(() => setAttempt((n) => n + 1), 200);
  useHubEvents(['screen.action'], (env) => {
    if (eventComputerId(env) === computerId) reload();
  });

  const older = useCallback(async () => {
    const last = items?.at(-1);
    if (!last) return;
    setLoadingMore(true);
    try {
      const { items: page } = await api.listScreenActions(computerId, {
        limit: SCREEN_ACTIONS_PAGE,
        before: last.id,
      });
      setItems((old) => {
        const ids = new Set((old ?? []).map((a) => a.id));
        return [...(old ?? []), ...page.filter((a) => !ids.has(a.id))].sort(newestFirst);
      });
      setMore(page.length >= SCREEN_ACTIONS_PAGE);
    } catch (err) {
      setError(errorMessage(err, S.olderFailed));
    } finally {
      setLoadingMore(false);
    }
  }, [api, computerId, items]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="ws-section scr-actions" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>{S.title}</h3>
        <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
          <Icon name="refresh" /> {S.refresh}
        </Button>
      </div>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? <p className="muted">{S.empty}</p> : null}
      {items?.length ? (
        <ol className="activity-list scr-trace" aria-label={S.title}>
          {items.map((a) => {
            const st = ACTION_STATUS[a.status];
            const label = screenActionText(a);
            const expanded = open.has(a.id);
            return (
              <li key={a.id} className="activity-item" data-status={a.status}>
                <button
                  type="button"
                  className="scr-trace-step"
                  aria-expanded={expanded}
                  onClick={() => toggle(a.id)}
                >
                  <span className="activity-title">
                    {a.app
                      ? rich(S.inApp, {
                          step: label,
                          app: (
                            <span className="muted" dir="auto">
                              {a.app}
                            </span>
                          ),
                        })
                      : label}
                  </span>
                  <span className="nv-chip" data-status={st.tone}>
                    <Icon name={st.icon} />
                    <span>{st.text}</span>
                  </span>
                  <span className="muted">{actorText(a.actor, a.origin)}</span>
                  <time className="muted activity-time" dateTime={a.createdAt}>
                    {timeOf(a.createdAt)}
                  </time>
                </button>
                {expanded ? (
                  <div className="scr-trace-detail">
                    <dl className="ws-dl">
                      <dt>{S.who}</dt>
                      <dd>{actorText(a.actor, a.origin)}</dd>
                      {a.windowTitle ? (
                        <>
                          <dt>{S.window}</dt>
                          <dd dir="auto">{a.windowTitle}</dd>
                        </>
                      ) : null}
                      {a.tier ? (
                        <>
                          <dt>{S.level}</dt>
                          <dd>{TIER_TEXT[a.tier]}</dd>
                        </>
                      ) : null}
                      {a.error ? (
                        <>
                          <dt>{S.why}</dt>
                          <dd>{sentence(a.error.message)}</dd>
                        </>
                      ) : null}
                      <dt>{S.time}</dt>
                      <dd>{fullTime(a.createdAt)}</dd>
                    </dl>
                    {a.hasBefore || a.hasAfter ? (
                      <div className="scr-shots">
                        {a.hasBefore ? (
                          <figure>
                            <img
                              src={api.screenShotUrl(computerId, a.id, 'before')}
                              alt={S.beforeAlt({ step: label })}
                              loading="lazy"
                            />
                            <figcaption>{S.before}</figcaption>
                          </figure>
                        ) : null}
                        {a.hasAfter ? (
                          <figure>
                            <img
                              src={api.screenShotUrl(computerId, a.id, 'after')}
                              alt={S.afterAlt({ step: label })}
                              loading="lazy"
                            />
                            <figcaption>{S.after}</figcaption>
                          </figure>
                        ) : null}
                      </div>
                    ) : (
                      <p className="muted ws-flush">
                        {a.status === 'refused' ? S.noShotsRefused : S.noShots}
                      </p>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {more && items?.length ? (
        <div className="row">
          <Button onClick={() => void older()} disabled={loadingMore}>
            {S.older}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
