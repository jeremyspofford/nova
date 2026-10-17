// Event triggers (FR-056, docs/09 §7) and MCP event subscriptions (FR-201, docs/18 J7 step 5):
// webhook triggers authenticated by token and signature, dedupe keys, runs and wakes without the
// user's authority and with the payload fenced off, the hourly cap, channel watches that never
// fire on the agent's own messages, kinds that are not available yet, and the MCP subscription
// lifecycle (subscribe, refresh before expiry, lapse, unsubscribe on removal) with signed
// deliveries accepted and unsigned, stale, forged, oversized and duplicate ones refused.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { SETTINGS, uuidv7, type SettingKey } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import {
  MCP_DELIVERY_MAX_BYTES,
  McpEventService,
  MemoryEventSink,
  TriggerService,
  signMcpDelivery,
  type AuditRecord,
  type McpEventInfo,
  type McpEventSource,
} from '../src/index.ts';
import { signBody } from '../src/channels/signing.ts';
import { eventText, fieldAt } from '../src/channels/triggers.ts';
import {
  ACCOUNT,
  Clock,
  FakeRuns,
  FakeTurns,
  channelsDb,
  insertThread,
  serviceEnv,
} from './fixtures/channels/env.ts';
import { startMockSlack } from './fixtures/channels/mock-slack.ts';

class FakeSource implements McpEventSource {
  connected = true;
  offered: McpEventInfo[] = [{ name: 'ticket.created', description: 'A ticket' }];
  subs = new Map<string, { event: string; url: string; secret: string; ttl: number }>();
  calls: string[] = [];
  failRefresh = false;
  failSubscribe = false;
  ttlMs = 3_600_000;
  #seq = 0;
  now: () => Date = () => new Date();
  events(): McpEventInfo[] | null {
    return this.connected ? this.offered : null;
  }
  subscribe(
    _serverId: string,
    input: { event: string; webhookUrl: string; secret: string; ttlSeconds: number },
  ) {
    this.calls.push(`subscribe:${input.event}`);
    if (this.failSubscribe) return Promise.reject(new Error('server busy'));
    const id = `remote-${++this.#seq}`;
    this.subs.set(id, {
      event: input.event,
      url: input.webhookUrl,
      secret: input.secret,
      ttl: input.ttlSeconds,
    });
    return Promise.resolve({
      remoteId: id,
      expiresAt: new Date(this.now().getTime() + this.ttlMs).toISOString(),
    });
  }
  refresh(_serverId: string, remoteId: string) {
    this.calls.push(`refresh:${remoteId}`);
    if (this.failRefresh) return Promise.reject(new Error('refresh failed'));
    return Promise.resolve({
      expiresAt: new Date(this.now().getTime() + this.ttlMs).toISOString(),
    });
  }
  unsubscribe(_serverId: string, remoteId: string) {
    this.calls.push(`unsubscribe:${remoteId}`);
    this.subs.delete(remoteId);
    return Promise.resolve();
  }
}

let db: NovaDatabase;
let secrets: MemorySecretStore;
let events: MemoryEventSink;
let audit: AuditRecord[];
let clock: Clock;
let runs: FakeRuns;
let turns: FakeTurns;
let triggers: TriggerService;
let mcp: McpEventService;
let source: FakeSource;
let settings: Partial<Record<SettingKey, unknown>>;
const SERVER = '01920000-0000-7000-8000-00000000f001';

beforeEach(async () => {
  db = await channelsDb();
  secrets = new MemorySecretStore();
  events = new MemoryEventSink();
  audit = [];
  clock = new Clock();
  settings = {};
  runs = new FakeRuns();
  turns = new FakeTurns();
  source = new FakeSource();
  source.now = clock.now;
  const setting = <K extends SettingKey>(key: K) =>
    Promise.resolve((settings[key] ?? SETTINGS[key].default) as never);
  triggers = new TriggerService({
    db,
    events,
    secrets,
    setting,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    now: clock.now,
    createThread: (_a, input) => Promise.resolve(insertThread(db, input.title, input.mode)),
  });
  mcp = new McpEventService({
    db,
    events,
    secrets,
    webhookBase: () => Promise.resolve('https://hub.example/'),
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    now: clock.now,
    timers: clock,
    ttlSeconds: 3600,
  });
  triggers.useRuns(runs);
  triggers.useTurns(turns);
  triggers.useSubscriptions(mcp);
  mcp.useTriggers((a, id, e) => triggers.fire(a, id, e));
  mcp.useSource(source);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO mcp_server (id, account_id, name, transport, command, enabled, created_at, updated_at)
       VALUES (?, ?, 'tickets', 'stdio', 'node', 1, ?, ?)`,
    )
    .run(SERVER, ACCOUNT, now, now);
});

afterEach(async () => {
  await mcp.stop();
  db.close();
});

const TOKEN = 't'.repeat(32);
const SECRET = 's'.repeat(40);

function webhookTrigger(over: Record<string, unknown> = {}) {
  return triggers.create(ACCOUNT, {
    kind: 'webhook',
    instructions: 'Triage the alert and summarize it.',
    action: 'run',
    credentials: { token: TOKEN, secret: SECRET },
    ...over,
  } as never);
}

function post(body: string, o: { token?: string; secret?: string; ts?: number; id?: string } = {}) {
  const ts = String(o.ts ?? Math.floor(clock.t / 1000));
  return {
    headers: {
      authorization: `Bearer ${o.token ?? TOKEN}`,
      'x-nova-timestamp': ts,
      'x-nova-signature': signBody(o.secret ?? SECRET, ts, body),
      ...(o.id ? { 'x-nova-event-id': o.id } : {}),
    },
    rawBody: new Uint8Array(Buffer.from(body)),
  };
}

describe('webhook triggers', () => {
  it('stores the token and secret in the secret store and shows where to post', async () => {
    const t = await webhookTrigger();
    expect(t).toMatchObject({
      kind: 'webhook',
      action: 'run',
      available: true,
      webhookPath: `/api/v1/triggers/${t.id}/webhook`,
      enabled: true,
    });
    expect(JSON.stringify(t)).not.toContain(SECRET);
    const row = db.raw.prepare('SELECT * FROM trigger WHERE id = ?').get(t.id) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(await secrets.get(`secret://trigger/${t.id}/secret`)).toBe(SECRET);
    expect(triggers.list(ACCOUNT)).toHaveLength(1);
  });

  it('starts a run without the user authority, with the payload fenced as data', async () => {
    const t = await webhookTrigger();
    const out = await triggers.receiveWebhook(
      t.id,
      post(JSON.stringify({ id: 'evt-1', alert: 'disk full' })),
    );
    expect(out).toMatchObject({ status: 'started', runId: 'run-1' });
    const run = runs.created[0]!;
    expect(run).toMatchObject({
      accountId: ACCOUNT,
      origin: 'trigger',
      originRef: t.id,
      authority: { kind: 'none', origin: 'tool' },
      start: true,
      autonomy: 'standard',
    });
    expect(run.objective).toMatch(
      /^Triage the alert and summarize it\.\n\nAn event arrived from a webhook/,
    );
    expect(run.objective).toContain('not instructions');
    expect(run.objective).toContain('"alert": "disk full"');
    expect(events.events.find((e) => e.name === 'trigger.fired')!.payload).toEqual({
      triggerId: t.id,
      kind: 'webhook',
      dedupeKey: 'evt-1',
    });
    expect(triggers.get(ACCOUNT, t.id).lastFiredAt).not.toBeNull();
    expect(triggers.history(ACCOUNT, t.id)).toMatchObject([
      { dedupeKey: 'evt-1', status: 'started', runId: 'run-1' },
    ]);
  });

  it('dedupes by the event id header, a payload field or the body hash', async () => {
    const t = await webhookTrigger({ dedupeKey: 'event.id' });
    const body = JSON.stringify({ event: { id: 'e-9' } });
    expect((await triggers.receiveWebhook(t.id, post(body))).status).toBe('started');
    expect((await triggers.receiveWebhook(t.id, post(body))).status).toBe('duplicate');
    expect((await triggers.receiveWebhook(t.id, post('{"x":1}', { id: 'h-1' }))).status).toBe(
      'started',
    );
    expect((await triggers.receiveWebhook(t.id, post('{"x":2}', { id: 'h-1' }))).status).toBe(
      'duplicate',
    );
    expect((await triggers.receiveWebhook(t.id, post('plain text'))).status).toBe('started');
    expect((await triggers.receiveWebhook(t.id, post('plain text'))).status).toBe('duplicate');
    expect(runs.created).toHaveLength(3);
    expect(fieldAt({ a: { b: 7 } }, 'a.b')).toBe('7');
    expect(fieldAt({ a: [1] }, 'a.0')).toBeNull();
  });

  it('refuses a bad token, a bad signature, a stale timestamp and an unsigned post', async () => {
    const t = await webhookTrigger();
    const body = '{"id":"x"}';
    for (const req of [
      post(body, { token: 'u'.repeat(32) }),
      post(body, { secret: 'z'.repeat(40) }),
      post(body, { ts: Math.floor(clock.t / 1000) - 600 }),
      { headers: { authorization: `Bearer ${TOKEN}` }, rawBody: new Uint8Array(Buffer.from(body)) },
    ])
      await expect(triggers.receiveWebhook(t.id, req)).rejects.toMatchObject({
        code: 'token_required',
      });
    expect(
      audit.filter((a) => a.action === 'trigger.rejected').map((a) => a.detail?.reason),
    ).toEqual(['bad_token', 'bad_signature', 'stale', 'unsigned']);
    expect(runs.created).toHaveLength(0);
    await expect(triggers.receiveWebhook('nope', post(body))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('wakes an agent with an event turn; a disabled trigger skips', async () => {
    const t = await webhookTrigger({ action: 'wake', agentId: 'agent-1' });
    const out = await triggers.receiveWebhook(t.id, post('{"id":"w1"}'));
    expect(out.status).toBe('started');
    expect(turns.calls[0]).toMatchObject({
      trigger: 'event',
      triggerRef: t.id,
      authority: { kind: 'none', origin: 'tool' },
      authorKind: 'system',
    });
    // The next wake uses the same thread.
    await triggers.receiveWebhook(t.id, post('{"id":"w2"}'));
    expect(turns.calls[1]!.threadId).toBe(turns.calls[0]!.threadId);
    // The agents area's primary thread wins once it is bound.
    const main = insertThread(db, 'main', 'agent');
    triggers.useAgentThreads(() => Promise.resolve(main));
    await triggers.receiveWebhook(t.id, post('{"id":"w3"}'));
    expect(turns.calls[2]!.threadId).toBe(main);
    await triggers.update(ACCOUNT, t.id, { enabled: false });
    expect(await triggers.receiveWebhook(t.id, post('{"id":"w4"}'))).toMatchObject({
      status: 'skipped',
      reason: 'disabled',
    });
  });

  it('skips past the hourly cap and records a failed start', async () => {
    settings['triggers.ratePerHour'] = 2;
    const t = await webhookTrigger();
    const statuses = [];
    for (let i = 0; i < 3; i++)
      statuses.push(
        (await triggers.receiveWebhook(t.id, post(JSON.stringify({ id: `r${i}` })))).status,
      );
    expect(statuses).toEqual(['started', 'started', 'skipped']);
    clock.t += 3_600_001;
    const failing = new TriggerService({
      db,
      events,
      secrets,
      setting: () => Promise.resolve(10 as never),
      now: clock.now,
    });
    expect(
      await failing.fire(ACCOUNT, t.id, {
        dedupeKey: 'f1',
        payload: {},
        origin: 'tool',
        source: 'x',
      }),
    ).toMatchObject({
      status: 'failed',
      reason: 'Work runs are not available',
    });
    expect(triggers.history(ACCOUNT, t.id)[0]).toMatchObject({ status: 'failed' });
  });

  it('updates, validates and deletes (secrets go with it)', async () => {
    const t = await webhookTrigger({ title: 'Alerts' });
    const next = await triggers.update(ACCOUNT, t.id, {
      instructions: 'New instructions',
      autonomy: 'ask_first',
      credentials: { token: 'n'.repeat(32), secret: 'm'.repeat(40) },
    });
    expect(next).toMatchObject({
      title: 'Alerts',
      instructions: 'New instructions',
      autonomy: 'ask_first',
    });
    await expect(triggers.update(ACCOUNT, t.id, { contains: 'x' })).rejects.toMatchObject({
      code: 'validation',
    });
    await triggers.remove(ACCOUNT, t.id);
    expect(await secrets.list(`secret://trigger/${t.id}/`)).toEqual([]);
    expect(() => triggers.get(ACCOUNT, t.id)).toThrow(/not found/);
    expect(
      events.events.filter((e) => e.name === 'trigger.changed').map((e) => e.payload.change),
    ).toEqual(['created', 'updated', 'deleted']);
  });

  it('fences the payload and cuts very long ones', () => {
    const text = eventText('Do it', {
      dedupeKey: 'k',
      payload: { big: 'x'.repeat(20_000) },
      origin: 'tool',
      source: 's',
    });
    expect(text).toContain('<event>');
    expect(text).toContain('… (cut)');
    expect(text.length).toBeLessThan(17_000);
  });
});

describe('kinds without a source yet', () => {
  it('accepts fs_change and email definitions and marks them unavailable', async () => {
    const fs = await triggers.create(ACCOUNT, {
      kind: 'fs_change',
      deviceId: 'dev-1',
      path: '/home/me/inbox',
      instructions: 'File new scans',
      action: 'run',
    });
    const mail = await triggers.create(ACCOUNT, {
      kind: 'email',
      mailbox: 'me@example.com',
      label: 'invoices',
      instructions: 'Record invoices',
      action: 'run',
    });
    expect(fs).toMatchObject({
      available: false,
      sourceRef: 'dev-1',
      config: { path: '/home/me/inbox' },
    });
    expect(fs.unavailableReason).toMatch(/novad/);
    expect(mail).toMatchObject({
      available: false,
      config: { mailbox: 'me@example.com', label: 'invoices' },
    });
  });
});

describe('channel watches (connector_event)', () => {
  it('fires on every message of the watched conversation, never on our own', async () => {
    const slack = await startMockSlack();
    const env = await serviceEnv({ slackApi: slack.api });
    try {
      const t2 = new TriggerService({
        db: env.db,
        events,
        secrets: env.secrets,
        setting: () => Promise.resolve(100 as never),
        now: env.clock.now,
      });
      const r2 = new FakeRuns();
      t2.useRuns(r2);
      env.service.useConnectorEvents(t2.onConnectorMessage);
      const b = await env.service.create(ACCOUNT, {
        kind: 'slack',
        externalRef: 'C1',
        credentials: { botToken: slack.botToken, signingSecret: slack.signingSecret },
        config: { botUserId: 'UBOT' },
      });
      // Joining the channel watches nothing (docs/09 §7).
      await env.service.receive(
        b.id,
        slack.message({ channel: 'C2', user: 'U5', text: 'deploy failed' }),
      );
      expect(r2.created).toHaveLength(0);
      await expect(
        t2.create(ACCOUNT, {
          kind: 'connector_event',
          bindingId: 'nope',
          instructions: 'x',
          action: 'run',
        }),
      ).rejects.toMatchObject({ code: 'validation' });
      const watch = await t2.create(ACCOUNT, {
        kind: 'connector_event',
        bindingId: b.id,
        conversation: 'C2',
        contains: 'failed',
        instructions: 'Open an incident',
        action: 'run',
      });
      expect(watch.config).toEqual({ conversation: 'C2', contains: 'failed' });
      await env.service.receive(
        b.id,
        slack.message({ channel: 'C2', user: 'U5', text: 'deploy failed', ts: '9.1' }),
      );
      await env.service.receive(
        b.id,
        slack.message({ channel: 'C2', user: 'U5', text: 'all good' }),
      );
      await env.service.receive(
        b.id,
        slack.message({ channel: 'C2', user: 'U5', text: 'deploy failed', ts: '9.1' }),
      );
      await env.service.receive(
        b.id,
        slack.message({ channel: 'C2', user: 'U5', text: 'failed again', botId: 'B1' }),
      );
      expect(r2.created).toHaveLength(1);
      expect(r2.created[0]).toMatchObject({ authority: { kind: 'none', origin: 'channel' } });
      expect(r2.created[0]!.objective).toContain('deploy failed');
    } finally {
      await env.service.close();
      env.db.close();
      await slack.close();
    }
  });
});

describe('MCP event subscriptions (FR-201)', () => {
  async function mcpTrigger(over: Record<string, unknown> = {}) {
    return triggers.create(ACCOUNT, {
      kind: 'mcp_event',
      serverId: SERVER,
      event: 'ticket.created',
      instructions: 'Triage the new ticket',
      action: 'wake',
      agentId: 'agent-1',
      ...over,
    } as never);
  }

  function deliver(
    subId: string,
    body: string,
    o: { id?: string; ts?: number; secret?: string; unsigned?: boolean } = {},
  ) {
    const sub = [...source.subs.values()][0]!;
    const id = o.id ?? `d-${uuidv7()}`;
    const ts = String(o.ts ?? Math.floor(clock.t / 1000));
    const headers: Record<string, string> = o.unsigned
      ? {}
      : {
          'x-nova-event-id': id,
          'x-nova-event-timestamp': ts,
          'x-nova-event-signature': signMcpDelivery(o.secret ?? sub.secret, id, ts, body),
        };
    return mcp.receive(subId, { headers, rawBody: new Uint8Array(Buffer.from(body)) });
  }

  it('subscribes with the Hub webhook URL and a secret from the secret store', async () => {
    const t = await mcpTrigger();
    const sub = t.subscription!;
    expect(sub).toMatchObject({ status: 'active', event: 'ticket.created', serverId: SERVER });
    expect(t.sourceRef).toBe(sub.id);
    const remote = source.subs.get('remote-1')!;
    expect(remote.url).toBe(`https://hub.example/api/v1/mcp/events/${sub.id}`);
    expect(await secrets.get(`secret://mcp/${SERVER}/events/${sub.id}`)).toBe(remote.secret);
    expect(JSON.stringify(t)).not.toContain(remote.secret);
    expect(sub.refreshBefore! < sub.expiresAt!).toBe(true);
    expect(mcp.sources(ACCOUNT)).toEqual([
      {
        serverId: SERVER,
        name: 'tickets',
        events: [{ name: 'ticket.created', description: 'A ticket' }],
      },
    ]);
  });

  it('refuses an event the server does not offer, or an unknown server', async () => {
    await expect(mcpTrigger({ event: 'nope' })).rejects.toMatchObject({ code: 'validation' });
    await expect(mcpTrigger({ serverId: 'other' })).rejects.toMatchObject({ code: 'validation' });
    expect(triggers.list(ACCOUNT)).toEqual([]);
  });

  it('a signed delivery wakes the agent; a duplicate id is ignored', async () => {
    const t = await mcpTrigger();
    const subId = t.subscription!.id;
    const body = JSON.stringify({ event: 'ticket.created', data: { title: 'Printer on fire' } });
    expect(await deliver(subId, body, { id: 'd-1' })).toMatchObject({
      status: 200,
      body: { ok: true, duplicate: false, outcome: 'started' },
    });
    expect(turns.calls).toHaveLength(1);
    expect(turns.calls[0]).toMatchObject({
      trigger: 'event',
      authority: { kind: 'none', origin: 'mcp' },
    });
    expect(turns.calls[0]!.text).toContain('Printer on fire');
    expect(await deliver(subId, body, { id: 'd-1' })).toMatchObject({
      status: 200,
      body: { duplicate: true },
    });
    expect(turns.calls).toHaveLength(1);
    expect(
      events.events.filter((e) => e.name === 'mcp.event.received').map((e) => e.payload.duplicate),
    ).toEqual([false, true]);
    const rows = db.raw.prepare('SELECT delivery_id, size_bytes FROM mcp_event_delivery').all();
    expect(rows).toEqual([{ delivery_id: 'd-1', size_bytes: Buffer.byteLength(body) }]);
  });

  it('rejects unsigned, forged, stale and oversized deliveries and records none of them', async () => {
    const t = await mcpTrigger();
    const subId = t.subscription!.id;
    const body = '{"event":"ticket.created"}';
    expect((await deliver(subId, body, { unsigned: true })).status).toBe(401);
    expect((await deliver(subId, body, { secret: 'not-the-secret' })).status).toBe(401);
    expect((await deliver(subId, body, { ts: Math.floor(clock.t / 1000) - 3600 })).status).toBe(
      401,
    );
    const big = JSON.stringify({ pad: 'x'.repeat(MCP_DELIVERY_MAX_BYTES) });
    expect((await deliver(subId, big)).status).toBe(413);
    expect((await deliver(subId, 'not json')).status).toBe(400);
    expect(db.raw.prepare('SELECT count(*) AS n FROM mcp_event_delivery').get()).toEqual({ n: 0 });
    expect(turns.calls).toHaveLength(0);
    expect(audit.filter((a) => a.action === 'mcp.event.rejected').map((a) => a.result)).toEqual([
      'unsigned',
      'bad_signature',
      'stale',
      'too_large',
      'not_json',
    ]);
    expect(mcp.get(ACCOUNT, subId).lastError).toMatch(/refused: not_json/);
    expect((await mcp.receive('unknown', { headers: {}, rawBody: new Uint8Array() })).status).toBe(
      410,
    );
  });

  it('refreshes before expiry, lapses when refresh fails past it, and subscribes again', async () => {
    const t = await mcpTrigger();
    const subId = t.subscription!.id;
    mcp.start();
    clock.advance(1); // the first tick: nothing due
    await mcp.tick();
    expect(source.calls).toEqual(['subscribe:ticket.created']);
    clock.t = Date.parse(mcp.get(ACCOUNT, subId).refreshBefore!) + 1;
    await mcp.tick();
    expect(source.calls.at(-1)).toBe('refresh:remote-1');
    expect(mcp.get(ACCOUNT, subId).status).toBe('active');
    source.failRefresh = true;
    clock.t = Date.parse(mcp.get(ACCOUNT, subId).refreshBefore!) + 1;
    await mcp.tick();
    expect(mcp.get(ACCOUNT, subId)).toMatchObject({
      status: 'refreshing',
      lastError: 'refresh failed',
    });
    clock.t = Date.parse(mcp.get(ACCOUNT, subId).expiresAt!) + 1;
    await mcp.tick();
    expect(mcp.get(ACCOUNT, subId).status).toBe('lapsed');
    source.failRefresh = false;
    await mcp.tick();
    expect(mcp.get(ACCOUNT, subId)).toMatchObject({ status: 'active', lastError: null });
    expect(source.calls.at(-1)).toBe('subscribe:ticket.created');
    expect(
      events.events
        .filter((e) => e.name === 'mcp.subscription.changed')
        .map((e) => e.payload.status),
    ).toEqual(['active', 'refreshing', 'active', 'refreshing', 'lapsed', 'active']);
  });

  it('waits while the server is not connected, then subscribes', async () => {
    source.connected = false;
    const t = await mcpTrigger();
    expect(t.subscription).toMatchObject({
      status: 'pending',
      lastError: 'the MCP server is not connected',
    });
    source.connected = true;
    await mcp.tick();
    expect(mcp.get(ACCOUNT, t.subscription!.id).status).toBe('active');
    source.failSubscribe = true;
    const t2 = await mcpTrigger();
    expect(t2.subscription).toMatchObject({ status: 'pending', lastError: 'server busy' });
    source.offered = [];
    await mcp.tick();
    expect(mcp.get(ACCOUNT, t2.subscription!.id)).toMatchObject({ status: 'failed' });
  });

  it('unsubscribes on removal: the webhook then answers 410', async () => {
    const t = await mcpTrigger();
    const subId = t.subscription!.id;
    const removed = await mcp.remove(ACCOUNT, subId);
    expect(removed.status).toBe('removed');
    expect(source.calls).toContain('unsubscribe:remote-1');
    expect(triggers.get(ACCOUNT, t.id).enabled).toBe(false);
    expect((await mcp.receive(subId, { headers: {}, rawBody: new Uint8Array() })).status).toBe(410);
    // Deleting a trigger unsubscribes and removes the subscription with it.
    const t2 = await mcpTrigger();
    await triggers.remove(ACCOUNT, t2.id);
    expect(source.calls).toContain('unsubscribe:remote-2');
    expect(mcp.list(ACCOUNT).map((s) => s.id)).toEqual([subId]);
    expect(await secrets.list(`secret://mcp/${SERVER}/events/${t2.subscription!.id}`)).toEqual([]);
  });

  it('removing the MCP server unsubscribes first, then its subscriptions go with it', async () => {
    const t = await mcpTrigger();
    expect(await mcp.removeForServer(ACCOUNT, SERVER)).toBe(1);
    expect(source.calls).toContain('unsubscribe:remote-1');
    expect(mcp.get(ACCOUNT, t.subscription!.id).status).toBe('removed');
    expect(triggers.get(ACCOUNT, t.id).enabled).toBe(false);
    db.raw.prepare('DELETE FROM mcp_server WHERE id = ?').run(SERVER);
    expect(mcp.list(ACCOUNT)).toEqual([]);
  });
});
