// Settings → Notifications → "Notifications on this device" (FR-111, FR-060; docs/13 §6): Web Push,
// so approvals, finished work and errors reach this device even when Nova is closed. Turn on asks
// the browser for permission and subscribes with the Hub's VAPID key; Turn off unsubscribes here
// and on the Hub; Send a test pushes one to this device. The detail level (`push.detail`) says how
// much a push may say; a push never carries message text, secrets or file contents, and opening it
// goes to the run, the session or the approval in its thread. The devices that get pushes are
// listed (by name and push service only: the endpoint is a capability the Hub never returns), each
// with Remove, which asks first.
import { useCallback, useEffect, useId, useState } from 'react';
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
import './push.css';

export const DETAIL_TEXT: Record<PushDetailLevel, { label: string; description: string }> = {
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
};

const STATUS_TEXT: Record<PushSubscriptionView['status'], string> = {
  active: 'Working',
  failing: 'Failing',
  gone: 'Gone',
};

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function testText(r: PushTestView): { ok: boolean; text: string } {
  const one = r.results[0];
  if (!one) return { ok: false, text: 'There was nothing to send to.' };
  if (one.status === 'sent')
    return { ok: true, text: 'Sent. It should appear on this device in a few seconds.' };
  if (one.status === 'gone')
    return {
      ok: false,
      text: 'The push service says this device’s subscription is gone. Turn notifications on again.',
    };
  return {
    ok: false,
    text: `The push service did not take it${one.detail ? `: ${one.detail}` : ''}.`,
  };
}

interface HubSide {
  vapidKey: string;
  items: PushSubscriptionView[];
}

export function PushSection({ env: givenEnv }: { env?: PushEnv }) {
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
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null);
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
        setFailure(
          perm === 'denied'
            ? 'Notifications are blocked for this site. Allow them in the browser’s site settings, then reload.'
            : 'Nova needs your permission to show notifications on this device.',
        );
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
      if (!body) throw new Error('The browser gave a subscription without keys.');
      const view = await api.subscribePush(body);
      made = null;
      await rememberMine(env, view.id, current.endpoint);
      setSub(current);
      setMineId(view.id);
      upsert(view);
      announce('Notifications are on for this device.');
    } catch (err) {
      // A subscription the Hub did not take is not left behind in the browser.
      if (made) await made.unsubscribe().catch(() => false);
      setFailure(`Could not turn on notifications: ${errorMessage(err)}`);
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
      announce('Notifications are off for this device.');
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
      setTested(testText(r));
      if (r.results[0]?.status === 'gone') drop(mineId);
    } catch (err) {
      setFailure(`Could not send a test: ${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const saved = (p: Promise<void>) =>
    void p.catch((err: unknown) =>
      toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' }),
    );

  const others = hub?.items ?? [];

  return (
    <section className="settings-section push-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Notifications on this device</h3>
      <p className="muted ws-flush">
        Push notifications reach this device even when Nova is closed, for the categories turned on
        above. Opening one goes to the run, the Code session or the approval in its conversation.
      </p>

      {support === null ? <Spinner label="Checking this browser" /> : null}
      {support && !support.ok ? (
        <p className="push-state" role="status">
          <Icon name="alert" /> {SUPPORT_TEXT[support.reason]}
        </p>
      ) : null}

      {loadError ? (
        <div role="alert" className="ws-error">
          <p>{errorMessage(loadError, 'Could not load push notifications.')}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}

      {support?.ok && !hub && !loadError ? <Spinner label="Loading push notifications" /> : null}

      {support?.ok && hub ? (
        <>
          <p className="push-state" role="status" data-on={on || undefined}>
            <Icon name={on ? 'check' : 'bell'} />{' '}
            {on
              ? 'On for this device.'
              : permission === 'denied'
                ? 'Blocked on this device. Allow notifications in the browser’s site settings, then reload.'
                : 'Off for this device.'}
          </p>
          {!enabled.value ? (
            <p className="ws-warning">
              <Icon name="alert" /> This Hub sends no push notifications now. Turn on “Send push
              notifications” under For every device.
            </p>
          ) : null}
          <div className="row push-actions">
            {on ? (
              <>
                <Button onClick={() => void test()} disabled={busy !== null}>
                  {busy === 'test' ? <Spinner /> : <Icon name="bell" />} Send a test
                </Button>
                <Button variant="ghost" onClick={() => void turnOff()} disabled={busy !== null}>
                  {busy === 'off' ? <Spinner /> : null} Turn off
                </Button>
              </>
            ) : permission === 'denied' ? null : (
              <Button variant="primary" onClick={() => void turnOn()} disabled={busy !== null}>
                {busy === 'on' ? <Spinner /> : null} Turn on for this device
              </Button>
            )}
          </div>
          {failure ? (
            <p role="alert" className="nv-field-error">
              {failure}
            </p>
          ) : null}
          {tested ? (
            <p role="status" className={tested.ok ? 'push-ok' : 'nv-field-error'}>
              {tested.text}
            </p>
          ) : null}
        </>
      ) : null}

      {hub ? (
        <div className="stack push-devices">
          <h4 className="push-subhead">Devices that get notifications</h4>
          {others.length === 0 ? (
            <p className="muted ws-flush">No device gets push notifications yet.</p>
          ) : (
            <ul className="ws-list" aria-label="Devices that get notifications">
              {others.map((s) => (
                <li key={s.id} className="ws-list-row push-row">
                  <div className="push-row-main">
                    <span className="push-row-name">
                      {s.label ?? 'A browser'}
                      {s.id === mineId ? <span className="ws-badge">This device</span> : null}
                    </span>
                    <span className="muted ws-row-meta">
                      <span>Through {hostOf(s.endpointOrigin)}</span>
                      <span data-status={s.status}>
                        {STATUS_TEXT[s.status]}
                        {s.status !== 'active' && s.lastError ? `: ${s.lastError}` : ''}
                      </span>
                      <span>
                        {s.lastSuccessAt
                          ? `Last delivered ${formatWhen(s.lastSuccessAt)}`
                          : 'Nothing delivered yet'}
                      </span>
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => setRemoving(s)}
                    aria-label={`Remove ${s.label ?? 'this browser'}`}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <h4 className="push-subhead">For every device</h4>
      <SwitchField
        label="Send push notifications"
        description="From this Hub to every device above. Off: no device gets pushes, and Nova shows notifications only while it is open."
        checked={enabled.value}
        locked={enabled.locked}
        onChange={(v) => saved(settings.set('push.enabled', v))}
      />
      <RadioGroup
        legend="What a notification says"
        name="push-detail"
        value={detail.value}
        locked={detail.locked}
        onChange={(v) => saved(settings.set('push.detail', v as PushDetailLevel))}
        hint="Notifications to the Nova phone app go through the Relay and never say more than the kind and where."
        options={(['none', 'redacted', 'titles'] as const).map((k) => ({
          value: k,
          label: DETAIL_TEXT[k].label,
          description: DETAIL_TEXT[k].description,
        }))}
      />

      <ConfirmDialog
        open={removing !== null}
        title={`Stop notifications on ${removing?.label ?? 'this browser'}?`}
        description="It stops getting push notifications from this Hub. They can be turned on again on that device."
        confirmLabel="Remove"
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
          announce(`${target.label ?? 'The browser'} no longer gets notifications.`);
        }}
      />
    </section>
  );
}
