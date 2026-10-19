// A sub-agent's tool list (FR-053), enforced at the gate through `runs.toolLimits`: a child given
// a list may call only those tools plus reporting back and the loop's own tools; a child without
// a list, the run's own thread and other accounts are not limited.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { limitDenial } from '../src/approvals/index.ts';
import { ACCOUNT, makeRunsEnv, type RunsEnv } from './runs-env.ts';

let e: RunsEnv;

beforeEach(async () => {
  e = await makeRunsEnv();
  e.settings.subagents = { maxChildren: 3, maxConcurrent: 3 };
});

afterEach(async () => {
  await e.close();
});

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("a sub-agent's tool list (FR-053)", () => {
  it('limits the child that has one, at the gate', async () => {
    const children: { text: string; threadId: string }[] = [];
    let runThread = '';
    e.turns.script = async (t) => {
      if (t.input.authorKind === 'subagent') {
        children.push({ text: t.input.text, threadId: t.input.threadId });
        return { reply: 'ok' };
      }
      runThread = t.input.threadId;
      await t.call('task.spawn', {
        role: 'researcher',
        objective: 'limited',
        tools: ['web.search'],
      });
      await t.call('task.spawn', { role: 'helper', objective: 'free' });
      await t.hold();
      return { reply: 'done' };
    };
    const v = await e.runs.create({
      accountId: ACCOUNT,
      objective: 'Compare',
      origin: 'user',
      authority: { kind: 'user', source: 'test' },
      start: true,
    });
    await waitUntil(() => children.length === 2);
    const limited = children.find((c) => c.text.includes('limited'))!.threadId;
    const free = children.find((c) => c.text.includes('free'))!.threadId;
    const l = await e.runs.toolLimits.forThread(ACCOUNT, limited);
    expect(l?.allow).toEqual([
      'web.search',
      'run.complete',
      'tool.search',
      'context.remaining',
      'context.fresh',
    ]);
    expect(limitDenial(l!, { name: 'exec.run', source: 'builtin' }, null)).toBe(
      "the tool is not in this sub-agent's tool list",
    );
    expect(limitDenial(l!, { name: 'web.search', source: 'builtin' }, null)).toBeNull();
    expect(limitDenial(l!, { name: 'run.complete', source: 'builtin' }, null)).toBeNull();
    expect(await e.runs.toolLimits.forThread(ACCOUNT, free)).toBeNull();
    expect(await e.runs.toolLimits.forThread(ACCOUNT, runThread)).toBeNull();
    expect(await e.runs.toolLimits.forThread('someone-else', limited)).toBeNull();
    e.turns.release(v.threadId);
    await e.settle();
  });
});
