// Map MCP tool results and failures onto Nova's tool result (docs/08 §1.2). The output is
// untrusted data; the tool runtime labels it as such before a model sees it (FR-103).
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import type { ContentPart } from '@nova/providers';

export type McpToolResult =
  | { ok: true; content: ContentPart[]; meta?: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** The parts of an MCP `CallToolResult` this module reads. */
export interface McpCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

const ERROR_TEXT_MAX = 2000;

/** One MCP content block as Nova content (text and images; other kinds are described in text). */
export function mapBlock(block: unknown): ContentPart {
  const b = (block ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (b.type) {
    case 'text':
      return { type: 'text', text: str(b.text) };
    case 'image':
      return {
        type: 'image',
        mime: str(b.mimeType) || 'application/octet-stream',
        data: str(b.data),
      };
    case 'audio':
      return { type: 'text', text: `[audio ${str(b.mimeType) || 'unknown'} omitted]` };
    case 'resource_link':
      return { type: 'text', text: `[resource ${str(b.name) || str(b.uri)}: ${str(b.uri)}]` };
    case 'resource': {
      const r = (b.resource ?? {}) as Record<string, unknown>;
      const mime = str(r.mimeType);
      if (typeof r.text === 'string')
        return { type: 'text', text: `[resource ${str(r.uri)}]\n${r.text}` };
      if (typeof r.blob === 'string' && mime.startsWith('image/'))
        return { type: 'image', mime, data: r.blob };
      return { type: 'text', text: `[resource ${str(r.uri)} (${mime || 'binary'}) omitted]` };
    }
    default:
      return { type: 'text', text: `[unsupported content ${str(b.type) || 'block'} omitted]` };
  }
}

/**
 * A completed call. `isError` becomes `ok: false` with the server's text as the message;
 * structured content is passed as JSON text (unless a text block already carries it) and in
 * `meta.structuredContent`.
 */
export function mapCallResult(res: McpCallResult, meta: Record<string, unknown>): McpToolResult {
  const content = (res.content ?? []).map(mapBlock);
  if (res.isError) {
    const message = content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
      .slice(0, ERROR_TEXT_MAX);
    return {
      ok: false,
      error: {
        code: 'mcp.tool_error',
        message: message || 'the tool reported an error',
        details: meta,
      },
    };
  }
  const out: Record<string, unknown> = { ...meta };
  if (res.structuredContent !== undefined) {
    out.structuredContent = res.structuredContent;
    if (!content.some((p) => p.type === 'text' && sameJson(p.text, res.structuredContent)))
      content.push({ type: 'text', text: JSON.stringify(res.structuredContent) });
  }
  return { ok: true, content, meta: out };
}

function sameJson(text: string, value: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
  } catch {
    return false;
  }
}

/** A call that did not complete: cancelled, timed out, refused by the server or disconnected. */
export function mapCallError(
  err: unknown,
  ctx: { tool: string; timeoutMs: number; cancelled: boolean },
): McpToolResult {
  const fail = (code: string, message: string, details?: unknown): McpToolResult => ({
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  });
  if (ctx.cancelled) return fail('mcp.cancelled', `${ctx.tool} was cancelled`);
  if (err instanceof SdkError) {
    switch (err.code) {
      case SdkErrorCode.RequestTimeout:
        return fail('mcp.timeout', `${ctx.tool} did not answer within ${ctx.timeoutMs} ms`);
      case SdkErrorCode.ConnectionClosed:
      case SdkErrorCode.NotConnected:
      case SdkErrorCode.SendFailed:
        return fail('mcp.unavailable', `the server disconnected during ${ctx.tool}`);
      default:
        return fail('mcp.client_error', err.message, { sdkCode: err.code });
    }
  }
  if (err instanceof ProtocolError) {
    return fail('mcp.protocol_error', err.message, { rpcCode: err.code });
  }
  return fail('mcp.client_error', err instanceof Error ? err.message : String(err));
}
