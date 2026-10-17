// File tools (docs/08 §1.1, FR-190): reading, listing, searching, writing, editing and deleting
// inside the roots; refusals outside them, through symlinks, into read-only roots, protected
// and credential paths and the Nova data folder; size caps.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Logger } from '@nova/telemetry';
import {
  MAX_READ_CHARS,
  MAX_WRITE_BYTES,
  PathDenied,
  UnavailableSandbox,
  fsTools,
  globToRegExp,
  resolveInRoots,
  type BuiltinContext,
  type ToolResult,
  type ToolRoot,
} from '../src/index.ts';

let dir: string;
let work: string;
let ro: string;
let roots: ToolRoot[];
const tools = () =>
  fsTools({ paths: { denied: [join(dir, 'data')], allowed: [join(dir, 'data', 'workspace')] } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-fs-'));
  work = join(dir, 'data', 'workspace');
  ro = join(dir, 'ro');
  mkdirSync(work, { recursive: true });
  mkdirSync(ro);
  roots = [
    { path: work, access: 'write', label: 'Workspace' },
    { path: ro, access: 'read', label: 'ro' },
  ];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(extra: Partial<BuiltinContext> = {}): BuiltinContext {
  return {
    accountId: 'a',
    threadId: 't',
    turnId: 'u',
    callId: 'c',
    projectId: null,
    origin: 'model',
    profile: { id: 'workspace', hash: 'h' },
    roots,
    sandbox: new UnavailableSandbox(),
    signal: new AbortController().signal,
    log: new Logger({ module: 'test', sinks: [] }),
    ...extra,
  };
}

async function run(name: string, args: unknown, c = ctx()): Promise<ToolResult> {
  const t = tools().find((x) => x.descriptor.name === name)!;
  return t.handler(args, c);
}
const text = (r: ToolResult) =>
  r.ok ? r.content.map((p) => (p.type === 'text' ? p.text : '')).join('') : '';
const code = (r: ToolResult) => (r.ok ? null : r.error.code);

describe('fs.read', () => {
  it('reads a file relative to the workspace, or a line range', async () => {
    writeFileSync(join(work, 'a.txt'), 'one\ntwo\nthree\n');
    expect(text(await run('fs.read', { path: 'a.txt' }))).toBe('one\ntwo\nthree\n');
    const part = await run('fs.read', { path: 'a.txt', startLine: 2, endLine: 3 });
    expect(text(part)).toBe('[a.txt: lines 2-3 of 4]\ntwo\nthree');
    const r = await run('fs.read', { path: join(work, 'a.txt') });
    expect(r.ok && r.meta).toMatchObject({ path: 'a.txt', size: 14, truncated: false });
  });

  it('reads from a read-only root by absolute path', async () => {
    writeFileSync(join(ro, 'r.txt'), 'readable');
    expect(text(await run('fs.read', { path: join(ro, 'r.txt') }))).toBe('readable');
  });

  it('refuses paths outside the roots, through .. or a symlink', async () => {
    writeFileSync(join(dir, 'secret.txt'), 'nope');
    expect(code(await run('fs.read', { path: '../../secret.txt' }))).toBe('path_denied');
    expect(code(await run('fs.read', { path: join(dir, 'secret.txt') }))).toBe('path_denied');
    symlinkSync(join(dir, 'secret.txt'), join(work, 'link.txt'));
    const r = await run('fs.read', { path: 'link.txt' });
    expect(code(r)).toBe('path_denied');
    expect(r.ok ? '' : r.error.message).toContain('outside the allowed folders');
  });

  it('refuses the Nova data folder and credential files even inside a root', async () => {
    roots = [{ path: dir, access: 'write', label: 'all' }];
    writeFileSync(join(dir, 'data', 'nova.db'), 'db');
    expect(code(await run('fs.read', { path: 'data/nova.db' }))).toBe('path_denied');
    writeFileSync(join(work, 'ok.txt'), 'fine');
    expect(text(await run('fs.read', { path: 'data/workspace/ok.txt' }))).toBe('fine');
    mkdirSync(join(dir, '.ssh'));
    writeFileSync(join(dir, '.ssh', 'id_ed25519'), 'key');
    expect(code(await run('fs.read', { path: '.ssh/id_ed25519' }))).toBe('path_denied');
    mkdirSync(join(dir, '.config', 'gh'), { recursive: true });
    expect(code(await run('fs.read', { path: '.config/gh/hosts.yml' }))).toBe('path_denied');
  });

  it('refuses binary files and folders, and caps long files', async () => {
    writeFileSync(join(work, 'b.bin'), Buffer.from([0, 1, 2]));
    expect(code(await run('fs.read', { path: 'b.bin' }))).toBe('binary');
    expect(code(await run('fs.read', { path: '.' }))).toBe('is_directory');
    expect(code(await run('fs.read', { path: 'missing.txt' }))).toBe('not_found');
    writeFileSync(join(work, 'big.txt'), 'x'.repeat(MAX_READ_CHARS + 10));
    const r = await run('fs.read', { path: 'big.txt' });
    expect(text(r)).toContain('truncated; read later parts with startLine');
    expect(r.ok && r.meta?.truncated).toBe(true);
  });

  it('honours profile deny entries passed by the runtime', async () => {
    mkdirSync(join(work, 'private'));
    writeFileSync(join(work, 'private', 'p.txt'), 'hidden');
    const c = ctx({
      extras: {
        messageId: null,
        network: 'off',
        deny: [join(work, 'private')],
        cite: () => [],
        searchTools: () => [],
      },
    });
    expect(code(await run('fs.read', { path: 'private/p.txt' }, c))).toBe('path_denied');
  });
});

describe('fs.list and fs.search', () => {
  beforeEach(() => {
    mkdirSync(join(work, 'src', 'lib'), { recursive: true });
    writeFileSync(join(work, 'src', 'a.ts'), 'export const a = 1;\n// TODO later\n');
    writeFileSync(join(work, 'src', 'lib', 'b.ts'), 'export const b = 2;\n');
    writeFileSync(join(work, 'README.md'), '# Readme\ntodo: write docs\n');
    mkdirSync(join(work, '.ssh'));
    writeFileSync(join(work, '.ssh', 'key'), 'TODO secret');
    mkdirSync(join(work, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(work, 'node_modules', 'x', 'i.js'), 'TODO vendored');
  });

  it('lists folders first, to the requested depth, hiding credential folders', async () => {
    const r = await run('fs.list', {});
    expect(text(r)).toBe('./\nnode_modules/\nsrc/\nREADME.md (26 bytes)');
    const deep = text(await run('fs.list', { path: 'src', depth: 2 }));
    expect(deep).toBe('src/\nlib/\n  b.ts (20 bytes)\na.ts (34 bytes)');
    expect(code(await run('fs.list', { path: 'README.md' }))).toBe('not_a_folder');
  });

  it('searches text case-insensitively across roots, skipping vendored and credential files', async () => {
    writeFileSync(join(ro, 'notes.txt'), 'TODO in the other root\n');
    const r = await run('fs.search', { query: 'todo' });
    expect(text(r).split('\n')).toEqual([
      'README.md:2: todo: write docs',
      'src/a.ts:2: // TODO later',
      `${join(ro, 'notes.txt')}:1: TODO in the other root`,
    ]);
    const exact = await run('fs.search', { query: 'TODO', caseSensitive: true, path: 'src' });
    expect(text(exact)).toBe('src/a.ts:2: // TODO later');
    expect(text(await run('fs.search', { query: 'zzz' }))).toBe('No matches.');
  });

  it('supports regular expressions, globs and a result cap; refuses runaway patterns', async () => {
    const re = await run('fs.search', { query: 'export const [ab]', regex: true, glob: '**/*.ts' });
    expect(text(re).split('\n')).toEqual([
      'src/a.ts:1: export const a = 1;',
      'src/lib/b.ts:1: export const b = 2;',
    ]);
    const capped = await run('fs.search', { query: 'export', maxResults: 1 });
    expect(text(capped)).toContain('[showing the first 1 matches]');
    expect(code(await run('fs.search', { query: '(a+)+$', regex: true }))).toBe('invalid_regex');
    expect(code(await run('fs.search', { query: '(a|aa)*', regex: true }))).toBe('invalid_regex');
    expect(code(await run('fs.search', { query: '([a-z]', regex: true }))).toBe('invalid_regex');
  });

  it('turns globs into anchored expressions', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false);
    expect(globToRegExp('src/**/*.ts').test('src/x/y/a.ts')).toBe(true);
    expect(globToRegExp('a?.md').test('ab.md')).toBe(true);
  });
});

describe('fs.write, fs.edit and fs.delete', () => {
  it('creates and replaces files, creating parent folders', async () => {
    const r = await run('fs.write', { path: 'docs/plan.md', content: '# Plan' });
    expect(text(r)).toBe('Created docs/plan.md (6 bytes).');
    expect(r.ok && r.meta).toMatchObject({ created: true, sha256Before: null });
    const again = await run('fs.write', { path: 'docs/plan.md', content: '# Plan 2' });
    expect(text(again)).toBe('Replaced docs/plan.md (8 bytes).');
    expect(readFileSync(join(work, 'docs', 'plan.md'), 'utf8')).toBe('# Plan 2');
  });

  it('refuses read-only roots, protected paths, folders and oversize content', async () => {
    expect(code(await run('fs.write', { path: join(ro, 'x.txt'), content: 'x' }))).toBe(
      'path_denied',
    );
    expect(code(await run('fs.write', { path: '.git/config', content: 'x' }))).toBe('path_denied');
    expect(code(await run('fs.write', { path: '.bashrc', content: 'x' }))).toBe('path_denied');
    expect(code(await run('fs.write', { path: '.nova/rules.json', content: 'x' }))).toBe(
      'path_denied',
    );
    mkdirSync(join(work, 'folder'));
    expect(code(await run('fs.write', { path: 'folder', content: 'x' }))).toBe('is_directory');
    expect(code(await run('fs.write', { path: '.', content: 'x' }))).toBe('invalid_path');
    expect(
      code(await run('fs.write', { path: 'big', content: 'x'.repeat(MAX_WRITE_BYTES + 1) })),
    ).toBe('too_large');
  });

  it('protects the policy package locations, case-insensitively (docs/12 §7.2)', async () => {
    expect(code(await run('fs.write', { path: '.GIT/config', content: 'x' }))).toBe('path_denied');
    expect(code(await run('fs.write', { path: '.config/fish/config.fish', content: 'x' }))).toBe(
      'path_denied',
    );
    expect(code(await run('fs.read', { path: '.mozilla/profile/key4.db' }))).toBe('path_denied');
    expect(code(await run('fs.read', { path: '.cargo/credentials.toml' }))).toBe('path_denied');
    expect(text(await run('fs.write', { path: '.cargo/config.toml', content: 'x' }))).toContain(
      'Created',
    );
  });

  it('edits with a patch and returns its errors with details', async () => {
    writeFileSync(join(work, 'a.txt'), 'one\ntwo\n');
    const r = await run('fs.edit', {
      patch: '%%% patch\n%%% update a.txt\n@@\n one\n-two\n+2\n%%% add b.txt\n+bee\n%%% end',
    });
    expect(text(r)).toBe('Applied the patch: updated a.txt (+1 -1); added b.txt (+1 -0).');
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('one\n2\n');
    const bad = await run('fs.edit', { patch: '%%% patch\n%%% update a.txt\n@@\n-zzz\n%%% end' });
    expect(bad).toMatchObject({
      ok: false,
      error: { code: 'patch.context_not_found', details: { path: 'a.txt', hunk: 0 } },
    });
    const denied = await run('fs.edit', {
      patch: `%%% patch\n%%% add ${join(ro, 'n.txt')}\n+x\n%%% end`,
    });
    expect(code(denied)).toBe('patch.path_denied');
    expect(existsSync(join(ro, 'n.txt'))).toBe(false);
  });

  it('deletes files, and folders only when recursive and free of protected paths', async () => {
    writeFileSync(join(work, 'f.txt'), 'x');
    expect(text(await run('fs.delete', { path: 'f.txt' }))).toBe('Deleted f.txt.');
    expect(existsSync(join(work, 'f.txt'))).toBe(false);
    mkdirSync(join(work, 'd', 'e'), { recursive: true });
    expect(code(await run('fs.delete', { path: 'd' }))).toBe('is_directory');
    expect(text(await run('fs.delete', { path: 'd', recursive: true }))).toBe('Deleted d.');
    mkdirSync(join(work, 'repo', '.git'), { recursive: true });
    expect(code(await run('fs.delete', { path: 'repo', recursive: true }))).toBe('path_denied');
    expect(code(await run('fs.delete', { path: '.' }))).toBe('invalid_path');
    expect(code(await run('fs.delete', { path: 'gone' }))).toBe('not_found');
    writeFileSync(join(ro, 'keep.txt'), 'x');
    expect(code(await run('fs.delete', { path: join(ro, 'keep.txt') }))).toBe('path_denied');
  });

  it('gives the gate the resolved path as the resource', () => {
    const t = tools().find((x) => x.descriptor.name === 'fs.write')!;
    expect(t.resource!({ path: 'x.md' }, ctx())).toEqual({
      kind: 'path',
      value: join(work, 'x.md'),
    });
    expect(t.resource!({ path: '../../../etc/passwd' }, ctx())).toEqual({
      kind: 'path',
      value: '../../../etc/passwd',
    });
    const edit = tools().find((x) => x.descriptor.name === 'fs.edit')!;
    expect(edit.resource!({ patch: '%%% patch\n%%% add n.md\n+x\n%%% end' }, ctx())).toEqual({
      kind: 'path',
      value: join(work, 'n.md'),
    });
    expect(edit.resource!({ patch: 'nonsense' }, ctx())).toBeUndefined();
  });

  it('declares annotations and effects for every tool', () => {
    const byName = new Map(tools().map((t) => [t.descriptor.name, t.descriptor]));
    expect(byName.get('fs.read')).toMatchObject({
      annotations: { readOnly: true },
      effects: [],
      loading: 'always',
    });
    expect(byName.get('fs.write')).toMatchObject({
      annotations: { destructive: true },
      effects: ['file_write'],
    });
    expect(byName.get('fs.delete')).toMatchObject({ effects: ['data_delete'] });
  });
});

describe('resolveInRoots', () => {
  it('needs a root and picks the most specific one', () => {
    expect(() => resolveInRoots([], 'x', 'read')).toThrow(PathDenied);
    const inner = join(work, 'inner');
    mkdirSync(inner);
    const r = resolveInRoots(
      [...roots, { path: inner, access: 'read', label: 'inner' }],
      join(inner, 'f'),
      'read',
    );
    expect(r.root.label).toBe('inner');
    expect(r.rel).toBe('f');
    expect(() =>
      resolveInRoots(
        [...roots, { path: inner, access: 'read', label: 'inner' }],
        join(inner, 'f'),
        'write',
      ),
    ).toThrow('read-only');
  });
});
