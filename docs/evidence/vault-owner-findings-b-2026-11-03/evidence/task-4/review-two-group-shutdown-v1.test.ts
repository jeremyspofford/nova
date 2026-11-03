// Task 4: real owned processes and synthetic keychain only, in private temporary homes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileSha256 } from '../../../../../src/broker/origin.ts';
import { startBroker } from '../../../../../src/broker/spawn.ts';
import { BrokerClient } from '../../../../../src/core/broker/client.ts';
import { Vault } from '../../../../../src/core/vault.ts';
import { C, Person, inProcess, tmp, type A } from '../../../../../tests/support/broker-support.ts';

async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await delay(20);
  assert.ok(check(), 'condition reached before deadline');
}
function running(pid: number) {
  try { return !/^[^)]*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
async function program(body: string, permission = false) {
  const home = tmp('nova-owned-launch-');
  const dir = join(home, 'broker');
  const local = permission ? null : inProcess(dir);
  const started = permission ? await startBroker(dir, { keyMode: 'file', pipe: false }) : null;
  const client = started ? new BrokerClient({ socket: started.socket, token: started.tokens.core }) : null;
  const call = local?.call ?? ((m: string, f = {}) => client!.call(m, f));
  const p = new Person(call);
  await p.setup();
  const path = join(home, 'program.py');
  writeFileSync(path, '#!/usr/bin/python3\n' + body, { mode: 0o755 });
  const target = { kind: 'process', path, sha256: fileSha256(path) };
  const made = await p.approve('create', { meta: { name: 'test/FILE', kind: 'secret', class: 'standard' }, source: 'sealed', bind: [{ target, inject: { how: 'file', env: 'CREDENTIAL_FILE' }, consent: {} }] }, { seal: C('owned-file'), sealAt: (f, e) => ({ ...f, source: { sealed: e } }) });
  assert.equal(made.ok, true);
  return { home, dir, local, started, use: (request = {}) => call('use', { ref: made.ref, target, request: { argv: [], ...request } }),
    close: async () => { client?.close(); if (started) { const exited = once(started.child, 'exit'); started.child.kill(); await exited; } } };
}
const stubborn = `import os,signal,time,json
signal.signal(signal.SIGTERM,signal.SIG_IGN)
pid=os.fork()
if pid==0:
    while True: time.sleep(1)
with open(os.environ['TF_VAR_LOG'],'w') as f: json.dump([os.getpid(),pid,os.environ['CREDENTIAL_FILE']],f)
time.sleep(.2)
with open(os.environ['CREDENTIAL_FILE']) as f: print(f.read(),flush=True)
print('delayed read complete '*1000,flush=True)
while True: time.sleep(1)
`;

test('review: stop must await every owned escalation even when one cleanup fails', { timeout: 15000 }, async () => {
  const b = await program(stubborn);
  const logs = [join(b.home, 'first'), join(b.home, 'second')];
  const uses = logs.map(log => b.use({ env: { TF_VAR_LOG: log } }));
  let pids: number[] = [];
  const kill = process.kill;
  try {
    await until(() => logs.every(existsSync));
    pids = logs.flatMap(log => JSON.parse(readFileSync(log, 'utf8')).slice(0, 2));
    let denied: number | undefined;
    process.kill = ((pid: number, sig?: number | NodeJS.Signals) => {
      if (pid < 0 && denied === undefined) denied = pid;
      if (pid === denied) throw Object.assign(new Error('synthetic denied first group'), { code: 'EPERM' });
      return kill(pid, sig);
    }) as typeof process.kill;
    await assert.rejects(b.local!.broker.stopPrograms(), /cleanup/);
    const secondRunningAtShutdownReturn = pids.slice(2).some(running);
    process.stdout.write(JSON.stringify({ secondRunningAtShutdownReturn }) + '\n');
    await delay(200);
    process.stdout.write(JSON.stringify({ secondRunningAfterOtherEscalation: pids.slice(2).some(running) }) + '\n');
    assert.equal(secondRunningAtShutdownReturn, false, 'main exits immediately when stopPrograms rejects, before the second KILL timer fires');
  } finally {
    process.kill = kill;
    for (const pid of pids) if (running(pid)) kill(pid, 'SIGKILL');
    await Promise.all(uses);
    await b.close();
  }
});
