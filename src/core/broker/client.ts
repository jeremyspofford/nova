// Core's client for the Credential Broker (docs/plans/vault-broker.md §3, §9 row 1). Core holds
// refs and metadata only: none of these methods returns a value, because the broker never sends
// one to core. It imports the broker's protocol types only (erased at run time), and nothing of
// the broker's code: the broker is a separate process, reached over its local socket.
//
// What core does with a credential:
//  - list_refs, for names, sites, usernames, bindings, classes and health flags;
//  - use, for an http request the broker sends itself, a check of a callback's signature, or a
//    ticket for a program, which `launch` hands to the broker's launcher (never to the program);
//  - create, update, rotate, bind and share_scope, each answering needs_approval with a challenge
//    first; the person's client approves it, and seals any value it types (src/broker/seal.ts);
//  - the migration from vault.ts, through the launcher, so no old value is read in core either.
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { AuditRecord, Challenge, Refusal, RefMeta, Target } from '../../broker/protocol.ts';

export type { AuditRecord, Challenge, Refusal, RefMeta, Target };

export interface Answer {
  id: number;
  ok?: true;
  refused?: Refusal;
  error?: string;
  words?: string;
  challenge?: Challenge;
  record?: AuditRecord;
  [k: string]: unknown;
}
export interface Approval { id: string; digest: string; mode: 'core' | 'passkey'; credential_id?: string; authenticator_data?: string; client_data_json?: string; signature?: string }
export interface Ask { task?: { id: string; title: string }; caller?: string; approval?: Approval }

export const LAUNCHER = fileURLToPath(new URL('../../broker/launch.ts', import.meta.url));

export class BrokerError extends Error {
  readonly answer: Answer;
  constructor(a: Answer) { super(a.words ?? a.refused ?? a.error ?? 'The broker refused.'); this.answer = a; }
}

export class BrokerClient {
  readonly socket: string;
  #token: string;
  #sock: Socket | null = null;
  #ready: Promise<void> | null = null;
  #n = 0;
  #buf = '';
  #waiting = new Map<number, (a: Answer) => void>();
  // Every audit record the broker sent back, for the Work Ledger (§8): core copies each one under
  // its task, and a gap in the sequence shows in Health.
  onRecord: ((r: AuditRecord) => void) | null = null;

  constructor(o: { socket: string; token: string }) {
    this.socket = o.socket;
    this.#token = o.token;
  }

  #open(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = new Promise((ok, fail) => {
      const s = connect(this.socket);
      s.setEncoding('utf8');
      s.on('data', (c: string) => {
        this.#buf += c;
        let i: number;
        while ((i = this.#buf.indexOf('\n')) >= 0) {
          const line = this.#buf.slice(0, i);
          this.#buf = this.#buf.slice(i + 1);
          let a: Answer;
          try { a = JSON.parse(line) as Answer; } catch { continue; }
          if (a.record && this.onRecord) this.onRecord(a.record);
          this.#waiting.get(a.id)?.(a);
          this.#waiting.delete(a.id);
        }
      });
      const gone = () => { this.#sock = null; this.#ready = null; for (const w of this.#waiting.values()) w({ id: -1, error: 'failed', words: 'Nova’s vault isn’t running.' }); this.#waiting.clear(); };
      s.on('close', gone);
      s.once('error', (e) => { gone(); fail(new Error(`Nova’s vault isn’t running (${(e as NodeJS.ErrnoException).code ?? e.message}).`)); });
      s.once('connect', async () => {
        this.#sock = s;
        const a = await this.#send('hello', { token: this.#token });
        if (a.ok) ok(); else fail(new BrokerError(a));
      });
    });
    return this.#ready;
  }

  #send(m: string, f: Record<string, unknown>): Promise<Answer> {
    const id = ++this.#n;
    return new Promise((ok) => {
      this.#waiting.set(id, ok);
      this.#sock!.write(`${JSON.stringify({ id, m, ...f })}\n`);
    });
  }

  async call(m: string, f: Record<string, unknown> = {}): Promise<Answer> {
    await this.#open();
    return this.#send(m, f);
  }

  close(): void { this.#sock?.end(); this.#sock = null; this.#ready = null; }

  // ---- the protocol messages and the seven verbs ----------------------------------------------

  state() { return this.call('list_refs', {}).then((a) => a.state as Record<string, unknown>); }
  unlock(factor: Record<string, unknown>) { return this.call('unlock', factor); }
  lock() { return this.call('lock'); }
  listRefs(filter: { prefix?: string; kind?: string } = {}) { return this.call('list_refs', { filter }); }
  use(ref: string, target: Target, request: Record<string, unknown>, ask: Ask & { version?: 'pending' } = {}) { return this.call('use', { ref, target, request, ...ask }); }
  create(meta: Record<string, unknown>, source: unknown, ask: Ask & { bind?: unknown[] } = {}) { return this.call('create', { meta, source, ...ask }); }
  update(ref: string, change: unknown, ask: Ask = {}) { return this.call('update', { ref, change, ...ask }); }
  rotate(ref: string, phase: 'begin' | 'commit' | 'abandon', ask: Ask = {}) { return this.call('rotate', { ref, phase, ...ask }); }
  bind(ref: string, change: { add?: unknown; remove?: unknown }, ask: Ask = {}) { return this.call('bind', { ref, ...change, ...ask }); }
  shareScope(scope: { device?: unknown; backend?: unknown }, ask: Ask = {}) { return this.call('share_scope', { ...scope, ...ask }); }

  // ---- the launcher ---------------------------------------------------------------------------

  // Starts the broker's launcher for a program ticket (from `use` on a process target). The ticket
  // goes in on fd 3. Core gets a child whose output the launcher has already scrubbed.
  launch(ticket: string, program: string, o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcess {
    const child = spawn(process.execPath, ['--disable-sigusr1', '--disable-warning=ExperimentalWarning', LAUNCHER, 'run', this.socket, program], { cwd: o.cwd, env: o.env ?? { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    (child.stdio[3] as NodeJS.WritableStream).end(`${ticket}\n`);
    return child;
  }

  // The migration from vault.ts (§10): stage (the launcher reads the old vault and streams it to
  // the broker), commit (each entry becomes an unbound item and is read back), finish (the launcher
  // takes what moved out of the old vault), then propose (one tier-3 card of bindings and classes).
  // Core only ever sees names, counts and the card; it never opens the old vault itself.
  async migrateStage(home: string, ask: Ask = {}): Promise<{ staged: number } | Answer> {
    const a = await this.create({}, { migrate: 'stage' }, ask);
    if (!a.ok) return a;
    const out = await this.#runLauncher('migrate', home, (a.outcome as { ticket: string }).ticket);
    return out.code === 0 ? (JSON.parse(out.stdout) as { staged: number }) : { id: -1, error: 'failed', words: out.stderr.trim() };
  }
  migrateCommit(ask: Ask = {}) { return this.create({}, { migrate: 'commit' }, ask); }
  migratePropose(proposals: Record<string, { origin?: string; class?: string; bind?: unknown[] }>, ask: Ask = {}) {
    return this.create({}, { migrate: 'propose', proposals }, ask);
  }
  async migrateFinish(home: string, ticket: string): Promise<{ removed: number; kept: number } | Answer> {
    const out = await this.#runLauncher('migrate-finish', home, ticket);
    return out.code === 0 ? (JSON.parse(out.stdout) as { removed: number; kept: number }) : { id: -1, error: 'failed', words: out.stderr.trim() };
  }

  #runLauncher(mode: string, home: string, ticket: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((ok) => {
      const child = spawn(process.execPath, ['--disable-sigusr1', '--disable-warning=ExperimentalWarning', LAUNCHER, mode, this.socket, home], { env: { PATH: process.env.PATH ?? '', ...(process.env.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT } : {}), ...(process.env.NOVA_VAULT_KEY ? { NOVA_VAULT_KEY: process.env.NOVA_VAULT_KEY } : {}), ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout!.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
      child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
      (child.stdio[3] as NodeJS.WritableStream).end(`${ticket}\n`);
      child.on('close', (code) => ok({ code, stdout, stderr }));
    });
  }
}

// Nova's own keys stay in core's vault.ts (§9 row 15); everything else in it is a credential the
// migration proposes to move.
export const OWN_KEY_NAMES = [/^nova\//, /^capture\/hash-key$/, /^network\/[^/]+\/change\//, /^infra\/[^/]+\/run\//];
export const isOwnKey = (name: string) => OWN_KEY_NAMES.some((r) => r.test(name));

// Paths in the home a backup, the home's git, the sync journal and a checkpoint must treat
// specially (§10 "No escrow"): only items/ is backed up; the header, wraps, device key, socket and
// audit log never are.
export const BROKER_DIR = 'broker';
export const BROKER_BACKUP_ONLY = 'broker/items/';
