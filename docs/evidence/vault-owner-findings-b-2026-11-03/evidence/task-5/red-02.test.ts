// Task 5: approval effects at real synthetic targets, with frozen broker time and no owner data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileSha256 } from '../../src/broker/origin.ts';
import { generate } from '../../src/broker/policy.ts';
import { sealValue } from '../../src/broker/seal.ts';
import { C, Person, anyForm, boundCredential, inProcess, standIn, tmp, type A } from '../support/broker-support.ts';

async function fresh(now?: () => Date) {
  const b = inProcess(join(tmp('nova-policy-'), 'broker'), { now });
  const p = new Person(b.call);
  await p.setup({ passkey: true });
  return { ...b, p };
}
async function program(consent = false) {
  const b = await fresh();
  const home = tmp('nova-policy-program-');
  const log = join(home, 'runs');
  const path = join(home, 'target.py');
  writeFileSync(path, `#!/usr/bin/python3
with open(${JSON.stringify(log)}, 'a') as f: f.write('ran\\n')
print('finished')
`, { mode: 0o755 });
  const target = { kind: 'process', path, sha256: fileSha256(path) };
  const bind = { target, inject: { how: 'env', env: 'TEST_CREDENTIAL' }, ...(consent ? { consent: {} } : {}) };
  const made = await b.p.approve('create', { meta: { name: 'test/PROGRAM', kind: 'secret', class: 'standard' }, source: 'sealed', bind: [bind] }, { seal: C('policy-stored'), sealAt: (f, e) => ({ ...f, source: { sealed: e } }) });
  assert.equal(made.ok, true);
  const cwd = join(home, 'first'); mkdirSync(cwd);
  const other = join(home, 'second'); mkdirSync(other);
  const request = { argv: ['first'], cwd, env: { TF_VAR_INPUT: 'caller-env-private' }, stdin: 'caller-stdin-private', timeout_ms: 3000 };
  return { ...b, bind, other, request, use: { ref: made.ref, target, request, task: { id: 'same-program-task' } }, runs: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0 };
}
const changes: Record<string, (b: Awaited<ReturnType<typeof program>>) => A> = {
  argv: () => ({ argv: ['second'] }), cwd: (b) => ({ cwd: b.other }),
  env: () => ({ env: { TF_VAR_INPUT: 'changed-env-private' } }),
  stdin: () => ({ stdin: 'changed-stdin-private' }), timeout_ms: () => ({ timeout_ms: 4000 }),
};
for (const [field, change] of Object.entries(changes)) {
  test(`process ${field} substitution cannot spend an approval or reuse a task grant`, async () => {
    const b = await program();
    try {
      const asked = await b.call('use', b.use);
      assert.equal(asked.refused, 'needs_approval');
      const changed = { ...b.use, request: { ...b.request, ...change(b) } };
      assert.equal((await b.call('use', { ...changed, approval: b.p.approval(asked.challenge) })).refused, 'approval_invalid');
      assert.equal(b.runs(), 0, 'changed request did not reach the program');
      assert.equal((await b.call('use', { ...b.use, approval: b.p.approval(asked.challenge) })).ok, true);
      assert.equal(b.runs(), 1);
      assert.equal((await b.call('use', changed)).refused, 'needs_approval');
      assert.equal(b.runs(), 1, 'old task grant did not authorize changed inputs');
      assert.equal((await b.p.approve('use', changed)).ok, true);
      assert.equal(b.runs(), 2);
    } finally { b.broker.lock(); }
  });
}
for (const [field, change] of Object.entries(changes)) {
  test(`process task grant refuses changed ${field} before launching`, async () => {
    const b = await program();
    try {
      const first = await b.p.approve('use', b.use);
      assert.equal(first.ok, true); assert.equal(first.outcome.exit, 0); assert.equal(b.runs(), 1);
      assert.equal((await b.call('use', { ...b.use, request: { ...b.request, ...change(b) } })).refused, 'needs_approval');
      assert.equal(b.runs(), 1);
    } finally { b.broker.lock(); }
  });
}
test('process cards identify each caller input safely; audit never carries env or stdin', async () => {
  const b = await program();
  try {
    const first = await b.call('use', b.use);
    const flags: string[] = first.challenge.card.flags ?? [];
    for (const field of ['cwd', 'env', 'stdin', 'timeout_ms']) assert.ok(flags.some((x) => x.includes(field)), field);
    assert.ok(flags.some((x) => /env.*sha256:[a-f0-9]{64}/.test(x)));
    assert.ok(flags.some((x) => /stdin.*sha256:[a-f0-9]{64}/.test(x)));
    for (const [field, change] of Object.entries(changes)) {
      const next = await b.call('use', { ...b.use, request: { ...b.request, ...change(b) }, task: { id: field } });
      if (field === 'argv') assert.notDeepEqual(next.challenge.card.argv, first.challenge.card.argv);
      else assert.notDeepEqual(next.challenge.card.flags.filter((x: string) => x.includes(field)), flags.filter((x) => x.includes(field)), `card identifies changed ${field}`);
    }
    const publicText = JSON.stringify(b.answers) + readFileSync(join(b.dir, 'audit.log'), 'utf8');
    for (const value of ['caller-env-private', 'caller-stdin-private', 'changed-env-private', 'changed-stdin-private', C('policy-stored')]) assert.equal(anyForm(publicText, value), null);
    assert.ok(!publicText.includes(createHash('sha256').update(C('policy-stored')).digest('hex')), 'no stored credential fingerprint');
  } finally { b.broker.lock(); }
});
test('standing process consent cards explain argv cwd allow-listed env stdin and timeout breadth', async () => {
  const b = await program();
  try {
    const frame = { ref: b.use.ref, add: { ...b.bind, consent: {} } };
    const asked = await b.call('bind', frame);
    const shown = JSON.stringify(asked.challenge.card);
    for (const word of ['caller', 'argv', 'cwd', 'allow-listed', 'env', 'stdin', 'timeout']) assert.ok(shown.includes(word), word);
    assert.equal((await b.call('bind', { ...frame, approval: b.p.approval(asked.challenge) })).ok, true);
    assert.equal((await b.call('use', b.use)).ok, true);
    assert.equal((await b.call('use', { ...b.use, request: { ...b.request, ...changes.stdin!(b) } })).ok, true);
    assert.equal(b.runs(), 2, 'standing consent actually covers changed inputs');
    const create = await b.call('create', { meta: { name: 'test/SECOND', kind: 'secret', class: 'standard' }, source: 'generate', bind: [frame.add] });
    assert.match(JSON.stringify(create.challenge.card.items), /caller.*argv.*cwd.*allow-listed.*env.*stdin.*timeout/);
    const propose = await b.call('create', { source: { migrate: 'propose', proposals: { 'test/PROGRAM': { class: 'standard' } } } });
    assert.match(JSON.stringify(propose.challenge.card.items), /caller.*argv.*cwd.*allow-listed.*env.*stdin.*timeout/);
  } finally { b.broker.lock(); }
});
test('task grants expire exactly five minutes after approval despite repeated same-task reuse', async () => {
  let clock = Date.parse('2026-11-03T12:00:00Z');
  const b = await fresh(() => new Date(clock));
  const site = await standIn();
  try {
    const made = await boundCredential(b.p, site.origin, { consent: false, class: 'standard' });
    const use = { ref: made.ref, target: { kind: 'http', origin: site.origin }, request: { method: 'GET', path: '/api/x' }, task: { id: 'reused-forever' } };
    assert.equal((await b.p.approve('use', use)).ok, true);
    for (const elapsed of [60_000, 120_000, 299_999]) {
      clock = Date.parse('2026-11-03T12:00:00Z') + elapsed;
      assert.equal((await b.call('use', use)).ok, true);
    }
    clock++;
    const expired = await b.call('use', use);
    assert.equal(expired.refused, 'needs_approval');
    assert.equal(site.requests.length, 4);
    assert.match(expired.challenge.card.approving, /five minutes|5 minutes/);
    assert.equal((await b.call('use', { ...use, approval: b.p.approval(expired.challenge) })).ok, true);
    await b.call('lock'); await b.call('unlock', { device: true });
    assert.equal((await b.call('use', use)).refused, 'needs_approval', 'lock clears even fresh grants');
  } finally { b.broker.lock(); await site.close(); }
});
test('HTTP query substitution needs matching approval and a new grant; audit retains bare path', async () => {
  const b = await fresh(); const site = await standIn();
  try {
    const made = await boundCredential(b.p, site.origin, { consent: false, class: 'standard' });
    const use = { ref: made.ref, target: { kind: 'http', origin: site.origin }, request: { method: 'GET', path: '/api/x?filter=caller-query-private' }, task: { id: 'query-task' } };
    const asked = await b.call('use', use);
    const changed = { ...use, request: { ...use.request, path: '/api/x?filter=changed-query-private' } };
    assert.equal((await b.call('use', { ...changed, approval: b.p.approval(asked.challenge) })).refused, 'approval_invalid');
    assert.equal(site.requests.length, 0);
    assert.equal((await b.call('use', { ...use, approval: b.p.approval(asked.challenge) })).ok, true);
    assert.equal((await b.call('use', changed)).refused, 'needs_approval');
    assert.equal(site.requests.length, 1);
    assert.equal((await b.p.approve('use', changed)).ok, true);
    assert.deepEqual(site.requests.map((r) => r.url), [use.request.path, changed.request.path]);
    assert.equal((await b.call('use', { ...use, request: { method: 'GET', path: '/outside?filter=x' } })).refused, 'out_of_scope');
    const publicText = JSON.stringify(b.answers) + readFileSync(join(b.dir, 'audit.log'), 'utf8');
    for (const text of ['caller-query-private', 'changed-query-private']) assert.equal(anyForm(publicText, text), null);
    assert.equal(asked.record.scope_item, 'GET /api/x');
  } finally { b.broker.lock(); await site.close(); }
});
test('HTTP card identifies query changes without showing raw query', async () => {
  const b = await fresh(); const site = await standIn();
  try {
    const made = await boundCredential(b.p, site.origin, { consent: false, class: 'standard' });
    const use = { ref: made.ref, target: { kind: 'http', origin: site.origin }, request: { method: 'GET', path: '/api/x?filter=private-first' } };
    const first = await b.call('use', use);
    const next = await b.call('use', { ...use, request: { ...use.request, path: '/api/x?filter=private-second' } });
    assert.match(JSON.stringify(first.challenge.card.flags), /query.*sha256:[a-f0-9]{64}/);
    assert.notDeepEqual(first.challenge.card.flags, next.challenge.card.flags);
    assert.ok(!JSON.stringify(b.answers).includes('private-first'));
    assert.ok(!JSON.stringify(b.answers).includes('private-second'));
  } finally { b.broker.lock(); await site.close(); }
});
const policy = { length: 16, alphabet: '0123456789abcdef' };
for (const source of ['generate', 'sealed']) {
  test(`${source} creation approval binds exact stored generation policy`, async () => {
    const b = await fresh();
    try {
      const frame = { meta: { name: 'test/POLICY', kind: 'secret', policy }, source };
      const asked = await b.call('create', frame);
      const envelope = source === 'sealed' ? await sealValue((await b.p.state()).entry_key, asked.challenge.digest, C('policy-sealed')) : null;
      const approval = b.p.approval(asked.challenge, 'passkey', envelope);
      const changed = { ...frame, meta: { ...frame.meta, policy: { length: 32, alphabet: 'ABCDEFGHIJKLMNOP' } }, source: envelope ? { sealed: envelope } : source, approval };
      assert.equal((await b.call('create', changed)).refused, 'approval_invalid');
      assert.deepEqual((await b.call('list_refs')).refs, []);
      const made = await b.call('create', { ...frame, source: envelope ? { sealed: envelope } : source, approval: b.p.approval(asked.challenge, 'passkey', envelope) });
      assert.equal(made.ok, true);
      assert.deepEqual(b.broker.store.meta(made.ref).policy, policy);
      assert.equal(anyForm(JSON.stringify(b.answers), C('policy-sealed')), null);
    } finally { b.broker.lock(); }
  });
  test(`${source} create card shows validated policy, including future generated replacements`, async () => {
    const b = await fresh();
    try {
      const frame = { meta: { name: 'test/POLICY', kind: 'secret', policy }, source };
      const asked = await b.call('create', frame);
      const shown = JSON.stringify(asked.challenge.card);
      assert.match(shown, /16 characters/); assert.match(shown, /16 distinct/); assert.match(shown, /64 bits/); assert.ok(shown.includes(policy.alphabet));
      const made = await b.p.approve('create', frame, source === 'sealed' ? { seal: C('policy-future'), sealAt: (f, e) => ({ ...f, source: { sealed: e } }) } : {});
      assert.equal(made.ok, true);
      await b.call('lock'); await b.call('unlock', { device: true });
      for (const [verb, args] of [['rotate', { ref: made.ref, phase: 'begin' }], ['update', { ref: made.ref, change: { value: 'generate' } }]] as const) {
        const card = await b.call(verb, args);
        assert.match(JSON.stringify(card.challenge.card), /16 characters.*16 distinct.*64 bits/);
        assert.equal((await b.call(verb, { ...args, approval: b.p.approval(card.challenge) })).ok, true);
        const value = b.broker.store.value(made.ref, verb === 'rotate' ? 'pending' : 'current');
        try { assert.match(value.toString(), /^[0-9a-f]{16}$/); assert.equal(anyForm(JSON.stringify(b.answers), value.toString()), null); } finally { value.fill(0); }
      }
    } finally { b.broker.lock(); }
  });
}
test('generation policy validation rejects coercion and unsafe policies before offering approval', async () => {
  const b = await fresh();
  try {
    const bad: unknown[] = [{ length: '16', alphabet: policy.alphabet }, { length: 16, alphabet: 1234567890123456 }, null, [], 'policy',
      { length: 15, alphabet: policy.alphabet }, { length: 129, alphabet: policy.alphabet }, { length: 16.5, alphabet: policy.alphabet },
      { length: 16, alphabet: '0123456789abcde' }, { length: 16, alphabet: policy.alphabet + ' ' }, { length: 16, alphabet: policy.alphabet + '\n' }, { length: 16, alphabet: policy.alphabet + 'é' }];
    for (const p of bad) {
      const answer = await b.call('create', { meta: { name: 'test/INVALID', kind: 'secret', policy: p }, source: 'generate' });
      assert.equal(answer.error, 'failed', JSON.stringify(p)); assert.equal(answer.challenge, undefined);
    }
    for (const length of [16, 128]) {
      const value = generate({ length, alphabet: policy.alphabet + '00' });
      try { assert.equal(value.length, length); assert.match(value.toString(), /^[0-9a-f]+$/); } finally { value.fill(0); }
    }
  } finally { b.broker.lock(); }
});
