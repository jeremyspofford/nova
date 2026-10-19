// Nova as an Agent Client Protocol client (FR-203): the handshake, one session, prompts and
// cancellation, and the agent's requests dispatched to an AcpHost. The host is where Nova's
// policy applies (host.ts): this file only validates and routes. Nova advertises the file system
// and terminal capabilities, so a conforming agent reads, writes and runs commands through Nova,
// and its sandbox gives it no other way to change the project.
import type { Logger } from '@nova/telemetry';
import {
  JsonRpcError,
  JsonRpcPeer,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
} from './jsonrpc.ts';
import type { LineTransport } from './jsonrpc.ts';
import {
  ACP_PROTOCOL_VERSION,
  createTerminalSchema,
  initializeResultSchema,
  newSessionResultSchema,
  promptResultSchema,
  readTextFileSchema,
  requestPermissionSchema,
  sessionUpdateSchema,
  terminalRefSchema,
  textPrompt,
  writeTextFileSchema,
  type CreateTerminalRequest,
  type InitializeResult,
  type PermissionRequest,
  type ReadTextFileRequest,
  type SessionUpdate,
  type StopReason,
  type WriteTextFileRequest,
} from './protocol.ts';

/** How the client answers a permission request. */
export type PermissionAnswer = 'allow' | 'reject' | 'cancelled';

export interface TerminalOutput {
  output: string;
  truncated: boolean;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
}

/** What the agent may ask of Nova; every method goes through Nova's policy engine. */
export interface AcpHost {
  requestPermission(req: PermissionRequest): Promise<PermissionAnswer>;
  readTextFile(req: ReadTextFileRequest): Promise<string>;
  writeTextFile(req: WriteTextFileRequest): Promise<void>;
  createTerminal(req: CreateTerminalRequest): Promise<string>;
  terminalOutput(terminalId: string): Promise<TerminalOutput>;
  waitForExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null }>;
  killTerminal(terminalId: string): Promise<void>;
  releaseTerminal(terminalId: string): Promise<void>;
}

export interface AcpClientOptions {
  transport: LineTransport;
  host: AcpHost;
  onUpdate?: (u: SessionUpdate) => void;
  /** Time for the handshake and session start (default 30 s). */
  startTimeoutMs?: number;
  /** Time the agent has to finish after a cancel (default 10 s). */
  cancelGraceMs?: number;
  clientInfo?: { name: string; version: string };
  log?: Logger;
}

/** Why an agent was refused at the handshake. */
export class AgentRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRefused';
  }
}

export class AcpClient {
  readonly #o: AcpClientOptions;
  readonly #peer: JsonRpcPeer;
  #session: string | null = null;
  /** Requests the agent made, by method (counted for the delegation's record). */
  readonly counts = { permission: 0, operations: 0 };

  constructor(opts: AcpClientOptions) {
    this.#o = opts;
    this.#peer = new JsonRpcPeer({
      transport: opts.transport,
      onRequest: (method, params) => this.#onRequest(method, params),
      onNotification: (method, params) => this.#onNotification(method, params),
      ...(opts.log ? { log: opts.log } : {}),
    });
  }

  get sessionId(): string | null {
    return this.#session;
  }

  /** Lines from the agent that were not protocol messages. */
  get ignoredLines(): number {
    return this.#peer.ignored;
  }

  /** The handshake: protocol version 1, Nova's file system and terminal capabilities. */
  async initialize(): Promise<InitializeResult> {
    const raw = await this.#peer.request(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: this.#o.clientInfo ?? { name: 'nova', version: '0' },
      },
      { timeoutMs: this.#o.startTimeoutMs ?? 30_000 },
    );
    const r = initializeResultSchema.safeParse(raw);
    if (!r.success) throw new AgentRefused('the agent answered the handshake with something else');
    if (r.data.protocolVersion !== ACP_PROTOCOL_VERSION)
      throw new AgentRefused(
        `the agent speaks protocol version ${r.data.protocolVersion}; Nova speaks ${ACP_PROTOCOL_VERSION}`,
      );
    return r.data;
  }

  async newSession(cwd: string): Promise<string> {
    const raw = await this.#peer.request(
      'session/new',
      { cwd, mcpServers: [] },
      { timeoutMs: this.#o.startTimeoutMs ?? 30_000 },
    );
    const r = newSessionResultSchema.safeParse(raw);
    if (!r.success) throw new AgentRefused('the agent did not start a session');
    this.#session = r.data.sessionId;
    return r.data.sessionId;
  }

  /** Send the prompt and wait for the turn to end; aborting cancels it (session/cancel). */
  async prompt(text: string, signal: AbortSignal): Promise<StopReason> {
    const sessionId = this.#session;
    if (!sessionId) throw new Error('no session');
    const answer = this.#peer.request('session/prompt', { sessionId, prompt: textPrompt(text) });
    const onAbort = () => this.#peer.notify('session/cancel', { sessionId });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) onAbort();
      // After a cancel the agent should answer `cancelled`; it gets a grace period, then it is
      // treated as cancelled anyway (the process is stopped by the caller).
      const abortGrace = new Promise<'grace'>((resolve) => {
        const fire = () =>
          setTimeout(() => resolve('grace'), this.#o.cancelGraceMs ?? 10_000).unref?.();
        if (signal.aborted) fire();
        else signal.addEventListener('abort', fire, { once: true });
      });
      const raw = await Promise.race([answer, abortGrace]);
      if (raw === 'grace') return 'cancelled';
      const r = promptResultSchema.safeParse(raw);
      if (!r.success) throw new AgentRefused('the agent ended the turn with something else');
      return r.data.stopReason;
    } finally {
      signal.removeEventListener('abort', onAbort);
      answer.catch(() => undefined);
    }
  }

  close(reason?: string): Promise<void> {
    return this.#peer.close(reason);
  }

  #params<T>(
    schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
    params: unknown,
  ): T {
    const r = schema.safeParse(params);
    if (!r.success) throw new JsonRpcError(JSONRPC_INVALID_PARAMS, 'invalid parameters');
    const sid = (r.data as { sessionId?: unknown }).sessionId;
    if (sid !== this.#session) throw new JsonRpcError(JSONRPC_INVALID_PARAMS, 'unknown session');
    return r.data;
  }

  async #onRequest(method: string, params: unknown): Promise<unknown> {
    const host = this.#o.host;
    switch (method) {
      case 'session/request_permission': {
        const p = this.#params(requestPermissionSchema, params);
        this.counts.permission++;
        const answer = await host.requestPermission(p);
        return { outcome: pickOption(p, answer) };
      }
      case 'fs/read_text_file': {
        const p = this.#params(readTextFileSchema, params);
        this.counts.operations++;
        return { content: await host.readTextFile(p) };
      }
      case 'fs/write_text_file': {
        const p = this.#params(writeTextFileSchema, params);
        this.counts.operations++;
        await host.writeTextFile(p);
        return {};
      }
      case 'terminal/create': {
        const p = this.#params(createTerminalSchema, params);
        this.counts.operations++;
        return { terminalId: await host.createTerminal(p) };
      }
      case 'terminal/output': {
        const p = this.#params(terminalRefSchema, params);
        const out = await host.terminalOutput(p.terminalId);
        return { output: out.output, truncated: out.truncated, exitStatus: out.exitStatus };
      }
      case 'terminal/wait_for_exit': {
        const p = this.#params(terminalRefSchema, params);
        return await host.waitForExit(p.terminalId);
      }
      case 'terminal/kill': {
        const p = this.#params(terminalRefSchema, params);
        this.counts.operations++;
        await host.killTerminal(p.terminalId);
        return {};
      }
      case 'terminal/release': {
        const p = this.#params(terminalRefSchema, params);
        await host.releaseTerminal(p.terminalId);
        return {};
      }
      default:
        throw new JsonRpcError(
          JSONRPC_METHOD_NOT_FOUND,
          `Nova does not offer ${method.slice(0, 100)}`,
        );
    }
  }

  #onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return;
    const r = sessionUpdateSchema.safeParse(params);
    if (!r.success || r.data.sessionId !== this.#session) return;
    this.#o.onUpdate?.(r.data.update);
  }
}

/**
 * The option that carries Nova's answer. An allow is always `allow_once`: Nova's own grants
 * decide what is remembered, never the agent. With no such option the answer is a reject.
 */
export function pickOption(
  p: PermissionRequest,
  answer: PermissionAnswer,
): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  if (answer === 'cancelled') return { outcome: 'cancelled' };
  if (answer === 'allow') {
    const once = p.options.find((o) => o.kind === 'allow_once');
    if (once) return { outcome: 'selected', optionId: once.optionId };
  }
  const reject =
    p.options.find((o) => o.kind === 'reject_once') ??
    p.options.find((o) => o.kind === 'reject_always');
  return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
}
