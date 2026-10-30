// The hub's keys (home/mesh/identity.json) and a standby's role file never reach the home's git
// history, which is readable by anyone who can read the folder; a home whose history already has
// them says so, plainly, at every start until the keys are replaced. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as home$ from '../src/home.js';

const { commitHome, ensureGit } = home$;
const keysInHistory = (h) => home$.keysInHistory(h);
import { loadIdentity, ensureMark } from '../src/core/index.ts';

const git = (h, ...args) => execFileSync('git', ['-C', h, ...args], { encoding: 'utf8' });

function home() {
  const h = mkdtempSync(join(tmpdir(), 'nova-home-keys-'));
  ensureMark(h);
  writeFileSync(join(h, 'USER.md'), '# USER.md\n');
  loadIdentity(h);
  writeFileSync(join(h, 'mesh', 'role.json'), '{"version":1,"role":"standby"}\n', { mode: 0o600 });
  return h;
}

test('a fresh home never tracks mesh/, at the first commit or after any turn', async () => {
  const h = home();
  const problems = [];
  assert.equal(await ensureGit(h, { problem: (m) => problems.push(m) }), true);
  assert.doesNotMatch(git(h, 'ls-files'), /^mesh\//m);
  writeFileSync(join(h, 'workspace.md'), 'a change\n');
  writeFileSync(join(h, 'mesh', 'role.json'), '{"version":1,"role":"hub"}\n');
  await commitHome(h, 'Nova: turn');
  assert.match(git(h, 'ls-files'), /workspace\.md/);
  assert.doesNotMatch(git(h, 'ls-files'), /^mesh\//m);
  const priv = JSON.parse(readFileSync(join(h, 'mesh', 'identity.json'), 'utf8')).ed25519.private;
  assert.doesNotMatch(git(h, 'log', '--all', '-p'), new RegExp(priv.replace(/[-]/g, '\\-')));
  assert.equal(await keysInHistory(h), false);
  assert.deepEqual(problems, []);
});

test('a home whose history already has the keys stops tracking them and says they must be replaced, at every start', async () => {
  const h = home();
  // As an M4 home before this fix: the keys went in with everything else.
  git(h, 'init', '-q');
  writeFileSync(join(h, '.gitignore'), '# Nova: kept out of history, so forgetting and removing are final.\nMEMORY.md\n');
  git(h, 'add', '-A');
  git(h, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old');
  assert.match(git(h, 'ls-files'), /^mesh\/identity\.json$/m);

  const problems = [];
  await ensureGit(h, { problem: (m) => problems.push(m) });
  assert.doesNotMatch(git(h, 'ls-files'), /^mesh\//m, 'no longer tracked');
  assert.match(readFileSync(join(h, '.gitignore'), 'utf8'), /^mesh\/$/m);
  assert.ok(readFileSync(join(h, 'mesh', 'identity.json'), 'utf8').includes('"private"'), 'the file itself stays');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /keys/);
  assert.match(problems[0], /history/);
  assert.match(problems[0], /replace|rotate/i);
  assert.equal(await keysInHistory(h), true);

  // The next start says it again: the old commits still hold the keys.
  await ensureGit(h, { problem: (m) => problems.push(m) });
  assert.equal(problems.length, 2);
});

// Re-check findings: replacing the keys while Nova runs leaves the running hub serving the old key
// against a roster naming the new one; and the warning stayed open after the keys were replaced.
test('replacing the keys refuses while Nova runs this home, and the warning closes once they are new', async () => {
  const h = home();
  rmSync(join(h, 'mesh', 'role.json')); // a hub, not a standby
  git(h, 'init', '-q');
  git(h, 'add', '-A');
  git(h, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old');
  const before = readFileSync(join(h, 'mesh', 'identity.json'), 'utf8');

  // A live process names this home as its own (here, the test itself).
  writeFileSync(join(h, 'nova.pid'), String(process.pid));
  assert.equal(home$.runningPid(h), process.pid);
  const script = join(import.meta.dirname, '..', 'scripts', 'rotate-hub-keys.js');
  let refused = null;
  try { execFileSync(process.execPath, [script, h], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { refused = e; }
  assert.ok(refused, 'refused while running');
  assert.match(refused.stderr, /Stop it first/);
  assert.equal(readFileSync(join(h, 'mesh', 'identity.json'), 'utf8'), before, 'nothing changed');

  // A stale pid file (that process is gone) doesn't block it.
  writeFileSync(join(h, 'nova.pid'), '999999999');
  assert.equal(home$.runningPid(h), null);
  execFileSync(process.execPath, [script, h], { encoding: 'utf8', stdio: 'pipe' });
  assert.notEqual(readFileSync(join(h, 'mesh', 'identity.json'), 'utf8'), before, 'new keys');

  const resolved = [];
  const problems = [];
  await ensureGit(h, { problem: (m) => problems.push(m), resolved: (m) => resolved.push(m) });
  assert.deepEqual(problems, [], 'the history holds only keys that no longer open anything');
  assert.equal(resolved.length, 1, 'so the open warning is closed');
  assert.match(resolved[0], /keys/);
});

// Nova's mark on its home holds the key that seals a factory reset; checkpoints hold the identity and
// the vault key. None of them, nor a reset's marker or report, ever reaches the home's history.
test('the home’s mark, a reset’s marker and report, and checkpoints never reach the home’s history', async () => {
  const h = home();
  mkdirSync(join(h, 'checkpoints', '000001-here', 'files', 'mesh'), { recursive: true });
  writeFileSync(join(h, 'checkpoints', '000001-here', 'files', 'mesh', 'identity.json'), '{}');
  writeFileSync(join(h, 'checkpoints', '.seal'), 'seal');
  writeFileSync(join(h, 'factory-reset.json'), '{}');
  writeFileSync(join(h, 'factory-reset.json.set-aside-2026-10-30T00-00-00-000Z'), '{}');
  writeFileSync(join(h, 'reset-report.json'), '{}');
  assert.equal(await ensureGit(h, { problem: () => {} }), true);
  await commitHome(h, 'Nova: turn');
  const tracked = git(h, 'ls-files').split('\n');
  for (const name of ['.nova-home', 'checkpoints/', 'factory-reset.json', 'reset-report.json']) {
    assert.ok(!tracked.some((f) => f.startsWith(name)), `${name} isn’t tracked: ${tracked.join(' ')}`);
  }
});
