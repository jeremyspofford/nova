// Hub-only approval cards (M7.5, docs/23 §6.3 "explicit approval on the Hub"): a card with
// `answerIn: 'hub'` (firmware, boot, out-of-band) is never answered from a channel. Its prompt
// carries no buttons and says to open Nova; a button press, a reply and a signed email link are
// each refused with `hub_only` and audited as `channel.approval.refused`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalLinks, HUB_ONLY_TEXT, approvalCode, approvalPrompt } from '../src/index.ts';
import { ACCOUNT, serviceEnv, type ServiceEnv } from './fixtures/channels/env.ts';
import { FakeApprovals } from './fixtures/channels/approvals.ts';
import { startMockTelegram, type MockTelegram } from './fixtures/channels/mock-telegram.ts';

let env: ServiceEnv;
let tg: MockTelegram;
let approvals: FakeApprovals;

beforeEach(async () => {
  tg = await startMockTelegram();
  env = await serviceEnv({ telegramApi: tg.api, publicBase: 'https://hub.example.com' });
  approvals = new FakeApprovals();
  env.service.useApprovals(approvals);
});

afterEach(async () => {
  await env.service.close();
  env.db.close();
  await tg.close();
});

const OWNER = 42;

async function heldTurn() {
  await env.service.addIdentity(ACCOUNT, {
    kind: 'telegram',
    externalId: String(OWNER),
    role: 'owner',
  });
  const b = await env.service.create(ACCOUNT, {
    kind: 'telegram',
    externalRef: String(OWNER),
    label: 'Jeremy on Telegram',
    agentId: 'agent-1',
    audience: 'private',
    credentials: { botToken: tg.botToken },
  } as never);
  await env.service.setEnabled(ACCOUNT, b.id, true);
  env.turns.hold = true;
  const secret = (await env.secrets.get(`secret://channel/${b.id}/webhookSecret`))!;
  const deliver = (update: Record<string, unknown>) =>
    env.service.receive(b.id, tg.webhook(update, secret));
  const started = await deliver(tg.message({ chat: OWNER, from: OWNER, text: 'reboot it' }));
  return { b, deliver, threadId: started.threadId!, turnId: started.turnId! };
}

/** A pre-approvable card, so only `answerIn` keeps it out of the channel. */
function hubOnly(threadId: string) {
  return approvals.add(threadId, {
    tool: 'device.firmware.apply',
    action: 'Change BIOS/firmware settings on desk: wol Disabled -> LanOnly',
    options: ['allow_once', 'deny_continue'],
    answerIn: 'hub',
  });
}

const refusals = () =>
  env.audit
    .filter((x) => x.action === 'channel.approval.refused')
    .map((x) => (x.detail as { reason: string; via?: string }).reason);

describe('Hub-only approval cards in channels', () => {
  it('get a prompt without buttons that says to answer in Nova', async () => {
    const { threadId, turnId } = await heldTurn();
    const a = hubOnly(threadId);
    await env.service.onApprovalRequested({
      accountId: ACCOUNT,
      threadId,
      turnId,
      approvalId: a.id,
    });
    const prompt = tg.of('sendMessage').at(-1)!;
    expect(prompt.reply_markup).toBeUndefined();
    expect(prompt.text).toContain(HUB_ONLY_TEXT);
    expect(approvalPrompt({ ...a, answerIn: null })).toContain('Reply "allow');
  });

  it('refuses a button press', async () => {
    const { b, deliver, threadId } = await heldTurn();
    const a = hubOnly(threadId);
    const press = tg.callback({ chat: OWNER, from: OWNER, data: `nova:a:${a.id}:o`, messageId: 5 });
    expect(await deliver(press)).toMatchObject({ reason: 'refused:hub_only' });
    expect(approvals.decided).toEqual([]);
    expect(refusals()).toEqual(['hub_only']);
    expect(tg.of('answerCallbackQuery').at(-1)).toMatchObject({ text: HUB_ONLY_TEXT });
    expect(env.audit.at(-1)).toMatchObject({ actor: `channel:${b.id}`, detail: { via: 'button' } });
  });

  it('refuses a text answer', async () => {
    const { deliver, threadId } = await heldTurn();
    const a = hubOnly(threadId);
    const reply = tg.message({ chat: OWNER, from: OWNER, text: `allow ${approvalCode(a.id)}` });
    // (The first turn is still held: read the outcome without waiting for it.)
    expect(await deliver(reply)).toMatchObject({ reason: 'refused:hub_only' });
    expect(approvals.decided).toEqual([]);
    expect(refusals()).toEqual(['hub_only']);
    expect(tg.of('sendMessage').at(-1)!.text).toBe(HUB_ONLY_TEXT);
  });

  it('refuses a signed email link, even one that exists', async () => {
    const { b, threadId } = await heldTurn();
    const a = hubOnly(threadId);
    // A link is never made for such a card; one made by other means answers nothing either.
    const links = new ApprovalLinks({ db: env.db, secrets: env.secrets });
    const token = await links.create({
      accountId: ACCOUNT,
      bindingId: b.id,
      approvalId: a.id,
      expiresAt: new Date(Date.now() + 600_000),
    });
    await expect(env.service.approvalLinkView(token)).rejects.toMatchObject({ code: 'not_found' });
    await expect(env.service.answerByLink(token, 'allow_once')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(approvals.decided).toEqual([]);
    expect(
      env.audit.filter((x) => x.action === 'channel.approval.refused').map((x) => x.detail),
    ).toEqual([expect.objectContaining({ reason: 'hub_only', via: 'link' })]);
    // The same card without the attribute is answered by its link (the path itself works).
    const plain = approvals.add(threadId, { options: ['allow_once', 'deny_continue'] });
    const ok = await links.create({
      accountId: ACCOUNT,
      bindingId: b.id,
      approvalId: plain.id,
      expiresAt: new Date(Date.now() + 600_000),
    });
    expect(await env.service.answerByLink(ok, 'allow_once')).toMatchObject({
      decision: 'allow_once',
    });
  });
});
