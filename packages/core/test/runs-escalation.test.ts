// Chat escalation to Work (FR-186, ADR-077) and the deep research template (FR-220): work.start
// proposes or starts a run that keeps the chat's project and context; a proposed run carries the
// user's authority only after Start; deep research plans sub-questions, fans out to read-only
// researchers and succeeds only when the cited report is saved.
/* eslint-disable @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import { DEEP_RESEARCH, RESEARCH_TOOLS } from '../src/index.ts';
import { ACCOUNT, makeRunsEnv, type RunsEnv } from './runs-env.ts';

let e: RunsEnv;

beforeEach(async () => {
  e = await makeRunsEnv();
});

afterEach(async () => {
  await e.close();
});

const text = (r: { ok: boolean; content?: { type: string; text?: string }[] }) =>
  r.ok ? (r.content?.[0]?.text ?? '') : '';

async function workStart(threadId: string, args: Record<string, unknown>) {
  const tool = (await e.runs.toolSource.list(ACCOUNT)).find(
    (t) => t.descriptor.name === 'work.start',
  )!;
  return tool.handler(args, {
    accountId: ACCOUNT,
    threadId,
    turnId: 'chat-turn',
    callId: uuidv7(),
    projectId: null,
    origin: 'model',
    profile: { id: 'workspace', hash: 'x' },
    roots: [],
    sandbox: {} as never,
    signal: new AbortController().signal,
    log: {} as never,
  });
}

function say(threadId: string, role: 'user' | 'assistant', words: string) {
  const id = uuidv7();
  const now = new Date().toISOString();
  e.env.db.raw
    .prepare(
      "INSERT INTO message (id, thread_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'complete', ?, ?)",
    )
    .run(id, threadId, role, now, now);
  e.env.db.raw
    .prepare(
      "INSERT INTO message_part (id, message_id, idx, type, content, created_at) VALUES (?, ?, 0, 'text', ?, ?)",
    )
    .run(uuidv7(), id, words, now);
}

describe('chat escalation (FR-186)', () => {
  it('propose: a run card waits in planning; Start gives it the user authority', async () => {
    const project = await e.env.projects.create(ACCOUNT, { name: 'Docs' });
    const chat = await e.env.threads.create(ACCOUNT, { mode: 'chat', projectId: project.id });
    say(chat.id, 'user', 'Please audit every page of the docs and fix broken links.');
    say(chat.id, 'assistant', 'That needs many steps; I will propose a Work run.');
    const r = await workStart(chat.id, {
      objective: 'Audit the docs and fix broken links',
      plan: [{ title: 'Crawl' }, { title: 'Fix' }],
    });
    const out = JSON.parse(text(r)) as { runId: string; threadId: string; status: string };
    expect(out.status).toBe('proposed');
    expect(e.turns.started).toHaveLength(0);
    const run = await e.runs.get(ACCOUNT, out.runId);
    expect(run).toMatchObject({
      status: 'planning',
      origin: 'chat_escalation',
      originRef: chat.id,
      projectId: project.id,
      planApproved: false,
      derived: { status: 'needs_input', reason: 'Waiting to start' },
    });
    expect(run.plan?.map((s) => s.title)).toEqual(['Crawl', 'Fix']);
    // It is listed under Work, linked to the chat.
    expect((await e.runs.list(ACCOUNT, { projectId: project.id })).items[0]?.originRef).toBe(
      chat.id,
    );
    let chatBlock: { text: string; trusted: boolean } | undefined;
    let objective: { trusted: boolean } | undefined;
    e.turns.script = async (t) => {
      chatBlock = t.addition?.context?.find((b) => b.label === 'From the chat');
      objective = t.addition?.context?.find((b) => b.label === 'Run objective');
      return { reply: 'Fixed 3 links.' };
    };
    const started = await e.runs.start(ACCOUNT, out.runId);
    expect(started.planApproved).toBe(true);
    expect(e.turns.started[0]).toMatchObject({
      text: 'Audit the docs and fix broken links',
      authority: { kind: 'user', source: `run:${out.runId}` },
    });
    await e.settle();
    expect(chatBlock?.trusted).toBe(false);
    expect(chatBlock?.text).toMatch(/User: Please audit every page/);
    expect(objective?.trusted).toBe(true);
    expect((await e.runs.get(ACCOUNT, out.runId)).status).toBe('done');
  });

  it('auto: the run starts at once without the user authority', async () => {
    e.settings.escalation = 'auto';
    const chat = await e.env.threads.create(ACCOUNT, { mode: 'chat' });
    const r = await workStart(chat.id, { objective: 'Rename the files', title: 'Rename' });
    const out = JSON.parse(text(r)) as { runId: string; status: string };
    expect(out.status).toBe('running');
    expect(r.ok && r.meta).toMatchObject({ runId: out.runId, status: 'running' });
    expect(e.turns.started[0]).toMatchObject({
      text: 'Rename the files',
      authority: { kind: 'none', origin: 'system' },
    });
    await e.settle();
    expect((await e.runs.get(ACCOUNT, out.runId)).title).toBe('Rename');
  });

  it('off: work.start is not offered and refuses; it works only in chats', async () => {
    const chat = await e.env.threads.create(ACCOUNT, { mode: 'chat' });
    expect((await e.runs.toolsFor(ACCOUNT, chat.id)).map((t) => t.descriptor.name)).toEqual([
      'work.start',
    ]);
    // Per turn, a chat lists only work.start (ToolListScope); without a scope, everything.
    const scoped = (threadId: string | null, mode: 'chat' | 'work' | 'code') =>
      e.runs.toolSource
        .list(ACCOUNT, { threadId, mode })
        .then((l) => l.map((t) => t.descriptor.name));
    expect(await scoped(chat.id, 'chat')).toEqual(['work.start']);
    expect(await scoped(null, 'chat')).toEqual([]);
    expect(await scoped(chat.id, 'code')).toEqual([]);
    expect((await e.runs.toolSource.list(ACCOUNT)).length).toBe(12);
    e.settings.escalation = 'off';
    expect(await scoped(chat.id, 'chat')).toEqual([]);
    expect(await e.runs.toolsFor(ACCOUNT, chat.id)).toEqual([]);
    expect(
      await e.runs.extension.forTurn({
        accountId: ACCOUNT,
        threadId: chat.id,
        turnId: 't',
        mode: 'chat',
        trigger: 'user',
        projectId: null,
      }),
    ).toBeNull();
    expect(await workStart(chat.id, { objective: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'escalation_off' },
    });
    e.settings.escalation = 'propose';
    const work = await e.env.threads.create(ACCOUNT, { mode: 'work' });
    expect(await workStart(work.id, { objective: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'not_in_chat' },
    });
    expect(
      await e.runs.extension.forTurn({
        accountId: ACCOUNT,
        threadId: work.id,
        turnId: 't',
        mode: 'work',
        trigger: 'user',
        projectId: null,
      }),
    ).toBeNull();
    expect(await e.runs.toolsFor(ACCOUNT, work.id)).toEqual([]);
  });
});

describe('deep research (FR-220)', () => {
  it('plans sub-questions, fans out to researchers and saves a cited report', async () => {
    let blocks: string[] = [];
    let childTools: string[] = [];
    e.turns.script = async (t) => {
      if (t.input.authorKind === 'subagent') {
        childTools = (
          await e.runs.toolSource.list(ACCOUNT, { threadId: t.input.threadId, mode: 'work' })
        ).map((x) => x.descriptor.name);
        t.step({ tokens: 200 });
        return {
          reply: `Answer to "${t.input.text}" [1] https://example.org/${t.input.text.length}`,
        };
      }
      blocks = (t.addition?.context ?? []).map((b) => b.label);
      const questions = ['What is it?', 'Who uses it?'];
      await t.call('plan.set', { steps: questions.map((q) => ({ title: q })) });
      const ids: string[] = [];
      for (const q of questions) {
        const s = JSON.parse(
          text(
            await t.call('task.spawn', { role: 'researcher', objective: q, tools: RESEARCH_TOOLS }),
          ),
        ) as { id: string };
        ids.push(s.id);
      }
      const waited = JSON.parse(text(await t.call('task.wait', { ids }))) as {
        results: { result: string }[];
      };
      for (let i = 0; i < questions.length; i++)
        await t.call('plan.update', { idx: i, status: 'done' });
      const report = `# Report\n\n${waited.results.map((r) => r.result).join('\n\n')}\n\n## Sources\n1. https://example.org`;
      const id = await t.saveArtifact('Research report', report);
      await t.call('run.complete', { summary: 'Report saved.', artifactIds: [id] });
      return { reply: 'Report saved.' };
    };
    const v = await e.runs.create({
      accountId: ACCOUNT,
      objective: 'Research the fixture corpus',
      origin: 'user',
      authority: { kind: 'user', source: 'test' },
      start: true,
      template: 'deep_research',
    });
    expect(v.expectedOutput).toEqual({ kind: 'artifact' });
    await e.settle();
    expect(blocks).toContain('Deep research');
    expect(DEEP_RESEARCH).toMatch(/researcher/);
    // A researcher gets no run tools but run.complete, and the read-only profile.
    expect(childTools).toEqual(['run.complete']);
    const stored = e.env.db.raw.prepare('SELECT tools_json AS t FROM subagent LIMIT 1').get() as {
      t: string;
    };
    expect(JSON.parse(stored.t)).toEqual(RESEARCH_TOOLS);
    const r = await e.runs.get(ACCOUNT, v.id);
    expect(r.status).toBe('done');
    expect(r.outputVerifiedAt).not.toBeNull();
    expect(r.plan?.every((s) => s.status === 'done')).toBe(true);
    const subs = await e.runs.subagents(ACCOUNT, v.id);
    expect(subs.map((s) => [s.role, s.status])).toEqual([
      ['researcher', 'done'],
      ['researcher', 'done'],
    ]);
    expect(await e.runs.policy.forThread(ACCOUNT, subs[0]!.threadId!)).toMatchObject({
      profileId: 'read-only',
    });
    expect(r.used.tokens).toBe(400);
  });

  it('ends output_missing when no report artifact is saved', async () => {
    e.turns.script = async () => ({ reply: 'I ran out of ideas.' });
    const v = await e.runs.create({
      accountId: ACCOUNT,
      objective: 'Research',
      origin: 'user',
      authority: { kind: 'user', source: 'test' },
      start: true,
      template: 'deep_research',
    });
    await e.settle();
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('output_missing');
  });
});

describe('delegation (FR-059 stub)', () => {
  it('a child run is capped by its parent and counts toward it', async () => {
    e.turns.script = async (t) => {
      await t.hold();
      return {};
    };
    const parent = await e.runs.create({
      accountId: ACCOUNT,
      objective: 'Parent',
      origin: 'user',
      authority: { kind: 'user', source: 'test' },
      start: true,
      budgets: { tokens: 5000 },
    });
    e.turns.script = async (t) => {
      t.step({ tokens: 3000 });
      return { reply: 'child done' };
    };
    const { runId } = await e.runs.starter.createRun({
      accountId: ACCOUNT,
      objective: 'Child',
      origin: 'delegation',
      parentRunId: parent.id,
      authority: { kind: 'none', origin: 'system' },
      start: true,
      budgets: { tokens: 50_000 },
    });
    const fin = await e.runs.starter.whenFinished(ACCOUNT, runId);
    expect(fin.status).toBe('done');
    const child = await e.runs.get(ACCOUNT, runId);
    expect(child.budgets.tokens).toBe(5000);
    expect(child.parentRunId).toBe(parent.id);
    expect((await e.runs.get(ACCOUNT, parent.id)).used.tokens).toBe(3000);
    e.turns.release(parent.threadId);
    await e.settle();
  });
});
