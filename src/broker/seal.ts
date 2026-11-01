// Sealed entry, the person's side (docs/plans/vault-broker.md §10 "How values come in"). Runs in
// the person's own client (WebCrypto only: a browser, or Node's globalThis.crypto) and never in
// core: a value the person types is sealed here to the broker's per-boot entry key, bound to the
// digest of the action it belongs to, and reaches the broker through core as ciphertext.
// ECDH P-256 → HKDF-SHA256 (salt: the digest, info: nova-broker-entry-v1) → AES-256-GCM (AAD: the
// digest). The broker's side is openEnvelope in crypto.ts.
//
// A stated limit: the console's code comes from core, so sealed entry rests on that code being the
// released one (ADR-9).

const enc = new TextEncoder();
const toB64 = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
};
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const fromHex = (h: string): Uint8Array<ArrayBuffer> => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

export interface Envelope { epk: string; iv: string; ct: string }

export async function sealValue(entryKeyB64: string, digest: string, value: string | Uint8Array<ArrayBuffer>): Promise<Envelope> {
  const subtle = globalThis.crypto.subtle;
  const brokerKey = await subtle.importKey('raw', fromB64(entryKeyB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const shared = await subtle.deriveBits({ name: 'ECDH', public: brokerKey }, eph.privateKey, 256);
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: fromHex(digest), info: enc.encode('nova-broker-entry-v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(digest) }, key, typeof value === 'string' ? enc.encode(value) : value);
  return { epk: toB64(await subtle.exportKey('raw', eph.publicKey)), iv: toB64(iv), ct: toB64(ct) };
}

// What an unlock factor is sealed to: not an approval, so the digest names the vault, the factor
// and this boot of the broker (from list_refs' state), and a captured envelope dies with the boot.
export async function unlockDigest(vaultId: string, factor: string, boot: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(`nova-broker-unlock|${vaultId}|${factor}|${boot}`));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
