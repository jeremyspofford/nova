// Long state, for a seat whose context it would exceed (moved from Part 1's tev1.ts; ADR §2, §4).
// A template field declared chunk: 'worst' is split into pieces that each fit the seat, EVERY piece
// is asked with the whole battery, and each Noul keeps its worst (highest) probability across the
// pieces. Nothing is sampled, nothing is truncated, and no decision is made on part of the state.
// The numbers were fixed in Part 1 before any real run and are not tuned to results.
import { TooLong, type Asked } from './wire.ts';
import type { Answer, BuiltState, SeatAnswer, ServiceTemplate } from './types.ts';

export const OVERLAP_CHARS = 200;
export const MAX_PIECES = 64;
export const MAX_SPLIT_DEPTH = 4;
// A conservative token estimate: one token per two UTF-8 bytes (Qwen's tokenizer averages about
// four bytes a token on English; dense text such as base64 or other scripts takes more).
export const estimateTokens = (s: string): number => Math.ceil(Buffer.byteLength(s, 'utf8') / 2);

export interface PlanLimits { overlap: number; maxPieces: number }
export const PLAN_LIMITS: PlanLimits = Object.freeze({ overlap: OVERLAP_CHARS, maxPieces: MAX_PIECES });

export interface Piece { start: number; end: number; text: string }

// The pieces of `inner` (in code points, so no character is cut): each the longest run from its
// start that fits, preferring to end at whitespace in its last eighth, overlapping the next by
// `overlap` (at most a quarter of the piece). Together they cover every character.
export function plan(inner: string, ok: (piece: string) => boolean, l: PlanLimits = PLAN_LIMITS): Piece[] {
  const cp = Array.from(inner);
  const n = cp.length;
  const text = (i: number, j: number) => cp.slice(i, j).join('');
  if (!n) {
    if (!ok('')) throw new TooLong('The questions alone don’t fit in one request.');
    return [{ start: 0, end: 0, text: '' }];
  }
  const out: Piece[] = [];
  let i = 0;
  for (;;) {
    let lo = i, hi = n;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (ok(text(i, mid))) lo = mid; else hi = mid - 1;
    }
    let j = lo;
    if (j === i) throw new TooLong('Not even one character of the state fits beside the questions in one request.');
    if (j < n) {
      const floor = j - Math.floor((j - i) / 8);
      for (let k = j - 1; k > Math.max(i, floor); k--) if (/\s/.test(cp[k]!)) { j = k + 1; break; }
    }
    out.push({ start: i, end: j, text: text(i, j) });
    if (out.length > l.maxPieces) throw new TooLong(`This state needs more than ${l.maxPieces} requests; Nova doesn’t decide on part of it.`);
    if (j >= n) return out;
    i = Math.max(i + 1, j - Math.min(l.overlap, Math.floor((j - i) / 4)));
  }
}

// One state, chunked if it must be: each request carries the whole battery; answers aggregate by
// the worst Noul. `fits` says whether a whole state fits one request on this seat.
export async function askChunked(o: {
  t: ServiceTemplate;
  built: BuiltState;
  fits: (state: Record<string, unknown>) => boolean;
  ask: (state: Record<string, unknown>) => Promise<Asked>;
  limits?: PlanLimits;
}): Promise<SeatAnswer> {
  const l = o.limits ?? PLAN_LIMITS;
  const usage = { input_tokens: 0, output_tokens: 0 };
  let requests = 0;
  let model = '';
  const one = async (state: Record<string, unknown>) => {
    requests++;
    const r = await o.ask(state);
    usage.input_tokens += r.usage.input_tokens ?? 0;
    usage.output_tokens += r.usage.output_tokens ?? 0;
    model ||= r.model;
    return r;
  };
  if (!o.built.chunk || o.fits(o.built.state)) {
    const r = await one(o.built.state);
    return { answers: r.answers, model_answered: r.model, pieces: 1, requests, usage };
  }
  const field = o.built.chunk.field;
  const value = String(o.built.state[field] ?? '');
  const { inner, wrap } = o.built.chunk.split ? o.built.chunk.split(value) : { inner: value, wrap: (p: string) => p };
  const withPiece = (piece: string) => ({ ...o.built.state, [field]: wrap(piece) });
  const pieces = plan(inner, (p) => o.fits(withPiece(p)), l);
  const ids = Object.keys(o.t.questions);
  const worst: Record<string, number> = Object.fromEntries(ids.map((q) => [q, 0]));
  let count = 0;
  const screen = async (piece: string, depth: number): Promise<void> => {
    if (++count > l.maxPieces) throw new TooLong(`This state needs more than ${l.maxPieces} requests; Nova doesn’t decide on part of it.`);
    try {
      const r = await one(withPiece(piece));
      for (const q of ids) { const a = r.answers[q]; if (a?.type === 'noul') worst[q] = Math.max(worst[q]!, a.noul); }
    } catch (e) {
      if (!(e instanceof TooLong) || depth >= MAX_SPLIT_DEPTH) throw e;
      // The seat found it too long after all: both halves, overlapping, are screened instead.
      const cp = Array.from(piece);
      if (cp.length < 2) throw e;
      const mid = Math.floor(cp.length / 2);
      const ov = Math.min(l.overlap, Math.floor(cp.length / 4));
      await screen(cp.slice(0, mid + ov).join(''), depth + 1);
      await screen(cp.slice(mid - ov).join(''), depth + 1);
    }
  };
  for (const p of pieces) await screen(p.text, 0);
  const answers: Record<string, Answer> = Object.fromEntries(ids.map((q) => [q, { type: 'noul' as const, noul: worst[q]! }]));
  return { answers, model_answered: model, pieces: count, requests, usage };
}
