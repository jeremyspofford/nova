// The Decision Service as the person sees and sets it (DS1 NOTE 4, owner decision 2; evals NOTE 1):
// GET/PUT /models/decisions (the route, model and key for Jev, Tev1's size, the two opt-ins, every
// notice before saving, each model's scorecard), the device record's decision model, Health's
// "Outside content" lines, and the eval scorecards route. The hub's Ollama is a closed port, so no
// real model is touched; nothing calls TypeSafe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { OPT_IN_WORDS } from '../../src/core/decision-service/index.ts';
import { evals } from '../../src/core/index.ts';
import { hubHardware } from '../support/models.ts';

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'nova-decisions-api-'));
  const config = { ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC' }), port: 0 };
  const nova = createNova(config, { models: { ollamaUrl: 'http://127.0.0.1:9', hardware: async () => hubHardware(), watchMs: 60_000 } });
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };
  return { nova, home, call, stop: async () => { nova.server.close(); await nova.core.close(); rmSync(home, { recursive: true, force: true }); } };
}

const KEY = 'ts-test-key-0123456789abcdef';

test('GET /models/decisions: the seats, the choices (never the key), recommendation, notices, scorecards and the opt-in words', async () => {
  const { call, stop } = await boot();
  try {
    const { status, body } = await call('GET', '/models/decisions');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['jev', 'legacy', 'notices', 'opt_in_words', 'privacy', 'recommendation', 'scorecards', 'settings', 'tev1']);
    assert.deepEqual(body.settings, { jev: null, tev1: { model: 'auto' }, opt_in: { screening: false, box: false }, key_set: false });
    assert.deepEqual(body.recommendation.jev, { base_url: 'https://api.typesafe.ai', model: 'jev-1.14.0' });
    assert.equal(body.recommendation.tev1.model, 'tev1:4b');
    assert.deepEqual(body.opt_in_words, OPT_IN_WORDS);
    assert.match(body.opt_in_words.screening, /Local-only isn’t strictly local for screening while it is on/);
    assert.match(body.opt_in_words.box, /preview/);
    assert.match(body.jev.why, /isn’t set up/);
    assert.equal(body.legacy.wired, true);
    assert.deepEqual(body.notices, [], 'nothing chosen, nothing to notice');
  } finally { await stop(); }
});

test('PUT /models/decisions: 422 with problems; tier 2 needs confirm, with every notice first; the key goes to the vault only', async () => {
  const { nova, call, stop } = await boot();
  try {
    // An alias, an address that isn't one, a bad size, a non-boolean opt-in, a key that isn't text.
    const bad = await call('PUT', '/models/decisions', { jev: { base_url: 'not a url', model: 'jev-latest' }, tev1: { model: 'tev1:70b' }, opt_in: { screening: 'yes' }, key: 42 });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.problems.length >= 4, JSON.stringify(bad.body));
    assert.ok(bad.body.problems.some((p: string) => /alias/.test(p)));
    assert.ok(bad.body.problems.some((p: string) => /key/.test(p)));
    // A real choice that isn't Nova's recommendation, with the screening opt-in on: refused until
    // confirmed, with the notices to read (route, unevaluated, the opt-in's own words).
    const choice = { jev: { base_url: 'https://gateway.example.com', model: 'jev-1.13.0' }, opt_in: { screening: true, box: false }, key: KEY };
    const ask = await call('PUT', '/models/decisions', choice);
    assert.equal(ask.status, 409);
    assert.match(ask.body.error, /confirm: true/);
    const words = ask.body.details.join('\n');
    assert.match(words, /isn’t the Jev model Nova recommends/);
    assert.match(words, /gateway\.example\.com isn’t TypeSafe’s own API/);
    assert.match(words, /hasn’t passed the eval for ingest-screen v1/);
    assert.ok(ask.body.details.includes(OPT_IN_WORDS.screening));
    assert.equal((await call('GET', '/models/decisions')).body.settings.jev, null, 'nothing saved without confirm');
    assert.equal(nova.core.vault.has('decisions.jev'), false);
    // Confirmed: saved; the key is in the vault and never in any answer.
    const ok = await call('PUT', '/models/decisions', { ...choice, confirm: true });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.settings, { jev: { base_url: 'https://gateway.example.com', model: 'jev-1.13.0' }, tev1: { model: 'auto' }, opt_in: { screening: true, box: false }, key_set: true });
    assert.equal(nova.core.vault.get('decisions.jev'), KEY);
    assert.doesNotMatch(ok.text, new RegExp(KEY));
    assert.doesNotMatch((await call('GET', '/models/decisions')).text, new RegExp(KEY));
    assert.ok(ok.body.notices.some((n: { kind: string }) => n.kind === 'opt_in'), 'the opt-in’s notice stays while it is on');
    assert.ok(ok.body.scorecards.some((c: { seat: string; model: string; templates: { trusted: boolean }[] }) => c.seat === 'jev' && c.model === 'jev-1.13.0' && c.templates.every((t) => !t.trusted)), 'its scorecard: no passing eval');
    assert.match(ok.body.jev.why, /Jev \(jev-1\.13\.0\) at gateway\.example\.com/);
    // Turning the opt-in off is a change too (tier 2), and removing the key deletes it.
    assert.equal((await call('PUT', '/models/decisions', { opt_in: { screening: false, box: false } })).status, 409);
    const off = await call('PUT', '/models/decisions', { opt_in: { screening: false, box: false }, key: null, confirm: true });
    assert.equal(off.body.settings.opt_in.screening, false);
    assert.equal(off.body.settings.key_set, false);
    // No change: nothing to confirm.
    assert.equal((await call('PUT', '/models/decisions', {})).status, 200);
    // {use} still sets whether System 1 uses the sorting model.
    assert.equal((await call('PUT', '/models/decisions', { use: 'rules' })).status, 200);
    assert.equal(nova.core.profile.get('models', 'decisions'), 'rules');
    assert.equal((await call('PUT', '/models/decisions', { use: 'maybe' })).status, 400);
    // Nothing is dropped in silence (review): {use} with other choices, an unknown field, and an
    // opt_in that isn't {screening, box} are each refused with their problem.
    const mixed = await call('PUT', '/models/decisions', { use: 'model', opt_in: { screening: true } });
    assert.equal(mixed.status, 422);
    assert.match(mixed.body.problems[0], /on its own; send opt_in separately/);
    assert.equal(nova.core.profile.get('models', 'decisions'), 'rules', 'nothing of it was applied');
    const unknown = await call('PUT', '/models/decisions', { jev: null, capture: true });
    assert.equal(unknown.status, 422);
    assert.match(unknown.body.problems[0], /doesn’t know capture/);
    for (const opt_in of [true, 'yes', ['screening'], null, { screening: true, capture: true }]) {
      const r = await call('PUT', '/models/decisions', { opt_in, confirm: true });
      assert.equal(r.status, 422, JSON.stringify(opt_in));
      assert.match(r.body.problems.join(' '), /opt_in must be \{screening, box\}|must be on or off/);
    }
  } finally { await stop(); }
});

test('the device record names the decision model, and Health has a plain line per seat', async () => {
  const { call, stop } = await boot();
  try {
    const hub = (await call('GET', '/models')).body.devices[0];
    assert.ok('decision_model' in hub);
    assert.deepEqual(Object.keys(hub.decision_model).sort(), ['digest', 'model', 'why']);
    const ingest = (await call('GET', '/health')).body.checks.ingest;
    assert.equal(ingest.model, false);
    assert.match(ingest.detail, /held back as unsure/);
    assert.equal(ingest.lines.length, 4);
    assert.match(ingest.lines[0], /^Tev1: /);
    assert.match(ingest.lines[1], /^Jev: .*isn’t set up/);
    assert.match(ingest.lines[2], /^Sorting model: /);
    assert.match(ingest.lines[3], /aren’t relied on yet.*held back as unsure/);
  } finally { await stop(); }
});

test('GET /evals/scorecards: each configured model’s card or a plain “none”, and one model’s status', async () => {
  const { home, call, stop } = await boot();
  try {
    const all = await call('GET', '/evals/scorecards');
    assert.equal(all.status, 200);
    assert.equal(all.body.fingerprint, evals.REGRESSION_FINGERPRINT);
    assert.ok(Array.isArray(all.body.configured) && Array.isArray(all.body.cards));
    // A card kept in this home's workers/evals/ is read back.
    const store = new evals.Scorecards(home);
    mkdirSync(store.dir, { recursive: true });
    const one = await call('GET', '/evals/scorecards/status?provider=openai-compatible&model=example-small:3b');
    assert.equal(one.body.state, 'none');
    assert.match(one.body.words, /No scorecard.*You can still switch to it/);
    writeFileSync(join(store.dir, 'note.txt'), 'not a card');
    assert.equal((await call('GET', '/evals/scorecards')).status, 200);
  } finally { await stop(); }
});
