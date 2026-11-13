// Nova's own Claude CLI seat (design amendment 2026-11-12, "Authentication and seat health").
//
// Isolation: every Claude CLI Nova starts runs with CLAUDE_CONFIG_DIR set to this seat's folder in
// Nova's home (seats/claude-cli). Nova never starts the CLI against the person's interactive
// ~/.claude, and never copies a sign-in from anywhere: two clients on one grant rotate each other's
// refresh tokens away (the CLI's own words: "another Claude Code process is refreshing it"). The
// folder is kept out of the home's git history, backups and checkpoints (home.js, backup.ts,
// checkpoints.ts), so a sign-in never leaves this folder either.
//
// Health: one field, three states (ok, needs-sign-in, unreachable), from a keepalive probe on an
// interval (seat_probe_hours, L0 default 6) and from any live call that fails to authenticate. The
// probe is the cheapest call that goes through the CLI's token refresh: a one-turn `claude -p` on
// its smallest model with no tools. `claude auth status` doesn't qualify: in 2.1.259 it reports
// loggedIn from the token on disk and never refreshes it.
//
// Detection: needs-sign-in raises ONE problem (playbook seat-sign-in, deduped by subject). It stops
// Nova (red) when no other seat can chat, and is amber when another can. Its one action, Sign in
// again, runs `claude auth login` against the seat's folder and shows the authorization page's
// address and a field for the code in the console. The problem closes only when an independent
// probe succeeds afterwards (the playbook's check): the login's own "Login successful" closes
// nothing. The closing is a Work Ledger task with the probe's record as evidence.
//
// Never logged: the sign-in page's address, and the code. Neither is written to the log, the
// problem, the ledger, or any file; the address lives in memory while the sign-in waits.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from './db.ts';
import type { Log, Problem } from './log.ts';
import type { Route, Who } from './api.ts';
import type { Ledger, LanedWorker } from './ledger.ts';
import type { Verifier } from './verify.ts';
import type { Playbooks } from './resilience/playbooks.ts';
import { reportOf, type Brief, type Report } from './envelope.ts';
import { inheritedChildEnv } from './child-env.ts';
import { trackChild } from './children.ts';
import { runLines } from './providers/cli.ts';
import { CoreError } from './errors.ts';
import { allows } from './mesh/access.ts';

export const SEAT_ID = 'claude-cli';
export const SEAT_PLAYBOOK = 'seat-sign-in';
export const WORKER_ID = 'claude-seat';
export const CONFIRMATION_SYSTEM = 'claude-seat';
export const DEFAULT_PROBE_HOURS = 6;
// While the seat isn't ok, it is looked at again at least this often, so a network that came back
// or a sign-in made from a terminal into the seat's folder shows within minutes.
export const RECHECK_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 90_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export type SeatState = 'ok' | 'needs-sign-in' | 'unreachable';

// The seat's own folder in a Nova home, made private (0700) on first use.
export function seatDir(home: string): string {
  return join(home, 'seats', SEAT_ID);
}

export function seatEnv(home: string): { CLAUDE_CONFIG_DIR: string } {
  const dir = seatDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of [join(home, 'seats'), dir]) { try { chmodSync(d, 0o700); } catch { /* not ours to change */ } }
  return { CLAUDE_CONFIG_DIR: dir };
}

// A failure that means the sign-in is gone, in the words Claude Code (and the API behind it) use.
// Matched on what the CLI said, never on what the model wrote in a reply.
const AUTH = /Failed to authenticate|OAuth (?:session|token)[^\n]*(?:expired|revoked|could not be refreshed)|Not logged in|Please run \/login|claude auth login|Invalid (?:API key|bearer token)|authentication_error|token has been revoked|\b401\b[^\n]*(?:Unauthorized|auth)/i;
const NETWORK = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Unable to connect|fetch failed|network|getaddrinfo|socket hang up|overloaded|\b5\d\d\b/i;

export function authFailure(text: string | null | undefined): boolean {
  return !!text && AUTH.test(text);
}

// The program a command starts, by its first word that isn't an environment assignment.
export function programOf(cmd: string): string {
  return cmd.trim().split(/\s+/).find((w) => !/^\w+=/.test(w)) ?? '';
}

export function isClaudeProgram(program: string): boolean {
  return program.replace(/^['"]|['"]$/g, '').split('/').pop() === 'claude';
}

// The probe's arguments: one turn, the smallest model, no tools, settings, MCP servers, slash
// commands or saved session. Its answer is never read for content, only for whether it came.
export const PROBE_ARGS = [
  '-p', '--model', 'haiku', '--max-turns', '1', '--output-format', 'json',
  '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence',
];
const PROBE_PROMPT = 'Reply with the single word: ok';

export interface SeatCheck { id: number; at: string; state: SeatState; by: string; said: string }

export interface SignInView {
  state: 'idle' | 'starting' | 'waiting' | 'checking' | 'done' | 'failed';
  said: string;
  // Only to an owner-class caller, and only while the sign-in waits for the code.
  url?: string;
}

export interface ClaudeSeatOptions {
  db: Db;
  log: Log;
  home: string;
  playbooks: Playbooks;
  ledger: Ledger;
  verifier: Verifier;
  now?: () => Date;
  probeHours?: number;
  // The claude program to start (agent_cmd's when it is claude), or a stand-in in tests.
  program: () => string;
  // Whether anything Nova runs uses this seat now; a seat nothing uses is never probed.
  inUse: () => boolean;
  // Whether another seat can serve chat while this one can't: then its problem is amber.
  alternative: () => boolean;
}

export class ClaudeSeat {
  #o: ClaudeSeatOptions;
  #now: () => Date;
  #probing: Promise<SeatCheck> | null = null;
  #signIn: { view: SignInView; url: string | null; child: ChildProcessWithoutNullStreams | null; timer: ReturnType<typeof setTimeout> | null } = { view: { state: 'idle', said: '' }, url: null, child: null, timer: null };
  #key = Symbol('claude-seat');

  constructor(o: ClaudeSeatOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    this.#wireLedger();
    // The independent check that closes the problem: a probe that succeeded after the problem was
    // raised and after the last sign-in started. Never the login's own claim.
    o.playbooks.check(SEAT_PLAYBOOK, 'Nova’s own check call to Claude succeeds after you sign in', (_subject, p) => {
      const last = this.last();
      const after = Math.max(Date.parse(p.at), this.#signInStarted ?? 0);
      if (last?.state === 'ok' && Date.parse(last.at) >= after && last.by !== 'call') return { holds: true, said: `Nova’s check call to Claude answered (${last.by}, ${last.at}).` };
      return { holds: false, said: last ? `The last check (${last.by}) says: ${last.said}` : 'Nova hasn’t checked Claude since.' };
    });
    o.playbooks.on('change', (e: { problem_id: number; settled?: boolean }) => {
      if (!e.settled || o.playbooks.view(e.problem_id)?.id !== SEAT_PLAYBOOK) return;
      this.#recordClosed(e.problem_id);
    });
  }

  get probeHours(): number {
    return this.#o.probeHours ?? DEFAULT_PROBE_HOURS;
  }

  env(): { CLAUDE_CONFIG_DIR: string } {
    return seatEnv(this.#o.home);
  }

  // The newest check, from a probe or a live call.
  last(): SeatCheck | null {
    return this.#o.db.get<SeatCheck>('SELECT id, at, state, by, said FROM seat_check WHERE seat = ? ORDER BY id DESC LIMIT 1', SEAT_ID) ?? null;
  }

  lastProbe(): SeatCheck | null {
    return this.#o.db.get<SeatCheck>('SELECT id, at, state, by, said FROM seat_check WHERE seat = ? AND by != ? ORDER BY id DESC LIMIT 1', SEAT_ID, 'call') ?? null;
  }

  // The heartbeat's turn: probe when the interval has passed since the last probe (or sooner while
  // the seat isn't ok). Nothing while no one uses the seat, or while a sign-in is under way.
  async tick(): Promise<SeatCheck | null> {
    if (!this.#o.inUse() || this.#signInBusy()) return null;
    const last = this.lastProbe();
    const now = this.#now().getTime();
    const every = this.probeHours * 3_600_000;
    const due = !last || now - Date.parse(last.at) >= (this.last()?.state === 'ok' ? every : Math.min(every, RECHECK_MS));
    return due ? this.probe('keepalive') : null;
  }

  // One probe now. Concurrent callers share it.
  probe(by: 'keepalive' | 'after-sign-in' | 'person' = 'keepalive'): Promise<SeatCheck> {
    if (!this.#probing) this.#probing = this.#runProbe(by).finally(() => { this.#probing = null; });
    return this.#probing;
  }

  async #runProbe(by: string): Promise<SeatCheck> {
    const cwd = mkdtempSync(join(tmpdir(), 'nova-seat-'));
    let out = '';
    let state: SeatState;
    let said: string;
    try {
      const ran = await runLines({ argv: [this.#o.program(), ...PROBE_ARGS], cwd, input: PROBE_PROMPT, env: { ...inheritedChildEnv(), ...this.env() }, timeoutMs: PROBE_TIMEOUT_MS, onLine: (l) => { out = (out + l + '\n').slice(-16_000); } });
      let result: { is_error?: boolean; result?: unknown; subtype?: string } | null = null;
      try { result = JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? ''); } catch { result = null; }
      const words = `${typeof result?.result === 'string' ? result.result : ''}\n${ran.stderr}`.trim();
      if (ran.code === 0 && result && !result.is_error) { state = 'ok'; said = 'Claude answered Nova’s check call.'; }
      else if (ran.timedOut) { state = 'unreachable'; said = 'Claude didn’t answer Nova’s check call in time.'; }
      else if (ran.code === 127) { state = 'unreachable'; said = `Nova can’t find \`${this.#o.program()}\` on this computer.`; }
      else if (authFailure(words)) { state = 'needs-sign-in'; said = plain(words); }
      else if (NETWORK.test(words)) { state = 'unreachable'; said = `Claude couldn’t be reached: ${plain(words)}`; }
      else if (await this.#signedOut()) { state = 'needs-sign-in'; said = 'Nova’s Claude seat isn’t signed in.'; }
      else { state = 'unreachable'; said = `Claude’s check call failed: ${plain(words) || `exit code ${ran.code}`}`; }
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      state = 'unreachable';
      said = missing ? `Nova can’t find \`${this.#o.program()}\` on this computer.` : `Nova couldn’t start its check call: ${(e as Error).message}`;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    return this.#record(state, by, said);
  }

  // Whether the seat's folder holds no sign-in at all (`claude auth status`, read from disk only).
  async #signedOut(): Promise<boolean> {
    let out = '';
    try {
      await runLines({ argv: [this.#o.program(), 'auth', 'status', '--json'], cwd: seatDir(this.#o.home), env: { ...inheritedChildEnv(), ...this.env() }, timeoutMs: 15_000, onLine: (l) => { out += l; } });
      return JSON.parse(out).loggedIn === false;
    } catch { return false; }
  }

  // A live call (chat, a schedule, a coding task) failed to authenticate: the seat needs a sign-in
  // now, whatever the last probe said.
  failed(detail: string): SeatCheck {
    return this.#record('needs-sign-in', 'call', plain(detail) || 'A call to Claude failed to authenticate.');
  }

  #record(state: SeatState, by: string, said: string): SeatCheck {
    const at = this.#now().toISOString();
    this.#o.db.run('INSERT INTO seat_check (seat, at, state, by, said) VALUES (?, ?, ?, ?, ?)', SEAT_ID, at, state, by, said);
    const id = this.#o.db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
    const check = { id: Number(id), at, state, by, said };
    this.#o.log.info('seat', `Claude seat: ${state} (${by}). ${said}`, { seat: SEAT_ID, state, by });
    if (state === 'needs-sign-in') this.#raise(said);
    return check;
  }

  #raise(said: string): Problem {
    const stops = !this.#o.alternative();
    const until = stops ? ', so I can’t answer anything until you sign in' : '; another model is answering meanwhile';
    // A seat that has never answered was never signed in: Nova's own sign-in starts signed out (it
    // never copies one), and saying "expired" about it would be wrong.
    const ever = !!this.#o.db.get('SELECT 1 FROM seat_check WHERE seat = ? AND state = ? LIMIT 1', SEAT_ID, 'ok');
    const words = ever ? `My Claude sign-in expired${until}${stops ? ' again' : ''}.` : `Nova now keeps its own Claude sign-in, and it isn’t signed in yet${until}.`;
    return this.#o.playbooks.open('seat', words, SEAT_PLAYBOOK, { subject: SEAT_ID, detail: said, stops });
  }

  open(): Problem | null {
    return this.#o.playbooks.openFor(SEAT_PLAYBOOK, SEAT_ID);
  }

  // For Health's checks list.
  // needs_owner: failing, but only the owner can fix it (a sign-in); a release didn't break it, and
  // going back to older code can't mend it, so the supervisor's canary doesn't count it (supervisor.ts).
  health(): { ok: boolean; detail: string; state: SeatState | 'unchecked' | 'unused'; checked_at: string | null; interval_hours: number; attention?: string; stops?: boolean; needs_owner?: boolean } {
    const base = { checked_at: this.last()?.at ?? null, interval_hours: this.probeHours };
    if (!this.#o.inUse()) return { ok: true, state: 'unused', detail: 'Nothing Nova runs uses its Claude seat now.', ...base };
    const last = this.last();
    if (!last) return { ok: true, state: 'unchecked', detail: `Nova checks its Claude sign-in every ${this.probeHours} h; it hasn’t checked yet.`, ...base };
    if (last.state === 'ok') return { ok: true, state: 'ok', detail: `Signed in. Checked ${last.at}; Nova checks every ${this.probeHours} h to keep the sign-in fresh.`, ...base };
    if (last.state === 'unreachable') return { ok: true, state: 'unreachable', detail: last.said, attention: 'Claude couldn’t be reached at the last check.', ...base };
    return { ok: false, state: 'needs-sign-in', detail: `Needs you to sign in again. ${last.said}`, needs_owner: true, ...(this.#o.alternative() ? {} : { stops: true }), ...base };
  }

  // ---- Sign in again --------------------------------------------------------------------------

  #signInStarted: number | null = null;

  #signInBusy(): boolean {
    return ['starting', 'waiting', 'checking'].includes(this.#signIn.view.state);
  }

  signInView(owner: boolean): SignInView {
    const v = this.#signIn.view;
    return { ...v, ...(owner && v.state === 'waiting' && this.#signIn.url ? { url: this.#signIn.url } : {}) };
  }

  // Starts `claude auth login` against the seat's folder. Its address comes back to the console
  // (never logged); the code goes in with submitCode. A sign-in already under way is reused.
  async startSignIn(): Promise<SignInView> {
    if (this.#signInBusy()) return this.signInView(true);
    this.#signInStarted = this.#now().getTime();
    const s = this.#signIn;
    s.url = null;
    s.view = { state: 'starting', said: 'Starting Claude’s sign-in…' };
    // BROWSER=true: the CLI's attempt to open a browser on this machine does nothing; the address
    // is shown in the console instead, for any device.
    const child = trackChild(spawn(this.#o.program(), ['auth', 'login', '--claudeai'], { cwd: seatDir(this.#o.home), env: { ...inheritedChildEnv(), ...this.env(), BROWSER: 'true' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }), { group: true });
    s.child = child;
    let stdout = '';
    let stderr = '';
    const ready = new Promise<void>((resolve) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        stdout = (stdout + d).slice(-8000);
        const m = /https:\/\/\S+/.exec(stdout);
        if (m && !s.url) { s.url = m[0]; s.view = { state: 'waiting', said: 'Open the sign-in page on any device, approve, then paste the code it shows here.' }; resolve(); }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => {
        stderr = (stderr + d).slice(-4000);
        if (/Invalid code/i.test(d) && s.view.state === 'checking') s.view = { state: 'waiting', said: 'That code didn’t work. Copy the whole code from the sign-in page and paste it again.' };
      });
      child.on('close', () => resolve());
    });
    child.stdin.on('error', () => { /* it may exit first */ });
    child.on('error', (e) => { s.view = { state: 'failed', said: `Nova couldn’t start Claude’s sign-in: ${(e as Error).message}` }; });
    child.on('close', (code) => {
      if (s.timer) clearTimeout(s.timer);
      s.child = null;
      s.url = null;
      if (code === 0) {
        // The login's "Login successful" is only its claim. An independent probe decides.
        s.view = { state: 'checking', said: 'Signed in. Nova is checking that Claude answers…' };
        void this.probe('after-sign-in').then(async (c) => {
          await this.#o.playbooks.verify();
          s.view = c.state === 'ok' ? { state: 'done', said: 'Signed in, and Claude answered Nova’s check call.' } : { state: 'failed', said: `The sign-in finished, but Nova’s check call still failed: ${c.said}` };
        }).catch((e) => { s.view = { state: 'failed', said: `The sign-in finished, but Nova couldn’t check it: ${(e as Error).message}` }; });
      } else if (s.view.state !== 'failed') {
        s.view = { state: 'failed', said: `The sign-in didn’t finish. ${plain(stripAddresses(stderr)) || `Claude’s sign-in stopped (exit code ${code}).`} You can start it again.` };
      }
    });
    s.timer = setTimeout(() => { s.view = { state: 'failed', said: 'The sign-in waited ten minutes for a code, so Nova stopped it. Start it again when you’re ready.' }; try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ } }, SIGN_IN_TIMEOUT_MS);
    s.timer.unref();
    await Promise.race([ready, new Promise((r) => setTimeout(r, 20_000).unref())]);
    if (s.view.state === 'starting') s.view = { state: 'failed', said: 'Claude’s sign-in didn’t give Nova a sign-in page to show.' };
    return this.signInView(true);
  }

  // The code from the sign-in page, handed to the waiting login on its stdin. Never logged.
  submitCode(code: unknown): SignInView {
    const s = this.#signIn;
    if (s.view.state !== 'waiting' || !s.child) throw new CoreError('conflict', 'No sign-in is waiting for a code. Start Sign in again first.');
    const c = typeof code === 'string' ? code.trim() : '';
    if (!c || c.length > 1024 || !/^[A-Za-z0-9._~-]+#[A-Za-z0-9._~-]+$/.test(c)) throw new CoreError('validation', 'That doesn’t look like the whole code. Copy everything the sign-in page shows and paste it here.');
    s.view = { state: 'checking', said: 'Checking the code…' };
    s.child.stdin.write(`${c}\n`);
    return this.signInView(true);
  }

  cancelSignIn(): SignInView {
    const s = this.#signIn;
    if (s.child) { s.view = { state: 'failed', said: 'Sign-in stopped.' }; try { process.kill(-s.child.pid!, 'SIGTERM'); } catch { /* gone */ } }
    return this.signInView(true);
  }

  view(owner: boolean) {
    return { id: SEAT_ID, ...this.health(), last: this.last(), sign_in: this.signInView(owner), problem: this.open()?.id ?? null };
  }

  routes(): Route[] {
    // Owner-class: the hub's own console, or a device that may approve (as restarting Nova is).
    const owner = (who: Who) => allows('approver', who.principal) === 'ok';
    const need = (who: Who) => { if (!owner(who)) throw new CoreError('forbidden', 'Signing Nova in to Claude is for the hub’s own screen or a device that may approve.'); };
    return [
      { method: 'GET', path: '/seats', summary: 'Nova’s model seats and how each stands: signed in (ok), needs you to sign in again, or unreachable, with the last check.', handle: ({ who }) => [this.view(owner(who))] },
      { method: 'POST', path: '/seats/claude-cli/check', summary: 'Check Nova’s Claude seat now with one small call.', handle: async ({ who }) => { need(who); await this.probe('person'); await this.#o.playbooks.verify(); return this.view(true); } },
      { method: 'POST', path: '/seats/claude-cli/sign-in', summary: 'Sign Nova’s own Claude seat in again: starts Claude’s sign-in and returns the page to open on any device (owner only).', handle: async ({ who }) => { need(who); return this.startSignIn(); } },
      { method: 'GET', path: '/seats/claude-cli/sign-in', summary: 'How the sign-in stands; the page’s address only to the owner, only while it waits for the code.', handle: ({ who }) => this.signInView(owner(who)) },
      { method: 'POST', path: '/seats/claude-cli/sign-in/code', summary: 'The code the sign-in page showed (owner only). Never logged.', body: '{code}', handle: ({ who, body }) => { need(who); return this.submitCode(body.code); } },
      { method: 'POST', path: '/seats/claude-cli/sign-in/cancel', summary: 'Stop a sign-in under way (owner only).', handle: ({ who }) => { need(who); return this.cancelSignIn(); } },
    ];
  }

  // ---- The closing, in the Work Ledger ----------------------------------------------------------

  #wireLedger(): void {
    const o = this.#o;
    const worker: LanedWorker = {
      id: WORKER_ID, name: 'Claude seat', about: 'Records that Nova’s Claude sign-in works again, with the check call that showed it.', egress: 'none', evidence: ['confirmation'],
      health: () => ({ ok: true }),
      lane: () => ({ key: 'claude-seat', max: 1 }),
      internal: { key: this.#key, why: 'Only Nova’s own seat check records a sign-in restored.' },
      run: async (brief: Brief): Promise<Report> => reportOf(brief.task_id, 'done', String(brief.inputs?.said ?? 'Signed in again.'), {
        evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: String(brief.inputs?.check ?? '') }],
      }),
    };
    o.ledger.workers.set(worker.id, worker);
    o.verifier.registerConfirmation(CONFIRMATION_SYSTEM, (e, brief) => {
      const id = Number((e as { id?: string }).id);
      const r = o.db.get<SeatCheck>('SELECT id, at, state, by, said FROM seat_check WHERE id = ? AND seat = ?', id, SEAT_ID);
      if (!r) return { ok: false, why: `Nova has no record of seat check ${id}.` };
      if (r.state !== 'ok' || r.by === 'call') return { ok: false, why: `Seat check ${id} wasn’t a successful check call.` };
      if (Number(brief.inputs?.check) !== id) return { ok: false, why: `Seat check ${id} belongs to other work.` };
      return { ok: true, why: `Nova read its own record: check call ${id} (${r.by}) to Claude answered at ${r.at}.` };
    });
  }

  #recordClosed(problemId: number): void {
    const check = this.lastProbe();
    if (!check || check.state !== 'ok') return;
    try {
      this.#o.ledger.create({
        title: 'Claude sign-in works again',
        owner: WORKER_ID,
        goal: `Nova’s Claude seat answers again after a sign-in, closing problem ${problemId}.`,
        origin: { kind: 'trigger', ref: `seat:${SEAT_ID}` },
        evidence_required: [{ kind: 'confirmation', note: 'Nova’s own record of the check call that answered.' }],
        inputs: { seat: SEAT_ID, problem: problemId, check: check.id, said: `Problem ${problemId} closed: ${check.said}` },
        privacy_mode: 'local-only', approval_tier: 0, user_visibility: 'handling', idempotency_key: `seat:${SEAT_ID}:closed:${problemId}`,
      }, { as: this.#key });
      void this.#o.ledger.pump();
    } catch (e) {
      this.#o.log.warn('seat', 'Nova couldn’t record the sign-in working again in the Work Ledger.', { error: (e as Error).message });
    }
  }
}

// What a program said, as one plain line for a person: no control characters, no addresses (a
// sign-in page's address must never land in a log or a problem), at most 300 characters.
function plain(text: string): string {
  return stripAddresses(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function stripAddresses(text: string): string {
  return text.replace(/https?:\/\/\S+/g, '(address left out)');
}
