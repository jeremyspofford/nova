// Settings → Computer use (FR-207, FR-093; docs/04 §2.8, §5, docs/11 §5, §9, docs/12 §4.2): the
// kill key (remappable, never unbound), how long an app grant lasts, how long action screenshots
// are kept, per-app level overrides (they can only lower a level), and the apps Nova may control
// right now on each computer, with their time left, Renew and Revoke.
import { useId, useState } from 'react';
import type { ScreenControlTier, ScreenGrantView } from '@nova/shared';
import { Button, Dialog, Icon, Kbd, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useSettings } from '../settings.tsx';
import { MANAGED, useInterval } from '../settings/common.ts';
import { useScreenApi } from './api.ts';
import { TIER_TEXT, computerText, keyCaps, remainingText, secondsLeft } from './format.ts';
import { useScreenStatuses } from './statuses.ts';
import '../workspace.css';
import './screen.css';

const KEY_RE = /^[A-Za-z0-9]+([+ ][A-Za-z0-9]+){0,4}$/;
const LOWER_TIERS: ScreenControlTier[] = ['none', 'view', 'click'];

/** The setting's form of a key press ("Escape", "ctrl+alt+k"), or null when it cannot be one. */
export function killKeyFromEvent(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Tab'].includes(e.key))
    return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!/^[A-Za-z0-9]+$/.test(key)) return null;
  const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta'];
  const out = [...mods.filter(Boolean), key].join('+');
  return KEY_RE.test(out) ? out : null;
}

export function ComputerUseSettings() {
  const settings = useSettings();
  const toast = useToast();
  const killKey = settings.get('screen.killKey');
  const minutes = settings.get('screen.grantMinutes');
  const keep = settings.get('screen.screenshotRetentionDays');
  const overrides = settings.get('screen.tierOverrides');
  const [recording, setRecording] = useState(false);
  const [keyProblem, setKeyProblem] = useState<string | null>(null);
  const [mins, setMins] = useState<string | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const [app, setApp] = useState('');
  const [tier, setTier] = useState<ScreenControlTier>('none');
  const fail = (err: unknown) =>
    toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });

  const minText = mins ?? String(minutes.value);
  const minNum = Number(minText);
  const minOk = Number.isInteger(minNum) && minNum >= 1 && minNum <= 1_440;
  const dayText = days ?? String(keep.value);
  const dayNum = Number(dayText);
  const dayOk = Number.isInteger(dayNum) && dayNum >= 1 && dayNum <= 3_650;
  const entries = Object.entries(overrides.value).sort(([a], [b]) => a.localeCompare(b));

  const setOverrides = (next: Record<string, ScreenControlTier>) =>
    void settings.set('screen.tierOverrides', next).catch(fail);

  return (
    <div className="settings-page scr-settings">
      <h2>Computer use</h2>
      <section className="settings-section" aria-labelledby="scr-kill">
        <h3 id="scr-kill">Kill key</h3>
        <p className="muted">
          Stops computer use at once, wherever you are. On a device with Nova installed it works
          even when Nova is in the background; in a browser tab, only while Nova has focus.
        </p>
        <p className="row">
          <span>Current key:</span> <Kbd keys={keyCaps(killKey.value)} />
        </p>
        {killKey.locked ? <p className="muted">{MANAGED}</p> : null}
        {recording ? (
          <div
            className="scr-record"
            role="group"
            aria-label="Press the new kill key"
            tabIndex={0}
            ref={(el) => el?.focus()}
            onKeyDown={(e) => {
              if (e.key === 'Tab') return;
              e.preventDefault();
              e.stopPropagation();
              const k = killKeyFromEvent(e.nativeEvent);
              if (!k) {
                setKeyProblem('Use a letter, a digit or a named key such as Esc or F12.');
                return;
              }
              setRecording(false);
              setKeyProblem(null);
              void settings.set('screen.killKey', k).catch(fail);
            }}
          >
            <p>Press the new key or combination now…</p>
            <Button onClick={() => setRecording(false)}>Cancel</Button>
          </div>
        ) : (
          <div className="row">
            <Button onClick={() => setRecording(true)} disabled={killKey.locked}>
              Change the kill key
            </Button>
            <Button
              variant="ghost"
              onClick={() => void settings.set('screen.killKey', 'Escape').catch(fail)}
              disabled={killKey.locked || killKey.value === 'Escape'}
            >
              Use Esc
            </Button>
          </div>
        )}
        {keyProblem ? (
          <p className="ws-warning" role="alert">
            <Icon name="alert" /> {keyProblem}
          </p>
        ) : null}
      </section>

      <section className="settings-section" aria-labelledby="scr-limits">
        <h3 id="scr-limits">Limits</h3>
        <form
          className="ws-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            if (minOk) settings.set('screen.grantMinutes', minNum).then(() => setMins(null), fail);
          }}
        >
          <TextField
            label="An app grant lasts (minutes)"
            inputMode="numeric"
            value={minText}
            disabled={minutes.locked}
            onChange={(e) => setMins(e.target.value.trim())}
            hint={minutes.locked ? MANAGED : 'Renew from the indicator to keep going.'}
            error={minOk ? undefined : 'From 1 to 1440 minutes'}
          />
          <Button type="submit" disabled={!minOk || mins === null || minutes.locked}>
            Save
          </Button>
        </form>
        <form
          className="ws-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            if (dayOk)
              settings
                .set('screen.screenshotRetentionDays', dayNum)
                .then(() => setDays(null), fail);
          }}
        >
          <TextField
            label="Keep action screenshots for (days)"
            inputMode="numeric"
            value={dayText}
            disabled={keep.locked}
            onChange={(e) => setDays(e.target.value.trim())}
            hint={keep.locked ? MANAGED : 'Older screenshots are deleted; the actions stay listed.'}
            error={dayOk ? undefined : 'From 1 to 3650 days'}
          />
          <Button type="submit" disabled={!dayOk || days === null || keep.locked}>
            Save
          </Button>
        </form>
      </section>

      <section className="settings-section" aria-labelledby="scr-levels">
        <h3 id="scr-levels">App levels</h3>
        <p className="muted">
          Lower what Nova may do in an app. Nothing raises an app above its kind: browsers stay view
          only and terminals and editors click only.
        </p>
        {overrides.locked ? <p className="muted">{MANAGED}</p> : null}
        {entries.length === 0 ? <p className="muted">No apps lowered.</p> : null}
        {entries.length ? (
          <ul className="ws-list" aria-label="Lowered apps">
            {entries.map(([name, t]) => (
              <li key={name} className="ws-list-row" aria-label={name}>
                <strong>{name}</strong>
                <div className="row ws-row-actions">
                  <SelectField
                    label={`Level for ${name}`}
                    hideLabel
                    value={t}
                    locked={overrides.locked}
                    onChange={(v) =>
                      setOverrides({ ...overrides.value, [name]: v as ScreenControlTier })
                    }
                    options={LOWER_TIERS.map((x) => ({ value: x, label: TIER_TEXT[x] }))}
                  />
                  <Button
                    variant="ghost"
                    disabled={overrides.locked}
                    aria-label={`Remove ${name}`}
                    onClick={() => {
                      const next = { ...overrides.value };
                      delete next[name];
                      setOverrides(next);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <form
          className="ws-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            const a = app.trim();
            if (!a) return;
            setOverrides({ ...overrides.value, [a]: tier });
            setApp('');
          }}
        >
          <TextField
            label="App"
            value={app}
            maxLength={200}
            disabled={overrides.locked}
            onChange={(e) => setApp(e.target.value)}
          />
          <SelectField
            label="Level"
            value={tier}
            locked={overrides.locked}
            onChange={(v) => setTier(v as ScreenControlTier)}
            options={LOWER_TIERS.map((x) => ({ value: x, label: TIER_TEXT[x] }))}
          />
          <Button type="submit" disabled={!app.trim() || overrides.locked}>
            Lower
          </Button>
        </form>
      </section>

      <ActiveGrants />
    </div>
  );
}

/** Every computer's active grants: time left, Renew and Revoke (docs/04 §2.8). */
function ActiveGrants() {
  const api = useScreenApi();
  const toast = useToast();
  const headingId = useId();
  const { statuses, computers, error, refresh } = useScreenStatuses();
  const [now, setNow] = useState(() => Date.now());
  const [revoking, setRevoking] = useState<ScreenGrantView | null>(null);
  const grants = (statuses ?? []).flatMap((s) => s.grants.filter((g) => g.active));
  useInterval(() => setNow(Date.now()), 15_000, grants.length > 0);

  const renew = (g: ScreenGrantView) =>
    api.renewScreenGrant(g.computerId, g.id).then(
      () => {
        refresh(g.computerId);
        toast.show(`Renewed ${g.app}.`, { tone: 'success' });
      },
      (err: unknown) => toast.show(`Could not renew: ${errorMessage(err)}`, { tone: 'error' }),
    );

  const revoke = (g: ScreenGrantView) => {
    setRevoking(null);
    api.revokeScreenGrant(g.computerId, g.id).then(
      () => {
        refresh(g.computerId);
        toast.show(`Nova can no longer control ${g.app}.`, { tone: 'success' });
      },
      (err: unknown) => toast.show(`Could not revoke: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Apps Nova may control now</h3>
      {error && statuses === null ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => refresh()}>Retry</Button>
        </div>
      ) : statuses === null ? (
        <Spinner label="Loading grants" />
      ) : grants.length === 0 ? (
        <p className="muted">None. Nova asks before it controls an app.</p>
      ) : (
        <ul className="ws-list" aria-label="Active grants">
          {grants.map((g) => (
            <li key={g.id} className="ws-list-row" aria-label={g.app}>
              <div className="ws-source-main">
                <strong>{g.app}</strong>
                <span className="muted ws-row-meta">
                  <span>{TIER_TEXT[g.tier]}</span>
                  <span>{remainingText(secondsLeft(g.expiresAt, now))}</span>
                  <span>{computerText(computers.get(g.computerId), g.computerId)}</span>
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
      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={revoking ? `Revoke ${revoking.app}?` : 'Revoke this app?'}
        description="Nova stops controlling the app at once."
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => revoking && revoke(revoking)}>
              Revoke
            </Button>
          </>
        }
      />
    </section>
  );
}
