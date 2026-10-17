// Byte helpers that run in Node and in browsers alike (no Buffer, no node: imports): base64 and
// base64url with strict decoding, UTF-8, concatenation, constant-time comparison and random bytes.

const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function table(alphabet: string): Int16Array {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) t[alphabet.charCodeAt(i)] = i;
  return t;
}
const STD_T = table(STD);
const URL_T = table(URL_SAFE);

function encode(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      alphabet[(n >> 18) & 63]! +
      alphabet[(n >> 12) & 63]! +
      alphabet[(n >> 6) & 63]! +
      alphabet[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + (pad ? '==' : '');
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      alphabet[(n >> 18) & 63]! +
      alphabet[(n >> 12) & 63]! +
      alphabet[(n >> 6) & 63]! +
      (pad ? '=' : '');
  }
  return out;
}

function decode(text: string, t: Int16Array, padded: boolean): Uint8Array {
  let s = text;
  if (padded) {
    if (s.length % 4 !== 0) throw new Error('invalid base64 length');
    if (s.endsWith('==')) s = s.slice(0, -2);
    else if (s.endsWith('=')) s = s.slice(0, -1);
  }
  if (s.length % 4 === 1) throw new Error('invalid base64 length');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? t[c]! : -1;
    if (v < 0) throw new Error('invalid base64 character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero, so every byte string has exactly one encoding.
  if ((acc & ((1 << bits) - 1)) !== 0) throw new Error('non-canonical base64');
  return out;
}

/** Standard base64 with padding (the envelope's `ct`). */
export function toBase64(bytes: Uint8Array): string {
  return encode(bytes, STD, true);
}

export function fromBase64(text: string): Uint8Array {
  return decode(text, STD_T, true);
}

/** base64url without padding (keys, ids, tokens). */
export function toBase64Url(bytes: Uint8Array): string {
  return encode(bytes, URL_SAFE, false);
}

export function fromBase64Url(text: string): Uint8Array {
  return decode(text, URL_T, false);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Constant-time comparison for equal-length secrets (hashes, tokens). */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // getRandomValues fills at most 65536 bytes per call.
  for (let o = 0; o < n; o += 65536) globalThis.crypto.getRandomValues(out.subarray(o, o + 65536));
  return out;
}

/** A random opaque id (base64url, 16 bytes = 22 characters): routing, client and pairing ids. */
export function randomId(bytes = 16): string {
  return toBase64Url(randomBytes(bytes));
}
