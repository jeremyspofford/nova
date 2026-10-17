// Integrated terminals (FR-006). A terminal is a shell inside the sandbox, never on the Hub
// itself (docs/12 §7: unsandboxed execution is never a fallback): the container substrate starts
// a container with the thread's roots mounted per access and runs a pseudo-terminal in it with
// `script`, so prompts, line editing and job control work without a native pty module. A small
// Perl relay (Perl is part of every Debian-based image) separates resize frames from keystrokes
// and applies them with `stty` on the pty, which sends SIGWINCH to the foreground program. At
// most 4 run per account; each is killed when it is closed, when nobody has watched it for a
// while, and at shutdown. Opening and closing one is audited; `terminal.exited` is announced.
import { NovaError, uuidv7, type TerminalView } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { ExecRequestExtras } from '../tools/sandbox.ts';
import type { ToolRuntimeOptions } from '../tools/runtime.ts';
import type { AuditSink, ExecRequest, ExecResult, SandboxClient } from '../tools/types.ts';

export const MAX_TERMINALS_PER_ACCOUNT = 4;
/** Output kept for a reconnecting viewer. */
export const TERMINAL_SCROLLBACK_CHARS = 256 * 1024;
/** A terminal nobody watches for this long is closed. */
export const TERMINAL_IDLE_MS = 15 * 60_000;
const EXITED_KEPT = 8;

/** Starts and ends a resize frame; a private-use character no keyboard produces. */
const FRAME = '\u{10FFFD}';

// No single quotes: the program is passed to `perl -e '...'` inside `sh -c`.
const RELAY = String.raw`use strict; use warnings; use POSIX ();
my ($cols, $rows) = map { int } @ARGV;
$SIG{PIPE} = "IGNORE";
my $ttyf = "/tmp/.nova-tty-$$";
my $sh = "stty cols $cols rows $rows 2>/dev/null; tty > $ttyf 2>/dev/null; if command -v bash >/dev/null 2>&1; then exec bash -i; fi; exec sh -i";
pipe(my $r, my $w) or die "pipe: $!";
my $pid = fork() // die "fork: $!";
if ($pid == 0) { close $w; POSIX::dup2(fileno($r), 0); close $r; exec("script", "-qefc", $sh, "/dev/null") or POSIX::_exit(127); }
close $r;
$SIG{CHLD} = sub { if (waitpid($pid, POSIX::WNOHANG()) == $pid) { my $c = $? >> 8; unlink $ttyf; POSIX::_exit($c); } };
my $pre = "\xF4\x8F\xBF\xBDresize;"; my $end = "\xF4\x8F\xBF\xBD"; my $buf = "";
while (1) {
  my $n = sysread(STDIN, my $chunk, 65536);
  if (!defined $n) { next if $!{EINTR}; last; }
  last if $n == 0;
  $buf .= $chunk;
  while (length $buf) {
    my $i = index($buf, $pre);
    if ($i < 0) {
      my $k = 0;
      for my $l (reverse 1 .. length($pre) - 1) { if (length($buf) >= $l && substr($buf, -$l) eq substr($pre, 0, $l)) { $k = $l; last; } }
      syswrite($w, substr($buf, 0, length($buf) - $k)); $buf = substr($buf, length($buf) - $k); last;
    }
    syswrite($w, substr($buf, 0, $i)) if $i > 0;
    my $j = index($buf, $end, $i + length $pre);
    if ($j < 0) { if (length($buf) - $i > 64) { syswrite($w, substr($buf, $i)); $buf = ""; } else { $buf = substr($buf, $i); } last; }
    my $arg = substr($buf, $i + length $pre, $j - $i - length $pre);
    $buf = substr($buf, $j + length $end);
    if ($arg =~ /^(\d{1,4});(\d{1,4})$/) { my ($c, $h) = ($1, $2); if (open(my $f, "<", $ttyf)) { my $t = <$f> // ""; close $f; chomp $t; system("stty", "-F", $t, "cols", $c, "rows", $h) if $t =~ m{^/dev/}; } }
  }
}
close $w; waitpid($pid, 0); unlink $ttyf; exit($? >> 8);`;

/**
 * The command a terminal runs in the sandbox (`sh -c`): the relay and a pty when Perl and
 * `script` exist, else a pty without live resizing, else a plain interactive shell.
 */
export function terminalCommand(cols: number, rows: number): string {
  const c = clampCols(cols);
  const r = clampRows(rows);
  const shell = 'if command -v bash >/dev/null 2>&1; then exec bash -i; fi; exec sh -i';
  return [
    `if command -v perl >/dev/null 2>&1 && command -v script >/dev/null 2>&1; then exec perl -e '${RELAY}' ${c} ${r}; fi`,
    `if command -v script >/dev/null 2>&1; then exec script -qefc "stty cols ${c} rows ${r} 2>/dev/null; ${shell}" /dev/null; fi`,
    shell,
  ].join('\n');
}

/** The frame that asks the relay to resize the pty. */
export function resizeFrame(cols: number, rows: number): string {
  return `${FRAME}resize;${clampCols(cols)};${clampRows(rows)}${FRAME}`;
}

function clampCols(n: number): number {
  return Math.min(500, Math.max(10, Math.floor(Number.isFinite(n) ? n : 100)));
}

function clampRows(n: number): number {
  return Math.min(200, Math.max(5, Math.floor(Number.isFinite(n) ? n : 30)));
}

/** A viewer of a terminal (a WebSocket). */
export interface TerminalSink {
  send(frame: { type: 'output'; data: string } | { type: 'exit'; code: number | null }): void;
}

export interface TerminalAttachment {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

export interface TerminalManagerOptions {
  db: NovaDatabase;
  /** The sandbox in use, or null without one (terminals then fail with sandbox_unavailable). */
  sandbox: () => SandboxClient | null;
  /** Roots of a thread or project, project folders included. */
  scope: ToolRuntimeOptions['scope'];
  events: EventSink;
  audit: AuditSink;
  log?: Logger;
  maxPerAccount?: number;
  idleMs?: number;
  scrollbackChars?: number;
  now?: () => Date;
}

export interface CreateTerminalInput {
  /** A root of the thread (default: its first root, the workspace). */
  root?: string | undefined;
  threadId?: string | undefined;
  cols: number;
  rows: number;
}

interface Terminal {
  id: string;
  accountId: string;
  threadId: string | null;
  cwd: string;
  createdAt: string;
  status: 'starting' | 'running' | 'exited';
  exitCode: number | null;
  sandbox: SandboxClient;
  sessionId: string | null;
  /** The sandbox streams output itself (else it arrives with each poll). */
  streamed: boolean;
  scrollback: string;
  sinks: Set<TerminalSink>;
  abort: AbortController;
  idle: ReturnType<typeof setTimeout> | null;
  audited: boolean;
}

export class TerminalManager {
  readonly #o: TerminalManagerOptions;
  readonly #log: Logger;
  readonly #max: number;
  readonly #idleMs: number;
  readonly #keep: number;
  readonly #terms = new Map<string, Terminal>();
  /** Terminals being started per account, so concurrent requests cannot pass the limit. */
  readonly #starting = new Map<string, number>();
  #closed = false;

  constructor(opts: TerminalManagerOptions) {
    this.#o = opts;
    this.#log = opts.log ?? new Logger({ module: 'core.terminals', sinks: [] });
    this.#max = opts.maxPerAccount ?? MAX_TERMINALS_PER_ACCOUNT;
    this.#idleMs = opts.idleMs ?? TERMINAL_IDLE_MS;
    this.#keep = opts.scrollbackChars ?? TERMINAL_SCROLLBACK_CHARS;
  }

  list(accountId: string): TerminalView[] {
    return [...this.#terms.values()].filter((t) => t.accountId === accountId).map(viewOf);
  }

  get(accountId: string, id: string): TerminalView {
    return viewOf(this.#term(accountId, id));
  }

  async create(accountId: string, input: CreateTerminalInput): Promise<TerminalView> {
    if (this.#closed) throw new NovaError('sandbox_unavailable', 'the Hub is shutting down');
    // Terminals still starting are counted in #starting.
    const live = [...this.#terms.values()].filter(
      (t) => t.accountId === accountId && t.status === 'running',
    );
    const starting = this.#starting.get(accountId) ?? 0;
    if (live.length + starting >= this.#max)
      throw new NovaError(
        'conflict',
        `at most ${this.#max} terminals can be open; close one first`,
        {
          details: { reason: 'too_many_terminals' },
        },
      );
    this.#starting.set(accountId, starting + 1);
    try {
      return await this.#start(accountId, input);
    } finally {
      const n = (this.#starting.get(accountId) ?? 1) - 1;
      if (n > 0) this.#starting.set(accountId, n);
      else this.#starting.delete(accountId);
    }
  }

  async #start(accountId: string, input: CreateTerminalInput): Promise<TerminalView> {
    const sandbox = this.#o.sandbox();
    const probe = sandbox
      ? await sandbox.available()
      : { ok: false, detail: 'No sandbox is available on this Hub.' };
    if (!sandbox || !probe.ok)
      throw new NovaError('sandbox_unavailable', probe.detail, {
        action: 'Install Docker or Podman on the Hub',
      });
    const threadId = input.threadId ?? null;
    let projectId: string | null = null;
    if (threadId) {
      const t = this.#o.db.raw
        .prepare(
          'SELECT project_id AS projectId FROM thread WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
        )
        .get(threadId, accountId) as { projectId: string | null } | undefined;
      if (!t) throw new NovaError('not_found', 'thread not found');
      projectId = t.projectId;
    }
    const scope = await this.#o.scope({ accountId, threadId, projectId });
    if (!scope.roots.length)
      throw new NovaError('validation', 'no folders are available to this chat');
    const root = input.root ? scope.roots.find((r) => r.path === input.root) : scope.roots[0];
    if (!root) throw new NovaError('not_found', 'no such folder for this chat');

    const t: Terminal = {
      id: uuidv7(),
      accountId,
      threadId,
      cwd: root.path,
      createdAt: (this.#o.now?.() ?? new Date()).toISOString(),
      status: 'starting',
      exitCode: null,
      sandbox,
      sessionId: null,
      streamed: false,
      scrollback: '',
      sinks: new Set(),
      abort: new AbortController(),
      idle: null,
      audited: false,
    };
    this.#terms.set(t.id, t);
    const req: ExecRequest & ExecRequestExtras = {
      cmd: terminalCommand(input.cols, input.rows),
      cwd: root.path,
      roots: scope.roots,
      network: scope.network,
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8' },
      yieldMs: 0,
      signal: t.abort.signal,
      turnId: `terminal:${t.id}`,
      onOutput: (chunk) => {
        t.streamed = true;
        this.#output(t, chunk);
      },
    };
    let first: ExecResult;
    try {
      first = await sandbox.exec(req);
    } catch (err) {
      this.#terms.delete(t.id);
      throw err;
    }
    await this.#o.audit.append({
      accountId,
      actor: 'user',
      kind: 'tool_call',
      action: 'terminal.open',
      resource: root.path,
      decision: 'allow',
      result: 'ok',
      threadId,
      detail: { terminalId: t.id, profileId: scope.profile.id, profileHash: scope.profile.hash },
    });
    if (!t.streamed && first.output) this.#output(t, first.output);
    if (first.status === 'exited') {
      await this.#exited(t, first.exitCode);
    } else {
      t.status = 'running';
      t.sessionId = first.sessionId;
      void this.#pump(t);
    }
    this.#armIdle(t);
    return viewOf(t);
  }

  /** Watch a terminal: replay its scrollback, then stream. Throws `not_found`. */
  attach(accountId: string, id: string, sink: TerminalSink): TerminalAttachment {
    const t = this.#term(accountId, id);
    if (t.idle) clearTimeout(t.idle);
    t.idle = null;
    t.sinks.add(sink);
    if (t.scrollback) sink.send({ type: 'output', data: t.scrollback });
    if (t.status === 'exited') sink.send({ type: 'exit', code: t.exitCode });
    return {
      input: (data) => {
        if (t.status !== 'running' || !t.sessionId) return;
        // Frames are the relay's; typed or pasted text can never carry one.
        const text = data.replaceAll(FRAME, '');
        if (text) this.#write(t, text);
      },
      resize: (cols, rows) => {
        if (t.status === 'running' && t.sessionId) this.#write(t, resizeFrame(cols, rows));
      },
      detach: () => {
        t.sinks.delete(sink);
        if (!t.sinks.size) this.#armIdle(t);
      },
    };
  }

  /** Kill a terminal and forget it. */
  async close(accountId: string, id: string): Promise<void> {
    const t = this.#term(accountId, id);
    await this.#kill(t);
    this.#terms.delete(t.id);
  }

  /** Kill every terminal (Hub shutdown). */
  async closeAll(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#terms.values()].map((t) => this.#kill(t)));
    this.#terms.clear();
  }

  // ---- internals ----------------------------------------------------------------------------

  #term(accountId: string, id: string): Terminal {
    const t = this.#terms.get(id);
    if (!t || t.accountId !== accountId) throw new NovaError('not_found', 'terminal not found');
    return t;
  }

  #write(t: Terminal, text: string): void {
    t.sandbox.write(t.sessionId!, { text }).catch((err: unknown) => {
      this.#log.debug('terminal write failed', { err, terminalId: t.id });
    });
  }

  #output(t: Terminal, chunk: string): void {
    if (!chunk) return;
    t.scrollback += chunk;
    if (t.scrollback.length > this.#keep) t.scrollback = t.scrollback.slice(-this.#keep);
    for (const s of t.sinks) s.send({ type: 'output', data: chunk });
  }

  /** Drain the session until it exits: output (when not streamed) and the exit code. */
  async #pump(t: Terminal): Promise<void> {
    while (t.status === 'running' && t.sessionId) {
      const started = Date.now();
      let r: ExecResult;
      try {
        r = await t.sandbox.poll(t.sessionId, t.streamed ? 2_000 : 50, t.abort.signal);
      } catch {
        // The session is gone (killed, or collected after it exited).
        if (t.status === 'running') await this.#exited(t, null);
        return;
      }
      if (t.status !== 'running') return;
      if (!t.streamed && r.output) this.#output(t, r.output);
      if (r.status === 'exited') {
        await this.#exited(t, r.exitCode);
        return;
      }
      // A sandbox that answers at once must not turn this into a busy loop.
      if (Date.now() - started < 5 && !r.output) await new Promise((res) => setTimeout(res, 25));
    }
  }

  async #exited(t: Terminal, code: number | null): Promise<void> {
    if (t.status === 'exited') return;
    t.status = 'exited';
    t.exitCode = code;
    if (t.idle) clearTimeout(t.idle);
    t.idle = null;
    for (const s of t.sinks) s.send({ type: 'exit', code });
    await this.#closeRecord(t, code, 'exited');
    this.#prune(t.accountId);
  }

  async #kill(t: Terminal): Promise<void> {
    if (t.idle) clearTimeout(t.idle);
    t.idle = null;
    const wasRunning = t.status !== 'exited';
    t.status = 'exited';
    t.abort.abort();
    if (wasRunning && t.sessionId) {
      await t.sandbox.write(t.sessionId, { signal: 'terminate' }).catch(() => undefined);
      await t.sandbox.killTurn(`terminal:${t.id}`).catch(() => undefined);
    }
    if (wasRunning) {
      for (const s of t.sinks) s.send({ type: 'exit', code: null });
      await this.#closeRecord(t, null, 'closed');
    }
  }

  async #closeRecord(t: Terminal, code: number | null, how: 'exited' | 'closed'): Promise<void> {
    if (t.audited) return;
    t.audited = true;
    try {
      await this.#o.audit.append({
        accountId: t.accountId,
        actor: how === 'closed' ? 'user' : 'system',
        kind: 'tool_call',
        action: 'terminal.close',
        resource: t.cwd,
        decision: null,
        result: how,
        threadId: t.threadId,
        detail: { terminalId: t.id, exitCode: code },
      });
      await this.#o.events.emit({
        name: 'terminal.exited',
        accountId: t.accountId,
        payload: { terminalId: t.id, code },
      });
    } catch (err) {
      this.#log.warn('recording a closed terminal failed', { err, terminalId: t.id });
    }
  }

  /** Close a terminal nobody watches once the idle time passes. */
  #armIdle(t: Terminal): void {
    if (t.status === 'exited' || t.sinks.size || this.#idleMs <= 0) return;
    if (t.idle) clearTimeout(t.idle);
    t.idle = setTimeout(() => {
      t.idle = null;
      if (t.sinks.size) return;
      void this.#kill(t).then(() => this.#terms.delete(t.id));
    }, this.#idleMs);
    t.idle.unref?.();
  }

  /** Keep only the newest exited terminals of an account listed. */
  #prune(accountId: string): void {
    const exited = [...this.#terms.values()].filter(
      (t) => t.accountId === accountId && t.status === 'exited' && !t.sinks.size,
    );
    for (const t of exited.slice(0, Math.max(0, exited.length - EXITED_KEPT)))
      this.#terms.delete(t.id);
  }
}

function viewOf(t: Terminal): TerminalView {
  return {
    id: t.id,
    threadId: t.threadId,
    cwd: t.cwd,
    status: t.status === 'exited' ? 'exited' : 'running',
    exitCode: t.exitCode,
    createdAt: t.createdAt,
  };
}
