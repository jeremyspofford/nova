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
import { lookup } from 'node:dns/promises';
import { CoreError } from '../errors.ts';
import { isObj, reporter, type Brief, type PrivacyMode, type Report } from '../envelope.ts';
import { stricter } from '../workers.ts';
import { chatMessages } from '../providers/openai.ts';
import { str, type Usage } from '../providers/types.ts';
import { checkHardware, detectHardware, gb, hardwareWords, privateAddress, type Hardware } from './hardware.ts';
import { Ollama, RuntimeDown, runsRemotely, type InstalledModel, type LoadedModel, type Message, type ModelShape } from './ollama.ts';
import { CATALOG, HEADROOM, ROLES, ROLE_WORDS, capacityWords, fitDevice, installedModel, isEmbedder, isText, planCandidates, quantTag, recommend, roleContext, roleFit, type DeviceModels, type Pick, type Role, type RoleAdvice } from './recommend.ts';
import { deviceBudget, fit, learnOverhead, overheadWords, priorOverhead, unifiedBudgetBytes, weightsBytes, type LearnedOverhead, type Quant } from './fit.ts';
import { hubCards, parseTarget, sendMagic, targetOnRoute, wakeRoute, type Card, type RouteRefusal, type Sender, type WakeRoute } from './wake.ts';
import type { Db } from '../db.ts';
import type { Ledger, LanedWorker, Task } from '../ledger.ts';
import type { Log } from '../log.ts';
import type { Profile } from '../profile.ts';
import type { ContextItem, Receipts } from '../receipts.ts';
import type { Verifier } from '../verify.ts';
import type { Devices, Device } from '../mesh/devices.ts';
import type { Route } from '../api.ts';
import { sha256 } from '../workspace.ts';

export { ROLES, ROLE_WORDS, type Role } from './recommend.ts';
export type { Hardware } from './hardware.ts';

export const HUB = 'hub';
export const DEFAULT_OLLAMA = 'http://127.0.0.1:11434';
export const CONFIRMATION_SYSTEM = 'model-runtime';
const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/;
const PERIODS = ['day', 'week', 'month'] as const;
type Period = (typeof PERIODS)[number];

// Where a role runs: a device (the hub, or a paired computer), its runtime's address, and the
// model. A role on a GPU spoke may name a hub model that small jobs use instead of waking it.
// `context` is the context the role runs with (Ollama's num_ctx), when the person set one; otherwise
// the role's planned context (recommend.ts roleContext), the one the fit verdict assumed.
// accepted_tight: the person acknowledged a tight fit when they assigned it (#354); an assignment
// without it that the fit check now calls Tight is flagged on the Models screen, never changed.
export interface Placement { device: string; runtime: 'ollama'; url: string; model: string; hub_model?: string; context?: number; accepted_tight?: true }
export const CONTEXT_MIN = 512;
export const CONTEXT_MAX = 1_048_576;
const okContext = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= CONTEXT_MIN && (v as number) <= CONTEXT_MAX;
// Why a Tight fit waits for the person (the owner, 2026-11-06): Nova never picks one for them.
const TIGHT_WORDS = 'It leaves little memory headroom, so replies may slow down sharply or fail under load. Nova installs or assigns it only once you acknowledge that for this plan (accept_tight: true).';

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
// The local model is on a device that was to be woken and wasn't, or woke and can't run it now, and
// nothing else of the person's could serve: under local-preferred Nova asks before the cloud (the WoL
// ADR's question 3), never falls back silently.
class WakeDown extends LocalDown {
  readonly device: string;
  constructor(device: string, message: string) { super(message); this.device = device; }
}
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
  // The hub's own device id: what its learned overhead is kept under (device_overhead), so a standby
  // that takes over doesn't take the old hub's figure for its own.
  hubId?: () => string;
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
  // The hub's own network cards, which wakes are sent from (the OS's, unless a test hands in its own),
  // what sends a datagram (a UDP socket, unless a test hands in a recorder), and the gap between the
  // three packets of one wake (1 s).
  hubCards?: () => Card[];
  wakeSender?: Sender;
  wakeGapMs?: number;
  // The clock a wake waits by (real time unless a test hands in one that moves when it sleeps), and
  // how long a device that checked in after a wake has for its Ollama to answer (60 s).
  wakeClock?: { now(): number; sleep(ms: number): Promise<void> };
  wakeHealthyMs?: number;
  // The hub's decision model as the Decision Service sees it (DS1 NOTE 4), for the device record.
  decisionModel?: () => { model: string | null; digest: string | null; why: string } | null;
  // Called after /models/refresh has read the hub again, so a newly pulled decision model is seen.
  refreshed?: () => Promise<void>;
  now?: () => Date;
}

interface Inventory { ok: boolean; version: string | null; models: InstalledModel[]; problem: string | null; at: string }
// A download that has passed every check it is refused on at once (#pullCheck).
interface PullSpec { model: string; device: string; url: string; digest: string; known: number | undefined }
interface Download { task_id: string; action: 'pull' | 'remove'; model: string; device: string; status: string; completed: number; total: number; digest: string | null }

// Wake-on-LAN (docs/plans/wol-inference-nodes-adr-2026-11-06.md). Waking is the person's choice per
// device (`power.<device_id>` in the profile's models section), off until they turn it on; the idle
// choices are a fixed list. Rate limits: per device and across the hub, per hour, from any origin.
export const SLEEP_AFTER = [15, 30, 60, 120] as const;
export interface PowerPolicy { on_demand: boolean; sleep_after_min: null | (typeof SLEEP_AFTER)[number] }
export const WAKE_LIMITS = { device: 4, hub: 12, windowMs: 3600_000, maxWaitMs: 300_000, healthyMs: 60_000 } as const;
// A model Nova loaded stays within Ollama's keep-alive this long (#local asks for 5m): the device is
// held awake for it.
const KEEP_ALIVE_MS = 5 * 60_000;
const ONLINE_MS = 2 * 60_000;
export type WakeOrigin = 'routing' | 'person';
export type WakeRefusal = 'not_trusted' | 'not_compute' | 'off' | 'paused' | 'once' | 'rate_limit' | 'rate_limit_hub' | 'address' | 'duplicate_mac' | 'wol_off' | 'target' | RouteRefusal;
const WAKE_CONFIRMATION = 'device-wake';
// What the person's choice is until they make one: never sleep, and wait until it is turned on.
const NO_POLICY: PowerPolicy = { on_demand: false, sleep_after_min: null };

export class Models extends EventEmitter {
  readonly worker: LanedWorker;
  // The person's own wakes (POST /models/devices/{id}/wake), and routing's for work with no task of
  // its own: each is a tier-1 ledger task "Wake ⟨device⟩" that only this module makes.
  readonly wakeWorker: LanedWorker;
  #wakeKey = Symbol('wake');
  #pending = new Map<string, (r: WakeResult) => void>();
  #dupes = new Set<string>();
  // Per device, in memory: when it said it was going to sleep; a wake in flight (since, for which
  // task, the wait's limit); calls running and when the last one ended (`hold`); the model loading
  // after a wake; and what Nova did instead after its last failed wake.
  #asleepAt = new Map<string, string>();
  #inFlight = new Map<string, { since: number; sent: string; title: string | null; mode: PrivacyMode; limit: number; measured: number | null }>();
  #calls = new Map<string, number>();
  #lastUse = new Map<string, number>();
  #loadingAfterWake = new Map<string, { model: string; since: number; title: string | null; words: string }>();
  #instead = new Map<string, string>();
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
    o.verifier.registerConfirmation(WAKE_CONFIRMATION, (e, brief) => this.#confirmWake(e, brief));
    this.worker = this.#makeWorker();
    this.wakeWorker = this.#makeWakeWorker();
    // Cloud usage that came back in a report from a provider that sends off the devices (a coding
    // agent in the cloud) is tracked here too, so the budget sees every dollar.
    // A wake task that ended without running (cancelled, or failed before it could) answers its caller.
    o.ledger.on('task', (t: Task) => {
      this.#trackReport(t);
      if (t.state === 'failed' || t.state === 'cancelled') this.#pending.get(t.id)?.({ ok: false, waited_ms: 0, limit_ms: 0, words: t.reason ?? 'The wake didn’t run.' });
    });
    // Install and assign (the Models screen): a download asked for with a role is assigned once
    // Nova has verified it.
    o.ledger.on('task', (t: Task) => this.#assignAfterPull(t));
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
    if (!(isObj(p) && typeof p.model === 'string' && typeof p.device === 'string')) return null;
    const { context, accepted_tight, ...rest } = p;
    return { ...rest, runtime: 'ollama', url: p.device === HUB ? this.hubUrl() : p.url, ...(okContext(context) ? { context } : {}), ...(accepted_tight === true ? { accepted_tight: true as const } : {}) };
  }

  // The hub, or a paired computer the person still trusts. Checked on every call, not only when a
  // role is assigned: trust can be taken back at any time.
  #trusted(device: string): boolean {
    if (device === HUB) return true;
    const d = this.#o.devices.find(device);
    return !!d && d.trust === 'trusted' && d.kind === 'computer' && d.role !== 'hub';
  }

  // Model work on a paired computer needs its compute role (M10f, the orchestration ADR Point 9:
  // roles bound what may run there). The hub runs Nova and its own local models whatever its roles.
  // Checked on every call, like trust: roles can be narrowed at any time.
  #computes(device: string): boolean {
    if (device === HUB) return true;
    return this.#o.devices.find(device)?.purposes.includes('compute') ?? false;
  }

  #noCompute(device: string): string {
    return `${this.#deviceName(device)} isn’t a compute device, so Nova sends it no model work. Give it the Compute role in Settings › Devices first`;
  }

  // The model roles a paired computer serves now: what taking its compute role away stops.
  rolesOn(device: string): Role[] {
    return ROLES.filter((r) => this.#stored(r)?.device === device);
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
    // A card's MAC that changed is noted in the device's activity: it is what a wake is sent for.
    const was = this.#spokeHardware(device.id)?.network.map((n) => n.mac).sort().join(', ');
    const now = hw.network.map((n) => n.mac).sort().join(', ');
    if (was !== undefined && was !== now) this.#o.log.info('models', `${device.name}’s network cards changed: ${was || 'none'} before, ${now || 'none'} now. Wakes go to the new ones.`, { device: device.id });
    this.#o.db.run(
      `INSERT INTO device_hardware (device_id, hardware, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET hardware = excluded.hardware, updated_at = excluded.updated_at`,
      device.id, JSON.stringify(hw), this.#now().toISOString(),
    );
    this.emit('change', { action: 'hardware', device: device.id });
    // A computer that serves a role is back: work waiting on it can run now.
    if (ROLES.some((r) => this.placement(r)?.device === device.id)) void this.check();
  }

  // What a paired computer last reported about its hardware, or null (placement reads it, M10f).
  hardwareOf(id: string): Hardware | null {
    return this.#spokeHardware(id);
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
    const out: DeviceModels[] = [await this.#deviceModel(HUB)];
    // Only computers that may run model work are recommended for it.
    for (const d of this.#spokes().filter((x) => this.#computes(x.id))) out.push(await this.#deviceModel(d.id));
    return out;
  }

  async #deviceModel(id: string): Promise<DeviceModels> {
    if (id === HUB) {
      const hub = await this.inventory(HUB);
      const hubUrl = this.hubUrl();
      return { id: HUB, name: this.#o.hubName(), hub: true, hardware: await this.hubHardware(), models: hub.ok || hub.models.length ? await this.#withShapes(hubUrl, hub) : null, url: hubUrl, overhead: this.overhead(HUB) };
    }
    const url = this.#urlFor(id);
    const inv = url ? await this.inventory(id, { timeoutMs: 1200 }) : null;
    return { id, name: this.#deviceName(id), hub: false, hardware: this.#spokeHardware(id), models: url && inv && (inv.ok || inv.models.length) ? await this.#withShapes(url, inv) : null, url, overhead: this.overhead(id) };
  }

  // Whether a model may serve a role on a device, by the fit engine: Won't fit never; Tight only with
  // the person's acknowledgement for it (accept_tight); null when it may, or Nova can't tell.
  async #fitRefusal(device: string, model: string, role: Exclude<Role, 'transcriber'>, context: number | undefined, ack: boolean): Promise<string | null> {
    const d = await this.#deviceModel(device);
    const r = roleFit(d, model, role, context);
    if (!r || r.verdict === 'fits' || (r.verdict === 'tight' && ack)) return null;
    return r.verdict === 'wont-fit'
      ? `${model} doesn’t fit on ${d.name}: ${r.words} Nothing was assigned.`
      : `${model} is tight on ${d.name}: ${r.words} ${TIGHT_WORDS} Nothing was assigned.`;
  }

  // ---- model shapes and the learned overhead (model fit) ---------------------------------------

  // Each installed model's shape (/api/show model_info), read once per model version and kept; a
  // runtime that is asleep gets what was read before, or none (the verdict is then an estimate).
  #shapes = new Map<string, { arch: ModelShape | null; max_context: number | null }>();

  async #shape(url: string, m: { name: string; digest: string }, ask = true): Promise<{ arch: ModelShape | null; max_context: number | null } | null> {
    const key = `${url}\0${m.name}\0${m.digest}`;
    const had = this.#shapes.get(key);
    if (had || !ask) return had ?? null;
    const shown = await new Ollama(url).show(m.name).catch(() => null);
    if (!shown) return null;
    const v = { arch: shown.arch, max_context: shown.max_context };
    this.#shapes.set(key, v);
    return v;
  }

  async #withShapes(url: string, inv: Inventory): Promise<InstalledModel[]> {
    const out: InstalledModel[] = [];
    for (const m of inv.models) out.push({ ...m, ...((await this.#shape(url, m, inv.ok)) ?? {}) });
    return out;
  }

  // The key a device's overhead is kept under: its own device id, the hub's too.
  #overheadId(device: string): string { return device === HUB ? (this.#o.hubId?.() ?? HUB) : device; }

  // What Nova learned of a device's runtime overhead from real loads, or the prior.
  overhead(device: string): LearnedOverhead {
    const r = this.#o.db.get<{ learned_bytes: number; samples: number; last_observed_bytes: number | null; updated_at: string }>(
      `SELECT learned_bytes, samples, last_observed_bytes, updated_at FROM device_overhead WHERE device_id = ? AND backend = 'ollama'`, this.#overheadId(device));
    return r ? { bytes: r.learned_bytes, n: r.samples, last_observed: r.last_observed_bytes, updated_at: r.updated_at } : priorOverhead();
  }

  // Loads already learned from, per device: one load counts once, however many calls it serves. A
  // model that leaves /api/ps leaves this too, so its next load counts again. (One that unloads and
  // reloads the same way between two of Nova's reads counts once: an undercount, never a double one.)
  #loads = new Map<string, Set<string>>();
  #learning = new Map<string, Promise<void>>();

  // After a call Nova asked for: what the runtime reports for that load, against the engine's
  // estimate, corrects the device's overhead (fit.ts learnOverhead: fully-on-GPU loads only, 30%
  // toward the reading, 0.25–4 GB, wild readings logged and dropped). Never fails the call; one
  // device's readings are taken in turn, so two replies can't both count the same load.
  async #learnLoad(device: string, url: string, model: string, sent: number): Promise<void> {
    const next = (this.#learning.get(device) ?? Promise.resolve()).then(() => this.#learnOnce(device, url, model, sent)).catch((e) => {
      this.#o.log.warn('models', `Nova couldn’t read what ${this.#deviceName(device)}’s runtime loaded, so nothing was learned from this load.`, { error: (e as Error)?.message ?? String(e) });
    });
    this.#learning.set(device, next);
    await next;
  }

  async #learnOnce(device: string, url: string, model: string, sent: number): Promise<void> {
    const loaded = await new Ollama(url).loaded(AbortSignal.timeout(1500));
    const keyOf = (l: LoadedModel) => [l.name, l.digest, l.size_bytes, l.vram_bytes, l.context].join('\0');
    const seen = this.#loads.get(device) ?? new Set<string>();
    this.#loads.set(device, seen);
    const now = new Set(loaded.map(keyOf));
    for (const k of seen) if (!now.has(k)) seen.delete(k);
    const l = loaded.find((x) => x.name === model || x.name === `${model}:latest`);
    if (!l || l.size_bytes === null || l.vram_bytes === null || seen.has(keyOf(l))) return;
    seen.add(keyOf(l));
    const inst = (this.#inventory.get(device) ?? this.#remembered(device))?.models.find((m) => m.name === model);
    if (!inst || !(inst.size > 0)) return;
    // Without the model's shape the KV estimate is a guess, and a guess would teach the overhead
    // the wrong thing: nothing is learned.
    const arch = (await this.#shape(url, inst))?.arch;
    if (!arch) return;
    const at = this.#now().toISOString();
    const r = learnOverhead(this.overhead(device), { size_bytes: l.size_bytes, size_vram_bytes: l.vram_bytes, weights_bytes: inst.size, context: l.context ?? sent, arch, kv_type: 'f16' }, at,
      (line) => this.#o.log.warn('models', `${this.#deviceName(device)}, ${model}: ${line}`));
    if (r.outcome !== 'learned') return;
    this.#o.db.run(
      `INSERT INTO device_overhead (device_id, backend, learned_bytes, samples, last_observed_bytes, updated_at) VALUES (?, 'ollama', ?, ?, ?, ?)
       ON CONFLICT (device_id, backend) DO UPDATE SET learned_bytes = excluded.learned_bytes, samples = excluded.samples, last_observed_bytes = excluded.last_observed_bytes, updated_at = excluded.updated_at`,
      this.#overheadId(device), r.state.bytes, r.state.n, r.state.last_observed, at,
    );
    this.emit('change', { action: 'overhead', device });
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
    // The context the role runs with, when the person sets one: what chat calls send as num_ctx.
    let context: number | undefined;
    if (body.context !== undefined && body.context !== null) {
      if (r === 'embedder') throw new CoreError('validation', 'context is for the chat roles (sorting, thinking and writing); embeddings use the model’s own.');
      if (!okContext(body.context)) throw new CoreError('validation', `context is how many tokens the role runs with (Ollama’s num_ctx): a whole number from ${CONTEXT_MIN} to ${CONTEXT_MAX.toLocaleString('en-US')}.`);
      context = body.context;
    }
    let url = this.hubUrl();
    if (device !== HUB) {
      const d = this.#o.devices.find(device);
      if (!d || d.trust !== 'trusted' || d.kind !== 'computer') throw new CoreError('validation', 'device is the hub, or one of your paired computers.');
      if (!this.#computes(device)) throw new CoreError('conflict', `${this.#noCompute(device)}.`);
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
    const ack = body.accept_tight === true;
    const refusal = await this.#fitRefusal(device, model, r, context, ack);
    if (refusal) throw new CoreError('conflict', refusal);
    const p: Placement = { device, runtime: 'ollama', url: device === HUB ? '' : url, model, ...(context ? { context } : {}), ...(ack ? { accepted_tight: true as const } : {}) };
    const hubModel = str(body.hub_model);
    if (hubModel && device !== HUB) {
      const hub = await this.inventory(HUB);
      if (runsRemotely(hubModel, hub.models.find((m) => m.name === hubModel))) throw new CoreError('validation', cloudWords(hubModel));
      if (!hub.models.some((m) => m.name === hubModel)) throw new CoreError('conflict', `The hub doesn’t have ${hubModel}.`);
      // The hub model serves the same role's small jobs, so it is fit-checked the same way.
      const hubRefusal = await this.#fitRefusal(HUB, hubModel, r, context, ack);
      if (hubRefusal) throw new CoreError('conflict', hubRefusal);
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
    // The mode is read again right before any remote send (A-001): the person may tighten it while a
    // local attempt is in flight, and a fallback must never go out on the mode the request started with.
    const modeNow = (): PrivacyMode => (req.privacy_mode ? stricter(req.privacy_mode, this.#privacy()) : this.#privacy());
    let mode = modeNow();
    const cloud = req.role === 'embedder' ? null : this.cloud();
    const order: ('local' | 'cloud')[] = mode === 'local-only' || !cloud ? ['local'] : mode === 'local-preferred' ? ['local', 'cloud'] : ['cloud', 'local'];
    const notes: string[] = [];
    const failed: { where: 'local' | 'cloud'; why: string; budget?: boolean }[] = [];
    // Falling back happens before any output, never after: once text has reached the person, a
    // second model's reply would be spliced onto the first one's half.
    let emitted = false;
    const call: InferRequest = { ...req, ...(req.onText ? { onText: (t: string) => { emitted = true; req.onText!(t); } } : {}) };
    // Local first and a wake that failed: Nova asks before the cloud, unless the person already said
    // "this once" for this task.
    let asked: WakeDown | null = null;
    for (const where of order) {
      if (where === 'cloud' && asked) break;
      if (where === 'cloud') {
        // Nothing awaits between this check and the receipt in #cloud, so this is the send-time mode.
        mode = modeNow();
        if (mode === 'local-only') continue;
      }
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
        if (e instanceof WakeDown && mode === 'local-preferred' && !this.#cloudOnce(req.task_id)) asked = e;
        if (e instanceof LocalDown) failed.push({ where: 'local', why: e.message });
        else if (e instanceof CloudDown) failed.push({ where: 'cloud', why: e.message });
        else if (e instanceof BudgetBlocked) failed.push({ where: 'cloud', why: e.message, budget: true });
        else throw e;
      }
    }
    const local = failed.find((f) => f.where === 'local');
    const budget = failed.find((f) => f.budget);
    if (asked && local && cloud) {
      const name = this.#deviceName(asked.device);
      const err = new ModelsWaiting('capacity', req.role, `Waiting on local capacity: ${local.why.replace(/\.$/, '')}. This is local first, so Nova asks before anything goes to the cloud: it waits until ${name} is on, unless you send it to your cloud model this once.`);
      this.#instead.set(asked.device, `This is local first, so Nova asks before anything goes to the cloud: ${this.#taskWords(req.task_id)} waits until ${name} is on, unless you send it to your cloud model this once.`);
      this.emit('change', { action: 'wake-ask', device: asked.device });
      if (req.task_id) this.#waiting(req.task_id, err, { ask_cloud: asked.device });
      throw err;
    }
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
    if (stored && !this.#computes(stored.device)) throw new LocalDown(this.#noCompute(stored.device));
    const p = this.placement(req.role);
    if (!p) throw new LocalDown(`no model is assigned to ${ROLE_WORDS[req.role].name.toLowerCase()} yet`);
    if (this.#remote(p.device, p.model)) throw new LocalDown(cloudWords(p.model).replace(/\.$/, ''));
    let device = p.device;
    let url = p.url;
    let model = p.model;
    let woke = false;
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
          const w = await this.wake(p.device, { origin: 'routing', task_id: req.task_id ?? null });
          // Woke: the fit engine runs again on what it reports now, before anything loads (a game may
          // hold the GPU now). Didn't wake, or no longer fits: another awake device of the person's
          // where the role's model fits (the ADR's question 8: automatically, with a note); else the
          // privacy mode decides, in infer.
          const nofit = w.ok && req.role !== 'embedder' ? await this.#noFitNow(p.device, p.url, p.model, p.context ?? roleContext(req.role as 'triage-text' | 'reasoner')) : null;
          if (w.ok && !nofit) {
            notes.push(w.words);
            woke = true;
          } else {
            const alt = await this.#alternative(req.role, p.device);
            if (!alt) {
              const why = nofit ?? w.words;
              this.#instead.set(p.device, mode === 'local-only' ? `Nothing else that is awake fits ${p.model}. This is local only, so ${this.#taskWords(req.task_id)} waits on your devices and runs once ${name} checks in. Nova won’t keep waking it.` : `Nothing else that is awake fits ${p.model}.`);
              // A device the person chose not to have woken is today's plain local outage.
              throw w.reason === 'off' ? new LocalDown(why) : new WakeDown(p.device, why);
            }
            device = alt.device;
            url = alt.url;
            model = alt.model;
            const said = nofit ? `${nofit.replace(/\.$/, '')}, so ${model} on ${this.#deviceName(device)} answered.` : `${name} didn’t wake, so ${model} on ${this.#deviceName(device)} answered.`;
            notes.push(said);
            this.#instead.set(p.device, said);
          }
        }
      }
    }
    // Checked again on every call, whatever was assigned: an Ollama cloud model would take this off
    // the person's devices while the receipt said local.
    if (this.#remote(device, model)) throw new LocalDown(cloudWords(model).replace(/\.$/, ''));
    const rt = new Ollama(url);
    // The receipt names the computer that answered; plain `ollama` is the hub's own runtime.
    const receipt = this.#receipt(req, mode, device === HUB ? 'ollama' : `ollama@${slug(this.#deviceName(device))}`, model, 'local');
    // While a call runs on a device, and for the model's keep-alive after it, Nova holds it awake.
    this.#calls.set(device, (this.#calls.get(device) ?? 0) + 1);
    const done = () => { this.#loadingAfterWake.delete(device); this.#calls.set(device, Math.max(0, (this.#calls.get(device) ?? 1) - 1)); this.#lastUse.set(device, Date.now()); };
    try {
      if (req.role === 'embedder') {
        const e = await rt.embed(model, req.input!);
        return { embeddings: e.embeddings, served_by: 'local', device, model, provider: 'ollama', egress: 'local', receipt_id: receipt, usage: { model, ...(e.tokens_in ? { tokens_in: e.tokens_in } : {}) } };
      }
      const thinks = req.format ? await this.#thinks(device, url, model) : false;
      // The context the fit verdict assumed is the one asked for, so the verdict describes what runs.
      const numCtx = p.context ?? roleContext(req.role as 'triage-text' | 'reasoner');
      // Just woken: "Loading ⟨model⟩" until the first token.
      if (woke) {
        this.#loadingAfterWake.set(device, { model, since: Date.now(), title: req.task_id ? this.#taskWords(req.task_id) : null, words: notes.at(-1) ?? '' });
        this.emit('change', { action: 'loading', device });
      }
      const onText = (t: string) => { if (this.#loadingAfterWake.delete(device)) this.emit('change', { action: 'loaded', device }); req.onText?.(t); };
      const out = await rt.chat({ model, messages: req.messages!, ...(req.format ? { format: req.format } : {}), ...(thinks ? { think: false } : {}), numCtx, ...(req.signal ? { signal: req.signal } : {}), ...(req.onText || woke ? { onText } : {}), keepAlive: '5m' });
      if (!out.aborted) await this.#learnLoad(device, url, model, numCtx);
      return { text: out.text, aborted: out.aborted, served_by: 'local', device, model, provider: 'ollama', egress: 'local', receipt_id: receipt, usage: { model, ...out.usage } };
    } catch (e) {
      if (e instanceof RuntimeDown) throw new LocalDown(e.message);
      throw e;
    } finally {
      done();
    }
  }

  // Step 6 of the wake path: why the model can't run on a device that just woke, by the fit engine on
  // the hardware it reports now (what else holds its memory counted), or null when it fits.
  async #noFitNow(device: string, url: string, model: string, context: number): Promise<string | null> {
    const hw = this.#spokeHardware(device);
    const m = (this.#inventory.get(device) ?? this.#remembered(device))?.models.find((x) => x.name === model);
    if (!hw || !m) return null;
    const shaped = { ...m, ...((await this.#shape(url, m)) ?? {}) };
    const fm = { ...installedModel(shaped, 'reasoner'), context };
    const dev = deviceBudget(hw, { overhead: this.overhead(device) });
    if (fit({ device: dev, models: [fm] }).verdict !== 'wont-fit') return null;
    const other = dev.other_use_known && dev.other_use_bytes > 0 ? `${gb(dev.other_use_bytes)} of its ${dev.memory === 'gpu' ? 'video ' : ''}memory is in use by other programs now, so ` : '';
    return `${this.#deviceName(device)} woke, but ${other}${model} at ${fm.quant} with ${Math.round(context / 1024)}k context doesn’t fit.`;
  }

  // Fallback rule 1: another awake device of the person's (the hub included) with an installed model
  // for the role whose verdict is Fits or Tight, whose runtime answers now. Never one that runs off
  // the devices.
  async #alternative(role: Role, skip: string): Promise<{ device: string; url: string; model: string } | null> {
    if (role === 'transcriber') return null;
    const dms = (await this.#deviceModels()).filter((d) => d.id !== skip && !!d.models && this.#online(d.id));
    const pick = recommend(dms).find((a) => a.role === role)?.pick;
    if (!pick?.installed || !pick.url || !pick.fit || pick.fit.verdict === 'wont-fit' || this.#remote(pick.device, pick.model)) return null;
    if (pick.device !== HUB && await this.#spokeAddress(pick.device, pick.url)) return null;
    const up = await new Ollama(pick.url).version(AbortSignal.timeout(1500)).then(() => true, () => false);
    return up ? { device: pick.device, url: pick.url, model: pick.model } : null;
  }

  // Heard from within the Online window, and not since it said it was going to sleep.
  #online(id: string): boolean {
    if (id === HUB) return true;
    if (this.#asleepAt.has(id)) return false;
    const seen = this.#o.devices.find(id)?.last_seen;
    return !!seen && this.#now().getTime() - Date.parse(seen) < ONLINE_MS;
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
    const items = req.context_items?.length ? req.context_items : [{ kind: 'file' as const, ref: `${req.role} request`, sha256: sha256(JSON.stringify(req.messages ?? req.input ?? '')) }];
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

  #waiting(taskId: string, err: ModelsWaiting, extra: Record<string, unknown> = {}): void {
    try { this.#o.ledger.note(taskId, 'waiting_on_model', { role: err.role, kind: err.kind, reason: err.message, ...extra }); } catch { /* not a task Nova knows: a chat */ }
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
  // `ask`: the device whose failed wake made a local-first task ask before the cloud.
  #waiters(): { task: Task; role: Role; kind: 'capacity' | 'budget'; provider: boolean; ask: string | null }[] {
    const out: { task: Task; role: Role; kind: 'capacity' | 'budget'; provider: boolean; ask: string | null }[] = [];
    for (const t of this.#o.ledger.list({ state: 'waiting', limit: 500 })) {
      if (!/Waiting on (local capacity|the cloud budget)/.test(t.reason ?? '')) continue;
      const note = this.#o.ledger.events(t.id).filter((e) => e.kind === 'waiting_on_model').at(-1)?.detail as { role?: Role; kind?: 'capacity' | 'budget'; via?: string; ask_cloud?: string } | undefined;
      if (note?.role) out.push({ task: t, role: note.role, kind: note.kind ?? 'capacity', provider: note.via === 'provider', ask: typeof note.ask_cloud === 'string' ? note.ask_cloud : null });
    }
    return out;
  }

  // The person said "Use the cloud model this once" for this task.
  #cloudOnce(taskId: string | undefined): boolean {
    if (!taskId) return false;
    try { return this.#o.ledger.events(taskId).some((e) => e.kind === 'cloud_once'); } catch { return false; }
  }

  // POST /models/devices/{id}/cloud-once: each local-first task waiting on this device's failed wake
  // goes to the cloud model this once, as the person said; it is recorded on the task.
  cloudOnce(device: string): { released: string[] } {
    if (!this.cloud()) throw new CoreError('conflict', 'No cloud model is set, so there is nothing to send it to.');
    const released: string[] = [];
    for (const w of this.#waiters().filter((x) => x.ask === device)) {
      try {
        this.#o.ledger.note(w.task.id, 'cloud_once', { device, by: 'person' });
        this.#o.ledger.retry(w.task.id, 'You said to use the cloud model this once, so it runs there.');
        released.push(w.task.id);
      } catch { /* it moved on meanwhile */ }
    }
    if (!released.length) throw new CoreError('conflict', `Nothing is waiting on ${this.#deviceName(device)} for your answer.`);
    this.#instead.delete(device);
    this.emit('change', { action: 'cloud-once', device });
    return { released };
  }

  // A task's title in quotes, for what the screen says; "The task" when there is none.
  #taskWords(taskId: string | null | undefined): string {
    if (!taskId) return 'the work';
    try { return `“${this.#o.ledger.get(taskId).title}”`; } catch { return 'the work'; }
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
    this.#firstRunPower();
    if (this.#waiters().length) this.#watch();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // ---- waking a compute device (docs/plans/wol-inference-nodes-adr-2026-11-06.md) ---------------

  // How long the device took to wake last time it was woken, or null when Nova hasn't seen it.
  wakeLatency(device: string): number | null {
    const r = this.#o.db.get<{ waited_ms: number }>(`SELECT waited_ms FROM device_wake WHERE device_id = ? AND outcome = 'awake' ORDER BY id DESC LIMIT 1`, device);
    return r ? r.waited_ms : null;
  }

  // The person's sleep and wake choices for a device, or the default: Nova never sleeps it, and wakes
  // it only once they turn waking on.
  power(device: string): PowerPolicy {
    const p = this.#get<Record<string, unknown>>(`power.${device}`);
    if (!isObj(p)) return { ...NO_POLICY };
    return { on_demand: p.on_demand === true, sleep_after_min: SLEEP_AFTER.includes(p.sleep_after_min as never) ? p.sleep_after_min as PowerPolicy['sleep_after_min'] : null };
  }

  // PUT /models/devices/{id}/power (the person scope, tier 1: reversible, and nothing leaves the
  // devices). Either choice may be sent alone; each is one of a fixed list.
  setPower(device: string, v: unknown): PowerPolicy {
    if (device === HUB || !this.#trusted(device)) throw new CoreError('not_found', `${this.#deviceName(device)} isn’t one of your trusted computers.`);
    if (!isObj(v)) throw new CoreError('validation', 'The sleep and wake choices are {on_demand?: true | false, sleep_after_min?: null | 15 | 30 | 60 | 120}.');
    const out = this.power(device);
    if (v.on_demand !== undefined) {
      if (typeof v.on_demand !== 'boolean') throw new CoreError('validation', 'on_demand is true (Nova wakes it when work needs it) or false (wait until it’s turned on).');
      out.on_demand = v.on_demand;
    }
    if (v.sleep_after_min !== undefined) {
      if (!(v.sleep_after_min === null || SLEEP_AFTER.includes(v.sleep_after_min as never))) throw new CoreError('validation', 'sleep_after_min is null (never sleep) or 15, 30, 60 or 120 minutes.');
      out.sleep_after_min = v.sleep_after_min as PowerPolicy['sleep_after_min'];
    }
    this.#set(`power.${device}`, out);
    this.emit('change', { action: 'power', device });
    return out;
  }

  // The sleep policy's other half (the ADR's "Who enforces it"): what a computer's heartbeat is
  // answered with. Its own policy only, and `hold` while Nova has work running or queued for it, a
  // model it loaded is still within its keep-alive, or a native service is placed there. A heartbeat
  // with going_to_sleep says it is about to suspend, so it shows asleep at once.
  powerAnswer(device: Device, body: Record<string, unknown>): { sleep_after_min: PowerPolicy['sleep_after_min']; hold: boolean } {
    if (body.going_to_sleep === true) this.#asleepAt.set(device.id, this.#now().toISOString());
    else if (this.#asleepAt.delete(device.id)) this.emit('change', { action: 'awake', device: device.id });
    if (body.going_to_sleep === true) this.emit('change', { action: 'asleep', device: device.id });
    return { sleep_after_min: this.power(device.id).sleep_after_min, hold: this.holds(device.id) };
  }

  holds(device: string): boolean {
    if ((this.#calls.get(device) ?? 0) > 0 || this.#waking.has(device)) return true;
    if (Date.now() - (this.#lastUse.get(device) ?? -Infinity) < KEEP_ALIVE_MS) return true;
    const roles = this.rolesOn(device);
    if (roles.length && this.#waiters().some((w) => w.kind === 'capacity' && roles.includes(w.role))) return true;
    return !!this.#o.db.get(`SELECT 1 FROM device_workload WHERE device_id = ? AND want != 'stopped'`, device);
  }

  // Waking became opt-in with this build (the owner's answer to the ADR's question 5). So that a
  // device Nova already wakes for work keeps working, the first run turns waking on for each trusted
  // computer that serves a role and that Nova has sent a wake before (the owner's Dell); every other
  // device waits for the person's choice. It needs no marker: since this build every wake that is
  // sent needs a choice the person made (a `power.<id>`), so a device with a sent wake and no choice
  // can only be one from before it, and a choice once made (on or off) is never overwritten.
  #firstRunPower(): void {
    for (const d of this.#spokes()) {
      if (this.#get(`power.${d.id}`) !== undefined || !this.rolesOn(d.id).length) continue;
      if (!this.#o.db.get(`SELECT 1 FROM device_wake WHERE device_id = ? AND outcome != 'refused'`, d.id)) continue;
      this.#set(`power.${d.id}`, { on_demand: true, sleep_after_min: null });
      this.#o.log.info('models', `Waking is now your choice for each device. ${d.name} serves a model role and Nova has woken it before, so it stays on: Nova wakes it when work needs it (Settings › Models, “Sleep and wake”).`);
    }
  }

  // Paused: the last wake sent to it failed, and it hasn't been heard from since. Routing doesn't wake
  // it again until then; the person still can ("Try waking it again").
  #paused(device: string): boolean {
    const last = this.#o.db.get<{ sent_at: string; outcome: string }>(`SELECT sent_at, outcome FROM device_wake WHERE device_id = ? AND outcome NOT IN ('refused', 'waiting') ORDER BY id DESC LIMIT 1`, device);
    if (!last || last.outcome === 'awake') return false;
    const seen = this.#o.devices.find(device)?.last_seen;
    return !seen || Date.parse(seen) < Date.parse(last.sent_at);
  }

  // The rate limits, counted from the durable (and replicated) wake table: wakes that were sent, from
  // any origin, in the last hour. When one is reached, when the oldest of them leaves the hour.
  #rateLimit(device: string): { reason: 'rate_limit' | 'rate_limit_hub'; at: Date } | null {
    const since = new Date(this.#now().getTime() - WAKE_LIMITS.windowMs).toISOString();
    const sent = `outcome NOT IN ('refused', 'not_sent') AND sent_at > ?`;
    const mine = this.#o.db.all<{ sent_at: string }>(`SELECT sent_at FROM device_wake WHERE device_id = ? AND ${sent} ORDER BY sent_at`, device, since);
    if (mine.length >= WAKE_LIMITS.device) return { reason: 'rate_limit', at: new Date(Date.parse(mine[mine.length - WAKE_LIMITS.device]!.sent_at) + WAKE_LIMITS.windowMs) };
    const all = this.#o.db.all<{ sent_at: string }>(`SELECT sent_at FROM device_wake WHERE ${sent} ORDER BY sent_at`, since);
    if (all.length >= WAKE_LIMITS.hub) return { reason: 'rate_limit_hub', at: new Date(Date.parse(all[all.length - WAKE_LIMITS.hub]!.sent_at) + WAKE_LIMITS.windowMs) };
    return null;
  }

  // Another trusted computer that reports one of these MACs: then neither is woken until one changes,
  // since a wake for one would wake the other. Said once as a problem.
  #sharedMac(device: string, macs: string[]): { other: string; mac: string } | null {
    for (const d of this.#spokes()) {
      if (d.id === device) continue;
      const mac = this.#spokeHardware(d.id)?.network.find((n) => macs.includes(n.mac))?.mac;
      if (!mac) continue;
      const key = [device, d.id].sort().join('|') + mac;
      if (!this.#dupes.has(key)) {
        this.#dupes.add(key);
        this.#o.log.problem('models', `${this.#deviceName(device)} and ${d.name} both report the network card ${mac}, so Nova wakes neither until one of them changes. Check which machine that card is in.`);
      }
      return { other: d.name, mac };
    }
    return null;
  }

  // Every check a wake must pass before anything is sent (the ADR's step 1), in order: trusted ·
  // compute · the person's opt-in · not paused · once per task · rate limits · where its models
  // answer · its cards (a MAC no other device claims, Wake-on-LAN not off) · a hub card on its own
  // network (the same-network test) · the person's own target, if set, on that network.
  async #wakeCheck(device: string, origin: WakeOrigin, taskId: string | null): Promise<
    { ok: true; route: WakeRoute; mac: string; url: string; target: string } | { ok: false; reason: WakeRefusal; words: string; retry_at?: string }> {
    const name = this.#deviceName(device);
    const no = (reason: WakeRefusal, words: string, retry?: Date) => ({ ok: false as const, reason, words, ...(retry ? { retry_at: retry.toISOString() } : {}) });
    if (device === HUB || !this.#trusted(device)) return no('not_trusted', `${name} isn’t one of your trusted computers, so Nova won’t wake it.`);
    if (!this.#computes(device)) return no('not_compute', `${this.#noCompute(device)}.`);
    if (!this.power(device).on_demand) return no('off', `Nova doesn’t wake ${name}: you chose to wait until it’s turned on (Settings › Models, “Sleep and wake”).`);
    if (origin === 'routing' && this.#paused(device)) return no('paused', `Nova woke ${name} and it didn’t come up, so it won’t wake it again by itself until ${name} is heard from. You can try waking it again.`);
    if (origin === 'routing' && taskId && this.#o.ledger.events(taskId).some((e) => e.kind === 'wake' && (e.detail as { outcome?: string } | null)?.outcome !== 'refused')) {
      return no('once', `Nova already woke ${name} once for this task and won’t keep waking it.`);
    }
    const limit = this.#rateLimit(device);
    if (limit) {
      const at = limit.at.toTimeString().slice(0, 5);
      return no(limit.reason, limit.reason === 'rate_limit'
        ? `Nova has woken ${name} ${WAKE_LIMITS.device} times this hour; it can try again at ${at}.`
        : `Nova has sent ${WAKE_LIMITS.hub} wakes this hour across your devices; it can try again at ${at}.`, limit.at);
    }
    const url = this.#urlFor(device);
    if (!url) return no('address', `Nova doesn’t know where ${name}’s models answer.`);
    const wrong = await this.#spokeAddress(device, url);
    if (wrong) return no('address', `Nova won’t wake ${name}: ${wrong}.`);
    const cards = this.#spokeHardware(device)?.network ?? [];
    if (!cards.length) return no('no_card', `${name} hasn’t told Nova its network card, so Nova can’t wake it. It needs to be on for its heartbeat once.`);
    const shared = this.#sharedMac(device, cards.map((c) => c.mac));
    if (shared) return no('duplicate_mac', `${name} and ${shared.other} both report the network card ${shared.mac}, so Nova wakes neither until one of them changes.`);
    const able = cards.filter((c) => c.wol !== 'off');
    if (!able.length) return no('wol_off', `${name}’s network card has Wake-on-LAN turned off, so Nova can’t wake it. Turn it on in its BIOS or network settings.`);
    let host = '';
    try { host = new URL(url).hostname; } catch { /* checked above */ }
    const r = wakeRoute((this.#o.hubCards ?? hubCards)(), able, (a) => this.#o.meshHost?.(a) === true, host);
    if (!r.ok) {
      return no(r.reason, {
        no_card: `${name} hasn’t told Nova its network card, so Nova can’t wake it.`,
        not_private: `None of ${name}’s network cards is on a private network Nova can send a wake signal on.`,
        mesh: `${name} reports only its mesh address, and Nova doesn’t send wake signals over your mesh.`,
        netmask: `${name}’s network card reports a netmask that is too broad, or not a netmask, so Nova won’t send a wake signal on it: only on a home network from /16 to /30.`,
        no_sender: 'None of your always-on devices is on its network, so nothing can send the wake signal. Nova doesn’t send wake signals across networks or over your mesh.',
      }[r.reason]);
    }
    // The person's own target, if set, must be on that same network; otherwise it is refused for this
    // device (Nova never falls back to 255.255.255.255).
    const w = this.#get<{ target?: string }>('wake') ?? {};
    let target = `${r.route.target}:${r.route.port}`;
    if (str(w.target)) {
      const t = parseTarget(str(w.target));
      if (!targetOnRoute(t.host, r.route)) return no('target', `The wake target you set (${w.target}) isn’t on ${name}’s network, so Nova won’t send its wake there.`);
      target = `${t.host}:${t.port}`;
    }
    return { ok: true, route: r.route, mac: r.route.card.mac!, url, target };
  }

  // Wakes a device, or says why not. `origin`: routing (work routed to its role) or the person.
  // Routing's wake for a task is an event on that task; the person's wake, and routing's for work
  // with no task of its own, is a tier-1 task "Wake ⟨device⟩" (refused routing ones without a task go
  // to the wake table and the activity log). One wake per device at a time.
  wake(device: string, o: { origin?: WakeOrigin; task_id?: string | null } = {}): Promise<WakeResult> {
    const going = this.#waking.get(device);
    if (going) return going;
    const origin = o.origin ?? 'routing';
    const run = async (): Promise<WakeResult> => {
      if (o.task_id) return this.#wakeNow(device, origin, o.task_id);
      if (origin === 'routing') {
        const c = await this.#wakeCheck(device, origin, null);
        if (!c.ok) return this.#refused(device, origin, null, c);
      }
      return this.#wakeTask(device, origin);
    };
    const p = run().finally(() => this.#waking.delete(device));
    this.#waking.set(device, p);
    return p;
  }

  #record(device: string, origin: WakeOrigin, outcome: string, at: Date, more: { sender?: string | null; reason?: string | null } = {}): number {
    return Number(this.#o.db.get<{ id: number }>(
      'INSERT INTO device_wake (device_id, sent_at, outcome, origin, sender, reason) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      device, at.toISOString(), outcome, origin, more.sender ?? null, more.reason ?? null,
    )!.id);
  }

  #ledgerWake(taskId: string | null, detail: Record<string, unknown>): void {
    if (taskId) try { this.#o.ledger.note(taskId, 'wake', detail); } catch { /* not a task Nova knows */ }
  }

  #refused(device: string, origin: WakeOrigin, taskId: string | null, c: { reason: WakeRefusal; words: string; retry_at?: string }): WakeResult {
    this.#record(device, origin, 'refused', this.#now(), { reason: c.reason });
    this.#ledgerWake(taskId, { device, origin, sender: null, target: null, outcome: 'refused', reason: c.reason, words: c.words, waited_ms: 0 });
    if (!taskId) this.#o.log.info('models', `No wake sent: ${c.words}`, { device, origin, reason: c.reason });
    this.emit('change', { action: 'wake-refused', device });
    return { ok: false, waited_ms: 0, limit_ms: 0, words: c.words, reason: c.reason, ...(c.retry_at ? { retry_at: c.retry_at } : {}) };
  }

  async #wakeNow(device: string, origin: WakeOrigin, taskId: string | null): Promise<WakeResult> {
    const name = this.#deviceName(device);
    const c = await this.#wakeCheck(device, origin, taskId);
    if (!c.ok) return this.#refused(device, origin, taskId, c);
    const w = this.#get<{ wait_s?: number }>('wake') ?? {};
    const measured = this.wakeLatency(device);
    // Honest about latency: wait as long as it took last time, with a margin; never measured, wait the
    // setting (two minutes by default) and say that is a guess. Never more than five minutes.
    const limit = Math.min(WAKE_LIMITS.maxWaitMs, measured !== null ? Math.round(measured * 1.5) + 2000 : (typeof w.wait_s === 'number' && w.wait_s > 0 ? w.wait_s : 120) * 1000);
    const sent = this.#now();
    const clock = this.#o.wakeClock ?? { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
    const started = clock.now();
    const base = { device, origin, sender: HUB, card: c.route.sender.name ?? c.route.bind, target: c.target };
    try {
      await sendMagic(c.mac, c.target, { bind: c.route.bind, count: 3, gapMs: this.#o.wakeGapMs ?? 1000, ...(this.#o.wakeSender ? { sender: this.#o.wakeSender } : {}) });
    } catch (e) {
      const why = (e as Error).message;
      this.#record(device, origin, 'not_sent', sent, { sender: HUB, reason: why });
      this.#ledgerWake(taskId, { ...base, outcome: 'not_sent', reason: why, waited_ms: 0 });
      return { ok: false, waited_ms: 0, limit_ms: limit, words: `Nova couldn’t send the wake signal to ${name}: ${why}.`, reason: 'not_sent' };
    }
    const id = this.#record(device, origin, 'waiting', sent, { sender: HUB });
    let mode = this.#privacy();
    try { if (taskId) mode = this.#o.ledger.get(taskId).privacy_mode; } catch { /* not a task Nova knows */ }
    this.#inFlight.set(device, { since: Date.now(), sent: sent.toISOString(), title: taskId ? this.#taskWords(taskId) : null, mode, limit, measured });
    this.#instead.delete(device);
    this.emit('change', { action: 'waking', device });
    try {
      return await this.#waitAwake(device, id, c.url, taskId, base, { started, limit, measured, sent, clock });
    } finally {
      this.#inFlight.delete(device);
    }
  }

  // Steps 4 and 5 of the wake path: poll every second for (a) the device's heartbeat and (b) its
  // Ollama, up to the wake limit; a heartbeat without Ollama for a minute is "woke, unhealthy".
  async #waitAwake(device: string, id: number, url: string, taskId: string | null, base: Record<string, unknown>,
    o: { started: number; limit: number; measured: number | null; sent: Date; clock: { now(): number; sleep(ms: number): Promise<void> } }): Promise<WakeResult> {
    const { started, limit, measured, sent, clock } = o;
    const name = this.#deviceName(device);
    const rt = new Ollama(url);
    const poll = this.#o.wakePollMs ?? 1000;
    const healthy = this.#o.wakeHealthyMs ?? WAKE_LIMITS.healthyMs;
    let heardAt: number | null = null;
    for (;;) {
      const ok = await rt.version(AbortSignal.timeout(Math.min(2000, poll * 2))).then(() => true, () => false);
      const waited = clock.now() - started;
      const seen = this.#o.devices.find(device)?.last_seen;
      if (heardAt === null && seen && Date.parse(seen) > sent.getTime() && !this.#asleepAt.has(device)) heardAt = clock.now();
      if (ok) {
        this.#o.db.run(`UPDATE device_wake SET awake_at = ?, waited_ms = ?, outcome = 'awake' WHERE id = ?`, this.#now().toISOString(), waited, id);
        this.#ledgerWake(taskId, { ...base, outcome: 'awake', waited_ms: waited });
        this.emit('change', { action: 'awake', device });
        return { ok: true, waited_ms: waited, limit_ms: limit, wake_id: id, words: `Nova woke ${name}; it answered after ${secs(waited)}${measured !== null ? ` (last time ${secs(measured)})` : ''}.` };
      }
      if (heardAt !== null && clock.now() - heardAt >= healthy) {
        const woke = heardAt - started;
        const words = `${name} woke after ${secs(woke)} and its device agent checked in, but Ollama didn’t answer in the minute after.`;
        this.#o.db.run(`UPDATE device_wake SET waited_ms = ?, outcome = 'unhealthy', reason = 'unhealthy' WHERE id = ?`, woke, id);
        this.#ledgerWake(taskId, { ...base, outcome: 'unhealthy', waited_ms: waited });
        this.#o.log.problem('models', `${words} Check that Ollama starts with ${name} (its service is enabled), then try again; Nova won’t wake it again for the task that was waiting.`);
        this.emit('change', { action: 'wake-failed', device });
        return { ok: false, waited_ms: waited, limit_ms: limit, reason: 'unhealthy', words };
      }
      if (heardAt === null && waited >= limit) {
        this.#o.db.run(`UPDATE device_wake SET waited_ms = ?, outcome = 'no_answer', reason = 'no_answer' WHERE id = ?`, waited, id);
        this.#ledgerWake(taskId, { ...base, outcome: 'no_answer', waited_ms: waited });
        this.emit('change', { action: 'wake-failed', device });
        return {
          ok: false, waited_ms: waited, limit_ms: limit, reason: 'no_answer',
          words: measured !== null
            ? `${name} didn’t answer after Nova woke it: it waited ${secs(waited)}, half again what waking took last time (${secs(measured)})`
            : `${name} didn’t answer after Nova woke it: it waited ${secs(waited)}. It has never been woken before, so that wait was a guess`,
        };
      }
      await clock.sleep(poll);
    }
  }

  // A tier-1 task "Wake ⟨device⟩" that the wake worker runs, and its result once it has run.
  #wakeTask(device: string, origin: WakeOrigin): Promise<WakeResult> {
    const name = this.#deviceName(device);
    const t = this.#o.ledger.create({
      title: `Wake ${name}`,
      owner: this.wakeWorker.id,
      goal: `${name} is awake and its models answer.`,
      origin: origin === 'person' ? { kind: 'user' } : { kind: 'trigger', ref: 'model-routing' },
      evidence_required: [{ kind: 'confirmation', note: 'the device’s models answered after the wake, as Nova read them itself' }],
      inputs: { action: 'wake', device, origin },
      privacy_mode: 'local-only',
      // Waking is reversible and sends nothing of the person's anywhere (the ADR's question 4).
      approval_tier: 1,
      user_visibility: 'handling',
    }, { as: this.#wakeKey });
    return new Promise((resolve) => {
      this.#pending.set(t.id, (r) => { this.#pending.delete(t.id); resolve({ ...r, task_id: t.id }); });
    });
  }

  #makeWakeWorker(): LanedWorker {
    return {
      id: 'wake',
      name: 'Wake-on-LAN',
      about: 'Wakes one of your compute devices with a Wake-on-LAN signal on its own network, and waits for its models to answer.',
      egress: 'local',
      evidence: ['confirmation'],
      timeoutMs: WAKE_LIMITS.maxWaitMs + 60_000,
      health: () => ({ ok: true }),
      lane: () => ({ key: 'wake', max: 4 }),
      internal: { key: this.#wakeKey, why: 'Only Nova’s model manager makes wake tasks. Wake a computer with POST /models/devices/{id}/wake.' },
      run: async (brief) => {
        const report = reporter(brief);
        const i = (brief.inputs ?? {}) as { device?: string; origin?: string };
        const r = await this.#wakeNow(str(i.device), i.origin === 'person' ? 'person' : 'routing', brief.task_id);
        this.#pending.get(brief.task_id)?.(r);
        return r.ok ? report('done', r.words, { evidence: [{ kind: 'confirmation', system: WAKE_CONFIRMATION, id: String(r.wake_id) }] }) : report('blocked', r.words);
      },
    };
  }

  // The verifier's check of a wake task: Nova's own record that this device's models answered.
  #confirmWake(e: { kind: string; id?: string }, brief: Brief): { ok: boolean; why: string } {
    const row = this.#o.db.get<{ device_id: string; outcome: string; waited_ms: number | null }>('SELECT device_id, outcome, waited_ms FROM device_wake WHERE id = ?', Number(e.id));
    const device = str((brief.inputs as { device?: string } | undefined)?.device);
    if (!row || row.device_id !== device) return { ok: false, why: 'Nova has no record of that wake for this device.' };
    return row.outcome === 'awake' ? { ok: true, why: `Nova read ${this.#deviceName(device)}’s models answering ${secs(row.waited_ms ?? 0)} after the wake.` } : { ok: false, why: `Nova’s record says the wake ended ${row.outcome}.` };
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
    if (limited && o.cloud && c && !this.#priceOf(c.model)) return `Nova can’t tell what ${c.name} costs, so with a budget set it doesn’t use it. Nova needs its price per million tokens, and no screen in Nova takes one yet: it is added through Nova’s API.`;
    const unpriced = (u: string[]) => `Nova can’t tell what ${u.join(' and ')} cost (it reported tokens but no price), so with a budget set the cloud waits. Nova needs its price per million tokens, and no screen in Nova takes one yet: it is added through Nova’s API.`;
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
    return this.#queuePull(await this.#pullCheck(body), null);
  }

  // Every check a download is refused on at once, with nothing changed: the name, the device, where
  // its models answer, the digest, and the disk budget and free disk for what Nova knows of its size.
  // `size` is never read from a request: only installPlan (below) passes it, from its own plan.
  async #pullCheck(body: Record<string, unknown>, size?: number | null): Promise<PullSpec> {
    const model = str(body.model);
    if (!MODEL_NAME.test(model)) throw new CoreError('validation', 'model is the name to download, like nomic-embed-text or qwen3:8b.');
    const device = str(body.device) || HUB;
    if (!this.#computes(device)) throw new CoreError('conflict', `${this.#noCompute(device)}.`);
    const url = this.#urlFor(device);
    if (!url) throw new CoreError('conflict', `Nova doesn’t know where ${this.#deviceName(device)}’s models answer.`);
    const known = CATALOG.find((c) => c.name === model)?.size ?? size ?? undefined;
    const digest = str(body.digest).replace(/^sha256:/, '');
    if (digest && !/^[0-9a-f]{64}$/.test(digest)) throw new CoreError('validation', 'digest is the sha256 Nova should expect, 64 hex characters.');
    if (known) {
      const refusal = await this.#diskRefusal(device, known, model);
      if (refusal) throw new CoreError('conflict', refusal);
    }
    return { model, device, url, digest, known };
  }

  // Makes the download task for a request #pullCheck has passed. `assign` is installPlan's role.
  #queuePull({ model, device, url, digest, known }: PullSpec, assign: { role: Role; context: number | null; accept_tight?: true } | null): Task {
    const task = this.#o.ledger.create({
      title: `Download ${model}${device === HUB ? '' : ` on ${this.#deviceName(device)}`}`,
      owner: this.worker.id,
      goal: `${model} is installed on ${this.#deviceName(device)}, and Nova has read its digest from the runtime itself.`,
      origin: { kind: 'user' },
      evidence_required: [{ kind: 'confirmation', note: 'the model’s digest, read by Nova from the runtime' }],
      inputs: { action: 'pull', model, device, url, ...(digest ? { digest } : {}), ...(known ? { size: known } : {}), ...(assign ? { assign } : {}) },
      privacy_mode: 'local-only',
      // Downloading takes disk, bandwidth and time: Nova asks first.
      approval_tier: 2,
      user_visibility: 'handling',
    });
    return task;
  }

  // Install and assign (the per-device Models screen, model-fit step 3): a planned set of models for
  // one device, each with its quant and context and, if it serves one, its role. Checked here, at the
  // API's edge: the device must be one that may run model work, every model one Nova lists for it
  // (installed there, or in its catalog), never one that runs off the person's devices, each role
  // once, and the set must fit the device together (the fit engine, overhead and reserve counted
  // once; a Tight set only with accept_tight, the person's acknowledgement). Nothing is loosened: an installed model is assigned now, exactly as PUT
  // /models/roles/{role} does; every download is the same tier-2 task POST /models/pull makes, which
  // waits for the person's OK, and its role is assigned only once Nova has verified the download.
  // A plan refused on any of these, or on a check a download is refused on at once (the disk
  // budget, for each download and for all of them together with those already pending on the
  // device), changes nothing: they all run before the first role is assigned.
  // A step that fails after that says what had already changed.
  async installPlan(body: Record<string, unknown>): Promise<{ device: string; assigned: { role: Role; model: string }[]; tasks: { id: string; title: string; model: string; role: Role | null; size: number | null; state: string }[]; words: string }> {
    const device = str(body.device) || HUB;
    if (device !== HUB && !this.#trusted(device)) throw new CoreError('validation', 'device is the hub, or one of your paired computers.');
    if (!this.#computes(device)) throw new CoreError('conflict', `${this.#noCompute(device)}.`);
    const name = this.#deviceName(device);
    const plan = body.plan;
    if (!Array.isArray(plan) || plan.length < 1 || plan.length > 4) throw new CoreError('validation', 'plan is what to put on the device: 1 to 4 of {model, quant, context?, role?}.');
    const dm = (await this.#deviceModels()).find((d) => d.id === device);
    if (!dm?.hardware) throw new CoreError('conflict', `Nova doesn’t know ${name}’s hardware yet, so it can’t check that the plan fits.`);
    // Local candidates only, whatever the privacy mode: nothing that runs elsewhere is installed.
    const candidates = planCandidates(dm, { privacy: 'local-only', cloud: null }).filter((c) => c.where === 'local');
    const ROLE_OK = ['triage-text', 'reasoner', 'embedder'] as const;
    const items = plan.map((raw, i) => {
      if (!isObj(raw)) throw new CoreError('validation', `plan[${i}] is {model, quant, context?, role?}.`);
      const model = str(raw.model);
      const c = candidates.find((x) => x.name === model);
      if (!c) throw new CoreError('validation', `plan[${i}].model: ${model || 'nothing'} isn’t a model Nova lists for ${name}. Pick one from the screen’s list.`);
      if (!c.quants.includes(raw.quant as Quant)) throw new CoreError('validation', `plan[${i}].quant is one of ${c.quants.join(', ')} for ${model}.`);
      const quant = raw.quant as Quant;
      let role: Role | null = null;
      if (raw.role !== undefined && raw.role !== null) {
        if (!ROLE_OK.includes(raw.role as (typeof ROLE_OK)[number])) throw new CoreError('validation', `plan[${i}].role is one of ${ROLE_OK.join(', ')}, or null.`);
        role = raw.role as Role;
        const asModel = { name: c.name, capabilities: c.capabilities } as InstalledModel;
        if (role === 'embedder' ? !isEmbedder(asModel) : !isText(asModel)) throw new CoreError('validation', `plan[${i}]: ${model} can’t serve ${ROLE_WORDS[role].name.toLowerCase()}.`);
      }
      const own = c.max_context ?? null;
      let context: number;
      if (raw.context === undefined || raw.context === null) {
        if (!own && role !== 'embedder') throw new CoreError('validation', `plan[${i}].context is how many tokens it runs with, ${CONTEXT_MIN} to ${CONTEXT_MAX.toLocaleString('en-US')}.`);
        context = own ?? 2048;
      } else {
        if (!okContext(raw.context)) throw new CoreError('validation', `plan[${i}].context is how many tokens it runs with: a whole number from ${CONTEXT_MIN} to ${CONTEXT_MAX.toLocaleString('en-US')}.`);
        context = raw.context;
      }
      const installed = !!c.installed && c.installed.quant === quant;
      return { c, quant, role, context, installed, model: installed ? c.name : quantTag(c.name, quant, c.default_quant) };
    });
    const roles = items.map((x) => x.role).filter((r): r is Role => r !== null);
    if (new Set(roles).size !== roles.length) throw new CoreError('validation', 'Each role can be given to one model of the plan.');
    if (new Set(items.map((x) => x.model)).size !== items.length) throw new CoreError('validation', 'The plan names the same model twice.');
    const r = fit({
      device: fitDevice(dm.hardware, dm.overhead),
      models: items.map((x) => ({ name: x.model, params: x.c.params, weights_bytes: x.installed ? x.c.installed!.weights_bytes : null, quant: x.quant, context: x.context, arch: x.c.arch, arch_source: x.c.arch_source, kv_type: 'f16' })),
    });
    if (r.verdict === 'wont-fit') throw new CoreError('conflict', `That plan doesn’t fit on ${name}: ${r.words} Nothing was installed or assigned.`);
    // Tight, only with the person's acknowledgement for this plan. The verdict for the whole plan
    // covers each model in it: overhead and reserve count once, so no one model needs more than all.
    const ack = body.accept_tight === true;
    if (r.verdict === 'tight' && !ack) throw new CoreError('conflict', `That plan is tight on ${name}: ${r.words} ${TIGHT_WORDS} Nothing was installed or assigned.`);
    // Every download passes POST /models/pull's own checks (the disk budget among them) before
    // anything changes, so a plan refused here assigns nothing and makes no task.
    const pulls = [];
    for (const x of items.filter((y) => !y.installed)) {
      const size = x.c.default_quant === x.quant && x.c.size ? x.c.size : weightsBytes(x.c.params, x.quant);
      pulls.push({ x, size, spec: await this.#pullCheck({ model: x.model, device }, size) });
    }
    // Then all of them together, with the downloads already waiting or under way on the device.
    const together = await this.#planDiskRefusal(device, pulls.map((p) => ({ model: p.spec.model, size: p.spec.known ?? 0 })));
    if (together) throw new CoreError('conflict', together);
    const url = device === HUB ? undefined : this.#urlFor(device) ?? undefined;
    const assigned: { role: Role; model: string }[] = [];
    const tasks: { id: string; title: string; model: string; role: Role | null; size: number | null; state: string }[] = [];
    try {
      for (const x of items.filter((y) => y.installed && y.role)) {
        await this.assign(x.role, { device, model: x.model, ...(url ? { url } : {}), ...(x.role === 'embedder' ? {} : { context: x.context }), ...(ack ? { accept_tight: true } : {}) });
        assigned.push({ role: x.role!, model: x.model });
      }
      for (const { x, size, spec } of pulls) {
        const t = this.#queuePull(spec, x.role ? { role: x.role, context: x.role === 'embedder' ? null : x.context, ...(ack ? { accept_tight: true } : {}) } : null);
        tasks.push({ id: t.id, title: t.title, model: x.model, role: x.role, size, state: t.state });
      }
    } catch (e) {
      if (!assigned.length && !tasks.length) throw e;
      // Something failed after the plan began to change: say what already changed, never "nothing".
      const done = [...assigned.map((a) => `${a.model} serves ${ROLE_WORDS[a.role].name.toLowerCase()}`), ...tasks.map((t) => `a download of ${t.model} waits for your OK`)].join('; ');
      const why = e instanceof CoreError ? e.message : 'Something went wrong inside Nova.';
      if (!(e instanceof CoreError)) this.#o.log.warn('models', 'Install and assign stopped part way.', { error: (e as Error).message });
      throw new CoreError(e instanceof CoreError ? e.code : 'conflict', `${why} The plan was applied only in part: ${done}. The rest wasn’t.`);
    }
    const words = [
      assigned.length ? `${assigned.map((a) => `${a.model} serves ${ROLE_WORDS[a.role].name.toLowerCase()}`).join('; ')} now.` : '',
      tasks.length ? `${tasks.length === 1 ? 'One download waits' : `${tasks.length} downloads wait`} for your OK; ${tasks.some((t) => t.role) ? 'each is assigned once Nova has checked it arrived.' : 'nothing is assigned until you choose.'}` : '',
    ].filter(Boolean).join(' ') || 'Nothing to change: the plan is installed, and serves no role yet.';
    return { device, assigned, tasks, words };
  }

  // A download asked for with a role (installPlan) is assigned once the task is done, which is after
  // the verifier has checked Nova's own reading of the runtime. Once per task.
  #afterPull = new Set<string>();
  #assignAfterPull(t: Task): void {
    if (t.owner !== this.worker.id || t.state !== 'done' || this.#afterPull.has(t.id)) return;
    const i = (t.brief.inputs ?? {}) as { action?: string; model?: string; device?: string; assign?: { role?: Role; context?: number | null; accept_tight?: boolean } };
    if (i.action !== 'pull' || !isObj(i.assign) || !i.assign.role) return;
    this.#afterPull.add(t.id);
    const device = str(i.device) || HUB;
    const role = i.assign.role;
    const context = i.assign.context;
    void (async () => {
      const inv = await this.inventory(device);
      const model = str(i.model);
      const got = inv.models.find((m) => m.name === model)?.name ?? inv.models.find((m) => m.name === `${model}:latest`)?.name ?? model;
      const url = device === HUB ? null : this.#urlFor(device);
      // The person's acknowledgement of a tight plan carries through to the assignment it asked for.
      await this.assign(role, { device, model: got, ...(url ? { url } : {}), ...(context ? { context } : {}), ...(i.assign!.accept_tight === true ? { accept_tight: true } : {}) });
      this.#o.log.info('models', `${got} is downloaded and checked, so it now serves ${ROLE_WORDS[role].name.toLowerCase()} on ${this.#deviceName(device)}.`);
    })().catch((e) => this.#o.log.warn('models', `Nova downloaded ${i.model} but couldn’t give it its role.`, { error: (e as Error).message }));
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

  // The downloads asked for on a device that haven't arrived yet: waiting for the OK, queued or under
  // way (a verifying one is already in the runtime's list, so in #used). Sized as the worker sizes
  // them; one whose size Nova doesn't know counts nothing here, and is checked when it runs.
  #pendingPulls(device: string): { n: number; bytes: number } {
    let n = 0;
    let bytes = 0;
    for (const state of ['queued', 'active', 'waiting'] as const) {
      for (const t of this.#o.ledger.list({ state, limit: 500 })) {
        const i = (t.brief.inputs ?? {}) as { action?: string; model?: string; device?: string; size?: unknown };
        if (t.owner !== this.worker.id || i.action !== 'pull' || (str(i.device) || HUB) !== device) continue;
        n++;
        bytes += CATALOG.find((c) => c.name === i.model)?.size ?? (typeof i.size === 'number' && i.size > 0 ? i.size : 0);
      }
    }
    return { n, bytes };
  }

  // installPlan's check of its downloads together, with those already pending on the device, against
  // the disk budget and free disk. Each download alone has passed #diskRefusal already.
  async #planDiskRefusal(device: string, downloads: { model: string; size: number }[]): Promise<string | null> {
    const pending = this.#pendingPulls(device);
    if (!downloads.length || (downloads.length < 2 && !pending.n)) return null;
    const plan = downloads.reduce((n, d) => n + d.size, 0);
    const total = plan + pending.bytes;
    const names = downloads.length === 1 ? downloads[0]!.model : `${downloads.slice(0, -1).map((d) => d.model).join(', ')} and ${downloads.at(-1)!.model}`;
    const what = `${names} ${downloads.length === 1 ? 'takes' : 'take'} about ${gb(plan)}${downloads.length > 1 ? ' together' : ''}${pending.n ? `, and ${pending.n === 1 ? 'a download' : `${pending.n} downloads`} already waiting or under way about ${gb(pending.bytes)}, ${gb(total)} in all` : ''}`;
    const budget = this.diskBudget();
    const used = await this.#used(device);
    if (budget !== null && used + total > budget) return `Refused: ${what}. With the ${gb(used)} your models already use that is past the disk budget of ${gb(budget)}. Raise the budget, plan fewer downloads, or remove a model first. Nothing was installed or assigned.`;
    const hw = device === HUB ? await this.hubHardware() : this.#spokeHardware(device);
    if (hw?.disk && total * 1.05 > hw.disk.free_bytes) return `Refused: ${what}, and only ${gb(hw.disk.free_bytes)} is free. Nothing was installed or assigned.`;
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
    const report = reporter(brief);
    const i = (brief.inputs ?? {}) as { action?: string; model?: string; device?: string; url?: string; digest?: string; size?: number };
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
    // Checked again when it runs: the computer's roles may have been narrowed since it was asked.
    if (!this.#computes(device)) return report('failed', `${this.#noCompute(device)}.`);
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

  // What the per-device Models screen plans with (model-fit step 3): the device's learned overhead,
  // what its runtime has loaded now (with the memory each load takes), the models it can plan (its
  // installed ones, then the catalog; privacy first, see planCandidates), the roles it serves, and
  // how old its hardware reading and model list are, for a device that sleeps. Null for a computer
  // that may not run model work. The screen runs the same fit engine in the browser.
  async #planView(id: string, dm: DeviceModels | undefined, hardwareAt: string | null) {
    if (!dm) return null;
    const inv = this.#inventory.get(id);
    const url = this.#urlFor(id);
    const loaded: LoadedModel[] = url && inv?.ok ? await new Ollama(url).loaded(AbortSignal.timeout(1200)).catch(() => []) : [];
    const cloud = this.cloud();
    return {
      overhead: this.overhead(id),
      candidates: planCandidates(dm, { privacy: this.#privacy(), cloud: cloud ? cloud.name : null }),
      loaded: loaded.map((l) => ({ name: l.name, size_bytes: l.size_bytes, vram_bytes: l.vram_bytes, context: l.context })),
      roles: ROLES.flatMap((r) => { const p = this.placement(r); return p && p.device === id ? [{ role: r, model: p.model, context: p.context ?? null }] : []; }),
      models_at: inv?.at ?? null, models_live: !!inv?.ok, hardware_at: hardwareAt,
    };
  }

  // A computer's wake state, derived here from what the hub knows (never reported by the device), and
  // what the per-device Models screen shows for it: the approved styleguide states (components.js
  // wakeStatus and sleepPolicy). `screen`: {state, pill, lines, waiting?: {text, since}, actions?,
  // policy: {idle, demand, notes}}; `since` is an ISO time the page turns into its waiting line.
  #wakeState(id: string, online: boolean, can: Awaited<ReturnType<Models['wakeCheckFor']>>, latency: number | null): { state: 'awake' | 'asleep-wakeable' | 'asleep' | 'waking' | 'woke-loading' | 'wake-failed'; screen: WakeScreen } {
    const name = this.#deviceName(id);
    const hubName = this.#o.hubName();
    const p = this.power(id);
    const agentSleeps = this.#o.devices.find(id)?.capabilities.includes('power') ?? false;
    const notes = [
      agentSleeps ? `${name}’s own device agent puts it to sleep once nothing of Nova’s has run there for that long and no one is using it. Nova keeps it awake while work runs.`
        : 'Its device agent can’t put it to sleep yet; the OS’s own power settings decide. Nova can still wake it.',
      can.ok || !['no_sender', 'mesh', 'netmask'].includes(can.reason) ? `${hubName} wakes it with a signal on their shared network, and only there: never across the internet or over your mesh.`
        : 'Nova can wake it only from an always-on device of yours on the same network, like the hub at home.',
    ];
    const policy = { idle: p.sleep_after_min === null ? 'never' : String(p.sleep_after_min), demand: p.on_demand ? 'wake' : 'wait', notes };
    const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
    const asks = this.#waiters().some((w) => w.ask === id) && !!this.cloud();
    const cloudOnce = asks ? [{ action: 'models-cloud-once', label: 'Use the cloud model this once' }] : [];
    const flight = this.#inFlight.get(id);
    if (flight) {
      const lines = [`${hubName} sent the wake signal at ${hhmm(flight.sent)}. ${flight.measured !== null ? `Waking took ${secs(flight.measured)} last time, so Nova waits up to ${secs(flight.limit)} before it says what it will do instead.` : `How long waking takes isn’t measured yet, so Nova waits up to ${secs(flight.limit)}.`}`];
      if (flight.mode === 'local-only') lines.push('This is local only: the task waits on your devices, and nothing goes to the cloud.');
      return { state: 'waking', screen: { state: 'waking', pill: 'Waking', waiting: { text: `Waking ${name}${flight.title ? ` for ${flight.title}` : ''}`, since: new Date(flight.since).toISOString() }, lines, policy } };
    }
    const loading = this.#loadingAfterWake.get(id);
    if (loading) return { state: 'woke-loading', screen: { state: 'awake', pill: 'Awake', waiting: { text: `Loading ${loading.model}${loading.title ? ` for ${loading.title}` : ''}`, since: new Date(loading.since).toISOString() }, lines: [loading.words], policy } };
    if (online) return { state: 'awake', screen: { state: 'awake', pill: 'Online', lines: [this.holds(id) ? 'Nova is using it now, so it stays awake.' : 'Nothing of Nova’s is running here now.'], policy } };
    // Not heard from since the last wake attempt, and that attempt failed: Couldn't wake.
    const seen = this.#o.devices.find(id)?.last_seen ?? null;
    const last = this.#o.db.get<{ sent_at: string; outcome: string; waited_ms: number | null; reason: string | null }>(`SELECT sent_at, outcome, waited_ms, reason FROM device_wake WHERE device_id = ? AND outcome != 'waiting' AND NOT (outcome = 'refused' AND reason IN ('off', 'paused', 'once')) ORDER BY id DESC LIMIT 1`, id);
    const failed = last && last.outcome !== 'awake' && (!seen || Date.parse(seen) < Date.parse(last.sent_at));
    if (failed && last) {
      const prev = this.#o.db.get<{ waited_ms: number }>(`SELECT waited_ms FROM device_wake WHERE device_id = ? AND outcome = 'awake' AND sent_at < ? ORDER BY id DESC LIMIT 1`, id, last.sent_at)?.waited_ms ?? null;
      const first = last.outcome === 'no_answer'
        ? `${hubName} sent the wake signal at ${hhmm(last.sent_at)} and waited ${secs(last.waited_ms ?? 0)}${prev !== null ? `, half again what waking took last time (${secs(prev)})` : ''}. ${name} didn’t answer.`
        : last.outcome === 'unhealthy' ? `${name} woke after ${secs(last.waited_ms ?? 0)} and its device agent checked in, but Ollama didn’t answer in the minute after.`
        : last.outcome === 'not_sent' ? `Nova couldn’t send the wake signal: ${last.reason ?? 'the network refused it'}.`
        : can.ok ? `Nova didn’t wake ${name} last time it was needed.` : can.words;
      const instead = this.#instead.get(id) ?? `Work for it waits on your devices until ${name} checks in. Nova won’t keep waking it.`;
      const again = last.outcome !== 'refused' && p.on_demand ? [{ action: 'models-wake-again', label: 'Try waking it again' }] : [];
      return { state: 'wake-failed', screen: { state: 'failed', pill: 'Couldn’t wake', lines: [first, instead], actions: [...again, ...cloudOnce], policy } };
    }
    if (can.ok) {
      return { state: 'asleep-wakeable', screen: { state: 'asleep', pill: 'Asleep, wakeable', lines: [`Nova wakes it when work needs it: ${hubName} sends the wake signal on their shared network. ${latency !== null ? `Waking took ${secs(latency)} last time.` : 'How long waking takes isn’t measured yet.'}`], policy } };
    }
    return { state: 'asleep', screen: { state: 'asleep', pill: 'Asleep or away', lines: [can.words], ...(cloudOnce.length ? { actions: cloudOnce } : {}), policy } };
  }

  // The checks a routing wake would pass now, sending nothing (the screen's wake state).
  wakeCheckFor(device: string) { return this.#wakeCheck(device, 'routing', null); }

  async view() {
    const dms = await this.#deviceModels();
    const advice = recommend(dms);
    const hubHw = await this.hubHardware();
    const hubInv = this.#inventory.get(HUB)!;
    const deviceView = async (id: string, name: string, hub: boolean, hw: Hardware | null, d?: Device) => {
      const inv = this.#inventory.get(id);
      const nic = hw?.network[0];
      const online = hub || this.#online(id);
      const latency = hub ? null : this.wakeLatency(id);
      // Whether routing could wake it now, by the same checks a wake passes (nothing is sent).
      const can = hub ? null : await this.#wakeCheck(id, 'routing', null);
      const hardwareAt = hub ? hw?.at ?? null : this.#o.db.get<{ updated_at: string }>('SELECT updated_at FROM device_hardware WHERE device_id = ?', id)?.updated_at ?? null;
      return {
        id, name, hub, online, last_seen: hub ? null : d?.last_seen ?? null, compute: this.#computes(id),
        plan: await this.#planView(id, dms.find((x) => x.id === id), hardwareAt),
        hardware: hw, words: hw ? hardwareWords(hw, unifiedBudgetBytes(hw.ram_bytes, hw.gpu_wired_limit_bytes)) : 'It hasn’t reported its hardware yet.', capacity: hw ? capacityWords(hw, this.overhead(id)) : '',
        overhead: overheadWords(this.overhead(id)),
        ...(hub ? { decision_model: this.#o.decisionModel?.() ?? null } : {}),
        runtime: inv ? { url: this.#urlFor(id), ok: inv.ok, version: inv.version, models: inv.models.length, problem: inv.problem, words: inv.ok ? `Ollama ${inv.version} · ${inv.models.length} model${inv.models.length === 1 ? '' : 's'}` : `Ollama isn’t answering${inv.problem ? `: ${inv.problem}` : ''}` } : null,
        wake: !can ? null : {
          mac: nic?.mac ?? null, latency_ms: latency, policy: this.power(id), able: can.ok, reason: can.ok ? null : can.reason,
          words: !can.ok ? can.words : latency !== null ? `Wakes in about ${secs(latency)} (measured).` : 'Can be woken; how long it takes isn’t measured yet.',
          ...this.#wakeState(id, online, can, latency),
        },
      };
    };
    const devices = await Promise.all([deviceView(HUB, this.#o.hubName(), true, hubHw), ...this.#spokes().map((d) => deviceView(d.id, d.name, false, this.#spokeHardware(d.id), d))]);
    const roles = await Promise.all(advice.map(async (a) => {
      const p = this.placement(a.role);
      const problem = p ? (this.#inventory.get(p.device)?.models.some((m) => m.name === p.model) === false && this.#inventory.get(p.device)?.ok ? `${p.model} isn’t installed there any more.` : await this.probe(a.role)) : null;
      const recommended = a.pick && !(p && p.device === a.pick.device && p.model === a.pick.model) ? a.pick : null;
      // Each route names its device's wake state: "Dell desktop (asleep, wakeable; waking took 38 s)".
      const w = p && p.device !== HUB ? devices.find((x) => x.id === p.device)?.wake : null;
      const wakeWords = !w ? null : w.state === 'asleep-wakeable' ? `asleep, wakeable; ${w.latency_ms !== null ? `waking took ${secs(w.latency_ms)}` : 'waking isn’t measured yet'}`
        : w.state === 'asleep' ? 'asleep or away; Nova doesn’t wake it' : w.state === 'waking' ? 'waking' : w.state === 'wake-failed' ? 'couldn’t wake' : null;
      // Re-checked every time: an assignment from before Nova asked about tight fits (#354), or one
      // whose computer changed since, is flagged here. Nothing is reassigned.
      const fit = p && a.role !== 'transcriber' ? roleFit(await this.#deviceModel(p.device), p.model, a.role, p.context) : null;
      const name = p ? this.#deviceName(p.device) : '';
      const fitWords = !fit || !p ? null
        : fit.verdict === 'wont-fit' ? `Nova’s fit check now says it doesn’t fit on ${name}: ${fit.words} Pick another model.`
          : fit.verdict === 'tight' && !p.accepted_tight ? `It’s tight on ${name}, and you haven’t acknowledged that (it was assigned before Nova asked, or ${name} has changed since): ${fit.words} Replies may slow down sharply or fail under load. To keep it, assign it again from Models on ${name} with the acknowledgement ticked; or pick another.`
            : null;
      return {
        role: a.role, ...ROLE_WORDS[a.role], assigned: p ? { ...p, device_name: name, ...(wakeWords ? { wake_words: wakeWords } : {}), ...(fit ? { fit: fit.verdict } : {}), ...(fitWords ? { fit_words: fitWords } : {}) } : null,
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
      { method: 'PUT', path: '/models/roles/{role}', summary: 'Assign a role (triage-text, reasoner, embedder) to an installed model on the hub or a paired computer. A computer’s url must be one of its own addresses; hub_model is what small jobs use while it sleeps. Refused when the model (or the hub model) won’t fit the device; when it is tight, refused unless accept_tight is true, the person’s acknowledgement.', body: '{model, device?, url?, hub_model?, context?, accept_tight?}', handle: async ({ params, body }) => ({ placement: await this.assign(params.role, body), view: await view() }) },
      { method: 'DELETE', path: '/models/roles/{role}', summary: 'Leave a role unassigned.', handle: async ({ params }) => { this.unassign(params.role); return view(); } },
      { method: 'POST', path: '/models/pull', status: 201, summary: 'Download a model (a tier-2 ledger task: it waits for your OK). Refused at once when the disk budget can’t take it. digest: the sha256 to expect, if known.', body: '{model, device?, digest?}', handle: ({ body }) => this.requestPull(body) },
      { method: 'POST', path: '/models/install', status: 201, summary: 'Install and assign a plan for one device (the Models screen): each model at its quant and context, with the role it serves, if any. Refused when a model isn’t one Nova lists for the device, runs off your devices, or the plan won’t fit together; when it fits only tightly, refused unless accept_tight is true, the person’s acknowledgement for this plan. An installed model is assigned now, as PUT /models/roles/{role}; each download is a tier-2 ledger task that waits for your OK, as POST /models/pull, and is assigned once Nova has verified it.', body: '{device?, plan: [{model, quant, context?, role?}], accept_tight?}', handle: ({ body }) => this.installPlan(body) },
      { method: 'POST', path: '/models/remove', status: 201, summary: 'Remove an installed model (a tier-2 ledger task). A model serving a role must be replaced first.', body: '{model, device?}', handle: ({ body }) => this.requestRemove(body) },
      { method: 'PUT', path: '/models/wake', summary: 'Where Wake-on-LAN packets go (host:port; by default the broadcast address of the hub’s own card on the computer’s network; a target set here must be on that network too, or that computer’s wake is refused) and how long to wait for a computer never woken before (wait_s, 120 by default). After the first wake Nova waits as long as it took, half again, plus 2 s.', body: '{target?, wait_s?}', handle: async ({ body }) => { this.setWake(body); return view(); } },
      { method: 'PUT', path: '/models/disk-budget', summary: 'The most disk models may use, in GB (null for none). Downloads past it are refused.', body: '{gb}', handle: async ({ body }) => { this.setDiskBudget(body.gb); return view(); } },
      { method: 'PUT', path: '/models/budget', summary: 'Cloud budgets: per task and per period (day, week or month), in US dollars. Over budget, work waits with the reason; local stays the default.', body: '{per_task_usd?, per_period_usd?, period}', handle: async ({ body }) => { this.setBudget(body); return view(); } },
      { method: 'PUT', path: '/models/prices', summary: 'Prices per million tokens by model, for cloud usage that reports tokens but no cost (a coding agent off your devices). With a budget set, usage Nova can’t price makes the cloud wait.', body: '{"<model>": {usd_per_mtok_in, usd_per_mtok_out}}', handle: async ({ body }) => { this.setPrices(body); return view(); } },
      { method: 'PUT', path: '/models/cloud', summary: 'The cloud model local-preferred and cloud-allowed work may use when it must (an OpenAI-compatible address; its key in the vault). A new address needs {confirm: true}. {cloud: null} removes it.', body: '{cloud, confirm?}', handle: async ({ body }) => { this.setCloud(body.cloud, body.confirm === true); return view(); } },
      { method: 'POST', path: '/models/devices/{id}/wake', summary: 'Wake a paired computer with a Wake-on-LAN signal and wait for its models, as long as waking took last time. A tier-1 ledger task “Wake ⟨device⟩”. Only on its own network, from the hub’s card there; only when waking is on for it; at most 4 wakes of a device and 12 across the hub per hour. A refusal says why and sends nothing.', handle: ({ params }) => this.wake(params.id!, { origin: 'person' }) },
      { method: 'POST', path: '/models/devices/{id}/cloud-once', summary: 'Local-first work waiting because this computer didn’t wake goes to your cloud model this once, as you say (recorded on each task). Nothing else changes: the next failed wake asks again.', handle: async ({ params }) => ({ ...this.cloudOnce(params.id!), view: await view() }) },
      { method: 'PUT', path: '/models/devices/{id}/power', summary: 'A computer’s sleep and wake choices: on_demand (Nova wakes it when work needs it, or waits until it’s turned on) and sleep_after_min (null to never sleep, or 15, 30, 60 or 120 idle minutes).', body: '{on_demand?, sleep_after_min?}', handle: async ({ params, body }) => { this.setPower(params.id!, body); return view(); } },
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

// What the per-device Models screen draws for a computer's wake state (components.js wakeStatus,
// sleepPolicy): the approved styleguide states.
export interface WakeScreen {
  state: 'asleep' | 'waking' | 'awake' | 'failed';
  pill: string;
  lines: string[];
  waiting?: { text: string; since: string };
  actions?: { action: string; label: string }[];
  policy: { idle: string; demand: string; notes: string[] };
}

// `reason`: why a wake was refused or failed (a WakeRefusal, `not_sent` or `no_answer`); `retry_at`:
// when a rate limit lets it try again; `task_id`: the "Wake ⟨device⟩" task, when one was made.
export interface WakeResult { ok: boolean; waited_ms: number; limit_ms: number; words: string; reason?: string; retry_at?: string; task_id?: string; wake_id?: number }

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
