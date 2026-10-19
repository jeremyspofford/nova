// The local browser fallback in a computer's browser panel (FR-209, docs/11 §4.6): while the agent
// works on a connected computer's browser, the panel says so (which computer, which profile, which
// site, since when and why), and every trace row recorded there carries a mark naming the computer
// and the profile. Device names come from the account's consents (a fallback always runs on one),
// so a row of a device that left still reads "your computer".
import { useEffect, useState } from 'react';
import type { BrowserActionFallbackMark, BrowserFallbackSessionView } from '@nova/shared';
import { Icon } from '@nova/ui';
import { formatWhen } from '../settings/common.ts';
import { useHubEvents } from '../spaces/events.ts';
import { useDebounced } from '../work/events.ts';
import { useBrowserDeviceApi } from './api-m75.ts';
import { FALLBACK_EVENTS, eventComputer } from './events.ts';
import { CAUSE_TEXT, END_TEXT, PROFILE_TEXT, markText } from './format.ts';
import './browserdevice.css';

/** Device names by id, from the account's consents (revoked ones too); live. */
export function useFallbackDeviceNames(): Map<string, string> {
  const api = useBrowserDeviceApi();
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.listFallbackConsents({ all: true }).then(
      ({ items }) => {
        if (!alive) return;
        const next = new Map<string, string>();
        for (const c of items) if (c.deviceName) next.set(c.deviceId, c.deviceName);
        setNames(next);
      },
      // Names are extra: without them a mark says "your computer".
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, version]);
  const reload = useDebounced(() => setVersion((v) => v + 1), 200);
  useHubEvents(FALLBACK_EVENTS, () => reload());
  return names;
}

/** A trace row's mark: "On Desk PC, clean profile". */
export function FallbackMark({
  mark,
  deviceName,
}: {
  mark: BrowserActionFallbackMark;
  deviceName: string | null;
}) {
  return (
    <span className="ws-badge bdv-mark" data-profile={mark.profile}>
      <Icon name="server" /> {markText(mark, deviceName)}
    </span>
  );
}

/** How long after it ended the last session is still mentioned. */
const RECENT_MS = 30 * 60_000;

/**
 * "The agent is working in Desk PC's browser": the computer's open fallback session, if any; else
 * how the last one ended, for half an hour (why the marks stopped).
 */
export function FallbackSessionNote({ computerId }: { computerId: string }) {
  const api = useBrowserDeviceApi();
  const names = useFallbackDeviceNames();
  // The sessions, and when they were read (what "recent" is measured from).
  const [loaded, setLoaded] = useState<{ items: BrowserFallbackSessionView[]; at: number }>({
    items: [],
    at: 0,
  });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.listFallbackSessions({ computerId, limit: 10 }).then(
      ({ items }) => alive && setLoaded({ items, at: Date.now() }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, computerId, version]);
  const reload = useDebounced(() => setVersion((v) => v + 1), 200);
  useHubEvents(FALLBACK_EVENTS, (env) => {
    const c = eventComputer(env);
    if (!c || c === computerId) reload();
  });
  if (!api) return null;
  const open = loaded.items.find((s) => !s.endedAt) ?? null;
  const last = open ? null : (loaded.items[0] ?? null);
  const recent =
    last?.endedAt && last.endReason && loaded.at - Date.parse(last.endedAt) < RECENT_MS
      ? last
      : null;
  const where = (s: BrowserFallbackSessionView) =>
    s.profile === 'extension' && s.bridgeUser
      ? `${s.bridgeUser}’s own browser on ${names.get(s.deviceId) ?? 'your computer'}`
      : `${names.get(s.deviceId) ?? 'your computer'}’s browser`;
  return (
    <div role="status" className="bdv-now-live">
      {open ? (
        <div className="ws-callout bdv-now">
          <Icon name="server" />
          <div className="stack">
            <p className="ws-flush">
              <strong>
                Working in {where(open)} on {open.site}
              </strong>{' '}
              ({PROFILE_TEXT[open.profile].toLowerCase()}) since {formatWhen(open.startedAt)},
              because {CAUSE_TEXT[open.cause]}.
            </p>
            <p className="muted ws-flush">
              {open.profile === 'clean'
                ? 'The profile starts empty and reaches only this site and its subdomains; it is deleted when the session ends.'
                : 'The agent acts only in a tab it opened or one you shared, and never reads cookies or passwords.'}{' '}
              Actions there are marked below. It stops when the agent leaves {open.site}, and the
              agent goes back to its own browser.
            </p>
          </div>
        </div>
      ) : recent?.endReason ? (
        <p className="muted ws-flush bdv-ended">
          <Icon name="server" /> The last session in {where(recent)} on {recent.site}:{' '}
          {END_TEXT[recent.endReason].toLowerCase()}, {formatWhen(recent.endedAt)}.
        </p>
      ) : null}
    </div>
  );
}
