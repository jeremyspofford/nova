// The cloud Jev seat (ADR docs/plans/decision-service.md §2): TypeSafe's System One API, on the
// route and model the person chose (owner decision 2). Limits from TypeSafe's models page and
// request rules (read 2026-10-31): no limit on the number of questions; 64k tokens per request and
// 32k per question (the long-context header is never sent); a body of at most 32 MiB; images and
// Box questions with the images header, Box on jev-1.14.0 only.
//
// The model is PINNED to a versioned id (jev-1.14.0). An alias (jev-latest, jev-preview) moves
// under you, so it is refused. The key is read from the vault at call time and never logged.
// Nothing in Nova's tests calls TypeSafe: this seat is exercised against a loopback stand-in.
import { askChunked, estimateTokens } from '../chunk.ts';
import { body, JEV_MAX_BODY_BYTES, SystemOne, Unavailable, utf8, wireQuestions } from '../wire.ts';
import type { BuiltState, Seat, SeatAnswer, SeatLimits, SeatStatus, ServiceTemplate } from '../types.ts';
import type { Egress } from '../../workers.ts';

export const SEAT_ID = 'jev';
export const RECOMMENDED_URL = 'https://api.typesafe.ai';
export const RECOMMENDED_MODEL = 'jev-1.14.0';
export const VERSIONED = /^jev-\d+\.\d+\.\d+$/;
export const ALIASES = ['jev-latest', 'jev-preview'];
export const PER_REQUEST_TOKENS = 64_000;
export const PER_QUESTION_TOKENS = 32_000;
// Box needs jev-1.14 or later.
export const BOX_SINCE = [1, 14] as const;

export interface JevConfig { base_url: string; model: string; key: () => string | null }

export function boxCapable(model: string): boolean {
  const m = /^jev-(\d+)\.(\d+)\.\d+$/.exec(model);
  return !!m && (Number(m[1]) > BOX_SINCE[0] || (Number(m[1]) === BOX_SINCE[0] && Number(m[2]) >= BOX_SINCE[1]));
}

// Why a model id can't be used, or null.
export function modelProblem(model: string): string | null {
  if (ALIASES.includes(model)) return `${model} is an alias that moves to each new Jev release, so answers could change under thresholds tuned on another version. Choose a versioned model, such as ${RECOMMENDED_MODEL}.`;
  if (!VERSIONED.test(model)) return `${model} isn’t a versioned Jev model id (such as ${RECOMMENDED_MODEL}).`;
  return null;
}

// Whether one request with this state fits TypeSafe's two context limits and its body limit.
export function fits(model: string, state: Record<string, unknown>, questions: Record<string, unknown>): boolean {
  if (utf8(body(model, state, questions)) > JEV_MAX_BODY_BYTES) return false;
  const s = estimateTokens(JSON.stringify(state));
  const qs = Object.values(questions).map((q) => estimateTokens(JSON.stringify(q)));
  return s + qs.reduce((a, b) => a + b, 0) <= PER_REQUEST_TOKENS && s + Math.max(0, ...qs) <= PER_QUESTION_TOKENS;
}

export class JevSeat implements Seat {
  readonly id = SEAT_ID;
  readonly egress: Egress = 'remote';
  #config: () => JevConfig | null;
  #timeoutMs: number;

  constructor(o: { config: () => JevConfig | null; timeoutMs?: number }) {
    this.#config = o.config;
    this.#timeoutMs = o.timeoutMs ?? 30_000;
  }

  limits(): SeatLimits {
    const c = this.#config();
    return { maxQuestions: null, contextTokens: PER_REQUEST_TOKENS, perQuestionTokens: PER_QUESTION_TOKENS, maxBodyBytes: JEV_MAX_BODY_BYTES, images: true, types: c && boxCapable(c.model) ? ['noul', 'choice', 'score', 'box'] : ['noul', 'choice', 'score'] };
  }

  status(): SeatStatus {
    const c = this.#config();
    if (!c) return { available: false, model: null, why: 'Jev isn’t set up: no route has been chosen in Settings › Models.' };
    const bad = modelProblem(c.model);
    if (bad) return { available: false, model: null, why: bad };
    try { new URL(c.base_url); } catch { return { available: false, model: c.model, why: `${c.base_url} isn’t an address.` }; }
    if (!c.key()) return { available: false, model: c.model, why: 'Jev is set up without a key; add it in Settings › Models.' };
    return { available: true, model: c.model, why: `Jev (${c.model}) at ${new URL(c.base_url).host}.` };
  }

  // `beforeSend` runs before every request: the service re-reads the mode and the opt-ins there, so
  // a switch turned off part-way stops the rest.
  async ask(t: ServiceTemplate, built: BuiltState, o: { beforeSend?: () => void } = {}): Promise<SeatAnswer> {
    const s = this.status();
    const c = this.#config();
    if (!s.available || !c) throw new Unavailable(s.why);
    if (Object.values(t.questions).some((q) => q.type === 'box') && !boxCapable(c.model)) throw new Unavailable(`Box questions need jev-1.14.0 or later; ${c.model} is chosen.`);
    const client = new SystemOne(c.base_url, { key: c.key, maxQuestions: null, maxBodyBytes: JEV_MAX_BODY_BYTES, timeoutMs: this.#timeoutMs });
    const wq = wireQuestions(t.questions);
    return askChunked({
      t, built,
      fits: (state) => fits(c.model, state, wq),
      ask: (state) => { o.beforeSend?.(); return client.ask(c.model, state, t.questions, { images: built.images }); },
    });
  }
}
