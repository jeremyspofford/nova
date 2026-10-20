// Members and shared threads (decision 5, FR-217): a member never sees the owner's memory,
// threads or user instructions; a shared thread injects nobody's memory, instructions or private
// connectors; a turn there runs under the account that wrote it; the thread shows who said what;
// nothing said there becomes anyone's memory.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SHARED_THREAD_LIMITS,
  limitDenial,
  ok,
  type SharedThreadService,
  type ToolDefinition,
  type ToolGate,
  type ToolSourceProvider,
} from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { allText, makeTeamEnv, systemText, type TeamEnv } from './team-env.ts';

let env: TeamEnv;
let sharedRef: SharedThreadService | null = null;
const mcpCalls: string[] = [];

/** A connector of whoever lists it (an MCP server is per account). */
const secretTool: ToolDefinition = {
  descriptor: {
    name: 'mcp.secret',
    title: 'Secret',
    description: 'reads a private connector',
    source: 'mcp',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    loading: 'always',
    deferred: false,
    effects: [],
  },
  handler: (_args, ctx) => {
    mcpCalls.push(ctx.accountId);
    return Promise.resolve(ok(`private data of ${ctx.accountId}`));
  },
};
const connectors: ToolSourceProvider = { source: 'mcp', list: () => Promise.resolve([secretTool]) };

/** Applies the shared-thread tool limits the way the policy gate does. */
const limitingGate: ToolGate = {
  check: async (req) => {
    const limits = await sharedRef?.toolLimits.forThread(req.accountId, req.threadId);
    const why = limits ? limitDenial(limits, req.tool, req.tool.pluginId ?? null) : null;
    return why
      ? { effect: 'deny', reason: why, tier: 'pre_approvable', stop: false }
      : { effect: 'allow', reason: 'test', tier: 'pre_approvable' };
  },
  preview: async (req) => {
    const limits = await sharedRef?.toolLimits.forThread(req.accountId, req.threadId);
    const why = limits ? limitDenial(limits, req.tool, null) : null;
    return {
      effect: why ? 'deny' : 'allow',
      tier: 'pre_approvable',
      reason: why ?? 'test',
      source: 'fallback',
      ruleId: null,
    };
  },
};

beforeEach(async () => {
  mcpCalls.length = 0;
  env = await makeTeamEnv({ sources: [connectors], gate: limitingGate });
  sharedRef = env.shared;
});

afterEach(async () => {
  sharedRef = null;
  await env.close();
});

async function turn(accountId: string, threadId: string, text: string) {
  const res = await env.chat.send(accountId, threadId, { text });
  await env.chat.idle();
  return res;
}

const lastRequest = () => env.mock.requests.at(-1)!;

describe('members (decision 5)', () => {
  it("a member's chats never carry the owner's memory or user instructions, nor the other way", async () => {
    const bea = await env.addMember('Bea');
    await env.memory.create(ACCOUNT, { content: 'The owner paints with teal' });
    await env.memory.create(bea, { content: 'Bea keeps honey bees' });
    writeFileSync(join(env.dir, 'data', 'instructions.md'), 'OWNER-INSTRUCTIONS: answer in haiku');

    const mine = await env.threads.create(ACCOUNT, {});
    await turn(ACCOUNT, mine.id, 'what about teal and bees?');
    // The baseline: the owner's own chat does get the owner's memory and instructions.
    expect(systemText(lastRequest())).toContain('teal');
    expect(systemText(lastRequest())).toContain('OWNER-INSTRUCTIONS');
    expect(systemText(lastRequest())).not.toContain('honey bees');

    const hers = await env.threads.create(bea, {});
    await turn(bea, hers.id, 'what about teal and bees?');
    expect(systemText(lastRequest())).toContain('honey bees');
    expect(systemText(lastRequest())).not.toContain('teal');
    expect(systemText(lastRequest())).not.toContain('OWNER-INSTRUCTIONS');

    // Neither reads the other's threads or memory.
    await expect(env.threads.row(bea, mine.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(env.chat.send(bea, mine.id, { text: 'hi' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await env.threads.list(bea)).items.map((t) => t.id)).toEqual([hers.id]);
    expect((await env.memory.list(bea)).map((m) => m.content)).toEqual(['Bea keeps honey bees']);
  });
});

describe('shared threads (FR-217)', () => {
  it("inject nobody's memory or instructions, and run each turn under its writer", async () => {
    const bea = await env.addMember('Bea');
    await env.memory.create(ACCOUNT, { content: 'The owner paints with teal' });
    await env.memory.create(bea, { content: 'Bea keeps honey bees' });
    writeFileSync(join(env.dir, 'data', 'instructions.md'), 'OWNER-INSTRUCTIONS: answer in haiku');
    const t = await env.threads.create(ACCOUNT, {});
    await turn(ACCOUNT, t.id, 'hello before sharing');
    const view = await env.shared.share(ACCOUNT, t.id, [bea]);
    expect(view).toMatchObject({ you: 'owner', participants: [{ accountId: bea }] });
    expect((await env.threads.row(ACCOUNT, t.id)).memoryOptOut).toBe(true);

    const before = env.envelopes.length;
    await turn(bea, t.id, 'teal and bees, anyone?');
    let sys = systemText(lastRequest());
    expect(sys).not.toContain('teal');
    expect(sys).not.toContain('honey bees');
    expect(sys).not.toContain('OWNER-INSTRUCTIONS');
    // The conversation itself is shared: Bea's turn reads what the owner said.
    expect(allText(lastRequest())).toContain('hello before sharing');
    // Bea's turn is hers: its events name her account.
    const started = env.envelopes.slice(before).find((e) => e.name === 'turn.started');
    expect(started?.accountId).toBe(bea);

    await turn(ACCOUNT, t.id, 'teal and bees again');
    sys = systemText(lastRequest());
    expect(sys).not.toContain('teal');
    expect(sys).not.toContain('honey bees');
    expect(sys).not.toContain('OWNER-INSTRUCTIONS');

    // Who said what.
    const d = await env.shared.detail(bea, t.id);
    expect(d.you).toBe('participant');
    const said = d.messages.map((m) => [m.role, d.authors[m.id]?.accountId, d.authors[m.id]?.as]);
    expect(said).toEqual([
      ['user', ACCOUNT, 'wrote'],
      ['assistant', ACCOUNT, 'asked'],
      ['user', bea, 'wrote'],
      ['assistant', bea, 'asked'],
      ['user', ACCOUNT, 'wrote'],
      ['assistant', ACCOUNT, 'asked'],
    ]);
    expect(d.authors[d.messages[2]!.id]?.displayName).toBe('Bea');
  });

  it("names who wrote each message in the owner's ordinary chat view, and nobody in a private one", async () => {
    const bea = await env.addMember('Bea');
    const t = await env.threads.create(ACCOUNT, {});
    await turn(ACCOUNT, t.id, 'hello before sharing');
    const quiet = await env.threads.create(ACCOUNT, {});
    await turn(ACCOUNT, quiet.id, 'just me');
    // Not shared yet: no names.
    expect((await env.threads.detail(ACCOUNT, t.id)).messages.some((m) => m.author)).toBe(false);
    await env.shared.share(ACCOUNT, t.id, [bea]);
    await turn(bea, t.id, 'hi from Bea');

    const d = await env.threads.detail(ACCOUNT, t.id);
    expect(d.messages.map((m) => [m.role, m.author?.accountId ?? null])).toEqual([
      ['user', ACCOUNT],
      ['assistant', null],
      ['user', bea],
      ['assistant', null],
    ]);
    // Only the id and the display name.
    expect(d.messages[2]!.author).toEqual({ accountId: bea, displayName: 'Bea' });
    expect(Object.keys(d.messages[0]!.author!)).toEqual(['accountId', 'displayName']);
    // A private chat names nobody.
    expect((await env.threads.detail(ACCOUNT, quiet.id)).messages.some((m) => m.author)).toBe(
      false,
    );
  });

  it('remembers nothing said there, for anyone', async () => {
    const bea = await env.addMember('Bea');
    const t = await env.threads.create(ACCOUNT, {});
    await env.shared.share(ACCOUNT, t.id, [bea]);
    await turn(bea, t.id, 'Remember that my locker code is 4242');
    await turn(ACCOUNT, t.id, 'Remember that the gate code is 9191');
    // The same sentence in a private chat is remembered (the baseline).
    const own = await env.threads.create(bea, {});
    await turn(bea, own.id, 'Remember that I like quiet mornings');
    const all = [...(await env.memory.list(bea)), ...(await env.memory.list(ACCOUNT))].map(
      (m) => m.content,
    );
    expect(all.some((c) => c.includes('quiet mornings'))).toBe(true);
    expect(all.some((c) => c.includes('4242') || c.includes('9191'))).toBe(false);
  });

  it("offers nobody's private connectors, while each person's own chats keep theirs", async () => {
    const bea = await env.addMember('Bea');
    const t = await env.threads.create(ACCOUNT, {});
    await env.shared.share(ACCOUNT, t.id, [bea]);
    await turn(bea, t.id, '/tool mcp.secret {}');
    expect(lastRequest().tools?.map((x) => x.name) ?? []).not.toContain('mcp.secret');
    expect(mcpCalls).toEqual([]);
    // Calls in the shared thread were checked under Bea's account.
    const inShared = env.gateCalls.filter((c) => c.threadId === t.id);
    expect(inShared.length).toBeGreaterThan(0);
    expect(inShared.every((c) => c.accountId === bea)).toBe(true);

    const own = await env.threads.create(bea, {});
    await turn(bea, own.id, '/tool mcp.secret {}');
    expect(mcpCalls).toEqual([bea]);
    expect(
      limitDenial(SHARED_THREAD_LIMITS, { name: 'channel.send', source: 'builtin' }, null),
    ).toMatch(/private connectors/);
    expect(limitDenial(SHARED_THREAD_LIMITS, { name: 'web.search', source: 'builtin' }, null)).toBe(
      null,
    );
  });

  it('is shared only by its owner, with people of the Hub, and only plain chats', async () => {
    const bea = await env.addMember('Bea');
    const cy = await env.addMember('Cy');
    const t = await env.threads.create(ACCOUNT, {});
    await expect(env.shared.share(bea, t.id, [cy])).rejects.toMatchObject({ code: 'not_found' });
    await expect(env.shared.share(ACCOUNT, t.id, ['nobody'])).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'not_a_person' },
    });
    await expect(env.shared.share(ACCOUNT, t.id, [ACCOUNT])).rejects.toMatchObject({
      code: 'validation',
    });
    const project = await env.projects.create(ACCOUNT, { name: 'P' });
    const inProject = await env.threads.create(ACCOUNT, { projectId: project.id });
    await expect(env.shared.share(ACCOUNT, inProject.id, [bea])).rejects.toMatchObject({
      details: { reason: 'not_shareable' },
    });
    const tmp = await env.threads.create(ACCOUNT, { temporary: true });
    await expect(env.shared.share(ACCOUNT, tmp.id, [bea])).rejects.toMatchObject({
      details: { reason: 'not_shareable' },
    });

    await env.shared.share(ACCOUNT, t.id, [bea, cy]);
    expect((await env.shared.list(cy)).map((s) => s.thread.id)).toEqual([t.id]);
    // A participant cannot take someone else out, but may leave.
    await expect(env.shared.unshare(bea, t.id, cy)).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await env.shared.unshare(cy, t.id, cy);
    await expect(env.shared.detail(cy, t.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(env.chat.send(cy, t.id, { text: 'still here?' })).rejects.toMatchObject({
      code: 'not_found',
    });
    // The owner takes Bea out: the thread is no longer shared.
    await env.shared.unshare(ACCOUNT, t.id, bea);
    expect(env.shared.sharing(t.id)).toBeNull();
    expect(env.shared.canSee(bea, t.id)).toBe(false);
    await expect(env.shared.unshare(ACCOUNT, t.id, bea)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses edits and regeneration of what others said', async () => {
    const bea = await env.addMember('Bea');
    const t = await env.threads.create(ACCOUNT, {});
    await turn(ACCOUNT, t.id, 'first');
    await env.shared.share(ACCOUNT, t.id, [bea]);
    const d = await env.shared.detail(ACCOUNT, t.id);
    await expect(
      env.chat.edit(ACCOUNT, t.id, d.messages[0]!.id, { text: 'changed' }),
    ).rejects.toMatchObject({ details: { reason: 'shared_thread' } });
    await expect(env.chat.regenerate(bea, t.id, d.messages[1]!.id)).rejects.toMatchObject({
      details: { reason: 'shared_thread' },
    });
  });

  it('shows participants the conversation live, and approvals only to their person', async () => {
    const bea = await env.addMember('Bea');
    const t = await env.threads.create(ACCOUNT, {});
    await env.shared.share(ACCOUNT, t.id, [bea]);
    const msg = {
      id: 'e1',
      name: 'chat.message.created',
      schemaVersion: 1,
      ts: '',
      actor: 'user',
      accountId: ACCOUNT,
      correlation: { threadId: t.id },
      payload: {},
    };
    expect(env.shared.visible(bea, t.id, msg)).toBe(true);
    expect(env.shared.visible(bea, t.id, { ...msg, name: 'approval.requested' })).toBe(false);
    expect(env.shared.visible(ACCOUNT, t.id, { ...msg, name: 'approval.requested' })).toBe(true);
    expect(env.shared.visible(bea, 'other', msg)).toBe(false);
  });

  it('ends with a removed member: the shares go and the account is closed', async () => {
    const bea = await env.addMember('Bea');
    const t = await env.threads.create(ACCOUNT, {});
    await env.shared.share(ACCOUNT, t.id, [bea]);
    await env.team.removeMember(ACCOUNT, bea);
    expect(env.shared.sharing(t.id)).toBeNull();
    expect(env.team.roleOf(bea)).toBeNull();
    expect(env.sessions.revoked).toEqual([bea]);
  });
});
