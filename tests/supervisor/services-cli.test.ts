// The services through the supervisor's command line, as the person runs it (M10e): the supervisor
// is a real process (`main.ts run`) over the stand-in console; the stand-in service is deployed,
// promoted only with the typed word, listed, and stopped with the supervisor, process group and all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeRepo } from './fake.ts';
import { cli, scratch, supervise, until } from './support.ts';
import { SERVICE_TIMINGS } from './services-support.ts';
import { alive, freePort, standIn, whoami } from '../support/services.ts';

test('deploy, promote with the typed word, list and go back, from the command line; stopping the supervisor stops the service', async () => {
  const dir = scratch('nova-svc-cli-');
  const s = await supervise({ dir, repo: fakeRepo(dir), timings: SERVICE_TIMINGS });
  let pids: number[] = [];
  try {
    const port = await freePort();
    const file = (v: string) => { const f = join(dir, `stand-in-${v}.json`); writeFileSync(f, JSON.stringify(standIn({ version: v, port }))); return f; };
    const plan = await cli(s.dir, 'service', 'plan', file('1.0.0'));
    assert.equal(plan.code, 0, plan.out);
    assert.equal(JSON.parse(plan.out).steps[0].step, 'install');

    const d1 = await cli(s.dir, 'service', 'deploy', file('1.0.0'));
    assert.equal(d1.code, 0, d1.out);
    assert.match(d1.out, /✓ install[\s\S]*✓ tests[\s\S]*ready to promote/);
    // No terminal to type into, no --confirm: not promoted.
    const no = await cli(s.dir, 'service', 'promote', 'stand-in', '1.0.0');
    assert.equal(no.code, 2);
    assert.match(no.out, /Not promoted: it needs your confirmation \(type stand-in@1\.0\.0/);
    assert.equal(await whoami(port), null);
    const wrong = await cli(s.dir, 'service', 'promote', 'stand-in', '1.0.0', '--confirm', 'yes');
    assert.equal(wrong.code, 2);
    const yes = await cli(s.dir, 'service', 'promote', 'stand-in', '1.0.0', '--confirm', 'stand-in@1.0.0');
    assert.equal(yes.code, 0, yes.out);
    assert.equal((await whoami(port))!.version, '1.0.0');

    assert.equal((await cli(s.dir, 'service', 'deploy', file('2.0.0'))).code, 0);
    assert.equal((await cli(s.dir, 'service', 'promote', 'stand-in', '2.0.0', '--confirm', 'stand-in@2.0.0')).code, 0);
    const list = await cli(s.dir, 'services');
    assert.match(list.out, /nova-console: base, running\./);
    assert.match(list.out, /stand-in: 2\.0\.0 live; 1\.0\.0 kept\./);
    const json = JSON.parse((await cli(s.dir, 'services', '--json')).out);
    assert.equal(json[0].live, '2.0.0');

    assert.equal((await cli(s.dir, 'service', 'rollback', 'stand-in')).code, 2, 'going back asks first');
    const back = await cli(s.dir, 'service', 'rollback', 'stand-in', '--confirm', 'rollback');
    assert.equal(back.code, 0, back.out);
    assert.equal((await whoami(port))!.version, '1.0.0');
    pids = [(await whoami(port))!.pid];
  } finally {
    await s.stop();
  }
  // The supervisor stopped on SIGTERM, and its services with it.
  await until(() => pids.every((p) => !alive(p)), 'the service to stop with the supervisor', 5000);
});

test('a supervisor killed outright leaves its service running; the next one ends that process group before starting its own', async () => {
  const dir = scratch('nova-svc-killed-');
  const repo = fakeRepo(dir);
  const first = await supervise({ dir, repo, timings: SERVICE_TIMINGS });
  const port = await freePort();
  const f = join(dir, 'stand-in.json');
  writeFileSync(f, JSON.stringify(standIn({ version: '1.0.0', port, flags: ['--child'] })));
  let leftover = 0;
  let child = 0;
  try {
    assert.equal((await cli(first.dir, 'service', 'deploy', f)).code, 0);
    assert.equal((await cli(first.dir, 'service', 'promote', 'stand-in', '1.0.0', '--confirm', 'stand-in@1.0.0')).code, 0);
    leftover = (await whoami(port))!.pid;
    child = Number((await import('node:fs')).readFileSync(join(first.dir, 'services', 'stand-in', 'state', 'default', 'child-1.0.0.pid'), 'utf8'));
    const consolePid = first.state()?.server?.pid as number;
    first.proc.kill('SIGKILL');
    await until(() => first.proc.exitCode !== null || first.proc.signalCode !== null, 'the supervisor to die');
    // Killed, it ended nothing: its service and that service's child run on, orphaned.
    assert.ok(alive(leftover) && alive(child), 'the service is left running');
    process.kill(consolePid, 'SIGKILL');
  } finally {
    await first.stop();
  }
  const again = await supervise({ dir, repo, timings: SERVICE_TIMINGS });
  try {
    await until(() => !alive(leftover) && !alive(child), 'the leftover process group to be ended');
    await until(async () => { const w = await whoami(port); return !!w && w.pid !== leftover; }, 'its own instance to serve');
  } finally {
    await again.stop();
    // Whatever the outcome, the orphaned group this test made is not left behind.
    if (leftover && alive(leftover)) try { process.kill(-leftover, 'SIGKILL'); } catch { /* gone */ }
    if (child && alive(child)) try { process.kill(child, 'SIGKILL'); } catch { /* gone */ }
  }
  await until(() => !alive(leftover) && !alive(child), 'nothing left', 5000);
});
