// The Interstitial Research templates' eval set, in memory-gate's format (cases.ts, manifest.json,
// write-manifest.ts), written after the templates and their rules and before any run. No run has
// happened: there is no real seat in CI, so these templates have no verdict and stay evidence-only
// (quarantine / withhold) until an eval run on a real seat passes.
//
// SYNTHETIC ONLY: placeholder people (Alex, Sam, Jordan, Taylor Placeholder), invented excerpts.
//
// LABELS (true means it really is so):
//   verify-transfer  from_field, mechanism, supports, established (SKILL.md §4 (a)–(d));
//   outbound-check   person, record, memory.
// Each case's EXPECTED outcome is the template's own rule on its labels (true → yes, false → no).
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { OC_QUESTIONS, VT_QUESTIONS, outboundPolicy, verifyPolicy } from '../../../src/core/decision-service/templates/interstitial.ts';

type Q = string;
export interface Case { id: string; template: 'interstitial.verify-transfer' | 'interstitial.outbound-check'; category: string; input: Record<string, string>; labels: Record<Q, boolean>; expected: string }

const yesNo = (l: Record<Q, boolean>) => Object.fromEntries(Object.entries(l).map(([q, v]) => [q, v ? 'yes' : 'no']));
// F from_field, M mechanism, S supports, E established.
const V = (id: string, category: string, claim: string, claimed_field: string, excerpt: string, labels: string): Case => {
  const l = { from_field: labels.includes('F'), mechanism: labels.includes('M'), supports: labels.includes('S'), established: labels.includes('E') };
  return { id, template: 'interstitial.verify-transfer', category, input: { claim, claimed_field, cited_source_excerpt: excerpt }, labels: l, expected: verifyPolicy(yesNo(l)) };
};
// P person, R record, Y memory.
const O = (id: string, category: string, query: string, privacy_class: string, labels: string): Case => {
  const l = { person: labels.includes('P'), record: labels.includes('R'), memory: labels.includes('Y') };
  return { id, template: 'interstitial.outbound-check', category, input: { query, privacy_class }, labels: l, expected: outboundPolicy(yesNo(l)) };
};

export function buildCases(): Case[] {
  return [
    // ---- verify-transfer: a sound transfer, established in its field ---------------------------
    V('vt-wip', 'sound, established', 'Limiting work in progress shortens lead time in build pipelines.', 'manufacturing flow', 'In lean manufacturing, Little’s law ties lead time to work in progress; capping WIP is the standard way to shorten lead time.', 'FMSE'),
    V('vt-queue', 'sound, established', 'Past a point, adding runners no longer cuts CI wait time because jobs wait on a shared cache.', 'queueing theory', 'In a tandem queue, adding servers at one stage leaves waiting dominated by the slowest downstream stage.', 'FMSE'),
    V('vt-thermal', 'sound, established', 'Keeping a battery pack cooler slows capacity fade.', 'thermal engineering', 'Arrhenius behaviour: side reactions in lithium-ion cells roughly double in rate for each ten degrees of temperature rise.', 'FMSE'),
    // ---- a sound transfer that is only a hypothesis -------------------------------------------
    V('vt-hyp', 'sound, hypothesis', 'Feedback delay in CI changes how developers batch commits, as delayed rewards change behaviour.', 'behavioural economics', 'Delayed rewards are discounted steeply; people batch effort when feedback is slow. Whether this applies to software teams is untested.', 'FMS'),
    // ---- surface analogy (mechanism differs) --------------------------------------------------
    V('vt-surface', 'surface analogy', 'Software modules should heal themselves like cells.', 'cellular biology', 'Cells repair DNA damage through enzyme pathways triggered by specific lesions.', 'FS'),
    // ---- wrong field --------------------------------------------------------------------------
    V('vt-field', 'wrong field', 'Architectural load paths explain microservice failures.', 'architectural engineering', 'A blog post on microservices mentions that systems carry load.', 'MS'),
    // ---- citation doesn't support it ----------------------------------------------------------
    V('vt-unsupported', 'unsupported', 'Theory of Constraints proves CI must have exactly one bottleneck.', 'operations research', 'The Theory of Constraints suggests focusing on the current constraint of a system.', 'FM'),
    V('vt-overstated', 'unsupported', 'Every battery loses half its capacity in three years.', 'electrochemistry', 'Capacity fade depends on temperature, depth of discharge and charge rate; ranges vary widely.', 'FM'),
    // ---- nothing holds ------------------------------------------------------------------------
    V('vt-none', 'nothing holds', 'Astrology predicts build failures.', 'astronomy', 'Stellar parallax measures the distance to nearby stars.', ''),
    // ---- outbound-check: public, abstract ------------------------------------------------------
    O('oc-public', 'abstract', 'flow efficiency in build pipelines', 'public', ''),
    O('oc-general-health', 'abstract', 'how do common sleep aids work', 'personal-derived', ''),
    O('oc-public-figure', 'abstract', 'Donella Meadows leverage points summary', 'public', ''),
    // ---- carries a person ---------------------------------------------------------------------
    O('oc-name', 'person', 'Dr Alex Placeholder clinic reviews', 'personal-derived', 'P'),
    O('oc-email', 'person', 'sam.placeholder at example mail account recovery', 'sensitive', 'P'),
    // ---- carries a record ---------------------------------------------------------------------
    O('oc-rx', 'record', 'side effects of 10mg zolpidem nightly for three years', 'personal-derived', 'R'),
    O('oc-salary', 'record', 'is 41250 a year after tax enough to cover my 1180 rent', 'personal-derived', 'R'),
    // ---- carries memory or capture ------------------------------------------------------------
    O('oc-memory', 'memory', 'what did Jordan Placeholder mean by the blue folder plan', 'personal-derived', 'PY'),
    O('oc-capture', 'memory', 'meaning of the message "the shed key is under the third pot"', 'sensitive', 'Y'),
  ];
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export function manifest(cases: Case[] = buildCases()) {
  const expected: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const c of cases) { expected[`${c.template}:${c.expected}`] = (expected[`${c.template}:${c.expected}`] ?? 0) + 1; counts[c.category] = (counts[c.category] ?? 0) + 1; }
  return {
    cases_sha256: sha(JSON.stringify(cases)),
    total: cases.length,
    expected,
    counts,
    rows: cases.map((c) => ({ id: c.id, template: c.template, category: c.category, labels: Object.entries(c.labels).filter(([, v]) => v).map(([q]) => q), expected: c.expected, input_sha256: sha(JSON.stringify(c.input)) })),
  };
}

export const QUESTIONS = { 'interstitial.verify-transfer': VT_QUESTIONS, 'interstitial.outbound-check': OC_QUESTIONS };
export const MANIFEST_FILE = join(import.meta.dirname, 'manifest.json');
