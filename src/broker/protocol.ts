// The Credential Broker's wire protocol (docs/plans/vault-broker.md §3–§4). Newline-delimited JSON
// over local IPC, one id per request, a size cap, and unknown fields refused. The broker answers
// seven fixed verbs and three protocol messages, and nothing else: its launcher is its own child,
// spoken to over a pipe, never over this socket. No answer to core carries a value, a part of one,
// its length, or a hash of it: every answer is checked against ANSWER_KEYS before it is written
// (checkAnswer). Text core sent is never echoed back, and answers aren't scrubbed as a whole: only
// what a target sent back (a response, a program's output) is, of the value that use injected.
//
// This file imports nothing; the core client imports its types only.

export const VERBS = ['list_refs', 'use', 'create', 'update', 'rotate', 'bind', 'share_scope'] as const;
export const MESSAGES = ['hello', 'unlock', 'lock'] as const;
export type Verb = (typeof VERBS)[number];
export type Message = Verb | (typeof MESSAGES)[number];
export type Role = 'core' | 'supervisor';

// The fixed refusal list (§4), each with plain words.
export const REFUSALS = {
  not_bound: 'That credential isn’t bound to this target, so the broker won’t use it there. Binding a target is a tier-3 approval.',
  out_of_scope: 'That request is outside what this credential’s binding allows.',
  needs_approval: 'This needs your approval first.',
  approval_invalid: 'The approval doesn’t match this action, has expired, or was already used.',
  locked: 'Nova’s vault is locked. Unlock it with your own factor.',
  class_policy: 'This credential’s sensitivity class doesn’t allow that.',
  rate: 'Too many requests for this credential, or too many approval requests. Something keeps asking to use your credentials.',
  unknown_ref: 'There is no credential with that reference.',
  wrong_target_kind: 'That kind of target isn’t one this credential can be used on (or isn’t built yet).',
} as const;
export type Refusal = keyof typeof REFUSALS;

// Protocol-level errors: a frame the broker can't take at all. Not refusals of a verb.
export const ERRORS = {
  bad_frame: 'That frame isn’t one the broker reads.',
  too_large: 'That frame is larger than the broker accepts.',
  unknown_message: 'The broker answers seven verbs and three protocol messages; that isn’t one of them.',
  unknown_field: 'That message carries a field the broker doesn’t take.',
  unauthenticated: 'Say hello with a valid token first.',
  not_allowed: 'That role can’t send this message.',
  failed: 'The broker couldn’t do that.',
} as const;
export type ProtocolError = keyof typeof ERRORS;

export const MAX_FRAME = 2 * 1024 * 1024;

// The fields each message may carry (besides `id` and `m`). Anything else is refused.
const COMMON = ['task', 'caller', 'approval'];
export const FIELDS: Record<Message, readonly string[]> = {
  hello: ['token'],
  unlock: ['passphrase', 'recovery', 'passkey', 'device', 'setup'],
  lock: [],
  list_refs: ['filter'],
  use: [...COMMON, 'ref', 'target', 'request', 'version'],
  create: [...COMMON, 'meta', 'source', 'bind'],
  update: [...COMMON, 'ref', 'change'],
  rotate: [...COMMON, 'ref', 'phase'],
  bind: [...COMMON, 'ref', 'add', 'remove'],
  share_scope: [...COMMON, 'device', 'backend', 'hub'],
};

// Every key that may appear anywhere in an answer to core or the supervisor. A schema check over
// every answer type (gate item 5): none of these is a field that carries a value. `body` is the
// target's own response, scrubbed of every value the broker holds in each encoding (§8).
export const ANSWER_KEYS: ReadonlySet<string> = new Set([
  'id', 'ok', 'refused', 'error', 'words', 'role', 'record', 'problem',
  // vault state
  'state', 'locked', 'exists', 'vault_id', 'unlock_mode', 'approval_mode', 'factors', 'entry_key', 'boot', 'device_id', 'device_key', 'holders', 'kdf', 'alg', 'm', 't', 'p', 'safe_mode',
  // refs and metadata
  'refs', 'ref', 'aliases', 'name', 'kind', 'origin', 'username', 'class', 'suggested_class', 'per_use', 'created_at', 'last_used', 'last_rotated', 'health', 'reused', 'old', 'backend', 'version', 'pending', 'bindings',
  'target', 'scope', 'methods', 'paths', 'consent', 'rate_per_hour', 'granted_at', 'approval_id', 'inject', 'how', 'header', 'prefix', 'format', 'lan', 'pin', 'embed_on', 'env', 'file', 'argv',
  // approvals
  'challenge', 'digest', 'expires_at', 'card', 'tier', 'verb', 'what', 'flags', 'task', 'approving', 'items', 'passkey',
  // outcomes
  'outcome', 'status', 'headers', 'body', 'truncated', 'valid', 'exit', 'stdout', 'stderr', 'migrated', 'kept', 'moved', 'staged', 'read_back', 'removed', 'device', 'outbox', 'text', 'hub', 'signer',
  // audit records
  'seq', 'at', 'prev', 'hash', 'scope_item',
]);

// Header names a response may pass on to core (everything else is dropped, never forwarded).
export const RESPONSE_HEADERS = ['content-type', 'content-length', 'location', 'retry-after', 'etag', 'last-modified', 'date', 'x-request-id', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

// The keys allowed are checked recursively, except under `headers` (header names) and `refs`
// filters, which are data. Returns the first key that isn't allowed, or null.
export function checkAnswer(v: unknown, path = ''): string | null {
  if (v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) { for (const x of v) { const bad = checkAnswer(x, path); if (bad) return bad; } return null; }
  for (const [k, x] of Object.entries(v)) {
    const free = path.endsWith('.headers') || path.endsWith('.methods');
    if (!free && !ANSWER_KEYS.has(k)) return `${path}.${k}`;
    if (!free) { const bad = checkAnswer(x, `${path}.${k}`); if (bad) return bad; }
    else if (typeof x !== 'string' && typeof x !== 'number') return `${path}.${k}`;
  }
  return null;
}

export interface Frame { id: string | number; m: Message; [k: string]: unknown }

// Parses one line into a frame, or says why not. Checks the message name and its fields only;
// each handler checks the fields' contents.
export function parseFrame(line: string): { frame: Frame } | { error: ProtocolError; id: string | number | null } {
  if (line.length > MAX_FRAME) return { error: 'too_large', id: null };
  let v: unknown;
  try { v = JSON.parse(line); } catch { return { error: 'bad_frame', id: null }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'bad_frame', id: null };
  const o = v as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id.length <= 64 ? o.id : typeof o.id === 'number' && Number.isSafeInteger(o.id) ? o.id : null;
  if (id === null) return { error: 'bad_frame', id: null };
  if (typeof o.m !== 'string' || !Object.hasOwn(FIELDS, o.m)) return { error: 'unknown_message', id };
  const allowed = new Set(['id', 'm', ...FIELDS[o.m as Message]]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) return { error: 'unknown_field', id };
  return { frame: o as Frame };
}

// A canonical JSON text (sorted keys), for approval digests: what the card shows is what is signed.
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

// ---- the shapes core sees (types only; erased at run time) --------------------------------------

export type TargetKind = 'web' | 'http' | 'ws' | 'stream' | 'process' | 'service' | 'device';
export interface Target { kind: TargetKind; origin?: string; path?: string; sha256?: string }
export interface Scope { methods: string[]; paths: string[] }
export interface Inject { how: 'bearer' | 'basic' | 'header' | 'sign' | 'verify' | 'env' | 'file' | 'fill'; header?: string; env?: string; prefix?: string; format?: 'hex' | 'base64' }
export interface Consent { scope: Scope; rate_per_hour: number; granted_at: string; approval_id: string; last_used: string | null }
export interface Binding { target: string; kind: TargetKind; scope: Scope; inject: Inject; consent: Consent | null; lan?: boolean; pin?: string | null; embed_on?: string[] }
export interface RefMeta {
  ref: string; aliases: string[]; name: string; kind: string; origin: string | null; username: string | null;
  class: 'standard' | 'sensitive'; per_use: boolean; created_at: string; last_used: string | null; last_rotated: string | null;
  health: { reused: boolean; old: boolean }; backend: 'nova'; version: number; pending: boolean; bindings: Binding[];
}
// The card shows stored metadata and what the broker computed; never text from the frame that asked
// (core shows the task and who asked from its own records).
export interface Card { argv?: string[]; verb: string; what: string; name?: string; origin?: string | null; username?: string | null; target?: string; scope?: Scope; class?: string; flags?: string[]; tier: number; approving: string; expires_at: string; items?: unknown[] }
export interface Challenge { id: string; digest: string; expires_at: string; card: Card; tier: number }
export interface AuditRecord { seq: number; at: string; device: string; verb: string; ref: string | null; target: string | null; scope_item: string | null; outcome: string; tier: number | null; approval_id: string | null; task: string | null; role: Role; prev: string; hash: string }
