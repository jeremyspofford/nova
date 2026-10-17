// One supervised connection to an MCP server (FR-042, FR-043; docs/08 §2.1, §9): launch over
// stdio, SSE or streamable HTTP, discovery with list-changed refresh, tool calls with a timeout
// and cancellation, restart with backoff, status and a redacted log tail.
import { mkdirSync } from 'node:fs';
import {
  Client,
  SSEClientTransport,
  SUPPORTED_PROTOCOL_VERSIONS,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type AuthProvider,
  type ListChangedHandlers,
  type Prompt,
  type Resource,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpStatus, McpTransport, ToolDescriptor } from '@nova/shared';
import type { Logger } from '@nova/telemetry';
import { mapBlock, mapCallError, mapCallResult, type McpToolResult } from './content.ts';
import { LineSplitter, LogRing } from './log-ring.ts';
import { canonicalNames, listNames, toDescriptor, toolExposed, type McpToolInfo } from './names.ts';

export const MCP_CLIENT_NAME = 'nova';

/** Nova speaks MCP 2025-11-25 or later (docs/08 §2.1); older answers end the connection. */
export const MIN_PROTOCOL_VERSION = '2025-11-25';
export const PROTOCOL_VERSIONS = SUPPORTED_PROTOCOL_VERSIONS.filter(
  (v) => v >= MIN_PROTOCOL_VERSION,
);

/** The MCP Apps UI extension (FR-198): Nova renders `ui://` resources of this MIME type. */
export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
const CLIENT_CAPABILITIES = {
  extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
};

/** A server as the manager runs it. Secret values are `secret://` references until launch. */
export interface McpServerConfig {
  id: string;
  accountId: string;
  /** The namespace segment of its tools (`mcp:<name>.<tool>`). */
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  /**
   * NAME → `secret://` reference, resolved at start (a literal is used as is). stdio servers get
   * these as environment variables; sse/http servers get each as a header named with `_` turned
   * into `-` (`X_Api_Key` → `X-Api-Key`), the convention the settings UI uses.
   */
  env: Record<string, string>;
  /** Extra sse/http headers: name → `secret://` reference, resolved at start. */
  headers: Record<string, string>;
  enabled: boolean;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  enabledTools: string[] | null;
  disabledTools: string[];
  /**
   * Tools the owner declared read-only in Settings (FR-082, FR-189), matched like the tool lists;
   * their descriptors get `userReadOnly`. Absent or empty: none. Never set from the server's
   * hints or a plugin's manifest.
   */
  readOnlyTools?: string[];
}

export interface BackoffOptions {
  /** First restart delay; doubles per restart in the window, up to `maxMs`. */
  baseMs: number;
  maxMs: number;
  /** At most this many automatic restarts per window, then `error` until a manual restart. */
  maxRestarts: number;
  windowMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 1000,
  maxMs: 30_000,
  maxRestarts: 5,
  windowMs: 10 * 60_000,
};

export interface McpServerState {
  id: string;
  accountId: string;
  name: string;
  status: McpStatus;
  lastError: string | null;
  protocolVersion: string | null;
  serverInfo: { name: string; version: string } | null;
  counts: { tools: number; resources: number; prompts: number };
  connectedAt: string | null;
  /** Automatic restarts in the current window. */
  restarts: number;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** One item of `resources/read` as the server sent it. */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  /** Base64. */
  blob?: string;
  _meta?: Record<string, unknown>;
}

export type McpResourceContents =
  | { ok: true; contents: McpResourceContent[] }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export interface McpToolEntry {
  serverId: string;
  /** The server's own tool name (what is sent in `tools/call`). */
  original: string;
  descriptor: ToolDescriptor;
  /** Allowed by `enabledTools`/`disabledTools`. */
  exposed: boolean;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Overrides the server's `toolTimeoutMs`. */
  timeoutMs?: number;
  onProgress?: (chunk: string) => void;
}

/** Replace how a transport is built (tests); returning null builds the default one. */
export type TransportFactory = (
  config: McpServerConfig,
  launch: { env: Record<string, string>; headers: Record<string, string>; cwd: string | null },
) => Transport | null;

export interface ConnectionDeps {
  resolveSecret: (ref: string) => Promise<string | null>;
  log: Logger;
  redact: (text: string) => string;
  workDir: ((serverId: string) => string) | null;
  clientVersion: string;
  backoff: BackoffOptions;
  listChangedDebounceMs: number;
  createTransport?: TransportFactory;
  /** Bearer tokens for sse/http servers authorized with OAuth (FR-047); null for none. */
  authFor?: (config: McpServerConfig) => AuthProvider | null;
  onStatus: (state: McpServerState) => void;
  onToolsChanged: (serverId: string) => void;
  now: () => number;
}

class StartError extends Error {}

const isRef = (v: string) => v.startsWith('secret://');

function launchKey(c: McpServerConfig): string {
  return JSON.stringify([
    c.transport,
    c.command,
    c.args,
    c.url,
    c.env,
    c.headers,
    c.startupTimeoutMs,
  ]);
}

/** Env entries as HTTP headers for sse/http servers: `_` in a name becomes `-`. */
export function envHeaders(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) out[name.replace(/_/g, '-')] = value;
  return out;
}

function toolInfo(t: Tool): McpToolInfo {
  const info: McpToolInfo = {
    name: t.name,
    inputSchema: t.inputSchema,
  };
  if (t.title !== undefined) info.title = t.title;
  if (t.description !== undefined) info.description = t.description;
  if (t.outputSchema !== undefined) info.outputSchema = t.outputSchema;
  if (t.annotations) info.annotations = { ...t.annotations };
  if (isPlainObject(t._meta)) info._meta = { ...t._meta };
  return info;
}

function resourceInfo(r: Resource): McpResourceInfo {
  const info: McpResourceInfo = { uri: r.uri, name: r.name };
  if (r.title !== undefined) info.title = r.title;
  if (r.description !== undefined) info.description = r.description;
  if (r.mimeType !== undefined) info.mimeType = r.mimeType;
  return info;
}

function promptInfo(p: Prompt): McpPromptInfo {
  const info: McpPromptInfo = { name: p.name };
  if (p.title !== undefined) info.title = p.title;
  if (p.description !== undefined) info.description = p.description;
  if (p.arguments) info.arguments = p.arguments.map((a) => ({ ...a }));
  return info;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class McpConnection {
  #config: McpServerConfig;
  readonly #deps: ConnectionDeps;
  readonly #log: Logger;
  readonly #secrets = new Set<string>();
  readonly logs: LogRing;
  #status: McpStatus;
  #lastError: string | null = null;
  #client: Client | null = null;
  /** Bumped whenever the current attempt or connection is abandoned; stale callbacks compare it. */
  #gen = 0;
  #attempt: AbortController | null = null;
  #timer: NodeJS.Timeout | null = null;
  #settled: Promise<void> = Promise.resolve();
  #restartTimes: number[] = [];
  #protocolVersion: string | null = null;
  #serverInfo: { name: string; version: string } | null = null;
  #connectedAt: string | null = null;
  #tools: McpToolInfo[] = [];
  #resources: McpResourceInfo[] = [];
  #prompts: McpPromptInfo[] = [];

  constructor(config: McpServerConfig, deps: ConnectionDeps) {
    this.#config = config;
    this.#deps = deps;
    this.#log = deps.log.with({ serverId: config.id, server: config.name });
    this.#status = config.enabled ? 'stopped' : 'disabled';
    this.logs = new LogRing((t) => this.#redact(t));
  }

  get config(): McpServerConfig {
    return this.#config;
  }

  state(): McpServerState {
    const recent = this.#restartTimes.filter(
      (t) => this.#deps.now() - t < this.#deps.backoff.windowMs,
    );
    return {
      id: this.#config.id,
      accountId: this.#config.accountId,
      name: this.#config.name,
      status: this.#status,
      lastError: this.#lastError,
      protocolVersion: this.#protocolVersion,
      serverInfo: this.#serverInfo,
      counts: {
        tools: this.#tools.length,
        resources: this.#resources.length,
        prompts: this.#prompts.length,
      },
      connectedAt: this.#connectedAt,
      restarts: recent.length,
    };
  }

  /** Every tool the server offers, with its descriptor and whether the tool lists expose it. */
  tools(): McpToolEntry[] {
    const cfg = this.#config;
    const names = canonicalNames(
      cfg.name,
      this.#tools.map((t) => t.name),
    );
    const readOnly = cfg.readOnlyTools ?? [];
    return this.#tools.map((t) => {
      const canonical = names.get(t.name)!;
      const descriptor = toDescriptor(cfg, t, canonical);
      if (listNames(readOnly, t.name, canonical)) descriptor.userReadOnly = true;
      return {
        serverId: cfg.id,
        original: t.name,
        descriptor,
        exposed: toolExposed(cfg, t.name, canonical),
      };
    });
  }

  resources(): McpResourceInfo[] {
    return this.#resources.map((r) => ({ ...r }));
  }

  prompts(): McpPromptInfo[] {
    return this.#prompts.map((p) => ({ ...p }));
  }

  /** Start when enabled and idle. Resolves when the attempt settles; never rejects. */
  start(): Promise<void> {
    if (!this.#config.enabled) {
      this.#setStatus('disabled', null);
      return Promise.resolve();
    }
    if (this.#client || this.#attempt || this.#timer) return this.#settled;
    return this.#begin();
  }

  /** A manual restart: forgets earlier automatic restarts (FR-043). */
  async restart(): Promise<void> {
    this.#restartTimes = [];
    // Report the restart at once; the old connection closes before the new one starts.
    if (this.#config.enabled) this.#setStatus('starting', this.#lastError);
    await this.#teardown();
    if (!this.#config.enabled) {
      this.#setStatus('disabled', null);
      return;
    }
    await this.#begin();
  }

  /** Apply new settings; relaunch when how the server is reached changed (or `restart`). */
  async update(next: McpServerConfig, opts: { restart?: boolean } = {}): Promise<void> {
    const prev = this.#config;
    this.#config = next;
    if (!next.enabled) {
      if (this.#status !== 'disabled') await this.stop('disabled');
      return;
    }
    if (!prev.enabled || opts.restart || launchKey(prev) !== launchKey(next)) {
      await this.restart();
      return;
    }
    const listed = (c: McpServerConfig) =>
      JSON.stringify([
        c.name,
        c.enabledTools,
        c.disabledTools,
        c.readOnlyTools ?? [],
        c.toolTimeoutMs,
      ]);
    if (listed(prev) !== listed(next)) {
      this.#deps.onToolsChanged(next.id);
    }
  }

  async stop(final: 'stopped' | 'disabled' = 'stopped'): Promise<void> {
    if (final === 'disabled') this.#lastError = null;
    this.#setStatus(final, this.#lastError);
    await this.#teardown();
  }

  async callTool(original: string, args: unknown, opts: CallOptions = {}): Promise<McpToolResult> {
    const cfg = this.#config;
    const client = this.#client;
    const fail = (code: string, message: string): McpToolResult => ({
      ok: false,
      error: { code, message },
    });
    if (!client) return fail('mcp.unavailable', `MCP server ${cfg.name} is ${this.#status}`);
    const entry = this.tools().find((t) => t.original === original);
    if (!entry) return fail('mcp.tool_not_found', `MCP server ${cfg.name} has no tool ${original}`);
    if (!entry.exposed) return fail('mcp.tool_disabled', `${entry.descriptor.name} is disabled`);
    if (args !== undefined && !isPlainObject(args))
      return fail('mcp.invalid_args', 'tool arguments must be an object');
    const timeoutMs = opts.timeoutMs ?? cfg.toolTimeoutMs;
    const signal = opts.signal;
    if (signal?.aborted) return fail('mcp.cancelled', `${original} was cancelled`);
    const progress = opts.onProgress;
    try {
      const res = await client.callTool(
        { name: original, arguments: args ?? {} },
        {
          timeout: timeoutMs,
          maxTotalTimeout: timeoutMs,
          ...(signal ? { signal } : {}),
          ...(progress
            ? {
                onprogress: (p: { progress: number; total?: number; message?: string }) =>
                  progress(
                    p.message ?? (p.total ? `${p.progress}/${p.total}` : String(p.progress)),
                  ),
              }
            : {}),
        },
      );
      return mapCallResult(res, { serverId: cfg.id, tool: original });
    } catch (err) {
      return mapCallError(err, { tool: original, timeoutMs, cancelled: signal?.aborted ?? false });
    }
  }

  /** The connected SDK client, null while not connected (MCP event subscriptions, FR-201). */
  get sdkClient(): Client | null {
    return this.#client;
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpToolResult> {
    const client = this.#client;
    if (!client) {
      return {
        ok: false,
        error: {
          code: 'mcp.unavailable',
          message: `MCP server ${this.#config.name} is ${this.#status}`,
        },
      };
    }
    const timeoutMs = this.#config.toolTimeoutMs;
    try {
      const res = await client.readResource(
        { uri },
        { timeout: timeoutMs, ...(signal ? { signal } : {}) },
      );
      return {
        ok: true,
        content: res.contents.map((c) => mapBlock({ type: 'resource', resource: c })),
        meta: { serverId: this.#config.id, uri },
      };
    } catch (err) {
      return mapCallError(err, { tool: uri, timeoutMs, cancelled: signal?.aborted ?? false });
    }
  }

  /**
   * A resource's contents as the server sent them (text or base64 blob, MIME type and `_meta`),
   * for MCP Apps, which need the declared CSP and the exact HTML. The content is untrusted.
   */
  async readResourceContents(uri: string, signal?: AbortSignal): Promise<McpResourceContents> {
    const client = this.#client;
    if (!client) {
      return {
        ok: false,
        error: {
          code: 'mcp.unavailable',
          message: `MCP server ${this.#config.name} is ${this.#status}`,
        },
      };
    }
    const timeoutMs = this.#config.toolTimeoutMs;
    try {
      const res = await client.readResource(
        { uri },
        { timeout: timeoutMs, ...(signal ? { signal } : {}) },
      );
      return {
        ok: true,
        contents: res.contents.map((c) => {
          const raw = c as Record<string, unknown>;
          const item: McpResourceContent = { uri: typeof raw.uri === 'string' ? raw.uri : uri };
          if (typeof raw.mimeType === 'string') item.mimeType = raw.mimeType;
          if (typeof raw.text === 'string') item.text = raw.text;
          if (typeof raw.blob === 'string') item.blob = raw.blob;
          if (isPlainObject(raw._meta)) item._meta = { ...raw._meta };
          return item;
        }),
      };
    } catch (err) {
      const mapped = mapCallError(err, {
        tool: uri,
        timeoutMs,
        cancelled: signal?.aborted ?? false,
      });
      return mapped.ok
        ? { ok: false, error: { code: 'mcp.protocol_error', message: 'unexpected result' } }
        : mapped;
    }
  }

  // ---- lifecycle -------------------------------------------------------------------------

  #begin(): Promise<void> {
    const gen = ++this.#gen;
    this.#settled = this.#connect(gen);
    return this.#settled;
  }

  async #teardown(): Promise<void> {
    this.#gen++;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#attempt?.abort();
    this.#attempt = null;
    const client = this.#client;
    this.#client = null;
    this.#clearLists();
    if (client) await client.close().catch(() => undefined);
    await this.#settled;
  }

  async #connect(gen: number): Promise<void> {
    const cfg = this.#config;
    const ctl = new AbortController();
    this.#attempt = ctl;
    this.#setStatus('starting', this.#lastError);
    this.logs.push('status', 'starting');
    const deadline = AbortSignal.any([ctl.signal, AbortSignal.timeout(cfg.startupTimeoutMs)]);
    const startedAt = this.#deps.now();
    const remaining = () => Math.max(1, cfg.startupTimeoutMs - (this.#deps.now() - startedAt));
    let transport: Transport | null = null;
    let client: Client | null = null;
    try {
      transport = await this.#transport(cfg);
      if (gen !== this.#gen) {
        await transport.close();
        return;
      }
      const c = new Client(
        { name: MCP_CLIENT_NAME, version: this.#deps.clientVersion },
        {
          capabilities: CLIENT_CAPABILITIES,
          supportedProtocolVersions: [...PROTOCOL_VERSIONS],
          listChanged: this.#listChanged(gen),
        },
      );
      client = c;
      c.onclose = () => this.#onClose(c);
      c.onerror = (err) => this.logs.push('protocol', `error: ${err.message}`);
      c.setNotificationHandler('notifications/message', (n) => {
        const data =
          typeof n.params.data === 'string' ? n.params.data : JSON.stringify(n.params.data);
        this.logs.push('protocol', `${n.params.level}: ${data}`);
      });
      await c.connect(transport, { timeout: cfg.startupTimeoutMs, signal: deadline });
      const { tools } = await c.listTools(undefined, { signal: deadline, timeout: remaining() });
      const resources = await c
        .listResources(undefined, { signal: deadline, timeout: remaining() })
        .then((r) => r.resources)
        .catch((err: unknown) => this.#listFailed('resources', err));
      const prompts = await c
        .listPrompts(undefined, { signal: deadline, timeout: remaining() })
        .then((r) => r.prompts)
        .catch((err: unknown) => this.#listFailed('prompts', err));
      if (gen !== this.#gen) {
        await c.close().catch(() => undefined);
        return;
      }
      this.#client = c;
      this.#tools = tools.map(toolInfo);
      this.#resources = resources.map(resourceInfo);
      this.#prompts = prompts.map(promptInfo);
      this.#protocolVersion = c.getNegotiatedProtocolVersion() ?? null;
      const info = c.getServerVersion();
      this.#serverInfo = info ? { name: info.name, version: info.version } : null;
      this.#connectedAt = new Date(this.#deps.now()).toISOString();
      this.#lastError = null;
      this.#setStatus('connected', null);
      this.logs.push(
        'status',
        `connected (protocol ${this.#protocolVersion ?? 'unknown'}, ${tools.length} tools)`,
      );
      this.#log.info('mcp server connected', {
        protocolVersion: this.#protocolVersion,
        tools: tools.length,
      });
      this.#deps.onToolsChanged(cfg.id);
    } catch (err) {
      if (client) await client.close().catch(() => undefined);
      else await transport?.close().catch(() => undefined);
      if (gen !== this.#gen) return;
      const message = deadline.aborted
        ? `did not start within ${cfg.startupTimeoutMs} ms`
        : this.#describe(err);
      this.#fail(message);
    } finally {
      if (this.#attempt === ctl) this.#attempt = null;
    }
  }

  #listFailed(kind: string, err: unknown): never[] {
    this.logs.push(
      'protocol',
      `${kind}/list failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  #listChanged(gen: number): ListChangedHandlers {
    const live = () => gen === this.#gen && this.#client !== null;
    const debounceMs = this.#deps.listChangedDebounceMs;
    const failed = (kind: string, err: Error) =>
      this.logs.push('protocol', `${kind} refresh failed: ${err.message}`);
    return {
      tools: {
        debounceMs,
        onChanged: (err, items) => {
          if (!live()) return;
          if (err) return failed('tools', err);
          this.#tools = (items ?? []).map(toolInfo);
          this.logs.push('protocol', `tools changed (${this.#tools.length})`);
          this.#deps.onToolsChanged(this.#config.id);
        },
      },
      resources: {
        debounceMs,
        onChanged: (err, items) => {
          if (!live()) return;
          if (err) return failed('resources', err);
          this.#resources = (items ?? []).map(resourceInfo);
        },
      },
      prompts: {
        debounceMs,
        onChanged: (err, items) => {
          if (!live()) return;
          if (err) return failed('prompts', err);
          this.#prompts = (items ?? []).map(promptInfo);
        },
      },
    };
  }

  #onClose(c: Client): void {
    if (this.#client !== c) return;
    this.#client = null;
    this.#clearLists();
    this.#log.warn('mcp server closed the connection');
    this.#fail('the server closed the connection');
  }

  /** Record a failure and schedule a restart, unless the window's restart budget is spent. */
  #fail(message: string): void {
    const { baseMs, maxMs, maxRestarts, windowMs } = this.#deps.backoff;
    const now = this.#deps.now();
    this.#restartTimes = this.#restartTimes.filter((t) => now - t < windowMs);
    if (this.#restartTimes.length >= maxRestarts) {
      const minutes = Math.round(windowMs / 60_000);
      const final = `${message}; gave up after ${maxRestarts} restarts in ${minutes} minutes (restart it to try again)`;
      this.#lastError = final;
      this.logs.push('status', final);
      this.#log.error('mcp server failed', { error: final });
      this.#setStatus('error', final);
      return;
    }
    const delay = Math.min(baseMs * 2 ** this.#restartTimes.length, maxMs);
    this.#restartTimes.push(now);
    this.#lastError = message;
    this.logs.push('status', `${message}; restarting in ${delay} ms`);
    this.#log.warn('mcp server failed; restarting', { error: message, delayMs: delay });
    this.#setStatus('error', message);
    const gen = this.#gen;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (gen === this.#gen) void this.#begin();
    }, delay);
    this.#timer.unref();
  }

  #clearLists(): void {
    this.#tools = [];
    this.#resources = [];
    this.#prompts = [];
    this.#connectedAt = null;
  }

  #setStatus(status: McpStatus, error: string | null): void {
    const changed = status !== this.#status || error !== this.#lastErrorEmitted;
    this.#status = status;
    if (!changed) return;
    this.#lastErrorEmitted = error;
    this.#deps.onStatus(this.state());
  }

  #lastErrorEmitted: string | null = null;

  // ---- launch ---------------------------------------------------------------------------

  async #transport(cfg: McpServerConfig): Promise<Transport> {
    const env = await this.#resolve(cfg.env, 'environment variable');
    const headers =
      cfg.transport === 'stdio'
        ? await this.#resolve(cfg.headers, 'header')
        : { ...envHeaders(env), ...(await this.#resolve(cfg.headers, 'header')) };
    const args = await this.#resolveArgs(cfg);
    const cwd = cfg.transport === 'stdio' && this.#deps.workDir ? this.#deps.workDir(cfg.id) : null;
    if (cwd) mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const custom = this.#deps.createTransport?.(cfg, { env, headers, cwd });
    if (custom) return custom;
    const authProvider = cfg.transport === 'stdio' ? null : (this.#deps.authFor?.(cfg) ?? null);
    const remote = { requestInit: { headers }, ...(authProvider ? { authProvider } : {}) };
    switch (cfg.transport) {
      case 'stdio': {
        if (!cfg.command) throw new StartError('a stdio server needs a command');
        // Spawned without a shell, with only a minimal inherited environment plus its own.
        const t = new StdioClientTransport({
          command: cfg.command,
          args,
          env,
          stderr: 'pipe',
          ...(cwd ? { cwd } : {}),
        });
        const lines = new LineSplitter((line) => this.logs.push('stderr', line));
        t.stderr?.on('data', (chunk: Buffer) => lines.write(chunk));
        t.stderr?.on('end', () => lines.flush());
        return t;
      }
      case 'http':
        return new StreamableHTTPClientTransport(this.#url(cfg), remote);
      case 'sse':
        return new SSEClientTransport(this.#url(cfg), remote);
    }
  }

  /**
   * Arguments that are references into this server's own part of the vault
   * (`secret://mcp/<id>/…`, e.g. a bundle's sensitive setting on its command line) are resolved
   * at launch. Any other value is passed as written, so an argument can never pull another
   * secret out of the vault.
   */
  async #resolveArgs(cfg: McpServerConfig): Promise<string[]> {
    const own = `secret://mcp/${cfg.id}/`;
    const out: string[] = [];
    for (const [i, a] of cfg.args.entries()) {
      if (!a.startsWith(own)) {
        out.push(a);
        continue;
      }
      const v = await this.#deps.resolveSecret(a);
      if (v === null) throw new StartError(`the secret for argument ${i + 1} is missing`);
      if (v.length >= 4) this.#secrets.add(v);
      out.push(v);
    }
    return out;
  }

  #url(cfg: McpServerConfig): URL {
    let url: URL;
    try {
      url = new URL(cfg.url ?? '');
    } catch {
      throw new StartError('the server URL is not valid');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new StartError('the server URL must use http or https');
    return url;
  }

  async #resolve(map: Record<string, string>, kind: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(map)) {
      const resolved = isRef(value) ? await this.#deps.resolveSecret(value) : value;
      // Fail closed: a missing secret never launches the server without it.
      if (resolved === null) throw new StartError(`the secret for ${kind} ${key} is missing`);
      if (resolved.length >= 4) this.#secrets.add(resolved);
      out[key] = resolved;
    }
    return out;
  }

  #redact(text: string): string {
    let out = text;
    for (const s of this.#secrets) out = out.split(s).join('[REDACTED]');
    return this.#deps.redact(out);
  }

  #describe(err: unknown): string {
    if (err instanceof StartError) return err.message;
    const msg = err instanceof Error ? err.message : String(err);
    const version = /protocol version is not supported: (\S+)/i.exec(msg);
    if (version) {
      return `the server speaks MCP protocol ${version[1]}; Nova supports ${MIN_PROTOCOL_VERSION} or later`;
    }
    if ((err as { code?: unknown }).code === 'ENOENT')
      return `command not found: ${this.#config.command ?? ''}`;
    if (err instanceof SdkError && err.code === SdkErrorCode.ConnectionClosed)
      return 'the server exited before it was ready';
    // HTTP refusals say what happened; 401 is how settings know to offer authorization (FR-047).
    const status = (err as { data?: { status?: unknown } }).data?.status;
    if (err instanceof UnauthorizedError || status === 401)
      return 'the server needs authorization (HTTP 401)';
    if (status === 403) return 'the server refused access (HTTP 403)';
    if (typeof status === 'number') return `the server answered HTTP ${status}`;
    return this.#redact(msg);
  }
}
