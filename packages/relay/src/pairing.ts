// Pairing through a Relay (FR-137, FR-132, docs/22 §3.1 and §4, contracts/rest-api.md §3.1).
//
// The code never reaches the Relay in clear. Both sides stretch it with PBKDF2 salted with the
// Relay pairing id (crypto.ts) into a hash the Relay compares claims against and two keys:
// - the Hub's offer (its routing id, its X25519 key signed by its identity key, the Add Device
//   pairing id) is sealed with the offer key and handed to whoever presents the right hash;
// - the client's claim (its device and X25519 keys, the X25519 key signed by the device key, its
//   name and platform) is sealed with the claim key, so the Relay forwards it without reading it.
// Opening either proves knowledge of the code; the owner's comparison of the confirmation codes on
// both screens (Add Device) is the human check on top.
import { fromBase64Url, toBase64Url, utf8, fromUtf8 } from './bytes.ts';
import {
  normalizePairingCode,
  open,
  seal,
  sha256,
  verifyEd25519,
  keyFingerprint,
  type Ed25519Signer,
} from './crypto.ts';

export const RELAY_CLIENT_KINDS = ['browser', 'native'] as const;
export type RelayClientKind = (typeof RELAY_CLIENT_KINDS)[number];

export interface PairingOffer {
  v: 1;
  /** The Hub's routing id at the Relay. */
  hubRoute: string;
  /** The Hub's X25519 key for this Relay (raw, base64url). */
  x25519: string;
  /** The Add Device pairing the code belongs to. */
  addPairingId: string;
  /** The Hub identity key (FR-134) when the Hub has one, its fingerprint and its signature. */
  identityKey: string | null;
  fingerprint: string | null;
  sig: string | null;
}

export interface PairingClaim {
  v: 1;
  /** The canonical code, so the Hub's Add Device service can check it like a direct claim. */
  code: string;
  /** The device's Ed25519 key (raw, base64url): Add Device's `publicKey`. */
  publicKey: string;
  x25519: string;
  name: string;
  platform: string;
  kind: RelayClientKind;
  /** The device key's signature over the X25519 binding. */
  sig: string;
}

const KEY = /^[A-Za-z0-9_-]{43}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;

/** What a side signs to vouch for its X25519 key in this pairing. */
export function bindingBytes(
  role: 'hub' | 'client',
  x25519: string,
  relayPairingId: string,
  hubRoute = '',
): Uint8Array {
  return utf8(JSON.stringify(['nova-relay-bind-v1', role, x25519, relayPairingId, hubRoute]));
}

function sealJson(key: Uint8Array, label: string, relayPairingId: string, value: unknown): string {
  return seal(key, utf8(JSON.stringify(value)), utf8(`${label}|${relayPairingId}`));
}

function openJson(key: Uint8Array, label: string, relayPairingId: string, sealed: string): unknown {
  const bytes = open(key, sealed, utf8(`${label}|${relayPairingId}`));
  if (!bytes) return null;
  try {
    return JSON.parse(fromUtf8(bytes)) as unknown;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number, min = 1): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

// ---- the Hub's side ------------------------------------------------------------------------------

export async function createOffer(input: {
  offerKey: Uint8Array;
  relayPairingId: string;
  hubRoute: string;
  x25519: string;
  addPairingId: string;
  identity?: {
    publicKey: string;
    sign(bytes: Uint8Array): Promise<Uint8Array> | Uint8Array;
  } | null;
}): Promise<string> {
  let identityKey: string | null = null;
  let fingerprint: string | null = null;
  let sig: string | null = null;
  if (input.identity) {
    identityKey = input.identity.publicKey;
    fingerprint = await keyFingerprint(identityKey);
    sig = toBase64Url(
      await input.identity.sign(
        bindingBytes('hub', input.x25519, input.relayPairingId, input.hubRoute),
      ),
    );
  }
  const offer: PairingOffer = {
    v: 1,
    hubRoute: input.hubRoute,
    x25519: input.x25519,
    addPairingId: input.addPairingId,
    identityKey,
    fingerprint,
    sig,
  };
  return sealJson(input.offerKey, 'nova-relay-offer-v1', input.relayPairingId, offer);
}

/** Open and check a client's claim; null when it does not open, parse or verify. */
export async function openClaim(
  claimKey: Uint8Array,
  relayPairingId: string,
  sealed: string,
): Promise<PairingClaim | null> {
  const v = openJson(claimKey, 'nova-relay-claim-v1', relayPairingId, sealed);
  if (!isRecord(v) || v.v !== 1) return null;
  if (
    !str(v.code, 16) ||
    typeof v.publicKey !== 'string' ||
    !KEY.test(v.publicKey) ||
    typeof v.x25519 !== 'string' ||
    !KEY.test(v.x25519) ||
    !str(v.name, 100) ||
    !str(v.platform, 50) ||
    !(RELAY_CLIENT_KINDS as readonly unknown[]).includes(v.kind) ||
    typeof v.sig !== 'string' ||
    !SIG.test(v.sig)
  )
    return null;
  const ok = await verifyEd25519(
    v.publicKey,
    bindingBytes('client', v.x25519, relayPairingId),
    fromBase64Url(v.sig),
  );
  if (!ok) return null;
  return {
    v: 1,
    code: v.code,
    publicKey: v.publicKey,
    x25519: v.x25519,
    name: v.name,
    platform: v.platform,
    kind: v.kind as RelayClientKind,
    sig: v.sig,
  };
}

// ---- the client's side ---------------------------------------------------------------------------

export async function createClaim(input: {
  claimKey: Uint8Array;
  relayPairingId: string;
  code: string;
  device: Ed25519Signer;
  x25519: string;
  name: string;
  platform: string;
  kind: RelayClientKind;
}): Promise<string> {
  const sig = toBase64Url(
    await input.device.sign(bindingBytes('client', input.x25519, input.relayPairingId)),
  );
  const claim: PairingClaim = {
    v: 1,
    code: normalizePairingCode(input.code),
    publicKey: input.device.publicKey,
    x25519: input.x25519,
    name: input.name,
    platform: input.platform,
    kind: input.kind,
    sig,
  };
  return sealJson(input.claimKey, 'nova-relay-claim-v1', input.relayPairingId, claim);
}

/**
 * Open the Hub's offer and check it: it must open with the code's key, name the routing id the
 * Relay reported, and, when the Hub has an identity key, carry its valid signature; with `pin`
 * (the fingerprint from the QR payload) the identity must match it.
 */
export async function openOffer(input: {
  offerKey: Uint8Array;
  relayPairingId: string;
  sealed: string;
  hubRoute: string;
  pin?: string | null;
}): Promise<PairingOffer> {
  const v = openJson(input.offerKey, 'nova-relay-offer-v1', input.relayPairingId, input.sealed);
  if (!isRecord(v) || v.v !== 1) throw new Error('the Hub offer does not open with this code');
  if (
    v.hubRoute !== input.hubRoute ||
    typeof v.x25519 !== 'string' ||
    !KEY.test(v.x25519) ||
    !str(v.addPairingId, 64)
  )
    throw new Error('the Hub offer is malformed');
  let identityKey: string | null = null;
  let fingerprint: string | null = null;
  let sig: string | null = null;
  if (v.identityKey !== null && v.identityKey !== undefined) {
    if (
      typeof v.identityKey !== 'string' ||
      !KEY.test(v.identityKey) ||
      typeof v.sig !== 'string' ||
      !SIG.test(v.sig)
    )
      throw new Error('the Hub offer is malformed');
    const ok = await verifyEd25519(
      v.identityKey,
      bindingBytes('hub', v.x25519, input.relayPairingId, input.hubRoute),
      fromBase64Url(v.sig),
    );
    if (!ok) throw new Error('the Hub offer signature does not verify');
    identityKey = v.identityKey;
    fingerprint = await keyFingerprint(identityKey);
    sig = v.sig;
  }
  if (input.pin && input.pin !== fingerprint)
    throw new Error('the Hub identity does not match the pinned fingerprint');
  return {
    v: 1,
    hubRoute: input.hubRoute,
    x25519: v.x25519,
    addPairingId: v.addPairingId,
    identityKey,
    fingerprint,
    sig,
  };
}

/**
 * The confirmation code both screens show (Add Device, docs/22 §4.1 step 2): SHA-256 of
 * `nova-add-device-v1|<hub fingerprint or ''>|<pairingId>|<publicKey>|<canonical code>`, read as
 * a big-endian integer, mod 10^6, zero-padded. The same computation as the Hub's Add Device service.
 */
export async function confirmationCode(input: {
  hubFingerprint: string | null;
  pairingId: string;
  publicKey: string;
  code: string;
}): Promise<string> {
  const digest = await sha256(
    utf8(
      [
        'nova-add-device-v1',
        input.hubFingerprint ?? '',
        input.pairingId,
        input.publicKey,
        normalizePairingCode(input.code),
      ].join('|'),
    ),
  );
  let r = 0;
  for (const b of digest) r = (r * 256 + b) % 1_000_000;
  return String(r).padStart(6, '0');
}
