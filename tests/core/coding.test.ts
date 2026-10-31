// Coding through chat (M10c, docs/plans/M10c.md): a coding run through the Work Ledger, with the
// Claude Code stand-in (and Codex's and Relay's) as the agent, on throwaway repositories in a temp
// folder: a small project as the person's, a bare clone beside it as its "remote". Nothing pushes,
// and no test touches any other repository.
//   - the gate: a reviewed diff, green tests and a running preview, and only then the merge ask, at
//     tier 3; declining leaves the person's repository and the remote byte-identical;
//   - approving merges exactly the reviewed diff, and pushes nothing;
//   - the branch moved after review: nothing merged, a new round, asked again;
//   - a failing test never reaches the merge ask;
//   - what Nova refuses from an agent; a preview open to the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { startFakeRelay } from '../../scripts/stand-ins/fake-relay.js';
import { APP_FIXED, FAKE_CLAUDE, FAKE_CODEX, agentScript, git, makeRepos, treeHash, type Repos } from '../support/coding.ts';

function boot() {
  const home = mkdtempSync(join(tmpdir(), 'nova-coding-home-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, coding: { testTimeoutS: 60, previewTimeoutS: 20 } });
  core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
  return { core, home };
}

const claude = (core: Core, script: string) => {
  core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE} --script ${script}` }, { confirm: true });
  core.providers.enable('claude-code', { approved: true });
};

async function settle(core: Core, id: string) {
  for (let i = 0; i < 800; i++) {
    await core.ledger.idle();
    const t = core.ledger.get(id);
    if (['done', 'failed', 'cancelled', 'waiting'].includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  return core.ledger.get(id);
}

// The run's task for a step (the newest round's unless said).
const taskOf = (core: Core, run: string, step: string, round?: number) => {
  const v = core.coding.view(run);
  const ref = v.tasks.filter((x) => x.step === step && (round === undefined || x.round === round)).at(-1);
  return ref ? core.ledger.get(ref.id) : null;
};

// Starts a run and takes it to the merge ask: the write, then the person's OK to test and preview.
async function toReview(core: Core, repos: Repos, more: Record<string, unknown> = {}) {
  const { run: { id: run }, task } = await core.coding.start({ repo: repos.person, goal: 'Make greet() say “Hello, <name>!”, as the test expects.', test_command: 'node --test', preview_command: 'node server.mjs', ...more });
  const write = await settle(core, task.id);
  assert.equal(write.state, 'done', `write: ${write.reason}`);
  const check = taskOf(core, run, 'check')!;
  assert.ok(check, 'a check step follows the write');
  const asked = await settle(core, check.id);
  return { run, write, check: asked };
}

test('M10c gate: a coding request ends as a reviewed diff with green tests and a running preview, asks before merge, and declining leaves nothing merged', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, agentScript('fix', join(repos.dir, 'scripts')));
  const personBefore = treeHash(repos.person);
  const remoteBefore = treeHash(repos.remote);
  const mainBefore = git(repos.person, 'rev-parse', 'main');
  let url = '';
  try {
    const { run, write, check } = await toReview(core, repos);
    // Write: tier 1, Nova's own worktree, verified by Nova reading its own repository.
    assert.equal(write.approval_tier, 1);
    assert.ok(write.verification?.ok);
    assert.match(write.verification!.checks[0]!.why, /nova\/r[0-9a-f]+ is at [0-9a-f]{7}/);
    assert.equal(treeHash(repos.person), personBefore, 'the write changed nothing in the person’s repository');
    // Check: asks first (tier 2), because it runs the agent's code.
    assert.equal(check.state, 'waiting');
    assert.equal(check.approval_tier, 2);
    assert.match(String(check.reason), /Needs your OK/);
    let v = core.coding.view(run);
    assert.equal(v.state, 'checking');
    assert.deepEqual(v.changes.map((c) => [c.path, c.kind, c.added, c.removed]), [['app.mjs', 'modified', 1, 1]]);
    assert.match(String(v.diff), /^-export const greet = \(name\) => `Hi \$\{name\}`;$/m);
    assert.match(String(v.diff), /^\+export const greet = \(name\) => `Hello, \$\{name\}!`;$/m);
    assert.equal(taskOf(core, run, 'merge'), null, 'no merge ask before the tests have run');

    core.ledger.approve(check.id);
    const checked = await settle(core, check.id);
    assert.equal(checked.state, 'done', `check: ${checked.reason}`);
    assert.deepEqual(checked.verification!.checks.map((c) => [c.requirement.kind, c.ok]), [['test_result', true], ['confirmation', true]]);

    // The merge ask: tier 3, and by now the person has the diff, the test result and the preview.
    const merge = await settle(core, taskOf(core, run, 'merge')!.id);
    assert.equal(merge.state, 'waiting');
    assert.equal(merge.approval_tier, 3);
    v = core.coding.view(run);
    assert.equal(v.state, 'review');
    assert.equal(v.test!.passed, true);
    assert.equal(v.test!.commit, v.head);
    assert.ok(v.preview?.running, 'the preview is running');
    url = v.preview!.url;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(await (await fetch(url)).text(), 'Hello, preview!', 'the preview serves the change');
    assert.match(String(v.merge), new RegExp(`moves main in .* from ${mainBefore.slice(0, 7)} to ${v.head!.slice(0, 7)}: exactly this diff. Nova doesn’t push`));
    assert.throws(() => core.ledger.approve(merge.id), /explicit confirmation/, 'tier 3 is never approved without confirm');

    // Declining: nothing merged, the person's repository (its .git too) and the remote as they were.
    core.coding.decline(run);
    await core.ledger.idle();
    assert.equal(core.ledger.get(merge.id).state, 'cancelled');
    v = core.coding.view(run);
    assert.equal(v.state, 'declined');
    assert.equal(git(repos.person, 'rev-parse', 'main'), mainBefore);
    assert.equal(treeHash(repos.person), personBefore, 'the person’s repository is byte-identical');
    assert.equal(treeHash(repos.remote), remoteBefore, 'nothing was pushed');
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(3000) }), 'the preview stopped');
  } finally {
    await core.close();
  }
});

test('M10c: approving merges exactly the reviewed diff into the branch, and pushes nothing', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, agentScript('fix', join(repos.dir, 'scripts')));
  const remoteBefore = treeHash(repos.remote);
  const base = git(repos.person, 'rev-parse', 'main');
  try {
    const { run, check } = await toReview(core, repos);
    core.ledger.approve(check.id);
    await settle(core, check.id);
    const merge = await settle(core, taskOf(core, run, 'merge')!.id);
    const reviewed = core.coding.view(run);
    core.ledger.approve(merge.id, { confirm: true });
    const merged = await settle(core, merge.id);
    assert.equal(merged.state, 'done', `merge: ${merged.reason}`);
    assert.ok(merged.verification?.ok);
    const v = core.coding.view(run);
    assert.equal(v.state, 'merged');
    assert.equal(git(repos.person, 'rev-parse', 'main'), reviewed.head, 'main is the reviewed commit');
    assert.equal(`${git(repos.person, 'diff', '--no-color', base, 'main')}\n`, reviewed.diff, 'the merged diff is the reviewed diff');
    assert.equal(readFileSync(join(repos.person, 'app.mjs'), 'utf8'), APP_FIXED, 'the checkout moved with its branch');
    assert.equal(git(repos.person, 'status', '--porcelain'), '', 'and is clean');
    assert.equal(treeHash(repos.remote), remoteBefore, 'nothing was pushed');
    assert.equal(git(repos.remote, 'rev-parse', 'main'), base);
    assert.equal(v.preview?.running, false, 'the preview stopped once merged');
    for (let i = 0; i < 200 && existsSync(join(core.coding.dir, 'runs', run)); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(existsSync(join(core.coding.dir, 'runs', run)), false, 'Nova’s worktree is gone');
  } finally {
    await core.close();
  }
});

test('M10c: the branch moved after review: nothing unreviewed is merged, and Nova asks again', { timeout: 150_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, agentScript('fix', join(repos.dir, 'scripts')));
  try {
    const { run, check } = await toReview(core, repos);
    core.ledger.approve(check.id);
    await settle(core, check.id);
    const merge = await settle(core, taskOf(core, run, 'merge')!.id);
    // Someone commits to main after the review.
    writeFileSync(join(repos.person, 'NOTES.md'), 'A note.\n');
    git(repos.person, 'add', 'NOTES.md');
    git(repos.person, 'commit', '--quiet', '-m', 'A note');
    const moved = git(repos.person, 'rev-parse', 'main');
    const before = treeHash(repos.person);
    core.ledger.approve(merge.id, { confirm: true });
    const refused = await settle(core, merge.id);
    assert.equal(refused.state, 'failed');
    assert.match(String(refused.reason), /main moved since you reviewed the change.*Nova merged nothing/);
    assert.equal(git(repos.person, 'rev-parse', 'main'), moved, 'main is where the person left it');
    assert.equal(treeHash(repos.person), before);
    // A new round: brought up to date, checked again (asking again), and a new merge ask.
    const update = await settle(core, taskOf(core, run, 'update', 2)!.id);
    assert.equal(update.state, 'done', `update: ${update.reason}`);
    const check2 = await settle(core, taskOf(core, run, 'check', 2)!.id);
    assert.equal(check2.state, 'waiting');
    assert.match(String(check2.reason), /Needs your OK/, 'the tests are asked about again');
    core.ledger.approve(check2.id);
    assert.equal((await settle(core, check2.id)).state, 'done');
    const merge2 = await settle(core, taskOf(core, run, 'merge', 2)!.id);
    assert.equal(merge2.state, 'waiting');
    assert.equal(merge2.approved_at, null, 'asked again, not carried over');
    const v = core.coding.view(run);
    assert.equal(v.base, moved, 'reviewed against the new main');
    assert.deepEqual(v.changes.map((c) => c.path), ['app.mjs'], 'the new review is the change, on top of the note');
    core.ledger.approve(merge2.id, { confirm: true });
    assert.equal((await settle(core, merge2.id)).state, 'done');
    assert.equal(git(repos.person, 'rev-parse', 'main'), v.head);
    assert.equal(readFileSync(join(repos.person, 'NOTES.md'), 'utf8'), 'A note.\n');
    assert.equal(readFileSync(join(repos.person, 'app.mjs'), 'utf8'), APP_FIXED);
  } finally {
    await core.close();
  }
});

test('M10c: a failing test run never reaches the merge ask', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, agentScript('wrong', join(repos.dir, 'scripts')));
  const before = treeHash(repos.person);
  try {
    const { run, check } = await toReview(core, repos);
    core.ledger.approve(check.id);
    const failed = await settle(core, check.id);
    assert.equal(failed.state, 'failed');
    assert.match(String(failed.reason), /Nova ran `node --test` itself on [0-9a-f]{7}: it failed.*won’t ask you to merge it/);
    await core.ledger.idle();
    assert.equal(taskOf(core, run, 'merge'), null, 'no merge task was ever made');
    const v = core.coding.view(run);
    assert.equal(v.state, 'failed');
    assert.equal(v.test!.passed, false);
    assert.equal(v.preview, null, 'no preview of a change that fails its tests');
    assert.equal(treeHash(repos.person), before);
  } finally {
    await core.close();
  }
});

test('M10c: what Nova refuses from an agent: the tests, git’s own files, a link out, nothing at all', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  const before = treeHash(repos.person);
  try {
    for (const [kind, why] of [
      ['tests', /changed app\.test\.mjs, which it was not allowed to change.*Nothing was committed/],
      ['gitdir', /\.git.*git’s own.*Nothing was committed/],
      ['link', /leak \(a link to "\/etc\/hostname", outside the repository\).*Nothing was committed/],
      ['nothing', /changed nothing/],
    ] as const) {
      claude(core, agentScript(kind, join(repos.dir, 'scripts')));
      const { run: { id: run }, task } = await core.coding.start({ repo: repos.person, goal: 'Make the test pass.', test_command: 'node --test' });
      const t = await settle(core, task.id);
      assert.equal(t.state, 'failed', kind);
      assert.match(String(t.reason), why, kind);
      await core.ledger.idle();
      assert.equal(taskOf(core, run, 'check'), null, `${kind}: nothing runs`);
      assert.equal(core.coding.view(run).state, 'failed');
    }
    // The person may let the agent change the tests, by saying so.
    claude(core, agentScript('tests', join(repos.dir, 'scripts')));
    const { task } = await core.coding.start({ repo: repos.person, goal: 'Change the test.', test_command: 'node --test', editable: ['app.test.mjs'] });
    assert.equal((await settle(core, task.id)).state, 'done');
    assert.equal(treeHash(repos.person), before, 'the person’s repository untouched throughout');
  } finally {
    await core.close();
  }
});

test('M10c: a preview that listens on every address is stopped, and the check fails', { timeout: 120_000, skip: process.platform !== 'linux' ? 'the loopback check reads /proc/net (Linux)' : false }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, agentScript('fix', join(repos.dir, 'scripts')));
  try {
    const { run, check } = await toReview(core, repos, { preview_command: 'HOST=0.0.0.0 node server.mjs' });
    core.ledger.approve(check.id);
    const failed = await settle(core, check.id);
    assert.equal(failed.state, 'failed');
    assert.match(String(failed.reason), /The preview listened on every address \(0\.0\.0\.0\), not only on this computer, so Nova stopped it/);
    await core.ledger.idle();
    assert.equal(taskOf(core, run, 'merge'), null);
  } finally {
    await core.close();
  }
});

test('M10c: the person’s checkout with uncommitted changes is never merged over', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, agentScript('fix', join(repos.dir, 'scripts')));
  try {
    const { run, check } = await toReview(core, repos);
    core.ledger.approve(check.id);
    await settle(core, check.id);
    const merge = await settle(core, taskOf(core, run, 'merge')!.id);
    writeFileSync(join(repos.person, 'README.md'), '# Edited by hand\n');
    const before = treeHash(repos.person);
    core.ledger.approve(merge.id, { confirm: true });
    const held = await settle(core, merge.id);
    assert.equal(held.state, 'waiting');
    assert.match(String(held.reason), /changes that aren’t committed\. Nova doesn’t merge over them/);
    assert.equal(treeHash(repos.person), before, 'nothing written');
    // Once they are put away, a retry asks again (tier 3, every time).
    git(repos.person, 'checkout', '--', 'README.md');
    const again = core.ledger.retry(merge.id);
    assert.equal(again.state, 'waiting');
    assert.equal(again.approved_at, null);
    core.ledger.approve(merge.id, { confirm: true });
    assert.equal((await settle(core, merge.id)).state, 'done');
    assert.equal(git(repos.person, 'rev-parse', 'main'), core.coding.view(run).head);
  } finally {
    await core.close();
  }
});

test('M10c: undo of the write removes Nova’s worktree and branch; nothing of the person’s changes', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, agentScript('fix', join(repos.dir, 'scripts')));
  const before = treeHash(repos.person);
  try {
    const { run, check } = await toReview(core, repos);
    assert.ok(existsSync(join(core.coding.dir, 'runs', run, 'tree')));
    const v = await core.coding.discard(run);
    assert.equal(v.state, 'discarded');
    assert.equal(core.ledger.get(check.id).state, 'cancelled');
    assert.equal(existsSync(join(core.coding.dir, 'runs', run)), false);
    const mirror = join(core.coding.dir, 'repos', `${createHash('sha256').update(repos.person).digest('hex').slice(0, 16)}.git`);
    assert.ok(existsSync(join(mirror, 'HEAD')), 'Nova’s own copy of the repository stays');
    assert.throws(() => git(mirror, 'rev-parse', '--verify', '--quiet', `refs/heads/nova/${run}`), 'its branch is gone');
    assert.equal(treeHash(repos.person), before);
  } finally {
    await core.close();
  }
});

test('M10c: Codex’s and Relay’s stand-ins write the change too, through the same adapters', { timeout: 150_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  const relay = await startFakeRelay({ mode: 'script', script: { writes: [{ path: 'app.mjs', content: APP_FIXED }], summary: 'Fixed greet().' } });
  try {
    core.providers.configure('codex', { command: `node ${FAKE_CODEX} --script ${agentScript('fix', join(repos.dir, 'scripts'))}` }, { confirm: true });
    core.providers.enable('codex', { approved: true });
    core.providers.configure('relay', { base_url: relay.url, profile: 'Builder', poll_ms: 20 });
    core.providers.enable('relay', { approved: true });
    await core.providers.check('relay');
    for (const agent of ['codex', 'relay']) {
      const { run: { id: run }, task } = await core.coding.start({ repo: repos.person, goal: 'Make greet() say “Hello, <name>!”.', test_command: 'node --test', agent });
      const t = await settle(core, task.id);
      assert.equal(t.state, 'done', `${agent}: ${t.reason}`);
      const v = core.coding.view(run);
      assert.deepEqual(v.changes.map((c) => c.path), ['app.mjs'], agent);
      const check = await settle(core, taskOf(core, run, 'check')!.id);
      core.ledger.approve(check.id);
      assert.equal((await settle(core, check.id)).state, 'done', agent);
      await core.coding.discard(run);
    }
    const receipts = core.receipts.list({ limit: 50 }).map((r: { provider: string }) => r.provider);
    assert.ok(receipts.includes('codex') && receipts.includes('relay'), 'each call has its receipt');
  } finally {
    await core.close();
    await relay.close();
  }
});

test('M10c: starting checks the repository, the branch, the agent and the privacy mode', { timeout: 60_000 }, async () => {
  const { core, home } = boot();
  const repos = makeRepos();
  claude(core, agentScript('fix', join(repos.dir, 'scripts')));
  try {
    const start = (o: Record<string, unknown>) => core.coding.start({ repo: repos.person, goal: 'x', test_command: 'node --test', ...o });
    await assert.rejects(start({ repo: join(repos.dir, 'nowhere') }), /isn’t there/);
    await assert.rejects(start({ repo: repos.dir }), /isn’t a git repository/);
    await assert.rejects(start({ repo: home }), /Nova’s own home/);
    await assert.rejects(start({ branch: 'no-such' }), /has no branch called no-such/);
    await assert.rejects(start({ branch: '--upload-pack=x' }), /isn’t a branch name/);
    await assert.rejects(start({ test_command: '' }), /never asks you to merge a change it hasn’t tested/);
    await assert.rejects(start({ agent: 'codex' }), /turned off/);
    await assert.rejects(start({ privacy_mode: 'local-only' }), /sends data off your devices, and this task is local-only/);
    assert.equal(core.coding.list().length, 0, 'nothing refused was recorded');
    // Nobody but the coding module makes a coding task.
    assert.throws(() => core.ledger.create({ title: 'Merge', owner: 'coding', goal: 'x', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation' }], inputs: { step: 'merge', run_id: 'r0' } }), /Only Nova’s coding runs make their own tasks/);
  } finally {
    await core.close();
  }
});

test('M10c: two runs on one repository at once each get their own worktree and branch', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, agentScript('fix', join(repos.dir, 'scripts')));
  try {
    const [a, b] = await Promise.all([1, 2].map((n) => core.coding.start({ repo: repos.person, goal: `Fix greet(), take ${n}.`, test_command: 'node --test' })));
    const [ta, tb] = await Promise.all([settle(core, a!.task.id), settle(core, b!.task.id)]);
    assert.equal(ta.state, 'done', String(ta.reason));
    assert.equal(tb.state, 'done', String(tb.reason));
    const [va, vb] = [core.coding.view(a!.run.id), core.coding.view(b!.run.id)];
    assert.notEqual(va.nova_branch, vb.nova_branch);
    assert.equal(va.base, vb.base);
    assert.deepEqual([va.changes.length, vb.changes.length], [1, 1]);
  } finally {
    await core.close();
  }
});

test('M10c: after a restart the merge ask stands, says its preview stopped, and still merges only the reviewed commit', { timeout: 120_000 }, async () => {
  const { core, home } = boot();
  const repos = makeRepos();
  claude(core, agentScript('fix', join(repos.dir, 'scripts')));
  const { run, check } = await toReview(core, repos);
  core.ledger.approve(check.id);
  await settle(core, check.id);
  const merge = await settle(core, taskOf(core, run, 'merge')!.id);
  const url = core.coding.view(run).preview!.url;
  await core.close();
  const again = createCore({ home, version: '0.1.0', trustedOrigin: () => true, coding: { testTimeoutS: 60, previewTimeoutS: 20 } });
  try {
    again.start();
    const v = again.coding.view(run);
    assert.equal(v.state, 'review');
    assert.equal(v.preview!.running, false);
    assert.ok(v.preview!.why_stopped);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(3000) }), 'no preview outlives Nova');
    assert.equal(again.ledger.get(merge.id).state, 'waiting');
    again.ledger.approve(merge.id, { confirm: true });
    assert.equal((await settle(again, merge.id)).state, 'done');
    assert.equal(git(repos.person, 'rev-parse', 'main'), v.head);
  } finally {
    await again.close();
  }
});
