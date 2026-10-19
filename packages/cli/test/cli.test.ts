// The `nova` command (FR-117, FR-044, FR-105; ADR-097 D1), in-process: init from the template,
// validate (folders, bundles, JSON), keys kept 0600 outside any repository, pack signed and
// unsigned bundles the Hub verifies, dev loading into a (fake) Hub with the owner token from the
// environment and reloading on a change, mcp stdio and data wired, usage errors.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBundleEntries, verifyBundle } from '@nova/core';
import { USAGE, hubFromEnv, runCli, type CliIo } from '../src/cli.ts';
import { defaultKeyFile, repositoryOf } from '../src/keyfile.ts';

let dir: string;
let out: string[];
let err: string[];
let io: CliIo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-cli-'));
  out = [];
  err = [];
  io = {
    env: { XDG_CONFIG_HOME: join(dir, 'config'), HOME: join(dir, 'home') },
    cwd: dir,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    debounceMs: 50,
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const text = () => out.join('');
const errors = () => err.join('');

describe('help and usage', () => {
  it('prints usage, the version, and refuses unknown commands', async () => {
    expect(await runCli(['help'], io)).toBe(0);
    expect(text()).toBe(USAGE);
    expect(await runCli([], io)).toBe(2);
    expect(await runCli(['--version'], io)).toBe(0);
    expect(text()).toMatch(/nova 0\.0\.0/);
    expect(await runCli(['frobnicate'], io)).toBe(2);
    expect(errors()).toMatch(/unknown command frobnicate/);
    expect(await runCli(['validate'], io)).toBe(2);
    expect(await runCli(['pack', 'x', '--key'], io)).toBe(2);
  });
});

describe('init, validate, keys and pack', () => {
  it('creates an extension from the template that validates, packs signed and verifies', async () => {
    expect(await runCli(['init', 'my-ext', '--id', 'com.acme.myext', '--name', 'My ext'], io)).toBe(
      0,
    );
    const root = join(dir, 'my-ext');
    const plugin = JSON.parse(
      readFileSync(join(root, '.nova-plugin', 'plugin.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(plugin).toMatchObject({ id: 'com.acme.myext', name: 'My ext', version: '0.1.0' });
    expect(readFileSync(join(root, '.nova-plugin', 'extension.json'), 'utf8')).toContain(
      'ext:com.acme.myext/greet',
    );
    expect(await runCli(['init', 'my-ext'], io)).toBe(1);
    expect(errors()).toMatch(/not empty/);
    expect(await runCli(['init', 'x', '--id', 'Bad'], io)).toBe(2);

    out = [];
    expect(await runCli(['validate', 'my-ext'], io)).toBe(0);
    expect(text()).toMatch(
      /com\.acme\.myext 0\.1\.0 is valid: 1 commands, 1 panels, 2 tools, 1 hooks, 1 events/,
    );
    expect(await runCli(['validate', 'my-ext', '--json'], io)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ ok: true, id: 'com.acme.myext' });

    // No key yet: pack says how to make one, or packs unsigned on request.
    expect(await runCli(['pack', 'my-ext'], io)).toBe(1);
    expect(errors()).toMatch(/nova keys generate/);
    expect(await runCli(['pack', 'my-ext', '--unsigned', '--out', 'u.novax'], io)).toBe(0);
    expect(text()).toMatch(/unsigned/);
    expect(verifyBundle(readFileSync(join(dir, 'u.novax')), { trusted: [] }).status).toBe(
      'unverified',
    );

    out = [];
    expect(await runCli(['keys', 'generate'], io)).toBe(0);
    const keyFile = defaultKeyFile(io.env);
    expect(keyFile).toBe(join(dir, 'config', 'nova', 'publisher-key'));
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const publicKey = /public key: ([A-Za-z0-9_-]{43})/.exec(text())![1]!;
    expect(await runCli(['keys', 'generate'], io)).toBe(1);
    expect(errors()).toMatch(/already exists/);
    out = [];
    expect(await runCli(['keys', 'show'], io)).toBe(0);
    expect(text()).toContain(publicKey);

    out = [];
    expect(await runCli(['pack', 'my-ext'], io)).toBe(0);
    const file = join(dir, 'com.acme.myext-0.1.0.novax');
    expect(text()).toMatch(/signed by/);
    const check = verifyBundle(readFileSync(file), { trusted: [{ key: publicKey }] });
    expect(check).toMatchObject({ status: 'verified', publisher: publicKey });
    expect(readBundleEntries(readFileSync(file)).has('META-INF/nova-signature.json')).toBe(true);
    out = [];
    expect(await runCli(['validate', file], io)).toBe(0);
    expect(text()).toMatch(/signature: unverified/);
  });

  it('refuses to pack an invalid extension and reports every problem', async () => {
    await runCli(['init', 'bad'], io);
    const ext = join(dir, 'bad', '.nova-plugin', 'extension.json');
    const m = JSON.parse(readFileSync(ext, 'utf8')) as {
      permissions: { panels: { connectDomains?: string[] }[]; hooks: unknown[] };
    };
    m.permissions.panels[0]!.connectDomains = ['evil.example'];
    m.permissions.hooks.push({ id: 'note-greetings', event: 'stop' });
    writeFileSync(ext, JSON.stringify(m));
    writeFileSync(join(dir, 'bad', 'extension.js'), 'export function activate( {');
    expect(await runCli(['pack', 'bad', '--unsigned'], io)).toBe(1);
    expect(errors()).toMatch(/evil\.example is not within the declared network permissions/);
    expect(errors()).toMatch(/used twice/);
    expect(errors()).toMatch(/SyntaxError/);
    expect(errors()).toMatch(/nothing was packed/);
    expect(await runCli(['validate', 'nowhere'], io)).toBe(1);
    expect(await runCli(['pack', 'nowhere'], io)).toBe(1);
  });

  it('keeps keys out of repositories and warns about loose permissions', async () => {
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    expect(repositoryOf(join(dir, 'repo', 'keys', 'k'))).toBe(join(dir, 'repo'));
    expect(await runCli(['keys', 'generate', '--key', 'repo/keys/k'], io)).toBe(1);
    expect(errors()).toMatch(/never goes in a repository/);
    expect(await runCli(['keys', 'generate', '--key', 'k1'], io)).toBe(0);
    const { chmodSync } = await import('node:fs');
    chmodSync(join(dir, 'k1'), 0o644);
    expect(await runCli(['keys', 'show', '--key', 'k1'], io)).toBe(0);
    expect(errors()).toMatch(/other users/);
    expect(await runCli(['keys', 'show', '--key', 'missing'], io)).toBe(1);
    expect(await runCli(['keys'], io)).toBe(2);
    expect(defaultKeyFile({ NOVA_PUBLISHER_KEY: '/x/k' })).toBe('/x/k');
    expect(defaultKeyFile({ APPDATA: 'C:\\Users\\a\\AppData' }, 'win32')).toMatch(/Nova/);
  });
});

describe('nova dev', () => {
  let server: Server;
  let requests: { url: string; auth: string | undefined; body: Record<string, unknown> }[];
  let answer: (body: Record<string, unknown>) => { status: number; json: unknown };

  beforeEach(async () => {
    requests = [];
    answer = () => ({
      status: 200,
      json: {
        id: 'com.acme.dev',
        version: '0.1.0',
        status: 'running',
        registered: { commands: 1, panels: 1, tools: 2 },
      },
    });
    server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        requests.push({ url: req.url ?? '', auth: req.headers.authorization, body });
        const a = answer(body);
        res.writeHead(a.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(a.json));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    io.env = { ...io.env, NOVA_URL: `http://127.0.0.1:${port}/`, NOVA_TOKEN: 'owner-token' };
    await runCli(['init', 'dev-ext', '--id', 'com.acme.dev'], io);
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('loads once with the owner token from the environment', async () => {
    out = [];
    expect(await runCli(['dev', 'dev-ext', '--once', '--trust-hooks'], io)).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: '/api/v1/extensions/dev',
      auth: 'Bearer owner-token',
    });
    expect(requests[0]!.body).toMatchObject({ confirmSideload: true, trustHooks: true });
    const entries = readBundleEntries(Buffer.from(String(requests[0]!.body.bundle), 'base64'));
    expect(entries.has('.nova-plugin/extension.json')).toBe(true);
    expect(text()).toMatch(/loaded com\.acme\.dev 0\.1\.0: running; 1 commands, 1 panels, 2 tools/);
  });

  it('reports a refusal, an unreachable Hub and an invalid extension', async () => {
    answer = () => ({ status: 403, json: { error: { message: 'owner only' } } });
    expect(await runCli(['dev', 'dev-ext', '--once'], io)).toBe(1);
    expect(errors()).toMatch(/403: owner only/);
    answer = () => ({
      status: 200,
      json: { id: 'x', version: '1', status: 'error', error: 'activate failed' },
    });
    expect(await runCli(['dev', 'dev-ext', '--once'], io)).toBe(1);
    expect(text()).toMatch(/error \(activate failed\)/);
    writeFileSync(join(dir, 'dev-ext', 'extension.js'), 'export function activate( {');
    expect(await runCli(['dev', 'dev-ext', '--once'], io)).toBe(1);
    expect(errors()).toMatch(/not loaded/);
    io.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    writeFileSync(join(dir, 'dev-ext', 'extension.js'), 'export function activate() {}');
    err = [];
    expect(await runCli(['dev', 'dev-ext', '--once'], io)).toBe(1);
    expect(errors(), errors()).toMatch(/could not be reached/);
  });

  it('needs NOVA_URL and NOVA_TOKEN, and https unless the Hub is on this machine', async () => {
    expect(await runCli(['dev', 'dev-ext', '--once'], { ...io, env: {} })).toBe(2);
    expect(() => hubFromEnv({ NOVA_URL: 'http://hub.example:8080', NOVA_TOKEN: 't' })).toThrow(
      /https/,
    );
    expect(() => hubFromEnv({ NOVA_URL: 'nope', NOVA_TOKEN: 't' })).toThrow(/not a URL/);
    expect(hubFromEnv({ NOVA_URL: 'https://hub.example/', NOVA_TOKEN: 't' })).toEqual({
      base: 'https://hub.example',
      token: 't',
    });
    expect(await runCli(['dev', 'nowhere', '--once'], io)).toBe(1);
  });

  it('reloads on a change until stopped', async () => {
    const stop = new AbortController();
    io.signal = stop.signal;
    const done = runCli(['dev', 'dev-ext'], io);
    for (let i = 0; i < 200 && requests.length < 1; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(requests).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(
      join(dir, 'dev-ext', 'extension.js'),
      'export function activate(nova) { nova.log("v2"); }',
    );
    for (let i = 0; i < 200 && requests.length < 2; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(text()).toMatch(/changed: extension\.js/);
    stop.abort();
    expect(await done).toBe(0);
  });
});

describe('mcp and data', () => {
  it('nova mcp stdio needs stdio and an endpoint; it relays when configured', async () => {
    expect(await runCli(['mcp'], io)).toBe(2);
    expect(await runCli(['mcp', 'stdio'], io)).toBe(2);
    expect(errors()).toMatch(/NOVA_MCP_URL/);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const env = { NOVA_MCP_URL: 'http://127.0.0.1:9/mcp', NOVA_MCP_TOKEN: 'nvm_x' };
    const run = runCli(['mcp', 'stdio'], {
      ...io,
      env,
      stdin,
      stdoutStream: stdout,
      fetch: () => Promise.reject(new Error('down')),
    });
    stdin.end();
    expect(await run).toBe(0);
    expect(await runCli(['mcp', 'stdio'], { ...io, env })).toBe(1);
  });

  it('nova data is the data controls subcommand', async () => {
    expect(await runCli(['data'], io)).toBe(2);
    expect(errors()).toMatch(/nova data export/);
  });
});
