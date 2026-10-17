// The MCP client manager (FR-042, FR-043): one supervised connection per configured server,
// their status, logs and tools, and tool calls routed to the right server.
import { join } from 'node:path';
import type { McpLogLine } from '@nova/shared';
import { defaultRedactor, type Redactor } from '@nova/security';
import type { Logger } from '@nova/telemetry';
import {
  DEFAULT_BACKOFF,
  McpConnection,
  type BackoffOptions,
  type CallOptions,
  type McpPromptInfo,
  type McpResourceInfo,
  type McpServerConfig,
  type McpServerState,
  type McpToolEntry,
  type TransportFactory,
} from './connection.ts';
import type { McpToolResult } from './content.ts';

export interface McpManagerOptions {
  /** Resolve a `secret://` reference at launch (FR-101); null when it does not exist. */
  resolveSecret: (ref: string) => Promise<string | null>;
  log: Logger;
  redactor?: Redactor;
  /** Parent of each stdio server's working directory, `<dir>/<serverId>` (created 0700). */
  workDir?: string;
  clientVersion?: string;
  backoff?: Partial<BackoffOptions>;
  /** Debounce for list-changed refreshes (default 300 ms). */
  listChangedDebounceMs?: number;
  createTransport?: TransportFactory;
  onStatus?: (state: McpServerState) => void;
  /** A server's tool list (or what its lists expose) changed; rebuild tool indexes. */
  onToolsChanged?: (serverId: string) => void;
  now?: () => number;
}

export class McpManager {
  readonly #conns = new Map<string, McpConnection>();
  readonly #opts: McpManagerOptions;
  readonly #backoff: BackoffOptions;
  readonly #redactor: Redactor;
  #closed = false;

  constructor(opts: McpManagerOptions) {
    this.#opts = opts;
    this.#backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    this.#redactor = opts.redactor ?? defaultRedactor;
  }

  /** Register a server and connect it when enabled. Resolves when the first attempt settles. */
  add(config: McpServerConfig): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const existing = this.#conns.get(config.id);
    if (existing) return existing.update(config);
    const workDir = this.#opts.workDir;
    const conn = new McpConnection(config, {
      resolveSecret: this.#opts.resolveSecret,
      log: this.#opts.log,
      redact: (t) => this.#redactor.redactString(t),
      workDir: workDir ? (id) => join(workDir, id) : null,
      clientVersion: this.#opts.clientVersion ?? '0.0.0',
      backoff: this.#backoff,
      listChangedDebounceMs: this.#opts.listChangedDebounceMs ?? 300,
      ...(this.#opts.createTransport ? { createTransport: this.#opts.createTransport } : {}),
      // Removed servers and a closing manager report nothing more.
      onStatus: (s) => {
        if (!this.#closed && this.#conns.get(s.id) === conn) this.#opts.onStatus?.(s);
      },
      onToolsChanged: (id) => this.#opts.onToolsChanged?.(id),
      now: this.#opts.now ?? Date.now,
    });
    this.#conns.set(config.id, conn);
    return conn.start();
  }

  /** Apply new settings; `restart` forces a relaunch (for example after a secret changed). */
  async update(config: McpServerConfig, opts: { restart?: boolean } = {}): Promise<void> {
    const conn = this.#conns.get(config.id);
    if (!conn) return this.add(config);
    await conn.update(config, opts);
  }

  /** Disconnect and forget a server. */
  async remove(id: string): Promise<boolean> {
    const conn = this.#conns.get(id);
    if (!conn) return false;
    this.#conns.delete(id);
    await conn.stop();
    this.#opts.onToolsChanged?.(id);
    return true;
  }

  /** A manual restart (FR-043); resolves when the attempt settles. */
  async restart(id: string): Promise<void> {
    await this.#conns.get(id)?.restart();
  }

  has(id: string): boolean {
    return this.#conns.has(id);
  }

  config(id: string): McpServerConfig | null {
    return this.#conns.get(id)?.config ?? null;
  }

  state(id: string): McpServerState | null {
    return this.#conns.get(id)?.state() ?? null;
  }

  states(accountId?: string): McpServerState[] {
    return [...this.#conns.values()]
      .filter((c) => accountId === undefined || c.config.accountId === accountId)
      .map((c) => c.state());
  }

  /** The last 500 log lines, oldest first, redacted (again, for secrets learned since). */
  logs(id: string): McpLogLine[] {
    return (this.#conns.get(id)?.logs.lines() ?? []).map((l) => ({
      ...l,
      text: this.#redactor.redactString(l.text),
    }));
  }

  /** Every tool a server offers, exposed or not (for settings). */
  tools(id: string): McpToolEntry[] {
    return this.#conns.get(id)?.tools() ?? [];
  }

  /** The tools the model may be offered: connected servers of this account, lists applied. */
  exposedTools(accountId: string): McpToolEntry[] {
    const out: McpToolEntry[] = [];
    for (const c of this.#conns.values()) {
      if (c.config.accountId !== accountId || !c.config.enabled) continue;
      for (const t of c.tools()) if (t.exposed) out.push(t);
    }
    return out;
  }

  resources(id: string): McpResourceInfo[] {
    return this.#conns.get(id)?.resources() ?? [];
  }

  prompts(id: string): McpPromptInfo[] {
    return this.#conns.get(id)?.prompts() ?? [];
  }

  callTool(
    serverId: string,
    tool: string,
    args: unknown,
    opts: CallOptions = {},
  ): Promise<McpToolResult> {
    const conn = this.#conns.get(serverId);
    if (!conn) {
      return Promise.resolve({
        ok: false,
        error: { code: 'mcp.unavailable', message: 'the MCP server was removed' },
      });
    }
    return conn.callTool(tool, args, opts);
  }

  readResource(serverId: string, uri: string, signal?: AbortSignal): Promise<McpToolResult> {
    const conn = this.#conns.get(serverId);
    if (!conn) {
      return Promise.resolve({
        ok: false,
        error: { code: 'mcp.unavailable', message: 'the MCP server was removed' },
      });
    }
    return conn.readResource(uri, signal);
  }

  /** Stop every server (Hub shutdown). */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#conns.values()].map((c) => c.stop()));
  }
}
