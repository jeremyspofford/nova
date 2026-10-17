// Channel bindings end to end against the mock Slack (FR-088, docs/13 §4, docs/18 J7 steps 3-4):
// credentials only in the secret store, identity mapping, a thread per binding (DM and shared
// channel), turns without authority, replies back through the adapter, dedupe, loop prevention,
// rate caps, disconnect at once, the private-to-shared check, and approvals answered from Slack
// through the real policy gate (allowed for a rule-forced approval, refused for
// confirm_at_action and for anyone but the owner).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS, uuidv7, type ToolDescriptor } from '@nova/shared';
import {
  MemoryEventSink,
  PolicyGate,
  PolicyStore,
  approvalCode,
  channelDelivery,
  channelToolSource,
  channelTools,
  type ApprovalRequests,
  type GateOutcome,
  type ToolContext,
} from '../src/index.ts';
import { signBody } from '../src/channels/signing.ts';
import {
  ACCOUNT,
  insertMessage,
  insertThread,
  serviceEnv,
  type ServiceEnv,
} from './fixtures/channels/env.ts';
import { startMockSlack, type MockSlack } from './fixtures/channels/mock-slack.ts';

let env: ServiceEnv;
let slack: MockSlack;

beforeEach(async () => {
  slack = await startMockSlack();
  env = await serviceEnv({ slackApi: slack.api });
});

afterEach(async () => {
  await env.service.close();
  env.db.close();
  await slack.close();
});

const creds = () => ({ botToken: slack.botToken, signingSecret: slack.signingSecret });

function channel(over: Record<string, unknown> = {}) {
  return env.service.create(ACCOUNT, {
    kind: 'slack',
    externalRef: 'C1',
    label: '#general',
    agentId: 'agent-1',
    credentials: creds(),
    config: { botUserId: 'UBOT' },
    ...over,
  } as never);
}

async function dm(shareWith: string, over: Record<string, unknown> = {}) {
  return env.service.create(ACCOUNT, {
    kind: 'slack',
    externalRef: 'D1',
    label: 'Jeremy DM',
    agentId: 'agent-1',
    audience: 'private',
    shareCredentialsWith: shareWith,
    ...over,
  } as never);
}

const owner = (id = 'U1') =>
  env.service.addIdentity(ACCOUNT, {
    kind: 'slack',
    externalId: id,
    displayName: 'Jeremy',
    role: 'owner',
  });
const member = (id = 'U2') =>
  env.service.addIdentity(ACCOUNT, {
    kind: 'slack',
    externalId: id,
    displayName: 'Sam',
    role: 'member',
  });

async function say(
  bindingId: string,
  m: Parameters<MockSlack['message']>[0],
  opts?: Parameters<MockSlack['message']>[1],
) {
  const out = await env.service.receive(bindingId, slack.message(m, opts));
  // Held turns end when the test releases them.
  if (!env.turns.hold) await env.service.idle();
  return out;
}

describe('bindings and credentials', () => {
  it('keeps credentials in the secret store only, never in the row or the view', async () => {
    const b = await channel();
    const row = env.db.raw
      .prepare('SELECT * FROM channel_binding WHERE id = ?')
      .get(b.id) as Record<string, unknown>;
    expect(row.secret_ref).toBe(`secret://channel/${b.id}`);
    expect(JSON.stringify(row)).not.toContain(slack.botToken);
    expect(JSON.stringify(b)).not.toContain(slack.botToken);
    expect(JSON.stringify(b)).not.toContain(slack.signingSecret);
    expect(b).toMatchObject({
      status: 'connected',
      audience: 'shared',
      credentials: [
        { name: 'botToken', set: true },
        { name: 'signingSecret', set: true },
      ],
      inboundPath: `/api/v1/channels/${b.id}/inbound`,
      config: { botUserId: 'UBOT' },
    });
    expect(await env.secrets.get(`secret://channel/${b.id}/botToken`)).toBe(slack.botToken);
    expect(env.audit.find((a) => a.action === 'channel.create')).toMatchObject({ kind: 'channel' });
    expect(env.events.names()).toContain('channel.binding.changed');
  });

  it('shares an app between bindings; refuses a duplicate conversation and email', async () => {
    const c = await channel();
    const d = await dm(c.id);
    expect(d.sharesCredentialsWith).toBe(c.id);
    expect(d.credentials.every((x) => x.set)).toBe(true);
    await expect(dm(c.id, { label: 'again' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      env.service.create(ACCOUNT, { kind: 'slack', externalRef: 'C9' } as never),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      env.service.create(ACCOUNT, { kind: 'email', externalRef: 'me@example.com' }),
    ).rejects.toMatchObject({ code: 'capability_missing' });
    await expect(
      env.service.create(ACCOUNT, {
        kind: 'slack',
        externalRef: 'C2',
        audience: 'shared',
        sharePrimaryThread: true,
        credentials: creds(),
      } as never),
    ).rejects.toMatchObject({ code: 'validation' });
    // Removing the first binding keeps the secrets the second still uses.
    await env.service.remove(ACCOUNT, c.id);
    expect(await env.secrets.get(`secret://channel/${c.id}/botToken`)).toBe(slack.botToken);
    await env.service.remove(ACCOUNT, d.id);
    expect(await env.secrets.list(`secret://channel/${c.id}/`)).toEqual([]);
    await expect(env.service.get(ACCOUNT, c.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('updates settings and credentials by name; refuses unknown ones', async () => {
    const c = await channel();
    const next = await env.service.update(ACCOUNT, c.id, {
      label: '#ops',
      allowUnknown: true,
      rateLimit: { perMinute: 5, perHour: 50 },
      // secret-scan: fake
      credentials: { botToken: 'xoxb-rotated-0002' },
      config: { teamId: 'T1' },
    });
    expect(next).toMatchObject({ label: '#ops', allowUnknown: true, rateLimit: { perMinute: 5 } });
    expect(next.config).toMatchObject({ teamId: 'T1', botUserId: 'UBOT' });
    // secret-scan: fake
    expect(await env.secrets.get(`secret://channel/${c.id}/botToken`)).toBe('xoxb-rotated-0002');
    await expect(
      // secret-scan: fake
      env.service.update(ACCOUNT, c.id, { credentials: { password: 'whatever1' } }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      env.service.update(ACCOUNT, c.id, { config: { callbackUrl: 'https://x.example' } }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      env.service.update(ACCOUNT, c.id, { sharePrimaryThread: true }),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('inbound messages', () => {
  it('DM and shared channel each get a thread of the agent; turns carry no authority', async () => {
    const c = await channel();
    const d = await dm(c.id);
    await owner();
    await member();
    // A message for the DM arrives through the channel binding's URL (one Request URL per app).
    const one = await say(c.id, { channel: 'D1', user: 'U1', text: 'remember the plan' });
    const two = await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> what is up?' });
    expect(one).toMatchObject({ status: 'started', bindingId: d.id });
    expect(two).toMatchObject({ status: 'started', bindingId: c.id });
    expect(one.threadId).not.toBe(two.threadId);
    const modes = env.db.raw
      .prepare('SELECT mode FROM thread WHERE id IN (?, ?)')
      .all(one.threadId!, two.threadId!) as { mode: string }[];
    expect(modes.map((m) => m.mode)).toEqual(['agent', 'agent']);
    const [first, second] = env.turns.calls;
    expect(first).toMatchObject({
      trigger: 'channel',
      triggerRef: d.id,
      authority: { kind: 'none', origin: 'channel' },
      authorKind: 'user',
    });
    expect(first!.text).toBe(
      'Jeremy (the owner) wrote in a direct message on Slack:\nremember the plan',
    );
    expect(second!.text).toBe(
      'Sam (a known member) wrote in Slack (#general, a shared conversation):\nwhat is up?',
    );
    // Replies go back where each message came from; in a channel, into its thread.
    expect(slack.posts.map((p) => [p.channel, p.thread_ts ?? null])).toEqual([
      ['D1', null],
      ['C1', two.turnId ? expect.any(String) : null],
    ]);
    expect(slack.posts[1]!.text).toContain('what is up?');
    expect(env.events.names()).toEqual(
      expect.arrayContaining(['channel.message.received', 'channel.message.sent']),
    );
    const received = env.events.events.find((e) => e.name === 'channel.message.received')!;
    expect(received.payload).toEqual({ bindingId: d.id, from: 'U1', threadId: one.threadId });
    expect(env.service.audienceOf(ACCOUNT, one.threadId!)).toBe('private');
    expect(env.service.audienceOf(ACCOUNT, two.threadId!)).toBe('shared');
  });

  it('asks the agents area for the thread (shared identity and memory) when it is bound', async () => {
    const c = await channel();
    const d = await dm(c.id, { sharePrimaryThread: true });
    await owner();
    await member();
    const main = insertThread(env.db, 'Agent', 'agent');
    const asked: {
      agentId: string | null;
      binding: { id: string; sharePrimaryThread: boolean };
    }[] = [];
    env.service.useThreads((input) => {
      asked.push(input);
      return Promise.resolve(
        input.binding.sharePrimaryThread
          ? main
          : insertThread(env.db, input.binding.label, 'agent'),
      );
    });
    const a = await say(c.id, { channel: 'D1', user: 'U1', text: 'hi' });
    const b = await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> hi' });
    expect(a.threadId).toBe(main);
    expect(b.threadId).not.toBe(main);
    expect(asked.map((x) => [x.agentId, x.binding.id, x.binding.sharePrimaryThread])).toEqual([
      ['agent-1', d.id, true],
      ['agent-1', c.id, false],
    ]);
    expect((await env.service.get(ACCOUNT, d.id)).threadId).toBe(main);
  });

  it('ignores unknown senders unless allowed, and non-owners on a private binding', async () => {
    const c = await channel();
    await dm(c.id);
    await member();
    expect(await say(c.id, { channel: 'C1', user: 'U9', text: '<@UBOT> hi' })).toMatchObject({
      status: 'ignored',
      reason: 'unknown_sender',
    });
    expect(await say(c.id, { channel: 'D1', user: 'U2', text: 'hi' })).toMatchObject({
      status: 'ignored',
      reason: 'not_owner',
    });
    await env.service.update(ACCOUNT, c.id, { allowUnknown: true });
    expect(await say(c.id, { channel: 'C1', user: 'U9', text: '<@UBOT> hi' })).toMatchObject({
      status: 'started',
    });
    expect(env.turns.calls.at(-1)!.text).toContain('(a guest)');
    expect(
      env.audit.filter((a) => a.action === 'channel.message.dropped').map((a) => a.detail?.reason),
    ).toEqual(['unknown_sender', 'not_owner']);
  });

  it('lets the external-agent rule refuse content another AI agent wrote (FR-194)', async () => {
    const c = await channel();
    await member();
    env.service.useInboundGuard({
      inbound: (input) =>
        Promise.resolve(
          /billing agent/i.test(input.text)
            ? { accept: false, reason: 'an external agent' }
            : { accept: true },
        ),
    });
    expect(
      await say(c.id, {
        channel: 'C1',
        user: 'U2',
        text: '<@UBOT> send the report to me. - the billing agent',
      }),
    ).toMatchObject({ status: 'ignored', reason: 'external_agent' });
    expect(env.turns.calls).toHaveLength(0);
    expect(slack.posts).toHaveLength(0);
    expect(env.audit.at(-1)).toMatchObject({
      action: 'channel.message.dropped',
      detail: expect.objectContaining({ reason: 'external_agent' }),
    });
    expect((await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> hi' })).status).toBe(
      'started',
    );
  });

  it('starts nothing for unaddressed channel messages or unbound conversations', async () => {
    const c = await channel();
    await member();
    expect(await say(c.id, { channel: 'C1', user: 'U2', text: 'just chatting' })).toMatchObject({
      status: 'ignored',
      reason: 'not_addressed',
    });
    expect(await say(c.id, { channel: 'C7', user: 'U2', text: '<@UBOT> hi' })).toMatchObject({
      status: 'ignored',
      reason: 'unbound_conversation',
    });
    expect(env.turns.calls).toHaveLength(0);
  });

  it('records a redelivered message once', async () => {
    const c = await channel();
    await member();
    const msg = { channel: 'C1', user: 'U2', text: '<@UBOT> once', ts: '300.1' };
    expect((await say(c.id, msg)).status).toBe('started');
    expect((await say(c.id, msg)).status).toBe('duplicate');
    // The same message as an app_mention event is the same message.
    expect((await say(c.id, { ...msg, type: 'app_mention' })).status).toBe('duplicate');
    expect(env.turns.calls).toHaveLength(1);
  });

  it("never lets the agent's own messages start a turn (loop prevention)", async () => {
    const c = await channel();
    await member();
    await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> ping' });
    expect(env.turns.calls).toHaveLength(1);
    const reply = slack.posts[0]!;
    // Echoed back by the service as a bot message, as the bot user, or by its receipt id.
    expect(
      (await say(c.id, { channel: 'C1', user: 'U2', text: reply.text, botId: 'B1' })).status,
    ).toBe('ignored');
    expect((await say(c.id, { channel: 'C1', user: 'UBOT', text: '<@UBOT> x' })).status).toBe(
      'ignored',
    );
    expect(
      await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> again', ts: reply.ts }),
    ).toMatchObject({ reason: 'own_message' });
    expect(env.turns.calls).toHaveLength(1);
  });

  it('caps turns per minute and messages per minute', async () => {
    const c = await channel({ rateLimit: { perMinute: 2, perHour: 100 } });
    await member();
    const out = [];
    for (let i = 0; i < 3; i++)
      out.push((await say(c.id, { channel: 'C1', user: 'U2', text: `<@UBOT> n${i}` })).status);
    expect(out).toEqual(['started', 'started', 'dropped']);
    expect(env.audit.at(-1)).toMatchObject({
      action: 'channel.message.dropped',
      detail: expect.objectContaining({ reason: 'rate_limited' }),
    });
    // The two replies used the outbound allowance too.
    await expect(env.service.sendTo(ACCOUNT, c.id, 'third')).rejects.toMatchObject({
      code: 'rate_limited',
    });
    env.clock.t += 61_000;
    expect((await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> later' })).status).toBe(
      'started',
    );
  });

  it('disconnects at once: the running turn is cancelled, its reply withheld, inbound ignored', async () => {
    const c = await channel();
    await member();
    env.turns.hold = true;
    const started = await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> long job' });
    const off = await env.service.setEnabled(ACCOUNT, c.id, false);
    expect(off.status).toBe('disconnected');
    expect(env.turns.cancelled).toEqual([started.threadId]);
    env.turns.release(started.turnId!);
    await env.service.idle();
    expect(slack.posts).toHaveLength(0);
    expect(await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> hello?' })).toMatchObject({
      status: 'dropped',
      reason: 'disconnected',
    });
    await expect(env.service.test(ACCOUNT, c.id)).rejects.toMatchObject({ code: 'conflict' });
    // Reconnecting checks the token and learns the bot user id.
    const on = await env.service.setEnabled(ACCOUNT, c.id, true);
    expect(on).toMatchObject({
      status: 'connected',
      statusDetail: null,
      config: { botUserId: 'UBOT', teamId: 'T1' },
    });
    expect(env.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['channel.disconnect', 'channel.connect']),
    );
  });

  it('accepts a signed webhook message and answers through its callback', async () => {
    const sent: string[] = [];
    await env.service.close();
    env = await serviceEnv({
      slackApi: slack.api,
      webhookTransport: (req) => (sent.push(req.body), Promise.resolve({ status: 204 })),
    });
    const token = 'w'.repeat(30);
    const secret = 'v'.repeat(40);
    const b = await env.service.create(ACCOUNT, {
      kind: 'webhook',
      externalRef: 'ci',
      credentials: { token, secret },
      config: { callbackUrl: 'https://ci.example/callback' },
      allowUnknown: true,
    });
    const body = JSON.stringify({ id: 'w-1', text: 'build broke', from: { id: 'ci-bot' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const out = await env.service.receive(b.id, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-nova-timestamp': ts,
        'x-nova-signature': signBody(secret, ts, body),
      },
      rawBody: new Uint8Array(Buffer.from(body)),
    });
    await env.service.idle();
    expect(out.status).toBe('started');
    expect(JSON.parse(sent[0]!)).toMatchObject({ conversation: 'ci' });
    await expect(
      env.service.receive(b.id, {
        headers: { authorization: 'Bearer nope' },
        rawBody: new Uint8Array(Buffer.from(body)),
      }),
    ).rejects.toMatchObject({ code: 'token_required' });
  });
});

describe('private to shared (docs/13 §4)', () => {
  async function setup() {
    const c = await channel();
    await dm(c.id);
    await owner();
    await member();
    const first = await say(c.id, { channel: 'D1', user: 'U1', text: 'my locker code is 4417' });
    // What the DM thread holds (the chat loop writes it; the fake turns do not).
    insertMessage(env.db, first.threadId!, 'user', 'my locker code is 4417');
    env.turns.reply = (i) =>
      i.text.includes('locker') && i.text.includes('shared')
        ? 'The locker code is 4417.'
        : 'Hello there.';
    slack.posts.length = 0;
    return c;
  }

  it('by default asks the owner; with no one to ask, the detail is withheld', async () => {
    const c = await setup();
    await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> what is the locker code?' });
    expect(slack.posts.map((p) => p.text)).toEqual(["I can't share that here."]);
    expect(JSON.stringify(slack.posts)).not.toContain('4417');
    const check = env.audit.find((a) => a.action === 'channel.share.check')!;
    expect(check).toMatchObject({
      decision: 'deny',
      detail: expect.objectContaining({ policy: 'ask' }),
    });
    const out = env.db.raw
      .prepare(
        "SELECT status, reason FROM channel_message WHERE direction = 'out' AND status = 'withheld'",
      )
      .all() as { status: string; reason: string }[];
    expect(out).toEqual([{ status: 'withheld', reason: 'denied' }]);
  });

  it('sends it when the owner allows, or when the policy allows', async () => {
    const c = await setup();
    const asked: unknown[] = [];
    env.service.useShareAsk((input) => (asked.push(input), Promise.resolve('allow')));
    await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> what is the locker code?' });
    expect(slack.posts.at(-1)!.text).toBe('The locker code is 4417.');
    expect(asked[0]).toMatchObject({
      bindingId: c.id,
      sources: [expect.objectContaining({ kind: 'thread' })],
    });
    env.service.useShareAsk(() => Promise.resolve('deny'));
    env.settings['channels.privateToShared'] = 'allow';
    await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> the locker code again?' });
    expect(slack.posts.at(-1)!.text).toBe('The locker code is 4417.');
    env.settings['channels.privateToShared'] = 'deny';
    await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> locker code please' });
    expect(slack.posts.at(-1)!.text).toBe("I can't share that here.");
  });

  it('checks private memory items too; replies without private content go straight out', async () => {
    const c = await channel();
    await member();
    const now = new Date().toISOString();
    env.db.raw
      .prepare(
        `INSERT INTO memory_item (id, account_id, scope_kind, content, content_key, origin_audience,
           created_at, updated_at) VALUES (?, ?, 'global', ?, ?, 'private', ?, ?)`,
      )
      .run(uuidv7(), ACCOUNT, 'Jeremy prefers the teal standing desk', 'k1', now, now);
    env.turns.reply = (i) =>
      i.text.includes('desk') ? 'He prefers the teal standing desk.' : 'Hi!';
    await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> hello' });
    expect(slack.posts.at(-1)!.text).toBe('Hi!');
    await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> which desk?' });
    expect(slack.posts.at(-1)!.text).toBe("I can't share that here.");
    const check = env.audit.filter((a) => a.action === 'channel.share.check');
    expect(check).toHaveLength(1);
    expect(String((check[0]!.detail as { sources: string[] }).sources[0])).toMatch(/^memory:/);
  });

  it("checks the agent's notes from private threads too (FR-089)", async () => {
    const c = await channel();
    await member();
    const now = new Date().toISOString();
    const agentId = 'agent-1';
    env.db.raw
      .prepare(
        `INSERT INTO agent (id, account_id, name, time_budget_s, token_budget, created_at, updated_at)
         VALUES (?, ?, 'Ada', 600, 200000, ?, ?)`,
      )
      .run(agentId, ACCOUNT, now, now);
    const note = (content: string, audience: 'private' | 'shared') =>
      env.db.raw
        .prepare(
          `INSERT INTO agent_memory (id, agent_id, kind, content, author, source, origin_audience,
             created_at, updated_at) VALUES (?, ?, 'note', ?, 'agent', 'conversation', ?, ?, ?)`,
        )
        .run(uuidv7(), agentId, content, audience, now, now);
    note('The garage door code is 90210 for the plumber', 'private');
    note('The team standup moved to ten thirty on Mondays', 'shared');
    env.turns.reply = (i) =>
      i.text.includes('garage')
        ? 'The garage door code is 90210.'
        : 'The team standup moved to ten thirty on Mondays.';
    await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> when is standup?' });
    expect(slack.posts.at(-1)!.text).toContain('standup');
    await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> garage code?' });
    expect(slack.posts.at(-1)!.text).toBe("I can't share that here.");
  });

  it("content the shared channel itself said is not private; the agents area's check replaces the default", async () => {
    const c = await setup();
    // The member says the number first: echoing it back leaks nothing.
    env.turns.reply = (i) => `You said: ${i.text}`;
    await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> is 4417 the code?' });
    const sharedThread = (await env.service.get(ACCOUNT, c.id)).threadId!;
    insertMessage(env.db, sharedThread, 'user', 'is 4417 the code?');
    await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> is 4417 the code?' });
    expect(slack.posts.at(-1)!.text).toContain('4417');
    env.service.usePrivacy(() => Promise.resolve([{ kind: 'memory', id: 'm-1' }]));
    await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> anything' });
    expect(slack.posts.at(-1)!.text).toBe("I can't share that here.");
  });
});

describe('notification copies (FR-060)', () => {
  it('go to private channels; to a shared one only when the policy allows sharing', async () => {
    const shared = await channel();
    const priv = await dm(shared.id);
    expect(await env.service.mayNotify(ACCOUNT, priv.id)).toBe(true);
    // The default policy asks, and a notification cannot ask before every copy: withheld.
    expect(await env.service.mayNotify(ACCOUNT, shared.id)).toBe(false);
    env.settings['channels.privateToShared'] = 'deny';
    expect(await env.service.mayNotify(ACCOUNT, shared.id)).toBe(false);
    env.settings['channels.privateToShared'] = 'allow';
    expect(await env.service.mayNotify(ACCOUNT, shared.id)).toBe(true);
  });
});

describe('approvals answered from Slack (FR-100, FR-189)', () => {
  let dir: string;
  let gate: PolicyGate;
  let store: PolicyStore;
  let gateEvents: MemoryEventSink;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nova-channels-'));
    mkdirSync(join(dir, 'data', 'workspace'), { recursive: true });
    store = new PolicyStore({ db: env.db });
    gateEvents = new MemoryEventSink();
    gate = new PolicyGate({
      store,
      events: gateEvents,
      audit: { append: () => Promise.resolve() },
      notifier: { notify: () => Promise.resolve() },
      setting: (key) => Promise.resolve(SETTINGS[key].default as never),
      dataDir: join(dir, 'data'),
      home: join(dir, 'home'),
      approvalTimeoutMs: () => 60_000,
    });
    const approvals: ApprovalRequests = {
      pending: (a, t) =>
        store.listApprovals(a, { status: 'pending', ...(t ? { threadId: t } : {}) }),
      get: (a, id) => store.getApproval(a, id),
      decide: (a, body, by) => gate.decide(a, body, by),
    };
    env.service.useApprovals(approvals);
  });

  afterEach(async () => {
    await gate.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const tool = (over: Partial<ToolDescriptor> & { name: string }): ToolDescriptor => ({
    title: over.name,
    description: '',
    source: 'builtin',
    inputSchema: { type: 'object' },
    ...over,
  });

  /** A channel turn calls a tool: the gate's check, and the prompt posted to Slack. */
  async function toolCall(threadId: string, turnId: string, t: ToolDescriptor, args: unknown) {
    const before = gateEvents.events.filter((e) => e.name === 'approval.requested').length;
    const outcome: Promise<GateOutcome> = gate.check(
      {
        accountId: ACCOUNT,
        threadId,
        turnId,
        callId: uuidv7(),
        projectId: null,
        mode: 'agent',
        tool: t,
        args,
        argsPreview: JSON.stringify(args),
        provenance: { taint: ['channel'] },
        profile: { id: 'workspace', hash: 'h' },
      },
      new AbortController().signal,
    );
    let approvalId = '';
    await vi.waitFor(() => {
      const reqs = gateEvents.events.filter((e) => e.name === 'approval.requested');
      expect(reqs.length).toBe(before + 1);
      approvalId = reqs.at(-1)!.payload.approvalId as string;
    });
    // The Hub forwards approval.requested from the bus.
    await env.service.onApprovalRequested({ accountId: ACCOUNT, threadId, turnId, approvalId });
    return { outcome, approvalId, code: approvalCode(approvalId) };
  }

  it('a rule-forced approval is posted and answered "allow" by the owner from Slack', async () => {
    await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'web.post' },
      effect: 'ask',
      label: 'Ask before posting',
    });
    const c = await channel();
    await owner();
    await member();
    env.turns.hold = true;
    const started = await say(c.id, { channel: 'C1', user: 'U1', text: '<@UBOT> post the update' });
    const post = tool({
      name: 'web.post',
      annotations: { requiresNetwork: true },
      effects: ['network'],
    });
    const { outcome, approvalId, code } = await toolCall(started.threadId!, started.turnId!, post, {
      url: 'https://status.example/update',
    });
    // A shared channel gets the code, not the action (it can name private things).
    expect(slack.posts.at(-1)!.text).toBe(
      `Approval needed for an action (${code}); the details are in Nova.\n` +
        `Reply "allow ${code}", "deny ${code}", "deny and stop ${code}".`,
    );

    // Only the owner's mapped identity can answer.
    expect(
      await say(c.id, { channel: 'C1', user: 'U2', text: `<@UBOT> allow ${code}` }),
    ).toMatchObject({
      status: 'answered',
      reason: 'refused:not_owner',
    });
    expect((await store.getApproval(ACCOUNT, approvalId)).status).toBe('pending');

    expect(
      await say(c.id, { channel: 'C1', user: 'U1', text: `<@UBOT> allow ${code}` }),
    ).toMatchObject({
      status: 'answered',
      reason: 'allow_once',
    });
    await expect(outcome).resolves.toMatchObject({ effect: 'allow', approvalId });
    const decided = await store.getApproval(ACCOUNT, approvalId);
    expect(decided).toMatchObject({ decision: 'allow_once', decidedBy: `channel:${c.id}` });
    expect(slack.posts.at(-1)!.text).toBe('Allowed once.');
    expect(env.audit.find((a) => a.action === 'channel.approval.answered')).toMatchObject({
      decision: 'allow_once',
      actor: `channel:${c.id}`,
    });
    // An answer is not a message: no extra turn started.
    expect(env.turns.calls).toHaveLength(1);
    env.turns.release(started.turnId!);
  });

  it('denies from Slack too, with the reason', async () => {
    await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'web.post' },
      effect: 'ask',
    });
    const c = await channel();
    await owner();
    env.turns.hold = true;
    const started = await say(c.id, { channel: 'D-none', user: 'U1', text: 'x' });
    expect(started.status).toBe('ignored');
    const s2 = await say(c.id, { channel: 'C1', user: 'U1', text: '<@UBOT> post it' });
    const post = tool({ name: 'web.post', effects: ['network'] });
    const { outcome } = await toolCall(s2.threadId!, s2.turnId!, post, {
      url: 'https://a.example',
    });
    await say(c.id, { channel: 'C1', user: 'U1', text: '<@UBOT> deny: not today' });
    await expect(outcome).resolves.toMatchObject({ effect: 'deny', stop: false });
    expect(slack.posts.at(-1)!.text).toBe('Denied.');
    env.turns.release(s2.turnId!);
  });

  it('refuses to answer a confirm_at_action approval from a channel', async () => {
    const c = await channel();
    await owner();
    env.turns.hold = true;
    const started = await say(c.id, { channel: 'C1', user: 'U1', text: '<@UBOT> buy the thing' });
    const purchase = tool({ name: 'mcp:shop.purchase_item', source: 'mcp', serverId: 'shop' });
    const { outcome, approvalId, code } = await toolCall(
      started.threadId!,
      started.turnId!,
      purchase,
      {
        item: 'x',
      },
    );
    expect((await store.getApproval(ACCOUNT, approvalId)).tier).toBe('confirm_at_action');
    expect(slack.posts.at(-1)!.text).toMatch(/only be answered in Nova/);
    expect(
      await say(c.id, { channel: 'C1', user: 'U1', text: `<@UBOT> allow ${code}` }),
    ).toMatchObject({
      reason: 'refused:native_client_only',
    });
    expect(slack.posts.at(-1)!.text).toBe('This approval can only be answered in Nova.');
    expect((await store.getApproval(ACCOUNT, approvalId)).status).toBe('pending');
    expect(env.audit.find((a) => a.action === 'channel.approval.refused')).toMatchObject({
      detail: expect.objectContaining({ reason: 'native_client_only', tier: 'confirm_at_action' }),
    });
    // The owner answers in Nova (a signed-in client).
    await gate.decide(ACCOUNT, { approvalId, decision: 'deny_continue' }, 'user');
    await expect(outcome).resolves.toMatchObject({ effect: 'deny' });
    env.turns.release(started.turnId!);
  });
});

describe('sending', () => {
  it('replyFor answers a bound thread in its last conversation; null for other threads', async () => {
    const c = await channel();
    await member();
    const s = await say(c.id, { channel: 'C1', user: 'U2', text: '<@UBOT> hi', ts: '400.1' });
    const r = await env.service.replyFor(ACCOUNT, s.threadId!, 'a later update');
    expect(r?.id).toBe(slack.posts.at(-1)!.ts);
    expect(slack.posts.at(-1)).toMatchObject({
      channel: 'C1',
      thread_ts: '400.1',
      text: 'a later update',
    });
    expect(await env.service.replyFor(ACCOUNT, 'no-such-thread', 'x')).toBeNull();
  });

  it('delivers schedule results to Slack with the message id as the receipt', async () => {
    const c = await channel();
    const ch = channelDelivery(env.service, 'slack');
    const req = {
      accountId: ACCOUNT,
      scheduleId: 's1',
      title: 'Daily digest',
      runId: 'r1',
      threadId: null,
      fireId: 'f1',
      message: 'All quiet.',
      firedAt: new Date().toISOString(),
    };
    const ok = await ch.deliver(req, { kind: 'slack', ref: c.id });
    expect(ok.receipt).toBe(`slack:${slack.posts.at(-1)!.ts}`);
    expect(slack.posts.at(-1)!.text).toBe('Daily digest\n\nAll quiet.');
    expect((await ch.deliver(req, { kind: 'slack' })).error).toMatch(/needs a channel binding/);
    const teams = channelDelivery(env.service, 'teams');
    expect((await teams.deliver(req, { kind: 'teams', ref: c.id })).error).toMatch(/teams binding/);
    expect((await ch.deliver(req, { kind: 'slack', ref: 'missing' })).receipt).toBeNull();
  });

  it('redacts secrets from everything sent out', async () => {
    const c = await channel();
    await env.service.test(ACCOUNT, c.id, `the token is ${slack.botToken}`);
    expect(slack.posts.at(-1)!.text).not.toContain(slack.botToken);
  });

  it('channel tools: list, send with the channel resource, and refusal of unknown channels', async () => {
    const c = await channel();
    const agentThread = insertThread(env.db, 'agent', 'agent');
    env.db.raw
      .prepare('UPDATE channel_binding SET thread_id = ? WHERE id = ?')
      .run(agentThread, c.id);
    const [list, send] = channelTools(env.service);
    const ctx = { accountId: ACCOUNT, threadId: agentThread, turnId: 't1' } as ToolContext;
    const listed = await list!.handler({}, ctx);
    expect(JSON.stringify(listed)).toContain(c.id);
    expect(send!.resource!({ channel: '#general', text: 'hi' }, ctx)).toEqual({
      kind: 'account',
      value: 'slack:C1',
    });
    expect(send!.descriptor.effects).toEqual(['external_communication']);
    const sent = await send!.handler({ channel: c.id, text: 'Standup in 5' }, ctx);
    expect(sent).toMatchObject({ ok: true });
    expect(slack.posts.at(-1)!.text).toBe('Standup in 5');
    expect(await send!.handler({ channel: 'nope', text: 'x' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    const source = channelToolSource(
      [list!, send!],
      (a, t) => env.service.bindingsOfThread(a, t).length > 0,
    );
    expect(await source.list(ACCOUNT, { threadId: agentThread, mode: 'chat' })).toHaveLength(2);
    expect(await source.list(ACCOUNT, { threadId: 'other', mode: 'chat' })).toHaveLength(0);
    expect(await source.list(ACCOUNT, { threadId: null, mode: 'agent' })).toHaveLength(2);
  });

  it('removes every binding of a deleted agent', async () => {
    const c = await channel();
    await dm(c.id);
    expect(await env.service.removeForAgent(ACCOUNT, 'agent-1')).toBe(2);
    expect(await env.service.list(ACCOUNT)).toEqual([]);
  });
});
