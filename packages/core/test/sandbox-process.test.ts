// The process engine every child-process substrate shares (docs/11 §3, §8): one-shot runs with
// separate stdout and stderr, stdin, the wall-clock limit and cancellation; sessions that stop
// at the wall clock; the launch plan's note, fd 3 data and cleanup (closing the egress session).
import { describe, expect, it } from 'vitest';
import {
  ProcessSandbox,
  type LaunchPlan,
  type SandboxExecRequest,
} from '../src/tools/sandbox-process.ts';

class Shell extends ProcessSandbox {
  readonly substrate = 'container' as const;
  cleaned = 0;
  readonly extra: Partial<LaunchPlan>;
  constructor(
    extra: Partial<LaunchPlan> = {},
    opts: ConstructorParameters<typeof ProcessSandbox>[0] = {},
  ) {
    super(opts);
    this.extra = extra;
  }
  available() {
    return Promise.resolve({ ok: true, detail: 'sh' });
  }
  protected plan(req: SandboxExecRequest): Promise<LaunchPlan> {
    return Promise.resolve({
      bin: 'sh',
      args: ['-c', req.cmd],
      cleanup: () => Promise.resolve(void this.cleaned++),
      ...this.extra,
    });
  }
}

const req = (cmd: string, over: Partial<SandboxExecRequest> = {}): SandboxExecRequest => ({
  cmd,
  cwd: '/',
  roots: [],
  network: 'off',
  yieldMs: 5_000,
  signal: new AbortController().signal,
  ...over,
});

describe('one-shot runs', () => {
  it('separates stdout and stderr, writes stdin, and cleans up', async () => {
    const sb = new Shell();
    const r = await sb.runOnce(
      { ...req('read x; echo "got $x"; echo oops >&2; exit 4'), stdin: 'hello\n' },
      new AbortController().signal,
    );
    expect(r).toEqual({ exitCode: 4, stdout: 'got hello\n', stderr: 'oops\n', timedOut: false });
    expect(sb.cleaned).toBe(1);
  });

  it('stops at the wall clock and on cancel', async () => {
    const sb = new Shell({}, { wallClockMs: 200 });
    const t0 = Date.now();
    const r = await sb.runOnce(req('sleep 10'), new AbortController().signal);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000);
    const ac = new AbortController();
    const p = new Shell().runOnce(req('sleep 10'), ac.signal);
    setTimeout(() => ac.abort(), 100);
    expect((await p).exitCode).not.toBe(0);
    const pre = new AbortController();
    pre.abort();
    expect((await new Shell().runOnce(req('sleep 10'), pre.signal)).exitCode).not.toBe(0);
  });

  it('passes fd 3 data and shows the plan note first', async () => {
    const sb = new Shell({ fd3: Buffer.from('seccomp-bytes'), note: 'nova: no network: test' });
    const r = await sb.runOnce(req('cat <&3'), new AbortController().signal);
    expect(r.stdout).toBe('nova: no network: test\nseccomp-bytes');
    const s = await sb.exec(req('cat <&3'));
    expect(s).toEqual({
      status: 'exited',
      exitCode: 0,
      output: 'nova: no network: test\nseccomp-bytes',
    });
  });

  it('caps very large output', async () => {
    const sb = new Shell({}, { outputLimit: 100 });
    const r = await sb.runOnce(
      req('i=0; while [ $i -lt 100 ]; do echo xxxxxxxxxx; i=$((i+1)); done'),
      new AbortController().signal,
    );
    expect(r.stdout).toContain('[output truncated]');
    expect(r.stdout.length).toBeLessThan(400);
  });
});

describe('sessions', () => {
  it('stop at the wall clock with a note', async () => {
    const sb = new Shell();
    const r = await sb.exec(req('sleep 10', { timeoutMs: 150 }));
    expect(r.status).toBe('exited');
    expect(r.output).toContain('wall-clock limit');
    expect(sb.cleaned).toBe(1);
  });
});
