// Private to shared (FR-088, docs/13 §4, ADR-070, docs/06 invariant 18): before a reply goes to a
// shared channel, find private content it carries. The agents area replaces this with exact
// provenance (`memory.originOf`); until then the default compares the reply with private sources
// by word sequences: private-origin memory items and agent notes, and what people said in the
// threads of the agent's private bindings and in-app channel and in the owner's recent chats
// (past-chat recall can bring those into a turn).
// Text the shared thread itself already holds is not private (someone in the channel said it).
// A match does not block by itself: the channel's policy decides (default ask the owner).
import type { NovaDatabase } from '@nova/storage';

/**
 * A piece of private content a reply would carry into a shared channel. `file` (M8): a file the
 * check cannot read (an image, a PDF), which counts as private, as a failed check does.
 */
export interface PrivateSource {
  kind: 'memory' | 'thread' | 'file';
  id: string;
}

export interface PrivateOriginInput {
  accountId: string;
  agentId: string | null;
  /** The shared binding's thread the reply belongs to. */
  threadId: string;
  turnId: string | null;
  text: string;
}

/** Which private content a reply uses; empty when none. */
export type PrivateOriginCheck = (input: PrivateOriginInput) => Promise<PrivateSource[]>;

const SHINGLE = 4;
const STOP = new Set(
  (
    'a an and are as at be but by for from has have i if in into is it its me my no not of on ' +
    'or our so that the their them then there these they this to was we were what when which ' +
    'who will with you your yes do does did can could would should said say'
  ).split(' '),
);
/** Bounds on what is read per check. */
const MAX_MEMORY_ITEMS = 500;
const MAX_THREADS = 20;
const MAX_PARTS_PER_THREAD = 200;

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Word 4-grams that are not only stop words, and tokens with digits (codes, numbers). */
export function fingerprints(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= w.length; i++) {
    const gram = w.slice(i, i + SHINGLE);
    if (gram.every((t) => STOP.has(t) || t.length <= 2)) continue;
    out.add(gram.join(' '));
  }
  for (const t of w) if (t.length >= 3 && /\d/.test(t)) out.add(`#${t}`);
  return out;
}

interface Source extends PrivateSource {
  text: string;
}

/** The default check over the database (see the header). */
export function overlapPrivacyCheck(db: NovaDatabase): PrivateOriginCheck {
  return (input) => {
    const reply = fingerprints(input.text);
    if (!reply.size) return Promise.resolve([]);
    // What the shared thread already holds is public to its channel, except the reply's own turn
    // (stored before the check runs: counting it would make every reply look public).
    for (const t of threadTexts(db, input.threadId, { exceptTurn: input.turnId }))
      for (const f of fingerprints(t)) reply.delete(f);
    if (!reply.size) return Promise.resolve([]);
    const hits: PrivateSource[] = [];
    for (const s of privateSources(db, input)) {
      const fp = fingerprints(s.text);
      for (const f of reply) {
        if (fp.has(f)) {
          hits.push({ kind: s.kind, id: s.id });
          break;
        }
      }
    }
    return Promise.resolve(dedupe(hits));
  };
}

function dedupe(list: PrivateSource[]): PrivateSource[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = `${s.kind}:${s.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function threadTexts(
  db: NovaDatabase,
  threadId: string,
  opts: { exceptTurn?: string | null; role?: 'user' } = {},
): string[] {
  const exceptTurn = opts.exceptTurn ?? null;
  const role = opts.role ?? null;
  const rows = db.raw
    .prepare(
      `SELECT p.content FROM message_part p JOIN message m ON m.id = p.message_id
       WHERE m.thread_id = ? AND m.deleted_at IS NULL AND p.type = 'text' AND p.content IS NOT NULL
         AND (? IS NULL OR m.turn_id IS NULL OR m.turn_id <> ?)
         AND (? IS NULL OR m.role = ?)
       ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(threadId, exceptTurn, exceptTurn, role, role, MAX_PARTS_PER_THREAD) as {
    content: string;
  }[];
  return rows.map((r) => r.content);
}

function* privateSources(db: NovaDatabase, input: PrivateOriginInput): Generator<Source> {
  const memory = db.raw
    .prepare(
      `SELECT id, content FROM memory_item
       WHERE account_id = ? AND status = 'active' AND origin_audience = 'private'
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(input.accountId, MAX_MEMORY_ITEMS) as { id: string; content: string }[];
  for (const m of memory) yield { kind: 'memory', id: m.id, text: m.content };
  // The agent's own notes that came from private threads (FR-089).
  const notes = db.raw
    .prepare(
      `SELECT m.id, m.content FROM agent_memory m JOIN agent g ON g.id = m.agent_id
       WHERE g.account_id = ? AND m.origin_audience = 'private' AND (? IS NULL OR g.id = ?)
       ORDER BY m.updated_at DESC LIMIT ?`,
    )
    .all(input.accountId, input.agentId, input.agentId, MAX_MEMORY_ITEMS) as {
    id: string;
    content: string;
  }[];
  for (const n of notes) yield { kind: 'memory', id: n.id, text: n.content };
  // Private threads: the agent's private and in-app bindings, then the owner's recent chats that
  // no shared binding owns.
  const bound = db.raw
    .prepare(
      `SELECT DISTINCT thread_id AS id FROM channel_binding
       WHERE account_id = ? AND thread_id IS NOT NULL AND thread_id <> ?
         AND (audience = 'private' OR kind = 'inapp')
         AND (agent_id IS ? OR agent_id = ?)`,
    )
    .all(input.accountId, input.threadId, input.agentId, input.agentId) as { id: string }[];
  const recent = db.raw
    .prepare(
      `SELECT t.id FROM thread t
       WHERE t.account_id = ? AND t.id <> ? AND t.deleted_at IS NULL AND t.temporary = 0
         AND NOT EXISTS (SELECT 1 FROM channel_binding b
                         WHERE b.thread_id = t.id AND b.audience = 'shared' AND b.kind <> 'inapp')
       ORDER BY t.updated_at DESC LIMIT ?`,
    )
    .all(input.accountId, input.threadId, MAX_THREADS) as { id: string }[];
  const ids = [...new Set([...bound, ...recent].map((r) => r.id))];
  // What people said in those threads; the agent's own wording there restates it (and its stock
  // phrases, the same in every thread, would look private everywhere).
  for (const id of ids)
    for (const text of threadTexts(db, id, { role: 'user' })) yield { kind: 'thread', id, text };
}
