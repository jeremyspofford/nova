import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Supervisor } from '/workspace/src/supervisor/supervisor.ts';
import { fakeRepo, fakeRelease, git, FAST } from '/workspace/tests/supervisor/fake.ts';
import { Person } from '/workspace/tests/support/broker-support.ts';
import { fileSha256 } from '/workspace/src/broker/origin.ts';
import { readMark } from '/workspace/src/core/resilience/home-mark.ts';
import { open } from '/workspace/tests/core/resilience-support.ts';
import { until, ROOT } from '/workspace/tests/supervisor/support.ts';
import { validate } from '/workspace/src/core/services/definition.ts';
import { consoleDefinition } from '/workspace/src/core/services/console.ts';

function fixture(change?: (root: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-broker-life-'));
  const repo = fakeRepo(dir);
  cpSync(join(ROOT, 'src/broker'), join(repo, 'src/broker'), { recursive: true });
  cpSync(join(ROOT, 'src/core/broker'), join(repo, 'src/core/broker'), { recursive: true });
  cpSync(join(ROOT, 'src/core/resilience/link.ts'), join(repo, 'src/core/resilience/link.ts'));
  const file = join(repo, 'src/server.js');
  writeFileSync(file, readFileSync(file, 'utf8').replace("const marker =", `import { BrokerClient } from './core/broker/client.ts';
import { ipcBroker } from './core/resilience/link.ts';
let broker;
const context = await ipcBroker(process);
if (context) {
  broker = new BrokerClient(context);
  const a = await broker.listRefs();
  if (!a.ok || Object.keys(context).sort().join() !== 'socket,token') process.exit(71);
  if (Object.values(process.env).includes(context.token) || process.argv.includes(context.token)) process.exit(72);
}
const marker =`).replace("const u = req.url || '';", `const u = req.url || '';
  if (u === '/test-broker' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const q = JSON.parse(body); return json(await broker.call(q.m, q.f));
  }`));
  change?.(repo);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'broker-aware fixture');
  const home = join(dir, 'home'); mkdirSync(home);
  const sup = new Supervisor({ dir: join(dir, 'supervisor'), home, repo, base: repo, env: { PATH: process.env.PATH!, HOME: dir, NOVA_PORT: '0', NOVA_VAULT_KEY: 'file' }, tests: [process.execPath, '-e', ''], timings: FAST });
  return { dir, repo, home, sup };
}

test('review: rollback must keep Core stopped when owned broker cleanup fails', { timeout: 20000 }, async () => {
  const f = fixture((root) => {
    const path = join(root, 'src/broker/main.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('await broker.stopPrograms();', 'await Promise.reject(new Error("injected owned cleanup failure"));'));
  });
  try {
    fakeRelease(f.repo, 'v1.1.0', 'two');
    await f.sup.slots.ensure('v1.1.0'); f.sup.slots.point('v1.1.0');
    await f.sup.run(); await until(() => f.sup.state.mode === 'running', 'running', 4000);
    const oldPid = (f.sup.state as any).broker.pid;
    const result = await f.sup.rollback({ auto: false, reason: 'review cleanup contract', target: 'base' });
    console.log(JSON.stringify({ result, mode: f.sup.state.mode, oldPid, broker: (f.sup.state as any).broker, coreRestarted: f.sup.server !== null }));
    assert.equal(result.ok, false);
    assert.equal(f.sup.server, null, 'rollback must not start replacement Core after unconfirmed cleanup');
  } finally {
    await f.sup.close().catch((e) => console.log('Expected cleanup rejection: ' + e.message));
    rmSync(f.dir, { recursive: true, force: true });
    const egress = process.env.NOVA_EGRESS_LOG!;
    assert.equal(existsSync(egress) ? readFileSync(egress, 'utf8') : '', '', 'egress guard never fired');
    console.log('review egress guard: never fired');
  }
});
