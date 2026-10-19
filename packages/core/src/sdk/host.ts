// The Hub's side of the extension runtime (FR-117; docs/14 §4.2; ADR-097 D3): one worker thread
// per enabled extension, running its code in an isolated engine (engine.ts). Everything the code
// asks for arrives here as a request and is checked against what its extension.json declared:
// registrations (commands, panels, tools, hooks, themes, keybindings, events, menus, status
// items), network requests (declared hosts only, public addresses only), files (declared scopes
// only, links resolved) and secrets (declared names only). Anything undeclared is denied,
// audited and reported to the service, which turns the extension off (docs/08 §3.1). The worker
// is terminated on disable, uninstall, a fault (CPU or memory limit) and Hub shutdown.
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { EventEnvelope } from '@nova/shared';
import { contracts, type Validator } from '@nova/contracts';
import type { SecretStore } from '@nova/secrets';
import { defaultRedactor, type Redactor } from '@nova/security';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import { publicFetch } from '../team/public-net.ts';
import { matchingPattern } from '../computers/egress-policy.ts';
import type { AuditRecord, AuditSink, ToolResult } from '../tools/types.ts';
import type { EngineLimits } from './engine.ts';
import {
  EXTENSION_DATA_VAR,
  EXTENSION_ROOT_VAR,
  OBSERVABLE_EVENTS,
  eventAllowed,
  extensionSources,
  fsScopes,
  hostDeclared,
  resolveEventName,
  type ExtensionActionClass,
  type ExtensionManifest,
  type ExtensionPanel,
  type FsScope,
} from './manifest.ts';
import type { FromWorker, WorkerInit } from './worker.ts';

const WORKER_URL = new URL('./worker.ts', import.meta.url);

/** Where a context menu item may appear (docs/14 §4.1 "Context menus"). */
export const MENU_PLACES = ['thread', 'message', 'file', 'composer', 'sidebar'] as const;

const LIMITS = {
  themes: 10,
  keybindings: 50,
  menus: 20,
  menuItems: 20,
  statusItems: 5,
  events: 50,
  invocations: 32,
  eventsInFlight: 20,
  schemaChars: 64 * 1024,
  responseBytes: 5 * 1024 * 1024,
  fileBytes: 5 * 1024 * 1024,
  listEntries: 1000,
  eventChars: 64 * 1024,
  resultChars: 100_000,
  argsChars: 1_000_000,
};

/** What the service tells the host about an extension it should run. */
export interface ExtensionSpec {
  accountId: string;
  extensionId: string;
  version: string;
  /** The installed folder (`${extensionRoot}`). */
  root: string;
  /** The extension's own data folder (`${extensionData}`). */
  dataDir: string;
  manifest: ExtensionManifest;
  digest: string;
}

export type HostStatus = 'starting' | 'running' | 'error' | 'stopped';

/** The egress ceiling for `nova.net.fetch` (FR-102, FR-106; docs/12 §8). */
export interface ExtensionEgress {
  /** off: no network; limited: read requests (GET, HEAD, OPTIONS) only; allowlist: its hosts. */
  mode: 'off' | 'limited' | 'allowlist';
  /** Host patterns no request reaches (a deny always wins). */
  deny: string[];
  /** Each managed layer's allowed hosts: a host must be in every list. */
  allow: string[][];
  /** Managed policy could not be read: no network at all. */
  failClosed: string | null;
}

export interface ToolRegistration {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
    requiresNetwork?: boolean;
    costClass?: 'free' | 'metered';
  };
  action: ExtensionActionClass;
}

export interface Registrations {
  commands: Map<string, { id: string; title: string }>;
  panels: Map<string, ExtensionPanel & { title: string }>;
  tools: Map<string, ToolRegistration>;
  hooks: Map<string, { id: string; event: string }>;
  themes: Map<string, Record<string, unknown>>;
  keybindings: Map<string, { command: string; key: string; when: string | null }>;
  menus: Map<string, { where: string; items: { id: string; title: string; command: string }[] }>;
  status: Map<string, { id: string; text: string; command: string | null; clickable: boolean }>;
  events: Map<string, string>;
}

function emptyRegistrations(): Registrations {
  return {
    commands: new Map(),
    panels: new Map(),
    tools: new Map(),
    hooks: new Map(),
    themes: new Map(),
    keybindings: new Map(),
    menus: new Map(),
    status: new Map(),
    events: new Map(),
  };
}

export type InvokeKind = 'command' | 'tool' | 'hook' | 'event' | 'status' | 'lifecycle';

export type ExtensionInvokeResult =
  { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

interface Pending {
  resolve: (r: ExtensionInvokeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Running {
  key: string;
  spec: ExtensionSpec;
  worker: Worker;
  status: HostStatus;
  error: string | null;
  reg: Registrations;
  pending: Map<number, Pending>;
  nextId: number;
  eventsInFlight: number;
  activated: (r: { ok: boolean; error: string | null }) => void;
  stopping: boolean;
}

export interface ExtensionHostOptions {
  secrets: SecretStore;
  /** The Hub's data folder: no filesystem scope may reach into it except the extension's own. */
  hubDataDir: string;
  audit?: AuditSink;
  events?: EventSink;
  log?: Logger;
  /** Network for `nova.net.fetch`: public addresses only by default. */
  fetch?: typeof fetch;
  limits?: Partial<EngineLimits>;
  startTimeoutMs?: number;
  invokeTimeoutMs?: number;
  fetchTimeoutMs?: number;
  /**
   * The network ceiling above the extension's own hosts: managed policy's egress restriction and
   * the egress settings, read on every request. A reader that fails refuses the request.
   */
  egress?: () => Promise<ExtensionEgress>;
  /** An undeclared request: the service turns the extension off and tells the owner. */
  onViolation?: (accountId: string, extensionId: string, what: string) => void | Promise<void>;
  /** Registrations or status changed (the client refreshes its commands and panels). */
  onChange?: (accountId: string, extensionId: string) => void;
  redactor?: Redactor;
  /** Restart after a fault at most this often per 10 minutes (default 3). */
  maxRestarts?: number;
  restartDelayMs?: number;
  workerUrl?: URL;
}

const keyOf = (accountId: string, extensionId: string) => `${accountId}\n${extensionId}`;

function fail(code: string, message: string): ExtensionInvokeResult {
  return { ok: false, error: { code, message } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A string field, or `fallback` for anything else (never an object's default text). */
function textOf(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max ? v : null;
}

/** Whether `child` is `parent` or inside it (both absolute, normalized). */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A handler's value as a tool result (docs/08 §1.2): text, plus structured content. */
export function toToolResult(value: unknown): ToolResult {
  const cap = (t: string) =>
    t.length > LIMITS.resultChars ? `${t.slice(0, LIMITS.resultChars)}\n[truncated]` : t;
  if (typeof value === 'string') return { ok: true, content: [{ type: 'text', text: cap(value) }] };
  if (isRecord(value) && Array.isArray(value.content)) {
    const texts = value.content
      .filter(
        (p): p is { type: 'text'; text: string } =>
          isRecord(p) && p.type === 'text' && typeof p.text === 'string',
      )
      .map((p) => ({ type: 'text' as const, text: cap(p.text) }));
    if (value.isError === true)
      return {
        ok: false,
        error: {
          code: 'tool_error',
          message:
            texts
              .map((t) => t.text)
              .join('\n')
              .slice(0, 2000) || 'the tool failed',
        },
      };
    return {
      ok: true,
      content: texts.length ? texts : [{ type: 'text', text: '' }],
      ...(value.structuredContent !== undefined
        ? { meta: { structuredContent: value.structuredContent } }
        : {}),
    };
  }
  let text: string;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    text = String(value);
  }
  return {
    ok: true,
    content: [{ type: 'text', text: cap(text) }],
    ...(value !== null && value !== undefined ? { meta: { structuredContent: value } } : {}),
  };
}

let themeValidator: Validator | null = null;

export class ExtensionHost {
  readonly #o: ExtensionHostOptions;
  readonly #log: Logger;
  readonly #fetch: typeof fetch;
  readonly #redactor: Redactor;
  readonly #running = new Map<string, Running>();
  /** Why an extension last failed while it is not running (cleared on a good start). */
  readonly #failed = new Map<string, string>();
  /** Worker threads that have not exited yet (terminated workers leave it). */
  readonly #live = new Set<Worker>();
  readonly #restarts = new Map<string, number[]>();
  readonly #restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #closed = false;

  constructor(opts: ExtensionHostOptions) {
    this.#o = opts;
    this.#log = opts.log ?? new Logger({ module: 'core.sdk', sinks: [] });
    this.#fetch = opts.fetch ?? publicFetch();
    this.#redactor = opts.redactor ?? defaultRedactor;
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  /**
   * Start (or restart) an extension's worker and wait until its `activate` finished, failed or
   * timed out. Resolves to the status it reached; never throws.
   */
  async start(spec: ExtensionSpec): Promise<{ status: HostStatus; error: string | null }> {
    const key = keyOf(spec.accountId, spec.extensionId);
    this.#cancelRestart(key);
    await this.#stop(key, 'restarted');
    if (this.#closed) return { status: 'stopped', error: 'the Hub is shutting down' };
    let sources: Record<string, string>;
    try {
      sources = extensionSources(spec.root);
      mkdirSync(spec.dataDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
    const init: WorkerInit = {
      start: {
        extensionId: spec.extensionId,
        api: spec.manifest.api,
        entry: spec.manifest.entry,
        sources,
      },
      limits: this.#o.limits ?? {},
    };
    const memoryMb = Math.ceil((this.#o.limits?.memoryBytes ?? 64 * 1024 * 1024) / 1048576);
    let worker: Worker;
    try {
      worker = new Worker(this.#o.workerUrl ?? WORKER_URL, {
        workerData: init,
        // The engine's heap lives in the worker's; nothing of the Hub's environment is passed.
        resourceLimits: {
          maxOldGenerationSizeMb: 64 + memoryMb * 2,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        env: {},
        stdout: true,
        stderr: true,
      });
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : 'the worker did not start',
      };
    }
    worker.stdout.resume();
    worker.stderr.resume();
    let settle: (r: { ok: boolean; error: string | null }) => void = () => undefined;
    const activated = new Promise<{ ok: boolean; error: string | null }>((r) => (settle = r));
    const run: Running = {
      key,
      spec,
      worker,
      status: 'starting',
      error: null,
      reg: emptyRegistrations(),
      pending: new Map(),
      nextId: 1,
      eventsInFlight: 0,
      activated: (r) => settle(r),
      stopping: false,
    };
    this.#running.set(key, run);
    this.#changed(run);
    worker.on('message', (m: FromWorker) => this.#onMessage(run, m));
    worker.on('error', (err: unknown) =>
      this.#crashed(
        run,
        `the extension's worker failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      ),
    );
    this.#live.add(worker);
    worker.on('exit', (code) => {
      this.#live.delete(worker);
      if (!run.stopping) this.#crashed(run, `the extension's worker exited (${code})`);
    });
    const timeout = this.#o.startTimeoutMs ?? 20_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([
      activated,
      new Promise<{ ok: boolean; error: string | null }>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              ok: false,
              error: `the extension did not start within ${Math.round(timeout / 1000)} s`,
            }),
          timeout,
        );
      }),
    ]);
    clearTimeout(timer);
    if (this.#running.get(key) !== run) return { status: 'stopped', error: null };
    if (r.ok && run.status === 'starting') {
      run.status = 'running';
      this.#changed(run);
      return { status: 'running', error: null };
    }
    const error = r.error ?? run.error ?? 'the extension did not start';
    await this.#stop(key, 'failed');
    return { status: 'error', error };
  }

  /** Stop an extension's worker (disable, uninstall, the SDK switch off). */
  stop(accountId: string, extensionId: string): Promise<void> {
    const key = keyOf(accountId, extensionId);
    this.#cancelRestart(key);
    return this.#stop(key, 'stopped');
  }

  /** Stop every worker (Hub shutdown); nothing starts afterwards. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const k of [...this.#restartTimers.keys()]) this.#cancelRestart(k);
    await Promise.all([...this.#running.keys()].map((k) => this.#stop(k, 'stopped')));
  }

  /** Stop every worker but keep accepting starts (the SDK switch turned off). */
  async stopAll(): Promise<void> {
    for (const k of [...this.#restartTimers.keys()]) this.#cancelRestart(k);
    await Promise.all([...this.#running.keys()].map((k) => this.#stop(k, 'stopped')));
  }

  async #stop(key: string, why: string): Promise<void> {
    const run = this.#running.get(key);
    if (!run || run.stopping) return;
    run.stopping = true;
    // A graceful `deactivate`, briefly; the worker is terminated either way.
    if (run.status === 'running')
      await this.#invoke(run, 'lifecycle', 'deactivate', null, {}, 500).catch(() => undefined);
    this.#running.delete(key);
    for (const [, p] of run.pending) {
      clearTimeout(p.timer);
      p.resolve(fail('extension_stopped', `the extension was ${why}`));
    }
    run.pending.clear();
    run.activated({ ok: false, error: run.error ?? `the extension was ${why}` });
    await run.worker.terminate().catch(() => undefined);
    this.#changed(run);
  }

  #crashed(run: Running, message: string): void {
    if (run.stopping || this.#running.get(run.key) !== run) return;
    run.error = message;
    run.status = 'error';
    this.#log.warn('extension worker stopped', { extensionId: run.spec.extensionId, message });
    run.activated({ ok: false, error: message });
    void this.#stop(run.key, 'stopped after a fault').then(() => this.#maybeRestart(run, message));
  }

  #maybeRestart(run: Running, message: string): void {
    if (this.#closed) return;
    const now = Date.now();
    const recent = (this.#restarts.get(run.key) ?? []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= (this.#o.maxRestarts ?? 3)) {
      this.#failed.set(run.key, `${message}; it was stopped after repeated faults`);
      this.#changed(run);
      return;
    }
    recent.push(now);
    this.#restarts.set(run.key, recent);
    this.#failed.set(run.key, message);
    const t = setTimeout(() => {
      this.#restartTimers.delete(run.key);
      void this.start(run.spec).then((r) => {
        if (r.status === 'running') this.#failed.delete(run.key);
      });
    }, this.#o.restartDelayMs ?? 1000);
    t.unref();
    this.#restartTimers.set(run.key, t);
  }

  #cancelRestart(key: string): void {
    const t = this.#restartTimers.get(key);
    if (t) clearTimeout(t);
    this.#restartTimers.delete(key);
  }

  /** How many extension worker threads are alive (terminated ones are gone). */
  liveWorkers(): number {
    return this.#live.size;
  }

  /** Where an extension's worker is, with the last error when it failed. */
  status(accountId: string, extensionId: string): { status: HostStatus; error: string | null } {
    const key = keyOf(accountId, extensionId);
    const run = this.#running.get(key);
    if (run) return { status: run.status, error: run.error };
    const failed = this.#failed.get(key);
    return failed ? { status: 'error', error: failed } : { status: 'stopped', error: null };
  }

  /** Forget a failure (the extension was turned off or removed). */
  clearError(accountId: string, extensionId: string): void {
    this.#failed.delete(keyOf(accountId, extensionId));
    this.#restarts.delete(keyOf(accountId, extensionId));
  }

  /** Running extensions of an account with what they registered. */
  running(accountId: string): { spec: ExtensionSpec; reg: Registrations }[] {
    return [...this.#running.values()]
      .filter((r) => r.spec.accountId === accountId && r.status === 'running')
      .map((r) => ({ spec: r.spec, reg: r.reg }));
  }

  /** One running extension's registrations, or null. */
  registrations(accountId: string, extensionId: string): Registrations | null {
    const run = this.#running.get(keyOf(accountId, extensionId));
    return run && run.status === 'running' ? run.reg : null;
  }

  #changed(run: Running): void {
    try {
      this.#o.onChange?.(run.spec.accountId, run.spec.extensionId);
    } catch (err) {
      this.#log.warn('extension change listener failed', { err });
    }
  }

  // ---- invocations ------------------------------------------------------------------------------

  /** Run one of an extension's handlers and wait for its answer (or the timeout). Never throws. */
  invoke(
    accountId: string,
    extensionId: string,
    kind: InvokeKind,
    key: string,
    args: unknown,
    ctx: Record<string, unknown> = {},
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ExtensionInvokeResult> {
    const run = this.#running.get(keyOf(accountId, extensionId));
    if (!run || run.status !== 'running')
      return Promise.resolve(
        fail('extension_unavailable', `the extension ${extensionId} is not running`),
      );
    return this.#invoke(
      run,
      kind,
      key,
      args,
      ctx,
      opts.timeoutMs ?? this.#o.invokeTimeoutMs ?? 30_000,
      opts.signal,
    );
  }

  #invoke(
    run: Running,
    kind: InvokeKind,
    key: string,
    args: unknown,
    ctx: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExtensionInvokeResult> {
    if (run.pending.size >= LIMITS.invocations)
      return Promise.resolve(
        fail('extension_busy', 'the extension has too many calls in progress'),
      );
    let json: string;
    try {
      json = JSON.stringify({ t: 'invoke', id: run.nextId, kind, key, args: args ?? null, ctx });
    } catch {
      return Promise.resolve(fail('invalid_arguments', 'the arguments are not JSON'));
    }
    if (json.length > LIMITS.argsChars)
      return Promise.resolve(fail('invalid_arguments', 'the arguments are too large'));
    const id = run.nextId++;
    return new Promise<ExtensionInvokeResult>((resolve) => {
      const done = (r: ExtensionInvokeResult) => {
        const p = run.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        run.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onAbort = () => done(fail('cancelled', 'the call was cancelled'));
      const timer = setTimeout(
        () =>
          done(
            fail(
              'timeout',
              `the extension did not answer within ${Math.round(timeoutMs / 1000)} s`,
            ),
          ),
        timeoutMs,
      );
      run.pending.set(id, { resolve: done, timer });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      run.worker.postMessage({ type: 'deliver', json });
    });
  }

  /** Deliver an observable event to the extensions of its account that subscribed (observe only). */
  dispatchEvent(env: EventEnvelope): void {
    if (!env.accountId || !(OBSERVABLE_EVENTS as readonly string[]).includes(env.name)) return;
    for (const run of this.#running.values()) {
      if (run.status !== 'running' || run.spec.accountId !== env.accountId) continue;
      for (const [subKey, pattern] of run.reg.events) {
        const p = resolveEventName(pattern);
        const hit = p.endsWith('.*') ? env.name.startsWith(p.slice(0, -1)) : p === env.name;
        if (!hit) continue;
        if (run.eventsInFlight >= LIMITS.eventsInFlight) continue;
        const event = this.#redactor.redact({
          name: env.name,
          at: env.ts,
          payload: env.payload,
          correlation: env.correlation ?? {},
        });
        if (JSON.stringify(event).length > LIMITS.eventChars) continue;
        run.eventsInFlight++;
        void this.#invoke(run, 'event', subKey, event, {}, 10_000).finally(() => {
          run.eventsInFlight--;
        });
      }
    }
  }

  // ---- messages from the worker -----------------------------------------------------------------

  #onMessage(run: Running, m: FromWorker): void {
    if (this.#running.get(run.key) !== run) return;
    if (m.type === 'log') {
      const text = this.#redactor.redactString(String(m.text)).slice(0, 4000);
      // The extension's own words are content: a fixed message, the text as a `content.`
      // attribute, so OTLP export leaves it out unless content export is on (FR-223).
      const fields = { extensionId: run.spec.extensionId, 'content.text': text };
      if (m.level === 'error') this.#log.warn('extension log', fields);
      else this.#log.debug('extension log', fields);
      return;
    }
    if (m.type === 'fault') {
      this.#crashed(run, String(m.message));
      return;
    }
    if (m.type !== 'send' || typeof m.json !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(m.json);
      if (!isRecord(parsed)) return;
      msg = parsed;
    } catch {
      return;
    }
    if (msg.t === 'activated') {
      const err = isRecord(msg.error) ? textOf(msg.error.message, 'activate failed') : null;
      if (msg.ok !== true) run.error = err ?? 'activate failed';
      run.activated({ ok: msg.ok === true, error: err });
      return;
    }
    if (msg.t === 'done') {
      const p = typeof msg.id === 'number' ? run.pending.get(msg.id) : undefined;
      if (!p) return;
      p.resolve(
        msg.ok === true
          ? { ok: true, value: msg.value ?? null }
          : fail(
              isRecord(msg.error) && typeof msg.error.code === 'string'
                ? msg.error.code.slice(0, 100)
                : 'extension_error',
              this.#redactor
                .redactString(isRecord(msg.error) ? textOf(msg.error.message, 'failed') : 'failed')
                .slice(0, 2000),
            ),
      );
      return;
    }
    if (msg.t !== 'req' || typeof msg.op !== 'string') return;
    const id = typeof msg.id === 'number' ? msg.id : 0;
    void this.#request(run, msg.op, msg.args).then(
      (r) => {
        if (id > 0 && this.#running.get(run.key) === run)
          run.worker.postMessage({ type: 'deliver', json: JSON.stringify({ t: 'res', id, ...r }) });
      },
      (err: unknown) => {
        this.#log.warn('extension request failed', { err, op: msg.op });
        if (id > 0 && this.#running.get(run.key) === run)
          run.worker.postMessage({
            type: 'deliver',
            json: JSON.stringify({
              t: 'res',
              id,
              ok: false,
              error: { code: 'internal', message: 'the request failed' },
            }),
          });
      },
    );
  }

  async #request(
    run: Running,
    op: string,
    args: unknown,
  ): Promise<
    { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }
  > {
    const a = isRecord(args) ? args : {};
    switch (op) {
      case 'register':
        return this.#register(run, a);
      case 'unregister':
        this.#unregister(run, a);
        return { ok: true, value: null };
      case 'status.update': {
        const item = typeof a.key === 'string' ? run.reg.status.get(a.key) : undefined;
        const text = str(a.text, 80);
        if (item && text !== null) {
          item.text = text;
          this.#changed(run);
        }
        return { ok: true, value: null };
      }
      case 'net.fetch':
        return this.#fetchFor(run, a);
      case 'fs.read':
      case 'fs.write':
      case 'fs.list':
      case 'fs.remove':
        return this.#fs(run, op, a);
      case 'secrets.get':
        return this.#secret(run, a);
      default:
        return { ok: false, error: { code: 'unknown_request', message: `unknown request ${op}` } };
    }
  }

  // ---- registrations ----------------------------------------------------------------------------

  async #denied(run: Running, what: string, target: string, kind: AuditRecord['kind'] = 'plugin') {
    const { accountId, extensionId } = run.spec;
    const message = `${extensionId} asked for ${what} ${target}, which it did not declare`;
    this.#log.warn('extension request denied', { extensionId, what, target });
    await this.#o.audit
      ?.append({
        accountId,
        actor: `ext:${extensionId}`,
        kind,
        action: 'extension.access.denied',
        resource: `ext:${extensionId}`,
        decision: 'denied',
        detail: { extensionId, what, target: target.slice(0, 300) },
      })
      .catch((err: unknown) => this.#log.warn('extension audit failed', { err }));
    await Promise.resolve(
      this.#o.events?.emit({
        name: 'extension.access.denied',
        actor: 'system',
        accountId,
        payload: { extensionId, what, target: target.slice(0, 300) },
      }),
    ).catch(() => undefined);
    // After the answer goes back: the service turns the extension off (fail closed).
    setImmediate(() => {
      void Promise.resolve(
        this.#o.onViolation?.(accountId, extensionId, `${what} ${target}`),
      ).catch((err: unknown) => this.#log.warn('extension violation handler failed', { err }));
    });
    return { ok: false as const, error: { code: 'policy_denied', message } };
  }

  #bad(message: string) {
    return { ok: false as const, error: { code: 'validation', message } };
  }

  async #register(run: Running, a: Record<string, unknown>) {
    const p = run.spec.manifest.permissions;
    const key = typeof a.key === 'string' ? a.key.slice(0, 200) : '';
    const reg = run.reg;
    const ok = () => {
      this.#changed(run);
      return { ok: true as const, value: null };
    };
    switch (a.kind) {
      case 'command': {
        if (!(p.commands ?? []).includes(key)) return this.#denied(run, 'the command', key);
        const title = str(a.title, 100) ?? key;
        reg.commands.set(key, { id: key, title });
        return ok();
      }
      case 'panel': {
        const panel = (p.panels ?? []).find((x) => x.id === key);
        if (!panel) return this.#denied(run, 'the panel', key);
        if (
          (a.resource !== undefined && a.resource !== null && a.resource !== panel.resource) ||
          (a.entryPoint !== undefined && a.entryPoint !== null && a.entryPoint !== panel.entryPoint)
        )
          return this.#denied(run, 'a different resource or entry point for the panel', key);
        reg.panels.set(key, { ...panel, title: str(a.title, 100) ?? panel.title });
        return ok();
      }
      case 'tool': {
        const decl = p.tools?.[key];
        if (!decl || !Object.hasOwn(p.tools ?? {}, key)) return this.#denied(run, 'the tool', key);
        const input = isRecord(a.inputSchema) ? a.inputSchema : { type: 'object' };
        if (input.type !== undefined && input.type !== 'object')
          return this.#bad('a tool inputSchema is a JSON Schema of type object');
        const schemaSize =
          JSON.stringify(input).length + JSON.stringify(a.outputSchema ?? null).length;
        if (schemaSize > LIMITS.schemaChars) return this.#bad('the tool schemas are too large');
        const ann = isRecord(a.annotations) ? a.annotations : {};
        const flag = (k: string) => (typeof ann[k] === 'boolean' ? { [k]: ann[k] } : {});
        reg.tools.set(key, {
          name: key,
          title: str(a.title, 120) ?? key,
          description: str(a.description, 2000) ?? '',
          inputSchema: { type: 'object', ...input },
          ...(isRecord(a.outputSchema) ? { outputSchema: a.outputSchema } : {}),
          annotations: {
            ...flag('destructive'),
            ...flag('idempotent'),
            ...flag('requiresNetwork'),
            ...(ann.costClass === 'free' || ann.costClass === 'metered'
              ? { costClass: ann.costClass }
              : {}),
            // Only a declared read can be read-only: the manifest's action class wins.
            ...(decl.action === 'read' && ann.readOnly === true ? { readOnly: true } : {}),
          },
          action: decl.action,
        });
        return ok();
      }
      case 'hook': {
        const decl = (p.hooks ?? []).find((h) => h.id === key);
        if (!decl) return this.#denied(run, 'the hook', key);
        if (a.event !== undefined && a.event !== null && a.event !== decl.event)
          return this.#denied(run, `the hook event ${textOf(a.event, '?')} for`, key);
        reg.hooks.set(key, { id: key, event: decl.event });
        return ok();
      }
      case 'theme': {
        if (!reg.themes.has(key) && reg.themes.size >= LIMITS.themes)
          return this.#bad('too many themes');
        themeValidator ??= contracts().validator('theme.json');
        const v = themeValidator(a.theme);
        if (!v.ok || !isRecord(a.theme) || a.theme.id !== key)
          return this.#bad(
            `the theme is not valid: ${v.ok ? 'its id changed' : (v.errors[0]?.message ?? 'invalid')}`,
          );
        reg.themes.set(key, a.theme);
        return ok();
      }
      case 'keybinding': {
        const command = str(a.command, 100);
        const keys = str(a.key, 40);
        if (!command || !keys || !/^[A-Za-z0-9+\-,. ]+$/.test(keys))
          return this.#bad('a keybinding is {command, key, when?}');
        if (!(p.commands ?? []).includes(command))
          return this.#denied(run, 'a keybinding for the command', command);
        if (!reg.keybindings.has(key) && reg.keybindings.size >= LIMITS.keybindings)
          return this.#bad('too many keybindings');
        reg.keybindings.set(key, { command, key: keys, when: str(a.when, 200) });
        return ok();
      }
      case 'event': {
        const name = str(a.name, 100);
        if (!name) return this.#bad('events.on needs an event name');
        if (!eventAllowed(p.events ?? [], name)) return this.#denied(run, 'the event', name);
        if (reg.events.size >= LIMITS.events) return this.#bad('too many event listeners');
        reg.events.set(key, name);
        return ok();
      }
      case 'menu': {
        const where = str(a.where, 40);
        if (!where || !(MENU_PLACES as readonly string[]).includes(where))
          return this.#bad(`a menu goes in one of: ${MENU_PLACES.join(', ')}`);
        const raw = Array.isArray(a.items) ? a.items : [];
        if (raw.length > LIMITS.menuItems) return this.#bad('too many menu items');
        const items: { id: string; title: string; command: string }[] = [];
        for (const it of raw) {
          const r = isRecord(it) ? it : {};
          const command = str(r.command, 100);
          const title = str(r.title, 100);
          if (!command || !title) return this.#bad('a menu item is {id?, title, command}');
          if (!(p.commands ?? []).includes(command))
            return this.#denied(run, 'a menu item for the command', command);
          items.push({ id: str(r.id, 100) ?? command, title, command });
        }
        if (!reg.menus.has(key) && reg.menus.size >= LIMITS.menus)
          return this.#bad('too many menus');
        reg.menus.set(key, { where, items });
        return ok();
      }
      case 'status': {
        if (!/^[a-z0-9][a-zA-Z0-9._-]{0,63}$/.test(key))
          return this.#bad('a status item id is a short name');
        const command = a.command === undefined || a.command === null ? null : str(a.command, 100);
        if (command !== null && !(p.commands ?? []).includes(command))
          return this.#denied(run, 'a status item for the command', command);
        if (!reg.status.has(key) && reg.status.size >= LIMITS.statusItems)
          return this.#bad('too many status items');
        reg.status.set(key, {
          id: key,
          text: str(a.text, 80) ?? '',
          command,
          clickable: a.clickable === true,
        });
        return ok();
      }
      default:
        return this.#bad('unknown registration');
    }
  }

  #unregister(run: Running, a: Record<string, unknown>): void {
    const key = typeof a.key === 'string' ? a.key : '';
    const table: Record<string, Map<string, unknown>> = {
      command: run.reg.commands,
      panel: run.reg.panels,
      tool: run.reg.tools,
      hook: run.reg.hooks,
      theme: run.reg.themes,
      keybinding: run.reg.keybindings,
      event: run.reg.events,
      menu: run.reg.menus,
      status: run.reg.status,
    };
    const map = typeof a.kind === 'string' ? table[a.kind] : undefined;
    if (map?.delete(key)) this.#changed(run);
  }

  // ---- network, files, secrets ------------------------------------------------------------------

  async #fetchFor(run: Running, a: Record<string, unknown>) {
    let url: URL;
    try {
      url = new URL(textOf(a.url, ''));
    } catch {
      return this.#bad('not a URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      return this.#bad('only http and https URLs');
    if (url.username || url.password) return this.#bad('URLs cannot carry credentials');
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!hostDeclared(run.spec.manifest.permissions.network ?? [], host))
      return this.#denied(run, 'the host', host, 'network');
    const method = textOf(a.method, 'GET').toUpperCase();
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method))
      return this.#bad('unsupported method');
    // Declared is not enough: managed policy and the egress settings still apply (FR-106).
    const refused = await this.#egressProblem(host, method);
    if (refused) return this.#egressDenied(run, host, refused);
    const headers = new Headers();
    if (isRecord(a.headers))
      for (const [k, v] of Object.entries(a.headers).slice(0, 50))
        if (
          typeof v === 'string' &&
          !/^(host|cookie|proxy-.*|connection|transfer-encoding)$/i.test(k)
        ) {
          try {
            headers.set(k, v);
          } catch {
            // an invalid header name is left out
          }
        }
    const body =
      typeof a.body === 'string' && method !== 'GET' && method !== 'HEAD' ? a.body : undefined;
    if (body !== undefined && body.length > LIMITS.responseBytes)
      return this.#bad('the request body is too large');
    const timeout = AbortSignal.timeout(this.#o.fetchTimeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        signal: timeout,
      });
    } catch (err) {
      return {
        ok: false as const,
        error: {
          code: 'fetch_failed',
          message: `${host}: ${err instanceof Error ? err.message : 'the request failed'}`,
        },
      };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    if (res.body) {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        if (size >= LIMITS.responseBytes) {
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    const buf = Buffer.concat(chunks).subarray(0, LIMITS.responseBytes);
    const type = res.headers.get('content-type') ?? '';
    const textual =
      /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|$)|\+json|\+xml/i.test(
        type,
      );
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k !== 'set-cookie') out[k] = v;
    });
    return {
      ok: true as const,
      value: {
        status: res.status,
        statusText: res.statusText,
        headers: out,
        body: textual ? buf.toString('utf8') : buf.toString('base64'),
        encoding: textual ? 'utf8' : 'base64',
        truncated,
      },
    };
  }

  /** Why the egress ceiling refuses a request, or null. */
  async #egressProblem(host: string, method: string): Promise<string | null> {
    if (!this.#o.egress) return null;
    let e: ExtensionEgress;
    try {
      e = await this.#o.egress();
    } catch {
      return 'the egress policy could not be read, so no request is made';
    }
    if (e.failClosed)
      return `network access is off: your organization's managed policy could not be read (${e.failClosed})`;
    if (e.mode === 'off') return 'network access is turned off (egress off)';
    if (e.mode === 'limited' && !/^(GET|HEAD|OPTIONS)$/.test(method))
      return `only read requests (GET, HEAD, OPTIONS) are allowed; ${method} is not`;
    if (matchingPattern(e.deny, host)) return `${host} is on the egress deny list`;
    if (e.allow.some((list) => !matchingPattern(list, host)))
      return `${host} is not among the hosts your organization's managed policy allows`;
    return null;
  }

  /** A refusal by policy, not by the manifest: audited, and the extension stays on. */
  async #egressDenied(run: Running, host: string, why: string) {
    const { accountId, extensionId } = run.spec;
    await this.#o.audit
      ?.append({
        accountId,
        actor: `ext:${extensionId}`,
        kind: 'network',
        action: 'extension.egress.denied',
        resource: `ext:${extensionId}`,
        decision: 'denied',
        detail: { extensionId, host, reason: why },
      })
      .catch((err: unknown) => this.#log.warn('extension audit failed', { err }));
    return { ok: false as const, error: { code: 'policy_denied', message: why } };
  }

  /** The scope a path falls in, after variables are expanded; null when none covers it. */
  #scopeFor(run: Running, raw: string, write: boolean): { path: string; scope: FsScope } | null {
    const spec = run.spec;
    let p = raw;
    if (p.startsWith(EXTENSION_DATA_VAR))
      p = join(spec.dataDir, p.slice(EXTENSION_DATA_VAR.length));
    else if (p.startsWith(EXTENSION_ROOT_VAR))
      p = join(spec.root, p.slice(EXTENSION_ROOT_VAR.length));
    if (!isAbsolute(p) || p.includes('\0')) return null;
    const path = normalize(p);
    for (const scope of fsScopes(spec.manifest, { data: spec.dataDir, root: spec.root })) {
      if (write && !scope.write) continue;
      if (!within(scope.path, path)) continue;
      // The Hub's own data stays out of reach, except the extension's own folders.
      const own = within(spec.dataDir, path) || within(spec.root, path);
      if (!own && within(this.#o.hubDataDir, path)) continue;
      return { path, scope };
    }
    return null;
  }

  /** The real path stays inside the scope's real path (links resolved); for a new file, its folder. */
  #really(scope: FsScope, path: string): boolean {
    try {
      const base = realpathSync(scope.path);
      let probe = path;
      for (;;) {
        try {
          return within(base, realpathSync(probe));
        } catch {
          const up = dirname(probe);
          if (up === probe || !within(scope.path, up)) return false;
          probe = up;
        }
      }
    } catch {
      return false;
    }
  }

  async #fs(run: Running, op: string, a: Record<string, unknown>) {
    const raw = typeof a.path === 'string' ? a.path : '';
    const write = op === 'fs.write' || op === 'fs.remove';
    const hit = this.#scopeFor(run, raw, write);
    if (!hit) return this.#denied(run, write ? 'write access to' : 'read access to', raw, 'fs');
    const { path, scope } = hit;
    if (!this.#really(scope, path))
      return this.#denied(run, 'a link out of its folder at', raw, 'fs');
    try {
      switch (op) {
        case 'fs.read': {
          const st = statSync(path);
          if (!st.isFile()) return this.#bad('not a file');
          if (st.size > LIMITS.fileBytes) return this.#bad('the file is larger than 5 MB');
          return { ok: true as const, value: readFileSync(path, 'utf8') };
        }
        case 'fs.write': {
          const text = typeof a.text === 'string' ? a.text : '';
          if (Buffer.byteLength(text) > LIMITS.fileBytes)
            return this.#bad('the text is larger than 5 MB');
          if (path === scope.path) return this.#bad('cannot write the folder itself');
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          if (!this.#really(scope, path))
            return this.#denied(run, 'a link out of its folder at', raw, 'fs');
          writeFileSync(path, text, { mode: 0o600 });
          return { ok: true as const, value: null };
        }
        case 'fs.list': {
          const out = readdirSync(path, { withFileTypes: true })
            .slice(0, LIMITS.listEntries)
            .map((d) => ({
              name: d.name,
              kind: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other',
              size: d.isFile() ? lstatSync(join(path, d.name)).size : null,
            }));
          return { ok: true as const, value: out };
        }
        default: {
          if (path === scope.path) return this.#bad('cannot remove the folder itself');
          rmSync(path, { recursive: true, force: true });
          return { ok: true as const, value: null };
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return {
        ok: false as const,
        error: {
          code: code === 'ENOENT' ? 'not_found' : 'fs_error',
          message:
            code === 'ENOENT' ? 'no such file' : `the file operation failed (${code ?? 'error'})`,
        },
      };
    }
  }

  async #secret(run: Running, a: Record<string, unknown>) {
    const name = typeof a.name === 'string' ? a.name : '';
    const { accountId, extensionId } = run.spec;
    if (!(run.spec.manifest.permissions.secrets ?? []).includes(name))
      return this.#denied(run, 'the secret', name, 'secret');
    const value = await this.#o.secrets.get(extensionSecretRef(extensionId, name));
    await this.#o.audit
      ?.append({
        accountId,
        actor: `ext:${extensionId}`,
        kind: 'secret',
        action: 'extension.secret.read',
        resource: `ext:${extensionId}`,
        decision: 'allowed',
        detail: { extensionId, name, set: value !== null },
      })
      .catch((err: unknown) => this.#log.warn('extension audit failed', { err }));
    return { ok: true as const, value };
  }
}

/** Where an extension's declared secret lives in the vault. */
export function extensionSecretRef(extensionId: string, name: string): string {
  return `secret://extension/${extensionId}/${name}`;
}
