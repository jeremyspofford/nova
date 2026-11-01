// The ingest gate as the core wires it (plan §1–§9): the screen through the Decision Service (DS1),
// the reader, the outbound guard's sources, and the Work Ledger entry a block opens: a task for the
// `ingest` worker that only this module may create, whose evidence Nova checks by reading the
// screen's record itself.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENVELOPE_VERSION, type Brief, type Report } from '../envelope.ts';
import { Ingest, READER_SYSTEM, type Blocked, type IngestOptions } from './screen.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { Templates } from '../decide.ts';
import type { Ledger, LanedWorker } from '../ledger.ts';
import type { Verifier } from '../verify.ts';
import type { InferRequest, InferResult } from '../models/index.ts';

export const WORKER_ID = 'ingest';
export const CONFIRMATION_SYSTEM = 'ingest-screen';
// The person's own files, read fresh for every model call (Era 2's home.js), which the outbound
// guard keeps from leaving a run that read outside content.
export const STANDING = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md'];

export interface WiredOptions {
  db: Db; log: Log; home: string; now: () => Date;
  templates: Templates; ledger: Ledger; verifier: Verifier;
  // The Decision Service for template ingest-screen, and how it stands (DS1 NOTES 1 and 4).
  ask: IngestOptions['ask']; screening?: IngestOptions['screening'];
  infer: (r: InferRequest) => Promise<InferResult>;
  secrets: () => string[];
  memory: () => string[];
}

export function wireIngest(o: WiredOptions): { ingest: Ingest; worker: LanedWorker } {
  const key = Symbol('ingest');
  const worker: LanedWorker = {
    id: WORKER_ID,
    name: 'Ingest screen',
    about: 'Records outside content Nova blocked before any model read it, and why.',
    egress: 'none',
    evidence: ['confirmation'],
    health: () => ({ ok: true }),
    lane: () => ({ key: 'ingest', max: 1 }),
    internal: { key, why: 'Only Nova’s own screen records what it blocked.' },
    run: async (brief: Brief): Promise<Report> => ({
      envelope: ENVELOPE_VERSION, task_id: brief.task_id, status: 'done',
      summary: String(brief.inputs?.why ?? 'Blocked.'),
      evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: String(brief.inputs?.screen ?? '') }],
      artifacts: [], blockers: [], usage: { duration_ms: 0 }, follow_up_suggestions: [],
    }),
  };
  o.ledger.workers.set(worker.id, worker);
  o.verifier.registerConfirmation(CONFIRMATION_SYSTEM, (e, brief) => {
    const id = (e as { id?: string }).id;
    const r = id ? o.db.get<{ verdict: string; kind: string; origin: string }>('SELECT verdict, kind, origin FROM ingest_screen WHERE id = ?', id) : undefined;
    if (!r) return { ok: false, why: `Nova has no record of screen ${id ?? '(none)'}.` };
    if (r.verdict !== 'block') return { ok: false, why: `Screen ${id} wasn’t a block.` };
    if (brief.inputs?.screen !== id) return { ok: false, why: `Screen ${id} belongs to other work.` };
    return { ok: true, why: `Nova read its own record: screen ${id} blocked content from ${r.origin} (${r.kind}).` };
  });
  let ingest: Ingest;
  const blocked = (b: Blocked) => {
    const task = o.ledger.create({
      title: `Blocked outside content from ${b.origin}`,
      owner: WORKER_ID,
      goal: `Keep content from ${b.origin} (${b.kind}) away from every model. ${b.why}`,
      origin: { kind: 'trigger', ref: `ingest:${b.kind}` },
      evidence_required: [{ kind: 'confirmation', note: 'The screen’s record says it was blocked.' }],
      inputs: { screen: b.id, kind: b.kind, origin: b.origin, flags: b.flags, max: b.max, why: b.why },
      privacy_mode: 'local-only', approval_tier: 0, user_visibility: 'handling', idempotency_key: `ingest:block:${b.id}`,
    }, { as: key });
    ingest.linkTask(b.id, task.id);
  };
  const read: IngestOptions['read'] = async (fenced) => {
    const r = await o.infer({
      role: 'triage-text', privacy_mode: 'local-only', purpose: 'ingest: reader',
      messages: [{ role: 'system', content: READER_SYSTEM }, { role: 'user', content: fenced }],
    });
    return r.text ?? null;
  };
  const standing = () => STANDING.map((f) => join(o.home, f)).filter((p) => existsSync(p)).map((p) => readFileSync(p, 'utf8'));
  ingest = new Ingest({
    db: o.db, log: o.log, now: o.now, templates: o.templates,
    ask: o.ask, screening: o.screening ?? null, read, blocked,
    secrets: o.secrets, memory: o.memory, standing,
  });
  return { ingest, worker };
}

export { Ingest, BLOCK_LINE, SCREEN, QUESTIONS, CHUNK, OVERLAP, SCREEN_CONCURRENCY, DEFAULT_THRESHOLDS, DEFAULT_LINK_CAPS, cleanOrigin, escapeProtocol, wrapData, fence, type Screened, type Source, type SourceKind, type Taint, type Verdict, type Candidate, type Hold, type ScreenInput, type ScreenAnswer, type ScreenAsk, type ScreenStanding } from './screen.ts';
export { PROTOCOL_NAMES, KIND_WORDS, fold } from './checks.ts';
