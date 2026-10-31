// Settings › Models in a real browser (docs/plans/gate-decision-service.md; evals NOTE 2; DS1 NOTE
// 4): each model's eval scorecard before a switch, or a plain "none" that still lets the person
// switch; the decision model with its two separate switches, each with its plain words beside it;
// every notice shown before saving, and the save waiting for the person's OK (tier 2); the opt-in's
// words staying while it is on. Against the real server and the stand-in Ollama. Nothing calls
// TypeSafe. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stop } from '../acceptance/support.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { INSTALLED, LIBRARY, hardwareFile } from '../support/models.ts';
import { evals } from '../../src/core/index.ts';
import { blank, browser, device, finishSetup, ready } from './support.ts';

test('Settings › Models: scorecards before a switch, and the decision model’s switches and notices', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const ollama = await startFakeOllama({ models: INSTALLED, library: LIBRARY });
  const m = blank('nova-ui-gate-ds-');
  const nova = await m.start({ NOVA_OLLAMA_URL: ollama.url, NOVA_HARDWARE_FILE: hardwareFile(m.dir), NOVA_MODELS_WATCH_MS: '200' });
  // A scorecard for the small model, run against today's regression tasks; none for the others.
  // (Written once Nova has made its home: the route reads the cards on every request.)
  const cards = join(m.home, 'workers', 'evals', 'scorecards');
  mkdirSync(cards, { recursive: true });
  writeFileSync(join(cards, evals.cardFile('openai-compatible', 'example-small:3b')), JSON.stringify({
    schema: evals.SCORECARD_SCHEMA,
    target: { provider: 'openai-compatible', model: 'example-small:3b', digest: null, where: 'local' },
    suites: { regression: { fingerprint: evals.REGRESSION_FINGERPRINT, passed: 23, total: 23, pass_rate: 1, ungraded: 0, trials: 1, date: '2026-10-31T09:00:00.000Z', run_id: 'run-1', duration_ms: 1000, nova: { version: '0.1.0', commit: null }, endpoint: null, failed: [] } },
  }));
  try {
    await finishSetup(m);
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/settings#models`);
    await ready(page);
    const section = page.locator('#models');
    await section.locator('.model-role').first().waitFor();

    // Before a switch: the recommended triage model's card (rate and date); the deep model has none,
    // said plainly, and "Use these" stays usable.
    const triage = section.locator('.model-role[data-role="triage-text"]');
    assert.match((await triage.textContent()) ?? '', /23 of 23 regression tasks passed \(100%\), 31 Oct 2026\./);
    const reasoner = section.locator('.model-role[data-role="reasoner"]');
    assert.match((await reasoner.textContent()) ?? '', /No scorecard: Nova hasn’t run its regression tasks against this model\. You can still switch to it/);
    assert.equal(await section.locator('[data-action="models-accept"]').isEnabled(), true);

    // The decision model: two separate switches, off, each with its words; Box is a preview.
    const form = section.locator('form[data-form="decisions"]');
    await form.waitFor();
    assert.equal(await form.locator('input[name="opt_in_screening"]').isChecked(), false);
    assert.equal(await form.locator('input[name="opt_in_box"]').isChecked(), false);
    const words = (await form.textContent()) ?? '';
    assert.match(words, /Screening: let Jev judge outside content in local modes/);
    assert.match(words, /Local-only isn’t strictly local for screening while it is on/);
    assert.match(words, /Box \(preview\)/);
    assert.match(words, /In local-only they never go to a cloud provider/);
    assert.match((await section.textContent()) ?? '', /Jev: Jev isn’t set up/);

    // Turning screening on: the notices come first, and nothing is saved until the person says so.
    await form.locator('input[name="opt_in_screening"]').check();
    await form.locator('button[type="submit"]').click();
    const save = section.locator('[data-action="models-decisions-confirm"]');
    await save.waitFor();
    assert.match((await section.locator('.model-notices').textContent()) ?? '', /While this is on, outside content Nova screens/);
    assert.equal((await m.get('/api/v1/models/decisions')).settings.opt_in.screening, false, 'not saved yet');
    await save.click();
    await page.waitForFunction(() => !document.querySelector('[data-action="models-decisions-confirm"]'));
    const after = await m.get('/api/v1/models/decisions');
    assert.equal(after.settings.opt_in.screening, true);
    assert.equal(after.settings.opt_in.box, false, 'the switches are separate');
    // While it is on, its words stay on the page.
    assert.match((await section.locator('.model-notices').textContent()) ?? '', /Local-only isn’t strictly local for screening while it is on/);
    assert.equal(await section.locator('form[data-form="decisions"] input[name="opt_in_screening"]').isChecked(), true);
    // The first save asked for an OK (409), which the browser logs; nothing else went wrong.
    assert.deepEqual(errors.filter((e) => !/status of 409/.test(e)), []);
  } finally {
    await stop(nova);
    await ollama.close();
    await b.close();
  }
});
