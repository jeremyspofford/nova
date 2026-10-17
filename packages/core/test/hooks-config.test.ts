// Hooks files, matchers, effects per event and the content hash (FR-197; hook-config.json).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contracts } from '@nova/contracts';
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  commandPlacement,
  expandArgv,
  failsClosed,
  handlerTimeout,
  hookArgvCommand,
  hookContentHash,
  hookMatches,
  parseHookResult,
  parseHooksFile,
  referencedFiles,
  type HookDefinition,
  type HookRow,
} from '../src/index.ts';

const cmd = (over: Partial<HookDefinition> = {}): HookDefinition => ({
  id: 'guard',
  event: 'tool.pre',
  handler: { type: 'command', command: ['node', 'hooks/guard.mjs'] },
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hooks-config-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseHooksFile', () => {
  it('reads a hooks file and agrees with the contract', () => {
    const file = {
      schemaVersion: 1,
      hooks: [
        cmd(),
        {
          id: 'no-prod-writes',
          event: 'tool.pre',
          matcher: ['exec.run', 'mcp:db.*'],
          handler: { type: 'mcp_tool', tool: 'mcp:guard.check' },
          failClosed: true,
        },
      ],
    };
    expect(contracts().validate('hook-config.json', file).ok).toBe(true);
    const parsed = parseHooksFile(file);
    expect(parsed.errors).toEqual([]);
    expect(parsed.hooks.map((h) => h.id)).toEqual(['guard', 'no-prod-writes']);
  });

  it('accepts a bare array (a plugin manifest inline list)', () => {
    expect(parseHooksFile([cmd()]).hooks).toHaveLength(1);
  });

  it('keeps valid hooks and reports invalid and repeated ones', () => {
    const parsed = parseHooksFile({
      hooks: [
        cmd(),
        { id: 'Bad Id', event: 'tool.pre', handler: { type: 'command', command: ['x'] } },
        { id: 'late', event: 'tool.pre', handler: { type: 'mcp_tool', tool: 'not-mcp' } },
        cmd({ event: 'tool.post' }),
        {
          id: 'timeouts',
          event: 'stop',
          handler: { type: 'command', command: ['x'], timeoutMs: 5 },
        },
      ],
    });
    expect(parsed.hooks.map((h) => h.id)).toEqual(['guard']);
    expect(parsed.errors).toHaveLength(4);
    expect(parsed.errors.join('\n')).toMatch(/Bad Id/);
    expect(parsed.errors.join('\n')).toMatch(/used twice/);
  });

  it('rejects files that are not hooks files', () => {
    expect(parseHooksFile('nope').errors[0]).toMatch(/object with a "hooks" array/);
    expect(parseHooksFile({ hooks: [], schemaVersion: 2 }).errors[0]).toMatch(/schemaVersion/);
    expect(parseHooksFile({ hooks: [], extra: 1 }).errors[0]).toMatch(/unknown top-level/);
  });
});

describe('results', () => {
  it('validates handler results against the contract', () => {
    expect(parseHookResult({ block: { reason: 'no' } })).toEqual({ block: { reason: 'no' } });
    expect(parseHookResult({ decision: 'allow', context: 'x' })).toEqual({
      decision: 'allow',
      context: 'x',
    });
    expect(parseHookResult({ decision: 'maybe' })).toHaveProperty('error');
    expect(parseHookResult({ rewrite: { args: {} } })).toHaveProperty('error');
  });
});

describe('matching and effects', () => {
  it('matches tool globs and treats no matcher as every occurrence', () => {
    const h = cmd({ matcher: ['exec.run', 'mcp:db.*'] });
    expect(hookMatches(h, 'exec.run')).toBe(true);
    expect(hookMatches(h, 'mcp:db.query')).toBe(true);
    expect(hookMatches(h, 'mcp:dbx.query')).toBe(false);
    expect(hookMatches(h, 'fs.write')).toBe(false);
    expect(hookMatches(h, undefined)).toBe(false);
    expect(hookMatches(cmd(), 'anything')).toBe(true);
    expect(hookMatches(cmd({ matcher: 'compacted', event: 'session.start' }), 'new')).toBe(false);
    // Events without a subject ignore matchers.
    expect(hookMatches(cmd({ event: 'stop', matcher: 'x' }), undefined)).toBe(true);
  });

  it('fails closed for tool.pre and permission.request, else only with failClosed', () => {
    expect(failsClosed(cmd())).toBe(true);
    expect(failsClosed(cmd({ event: 'permission.request' }))).toBe(true);
    expect(failsClosed(cmd({ event: 'tool.post', failClosed: true }))).toBe(false);
    expect(failsClosed(cmd({ event: 'prompt.submit' }))).toBe(false);
    expect(failsClosed(cmd({ event: 'prompt.submit', failClosed: true }))).toBe(true);
  });

  it('clamps timeouts to the contract range', () => {
    expect(handlerTimeout({ type: 'command', command: ['x'] })).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(handlerTimeout({ type: 'command', command: ['x'], timeoutMs: 10 })).toBe(1_000);
    expect(handlerTimeout({ type: 'mcp_tool', tool: 'mcp:a.b', timeoutMs: 9e9 })).toBe(600_000);
  });
});

describe('content hash', () => {
  it('is stable, ignores `enabled` and changes with the definition', () => {
    const a = hookContentHash(cmd(), null);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hookContentHash(cmd({ enabled: false }), null)).toBe(a);
    expect(hookContentHash(cmd({ matcher: 'fs.*' }), null)).not.toBe(a);
    expect(hookContentHash(cmd({ failClosed: true }), null)).not.toBe(a);
  });

  it('covers the bytes of the script it runs inside its folder', () => {
    mkdirSync(join(dir, 'hooks'));
    writeFileSync(join(dir, 'hooks', 'guard.mjs'), 'console.log("{}")');
    const before = hookContentHash(cmd(), dir);
    expect(referencedFiles(cmd(), dir).map((f) => f.path)).toEqual([join('hooks', 'guard.mjs')]);
    writeFileSync(join(dir, 'hooks', 'guard.mjs'), 'console.log("{ }")');
    expect(hookContentHash(cmd(), dir)).not.toBe(before);
  });

  it('follows a symlink inside the folder but ignores files outside it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'nova-hooks-outside-'));
    try {
      writeFileSync(join(outside, 'x.sh'), 'one');
      symlinkSync(join(outside, 'x.sh'), join(dir, 'link.sh'));
      const viaLink = cmd({ handler: { type: 'command', command: ['sh', 'link.sh'] } });
      const h1 = hookContentHash(viaLink, dir);
      writeFileSync(join(outside, 'x.sh'), 'two');
      expect(hookContentHash(viaLink, dir)).not.toBe(h1);
      const direct = cmd({ handler: { type: 'command', command: ['sh', join(outside, 'x.sh')] } });
      expect(referencedFiles(direct, dir)).toEqual([]);
      expect(
        referencedFiles(cmd({ handler: { type: 'command', command: ['sh', '../x'] } }), dir),
      ).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('hashes a plugin the same before and after it is copied', () => {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    for (const d of [a, b]) {
      mkdirSync(d);
      writeFileSync(join(d, 'check.sh'), 'echo {}');
    }
    const h = cmd({ handler: { type: 'command', command: ['sh', '${pluginRoot}/check.sh'] } });
    const ha = hookContentHash(h, a, { pluginRoot: a });
    expect(hookContentHash(h, b, { pluginRoot: b })).toBe(ha);
    expect(referencedFiles(h, a, { pluginRoot: a })).toHaveLength(1);
    expect(expandArgv(['${pluginRoot}/x', '${other}'], { pluginRoot: '/p' })).toEqual([
      '/p/x',
      '${other}',
    ]);
  });
});

describe('command placement', () => {
  const row = (over: Partial<HookRow> = {}): HookRow => ({
    id: 'r1',
    accountId: 'a',
    key: 'guard',
    event: 'tool.pre',
    source: 'project',
    pluginId: null,
    projectId: 'p',
    definition: cmd({ handler: { type: 'command', command: ['x'], network: ['api.example.com'] } }),
    baseDir: '/srv/proj',
    limits: null,
    contentHash: 'sha256:x',
    trustedHash: null,
    trustState: 'trusted',
    trustedBy: null,
    trustedAt: null,
    timeoutMs: 30_000,
    enabled: true,
    lastRunAt: null,
    lastEffect: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  });
  const scope = {
    roots: [{ path: '/srv', access: 'write' as const, label: 'srv' }],
    profile: { id: 'workspace', hash: 'h' },
    network: 'limited' as const,
  };

  it('runs in its folder with the session roots and its declared hosts', () => {
    const p = commandPlacement(row(), scope);
    expect(p.cwd).toBe('/srv/proj');
    expect(p.roots).toEqual(scope.roots);
    expect(p.network).toBe('allowlist');
    expect(p.hosts).toEqual(['api.example.com']);
    // No session network, or no scope at all: network off.
    expect(commandPlacement(row(), { ...scope, network: 'off' }).network).toBe('off');
    expect(commandPlacement(row(), null)).toMatchObject({ network: 'off', cwd: '/srv/proj' });
  });

  it('keeps plugin hooks inside the plugin folder and its network', () => {
    const p = commandPlacement(
      row({
        source: 'plugin',
        baseDir: '/plugins/x',
        limits: { network: ['*.other.com'], fsProject: false, answersAsks: false },
      }),
      scope,
    );
    expect(p.roots).toEqual([{ path: '/plugins/x', access: 'read', label: 'Hook folder' }]);
    expect(p.hosts).toEqual([]);
    expect(p.network).toBe('off');
    const q = commandPlacement(
      row({
        source: 'plugin',
        baseDir: '/plugins/x',
        limits: { network: ['api.example.com'], fsProject: true, answersAsks: false },
      }),
      scope,
    );
    expect(q.roots.map((r) => r.path)).toEqual(['/plugins/x', '/srv']);
    expect(q.network).toBe('allowlist');
  });

  it('falls back to the first root, then /tmp, for hooks without a folder', () => {
    expect(commandPlacement(row({ source: 'user', baseDir: null }), scope).cwd).toBe('/srv');
    expect(commandPlacement(row({ source: 'user', baseDir: null }), null).cwd).toBe('/tmp');
  });
});

describe('argv command', () => {
  it('quotes every element so the shell never interprets it', () => {
    const c = hookArgvCommand(['printf', '%s|', "it's", '$(id)', '`x`', 'a b']);
    expect(execFileSync('sh', ['-c', c]).toString()).toBe("it's|$(id)|`x`|a b|");
  });
});
