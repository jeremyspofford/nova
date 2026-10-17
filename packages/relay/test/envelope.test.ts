// Envelope validation against contracts/schemas/relay-envelope.json (FR-137, ADR-071): every
// field, bad kinds, sizes, and agreement with the schema itself on a corpus of frames.
import { describe, expect, it } from 'vitest';
import { Contracts } from '../../contracts/src/index.ts';
import {
  MAX_CT_CHARS,
  MAX_FRAME_BYTES,
  associatedData,
  encodeEnvelope,
  fromBase64,
  fromBase64Url,
  parseEnvelope,
  toBase64,
  toBase64Url,
  validateEnvelope,
  equalBytes,
  concatBytes,
  randomId,
  fromUtf8,
  utf8,
  type RelayEnvelope,
} from '../src/index.ts';

const A = 'AAAAAAAAAAAAAAAAAAAAAA';
const B = 'BBBBBBBBBBBBBBBBBBBBBB';
const data: RelayEnvelope = {
  v: 1,
  kind: 'data',
  to: A,
  from: B,
  client: 'client-1',
  stream: 'c1',
  seq: 1,
  seg: { i: 0, n: 1 },
  ack: 0,
  ct: toBase64(new Uint8Array(40)),
};

const schema = new Contracts().validator('relay-envelope.json');

function variants(): unknown[] {
  const bigCt = 'A'.repeat(MAX_CT_CHARS);
  return [
    data,
    { v: 1, kind: 'ack', to: A, from: B, client: 'c', stream: 's', ack: 3 },
    { v: 1, kind: 'ping', to: A, from: B },
    { v: 1, kind: 'pong', to: A, from: A },
    { v: 1, kind: 'close', to: A, from: B, reason: 'revoked' },
    { v: 1, kind: 'close', to: A, from: B },
    { ...data, ct: bigCt },
    { ...data, ct: `${bigCt}AAAA` },
    { ...data, v: 2 },
    { ...data, kind: 'push' },
    { ...data, kind: 7 },
    { ...data, to: 'short' },
    { ...data, from: 'has space in it!!!!!' },
    { ...data, to: 'x'.repeat(65) },
    { ...data, client: '' },
    { ...data, client: 'c'.repeat(65) },
    { ...data, stream: '' },
    { ...data, stream: 7 },
    { ...data, seq: 0 },
    { ...data, seq: 1.5 },
    { ...data, seq: '1' },
    { ...data, seg: { i: 0 } },
    { ...data, seg: { i: 256, n: 256 } },
    { ...data, seg: { i: 0, n: 257 } },
    { ...data, seg: { i: 0, n: 0 } },
    { ...data, seg: { i: 0, n: 1, x: 1 } },
    { ...data, seg: [0, 1] },
    { ...data, ack: -1 },
    { ...data, extra: true },
    { ...data, reason: 'nope', kind: 'close' },
    { v: 1, kind: 'data', to: A, from: B, client: 'c', stream: 's', seq: 1 },
    { v: 1, kind: 'data', to: A, from: B, client: 'c', seq: 1, ct: 'AAAA' },
    { v: 1, kind: 'ack', to: A, from: B, client: 'c', stream: 's' },
    { v: 1, kind: 'ack', to: A, from: B, stream: 's', ack: 1 },
    { v: 1, kind: 'ping', to: A, from: B, ct: 'AAAA' },
    { v: 1, kind: 'pong', to: A, from: B, ct: 'AAAA' },
    { v: 1, to: A, from: B },
    { v: 1, kind: 'ping', to: A },
    null,
    [],
    'frame',
  ];
}

describe('envelope validation', () => {
  it('accepts every kind in its schema shape', () => {
    for (const v of variants().slice(0, 7)) {
      expect(validateEnvelope(v).ok, JSON.stringify(v).slice(0, 80)).toBe(true);
      expect(schema(v).ok).toBe(true);
    }
  });

  it('agrees with the JSON schema on every frame of the corpus', () => {
    for (const v of variants()) {
      expect(validateEnvelope(v).ok, JSON.stringify(v)?.slice(0, 120)).toBe(schema(v).ok);
    }
  });

  it('adds the rules the schema states in prose', () => {
    // reason only on close frames
    const r1 = validateEnvelope({ ...data, reason: 'normal' });
    expect(r1).toEqual({ ok: false, error: 'reason is for close frames only' });
    expect(schema({ ...data, reason: 'normal' }).ok).toBe(true);
    // a segment index must be below the count
    expect(validateEnvelope({ ...data, seg: { i: 3, n: 3 } })).toMatchObject({ ok: false });
    // ct must be base64
    expect(validateEnvelope({ ...data, ct: 'not base64!' })).toMatchObject({
      ok: false,
      error: 'bad ct',
    });
  });

  it('names the failing field', () => {
    expect(validateEnvelope({ ...data, kind: 'push' })).toEqual({ ok: false, error: 'bad kind' });
    expect(validateEnvelope({ ...data, to: 'x' })).toEqual({ ok: false, error: 'bad to' });
    expect(validateEnvelope({ ...data, from: 'x' })).toEqual({ ok: false, error: 'bad from' });
    expect(validateEnvelope({ ...data, client: '' })).toEqual({ ok: false, error: 'bad client' });
    expect(validateEnvelope({ ...data, stream: '' })).toEqual({ ok: false, error: 'bad stream' });
    expect(validateEnvelope({ ...data, seq: 0 })).toEqual({ ok: false, error: 'bad seq' });
    expect(validateEnvelope({ ...data, ack: -2 })).toEqual({ ok: false, error: 'bad ack' });
    expect(validateEnvelope({ ...data, seg: { i: 0, n: 0 } })).toEqual({
      ok: false,
      error: 'bad seg.n',
    });
    expect(validateEnvelope({ ...data, seg: { i: -1, n: 1 } })).toEqual({
      ok: false,
      error: 'bad seg.i',
    });
    expect(validateEnvelope({ ...data, seg: 'x' })).toEqual({ ok: false, error: 'bad seg' });
    expect(validateEnvelope({ ...data, v: 2 })).toEqual({ ok: false, error: 'bad v' });
    expect(validateEnvelope({ ...data, x: 1 })).toEqual({ ok: false, error: 'unknown field x' });
    expect(validateEnvelope({ v: 1, kind: 'close', to: A, from: B, reason: 'later' })).toEqual({
      ok: false,
      error: 'bad reason',
    });
    expect(validateEnvelope({ v: 1, kind: 'ping', to: A, from: B, ct: 'AAAA' })).toEqual({
      ok: false,
      error: 'ping carries no ct',
    });
    expect(validateEnvelope(42)).toEqual({ ok: false, error: 'not an object' });
  });

  it('parses text frames with a size limit', () => {
    expect(parseEnvelope(encodeEnvelope(data))).toEqual({ ok: true, envelope: data });
    expect(parseEnvelope('{')).toEqual({ ok: false, error: 'invalid JSON' });
    expect(parseEnvelope('x'.repeat(MAX_FRAME_BYTES + 1))).toEqual({
      ok: false,
      error: 'too_large',
    });
    // Multi-byte characters count in UTF-8.
    expect(parseEnvelope('é'.repeat(MAX_FRAME_BYTES / 2 + 1))).toEqual({
      ok: false,
      error: 'too_large',
    });
    // A full-size data frame with 64-character ids fits.
    const full = {
      ...data,
      to: 'x'.repeat(64),
      from: 'y'.repeat(64),
      client: 'c'.repeat(64),
      stream: 's'.repeat(64),
      seq: Number.MAX_SAFE_INTEGER,
      ack: Number.MAX_SAFE_INTEGER,
      seg: { i: 255, n: 256 },
      ct: 'A'.repeat(MAX_CT_CHARS),
    };
    expect(parseEnvelope(JSON.stringify(full)).ok).toBe(true);
  });

  it('binds client, stream, seq and seg into the associated data unambiguously', () => {
    const a = associatedData({ client: 'a|b', stream: 'c', seq: 1, seg: { i: 0, n: 1 } });
    const b = associatedData({ client: 'a', stream: 'b|c', seq: 1, seg: { i: 0, n: 1 } });
    expect(equalBytes(a, b)).toBe(false);
  });
});

describe('byte helpers', () => {
  it('round-trips base64 and base64url of every length', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
      expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });

  it('refuses malformed base64', () => {
    expect(() => fromBase64('abc')).toThrow();
    expect(() => fromBase64('ab!d')).toThrow();
    expect(() => fromBase64('ab=d')).toThrow();
    expect(() => fromBase64Url('a')).toThrow();
    expect(() => fromBase64Url('a+b/')).toThrow();
    expect(() => fromBase64Url('é')).toThrow();
    // Non-zero trailing bits would give one byte string two encodings.
    expect(() => fromBase64('AB==')).toThrow('non-canonical');
  });

  it('compares, concatenates and encodes', () => {
    expect(equalBytes(utf8('ab'), utf8('ab'))).toBe(true);
    expect(equalBytes(utf8('ab'), utf8('ac'))).toBe(false);
    expect(equalBytes(utf8('ab'), utf8('abc'))).toBe(false);
    expect(fromUtf8(concatBytes(utf8('a'), utf8('bc')))).toBe('abc');
    expect(randomId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomId()).not.toBe(randomId());
    expect(() => fromUtf8(new Uint8Array([0xff]))).toThrow();
  });
});
