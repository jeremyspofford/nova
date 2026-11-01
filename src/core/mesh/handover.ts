// Hub promotion as a first-class process (M10g; docs/plans/M10g.md, the orchestration ADR's Point 10,
// the owner's Decisions 2 and 5). Two variants, both tier 3, every step a ledger task in one chain:
//
//  - Planned ("Promote to hub" in Settings › Devices): the hub drives its live standby through
//    pre-checks, catch-up, drain, transfer, demotion and a verification window, and rolls back by
//    itself (tier 1) at epoch + 2 when the new hub fails its checks. The hub talks to the candidate
//    over the candidate's own mesh address, each request signed by the hub's identity key, which the
//    candidate checks against the key its role file and registry hold; what the candidate answers
//    with authority (its roster) is signed by its own pinned key and checked here.
//  - Emergency (the hub can't be reached, and this node holds no live copy): the latest backup that
//    passes its restore drill is staged like a checkpoint restore and applied at the next start;
//    this node keeps its own keys and takes epoch max + 1. Nothing is escrowed: the backup never held
//    the vault's key, so connectors are signed in again, and the sheet says so first.
//
// Private keys never move. What transfers is the roster's lineage (the new hub signs a roster at a
// higher epoch with its own key, which devices pinned as a candidate's) and the stable mesh name
// (NOVA_MESH_PUBLIC_URL), which the node that becomes hub points at itself through a driver, when one
// is configured (NOVA_MESH_NAME_CONTROL; in this build only a loopback stand-in is ever used).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CoreError } from '../errors.ts';
import { ENVELOPE_VERSION, type Brief, type Report } from '../envelope.ts';
import { TERMINAL, type LanedWorker, type Ledger, type Task } from '../ledger.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { Route } from '../api.ts';
import type { Verifier } from '../verify.ts';
import type { Device, Devices } from './devices.ts';
import type { MeshIdentity } from './identity.ts';
import type { MeshRole } from './promote.ts';
import type { SyncLog } from './sync.ts';
import { ask, readRole } from './replica.ts';
import { tap } from './tap.ts';
export { tap };
import { sealed, type Manifest } from '../resilience/backup.ts';
import { canonicalJson, freshTime, sessionMessage, verifyDeviceSignature, verifyRoster, type SignedRoster } from './wire.ts';

export const PROMOTION_WORKER = 'mesh-promotion';
export const PROMOTION_SYSTEM = 'nova-promotion';
export const PROMOTION_FILE = join('mesh', 'promotion.json');
// The verification window: 30 minutes, longer if the person sets it, never shorter (the ADR). A drill
// or a test may set a shorter one with NOVA_PROMOTION_WINDOW_S; the sheet says which applies.
export const WINDOW_MIN_S = 30 * 60;
// The pre-checks' hardware minimums (the ADR: free disk at least three times the home's size, and
// enough memory to run Nova).
export const DISK_FACTOR = 3;
export const MIN_MEMORY_BYTES = 2 * 1024 ** 3;
export const BACKUP_FRESH_MS = 24 * 3600_000;
// Probes failing in a row before the old hub takes the role back.
export const FAILS_TO_ROLL_BACK = 3;
const TIER3 = 'It changes which computer runs Nova and holds your data, so it needs your explicit confirmation every time (tier 3).';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

// ---- pre-checks (step 1), pure -------------------------------------------------------------------

export interface Check { name: string; ok: boolean; said: string }

// What the candidate says about itself, signed by nothing: the hub checks what it can (its epoch,
// whose standby it is) against its own records, and takes disk and memory as reported.
export interface CandidateFacts { id: string; role: 'hub' | 'standby'; epoch: number; hub_id: string | null; version: string; schema: number; free_disk: number | null; memory: number; cursor: number; demoted: boolean }
export interface HubFacts { id: string; epoch: number; version: string; schema: number; home_bytes: number; backup: { at: string; path: string | null; drilled: boolean } | null; now: Date }

const gib = (n: number) => `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
const human = (n: number) => (n >= 1024 ** 3 ? gib(n) : n >= 1024 ** 2 ? `${Math.ceil(n / 1024 ** 2)} MB` : `${Math.ceil(n / 1024)} KB`);

export function prechecks(o: { device: Device | null; standbyId: string | null; candidate: CandidateFacts | null; unreachable?: string | null; hub: HubFacts }): Check[] {
  const d = o.device;
  const out: Check[] = [];
  const name = d ? `“${d.name}”` : 'That device';
  // Role.
  if (!d) out.push({ name: 'role', ok: false, said: 'There is no such device.' });
  else if (d.trust !== 'trusted') out.push({ name: 'role', ok: false, said: `${name} was revoked, so it can’t become the hub.` });
  else if (d.id === o.hub.id) out.push({ name: 'role', ok: false, said: `${name} is the hub already.` });
  else if (d.kind === 'phone' || d.kind === 'browser') out.push({ name: 'role', ok: false, said: `${name} is a ${d.kind}: a screen onto Nova, never a hub.` });
  else if (!d.purposes.includes('hub-candidate')) out.push({ name: 'role', ok: false, said: `${name} isn’t a hub candidate. Making it one is its own explicit confirmation, in its roles.` });
  else if (d.id !== o.standbyId || !d.address) out.push({ name: 'role', ok: false, said: `${name} is a hub candidate but not the standby, so it holds no live copy to take over with. Make it the standby first (Add a device, as a standby, on that computer; it replaces the current one), then promote it.` });
  else out.push({ name: 'role', ok: true, said: `${name} is a hub candidate and the standby.` });
  if (!out[0]!.ok) return out;
  const c = o.candidate;
  if (!c) {
    out.push({ name: 'reach', ok: false, said: `Nova couldn’t reach ${name} at ${d!.address}${o.unreachable ? ` (${o.unreachable})` : ''}.` });
    return out;
  }
  // It follows this hub, at this hub's epoch.
  const follows = c.role === 'standby' && !c.demoted && c.hub_id === o.hub.id && c.epoch === o.hub.epoch && c.id === d!.id;
  out.push({ name: 'follows', ok: follows, said: follows ? `It copies this hub, at epoch ${c.epoch}.` : `It doesn’t copy this hub at its epoch (it says ${c.role}${c.demoted ? ', stepped down' : ''}, epoch ${c.epoch}).` });
  // Hardware.
  const need = DISK_FACTOR * o.hub.home_bytes;
  const disk = c.free_disk !== null && c.free_disk >= need;
  out.push({ name: 'disk', ok: disk, said: c.free_disk === null ? 'It couldn’t say how much disk it has free.' : disk ? `${human(c.free_disk)} free, at least ${DISK_FACTOR} times the home’s ${human(o.hub.home_bytes)}.` : `Only ${human(c.free_disk)} free; it needs at least ${human(need)} (${DISK_FACTOR} times the home’s ${human(o.hub.home_bytes)}).` });
  const mem = c.memory >= MIN_MEMORY_BYTES;
  out.push({ name: 'memory', ok: mem, said: mem ? `${gib(c.memory)} of memory.` : `Only ${gib(c.memory)} of memory; the hub needs at least ${gib(MIN_MEMORY_BYTES)}.` });
  // Version parity.
  const v = c.version === o.hub.version;
  out.push({ name: 'version', ok: v, said: v ? `The same release (${c.version}).` : `It runs release ${c.version}, and this hub ${o.hub.version}. Update it to the same release first.` });
  const sc = c.schema === o.hub.schema;
  out.push({ name: 'schema', ok: sc, said: sc ? `The same database version (${c.schema}).` : `Its database is version ${c.schema}, and this hub’s ${o.hub.schema}. Update it to the same release first.` });
  // Backup freshness.
  const b = o.hub.backup;
  const fresh = !!b && o.hub.now.getTime() - Date.parse(b.at) <= BACKUP_FRESH_MS;
  out.push({ name: 'backup', ok: fresh && !!b?.drilled, said: !b ? 'There is no backup. Back up now (Settings › Backups), then try again.' : !fresh ? `The last backup is from ${b.at}, more than 24 hours ago. Back up now, then try again.` : !b.drilled ? `The backup of ${b.at} hasn’t passed a restore drill yet. Run the drill, then try again.` : `A backup from ${b.at}, and its restore drill passed.` });
  return out;
}

// ---- signed calls and the handover ---------------------------------------------------------------

interface CallAuth { from: string; to: string; epoch: number; time: number; nonce: string; signature: string }
const callMessage = (step: string, a: Omit<CallAuth, 'signature'>, payload: unknown) => Buffer.from(`nova-promotion-v1|${step}|${a.from}|${a.to}|${a.epoch}|${a.time}|${a.nonce}|${sha(canonicalJson(payload ?? null))}`, 'utf8');

export function signCall(identity: MeshIdentity, step: string, to: string, epoch: number, payload: unknown, nowS: number): { auth: CallAuth; payload: unknown } {
  const a = { from: identity.id, to, epoch, time: nowS, nonce: randomBytes(12).toString('base64url') };
  return { auth: { ...a, signature: identity.sign(callMessage(step, a, payload)) }, payload };
}

export function verifyCall(step: string, body: unknown, o: { hubId: string; hubKey: string; me: string; nowS: number; seen: Map<string, number> }): { ok: true; payload: Record<string, unknown>; epoch: number } | { ok: false; why: string } {
  const b = body as { auth?: CallAuth; payload?: Record<string, unknown> } | null;
  const a = b?.auth;
  if (!a || typeof a.signature !== 'string' || typeof a.nonce !== 'string' || !Number.isInteger(a.time) || !Number.isInteger(a.epoch)) return { ok: false, why: 'That isn’t a signed request from the hub.' };
  if (a.from !== o.hubId || a.to !== o.me) return { ok: false, why: 'That request isn’t from this node’s hub, or isn’t for this node.' };
  if (!freshTime(a.time, o.nowS)) return { ok: false, why: 'The request’s signed time is too far from this node’s clock.' };
  for (const [n, t] of o.seen) if (t < o.nowS - 300) o.seen.delete(n);
  if (o.seen.has(a.nonce)) return { ok: false, why: 'That signed request was already used.' };
  if (!verifyDeviceSignature(o.hubKey, callMessage(step, a, b?.payload ?? null), a.signature)) return { ok: false, why: 'The request isn’t signed by the hub’s key.' };
  o.seen.set(a.nonce, o.nowS);
  return { ok: true, payload: (b?.payload ?? {}) as Record<string, unknown>, epoch: a.epoch };
}

// The handover (step 4): the old hub names its successor at the next epoch and the last sequence
// both hold. Signed by the old hub's key; it carries no key of any kind.
export interface Handover { v: 1; id: string; parent: string | null; from: string; to: string; epoch: number; last_seq: number; from_address: string | null; name: string | null; at: string }
export interface SignedHandover { handover: Handover; signature: string }
export const handoverMessage = (h: Handover) => Buffer.from(`nova-handover-v1|${canonicalJson(h)}`, 'utf8');
export const verifyHandover = (s: SignedHandover, key: string) => !!s?.handover && typeof s.signature === 'string' && verifyDeviceSignature(key, handoverMessage(s.handover), s.signature);

// ---- the stable mesh name -----------------------------------------------------------------------

export interface StableName { name: string; point(address: string): Promise<{ ok: boolean; said: string }> }

// A driver that moves the name by asking an HTTP endpoint to point it at an address. In this build
// that endpoint is only ever a loopback stand-in the drill runs (Hard limits: no DNS, tailnet or
// router change is made). A real DNS or tailnet driver is the owner's call.
export function httpStableName(control: string, name: string): StableName {
  return {
    name,
    async point(address) {
      try {
        const r = await ask(control, { method: 'POST', headers: { 'x-nova': '1' }, body: { name, address }, timeoutMs: 5000 });
        return r.status >= 200 && r.status < 300 ? { ok: true, said: `${name} now points at ${address}.` } : { ok: false, said: `Moving ${name} was refused (${r.body?.error ?? r.status}).` };
      } catch (e) {
        return { ok: false, said: `Nova couldn’t reach what moves ${name}: ${(e as Error).message}` };
      }
    },
  };
}

// ---- the record --------------------------------------------------------------------------------

export type PromotionState = 'checking' | 'catching-up' | 'draining' | 'holding' | 'transferring' | 'verifying' | 'verified' | 'rolling-back' | 'rolled-back' | 'stepped-down' | 'failed' | 'refused' | 'staged' | 'done';
export interface Probe { at: string; ok: boolean; checks: Check[] }
export interface Peer { id: string; name: string; address: string | null; public_key: string; x25519_public_key: string }
// This node's own record of the promotion it is part of (mesh/promotion.json, mode 0600; mesh/ stays
// on its node). The ledger tasks, replicated, are the shared record; this is what each end needs to
// carry on after a restart.
export interface PromotionRecord {
  v: 1; id: string; kind: 'planned' | 'cold'; side: 'from' | 'to'; state: PromotionState;
  from: Peer | null; to: Peer | null; epoch_from: number; epoch_to: number | null; last_seq: number | null;
  window_s: number; verify_until: string | null; probes: Probe[]; parent: string | null; said: string | null;
  restore_id?: string | null; cold?: ColdFacts | null; started_at: string; updated_at: string;
}

// ---- the emergency sheet ------------------------------------------------------------------------

export interface FoundBackup { path: string; id: string; seq: number; at: string; nova_version: string; schema_version: number; sealed: boolean | null }
export interface ColdFacts { backup: FoundBackup | null; epoch_now: number; epoch_backup: number | null; epoch_new: number | null; pinned: boolean; lost: string; connectors: string; devices: string }

export interface Fact { label: string; text: string }

// The words the person reads before an emergency promotion (Decision 5: the backup's time, what was
// lost, connectors), built here so the claims register reads one file (tests/evals/claims.ts).
export function coldSheet(f: ColdFacts, o: { name: string | null; window?: string }): Fact[] {
  const b = f.backup;
  return [
    { label: 'The backup', text: b ? `Backup ${b.seq}, made ${b.at}${b.sealed === false ? '. Nova couldn’t check its seal here, so it checks every file’s hash against the manifest instead' : ''}.` : 'There is no backup Nova can use.' },
    { label: 'What is lost', text: f.lost },
    { label: 'Connectors', text: f.connectors },
    { label: 'Devices', text: f.devices },
    { label: 'Epoch', text: f.epoch_new ? `This node becomes the hub at epoch ${f.epoch_new}, higher than any it knows of, so a hub that comes back steps down.` : 'Not known yet.' },
    { label: 'The stable name', text: o.name ? `Devices look for the hub at ${o.name}. ${o.window ?? ''}`.trim() : 'This hub has no stable name, so devices look for it at the addresses their roster lists.' },
    { label: 'Why it asks', text: TIER3 },
  ];
}

export const LOST_WORDS = (at: string) => `Everything written after ${at}: changes, conversations, memories and tasks from then on are not in the backup.`;
export const CONNECTOR_WORDS = 'Connectors need signing in again. The backup holds your saved secrets encrypted but never their key, and Nova keeps no copy of that key anywhere, so they can’t be opened.';
export const DEVICE_WORDS = 'Devices paired before the backup find this node without pairing again: its key is in the roster they hold. A device paired after it needs pairing again.';

// The planned sheet's facts, around the pre-checks.
export function plannedSheet(o: { device: Device; checks: Check[]; windowS: number; name: string | null; driver: boolean; hub: string }): Fact[] {
  const window = o.windowS >= 60 ? `${Math.round(o.windowS / 60)} minutes` : `${o.windowS} seconds`;
  return [
    { label: 'What happens', text: `Nova copies the last changes to “${o.device.name}”, lets running work finish (or hands it over), holds new changes for a moment, and then “${o.device.name}” becomes the hub. This hub becomes its standby, keeping a live copy.` },
    { label: 'Devices', text: o.name ? `They look for the hub at ${o.name}, ${o.driver ? 'which Nova points at the new hub' : `which you point at the new hub yourself: Nova can’t move it here`}. Computers also follow the roster. None is paired again.` : 'Computers follow the roster; phones and browsers sign in again at the new hub’s address. None is paired again.' },
    { label: 'Keys', text: 'Each computer keeps its own keys. The new hub signs a new roster with the key you pinned when you made it a candidate.' },
    { label: 'Checking it', text: `For ${window} this hub checks the new one. If it fails, Nova makes this hub the hub again by itself and tells you.` },
    { label: 'Why it asks', text: TIER3 },
  ];
}

// ---- the service ---------------------------------------------------------------------------------

export interface ColdHooks {
  // The restore drill on a backup folder (resilience/drill.ts), with this Nova's migrations.
  drill: (backupDir: string) => Promise<{ ok: boolean; checks: Check[] }>;
  // Stages the backup like a checkpoint restore, with the cold marker; returns its restore id.
  stage: (backupDir: string, cold: ColdMarker) => string;
  // Restarts Nova so the staged home is swapped in before the database opens.
  restart: (why: string, failed: (e: Error) => void) => Promise<{ said: string }>;
  // The vault's own key for backup seals, when this node's vault holds it.
  seal: () => Buffer | null;
  folder: () => string | null;
}

export interface ColdMarker { node: string; floor: number; promotion: string; backup: FoundBackup; drill: Check[]; by: string }

export interface PromotionOptions {
  db: Db; log: Log; home: string; now: () => Date; version: string;
  identity: MeshIdentity; devices: Devices; role: MeshRole; sync: SyncLog; ledger: Ledger; verifier: Verifier;
  publicUrl: () => string | null; address: () => string | null; schema: () => number;
  // The hub's own work (the heartbeat, connectors, capture, models: index.ts stopHub/startHub).
  stopWork: () => void; startWork: () => void;
  // The latest backup that went well, and whether its restore drill passed.
  backup: () => HubFacts['backup'];
  hardware?: () => { free_disk: number | null; memory: number };
  name?: StableName | null;
  windowS?: number; probeMs?: number; catchupMs?: number; drainMs?: number; commitMs?: number;
  cold: ColdHooks;
}

export class Promotions {
  #o: PromotionOptions;
  #running: Promise<void> | null = null;
  #watching: ReturnType<typeof setTimeout> | null = null;
  #seen = new Map<string, number>();
  #closed = false;
  #lastFence = 0;
  #lastTime = 0;
  readonly windowS: number;
  readonly probeMs: number;

  constructor(o: PromotionOptions) {
    this.#o = o;
    const env = Number(process.env.NOVA_PROMOTION_WINDOW_S);
    this.windowS = o.windowS ?? (Number.isFinite(env) && env > 0 ? env : WINDOW_MIN_S);
    const probe = Number(process.env.NOVA_PROMOTION_PROBE_MS);
    this.probeMs = o.probeMs ?? (Number.isFinite(probe) && probe > 0 ? probe : 10_000);
    o.ledger.workers.set(this.worker.id, this.worker);
    o.verifier.registerConfirmation(PROMOTION_SYSTEM, (e, brief) => this.#confirm(e, brief));
    // A roll-back elsewhere: the node this one took over from is hub again at a higher epoch, and this
    // node stepped down (fencing). It follows that hub as its live standby, copying it afresh.
    o.role.on('demoted', (d: { hub: string; epoch: number }) => {
      const r = this.record();
      if (!r || r.kind !== 'planned' || r.side !== 'to' || !r.from || r.from.id !== d.hub || !['verifying', 'verified'].includes(r.state)) return;
      try {
        o.role.follow({ id: r.from.id, name: r.from.name, url: r.from.address ?? '', public_key: r.from.public_key, x25519_public_key: r.from.x25519_public_key }, { epoch: d.epoch, cursor: null });
        this.#save({ ...r, state: 'stepped-down', said: `“${r.from.name}” took the hub back at epoch ${d.epoch}; this node stepped down and copies it afresh as its standby.` });
      } catch (e) {
        o.log.problem('mesh', 'After the hub was taken back, this node couldn’t start copying it.', { detail: (e as Error)?.stack ?? String(e) });
      }
    });
    // Any other promotion (M4's, by the person or automatic): the node that became hub points the
    // stable name at itself too. A planned one and a roll-back do it as their own step.
    o.role.on('promoted', (p: { planned?: boolean }) => { if (!p.planned) void this.#pointName().catch(() => {}); });
    // The old hub copies the new one: its first acknowledgement after the hand-over is step 5's record.
    o.role.on('acked', (a: { standby: string; seq: number }) => {
      const r = this.record();
      if (!r || r.side !== 'to' || r.state !== 'verifying' || !r.from || a.standby !== r.from.id || r.last_seq === null || a.seq < r.last_seq) return;
      if (o.db.get('SELECT 1 FROM task WHERE idempotency_key = ?', this.#key(r.id, 'demote'))) return;
      this.#task(r, 'demote', `“${r.from.name}” is the standby now`, true, `“${r.from.name}” stepped down and copies this hub: it has acknowledged sequence ${a.seq}.`, { standby: r.from.id, acked: a.seq, last_seq: r.last_seq });
    });
  }

  // ---- this node's record ---------------------------------------------------------------------

  record(): PromotionRecord | null {
    try { return JSON.parse(readFileSync(join(this.#o.home, PROMOTION_FILE), 'utf8')) as PromotionRecord; } catch { return null; }
  }

  #save(r: PromotionRecord): PromotionRecord {
    const file = join(this.#o.home, PROMOTION_FILE);
    mkdirSync(join(this.#o.home, 'mesh'), { recursive: true, mode: 0o700 });
    const next = { ...r, updated_at: this.#o.now().toISOString() };
    writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    this.#o.role.emit('change', this.#o.role.status());
    return next;
  }

  view() {
    const r = this.record();
    const tasks = r?.parent ? this.#o.db.all<{ id: string; title: string; state: string; reason: string | null; created_at: string }>('SELECT id, title, state, reason, created_at FROM task WHERE id = ? OR parent_id = ? ORDER BY created_at, rowid', r.parent, r.parent) : [];
    return { promotion: r, tasks, window_s: this.windowS, window_min_s: WINDOW_MIN_S, name: this.#o.publicUrl(), driver: !!this.#o.name };
  }

  // ---- start and stop ----------------------------------------------------------------------------

  // At start: carry on with whatever this node was in the middle of. A hub that was holding writes
  // starts holding them and finds out whether the hand-over happened; a standby that was watching a
  // new hub watches on; an emergency promotion that was staged and has now been applied is recorded.
  start(): void {
    const r = this.record();
    if (!r) return;
    if (r.kind === 'planned' && r.side === 'from' && ['holding', 'transferring'].includes(r.state) && this.#o.role.role() === 'hub') {
      this.#o.role.hold(this.#holdWords(r));
      this.#o.sync.setLogging(false);
      this.#running = this.#settleUnknown(r).finally(() => { this.#running = null; });
    } else if (r.kind === 'planned' && r.side === 'from' && ['holding', 'transferring'].includes(r.state)) {
      // Stepped down at start already (fencing found the candidate hub at the new epoch): it follows
      // it once the candidate proves that, rather than staying a node that copies nothing.
      this.#running = this.#settleUnknown(r).finally(() => { this.#running = null; });
    } else if (r.kind === 'planned' && r.side === 'from' && (r.state === 'verifying' || r.state === 'rolling-back') && this.#o.role.role() === 'standby') {
      this.#save({ ...r, state: 'verifying' });
      this.#watch();
    } else if (r.kind === 'planned' && r.side === 'from' && r.state === 'rolling-back' && this.#o.role.role() === 'hub') {
      this.#save({ ...r, state: 'rolled-back', said: `This node took the hub back at epoch ${this.#o.devices.state().epoch}.` });
    } else if (r.kind === 'cold' && r.state === 'staged' && this.#o.role.role() === 'hub') {
      void this.#afterCold(r).catch((e) => this.#o.log.problem('mesh', 'Nova couldn’t record the emergency promotion in the ledger.', { detail: (e as Error)?.stack ?? String(e) }));
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#watching) clearTimeout(this.#watching);
  }

  // ---- step 1: pre-checks (tier 0 as a dry run) ------------------------------------------------

  async check(deviceId: unknown): Promise<{ ok: boolean; checks: Check[]; device: Device | null; sheet: Fact[] | null; candidate: CandidateFacts | null }> {
    if (typeof deviceId !== 'string') throw new CoreError('validation', 'Send device_id: the device to make the hub.');
    if (this.#o.role.role() !== 'hub') throw new CoreError('conflict', 'Only the hub can hand its role over. This node isn’t the hub.');
    const s = this.#o.devices.state();
    const device = this.#o.devices.find(deviceId);
    let candidate: CandidateFacts | null = null;
    let unreachable: string | null = null;
    if (device?.address && device.id === s.standby_id && device.trust === 'trusted') {
      try {
        const a = await this.#callCandidate(device, 'ready', {}, 10_000);
        if (a.status === 200 && a.body && typeof a.body.id === 'string') candidate = a.body as CandidateFacts;
        else unreachable = String(a.body?.error ?? `it answered ${a.status}`);
      } catch (e) { unreachable = (e as Error).message; }
    }
    const checks = prechecks({ device, standbyId: s.standby_id, candidate, unreachable, hub: this.#hubFacts() });
    const ok = checks.every((c) => c.ok);
    return { ok, checks, device, candidate, sheet: device ? plannedSheet({ device, checks, windowS: this.windowS, name: this.#stable(), driver: !!this.#o.name, hub: this.#o.identity.id }) : null };
  }

  // The stable mesh name, when there is one apart from this node's own address (devices joined at it,
  // and a promotion points it at the new hub). Without an address of its own, the public address is
  // this node's, and moves with nothing.
  #stable(): string | null {
    return this.#o.address() ? this.#o.publicUrl() : null;
  }

  #hubFacts(): HubFacts {
    return { id: this.#o.identity.id, epoch: this.#o.devices.state().epoch, version: this.#o.version, schema: this.#o.schema(), home_bytes: homeBytes(this.#o.home), backup: this.#o.backup(), now: this.#o.now() };
  }

  // ---- the planned run (on the hub) --------------------------------------------------------------

  async start_(deviceId: unknown, o: { confirm: boolean; by: string }) {
    if (!o.confirm) throw new CoreError('validation', 'Making another computer the hub needs your explicit confirmation every time (tier 3): send confirm: true.');
    if (this.#running) throw new CoreError('conflict', 'A promotion is already under way.');
    const open = this.record();
    if (open && ['checking', 'catching-up', 'draining', 'holding', 'transferring'].includes(open.state)) throw new CoreError('conflict', 'A promotion is already under way.');
    const c = await this.check(deviceId);
    const at = this.#o.now().toISOString();
    const me = this.#peer(this.#o.devices.find(this.#o.identity.id), this.#o.address());
    let r: PromotionRecord = {
      v: 1, id: randomUUID(), kind: 'planned', side: 'from', state: 'checking', from: me, to: c.device ? this.#peer(c.device, c.device.address) : null,
      epoch_from: this.#o.devices.state().epoch, epoch_to: null, last_seq: null, window_s: this.windowS, verify_until: null, probes: [], parent: null, said: null, started_at: at, updated_at: at,
    };
    const failed = c.checks.filter((x) => !x.ok);
    const parent = this.#task(r, 'checks', `Promotion pre-checks for “${c.device?.name ?? 'a device'}”`, c.ok, c.ok ? 'Every pre-check passed.' : failed.map((x) => x.said).join(' '), { checks: c.checks, device: c.device?.id ?? null, by: o.by, confirmed: 'tier 3' }, null);
    r = this.#save({ ...r, parent: parent.id, state: c.ok ? 'catching-up' : 'refused', said: c.ok ? null : failed[0]!.said });
    if (!c.ok) throw new CoreError('conflict', `Nova didn’t promote ${c.device ? `“${c.device.name}”` : 'that device'}: ${failed[0]!.said}`, failed.map((x) => x.said));
    this.#o.log.info('mesh', 'Promotion started.', { promotion: r.id, to: r.to!.id, by: o.by });
    this.#running = this.#planned(r).catch((e) => {
      this.#o.log.problem('mesh', 'A promotion stopped part-way.', { detail: (e as Error)?.stack ?? String(e) });
    }).finally(() => { this.#running = null; });
    return this.view();
  }

  async #planned(r0: PromotionRecord): Promise<void> {
    let r = r0;
    const to = this.#o.devices.get(r.to!.id);
    const sync = this.#o.sync;
    const role = this.#o.role;
    // Step 2: catch-up.
    const head = sync.head();
    const caught = await this.#until(() => role.lag().acked_seq >= head, this.#o.catchupMs ?? 120_000);
    this.#task(r, 'catchup', 'Copied to the candidate', caught, caught ? `“${to.name}” has every change up to sequence ${head}.` : `“${to.name}” didn’t catch up to sequence ${head} in time.`, { head, acked: role.lag().acked_seq });
    if (!caught) { this.#save({ ...r, state: 'failed', said: `“${to.name}” didn’t catch up in time. Nothing changed.` }); return; }
    // Step 3: drain.
    r = this.#save({ ...r, state: 'draining' });
    role.emit('draining', { promotion: r.id });
    this.#o.stopWork();
    const d = await this.#o.ledger.drain({ boundMs: this.#o.drainMs ?? 60_000, commitMs: this.#o.commitMs ?? 5 * 60_000, keep: (t) => t.owner === PROMOTION_WORKER || t.owner === 'mesh' });
    if (d.stuck.length) {
      this.#resume();
      this.#task(r, 'drain', 'Running work finished or handed over', false, `${d.stuck.length} ${d.stuck.length === 1 ? 'task is' : 'tasks are'} past the point where they change something outside Nova, and still running; Nova never cuts that short. Nothing changed: try again when ${d.stuck.length === 1 ? 'it is' : 'they are'} done.`, { stuck: d.stuck });
      this.#save({ ...r, state: 'failed', said: 'Work past its commit point was still running. Nothing changed.' });
      return;
    }
    const drained = this.#task(r, 'drain', 'Running work finished or handed over', true, `${d.finished.length} finished; ${d.handed.length} handed over to run again on the new hub.`, { finished: d.finished, handed: d.handed });
    await this.#settled(drained.id);
    // Writes held; the last sequence fixed.
    role.hold(this.#holdWords(r));
    r = this.#save({ ...r, state: 'holding' });
    try { sync.scan(); } catch { /* the journal's last look; a failure is the scan's own problem */ }
    sync.stopJournal();
    const last = sync.head();
    sync.setLogging(false);
    r = this.#save({ ...r, last_seq: last });
    const all = await this.#until(() => role.lag().acked_seq >= last, this.#o.catchupMs ?? 120_000);
    if (!all) { this.#abort(r, `“${to.name}” didn’t acknowledge the last sequence (${last}) in time.`); return; }
    // Step 4: transfer.
    r = this.#save({ ...r, state: 'transferring' });
    const epoch = r.epoch_from + 1;
    const h: Handover = { v: 1, id: r.id, parent: r.parent, from: this.#o.identity.id, to: to.id, epoch, last_seq: last, from_address: this.#o.address(), name: this.#o.publicUrl(), at: this.#o.now().toISOString() };
    const signed: SignedHandover = { handover: h, signature: this.#o.identity.sign(handoverMessage(h)) };
    let answer: { status: number; body: any } | null = null;
    try { answer = await this.#callCandidate(to, 'transfer', { handover: signed }, 30_000); } catch { answer = null; }
    if (answer && answer.status !== 200) { this.#abort(r, `“${to.name}” refused to take the role: ${answer.body?.error ?? answer.status}.`); return; }
    const roster = answer?.body?.roster as SignedRoster | undefined;
    if (answer && !this.#theirs(roster, to, epoch)) { this.#abort(r, `“${to.name}” answered without a roster signed by its own key at epoch ${epoch}.`); return; }
    if (!answer) { await this.#settleUnknown(r); return; }
    tap('transfer-answer', answer.body);
    this.#followNew(r, to, epoch, last, roster!);
  }

  // The new hub signed a roster at the new epoch with the key this hub holds for it.
  #theirs(roster: SignedRoster | undefined, to: Device, epoch: number): boolean {
    return !!roster && roster.roster?.epoch === epoch && roster.roster.hub?.id === to.id && roster.roster.hub.public_key === to.public_key && verifyRoster(roster, [to.public_key]);
  }

  // Step 5: this node becomes the new hub's live standby, then watches it (step 6).
  #followNew(r: PromotionRecord, to: Device, epoch: number, last: number, roster: SignedRoster): void {
    const f = this.#o.role.follow({ id: to.id, name: to.name, url: to.address!, public_key: to.public_key, x25519_public_key: to.x25519_public_key }, { epoch, cursor: last, roster });
    if (f.dropped) this.#o.log.problem('mesh', `${f.dropped} ${f.dropped === 1 ? 'change' : 'changes'} recorded here after the hand-over point stayed on this node only.`);
    this.#save({ ...r, state: 'verifying', epoch_to: epoch, verify_until: new Date(this.#o.now().getTime() + r.window_s * 1000).toISOString(), said: `“${to.name}” is the hub at epoch ${epoch}; this node is its standby and checks it until the window ends.` });
    this.#watch();
  }

  // The candidate's answer was lost: holding on, until it says what it is. It becoming hub at the new
  // epoch (proven with its key) means the hand-over happened; it saying it is still the standby means
  // it didn't, and this hub carries on. Until then nothing is written here.
  async #settleUnknown(r: PromotionRecord): Promise<void> {
    const to = r.to ? this.#o.devices.find(r.to.id) : null;
    const epoch = r.epoch_from + 1;
    this.#o.log.problem('mesh', `Nova couldn’t tell whether ${to ? `“${to.name}”` : 'the candidate'} took the hub’s role, so this node keeps refusing changes until it can.`);
    for (let i = 0; !this.#closed; i++) {
      if (to?.address) {
        try {
          const a = await ask(`${to.address}/api/v1/mesh/hello`, { timeoutMs: 5000 });
          const b = a.body as { id?: string; role?: string; epoch?: number; roster?: SignedRoster };
          if (a.status === 200 && b?.id === to.id && b.role === 'hub' && this.#theirs(b.roster, to, epoch)) { this.#followNew(r, to, epoch, r.last_seq ?? this.#o.sync.head(), b.roster!); return; }
          if (a.status === 200 && b?.id === to.id && b.role === 'standby' && (b.epoch ?? 0) <= r.epoch_from) {
            if (this.#o.role.role() === 'hub') this.#abort(r, `“${to.name}” didn’t take the role.`);
            else this.#save({ ...r, state: 'failed', said: `“${to.name}” didn’t take the role, and this node had stepped down: it copies nothing now. Enroll it again as the standby.` });
            return;
          }
        } catch { /* not reachable yet */ }
      }
      await new Promise((res) => setTimeout(res, Math.min(10_000, 500 * 2 ** Math.min(i, 5))));
    }
  }

  // Nothing was handed over: this hub carries on as it was.
  #abort(r: PromotionRecord, why: string): void {
    this.#resume();
    this.#task(r, 'transfer', 'Hub handed over', false, `${why} This node is still the hub; nothing changed.`, { why });
    this.#save({ ...r, state: 'failed', said: `${why} Nothing changed.` });
    this.#o.log.problem('mesh', `The promotion stopped: ${why} This node is still the hub.`);
  }

  #resume(): void {
    this.#o.role.release();
    this.#o.sync.setLogging(true);
    this.#o.sync.startJournal();
    this.#o.ledger.resume();
    this.#o.startWork();
    this.#o.role.emit('resumed', {});
  }

  #holdWords(r: PromotionRecord): string {
    return `Nova is handing the hub over to “${r.to?.name ?? 'another computer'}”, so changes wait a moment. Try again in a minute${this.#o.publicUrl() ? `, at ${this.#o.publicUrl()}` : ''}.`;
  }

  // ---- step 6: verification (on the old hub, now the standby) ---------------------------------

  #watch(): void {
    if (this.#watching || this.#closed) return;
    const next = () => { this.#watching = setTimeout(() => { this.#watching = null; void this.probe().then(() => next(), () => next()); }, this.probeMs); this.#watching.unref?.(); };
    // Not after the end: probe() itself finishes the window.
    next();
  }

  // One probe of the new hub: it says hello as hub at the new epoch, with a roster signed by its own
  // key; the stable name leads to it (when Nova moves the name); this node's copy keeps arriving.
  async probe(): Promise<Probe | null> {
    let r = this.record();
    if (!r || r.kind !== 'planned' || r.side !== 'from' || r.state !== 'verifying' || !r.to || this.#closed) return null;
    const to = r.to;
    const checks: Check[] = [];
    const hello = async (url: string) => (await ask(`${url}/api/v1/mesh/hello`, { timeoutMs: Math.max(2000, Math.min(this.probeMs, 5000)) })).body as { id?: string; role?: string; epoch?: number; roster?: SignedRoster };
    try {
      const h = await hello(to.address!);
      const ok = h?.id === to.id && h.role === 'hub' && (h.epoch ?? 0) >= r.epoch_to! && !!h.roster && verifyRoster(h.roster, [to.public_key]);
      checks.push({ name: 'hub', ok, said: ok ? `“${to.name}” answers as the hub at epoch ${h.epoch}, its roster signed by its key.` : `“${to.name}” answers, but not as the hub at epoch ${r.epoch_to} with a roster signed by its key (it says ${h?.role ?? 'nothing'}).` });
    } catch (e) { checks.push({ name: 'hub', ok: false, said: `“${to.name}” doesn’t answer: ${(e as Error).message}` }); }
    const name = this.#o.publicUrl();
    if (this.#o.name && name && name !== to.address) {
      try {
        const h = await hello(name);
        const ok = h?.id === to.id;
        checks.push({ name: 'name', ok, said: ok ? `${name} leads to “${to.name}”.` : `${name} doesn’t lead to “${to.name}” (it answers as ${h?.id === this.#o.identity.id ? 'this node' : 'another node'}).` });
      } catch (e) { checks.push({ name: 'name', ok: false, said: `${name} doesn’t answer: ${(e as Error).message}` }); }
    }
    const rep = (this.#o.role.status() as { replica?: { sync?: { last_ok_at?: string | null; refused?: string | null } | null } }).replica?.sync;
    const copying = !!rep?.last_ok_at && !rep.refused && this.#o.now().getTime() - Date.parse(rep.last_ok_at) <= Math.max(3 * this.probeMs, 30_000);
    checks.push({ name: 'copy', ok: copying, said: copying ? `This node’s copy last arrived ${rep!.last_ok_at}.` : `This node’s copy isn’t arriving${rep?.refused ? `: ${rep.refused}` : ''}.` });
    const probe: Probe = { at: this.#o.now().toISOString(), ok: checks.every((c) => c.ok), checks };
    r = this.record();
    if (!r || r.state !== 'verifying') return probe;
    r = this.#save({ ...r, probes: [...r.probes, probe].slice(-200) });
    const tail = r.probes.slice(-FAILS_TO_ROLL_BACK);
    if (tail.length === FAILS_TO_ROLL_BACK && tail.every((p) => !p.ok)) { await this.#rollBack(r); return probe; }
    if (probe.ok && Date.parse(r.verify_until!) <= this.#o.now().getTime()) await this.#passed(r);
    return probe;
  }

  // The window passed: the new hub records it, with the probe runs.
  async #passed(r: PromotionRecord): Promise<void> {
    const to = this.#o.devices.find(r.to!.id);
    const body = { id: r.id, probes: r.probes, window_s: r.window_s };
    let said = `“${to?.name ?? r.to!.name}” passed every check for ${r.window_s >= 60 ? `${Math.round(r.window_s / 60)} minutes` : `${r.window_s} seconds`}: the promotion is verified.`;
    try {
      const a = await this.#asDevice(r.to!.address!, '/api/v1/mesh/promotion/verified', body);
      if (a.status !== 200) said = `${said} “${to?.name ?? r.to!.name}” didn’t take the record (${a.body?.error ?? a.status}).`;
    } catch (e) { said = `${said} “${to?.name ?? r.to!.name}” couldn’t be told (${(e as Error).message}).`; }
    if (this.#watching) clearTimeout(this.#watching);
    this.#watching = null;
    this.#save({ ...r, state: 'verified', said });
  }

  // Step 6 failed: the same swap the other way, at a higher epoch still (Decision 2: epoch + 2 from
  // where it started), by Nova itself (tier 1), said as a problem.
  async #rollBack(r: PromotionRecord): Promise<void> {
    if (this.#watching) clearTimeout(this.#watching);
    this.#watching = null;
    const to = r.to!;
    const failing = r.probes.slice(-FAILS_TO_ROLL_BACK).flatMap((p) => p.checks.filter((c) => !c.ok).map((c) => c.said));
    r = this.#save({ ...r, state: 'rolling-back', said: 'Taking the hub back.' });
    // First the failing hub stops taking changes, so there is never a moment with two hubs; what it
    // took before it stopped is copied here first. A hub that can't be reached at all can't be asked:
    // the roll-back goes ahead, which is what it is for (a cut-off one is a limit, docs/plans/M10g.md).
    let stood: string;
    try {
      const a = await this.#callCandidate(to, 'stand-down', { id: r.id }, 5000);
      if (a.status === 200 && Number.isInteger(a.body?.head)) {
        const head = Number(a.body.head);
        const copied = await this.#until(() => this.#o.sync.cursor() >= head, 10_000);
        stood = copied ? `“${to.name}” stopped taking changes first, and this node had copied all it took (to sequence ${head}).` : `“${to.name}” stopped taking changes first; this node hadn’t copied all it took (it had ${this.#o.sync.cursor()} of ${head}), and “${to.name}” says what stayed there.`;
      } else stood = `“${to.name}” wouldn’t stop taking changes (${a.body?.error ?? a.status}).`;
    } catch (e) { stood = `“${to.name}” couldn’t be reached to stop it taking changes (${(e as Error).message}).`; }
    const back = await this.#o.role.promote({
      confirm: true, by: 'nova',
      planned: { previous: to.id, address: to.address, parent: r.parent, title: 'Promotion rolled back: this node is the hub again', goal: `“${to.name}” didn’t pass its checks after taking over (${failing[0] ?? 'it failed its probes'}), so this node takes the hub back, by itself (tier 1).` },
    });
    this.#o.ledger.resume();
    this.#task(r, 'verify', `Checks of “${to.name}” as the hub`, false, `“${to.name}” failed ${FAILS_TO_ROLL_BACK} checks in a row: ${[...new Set(failing)].join(' ')} ${stood}`, { probes: r.probes, window_s: r.window_s, stood });
    const pointed = await this.#pointName();
    this.#save({ ...r, state: 'rolled-back', said: `“${to.name}” didn’t pass its checks, so this node is the hub again, at epoch ${back.epoch}.${pointed ? ` ${pointed}` : ''}` });
    this.#o.log.problem('mesh', `“${to.name}” didn’t pass its checks after it became the hub (${failing[0] ?? 'its probes failed'}), so Nova made this node the hub again by itself, at epoch ${back.epoch}. “${to.name}” steps down when it sees that, and copies this hub.`);
    // It finds out at its next fencing round; asking it now is quicker. Nothing depends on the answer.
    if (to.address) void ask(`${to.address}/api/v1/mesh/promotion/fence`, { method: 'POST', headers: { 'x-nova': '1' }, body: {}, timeoutMs: 5000 }).catch(() => {});
  }

  // ---- the candidate's side ------------------------------------------------------------------------

  #fromHub(step: string, body: unknown): { payload: Record<string, unknown>; epoch: number } {
    const file = readRole(this.#o.home);
    const s = this.#o.devices.state();
    if (s.role !== 'standby' || !file || file.role !== 'standby' || file.device_id !== this.#o.identity.id || !s.hub_id) throw new CoreError('conflict', 'This node isn’t a standby copying a hub, so it can’t take part in a promotion.');
    const hub = this.#o.devices.find(s.hub_id);
    const key = hub?.public_key ?? (file.hub.id === s.hub_id ? file.hub.public_key : null);
    if (!key) throw new CoreError('conflict', 'This node doesn’t know its hub’s key.');
    const v = verifyCall(step, body, { hubId: s.hub_id, hubKey: key, me: this.#o.identity.id, nowS: Math.floor(this.#o.now().getTime() / 1000), seen: this.#seen });
    if (!v.ok) throw new CoreError('forbidden', v.why);
    if (v.epoch !== s.epoch) throw new CoreError('conflict', `The hub is at epoch ${v.epoch}; this node knows ${s.epoch}.`);
    return v;
  }

  #facts(): CandidateFacts {
    const s = this.#o.devices.state();
    const hw = this.#o.hardware?.() ?? { free_disk: freeDisk(this.#o.home), memory: totalmem() };
    return { id: this.#o.identity.id, role: s.role, epoch: s.epoch, hub_id: s.hub_id, version: this.#o.version, schema: this.#o.schema(), free_disk: hw.free_disk, memory: hw.memory, cursor: this.#o.sync.cursor(), demoted: !!this.#o.role.replica()?.demoted };
  }

  async #transfer(body: unknown): Promise<unknown> {
    const v = this.#fromHub('transfer', body);
    const signed = v.payload.handover as SignedHandover | undefined;
    const s = this.#o.devices.state();
    const hub = this.#o.devices.find(s.hub_id!);
    if (!hub || !signed || !verifyHandover(signed, hub.public_key)) throw new CoreError('forbidden', 'The handover isn’t signed by the hub’s key.');
    tap('handover', signed);
    const h = signed.handover;
    if (h.from !== hub.id || h.to !== this.#o.identity.id) throw new CoreError('forbidden', 'The handover doesn’t name this node.');
    if (h.epoch !== s.epoch + 1) throw new CoreError('conflict', `The handover is for epoch ${h.epoch}; this node is at ${s.epoch}, so it would be ${s.epoch + 1}.`);
    if (this.#o.sync.cursor() < h.last_seq) throw new CoreError('conflict', `This node has copied up to ${this.#o.sync.cursor()}, not the handover’s ${h.last_seq}.`);
    const at = this.#o.now().toISOString();
    const r: PromotionRecord = {
      v: 1, id: h.id, kind: 'planned', side: 'to', state: 'transferring', from: this.#peer(hub, h.from_address), to: this.#peer(this.#o.devices.find(this.#o.identity.id), this.#o.address()),
      epoch_from: s.epoch, epoch_to: h.epoch, last_seq: h.last_seq, window_s: this.windowS, verify_until: null, probes: [], parent: h.parent, said: null, started_at: at, updated_at: at,
    };
    this.#save(r);
    let p: Awaited<ReturnType<MeshRole['promote']>>;
    try {
      p = await this.#o.role.promote({
      confirm: true, by: `device:${hub.id}`,
      planned: { previous: hub.id, address: h.from_address, parent: h.parent, title: 'Hub handed over to this node', goal: `Take the hub’s role from “${hub.name}”, as it handed over at sequence ${h.last_seq} (its signed handover, checked with its key).` },
      });
    } catch (e) {
      this.#save({ ...r, state: 'failed', said: `This node couldn’t take the role: ${(e as Error).message}` });
      throw e;
    }
    const pointed = await this.#pointName();
    this.#save({ ...r, state: 'verifying', verify_until: new Date(this.#o.now().getTime() + this.windowS * 1000).toISOString(), said: `This node is the hub at epoch ${p.epoch}.${pointed ? ` ${pointed}` : ''}` });
    this.#o.log.info('mesh', 'This node took the hub’s role, handed over.', { promotion: h.id, epoch: p.epoch, from: hub.id });
    return { roster: p.roster, epoch: p.epoch, task: p.task.id, handover: signed };
  }

  // A roll-back (on the new hub): the old hub, its standby, failed it and asks it to stop taking
  // changes before it takes the role back. It holds writes now, keeps fencing (it steps down when it
  // sees the old hub at the higher epoch) and says how far its log goes, so the old hub can copy it all.
  #standDown(body: unknown): unknown {
    const r = this.record();
    const s = this.#o.devices.state();
    if (s.role !== 'hub' || !r || r.side !== 'to' || !r.from || s.standby_id !== r.from.id) throw new CoreError('conflict', 'This node isn’t a hub that took the role from its standby.');
    const from = this.#o.devices.find(r.from.id);
    if (!from || from.trust !== 'trusted') throw new CoreError('forbidden', 'That node isn’t trusted here.');
    const v = verifyCall('stand-down', body, { hubId: from.id, hubKey: from.public_key, me: this.#o.identity.id, nowS: Math.floor(this.#o.now().getTime() / 1000), seen: this.#seen });
    if (!v.ok) throw new CoreError('forbidden', v.why);
    if (v.epoch !== s.epoch || v.payload.id !== r.id) throw new CoreError('conflict', 'That isn’t this node’s promotion.');
    this.#o.role.hold(`Nova is giving the hub back to “${from.name}”, so changes wait a moment. Try again in a minute${this.#o.publicUrl() ? `, at ${this.#o.publicUrl()}` : ''}.`, { fence: true });
    this.#o.sync.setLogging(false);
    this.#o.role.emit('draining', { promotion: r.id });
    this.#save({ ...r, said: `“${from.name}” found this hub failing its checks and is taking the role back; this node takes no changes meanwhile.` });
    // It steps down once it sees the old hub at the higher epoch; asked again here in case no nudge
    // comes. After two minutes: an old hub that answers as the standby didn't take the role, and this
    // node carries on; one that can't be reached leaves this node holding (it can't tell), said once.
    const since = Date.now();
    let told = false;
    const look = setInterval(() => {
      if (this.#o.role.role() !== 'hub' || this.#closed) { clearInterval(look); return; }
      void this.#o.role.fence().catch(() => {});
      if (Date.now() - since < 120_000) return;
      void ask(`${r.from!.address}/api/v1/mesh/hello`, { timeoutMs: 3000 }).then((a) => {
        if (this.#o.role.role() !== 'hub') return;
        if (a.status === 200 && a.body?.id === from.id && a.body.role === 'standby') {
          clearInterval(look);
          this.#o.role.release();
          this.#o.sync.setLogging(true);
          this.#o.role.emit('resumed', {});
          this.#o.log.problem('mesh', `“${from.name}” asked this hub to stop taking changes so it could take the role back, then didn’t. This node carries on as the hub.`);
        }
      }, () => {
        if (told) return;
        told = true;
        this.#o.log.problem('mesh', `“${from.name}” asked this hub to stop taking changes so it could take the role back, and can’t be reached now. Nova keeps refusing changes here until it knows which node is hub. If “${from.name}” is gone for good, restart Nova here and it carries on as the hub.`);
      });
    }, 2000);
    look.unref?.();
    return { held: true, head: this.#o.sync.head() };
  }

  // The node that became hub points the stable name at itself.
  async #pointName(): Promise<string | null> {
    const n = this.#o.name;
    const me = this.#o.address();
    if (!n || !me) return null;
    const r = await n.point(me);
    if (!r.ok) this.#o.log.problem('mesh', r.said);
    return r.said;
  }

  #verified(body: Record<string, unknown>, from: Device): unknown {
    const r = this.record();
    if (!r || r.side !== 'to' || r.id !== body.id || r.from?.id !== from.id) throw new CoreError('conflict', 'This node isn’t waiting for that promotion’s checks.');
    if (r.state !== 'verifying') return { state: r.state };
    const probes = Array.isArray(body.probes) ? (body.probes as Probe[]).slice(-200) : [];
    const ok = probes.length > 0 && probes.at(-1)!.ok === true;
    this.#task(r, 'verify', `Checks of this node as the hub`, ok, ok ? `“${from.name}” checked this hub ${probes.length} times over ${r.window_s} seconds; the last check passed.` : 'The checks didn’t pass.', { probes, window_s: Number(body.window_s) || r.window_s, by: from.id });
    this.#save({ ...r, state: ok ? 'verified' : r.state, probes, said: ok ? 'The promotion is verified.' : r.said });
    return { state: ok ? 'verified' : r.state };
  }

  // ---- the emergency variant (on the candidate) ------------------------------------------------

  async coldView(o: { folder?: unknown } = {}) {
    const me = this.#o.identity.id;
    const s = this.#o.devices.state();
    const reasons: string[] = [];
    const file = readRole(this.#o.home);
    if (s.role === 'hub') reasons.push('This node is the hub.');
    const live = s.role === 'standby' && !!file && file.role === 'standby' && file.device_id === me && this.#o.sync.cursor() > 0;
    if (live) reasons.push('This node is the standby, with a live copy of the hub: use “Make this the hub” instead, which keeps everything it copied.');
    // A hub that answers anywhere is no case for a cold promotion.
    const hub = await this.#anyHub();
    if (hub) reasons.push(`A hub answers at ${hub.url} (epoch ${hub.epoch}). An emergency promotion is only for when the hub can’t be reached.`);
    const folder = typeof o.folder === 'string' && o.folder ? o.folder : this.#o.cold.folder();
    const backup = folder ? latestBackup(folder, this.#o.cold.seal()) : null;
    if (!folder) reasons.push('There is no backup folder set, and none was given.');
    else if (!backup) reasons.push(`There is no backup Nova can use in ${folder}.`);
    let epochBackup: number | null = null;
    let pinned = false;
    if (backup) {
      const b = backupState(backup.path, me, this.#o.identity.publicKey);
      epochBackup = b.epoch;
      pinned = b.pinned;
      if (!pinned) reasons.push('This node’s key isn’t in that backup as a trusted hub candidate, so devices holding a roster from then wouldn’t accept it as hub.');
      if (backup.schema_version > this.#o.schema()) reasons.push(`The backup was made by a newer Nova (database version ${backup.schema_version}).`);
    }
    const r = this.record();
    const floor = Math.max(s.epoch, epochBackup ?? 0, r?.epoch_to ?? 0);
    const facts: ColdFacts = {
      backup, epoch_now: s.epoch, epoch_backup: epochBackup, epoch_new: backup ? floor + 1 : null, pinned,
      lost: backup ? LOST_WORDS(backup.at) : 'Not known: there is no backup to restore.', connectors: CONNECTOR_WORDS, devices: DEVICE_WORDS,
    };
    return { eligible: reasons.length === 0, reasons, facts, sheet: coldSheet(facts, { name: this.#stable() }), folder };
  }

  // Probes every address a hub might answer at: the role file's hub, the stable name, every trusted peer.
  async #anyHub(): Promise<{ url: string; epoch: number } | null> {
    const me = this.#o.identity.id;
    const urls = new Set<string>();
    const file = readRole(this.#o.home);
    if (file?.hub.url) urls.add(file.hub.url);
    const name = this.#o.publicUrl();
    if (name && name !== this.#o.address()) urls.add(name.replace(/\/+$/, ''));
    for (const d of this.#o.devices.list()) if (d.id !== me && d.trust === 'trusted' && d.address) urls.add(d.address.replace(/\/+$/, ''));
    const found = await Promise.all([...urls].map(async (url) => {
      try {
        const a = await ask(`${url}/api/v1/mesh/hello`, { timeoutMs: 3000 });
        return a.status === 200 && a.body?.role === 'hub' && a.body?.id !== me ? { url, epoch: Number(a.body.epoch) } : null;
      } catch { return null; }
    }));
    return found.find((x) => x) ?? null;
  }

  async cold(o: { confirm: boolean; folder?: unknown; by: string }) {
    if (!o.confirm) throw new CoreError('validation', 'An emergency promotion restores a backup and loses everything written after it: it needs your explicit confirmation every time (tier 3). Send confirm: true.');
    if (this.#running) throw new CoreError('conflict', 'A promotion is already under way.');
    const v = await this.coldView({ folder: o.folder });
    if (!v.eligible) throw new CoreError('conflict', `Nova didn’t promote this node: ${v.reasons[0]}`, v.reasons);
    const b = v.facts.backup!;
    const at = this.#o.now().toISOString();
    const id = randomUUID();
    const drill = await this.#o.cold.drill(b.path);
    if (!drill.ok) {
      const bad = drill.checks.filter((c) => !c.ok).map((c) => c.said);
      throw new CoreError('conflict', `Nova didn’t promote this node: the backup of ${b.at} didn’t pass its restore drill. ${bad[0] ?? ''}`.trim(), bad);
    }
    const marker: ColdMarker = { node: this.#o.identity.id, floor: v.facts.epoch_new!, promotion: id, backup: b, drill: drill.checks, by: o.by };
    const restoreId = this.#o.cold.stage(b.path, marker);
    this.#save({
      v: 1, id, kind: 'cold', side: 'to', state: 'staged', from: null, to: this.#peer(this.#o.devices.find(this.#o.identity.id), this.#o.address()),
      epoch_from: v.facts.epoch_now, epoch_to: v.facts.epoch_new, last_seq: null, window_s: this.windowS, verify_until: null, probes: [], parent: null,
      said: `Restoring the backup of ${b.at}; Nova restarts and comes back as the hub at epoch ${v.facts.epoch_new}.`, restore_id: restoreId, cold: v.facts, started_at: at, updated_at: at,
    });
    const restart = await this.#o.cold.restart('an emergency promotion from a backup', (e) => {
      const r = this.record();
      if (r?.id === id) this.#save({ ...r, state: 'failed', said: `Nova couldn’t restart to finish it (${e.message}). Nothing changed.` });
    });
    return { staged: true, promotion: id, backup: b, drill: drill.checks, epoch: v.facts.epoch_new, sheet: v.sheet, restart };
  }

  // After the restart that applied the backup: the chain in the ledger (the drill, the restore, the
  // role), the stable name pointed here, and the person told what to do about connectors.
  async #afterCold(r: PromotionRecord): Promise<void> {
    const s = this.#o.devices.state();
    const applied = s.role === 'hub' && s.hub_id === this.#o.identity.id && s.epoch >= (r.epoch_to ?? Infinity);
    if (!applied) { this.#save({ ...r, state: 'failed', said: 'The backup wasn’t applied at the restart, so this node isn’t the hub. Nothing changed.' }); return; }
    const b = r.cold!.backup!;
    const parent = this.#task(r, 'cold', `Emergency promotion from the backup of ${b.at}`, true, `The backup of ${b.at} (number ${b.seq}) passed its restore drill and was restored here; this node is the hub at epoch ${s.epoch}. Everything written after ${b.at} isn’t in it. Connectors need signing in again: the backup never holds the vault’s key.`, { backup: b, drill: (r.cold as ColdFacts & { drill?: Check[] }).drill ?? null, restore_id: r.restore_id, epoch: s.epoch, keys: 'this node’s own' }, null);
    r = this.#save({ ...r, parent: parent.id });
    this.#o.ledger.create({
      title: 'Promoted from a backup: this node is the hub', owner: 'mesh', origin: { kind: 'user', ref: 'mesh:promotion:cold' }, parent_id: parent.id,
      goal: `This node is the hub at epoch ${s.epoch}, with a roster signed by its own key.`,
      evidence_required: [{ kind: 'confirmation', note: 'This node is hub at the new epoch, and the roster is signed by its key.' }],
      privacy_mode: 'local-only', approval_tier: 0, idempotency_key: `mesh:promote:${this.#o.identity.id}:${s.epoch}`, user_visibility: 'attention',
      inputs: { epoch: s.epoch, roster: this.#o.devices.roster(), previous_hub: null, by: 'cold-promotion', auto: false, cold: true },
    });
    void this.#o.ledger.pump();
    const pointed = await this.#pointName();
    this.#save({ ...r, state: 'done', said: `This node is the hub at epoch ${s.epoch}, from the backup of ${b.at}.${pointed ? ` ${pointed}` : ''}` });
    this.#o.log.problem('mesh', `This node became the hub from the backup of ${b.at}. Everything written after that isn’t in it. ${CONNECTOR_WORDS}`);
  }

  // ---- ledger records ------------------------------------------------------------------------------

  #key(id: string, step: string) { return `mesh:promotion:${id}:${step}`; }

  #task(r: PromotionRecord, step: string, title: string, ok: boolean, said: string, inputs: Record<string, unknown>, parent: string | null = r.parent): Task {
    const key = this.#key(r.id, step);
    const had = this.#o.db.get<{ id: string }>('SELECT id FROM task WHERE idempotency_key = ?', key);
    if (had) return this.#o.ledger.get(had.id);
    const t = this.#o.ledger.create({
      title, owner: PROMOTION_WORKER, origin: { kind: 'user', ref: `mesh:promotion:${r.kind}` }, goal: `${title}: ${said}`,
      evidence_required: [{ kind: 'confirmation', note: 'This step’s result, read back by Nova.' }],
      privacy_mode: 'local-only', approval_tier: 0, idempotency_key: key, user_visibility: ok ? 'handling' : 'attention',
      ...(parent ? { parent_id: parent } : {}),
      inputs: { promotion: r.id, step, ok, said, from: r.from?.id ?? null, to: r.to?.id ?? null, ...inputs },
    });
    void this.#o.ledger.pump();
    return t;
  }

  async #settled(id: string): Promise<void> {
    for (let i = 0; i < 200 && !this.#closed && !TERMINAL.includes(this.#o.ledger.get(id).state); i++) await new Promise((r) => setTimeout(r, 25));
  }

  readonly worker: LanedWorker = {
    id: PROMOTION_WORKER, name: 'Hub promotion', about: 'Records each step of a hub promotion, planned or from a backup, with what it found.', egress: 'none', evidence: ['confirmation'],
    health: () => ({ ok: true }),
    lane: () => ({ key: 'promotion', max: 1 }),
    run: async (brief: Brief): Promise<Report> => {
      const i = (brief.inputs ?? {}) as { ok?: boolean; said?: string; promotion?: string; step?: string };
      const base = { envelope: ENVELOPE_VERSION as typeof ENVELOPE_VERSION, task_id: brief.task_id, artifacts: [] as Report['artifacts'], blockers: [] as string[], usage: { duration_ms: 0 }, follow_up_suggestions: [] as string[] };
      if (i.ok !== true) return { ...base, status: 'failed', summary: String(i.said ?? 'This step didn’t pass.'), evidence: [] };
      return { ...base, status: 'done', summary: String(i.said ?? 'Done.'), evidence: [{ kind: 'confirmation', system: PROMOTION_SYSTEM, id: `${i.promotion}:${i.step}` }] };
    },
  };

  // Nova checks each step's claim for itself, against what it can read: the pre-checks all passed;
  // the copy reached the sequence; the drained work isn't running here; the old hub copies this one;
  // the probes passed; the emergency promotion's backup passed its drill and this node is hub.
  #confirm(e: { kind: string; system?: string; id?: string }, brief: Brief): { ok: boolean; why: string } {
    const i = (brief.inputs ?? {}) as Record<string, unknown>;
    if (e.id !== `${i.promotion}:${i.step}`) return { ok: false, why: `The confirmation names ${e.id}, not this step.` };
    const s = this.#o.devices.state();
    switch (i.step) {
      case 'checks': {
        const checks = (i.checks ?? []) as Check[];
        return checks.length && checks.every((c) => c.ok) ? { ok: true, why: `Every one of the ${checks.length} pre-checks passed: ${checks.map((c) => c.name).join(', ')}.` } : { ok: false, why: 'Not every pre-check passed.' };
      }
      case 'catchup': {
        const head = Number(i.head);
        const acked = Number(i.acked);
        return acked >= head ? { ok: true, why: `The candidate acknowledged sequence ${acked}, at least the head ${head} when it was asked.` } : { ok: false, why: `It acknowledged ${acked}, short of ${head}.` };
      }
      case 'drain': {
        const handed = (i.handed ?? []) as string[];
        const finished = (i.finished ?? []) as string[];
        return { ok: true, why: `${finished.length} finished, ${handed.length} handed over (left active for the next hub’s recovery); nothing new started while it drained.` };
      }
      case 'demote': {
        const ok = s.role === 'hub' && s.standby_id === i.standby && Number(i.acked) >= Number(i.last_seq);
        return ok ? { ok, why: `This hub’s standby is the old hub, which acknowledged sequence ${i.acked} (the hand-over was at ${i.last_seq}).` } : { ok, why: 'The old hub isn’t this hub’s standby, or hasn’t copied past the hand-over.' };
      }
      case 'verify': {
        const probes = (i.probes ?? []) as Probe[];
        const ok = probes.length > 0 && probes.at(-1)!.ok;
        return ok ? { ok, why: `${probes.length} probes over ${i.window_s} s; the last passed.` } : { ok, why: 'The probes didn’t pass.' };
      }
      case 'cold': {
        const b = i.backup as FoundBackup | undefined;
        const ok = s.role === 'hub' && s.hub_id === this.#o.identity.id && s.epoch >= Number(i.epoch) && !!b;
        return ok ? { ok, why: `Nova read its own mesh state: hub at epoch ${s.epoch}, from backup ${b!.seq} (${b!.at}), with its own keys.` } : { ok, why: 'This node isn’t the hub at that epoch.' };
      }
    }
    return { ok: false, why: 'Not a step Nova records.' };
  }

  // ---- routes ---------------------------------------------------------------------------------------

  #peer(d: Device | null, address: string | null): Peer | null {
    return d ? { id: d.id, name: d.name, address: address?.replace(/\/+$/, '') ?? null, public_key: d.public_key, x25519_public_key: d.x25519_public_key } : null;
  }

  async #callCandidate(d: { id: string; address: string | null }, step: string, payload: Record<string, unknown>, timeoutMs: number) {
    const time = (this.#lastTime = Math.max(Math.floor(this.#o.now().getTime() / 1000), this.#lastTime + 1));
    const body = signCall(this.#o.identity, step, d.id, this.#o.devices.state().epoch, payload, time);
    const a = await ask(`${d.address!.replace(/\/+$/, '')}/api/v1/mesh/promotion/${step}`, { method: 'POST', headers: { 'x-nova': '1' }, body, timeoutMs });
    tap(`${step}-answer`, a.body);
    return a;
  }

  // A call to the new hub as this node (its standby): a session signed with this node's key.
  async #asDevice(base: string, path: string, body: unknown) {
    const me = this.#o.identity.id;
    const time = (this.#lastTime = Math.max(Math.floor(this.#o.now().getTime() / 1000), this.#lastTime + 1));
    const s = await ask(`${base}/api/v1/mesh/session`, { method: 'POST', headers: { 'x-nova': '1' }, body: { device_id: me, time, signature: this.#o.identity.sign(sessionMessage(me, time)) }, timeoutMs: 5000 });
    if (s.status !== 200 || typeof s.body?.token !== 'string') return s;
    return ask(`${base}${path}`, { method: 'POST', headers: { 'x-nova': '1', authorization: `Bearer ${s.body.token}` }, body, timeoutMs: 10_000 });
  }

  async #until(done: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (!this.#closed && Date.now() < end) {
      try { if (done()) return true; } catch { /* closing */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    try { return done(); } catch { return false; }
  }

  routes(): Route[] {
    return [
      { method: 'GET', path: '/mesh/promotion', summary: 'The promotion this node is part of, if any: its state, each step’s ledger task, and the verification window.', handle: () => this.view() },
      {
        method: 'POST', path: '/mesh/promotions/check', access: 'approver', body: '{device_id}',
        summary: 'What promoting this device to hub would do, and each pre-check in words (tier 0: nothing changes).',
        handle: async ({ body }) => { const c = await this.check(body.device_id); return { ok: c.ok, checks: c.checks, sheet: c.sheet, device: c.device ? { id: c.device.id, name: c.device.name } : null }; },
      },
      {
        method: 'POST', path: '/mesh/promotions', status: 202, access: 'approver', body: '{device_id, confirm}',
        summary: 'Hand the hub’s role to this hub candidate (tier 3: needs {confirm: true}, every time): pre-checks, catch-up, drain, transfer, demotion, then a verification window with an automatic roll-back.',
        handle: ({ body, who }) => this.start_(body.device_id, { confirm: body.confirm === true, by: who.principal.kind === 'device' ? `device:${who.principal.device.id}` : who.principal.kind }),
      },
      {
        method: 'GET', path: '/mesh/promotion/cold', access: 'approver',
        summary: 'Whether this node can become the hub from the latest backup, and what that loses, in the sheet’s words (tier 0). ?folder= names a backup folder.',
        handle: ({ query }) => this.coldView({ folder: query.get('folder') }),
      },
      {
        method: 'POST', path: '/mesh/promotion/cold', status: 202, access: 'approver', body: '{confirm, folder?}',
        summary: 'Make this node the hub from the latest backup, when the hub can’t be reached (tier 3: {confirm: true}, every time). The backup’s restore drill runs first; Nova restarts to apply it.',
        handle: ({ body, who }) => this.cold({ confirm: body.confirm === true, folder: body.folder, by: who.principal.kind === 'device' ? `device:${who.principal.device.id}` : who.principal.kind }),
      },
      // The candidate's side, signed by its hub (public: the signature is the authority).
      { method: 'POST', path: '/mesh/promotion/ready', access: 'public', body: '{auth, payload}', summary: 'The hub asks its standby about itself before a promotion (signed by the hub’s key).', handle: ({ body }) => { this.#fromHub('ready', body); return this.#facts(); } },
      { method: 'POST', path: '/mesh/promotion/stand-down', access: 'public', body: '{auth, payload: {id}}', summary: 'A roll-back: the old hub, this hub’s standby, asks it to stop taking changes before it takes the role back (signed by the old hub’s key).', handle: ({ body }) => this.#standDown(body) },
      { method: 'POST', path: '/mesh/promotion/transfer', access: 'public', body: '{auth, payload: {handover}}', summary: 'The hub hands its role to this standby (signed by the hub’s key, with a handover signed by it): this node becomes the hub at the next epoch and answers with its own signed roster.', handle: ({ body }) => this.#transfer(body) },
      {
        method: 'POST', path: '/mesh/promotion/fence', access: 'public', summary: 'Asks this node to check now whether another node is hub at a higher epoch (fencing). Nothing is taken on trust: it checks for itself.',
        handle: async () => {
          const now = Date.now();
          if (now - this.#lastFence < 2000) return { checked: false };
          this.#lastFence = now;
          const f = await this.#o.role.fence();
          return { checked: true, demoted: f.demoted };
        },
      },
      {
        method: 'POST', path: '/mesh/promotion/verified', access: 'sync', body: '{id, probes, window_s}',
        summary: 'The old hub, now this hub’s standby, says the verification window passed, with its probe runs.',
        handle: ({ body, who }) => { if (who.principal.kind !== 'device') throw new CoreError('forbidden', 'Only the standby says this.'); return this.#verified(body, who.principal.device); },
      },
    ];
  }
}

// ---- helpers --------------------------------------------------------------------------------------

// The home's size, as the pre-check counts it: everything but what stays local (checkpoints, backups).
export function homeBytes(home: string): number {
  let n = 0;
  const walk = (dir: string, top: boolean) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (top && (e.name === 'checkpoints' || e.name === 'backups' || e.name === 'logs')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, false);
      else if (e.isFile()) { try { n += statSync(p).size; } catch { /* gone */ } }
    }
  };
  walk(home, true);
  return n;
}

export function freeDisk(dir: string): number | null {
  try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

// The newest backup folder Nova made (by sequence, never by date) in `folder`: its manifest names
// it; its seal is checked when this node's vault holds the seal's key (`sealed` null otherwise).
export function latestBackup(folder: string, sealKey: Buffer | null): FoundBackup | null {
  let names: string[] = [];
  try { names = readdirSync(folder); } catch { return null; }
  const found: FoundBackup[] = [];
  for (const n of names) {
    const m = /^nova-backup-(\d{6,})$/.exec(n);
    if (!m) continue;
    try {
      const man = JSON.parse(readFileSync(join(folder, n, 'manifest.json'), 'utf8')) as { id: string; seq: number; at: string; nova_version: string; schema_version: number; seal?: string };
      if (man.id !== n || man.seq !== Number(m[1]) || !existsSync(join(folder, n, 'nova.db'))) continue;
      let ok: boolean | null = null;
      if (sealKey) {
        ok = sealed(man as unknown as Manifest, sealKey);
        if (!ok) continue;
      }
      found.push({ path: join(folder, n), id: man.id, seq: man.seq, at: man.at, nova_version: man.nova_version, schema_version: man.schema_version, sealed: ok });
    } catch { /* not a backup */ }
  }
  return found.sort((a, b) => b.seq - a.seq)[0] ?? null;
}

// What the backup's own database says: its epoch, and whether this node's key is in it as a trusted
// hub candidate (or the standby, which is one).
export function backupState(backupDir: string, me: string, publicKey: string): { epoch: number | null; pinned: boolean; hub: string | null } {
  const d = new DatabaseSync(join(backupDir, 'nova.db'), { readOnly: true });
  try {
    const s = d.prepare('SELECT epoch, hub_id FROM mesh_state WHERE id = 1').get() as { epoch: number; hub_id: string | null } | undefined;
    const row = d.prepare('SELECT trust, public_key, purposes, kind FROM device WHERE id = ?').get(me) as { trust: string; public_key: string; purposes: string | null; kind: string } | undefined;
    let purposes: string[] = [];
    try { purposes = JSON.parse(row?.purposes ?? '[]') as string[]; } catch { /* none */ }
    const pinned = !!row && row.trust === 'trusted' && row.public_key === publicKey && (purposes.includes('hub-candidate') || row.kind === 'standby');
    return { epoch: s?.epoch ?? null, pinned, hub: s?.hub_id ?? null };
  } finally {
    d.close();
  }
}

