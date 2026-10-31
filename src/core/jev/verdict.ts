// The verdict-driven switch (plan docs/plans/tev1.md §3). Whether the gate's probability thresholds
// rely on Tev1 is decided by the injection eval's recorded verdict for the size in use, never by a
// setting: tev1-verdicts.json is written by the eval run (tests/acceptance/tev1-eval-real.test.ts),
// and CI recomputes it from the committed per-case results, so a hand edit fails the check.
//
// Relied on only when that size's status is "pass", the digest it ran against is the installed
// model's, and the recorded bounds are the bounds in eval.ts. Anything else is ADVISORY: Tev1 still
// answers, its scores are logged as evidence, and its decision comes back escalated, which the gate
// takes as no model answer, so the deterministic layer and quarantine-on-uncertain decide.
import { readFileSync } from 'node:fs';
import { BOUNDS, type Bounds, type Metrics } from './eval.ts';
import type { Decision, DecisionProvider, Template } from '../decide.ts';
import type { Log } from '../log.ts';
import type { Size, Tev1Provider, Tev1Status } from './tev1.ts';

export const VERDICTS_FILE = new URL('./tev1-verdicts.json', import.meta.url);

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
  // The commit that fixed the cases, the bounds and the scoring before any real run.
  bounds_commit: string | null;
  cases_sha256: string;
  sizes: Record<Size, SizeVerdict>;
}

export function readVerdicts(file: URL | string = VERDICTS_FILE): VerdictFile {
  return JSON.parse(readFileSync(file, 'utf8')) as VerdictFile;
}

export interface Reliance { relied: boolean; why: string }

const sameBounds = (a: Bounds, b: Bounds) => (Object.keys(b) as (keyof Bounds)[]).every((k) => a?.[k] === b[k]) && Object.keys(a ?? {}).length === Object.keys(b).length;

export function relianceFor(v: VerdictFile | null, model: Size | null, digest: string | null): Reliance {
  if (!model) return { relied: false, why: 'No Tev1 size is in use.' };
  const s = v?.sizes?.[model];
  if (!v || !s) return { relied: false, why: `There is no recorded eval verdict for ${model}; its scores are advisory.` };
  if (!sameBounds(v.bounds, BOUNDS)) return { relied: false, why: `The eval verdict for ${model} was recorded against other bounds; its scores are advisory until the eval runs again.` };
  if (s.status === 'not-run') return { relied: false, why: `The injection eval hasn’t been run on ${model} yet (${s.why}); its scores are advisory.` };
  if (s.status === 'fail') return { relied: false, why: `${model} didn’t pass the injection eval (${s.why}); its scores are advisory.` };
  if (!digest || s.digest !== digest) return { relied: false, why: `The installed ${model} isn’t the build the eval passed (${short(s.digest)} was tested, ${short(digest)} is installed); its scores are advisory until the eval runs again.` };
  return { relied: true, why: `${model} passed the injection eval on ${s.run_at?.slice(0, 10) ?? 'record'}; the gate’s thresholds use its scores.` };
}

const short = (d: string | null) => (d ? d.replace(/^sha256:/, '').slice(0, 12) : 'none');

export interface Bound extends DecisionProvider {
  readyFor(templateId: string): boolean;
  status(): Tev1Status & { reliance: Reliance };
  refresh(): Promise<Tev1Status>;
}

// The provider as production registers it: the recorded verdict decides whether its answers
// count. `verdicts` is read on every decision, so a new run's file takes effect without a restart.
export function boundToVerdict(p: Tev1Provider, o: { verdicts?: () => VerdictFile | null; log?: Log } = {}): Bound {
  const verdicts = o.verdicts ?? (() => { try { return readVerdicts(); } catch { return null; } });
  const reliance = () => { const s = p.status(); return relianceFor(verdicts(), s.model, s.digest); };
  return {
    id: p.id,
    egress: p.egress,
    questionTypes: p.questionTypes,
    ready: (t: Template) => p.ready(t),
    readyFor: (id: string) => p.readyFor(id),
    refresh: () => p.refresh(),
    status: () => ({ ...p.status(), reliance: reliance() }),
    async decide(t: Template, inputs: Record<string, unknown>): Promise<Decision> {
      const d = await p.decide(t, inputs);
      const r = reliance();
      if (r.relied) return d;
      // Evidence only: numbers, never the content.
      o.log?.info('decide', 'Tev1 answered as advisory; the gate doesn’t use its scores.', { template: t.template_id, model: p.status().model, scores: d.answers, requests: p.last?.requests ?? null, why: r.why });
      return { ...d, escalate: true, why: `Tev1 is advisory: ${r.why}` };
    },
  };
}
