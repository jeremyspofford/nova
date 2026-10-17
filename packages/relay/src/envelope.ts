// The Relay envelope (FR-137, ADR-071, docs/22 §3.1, contracts/rest-api.md §3.2,
// contracts/schemas/relay-envelope.json). The validator applies the schema's rules by hand so the
// library stays dependency-free in browsers; test/envelope.test.ts checks it against the schema.
import { utf8 } from './bytes.ts';

export const RELAY_ENVELOPE_VERSION = 1;
export const RELAY_KINDS = ['data', 'ack', 'ping', 'pong', 'close'] as const;
export type RelayKind = (typeof RELAY_KINDS)[number];
export const RELAY_CLOSE_REASONS = [
  'normal',
  'revoked',
  'unknown_route',
  'too_large',
  'idle',
] as const;
export type RelayCloseReason = (typeof RELAY_CLOSE_REASONS)[number];

/** Plaintext per segment (64 KiB). */
export const SEGMENT_BYTES = 64 * 1024;
/** Segments per message; with SEGMENT_BYTES this caps a message at 16 MiB. */
export const MAX_SEGMENTS = 256;
export const MAX_MESSAGE_BYTES = SEGMENT_BYTES * MAX_SEGMENTS;
export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;
/** base64 of nonce + one full segment + tag (the schema's `ct.maxLength`). */
export const MAX_CT_CHARS = Math.ceil((NONCE_BYTES + SEGMENT_BYTES + TAG_BYTES) / 3) * 4;
/**
 * The largest JSON frame a Relay accepts: a full data envelope with 64-character ids is about
 * 87.8 KB; anything larger is refused with `close {reason: too_large}`.
 */
export const MAX_FRAME_BYTES = 96 * 1024;
export const ROUTE_ID = /^[A-Za-z0-9_-]{16,64}$/;

export interface RelaySegment {
  i: number;
  n: number;
}

export interface RelayEnvelope {
  v: 1;
  kind: RelayKind;
  to: string;
  from: string;
  client?: string;
  stream?: string;
  seq?: number;
  seg?: RelaySegment;
  ack?: number;
  ct?: string;
  reason?: RelayCloseReason;
}

export type EnvelopeCheck = { ok: true; envelope: RelayEnvelope } | { ok: false; error: string };

const FIELDS = new Set([
  'v',
  'kind',
  'to',
  'from',
  'client',
  'stream',
  'seq',
  'seg',
  'ack',
  'ct',
  'reason',
]);
// Standard base64 with padding; the length check comes first so the regex never sees huge input.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function idString(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 64;
}

/**
 * Check one frame against relay-envelope.json, plus three rules the schema states in prose:
 * `reason` only on `close` frames, `seg.i < seg.n`, and `ct` must be valid base64.
 */
export function validateEnvelope(value: unknown): EnvelopeCheck {
  if (!isRecord(value)) return { ok: false, error: 'not an object' };
  for (const k of Object.keys(value))
    if (!FIELDS.has(k)) return { ok: false, error: `unknown field ${k}` };
  if (value.v !== RELAY_ENVELOPE_VERSION) return { ok: false, error: 'bad v' };
  const kind = value.kind;
  if (typeof kind !== 'string' || !(RELAY_KINDS as readonly string[]).includes(kind))
    return { ok: false, error: 'bad kind' };
  if (typeof value.to !== 'string' || !ROUTE_ID.test(value.to))
    return { ok: false, error: 'bad to' };
  if (typeof value.from !== 'string' || !ROUTE_ID.test(value.from))
    return { ok: false, error: 'bad from' };
  if ('client' in value && !idString(value.client)) return { ok: false, error: 'bad client' };
  if ('stream' in value && !idString(value.stream)) return { ok: false, error: 'bad stream' };
  if ('seq' in value && !(isInt(value.seq) && value.seq >= 1))
    return { ok: false, error: 'bad seq' };
  if ('seg' in value) {
    const seg = value.seg;
    if (!isRecord(seg) || Object.keys(seg).some((k) => k !== 'i' && k !== 'n'))
      return { ok: false, error: 'bad seg' };
    if (!isInt(seg.i) || seg.i < 0 || seg.i > MAX_SEGMENTS - 1)
      return { ok: false, error: 'bad seg.i' };
    if (!isInt(seg.n) || seg.n < 1 || seg.n > MAX_SEGMENTS)
      return { ok: false, error: 'bad seg.n' };
    if (seg.i >= seg.n) return { ok: false, error: 'seg.i must be below seg.n' };
  }
  if ('ack' in value && !(isInt(value.ack) && value.ack >= 0))
    return { ok: false, error: 'bad ack' };
  if ('ct' in value) {
    const ct = value.ct;
    if (typeof ct !== 'string' || ct.length > MAX_CT_CHARS || !BASE64.test(ct))
      return { ok: false, error: 'bad ct' };
  }
  if ('reason' in value) {
    const r = value.reason;
    if (typeof r !== 'string' || !(RELAY_CLOSE_REASONS as readonly string[]).includes(r))
      return { ok: false, error: 'bad reason' };
    if (kind !== 'close') return { ok: false, error: 'reason is for close frames only' };
  }
  switch (kind as RelayKind) {
    case 'data':
      for (const k of ['client', 'stream', 'seq', 'ct'])
        if (!(k in value)) return { ok: false, error: `data needs ${k}` };
      break;
    case 'ack':
      for (const k of ['client', 'stream', 'ack'])
        if (!(k in value)) return { ok: false, error: `ack needs ${k}` };
      break;
    case 'ping':
    case 'pong':
      if ('ct' in value) return { ok: false, error: `${kind} carries no ct` };
      break;
    case 'close':
      break;
  }
  return { ok: true, envelope: value as unknown as RelayEnvelope };
}

/** Parse and validate one text frame; frames above `maxBytes` are refused before parsing. */
export function parseEnvelope(text: string, maxBytes = MAX_FRAME_BYTES): EnvelopeCheck {
  // A UTF-16 length bound first (cheap), then the exact UTF-8 size.
  if (text.length > maxBytes || utf8(text).length > maxBytes)
    return { ok: false, error: 'too_large' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  return validateEnvelope(value);
}

export function encodeEnvelope(env: RelayEnvelope): string {
  return JSON.stringify(env);
}

/**
 * The associated data a data segment is sealed with: the canonical bytes of client, stream, seq
 * and seg (docs/22 §3.1), as a JSON array so no field boundary is ambiguous. The Relay cannot
 * move a segment to another client, stream, position or message without the open failing.
 */
export function associatedData(f: {
  client: string;
  stream: string;
  seq: number;
  seg: RelaySegment;
}): Uint8Array {
  return utf8(JSON.stringify(['nova-relay-v1', f.client, f.stream, f.seq, f.seg.i, f.seg.n]));
}
