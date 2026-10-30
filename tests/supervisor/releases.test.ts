// Code releases through the supervisor (M7 gate item 5), with real processes and real git tags:
// a good release deploys (tier 3), canaries and stays; a sabotaged one that breaks health after the
// switch is rolled back automatically to the previous slot with the data intact; a release whose
// own tests fail never reaches the switch; and going back across a database upgrade restores the
// pre-upgrade backup only when nothing was written since, refusing with the reason otherwise.
// Run alone for the gate: node --test tests/supervisor/releases.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, cli, releaseRepo, scratch, supervise, until } from './support.ts';

const bump = (version: string) => (root: string, r: ReturnType<typeof releaseRepo>) => r.edit(root, 'package.json', '"version": "0.1.0"', `"version": "${version}"`);

test('a good release deploys only with a tier-3 confirmation, canaries, and stays; the data is untouched', async () => {
  const dir = scratch('nova-rel-good-');
  const r = releaseRepo(dir);
  r.tag('v1.1.0', (root) => bump('0.1.1')(root, r));
  const s = await supervise({ dir, repo: r.repo });
  try {
    const m = await api(s.base(), 'POST', '/api/v1/memory', { kind: 'fact', content: 'The shed key is on the blue hook.' });
    assert.equal(m.status, 201);
    assert.equal((await api(s.base(), 'GET', '/api/v1/health')).body.version, '0.1.0');

    // Tier 3: never without the explicit confirmation, on the command line or the API.
    const unconfirmed = await cli(s.dir, 'deploy', 'v1.1.0');
    assert.equal(unconfirmed.code, 2);
    assert.match(unconfirmed.out, /explicit confirmation/);
    assert.equal((await api(s.base(), 'POST', '/api/v1/supervisor/deploy', { version: 'v1.1.0' })).status, 400);
    assert.equal(s.state().releases.current, 'base', 'nothing changed');

    const d = await cli(s.dir, 'deploy', 'v1.1.0', '--confirm', 'v1.1.0');
    assert.equal(d.code, 0, d.out);
    for (const stage of ['prepare', 'tests', 'sandbox', 'smoke', 'switch', 'canary', 'promote']) assert.match(d.out, new RegExp(`✓ ${stage}:`), `${stage} in:\n${d.out}`);
    const st = s.state();
    assert.equal(st.releases.current, 'v1.1.0');
    assert.equal(st.releases.previous, 'base');
    assert.equal(st.releases.last_good, 'v1.1.0');
    assert.equal(st.deploy.outcome, 'promoted');
    assert.ok(st.deploy.canary.probes.length >= 2 && st.deploy.canary.probes.every((p: { ok: boolean }) => p.ok));
    // The slot is a worktree of the tag, and `current` points at it.
    const slot = join(s.dir, 'releases', 'v1.1.0');
    assert.ok(existsSync(join(slot, '.git')) && existsSync(join(slot, 'src', 'server.js')));
    assert.ok(lstatSync(join(s.dir, 'releases', 'current')).isSymbolicLink());
    assert.equal(readlinkSync(join(s.dir, 'releases', 'current')), 'v1.1.0');

    // It stays: still the new version a while later, still answering, the memory still there.
    await new Promise((res) => setTimeout(res, 1500));
    const h = await api(s.base(), 'GET', '/api/v1/health');
    assert.equal(h.body.version, '0.1.1');
    assert.equal(s.state().releases.current, 'v1.1.0');
    assert.ok((await api(s.base(), 'GET', '/api/v1/memory')).body.some((x: { id: string }) => x.id === m.body.id));
    // Health shows it, through the running server.
    const view = (await api(s.base(), 'GET', '/api/v1/resilience')).body;
    assert.equal(view.releases.current, 'v1.1.0');
    assert.equal(view.supervisor.mode, 'running');
    const status = await cli(s.dir, 'status');
    assert.match(status.out, /Release: v1\.1\.0\. Previous: the code the supervisor started from/);
  } finally {
    await s.stop();
  }
});

test('a sabotaged release that breaks health after the switch is rolled back automatically, data intact, with a problem and its playbook', async () => {
  const dir = scratch('nova-rel-bad-');
  const r = releaseRepo(dir);
  // Passes its tests and the sandbox (where NOVA_SANDBOX is set), then fails live.
  r.tag('v1.2.0', (root) => r.edit(root, 'src/core/index.ts', '      backups: keep.health(),\n', "      backups: keep.health(),\n      sabotage: { ok: process.env.NOVA_SANDBOX === '1', detail: 'This release breaks once it runs on the live home.' },\n"));
  const s = await supervise({ dir, repo: r.repo });
  try {
    const m = await api(s.base(), 'POST', '/api/v1/memory', { kind: 'fact', content: 'The boiler was serviced in March.' });
    // Deployed from the console's API, as the PWA does.
    const asked = await api(s.base(), 'POST', '/api/v1/supervisor/deploy', { version: 'v1.2.0', confirm: true });
    assert.equal(asked.status, 202, JSON.stringify(asked.body));
    await until(() => ['rolled_back', 'promoted', 'stopped', 'refused'].includes(s.state()?.deploy?.outcome) && s.state()?.mode === 'running', 'the deploy to end', 60_000);
    const st = s.state();
    assert.equal(st.deploy.outcome, 'rolled_back', JSON.stringify(st.deploy.stages, null, 1));
    const stages = Object.fromEntries(st.deploy.stages.map((x: { stage: string; ok: boolean }) => [x.stage, x.ok]));
    assert.deepEqual([stages.tests, stages.sandbox, stages.smoke, stages.switch, stages.canary, stages.rollback], [true, true, true, true, false, true]);
    assert.match(st.deploy.stages.find((x: { stage: string }) => x.stage === 'canary').said, /sabotage/);
    assert.equal(st.releases.current, 'base', 'back on the previous slot');
    assert.equal(st.releases.slots.find((x: { version: string }) => x.version === 'v1.2.0').status, 'rolled_back');

    await until(async () => (await api(s.base(), 'GET', '/api/v1/health')).body?.ok === true, 'the previous release to be healthy');
    assert.equal((await api(s.base(), 'GET', '/api/v1/memory')).body.find((x: { id: string }) => x.id === m.body.id)?.content, 'The boiler was serviced in March.', 'the data is intact');
    await until(async () => (await api(s.base(), 'GET', '/api/v1/problems?open=1')).body.some((p: { message: string }) => /v1\.2\.0 was rolled back/.test(p.message)), 'the problem');
    const p = (await api(s.base(), 'GET', '/api/v1/problems?open=1')).body.find((x: { message: string }) => /v1\.2\.0 was rolled back/.test(x.message));
    const pb = (await api(s.base(), 'GET', `/api/v1/problems/${p.id}/playbook`)).body;
    assert.equal(pb.id, 'release-rolled-back');
    assert.match(p.detail, /sabotage/);
  } finally {
    await s.stop();
  }
});

test('a release whose own tests fail stops before the switch; nothing changes', async () => {
  const dir = scratch('nova-rel-tests-');
  const r = releaseRepo(dir);
  r.tag('v1.4.0', (root) => writeFileSync(join(root, 'tests', 'release.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => assert.equal(1, 2));\n"));
  const s = await supervise({ dir, repo: r.repo });
  try {
    const d = await cli(s.dir, 'deploy', 'v1.4.0', '--confirm', 'v1.4.0');
    assert.equal(d.code, 1);
    assert.match(d.out, /✗ tests:/);
    assert.doesNotMatch(d.out, /switch/);
    assert.equal(s.state().releases.current, 'base');
    assert.equal(s.state().deploy.outcome, 'stopped');
    await until(async () => (await api(s.base(), 'GET', '/api/v1/problems?open=1')).body.some((p: { message: string }) => /v1\.4\.0 didn’t pass its tests/.test(p.message)), 'the problem');
    // An unknown tag is refused at once.
    assert.match((await cli(s.dir, 'deploy', 'v9.9.9', '--confirm', 'v9.9.9')).out, /no release tagged v9\.9\.9/);
  } finally {
    await s.stop();
  }
});

test('going back across a database upgrade: refused with the reason when something was written since, restored from the backup when nothing was', async () => {
  const dir = scratch('nova-rel-mig-');
  const r = releaseRepo(dir);
  r.tag('v1.3.0', (root) => { bump('0.1.3')(root, r); writeFileSync(join(root, 'src', 'core', 'migrations', `${r.nextMigration(root)}_release_note.sql`), '-- A harmless new table, so this release upgrades the database.\nCREATE TABLE release_note (id INTEGER PRIMARY KEY, text TEXT NOT NULL);\n'); });
  const s = await supervise({ dir, repo: r.repo });
  try {
    const before = (await api(s.base(), 'GET', '/api/v1/health')).body.checks.database.detail;
    const d = await cli(s.dir, 'deploy', 'v1.3.0', '--confirm', 'v1.3.0');
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /the database was upgraded from (\d+) to (\d+)/);
    const mig = s.state().releases.slots.find((x: { version: string }) => x.version === 'v1.3.0').migration;
    assert.ok(mig && mig.to === mig.from + 1 && mig.backup && existsSync(mig.backup), 'the pre-upgrade backup is kept');

    // Something written since the upgrade: going back would lose it, so it is refused.
    const m = await api(s.base(), 'POST', '/api/v1/memory', { kind: 'fact', content: 'Written after the upgrade.' });
    assert.equal(m.status, 201);
    const back = await cli(s.dir, 'rollback', '--confirm');
    assert.equal(back.code, 1, back.out);
    assert.match(back.out, /would lose \d+ changes? written since v1\.3\.0 upgraded the database/);
    assert.match(back.out, /Nova kept v1\.3\.0 running/);
    await until(() => s.state()?.mode === 'running' && !!s.port(), 'Nova running again');
    assert.equal(s.state().releases.current, 'v1.3.0');
    assert.equal((await api(s.base(), 'GET', '/api/v1/health')).body.version, '0.1.3');
    assert.ok((await api(s.base(), 'GET', '/api/v1/memory')).body.some((x: { id: string }) => x.id === m.body.id), 'nothing was lost');
    await until(async () => (await api(s.base(), 'GET', '/api/v1/problems?open=1')).body.some((p: { message: string }) => /couldn’t go back/.test(p.message)), 'the problem with its reason');
  } finally {
    await s.stop();
  }

  // A second home: the same upgrade, and nothing written since. Going back restores the backup.
  const dir2 = scratch('nova-rel-mig2-');
  const s2 = await supervise({ dir: dir2, repo: r.repo });
  try {
    const before = (await api(s2.base(), 'GET', '/api/v1/health')).body.checks.database.detail;
    const d = await cli(s2.dir, 'deploy', 'v1.3.0', '--confirm', 'v1.3.0');
    assert.equal(d.code, 0, d.out);
    const back = await cli(s2.dir, 'rollback', '--confirm');
    assert.equal(back.code, 0, back.out);
    assert.match(back.out, /Restored the database from before v1\.3\.0 upgraded it/);
    await until(() => s2.state()?.mode === 'running' && !!s2.port(), 'Nova running again');
    assert.equal(s2.state().releases.current, 'base');
    assert.equal((await api(s2.base(), 'GET', '/api/v1/health')).body.checks.database.detail, before, 'the database is at the version it was');
  } finally {
    await s2.stop();
  }
});
