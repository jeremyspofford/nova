// The isolated engine of `script.run` (FR-202, docs/08 §1.1): one QuickJS runtime in its own
// WebAssembly module per script, with no network, filesystem, timers or host objects. The only
// ways out are two host functions handed to a prelude closure (never globals): `log`, capped,
// and `call`, which hands a tool name and JSON arguments to the bridge and returns a promise.
// Everything crossing the boundary is a string; host values never enter the engine.
//
// Limits: a memory limit and a stack limit on the runtime, a CPU budget enforced by the
// interrupt handler (only time spent running script code counts, so a nested call waiting for
// an approval pauses the script without spending its budget), a cap on nested calls, and caps
// on the log and the result. Running out of CPU is uncatchable inside the script.
import {
  DefaultIntrinsics,
  RELEASE_SYNC,
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from 'quickjs-emscripten';

export interface ScriptLimits {
  /** CPU time the script may spend running, in milliseconds. */
  cpuMs: number;
  /** Heap the engine may allocate, in bytes. */
  memoryBytes: number;
  /** Stack the engine may use, in bytes (deep recursion fails with a stack overflow). */
  stackBytes: number;
  /** Nested tool calls one script may make. */
  maxCalls: number;
  /** Characters of `console.log` output kept. */
  logChars: number;
  /** Characters of the JSON result kept. */
  resultChars: number;
}

export const DEFAULT_SCRIPT_LIMITS: ScriptLimits = {
  cpuMs: 5_000,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 128 * 1024,
  maxCalls: 20,
  logChars: 20_000,
  resultChars: 20_000,
};

/** Largest script source and argument payload accepted, in characters. */
export const MAX_SCRIPT_CHARS = 50_000;
export const MAX_CALL_ARGS_CHARS = 1_000_000;

/** What a nested call answers: the tool's result text, or why it failed. */
export type BridgeAnswer =
  { ok: true; text: string } | { ok: false; code: string; message: string };

/** The host side of the engine: nested tool calls, one at a time, in the order made. */
export interface ScriptBridge {
  call(name: string, argsJson: string): Promise<BridgeAnswer>;
}

export type ScriptErrorCode =
  | 'script_error'
  | 'syntax_error'
  | 'cpu_limit'
  | 'memory_limit'
  | 'stack_limit'
  | 'stalled'
  | 'cancelled'
  | 'crashed';

export interface ScriptOutcome {
  ok: boolean;
  /** JSON of the value the script returned (capped), when it finished. */
  resultJson: string | null;
  resultTruncated: boolean;
  error: { code: ScriptErrorCode; message: string } | null;
  log: string;
  logTruncated: boolean;
  cpuMs: number;
  calls: number;
}

export interface ScriptRequest {
  code: string;
  /** JSON given to the script as the global `input`. */
  inputJson: string;
  /** Tool names offered as `tools['name'](args)`; `tools.call(name, args)` takes any name. */
  names: string[];
  limits: ScriptLimits;
  signal?: AbortSignal;
  now?: () => number;
}

// The prelude runs before the script with the host functions as arguments, so the script never
// sees them as globals. It captures the built-ins it uses before the script can replace them.
const PRELUDE = `(function (call, log, namesJson, inputJson) {
  'use strict';
  const stringify = JSON.stringify, parse = JSON.parse, freeze = Object.freeze, S = String, E = Error;
  const show = (v) => {
    if (typeof v === 'string') return v;
    try { const j = stringify(v); return j === undefined ? S(v) : j; }
    catch (e) { try { return S(v); } catch (e2) { return '[unprintable]'; } }
  };
  const out = function () {
    let s = '';
    for (let i = 0; i < arguments.length; i++) s += (i ? ' ' : '') + show(arguments[i]);
    log(s);
  };
  const invoke = (name, args) => {
    let json;
    try { json = stringify(args === undefined ? {} : args); }
    catch (e) { return Promise.reject(new E('the arguments are not JSON')); }
    if (typeof json !== 'string') return Promise.reject(new E('the arguments are not JSON'));
    return call(S(name), json).then((r) => {
      const v = parse(r);
      if (v.ok) return v.text;
      const err = new E(v.message);
      err.code = v.code;
      throw err;
    });
  };
  const names = parse(namesJson);
  const tools = { call: invoke, names: freeze(names.slice()) };
  for (const n of names) tools[n] = (args) => invoke(n, args);
  globalThis.tools = freeze(tools);
  globalThis.console = freeze({ log: out, info: out, warn: out, error: out, debug: out });
  globalThis.input = parse(inputJson);
  const result = (v) => {
    try { const j = stringify(v === undefined ? null : v); return j === undefined ? 'null' : j; }
    catch (e) { return stringify(show(v)); }
  };
  const error = (e) => {
    try {
      if (e !== null && typeof e === 'object')
        return stringify({ name: S(e.name), message: S(e.message), code: typeof e.code === 'string' ? e.code : null });
      return stringify({ name: 'Error', message: S(e), code: null });
    } catch (x) { return '{"name":"Error","message":"an error that cannot be shown","code":null}'; }
  };
  return freeze({ result, error });
})`;

interface Pending {
  deferred: QuickJSDeferredPromise;
  name: string;
  argsJson: string;
}

/**
 * Run one script to completion in a fresh engine. Never throws: every failure, including the
 * engine itself failing, is an outcome.
 */
export async function runScript(req: ScriptRequest, bridge: ScriptBridge): Promise<ScriptOutcome> {
  const now = req.now ?? (() => performance.now());
  const limits = req.limits;
  const state = {
    cpu: 0,
    sliceStart: 0,
    inSlice: false,
    interrupted: false,
    log: '',
    logTruncated: false,
    calls: 0,
  };
  const outcome = (
    ok: boolean,
    resultJson: string | null,
    error: ScriptOutcome['error'],
  ): ScriptOutcome => {
    let result = resultJson;
    let resultTruncated = false;
    if (result !== null && result.length > limits.resultChars) {
      result = result.slice(0, limits.resultChars);
      resultTruncated = true;
    }
    return {
      ok,
      resultJson: result,
      resultTruncated,
      error,
      log: state.log,
      logTruncated: state.logTruncated,
      cpuMs: Math.round(state.cpu),
      calls: state.calls,
    };
  };
  if (req.code.length > MAX_SCRIPT_CHARS)
    return outcome(false, null, {
      code: 'syntax_error',
      message: `the script is longer than ${MAX_SCRIPT_CHARS} characters`,
    });

  let rt: QuickJSRuntime | null = null;
  let ctx: QuickJSContext | null = null;
  const handles: QuickJSHandle[] = [];
  const deferreds: QuickJSDeferredPromise[] = [];
  const queue: Pending[] = [];
  let wake: (() => void) | null = null;
  let draining = false;
  // A failed engine is dropped without freeing it (freeing a broken runtime aborts loudly).
  let broken = false;
  const onAbort = () => wake?.();
  req.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // A module of its own per script: nothing one script does can reach another's engine.
    const mod = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
    rt = mod.newRuntime();
    rt.setMemoryLimit(limits.memoryBytes);
    rt.setMaxStackSize(limits.stackBytes);
    rt.setInterruptHandler(() => {
      if (!state.inSlice) return false;
      if (state.interrupted || state.cpu + (now() - state.sliceStart) > limits.cpuMs) {
        state.interrupted = true;
        return true;
      }
      return false;
    });
    ctx = rt.newContext({ intrinsics: { ...DefaultIntrinsics } });
    const vm = ctx;
    const runtime = rt;

    const slice = <T>(fn: () => T): T => {
      state.sliceStart = now();
      state.inSlice = true;
      try {
        return fn();
      } finally {
        state.cpu += now() - state.sliceStart;
        state.inSlice = false;
      }
    };

    const logFn = vm.newFunction('log', (h) => {
      if (vm.typeof(h) !== 'string' || state.logTruncated) return;
      const text = vm.getString(h);
      const room = limits.logChars - state.log.length;
      if (text.length + 1 > room) {
        state.log += `${text}\n`.slice(0, Math.max(0, room));
        state.logTruncated = true;
      } else state.log += `${text}\n`;
    });
    handles.push(logFn);

    const callFn = vm.newFunction('call', (nameH, argsH) => {
      const deferred = vm.newPromise();
      deferreds.push(deferred);
      const reject = (code: string, message: string) => {
        const h = vm.newString(JSON.stringify({ ok: false, code, message }));
        deferred.resolve(h);
        h.dispose();
      };
      if (vm.typeof(nameH) !== 'string' || vm.typeof(argsH) !== 'string') {
        reject('invalid_arguments', 'a tool name and JSON arguments are needed');
        return deferred.handle;
      }
      const name = vm.getString(nameH);
      const argsJson = vm.getString(argsH);
      if (state.calls >= limits.maxCalls) {
        reject('call_limit', `a script may make at most ${limits.maxCalls} tool calls`);
        return deferred.handle;
      }
      if (name.length > 200 || argsJson.length > MAX_CALL_ARGS_CHARS) {
        reject('invalid_arguments', 'the tool name or the arguments are too large');
        return deferred.handle;
      }
      state.calls++;
      queue.push({ deferred, name, argsJson });
      void drain();
      return deferred.handle;
    });
    handles.push(callFn);

    // Nested calls run one at a time, in the order the script made them (each passes the gate).
    const drain = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        while (queue.length) {
          const p = queue[0]!;
          let answer: BridgeAnswer;
          if (req.signal?.aborted)
            answer = { ok: false, code: 'cancelled', message: 'the script was stopped' };
          else {
            try {
              answer = await bridge.call(p.name, p.argsJson);
            } catch (err) {
              answer = {
                ok: false,
                code: 'tool_error',
                message: err instanceof Error ? err.message : String(err),
              };
            }
          }
          queue.shift();
          if (vm.alive && p.deferred.alive) {
            const h = vm.newString(JSON.stringify(answer));
            p.deferred.resolve(h);
            h.dispose();
          }
          wake?.();
        }
      } finally {
        draining = false;
      }
    };

    // The prelude and the script.
    const preludeR = slice(() => vm.evalCode(PRELUDE, 'prelude.js'));
    if (preludeR.error) {
      preludeR.error.dispose();
      return outcome(false, null, { code: 'crashed', message: 'the script engine did not start' });
    }
    const preludeFn = preludeR.value;
    handles.push(preludeFn);
    const namesH = vm.newString(JSON.stringify(req.names));
    const inputH = vm.newString(req.inputJson);
    handles.push(namesH, inputH);
    const helpersR = slice(() =>
      vm.callFunction(preludeFn, vm.undefined, callFn, logFn, namesH, inputH),
    );
    if (helpersR.error) {
      helpersR.error.dispose();
      return outcome(false, null, { code: 'crashed', message: 'the script input is not JSON' });
    }
    const helpers = helpersR.value;
    handles.push(helpers);
    const resultFn = vm.getProp(helpers, 'result');
    const errorFn = vm.getProp(helpers, 'error');
    handles.push(resultFn, errorFn);

    const describe = (h: QuickJSHandle): { name: string; message: string; code: string | null } => {
      const r = slice(() => vm.callFunction(errorFn, vm.undefined, h));
      if (r.error) {
        r.error.dispose();
        return { name: 'Error', message: 'an error that cannot be shown', code: null };
      }
      const json = vm.typeof(r.value) === 'string' ? vm.getString(r.value) : '';
      r.value.dispose();
      try {
        return JSON.parse(json) as { name: string; message: string; code: string | null };
      } catch {
        return { name: 'Error', message: 'an error that cannot be shown', code: null };
      }
    };
    const failure = (e: { name: string; message: string }): ScriptOutcome['error'] => {
      if (state.interrupted)
        return {
          code: 'cpu_limit',
          message: `the script used more than ${limits.cpuMs} ms of CPU time`,
        };
      if (/out of memory/i.test(e.message))
        return {
          code: 'memory_limit',
          message: `the script used more than ${Math.round(limits.memoryBytes / 1048576)} MiB`,
        };
      if (/stack overflow/i.test(e.message))
        return { code: 'stack_limit', message: 'the script recursed too deeply' };
      if (e.name === 'SyntaxError') return { code: 'syntax_error', message: e.message };
      return { code: 'script_error', message: `${e.name}: ${e.message}` };
    };

    const wrapped = `(async () => {\n${req.code}\n})()`;
    const evalR = slice(() => vm.evalCode(wrapped, 'script.js', { type: 'global', strict: true }));
    if (evalR.error) {
      const e = describe(evalR.error);
      evalR.error.dispose();
      return outcome(false, null, failure(e));
    }
    const main = evalR.value;
    handles.push(main);

    for (;;) {
      const jobs = slice(() => runtime.executePendingJobs());
      if (jobs.error) {
        const e = describe(jobs.error);
        jobs.error.dispose();
        return outcome(false, null, failure(e));
      }
      if (state.interrupted) return outcome(false, null, failure({ name: '', message: '' }));
      const st = vm.getPromiseState(main);
      if (st.type === 'fulfilled') {
        const value = st.value;
        const r = slice(() => vm.callFunction(resultFn, vm.undefined, value));
        if (!('notAPromise' in st && st.notAPromise)) value.dispose();
        if (r.error) {
          const e = describe(r.error);
          r.error.dispose();
          return outcome(false, null, failure(e));
        }
        const json = vm.typeof(r.value) === 'string' ? vm.getString(r.value) : 'null';
        r.value.dispose();
        return outcome(true, json, null);
      }
      if (st.type === 'rejected') {
        const e = describe(st.error);
        st.error.dispose();
        return outcome(false, null, failure(e));
      }
      if (req.signal?.aborted)
        return outcome(false, null, { code: 'cancelled', message: 'the script was stopped' });
      // Nothing can settle the script any more: it awaits something that never comes.
      if (!queue.length)
        return outcome(false, null, {
          code: 'stalled',
          message: 'the script is waiting for something that will never finish',
        });
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (req.signal?.aborted) resolve();
      });
      wake = null;
    }
  } catch (err) {
    // The engine itself failed (the host's stack, a WebAssembly trap): the module is dropped.
    broken = true;
    const message = err instanceof Error ? err.message : String(err);
    if (/call stack/i.test(message))
      return outcome(false, null, { code: 'stack_limit', message: 'the script nested too deeply' });
    return outcome(false, null, { code: 'crashed', message: 'the script engine failed' });
  } finally {
    queue.length = 0;
    req.signal?.removeEventListener('abort', onAbort);
    if (!broken)
      try {
        for (const d of deferreds) if (d.alive) d.dispose();
        for (const h of handles.reverse()) if (h.alive) h.dispose();
        ctx?.dispose();
        rt?.dispose();
      } catch {
        // An engine that cannot free itself is garbage with its module either way.
      }
  }
}
