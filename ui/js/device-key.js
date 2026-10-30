// This browser as a paired device (M4 plan §1): an Ed25519 key to sign with and an X25519 key to
// seal with, made by WebCrypto as non-extractable keys and kept in IndexedDB, so the private halves
// can be used but never read, not even by this page. There is no fallback: where the browser can't
// make these keys (no secure context, no Ed25519), the page says so plainly and pairing stops.
//
// The wire formats match src/core/mesh/wire.ts: raw public keys and signatures in base64url, and
// every signed string carries its own nova-…-v1 label.

const DB = 'nova-device';
const STORE = 'keys';
const SELF = 'self';
// Set while this browser holds a session, so the app knows to renew it before it runs out.
const FLAG = 'nova.session';

export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const utf8 = (s) => new TextEncoder().encode(s);

// Whether this browser can be a paired device, and if not, why, in plain words.
export async function support() {
  if (!window.isSecureContext) {
    return { ok: false, reason: 'This page isn’t on a secure connection, so the browser won’t make the keys Nova needs to pair it. Open Nova at its https:// address.' };
  }
  if (!crypto?.subtle || !window.indexedDB) return { ok: false, reason: 'This browser can’t keep keys safely, so it can’t be paired with Nova. Try an up-to-date browser.' };
  try {
    await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  } catch {
    return { ok: false, reason: 'This browser can’t make the kind of key Nova uses (Ed25519), so it can’t be paired. Update it, or use another browser. Nova won’t fall back to a weaker key.' };
  }
  return { ok: true, reason: '' };
}

function idb() {
  return new Promise((ok, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

async function tx(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((ok, fail) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => ok(req?.result);
      t.onerror = () => fail(t.error);
    });
  } finally { db.close(); }
}

// The stored identity, or null: { ed, x (CryptoKeyPairs), publicKey, x25519PublicKey, deviceId?, hub? }.
export const load = () => tx('readonly', (s) => s.get(SELF)).then((v) => v ?? null);
const save = (v) => tx('readwrite', (s) => s.put(v, SELF));

// Forgets this browser's keys (after a revocation: a revoked key can never be used again), and
// everything the service worker kept for offline use: those are Nova's answers as this device saw
// them, and a revoked device must not go on showing them. Memory and receipts were never kept.
export async function forget() {
  await tx('readwrite', (s) => s.delete(SELF));
  try { localStorage.removeItem(FLAG); } catch { /* storage may be off */ }
  try {
    if (globalThis.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  } catch { /* no Cache API, or storage is off */ }
}

// A new identity: both private keys non-extractable.
export async function create() {
  const ed = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const x = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  const v = {
    ed, x, deviceId: null, hub: null, created_at: new Date().toISOString(),
    publicKey: b64url(await crypto.subtle.exportKey('raw', ed.publicKey)),
    x25519PublicKey: b64url(await crypto.subtle.exportKey('raw', x.publicKey)),
  };
  await save(v);
  return v;
}

export async function update(patch) {
  const v = { ...(await load()), ...patch };
  await save(v);
  return v;
}

export async function sign(identity, text) {
  return b64url(await crypto.subtle.sign({ name: 'Ed25519' }, identity.ed.privateKey, utf8(text)));
}

export async function verify(publicKey, text, signature) {
  try {
    const key = await crypto.subtle.importKey('raw', fromB64url(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromB64url(signature), utf8(text));
  } catch { return false; }
}

const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text)));
export const nonce = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const commitment = async (publicKey, n) => b64url(await sha256(`nova-add-device-commit-v1|${publicKey}|${n}`));

// The six digits, computed here rather than taken from the hub (wire.ts pairingConfirmationV2).
export async function digits({ hubFingerprint, pairingId, publicKey, code, deviceNonce, hubNonce }) {
  const canonical = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  let r = 0;
  for (const b of await sha256(['nova-add-device-v2', hubFingerprint, pairingId, publicKey, canonical, deviceNonce, hubNonce].join('|'))) r = (r * 256 + b) % 1_000_000;
  return String(r).padStart(6, '0');
}

// Canonical JSON, as the hub signs the roster (wire.ts canonicalJson).
export function canonicalJson(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// Signed times only move forward, so two calls in one second still differ.
let lastTime = 0;
export const signedTime = () => (lastTime = Math.max(Math.floor(Date.now() / 1000), lastTime + 1));

// Starts a session for a paired identity: the hub sets an HttpOnly cookie, which this page never
// sees. Returns the hub's answer, or throws with its words and status.
export async function startSession(identity) {
  const time = signedTime();
  const signature = await sign(identity, `nova-session-v1.${identity.deviceId}.${time}`);
  const res = await fetch('/api/v1/mesh/session', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' },
    body: JSON.stringify({ device_id: identity.deviceId, time, signature, cookie: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Nova didn’t start a session.'); e.status = res.status; throw e; }
  try { localStorage.setItem(FLAG, data.expires_at); } catch { /* storage may be off */ }
  return data;
}

// For the app: whether this browser is a paired device (not the hub's own screen), and when its
// session ends.
export function sessionEnds() {
  try { return localStorage.getItem(FLAG); } catch { return null; }
}

// Signs in again with the stored key. False when there is no key to sign with, or the hub refused
// (a revoked device): then the page should go to /pair.
let renewing = null;
export function renew() {
  renewing ??= (async () => {
    try {
      const identity = await load();
      if (!identity?.deviceId) return false;
      await startSession(identity);
      return true;
    } catch { return false; } finally { setTimeout(() => { renewing = null; }, 0); }
  })();
  return renewing;
}
