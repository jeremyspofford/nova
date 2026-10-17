// Mapping MCP results and failures to Nova tool results (docs/08 §1.2).
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { mapBlock, mapCallError, mapCallResult } from '../src/index.ts';

describe('content mapping', () => {
  it('maps blocks', () => {
    expect(mapBlock({ type: 'text', text: 'hi' })).toEqual({ type: 'text', text: 'hi' });
    expect(mapBlock({ type: 'image', data: 'AA' })).toEqual({
      type: 'image',
      mime: 'application/octet-stream',
      data: 'AA',
    });
    expect(
      mapBlock({ type: 'resource', resource: { uri: 'u', mimeType: 'image/png', blob: 'B' } }),
    ).toEqual({ type: 'image', mime: 'image/png', data: 'B' });
    expect(mapBlock({ type: 'resource', resource: { uri: 'u', blob: 'B' } })).toEqual({
      type: 'text',
      text: '[resource u (binary) omitted]',
    });
    expect(mapBlock({ type: 'video' })).toEqual({
      type: 'text',
      text: '[unsupported content video omitted]',
    });
    expect(mapBlock(null)).toEqual({ type: 'text', text: '[unsupported content block omitted]' });
  });

  it('does not repeat structured content already given as JSON text', () => {
    const r = mapCallResult(
      { content: [{ type: 'text', text: '{ "sum": 5 }' }], structuredContent: { sum: 5 } },
      { tool: 'add' },
    );
    expect(r).toEqual({
      ok: true,
      content: [{ type: 'text', text: '{ "sum": 5 }' }],
      meta: { tool: 'add', structuredContent: { sum: 5 } },
    });
    expect(mapCallResult({}, {})).toEqual({ ok: true, content: [], meta: {} });
  });

  it('turns isError into a failed result', () => {
    expect(mapCallResult({ isError: true, content: [] }, { tool: 't' })).toEqual({
      ok: false,
      error: {
        code: 'mcp.tool_error',
        message: 'the tool reported an error',
        details: { tool: 't' },
      },
    });
    const long = mapCallResult(
      { isError: true, content: [{ type: 'text', text: 'x'.repeat(5000) }] },
      {},
    );
    expect(!long.ok && long.error.message).toHaveLength(2000);
  });

  it('maps call failures', () => {
    const ctx = { tool: 't', timeoutMs: 10, cancelled: false };
    const code = (err: unknown, c = ctx) => {
      const r = mapCallError(err, c);
      return r.ok ? null : r.error.code;
    };
    expect(code(new SdkError(SdkErrorCode.RequestTimeout, 'x'))).toBe('mcp.timeout');
    expect(code(new SdkError(SdkErrorCode.ConnectionClosed, 'x'))).toBe('mcp.unavailable');
    expect(code(new SdkError(SdkErrorCode.InvalidResult, 'x'))).toBe('mcp.client_error');
    expect(code(new ProtocolError(-32602, 'bad'))).toBe('mcp.protocol_error');
    expect(code(new Error('boom'))).toBe('mcp.client_error');
    expect(code('weird')).toBe('mcp.client_error');
    expect(code(new SdkError(SdkErrorCode.RequestTimeout, 'x'), { ...ctx, cancelled: true })).toBe(
      'mcp.cancelled',
    );
  });
});
