// Terminals (FR-006): lifecycle with a fake sandbox (input, output, resize, exit, the per-account
// limit, idle close, shutdown), refusal without a sandbox, and the real pty relay end to end
// through the container sandbox driving a stand-in container engine on this machine.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, uuidv7 } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  ContainerSandbox,
  MemoryEventSink,
  TerminalManager,
  UnavailableSandbox,
  resizeFrame,
  terminalCommand,
  type AuditRecord,
  type ExecRequest,
  type ExecResult,
  type SandboxClient,
  type TerminalSink,
  type ToolScope,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000d1';
const OTHER = '01920000-0000-7000-8000-0000000000d2';

let dir: string;
let db: NovaDatabase;
let events: MemoryEventSink;
let audit: AuditRecord[];
let threadId: string;

interface FakeSession {
  req: ExecRequest & { onOutput?: (c: string) => void; turnId?: string };
  writes: string[];
  buffered: string;
  exitCode: number | null;
  wake: (() => void) | null;
}

/** A sandbox that records what terminals ask of it; tests drive output and exits. */
class FakeSandbox implements SandboxClient {
  readonly substrate = 'container' as const;
  ok = true;
  /** Stream output through `onOutput` (like the container sandbox) or only through polls. */
  stream = true;
  exitAtOnce: number | null = null;
  readonly sessions = new Map<string, FakeSession>();
  readonly killed: string[] = [];

  available() {
    return Promise.resolve({ ok: this.ok, detail: this.ok ? 'fake' : 'engine stopped' });
  }

  exec(req: ExecRequest): Promise<ExecResult> {
    if (this.exitAtOnce !== null)
      return Promise.resolve({ status: 'exited', exitCode: this.exitAtOnce, output: 'bye\n' });
    const id = uuidv7();
    this.sessions.set(id, { req, writes: [], buffered: '', exitCode: null, wake: null });
    return Promise.resolve({ status: 'running', sessionId: id, output: '' });
  }

  async poll(id: string, yieldMs: number, signal: AbortSignal): Promise<ExecResult> {
    const s = this.sessions.get(id);
    if (!s) throw new NovaError('not_found', 'gone');
    if (!s.buffered && s.exitCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, yieldMs);
        s.wake = () => {
          clearTimeout(t);
          resolve();
        };
        signal.addEventListener('abort', () => s.wake?.(), { once: true });
      });
    }
    const output = s.buffered;
    s.buffered = '';
    if (s.exitCode !== null) {
      this.sessions.delete(id);
      return { status: 'exited', exitCode: s.exitCode, output };
    }
    return { status: 'running', sessionId: id, output };
  }

  write(id: string, input: { text?: string; signal?: 'interrupt' | 'terminate' }): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return Promise.reject(new NovaError('not_found', 'gone'));
    if (input.text !== undefined) s.writes.push(input.text);
    if (input.signal === 'terminate') {
      this.killed.push(id);
      this.sessions.delete(id);
      s.wake?.();
    }
    return Promise.resolve();
  }

  killTurn(turnId: string): Promise<void> {
    for (const [id, s] of this.sessions) if (s.req.turnId === turnId) this.sessions.delete(id);
    return Promise.resolve();
  }

  only(): [string, FakeSession] {
    const all = [...this.sessions.entries()];
    if (all.length !== 1) throw new Error(`expected one session, got ${all.length}`);
    return all[0]!;
  }

  emit(id: string, text: string): void {
    const s = this.sessions.get(id)!;
    if (this.stream) s.req.onOutput?.(text);
    s.buffered += text;
    s.wake?.();
  }

  exit(id: string, code: number): void {
    const s = this.sessions.get(id)!;
    s.exitCode = code;
    s.wake?.();
  }
}

class Screen implements TerminalSink {
  readonly frames: ({ type: 'output'; data: string } | { type: 'exit'; code: number | null })[] =
    [];
  send(f: Screen['frames'][number]): void {
    this.frames.push(f);
  }
  text(): string {
    return this.frames.map((f) => (f.type === 'output' ? f.data : '')).join('');
  }
}

function scope(roots = [join(dir, 'ws'), join(dir, 'repo')]) {
  return (): Promise<ToolScope> =>
    Promise.resolve({
      roots: roots.map((path, i) => ({ path, access: i ? 'read' : 'write', label: `r${i}` })),
      profile: { id: 'workspace', hash: 'h' },
      network: 'off',
      deny: [],
    });
}

function manager(sandbox: SandboxClient | null, opts: { idleMs?: number; max?: number } = {}) {
  return new TerminalManager({
    db,
    sandbox: () => sandbox,
    scope: scope(),
    events,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
    ...(opts.max !== undefined ? { maxPerAccount: opts.max } : {}),
  });
}

async function until(fn: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-term-'));
  mkdirSync(join(dir, 'ws'));
  mkdirSync(join(dir, 'repo'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  events = new MemoryEventSink();
  audit = [];
  const now = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare(
        "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'x', ?, ?)",
      )
      .run(id, now, now);
  threadId = uuidv7();
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, created_at, updated_at) VALUES (?, ?, 'code', ?, ?)",
    )
    .run(threadId, ACCOUNT, now, now);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('terminal lifecycle', () => {
  it('starts a shell in the sandbox with the roots, streams output, input and resizes', async () => {
    const sb = new FakeSandbox();
    const terms = manager(sb);
    const view = await terms.create(ACCOUNT, { threadId, cols: 120, rows: 40 });
    expect(view).toMatchObject({
      threadId,
      cwd: join(dir, 'ws'),
      status: 'running',
      exitCode: null,
    });
    const [sid, s] = sb.only();
    expect(s.req).toMatchObject({
      cwd: join(dir, 'ws'),
      network: 'off',
      yieldMs: 0,
      turnId: `terminal:${view.id}`,
      env: { TERM: 'xterm-256color' },
    });
    expect(s.req.roots.map((r) => r.access)).toEqual(['write', 'read']);
    expect(s.req.cmd).toContain(' 120 40;');
    expect(audit[0]).toMatchObject({
      action: 'terminal.open',
      actor: 'user',
      resource: join(dir, 'ws'),
    });

    sb.emit(sid, 'prompt$ ');
    const screen = new Screen();
    const a = terms.attach(ACCOUNT, view.id, screen);
    expect(screen.text()).toBe('prompt$ ');
    sb.emit(sid, 'more');
    expect(screen.text()).toBe('prompt$ more');
    a.input('ls\r');
    a.input(`evil${resizeFrame(1, 1)}`);
    a.resize(90, 30);
    a.resize(9999, 1);
    await until(() => s.writes.length === 4);
    expect(s.writes).toEqual(['ls\r', 'evilresize;10;5', resizeFrame(90, 30), resizeFrame(500, 5)]);
    expect(terms.list(OTHER)).toEqual([]);
    expect(() => terms.attach(OTHER, view.id, new Screen())).toThrow(/not found/);

    sb.exit(sid, 3);
    await until(() => screen.frames.some((f) => f.type === 'exit'));
    expect(screen.frames.at(-1)).toEqual({ type: 'exit', code: 3 });
    expect(terms.get(ACCOUNT, view.id)).toMatchObject({ status: 'exited', exitCode: 3 });
    expect(events.events.find((e) => e.name === 'terminal.exited')?.payload).toEqual({
      terminalId: view.id,
      code: 3,
    });
    expect(audit.at(-1)).toMatchObject({ action: 'terminal.close', result: 'exited' });
    // Exited terminals keep their output for a late viewer; input is ignored.
    const late = new Screen();
    terms.attach(ACCOUNT, view.id, late).input('x');
    expect(late.frames).toEqual([
      { type: 'output', data: 'prompt$ more' },
      { type: 'exit', code: 3 },
    ]);
    await terms.close(ACCOUNT, view.id);
    expect(terms.list(ACCOUNT)).toEqual([]);
  });

  it('reads output from polls when the sandbox does not stream it', async () => {
    const sb = new FakeSandbox();
    sb.stream = false;
    const terms = manager(sb);
    const view = await terms.create(ACCOUNT, { cols: 80, rows: 24 });
    const [sid] = sb.only();
    const screen = new Screen();
    terms.attach(ACCOUNT, view.id, screen);
    sb.emit(sid, 'polled');
    await until(() => screen.text() === 'polled');
    await terms.closeAll();
  });

  it('opens in a chosen root of the chat, and refuses unknown roots and threads', async () => {
    const sb = new FakeSandbox();
    const terms = manager(sb);
    const v = await terms.create(ACCOUNT, { root: join(dir, 'repo'), cols: 80, rows: 24 });
    expect(v.cwd).toBe(join(dir, 'repo'));
    await expect(
      terms.create(ACCOUNT, { root: '/elsewhere', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(terms.create(OTHER, { threadId, cols: 80, rows: 24 })).rejects.toMatchObject({
      code: 'not_found',
    });
    await terms.closeAll();
  });

  it('allows four running terminals per account', async () => {
    const sb = new FakeSandbox();
    const terms = manager(sb);
    const views = [];
    for (let i = 0; i < 4; i++) views.push(await terms.create(ACCOUNT, { cols: 80, rows: 24 }));
    await expect(terms.create(ACCOUNT, { cols: 80, rows: 24 })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'too_many_terminals' },
    });
    expect((await terms.create(OTHER, { cols: 80, rows: 24 })).status).toBe('running');
    await terms.close(ACCOUNT, views[0]!.id);
    expect(sb.killed).toHaveLength(1);
    expect(audit.at(-1)).toMatchObject({ action: 'terminal.close', result: 'closed' });
    expect((await terms.create(ACCOUNT, { cols: 80, rows: 24 })).status).toBe('running');
    await terms.closeAll();
    expect(sb.sessions.size).toBe(0);
    await expect(terms.create(ACCOUNT, { cols: 80, rows: 24 })).rejects.toMatchObject({
      code: 'sandbox_unavailable',
    });
  });

  it('holds the limit when terminals are opened at the same time', async () => {
    const sb = new FakeSandbox();
    const terms = manager(sb);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => terms.create(ACCOUNT, { cols: 80, rows: 24 })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    expect(sb.sessions.size).toBe(4);
    await terms.closeAll();
  });

  it('fails closed without a working sandbox', async () => {
    await expect(manager(null).create(ACCOUNT, { cols: 80, rows: 24 })).rejects.toMatchObject({
      code: 'sandbox_unavailable',
    });
    await expect(
      manager(new UnavailableSandbox()).create(ACCOUNT, { cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'sandbox_unavailable' });
    const sb = new FakeSandbox();
    sb.ok = false;
    await expect(manager(sb).create(ACCOUNT, { cols: 80, rows: 24 })).rejects.toThrow(
      /engine stopped/,
    );
  });

  it('records a shell that ends at once', async () => {
    const sb = new FakeSandbox();
    sb.exitAtOnce = 127;
    const terms = manager(sb);
    const v = await terms.create(ACCOUNT, { cols: 80, rows: 24 });
    expect(v).toMatchObject({ status: 'exited', exitCode: 127 });
    const screen = new Screen();
    terms.attach(ACCOUNT, v.id, screen);
    expect(screen.frames).toEqual([
      { type: 'output', data: 'bye\n' },
      { type: 'exit', code: 127 },
    ]);
  });

  it('closes a terminal nobody watches once the idle time passes', async () => {
    const sb = new FakeSandbox();
    const terms = manager(sb, { idleMs: 40 });
    const watched = await terms.create(ACCOUNT, { cols: 80, rows: 24 });
    const detach = terms.attach(ACCOUNT, watched.id, new Screen());
    const unwatched = await terms.create(ACCOUNT, { cols: 80, rows: 24 });
    await until(() => terms.list(ACCOUNT).length === 1);
    expect(terms.list(ACCOUNT)[0]?.id).toBe(watched.id);
    expect(() => terms.get(ACCOUNT, unwatched.id)).toThrow(/not found/);
    detach.detach();
    await until(() => terms.list(ACCOUNT).length === 0);
    expect(sb.sessions.size).toBe(0);
  });

  it('builds a shell command whose relay survives single quoting', () => {
    const cmd = terminalCommand(0, 9999);
    expect(cmd).toContain(' 10 200;');
    const relay = /perl -e '([^']*)'/.exec(cmd);
    expect(relay?.[1]).toContain('stty');
    expect(resizeFrame(Number.NaN, 30)).toBe('\u{10FFFD}resize;100;30\u{10FFFD}');
  });
});

// ---- the real relay, through the container sandbox and a stand-in engine ------------------

function has(cmd: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const relayTools = ['perl', 'script', 'stty', 'pgrep'].every(has);

/**
 * A container engine stand-in: `run` drops the isolation flags and runs the command in the
 * work directory on this machine; `kill` ends the process tree. Only for this test.
 */
function fakeEngine(): string {
  const bin = join(dir, 'engine');
  const pids = join(dir, 'pids');
  mkdirSync(pids);
  writeFileSync(
    bin,
    `#!/bin/sh
killtree() { for c in $(pgrep -P "$1"); do killtree "$c"; done; kill -9 "$1" 2>/dev/null; }
case "$1" in
  version) echo 1.0; exit 0 ;;
  kill)
    shift; [ "$1" = "--signal" ] && shift 2
    [ -f "${pids}/$1" ] && killtree "$(cat "${pids}/$1")"; exit 0 ;;
  run) shift ;;
  *) exit 1 ;;
esac
name=""; workdir="/"
while [ $# -gt 0 ]; do
  case "$1" in
    --rm|-i) shift ;;
    --name) name="$2"; shift 2 ;;
    --workdir) workdir="$2"; shift 2 ;;
    -e) export "$2"; shift 2 ;;
    --user|--cap-drop|--security-opt|--pids-limit|--memory|--cpus|--network|--mount) shift 2 ;;
    *) break ;;
  esac
done
shift
echo $$ > "${pids}/$name"
cd "$workdir" || exit 1
exec "$@"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe.skipIf(!relayTools)('pty relay', () => {
  it('runs an interactive shell with a pty, live resize, job control and the exit code', async () => {
    const sb = new ContainerSandbox({ bin: fakeEngine() });
    const terms = manager(sb);
    const view = await terms.create(ACCOUNT, { cols: 80, rows: 24 });
    const screen = new Screen();
    const t = terms.attach(ACCOUNT, view.id, screen);
    // Quotes split the markers, so the echoed input line never matches them.
    t.input('stty size; tty -s && echo IS-A""-TTY\n');
    await until(
      () => screen.text().includes('24 80') && screen.text().includes('IS-A-TTY'),
      10_000,
    );
    t.resize(132, 40);
    await new Promise((r) => setTimeout(r, 300));
    t.input('stty size; sleep 30 & jobs\n');
    await until(() => screen.text().includes('40 132') && /Running/.test(screen.text()), 10_000);
    t.input('kill %1; exit 7\n');
    await until(() => screen.frames.some((f) => f.type === 'exit'), 10_000);
    expect(screen.frames.at(-1)).toEqual({ type: 'exit', code: 7 });
    expect(terms.get(ACCOUNT, view.id)).toMatchObject({ status: 'exited', exitCode: 7 });
  }, 30_000);

  it('kills the shell when the terminal is closed', async () => {
    const sb = new ContainerSandbox({ bin: fakeEngine() });
    const terms = manager(sb);
    const view = await terms.create(ACCOUNT, { cols: 80, rows: 24 });
    const screen = new Screen();
    const t = terms.attach(ACCOUNT, view.id, screen);
    t.input('echo $$ > shell.pid; echo STAR""TED\n');
    await until(() => screen.text().includes('STARTED'), 10_000);
    const pid = Number(readFileSync(join(dir, 'ws', 'shell.pid'), 'utf8').trim());
    await terms.close(ACCOUNT, view.id);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 10_000);
    expect(screen.frames.at(-1)).toEqual({ type: 'exit', code: null });
  }, 30_000);
});
