// Channels area routes (FR-088, FR-056, FR-201, FR-060; docs/18 J7 steps 3 and 5): sessions on
// every route but the three public inbound endpoints, binding CRUD with write-only credentials,
// Slack and Teams end to end against their mocks, webhook triggers, MCP event subscriptions with
// the events fixture server (signed delivery wakes the agent; unsigned, oversized and duplicate
// ones refused or ignored; removal unsubscribes and the webhook answers 410), notification rules
// and quiet hours, approvals and notifications routed from the event bus, and diagnostics.
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
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
  BotFrameworkVerifier,
  NotificationService,
  signWebhook as signBody,
  type AskInput,
  type AuditRecord,
  type CreateRunInput,
  type RunFinish,
  type RunStarter,
  type StartTurnInput,
  type StartedTurn,
  type TurnStarter,
} from '@nova/core';
import { McpEventsClient, sdkClientTransport } from '@nova/mcp';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { setupChannels, type ChannelsArea, type ChannelsDeps } from '../src/channels.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import {
  startMockSlack,
  type MockSlack,
} from '../../../packages/core/test/fixtures/channels/mock-slack.ts';
import {
  startMockTeams,
  type MockTeams,
} from '../../../packages/core/test/fixtures/channels/mock-teams.ts';
import { createEventsServer } from '../../../packages/mcp/test/fixtures/events-server.mjs';

const ACCOUNT = '01920000-0000-7000-8000-0000000000e9';
const AUTH = { 'x-account': ACCOUNT };

class Turns implements TurnStarter {
  calls: StartTurnInput[] = [];
  startTurn(input: StartTurnInput): Promise<StartedTurn> {
    this.calls.push(input);
    const turnId = uuidv7();
    return Promise.resolve({
      turnId,
      messageId: uuidv7(),
      done: Promise.resolve({
        turnId,
        status: 'completed' as const,
        stop: 'end' as const,
        replyText: `Got it: ${input.text.split('\n').at(-1) ?? ''}`,
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        activeMs: 1,
      }),
    });
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

class Runs implements RunStarter {
  created: CreateRunInput[] = [];
  createRun(input: CreateRunInput) {
    this.created.push(input);
    return Promise.resolve({ runId: `run-${this.created.length}`, threadId: 't' });
  }
  whenFinished(): Promise<RunFinish> {
    return new Promise(() => undefined);
  }
}

let db: NovaDatabase;
let app: FastifyInstance;
let area: ChannelsArea;
let events: EventStore;
let audit: AuditRecord[];
let diagnostics: DiagnosticsRegistry;
let settings: Partial<Record<SettingKey, unknown>>;
let slack: MockSlack;
let turns: Turns;
let runs: Runs;

async function build(deps: Partial<ChannelsDeps> = {}) {
  const ctx = {
    config: { host: '127.0.0.1', port: 7419, tls: null, allowedOrigins: [] },
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets: new MemorySecretStore(),
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
    diagnostics,
  } as unknown as Parameters<typeof setupChannels>[0];
  area = await setupChannels(ctx, {
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    slackApiBase: slack.api,
    ...deps,
  });
  area.useTurns(turns);
  area.useRuns(runs);
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
  audit = [];
  diagnostics = new DiagnosticsRegistry();
  settings = {};
  turns = new Turns();
  runs = new Runs();
  slack = await startMockSlack();
});

afterEach(async () => {
  await app.close();
  await area.close();
  await slack.close();
  db.close();
});

const json = (r: { body: string }) => JSON.parse(r.body);

async function slackBinding(over: Record<string, unknown> = {}) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/channels',
    headers: AUTH,
    payload: {
      kind: 'slack',
      externalRef: 'C1',
      label: '#general',
      agentId: 'agent-1',
      credentials: { botToken: slack.botToken, signingSecret: slack.signingSecret },
      ...over,
    },
  });
  expect(r.statusCode).toBe(201);
  return json(r);
}

function inbound(id: string, req: { headers: Record<string, string>; rawBody: Uint8Array }) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/channels/${id}/inbound`,
    headers: req.headers,
    payload: Buffer.from(req.rawBody),
  });
}

describe('sessions and validation', () => {
  beforeEach(() => build());

  it('every route but the inbound endpoints needs a session', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/channels'],
      ['POST', '/api/v1/channels'],
      ['GET', '/api/v1/channel-identities'],
      ['GET', '/api/v1/triggers'],
      ['POST', '/api/v1/triggers'],
      ['GET', '/api/v1/mcp/subscriptions'],
      ['GET', '/api/v1/mcp/event-sources'],
      ['GET', '/api/v1/notification-rules'],
      ['PUT', '/api/v1/quiet-hours'],
    ] as const) {
      const r = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('validates bodies and naming', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: AUTH,
      payload: { kind: 'slack' },
    });
    expect(bad.statusCode).toBe(400);
    const email = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: AUTH,
      payload: { kind: 'email', externalRef: 'me@example.com' },
    });
    expect(email.statusCode).toBe(400);
    expect(json(email).error.code).toBe('capability_missing');
    const trig = await app.inject({
      method: 'POST',
      url: '/api/v1/triggers',
      headers: AUTH,
      payload: {
        kind: 'webhook',
        instructions: 'x',
        action: 'wake',
        credentials: { token: 'a'.repeat(24), secret: 'b'.repeat(32) },
      },
    });
    expect(trig.statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/notification-rules/nope',
          headers: AUTH,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('Slack through the Hub (J7 step 3)', () => {
  beforeEach(() => build());

  it('creates, lists, connects, tests, disconnects and deletes; credentials never come back', async () => {
    const b = await slackBinding();
    expect(JSON.stringify(b)).not.toContain(slack.botToken);
    const list = json(await app.inject({ method: 'GET', url: '/api/v1/channels', headers: AUTH }));
    expect(list.items).toHaveLength(1);
    expect(list.adapters.find((a: { kind: string }) => a.kind === 'email')).toMatchObject({
      available: false,
    });
    const on = json(
      await app.inject({ method: 'POST', url: `/api/v1/channels/${b.id}/connect`, headers: AUTH }),
    );
    expect(on.config).toMatchObject({ botUserId: 'UBOT', teamId: 'T1' });
    const test = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${b.id}/test`,
      headers: AUTH,
      payload: { text: 'hello from Nova' },
    });
    expect(json(test).receipt.id).toBe(slack.posts.at(-1)!.ts);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/channels/${b.id}`,
      headers: AUTH,
      payload: { label: '#ops' },
    });
    expect(json(patched).label).toBe('#ops');
    const off = json(
      await app.inject({
        method: 'POST',
        url: `/api/v1/channels/${b.id}/disconnect`,
        headers: AUTH,
      }),
    );
    expect(off.status).toBe('disconnected');
    expect(
      json(
        await app.inject({ method: 'GET', url: `/api/v1/channels?agentId=agent-1`, headers: AUTH }),
      ).items,
    ).toHaveLength(1);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/channels/${b.id}`, headers: AUTH }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/channels/${b.id}`, headers: AUTH }))
        .statusCode,
    ).toBe(404);
  });

  it('maps identities; a signed DM starts a turn and the reply goes back to Slack', async () => {
    const b = await slackBinding({ externalRef: 'D1', audience: 'private' });
    const who = await app.inject({
      method: 'POST',
      url: '/api/v1/channel-identities',
      headers: AUTH,
      payload: { kind: 'slack', externalId: 'U1', displayName: 'Jeremy', role: 'owner' },
    });
    expect(who.statusCode).toBe(201);
    const r = await inbound(b.id, slack.message({ channel: 'D1', user: 'U1', text: 'hello' }));
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ ok: true, status: 'started' });
    await area.service.idle();
    expect(turns.calls[0]).toMatchObject({
      trigger: 'channel',
      authority: { kind: 'none', origin: 'channel' },
    });
    expect(slack.posts.at(-1)).toMatchObject({ channel: 'D1', text: 'Got it: hello' });
    const ids = json(
      await app.inject({ method: 'GET', url: '/api/v1/channel-identities', headers: AUTH }),
    );
    expect(ids.items[0]).toMatchObject({ externalId: 'U1', role: 'owner' });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/channel-identities/${ids.items[0].id}`,
          headers: AUTH,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('answers the URL verification; refuses bad and stale signatures; 404 for unknown bindings', async () => {
    const b = await slackBinding();
    const challenge = await inbound(
      b.id,
      slack.sign(JSON.stringify({ type: 'url_verification', challenge: 'c-1' })),
    );
    expect(json(challenge)).toEqual({ challenge: 'c-1' });
    const bad = await inbound(
      b.id,
      slack.message({ channel: 'C1', user: 'U1', text: 'x' }, { secret: 'nope' }),
    );
    expect(bad.statusCode).toBe(401);
    const stale = await inbound(
      b.id,
      slack.message(
        { channel: 'C1', user: 'U1', text: 'x' },
        { timestamp: Math.floor(Date.now() / 1000) - 400 },
      ),
    );
    expect(stale.statusCode).toBe(401);
    expect((await inbound(uuidv7(), slack.sign('{}'))).statusCode).toBe(404);
    expect(turns.calls).toHaveLength(0);
  });

  it('delivers approvals and notifications from the event bus to the channel', async () => {
    const b = await slackBinding();
    await app.inject({
      method: 'POST',
      url: '/api/v1/channel-identities',
      headers: AUTH,
      payload: { kind: 'slack', externalId: 'U1', role: 'owner' },
    });
    // A channel turn that waits for an approval.
    let release!: () => void;
    turns.startTurn = (input) => {
      turns.calls.push(input);
      const turnId = 'turn-held';
      return Promise.resolve({
        turnId,
        messageId: uuidv7(),
        done: new Promise((r) => {
          release = () =>
            r({
              turnId,
              status: 'completed',
              stop: 'end',
              replyText: '',
              steps: 1,
              usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
              activeMs: 0,
            });
        }),
      });
    };
    const approvalId = uuidv7();
    area.useApprovals({
      pending: () => Promise.resolve([]),
      get: () =>
        Promise.resolve({
          id: approvalId,
          action: 'Post to the status page',
          reason: 'a rule asks first',
          tier: 'pre_approvable',
          options: ['allow_once', 'deny_continue'],
        } as never),
      decide: () => Promise.reject(new Error('unused')),
    });
    await inbound(
      b.id,
      slack.message({ channel: 'C1', user: 'U1', text: 'post it', type: 'app_mention' }),
    );
    const threadId = turns.calls[0]!.threadId;
    await events.emit({
      name: 'approval.requested',
      accountId: ACCOUNT,
      correlation: { threadId, turnId: 'turn-held' },
      payload: { approvalId },
    });
    await vi.waitFor(() =>
      expect(slack.posts.at(-1)?.text).toMatch(/^Approval needed for an action \(/),
    );
    release();
    await area.service.idle();

    // A notification rule sends errors to the channel.
    const rule = await app.inject({
      method: 'PUT',
      url: '/api/v1/notification-rules/error',
      headers: AUTH,
      payload: { inapp: true, os: true, channels: [b.id] },
    });
    expect(json(rule)).toMatchObject({ category: 'error', channels: [b.id], isDefault: false });
    const notes = new NotificationService({ db, events });
    // #general is a shared channel: by default nothing private goes there unasked, so the copy
    // is withheld; with the private-to-shared policy at allow it is sent.
    const before = slack.posts.length;
    await notes.create({ accountId: ACCOUNT, kind: 'error', title: 'Held back', body: 'x' });
    await vi.waitFor(() =>
      expect(area.routing.deliveries(ACCOUNT).some((d) => d.status === 'failed')).toBe(true),
    );
    expect(slack.posts.length).toBe(before);
    settings['channels.privateToShared'] = 'allow';
    await notes.create({
      accountId: ACCOUNT,
      kind: 'error',
      title: 'Run failed',
      body: 'disk full',
    });
    await vi.waitFor(() => expect(slack.posts.at(-1)?.text).toBe('Run failed\ndisk full'));
    const rules = json(
      await app.inject({ method: 'GET', url: '/api/v1/notification-rules', headers: AUTH }),
    );
    expect(rules.items).toHaveLength(5);
    expect(rules.quietHours).toMatchObject({ enabled: false, active: false });
    const reset = await app.inject({
      method: 'DELETE',
      url: '/api/v1/notification-rules/error',
      headers: AUTH,
    });
    expect(json(reset).isDefault).toBe(true);
  });

  it('quiet hours: set, read, and the window the agents area reads', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/v1/quiet-hours',
      headers: AUTH,
      payload: { enabled: true, start: '00:00', end: '23:59', timezone: 'UTC' },
    });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ enabled: true, timezone: 'UTC' });
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/v1/quiet-hours',
      headers: AUTH,
      payload: { enabled: true, start: '25:00', end: '07:00', timezone: 'UTC' },
    });
    expect(bad.statusCode).toBe(400);
    expect(
      json(await app.inject({ method: 'GET', url: '/api/v1/quiet-hours', headers: AUTH })).start,
    ).toBe('00:00');
    const at = new Date();
    at.setUTCHours(12, 0, 0, 0);
    expect(await area.quietHours(ACCOUNT, at)).toMatchObject({
      start: expect.any(String),
      end: expect.any(String),
    });
  });

  it('asks the owner through the request broker before private content goes to a shared channel', async () => {
    const b = await slackBinding({ allowUnknown: true });
    const asked: AskInput[] = [];
    let answer = 'Share';
    area.useRequests({
      ask: (input) => {
        asked.push(input);
        return Promise.resolve({ status: 'resolved', result: { choice: answer }, by: 'user' });
      },
    });
    // The agents area says the reply uses a private memory item.
    area.useAgents({ originOf: () => Promise.resolve([{ kind: 'memory', id: 'm-1' }]) });
    await inbound(
      b.id,
      slack.message({ channel: 'C1', user: 'U7', text: 'hi', type: 'app_mention' }),
    );
    await area.service.idle();
    expect(asked[0]).toMatchObject({
      kind: 'user_input',
      payload: { choices: ['Share', 'Do not share'], allowFreeText: false },
    });
    expect(slack.posts.at(-1)!.text).toBe('Got it: hi');
    answer = 'Do not share';
    await inbound(
      b.id,
      slack.message({ channel: 'C1', user: 'U7', text: 'again', type: 'app_mention' }),
    );
    await area.service.idle();
    expect(slack.posts.at(-1)!.text).toBe("I can't share that here.");
    // Deleting the agent removes its bindings and triggers here first.
    await area.removeForAgent(ACCOUNT, 'agent-1');
    expect(
      json(await app.inject({ method: 'GET', url: '/api/v1/channels', headers: AUTH })).items,
    ).toEqual([]);
  });

  it('reports diagnostics and offers the channel tools in agent threads', async () => {
    await slackBinding();
    const d = (await diagnostics.collect()).channels as Record<string, number>;
    expect(d).toMatchObject({ bindings: 1, connected: 1, triggers: 0, mcpSubscriptions: 0 });
    const tools = await area.tools.list(ACCOUNT, { threadId: null, mode: 'agent' });
    expect(tools.map((t) => t.descriptor.name)).toEqual(['channel.list', 'channel.send']);
    expect(await area.tools.list(ACCOUNT, { threadId: null, mode: 'chat' })).toEqual([]);
  });
});

describe('Teams through the Hub', () => {
  let teams: MockTeams;
  beforeEach(async () => {
    teams = await startMockTeams();
    await build({
      teamsVerifier: new BotFrameworkVerifier({ openIdUrl: teams.openIdUrl }),
      teamsTokenUrl: teams.tokenUrl,
      teamsServiceHost: (host) => host === '127.0.0.1',
    });
  });
  afterEach(() => teams.close());

  it('a personal chat with a valid token starts a turn; the reply goes through the connector', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: AUTH,
      payload: {
        kind: 'teams',
        externalRef: 'conv-1',
        audience: 'private',
        credentials: { appPassword: teams.appPassword },
        config: { appId: teams.appId },
        allowUnknown: true,
      },
    });
    expect(r.statusCode).toBe(201);
    const b = json(r);
    expect(b.status).toBe('connected');
    await app.inject({
      method: 'POST',
      url: '/api/v1/channel-identities',
      headers: AUTH,
      payload: { kind: 'teams', externalId: 'user-1', role: 'owner' },
    });
    const ok = await inbound(
      b.id,
      teams.activity({ conversation: 'conv-1', from: 'user-1', text: 'status?' }),
    );
    expect(json(ok)).toEqual({ ok: true, status: 'started' });
    await area.service.idle();
    expect(teams.replies.at(-1)).toMatchObject({ conversation: 'conv-1', text: 'Got it: status?' });
    const bad = await inbound(
      b.id,
      teams.activity({ conversation: 'conv-1', from: 'user-1', text: 'x' }, { audience: 'other' }),
    );
    expect(bad.statusCode).toBe(401);
  });
});

describe('webhook triggers', () => {
  beforeEach(() => build());

  it('creates a webhook trigger, starts a run from a signed post and keeps its history', async () => {
    const token = 'k'.repeat(30);
    const secret = 'q'.repeat(40);
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/triggers',
      headers: AUTH,
      payload: {
        kind: 'webhook',
        title: 'Alerts',
        instructions: 'Summarize the alert',
        credentials: { token, secret },
      },
    });
    expect(r.statusCode).toBe(201);
    const t = json(r);
    expect(t.webhookPath).toBe(`/api/v1/triggers/${t.id}/webhook`);
    const body = JSON.stringify({ id: 'a-1', alert: 'cpu' });
    const ts = String(Math.floor(Date.now() / 1000));
    const fire = await app.inject({
      method: 'POST',
      url: t.webhookPath,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-nova-timestamp': ts,
        'x-nova-signature': signBody(secret, ts, body),
      },
      payload: body,
    });
    expect(fire.statusCode).toBe(202);
    expect(json(fire)).toMatchObject({ ok: true, status: 'started', runId: 'run-1' });
    expect(runs.created[0]).toMatchObject({ origin: 'trigger', authority: { kind: 'none' } });
    const again = await app.inject({
      method: 'POST',
      url: t.webhookPath,
      headers: {
        authorization: `Bearer ${token}`,
        'x-nova-timestamp': ts,
        'x-nova-signature': signBody(secret, ts, body),
      },
      payload: body,
    });
    expect(json(again)).toMatchObject({ status: 'duplicate' });
    const unsigned = await app.inject({
      method: 'POST',
      url: t.webhookPath,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);
    const history = json(
      await app.inject({ method: 'GET', url: `/api/v1/triggers/${t.id}/events`, headers: AUTH }),
    );
    expect(history.items).toHaveLength(1);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/triggers/${t.id}`,
      headers: AUTH,
      payload: { enabled: false },
    });
    expect(json(patched).enabled).toBe(false);
    expect(
      json(await app.inject({ method: 'GET', url: '/api/v1/triggers', headers: AUTH })).items,
    ).toHaveLength(1);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/triggers/${t.id}`, headers: AUTH }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/triggers/${t.id}`, headers: AUTH }))
        .statusCode,
    ).toBe(200);
  });
});

describe('MCP event subscriptions (J7 step 5)', () => {
  const SERVER = '01920000-0000-7000-8000-00000000f0e1';
  let client: Client;
  let fixtureSubs: Map<string, unknown>;

  beforeEach(async () => {
    settings['channels.publicUrl'] = 'https://hub.example';
    await build();
    // The events fixture posts its deliveries to this Hub.
    const fixture = createEventsServer({
      fetch: async (url, init) => {
        const r = await app.inject({
          method: 'POST',
          url: new URL(url).pathname,
          headers: init.headers,
          payload: init.body,
        });
        return { status: r.statusCode };
      },
    });
    fixtureSubs = fixture.subscriptions;
    const [c, s] = InMemoryTransport.createLinkedPair();
    await fixture.server.connect(s);
    client = new Client({ name: 'nova-test', version: '0.0.0' });
    await client.connect(c);
    area.useMcp(new McpEventsClient(sdkClientTransport((id) => (id === SERVER ? client : null))));
    const now = new Date().toISOString();
    db.raw
      .prepare(
        `INSERT INTO mcp_server (id, account_id, name, transport, command, enabled, created_at, updated_at)
         VALUES (?, ?, 'tickets', 'stdio', 'node', 1, ?, ?)`,
      )
      .run(SERVER, ACCOUNT, now, now);
  });

  afterEach(async () => {
    await client.close();
  });

  async function emit(args: Record<string, unknown>) {
    const res = await client.callTool({
      name: 'emit_event',
      arguments: { event: 'ticket.created', ...args },
    });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    return JSON.parse(text) as { status: number; deliveryId: string }[];
  }

  it('subscribes; a signed event wakes the agent; unsigned, oversized and duplicate ones do not', async () => {
    const sources = json(
      await app.inject({ method: 'GET', url: '/api/v1/mcp/event-sources', headers: AUTH }),
    );
    expect(sources.items[0]).toMatchObject({
      serverId: SERVER,
      events: expect.arrayContaining([expect.objectContaining({ name: 'ticket.created' })]),
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/subscriptions',
      headers: AUTH,
      payload: {
        serverId: SERVER,
        event: 'ticket.created',
        instructions: 'Triage new tickets',
        action: 'wake',
        agentId: 'agent-1',
      },
    });
    expect(r.statusCode).toBe(201);
    const sub = json(r);
    expect(sub).toMatchObject({ status: 'active', webhookPath: `/api/v1/mcp/events/${sub.id}` });
    const remote = [...fixtureSubs.values()][0] as { url: string };
    expect(remote.url).toBe(`https://hub.example/api/v1/mcp/events/${sub.id}`);

    const [ok] = await emit({ data: { title: 'Printer on fire' }, deliveryId: 'dlv-1' });
    expect(ok!.status).toBe(200);
    expect(turns.calls).toHaveLength(1);
    expect(turns.calls[0]).toMatchObject({
      trigger: 'event',
      authority: { kind: 'none', origin: 'mcp' },
    });
    expect(turns.calls[0]!.text).toContain('Printer on fire');

    expect((await emit({ deliveryId: 'dlv-1' }))[0]!.status).toBe(200); // duplicate: ignored
    expect((await emit({ unsigned: true }))[0]!.status).toBe(401);
    expect((await emit({ badSignature: true }))[0]!.status).toBe(401);
    expect((await emit({ padBytes: 300 * 1024 }))[0]!.status).toBe(413);
    expect(turns.calls).toHaveLength(1);
    const stored = await events.since(null, 500, { accountId: ACCOUNT });
    expect(
      stored.filter((e) => e.name === 'mcp.event.received').map((e) => e.payload.duplicate),
    ).toEqual([false, true]);

    // Removing the subscription unsubscribes; the webhook then answers 410.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/mcp/subscriptions/${sub.id}`,
      headers: AUTH,
    });
    expect(json(del).status).toBe('removed');
    expect(fixtureSubs.size).toBe(0);
    const gone = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/events/${sub.id}`,
      payload: '{}',
    });
    expect(gone.statusCode).toBe(410);
    const list = json(
      await app.inject({ method: 'GET', url: '/api/v1/mcp/subscriptions', headers: AUTH }),
    );
    expect(list.items[0]).toMatchObject({ id: sub.id, status: 'removed' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/mcp/subscriptions/${sub.id}`,
          headers: AUTH,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('refuses an event the server does not advertise', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/subscriptions',
      headers: AUTH,
      payload: { serverId: SERVER, event: 'nope', instructions: 'x' },
    });
    expect(r.statusCode).toBe(400);
    expect(json(r).error.message).toMatch(/does not offer/);
  });
});
