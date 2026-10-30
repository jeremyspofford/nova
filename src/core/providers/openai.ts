// The OpenAI-compatible chat provider, ported from Era 1 (6e2cf142,
// packages/providers/src/{sse,openai-compatible}.ts): plain `fetch` and Server-Sent Events, a base
// URL and a model, and a key from the vault when the server needs one. One adapter serves Ollama's
// /v1, llama.cpp, LM Studio and hosted compatible APIs. Era 1's tools, images and model catalogue
// aren't needed here and stayed behind.
import { CoreError } from '../errors.ts';
import { NO_REDIRECT, num, reachProblem, secretName, str, type ChatRequest, type Config, type Impl, type Usage, type WorkInput, type WorkOutcome } from './types.ts';

// The Ollama profile: what a fresh Nova points at.
export const OLLAMA_BASE = 'http://127.0.0.1:11434/v1';

// Incremental Server-Sent Events parser (WHATWG event stream), reduced to what model streams use:
// `data:` fields joined per event; comments and other fields ignored.
export class SseParser {
  #buf = '';
  #data: string[] = [];

  push(text: string): string[] {
    this.#buf += text;
    const out: string[] = [];
    for (;;) {
      const i = this.#buf.search(/[\r\n]/);
      if (i < 0) break;
      // A lone CR at the end may be the first half of CRLF: wait for the next chunk.
      if (this.#buf[i] === '\r' && i === this.#buf.length - 1) break;
      const eol = this.#buf[i] === '\r' && this.#buf[i + 1] === '\n' ? 2 : 1;
      const line = this.#buf.slice(0, i);
      this.#buf = this.#buf.slice(i + eol);
      this.#line(line, out);
    }
    return out;
  }

  end(): string[] {
    const out: string[] = [];
    if (this.#buf) this.#line(this.#buf.replace(/\r$/, ''), out);
    this.#buf = '';
    if (this.#data.length) out.push(this.#data.join('\n'));
    this.#data = [];
    return out;
  }

  #line(line: string, out: string[]): void {
    if (line === '') {
      if (this.#data.length) out.push(this.#data.join('\n'));
      this.#data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== 'data') return;
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.#data.push(value);
  }
}

// A bare local server address gets the /v1 path its OpenAI-style API lives at.
export function normalizeBase(raw: string): string {
  const u = new URL(raw);
  let path = u.pathname.replace(/\/+$/, '');
  if (!path && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) path = '/v1';
  return `${u.origin}${path}`;
}

// A key must never show in an error a person sees.
const scrub = (text: string, key: string | null) => (key ? text.split(key).join('[key]') : text);

// The provider's error, in plain words (Era 1's mapping, cut down).
export function httpProblem(status: number, body: string, host: string, hadKey: boolean): string {
  let detail = body.trim();
  try {
    const v = JSON.parse(body) as { error?: unknown };
    if (typeof v.error === 'string') detail = v.error;
    else if (v.error && typeof v.error === 'object' && typeof (v.error as { message?: unknown }).message === 'string') detail = (v.error as { message: string }).message;
  } catch { /* not JSON: keep the text */ }
  detail = detail.slice(0, 300);
  const said = detail ? ` (${detail})` : '';
  if (status === 401 || status === 403) return hadKey ? `${host} turned down the key${said}.` : `${host} needs a key${said}; add one in the vault and name it in the settings.`;
  if (status === 404) return `${host} doesn’t have that model or address${said}.`;
  if (status === 429) return `${host} is limiting requests right now${said}.`;
  if (status >= 500) return `${host} had a problem of its own (${status})${said}.`;
  return `${host} refused the request (${status})${said}.`;
}

interface Resolved { base: string; host: string; model: string; key: string | null; timeoutMs: number }

function resolveCfg(c: Config, secret: (v: unknown) => string | null): Resolved {
  const base = normalizeBase(str(c.base_url));
  const key = c.api_key ? secret(c.api_key) : null;
  if (c.api_key && !key) throw new CoreError('validation', `The key ${secretName(c.api_key)} isn’t in the vault.`);
  return { base, host: new URL(base).host, model: str(c.model), key, timeoutMs: num(c.timeout_s, 600) * 1000 };
}

// One streamed chat completion. Text arrives through onText as it streams; the whole text,
// whether it was stopped, and the usage come back at the end. Failures throw, in plain words.
async function complete(r: Resolved, body: Record<string, unknown>, req: { signal?: AbortSignal; onText?: (t: string) => void }): Promise<{ text: string; aborted: boolean; usage: Usage }> {
  const timeout = AbortSignal.timeout(r.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const usage: Usage = { model: r.model };
  let text = '';
  let res: Response;
  try {
    res = await fetch(`${r.base}/chat/completions`, {
      method: 'POST', signal, ...NO_REDIRECT,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(r.key ? { authorization: `Bearer ${r.key}` } : {}) },
      body: JSON.stringify({ model: r.model, stream: true, stream_options: { include_usage: true }, ...body }),
    });
  } catch (e) {
    if (req.signal?.aborted) return { text, aborted: true, usage };
    if (timeout.aborted) throw new CoreError('conflict', `${r.host} didn’t answer within ${Math.round(r.timeoutMs / 1000)} s.`);
    throw new CoreError('conflict', `Nova couldn’t reach ${r.host}: ${scrub(reachProblem(e), r.key)}.`);
  }
  if (!res.ok) throw new CoreError('conflict', scrub(httpProblem(res.status, (await res.text().catch(() => '')).slice(0, 2000), r.host, !!r.key), r.key));
  const parser = new SseParser();
  const decoder = new TextDecoder();
  let done = false;
  let finish: string | null = null;
  const take = (data: string) => {
    if (data === '[DONE]') { done = true; return; }
    let ev: Record<string, any>;
    try { ev = JSON.parse(data); } catch { throw new CoreError('conflict', `${r.host} sent a stream event Nova couldn’t read.`); }
    if (ev.error) throw new CoreError('conflict', scrub(httpProblem(0, JSON.stringify(ev), r.host, !!r.key), r.key));
    if (typeof ev.model === 'string') usage.model = ev.model;
    const choice = Array.isArray(ev.choices) ? ev.choices[0] : undefined;
    const piece = choice?.delta?.content;
    if (typeof piece === 'string' && piece) { text += piece; req.onText?.(piece); }
    if (typeof choice?.finish_reason === 'string' && choice.finish_reason) finish = choice.finish_reason;
    if (typeof ev.usage?.prompt_tokens === 'number') usage.tokens_in = ev.usage.prompt_tokens;
    if (typeof ev.usage?.completion_tokens === 'number') usage.tokens_out = ev.usage.completion_tokens;
  };
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      for (const data of parser.push(decoder.decode(chunk, { stream: true }))) take(data);
      if (done) break;
    }
    for (const data of parser.end()) take(data);
  } catch (e) {
    if (req.signal?.aborted) return { text, aborted: true, usage };
    if (e instanceof CoreError) throw e;
    if (timeout.aborted) throw new CoreError('conflict', `${r.host} didn’t finish within ${Math.round(r.timeoutMs / 1000)} s.`);
    throw new CoreError('conflict', `The connection to ${r.host} broke off: ${(e as Error).message}.`);
  }
  if (!done && finish === null) throw new CoreError('conflict', `The connection to ${r.host} closed before the reply finished.`);
  if (finish === 'length') throw new CoreError('conflict', `${r.model} ran out of room before finishing its reply.`);
  return { text, aborted: false, usage };
}

// A chat with a whole message list, for the model manager (models/index.ts): its cloud fallback and
// a role served by an OpenAI-compatible runtime. `json` asks for a JSON object back.
// `max_tokens` bounds the reply, so what a call can cost is known before it is made.
export async function chatMessages(c: Config, secret: (v: unknown) => string | null, messages: { role: string; content: string }[], req: { signal?: AbortSignal; onText?: (t: string) => void; json?: boolean; max_tokens?: number } = {}): Promise<{ text: string; aborted: boolean; usage: Usage }> {
  return complete(resolveCfg(c, secret), { messages, ...(req.json ? { response_format: { type: 'json_object' } } : {}), ...(req.max_tokens ? { max_tokens: req.max_tokens } : {}) }, req);
}

// Roles Nova's model manager serves (models/recommend.ts ROLES, the ones that chat). A provider
// set to one of them talks to Nova's own local models instead of an address (M6 plan §2).
export const CHAT_ROLES = ['reasoner', 'triage-text'] as const;
export const roleOf = (c: Config): string | null => (CHAT_ROLES as readonly string[]).includes(str(c.role)) ? str(c.role) : null;

export const openaiCompatible: Impl = {
  id: 'openai-compatible',
  check(c: Config) {
    const out: string[] = [];
    if (c.role !== undefined && c.role !== '' && !roleOf(c)) out.push(`role is ${CHAT_ROLES.join(' or ')}, to use Nova’s local models, or empty to use the address.`);
    if (roleOf(c)) return out;
    try {
      const u = new URL(str(c.base_url));
      if (!['http:', 'https:'].includes(u.protocol)) out.push('base_url must be an http(s) address.');
      if (u.username || u.password) out.push('base_url can’t carry a name or password; keep the key in the vault and name it in api_key.');
    } catch { out.push('base_url is the server’s address, like http://127.0.0.1:11434/v1.'); }
    if (c.model !== undefined && typeof c.model !== 'string') out.push('model is the model’s name on that server.');
    if (c.api_key !== undefined && c.api_key !== '' && !secretName(c.api_key)) out.push('api_key names a secret in the vault, like secret://API_KEY; the key itself never goes in a setting.');
    if (c.json_mode !== undefined && typeof c.json_mode !== 'boolean') out.push('json_mode is true or false.');
    return out;
  },
  unconfigured(c, secret) {
    if (roleOf(c)) return null;
    if (!str(c.base_url)) return 'It needs the server’s address.';
    if (!str(c.model)) return 'It needs a model name.';
    if (c.api_key && !secret(c.api_key)) return `The key ${secretName(c.api_key)} isn’t in the vault yet.`;
    return null;
  },
  url: (c) => (roleOf(c) ? null : str(c.base_url) || null),
  model: (c) => (roleOf(c) ? `role:${roleOf(c)}` : str(c.model) || 'unset'),
  async probe(c, secret, signal) {
    let r: Resolved;
    try { r = resolveCfg(c, secret); } catch (e) { return (e as Error).message; }
    try {
      const res = await fetch(`${r.base}/models`, { ...NO_REDIRECT, signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]), headers: r.key ? { authorization: `Bearer ${r.key}` } : {} });
      if (!res.ok) return scrub(httpProblem(res.status, await res.text().catch(() => ''), r.host, !!r.key), r.key);
      const body = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const ids = Array.isArray(body?.data) ? body!.data.map((m) => m?.id).filter(Boolean) : [];
      if (ids.length && r.model && !ids.includes(r.model)) return `${r.host} answers, but has no model called ${r.model} (it has ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}).`;
      return null;
    } catch (e) {
      return `Nova couldn’t reach ${r.host}: ${scrub(reachProblem(e), r.key)}.`;
    }
  },
  async chat(c, secret, req: ChatRequest) {
    const r = resolveCfg(c, secret);
    return complete(r, { messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }] }, req);
  },
  async work(i: WorkInput): Promise<WorkOutcome> {
    let r: Resolved;
    try { r = resolveCfg(i.config, i.secret); } catch (e) { return { status: 'blocked', summary: (e as Error).message, blockers: [(e as Error).message], usage: {} }; }
    try {
      const out = await complete(r, {
        messages: [{ role: 'system', content: i.system }, { role: 'user', content: i.prompt }],
        ...(i.config.json_mode === false ? {} : { response_format: { type: 'json_object' } }),
      }, { signal: i.signal });
      if (out.aborted) return { status: 'failed', summary: 'Stopped before the reply finished.', usage: out.usage };
      return { status: 'done', summary: '', reply: out.text, usage: out.usage };
    } catch (e) {
      return { status: 'failed', summary: (e as Error).message, usage: { model: r.model } };
    }
  },
};
