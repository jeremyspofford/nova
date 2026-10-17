// The sample plugin's MCP server (docs/18 J4), built with the MCP server SDK over stdio.
//
// Tools:
//   fetch_status {url}   reports the host it would check; it makes no network request
//   panel_action {value} records an action from the panel (rendered by ui://sample/panel)
// Resource:
//   ui://sample/panel    the MCP App panel, served from ../ui/panel.html
//
// An installed copy runs from Nova's data folder, outside any node_modules folder. Nova sets
// NODE_PATH to the folder of its own packages for Node plugin servers, and require() honours it,
// so the SDK is loaded with require rather than import.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { stderr } from 'node:process';

const require = createRequire(import.meta.url);
const { McpServer, fromJsonSchema } = require('@modelcontextprotocol/server');
const { StdioServerTransport } = require('@modelcontextprotocol/server/stdio');

const PANEL_URI = 'ui://sample/panel';
const APP_MIME = 'text/html;profile=mcp-app';
const PANEL_FILE = new URL('../ui/panel.html', import.meta.url);
// The panel may reach only the plugin's declared host (intersected with its network permission).
const PANEL_META = { ui: { csp: { connectDomains: ['https://api.example.com'] } } };

const text = (t, structured) => ({
  content: [{ type: 'text', text: t }],
  ...(structured ? { structuredContent: structured } : {}),
});
const object = (properties) =>
  fromJsonSchema({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });

export function createSampleServer() {
  const server = new McpServer({ name: 'nova-sample-plugin', version: '1.0.0' });

  server.registerTool(
    'fetch_status',
    {
      title: 'Fetch status',
      description:
        'Check whether a service URL is up (the sample reports the host and fetches nothing)',
      inputSchema: object({ url: { type: 'string', description: 'The https URL to check' } }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ url }) => {
      let host;
      try {
        host = new URL(url).hostname;
      } catch {
        return { content: [{ type: 'text', text: `Not a URL: ${url}` }], isError: true };
      }
      return text(`Would check ${host}; the sample server makes no network requests.`, { host });
    },
  );

  server.registerTool(
    'panel_action',
    {
      title: 'Panel action',
      description: 'Record an action chosen in the sample panel',
      inputSchema: object({ value: { type: 'string', description: 'What the panel sent' } }),
      _meta: { ui: { resourceUri: PANEL_URI } },
    },
    ({ value }) => text(`Panel action recorded: ${value}`, { value }),
  );

  server.registerResource(
    'panel',
    PANEL_URI,
    {
      title: 'Sample panel',
      description: 'A small MCP App that calls panel_action',
      mimeType: APP_MIME,
      _meta: PANEL_META,
    },
    async (uri) => {
      let html;
      try {
        html = await readFile(PANEL_FILE, 'utf8');
      } catch {
        html =
          '<!doctype html><meta charset="utf-8"><title>Sample panel</title><p>The panel file is missing.</p>';
      }
      return { contents: [{ uri: uri.href, mimeType: APP_MIME, text: html, _meta: PANEL_META }] };
    },
  );

  return server;
}

const server = createSampleServer();
await server.connect(new StdioServerTransport());
stderr.write('sample plugin server ready\n');
