// The fallback never loosens (docs/plans/gate-decision-service.md, safety rule 2). The gate's own
// regression corpus (tests/ingest/corpus) runs through the new path, the real core with the
// Decision Service, in every privacy mode, with each seat state:
//   - unavailable: Tev1 is set up but its Ollama doesn't answer, and Jev is set up with a key but
//     its route fails (in local modes the screening opt-in is ON, so the cloud is really tried);
//   - untrusted: Tev1 and Jev both answer (stand-ins on loopback that see nothing wrong, 0.02),
//     with no passing eval verdict (opt-in ON in local modes again);
//   - trusted stand-in: Tev1 and Jev both have a passing verdict (in memory, for this test only),
//     with the screening opt-in OFF, the owner's default.
// With no trusted seat, every verdict must be at least as strict as today's checks plus quarantine
// (the baseline: no seat at all). With a trusted seat that sees nothing wrong, the checks alone still
// catch every injection; with one that sees an injection everywhere, nothing passes. Nothing here
// calls TypeSafe: Jev is a loopback stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { memoryVerdicts } from '../../src/core/decision-service/index.ts';
import { startTev1StandIn } from '../support/tev1-stand-in.ts';
import { startJevStandIn } from '../support/jev-stand-in.ts';
import { hubHardware } from '../support/models.ts';
import { pass } from '../support/decision-gate.ts';
import type { PrivacyMode } from '../../src/core/envelope.ts';

interface Item { id: string; category: string; expect?: 'quarantine' | 'block'; source: { kind: string; origin: string }; text?: string; html?: string; headers?: Record<string, string>; attachments?: { name: string; type?: string }[] }
const load = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'corpus', f), 'utf8')) as Item[];
const INJECTION = load('injection.json');
const BENIGN = load('benign.json');
const ALL = [...INJECTION, ...BENIGN];
const KNOWN_FALSE_POSITIVES = new Set(['article-about-injection']);
const RANK = { pass: 0, quarantine: 1, block: 2 } as const;
type V = keyof typeof RANK;
const MODES: PrivacyMode[] = ['local-only', 'local-preferred', 'cloud-allowed'];
const CLOSED = 'http://127.0.0.1:9';

type State = 'none' | 'unavailable' | 'untrusted' | 'trusted';

async function rig(mode: PrivacyMode, state: State, p = 0.02, o: { optIn?: boolean } = {}) {
  const tev1 = state === 'untrusted' || state === 'trusted' ? await startTev1StandIn({ score: () => p }) : null;
  const jev = state === 'none' ? null : await startJevStandIn({ noul: () => p, ...(state === 'unavailable' ? { status: 503 } : {}) });
  const verdicts = memoryVerdicts(state === 'trusted' ? [pass('tev1', 'tev1:4b@aaaa4b'), pass('jev', 'jev-1.14.0')] : []);
  const home = mkdtempSync(join(tmpdir(), 'nova-gate-matrix-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, models: { ollamaUrl: tev1?.url ?? CLOSED, hardware: async () => hubHardware() as never, watchMs: 60_000 }, decisions: { verdicts } });
  core.profile.set('privacy', 'default', mode, 'settings');
  const optIn = o.optIn ?? (state === 'unavailable' || state === 'untrusted');
  if (jev) {
    core.profile.set('models', 'decision', { jev: { base_url: jev.url, model: 'jev-1.14.0' }, tev1: { model: 'auto' }, opt_in: { screening: optIn, box: false } }, 'settings');
    core.vault.put('decisions.jev', jev.key);
  }
  await core.decisionService.refresh();
  return { core, tev1, jev, close: async () => { await core.close(); await tev1?.close(); await jev?.close(); } };
}

async function screenAll(core: Core) {
  const out = new Map<string, { verdict: V; max: number | null; model: string | null }>();
  for (const it of ALL) {
    const r = await core.ingest.screen({ ...(it.text !== undefined ? { text: it.text } : {}), ...(it.html !== undefined ? { html: it.html } : {}), ...(it.headers ? { headers: it.headers } : {}), ...(it.attachments ? { attachments: it.attachments } : {}), source: it.source as never });
    out.set(it.id, { verdict: r.verdict, max: r.max, model: r.model });
  }
  return out;
}

let baseline: Map<string, { verdict: V }> | null = null;

test('the baseline: no seat at all is today’s checks plus quarantine', async () => {
  const r = await rig('local-only', 'none');
  try {
    assert.equal(r.core.health().checks.ingest.model, false);
    baseline = await screenAll(r.core);
    for (const it of INJECTION) assert.ok(RANK[baseline.get(it.id)!.verdict] >= RANK[it.expect!], it.id);
    for (const it of BENIGN) assert.equal(baseline.get(it.id)!.verdict, 'quarantine', it.id);
  } finally { await r.close(); }
});

for (const mode of MODES) {
  for (const state of ['unavailable', 'untrusted'] as const) {
    test(`${mode}, seats ${state}: every verdict at least as strict as checks plus quarantine`, async () => {
      const r = await rig(mode, state);
      try {
        assert.equal(r.core.health().checks.ingest.model, false, 'Health says nothing is relied on');
        assert.match(r.core.health().checks.ingest.detail, /held back as unsure/);
        const got = await screenAll(r.core);
        for (const it of ALL) {
          const g = got.get(it.id)!;
          assert.ok(RANK[g.verdict] >= RANK[baseline!.get(it.id)!.verdict], `${it.id}: ${g.verdict}, baseline ${baseline!.get(it.id)!.verdict}`);
          assert.notEqual(g.verdict, 'pass', `${it.id}: nothing passes on an untrusted or missing answer`);
          assert.equal(g.model, null, `${it.id}: no model's answer was used`);
        }
        // The seats were really tried: the cloud only as the mode and the opt-in allow.
        if (state === 'untrusted') assert.ok(r.tev1!.requests.length > 0, 'Tev1 answered, as evidence');
        assert.ok(r.jev!.requests.length > 0, 'Jev was tried (cloud mode, or the screening opt-in in a local mode)');
        const records = r.core.db.all<{ trust: string; egress: string; opt_in: string | null; privacy_mode: string }>("SELECT trust, egress, opt_in, privacy_mode FROM decision_record WHERE template_id = 'ingest-screen'");
        assert.ok(records.length > 0 && records.every((x) => x.trust === 'none' && x.privacy_mode === mode));
        const remote = r.core.receipts.list({ egress: 'remote', limit: 1000 });
        assert.ok(remote.length > 0 && remote.every((x) => x.provider === 'jev' && x.opt_in === (mode === 'cloud-allowed' ? null : 'screening')), JSON.stringify(remote.slice(0, 2)));
      } finally { await r.close(); }
    });
  }

  test(`${mode}, trusted stand-in that sees nothing wrong: the checks still catch every injection; benign passes`, async () => {
    const r = await rig(mode, 'trusted', 0.02);
    try {
      assert.equal(r.core.health().checks.ingest.model, true);
      const got = await screenAll(r.core);
      for (const it of INJECTION) assert.ok(RANK[got.get(it.id)!.verdict] >= RANK[it.expect!], `${it.id}: ${got.get(it.id)!.verdict}, expected at least ${it.expect}`);
      const fp = BENIGN.filter((it) => got.get(it.id)!.verdict !== 'pass');
      assert.ok(fp.every((it) => got.get(it.id)!.verdict === 'quarantine'), 'a false positive is held back, never blocked');
      assert.deepEqual(fp.map((x) => x.id).sort(), [...KNOWN_FALSE_POSITIVES].sort());
      // Which seat decided follows the mode: Jev in cloud mode; Tev1 in the local modes, where the
      // screening opt-in is off, so Jev is never sent anything.
      const passed = got.get(BENIGN[0]!.id)!;
      assert.equal(passed.model, mode === 'cloud-allowed' ? 'jev:jev-1.14.0' : 'tev1:tev1:4b@aaaa4b');
      if (mode !== 'cloud-allowed') assert.equal(r.jev!.requests.length, 0, `${mode}: nothing went to the cloud`);
    } finally { await r.close(); }
  });

  test(`${mode}, trusted stand-in that sees an injection everywhere: nothing passes, everything blocks`, async () => {
    const r = await rig(mode, 'trusted', 0.95);
    try {
      const got = await screenAll(r.core);
      for (const it of ALL) assert.equal(got.get(it.id)!.verdict, 'block', it.id);
    } finally { await r.close(); }
  });
}

test('local-only with the screening opt-in on: Jev screens, and the receipt and the record name the opt-in', async () => {
  const r = await rig('local-only', 'trusted', 0.02, { optIn: true });
  try {
    // Tev1 trusted and local comes first in local-only; with Tev1 gone, the opted-in Jev decides.
    await r.tev1!.close();
    r.core.profile.set('models', 'decision', { jev: { base_url: r.jev!.url, model: 'jev-1.14.0' }, tev1: null, opt_in: { screening: true, box: true } }, 'settings');
    const s = await r.core.ingest.screen({ text: 'Mix flour and water. Bake for an hour.', source: { kind: 'web', origin: 'www.example.org' } });
    assert.equal(s.verdict, 'pass');
    assert.equal(s.model, 'jev:jev-1.14.0');
    const remote = r.core.receipts.list({ egress: 'remote' });
    assert.deepEqual(remote.map((x) => [x.provider, x.privacy_mode, x.opt_in]), [['jev', 'local-only', 'screening']]);
    const rec = r.core.db.get<{ egress: string; opt_in: string; trust: string }>("SELECT egress, opt_in, trust FROM decision_record WHERE template_id = 'ingest-screen'")!;
    assert.deepEqual({ ...rec }, { egress: 'remote:typesafe', opt_in: 'screening', trust: 'verdict' });
  } finally { await r.close(); }
});
