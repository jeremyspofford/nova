// The SDK's test host (FR-117, docs/14 §4): the sample extension activates and its command,
// tool, hook and events work; undeclared commands, tools, hosts, files, secrets and events are
// refused as the Hub would refuse them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  API_VERSION,
  PermissionDeniedError,
  createTestHost,
  defineExtension,
  type Extension,
  type ExtensionManifest,
} from '../src/index.ts';

const HELLO = new URL('../examples/hello/', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('.nova-plugin/extension.json', HELLO), 'utf8'),
) as ExtensionManifest;

async function hello(): Promise<Extension> {
  return (await import(new URL('extension.js', HELLO).href)) as Extension;
}

describe('the sample extension in the test host', () => {
  it('registers a command, a panel and a tool, and they work', async () => {
    const host = createTestHost(manifest, {
      extensionId: 'com.example.hello',
      secrets: { greeting: 'Hi' },
    });
    await (await hello()).activate(host.nova);
    expect([...host.commands.keys()]).toEqual(['hello.greet']);
    expect([...host.panels.keys()]).toEqual(['hello.panel']);
    expect([...host.tools.keys()].sort()).toEqual(['greet', 'save_note']);
    expect(host.denied).toEqual([]);
    expect(await host.run('hello.greet', { name: 'Ada' })).toEqual({
      text: 'Hi, Ada!',
      greeted: 1,
    });
    expect(host.status.get('hello.count')?.text).toBe('Hello: 1');
    expect(await host.callTool('greet', { name: 'Grace' })).toBe('Hello, Grace!');
    expect(await host.callTool('save_note', { text: 'remember' })).toBe('Saved.');
    expect(host.files.get('${extensionData}/note.txt')).toBe('remember');
    expect(await host.runHook('note-greetings', { tool: 'ext:com.example.hello/greet' })).toEqual({
      context: 'The hello extension greeted someone.',
    });
    await host.emit('tool.call.completed', { callId: 'c1' });
    expect(host.keybindings).toEqual([{ command: 'hello.greet', key: 'mod+shift+h' }]);
    expect(host.menus[0]?.where).toBe('thread');
    expect(host.logs[0]).toContain('hello is ready');
  });
});

describe('declared permissions', () => {
  const m: ExtensionManifest = {
    api: 1,
    entry: 'x.js',
    permissions: {
      network: ['*.example.com'],
      fs: ['${extensionData}', '/srv/shared'],
      secrets: ['token'],
      commands: ['a.run'],
      events: ['run.*'],
    },
  };

  it('refuses what was not declared, and remembers it', async () => {
    const host = createTestHost(m);
    const { nova } = host;
    expect(() => nova.commands.register({ id: 'b.run', run: () => 1 })).toThrow(
      PermissionDeniedError,
    );
    expect(() =>
      nova.tools.register({ name: 'x', inputSchema: { type: 'object' }, handler: () => 'x' }),
    ).toThrow(/the tool x/);
    expect(() => nova.events.on('chat.message.created', () => undefined)).toThrow(/event/);
    await expect(nova.net.fetch('https://evil.test/')).rejects.toThrow(/evil\.test/);
    await expect(nova.secrets.get('other')).rejects.toThrow(/secret other/);
    await expect(nova.fs.write('/srv/shared/x', 'y')).rejects.toThrow(/write access/);
    await expect(nova.fs.read('/etc/passwd')).rejects.toThrow(/read access/);
    await expect(nova.fs.read('${extensionData}/../x')).rejects.toThrow(/read access/);
    expect(() => nova.keybindings.register({ command: 'nope', key: 'k' })).toThrow();
    expect(() =>
      nova.menus.register({ where: 'thread', items: [{ title: 't', command: 'nope' }] }),
    ).toThrow();
    expect(() => nova.status.addItem({ id: 's', text: 't', onClick: 'nope' })).toThrow();
    expect(host.denied).toHaveLength(11);
  });

  it('allows what was declared', async () => {
    const host = createTestHost(m, {
      secrets: { token: 't0k' },
      files: { '/srv/shared/a.txt': 'A' },
      fetch: (url) => Promise.resolve({ status: 200, body: JSON.stringify({ url }) }),
    });
    const { nova } = host;
    const reg = nova.commands.register({ id: 'a.run', run: (args) => ({ args }) });
    await reg.ready;
    expect(await host.run('a.run', 1)).toEqual({ args: 1 });
    reg.dispose();
    await expect(host.run('a.run')).rejects.toThrow(/not registered/);
    const res = await nova.net.fetch('https://api.example.com/v1');
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ url: 'https://api.example.com/v1' });
    expect(await nova.secrets.get('token')).toBe('t0k');
    expect(await nova.fs.read('/srv/shared/a.txt')).toBe('A');
    expect(await nova.fs.list('/srv/shared')).toEqual([
      { name: 'a.txt', kind: 'file', size: null },
    ]);
    await nova.fs.write('${extensionData}/n', 'x');
    await nova.fs.remove('${extensionData}/n');
    expect(host.files.has('${extensionData}/n')).toBe(false);
    let seen = '';
    nova.events.on('run.end', (e) => {
      seen = e.name;
    });
    await host.emit('run.completed');
    expect(seen).toBe('run.completed');
    nova.themes.register({ schemaVersion: 1, id: 'a.b', name: 'T', variant: 'dark', tokens: {} });
    expect(host.themes.has('a.b')).toBe(true);
    nova.log('a', { b: 1 });
    expect(host.logs).toEqual(['a {"b":1}']);
    expect(host.denied).toEqual([]);
  });

  it('types an extension and states the API version', () => {
    const ext = defineExtension({ activate: () => undefined });
    expect(typeof ext.activate).toBe('function');
    expect(API_VERSION).toBe(1);
  });
});
