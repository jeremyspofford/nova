// Local models while the Hub is away (FR-128, docs/21 §9): the shell's main process talks to this
// computer's `novad` local-runtime module (services/novad/src/local_runtime.rs), which proxies an
// OpenAI-compatible model server once the Hub granted the device `local-runtime`. The page never
// sees where it is or how it authenticates: a Unix socket whose file mode is the authentication
// (contracts/hub-api.md §4), or novad's loopback address with its bearer token.
import { readFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type {
  ShellLocalChatMessage,
  ShellLocalRuntimeModelsView,
  ShellLocalRuntimeReason,
} from '@nova/shared';
import { LOCAL_TEXT } from './text.ts';

export type RuntimeEndpoint =
  { kind: 'socket'; path: string } | { kind: 'loopback'; url: string; tokenFile: string };

export interface RuntimeSettings {
  socket?: string | null | undefined;
  url?: string | null | undefined;
  tokenFile?: string | null | undefined;
}

/** novad's own socket (its data folder defaults to /var/lib/nova, services/novad/src/cli.rs). */
export const SYSTEM_SOCKET = '/var/lib/nova/local-runtime/runtime.sock';

function loopbackUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Where to look for the local runtime, in order. Settings (or `NOVA_LOCAL_RUNTIME_*`) replace the
 * defaults: the per-user socket a system novad offers this user in the user's runtime folder
 * (`<runtime dir>/nova/runtime.sock`, contracts/hub-api.md §4), then novad's own socket, which this
 * app can open only when novad runs as the same user (otherwise: `no_access`). Windows has no
 * default: novad offers no named pipe yet, so its loopback address is set up by hand.
 */
export function runtimeEndpoints(opts: {
  settings: RuntimeSettings;
  env: NodeJS.ProcessEnv;
  platform: string;
  home: string;
  uid: number | null;
}): RuntimeEndpoint[] {
  const { env } = opts;
  const out: RuntimeEndpoint[] = [];
  const socket = env.NOVA_LOCAL_RUNTIME_SOCKET ?? opts.settings.socket;
  if (socket) out.push({ kind: 'socket', path: socket });
  const url = env.NOVA_LOCAL_RUNTIME_URL ?? opts.settings.url;
  const tokenFile = env.NOVA_LOCAL_RUNTIME_TOKEN_FILE ?? opts.settings.tokenFile;
  const origin = url ? loopbackUrl(url) : null;
  if (origin && tokenFile) out.push({ kind: 'loopback', url: origin, tokenFile });
  if (socket || url) return out;
  if (opts.platform === 'linux') {
    const runtimeDir = env.XDG_RUNTIME_DIR ?? (opts.uid !== null ? `/run/user/${opts.uid}` : null);
    if (runtimeDir) out.push({ kind: 'socket', path: join(runtimeDir, 'nova', 'runtime.sock') });
  } else if (opts.platform === 'darwin') {
    out.push({
      kind: 'socket',
      path: join(opts.home, 'Library', 'Application Support', 'Nova', 'run', 'runtime.sock'),
    });
  } else return out;
  out.push({ kind: 'socket', path: SYSTEM_SOCKET });
  return out;
}

export class LocalRuntimeError extends Error {
  readonly reason: ShellLocalRuntimeReason;
  constructor(reason: ShellLocalRuntimeReason, message: string) {
    super(message);
    this.name = 'LocalRuntimeError';
    this.reason = reason;
  }
}

/** The sentence the web UI shows for a reason: what is wrong and what to do. */
export function reasonMessage(reason: ShellLocalRuntimeReason, detail?: string): string {
  switch (reason) {
    case 'no_novad':
      return LOCAL_TEXT.noNovad;
    case 'no_access':
      return LOCAL_TEXT.noAccess({ flag: '--user' });
    case 'scope_missing':
      return LOCAL_TEXT.scopeMissing;
    case 'no_model_server':
      return LOCAL_TEXT.noModelServer({ url: 'http://127.0.0.1:11434/v1' });
    case 'failed':
      return detail ? LOCAL_TEXT.failedDetail({ detail }) : LOCAL_TEXT.failed;
  }
}

const fail = (reason: ShellLocalRuntimeReason, detail?: string) =>
  new LocalRuntimeError(reason, reasonMessage(reason, detail));

const ABSENT = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTDIR', 'ENOTSOCK', 'ECONNRESET']);
const DENIED = new Set(['EACCES', 'EPERM']);

function codeOf(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
}

function readBody(res: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', (c: string) => {
      out += c;
      if (out.length > max) res.destroy(new Error('the answer is too large'));
    });
    res.once('end', () => resolve(out));
    res.once('error', reject);
  });
}

/** The error a non-200 answer of novad (or of the model server behind it) stands for. */
async function answerError(res: IncomingMessage): Promise<LocalRuntimeError> {
  const text = await readBody(res, 64 * 1024).catch(() => '');
  let error: { code?: unknown; message?: unknown; details?: { reason?: unknown } } = {};
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (body.error && typeof body.error === 'object') error = body.error;
    else if (typeof body.error === 'string') error = { message: body.error };
  } catch {
    // not JSON
  }
  const status = res.statusCode ?? 0;
  if (status === 403 && error.details?.reason === 'scope_missing') return fail('scope_missing');
  // novad answers 502 when the model server behind it does not.
  if (status === 502) return fail('no_model_server');
  // A wrong or missing token on the loopback address: the token file is not this app's to read.
  if (status === 401) return fail('no_access');
  const message =
    typeof error.message === 'string' ? error.message.slice(0, 300) : `HTTP ${status}`;
  return fail('failed', message);
}

export interface LocalRuntimeOptions {
  endpoints: () => RuntimeEndpoint[];
  /** Connecting and the whole of a models request (ms). */
  timeoutMs?: number;
  /** Silence allowed between parts of an answer: a local model may think a while (ms). */
  idleMs?: number;
  /** Most characters of one answer. */
  maxChars?: number;
}

export class LocalRuntime {
  readonly #endpoints: () => RuntimeEndpoint[];
  readonly #timeoutMs: number;
  readonly #idleMs: number;
  readonly #maxChars: number;

  constructor(opts: LocalRuntimeOptions) {
    this.#endpoints = opts.endpoints;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#idleMs = opts.idleMs ?? 300_000;
    this.#maxChars = opts.maxChars ?? 2_000_000;
  }

  /** One request to the first endpoint that answers; non-200 answers become errors. */
  async #request(
    method: 'GET' | 'POST',
    path: string,
    body: string | null,
    signal?: AbortSignal,
  ): Promise<IncomingMessage> {
    let denied = false;
    for (const ep of this.#endpoints()) {
      const headers: Record<string, string> = { accept: 'application/json, text/event-stream' };
      if (body !== null) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(body));
      }
      let target: { socketPath: string } | { host: string; port: number };
      if (ep.kind === 'socket') {
        target = { socketPath: ep.path };
        headers.host = 'localhost';
      } else {
        let token: string;
        try {
          token = readFileSync(ep.tokenFile, 'utf8').trim();
        } catch (err) {
          if (DENIED.has(codeOf(err))) denied = true;
          continue;
        }
        const u = new URL(ep.url);
        target = { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 80) };
        headers.host = u.host;
        headers.authorization = `Bearer ${token}`;
      }
      try {
        const res = await new Promise<IncomingMessage>((resolve, reject) => {
          const req = request({ ...target, method, path, headers, timeout: this.#timeoutMs });
          req.once('response', resolve);
          req.once('error', reject);
          req.once('timeout', () =>
            req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
          );
          signal?.addEventListener('abort', () => req.destroy(new Error('stopped')), {
            once: true,
          });
          req.end(body ?? undefined);
        });
        if (res.statusCode === 200) {
          res.socket.setTimeout(this.#idleMs);
          res.socket.once('timeout', () =>
            res.destroy(new Error('the local model stopped answering')),
          );
          return res;
        }
        throw await answerError(res);
      } catch (err) {
        if (err instanceof LocalRuntimeError) throw err;
        if (signal?.aborted) throw fail('failed', 'the answer was stopped');
        const code = codeOf(err);
        if (DENIED.has(code)) {
          denied = true;
          continue;
        }
        if (ABSENT.has(code)) continue;
        if (code === 'ETIMEDOUT') throw fail('failed', 'novad did not answer in time');
        throw fail('failed', err instanceof Error ? err.message : String(err));
      }
    }
    throw fail(denied ? 'no_access' : 'no_novad');
  }

  /** The model ids the local runtime offers, or why it cannot be used. */
  async models(): Promise<ShellLocalRuntimeModelsView> {
    try {
      const res = await this.#request('GET', '/v1/models', null);
      const text = await readBody(res, 4 * 1024 * 1024);
      const body = JSON.parse(text) as { data?: unknown; models?: unknown };
      const list = Array.isArray(body.data)
        ? body.data
        : Array.isArray(body.models)
          ? body.models
          : [];
      const ids = new Set<string>();
      for (const m of list as { id?: unknown; name?: unknown }[]) {
        const id = typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : null;
        if (id) ids.add(id);
      }
      return { ok: true, models: [...ids].sort() };
    } catch (err) {
      const e =
        err instanceof LocalRuntimeError ? err : fail('failed', 'the model list was not readable');
      return { ok: false, reason: e.reason, message: e.message, models: [] };
    }
  }

  /**
   * Ask a local model; the answer's text streams through `onDelta` as it arrives (the model's
   * reasoning, which some servers send separately, is left out) and comes back whole.
   */
  async chat(
    req: { model: string; messages: ShellLocalChatMessage[] },
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<{ text: string }> {
    const body = JSON.stringify({ model: req.model, messages: req.messages, stream: true });
    const res = await this.#request('POST', '/v1/chat/completions', body, signal);
    signal?.addEventListener('abort', () => res.destroy(new Error('stopped')), { once: true });
    let text = '';
    const take = (delta: unknown) => {
      if (typeof delta !== 'string' || delta === '') return;
      if (text.length + delta.length > this.#maxChars)
        throw fail('failed', 'the answer is too long');
      text += delta;
      onDelta(delta);
    };
    const type = String(res.headers['content-type'] ?? '');
    try {
      if (!type.includes('text/event-stream')) {
        // A server that ignores `stream` answers with one JSON object.
        const whole = JSON.parse(await readBody(res, this.#maxChars * 2)) as {
          choices?: { message?: { content?: unknown } }[];
        };
        take(whole.choices?.[0]?.message?.content);
        return { text };
      }
      let buffer = '';
      res.setEncoding('utf8');
      for await (const chunk of res as AsyncIterable<string>) {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return { text };
          let event: {
            choices?: { delta?: { content?: unknown } }[];
            error?: { message?: unknown };
          };
          try {
            event = JSON.parse(data) as typeof event;
          } catch {
            continue;
          }
          if (event.error)
            throw fail(
              'failed',
              typeof event.error.message === 'string' ? event.error.message : 'error',
            );
          take(event.choices?.[0]?.delta?.content);
        }
        if (buffer.length > 1024 * 1024)
          throw fail('failed', 'the answer is not a stream of events');
      }
      return { text };
    } catch (err) {
      if (err instanceof LocalRuntimeError) throw err;
      if (signal?.aborted) throw fail('failed', 'the answer was stopped');
      throw fail('failed', err instanceof Error ? err.message : 'the answer broke off');
    } finally {
      res.destroy();
    }
  }
}
