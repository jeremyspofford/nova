// Permission profiles and a turn's roots (FR-190, docs/12 §7.1-§7.2).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_PROFILES } from '@nova/policy';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { PolicyStore, loadPermissionProfile, resolveToolRoots } from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
let db: NovaDatabase;
let store: PolicyStore;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-profiles-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  store = new PolicyStore({ db });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const byId = (id: string) => BUILTIN_PROFILES.find((p) => p.id === id)!;

describe('resolveToolRoots', () => {
  it('puts the workspace first and caps each folder by its own access', () => {
    const ws = join(dir, 'data', 'workspace');
    const docs = join(dir, 'docs');
    const r = resolveToolRoots({
      profile: byId('workspace'),
      roots: [
        { path: docs, access: 'read', label: 'Docs' },
        { path: '~/inbox', access: 'write' },
      ],
      workspaceDir: ws,
      home: join(dir, 'home'),
    });
    expect(r.roots).toEqual([
      { path: ws, access: 'write', label: 'Workspace' },
      { path: docs, access: 'read', label: 'Docs' },
      { path: join(dir, 'home', 'inbox'), access: 'write', label: 'inbox' },
    ]);
    expect(r.profile.id).toBe('workspace');
    expect(r.profile.hash).toMatch(/^sha256:/);
    expect(r.network).toEqual({ mode: 'off' });
    expect(r.requiresSubstrate).toBeNull();
    const ro = resolveToolRoots({
      profile: byId('read-only'),
      roots: [],
      workspaceDir: ws,
      home: null,
    });
    expect(ro.roots).toEqual([{ path: ws, access: 'read', label: 'Workspace' }]);
    expect(ro.profile.hash).not.toBe(r.profile.hash);
  });

  it('canonicalizes symlinked roots, merges duplicates and lists denied paths', () => {
    const real = join(dir, 'real');
    mkdirSync(real);
    symlinkSync(real, join(dir, 'link'));
    const r = resolveToolRoots({
      profile: {
        id: 'c',
        name: 'c',
        filesystem: [
          { path: ':project', access: 'read' },
          { path: join(dir, 'link'), access: 'write' },
          { path: join(dir, 'real', 'secret'), access: 'deny' },
        ],
        network: { mode: 'off' },
      },
      roots: [{ path: join(dir, 'real'), access: 'read' }],
      workspaceDir: join(dir, 'ws'),
    });
    expect(r.roots.find((x) => x.path === real)).toMatchObject({ access: 'write' });
    expect(r.deny).toEqual([join(real, 'secret')]);
  });

  it('keeps the full profile`s substrate requirement', () => {
    const r = resolveToolRoots({
      profile: byId('full'),
      roots: [],
      workspaceDir: join(dir, 'ws'),
      home: null,
    });
    expect(r.requiresSubstrate).toBe('vm_or_container');
    expect(r.roots.map((x) => x.path)).toContain('/');
  });
});

describe('profiles in the store', () => {
  it('lists the built-ins with their hashes, then user profiles', async () => {
    const list = await store.listProfiles(ACCOUNT);
    expect(list.map((p) => p.id)).toEqual(['read-only', 'workspace', 'full']);
    expect(list[2]).toMatchObject({
      builtin: true,
      requiresSubstrate: 'vm_or_container',
      network: { mode: 'allowlist', allow: [], deny: [] },
    });
    const net = await store.createProfile(ACCOUNT, {
      name: 'workspace-net',
      extends: 'workspace',
      filesystem: [{ path: ':home', access: 'deny' }],
      network: { mode: 'allowlist', allow: ['registry.npmjs.org'] },
    });
    expect(net).toMatchObject({ name: 'workspace-net', builtin: false, requiresSubstrate: null });
    expect(net.fs.map((e) => e.path)).toEqual([':project', ':tmp', ':minimal', ':home']);
    const loaded = await loadPermissionProfile(db, ACCOUNT, 'workspace-net');
    expect(loaded.fallback).toBeNull();
    expect(loaded.profile.network.allow).toEqual(['registry.npmjs.org']);
    expect((await loadPermissionProfile(db, ACCOUNT, net.id)).profile.name).toBe('workspace-net');
  });

  it('validates new profiles', async () => {
    const base = { name: 'x', filesystem: [], network: { mode: 'off' as const } };
    await expect(
      store.createProfile(ACCOUNT, { ...base, name: 'workspace' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.createProfile(ACCOUNT, { ...base, name: 'Bad' })).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(
      store.createProfile(ACCOUNT, { ...base, extends: 'missing' }),
    ).rejects.toMatchObject({ code: 'validation' });
    const onFull = await store.createProfile(ACCOUNT, {
      ...base,
      name: 'on-full',
      extends: 'full',
    });
    expect(onFull.requiresSubstrate).toBe('vm_or_container');
  });

  it('deletes user profiles but not built-ins, managed ones or parents', async () => {
    const parent = await store.createProfile(ACCOUNT, {
      name: 'parent',
      filesystem: [],
      network: { mode: 'off' },
    });
    const child = await store.createProfile(ACCOUNT, {
      name: 'child',
      extends: parent.id,
      filesystem: [],
      network: { mode: 'off' },
    });
    await expect(store.deleteProfile(ACCOUNT, 'workspace')).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(store.deleteProfile(ACCOUNT, parent.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    await store.deleteProfile(ACCOUNT, child.id);
    await store.deleteProfile(ACCOUNT, parent.id);
    await expect(store.deleteProfile(ACCOUNT, parent.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    const now = new Date().toISOString();
    db.raw
      .prepare(
        `INSERT INTO permission_profile (id, account_id, name, fs_rules_json, network_json, source, created_at, updated_at)
         VALUES ('m1', ?, 'corp', '[]', '{"mode":"off"}', 'managed', ?, ?)`,
      )
      .run(ACCOUNT, now, now);
    await expect(store.deleteProfile(ACCOUNT, 'm1')).rejects.toMatchObject({
      code: 'policy_denied',
    });
  });

  it('falls back to read-only for unknown or broken profiles (fail closed)', async () => {
    expect(await loadPermissionProfile(db, ACCOUNT, 'nope')).toMatchObject({
      profile: { id: 'read-only' },
      fallback: 'unknown permission profile "nope"',
    });
    const now = new Date().toISOString();
    db.raw
      .prepare(
        `INSERT INTO permission_profile (id, account_id, name, extends, fs_rules_json, network_json, created_at, updated_at)
         VALUES ('loop', ?, 'loop', 'loop', '[]', '{"mode":"off"}', ?, ?)`,
      )
      .run(ACCOUNT, now, now);
    const broken = await loadPermissionProfile(db, ACCOUNT, 'loop');
    expect(broken.profile.id).toBe('read-only');
    expect(broken.fallback).toContain('extends itself');
    expect((await store.listProfiles(ACCOUNT)).map((p) => p.id)).not.toContain('loop');
  });
});
