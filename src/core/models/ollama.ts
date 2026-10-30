// The Ollama runtime adapter (M6 plan §2): what Nova asks a local Ollama, over its own API. Plain
// fetch, no redirects (what Nova sends goes only to the address it checked), and every failure in
// words. A runtime that can't be reached throws RuntimeDown, which the model manager treats as
// "local capacity is missing" rather than as a bug.
import { NO_REDIRECT, reachProblem } from '../providers/types.ts';

export class RuntimeDown extends Error {
  constructor(message: string) { super(message); this.name = 'RuntimeDown'; }
}

export interface InstalledModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
  family: string;
  parameter_size: string;
  // Billions of parameters, read from parameter_size ("8.2B", "137M"); null when unsaid.
  params_b: number | null;
  quantization: string;
  capabilities: string[];
}

export interface PullProgress { status: string; digest?: string; total?: number; completed?: number }
export interface Message { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatOut { text: string; aborted: boolean; usage: { tokens_in?: number; tokens_out?: number } }

export function paramsB(s: unknown): number | null {
  const m = /^([\d.]+)\s*([BMK])/i.exec(String(s ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return m[2]!.toUpperCase() === 'B' ? n : m[2]!.toUpperCase() === 'M' ? n / 1000 : n / 1e6;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function toInstalled(m: Record<string, any>): InstalledModel {
  const d = isObj(m.details) ? m.details : {};
  return {
    name: String(m.name ?? m.model ?? ''), size: Number(m.size) || 0, digest: String(m.digest ?? ''), modified_at: String(m.modified_at ?? ''),
    family: String(d.family ?? ''), parameter_size: String(d.parameter_size ?? ''), params_b: paramsB(d.parameter_size), quantization: String(d.quantization_level ?? ''),
    capabilities: Array.isArray(m.capabilities) ? m.capabilities.map(String) : [],
  };
}

export class Ollama {
  readonly url: string;
  readonly host: string;
  #timeoutMs: number;

  constructor(url: string, o: { timeoutMs?: number } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.host = new URL(this.url).host;
    this.#timeoutMs = o.timeoutMs ?? 600_000;
  }

  async #fetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? 5000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      return await fetch(`${this.url}${path}`, { ...init, ...NO_REDIRECT, signal, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    } catch (e) {
      if (init.signal?.aborted) throw e;
      if (timeout.aborted) throw new RuntimeDown(`Ollama at ${this.host} didn’t answer in time.`);
      throw new RuntimeDown(`Nova couldn’t reach Ollama at ${this.host}: ${reachProblem(e)}.`);
    }
  }

  async #json<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const res = await this.#fetch(path, init);
    const body = await res.text().catch(() => '');
    if (!res.ok) throw new Error(errorText(res.status, body, this.host));
    try { return JSON.parse(body) as T; } catch { throw new Error(`Ollama at ${this.host} sent something Nova couldn’t read.`); }
  }

  async version(signal?: AbortSignal): Promise<string> {
    const v = await this.#json<{ version?: string }>('/api/version', { ...(signal ? { signal } : {}), timeoutMs: 3000 });
    return String(v.version ?? 'unknown');
  }

  async tags(): Promise<InstalledModel[]> {
    const v = await this.#json<{ models?: unknown[] }>('/api/tags');
    return (Array.isArray(v.models) ? v.models : []).filter(isObj).map(toInstalled).filter((m) => m.name);
  }

  async ps(): Promise<string[]> {
    const v = await this.#json<{ models?: unknown[] }>('/api/ps');
    return (Array.isArray(v.models) ? v.models : []).filter(isObj).map((m) => String(m.name ?? m.model ?? '')).filter(Boolean);
  }

  async show(name: string): Promise<{ capabilities: string[]; details: Record<string, unknown> } | null> {
    const res = await this.#fetch('/api/show', { method: 'POST', body: JSON.stringify({ model: name }) });
    if (res.status === 404) return null;
    const body = await res.text().catch(() => '');
    if (!res.ok) throw new Error(errorText(res.status, body, this.host));
    const j = JSON.parse(body) as Record<string, unknown>;
    return { capabilities: Array.isArray(j.capabilities) ? j.capabilities.map(String) : [], details: isObj(j.details) ? j.details : {} };
  }

  // Streams Ollama's progress lines to onProgress; resolves once it says success. An error line,
  // or a stream that ends without success, throws in words.
  async pull(name: string, onProgress: (p: PullProgress) => void, signal: AbortSignal): Promise<void> {
    const res = await this.#fetch('/api/pull', { method: 'POST', body: JSON.stringify({ model: name, stream: true }), signal, timeoutMs: 24 * 3600_000 });
    if (!res.ok) throw new Error(errorText(res.status, await res.text().catch(() => ''), this.host));
    let ok = false;
    for await (const line of ndjson(res, signal)) {
      if (typeof line.error === 'string') throw new Error(`Ollama couldn’t download ${name}: ${line.error}`);
      const p: PullProgress = { status: String(line.status ?? '') };
      if (typeof line.digest === 'string') p.digest = line.digest;
      if (typeof line.total === 'number') p.total = line.total;
      if (typeof line.completed === 'number') p.completed = line.completed;
      onProgress(p);
      if (p.status === 'success') ok = true;
    }
    if (!ok) throw new Error(`The download of ${name} ended before Ollama said it was complete.`);
  }

  async remove(name: string): Promise<boolean> {
    const res = await this.#fetch('/api/delete', { method: 'DELETE', body: JSON.stringify({ model: name }) });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(errorText(res.status, await res.text().catch(() => ''), this.host));
    return true;
  }

  // A streamed chat. `format` is a JSON schema the reply must follow (Ollama's structured output).
  // `think: false` turns a thinking model's reasoning off: with a schema to follow, a thinking model
  // otherwise spends its answer reasoning and the reply can miss the schema. Sent only to a model
  // that says it thinks (Ollama refuses the field elsewhere).
  async chat(o: { model: string; messages: Message[]; format?: Record<string, unknown> | 'json'; think?: boolean; signal?: AbortSignal; onText?: (t: string) => void; keepAlive?: string }): Promise<ChatOut> {
    const body = { model: o.model, messages: o.messages, stream: true, ...(o.format ? { format: o.format, options: { temperature: 0 } } : {}), ...(o.think !== undefined ? { think: o.think } : {}), ...(o.keepAlive ? { keep_alive: o.keepAlive } : {}) };
    let res: Response;
    try {
      res = await this.#fetch('/api/chat', { method: 'POST', body: JSON.stringify(body), timeoutMs: this.#timeoutMs, ...(o.signal ? { signal: o.signal } : {}) });
    } catch (e) {
      if (o.signal?.aborted) return { text: '', aborted: true, usage: {} };
      throw e;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // A model that isn't there is a capacity problem too: the role points at nothing.
      if (res.status === 404) throw new RuntimeDown(errorText(res.status, text, this.host));
      throw new Error(errorText(res.status, text, this.host));
    }
    let text = '';
    const usage: ChatOut['usage'] = {};
    let done = false;
    try {
      for await (const line of ndjson(res, o.signal)) {
        if (typeof line.error === 'string') throw new Error(`Ollama at ${this.host}: ${line.error}`);
        const piece = line.message?.content;
        if (typeof piece === 'string' && piece) { text += piece; o.onText?.(piece); }
        if (line.done === true) {
          done = true;
          if (typeof line.prompt_eval_count === 'number') usage.tokens_in = line.prompt_eval_count;
          if (typeof line.eval_count === 'number') usage.tokens_out = line.eval_count;
        }
      }
    } catch (e) {
      if (o.signal?.aborted) return { text, aborted: true, usage };
      if (e instanceof RuntimeDown || (e as Error).message.startsWith('Ollama at')) throw e;
      throw new RuntimeDown(`The connection to Ollama at ${this.host} broke off: ${(e as Error).message}.`);
    }
    if (!done) throw new RuntimeDown(`Ollama at ${this.host} stopped before the reply finished.`);
    return { text, aborted: false, usage };
  }

  async embed(model: string, input: string | string[]): Promise<{ embeddings: number[][]; tokens_in?: number }> {
    const res = await this.#fetch('/api/embed', { method: 'POST', body: JSON.stringify({ model, input }), timeoutMs: 120_000 });
    const body = await res.text().catch(() => '');
    if (res.status === 404) throw new RuntimeDown(errorText(res.status, body, this.host));
    if (!res.ok) throw new Error(errorText(res.status, body, this.host));
    const j = JSON.parse(body) as { embeddings?: number[][]; prompt_eval_count?: number };
    return { embeddings: Array.isArray(j.embeddings) ? j.embeddings : [], ...(typeof j.prompt_eval_count === 'number' ? { tokens_in: j.prompt_eval_count } : {}) };
  }
}

function errorText(status: number, body: string, host: string): string {
  let detail = body.trim();
  try { const j = JSON.parse(body) as { error?: unknown }; if (typeof j.error === 'string') detail = j.error; } catch { /* plain text */ }
  detail = detail.slice(0, 300);
  if (status === 404) return `Ollama at ${host} doesn’t have that model${detail ? ` (${detail})` : ''}.`;
  return `Ollama at ${host} answered ${status}${detail ? `: ${detail}` : ''}.`;
}

async function* ndjson(res: Response, signal?: AbortSignal): AsyncGenerator<Record<string, any>> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    if (signal?.aborted) return;
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { yield JSON.parse(line) as Record<string, any>; } catch { throw new Error('a progress line Nova couldn’t read'); }
    }
  }
  if (buf.trim()) { try { yield JSON.parse(buf) as Record<string, any>; } catch { /* a cut-off last line */ } }
}
