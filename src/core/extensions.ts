// The extension host, skeleton (EXTENSION-MODEL). M1 covers the manifest (CONTRACTS §4) and the
// lifecycle: install (disabled), review permissions, enable, disable, remove. Removal follows the
// manifest's on_remove exactly and leaves nothing behind. Running extension code comes later;
// nothing here executes anything an extension ships.
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { CoreError } from './errors.ts';
import type { Db } from './db.ts';

export const KINDS = ['connector', 'mcp-server', 'plugin', 'skill-pack', 'agent-adapter', 'automation-adapter', 'design-system'] as const;
export type Kind = (typeof KINDS)[number];
export const PERMISSION_KINDS = ['data-read', 'data-write', 'network', 'device'] as const;

export interface Permission { kind: (typeof PERMISSION_KINDS)[number]; target: string; why: string }
export interface OnRemove { delete: string[]; keep: string[]; export: string[] }

export interface Manifest {
  id: string;
  version: string;
  kind: Kind;
  name: string;
  capabilities: string[];
  permissions: Permission[];
  secrets: string[];
  config_schema: Record<string, unknown>;
  setup_flow: unknown;
  health_check: Record<string, unknown>;
  nova_compat: string;
  on_remove: OnRemove;
}

export interface Installed { id: string; version: string; kind: Kind; state: 'installed' | 'enabled' | 'disabled'; manifest: Manifest; installed_at: string; updated_at: string }

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

type V = [number, number, number];
const ver = (s: string): V | null => {
  const m = SEMVER.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a: V, b: V) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// A range is space-separated comparators, all of which must hold: ">=0.1.0 <1.0.0".
export function satisfies(version: string, range: string): boolean {
  const v = ver(version);
  if (!v) return false;
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  return parts.every((p) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(p);
    const target = m && ver(m[2]!);
    if (!target) return false;
    const c = cmp(v, target);
    switch (m![1] ?? '=') {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      default: return c === 0;
    }
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const relPath = (p: string) => !p.startsWith('/') && !p.split(/[\\/]/).includes('..');

export function validateManifest(input: unknown): Manifest {
  const e: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) e.push(msg); };
  if (!isObj(input)) throw new CoreError('validation', 'An extension manifest must be an object.');
  const m = input;
  need(typeof m.id === 'string' && ID.test(m.id), 'id must be lowercase letters and numbers, separated by dots or dashes');
  need(typeof m.version === 'string' && !!ver(m.version), 'version must be semver, like 1.2.0');
  need(KINDS.includes(m.kind as Kind), `kind must be one of ${KINDS.join(', ')}`);
  need(typeof m.name === 'string' && m.name.trim().length > 0, 'name is required');
  need(strings(m.capabilities), 'capabilities must be a list of strings');
  need(Array.isArray(m.permissions) && m.permissions.every((p) => isObj(p) && PERMISSION_KINDS.includes(p.kind as Permission['kind']) && typeof p.target === 'string' && typeof p.why === 'string' && p.why.trim().length > 0),
    'permissions must be a list of {kind, target, why}; every permission says why, in plain words');
  need(Array.isArray(m.secrets) && m.secrets.every((s) => typeof s === 'string' && /^[A-Z][A-Z0-9_]*$/.test(s)), 'secrets must be a list of names like API_TOKEN, never values');
  need(isObj(m.config_schema), 'config_schema must be an object');
  need(m.setup_flow !== undefined, 'setup_flow is required (null if there is none)');
  need(isObj(m.health_check), 'health_check must be an object');
  need(typeof m.nova_compat === 'string' && m.nova_compat.trim().split(/\s+/).every((p) => !!ver(p.replace(/^(>=|<=|>|<|=)/, ''))), 'nova_compat must be a version range, like ">=0.1.0 <1.0.0"');
  const r = m.on_remove;
  need(isObj(r) && strings(r.delete) && strings(r.keep) && strings(r.export), 'on_remove must say what is deleted, kept and exported: {delete: [], keep: [], export: []}');
  if (isObj(r)) need([r.delete, r.keep, r.export].every((l) => !Array.isArray(l) || (l as string[]).every(relPath)), 'on_remove paths must stay inside the extension’s own data folder');
  if (e.length) throw new CoreError('validation', 'This extension manifest isn’t valid.', e);
  return m as unknown as Manifest;
}

// What the person is asked to agree to, in their words, not ours.
export function review(m: Manifest): string[] {
  const say: Record<Permission['kind'], string> = { 'data-read': 'Read', 'data-write': 'Change', network: 'Connect to', device: 'On your devices:' };
  const lines = m.permissions.map((p) => `${say[p.kind]} ${p.target}: ${p.why}`);
  if (m.secrets.length) lines.push(`Uses ${m.secrets.length === 1 ? 'a secret' : 'secrets'} you provide (${m.secrets.join(', ')}); Nova keeps the values, the extension never sees where.`);
  return lines.length ? lines : ['Asks for no permissions.'];
}

type Row = Record<string, string>;
const toInstalled = (r: Row): Installed => ({ ...(r as unknown as Installed), manifest: JSON.parse(r.manifest!) });

export class Extensions extends EventEmitter {
  readonly root: string;
  #db: Db;
  #home: string;
  #version: string;
  #now: () => Date;

  constructor(o: { db: Db; home: string; novaVersion: string; now?: () => Date }) {
    super();
    this.#db = o.db;
    this.#home = o.home;
    this.root = join(o.home, 'extensions');
    this.#version = o.novaVersion;
    this.#now = o.now ?? (() => new Date());
  }

  list(): Installed[] {
    return this.#db.all<Row>('SELECT * FROM extension ORDER BY id').map(toInstalled);
  }

  get(id: string): Installed {
    const row = this.#db.get<Row>('SELECT * FROM extension WHERE id = ?', id);
    if (!row) throw new CoreError('not_found', `No extension "${id}" is installed.`);
    return toInstalled(row);
  }

  dataDir(id: string): string {
    return join(this.root, id);
  }

  // Installed extensions start disabled: the person reviews permissions, then enables.
  install(input: unknown): { extension: Installed; review: string[] } {
    const m = validateManifest(input);
    if (!satisfies(this.#version, m.nova_compat)) throw new CoreError('conflict', `${m.name} needs Nova ${m.nova_compat}; this is ${this.#version}.`);
    if (this.#db.get('SELECT 1 FROM extension WHERE id = ?', m.id)) throw new CoreError('conflict', `${m.name} is already installed. Updates go through the update path.`);
    const at = this.#now().toISOString();
    this.#db.run('INSERT INTO extension (id, version, kind, manifest, state, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', m.id, m.version, m.kind, JSON.stringify(m), 'installed', at, at);
    mkdirSync(this.dataDir(m.id), { recursive: true });
    const extension = this.get(m.id);
    this.emit('change', { id: m.id, state: 'installed' });
    return { extension, review: review(m) };
  }

  enable(id: string, opts: { approved?: boolean } = {}): Installed {
    const x = this.get(id);
    if (x.manifest.permissions.length && opts.approved !== true) throw new CoreError('forbidden', `Enabling ${x.manifest.name} needs your OK on its permissions first.`, review(x.manifest));
    return this.#set(id, 'enabled');
  }

  disable(id: string): Installed {
    this.get(id);
    return this.#set(id, 'disabled');
  }

  // Follows on_remove: exports what it promises to export, keeps what it promises to keep, and
  // deletes the rest, including the record. Nothing of the extension stays behind.
  remove(id: string): { deleted: string[]; kept: string[]; exported: string[] } {
    const x = this.get(id);
    const data = this.dataDir(id);
    const stamp = this.#now().toISOString().replace(/[:.]/g, '-');
    const inside = (p: string) => {
      const abs = resolve(data, p);
      if (abs !== data && !abs.startsWith(data + sep)) throw new CoreError('forbidden', `${p} is outside ${x.manifest.name}'s data folder.`);
      return abs;
    };
    const copyOut = (paths: string[], to: string) => paths.filter((p) => existsSync(inside(p))).map((p) => {
      const dest = join(to, p);
      cpSync(inside(p), dest, { recursive: true });
      return dest;
    });
    const exported = copyOut(x.manifest.on_remove.export, join(this.#home, 'exports', `${id}-${stamp}`));
    const kept = copyOut(x.manifest.on_remove.keep, join(this.#home, 'kept', id));
    const deleted = existsSync(data) ? [data] : [];
    rmSync(data, { recursive: true, force: true });
    this.#db.run('DELETE FROM extension WHERE id = ?', id);
    this.emit('change', { id, state: 'removed' });
    return { deleted, kept, exported };
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = { installed: 0, enabled: 0, disabled: 0 };
    for (const r of this.#db.all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM extension GROUP BY state')) out[r.state] = r.n;
    return out;
  }

  #set(id: string, state: Installed['state']): Installed {
    this.#db.run('UPDATE extension SET state = ?, updated_at = ? WHERE id = ?', state, this.#now().toISOString(), id);
    this.emit('change', { id, state });
    return this.get(id);
  }
}
