// The test fixtures' own regressions (docs/plans/track1-follow-up-queue.md, broad-host timing):
//  - a service a test wants absent is held at a port the test owns, which refuses every connection.
//    A port bound and released instead was taken in the full suite by other test files' listeners
//    (WSL2 gives listeners about a thousand port numbers); a Nova server landing there answers
//    GET /health 200, and fresh-user's discovery then reported Screenpipe.
//  - a test that fails early still ends by itself and leaves nothing behind. fresh-user once closed
//    its stand-ins only on the restart path: an early assertion left them listening, and the run
//    never ended ("Promise resolution is still pending but the event loop has already resolved").
// Everything here is on 127.0.0.1 with stand-ins; no real service is looked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover, loopbackTransport } from '../../src/core/index.ts';
import { absentService } from '../support/fake-mdns.ts';
import { ROOT } from './support.ts';

test('a service held absent keeps its port for the test and refuses every connection, so nothing else answers there', async (t) => {
  const absent = await absentService();
  t.after(() => absent.close());
  // No other listener can take the port, on loopback or on every address.
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    const other = createServer((_, res) => res.end('ok'));
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => { other.once('error', r); other.listen(absent.port, host, () => r(null)); });
    if (!err) await new Promise((r) => other.close(r));
    assert.equal(err?.code, 'EADDRINUSE', `another listener took ${host}:${absent.port}`);
  }
  // A connection gets no answer at all, and discovery finds nothing there (every one of its local
  // looks pointed at the held port, so nothing at the usual ports is contacted).
  await assert.rejects(fetch(`http://127.0.0.1:${absent.port}/health`));
  const here = loopbackTransport({ ports: { 'model-runtime': absent.port, screenpipe: absent.port, 'home-assistant': absent.port } });
  const found = await discover({ scope: 'device', transport: here, timeoutMs: 1000 });
  assert.deepEqual(found.found, []);
  assert.equal(absent.attempts, 4, 'one plain GET, then discovery’s three, each refused');
});

test('a test that fails early still ends by itself and leaves nothing behind: no server, no stand-in, no folder', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'nova-early-run-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const report = join(tmp, 'report.json');
  // The ordinary runner, as npm test runs it: no forced exit, no runner timeout. (Its own run, not
  // a subtest of this one: without this runner's NODE_TEST_CONTEXT.)
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const child = spawn(process.execPath, ['--test', 'tests/support/fixtures/early-failure.ts'], {
    cwd: ROOT, env: { ...env, TMPDIR: tmp, NOVA_FIXTURE_REPORT: report }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { out += d; });
  // A run held open by a leaked handle never ends; this bound only turns that into a failure here
  // (and then ends the whole process group, so the failure leaks nothing either).
  const code = await new Promise<number | null>((ok) => {
    const bound = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } ok(null); }, 60_000);
    child.once('exit', (c) => { clearTimeout(bound); ok(c); });
  });
  assert.notEqual(code, null, `the run did not end by itself within 60 s:\n${out}`);
  assert.equal(code, 1, out);
  assert.match(out, /the intended early failure/);
  assert.doesNotMatch(out, /Promise resolution is still pending/);
  // The process that held the stand-ins' ports has exited, so they are closed. What it started
  // outside itself is gone too.
  const r = JSON.parse(readFileSync(report, 'utf8')) as { dir: string; nova: number };
  assert.throws(() => process.kill(r.nova, 0), { code: 'ESRCH' }, 'the Nova server it started is gone');
  assert.equal(existsSync(r.dir), false, 'the blank machine’s folder is gone');
  assert.deepEqual(readdirSync(tmp).filter((n) => n !== 'report.json'), [], 'nothing else is left in its temporary folder');
});
