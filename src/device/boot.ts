// The boot agent (ADR-3, M4 plan §2): the small, privileged half of a computer's device agent. It
// changes rarely. It holds the keys, joins the mesh, pins the roster, starts sessions, runs the
// runtime agent under a watchdog with Node's permission model around it, and installs runtime
// updates only when a pinned key signed them. The runtime can never touch any of this.
//
//   node src/device/boot.ts join <hub-url> --code <code> [--name <name>] [--kind computer|standby]
//                                [--nova-home <dir>] [--address <url>]
//   node src/device/boot.ts run        keep the runtime running (what join.sh starts)
//   node src/device/boot.ts status     what this device is, where its hub is, how it is (--json)
//   node src/device/boot.ts recover    reinstall the runtime from the hub and leave safe mode
//   node src/device/boot.ts queue <event|task_request|memory_note|config_change> '<json>' [--key <key>]
//
// The device home is NOVA_DEVICE_HOME (default ~/.nova-device):
//   boot/     keys.json (0600), device.json (the pinned roster), state.json, installed.json, ca.pem
//   runtime/  the runtime agent's files, replaced only by a verified bundle
//   state/    the only folder the runtime may write: its queue and its status
//   agent/    this program, as join.sh unpacked it
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tls from 'node:tls';
import {
  exportDeviceKeys, generateDeviceKeys, importDeviceKeys, keyFingerprint, newPairingNonce, pairingCommitment, pairingConfirmationV2,
  revealMessage, runtimeManifest, sessionMessage, sha256Hex, signMessage, statusMessage, verifyRoster, x25519Statement,
  type DeviceKeys, type SignedRoster,
} from '../core/mesh/wire.ts';
import { acceptRoster, checkProof, rosterKeys, runtimeOrder, sameRoster, verifyBundle, type Bundle, type Proof } from './trust.ts';
import { Watchdog } from './watchdog.ts';
import { detectHardware, type Hardware } from '../core/models/hardware.ts';
import { Queue, QUEUE_KINDS, type QueueKind } from './queue.ts';
import type { CallAnswer, FromRuntime, SessionMessage } from './runtime.ts';

// The hub calls the runtime may ask this agent to make for it, and nothing else; and how big one
// may be (the hub takes request bodies up to 1 MB).
export const RUNTIME_CALLS: ReadonlyArray<{ method: 'POST'; path: string }> = [
  { method: 'POST', path: '/api/v1/mesh/devices/me/heartbeat' },
  { method: 'POST', path: '/api/v1/mesh/inbox' },
];
export const MAX_CALL_BYTES = 900_000;

const HERE = dirname(fileURLToPath(import.meta.url));
export const AGENT_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8')).version ?? '0'); } catch { return '0'; }
})();
// What the runtime agent consists of; the hub's bundle carries the same files.
const RUNTIME_FILES = ['runtime.ts', 'queue.ts'];
const CAPABILITIES = ['heartbeat', 'queue'];
// The process exits with this when the hub revoked the device, so a supervisor can tell.
export const EXIT_REVOKED = 3;

// ---- the device home -----------------------------------------------------------------------------

export function deviceHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.NOVA_DEVICE_HOME || join(homedir(), '.nova-device'));
}

export function paths(home: string) {
  const boot = join(home, 'boot');
  return {
    home, boot, runtime: join(home, 'runtime'), state: join(home, 'state'),
    keys: join(boot, 'keys.json'), device: join(boot, 'device.json'), bootState: join(boot, 'state.json'),
    installed: join(boot, 'installed.json'), ca: join(boot, 'ca.pem'), pid: join(boot, 'run.pid'),
    queue: join(home, 'state', 'queue'), runtimeStatus: join(home, 'state', 'runtime.json'),
  };
}
export type Paths = ReturnType<typeof paths>;

// The pinned roster and who this device is. The hub URL is the address it last reached the hub at.
export interface DeviceFile {
  version: 1;
  device_id: string;
  name: string;
  kind: 'computer' | 'standby';
  hub_url: string;
  join_url: string;
  roster: SignedRoster;
  pinned: string[];
  epoch: number;
  joined_at: string;
  nova_home?: string;
}
export interface BootState {
  safe_mode: boolean;
  safe_mode_since?: string | null;
  revoked?: boolean;
  revoked_at?: string;
  revoked_reason?: string;
  last_update?: { version: string; at: string; result: string } | null;
  refused_bundle?: { sha256: string; at: string } | null;
}
export interface Installed { version: string; manifest: { version: string; sha256: string; files: Record<string, string>; epoch?: number; issued_at?: string }; installed_at: string; source: 'hub' | 'local' }

// Written whole, then moved into place, so a crash never leaves half a file. Mode 0600 for
// anything under boot/.
function writeJson(file: string, data: unknown, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  renameSync(tmp, file);
}
function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; }
}

function ensureDirs(p: Paths): void {
  for (const d of [p.home, p.boot, p.runtime, p.state]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
}

function loadKeys(p: Paths): DeviceKeys {
  return importDeviceKeys(JSON.parse(readFileSync(p.keys, 'utf8')));
}

// TLS trust: the system's, plus NOVA_CA_FILE when the hub's certificate authority isn't one the
// system knows. The file is copied into boot/ at join, so later runs need no environment.
export function caPem(p: Paths, env: NodeJS.ProcessEnv): string | null {
  const file = env.NOVA_CA_FILE || (existsSync(p.ca) ? p.ca : '');
  if (!file) return null;
  const pem = readFileSync(file, 'utf8');
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), pem]);
  return pem;
}

// ---- talking to a node --------------------------------------------------------------------------

export class NetError extends Error {}
export interface Res { status: number; body: any }

export async function call(base: string, method: string, path: string, o: { body?: unknown; token?: string; timeoutMs?: number } = {}): Promise<Res> {
  let res: Response;
  try {
    res = await fetch(new URL(path, base), {
      method, signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      headers: { 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'x-nova': '1' }), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    throw new NetError(`${base} can’t be reached (${cause?.code ?? cause?.message ?? (e as Error).message}).`);
  }
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body };
}

const say = (line: string) => console.log(line);
const errorOf = (r: Res) => (typeof r.body === 'object' && r.body?.error ? r.body.error : `HTTP ${r.status}`);

// ---- join ---------------------------------------------------------------------------------------

export interface JoinOptions { say?: (line: string) => void; hub: string; code: string; name?: string; kind?: 'computer' | 'standby'; novaHome?: string; address?: string; pollMs?: number; timeoutMs?: number }

// Enrollment (CONTRACTS §5) from this side: make keys here, ask with the code, show the six digits,
// wait for the person to approve on the hub, then pin the roster the hub signed.
export async function joinHub(home: string, o: JoinOptions, env: NodeJS.ProcessEnv = process.env): Promise<DeviceFile> {
  const p = paths(home);
  const say = o.say ?? console.log;
  const kind = o.kind ?? 'computer';
  if (kind !== 'computer' && kind !== 'standby') throw new Error('--kind must be computer or standby.');
  if (kind === 'standby' && !o.novaHome) throw new Error('A standby needs --nova-home <dir>: the home its Nova server will use.');
  const existing = readJson<DeviceFile>(p.device);
  if (existing && !readJson<BootState>(p.bootState)?.revoked) throw new Error(`This device home (${home}) has already joined ${existing.hub_url}. Use another NOVA_DEVICE_HOME to join again.`);
  ensureDirs(p);
  const hub = new URL(o.hub).origin;
  const ca = caPem(p, env);
  if (env.NOVA_CA_FILE && ca) writeFileSync(p.ca, ca, { mode: 0o600 });

  const hello = await call(hub, 'GET', '/api/v1/mesh/hello');
  if (hello.status !== 200) throw new Error(`${hub} isn’t answering as a Nova hub (${errorOf(hello)}).`);
  // New keys for every join: a key that was ever revoked or turned away can't be used again.
  const keys = generateDeviceKeys();
  const nonce = newPairingNonce();
  const name = o.name?.trim() || hostname() || 'Computer';
  const claims: Record<string, unknown> = { name, platform: `${process.platform} ${process.arch}`, kind, capabilities: kind === 'standby' ? ['sync'] : CAPABILITIES };
  if (kind === 'standby' && o.address) claims.address = o.address;
  const j = await call(hub, 'POST', '/api/v1/mesh/join', {
    body: {
      code: o.code, public_key: keys.ed25519.publicKey, x25519_public_key: keys.x25519.publicKey,
      x25519_sig: signMessage(keys.ed25519.privateKey, x25519Statement(keys.x25519.publicKey)), claims, commitment: pairingCommitment(keys.ed25519.publicKey, nonce),
    },
  });
  if (j.status !== 201) throw new Error(`The hub didn’t take the code: ${errorOf(j)}`);
  const { request_id: requestId, pairing_id: pairingId, hub_nonce: hubNonce, hub_fingerprint: fp } = j.body;
  if (fp !== hello.body.fingerprint || keyFingerprint(hello.body.public_key) !== fp) throw new Error('The hub’s fingerprint changed while joining. Stop, and check you are joining the right hub.');
  let last = 0;
  const time = () => (last = Math.max(Math.floor(Date.now() / 1000), last + 1));
  const t = time();
  const rv = await call(hub, 'POST', `/api/v1/mesh/join/${requestId}/reveal`, { body: { device_nonce: nonce, time: t, signature: signMessage(keys.ed25519.privateKey, revealMessage(requestId, t)) } });
  if (rv.status !== 200) throw new Error(`The hub refused the confirmation step: ${errorOf(rv)}`);
  const digits = pairingConfirmationV2({ hubFingerprint: fp, pairingId, publicKey: keys.ed25519.publicKey, code: o.code, deviceNonce: nonce, hubNonce });
  if (rv.body.confirmation !== digits) throw new Error('The hub’s digits don’t match the ones this device worked out. Don’t approve anything; start again with a new code.');
  say(`Hub: ${hub} (fingerprint ${fp})`);
  say(`This device: ${name} (${kind}), key ${keyFingerprint(keys.ed25519.publicKey)}`);
  say(`Check that the hub shows these digits: ${digits.slice(0, 3)} ${digits.slice(3)}`);
  say('Then approve it there. Waiting…');

  const until = Date.now() + (o.timeoutMs ?? 11 * 60_000);
  let status: Res;
  for (;;) {
    await new Promise((r) => setTimeout(r, o.pollMs ?? 2000));
    const ts = time();
    status = await call(hub, 'GET', `/api/v1/mesh/join/${requestId}?time=${ts}&signature=${signMessage(keys.ed25519.privateKey, statusMessage(requestId, ts))}`);
    if (status.status !== 200) throw new Error(`The hub stopped answering about this request: ${errorOf(status)}`);
    if (status.body.state !== 'pending') break;
    if (Date.now() > until) throw new Error('Nobody approved this device in time. Start again with a new code.');
  }
  if (status.body.state !== 'approved') throw new Error(status.body.state === 'denied' ? `The hub turned this device away${status.body.reason ? `: ${status.body.reason}` : '.'}` : 'The request expired before it was approved. Start again with a new code.');
  const roster = status.body.roster as SignedRoster;
  // The roster must be signed by the key whose fingerprint was shown, and name that key as hub.
  if (!verifyRoster(roster, [hello.body.public_key]) || roster.roster.hub.public_key !== hello.body.public_key) throw new Error('The roster the hub sent isn’t signed by the hub. Nothing was saved.');
  const deviceId = status.body.device_id as string;
  const device: DeviceFile = {
    version: 1, device_id: deviceId, name, kind, hub_url: hub, join_url: hub, roster, pinned: rosterKeys(roster.roster), epoch: roster.roster.epoch, joined_at: new Date().toISOString(),
    ...(o.novaHome ? { nova_home: resolve(o.novaHome) } : {}),
  };
  if (kind === 'standby') writeStandby(resolve(o.novaHome!), keys, device, ca ? (env.NOVA_CA_FILE ? resolve(env.NOVA_CA_FILE) : p.ca) : null);
  else writeJson(p.keys, exportDeviceKeys(keys));
  writeJson(p.device, device);
  writeJson(p.bootState, { safe_mode: false } satisfies BootState);
  say(`Approved. This device is ${deviceId} in Nova’s registry.`);
  if (kind === 'standby') say(`Start the standby with: NOVA_HOME='${resolve(o.novaHome!)}' node src/server.js (it reads mesh/role.json).`);
  return device;
}

// What a standby's Nova server reads (M4 plan §2, "role.json"): its keys go in its own home as its
// mesh identity (the standby signs its own sessions and rosters), and role.json says who it is
// standby for. Both 0600, in a 0700 folder.
export interface RoleFile {
  version: 1;
  role: 'standby';
  device_id: string;
  hub_url: string;
  hub_id: string;
  identity: 'identity.json';
  roster: SignedRoster;
  pinned: string[];
  epoch: number;
  address: string | null;
  ca_file: string | null;
  joined_at: string;
}

function writeStandby(novaHome: string, keys: DeviceKeys, d: DeviceFile, caFile: string | null): void {
  const dir = join(novaHome, 'mesh');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (existsSync(join(dir, 'identity.json'))) throw new Error(`${novaHome} already has a mesh identity. A standby needs a home of its own.`);
  writeJson(join(dir, 'identity.json'), { version: 1, id: d.device_id, created_at: d.joined_at, ...exportDeviceKeys(keys) });
  const role: RoleFile = {
    version: 1, role: 'standby', device_id: d.device_id, hub_url: d.hub_url, hub_id: d.roster.roster.hub.id, identity: 'identity.json',
    roster: d.roster, pinned: d.pinned, epoch: d.epoch, address: d.roster.roster.standby?.id === d.device_id ? d.roster.roster.standby.url : null, ca_file: caFile, joined_at: d.joined_at,
  };
  writeJson(join(dir, 'role.json'), role);
}

// ---- finding the hub ----------------------------------------------------------------------------

export type Found =
  | { ok: true; url: string; token: string; expires_at: string; epoch: number; moved: boolean }
  | { ok: false; revoked: true; reason: string }
  | { ok: false; revoked: false; reason: string };

// Where to look: the address it last reached the hub at, the hub's and the standby's in the pinned
// roster, and the address it joined at.
export function candidates(d: DeviceFile): string[] {
  const r = d.roster.roster;
  return [...new Set([d.hub_url, r.hub.url, r.standby?.url, d.join_url].filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)).map((u) => new URL(u).origin))];
}

export class Signer {
  #keys: DeviceKeys;
  #last = 0;
  constructor(keys: DeviceKeys) { this.#keys = keys; }
  session(deviceId: string): { device_id: string; time: number; signature: string } {
    const time = (this.#last = Math.max(Math.floor(Date.now() / 1000), this.#last + 1));
    return { device_id: deviceId, time, signature: signMessage(this.#keys.ed25519.privateKey, sessionMessage(deviceId, time)) };
  }
}

// One node: it proves it holds a pinned key and says it is hub at an epoch no lower than known;
// only then is a session signed for it; then its roster must be signed by a pinned key and name it
// as hub. Accepting it re-pins the roster (saved by the caller).
export async function probe(url: string, d: DeviceFile, signer: Signer): Promise<Found & { roster?: SignedRoster }> {
  const challenge = randomBytes(24).toString('base64url');
  let r: Res;
  try {
    r = await call(url, 'GET', `/api/v1/mesh/hello/proof?challenge=${challenge}`, { timeoutMs: 5000 });
  } catch (e) {
    return { ok: false, revoked: false, reason: (e as Error).message };
  }
  if (r.status !== 200) return { ok: false, revoked: false, reason: `${url} didn’t answer the challenge (${errorOf(r)}).` };
  const proof = r.body as Proof;
  const pv = checkProof(proof, challenge, d.pinned);
  if (!pv.ok) return { ok: false, revoked: false, reason: `${url}: ${pv.reason}` };
  if (proof.role !== 'hub') return { ok: false, revoked: false, reason: `${url} is the ${proof.role}, not the hub.` };
  if (proof.epoch < d.epoch) return { ok: false, revoked: false, reason: `${url} says it is hub at epoch ${proof.epoch}, older than ${d.epoch}; it was replaced.` };
  const s = await call(url, 'POST', '/api/v1/mesh/session', { body: signer.session(d.device_id) }).catch((e: Error) => ({ status: 0, body: { error: e.message } }));
  if (s.status === 401 || s.status === 403) {
    const reason = errorOf(s);
    // The hub knows this key and refuses it: revoked (or removed). A clock that is off says so instead.
    if (/revoked/i.test(reason)) return { ok: false, revoked: true, reason };
    return { ok: false, revoked: false, reason: `${url} refused a session: ${reason}` };
  }
  if (s.status !== 200) return { ok: false, revoked: false, reason: `${url} couldn’t start a session (${errorOf(s)}).` };
  const ro = await call(url, 'GET', '/api/v1/mesh/roster', { token: s.body.token }).catch((e: Error) => ({ status: 0, body: { error: e.message } }));
  if (ro.status !== 200) return { ok: false, revoked: false, reason: `${url} didn’t send its roster (${errorOf(ro)}).` };
  const rv = acceptRoster(ro.body, { pinned: d.pinned, epoch: d.epoch, hubKey: proof.public_key });
  if (!rv.ok) return { ok: false, revoked: false, reason: `${url}: ${rv.reason}` };
  const moved = new URL(url).origin !== new URL(d.hub_url).origin || ro.body.roster.epoch > d.epoch;
  return { ok: true, url: new URL(url).origin, token: s.body.token, expires_at: s.body.expires_at, epoch: ro.body.roster.epoch, moved, roster: ro.body };
}

// Takes the first node that passes, in the order of `candidates`. Saves the roster it accepted.
export async function findHub(p: Paths, d: DeviceFile, signer: Signer): Promise<Found> {
  const reasons: string[] = [];
  for (const url of candidates(d)) {
    const f = await probe(url, d, signer);
    if (f.ok) {
      if (!sameRoster(d.roster, f.roster!) || d.hub_url !== f.url) {
        d.roster = f.roster!;
        d.pinned = rosterKeys(f.roster!.roster);
        d.epoch = f.epoch;
        d.hub_url = f.url;
        writeJson(p.device, d);
      }
      const { roster: _r, ...found } = f;
      return found;
    }
    if (f.revoked) return f;
    reasons.push(f.reason);
  }
  return { ok: false, revoked: false, reason: reasons.join(' ') || 'There is nowhere to look for the hub.' };
}

// ---- the runtime: install and start -------------------------------------------------------------

// Whether runtime/ holds exactly what was verified at install time.
export function runtimeIntact(p: Paths): Installed | null {
  const inst = readJson<Installed>(p.installed);
  if (!inst) return null;
  for (const [name, hash] of Object.entries(inst.manifest.files)) {
    try { if (sha256Hex(readFileSync(join(p.runtime, name))) !== hash) return null; } catch { return null; }
  }
  return inst;
}

// Replaces runtime/ with verified files: written to runtime.next/, then swapped in by rename.
export function installRuntime(p: Paths, files: Record<string, Buffer>, version: string, source: Installed['source'], signed: { epoch?: number; issued_at?: string } = {}): Installed {
  const next = `${p.runtime}.next`;
  const prev = `${p.runtime}.prev`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { mode: 0o700 });
  for (const [name, data] of Object.entries(files)) writeFileSync(join(next, name), data, { mode: 0o600 });
  // So Node treats the runtime's .ts files as ES modules without looking above runtime/.
  writeFileSync(join(next, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
  rmSync(prev, { recursive: true, force: true });
  if (existsSync(p.runtime)) renameSync(p.runtime, prev);
  renameSync(next, p.runtime);
  rmSync(prev, { recursive: true, force: true });
  const inst: Installed = { version, manifest: { ...runtimeManifest(version, files), ...signed }, installed_at: new Date().toISOString(), source };
  writeJson(p.installed, inst);
  return inst;
}

// The runtime's own files from this agent's folder: used when no runtime is installed yet and the
// hub can't be asked for one.
export function installLocalRuntime(p: Paths): Installed {
  const files: Record<string, Buffer> = {};
  for (const f of RUNTIME_FILES) files[f] = readFileSync(join(HERE, f));
  return installRuntime(p, files, `local+${runtimeManifest('', files).sha256.slice(0, 12)}`, 'local');
}

// Run before the runtime's own code: takes away the few things Node's permission model doesn't
// guard. process.report writes a diagnostic report to any folder it is told (checking only the
// working folder), v8.setFlagsFromString can switch on V8 tracers that write files anywhere
// (--trace-turbo-path, --redirect-code-traces-to), and process.kill reaches every process of the
// person's — as do the raw bindings under it (process._kill) and process._debugProcess, which
// sends any process the signal that opens its inspector. process.chdir and abort are taken too:
// the runtime starts in state/ and has no reason to leave, and a core dump lands where it stands.
// None of them can be had back: they are replaced, not hidden, and can't be redefined.
export const RUNTIME_SANDBOX = `
const lock = (o, k, v) => Object.defineProperty(o, k, { value: v, writable: false, configurable: false, enumerable: true });
const no = (what) => function () { throw Object.assign(new Error(what + ' isn’t available to the runtime agent.'), { code: 'ERR_ACCESS_DENIED' }); };
lock(process, 'report', undefined);
lock(process, 'kill', no('process.kill'));
lock(process, '_kill', no('process._kill'));
lock(process, '_debugProcess', no('process._debugProcess'));
lock(process, '_debugEnd', no('process._debugEnd'));
lock(process, 'chdir', no('process.chdir'));
lock(process, 'abort', no('process.abort'));
lock(process.getBuiltinModule('node:v8'), 'setFlagsFromString', no('v8.setFlagsFromString'));
process.getBuiltinModule('node:module').syncBuiltinESMExports();
`;

// How the runtime is started (ADR-3): Node's permission model, reading runtime/ and state/, writing
// only state/, and nothing else. Each flag closes a way around that, found by trying them (the
// sandbox test runs every one under these exact flags):
//  - no --allow-net: with it, a unix socket anywhere (an SSH agent, a container daemon) and any
//    loopback service are reachable. The boot agent makes the runtime's hub calls instead;
//  - --no-experimental-sqlite: node:sqlite ignores the permission model and opens, ATTACHes or
//    VACUUMs INTO any path the person can (the queue is plain JSON files for this reason);
//  - --no-experimental-webstorage: no localStorage file of its own;
//  - diagnostics (trace events, heap snapshots near the limit) go to state/, not to whichever
//    folder it was started from; the inspector can't be opened by a signal;
//  - RUNTIME_SANDBOX, above, first.
// Child processes, workers, addons, WASI and the inspector are refused by --permission itself.
export function runtimeCommand(p: Paths, entry = join(p.runtime, 'runtime.ts')): string[] {
  return [
    '--permission', `--allow-fs-read=${p.runtime}/`, `--allow-fs-read=${p.state}/`, `--allow-fs-write=${p.state}/`,
    '--no-experimental-sqlite', '--no-experimental-webstorage', `--diagnostic-dir=${p.state}`,
    `--trace-event-file-pattern=${join(p.state, 'node_trace.${rotation}.log')}`, '--disable-sigusr1',
    `--import=data:text/javascript,${encodeURIComponent(RUNTIME_SANDBOX)}`,
    '--disable-warning=ExperimentalWarning', entry, p.home,
  ];
}

export function spawnRuntime(p: Paths): ChildProcess {
  // An empty environment: nothing of the boot agent's (or the person's shell) leaks into it. It
  // starts in state/, the one folder it may write.
  return spawn(process.execPath, runtimeCommand(p), { cwd: p.state, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { TZ: process.env.TZ ?? 'UTC' } });
}

// ---- run ----------------------------------------------------------------------------------------

export interface RunOptions { heartbeatMs: number; tickMs: number; retryMs: number; backoffMs: number }

export function runOptions(env: NodeJS.ProcessEnv): RunOptions {
  const n = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);
  return { heartbeatMs: n(env.NOVA_DEVICE_HEARTBEAT_MS, 30_000), tickMs: n(env.NOVA_DEVICE_TICK_MS, 2000), retryMs: n(env.NOVA_DEVICE_RETRY_MS, 5000), backoffMs: n(env.NOVA_DEVICE_BACKOFF_MS, 1000) };
}

export class Boot {
  readonly p: Paths;
  readonly o: RunOptions;
  d: DeviceFile;
  state: BootState;
  watchdog: Watchdog<ChildProcess>;
  #signer: Signer;
  #session: { url: string; token: string; expires_at: string } | null = null;
  #looking: Promise<void> | null = null;
  #timers: ReturnType<typeof setInterval>[] = [];
  #updating: Promise<void> | null = null;
  #done: (code: number) => void = () => {};
  // Whether this process runs the runtime (run), or only installs one (the recover command).
  #running = false;
  // Shut down (or revoked): nothing more is looked for, installed or started.
  #closed = false;
  // What this computer can run models on (M6b), read here because the runtime may not start
  // programs; it goes to the hub in the runtime's heartbeat.
  #hardware: Hardware | null = null;
  #hardwareAt = 0;
  readonly finished: Promise<number>;

  // Where the agent's plain-words lines go (its log).
  readonly say: (line: string) => void;

  constructor(home: string, env: NodeJS.ProcessEnv = process.env, o: { say?: (line: string) => void } = {}) {
    this.say = o.say ?? say;
    this.p = paths(home);
    this.o = runOptions(env);
    const d = readJson<DeviceFile>(this.p.device);
    if (!d) throw new Error(`This device hasn’t joined a hub yet (nothing in ${this.p.boot}). Run join first.`);
    if (d.kind === 'standby') throw new Error(`This device home belongs to a standby. A standby runs as a Nova server: NOVA_HOME='${d.nova_home}' node src/server.js`);
    this.d = d;
    this.state = readJson<BootState>(this.p.bootState) ?? { safe_mode: false };
    this.#signer = new Signer(loadKeys(this.p));
    // The hub calls (its own, and the runtime’s) trust the hub’s CA from here on.
    caPem(this.p, env);
    this.watchdog = new Watchdog({ start: () => this.#startRuntime(), backoffMs: this.o.backoffMs, maxBackoffMs: Math.max(this.o.backoffMs, 30_000) });
    this.finished = new Promise((r) => { this.#done = r; });
  }

  async start(o: { signals?: boolean } = {}): Promise<void> {
    if (this.state.revoked) return this.#revoked(this.state.revoked_reason ?? 'It was revoked earlier.', false);
    ensureDirs(this.p);
    this.#lock();
    this.#running = true;
    this.watchdog.on('crash', ({ code, signal, count }) => this.say(`The runtime stopped (${signal ?? `exit ${code}`}); crash ${count} in a minute.`));
    this.watchdog.on('backoff', (ms) => this.say(`Starting it again in ${ms} ms.`));
    this.watchdog.on('safe_mode', () => this.#enterSafeMode());
    void this.#readHardware();
    await this.#connect();
    if (this.#session) await this.update();
    if (!runtimeIntact(this.p)) {
      const inst = installLocalRuntime(this.p);
      this.say(`Installed the runtime from this agent’s own files (${inst.version}); the hub’s will replace it when it can be reached.`);
    }
    if (this.state.safe_mode) {
      this.watchdog.safeMode = true;
      this.say('The agent is in safe mode: the runtime stays stopped. Run recover, or wait for a new runtime from the hub.');
    } else this.watchdog.run();
    if (!this.#session) void this.#lookForHub();
    // Safe mode heartbeats come from here; so do session renewals and the search for the hub.
    this.#timers.push(setInterval(() => void this.#tick(), this.o.heartbeatMs));
    if (o.signals !== false) {
      for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => void this.shutdown(0));
      process.on('SIGHUP', () => void this.recover());
    }
  }

  async shutdown(code: number): Promise<void> {
    this.#closed = true;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    await this.watchdog.stop();
    this.#unlock();
    this.#done(code);
  }

  // Reinstall the runtime from the hub and leave safe mode.
  async recover(): Promise<void> {
    this.say('Recovering: reinstalling the runtime from the hub.');
    if (!this.#session) await this.#connect();
    await this.update({ force: true });
    if (!runtimeIntact(this.p)) installLocalRuntime(this.p);
    this.#leaveSafeMode();
    if (this.#running && !this.#closed) await this.watchdog.restart();
  }

  // A runtime from the hub, when it differs from the one installed: verified against the pinned
  // keys first. A bundle that fails is refused, reported to the hub, and not tried again for a while.
  update(o: { force?: boolean } = {}): Promise<void> {
    this.#updating ??= this.#update(o).finally(() => { this.#updating = null; });
    return this.#updating;
  }

  async #update(o: { force?: boolean }): Promise<void> {
    const s = this.#session;
    if (!s) return;
    let r: Res;
    try { r = await call(s.url, 'GET', '/api/v1/mesh/runtime', { token: s.token }); } catch { return; }
    if (r.status === 401) return this.#unauthorized();
    if (r.status !== 200) return;
    const b = r.body as Bundle;
    const installed = runtimeIntact(this.p);
    if (!o.force && installed && installed.source === 'hub' && installed.manifest.sha256 === b?.manifest?.sha256) return;
    const checked = verifyBundle(b, this.d.pinned);
    // Never back to an older runtime than the hub's one installed, however validly signed: an old
    // bundle served again could bring back a fixed bug.
    const v: typeof checked = checked.ok && installed?.source === 'hub' && runtimeOrder(b.manifest, installed.manifest) < 0
      ? { ok: false, reason: `It is older than the runtime installed (${installed.version}).` }
      : checked;
    if (!v.ok) {
      const sha = String(b?.manifest?.sha256 ?? '');
      const again = this.state.refused_bundle?.sha256 === sha && Date.now() - Date.parse(this.state.refused_bundle.at) < 10 * 60_000;
      if (!again) {
        this.say(`Refused a runtime update from the hub: ${v.reason} The current runtime keeps running.`);
        this.#saveState({ refused_bundle: { sha256: sha, at: new Date().toISOString() }, last_update: { version: String(b?.manifest?.version ?? '?'), at: new Date().toISOString(), result: `refused: ${v.reason}` } });
      }
      await call(s.url, 'POST', '/api/v1/mesh/devices/me/report', { token: s.token, body: { problem: 'runtime_update_refused', detail: v.reason } }).catch(() => {});
      return;
    }
    const inst = installRuntime(this.p, v.files, b.manifest.version, 'hub', { ...(Number.isInteger(b.manifest.epoch) ? { epoch: b.manifest.epoch } : {}), ...(typeof b.manifest.issued_at === 'string' ? { issued_at: b.manifest.issued_at } : {}) });
    this.#saveState({ refused_bundle: null, last_update: { version: inst.version, at: inst.installed_at, result: 'installed' } });
    this.say(`Installed runtime ${inst.version}, signed by the hub.`);
    this.#leaveSafeMode();
    if (this.#running && !this.#closed) await this.watchdog.restart();
  }

  #startRuntime(): ChildProcess {
    const c = spawnRuntime(this.p);
    // Whatever the runtime sends is untrusted: anything that isn't a message we know is dropped, and
    // a failure handling one is said, never left to crash the boot agent.
    c.on('message', (m: unknown) => {
      if (!m || typeof m !== 'object' || typeof (m as { type?: unknown }).type !== 'string') return;
      this.#fromRuntime(m as FromRuntime).catch((e: Error) => this.say(`A message from the runtime failed: ${e.message}`));
    });
    c.on('error', (e) => this.say(`The runtime couldn’t start: ${e.message}`));
    return c;
  }

  #sessionMessage(): SessionMessage | null {
    const s = this.#session;
    const inst = readJson<Installed>(this.p.installed);
    if (!s) return null;
    if (Date.now() - this.#hardwareAt > 3600_000) void this.#readHardware();
    return {
      type: 'session', hub_url: s.url, device_id: this.d.device_id, expires_at: s.expires_at, version: inst?.version ?? 'unknown',
      capabilities: CAPABILITIES, heartbeat_ms: this.o.heartbeatMs, tick_ms: this.o.tickMs,
      ...(this.#hardware ? { hardware: this.#hardware } : {}),
    };
  }

  // Reads the hardware (GPU tools, memory, disk, network cards), then hands it to the runtime for
  // its next heartbeat. A machine without a GPU tool simply reports no GPU.
  async #readHardware(): Promise<void> {
    this.#hardwareAt = Date.now();
    try {
      this.#hardware = await detectHardware({ diskPath: this.p.boot });
      this.#toRuntime();
    } catch (e) {
      this.say(`Couldn’t read this computer’s hardware: ${(e as Error).message}`);
    }
  }

  // The runtime has no network: it asks for one of the hub calls it is allowed, and this agent
  // makes it with its own session (TLS trust included). Anything else is refused without a call.
  async #callForRuntime(m: Extract<FromRuntime, { type: 'call' }>): Promise<void> {
    const c = this.watchdog.child;
    const answer = (a: Omit<CallAnswer, 'type' | 'id'>) => { if (c?.connected) c.send({ type: 'answer', id: m.id, ...a } satisfies CallAnswer); };
    if (!RUNTIME_CALLS.some((r) => r.method === m.method && r.path === m.path)) return answer({ status: 403, body: { error: `The runtime may not call ${String(m.method)} ${String(m.path)}.` } });
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify(m.body ?? null)); } catch { return answer({ status: 400, body: { error: 'That body can’t be sent.' } }); }
    if (size > MAX_CALL_BYTES) return answer({ status: 413, body: { error: `That call is ${size} bytes; the hub takes up to ${MAX_CALL_BYTES}.` } });
    const s = this.#session;
    if (!s) return answer({ error: 'no session with the hub yet' });
    try {
      const r = await call(s.url, m.method, m.path, { token: s.token, body: m.body });
      answer({ status: r.status, body: r.body });
    } catch (e) {
      answer({ error: (e as Error).message });
    }
  }

  #toRuntime(): void {
    const m = this.#sessionMessage();
    const c = this.watchdog.child;
    if (m && c?.connected) c.send(m);
  }

  async #fromRuntime(m: FromRuntime): Promise<void> {
    switch (m.type) {
      case 'ready': return this.#toRuntime();
      case 'unreachable': this.#session = null; return this.#lookForHub();
      case 'unauthorized': return this.#unauthorized();
      case 'update': return this.update();
      case 'heartbeat': return;
      case 'call': return this.#callForRuntime(m);
    }
  }

  async #unauthorized(): Promise<void> {
    this.#session = null;
    await this.#lookForHub();
  }

  // Looks for the hub until it is found: now, then every retry interval. One search at a time.
  #lookForHub(): Promise<void> {
    this.#looking ??= (async () => {
      while (!this.#session && !this.state.revoked && !this.#closed) {
        await this.#connect();
        if (this.#session || this.state.revoked || this.#closed) break;
        await new Promise((r) => setTimeout(r, this.o.retryMs));
      }
    })().finally(() => { this.#looking = null; });
    return this.#looking;
  }

  async #connect(): Promise<void> {
    const before = this.d.hub_url;
    const beforeEpoch = this.d.epoch;
    const f = await findHub(this.p, this.d, this.#signer);
    if (this.#closed) return;
    if (f.ok) {
      const wasOffline = !this.#session;
      this.#session = { url: f.url, token: f.token, expires_at: f.expires_at };
      if (f.url !== before || f.epoch > beforeEpoch) this.say(`Moved to the hub at ${f.url} (epoch ${f.epoch}).`);
      else if (wasOffline) this.say(`Connected to the hub at ${f.url} (epoch ${f.epoch}).`);
      this.#toRuntime();
      return;
    }
    if (f.revoked) return this.#revoked(f.reason, true);
    if (!this.#lastReason || this.#lastReason !== f.reason) this.say(`The hub can’t be reached yet; what is made here waits in the queue. ${f.reason}`);
    this.#lastReason = f.reason;
  }
  #lastReason = '';

  async #tick(): Promise<void> {
    if (this.#closed) return;
    const s = this.#session;
    if (!s) { if (!this.#looking) void this.#lookForHub(); return; }
    // Renew two hours before the session ends.
    if (Date.parse(s.expires_at) - Date.now() < 2 * 60 * 60_000) { this.#session = null; await this.#connect(); return; }
    if (!this.watchdog.safeMode) return;
    // In safe mode the boot agent heartbeats itself, saying so, and takes a new runtime if one comes.
    const inst = readJson<Installed>(this.p.installed);
    try {
      const r = await call(s.url, 'POST', '/api/v1/mesh/devices/me/heartbeat', { token: s.token, body: { capabilities: CAPABILITIES, version: AGENT_VERSION, runtime_version: inst?.version ?? null, safe_mode: true } });
      if (r.status === 401) return this.#unauthorized();
      if (r.status === 200 && inst && r.body?.runtime?.version && r.body.runtime.version !== inst.version) await this.update();
    } catch {
      this.#session = null;
      void this.#lookForHub();
    }
  }

  #enterSafeMode(): void {
    this.#saveState({ safe_mode: true, safe_mode_since: new Date().toISOString() });
    this.say('The runtime crashed three times in a minute. The agent is in safe mode: the runtime stays stopped, and the hub is told. Run recover, or wait for a new runtime from the hub.');
    void this.#tick();
  }

  #leaveSafeMode(): void {
    if (this.state.safe_mode) this.say('Leaving safe mode.');
    this.#saveState({ safe_mode: false, safe_mode_since: null });
    this.watchdog.reset();
  }

  async #revoked(reason: string, now: boolean): Promise<void> {
    this.#closed = true;
    if (now) this.#saveState({ revoked: true, revoked_at: new Date().toISOString(), revoked_reason: reason });
    this.say('This computer was removed from Nova: the hub revoked it. The agent has stopped and won’t start again.');
    this.say('To use this computer with Nova again, add it again with a new code (its old key can never be used again).');
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    await this.watchdog.stop();
    this.#unlock();
    this.#done(EXIT_REVOKED);
  }

  #saveState(patch: Partial<BootState>): void {
    this.state = { ...this.state, ...patch };
    writeJson(this.p.bootState, this.state);
  }

  // One boot agent per device home.
  #lock(): void {
    const other = Number(readJson<number>(this.p.pid));
    if (other && other !== process.pid && alive(other)) throw new Error(`The agent is already running for this device home (process ${other}).`);
    writeJson(this.p.pid, process.pid);
  }

  #unlock(): void {
    if (Number(readJson<number>(this.p.pid)) === process.pid) rmSync(this.p.pid, { force: true });
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

// ---- status -------------------------------------------------------------------------------------

export function status(home: string): Record<string, unknown> {
  const p = paths(home);
  const d = readJson<DeviceFile>(p.device);
  if (!d) return { joined: false, home };
  const st = readJson<BootState>(p.bootState) ?? { safe_mode: false };
  const pid = Number(readJson<number>(p.pid));
  const inst = d.kind === 'computer' ? runtimeIntact(p) : null;
  let queue = null;
  if (existsSync(p.queue)) { const q = new Queue(p.queue); queue = q.counts(); q.close(); }
  return {
    joined: true, home, device_id: d.device_id, name: d.name, kind: d.kind, hub_url: d.hub_url, epoch: d.epoch,
    running: !!pid && alive(pid), pid: pid || null, safe_mode: !!st.safe_mode, revoked: !!st.revoked, revoked_reason: st.revoked_reason ?? null,
    runtime: inst ? { version: inst.version, source: inst.source, installed_at: inst.installed_at } : null, last_update: st.last_update ?? null,
    runtime_status: readJson(p.runtimeStatus), queue,
  };
}

function printStatus(s: Record<string, unknown>): void {
  if (!s.joined) return say(`This device hasn’t joined a hub (device home ${s.home}).`);
  say(`${s.name} (${s.kind}), device ${s.device_id}`);
  say(`Hub: ${s.hub_url} (epoch ${s.epoch})`);
  if (s.revoked) return say(`Revoked: the hub removed this device. ${s.revoked_reason ?? ''}`.trim());
  say(`Agent: ${s.running ? `running (process ${s.pid})` : 'not running'}${s.safe_mode ? ', in safe mode' : ''}`);
  const rt = s.runtime as { version: string; source: string } | null;
  if (rt) say(`Runtime: ${rt.version} (${rt.source === 'hub' ? 'signed by the hub' : 'from this agent'})`);
  const rs = s.runtime_status as { last_heartbeat_at?: string; last_error?: string | null } | null;
  if (rs?.last_heartbeat_at) say(`Last heartbeat: ${rs.last_heartbeat_at}`);
  if (rs?.last_error) say(`Last trouble: ${rs.last_error}`);
  const q = s.queue as { pending: number; delivered: number; refused: number } | null;
  if (q) say(`Queue: ${q.pending} waiting, ${q.delivered} delivered${q.refused ? `, ${q.refused} refused or rejected` : ''}`);
}

// ---- the command line ---------------------------------------------------------------------------

function parse(argv: string[]): { cmd: string; args: string[]; flags: Record<string, string | true> } {
  const [cmd = 'help', ...rest] = argv;
  const args: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) { args.push(a); continue; }
    const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
    if (v !== undefined) flags[k] = v;
    else if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith('--')) flags[k] = rest[++i]!;
    else flags[k] = true;
  }
  return { cmd, args, flags };
}

const USAGE = `Nova's device agent (boot).
  join <hub-url> --code <code> [--name <name>] [--kind computer|standby] [--nova-home <dir>] [--address <url>]
  run | status [--json] | recover
  queue <${QUEUE_KINDS.join('|')}> '<json body>' [--key <key>]
The device home is NOVA_DEVICE_HOME (default ~/.nova-device).`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { cmd, args, flags } = parse(argv);
  const home = deviceHome(env);
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
  switch (cmd) {
    case 'join': {
      const hub = args[0];
      const code = str('code') ?? args[1];
      if (!hub || !code) { say(USAGE); return 2; }
      await joinHub(home, { hub, code, ...(str('name') ? { name: str('name')! } : {}), kind: (str('kind') ?? 'computer') as 'computer', ...(str('nova-home') ? { novaHome: str('nova-home')! } : {}), ...(str('address') ? { address: str('address')! } : {}), ...(env.NOVA_DEVICE_POLL_MS ? { pollMs: Number(env.NOVA_DEVICE_POLL_MS) } : {}) }, env);
      return 0;
    }
    case 'run': {
      const boot = new Boot(home, env);
      await boot.start();
      return boot.finished;
    }
    case 'status': {
      const s = status(home);
      if (flags.json) say(JSON.stringify(s, null, 2));
      else printStatus(s);
      return 0;
    }
    case 'recover': {
      const p = paths(home);
      const pid = Number(readJson<number>(p.pid));
      if (pid && alive(pid)) {
        process.kill(pid, 'SIGHUP');
        say(`Asked the running agent (process ${pid}) to reinstall its runtime and leave safe mode.`);
        return 0;
      }
      const boot = new Boot(home, env);
      await boot.recover();
      say('Done. Start the agent with run.');
      return 0;
    }
    case 'queue': {
      const kind = args[0] as QueueKind;
      if (!QUEUE_KINDS.includes(kind) || !args[1]) { say(USAGE); return 2; }
      mkdirSync(paths(home).state, { recursive: true, mode: 0o700 });
      const q = new Queue(paths(home).queue);
      const r = q.add(kind, JSON.parse(args[1]) as Record<string, unknown>, ...(str('key') ? [str('key')!] : []));
      q.close();
      say(r.added ? `Queued ${kind} ${r.key}.` : `Already queued: ${r.key}.`);
      return 0;
    }
    default:
      say(USAGE);
      return cmd === 'help' || cmd === '--help' ? 0 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e: Error) => {
    console.error(`Nova’s device agent: ${e.message}`);
    process.exit(1);
  });
}
