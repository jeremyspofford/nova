// A client for the TypeSafe Jev API as Ollama serves it at /v1/systemone (docs/plans/tev1.md, "The
// API, as found"). Read from the running Ollama, its API reference (docs.ollama.com/api/systemone),
// the Tev1 model card and the registry on 2026-10-31; nothing here is guessed:
//
//   POST /v1/systemone {model, state, questions: {<name>: {type: "noul", instructions, criteria?}}}
//     → {model, answers: {<name>: {type: "noul", noul: P(true)}}, usage: {input_tokens, output_tokens}}
//
// 1 to 64 questions per request; local text and schema up to 64 KiB (413 above); a prompt longer
// than the loaded context is a 400, never truncated; 404 is a model that isn't downloaded.
//
// Plain fetch, no redirects (what Nova sends goes only to the address it checked), and every
// failure in words. One call to `ask` is exactly one request.
import { NO_REDIRECT, reachProblem } from '../providers/types.ts';

export const SYSTEMONE_PATH = '/v1/systemone';
export const MAX_QUESTIONS = 64;
export const MAX_BODY_BYTES = 64 * 1024;
// The endpoint arrived in Ollama 0.35 (the amendment's figure).
export const ENDPOINT_SINCE = '0.35.0';
// What the published tev1:4b and tev1:0.8b builds require (their registry configs, 2026-10-31):
// an older Ollama refuses to pull them.
export const TEV1_REQUIRES = '0.40.4';

export interface NoulQuestion { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
export type State = string | Record<string, unknown> | unknown[];
export interface Asked { answers: Record<string, number>; usage: { input_tokens: number | null; output_tokens: number | null }; ms: number; bytes: number }
export interface InstalledTev1 { name: string; digest: string; size: number }

// Ollama can't be reached, is too old, or doesn't have the model: local capacity is missing.
export class Unavailable extends Error {
  constructor(message: string) { super(message); this.name = 'Unavailable'; }
}
// The request is longer than the model or the endpoint takes.
export class TooLong extends Error {
  constructor(message: string) { super(message); this.name = 'TooLong'; }
}

export const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8');

export function body(model: string, state: State, questions: Record<string, NoulQuestion>, keepAlive?: string): string {
  return JSON.stringify({ model, state, questions, ...(keepAlive ? { keep_alive: keepAlive } : {}) });
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

export class SystemOne {
  readonly url: string;
  readonly host: string;
  #timeoutMs: number;

  constructor(url: string, o: { timeoutMs?: number } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.host = new URL(this.url).host;
    this.#timeoutMs = o.timeoutMs ?? 120_000;
  }

  async #fetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(`${this.url}${path}`, { ...init, ...NO_REDIRECT, signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json' } });
    } catch (e) {
      if ((e as Error)?.name === 'TimeoutError') throw new Unavailable(`Ollama at ${this.host} didn’t answer in time.`);
      throw new Unavailable(`Nova couldn’t reach Ollama at ${this.host}: ${reachProblem(e)}.`);
    }
  }

  async version(): Promise<string> {
    const res = await this.#fetch('/api/version', { method: 'GET' }, 3000);
    const j = await res.json().catch(() => ({})) as { version?: unknown };
    if (!res.ok || typeof j.version !== 'string') throw new Unavailable(`Ollama at ${this.host} didn’t say which version it is.`);
    return j.version;
  }

  // The Tev1 builds this Ollama has, with their digests.
  async installed(): Promise<InstalledTev1[]> {
    const res = await this.#fetch('/api/tags', { method: 'GET' }, 5000);
    const j = await res.json().catch(() => ({})) as { models?: unknown };
    if (!res.ok) throw new Unavailable(`Ollama at ${this.host} didn’t list its models (${res.status}).`);
    return (Array.isArray(j.models) ? j.models : []).filter(isObj)
      .map((m) => ({ name: String(m.name ?? m.model ?? ''), digest: String(m.digest ?? ''), size: Number(m.size) || 0 }))
      .filter((m) => /^tev1:/.test(m.name));
  }

  // One request carrying every question about one state. Refused before sending when it couldn't
  // be valid; the answer is read strictly, and anything missing or out of range fails the call.
  async ask(model: string, state: State, questions: Record<string, NoulQuestion>, o: { keepAlive?: string } = {}): Promise<Asked> {
    const names = Object.keys(questions);
    if (!names.length) throw new Error('A decision request needs at least one question.');
    if (names.length > MAX_QUESTIONS) throw new Error(`A decision request takes at most ${MAX_QUESTIONS} questions; this one has ${names.length}.`);
    const text = body(model, state, questions, o.keepAlive);
    const bytes = utf8(text);
    if (bytes > MAX_BODY_BYTES) throw new TooLong(`This decision request is ${bytes} bytes; Ollama takes at most ${MAX_BODY_BYTES}.`);
    const started = performance.now();
    const res = await this.#fetch(SYSTEMONE_PATH, { method: 'POST', body: text }, this.#timeoutMs);
    const raw = await res.text().catch(() => '');
    let j: unknown;
    try { j = JSON.parse(raw); } catch { j = null; }
    const said = isObj(j) && typeof j.error === 'string' ? j.error.slice(0, 300) : raw.trim().slice(0, 300);
    if (res.status === 404) throw new Unavailable(`Ollama at ${this.host} doesn’t have ${model}${said ? ` (${said})` : ''}.`);
    if (res.status === 413 || (res.status === 400 && /context|too long|exceed|token/i.test(said))) throw new TooLong(`Ollama at ${this.host} said the request is too long: ${said}`);
    if (res.status === 405) throw new Unavailable(`Ollama at ${this.host} has no decision-model endpoint (it needs ${ENDPOINT_SINCE} or later).`);
    if (!res.ok) throw new Error(`Ollama at ${this.host} answered ${res.status}${said ? `: ${said}` : ''}.`);
    if (!isObj(j) || !isObj(j.answers)) throw new Error(`Ollama at ${this.host} sent a decision without answers.`);
    const answers: Record<string, number> = {};
    const problems: string[] = [];
    for (const n of names) {
      const a = j.answers[n];
      const p = isObj(a) ? a.noul : undefined;
      if (!isObj(a) || a.type !== 'noul' || typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) problems.push(n);
      else answers[n] = p;
    }
    if (problems.length) throw new Error(`Ollama at ${this.host} didn’t answer ${problems.join(', ')} as a probability.`);
    const u = isObj(j.usage) ? j.usage : {};
    return {
      answers,
      usage: { input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : null, output_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : null },
      ms: performance.now() - started,
      bytes,
    };
  }
}
