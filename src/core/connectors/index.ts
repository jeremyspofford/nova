// The connector kind (EXTENSION-MODEL): an extension that talks to an outside service. It has a
// manifest (CONTRACTS §4) in the extension host, owns its auth through the vault (every secret
// under connector/<id>/), and turns what it sees into M2 event triggers, but only for what a rule
// listens to (source connector:<id>/<topic>). Disconnecting or removing one revokes it at the
// service where the service allows, deletes its secrets, its rules and its settings: nothing of it
// stays behind.
//
// Connectors run on the hub only. A standby holds their settings (journalled) and secrets (the vault,
// sealed in the sync stream) and starts them when it is promoted.
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import type { Extensions, Installed, Manifest } from '../extensions.ts';
import type { Vault } from '../vault.ts';
import type { Triggers, TriggerRecord } from '../triggers.ts';
import type { Log } from '../log.ts';
import type { Egress, Worker } from '../workers.ts';
import type { Checker } from '../verify.ts';
import type { Route } from '../api.ts';
import type { PrivacyMode } from '../envelope.ts';
import type { Task, TaskInput } from '../ledger.ts';
import { permits } from '../workers.ts';

export interface ConnectorStatus {
  connected: boolean;
  // It was connected, and the service no longer accepts Nova: reconnect.
  broken?: boolean;
  // Whom or what it is connected to, in plain words (an address, “Home”).
  account?: string | null;
  since?: string | null;
  // Live events: listening, reconnecting after a drop, or off.
  live?: 'listening' | 'reconnecting' | 'off' | null;
  detail?: string | null;
}

export type Setup =
  | { kind: 'form'; fields: { key: string; label: string; secret?: boolean; placeholder?: string; hint?: string }[] }
  | { kind: 'link'; href: string; label: string };

export interface Connector {
  manifest: Manifest;
  summary: string;
  // What it can do and what it never does, in plain words, for the person to read before connecting.
  can: string[];
  never: string[];
  setup: Setup;
  // Where its calls go, for the privacy check: local (this network or the mesh) or remote.
  egress(): Egress;
  status(): ConnectorStatus;
  connect?(input: Record<string, unknown>): Promise<ConnectorStatus>;
  // Revokes at the service where it can; the registry deletes the secrets afterwards in any case.
  disconnect(): Promise<{ revoked: boolean; note?: string }>;
  start?(): void;
  stop?(): Promise<void> | void;
  // What an event rule may listen for: null when the topic is fine, else why not.
  topic?(topic: string): string | null;
  worker?: Worker;
  confirm?: Checker;
  routes?: Route[];
}

export interface ConnectorContext {
  id: string;
  // This connector's secrets, by name (HA_TOKEN); stored as connector/<id>/<name> in the vault.
  secrets: { get(name: string): string | null; put(name: string, value: string): string; delete(name: string): boolean; has(name: string): boolean };
  // Its settings, in its extension data folder (journalled, so a standby has them).
  config: { get(): Record<string, unknown>; set(patch: Record<string, unknown>): Record<string, unknown>; clear(): void };
  // Something happened: a trigger record if a rule listens for the topic, else nothing.
  emit(topic: string, payload: unknown, dedupKey?: string): Promise<TriggerRecord | null>;
  // The topics rules listen for right now.
  topics(): string[];
  // Whether the person's privacy setting lets Nova contact something with this egress.
  permits(egress: Egress): boolean;
  privacy(): PrivacyMode;
  // Hosts of devices in the mesh, which count as local.
  meshHosts(): string[];
  // Work that needs the ledger's gates (approval tiers): a task for this connector's worker.
  delegate(input: Omit<TaskInput, 'origin' | 'owner'>): Task;
  problem(message: string, detail?: string): void;
  changed(): void;
  now(): Date;
}

export type ConnectorFactory = (ctx: ConnectorContext) => Connector;

export interface ConnectorView extends ConnectorStatus {
  id: string;
  name: string;
  summary: string;
  can: string[];
  never: string[];
  setup: Setup;
  egress: Egress;
  // Whether the person's privacy setting lets it be used now, and if not, why.
  allowed: boolean;
  blocked: string | null;
  secrets: string[];
  recommended: boolean;
}

export const secretPrefix = (id: string) => `connector/${id}/`;

export interface ConnectorsOptions {
  extensions: Extensions;
  vault: Vault;
  triggers: Triggers;
  log: Log;
  privacy: () => PrivacyMode;
  meshHosts: () => string[];
  delegate: (owner: string, input: Omit<TaskInput, 'origin' | 'owner'>) => Task;
  addWorker: (w: Worker) => void;
  addConfirmation: (system: string, check: Checker) => void;
  now: () => Date;
}

export class Connectors extends EventEmitter {
  #o: ConnectorsOptions;
  #all = new Map<string, Connector>();
  #started = false;
  #removing = new Set<string>();

  constructor(o: ConnectorsOptions) {
    super();
    this.#o = o;
    o.triggers.connectorCheck = (id, topic) => {
      const c = this.#all.get(id);
      if (!c) return `There is no connector called ${id}.`;
      return c.topic ? c.topic(topic) : `${c.manifest.name} doesn’t send events.`;
    };
    // Removing a connector through the extension host revokes it too.
    o.extensions.defineKind('connector', {
      revoke: (x: Installed) => {
        // Disconnect removes the record itself, after doing all of this.
        if (this.#removing.has(x.id)) return;
        const c = this.#all.get(x.id);
        let signingOut: Promise<{ revoked: boolean; note?: string }> | null = null;
        if (c) {
          try { void c.stop?.(); } catch { /* stopping anyway */ }
          // Started first: it reads the token and address it needs before they are deleted below.
          signingOut = c.disconnect();
        }
        this.#revokeLocal(x.id);
        signingOut?.then((r) => { if (r.note) o.log.problem('connectors', `${x.manifest.name} was removed. ${r.note}`); })
          .catch((e) => o.log.problem('connectors', `Nova removed ${x.manifest.name} here, but couldn’t sign it out at the service. Remove Nova’s access there too.`, { detail: (e as Error)?.stack ?? String(e) }));
        this.emit('change', { id: x.id, connected: false });
      },
    });
  }

  register(factory: ConnectorFactory): Connector {
    const ctx = this.#context(factory);
    const c = factory(ctx.ctx);
    ctx.bind(c);
    const m = c.manifest;
    if (m.kind !== 'connector') throw new Error(`${m.name} isn’t a connector.`);
    if (this.#all.has(m.id)) throw new Error(`A connector called ${m.id} is already registered.`);
    this.#all.set(m.id, c);
    // A built-in connector is in the extension host once the person connects it (and leaves it
    // when they disconnect), so the host lists what they chose, not everything Nova could do.
    // Records change on the hub only (start(), below): a standby's come from the hub.
    if (c.worker) this.#o.addWorker(c.worker);
    if (c.confirm) this.#o.addConfirmation(m.id, c.confirm);
    if (this.#started) this.#ready(c);
    return c;
  }

  // On the hub: the extension record matches what is connected (an Era 2 Gmail connected before
  // M5 gets its record here, and a newer built-in manifest replaces the old), then live work starts.
  #ready(c: Connector): void {
    const m = c.manifest;
    try {
      const have = this.#o.extensions.list().find((x) => x.id === m.id);
      if (have && have.version !== m.version) this.#o.extensions.update(m, { builtin: true });
      if (safeStatus(c).connected) this.#enabled(m.id, true);
    } catch (e) {
      this.#o.log.problem('connectors', `Nova couldn’t record ${m.name} in its extensions.`, { detail: (e as Error)?.stack ?? String(e) });
    }
    if (safeStatus(c).connected) this.#startOne(c);
  }

  has(id: string): boolean {
    return this.#all.has(id);
  }

  get(id: string): Connector {
    const c = this.#all.get(id);
    if (!c) throw new CoreError('not_found', `There is no connector called ${id}.`);
    return c;
  }

  list(): ConnectorView[] {
    const views = [...this.#all.values()].map((c) => this.#view(c));
    // Nova recommends one rather than listing options: the first not yet connected that the
    // privacy setting allows.
    const pick = views.find((v) => !v.connected && !v.broken && v.allowed);
    if (pick) pick.recommended = true;
    return views;
  }

  view(id: string): ConnectorView {
    return this.list().find((v) => v.id === id) ?? this.#view(this.get(id));
  }

  async connect(id: string, input: Record<string, unknown>): Promise<ConnectorView> {
    const c = this.get(id);
    if (!c.connect) throw new CoreError('validation', `${c.manifest.name} is connected from its own page.`);
    await c.connect(input ?? {});
    this.#enabled(id, true);
    if (this.#started) this.#startOne(c);
    this.emit('change', { id, connected: c.status().connected });
    return this.view(id);
  }

  // Signs out at the service where it can, then deletes everything of it here: secrets, the rules
  // that listen to it, its settings.
  async disconnect(id: string): Promise<ConnectorView & { revoked: boolean; note: string | null; rules_removed: number }> {
    const c = this.get(id);
    await c.stop?.();
    let out: { revoked: boolean; note?: string } = { revoked: false };
    try {
      out = await c.disconnect();
    } catch (e) {
      out = { revoked: false, note: `Nova couldn’t sign out at the service (${(e as Error).message}), so remove Nova’s access there too.` };
    }
    const rules = this.#revokeLocal(id);
    // Out of the extension host too; its data folder goes with it (on_remove).
    if (this.#o.extensions.list().some((x) => x.id === id)) {
      this.#removing.add(id);
      try { this.#o.extensions.remove(id); } finally { this.#removing.delete(id); }
    }
    this.emit('change', { id, connected: false });
    return { ...this.view(id), revoked: out.revoked, note: out.note ?? null, rules_removed: rules };
  }

  // Connected or disconnected somewhere else (Era 2's Gmail page): started or stopped to match.
  touched(id: string): void {
    const c = this.get(id);
    const s = safeStatus(c);
    if (s.connected && this.#started) this.#startOne(c);
    if (!s.connected) Promise.resolve(c.stop?.()).catch(() => {});
    this.#enabled(id, s.connected);
    this.emit('change', { id, connected: s.connected });
  }

  // Hub only: live connections start when the node is hub, and stop when it steps down.
  start(): void {
    this.#started = true;
    for (const c of this.#all.values()) this.#ready(c);
  }

  async stop(): Promise<void> {
    this.#started = false;
    await Promise.all([...this.#all.values()].map(async (c) => { try { await c.stop?.(); } catch { /* stopping anyway */ } }));
  }

  routes(): Route[] {
    return [...this.#all.values()].flatMap((c) => (c.routes ?? []).map((r) => ({ ...r, path: `/connectors/${c.manifest.id}${r.path}` })));
  }

  health(): { ok: boolean; detail: string; connected: number; broken: number } {
    const views = [...this.#all.values()].map((c) => ({ c, s: safeStatus(c) }));
    const broken = views.filter((v) => v.s.broken);
    const connected = views.filter((v) => v.s.connected).length;
    return {
      ok: true, connected, broken: broken.length,
      detail: broken.length ? `${broken.map((v) => v.c.manifest.name).join(', ')} needs reconnecting.` : connected ? `${connected} connected.` : 'Nothing connected.',
    };
  }

  // ---- inside ------------------------------------------------------------------------------

  #startOne(c: Connector): void {
    try { c.start?.(); } catch (e) { this.#o.log.problem('connectors', `${c.manifest.name} couldn’t start.`, { detail: (e as Error)?.stack ?? String(e) }); }
  }

  // Connecting is the person's OK on what the connector shows it can do (its permissions).
  #enabled(id: string, on: boolean): void {
    const x = this.#o.extensions.list().find((e) => e.id === id);
    if (on && !x) this.#o.extensions.install(this.get(id).manifest, { builtin: true });
    if (on && x?.state !== 'enabled') this.#o.extensions.enable(id, { approved: true });
    if (!on && x?.state === 'enabled') this.#o.extensions.disable(id);
  }

  // Secrets, subscriptions and settings: what revoking means here. Returns how many rules went.
  #revokeLocal(id: string): number {
    this.#o.vault.deletePrefix(secretPrefix(id));
    const rules = this.#o.triggers.removeConnectorRules(id);
    rmSync(join(this.#o.extensions.dataDir(id), 'config.json'), { force: true });
    return rules.length;
  }

  #view(c: Connector): ConnectorView {
    const s = safeStatus(c);
    const egress = c.egress();
    const allowed = permits(this.#o.privacy(), egress);
    return {
      id: c.manifest.id, name: c.manifest.name, summary: c.summary, can: c.can, never: c.never, setup: c.setup,
      ...s, egress, allowed,
      blocked: allowed ? null : `${c.manifest.name} works through a service outside your devices, and Nova is set to local-only, so it’s off.`,
      secrets: this.#o.vault.status().ok ? this.#o.vault.list(secretPrefix(c.manifest.id)).map((n) => n.slice(secretPrefix(c.manifest.id).length)) : [],
      recommended: false,
    };
  }

  #context(factory: ConnectorFactory): { ctx: ConnectorContext; bind: (c: Connector) => void } {
    let c: Connector | null = null;
    const o = this.#o;
    const id = () => {
      if (!c) throw new Error(`A connector used its context before it was made (${factory.name}).`);
      return c.manifest.id;
    };
    const name = (n: string) => {
      const m = c?.manifest;
      if (m && !m.secrets.includes(n)) throw new Error(`${m.name} doesn’t declare a secret called ${n}.`);
      return `${secretPrefix(id())}${n}`;
    };
    const configFile = () => join(o.extensions.dataDir(id()), 'config.json');
    const read = (): Record<string, unknown> => { try { return JSON.parse(readFileSync(configFile(), 'utf8')) as Record<string, unknown>; } catch { return {}; } };
    const ctx: ConnectorContext = {
      get id() { return id(); },
      secrets: {
        get: (n) => o.vault.get(name(n)),
        put: (n, v) => o.vault.put(name(n), v),
        delete: (n) => o.vault.delete(name(n)),
        has: (n) => o.vault.has(name(n)),
      },
      config: {
        get: read,
        set: (patch) => {
          const next = { ...read(), ...patch };
          mkdirSync(o.extensions.dataDir(id()), { recursive: true });
          writeFileSync(configFile(), `${JSON.stringify(next, null, 2)}\n`);
          return next;
        },
        clear: () => rmSync(configFile(), { force: true }),
      },
      emit: (topic, payload, dedupKey) => o.triggers.connectorEvent(id(), topic, payload, dedupKey),
      topics: () => o.triggers.connectorTopics(id()),
      permits: (egress) => permits(o.privacy(), egress),
      privacy: () => o.privacy(),
      meshHosts: () => o.meshHosts(),
      delegate: (input) => o.delegate(id(), input),
      problem: (message, detail) => { o.log.problem('connectors', message, detail ? { detail } : {}); },
      changed: () => this.emit('change', { id: id(), connected: c ? safeStatus(c).connected : false }),
      now: () => o.now(),
    };
    return { ctx, bind: (x) => { c = x; } };
  }
}

function safeStatus(c: Connector): ConnectorStatus {
  try {
    return c.status();
  } catch (e) {
    return { connected: false, detail: (e as Error).message };
  }
}

// ---- where a service is ---------------------------------------------------------------------

// local: this computer, the home network, or a device in the mesh; remote: anywhere else. Decided
// from the address as written (a name that resolves somewhere public still counts by its name).
export function addressEgress(url: string, meshHosts: string[] = []): Egress {
  let host: string;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return 'remote'; }
  if (meshHosts.map((h) => h.toLowerCase()).includes(host)) return 'local';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'local';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) ? 'local' : 'remote';
  }
  if (host.includes(':')) return host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host) ? 'local' : 'remote';
  if (!host.includes('.') || /\.(local|lan|home\.arpa|internal)$/.test(host)) return 'local';
  return 'remote';
}
