// A dependency-free stdio MCP server for Nova's sample bundle (FR-199). It speaks newline-delimited
// JSON-RPC: initialize, ping, tools/list and tools/call for two tools. It never reveals the
// configured key; settings_check only says whether one is set.
import { createInterface } from 'node:readline';

const VERSIONS = ['2025-11-25'];
const TOOLS = [
  {
    name: 'greet',
    description: 'Greet someone by name',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'settings_check',
    description: 'Report which settings are set',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const text = (t) => ({ content: [{ type: 'text', text: t }] });

function call(name, args) {
  if (name === 'greet') {
    const who = typeof args?.name === 'string' && args.name ? args.name : 'there';
    return text(`${process.env.HELLO_GREETING || 'Hello'}, ${who}!`);
  }
  if (name === 'settings_check') {
    const key = process.env.HELLO_API_KEY ?? '';
    return text(key ? `an API key is set (${key.length} characters)` : 'no API key is set');
  }
  return null;
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications need no answer
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      send({
        id,
        result: {
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'nova-hello', version: '1.0.0' },
        },
      });
      return;
    }
    case 'ping':
      send({ id, result: {} });
      return;
    case 'tools/list':
      send({ id, result: { tools: TOOLS } });
      return;
    case 'tools/call': {
      const result = call(params?.name, params?.arguments);
      if (result) send({ id, result });
      else send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      return;
    }
    default:
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  handle(msg);
});
