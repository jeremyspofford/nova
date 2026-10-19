// M7 channels routes (FR-110, FR-060, FR-055, FR-201; docs/13 §4-§6): sessions on every new
// route; Telegram and email bindings created through the API (with the schema's checks) and run
// end to end against the mock Bot API and local mail servers; Slack button presses on the inbound
// route; the public approval-link page (GET shows, POST answers once, with no-store, no-referrer
// and a strict CSP); the message log; the MCP subscription refresh; the test notification through
// the push leg; and a schedule's webhook secret rotated and shown once.
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  uuidv7,
  type SettingKey,
} from '@nova/shared';
import {
  ApprovalLinks,
  NotificationService,
  webhookSecretRef,
  type AuditRecord,
  type StartTurnInput,
  type StartedTurn,
  type TurnStarter,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { setupChannels, type ChannelsArea } from '../src/channels.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import { FakeApprovals } from '../../../packages/core/test/fixtures/channels/approvals.ts';
import {
  startMockSlack,
  type MockSlack,
} from '../../../packages/core/test/fixtures/channels/mock-slack.ts';
import {
  startMockTelegram,
  type MockTelegram,
} from '../../../packages/core/test/fixtures/channels/mock-telegram.ts';
import {
  mail,
  startFakeImap,
  startFakeSmtp,
  type FakeImap,
  type FakeSmtp,
} from '../../../packages/core/test/fixtures/channels/mail-servers.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000ea';
const AUTH = { 'x-account': ACCOUNT };

class Turns implements TurnStarter {
  calls: StartTurnInput[] = [];
  hold = false;
  startTurn(input: StartTurnInput): Promise<StartedTurn> {
    this.calls.push(input);
    const turnId = uuidv7();
    const done = this.hold
      ? new Promise<never>(() => undefined)
      : Promise.resolve({
          turnId,
          status: 'completed' as const,
          stop: 'end' as const,
          replyText: `Got it: ${input.text.split('\n').at(-1) ?? ''}`,
          steps: 1,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          activeMs: 1,
        });
    return Promise.resolve({ turnId, messageId: uuidv7(), done });
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

let db: NovaDatabase;
let app: FastifyInstance;
let area: ChannelsArea;
let events: EventStore;
let secrets: MemorySecretStore;
let audit: AuditRecord[];
let settings: Partial<Record<SettingKey, unknown>>;
let turns: Turns;
let tg: MockTelegram;
let slack: MockSlack;
let approvals: FakeApprovals;

async function build() {
  const ctx = {
    config: { host: '127.0.0.1', port: 7419, tls: null, allowedOrigins: [] },
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets,
    dataDir: '/nonexistent',
    registry: {} as never,
    router: {} as never,
    nodes: {} as never,
    threads: {
      create: (_accountId: string, req: { title?: string; mode?: string }) => {
        const id = uuidv7();
        const now = new Date().toISOString();
        db.raw
          .prepare(
            'INSERT INTO thread (id, account_id, mode, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(id, ACCOUNT, req.mode ?? 'chat', req.title ?? null, now, now);
        return Promise.resolve({ id });
      },
    },
    setting: (key: SettingKey) =>
      Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    accountOf: (req: FastifyRequest) => {
      if (req.headers['x-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as Parameters<typeof setupChannels>[0];
  area = await setupChannels(ctx, {
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    slackApiBase: slack.api,
    telegramApiBase: tg.api,
    pollers: { telegramWaitSeconds: 0, idleMs: 20, backoffMs: 50 },
  });
  area.useTurns(turns);
  area.useApprovals(approvals);
  app = Fastify({ logger: false });
  app.setErrorHandler((err, req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON(), requestId: req.id });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', issues: err.issues } });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  events = new EventStore(db);
  secrets = new MemorySecretStore();
  audit = [];
  settings = { 'channels.publicUrl': 'https://hub.example.com' };
  turns = new Turns();
  approvals = new FakeApprovals();
  tg = await startMockTelegram();
  slack = await startMockSlack();
  await build();
});

afterEach(async () => {
  await app.close();
  await area.close();
  await tg.close();
  await slack.close();
  db.close();
});

const json = (r: { body: string }) => JSON.parse(r.body);

function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers = AUTH,
) {
  return app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

async function create(payload: Record<string, unknown>) {
  const r = await call('POST', '/api/v1/channels', payload);
  expect(r.statusCode, r.body).toBe(201);
  return json(r);
}

describe('sessions', () => {
  it('every new route needs a session', async () => {
    for (const [method, url] of [
      ['GET', `/api/v1/channels/${uuidv7()}/messages`],
      ['POST', `/api/v1/mcp/subscriptions/${uuidv7()}/refresh`],
      ['POST', '/api/v1/notification-rules/approval/test'],
      ['POST', `/api/v1/schedules/${uuidv7()}/webhook-secret`],
    ] as const) {
      const r = await call(method, url, method === 'POST' ? {} : undefined, {} as typeof AUTH);
      expect(r.statusCode, url).toBe(401);
    }
  });
});

describe('Telegram through the Hub', () => {
  it('creates with a checked token, connects the webhook, and answers a verified delivery', async () => {
    const bad = await call('POST', '/api/v1/channels', {
      kind: 'telegram',
      externalRef: '42',
      credentials: { botToken: 'not-a-token' },
    });
    expect(bad.statusCode).toBe(400);
    const b = await create({
      kind: 'telegram',
      externalRef: '42',
      label: 'Jeremy',
      audience: 'private',
      credentials: { botToken: tg.botToken },
      config: { mode: 'webhook' },
    });
    expect(JSON.stringify(b)).not.toContain(tg.botToken);
    expect(b.inboundPath).toBe(`/api/v1/channels/${b.id}/inbound`);
    const on = json(await call('POST', `/api/v1/channels/${b.id}/connect`));
    expect(on.statusDetail).toBeNull();
    const hook = tg.of('setWebhook').at(-1)!;
    expect(hook.url).toBe(`https://hub.example.com/api/v1/channels/${b.id}/inbound`);
    const identity = await call('POST', '/api/v1/channel-identities', {
      kind: 'telegram',
      externalId: '42',
      role: 'owner',
    });
    expect(identity.statusCode).toBe(201);
    const update = tg.message({ chat: 42, from: 42, text: 'hello from Telegram' });
    const deliver = (secret: string | null) => {
      const req = tg.webhook(update, secret);
      return app.inject({
        method: 'POST',
        url: `/api/v1/channels/${b.id}/inbound`,
        headers: req.headers,
        payload: Buffer.from(req.rawBody),
      });
    };
    expect((await deliver('wrong-secret')).statusCode).toBe(401);
    const ok = await deliver(String(hook.secret_token));
    expect(json(ok)).toEqual({ ok: true, status: 'started' });
    await vi.waitFor(() =>
      expect(String(tg.of('sendMessage').at(-1)?.text)).toContain('hello from Telegram'),
    );
    const log = json(await call('GET', `/api/v1/channels/${b.id}/messages?direction=in`));
    expect(log.items).toEqual([
      expect.objectContaining({ direction: 'in', status: 'started', sender: '42' }),
    ]);
    expect(log.nextCursor).toBeNull();
    expect((await call('GET', `/api/v1/channels/${b.id}/messages?limit=0`)).statusCode).toBe(400);
    // A page names the next one; a cursor with `before` is refused (M7).
    const first = json(await call('GET', `/api/v1/channels/${b.id}/messages?limit=1`));
    expect(first.items).toHaveLength(1);
    expect(typeof first.nextCursor).toBe('string');
    const rest = json(
      await call('GET', `/api/v1/channels/${b.id}/messages?limit=50&cursor=${first.nextCursor}`),
    );
    expect(rest.items.map((m: { id: string }) => m.id)).not.toContain(first.items[0].id);
    expect(
      (
        await call(
          'GET',
          `/api/v1/channels/${b.id}/messages?cursor=${first.nextCursor}&before=2026-01-01T00:00:00Z`,
        )
      ).statusCode,
    ).toBe(400);
    // The Hub makes the webhook secret: PATCH never replaces it (M7).
    const patch = await call('PATCH', `/api/v1/channels/${b.id}`, {
      credentials: { webhookSecret: 'mine-mine-mine' },
    });
    expect(patch.statusCode).toBe(400);
    expect(json(patch).error.details).toMatchObject({ field: 'credentials.webhookSecret' });
    const list = json(await call('GET', '/api/v1/channels'));
    expect(list.adapters.map((a: { kind: string }) => a.kind)).toContain('telegram');
  });

  it('polls a bot in polling mode from the moment it connects', async () => {
    const b = await create({
      kind: 'telegram',
      externalRef: '42',
      audience: 'private',
      credentials: { botToken: tg.botToken },
    });
    await call('POST', '/api/v1/channel-identities', {
      kind: 'telegram',
      externalId: '42',
      role: 'owner',
    });
    await call('POST', `/api/v1/channels/${b.id}/connect`);
    tg.queue.push(tg.message({ chat: 42, from: 42, text: 'polled hello' }));
    await vi.waitFor(() =>
      expect(turns.calls.map((c) => c.text)).toEqual([expect.stringContaining('polled hello')]),
    );
    await call('POST', `/api/v1/channels/${b.id}/disconnect`);
    expect(area.pollers.groups()).toEqual([]);
  });
});

describe('email through the Hub', () => {
  let imap: FakeImap;
  let smtp: FakeSmtp;
  beforeEach(async () => {
    imap = await startFakeImap();
    smtp = await startFakeSmtp();
  });
  afterEach(async () => {
    await imap.close();
    await smtp.close();
  });

  const config = () => ({
    address: 'nova@example.com',
    imapHost: '127.0.0.1',
    imapPort: imap.port,
    imapSecurity: 'none',
    smtpHost: '127.0.0.1',
    smtpPort: smtp.port,
    smtpSecurity: 'none',
    mode: 'polling',
    authservId: 'mx.example.com',
  });

  it('turning the sender check off needs the confirmation on PATCH, and an authserv-id is a host', async () => {
    const b = await create({
      kind: 'email',
      externalRef: 'jeremy@home.example',
      credentials: { password: imap.password },
      config: config(),
    });
    const off = { config: { senderCheck: 'none' } };
    const refused = await call('PATCH', `/api/v1/channels/${b.id}`, off);
    expect(refused.statusCode).toBe(400);
    expect(json(refused).error.details).toMatchObject({ reason: 'confirm_required' });
    expect(
      (await call('PATCH', `/api/v1/channels/${b.id}`, { ...off, confirmSenderCheckNone: 'yes' }))
        .statusCode,
    ).toBe(400);
    const ok = await call('PATCH', `/api/v1/channels/${b.id}`, {
      ...off,
      confirmSenderCheckNone: true,
    });
    expect(ok.statusCode).toBe(200);
    expect(json(ok).config.senderCheck).toBe('none');
    expect(audit.find((a) => a.action === 'channel.email.sender_check_off')).toBeDefined();
    expect(
      (await call('PATCH', `/api/v1/channels/${b.id}`, { config: { authservId: 'mx example' } }))
        .statusCode,
    ).toBe(400);
    const created = await call('POST', '/api/v1/channels', {
      kind: 'email',
      externalRef: 'sam@home.example',
      credentials: { password: imap.password },
      config: { ...config(), senderCheck: 'none' },
    });
    expect(json(created).error.details).toMatchObject({ field: 'confirmSenderCheckNone' });
  });

  it('refuses plain text off this machine, and runs a mailbox end to end', async () => {
    const plain = await call('POST', '/api/v1/channels', {
      kind: 'email',
      externalRef: 'jeremy@home.example',
      credentials: { password: imap.password },
      config: { ...config(), imapHost: 'imap.example.com' },
    });
    expect(plain.statusCode).toBe(400);
    expect(
      (await call('POST', '/api/v1/channels', { kind: 'email', externalRef: 'not-an-address' }))
        .statusCode,
    ).toBe(400);
    settings['channels.email.pollSeconds'] = 15;
    const b = await create({
      kind: 'email',
      externalRef: 'Jeremy@Home.example',
      audience: 'private',
      credentials: { password: imap.password },
      config: config(),
    });
    expect(b.externalRef).toBe('jeremy@home.example');
    expect(b.config.imapPort).toBe(String(imap.port));
    await call('POST', '/api/v1/channel-identities', {
      kind: 'email',
      externalId: 'jeremy@home.example',
      role: 'owner',
    });
    expect(json(await call('POST', `/api/v1/channels/${b.id}/connect`)).statusDetail).toBeNull();
    // The first read sets the cursor; then new mail starts a turn and the reply goes by SMTP.
    await vi.waitFor(() =>
      expect(db.raw.prepare('SELECT count(*) AS n FROM channel_cursor').get()).toEqual({ n: 1 }),
    );
    await area.pollers.stop();
    imap.deliver(
      mail({
        from: 'jeremy@home.example',
        to: 'nova@example.com',
        subject: 'Trip',
        text: 'book the train',
        auth: 'dmarc=pass header.from=home.example',
      }),
    );
    expect(await area.pollers.pollOnce(b.id)).toBe(1);
    await vi.waitFor(() => expect(smtp.sent.at(-1)?.data).toMatch(/^Subject: Re: Trip$/m));
  });
});

describe('Slack buttons through the inbound route', () => {
  it('a signed press by the owner answers the approval', async () => {
    const c = await create({
      kind: 'slack',
      externalRef: 'D1',
      audience: 'private',
      credentials: { botToken: slack.botToken, signingSecret: slack.signingSecret },
      config: { botUserId: 'UBOT' },
    });
    await call('POST', '/api/v1/channel-identities', {
      kind: 'slack',
      externalId: 'U1',
      role: 'owner',
    });
    turns.hold = true;
    const msg = slack.message({ channel: 'D1', user: 'U1', text: 'post it' });
    const started = json(
      await app.inject({
        method: 'POST',
        url: `/api/v1/channels/${c.id}/inbound`,
        headers: msg.headers,
        payload: Buffer.from(msg.rawBody),
      }),
    );
    expect(started.status).toBe('started');
    const threadId = turns.calls.at(-1)!.threadId;
    const a = approvals.add(threadId);
    const press = slack.interaction({
      user: 'U1',
      channel: 'D1',
      ts: '1.000001',
      value: `nova:a:${a.id}:o`,
    });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${c.id}/inbound`,
      headers: press.headers,
      payload: Buffer.from(press.rawBody),
    });
    expect(json(r)).toEqual({ ok: true, status: 'answered' });
    expect(approvals.decided).toEqual([
      { id: a.id, decision: 'allow_once', by: `channel:${c.id}` },
    ]);
    expect(slack.updates.at(-1)).toMatchObject({ channel: 'D1', ts: '1.000001' });
  });
});

describe('approval links', () => {
  async function link() {
    const imap = await startFakeImap();
    const b = await create({
      kind: 'email',
      externalRef: 'jeremy@home.example',
      audience: 'private',
      credentials: { password: 'pw' },
      config: {
        address: 'nova@example.com',
        imapHost: '127.0.0.1',
        imapPort: imap.port,
        imapSecurity: 'none',
        smtpHost: '127.0.0.1',
        smtpSecurity: 'none',
      },
    });
    await imap.close();
    const a = approvals.add(uuidv7());
    const token = await new ApprovalLinks({ db, secrets }).create({
      accountId: ACCOUNT,
      bindingId: b.id,
      approvalId: a.id,
      expiresAt: new Date(Date.now() + 600_000),
    });
    return { b, a, url: `/api/v1/channels/approval-links/${token}` };
  }

  it('GET shows the choices without a session and changes nothing; POST answers once', async () => {
    const { a, url } = await link();
    const page = await app.inject({ method: 'GET', url });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.body).toContain('<form method="post">');
    expect(page.body).toContain('value="allow_once"');
    expect(page.body).toContain('Post the weekly update');
    expect(approvals.decided).toEqual([]);
    const bad = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'decision=handoff',
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'decision=deny_continue',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('Denied.');
    expect(approvals.decided).toMatchObject([{ id: a.id, decision: 'deny_continue' }]);
    const again = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ decision: 'allow_once' }),
    });
    expect(again.statusCode).toBe(404);
    expect(again.body).toContain('not valid any more');
  });

  it('answers 404 for a made-up or tampered token, escaping what it shows', async () => {
    const { url } = await link();
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/channels/approval-links/<script>' }))
        .statusCode,
    ).toBe(404);
    const tampered = `${url.slice(0, -2)}${url.endsWith('AA') ? 'BB' : 'AA'}`;
    const r = await app.inject({ method: 'GET', url: tampered });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('<script>');
  });
});

describe('notifications, MCP refresh and webhook secrets', () => {
  it('sends a test notification through the routing and its push leg', async () => {
    expect(
      json(await call('POST', '/api/v1/notification-rules/approval/test', {})).error.code,
    ).toBe('capability_missing');
    const notifier = new NotificationService({ db, events });
    area.useNotifier(notifier);
    const pushed: unknown[] = [];
    area.usePush({ notify: (n) => (pushed.push(n), Promise.resolve()) });
    const r = await call('POST', '/api/v1/notification-rules/completion/test', {
      title: 'Hello there',
    });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({
      category: 'completion',
      inapp: true,
      os: true,
      channels: [],
      deferUntil: null,
    });
    await vi.waitFor(() =>
      expect(pushed).toEqual([
        expect.objectContaining({
          kind: 'completion',
          title: 'Hello there',
          href: '/settings/notifications',
        }),
      ]),
    );
    expect(audit.find((a) => a.action === 'notification.test')).toBeDefined();
    expect((await call('POST', '/api/v1/notification-rules/nope/test', {})).statusCode).toBe(400);
  });

  it('refreshes an MCP subscription now, and refuses unknown or removed ones', async () => {
    expect(
      (await call('POST', `/api/v1/mcp/subscriptions/${uuidv7()}/refresh`, {})).statusCode,
    ).toBe(404);
    const now = new Date().toISOString();
    const serverId = uuidv7();
    const triggerId = uuidv7();
    const subId = uuidv7();
    db.raw
      .prepare(
        `INSERT INTO mcp_server (id, account_id, name, transport, command, enabled, created_at, updated_at)
         VALUES (?, ?, 'events', 'stdio', 'x', 1, ?, ?)`,
      )
      .run(serverId, ACCOUNT, now, now);
    db.raw
      .prepare(
        `INSERT INTO trigger (id, account_id, kind, title, action, instructions, enabled, created_at, updated_at)
         VALUES (?, ?, 'mcp_event', 't', 'run', 'do it', 1, ?, ?)`,
      )
      .run(triggerId, ACCOUNT, now, now);
    db.raw
      .prepare(
        `INSERT INTO mcp_event_subscription (id, account_id, mcp_server_id, trigger_id, event_name,
           webhook_secret_ref, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'issue.created', 'secret://x', 'pending', ?, ?)`,
      )
      .run(subId, ACCOUNT, serverId, triggerId, now, now);
    const r = await call('POST', `/api/v1/mcp/subscriptions/${subId}/refresh`, {});
    expect(r.statusCode).toBe(200);
    // No MCP client is wired: it stays pending and says why.
    expect(json(r)).toMatchObject({ id: subId, status: 'pending', lastError: expect.any(String) });
    expect(audit.find((a) => a.action === 'mcp.subscription.refresh')).toMatchObject({
      detail: { subscriptionId: subId, was: 'pending' },
    });
    db.raw.prepare("UPDATE mcp_event_subscription SET status = 'removed' WHERE id = ?").run(subId);
    expect((await call('POST', `/api/v1/mcp/subscriptions/${subId}/refresh`, {})).statusCode).toBe(
      409,
    );
  });

  it('rotates a schedule webhook secret and shows it once', async () => {
    const now = new Date().toISOString();
    const insert = (targets: unknown) => {
      const id = uuidv7();
      db.raw
        .prepare(
          `INSERT INTO schedule (id, account_id, title, interval_seconds, timezone, instructions,
             delivery_targets_json, created_at, updated_at)
           VALUES (?, ?, 'daily', 3600, 'UTC', 'report', ?, ?, ?)`,
        )
        .run(id, ACCOUNT, JSON.stringify(targets), now, now);
      return id;
    };
    const id = insert([{ kind: 'inapp' }, { kind: 'webhook', ref: 'https://example.com/hook' }]);
    const r = await call('POST', `/api/v1/schedules/${id}/webhook-secret`, {});
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = json(r);
    expect(body).toMatchObject({ scheduleId: id, scheme: 'hmac-sha256' });
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await secrets.get(webhookSecretRef(id))).toBe(body.secret);
    const second = json(await call('POST', `/api/v1/schedules/${id}/webhook-secret`, {}));
    expect(second.secret).not.toBe(body.secret);
    expect(await secrets.get(webhookSecretRef(id))).toBe(second.secret);
    expect(audit.filter((a) => a.action === 'schedule.webhook_secret.rotate')).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain(body.secret);
    expect(
      (await call('POST', `/api/v1/schedules/${insert([{ kind: 'inapp' }])}/webhook-secret`, {}))
        .statusCode,
    ).toBe(409);
    expect(
      (await call('POST', `/api/v1/schedules/${uuidv7()}/webhook-secret`, {})).statusCode,
    ).toBe(404);
  });
});
