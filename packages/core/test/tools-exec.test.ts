// Exec tools and sandboxes (FR-184, FR-190, docs/12 §7): yield and sessions, output redaction
// and head/tail caps, session ownership, failing closed without a sandbox, and the container
// substrate driven through a stand-in for the docker CLI (no container engine needed).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Logger } from '@nova/telemetry';
import {
  ContainerSandbox,
  UnavailableSandbox,
  detectSandbox,
  execTools,
  findOnPath,
  type BuiltinContext,
  type ExecRequest,
  type ExecResult,
  type SandboxClient,
  type ToolResult,
  type ToolRoot,
} from '../src/index.ts';

let dir: string;
let work: string;
let roots: ToolRoot[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-exec-'));
  work = join(dir, 'work');
  mkdirSync(work);
  roots = [{ path: work, access: 'write', label: 'Workspace' }];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(sandbox: SandboxClient, extra: Partial<BuiltinContext> = {}): BuiltinContext {
  return {
    accountId: 'a',
    threadId: 't',
    turnId: 'turn-1',
    callId: 'c',
    projectId: null,
    origin: 'model',
    profile: { id: 'workspace', hash: 'h' },
    roots,
    sandbox,
    signal: new AbortController().signal,
    log: new Logger({ module: 'test', sinks: [] }),
    ...extra,
  };
}
const text = (r: ToolResult) =>
  r.ok ? r.content.map((p) => (p.type === 'text' ? p.text : '')).join('') : '';

/** A scripted sandbox that records what it was asked. */
function fakeSandbox(results: ExecResult[]) {
  const execs: (ExecRequest & { turnId?: string })[] = [];
  const polls: string[] = [];
  const writes: { id: string; input: unknown }[] = [];
  const sb: SandboxClient & { execs: typeof execs; polls: string[]; writes: typeof writes } = {
    substrate: 'container',
    execs,
    polls,
    writes,
    available: () => Promise.resolve({ ok: true, detail: 'fake' }),
    exec: (req) => {
      execs.push(req);
      (req as { onOutput?: (c: string) => void }).onOutput?.(
        'token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV\n',
      );
      return Promise.resolve(results.shift()!);
    },
    poll: (id) => {
      polls.push(id);
      return Promise.resolve(results.shift()!);
    },
    write: (id, input) => {
      writes.push({ id, input });
      return Promise.resolve();
    },
    killTurn: () => Promise.resolve(),
  };
  return sb;
}

const tool = (name: string) => execTools().find((t) => t.descriptor.name === name)!;

describe('exec tools', () => {
  it('runs a command in the workspace and returns the exit code and redacted output', async () => {
    const sb = fakeSandbox([
      { status: 'exited', exitCode: 3, output: 'ok\nAPI_KEY=supersecretvalue123\n' },
    ]);
    const progress: string[] = [];
    const r = await tool('exec.run').handler(
      { cmd: 'make test', yieldMs: 500 },
      ctx(sb, {
        progress: (c) => progress.push(c),
        extras: {
          messageId: null,
          network: 'allowlist',
          deny: [],
          cite: () => [],
          searchTools: () => [],
        },
      }),
    );
    expect(text(r)).toBe('Exit code 3\nok\nAPI_KEY=[REDACTED]\n');
    expect(r.ok && r.meta).toMatchObject({ status: 'exited', exitCode: 3 });
    expect(sb.execs[0]).toMatchObject({
      cmd: 'make test',
      cwd: work,
      roots,
      network: 'allowlist',
      yieldMs: 500,
      turnId: 'turn-1',
    });
    expect(progress.join('')).not.toContain('sk-ant-api03');
  });

  it('caps long output keeping the head and the tail', async () => {
    const out = `HEAD${'x'.repeat(10_000)}TAIL`;
    const sb = fakeSandbox([{ status: 'exited', exitCode: 0, output: out }]);
    const r = await tool('exec.run').handler({ cmd: 'yes', maxOutputTokens: 500 }, ctx(sb));
    const t = text(r);
    expect(t.startsWith('Exit code 0\nHEAD')).toBe(true);
    expect(t.endsWith('TAIL')).toBe(true);
    expect(t).toContain('characters omitted');
    expect(t.length).toBeLessThan(2_100);
  });

  it('returns a session for a running command that only its turn can poll and drive', async () => {
    const sb = fakeSandbox([
      { status: 'running', sessionId: 's1', output: 'started\n' },
      { status: 'running', sessionId: 's1', output: 'more\n' },
      { status: 'exited', exitCode: 0, output: 'done\n' },
    ]);
    const run = await tool('exec.run').handler({ cmd: 'serve' }, ctx(sb));
    expect(text(run)).toContain('Still running (session s1)');
    expect(text(run)).toContain('started');
    const other = await tool('exec.poll').handler(
      { sessionId: 's1' },
      ctx(sb, { turnId: 'turn-2' }),
    );
    expect(other).toMatchObject({ ok: false, error: { code: 'not_found' } });
    const tools = execTools();
    // Ownership lives with the tool set the session was started from.
    const run2 = await tools[0]!.handler(
      { cmd: 'serve' },
      ctx(fakeSandbox([{ status: 'running', sessionId: 's9', output: '' }])),
    );
    expect(text(run2)).toContain('session s9');
    const w = await tools[2]!.handler({ sessionId: 's9', text: 'q\n' }, ctx(sb));
    expect(text(w)).toContain('more');
    expect(sb.writes).toEqual([{ id: 's9', input: { text: 'q\n' } }]);
    const end = await tools[1]!.handler({ sessionId: 's9', yieldMs: 10 }, ctx(sb));
    expect(text(end)).toBe('Exit code 0\ndone\n');
    // Exited sessions are forgotten.
    expect(await tools[1]!.handler({ sessionId: 's9' }, ctx(sb))).toMatchObject({ ok: false });
  });

  it('terminates a session', async () => {
    const sb = fakeSandbox([{ status: 'running', sessionId: 's2', output: '' }]);
    const tools = execTools();
    await tools[0]!.handler({ cmd: 'sleep 99' }, ctx(sb));
    const r = await tools[2]!.handler({ sessionId: 's2', signal: 'terminate' }, ctx(sb));
    expect(text(r)).toBe('Terminated session s2.');
    expect(sb.writes[0]!.input).toEqual({ signal: 'terminate' });
  });

  it('fails closed with sandbox_unavailable when there is no sandbox', async () => {
    const sb = new UnavailableSandbox();
    for (const [name, args] of [
      ['exec.run', { cmd: 'ls' }],
      ['exec.poll', { sessionId: 'x' }],
      ['exec.write', { sessionId: 'x', text: 'y' }],
    ] as const) {
      const r = await tool(name).handler(args, ctx(sb));
      expect(r).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
      expect(r.ok ? '' : r.error.message).toContain('install Docker or Podman');
    }
    await expect(sb.exec()).rejects.toMatchObject({ code: 'sandbox_unavailable' });
    await expect(sb.poll()).rejects.toMatchObject({ code: 'sandbox_unavailable' });
    await expect(sb.write()).rejects.toMatchObject({ code: 'sandbox_unavailable' });
    await expect(sb.killTurn()).resolves.toBeUndefined();
  });

  it('refuses a working folder outside the roots', async () => {
    const sb = fakeSandbox([]);
    const r = await tool('exec.run').handler({ cmd: 'ls', cwd: '/etc' }, ctx(sb));
    expect(r).toMatchObject({ ok: false, error: { code: 'path_denied' } });
    expect(sb.execs).toHaveLength(0);
    expect(tool('exec.run').resource!({ cmd: 'ls' }, ctx(sb))).toEqual({
      kind: 'path',
      value: work,
    });
  });
});

// ---- the container substrate ------------------------------------------------------------------

const FAKE_DOCKER = `#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const state = process.env.FAKE_DOCKER_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'calls.log'), JSON.stringify(args) + '\\n');
if (args[0] === 'version') {
  if (fs.existsSync(path.join(state, 'down'))) process.exit(1);
  console.log('99.1');
  process.exit(0);
}
if (args[0] === 'kill') {
  const name = args[args.length - 1];
  try {
    const pid = Number(fs.readFileSync(path.join(state, name), 'utf8'));
    process.kill(pid, args.includes('INT') ? 'SIGINT' : 'SIGKILL');
  } catch {}
  process.exit(0);
}
if (args[0] === 'run') {
  const name = args[args.indexOf('--name') + 1];
  const cwd = args[args.indexOf('--workdir') + 1];
  const child = spawn('sh', ['-c', args[args.length - 1]], { cwd, stdio: 'inherit' });
  fs.writeFileSync(path.join(state, name), String(child.pid));
  child.on('exit', (code) => process.exit(code === null ? 137 : code));
}
`;

describe('ContainerSandbox (through a stand-in docker CLI)', () => {
  let bin: string;
  let state: string;
  let binDir: string;
  const prevState = process.env.FAKE_DOCKER_STATE;
  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'nova-fake-docker-'));
    bin = join(binDir, 'docker');
    writeFileSync(bin, FAKE_DOCKER);
    chmodSync(bin, 0o755);
  });
  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
    if (prevState === undefined) delete process.env.FAKE_DOCKER_STATE;
    else process.env.FAKE_DOCKER_STATE = prevState;
  });
  beforeEach(() => {
    state = join(dir, 'state');
    mkdirSync(state);
    process.env.FAKE_DOCKER_STATE = state;
  });
  const calls = () =>
    readFileSync(join(state, 'calls.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
  const req = (cmd: string, yieldMs: number, extra: Partial<ExecRequest> = {}) => ({
    cmd,
    cwd: work,
    roots: [...roots, { path: dir, access: 'read' as const, label: 'all' }],
    network: 'off' as const,
    yieldMs,
    signal: new AbortController().signal,
    ...extra,
  });

  it('reports whether the engine answers', async () => {
    const sb = new ContainerSandbox({ bin });
    expect(await sb.available()).toEqual({
      ok: true,
      detail: `${bin} 99.1, image debian:stable-slim`,
    });
    writeFileSync(join(state, 'down'), '');
    expect((await new ContainerSandbox({ bin }).available()).ok).toBe(false);
  });

  it('runs isolated: no network, a non-root user, no capabilities, read-only mounts', async () => {
    const sb = new ContainerSandbox({ bin, image: 'img:1', user: '1000:1000' });
    const r = await sb.exec({ ...req('echo hi; pwd', 5_000), turnId: 'T' });
    expect(r).toEqual({ status: 'exited', exitCode: 0, output: `hi\n${work}\n` });
    const run = calls().find((c) => c[0] === 'run')!;
    expect(run).toEqual(
      expect.arrayContaining([
        '--rm',
        '--network',
        'none',
        '--user',
        '1000:1000',
        '--cap-drop',
        'ALL',
      ]),
    );
    expect(run).toContain('no-new-privileges');
    expect(run).toContain(`type=bind,source=${work},target=${work}`);
    expect(run).toContain(`type=bind,source=${dir},target=${dir},readonly`);
    expect(run.slice(-4)).toEqual(['img:1', 'sh', '-c', 'echo hi; pwd']);
    // An allowlist cannot be enforced yet (no egress proxy): it fails closed unless opened.
    const closed = new ContainerSandbox({ bin }).runArgs(
      req('x', 0, { network: 'allowlist' }),
      'n',
    );
    expect(closed).toContain('none');
    const open = new ContainerSandbox({ bin, allowedNetwork: 'open' }).runArgs(
      req('x', 0, { network: 'allowlist' }),
      'n',
    );
    expect(open).not.toContain('none');
    const off = new ContainerSandbox({ bin, allowedNetwork: 'open' }).runArgs(req('x', 0), 'n');
    expect(off).toContain('none');
    expect(() =>
      sb.runArgs(req('x', 0, { roots: [{ path: '/a,b', access: 'read', label: 'x' }] }), 'n'),
    ).toThrow('commas');
  });

  it('returns a session after the yield, streams to poll, and accepts input', async () => {
    const sb = new ContainerSandbox({ bin });
    const out: string[] = [];
    const r = await sb.exec({
      ...req('echo start; read line; echo "got $line"', 300),
      turnId: 'T',
      onOutput: (c) => out.push(c),
    });
    expect(r).toMatchObject({ status: 'running', output: 'start\n' });
    const id = (r as { sessionId: string }).sessionId;
    expect(sb.sessions('T')).toEqual([id]);
    await sb.write(id, { text: 'hello\n' });
    const done = await sb.poll(id, 5_000, new AbortController().signal);
    expect(done).toEqual({ status: 'exited', exitCode: 0, output: 'got hello\n' });
    expect(out.join('')).toContain('got hello');
    expect(sb.sessions()).toEqual([]);
    await expect(sb.poll(id, 10, new AbortController().signal)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(sb.write(id, { text: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('kills a turn’s sessions and limits open sessions per turn', async () => {
    const sb = new ContainerSandbox({ bin, maxSessionsPerTurn: 2 });
    await sb.exec({ ...req('sleep 30', 50), turnId: 'T' });
    await sb.exec({ ...req('sleep 30', 50), turnId: 'T' });
    await expect(sb.exec({ ...req('sleep 30', 50), turnId: 'T' })).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'too_many_sessions' },
    });
    const other = await sb.exec({ ...req('sleep 30', 50), turnId: 'U' });
    expect(other.status).toBe('running');
    await sb.killTurn('T');
    expect(sb.sessions('T')).toEqual([]);
    expect(sb.sessions('U')).toHaveLength(1);
    expect(calls().filter((c) => c[0] === 'kill')).toHaveLength(2);
    await sb.killAll();
    expect(sb.sessions()).toEqual([]);
  });

  it('interrupts a session and keeps the head and tail of huge output', async () => {
    const sb = new ContainerSandbox({ bin, outputLimit: 1000 });
    const r = await sb.exec({
      ...req("printf 'A%.0s' $(seq 1 3000); printf END", 5_000),
      turnId: 'T',
    });
    expect(r.status).toBe('exited');
    expect(r.output).toContain('characters of output dropped');
    expect(r.output.endsWith('END')).toBe(true);
    const s = await sb.exec({ ...req('sleep 30', 50), turnId: 'T' });
    const id = (s as { sessionId: string }).sessionId;
    await sb.write(id, { signal: 'interrupt' });
    expect(calls().some((c) => c[0] === 'kill' && c.includes('INT'))).toBe(true);
    await sb.write(id, { signal: 'terminate' });
    expect(sb.sessions()).toEqual([]);
  });

  it('is found on PATH by detectSandbox; without an engine commands are unavailable', async () => {
    const found = detectSandbox({ env: { PATH: binDir } });
    expect(found).toBeInstanceOf(ContainerSandbox);
    expect(findOnPath('docker', { PATH: `/nonexistent:${binDir}` })).toBe(bin);
    const none = detectSandbox({ env: { PATH: '/nonexistent' } });
    expect(none).toBeInstanceOf(UnavailableSandbox);
    expect((await none.available()).ok).toBe(false);
    const off = detectSandbox({ mode: 'off', env: { PATH: binDir } });
    expect((await off.available()).detail).toContain('turned off');
    expect(detectSandbox({ mode: 'podman', env: { PATH: binDir } })).toBeInstanceOf(
      UnavailableSandbox,
    );
  });
});
