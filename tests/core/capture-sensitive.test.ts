// capture-sensitive v1 (capture screening, job 1; plan docs/plans/ds2-capture-sensitive.md): the
// deterministic pre-pass (known sensitive apps with no model call; key, token and number patterns,
// redacted before the model sees the text), the truth table, the stricter-wins combination, and the
// routing rule: capture text never goes to a cloud seat in local-first or local-only, and in cloud
// mode only with the capture source's own opt-in. Synthetic values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, Registry } from '../../src/core/decision-service/registry.ts';
import { rows, checkTable } from '../../src/core/decision-service/policy.ts';
import { DecisionService } from '../../src/core/decision-service/service.ts';
import { MemoryLog } from '../../src/core/decision-service/log.ts';
import { memoryVerdicts, type VerdictRecord } from '../../src/core/decision-service/verdicts.ts';
import { Tev1Seat } from '../../src/core/decision-service/seats/tev1.ts';
import { JevSeat } from '../../src/core/decision-service/seats/jev.ts';
import { DEFAULT_SETTINGS, type DecisionSettings } from '../../src/core/decision-service/settings.ts';
import { CAPTURE_SENSITIVE_V1, CS_QUESTIONS, capturePolicy, capturePrecheck, findSecrets, redact, sensitiveApp } from '../../src/core/decision-service/templates/capture-sensitive.ts';
import { startTev1StandIn } from '../support/tev1-stand-in.ts';
import { startJevStandIn } from '../support/jev-stand-in.ts';
import type { PrivacyMode } from '../../src/core/envelope.ts';

test('the template passes the authoring rules with no warnings, and its rule is a full truth table', () => {
  assert.deepEqual(validate(CAPTURE_SENSITIVE_V1), { errors: [], warnings: [] });
  assert.equal(CAPTURE_SENSITIVE_V1.feature, 'capture');
  assert.equal(rows(CAPTURE_SENSITIVE_V1).length, 3 ** 4);
  assert.deepEqual(checkTable(CAPTURE_SENSITIVE_V1), []);
  const all = (b: string) => Object.fromEntries(CS_QUESTIONS.map((q) => [q, b]));
  assert.equal(capturePolicy(all('no')), 'index');
  assert.equal(capturePolicy({ ...all('no'), password: 'yes' }), 'exclude');
  assert.equal(capturePolicy({ ...all('no'), secret_key: 'yes' }), 'exclude');
  assert.equal(capturePolicy({ ...all('no'), financial_details: 'yes' }), 'hold');
  assert.equal(capturePolicy({ ...all('no'), health_details: 'yes' }), 'hold');
  for (const q of CS_QUESTIONS) assert.equal(capturePolicy({ ...all('no'), [q]: 'unsettled' }), 'hold', `${q} unsettled: when unsure, don't index`);
  assert.equal(capturePolicy({ ...all('no'), health_details: 'yes', secret_key: 'yes' }), 'exclude', 'the stricter wins');
  assert.deepEqual(CAPTURE_SENSITIVE_V1.policy.order, ['index', 'redact', 'hold', 'exclude']);
});

test('pattern detectors: key and token shapes, private keys, passwords, cards (Luhn), IBANs (mod 97), SSNs; and not the look-alikes', () => {
  const kinds = (t: string) => findSecrets(t).map((f) => f.kind);
  assert.deepEqual(kinds('aws key AKIAIOSFODNN7EXAMPLE'), ['cloud access key']);
  assert.deepEqual(kinds('token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'), ['access token']);
  // Assembled at run time: a key-shaped literal in source trips secret scanners, though it is made up.
  assert.deepEqual(kinds(`stripe ${['sk', 'test', 'CANARY51Habcdefghijklmnop'].join('_')}`), ['access token']);
  assert.deepEqual(kinds('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----'), ['private key']);
  assert.deepEqual(kinds('db: postgres://app:CanaryPass9@db.example.com/main'), ['password in a connection string']);
  assert.deepEqual(kinds('wifi password is maple-cloud-71'), ['password']);
  assert.deepEqual(kinds('pin: 4821'), ['password']);
  assert.deepEqual(kinds('card 4242 4242 4242 4242 exp 12/30'), ['card number']);
  assert.deepEqual(kinds('IBAN GB82 WEST 1234 5698 7654 32'), ['bank account (IBAN)']);
  assert.deepEqual(kinds('ssn 123-45-6789'), ['social security number']);
  assert.deepEqual(kinds('api_key = Zx81QpLm2Vn7Rt4Ws9Yb3Kc6Hd1Fg5Jq'), ['secret']);
  // Look-alikes: masked fields, prose, a hex hash, a phone number, a card that fails Luhn, a bad IBAN.
  for (const t of ['Password: ••••••', 'the pin is in the map', 'commit token 3f2a9c1e0b7d4a6f8e2c1b0a9d8e7f6a5b4c3d2e', 'call 555-123-4567', 'card 4242 4242 4242 4241', 'IBAN GB82 WEST 1234 5698 7654 33', 'Set YOUR_API_KEY in the environment.']) assert.deepEqual(kinds(t), [], t);
  const text = 'wifi password is maple-cloud-71 and card 4242 4242 4242 4242';
  assert.equal(redact(text, findSecrets(text)), 'wifi [redacted: password] and card [redacted: card number]');
});

test('known sensitive apps: password managers and banking apps and sites, by whole words', () => {
  assert.match(sensitiveApp('Bitwarden', '')!, /password manager/);
  assert.match(sensitiveApp('1Password 8', '')!, /password manager/);
  assert.match(sensitiveApp('Example Bank', '')!, /banking app/);
  assert.match(sensitiveApp('Firefox', 'https://online.examplebank.com/accounts')!, /banking site/);
  assert.equal(sensitiveApp('Firefox', 'https://news.example.com/banking-rates'), null, 'a page about banking on a news site is not a bank');
  assert.equal(sensitiveApp('Notes', ''), null);
  assert.equal(sensitiveApp('Passwordless Login Demo', ''), null, 'whole words only');
});

const pass = (template_id: string, seat: 'jev' | 'tev1', model: string): VerdictRecord => ({ template_id, version: 1, seat, model, status: 'pass', why: 'test', run_at: null, ref: 'test' });

async function rig(o: { mode?: PrivacyMode; verdicts?: VerdictRecord[]; screeningOptIn?: boolean; captureCloud?: (s: string) => boolean; tev1?: Parameters<typeof startTev1StandIn>[0] } = {}) {
  const ollama = await startTev1StandIn(o.tev1 ?? {});
  const api = await startJevStandIn({ noul: () => 0.05 });
  const settings: DecisionSettings = { ...DEFAULT_SETTINGS, jev: { base_url: api.url, model: 'jev-1.14.0' }, opt_in: { screening: o.screeningOptIn ?? false, box: false } };
  const registry = new Registry();
  registry.add(CAPTURE_SENSITIVE_V1);
  const tev1 = new Tev1Seat({ url: ollama.url });
  await tev1.refresh();
  const log = new MemoryLog();
  const service = new DecisionService({
    registry, log, settings: () => settings, privacy: () => o.mode ?? 'local-only',
    verdicts: memoryVerdicts(o.verdicts ?? []),
    seats: { tev1, jev: new JevSeat({ config: () => ({ ...settings.jev!, key: () => api.key }) }) },
    ...(o.captureCloud ? { captureCloud: o.captureCloud } : {}),
  });
  return { service, log, ollama, api, close: async () => { await ollama.close(); await api.close(); } };
}

const item = (text: string, app = 'Notes', url = '') => ({ kind: 'ocr', app, url, text });

test('a known sensitive app is excluded with no model call at all, and the record says so', async () => {
  const r = await rig({ verdicts: [pass('capture-sensitive', 'tev1', 'tev1:4b@aaaa4b')] });
  try {
    const d = (await r.service.ask('capture-sensitive', item('Vault: 12 items', 'Bitwarden'), { subsystem: 'capture' }))!;
    assert.equal(d.outcome, 'exclude');
    assert.equal(d.seat, 'stub');
    assert.equal(r.ollama.requests.length, 0, 'no model call');
    assert.equal(r.log.records[0]!.egress, 'none');
    assert.match(d.why, /password manager/);
  } finally { await r.close(); }
});

test('patterns redact before the model sees the text, and their outcome stands whatever the model says', async () => {
  const r = await rig({ verdicts: [pass('capture-sensitive', 'tev1', 'tev1:4b@aaaa4b')] });
  try {
    const d = (await r.service.ask('capture-sensitive', item('deploy notes: api_key = Zx81QpLm2Vn7Rt4Ws9Yb3Kc6Hd1Fg5Jq for staging'), { subsystem: 'capture' }))!;
    const sent = JSON.stringify(r.ollama.requests.map((x) => x.state));
    assert.doesNotMatch(sent, /Zx81QpLm2Vn7Rt4Ws9Yb3Kc6Hd1Fg5Jq/, 'the model never sees the secret');
    assert.match(sent, /\[redacted: secret\]/);
    assert.equal(d.outcome, 'redact', 'the model said no to everything; the pattern’s redact stands');
    assert.deepEqual(d.findings!.map((f) => f.kind), ['secret']);
    assert.doesNotMatch(JSON.stringify(r.log.records[0]), /Zx81QpLm2Vn7Rt4Ws9Yb3Kc6Hd1Fg5Jq/, 'never in the record');
  } finally { await r.close(); }
  // The model's stricter outcome wins over the pattern's redact.
  const r2 = await rig({ verdicts: [pass('capture-sensitive', 'tev1', 'tev1:4b@aaaa4b')], tev1: { score: (_c, q) => (q === 'health_details' ? 0.95 : 0.02) } });
  try {
    const d = (await r2.service.ask('capture-sensitive', item('card 4242 4242 4242 4242; diagnosis follow-up Tuesday'), { subsystem: 'capture' }))!;
    assert.equal(d.outcome, 'hold');
  } finally { await r2.close(); }
});

test('untrusted: the deterministic checks still run; otherwise today’s behaviour (index), with the model’s answer as a shadow', async () => {
  const r = await rig();
  try {
    const d = (await r.service.ask('capture-sensitive', item('Team lunch on Friday at noon.'), { subsystem: 'capture' }))!;
    assert.equal(d.trust, 'none');
    assert.equal(d.outcome, 'index');
    assert.equal(r.log.records[0]!.shadows[0]!.seat, 'tev1');
    const red = (await r.service.ask('capture-sensitive', item('pin: 4821'), { subsystem: 'capture' }))!;
    assert.equal(red.outcome, 'redact');
  } finally { await r.close(); }
});

test('routing: capture text never goes to the cloud in local-first or local-only, even with the screening opt-in on', async () => {
  for (const mode of ['local-only', 'local-preferred'] as const) {
    const r = await rig({ mode, screeningOptIn: true, verdicts: [pass('capture-sensitive', 'jev', 'jev-1.14.0')], captureCloud: () => true });
    try {
      await r.service.ask('capture-sensitive', item('Team lunch.'), { subsystem: 'capture', capture_source: 'screen-1' });
      assert.equal(r.api.requests.length, 0, mode);
      assert.ok(r.log.records[0]!.failures.some((f) => f.seat === 'jev' && /never goes to a cloud provider in local-first or local-only/.test(f.why)));
    } finally { await r.close(); }
  }
});

test('routing: in cloud mode only with the capture source’s own opt-in (not built yet, so off)', async () => {
  const off = await rig({ mode: 'cloud-allowed', verdicts: [pass('capture-sensitive', 'jev', 'jev-1.14.0')] });
  try {
    await off.service.ask('capture-sensitive', item('Team lunch.'), { subsystem: 'capture', capture_source: 'screen-1' });
    assert.equal(off.api.requests.length, 0, 'no per-source opt-in: never');
    assert.ok(off.log.records[0]!.failures.some((f) => /only with that capture source’s own opt-in/.test(f.why)));
  } finally { await off.close(); }
  const on = await rig({ mode: 'cloud-allowed', verdicts: [pass('capture-sensitive', 'jev', 'jev-1.14.0')], captureCloud: (s) => s === 'screen-1' });
  try {
    const d = (await on.service.ask('capture-sensitive', item('Team lunch.'), { subsystem: 'capture', capture_source: 'screen-1' }))!;
    assert.equal(d.seat, 'jev');
    assert.equal(on.log.records[0]!.opt_in, 'capture');
    await on.service.ask('capture-sensitive', item('Team lunch.'), { subsystem: 'capture', capture_source: 'screen-2' });
    assert.equal(on.api.requests.length, 1, 'another source, not opted in: not sent');
  } finally { await on.close(); }
});

test('the precheck is what the template uses, end to end, and returns nothing for ordinary text', () => {
  assert.equal(capturePrecheck(item('Team lunch on Friday.')), null);
  assert.equal(capturePrecheck(item('anything', 'KeePassXC'))!.final, true);
  const p = capturePrecheck(item('wifi password is maple-cloud-71'))!;
  assert.equal(p.final, false);
  assert.equal((p.fields as { text: string }).text, 'wifi [redacted: password]');
});

test('the committed verdicts: trusted on exactly tev1:4b@7954…, and on nothing else', async () => {
  const { fileVerdicts } = await import('../../src/core/decision-service/verdicts.ts');
  const v = fileVerdicts();
  const four = v.lookup('capture-sensitive', 1, 'tev1', 'tev1:4b@7954dce22bc6c29c3b119656207681d12cb34434fed7caa086bfbc919bef0740');
  assert.equal(four.trusted, true, four.why);
  assert.equal(v.lookup('capture-sensitive', 1, 'tev1', 'tev1:0.8b@abc31fdb0bf52506cc47091145ac19c4cfb509b73a6841789324f9e32200c099').trusted, false);
  assert.equal(v.lookup('capture-sensitive', 1, 'tev1', 'tev1:4b@some-other-build').trusted, false, 'a different build is untrusted until the eval runs again');
  assert.equal(v.lookup('capture-sensitive', 1, 'jev', 'jev-1.14.0').trusted, false, 'no verdict for the cloud seat');
  assert.equal(v.passed('capture-sensitive', 1), true);
  assert.equal(v.passed('ingest-screen', 2), false, 'the ingest screen is unaffected');
});
