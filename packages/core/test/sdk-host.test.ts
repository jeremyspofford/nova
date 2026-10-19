// The host's checks of what an extension asks for (FR-117; docs/14 §4.2; ADR-097 D3), which is
// security policy (AGENTS.md §6): every registration kind with its declared/undeclared and
// malformed cases, network requests (URL, scheme, credentials, method, headers, sizes, binary and
// cut bodies, failures), files (scopes, writable scopes, the scope root, sizes, missing files,
// links out of a scope, the Hub's own data), secrets, invocation limits (busy, size, non-JSON,
// cancel, timeout), event delivery limits, start failures, and malformed messages from a worker
// that speaks the protocol directly.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { Logger, MemorySink } from '@nova/telemetry';
import {
  ExtensionHost,
  MemoryEventSink,
  parseExtensionManifest,
  toToolResult,
  type AuditRecord,
  type ExtensionHostOptions,
  type ExtensionSpec,
} from '../src/index.ts';
import { ACCOUNT, tempDir, writeTree } from './sdk-env.ts';

const RAW_WORKER = new URL('./fixtures/sdk/raw-worker.ts', import.meta.url);
const ID = 'com.example.h';

let dir: string;
let audit: AuditRecord[];
let violations: string[];
let logs: MemorySink;
let secrets: MemorySecretStore;
let hosts: ExtensionHost[];

beforeEach(() => {
  dir = tempDir('nova-sdk-host-');
  audit = [];
  violations = [];
  logs = new MemorySink();
  secrets = new MemorySecretStore();
  hosts = [];
});
afterEach(async () => {
  for (const h of hosts) await h.close();
  rmSync(dir, { recursive: true, force: true });
});

function host(over: Partial<ExtensionHostOptions> = {}): ExtensionHost {
  const h = new ExtensionHost({
    secrets,
    hubDataDir: join(dir, 'hub'),
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    events: new MemoryEventSink(),
    log: new Logger({ module: 'test', sinks: [logs], level: 'debug' }),
    onViolation: (_a, _e, what) => {
      violations.push(what);
    },
    startTimeoutMs: 15_000,
    ...over,
  });
  hosts.push(h);
  return h;
}

function spec(
  code: string,
  permissions: Record<string, unknown>,
  files: Record<string, string> = {},
): ExtensionSpec {
  const root = writeTree(join(dir, 'ext'), { 'main.js': code, ...files });
  return {
    accountId: ACCOUNT,
    extensionId: ID,
    version: '1.0.0',
    root,
    dataDir: join(dir, 'hub', 'extensions', 'data', ID),
    manifest: parseExtensionManifest({ api: 1, entry: 'main.js', permissions }),
    digest: 'a'.repeat(64),
  };
}

/** A command `p` that runs `body` (an async function of nova and args) and returns its result or error. */
const probe = (body: string) => `export function activate(nova) {
  nova.commands.register({ id: 'p', run: async (args) => {
    try { return { ok: true, value: await (async (nova, args) => { ${body} })(nova, args) }; }
    catch (e) { return { ok: false, code: e.code, message: e.message }; }
  } });
}`;

async function run(h: ExtensionHost, args: unknown = null) {
  const r = await h.invoke(ACCOUNT, ID, 'command', 'p', args);
  if (!r.ok) throw new Error(`invoke failed: ${r.error.message}`);
  return r.value as { ok: boolean; value?: unknown; code?: string; message?: string };
}

describe('registrations', () => {
  it('checks every kind against the manifest and its shape', async () => {
    const h = host();
    const s = spec(
      probe(`
  const out = {};
  const tryReg = async (name, f) => { try { await f().ready; out[name] = 'ok'; } catch (e) { out[name] = e.code; } };
  await tryReg('cmd-undeclared', () => nova.commands.register({ id: 'nope', run() {} }));
  await tryReg('panel-undeclared', () => nova.panels.register({ id: 'x', resource: 'ui://x/x', entryPoint: 'global' }));
  await tryReg('panel-other-resource', () => nova.panels.register({ id: 'pn', resource: 'ui://other/x', entryPoint: 'global' }));
  await tryReg('panel-ok', () => nova.panels.register({ id: 'pn', title: 'Panel', resource: 'ui://h/p', entryPoint: 'thread' }));
  await tryReg('tool-bad-schema', () => nova.tools.register({ name: 't', inputSchema: { type: 'array' }, handler() {} }));
  await tryReg('tool-big-schema', () => nova.tools.register({ name: 't', inputSchema: { type: 'object', description: 'x'.repeat(70000) }, handler() {} }));
  await tryReg('tool-ok', () => nova.tools.register({ name: 't', inputSchema: { type: 'object' }, annotations: { readOnly: true, destructive: true, costClass: 'metered' }, handler() {} }));
  await tryReg('tool-read', () => nova.tools.register({ name: 'r', annotations: { readOnly: true }, handler() {} }));
  await tryReg('hook-undeclared', () => nova.hooks.register({ id: 'zz', event: 'stop', handler() {} }));
  await tryReg('hook-other-event', () => nova.hooks.register({ id: 'hk', event: 'tool.pre', handler() {} }));
  await tryReg('hook-ok', () => nova.hooks.register({ id: 'hk', event: 'stop', handler() {} }));
  await tryReg('theme-bad', () => nova.themes.register({ id: 'a.b', name: 'x' }));
  for (let i = 0; i < 10; i++) await tryReg('theme-ok', () => nova.themes.register({ schemaVersion: 1, id: 'a.t' + i, name: 'T', variant: 'dark', tokens: {} }));
  await tryReg('theme-too-many', () => nova.themes.register({ schemaVersion: 1, id: 'a.x', name: 'T', variant: 'dark', tokens: {} }));
  await tryReg('key-bad', () => nova.keybindings.register({ command: 'c', key: 'ctrl+<' }));
  await tryReg('key-undeclared', () => nova.keybindings.register({ command: 'nope', key: 'k' }));
  for (let i = 0; i < 50; i++) await tryReg('key-ok', () => nova.keybindings.register({ command: 'c', key: 'k' + i }));
  await tryReg('key-too-many', () => nova.keybindings.register({ command: 'c', key: 'kk' }));
  await tryReg('event-undeclared', () => nova.events.on('chat.message.created', () => {}));
  await tryReg('event-ok', () => nova.events.on('run.end', () => {}));
  await tryReg('menu-bad-place', () => nova.menus.register({ where: 'roof', items: [] }));
  await tryReg('menu-bad-item', () => nova.menus.register({ where: 'thread', items: [{ command: 'c' }] }));
  await tryReg('menu-undeclared', () => nova.menus.register({ where: 'thread', items: [{ title: 'x', command: 'nope' }] }));
  await tryReg('menu-too-many-items', () => nova.menus.register({ where: 'thread', items: Array.from({ length: 21 }, () => ({ title: 'x', command: 'c' })) }));
  await tryReg('menu-ok', () => nova.menus.register({ where: 'file', items: [{ title: 'x', command: 'c' }] }));
  await tryReg('status-bad-id', () => nova.status.addItem({ id: 'Bad Id', text: 'x' }));
  await tryReg('status-undeclared', () => nova.status.addItem({ id: 's1', text: 'x', onClick: 'nope' }));
  for (let i = 0; i < 5; i++) await tryReg('status-ok', () => nova.status.addItem({ id: 's' + i, text: 'x' }));
  await tryReg('status-too-many', () => nova.status.addItem({ id: 's9', text: 'x' }));
  return out;`),
      {
        commands: ['p', 'c'],
        panels: [
          { id: 'pn', title: 'P', resource: 'ui://h/p', entryPoint: 'thread', file: 'p.html' },
        ],
        tools: { t: { action: 'write' }, r: { action: 'read' } },
        hooks: [{ id: 'hk', event: 'stop' }],
        events: ['run.*'],
      },
      { 'p.html': '<p>x</p>' },
    );
    expect(await h.start(s)).toEqual({ status: 'running', error: null });
    const r = await run(h);
    expect(r.value).toEqual({
      'cmd-undeclared': 'policy_denied',
      'panel-undeclared': 'policy_denied',
      'panel-other-resource': 'policy_denied',
      'panel-ok': 'ok',
      'tool-bad-schema': 'validation',
      'tool-big-schema': 'validation',
      'tool-ok': 'ok',
      'tool-read': 'ok',
      'hook-undeclared': 'policy_denied',
      'hook-other-event': 'policy_denied',
      'hook-ok': 'ok',
      'theme-bad': 'validation',
      'theme-ok': 'ok',
      'theme-too-many': 'validation',
      'key-bad': 'validation',
      'key-undeclared': 'policy_denied',
      'key-ok': 'ok',
      'key-too-many': 'validation',
      'event-undeclared': 'policy_denied',
      'event-ok': 'ok',
      'menu-bad-place': 'validation',
      'menu-bad-item': 'validation',
      'menu-undeclared': 'policy_denied',
      'menu-too-many-items': 'validation',
      'menu-ok': 'ok',
      'status-bad-id': 'validation',
      'status-undeclared': 'policy_denied',
      'status-ok': 'ok',
      'status-too-many': 'validation',
    });
    const reg = h.registrations(ACCOUNT, ID)!;
    expect(reg.panels.get('pn')).toMatchObject({ title: 'Panel', file: 'p.html' });
    // Only a declared read keeps readOnly; the declared action class wins.
    expect(reg.tools.get('t')).toMatchObject({
      action: 'write',
      annotations: { destructive: true, costClass: 'metered' },
    });
    expect(reg.tools.get('t')?.annotations.readOnly).toBeUndefined();
    expect(reg.tools.get('r')).toMatchObject({
      action: 'read',
      annotations: { readOnly: true },
      title: 'r',
    });
    expect(reg.themes.size).toBe(10);
    expect(reg.keybindings.size).toBe(50);
    expect(reg.status.size).toBe(5);
    expect(violations).toHaveLength(9);
    expect(audit.filter((a) => a.action === 'extension.access.denied')).toHaveLength(9);
    expect(h.running(ACCOUNT)).toHaveLength(1);
    expect(h.running('other')).toEqual([]);
  });
});

describe('network', () => {
  it('checks URLs, hosts, methods and headers, and shapes the answer', async () => {
    const seen: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
    }[] = [];
    const h = host({
      fetch: async (input, init) => {
        const url = input instanceof URL ? input.href : (input as Request).url;
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
        seen.push({
          url,
          method: String(init?.method),
          headers,
          body: typeof init?.body === 'string' ? init.body : null,
        });
        await Promise.resolve();
        if (url.endsWith('/fail')) throw new Error('socket hang up');
        if (url.endsWith('/bin'))
          return new Response(new Uint8Array([0, 1, 2]), {
            headers: { 'content-type': 'image/png' },
          });
        if (url.endsWith('/big'))
          return new Response('x'.repeat(5 * 1024 * 1024 + 10), {
            headers: { 'content-type': 'text/plain' },
          });
        return new Response('{"a":1}', {
          status: 201,
          statusText: 'Created',
          headers: { 'content-type': 'application/json', 'set-cookie': 'k=v' },
        });
      },
    });
    const s = spec(
      probe(`
  const f = async (url, init) => { try { const r = await nova.net.fetch(url, init); return { status: r.status, text: await r.text(), b64: await r.base64(), cut: r.truncated, h: r.headers }; } catch (e) { return e.code + ': ' + e.message; } };
  return {
    notUrl: await f('nope'), ftp: await f('ftp://api.example.com/x'), creds: await f('https://u:p@api.example.com/'),
    method: await f('https://api.example.com/', { method: 'TRACE' }),
    ok: await f('https://api.example.com/ok', { method: 'POST', body: 'hi', headers: { 'x-a': '1', cookie: 'no', host: 'evil', 'bad header': 'x' } }),
    bigBody: await f('https://api.example.com/', { method: 'PUT', body: 'x'.repeat(5 * 1024 * 1024 + 1) }),
    get: await f('https://cdn.example.com/', { body: 'ignored' }),
    fail: await f('https://api.example.com/fail'),
    bin: await f('https://api.example.com/bin'),
    big: (await f('https://api.example.com/big')).cut,
    undeclared: await f('https://evil.example/'),
  };`),
      { commands: ['p'], network: ['api.example.com', '*.example.com'] },
    );
    await h.start(s);
    const v = (await run(h)).value as Record<string, unknown> & {
      ok: { h: Record<string, string> };
    };
    expect(v.notUrl).toBe('validation: not a URL');
    expect(v.ftp).toBe('validation: only http and https URLs');
    expect(v.creds).toBe('validation: URLs cannot carry credentials');
    expect(v.method).toBe('validation: unsupported method');
    expect(v.ok).toMatchObject({ status: 201, text: '{"a":1}', b64: null, cut: false });
    expect(v.ok.h['set-cookie']).toBeUndefined();
    expect(seen[0]).toMatchObject({
      url: 'https://api.example.com/ok',
      method: 'POST',
      body: 'hi',
      headers: { 'x-a': '1' },
    });
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers.host).toBeUndefined();
    expect(v.bigBody).toBe('validation: the request body is too large');
    expect(seen.find((x) => x.url === 'https://cdn.example.com/')?.body).toBeNull();
    expect(v.fail).toBe('fetch_failed: api.example.com: socket hang up');
    expect(v.bin).toMatchObject({ text: '', b64: 'AAEC' });
    expect(v.big).toBe(true);
    expect(v.undeclared).toMatch(/^policy_denied/);
    expect(audit.find((a) => a.action === 'extension.access.denied')).toMatchObject({
      kind: 'network',
    });
  });
});

describe('files and secrets', () => {
  it('keeps files within declared scopes, sizes and links, and out of the Hub', async () => {
    const shared = join(dir, 'shared');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'big.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    writeFileSync(join(dir, 'secret.txt'), 'outside');
    const h = host();
    const s = spec(
      probe(`
  const t = async (f) => { try { return await f(); } catch (e) { return e.code; } };
  const D = '\${extensionData}';
  await nova.fs.write(D + '/sub/a.txt', 'A');
  return {
    read: await t(() => nova.fs.read(D + '/sub/a.txt')),
    list: await t(() => nova.fs.list(D)),
    dir: await t(() => nova.fs.read(D + '/sub')),
    missing: await t(() => nova.fs.read(D + '/none')),
    big: await t(() => nova.fs.read('${join(dir, 'shared')}/big.txt')),
    sharedWrite: await t(() => nova.fs.write('${join(dir, 'shared')}/x', 'y')),
    rootWrite: await t(() => nova.fs.write(D, 'y')),
    rootRemove: await t(() => nova.fs.remove(D)),
    bigWrite: await t(() => nova.fs.write(D + '/b', 'x'.repeat(5 * 1024 * 1024 + 1))),
    link: await t(() => nova.fs.read(D + '/link/secret.txt')),
    hub: await t(() => nova.fs.read('${join(dir, 'hub')}/other.txt')),
    relative: await t(() => nova.fs.read('relative.txt')),
    remove: await t(() => nova.fs.remove(D + '/sub/a.txt')),
    ownFiles: await t(() => nova.fs.read('\${extensionRoot}/main.js')),
    secret: await t(() => nova.secrets.get('token')),
  };`),
      {
        commands: ['p'],
        fs: ['${extensionData}', '${extensionRoot}', join(dir, 'shared'), join(dir, 'hub')],
        secrets: ['token'],
      },
    );
    mkdirSync(s.dataDir, { recursive: true });
    symlinkSync(dir, join(s.dataDir, 'link'));
    await h.start(s);
    const v = (await run(h)).value as Record<string, unknown>;
    expect(v).toMatchObject({
      read: 'A',
      list: expect.arrayContaining([{ name: 'sub', kind: 'dir', size: null }]),
      dir: 'validation',
      missing: 'not_found',
      big: 'validation',
      sharedWrite: 'policy_denied',
      rootWrite: 'validation',
      rootRemove: 'validation',
      bigWrite: 'validation',
      link: 'policy_denied',
      hub: 'policy_denied',
      relative: 'policy_denied',
      remove: null,
      secret: null,
    });
    expect(String(v.ownFiles)).toContain('activate');
    expect(audit.filter((a) => a.kind === 'fs').map((a) => a.detail?.what)).toEqual([
      'write access to',
      'a link out of its folder at',
      'read access to',
      'read access to',
    ]);
    expect(audit.find((a) => a.action === 'extension.secret.read')?.detail).toMatchObject({
      set: false,
    });
  });
});

describe('invocations and events', () => {
  it('limits calls: busy, size, JSON, cancel and timeout', async () => {
    const h = host({ invokeTimeoutMs: 300 });
    const s = spec(
      `export function activate(nova) {
  nova.commands.register({ id: 'wait', run: () => new Promise(() => {}) });
  nova.events.on('run.*', () => new Promise(() => {}));
}`,
      { commands: ['wait'], events: ['run.*'] },
    );
    await h.start(s);
    expect(await h.invoke(ACCOUNT, 'other.ext', 'command', 'wait', null)).toMatchObject({
      ok: false,
      error: { code: 'extension_unavailable' },
    });
    expect(await h.invoke(ACCOUNT, ID, 'command', 'wait', 'x'.repeat(1_000_001))).toMatchObject({
      error: { code: 'invalid_arguments' },
    });
    expect(await h.invoke(ACCOUNT, ID, 'command', 'wait', { n: 1n })).toMatchObject({
      error: { code: 'invalid_arguments' },
    });
    const ctl = new AbortController();
    const cancelled = h.invoke(ACCOUNT, ID, 'command', 'wait', null, {}, { signal: ctl.signal });
    ctl.abort();
    expect(await cancelled).toMatchObject({ error: { code: 'cancelled' } });
    const pre = new AbortController();
    pre.abort();
    expect(
      await h.invoke(ACCOUNT, ID, 'command', 'wait', null, {}, { signal: pre.signal }),
    ).toMatchObject({ error: { code: 'cancelled' } });
    expect(await h.invoke(ACCOUNT, ID, 'command', 'wait', null)).toMatchObject({
      error: { code: 'timeout' },
    });
    const many = Array.from({ length: 32 }, () =>
      h.invoke(ACCOUNT, ID, 'command', 'wait', null, {}, { timeoutMs: 2000 }),
    );
    expect(await h.invoke(ACCOUNT, ID, 'command', 'wait', null)).toMatchObject({
      error: { code: 'extension_busy' },
    });
    // Events: at most 20 in flight; an oversized event is not delivered.
    const env = {
      id: 'e',
      schemaVersion: 1,
      ts: new Date().toISOString(),
      actor: 'system',
      accountId: ACCOUNT,
    };
    h.dispatchEvent({ ...env, name: 'run.completed', payload: { big: 'x'.repeat(70_000) } });
    h.dispatchEvent({ ...env, name: 'run.completed', accountId: undefined, payload: {} });
    await Promise.all(many);
    for (let i = 0; i < 25; i++) h.dispatchEvent({ ...env, name: 'run.completed', payload: { i } });
    expect(h.status(ACCOUNT, ID).status).toBe('running');
    await h.stop(ACCOUNT, ID);
    expect(h.status(ACCOUNT, ID)).toEqual({ status: 'stopped', error: null });
  });

  it('reports a start that cannot read the extension, or that times out', async () => {
    const h = host({ startTimeoutMs: 200 });
    const s = spec('export function activate() { return new Promise(() => {}); }', {});
    expect(await h.start({ ...s, root: join(dir, 'gone') })).toMatchObject({ status: 'error' });
    expect(await h.start(s)).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/did not start within/),
    });
    expect(h.liveWorkers()).toBe(0);
    const bad = spec(
      "export function activate() { throw Object.assign(new Error('nope'), { code: 'x' }); }",
      {},
    );
    expect(await host().start(bad)).toEqual({ status: 'error', error: 'nope' });
    await h.close();
    expect(await h.start(s)).toMatchObject({ status: 'stopped' });
  });
});

describe('a worker that speaks the protocol directly', () => {
  it('answers malformed requests safely and keeps running', async () => {
    const h = host({ workerUrl: RAW_WORKER });
    const send = (m: unknown) => ({ type: 'send', json: JSON.stringify(m) });
    const s = spec(
      '',
      { commands: ['c'], secrets: ['s'] },
      {
        'script.js': JSON.stringify([
          { type: 'send', json: 'not json' },
          { type: 'send', json: '[1,2]' },
          { type: 'other' },
          send({ t: 'activated', ok: true }),
          send({ t: 'req', id: 1, op: 'nonsense', args: {} }),
          send({ t: 'req', id: 2, op: 'register', args: 'not an object' }),
          send({ t: 'req', id: 3, op: 'register', args: { kind: 'command', key: 'c', title: 7 } }),
          send({ t: 'req', id: 4, op: 'status.update', args: { key: 'none', text: 'x' } }),
          send({ t: 'req', id: 5, op: 'unregister', args: { kind: 'command', key: 'c' } }),
          send({ t: 'req', id: 6, op: 'secrets.get', args: {} }),
          send({ t: 'req', id: 7, op: 'register', args: { kind: 'event', key: 'e' } }),
          send({ t: 'req', id: 8, op: 'fs.read', args: { path: 7 } }),
          send({ t: 'done', id: 99, ok: true }),
          { type: 'log', level: 'error', text: 'an error line' },
        ]),
      },
    );
    expect(await h.start(s)).toEqual({ status: 'running', error: null });
    // The extension's text is a `content.text` field (not the message: OTLP leaves content out).
    const text = (r: { [k: string]: unknown }) =>
      typeof r['content.text'] === 'string' ? r['content.text'] : '';
    const got = () =>
      logs.records
        .filter((r) => r.msg === 'extension log' && text(r).startsWith('got'))
        .map((r) => text(r));
    for (let i = 0; i < 100 && got().length < 8; i++) await new Promise((r) => setTimeout(r, 20));
    const answers = got().join('\n');
    expect(answers).toContain('"id":1,"ok":false,"error":{"code":"unknown_request"');
    expect(answers).toContain(
      '"id":2,"ok":false,"error":{"code":"validation","message":"unknown registration"}',
    );
    expect(answers).toContain('"id":3,"ok":true');
    expect(answers).toContain('"id":6,"ok":false,"error":{"code":"policy_denied"');
    expect(answers).toContain(
      '"id":7,"ok":false,"error":{"code":"validation","message":"events.on needs an event name"}',
    );
    expect(answers).toContain('"id":8,"ok":false,"error":{"code":"policy_denied"');
    expect(h.registrations(ACCOUNT, ID)?.commands.size).toBe(0);
    expect(
      logs.records.some(
        (r) => r.level === 'warn' && r.msg === 'extension log' && text(r) === 'an error line',
      ),
    ).toBe(true);
  });

  it('an extension that declares nothing gets nothing; menus and listeners are capped', async () => {
    const send = (id: number, op: string, args: unknown) => ({
      type: 'send',
      json: JSON.stringify({ t: 'req', id, op, args }),
    });
    const empty = host({ workerUrl: RAW_WORKER });
    const kinds = [
      { kind: 'command', key: 'c' },
      { kind: 'panel', key: 'p' },
      { kind: 'tool', key: 't' },
      { kind: 'hook', key: 'h' },
      { kind: 'keybinding', key: 'k', command: 'c', key2: 'x' },
      { kind: 'event', key: 'e', name: 'run.end' },
      { kind: 'menu', key: 'm', where: 'thread', items: [{ title: 't', command: 'c' }] },
      { kind: 'status', key: 's', command: 'c' },
    ];
    const s1 = spec(
      '',
      {},
      {
        'script.js': JSON.stringify([
          { type: 'send', json: JSON.stringify({ t: 'activated', ok: true }) },
          ...kinds.map((k, i) =>
            send(i + 1, 'register', { ...k, ...(k.kind === 'keybinding' ? { key: 'x' } : {}) }),
          ),
          send(20, 'secrets.get', { name: 's' }),
          send(21, 'net.fetch', { url: 'https://a.example/' }),
          send(22, 'unregister', { kind: 'nothing', key: 'x' }),
        ]),
      },
    );
    await empty.start(s1);
    const got = () =>
      logs.records.filter(
        (r) =>
          r.msg === 'extension log' &&
          typeof r['content.text'] === 'string' &&
          r['content.text'].startsWith('got'),
      ).length;
    for (let i = 0; i < 100 && got() < 10; i++) await new Promise((r) => setTimeout(r, 20));
    expect(violations).toHaveLength(10);
    await empty.close();

    violations.length = 0;
    logs.records.length = 0;
    const capped = host({ workerUrl: RAW_WORKER });
    const menus = Array.from({ length: 21 }, (_, i) =>
      send(100 + i, 'register', {
        kind: 'menu',
        key: `m${i}`,
        where: 'thread',
        items: [{ title: 't', command: 'c' }],
      }),
    );
    const listeners = Array.from({ length: 51 }, (_, i) =>
      send(200 + i, 'register', { kind: 'event', key: `e${i}`, name: 'run.completed' }),
    );
    const s2 = spec(
      '',
      { commands: ['c'], events: ['run.*'], tools: { t: { action: 'read' } } },
      {
        'script.js': JSON.stringify([
          { type: 'send', json: JSON.stringify({ t: 'activated', ok: true }) },
          ...menus,
          ...listeners,
          send(300, 'register', {
            kind: 'tool',
            key: 't',
            inputSchema: 'nope',
            outputSchema: { type: 'object' },
            annotations: 'nope',
          }),
          send(301, 'register', { kind: 'menu', key: 'mx', where: 'thread', items: 'nope' }),
          send(302, 'register', { kind: 'status', key: 'sx', command: 'c', text: 5 }),
          send(303, 'register', {
            kind: 'theme',
            key: 'a.b',
            theme: { schemaVersion: 1, id: 'a.c', name: 'T', variant: 'dark', tokens: {} },
          }),
        ]),
      },
    );
    await capped.start(s2);
    for (let i = 0; i < 200 && got() < 76; i++) await new Promise((r) => setTimeout(r, 20));
    const reg = capped.registrations(ACCOUNT, ID)!;
    expect(reg.menus.size).toBe(20);
    expect(reg.events.size).toBe(50);
    expect(reg.tools.get('t')).toMatchObject({
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      annotations: {},
    });
    expect(reg.status.get('sx')).toMatchObject({ text: '', command: 'c' });
    const answers = logs.records
      .map((r) => (typeof r['content.text'] === 'string' ? r['content.text'] : r.msg))
      .join('\n');
    expect(answers).toContain('"message":"too many menus"');
    expect(answers).toContain('"message":"too many event listeners"');
    expect(answers).toContain('its id changed');
    expect(violations).toEqual([]);
  });

  it('a worker that faults is restarted, then left stopped after too many faults', async () => {
    const h = host({ workerUrl: RAW_WORKER, restartDelayMs: 20, maxRestarts: 1 });
    const s = spec(
      '',
      {},
      {
        'script.js': JSON.stringify([
          { type: 'send', json: JSON.stringify({ t: 'activated', ok: true }) },
          { type: 'fault', kind: 'cpu', message: 'ran too long' },
        ]),
      },
    );
    await h.start(s);
    for (let i = 0; i < 200 && !/repeated faults/.test(h.status(ACCOUNT, ID).error ?? ''); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(h.status(ACCOUNT, ID)).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/ran too long; it was stopped after repeated faults/),
    });
    h.clearError(ACCOUNT, ID);
    expect(h.status(ACCOUNT, ID)).toEqual({ status: 'stopped', error: null });
  });
});

describe('tool results', () => {
  it('shapes text, MCP-style content, errors and JSON', () => {
    expect(toToolResult('hi')).toEqual({ ok: true, content: [{ type: 'text', text: 'hi' }] });
    expect(
      toToolResult({
        content: [{ type: 'text', text: 'a' }, { type: 'image' }],
        structuredContent: { a: 1 },
      }),
    ).toEqual({
      ok: true,
      content: [{ type: 'text', text: 'a' }],
      meta: { structuredContent: { a: 1 } },
    });
    expect(toToolResult({ content: [], isError: true })).toEqual({
      ok: false,
      error: { code: 'tool_error', message: 'the tool failed' },
    });
    expect(toToolResult({ content: [] })).toEqual({
      ok: true,
      content: [{ type: 'text', text: '' }],
    });
    expect(toToolResult({ a: 1 })).toEqual({
      ok: true,
      content: [{ type: 'text', text: '{"a":1}' }],
      meta: { structuredContent: { a: 1 } },
    });
    expect(toToolResult(null)).toEqual({ ok: true, content: [{ type: 'text', text: 'null' }] });
    const long = toToolResult('x'.repeat(100_010));
    expect(
      long.ok && long.content[0]!.type === 'text' && long.content[0]!.text.endsWith('[truncated]'),
    ).toBe(true);
  });
});
