// Which model for which role (M6 plan §2): a small set that fits each device, installed models
// first, with the trade-off in plain words (speed, depth, size). Nova recommends one model per
// role; it doesn't list everything that would run. A role with no runtime here says so and stays
// unassigned: transcription without a whisper runtime is off, not faked.
//
// Whether a model fits a device is the fit engine's answer (fit.ts, docs/plans/model-fit-adr-2026-11-04.md):
// weights, the KV cache for the context the role runs at, the device's overhead (learned or the
// prior) and the reserve, against the device's budget. Tight counts as fitting here: one model is
// planned per role, as the ADR's step 2 allows.
import { gb, modelMemory, type Hardware } from './hardware.ts';
import { runsRemotely, type InstalledModel } from './ollama.ts';
import {
  BITS_PER_WEIGHT, QUANTS, REFERENCE_SHAPES, TASK_CONTEXT, deviceBudget, fit, weightsBytes,
  type Arch, type FitCandidate, type FitDevice, type FitModel, type FitResult, type LearnedOverhead, type Quant, type TaskClass,
} from './fit.ts';
import type { PrivacyMode } from '../envelope.ts';

export const ROLES = ['triage-text', 'reasoner', 'embedder', 'transcriber'] as const;
export type Role = (typeof ROLES)[number];

// Roles in a person's words.
export const ROLE_WORDS: Record<Role, { name: string; does: string }> = {
  'triage-text': { name: 'Sorting', does: 'quick, small decisions: what an event is, whether it needs you' },
  reasoner: { name: 'Thinking and writing', does: 'chat, briefs and delegated work' },
  embedder: { name: 'Finding by meaning', does: 'search over your notes and memory' },
  transcriber: { name: 'Transcription', does: 'turning speech into text' },
};

// The old rule, file size × 1.15. The role recommendations no longer use it (the fit engine does);
// the Decision Service's Tev1 sizing still does (decision-service/seats/tev1.ts) until it moves too.
export const HEADROOM = 1.15;

// The task class each role is planned as (the ADR's table), and the context it runs at: what the
// verdict assumes is what a chat call asks for (num_ctx).
export const ROLE_TASK: Record<Exclude<Role, 'transcriber'>, TaskClass> = { 'triage-text': 'screening', reasoner: 'general-chat', embedder: 'embeddings' };
export const CHAT_ROLES = ['triage-text', 'reasoner'] as const;
export const roleContext = (role: (typeof CHAT_ROLES)[number]): number => TASK_CONTEXT[ROLE_TASK[role]]!;
const EMBED_CONTEXT = 2048;

export interface DeviceModels {
  id: string;
  name: string;
  hub: boolean;
  hardware: Hardware | null;
  // What its runtime has installed (as last read), or null when Nova has never reached it.
  models: InstalledModel[] | null;
  url: string | null;
  // What Nova learned of this device's runtime overhead from real loads; the prior when absent.
  overhead?: LearnedOverhead | null;
}

// The engine's verdict behind a pick: what it assumed and what it found.
export interface PickFit { verdict: FitResult['verdict']; quant: Quant; context: number; basis: FitResult['basis']; need_bytes: number; budget_bytes: number; words: string }

export interface Pick {
  device: string;
  device_name: string;
  model: string;
  installed: boolean;
  size: number;
  params_b: number | null;
  url: string | null;
  // For a role served by a GPU spoke: a model on the hub that small jobs use, so the spoke isn't
  // woken for them.
  hub_model?: string;
  why: string;
  tradeoff: string;
  // Null when Nova doesn't know the device's hardware.
  fit?: PickFit | null;
}

export interface RoleAdvice { role: Role; pick: Pick | null; words: string }

// A few well-known models Nova can suggest downloading when nothing installed fits a role. Sizes
// are what Ollama's default (4-bit) download takes, so the disk budget can be checked up front.
export interface CatalogEntry { name: string; role: Exclude<Role, 'transcriber'>; size: number; params_b: number; words: string }
export const CATALOG: CatalogEntry[] = [
  { name: 'qwen3:4b', role: 'triage-text', size: 2.6e9, params_b: 4, words: 'small and quick' },
  { name: 'llama3.2:3b', role: 'triage-text', size: 2.0e9, params_b: 3.2, words: 'small and quick' },
  { name: 'qwen3:32b', role: 'reasoner', size: 20.2e9, params_b: 32.8, words: 'deep, needs a 24 GB GPU' },
  { name: 'qwen3:14b', role: 'reasoner', size: 9.3e9, params_b: 14.8, words: 'a good balance of depth and speed' },
  { name: 'qwen3:8b', role: 'reasoner', size: 5.2e9, params_b: 8.2, words: 'quick, a little less depth' },
  { name: 'nomic-embed-text', role: 'embedder', size: 0.27e9, params_b: 0.137, words: 'small and fast' },
];

const isEmbedder = (m: InstalledModel) => m.capabilities.includes('embedding') || (!m.capabilities.length && /embed|bge|minilm/i.test(m.name));
const isText = (m: InstalledModel) => !isEmbedder(m) && (m.capabilities.includes('completion') || !m.capabilities.length);
const isCoder = (m: InstalledModel) => /coder|code/i.test(m.name);
const isCloud = (m: InstalledModel) => runsRemotely(m.name, m);

// ---- fit, from the engine --------------------------------------------------------------------------

// The device as the engine sees it. What else holds the GPU is not counted for a role
// recommendation: the hardware reading it comes from (a heartbeat, up to an hour old; the hub's,
// up to ten minutes) and what the runtime has loaded are read at different times, so Nova's own
// model, loaded then and gone now, would count as someone else's. The verdict says it isn't counted.
export function fitDevice(h: Hardware, overhead?: LearnedOverhead | null): FitDevice {
  const d = deviceBudget(h, { overhead: overhead ?? null });
  return d.memory === 'cpu' ? d : { ...d, other_use_bytes: 0, other_use_known: false };
}

// Ollama's quantization label, as the nearest of the engine's. The file's own size is what counts
// for an installed model; the label only names the verdict.
export function quantOf(label: string): Quant {
  const q = label.toUpperCase();
  if ((QUANTS as readonly string[]).includes(q)) return q as Quant;
  if (/^(F16|BF16|F32)$/.test(q)) return 'F16';
  if (q.startsWith('Q8')) return 'Q8_0';
  if (q.startsWith('Q6')) return 'Q6_K';
  if (q.startsWith('Q5')) return 'Q5_K_M';
  return 'Q4_K_M';
}

const contextFor = (role: Exclude<Role, 'transcriber'>, own: number | null | undefined) => (role === 'embedder' ? own ?? EMBED_CONTEXT : TASK_CONTEXT[ROLE_TASK[role]]!);

// An installed model as the engine plans it: its own file size, its shape when the runtime said it.
function installedModel(m: InstalledModel, role: Exclude<Role, 'transcriber'>): FitModel {
  const quant = quantOf(m.quantization);
  const params = m.params_b ? Math.round(m.params_b * 1e9) : Math.round((m.size * 8) / BITS_PER_WEIGHT[quant]);
  const arch = m.arch ?? null;
  return { name: m.name, params, weights_bytes: m.size, quant, context: contextFor(role, m.max_context), arch, arch_source: arch ? 'backend' : null, kv_type: 'f16' };
}

// A catalog model, not installed: Ollama's default pull (Q4_K_M), with the shape Nova assumes for it.
function plannedModel(c: CatalogEntry, role: Exclude<Role, 'transcriber'>): FitModel {
  const arch: Arch | null = REFERENCE_SHAPES.find((r) => r.name === c.name)?.arch ?? null;
  return { name: c.name, params: Math.round(c.params_b * 1e9), weights_bytes: null, quant: 'Q4_K_M', context: contextFor(role, null), arch, arch_source: arch ? 'catalog' : null, kv_type: 'f16' };
}

const fitOf = (d: DeviceModels, models: FitModel[]): FitResult | null => (d.hardware ? fit({ device: fitDevice(d.hardware, d.overhead), models }) : null);
// Without hardware Nova can't tell, and doesn't rule a model out.
const fits = (r: FitResult | null) => !r || r.verdict !== 'wont-fit';
const pickFit = (r: FitResult | null, m: FitModel): PickFit | null =>
  r ? { verdict: r.verdict, quant: m.quant, context: m.context, basis: r.basis, need_bytes: r.need_bytes, budget_bytes: r.budget_bytes, words: r.words } : null;

// The memory models sit in, in words. A unified-memory device is named with the engine's budget
// (UNIFIED_BUDGET_FRACTION_BELOW_36GB in fit.ts), not hardware.ts's 0.75 × RAM.
function memoryWords(h: Hardware, dev: FitDevice): string {
  const unified = h.gpus.find((g) => g.unified);
  return dev.memory === 'unified' && unified ? `${unified.name}, sharing ${gb(dev.budget_bytes)} of memory` : modelMemory(h).words;
}

// What a device can hold, in words: the largest model the engine would not call Won't fit, at
// Q4_K_M with 4k context and the shapes Nova assumes, in steps of 0.1B parameters.
export function capacityWords(h: Hardware, overhead?: LearnedOverhead | null): string {
  const dev = fitDevice(h, overhead);
  const on = memoryWords(h, dev);
  const context = TASK_CONTEXT['general-chat']!;
  const most = Math.floor((dev.budget_bytes * 8) / BITS_PER_WEIGHT.Q4_K_M / 1e8);
  let best = 0;
  for (let n = 1; n <= most; n++) {
    const params = n * 1e8;
    const r = fit({ device: dev, models: [{ name: 'capacity', params, weights_bytes: null, quant: 'Q4_K_M', context, arch: null, arch_source: null, kv_type: 'f16' }] });
    if (r.verdict !== 'wont-fit') best = params;
  }
  if (!best) return `Too little memory for a model Nova can plan at Q4_K_M with 4k context, on ${on}.`;
  return `${dev.memory === 'cpu' ? 'Can run, slowly,' : 'Runs'} models up to about ${gb(weightsBytes(best, 'Q4_K_M'))} (around ${Math.max(1, Math.floor(best / 1e9))}B parameters at Q4_K_M with 4k context) on ${on}.`;
}

function size(m: InstalledModel) { return `${m.parameter_size || '?'} parameters, ${gb(m.size)}`; }

const installedFits = (d: DeviceModels, m: InstalledModel, role: Exclude<Role, 'transcriber'>) => fits(fitOf(d, [installedModel(m, role)]));

function triagePick(d: DeviceModels): InstalledModel | null {
  const ok = (d.models ?? []).filter((m) => isText(m) && !isCloud(m) && installedFits(d, m, 'triage-text') && (m.params_b === null ? m.size <= 6e9 : m.params_b <= 9));
  ok.sort((a, b) => Number((b.params_b ?? 3) >= 3) - Number((a.params_b ?? 3) >= 3) || a.size - b.size);
  return ok[0] ?? null;
}

function reasonerPick(d: DeviceModels): InstalledModel | null {
  const ok = (d.models ?? []).filter((m) => isText(m) && !isCloud(m) && installedFits(d, m, 'reasoner'));
  ok.sort((a, b) => Number(isCoder(a)) - Number(isCoder(b)) || (b.params_b ?? 0) - (a.params_b ?? 0) || a.size - b.size);
  return ok[0] ?? null;
}

function embedderPick(d: DeviceModels): InstalledModel | null {
  const ok = (d.models ?? []).filter((m) => isEmbedder(m) && !isCloud(m) && installedFits(d, m, 'embedder'));
  ok.sort((a, b) => a.size - b.size);
  return ok[0] ?? null;
}

function pickOf(d: DeviceModels, m: InstalledModel, role: Exclude<Role, 'transcriber'>, why: string, tradeoff: string): Pick {
  const planned = installedModel(m, role);
  return { device: d.id, device_name: d.name, model: m.name, installed: true, size: m.size, params_b: m.params_b, url: d.url, why, tradeoff, fit: pickFit(fitOf(d, [planned]), planned) };
}

function download(hub: DeviceModels, role: Exclude<Role, 'transcriber'>): Pick | null {
  const c = CATALOG.filter((e) => e.role === role && fits(fitOf(hub, [plannedModel(e, role)]))).sort((a, b) => (role === 'reasoner' ? b.params_b - a.params_b : a.size - b.size))[0];
  if (!c) return null;
  const planned = plannedModel(c, role);
  return {
    device: hub.id, device_name: hub.name, model: c.name, installed: false, size: c.size, params_b: c.params_b, url: hub.url,
    why: `Nothing installed here fits this role. ${c.name} is ${c.words}, and fits ${hub.hardware ? memoryWords(hub.hardware, fitDevice(hub.hardware, hub.overhead)) : 'this hub'}.`,
    tradeoff: `A ${gb(c.size)} download; Nova asks before it starts.`,
    fit: pickFit(fitOf(hub, [planned]), planned),
  };
}

export function recommend(devices: DeviceModels[]): RoleAdvice[] {
  const hub = devices.find((d) => d.hub)!;
  const out: RoleAdvice[] = [];
  const mem = (d: DeviceModels) => {
    if (!d.hardware) return null;
    const dev = fitDevice(d.hardware, d.overhead);
    return { on: dev.memory, words: memoryWords(d.hardware, dev) };
  };

  // Sorting stays on the hub: it runs often, on small inputs, and waking a computer for it would
  // cost more time than it saves.
  const t = triagePick(hub);
  out.push({ role: 'triage-text', pick: t ? pickOf(hub, t, 'triage-text', `${t.name} (${size(t)}) is the smallest capable model installed here, so sorting stays quick.`, 'Fast and light; not meant for long answers.') : download(hub, 'triage-text'), words: t ? '' : 'No small text model is installed on the hub.' });

  // Thinking and writing: the deepest model that fits, wherever it is; a GPU spoke serves it
  // only when it is clearly deeper than what the hub can run, and small jobs then stay on the hub.
  const options = devices.map((d) => ({ d, m: reasonerPick(d) })).filter((x): x is { d: DeviceModels; m: InstalledModel } => !!x.m);
  options.sort((a, b) => (b.m.params_b ?? 0) - (a.m.params_b ?? 0) || Number(b.d.hub) - Number(a.d.hub));
  const hubBest = options.find((x) => x.d.hub) ?? null;
  let best = options[0] ?? null;
  if (best && !best.d.hub && hubBest && (best.m.params_b ?? 0) < (hubBest.m.params_b ?? 0) * 1.5) best = hubBest;
  if (best) {
    const m = mem(best.d);
    const p = pickOf(best.d, best.m, 'reasoner', `${best.m.name} (${size(best.m)}) is the deepest model that fits ${m ? m.words : best.d.name}.`, '');
    // Whether the sorting model can stay loaded beside it: the two together, overhead and reserve
    // counted once (the engine's combination rule).
    const both = t && best.d.hub ? fitOf(best.d, [installedModel(best.m, 'reasoner'), installedModel(t, 'triage-text')]) : null;
    p.tradeoff = m && m.on === 'cpu' ? 'It runs on the CPU here, so long answers are slow.'
      : both && both.verdict === 'wont-fit' ? 'Slower to answer than a small model, and it and the sorting model can’t both stay loaded, so switching between them takes a few seconds.'
      : 'Slower to answer than a small model, in exchange for depth.';
    if (!best.d.hub) {
      p.why += ` It runs on ${best.d.name}, which Nova wakes when needed.`;
      if (hubBest) { p.hub_model = hubBest.m.name; p.tradeoff = `Waking ${best.d.name} takes time, so small jobs go to ${hubBest.m.name} on the hub instead.`; }
    }
    out.push({ role: 'reasoner', pick: p, words: '' });
  } else {
    out.push({ role: 'reasoner', pick: download(hub, 'reasoner'), words: 'No text model that fits is installed on your devices.' });
  }

  const e = embedderPick(hub);
  out.push({ role: 'embedder', pick: e ? pickOf(hub, e, 'embedder', `${e.name} (${gb(e.size)}) is the smallest embedding model installed here.`, 'Small and fast; good enough for finding things by meaning.') : download(hub, 'embedder'), words: e ? '' : 'No embedding model is installed on the hub.' });

  // Ollama can't transcribe; that needs a whisper runtime, which Nova has no adapter for yet.
  const whisper = devices.map((d) => d.hardware?.whisper).find(Boolean);
  out.push({
    role: 'transcriber', pick: null,
    words: whisper
      ? `Nova found a transcription runtime (${whisper}), but can’t use it yet, so transcription stays off.`
      : 'There is no transcription runtime on your devices (Nova looks for whisper.cpp or faster-whisper), so transcription stays off. Nothing is sent elsewhere to transcribe instead.',
  });
  return out;
}

// ---- what the Models screen plans with, per task class (model-fit step 3) -----------------------

// Models Nova can suggest for a task class no role covers yet (vision), with the shape the screen
// plans them with. Model-card figures: Qwen2.5-VL-7B's language model (28 layers, 4 KV heads, head
// size 128); nomic-embed-text v1.5 (12 layers, 12 heads, 768 wide). A vision model's projector isn't
// in here, so its verdict stays an estimate (fit.ts recommendFit).
export interface PlanExtra { name: string; params_b: number; size: number; capabilities: string[] }
export const PLAN_EXTRA: PlanExtra[] = [
  { name: 'qwen2.5vl:7b', params_b: 8.3, size: 6.0e9, capabilities: ['vision'] },
];
const PLAN_SHAPES: Record<string, Arch> = {
  ...Object.fromEntries(REFERENCE_SHAPES.map((r) => [r.name, r.arch])),
  'nomic-embed-text': { layers: 12, kv_heads: 12, head_dim: 64 },
  'qwen2.5vl:7b': { layers: 28, kv_heads: 4, head_dim: 128 },
};

// One model the screen can plan on a device: the fit engine's candidate, plus the quants offered,
// the one Ollama's plain name downloads, and its size when Nova knows it.
export interface PlanCandidate extends FitCandidate { quants: Quant[]; default_quant: Quant; size: number | null }

const EMBED_QUANTS: Quant[] = ['Q8_0', 'F16'];

// The candidates for one device, privacy first: under local-only nothing that runs off the person's
// devices is listed at all (not a cloud model, not an Ollama model that runs remotely), so nothing
// downstream can rank or mention one. Otherwise the cloud model the person set is listed, without a
// verdict. What the runtime has installed comes first, with its own file and shape; then the catalog.
export function planCandidates(d: DeviceModels, o: { privacy: PrivacyMode; cloud: string | null }): PlanCandidate[] {
  const out: PlanCandidate[] = [];
  for (const m of d.models ?? []) {
    const remote = isCloud(m);
    if (remote && o.privacy === 'local-only') continue;
    const quant = quantOf(m.quantization);
    const embed = isEmbedder(m);
    out.push({
      name: m.name, params: m.params_b ? Math.round(m.params_b * 1e9) : Math.round((m.size * 8) / BITS_PER_WEIGHT[quant]),
      capabilities: embed && !m.capabilities.includes('embedding') ? ['embedding', ...m.capabilities] : m.capabilities,
      where: remote ? 'remote' : 'local', installed: remote ? null : { quant, weights_bytes: m.size },
      arch: m.arch ?? null, arch_source: m.arch ? 'backend' : null, max_context: m.max_context ?? null,
      quants: embed ? [...new Set([...EMBED_QUANTS, quant])] : [...QUANTS], default_quant: quant, size: m.size,
    });
  }
  const have = new Set(out.map((c) => c.name));
  const plain = [
    ...CATALOG.map((c) => ({ name: c.name, params_b: c.params_b, size: c.size, capabilities: c.role === 'embedder' ? ['embedding'] : ['completion'] })),
    ...PLAN_EXTRA,
  ];
  for (const c of plain) {
    if (have.has(c.name)) continue;
    const embed = c.capabilities.includes('embedding');
    const arch = PLAN_SHAPES[c.name] ?? null;
    out.push({
      name: c.name, params: Math.round(c.params_b * 1e9), capabilities: c.capabilities, where: 'local', installed: null,
      arch, arch_source: arch ? 'catalog' : null, max_context: embed ? EMBED_CONTEXT : null,
      quants: embed ? EMBED_QUANTS : [...QUANTS], default_quant: embed ? 'F16' : 'Q4_K_M', size: c.size,
    });
  }
  if (o.privacy !== 'local-only' && o.cloud) out.push({ name: o.cloud, params: 0, capabilities: ['completion'], where: 'cloud', installed: null, arch: null, arch_source: null, quants: [], default_quant: 'Q4_K_M', size: null });
  return out;
}

// What a device's runtime should download for a model at a quant: the plain name for the quant it
// downloads by default, otherwise Ollama's tag for that quant (qwen3:8b at Q8_0 is qwen3:8b-q8_0).
const QUANT_TAG: Record<Quant, string> = { Q4_K_M: 'q4_K_M', Q5_K_M: 'q5_K_M', Q6_K: 'q6_K', Q8_0: 'q8_0', F16: 'fp16' };
export function quantTag(name: string, quant: Quant, defaultQuant: Quant): string {
  if (quant === defaultQuant) return name;
  return `${name}${name.includes(':') ? '-' : ':'}${QUANT_TAG[quant]}`;
}

export { isEmbedder, isText };
