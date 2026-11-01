// Capture screening, job 1, switched on in the real capture pipeline (owner decision
// INPUT-2026-10-31-CAPTURE-SCREENING-DECISION.md; ADR docs/plans/decision-service.md §2.1, with
// option B; plan docs/plans/capture-screening-consumers.md). End to end through capture's intake (a
// Screenpipe pull, and a device's inbox), against stand-ins only: the Tev1 stand-in answers
// capture-sensitive from markers in the text, and is trusted only when a test says so.
//   - Nova's own rules first, with no model call: sensitive apps dropped at intake; key, token,
//     card and similar shapes redacted before anything is stored.
//   - Every outcome applied: index, redact, hold, exclude; unsure holds.
//   - Canary secrets never reach memory, the archive, its write-ahead log or a backup in clear.
//   - Option B: with no trusted model on the device, every event is held, with the notice, and
//     never triaged or remembered; held events are checked once a model is trusted, and expire
//     with retention.
//   - Provenance on each event; the decision record names the capture source.
//   - No cloud seat in local-first or local-only, nor in cloud mode without the per-source opt-in
//     (which doesn't exist: always off).
// Synthetic placeholders only (published test card numbers, canary keys); nothing is captured from
// this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { memoryVerdicts } from '../../src/core/decision-service/index.ts';
import { HELD_NOTICE } from '../../src/core/capture/capture.ts';
import { captureCheck, STAND_IN_MODEL } from '../support/capture-check.ts';
import { startJevStandIn } from '../support/jev-stand-in.ts';
import { hubHardware } from '../support/models.ts';
import { call, enroll, hub } from './mesh-support.ts';
import type { PrivacyMode } from '../../src/core/envelope.ts';

type Hub = Awaited<ReturnType<typeof hub>>;
type Sp = Awaited<ReturnType<typeof startFakeScreenpipe>>;
type Check = Awaited<ReturnType<typeof captureCheck>>;
const min = (h: Hub, n: number) => new Date(h.clock.t + n * 60_000).toISOString();
const CLOSED = 'http://127.0.0.1:9';

// Canary values, all synthetic: a published test card, a cloud key shape, a GitHub token shape.
const CARD = '4242 4242 4242 4242';
const AWS = 'AKIACANARY0000000000';
const GH = 'ghp_CANARY0123456789abcdefghijklmnopqrstu';

function holding(dir: string, needle: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...holding(p, needle));
    else if (e.isFile() && readFileSync(p).includes(Buffer.from(needle))) out.push(p);
  }
  return out;
}

async function rig(o: { trusted?: boolean; tev1?: boolean } = {}) {
  const check = o.tev1 === false ? null : await captureCheck({ trusted: o.trusted ?? true });
  const core = check?.core ?? { models: { ollamaUrl: CLOSED, hardware: async () => hubHardware() as never, watchMs: 60_000 }, decisions: { verdicts: memoryVerdicts([]) } };
  const h = await hub({ core });
  await h.core.decisionService.refresh();
  const sp = await startFakeScreenpipe();
  const added = await h.c('POST', '/capture/sources/screenpipe', { url: sp.base });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const id = added.body.id as string;
  await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
  h.tick(60_000);
  const pull = async () => (await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/pull`)).body;
  const screen = async () => (await h.c('POST', '/capture/screen')).body;
  const events = async () => (await h.c('GET', '/capture/events?limit=100')).body as any[];
  const byText = async (needle: string) => (await events()).find((e) => (e.text ?? '').includes(needle) || (e.window_title ?? '').includes(needle));
  const close = async () => { await sp.close(); await h.stop(); await check?.close(); };
  return { h, sp, id, check: check as Check, pull, screen, events, byText, close };
}

const promote = (h: Hub, id: string) => h.c('POST', '/capture/promote', { event_ids: [id] });

test('Nova’s own rules first: password managers and banking apps and sites are dropped at intake, counted, never stored, and no model is asked', async () => {
  const r = await rig();
  try {
    r.sp.add(
      { at: min(r.h, 1), app: '1Password', window: 'Vault', text: 'SENSITIVE-APP-ONE' },
      { at: min(r.h, 2), app: 'Bitwarden', window: 'My vault', text: 'SENSITIVE-APP-TWO' },
      { at: min(r.h, 3), app: 'Example Bank', window: 'Accounts', text: 'SENSITIVE-APP-THREE' },
      { at: min(r.h, 4), app: 'Browser', window: 'Statement', url: 'https://onlinebanking.example.com/accounts', text: 'SENSITIVE-SITE' },
      { at: min(r.h, 5), app: 'Editor', window: 'notes.txt', text: 'An ordinary note about the weekend' },
    );
    const got = await r.pull();
    assert.equal(got.kept, 1, JSON.stringify(got));
    assert.deepEqual(got.dropped, { sensitive_app: 4 });
    assert.deepEqual((await r.h.c('GET', '/capture')).body.sources[0].counts, { kept: 1, sensitive_app: 4 });
    for (const w of ['SENSITIVE-APP-ONE', 'SENSITIVE-APP-TWO', 'SENSITIVE-APP-THREE', 'SENSITIVE-SITE']) assert.deepEqual(holding(r.h.home, w), [], `${w} is nowhere under the home`);
    await r.screen();
    assert.equal(r.check.seen().length, 1, 'only the ordinary note reached the model');
    assert.ok(!r.check.seen().some((s) => /SENSITIVE-/.test(s)));
    // A device's capture through the inbox is dropped the same way.
    const { dev, token } = await enroll(r.h, { kind: 'computer', name: 'Test computer' });
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await call(r.h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { capabilities: ['heartbeat', 'queue', 'capture.screen'] }, auth)).status, 200);
    await r.h.c('POST', `/capture/sources/${encodeURIComponent(`device:${dev.deviceId}:screen`)}/enable`);
    r.h.tick(60_000);
    const sent = await call(r.h.mesh, 'POST', '/api/v1/mesh/inbox', { items: [{ key: 'cap-pm-0001', kind: 'capture_event', body: { kind: 'screen', at: min(r.h, 1), app: 'KeePassXC', window_title: 'db.kdbx', text: 'SENSITIVE-DEVICE' } }] }, auth);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.match(sent.body.results[0].reason, /password managers and banking apps and sites are never kept/);
    assert.deepEqual(holding(r.h.home, 'SENSITIVE-DEVICE'), []);
  } finally { await r.close(); }
});

test('every outcome end to end through intake: index, redact, hold, exclude, and unsure holds; each shown with its reason, nothing deleted silently', async () => {
  const r = await rig();
  try {
    r.sp.add(
      { at: min(r.h, 1), app: 'Editor', window: 'plan.md', text: 'Draft the quarterly plan outline' },
      { at: min(r.h, 2), app: 'Notes', window: 'card', text: `Pay the invoice with card ${CARD} and key ${AWS}` },
      { at: min(r.h, 3), app: 'Notes', window: 'clinic', text: 'Alex Placeholder CANARY-GREY-HEALTH follow-up on Tuesday' },
      { at: min(r.h, 4), app: 'Chat', window: 'wifi', text: 'the wifi word is CANARY-GREY-PASSWORD maple' },
      { at: min(r.h, 5), app: 'Notes', window: 'odd', text: 'CANARY-GREY-UNSURE something ambiguous' },
    );
    assert.equal((await r.pull()).kept, 5);
    // Taken in after the rules, not yet checked: held until it is, and nothing can be remembered.
    const before = await r.events();
    assert.ok(before.every((e) => e.sensitivity.state === 'unscreened' && e.sensitivity.usable === false));
    const card = before.find((e) => e.window_title === 'card');
    assert.equal(card.text, 'Pay the invoice with card [redacted: card number] and key [redacted: cloud access key]', 'redacted before it was stored');
    assert.equal((await promote(r.h, card.id)).status, 409, 'not checked yet: it can’t be remembered');

    const done = await r.screen();
    assert.deepEqual(done.outcomes, { index: 1, redact: 1, hold: 2, exclude: 1 });
    const ev = Object.fromEntries((await r.events()).map((e) => [e.window_title, e]));
    assert.equal(ev['plan.md'].sensitivity.state, 'index');
    assert.equal(ev['plan.md'].sensitivity.why, null);
    assert.equal(ev.card.sensitivity.state, 'redact');
    assert.equal(ev.card.sensitivity.why, 'Redacted: a card number and a cloud access key.');
    assert.equal(ev.clinic.sensitivity.state, 'hold');
    assert.match(ev.clinic.sensitivity.why, /^Sensitive: held, not added to memory: Nova’s check found a person’s health details in it\. It is kept only until capture retention deletes it\.$/);
    assert.equal(ev.odd.sensitivity.state, 'hold');
    assert.match(ev.odd.sensitivity.why, /wasn’t sure/);
    assert.equal(ev.wifi.sensitivity.state, 'exclude');
    assert.equal(ev.wifi.text, null, 'its words are cleared');
    assert.equal(ev.wifi.app, 'Chat', 'the row stays: time, app and source');
    assert.match(ev.wifi.sensitivity.why, /^Sensitive: excluded, text not kept: Nova’s check found a password in it\.$/);
    assert.deepEqual(holding(r.h.home, 'CANARY-GREY-PASSWORD'), [], 'the excluded words are nowhere under the home');

    // Only index and redact may be triaged or remembered.
    assert.equal((await promote(r.h, ev['plan.md'].id)).status, 201);
    const m = await promote(r.h, ev.card.id);
    assert.equal(m.status, 201);
    assert.equal(m.body.memory.content, 'Pay the invoice with card [redacted: card number] and key [redacted: cloud access key]');
    for (const k of ['clinic', 'odd', 'wifi']) {
      const refused = await promote(r.h, ev[k].id);
      assert.equal(refused.status, 409, k);
      assert.match(refused.body.error?.message ?? JSON.stringify(refused.body), /can’t be remembered|never added to memory|weren’t kept/, k);
    }
    // Triage looks only at what a trusted check let through.
    let looked: string[] = [];
    r.h.core.decisions.decide = async (t, inputs) => { looked.push(String(inputs.text)); return { template_id: t, version: 1, provider: 'test', answers: { remember: 0.1 }, confidence: 0.9, escalate: false } as never; };
    await r.h.c('POST', '/capture/propose');
    assert.ok(!looked.some((t) => /CANARY-GREY-HEALTH|CANARY-GREY-UNSURE/.test(t)), JSON.stringify(looked));
    // Every event stays in the timeline with its label.
    assert.equal((await r.events()).length, 5);
  } finally { await r.close(); }
});

test('canary secrets never reach the model, memory, the archive, its write-ahead log or a backup in clear', async () => {
  const r = await rig();
  try {
    r.sp.add(
      { at: min(r.h, 1), app: 'Terminal', window: `deploy ${GH}`, url: 'https://deploy:CANARYPASS99@db.example.com/main', text: `export AWS_ACCESS_KEY_ID=${AWS}\ncard ${CARD}\ntoken ${GH}` },
    );
    assert.equal((await r.pull()).kept, 1);
    await r.screen();
    const [e] = await r.events();
    assert.equal(e.sensitivity.state, 'redact');
    assert.deepEqual(e.sensitivity.detail.rules.fields.sort(), ['text', 'url', 'window_title']);
    assert.deepEqual(e.sensitivity.detail.rules.redacted.sort(), ['access token', 'card number', 'cloud access key', 'password in a connection string']);
    assert.equal((await promote(r.h, e.id)).status, 201);
    for (const v of [AWS, GH, '4242 4242 4242 4242', 'CANARYPASS99']) {
      assert.deepEqual(holding(r.h.home, v), [], `${v} is nowhere under the home`);
      assert.ok(!r.check.seen().some((s) => s.includes(v)), `${v} never reached the model`);
    }
    assert.ok(r.h.core.memory.active().every((m) => !m.content.includes(AWS) && !m.content.includes(GH)));
  } finally { await r.close(); }
});

test('an event stored before the rules existed is redacted in place by the template’s own rules, its old words scrubbed', async () => {
  const r = await rig();
  try {
    r.sp.add({ at: min(r.h, 1), app: 'Notes', window: 'old', text: 'placeholder' });
    await r.pull();
    const [e] = await r.events();
    // As if stored by an older Nova: its words in clear, not yet checked.
    r.h.core.db.run(`UPDATE capture_event SET text = ?, sensitivity = 'unscreened', sensitivity_detail = NULL WHERE id = ?`, `old note with ${AWS} in it`, e.id);
    await r.screen();
    const after = (await r.h.c('GET', `/capture/events/${e.id}`)).body;
    assert.equal(after.text, 'old note with [redacted: cloud access key] in it');
    assert.equal(after.sensitivity.state, 'redact');
    assert.deepEqual(after.sensitivity.detail.decision.findings, ['cloud access key']);
    assert.ok(!r.check.seen().some((s) => s.includes(AWS)), 'the template redacted it before the model saw it');
    assert.deepEqual(holding(r.h.home, AWS), []);
  } finally { await r.close(); }
});

test('provenance on each event: template version, the seat and pinned model, scores, capture source, and the decision record', async () => {
  const r = await rig();
  try {
    r.sp.add({ at: min(r.h, 1), app: 'Notes', window: 'clinic', text: 'Sam Placeholder CANARY-GREY-HEALTH results' });
    await r.pull();
    await r.screen();
    const [e] = await r.events();
    const d = e.sensitivity.detail;
    assert.equal(d.template, 'capture-sensitive');
    assert.equal(d.version, 1);
    assert.equal(d.capture_source, r.id);
    assert.equal(d.decision.seat, 'tev1');
    assert.equal(d.decision.model, STAND_IN_MODEL);
    assert.equal(d.decision.trust, 'verdict');
    assert.deepEqual(Object.keys(d.decision.scores).sort(), ['financial_details', 'health_details', 'password', 'secret_key']);
    assert.equal(d.decision.scores.health_details, 0.96);
    assert.equal(d.decision.bands.health_details, 'yes');
    assert.equal(e.sensitivity.decision, d.decision.id);
    const rec = r.h.core.db.get<{ subsystem: string; template_id: string; version: number; seat: string; model: string; egress: string; outcome: string; trust: string }>('SELECT * FROM decision_record WHERE id = ?', e.sensitivity.decision);
    assert.deepEqual([rec?.subsystem, rec?.template_id, rec?.version, rec?.seat, rec?.model, rec?.egress, rec?.outcome, rec?.trust], ['capture', 'capture-sensitive', 1, 'tev1', STAND_IN_MODEL, 'local', 'hold', 'verdict']);
  } finally { await r.close(); }
});

test('option B: with no trusted model on the device, every event is held, not kept, with the notice; nothing is triaged or remembered; no evidence-only asks', async () => {
  for (const kind of ['untrusted', 'no Tev1'] as const) {
    const r = await rig(kind === 'untrusted' ? { trusted: false } : { tev1: false });
    try {
      r.sp.add(
        { at: min(r.h, 1), app: 'Editor', window: 'plan.md', text: 'Draft the quarterly plan outline' },
        { at: min(r.h, 2), app: 'Notes', window: 'card', text: `card ${CARD}` },
      );
      await r.pull();
      const pass = await r.screen();
      assert.deepEqual([pass.outcomes, pass.waiting], [{ held: 2 }, true], kind);
      const ev = await r.events();
      for (const e of ev) {
        assert.equal(e.sensitivity.state, 'held', kind);
        assert.ok(e.sensitivity.why.startsWith(HELD_NOTICE), `${kind}: ${e.sensitivity.why}`);
        assert.equal((await promote(r.h, e.id)).status, 409, kind);
      }
      // The rules still ran: the card is redacted, though the model never checked it.
      assert.equal(ev.find((e) => e.window_title === 'card').text, 'card [redacted: card number]');
      const held = (await r.h.c('GET', '/capture/holding')).body;
      assert.deepEqual([held.held, held.trusted, held.notice], [2, false, HELD_NOTICE], kind);
      assert.ok(held.why, `${kind}: says what stands in the way`);
      assert.deepEqual((await r.h.c('GET', '/capture/status')).body.screening.held, 2);
      if (kind === 'untrusted') assert.equal(r.check.seen().length, 0, 'an untrusted seat isn’t asked for evidence on captured text');
      // Held events aren't asked again while nothing trusted can check them.
      assert.deepEqual((await r.screen()).checked, 0);
      let looked = 0;
      r.h.core.decisions.decide = async () => { looked++; return null as never; };
      await r.h.c('POST', '/capture/propose');
      assert.equal(looked, 0, `${kind}: nothing held is triaged`);
    } finally { await r.close(); }
  }
});

test('held events are released for checking once a model is trusted on the device, and decided then', async () => {
  const r = await rig({ trusted: false });
  try {
    r.sp.add(
      { at: min(r.h, 1), app: 'Editor', window: 'plan.md', text: 'Draft the quarterly plan outline' },
      { at: min(r.h, 2), app: 'Notes', window: 'clinic', text: 'Alex Placeholder CANARY-GREY-HEALTH' },
    );
    await r.pull();
    await r.screen();
    assert.ok((await r.events()).every((e) => e.sensitivity.state === 'held'));
    r.check.trust();
    assert.equal((await r.h.c('GET', '/capture/holding')).body.trusted, true);
    const pass = await r.screen();
    assert.deepEqual(pass.outcomes, { index: 1, hold: 1 });
    const ev = Object.fromEntries((await r.events()).map((e) => [e.window_title, e]));
    assert.equal(ev['plan.md'].sensitivity.state, 'index');
    assert.equal(ev.clinic.sensitivity.state, 'hold');
    assert.equal((await promote(r.h, ev['plan.md'].id)).status, 201);
    assert.equal((await r.h.c('GET', '/capture/holding')).body.held, 0);
  } finally { await r.close(); }
});

test('held and sensitive events expire with retention, like all capture', async () => {
  const r = await rig({ trusted: false });
  try {
    r.sp.add({ at: min(r.h, 1), app: 'Notes', window: 'kept-a-while', text: 'Draft the quarterly plan outline' });
    await r.pull();
    await r.screen();
    assert.equal((await r.events())[0].sensitivity.state, 'held');
    await r.h.c('PUT', '/capture/settings', { retention_days: 1 });
    r.h.tick(2 * 86_400_000);
    const swept = (await r.h.c('POST', '/capture/sweep')).body;
    assert.equal(swept.swept, 1);
    assert.equal((await r.events()).length, 0);
    assert.equal((await r.h.c('GET', '/capture/holding')).body.held, 0);
    assert.deepEqual(holding(r.h.home, 'quarterly plan outline'), []);
  } finally { await r.close(); }
});

test('captured text never goes to a cloud seat in local-first or local-only, nor in cloud mode without the source’s own opt-in (always off)', async () => {
  for (const mode of ['local-only', 'local-preferred', 'cloud-allowed'] as PrivacyMode[]) {
    const jev = await startJevStandIn({ noul: () => 0.02 });
    // Jev is set up, its key saved, the screening opt-in on, and it even has a passing verdict for
    // capture-sensitive: none of it opens a way out for capture text.
    const verdicts = memoryVerdicts([{ template_id: 'capture-sensitive', version: 1, seat: 'jev', model: 'jev-1.14.0', status: 'pass', why: 'test', run_at: '2026-10-31T00:00:00Z', ref: 'test#jev' }]);
    const h = await hub({ core: { models: { ollamaUrl: CLOSED, hardware: async () => hubHardware() as never, watchMs: 60_000 }, decisions: { verdicts } } });
    const sp = await startFakeScreenpipe();
    try {
      h.core.profile.set('privacy', 'default', mode, 'settings');
      h.core.profile.set('models', 'decision', { jev: { base_url: jev.url, model: 'jev-1.14.0' }, tev1: { model: 'auto' }, opt_in: { screening: true, box: false } }, 'settings');
      h.core.vault.put('decisions.jev', jev.key);
      await h.core.decisionService.refresh();
      const id = (await h.c('POST', '/capture/sources/screenpipe', { url: sp.base })).body.id;
      await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
      h.tick(60_000);
      sp.add({ at: min(h, 1), app: 'Notes', window: 'n', text: 'CLOUD-NEVER-SENTINEL an ordinary note' });
      await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/pull`);
      await h.c('POST', '/capture/screen');
      assert.ok(!jev.requests.some((q) => JSON.stringify(q.body).includes('CLOUD-NEVER-SENTINEL')), `${mode}: nothing captured went to Jev`);
      const [e] = (await h.c('GET', '/capture/events')).body;
      assert.equal(e.sensitivity.state, 'held', `${mode}: no trusted local model, so held`);
      const rec = h.core.db.get<{ egress: string; failures: string }>('SELECT egress, failures FROM decision_record WHERE id = ?', e.sensitivity.decision);
      assert.notEqual(rec?.egress, 'remote:typesafe', mode);
      assert.match(rec?.failures ?? '', mode === 'cloud-allowed' ? /only with that capture source’s own opt-in/ : /never goes to a cloud provider in local-first or local-only/, mode);
      assert.equal(h.core.receipts.list({ egress: 'remote', limit: 100 }).filter((x) => x.purpose.includes('capture-sensitive')).length, 0, `${mode}: no remote receipt`);
    } finally { await sp.close(); await h.stop(); await jev.close(); }
  }
});

test('a capture tick checks what it pulled before triage reads anything', async () => {
  const r = await rig();
  try {
    r.sp.add({ at: min(r.h, 1), app: 'Editor', window: 'plan.md', text: 'Draft the quarterly plan outline' });
    const t = await r.h.core.capture.tick();
    assert.equal(t.screened, 1);
    assert.equal((await r.events())[0].sensitivity.state, 'index');
  } finally { await r.close(); }
});
