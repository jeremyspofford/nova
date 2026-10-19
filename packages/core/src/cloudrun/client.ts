// The Hub's client of a cloud runner (contracts/rest-api.md §5 as amended by ADR-095; FR-108).
// Every call carries the Hub's runner token; the runner's errors (contracts/rest-api.md §6) become
// NovaErrors: an unreachable runner is `node_unavailable` (retryable), a refused token
// `auth_missing`, a cap reached `budget_exhausted`, no sandbox there `sandbox_unavailable`. The
// token never appears in an error, a log line or a view.
import { NovaError, type ErrorCode } from '@nova/shared';

export interface RunnerHealth {
  status: string;
  version: string;
  substrate: { kind: string | null; ok: boolean; detail: string };
  limits: Record<string, unknown>;
}

export interface RunnerEnvironment {
  id: string;
  name: string;
  status: 'provisioning' | 'ready' | 'failed' | 'deleting';
  detail: string | null;
  substrate: string | null;
  repoUrls: string[];
  setupScript: string | null;
  baseImage: string | null;
  caches: string[];
  network: 'off' | 'setup' | 'on';
  connection: {
    workdir: string;
    repos: { name: string; path: string; ref: string | null; head: string | null }[];
    caches: { name: string; path: string }[];
  };
  setup: {
    status: 'none' | 'running' | 'ok' | 'failed';
    exitCode: number | null;
    log: string;
    startedAt: string | null;
    endedAt: string | null;
  };
  usage: { diskBytes: number };
  caps: { diskBytes: number };
  runs: { active: number };
  processes: { running: number };
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
}

export interface RunnerProcess {
  id: string;
  runId: string;
  cmd: string;
  cwd: string;
  tag: string | null;
  running: boolean;
  exitCode: number | null;
  stopped: string | null;
  cpuSeconds: number;
  outputBytes: number;
  startedAt: string;
  endedAt: string | null;
}

export interface RunnerArtifact {
  id: string;
  path: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface RunnerRun {
  id: string;
  environmentId: string;
  label: string | null;
  status: 'active' | 'completed' | 'cancelled' | 'capped' | 'failed';
  reason: string | null;
  caps: { cpuSeconds: number; wallSeconds: number };
  usage: { cpuSeconds: number; wallSeconds: number; commands: number };
  artifacts: RunnerArtifact[];
  processes: RunnerProcess[];
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface RunnerRead {
  data: string;
  offset: number;
  dropped: number;
  running: boolean;
  exitCode: number | null;
}

export interface RunnerSnapshot {
  id: string;
  environmentId: string;
  label: string | null;
  sizeBytes: number;
  createdAt: string;
  restoredAt: string | null;
}

export type RunnerFile =
  | {
      kind: 'dir';
      entries: { name: string; kind: 'file' | 'dir' | 'link' | 'other'; size: number }[];
      truncated: boolean;
    }
  | { kind: 'file'; size: number; content: string; truncated: boolean };

export interface RunnerStreamEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

export interface RunnerClientOptions {
  /** The runner's base URL (https://, or http:// on this machine). */
  url: string;
  token: string;
  fetch?: typeof fetch;
  /** Per-request timeout (long polls add their wait). */
  timeoutMs?: number;
}

const CODE_MAP: Record<string, ErrorCode> = {
  validation: 'validation',
  auth_missing: 'auth_missing',
  auth_invalid: 'auth_missing',
  not_found: 'not_found',
  conflict: 'conflict',
  quota_exceeded: 'budget_exhausted',
  too_large: 'validation',
  rate_limited: 'rate_limited',
  not_implemented: 'capability_missing',
  sandbox_unavailable: 'sandbox_unavailable',
  server_error: 'server_error',
};

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

export class RunnerClient {
  readonly url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: RunnerClientOptions) {
    this.url = base(opts.url);
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async #call<T>(
    method: string,
    path: string,
    body?: unknown,
    o: { signal?: AbortSignal; extraMs?: number; raw?: boolean; maxBytes?: number } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.#timeoutMs + (o.extraMs ?? 0));
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.#fetch(`${this.url}/v1/runner${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (err) {
      if (o.signal?.aborted) throw new NovaError('cancelled', 'cancelled');
      const why =
        err instanceof Error
          ? err.cause instanceof Error
            ? err.cause.message
            : err.message
          : String(err);
      throw new NovaError('node_unavailable', `the cloud runner cannot be reached: ${why}`, {
        retryable: true,
        details: { reason: 'runner_unreachable' },
      });
    }
    // A compromised runner cannot make the Hub buffer without bound.
    const bytes = await readCapped(res, o.maxBytes ?? MAX_RESPONSE_BYTES);
    if (o.raw && res.ok) return bytes as T;
    const json = parseJson(bytes.toString('utf8'));
    if (res.ok) return json as T;
    throw toNovaError(res.status, json);
  }

  health(): Promise<RunnerHealth> {
    return this.#call('GET', '/health');
  }

  // ---- environments ----

  createEnvironment(body: Record<string, unknown>): Promise<RunnerEnvironment> {
    return this.#call('POST', '/environments', body);
  }
  environment(id: string): Promise<RunnerEnvironment> {
    return this.#call('GET', `/environments/${encodeURIComponent(id)}`);
  }
  async environments(): Promise<RunnerEnvironment[]> {
    return (await this.#call<{ items: RunnerEnvironment[] }>('GET', '/environments')).items;
  }
  rebuild(id: string): Promise<RunnerEnvironment> {
    return this.#call('POST', `/environments/${encodeURIComponent(id)}/rebuild`);
  }
  async deleteEnvironment(id: string): Promise<void> {
    await this.#call('DELETE', `/environments/${encodeURIComponent(id)}`);
  }

  // ---- files ----

  async stat(
    envId: string,
    path: string,
  ): Promise<{ kind: 'file' | 'dir' | 'link' | 'other'; size: number } | null> {
    try {
      return await this.#call(
        'GET',
        `/environments/${encodeURIComponent(envId)}/files?path=${encodeURIComponent(path)}&stat=1`,
      );
    } catch (err) {
      if (err instanceof NovaError && err.code === 'not_found') return null;
      throw err;
    }
  }
  files(envId: string, path: string): Promise<RunnerFile> {
    return this.#call(
      'GET',
      `/environments/${encodeURIComponent(envId)}/files?path=${encodeURIComponent(path)}`,
    );
  }
  writeFile(
    envId: string,
    path: string,
    content: Buffer,
  ): Promise<{ size: number; sha256: string }> {
    return this.#call(
      'PUT',
      `/environments/${encodeURIComponent(envId)}/files?path=${encodeURIComponent(path)}`,
      {
        content: content.toString('base64'),
      },
    );
  }
  async deleteFile(envId: string, path: string): Promise<void> {
    await this.#call(
      'DELETE',
      `/environments/${encodeURIComponent(envId)}/files?path=${encodeURIComponent(path)}`,
    );
  }

  // ---- runs and commands ----

  createRun(body: {
    environmentId: string;
    label?: string;
    budget?: { cpuSeconds?: number; wallSeconds?: number };
  }): Promise<RunnerRun> {
    return this.#call('POST', '/runs', body);
  }
  run(id: string): Promise<RunnerRun> {
    return this.#call('GET', `/runs/${encodeURIComponent(id)}`);
  }
  updateRun(id: string, budget: { cpuSeconds?: number; wallSeconds?: number }): Promise<RunnerRun> {
    return this.#call('PATCH', `/runs/${encodeURIComponent(id)}`, { budget });
  }
  cancelRun(id: string): Promise<RunnerRun> {
    return this.#call('POST', `/runs/${encodeURIComponent(id)}/cancel`);
  }
  finishRun(id: string): Promise<RunnerRun> {
    return this.#call('POST', `/runs/${encodeURIComponent(id)}/finish`);
  }
  exec(
    runId: string,
    body: {
      cmd: string;
      cwd?: string;
      env?: Record<string, string>;
      tag?: string;
      network?: 'off' | 'on';
      readOnly?: boolean;
      timeoutMs?: number;
      stdin?: boolean;
    },
  ): Promise<RunnerProcess> {
    return this.#call('POST', `/runs/${encodeURIComponent(runId)}/exec`, body);
  }
  /** One program to its end with bytes in and out (the environment transport). */
  async runProgram(
    runId: string,
    body: {
      argv: readonly string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: Buffer;
      timeoutMs?: number;
      maxBytes?: number;
    },
    signal?: AbortSignal,
  ): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    const r = await this.#call<{ code: number; stdout: string; stderr: string }>(
      'POST',
      `/runs/${encodeURIComponent(runId)}/run`,
      {
        argv: body.argv,
        ...(body.cwd ? { cwd: body.cwd } : {}),
        ...(body.env && Object.keys(body.env).length ? { env: body.env } : {}),
        ...(body.stdin?.length ? { stdin: body.stdin.toString('base64') } : {}),
        ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
        ...(body.maxBytes ? { maxBytes: body.maxBytes } : {}),
      },
      { extraMs: body.timeoutMs ?? 120_000, ...(signal ? { signal } : {}) },
    );
    return { code: r.code, stdout: Buffer.from(r.stdout, 'base64'), stderr: r.stderr };
  }
  read(
    runId: string,
    processId: string,
    offset: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<RunnerRead> {
    const wait = Math.max(0, Math.min(30_000, Math.round(waitMs)));
    return this.#call(
      'GET',
      `/runs/${encodeURIComponent(runId)}/processes/${encodeURIComponent(processId)}/output?offset=${offset}&waitMs=${wait}`,
      undefined,
      { extraMs: wait, ...(signal ? { signal } : {}) },
    );
  }
  async input(
    runId: string,
    processId: string,
    body: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' },
  ): Promise<void> {
    await this.#call(
      'POST',
      `/runs/${encodeURIComponent(runId)}/processes/${encodeURIComponent(processId)}/input`,
      body,
    );
  }
  async kill(runId: string, tag: string): Promise<number> {
    return (
      await this.#call<{ killed: number }>('POST', `/runs/${encodeURIComponent(runId)}/kill`, {
        tag,
      })
    ).killed;
  }
  async processes(runId: string): Promise<RunnerProcess[]> {
    return (
      await this.#call<{ items: RunnerProcess[] }>(
        'GET',
        `/runs/${encodeURIComponent(runId)}/processes`,
      )
    ).items;
  }
  collectArtifact(runId: string, path: string, name?: string): Promise<RunnerArtifact> {
    return this.#call('POST', `/runs/${encodeURIComponent(runId)}/artifacts`, {
      path,
      ...(name ? { name } : {}),
    });
  }
  /** An artifact's bytes; refused past `maxBytes` before anything else is read. */
  artifact(runId: string, artifactId: string, maxBytes: number): Promise<Buffer> {
    return this.#call(
      'GET',
      `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
      undefined,
      { raw: true, extraMs: 60_000, maxBytes },
    );
  }

  // ---- snapshots ----

  snapshot(environmentId: string, label?: string): Promise<RunnerSnapshot> {
    return this.#call(
      'POST',
      '/snapshots',
      { environmentId, ...(label ? { label } : {}) },
      { extraMs: 30 * 60_000 },
    );
  }
  async snapshots(environmentId: string): Promise<RunnerSnapshot[]> {
    return (
      await this.#call<{ items: RunnerSnapshot[] }>(
        'GET',
        `/snapshots?environmentId=${encodeURIComponent(environmentId)}`,
      )
    ).items;
  }
  async restore(id: string): Promise<RunnerSnapshot> {
    return (
      await this.#call<{ snapshot: RunnerSnapshot }>(
        'POST',
        `/snapshots/${encodeURIComponent(id)}/restore`,
        undefined,
        { extraMs: 30 * 60_000 },
      )
    ).snapshot;
  }
  async deleteSnapshot(id: string): Promise<void> {
    await this.#call('DELETE', `/snapshots/${encodeURIComponent(id)}`);
  }

  /**
   * A run's server-sent events after `since` (usage, caps, process ends; output when asked). Ends
   * when the run ends, the connection drops or `signal` aborts.
   */
  async *stream(
    runId: string,
    since: number,
    signal: AbortSignal,
    output = false,
  ): AsyncGenerator<RunnerStreamEvent> {
    let res: Response;
    try {
      res = await this.#fetch(
        `${this.url}/v1/runner/runs/${encodeURIComponent(runId)}/stream?since=${since}&output=${output ? 1 : 0}`,
        {
          headers: { authorization: `Bearer ${this.#token}`, accept: 'text/event-stream' },
          signal,
        },
      );
    } catch (err) {
      if (signal.aborted) return;
      throw new NovaError(
        'node_unavailable',
        `the cloud runner cannot be reached: ${err instanceof Error ? err.message : String(err)}`,
        {
          retryable: true,
          details: { reason: 'runner_unreachable' },
        },
      );
    }
    if (!res.ok || !res.body) {
      const json = parseJson(
        (await readCapped(res, 64 * 1024).catch(() => Buffer.alloc(0))).toString('utf8'),
      );
      throw toNovaError(res.status, json);
    }
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        if (buf.length > MAX_EVENT_CHARS)
          throw new NovaError('server_error', 'the runner sent an oversized event', {
            details: { reason: 'runner_event_too_large' },
          });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const e = parseSse(block);
          if (e) yield e;
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof NovaError) throw err;
      throw new NovaError(
        'node_unavailable',
        `the runner stream dropped: ${err instanceof Error ? err.message : String(err)}`,
        {
          retryable: true,
          details: { reason: 'runner_unreachable' },
        },
      );
    }
  }
}

/** Bytes of one runner answer at most (a program's 64 MiB of output, base64, and its frame). */
const MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
/** Characters of one server-sent event (and of a partial one) at most. */
const MAX_EVENT_CHARS = 1024 * 1024;

/** A response body, refused (and its download stopped) past `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge(max);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) {
      await res.body.cancel().catch(() => undefined);
      throw tooLarge(max);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function tooLarge(max: number): NovaError {
  return new NovaError('validation', `the runner's answer is larger than ${max} bytes`, {
    details: { reason: 'runner_answer_too_large', limit: max },
  });
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** One server-sent event block (comments and keepalives give null). */
export function parseSse(block: string): RunnerStreamEvent | null {
  let id = 0;
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const at = line.indexOf(':');
    const field = at < 0 ? line : line.slice(0, at);
    const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
    if (field === 'id') id = Number(value) || 0;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  try {
    return { id, event, data: JSON.parse(data.join('\n')) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** The runner's error body as a NovaError. */
export function toNovaError(status: number, body: unknown): NovaError {
  const e = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)
    ?.error;
  const code = typeof e?.code === 'string' ? e.code : null;
  const message =
    typeof e?.message === 'string' ? e.message : `the cloud runner answered ${status}`;
  const details =
    e?.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : {};
  if (status === 401)
    return new NovaError('auth_missing', 'the cloud runner refused the token', {
      details: { reason: 'runner_token' },
      action: 'Set a new runner token in Settings',
    });
  if (code === 'quota_exceeded')
    return new NovaError('budget_exhausted', message, {
      details: { reason: 'cap_reached', ...details },
    });
  const mapped = (code && CODE_MAP[code]) || (status >= 500 ? 'server_error' : 'validation');
  return new NovaError(mapped, message, {
    details: { ...details, runner: code ?? status },
    ...(status >= 500 || status === 429 ? { retryable: true } : {}),
  });
}
