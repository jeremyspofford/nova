// Delivery of scheduled results (FR-187): receipts from the notification center, signed webhooks
// (HMAC-SHA256 with the per-schedule secret), the https-only and private-address guard with a
// pinned DNS answer, and the outcome when a webhook fails.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import {
  deliverAll,
  httpsTransport,
  notificationChannel,
  pinnedLookup,
  publicAddress,
  signWebhook,
  webhookChannel,
  webhookSecretRef,
  webhookUrlProblem,
  type DeliveryChannel,
  type DeliveryKind,
  type DeliveryRequest,
  type ScheduleInput,
  type WebhookRequest,
} from '../src/index.ts';
import { ACCOUNT, makeHarness, type Harness } from './scheduler-helpers.ts';

const req: DeliveryRequest = {
  accountId: ACCOUNT,
  scheduleId: 'sched-1',
  title: 'Daily digest',
  runId: 'run-1',
  threadId: 'thread-1',
  fireId: 'fire-1',
  message: 'Three things happened.',
  firedAt: '2026-05-01T09:00:00.000Z',
};
const now = () => new Date('2026-05-01T09:05:00.000Z');

describe('webhook URLs', () => {
  it('accepts public https only', () => {
    expect(webhookUrlProblem('https://hooks.example.com/x?y=1')).toBeNull();
    expect(webhookUrlProblem('https://93.184.216.34/x')).toBeNull();
    expect(webhookUrlProblem(undefined)).toMatch(/needs a URL/);
    expect(webhookUrlProblem('http://hooks.example.com')).toMatch(/https/);
    expect(webhookUrlProblem('ftp://hooks.example.com')).toMatch(/https/);
    expect(webhookUrlProblem('https://a:b@hooks.example.com')).toMatch(/credentials/);
    for (const host of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.5',
      '169.254.169.254',
      '[::1]',
      '[fd00::1]',
      'localhost',
      'a.localhost',
      'nas.local',
      'svc.internal',
      'intranet',
    ])
      expect(webhookUrlProblem(`https://${host}/hook`), host).toMatch(/private or local/);
    expect(webhookUrlProblem('::not a url')).toMatch(/not a URL/);
  });

  it('refuses a host that resolves to a private address and pins the checked one', async () => {
    await expect(
      publicAddress('evil.example.com', () => Promise.resolve(['8.8.8.8', '10.0.0.7'])),
    ).rejects.toThrow(/private or local/);
    await expect(publicAddress('none.example.com', () => Promise.resolve([]))).rejects.toThrow(
      /could not be resolved/,
    );
    expect(await publicAddress('ok.example.com', () => Promise.resolve(['8.8.4.4']))).toBe(
      '8.8.4.4',
    );
    expect(await publicAddress('[2001:db8::1]', () => Promise.reject(new Error('no DNS')))).toBe(
      '2001:db8::1',
    );
    expect(await publicAddress('x.example.com', () => Promise.resolve(['127.0.0.1']), true)).toBe(
      '127.0.0.1',
    );
    const lookup = pinnedLookup('8.8.4.4');
    const one = await new Promise<unknown[]>((resolve) =>
      lookup('rebound.example.com', {}, (...args: unknown[]) => resolve(args)),
    );
    expect(one).toEqual([null, '8.8.4.4', 4]);
    const all = await new Promise<unknown[]>((resolve) =>
      lookup('rebound.example.com', { all: true }, (...args: unknown[]) => resolve(args)),
    );
    expect(all).toEqual([null, [{ address: '8.8.4.4', family: 4 }]]);
  });

  describe('the https transport', () => {
    let server: Server | null = null;
    afterEach(() => {
      server?.close();
      server = null;
    });

    it('never connects to a private address', async () => {
      const send = httpsTransport({ resolveHost: () => Promise.resolve(['127.0.0.1']) });
      await expect(
        send({
          url: new URL('https://rebinding.example.com/hook'),
          headers: {},
          body: '{}',
          signal: AbortSignal.timeout(2000),
        }),
      ).rejects.toThrow(/private or local/);
    });

    it('connects to the pinned address, whatever the name', async () => {
      let connections = 0;
      server = createServer((socket) => {
        connections++;
        socket.destroy();
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const send = httpsTransport({
        resolveHost: () => Promise.resolve(['127.0.0.1']),
        allowPrivate: true,
      });
      await expect(
        send({
          url: new URL(`https://hooks.example.invalid:${port}/hook`),
          headers: { 'content-type': 'application/json' },
          body: '{"a":1}',
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow();
      expect(connections).toBe(1);
    });
  });
});

describe('channels', () => {
  it('signs webhook bodies with the schedule secret and treats 2xx as the receipt', async () => {
    const secrets = new MemorySecretStore();
    await secrets.put(webhookSecretRef('sched-1'), 'shh');
    const sent: WebhookRequest[] = [];
    let status = 202;
    const channel = webhookChannel({
      secrets,
      now,
      transport: (r) => (sent.push(r), Promise.resolve({ status })),
    });
    const ok = await channel.deliver(req, { kind: 'webhook', ref: 'https://hooks.example.com/n' });
    expect(ok).toEqual({ receipt: 'webhook:fire-1:202' });
    const r = sent[0]!;
    expect(r.url.href).toBe('https://hooks.example.com/n');
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body).toEqual({
      scheduleId: 'sched-1',
      runId: 'run-1',
      fireId: 'fire-1',
      title: 'Daily digest',
      summary: 'Three things happened.',
      firedAt: '2026-05-01T09:00:00.000Z',
      deliveredAt: '2026-05-01T09:05:00.000Z',
    });
    const ts = r.headers['x-nova-timestamp']!;
    expect(ts).toBe(String(Date.parse('2026-05-01T09:05:00Z') / 1000));
    const expected = createHmac('sha256', 'shh').update(`${ts}.${r.body}`).digest('hex');
    expect(r.headers['x-nova-signature']).toBe(`sha256=${expected}`);
    expect(signWebhook('shh', ts, r.body)).toBe(`sha256=${expected}`);
    expect(r.headers['x-nova-delivery']).toBe('fire-1');
    expect(JSON.stringify(r)).not.toContain('"shh"');

    status = 500;
    expect(
      await channel.deliver(req, { kind: 'webhook', ref: 'https://hooks.example.com/n' }),
    ).toEqual({
      receipt: null,
      error: 'the webhook answered 500',
    });
    const failing = webhookChannel({
      secrets,
      now,
      transport: () =>
        Promise.reject(
          Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
        ),
    });
    expect(
      (await failing.deliver(req, { kind: 'webhook', ref: 'https://hooks.example.com/n' })).error,
    ).toBe('the webhook could not be reached: ECONNREFUSED');
    expect(
      (await channel.deliver(req, { kind: 'webhook', ref: 'http://hooks.example.com/n' })).error,
    ).toMatch(/https/);
    const noSecret = await channel.deliver(
      { ...req, scheduleId: 'other' },
      {
        kind: 'webhook',
        ref: 'https://hooks.example.com/n',
      },
    );
    expect(noSecret).toEqual({ receipt: null, error: 'the webhook signing secret is missing' });
  });

  it('redacts secrets in what leaves the Hub', async () => {
    const secrets = new MemorySecretStore();
    await secrets.put(webhookSecretRef('sched-1'), 'shh');
    const sent: WebhookRequest[] = [];
    const channel = webhookChannel({
      secrets,
      now,
      transport: (r) => (sent.push(r), Promise.resolve({ status: 200 })),
    });
    await channel.deliver(
      { ...req, message: 'the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' },
      { kind: 'webhook', ref: 'https://hooks.example.com/n' },
    );
    expect(sent[0]!.body).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('gives notification ids as receipts, and none when the notifier cannot', async () => {
    const created: unknown[] = [];
    const withIds = notificationChannel(() => ({
      create: (n) => (created.push(n), Promise.resolve({ id: 'n-1' })),
    }));
    expect(await withIds.deliver(req, { kind: 'inapp' })).toEqual({ receipt: 'n-1' });
    expect(created[0]).toMatchObject({ href: '/work/run-1', dedupeKey: 'schedule-run:run-1' });
    const off = notificationChannel(() => ({ create: () => Promise.resolve(null) }));
    expect((await off.deliver(req, { kind: 'inapp' })).receipt).toBeNull();
    const silent = notificationChannel(() => ({ notify: () => Promise.resolve() }));
    expect(await silent.deliver(req, { kind: 'os' })).toEqual({
      receipt: null,
      error: 'the notifier accepted it but gave no receipt',
    });
    const none = notificationChannel(() => null);
    expect((await none.deliver(req, { kind: 'inapp' })).error).toMatch(/not available/);
    const broken = notificationChannel(() => ({
      create: () => Promise.reject(new Error('db locked')),
    }));
    expect((await broken.deliver(req, { kind: 'inapp' })).error).toMatch(/db locked/);
  });

  it('delivers to every target and survives a channel that throws', async () => {
    const channels = new Map<DeliveryKind, DeliveryChannel>([
      ['inapp', { deliver: () => Promise.resolve({ receipt: 'n-1' }) }],
      ['webhook', { deliver: () => Promise.reject(new Error('boom')) }],
    ]);
    expect(
      await deliverAll(channels, req, [
        { kind: 'inapp' },
        { kind: 'webhook', ref: 'https://h.example.com' },
        { kind: 'email', ref: 'me@example.com' },
      ]),
    ).toEqual([
      { kind: 'inapp', receipt: 'n-1' },
      { kind: 'webhook', ref: 'https://h.example.com', receipt: null, error: 'boom' },
      {
        kind: 'email',
        ref: 'me@example.com',
        receipt: null,
        error: 'email delivery is not available',
      },
    ]);
  });
});

describe('webhook delivery of a scheduled run', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  const hook = (ref: string): ScheduleInput => ({
    when: { cron: '0 * * * *' },
    timezone: 'UTC',
    instructions: 'Post the status.',
    deliveryTargets: [{ kind: 'webhook', ref }],
  });

  it('is done with a 2xx receipt and output_missing on a failure, with the network audited', async () => {
    const sent: WebhookRequest[] = [];
    let status = 200;
    h = await makeHarness('2026-05-01T08:30:00.000Z', {
      webhookTransport: (r) => (sent.push(r), Promise.resolve({ status })),
    });
    const s = await h.svc.create(ACCOUNT, hook('https://hooks.example.com/status'));
    await h.clock.advanceTo('2026-05-01T09:00:00Z', h.svc);
    h.runs.finish('run-1', 'done', 'All systems normal.');
    await h.svc.idle();
    const secret = await h.secrets.get(`secret://schedule/${s.id}/webhook`);
    const r = sent[0]!;
    expect(r.headers['x-nova-signature']).toBe(
      signWebhook(secret!, r.headers['x-nova-timestamp']!, r.body),
    );
    expect(JSON.parse(r.body)).toMatchObject({
      scheduleId: s.id,
      runId: 'run-1',
      summary: 'All systems normal.',
    });
    expect((await h.svc.history(ACCOUNT, s.id))[0]?.outcome).toBe('done');

    status = 503;
    await h.clock.advanceTo('2026-05-01T10:00:00Z', h.svc);
    h.runs.finish('run-2');
    await h.svc.idle();
    expect((await h.svc.history(ACCOUNT, s.id))[0]?.outcome).toBe('output_missing');
    expect(
      h.audit
        .filter((a) => a.action === 'schedule.webhook')
        .map((a) => [a.kind, a.resource, a.decision]),
    ).toEqual([
      ['network', 'hooks.example.com', 'delivered'],
      ['network', 'hooks.example.com', 'failed'],
    ]);
  });

  it('ends output_missing when the webhook host resolves to a private address', async () => {
    h = await makeHarness('2026-05-01T08:30:00.000Z', {
      webhookTransport: httpsTransport({ resolveHost: () => Promise.resolve(['169.254.169.254']) }),
    });
    const s = await h.svc.create(ACCOUNT, hook('https://metadata.example.com/latest'));
    await h.clock.advanceTo('2026-05-01T09:00:00Z', h.svc);
    h.runs.finish('run-1');
    await h.svc.idle();
    expect((await h.svc.history(ACCOUNT, s.id))[0]?.outcome).toBe('output_missing');
    const done = h.events.events.find((e) => e.name === 'schedule.completed');
    expect(String(done?.payload['detail'])).toMatch(/private or local/);
  });
});
