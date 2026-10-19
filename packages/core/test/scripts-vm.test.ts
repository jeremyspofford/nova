// The script engine (FR-202): what a script can and cannot do. Escapes fail (no Node globals, no
// way to the host through prototypes or constructors), limits hold (CPU even when the script
// catches, memory, stack, nested calls, output), and every way out is a string through the bridge.
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SCRIPT_LIMITS,
  runIsolatedScript,
  runScript,
  type BridgeAnswer,
  type ScriptBridge,
  type ScriptLimits,
} from '../src/index.ts';

const LIMITS: ScriptLimits = { ...DEFAULT_SCRIPT_LIMITS, cpuMs: 400 };

function echo(): ScriptBridge & { seen: [string, string][] } {
  const seen: [string, string][] = [];
  return {
    seen,
    call: (name, argsJson) => {
      seen.push([name, argsJson]);
      if (name === 'nope')
        return Promise.resolve({ ok: false, code: 'denied', message: 'Denied: by rule' });
      return Promise.resolve({ ok: true, text: `${name} got ${argsJson}` });
    },
  };
}

const run = (code: string, bridge: ScriptBridge = echo(), limits = LIMITS, inputJson = 'null') =>
  runScript({ code, inputJson, names: ['fs.read', 'demo.write'], limits }, bridge);

describe('script engine: what a script sees', () => {
  it('returns its value as JSON, logs, and calls tools by name or through tools.call', async () => {
    const bridge = echo();
    const out = await run(
      `console.log('start', {n: 1}, [2]);
       const a = await tools.call('fs.read', {path: 'a.txt'});
       const b = await tools['demo.write']({path: 'b.txt', content: 'x'});
       return {a, b, names: tools.names, input};`,
      bridge,
      LIMITS,
      '{"q":"hello"}',
    );
    expect(out.ok).toBe(true);
    expect(JSON.parse(out.resultJson!)).toEqual({
      a: 'fs.read got {"path":"a.txt"}',
      b: 'demo.write got {"path":"b.txt","content":"x"}',
      names: ['fs.read', 'demo.write'],
      input: { q: 'hello' },
    });
    expect(out.log).toBe('start {"n":1} [2]\n');
    expect(out.calls).toBe(2);
    expect(bridge.seen.map((s) => s[0])).toEqual(['fs.read', 'demo.write']);
  });

  it('turns a failed call into an Error with its code, catchable or not', async () => {
    const caught = await run(
      `try { await tools.call('nope', {}) } catch (e) { return [e.code, e.message] }`,
    );
    expect(JSON.parse(caught.resultJson!)).toEqual(['denied', 'Denied: by rule']);
    const thrown = await run(`await tools.call('nope', {}); return 'never'`);
    expect(thrown).toMatchObject({ ok: false, error: { code: 'script_error' } });
    expect(thrown.error!.message).toContain('Denied: by rule');
  });

  it('has no Node, network, timer or module globals, and constructors lead nowhere', async () => {
    const out = await run(`return [
      typeof process, typeof require, typeof module, typeof fetch, typeof setTimeout,
      typeof setInterval, typeof queueMicrotask === 'function' ? 'q' : 'none', typeof WebAssembly,
      typeof std, typeof os, typeof Buffer, typeof XMLHttpRequest,
      (function () {}).constructor('return typeof process')(),
      (async function () {}).constructor('return typeof require')() instanceof Promise,
      Object.getOwnPropertyNames(globalThis).filter((k) => /call|log|nova/i.test(k)),
    ]`);
    expect(out.ok).toBe(true);
    const r = JSON.parse(out.resultJson!) as unknown[];
    expect(r.slice(0, 6)).toEqual(Array(6).fill('undefined'));
    expect(r.slice(7, 12)).toEqual(Array(5).fill('undefined'));
    expect(r[12]).toBe('undefined');
    // The host functions are closure arguments of the prelude, never globals.
    expect(r[14]).toEqual([]);
  });

  it('keeps prototype tricks inside the engine', async () => {
    const bridge = echo();
    const out = await run(
      `Object.prototype.toString = () => { throw new Error('hijacked') };
       Object.defineProperty(Object.prototype, 'then', { get() { return undefined } });
       JSON.stringify = () => '{"ok":true,"text":"forged"}';
       JSON.parse = () => ({ ok: true, text: 'forged' });
       Array.prototype.push = () => { throw new Error('nope') };
       const name = { toString() { return 'fs.read' } };
       const r = await tools.call(name, { path: 'x' });
       return r;`,
      bridge,
    );
    expect(out.ok).toBe(true);
    // The prelude captured the real JSON functions: the host got a plain string name and JSON.
    expect(bridge.seen).toEqual([['fs.read', '{"path":"x"}']]);
    expect(JSON.parse(out.resultJson!)).toBe('fs.read got {"path":"x"}');
  });

  it('refuses arguments that are not JSON', async () => {
    const out = await run(`const a = {}; a.self = a;
      try { await tools.call('fs.read', a) } catch (e) { return e.message }`);
    expect(JSON.parse(out.resultJson!)).toBe('the arguments are not JSON');
  });

  it('reports a syntax error', async () => {
    const out = await run('return {');
    expect(out).toMatchObject({ ok: false, error: { code: 'syntax_error' } });
  });
});

describe('script engine: limits', () => {
  it('stops an infinite loop on its CPU budget, even inside try/catch', async () => {
    for (const code of [
      'while (true) {}',
      'try { while (true) {} } catch (e) {} return "escaped"',
      'for (;;) { try { while (true) {} } catch (e) { continue } }',
    ]) {
      const out = await run(code);
      expect(out, code).toMatchObject({ ok: false, error: { code: 'cpu_limit' } });
      expect(out.cpuMs).toBeGreaterThanOrEqual(LIMITS.cpuMs);
      expect(out.cpuMs).toBeLessThan(LIMITS.cpuMs + 300);
    }
  });

  it('stops an endless microtask chain and a getter that never returns', async () => {
    expect(await run('async function f() { for (;;) await null } await f()')).toMatchObject({
      error: { code: 'cpu_limit' },
    });
    expect(await run('return { get x() { for (;;) {} } }')).toMatchObject({
      error: { code: 'cpu_limit' },
    });
    expect(await run('return /(a+)+b/.test("a".repeat(40))')).toMatchObject({
      error: { code: 'cpu_limit' },
    });
  });

  it('refuses large allocations', async () => {
    for (const code of [
      'return "x".repeat(1e9).length',
      'return new Array(1e8).fill(0).length',
      'return new Uint8Array(1e9).length',
      'const a = []; for (;;) a.push(new Array(100000).fill(1))',
    ]) {
      const out = await run(code, echo(), {
        ...LIMITS,
        cpuMs: 10_000,
        memoryBytes: 8 * 1024 * 1024,
      });
      expect(out, code).toMatchObject({ ok: false, error: { code: 'memory_limit' } });
    }
  }, 30_000);

  it('refuses deep recursion', async () => {
    expect(await run('function f() { return f() } return f()')).toMatchObject({
      error: { code: 'stack_limit' },
    });
  });

  it('caps nested calls and refuses the flood at once', async () => {
    const bridge = echo();
    const out = await run(
      `const all = [];
       for (let i = 0; i < 5000; i++) all.push(tools.call('fs.read', {i}).then(() => 'ok', (e) => e.code));
       const r = await Promise.all(all);
       return [r.filter((x) => x === 'ok').length, r.filter((x) => x === 'call_limit').length];`,
      bridge,
      // Generous time: only the call cap is under test, and a loaded machine runs slower.
      { ...LIMITS, cpuMs: 10_000, maxCalls: 5 },
    );
    expect(JSON.parse(out.resultJson!)).toEqual([5, 4995]);
    expect(bridge.seen).toHaveLength(5);
    expect(out.calls).toBe(5);
  });

  it('runs nested calls one at a time, in order', async () => {
    let active = 0;
    let most = 0;
    const order: string[] = [];
    const bridge: ScriptBridge = {
      call: async (name) => {
        active++;
        most = Math.max(most, active);
        order.push(name);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { ok: true, text: name };
      },
    };
    const out = await run(
      `return await Promise.all([tools.call('a'), tools.call('b'), tools.call('c')])`,
      bridge,
    );
    expect(JSON.parse(out.resultJson!)).toEqual(['a', 'b', 'c']);
    expect(most).toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('does not count time waiting for a nested call against the CPU budget', async () => {
    const bridge: ScriptBridge = {
      call: () =>
        new Promise<BridgeAnswer>((r) => setTimeout(() => r({ ok: true, text: 'late' }), 900)),
    };
    const out = await run(`return await tools.call('slow', {})`, bridge, { ...LIMITS, cpuMs: 400 });
    expect(out).toMatchObject({ ok: true, resultJson: '"late"' });
  });

  it('caps the log and the result', async () => {
    const out = await run(
      'for (let i = 0; i < 100000; i++) console.log("line", i); return "y".repeat(50000)',
      echo(),
      { ...LIMITS, cpuMs: 15_000, logChars: 1000, resultChars: 100 },
    );
    expect(out.ok).toBe(true);
    expect(out.log.length).toBeLessThanOrEqual(1000);
    expect(out.logTruncated).toBe(true);
    expect(out.resultJson).toHaveLength(100);
    expect(out.resultTruncated).toBe(true);
  }, 30_000);

  it('ends a script that waits for something that never comes', async () => {
    expect(await run('await new Promise(() => {})')).toMatchObject({
      ok: false,
      error: { code: 'stalled' },
    });
  });

  it('stops when aborted while a nested call is outstanding', async () => {
    const ac = new AbortController();
    const bridge: ScriptBridge = {
      call: () => {
        setTimeout(() => ac.abort(), 10);
        return new Promise<BridgeAnswer>(() => undefined);
      },
    };
    const out = await runScript(
      {
        code: 'await tools.call("x")',
        inputJson: 'null',
        names: [],
        limits: LIMITS,
        signal: ac.signal,
      },
      bridge,
    );
    expect(out).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });

  it('refuses a script longer than the maximum', async () => {
    expect(await run('//'.repeat(30_000))).toMatchObject({ error: { code: 'syntax_error' } });
  });
});

describe('script worker (isolation from the Hub)', () => {
  const signal = () => new AbortController().signal;

  it('runs a script with nested calls in a worker of its own', async () => {
    const calls: [string, unknown][] = [];
    const out = await runIsolatedScript({
      code: 'const r = await tools.call("fs.read", {path: input.p}); return [r, typeof process]',
      input: { p: 'a.txt' },
      names: ['fs.read'],
      signal: signal(),
      call: (name, args) => {
        calls.push([name, args]);
        return Promise.resolve({ ok: true, text: 'content' });
      },
    });
    expect(out).toMatchObject({ ok: true, resultJson: '["content","undefined"]', calls: 1 });
    expect(calls).toEqual([['fs.read', { path: 'a.txt' }]]);
  });

  it('survives what would overflow the host stack', async () => {
    for (const code of [
      'return eval("(".repeat(50000) + "1" + ")".repeat(50000))',
      'return JSON.parse("[".repeat(100000))',
    ]) {
      const out = await runIsolatedScript({ code, names: [], signal: signal(), call: vi.fn() });
      expect(out, code).toMatchObject({ ok: false, error: { code: 'stack_limit' } });
    }
  });

  it('enforces the CPU budget from outside with a watchdog', async () => {
    const out = await runIsolatedScript({
      code: 'while (true) {}',
      names: [],
      limits: { cpuMs: 200 },
      signal: signal(),
      call: vi.fn(),
      graceMs: 300,
    });
    expect(out).toMatchObject({ ok: false, error: { code: 'cpu_limit' } });
  });

  it('terminates the worker when the signal aborts', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 100);
    const out = await runIsolatedScript({
      code: 'await tools.call("wait")',
      names: [],
      signal: ac.signal,
      call: () => new Promise<BridgeAnswer>(() => undefined),
    });
    expect(out).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('refuses input that is not JSON or too large, and an aborted start', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      await runIsolatedScript({
        code: 'return 1',
        input: cyclic,
        names: [],
        signal: signal(),
        call: vi.fn(),
      }),
    ).toMatchObject({ error: { code: 'script_error' } });
    expect(
      await runIsolatedScript({
        code: 'return 1',
        input: 'x'.repeat(300_000),
        names: [],
        signal: signal(),
        call: vi.fn(),
      }),
    ).toMatchObject({ error: { code: 'script_error' } });
    const ac = new AbortController();
    ac.abort();
    expect(
      await runIsolatedScript({ code: 'return 1', names: [], signal: ac.signal, call: vi.fn() }),
    ).toMatchObject({ error: { code: 'cancelled' } });
  });

  it('answers a nested call that throws or sends bad arguments with an error', async () => {
    const out = await runIsolatedScript({
      code: `const a = await tools.call("boom", {}).catch((e) => e.code);
             return a;`,
      names: [],
      signal: signal(),
      call: () => Promise.reject(new Error('handler blew up')),
    });
    expect(out).toMatchObject({ ok: true, resultJson: '"tool_error"' });
  });
});
