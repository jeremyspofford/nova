// Nova's own git for coding runs (M10c, docs/plans/M10c.md "Nova's git"): no hook runs, from the
// person's repository or Nova's, no fsmonitor, no personal config, nothing but local paths, and none
// of Nova's own GIT_* variables. On throwaway repositories in a temp folder; the canaries are files a
// hook or helper would have written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git, checkBranch } from '../../src/core/coding/git.ts';
import { listeners, loopbackAddress } from '../../src/core/coding/preview.ts';
import { createCore, type Core } from '../../src/core/index.ts';
import { FAKE_CLAUDE, agentScript, git, makeRepos } from '../support/coding.ts';

async function settle(core: Core, id: string) {
  for (let i = 0; i < 800; i++) {
    await core.ledger.idle();
    const t = core.ledger.get(id);
    if (['done', 'failed', 'cancelled', 'waiting'].includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  return core.ledger.get(id);
}

test('Nova’s git reaches only local paths: no network transport, no ext:: helper', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-coding-git-'));
  const g = new Git({ home: join(dir, 'home') });
  await g.run(['init', '--bare', '--quiet', join(dir, 'm.git')]);
  const canary = join(dir, 'ext-ran');
  for (const url of ['https://example.invalid/repo.git', 'http://example.invalid/repo.git', 'ssh://example.invalid/repo.git', 'git://example.invalid/repo.git', `ext::sh -c touch% ${canary}`]) {
    await assert.rejects(g.run(['--git-dir', join(dir, 'm.git'), 'fetch', url, 'main']), /not allowed|transport/, url);
  }
  assert.equal(existsSync(canary), false, 'the ext:: command never ran');
});

test('Nova’s git takes no GIT_* variable of its own process, and no personal config', async () => {
  const repos = makeRepos('nova-coding-env-');
  const g = new Git({ home: join(repos.dir, 'home') });
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(repos.dir, 'nowhere');
  process.env.GIT_WORK_TREE = join(repos.dir, 'nowhere');
  try {
    assert.equal((await g.run(['-C', repos.person, 'rev-parse', '--show-toplevel'])).out.trim(), repos.person);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.equal((await g.run(['config', '--global', '--list'], { allow: [128, 1] })).out.trim(), '', 'nothing personal is read');
});

test('a branch name is never read as an option or a range', () => {
  for (const bad of ['--upload-pack=x', '-b', 'a..b', 'a b', 'x@{1}', '.hidden', 'a/.b', 'x.lock', '/abs', '', 'a;b', 'a\nb']) assert.throws(() => checkBranch(bad), bad);
  for (const ok of ['main', 'feature/one', 'release-1.2', 'a_b']) assert.equal(checkBranch(ok), ok);
});

test('the preview’s loopback check reads the kernel’s listening sockets', () => {
  const tcp = '  sl  local_address rem_address   st\n   0: 0100007F:1F90 00000000:0000 0A\n   1: 00000000:1F91 00000000:0000 0A\n   2: 0100007F:1F92 0100007F:9999 01\n';
  const tcp6 = '  sl  local_address rem_address   st\n   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A\n   1: 00000000000000000000000000000000:1F91 00000000000000000000000000000000:0000 0A\n';
  const read = (f: string) => (f.endsWith('6') ? tcp6 : tcp);
  if (process.platform !== 'linux') { assert.equal(listeners(8080, read), null); return; }
  assert.deepEqual(listeners(0x1f90, read), ['127.0.0.1', '::1']);
  assert.deepEqual(listeners(0x1f91, read), ['0.0.0.0', '::']);
  assert.deepEqual(listeners(0x1f92, read), [], 'a connection, not a listener');
  assert.ok(loopbackAddress('127.0.0.1') && loopbackAddress('::1') && loopbackAddress('::ffff:127.0.0.1'));
  assert.ok(!loopbackAddress('0.0.0.0') && !loopbackAddress('::') && !loopbackAddress('192.168.1.10'));
});

test('a whole coding run, merge included, runs none of the person’s hooks and no fsmonitor', { timeout: 120_000 }, async () => {
  const repos = makeRepos('nova-coding-hooks-');
  const canaries = join(repos.dir, 'canaries');
  mkdirSync(canaries);
  const hooks = join(repos.person, '.git', 'hooks');
  for (const h of ['pre-commit', 'post-commit', 'post-checkout', 'post-merge', 'reference-transaction', 'pre-push', 'post-rewrite']) {
    writeFileSync(join(hooks, h), `#!/bin/sh\ntouch '${join(canaries, h)}'\n`);
    chmodSync(join(hooks, h), 0o755);
  }
  const monitor = join(repos.dir, 'fsmonitor.sh');
  writeFileSync(monitor, `#!/bin/sh\ntouch '${join(canaries, 'fsmonitor')}'\n`);
  chmodSync(monitor, 0o755);
  git(repos.person, 'config', 'core.fsmonitor', monitor);
  const home = mkdtempSync(join(tmpdir(), 'nova-coding-hooks-home-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, coding: { testTimeoutS: 60, previewTimeoutS: 20 } });
  core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
  core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE} --script ${agentScript('fix', join(repos.dir, 'scripts'))}` }, { confirm: true });
  core.providers.enable('claude-code', { approved: true });
  try {
    const { run, task } = await core.coding.start({ repo: repos.person, goal: 'Fix greet().', test_command: 'node --test' });
    assert.equal((await settle(core, task.id)).state, 'done');
    const step = (s: string) => core.ledger.get(core.coding.view(run.id).tasks.filter((x) => x.step === s).at(-1)!.id);
    const check = await settle(core, step('check').id);
    core.ledger.approve(check.id);
    assert.equal((await settle(core, check.id)).state, 'done');
    const merge = await settle(core, step('merge').id);
    core.ledger.approve(merge.id, { confirm: true });
    assert.equal((await settle(core, merge.id)).state, 'done');
    assert.equal(git(repos.person, '-c', 'core.fsmonitor=false', 'rev-parse', 'main'), core.coding.view(run.id).head);
    const ran = ['pre-commit', 'post-commit', 'post-checkout', 'post-merge', 'reference-transaction', 'pre-push', 'post-rewrite', 'fsmonitor'].filter((c) => existsSync(join(canaries, c)));
    assert.deepEqual(ran, [], 'no hook and no fsmonitor ran');
  } finally {
    await core.close();
  }
});
