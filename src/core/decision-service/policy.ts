// Policy (ADR §1.2): the model makes the judgments, code makes the decision. Each answer is read
// into a band; a truth table, enumerated in full when a template is registered, maps the bands to
// an outcome; the outcome's action and stakes tier, with the answer's quality, give the autonomy.
// System One only ever LOWERS autonomy: it never acts above an action's tier.
import type { Answer, Autonomy, Band, Policy, Quality, Question, ServiceTemplate, Tier } from './types.ts';

export const NOUL_LO = 0.3;
export const NOUL_HI = 0.7;
export const SETTLED_AT = 0.6;
export const UNSETTLED = 'unsettled';
// A table bigger than this is a sign the battery wants splitting, not enumerating.
export const MAX_ROWS = 100_000;

// The bands one question can take.
export function domain(q: Question): Band[] {
  if (q.type === 'noul') return ['yes', 'no', UNSETTLED];
  if (q.type === 'choice') return [...Object.keys(q.criteria), UNSETTLED];
  if (q.type === 'score') return [...q.criteria.map((_, i) => String(i)), UNSETTLED];
  return ['located', UNSETTLED];
}

// One answer's band: a Noul is yes at or above hi, no below lo, unsettled between (TypeSafe's
// guidance: 0.7 and 0.3 to start). A Choice, Score or Box is settled at or above its confidence.
export function band(q: Question, a: Answer, id: string, p: Policy): Band {
  const at = p.settled_at ?? SETTLED_AT;
  if (q.type === 'noul' && a.type === 'noul') {
    const b = p.bands?.[id] ?? { lo: NOUL_LO, hi: NOUL_HI };
    return a.noul >= b.hi ? 'yes' : a.noul < b.lo ? 'no' : UNSETTLED;
  }
  if (q.type === 'choice' && a.type === 'choice') return a.confidence >= at ? a.choice : UNSETTLED;
  if (q.type === 'score' && a.type === 'score') {
    const top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0];
    return top && a.confidence >= at ? top[0] : UNSETTLED;
  }
  if (q.type === 'box' && a.type === 'box') return a.confidence !== null && a.confidence >= at ? 'located' : UNSETTLED;
  return UNSETTLED;
}

export function bands(t: ServiceTemplate, answers: Record<string, Answer>): Record<string, Band> {
  return Object.fromEntries(Object.entries(t.questions).map(([id, q]) => [id, answers[id] ? band(q, answers[id]!, id, t.policy) : UNSETTLED]));
}

// Every combination of bands, in order. Throws when there are more than MAX_ROWS.
export function rows(t: ServiceTemplate): Record<string, Band>[] {
  const ids = Object.keys(t.questions);
  const doms = ids.map((id) => domain(t.questions[id]!));
  const count = doms.reduce((n, d) => n * d.length, 1);
  if (count > MAX_ROWS) throw new Error(`${t.template_id}'s truth table has ${count} rows; split the battery or decide part of it in code.`);
  let out: Record<string, Band>[] = [{}];
  ids.forEach((id, i) => { out = out.flatMap((r) => doms[i]!.map((b) => ({ ...r, [id]: b }))); });
  return out;
}

// Every row has a declared outcome; returns the problems.
export function checkTable(t: ServiceTemplate): string[] {
  const p = t.policy;
  const problems: string[] = [];
  if (!(p.default in p.outcomes)) problems.push(`the default "${p.default}" isn’t one of its outcomes`);
  let all: Record<string, Band>[];
  try { all = rows(t); } catch (e) { return [...problems, (e as Error).message]; }
  for (const r of all) {
    let o: string;
    try { o = p.table(r); } catch (e) { problems.push(`the table throws on ${JSON.stringify(r)}: ${(e as Error).message}`); continue; }
    if (!(o in p.outcomes)) { problems.push(`the table gives "${o}" for ${JSON.stringify(r)}, which isn’t one of its outcomes`); if (problems.length > 5) break; }
  }
  return problems;
}

// How settled the answers are: high when no question is unsettled, medium otherwise.
export const qualityOf = (b: Record<string, Band>): Quality => (Object.values(b).includes(UNSETTLED) ? 'medium' : 'high');

// The ADR's table: a restrictive outcome (hold, block, pause) always acts, since it only makes
// things safer. Otherwise: tier 0–1 acts when high, asks when medium; tier 2 always asks; tier 3
// always confirms; low quality escalates or stops, per the template.
export function autonomy(tier: Tier, quality: Quality, restrictive: boolean, low: Policy['low']): Autonomy {
  if (restrictive) return 'act';
  if (quality === 'low') return tier === 3 ? 'stop' : low;
  if (tier === 3) return 'confirm';
  if (tier === 2) return 'ask';
  return quality === 'high' ? 'act' : 'ask';
}
