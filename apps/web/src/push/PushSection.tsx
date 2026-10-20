// Settings → Notifications → "Notifications on this device" (FR-111, FR-060; docs/13 §6): Web Push,
// so approvals, finished work and errors reach this device even when Nova is closed. Turn on asks
// the browser for permission and subscribes with the Hub's VAPID key; Turn off unsubscribes here
// and on the Hub; Send a test pushes one to this device. The detail level (`push.detail`) says how
// much a push may say; a push never carries message text, secrets or file contents, and opening it
// goes to the run, the session or the approval in its thread. The devices that get pushes are
// listed (by name and push service only: the endpoint is a capability the Hub never returns), each
// with Remove, which asks first.
import { useCallback, useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { PushDetailLevel, PushSubscriptionView, PushTestView } from '@nova/shared';
import { Button, Icon, RadioGroup, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { detectPlatform } from '../join/platform.ts';
import { ConfirmDialog } from '../netsurface/parts.tsx';
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { usePushApi } from './api.ts';
import {
  SUPPORT_TEXT,
  browserPushEnv,
  forgetMine,
  pushSupport,
  recallMine,
  rememberMine,
  sameServerKey,
  subscriptionBody,
  vapidKeyBytes,
  type PermissionState,
  type PushEnv,
  type PushSubscriptionLike,
  type PushSupport,
} from './browser.ts';
import { PUSH_TEXT as S } from './strings.ts';
import './push.css';

/** How much a push may say (`push.detail`). */
export const DETAIL_TEXT = defineMessages('push.detail', {
  none: {
    label: 'Nothing',
    description: 'Every notification says only “Nova”. Open it to see what happened.',
  },
  redacted: {
    label: 'The kind and where (recommended)',
    description:
      'For example “Approval needed in a Code session” or “A task finished in a Work run”.',
  },
  titles: {
    label: 'Titles',
    description:
      'The notification’s title, such as the name of a run. Never message text, secrets or file contents.',
  },
});

const DETAIL_LEVELS: PushDetailLevel[] = ['none', 'redacted', 'titles'];

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** What the push service said about a test, in the active locale (the detail is its own text). */
function testText(r: PushTestView): { ok: boolean; text: string } {
  const one = r.results[0];
  if (!one) return { ok: false, text: S.test.nobody };
  if (one.status === 'sent') return { ok: true, text: S.test.sent };
  if (one.status === 'gone') return { ok: false, text: S.test.gone };
  return {
    ok: false,
    text: one.detail ? S.test.refusedDetail({ detail: one.detail }) : S.test.refused,
  };
}

interface HubSide {
  vapidKey: string;
  items: PushSubscriptionView[];
}

export function PushSection({
  env: givenEnv,
  hubSettingsNote,
}: {
  env?: PushEnv;
  /**
   * Said in place of the Hub-wide switches (M8 member mode): someone who cannot change the Hub's
   * settings sees who sets them, and no warning about a value they cannot read.
   */
  hubSettingsNote?: string;
}) {
  const api = usePushApi();
  const settings = useSettings();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [env] = useState<PushEnv>(() => givenEnv ?? browserPushEnv());
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [permission, setPermission] = useState<PermissionState>(() => env.permission());
  const [hub, setHub] = useState<HubSide | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [sub, setSub] = useState<PushSubscriptionLike | null>(null);
  const [mineId, setMineId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'on' | 'off' | 'test' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [tested, setTested] = useState<PushTestView | null>(null);
  const [removing, setRemoving] = useState<PushSubscriptionView | null>(null);

  const enabled = settings.get('push.enabled');
  const detail = settings.get('push.detail');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const s = await pushSupport(env);
      let current: PushSubscriptionLike | null = null;
      if (s.ok) current = await s.registration.pushManager.getSubscription().catch(() => null);
      const id = current ? await recallMine(env, current.endpoint) : null;
      if (!alive) return;
      setSupport(s);
      setSub(current);
      setMineId(id);
    })();
    return () => {
      alive = false;
    };
  }, [env]);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getPushVapidKey(), api.listPushSubscriptions()]).then(
      ([key, list]) => {
        if (!alive) return;
        setHub({ vapidKey: key.publicKey, items: list.items });
        setLoadError(null);
      },
      (err: unknown) => alive && setLoadError(err),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  const mine = hub && mineId ? (hub.items.find((s) => s.id === mineId) ?? null) : null;
  const on = sub !== null && mine !== null && mine.status !== 'gone';

  const upsert = useCallback((view: PushSubscriptionView) => {
    setHub((h) => (h ? { ...h, items: [view, ...h.items.filter((s) => s.id !== view.id)] } : h));
  }, []);
  const drop = useCallback((id: string) => {
    setHub((h) => (h ? { ...h, items: h.items.filter((s) => s.id !== id) } : h));
  }, []);

  const turnOn = async () => {
    if (!support?.ok || !hub || busy) return;
    setBusy('on');
    setFailure(null);
    setTested(null);
    let made: PushSubscriptionLike | null = null;
    try {
      const perm = permission === 'granted' ? permission : await env.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        setFailure(perm === 'denied' ? S.permissionBlocked : S.permissionNeeded);
        return;
      }
      const pm = support.registration.pushManager;
      let current = await pm.getSubscription();
      if (current && !sameServerKey(current, hub.vapidKey)) {
        await current.unsubscribe().catch(() => false);
        current = null;
      }
      if (!current) {
        current = await pm.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKeyBytes(hub.vapidKey),
        });
        made = current;
      }
      const body = subscriptionBody(
        current,
        detectPlatform(navigator.userAgent, navigator.maxTouchPoints || 0).name,
      );
      if (!body) throw new Error(S.noKeys);
      const view = await api.subscribePush(body);
      made = null;
      await rememberMine(env, view.id, current.endpoint);
      setSub(current);
      setMineId(view.id);
      upsert(view);
      announce(S.turnedOn);
    } catch (err) {
      // A subscription the Hub did not take is not left behind in the browser.
      if (made) await made.unsubscribe().catch(() => false);
      setFailure(S.turnOnError({ error: errorMessage(err) }));
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async () => {
    if (busy) return;
    setBusy('off');
    setFailure(null);
    setTested(null);
    try {
      if (sub) await sub.unsubscribe().catch(() => false);
      setSub(null);
      forgetMine(env);
      if (mineId) {
        await api.unsubscribePush(mineId).catch(() => undefined);
        drop(mineId);
      }
      setMineId(null);
      announce(S.turnedOff);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!mineId || busy) return;
    setBusy('test');
    setFailure(null);
    setTested(null);
    try {
      const r = await api.testPush(mineId);
      // The result line is a status region: it announces itself.
      setTested(r);
      if (r.results[0]?.status === 'gone') drop(mineId);
    } catch (err) {
      setFailure(S.testError({ error: errorMessage(err) }));
    } finally {
      setBusy(null);
    }
  };

  const saved = (p: Promise<void>) =>
    void p.catch((err: unknown) =>
      toast.show(S.saveError({ error: errorMessage(err) }), { tone: 'error' }),
    );

  const others = hub?.items ?? [];
  const testResult = tested ? testText(tested) : null;

  return (
    <section className="settings-section push-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{S.heading}</h3>
      <p className="muted ws-flush">{S.intro}</p>

      {support === null ? <Spinner label={S.checking} /> : null}
      {support && !support.ok ? (
        <p className="push-state" role="status">
          <Icon name="alert" /> {SUPPORT_TEXT[support.reason]}
        </p>
      ) : null}

      {loadError ? (
        <div role="alert" className="ws-error">
          <p>{errorMessage(loadError, S.loadError)}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{S.retry}</Button>
        </div>
      ) : null}

      {support?.ok && !hub && !loadError ? <Spinner label={S.loading} /> : null}

      {support?.ok && hub ? (
        <>
          <p className="push-state" role="status" data-on={on || undefined}>
            <Icon name={on ? 'check' : 'bell'} />{' '}
            {on ? S.stateOn : permission === 'denied' ? S.stateBlocked : S.stateOff}
          </p>
          {!enabled.value && !hubSettingsNote ? (
            <p className="ws-warning">
              <Icon name="alert" /> {S.hubOff}
            </p>
          ) : null}
          <div className="row push-actions">
            {on ? (
              <>
                <Button onClick={() => void test()} disabled={busy !== null}>
                  {busy === 'test' ? <Spinner /> : <Icon name="bell" />} {S.sendTest}
                </Button>
                <Button variant="ghost" onClick={() => void turnOff()} disabled={busy !== null}>
                  {busy === 'off' ? <Spinner /> : null} {S.turnOff}
                </Button>
              </>
            ) : permission === 'denied' ? null : (
              <Button variant="primary" onClick={() => void turnOn()} disabled={busy !== null}>
                {busy === 'on' ? <Spinner /> : null} {S.turnOn}
              </Button>
            )}
          </div>
          {failure ? (
            <p role="alert" className="nv-field-error">
              {failure}
            </p>
          ) : null}
          {testResult ? (
            <p role="status" className={testResult.ok ? 'push-ok' : 'nv-field-error'}>
              {testResult.text}
            </p>
          ) : null}
        </>
      ) : null}

      {hub ? (
        <div className="stack push-devices">
          <h4 className="push-subhead">{S.devices}</h4>
          {others.length === 0 ? (
            <p className="muted ws-flush">{S.noDevices}</p>
          ) : (
            <ul className="ws-list" aria-label={S.devices}>
              {others.map((s) => (
                <li key={s.id} className="ws-list-row push-row">
                  <div className="push-row-main">
                    <span className="push-row-name">
                      <span dir="auto">{s.label ?? S.aBrowser}</span>
                      {s.id === mineId ? <span className="ws-badge">{S.thisDevice}</span> : null}
                    </span>
                    <span className="muted ws-row-meta">
                      <span>{S.through({ host: hostOf(s.endpointOrigin) })}</span>
                      <span data-status={s.status}>
                        {s.status !== 'active' && s.lastError
                          ? S.statusError({ status: s.status, error: s.lastError })
                          : S.status[s.status]}
                      </span>
                      <span>
                        {s.lastSuccessAt
                          ? S.lastDelivered({ when: formatWhen(s.lastSuccessAt) })
                          : S.nothingDelivered}
                      </span>
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => setRemoving(s)}
                    aria-label={s.label ? S.removeNamed({ name: s.label }) : S.removeThisBrowser}
                  >
                    {S.remove}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <h4 className="push-subhead">{S.forEvery}</h4>
      {hubSettingsNote ? (
        <p className="muted ws-flush">{hubSettingsNote}</p>
      ) : (
        <>
          <SwitchField
            label={S.sendPush}
            description={S.sendPushDescription}
            checked={enabled.value}
            locked={enabled.locked}
            onChange={(v) => saved(settings.set('push.enabled', v))}
          />
          <RadioGroup
            legend={S.whatSays}
            name="push-detail"
            value={detail.value}
            locked={detail.locked}
            onChange={(v) => saved(settings.set('push.detail', v as PushDetailLevel))}
            hint={S.detailHint}
            options={DETAIL_LEVELS.map((k) => ({
              value: k,
              label: DETAIL_TEXT[k].label,
              description: DETAIL_TEXT[k].description,
            }))}
          />
        </>
      )}

      <ConfirmDialog
        open={removing !== null}
        title={removing?.label ? S.stopTitle({ name: removing.label }) : S.stopTitleThis}
        description={S.stopBody}
        confirmLabel={S.remove}
        danger
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          const target = removing;
          if (!target) return;
          await api.unsubscribePush(target.id);
          drop(target.id);
          if (target.id === mineId) {
            await sub?.unsubscribe().catch(() => false);
            forgetMine(env);
            setSub(null);
            setMineId(null);
          }
          setRemoving(null);
          announce(target.label ? S.stopped({ name: target.label }) : S.stoppedBrowser);
        }}
      />
    </section>
  );
}
