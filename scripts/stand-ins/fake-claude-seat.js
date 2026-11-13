#!/usr/bin/env node
// A stand-in for the `claude` CLI's sign-in behaviour, for Nova's seat (src/core/claude-seat.ts).
// Never calls any model or Anthropic. Its state is the folder it runs against (CLAUDE_CONFIG_DIR,
// or ~/.claude without one, as the real CLI does):
//
//   <dir>/.credentials.json  {"ok": true}   signed in: a `-p` call answers
//                            {"ok": false}  "signed in", but the grant doesn't work (as an expired one)
//                            absent          signed out (signed in, for fake-claude-seat-signed-in.js)
//   <dir>/calls.jsonl        each call's argv and the folder it ran against (never its stdin)
//   <dir>/login-gives        what a finished `auth login` writes (default {"ok": true})
//
//   claude -p …                      result event: "ok", or "Not logged in · Please run /login",
//                                     or "Failed to authenticate: OAuth session expired …"
//   claude auth status --json        {"loggedIn": …} from the file alone
//   claude auth login --claudeai     prints a sign-in address, reads "code#state" lines from stdin;
//                                     the right one (GOODCODE#STATE-<pid>) signs in and exits 0
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), '.claude');
mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ argv, dir, configDirSet: !!process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME ?? null })}\n`);
const credsPath = join(dir, '.credentials.json');
const fallback = globalThis.FAKE_CLAUDE_SIGNED_IN ? { ok: true } : null;
const creds = () => { try { return JSON.parse(readFileSync(credsPath, 'utf8')); } catch { return fallback; } };

if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(`${JSON.stringify({ loggedIn: !!creds(), authMethod: creds() ? 'claude.ai' : 'none' }, null, 2)}\n`);
  process.exit(creds() ? 0 : 1);
}

if (argv[0] === 'auth' && argv[1] === 'login') {
  const state = `STATE-${process.pid}`;
  process.stdout.write('Opening browser to sign in…\n');
  process.stdout.write(`If the browser didn't open, visit: https://claude.example/cai/oauth/authorize?code=true&client_id=stand-in&state=${state}\n`);
  process.stdout.write('Paste code here if prompted > ');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const [code, st] = line.trim().split('#');
    if (!code || !st) { process.stderr.write('Invalid code. Please make sure the full code was copied.\n'); return; }
    if (code !== 'GOODCODE' || st !== state) { process.stderr.write('Login failed: invalid authorization code\n'); process.exit(1); }
    const gives = existsSync(join(dir, 'login-gives')) ? readFileSync(join(dir, 'login-gives'), 'utf8') : '{"ok": true}';
    writeFileSync(credsPath, gives, { mode: 0o600 });
    process.stdout.write('Login successful.\n');
    process.exit(0);
  });
  rl.on('close', () => process.exit(1));
} else if (argv.includes('-p')) {
  let input = '';
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    const c = creds();
    const said = !c ? 'Not logged in · Please run /login' : c.ok ? 'ok' : 'Failed to authenticate: OAuth session expired and could not be refreshed';
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: !c?.ok, result: said, total_cost_usd: 0 })}\n`);
    process.exit(c?.ok ? 0 : 1);
  });
} else {
  process.stderr.write(`fake-claude-seat: unexpected arguments ${JSON.stringify(argv)}\n`);
  process.exit(2);
}
