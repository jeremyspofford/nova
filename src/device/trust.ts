// What the boot agent believes, and why (M4 plan §2, ADR-11). Pure functions over what it pinned:
//  - a node is the hub only if it proves it holds a pinned key, says it is hub, and hands over a
//    roster signed by a pinned key, naming it as hub, with an epoch at least the one known. A lower
//    epoch is never accepted: that is how a demoted hub is fenced off from devices;
//  - a runtime bundle is installed only if a pinned key signed its manifest and every file matches
//    its hash.
// The device agent ships alone, so this imports only the wire format (node:crypto underneath).
import {
  canonicalJson, helloProofMessage, runtimeManifest, runtimeManifestMessage, sha256Hex, verifyDeviceSignature, verifyRoster,
  type Roster, type RuntimeManifest, type SignedRoster,
} from '../core/mesh/wire.ts';

export type Verdict = { ok: true } | { ok: false; reason: string };

// The keys that may hold the hub's role: the hub's, the standby's, and every other hub candidate the
// roster lists (M10g, Decision 2: each candidacy was confirmed at tier 3, so a cold promotion onto
// any of them needs no new pairing). A node is still accepted as hub only by proving one of these
// keys, at an epoch no lower than known, with a roster signed by that same key (`checkProof`,
// `acceptRoster`), and the hub it replaced steps down because fencing covers every candidate too.
export function rosterKeys(r: Roster): string[] {
  return [...new Set([r.hub.public_key, ...(r.standby ? [r.standby.public_key] : []), ...(Array.isArray(r.candidates) ? r.candidates.map((c) => c.public_key) : [])].filter((k): k is string => typeof k === 'string'))];
}

// The keys a runtime bundle may be signed by: the hub's and the standby's, as before M10g. A
// candidate signs bundles once it is the hub, never before (M10f held candidate trust back for this).
export function bundleKeys(r: Roster): string[] {
  return [r.hub.public_key, ...(r.standby ? [r.standby.public_key] : [])];
}

// What this device may run (M10f, the orchestration ADR Point 9: "checked twice"). The hub checks a
// placement when it is proposed; the device checks again, against the roles it holds itself (kept in
// device.json from its approval and from each heartbeat answer), and refuses an assignment they don't
// allow. A thin client, or a device with no workload role, never runs anything. The roles are the
// hub's (src/core/mesh/purposes.ts WORKLOAD_PURPOSES); this file ships alone, so they are listed here
// and a test keeps the two the same.
export const WORKLOAD_ROLES: readonly string[] = Object.freeze(['compute', 'storage', 'capture-source', 'general-server']);

export function assignmentAllowed(purposes: readonly string[] | undefined, workload: { service: string; roles?: readonly string[] }): Verdict {
  const mine = Array.isArray(purposes) ? purposes : [];
  if (!mine.some((p) => WORKLOAD_ROLES.includes(p))) {
    return { ok: false, reason: mine.includes('thin-client') ? `This device is a thin client, so it runs nothing for Nova: ${workload.service} was refused.` : `This device has no workload role, so ${workload.service} was refused. Give it one in Settings › Devices on the hub.` };
  }
  const want = workload.roles?.length ? workload.roles : ['general-server'];
  const missing = want.filter((r) => !mine.includes(r));
  if (missing.length) return { ok: false, reason: `${workload.service} needs ${missing.join(', ')}, which this device isn’t, so it was refused.` };
  return { ok: true };
}

export interface Proof { id: string; role: string; epoch: number; public_key: string; signature: string }

// A node's answer to our challenge: signed by the key it claims, and that key is pinned.
export function checkProof(p: Proof, challenge: string, pinned: string[]): Verdict {
  if (!p || typeof p !== 'object' || typeof p.public_key !== 'string' || typeof p.epoch !== 'number') return { ok: false, reason: 'It didn’t answer the challenge.' };
  if (!pinned.includes(p.public_key)) return { ok: false, reason: 'Its key isn’t one this device pinned.' };
  const claim = { id: p.id, role: p.role, epoch: p.epoch, public_key: p.public_key };
  if (!verifyDeviceSignature(p.public_key, helloProofMessage(challenge, claim), p.signature)) return { ok: false, reason: 'Its answer to the challenge isn’t signed by the key it claims.' };
  return { ok: true };
}

// Whether to take `next` as the roster: signed by a pinned key, an epoch no lower than the one
// known, and (when given) naming `hubKey`, the key of the node that handed it over, as hub.
export function acceptRoster(next: SignedRoster, o: { pinned: string[]; epoch: number; hubKey?: string }): Verdict {
  if (!next?.roster || typeof next.roster.epoch !== 'number' || !next.roster.hub) return { ok: false, reason: 'That isn’t a roster.' };
  if (!verifyRoster(next, o.pinned)) return { ok: false, reason: 'The roster isn’t signed by a key this device pinned.' };
  if (!Number.isInteger(next.roster.epoch) || next.roster.epoch < o.epoch) return { ok: false, reason: `The roster’s epoch (${next.roster.epoch}) is lower than the one this device knows (${o.epoch}); that node is no longer the hub.` };
  if (o.hubKey && next.roster.hub.public_key !== o.hubKey) return { ok: false, reason: 'The roster names a different node as hub.' };
  return { ok: true };
}

// The same roster, ignoring when it was issued.
export function sameRoster(a: SignedRoster | null, b: SignedRoster): boolean {
  if (!a) return false;
  const { issued_at: _a, ...ra } = a.roster;
  const { issued_at: _b, ...rb } = b.roster;
  return canonicalJson(ra) === canonicalJson(rb);
}

// Which of two signed runtimes is newer: the higher epoch, then the later signing time. A manifest
// without them (an older hub's, or this agent's own files) counts as oldest.
export function runtimeOrder(a: Pick<RuntimeManifest, 'epoch' | 'issued_at'>, b: Pick<RuntimeManifest, 'epoch' | 'issued_at'>): number {
  const t = (m: Pick<RuntimeManifest, 'issued_at'>) => (m.issued_at && !Number.isNaN(Date.parse(m.issued_at)) ? Date.parse(m.issued_at) : 0);
  return (a.epoch ?? 0) - (b.epoch ?? 0) || t(a) - t(b);
}

export interface Bundle { manifest: RuntimeManifest; signature: string; signer: string; files: Record<string, string> }

// The runtime's files, checked: names are plain file names, a pinned key signed the manifest, the
// manifest matches the files' hashes, and the files are exactly the ones the manifest lists.
export function verifyBundle(b: Bundle, pinned: string[]): { ok: true; files: Record<string, Buffer> } | { ok: false; reason: string } {
  if (!b || typeof b !== 'object' || !b.manifest || typeof b.files !== 'object' || b.files === null) return { ok: false, reason: 'The download isn’t a runtime bundle.' };
  if (!pinned.includes(b.signer)) return { ok: false, reason: 'It was signed by a key this device didn’t pin.' };
  if (!verifyDeviceSignature(b.signer, runtimeManifestMessage(b.manifest), b.signature)) return { ok: false, reason: 'Its signature doesn’t match its manifest.' };
  const files: Record<string, Buffer> = {};
  for (const [name, data] of Object.entries(b.files)) {
    if (!/^[a-z][a-z0-9-]*\.ts$/.test(name) || typeof data !== 'string') return { ok: false, reason: `It carries a file it shouldn’t (${name}).` };
    files[name] = Buffer.from(data, 'base64');
  }
  const names = Object.keys(files).sort();
  if (canonicalJson(names) !== canonicalJson(Object.keys(b.manifest.files ?? {}).sort())) return { ok: false, reason: 'Its files aren’t the ones its manifest lists.' };
  for (const n of names) if (sha256Hex(files[n]!) !== b.manifest.files[n]) return { ok: false, reason: `${n} doesn’t match its hash.` };
  if (runtimeManifest('', files).sha256 !== b.manifest.sha256) return { ok: false, reason: 'Its manifest’s hash is wrong.' };
  if (!files['runtime.ts']) return { ok: false, reason: 'It has no runtime.ts.' };
  return { ok: true, files };
}
