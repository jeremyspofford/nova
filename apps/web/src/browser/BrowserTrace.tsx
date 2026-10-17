// The agent browser's recorded actions on a computer (FR-098, FR-095, FR-194; docs/11 §4, §9),
// newest first: what was done, on which site, the result, why a write was flagged or refused, and
// the before/after screenshots. Refusals because a page came from an external AI agent are
// called out above the list, and finished downloads are listed with where they went. Targets,
// URLs and errors are page-derived text: shown as text, never as links or HTML.
import { useEffect, useId, useState } from 'react';
import type { BrowserActionView } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { timeOf } from '../screen/format.ts';
import { useDebounced } from '../work/events.ts';
import { useBrowserApi } from './api.ts';
import { eventComputerId, useHubEvents } from './events.ts';
import {
  RESULT_CHIP,
  browserActionText,
  externalAgentName,
  isDownload,
  isExternalAgentNotice,
} from './format.ts';

/** The Hub returns at most this many, oldest first. */
export const BROWSER_TRACE_LIMIT = 500;
export const BROWSER_TRACE_PAGE = 30;

export function BrowserTrace({ computerId }: { computerId: string }) {
  const api = useBrowserApi();
  const headingId = useId();
  const [items, setItems] = useState<BrowserActionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState(BROWSER_TRACE_PAGE);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    api.listBrowserActions({ computerId, limit: BROWSER_TRACE_LIMIT }).then(
      ({ items: list }) => {
        if (!alive) return;
        setItems([...list].reverse());
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the browser actions.')),
    );
    return () => {
      alive = false;
    };
  }, [api, computerId, attempt]);

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
          {items.slice(0, shown).map((a) => {
            const chip = RESULT_CHIP[a.result];
            const label = browserActionText(a);
            const expanded = open.has(a.id);
            return (
              <li key={a.id} className="activity-item" data-result={a.result}>
                <button
                  type="button"
                  className="scr-trace-step"
                  aria-expanded={expanded}
                  onClick={() => toggle(a.id)}
                >
                  <span className="activity-title">
                    {label}
                    {a.target ? <span className="muted"> {a.target}</span> : null}
                    {a.host ? <span className="muted"> on {a.host}</span> : null}
                  </span>
                  {a.classification?.flagged ? (
                    <span className="ws-badge" data-tone="warn">
                      <Icon name="alert" /> Flagged
                    </span>
                  ) : null}
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
      {items && items.length > shown ? (
        <div className="row">
          <Button onClick={() => setShown((n) => n + BROWSER_TRACE_PAGE)}>Show older</Button>
        </div>
      ) : null}
    </section>
  );
}
