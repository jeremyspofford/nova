// Which model for which role (M6 plan §2): a small set that fits each device, installed models
// first, with the trade-off in plain words (speed, depth, size). Nova recommends one model per
// role; it doesn't list everything that would run. A role with no runtime here says so and stays
// unassigned: transcription without a whisper runtime is off, not faked.
import { gb, modelMemory, type Hardware } from './hardware.ts';
import type { InstalledModel } from './ollama.ts';

export const ROLES = ['triage-text', 'reasoner', 'embedder', 'transcriber'] as const;
export type Role = (typeof ROLES)[number];

// Roles in a person's words.
export const ROLE_WORDS: Record<Role, { name: string; does: string }> = {
  'triage-text': { name: 'Sorting', does: 'quick, small decisions: what an event is, whether it needs you' },
  reasoner: { name: 'Thinking and writing', does: 'chat, briefs and delegated work' },
  embedder: { name: 'Finding by meaning', does: 'search over your notes and memory' },
  transcriber: { name: 'Transcription', does: 'turning speech into text' },
};

// Room a model needs beyond its file: the context and the runtime's own use.
export const HEADROOM = 1.15;
// Roughly what one billion parameters takes at the 4-bit quantization Ollama pulls by default.
const BYTES_PER_B = 0.62 * 1024 ** 3;

export interface DeviceModels {
  id: string;
  name: string;
  hub: boolean;
  hardware: Hardware | null;
  // What its runtime has installed (as last read), or null when Nova has never reached it.
  models: InstalledModel[] | null;
  url: string | null;
}

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
const isCloud = (m: InstalledModel) => /[:-]cloud$/i.test(m.name);
const fits = (size: number, h: Hardware | null) => !h || size * HEADROOM <= modelMemory(h).bytes;

// What a device can hold, in words: the biggest model and roughly how many parameters.
export function capacityWords(h: Hardware): string {
  const mem = modelMemory(h);
  const usable = mem.bytes / HEADROOM;
  const params = Math.max(1, Math.floor(usable / BYTES_PER_B));
  return `${mem.on === 'gpu' ? 'Runs' : 'Can run, slowly,'} models up to about ${gb(usable)} (around ${params}B parameters at 4-bit) on ${mem.words}.`;
}

function size(m: InstalledModel) { return `${m.parameter_size || '?'} parameters, ${gb(m.size)}`; }

function triagePick(d: DeviceModels): InstalledModel | null {
  const ok = (d.models ?? []).filter((m) => isText(m) && !isCloud(m) && fits(m.size, d.hardware) && (m.params_b === null ? m.size <= 6e9 : m.params_b <= 9));
  ok.sort((a, b) => Number((b.params_b ?? 3) >= 3) - Number((a.params_b ?? 3) >= 3) || a.size - b.size);
  return ok[0] ?? null;
}

function reasonerPick(d: DeviceModels): InstalledModel | null {
  const ok = (d.models ?? []).filter((m) => isText(m) && !isCloud(m) && fits(m.size, d.hardware));
  ok.sort((a, b) => Number(isCoder(a)) - Number(isCoder(b)) || (b.params_b ?? 0) - (a.params_b ?? 0) || a.size - b.size);
  return ok[0] ?? null;
}

function embedderPick(d: DeviceModels): InstalledModel | null {
  const ok = (d.models ?? []).filter((m) => isEmbedder(m) && !isCloud(m) && fits(m.size, d.hardware));
  ok.sort((a, b) => a.size - b.size);
  return ok[0] ?? null;
}

function pickOf(d: DeviceModels, m: InstalledModel, why: string, tradeoff: string): Pick {
  return { device: d.id, device_name: d.name, model: m.name, installed: true, size: m.size, params_b: m.params_b, url: d.url, why, tradeoff };
}

function download(hub: DeviceModels, role: Exclude<Role, 'transcriber'>): Pick | null {
  const c = CATALOG.filter((e) => e.role === role && fits(e.size, hub.hardware)).sort((a, b) => (role === 'reasoner' ? b.params_b - a.params_b : a.size - b.size))[0];
  if (!c) return null;
  return {
    device: hub.id, device_name: hub.name, model: c.name, installed: false, size: c.size, params_b: c.params_b, url: hub.url,
    why: `Nothing installed here fits this role. ${c.name} is ${c.words}, and fits ${hub.hardware ? modelMemory(hub.hardware).words : 'this hub'}.`,
    tradeoff: `A ${gb(c.size)} download; Nova asks before it starts.`,
  };
}

export function recommend(devices: DeviceModels[]): RoleAdvice[] {
  const hub = devices.find((d) => d.hub)!;
  const out: RoleAdvice[] = [];
  const mem = (d: DeviceModels) => (d.hardware ? modelMemory(d.hardware) : null);

  // Sorting stays on the hub: it runs often, on small inputs, and waking a computer for it would
  // cost more time than it saves.
  const t = triagePick(hub);
  out.push({ role: 'triage-text', pick: t ? pickOf(hub, t, `${t.name} (${size(t)}) is the smallest capable model installed here, so sorting stays quick.`, 'Fast and light; not meant for long answers.') : download(hub, 'triage-text'), words: t ? '' : 'No small text model is installed on the hub.' });

  // Thinking and writing: the deepest model that fits, wherever it is; a GPU spoke serves it
  // only when it is clearly deeper than what the hub can run, and small jobs then stay on the hub.
  const options = devices.map((d) => ({ d, m: reasonerPick(d) })).filter((x): x is { d: DeviceModels; m: InstalledModel } => !!x.m);
  options.sort((a, b) => (b.m.params_b ?? 0) - (a.m.params_b ?? 0) || Number(b.d.hub) - Number(a.d.hub));
  const hubBest = options.find((x) => x.d.hub) ?? null;
  let best = options[0] ?? null;
  if (best && !best.d.hub && hubBest && (best.m.params_b ?? 0) < (hubBest.m.params_b ?? 0) * 1.5) best = hubBest;
  if (best) {
    const m = mem(best.d);
    const p = pickOf(best.d, best.m, `${best.m.name} (${size(best.m)}) is the deepest model that fits ${m ? m.words : best.d.name}.`, '');
    const triage = t && best.d.hub ? t.size : 0;
    p.tradeoff = m && m.on === 'cpu' ? 'It runs on the CPU here, so long answers are slow.'
      : triage && m && (best.m.size + triage) * HEADROOM > m.bytes ? 'Slower to answer than a small model, and it and the sorting model can’t both stay loaded, so switching between them takes a few seconds.'
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
  out.push({ role: 'embedder', pick: e ? pickOf(hub, e, `${e.name} (${gb(e.size)}) is the smallest embedding model installed here.`, 'Small and fast; good enough for finding things by meaning.') : download(hub, 'embedder'), words: e ? '' : 'No embedding model is installed on the hub.' });

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

export { isEmbedder, isText };
