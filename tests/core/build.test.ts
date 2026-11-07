// The running build (src/core/build.ts): which version and commit this is, built when or started
// when (never one said as the other), and whether it is the latest merged build, from the deploy
// step's file only (scripts/deploy-record.sh), checked at the boundary. GET /api/v1/version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Build, LATEST_MAX_BYTES, readLatest } from '../../src/core/build.ts';
import { call, hub } from './mesh-support.ts';

const A = 'a'.repeat(40);
const B = '0123456789abcdef0123456789abcdef01234567';
const STARTED = new Date('2026-11-06T12:00:00.000Z');
const RECORD = join(import.meta.dirname, '..', '..', 'scripts', 'deploy-record.sh');
const scratch = () => mkdtempSync(join(tmpdir(), 'nova-build-'));
const latest = (home: string, body: string) => { mkdirSync(join(home, 'deploy'), { recursive: true }); writeFileSync(join(home, 'deploy', 'latest.json'), body); };
// A code root that isn't a git checkout, so only the environment can name the commit.
const notGit = () => scratch();

test('the commit comes from NOVA_BUILD_COMMIT, else the checkout, else it is unknown; it never throws', () => {
  const home = scratch();
  const fromEnv = new Build({ version: '0.1.0-alpha.1', codeRoot: notGit(), home, env: { NOVA_BUILD_COMMIT: A.toUpperCase() }, startedAt: STARTED });
  assert.equal(fromEnv.identity.commit, A);
  assert.equal(fromEnv.identity.commit_short, 'aaaaaaaa');
  const unknown = new Build({ version: '0.1.0-alpha.1', codeRoot: notGit(), home, env: {}, startedAt: STARTED });
  assert.equal(unknown.identity.commit, null);
  assert.equal(unknown.identity.commit_short, null);
  const notACommit = new Build({ version: '0.1.0-alpha.1', codeRoot: notGit(), home, env: { NOVA_BUILD_COMMIT: 'main; rm -rf /' }, startedAt: STARTED });
  assert.equal(notACommit.identity.commit, null, 'a NOVA_BUILD_COMMIT that is not a commit is ignored');
  // This repository's own checkout, when git can read it here (CI and the iso sandbox can).
  const head = spawnSync('git', ['-C', join(import.meta.dirname, '..', '..'), 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status === 0) {
    const fromGit = new Build({ version: '0.1.0-alpha.1', codeRoot: join(import.meta.dirname, '..', '..'), home, env: {}, startedAt: STARTED });
    assert.equal(fromGit.identity.commit, head.stdout.trim());
  }
});

test('built_at only when the launcher said; otherwise started_at, labelled as such', () => {
  const home = scratch();
  const built = new Build({ version: 'v', codeRoot: notGit(), home, env: { NOVA_BUILD_COMMIT: A, NOVA_BUILD_DATE: '2026-11-06T09:30:00-05:00' }, startedAt: STARTED }).identity;
  assert.equal(built.built_at, '2026-11-06T14:30:00.000Z');
  assert.equal('started_at' in built, false);
  for (const bad of [undefined, '', 'yesterday', '2026-11-06', '2026-13-45T99:99:00Z']) {
    const started = new Build({ version: 'v', codeRoot: notGit(), home, env: { NOVA_BUILD_COMMIT: A, ...(bad === undefined ? {} : { NOVA_BUILD_DATE: bad }) }, startedAt: STARTED }).identity;
    assert.equal(started.started_at, STARTED.toISOString(), String(bad));
    assert.equal('built_at' in started, false, String(bad));
  }
});

test('running vs latest: behind, the same, or not known, with the words for each', () => {
  const home = scratch();
  const b = new Build({ version: '0.1.0-alpha.1', codeRoot: notGit(), home, env: { NOVA_BUILD_COMMIT: A }, startedAt: STARTED });
  let v = b.view();
  assert.equal(v.latest, null);
  assert.equal(v.behind, null);
  assert.equal(v.words, 'Running aaaaaaaa; Nova doesn\'t know the latest merged build.');
  latest(home, JSON.stringify({ commit: B, merged_at: '2026-11-06T18:22:01Z' }));
  v = b.view();
  assert.deepEqual(v.latest, { commit: B, merged_at: '2026-11-06T18:22:01.000Z', source: join(home, 'deploy', 'latest.json') });
  assert.equal(v.behind, true);
  assert.equal(v.words, 'Running aaaaaaaa, latest merged 01234567 — redeploy pending.');
  latest(home, JSON.stringify({ commit: A, merged_at: '2026-11-06T18:22:01Z' }));
  v = b.view();
  assert.equal(v.behind, false);
  assert.equal(v.words, 'Running aaaaaaaa, the latest merged build.');
  // An unknown running commit can't be compared: behind stays unknown.
  const blind = new Build({ version: 'v', codeRoot: notGit(), home, env: {}, startedAt: STARTED }).view();
  assert.equal(blind.behind, null);
  assert.match(blind.words, /doesn't know which commit it is running; latest merged aaaaaaaa/);
});

test('NOVA_LATEST_FILE moves the file; anything that isn’t a clean record is not known', () => {
  const home = scratch();
  const elsewhere = join(scratch(), 'record.json');
  const b = new Build({ version: 'v', codeRoot: notGit(), home, env: { NOVA_BUILD_COMMIT: A, NOVA_LATEST_FILE: elsewhere }, startedAt: STARTED });
  assert.equal(b.latestPath, elsewhere);
  writeFileSync(elsewhere, JSON.stringify({ commit: B, merged_at: '2026-11-06T18:22:01Z' }));
  assert.equal(b.view().behind, true);
  const bad = [
    'not json', '[]', 'null', JSON.stringify({ commit: B }), JSON.stringify({ merged_at: '2026-11-06T18:22:01Z' }),
    JSON.stringify({ commit: 'abc1234', merged_at: '2026-11-06T18:22:01Z' }), JSON.stringify({ commit: `${B}0`, merged_at: '2026-11-06T18:22:01Z' }),
    JSON.stringify({ commit: B, merged_at: 'yesterday' }), JSON.stringify({ commit: B, merged_at: 1762453321 }),
    JSON.stringify({ commit: B, merged_at: '2026-11-06T18:22:01Z', pad: 'x'.repeat(LATEST_MAX_BYTES) }),
  ];
  for (const body of bad) {
    writeFileSync(elsewhere, body);
    assert.equal(readLatest(elsewhere), null, body.slice(0, 80));
    assert.equal(b.view().behind, null);
  }
  const link = join(scratch(), 'link.json');
  writeFileSync(elsewhere, JSON.stringify({ commit: B, merged_at: '2026-11-06T18:22:01Z' }));
  symlinkSync(elsewhere, link);
  assert.equal(readLatest(link), null, 'a link is not the record');
  assert.equal(readLatest(join(scratch(), 'missing.json')), null);
  assert.equal(readLatest(scratch()), null, 'a folder is not the record');
});

test('scripts/deploy-record.sh writes the record Nova reads: atomically, mode 600, refusing bad input', () => {
  const home = scratch();
  const run = (...args: string[]) => spawnSync('sh', [RECORD, ...args], { encoding: 'utf8' });
  let r = run(home, B.toUpperCase(), '2026-11-06T18:22:01Z');
  assert.equal(r.status, 0, r.stderr);
  const file = join(home, 'deploy', 'latest.json');
  assert.deepEqual(readLatest(file), { commit: B, merged_at: '2026-11-06T18:22:01.000Z', source: file });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(home, 'deploy')), ['latest.json'], 'no temporary file left behind');
  r = run(home, A, '2026-11-07T08:00:00+01:00');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readLatest(file)!.commit, A, 'a later merge replaces the record');
  for (const args of [[home, 'abc1234', '2026-11-06T18:22:01Z'], [home, `${A}","x":"`, '2026-11-06T18:22:01Z'], [home, A, 'yesterday'], [home, A, '2026-11-06T18:22:01Z"}'], [join(home, 'nowhere'), A, '2026-11-06T18:22:01Z'], [home, A]]) {
    r = run(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
  }
  assert.equal(readLatest(file)!.commit, A, 'a refused record changes nothing');
});

test('GET /api/v1/version says the running build and whether a redeploy is pending, under the API’s own guard', async () => {
  const startedAt = STARTED;
  const h = await hub({ core: { version: '0.1.0-alpha.1', build: { env: { NOVA_BUILD_COMMIT: A, NOVA_BUILD_DATE: '2026-11-06T09:30:00Z' }, startedAt } } });
  try {
    let r = await h.c('GET', '/version');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { version: '0.1.0-alpha.1', commit: A, commit_short: 'aaaaaaaa', built_at: '2026-11-06T09:30:00.000Z', latest: null, behind: null, words: 'Running aaaaaaaa; Nova doesn\'t know the latest merged build.' });
    latest(h.home, JSON.stringify({ commit: B, merged_at: '2026-11-06T18:22:01Z' }));
    r = await h.c('GET', '/version');
    assert.equal(r.body.behind, true);
    assert.equal(r.body.latest.commit, B);
    assert.equal(r.body.words, 'Running aaaaaaaa, latest merged 01234567 — redeploy pending.');
    assert.equal((await h.c('POST', '/version', {})).status, 405, 'read-only');
    assert.equal((await call(h.mesh, 'GET', '/api/v1/version')).status, 401, 'a caller without a session learns nothing');
    const doc = (await h.c('GET', '/openapi.json')).body;
    assert.ok(doc.paths['/api/v1/version'].get, 'in the API document');
  } finally {
    await h.stop();
  }
});
