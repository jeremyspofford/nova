// The engine an extension's code runs in (FR-117; docs/14 §4.2; ADR-097 D3): one QuickJS runtime
// in its own WebAssembly module, inside the extension's worker thread. The code has no Node, no
// filesystem, no network, no host objects: nothing but plain ECMAScript, `console`, timers and the
// `nova` object a prelude builds. Every `nova` call becomes a JSON request the Hub answers after
// checking it against the extension's declared permissions. As in `script.run` (FR-202) the only
// ways out are host functions handed to the prelude closure (never globals), and only strings
// cross the boundary, so no host value ever enters the engine.
//
// Modules: the entry is an ES module; it may import other `.js`/`.mjs` files of the extension by
// relative path, and `@nova/sdk` (a small built-in module). Nothing else resolves.
//
// Limits: a memory limit and a stack limit on the runtime, and a CPU budget per entry into the
// engine (a delivered message with the promise jobs it starts) enforced by the interrupt handler;
// running past it, or out of memory, is a fault the host answers by restarting the worker.
import { posix } from 'node:path';
import {
  DefaultIntrinsics,
  RELEASE_SYNC,
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from 'quickjs-emscripten';

export interface EngineLimits {
  /** Heap the engine may allocate, in bytes. */
  memoryBytes: number;
  /** Stack the engine may use, in bytes. */
  stackBytes: number;
  /** CPU time one entry into the engine may take (a message and the jobs it starts), in ms. */
  sliceMs: number;
  /** Timers an extension may have at once. */
  maxTimers: number;
  /** Largest message the extension may send, in characters. */
  maxMessageChars: number;
  /** Console lines kept per minute; the rest is dropped (with one line saying so). */
  logLinesPerMinute: number;
}

export const DEFAULT_ENGINE_LIMITS: EngineLimits = {
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  sliceMs: 2_000,
  maxTimers: 100,
  maxMessageChars: 8_000_000,
  logLinesPerMinute: 300,
};

export type EngineLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type EngineFault = 'cpu' | 'memory' | 'crash';

/** The engine's side of the worker: where its messages and console lines go. */
export interface EngineHost {
  /** A JSON message from the extension: a request, an invocation's answer or `activated`. */
  send(json: string): void;
  log(level: EngineLogLevel, text: string): void;
  /** The engine cannot go on (CPU or memory limit, or the engine itself failed). */
  fault(kind: EngineFault, message: string): void;
}

export interface EngineStart {
  extensionId: string;
  api: number;
  /** The entry module's path, relative to the extension folder. */
  entry: string;
  /** Every module the extension may load, by relative path. */
  sources: Record<string, string>;
}

/** The module `import ... from '@nova/sdk'` resolves to inside the engine. */
export const SDK_MODULE_NAME = '@nova/sdk';
const UNRESOLVED = 'nova-unresolved:';
const SDK_MODULE = `export const API_VERSION = 1;
export function defineExtension(extension) { return extension; }
export const nova = globalThis.nova;
export default { API_VERSION, defineExtension, nova };
`;

// The prelude runs before any extension code with the host functions as arguments, so the code
// never sees them as globals. It captures the built-ins it uses before the code can replace them.
const PRELUDE = `(function (send, log, timer, infoJson) {
  'use strict';
  const stringify = JSON.stringify, parse = JSON.parse, freeze = Object.freeze;
  const S = String, E = Error, TE = TypeError, P = Promise, M = Map, isArray = Array.isArray;
  const info = parse(infoJson);
  const show = (v) => {
    if (typeof v === 'string') return v;
    try { const j = stringify(v); return j === undefined ? S(v) : j; }
    catch (e) { try { return S(v); } catch (e2) { return '[unprintable]'; } }
  };
  const logger = (level) => function () {
    let s = '';
    for (let i = 0; i < arguments.length; i++) s += (i ? ' ' : '') + show(arguments[i]);
    log(level, s);
  };
  const errorOf = (e) => {
    try {
      if (e !== null && typeof e === 'object')
        return { code: typeof e.code === 'string' ? e.code : 'extension_error', message: S(e.message) };
      return { code: 'extension_error', message: S(e) };
    } catch (x) { return { code: 'extension_error', message: 'an error that cannot be shown' }; }
  };
  const post = (m) => {
    let j;
    try { j = stringify(m); } catch (e) { j = undefined; }
    if (typeof j !== 'string')
      j = stringify({ t: m.t, id: m.id, ok: false, error: { code: 'not_json', message: 'the value is not JSON' } });
    send(j);
  };
  const toError = (err) => {
    const e = new E(err && err.message ? S(err.message) : 'the request failed');
    e.code = err && err.code ? S(err.code) : 'error';
    return e;
  };
  let next = 1;
  const pending = new M();
  const request = (op, args) => new P((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    post({ t: 'req', id, op, args: args === undefined ? null : args });
  });
  const handlers = { command: new M(), tool: new M(), hook: new M(), event: new M(), status: new M(), lifecycle: new M() };
  const register = (kind, key, handler, payload) => {
    const table = handlers[kind];
    if (table && handler) table.set(key, handler);
    const args = { kind, key };
    for (const k in payload) args[k] = payload[k];
    const ready = request('register', args);
    ready.then(null, (err) => {
      if (table && table.get(key) === handler) table.delete(key);
      log('error', 'nova: the ' + kind + ' ' + key + ' was refused: ' + (err && err.message));
    });
    let disposed = false;
    return {
      ready: ready.then(() => undefined),
      dispose() {
        if (disposed) return;
        disposed = true;
        if (table && table.get(key) === handler) table.delete(key);
        post({ t: 'req', id: 0, op: 'unregister', args: { kind, key } });
      },
    };
  };
  const need = (cond, what) => { if (!cond) throw new TE(what); };
  const str = (v) => (typeof v === 'string' ? v : undefined);
  let sub = 1, menu = 1;
  const nova = freeze({
    api: info.api,
    extensionId: info.extensionId,
    commands: freeze({
      register(c) {
        need(c && typeof c.id === 'string' && typeof c.run === 'function', 'commands.register needs {id, title, run}');
        return freeze(register('command', c.id, c.run, { id: c.id, title: S(c.title === undefined ? c.id : c.title) }));
      },
    }),
    panels: freeze({
      register(p) {
        need(p && typeof p.id === 'string', 'panels.register needs {id, title, resource, entryPoint}');
        return freeze(register('panel', p.id, null, {
          id: p.id, title: str(p.title), resource: str(p.resource), entryPoint: str(p.entryPoint),
          extensions: isArray(p.extensions) ? p.extensions.map(S) : undefined,
        }));
      },
    }),
    tools: freeze({
      register(t) {
        need(t && typeof t.name === 'string' && typeof t.handler === 'function', 'tools.register needs {name, title, description, inputSchema, handler}');
        return freeze(register('tool', t.name, t.handler, {
          name: t.name, title: str(t.title), description: str(t.description), inputSchema: t.inputSchema,
          outputSchema: t.outputSchema, annotations: t.annotations,
        }));
      },
    }),
    hooks: freeze({
      register(h) {
        need(h && typeof h.id === 'string' && typeof h.handler === 'function', 'hooks.register needs {id, event, handler}');
        return freeze(register('hook', h.id, h.handler, { id: h.id, event: str(h.event), matcher: h.matcher }));
      },
    }),
    themes: freeze({
      register(theme) {
        need(theme && typeof theme.id === 'string', 'themes.register needs a theme with an id');
        return freeze(register('theme', theme.id, null, { theme }));
      },
    }),
    keybindings: freeze({
      register(b) {
        need(b && typeof b.command === 'string' && typeof b.key === 'string', 'keybindings.register needs {command, key}');
        return freeze(register('keybinding', b.command + ' ' + b.key, null, { command: b.command, key: b.key, when: str(b.when) }));
      },
    }),
    events: freeze({
      on(name, fn) {
        need(typeof name === 'string' && typeof fn === 'function', 'events.on needs a name and a function');
        return freeze(register('event', 'e' + (sub++), fn, { name }));
      },
    }),
    menus: freeze({
      register(m) {
        need(m && typeof m.where === 'string' && isArray(m.items), 'menus.register needs {where, items}');
        return freeze(register('menu', m.where + '#' + (menu++), null, { where: m.where, items: m.items }));
      },
    }),
    status: freeze({
      addItem(item) {
        need(item && typeof item.id === 'string', 'status.addItem needs {id, text}');
        const click = typeof item.onClick === 'function' ? item.onClick : null;
        const r = register('status', item.id, click, {
          id: item.id, text: S(item.text === undefined ? '' : item.text),
          command: typeof item.onClick === 'string' ? item.onClick : undefined, clickable: !!click,
        });
        return freeze({
          ready: r.ready,
          dispose: r.dispose,
          update(text) { post({ t: 'req', id: 0, op: 'status.update', args: { key: item.id, text: S(text) } }); },
        });
      },
    }),
    net: freeze({
      fetch(url, init) {
        const o = init || {};
        return request('net.fetch', {
          url: S(url), method: o.method === undefined ? 'GET' : S(o.method),
          headers: o.headers || {}, body: o.body === undefined || o.body === null ? null : S(o.body),
        }).then((r) => freeze({
          ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.statusText,
          headers: freeze(r.headers || {}), truncated: !!r.truncated,
          text: () => P.resolve(r.encoding === 'base64' ? '' : r.body),
          json: () => P.resolve().then(() => parse(r.body)),
          base64: () => P.resolve(r.encoding === 'base64' ? r.body : null),
        }));
      },
    }),
    fs: freeze({
      read: (path) => request('fs.read', { path: S(path) }),
      write: (path, text) => request('fs.write', { path: S(path), text: S(text) }),
      list: (path) => request('fs.list', { path: S(path) }),
      remove: (path) => request('fs.remove', { path: S(path) }),
    }),
    secrets: freeze({ get: (name) => request('secrets.get', { name: S(name) }) }),
    log: logger('info'),
  });
  let tnext = 1;
  const timers = new M();
  const setT = (repeat) => function (fn, ms) {
    need(typeof fn === 'function', 'a timer needs a function');
    const args = [];
    for (let i = 2; i < arguments.length; i++) args.push(arguments[i]);
    const id = tnext++;
    if (!timer(repeat ? 'interval' : 'timeout', id, +ms || 0)) throw new E('too many timers');
    timers.set(id, { fn, args, repeat });
    return id;
  };
  const clearT = (id) => { if (timers.delete(id)) timer('clear', id, 0); };
  globalThis.nova = nova;
  globalThis.console = freeze({
    log: logger('info'), info: logger('info'), warn: logger('warn'), error: logger('error'), debug: logger('debug'),
  });
  globalThis.setTimeout = setT(false);
  globalThis.setInterval = setT(true);
  globalThis.clearTimeout = clearT;
  globalThis.clearInterval = clearT;
  globalThis.queueMicrotask = (fn) => { P.resolve().then(() => fn()); };
  const run = (m) => {
    const table = handlers[m.kind];
    const fn = table ? table.get(m.key) : undefined;
    if (typeof fn !== 'function') {
      post({ t: 'done', id: m.id, ok: false, error: { code: 'not_registered', message: 'the ' + m.kind + ' ' + m.key + ' is not registered' } });
      return;
    }
    let p;
    try { p = P.resolve(fn(m.args, m.ctx)); } catch (e) { p = P.reject(e); }
    p.then(
      (v) => post({ t: 'done', id: m.id, ok: true, value: v === undefined ? null : v }),
      (e) => post({ t: 'done', id: m.id, ok: false, error: errorOf(e) }),
    );
  };
  const deliver = (json) => {
    let m;
    try { m = parse(json); } catch (e) { return; }
    if (m.t === 'res') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value); else p.reject(toError(m.error));
    } else if (m.t === 'timer') {
      const t = timers.get(m.id);
      if (!t) return;
      if (!t.repeat) timers.delete(m.id);
      try { t.fn.apply(undefined, t.args); } catch (e) { log('error', 'a timer failed: ' + errorOf(e).message); }
    } else if (m.t === 'invoke') run(m);
  };
  const activate = (ns) => {
    const own = (o, k) => (o !== null && typeof o === 'object' && typeof o[k] === 'function' ? o[k] : null);
    const fn = own(ns, 'activate') || own(ns && ns.default, 'activate');
    const off = own(ns, 'deactivate') || own(ns && ns.default, 'deactivate');
    if (off) handlers.lifecycle.set('deactivate', () => off());
    let p;
    try { p = P.resolve(fn ? fn(nova) : undefined); } catch (e) { p = P.reject(e); }
    p.then(
      () => post({ t: 'activated', ok: true }),
      (e) => post({ t: 'activated', ok: false, error: errorOf(e) }),
    );
  };
  return freeze({ deliver, activate });
})`;

/** Normalize an import inside the extension: relative paths stay inside it; `@nova/sdk` is built in. */
export function resolveExtensionImport(
  base: string,
  requested: string,
  sources: Readonly<Record<string, string>>,
): string | null {
  if (requested === SDK_MODULE_NAME) return SDK_MODULE_NAME;
  if (!requested.startsWith('./') && !requested.startsWith('../')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(base), requested));
  if (joined.startsWith('../') || joined === '..' || joined.startsWith('/')) return null;
  return Object.hasOwn(sources, joined) ? joined : null;
}

const SPECIFIER =
  /(?:^|[;\n}])\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[;\n}])\s*import\s*['"]([^'"]+)['"]/g;

/** Module specifiers a file names statically (`import … from`, `export … from`, `import '…'`). */
export function moduleSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(SPECIFIER)) {
    const s = m[1] ?? m[2];
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

const TOO_LARGE = (id: number, kind: 'done' | 'res', limit: number) =>
  JSON.stringify({
    t: kind,
    id,
    ok: false,
    error: { code: 'too_large', message: `the message is larger than ${limit} characters` },
  });

/** `Name: message` of a dumped engine error. */
function errorText(d: unknown): string {
  if (d && typeof d === 'object') {
    const e = d as { name?: unknown; message?: unknown };
    const name = typeof e.name === 'string' ? e.name : 'Error';
    const message = typeof e.message === 'string' ? e.message : '';
    return `${name}: ${message}`;
  }
  return typeof d === 'string' ? d : (JSON.stringify(d) ?? 'error');
}

/** A dumped error with where it happened: `SyntaxError: … (at extension.js:3)`. */
function located(d: unknown): string {
  const text = errorText(d);
  const stack =
    d && typeof d === 'object' && typeof (d as { stack?: unknown }).stack === 'string'
      ? (d as { stack: string }).stack
      : '';
  const at = /at ([^\s:()]+\.m?js):(\d+)/.exec(stack);
  return at ? `${text} (at ${at[1]}:${at[2]})` : text;
}

export class ExtensionEngine {
  readonly #rt: QuickJSRuntime;
  readonly #vm: QuickJSContext;
  readonly #host: EngineHost;
  readonly #limits: EngineLimits;
  readonly #start: EngineStart;
  readonly #now: () => number;
  readonly #handles: QuickJSHandle[] = [];
  readonly #timers = new Map<number, ReturnType<typeof setTimeout>>();
  #deliverFn: QuickJSHandle | null = null;
  #activateFn: QuickJSHandle | null = null;
  #sliceStart = 0;
  #inSlice = false;
  #interrupted = false;
  #broken: string | null = null;
  #disposed = false;
  #logWindow = 0;
  #logCount = 0;
  #logDropped = false;

  private constructor(
    rt: QuickJSRuntime,
    vm: QuickJSContext,
    start: EngineStart,
    host: EngineHost,
    limits: EngineLimits,
    now: () => number,
  ) {
    this.#rt = rt;
    this.#vm = vm;
    this.#start = start;
    this.#host = host;
    this.#limits = limits;
    this.#now = now;
  }

  /** A fresh engine with the prelude in place; the extension's code has not run yet. */
  static async create(
    start: EngineStart,
    host: EngineHost,
    over: Partial<EngineLimits> = {},
    opts: { now?: () => number } = {},
  ): Promise<ExtensionEngine> {
    const limits = { ...DEFAULT_ENGINE_LIMITS, ...over };
    // A module of its own per engine: nothing one extension does can reach another's.
    const mod = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
    const rt = mod.newRuntime();
    rt.setMemoryLimit(limits.memoryBytes);
    rt.setMaxStackSize(limits.stackBytes);
    const sources = start.sources;
    rt.setModuleLoader(
      (name) => {
        if (name === SDK_MODULE_NAME) return SDK_MODULE;
        if (name.startsWith(UNRESOLVED))
          return {
            error: new Error(
              `cannot import ${name.slice(UNRESOLVED.length)}: only the extension's own files (./…) and @nova/sdk resolve`,
            ),
          };
        const text = Object.hasOwn(sources, name) ? sources[name] : undefined;
        return text === undefined ? { error: new Error(`module not found: ${name}`) } : text;
      },
      // An import that does not resolve gets a name the loader refuses with the reason.
      (base, requested) =>
        resolveExtensionImport(base, requested, sources) ?? `${UNRESOLVED}${requested}`,
    );
    const vm = rt.newContext({ intrinsics: { ...DefaultIntrinsics } });
    const engine = new ExtensionEngine(rt, vm, start, host, limits, opts.now ?? (() => Date.now()));
    engine.#install();
    return engine;
  }

  /** Why the engine stopped working, or null. */
  get broken(): string | null {
    return this.#broken;
  }

  /**
   * Run engine code under the CPU budget. A fresh slice starts the clock; the promise jobs an entry
   * starts continue its slice (`fresh` false), so a chain of jobs that never ends runs out of the
   * same budget instead of getting a new one per batch (M8 supply review).
   */
  #slice<T>(fn: () => T, fresh = true): T {
    if (fresh) this.#sliceStart = this.#now();
    this.#inSlice = true;
    try {
      return fn();
    } finally {
      this.#inSlice = false;
    }
  }

  #install(): void {
    const vm = this.#vm;
    this.#rt.setInterruptHandler(() => {
      if (!this.#inSlice) return false;
      if (this.#interrupted || this.#now() - this.#sliceStart > this.#limits.sliceMs) {
        this.#interrupted = true;
        return true;
      }
      return false;
    });
    const send = vm.newFunction('send', (h) => {
      if (vm.typeof(h) !== 'string') return;
      this.#send(vm.getString(h));
    });
    const log = vm.newFunction('log', (levelH, textH) => {
      const level = vm.typeof(levelH) === 'string' ? vm.getString(levelH) : 'info';
      const text = vm.typeof(textH) === 'string' ? vm.getString(textH) : '';
      this.#log(level, text);
    });
    const timer = vm.newFunction('timer', (opH, idH, msH) => {
      const op = vm.typeof(opH) === 'string' ? vm.getString(opH) : '';
      const id = vm.typeof(idH) === 'number' ? vm.getNumber(idH) : -1;
      const ms = vm.typeof(msH) === 'number' ? vm.getNumber(msH) : 0;
      return this.#timer(op, id, ms) ? vm.true : vm.false;
    });
    this.#handles.push(send, log, timer);
    const preludeR = this.#slice(() => vm.evalCode(PRELUDE, 'nova-prelude.js'));
    if (preludeR.error) {
      preludeR.error.dispose();
      throw new Error('the extension engine did not start');
    }
    const prelude = preludeR.value;
    this.#handles.push(prelude);
    const info = vm.newString(
      JSON.stringify({ extensionId: this.#start.extensionId, api: this.#start.api }),
    );
    this.#handles.push(info);
    const r = this.#slice(() => vm.callFunction(prelude, vm.undefined, send, log, timer, info));
    if (r.error) {
      r.error.dispose();
      throw new Error('the extension engine did not start');
    }
    this.#handles.push(r.value);
    this.#deliverFn = vm.getProp(r.value, 'deliver');
    this.#activateFn = vm.getProp(r.value, 'activate');
    this.#handles.push(this.#deliverFn, this.#activateFn);
  }

  #send(json: string): void {
    if (json.length > this.#limits.maxMessageChars) {
      const m = /^\{"t":"(done|req)","id":(\d+)/.exec(json);
      this.#log('error', `a message of ${json.length} characters was dropped (too large)`);
      if (m?.[1] === 'done')
        this.#host.send(TOO_LARGE(Number(m[2]), 'done', this.#limits.maxMessageChars));
      else if (m?.[1] === 'req' && Number(m[2]) > 0)
        queueMicrotask(() =>
          this.deliver(TOO_LARGE(Number(m[2]), 'res', this.#limits.maxMessageChars)),
        );
      return;
    }
    try {
      this.#host.send(json);
    } catch {
      // The host's problem; the engine carries on.
    }
  }

  #log(level: string, text: string): void {
    const now = this.#now();
    if (now - this.#logWindow > 60_000) {
      this.#logWindow = now;
      this.#logCount = 0;
      this.#logDropped = false;
    }
    if (++this.#logCount > this.#limits.logLinesPerMinute) {
      if (!this.#logDropped) {
        this.#logDropped = true;
        this.#host.log('warn', 'console output dropped: too many lines this minute');
      }
      return;
    }
    const lvl: EngineLogLevel =
      level === 'debug' || level === 'warn' || level === 'error' ? level : 'info';
    this.#host.log(lvl, text.length > 4000 ? `${text.slice(0, 3999)}…` : text);
  }

  #timer(op: string, id: number, ms: number): boolean {
    if (this.#disposed || this.#broken) return false;
    if (op === 'clear') {
      const t = this.#timers.get(id);
      if (t) {
        clearTimeout(t);
        clearInterval(t);
        this.#timers.delete(id);
      }
      return true;
    }
    if (op !== 'timeout' && op !== 'interval') return false;
    if (this.#timers.size >= this.#limits.maxTimers) return false;
    const delay = Math.min(
      Math.max(Number.isFinite(ms) ? ms : 0, op === 'interval' ? 10 : 0),
      86_400_000,
    );
    const fire = () => {
      if (op === 'timeout') this.#timers.delete(id);
      this.deliver(JSON.stringify({ t: 'timer', id }));
    };
    const handle = op === 'interval' ? setInterval(fire, delay) : setTimeout(fire, delay);
    handle.unref();
    this.#timers.set(id, handle);
    return true;
  }

  /** A failed entry: a fault when it hit a limit, else a console line. */
  #failed(error: QuickJSHandle, what: string): void {
    let text = 'error';
    try {
      text = errorText(this.#vm.dump(error));
    } catch {
      // keep the generic text
    }
    error.dispose();
    if (this.#interrupted)
      return this.#fault(
        'cpu',
        `the extension ran for more than ${this.#limits.sliceMs} ms without yielding`,
      );
    if (/out of memory/i.test(text))
      return this.#fault(
        'memory',
        `the extension used more than ${Math.round(this.#limits.memoryBytes / 1048576)} MiB`,
      );
    if (/stack overflow/i.test(text))
      return this.#fault('memory', 'the extension recursed too deeply');
    this.#log('error', `${what}: ${text}`);
  }

  #fault(kind: EngineFault, message: string): void {
    if (this.#broken) return;
    this.#broken = message;
    for (const t of this.#timers.values()) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.#timers.clear();
    this.#host.fault(kind, message);
  }

  /** Run the promise jobs the last entry started, within the same CPU budget per batch. */
  #pump(): void {
    for (let i = 0; i < 10_000 && !this.#broken; i++) {
      const r = this.#slice(() => this.#rt.executePendingJobs(256), false);
      if (r.error) {
        this.#failed(r.error, 'a promise job failed');
        if (this.#broken) return;
        continue;
      }
      // The budget ran out inside a promise job, which turns the interrupt into a rejection: the
      // slice still spent it, so the engine stops all the same.
      if (this.#interrupted)
        return this.#fault(
          'cpu',
          `the extension ran for more than ${this.#limits.sliceMs} ms without yielding`,
        );
      if (r.value === 0) return;
    }
    // Still jobs after this many batches: an endless chain, whatever the clock says.
    if (!this.#broken) this.#fault('cpu', 'the extension kept scheduling promise jobs without end');
  }

  /** Evaluate the entry module and call its `activate(nova)`; the result arrives as `activated`. */
  start(): void {
    if (this.#broken || this.#disposed) return;
    const vm = this.#vm;
    const entry = this.#start.entry;
    const source = this.#start.sources[entry];
    if (source === undefined) {
      this.#send(
        JSON.stringify({
          t: 'activated',
          ok: false,
          error: { code: 'not_found', message: `the entry module ${entry} is missing` },
        }),
      );
      return;
    }
    const r = this.#slice(() => vm.evalCode(source, entry, { type: 'module' }));
    if (r.error) {
      let message = 'the entry module failed';
      try {
        message = located(vm.dump(r.error));
      } catch {
        // generic message
      }
      if (this.#interrupted || /out of memory|stack overflow/i.test(message)) {
        this.#failed(r.error, 'the entry module failed');
        return;
      }
      r.error.dispose();
      this.#send(
        JSON.stringify({ t: 'activated', ok: false, error: { code: 'start_failed', message } }),
      );
      return;
    }
    this.#pump();
    if (this.#broken) {
      r.value.dispose();
      return;
    }
    const handle = r.value;
    const st = vm.getPromiseState(handle);
    if (st.type === 'fulfilled') {
      this.#activate(st.value);
      if (!('notAPromise' in st && st.notAPromise)) st.value.dispose();
      handle.dispose();
      return;
    }
    if (st.type === 'rejected') {
      let message = 'the entry module failed while it loaded';
      try {
        message = located(vm.dump(st.error));
      } catch {
        // generic message
      }
      st.error.dispose();
      handle.dispose();
      this.#send(
        JSON.stringify({ t: 'activated', ok: false, error: { code: 'start_failed', message } }),
      );
      return;
    }
    // Top-level await still pending: activate once the module settles (later deliveries pump it).
    void vm.resolvePromise(handle).then((res) => {
      handle.dispose();
      if (this.#disposed || this.#broken) {
        if (res.error) res.error.dispose();
        else res.value.dispose();
        return;
      }
      if (res.error) {
        res.error.dispose();
        this.#send(
          JSON.stringify({
            t: 'activated',
            ok: false,
            error: { code: 'start_failed', message: 'the entry module failed while it loaded' },
          }),
        );
        return;
      }
      this.#activate(res.value);
      res.value.dispose();
    });
  }

  #activate(ns: QuickJSHandle): void {
    const fn = this.#activateFn;
    if (!fn) return;
    const r = this.#slice(() => this.#vm.callFunction(fn, this.#vm.undefined, ns));
    if (r.error) this.#failed(r.error, 'activate failed');
    else r.value.dispose();
    this.#pump();
  }

  /** A message from the Hub: an answer to a request, an invocation, or a timer firing. */
  deliver(json: string): void {
    if (this.#broken || this.#disposed || !this.#deliverFn) return;
    const vm = this.#vm;
    const fn = this.#deliverFn;
    const arg = vm.newString(json);
    const r = this.#slice(() => vm.callFunction(fn, vm.undefined, arg));
    arg.dispose();
    if (r.error) this.#failed(r.error, 'a message could not be delivered');
    else r.value.dispose();
    if (!this.#broken) this.#pump();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const t of this.#timers.values()) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.#timers.clear();
    // A failed engine is dropped without freeing it (freeing a broken runtime aborts loudly); its
    // worker is terminated anyway.
    if (this.#broken) return;
    try {
      for (const h of this.#handles.reverse()) if (h.alive) h.dispose();
      this.#vm.dispose();
      this.#rt.dispose();
    } catch {
      // the worker ends next
    }
  }
}

/**
 * Whether an extension's modules load (`nova validate`): the entry is evaluated in a throwaway
 * engine, the same way the Hub loads it, so syntax errors, imports that do not resolve and a
 * module that throws while it loads are reported with the file and line. Nothing it does can leave
 * the engine; `activate` runs but its outcome is not judged (it needs the Hub's answers).
 */
export async function checkExtensionModules(
  entry: string,
  sources: Readonly<Record<string, string>>,
): Promise<{ file: string; message: string }[]> {
  const out: { file: string; message: string }[] = [];
  const engine = await ExtensionEngine.create(
    { extensionId: 'nova.validate', api: 1, entry, sources: { ...sources } },
    {
      send: (json) => {
        const m = JSON.parse(json) as {
          t?: string;
          ok?: boolean;
          error?: { code?: string; message?: string };
        };
        if (m.t === 'activated' && m.ok === false && m.error?.code !== 'extension_error')
          out.push({
            file: fileOf(m.error?.message) ?? entry,
            message: m.error?.message ?? 'it does not load',
          });
      },
      log: () => undefined,
      fault: (_kind, message) => out.push({ file: entry, message }),
    },
    { sliceMs: 2_000 },
  );
  try {
    engine.start();
  } finally {
    engine.dispose();
  }
  return out;
}

/** The file of a `… (at file.js:3)` message. */
function fileOf(message: string | undefined): string | null {
  const m = /\(at ([^:()]+):\d+\)$/.exec(message ?? '');
  return m?.[1] ?? null;
}
