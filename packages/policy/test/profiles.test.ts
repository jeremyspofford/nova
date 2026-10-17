import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PROFILES,
  checkProfile,
  expandProfile,
  flattenProfile,
  isolatedSubstrate,
  profileHash,
  stableHash,
  type PermissionProfile,
} from '../src/profiles.ts';
import { effectiveEffects, inferEffects, isReadOnly, words, writesPath } from '../src/classify.ts';
import type { ToolDescriptor } from '../src/types.ts';

const byId = (id: string) => BUILTIN_PROFILES.find((p) => p.id === id);
const roots = [
  { path: '/data/nova/workspace', access: 'write' as const, label: 'Workspace' },
  { path: '/work/docs', access: 'read' as const, label: 'docs' },
];

describe('permission profiles (FR-190, docs/12 §7.1)', () => {
  it('ships read-only, workspace and full; full requires a VM or container', () => {
    expect(BUILTIN_PROFILES.map((p) => p.id)).toEqual(['read-only', 'workspace', 'full']);
    expect(byId('full')!.requiresSubstrate).toBe('vm_or_container');
    for (const p of BUILTIN_PROFILES) expect(checkProfile(p)).toBeNull();
    expect(isolatedSubstrate('container')).toBe(true);
    expect(isolatedSubstrate('micro_vm')).toBe(true);
    expect(isolatedSubstrate('os_sandbox')).toBe(false);
    expect(isolatedSubstrate(null)).toBe(false);
  });

  it('expands tokens against the project roots, capped by each root', () => {
    expect(expandProfile(byId('workspace')!, { projectRoots: roots })).toEqual([
      { path: '/data/nova/workspace', access: 'write', label: 'Workspace' },
      { path: '/work/docs', access: 'read', label: 'docs' },
    ]);
    expect(expandProfile(byId('read-only')!, { projectRoots: roots }).map((e) => e.access)).toEqual(
      ['read', 'read'],
    );
    expect(expandProfile(byId('full')!, { projectRoots: [] })).toEqual([
      { path: '/', access: 'write', label: 'Whole filesystem' },
    ]);
    const custom: PermissionProfile = {
      id: 'c',
      name: 'custom',
      filesystem: [
        { path: ':project/build', access: 'deny' },
        { path: ':tmp', access: 'write' },
        { path: ':home/notes', access: 'read' },
        { path: '~/inbox', access: 'write' },
        { path: '~', access: 'read' },
        { path: '/opt/data', access: 'read' },
        { path: ':minimal', access: 'read' },
      ],
      network: { mode: 'off' },
    };
    expect(
      expandProfile(custom, { projectRoots: roots.slice(0, 1), tmp: '/tmp/s1', home: '/home/u' }),
    ).toEqual([
      { path: '/data/nova/workspace/build', access: 'deny', label: 'Workspace/build' },
      { path: '/tmp/s1', access: 'write', label: 'Temporary files' },
      { path: '/home/u/notes', access: 'read', label: 'Home' },
      { path: '/home/u/inbox', access: 'write', label: '~/inbox' },
      { path: '/home/u', access: 'read', label: '~' },
      { path: '/opt/data', access: 'read', label: '/opt/data' },
    ]);
    expect(expandProfile(custom, { projectRoots: [] }).map((e) => e.path)).toEqual(['/opt/data']);
  });

  it('flattens extends chains and inherits the substrate requirement', () => {
    const child: PermissionProfile = {
      id: 'net',
      name: 'workspace-net',
      extends: 'workspace',
      filesystem: [{ path: ':home', access: 'deny' }],
      network: { mode: 'allowlist', allow: ['registry.npmjs.org'] },
    };
    const lookup = (id: string) => (id === 'net' ? child : byId(id));
    const flat = flattenProfile(child, lookup);
    expect(flat.filesystem.map((e) => e.path)).toEqual([':project', ':tmp', ':minimal', ':home']);
    expect(flat.network.allow).toEqual(['registry.npmjs.org']);
    expect(flat.extends).toBeUndefined();
    const onFull = flattenProfile({ ...child, extends: 'full' }, lookup);
    expect(onFull.requiresSubstrate).toBe('vm_or_container');
    expect(() => flattenProfile({ ...child, extends: 'missing' }, lookup)).toThrow(/unknown/);
    const loop: PermissionProfile = { ...child, id: 'a', extends: 'b' };
    const loop2: PermissionProfile = { ...child, id: 'b', extends: 'a' };
    expect(() => flattenProfile(loop, (id) => (id === 'a' ? loop : loop2))).toThrow(/itself/);
  });

  it('validates names, paths and the network allowlist', () => {
    const base: PermissionProfile = {
      id: 'x',
      name: 'ok-name',
      filesystem: [],
      network: { mode: 'off' },
    };
    expect(checkProfile({ ...base, name: 'Bad Name' })).toMatch(/names/);
    expect(checkProfile({ ...base, filesystem: [{ path: 'relative', access: 'read' }] })).toMatch(
      /absolute/,
    );
    expect(checkProfile({ ...base, filesystem: [{ path: '/a/../b', access: 'read' }] })).toMatch(
      /\.\./,
    );
    expect(checkProfile({ ...base, network: { mode: 'allowlist', allow: ['*'] } })).toMatch(/\*/);
    expect(checkProfile({ ...base, filesystem: [{ path: 'C:\\x', access: 'read' }] })).toBeNull();
  });

  it('hashes canonically', () => {
    expect(stableHash({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe(
      stableHash({ a: [1, { d: 2 }], b: 1 }),
    );
    expect(profileHash(byId('workspace')!)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(profileHash(byId('workspace')!)).not.toBe(profileHash(byId('read-only')!));
  });
});

describe('effect classes (FR-189)', () => {
  const mcp = (name: string, description = ''): ToolDescriptor => ({
    name,
    source: 'mcp',
    description,
  });

  it('infers classes from an untrusted tool name and description, only adding', () => {
    expect(inferEffects(mcp('mcp:shop.purchase_item'))).toEqual(['purchase']);
    expect(inferEffects(mcp('mcp:mail.sendEmail'))).toEqual(['external_communication']);
    expect(inferEffects(mcp('mcp:x.do', 'Deletes the record.'))).toEqual(['data_delete']);
    expect(inferEffects(mcp('mcp:x.do', 'Installs a package'))).toEqual(['install']);
    expect(inferEffects(mcp('mcp:x.getAPIKey'))).toEqual(['credential_change']);
    expect(inferEffects(mcp('mcp:x.reset_password'))).toEqual(['credential_change']);
    expect(inferEffects(mcp('mcp:x.do', 'Create a new account for the user'))).toEqual([
      'account_change',
    ]);
    expect(inferEffects(mcp('mcp:x.do', 'Grant read access to a teammate'))).toEqual([
      'account_change',
    ]);
    expect(inferEffects(mcp('mcp:x.do', 'Invite a member'))).toEqual(['account_change']);
    expect(inferEffects(mcp('plugin:com.pay.checkout'))).toEqual(['purchase']);
    expect(inferEffects({ name: 'page:shop.example.com.buyNow', source: 'page' })).toEqual([
      'purchase',
    ]);
    expect(inferEffects({ name: 'mcp:x.y', source: 'mcp', title: 'Publish post' })).toEqual([
      'external_communication',
    ]);
  });

  it('ignores benign noun phrases and trusted sources', () => {
    expect(inferEffects(mcp('mcp:git.log', 'Show commit messages in descending order'))).toEqual(
      [],
    );
    expect(
      inferEffects(mcp('mcp:x.list', 'Use the next page token; returns an error message')),
    ).toEqual([]);
    expect(inferEffects(mcp('mcp:x.count_tokens'))).toEqual([]);
    expect(inferEffects({ name: 'email.send', source: 'builtin' })).toEqual([]);
  });

  it('splits words from camelCase and punctuation', () => {
    expect(words('purchaseItem_now-ABCDef')).toBe('purchase item now abc def');
  });

  it('maps the action class and combines with declared effects', () => {
    expect(
      effectiveEffects({ name: 'a.b', source: 'builtin', annotations: { action: 'send' } }),
    ).toEqual(['external_communication']);
    expect(
      effectiveEffects({ name: 'a.b', source: 'builtin', annotations: { action: 'delete' } }),
    ).toEqual(['data_delete']);
    expect(
      effectiveEffects({ name: 'a.b', source: 'builtin', annotations: { action: 'execute' } }),
    ).toEqual(['exec']);
    expect(
      effectiveEffects({ name: 'a.b', source: 'builtin', annotations: { action: 'write' } }),
    ).toEqual([]);
    expect(
      effectiveEffects({
        name: 'mcp:s.delete_file',
        source: 'mcp',
        effects: ['file_write'],
        annotations: { action: 'read' },
      }),
    ).toEqual(['file_write', 'data_delete']);
  });

  it('treats only trusted read-only tools without side effects as read-only', () => {
    const fetchTool: ToolDescriptor = {
      name: 'web.fetch',
      source: 'builtin',
      annotations: { readOnly: true },
    };
    expect(isReadOnly(fetchTool, ['network'])).toBe(true);
    expect(isReadOnly(fetchTool, ['file_write'])).toBe(false);
    expect(isReadOnly({ ...fetchTool, annotations: { readOnly: true, action: 'send' } }, [])).toBe(
      false,
    );
    expect(isReadOnly({ ...fetchTool, source: 'mcp' }, [])).toBe(false);
    expect(isReadOnly({ name: 'x.y', source: 'builtin' }, [])).toBe(false);
  });

  it('decides whether a call writes its path', () => {
    const t = (annotations: ToolDescriptor['annotations']): ToolDescriptor => ({
      name: 'a.b',
      source: 'builtin',
      annotations,
    });
    expect(writesPath(t({ destructive: true }), [])).toBe(true);
    expect(writesPath(t({ destructive: true }), ['exec'])).toBe(false);
    expect(writesPath(t({ action: 'write' }), [])).toBe(true);
    expect(writesPath(t({}), ['data_delete'])).toBe(true);
    expect(writesPath(t({ readOnly: true }), [])).toBe(false);
  });
});
