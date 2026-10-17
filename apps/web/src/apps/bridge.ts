// The host side of the MCP Apps bridge (FR-198, ADR-066; docs/08 §3.1): JSON-RPC 2.0 over
// postMessage with one sandboxed iframe. A message is read only when its source is that frame's
// window and its origin is the opaque `null` of a sandbox without allow-same-origin; it must then
// have the JSON-RPC shape before a handler sees it. A request gets exactly one answer: a
// malformed one Invalid Request, an unknown method Method not found. Nothing an app sends
// authorizes anything: tool calls still pass the policy gate (FR-189).

export type RpcId = string | number;
export type RpcParams = Record<string, unknown>;

/** JSON-RPC error codes; `refused` is the host declining (busy, nothing to fill, …). */
export const RPC = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  refused: -32000,
} as const;

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export type RpcMessage =
  | { kind: 'request'; id: RpcId; method: string; params: RpcParams }
  | { kind: 'notification'; method: string; params: RpcParams }
  | { kind: 'response'; id: RpcId }
  | { kind: 'invalid'; id: RpcId | null; code: number; reason: string };

/** Larger messages are refused unread (as serialized JSON). */
export const MESSAGE_MAX_CHARS = 1_000_000;
const METHOD_MAX = 200;
const ID_MAX = 200;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function validId(v: unknown): v is RpcId {
  return (
    (typeof v === 'string' && v.length > 0 && v.length <= ID_MAX) ||
    (typeof v === 'number' && Number.isSafeInteger(v))
  );
}

/** Check one message against the JSON-RPC 2.0 shape (no batches). */
export function parseRpc(data: unknown): RpcMessage {
  if (!isPlainObject(data)) return invalid(null, 'a message must be a JSON-RPC object');
  const id = validId(data.id) ? data.id : null;
  let size: number;
  try {
    size = JSON.stringify(data).length;
  } catch {
    return invalid(id, 'the message is not JSON');
  }
  if (size > MESSAGE_MAX_CHARS) return invalid(id, 'the message is too large');
  if (data.jsonrpc !== '2.0') return invalid(id, 'jsonrpc must be "2.0"');
  if ('id' in data && id === null) return invalid(null, 'id must be a string or an integer');
  if (!('method' in data)) {
    if (id !== null && ('result' in data || 'error' in data)) return { kind: 'response', id };
    return invalid(id, 'a request needs a method');
  }
  const method = data.method;
  if (typeof method !== 'string' || !method || method.length > METHOD_MAX)
    return invalid(id, 'method must be a short string');
  const params = data.params ?? {};
  if (!isPlainObject(params))
    return { kind: 'invalid', id, code: RPC.invalidParams, reason: 'params must be an object' };
  return id === null
    ? { kind: 'notification', method, params }
    : { kind: 'request', id, method, params };
}

function invalid(id: RpcId | null, reason: string): RpcMessage {
  return { kind: 'invalid', id, code: RPC.invalidRequest, reason };
}

export interface BridgeOptions {
  /** The app's frame; messages from any other window are ignored. */
  frame: () => HTMLIFrameElement | null;
  /** Answer a request; throw an RpcError to answer with that error. */
  onRequest: (method: string, params: RpcParams) => unknown;
  onNotification: (method: string, params: RpcParams) => void;
  /** A message was dropped or refused (diagnostics and tests). */
  onReject?: (reason: string) => void;
  /** The window the frame posts to (tests). */
  host?: Window;
}

export class HostBridge {
  readonly #opts: BridgeOptions;
  readonly #host: Window;
  readonly #listener = (event: MessageEvent) => void this.#receive(event);
  #nextId = 1;
  #started = false;

  constructor(opts: BridgeOptions) {
    this.#opts = opts;
    this.#host = opts.host ?? window;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#host.addEventListener('message', this.#listener);
  }

  stop(): void {
    this.#started = false;
    this.#host.removeEventListener('message', this.#listener);
  }

  /** A host notification to the app. */
  notify(method: string, params: RpcParams = {}): void {
    this.#post({ jsonrpc: '2.0', method, params });
  }

  /** A host request whose answer is not needed (teardown); the reply is read and dropped. */
  request(method: string, params: RpcParams = {}): void {
    this.#post({ jsonrpc: '2.0', id: `host-${this.#nextId++}`, method, params });
  }

  #post(message: Record<string, unknown>): void {
    // A sandboxed frame has an opaque origin, so the target must be `*`; the message still goes
    // only to that frame's window.
    this.#opts.frame()?.contentWindow?.postMessage(message, '*');
  }

  async #receive(event: MessageEvent): Promise<void> {
    const win = this.#opts.frame()?.contentWindow;
    if (!win || event.source !== win) return;
    if (event.origin !== 'null') {
      this.#opts.onReject?.('the frame is not on an opaque origin');
      return;
    }
    const msg = parseRpc(event.data as unknown);
    switch (msg.kind) {
      case 'invalid':
        this.#opts.onReject?.(msg.reason);
        if (msg.id !== null) this.#error(msg.id, msg.code, msg.reason);
        return;
      case 'response':
        return;
      case 'notification':
        try {
          this.#opts.onNotification(msg.method, msg.params);
        } catch (err) {
          this.#opts.onReject?.(err instanceof Error ? err.message : String(err));
        }
        return;
      case 'request':
        try {
          const result = await this.#opts.onRequest(msg.method, msg.params);
          if (this.#started) this.#post({ jsonrpc: '2.0', id: msg.id, result: result ?? {} });
        } catch (err) {
          if (!this.#started) return;
          if (err instanceof RpcError) this.#error(msg.id, err.code, err.message);
          else this.#error(msg.id, RPC.internal, 'the host could not complete the request');
        }
        return;
    }
  }

  #error(id: RpcId, code: number, message: string): void {
    this.#post({ jsonrpc: '2.0', id, error: { code, message } });
  }
}

// ---- method payloads -------------------------------------------------------------------------

/** Model context per app: 4,000 tokens at about four characters each (docs/08 §3.1). */
export const MODEL_CONTEXT_MAX_CHARS = 16_000;
/** The longest message an app may put in the composer. */
export const APP_MESSAGE_MAX_CHARS = 20_000;
/** Nova's namespaced extension: content (or a whole update) marked private stays in the browser. */
export const PRIVATE_KEY = 'nova/private';

const isPrivate = (v: unknown) =>
  isPlainObject(v) && isPlainObject(v._meta) && v._meta[PRIVATE_KEY] === true;

/**
 * Split `ui/update-model-context` params into what the model may see (text blocks and structured
 * content) and what stays private (anything marked `_meta["nova/private"]`, or the whole update
 * when its own `_meta` says so). Other block kinds are not model context and are dropped.
 */
export function splitModelContext(params: RpcParams): { visible: string; hidden: unknown[] } {
  const content = params.content ?? [];
  if (!Array.isArray(content)) throw new RpcError(RPC.invalidParams, 'content must be a list');
  const hidden: unknown[] = [];
  const visible: string[] = [];
  const all = isPrivate(params);
  for (const block of content) {
    if (!isPlainObject(block)) throw new RpcError(RPC.invalidParams, 'content blocks are objects');
    if (all || isPrivate(block)) hidden.push(block);
    else if (block.type === 'text' && typeof block.text === 'string') visible.push(block.text);
  }
  if (params.structuredContent !== undefined) {
    if (all) hidden.push(params.structuredContent);
    else visible.push(JSON.stringify(params.structuredContent));
  }
  return { visible: visible.join('\n\n').trim(), hidden };
}

/** The text of a `ui/message` (a user-role message with text content). */
export function messageText(params: RpcParams): string {
  if (params.role !== undefined && params.role !== 'user')
    throw new RpcError(RPC.invalidParams, 'an app can only suggest a user message');
  const content = Array.isArray(params.content) ? params.content : [params.content];
  const parts: string[] = [];
  for (const block of content) {
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string')
      parts.push(block.text);
  }
  const text = parts.join('\n').trim();
  if (!text) throw new RpcError(RPC.invalidParams, 'the message needs text content');
  if (text.length > APP_MESSAGE_MAX_CHARS)
    throw new RpcError(RPC.invalidParams, 'the message is too long');
  return text;
}

/** A link an app asks to open: http and https only. */
export function linkUrl(params: RpcParams): string {
  const raw = params.url;
  if (typeof raw !== 'string' || raw.length > 2000)
    throw new RpcError(RPC.invalidParams, 'url must be a string');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RpcError(RPC.invalidParams, 'url is not valid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new RpcError(RPC.invalidParams, 'only http and https links can be opened');
  return url.href;
}

/** A tool name as the last segment of its canonical name (as the MCP client sanitizes it). */
export function toolSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128) || '_';
}
