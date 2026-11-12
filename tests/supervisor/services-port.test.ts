// A service's ports (#516): the supervisor finds each one free and closes it again before the
// service starts, so another program can take it first. Its health and contract checks count only
// an answer from a socket the service's own process group holds (Linux), so that other program is
// never taken for the service and the stable port is never pointed at it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, freePort, standIn } from '../support/services.ts';
import { scratch } from './support.ts';
import { deploy, supervised } from './services-support.ts';

const skip = process.platform === 'linux' ? false : 'reads /proc';

// A "service" that doesn't listen itself: it starts a server in a process group of its own on the
// port it was given, which answers /health and /contract as the service would, writes down that
// port and the server's pid in `notes`, and waits.
const outsideProgram = (notes: string) => `const { spawn } = require('node:child_process');
const c = spawn(process.execPath, ['-e', "require('node:http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')"], { detached: true, stdio: 'ignore', env: process.env });
require('node:fs').writeFileSync(${JSON.stringify(notes)} + '/outside-' + c.pid, process.env.PORT);
c.unref();
setInterval(() => {}, 1000);
`;

test('a service whose port is answered by a process outside its own process group is not taken as healthy', { timeout: 60_000, skip }, async () => {
  const h = await supervised('nova-svc-port-');
  const state = scratch('nova-svc-port-notes-');
  const file = join(scratch('nova-svc-port-prog-'), 'outside.cjs');
  writeFileSync(file, outsideProgram(state));
  const outside = () => { try { return readdirSync(state).filter((f) => f.startsWith('outside-')).map((f) => ({ pid: Number(f.slice(8)), port: Number(readFileSync(join(state, f), 'utf8')) })); } catch { return []; } };
  try {
    const r = await deploy(h.s, standIn({ version: '1.0.0', port: await freePort(), file }));
    assert.equal(r.ok, false, `deployed: ${r.said}`);
    assert.match(r.said, /health didn’t answer within/);
    const seen = outside();
    assert.ok(seen.length >= 1, 'the outside server was started');
    // It did answer health, on the port the service was given: an answer came, not from the service.
    assert.equal((await call(seen.at(-1)!.port, '/health'))?.status, 200);
  } finally {
    for (const o of outside()) try { process.kill(o.pid, 'SIGKILL'); } catch { /* gone */ }
    await h.stop();
  }
});
