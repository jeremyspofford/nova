// The TypeSafe Jev API client, for both the cloud seat (api.typesafe.ai) and Tev1 through Ollama
// (moved from Part 1's systemone.ts; ADR docs/plans/decision-service.md §2). Read from TypeSafe's
// OpenAPI spec and docs and from Ollama's API reference, 2026-10-31; nothing here is guessed:
//
//   POST /v1/systemone {model, state, questions: {<name>: {type, instructions, criteria?}}, assets?}
//     → {model, answers: {<name>: <typed answer>}, usage: {input_tokens, output_tokens}}
//
// Noul → {noul}; Choice → {choice, probabilities, confidence}; Score → {score, probabilities,
// confidence}; Box → {box: {top, bottom, left, right}, confidence|null}. Images go in `assets` as
// {type: "image", format, data_base64}, referenced from the state, and need the header
// TypeSafe-Danger-Zone-Images: true, as do Box questions. The long-context header is never sent.
//
// This is the ONLY file in src/ that names the endpoint (the boundary test checks it). Plain fetch,
// no redirects, one call is one request, answers read strictly, every failure in words.
import { NO_REDIRECT, reachProblem } from '../providers/types.ts';
import type { Answer, Question } from './types.ts';

export const SYSTEMONE_PATH = '/v1/systemone';
export const IMAGES_HEADER = 'TypeSafe-Danger-Zone-Images';
// Ollama's limits for a local decision model (its API reference).
export const MAX_QUESTIONS = 64;
export const MAX_BODY_BYTES = 64 * 1024;
// TypeSafe's request rule: a body of at most 32 MiB.
export const JEV_MAX_BODY_BYTES = 32 * 1024 * 1024;
// The endpoint arrived in Ollama 0.35; the published Tev1 builds require 0.40.4.
export const ENDPOINT_SINCE = '0.35.0';
export const TEV1_REQUIRES = '0.40.4';

export type State = string | Record<string, unknown> | unknown[];
export interface WireImage { format: 'png' | 'jpg'; data: Uint8Array }
export interface Asked { answers: Record<string, Answer>; model: string; usage: { input_tokens: number | null; output_tokens: number | null }; ms: number; bytes: number }
export interface InstalledTev1 { name: string; digest: string; size: number }

// Can't be reached, too old, busy, or refuses the key or the model: the seat is missing for now.
export class Unavailable extends Error {
  constructor(message: string) { super(message); this.name = 'Unavailable'; }
}
// Longer than the model or the endpoint takes.
export class TooLong extends Error {
  constructor(message: string) { super(message); this.name = 'TooLong'; }
}
// A request that failed, in Nova's own words: a status and a fixed reason. Never what the other
// side sent back, which may echo the state (content) it was given.
export class SeatFailure extends Error {
  constructor(message: string) { super(message); this.name = 'SeatFailure'; }
}
// A model name as an answer gives it, kept only when it looks like one (it goes into records).
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
export const modelName = (v: unknown): string => (typeof v === 'string' && MODEL_NAME.test(v) ? v : '');

export const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8');

export function body(model: string, state: State, questions: Record<string, unknown>, o: { keepAlive?: string; assets?: Record<string, unknown> } = {}): string {
  return JSON.stringify({ model, state, questions, ...(o.assets ? { assets: o.assets } : {}), ...(o.keepAlive ? { keep_alive: o.keepAlive } : {}) });
}

// What goes on the wire for a question: the service's own fields (a Box's companion, a Noul's
// escapes) stay home.
export function wireQuestions(qs: Record<string, Question>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(qs).map(([k, q]) => {
    if (q.type === 'box') return [k, { type: 'box', instructions: q.instructions }];
    if (q.type === 'noul') return [k, { type: 'noul', instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) }];
    return [k, q];
  }));
}

// a < b for dotted versions ("0.40.0" < "0.40.4"); pre-release suffixes are ignored.
export function older(a: string, b: string): boolean {
  const n = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0]!.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const x = n(a), y = n(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const prob = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const probs = (v: unknown, keys: string[]): v is Record<string, number> => isObj(v) && keys.every((k) => prob(v[k]));

// One answer, read against its question. Null when it doesn't fit: nothing is repaired.
export function readAnswer(q: Question, a: unknown): Answer | null {
  if (!isObj(a) || a.type !== q.type) return null;
  if (q.type === 'noul') return prob(a.noul) ? { type: 'noul', noul: a.noul } : null;
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria);
    return typeof a.choice === 'string' && keys.includes(a.choice) && probs(a.probabilities, keys) && prob(a.confidence)
      ? { type: 'choice', choice: a.choice, probabilities: Object.fromEntries(keys.map((k) => [k, (a.probabilities as Record<string, number>)[k]!])), confidence: a.confidence } : null;
  }
  if (q.type === 'score') {
    const keys = q.criteria.map((_, i) => String(i));
    return typeof a.score === 'number' && Number.isFinite(a.score) && a.score >= 0 && a.score <= q.criteria.length - 1 && probs(a.probabilities, keys) && prob(a.confidence)
      ? { type: 'score', score: a.score, probabilities: Object.fromEntries(keys.map((k) => [k, (a.probabilities as Record<string, number>)[k]!])), confidence: a.confidence } : null;
  }
  const b = a.box;
  if (!isObj(b) || !['top', 'bottom', 'left', 'right'].every((k) => prob(b[k])) || !((b.left as number) < (b.right as number)) || !((b.top as number) < (b.bottom as number))) return null;
  if (!(a.confidence === null || a.confidence === undefined || prob(a.confidence))) return null;
  return { type: 'box', box: { top: b.top as number, bottom: b.bottom as number, left: b.left as number, right: b.right as number }, confidence: prob(a.confidence) ? a.confidence : null };
}

export interface ClientOptions {
  timeoutMs?: number;
  // The bearer key, read at call time (the cloud seat); never logged.
  key?: () => string | null;
  maxQuestions?: number | null;
  maxBodyBytes?: number;
}

export class SystemOne {
  readonly url: string;
  readonly host: string;
  #o: ClientOptions;

  constructor(url: string, o: ClientOptions = {}) {
    this.url = url.replace(/\/+$/, '');
    this.host = new URL(this.url).host;
    this.#o = o;
  }

  async #fetch(path: string, init: { method: string; body?: string; headers?: Record<string, string> }, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(`${this.url}${path}`, { ...init, ...NO_REDIRECT, signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    } catch (e) {
      if ((e as Error)?.name === 'TimeoutError') throw new Unavailable(`${this.host} didn’t answer in time.`);
      throw new Unavailable(`Nova couldn’t reach ${this.host}: ${reachProblem(e)}.`);
    }
  }

  // Ollama only: its version and the Tev1 builds it has.
  async version(): Promise<string> {
    const res = await this.#fetch('/api/version', { method: 'GET' }, 3000);
    const j = await res.json().catch(() => ({})) as { version?: unknown };
    if (!res.ok || typeof j.version !== 'string') throw new Unavailable(`Ollama at ${this.host} didn’t say which version it is.`);
    return j.version;
  }

  async installed(): Promise<InstalledTev1[]> {
    const res = await this.#fetch('/api/tags', { method: 'GET' }, 5000);
    const j = await res.json().catch(() => ({})) as { models?: unknown };
    if (!res.ok) throw new Unavailable(`Ollama at ${this.host} didn’t list its models (${res.status}).`);
    return (Array.isArray(j.models) ? j.models : []).filter(isObj)
      .map((m) => ({ name: String(m.name ?? m.model ?? ''), digest: String(m.digest ?? ''), size: Number(m.size) || 0 }))
      .filter((m) => /^tev1:/.test(m.name));
  }

  // One request carrying every question about one state. Refused before sending when it couldn't
  // be valid; each answer is read against its question, and anything that doesn't fit fails it.
  async ask(model: string, state: State, questions: Record<string, Question>, o: { keepAlive?: string; images?: Record<string, WireImage> } = {}): Promise<Asked> {
    const names = Object.keys(questions);
    if (!names.length) throw new SeatFailure('A decision request needs at least one question.');
    const max = this.#o.maxQuestions === undefined ? MAX_QUESTIONS : this.#o.maxQuestions;
    if (max !== null && names.length > max) throw new SeatFailure(`A decision request here takes at most ${max} questions; this one has ${names.length}.`);
    const images = o.images ?? {};
    const assets = Object.keys(images).length ? Object.fromEntries(Object.entries(images).map(([ref, im]) => [ref, { type: 'image', format: im.format, data_base64: Buffer.from(im.data).toString('base64') }])) : undefined;
    const text = body(model, state, wireQuestions(questions), { ...(o.keepAlive ? { keepAlive: o.keepAlive } : {}), ...(assets ? { assets } : {}) });
    const bytes = utf8(text);
    const cap = this.#o.maxBodyBytes ?? MAX_BODY_BYTES;
    if (bytes > cap) throw new TooLong(`This decision request is ${bytes} bytes; ${this.host} takes at most ${cap}.`);
    const headers: Record<string, string> = {};
    const key = this.#o.key?.() ?? null;
    if (key) headers.authorization = `Bearer ${key}`;
    if (assets || Object.values(questions).some((q) => q.type === 'box')) headers[IMAGES_HEADER] = 'true';
    const started = performance.now();
    const res = await this.#fetch(SYSTEMONE_PATH, { method: 'POST', body: text, headers }, this.#o.timeoutMs ?? 120_000);
    const raw = await res.text().catch(() => '');
    let j: unknown;
    try { j = JSON.parse(raw); } catch { j = null; }
    // What the other side said is read only to classify the failure, and never kept: it may echo
    // the state it was sent.
    const said = (isObj(j) && typeof j.error === 'string' ? j.error : isObj(j) && typeof j.detail === 'string' ? j.detail : raw.trim()).slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new Unavailable(`${this.host} refused Nova’s key (${res.status}).`);
    if (res.status === 404) throw new Unavailable(`${this.host} doesn’t have ${model} (404).`);
    if (res.status === 405) throw new Unavailable(`${this.host} has no decision-model endpoint.`);
    if (res.status === 429 || res.status === 529) throw new Unavailable(`${this.host} is busy (${res.status}); Nova will ask again later.`);
    if (res.status === 413 || (res.status === 400 && /context|max_tokens_exceeded|too long|exceed|token/i.test(said))) throw new TooLong(`${this.host} said the request is too long (${res.status}).`);
    if (!res.ok) throw new SeatFailure(`${this.host} answered ${res.status}: ${res.status === 422 ? 'it refused the request as invalid' : res.status >= 500 ? 'it failed on its side' : 'it refused the request'}.`);
    if (!isObj(j) || !isObj(j.answers)) throw new SeatFailure(`${this.host} sent a decision without answers.`);
    const answers: Record<string, Answer> = {};
    const problems: string[] = [];
    for (const n of names) {
      const a = readAnswer(questions[n]!, j.answers[n]);
      if (a) answers[n] = a; else problems.push(n);
    }
    if (problems.length) throw new SeatFailure(`${this.host} didn’t answer ${problems.length} of the questions in the question’s own type.`);
    const u = isObj(j.usage) ? j.usage : {};
    return {
      answers,
      model: modelName(j.model),
      usage: { input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : null, output_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : null },
      ms: performance.now() - started,
      bytes,
    };
  }
}
