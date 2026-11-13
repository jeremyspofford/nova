// Nova's own Claude seat (design amendment 2026-11-12, "Authentication and seat health";
// src/core/claude-seat.ts). On 2026-11-12 every Claude call failed: the CLI's sign-in had expired
// and couldn't be refreshed, the seat rode the person's interactive ~/.claude, and nothing named the
// failure or offered a way back. These pin the class, against a stand-in `claude` that keeps its
// sign-in in the folder it runs against (scripts/stand-ins/fake-claude-seat.js), never a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { open, world } from './resilience-support.ts';
import { seatDir, SEAT_PLAYBOOK, authFailure, PROBE_ARGS } from '../../src/core/claude-seat.ts';
import { claudeEnv } from '../../src/core/providers/cli.ts';
import { runAgent } from '../../src/agent.js';
import { loadConfig, ConfigError } from '../../src/config.js';
import { ensureGit } from '../../src/home.js';
import { releaseFailures } from '../../src/supervisor/supervisor.ts';

const STAND_IN = new URL('../../scripts/stand-ins/fake-claude-seat.js', import.meta.url).pathname;
const console_ = { principal: { kind: 'console' as const }, listener: 'console' as const, address: 'console' };
const phone = { principal: { kind: 'device' as const, device: { id: 'd1', name: 'Phone', role: 'client', can_approve: false } }, listener: 'mesh' as const, address: '100.64.0.2' };

// A home, a stand-in claude on a path of its own, the person's interactive ~/.claude (HOME), and a
// core with agent_cmd = claude, so the seat is in use and is chat's only seat.
function setup(o: { probeHours?: number; alternative?: boolean } = {}) {
  const w = world('nova-seat-');
  const bin = join(w.dir, 'bin');
  mkdirSync(bin);
  const program = join(bin, 'claude');
  copyFileSync(STAND_IN, program);
  chmodSync(program, 0o755);
  // The person's own interactive sign-in, which Nova must never touch.
  const personal = join(w.dir, 'person-home', '.claude');
  mkdirSync(personal, { recursive: true });
  writeFileSync(join(personal, '.credentials.json'), '{"ok": true}');
  const before = process.env.HOME;
  process.env.HOME = join(w.dir, 'person-home');
  let t = Date.parse('2026-11-12T09:00:00Z');
  const c = open(w.home, { now: () => new Date(t), agent: { command: 'claude -p --output-format stream-json', egress: 'remote' }, seat: { program, ...(o.probeHours !== undefined ? { probeHours: o.probeHours } : {}) } });
  const seat = c.seat;
  let closed = false;
  const dir = seatDir(w.home);
  const route = (method: string, path: string) => c.routes.find((r) => r.method === method && r.path === path)!;
  const call = (method: string, path: string, who: unknown = console_, body: Record<string, unknown> = {}) => Promise.resolve().then(() => route(method, path).handle({ params: {}, query: new URLSearchParams(), body, headers: {}, who: who as typeof console_ }));
  return {
    w, c, seat, dir, personal, program, call,
    at: (iso: string) => { t = Date.parse(iso); },
    signIn: (ok = true) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ ok })); },
    calls: () => (existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    personalCalls: () => existsSync(join(personal, 'calls.jsonl')),
    open: () => c.log.problems({ open: true }).filter((p) => c.resilience.playbooks.view(p.id)?.id === SEAT_PLAYBOOK),
    done: () => { if (!closed) { closed = true; void c.close(); } process.env.HOME = before; },
  };
}

test('isolation: every seat call runs against the seat’s own folder in Nova’s home; the person’s ~/.claude is never used', async () => {
  const s = setup();
  try {
    s.signIn();
    const probe = await s.seat.probe('person');
    assert.equal(probe.state, 'ok');
    const v = await s.seat.startSignIn();
    assert.equal(v.state, 'waiting');
    s.seat.cancelSignIn();
    const calls = s.calls();
    assert.ok(calls.length >= 2, 'the probe and the sign-in both ran');
    for (const call of calls) {
      assert.equal(call.configDirSet, true, `CLAUDE_CONFIG_DIR passed to ${call.argv.join(' ')}`);
      assert.equal(call.dir, s.dir);
    }
    assert.deepEqual(calls[0].argv, PROBE_ARGS, 'the probe is the one-turn -p call, not auth status');
    assert.equal(s.personalCalls(), false, 'nothing ran against the person’s ~/.claude');
    assert.equal(s.dir, join(s.w.home, 'seats', 'claude-cli'));
    assert.equal(statSync(s.dir).mode & 0o777, 0o700, 'the seat folder is private');
    // Kept out of the home's git history, as the vault and the mesh keys are.
    await ensureGit(s.w.home);
    assert.match(readFileSync(join(s.w.home, '.gitignore'), 'utf8'), /^seats\/$/m);
  } finally { s.done(); }
});

test('isolation: the model command (runAgent) and Claude Code providers get the seat folder, and without one a signed-out folder, never ~/.claude', async () => {
  const s = setup();
  try {
    // With the seat: the stand-in answers "Not logged in" from the seat folder (nothing signed in there).
    await assert.rejects(runAgent({ cmd: `${s.program} -p --output-format stream-json`, system: 's', prompt: 'p', seatEnv: s.seat.env() }), (e: Error & { seat?: string; next?: { href: string } }) => {
      assert.equal(e.message, 'My Claude sign-in expired, so I can’t answer until you sign in again.');
      assert.equal(e.seat, 'needs-sign-in');
      assert.equal(e.next?.href, '/health');
      return true;
    });
    assert.equal(s.calls().at(-1).dir, s.dir);
    // Without a seat: a folder of the call's own, signed out, so it fails loudly rather than use the person's.
    await assert.rejects(runAgent({ cmd: `${s.program} -p --output-format stream-json`, system: 's', prompt: 'p' }), /sign-in expired/);
    assert.equal(s.personalCalls(), false, 'the person’s ~/.claude was never used, seat or no seat');
    // Providers that start claude: the seat's folder, or the task's own signed-out one.
    assert.equal(claudeEnv({ seatEnv: s.seat.env(), stateDir: '/x' }).CLAUDE_CONFIG_DIR, s.dir);
    assert.equal(claudeEnv({ stateDir: '/x/task' }).CLAUDE_CONFIG_DIR, '/x/task/no-seat');
  } finally { s.done(); }
});

test('keepalive: the heartbeat probes when the interval has passed, and each probe is recorded as seat health; a sign-in never fails a release', async () => {
  const s = setup({ probeHours: 6 });
  try {
    s.signIn();
    const first = await s.seat.tick();
    assert.equal(first?.state, 'ok', 'the first tick probes at once');
    s.at('2026-11-12T14:59:00Z');
    assert.equal(await s.seat.tick(), null, 'not before six hours');
    s.at('2026-11-12T15:00:00Z');
    assert.equal((await s.seat.tick())?.state, 'ok', 'at six hours, again');
    const h = s.seat.health();
    assert.equal(h.state, 'ok');
    assert.equal(h.interval_hours, 6);
    assert.equal(s.c.health().checks.seat.state, 'ok', 'Health shows the seat');
    assert.equal(s.c.db.all('SELECT * FROM seat_check').length, 2);
    // Signed out: the next probe records needs-sign-in; a seat that isn't ok is looked at again sooner.
    writeFileSync(join(s.dir, '.credentials.json'), '{"ok": false}');
    s.at('2026-11-12T21:00:00Z');
    assert.equal((await s.seat.tick())?.state, 'needs-sign-in');
    s.at('2026-11-12T21:16:00Z');
    assert.ok(await s.seat.tick(), 'after 15 minutes, not six hours');
    assert.equal(s.c.health().checks.seat.ok, false);
    // Failing, but the owner's to fix: a release canary doesn't count it (going back to older code
    // can't sign Nova in), while any other failing check still counts.
    const checks = s.c.health().checks as Record<string, { ok: boolean; detail?: string; needs_owner?: boolean }>;
    assert.equal(checks.seat!.needs_owner, true);
    assert.deepEqual(releaseFailures(checks).map((f) => f.name), []);
    assert.deepEqual(releaseFailures({ ...checks, database: { ok: false, detail: 'locked' } }).map((f) => f.name), ['database']);
  } finally { s.done(); }
});

test('keepalive: a seat nothing uses is never probed', async () => {
  const w = world('nova-seat-unused-');
  const c = open(w.home, { agent: { command: 'ollama run llama3', egress: 'local' }, seat: { program: '/nonexistent/claude' } });
  try {
    assert.equal(await c.seat.tick(), null);
    assert.equal(c.seat.health().state, 'unused');
    assert.equal(c.health().checks.seat.ok, true);
  } finally { c.close(); }
});

test('detection: an authentication failure raises ONE stop-class problem with Sign in again, however often it repeats', async () => {
  const s = setup();
  try {
    // Signed in once (the seat answered), then the grant dies.
    s.signIn(true);
    assert.equal((await s.seat.probe('keepalive')).state, 'ok');
    s.signIn(false);
    s.seat.failed('Failed to authenticate: OAuth session expired and could not be refreshed');
    s.seat.failed('Failed to authenticate: OAuth session expired and could not be refreshed');
    await s.seat.probe('keepalive');
    await s.seat.probe('keepalive');
    const open = s.open();
    assert.equal(open.length, 1, 'repeated failures are one problem');
    const p = open[0]!;
    assert.equal(p.stops, 1, 'chat’s only seat: Nova is stopped (red)');
    assert.match(p.message, /^My Claude sign-in expired/);
    const pb = s.c.resilience.playbooks.view(p.id)!;
    assert.deepEqual(pb.action, { label: 'Sign in again', kind: 'seat-sign-in' });
    assert.equal(pb.closes, 'check');
    assert.match(pb.steps.join(' '), /doesn’t sign Nova in, and Nova never copies a sign-in/);
    assert.match(pb.steps.join(' '), /last one in the wrong place/);
    // Only the check may close it: "Mark as dealt with" is refused.
    const resolve = s.c.routes.find((x) => x.method === 'POST' && x.path === '/problems/{id}/resolve')!;
    await assert.rejects(Promise.resolve().then(() => resolve.handle({ params: { id: String(p.id) }, query: new URLSearchParams(), body: {}, headers: {}, who: console_ })), /closes by itself once Nova’s own check call to Claude succeeds/);
    assert.equal(s.open().length, 1);
  } finally { s.done(); }
});

test('detection: a seat that never answered says it isn’t signed in yet, not that it expired', async () => {
  const s = setup();
  try {
    assert.equal((await s.seat.probe('keepalive')).state, 'needs-sign-in');
    const [p] = s.open();
    assert.equal(p!.message, 'Nova now keeps its own Claude sign-in, and it isn’t signed in yet, so I can’t answer anything until you sign in.');
    assert.equal(p!.stops, 1);
  } finally { s.done(); }
});

test('detection: authentication failures are told apart from a reply or a network failure', () => {
  for (const said of ['Failed to authenticate: OAuth session expired and could not be refreshed', 'Not logged in · Please run /login', 'Invalid API key · Please run /login', 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}']) assert.equal(authFailure(said), true, said);
  for (const said of ['ok', 'getaddrinfo ENOTFOUND api.anthropic.com', 'The model returned an error', '']) assert.equal(authFailure(said), false, said);
});

test('the sign-in: owner-class; the problem closes only when an independent probe succeeds afterwards, never on the login’s word; the closing is a ledger task', async () => {
  const s = setup();
  try {
    s.seat.failed('Not logged in · Please run /login');
    const [p] = s.open();
    // A device that may not approve can't start it, or see the page's address.
    await assert.rejects(s.call('POST', '/seats/claude-cli/sign-in', phone), /hub’s own screen or a device that may approve/);
    // Started from the console: the address comes back, to the console only.
    s.at('2026-11-12T10:00:00Z');
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, 'login-gives'), '{"ok": false}'); // the login "succeeds" but the grant doesn't work
    const v = await s.call('POST', '/seats/claude-cli/sign-in') as { state: string; url?: string };
    assert.equal(v.state, 'waiting');
    assert.match(v.url!, /^https:\/\/claude\.example\/cai\/oauth\/authorize\?/);
    const seen = await s.call('GET', '/seats/claude-cli/sign-in', phone) as { url?: string };
    assert.equal(seen.url, undefined, 'the address is never shown to a device that may not approve');
    await assert.rejects(s.call('POST', '/seats/claude-cli/sign-in/code', phone, { code: 'x#y' }), /may approve/);
    await assert.rejects(s.call('POST', '/seats/claude-cli/sign-in/code', console_, { code: 'not a code' }), /whole code/);
    const state = new URL(v.url!).searchParams.get('state');
    await s.call('POST', '/seats/claude-cli/sign-in/code', console_, { code: `GOODCODE#${state}` });
    const after = await until(() => s.seat.signInView(true), (x) => ['done', 'failed'].includes(x.state));
    assert.equal(after.state, 'failed', 'Login successful, but the check call failed');
    assert.equal(s.open().length, 1, 'a completed login with a failing probe leaves the problem open');
    assert.equal(s.open()[0]!.id, p!.id);
    // Signed in for real, and the independent probe sees it: closed, and a ledger task records it.
    s.signIn(true);
    s.at('2026-11-12T10:05:00Z');
    await s.call('POST', '/seats/claude-cli/check');
    assert.equal(s.open().length, 0, 'closed by the probe');
    const task = s.c.db.get<{ id: string; owner: string; title: string }>("SELECT id, owner, title FROM task WHERE owner = 'claude-seat'");
    assert.equal(task?.title, 'Claude sign-in works again');
    const done = await until(() => s.c.ledger.get(task!.id), (t) => t.state === 'done' || t.state === 'failed');
    assert.equal(done.state, 'done', 'its evidence (the probe’s own record) checked out');
  } finally { s.done(); }
});

test('the sign-in: the code and the sign-in page’s address are never written anywhere in Nova’s home, its log included', async () => {
  const s = setup();
  try {
    s.seat.failed('Not logged in · Please run /login');
    const v = await s.seat.startSignIn();
    const state = new URL(v.url!).searchParams.get('state')!;
    s.seat.submitCode('WRONGCODE#nope');
    await until(() => s.seat.signInView(true), (x) => x.state === 'failed');
    const again = await s.seat.startSignIn();
    const state2 = new URL(again.url!).searchParams.get('state')!;
    s.seat.submitCode(`GOODCODE#${state2}`);
    await until(() => s.seat.signInView(true), (x) => x.state === 'done' || x.state === 'failed');
    s.seat.cancelSignIn();
    const task = await until(() => s.c.db.get<{ state: string }>("SELECT state FROM task WHERE owner = 'claude-seat'"), (t) => t?.state === 'done' || t?.state === 'failed');
    assert.equal(task?.state, 'done');
    s.done();
    const secrets = ['GOODCODE', 'WRONGCODE', state, state2, 'claude.example', 'oauth/authorize'];
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== '.git') walk(p); continue; }
        const text = readFileSync(p).toString('latin1');
        for (const x of secrets) if (text.includes(x)) hits.push(`${p}: ${x}`);
      }
    };
    walk(s.w.home);
    assert.deepEqual(hits, [], 'no code or sign-in address in any file Nova keeps');
  } finally { s.done(); }
});

test('alternative seat: while another provider serves chat, the problem is amber, not red', async () => {
  const s = setup();
  try {
    // Simulate a chat provider other than agent_cmd being chosen.
    (s.c.providers as unknown as { chat: () => unknown }).chat = () => ({ id: 'ollama' });
    // Still in use? agent_cmd isn't chat's now; turn a Claude Code provider's use on via inUse.
    s.seat.failed('Failed to authenticate: OAuth session expired and could not be refreshed');
    const [p] = s.open();
    assert.equal(p!.stops, 0);
    assert.match(p!.message, /another model is answering meanwhile/);
  } finally { s.done(); }
});

test('interval: L0 default 6 hours, seat_probe_hours in nova.config.json over it, NOVA_SEAT_PROBE_HOURS over both', () => {
  const w = world('nova-seat-cfg-');
  assert.equal(loadConfig({}, w.dir).seatProbeHours, 6);
  writeFileSync(join(w.dir, 'nova.config.json'), JSON.stringify({ seat_probe_hours: 3 }));
  assert.equal(loadConfig({}, w.dir).seatProbeHours, 3);
  assert.equal(loadConfig({ NOVA_SEAT_PROBE_HOURS: '1.5' }, w.dir).seatProbeHours, 1.5);
  assert.throws(() => loadConfig({ NOVA_SEAT_PROBE_HOURS: '0' }, w.dir), ConfigError);
  assert.throws(() => loadConfig({ NOVA_SEAT_PROBE_HOURS: 'often' }, w.dir), /hours apart/);
  // And the core honours what it is given.
  const c = open(join(w.dir, 'home'), { agent: { command: 'claude -p', egress: 'remote' }, seat: { program: '/nonexistent/claude', probeHours: 3 } });
  try { assert.equal(c.seat.health().interval_hours, 3); } finally { c.close(); }
});

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50)); // wait: poll: has the stand-in sign-in finished?
  }
}
