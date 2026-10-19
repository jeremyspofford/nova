#!/usr/bin/env node
// `nova mcp stdio` (FR-044): run Nova's MCP server for a stdio-only client. Usage:
//   node packages/mcp/src/launcher-main.ts mcp stdio [--url URL] [--token-file FILE]
// The endpoint comes from --url or NOVA_MCP_URL; the client's token from NOVA_MCP_TOKEN or a file
// (--token-file or NOVA_MCP_TOKEN_FILE). Diagnostics go to stderr; stdout carries only JSON-RPC.
import { launcherConfig, runStdioLauncher } from './stdio-launcher.ts';

const argv = process.argv.slice(2);
if (argv[0] !== 'mcp' || argv[1] !== 'stdio') {
  process.stderr.write('usage: nova mcp stdio [--url URL] [--token-file FILE]\n');
  process.exit(2);
}
let config: { url: string; token: string };
try {
  config = launcherConfig(argv.slice(2), process.env);
} catch (err) {
  process.stderr.write(`nova mcp stdio: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
await runStdioLauncher({
  ...config,
  stdin: process.stdin,
  stdout: process.stdout,
  log: (line) => process.stderr.write(`${line}\n`),
});
process.exit(0);
