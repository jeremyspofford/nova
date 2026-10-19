// Settings → Notifications → "Notifications on this device" (FR-111, FR-060; docs/13 §6) with a
// fake PushManager and the fake Hub's push rules: turning on asks for permission and subscribes with
// the Hub's VAPID key, the Hub keeps the subscription (the endpoint it refuses is not left behind),
// a test reports what the push service said, turning off ends it on both sides, an old key is
// replaced, other devices can be removed after a confirmation, and every unsupported case says why.
/* eslint-disable @typescript-eslint/require-await */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { pushApi } from '../src/push/api.ts';
import {
  browserPushEnv,
  forgetMine,
  pushSupport,
  recallMine,
  rememberMine,
  sameServerKey,
  subscriptionBody,
  vapidKeyBytes,
} from '../src/push/browser.ts';
import { PushSection } from '../src/push/PushSection.tsx';
import {
  OLD_VAPID_KEY,
  VAPID_KEY,
  fakePushEnv,
  renderWithPush,
  subscriptionView,
} from './fakes-m7-push.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const section = () => screen.getByRole('region', { name: 'Notifications on this device' });

describe('Notifications on this device', () => {
  it('turns on with the Hub key, sends a test, and turns off', async () => {
    const env = fakePushEnv();
    const { api, state } = await renderWithPush(<PushSection env={env} />);
    expect(await screen.findByText('Off for this device.')).toBeTruthy();
    expect(screen.getByText('No device gets push notifications yet.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Turn on for this device' }));
    expect(await screen.findByText('On for this device.')).toBeTruthy();
    expect(env.prompts).toBe(1);
    // Subscribed with the Hub's application server key, user-visible only.
    const call = env.manager.subscribeCalls[0]!;
    expect(call.userVisibleOnly).toBe(true);
    expect([...call.applicationServerKey]).toEqual([...vapidKeyBytes(VAPID_KEY)]);
    // The Hub got the browser's subscription with a readable label.
    expect(api.subscribePush).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://fcm.googleapis.com/fcm/send/browser-1',
        keys: expect.objectContaining({ p256dh: expect.any(String), auth: expect.any(String) }),
        label: expect.any(String),
      }),
    );
    expect(state.subscriptions).toHaveLength(1);
    const list = screen.getByRole('list', { name: 'Devices that get notifications' });
    expect(within(list).getByText('This device')).toBeTruthy();
    expect(within(list).getByText('Through fcm.googleapis.com')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Send a test' }));
    expect(
      await screen.findByText('Sent. It should appear on this device in a few seconds.'),
    ).toBeTruthy();
    expect(api.testPush).toHaveBeenCalledWith(state.subscriptions[0]!.id);

    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('Off for this device.')).toBeTruthy();
    expect(env.manager.current).toBeNull();
    expect(state.subscriptions).toHaveLength(0);
    expect(env.store.size).toBe(0);
  });

  it('recognizes this device after a reload', async () => {
    const env = fakePushEnv({ permission: 'granted' });
    const sub = env.manager.existing('https://fcm.googleapis.com/fcm/send/mine', VAPID_KEY);
    const mine = subscriptionView({ endpoint: sub.endpoint, label: 'Phone' });
    await rememberMine(env, mine.id, sub.endpoint);
    await renderWithPush(<PushSection env={env} />, { push: { subscriptions: [mine] } });
    expect(await screen.findByText('On for this device.')).toBeTruthy();
    expect(screen.getByText('This device')).toBeTruthy();
  });

  it('says why when the browser blocks notifications', async () => {
    const env = fakePushEnv({ prompt: 'denied' });
    const { api } = await renderWithPush(<PushSection env={env} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on for this device' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/blocked for this site/);
    expect(api.subscribePush).not.toHaveBeenCalled();
    expect(env.manager.subscribeCalls).toHaveLength(0);
    // Blocked: no Turn on until the browser allows it again.
    expect(screen.queryByRole('button', { name: 'Turn on for this device' })).toBeNull();
    expect(screen.getByText(/Blocked on this device/)).toBeTruthy();

    cleanup();
    const later = fakePushEnv({ prompt: 'default' });
    await renderWithPush(<PushSection env={later} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on for this device' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/needs your permission/);
  });

  it('does not leave a subscription the Hub refused', async () => {
    const env = fakePushEnv();
    env.manager.nextEndpoint = 'https://push.evil.example/x';
    const { state } = await renderWithPush(<PushSection env={env} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on for this device' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not turn on notifications: push.evil.example is not a push service this Hub sends to (push.webPushHosts)',
    );
    expect(env.manager.current).toBeNull();
    expect(state.subscriptions).toHaveLength(0);
    expect(screen.getByText('Off for this device.')).toBeTruthy();
  });

  it('replaces a subscription made with an older Hub key', async () => {
    const env = fakePushEnv({ permission: 'granted' });
    const old = env.manager.existing('https://fcm.googleapis.com/fcm/send/old', OLD_VAPID_KEY);
    await renderWithPush(<PushSection env={env} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on for this device' }));
    expect(await screen.findByText('On for this device.')).toBeTruthy();
    expect(old.unsubscribed).toBe(true);
    expect(env.manager.subscribeCalls).toHaveLength(1);
    expect(env.prompts).toBe(0);
  });

  it('reports a failed and a gone test push', async () => {
    const env = fakePushEnv({ permission: 'granted' });
    const sub = env.manager.existing('https://fcm.googleapis.com/fcm/send/mine', VAPID_KEY);
    const mine = subscriptionView({ endpoint: sub.endpoint });
    await rememberMine(env, mine.id, sub.endpoint);
    const { state } = await renderWithPush(<PushSection env={env} />, {
      push: {
        subscriptions: [mine],
        outcomes: { [mine.id]: { status: 'failed', detail: '429 Too Many Requests' } },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Send a test' }));
    expect(
      await screen.findByText('The push service did not take it: 429 Too Many Requests.'),
    ).toBeTruthy();
    state.outcomes[mine.id] = { status: 'gone' };
    await userEvent.click(screen.getByRole('button', { name: 'Send a test' }));
    expect(await screen.findByText(/subscription is gone/)).toBeTruthy();
    expect(await screen.findByText('Off for this device.')).toBeTruthy();
  });

  it('removes another device after asking', async () => {
    const env = fakePushEnv();
    const other = subscriptionView({
      label: 'Firefox on Linux',
      status: 'failing',
      lastError: '410 Gone',
      lastSuccessAt: '2026-10-01T11:00:00.000Z',
    });
    const { state } = await renderWithPush(<PushSection env={env} />, {
      push: { subscriptions: [other] },
    });
    expect(await screen.findByText('Failing: 410 Gone')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Firefox on Linux' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Stop notifications on Firefox on Linux?',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.subscriptions).toHaveLength(0);
    expect(screen.getByText('No device gets push notifications yet.')).toBeTruthy();
  });

  it('keeps the dialog open with the reason when removing fails', async () => {
    const env = fakePushEnv();
    const other = subscriptionView({ label: 'Tablet' });
    const { push } = await renderWithPush(<PushSection env={env} />, {
      push: { subscriptions: [other] },
    });
    push.failNext.unsubscribePush = new ApiError(500, {
      code: 'server_error',
      message: 'The Hub could not remove it.',
      retryable: true,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Tablet' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The Hub could not remove it.',
    );
  });

  it('saves the detail level and the Hub switch, and warns while push is off', async () => {
    const env = fakePushEnv();
    const { hub } = await renderWithPush(<PushSection env={env} />, {
      settings: { 'push.enabled': false },
    });
    expect(await screen.findByText(/This Hub sends no push notifications now/)).toBeTruthy();
    const group = screen.getByRole('group', { name: 'What a notification says' });
    expect(
      within(group).getByRole<HTMLInputElement>('radio', {
        name: 'The kind and where (recommended)',
      }).checked,
    ).toBe(true);
    await userEvent.click(within(group).getByRole('radio', { name: 'Nothing' }));
    await waitFor(() => expect(hub.state.settings['push.detail']).toBe('none'));
    await userEvent.click(screen.getByRole('switch', { name: 'Send push notifications' }));
    await waitFor(() => expect(hub.state.settings['push.enabled']).toBe(true));
    expect(screen.queryByText(/This Hub sends no push notifications now/)).toBeNull();
  });

  it('shows the managed lock on the detail level', async () => {
    await renderWithPush(<PushSection env={fakePushEnv()} />, {
      managed: { 'push.detail': 'none' },
    });
    const group = await screen.findByRole('group', { name: 'What a notification says' });
    expect((group as HTMLFieldSetElement).disabled).toBe(true);
    expect(within(group).getByText('Managed by your organization')).toBeTruthy();
  });

  it('retries when the Hub cannot be reached', async () => {
    const { push } = await renderWithPush(<PushSection env={fakePushEnv()} />, {
      fail: { listPushSubscriptions: new TypeError('Failed to fetch') },
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/Cannot reach the Hub/);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Off for this device.')).toBeTruthy();
    expect(push.api.listPushSubscriptions).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ secure: false }, /not on a secure connection/],
    [{ pushManager: false, iosTab: true }, /Add to Home Screen/],
    [{ pushManager: false }, /cannot receive push notifications/],
    [{ worker: false }, /background worker is not running/],
    [{ permission: 'unsupported' as const }, /cannot receive push notifications/],
  ])('says why it cannot work here (%o)', async (over, text) => {
    await renderWithPush(<PushSection env={fakePushEnv(over)} />);
    expect(await within(section()).findByText(text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn on for this device' })).toBeNull();
  });
});

describe('push helpers', () => {
  it('matches keys, builds the body and remembers this browser by a hash', async () => {
    const env = fakePushEnv();
    const sub = env.manager.existing('https://fcm.googleapis.com/x', VAPID_KEY);
    expect(sameServerKey(sub, VAPID_KEY)).toBe(true);
    expect(sameServerKey(sub, OLD_VAPID_KEY)).toBe(false);
    expect(subscriptionBody(sub, 'Phone')).toMatchObject({
      endpoint: sub.endpoint,
      label: 'Phone',
    });
    const keyless = { ...sub, endpoint: sub.endpoint, toJSON: () => ({ endpoint: 'x' }) };
    expect(subscriptionBody(keyless as never, 'x')).toBeNull();
    await rememberMine(env, 'ps1', sub.endpoint);
    expect([...env.store.values()].join()).not.toContain('fcm.googleapis.com');
    expect(await recallMine(env, sub.endpoint)).toBe('ps1');
    expect(await recallMine(env, 'https://other')).toBeNull();
    forgetMine(env);
    expect(await recallMine(env, sub.endpoint)).toBeNull();
    env.store.set('nova.push.subscription', '{bad');
    expect(await recallMine(env, sub.endpoint)).toBeNull();
    expect(await pushSupport(fakePushEnv())).toMatchObject({ ok: true });
  });
});

describe('the push client and the browser', () => {
  it('calls the Hub routes', async () => {
    const calls: unknown[][] = [];
    const api = pushApi(async <T,>(...a: unknown[]) => {
      calls.push(a);
      return Promise.resolve({} as T);
    });
    await api.getPushVapidKey();
    await api.listPushSubscriptions();
    await api.subscribePush({ endpoint: 'https://x', keys: { p256dh: 'a', auth: 'b' } });
    await api.unsubscribePush('a b');
    await api.testPush();
    await api.testPush('s1');
    expect(calls).toEqual([
      ['GET', '/api/v1/push/vapid-key'],
      ['GET', '/api/v1/push/subscriptions'],
      [
        'POST',
        '/api/v1/push/subscriptions',
        { endpoint: 'https://x', keys: { p256dh: 'a', auth: 'b' } },
      ],
      ['DELETE', '/api/v1/push/subscriptions/a%20b'],
      ['POST', '/api/v1/push/test', {}],
      ['POST', '/api/v1/push/test', { subscriptionId: 's1' }],
    ]);
  });

  it('reads the browser: permission, the worker and its PushManager', async () => {
    const requestPermission = vi.fn(async () => 'granted' as const);
    vi.stubGlobal(
      'Notification',
      Object.assign(function Notification() {}, { permission: 'default', requestPermission }),
    );
    vi.stubGlobal('PushManager', function PushManager() {});
    const reg = { pushManager: { getSubscription: async () => null } };
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { getRegistration: async () => reg },
      configurable: true,
    });
    try {
      const env = browserPushEnv();
      expect(env.pushManager).toBe(true);
      expect(env.iosTab).toBe(false);
      expect(env.permission()).toBe('default');
      expect(await env.requestPermission()).toBe('granted');
      expect(await env.registration()).toBe(reg);
      env.storage?.setItem('k', 'v');
      expect(env.storage?.getItem('k')).toBe('v');
      env.storage?.removeItem('k');
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
    vi.unstubAllGlobals();
    const bare = browserPushEnv();
    expect(bare.permission()).toBe('unsupported');
    expect(await bare.requestPermission()).toBe('unsupported');
    expect(await bare.registration()).toBeNull();
  });
});
