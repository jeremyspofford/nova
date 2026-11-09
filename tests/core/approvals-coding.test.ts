// An approval tier lowered in settings takes effect in the real code path (owner ruling 2026-11-09,
// decision 8): with coding merge set to 1, "does it and tells you", a reviewed change merges once its
// check is done, without waiting for an OK, and it is still exactly the reviewed diff. Throwaway
// repositories in a temp folder, the Claude Code stand-in as the agent; nothing pushes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { FAKE_CLAUDE, agentScript, git, makeRepos, treeHash } from '../support/coding.ts';

async function settle(core: Core, id: string) {
  for (let i = 0; i < 800; i++) {
    await core.ledger.idle();
    const t = core.ledger.get(id);
    if (['done', 'failed', 'cancelled', 'waiting'].includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  return core.ledger.get(id);
}

test('coding merge lowered to tier 1: the reviewed change merges without an approval, and nothing is pushed', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-approvals-coding-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, coding: { testTimeoutS: 60, previewTimeoutS: 20 } });
  core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
  const repos = makeRepos();
  core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE} --script ${agentScript('fix', join(repos.dir, 'scripts'))}` }, { confirm: true });
  core.providers.enable('claude-code', { approved: true });
  const remoteBefore = treeHash(repos.remote);
  try {
    core.approvals.set('coding.merge', 1, { confirm: true });
    const { run: { id: run }, task } = await core.coding.start({ repo: repos.person, goal: 'Make greet() say “Hello, <name>!”, as the test expects.', test_command: 'node --test' });
    assert.equal((await settle(core, task.id)).state, 'done');
    const check = core.ledger.get(core.coding.view(run).tasks.find((x) => x.step === 'check')!.id);
    // The check is still tier 2: only merge was lowered.
    assert.equal((await settle(core, check.id)).state, 'waiting');
    core.ledger.approve(check.id);
    await settle(core, check.id);
    const ref = core.coding.view(run).tasks.find((x) => x.step === 'merge')!;
    const merged = await settle(core, ref.id);
    assert.deepEqual([merged.state, merged.approval_tier, merged.approved_at], ['done', 1, null], `merge: ${merged.reason}`);
    const v = core.coding.view(run);
    assert.equal(v.state, 'merged');
    assert.equal(git(repos.person, 'rev-parse', 'main'), v.head, 'main is the reviewed commit');
    assert.equal(treeHash(repos.remote), remoteBefore, 'nothing was pushed');
    // Nova's words followed the setting: no message or plan step claimed it would ask before the merge.
    const messages = core.db.all<{ text: string }>('SELECT text FROM message').map((m) => m.text).join('\n');
    assert.match(messages, /Nova is merging it into main now, without asking \(you set merges to not ask\)/);
    assert.doesNotMatch(messages, /only when you confirm|asks before it merges|merges it into main only/);
    const plan = (core.ledger.get(task.id).brief.inputs?.plan as string[]).join('\n');
    assert.match(plan, /Merge into main, without asking \(your setting\), and tell you\. Nothing is pushed\./);
    assert.match(plan, /after your OK\./, 'the check still asks: only merge was lowered');
  } finally {
    await core.close();
  }
});
