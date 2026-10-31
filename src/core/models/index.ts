// The local model manager (M6 plan §2, LOCAL-MODELS): what each device can run, which model
// serves which role, downloads and removal as ledger tasks Nova checks itself, and the one
// internal inference API. Callers name a role (`infer({role, messages | input, privacy_mode})`),
// never a model or a binary; the manager picks the device and model the profile assigns, wakes a
// sleeping GPU spoke when the job is worth it, and works the fallback chain inside the task's
// privacy mode:
//   - local-only: local models only. Down means the task waits ("waiting on local capacity") and
//     the person is told; it is never sent to the cloud, not even with a warning.
//   - local-preferred: local first; when local is down, the cloud model the person set serves,
//     the receipt says so, and a problem is opened for the local fault.
//   - cloud-allowed: the cloud model first (within budget); when it can't be reached, or the
//     budget is used, the local model serves and Nova says the answer may be less thorough.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { CoreError } from '../errors.ts';
import { ENVELOPE_VERSION, type Brief, type PrivacyMode, type Report } from '../envelope.ts';
import { stricter } from '../workers.ts';
import { chatMessages } from '../providers/openai.ts';
import { str, type Usage } from '../providers/types.ts';
import { checkHardware, detectHardware, gb, hardwareWords, privateAddress, type Hardware } from './hardware.ts';
import { Ollama, RuntimeDown, runsRemotely, type InstalledModel, type Message } from './ollama.ts';
import { CATALOG, HEADROOM, ROLES, ROLE_WORDS, capacityWords, recommend, type DeviceModels, type Pick, type Role, type RoleAdvice } from './recommend.ts';
import { sendMagic } from './wake.ts';
import type { Db } from '../db.ts';
import type { Ledger, LanedWorker, Task } from '../ledger.ts';
import type { Log } from '../log.ts';
import type { Profile } from '../profile.ts';
import type { ContextItem, Receipts } from '../receipts.ts';
import type { Verifier } from '../verify.ts';
import type { Devices, Device } from '../mesh/devices.ts';
import type { Route } from '../api.ts';

export { ROLES, ROLE_WORDS, type Role } from './recommend.ts';
export type { Hardware } from './hardware.ts';

export const HUB = 'hub';
export const DEFAULT_OLLAMA = 'http://127.0.0.1:11434';
export const CONFIRMATION_SYSTEM = 'model-runtime';
const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/;
const PERIODS = ['day', 'week', 'month'] as const;
type Period = (typeof PERIODS)[number];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Where a role runs: a device (the hub, or a paired computer), its runtime's address, and the
// model. A role on a GPU spoke may name a hub model that small jobs use instead of waking it.
export interface Placement { device: string; runtime: 'ollama'; url: string; model: string; hub_model?: string }

export interface Cloud { name: string; base_url: string; model: string; api_key?: string; usd_per_mtok_in?: number; usd_per_mtok_out?: number; max_tokens?: number }
// The longest reply a cloud call may give, unless the person set one: it bounds what a call costs.
export const DEFAULT_MAX_TOKENS = 4096;
export interface Budget { per_task_usd?: number; per_period_usd?: number; period: Period }

export interface InferRequest {
  role: Role;
  messages?: Message[];
  input?: string | string[];
  privacy_mode?: PrivacyMode;
  task_id?: string;
  session_id?: string;
  purpose?: string;
  // What went into the call, for its receipt (CONTRACTS §2); the messages' hash when not given.
  context_items?: ContextItem[];
  // A JSON schema the reply must follow (structured output), for typed answers.
  format?: Record<string, unknown> | 'json';
  // The task's own cloud budget (its brief's max_cost_usd).
  max_cost_usd?: number;
  signal?: AbortSignal;
  onText?: (t: string) => void;
}

export interface InferResult {
  text?: string;
  embeddings?: number[][];
  aborted?: boolean;
  served_by: 'local' | 'cloud';
  device: string;
  model: string;
  provider: string;
  egress: string;
  receipt_id: string;
  // What the person should know about how it was served (a cloud fallback, possibly less depth).
  notes: string[];
  usage: Usage;
}

// The task (or chat) can't be served right now and waits: on local capacity, or on the cloud
// budget. The message is what the person reads.
export class ModelsWaiting extends CoreError {
  readonly kind: 'capacity' | 'budget';
  readonly role: Role;
  constructor(kind: 'capacity' | 'budget', role: Role, message: string) {
    super('conflict', message);
    this.kind = kind;
    this.role = role;
  }
}

class LocalDown extends Error {}
class CloudDown extends Error {}
class BudgetBlocked extends Error {}

export interface ModelsOptions {
  db: Db;
  log: Log;
  profile: Profile;
  ledger: Ledger;
  verifier: Verifier;
  receipts: Receipts;
  devices: Devices;
  // The hub's own name, for the device map.
  hubName: () => string;
  // Where the hub's Ollama answers, unless the profile says otherwise.
  ollamaUrl?: string;
  // How the hub's hardware is read (tests hand in a fixed answer).
  hardware?: () => Promise<Hardware>;
  // The disk the hub's models live on, for free space.
  diskPath?: string;
  secret: (v: unknown) => string | null;
  // Whether a host is one of the person's devices on the mesh (its address there).
  meshHost?: (host: string) => boolean;
  // Tells the person something, the way proactive messages go (quiet hours and all).
  notify?: (key: string, text: string) => void;
  // How often waiting tasks are checked against returning capacity; how often a waking device is asked.
  watchMs?: number;
  wakePollMs?: number;
  // The hub's decision model as the Decision Service sees it (DS1 NOTE 4), for the device record.
  decisionModel?: () => { model: string | null; digest: string | null; why: string } | null;
  // Called after /models/refresh has read the hub again, so a newly pulled decision model is seen.
  refreshed?: () => Promise<void>;
  now?: () => Date;
}

interface Inventory { ok: boolean; version: string | null; models: InstalledModel[]; problem: string | null; at: string }
interface Download { task_id: string; action: 'pull' | 'remove'; model: string; device: string; status: string; completed: number; total: number; digest: string | null }

export class Models extends EventEmitter {
  readonly worker: LanedWorker;
  #o: ModelsOptions;
  #now: () => Date;
  #hw: Hardware | null = null;
  #hwAt = 0;
  #inventory = new Map<string, Inventory>();
  #downloads = new Map<string, Download>();
  #waking = new Map<string, Promise<WakeResult>>();
  #faults = new Set<Role>();
  #told = new Set<string>();
  // What cloud calls still running may cost at most, held against the budget until they settle.
  #reserved = new Map<symbol, { task_id: string | null; usd: number }>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #watching = false;

  constructor(o: ModelsOptions) {
    super();
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    o.verifier.registerConfirmation(CONFIRMATION_SYSTEM, (e, brief) => this.#confirm(e, brief));
    this.worker = this.#makeWorker();
    // Cloud usage that came back in a report from a provider that sends off the devices (a coding
    // agent in the cloud) is tracked here too, so the budget sees every dollar.
    o.ledger.on('task', (t: Task) => this.#trackReport(t));
    // A computer revoked (or no longer a trusted computer for any reason) loses its roles at once.
    o.devices.on('revoked', () => this.#forgetUntrusted());
    o.devices.on('change', () => this.#forgetUntrusted());
  }

  // ---- settings ------------------------------------------------------------------------------

  #get<T>(key: string): T | undefined { return this.#o.profile.get<T>('models', key); }
  #set(key: string, value: unknown): void { this.#o.profile.set('models', key, value, 'settings'); }

  hubUrl(): string { return str(this.#get<string>('runtime.hub')) || this.#o.ollamaUrl || DEFAULT_OLLAMA; }

  // Where a role runs, as long as its device is still one Nova may send work to. A computer that
  // was revoked has no roles, whatever the profile still says.
  placement(role: Role): Placement | null {
    const p = this.#stored(role);
    return p && this.#trusted(p.device) ? p : null;
  }

  #stored(role: Role): Placement | null {
    const p = this.#get<Placement>(`role.${role}`);
    return isObj(p) && typeof p.model === 'string' && typeof p.device === 'string' ? { ...p, runtime: 'ollama', url: p.device === HUB ? this.hubUrl() : p.url } : null;
  }

  // The hub, or a paired computer the person still trusts. Checked on every call, not only when a
  // role is assigned: trust can be taken back at any time.
  #trusted(device: string): boolean {
    if (device === HUB) return true;
    const d = this.#o.devices.find(device);
    return !!d && d.trust === 'trusted' && d.kind === 'computer' && d.role !== 'hub';
  }

  // A computer that is no longer trusted loses its roles and the address Nova kept for it, so
  // nothing reaches it again until the person pairs and assigns it anew.
  #forgetUntrusted(): void {
    const gone = new Set<string>();
    for (const r of ROLES) {
      const p = this.#stored(r);
      if (p && !this.#trusted(p.device)) { gone.add(p.device); this.unassign(r); }
    }
    for (const row of this.#o.db.all<{ key: string }>(`SELECT key FROM profile WHERE section = 'models' AND key LIKE 'runtime.%' AND key != 'runtime.hub'`)) {
      const device = row.key.slice('runtime.'.length);
      if (!this.#trusted(device)) { gone.add(device); this.#del(row.key); }
    }
    for (const device of gone) {
      this.#inventory.delete(device);
      this.#o.log.info('models', `${this.#deviceName(device)} is no longer trusted, so its model roles were cleared and Nova sends it nothing.`);
    }
  }

  #del(key: string): void {
    this.#o.db.run(`DELETE FROM profile WHERE section = 'models' AND key = ?`, key);
    this.#o.profile.emit('change', { section: 'models', key });
  }

  // Whether a model runs somewhere other than the device that lists it (an Ollama cloud model),
  // by its name or by what Nova last read of that device's list.
  #remote(device: string, model: string): boolean {
    const m = (this.#inventory.get(device) ?? this.#remembered(device))?.models.find((x) => x.name === model);
    return runsRemotely(model, m);
  }

  cloud(): Cloud | null {
    const c = this.#get<Cloud>('cloud');
    return isObj(c) && str(c.base_url) && str(c.model) ? c : null;
  }

  budget(): Budget {
    const b = this.#get<Budget>('budget');
    return isObj(b) ? { ...b, period: PERIODS.includes(b.period) ? b.period : 'month' } : { period: 'month' };
  }

  diskBudget(): number | null {
    const g = this.#get<number>('disk_budget_gb');
    return typeof g === 'number' && g > 0 ? g * 1024 ** 3 : null;
  }

  // Decisions go to the local model on the sorting role when it is assigned, unless the person
  // keeps them on the rules.
  decisionsByModel(): boolean {
    return this.#get<string>('decisions') !== 'rules' && this.#sorts();
  }

  // Whether the local model answers a template: once a sorting model is assigned, every template,
  // or (decisions kept on the rules) only those the rules have no rule for, which they couldn't
  // answer anyway (capture's proposals, for one).
  decidesWithModel(hasRule: boolean): boolean {
    return this.#sorts() && (this.#get<string>('decisions') !== 'rules' || !hasRule);
  }

  // A sorting model is assigned, and it is one that runs on the person's devices.
  #sorts(): boolean {
    const p = this.placement('triage-text');
    return !!p && !this.#remote(p.device, p.model) && !(p.hub_model && this.#remote(HUB, p.hub_model));
  }

  #privacy(): PrivacyMode { return this.#o.profile.privacyDefault(); }

  // ---- hardware and the device map -------------------------------------------------------------

  async hubHardware(fresh = false): Promise<Hardware> {
    if (this.#hw && !fresh && Date.now() - this.#hwAt < 10 * 60_000) return this.#hw;
    this.#hw = this.#o.hardware ? await this.#o.hardware() : await detectHardware({ ...(this.#o.diskPath ? { diskPath: this.#o.diskPath } : {}), now: this.#now });
    this.#hwAt = Date.now();
    return this.#hw;
  }

  // Why Nova won't send a computer's runtime anything at this address, or null. Checked when a role
  // is assigned and again before every call and wake: the address must be one the computer's
  // latest heartbeat reports (its addresses move with DHCP and networks), and a private, LAN or
  // mesh one, so a prompt never leaves the person's machines. A host name must resolve only to
  // such addresses.
  async #spokeAddress(device: string, url: string): Promise<string | null> {
    const name = this.#deviceName(device);
    const hw = this.#spokeHardware(device);
    let host: string;
    try { host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return `${url} isn’t an address`; }
    const own = new Set([...(hw?.network ?? []).map((n) => n.address), ...(hw?.hostname ? [hw.hostname, `${hw.hostname}.local`] : [])].map((x) => x.toLowerCase()));
    if (!own.has(host)) return `${host} isn’t one of ${name}’s addresses now${hw ? ` (it reports ${[...own].join(', ') || 'none'})` : ' (it hasn’t reported its hardware yet)'}`;
    const near = (a: string) => privateAddress(a) || this.#o.meshHost?.(a) === true;
    if (/^[\d.]+$/.test(host) || host.includes(':')) return near(host) ? null : `${host} isn’t a private, LAN or mesh address`;
    const found = await lookup(host, { all: true }).catch(() => []);
    if (!found.length) return `${name}’s name ${host} doesn’t resolve to an address`;
    const far = found.find((a) => !near(a.address));
    return far ? `${host} resolves to ${far.address}, which isn’t a private, LAN or mesh address` : null;
  }

  // A paired computer's heartbeat carried its hardware: kept, so the map knows what it can serve
  // and where to send a wake packet.
  heartbeat(device: Device, raw: unknown): void {
    let hw: Hardware;
    try { hw = checkHardware(raw); } catch (e) {
      this.#o.log.warn('models', `${device.name} sent hardware Nova couldn’t read.`, { error: (e as Error).message });
      return;
    }
    this.#o.db.run(
      `INSERT INTO device_hardware (device_id, hardware, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET hardware = excluded.hardware, updated_at = excluded.updated_at`,
      device.id, JSON.stringify(hw), this.#now().toISOString(),
    );
    this.emit('change', { action: 'hardware', device: device.id });
    // A computer that serves a role is back: work waiting on it can run now.
    if (ROLES.some((r) => this.placement(r)?.device === device.id)) void this.check();
  }

  #spokeHardware(id: string): Hardware | null {
    const r = this.#o.db.get<{ hardware: string }>('SELECT hardware FROM device_hardware WHERE device_id = ?', id);
    return r ? JSON.parse(r.hardware) as Hardware : null;
  }

  #spokes(): Device[] {
    return this.#o.devices.list().filter((d) => d.trust === 'trusted' && d.kind === 'computer' && d.role !== 'hub' && !!this.#spokeHardware(d.id));
  }

  #deviceName(id: string): string {
    if (id === HUB) return this.#o.hubName();
    return this.#o.devices.find(id)?.name ?? id;
  }

  // The runtime address a device's models answer at: the hub's setting, or where a role on that
  // device points.
  #urlFor(device: string): string | null {
    if (device === HUB) return this.hubUrl();
    if (!this.#trusted(device)) return null;
    const saved = this.#get<string>(`runtime.${device}`);
    if (str(saved)) return saved!;
    for (const r of ROLES) { const p = this.placement(r); if (p?.device === device) return p.url; }
    return null;
  }

  // What a runtime has, read from it now (a short wait), remembered for when it is asleep.
  async inventory(device: string, o: { timeoutMs?: number } = {}): Promise<Inventory> {
    const url = this.#urlFor(device);
    const at = this.#now().toISOString();
    if (!url) return { ok: false, version: null, models: [], problem: 'Nova doesn’t know where its models answer yet.', at };
    const rt = new Ollama(url);
    let inv: Inventory;
    try {
      const version = await rt.version(AbortSignal.timeout(o.timeoutMs ?? 2500));
      const models = await rt.tags();
      inv = { ok: true, version, models, problem: null, at };
      this.#observe(device, url, models, null);
    } catch (e) {
      const last = this.#inventory.get(device) ?? this.#remembered(device);
      inv = { ok: false, version: last?.version ?? null, models: last?.models ?? [], problem: (e as Error).message, at: last?.at ?? at };
    }
    this.#inventory.set(device, inv);
    return inv;
  }

  // Installed models as Nova last saw them (model_version), for a device that is asleep now.
  #remembered(device: string): Inventory | null {
    const rows = this.#o.db.all<{ name: string; digest: string; size_bytes: number; details: string; last_seen: string }>('SELECT name, digest, size_bytes, details, last_seen FROM model_version WHERE device_id = ? AND removed_at IS NULL', device);
    if (!rows.length) return null;
    return { ok: false, version: null, models: rows.map((r) => ({ ...(JSON.parse(r.details) as InstalledModel), name: r.name, digest: r.digest, size: r.size_bytes })), problem: null, at: rows.map((r) => r.last_seen).sort().at(-1)! };
  }

  // Versions are recorded: each model, by digest, when Nova first and last saw it, and when it
  // went. A new digest under the same name is a new version.
  #observe(device: string, url: string, models: InstalledModel[], taskId: string | null): void {
    // Only a list Nova read itself from the runtime it resolved for that device counts; the
    // verifier trusts these rows.
    if (url !== this.#urlFor(device)) return;
    const at = this.#now().toISOString();
    this.#o.db.tx(() => {
      for (const m of models) {
        this.#o.db.run(
          `INSERT INTO model_version (device_id, runtime_url, name, digest, size_bytes, details, first_seen, last_seen, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (device_id, name, digest) DO UPDATE SET last_seen = excluded.last_seen, size_bytes = excluded.size_bytes, removed_at = NULL, task_id = COALESCE(excluded.task_id, model_version.task_id)`,
          device, url, m.name, m.digest, m.size, JSON.stringify(m), at, at, taskId,
        );
      }
      const present = new Set(models.map((m) => `${m.name}\0${m.digest}`));
      for (const r of this.#o.db.all<{ id: number; name: string; digest: string }>('SELECT id, name, digest FROM model_version WHERE device_id = ? AND removed_at IS NULL', device)) {
        if (!present.has(`${r.name}\0${r.digest}`)) this.#o.db.run('UPDATE model_version SET removed_at = ? WHERE id = ?', at, r.id);
      }
    });
  }

  versions(device = HUB): { name: string; digest: string; size_bytes: number; first_seen: string; last_seen: string; removed_at: string | null; task_id: string | null }[] {
    return this.#o.db.all('SELECT name, digest, size_bytes, first_seen, last_seen, removed_at, task_id FROM model_version WHERE device_id = ? ORDER BY name, first_seen', device);
  }

  async #deviceModels(): Promise<DeviceModels[]> {
    const hub = await this.inventory(HUB);
    const out: DeviceModels[] = [{ id: HUB, name: this.#o.hubName(), hub: true, hardware: await this.hubHardware(), models: hub.ok || hub.models.length ? hub.models : null, url: this.hubUrl() }];
    for (const d of this.#spokes()) {
      const url = this.#urlFor(d.id);
      const inv = url ? await this.inventory(d.id, { timeoutMs: 1200 }) : null;
      out.push({ id: d.id, name: d.name, hub: false, hardware: this.#spokeHardware(d.id), models: inv && (inv.ok || inv.models.length) ? inv.models : null, url });
    }
    return out;
  }

  async recommendation(): Promise<RoleAdvice[]> {
    return recommend(await this.#deviceModels());
  }

  // ---- roles -----------------------------------------------------------------------------------

  async assign(role: unknown, body: Record<string, unknown>): Promise<Placement> {
    if (!ROLES.includes(role as Role)) throw new CoreError('validation', `There is no role called ${String(role)}. Roles are ${ROLES.join(', ')}.`);
    const r = role as Role;
    if (r === 'transcriber') throw new CoreError('conflict', (await this.recommendation()).find((a) => a.role === 'transcriber')!.words);
    const device = str(body.device) || HUB;
    const model = str(body.model);
    if (!model) throw new CoreError('validation', 'model is the installed model to use.');
    let url = this.hubUrl();
    if (device !== HUB) {
      const d = this.#o.devices.find(device);
      if (!d || d.trust !== 'trusted' || d.kind !== 'computer') throw new CoreError('validation', 'device is the hub, or one of your paired computers.');
      url = str(body.url);
      if (!url) throw new CoreError('validation', `url is where ${d.name}’s Ollama answers, like http://<its address>:11434.`);
      const wrong = await this.#spokeAddress(device, url);
      if (wrong) throw new CoreError('validation', `${wrong}.`);
      this.#set(`runtime.${device}`, url);
    }
    const inv = await this.inventory(device);
    if (runsRemotely(model, inv.models.find((m) => m.name === model))) throw new CoreError('validation', cloudWords(model));
    if (!inv.models.some((m) => m.name === model)) {
      throw new CoreError('conflict', inv.ok ? `${this.#deviceName(device)} doesn’t have ${model}. Download it first.` : `Nova can’t check ${this.#deviceName(device)}’s models right now (${inv.problem}), and hasn’t seen ${model} there before.`);
    }
    const p: Placement = { device, runtime: 'ollama', url: device === HUB ? '' : url, model };
    const hubModel = str(body.hub_model);
    if (hubModel && device !== HUB) {
      const hub = await this.inventory(HUB);
      if (runsRemotely(hubModel, hub.models.find((m) => m.name === hubModel))) throw new CoreError('validation', cloudWords(hubModel));
      if (!hub.models.some((m) => m.name === hubModel)) throw new CoreError('conflict', `The hub doesn’t have ${hubModel}.`);
      p.hub_model = hubModel;
    }
    this.#set(`role.${r}`, p);
    this.emit('change', { action: 'assigned', role: r });
    return this.placement(r)!;
  }

  unassign(role: unknown): void {
    if (!ROLES.includes(role as Role)) throw new CoreError('validation', `There is no role called ${String(role)}.`);
    this.#o.db.run(`DELETE FROM profile WHERE section = 'models' AND key = ?`, `role.${role}`);
    this.#o.profile.emit('change', { section: 'models', key: `role.${role}` });
    this.emit('change', { action: 'unassigned', role });
  }

  // Takes the recommendation for every role it can fill from installed models. A role whose best
  // option needs a download, or has no runtime, is left as it is and said.
  async accept(): Promise<{ assigned: Role[]; left: { role: Role; why: string }[] }> {
    const assigned: Role[] = [];
    const left: { role: Role; why: string }[] = [];
    for (const a of await this.recommendation()) {
      if (!a.pick) { left.push({ role: a.role, why: a.words }); continue; }
      if (!a.pick.installed) { left.push({ role: a.role, why: `${a.pick.model} needs downloading first.` }); continue; }
      if (runsRemotely(a.pick.model) || (a.pick.hub_model && runsRemotely(a.pick.hub_model))) { left.push({ role: a.role, why: cloudWords(a.pick.model) }); continue; }
      await this.assign(a.role, { device: a.pick.device, model: a.pick.model, ...(a.pick.url && a.pick.device !== HUB ? { url: a.pick.url } : {}), ...(a.pick.hub_model ? { hub_model: a.pick.hub_model } : {}) });
      assigned.push(a.role);
    }
    return { assigned, left };
  }

  // Whether a role's runtime answers now, in words; null when it does. Never wakes a device.
  async probe(role: Role): Promise<string | null> {
    const p = this.placement(role);
    if (!p) return `No model is assigned to ${ROLE_WORDS[role].name.toLowerCase()} yet (Settings › Models).`;
    try {
      await new Ollama(p.url).version(AbortSignal.timeout(2000));
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  // ---- the inference API ----------------------------------------------------------------------

  async infer(req: InferRequest): Promise<InferResult> {
    if (!ROLES.includes(req.role)) throw new CoreError('validation', `There is no role called ${String(req.role)}.`);
    if (req.role === 'transcriber') throw new CoreError('conflict', 'There is no transcription runtime on your devices, so Nova can’t transcribe. Nothing was sent anywhere.');
    if (req.role === 'embedder' ? req.input === undefined : !Array.isArray(req.messages) || !req.messages.length) {
      throw new CoreError('validation', req.role === 'embedder' ? 'input is the text to embed.' : 'messages is the conversation to answer.');
    }
    // A caller's mode can only tighten the person's setting, never loosen it.
    const mode = req.privacy_mode ? stricter(req.privacy_mode, this.#privacy()) : this.#privacy();
    const cloud = req.role === 'embedder' ? null : this.cloud();
    const order: ('local' | 'cloud')[] = mode === 'local-only' || !cloud ? ['local'] : mode === 'local-preferred' ? ['local', 'cloud'] : ['cloud', 'local'];
    const notes: string[] = [];
    const failed: { where: 'local' | 'cloud'; why: string; budget?: boolean }[] = [];
    // Falling back happens before any output, never after: once text has reached the person, a
    // second model's reply would be spliced onto the first one's half.
    let emitted = false;
    const call: InferRequest = { ...req, ...(req.onText ? { onText: (t: string) => { emitted = true; req.onText!(t); } } : {}) };
    for (const where of order) {
      try {
        const r = where === 'local' ? await this.#local(call, mode, notes) : await this.#cloud(cloud!, call, mode);
        const local = failed.find((f) => f.where === 'local');
        const away = failed.find((f) => f.where === 'cloud');
        if (where === 'cloud' && local) {
          notes.push(`The local ${ROLE_WORDS[req.role].name.toLowerCase()} model wasn’t answering (${local.why.replace(/\.$/, '')}), so ${cloud!.name} answered instead: this went off your devices.`);
          this.#fault(req.role, local.why);
        }
        if (where === 'local' && away) notes.push(away.budget ? `${away.why} So the local model (${r.model}) answered.` : `${cloud!.name} couldn’t be reached, so the local model (${r.model}) answered; the answer may be less thorough.`);
        if (where === 'local') this.#healed(req.role);
        return { ...r, notes };
      } catch (e) {
        if (emitted && (e instanceof LocalDown || e instanceof CloudDown)) {
          throw new CoreError('conflict', `The reply broke off partway (${e.message.replace(/\.$/, '')}). Nova doesn’t switch to another model once a reply has started, so what arrived is all there is; ask again.`);
        }
        if (e instanceof LocalDown) failed.push({ where: 'local', why: e.message });
        else if (e instanceof CloudDown) failed.push({ where: 'cloud', why: e.message });
        else if (e instanceof BudgetBlocked) failed.push({ where: 'cloud', why: e.message, budget: true });
        else throw e;
      }
    }
    const local = failed.find((f) => f.where === 'local');
    const budget = failed.find((f) => f.budget);
    // A role on a computer that didn't come up waits for that computer, and says so: Nova woke it
    // once and won't keep sending wake packets; the work runs when it is heard from again.
    const p = this.placement(req.role);
    const spoke = p && p.device !== HUB ? this.#deviceName(p.device) : null;
    const back = spoke ? `when ${spoke} is on again (Nova won’t keep waking it; turn it on, and the work runs once it checks in)` : 'when the model is back';
    // A model that was assigned and stopped answering is a fault, whatever the mode (M7b's chaos
    // pass): the person sees it with its playbook, not only the work that waits on it.
    if (local && p && !spoke) this.#fault(req.role, local.why);
    const err = local
      ? new ModelsWaiting('capacity', req.role, `Waiting on local capacity: ${local.why.replace(/\.$/, '')}.${mode === 'local-only' ? ` This is local-only, so it stays on your devices and runs ${back}.` : budget ? ` ${budget.why}` : ''}`)
      : new ModelsWaiting(budget ? 'budget' : 'capacity', req.role, budget ? `Waiting on the cloud budget: ${budget.why}` : `Waiting: ${failed.map((f) => f.why).join(' ')}`);
    if (req.task_id) this.#waiting(req.task_id, err);
    throw err;
  }

  // The person's local model: the placement, a spoke woken if it's worth it, the call.
  async #local(req: InferRequest, mode: PrivacyMode, notes: string[]): Promise<Omit<InferResult, 'notes'>> {
    const stored = this.#stored(req.role);
    if (stored && !this.#trusted(stored.device)) throw new LocalDown(`${this.#deviceName(stored.device)} is no longer one of your trusted computers, so Nova sends it nothing`);
    const p = this.placement(req.role);
    if (!p) throw new LocalDown(`no model is assigned to ${ROLE_WORDS[req.role].name.toLowerCase()} yet`);
    if (this.#remote(p.device, p.model)) throw new LocalDown(cloudWords(p.model).replace(/\.$/, ''));
    let device = p.device;
    let url = p.url;
    let model = p.model;
    if (p.device !== HUB) {
      const wrong = await this.#spokeAddress(p.device, p.url);
      if (wrong) throw new LocalDown(wrong);
      const awake = await new Ollama(p.url).version(AbortSignal.timeout(1500)).then(() => true, () => false);
      if (!awake) {
        const name = this.#deviceName(p.device);
        const latency = this.wakeLatency(p.device);
        if (p.hub_model && this.#small(req)) {
          // Small jobs stay on the hub: waking a computer costs more time than the job.
          device = HUB;
          url = this.hubUrl();
          model = p.hub_model;
          notes.push(`${name} is asleep and this was small, so ${model} on the hub answered rather than waking it${latency ? ` (waking takes about ${Math.round(latency / 1000)} s)` : ''}.`);
        } else {
          const w = await this.wake(p.device);
          if (!w.ok) throw new LocalDown(w.words);
          notes.push(w.words);
        }
      }
    }
    // Checked again on every call, whatever was assigned: an Ollama cloud model would take this off
    // the person's devices while the receipt said local.
    if (this.#remote(device, model)) throw new LocalDown(cloudWords(model).replace(/\.$/, ''));
    const rt = new Ollama(url);
    // The receipt names the computer that answered; plain `ollama` is the hub's own runtime.
    const receipt = this.#receipt(req, mode, device === HUB ? 'ollama' : `ollama@${slug(this.#deviceName(device))}`, model, 'local');
    try {
      if (req.role === 'embedder') {
        const e = await rt.embed(model, req.input!);
        return { embeddings: e.embeddings, served_by: 'local', device, model, provider: 'ollama', egress: 'local', receipt_id: receipt, usage: { model, ...(e.tokens_in ? { tokens_in: e.tokens_in } : {}) } };
      }
      const thinks = req.format ? await this.#thinks(device, url, model) : false;
      const out = await rt.chat({ model, messages: req.messages!, ...(req.format ? { format: req.format } : {}), ...(thinks ? { think: false } : {}), ...(req.signal ? { signal: req.signal } : {}), ...(req.onText ? { onText: req.onText } : {}), keepAlive: '5m' });
      return { text: out.text, aborted: out.aborted, served_by: 'local', device, model, provider: 'ollama', egress: 'local', receipt_id: receipt, usage: { model, ...out.usage } };
    } catch (e) {
      if (e instanceof RuntimeDown) throw new LocalDown(e.message);
      throw e;
    }
  }

  // Whether a model reasons before it answers (Ollama's "thinking" capability), from what Nova last
  // read of the runtime, or asked once.
  #capabilities = new Map<string, string[]>();
  async #thinks(device: string, url: string, model: string): Promise<boolean> {
    const key = `${url}\0${model}`;
    let caps = this.#capabilities.get(key) ?? this.#inventory.get(device)?.models.find((m) => m.name === model)?.capabilities;
    if (!caps) caps = (await new Ollama(url).show(model).catch(() => null))?.capabilities ?? [];
    this.#capabilities.set(key, caps);
    return caps.includes('thinking');
  }

  #small(req: InferRequest): boolean {
    const limit = this.#get<number>('small_job_chars') ?? 2000;
    return (req.messages ?? []).reduce((n, m) => n + m.content.length, 0) <= limit;
  }

  async #cloud(c: Cloud, req: InferRequest, mode: PrivacyMode): Promise<Omit<InferResult, 'notes'>> {
    const blocked = this.budgetBlock(req.task_id ?? null, req.max_cost_usd, { cloud: true });
    if (blocked) throw new BudgetBlocked(blocked);
    // What this call can cost at most (its prompt, roughly, and a reply capped at max_tokens) is
    // held against the budget before it is sent, in the same step as the check above, so calls
    // made at once can't all pass a check none of them has paid for yet.
    const maxOut = c.max_tokens ?? DEFAULT_MAX_TOKENS;
    const price = this.#priceOf(c.model);
    const hold = Symbol('reservation');
    const estimate = price ? (Math.ceil(JSON.stringify(req.messages).length / 4) * price.in + maxOut * price.out) / 1e6 : null;
    if (estimate !== null) this.#reserved.set(hold, { task_id: req.task_id ?? null, usd: estimate });
    const egress = cloudEgress(c);
    let out;
    let received = false;
    try {
      // The receipt is written before anything is sent; under local-only it refuses (receipts.ts),
      // a second wall behind the order above.
      const receipt = this.#receipt(req, mode, `cloud:${egress.slice('remote:'.length)}`, c.model, egress);
      try {
        out = await chatMessages({ base_url: c.base_url, model: c.model, ...(c.api_key ? { api_key: c.api_key } : {}), timeout_s: 600 }, this.#o.secret, req.messages!, { ...(req.signal ? { signal: req.signal } : {}), onText: (t) => { received = true; req.onText?.(t); }, json: !!req.format, max_tokens: maxOut });
      } catch (e) {
        // A reply that broke off partway was still made, and may be billed: the reservation is
        // counted as spent, since what was used isn't known.
        if (received) this.#spend({ task_id: req.task_id ?? null, session_id: req.session_id ?? null, provider: egress, model: c.model, tokens_in: null, tokens_out: null, cost_usd: estimate, ref: null });
        throw new CloudDown((e as Error).message);
      }
      const cost = price ? ((out.usage.tokens_in ?? 0) * price.in + (out.usage.tokens_out ?? 0) * price.out) / 1e6 : null;
      this.#spend({ task_id: req.task_id ?? null, session_id: req.session_id ?? null, provider: egress, model: c.model, tokens_in: out.usage.tokens_in ?? null, tokens_out: out.usage.tokens_out ?? null, cost_usd: cost, ref: null });
      return { text: out.text, aborted: out.aborted, served_by: 'cloud', device: c.name, model: c.model, provider: egress, egress, receipt_id: receipt, usage: { ...out.usage, ...(cost !== null ? { cost_usd: cost } : {}) } };
    } finally {
      this.#reserved.delete(hold);
    }
  }

  #receipt(req: InferRequest, mode: PrivacyMode, provider: string, model: string, egress: string): string {
    const items = req.context_items?.length ? req.context_items : [{ kind: 'file' as const, ref: `${req.role} request`, sha256: sha(JSON.stringify(req.messages ?? req.input ?? '')) }];
    return this.#o.receipts.record({
      ...(req.task_id ? { task_id: req.task_id } : {}), ...(req.session_id ? { session_id: req.session_id } : {}),
      provider, model, purpose: req.purpose ?? `${req.role}`, privacy_mode: mode, egress, context_items: items,
    }).id;
  }

  // ---- outages: a problem for the local fault, the person told, waiting work released ----------

  #fault(role: Role, why: string): void {
    if (this.#faults.has(role)) return;
    this.#faults.add(role);
    this.#o.log.problem('models', `The local ${ROLE_WORDS[role].name.toLowerCase()} model isn’t answering (${why.replace(/\.$/, '')}). Work allowed to use the cloud is going there meanwhile; local-only work waits. Check that Ollama is running.`);
    this.#watch();
  }

  #healed(role: Role): void {
    if (this.#faults.delete(role)) this.#o.log.info('models', `The local ${ROLE_WORDS[role].name.toLowerCase()} model answers again.`);
  }

  #waiting(taskId: string, err: ModelsWaiting): void {
    try { this.#o.ledger.note(taskId, 'waiting_on_model', { role: err.role, kind: err.kind, reason: err.message }); } catch { /* not a task Nova knows: a chat */ }
    if (!this.#told.has(taskId)) {
      this.#told.add(taskId);
      let title = 'A task';
      try { title = `“${this.#o.ledger.get(taskId).title}”`; } catch { /* keep the plain words */ }
      this.#o.notify?.(`models-wait:${taskId}`, `${title} is waiting. ${err.message}`);
    }
    this.#watch();
  }

  // While anything waits on capacity or the budget, Nova looks every few seconds whether it can
  // run, and starts it again when it can. It never wakes a device to find out.
  #watch(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.check(); }, this.#o.watchMs ?? 15_000);
    this.#timer.unref();
  }

  // The waiting tasks Nova itself parked (a waiting_on_model note), by role and kind, and whether
  // the model manager parked it (a role it serves) or a provider off the devices did (the budget
  // alone decides when that one runs).
  #waiters(): { task: Task; role: Role; kind: 'capacity' | 'budget'; provider: boolean }[] {
    const out: { task: Task; role: Role; kind: 'capacity' | 'budget'; provider: boolean }[] = [];
    for (const t of this.#o.ledger.list({ state: 'waiting', limit: 500 })) {
      if (!/Waiting on (local capacity|the cloud budget)/.test(t.reason ?? '')) continue;
      const note = this.#o.ledger.events(t.id).filter((e) => e.kind === 'waiting_on_model').at(-1)?.detail as { role?: Role; kind?: 'capacity' | 'budget'; via?: string } | undefined;
      if (note?.role) out.push({ task: t, role: note.role, kind: note.kind ?? 'capacity', provider: note.via === 'provider' });
    }
    return out;
  }

  async check(): Promise<string[]> {
    if (this.#watching) return [];
    this.#watching = true;
    const released: string[] = [];
    try {
      const waiters = this.#waiters();
      const up = new Map<Role, boolean>();
      for (const w of waiters) {
        // Each waits on its own condition only: a provider's budget wait isn't released because the
        // local reasoner is up (it would only run into the budget again), and a role's wait on the
        // budget is released by the budget, or by its local model coming back.
        const budgetOk = () => !this.budgetBlock(w.task.id, w.task.brief.constraints.max_cost_usd, { cloud: !w.provider });
        const roleUp = async () => {
          if (!up.has(w.role)) up.set(w.role, (await this.probe(w.role)) === null);
          return up.get(w.role)!;
        };
        const can = w.provider ? budgetOk() : w.kind === 'budget' ? budgetOk() || await roleUp() : await roleUp();
        if (!can) continue;
        try {
          this.#o.ledger.retry(w.task.id, w.kind === 'budget' ? 'The cloud budget allows it now, so it runs.' : 'Local capacity is back, so it runs now.');
          this.#told.delete(w.task.id);
          released.push(w.task.id);
        } catch { /* it moved on meanwhile */ }
      }
      for (const r of [...this.#faults]) if ((await this.probe(r)) === null) this.#healed(r);
      if (!waiters.length && !this.#faults.size && this.#timer) { clearInterval(this.#timer); this.#timer = null; }
    } finally {
      this.#watching = false;
    }
    return released;
  }

  // After a restart: anything still parked is watched again.
  start(): void {
    if (this.#waiters().length) this.#watch();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // ---- waking a GPU spoke ----------------------------------------------------------------------

  // How long the device took to wake last time it was woken, or null when Nova hasn't seen it.
  wakeLatency(device: string): number | null {
    const r = this.#o.db.get<{ waited_ms: number }>(`SELECT waited_ms FROM device_wake WHERE device_id = ? AND outcome = 'awake' ORDER BY id DESC LIMIT 1`, device);
    return r ? r.waited_ms : null;
  }

  wake(device: string): Promise<WakeResult> {
    const going = this.#waking.get(device);
    if (going) return going;
    const p = this.#wake(device).finally(() => this.#waking.delete(device));
    this.#waking.set(device, p);
    return p;
  }

  async #wake(device: string): Promise<WakeResult> {
    const name = this.#deviceName(device);
    if (device === HUB || !this.#trusted(device)) return { ok: false, waited_ms: 0, limit_ms: 0, words: `${name} isn’t one of your trusted computers, so Nova won’t wake it.` };
    const hw = this.#spokeHardware(device);
    const url = this.#urlFor(device);
    if (!url) return { ok: false, waited_ms: 0, limit_ms: 0, words: `Nova doesn’t know where ${name}’s models answer.` };
    const wrong = await this.#spokeAddress(device, url);
    if (wrong) return { ok: false, waited_ms: 0, limit_ms: 0, words: `Nova won’t wake ${name}: ${wrong}.` };
    let host = '';
    try { host = new URL(url).hostname; } catch { /* checked above */ }
    const nic = hw?.network.find((n) => n.address === host) ?? hw?.network[0];
    if (!nic) return { ok: false, waited_ms: 0, limit_ms: 0, words: `${name} hasn’t told Nova its network card, so Nova can’t wake it. It needs to be on for its heartbeat once.` };
    const w = this.#get<{ target?: string; wait_s?: number }>('wake') ?? {};
    const target = str(w.target) || (nic.broadcast ? `${nic.broadcast}:9` : '255.255.255.255:9');
    // Wake packets stay on the person's network, whatever an older heartbeat or setting says.
    if (!privateAddress(target.split(':')[0]!)) return { ok: false, waited_ms: 0, limit_ms: 0, words: `Nova won’t send a wake packet to ${target}: it isn’t a private or broadcast address on your network.` };
    const measured = this.wakeLatency(device);
    // Honest about latency: wait as long as it took last time, with a margin; never measured,
    // wait the setting (two minutes by default) and say that is a guess.
    const limit = measured !== null ? Math.round(measured * 1.5) + 2000 : (typeof w.wait_s === 'number' && w.wait_s > 0 ? w.wait_s : 120) * 1000;
    const sent = this.#now();
    const started = Date.now();
    try {
      await sendMagic(nic.mac, target);
    } catch (e) {
      this.#o.db.run('INSERT INTO device_wake (device_id, sent_at, outcome) VALUES (?, ?, ?)', device, sent.toISOString(), 'not_sent');
      return { ok: false, waited_ms: 0, limit_ms: limit, words: `Nova couldn’t send the wake packet to ${name}: ${(e as Error).message}.` };
    }
    const id = Number(this.#o.db.get<{ id: number }>(`INSERT INTO device_wake (device_id, sent_at, outcome) VALUES (?, ?, 'waiting') RETURNING id`, device, sent.toISOString())!.id);
    this.emit('change', { action: 'waking', device });
    const rt = new Ollama(url);
    const poll = this.#o.wakePollMs ?? 1000;
    for (;;) {
      const ok = await rt.version(AbortSignal.timeout(Math.min(2000, poll * 2))).then(() => true, () => false);
      const waited = Date.now() - started;
      if (ok) {
        this.#o.db.run(`UPDATE device_wake SET awake_at = ?, waited_ms = ?, outcome = 'awake' WHERE id = ?`, this.#now().toISOString(), waited, id);
        this.emit('change', { action: 'awake', device });
        return { ok: true, waited_ms: waited, limit_ms: limit, words: `Nova woke ${name}; it answered after ${secs(waited)}${measured !== null ? ` (last time ${secs(measured)})` : ''}.` };
      }
      if (waited >= limit) {
        this.#o.db.run(`UPDATE device_wake SET waited_ms = ?, outcome = 'no_answer' WHERE id = ?`, waited, id);
        return {
          ok: false, waited_ms: waited, limit_ms: limit,
          words: measured !== null
            ? `${name} didn’t answer after Nova woke it: it waited ${secs(waited)}, half again what waking took last time (${secs(measured)})`
            : `${name} didn’t answer after Nova woke it: it waited ${secs(waited)}. It has never been woken before, so that wait was a guess`,
        };
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  // ---- cloud budgets ---------------------------------------------------------------------------

  periodStart(p: Period, at = this.#now()): Date {
    const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), p === 'month' ? 1 : at.getUTCDate()));
    if (p === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d;
  }

  // Dollars spent, with usage that came back as tokens and no cost priced from the price table.
  spent(o: { task_id?: string; since?: Date } = {}): number { return this.#usage(o).usd; }

  #usage(o: { task_id?: string; since?: Date }): { usd: number; unpriced: string[] } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.task_id) { where.push('task_id = ?'); args.push(o.task_id); }
    if (o.since) { where.push('at >= ?'); args.push(o.since.toISOString()); }
    const rows = this.#o.db.all<{ model: string; usd: number | null; tin: number; tout: number }>(
      `SELECT model, SUM(cost_usd) AS usd, SUM(CASE WHEN cost_usd IS NULL THEN COALESCE(tokens_in, 0) ELSE 0 END) AS tin, SUM(CASE WHEN cost_usd IS NULL THEN COALESCE(tokens_out, 0) ELSE 0 END) AS tout
       FROM cloud_usage ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY model`, ...args);
    let total = 0;
    const unpriced: string[] = [];
    for (const r of rows) {
      total += r.usd ?? 0;
      if (r.tin + r.tout <= 0) continue;
      const p = this.#priceOf(r.model);
      if (p) total += (r.tin * p.in + r.tout * p.out) / 1e6; else unpriced.push(r.model);
    }
    return { usd: total, unpriced };
  }

  // What a model costs per million tokens: the price table the person keeps, or the cloud model's
  // own price.
  #priceOf(model: string): { in: number; out: number } | null {
    const t = this.#get<Record<string, { usd_per_mtok_in?: unknown; usd_per_mtok_out?: unknown }>>('prices');
    const p = isObj(t) ? t[model] : undefined;
    if (isObj(p) && typeof p.usd_per_mtok_in === 'number' && typeof p.usd_per_mtok_out === 'number') return { in: p.usd_per_mtok_in, out: p.usd_per_mtok_out };
    const c = this.cloud();
    return c && c.model === model && c.usd_per_mtok_in !== undefined && c.usd_per_mtok_out !== undefined ? { in: c.usd_per_mtok_in, out: c.usd_per_mtok_out } : null;
  }

  #reservedUsd(taskId?: string): number {
    let n = 0;
    for (const r of this.#reserved.values()) if (taskId === undefined || r.task_id === taskId) n += r.usd;
    return n;
  }

  // Why the cloud may not be used for this task now, or null. Checked before every cloud call,
  // counting what calls still running may cost at most: a budget can go past its limit by one
  // call's cost at most, never further. `cloud`: the check is for the cloud model itself, which
  // Nova must be able to price; a provider off the devices (a coding agent) reports its own cost.
  budgetBlock(taskId: string | null, maxCost?: number, o: { cloud?: boolean } = {}): string | null {
    const b = this.budget();
    const c = this.cloud();
    const perTask = [b.per_task_usd, maxCost].filter((x): x is number => typeof x === 'number' && x >= 0);
    const limited = perTask.length > 0 || typeof b.per_period_usd === 'number';
    if (limited && o.cloud && c && !this.#priceOf(c.model)) return `Nova can’t tell what ${c.name} costs, so with a budget set it doesn’t use it. Add its price in Settings › Models.`;
    const unpriced = (u: string[]) => `Nova can’t tell what ${u.join(' and ')} cost (it reported tokens but no price), so with a budget set the cloud waits. Nova needs a price for it (PUT /api/v1/models/prices).`;
    if (typeof b.per_period_usd === 'number') {
      const u = this.#usage({ since: this.periodStart(b.period) });
      if (u.unpriced.length) return unpriced(u.unpriced);
      const running = this.#reservedUsd();
      const used = u.usd + running;
      if (used >= b.per_period_usd) return `This ${b.period}’s cloud budget is used: ${usd(used)} of ${usd(b.per_period_usd)}${running ? ', counting calls still running' : ''}.`;
    }
    if (taskId && perTask.length) {
      const cap = Math.min(...perTask);
      const u = this.#usage({ task_id: taskId });
      if (u.unpriced.length) return unpriced(u.unpriced);
      const running = this.#reservedUsd(taskId);
      const used = u.usd + running;
      if (used >= cap) return `This task has used its cloud budget: ${usd(used)} of ${usd(cap)}${running ? ', counting calls still running' : ''}.`;
    }
    return null;
  }

  // Prices per million tokens, by model, for usage that reports tokens but no cost (a provider
  // off the devices, or the cloud model before it was priced).
  setPrices(v: unknown): Record<string, { usd_per_mtok_in: number; usd_per_mtok_out: number }> {
    if (!isObj(v)) throw new CoreError('validation', 'prices is {"<model>": {usd_per_mtok_in, usd_per_mtok_out}}.');
    const out: Record<string, { usd_per_mtok_in: number; usd_per_mtok_out: number }> = {};
    for (const [model, p] of Object.entries(v).slice(0, 200)) {
      const ok = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1e6;
      if (!model.trim() || model.length > 200 || !isObj(p) || !ok(p.usd_per_mtok_in) || !ok(p.usd_per_mtok_out)) throw new CoreError('validation', `${model}: a price is {usd_per_mtok_in, usd_per_mtok_out}, US dollars per million tokens.`);
      out[model] = { usd_per_mtok_in: p.usd_per_mtok_in as number, usd_per_mtok_out: p.usd_per_mtok_out as number };
    }
    this.#set('prices', out);
    this.emit('change', { action: 'prices' });
    void this.check();
    return out;
  }

  #spend(r: { task_id: string | null; session_id: string | null; provider: string; model: string; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null; ref: string | null }): void {
    this.#o.db.run('INSERT INTO cloud_usage (at, task_id, session_id, provider, model, tokens_in, tokens_out, cost_usd, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ref) DO NOTHING',
      this.#now().toISOString(), r.task_id, r.session_id, r.provider, r.model, r.tokens_in, r.tokens_out, r.cost_usd, r.ref);
    if (r.task_id) { try { this.#o.ledger.note(r.task_id, 'cloud_usage', { provider: r.provider, model: r.model, tokens_in: r.tokens_in, tokens_out: r.tokens_out, cost_usd: r.cost_usd }); } catch { /* a chat */ } }
    this.emit('change', { action: 'spent' });
  }

  // A report's usage from a worker that sent the task off the devices (its receipts say remote).
  #trackReport(t: Task): void {
    const u = t.report?.usage;
    if (!u || (u.cost_usd === undefined && u.tokens_in === undefined)) return;
    if (!['done', 'failed', 'waiting'].includes(t.state)) return;
    const remote = this.#o.db.get<{ egress: string }>(`SELECT egress FROM receipt WHERE task_id = ? AND egress LIKE 'remote:%' AND provider NOT LIKE 'cloud:%' ORDER BY at DESC LIMIT 1`, t.id);
    if (!remote) return;
    this.#spend({ task_id: t.id, session_id: null, provider: remote.egress, model: u.model ?? 'unknown', tokens_in: u.tokens_in ?? null, tokens_out: u.tokens_out ?? null, cost_usd: u.cost_usd ?? null, ref: `report:${t.id}:${t.attempts}` });
  }

  // ---- downloads and removal: tier-2 ledger tasks ------------------------------------------------

  // Asks for a download. Refused at once when the disk budget can't take what Nova knows of its size.
  async requestPull(body: Record<string, unknown>): Promise<Task> {
    const model = str(body.model);
    if (!MODEL_NAME.test(model)) throw new CoreError('validation', 'model is the name to download, like nomic-embed-text or qwen3:8b.');
    const device = str(body.device) || HUB;
    const url = this.#urlFor(device);
    if (!url) throw new CoreError('conflict', `Nova doesn’t know where ${this.#deviceName(device)}’s models answer.`);
    const known = CATALOG.find((c) => c.name === model)?.size;
    const digest = str(body.digest).replace(/^sha256:/, '');
    if (digest && !/^[0-9a-f]{64}$/.test(digest)) throw new CoreError('validation', 'digest is the sha256 Nova should expect, 64 hex characters.');
    if (known) {
      const refusal = await this.#diskRefusal(device, known, model);
      if (refusal) throw new CoreError('conflict', refusal);
    }
    const task = this.#o.ledger.create({
      title: `Download ${model}${device === HUB ? '' : ` on ${this.#deviceName(device)}`}`,
      owner: this.worker.id,
      goal: `${model} is installed on ${this.#deviceName(device)}, and Nova has read its digest from the runtime itself.`,
      origin: { kind: 'user' },
      evidence_required: [{ kind: 'confirmation', note: 'the model’s digest, read by Nova from the runtime' }],
      inputs: { action: 'pull', model, device, url, ...(digest ? { digest } : {}), ...(known ? { size: known } : {}) },
      privacy_mode: 'local-only',
      // Downloading takes disk, bandwidth and time: Nova asks first.
      approval_tier: 2,
      user_visibility: 'handling',
    });
    return task;
  }

  async requestRemove(body: Record<string, unknown>): Promise<Task> {
    const model = str(body.model);
    const device = str(body.device) || HUB;
    const url = this.#urlFor(device);
    if (!model || !url) throw new CoreError('validation', 'model is the installed model to remove.');
    const using = this.#inUse(device, model);
    if (using) throw new CoreError('conflict', using);
    return this.#o.ledger.create({
      title: `Remove ${model}${device === HUB ? '' : ` from ${this.#deviceName(device)}`}`,
      owner: this.worker.id,
      goal: `${model} is no longer installed on ${this.#deviceName(device)}, as Nova reads from the runtime itself.`,
      origin: { kind: 'user' },
      evidence_required: [{ kind: 'confirmation', note: 'the runtime no longer lists the model' }],
      inputs: { action: 'remove', model, device, url },
      privacy_mode: 'local-only',
      approval_tier: 2,
      user_visibility: 'handling',
    });
  }

  // Why a model can't be removed: it serves a role. Null when nothing uses it.
  #inUse(device: string, model: string): string | null {
    const using = ROLES.filter((r) => { const p = this.placement(r); return p && ((p.device === device && p.model === model) || (device === HUB && p.hub_model === model)); });
    return using.length ? `${model} serves ${using.map((r) => ROLE_WORDS[r].name.toLowerCase()).join(' and ')}. Assign another model first.` : null;
  }

  async #used(device: string): Promise<number> {
    const inv = await this.inventory(device);
    return inv.models.reduce((n, m) => n + m.size, 0);
  }

  async #diskRefusal(device: string, size: number, model: string): Promise<string | null> {
    const budget = this.diskBudget();
    const used = await this.#used(device);
    if (budget !== null && used + size > budget) return `Refused: ${model} takes about ${gb(size)}, and with the ${gb(used)} your models already use that is past the disk budget of ${gb(budget)}. Raise the budget or remove a model first.`;
    const hw = device === HUB ? await this.hubHardware() : this.#spokeHardware(device);
    if (hw?.disk && size * 1.05 > hw.disk.free_bytes) return `Refused: ${model} takes about ${gb(size)}, and only ${gb(hw.disk.free_bytes)} is free.`;
    return null;
  }

  downloads(): Download[] { return [...this.#downloads.values()]; }

  #makeWorker(): LanedWorker {
    return {
      id: 'models',
      name: 'Model manager',
      about: 'Downloads and removes local models through their runtime, and reads back what it got.',
      // It talks only to the runtime on your devices; Ollama fetches a model from its library
      // itself, and nothing of yours goes with that.
      egress: 'local',
      evidence: ['confirmation'],
      timeoutMs: 12 * 3600_000,
      health: () => ({ ok: true }),
      lane: () => ({ key: 'pull', max: 1 }),
      // Downloading or removing a model takes disk, bandwidth and time, or takes away what a role
      // runs on: it always asks first, whoever made the task (a device, a trigger, the API).
      minTier: () => 2,
      run: (brief, signal) => this.#run(brief, signal),
    };
  }

  async #run(brief: Brief, signal: AbortSignal): Promise<Report> {
    const started = performance.now();
    const i = (brief.inputs ?? {}) as { action?: string; model?: string; device?: string; url?: string; digest?: string; size?: number };
    const report = (status: Report['status'], summary: string, more: Partial<Report> = {}): Report => ({
      envelope: ENVELOPE_VERSION, task_id: brief.task_id, status, summary, evidence: [], artifacts: [], blockers: status === 'blocked' ? [summary] : [], follow_up_suggestions: [],
      ...more, usage: { duration_ms: Math.round(performance.now() - started) },
    });
    const model = str(i.model);
    const device = str(i.device) || HUB;
    // Everything the brief says is checked again here, whoever wrote it: the address is never the
    // brief's (Nova's own runtime for that device is the one asked), the name must be a model name,
    // and the device must still be trusted.
    if (!MODEL_NAME.test(model)) return report('failed', 'The brief doesn’t name a model Nova can download or remove.');
    const url = this.#urlFor(device);
    if (!url) return report('failed', `Nova doesn’t know where ${this.#deviceName(device)}’s models answer, or it isn’t one of your trusted computers.`);
    const rt = new Ollama(url);
    const name = this.#deviceName(device);
    if (i.action === 'remove') {
      // A role may have been assigned to it since the task was asked for.
      const using = this.#inUse(device, model);
      if (using) return report('blocked', using);
      try {
        const had = await rt.remove(model);
        if (!had) return report('failed', `${name} doesn’t have ${model}.`);
      } catch (e) {
        return e instanceof RuntimeDown ? report('blocked', `Waiting on local capacity: ${e.message}`) : report('failed', (e as Error).message);
      }
      // Nova reads the runtime's list itself; the confirmation is checked against that reading.
      const models = await rt.tags().catch(() => null);
      if (!models) return report('failed', `Nova removed ${model} but couldn’t read ${name}’s models back to check.`);
      this.#observe(device, url, models, null);
      this.#o.db.run('UPDATE model_version SET task_id = ? WHERE device_id = ? AND name = ? AND removed_at IS NOT NULL', brief.task_id, device, model);
      this.emit('change', { action: 'removed', model, device });
      return report('done', `Removed ${model} from ${name}.`, { evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `${device}/${model}@removed` }] });
    }
    if (i.action !== 'pull') return report('failed', 'The brief asks for something the model manager doesn’t do.');
    const budget = this.diskBudget();
    let used: number;
    try { used = (await rt.tags()).reduce((n, m) => n + m.size, 0); } catch (e) {
      return e instanceof RuntimeDown ? report('blocked', `Waiting on local capacity: ${e.message}`) : report('failed', (e as Error).message);
    }
    // The size Nova knows from its catalog wins over what a brief says; the budget is checked
    // again mid-download either way, once Ollama says how big the layers are.
    const size = CATALOG.find((c) => c.name === model)?.size ?? (typeof i.size === 'number' && i.size > 0 ? i.size : null);
    if (size !== null) {
      const refusal = await this.#diskRefusal(device, size, model);
      if (refusal) return report('failed', refusal);
    }
    const dl: Download = { task_id: brief.task_id, action: 'pull', model, device, status: 'starting', completed: 0, total: 0, digest: null };
    this.#downloads.set(brief.task_id, dl);
    const layers = new Map<string, { total: number; completed: number }>();
    const stop = new AbortController();
    let refused: string | null = null;
    let last = 0;
    let lastStatus = '';
    try {
      await rt.pull(model, (p) => {
        dl.status = p.status;
        if (p.digest && typeof p.total === 'number') {
          layers.set(p.digest, { total: p.total, completed: p.completed ?? layers.get(p.digest)?.completed ?? 0 });
          dl.total = [...layers.values()].reduce((n, l) => n + l.total, 0);
          dl.completed = [...layers.values()].reduce((n, l) => n + l.completed, 0);
          // The disk budget, as soon as the sizes are known: the download stops, nothing is kept.
          if (budget !== null && used + dl.total > budget && !refused) {
            refused = `Refused: ${model} is at least ${gb(dl.total)}, and with the ${gb(used)} your models already use that is past the disk budget of ${gb(budget)}. Nova stopped the download.`;
            stop.abort();
          }
        }
        // Each new step (a layer, verifying, success) is shown; within one, a few times a second.
        const now = Date.now();
        if (now - last > 150 || p.status !== lastStatus) { last = now; lastStatus = p.status; this.emit('progress', { ...dl }); }
      }, AbortSignal.any([signal, stop.signal]));
    } catch (e) {
      this.#downloads.delete(brief.task_id);
      this.emit('progress', { ...dl, status: refused ? 'refused' : 'failed' });
      if (refused) return report('failed', refused);
      if (signal.aborted) throw e;
      return e instanceof RuntimeDown ? report('blocked', `Waiting on local capacity: ${e.message}`) : report('failed', (e as Error).message);
    }
    // Ollama checked each layer's sha256 as it wrote it. Nova now reads the runtime's own list
    // itself: the model must be there, and its digest is what gets recorded and checked.
    let models: InstalledModel[];
    try { models = await rt.tags(); } catch (e) {
      this.#downloads.delete(brief.task_id);
      return report('failed', `Ollama said ${model} downloaded, but Nova couldn’t read its models back: ${(e as Error).message}`);
    }
    const got = models.find((m) => m.name === model || m.name === `${model}:latest`);
    this.#observe(device, url, models, null);
    this.#downloads.delete(brief.task_id);
    if (!got) { this.emit('progress', { ...dl, status: 'failed' }); return report('failed', `Ollama said ${model} downloaded, but it isn’t in ${name}’s list of models.`); }
    this.#o.db.run('UPDATE model_version SET task_id = ? WHERE device_id = ? AND name = ? AND digest = ?', brief.task_id, device, got.name, got.digest);
    dl.digest = got.digest;
    this.emit('progress', { ...dl, status: 'verified' });
    this.emit('change', { action: 'pulled', model: got.name, device });
    if (i.digest && i.digest !== got.digest) return report('failed', `${got.name} arrived with digest sha256:${got.digest.slice(0, 12)}…, not the sha256:${i.digest.slice(0, 12)}… Nova was told to expect. It is installed but not trusted; remove it or check where it came from.`);
    return report('done', `Downloaded ${got.name} (${gb(got.size)}) to ${name}. Nova read its digest from Ollama itself: sha256:${got.digest.slice(0, 12)}…`, {
      evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `${device}/${got.name}@${got.digest}` }],
      artifacts: [{ kind: 'model', ref: `${device}/${got.name}`, sha256: got.digest }],
    });
  }

  // The verifier's check of a download or removal: against what Nova itself read from the runtime
  // (model_version, written only from Ollama's own list), never the worker's say-so.
  #confirm(e: { kind: string; id?: string }, brief: Brief): { ok: boolean; why: string } {
    const m = /^([^/]+)\/(.+)@(removed|[0-9a-f]{64})$/.exec(e.id ?? '');
    if (!m) return { ok: false, why: 'Not a model confirmation Nova can read.' };
    const [, device, name, digest] = m as unknown as [string, string, string, string];
    const i = (brief.inputs ?? {}) as { action?: string; digest?: string };
    if (digest === 'removed') {
      const still = this.#o.db.get('SELECT 1 FROM model_version WHERE device_id = ? AND name = ? AND removed_at IS NULL', device, name);
      const gone = this.#o.db.get('SELECT 1 FROM model_version WHERE device_id = ? AND name = ? AND removed_at IS NOT NULL AND task_id = ?', device, name, brief.task_id);
      if (i.action !== 'remove') return { ok: false, why: 'This task wasn’t a removal.' };
      return still || !gone ? { ok: false, why: `Nova’s own reading of the runtime still lists ${name}.` } : { ok: true, why: `Nova read the runtime’s list itself after the removal: ${name} isn’t there.` };
    }
    const row = this.#o.db.get<{ last_seen: string }>('SELECT last_seen FROM model_version WHERE device_id = ? AND name = ? AND digest = ? AND removed_at IS NULL AND task_id = ?', device, name, digest, brief.task_id);
    if (!row) return { ok: false, why: `Nova’s own reading of the runtime doesn’t show ${name} with digest ${digest.slice(0, 12)}… for this task.` };
    if (i.digest && i.digest !== digest) return { ok: false, why: `The digest Nova read (${digest.slice(0, 12)}…) isn’t the one expected (${i.digest.slice(0, 12)}…).` };
    return { ok: true, why: `Nova read ${name} from the runtime itself at ${row.last_seen}: digest sha256:${digest.slice(0, 12)}…${i.digest ? ', as expected' : ''}.` };
  }

  // ---- the view --------------------------------------------------------------------------------

  // What the hub's runtime has installed, by name and digest, as last read (scorecard targets).
  installedOnHub(): { name: string; digest: string }[] {
    return (this.#inventory.get(HUB)?.models ?? []).map((m) => ({ name: m.name, digest: m.digest }));
  }

  async view() {
    const advice = await this.recommendation();
    const hubHw = await this.hubHardware();
    const hubInv = this.#inventory.get(HUB)!;
    const deviceView = (id: string, name: string, hub: boolean, hw: Hardware | null, d?: Device) => {
      const inv = this.#inventory.get(id);
      const nic = hw?.network[0];
      const online = hub || (d?.last_seen ? this.#now().getTime() - Date.parse(d.last_seen) < 2 * 60_000 : false);
      const latency = hub ? null : this.wakeLatency(id);
      return {
        id, name, hub, online, hardware: hw, words: hw ? hardwareWords(hw) : 'It hasn’t reported its hardware yet.', capacity: hw ? capacityWords(hw) : '',
        ...(hub ? { decision_model: this.#o.decisionModel?.() ?? null } : {}),
        runtime: inv ? { url: this.#urlFor(id), ok: inv.ok, version: inv.version, models: inv.models.length, problem: inv.problem, words: inv.ok ? `Ollama ${inv.version} · ${inv.models.length} model${inv.models.length === 1 ? '' : 's'}` : `Ollama isn’t answering${inv.problem ? `: ${inv.problem}` : ''}` } : null,
        wake: hub ? null : { mac: nic?.mac ?? null, latency_ms: latency, words: !nic ? 'Can’t be woken: no network card reported.' : latency !== null ? `Wakes in about ${secs(latency)} (measured).` : 'Can be woken; how long it takes isn’t measured yet.' },
      };
    };
    const devices = [deviceView(HUB, this.#o.hubName(), true, hubHw), ...this.#spokes().map((d) => deviceView(d.id, d.name, false, this.#spokeHardware(d.id), d))];
    const roles = await Promise.all(advice.map(async (a) => {
      const p = this.placement(a.role);
      const problem = p ? (this.#inventory.get(p.device)?.models.some((m) => m.name === p.model) === false && this.#inventory.get(p.device)?.ok ? `${p.model} isn’t installed there any more.` : await this.probe(a.role)) : null;
      const recommended = a.pick && !(p && p.device === a.pick.device && p.model === a.pick.model) ? a.pick : null;
      return {
        role: a.role, ...ROLE_WORDS[a.role], assigned: p ? { ...p, device_name: this.#deviceName(p.device) } : null,
        state: a.role === 'transcriber' ? 'no-runtime' : !p ? 'unassigned' : problem ? (p.device !== HUB ? 'asleep' : 'down') : 'ready',
        problem, pick: a.pick, recommended, words: a.words,
      };
    }));
    const budget = this.diskBudget();
    const used = hubInv?.models.reduce((n, m) => n + m.size, 0) ?? 0;
    const cloud = this.cloud();
    const b = this.budget();
    const spentPeriod = this.spent({ since: this.periodStart(b.period) });
    const installed = (hubInv?.models ?? []).map((m) => ({ name: m.name, size: m.size, digest: m.digest, parameter_size: m.parameter_size, capabilities: m.capabilities, serves: ROLES.filter((r) => { const p = this.placement(r); return p && ((p.device === HUB && p.model === m.name) || p.hub_model === m.name); }) }));
    const acceptable = roles.filter((r) => r.recommended?.installed).length;
    // Downloads and removals lately, from the ledger: what waits for an OK, what is running, how
    // each ended, with the digest Nova read.
    const recent = this.#o.ledger.list({ limit: 200 }).filter((t) => t.owner === this.worker.id).slice(0, 6).map((t) => {
      const conf = t.report?.evidence.find((e) => e.kind === 'confirmation') as { id?: string } | undefined;
      const i = (t.brief.inputs ?? {}) as { action?: string; model?: string; size?: number };
      return { id: t.id, title: t.title, state: t.state, reason: t.reason, needs_ok: t.state === 'waiting' && t.approval_tier >= 2 && !t.approved_at, action: i.action ?? null, model: i.model ?? null, size: i.size ?? null, digest: conf?.id?.split('@')[1] ?? null, at: t.updated_at };
    });
    return {
      privacy: this.#privacy(),
      devices,
      roles,
      // The one standout: take the recommendation, when there is one to take.
      standout: acceptable ? 'accept' : null,
      installed,
      downloads: this.downloads(),
      recent,
      disk: { budget_bytes: budget, used_bytes: used, free_bytes: hubHw.disk?.free_bytes ?? null, words: `${gb(used)} used by models${budget !== null ? ` of a ${gb(budget)} budget` : ', no budget set'}${hubHw.disk ? `; ${gb(hubHw.disk.free_bytes)} free on the disk` : ''}.` },
      cloud: {
        configured: !!cloud, name: cloud?.name ?? null, model: cloud?.model ?? null, priced: !!cloud && cloud.usd_per_mtok_in !== undefined && cloud.usd_per_mtok_out !== undefined,
        budget: b, spent_period: spentPeriod,
        words: !cloud ? 'No cloud model is set here.'
          : this.#privacy() === 'local-only' ? `${cloud.name} is set, but your privacy setting is local-only, so it is never used.`
          : `${cloud.name} (${cloud.model}) helps ${this.#privacy() === 'local-preferred' ? 'only when your local models can’t' : 'when Nova chooses it'}. This ${b.period}: ${usd(spentPeriod)}${typeof b.per_period_usd === 'number' ? ` of ${usd(b.per_period_usd)}` : ''}.`,
      },
      decisions: this.decisionsByModel() ? 'model' : 'rules',
    };
  }

  // ---- settings through the API ------------------------------------------------------------------

  // Whether System 1 decisions use the local sorting model (model, the default once one is
  // assigned) or only the rules. PUT /models/decisions with {use} (the core's route, which also
  // takes the Decision Service's settings).
  useForDecisions(use: unknown): void {
    if (use !== 'model' && use !== 'rules') throw new CoreError('validation', 'use is model or rules.');
    this.#set('decisions', use);
  }

  // Where wake packets go (host:port; the device's own broadcast address by default) and how long
  // to wait for a computer never woken before.
  setWake(v: unknown): { target?: string; wait_s?: number } {
    if (!isObj(v)) throw new CoreError('validation', 'wake is {target?, wait_s?}.');
    const out: { target?: string; wait_s?: number } = {};
    if (v.target !== undefined && v.target !== null && v.target !== '') {
      if (typeof v.target !== 'string' || !/^[\d.]+(:\d{1,5})?$/.test(v.target) || !privateAddress(v.target.split(':')[0]!)) throw new CoreError('validation', 'target is where wake packets go: a private or broadcast address on your network and a port, like 192.168.1.255:9.');
      out.target = v.target;
    }
    if (v.wait_s !== undefined && v.wait_s !== null) {
      if (typeof v.wait_s !== 'number' || v.wait_s < 1 || v.wait_s > 900) throw new CoreError('validation', 'wait_s is how long to wait for a computer never woken before, 1 to 900 seconds.');
      out.wait_s = v.wait_s;
    }
    this.#set('wake', out);
    return out;
  }

  setDiskBudget(v: unknown): void {
    if (v !== null && !(typeof v === 'number' && v > 0 && v <= 100_000)) throw new CoreError('validation', 'gb is the most disk models may use, in GB, or null for no budget.');
    this.#set('disk_budget_gb', v);
    this.emit('change', { action: 'disk-budget' });
  }

  setBudget(v: unknown): Budget {
    if (!isObj(v)) throw new CoreError('validation', 'The budget is {per_task_usd?, per_period_usd?, period: day | week | month}.');
    const out: Budget = { period: PERIODS.includes(v.period as Period) ? v.period as Period : 'month' };
    for (const k of ['per_task_usd', 'per_period_usd'] as const) {
      if (v[k] === undefined || v[k] === null) continue;
      if (typeof v[k] !== 'number' || (v[k] as number) < 0 || (v[k] as number) > 1e6) throw new CoreError('validation', `${k} is an amount in US dollars, 0 or more.`);
      out[k] = v[k] as number;
    }
    this.#set('budget', out);
    this.emit('change', { action: 'budget' });
    void this.check();
    return out;
  }

  // The cloud model local-preferred and cloud-allowed work may use. Whatever its address, Nova
  // counts it as the cloud: the person named it as one.
  setCloud(v: unknown, confirm: boolean): Cloud | null {
    if (v === null) {
      this.#o.db.run(`DELETE FROM profile WHERE section = 'models' AND key = 'cloud'`);
      this.emit('change', { action: 'cloud' });
      return null;
    }
    if (!isObj(v)) throw new CoreError('validation', 'The cloud model is {name, base_url, model, api_key?, usd_per_mtok_in?, usd_per_mtok_out?, max_tokens?}.');
    const c: Cloud = { name: str(v.name), base_url: str(v.base_url), model: str(v.model) };
    if (!/^[a-z0-9][a-z0-9 ._-]{0,40}$/i.test(c.name)) throw new CoreError('validation', 'name is what to call it, like "Cloud model".');
    try { const u = new URL(c.base_url); if (!['http:', 'https:'].includes(u.protocol) || u.username) throw new Error(); } catch { throw new CoreError('validation', 'base_url is its OpenAI-compatible address, like https://api.example.com/v1.'); }
    if (!c.model) throw new CoreError('validation', 'model is the model’s name there.');
    if (v.api_key) { if (!/^secret:\/\/[A-Z][A-Z0-9_]*$/.test(String(v.api_key))) throw new CoreError('validation', 'api_key names a secret in the vault, like secret://CLOUD_KEY.'); c.api_key = String(v.api_key); }
    for (const k of ['usd_per_mtok_in', 'usd_per_mtok_out'] as const) {
      if (v[k] === undefined || v[k] === null) continue;
      if (typeof v[k] !== 'number' || (v[k] as number) < 0) throw new CoreError('validation', `${k} is the price per million tokens in US dollars.`);
      c[k] = v[k] as number;
    }
    if (v.max_tokens !== undefined && v.max_tokens !== null) {
      if (!Number.isInteger(v.max_tokens) || (v.max_tokens as number) < 1 || (v.max_tokens as number) > 1_000_000) throw new CoreError('validation', 'max_tokens is the longest reply it may give, in tokens.');
      c.max_tokens = v.max_tokens as number;
    }
    // Where conversations may go is a permission: a new address needs an explicit OK (tier 3).
    const was = this.cloud();
    if ((!was || was.base_url !== c.base_url) && !confirm) throw new CoreError('validation', `Setting a cloud model lets local-preferred and cloud-allowed work go to ${new URL(c.base_url).host}. Send confirm: true to do that.`);
    this.#set('cloud', c);
    this.emit('change', { action: 'cloud' });
    return c;
  }

  routes(): Route[] {
    const view = () => this.view();
    return [
      { method: 'GET', path: '/models', summary: 'The model manager: each device’s hardware and runtime, the role recommendation with reasons, assigned roles, downloads with progress, the disk budget and the cloud budget.', handle: view },
      { method: 'POST', path: '/models/refresh', summary: 'Read the hub’s hardware and every runtime again, now.', handle: async () => { await this.hubHardware(true); await this.#o.refreshed?.().catch(() => {}); return view(); } },
      { method: 'GET', path: '/models/versions', summary: 'Every model version Nova has seen on a device (?device=hub), by digest, with when it was first and last seen and when it went.', handle: ({ query }) => this.versions(query.get('device') ?? HUB) },
      { method: 'POST', path: '/models/roles/accept', summary: 'Assign every role Nova recommends from installed models. Roles needing a download or a runtime are left, and said.', handle: async () => ({ ...(await this.accept()), view: await view() }) },
      { method: 'PUT', path: '/models/roles/{role}', summary: 'Assign a role (triage-text, reasoner, embedder) to an installed model on the hub or a paired computer. A computer’s url must be one of its own addresses; hub_model is what small jobs use while it sleeps.', body: '{model, device?, url?, hub_model?}', handle: async ({ params, body }) => ({ placement: await this.assign(params.role, body), view: await view() }) },
      { method: 'DELETE', path: '/models/roles/{role}', summary: 'Leave a role unassigned.', handle: async ({ params }) => { this.unassign(params.role); return view(); } },
      { method: 'POST', path: '/models/pull', status: 201, summary: 'Download a model (a tier-2 ledger task: it waits for your OK). Refused at once when the disk budget can’t take it. digest: the sha256 to expect, if known.', body: '{model, device?, digest?}', handle: ({ body }) => this.requestPull(body) },
      { method: 'POST', path: '/models/remove', status: 201, summary: 'Remove an installed model (a tier-2 ledger task). A model serving a role must be replaced first.', body: '{model, device?}', handle: ({ body }) => this.requestRemove(body) },
      { method: 'PUT', path: '/models/wake', summary: 'Where Wake-on-LAN packets go (host:port; by default the computer’s own broadcast address) and how long to wait for a computer never woken before (wait_s, 120 by default). After the first wake Nova waits as long as it took, half again, plus 2 s.', body: '{target?, wait_s?}', handle: async ({ body }) => { this.setWake(body); return view(); } },
      { method: 'PUT', path: '/models/disk-budget', summary: 'The most disk models may use, in GB (null for none). Downloads past it are refused.', body: '{gb}', handle: async ({ body }) => { this.setDiskBudget(body.gb); return view(); } },
      { method: 'PUT', path: '/models/budget', summary: 'Cloud budgets: per task and per period (day, week or month), in US dollars. Over budget, work waits with the reason; local stays the default.', body: '{per_task_usd?, per_period_usd?, period}', handle: async ({ body }) => { this.setBudget(body); return view(); } },
      { method: 'PUT', path: '/models/prices', summary: 'Prices per million tokens by model, for cloud usage that reports tokens but no cost (a coding agent off your devices). With a budget set, usage Nova can’t price makes the cloud wait.', body: '{"<model>": {usd_per_mtok_in, usd_per_mtok_out}}', handle: async ({ body }) => { this.setPrices(body); return view(); } },
      { method: 'PUT', path: '/models/cloud', summary: 'The cloud model local-preferred and cloud-allowed work may use when it must (an OpenAI-compatible address; its key in the vault). A new address needs {confirm: true}. {cloud: null} removes it.', body: '{cloud, confirm?}', handle: async ({ body }) => { this.setCloud(body.cloud, body.confirm === true); return view(); } },
      { method: 'POST', path: '/models/devices/{id}/wake', summary: 'Wake a paired computer with a Wake-on-LAN packet and wait for its models, as long as waking took last time.', handle: ({ params }) => this.wake(params.id!) },
      {
        method: 'POST', path: '/models/infer', summary: 'Ask the model serving a role (the internal inference API, for tools and tests): a reply to messages, or embeddings of input. It keeps to the privacy mode: local-only never leaves your devices.', body: '{role, messages? | input?, privacy_mode?, task_id?}',
        handle: async ({ body }) => {
          const r = await this.infer({ role: body.role as Role, ...(Array.isArray(body.messages) ? { messages: body.messages as Message[] } : {}), ...(body.input !== undefined ? { input: body.input as string } : {}), ...(typeof body.privacy_mode === 'string' ? { privacy_mode: body.privacy_mode as PrivacyMode } : {}), ...(typeof body.task_id === 'string' ? { task_id: body.task_id } : {}), purpose: 'asked through the API' });
          return r;
        },
      },
    ];
  }
}

export interface WakeResult { ok: boolean; waited_ms: number; limit_ms: number; words: string }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 48) || 'device';
const cloudWords = (model: string) => `${model} runs in Ollama’s cloud, not on your devices, so it can’t serve a role: what it is given would leave them. Pick a model that runs locally.`;
const secs = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;
const usd = (n: number) => (n > 0 && n < 0.01 ? 'under $0.01' : `$${n.toFixed(2)}`);

export function cloudEgress(c: Cloud): string {
  let host = 'cloud';
  try { host = new URL(c.base_url).hostname; } catch { /* checked when set */ }
  // Loopback means a stand-in in tests; the name the person gave it still says "the cloud".
  const name = LOOPBACK.test(host) ? c.name : host;
  return `remote:${name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64) || 'cloud'}`;
}

export { HEADROOM, type Pick };
