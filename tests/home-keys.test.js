// The hub's keys (home/mesh/identity.json) and a standby's role file never reach the home's git
// history, which is readable by anyone who can read the folder; a home whose history already has
// them says so, plainly, at every start until the keys are replaced. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as home$ from '../src/home.js';

const { commitHome, ensureGit } = home$;
const keysInHistory = (h) => home$.keysInHistory(h);
import { loadIdentity } from '../src/core/index.ts';

const git = (h, ...args) => execFileSync('git', ['-C', h, ...args], { encoding: 'utf8' });

function home() {
  const h = mkdtempSync(join(tmpdir(), 'nova-home-keys-'));
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
