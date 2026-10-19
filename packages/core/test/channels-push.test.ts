// The push leg of notification routing (FR-111, FR-060, docs/13 §6): browser subscriptions only
// to https push services on the allow list, keys checked, the endpoint and auth secret never in a
// view (the secret only in the vault); pushes carry ids, a redacted title and the deep link,
// encrypted to the browser and never the body; `push.detail` chooses more or less; native apps
// through the Relay always get the redacted title; gone subscriptions are dropped and failing ones
// marked; and the router pushes only what may be raised on the OS now (rule and quiet hours).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { SETTINGS, uuidv7, type SettingKey } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import {
  NotificationRouter,
  PushService,
  VAPID_SECRET_REF,
  deepLink,
  endpointProblem,
  hostAllowed,
  pushTitle,
  type AuditRecord,
  type NativePush,
} from '../src/index.ts';
import { ACCOUNT, channelsDb } from './fixtures/channels/env.ts';
import { fakeBrowser, type FakeBrowser } from './fixtures/channels/webpush-browser.ts';

let db: NovaDatabase;
let secrets: MemorySecretStore;
let audit: AuditRecord[];
let settings: Partial<Record<SettingKey, unknown>>;
let sent: { url: string; headers: Record<string, string>; body: Buffer }[];
let status: number;
let push: PushService;

const setting = <K extends SettingKey>(key: K) =>
  Promise.resolve((settings[key] ?? SETTINGS[key].default) as never);

beforeEach(async () => {
  db = await channelsDb();
  secrets = new MemorySecretStore();
  audit = [];
  settings = {};
  sent = [];
  status = 201;
  push = new PushService({
    db,
    secrets,
    setting,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    publicUrl: () => Promise.resolve('https://hub.example.com/x'),
    fetch: (url, init) => {
      sent.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: init?.body as Buffer,
      });
      return Promise.resolve(new Response(status >= 400 ? 'nope' : null, { status }));
    },
  });
});

afterEach(() => db.close());

function notification(over: { kind?: string; title?: string; body?: string; href?: string } = {}) {
  const id = uuidv7();
  const now = new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO notification (id, account_id, kind, title, body, href, dedupe_key, read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
    )
    .run(
      id,
      ACCOUNT,
      over.kind ?? 'approval',
      over.title ?? 'Approval needed',
      over.body ?? 'rm -rf /home/jeremy/private-notes',
      over.href ?? null,
      now,
    );
  return id;
}

async function subscribed(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123'): Promise<{
  browser: FakeBrowser;
  id: string;
}> {
  const browser = fakeBrowser(endpoint);
  const view = await push.subscribe(ACCOUNT, {
    endpoint,
    keys: browser.keys,
    label: 'Phone',
  });
  return { browser, id: view.id };
}

describe('subscriptions', () => {
  it('accepts https push services on the list only, and checks the keys', async () => {
    const b = fakeBrowser('x');
    const sub = (endpoint: string, keys = b.keys) => push.subscribe(ACCOUNT, { endpoint, keys });
    await expect(sub('http://fcm.googleapis.com/fcm/send/1')).rejects.toMatchObject({
      code: 'validation',
      details: { field: 'endpoint' },
    });
    await expect(sub('https://evil.example/collect')).rejects.toMatchObject({ code: 'validation' });
    await expect(sub('https://push.apple.com/x')).rejects.toMatchObject({ code: 'validation' });
    await expect(sub('https://127.0.0.1/x')).rejects.toMatchObject({ code: 'validation' });
    await expect(
      sub('https://web.push.apple.com/x', {
        ...b.keys,
        auth: Buffer.alloc(8).toString('base64url'),
      }),
    ).rejects.toMatchObject({ code: 'validation', details: { field: 'keys' } });
    expect(await sub('https://web.push.apple.com/QW1')).toMatchObject({
      endpointOrigin: 'https://web.push.apple.com',
      status: 'active',
    });
    // The setting decides; it can name a push service of its own.
    settings['push.webPushHosts'] = ['push.example.org'];
    expect((await sub('https://push.example.org/s/1')).endpointOrigin).toBe(
      'https://push.example.org',
    );
    expect(hostAllowed('a.push.apple.com', ['*.push.apple.com'])).toBe(true);
    expect(hostAllowed('push.apple.com', ['*.push.apple.com'])).toBe(false);
    expect(
      endpointProblem(new URL('https://u:p@fcm.googleapis.com/x'), ['fcm.googleapis.com']),
    ).toMatch(/credentials/);
  });

  it('keeps the auth secret in the vault and the endpoint out of views; a renewal replaces keys', async () => {
    const { browser, id } = await subscribed();
    const row = db.raw.prepare('SELECT * FROM push_subscription WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(row)).not.toContain(browser.keys.auth);
    expect(await secrets.get(`secret://push/${id}/auth`)).toBe(browser.keys.auth);
    const views = push.list(ACCOUNT);
    expect(JSON.stringify(views)).not.toContain('abc123');
    expect(views).toEqual([expect.objectContaining({ id, kind: 'webpush', label: 'Phone' })]);
    const again = fakeBrowser(browser.endpoint);
    const renewed = await push.subscribe(ACCOUNT, { endpoint: browser.endpoint, keys: again.keys });
    expect(renewed.id).toBe(id);
    expect(await secrets.get(`secret://push/${id}/auth`)).toBe(again.keys.auth);
    expect(audit.map((a) => a.action)).toEqual(['push.subscribe', 'push.subscribe']);
    await push.remove(ACCOUNT, id);
    expect(push.list(ACCOUNT)).toEqual([]);
    expect(await secrets.get(`secret://push/${id}/auth`)).toBeNull();
    await expect(push.remove(ACCOUNT, id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('makes one VAPID key on first use and keeps it in the vault', async () => {
    const k1 = await push.vapidPublicKey(ACCOUNT);
    expect(k1).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    expect(await push.vapidPublicKey(ACCOUNT)).toBe(k1);
    expect(await secrets.get(VAPID_SECRET_REF)).toContain('"d"');
    expect(audit.filter((a) => a.action === 'push.vapid.create')).toHaveLength(1);
  });
});

describe('pushing', () => {
  it('pushes ids, a redacted title and the deep link, encrypted, never the body', async () => {
    const { browser, id } = await subscribed();
    const href = `/code/${uuidv7()}?approval=${uuidv7()}`;
    const n = notification({ href });
    const out = await push.notify({
      accountId: ACCOUNT,
      notificationId: n,
      kind: 'approval',
      title: 'Approval needed',
      href,
    });
    expect(out.webpush).toEqual({ sent: 1, failed: 0, gone: 0 });
    const req = sent[0]!;
    expect(req.url).toBe(browser.endpoint);
    expect(req.headers).toMatchObject({
      urgency: 'high',
      ttl: '3600',
      'content-encoding': 'aes128gcm',
    });
    expect(req.headers.authorization).toMatch(/^vapid t=/);
    expect(req.body.toString('latin1')).not.toContain('Approval');
    const payload = JSON.parse(browser.decrypt(req.body).toString()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      v: 1,
      id: n,
      category: 'approval',
      title: 'Approval needed in a Code session',
      path: href,
      link: `nova://approval/${href.split('approval=')[1]}`,
    });
    expect(JSON.stringify(payload)).not.toContain('private-notes');
    expect(push.deliveries(ACCOUNT)).toEqual([
      { notificationId: n, target: 'webpush', ref: id, status: 'sent', detail: null },
    ]);
    // The VAPID contact is the public Hub address.
    const claims = JSON.parse(
      Buffer.from(req.headers.authorization!.split('.')[1]!, 'base64url').toString(),
    ) as { sub: string; aud: string };
    expect(claims).toMatchObject({
      sub: 'https://hub.example.com',
      aud: 'https://fcm.googleapis.com',
    });
  });

  it('says more or less as push.detail chooses, and nothing when push is off', async () => {
    const { browser } = await subscribed();
    const n = notification({ kind: 'completion', title: 'Report “Q3 salaries” is ready' });
    const base = {
      accountId: ACCOUNT,
      notificationId: n,
      kind: 'completion' as const,
      title: 'Report “Q3 salaries” is ready',
      href: '/work/r1',
    };
    settings['push.detail'] = 'titles';
    await push.notify(base);
    expect(JSON.parse(browser.decrypt(sent.at(-1)!.body).toString())).toMatchObject({
      title: 'Report “Q3 salaries” is ready',
      link: 'nova://run/r1',
    });
    settings['push.detail'] = 'none';
    await push.notify(base);
    expect(JSON.parse(browser.decrypt(sent.at(-1)!.body).toString()).title).toBe('Nova');
    settings['push.enabled'] = false;
    const before = sent.length;
    expect(await push.notify(base)).toEqual({
      webpush: { sent: 0, failed: 0, gone: 0 },
      native: null,
    });
    expect(sent).toHaveLength(before);
  });

  it('drops a gone subscription and marks one that keeps failing', async () => {
    const a = await subscribed('https://fcm.googleapis.com/fcm/send/a');
    status = 410;
    const n = notification();
    await push.notify({
      accountId: ACCOUNT,
      notificationId: n,
      kind: 'approval',
      title: 't',
      href: null,
    });
    expect(push.list(ACCOUNT)).toEqual([]);
    expect(await secrets.get(`secret://push/${a.id}/auth`)).toBeNull();
    expect(audit.at(-1)).toMatchObject({ action: 'push.subscription.gone', actor: 'system' });
    await subscribed('https://fcm.googleapis.com/fcm/send/b');
    status = 500;
    for (let i = 0; i < 3; i++)
      await push.notify({
        accountId: ACCOUNT,
        notificationId: n,
        kind: 'error',
        title: 't',
        href: null,
      });
    expect(push.list(ACCOUNT)[0]).toMatchObject({ status: 'failing', lastError: 'HTTP 500: nope' });
    status = 201;
    await push.notify({
      accountId: ACCOUNT,
      notificationId: n,
      kind: 'error',
      title: 't',
      href: null,
    });
    expect(push.list(ACCOUNT)[0]).toMatchObject({ status: 'active', lastError: null });
    // A host taken off the list is not sent to any more.
    settings['push.webPushHosts'] = ['push.example.org'];
    const out = await push.notify({
      accountId: ACCOUNT,
      notificationId: n,
      kind: 'error',
      title: 't',
      href: null,
    });
    expect(out.webpush.failed).toBe(1);
    expect(push.deliveries(ACCOUNT)[0]!.detail).toMatch(/push.webPushHosts/);
  });

  it('asks the Relay for native apps with the redacted title only', async () => {
    const calls: Parameters<NativePush['pushNotify']>[] = [];
    let fail = false;
    push.useNative({
      pushNotify: (...args) => {
        calls.push(args);
        return fail
          ? Promise.reject(new Error('the Relay refused the push (HTTP 401)'))
          : Promise.resolve({ sent: 1, skipped: 1, failed: 0 });
      },
    });
    settings['push.detail'] = 'titles';
    const n = notification();
    const out = await push.notify({
      accountId: ACCOUNT,
      notificationId: n,
      kind: 'attention',
      title: 'Nova has a question about “divorce lawyer”',
      href: '/chat/t1?request=r1',
    });
    expect(out.native).toEqual({ sent: 1, skipped: 1, failed: 0 });
    expect(calls[0]).toEqual([
      ACCOUNT,
      {
        id: n,
        category: 'attention',
        title: 'Nova needs your attention in a chat',
        link: 'nova://chat/t1',
      },
    ]);
    fail = true;
    expect(
      (
        await push.notify({
          accountId: ACCOUNT,
          notificationId: n,
          kind: 'attention',
          title: 'x',
          href: null,
        })
      ).native,
    ).toEqual({
      sent: 0,
      skipped: 0,
      failed: 1,
    });
    expect(push.deliveries(ACCOUNT)[0]).toMatchObject({
      target: 'relay',
      status: 'failed',
      detail: expect.stringContaining('401'),
    });
  });

  it('sends a test push to each subscription and reports each one', async () => {
    const { id } = await subscribed();
    expect(await push.test(ACCOUNT)).toEqual({
      sent: 1,
      failed: 0,
      results: [{ subscriptionId: id, status: 'sent', detail: null }],
    });
    status = 400;
    expect((await push.test(ACCOUNT, id)).results[0]).toMatchObject({
      status: 'failed',
      detail: 'HTTP 400: nope',
    });
    await expect(push.test(ACCOUNT, uuidv7())).rejects.toMatchObject({ code: 'not_found' });
    expect(push.counts()).toEqual({ subscriptions: 1, failing: 0 });
  });
});

describe('titles and links', () => {
  it('maps paths to deep links and titles to the chosen detail', () => {
    expect(deepLink('/work/abc-1')).toBe('nova://run/abc-1');
    expect(deepLink('/code/s1/diff')).toBe('nova://code/s1');
    expect(deepLink('/code/sessions/s2')).toBe('nova://code/s2');
    expect(deepLink('/chat/t1?approval=a1')).toBe('nova://approval/a1');
    expect(deepLink('/approvals/a2')).toBe('nova://approval/a2');
    expect(deepLink('/settings/devices')).toBeNull();
    expect(deepLink('/work/../../etc')).toBeNull();
    expect(deepLink(null)).toBeNull();
    expect(pushTitle('approval', 'x', '/work/1', 'redacted')).toBe('Approval needed in a Work run');
    expect(pushTitle('system', 'x', '/work/1', 'redacted')).toBe('Nova');
    expect(pushTitle('error', 'Build failed', null, 'titles')).toBe('Build failed');
    expect(pushTitle('error', '', null, 'titles')).toBe('Something did not work');
  });
});

describe('the router OS leg', () => {
  it('pushes only what may be raised on the OS now', async () => {
    const pushed: string[] = [];
    const router = new NotificationRouter({ db, now: () => new Date('2026-10-17T12:00:00Z') });
    router.usePush({ notify: (n) => (pushed.push(n.notificationId), Promise.resolve()) });
    const n1 = notification({ href: '/work/r1' });
    expect(
      await router.onNotification({
        accountId: ACCOUNT,
        notificationId: n1,
        kind: 'completion',
        title: 't',
        os: true,
      }),
    ).toBe(0);
    expect(pushed).toEqual([n1]);
    // The event said not to raise it (in-app off, or quiet hours at creation).
    await router.onNotification({
      accountId: ACCOUNT,
      notificationId: notification(),
      kind: 'completion',
      title: 't',
      os: false,
    });
    // The category's OS rule is off.
    await router.setRule(ACCOUNT, 'error', {
      inapp: true,
      os: false,
      channels: [],
      bypassQuietHours: false,
    });
    await router.onNotification({
      accountId: ACCOUNT,
      notificationId: notification(),
      kind: 'error',
      title: 't',
    });
    // Quiet hours hold everything but approvals.
    await router.setQuietHours(ACCOUNT, {
      enabled: true,
      start: '11:00',
      end: '13:00',
      timezone: 'UTC',
    });
    await router.onNotification({
      accountId: ACCOUNT,
      notificationId: notification(),
      kind: 'completion',
      title: 't',
    });
    const urgent = notification();
    await router.onNotification({
      accountId: ACCOUNT,
      notificationId: urgent,
      kind: 'approval',
      title: 't',
    });
    expect(pushed).toEqual([n1, urgent]);
    // A failing push never blocks the rest.
    router.usePush({ notify: () => Promise.reject(new Error('down')) });
    await expect(
      router.onNotification({
        accountId: ACCOUNT,
        notificationId: notification(),
        kind: 'approval',
        title: 't',
      }),
    ).resolves.toBe(0);
  });
});

describe('review hardening', () => {
  it('bounds expirationTime and checks it before anything is written', async () => {
    const b = fakeBrowser('https://fcm.googleapis.com/fcm/send/exp');
    for (const expirationTime of [8.64e15 + 1, Number.MAX_SAFE_INTEGER, -1])
      await expect(
        push.subscribe(ACCOUNT, { endpoint: b.endpoint, keys: b.keys, expirationTime }),
      ).rejects.toMatchObject({ code: 'validation', details: { field: 'expirationTime' } });
    expect(await secrets.list('secret://push/')).toEqual([]);
    expect(push.list(ACCOUNT)).toEqual([]);
    const at = Date.parse('2027-01-01T00:00:00Z');
    const v = await push.subscribe(ACCOUNT, {
      endpoint: b.endpoint,
      keys: b.keys,
      expirationTime: at,
    });
    const row = db.raw
      .prepare('SELECT expires_at FROM push_subscription WHERE id = ?')
      .get(v.id) as {
      expires_at: string;
    };
    expect(row.expires_at).toBe('2027-01-01T00:00:00.000Z');
  });

  it('deletes a revoked device’s subscriptions and their secrets, and audits why', async () => {
    const mine = [
      fakeBrowser('https://fcm.googleapis.com/fcm/send/d1a'),
      fakeBrowser('https://fcm.googleapis.com/fcm/send/d1b'),
    ];
    const ids: string[] = [];
    for (const b of mine)
      ids.push(
        (
          await push.subscribe(
            ACCOUNT,
            { endpoint: b.endpoint, keys: b.keys },
            { deviceId: 'device-1' },
          )
        ).id,
      );
    const other = fakeBrowser('https://fcm.googleapis.com/fcm/send/d2');
    const keep = await push.subscribe(
      ACCOUNT,
      { endpoint: other.endpoint, keys: other.keys },
      { deviceId: 'device-2' },
    );
    expect(await push.removeForDevice(ACCOUNT, 'device-1')).toBe(2);
    expect(push.list(ACCOUNT).map((s) => s.id)).toEqual([keep.id]);
    for (const id of ids) expect(await secrets.get(`secret://push/${id}/auth`)).toBeNull();
    expect(await secrets.get(`secret://push/${keep.id}/auth`)).not.toBeNull();
    expect(audit.filter((a) => a.action === 'push.subscription.gone')).toEqual(
      ids.map((id) =>
        expect.objectContaining({
          resource: `push_subscription:${id}`,
          detail: { reason: 'device_revoked', deviceId: 'device-1' },
        }),
      ),
    );
    // Another account's device id never reaches this account's rows.
    expect(await push.removeForDevice('01920000-0000-7000-8000-0000000000ff', 'device-2')).toBe(0);
    expect(push.list(ACCOUNT)).toHaveLength(1);
  });
});
