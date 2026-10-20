// The local browser fallback in a computer's browser panel (FR-209, docs/11 §4.6): while the agent
// works on a connected computer's browser, the panel says so (which computer, which profile, which
// site, since when and why), and every trace row recorded there carries a mark naming the computer
// and the profile. Device names come from the account's consents (a fallback always runs on one),
// so a row of a device that left still reads "your computer".
import { useEffect, useState } from 'react';
import type { BrowserActionFallbackMark, BrowserFallbackSessionView } from '@nova/shared';
import { Icon } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { rich } from '../i18n/rich.tsx';
import { formatWhen } from '../settings/common.ts';
import { useHubEvents } from '../spaces/events.ts';
import { useDebounced } from '../work/events.ts';
import { useBrowserDeviceApi } from './api-m75.ts';
import { FALLBACK_EVENTS, eventComputer } from './events.ts';
import { CAUSE_TEXT, markText } from './format.ts';
import './browserdevice.css';

export const TRACE_TEXT = defineMessages('browserDevice.trace', {
  /** Where the session runs: a noun phrase inside the sentences below. */
  whereOwn: '{user}’s own browser on {device}',
  whereOwnYours: '{user}’s own browser on your computer',
  whereDevice: '{device}’s browser',
  whereYours: 'your computer’s browser',
  workingIn: 'Working in {where} on {site}',
  workingClean: '{title} (clean profile) since {when}, because {cause}.',
  workingOwn: '{title} (your own browser) since {when}, because {cause}.',
  cleanNote:
    'The profile starts empty and reaches only this site and its subdomains; it is deleted when the session ends.',
  extensionNote:
    'The agent acts only in a tab it opened or one you shared, and never reads cookies or passwords.',
  marked:
    'Actions there are marked below. It stops when the agent leaves {site}, and the agent goes back to its own browser.',
  /** How the last session ended: a clause, after a colon. */
  ends: {
    closed: 'closed',
    left_site: 'ended when the agent left the site',
    consent_revoked: 'ended when the consent was revoked',
    device_gone: 'ended when the computer left',
    error: 'ended by an error',
    disabled: 'ended when continuing on a computer was turned off',
    restarted: 'ended when the Hub restarted',
  },
  ended: 'The last session in {where} on {site}: {end}, {when}.',
});
const S = TRACE_TEXT;

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
  const where = (s: BrowserFallbackSessionView) => {
    const device = names.get(s.deviceId);
    if (s.profile === 'extension' && s.bridgeUser)
      return device
        ? S.whereOwn({ user: s.bridgeUser, device })
        : S.whereOwnYours({ user: s.bridgeUser });
    return device ? S.whereDevice({ device }) : S.whereYours;
  };
  return (
    <div role="status" className="bdv-now-live">
      {open ? (
        <div className="ws-callout bdv-now">
          <Icon name="server" />
          <div className="stack">
            <p className="ws-flush">
              {rich(open.profile === 'clean' ? S.workingClean : S.workingOwn, {
                title: <strong>{S.workingIn({ where: where(open), site: open.site })}</strong>,
                when: formatWhen(open.startedAt),
                cause: CAUSE_TEXT[open.cause],
              })}
            </p>
            <p className="muted ws-flush">
              {open.profile === 'clean' ? S.cleanNote : S.extensionNote}{' '}
              {S.marked({ site: open.site })}
            </p>
          </div>
        </div>
      ) : recent?.endReason ? (
        <p className="muted ws-flush bdv-ended">
          <Icon name="server" />{' '}
          {S.ended({
            where: where(recent),
            site: recent.site,
            end: S.ends[recent.endReason],
            when: formatWhen(recent.endedAt),
          })}
        </p>
      ) : null}
    </div>
  );
}
