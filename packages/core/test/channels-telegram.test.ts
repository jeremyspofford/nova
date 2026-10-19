// Telegram channels and approval buttons (FR-110, FR-100, docs/13 §4) against the mock Bot API and
// the mock Slack: the bot token only in the vault and the webhook secret made by the Hub; webhook
// deliveries need the secret token; private chats address the bot, groups only by a mention or a
// reply; the bot's own messages never start a turn; the private-to-shared check applies to group
// replies; approval prompts carry inline keyboards (Slack: buttons) that only the owner's mapped
// identity can answer, for approvals of that conversation; long polling feeds the same path and
// confirms updates one by one; and the message log lists what came and went without content.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelMessagesQuery } from '@nova/shared';
import { ChannelPollers, approvalCode } from '../src/index.ts';
import { ACCOUNT, serviceEnv, type ServiceEnv } from './fixtures/channels/env.ts';
import { FakeApprovals } from './fixtures/channels/approvals.ts';
import { startMockSlack, type MockSlack } from './fixtures/channels/mock-slack.ts';
import { startMockTelegram, type MockTelegram } from './fixtures/channels/mock-telegram.ts';

let env: ServiceEnv;
let tg: MockTelegram;
let slack: MockSlack;
let approvals: FakeApprovals;
let pollers: ChannelPollers | null = null;

beforeEach(async () => {
  tg = await startMockTelegram();
  slack = await startMockSlack();
  env = await serviceEnv({
    telegramApi: tg.api,
    slackApi: slack.api,
    publicBase: 'https://hub.example.com',
  });
  approvals = new FakeApprovals();
  env.service.useApprovals(approvals);
});

afterEach(async () => {
  await pollers?.stop();
  pollers = null;
  await env.service.close();
  env.db.close();
  await tg.close();
  await slack.close();
});

const OWNER = 42;
const MEMBER = 43;
const GROUP = -100777;

async function bot(over: Record<string, unknown> = {}) {
  return env.service.create(ACCOUNT, {
    kind: 'telegram',
    externalRef: String(OWNER),
    label: 'Jeremy on Telegram',
    agentId: 'agent-1',
    audience: 'private',
    credentials: { botToken: tg.botToken },
    ...over,
  } as never);
}

async function group(shareWith: string, over: Record<string, unknown> = {}) {
  return env.service.create(ACCOUNT, {
    kind: 'telegram',
    externalRef: String(GROUP),
    label: 'Team group',
    agentId: 'agent-1',
    shareCredentialsWith: shareWith,
    ...over,
  } as never);
}

const identities = async () => {
  await env.service.addIdentity(ACCOUNT, {
    kind: 'telegram',
    externalId: String(OWNER),
    role: 'owner',
  });
  await env.service.addIdentity(ACCOUNT, {
    kind: 'telegram',
    externalId: String(MEMBER),
    role: 'member',
  });
};

async function secretOf(bindingId: string) {
  return (await env.secrets.get(`secret://channel/${bindingId}/webhookSecret`))!;
}

async function deliver(bindingId: string, update: Record<string, unknown>, secret?: string | null) {
  const s = secret === undefined ? await secretOf(bindingId) : secret;
  const out = await env.service.receive(bindingId, tg.webhook(update, s));
  if (!env.turns.hold) await env.service.idle();
  return out;
}

describe('Telegram bindings', () => {
  it('keeps the bot token and its own webhook secret in the vault only', async () => {
    const b = await bot();
    const secret = await secretOf(b.id);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(b)).not.toContain(tg.botToken);
    expect(JSON.stringify(b)).not.toContain(secret);
    expect(b).toMatchObject({
      kind: 'telegram',
      status: 'connected',
      credentials: [
        { name: 'botToken', set: true },
        { name: 'webhookSecret', set: true },
      ],
      // Polling is the default: nothing posts to the Hub.
      inboundPath: null,
    });
    const row = env.db.raw.prepare('SELECT * FROM channel_binding WHERE id = ?').get(b.id);
    expect(JSON.stringify(row)).not.toContain(tg.botToken);
    // A second chat of the same bot shares it; the same chat twice is a conflict.
    const g = await group(b.id);
    expect(g.sharesCredentialsWith).toBe(b.id);
    await expect(group(b.id, { label: 'again' })).rejects.toMatchObject({ code: 'conflict' });
    expect(env.service.adapterViews().find((a) => a.kind === 'telegram')).toMatchObject({
      available: true,
    });
  });

  it('never takes the webhook secret from a client: the Hub makes it (M7)', async () => {
    const b = await bot();
    const secret = await secretOf(b.id);
    await expect(
      env.service.update(ACCOUNT, b.id, { credentials: { webhookSecret: 'mine-mine-mine' } }),
    ).rejects.toMatchObject({
      code: 'validation',
      details: { field: 'credentials.webhookSecret' },
    });
    expect(await secretOf(b.id)).toBe(secret);
    await expect(
      bot({ credentials: { botToken: tg.botToken, webhookSecret: 'mine-mine-mine' } }),
    ).rejects.toMatchObject({ details: { field: 'credentials.webhookSecret' } });
    // The bot token itself is still replaced by hand.
    await env.service.update(ACCOUNT, b.id, { credentials: { botToken: 'new-token' } });
    expect(await env.secrets.get(`secret://channel/${b.id}/botToken`)).toBe('new-token');
    expect(await secretOf(b.id)).toBe(secret);
  });

  it('connects: learns the bot, and sets the webhook with its secret or clears it for polling', async () => {
    const polling = await bot();
    const on = await env.service.setEnabled(ACCOUNT, polling.id, true);
    expect(on.config).toMatchObject({ botUserId: String(tg.botId), botUsername: tg.botUsername });
    expect(on.statusDetail).toBeNull();
    expect(tg.of('deleteWebhook')).toHaveLength(1);
    const hooked = await bot({ externalRef: '777', config: { mode: 'webhook' } });
    expect(hooked.inboundPath).toBe(`/api/v1/channels/${hooked.id}/inbound`);
    const connected = await env.service.setEnabled(ACCOUNT, hooked.id, true);
    expect(connected.statusDetail).toBeNull();
    expect(tg.of('setWebhook').at(-1)).toEqual({
      url: `https://hub.example.com/api/v1/channels/${hooked.id}/inbound`,
      secret_token: await secretOf(hooked.id),
      allowed_updates: ['message', 'callback_query'],
    });
    // A token Telegram refuses is reported, not thrown.
    tg.failNext = { method: 'getMe', description: 'Unauthorized', status: 401 };
    const bad = await env.service.setEnabled(ACCOUNT, polling.id, true);
    expect(bad.statusDetail).toMatch(/Telegram getMe failed: Unauthorized/);
    expect(bad.statusDetail).not.toContain(tg.botToken);
  });

  it('webhook mode needs an https public address', async () => {
    await env.service.close();
    env.db.close();
    env = await serviceEnv({ telegramApi: tg.api, publicBase: 'http://hub.local:7419' });
    const b = await bot({ config: { mode: 'webhook' } });
    expect((await env.service.setEnabled(ACCOUNT, b.id, true)).statusDetail).toMatch(/https/);
  });
});

describe('Telegram messages', () => {
  it('authenticates webhook deliveries by the secret token', async () => {
    const b = await bot();
    const u = tg.message({ chat: OWNER, from: OWNER, text: 'hi' });
    await expect(deliver(b.id, u, null)).rejects.toMatchObject({ code: 'token_required' });
    await expect(deliver(b.id, u, 'x'.repeat(43))).rejects.toMatchObject({
      code: 'token_required',
    });
  });

  it('a private chat starts a turn without authority and gets the reply', async () => {
    await identities();
    const b = await bot();
    await env.service.setEnabled(ACCOUNT, b.id, true);
    const out = await deliver(b.id, tg.message({ chat: OWNER, from: OWNER, text: 'status?' }));
    expect(out).toMatchObject({ status: 'started', bindingId: b.id });
    const call = env.turns.calls.at(-1)!;
    expect(call.authority).toEqual({ kind: 'none', origin: 'channel' });
    expect(call.text).toContain('(the owner) wrote in a direct message on Telegram');
    expect(tg.of('sendMessage').at(-1)).toMatchObject({ chat_id: String(OWNER) });
    expect(String(tg.of('sendMessage').at(-1)!.text)).toContain('You said:');
    // The same message again is a duplicate; a bot's message is never one to answer.
    const again = tg.message({ chat: OWNER, from: OWNER, text: 'x', messageId: 5 });
    await deliver(b.id, again);
    expect(await deliver(b.id, again)).toMatchObject({ status: 'duplicate' });
    expect(
      await deliver(b.id, tg.message({ chat: OWNER, from: 999, text: 'loop', isBot: true })),
    ).toMatchObject({ status: 'ignored', reason: 'not_a_message' });
    // A member is not the owner of a private chat.
    expect(
      await deliver(b.id, tg.message({ chat: OWNER, from: MEMBER, text: 'hi' })),
    ).toMatchObject({ status: 'ignored', reason: 'not_owner' });
  });

  it('a group addresses the bot only by a mention or a reply, and replies quote the message', async () => {
    await identities();
    const b = await bot();
    await env.service.setEnabled(ACCOUNT, b.id, true);
    const g = await group(b.id);
    await env.service.setEnabled(ACCOUNT, g.id, true);
    expect(
      await deliver(b.id, tg.message({ chat: GROUP, from: MEMBER, text: 'lunch?' })),
    ).toMatchObject({ status: 'ignored', reason: 'not_addressed', bindingId: g.id });
    const mention = tg.message({
      chat: GROUP,
      from: MEMBER,
      text: `@${tg.botUsername} what is due today?`,
      messageId: 31,
    });
    expect(await deliver(b.id, mention)).toMatchObject({ status: 'started', bindingId: g.id });
    expect(env.turns.calls.at(-1)!.text).toMatch(
      /\(a known member\) wrote in Telegram \(Team group/,
    );
    expect(env.turns.calls.at(-1)!.text).toContain('what is due today?');
    expect(env.turns.calls.at(-1)!.text).not.toContain(`@${tg.botUsername}`);
    expect(tg.of('sendMessage').at(-1)).toMatchObject({
      chat_id: String(GROUP),
      reply_parameters: { message_id: 31, allow_sending_without_reply: true },
    });
    expect(
      await deliver(
        b.id,
        tg.message({ chat: GROUP, from: MEMBER, text: 'and?', replyToBot: true }),
      ),
    ).toMatchObject({ status: 'started' });
    // An unbound chat of the bot is ignored.
    expect(
      await deliver(b.id, tg.message({ chat: -5, from: MEMBER, text: `@${tg.botUsername} hi` })),
    ).toMatchObject({ status: 'ignored', reason: 'unbound_conversation' });
  });

  it('a group reply that uses private content passes the private-to-shared check', async () => {
    await identities();
    const b = await bot();
    await env.service.setEnabled(ACCOUNT, b.id, true);
    const g = await group(b.id);
    await env.service.setEnabled(ACCOUNT, g.id, true);
    env.service.usePrivacy(() => Promise.resolve([{ kind: 'memory', id: 'mem-1' }]));
    await deliver(
      b.id,
      tg.message({ chat: GROUP, from: MEMBER, text: `@${tg.botUsername} salary?` }),
    );
    expect(tg.of('sendMessage').at(-1)!.text).toBe("I can't share that here.");
    expect(env.audit.find((a) => a.action === 'channel.share.check')).toMatchObject({
      decision: 'deny',
    });
  });
});

describe('approval buttons', () => {
  async function heldTurn() {
    await identities();
    const b = await bot();
    await env.service.setEnabled(ACCOUNT, b.id, true);
    env.turns.hold = true;
    const started = await deliver(b.id, tg.message({ chat: OWNER, from: OWNER, text: 'post it' }));
    return { b, threadId: started.threadId!, turnId: started.turnId! };
  }

  it('posts an inline keyboard the owner answers, and updates the prompt', async () => {
    const { b, threadId, turnId } = await heldTurn();
    const a = approvals.add(threadId);
    await env.service.onApprovalRequested({
      accountId: ACCOUNT,
      threadId,
      turnId,
      approvalId: a.id,
    });
    const prompt = tg.of('sendMessage').at(-1)!;
    expect(prompt.text).toContain(`Approval needed: ${a.action}`);
    expect(prompt.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Allow', callback_data: `nova:a:${a.id}:o` },
          { text: 'Allow for session', callback_data: `nova:a:${a.id}:s` },
          { text: 'Deny', callback_data: `nova:a:${a.id}:d` },
          { text: 'Deny and stop', callback_data: `nova:a:${a.id}:x` },
        ],
      ],
    });
    // Someone unknown pressing it changes nothing and is told so.
    const stranger = tg.callback({
      chat: OWNER,
      from: 999,
      data: `nova:a:${a.id}:o`,
      messageId: 77,
    });
    expect(await deliver(b.id, stranger)).toMatchObject({
      status: 'ignored',
      reason: 'unknown_sender',
    });
    expect(tg.of('answerCallbackQuery').at(-1)).toMatchObject({ show_alert: true });
    const press = tg.callback({
      chat: OWNER,
      from: OWNER,
      data: `nova:a:${a.id}:s`,
      messageId: 77,
      text: 'Approval needed: post',
    });
    expect(await deliver(b.id, press)).toMatchObject({
      status: 'answered',
      reason: 'allow_session',
    });
    expect(approvals.decided).toEqual([
      { id: a.id, decision: 'allow_session', by: `channel:${b.id}` },
    ]);
    expect(tg.of('editMessageText').at(-1)).toEqual({
      chat_id: String(OWNER),
      message_id: 77,
      text: 'Approval needed: post\n\nAllowed for this session.',
      reply_markup: { inline_keyboard: [] },
    });
    expect(env.audit.find((x) => x.action === 'channel.approval.answered')).toMatchObject({
      decision: 'allow_session',
      detail: { via: 'button' },
    });
    // The same press again is a duplicate; a fresh press on a decided approval is refused.
    expect(await deliver(b.id, press)).toMatchObject({ status: 'duplicate' });
    const late = tg.callback({ chat: OWNER, from: OWNER, data: `nova:a:${a.id}:o`, messageId: 77 });
    expect(await deliver(b.id, late)).toMatchObject({ reason: 'refused:already_decided' });
  });

  it('refuses a member, another conversation, and choices that are not offered', async () => {
    const { b, threadId } = await heldTurn();
    const g = await group(b.id, { allowUnknown: false });
    await env.service.setEnabled(ACCOUNT, g.id, true);
    const a = approvals.add(threadId, { options: ['allow_once', 'deny_continue'] });
    const press = (from: number, chat: number, letter: string) =>
      deliver(b.id, tg.callback({ chat, from, data: `nova:a:${a.id}:${letter}`, messageId: 9 }));
    // Pressed in the group: the approval belongs to the owner's private chat.
    expect(await press(OWNER, GROUP, 'o')).toMatchObject({ reason: 'refused:other_conversation' });
    expect(await press(OWNER, OWNER, 'x')).toMatchObject({ reason: 'refused:not_offered' });
    expect(approvals.decided).toEqual([]);
    expect(env.audit.filter((x) => x.action === 'channel.approval.refused')).toHaveLength(2);
    // A press by a member in the private chat is not the owner's.
    expect(await press(MEMBER, OWNER, 'o')).toMatchObject({ reason: 'refused:not_owner' });
  });

  it('gives no keyboard for approvals only a Nova client may answer', async () => {
    const { threadId, turnId } = await heldTurn();
    const a = approvals.add(threadId, {
      tier: 'confirm_at_action',
      options: ['allow_once', 'deny_continue'],
    });
    await env.service.onApprovalRequested({
      accountId: ACCOUNT,
      threadId,
      turnId,
      approvalId: a.id,
    });
    const prompt = tg.of('sendMessage').at(-1)!;
    expect(prompt.reply_markup).toBeUndefined();
    expect(prompt.text).toContain('can only be answered in Nova');
    const press = tg.callback({ chat: OWNER, from: OWNER, data: `nova:a:${a.id}:o`, messageId: 3 });
    const bId = (await env.service.list(ACCOUNT))[0]!.id;
    expect(await deliver(bId, press)).toMatchObject({ reason: 'refused:native_client_only' });
  });

  it('Slack approval prompts carry buttons; a signed press by the owner answers and updates it', async () => {
    const c = await env.service.create(ACCOUNT, {
      kind: 'slack',
      externalRef: 'C1',
      agentId: 'agent-1',
      credentials: { botToken: slack.botToken, signingSecret: slack.signingSecret },
      config: { botUserId: 'UBOT' },
    } as never);
    await env.service.addIdentity(ACCOUNT, { kind: 'slack', externalId: 'U1', role: 'owner' });
    await env.service.addIdentity(ACCOUNT, { kind: 'slack', externalId: 'U2', role: 'member' });
    env.turns.hold = true;
    const started = await env.service.receive(
      c.id,
      slack.message({ channel: 'C1', user: 'U1', text: '<@UBOT> post it' }),
    );
    const a = approvals.add(started.threadId!);
    await env.service.onApprovalRequested({
      accountId: ACCOUNT,
      threadId: started.threadId!,
      turnId: started.turnId!,
      approvalId: a.id,
    });
    const post = slack.posts.at(-1)!;
    const code = approvalCode(a.id);
    // A shared channel: the code, not the action, in the text and the blocks.
    expect(post.text).toContain(`Approval needed for an action (${code})`);
    expect(JSON.stringify(post.blocks)).not.toContain(a.action);
    const actions = (post.blocks as { type: string; elements?: { value: string }[] }[]).find(
      (x) => x.type === 'actions',
    )!;
    expect(actions.elements!.map((e) => e.value)).toEqual([
      `nova:a:${a.id}:o`,
      `nova:a:${a.id}:s`,
      `nova:a:${a.id}:d`,
      `nova:a:${a.id}:x`,
    ]);
    const press = (user: string, value: string, o?: { secret?: string }) =>
      env.service.receive(c.id, slack.interaction({ user, channel: 'C1', ts: post.ts, value }, o));
    await expect(press('U1', `nova:a:${a.id}:o`, { secret: 'wrong' })).rejects.toMatchObject({
      code: 'token_required',
    });
    expect(await press('U2', `nova:a:${a.id}:o`)).toMatchObject({ reason: 'refused:not_owner' });
    expect(slack.ephemerals.at(-1)).toMatchObject({ channel: 'C1', user: 'U2' });
    expect(await press('U1', `nova:a:${a.id}:d`)).toMatchObject({
      status: 'answered',
      reason: 'deny_continue',
    });
    expect(slack.updates.at(-1)).toMatchObject({ channel: 'C1', ts: post.ts });
    expect(String(slack.updates.at(-1)!.text)).toContain('Denied.');
    // A malformed button value is not a message.
    expect(await press('U1', 'nova:a:not-an-id:o')).toMatchObject({ status: 'ignored' });
  });
});

describe('long polling', () => {
  it('reads updates with getUpdates, confirms them one by one, and routes them like webhooks', async () => {
    await identities();
    const b = await bot();
    await env.service.setEnabled(ACCOUNT, b.id, true);
    pollers = new ChannelPollers({
      service: env.service,
      db: env.db,
      setting: () => Promise.resolve(null as never),
    });
    tg.queue.push(tg.message({ chat: OWNER, from: OWNER, text: 'one' }));
    tg.queue.push(tg.message({ chat: OWNER, from: OWNER, text: 'two' }));
    expect(await pollers.pollOnce(b.id)).toBe(2);
    await env.service.idle();
    expect(env.turns.calls.map((c) => c.text.split('\n').at(-1))).toEqual(['one', 'two']);
    const cursor = env.db.raw
      .prepare('SELECT cursor FROM channel_cursor WHERE binding_id = ?')
      .get(b.id) as {
      cursor: string;
    };
    expect(Number(cursor.cursor)).toBe((tg.queue.at(-1)!.update_id as number) + 1);
    // Already confirmed: nothing again.
    expect(await pollers.pollOnce(b.id)).toBe(0);
    expect(tg.of('getUpdates').at(-1)).toMatchObject({ offset: Number(cursor.cursor) });
    // A webhook-mode bot is not polled.
    const w = await bot({
      externalRef: '888',
      credentials: { botToken: tg.botToken },
      config: { mode: 'webhook' },
    });
    expect(pollers.groups().map((g) => g.via)).not.toContain(w.id);
  });

  it('runs a loop per bot that shows failures in the status and recovers', async () => {
    await identities();
    const b = await bot();
    await env.service.setEnabled(ACCOUNT, b.id, true);
    pollers = new ChannelPollers({
      service: env.service,
      db: env.db,
      setting: () => Promise.resolve(null as never),
      telegramWaitSeconds: 0,
      idleMs: 20,
      backoffMs: 600,
    });
    tg.failNext = {
      method: 'getUpdates',
      description: 'Conflict: terminated by other getUpdates',
      status: 409,
    };
    pollers.start();
    await vi.waitFor(async () =>
      expect((await env.service.get(ACCOUNT, b.id)).statusDetail).toMatch(
        /reading failed: .*Conflict/,
      ),
    );
    tg.queue.push(tg.message({ chat: OWNER, from: OWNER, text: 'after the error' }));
    await vi.waitFor(() =>
      expect(env.turns.calls.map((c) => c.text)).toEqual([
        expect.stringContaining('after the error'),
      ]),
    );
    await vi.waitFor(async () =>
      expect((await env.service.get(ACCOUNT, b.id)).statusDetail).toBeNull(),
    );
    // Disconnecting stops its loop.
    await env.service.setEnabled(ACCOUNT, b.id, false);
    expect(pollers.groups()).toEqual([]);
  });
});

describe('the message log', () => {
  it('lists what came and went, newest first, with filters and without content', async () => {
    await identities();
    const b = await bot();
    await env.service.setEnabled(ACCOUNT, b.id, true);
    await deliver(b.id, tg.message({ chat: OWNER, from: OWNER, text: 'secret plans for friday' }));
    await deliver(b.id, tg.message({ chat: OWNER, from: MEMBER, text: 'hi' }));
    const all = env.service.messages(ACCOUNT, b.id, { limit: 100 });
    expect(all.map((m) => [m.direction, m.status])).toEqual([
      ['in', 'ignored'],
      ['out', 'sent'],
      ['in', 'started'],
    ]);
    expect(all[0]).toMatchObject({ reason: 'not_owner', sender: String(MEMBER) });
    expect(JSON.stringify(all)).not.toContain('secret plans');
    expect(env.service.messages(ACCOUNT, b.id, { direction: 'out', limit: 100 })).toHaveLength(1);
    expect(env.service.messages(ACCOUNT, b.id, { status: 'started', limit: 1 })).toHaveLength(1);
    expect(
      env.service.messages(ACCOUNT, b.id, { before: all[1]!.createdAt, limit: 100 }).length,
    ).toBeLessThanOrEqual(2);
    expect(() =>
      env.service.messages('01920000-0000-7000-8000-0000000000ff', b.id, { limit: 5 }),
    ).toThrow(/not found/);
  });

  it('pages by cursor without skipping messages that share a timestamp (M7)', async () => {
    const b = await bot();
    const insert = env.db.raw.prepare(
      `INSERT INTO channel_message (id, binding_id, account_id, direction, status, created_at)
       VALUES (?, ?, ?, 'in', 'started', ?)`,
    );
    // Five messages, three of them in the same millisecond.
    const at = (s: number) => `2026-10-01T00:00:0${s}.000Z`;
    for (const [id, t] of [
      ['m1', at(1)],
      ['m2', at(2)],
      ['m3', at(2)],
      ['m4', at(2)],
      ['m5', at(3)],
    ] as const)
      insert.run(id, b.id, ACCOUNT, t);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = env.service.messagesPage(ACCOUNT, b.id, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((m) => m.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['m5', 'm4', 'm3', 'm2', 'm1']);
    // `before` (strictly older) still works; the last page has no cursor.
    expect(
      env.service.messagesPage(ACCOUNT, b.id, { before: at(2), limit: 5 }).items.map((m) => m.id),
    ).toEqual(['m1']);
    expect(env.service.messagesPage(ACCOUNT, b.id, { limit: 5 }).nextCursor).toBeNull();
    expect(() => env.service.messagesPage(ACCOUNT, b.id, { cursor: 'nope', limit: 5 })).toThrow(
      /cursor/,
    );
    // The query takes one of the two.
    expect(channelMessagesQuery.safeParse({ cursor: 'x', before: at(2) }).success).toBe(false);
    expect(channelMessagesQuery.parse({ cursor: 'x' })).toEqual({ cursor: 'x', limit: 100 });
  });
});
