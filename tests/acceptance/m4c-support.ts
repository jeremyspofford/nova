// A hub and a standby as two real Nova processes, the standby enrolled with the real command.
// Shared by the M4c failover test and its UI test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, blank, sleep, stop, until, type Running } from './support.ts';

export const agent = { NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(ROOT, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none' };

// A port for an address that must be known before its server starts (a standby's, which goes in
// the roster when it enrolls). Picked below the ephemeral range (Linux 32768+, macOS 49152+), so
// no server on port 0 and no outgoing connection elsewhere in a parallel run can take it between
// the check and the bind. Servers that can, listen on port 0 and say which port they got.
export async function freePort(host = '127.0.0.1'): Promise<number> {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    const s = createServer();
    const ok = await new Promise<boolean>((r) => { s.once('error', () => r(false)); s.listen(port, host, () => r(true)); });
    if (ok) {
      await new Promise((r) => s.close(r));
      return port;
    }
  }
}

export async function kill(r: Running) {
  r.proc.kill('SIGKILL');
  for (let i = 0; i < 200 && r.proc.exitCode === null && r.proc.signalCode === null; i++) await sleep(25);
}

// A hub and a standby home, each with a mesh listener on its own loopback port. The standby enrolls
// with `boot.ts join --kind standby --nova-home <dir> --address <its mesh URL>` (M4b), which writes
// its identity and mesh/role.json.
export async function setup(prefix: string, hubExtra: (home: string) => void = () => {}) {
  const hub = blank(`${prefix}-hub-`);
  const standby = blank(`${prefix}-standby-`);
  const standbyMesh = `http://127.0.0.1:${await freePort()}`;
  const env = (url: string) => ({ ...agent, NOVA_MESH_URL: url, NOVA_MESH_TRANSPORT: 'network', NOVA_SYNC_WAIT_S: '5' });
  hubExtra(hub.home);
  // The hub picks its own mesh port and says which.
  const hubProc = await hub.start(env('http://127.0.0.1:0'));
  const hubMesh = hubProc.mesh!;
  assert.match(hubMesh, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/, 'the hub says the port it chose');

  // Enrolled with the real command, as the gate does it. Anything going wrong stops both processes.
  let enrolling: ReturnType<typeof spawn> | null = null;
  try {
    const code = (await hub.send('POST', '/api/v1/mesh/pairings')).body.code;
    enrolling = spawn(process.execPath, ['src/device/boot.ts', 'join', hubMesh, '--code', code, '--kind', 'standby', '--name', 'Standby', '--nova-home', standby.home, '--address', standbyMesh], {
      cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: join(standby.dir, 'user'), NOVA_DEVICE_HOME: join(standby.dir, 'device'), NOVA_DEVICE_POLL_MS: '100' },
    });
    const said: string[] = [];
    enrolling.stdout!.on('data', (d) => said.push(String(d)));
    enrolling.stderr!.on('data', (d) => said.push(String(d)));
    const waiting = await until<any[]>(() => hub.get('/api/v1/mesh/requests'), (rs) => rs.some((r) => r.kind === 'standby'), 400);
    const req = waiting.find((r) => r.kind === 'standby');
    assert.ok(req, `the standby asked to join:\n${said.join('')}`);
    const digits = `${req.confirmation.slice(0, 3)} ${req.confirmation.slice(3)}`;
    await until(async () => said.join(''), (t) => t.includes(digits) || t.includes(req.confirmation), 200);
    assert.ok(said.join('').includes(digits) || said.join('').includes(req.confirmation), `the command shows the same digits:\n${said.join('')}`);
    assert.equal((await hub.send('POST', `/api/v1/mesh/requests/${req.id}/approve`, { confirm: true })).status, 200);
    for (let i = 0; i < 400 && enrolling.exitCode === null; i++) await sleep(25);
    assert.equal(enrolling.exitCode, 0, said.join(''));
    const role = JSON.parse(readFileSync(join(standby.home, 'mesh', 'role.json'), 'utf8'));
    assert.equal(role.roster.roster.hub.url, hubMesh, 'the roster names the hub where devices reach it');
    assert.equal(role.roster.roster.standby.url, standbyMesh, 'and the standby where they look when the hub is gone');
    const standbyId = role.device_id;
    return { hub, standby, hubMesh, standbyMesh, hubProc, env, standbyId };
  } catch (e) {
    enrolling?.kill('SIGKILL');
    await stop(hubProc);
    throw e;
  }
}

