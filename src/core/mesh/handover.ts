// Hub promotion as a first-class process (M10g; docs/plans/M10g.md, the orchestration ADR's Point 10,
// the owner's Decisions 2 and 5). Two variants, both tier 3, every step a ledger task in one chain:
//
//  - Planned ("Promote to hub" in Settings › Devices): the hub drives its live standby through
//    pre-checks, catch-up, drain, transfer, demotion and a verification window. It takes the role
//    back by itself (tier 1) at epoch + 2 only on positive evidence: the new hub, reached and
//    authenticated, says it is failing, and then acknowledges standing down (M10g review, finding 1).
//    A new hub that merely can't be reached stays the hub; the person is told, and can take the hub
//    back at tier 3, with the risk said plainly. The hub talks to the candidate
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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
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
export const SEEN_FILE = join('mesh', 'seen-epochs.json');
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

// What the other node answers with authority (its health, that it stood down, whether it took a
// hand-over) is signed by its own pinned key, so a forwarder in between can't make either node act.
export interface SignedAnswer<T> { body: T; signature: string }
const answerMessage = (kind: string, body: unknown) => Buffer.from(`nova-promotion-answer-v1|${kind}|${canonicalJson(body)}`, 'utf8');
export const signAnswer = <T>(identity: MeshIdentity, kind: string, body: T): SignedAnswer<T> => ({ body, signature: identity.sign(answerMessage(kind, body)) });
export const verifyAnswer = (kind: string, a: unknown, key: string): boolean => {
  const x = a as SignedAnswer<unknown> | null;
  return !!x && typeof x === 'object' && x.body !== undefined && typeof x.signature === 'string' && verifyDeviceSignature(key, answerMessage(kind, x.body), x.signature);
};

// Tests and the drill run with a short window and fast probes; nothing else may (M10g review,
// finding 10). Both must hold: the test runner or the drill says so (NODE_TEST_CONTEXT, NOVA_DRILL=1),
// and the home is a temp folder. Otherwise the window is never shorter than the ADR's 30 minutes.
export const PROBE_MIN_MS = 5000;
export function testing(home: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.NODE_TEST_CONTEXT && env.NOVA_DRILL !== '1') return false;
  try { return realpathSync(home).startsWith(`${realpathSync(tmpdir())}/`); } catch { return false; }
}

// ---- the stable mesh name -----------------------------------------------------------------------

export interface StableName { name: string; point(address: string): Promise<{ ok: boolean; said: string }> }

// A driver that moves the name by asking an HTTP endpoint to point it at an address. In this build
// that endpoint is only ever a loopback stand-in the drill runs (Hard limits: no DNS, tailnet or
// router change is made). A real DNS or tailnet driver is the owner's call.
// The endpoint must be https, or http on this machine (loopback), and every request carries a token
// (NOVA_MESH_NAME_TOKEN) the endpoint checks: an unauthenticated POST must never move the name.
export function httpStableName(control: string, name: string, token: string | null | undefined): StableName | null {
  let u: URL;
  try { u = new URL(control); } catch { return null; }
  const loopback = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(u.hostname);
  if (!token || token.length < 16 || (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback))) return null;
  return {
    name,
    async point(address) {
      try {
        const r = await ask(control, { method: 'POST', headers: { 'x-nova': '1', authorization: `Bearer ${token}` }, body: { name, address }, timeoutMs: 5000 });
        return r.status >= 200 && r.status < 300 ? { ok: true, said: `${name} now points at ${address}.` } : { ok: false, said: `Moving ${name} was refused (${r.body?.error ?? r.status}).` };
      } catch (e) {
        return { ok: false, said: `Nova couldn’t reach what moves ${name}: ${(e as Error).message}` };
      }
    },
  };
}

// ---- the record --------------------------------------------------------------------------------

export type PromotionState = 'checking' | 'catching-up' | 'draining' | 'holding' | 'transferring' | 'verifying' | 'verified' | 'rolling-back' | 'rolled-back' | 'stepped-down' | 'failed' | 'refused' | 'staged' | 'done' | 'declined' | 'cancelled' | 'ended';
// A probe's result: the new hub, reached and authenticated, says it is well (`ok`) or failing
// (`unhealthy`); or nothing authenticated came back (`unknown`), which is never evidence either way.
export interface Probe { at: string; ok: boolean; result?: 'ok' | 'unhealthy' | 'unknown'; checks: Check[] }
export interface Peer { id: string; name: string; address: string | null; public_key: string; x25519_public_key: string }
// This node's own record of the promotion it is part of (mesh/promotion.json, mode 0600; mesh/ stays
// on its node). The ledger tasks, replicated, are the shared record; this is what each end needs to
// carry on after a restart.
export interface PromotionRecord {
  v: 1; id: string; kind: 'planned' | 'cold'; side: 'from' | 'to'; state: PromotionState;
  from: Peer | null; to: Peer | null; epoch_from: number; epoch_to: number | null; last_seq: number | null;
  window_s: number; verify_until: string | null; probes: Probe[]; parent: string | null; said: string | null;
  restore_id?: string | null; cold?: ColdFacts | null; started_at: string; updated_at: string;
  // Said once each: the new hub can't be reached, the hand-over's outcome is unknown.
  told?: string[];
}

// ---- the emergency sheet ------------------------------------------------------------------------

export interface FoundBackup { path: string; id: string; seq: number; at: string; nova_version: string; schema_version: number; sealed: boolean | null }
export interface ColdFacts {
  backup: FoundBackup | null; epoch_now: number; epoch_backup: number | null; epoch_new: number | null; pinned: boolean; lost: string; connectors: string; devices: string;
  // The newest roster any of this node's devices showed it (M10g review, finding 2), and how many did.
  seen?: { max: number | null; count: number };
  // When this node's own copy was last brought up to date (the newest change it holds), for what a
  // restore can't know (finding 8).
  copy_at?: string | null;
}

export interface Fact { label: string; text: string }

// The words the person reads before an emergency promotion (Decision 5: the backup's time, what was
// lost, connectors), built here so the claims register reads one file (tests/evals/claims.ts).
export function coldSheet(f: ColdFacts, o: { name: string | null; window?: string }): Fact[] {
  const b = f.backup;
  const seen = f.seen ?? { max: null, count: 0 };
  const epoch = !f.epoch_new ? 'Not known yet.'
    : seen.count
      ? `This node becomes the hub at epoch ${f.epoch_new}: higher than its own record (${f.epoch_now}), the backup’s (${f.epoch_backup ?? 'none'}) and the newest roster your devices have shown it (epoch ${seen.max}, from ${seen.count === 1 ? 'one device' : `${seen.count} devices`}). A device that saw a newer one hasn’t told this node.`
      : `This node becomes the hub at epoch ${f.epoch_new}: higher than its own record (${f.epoch_now}) and the backup’s (${f.epoch_backup ?? 'none'}). None of your devices has shown this node its roster, so Nova can’t tell whether the old hub is still running somewhere. If it is, your devices follow whichever hub has the higher epoch, and when the two meet, the lower one steps down (at an equal epoch, a fixed rule picks one).`;
  return [
    { label: 'The backup', text: b ? `Backup ${b.seq}, made ${b.at}.${b.sealed ? ' Nova checked its seal: Nova made it.' : ' Nova couldn’t check its seal here (the seal’s key is in a vault this node doesn’t hold), so it can’t prove Nova made it; the restore drill checks every file against the backup’s own manifest, which shows the backup is whole, not who wrote it.'}` : 'There is no backup Nova can use.' },
    { label: 'What is lost', text: f.lost },
    { label: 'What may come back', text: `Devices revoked and memories forgotten stay that way when the backup or this node knew of it${f.copy_at ? ` (this node’s own copy is from ${f.copy_at})` : ''}. Anything revoked or forgotten on the old hub after that isn’t known here: check Settings › Devices and Memory afterwards.` },
    { label: 'Connectors', text: f.connectors },
    { label: 'Devices', text: f.devices },
    { label: 'Epoch', text: epoch },
    { label: 'The stable name', text: o.name ? `Devices look for the hub at ${o.name}. ${o.window ?? ''}`.trim() : 'This hub has no stable name, so devices look for it at the addresses their roster lists.' },
    { label: 'Why it asks', text: TIER3 },
  ];
}

export const LOST_WORDS = (at: string) => `Everything written after ${at}: changes, conversations, memories and tasks from then on are not in the backup.`;
export const CONNECTOR_WORDS = 'Connectors need signing in again. Backups never hold the key to your saved secrets, so they can’t be opened from this backup. The key stays only where it already was: on the old hub, on a standby that copied it, and in their own checkpoints, which never leave those computers.';
export const DEVICE_WORDS = 'Devices paired before the backup find this node without pairing again: its key is in the roster they hold. A device paired after it needs pairing again.';

// The planned sheet's facts, around the pre-checks.
export function plannedSheet(o: { device: Device; checks: Check[]; windowS: number; name: string | null; driver: boolean; hub: string }): Fact[] {
  const window = o.windowS >= 60 ? `${Math.round(o.windowS / 60)} minutes` : `${o.windowS} seconds`;
  return [
    { label: 'What happens', text: `Nova copies the last changes to “${o.device.name}”, lets running work finish (or hands it over), holds new changes for a moment, and then “${o.device.name}” becomes the hub. This hub becomes its standby, keeping a live copy.` },
    { label: 'Devices', text: o.name ? `They look for the hub at ${o.name}, ${o.driver ? 'which Nova points at the new hub' : `which you point at the new hub yourself: Nova can’t move it here`}. Computers also follow the roster. None is paired again.` : 'Computers follow the roster; phones and browsers sign in again at the new hub’s address. None is paired again.' },
    { label: 'Keys', text: 'Each computer keeps its own keys. The new hub signs a new roster with the key you pinned when you made it a candidate.' },
    { label: 'Checking it', text: `For ${window} this hub checks the new one. If the new hub says it is failing and stops taking changes, Nova makes this hub the hub again by itself and tells you. If it just can’t be reached, it stays the hub, and you can take the hub back here yourself.` },
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
  // Requests that passed the write gate and haven't answered yet (finding 5): the hold waits for them.
  inflight?: () => number;
  // Device sessions don't write their last-seen time while writes are held, so the log shows only
  // real changes.
  quiet?: (on: boolean) => void;
  // A named checkpoint of this home, kept on this node until the person deletes it: where changes a
  // node can't carry over are kept rather than thrown away (finding 1). Throws when it can't.
  keep?: (name: string) => { id: string; label: string };
  // The ledger stops starting work, without stopping what runs (a restart while holding: finding 4).
  pause?: (keep: (t: Task) => boolean) => void;
}

export const KEEP_OWNERS = (t: Task) => t.owner === PROMOTION_WORKER || t.owner === 'mesh';

export class Promotions {
  #o: PromotionOptions;
  #running: Promise<void> | null = null;
  #watching: ReturnType<typeof setTimeout> | null = null;
  #seen = new Map<string, number>();
  #closed = false;
  #lastFence = 0;
  #lastSeen = 0;
  #lastTime = 0;
  readonly windowS: number;
  readonly probeMs: number;

  constructor(o: PromotionOptions) {
    this.#o = o;
    const env = Number(process.env.NOVA_PROMOTION_WINDOW_S);
    const window = o.windowS ?? (Number.isFinite(env) && env > 0 ? env : WINDOW_MIN_S);
    const probe = Number(process.env.NOVA_PROMOTION_PROBE_MS);
    const pace = o.probeMs ?? (Number.isFinite(probe) && probe > 0 ? probe : 10_000);
    // Shorter than the ADR's window, or faster probes, only in a test or the drill, on a temp home.
    const t = testing(o.home);
    this.windowS = t ? window : Math.max(WINDOW_MIN_S, window);
    this.probeMs = t ? pace : Math.max(PROBE_MIN_MS, pace);
    if (!t && (window < WINDOW_MIN_S || pace < PROBE_MIN_MS)) o.log.warn('mesh', `A promotion’s window is never shorter than ${WINDOW_MIN_S / 60} minutes, nor its probes faster than one every ${PROBE_MIN_MS / 1000} s, outside a test or the drill; the shorter setting was ignored.`);
    o.ledger.workers.set(this.worker.id, this.worker);
    o.verifier.registerConfirmation(PROMOTION_SYSTEM, (e, brief) => this.#confirm(e, brief));
    // A roll-back elsewhere: the node this one took over from is hub again at a higher epoch, and this
    // node stepped down (fencing). It follows that hub as its live standby, copying it afresh.
    // Before it copies afresh, whatever it took that the other never copied is kept, never thrown away.
    o.role.on('demoted', (d: { hub: string; epoch: number }) => {
      const r = this.record();
      if (!r || r.kind !== 'planned' || r.side !== 'to' || !r.from || r.from.id !== d.hub || !['verifying', 'verified', 'transferring', 'failed'].includes(r.state)) return;
      const from = r.from;
      const kept = this.#keepUncopied(`Changes “${from.name}” never got`, `while this node was the hub, “${from.name}” took the role back at epoch ${d.epoch}`, o.db.get<{ acked_seq: number }>('SELECT acked_seq FROM sync_state WHERE id = 1')?.acked_seq ?? 0);
      if (kept === false) {
        this.#save({ ...r, state: 'stepped-down', said: `“${from.name}” took the hub back at epoch ${d.epoch}. This node stepped down and keeps what it had (it couldn’t set aside its own changes first, so it doesn’t copy “${from.name}” yet).` });
        return;
      }
      try {
        o.role.follow({ id: from.id, name: from.name, url: from.address ?? '', public_key: from.public_key, x25519_public_key: from.x25519_public_key }, { epoch: d.epoch, cursor: null });
        this.#save({ ...r, state: 'stepped-down', said: `“${from.name}” took the hub back at epoch ${d.epoch}; this node stepped down and copies it afresh as its standby.${kept ? ` ${kept}` : ''}` });
        if (kept) this.#problem(kept);
      } catch (e) {
        this.#problem('After the hub was taken back, this node couldn’t start copying it.', (e as Error)?.stack ?? String(e));
      }
    });
    // Any other promotion (M4's, by the person): the node that became hub points the stable name at
    // itself too, under the person's tier-3 confirmation. An automatic failover doesn't move the name:
    // nobody confirmed that, and no window watches it; it says so instead.
    o.role.on('promoted', (p: { planned?: boolean; auto?: boolean }) => {
      if (p.planned) return;
      if (p.auto) { if (this.#o.name) this.#problem(`This node became the hub by itself (automatic failover), so Nova didn’t move ${this.#o.publicUrl() ?? 'the stable name'}: nobody confirmed that. Phones and browsers find this hub when you point the name here; computers follow the roster.`); return; }
      void this.#pointName().catch(() => {});
    });
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

  // A problem, unless Nova is stopping (the database may be closed by then).
  #problem(message: string, detail?: string): void {
    if (this.#closed) return;
    try { this.#o.log.problem('mesh', message, detail ? { detail } : undefined); } catch { /* closing */ }
  }

  #tell(r: PromotionRecord, key: string, message: string): PromotionRecord {
    if ((r.told ?? []).includes(key)) return r;
    this.#problem(message);
    return this.#save({ ...r, told: [...(r.told ?? []), key] });
  }

  // Changes in this node's log past `after` (what the other node never acknowledged), set aside in a
  // named checkpoint before anything copies over them, and said exactly. Returns the words said, null
  // when there was nothing to keep, false when they couldn't be set aside (then nothing may wipe them).
  #keepUncopied(name: string, when: string, after: number): string | null | false {
    const rows = this.#o.db.all<{ seq: number; tbl: string; pk: string; op: string }>(`SELECT seq, tbl, pk, op FROM sync_log WHERE seq > ? AND tbl != 'vault' ORDER BY seq`, after);
    if (!rows.length) return null;
    const what = summarize(rows);
    let kept: { id: string; label: string };
    try { kept = this.#o.keep ? this.#o.keep(`${name} (${this.#o.now().toISOString().slice(0, 16)})`) : (() => { throw new Error('no way to keep them'); })(); } catch (e) {
      this.#problem(`${rows.length} ${rows.length === 1 ? 'change' : 'changes'} made here ${when} never reached the other node (${what}), and Nova couldn’t set ${rows.length === 1 ? 'it' : 'them'} aside in a checkpoint (${(e as Error).message}). Nothing was deleted: this node keeps them as they are and doesn’t copy the hub until you have looked.`);
      return false;
    }
    // Said by the caller once this node copies the hub (a problem written before would be copied over).
    return `${rows.length} ${rows.length === 1 ? 'change' : 'changes'} made here ${when} never reached the other node: ${what}. Nova kept ${rows.length === 1 ? 'it' : 'them'}, as ${rows.length === 1 ? 'it was' : 'they were'}, in the checkpoint “${kept.label}” on this node (Settings › Backups and changes); nothing was deleted. Add again on the hub what you still want.`;
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
  // Whether this node stopped while it held writes to hand over (finding 4): then it must start holding,
  // before the ledger resumes or recovers anything (handed-over work must not run here as well).
  holdPending(): boolean {
    const r = this.record();
    return !!r && r.kind === 'planned' && r.side === 'from' && ['holding', 'transferring'].includes(r.state) && this.#o.role.role() === 'hub';
  }

  // Called by the core before the hub's work starts: the hold, as it was.
  restoreHold(): boolean {
    if (!this.holdPending()) return false;
    const r = this.record()!;
    this.#o.role.hold(this.#holdWords(r));
    this.#o.quiet?.(true);
    this.#o.pause?.(KEEP_OWNERS);
    return true;
  }

  start(): void {
    const r = this.record();
    if (!r) return;
    const s = this.#o.devices.state();
    const me = this.#o.identity.id;
    if (r.kind === 'planned' && r.side === 'from' && ['holding', 'transferring'].includes(r.state)) {
      // Holding (restoreHold), or stepped down at start already (fencing found the candidate hub at the
      // new epoch): either way, the candidate says what happened before this node does anything.
      this.#running = this.#settleUnknown(r).finally(() => { this.#running = null; });
    } else if (r.kind === 'planned' && r.side === 'from' && (r.state === 'verifying' || r.state === 'rolling-back')) {
      // The facts first, then the watch (finding 1): this node is still the standby of the node it
      // handed over to, at that epoch. Anything else and the record is old news, not a reason to probe.
      const file = readRole(this.#o.home);
      const still = s.role === 'standby' && s.hub_id === r.to?.id && s.epoch >= (r.epoch_to ?? Infinity) && file?.role === 'standby' && file.hub.id === r.to?.id && file.device_id === me;
      if (still) { this.#save({ ...r, state: 'verifying' }); this.#watch(); }
      else if (s.role === 'hub' && s.hub_id === me && r.state === 'rolling-back') this.#save({ ...r, state: 'rolled-back', said: `This node took the hub back at epoch ${s.epoch}.` });
      else this.#save({ ...r, state: 'ended', said: `At this start, this node is ${s.role} at epoch ${s.epoch}, so the checks of “${r.to?.name ?? 'the new hub'}” weren’t taken up again: what the record said no longer holds.` });
    } else if (r.kind === 'planned' && r.side === 'to' && ['transferring', 'failed'].includes(r.state) && s.role === 'hub' && s.hub_id === me && s.epoch >= (r.epoch_to ?? Infinity)) {
      // It took the role (its database says so) and stopped before its record caught up (finding 3).
      this.#save({ ...r, state: 'verifying', said: `This node is the hub at epoch ${s.epoch}.` });
    } else if (r.kind === 'cold' && r.state === 'staged' && this.#o.role.role() === 'hub') {
      void this.#afterCold(r).catch((e) => this.#problem('Nova couldn’t record the emergency promotion in the ledger.', (e as Error)?.stack ?? String(e)));
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
      this.#problem('A promotion stopped part-way.', (e as Error)?.stack ?? String(e));
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
    // Writes held at the gate first; then the requests already past it finish; only then is the last
    // sequence fixed (finding 5). The log keeps recording: a change that lands after all (work that
    // ignored its stop) is in it, so the candidate copies it or it is kept here and said.
    role.hold(this.#holdWords(r));
    this.#o.quiet?.(true);
    r = this.#save({ ...r, state: 'holding' });
    await this.#until(() => (this.#o.inflight?.() ?? 0) === 0, 10_000);
    try { sync.scan(); } catch { /* the journal's last look; a failure is the scan's own problem */ }
    let last = sync.head();
    r = this.#save({ ...r, last_seq: last });
    for (let i = 0; i < 4; i++) {
      const all = await this.#until(() => role.lag().acked_seq >= last, this.#o.catchupMs ?? 120_000);
      if (!all) { this.#abort(r, `“${to.name}” didn’t acknowledge the last sequence (${last}) in time.`); return; }
      try { sync.scan(); } catch { /* as above */ }
      if (sync.head() <= last) break;
      last = sync.head();
      r = this.#save({ ...r, last_seq: last });
    }
    sync.stopJournal();
    // Step 4: transfer.
    r = this.#save({ ...r, state: 'transferring' });
    const epoch = r.epoch_from + 1;
    const h: Handover = { v: 1, id: r.id, parent: r.parent, from: this.#o.identity.id, to: to.id, epoch, last_seq: last, from_address: this.#o.address(), name: this.#o.publicUrl(), at: this.#o.now().toISOString() };
    const signed: SignedHandover = { handover: h, signature: this.#o.identity.sign(handoverMessage(h)) };
    let answer: { status: number; body: any } | null = null;
    let why = '';
    try { answer = await this.#callCandidate(to, 'transfer', { handover: signed }, 30_000); } catch (e) { why = (e as Error).message; }
    const roster = answer?.body?.roster as SignedRoster | undefined;
    if (answer?.status === 200 && this.#theirs(roster, to, epoch)) { this.#followNew(r, to, epoch, last, roster!); return; }
    // Anything else, even a refusal, may come after the candidate took the role (finding 3): only its
    // own signed word that it didn't lets this node carry on as hub.
    why ||= answer ? `it answered ${answer.status}${answer.body?.error ? `: ${answer.body.error}` : ''}` : 'no answer';
    await this.#settleUnknown(r, why);
  }

  // The new hub signed a roster at the new epoch with the key this hub holds for it.
  #theirs(roster: SignedRoster | undefined, to: Device, epoch: number): boolean {
    return !!roster && roster.roster?.epoch === epoch && roster.roster.hub?.id === to.id && roster.roster.hub.public_key === to.public_key && verifyRoster(roster, [to.public_key]);
  }

  // Step 5: this node becomes the new hub's live standby, then watches it (step 6). A change that
  // landed here after the hand-over point (it never reached the new hub) is kept and said first.
  #followNew(r: PromotionRecord, to: Device, epoch: number, last: number, roster: SignedRoster): void {
    if (this.#o.role.role() === 'hub') { try { this.#o.sync.scan(); } catch { /* the scan's own problem */ } }
    const kept = this.#keepUncopied(`Changes made during the hand-over to “${to.name}”`, `after the hand-over point (sequence ${last})`, last);
    if (kept === false) {
      this.#save({ ...r, state: 'failed', epoch_to: epoch, said: `“${to.name}” is the hub at epoch ${epoch}. This node had changes it couldn’t set aside, so it keeps them and doesn’t copy “${to.name}” yet.` });
      return;
    }
    this.#o.role.follow({ id: to.id, name: to.name, url: to.address!, public_key: to.public_key, x25519_public_key: to.x25519_public_key }, { epoch, cursor: last, roster });
    this.#o.quiet?.(false);
    if (kept) this.#problem(kept);
    this.#save({ ...r, state: 'verifying', epoch_to: epoch, verify_until: new Date(this.#o.now().getTime() + r.window_s * 1000).toISOString(), said: `“${to.name}” is the hub at epoch ${epoch}; this node is its standby and checks it until the window ends.` });
    this.#watch();
  }

  // Whether the candidate took the hand-over, in its own signed words: committed (with its roster),
  // declined (and it will never take that hand-over now), pending (still taking it), or null (nothing
  // authenticated came back).
  async #transferStatus(r: PromotionRecord): Promise<{ committed: boolean; pending?: boolean; roster?: SignedRoster | null } | null> {
    const to = r.to ? this.#o.devices.find(r.to.id) ?? null : null;
    if (!to?.address) return null;
    try {
      const a = await this.#callCandidate(to, 'transfer-status', { id: r.id }, 8000);
      if (a.status !== 200 || !verifyAnswer('transfer-status', a.body, to.public_key)) return null;
      const b = (a.body as SignedAnswer<{ id: string; committed: boolean; pending?: boolean; roster?: SignedRoster | null }>).body;
      return b.id === r.id ? b : null;
    } catch { return null; }
  }

  // The candidate's answer didn't settle it: holding on (nothing is written here) until the candidate
  // says, signed, what happened. Took it: this node follows it. Declined (it then never takes that
  // hand-over): this node carries on as hub. Until then the person is told once, and may cancel the
  // promotion at tier 3 (`cancel`), with what Nova can't know said plainly.
  async #settleUnknown(r0: PromotionRecord, why = 'its answer was lost'): Promise<void> {
    let r = r0;
    const to = r.to ? this.#o.devices.find(r.to.id) : null;
    const epoch = r.epoch_from + 1;
    for (let i = 0; !this.#closed; i++) {
      const cur = this.record();
      if (!cur || cur.id !== r.id || !['holding', 'transferring'].includes(cur.state)) return;
      const st = await this.#transferStatus(r);
      if (st?.committed && to && this.#theirs(st.roster ?? undefined, to, epoch)) { this.#followNew(this.record()!, to, epoch, r.last_seq ?? this.#o.sync.head(), st.roster!); return; }
      if (st && !st.committed && !st.pending) {
        if (this.#o.role.role() === 'hub') this.#abort(this.record()!, `“${to?.name ?? 'The candidate'}” says it didn’t take the role (${why}).`);
        else this.#save({ ...this.record()!, state: 'failed', said: `“${to?.name ?? 'The candidate'}” didn’t take the role, and this node had stepped down: it copies nothing now. Enroll it again as the standby.` });
        return;
      }
      if (i === 0) r = this.#tell(this.record()!, 'unknown', `Nova couldn’t tell whether “${to?.name ?? 'the candidate'}” took the hub’s role (${why}), so this node keeps refusing changes until “${to?.name ?? 'it'}” says. If “${to?.name ?? 'it'}” is gone for good, you can cancel the promotion here (Settings › Devices); Nova then says what it can’t know.`);
      await new Promise((res) => setTimeout(res, Math.min(10_000, 500 * 2 ** Math.min(i, 5))));
    }
  }

  // The person cancels a hand-over whose outcome is unknown (tier 3). Asked first: if the candidate
  // says, signed, what happened, that settles it as above. If nothing comes back, this node carries on
  // as hub at two epochs past where it was (finding 6), so if the candidate did take the role at the
  // next epoch, it steps down when the two meet and keeps what it took in a checkpoint.
  async cancel(o: { confirm: boolean; by: string }) {
    const r = this.record();
    if (!r || r.kind !== 'planned' || r.side !== 'from' || !['holding', 'transferring'].includes(r.state) || this.#o.role.role() !== 'hub') throw new CoreError('conflict', 'There is no hand-over waiting here to cancel.');
    if (!o.confirm) throw new CoreError('validation', `Cancelling now may leave two hubs for a while if “${r.to?.name ?? 'the candidate'}” took the role and some devices reach it; Nova settles it when they meet. That needs your explicit confirmation (tier 3): send confirm: true.`);
    const to = r.to ? this.#o.devices.find(r.to.id) : null;
    const st = await this.#transferStatus(r);
    if (st?.committed && to && this.#theirs(st.roster ?? undefined, to, r.epoch_from + 1)) { this.#followNew(r, to, r.epoch_from + 1, r.last_seq ?? this.#o.sync.head(), st.roster!); return { state: 'verifying', said: `“${to.name}” had taken the role: this node follows it.` }; }
    if (st && !st.committed && !st.pending) { this.#abort(r, `“${to?.name ?? 'The candidate'}” says it didn’t take the role.`); return { state: 'failed', said: 'Nothing was handed over; this node is the hub, as before.' }; }
    const epoch = this.#o.role.raiseEpoch(2);
    const said = `You cancelled the hand-over to “${to?.name ?? 'the candidate'}” without knowing whether it took the role: it couldn’t be reached. This node carries on as the hub at epoch ${epoch}. If “${to?.name ?? 'it'}” did take the role and devices reach it, both take changes until the two meet; then “${to?.name ?? 'it'}” steps down, and keeps what it took meanwhile in a checkpoint on itself, and says so.`;
    this.#task(r, 'cancel', 'Promotion cancelled', true, said, { epoch, by: o.by, confirmed: 'tier 3' });
    this.#resume();
    this.#save({ ...r, state: 'cancelled', said });
    this.#problem(said);
    return { state: 'cancelled', said, epoch };
  }

  // Nothing was handed over: this hub carries on as it was.
  #abort(r: PromotionRecord, why: string): void {
    this.#resume();
    this.#task(r, 'transfer', 'Hub handed over', false, `${why} This node is still the hub; nothing changed.`, { why });
    this.#save({ ...r, state: 'failed', said: `${why} Nothing changed.` });
    this.#problem(`The promotion stopped: ${why} This node is still the hub.`);
  }

  #resume(): void {
    this.#o.role.release();
    this.#o.quiet?.(false);
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

  // One probe of the new hub (finding 1). Asked over a request signed by this node's key, it answers
  // with its own health, signed by its pinned key: well, or failing (and which check). Nothing
  // authenticated coming back (a broken link, a clock too far off, a forwarder in between) is
  // `unknown`, which is never a reason to take the role back. This node's own copy arriving is noted,
  // but it is this node's link, not evidence about the new hub.
  async probe(): Promise<Probe | null> {
    let r = this.record();
    if (!r || r.kind !== 'planned' || r.side !== 'from' || r.state !== 'verifying' || !r.to || this.#closed) return null;
    const to = r.to;
    const checks: Check[] = [];
    let result: Probe['result'] = 'unknown';
    try {
      const a = await this.#callCandidate(to, 'health', { id: r.id }, Math.max(2000, Math.min(this.probeMs, 8000)));
      if (a.status === 200 && verifyAnswer('health', a.body, to.public_key)) {
        const h = (a.body as SignedAnswer<{ id: string; ok: boolean; epoch: number; checks: Check[] }>).body;
        if (h.id === r.id && h.epoch >= r.epoch_to!) {
          result = h.ok ? 'ok' : 'unhealthy';
          checks.push(...(h.checks ?? []).map((c) => ({ ...c, name: `hub:${c.name}` })));
        } else checks.push({ name: 'reach', ok: false, said: `“${to.name}” answered about another promotion or epoch.` });
      } else checks.push({ name: 'reach', ok: false, said: `“${to.name}” answered without a health report signed by its key (${a.status}${a.body?.error ? `: ${a.body.error}` : ''}).` });
    } catch (e) { checks.push({ name: 'reach', ok: false, said: `“${to.name}” doesn’t answer: ${(e as Error).message}` }); }
    const rep = (this.#o.role.status() as { replica?: { sync?: { last_ok_at?: string | null; refused?: string | null } | null } }).replica?.sync;
    const copying = !!rep?.last_ok_at && !rep.refused && this.#o.now().getTime() - Date.parse(rep.last_ok_at) <= Math.max(3 * this.probeMs, 30_000);
    checks.push({ name: 'copy', ok: copying, said: copying ? `This node’s copy last arrived ${rep!.last_ok_at}.` : `This node’s copy isn’t arriving${rep?.refused ? `: ${rep.refused}` : ''} (this node’s link, not a fault of the hub).` });
    const probe: Probe = { at: this.#o.now().toISOString(), ok: result === 'ok', result, checks };
    r = this.record();
    if (!r || r.state !== 'verifying') return probe;
    r = this.#save({ ...r, probes: [...r.probes, probe].slice(-200) });
    const tail = r.probes.slice(-FAILS_TO_ROLL_BACK);
    const all = (x: Probe['result']) => tail.length === FAILS_TO_ROLL_BACK && tail.every((p) => p.result === x);
    if (all('unhealthy')) { await this.#rollBack(r, 'auto'); return probe; }
    if (all('unknown')) {
      this.#tell(r, 'unreachable', `Nova can’t reach “${to.name}”, the hub since the hand-over, to check it (${checks.find((c) => c.name === 'reach')?.said ?? 'no answer'}). It stays the hub: a link that doesn’t answer is no proof it failed, and taking the role back by itself could leave two hubs. If “${to.name}” is gone for good, you can take the hub back here (Settings › Devices, tier 3).`);
    }
    if (probe.ok && Date.parse(r.verify_until!) <= this.#o.now().getTime()) await this.#passed(this.record()!);
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

  // The new hub said, signed, that it is failing (`auto`, tier 1), or the person asked for the hub back
  // (`person`, tier 3). Either way it is asked first to stop taking changes. By itself, Nova goes on
  // only when it acknowledges that, signed: then there is never a moment with two hubs, and what it
  // took before it stopped is copied here first. Asked by the person, it goes on even when the new hub
  // can't be reached, as the sheet said.
  async #rollBack(r: PromotionRecord, how: 'auto' | 'person'): Promise<{ epoch: number } | null> {
    if (this.#watching) clearTimeout(this.#watching);
    this.#watching = null;
    const to = r.to!;
    const failing = r.probes.slice(-FAILS_TO_ROLL_BACK).flatMap((p) => p.checks.filter((c) => !c.ok && c.name !== 'copy').map((c) => c.said));
    let stood: string;
    let acked = false;
    try {
      const a = await this.#callCandidate(to, 'stand-down', { id: r.id }, 8000);
      if (a.status === 200 && verifyAnswer('stand-down', a.body, to.public_key) && (a.body as SignedAnswer<{ id: string; held: boolean; head: number }>).body.id === r.id) {
        acked = true;
        const head = (a.body as SignedAnswer<{ head: number }>).body.head;
        const copied = await this.#until(() => this.#o.sync.cursor() >= head, 10_000);
        stood = copied ? `“${to.name}” stopped taking changes first, and this node had copied all it took (to sequence ${head}).` : `“${to.name}” stopped taking changes first; this node had copied ${this.#o.sync.cursor()} of its ${head}, and “${to.name}” keeps the rest in a checkpoint when it steps down.`;
      } else stood = `“${to.name}” didn’t acknowledge standing down (${a.status}${a.body?.error ? `: ${a.body.error}` : ''}).`;
    } catch (e) { stood = `“${to.name}” couldn’t be reached to stop it taking changes (${(e as Error).message}).`; }
    if (!acked && how === 'auto') {
      this.#tell(r, 'no-stand-down', `“${to.name}” said it is failing its checks (${failing[0] ?? 'its probes'}), but ${stood.replace(/^“[^”]+” /, 'it ')} So Nova didn’t take the hub back by itself: that could leave two hubs. If “${to.name}” is really down, take the hub back here (Settings › Devices, tier 3).`);
      this.#watch();
      return null;
    }
    r = this.#save({ ...r, state: 'rolling-back', said: 'Taking the hub back.' });
    const back = await this.#o.role.promote({
      confirm: true, by: how === 'auto' ? 'nova' : 'person',
      planned: { previous: to.id, address: to.address, parent: r.parent, title: 'Promotion rolled back: this node is the hub again', goal: how === 'auto' ? `“${to.name}” said it was failing its checks after taking over (${failing[0] ?? 'it failed its probes'}) and stood down, so this node takes the hub back, by itself (tier 1).` : `You asked for the hub back from “${to.name}” (tier 3).` },
    });
    this.#o.ledger.resume();
    this.#task(r, 'verify', `Checks of “${to.name}” as the hub`, false, how === 'auto' ? `“${to.name}” said it was failing ${FAILS_TO_ROLL_BACK} checks in a row: ${[...new Set(failing)].join(' ')} ${stood}` : `You took the hub back. ${stood}`, { probes: r.probes, window_s: r.window_s, stood, how });
    const pointed = await this.#pointName();
    this.#save({ ...r, state: 'rolled-back', said: `${how === 'auto' ? `“${to.name}” said it was failing its checks, so` : 'As you asked,'} this node is the hub again, at epoch ${back.epoch}.${pointed ? ` ${pointed}` : ''}` });
    this.#problem(how === 'auto'
      ? `“${to.name}” said it was failing its checks after it became the hub (${failing[0] ?? 'its probes failed'}) and stood down, so Nova made this node the hub again by itself, at epoch ${back.epoch}. “${to.name}” steps down and copies this hub.`
      : `As you asked, this node took the hub back from “${to.name}”, at epoch ${back.epoch}. ${stood} If “${to.name}” is still running and devices reach it, it steps down when it sees this hub, and keeps anything it took meanwhile in a checkpoint on itself.`);
    // It finds out at its next fencing round; asking it now is quicker. Nothing depends on the answer.
    if (to.address) void ask(`${to.address}/api/v1/mesh/promotion/fence`, { method: 'POST', headers: { 'x-nova': '1' }, body: {}, timeoutMs: 5000 }).catch(() => {});
    return { epoch: back.epoch };
  }

  // The person takes the hub back during the window (tier 3), for a new hub that can't be reached.
  async takeBack(o: { confirm: boolean }) {
    const r = this.record();
    if (!r || r.kind !== 'planned' || r.side !== 'from' || r.state !== 'verifying' || this.#o.role.role() !== 'standby') throw new CoreError('conflict', 'There is no promotion here whose hub can be taken back.');
    if (!o.confirm) throw new CoreError('validation', `If “${r.to?.name ?? 'the new hub'}” is still running and only cut off from this node, taking the hub back leaves two hubs taking changes until they meet; then it steps down and keeps what it took meanwhile in a checkpoint. That needs your explicit confirmation (tier 3): send confirm: true.`);
    const back = await this.#rollBack(r, 'person');
    return { state: this.record()?.state, epoch: back?.epoch ?? null, said: this.record()?.said };
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

  // A call from this hub's standby (the node it took the role from), signed by that node's key.
  #fromStandby(step: string, body: unknown): { payload: Record<string, unknown>; from: Device; r: PromotionRecord } {
    const s = this.#o.devices.state();
    const r = this.record();
    if (s.role !== 'hub' || !r || r.side !== 'to' || !r.from || s.standby_id !== r.from.id) throw new CoreError('conflict', 'This node isn’t a hub that took the role from its standby.');
    const from = this.#o.devices.find(r.from.id);
    if (!from || from.trust !== 'trusted') throw new CoreError('forbidden', 'That node isn’t trusted here.');
    const v = verifyCall(step, body, { hubId: from.id, hubKey: from.public_key, me: this.#o.identity.id, nowS: Math.floor(this.#o.now().getTime() / 1000), seen: this.#seen });
    if (!v.ok) throw new CoreError('forbidden', v.why);
    if (v.epoch !== s.epoch || v.payload.id !== r.id) throw new CoreError('conflict', 'That isn’t this node’s promotion.');
    return { payload: v.payload, from, r };
  }

  // The new hub's own health, signed (finding 1): it is the hub at the epoch it took; it takes writes
  // (it isn't holding them); and the stable name leads here, when Nova moves the name.
  async #health(body: unknown): Promise<unknown> {
    const { r } = this.#fromStandby('health', body);
    const s = this.#o.devices.state();
    const me = this.#o.identity.id;
    const checks: Check[] = [];
    const hub = s.role === 'hub' && s.hub_id === me && s.epoch >= (r.epoch_to ?? Infinity);
    checks.push({ name: 'role', ok: hub, said: hub ? `It is the hub at epoch ${s.epoch}.` : `It is ${s.role} at epoch ${s.epoch}.` });
    const held = this.#o.role.held();
    checks.push({ name: 'writes', ok: !held, said: held ? `It is holding changes: ${held.reason}` : 'It takes changes.' });
    const name = this.#o.publicUrl();
    const mine = this.#o.address();
    if (this.#o.name && name && mine && name !== mine) {
      try {
        const h = await ask(`${name}/api/v1/mesh/hello`, { timeoutMs: 4000 });
        const ok = h.body?.id === me;
        checks.push({ name: 'name', ok, said: ok ? `${name} leads to it.` : `${name} doesn’t lead to it (it answers as ${h.body?.id ? 'another node' : 'nothing Nova knows'}).` });
      } catch (e) { checks.push({ name: 'name', ok: false, said: `${name} doesn’t answer: ${(e as Error).message}` }); }
    }
    return signAnswer(this.#o.identity, 'health', { id: r.id, ok: checks.every((c) => c.ok), epoch: s.epoch, at: this.#o.now().toISOString(), checks });
  }

  // Whether this node took a hand-over, answered to the hub that sent it (or, once taken, to that same
  // node as this hub's standby), signed (finding 3). Not taken and not being taken: it is declined
  // here, so this node never takes it later.
  #transferStatusAnswer(body: unknown): unknown {
    const b = body as { auth?: { from?: string } } | null;
    const s = this.#o.devices.state();
    const me = this.#o.identity.id;
    const fromId = b?.auth?.from;
    if (typeof fromId !== 'string' || (fromId !== s.hub_id && fromId !== s.standby_id)) throw new CoreError('forbidden', 'Only the hub that handed over may ask.');
    const file = readRole(this.#o.home);
    const key = this.#o.devices.find(fromId)?.public_key ?? (file?.hub.id === fromId ? file.hub.public_key : null);
    if (!key) throw new CoreError('forbidden', 'This node doesn’t know that node’s key.');
    const v = verifyCall('transfer-status', body, { hubId: fromId, hubKey: key, me, nowS: Math.floor(this.#o.now().getTime() / 1000), seen: this.#seen });
    if (!v.ok) throw new CoreError('forbidden', v.why);
    const id = String(v.payload.id ?? '');
    const r = this.record();
    const committed = !!r && r.id === id && r.side === 'to' && s.role === 'hub' && s.hub_id === me && s.epoch >= (r.epoch_to ?? Infinity);
    const pending = !committed && !!r && r.id === id && r.side === 'to' && r.state === 'transferring';
    if (!committed && !pending && !(r && r.id === id && r.state === 'declined')) {
      const at = this.#o.now().toISOString();
      this.#save({ v: 1, id, kind: 'planned', side: 'to', state: 'declined', from: null, to: null, epoch_from: s.epoch, epoch_to: null, last_seq: null, window_s: this.windowS, verify_until: null, probes: [], parent: null, said: 'The hub asked whether this node took its hand-over; it hadn’t, and now never will.', started_at: at, updated_at: at });
    }
    return signAnswer(this.#o.identity, 'transfer-status', { id, committed, ...(pending ? { pending: true } : {}), epoch: s.epoch, roster: committed ? this.#o.devices.roster() : null });
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
    const prior = this.record();
    if (prior?.id === h.id && prior.state === 'declined') throw new CoreError('conflict', 'This node already told the hub it didn’t take that hand-over, so it never will.');
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
    const { from, r } = this.#fromStandby('stand-down', body);
    this.#o.role.hold(`Nova is giving the hub back to “${from.name}”, so changes wait a moment. Try again in a minute${this.#o.publicUrl() ? `, at ${this.#o.publicUrl()}` : ''}.`, { fence: true });
    this.#o.quiet?.(true);
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
          this.#o.quiet?.(false);
          this.#o.role.emit('resumed', {});
          this.#problem(`“${from.name}” asked this hub to stop taking changes so it could take the role back, then didn’t. This node carries on as the hub.`);
        }
      }, () => {
        if (told) return;
        told = true;
        this.#problem(`“${from.name}” asked this hub to stop taking changes so it could take the role back, and can’t be reached now. Nova keeps refusing changes here until it knows which node is hub. If “${from.name}” is gone for good, restart Nova here and it carries on as the hub.`);
      });
    }, 2000);
    look.unref?.();
    return signAnswer(this.#o.identity, 'stand-down', { id: r.id, held: true, head: this.#o.sync.head(), epoch: this.#o.devices.state().epoch });
  }

  // The node that became hub points the stable name at itself.
  async #pointName(): Promise<string | null> {
    const n = this.#o.name;
    const me = this.#o.address();
    if (!n || !me) return null;
    const r = await n.point(me);
    if (!r.ok) this.#problem(r.said);
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
    // The highest epoch anything has shown this node: its own, the backup's, its last promotion's, and
    // the rosters its devices showed it (finding 2). Max + 1, so it doesn't tie or trail any of them.
    const seen = this.#seenEpochs();
    const floor = Math.max(s.epoch, epochBackup ?? 0, r?.epoch_to ?? 0, seen.max ?? 0);
    const facts: ColdFacts = {
      backup, epoch_now: s.epoch, epoch_backup: epochBackup, epoch_new: floor + 1, pinned,
      lost: backup ? LOST_WORDS(backup.at) : 'Not known: there is no backup to restore.', connectors: CONNECTOR_WORDS, devices: DEVICE_WORDS,
      seen: { max: seen.max, count: seen.count }, copy_at: this.#copyAt(),
    };
    return { eligible: reasons.length === 0, reasons, facts, sheet: coldSheet(facts, { name: this.#stable() }), folder };
  }

  // Rosters this node's devices showed it (`POST /mesh/seen`), each checked against a key this node
  // trusts to sign one: the highest epoch, and from how many.
  #seenEpochs(): { max: number | null; count: number } {
    try {
      const j = JSON.parse(readFileSync(join(this.#o.home, SEEN_FILE), 'utf8')) as { seen: { device: string | null; epoch: number }[] };
      const list = Array.isArray(j.seen) ? j.seen : [];
      return { max: list.length ? Math.max(...list.map((x) => x.epoch)) : null, count: new Set(list.map((x) => x.device ?? x.epoch)).size };
    } catch { return { max: null, count: 0 }; }
  }

  // A device that found this node not to be the hub tells it the roster it holds (finding 2). Kept
  // only when signed by a key this node trusts to be hub (the hub's, the standby's, a candidate's).
  seen(body: Record<string, unknown>): { kept: boolean } {
    const now = Date.now();
    if (now - this.#lastSeen < 200) return { kept: false };
    this.#lastSeen = now;
    const roster = body.roster as SignedRoster | undefined;
    const ep = roster?.roster?.epoch;
    if (!roster?.roster?.hub || !Number.isSafeInteger(ep) || ep! < 1 || ep! > 2 ** 31 - 1) return { kept: false };
    const keys = new Set<string>();
    for (const d of this.#o.devices.list()) if (d.trust === 'trusted' && (d.role === 'hub' || d.kind === 'standby' || d.purposes.includes('hub-candidate'))) keys.add(d.public_key);
    const file = readRole(this.#o.home);
    if (file) keys.add(file.hub.public_key);
    if (!keys.has(roster.roster.hub.public_key) || !verifyRoster(roster, [roster.roster.hub.public_key])) return { kept: false };
    const file2 = join(this.#o.home, SEEN_FILE);
    let seen: { device: string | null; epoch: number; hub: string; at: string }[] = [];
    try { seen = (JSON.parse(readFileSync(file2, 'utf8')) as { seen: typeof seen }).seen ?? []; } catch { /* first */ }
    const device = typeof body.device_id === 'string' ? body.device_id.slice(0, 64) : null;
    seen = [...seen.filter((x) => x.device !== device || device === null), { device, epoch: ep!, hub: roster.roster.hub.id, at: this.#o.now().toISOString() }].slice(-50);
    mkdirSync(join(this.#o.home, 'mesh'), { recursive: true, mode: 0o700 });
    writeFileSync(`${file2}.tmp`, `${JSON.stringify({ seen }, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file2}.tmp`, file2);
    return { kept: true };
  }

  // When the newest change this node holds was made (its hybrid clock's wall time), or null.
  #copyAt(): string | null {
    const h = this.#o.db.get<{ hlc: string | null }>('SELECT hlc FROM sync_log ORDER BY seq DESC LIMIT 1')?.hlc;
    const ms = h ? Number(String(h).split(/[^0-9]/)[0]) : NaN;
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
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

  async cold(o: { confirm: boolean; folder?: unknown; backup?: unknown; by: string }) {
    if (!o.confirm) throw new CoreError('validation', 'An emergency promotion restores a backup and loses everything written after it: it needs your explicit confirmation every time (tier 3). Send confirm: true.');
    if (this.#running) throw new CoreError('conflict', 'A promotion is already under way.');
    const v = await this.coldView({ folder: o.folder });
    if (!v.eligible) throw new CoreError('conflict', `Nova didn’t promote this node: ${v.reasons[0]}`, v.reasons);
    const b = v.facts.backup!;
    // Only the backup the person was shown (minor finding): the sheet sends its id.
    if (o.backup !== b.id) throw new CoreError('conflict', `The sheet you confirmed named ${typeof o.backup === 'string' ? o.backup : 'no backup'}; the latest backup is now ${b.id} (${b.at}). Look at the sheet again.`);
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
    const parent = this.#task(r, 'cold', `Emergency promotion from the backup of ${b.at}`, true, `The backup of ${b.at} (number ${b.seq}) passed its restore drill and was restored here; this node is the hub at epoch ${s.epoch}. Everything written after ${b.at} isn’t in it. Connectors need signing in again: backups never hold the vault’s key.`, { backup: b, drill: (r.cold as ColdFacts & { drill?: Check[] }).drill ?? null, restore_id: r.restore_id, epoch: s.epoch, keys: 'this node’s own' }, null);
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
    this.#problem(`This node became the hub from the backup of ${b.at}. Everything written after that isn’t in it. ${CONNECTOR_WORDS} Devices revoked and memories forgotten on the old hub after this node’s own copy${r.cold?.copy_at ? ` (${r.cold.copy_at})` : ''} aren’t known here: check Settings › Devices and Memory.`);
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
        handle: ({ body, who }) => this.cold({ confirm: body.confirm === true, folder: body.folder, backup: body.backup, by: who.principal.kind === 'device' ? `device:${who.principal.device.id}` : who.principal.kind }),
      },
      {
        method: 'POST', path: '/mesh/promotion/cancel', access: 'approver', body: '{confirm}',
        summary: 'Cancel a hand-over whose outcome isn’t known (tier 3: {confirm: true}). The candidate is asked first; if it can’t say, this node carries on as hub two epochs higher, and the answer says what Nova can’t know.',
        handle: ({ body, who }) => this.cancel({ confirm: body.confirm === true, by: who.principal.kind === 'device' ? `device:${who.principal.device.id}` : who.principal.kind }),
      },
      {
        method: 'POST', path: '/mesh/promotion/take-back', access: 'approver', body: '{confirm}',
        summary: 'Take the hub back from the node it was handed to, during its checks, when that node can’t be reached (tier 3: {confirm: true}). It is asked to stand down first.',
        handle: ({ body }) => this.takeBack({ confirm: body.confirm === true }),
      },
      { method: 'POST', path: '/mesh/seen', access: 'public', body: '{roster, device_id?}', summary: 'A device that found this node not to be its hub tells it the roster it holds, signed by its hub; kept only when signed by a key this node trusts to be hub, for an emergency promotion’s epoch.', handle: ({ body }) => this.seen(body) },
      { method: 'POST', path: '/mesh/promotion/health', access: 'public', body: '{auth, payload: {id}}', summary: 'The node this hub took the role from asks how it is, signed by its key; the answer is signed by this node’s key.', handle: ({ body }) => this.#health(body) },
      { method: 'POST', path: '/mesh/promotion/transfer-status', access: 'public', body: '{auth, payload: {id}}', summary: 'The hub that handed over asks whether this node took the hand-over, signed by its key; the answer is signed by this node’s key, and a hand-over not taken is declined for good.', handle: ({ body }) => this.#transferStatusAnswer(body) },
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

// Log entries, said by kind and with their keys: “2 memories (a1b2…, c3d4…), 1 file (notes/x.md)”.
export function summarize(rows: { tbl: string; pk: string; op: string }[]): string {
  const by = new Map<string, string[]>();
  for (const r of rows) by.set(r.tbl, [...(by.get(r.tbl) ?? []), r.op.endsWith('delete') ? `${r.pk} removed` : r.pk]);
  const name = (t: string, n: number) => (t === 'file' ? (n === 1 ? 'file' : 'files') : `${t.replace(/_/g, ' ')} ${n === 1 ? 'record' : 'records'}`);
  return [...by].map(([t, pks]) => `${pks.length} ${name(t, pks.length)} (${pks.slice(0, 8).join(', ')}${pks.length > 8 ? ', …' : ''})`).join('; ');
}

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

