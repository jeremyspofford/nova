// The task envelope, CONTRACTS §1, version 1: every unit of delegated work goes out as a Brief
// and comes back as a Report, whoever does it. Validation is by hand, so the contract has no
// dependency; every problem found is listed, not just the first.
//
// One addition to the packet's field list, backwards-compatible: `inputs`, optional,
// worker-specific structured parameters. A deterministic worker (no model) cannot act on a
// plain-language goal alone; the goal stays the human statement of the outcome.
import { CoreError } from './errors.ts';

export const ENVELOPE_VERSION = '1';

export const PRIVACY_MODES = ['local-only', 'local-preferred', 'cloud-allowed'] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];
export type Tier = 0 | 1 | 2 | 3;

export const EVIDENCE_KINDS = ['test_result', 'file_diff', 'read_back', 'screenshot', 'url', 'confirmation'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface ContextRef { kind: 'memory' | 'file' | 'task' | 'url'; ref: string; sha256?: string }
export interface EvidenceRequirement { kind: EvidenceKind; target?: string; note?: string }

export interface Brief {
  envelope: typeof ENVELOPE_VERSION;
  task_id: string;
  goal: string;
  context_refs: ContextRef[];
  constraints: { deadline?: string; max_cost_usd?: number; allowed_tools?: string[] };
  privacy_mode: PrivacyMode;
  approval_tier: Tier;
  evidence_required: EvidenceRequirement[];
  idempotency_key: string;
  inputs?: Record<string, unknown>;
}

export type Evidence =
  | { kind: 'read_back'; target: string; sha256: string; bytes: number }
  | { kind: 'test_result'; name: string; passed: boolean; output?: string }
  | { kind: 'file_diff'; target: string; diff: string }
  | { kind: 'screenshot'; ref: string }
  | { kind: 'url'; url: string }
  | { kind: 'confirmation'; system: string; id: string };

export const REPORT_STATUSES = ['done', 'partial', 'blocked', 'failed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface Report {
  envelope: typeof ENVELOPE_VERSION;
  task_id: string;
  status: ReportStatus;
  summary: string;
  evidence: Evidence[];
  artifacts: { kind: string; ref: string; sha256?: string }[];
  blockers: string[];
  usage: { model?: string; tokens_in?: number; tokens_out?: number; cost_usd?: number; duration_ms: number };
  follow_up_suggestions: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

class Check {
  errors: string[] = [];
  need(ok: boolean, msg: string): boolean {
    if (!ok) this.errors.push(msg);
    return ok;
  }
  done<T>(what: string, value: T): T {
    if (this.errors.length) throw new CoreError('validation', `This ${what} doesn't match the task envelope.`, this.errors);
    return value;
  }
}

function checkEvidenceItem(c: Check, e: unknown, at: string): void {
  if (!c.need(isObj(e) && EVIDENCE_KINDS.includes(e.kind as EvidenceKind), `${at}.kind must be one of ${EVIDENCE_KINDS.join(', ')}`)) return;
  const x = e as Obj;
  const str = (k: string) => c.need(isStr(x[k]), `${at}.${k} is required`);
  switch (x.kind) {
    case 'read_back': str('target'); c.need(typeof x.sha256 === 'string' && /^[0-9a-f]{64}$/.test(x.sha256), `${at}.sha256 must be a sha256 hex digest`); c.need(Number.isInteger(x.bytes), `${at}.bytes must be a whole number`); break;
    case 'test_result': str('name'); c.need(typeof x.passed === 'boolean', `${at}.passed must be true or false`); break;
    case 'file_diff': str('target'); c.need(typeof x.diff === 'string', `${at}.diff is required`); break;
    case 'screenshot': str('ref'); break;
    case 'url': str('url'); break;
    case 'confirmation': str('system'); str('id'); break;
  }
}

export function validateBrief(input: unknown): Brief {
  const c = new Check();
  if (!c.need(isObj(input), 'a brief must be an object')) return c.done('brief', input as Brief);
  const b = input as Obj;
  c.need(b.envelope === ENVELOPE_VERSION, `envelope must be "${ENVELOPE_VERSION}"`);
  c.need(isStr(b.task_id), 'task_id is required');
  c.need(isStr(b.goal), 'goal is required: the outcome, in plain words');
  c.need(Array.isArray(b.context_refs) && b.context_refs.every((r) => isObj(r) && ['memory', 'file', 'task', 'url'].includes(r.kind as string) && isStr(r.ref)), 'context_refs must be a list of {kind, ref} pointers, not content');
  c.need(isObj(b.constraints), 'constraints must be an object');
  c.need(PRIVACY_MODES.includes(b.privacy_mode as PrivacyMode), `privacy_mode must be one of ${PRIVACY_MODES.join(', ')}`);
  c.need([0, 1, 2, 3].includes(b.approval_tier as number), 'approval_tier must be 0, 1, 2 or 3');
  if (c.need(Array.isArray(b.evidence_required), 'evidence_required must be a list')) {
    (b.evidence_required as unknown[]).forEach((r, i) => c.need(isObj(r) && EVIDENCE_KINDS.includes(r.kind as EvidenceKind), `evidence_required[${i}].kind must be one of ${EVIDENCE_KINDS.join(', ')}`));
  }
  c.need(isStr(b.idempotency_key), 'idempotency_key is required');
  c.need(b.inputs === undefined || isObj(b.inputs), 'inputs must be an object when present');
  return c.done('brief', b as unknown as Brief);
}

export function validateReport(input: unknown, brief: Brief): Report {
  const c = new Check();
  if (!c.need(isObj(input), 'a report must be an object')) return c.done('report', input as Report);
  const r = input as Obj;
  c.need(r.envelope === ENVELOPE_VERSION, `envelope must be "${ENVELOPE_VERSION}"`);
  c.need(r.task_id === brief.task_id, `task_id must be ${brief.task_id}, the task this report answers`);
  c.need(REPORT_STATUSES.includes(r.status as ReportStatus), `status must be one of ${REPORT_STATUSES.join(', ')}`);
  c.need(isStr(r.summary), 'summary is required');
  if (c.need(Array.isArray(r.evidence), 'evidence must be a list')) (r.evidence as unknown[]).forEach((e, i) => checkEvidenceItem(c, e, `evidence[${i}]`));
  c.need(Array.isArray(r.artifacts), 'artifacts must be a list');
  c.need(Array.isArray(r.blockers) && r.blockers.every((x) => typeof x === 'string'), 'blockers must be a list of strings');
  c.need(isObj(r.usage) && typeof r.usage.duration_ms === 'number', 'usage.duration_ms is required');
  c.need(Array.isArray(r.follow_up_suggestions), 'follow_up_suggestions must be a list');
  return c.done('report', r as unknown as Report);
}
