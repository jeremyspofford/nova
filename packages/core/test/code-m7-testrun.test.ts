// `test.run` in SSH and device sessions (J9 follow-up, docs/10 §4): the test command is detected
// from the marker files through the session's workspace (its helper), the same transport its file
// and Git operations use, and runs there; a local session reads the Hub's disk as before.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nova/telemetry';
import {
  TRANSPORT_TAG,
  codeTools,
  type SandboxClient,
  type ToolContext,
  type ToolResult,
} from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { FakeHelperConnection, FakeHelperHost } from './code-m6-env.ts';
import { makeCodeM7Env, type CodeM7Env } from './code-m7-env.ts';

// Remote-side work spawns many short processes; under a loaded full run they need time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let e: CodeM7Env;
let device: FakeHelperHost | null = null;
afterEach(async () => {
  device?.stop();
  device = null;
  await e.close();
});

async function testRun(threadId: string, sandbox: SandboxClient): Promise<ToolResult> {
  const tool = codeTools(e.svc).find((t) => t.descriptor.name === 'test.run')!;
  const ctx: ToolContext = {
    accountId: ACCOUNT,
    threadId,
    turnId: 'turn-t',
    callId: 'call-t',
    projectId: null,
    origin: 'model',
    profile: { id: 'workspace', hash: 'h' },
    roots: [],
    sandbox,
    signal: AbortSignal.timeout(50_000),
    log: new Logger({ module: 'test', sinks: [] }),
  };
  return tool.handler({}, ctx);
}

function project(dir: string, script: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: script } }));
  return dir;
}

/** The helper's own runs that read a marker file (the detection went through the transport). */
function markerReads(host: FakeHelperHost, folder: string): number {
  return [...host.procs.values()].filter(
    (p) => p.tag === TRANSPORT_TAG && p.cmd.includes(join(folder, 'package.json')),
  ).length;
}

describe('test.run on another machine', () => {
  it('detects and runs the test command of an SSH session through its helper', async () => {
    e = await makeCodeM7Env();
    const box = project(join(e.ssh.host.home!, 'box'), 'echo ssh-tests-ran');
    const s = await e.svc.create(ACCOUNT, { folder: box, environmentId: await e.sshEnv() });
    const r = await testRun(s.threadId, e.svc.sandboxForThread(ACCOUNT, s.threadId)!);
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    expect(r.ok && r.meta).toMatchObject({ command: 'npm test', status: 'passed' });
    expect(markerReads(e.ssh.host, box)).toBeGreaterThan(0);
  });

  it('detects and runs the test command of a device session through its helper', async () => {
    e = await makeCodeM7Env();
    const host = new FakeHelperHost();
    device = host;
    host.home = join(e.dir, 'device-home');
    mkdirSync(host.home, { recursive: true });
    e.svc.envs.useDevices({ connect: () => Promise.resolve(new FakeHelperConnection(host)) });
    const now = new Date().toISOString();
    e.db.raw
      .prepare(
        `INSERT INTO device (id, account_id, name, kind, platform, cert_fingerprint, public_key,
           roles, status, created_at, updated_at)
         VALUES ('dev-t', ?, 'Laptop', 'client', 'linux', 'fp-t', 'pk', '[]', 'active', ?, ?)`,
      )
      .run(ACCOUNT, now, now);
    const env = await e.svc.envs.create(ACCOUNT, {
      kind: 'device',
      label: 'laptop',
      connection: { deviceId: 'dev-t' },
    });
    const folder = project(join(host.home, 'proj'), 'echo device-tests-ran');
    const s = await e.svc.create(ACCOUNT, { folder, environmentId: env.id });
    const r = await testRun(s.threadId, e.svc.sandboxForThread(ACCOUNT, s.threadId)!);
    expect(r.ok && r.meta).toMatchObject({ command: 'npm test', status: 'passed' });
    expect(markerReads(host, folder)).toBeGreaterThan(0);
    // No marker there: the same answer as before, through the helper.
    const empty = join(host.home, 'empty');
    mkdirSync(empty);
    const bare = await e.svc.create(ACCOUNT, { folder: empty, environmentId: env.id });
    const none = await testRun(bare.threadId, e.svc.sandboxForThread(ACCOUNT, bare.threadId)!);
    expect(none.ok ? 'ok' : none.error.code).toBe('not_found');
  });

  it('reads the Hub disk for a local session, as before', async () => {
    e = await makeCodeM7Env();
    project(e.repo, 'echo local-tests-ran');
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    const r = await testRun(s.threadId, e.sandbox.current!);
    expect(r.ok && r.meta).toMatchObject({ command: 'npm test', status: 'passed' });
    expect(markerReads(e.ssh.host, e.repo)).toBe(0);
  });
});
