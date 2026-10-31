// The Tev1 seat: Tev1 through Ollama's decision endpoint on the person's own machine (moved from Part
// 1's Tev1Provider; ADR docs/plans/decision-service.md §2). Local only: an address that could be
// the internet is refused. Limits: at most 64 questions per request, about 2,000 tokens with the
// whole question set in every prompt, and 64 KiB; long state is chunked, every piece screened.
// Default size tev1:4b; tev1:0.8b only where memory requires. Unavailable, in plain words, below
// Ollama 0.40.4 (what the published models require), when unreachable, or when not downloaded.
import { modelMemory, privateAddress, gb, type Hardware } from '../../models/hardware.ts';
import { HEADROOM } from '../../models/recommend.ts';
import { askChunked, estimateTokens, PLAN_LIMITS, type PlanLimits } from '../chunk.ts';
import { body, ENDPOINT_SINCE, MAX_BODY_BYTES, MAX_QUESTIONS, older, SystemOne, TEV1_REQUIRES, SeatFailure, Unavailable, utf8, wireQuestions } from '../wire.ts';
import type { BuiltState, Seat, SeatAnswer, SeatLimits, SeatStatus, ServiceTemplate } from '../types.ts';
import type { Egress } from '../../workers.ts';

export const SEAT_ID = 'tev1';
export const SIZES = ['tev1:4b', 'tev1:0.8b'] as const;
export type Size = (typeof SIZES)[number];
// Download sizes from the registry manifests (2026-10-31), Q8_0.
export const SIZE_BYTES: Record<Size, number> = { 'tev1:4b': 4_610_582_112, 'tev1:0.8b': 833_594_080 };
export const CONTEXT_TOKENS = 2000;
export const SCORING_TOKENS = 2;
export const FRAMING_TOKENS = 96;

export interface Tev1Limits extends PlanLimits { contextTokens: number; maxBytes: number }
export const LIMITS: Tev1Limits = Object.freeze({ ...PLAN_LIMITS, contextTokens: CONTEXT_TOKENS, maxBytes: MAX_BODY_BYTES });

// Whether one request with this state fits both caps.
export function fits(model: string, state: Record<string, unknown>, questions: Record<string, unknown>, l: Tev1Limits = LIMITS): boolean {
  if (utf8(body(model, state, questions)) > l.maxBytes) return false;
  return estimateTokens(JSON.stringify(state)) + estimateTokens(JSON.stringify(questions)) + FRAMING_TOKENS + SCORING_TOKENS <= l.contextTokens;
}

export interface SizeChoice { model: Size | null; why: string }

export function chooseSize(h: Hardware | null): SizeChoice {
  if (!h) return { model: 'tev1:4b', why: 'Tev1 4B, the default (Nova hasn’t read this device’s hardware).' };
  const mem = modelMemory(h);
  const need = (s: Size) => SIZE_BYTES[s] * HEADROOM;
  if (need('tev1:4b') <= mem.bytes) return { model: 'tev1:4b', why: `Tev1 4B, the default: this device has ${gb(mem.bytes)} for models (${mem.words}).` };
  if (need('tev1:0.8b') <= mem.bytes) return { model: 'tev1:0.8b', why: `Tev1 0.8B: this device has ${gb(mem.bytes)} for models (${mem.words}), and Tev1 4B needs about ${gb(need('tev1:4b'))}.` };
  return { model: null, why: `This device has ${gb(mem.bytes)} for models (${mem.words}); even Tev1 0.8B needs about ${gb(need('tev1:0.8b'))}.` };
}

// Loopback, a private address or "localhost": Ollama on the person's own machines.
export function localUrl(url: string): boolean {
  const h = new URL(url).hostname.toLowerCase();
  return h === 'localhost' || privateAddress(h);
}

// The exact model a verdict is tied to: tag and registry digest.
export const modelId = (tag: string, digest: string) => `${tag}@${digest.replace(/^sha256:/, '')}`;

export interface Tev1Detail {
  available: boolean;
  model: Size | null;
  digest: string | null;
  ollama: string | null;
  size_why: string;
  why: string;
  checked_at: string | null;
}

export interface Tev1Options {
  // The Ollama on this device, or a function giving it now (the model manager's hubUrl()).
  url: string | (() => string);
  hardware?: () => Hardware | null | Promise<Hardware | null>;
  // A size the person chose (or the eval names), read each time; "auto" or none: from the hardware.
  model?: Size | (() => Size | 'auto' | null | undefined);
  limits?: Partial<Tev1Limits>;
  timeoutMs?: number;
  now?: () => Date;
  recheckMs?: number;
}

export class Tev1Seat implements Seat {
  readonly id = SEAT_ID;
  readonly egress: Egress = 'local';
  readonly tev1Limits: Tev1Limits;
  #o: Tev1Options;
  #client: SystemOne;
  #detail: Tev1Detail = { available: false, model: null, digest: null, ollama: null, size_why: '', why: 'Nova hasn’t checked for Tev1 yet.', checked_at: null };
  #checking: Promise<Tev1Detail> | null = null;
  #now: () => Date;

  constructor(o: Tev1Options) {
    this.#o = o;
    this.#client = this.#make(this.#url());
    this.tev1Limits = Object.freeze({ ...LIMITS, ...(o.limits ?? {}) });
    this.#now = o.now ?? (() => new Date());
  }

  #url(): string { return typeof this.#o.url === 'function' ? this.#o.url() : this.#o.url; }

  #make(url: string): SystemOne {
    if (!localUrl(url)) throw new Error(`Tev1 runs in Ollama on this device or the person’s own network; ${new URL(url).host} could be anywhere.`);
    return new SystemOne(url, { maxQuestions: MAX_QUESTIONS, maxBodyBytes: MAX_BODY_BYTES, ...(this.#o.timeoutMs ? { timeoutMs: this.#o.timeoutMs } : {}) });
  }

  get client(): SystemOne {
    const url = this.#url().replace(/\/+$/, '');
    if (url !== this.#client.url) this.#client = this.#make(url);
    return this.#client;
  }

  limits(): SeatLimits {
    return { maxQuestions: MAX_QUESTIONS, contextTokens: this.tev1Limits.contextTokens, perQuestionTokens: null, maxBodyBytes: this.tev1Limits.maxBytes, images: false, types: ['noul', 'choice', 'score'] };
  }

  detail(): Tev1Detail { return { ...this.#detail }; }

  status(): SeatStatus {
    const d = this.#detail;
    const at = d.checked_at ? Date.parse(d.checked_at) : 0;
    if (this.#now().getTime() - at > (this.#o.recheckMs ?? 60_000)) this.refresh().catch(() => {});
    return { available: d.available, model: d.model && d.digest ? modelId(d.model, d.digest) : d.model, why: d.why };
  }

  refresh(): Promise<SeatStatus> {
    this.#checking ??= this.#refresh().finally(() => { this.#checking = null; });
    return this.#checking.then((d) => ({ available: d.available, model: d.model && d.digest ? modelId(d.model, d.digest) : d.model, why: d.why }));
  }

  async #refresh(): Promise<Tev1Detail> {
    const at = this.#now().toISOString();
    let hw: Hardware | null = null;
    try { hw = (await this.#o.hardware?.()) ?? null; } catch { hw = null; }
    const chosen = typeof this.#o.model === 'function' ? this.#o.model() : this.#o.model;
    const size: SizeChoice = chosen && chosen !== 'auto' ? { model: chosen, why: `Tev1 ${chosen.slice(5).toUpperCase()}, chosen in Settings › Models.` } : chooseSize(hw);
    const down = (why: string, ollama: string | null = null): Tev1Detail => (this.#detail = { available: false, model: size.model, digest: null, ollama, size_why: size.why, why, checked_at: at });
    let client: SystemOne;
    try { client = this.client; } catch (e) { return down((e as Error).message); }
    let version: string;
    try { version = await client.version(); } catch (e) { return down((e as Error).message); }
    if (older(version, ENDPOINT_SINCE)) return down(`This Ollama is version ${version}. Decision models need Ollama ${ENDPOINT_SINCE.replace(/\.0$/, '')} or later, and Tev1’s published models need ${TEV1_REQUIRES} or later; update Ollama to use Tev1.`, version);
    if (older(version, TEV1_REQUIRES)) return down(`This Ollama is version ${version}. Tev1’s published models need Ollama ${TEV1_REQUIRES} or later; update Ollama to use Tev1.`, version);
    if (!size.model) return down(size.why, version);
    let have;
    try { have = (await client.installed()).find((m) => m.name === size.model); } catch (e) { return down((e as Error).message, version); }
    if (!have) return down(`Tev1 (${size.model}) isn’t downloaded in Ollama at ${client.host}.`, version);
    return (this.#detail = { available: true, model: size.model, digest: have.digest.replace(/^sha256:/, ''), ollama: version, size_why: size.why, why: size.why, checked_at: at });
  }

  async ask(t: ServiceTemplate, built: BuiltState, o: { beforeSend?: () => void } = {}): Promise<SeatAnswer> {
    const d = this.#detail;
    if (!d.available || !d.model) throw new Unavailable(d.why);
    const ids = Object.keys(t.questions);
    if (ids.length > MAX_QUESTIONS) throw new SeatFailure(`${t.template_id} has ${ids.length} questions; one Tev1 request takes at most ${MAX_QUESTIONS}.`);
    if (Object.keys(built.images).length || Object.values(t.questions).some((q) => q.type === 'box')) throw new SeatFailure('Tev1 reads no images.');
    const model = d.model;
    const wq = wireQuestions(t.questions);
    const client = this.client;
    const a = await askChunked({
      t, built, limits: this.tev1Limits,
      fits: (state) => fits(model, state, wq, this.tev1Limits),
      ask: (state) => { o.beforeSend?.(); return client.ask(model, state, t.questions); },
    });
    // Which build answered: Ollama names only the tag, so the digest is read again AFTER the answer.
    // A build swapped since the last check answers as tag@new-digest, which the service's pin
    // (tag@digest asked) refuses; the seat's own record moves to the new build at once.
    let now: string | null = null;
    try { now = (await client.installed()).find((m) => m.name === model)?.digest.replace(/^sha256:/, '') ?? null; } catch { now = null; }
    if (now && now !== this.#detail.digest && this.#detail.model === model) this.#detail = { ...this.#detail, digest: now, checked_at: this.#now().toISOString() };
    return { ...a, model_answered: now ? modelId(model, now) : `${model}@unconfirmed` };
  }
}
