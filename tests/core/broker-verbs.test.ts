// The seven verbs and their refusals, on the broker's own authority (docs/plans/vault-broker.md
// §4–§8; gate items 3, 4 and 5). The caller here is core itself, with a valid token: the broker
// still refuses a non-bound origin, a request outside scope, a missing, replayed, expired or
// mismatched approval, a standing consent on a sensitive credential, and a flood.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyChain } from '../../src/broker/audit.ts';
import { challengeBytes } from '../../src/broker/policy.ts';
import { C, Person, anyForm, boundCredential, inProcess, standIn, tmp, type A } from '../support/broker-support.ts';

async function fresh(o: { passkey?: boolean; now?: () => Date } = {}) {
  const b = inProcess(join(tmp(), 'broker'), o.now ? { now: o.now } : {});
  const p = new Person(b.call);
  await p.setup({ passkey: o.passkey });
  return { ...b, p };
}
const noValue = (answers: A[], values: string[]) => {
  const text = JSON.stringify(answers);
  for (const v of values) assert.equal(anyForm(text, v), null, `an answer carried ${v}`);
};

test('locked: list_refs gives the state and no refs; every other verb refuses with locked', async () => {
  const { call, broker, p } = await fresh();
  const site = await standIn();
  await boundCredential(p, site.origin, { value: C('locked') });
  broker.lock();
  const l = await call('list_refs');
  assert.equal(l.state.locked, true);
  assert.deepEqual(l.refs, []);
  const u = await call('use', { ref: 'secret://provider/EXAMPLE_KEY', target: { kind: 'http', origin: site.origin }, request: { method: 'GET', path: '/api' } });
  assert.equal(u.refused, 'locked');
  assert.equal(site.connections, 0);
  for (const m of ['create', 'update', 'rotate', 'bind', 'share_scope']) assert.equal((await call(m, {})).refused, 'locked', m);
  await site.close();
});

test('create: tier 3, a card of metadata only; a generated or sealed value, never in an answer', async () => {
  const { call, p, answers } = await fresh();
  const first = await call('create', { meta: { name: 'browser/login/shop.example/password', kind: 'login', origin: 'https://shop.example', username: 'person@example.test' }, source: 'generate' });
  assert.equal(first.refused, 'needs_approval');
  const card = first.challenge.card;
  assert.equal(card.tier, 3);
  assert.equal(card.class, 'sensitive', 'unsure means sensitive');
  assert.match(card.what, /Make a new password for https:\/\/shop\.example/);
  const made = await p.approve('create', { meta: { name: 'browser/login/shop.example/password', kind: 'login', origin: 'https://shop.example', username: 'person@example.test' }, source: 'generate' });
  assert.equal(made.ok, true);
  assert.equal(made.username, 'person@example.test');
  assert.deepEqual(made.aliases, ['secret://browser/login/shop.example/password']);
  // Sealed: the envelope is bound to the challenge's digest; one sealed for another action fails.
  const meta = { name: 'provider/SEALED', kind: 'api_key' };
  const one = await call('create', { meta, source: 'sealed' });
  const other = await call('create', { meta: { name: 'provider/OTHER', kind: 'api_key' }, source: 'sealed' });
  const st = await p.state();
  const { sealValue } = await import('../../src/broker/seal.ts');
  const wrong = await sealValue(st.entry_key, other.challenge.digest, C('sealed'));
  const r = await call('create', { meta, source: { sealed: wrong }, approval: p.approval(one.challenge) });
  assert.equal(r.refused, 'approval_invalid');
  const ok = await p.approve('create', { meta, source: 'sealed' }, { seal: C('sealed'), sealAt: (f, env) => ({ ...f, source: { sealed: env } }) });
  assert.equal(ok.ok, true);
  assert.equal((await call('create', { meta, source: 'generate' })).error, 'failed', 'a name is taken once');
  noValue(answers, [C('sealed')]);
});

test('use: the exact bound origin only, even when core asks with a valid approval made for the bound one', async () => {
  const { call, p, answers, broker } = await fresh();
  const a = await standIn();
  const b = await standIn();
  await boundCredential(p, a.origin, { value: C('bound'), consent: false });
  const ref = 'secret://provider/EXAMPLE_KEY';
  // An approval for a use at A, then the same call aimed at B, and every other near miss.
  const atA = await call('use', { ref, target: { kind: 'http', origin: a.origin }, request: { method: 'GET', path: '/api/x' } });
  assert.equal(atA.refused, 'needs_approval');
  const approval = p.approval(atA.challenge);
  const near = [b.origin, a.origin.replace('127.0.0.1', 'localhost'), a.origin.replace('http:', 'https:'), `${a.origin}/api`, 'http://127.0.0.2:' + a.port];
  for (const origin of near) {
    const r = await call('use', { ref, target: { kind: 'http', origin }, request: { method: 'GET', path: '/api/x' }, approval });
    assert.equal(r.refused, 'not_bound', origin);
  }
  // Names, without connecting: a subdomain, a parent, a homograph, an extra label, another port.
  await boundCredential(p, 'https://bank.example', { name: 'provider/BANK', value: C('bank'), consent: false, class: 'standard' });
  for (const origin of ['https://login.bank.example', 'https://example', 'https://bаnk.example', 'https://bank.example.attacker.test', 'https://bank.example:8443', 'http://bank.example', 'https://BANK.example.', 'https://*.bank.example']) {
    const r = await call('use', { ref: 'secret://provider/BANK', target: { kind: 'http', origin }, request: { method: 'GET', path: '/api' } });
    assert.equal(r.refused, 'not_bound', origin);
    assert.equal(r.record.outcome, 'refused:not_bound');
    assert.equal(r.record.ref, answers.at(-1)!.record.ref);
  }
  assert.equal(b.connections, 0, 'B never saw a connection');
  assert.equal(a.connections, 0, 'and nothing reached A without the approval');
  // The approval still works for exactly what it was made for, once.
  const ok = await call('use', { ref, target: { kind: 'http', origin: a.origin }, request: { method: 'GET', path: '/api/x' }, approval });
  assert.equal(ok.ok, true);
  assert.equal(a.requests[0]!.headers.authorization, `Bearer ${C('bound')}`, 'the target gets the value');
  assert.equal(ok.outcome.body, 'saw Bearer [redacted by the broker] ', 'and its echo comes back scrubbed');
  const log = readFileSync(broker.audit.path, 'utf8');
  assert.equal(verifyChain(log).ok, true);
  for (const v of [C('bound'), C('bank')]) assert.equal(anyForm(log, v), null);
  noValue(answers, [C('bound'), C('bank')]);
  await a.close(); await b.close();
});

test('redirects aren’t followed: A’s 302 to B comes back as an outcome, and B sees nothing', async () => {
  const { call, p } = await fresh();
  const b = await standIn();
  const a = await standIn((_req, res) => { res.statusCode = 302; res.setHeader('location', `${b.origin}/steal`); res.end(); });
  await boundCredential(p, a.origin, { value: C('redirect') });
  const r = await call('use', { ref: 'secret://provider/EXAMPLE_KEY', target: { kind: 'http', origin: a.origin }, request: { method: 'GET', path: '/api/login' } });
  assert.equal(r.outcome.status, 302);
  assert.equal(r.outcome.headers.location, `${b.origin}/steal`);
  assert.equal(b.connections, 0);
  const again = await call('use', { ref: 'secret://provider/EXAMPLE_KEY', target: { kind: 'http', origin: b.origin }, request: { method: 'GET', path: '/steal' } });
  assert.equal(again.refused, 'not_bound', 'the new address needs its own binding');
  await a.close(); await b.close();
});

test('use: out of scope (method, path, traversal, a host in the path, an auth header from the caller)', async () => {
  const { call, p } = await fresh();
  const a = await standIn();
  await boundCredential(p, a.origin, { value: C('scope'), scope: { methods: ['GET'], paths: ['/api/states'] } });
  const ref = 'secret://provider/EXAMPLE_KEY';
  const t = { kind: 'http', origin: a.origin };
  for (const request of [{ method: 'POST', path: '/api/states' }, { method: 'GET', path: '/api/services' }, { method: 'GET', path: '/api/statesx' }, { method: 'GET', path: '/api/states/../services' }, { method: 'GET', path: '/api/states/%2e%2e/services' }, { method: 'GET', path: '//evil.example/api/states' }, { method: 'GET', path: '/api/states', headers: { Authorization: 'Bearer mine' } }, { method: 'GET', path: '/api/states', headers: { 'x-a': 'b\r\nAuthorization: x' } }]) {
    const r = await call('use', { ref, target: t, request });
    assert.equal(r.refused, 'out_of_scope', JSON.stringify(request));
  }
  assert.equal(a.connections, 0);
  const ok = await call('use', { ref, target: t, request: { method: 'GET', path: '/api/states/light.kitchen?x=1' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.record.scope_item, 'GET /api/states/light.kitchen', 'the ledger has the path, never the query string');
  await a.close();
});

test('tiers: standing consent at tier 1; outside it, ask first, once per task; sensitive asks; per-use asks every time; no standing consent on sensitive', async () => {
  const { call, p } = await fresh();
  const a = await standIn();
  const scope = { methods: ['GET', 'POST'], paths: ['/api'] };
  const bind = [{ target: { kind: 'http', origin: a.origin }, scope, inject: { how: 'bearer' }, consent: { scope: { methods: ['GET'], paths: ['/api/states'] } } }];
  assert.equal((await p.approve('create', { meta: { name: 'connector/home-assistant/HA_TOKEN', kind: 'token', origin: a.origin }, source: 'generate', bind })).ok, true);
  const ref = 'secret://connector/home-assistant/HA_TOKEN';
  const t = { kind: 'http', origin: a.origin };
  const read = await call('use', { ref, target: t, request: { method: 'GET', path: '/api/states' } });
  assert.equal(read.record.tier, 1, 'state reads at standing consent');
  const svc = { ref, target: t, request: { method: 'POST', path: '/api/services/light/turn_on', body: '{}' }, task: { id: 'task-1', title: 'Lights' } };
  const ask = await call('use', svc);
  assert.equal(ask.refused, 'needs_approval');
  assert.equal(ask.challenge.card.tier, 2);
  assert.equal(ask.challenge.card.task.id, 'task-1');
  assert.equal((await call('use', { ...svc, approval: p.approval(ask.challenge) })).ok, true);
  assert.equal((await call('use', svc)).ok, true, 'the approval covers the task');
  assert.equal((await call('use', { ...svc, request: { method: 'POST', path: '/api/services/lock/unlock', body: '{}' } })).refused, 'needs_approval', 'but only that request');
  assert.equal((await call('use', { ...svc, task: { id: 'task-2', title: 'x' } })).refused, 'needs_approval', 'not another task');
  // Sensitive: no standing consent at all; asks once per task.
  const bank = await p.approve('create', { meta: { name: 'provider/BANKISH', kind: 'api_key', origin: 'https://bank.example' }, source: 'generate', bind: [{ ...bind[0], target: { kind: 'http', origin: 'https://bank.example' } }] });
  assert.equal(bank.refused, 'class_policy');
  await boundCredential(p, a.origin, { name: 'provider/SENSITIVE', class: 'sensitive', consent: false });
  const s = { ref: 'secret://provider/SENSITIVE', target: t, request: { method: 'GET', path: '/api' }, task: { id: 'task-3', title: 's' } };
  const sa = await call('use', s);
  assert.equal(sa.refused, 'needs_approval');
  assert.equal((await call('use', { ...s, approval: p.approval(sa.challenge) })).ok, true);
  assert.equal((await call('use', s)).ok, true);
  const created = await call('list_refs', { filter: { prefix: 'provider/SENSITIVE' } });
  const consentBind = await call('bind', { ref: created.refs[0].ref, add: { ...bind[0] } });
  assert.equal(consentBind.refused, 'class_policy');
  // Per use: every use asks.
  await boundCredential(p, a.origin, { name: 'provider/PERUSE', class: 'sensitive', consent: false, per_use: true });
  const pu = { ...s, ref: 'secret://provider/PERUSE' };
  const one = await call('use', pu);
  assert.equal((await call('use', { ...pu, approval: p.approval(one.challenge) })).ok, true);
  assert.equal((await call('use', pu)).refused, 'needs_approval');
  await a.close();
});

test('approvals: missing, replayed, made for another digest, or expired are refused', async () => {
  let now = Date.parse('2026-11-01T09:00:00Z');
  const { call, p } = await fresh({ now: () => new Date(now) });
  const a = await standIn();
  await boundCredential(p, a.origin, { value: C('ap'), consent: false });
  const ref = 'secret://provider/EXAMPLE_KEY';
  const t = { kind: 'http', origin: a.origin };
  const req = (path: string) => ({ ref, target: t, request: { method: 'GET', path }, task: { id: 't', title: 't' } });
  const c1 = (await call('use', req('/api/a'))).challenge;
  const other = await call('use', req('/api/b'), );
  assert.equal(other.refused, 'needs_approval');
  assert.equal((await call('use', { ...req('/api/b'), approval: p.approval(c1) })).refused, 'approval_invalid', 'made for another digest');
  assert.equal((await call('use', { ...req('/api/a'), approval: { ...p.approval(c1), digest: other.challenge.digest } })).refused, 'approval_invalid');
  assert.equal((await call('use', { ...req('/api/a'), approval: p.approval(c1) })).ok, true);
  const c3 = (await call('use', { ...req('/api/c'), task: { id: 'u', title: 'u' } })).challenge;
  assert.equal((await call('use', { ...req('/api/c'), task: { id: 'u', title: 'u' }, approval: p.approval(c3) })).ok, true);
  assert.equal((await call('use', { ...req('/api/c'), task: { id: 'v', title: 'v' }, approval: p.approval(c3) })).refused, 'approval_invalid', 'replayed');
  const c4 = (await call('update', { ref, change: 'remove' })).challenge;
  now += 5 * 60_000 + 1;
  assert.equal((await call('update', { ref, change: 'remove', approval: p.approval(c4) })).refused, 'approval_invalid', 'expired');
  assert.equal((await call('update', { ref, change: 'remove', approval: { id: 'ap_made_up', digest: c4.digest, mode: 'core' } })).refused, 'approval_invalid');
  await a.close();
});

test('rate caps and flood control are the broker’s own', async () => {
  const { call, p, broker } = await fresh();
  const a = await standIn();
  const scope = { methods: ['GET'], paths: ['/api'] };
  await p.approve('create', { meta: { name: 'provider/CAPPED', kind: 'api_key', origin: a.origin }, source: 'generate', bind: [{ target: { kind: 'http', origin: a.origin }, scope, inject: { how: 'bearer' }, consent: { scope, rate_per_hour: 2 } }] });
  const u = { ref: 'secret://provider/CAPPED', target: { kind: 'http', origin: a.origin }, request: { method: 'GET', path: '/api' } };
  assert.equal((await call('use', u)).ok, true);
  assert.equal((await call('use', u)).ok, true);
  assert.equal((await call('use', u)).refused, 'rate');
  // A few pending approvals per task, then refused, and a problem is raised.
  const ask = (n: number) => call('create', { meta: { name: `provider/FLOOD${n}`, kind: 'api_key' }, source: 'generate', task: { id: 'flood', title: 'f' } });
  for (const n of [1, 2, 3]) assert.equal((await ask(n)).refused, 'needs_approval');
  assert.equal((await ask(4)).refused, 'rate');
  assert.match(String(broker.problem), /keeps asking to use your credentials/);
  await a.close();
});

test('update, rotate: metadata and class, a new value, delete; a pending version used, committed or abandoned', async () => {
  const { call, p, answers } = await fresh();
  const a = await standIn();
  const made = await boundCredential(p, a.origin, { value: C('v1') });
  const ref = made.ref;
  const t = { kind: 'http', origin: a.origin };
  const meta = await p.approve('update', { ref, change: { meta: { username: 'robot', class: 'sensitive' } } });
  assert.equal(meta.class, 'sensitive');
  assert.equal((await call('use', { ref, target: t, request: { method: 'GET', path: '/api' } })).refused, 'needs_approval', 'its standing consent no longer covers it');
  await p.approve('update', { ref, change: { meta: { class: 'standard' } } });
  const v2 = await p.approve('update', { ref, change: { value: 'sealed' } }, { seal: C('v2'), sealAt: (f, env) => ({ ...f, change: { value: { sealed: env } } }) });
  assert.equal(v2.version, 2);
  await call('use', { ref, target: t, request: { method: 'GET', path: '/api' } });
  assert.equal(a.requests.at(-1)!.headers.authorization, `Bearer ${C('v2')}`);
  const begun = await p.approve('rotate', { ref, phase: 'begin' });
  assert.equal(begun.pending, true);
  await call('use', { ref, target: t, request: { method: 'GET', path: '/api' }, version: 'pending' });
  const pendingSeen = String(a.requests.at(-1)!.headers.authorization);
  assert.notEqual(pendingSeen, `Bearer ${C('v2')}`);
  assert.equal((await call('rotate', { ref, phase: 'abandon' })).pending, false, 'abandon is at once');
  assert.equal((await call('use', { ref, target: t, request: { method: 'GET', path: '/api' }, version: 'pending' })).refused, 'out_of_scope');
  await p.approve('rotate', { ref, phase: 'begin' });
  const committed = await p.approve('rotate', { ref, phase: 'commit' });
  assert.equal(committed.pending, false);
  const list = await call('list_refs');
  assert.ok(list.refs[0].last_rotated);
  const gone = await p.approve('update', { ref, change: 'remove' });
  assert.equal(gone.removed, true);
  assert.equal((await call('use', { ref, target: t, request: { method: 'GET', path: '/api' } })).refused, 'unknown_ref');
  assert.equal((await call('use', { ref: 'secret://provider/EXAMPLE_KEY', target: t, request: { method: 'GET', path: '/api' } })).refused, 'unknown_ref', 'its alias went with it');
  noValue(answers, [C('v1'), C('v2'), pendingSeen.slice(7)]);
  await a.close();
});

test('bind: tier 3 with lookalike flags to add; removing and revoking consent at once; no wildcards; kinds not built are refused', async () => {
  const { call, p } = await fresh();
  const made = await boundCredential(p, 'https://example.com', { value: C('bind'), class: 'standard' });
  const ref = made.ref;
  const add = (origin: string) => ({ ref, add: { target: { kind: 'http', origin }, scope: { methods: ['GET'], paths: ['/'] }, inject: { how: 'bearer' } } });
  const c1 = await call('bind', add('https://examp1e.com'));
  assert.equal(c1.refused, 'needs_approval');
  assert.ok(c1.challenge.card.flags.some((f: string) => /close to example\.com/.test(f)));
  const c2 = await call('bind', add('https://example.com.attacker.test'));
  assert.ok(c2.challenge.card.flags.some((f: string) => /starts with example\.com/.test(f)));
  const c3 = await call('bind', add('https://xn--exmple-cua.com'));
  assert.ok(c3.challenge.card.flags.some((f: string) => /shown as/.test(f)), 'the Unicode name is shown beside the A-label');
  assert.equal((await call('bind', add('https://*.example.com'))).error, 'failed');
  assert.equal((await call('bind', { ref, add: { target: { kind: 'ws', origin: 'wss://example.com' }, scope: { methods: ['GET'], paths: ['/'] }, inject: { how: 'bearer' } } })).refused, 'wrong_target_kind');
  assert.equal((await call('bind', { ref, add: { target: { kind: 'stream', origin: 'imap.example.com:993' } } })).refused, 'wrong_target_kind', 'IMAP waits for its stream target');
  const revoke = await call('bind', { ref, remove: { target: { kind: 'http', origin: 'https://example.com' }, consent_only: true } });
  assert.equal(revoke.ok, true);
  assert.equal(revoke.bindings[0].consent, null);
  const removed = await call('bind', { ref, remove: { target: { kind: 'http', origin: 'https://example.com' } } });
  assert.deepEqual(removed.bindings, []);
  assert.equal((await call('use', { ref, target: { kind: 'http', origin: 'https://example.com' }, request: { method: 'GET', path: '/' } })).refused, 'not_bound');
});

test('passkey approvals: required for bind and share_scope once a passkey is registered; checked by the broker itself', async () => {
  const { call, p } = await fresh({ passkey: true });
  assert.equal((await p.state()).approval_mode, 'passkey');
  const made = await p.approve('create', { meta: { name: 'provider/PK', kind: 'api_key' }, source: 'generate' }, { mode: 'core' });
  assert.equal(made.ok, true, 'create without bindings may be core-relayed');
  const add = { ref: made.ref, add: { target: { kind: 'http', origin: 'https://api.example.com' }, scope: { methods: ['GET'], paths: ['/'] }, inject: { how: 'bearer' } } };
  const ch = (await call('bind', add)).challenge;
  assert.equal((await call('bind', { ...add, approval: p.approval(ch, 'core') })).refused, 'approval_invalid', 'core can’t stand in for the passkey');
  const pk = p.passkey!;
  const bad = [
    pk.assert(challengeBytes(ch.id, ch.digest), { origin: 'https://evil.example' }),
    pk.assert(challengeBytes(ch.id, ch.digest), { uv: false }),
    pk.assert(challengeBytes(ch.id, ch.digest), { rpId: 'evil.example' }),
    pk.assert(challengeBytes('ap_other', ch.digest)),
  ];
  for (const x of bad) assert.equal((await call('bind', { ...add, approval: { id: ch.id, digest: ch.digest, mode: 'passkey', ...x } })).refused, 'approval_invalid');
  const ch2 = (await call('bind', add)).challenge;
  const good = pk.assert(challengeBytes(ch2.id, ch2.digest), { count: 50 });
  assert.equal((await call('bind', { ...add, approval: { id: ch2.id, digest: ch2.digest, mode: 'passkey', ...good } })).ok, true);
  const ch3 = (await call('bind', { ...add, add: { ...add.add, scope: { methods: ['GET', 'POST'], paths: ['/'] } } })).challenge;
  const old = pk.assert(challengeBytes(ch3.id, ch3.digest), { count: 49 });
  assert.equal((await call('bind', { ...add, add: { ...add.add, scope: { methods: ['GET', 'POST'], paths: ['/'] } }, approval: { id: ch3.id, digest: ch3.digest, mode: 'passkey', ...old } })).refused, 'approval_invalid', 'a counter that went back');
});

test('share_scope: a holder device at tier 3, removed at once with a re-key; external managers are Phase 2', async () => {
  const { call, p, broker } = await fresh();
  assert.equal((await call('share_scope', { backend: { kind: 'onepassword' } })).refused, 'wrong_target_kind');
  const sb = inProcess();
  const dev = (await sb.call('list_refs')).state;
  const add = { device: { id: dev.device_id, public_key: sb.broker.store.device().public, name: 'standby' } };
  const ch = await call('share_scope', add);
  assert.equal(ch.refused, 'needs_approval');
  assert.match(ch.challenge.card.approving, /will be able to open every item in this vault/);
  const ok = await p.approve('share_scope', add);
  assert.equal(ok.outbox, true);
  const gen = broker.store.header!.gen;
  const rm = await call('share_scope', { device: { id: dev.device_id, remove: true } });
  assert.equal(rm.ok, true);
  assert.equal(broker.store.header!.gen, gen + 1, 'removing a holder re-keys the vault');
});

test('n8n: sign computes the header inside the broker; verify answers valid or not', async () => {
  const { call, p } = await fresh();
  const n8n = await standIn();
  const scope = { methods: ['POST'], paths: ['/webhook'] };
  const made = await p.approve('create', { meta: { name: 'provider/N8N_SIGNING', kind: 'signing_key', origin: n8n.origin }, source: 'sealed', bind: [
    { target: { kind: 'http', origin: n8n.origin }, scope, inject: { how: 'sign', header: 'X-Nova-Signature', prefix: 'sha256=' }, consent: { scope } },
  ] }, { seal: C('n8n'), sealAt: (f, env) => ({ ...f, source: { sealed: env } }) });
  assert.equal(made.ok, true);
  const body = '{"run":1}';
  await call('use', { ref: made.ref, target: { kind: 'http', origin: n8n.origin }, request: { method: 'POST', path: '/webhook/x', body, headers: { 'content-type': 'application/json' } } });
  const expected = `sha256=${createHmac('sha256', C('n8n')).update(body).digest('hex')}`;
  assert.equal(n8n.requests[0]!.headers['x-nova-signature'], expected);
  // A check binding on the same origin (callbacks): no network, valid or not.
  await p.approve('bind', { ref: made.ref, add: { target: { kind: 'http', origin: `${n8n.origin.replace(String(n8n.port), String(n8n.port + 1))}` }, scope, inject: { how: 'verify', prefix: 'sha256=' }, consent: { scope } } });
  const vt = { kind: 'http', origin: n8n.origin.replace(String(n8n.port), String(n8n.port + 1)) };
  assert.equal((await call('use', { ref: made.ref, target: vt, request: { verify: { body, signature: expected } } })).outcome.valid, true);
  assert.equal((await call('use', { ref: made.ref, target: vt, request: { verify: { body: '{"run":2}', signature: expected } } })).outcome.valid, false);
  assert.equal(n8n.connections, 1);
  await n8n.close();
});

test('a program’s approval covers its exact arguments, shown on the card; a ticket carries them', async () => {
  const { call, p } = await fresh();
  const { fileSha256 } = await import('../../src/broker/origin.ts');
  const target = { kind: 'process', path: process.execPath, sha256: fileSha256(process.execPath) };
  const made = await p.approve('create', { meta: { name: 'infra/p/TF_VAR_X', kind: 'secret', class: 'standard' }, source: 'generate', bind: [{ target, inject: { how: 'env', env: 'TF_VAR_X' } }] });
  const plan = { ref: made.ref, target, request: { argv: ['plan'] }, task: { id: 'infra-1', title: 'Plan' } };
  const ask = await call('use', plan);
  assert.equal(ask.refused, 'needs_approval');
  assert.deepEqual(ask.challenge.card.argv, ['plan']);
  assert.ok((await call('use', { ...plan, approval: p.approval(ask.challenge) })).outcome.ticket);
  assert.ok((await call('use', plan)).outcome.ticket, 'the same command again in the task');
  assert.equal((await call('use', { ...plan, request: { argv: ['apply', '-auto-approve'] } })).refused, 'needs_approval', 'not another command');
  assert.equal((await call('use', plan)).record.scope_item, 'RUN', 'the arguments stay out of the ledger');
});

test('unlock: the person’s factor only, a few attempts a minute; “ask me after a restart” stays locked at start', async () => {
  const dir = join(tmp(), 'broker');
  const b = inProcess(dir);
  const p = new Person(b.call);
  await p.setup({ ask: true, recovery: true });
  b.broker.lock();
  const b2 = inProcess(dir);
  const p2 = new Person(b2.call);
  assert.equal((await p2.state()).locked, true, 'nothing on disk opens it by itself');
  assert.equal((await b2.call('unlock', { device: true })).refused, 'locked');
  for (let i = 0; i < 3; i++) assert.equal((await b2.call('unlock', { passphrase: await p2.factor('passphrase', `wrong-${i}-passphrase`) })).refused, 'locked');
  // A sealed factor from another boot doesn't open anything.
  const stale = await p.factor('passphrase', 'correct-horse-battery-staple');
  assert.equal((await b2.call('unlock', { passphrase: stale })).refused, 'locked');
  assert.equal((await b2.call('unlock', { passphrase: await p2.factor('passphrase', 'correct-horse-battery-staple') })).refused, 'rate', 'five failures a minute, then wait');
  const b3 = inProcess(dir);
  const p3 = new Person(b3.call);
  const { RECOVERY } = await import('../support/broker-support.ts');
  assert.equal((await b3.call('unlock', { recovery: await p3.factor('recovery', RECOVERY) })).ok, true);
  assert.equal((await b3.supervisor('unlock', { passphrase: await p3.factor('passphrase', 'x') })).error, 'failed', 'only core relays an unlock');
  assert.equal((await b3.supervisor('create', {})).error, 'failed', 'the supervisor lists and locks, nothing else');
  assert.equal((await b3.supervisor('lock')).ok, true);
});
