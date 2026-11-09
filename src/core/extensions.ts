// The extension host, skeleton (EXTENSION-MODEL). M1 covers the manifest (CONTRACTS §4) and the
// lifecycle: install (disabled), review permissions, enable, disable, remove. Removal follows the
// manifest's on_remove exactly and leaves nothing behind. Running extension code comes later;
// nothing here executes anything an extension ships.
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { CoreError } from './errors.ts';
import type { Db } from './db.ts';
import { isObj } from './envelope.ts';
import { EFFECT_NAMES, type ManifestApproval } from './approvals/index.ts';

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
  // Optional: the capabilities that act, each with its effect class, for the approvals registry
  // (approvals/index.ts). Nova derives each one's floor and starting default from its class; the
  // manifest may only ask for stricter. Registered on install, dropped on removal.
  approvals?: ManifestApproval[];
  // Optional: what the service can do when the person asks in chat, through the one chat tool
  // (service_call, src/tools.js) rather than a tool of its own. Each action belongs to one of the
  // capabilities above, which sets its tier and its outside-content guard. Code that runs an action
  // is the connector's `act` (connectors/index.ts); an extension declares the same field.
  actions?: ManifestAction[];
}

// One thing a service can do when asked, in words the chat model reads: `id` (call), `name` and
// `words` (what it does and how Nova checks it), `args` (each argument's name and what it is, in
// words; an argument whose words start "optional" may be left out), an `example` of the args, and
// `approval`, the local id of the capability in `approvals` it belongs to.
export interface ManifestAction {
  id: string;
  name: string;
  words: string;
  args: Record<string, string>;
  example?: Record<string, unknown>;
  approval: string;
}

// What a kind of extension adds to the host: extra install checks (plain-words problems), and a
// veto on removal (a reason, or null to allow). Design systems use both (design.ts).
export interface KindRules {
  check?: (m: Manifest) => string[];
  protect?: (x: Installed) => string | null;
  // On removal, before its data folder goes: what the kind revokes beyond that folder (a
  // connector's sign-in at its service, its secrets in the vault, its event subscriptions).
  revoke?: (x: Installed) => void;
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
  if (m.approvals !== undefined) {
    const tier = (t: unknown) => t === 0 || t === 1 || t === 2 || t === 3;
    const ok = Array.isArray(m.approvals) && m.approvals.every((a) => isObj(a)
      && typeof a.id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(a.id)
      && typeof a.name === 'string' && a.name.trim().length > 0
      && EFFECT_NAMES.includes(a.effect as never)
      && (a.default === undefined || tier(a.default)) && (a.floor === undefined || tier(a.floor))
      && (a.tiers === undefined || (Array.isArray(a.tiers) && a.tiers.every(tier)))
      && (a.tools === undefined || strings(a.tools)) && (a.guard === undefined || typeof a.guard === 'string') && (a.targets === undefined || typeof a.targets === 'string'));
    need(ok, `approvals must be a list of {id, name, effect, default?, floor?, tiers?, tools?, guard?, targets?}; effect is one of ${EFFECT_NAMES.join(', ')}, and a tier is 0 to 3`);
  }
  if (m.actions !== undefined) {
    const own = new Set(Array.isArray(m.approvals) ? m.approvals.filter(isObj).map((a) => a.id) : []);
    const ok = Array.isArray(m.actions) && m.actions.every((a) => isObj(a)
      && typeof a.id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(a.id)
      && typeof a.name === 'string' && a.name.trim().length > 0
      && typeof a.words === 'string' && a.words.trim().length > 0
      && isObj(a.args) && Object.entries(a.args).every(([k, v]) => /^[a-z_][a-z0-9_]{0,63}$/.test(k) && typeof v === 'string')
      && (a.example === undefined || isObj(a.example))
      && typeof a.approval === 'string' && own.has(a.approval));
    need(ok, 'actions must be a list of {id, name, words, args, example?, approval}; args names each argument with its words, and approval is the id of one of this manifest’s approvals');
    if (ok) need(new Set((m.actions as { id: string }[]).map((a) => a.id)).size === (m.actions as unknown[]).length, 'each action has its own id');
  }
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
  #kinds: Partial<Record<Kind, KindRules>>;

  constructor(o: { db: Db; home: string; novaVersion: string; now?: () => Date; kinds?: Partial<Record<Kind, KindRules>> }) {
    super();
    this.#kinds = o.kinds ?? {};
    this.#db = o.db;
    this.#home = o.home;
    this.root = join(o.home, 'extensions');
    this.#version = o.novaVersion;
    this.#now = o.now ?? (() => new Date());
  }

  // Lets the module that owns a kind (design.ts for design systems) add its rules after the host exists.
  defineKind(kind: Kind, rules: KindRules): void {
    this.#kinds[kind] = rules;
  }

  // An install check for every kind (the approvals registry: a declared capability may not take
  // an id that is Nova's own or another extension's).
  #checks: ((m: Manifest) => string[])[] = [];
  addCheck(check: (m: Manifest) => string[]): void {
    this.#checks.push(check);
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
  // `builtin`: ships inside this Nova (the core's own design systems), so it is compatible by
  // construction and nova_compat isn't checked.
  install(input: unknown, o: { builtin?: boolean } = {}): { extension: Installed; review: string[] } {
    const m = this.#validate(input);
    if (!o.builtin && !satisfies(this.#version, m.nova_compat)) throw new CoreError('conflict', `${m.name} needs Nova ${m.nova_compat}; this is ${this.#version}.`);
    if (this.#db.get('SELECT 1 FROM extension WHERE id = ?', m.id)) throw new CoreError('conflict', `${m.name} is already installed. Updates go through the update path.`);
    const at = this.#now().toISOString();
    this.#db.run('INSERT INTO extension (id, version, kind, manifest, state, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', m.id, m.version, m.kind, JSON.stringify(m), 'installed', at, at);
    mkdirSync(this.dataDir(m.id), { recursive: true });
    const extension = this.get(m.id);
    this.emit('change', { id: m.id, state: 'installed' });
    return { extension, review: review(m) };
  }

  // The update path: a newer manifest for an installed extension of the same kind replaces the
  // old one in place; its state (enabled or not) and its data folder stay as they are.
  update(input: unknown, o: { builtin?: boolean } = {}): Installed {
    const m = this.#validate(input);
    const x = this.get(m.id);
    if (x.kind !== m.kind) throw new CoreError('conflict', `${x.manifest.name} is a ${x.kind}; an update can’t change its kind to ${m.kind}.`);
    if (!o.builtin && !satisfies(this.#version, m.nova_compat)) throw new CoreError('conflict', `${m.name} needs Nova ${m.nova_compat}; this is ${this.#version}.`);
    this.#db.run('UPDATE extension SET version = ?, manifest = ?, updated_at = ? WHERE id = ?', m.version, JSON.stringify(m), this.#now().toISOString(), m.id);
    this.emit('change', { id: m.id, state: x.state, version: m.version });
    return this.get(m.id);
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

  // Puts a state back exactly as it was (the change pipeline's rollback): an extension that was
  // only installed, its permissions never OK'd, goes back to installed, not enabled.
  restoreState(id: string, state: Installed['state']): Installed {
    if (!['installed', 'enabled', 'disabled'].includes(state)) throw new CoreError('validation', `There is no extension state called ${String(state)}.`);
    this.get(id);
    return this.#set(id, state);
  }

  // Follows on_remove: exports what it promises to export, keeps what it promises to keep, and
  // deletes the rest, including the record. Nothing of the extension stays behind.
  // `purge`: undoing an install that never stayed (a change rolled back): nothing of it was the
  // person's to keep, so nothing is copied out.
  remove(id: string, o: { purge?: boolean } = {}): { deleted: string[]; kept: string[]; exported: string[] } {
    const x = this.get(id);
    const veto = this.#kinds[x.kind]?.protect?.(x);
    if (veto) throw new CoreError('conflict', veto);
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
    const exported = o.purge ? [] : copyOut(x.manifest.on_remove.export, join(this.#home, 'exports', `${id}-${stamp}`));
    const kept = o.purge ? [] : copyOut(x.manifest.on_remove.keep, join(this.#home, 'kept', id));
    this.#kinds[x.kind]?.revoke?.(x);
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

  #validate(input: unknown): Manifest {
    const m = validateManifest(input);
    const problems = [...(this.#kinds[m.kind]?.check?.(m) ?? []), ...this.#checks.flatMap((c) => c(m))];
    if (problems.length) throw new CoreError('validation', 'This extension manifest isn’t valid.', problems);
    return m;
  }

  #set(id: string, state: Installed['state']): Installed {
    this.#db.run('UPDATE extension SET state = ?, updated_at = ? WHERE id = ?', state, this.#now().toISOString(), id);
    this.emit('change', { id, state });
    return this.get(id);
  }
}
