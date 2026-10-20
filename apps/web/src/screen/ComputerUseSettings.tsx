// Settings → Computer use (FR-207, FR-093; docs/04 §2.8, §5, docs/11 §5, §9, docs/12 §4.2): the
// kill key (remappable, never unbound), how long an app grant lasts, how long action screenshots
// are kept, per-app level overrides (they can only lower a level), and the apps Nova may control
// right now on each computer, with their time left, Renew and Revoke.
import { useId, useState } from 'react';
import type { ScreenControlTier, ScreenGrantView } from '@nova/shared';
import { Button, Dialog, Icon, Kbd, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { errorMessage } from '../api.ts';
import { useSettings } from '../settings.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { useInterval } from '../settings/common.ts';
import { useScreenApi } from './api.ts';
import { TIER_TEXT, computerText, keyCaps, remainingText, secondsLeft } from './format.ts';
import { useScreenStatuses } from './statuses.ts';
import '../workspace.css';
import './screen.css';

export const COMPUTER_USE_TEXT = defineMessages('screen.settings', {
  title: 'Computer use',
  saveFailed: 'Could not save: {error}',
  killKey: 'Kill key',
  killKeyHelp:
    'Stops computer use at once, wherever you are. On a device with Nova installed it works even when Nova is in the background; in a browser tab, only while Nova has focus.',
  currentKey: 'Current key:',
  pressNew: 'Press the new kill key',
  keyProblem: 'Use a letter, a digit or a named key such as Esc or F12.',
  pressNow: 'Press the new key or combination now…',
  cancel: 'Cancel',
  change: 'Change the kill key',
  useEsc: 'Use Esc',
  limits: 'Limits',
  grantMinutes: 'An app grant lasts (minutes)',
  grantHint: 'Renew from the indicator to keep going.',
  grantRange: 'From 1 to 1440 minutes',
  save: 'Save',
  keepDays: 'Keep action screenshots for (days)',
  keepHint: 'Older screenshots are deleted; the actions stay listed.',
  keepRange: 'From 1 to 3650 days',
  levels: 'App levels',
  levelsHelp:
    'Lower what Nova may do in an app. Nothing raises an app above its kind: browsers stay view only and terminals and editors click only.',
  noneLowered: 'No apps lowered.',
  lowered: 'Lowered apps',
  levelFor: 'Level for {app}',
  remove: 'Remove',
  removeApp: 'Remove {app}',
  app: 'App',
  level: 'Level',
  lower: 'Lower',
  grants: {
    renewed: 'Renewed {app}.',
    renewFailed: 'Could not renew: {error}',
    revoked: 'Nova can no longer control {app}.',
    revokeFailed: 'Could not revoke: {error}',
    title: 'Apps Nova may control now',
    retry: 'Retry',
    loading: 'Loading grants',
    none: 'None. Nova asks before it controls an app.',
    list: 'Active grants',
    renew: 'Renew',
    renewApp: 'Renew {app}',
    revoke: 'Revoke',
    revokeApp: 'Revoke {app}',
    revokeTitle: 'Revoke {app}?',
    revokeThis: 'Revoke this app?',
    revokeHelp: 'Nova stops controlling the app at once.',
    cancel: 'Cancel',
  },
});
const S = COMPUTER_USE_TEXT;

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
    toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });

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
      <h2>{S.title}</h2>
      <section className="settings-section" aria-labelledby="scr-kill">
        <h3 id="scr-kill">{S.killKey}</h3>
        <p className="muted">{S.killKeyHelp}</p>
        <p className="row">
          <span>{S.currentKey}</span> <Kbd keys={keyCaps(killKey.value)} />
        </p>
        {killKey.locked ? <ManagedNote as="p" id="scr-kill-lock" setting="screen.killKey" /> : null}
        {recording ? (
          <div
            className="scr-record"
            role="group"
            aria-label={S.pressNew}
            tabIndex={0}
            ref={(el) => el?.focus()}
            onKeyDown={(e) => {
              if (e.key === 'Tab') return;
              e.preventDefault();
              e.stopPropagation();
              const k = killKeyFromEvent(e.nativeEvent);
              if (!k) {
                setKeyProblem(S.keyProblem);
                return;
              }
              setRecording(false);
              setKeyProblem(null);
              void settings.set('screen.killKey', k).catch(fail);
            }}
          >
            <p>{S.pressNow}</p>
            <Button onClick={() => setRecording(false)}>{S.cancel}</Button>
          </div>
        ) : (
          <div className="row">
            <Button
              onClick={() => setRecording(true)}
              disabled={killKey.locked}
              aria-describedby={killKey.locked ? 'scr-kill-lock' : undefined}
            >
              {S.change}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void settings.set('screen.killKey', 'Escape').catch(fail)}
              disabled={killKey.locked || killKey.value === 'Escape'}
            >
              {S.useEsc}
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
        <h3 id="scr-limits">{S.limits}</h3>
        <form
          className="ws-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            if (minOk) settings.set('screen.grantMinutes', minNum).then(() => setMins(null), fail);
          }}
        >
          <TextField
            label={S.grantMinutes}
            inputMode="numeric"
            value={minText}
            locked={minutes.locked}
            setting="screen.grantMinutes"
            onChange={(e) => setMins(e.target.value.trim())}
            hint={S.grantHint}
            error={minOk ? undefined : S.grantRange}
          />
          <Button type="submit" disabled={!minOk || mins === null || minutes.locked}>
            {S.save}
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
            label={S.keepDays}
            inputMode="numeric"
            value={dayText}
            locked={keep.locked}
            setting="screen.screenshotRetentionDays"
            onChange={(e) => setDays(e.target.value.trim())}
            hint={S.keepHint}
            error={dayOk ? undefined : S.keepRange}
          />
          <Button type="submit" disabled={!dayOk || days === null || keep.locked}>
            {S.save}
          </Button>
        </form>
      </section>

      <section className="settings-section" aria-labelledby="scr-levels">
        <h3 id="scr-levels">{S.levels}</h3>
        <p className="muted">{S.levelsHelp}</p>
        {overrides.locked ? <ManagedNote as="p" setting="screen.tierOverrides" /> : null}
        {entries.length === 0 ? <p className="muted">{S.noneLowered}</p> : null}
        {entries.length ? (
          <ul className="ws-list" aria-label={S.lowered}>
            {entries.map(([name, t]) => (
              <li key={name} className="ws-list-row" aria-label={name}>
                <strong dir="auto">{name}</strong>
                <div className="row ws-row-actions">
                  <SelectField
                    label={S.levelFor({ app: name })}
                    hideLabel
                    value={t}
                    locked={overrides.locked}
                    setting="screen.tierOverrides"
                    onChange={(v) =>
                      setOverrides({ ...overrides.value, [name]: v as ScreenControlTier })
                    }
                    options={LOWER_TIERS.map((x) => ({ value: x, label: TIER_TEXT[x] }))}
                  />
                  <Button
                    variant="ghost"
                    disabled={overrides.locked}
                    aria-label={S.removeApp({ app: name })}
                    onClick={() => {
                      const next = { ...overrides.value };
                      delete next[name];
                      setOverrides(next);
                    }}
                  >
                    {S.remove}
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
            label={S.app}
            value={app}
            maxLength={200}
            disabled={overrides.locked}
            onChange={(e) => setApp(e.target.value)}
          />
          <SelectField
            label={S.level}
            value={tier}
            locked={overrides.locked}
            onChange={(v) => setTier(v as ScreenControlTier)}
            options={LOWER_TIERS.map((x) => ({ value: x, label: TIER_TEXT[x] }))}
          />
          <Button type="submit" disabled={!app.trim() || overrides.locked}>
            {S.lower}
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
  const G = S.grants;
  const grants = (statuses ?? []).flatMap((s) => s.grants.filter((g) => g.active));
  useInterval(() => setNow(Date.now()), 15_000, grants.length > 0);

  const renew = (g: ScreenGrantView) =>
    api.renewScreenGrant(g.computerId, g.id).then(
      () => {
        refresh(g.computerId);
        toast.show(G.renewed({ app: g.app }), { tone: 'success' });
      },
      (err: unknown) => toast.show(G.renewFailed({ error: errorMessage(err) }), { tone: 'error' }),
    );

  const revoke = (g: ScreenGrantView) => {
    setRevoking(null);
    api.revokeScreenGrant(g.computerId, g.id).then(
      () => {
        refresh(g.computerId);
        toast.show(G.revoked({ app: g.app }), { tone: 'success' });
      },
      (err: unknown) => toast.show(G.revokeFailed({ error: errorMessage(err) }), { tone: 'error' }),
    );
  };

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{G.title}</h3>
      {error && statuses === null ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => refresh()}>{G.retry}</Button>
        </div>
      ) : statuses === null ? (
        <Spinner label={G.loading} />
      ) : grants.length === 0 ? (
        <p className="muted">{G.none}</p>
      ) : (
        <ul className="ws-list" aria-label={G.list}>
          {grants.map((g) => (
            <li key={g.id} className="ws-list-row" aria-label={g.app}>
              <div className="ws-source-main">
                <strong dir="auto">{g.app}</strong>
                <span className="muted ws-row-meta">
                  <span>{TIER_TEXT[g.tier]}</span>
                  <span>{remainingText(secondsLeft(g.expiresAt, now))}</span>
                  <span>{computerText(computers.get(g.computerId), g.computerId)}</span>
                </span>
              </div>
              <div className="row ws-row-actions">
                <Button onClick={() => void renew(g)} aria-label={G.renewApp({ app: g.app })}>
                  {G.renew}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setRevoking(g)}
                  aria-label={G.revokeApp({ app: g.app })}
                >
                  {G.revoke}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={revoking ? G.revokeTitle({ app: revoking.app }) : G.revokeThis}
        description={G.revokeHelp}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>{G.cancel}</Button>
            <Button variant="danger" onClick={() => revoking && revoke(revoking)}>
              {G.revoke}
            </Button>
          </>
        }
      />
    </section>
  );
}
