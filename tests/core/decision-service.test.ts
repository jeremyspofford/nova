// The Decision Service (ADR docs/plans/decision-service.md; plan docs/plans/ds1.md): routing by
// privacy mode and the person's opt-ins (owner decisions 1 and 4), trusted seats and shadows, the
// sorting model retired per template (decision 3), fall-through, the pin, the policy and autonomy,
// state hygiene and the decision log. Every seat is real; Ollama and TypeSafe are loopback
// stand-ins. Nothing here calls TypeSafe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fence, QUESTIONS } from '../../src/core/ingest/screen.ts';
import { DecisionService } from '../../src/core/decision-service/service.ts';
import { Registry } from '../../src/core/decision-service/registry.ts';
import { MemoryLog, FileLog } from '../../src/core/decision-service/log.ts';
import { memoryVerdicts, type VerdictRecord } from '../../src/core/decision-service/verdicts.ts';
import { Tev1Seat } from '../../src/core/decision-service/seats/tev1.ts';
import { JevSeat } from '../../src/core/decision-service/seats/jev.ts';
import { LegacySeat } from '../../src/core/decision-service/seats/legacy.ts';
import { INGEST_SCREEN_V1 } from '../../src/core/decision-service/templates/ingest-screen.ts';
import { autonomy } from '../../src/core/decision-service/policy.ts';
import { DEFAULT_SETTINGS, type DecisionSettings } from '../../src/core/decision-service/settings.ts';
import { createDecisionService, BUILT_INS } from '../../src/core/decision-service/index.ts';
import { SCREEN } from '../../src/core/ingest/screen.ts';
import { validateTemplate, type Decision, type DecisionProvider, type Template } from '../../src/core/decide.ts';
import { MARK, startTev1StandIn } from '../support/tev1-stand-in.ts';
import { startJevStandIn } from '../support/jev-stand-in.ts';
import type { PrivacyMode } from '../../src/core/envelope.ts';
import type { ServiceTemplate } from '../../src/core/decision-service/types.ts';

// A text battery: a Noul, a Choice with its escape as a companion Noul, and a tier-1 action.
const TEXT: ServiceTemplate = {
  template_id: 'demo-text', version: 1, purpose: 'Sort a note into a folder.', feature: 'screening',
  fields: { note: { type: 'text', max_chars: 500 } },
  questions: {
    is_receipt: { type: 'noul', instructions: 'Is `note` a receipt for a purchase?' },
    folder: { type: 'choice', instructions: 'Which folder does `note` belong in?', criteria: { bills: 'Bills and receipts', travel: 'Trips and bookings' } },
    fits: { type: 'noul', instructions: 'Does `note` fit any of these folders: bills, travel?', escapes: 'folder' },
  },
  policy: {
    outcomes: { file: { action: 'file the note', tier: 1 }, leave: { action: 'leave it in the inbox', tier: 0, restrictive: true } },
    table: (b) => (b.fits === 'yes' && b.folder !== 'unsettled' ? 'file' : 'leave'),
    default: 'leave', low: 'escalate',
  },
  legacy: true,
};

// An image battery: a Box with its companion Noul.
const PNG = (w: number, h: number) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return new Uint8Array(b); };
const BOX: ServiceTemplate = {
  template_id: 'demo-box', version: 1, purpose: 'Find a parcel at the door.', feature: 'box',
  fields: { frame: { type: 'image' } },
  questions: {
    has_parcel: { type: 'noul', instructions: 'Is there a parcel in `frame`?' },
    parcel: { type: 'box', instructions: 'the parcel in `frame`', companion: 'has_parcel' },
  },
  policy: {
    outcomes: { note: { action: 'note a delivery', tier: 1 }, none: { action: 'do nothing', tier: 0, restrictive: true } },
    table: (b) => (b.has_parcel === 'yes' && b.parcel === 'located' ? 'note' : 'none'),
    default: 'none', low: 'stop',
  },
};

// Today's sorting model, as an old-style provider: it answers what it is told and records calls.
function sortingModel(answer: Record<string, number | string> = { is_receipt: 0.9, folder: 'bills', fits: 0.9 }) {
  const calls: Record<string, unknown>[] = [];
  const provider: DecisionProvider = {
    id: 'local-model', egress: 'local', questionTypes: ['noul', 'choice', 'score'],
    async decide(t: Template, inputs: Record<string, unknown>): Promise<Decision> {
      calls.push(inputs);
      return { template_id: t.template_id, version: t.version, answers: answer, confidence: 0.9, provider: 'local-model', escalate: false, why: '' };
    },
  };
  const old = (id: string): Template | null => {
    if (id !== 'demo-text') return null;
    const def = validateTemplate({ template_id: 'demo-text', version: 1, situation: 'Sort a note.', inputs: { note: 'string' }, questions: [{ id: 'is_receipt', type: 'noul' }, { id: 'folder', type: 'choice', options: ['bills', 'travel', 'unknown'] }, { id: 'fits', type: 'noul' }], escalation: { confidence_floor: 0 } });
    return { ...def, stats: { uses: 0, agreed: 0, disagreed: 0 }, state: 'active', dry_runs: [], activation_task_id: null, created_by: 'test', created_at: '', updated_at: '' };
  };
  return { seat: new LegacySeat({ provider, old }), calls };
}

async function rig(o: { verdicts?: VerdictRecord[]; settings?: Partial<DecisionSettings>; mode?: PrivacyMode; jev?: Parameters<typeof startJevStandIn>[0]; tev1?: Parameters<typeof startTev1StandIn>[0]; legacy?: boolean } = {}) {
  const ollama = await startTev1StandIn(o.tev1 ?? {});
  const jevApi = await startJevStandIn(o.jev ?? {});
  const settings: DecisionSettings = { ...DEFAULT_SETTINGS, jev: { base_url: jevApi.url, model: 'jev-1.14.0' }, opt_in: { screening: false, box: false }, ...(o.settings ?? {}) };
  let mode: PrivacyMode = o.mode ?? 'cloud-allowed';
  const registry = new Registry();
  registry.add(TEXT); registry.add(BOX); registry.add(INGEST_SCREEN_V1);
  const tev1 = new Tev1Seat({ url: ollama.url });
  await tev1.refresh();
  const jev = new JevSeat({ config: () => (settings.jev ? { ...settings.jev, key: () => jevApi.key } : null) });
  const legacy = o.legacy === false ? undefined : sortingModel();
  const log = new MemoryLog();
  const receipts: unknown[] = [];
  const service = new DecisionService({
    registry, verdicts: memoryVerdicts(o.verdicts ?? []), settings: () => settings, privacy: () => mode, log,
    seats: { tev1, jev, ...(legacy ? { legacy: legacy.seat } : {}) }, receipt: (r) => receipts.push(r),
  });
  return {
    service, log, receipts, settings, ollama, jevApi, legacy,
    setMode: (m: PrivacyMode) => { mode = m; },
    close: async () => { await ollama.close(); await jevApi.close(); },
  };
}

const pass = (template_id: string, seat: 'jev' | 'tev1', model: string): VerdictRecord => ({ template_id, version: 1, seat, model, status: 'pass', why: 'test pass', run_at: '2026-10-31T00:00:00Z', ref: `test#${seat}` });

test('cloud mode, Jev set up and passed: Jev decides; the state went out with a receipt', async () => {
  const r = await rig({ verdicts: [pass('demo-text', 'jev', 'jev-1.14.0')], jev: { noul: () => 0.9 } });
  try {
    const d = (await r.service.ask('demo-text', { note: 'Receipt: 2 coffees, 6.40' }, { subsystem: 'test' }))!;
    assert.equal(d.seat, 'jev');
    assert.equal(d.trust, 'verdict');
    assert.equal(d.outcome, 'file');
    assert.equal(d.autonomy, 'act', 'tier 1, all settled');
    assert.equal(r.ollama.requests.length, 0, 'a trusted seat goes first; Tev1 isn’t asked');
    assert.equal(r.legacy!.calls.length, 0);
    const rec = r.log.records[0]!;
    assert.equal(rec.egress, 'remote:typesafe');
    assert.equal(rec.opt_in, null, 'cloud mode needs no opt-in');
    assert.equal(rec.model_asked, 'jev-1.14.0');
    assert.equal(r.receipts.length, 1);
    assert.deepEqual(r.jevApi.requests[0]!.body.questions.fits, { type: 'noul', instructions: 'Does `note` fit any of these folders: bills, travel?' }, 'service-only fields never go on the wire');
    assert.equal(r.jevApi.requests[0]!.headers['typesafe-danger-zone-long-context'], undefined);
  } finally { await r.close(); }
});

test('nothing passed yet: Jev and Tev1 answer as shadows (evidence), and the sorting model decides as today', async () => {
  const r = await rig();
  try {
    const d = (await r.service.ask('demo-text', { note: 'Boarding pass, gate 12' }, { subsystem: 'test' }))!;
    assert.equal(d.seat, 'legacy');
    assert.equal(d.trust, 'legacy');
    assert.equal(r.legacy!.calls.length, 1);
    assert.deepEqual(r.legacy!.calls[0], { note: 'Boarding pass, gate 12' }, 'the old inputs, unchanged');
    const rec = r.log.records[0]!;
    assert.deepEqual(rec.shadows.map((s) => s.seat), ['jev', 'tev1'], 'cloud order: Jev, then Tev1');
    assert.ok(rec.shadows.every((s) => s.answers && /no eval verdict/.test(s.why)));
    assert.equal(rec.egress, 'remote:typesafe', 'a shadow in the cloud still means the state went out');
  } finally { await r.close(); }
});

test('local-only with Jev set up but the screening opt-in off: Jev is never asked', async () => {
  const r = await rig({ mode: 'local-only', verdicts: [pass('demo-text', 'jev', 'jev-1.14.0')] });
  try {
    const d = (await r.service.ask('demo-text', { note: 'x' }, { subsystem: 'test' }))!;
    assert.equal(r.jevApi.requests.length, 0);
    assert.notEqual(d.seat, 'jev');
    assert.equal(r.log.records[0]!.egress, 'local');
    assert.equal(r.receipts.length, 0);
    assert.ok(r.log.records[0]!.failures.some((f) => f.seat === 'jev' && /keeps screening on this device unless its opt-in is on/.test(f.why)));
  } finally { await r.close(); }
});

test('local-only and local-preferred with the screening opt-in on: Jev answers, and the record and receipt name the opt-in', async () => {
  for (const mode of ['local-only', 'local-preferred'] as const) {
    const r = await rig({ mode, settings: { opt_in: { screening: true, box: false } }, verdicts: [pass('demo-text', 'jev', 'jev-1.14.0')] });
    try {
      const d = (await r.service.ask('demo-text', { note: 'Receipt' }, { subsystem: 'test' }))!;
      assert.equal(d.seat, 'jev', mode);
      const rec = r.log.records[0]!;
      assert.equal(rec.opt_in, 'screening');
      assert.equal(rec.egress, 'remote:typesafe');
      assert.equal((r.receipts[0] as { opt_in: string }).opt_in, 'screening');
    } finally { await r.close(); }
  }
});

test('in a local mode Tev1 comes before Jev; a trusted seat comes before both', async () => {
  const r = await rig({ mode: 'local-only', settings: { opt_in: { screening: true, box: false } } });
  try {
    await r.service.ask('demo-text', { note: 'x' }, { subsystem: 'test' });
    assert.deepEqual(r.log.records[0]!.shadows.map((s) => s.seat), ['tev1', 'jev']);
  } finally { await r.close(); }
  const r2 = await rig({ mode: 'local-only', settings: { opt_in: { screening: true, box: false } }, verdicts: [pass('demo-text', 'jev', 'jev-1.14.0')] });
  try {
    const d = (await r2.service.ask('demo-text', { note: 'x' }, { subsystem: 'test' }))!;
    assert.equal(d.seat, 'jev');
    assert.equal(r2.ollama.requests.length, 0);
  } finally { await r2.close(); }
});

test('a caller can only tighten the mode: asked as local-only under live cloud mode, Jev isn’t used', async () => {
  const r = await rig({ verdicts: [pass('demo-text', 'jev', 'jev-1.14.0')] });
  try {
    await r.service.ask('demo-text', { note: 'x' }, { subsystem: 'test', privacy_mode: 'local-only' });
    assert.equal(r.jevApi.requests.length, 0);
    assert.equal(r.log.records[0]!.privacy_mode, 'local-only');
  } finally { await r.close(); }
});

test('Box: an opt-in in every mode; in local-only never to the cloud; images go as assets with the images header', async () => {
  const frame = { image: PNG(640, 480) };
  // Opt-in off, cloud mode: no seat for images, the safe default.
  const r = await rig({ verdicts: [pass('demo-box', 'jev', 'jev-1.14.0')] });
  try {
    const d = (await r.service.ask('demo-box', { frame }, { subsystem: 'test' }))!;
    assert.equal(d.seat, 'stub');
    assert.equal(d.outcome, 'none');
    assert.equal(r.jevApi.requests.length, 0);
  } finally { await r.close(); }
  // Opt-in on, local-only: still never the cloud (owner decision 4, refined); no local seat reads images.
  const r2 = await rig({ mode: 'local-only', settings: { opt_in: { screening: true, box: true } }, verdicts: [pass('demo-box', 'jev', 'jev-1.14.0')] });
  try {
    const d = (await r2.service.ask('demo-box', { frame }, { subsystem: 'test' }))!;
    assert.equal(d.seat, 'stub');
    assert.equal(r2.jevApi.requests.length, 0);
    assert.equal(r2.ollama.requests.length, 0, 'Tev1 reads no images');
    assert.ok(r2.log.records[0]!.failures.some((f) => /never go to a cloud provider/.test(f.why)));
  } finally { await r2.close(); }
  // Opt-in on, local-preferred and cloud: Jev, with the frame as an asset and the images header.
  for (const mode of ['local-preferred', 'cloud-allowed'] as const) {
    const r3 = await rig({ mode, settings: { opt_in: { screening: false, box: true } }, verdicts: [pass('demo-box', 'jev', 'jev-1.14.0')], jev: { noul: () => 0.95 } });
    try {
      const d = (await r3.service.ask('demo-box', { frame }, { subsystem: 'test' }))!;
      assert.equal(d.seat, 'jev', mode);
      assert.equal(d.outcome, 'note');
      const req = r3.jevApi.requests[0]!;
      assert.equal(req.headers['typesafe-danger-zone-images'], 'true');
      const [ref, asset] = Object.entries(req.body.assets!)[0]!;
      assert.equal((req.body.state as { frame: string }).frame, ref);
      assert.equal(asset.format, 'png');
      assert.equal(Buffer.from(asset.data_base64, 'base64').length, 33);
      const rec = r3.log.records[0]!;
      assert.equal(rec.opt_in, 'box');
      assert.doesNotMatch(JSON.stringify(rec), new RegExp(asset.data_base64.slice(0, 16).replace(/[+/=]/g, '.')), 'the image is never in the record');
      assert.deepEqual((rec.answers!.parcel as { box: object }).box, { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 });
    } finally { await r3.close(); }
  }
});

test('the sorting model is retired per template once a decision seat passes its eval', async () => {
  // Tev1 passed demo-text on a digest that isn't installed: retired anyway; Tev1 here is untrusted.
  const r = await rig({ mode: 'local-only', verdicts: [pass('demo-text', 'tev1', 'tev1:4b@some-other-build')] });
  try {
    const d = (await r.service.ask('demo-text', { note: 'x' }, { subsystem: 'test' }))!;
    assert.equal(r.legacy!.calls.length, 0, 'retired');
    assert.equal(d.seat, 'stub');
    assert.equal(d.trust, 'none');
    assert.equal(d.outcome, 'leave');
    assert.ok(r.log.records[0]!.failures.some((f) => f.seat === 'legacy' && /retired for demo-text v1/.test(f.why)));
  } finally { await r.close(); }
});

test('a failing trusted seat falls through, said in the record; a different model version is never used', async () => {
  const r = await rig({ verdicts: [pass('demo-text', 'jev', 'jev-1.14.0')], jev: { status: 500 } });
  try {
    const d = (await r.service.ask('demo-text', { note: 'x' }, { subsystem: 'test' }))!;
    assert.notEqual(d.seat, 'jev');
    assert.ok(r.log.records[0]!.failures.some((f) => f.seat === 'jev' && /answered 500/.test(f.why)));
  } finally { await r.close(); }
  const r2 = await rig({ verdicts: [pass('demo-text', 'jev', 'jev-1.14.0')], jev: { answerModel: 'jev-1.15.0' } });
  try {
    const d = (await r2.service.ask('demo-text', { note: 'x' }, { subsystem: 'test' }))!;
    assert.notEqual(d.seat, 'jev');
    assert.ok(r2.log.records[0]!.failures.some((f) => /jev-1\.14\.0 was asked but jev-1\.15\.0 answered; the answer isn’t used/.test(f.why)));
  } finally { await r2.close(); }
});

test('an alias is refused: Jev is unavailable, in words, and nothing is sent', async () => {
  const r = await rig({ settings: { jev: { base_url: 'http://127.0.0.1:1', model: 'jev-latest' } } });
  try {
    await r.service.ask('demo-text', { note: 'x' }, { subsystem: 'test' });
    assert.ok(r.log.records[0]!.failures.some((f) => f.seat === 'jev' && /jev-latest is an alias that moves/.test(f.why)));
  } finally { await r.close(); }
});

test('ingest-screen v1 through the service: Tev1 untrusted on this build answers as a shadow; the safe default holds', async () => {
  const r = await rig({ mode: 'local-only', legacy: false });
  try {
    const content = fence(`Ordinary page text. ${MARK}`);
    const d = (await r.service.ask('ingest-screen', { source_kind: 'web', origin: 'www.example.org', content }, { subsystem: 'ingest' }))!;
    assert.equal(d.trust, 'none');
    assert.equal(d.outcome, 'quarantine');
    assert.equal(d.autonomy, 'act', 'quarantine is restrictive: it acts');
    const shadow = r.log.records[0]!.shadows[0]!;
    assert.equal(shadow.seat, 'tev1');
    assert.equal((shadow.answers!.direct_instruction as { noul: number }).noul, 0.97, 'the scores are kept as evidence');
  } finally { await r.close(); }
  // Passed on this exact build: Tev1 decides, by the gate's own thresholds.
  const r2 = await rig({ mode: 'local-only', legacy: false, verdicts: [pass('ingest-screen', 'tev1', 'tev1:4b@aaaa4b')] });
  try {
    const hit = (await r2.service.ask('ingest-screen', { source_kind: 'web', origin: 'www.example.org', content: fence(`Some text. ${MARK}`) }, { subsystem: 'ingest' }))!;
    assert.equal(hit.trust, 'verdict');
    assert.equal(hit.outcome, 'block');
    const clean = (await r2.service.ask('ingest-screen', { source_kind: 'web', origin: 'www.example.org', content: fence('Plant peas early.') }, { subsystem: 'ingest' }))!;
    assert.equal(clean.outcome, 'pass');
    assert.deepEqual(Object.keys(clean.answers!), [...QUESTIONS]);
  } finally { await r2.close(); }
});

test('the decision record: every field, full answers, and never the state’s content', async () => {
  const r = await rig({ verdicts: [pass('demo-text', 'jev', 'jev-1.14.0')] });
  try {
    const secret = 'CANARY-NOTE-CONTENT-9F2B';
    await r.service.ask('demo-text', { note: `Receipt ${secret}` }, { subsystem: 'test', task_id: 'task-1' });
    const rec = r.log.records[0]!;
    for (const k of ['id', 'at', 'task_id', 'subsystem', 'template_id', 'version', 'seat', 'model_asked', 'model', 'privacy_mode', 'egress', 'opt_in', 'state_sha256', 'state_fields', 'pieces', 'requests', 'usage', 'answers', 'shadows', 'failures', 'bands', 'outcome', 'action', 'tier', 'autonomy', 'quality', 'trust', 'verdict_ref', 'why']) assert.ok(k in rec, k);
    assert.equal(rec.task_id, 'task-1');
    assert.deepEqual(rec.state_fields, ['note']);
    assert.match(rec.state_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys((rec.answers!.folder as { probabilities: object }).probabilities), ['bills', 'travel'], 'full probabilities');
    assert.equal(rec.verdict_ref, 'test#jev');
    assert.doesNotMatch(JSON.stringify(rec), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(r.receipts), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(rec), /test-key-not-secret/, 'never the key');
    // The file sink writes the same records.
    const file = join(mkdtempSync(join(tmpdir(), 'nova-ds-log-')), 'logs', 'decisions.jsonl');
    new FileLog(file).write(rec);
    assert.equal(JSON.parse(readFileSync(file, 'utf8').trim()).id, rec.id);
  } finally { await r.close(); }
});

test('state hygiene: only declared fields, never truncated, images checked in code', async () => {
  const r = await rig();
  try {
    await assert.rejects(r.service.ask('demo-text', { note: 'x', memory: 'everything' }, { subsystem: 'test' }), /memory isn’t a field of demo-text/);
    await assert.rejects(r.service.ask('demo-text', { note: 'x'.repeat(501) }, { subsystem: 'test' }), /at most 500 \(never truncated\)/);
    await assert.rejects(r.service.ask('demo-box', { frame: { image: PNG(100, 100) } }, { subsystem: 'test' }), /each side must be 280 to 1568 pixels/);
    await assert.rejects(r.service.ask('demo-box', { frame: { image: new Uint8Array([1, 2, 3]) } }, { subsystem: 'test' }), /isn’t a PNG or JPEG/);
    assert.equal(await r.service.ask('no-such-template', {}, { subsystem: 'test' }), null, 'a cache miss is null, never an ad hoc question');
    assert.equal(r.log.records.length, 0);
  } finally { await r.close(); }
});

test('autonomy: System One only lowers it; restrictive outcomes act; tier 3 always confirms', () => {
  assert.equal(autonomy(0, 'high', false, 'escalate'), 'act');
  assert.equal(autonomy(1, 'medium', false, 'escalate'), 'ask');
  assert.equal(autonomy(1, 'low', false, 'escalate'), 'escalate');
  assert.equal(autonomy(2, 'high', false, 'stop'), 'ask');
  assert.equal(autonomy(3, 'high', false, 'escalate'), 'confirm');
  assert.equal(autonomy(3, 'low', false, 'escalate'), 'stop');
  assert.equal(autonomy(0, 'low', true, 'stop'), 'act');
});

test('a medium answer asks: one unsettled question on a tier-1 action', async () => {
  const r = await rig({ verdicts: [pass('demo-text', 'jev', 'jev-1.14.0')], jev: { noul: (_c, q) => (q === 'fits' ? 0.9 : 0.5) } });
  try {
    const d = (await r.service.ask('demo-text', { note: 'x' }, { subsystem: 'test' }))!;
    assert.equal(d.bands!.is_receipt, 'unsettled');
    assert.equal(d.quality, 'medium');
    assert.equal(d.outcome, 'file');
    assert.equal(d.autonomy, 'ask');
  } finally { await r.close(); }
});

test('createDecisionService: the built-ins, the seats, and the view for Health and the device record', async () => {
  const ollama = await startTev1StandIn();
  try {
    const { service, refresh, view } = createDecisionService({
      settings: () => ({ ...DEFAULT_SETTINGS, jev: { base_url: 'https://api.typesafe.ai', model: 'jev-1.13.0' } }),
      privacy: () => 'local-only', log: new MemoryLog(), ollamaUrl: () => ollama.url, jevKey: () => null,
      legacy: { provider: sortingModel().seat as never, old: () => null },
      verdicts: memoryVerdicts([pass('ingest-screen', 'tev1', 'tev1:4b@other')]),
    });
    await refresh();
    assert.deepEqual(service.registry.list().map((x) => `${x.template.template_id}@${x.template.version}`), BUILT_INS.map((t) => `${t.template_id}@${t.version}`));
    const v = await view();
    assert.equal(v.tev1.model, 'tev1:4b');
    assert.equal(v.jev.available, false);
    assert.match(v.jev.why, /without a key/);
    assert.deepEqual(v.legacy.retired_for, ['ingest-screen v1']);
    assert.ok(v.notices.some((n) => n.kind === 'model' && /jev-1\.13\.0 isn’t the Jev model Nova recommends \(jev-1\.14\.0\)/.test(n.words)));
    assert.ok(v.notices.some((n) => n.kind === 'unevaluated' && /tev1:4b@aaaa4b hasn’t passed the eval for ingest-screen v1/.test(n.words)));
    assert.equal(v.scorecards.find((c) => c.seat === 'tev1')!.templates[0]!.trusted, false);
  } finally { await ollama.close(); }
  assert.ok(SCREEN.template_id === INGEST_SCREEN_V1.template_id);
});

test('the receipt is taken before anything is sent: a refused receipt means Jev is never asked', async () => {
  const ollama = await startTev1StandIn();
  const jevApi = await startJevStandIn({ noul: () => 0.9 });
  try {
    const registry = new Registry();
    registry.add(TEXT);
    const settings: DecisionSettings = { ...DEFAULT_SETTINGS, jev: { base_url: jevApi.url, model: 'jev-1.14.0' } };
    const log = new MemoryLog();
    const service = new DecisionService({
      registry, log, settings: () => settings, privacy: () => 'cloud-allowed',
      verdicts: memoryVerdicts([pass('demo-text', 'jev', 'jev-1.14.0')]),
      seats: { jev: new JevSeat({ config: () => ({ ...settings.jev!, key: () => jevApi.key }) }) },
      receipt: () => { throw new Error('Local-only mode doesn’t allow sending context to typesafe.'); },
    });
    const d = (await service.ask('demo-text', { note: 'x' }, { subsystem: 'test' }))!;
    assert.equal(jevApi.requests.length, 0, 'nothing sent');
    assert.equal(d.seat, 'stub');
    assert.ok(log.records[0]!.failures.some((f) => /The receipt was refused, so nothing was sent/.test(f.why)));
    assert.equal(log.records[0]!.egress, 'none');
  } finally { await ollama.close(); await jevApi.close(); }
});
