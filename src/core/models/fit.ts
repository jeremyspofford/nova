// Whether a model fits a device (docs/plans/model-fit-adr-2026-11-04.md): deterministic arithmetic,
// never an LLM's guess. Memory needed = weights + KV cache + runtime overhead + a safety reserve +
// what else holds the GPU, against the device's budget. Every verdict names the quant and context it
// assumed. Pure: no files, no network, the same input gives the same output, in integer bytes.
//
// Also here, as the ADR specifies: the device budget (from the hardware Nova already reads), the
// learned overhead (corrected after real loads, within bounds; the reserve is never learned), the
// labelled fallback tier table (derived from the same formula), and per-task recommendations
// (privacy first, then the task class, then fit and ranking).
//
// Wired in (step 2b): recommend.ts decides fit with this engine, chat calls send the context it
// assumed (num_ctx), and the model manager learns the overhead after real loads (device_overhead).
// recommendFit (the per-task-class ranking) waits for the Models screen; see the LEDGER entry.
import type { PrivacyMode } from '../envelope.ts';
import type { Hardware } from './hardware.ts';

export const GiB = 1024 ** 3;

export const QUANTS = ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'F16'] as const;
export type Quant = (typeof QUANTS)[number];
export type KvType = 'f16' | 'q8_0' | 'q4_0';
export type Verdict = 'fits' | 'tight' | 'wont-fit';

export interface FitDevice {
  memory: 'gpu' | 'unified' | 'cpu';
  budget_bytes: number;
  // Where the budget came from: read off the device, or Nova's estimate. Absent means an estimate.
  budget_source?: BudgetSource;
  other_use_bytes: number;       // 0 when unknown (other_use_known: false)
  other_use_known: boolean;
  overhead_bytes: number;        // learned_overhead.bytes, or the prior
  overhead_source: 'prior' | 'learned';
}

export interface FitModel {
  name: string;
  params: number;                // parameter count, e.g. 8_200_000_000
  weights_bytes: number | null;  // the file's size when installed; null when only planned
  quant: Quant;
  context: number;               // tokens Nova will request (num_ctx)
  arch: { layers: number; kv_heads: number; head_dim: number } | null;
  arch_source: 'backend' | 'catalog' | null;
  kv_type: KvType;
}
export type Arch = NonNullable<FitModel['arch']>;

export interface FitInput { device: FitDevice; models: FitModel[] }

export interface FitPart { name: string; weights_bytes: number; kv_bytes: number }

export interface FitResult {
  verdict: Verdict;
  basis: 'formula' | 'tier-table';
  assumed: { quant: Quant; context: number; kv_type: KvType }[];
  parts: FitPart[];
  overhead_bytes: number;
  reserve_bytes: number;
  other_use_bytes: number;
  need_bytes: number;
  budget_bytes: number;
  budget_source: BudgetSource;
  headroom_bytes: number;
  max_context_fits: number | null;
  words: string;
}

// ---- the arithmetic ------------------------------------------------------------------------------

// Effective bits per weight, including the higher-precision embedding and output tensors. Kept in
// tenths of a bit so the weight estimate stays integer arithmetic.
export const BITS_PER_WEIGHT: Record<Quant, number> = { Q4_K_M: 5.0, Q5_K_M: 5.7, Q6_K: 6.6, Q8_0: 8.5, F16: 16 };
const BPW_TENTHS: Record<Quant, number> = { Q4_K_M: 50, Q5_K_M: 57, Q6_K: 66, Q8_0: 85, F16: 160 };
// Bytes per KV element: f16 2, q8_0 1, q4_0 0.5.
export const KV_BYTES_PER_ELEMENT: Record<KvType, number> = { f16: 2, q8_0: 1, q4_0: 0.5 };
// The same, doubled: the K-and-V factor of 2 and q4_0's half byte cancel into an integer.
const KV_BOTH_BYTES: Record<KvType, number> = { f16: 4, q8_0: 2, q4_0: 1 };

export const PRIOR_OVERHEAD_BYTES = 1 * GiB;   // the CUDA or Metal context and compute buffers
export const MIN_RESERVE_BYTES = GiB / 2;       // the reserve is max(0.5 GB, 5% of the budget)
export const CONTEXT_STEP = 1024;

export const weightsBytes = (params: number, quant: Quant): number => Math.ceil((params * BPW_TENTHS[quant]) / 80);
// layers × context × KV heads × head dim × 2 (K and V) × bytes per element.
export const kvBytes = (arch: Arch, context: number, kv: KvType): number => arch.layers * context * arch.kv_heads * arch.head_dim * KV_BOTH_BYTES[kv];
// Rounded up, so the reserve never comes out smaller than 5%.
export const reserveBytes = (budget: number): number => Math.max(MIN_RESERVE_BYTES, Math.ceil(budget / 20));
// Fits up to 90% of the budget, Tight up to 100%, Won't fit above. In integers: need × 10 ≤ budget × 9.
export const verdictOf = (need: number, budget: number): Verdict => (need * 10 <= budget * 9 ? 'fits' : need <= budget ? 'tight' : 'wont-fit');

// The shapes Nova assumes for a model class when it can't read a model's own: the tier table is
// derived from these, and so is the estimate for a model of unknown shape. Model-card figures as
// the ADR records them; they pin the arithmetic, not the model cards.
export const REFERENCE_SHAPES: { class: string; name: string; params: number; arch: Arch }[] = [
  { class: '3B', name: 'llama3.2:3b', params: 3_200_000_000, arch: { layers: 28, kv_heads: 8, head_dim: 128 } },
  { class: '4B', name: 'qwen3:4b', params: 4_000_000_000, arch: { layers: 36, kv_heads: 8, head_dim: 128 } },
  { class: '8B', name: 'qwen3:8b', params: 8_200_000_000, arch: { layers: 36, kv_heads: 8, head_dim: 128 } },
  { class: '14B', name: 'qwen3:14b', params: 14_800_000_000, arch: { layers: 40, kv_heads: 8, head_dim: 128 } },
  { class: '32B', name: 'qwen3:32b', params: 32_800_000_000, arch: { layers: 64, kv_heads: 8, head_dim: 128 } },
];

// The smallest reference class at least as large as the model; past the largest, its layers scale.
// A model without grouped-query attention can need more KV than this; that is why the verdict is
// labelled an estimate.
export function referenceArch(params: number): Arch {
  const s = REFERENCE_SHAPES.find((r) => r.params >= params);
  if (s) return s.arch;
  const big = REFERENCE_SHAPES[REFERENCE_SHAPES.length - 1]!;
  return { ...big.arch, layers: Math.ceil((big.arch.layers * params) / big.params) };
}

const ctxWords = (n: number): string => (n % CONTEXT_STEP === 0 ? `${n / CONTEXT_STEP}k` : `${n.toLocaleString('en-US')}-token`);
const at = (m: FitModel) => `at ${m.quant} with ${ctxWords(m.context)} context`;

export function fit(input: FitInput): FitResult {
  const { device, models } = input;
  if (!models.length) throw new Error('fit needs at least one model.');
  const basis = models.some((m) => m.arch === null) ? 'tier-table' : 'formula';
  const parts = models.map((m): FitPart => ({
    name: m.name,
    weights_bytes: m.weights_bytes ?? weightsBytes(m.params, m.quant),
    kv_bytes: kvBytes(m.arch ?? referenceArch(m.params), m.context, m.kv_type),
  }));
  // Overhead and the reserve count once for the whole set, not once per model.
  const overhead = device.overhead_bytes;
  const reserve = reserveBytes(device.budget_bytes);
  const other = Math.max(0, device.other_use_bytes);
  const need = parts.reduce((s, p) => s + p.weights_bytes + p.kv_bytes, 0) + overhead + reserve + other;
  const budget = device.budget_bytes;
  const verdict = verdictOf(need, budget);

  // The largest context, in steps of 1,024, at which the one model still Fits (90% of the budget).
  let max: number | null = null;
  const only = models.length === 1 ? models[0]! : null;
  if (only && only.arch) {
    const fixed = need - parts[0]!.kv_bytes;
    const perToken = kvBytes(only.arch, 1, only.kv_type);
    const room = budget * 9 - fixed * 10;
    max = room <= 0 ? 0 : Math.floor(Math.floor(room / (10 * perToken)) / CONTEXT_STEP) * CONTEXT_STEP;
  }

  let words: string;
  if (only) {
    words = verdict === 'fits' ? `Fits comfortably ${at(only)}.`
      : verdict === 'tight' ? `Fits, but tight, ${at(only)}: nothing else can stay loaded.`
      : `Won’t fit ${at(only)}.${max ? ` At ${only.quant} it fits up to ${ctxWords(max)}.` : ''}`;
  } else {
    const list = models.map((m) => `${m.name} ${at(m)}`).join('; ');
    words = verdict === 'fits' ? `Fits comfortably together: ${list}.`
      : verdict === 'tight' ? `Fits together, but tight: ${list}. Nothing else can stay loaded.`
      : `Won’t fit together: ${list}.`;
  }
  if (basis === 'tier-table') words = `Estimate: Nova doesn’t know this model’s shape. ${words}`;
  if (device.memory === 'cpu') words += ' It runs on the CPU, slow.';
  else if (!device.other_use_known) words += ' Nova can’t see what else is using this memory, so that isn’t counted.';

  return {
    verdict, basis,
    assumed: models.map((m) => ({ quant: m.quant, context: m.context, kv_type: m.kv_type })),
    parts, overhead_bytes: overhead, reserve_bytes: reserve, other_use_bytes: other,
    need_bytes: need, budget_bytes: budget, budget_source: device.budget_source ?? 'estimate', headroom_bytes: budget - need,
    max_context_fits: max, words,
  };
}

// ---- the device budget ---------------------------------------------------------------------------

// A unified-memory Mac (ADR, open question 1, answered by the owner 2026-11-06): the budget is the
// Mac's own GPU memory limit when it has been set (sysctl iogpu.wired_limit_mb, which hardware.ts
// reads), 'measured'. Otherwise it is these fractions of RAM, 'estimate': Nova's reading of macOS's
// default, not yet checked on a real Mac.
export const UNIFIED_BUDGET_FRACTION_BELOW_36GB = 2 / 3;
export const UNIFIED_BUDGET_FRACTION_FROM_36GB = 3 / 4;
export const UNIFIED_LARGE_RAM_BYTES = 36 * GiB;

export type BudgetSource = 'measured' | 'estimate';

export const unifiedBudget = (ram: number, wiredLimit?: number | null): { bytes: number; source: BudgetSource } =>
  typeof wiredLimit === 'number' && wiredLimit > 0
    ? { bytes: wiredLimit, source: 'measured' }
    : { bytes: Math.floor(ram * (ram < UNIFIED_LARGE_RAM_BYTES ? UNIFIED_BUDGET_FRACTION_BELOW_36GB : UNIFIED_BUDGET_FRACTION_FROM_36GB)), source: 'estimate' };

export const unifiedBudgetBytes = (ram: number, wiredLimit?: number | null): number => unifiedBudget(ram, wiredLimit).bytes;

// The budget the engine uses for a device, from the hardware Nova already reads. `loaded_vram_bytes`
// is what the backend reports its loaded models use, so the rest of the GPU's used memory is other
// use. A model sits on one GPU unless the backend is known to split it.
export function deviceBudget(h: Hardware, o: { loaded_vram_bytes?: number; overhead?: LearnedOverhead | null; split_across_gpus?: boolean } = {}): FitDevice {
  const learned = o.overhead && o.overhead.n > 0;
  const overhead = learned ? clampOverhead(o.overhead!.bytes) : PRIOR_OVERHEAD_BYTES;
  const base = { overhead_bytes: overhead, overhead_source: learned ? 'learned' as const : 'prior' as const };
  const gpus = h.gpus.filter((g) => g.unified || g.vram_bytes >= 2 * GiB).sort((a, b) => b.vram_bytes - a.vram_bytes);
  if (gpus[0]?.unified) {
    const u = unifiedBudget(h.ram_bytes, h.gpu_wired_limit_bytes);
    return { ...base, memory: 'unified', budget_bytes: u.bytes, budget_source: u.source, other_use_bytes: 0, other_use_known: false };
  }
  if (gpus.length) {
    const used = o.split_across_gpus ? gpus : [gpus[0]!];
    const total = used.reduce((s, g) => s + g.vram_bytes, 0);
    const known = used.every((g) => g.vram_free_bytes !== null);
    const other = known ? Math.max(0, total - used.reduce((s, g) => s + g.vram_free_bytes!, 0) - (o.loaded_vram_bytes ?? 0)) : 0;
    // Split across GPUs, the overhead is paid on each.
    return { ...base, overhead_bytes: overhead * used.length, memory: 'gpu', budget_bytes: total, budget_source: 'measured', other_use_bytes: other, other_use_known: known };
  }
  return { ...base, memory: 'cpu', budget_bytes: Math.floor(h.ram_bytes * 0.5), budget_source: 'estimate', other_use_bytes: 0, other_use_known: true };
}

// ---- the learned overhead ------------------------------------------------------------------------

export const OVERHEAD_MIN_BYTES = GiB / 4;
export const OVERHEAD_MAX_BYTES = 4 * GiB;
export const OVERHEAD_LEARN_RATE = 0.3;

export interface LearnedOverhead { bytes: number; n: number; last_observed: number | null; updated_at: string | null }
export interface LoadObservation {
  size_bytes: number;            // /api/ps size
  size_vram_bytes: number;       // /api/ps size_vram
  weights_bytes: number;         // the installed file's size
  context: number;               // /api/ps context_length, or the num_ctx Nova sent
  arch: Arch;
  kv_type: KvType;
}
export interface LearnResult { state: LearnedOverhead; outcome: 'learned' | 'partial' | 'discarded'; observed_bytes: number | null }

export const priorOverhead = (): LearnedOverhead => ({ bytes: PRIOR_OVERHEAD_BYTES, n: 0, last_observed: null, updated_at: null });
const clampOverhead = (b: number) => Math.min(OVERHEAD_MAX_BYTES, Math.max(OVERHEAD_MIN_BYTES, b));
const gb1 = (b: number) => `${(b / GiB).toFixed(1)} GB`;

// After a load Nova asked for: only a model fully on the GPU says anything about overhead. A reading
// outside 0.25–4 GB means the weights or KV estimate is wrong (a quantized KV cache Nova didn't know
// of, say); it is logged through `log`, not learned. The reserve is never touched here.
export function learnOverhead(state: LearnedOverhead, load: LoadObservation, at: string, log?: (line: string) => void): LearnResult {
  if (load.size_vram_bytes < load.size_bytes) return { state, outcome: 'partial', observed_bytes: null };
  const observed = load.size_bytes - load.weights_bytes - kvBytes(load.arch, load.context, load.kv_type);
  if (!Number.isFinite(observed) || observed < OVERHEAD_MIN_BYTES || observed > OVERHEAD_MAX_BYTES) {
    log?.(`model fit: an overhead reading of ${gb1(observed)} was discarded (outside 0.25–4 GB); the weights or KV estimate is likely wrong.`);
    return { state, outcome: 'discarded', observed_bytes: observed };
  }
  const from = clampOverhead(state.bytes);
  const bytes = clampOverhead(Math.round(from + OVERHEAD_LEARN_RATE * (observed - from)));
  return { state: { bytes, n: state.n + 1, last_observed: observed, updated_at: at }, outcome: 'learned', observed_bytes: observed };
}

export const overheadWords = (s: LearnedOverhead): string =>
  s.n > 0 ? `Overhead: ${gb1(s.bytes)}, measured from ${s.n} load${s.n === 1 ? '' : 's'}` : `Overhead: ${gb1(s.bytes)}, Nova’s estimate`;

// ---- the fallback tier table ---------------------------------------------------------------------

// Used only when Nova can't read or look up a model's shape. Each row is the formula at the band's
// floor with the reference shapes, Q4_K_M and Q8_0, 4k context, the prior overhead: never more
// generous than the engine. Unified devices map RAM to their budget first, so one table serves both.
export interface TierEntry { class: string; quant: Quant; verdict: Verdict }
export interface TierRow { band_gb: number; basis: 'tier-table'; label: string; expect: string; entries: TierEntry[] }
export const TIER_BANDS_GB = [4, 6, 8, 12, 16, 24, 32, 48];
const TIER_LABEL = 'Estimate: the fallback table, used only when Nova doesn’t know a model’s shape.';

function tierRow(band: number): TierRow {
  const device: FitDevice = { memory: 'gpu', budget_bytes: band * GiB, other_use_bytes: 0, other_use_known: true, overhead_bytes: PRIOR_OVERHEAD_BYTES, overhead_source: 'prior' };
  const entries: TierEntry[] = [];
  for (const s of REFERENCE_SHAPES) for (const quant of ['Q4_K_M', 'Q8_0'] as const) {
    const r = fit({ device, models: [{ name: s.name, params: s.params, weights_bytes: null, quant, context: 4096, arch: s.arch, arch_source: 'catalog', kv_type: 'f16' }] });
    if (r.verdict !== 'wont-fit') entries.push({ class: s.class, quant, verdict: r.verdict });
  }
  const largest = (q: Quant, only?: Verdict) => entries.filter((e) => e.quant === q && (!only || e.verdict === only)).at(-1);
  const q4 = largest('Q4_K_M');
  const q8 = largest('Q8_0', 'fits');
  const expect = !q4 ? 'nothing Nova can promise'
    : q8 && q8.class === q4.class ? `${q8.class} at Q8_0`
    : q4.verdict === 'tight' ? `${q4.class} (tight)${q8 ? `, or ${q8.class} at Q8_0` : ''}`
    : q4.class;
  return { band_gb: band, basis: 'tier-table', label: TIER_LABEL, expect, entries };
}

export const TIER_TABLE: TierRow[] = TIER_BANDS_GB.map(tierRow);
// The band is the largest one at or below the budget; below the smallest, none.
export const tierFor = (budget: number): TierRow | null => TIER_TABLE.filter((r) => r.band_gb * GiB <= budget).at(-1) ?? null;

// ---- recommendations per task class --------------------------------------------------------------

export const TASK_CLASSES = ['general-chat', 'coding', 'screening', 'embeddings', 'vision', 'transcription'] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];
// The context each class is planned at; embeddings use the model's own.
export const TASK_CONTEXT: Record<TaskClass, number | null> = { 'general-chat': 4096, coding: 16384, screening: 4096, embeddings: null, vision: 4096, transcription: null };
const EMBED_DEFAULT_CONTEXT = 2048;
const SCREENING_MAX_PARAMS = 9_000_000_000;

export interface FitCandidate {
  name: string;
  params: number;
  capabilities: string[];
  // local: this device's backend runs it. remote: an Ollama model that runs elsewhere (runsRemotely).
  // cloud: a cloud provider. Only local candidates get a verdict.
  where: 'local' | 'remote' | 'cloud';
  installed: { quant: Quant; weights_bytes: number } | null;
  arch: Arch | null;
  arch_source: FitModel['arch_source'];
  max_context?: number | null;
  projector_bytes?: number | null;   // a vision model's projector, from metadata
  score?: number | null;             // a current eval scorecard; breaks ties within a class only
}

// budget_source: the verdict's own (FitResult), so a pick on a Mac says whether it assumed the limit
// set on the Mac or Nova's estimate of the macOS default.
export interface FitPick { name: string; quant: Quant; context: number; verdict: Verdict; basis: FitResult['basis']; budget_source: BudgetSource; max_context_fits: number | null; words: string }

export interface TaskAdvice {
  task: TaskClass;
  context: number | null;
  pick: FitPick | null;
  alternative: FitPick | null;
  // When nothing Fits: the best Tight option, shown and labelled, never the pick (owner, 2026-11-06).
  tight: FitPick | null;
  nothing_fits: { name: string; quant: Quant; max_context: number } | null;
  cloud: { name: string; words: 'runs off your devices' }[];
  cloud_order: 'after-local' | 'beside-local' | null;
  words: string;
}

export interface RecommendInput { device: FitDevice; privacy: PrivacyMode; task: TaskClass; hub: boolean; candidates: FitCandidate[]; kv_type?: KvType }

// Parameter classes, so 8.0B and 8.2B rank together: the upper bound of each, in order.
const CLASS_BOUNDS = [1.5e9, 2.5e9, 3.5e9, 5.5e9, 10e9, 16e9, 24e9, 40e9, 80e9];
const paramClass = (params: number): number => { const i = CLASS_BOUNDS.findIndex((b) => params <= b); return i < 0 ? CLASS_BOUNDS.length : i; };
const isEmbedder = (c: FitCandidate) => c.capabilities.includes('embedding');
const isText = (c: FitCandidate) => !isEmbedder(c) && (c.capabilities.includes('completion') || !c.capabilities.length);
const isCoder = (c: FitCandidate) => /coder|code/i.test(c.name);

const TASK_FILTER: Record<TaskClass, (c: FitCandidate) => boolean> = {
  'general-chat': (c) => isText(c) && !isCoder(c),
  coding: isText,
  screening: (c) => isText(c) && c.params <= SCREENING_MAX_PARAMS,
  embeddings: isEmbedder,
  vision: (c) => c.capabilities.includes('vision'),
  transcription: () => false,
};

interface Ranked { c: FitCandidate; r: FitResult; quant: Quant; context: number }

export function recommendFit(input: RecommendInput): TaskAdvice {
  const { device, privacy, task, hub } = input;
  const kv = input.kv_type ?? 'f16';
  const context = TASK_CONTEXT[task];

  // 1. Privacy first: under local-only, cloud and remote candidates are gone before anything is
  //    ranked or mentioned. Otherwise they are listed, without a verdict, after or beside local.
  const local = input.candidates.filter((c) => c.where === 'local');
  const cloud = privacy === 'local-only' ? [] : input.candidates.filter((c) => c.where !== 'local').map((c) => ({ name: c.name, words: 'runs off your devices' as const }));
  const advice = (o: Partial<TaskAdvice> & { words: string }): TaskAdvice => ({
    task, context, pick: null, alternative: null, tight: null, nothing_fits: null, cloud,
    cloud_order: cloud.length ? (privacy === 'local-preferred' ? 'after-local' : 'beside-local') : null, ...o,
  });

  if (task === 'transcription') return advice({ words: 'Transcription stays off until Nova has a whisper adapter; nothing is sent elsewhere to transcribe.' });
  if (task === 'screening' && !hub) return advice({ words: 'Screening stays on the hub, so it is quick and never wakes another device.' });

  // 2. The task class. 3. Fit at the class's context, Q4_K_M then Q8_0 (an installed model at its own quant).
  const evaluated: Ranked[] = [];
  for (const c of local.filter(TASK_FILTER[task])) {
    const ctx = context ?? c.max_context ?? EMBED_DEFAULT_CONTEXT;
    const quants: Quant[] = c.installed ? [c.installed.quant] : ['Q4_K_M', 'Q8_0'];
    for (const quant of quants) {
      // A vision model's projector counts with its weights; without it, Nova only estimates.
      const vision = task === 'vision';
      const projector = vision ? c.projector_bytes ?? null : 0;
      const weights = c.installed?.weights_bytes ?? (vision && projector !== null ? weightsBytes(c.params, quant) : null);
      const model: FitModel = {
        name: c.name, params: c.params, quant, context: ctx, kv_type: kv,
        weights_bytes: weights === null ? null : weights + (projector ?? 0),
        arch: vision && projector === null ? null : c.arch, arch_source: vision && projector === null ? null : c.arch_source,
      };
      evaluated.push({ c, r: fit({ device, models: [model] }), quant, context: ctx });
    }
  }

  // 4. Rank: coders first for coding (last otherwise); larger class; Fits before Tight; the higher
  //    quant; then a scorecard; then the name, so the order is stable. Won't fit is gone.
  const coderKey = (x: Ranked) => (task === 'coding' ? Number(!isCoder(x.c)) : Number(isCoder(x.c)));
  const ranked = evaluated.filter((x) => x.r.verdict !== 'wont-fit').sort((a, b) =>
    coderKey(a) - coderKey(b)
    || paramClass(b.c.params) - paramClass(a.c.params)
    || Number(a.r.verdict === 'tight') - Number(b.r.verdict === 'tight')
    || QUANTS.indexOf(b.quant) - QUANTS.indexOf(a.quant)
    || (b.c.score ?? -Infinity) - (a.c.score ?? -Infinity)
    || a.c.name.localeCompare(b.c.name));
  const toPick = (x: Ranked): FitPick => ({ name: x.c.name, quant: x.quant, context: x.context, verdict: x.r.verdict, basis: x.r.basis, budget_source: x.r.budget_source, max_context_fits: x.r.max_context_fits, words: x.r.words });

  // 5. The pick is the first that Fits. A Tight model is never the pick (the owner, 2026-11-06): it
  //    leaves too little headroom to choose for the person; installing one needs their acknowledgement.
  const first = ranked.find((x) => x.r.verdict === 'fits');
  if (first) {
    // 6. The alternative: the best of a smaller class that Fits.
    const alt = ranked.find((x) => paramClass(x.c.params) < paramClass(first.c.params) && x.r.verdict === 'fits');
    return advice({
      pick: toPick(first), alternative: alt ? toPick(alt) : null,
      words: `${first.c.name}: ${first.r.words}${alt ? ` Smaller and faster: ${alt.c.name}, ${alt.r.words.charAt(0).toLowerCase()}${alt.r.words.slice(1)}` : ''}`,
    });
  }

  // 6b. Nothing Fits, but something is Tight: no pick; the best Tight option is shown, labelled.
  if (ranked[0]) return advice({ tight: toPick(ranked[0]), words: 'Nothing fits comfortably on this device; a tight option is shown below.' });

  // 7. Nothing local fits: say so, with the largest context that would.
  const ctxText = context ? `${ctxWords(context)} context` : 'its own context';
  const best = evaluated.filter((x) => (x.r.max_context_fits ?? 0) >= CONTEXT_STEP).sort((a, b) =>
    b.r.max_context_fits! - a.r.max_context_fits! || paramClass(b.c.params) - paramClass(a.c.params) || QUANTS.indexOf(b.quant) - QUANTS.indexOf(a.quant))[0];
  const then = privacy === 'local-only' ? ' Under local-only, the work waits.' : cloud.length ? ' A cloud option may follow.' : '';
  if (best) {
    return advice({
      nothing_fits: { name: best.c.name, quant: best.quant, max_context: best.r.max_context_fits! },
      words: `Nothing here fits at ${ctxText}. ${best.c.name} at ${best.quant} fits up to ${ctxWords(best.r.max_context_fits!)}.${then}`,
    });
  }
  return advice({ words: `Nothing here fits at ${ctxText}.${then}` });
}
