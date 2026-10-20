// Extensions end to end in core (FR-117; docs/14 §4-§5, docs/26 §3; ADR-097 D2-D3), with real
// workers: the signed sample packed, verified and installed; its command run, its tools offered as
// `ext:<id>/<name>` and decided by the gate (allowed and denied by permissions), its panel served
// from the bundle; SDK hooks run through the hooks area once trusted; undeclared network, file
// and secret access denied, audited and the extension turned off; a tampered bundle refused; an
// unknown publisher only through the sideload confirmation and Unverified; managed policy; dev
// reloads; updates with a permission diff; uninstall cleans up; workers end on disable, on a fault
// (and restart), on the SDK switch and on close; events reach declared listeners.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NovaError } from '@nova/shared';
import {
  extensionToolName,
  generatePublisherKeyPair,
  managedRestrictions,
  type ToolDefinition,
} from '../src/index.ts';
import {
  ACCOUNT,
  gateRequest,
  HELLO_DIR,
  HELLO_ID,
  THREAD,
  b64,
  copyHello,
  makeSdkEnv,
  packFolder,
  probeExtension,
  type SdkEnv,
} from './sdk-env.ts';

let env: SdkEnv;
beforeEach(async () => {
  env = await makeSdkEnv();
});
afterEach(async () => {
  await env.close();
});

const key = generatePublisherKeyPair();
const stranger = generatePublisherKeyPair();
const signal = () => new AbortController().signal;

async function tool(name: string): Promise<ToolDefinition> {
  const t = (await env.service.tools.list(ACCOUNT)).find((d) => d.descriptor.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

async function installSample(opts: { trust?: boolean; signed?: boolean } = {}) {
  if (opts.signed !== false) env.settings.trusted = [{ name: 'Nova examples', key: key.publicKey }];
  const bytes = packFolder(HELLO_DIR, opts.signed === false ? undefined : key.privateKeyPem);
  const preview = await env.service.preview(ACCOUNT, {
    kind: 'upload',
    bundle: b64(bytes),
    fileName: 'hello.novax',
  });
  const view = await env.service.install(ACCOUNT, {
    previewId: preview.previewId,
    ...(opts.signed === false ? { confirmSideload: true } : {}),
    ...(opts.trust
      ? { trustHooks: preview.hooks.map((h) => ({ id: h.id, contentHash: h.contentHash })) }
      : {}),
  });
  return { preview, view };
}

const until = async (fn: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('the signed sample extension (J10 step 1)', () => {
  it('verifies, installs without a sideload, and its command, tools and panel work', async () => {
    const { preview, view } = await installSample();
    expect(preview).toMatchObject({
      id: HELLO_ID,
      verified: true,
      signature: 'verified',
      sideloadReason: null,
      publisher: { key: key.publicKey, name: 'Nova examples', trusted: true },
      replaces: null,
      diff: null,
    });
    expect(preview.permissions.map((l) => l.text)).toContain(
      'Reach api.example.com over the network',
    );
    expect(preview.hooks[0]).toMatchObject({
      id: `hook:${HELLO_ID}.note-greetings`,
      status: 'needs_trust',
    });
    expect(view).toMatchObject({
      id: HELLO_ID,
      version: '1.0.0',
      verified: true,
      enabled: true,
      status: 'running',
      registered: {
        commands: 1,
        panels: 1,
        tools: 3,
        hooks: 1,
        keybindings: 1,
        menus: 1,
        statusItems: 1,
        events: 1,
      },
      secrets: [{ name: 'greeting', set: false }],
    });
    expect((await env.plugins.get(ACCOUNT, HELLO_ID)).verified).toBe(true);
    expect(env.audit.find((a) => a.action === 'extension.install')?.detail).toMatchObject({
      verified: true,
      sideload: false,
    });
    // The plugin row and its own audit entry agree with the signature check (FR-049).
    expect(env.audit.find((a) => a.action === 'plugin.install')?.detail).toMatchObject({
      verified: true,
      publisher: key.publicKey,
      via: 'signed',
      source: 'local',
      origin: 'upload:hello.novax',
    });

    // The command, with a secret the owner stored.
    await env.service.setSecret(ACCOUNT, HELLO_ID, 'greeting', 'Hi');
    expect(await env.secrets.get(`secret://extension/${ACCOUNT}/${HELLO_ID}/greeting`)).toBe('Hi');
    await expect(env.service.setSecret(ACCOUNT, HELLO_ID, 'other', 'x')).rejects.toThrow(
      /does not declare/,
    );
    expect(await env.service.runCommand(ACCOUNT, HELLO_ID, 'hello.greet', { name: 'Ada' })).toEqual(
      {
        ok: true,
        result: { text: 'Hi, Ada!', greeted: 1 },
        error: null,
      },
    );
    await expect(env.service.runCommand(ACCOUNT, HELLO_ID, 'nope', null)).rejects.toThrow(
      /not available/,
    );
    await until(() => env.service.contributions(ACCOUNT).statusItems[0]?.text === 'Hello: 1');
    expect(env.service.contributions(ACCOUNT)).toMatchObject({
      commands: [{ extensionId: HELLO_ID, id: 'hello.greet', title: 'Hello: say hello' }],
      panels: [{ id: 'hello.panel', resource: 'ui://hello/panel', entryPoint: 'global' }],
      keybindings: [{ command: `ext:${HELLO_ID}/hello.greet`, key: 'mod+shift+h' }],
      menus: [{ where: 'thread', items: [{ title: 'Say hello', command: 'hello.greet' }] }],
      statusItems: [{ id: 'hello.count', command: 'hello.greet', clickable: true }],
    });
    expect((await env.service.clickStatus(ACCOUNT, HELLO_ID, 'hello.count')).result).toMatchObject({
      greeted: 2,
    });

    // The panel: a ui:// resource served from the bundle with its declared domains.
    const [ui] = env.service.uiPanels(ACCOUNT);
    expect(ui).toMatchObject({
      extensionId: HELLO_ID,
      entryPoints: [{ kind: 'global', resource: 'ui://hello/panel', title: 'Hello' }],
      network: ['api.example.com'],
      domains: { connectDomains: ['api.example.com'] },
    });
    const html = await ui!.read('ui://hello/panel');
    expect(html.ok && html.html).toContain('Hello from an extension');
    expect(await ui!.read('ui://other/x')).toMatchObject({ ok: false });

    // The tools, decided by the gate with the extension's declared permissions.
    const names = (await env.service.tools.list(ACCOUNT)).map((t) => t.descriptor.name).sort();
    expect(names).toEqual([
      extensionToolName(HELLO_ID, 'check_status'),
      extensionToolName(HELLO_ID, 'greet'),
      extensionToolName(HELLO_ID, 'save_note'),
    ]);
    const greet = await tool(`ext:${HELLO_ID}/greet`);
    expect(greet.descriptor).toMatchObject({
      source: 'plugin',
      pluginId: HELLO_ID,
      annotations: { readOnly: true, action: 'read' },
    });
    const allowed = await env.gate.check(
      gateRequest(greet.descriptor, { name: 'Grace' }),
      signal(),
    );
    expect(allowed).toMatchObject({
      effect: 'allow',
      reason: `the plugin's default for ext:${HELLO_ID}/greet`,
    });
    const ctx = {
      accountId: ACCOUNT,
      threadId: THREAD,
      turnId: 't',
      callId: 'c',
      projectId: null,
      origin: 'model' as const,
      signal: signal(),
    };
    expect(await greet.handler({ name: 'Grace' }, ctx as never)).toEqual({
      ok: true,
      content: [{ type: 'text', text: 'Hello, Grace!' }],
    });
    const save = await tool(`ext:${HELLO_ID}/save_note`);
    const preview2 = await env.gate.preview({ ...gateRequest(save.descriptor, { text: 'x' }) });
    expect(preview2).toMatchObject({ effect: 'ask', source: 'plugin' });
    expect(await save.handler({ text: 'remember' }, ctx as never)).toMatchObject({ ok: true });
    expect(readFileSync(join(env.service.dataFolder(ACCOUNT, HELLO_ID), 'note.txt'), 'utf8')).toBe(
      'remember',
    );
  });

  it('denies an extension tool its permissions deny, and an undeclared host in its arguments', async () => {
    const root = probeExtension(env.dir, {
      code: `export function activate(nova) {
  nova.tools.register({ name: 'wipe', description: 'Delete the cache', inputSchema: { type: 'object' }, handler: () => 'wiped' });
  nova.tools.register({ name: 'peek', description: 'Read a page', inputSchema: { type: 'object' }, handler: () => 'ok' });
}`,
      permissions: {
        network: ['api.example.com'],
        tools: { wipe: { action: 'delete' }, peek: { action: 'read', default: 'allow' } },
        actionDefaults: { delete: 'deny' },
      },
    });
    const preview = await env.service.preview(ACCOUNT, { kind: 'path', path: root });
    expect(preview).toMatchObject({
      verified: false,
      signature: 'unverified',
      sideloadReason: 'the bundle is not signed',
    });
    await env.service.install(ACCOUNT, { previewId: preview.previewId, confirmSideload: true });
    const wipe = await tool('ext:com.example.probe/wipe');
    expect(await env.gate.check(gateRequest(wipe.descriptor, {}), signal())).toMatchObject({
      effect: 'deny',
      reason: "the plugin's default for delete actions",
    });
    const peek = await tool('ext:com.example.probe/peek');
    expect(
      await env.gate.check(
        gateRequest(peek.descriptor, { url: 'https://api.example.com/a' }),
        signal(),
      ),
    ).toMatchObject({ effect: 'allow' });
    expect(
      await env.gate.check(
        gateRequest(peek.descriptor, { url: 'https://evil.example/a' }),
        signal(),
      ),
    ).toMatchObject({
      effect: 'deny',
      reason: 'evil.example is not a host this plugin declared',
    });
  });
});

describe('hooks (FR-197)', () => {
  const post = (accountId = ACCOUNT): Parameters<SdkEnv['hooks']['dispatch']>[1] => ({
    accountId,
    threadId: THREAD,
    turnId: 'turn-1',
    projectId: null,
    tool: {
      name: `ext:${HELLO_ID}/greet`,
      title: 'g',
      description: '',
      source: 'plugin',
      inputSchema: {},
    },
    args: {},
    result: 'Hello',
  });

  it('an SDK hook runs through the hooks area once trusted at its hash', async () => {
    await installSample({ trust: true });
    const listed = (await env.hooks.list(ACCOUNT)).find(
      (h) => h.id === `hook:${HELLO_ID}.note-greetings`,
    );
    expect(listed).toMatchObject({
      source: 'extension',
      status: 'trusted',
      handler: { type: 'mcp_tool', tool: `ext:${HELLO_ID}/hooks/note-greetings` },
    });
    const out = await env.hooks.dispatch('tool.post', post(), signal());
    expect(out.context).toEqual([
      { text: 'The hello extension greeted someone.', hookId: `hook:${HELLO_ID}.note-greetings` },
    ]);
    expect(env.audit.some((a) => a.action === 'hook.tool.post' && a.decision === 'context')).toBe(
      true,
    );
    await env.hooks.untrust(ACCOUNT, `hook:${HELLO_ID}.note-greetings`);
    expect((await env.hooks.dispatch('tool.post', post(), signal())).context).toEqual([]);
  });

  it('an untrusted SDK hook does not run; a new bundle needs trust again', async () => {
    const { view } = await installSample();
    expect(view.hooks[0]).toMatchObject({ status: 'needs_trust' });
    expect((await env.hooks.dispatch('tool.post', post(), signal())).context).toEqual([]);
    const h = view.hooks[0]!;
    await env.hooks.trust(ACCOUNT, h.id, h.contentHash);
    expect((await env.hooks.dispatch('tool.post', post(), signal())).context).toHaveLength(1);
    // A changed bundle (new digest): the hook waits for trust again.
    const root = copyHello(env.dir);
    writeFileSync(
      join(root, 'extension.js'),
      `${readFileSync(join(root, 'extension.js'), 'utf8')}\n// changed\n`,
    );
    const p = await env.service.preview(ACCOUNT, {
      kind: 'upload',
      bundle: b64(packFolder(root, key.privateKeyPem)),
    });
    expect(p.hooks[0]!.contentHash).not.toBe(h.contentHash);
    const updated = await env.service.install(ACCOUNT, { previewId: p.previewId });
    expect(updated.hooks[0]).toMatchObject({ status: 'needs_trust' });
    expect((await env.hooks.list(ACCOUNT)).find((x) => x.id === h.id)?.changedSinceTrust).toBe(
      true,
    );
  });
});

describe('signatures and sideloading (docs/14 §5)', () => {
  it('refuses a tampered bundle outright', async () => {
    env.settings.trusted = [{ name: 'Nova examples', key: key.publicKey }];
    const { strToU8, unzipSync, zipSync } = await import('fflate');
    const entries = unzipSync(packFolder(HELLO_DIR, key.privateKeyPem));
    entries['extension.js'] = strToU8(
      'export function activate(nova) { nova.net.fetch("https://evil.example/") }',
    );
    const err = await env.service
      .preview(ACCOUNT, { kind: 'upload', bundle: b64(zipSync(entries)) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NovaError);
    expect((err as NovaError).details).toMatchObject({
      reason: 'signature_invalid',
      why: 'digest_mismatch',
    });
    expect(env.audit.find((a) => a.action === 'extension.refused')?.detail).toMatchObject({
      reason: 'digest_mismatch',
    });
    expect(await env.service.list(ACCOUNT)).toEqual([]);
  });

  it('an unknown publisher installs only through the sideload confirmation and stays Unverified', async () => {
    const bytes = packFolder(HELLO_DIR, stranger.privateKeyPem);
    const preview = await env.service.preview(ACCOUNT, { kind: 'upload', bundle: b64(bytes) });
    expect(preview).toMatchObject({
      verified: false,
      signature: 'unverified',
      sideloadReason: 'the bundle is signed by a publisher you have not trusted',
      publisher: { key: stranger.publicKey, trusted: false, name: null },
    });
    expect(preview.publisher.fingerprint).toMatch(/:/);
    expect(preview.warnings[0]).toMatch(/^Unverified/);
    const err = await env.service
      .install(ACCOUNT, { previewId: preview.previewId })
      .catch((e: unknown) => e);
    expect((err as NovaError).details).toMatchObject({ reason: 'sideload_confirmation_required' });
    const view = await env.service.install(ACCOUNT, {
      previewId: preview.previewId,
      confirmSideload: true,
    });
    expect(view).toMatchObject({ verified: false, signature: 'unverified', status: 'running' });
    expect((await env.plugins.get(ACCOUNT, HELLO_ID)).verified).toBe(false);
    expect(env.audit.find((a) => a.action === 'extension.install')?.detail).toMatchObject({
      sideload: true,
      verified: false,
    });
    expect(env.audit.find((a) => a.action === 'plugin.install')?.detail).toMatchObject({
      verified: false,
      via: 'sideload',
    });
    // Trusting the key later makes the installed bundle verified; untrusting it unverifies it.
    env.settings.trusted = [{ name: 'Later', key: stranger.publicKey }];
    expect((await env.service.get(ACCOUNT, HELLO_ID)).verified).toBe(false);
  });

  it('managed policy can refuse unverified installs; an expired preview is refused', async () => {
    env.service.useInstallPolicy({
      installProblem: ({ verified }) =>
        Promise.resolve(
          verified ? null : 'Your organization does not allow unverified extensions.',
        ),
    });
    const preview = await env.service.preview(ACCOUNT, { kind: 'path', path: HELLO_DIR });
    const err = await env.service
      .install(ACCOUNT, { previewId: preview.previewId, confirmSideload: true })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'policy_denied' });
    await expect(
      env.service.install(ACCOUNT, { previewId: '01920000-0000-7000-8000-00000000dead' }),
    ).rejects.toMatchObject({ code: 'request_expired' });
    // A signed, trusted bundle still installs.
    env.service.useInstallPolicy(null);
    await installSample();
    expect((await env.service.list(ACCOUNT)).map((e) => e.id)).toEqual([HELLO_ID]);
  });

  it('installs a .novax file or a folder from the Hub; refuses what is not an extension', async () => {
    env.settings.trusted = [{ name: 'Nova examples', key: key.publicKey }];
    const file = join(env.dir, 'hello.novax');
    writeFileSync(file, packFolder(HELLO_DIR, key.privateKeyPem));
    expect(await env.service.preview(ACCOUNT, { kind: 'path', path: file })).toMatchObject({
      verified: true,
    });
    await expect(
      env.service.preview(ACCOUNT, { kind: 'path', path: join(env.dir, 'none') }),
    ).rejects.toThrow(/not found/);
    const plain = probeExtension(env.dir, { id: 'com.example.plain', code: '' });
    const { rmSync } = await import('node:fs');
    rmSync(join(plain, '.nova-plugin', 'extension.json'));
    await expect(env.service.preview(ACCOUNT, { kind: 'path', path: plain })).rejects.toThrow(
      /not an extension/,
    );
  });
});

describe('undeclared access (docs/14 §4.2)', () => {
  const code = `export function activate(nova) {
  const cmd = (id, run) => nova.commands.register({ id, run });
  cmd('ok-net', async () => (await nova.net.fetch('https://api.example.com/v1')).json());
  cmd('ok-fs', async () => { await nova.fs.write('\${extensionData}/a.txt', 'A'); return nova.fs.read('\${extensionData}/a.txt'); });
  cmd('ok-secret', () => nova.secrets.get('token'));
  cmd('net', () => nova.net.fetch('https://evil.example/steal'));
  cmd('fs', () => nova.fs.read('/etc/hostname'));
  cmd('fs-up', () => nova.fs.read('\${extensionData}/../../../../etc/hostname'));
  cmd('secret', () => nova.secrets.get('other'));
  cmd('tool', () => nova.tools.register({ name: 'sneaky', inputSchema: { type: 'object' }, handler: () => 1 }).ready);
}`;
  const permissions = {
    network: ['api.example.com'],
    fs: ['${extensionData}'],
    secrets: ['token'],
    commands: ['ok-net', 'ok-fs', 'ok-secret', 'net', 'fs', 'fs-up', 'secret', 'tool'],
  };

  async function probe(): Promise<void> {
    const root = probeExtension(env.dir, { code, permissions });
    const p = await env.service.preview(ACCOUNT, { kind: 'path', path: root });
    await env.service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
  }

  it('allows what was declared', async () => {
    await env.close();
    env = await makeSdkEnv({
      host: {
        fetch: (url) =>
          Promise.resolve(
            new Response(
              JSON.stringify({ url: url instanceof URL ? url.href : String(url as string) }),
              {
                headers: { 'content-type': 'application/json' },
              },
            ),
          ),
        restartDelayMs: 50,
      },
    });
    await probe();
    await env.service.setSecret(ACCOUNT, 'com.example.probe', 'token', 't0k');
    expect(
      await env.service.runCommand(ACCOUNT, 'com.example.probe', 'ok-net', null),
    ).toMatchObject({
      ok: true,
      result: { url: 'https://api.example.com/v1' },
    });
    expect((await env.service.runCommand(ACCOUNT, 'com.example.probe', 'ok-fs', null)).result).toBe(
      'A',
    );
    expect(existsSync(join(env.service.dataFolder(ACCOUNT, 'com.example.probe'), 'a.txt'))).toBe(
      true,
    );
    expect(
      (await env.service.runCommand(ACCOUNT, 'com.example.probe', 'ok-secret', null)).result,
    ).toBe('t0k');
    expect(env.audit.find((a) => a.action === 'extension.secret.read')).toMatchObject({
      kind: 'secret',
      decision: 'allowed',
    });
  });

  it.each([
    ['net', 'network', 'evil.example'],
    ['fs', 'fs', '/etc/hostname'],
    ['fs-up', 'fs', '${extensionData}/../../../../etc/hostname'],
    ['secret', 'secret', 'other'],
    ['tool', 'plugin', 'sneaky'],
  ])(
    '%s: denied, audited, the extension turned off and its worker ended',
    async (command, kind, target) => {
      await probe();
      expect(env.service.host.liveWorkers()).toBe(1);
      const r = await env.service.runCommand(ACCOUNT, 'com.example.probe', command, null);
      expect(r).toMatchObject({ ok: false, error: { code: 'policy_denied' } });
      const denied = env.audit.find((a) => a.action === 'extension.access.denied');
      expect(denied).toMatchObject({ kind, decision: 'denied', actor: 'ext:com.example.probe' });
      expect(denied?.detail).toMatchObject({ target });
      expect(env.events.names()).toContain('extension.access.denied');
      await until(
        async () => (await env.service.get(ACCOUNT, 'com.example.probe')).status === 'disabled',
      );
      await until(() => env.service.host.liveWorkers() === 0);
      expect(env.notices[0]).toMatchObject({
        kind: 'error',
        title: 'Extension com.example.probe was turned off',
      });
      expect(env.audit.find((a) => a.action === 'extension.disable')?.actor).toBe('system');
    },
  );
});

describe('lifecycle', () => {
  it('nova dev reloads a local extension in one request', async () => {
    const v1 = probeExtension(env.dir, {
      code: "export function activate(nova) { nova.commands.register({ id: 'v', run: () => 1 }); }",
      permissions: { commands: ['v'], hooks: [{ id: 'h', event: 'stop' }] },
    });
    const first = await env.service.dev(ACCOUNT, {
      bundle: b64(packFolder(v1)),
      confirmSideload: true,
      trustHooks: true,
    });
    expect(first).toMatchObject({
      signature: 'dev',
      verified: false,
      status: 'running',
      hooks: [{ status: 'trusted' }],
    });
    expect((await env.service.runCommand(ACCOUNT, 'com.example.probe', 'v', null)).result).toBe(1);
    writeFileSync(
      join(v1, 'main.js'),
      "export function activate(nova) { nova.commands.register({ id: 'v', run: () => 2 }); }",
    );
    const second = await env.service.dev(ACCOUNT, {
      bundle: b64(packFolder(v1)),
      confirmSideload: true,
    });
    expect(second.hooks[0]?.status).toBe('needs_trust');
    expect((await env.service.runCommand(ACCOUNT, 'com.example.probe', 'v', null)).result).toBe(2);
    expect(env.audit.filter((a) => a.action === 'extension.dev.reload')).toHaveLength(2);
    expect(env.service.host.liveWorkers()).toBe(1);
  });

  it('an update shows the permission diff', async () => {
    const root = probeExtension(env.dir, {
      code: 'export function activate() {}',
      permissions: { network: ['a.example.com'] },
    });
    const p1 = await env.service.preview(ACCOUNT, { kind: 'path', path: root });
    await env.service.install(ACCOUNT, { previewId: p1.previewId, confirmSideload: true });
    const v2 = probeExtension(env.dir, {
      code: 'export function activate() {}',
      version: '1.1.0',
      permissions: { network: ['b.example.com'], secrets: ['token'] },
    });
    const p2 = await env.service.preview(ACCOUNT, { kind: 'path', path: v2 });
    expect(p2.replaces).toEqual({ version: '1.0.0' });
    expect(p2.diff?.added.map((l) => l.key)).toEqual(['network:b.example.com', 'secret:token']);
    expect(p2.diff?.removed.map((l) => l.key)).toEqual(['network:a.example.com']);
    expect(p2.warnings.join(' ')).toMatch(/This update asks for more/);
    const view = await env.service.install(ACCOUNT, {
      previewId: p2.previewId,
      confirmSideload: true,
    });
    expect(view.version).toBe('1.1.0');
    expect(env.audit.find((a) => a.action === 'extension.update')?.detail).toMatchObject({
      previousVersion: '1.0.0',
    });
  });

  it('uninstall removes the worker, the plugin, its hooks, secrets and (on request) its data', async () => {
    await installSample({ trust: true });
    await env.service.setSecret(ACCOUNT, HELLO_ID, 'greeting', 'Hi');
    const save = await tool(`ext:${HELLO_ID}/save_note`);
    await save.handler({ text: 'x' }, { signal: signal() } as never);
    const data = env.service.dataFolder(ACCOUNT, HELLO_ID);
    const installPath = (await env.plugins.list(ACCOUNT))[0]!.origin;
    expect(installPath).toMatch(/^upload:/);
    expect(existsSync(join(data, 'note.txt'))).toBe(true);
    await env.service.uninstall(ACCOUNT, HELLO_ID, { removeData: true });
    expect(await env.service.list(ACCOUNT)).toEqual([]);
    expect(await env.plugins.list(ACCOUNT)).toEqual([]);
    expect((await env.hooks.list(ACCOUNT)).filter((h) => h.source === 'extension')).toEqual([]);
    expect(await env.secrets.list(`secret://extension/${ACCOUNT}/${HELLO_ID}/`)).toEqual([]);
    expect(existsSync(data)).toBe(false);
    expect(existsSync(join(env.dir, 'data', 'plugins', HELLO_ID))).toBe(false);
    expect(env.service.host.liveWorkers()).toBe(0);
    expect(await env.service.tools.list(ACCOUNT)).toEqual([]);
    expect(env.audit.find((a) => a.action === 'extension.uninstall')?.detail).toEqual({
      removedData: true,
    });
    await expect(env.service.get(ACCOUNT, HELLO_ID)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('disable ends the worker and hides its parts; enable brings them back; close ends all', async () => {
    await installSample({ trust: true });
    expect(env.service.host.liveWorkers()).toBe(1);
    const off = await env.service.setEnabled(ACCOUNT, HELLO_ID, false);
    expect(off).toMatchObject({ enabled: false, status: 'disabled' });
    await until(() => env.service.host.liveWorkers() === 0);
    expect(await env.service.tools.list(ACCOUNT)).toEqual([]);
    expect(env.service.uiPanels(ACCOUNT)).toEqual([]);
    expect((await env.hooks.list(ACCOUNT)).find((h) => h.source === 'extension')?.status).toBe(
      'disabled',
    );
    const on = await env.service.setEnabled(ACCOUNT, HELLO_ID, true);
    expect(on.status).toBe('running');
    expect((await env.hooks.list(ACCOUNT)).find((h) => h.source === 'extension')?.status).toBe(
      'trusted',
    );
    expect(env.service.host.liveWorkers()).toBe(1);
    await env.service.close();
    await until(() => env.service.host.liveWorkers() === 0);
    expect(env.service.host.status(ACCOUNT, HELLO_ID).status).toBe('stopped');
  });

  it('the SDK switch stops and starts every extension', async () => {
    await installSample();
    env.settings.enabled = false;
    await env.service.stopAll();
    expect(await env.service.get(ACCOUNT, HELLO_ID)).toMatchObject({
      status: 'stopped',
      stopped: { reason: 'sdk_off', policy: null },
    });
    // Turned off by the owner, it is off, not stopped: no stop reason.
    expect((await env.service.setEnabled(ACCOUNT, HELLO_ID, false)).stopped).toBeNull();
    await env.service.setEnabled(ACCOUNT, HELLO_ID, true);
    await env.service.startAll();
    expect(env.service.host.liveWorkers()).toBe(0);
    env.settings.enabled = true;
    await env.service.startAll();
    expect((await env.service.get(ACCOUNT, HELLO_ID)).status).toBe('running');
    expect(env.service.diagnostics()).toEqual({ installed: 1, running: 1, previews: 0 });
  });

  it('a fault (a runaway handler) ends the worker; it restarts, and stops after repeated faults', async () => {
    await env.close();
    env = await makeSdkEnv({
      host: { limits: { sliceMs: 150 }, restartDelayMs: 30, maxRestarts: 1 },
    });
    const root = probeExtension(env.dir, {
      code: `export function activate(nova) {
  nova.commands.register({ id: 'spin', run() { for (;;) {} } });
  nova.commands.register({ id: 'ok', run: () => 'fine' });
}`,
      permissions: { commands: ['spin', 'ok'] },
    });
    const p = await env.service.preview(ACCOUNT, { kind: 'path', path: root });
    await env.service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    // The worker activates after install returns; on a loaded machine its commands come later.
    await until(() => env.service.host.status(ACCOUNT, 'com.example.probe').status === 'running');
    const r = await env.service.runCommand(ACCOUNT, 'com.example.probe', 'spin', null);
    expect(r.ok).toBe(false);
    await until(() => env.service.host.status(ACCOUNT, 'com.example.probe').status === 'running');
    expect((await env.service.runCommand(ACCOUNT, 'com.example.probe', 'ok', null)).result).toBe(
      'fine',
    );
    await env.service.runCommand(ACCOUNT, 'com.example.probe', 'spin', null);
    await until(() => env.service.host.status(ACCOUNT, 'com.example.probe').status === 'error');
    expect((await env.service.get(ACCOUNT, 'com.example.probe')).error).toMatch(/repeated faults/);
    expect(env.service.host.liveWorkers()).toBe(0);
  });

  it('events reach listeners of the declared events of the same account only', async () => {
    const root = probeExtension(env.dir, {
      code: `let seen = [];
export function activate(nova) {
  nova.events.on('run.*', (e) => { seen.push(e.name + ':' + e.payload.runId); });
  nova.commands.register({ id: 'seen', run: () => seen });
}`,
      permissions: { commands: ['seen'], events: ['run.*'] },
    });
    const p = await env.service.preview(ACCOUNT, { kind: 'path', path: root });
    await env.service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    const env0 = { id: 'e', schemaVersion: 1, ts: new Date().toISOString(), actor: 'system' };
    env.service.host.dispatchEvent({
      ...env0,
      name: 'run.completed',
      accountId: ACCOUNT,
      payload: { runId: 'r1', secret: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345' },
    });
    env.service.host.dispatchEvent({
      ...env0,
      name: 'run.completed',
      accountId: 'someone-else',
      payload: { runId: 'r2' },
    });
    env.service.host.dispatchEvent({
      ...env0,
      name: 'settings.changed',
      accountId: ACCOUNT,
      payload: {},
    });
    await vi.waitFor(async () =>
      expect(
        (await env.service.runCommand(ACCOUNT, 'com.example.probe', 'seen', null)).result,
      ).toEqual(['run.completed:r1']),
    );
  });

  it('adopts an extension installed through the plugins area', async () => {
    const root = copyHello(env.dir);
    const p = await env.plugins.preview(ACCOUNT, { kind: 'path', path: root });
    await env.plugins.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    await until(async () => (await env.service.list(ACCOUNT)).some((e) => e.status === 'running'));
    expect((await env.service.get(ACCOUNT, HELLO_ID)).signature).toBe('unverified');
    await env.plugins.setEnabled(ACCOUNT, HELLO_ID, false);
    await until(() => env.service.host.liveWorkers() === 0);
    await env.plugins.uninstall(ACCOUNT, HELLO_ID);
    await until(async () => (await env.service.list(ACCOUNT)).length === 0);
  });
});

describe('provenance and rollback (FR-049 with FR-117)', () => {
  /** v1 of the sample signed by the trusted key, and v1.1.0 with one more line of code. */
  function versions(): { v1: Uint8Array; v2: Uint8Array } {
    env.settings.trusted = [{ name: 'Nova examples', key: key.publicKey }];
    const root = copyHello(env.dir, 'versions');
    const v1 = packFolder(root, key.privateKeyPem);
    const pj = join(root, '.nova-plugin', 'plugin.json');
    writeFileSync(pj, readFileSync(pj, 'utf8').replace('"1.0.0"', '"1.1.0"'));
    writeFileSync(
      join(root, 'extension.js'),
      `${readFileSync(join(root, 'extension.js'), 'utf8')}\n// v2\n`,
    );
    return { v1, v2: packFolder(root, key.privateKeyPem) };
  }

  async function install(
    bytes: Uint8Array,
    provenance?: Parameters<SdkEnv['service']['preview']>[2],
  ) {
    const p = await env.service.preview(
      ACCOUNT,
      { kind: 'upload', bundle: b64(bytes) },
      provenance,
    );
    return env.service.install(ACCOUNT, {
      previewId: p.previewId,
      trustHooks: p.hooks.map((h) => ({ id: h.id, contentHash: h.contentHash })),
    });
  }

  const pluginRow = () =>
    env.db.raw
      .prepare('SELECT source, origin, signature, version FROM plugin_install WHERE plugin_id = ?')
      .get(HELLO_ID) as { source: string; origin: string; signature: string; version: string };

  it('records where an install came from; the verdict stays the signature check', async () => {
    const { v1 } = versions();
    await install(v1, { source: 'catalog', origin: 'cat/com.example.hello@1.0.0', via: 'cat' });
    expect(pluginRow()).toEqual({
      source: 'catalog',
      origin: 'cat/com.example.hello@1.0.0',
      signature: 'verified',
      version: '1.0.0',
    });
    expect(env.audit.find((a) => a.action === 'plugin.install')?.detail).toMatchObject({
      verified: true,
      source: 'catalog',
      origin: 'cat/com.example.hello@1.0.0',
      via: 'cat',
    });
    expect(env.audit.find((a) => a.action === 'extension.install')?.detail).toMatchObject({
      verified: true,
      source: 'catalog',
      via: 'cat',
    });
    // Given at install time instead, it replaces the preview's.
    const p = await env.service.preview(ACCOUNT, { kind: 'upload', bundle: b64(v1) });
    await env.service.install(
      ACCOUNT,
      { previewId: p.previewId },
      { source: 'git', origin: 'g@1' },
    );
    expect(pluginRow()).toMatchObject({ source: 'git', origin: 'g@1', signature: 'verified' });
  });

  it('a failed update puts the previous signed bundle back, verified, trusted and running', async () => {
    const { v1, v2 } = versions();
    await install(v1, { source: 'catalog', origin: 'cat/com.example.hello@1.0.0', via: 'cat' });
    const kept = join(env.dir, 'data', 'extensions', 'bundles', ACCOUNT, `${HELLO_ID}.novax`);
    expect(Buffer.from(readFileSync(kept)).equals(Buffer.from(v1))).toBe(true);
    // The update commits the plugin, then the hooks step fails once.
    const store = env.hooks.store;
    const sync = store.sync.bind(store);
    let fail = true;
    store.sync = (...a) => {
      // The extension's own step (the hooks area syncs plugin hooks too).
      if (fail && a[1].source === 'extension') {
        fail = false;
        return Promise.reject(new Error('disk full'));
      }
      return sync(...a);
    };
    await expect(install(v2)).rejects.toThrow(/disk full/);
    const back = await env.service.get(ACCOUNT, HELLO_ID);
    expect(back).toMatchObject({
      version: '1.0.0',
      verified: true,
      signature: 'verified',
      publisher: { key: key.publicKey, trusted: true },
      status: 'running',
      hooks: [{ status: 'trusted' }],
    });
    expect(pluginRow()).toEqual({
      source: 'catalog',
      origin: 'cat/com.example.hello@1.0.0',
      signature: 'verified',
      version: '1.0.0',
    });
    expect(Buffer.from(readFileSync(kept)).equals(Buffer.from(v1))).toBe(true);
    expect(env.audit.filter((a) => a.action === 'extension.update').at(-1)?.detail).toMatchObject({
      version: '1.0.0',
      previousVersion: '1.1.0',
      via: 'rollback',
      verified: true,
    });
  });

  it('a failed first install leaves nothing behind', async () => {
    const { v1 } = versions();
    const store = env.hooks.store;
    const sync = store.sync.bind(store);
    store.sync = (...a) =>
      a[1].source === 'extension' && a[2].length
        ? Promise.reject(new Error('disk full'))
        : sync(...a);
    await expect(install(v1)).rejects.toThrow(/disk full/);
    expect(await env.service.list(ACCOUNT)).toEqual([]);
    expect(await env.plugins.list(ACCOUNT)).toEqual([]);
    expect(env.service.host.liveWorkers()).toBe(0);
  });

  it('a snapshot restores the previous version as it was installed, verified or not', async () => {
    const { v1, v2 } = versions();
    await install(v1, { source: 'catalog', origin: 'cat/com.example.hello@1.0.0', via: 'cat' });
    await env.service.setEnabled(ACCOUNT, HELLO_ID, false);
    const restore = await env.service.snapshot(ACCOUNT, HELLO_ID);
    await install(v2, { source: 'catalog', origin: 'cat/com.example.hello@1.1.0', via: 'cat' });
    expect((await env.service.get(ACCOUNT, HELLO_ID)).version).toBe('1.1.0');
    await restore!();
    expect(await env.service.get(ACCOUNT, HELLO_ID)).toMatchObject({
      version: '1.0.0',
      verified: true,
      enabled: false,
      status: 'disabled',
      hooks: [{ status: 'disabled' }],
    });
    expect(pluginRow()).toMatchObject({ origin: 'cat/com.example.hello@1.0.0', source: 'catalog' });
    expect(await env.service.snapshot(ACCOUNT, 'com.example.none')).toBeNull();

    // A sideloaded extension comes back Unverified without asking again.
    await env.service.uninstall(ACCOUNT, HELLO_ID);
    expect(
      existsSync(join(env.dir, 'data', 'extensions', 'bundles', ACCOUNT, `${HELLO_ID}.novax`)),
    ).toBe(false);
    env.settings.trusted = [];
    const p = await env.service.preview(ACCOUNT, { kind: 'upload', bundle: b64(v1) });
    await env.service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    const again = await env.service.snapshot(ACCOUNT, HELLO_ID);
    const p2 = await env.service.preview(ACCOUNT, { kind: 'upload', bundle: b64(v2) });
    await env.service.install(ACCOUNT, { previewId: p2.previewId, confirmSideload: true });
    await again!();
    expect(await env.service.get(ACCOUNT, HELLO_ID)).toMatchObject({
      version: '1.0.0',
      verified: false,
      signature: 'unverified',
      publisher: { key: key.publicKey, trusted: false },
    });
  });
});

describe('managed policy (FR-106, D4)', () => {
  let layers: Record<string, unknown>[];
  let failClosed: string | null;
  beforeEach(() => {
    layers = [];
    failClosed = null;
    env.service.useManaged(() =>
      Promise.resolve(managedRestrictions({ layers, failClosed }, { home: '/home/x' })),
    );
  });

  const hookPost = () => ({
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: 'turn-1',
    projectId: null,
    tool: {
      name: `ext:${HELLO_ID}/greet`,
      title: 'g',
      description: '',
      source: 'plugin' as const,
      inputSchema: {},
    },
    args: {},
    result: 'Hello',
  });

  it('stops a running extension the policy now refuses, with its hooks; starts it again when allowed', async () => {
    await installSample({ trust: true });
    expect(env.service.host.liveWorkers()).toBe(1);
    layers.push({ extensions: { deny: ['com.example.*'] } });
    await env.service.reapplyPolicy();
    expect(env.service.host.liveWorkers()).toBe(0);
    const refused = await env.service.get(ACCOUNT, HELLO_ID);
    expect(refused).toMatchObject({
      status: 'stopped',
      // Why, for the card: the policy's extensions list, so a client can name its source.
      stopped: { reason: 'managed', policy: 'extensions' },
      error: expect.stringMatching(/not allowed/),
    });
    // Its hooks are off, so they neither run nor block what they guard.
    expect((await env.hooks.list(ACCOUNT)).find((h) => h.source === 'extension')?.status).toBe(
      'disabled',
    );
    expect((await env.hooks.dispatch('tool.post', hookPost(), signal())).context).toEqual([]);
    expect(env.audit.find((a) => a.action === 'extension.refused')?.detail).toMatchObject({
      reason: 'managed',
    });
    await expect(env.service.setEnabled(ACCOUNT, HELLO_ID, true)).rejects.toMatchObject({
      code: 'policy_denied',
    });
    // startAll (Hub start, an import) starts nothing the policy refuses.
    await env.service.startAll();
    expect(env.service.host.liveWorkers()).toBe(0);
    layers.length = 0;
    await env.service.reapplyPolicy();
    expect(await env.service.get(ACCOUNT, HELLO_ID)).toMatchObject({
      status: 'running',
      stopped: null,
      error: null,
    });
    expect((await env.hooks.list(ACCOUNT)).find((h) => h.source === 'extension')?.status).toBe(
      'trusted',
    );
  });

  it('an unverified extension does not start or restore while unverified installs are refused', async () => {
    const bytes = packFolder(HELLO_DIR, stranger.privateKeyPem);
    const p = await env.service.preview(ACCOUNT, { kind: 'upload', bundle: b64(bytes) });
    await env.service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    const restore = await env.service.snapshot(ACCOUNT, HELLO_ID);
    layers.push({ unverifiedInstalls: false });
    await env.service.reapplyPolicy();
    expect(env.service.host.liveWorkers()).toBe(0);
    // As after an import: the rows are there, and startAll leaves it stopped.
    await env.service.startAll();
    expect(env.service.host.liveWorkers()).toBe(0);
    expect(await env.service.get(ACCOUNT, HELLO_ID)).toMatchObject({
      status: 'stopped',
      stopped: { reason: 'managed', policy: 'unverifiedInstalls' },
      error: expect.stringMatching(/unverified extension/),
    });
    await expect(restore!()).rejects.toMatchObject({ code: 'policy_denied' });
    expect(env.service.host.liveWorkers()).toBe(0);
    // A verified one still runs under the same policy.
    await env.service.uninstall(ACCOUNT, HELLO_ID);
    const { view } = await installSample();
    expect(view.status).toBe('running');
    // An unreadable policy fails closed.
    failClosed = 'bad signature';
    await env.service.reapplyPolicy();
    expect(await env.service.get(ACCOUNT, HELLO_ID)).toMatchObject({
      status: 'stopped',
      stopped: { reason: 'managed_unreadable', policy: null },
      error: expect.stringMatching(/could not be read/),
    });
    expect(env.service.host.liveWorkers()).toBe(0);
  });

  it('a refused extension hook gets a deny from the hook gate, not the allow for trusted hooks', async () => {
    await installSample({ trust: true });
    const name = `ext:${HELLO_ID}/hooks/note-greetings`;
    const req = {
      ...gateRequest({ name, title: 'h', description: '', source: 'plugin', inputSchema: {} }, {}),
      origin: 'hook' as const,
    };
    const gate = env.service.hookGate(env.gate);
    expect(await gate.check(req, signal())).toMatchObject({
      effect: 'allow',
      reason: 'a trusted extension hook',
    });
    // The worker still runs (no reapply yet): the gate itself refuses.
    layers.push({ plugins: { deny: [HELLO_ID] } });
    expect(await gate.check(req, signal())).toMatchObject({
      effect: 'deny',
      reason: expect.stringMatching(/not allowed/),
    });
    expect(env.audit.some((a) => a.action === 'extension.hook.refused')).toBe(true);
  });

  it("net.fetch keeps to the egress mode, deny lists and the policy's allowed hosts", async () => {
    await env.close();
    const seen: string[] = [];
    env = await makeSdkEnv({
      host: {
        fetch: (url, init) => {
          seen.push(
            `${String(init?.method)} ${url instanceof URL ? url.href : (url as Request).url}`,
          );
          return Promise.resolve(new Response('ok'));
        },
      },
    });
    env.service.useManaged(() =>
      Promise.resolve(managedRestrictions({ layers, failClosed }, { home: '/home/x' })),
    );
    const root = probeExtension(env.dir, {
      code: `export function activate(nova) {
  nova.commands.register({ id: 'f', run: async (a) => { try { return (await nova.net.fetch(a.url, { method: a.method })).status; } catch (e) { return e.code + ': ' + e.message; } } });
}`,
      permissions: { commands: ['f'], network: ['*.example.com'] },
    });
    const p = await env.service.preview(ACCOUNT, { kind: 'path', path: root });
    await env.service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    const f = async (url: string, method = 'GET') =>
      (await env.service.runCommand(ACCOUNT, 'com.example.probe', 'f', { url, method })).result;
    expect(await f('https://a.example.com/')).toBe(200);
    layers.push({
      egress: {
        mode: 'limited',
        deny: ['b.example.com'],
        allow: ['a.example.com', 'c.example.com'],
      },
    });
    expect(await f('https://a.example.com/', 'POST')).toMatch(/^policy_denied: only read requests/);
    expect(await f('https://a.example.com/')).toBe(200);
    expect(await f('https://b.example.com/')).toMatch(/egress deny list/);
    expect(await f('https://d.example.com/')).toMatch(
      /not among the hosts your organization's managed policy allows/,
    );
    layers.length = 0;
    layers.push({ egress: { mode: 'off' } });
    expect(await f('https://a.example.com/')).toMatch(/turned off/);
    layers.length = 0;
    failClosed = 'unreadable';
    // A policy that cannot be read refuses the request itself (and reapplying would stop it).
    expect(await f('https://a.example.com/')).toMatch(/^policy_denied: network access is off/);
    // A refusal by policy is audited and does not turn the extension off (it declared the host).
    expect(
      env.audit.filter((a) => a.action === 'extension.egress.denied').length,
    ).toBeGreaterThanOrEqual(4);
    expect(env.notices).toEqual([]);
    expect(seen.filter((x) => x.startsWith('POST'))).toEqual([]);
  });

  it('the egress settings narrow it too', async () => {
    await env.close();
    let mode: 'off' | 'limited' | 'allowlist' = 'allowlist';
    let deny: string[] = [];
    env = await makeSdkEnv({
      host: { fetch: () => Promise.resolve(new Response('ok')) },
      settings: {
        enabled: () => Promise.resolve(true),
        trustedPublishers: () => Promise.resolve([]),
        egress: () => Promise.resolve({ mode, deny }),
      },
    });
    const root = probeExtension(env.dir, {
      code: `export function activate(nova) {
  nova.commands.register({ id: 'f', run: async () => { try { return (await nova.net.fetch('https://a.example.com/')).status; } catch (e) { return e.message; } } });
}`,
      permissions: { commands: ['f'], network: ['a.example.com'] },
    });
    const p = await env.service.preview(ACCOUNT, { kind: 'path', path: root });
    await env.service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    const f = async () =>
      (await env.service.runCommand(ACCOUNT, 'com.example.probe', 'f', null)).result;
    expect(await f()).toBe(200);
    deny = ['*.example.com'];
    expect(await f()).toMatch(/egress deny list/);
    deny = [];
    mode = 'off';
    expect(await f()).toMatch(/turned off/);
  });
});

describe('status items', () => {
  it('say whether a click does something: a command, an onClick handler, or neither', async () => {
    const root = probeExtension(env.dir, {
      code: `let clicks = 0;
export function activate(nova) {
  nova.commands.register({ id: 'c', run: () => 'command' });
  nova.status.addItem({ id: 'by-command', text: 'A', onClick: 'c' });
  nova.status.addItem({ id: 'by-handler', text: 'B', onClick: () => ++clicks });
  nova.status.addItem({ id: 'plain', text: 'C' });
}`,
      permissions: { commands: ['c'] },
    });
    const p = await env.service.preview(ACCOUNT, { kind: 'path', path: root });
    await env.service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    await until(() => env.service.contributions(ACCOUNT).statusItems.length === 3);
    expect(env.service.contributions(ACCOUNT).statusItems).toEqual([
      {
        extensionId: 'com.example.probe',
        id: 'by-command',
        text: 'A',
        command: 'c',
        clickable: true,
      },
      {
        extensionId: 'com.example.probe',
        id: 'by-handler',
        text: 'B',
        command: null,
        clickable: true,
      },
      { extensionId: 'com.example.probe', id: 'plain', text: 'C', command: null, clickable: false },
    ]);
    const click = async (id: string) =>
      (await env.service.clickStatus(ACCOUNT, 'com.example.probe', id)).result;
    expect(await click('by-command')).toBe('command');
    expect(await click('by-handler')).toBe(1);
    expect(await click('plain')).toBeNull();
  });
});
