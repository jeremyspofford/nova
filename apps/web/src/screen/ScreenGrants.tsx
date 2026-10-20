// App grants for computer use (FR-207; docs/04 §2.8, docs/11 §5.1-§5.2, docs/12 §4.2): the apps
// Nova may control on this computer, each for a limited time (30 minutes by default), renewable
// and revocable. Granting shows the grant prompt first: the app, its level and when it expires.
// Apps Nova never controls (system settings, password managers, banking) are refused with the
// reason; the apps on screen show the level Nova would get in each.
import { useEffect, useId, useState } from 'react';
import type { ScreenControlTier, ScreenGrantView, ScreenWindowView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { defineMessages, fmt } from '@nova/i18n';
import { ApiError, errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useInterval } from '../settings/common.ts';
import { useScreenApi } from './api.ts';
import { TIER_ALLOWS, TIER_TEXT, remainingText, secondsLeft, sentence, timeOf } from './format.ts';

const MINUTES_MAX = 1_440;

export const GRANTS_TEXT = defineMessages('screen.grants', {
  title: 'Apps Nova may control',
  intro:
    'Nova acts only in apps you allow, for a limited time. Browsers are view only (Nova uses the browser tool instead), terminals and editors click only, other apps full control. Apps like system settings, password managers and banking are never controlled.',
  historyFailed: 'Could not load past grants.',
  neverControlled: '{app} is never controlled by Nova. Do this step yourself.',
  allowedSaid:
    '{n, plural, one {Nova may control {app} for # minute.} other {Nova may control {app} for # minutes.}}',
  allowedToast: '{n, plural, other {Allowed {app} for # min.}}',
  allowFailed: 'Could not allow {app}: {error}',
  renewed: 'Renewed {app}.',
  renewFailed: 'Could not renew {app}: {error}',
  revoked: 'Nova can no longer control {app}.',
  revokeFailed: 'Could not revoke {app}: {error}',
  none: 'No apps allowed right now.',
  allowedList: 'Allowed apps',
  until: 'until {time}',
  renew: 'Renew',
  renewApp: 'Renew {app}',
  revoke: 'Revoke',
  revokeApp: 'Revoke {app}',
  appToAllow: 'App to allow',
  minutes: 'Minutes',
  minutesRange: 'From 1 to {max}',
  allow: 'Allow…',
  allowApp: 'Allow {app}…',
  lookAgain: 'Look again',
  seeApps: 'See apps on screen',
  looking: 'Looking at the screen',
  noWindows: 'No app windows are open.',
  onScreen: 'Apps on screen',
  inFront: '(in front)',
  allowed: 'Allowed',
  youDo: 'You do this one',
  showPast: 'Show past grants',
  hidePast: 'Hide past grants',
  loadingPast: 'Loading past grants',
  noPast: 'No expired or revoked grants.',
  pastList: 'Past grants',
  pastRevoked: '{app}: revoked {time}',
  pastExpired: '{app}: expired',
  askTitle: 'Allow Nova to control “{app}”?',
  askTitleAny: 'Allow this app?',
  askHelp: 'Stop at any time with the kill key or the Stop button.',
  cancel: 'Cancel',
  allowFor: '{n, plural, other {Allow for # min}}',
  level: 'Level',
  /** A tier's name, then what Nova may do at it. */
  levelIs: '{tier}. {allows}',
  levelByKind:
    'Set by the kind of app: full control for most apps, less for browsers, terminals and editors.',
  expires: 'Expires',
  expiresAfter: '{n, plural, one {# minute after you allow} other {# minutes after you allow}}',
  revokeTitle: 'Revoke {app}?',
  revokeTitleAny: 'Revoke this app?',
  revokeHelp: 'Nova stops controlling the app at once. Allow it again when you want.',
});
const S = GRANTS_TEXT;

export function ScreenGrants({
  computerId,
  grants,
  windows,
  noDesktop,
  onChanged,
  onLookAtApps,
  lookingAtApps,
}: {
  computerId: string;
  /** The active grants (from the control status). */
  grants: ScreenGrantView[];
  /** The apps on screen from the last look, or null before one. */
  windows: ScreenWindowView[] | null;
  /** Why the screen cannot be seen, when it cannot. */
  noDesktop: string | null;
  onChanged: () => void;
  onLookAtApps: () => void;
  lookingAtApps: boolean;
}) {
  const api = useScreenApi();
  const toast = useToast();
  const announce = useAnnounce();
  const settings = useSettings();
  const defaultMinutes = settings.get('screen.grantMinutes').value;
  const [now, setNow] = useState(() => Date.now());
  const [app, setApp] = useState('');
  const [minutes, setMinutes] = useState(String(defaultMinutes));
  const [asking, setAsking] = useState<{ app: string; tier: ScreenControlTier | null } | null>(
    null,
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ScreenGrantView | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [history, setHistory] = useState<ScreenGrantView[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const listId = useId();
  const headingId = useId();

  useInterval(() => setNow(Date.now()), 15_000, grants.length > 0);

  const grantKey = grants.map((g) => `${g.id}:${g.expiresAt}`).join(',');
  useEffect(() => {
    if (!showAll) return;
    let alive = true;
    api.listScreenGrants(computerId, true).then(
      ({ items }) => {
        if (!alive) return;
        setHistory(items);
        setHistoryError(null);
      },
      (err: unknown) => alive && setHistoryError(errorMessage(err, S.historyFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, computerId, showAll, grantKey]);

  const mins = Number(minutes);
  const minutesOk = Number.isInteger(mins) && mins >= 1 && mins <= MINUTES_MAX;
  const tierOf = (name: string): ScreenControlTier | null =>
    windows?.find((w) => w.app.trim().toLowerCase() === name.trim().toLowerCase())?.tier ?? null;

  const ask = (name: string) => {
    const a = name.trim();
    if (!a || !minutesOk) return;
    const tier = tierOf(a);
    if (tier === 'none') {
      setRefusal(S.neverControlled({ app: a }));
      return;
    }
    setRefusal(null);
    setAsking({ app: a, tier });
  };

  const grant = async (a: string) => {
    setAsking(null);
    try {
      const g = await api.grantScreenApp(computerId, { app: a, minutes: mins });
      setApp('');
      announce(S.allowedSaid({ app: g.app, n: mins }));
      toast.show(S.allowedToast({ app: g.app, n: mins }), { tone: 'success' });
      onChanged();
    } catch (err) {
      // The Hub's refusal (English in M8, D9), e.g. an app Nova never controls.
      if (err instanceof ApiError && err.status === 403) setRefusal(sentence(err.body.message));
      else toast.show(S.allowFailed({ app: a, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const renew = async (g: ScreenGrantView) => {
    try {
      await api.renewScreenGrant(computerId, g.id);
      toast.show(S.renewed({ app: g.app }), { tone: 'success' });
      onChanged();
    } catch (err) {
      toast.show(S.renewFailed({ app: g.app, error: errorMessage(err) }), { tone: 'error' });
      onChanged();
    }
  };

  const revoke = async (g: ScreenGrantView) => {
    setRevoking(null);
    try {
      await api.revokeScreenGrant(computerId, g.id);
      toast.show(S.revoked({ app: g.app }), { tone: 'success' });
      onChanged();
    } catch (err) {
      toast.show(S.revokeFailed({ app: g.app, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const past = (history ?? []).filter((g) => !g.active);

  return (
    <section className="ws-section scr-grants" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>{S.title}</h3>
      </div>
      <p className="muted ws-flush">{S.intro}</p>
      {grants.length === 0 ? (
        <p className="muted">{S.none}</p>
      ) : (
        <ul className="ws-list" aria-label={S.allowedList}>
          {grants.map((g) => (
            <li key={g.id} className="ws-list-row" aria-label={g.app}>
              <div className="ws-source-main">
                <strong dir="auto">{g.app}</strong>
                <span className="muted ws-row-meta">
                  <span>{TIER_TEXT[g.tier]}</span>
                  <span>{remainingText(secondsLeft(g.expiresAt, now))}</span>
                  <span>{S.until({ time: timeOf(g.expiresAt) })}</span>
                </span>
              </div>
              <div className="row ws-row-actions">
                <Button onClick={() => void renew(g)} aria-label={S.renewApp({ app: g.app })}>
                  {S.renew}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setRevoking(g)}
                  aria-label={S.revokeApp({ app: g.app })}
                >
                  {S.revoke}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="ws-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          ask(app);
        }}
      >
        <TextField
          label={S.appToAllow}
          value={app}
          list={listId}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => {
            setApp(e.target.value);
            setRefusal(null);
          }}
        />
        <datalist id={listId}>
          {(windows ?? []).map((w) => (
            <option key={w.id} value={w.app} />
          ))}
        </datalist>
        <TextField
          label={S.minutes}
          inputMode="numeric"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value.trim())}
          error={
            minutesOk
              ? undefined
              : S.minutesRange({ max: fmt.number(MINUTES_MAX, { useGrouping: false }) })
          }
        />
        <Button type="submit" variant="primary" disabled={!app.trim() || !minutesOk}>
          {S.allow}
        </Button>
      </form>
      {refusal ? (
        <div className="ws-callout" role="alert">
          <Icon name="shield" />
          <p>{refusal}</p>
        </div>
      ) : null}
      <div className="scr-apps">
        <div className="row">
          <Button onClick={onLookAtApps} disabled={lookingAtApps || noDesktop !== null}>
            <Icon name="eye" /> {windows ? S.lookAgain : S.seeApps}
          </Button>
          {lookingAtApps ? <Spinner label={S.looking} /> : null}
        </div>
        {noDesktop ? <p className="muted">{noDesktop}</p> : null}
        {windows && windows.length === 0 ? <p className="muted">{S.noWindows}</p> : null}
        {windows?.length ? (
          <ul className="ws-list" aria-label={S.onScreen}>
            {windows.map((w) => (
              <li key={w.id} className="ws-list-row" aria-label={w.app}>
                <div className="ws-source-main">
                  <strong>
                    <span dir="auto">{w.app}</span>
                    {w.focused ? <span className="muted"> {S.inFront}</span> : null}
                  </strong>
                  {/* Window titles come from the screen: untrusted text, shown as text. */}
                  <span className="muted ws-row-meta" dir="auto">
                    {w.title}
                  </span>
                  <span className="ws-row-meta">
                    <span className="ws-badge" data-tone={w.tier === 'none' ? 'warn' : undefined}>
                      {TIER_TEXT[w.tier]}
                    </span>
                    <span className="muted">{TIER_ALLOWS[w.tier]}</span>
                  </span>
                </div>
                {w.granted ? (
                  <span className="ws-badge" data-tone="ok">
                    <Icon name="check" /> {S.allowed}
                  </span>
                ) : w.tier === 'none' ? (
                  <span className="muted">{S.youDo}</span>
                ) : (
                  <Button onClick={() => ask(w.app)} aria-label={S.allowApp({ app: w.app })}>
                    {S.allow}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="row">
        <Button variant="ghost" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? S.hidePast : S.showPast}
        </Button>
      </div>
      {showAll ? (
        historyError ? (
          <div className="ws-error" role="alert">
            <p>{historyError}</p>
          </div>
        ) : history === null ? (
          <Spinner label={S.loadingPast} />
        ) : past.length === 0 ? (
          <p className="muted">{S.noPast}</p>
        ) : (
          <ul className="ws-plain-list" aria-label={S.pastList}>
            {past.map((g) => (
              <li key={g.id}>
                {g.revokedAt
                  ? S.pastRevoked({ app: g.app, time: timeOf(g.revokedAt) })
                  : S.pastExpired({ app: g.app })}
              </li>
            ))}
          </ul>
        )
      ) : null}
      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking ? S.askTitle({ app: asking.app }) : S.askTitleAny}
        description={S.askHelp}
        footer={
          <>
            <Button onClick={() => setAsking(null)}>{S.cancel}</Button>
            <Button variant="primary" onClick={() => asking && void grant(asking.app)}>
              {S.allowFor({ n: minutesOk ? mins : defaultMinutes })}
            </Button>
          </>
        }
      >
        {asking ? (
          <dl className="ws-dl">
            <dt>{S.level}</dt>
            <dd>
              {asking.tier
                ? S.levelIs({ tier: TIER_TEXT[asking.tier], allows: TIER_ALLOWS[asking.tier] })
                : S.levelByKind}
            </dd>
            <dt>{S.expires}</dt>
            <dd>{S.expiresAfter({ n: minutesOk ? mins : defaultMinutes })}</dd>
          </dl>
        ) : null}
      </Dialog>
      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={revoking ? S.revokeTitle({ app: revoking.app }) : S.revokeTitleAny}
        description={S.revokeHelp}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>{S.cancel}</Button>
            <Button variant="danger" onClick={() => revoking && void revoke(revoking)}>
              {S.revoke}
            </Button>
          </>
        }
      />
    </section>
  );
}
