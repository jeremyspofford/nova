// App grants for computer use (FR-207; docs/04 §2.8, docs/11 §5.1-§5.2, docs/12 §4.2): the apps
// Nova may control on this computer, each for a limited time (30 minutes by default), renewable
// and revocable. Granting shows the grant prompt first: the app, its level and when it expires.
// Apps Nova never controls (system settings, password managers, banking) are refused with the
// reason; the apps on screen show the level Nova would get in each.
import { useEffect, useId, useState } from 'react';
import type { ScreenControlTier, ScreenGrantView, ScreenWindowView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useInterval } from '../settings/common.ts';
import { useScreenApi } from './api.ts';
import { TIER_ALLOWS, TIER_TEXT, remainingText, secondsLeft, sentence, timeOf } from './format.ts';

const MINUTES_MAX = 1_440;

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
      (err: unknown) => alive && setHistoryError(errorMessage(err, 'Could not load past grants.')),
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
      setRefusal(`${a} is never controlled by Nova. Do this step yourself.`);
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
      announce(`Nova may control ${g.app} for ${mins} minutes.`);
      toast.show(`Allowed ${g.app} for ${mins} min.`, { tone: 'success' });
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setRefusal(sentence(err.body.message));
      else toast.show(`Could not allow ${a}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const renew = async (g: ScreenGrantView) => {
    try {
      await api.renewScreenGrant(computerId, g.id);
      toast.show(`Renewed ${g.app}.`, { tone: 'success' });
      onChanged();
    } catch (err) {
      toast.show(`Could not renew ${g.app}: ${errorMessage(err)}`, { tone: 'error' });
      onChanged();
    }
  };

  const revoke = async (g: ScreenGrantView) => {
    setRevoking(null);
    try {
      await api.revokeScreenGrant(computerId, g.id);
      toast.show(`Nova can no longer control ${g.app}.`, { tone: 'success' });
      onChanged();
    } catch (err) {
      toast.show(`Could not revoke ${g.app}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const past = (history ?? []).filter((g) => !g.active);

  return (
    <section className="ws-section scr-grants" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>Apps Nova may control</h3>
      </div>
      <p className="muted ws-flush">
        Nova acts only in apps you allow, for a limited time. Browsers are view only (Nova uses the
        browser tool instead), terminals and editors click only, other apps full control. Apps like
        system settings, password managers and banking are never controlled.
      </p>
      {grants.length === 0 ? (
        <p className="muted">No apps allowed right now.</p>
      ) : (
        <ul className="ws-list" aria-label="Allowed apps">
          {grants.map((g) => (
            <li key={g.id} className="ws-list-row" aria-label={g.app}>
              <div className="ws-source-main">
                <strong>{g.app}</strong>
                <span className="muted ws-row-meta">
                  <span>{TIER_TEXT[g.tier]}</span>
                  <span>{remainingText(secondsLeft(g.expiresAt, now))}</span>
                  <span>until {timeOf(g.expiresAt)}</span>
                </span>
              </div>
              <div className="row ws-row-actions">
                <Button onClick={() => void renew(g)} aria-label={`Renew ${g.app}`}>
                  Renew
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setRevoking(g)}
                  aria-label={`Revoke ${g.app}`}
                >
                  Revoke
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
          label="App to allow"
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
          label="Minutes"
          inputMode="numeric"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value.trim())}
          error={minutesOk ? undefined : `From 1 to ${MINUTES_MAX}`}
        />
        <Button type="submit" variant="primary" disabled={!app.trim() || !minutesOk}>
          Allow…
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
            <Icon name="eye" /> {windows ? 'Look again' : 'See apps on screen'}
          </Button>
          {lookingAtApps ? <Spinner label="Looking at the screen" /> : null}
        </div>
        {noDesktop ? <p className="muted">{noDesktop}</p> : null}
        {windows && windows.length === 0 ? <p className="muted">No app windows are open.</p> : null}
        {windows?.length ? (
          <ul className="ws-list" aria-label="Apps on screen">
            {windows.map((w) => (
              <li key={w.id} className="ws-list-row" aria-label={w.app}>
                <div className="ws-source-main">
                  <strong>
                    {w.app}
                    {w.focused ? <span className="muted"> (in front)</span> : null}
                  </strong>
                  {/* Window titles come from the screen: untrusted text, shown as text. */}
                  <span className="muted ws-row-meta">{w.title}</span>
                  <span className="ws-row-meta">
                    <span className="ws-badge" data-tone={w.tier === 'none' ? 'warn' : undefined}>
                      {TIER_TEXT[w.tier]}
                    </span>
                    <span className="muted">{TIER_ALLOWS[w.tier]}</span>
                  </span>
                </div>
                {w.granted ? (
                  <span className="ws-badge" data-tone="ok">
                    <Icon name="check" /> Allowed
                  </span>
                ) : w.tier === 'none' ? (
                  <span className="muted">You do this one</span>
                ) : (
                  <Button onClick={() => ask(w.app)} aria-label={`Allow ${w.app}…`}>
                    Allow…
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="row">
        <Button variant="ghost" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Hide past grants' : 'Show past grants'}
        </Button>
      </div>
      {showAll ? (
        historyError ? (
          <div className="ws-error" role="alert">
            <p>{historyError}</p>
          </div>
        ) : history === null ? (
          <Spinner label="Loading past grants" />
        ) : past.length === 0 ? (
          <p className="muted">No expired or revoked grants.</p>
        ) : (
          <ul className="ws-plain-list" aria-label="Past grants">
            {past.map((g) => (
              <li key={g.id}>
                {g.app}: {g.revokedAt ? `revoked ${timeOf(g.revokedAt)}` : 'expired'}
              </li>
            ))}
          </ul>
        )
      ) : null}
      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking ? `Allow Nova to control “${asking.app}”?` : 'Allow this app?'}
        description="Stop at any time with the kill key or the Stop button."
        footer={
          <>
            <Button onClick={() => setAsking(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => asking && void grant(asking.app)}>
              Allow for {minutesOk ? mins : defaultMinutes} min
            </Button>
          </>
        }
      >
        {asking ? (
          <dl className="ws-dl">
            <dt>Level</dt>
            <dd>
              {asking.tier
                ? `${TIER_TEXT[asking.tier]}. ${TIER_ALLOWS[asking.tier]}`
                : 'Set by the kind of app: full control for most apps, less for browsers, terminals and editors.'}
            </dd>
            <dt>Expires</dt>
            <dd>{minutesOk ? mins : defaultMinutes} minutes after you allow</dd>
          </dl>
        ) : null}
      </Dialog>
      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={revoking ? `Revoke ${revoking.app}?` : 'Revoke this app?'}
        description="Nova stops controlling the app at once. Allow it again when you want."
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => revoking && void revoke(revoking)}>
              Revoke
            </Button>
          </>
        }
      />
    </section>
  );
}
