#!/usr/bin/env node
// The `nova` command (FR-117, FR-044, FR-105; ADR-097 D1). Usage: `nova help`. The Hub and the
// owner's token come from NOVA_URL and NOVA_TOKEN, never from the command line.
import { runCli } from './cli.ts';

const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
const code = await runCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdin: process.stdin,
  stdoutStream: process.stdout,
  signal: stop.signal,
});
process.exit(code);
