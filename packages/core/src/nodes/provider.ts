// A Provider that runs a request on a compute node (FR-126, docs/21 §4): the Hub submits a job to
// the node's job API with the node's job token, relays the node's normalized stream events, and
// cancels the job when the turn is cancelled. Like every adapter, `stream()` never throws: every
// outcome ends with a `stop` event. An unreachable node is a retryable `network` error.
import type { ProviderErrorCode } from '@nova/shared';
import {
  SseParser,
  type AgentErrorShape,
  type CallContext,
  type ChatRequest,
  type ModelInfo,
  type Provider,
  type ProviderCapabilities,
  type StreamEvent,
} from '@nova/providers';

export interface NodeProviderOptions {
  nodeId: string;
  /** Shown in error messages. */
  name: string;
  /** The node's job API base URL (its transport endpoint). */
  endpoint: string;
  models: () => Promise<string[]>;
  /** Reads the job token from the vault at call time. */
  jobToken: () => Promise<string | null>;
  /** Aborted when the node is revoked: in-flight jobs stop at once. */
  revoked?: AbortSignal;
  fetch?: typeof fetch;
  /** Until the node answers a call (default 10 s). */
  connectTimeoutMs?: number;
  /** Longest silence while streaming; the node sends keep-alives (default 90 s). */
  idleTimeoutMs?: number;
  /** Budget for the best-effort cancel call (default 3 s). */
  cancelTimeoutMs?: number;
}

const NODE_CAPS: ProviderCapabilities = {
  streaming: true,
  tools: true,
  parallelToolCalls: false,
  vision: false,
  audioIn: false,
  audioOut: false,
  realtime: false,
  reasoning: false,
  promptCache: 'none',
  structuredOutput: false,
  imageGeneration: false,
  maxContextTokens: 32_000,
  maxOutputTokens: 4_096,
};

const EVENT_TYPES = new Set<string>([
  'start',
  'text_delta',
  'reasoning_delta',
  'tool_call_start',
  'tool_call_delta',
  'tool_call_end',
  'citation',
  'usage',
  'stop',
]);

type Call =
  | { ok: true; res: Response; conn: AbortController; release: () => void }
  | { ok: false; error: AgentErrorShape };

export class NodeProvider implements Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = NODE_CAPS;
  readonly #opts: NodeProviderOptions;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(opts: NodeProviderOptions) {
    this.id = `node:${opts.nodeId}`;
    this.#opts = opts;
    this.#fetch = opts.fetch ?? ((...a) => fetch(...a));
    this.#base = opts.endpoint.replace(/\/+$/, '');
  }

  async listModels(): Promise<ModelInfo[]> {
    return (await this.#opts.models()).map((id) => ({ id, label: id, capabilities: {} }));
  }

  async *stream(req: ChatRequest, _ctx: CallContext): AsyncIterable<StreamEvent> {
    const revoked = this.#opts.revoked;
    const signal = revoked ? AbortSignal.any([req.signal, revoked]) : req.signal;
    const name = this.#opts.name;
    // Revocation is an error (the router may go elsewhere); the caller's abort is a cancel.
    const halted = (): StreamEvent =>
      revoked?.aborted && !req.signal.aborted
        ? stopError('network', `node ${name} was revoked`, false)
        : { type: 'stop', reason: 'cancelled' };
    if (signal.aborted) {
      yield halted();
      return;
    }
    let token: string | null;
    try {
      token = await this.#opts.jobToken();
    } catch {
      token = null;
    }
    if (!token) {
      yield stopError('auth_missing', `the Hub holds no job token for node ${name}`, false);
      return;
    }

    const { signal: _signal, ...request } = req;
    const submit = await this.#call(
      `${this.#base}/node/v1/jobs`,
      {
        method: 'POST',
        headers: {
          ...auth(token),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ kind: 'chat', request }),
      },
      signal,
    );
    if (!submit.ok) {
      yield signal.aborted ? halted() : { type: 'stop', reason: 'error', error: submit.error };
      return;
    }
    let jobId = '';
    try {
      const body = (await submit.res.json()) as { jobId?: unknown };
      if (typeof body.jobId === 'string') jobId = body.jobId;
    } catch {
      // handled below
    } finally {
      submit.release();
    }
    if (!jobId) {
      yield stopError('provider_error', `node ${name} sent an invalid job response`, false);
      return;
    }

    // Set once the node itself ends the job; otherwise the job is cancelled on the way out.
    let ended = false;
    try {
      const opened = await this.#call(
        `${this.#base}/node/v1/jobs/${encodeURIComponent(jobId)}/stream`,
        { headers: { ...auth(token), accept: 'text/event-stream' } },
        signal,
      );
      if (!opened.ok) {
        yield signal.aborted ? halted() : { type: 'stop', reason: 'error', error: opened.error };
        return;
      }
      const events = this.#read(opened.res, opened.conn, signal);
      try {
        for (;;) {
          const r = await events.next();
          if (r.done) {
            // No stop from the node: aborted, or the stream failed.
            yield r.value ? { type: 'stop', reason: 'error', error: r.value } : halted();
            return;
          }
          const e = r.value;
          if (e.type === 'stop') {
            ended = true;
            yield signal.aborted && e.reason !== 'cancelled' ? halted() : e;
            return;
          }
          yield e;
        }
      } finally {
        opened.release();
      }
    } finally {
      // The node also cancels when the Hub disconnects; the explicit call frees its slot at once.
      if (!ended) this.#cancel(jobId, token);
    }
  }

  /** One call with a connect timeout; the caller releases it after reading the body. */
  async #call(url: string, init: RequestInit, signal: AbortSignal): Promise<Call> {
    const conn = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      conn.abort();
    }, this.#opts.connectTimeoutMs ?? 10_000);
    const onAbort = () => conn.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const release = () => signal.removeEventListener('abort', onAbort);
    let res: Response;
    try {
      // `redirect: 'error'`: the job token is never sent anywhere but the node's endpoint.
      res = await this.#fetch(url, { ...init, redirect: 'error', signal: conn.signal });
    } catch {
      release();
      return {
        ok: false,
        error: timedOut
          ? err('timeout', `node ${this.#opts.name} did not answer in time`, true)
          : err('network', `could not reach node ${this.#opts.name}`, true),
      };
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return { ok: true, res, conn, release };
    const error = await this.#httpError(res);
    release();
    return { ok: false, error };
  }

  async #httpError(res: Response): Promise<AgentErrorShape> {
    let message = '';
    try {
      const body = (await res.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === 'string') message = body.error.message.slice(0, 300);
    } catch {
      // not JSON
    }
    const name = this.#opts.name;
    const suffix = message ? `: ${message}` : '';
    if (res.status === 429) return err('rate_limited', `node ${name} is busy${suffix}`, true);
    if (res.status === 401 || res.status === 403)
      return err(
        'auth_expired',
        `node ${name} refused the Hub's job token`,
        false,
        'Enroll the node again',
      );
    if (res.status >= 500)
      return err('provider_error', `node ${name} failed (${res.status})${suffix}`, true);
    return err(
      'invalid_request',
      `node ${name} refused the request (${res.status})${suffix}`,
      false,
    );
  }

  /** Node events until its `stop`; returns a failure, or null when aborted. */
  async *#read(
    res: Response,
    conn: AbortController,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent, AgentErrorShape | null> {
    const name = this.#opts.name;
    if (!res.body) return err('provider_error', `node ${name} returned an empty stream`, true);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const idleMs = this.#opts.idleTimeoutMs ?? 90_000;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let idleFired = false;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        idleFired = true;
        conn.abort();
      }, idleMs);
    };
    armIdle();
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          if (signal.aborted) return null;
          return idleFired
            ? err(
                'timeout',
                `node ${name} stopped sending for ${Math.round(idleMs / 1000)} s`,
                true,
              )
            : err('network', `the connection to node ${name} was lost mid-response`, true);
        }
        if (!chunk.done) armIdle();
        const datas = chunk.done
          ? parser.end()
          : parser.push(decoder.decode(chunk.value, { stream: true }));
        for (const data of datas) {
          const e = parseEvent(data);
          if (!e) return err('provider_error', `node ${name} sent a malformed stream event`, false);
          yield e;
          if (e.type === 'stop') return null;
        }
        if (chunk.done) break;
      }
      if (signal.aborted) return null;
      return err('network', `node ${name} closed the stream before the response finished`, true);
    } finally {
      clearTimeout(idle);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  #cancel(jobId: string, token: string): void {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#opts.cancelTimeoutMs ?? 3_000);
    void this.#fetch(`${this.#base}/node/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      headers: auth(token),
      redirect: 'error',
      signal: ac.signal,
    })
      .then((r) => r.body?.cancel())
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  }
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function parseEvent(data: string): StreamEvent | null {
  try {
    const v: unknown = JSON.parse(data);
    if (typeof v !== 'object' || v === null) return null;
    const type = (v as { type?: unknown }).type;
    return typeof type === 'string' && EVENT_TYPES.has(type) ? (v as StreamEvent) : null;
  } catch {
    return null;
  }
}

function err(
  code: ProviderErrorCode,
  message: string,
  retryable: boolean,
  action?: string,
): AgentErrorShape {
  const e: AgentErrorShape = {
    code,
    message: message.charAt(0).toUpperCase() + message.slice(1),
    retryable,
  };
  if (action) e.action = action;
  return e;
}

function stopError(code: ProviderErrorCode, message: string, retryable: boolean): StreamEvent {
  return { type: 'stop', reason: 'error', error: err(code, message, retryable) };
}
