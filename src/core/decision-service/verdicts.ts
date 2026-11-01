// Eval binding (ADR §6; moved and generalised from Part 1's verdict.ts). A template's thresholds
// count only while a pre-registered eval verdict PASSES for that exact tuple: template, version,
// seat, and model version (a Jev version id, or a Tev1 tag and registry digest). Anything else is
// untrusted: the seat answers as a shadow, logged as evidence, and doesn't decide. A model bump is
// a new tuple, so its verdict is missing until the eval runs again. Verdicts are written by eval
// runs only; CI recomputes Part 1's from its committed per-case results, so a hand edit fails.
import { readFileSync, statSync } from 'node:fs';
import { BOUNDS, type Bounds, type Metrics } from './eval.ts';
import { BOUNDS_V2 } from './eval-v2.ts';
import { BOUNDS_CS } from './eval-capture.ts';
import { BOUNDS_MG } from './eval-memory.ts';
import { modelId, type Size } from './seats/tev1.ts';
import type { SeatId } from './types.ts';

// Part 1's verdicts: ingest-screen v1 on Tev1, per size and digest.
export const VERDICTS_FILE = new URL('./tev1-verdicts.json', import.meta.url);
export const PART1_TEMPLATE = { template_id: 'ingest-screen', version: 1 } as const;
// The wording Part 1's eval ran on (registry.ts wordingOf(INGEST_SCREEN_V1)). Its verdicts count only
// while ingest-screen v1 still reads exactly so; CI checks the template against it.
export const PART1_WORDING = '444bb949c7426d08242b8fc191f7078ee37e8b88a15b4d20892c930cee370f0f';

export type SizeStatus = 'pass' | 'fail' | 'not-run';
export interface SizeVerdict {
  status: SizeStatus;
  why: string;
  digest: string | null;
  run_at: string | null;
  ollama: string | null;
  metrics: Pick<Metrics, 'detection' | 'false_positive' | 'ece'> | null;
}
export interface VerdictFile {
  bounds: Bounds;
  bounds_commit: string | null;
  cases_sha256: string;
  sizes: Record<Size, SizeVerdict>;
}

export function readVerdicts(file: URL | string = VERDICTS_FILE): VerdictFile {
  return JSON.parse(readFileSync(file, 'utf8')) as VerdictFile;
}

export interface Reliance { relied: boolean; why: string }
const sameBounds = (a: Bounds, b: Bounds) => (Object.keys(b) as (keyof Bounds)[]).every((k) => a?.[k] === b[k]) && Object.keys(a ?? {}).length === Object.keys(b).length;
const short = (d: string | null) => (d ? d.replace(/^sha256:/, '').slice(0, 12) : 'none');

// Part 1's rule, for a Tev1 size and installed digest.
export function relianceFor(v: VerdictFile | null, model: Size | null, digest: string | null): Reliance {
  if (!model) return { relied: false, why: 'No Tev1 size is in use.' };
  const s = v?.sizes?.[model];
  if (!v || !s) return { relied: false, why: `There is no recorded eval verdict for ${model}; its scores are advisory.` };
  if (!sameBounds(v.bounds, BOUNDS)) return { relied: false, why: `The eval verdict for ${model} was recorded against other bounds; its scores are advisory until the eval runs again.` };
  if (s.status === 'not-run') return { relied: false, why: `The injection eval hasn’t been run on ${model} yet (${s.why}); its scores are advisory.` };
  if (s.status === 'fail') return { relied: false, why: `${model} didn’t pass the injection eval (${s.why}); its scores are advisory.` };
  const want = digest?.replace(/^sha256:/, '') ?? null;
  if (!want || s.digest?.replace(/^sha256:/, '') !== want) return { relied: false, why: `The installed ${model} isn’t the build the eval passed (${short(s.digest)} was tested, ${short(digest)} is installed); its scores are advisory until the eval runs again.` };
  return { relied: true, why: `${model} passed the injection eval on ${s.run_at?.slice(0, 10) ?? 'record'}; its scores are used.` };
}

// ---- the general store --------------------------------------------------------------------------

// `wording_sha256`: the template wording the eval ran on (registry.ts wordingOf); absent, unpinned.
export interface VerdictRecord { template_id: string; version: number; seat: SeatId; model: string; status: SizeStatus; why: string; run_at: string | null; ref: string; wording_sha256?: string }
export interface Lookup { trusted: boolean; why: string; ref: string | null; wording?: string | null }

export interface VerdictStore {
  // Whether this exact tuple has a passing verdict.
  lookup(templateId: string, version: number, seat: SeatId, model: string | null): Lookup;
  // Whether any decision seat has passed this template version (retires the sorting model).
  passed(templateId: string, version: number): boolean;
  // Every record for a seat and model (the scorecard shown before switching).
  forModel(seat: SeatId, model: string): VerdictRecord[];
}

export function memoryVerdicts(records: VerdictRecord[]): VerdictStore {
  const same = (r: VerdictRecord, id: string, v: number) => r.template_id === id && r.version === v;
  return {
    lookup(id, v, seat, model) {
      if (!model) return { trusted: false, why: `${seat} has no model in use.`, ref: null };
      const r = records.find((x) => same(x, id, v) && x.seat === seat && x.model === model);
      if (!r) return { trusted: false, why: `${id} v${v} has no eval verdict on ${model}; its answers are evidence only until the eval runs on that exact model.`, ref: null };
      if (r.status !== 'pass') return { trusted: false, why: `${id} v${v} ${r.status === 'fail' ? 'failed' : 'hasn’t run'} its eval on ${model} (${r.why}); its answers are evidence only.`, ref: r.ref };
      return { trusted: true, why: `${id} v${v} passed its eval on ${model}${r.run_at ? ` (${r.run_at.slice(0, 10)})` : ''}.`, ref: r.ref, wording: r.wording_sha256 ?? null };
    },
    passed: (id, v) => records.some((r) => same(r, id, v) && r.status === 'pass' && (r.seat === 'jev' || r.seat === 'tev1')),
    forModel: (seat, model) => records.filter((r) => r.seat === seat && r.model === model),
  };
}

// Part 1's file as records: a size's verdict applies only to its exact digest, and only under the
// bounds in eval.ts.
export function fileRecords(v: VerdictFile | null): VerdictRecord[] {
  if (!v) return [];
  const ok = sameBounds(v.bounds, BOUNDS);
  return (Object.entries(v.sizes) as [Size, SizeVerdict][])
    .filter(([, s]) => s.digest)
    .map(([size, s]) => ({
      ...PART1_TEMPLATE, seat: 'tev1' as const, model: modelId(size, s.digest!),
      status: ok ? s.status : 'not-run', why: ok ? s.why : 'recorded against other bounds',
      run_at: s.run_at, ref: `tev1-verdicts.json#${size}@${v.bounds_commit ?? 'unpinned'}`, wording_sha256: PART1_WORDING,
    }));
}

// Every later eval's verdicts (ingest-screen v2 onwards, DS2): records written by eval runs only,
// each under the bounds and pre-run commit it was registered with. Under other bounds than the
// code's, a record counts as not run.
export const RECORDS_FILE = new URL('./verdicts.json', import.meta.url);
export interface RecordsFile { bounds: Record<string, number>; pre_run_commit: string | null; cases_sha256: string | null; records: VerdictRecord[] }

export function readRecords(file: URL | string = RECORDS_FILE): RecordsFile {
  return JSON.parse(readFileSync(file, 'utf8')) as RecordsFile;
}

export function recordsOf(f: RecordsFile | null, bounds: Record<string, number> = BOUNDS_V2): VerdictRecord[] {
  if (!f) return [];
  const ok = Object.keys(bounds).length === Object.keys(f.bounds ?? {}).length && Object.keys(bounds).every((k) => f.bounds?.[k] === bounds[k]);
  return f.records.map((r) => (ok ? r : { ...r, status: 'not-run' as const, why: 'recorded against other bounds' }));
}

// Each later eval keeps its own records file, under its own registered bounds.
export const CAPTURE_RECORDS_FILE = new URL('./verdicts-capture-sensitive.json', import.meta.url);
export const MEMORY_RECORDS_FILE = new URL('./verdicts-memory-gate.json', import.meta.url);
export const RECORD_SETS: { file: URL; bounds: Record<string, number> }[] = [
  { file: RECORDS_FILE, bounds: BOUNDS_V2 },
  { file: CAPTURE_RECORDS_FILE, bounds: BOUNDS_CS },
  { file: MEMORY_RECORDS_FILE, bounds: BOUNDS_MG },
];

// The verdicts the service uses: Part 1's file and the records file, read fresh each time so a new
// run takes effect.
export function fileVerdicts(file: URL | string = VERDICTS_FILE, sets: { file: URL | string; bounds: Record<string, number> }[] = RECORD_SETS): VerdictStore {
  // Read again only when a file changed (its time or size), not on every ask (review, minor: status
  // and Health ask on every call).
  let cached: { stamp: string; store: VerdictStore } | null = null;
  const stampOf = () => [file, ...sets.map((s) => s.file)].map((f) => { try { const s = statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } }).join('|');
  const read = () => {
    const stamp = stampOf();
    if (cached?.stamp === stamp) return cached.store;
    let all: VerdictRecord[] = [];
    try { all = all.concat(fileRecords(readVerdicts(file))); } catch { /* none yet */ }
    for (const set of sets) { try { all = all.concat(recordsOf(readRecords(set.file), set.bounds)); } catch { /* none yet */ } }
    cached = { stamp, store: memoryVerdicts(all) };
    return cached.store;
  };
  return {
    lookup: (...a) => read().lookup(...a),
    passed: (...a) => read().passed(...a),
    forModel: (...a) => read().forModel(...a),
  };
}
