// The person's choices for the Decision Service (owner decisions 1, 2 and 4 on the ADR):
// - providers and models for each seat are the person's choice; Nova recommends, and says plainly
//   when a choice isn't what it recommends;
// - cloud Jev in local-first or local-only is a per-feature opt-in, off by default: "screening"
//   (text batteries) and "box" (images and Box). Box in local-only never goes to a cloud seat;
// - no live call is made until the person has set a route up.
// Where these are stored (the profile) and shown (Settings › Models) is wiring and UI (Track 1).
import type { Hardware } from '../models/hardware.ts';
import { ALIASES, modelProblem, RECOMMENDED_MODEL, RECOMMENDED_URL } from './seats/jev.ts';
import { chooseSize, SIZES, type Size } from './seats/tev1.ts';
import type { VerdictStore } from './verdicts.ts';
import type { OptIn, ServiceTemplate } from './types.ts';

export interface DecisionSettings {
  // Cloud Jev: the route (base URL), a versioned model, and whether a key is stored (the key itself
  // stays in the vault). Null until the person sets it up.
  jev: { base_url: string; model: string } | null;
  // Tev1 in the person's Ollama: a size, or "auto" (chosen from the hardware).
  tev1: { model: 'auto' | Size } | null;
  // Cloud Jev in local-first / local-only, per feature. Off by default.
  opt_in: Record<OptIn, boolean>;
}

// The settings as the person sends them (Settings › Models), checked: a versioned Jev model (never
// an alias), an https route (or http on loopback, for a local gateway), a known Tev1 size, and
// opt-ins that are true or false. Returns the problems, in words.
export function validateSettings(v: unknown): { ok: true; settings: DecisionSettings } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  let jev: DecisionSettings['jev'] = null;
  if (o.jev !== null && o.jev !== undefined) {
    const j = o.jev as Record<string, unknown>;
    const model = String(j.model ?? '');
    const bad = modelProblem(model);
    if (bad) problems.push(bad);
    let url: URL | null = null;
    try { url = new URL(String(j.base_url ?? '')); } catch { problems.push('The Jev route must be an address, such as https://api.typesafe.ai.'); }
    if (url && url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) problems.push('The Jev route must use https (plain http only on this machine).');
    if (!bad && url) jev = { base_url: url.toString().replace(/\/+$/, ''), model };
  }
  let tev1: DecisionSettings['tev1'] = { model: 'auto' };
  if (o.tev1 === null) tev1 = null;
  else if (o.tev1 !== undefined) {
    const m = (o.tev1 as Record<string, unknown>).model;
    if (m !== 'auto' && !SIZES.includes(m as Size)) problems.push(`Tev1's size must be auto, ${SIZES.join(' or ')}.`);
    else tev1 = { model: m as 'auto' | Size };
  }
  const oi = (o.opt_in ?? {}) as Record<string, unknown>;
  for (const f of ['screening', 'box']) if (oi[f] !== undefined && typeof oi[f] !== 'boolean') problems.push(`The ${f} opt-in must be on or off.`);
  if (problems.length) return { ok: false, problems };
  return { ok: true, settings: { jev, tev1, opt_in: { screening: oi.screening === true, box: oi.box === true } } };
}

export const DEFAULT_SETTINGS: DecisionSettings = Object.freeze({ jev: null, tev1: { model: 'auto' }, opt_in: Object.freeze({ screening: false, box: false }) }) as DecisionSettings;

export interface Recommendation { jev: { base_url: string; model: string }; tev1: { model: Size | null; why: string } }

export function recommend(h: Hardware | null): Recommendation {
  const size = chooseSize(h);
  return { jev: { base_url: RECOMMENDED_URL, model: RECOMMENDED_MODEL }, tev1: { model: size.model, why: size.why } };
}

// What each opt-in means, in plain words, shown beside the switch and whenever it is on.
export const OPT_IN_WORDS: Record<OptIn, string> = {
  screening: 'While this is on, outside content Nova screens (pages, mail, files, tool output) is sent to TypeSafe’s cloud (Jev) to be judged, even in local-first and local-only. Local-only isn’t strictly local for screening while it is on.',
  box: 'While this is on, images Nova is asked to judge, including camera and screen frames from sources you have allowed, are sent to TypeSafe’s cloud (Jev) in cloud and local-first modes. In local-only they never go to a cloud provider. TypeSafe labels images and Box a preview.',
};

export interface Notice { kind: 'route' | 'model' | 'size' | 'alias' | 'unevaluated' | 'opt_in'; words: string }

// Every plain notice for these choices: anything not recommended, and every opt-in that is on.
export function notices(s: DecisionSettings, o: { hardware: Hardware | null; verdicts?: VerdictStore; templates?: ServiceTemplate[]; tev1Digest?: string | null }): Notice[] {
  const r = recommend(o.hardware);
  const out: Notice[] = [];
  if (s.jev) {
    if (ALIASES.includes(s.jev.model) || modelProblem(s.jev.model)) out.push({ kind: 'alias', words: modelProblem(s.jev.model)! });
    else if (s.jev.model !== r.jev.model) out.push({ kind: 'model', words: `${s.jev.model} isn’t the Jev model Nova recommends (${r.jev.model}). Templates are evaluated per model version, so some may be evidence-only on it.` });
    let host = s.jev.base_url;
    try { host = new URL(s.jev.base_url).host; } catch { /* shown as typed */ }
    if (s.jev.base_url.replace(/\/+$/, '') !== r.jev.base_url) out.push({ kind: 'route', words: `${host} isn’t TypeSafe’s own API (${new URL(r.jev.base_url).host}). Content Nova sends to Jev goes to ${host} instead, under that service’s terms.` });
  }
  if (s.tev1 && s.tev1.model !== 'auto' && r.tev1.model && s.tev1.model !== r.tev1.model) {
    const smaller = SIZES.indexOf(s.tev1.model) > SIZES.indexOf(r.tev1.model);
    out.push({ kind: 'size', words: smaller ? `Tev1 ${s.tev1.model.slice(5).toUpperCase()} is smaller than this device can run (${r.tev1.model}); the smaller model was less accurate in its makers’ tests.` : `Tev1 ${s.tev1.model.slice(5).toUpperCase()} is bigger than Nova recommends for this device (${r.tev1.model}); it may not fit in memory.` });
  }
  if (o.verdicts && o.templates) {
    const check = (seat: 'jev' | 'tev1', model: string | null) => {
      if (!model) return;
      const missing = o.templates!.filter((t) => !o.verdicts!.lookup(t.template_id, t.version, seat, model).trusted).map((t) => `${t.template_id} v${t.version}`);
      if (missing.length) out.push({ kind: 'unevaluated', words: `${model} hasn’t passed the eval for ${missing.join(', ')}. Its answers there are kept as evidence, and Nova decides those without it.` });
    };
    if (s.jev && !modelProblem(s.jev.model)) check('jev', s.jev.model);
    const size = s.tev1 ? (s.tev1.model === 'auto' ? r.tev1.model : s.tev1.model) : null;
    if (size && o.tev1Digest) check('tev1', `${size}@${o.tev1Digest.replace(/^sha256:/, '')}`);
  }
  for (const f of ['screening', 'box'] as const) if (s.opt_in[f]) out.push({ kind: 'opt_in', words: OPT_IN_WORDS[f] });
  return out;
}

// Each template's verdict on one seat and model: shown before the person switches to it.
export function scorecard(verdicts: VerdictStore, templates: ServiceTemplate[], seat: 'jev' | 'tev1', model: string): { template: string; version: number; trusted: boolean; why: string }[] {
  return templates.map((t) => { const l = verdicts.lookup(t.template_id, t.version, seat, model); return { template: t.template_id, version: t.version, trusted: l.trusted, why: l.why }; });
}
