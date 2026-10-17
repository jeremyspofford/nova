// Notification routing and quiet hours (FR-060): rules per category (in-app, OS, channels),
// quiet-hour windows in a time zone (crossing midnight, chosen weekdays, DST), non-urgent channel
// copies deferred to the end of the window and delivered then, approvals passing by default, and
// the window the agents area reads.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { NotificationRouter, quietWindow, type AuditRecord } from '../src/index.ts';
import { ACCOUNT, Clock, channelsDb } from './fixtures/channels/env.ts';

let db: NovaDatabase;
let clock: Clock;
let router: NotificationRouter;
let audit: AuditRecord[];
let sent: { bindingId: string; text: string }[];
let failNext = false;

function binding(kind = 'slack'): string {
  const id = uuidv7();
  const now = new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO channel_binding (id, account_id, kind, label, external_ref, created_at, updated_at)
       VALUES (?, ?, ?, 'label', ?, ?, ?)`,
    )
    .run(id, ACCOUNT, kind, `ref-${id}`, now, now);
  return id;
}

beforeEach(async () => {
  db = await channelsDb();
  // Saturday 2026-10-17, 21:30 in Berlin (UTC+2).
  clock = new Clock('2026-10-17T19:30:00.000Z');
  audit = [];
  sent = [];
  failNext = false;
  router = new NotificationRouter({
    db,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    now: clock.now,
    timers: clock,
  });
  router.useSender({
    sendTo: (_a, bindingId, text) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('channel down'));
      }
      sent.push({ bindingId, text });
      return Promise.resolve({ id: `r-${sent.length}`, at: clock.now().toISOString() });
    },
  });
  router.start();
});

afterEach(async () => {
  await router.stop();
  db.close();
});

describe('quiet hours', () => {
  const q = {
    start: '22:00',
    end: '07:00',
    timezone: 'Europe/Berlin',
    days: [0, 1, 2, 3, 4, 5, 6],
  };

  it('covers the window across midnight in the time zone', () => {
    expect(quietWindow(q, Date.parse('2026-10-17T19:30:00Z')).active).toBe(false); // 21:30
    const late = quietWindow(q, Date.parse('2026-10-17T20:30:00Z')); // 22:30
    expect(late.active).toBe(true);
    expect(new Date(late.until!).toISOString()).toBe('2026-10-18T05:00:00.000Z'); // 07:00 local
    expect(new Date(late.from!).toISOString()).toBe('2026-10-17T20:00:00.000Z');
    const early = quietWindow(q, Date.parse('2026-10-18T03:00:00Z')); // 05:00
    expect(early.active).toBe(true);
    expect(new Date(early.until!).toISOString()).toBe('2026-10-18T05:00:00.000Z');
    expect(quietWindow(q, Date.parse('2026-10-18T05:00:00Z')).active).toBe(false); // 07:00
  });

  it('respects the weekdays a window starts on, and same-day windows', () => {
    const weekdays = { ...q, days: [1, 2, 3, 4, 5] }; // not Saturday night
    expect(quietWindow(weekdays, Date.parse('2026-10-17T20:30:00Z')).active).toBe(false);
    // Friday night's window still covers Saturday morning.
    expect(quietWindow(weekdays, Date.parse('2026-10-17T03:00:00Z')).active).toBe(true);
    const lunch = { start: '12:00', end: '13:00', timezone: 'UTC', days: [6] };
    expect(quietWindow(lunch, Date.parse('2026-10-17T12:30:00Z'))).toMatchObject({ active: true });
    expect(quietWindow(lunch, Date.parse('2026-10-17T13:30:00Z')).active).toBe(false);
  });

  it('ends at the right instant across a daylight-saving change', () => {
    // Europe/Berlin leaves summer time on 2026-10-25 at 03:00 local.
    const at = Date.parse('2026-10-24T21:00:00Z'); // 23:00 summer time
    expect(new Date(quietWindow(q, at).until!).toISOString()).toBe('2026-10-25T06:00:00.000Z');
  });

  it('is off until set; validates the zone; the agents area reads the window', async () => {
    expect(router.quietHours(ACCOUNT)).toEqual({ enabled: false, active: false, until: null });
    expect(await router.quietWindowAt(ACCOUNT, clock.now())).toBeNull();
    await expect(
      router.setQuietHours(ACCOUNT, {
        enabled: true,
        start: '22:00',
        end: '07:00',
        timezone: 'Mars/Base',
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    const view = await router.setQuietHours(ACCOUNT, {
      enabled: true,
      start: '21:00',
      end: '07:00',
      timezone: 'Europe/Berlin',
    });
    expect(view).toMatchObject({
      enabled: true,
      active: true,
      until: '2026-10-18T05:00:00.000Z',
      days: [0, 1, 2, 3, 4, 5, 6],
    });
    expect(await router.quietWindowAt(ACCOUNT, clock.now())).toEqual({
      start: '2026-10-17T19:00:00.000Z',
      end: '2026-10-18T05:00:00.000Z',
    });
    expect(audit.at(-1)).toMatchObject({ action: 'quiet_hours.set' });
  });
});

describe('routing rules', () => {
  it('defaults: in-app and OS, no channel, approvals pass quiet hours', () => {
    const rules = router.rules(ACCOUNT);
    expect(rules).toHaveLength(5);
    expect(rules.find((r) => r.category === 'approval')).toMatchObject({
      inapp: true,
      os: true,
      channels: [],
      bypassQuietHours: true,
      isDefault: true,
    });
    expect(router.route(ACCOUNT, 'completion')).toEqual({
      inapp: true,
      os: true,
      channels: [],
      deferUntil: null,
    });
  });

  it('sets and resets a rule; channels must be Slack, Teams or webhook bindings', async () => {
    const slack = binding();
    const inapp = binding('inapp');
    await expect(
      router.setRule(ACCOUNT, 'completion', {
        inapp: true,
        os: false,
        channels: [inapp],
        bypassQuietHours: false,
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    const rule = await router.setRule(ACCOUNT, 'completion', {
      inapp: false,
      os: false,
      channels: [slack, slack],
      bypassQuietHours: false,
    });
    expect(rule).toMatchObject({ inapp: false, os: false, channels: [slack], isDefault: false });
    expect(router.inappEnabled(ACCOUNT, 'completion')).toBe(false);
    expect(router.osEnabled(ACCOUNT, 'error')).toBe(true);
    expect((await router.resetRule(ACCOUNT, 'completion')).isDefault).toBe(true);
  });

  it('delivers a channel copy now outside quiet hours, with its receipt', async () => {
    const slack = binding();
    await router.setRule(ACCOUNT, 'error', {
      inapp: true,
      os: true,
      channels: [slack],
      bypassQuietHours: false,
    });
    expect(
      await router.onNotification({
        accountId: ACCOUNT,
        notificationId: 'n1',
        kind: 'error',
        title: 'Run failed',
        body: 'disk full',
      }),
    ).toBe(1);
    expect(sent).toEqual([{ bindingId: slack, text: 'Run failed\ndisk full' }]);
    expect(router.deliveries(ACCOUNT)).toMatchObject([{ status: 'sent', receipt: 'r-1' }]);
    // Nothing for categories without channels.
    expect(
      await router.onNotification({
        accountId: ACCOUNT,
        notificationId: 'n2',
        kind: 'system',
        title: 'x',
      }),
    ).toBe(0);
  });

  it('defers non-urgent copies and the OS during quiet hours; urgent ones pass', async () => {
    const slack = binding();
    await router.setQuietHours(ACCOUNT, {
      enabled: true,
      start: '21:00',
      end: '07:00',
      timezone: 'Europe/Berlin',
    });
    await router.setRule(ACCOUNT, 'completion', {
      inapp: true,
      os: true,
      channels: [slack],
      bypassQuietHours: false,
    });
    await router.setRule(ACCOUNT, 'approval', {
      inapp: true,
      os: true,
      channels: [slack],
      bypassQuietHours: true,
    });
    expect(router.route(ACCOUNT, 'completion')).toEqual({
      inapp: true,
      os: false,
      channels: [slack],
      deferUntil: '2026-10-18T05:00:00.000Z',
    });
    await router.onNotification({
      accountId: ACCOUNT,
      notificationId: 'n1',
      kind: 'completion',
      title: 'Digest ready',
    });
    await router.onNotification({
      accountId: ACCOUNT,
      notificationId: 'n2',
      kind: 'approval',
      title: 'Approval needed',
    });
    expect(sent.map((s) => s.text)).toEqual(['Approval needed']);
    expect(router.osEnabled(ACCOUNT, 'approval')).toBe(true);
    // At the end of the window the deferred copy goes out.
    clock.advance(Date.parse('2026-10-18T05:00:00.000Z') - clock.t);
    await router.flush();
    expect(sent.map((s) => s.text)).toEqual(['Approval needed', 'Digest ready']);
  });

  it('records a failed delivery and keeps going', async () => {
    const a = binding();
    const b = binding();
    await router.setRule(ACCOUNT, 'error', {
      inapp: true,
      os: true,
      channels: [a, b],
      bypassQuietHours: false,
    });
    failNext = true;
    await router.onNotification({
      accountId: ACCOUNT,
      notificationId: 'n1',
      kind: 'error',
      title: 'Oops',
    });
    expect(router.deliveries(ACCOUNT).map((d) => d.status)).toEqual(['failed', 'sent']);
  });
});
