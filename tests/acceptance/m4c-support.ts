// A hub and a standby as two real Nova processes, the standby enrolled with the real command.
// Shared by the M4c failover test and its UI test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, START_MS, STOP_MS, blank, exited, output, said, stop, until, type Running } from './support.ts';
import { ensureMark } from '../../src/core/index.ts';
import { freePort } from '../support/workloads.ts';

export const agent = { NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(ROOT, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none' };

// Ports are picked below the ephemeral range (tests/support/workloads.ts says why).
export { freePort } from '../support/workloads.ts';

export async function kill(r: Running) {
  r.proc.kill('SIGKILL');
  await exited(r.proc, STOP_MS);
}

// A hub and a standby home, each with a mesh listener on its own loopback port. The standby enrolls
// with `boot.ts join --kind standby --nova-home <dir> --address <its mesh URL>` (M4b), which writes
// its identity and mesh/role.json. `hubEnv` adds to the hub's environment only (the M6 gate's test
// clock and stand-in model runtime).
export async function setup(prefix: string, hubExtra: (home: string) => void = () => {}, hubEnv: Record<string, string> = {}) {
  const hub = blank(`${prefix}-hub-`);
  const standby = blank(`${prefix}-standby-`);
  const standbyMesh = `http://127.0.0.1:${await freePort()}`;
  const env = (url: string) => ({ ...agent, NOVA_MESH_URL: url, NOVA_MESH_TRANSPORT: 'network', NOVA_SYNC_WAIT_S: '5' });
  // Nova set the hub's home up first (its mark), as it would before anything is put in it.
  ensureMark(hub.home);
  hubExtra(hub.home);
  // The hub picks its own mesh port and says which.
  const hubProc = await hub.start({ ...env('http://127.0.0.1:0'), ...hubEnv });
  const hubMesh = hubProc.mesh!;
  assert.match(hubMesh, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/, 'the hub says the port it chose');

  // Enrolled with the real command, as the gate does it. Anything going wrong stops both processes.
  let enrolling: ReturnType<typeof spawn> | null = null;
  try {
    const code = (await hub.send('POST', '/api/v1/mesh/pairings')).body.code;
    enrolling = spawn(process.execPath, ['src/device/boot.ts', 'join', hubMesh, '--code', code, '--kind', 'standby', '--name', 'Standby', '--nova-home', standby.home, '--address', standbyMesh], {
      cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: join(standby.dir, 'user'), NOVA_DEVICE_HOME: join(standby.dir, 'device'), NOVA_DEVICE_POLL_MS: '100' },
    });
    const joining = output(enrolling);
    const shown = () => joining.out.join('');
    const waiting = await until<any[]>(() => hub.get('/api/v1/mesh/requests'), (rs) => rs.some((r) => r.kind === 'standby'));
    const req = waiting.find((r) => r.kind === 'standby');
    assert.ok(req, `the standby asked to join:\n${shown()}`);
    const digits = `${req.confirmation.slice(0, 3)} ${req.confirmation.slice(3)}`;
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await said(joining, new RegExp(`${escape(digits)}|${escape(req.confirmation)}`), START_MS, 'the command did not show the digits');
    assert.ok(shown().includes(digits) || shown().includes(req.confirmation), `the command shows the same digits:\n${shown()}`);
    assert.equal((await hub.send('POST', `/api/v1/mesh/requests/${req.id}/approve`, { confirm: true })).status, 200);
    // Approved, the command saves what the hub sent and ends.
    await exited(enrolling, START_MS);
    assert.equal(enrolling.exitCode, 0, shown());
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

