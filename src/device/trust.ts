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

// The keys a roster names: the hub's and the standby's.
export function rosterKeys(r: Roster): string[] {
  return [r.hub.public_key, ...(r.standby ? [r.standby.public_key] : [])];
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
