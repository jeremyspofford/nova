// A stdio MCP server that runs on a device (FR-042 `deviceId`, FR-210): the Hub reaches it
// through `novad`, which exposes the device's own MCP servers by name under the device's grants.
// This transport stands in for the process: it answers the MCP client's `initialize`, and turns
// `tools/list` and `tools/call` into the device bridge's list and call. Everything else the
// client asks is "method not found", so resources and prompts of device servers are not listed.
// The Hub never sends a command line to a device: the server's `command` names the server as the
// device lists it, and the device's own configuration starts it.
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';

/** One tool of a device's MCP server, as `novad` reports it. */
export interface DeviceMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** How the Hub reaches device-hosted MCP servers (the devices area wires it). */
export interface DeviceMcpBridge {
  list(
    target: { accountId: string; deviceId: string; server: string },
    signal: AbortSignal,
  ): Promise<DeviceMcpTool[]>;
  call(
    target: { accountId: string; deviceId: string; server: string },
    call: { tool: string; arguments: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<{ content: unknown[]; isError: boolean }>;
}

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

function cleanTool(t: unknown): Record<string, unknown> | null {
  if (!t || typeof t !== 'object') return null;
  const r = t as Record<string, unknown>;
  if (typeof r.name !== 'string' || !r.name || r.name.length > 128) return null;
  const schema =
    r.inputSchema && typeof r.inputSchema === 'object' && !Array.isArray(r.inputSchema)
      ? (r.inputSchema as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = { name: r.name, inputSchema: { ...schema, type: 'object' } };
  if (typeof r.title === 'string') out.title = r.title;
  if (typeof r.description === 'string') out.description = r.description;
  if (r.annotations && typeof r.annotations === 'object') out.annotations = { ...r.annotations };
  return out;
}

export function deviceTransport(
  bridge: DeviceMcpBridge,
  target: { accountId: string; deviceId: string; server: string },
): Transport {
  const stop = new AbortController();
  let closed = false;
  const t: Transport = {
    start: () => Promise.resolve(),
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      stop.abort();
      t.onclose?.();
      return Promise.resolve();
    },
    send: (message: JSONRPCMessage) => {
      const m = message as { id?: string | number; method?: string; params?: unknown };
      if (closed || m.id === undefined || typeof m.method !== 'string') return Promise.resolve();
      const id = m.id;
      const reply = (body: { result: unknown } | { error: { code: number; message: string } }) => {
        if (closed) return;
        queueMicrotask(() =>
          t.onmessage?.({ jsonrpc: '2.0', id, ...body } as unknown as JSONRPCMessage),
        );
      };
      const params = (m.params ?? {}) as Record<string, unknown>;
      switch (m.method) {
        case 'initialize':
          reply({
            result: {
              protocolVersion:
                typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: `device:${target.server}`, version: '0' },
            },
          });
          break;
        case 'ping':
          reply({ result: {} });
          break;
        case 'tools/list':
          void bridge.list(target, stop.signal).then(
            (tools) => reply({ result: { tools: tools.flatMap((x) => cleanTool(x) ?? []) } }),
            (err: unknown) =>
              reply({
                error: {
                  code: INTERNAL_ERROR,
                  message: `the device did not list its tools: ${err instanceof Error ? err.message : String(err)}`,
                },
              }),
          );
          break;
        case 'tools/call': {
          const name = typeof params.name === 'string' ? params.name : '';
          const args =
            params.arguments &&
            typeof params.arguments === 'object' &&
            !Array.isArray(params.arguments)
              ? (params.arguments as Record<string, unknown>)
              : {};
          void bridge.call(target, { tool: name, arguments: args }, stop.signal).then(
            (r) => reply({ result: { content: r.content, isError: r.isError } }),
            (err: unknown) =>
              reply({
                result: {
                  content: [
                    {
                      type: 'text',
                      text: `The device could not run the tool: ${err instanceof Error ? err.message : String(err)}`,
                    },
                  ],
                  isError: true,
                },
              }),
          );
          break;
        }
        default:
          reply({ error: { code: METHOD_NOT_FOUND, message: `Method not found: ${m.method}` } });
      }
      return Promise.resolve();
    },
  };
  return t;
}
