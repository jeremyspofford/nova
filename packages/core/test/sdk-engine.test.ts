// The engine extension code runs in (FR-117; ADR-097 D3), driven directly without a worker: the
// entry module and its imports (relative files and @nova/sdk only), activate and requests that
// wait for the Hub's answers, invocations, timers, no ambient authority (no Node, no host objects,
// a Function constructor that reaches nothing), the CPU and memory limits as faults, oversized
// messages, the console cap, and deactivate.
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExtensionEngine,
  moduleSpecifiers,
  resolveExtensionImport,
  type EngineFault,
} from '../src/index.ts';

interface Harness {
  engine: ExtensionEngine;
  sent: Record<string, unknown>[];
  logs: string[];
  faults: { kind: EngineFault; message: string }[];
  /** Answer requests automatically: op → value (or an error). */
  answers: Record<string, unknown>;
}

const engines: ExtensionEngine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});

async function harness(
  sources: Record<string, string>,
  opts: { entry?: string; limits?: Parameters<typeof ExtensionEngine.create>[2] } = {},
): Promise<Harness> {
  const h = { sent: [], logs: [], faults: [], answers: {} } as unknown as Harness;
  h.engine = await ExtensionEngine.create(
    { extensionId: 'com.example.t', api: 1, entry: opts.entry ?? 'main.js', sources },
    {
      send: (json) => {
        const m = JSON.parse(json) as Record<string, unknown>;
        h.sent.push(m);
        if (m.t === 'req' && typeof m.id === 'number' && m.id > 0) {
          const op = String(m.op);
          const answer = Object.hasOwn(h.answers, op) ? h.answers[op] : null;
          setImmediate(() =>
            h.engine.deliver(
              JSON.stringify(
                answer instanceof Error
                  ? {
                      t: 'res',
                      id: m.id,
                      ok: false,
                      error: { code: 'policy_denied', message: answer.message },
                    }
                  : { t: 'res', id: m.id, ok: true, value: answer },
              ),
            ),
          );
        }
      },
      log: (level, text) => h.logs.push(`${level} ${text}`),
      fault: (kind, message) => h.faults.push({ kind, message }),
    },
    opts.limits,
  );
  engines.push(h.engine);
  return h;
}

const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const done = (h: Harness, id: number) => h.sent.find((m) => m.t === 'done' && m.id === id);
const activated = (h: Harness) => h.sent.find((m) => m.t === 'activated');

function invoke(h: Harness, id: number, kind: string, key: string, args: unknown = null) {
  h.engine.deliver(JSON.stringify({ t: 'invoke', id, kind, key, args, ctx: { origin: 'user' } }));
}

describe('modules and activation', () => {
  it('loads the entry with relative imports and @nova/sdk, activates and answers invocations', async () => {
    const h = await harness({
      'main.js': `import { greet } from './lib/greet.js';
import { API_VERSION, defineExtension } from '@nova/sdk';
export default defineExtension({
  async activate(nova) {
    nova.commands.register({ id: 'c', title: 'C', run: async (args) => greet(args.name) + ' v' + API_VERSION });
    const v = await nova.secrets.get('s');
    console.log('secret is', v);
  },
});`,
      'lib/greet.js': "export const greet = (n) => 'Hello, ' + n;",
    });
    h.answers['secrets.get'] = 'xyz';
    h.engine.start();
    await until(() => activated(h) !== undefined);
    expect(activated(h)).toEqual({ t: 'activated', ok: true });
    expect(h.sent[0]).toMatchObject({
      t: 'req',
      op: 'register',
      args: { kind: 'command', key: 'c', title: 'C' },
    });
    expect(h.logs).toContain('info secret is xyz');
    invoke(h, 9, 'command', 'c', { name: 'Ada' });
    await until(() => done(h, 9) !== undefined);
    expect(done(h, 9)).toEqual({ t: 'done', id: 9, ok: true, value: 'Hello, Ada v1' });
    invoke(h, 10, 'command', 'nope');
    await until(() => done(h, 10) !== undefined);
    expect(done(h, 10)).toMatchObject({ ok: false, error: { code: 'not_registered' } });
  });

  it('refuses imports from outside the extension', async () => {
    expect(resolveExtensionImport('a/b.js', '../c.js', { 'c.js': '' })).toBe('c.js');
    expect(resolveExtensionImport('a.js', '../c.js', { 'c.js': '' })).toBeNull();
    expect(resolveExtensionImport('a.js', 'node:fs', {})).toBeNull();
    expect(resolveExtensionImport('a.js', '/etc/passwd', {})).toBeNull();
    expect(
      moduleSpecifiers("import a from './a.js';\nexport * from \"./b.js\";\nimport './c.js';"),
    ).toEqual(['./a.js', './b.js', './c.js']);
    const h = await harness({
      'main.js': "import fs from 'node:fs'; export function activate() {}",
    });
    h.engine.start();
    await until(() => activated(h) !== undefined);
    expect(activated(h)).toMatchObject({ ok: false, error: { code: 'start_failed' } });
    expect(JSON.stringify(activated(h))).toMatch(/node:fs/);
  });

  it('reports a throwing activate, a missing entry and a module that fails to load', async () => {
    const a = await harness({
      'main.js': "export function activate() { throw new Error('nope'); }",
    });
    a.engine.start();
    await until(() => activated(a) !== undefined);
    expect(activated(a)).toEqual({
      t: 'activated',
      ok: false,
      error: { code: 'extension_error', message: 'nope' },
    });
    const b = await harness({ 'main.js': '' }, { entry: 'other.js' });
    b.engine.start();
    expect(activated(b)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    const c = await harness({ 'main.js': "throw new Error('at load');" });
    c.engine.start();
    await until(() => activated(c) !== undefined);
    expect(activated(c)).toMatchObject({ ok: false });
  });

  it('waits for a top-level await before activating', async () => {
    const h = await harness({
      'main.js': `const v = await nova.secrets.get('k');
export function activate(n) { n.log('top', v); }`,
    });
    h.answers['secrets.get'] = 'later';
    h.engine.start();
    await until(() => activated(h) !== undefined);
    expect(activated(h)).toEqual({ t: 'activated', ok: true });
    expect(h.logs).toContain('info top later');
  });
});

describe('isolation', () => {
  it('has no Node, no host functions and a Function constructor that reaches nothing', async () => {
    const h = await harness({
      'main.js': `export function activate(nova) {
  const probe = Object.getPrototypeOf(nova.commands.register).constructor;
  console.log(JSON.stringify([
    typeof process, typeof require, typeof send, typeof log, typeof timer, typeof fetch,
    probe('return typeof process')(), typeof globalThis.nova, Object.isFrozen(nova),
  ]));
  try { nova.commands = null; } catch (e) { console.log('frozen'); }
}`,
    });
    h.engine.start();
    await until(() => activated(h) !== undefined);
    expect(h.logs).toContain(
      'info ["undefined","undefined","undefined","undefined","undefined","undefined","undefined","object",true]',
    );
    expect(h.logs).toContain('info frozen');
  });

  it('turns a runaway loop into a CPU fault; the engine takes nothing more', async () => {
    const h = await harness(
      {
        'main.js':
          "export function activate(nova) { nova.commands.register({ id: 'spin', run() { for (;;) {} } }); }",
      },
      { limits: { sliceMs: 100 } },
    );
    h.engine.start();
    await until(() => activated(h) !== undefined);
    invoke(h, 1, 'command', 'spin');
    expect(h.faults[0]?.kind).toBe('cpu');
    expect(h.engine.broken).toMatch(/100 ms/);
    invoke(h, 2, 'command', 'spin');
    expect(done(h, 2)).toBeUndefined();
  });

  it('turns running out of memory into a memory fault', async () => {
    const h = await harness(
      {
        'main.js': `export function activate(nova) {
  nova.commands.register({ id: 'grow', run() { const a = []; for (;;) a.push(new Array(100000).fill(1)); } });
}`,
      },
      { limits: { memoryBytes: 8 * 1024 * 1024, sliceMs: 10_000 } },
    );
    h.engine.start();
    await until(() => activated(h) !== undefined);
    invoke(h, 1, 'command', 'grow');
    await until(() => h.faults.length > 0 || done(h, 1) !== undefined, 10_000);
    // Out of memory is either the engine's fault or an error the handler could not survive.
    expect(h.faults[0]?.kind ?? (done(h, 1) as { ok?: boolean } | undefined)?.ok).toSatisfy(
      (v: unknown) => v === 'memory' || v === false,
    );
  });
});

describe('timers, messages and the console', () => {
  it('runs timers and intervals, clears them, and refuses past the cap', async () => {
    const h = await harness(
      {
        'main.js': `export function activate(nova) {
  let n = 0;
  setTimeout((a) => console.log('timeout', a), 1, 'arg');
  const i = setInterval(() => { n++; if (n === 2) { clearInterval(i); console.log('interval done'); } }, 10);
  const t = setTimeout(() => console.log('never'), 5); clearTimeout(t);
  try { setTimeout(() => {}, 1); setTimeout(() => {}, 1); } catch (e) { console.log(e.message); }
  queueMicrotask(() => console.log('micro'));
}`,
      },
      { limits: { maxTimers: 3 } },
    );
    h.engine.start();
    await until(() => h.logs.includes('info interval done'));
    expect(h.logs).toContain('info timeout arg');
    expect(h.logs).toContain('info too many timers');
    expect(h.logs).toContain('info micro');
    expect(h.logs).not.toContain('info never');
  });

  it('drops an oversized answer with an error, and caps the console', async () => {
    const h = await harness(
      {
        'main.js': `export function activate(nova) {
  nova.commands.register({ id: 'big', run: () => 'x'.repeat(5000) });
  for (let i = 0; i < 10; i++) console.log('line', i);
}`,
      },
      { limits: { maxMessageChars: 1000, logLinesPerMinute: 3 } },
    );
    h.engine.start();
    await until(() => activated(h) !== undefined);
    invoke(h, 4, 'command', 'big');
    await until(() => done(h, 4) !== undefined);
    expect(done(h, 4)).toMatchObject({ ok: false, error: { code: 'too_large' } });
    expect(h.logs.filter((l) => l.startsWith('info line'))).toHaveLength(3);
    expect(h.logs).toContain('warn console output dropped: too many lines this minute');
  });

  it('a refused registration removes the handler; deactivate runs on request', async () => {
    const h = await harness({
      'main.js': `export function activate(nova) {
  const r = nova.commands.register({ id: 'x', run: () => 1 });
  r.ready.catch((e) => console.log('refused', e.message, e.code));
}
export function deactivate() { console.log('bye'); }`,
    });
    h.answers.register = new Error('not declared');
    h.engine.start();
    await until(() => h.logs.some((l) => l.startsWith('info refused')));
    expect(h.logs).toContain('info refused not declared policy_denied');
    invoke(h, 3, 'command', 'x');
    expect(done(h, 3)).toMatchObject({ ok: false, error: { code: 'not_registered' } });
    invoke(h, 4, 'lifecycle', 'deactivate');
    await until(() => done(h, 4) !== undefined);
    expect(h.logs).toContain('info bye');
  });

  it('builds the full nova API: every registration and request reaches the host', async () => {
    const h = await harness({
      'main.js': `export async function activate(nova) {
  const p = nova.panels.register({ id: 'p', title: 'P', resource: 'ui://t/p', entryPoint: 'file', extensions: ['.x'] });
  nova.tools.register({ name: 't', title: 'T', description: 'd', inputSchema: { type: 'object' }, handler: () => 1 });
  nova.hooks.register({ id: 'h', event: 'stop', handler: () => ({}) });
  nova.themes.register({ schemaVersion: 1, id: 'a.b', name: 'N', variant: 'dark', tokens: {} });
  nova.keybindings.register({ command: 'c', key: 'mod+k' });
  nova.events.on('run.*', () => {});
  nova.menus.register({ where: 'thread', items: [{ title: 'x', command: 'c' }] });
  const s = nova.status.addItem({ id: 's', text: 'S', onClick: () => 'clicked' });
  s.update('S2');
  const r = await nova.net.fetch('https://a.example/x', { method: 'POST', body: 'b', headers: { a: '1' } });
  nova.log(r.ok, r.status, await r.text(), (await r.json()).k, await r.base64());
  await nova.fs.write('/a', 't'); await nova.fs.read('/a'); await nova.fs.list('/'); await nova.fs.remove('/a');
  p.dispose();
}`,
    });
    h.answers['net.fetch'] = {
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '{"k":2}',
      encoding: 'utf8',
    };
    h.engine.start();
    await until(() => activated(h) !== undefined);
    expect(activated(h)).toEqual({ t: 'activated', ok: true });
    const ops = h.sent
      .filter((m) => m.t === 'req')
      .map((m) => (m.op === 'register' ? `register:${(m.args as { kind: string }).kind}` : m.op));
    expect(ops).toEqual([
      'register:panel',
      'register:tool',
      'register:hook',
      'register:theme',
      'register:keybinding',
      'register:event',
      'register:menu',
      'register:status',
      'status.update',
      'net.fetch',
      'fs.write',
      'fs.read',
      'fs.list',
      'fs.remove',
      'unregister',
    ]);
    expect(h.logs).toContain('info true 200 {"k":2} 2 null');
    invoke(h, 5, 'status', 's');
    await until(() => done(h, 5) !== undefined);
    expect(done(h, 5)).toMatchObject({ ok: true, value: 'clicked' });
  });

  it('checks the shapes extensions pass', async () => {
    const h = await harness({
      'main.js': `export function activate(nova) {
  for (const f of [
    () => nova.commands.register({}), () => nova.tools.register({ name: 'x' }), () => nova.hooks.register({}),
    () => nova.panels.register(null), () => nova.themes.register({}), () => nova.keybindings.register({}),
    () => nova.events.on(1), () => nova.menus.register({}), () => nova.status.addItem({}), () => setTimeout(1),
  ]) { try { f(); console.log('accepted'); } catch (e) { console.log(e.name); } }
}`,
    });
    h.engine.start();
    await until(() => activated(h) !== undefined);
    expect(h.logs.filter((l) => l === 'info TypeError')).toHaveLength(10);
  });
});
