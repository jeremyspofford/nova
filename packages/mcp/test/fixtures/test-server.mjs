// A small MCP server for Nova's tests and the J3 journey (FR-042, docs/18 J3). Plain Node and the
// MCP server SDK only. Run it over stdio with `node packages/mcp/test/fixtures/test-server.mjs`;
// tests also build it in process (createTestServer) and serve it over streamable HTTP.
//
// Tools: echo, add, write_note (destructive hint; writes nothing), slow (for timeouts),
// purchase_item (changes nothing). One resource (note://readme) and one prompt (greet).
//
// Options (flags or environment):
//   --tools <N> | NOVA_TEST_MCP_TOOLS=N   also register N harmless tools extra_001 … (deferral tests)
//   --test-hooks                           add test-only tools: fail, crash, add_tool, remove_tool,
//                                          media, progress
//   --apps                                 add an MCP Apps tool (show_note, `ui://notes/view`) and
//                                          client_caps (the capabilities the client sent)
//   --print-env <NAME>                     write `env NAME=<value>` to stderr at start (redaction tests)
//   --exit-on-start <code>                 exit before serving (startup failure tests)
//   --protocol <version>                   only speak this protocol version (mismatch tests)
import { realpathSync } from 'node:fs';
import { argv, env, exit, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const NOUNS = [
  'library',
  'music',
  'recipe',
  'garden',
  'invoice',
  'contact',
  'movie',
  'podcast',
  'museum',
  'bicycle',
  'chess',
  'poetry',
  'pottery',
  'stamp',
  'coin',
  'train',
  'lighthouse',
  'orchard',
  'theatre',
  'harbor',
];

// One transparent pixel, for media mapping tests.
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const object = (properties, required = Object.keys(properties)) =>
  fromJsonSchema({ type: 'object', properties, required, additionalProperties: false });

/** The extra tool descriptions are distinct; only extra_042 is about the weather (FR-196 tests). */
export function extraToolDescription(i) {
  if (i === 42) return 'Look up the weather forecast for a city';
  return `Return entry ${i} from the ${NOUNS[i % NOUNS.length]} archive`;
}

/**
 * Build the test server. `options.extraTools` adds extra_001 … extra_N; `options.testHooks` adds
 * the test-only tools; `options.protocolVersions` limits the versions it speaks.
 */
export function createTestServer(options = {}) {
  const server = new McpServer(
    { name: 'nova-test-server', version: '1.0.0' },
    options.protocolVersions ? { supportedProtocolVersions: options.protocolVersions } : {},
  );
  const log = options.log ?? ((line) => stderr.write(`${line}\n`));

  server.registerTool(
    'echo',
    {
      title: 'Echo',
      description: 'Return the given text unchanged',
      inputSchema: object({ text: { type: 'string' } }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ text: t }) => text(t),
  );
  server.registerTool(
    'add',
    {
      title: 'Add',
      description: 'Add two numbers',
      inputSchema: object({ a: { type: 'number' }, b: { type: 'number' } }),
      outputSchema: object({ sum: { type: 'number' } }),
      annotations: { readOnlyHint: true },
    },
    ({ a, b }) => ({
      content: [{ type: 'text', text: String(a + b) }],
      structuredContent: { sum: a + b },
    }),
  );
  server.registerTool(
    'write_note',
    {
      title: 'Write note',
      description: 'Save a note under a name (the test server stores nothing)',
      inputSchema: object({ name: { type: 'string' }, text: { type: 'string' } }),
      annotations: { destructiveHint: true, readOnlyHint: true },
    },
    ({ name }) => text(`saved ${name}`),
  );
  server.registerTool(
    'slow',
    {
      title: 'Slow',
      description: 'Wait the given number of milliseconds, then answer',
      inputSchema: object({ ms: { type: 'number' } }),
    },
    ({ ms }, ctx) =>
      new Promise((resolve) => {
        const signal = ctx.mcpReq.signal;
        const timer = setTimeout(() => resolve(text(`slept ${ms}`)), ms);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          log('slow cancelled');
          resolve(text('cancelled'));
        });
      }),
  );
  server.registerTool(
    'purchase_item',
    {
      title: 'Purchase item',
      description:
        'Order an item for the given price in US dollars (the test server orders nothing)',
      inputSchema: object({ item: { type: 'string' }, priceUsd: { type: 'number' } }),
      annotations: { openWorldHint: true },
    },
    ({ item }) => text(`ordered ${item}`),
  );

  for (let i = 1; i <= (options.extraTools ?? 0); i++) {
    const name = `extra_${String(i).padStart(3, '0')}`;
    server.registerTool(
      name,
      {
        description: extraToolDescription(i),
        inputSchema: object({ query: { type: 'string' } }, []),
        annotations: { readOnlyHint: true },
      },
      () => text(`${name} ok`),
    );
  }

  server.registerResource(
    'readme',
    'note://readme',
    { title: 'Readme', description: 'About this test server', mimeType: 'text/plain' },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Nova test server' }] }),
  );
  server.registerPrompt(
    'greet',
    {
      title: 'Greet',
      description: 'Greet someone by name',
      argsSchema: object({ name: { type: 'string' } }),
    },
    ({ name }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Say hello to ${name}` } }],
    }),
  );

  if (options.testHooks) addTestHooks(server, log);
  if (options.apps) addApps(server);
  return server;
}

/** An MCP Apps tool and its `ui://` resource (FR-198 tests). */
function addApps(server) {
  server.registerTool(
    'show_note',
    {
      title: 'Show note',
      description: 'Show a note in an app view',
      inputSchema: object({ name: { type: 'string' } }),
      _meta: { ui: { resourceUri: 'ui://notes/view' } },
    },
    ({ name }) => text(`note ${name}`),
  );
  server.registerTool(
    'client_caps',
    { description: 'Return the capabilities the client sent at initialize' },
    () => text(JSON.stringify(server.server.getClientCapabilities() ?? {})),
  );
  server.registerResource(
    'note-view',
    'ui://notes/view',
    { title: 'Note view', mimeType: 'text/html;profile=mcp-app' },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/html;profile=mcp-app',
          text: '<!doctype html><title>Note</title><p>note</p>',
          _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] } } },
        },
      ],
    }),
  );
}

function addTestHooks(server, log) {
  const added = new Map();
  server.registerTool(
    'fail',
    {
      description: 'Report a tool error with the given message',
      inputSchema: object({ message: { type: 'string' } }),
    },
    ({ message }) => ({ content: [{ type: 'text', text: message }], isError: true }),
  );
  server.registerTool(
    'crash',
    {
      description: 'Exit the server process',
      inputSchema: object({ code: { type: 'number' } }, []),
    },
    ({ code }) => {
      log('crashing');
      setImmediate(() => exit(code ?? 1));
      return text('bye');
    },
  );
  server.registerTool(
    'add_tool',
    {
      description: 'Register another tool and announce the list change',
      inputSchema: object({ name: { type: 'string' } }),
    },
    ({ name }) => {
      added.set(
        name,
        server.registerTool(name, { description: `Added tool ${name}` }, () => text(name)),
      );
      return text(`added ${name}`);
    },
  );
  server.registerTool(
    'remove_tool',
    {
      description: 'Remove a tool added with add_tool',
      inputSchema: object({ name: { type: 'string' } }),
    },
    ({ name }) => {
      added.get(name)?.remove();
      added.delete(name);
      return text(`removed ${name}`);
    },
  );
  server.registerTool('media', { description: 'Return one block of every content type' }, () => ({
    content: [
      { type: 'text', text: 'caption' },
      { type: 'image', data: PIXEL, mimeType: 'image/png' },
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      { type: 'resource_link', uri: 'note://readme', name: 'readme' },
      {
        type: 'resource',
        resource: { uri: 'note://inline', mimeType: 'text/plain', text: 'inline' },
      },
      {
        type: 'resource',
        resource: { uri: 'note://blob', mimeType: 'application/zip', blob: 'AAAA' },
      },
    ],
  }));
  server.registerTool(
    'progress',
    {
      description: 'Report progress a few times, then answer',
      inputSchema: object({ steps: { type: 'number' } }),
    },
    async ({ steps }, ctx) => {
      const token = ctx.mcpReq._meta?.progressToken;
      for (let i = 1; i <= steps; i++) {
        if (token !== undefined) {
          await ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken: token, progress: i, total: steps, message: `step ${i}` },
          });
          // Keep working a moment after each report, as a real tool would: progress that
          // arrives after the result is dropped by the client, which made this racy.
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      return text(`done ${steps}`);
    },
  );
}

function flag(name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

async function main() {
  const exitCode = flag('--exit-on-start');
  if (exitCode !== undefined) {
    stderr.write('exiting on start\n');
    exit(Number(exitCode) || 1);
  }
  const printEnv = flag('--print-env');
  if (printEnv) stderr.write(`env ${printEnv}=${env[printEnv] ?? ''}\n`);
  const protocol = flag('--protocol');
  const server = createTestServer({
    extraTools: Number(flag('--tools') ?? env.NOVA_TEST_MCP_TOOLS ?? 0) || 0,
    testHooks: flag('--test-hooks') !== undefined,
    apps: flag('--apps') !== undefined,
    ...(protocol ? { protocolVersions: [protocol] } : {}),
  });
  await server.connect(new StdioServerTransport());
  stderr.write('test server ready\n');
}

// Serve only when run directly (tests import createTestServer); compare real paths, since the
// module URL is resolved through symlinks and argv[1] is not.
if (argv[1] && fileURLToPath(import.meta.url) === realpathSync(argv[1])) {
  main().catch((err) => {
    stderr.write(`test server failed: ${err instanceof Error ? err.message : String(err)}\n`);
    exit(1);
  });
}
