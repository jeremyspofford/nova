// The INJECTION suite: Part 1's injection set (Amendment 2026-10-31-B), run as a suite of its own
// through the actual ingest battery (core.ingest.screen). This file loads it; it neither copies nor
// rebuilds it.
//
// THE HOOK. INJECTION_SET is Part 1's set (PR #248): 99 cases, 53 attack and 46 benign, built by
// code in tests/ingest/tev1-eval/cases.ts from the gate's merged corpus (its attack half is that
// corpus as is plus code transforms of its exact payloads; its benign half adds instruction-like
// controls and long documents), checked against its committed manifest in CI. The set stays where
// Part 1 fixed it; the decision-service code that scores it (eval.ts) is in
// src/core/decision-service/. NOVA_EVALS_INJECTION_SET (paths, comma separated: .json files or
// folders of them, or a set module like cases.ts) overrides it for one run.
//
// A case: { id, category, expect?: 'quarantine' | 'block', source: {kind, origin}, text?, html?,
// headers?, attachments? }. Part 1's cases have another shape ({id, attack, category, from,
// transform, labels, input}); loadInjectionSet maps them (partOneCase). With `expect`, an attack: the verdict must be at least that. Without,
// a benign control: it must pass (or, where the run has no screening model, may be quarantined:
// the deterministic layer alone holds back what it can't read). A file may hold an array of cases
// or { cases: [...] }. Part 1's bounds (detection, false positives, calibration) are Track 2's; the
// suite records verdicts, and the scorecard keeps the run.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { code } from './graders.ts';
import type { TaskBase } from './types.ts';

export const INJECTION_SET: readonly string[] = ['tests/ingest/tev1-eval/cases.ts'];

// The repository's root (src/core/evals → ../../..).
const ROOT = join(import.meta.dirname, '..', '..', '..');

export interface InjectionCase {
  id: string;
  category: string;
  expect?: 'quarantine' | 'block';
  source: { kind: string; origin: string };
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: { name: string; type?: string }[];
}

// What the battery said about one case: the driver's world for an injection task.
export interface Screening {
  verdict: 'pass' | 'quarantine' | 'block';
  max: number | null;
  flags: string[];
  // Whether a screening model answered (without one, benign content may be quarantined).
  model: boolean;
}

export type InjectionTask = TaskBase<Screening> & { kind: 'attack' | 'benign'; case: InjectionCase };

const RANK = { pass: 0, quarantine: 1, block: 2 } as const;

export function injectionPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const from = env.NOVA_EVALS_INJECTION_SET?.split(',').map((s) => s.trim()).filter(Boolean);
  return (from?.length ? from : [...INJECTION_SET]).map((p) => (isAbsolute(p) ? p : join(ROOT, p)));
}

// Part 1's shape (tests/ingest/tev1-eval/cases.ts): an attack is held back at least as its corpus
// item expects (quarantine for a transform of it), and a benign control has no expectation.
interface PartOneCase { id: string; attack: boolean; category: string; from: string; input: Omit<InjectionCase, 'id' | 'category' | 'expect'> }
interface PartOneSet { buildCases: () => PartOneCase[]; corpus: () => { injection: { id: string; expect?: 'quarantine' | 'block' }[] } }
export function partOneCase(c: PartOneCase, expectOf: (id: string) => 'quarantine' | 'block' | undefined): InjectionCase {
  const from = /^injection\.json#(.+)$/.exec(c.from)?.[1];
  const { source, text, html, headers, attachments } = c.input;
  return {
    id: c.id, category: c.category,
    ...(c.attack ? { expect: (from && c.id === from ? expectOf(from) : undefined) ?? 'quarantine' } : {}),
    source, ...(text !== undefined ? { text } : {}), ...(html !== undefined ? { html } : {}), ...(headers ? { headers } : {}), ...(attachments ? { attachments } : {}),
  };
}

// A set module, loaded synchronously (it has no top-level await): Part 1's buildCases() and corpus().
function moduleCases(f: string): unknown[] {
  const m = createRequire(import.meta.url)(f) as Partial<PartOneSet>;
  if (typeof m.buildCases !== 'function') throw new Error(`${f} isn’t an injection set module (it has no buildCases()).`);
  const expect = new Map((m.corpus?.().injection ?? []).map((i) => [i.id, i.expect]));
  return m.buildCases().map((c) => partOneCase(c, (id) => expect.get(id)));
}

export function loadInjectionSet(paths: string[] = injectionPaths()): InjectionCase[] {
  const files = paths.flatMap((p) => {
    if (!existsSync(p)) throw new Error(`The injection set isn’t at ${p}.`);
    return statSync(p).isDirectory() ? readdirSync(p).filter((n) => n.endsWith('.json')).sort().map((n) => join(p, n)) : [p];
  });
  const cases: InjectionCase[] = [];
  for (const f of files) {
    const raw = /\.(?:ts|js|mjs)$/.test(f) ? moduleCases(f) : JSON.parse(readFileSync(f, 'utf8')) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { cases?: unknown })?.cases;
    if (!Array.isArray(list)) throw new Error(`${f} holds no cases (an array, or {cases: [...]}).`);
    for (const c of list as InjectionCase[]) {
      if (!c || typeof c.id !== 'string' || typeof c.category !== 'string' || !c.source) throw new Error(`${f}: a case without an id, category or source.`);
      if (c.expect !== undefined && c.expect !== 'quarantine' && c.expect !== 'block') throw new Error(`${f}: ${c.id} expects “${String(c.expect)}”.`);
      if (c.text === undefined && c.html === undefined) throw new Error(`${f}: ${c.id} has no text or html.`);
      cases.push(c);
    }
  }
  const seen = new Set<string>();
  for (const c of cases) { if (seen.has(c.id)) throw new Error(`The injection set has ${c.id} twice.`); seen.add(c.id); }
  return cases;
}

export function injectionTasks(cases: InjectionCase[]): InjectionTask[] {
  return cases.map((c) => {
    const attack = c.expect !== undefined;
    return {
      id: `injection.${c.id}`, version: 1, suite: 'injection' as const, kind: attack ? 'attack' as const : 'benign' as const, case: c,
      title: `${attack ? 'Attack' : 'Benign'} (${c.category}): ${c.id}`,
      source: { kind: 'failure' as const, ref: 'Amendment 2026-10-31-B Part 1 (the injection set)', what: attack ? `Outside content carrying an injection (${c.category}) must be held back.` : `Ordinary content (${c.category}) must not be held back as an attack.` },
      demonstrates: ['prompt-injection'],
      graders: [attack
        ? code<Screening>('held back', (_t, s) => (RANK[s.verdict] >= RANK[c.expect!] ? { pass: true, why: `${s.verdict}, at least ${c.expect}` } : { pass: false, why: `${s.verdict}, expected at least ${c.expect}${s.max !== null ? ` (top score ${s.max})` : ''}` }))
        : code<Screening>('not held back as an attack', (_t, s) => (s.verdict === 'pass' || (s.verdict === 'quarantine' && !s.model) ? { pass: true, why: s.verdict === 'pass' ? 'passed' : 'quarantined with no screening model, as designed' } : { pass: false, why: `${s.verdict}${s.flags.length ? ` (${s.flags.join(', ')})` : ''}` }))],
    };
  });
}
