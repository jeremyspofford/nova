// Built-in model presets (FR-221, docs/07 §8.1, docs/04 §3.1): Faster, Balanced and Smarter are
// generated deterministically from the models available now, until the user saves their own
// list in `models.presets`.
//
// Heuristic (model ids and reported capabilities only, no network):
// - Non-chat models (embeddings, speech, image generation, moderation, …) are skipped, and the
//   offline mock is used only when nothing else is available.
// - Each model gets a speed-to-smarts score: small-model markers (mini, nano, haiku, flash,
//   lite, small, fast, …) score 20; large-model markers (opus, fable, pro, large, ultra, smart,
//   gpt-5, o1/o3, …) score 80; otherwise a parameter size in the id (`:8b`, `-70b`) scores
//   15 (≤4B) / 25 (≤9B) / 40 (≤20B) / 55 (≤40B) / 75 (larger); otherwise 50. Reasoning-capable
//   models get +10.
// - Sorted by score (ties: local first, then list order): Faster is the first, Smarter the last,
//   Balanced the one at index ⌊(n−1)/2⌋.
// - Reasoning-capable picks get a level: Faster off, Balanced medium, Smarter high.
// - Each preset falls back to the nearest-scored model of a different provider account or node
//   when one exists (strategy `fallback`), otherwise it is `single`.
import { type ModelRef, type Preset } from '@nova/shared';

export const BUILT_IN_PRESET_IDS: readonly string[] = ['faster', 'balanced', 'smarter'];

export interface PresetCandidate {
  ref: ModelRef;
  modelId: string;
  /** The provider account or node serving it; a fallback comes from a different owner. */
  owner: string;
  local: boolean;
  reasoning: boolean;
  /** The offline mock provider: a stand-in, used only when there is no real model. */
  offline?: boolean;
}

const NOT_CHAT =
  /embed|whisper|tts|dall-e|gpt-image|moderation|rerank|transcribe|audio|realtime|davinci|babbage|sora/i;
// Markers count at a word start only, so `gemini` is not `mini`.
const SMALL = /(?<![a-z])(mini|nano|haiku|flash|lite|tiny|small|fast|instant)/i;
const LARGE =
  /(?<![a-z])(opus|fable|mythos|large|ultra|smart|gpt-5)|(^|[-_/.:])pro([-_/.:]|$)|(^|[/])o[13]([-_]|$)/i;

export function isChatModel(modelId: string): boolean {
  return !NOT_CHAT.test(modelId);
}

/** Position on the Faster ↔ Smarter scale (higher is smarter); see the heuristic above. */
export function presetScore(modelId: string, reasoning: boolean): number {
  const bonus = reasoning ? 10 : 0;
  if (SMALL.test(modelId)) return 20 + bonus;
  if (LARGE.test(modelId)) return 80 + bonus;
  const size = /(\d+(?:\.\d+)?)b(?![a-z])/i.exec(modelId);
  if (size) {
    const b = Number(size[1]);
    const s = b <= 4 ? 15 : b <= 9 ? 25 : b <= 20 ? 40 : b <= 40 ? 55 : 75;
    return s + bonus;
  }
  return 50 + bonus;
}

interface Scored extends PresetCandidate {
  score: number;
  order: number;
}

export function generatePresets(candidates: PresetCandidate[]): Preset[] {
  const chat = candidates.filter((c) => isChatModel(c.modelId));
  const real = chat.filter((c) => !c.offline);
  const scored: Scored[] = (real.length ? real : chat).map((c, order) => ({
    ...c,
    score: presetScore(c.modelId, c.reasoning),
    order,
  }));
  if (!scored.length) return [];
  const ranked = [...scored].sort(
    (a, b) => a.score - b.score || Number(b.local) - Number(a.local) || a.order - b.order,
  );
  const picks: [string, string, Scored, 'off' | 'medium' | 'high'][] = [
    ['faster', 'Faster', ranked[0]!, 'off'],
    ['balanced', 'Balanced', ranked[Math.floor((ranked.length - 1) / 2)]!, 'medium'],
    ['smarter', 'Smarter', ranked.at(-1)!, 'high'],
  ];
  return picks.map(([id, label, pick, level], i) => {
    const fallback = nearestOther(ranked, pick);
    const preset: Preset = {
      id,
      label,
      strategy: fallback ? 'fallback' : 'single',
      targets: fallback ? [pick.ref, fallback.ref] : [pick.ref],
      rank: i + 1,
    };
    if (pick.reasoning) preset.reasoningLevel = level;
    return preset;
  });
}

function nearestOther(ranked: Scored[], pick: Scored): Scored | undefined {
  let best: Scored | undefined;
  for (const c of ranked) {
    if (c.owner === pick.owner) continue;
    const d = Math.abs(c.score - pick.score);
    const bd = best ? Math.abs(best.score - pick.score) : Infinity;
    if (d < bd || (d === bd && best && Number(c.local) > Number(best.local))) best = c;
  }
  return best;
}
