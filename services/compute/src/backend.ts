// The node's local model backend (docs/07 §12): Ollama, a llama.cpp server or any other
// OpenAI-compatible server, driven through @nova/providers' adapter. The node talks only to the
// Hub and to this backend (FR-126); `guardedFetch` enforces that for every outgoing request.
import { OpenAICompatibleProvider, type ChatRequest, type StreamEvent } from '@nova/providers';

export const BACKEND_KINDS = ['ollama', 'llamacpp', 'openai_compatible'] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

/**
 * A fetch that refuses any origin outside `allowed` and never follows redirects, so neither a
 * bug nor a hostile backend or Hub response can make the node connect elsewhere.
 */
export function guardedFetch(allowed: string[], base: typeof fetch = fetch): typeof fetch {
  const origins = new Set(allowed.map((u) => new URL(u).origin));
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return Promise.reject(new TypeError('invalid URL'));
    }
    if (!origins.has(origin))
      return Promise.reject(new TypeError(`refused: ${origin} is not the Hub or the backend`));
    return base(input, { ...init, redirect: 'error' });
  };
}

export interface BackendOptions {
  url: string;
  kind: BackendKind;
  fetch?: typeof fetch;
  /** Until the backend answers (default 10 s). */
  connectTimeoutMs?: number;
  /** Longest silence while streaming (default 90 s; local models can be slow to start). */
  idleTimeoutMs?: number;
}

export class Backend {
  readonly url: string;
  readonly kind: BackendKind;
  readonly #provider: OpenAICompatibleProvider;

  constructor(opts: BackendOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.kind = opts.kind;
    const providerOpts = {
      id: 'backend',
      fetch: guardedFetch([this.url], opts.fetch),
      connectTimeoutMs: opts.connectTimeoutMs ?? 10_000,
      idleTimeoutMs: opts.idleTimeoutMs ?? 90_000,
      // The Hub decides about retries and fallback; the node reports the first failure.
      maxRetries: 0,
    };
    this.#provider =
      opts.kind === 'ollama'
        ? new OpenAICompatibleProvider({ ...providerOpts, kind: 'ollama', baseUrl: this.url })
        : new OpenAICompatibleProvider({
            ...providerOpts,
            kind: 'openai_compatible',
            // llama.cpp servers and most others serve the OpenAI API under /v1.
            baseUrl: /\/v1$/.test(this.url) ? this.url : `${this.url}/v1`,
          });
  }

  /** Model ids the backend serves now, sorted. */
  async models(): Promise<string[]> {
    return (await this.#provider.listModels()).map((m) => m.id).sort();
  }

  stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    return this.#provider.stream(req, { requestId: req.metadata?.jobId ?? 'job' });
  }
}
