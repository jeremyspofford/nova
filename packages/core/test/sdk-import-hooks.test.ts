// Hooks of other plugin layouts converted on import (FR-200; docs/08 §4.2): event maps become
// Nova hooks (events, tool matchers, start reasons and compaction triggers translated, the
// plugin-root variable as ${pluginRoot}, timeouts in milliseconds); shell commands, prompt hooks,
// unknown events and untranslatable matchers are left out with a note; the imported plugin
// installs with its hooks waiting for trust.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import {
  HookService,
  ImportService,
  PluginCatalogs,
  PluginService,
  SkillIndex,
  commandArgv,
  convertForeignHooks,
  loadPluginFolder,
  type ImportTargets,
} from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

describe('converting an event map', () => {
  it('turns command hooks into Nova hooks with translated events and matchers', () => {
    const out = convertForeignHooks({
      description: 'formatting and guards',
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: '${ACME_PLUGIN_ROOT}/scripts/guard.sh --strict',
                timeout: 5,
              },
            ],
          },
          {
            matcher: 'mcp__github__create_issue|mcp__db__.*',
            hooks: [{ type: 'command', command: 'node check.js' }],
          },
        ],
        PostToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit',
            hooks: [{ type: 'command', command: '"$ACME_PLUGIN_ROOT/fmt" "a b"' }],
          },
        ],
        SessionStart: [
          {
            matcher: 'startup|resume',
            hooks: [{ type: 'command', command: 'echo hi', timeout: 0.1 }],
          },
        ],
        PreCompact: [
          { matcher: 'auto', hooks: [{ type: 'command', command: 'save', timeout: 9999 }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }],
      },
    });
    expect(out.hooks).toEqual([
      {
        id: 'tool-pre-1',
        event: 'tool.pre',
        matcher: 'exec.run',
        handler: {
          type: 'command',
          command: ['${pluginRoot}/scripts/guard.sh', '--strict'],
          timeoutMs: 5000,
        },
      },
      {
        id: 'tool-pre-2',
        event: 'tool.pre',
        matcher: ['mcp:github.create_issue', 'mcp:db.*'],
        handler: { type: 'command', command: ['node', 'check.js'], timeoutMs: 30_000 },
      },
      {
        id: 'tool-post-1',
        event: 'tool.post',
        matcher: ['fs.write', 'fs.edit'],
        handler: { type: 'command', command: ['${pluginRoot}/fmt', 'a b'], timeoutMs: 30_000 },
      },
      {
        id: 'session-start-1',
        event: 'session.start',
        matcher: ['new', 'resume'],
        handler: { type: 'command', command: ['echo', 'hi'], timeoutMs: 1000 },
      },
      {
        id: 'compact-pre-1',
        event: 'compact.pre',
        matcher: ['pre_turn', 'mid_turn', 'post_turn'],
        handler: { type: 'command', command: ['save'], timeoutMs: 600_000 },
      },
      {
        id: 'stop-1',
        event: 'stop',
        handler: { type: 'command', command: ['notify'], timeoutMs: 30_000 },
      },
    ]);
    expect(out.notes).toEqual(['6 hooks converted; they wait for your trust before they run']);
  });

  it('leaves out what it cannot run without a shell or translate, and says why', () => {
    const out = convertForeignHooks({
      hooks: {
        Notification: [{ hooks: [{ type: 'command', command: 'say' }] }],
        PreToolUse: [
          { matcher: 'TodoWrite', hooks: [{ type: 'command', command: 'x' }] },
          { matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'is this safe?' }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'jq . | tee log' }] },
        ],
        SessionStart: [{ matcher: 'clear', hooks: [{ type: 'command', command: 'x' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'FOO=1 run' }] }],
      },
    });
    expect(out.hooks).toEqual([]);
    expect(out.notes[0]).toMatch(/^hooks left out: /);
    expect(out.notes[0]).toMatch(/Notification \(Nova has no such event\)/);
    expect(out.notes[0]).toMatch(/TodoWrite/);
    expect(out.notes[0]).toMatch(/a prompt hook at PreToolUse/);
    expect(out.notes[0]).toMatch(/needs a shell/);
    expect(convertForeignHooks({}).notes).toEqual([
      'its hooks use another format Nova cannot read; none were imported',
    ]);
    expect(convertForeignHooks(null).hooks).toEqual([]);
  });

  it('splits command lines without a shell', () => {
    expect(commandArgv("python3 'my script.py' --x=1")).toEqual([
      'python3',
      'my script.py',
      '--x=1',
    ]);
    expect(commandArgv('${MY_PLUGIN_ROOT}/a')).toEqual(['${pluginRoot}/a']);
    for (const bad of [
      'a && b',
      'a > f',
      'echo $HOME',
      '"$(x)"',
      'a\\ b',
      '"open',
      '',
      'x; y',
      'X=1 y',
    ])
      expect(commandArgv(bad), bad).toBeNull();
  });
});

describe('importing a plugin of another layout', () => {
  let env: Env;
  let root: string;
  beforeEach(async () => {
    env = await makeEnv();
    root = join(env.dir, 'src');
  });
  afterEach(() => env.close());

  function put(rel: string, content: string): void {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  it('installs it disabled with its converted hooks waiting for trust', async () => {
    put(
      'tools/.acme-plugin/plugin.json',
      JSON.stringify({ name: 'Format Tools', version: '1.2.0' }),
    );
    put('tools/scripts/fmt.sh', '#!/bin/sh\nexit 0\n');
    put(
      'tools/hooks/hooks.json',
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'Write',
              hooks: [{ type: 'command', command: '${ACME_PLUGIN_ROOT}/scripts/fmt.sh' }],
            },
          ],
          Notification: [{ hooks: [{ type: 'command', command: 'say' }] }],
        },
      }),
    );
    const dataDir = join(env.dir, 'data');
    const events = env.events;
    const plugins = new PluginService({
      db: env.db,
      secrets: new MemorySecretStore(),
      dataDir,
      catalogs: new PluginCatalogs({ cacheDir: join(env.dir, 'cache') }),
      catalogConfigs: () => Promise.resolve([]),
      events,
    });
    const hooks = new HookService({ db: env.db, events, userFile: join(dataDir, 'hooks.json') });
    hooks.usePluginHooks(plugins.hooks);
    const targets: ImportTargets = {
      skills: new SkillIndex({ db: env.db, userDir: join(dataDir, 'skills'), builtinDir: null }),
      plugins: {
        installDisabled: async (accountId, folder) => {
          const p = await plugins.preview(accountId, { kind: 'path', path: folder });
          const v = await plugins.install(accountId, {
            previewId: p.previewId,
            confirmSideload: true,
            enable: false,
          });
          return { id: v.id, name: v.name };
        },
      },
      folders: { add: () => Promise.resolve() },
    };
    const svc = new ImportService({
      db: env.db,
      secrets: env.secrets,
      events,
      dataDir,
      memory: env.memory,
      projects: env.projects,
      targets,
      home: join(env.dir, 'home'),
    });
    const preview = await svc.preview(ACCOUNT, {
      paths: [join(root, 'tools')],
      kinds: ['plugins'],
    });
    const item = preview.items.find((i) => i.name === 'Format Tools')!;
    expect(item.note).toMatch(/1 hook converted; they wait for your trust/);
    expect(item.note).toMatch(/Notification/);
    await svc.apply(ACCOUNT, { previewId: preview.previewId, items: [item.id] });
    const installed = await plugins.list(ACCOUNT);
    expect(installed[0]).toMatchObject({
      name: 'Format Tools',
      enabled: false,
      components: { hooks: 1 },
    });
    const loaded = loadPluginFolder(join(dataDir, 'plugins', installed[0]!.id, '1.2.0'));
    expect(loaded.hooks[0]?.hook).toMatchObject({
      id: 'tool-post-1',
      event: 'tool.post',
      matcher: 'fs.write',
      handler: { type: 'command', command: ['${pluginRoot}/scripts/fmt.sh'] },
    });
    await hooks.refresh(ACCOUNT);
    const row = hooks.store.list(ACCOUNT).find((r) => r.source === 'plugin');
    expect(row).toMatchObject({ trustState: 'needs_trust', key: 'tool-post-1' });
    hooks.close();
  });

  it('does not follow a hooks file that is a link', async () => {
    put('linked/.acme-plugin/plugin.json', JSON.stringify({ name: 'Linked' }));
    put(
      'outside.json',
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }),
    );
    mkdirSync(join(root, 'linked', 'hooks'), { recursive: true });
    symlinkSync(join(root, 'outside.json'), join(root, 'linked', 'hooks', 'hooks.json'));
    const svc = new ImportService({
      db: env.db,
      secrets: env.secrets,
      events: env.events,
      dataDir: join(env.dir, 'data'),
      memory: env.memory,
      projects: env.projects,
      targets: {
        skills: new SkillIndex({
          db: env.db,
          userDir: join(env.dir, 'data', 'skills'),
          builtinDir: null,
        }),
        plugins: { installDisabled: () => Promise.reject(new Error('no')) },
        folders: { add: () => Promise.resolve() },
      },
      home: join(env.dir, 'home'),
    });
    const preview = await svc.preview(ACCOUNT, {
      paths: [join(root, 'linked')],
      kinds: ['plugins'],
    });
    const item = preview.items.find((i) => i.name === 'Linked');
    expect(item?.note ?? '').not.toMatch(/converted/);
    rmSync(join(root, 'outside.json'));
  });
});
