#!/usr/bin/env node
// The supervisor's command line (M7 plan §2).
//
//   node src/supervisor/main.ts run       [--home DIR] [--dir DIR] [--repo DIR] [--tests "CMD"] [--canary-s N]
//   node src/supervisor/main.ts status    [--dir DIR]
//   node src/supervisor/main.ts releases  [--dir DIR]
//   node src/supervisor/main.ts deploy <version> [--confirm <version>]
//   node src/supervisor/main.ts rollback  [--confirm]
//   node src/supervisor/main.ts recover   leave safe mode and start Nova again
//
// `run` keeps the Nova server running (restarts, safe mode, health checks) and takes deploys.
// Deploying is tier 3: it asks you to type the version, every time, unless --confirm repeats it.
// --dir holds the supervisor's state, its control socket and the release slots
// (default ~/.nova-supervisor, or NOVA_SUPERVISOR_DIR). --repo is the git repository whose tags
// are releases (default: this checkout).
import { connect } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CODE_ROOT, type SupervisorState } from '../core/index.ts';
import { loadConfig } from '../config.js';
import { BASE, DEFAULT_TIMINGS, Supervisor, type Timings } from './supervisor.ts';

interface Args { cmd: string; pos: string[]; flags: Record<string, string | true> }

export function parse(argv: string[]): Args {
  const [cmd = 'help', ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);
const dirOf = (a: Args) => resolve(str(a.flags.dir) ?? process.env.NOVA_SUPERVISOR_DIR ?? join(homedir(), '.nova-supervisor'));

function readState(dir: string): SupervisorState | null {
  try { return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as SupervisorState; } catch { return null; }
}

// One request to the running supervisor; progress lines are printed as they come.
function ask(dir: string, req: Record<string, unknown>): Promise<{ ok: boolean; said: string }> {
  return new Promise((done) => {
    const sock = connect(join(dir, 'control.sock'));
    let buf = '';
    let settled = false;
    const finish = (r: { ok: boolean; said: string }) => { if (!settled) { settled = true; done(r); } };
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on('data', (d) => {
      buf += String(d);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const m = JSON.parse(line) as { said?: string; done?: boolean; ok?: boolean };
          if (m.done) finish({ ok: m.ok === true, said: String(m.said ?? '') });
          else if (m.said) process.stdout.write(`${m.said}\n`);
        } catch { /* not ours */ }
      }
    });
    sock.on('error', (e) => finish({ ok: false, said: `The supervisor isn’t running with ${dir} (${(e as NodeJS.ErrnoException).code ?? e.message}). Start it with: node src/supervisor/main.ts run` }));
    sock.on('close', () => finish({ ok: false, said: 'The supervisor closed the connection.' }));
  });
}

async function confirm(question: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim() === expected; } finally { rl.close(); }
}

function describe(s: SupervisorState): string {
  const name = (v: string | null) => (!v ? 'none' : v === BASE ? 'the code the supervisor started from' : v);
  const lines = [
    `Nova: ${s.mode.replace('_', ' ')}${s.server.port ? ` on port ${s.server.port}` : ''}${s.server.restarts ? `, restarted ${s.server.restarts} time${s.server.restarts === 1 ? '' : 's'}` : ''}.`,
    ...(s.safe_mode ? [`Held in safe mode since ${s.safe_mode.at}: ${s.safe_mode.reason}`, s.safe_mode.last_good ? `The last good release is ${s.safe_mode.last_good}.` : ''] : []),
    `Release: ${name(s.releases.current)}. Previous: ${name(s.releases.previous)}. Last good: ${name(s.releases.last_good)}.`,
    ...(s.deploy ? [`Last deploy: ${s.deploy.version} (${s.deploy.outcome ?? 'running'}), at ${s.deploy.stage}.`] : []),
    s.health.last_ok_at ? `Last healthy answer: ${s.health.last_ok_at}.` : 'No health check has answered yet.',
  ];
  return lines.filter(Boolean).join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parse(argv);
  const dir = dirOf(a);
  if (a.cmd === 'run') {
    // Only the home is needed here. A setting the server would refuse is the server's to say (and,
    // if it keeps refusing, safe mode's), so the supervisor still starts.
    let configured: string;
    try { configured = loadConfig().home; } catch { configured = process.env.NOVA_HOME ?? join(homedir(), 'Nova'); }
    const home = resolve(str(a.flags.home) ?? configured);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^NOVA_(SUPERVISOR_|SANDBOX|SUPERVISED)/.test(k)) env[k] = v;
    let timings: Partial<Timings> = {};
    if (process.env.NOVA_SUPERVISOR_TIMINGS) timings = JSON.parse(process.env.NOVA_SUPERVISOR_TIMINGS) as Partial<Timings>;
    if (str(a.flags['canary-s'])) timings.canaryMs = Number(a.flags['canary-s']) * 1000;
    const tests = str(a.flags.tests) ?? process.env.NOVA_RELEASE_TESTS ?? 'npm test';
    const sup = new Supervisor({
      dir, home, repo: resolve(str(a.flags.repo) ?? CODE_ROOT), base: CODE_ROOT, env, tests: tests.split(/\s+/).filter(Boolean), timings,
      echo: (s) => process.stdout.write(s), log: (s) => process.stdout.write(s),
    });
    try {
      await sup.run();
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
    process.stdout.write(`[supervisor] Supervising Nova for ${home} (state in ${dir}; health every ${Math.round((sup.t.healthEveryMs ?? DEFAULT_TIMINGS.healthEveryMs) / 1000)} s).\n`);
    await new Promise<void>((done) => {
      const quit = () => { void sup.close().then(done); };
      process.once('SIGTERM', quit);
      process.once('SIGINT', quit);
    });
    return 0;
  }
  if (a.cmd === 'status' || a.cmd === 'releases') {
    const s = readState(dir);
    if (!s) { process.stdout.write(`No supervisor state in ${dir}.\n`); return 1; }
    if (a.flags.json) { process.stdout.write(`${JSON.stringify(s, null, 2)}\n`); return 0; }
    if (a.cmd === 'status') { process.stdout.write(`${describe(s)}\n`); return 0; }
    const rows = s.releases.slots.map((r) => `${r.version === s.releases.current ? '*' : ' '} ${r.version}  ${r.status}  ${r.commit?.slice(0, 12) ?? ''}${r.migration ? `  database ${r.migration.from} → ${r.migration.to}` : ''}`);
    process.stdout.write(`${rows.length ? rows.join('\n') : 'No releases deployed yet.'}\n${s.history.slice(0, 10).map((h) => `${h.at}  ${h.version}: ${h.outcome}. ${h.said}`).join('\n')}\n`);
    return 0;
  }
  if (a.cmd === 'deploy') {
    const version = a.pos[0];
    if (!version) { process.stderr.write('Which release? node src/supervisor/main.ts deploy <version>\n'); return 2; }
    // Tier 3: confirmed every time, by typing the version (or repeating it with --confirm).
    const ok = str(a.flags.confirm) === version || await confirm(`Deploying ${version} changes Nova itself (tier 3). Type the version to go ahead: `, version);
    if (!ok) { process.stderr.write('Not deployed: it needs your explicit confirmation (type the version, or pass --confirm <version>).\n'); return 2; }
    const r = await ask(dir, { cmd: 'deploy', version, confirm: true });
    process.stdout.write(`${r.said}\n`);
    return r.ok ? 0 : 1;
  }
  if (a.cmd === 'rollback') {
    const ok = a.flags.confirm === true || await confirm('Go back to the previous release? Type rollback to go ahead: ', 'rollback');
    if (!ok) { process.stderr.write('Not rolled back: it needs your confirmation (type rollback, or pass --confirm).\n'); return 2; }
    const r = await ask(dir, { cmd: 'rollback', confirm: true });
    process.stdout.write(`${r.said}\n`);
    return r.ok ? 0 : 1;
  }
  if (a.cmd === 'recover' || a.cmd === 'restart') {
    const r = await ask(dir, { cmd: a.cmd });
    process.stdout.write(`${r.said}\n`);
    return r.ok ? 0 : 1;
  }
  process.stdout.write(`Usage:
  node src/supervisor/main.ts run [--home DIR] [--dir DIR] [--repo DIR] [--tests "CMD"] [--canary-s N]
  node src/supervisor/main.ts status | releases [--dir DIR] [--json]
  node src/supervisor/main.ts deploy <version> [--confirm <version>]
  node src/supervisor/main.ts rollback [--confirm]
  node src/supervisor/main.ts recover | restart
`);
  return a.cmd === 'help' ? 0 : 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
