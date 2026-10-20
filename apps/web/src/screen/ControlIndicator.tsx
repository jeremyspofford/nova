// The control indicator (FR-207; docs/04 §2.8, docs/11 §5.2): while Nova controls the screen of
// any of the account's computers, an always-on-top pill names the apps, shows the kill key and
// offers Stop and Renew. The kill key works anywhere in the app while it shows. Mounted once,
// globally, by the shell; it renders nothing while nothing is controlled.
import { useEffect, useRef } from 'react';
import type { ScreenStatusView } from '@nova/shared';
import { Button, Icon, Kbd, useToast } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { errorMessage } from '../api.ts';
import { listText } from '../devices/format.ts';
import { rich } from '../i18n/rich.tsx';
import { useAnnounce } from '../services.tsx';
import { useScreenApi } from './api.ts';
import { ariaKeys, computerText, keyCaps } from './format.ts';
import { claimKill, useKillKey } from './killkey.ts';
import { useScreenStatuses } from './statuses.ts';
import './screen.css';

export const INDICATOR_TEXT = defineMessages('screen.indicator', {
  region: 'Computer control',
  stopped: 'Computer use stopped. Nothing more is sent until you resume it.',
  stopFailed: 'Could not stop computer use: {error} Press Stop again.',
  renewed: 'Renewed control of {apps}.',
  renewFailed: 'Could not renew: {error}',
  ended: 'Nova stopped controlling the screen.',
  controlling: 'Nova is controlling {apps}',
  controllingApps: 'Nova is controlling apps',
  controllingOn: 'Nova is controlling {apps} on {computer}',
  controllingAppsOn: 'Nova is controlling apps on {computer}',
  /** After the apps, with the kill key's caps: "· Esc to stop". */
  toStop: '{key} to stop',
  stop: 'Stop',
  renew: 'Renew',
  open: 'Open',
});
const S = INDICATOR_TEXT;

/** "Nova is controlling Mail, Notes", with the computer when more than one is controlled. */
function controllingText(s: ScreenStatusView, computer: string | null): string {
  const apps = s.indicator.apps.length ? listText(s.indicator.apps) : null;
  if (computer)
    return apps ? S.controllingOn({ apps, computer }) : S.controllingAppsOn({ computer });
  return apps ? S.controlling({ apps }) : S.controllingApps;
}

export function ControlIndicator({
  onOpenComputer,
}: {
  /** Opens the computer's page (its Computer use panel), when the shell has one. */
  onOpenComputer?: (computerId: string) => void;
}) {
  const api = useScreenApi();
  const toast = useToast();
  const announce = useAnnounce();
  const { statuses, computers, put, refresh } = useScreenStatuses();
  const controlling = (statuses ?? []).filter((s) => s.state === 'controlling');
  const killKey = controlling[0]?.indicator.killKey ?? 'Escape';

  const stop = (list: ScreenStatusView[], e?: Event) => {
    for (const s of list) {
      if (e && !claimKill(e, s.computerId)) continue;
      api.killScreen(s.computerId).then(
        (next) => {
          put(next);
          toast.show(S.stopped, { tone: 'success' });
        },
        (err: unknown) => {
          refresh(s.computerId);
          toast.show(S.stopFailed({ error: errorMessage(err) }), { tone: 'error', duration: 0 });
        },
      );
    }
  };

  useKillKey(controlling.length > 0, killKey, (e) => stop(controlling, e));

  const renew = (s: ScreenStatusView) => {
    const active = s.grants.filter((g) => g.active);
    Promise.all(active.map((g) => api.renewScreenGrant(s.computerId, g.id))).then(
      () => {
        refresh(s.computerId);
        toast.show(S.renewed({ apps: listText(s.indicator.apps) }), { tone: 'success' });
      },
      (err: unknown) => {
        refresh(s.computerId);
        toast.show(S.renewFailed({ error: errorMessage(err) }), { tone: 'error' });
      },
    );
  };

  // Say when control starts and ends; the pill itself is not a live region (it holds buttons).
  const said = controlling.map((s) => s.indicator.text ?? '').join(' ');
  const last = useRef('');
  useEffect(() => {
    if (said === last.current) return;
    const before = last.current;
    last.current = said;
    if (said) announce(`${said}.`);
    else if (before) announce(S.ended);
  }, [said, announce]);

  if (!controlling.length) return null;
  return (
    <div className="scr-indicators" role="region" aria-label={S.region}>
      {controlling.map((s) => (
        <div key={s.computerId} className="scr-indicator" data-computer={s.computerId}>
          <Icon name="eye" />
          <span className="scr-indicator-text">
            {controllingText(
              s,
              controlling.length > 1
                ? computerText(computers.get(s.computerId), s.computerId)
                : null,
            )}
            <span className="scr-indicator-key">
              {' · '}
              {rich(S.toStop, { key: <Kbd keys={keyCaps(s.indicator.killKey)} /> })}
            </span>
          </span>
          <Button
            variant="danger"
            onClick={() => stop([s])}
            aria-keyshortcuts={ariaKeys(s.indicator.killKey)}
          >
            <Icon name="stop" /> {S.stop}
          </Button>
          <Button variant="ghost" onClick={() => renew(s)}>
            {S.renew}
          </Button>
          {onOpenComputer ? (
            <Button variant="ghost" onClick={() => onOpenComputer(s.computerId)}>
              {S.open}
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
