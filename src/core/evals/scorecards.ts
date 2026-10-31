// The model-swap scorecard (Amendment 2026-10-31-B Part 4): per provider and model, the latest run
// of each suite, kept as plain files under the Nova home that Settings shows them for:
//   <home>/workers/evals/scorecards/<provider>--<model>-<hash>.json   the latest card per model
//   <home>/workers/evals/runs.jsonl                                  every run, appended
// `workers/` is one of Nova's own home entries already (resilience/entries.ts), so checkpoints,
// restores and a factory reset treat these like the rest of Nova's state; the agent's write_file
// can't reach it (workspace/ and the standing files only), so no model can forge its own card.
// No migration: the files are the store.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Route } from '../api.ts';
import type { SuiteName, SuiteRun } from './types.ts';

export const SCORECARD_DIR = join('workers', 'evals');
export const SCORECARD_SCHEMA = 1;

export interface Target {
  // The provider registry's id (openai-compatible, custom-cli, …) and the model it serves.
  provider: string;
  model: string;
  // The model's digest as the runtime that served it reports it (Ollama's /api/tags), if any.
  digest?: string | null;
  // Where it runs, in the registry's coarse words (none, local, remote).
  where?: string | null;
}

export interface SuiteCard {
  fingerprint: string;
  passed: number;
  total: number;
  pass_rate: number;
  ungraded: number;
  trials: number;
  date: string;
  run_id: string;
  duration_ms: number;
  nova: { version: string; commit: string | null };
  // The address the model was reached at, for the record (never a secret).
  endpoint?: string | null;
  failed: { id: string; why: string }[];
}

export interface Scorecard {
  schema: number;
  target: Target;
  suites: Partial<Record<SuiteName, SuiteCard>>;
}

export type CardState = 'current' | 'stale' | 'none';
export interface CardStatus {
  state: CardState;
  target: Target;
  card: SuiteCard | null;
  // Plain words for Settings › Models, shown before a switch.
  words: string;
  why?: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function cardFile(provider: string, model: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 60);
  const h = createHash('sha256').update(`${provider}\0${model}`).digest('hex').slice(0, 8);
  return `${slug(provider)}--${slug(model)}-${h}.json`;
}

export class Scorecards {
  readonly dir: string;

  constructor(home: string) {
    this.dir = join(home, SCORECARD_DIR);
  }

  #cards(): string {
    return join(this.dir, 'scorecards');
  }

  get(provider: string, model: string): Scorecard | null {
    const f = join(this.#cards(), cardFile(provider, model));
    if (!existsSync(f)) return null;
    try {
      const c = JSON.parse(readFileSync(f, 'utf8')) as Scorecard;
      return c?.schema === SCORECARD_SCHEMA && c.target?.provider === provider && c.target?.model === model ? c : null;
    } catch {
      return null; // a damaged card is no card: the model reads as unchecked, never as passing
    }
  }

  list(): Scorecard[] {
    let names: string[] = [];
    try { names = readdirSync(this.#cards()).filter((n) => n.endsWith('.json')); } catch { return []; }
    const out: Scorecard[] = [];
    for (const n of names.sort()) {
      try {
        const c = JSON.parse(readFileSync(join(this.#cards(), n), 'utf8')) as Scorecard;
        if (c?.schema === SCORECARD_SCHEMA && c.target && cardFile(c.target.provider, c.target.model) === n) out.push(c);
      } catch { /* skipped, as get() would */ }
    }
    return out;
  }

  // Records a suite run for a target: the card's entry for that suite is replaced (the latest run
  // is what a card shows), and the run is appended to runs.jsonl (the history).
  record(target: Target, run: SuiteRun, o: { nova: { version: string; commit: string | null }; endpoint?: string | null }): Scorecard {
    if (!target.provider || !target.model) throw new Error('A scorecard needs the provider and the model.');
    mkdirSync(this.#cards(), { recursive: true });
    const prev = this.get(target.provider, target.model);
    const entry: SuiteCard = {
      fingerprint: run.fingerprint, passed: run.passed, total: run.total, pass_rate: run.pass_rate, ungraded: run.ungraded, trials: run.trials,
      date: run.finished, run_id: run.run_id, duration_ms: run.duration_ms, nova: o.nova, endpoint: o.endpoint ?? null,
      failed: run.results.filter((r) => !r.passed).map((r) => ({ id: r.id, why: r.why[0] ?? (r.ungraded ? 'ungraded' : 'failed') })),
    };
    const card: Scorecard = { schema: SCORECARD_SCHEMA, target: { ...prev?.target, ...target }, suites: { ...prev?.suites, [run.suite]: entry } };
    const file = join(this.#cards(), cardFile(target.provider, target.model));
    writeFileSync(`${file}.tmp`, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o644 });
    renameSync(`${file}.tmp`, file);
    appendFileSync(join(this.dir, 'runs.jsonl'), `${JSON.stringify({ target, suite: run.suite, ...entry, results: run.results.map((r) => ({ id: r.id, version: r.version, passed: r.passed, ungraded: r.ungraded, why: r.why })) })}\n`);
    return card;
  }

  history(limit = 50): Record<string, unknown>[] {
    let text = '';
    try { text = readFileSync(join(this.dir, 'runs.jsonl'), 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).slice(-limit).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
  }

  // Whether a model has a current regression scorecard: run against today's suite (its
  // fingerprint) and, when the runtime reports a digest, against the model as installed now.
  status(target: Target, fingerprint: string): CardStatus {
    const card = this.get(target.provider, target.model);
    const reg = card?.suites.regression ?? null;
    if (!card || !reg) {
      return { state: 'none', target, card: null, words: 'No scorecard: Nova hasn’t run its regression tasks against this model. You can still switch to it; how well it does here is unchecked.' };
    }
    const score = `${reg.passed} of ${reg.total} regression tasks passed (${pct(reg.pass_rate)}), ${day(reg.date)}`;
    let why: string | null = null;
    if (reg.fingerprint !== fingerprint) why = 'the regression tasks have changed since';
    else if (target.digest && card.target.digest && target.digest !== card.target.digest) why = 'the model has been updated since';
    else if (target.digest && !card.target.digest) why = 'the model’s version wasn’t recorded then';
    if (why) return { state: 'stale', target, card: reg, why, words: `${score}. Not current: ${why}. You can still switch to it.` };
    return { state: 'current', target, card: reg, words: `${score}.` };
  }
}

// What the registry has configured as chat models, as scorecard targets, with the digest Ollama
// reports for a model of that name. Reads the registry's views only (Providers.list()).
export function targetsFrom(providers: { id: string; class: string; model: string; enabled: boolean; implementation: string; egress?: { coarse?: string } }[], installed: { name: string; digest?: string }[] = []): Target[] {
  return providers
    .filter((p) => p.class === 'chat' && (p.enabled || p.implementation === 'custom-cli') && p.model && p.model !== 'unset')
    .map((p) => ({ provider: p.id, model: p.model, digest: installed.find((m) => m.name === p.model)?.digest ?? null, where: p.egress?.coarse ?? null }));
}

// The routes, ready for the composition root to wire (NOTES for Track 1 in docs/plans/evals.md):
// GET /evals/scorecards: today's regression fingerprint, each configured model's status in plain
// words (shown in Settings › Models before a switch), and every card kept.
export function scorecardRoutes(o: { store: Scorecards; fingerprint: string; targets: () => Target[] | Promise<Target[]> }): Route[] {
  return [
    {
      method: 'GET', path: '/evals/scorecards',
      summary: 'The model-swap scorecards: each configured model’s latest regression pass rate and date, whether it is current (today’s tasks, the model as installed now), and every scorecard kept. A model with no current scorecard can still be chosen.',
      handle: async () => {
        const targets = await o.targets();
        return { fingerprint: o.fingerprint, configured: targets.map((t) => o.store.status(t, o.fingerprint)), cards: o.store.list() };
      },
    },
    {
      method: 'GET', path: '/evals/scorecards/status',
      summary: 'One model’s scorecard status before switching to it: ?provider=<id>&model=<name>[&digest=<sha256>].',
      handle: ({ query }) => {
        const provider = query.get('provider') ?? '';
        const model = query.get('model') ?? '';
        if (!provider || !model) return { state: 'none', words: 'Name the provider and the model.' };
        return o.store.status({ provider, model, digest: query.get('digest') }, o.fingerprint);
      },
    },
  ];
}
