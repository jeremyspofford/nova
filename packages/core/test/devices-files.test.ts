// Device file operations through novad (FR-210) and the connected computer (FR-081, FR-062):
// the owner's own folder grants, staged writes with a diff and an atomic commit, conflicts, a
// write outside the grants filing a folder-access request with a Hub approval card (decided on
// the Hub or on the device), protected paths refused on the Hub too (novad's list kept equal to
// the policy engine's), one connection per agent
// refused below the minimum version, the local_host Computer and the Code device environment.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_LOCATIONS, READ_ONLY_LOCATIONS } from '@nova/policy';
import { NovaError } from '@nova/shared';
import {
  DeviceComputerProvider,
  callDevice,
  deviceEnvProvider,
  deviceEnvironment,
  deviceError,
  fakeDeviceLineDiff,
  type DeviceTransport,
  type FakeDevice,
} from '../src/index.ts';
import { ACCOUNT, devicesEnv, type DevicesEnv } from './devices-env.ts';

let env: DevicesEnv;
let fake: FakeDevice;
let proj: string;
const USER = { kind: 'user' as const, id: ACCOUNT };
const AGENT = { kind: 'agent' as const, id: 'agent-1' };

beforeEach(async () => {
  env = await devicesEnv();
  fake = await env.enroll({
    exec: (spec) =>
      Promise.resolve({
        exitCode: 0,
        stdout: `ran ${String(spec.cmd)}`,
        stderr: '',
        timedOut: false,
      }),
    mcp: { notes: { tools: [{ name: 'search' }], call: (tool, args) => ({ tool, args }) } },
  });
  proj = join(env.dir, 'proj');
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'src', 'a.txt'), 'one\ntwo\nthree\n');
});

afterEach(async () => {
  await env.close();
});

async function rejects(p: Promise<unknown>): Promise<NovaError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NovaError) return err;
    throw err;
  }
  throw new Error('expected a NovaError');
}

/** Answer the approval card the way POST /approvals does, then pass it to the service. */
async function decide(approvalId: string, decision: 'allow_once' | 'deny_continue') {
  env.db.raw
    .prepare(
      "UPDATE approval SET status = 'decided', decision = ?, decided_by = 'user' WHERE id = ?",
    )
    .run(decision, approvalId);
  await env.svc.onApprovalDecided(ACCOUNT, approvalId, decision);
}

describe('the owner’s folders', () => {
  it('grants the signed-in user at once and lists, reads and stats inside', async () => {
    const id = fake.deviceId!;
    expect((await rejects(env.svc.listFiles(ACCOUNT, id, USER, proj))).details).toMatchObject({
      reason: 'folder_access_required',
    });
    const r = await env.svc.requestAccess(ACCOUNT, id, USER, { path: proj, access: 'write' });
    expect(r).toMatchObject({
      status: 'granted',
      decidedBy: 'hub',
      approvalId: null,
      access: 'write',
    });
    const l = await env.svc.listFiles(ACCOUNT, id, USER, proj);
    expect(l.entries).toEqual([{ name: 'src', kind: 'dir', size: null }]);
    const f = await env.svc.readFile(ACCOUNT, id, USER, join(proj, 'src', 'a.txt'));
    expect(Buffer.from(f.contentBase64, 'base64').toString()).toBe('one\ntwo\nthree\n');
    expect((await env.svc.statFile(ACCOUNT, id, USER, join(proj, 'src'))).kind).toBe('dir');
    // Asking again is answered from the existing grant.
    expect(
      (await env.svc.requestAccess(ACCOUNT, id, USER, { path: proj, access: 'read' })).status,
    ).toBe('granted');
    const grants = await env.svc.grants(ACCOUNT, id);
    expect(grants.filter((g) => g.status === 'granted')).toHaveLength(1);
    await env.svc.revokeGrant(ACCOUNT, id, grants[0]!.id);
    await expect(env.svc.listFiles(ACCOUNT, id, USER, proj)).rejects.toThrow(/outside/);
    expect(env.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['device.grant.create', 'device.grant.revoke']),
    );
  });

  it('refuses protected paths on the Hub before the device sees them', async () => {
    const id = fake.deviceId!;
    await env.svc.requestAccess(ACCOUNT, id, USER, { path: proj, access: 'write' });
    const before = fake.calls.length;
    for (const p of [
      join(proj, '.git', 'config'),
      join(proj, '.ssh', 'id_rsa'),
      join(proj, '.bashrc'),
    ]) {
      const err = await rejects(
        env.svc.stage(ACCOUNT, id, USER, { path: p, contentBase64: 'eA==' }),
      );
      expect(err.details).toMatchObject({ reason: 'protected_path' });
    }
    expect(fake.calls.length).toBe(before);
    await expect(
      env.svc.grant(ACCOUNT, id, {
        grantee: AGENT,
        kind: 'folder',
        target: join(proj, '.ssh'),
        access: 'read',
      }),
    ).rejects.toThrow(/protected/);
    await expect(
      env.svc.stage(ACCOUNT, id, USER, { path: 'relative/x', contentBase64: 'eA==' }),
    ).rejects.toThrow(/absolute/);
  });

  it('novad protects the same locations as the policy engine (docs/12 §7.2)', () => {
    const rs = readFileSync(
      join(import.meta.dirname, '../../../services/novad/src/paths.rs'),
      'utf8',
    );
    const list = (name: string): string[][] => {
      const body = new RegExp(
        `pub const ${name}: &\\[&\\[&str\\]\\] = &\\[([\\s\\S]*?)\\n\\];`,
      ).exec(rs)?.[1];
      expect(body, name).toBeDefined();
      return [...body!.matchAll(/&\[([^\]]*)\]/g)].map((m) =>
        [...m[1]!.matchAll(/"([^"]*)"/g)].map((s) => s[1]!),
      );
    };
    expect(list('CREDENTIAL_LOCATIONS')).toEqual(CREDENTIAL_LOCATIONS.map((l) => [...l]));
    expect(list('READ_ONLY_LOCATIONS')).toEqual(READ_ONLY_LOCATIONS.map((l) => [...l]));
  });
});

describe('staged writes', () => {
  beforeEach(async () => {
    await env.svc.requestAccess(ACCOUNT, fake.deviceId!, USER, { path: proj, access: 'write' });
  });

  it('stages with a diff, writes nothing until commit, then commits once', async () => {
    const target = join(proj, 'src', 'a.txt');
    const s = await env.svc.stage(ACCOUNT, fake.deviceId!, USER, {
      path: target,
      contentBase64: Buffer.from('one\n2\nthree\n').toString('base64'),
      sessionRef: 'thread:t1',
    });
    expect(s).toMatchObject({
      status: 'staged',
      additions: 1,
      deletions: 1,
      binary: false,
      sessionRef: 'thread:t1',
    });
    expect(s.diff).toContain('-two\n+2');
    expect(readFileSync(target, 'utf8')).toBe('one\ntwo\nthree\n');
    expect(
      (await env.svc.stagedWrites(ACCOUNT, fake.deviceId!, { status: 'staged' })).map((x) => x.id),
    ).toEqual([s.id]);
    const c = await env.svc.commit(ACCOUNT, s.id);
    expect(c.status).toBe('committed');
    expect(readFileSync(target, 'utf8')).toBe('one\n2\nthree\n');
    await expect(env.svc.commit(ACCOUNT, s.id)).rejects.toThrow(/committed/);
    const names = env.events.names();
    expect(names).toEqual(
      expect.arrayContaining(['device.write.staged', 'device.write.committed']),
    );
    expect(
      env.audit.filter((a) => a.action.startsWith('device.write')).map((a) => a.action),
    ).toEqual(['device.write.stage', 'device.write.commit']);
  });

  it('a target changed after staging is a conflict and nothing is written', async () => {
    const target = join(proj, 'src', 'a.txt');
    const s = await env.svc.stage(ACCOUNT, fake.deviceId!, USER, {
      path: target,
      contentBase64: Buffer.from('mine\n').toString('base64'),
    });
    writeFileSync(target, 'theirs\n');
    const err = await rejects(env.svc.commit(ACCOUNT, s.id));
    expect(err.code).toBe('conflict');
    expect(readFileSync(target, 'utf8')).toBe('theirs\n');
    expect((await env.svc.stagedWrite(ACCOUNT, s.id)).status).toBe('conflict');
    expect(env.events.names()).toContain('device.write.conflict');
  });

  it('discards, and expires stages after a day', async () => {
    const a = await env.svc.stage(ACCOUNT, fake.deviceId!, USER, {
      path: join(proj, 'n.txt'),
      contentBase64: 'aGk=',
    });
    expect((await env.svc.discard(ACCOUNT, a.id)).status).toBe('discarded');
    await expect(env.svc.discard(ACCOUNT, a.id)).rejects.toThrow(/discarded/);
    const b = await env.svc.stage(ACCOUNT, fake.deviceId!, USER, {
      path: join(proj, 'm.txt'),
      contentBase64: 'aGk=',
    });
    env.clock.now += 24 * 3_600_000 + 1;
    await fake.heartbeat().catch(() => undefined);
    await env.svc.sweep();
    expect((await env.svc.stagedWrite(ACCOUNT, b.id)).status).toBe('expired');
    await expect(env.svc.stagedWrite(ACCOUNT, 'missing')).rejects.toThrow(/not found/);
  });
});

describe('folder-access requests (FR-210)', () => {
  it('a write outside the grants files a request with a Hub approval card', async () => {
    const id = fake.deviceId!;
    const err = await rejects(
      env.svc.stage(
        ACCOUNT,
        id,
        AGENT,
        { path: join(proj, 'src', 'a.txt'), contentBase64: 'eA==' },
        { agentId: 'agent-1', actor: 'agent:agent-1' },
      ),
    );
    expect(err.code).toBe('policy_denied');
    expect(err.details).toMatchObject({
      reason: 'folder_access_required',
      path: join(proj, 'src'),
      access: 'write',
    });
    const approvalId = err.details!.approvalId as string;
    const card = env.db.raw
      .prepare('SELECT * FROM approval WHERE id = ?')
      .get(approvalId) as Record<string, unknown>;
    expect(card).toMatchObject({
      status: 'pending',
      tool_name: 'device.fs.request_access',
      agent_id: 'agent-1',
      tier: 'confirm_at_action',
    });
    expect(String(card.requested_action)).toContain(
      `agent agent-1 read and change ${join(proj, 'src')}`,
    );
    expect(env.events.names()).toEqual(
      expect.arrayContaining(['approval.requested', 'device.access.requested']),
    );
    const req = await env.svc.accessRequest(ACCOUNT, err.details!.requestId as string);
    expect(req).toMatchObject({ status: 'pending', approvalId, grantee: AGENT });
    // Still pending: the same write is refused again with the same request.
    const again = await rejects(
      env.svc.stage(ACCOUNT, id, AGENT, {
        path: join(proj, 'src', 'a.txt'),
        contentBase64: 'eA==',
      }),
    );
    expect(again.details!.requestId).toBe(req.id);
    await decide(approvalId, 'allow_once');
    expect((await env.svc.accessRequest(ACCOUNT, req.id)).status).toBe('granted');
    const s = await env.svc.stage(ACCOUNT, id, AGENT, {
      path: join(proj, 'src', 'a.txt'),
      contentBase64: Buffer.from('x\n').toString('base64'),
    });
    await env.svc.commit(ACCOUNT, s.id);
    expect(readFileSync(join(proj, 'src', 'a.txt'), 'utf8')).toBe('x\n');
    expect(
      env.events.events.find((e) => e.name === 'device.access.decided')?.payload,
    ).toMatchObject({ status: 'granted', decidedBy: 'hub' });
  });

  it('a denial on the Hub leaves the folder closed', async () => {
    const r = await env.svc.requestAccess(ACCOUNT, fake.deviceId!, AGENT, {
      path: proj,
      access: 'read',
      reason: 'look around',
    });
    expect(r.status).toBe('pending');
    const card = env.db.raw
      .prepare('SELECT reason FROM approval WHERE id = ?')
      .get(r.approvalId) as { reason: string };
    expect(card.reason).toBe('Requested by agent agent-1: look around');
    await decide(r.approvalId!, 'deny_continue');
    expect((await env.svc.accessRequest(ACCOUNT, r.id)).status).toBe('denied');
    await expect(env.svc.listFiles(ACCOUNT, fake.deviceId!, AGENT, proj)).rejects.toThrow(
      /outside/,
    );
  });

  it('the device can decide first; the heartbeat reports it and closes the card', async () => {
    const r = await env.svc.requestAccess(ACCOUNT, fake.deviceId!, AGENT, {
      path: proj,
      access: 'read',
    });
    const deviceRequest = fake.requests.find((x) => x.status === 'pending')!;
    fake.decideLocally(deviceRequest.id, true);
    await fake.heartbeat();
    expect(await env.svc.accessRequest(ACCOUNT, r.id)).toMatchObject({
      status: 'granted',
      decidedBy: 'device',
    });
    const card = env.db.raw
      .prepare('SELECT status, decision, decided_by FROM approval WHERE id = ?')
      .get(r.approvalId) as Record<string, unknown>;
    expect(card).toMatchObject({
      status: 'decided',
      decision: 'allow_once',
      decided_by: `device:${fake.deviceId!}`,
    });
    expect((await env.svc.listFiles(ACCOUNT, fake.deviceId!, AGENT, proj)).entries.length).toBe(1);
    // A later Hub answer changes nothing.
    await env.svc.onApprovalDecided(ACCOUNT, r.approvalId!, 'deny_continue');
    expect((await env.svc.accessRequest(ACCOUNT, r.id)).status).toBe('granted');
  });

  it('a Hub grant made while the device was away is passed on its next heartbeat', async () => {
    const r = await env.svc.requestAccess(ACCOUNT, fake.deviceId!, AGENT, {
      path: proj,
      access: 'read',
    });
    await fake.close();
    await decide(r.approvalId!, 'allow_once');
    expect((await env.svc.accessRequest(ACCOUNT, r.id)).status).toBe('pending');
    await fake.listen();
    env.db.raw
      .prepare('UPDATE transport_endpoint SET url = ? WHERE device_id = ?')
      .run(fake.endpoint, fake.deviceId);
    await fake.heartbeat();
    for (
      let i = 0;
      i < 50 && (await env.svc.accessRequest(ACCOUNT, r.id)).status === 'pending';
      i++
    )
      await new Promise((res) => setTimeout(res, 10));
    expect((await env.svc.accessRequest(ACCOUNT, r.id)).status).toBe('granted');
  });
});

describe('the connected computer (FR-081)', () => {
  it('one active connection per agent, explicit and revocable', async () => {
    const hooked: string[] = [];
    const off = env.svc.onConnectionChanged((_a, x) => {
      hooked.push(`${x.agentId}:${x.status}`);
      return x.agentId === 'boom' ? Promise.reject(new Error('hook failed')) : Promise.resolve();
    });
    const c = await env.svc.connect(ACCOUNT, {
      agentId: 'agent-1',
      deviceId: fake.deviceId!,
      capabilities: ['files', 'exec'],
    });
    expect(c).toMatchObject({ status: 'active', agentId: 'agent-1', deviceName: fake.name });
    const second = await env.enroll();
    const err = await rejects(
      env.svc.connect(ACCOUNT, {
        agentId: 'agent-1',
        deviceId: second.deviceId!,
        capabilities: ['files'],
      }),
    );
    expect(err.code).toBe('conflict');
    // Re-connecting the same device updates it in place.
    expect(
      (
        await env.svc.connect(ACCOUNT, {
          agentId: 'agent-1',
          deviceId: fake.deviceId!,
          capabilities: ['files'],
        })
      ).id,
    ).toBe(c.id);
    // Grants given to the agent go with the connection.
    await env.svc.grant(ACCOUNT, fake.deviceId!, {
      grantee: AGENT,
      kind: 'folder',
      target: proj,
      access: 'read',
    });
    const replaced = await env.svc.connect(ACCOUNT, {
      agentId: 'agent-1',
      deviceId: second.deviceId!,
      capabilities: ['files'],
      replace: true,
    });
    expect(replaced.deviceId).toBe(second.deviceId);
    expect((await env.svc.connection(ACCOUNT, c.id)).status).toBe('revoked');
    expect(fake.grants.some((g) => g.grantee.kind === 'agent')).toBe(false);
    expect(
      (await env.svc.connections(ACCOUNT, { agentId: 'agent-1' })).map((x) => x.status),
    ).toEqual(['active', 'revoked']);
    await env.svc.disconnect(ACCOUNT, replaced.id);
    expect(await env.svc.activeConnection(ACCOUNT, 'agent-1')).toBeNull();
    expect(
      env.events.events
        .filter((e) => e.name === 'device.connection.changed')
        .map((e) => e.payload.status),
    ).toEqual(['active', 'revoked', 'active', 'revoked']);
    expect(hooked).toEqual([
      'agent-1:active',
      'agent-1:revoked',
      'agent-1:active',
      'agent-1:revoked',
    ]);
    // A failing hook does not fail the connection.
    await env.svc.connect(ACCOUNT, {
      agentId: 'boom',
      deviceId: fake.deviceId!,
      capabilities: ['files'],
    });
    off();
  });

  it('refuses devices below the minimum version, policy-ineligible devices and unknown agents', async () => {
    const old = await env.enroll({ novadVersion: '0.5.0' });
    const err = await rejects(
      env.svc.connect(ACCOUNT, { agentId: 'a2', deviceId: old.deviceId!, capabilities: ['files'] }),
    );
    expect(err.details).toMatchObject({ reason: 'update_required' });
    const noScreen = await rejects(
      env.svc.connect(ACCOUNT, {
        agentId: 'a2',
        deviceId: fake.deviceId!,
        capabilities: ['computer_use'],
      }),
    );
    expect(noScreen.details).toMatchObject({ reason: 'module_missing' });
    await env.svc.update(ACCOUNT, fake.deviceId!, { policy: { routingEligible: false } });
    expect(
      (
        await rejects(
          env.svc.connect(ACCOUNT, {
            agentId: 'a2',
            deviceId: fake.deviceId!,
            capabilities: ['files'],
          }),
        )
      ).details,
    ).toMatchObject({
      reason: 'not_routing_eligible',
    });
    env.svc.useAgents((_a, agentId) => Promise.resolve(agentId === 'known'));
    await expect(
      env.svc.connect(ACCOUNT, {
        agentId: 'ghost',
        deviceId: fake.deviceId!,
        capabilities: ['files'],
      }),
    ).rejects.toThrow(/agent not found/);
  });

  it('serves the agent a local_host Computer over novad', async () => {
    await env.svc.connect(ACCOUNT, {
      agentId: 'agent-1',
      deviceId: fake.deviceId!,
      capabilities: ['files', 'exec'],
    });
    await env.svc.grant(ACCOUNT, fake.deviceId!, {
      grantee: AGENT,
      kind: 'folder',
      target: proj,
      access: 'write',
    });
    const provider = new DeviceComputerProvider(env.svc);
    const computer = await provider.forAgent(ACCOUNT, 'agent-1');
    expect(computer.kind).toBe('local_host');
    expect(await provider.get(ACCOUNT, computer.id)).not.toBeNull();
    expect(await provider.get(ACCOUNT, 'device-connection:missing')).toBeNull();
    // The computers area's local_host row opens to the same device for the connected agent.
    env.db.raw
      .prepare(
        `INSERT INTO computer (id, account_id, kind, provider, device_id, state, created_at, updated_at)
         VALUES ('c1', ?, 'local_host', 'novad', ?, 'stopped', '2026-10-17', '2026-10-17')`,
      )
      .run(ACCOUNT, fake.deviceId);
    const opened = await provider.open({
      accountId: ACCOUNT,
      computerId: 'c1',
      deviceId: fake.deviceId!,
    });
    expect(opened).toMatchObject({ id: 'c1', grantee: AGENT });
    expect(env.svc.computerAgent('c1')).toBeNull();
    expect(
      await provider.open({ accountId: ACCOUNT, computerId: 'c1', deviceId: 'other' }),
    ).toBeNull();
    await expect(provider.forAgent(ACCOUNT, 'nobody')).rejects.toThrow(/no connected computer/);
    expect(new TextDecoder().decode(await computer.fs.read(join(proj, 'src', 'a.txt')))).toBe(
      'one\ntwo\nthree\n',
    );
    await computer.fs.write(join(proj, 'out', 'b.txt'), new TextEncoder().encode('hello\n'), {
      createDirs: true,
    });
    expect(readFileSync(join(proj, 'out', 'b.txt'), 'utf8')).toBe('hello\n');
    expect((await computer.fs.list(proj)).map((e) => e.name)).toEqual(['out', 'src']);
    expect((await computer.fs.stat(join(proj, 'out', 'b.txt'))).kind).toBe('file');
    await computer.fs.move(join(proj, 'out', 'b.txt'), join(proj, 'out', 'c.txt'));
    await computer.fs.delete(join(proj, 'out', 'c.txt'));
    const r = await computer.exec({ cmd: 'make', cwd: proj }, new AbortController().signal);
    expect(r.stdout).toBe('ran make');
    const st = await computer.status();
    expect(st).toMatchObject({ state: 'running', substrate: 'bwrap' });
    expect(await computer.browser()).toBeNull();
    expect(await computer.screen()).toBeNull();
    await expect(computer.snapshot()).rejects.toThrow(/snapshots/);
    await expect(computer.restore({ id: 'x', label: null, createdAt: '' })).rejects.toThrow(
      /snapshots/,
    );
    await computer.stop();
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(computer.exec({ cmd: 'x', cwd: proj }, ac.signal)).rejects.toThrow('stop');
    // A write outside the grants files a request instead of writing.
    const outside = join(env.dir, 'elsewhere');
    mkdirSync(outside);
    const err = await rejects(computer.fs.write(join(outside, 'x.txt'), new Uint8Array([1])));
    expect(err.details).toMatchObject({ reason: 'folder_access_required' });
    expect(env.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['device.exec', 'device.write.commit']),
    );
    expect(env.audit.find((a) => a.action === 'device.exec')?.actor).toBe('agent:agent-1');
  });

  it('refuses commands in quiet hours and without a sandbox on the device', async () => {
    const bare = await env.enroll();
    await env.svc.connect(ACCOUNT, {
      agentId: 'agent-2',
      deviceId: bare.deviceId!,
      capabilities: ['files'],
    });
    await env.svc.grant(ACCOUNT, bare.deviceId!, {
      grantee: { kind: 'agent', id: 'agent-2' },
      kind: 'folder',
      target: proj,
      access: 'read',
    });
    const computer = await new DeviceComputerProvider(env.svc).forAgent(ACCOUNT, 'agent-2');
    const err = await rejects(
      computer.exec({ cmd: 'ls', cwd: proj }, new AbortController().signal),
    );
    expect(err.code).toBe('sandbox_unavailable');
    await env.svc.update(ACCOUNT, bare.deviceId!, { policy: { quietHours: ['00:00-23:59'] } });
    const quiet = await rejects(
      computer.exec({ cmd: 'ls', cwd: proj }, new AbortController().signal),
    );
    expect(quiet.details).toMatchObject({ reason: 'quiet_hours' });
  });
});

describe('Code sessions on a device (FR-062)', () => {
  it('reports health and works under the session’s own grants', async () => {
    const e = deviceEnvironment(env.svc, {
      accountId: ACCOUNT,
      deviceId: fake.deviceId!,
      sessionId: 's1',
    });
    expect((await e.health()).status).toBe('ok');
    await expect(e.computer.fs.list(proj)).rejects.toThrow(/outside/);
    const req = await e.computer.requestAccess(proj, 'write', 'the repo');
    expect(req.status).toBe('pending');
    await decide(req.approvalId!, 'allow_once');
    const staged = await e.computer.stageWrite(
      join(proj, 'src', 'a.txt'),
      new TextEncoder().encode('new\n'),
    );
    expect(staged.diff).toContain('+new');
    await e.computer.discardWrite(staged.id);
    expect(e.grantee).toEqual({ kind: 'session', id: 's1' });
    await env.svc.grant(ACCOUNT, fake.deviceId!, {
      grantee: e.grantee,
      kind: 'mcp',
      target: 'notes',
      access: 'call',
    });
    expect((await e.mcp.list()).servers).toEqual([{ name: 'notes', tools: [{ name: 'search' }] }]);
    const out = (await e.mcp.call('notes', 'search', { q: 'x' })) as {
      untrusted: boolean;
      content: { text: string }[];
    };
    expect(out.untrusted).toBe(true);
    expect(out.content[0]!.text).toContain('"tool":"search"');
    expect(env.audit.map((a) => a.action)).toContain('device.mcp.call');
    const old = await env.enroll({ novadVersion: '0.1.0' });
    const e2 = deviceEnvironment(env.svc, {
      accountId: ACCOUNT,
      deviceId: old.deviceId!,
      sessionId: 's2',
    });
    expect((await e2.health()).status).toBe('down');
    await env.svc.revoke(ACCOUNT, old.deviceId!);
    expect((await e2.health()).detail).toMatch(/revoked/);
  });
});

describe('the code area’s helper connection (FR-062, FR-078)', () => {
  it('runs processes on the device under the user’s grants and reads their output', async () => {
    const provider = deviceEnvProvider(env.svc);
    const conn = (await provider.connect(ACCOUNT, fake.deviceId!, new AbortController().signal))!;
    expect(await conn.hello()).toMatchObject({
      version: '0.6.0',
      platform: 'linux',
      arch: 'x86_64',
      verified: true,
    });
    await expect(conn.spawn({ cmd: 'make', cwd: proj })).rejects.toThrow(/outside/);
    await env.svc.requestAccess(ACCOUNT, fake.deviceId!, USER, { path: proj, access: 'write' });
    expect(await conn.stat(join(proj, 'src'))).toEqual({ kind: 'dir' });
    expect(await conn.stat(join(proj, 'missing'))).toBeNull();
    const { id } = await conn.spawn({ cmd: 'make test', cwd: proj, tag: 's1:t1' });
    let r = await conn.read(id, 0, 0);
    for (let i = 0; i < 50 && r.running; i++) {
      await new Promise((res) => setTimeout(res, 5));
      r = await conn.read(id, 0, 0);
    }
    expect(r).toMatchObject({ running: false, exitCode: 0, data: 'ran /bin/sh' });
    expect(await conn.processes()).toEqual([
      expect.objectContaining({ id, tag: 's1:t1', running: false }),
    ]);
    await conn.write(id, { signal: 'terminate' });
    await expect(conn.wslDistros()).rejects.toThrow(/Windows/);
    await expect(conn.wsl('Ubuntu')).rejects.toThrow(/Windows/);
    expect(conn.closed).toBe(false);
    await conn.close();
    expect(conn.closed).toBe(true);
    expect(env.audit.map((a) => a.action)).toContain('device.exec');
    // An unreachable device has no connection; an old one is not verified.
    env.clock.now += 60_000;
    await env.svc.sweep();
    expect(
      await provider.connect(ACCOUNT, fake.deviceId!, new AbortController().signal),
    ).toBeNull();
    const old = await env.enroll({ novadVersion: '0.1.0' });
    const oldConn = (await provider.connect(ACCOUNT, old.deviceId!, new AbortController().signal))!;
    expect((await oldConn.hello()).verified).toBe(false);
  });
});

describe('the management client', () => {
  it('maps device errors and unreachable devices', async () => {
    expect(
      deviceError(403, {
        error: { code: 'policy_denied', message: 'no', details: { reason: 'x' } },
      }),
    ).toMatchObject({
      code: 'policy_denied',
      details: { reason: 'x' },
    });
    expect(deviceError(500, { error: { code: 'weird', message: 'm' } }).code).toBe('server_error');
    expect(deviceError(401, {}).code).toBe('auth_missing');
    expect(deviceError(413, null).code).toBe('validation');
    const down: DeviceTransport = { post: () => Promise.reject(new Error('ECONNREFUSED')) };
    await expect(
      callDevice(down, 'http://x', 't', '/agent/v1/status', {}, 100),
    ).rejects.toMatchObject({ code: 'node_unavailable' });
    const ok: DeviceTransport = { post: () => Promise.resolve({ status: 200, body: null }) };
    expect(await callDevice(ok, 'http://x/', 't', '/p', {}, 100)).toEqual({});
  });

  it('diffs lines in the fake device like novad', () => {
    const d = fakeDeviceLineDiff('a\nb\nc\n', 'a\nB\nc\nd\n', 'a/f', 'b/f');
    expect(d).toMatchObject({ additions: 2, deletions: 1 });
    expect(d.diff).toContain('@@ -1,3 +1,4 @@');
    expect(fakeDeviceLineDiff('same\n', 'same\n', 'a', 'b').diff).toBe('');
  });
});
