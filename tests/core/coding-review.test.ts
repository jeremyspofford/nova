// The independent review of PR #239 (M10c), one test per item, each written against the merged code
// first and seen failing there (docs/evidence/m10c-gate.md, "The review of PR #239"). Throwaway
// repositories under mkdtemp only, a bare clone as the "remote"; nothing pushes; the agent is Claude
// Code's stand-in; previews bind 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { Git } from '../../src/core/coding/git.ts';
import { changes, refusals, walk } from '../../src/core/coding/tree.ts';
import { procStart } from '../../src/core/coding/preview.ts';
import { FAKE_CLAUDE, git, makeRepos, treeHash, type Repos } from '../support/coding.ts';

const LINUX = process.platform === 'linux';
const FIX = { edit: { path: 'app.mjs', old: '`Hi ${name}`', new: '`Hello, ${name}!`' } };

function boot(home = mkdtempSync(join(tmpdir(), 'nova-coding-review-home-'))) {
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, coding: { testTimeoutS: 60, previewTimeoutS: 20 } });
  core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
  return { core, home };
}
const script = (repos: Repos, steps: unknown[]) => {
  mkdirSync(join(repos.dir, 'scripts'), { recursive: true });
  const f = join(repos.dir, 'scripts', `s-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ steps, result: 'Done.' }));
  return f;
};
const claude = (core: Core, file: string) => {
  core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE} --script ${file}` }, { confirm: true });
  core.providers.enable('claude-code', { approved: true });
};
async function settle(core: Core, id: string) {
  for (let i = 0; i < 1200; i++) {
    await core.ledger.idle();
    const t = core.ledger.get(id);
    if (['done', 'failed', 'cancelled', 'waiting'].includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  return core.ledger.get(id);
}
const taskOf = (core: Core, run: string, step: string, round?: number) => {
  const ref = core.coding.view(run).tasks.filter((x) => x.step === step && (round === undefined || x.round === round)).at(-1);
  return ref ? core.ledger.get(ref.id) : null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gone = async (url: string) => { try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return false; } catch { return true; } };

async function toMergeAsk(core: Core, repos: Repos, more: Record<string, unknown> = {}) {
  const { run: { id: run }, task } = await core.coding.start({ repo: repos.person, goal: 'Fix greet().', test_command: 'node --test', ...more });
  const w = await settle(core, task.id);
  assert.equal(w.state, 'done', `write: ${w.reason}`);
  const check = await settle(core, taskOf(core, run, 'check')!.id);
  core.ledger.approve(check.id);
  const c = await settle(core, check.id);
  assert.equal(c.state, 'done', `check: ${c.reason}`);
  return { run, merge: await settle(core, taskOf(core, run, 'merge')!.id) };
}

test('review 1: once a confirmed merge passed its commit point, decline, cancel and discard are refused, and the record says what git did', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, script(repos, [FIX]));
  try {
    const { run, merge } = await toMergeAsk(core, repos);
    const tried: string[] = [];
    const orig = core.ledger.committing.bind(core.ledger);
    core.ledger.committing = (id: string, what: string) => {
      orig(id, what);
      for (const [name, act] of [['decline', () => core.coding.decline(run)], ['cancel', () => core.ledger.cancel(merge.id, 'Cancelled by you.')]] as const) {
        try { act(); tried.push(`${name}: accepted`); } catch (e) { tried.push(`${name}: refused: ${(e as Error).message}`); }
      }
      core.coding.discard(run).then(() => tried.push('discard: accepted'), (e) => tried.push(`discard: refused: ${(e as Error).message}`));
    };
    core.ledger.approve(merge.id, { confirm: true });
    const m = await settle(core, merge.id);
    await sleep(200);
    assert.ok(tried.every((x) => /refused/.test(x)), tried.join('\n'));
    assert.match(tried.join('\n'), /already moving main/);
    assert.equal(m.state, 'done', String(m.reason));
    const v = core.coding.view(run);
    assert.equal(v.state, 'merged');
    assert.equal(git(repos.person, 'rev-parse', 'main'), v.head, 'what the record says is what git did');
  } finally {
    await core.close();
  }
});

test('review 2: a preview whose shell exits takes its process group with it; decline and close leave nothing listening', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, script(repos, [FIX]));
  let url = '';
  try {
    const { run } = await toMergeAsk(core, repos, { preview_command: 'node server.mjs & sleep 1' });
    url = core.coding.view(run).preview!.url;
    await sleep(2500);
    assert.equal(core.coding.view(run).preview!.running, false, 'its leader exited');
    assert.ok(await gone(url), 'and nothing of it still answers');
  } finally {
    await core.close();
  }
  assert.ok(await gone(url));
});

test('review 2: after a restart Nova stops a preview group it recorded, and only one that is still the process it started', { timeout: 120_000, skip: LINUX ? false : 'reads /proc' }, async () => {
  const { core, home } = boot();
  const repos = makeRepos();
  claude(core, script(repos, [FIX]));
  const { run } = await toMergeAsk(core, repos);
  await core.close();
  // A preview left by a Nova that stopped without its close (as a crash would): a group of its own.
  const server = "require('node:http').createServer((q,s)=>s.end('left')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})";
  const left = spawn('/bin/sh', ['-c', `node -e "${server}"`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise<number>((r) => left.stdout!.once('data', (d) => r(Number(String(d).trim()))));
  const other = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
  const again = boot(home).core;
  try {
    const rec = (pid: number, start: string | null) => JSON.stringify({ run_id: run, round: 1, task_id: 'x', command: 'x', commit: 'x', url: `http://127.0.0.1:${port}/`, port, pid, start, status: 200, loopback: 'yes', started_at: new Date().toISOString(), stopped_at: null, why_stopped: null });
    again.db.run('UPDATE coding_run SET preview = ? WHERE id = ?', rec(left.pid!, procStart(left.pid!)), run);
    again.start();
    await sleep(500);
    assert.ok(await gone(`http://127.0.0.1:${port}/`), 'the recorded preview group was stopped');
    // A record whose process isn't the one Nova started (another start time) is left alone.
    again.db.run('UPDATE coding_run SET preview = ? WHERE id = ?', rec(other.pid!, '1'), run);
    again.coding.recover();
    await sleep(300);
    assert.doesNotThrow(() => process.kill(other.pid!, 0), 'a process Nova didn’t start isn’t touched');
  } finally {
    try { process.kill(-other.pid!, 'SIGKILL'); } catch { /* gone */ }
    try { process.kill(-left.pid!, 'SIGKILL'); } catch { /* gone */ }
    await again.close();
  }
});

test('review 3: the agent can’t make failing tests pass through the test runner’s configuration', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  writeFileSync(join(repos.person, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2));
  git(repos.person, 'add', '--all');
  git(repos.person, 'commit', '--quiet', '-m', 'npm test');
  const WRONG = { edit: { path: 'app.mjs', old: '`Hi ${name}`', new: '`Hey ${name}`' } };
  try {
    for (const [what, step] of [
      ['.npmrc', { write: { path: '.npmrc', content: 'script-shell=/bin/true\n' } }],
      ['package.json', { edit: { path: 'package.json', old: '"node --test"', new: '"true"' } }],
      ['vitest.config.mjs', { write: { path: 'vitest.config.mjs', content: 'export default {};\n' } }],
      ['tsconfig.json', { write: { path: 'tsconfig.json', content: '{}\n' } }],
      ['.yarnrc.yml', { write: { path: '.yarnrc.yml', content: 'x: 1\n' } }],
      ['test-helper.mjs', { write: { path: 'test-helper.mjs', content: '\n' } }],
    ] as const) {
      claude(core, script(repos, [WRONG, step]));
      const { run: { id: run }, task } = await core.coding.start({ repo: repos.person, goal: 'Fix greet().', test_command: 'npm test' });
      const t = await settle(core, task.id);
      assert.equal(t.state, 'failed', `${what}: ${t.reason}`);
      assert.match(String(t.reason), new RegExp(`${what.replace(/\./g, '\\.')}.*not allowed to change`), what);
      assert.equal(taskOf(core, run, 'check'), null, `${what}: nothing ran`);
    }
  } finally {
    await core.close();
  }
});

test('review 3: chat can’t widen what the agent may change; the scope in force is in the run for both sheets', { timeout: 60_000 }, async () => {
  const { TOOLS } = await import('../../src/tools.js');
  const { core } = boot();
  const repos = makeRepos();
  claude(core, script(repos, [FIX]));
  try {
    await assert.rejects(TOOLS.code_change.run({ repo: repos.person, goal: 'x', test_command: 'node --test', editable: ['**'] }, { coding: core.coding, sessionId: 's' }), /Only you can widen what the agent may change/);
    assert.equal(core.coding.list().length, 0);
    const { run } = await core.coding.start({ repo: repos.person, goal: 'x', test_command: 'node --test' });
    assert.match(String(core.coding.view(run.id).scope), /not the tests, the test runner’s settings/);
    const wide = await core.coding.start({ repo: repos.person, goal: 'x', test_command: 'node --test', editable: ['**'] });
    assert.match(String(core.coding.view(wide.run.id).scope), /You let it change: \*\*/);
    await core.ledger.idle();
  } finally {
    await core.close();
  }
});

test('review 4: a link that escapes through another link in the tree is refused', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  writeFileSync(join(repos.dir, 'OUTSIDE'), 'beside the repository\n');
  claude(core, script(repos, [FIX, { run: 'mkdir -p sub && ln -s . sub/q && ln -s q/../../OUTSIDE sub/p' }]));
  try {
    const { task } = await core.coding.start({ repo: repos.person, goal: 'Fix greet().', test_command: 'node --test' });
    const t = await settle(core, task.id);
    assert.equal(t.state, 'failed', t.reason ?? '');
    assert.match(String(t.reason), /sub\/p \(a link to "q\/\.\.\/\.\.\/OUTSIDE", outside the repository\)/);
  } finally {
    await core.close();
  }
  // And the pure check: inside stays allowed, chains that leave are not.
  const dir = mkdtempSync(join(tmpdir(), 'nova-coding-links-'));
  mkdirSync(join(dir, 'docs', 'v2'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'v2', 'a.md'), 'a\n');
  const { symlinkSync } = await import('node:fs');
  symlinkSync('v2', join(dir, 'docs', 'latest'));
  symlinkSync('../docs/v2/a.md', join(dir, 'docs', 'up'));
  symlinkSync('.', join(dir, 'docs', 'here'));
  symlinkSync('here/../../x', join(dir, 'docs', 'sneaky'));
  const w = walk(dir);
  const said = refusals(changes(new Map(), w.entries), w) ?? '';
  assert.match(said, /docs\/sneaky/);
  assert.doesNotMatch(said, /docs\/(latest|up|here) /);
});

test('review 5: the merge is a compare-and-swap of the branch even when it is checked out; a switch in the window moves only that branch', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, script(repos, [FIX]));
  const base = git(repos.person, 'rev-parse', 'main');
  try {
    const { run, merge } = await toMergeAsk(core, repos);
    const orig = core.ledger.committing.bind(core.ledger);
    core.ledger.committing = (id: string, what: string) => { orig(id, what); git(repos.person, 'checkout', '--quiet', '-b', 'other'); };
    core.ledger.approve(merge.id, { confirm: true });
    const m = await settle(core, merge.id);
    assert.equal(m.state, 'done', String(m.reason));
    assert.equal(git(repos.person, 'rev-parse', 'main'), core.coding.view(run).head, 'main moved to the reviewed commit');
    assert.equal(git(repos.person, 'rev-parse', 'other'), base, 'the branch checked out instead is untouched');
  } finally {
    await core.close();
  }
});

test('review 5: a branch that moves in the merge’s window starts a new round, not a failure', { timeout: 150_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, script(repos, [FIX]));
  try {
    const { run, merge } = await toMergeAsk(core, repos);
    const orig = core.ledger.committing.bind(core.ledger);
    core.ledger.committing = (id: string, what: string) => {
      orig(id, what);
      writeFileSync(join(repos.person, 'NOTES.md'), 'A note.\n');
      git(repos.person, 'add', 'NOTES.md');
      git(repos.person, 'commit', '--quiet', '-m', 'A note');
    };
    core.ledger.approve(merge.id, { confirm: true });
    await settle(core, merge.id);
    const moved = git(repos.person, 'rev-parse', 'main');
    assert.equal(git(repos.person, 'log', '-1', '--format=%s', 'main'), 'A note', 'main is the person’s, not Nova’s');
    const update = await settle(core, taskOf(core, run, 'update', 2)!.id);
    assert.equal(update.state, 'done', String(update.reason));
    assert.equal(core.coding.view(run).base, moved);
  } finally {
    await core.close();
  }
});

test('review 6: a repository’s own protocol and insteadOf settings can’t send Nova’s git to the network', { timeout: 120_000 }, async () => {
  let hits = 0;
  const srv = createServer((_q, s) => { hits++; s.writeHead(404); s.end(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const { core, home } = boot();
  const repos = makeRepos();
  claude(core, script(repos, [FIX]));
  try {
    for (const p of ['http', 'https', 'ssh', 'git', 'ext']) git(repos.person, 'config', `protocol.${p}.allow`, 'always');
    git(repos.person, 'config', `url.http://127.0.0.1:${port}/.insteadOf`, home);
    git(repos.person, 'config', `url.http://127.0.0.1:${port}/x/.insteadOf`, '/nowhere/');
    const g = new Git({ home: join(repos.dir, 'git-home') });
    await g.run(['-C', repos.person, 'fetch', '--quiet', '/nowhere/mirror.git', 'main'], { allow: [1, 128] });
    assert.equal(hits, 0, 'Nova’s git didn’t reach the http listener');
    const { run, merge } = await toMergeAsk(core, repos);
    core.ledger.approve(merge.id, { confirm: true });
    const m = await settle(core, merge.id);
    assert.equal(m.state, 'done', String(m.reason));
    assert.equal(git(repos.person, 'rev-parse', 'main'), core.coding.view(run).head);
    assert.equal(hits, 0, 'the merge reached nothing either');
  } finally {
    srv.close();
    await core.close();
  }
});

test('review 7: a huge file the agent leaves is refused by its size, never read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-coding-big-'));
  const fd = openSync(join(dir, 'big.bin'), 'w');
  ftruncateSync(fd, 1.5 * 1024 ** 3);
  closeSync(fd);
  writeFileSync(join(dir, 'small.txt'), 'small\n');
  const w = walk(dir);
  assert.ok(w.bytes < 1024 * 1024, `read ${w.bytes} bytes`);
  assert.match(refusals(changes(new Map(), w.entries), w) ?? '', /big\.bin.*over 50 MB/);
});

test('review 8: a change too big to show in full is never offered as reviewed', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  const big = `node -e "require('fs').writeFileSync('data.txt', Array.from({ length: 20000 }, (_, i) => 'line ' + i + ' of a long generated file').join('\\n'))"`;
  claude(core, script(repos, [FIX, { run: big }]));
  try {
    const { run: { id: run }, task } = await core.coding.start({ repo: repos.person, goal: 'Fix greet().', test_command: 'node --test', editable: ['**'] });
    const t = await settle(core, task.id);
    assert.equal(t.state, 'failed', t.reason ?? '');
    assert.match(String(t.reason), /too long to review here/);
    assert.equal(taskOf(core, run, 'check'), null);
  } finally {
    await core.close();
  }
});

test('review 9: a merge that already moved the branch before Nova stopped is merged, not failed', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, script(repos, [FIX]));
  try {
    const { run, merge } = await toMergeAsk(core, repos);
    const head = core.coding.view(run).head!;
    // As if an earlier attempt moved the branch and Nova stopped before it read it back.
    const mirror = readdirSync(join(core.coding.dir, 'repos'))[0]!;
    git(repos.person, 'fetch', '--quiet', join(core.coding.dir, 'repos', mirror), `refs/heads/nova/${run}`);
    git(repos.person, 'merge', '--quiet', '--ff-only', head);
    core.ledger.approve(merge.id, { confirm: true });
    const m = await settle(core, merge.id);
    assert.equal(m.state, 'done', String(m.reason));
    assert.equal(core.coding.view(run).state, 'merged');
    assert.equal(taskOf(core, run, 'update', 2), null, 'no new round');
  } finally {
    await core.close();
  }
});

test('review 10: a write cancelled while Nova commits leaves no worktree, no branch and no head', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, script(repos, [FIX]));
  try {
    const orig = core.providers.workIn.bind(core.providers);
    core.providers.workIn = (async (id: string, o: Parameters<typeof orig>[1]) => {
      const out = await orig(id, o);
      core.ledger.cancel(o.brief.task_id, 'Cancelled by you.');
      return out;
    }) as typeof core.providers.workIn;
    const { run: { id: run }, task } = await core.coding.start({ repo: repos.person, goal: 'Fix greet().', test_command: 'node --test' });
    await settle(core, task.id);
    for (let i = 0; i < 100; i++) { await sleep(30); }
    const v = core.coding.view(run);
    assert.equal(v.state, 'cancelled');
    assert.equal(v.head, null, 'no head written into a cancelled run');
    assert.equal(existsSync(join(core.coding.dir, 'runs', run)), false, 'no worktree left');
    const mirror = join(core.coding.dir, 'repos', readdirSync(join(core.coding.dir, 'repos'))[0] ?? 'none');
    if (existsSync(mirror)) assert.throws(() => git(mirror, 'rev-parse', '--verify', '--quiet', `refs/heads/nova/${run}`), 'no branch left');
  } finally {
    await core.close();
  }
});

test('review 11: any listener of the preview’s process group off loopback stops the check', { timeout: 120_000, skip: LINUX ? false : 'reads /proc' }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, script(repos, [FIX]));
  try {
    const side = "require('node:http').createServer(()=>{}).listen(0,'0.0.0.0')";
    const { run: { id: run }, task } = await core.coding.start({ repo: repos.person, goal: 'Fix greet().', test_command: 'node --test', preview_command: `node -e "${side}" & node server.mjs` });
    await settle(core, task.id);
    const check = await settle(core, taskOf(core, run, 'check')!.id);
    core.ledger.approve(check.id);
    const c = await settle(core, check.id);
    assert.equal(c.state, 'failed', c.reason ?? '');
    assert.match(String(c.reason), /listened on every address \(0\.0\.0\.0\)/);
  } finally {
    await core.close();
  }
});

test('review 12: a run’s records and Nova’s copy of the repository go when nothing uses them', { timeout: 120_000 }, async () => {
  const { core } = boot();
  const repos = makeRepos();
  claude(core, script(repos, [FIX]));
  try {
    const { run } = await toMergeAsk(core, repos, { preview_command: 'node server.mjs' });
    const recs = () => ['tests', 'previews'].flatMap((k) => { try { return readdirSync(join(core.coding.dir, 'records', k)); } catch { return []; } }).filter((f) => f.startsWith(run));
    assert.ok(recs().length >= 2, 'records while under review');
    core.coding.decline(run);
    await core.ledger.idle();
    for (let i = 0; i < 100 && (recs().length || readdirSync(join(core.coding.dir, 'repos')).length); i++) await sleep(30);
    assert.deepEqual(recs(), [], 'its records went with the run');
    assert.deepEqual(readdirSync(join(core.coding.dir, 'repos')), [], 'and Nova’s copy of the repository, used by no other run');
    assert.equal(treeHash(repos.person).length, 64);
  } finally {
    await core.close();
  }
});
