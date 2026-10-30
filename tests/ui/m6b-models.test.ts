// Settings › Models (M6b) in a real browser, against the real server and the stand-in Ollama, on
// a fixed hub-class hardware reading: the device map, the recommendation with its reasons (one
// standout: "Use these"), transcription said plainly to have no runtime, roles assigned, a
// download asked for, OK'd (then the OK is the standout), its progress and the digest Nova read,
// and the disk budget refusing a download that wouldn't fit. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stop } from '../acceptance/support.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { INSTALLED, LIBRARY, hardwareFile } from '../support/models.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

test('M6b: Settings › Models — device map, recommendation, roles, a download with progress and digest, the disk budget', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const ollama = await startFakeOllama({ models: INSTALLED, library: LIBRARY, pullDelayMs: 120 });
  const m = blank('nova-ui-m6b-');
  const nova = await m.start({ NOVA_OLLAMA_URL: ollama.url, NOVA_HARDWARE_FILE: hardwareFile(m.dir), NOVA_MODELS_WATCH_MS: '200' });
  const m3 = shotsDir();
  const shots = m3 ? join(dirname(m3), 'm6') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    await finishSetup(m);
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/settings#models`);
    await ready(page);
    const section = page.locator('#models');
    const top = () => section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await section.locator('.model-device').first().waitFor();
    const text = async () => (await section.textContent()) ?? '';

    // The device map: real hardware words, what it can hold, the runtime.
    const hub = section.locator('.model-device').first();
    assert.match((await hub.textContent()) ?? '', /Example GPU 24GB \(24 GB\) · 32 GB memory · 20 threads · 400 GB free disk/);
    assert.match((await hub.textContent()) ?? '', /Runs models up to about 21 GB/);
    assert.match((await hub.textContent()) ?? '', /Ollama 0\.0\.0-stand-in · 5 models/);
    // One recommendation per role, with why and the trade-off; transcription says it has no runtime.
    const reasoner = section.locator('.model-role[data-role="reasoner"]');
    assert.match((await reasoner.textContent()) ?? '', /Nova recommends example-deep:32b: example-deep:32b \(32\.8B parameters, 19 GB\) is the deepest model that fits Example GPU 24GB with 24 GB\./);
    assert.match((await section.locator('.model-role[data-role="transcriber"]').textContent()) ?? '', /There is no transcription runtime on your devices .* so transcription stays off\. Nothing is sent elsewhere to transcribe instead\./);
    assert.equal(await section.locator('.btn.primary').count(), 1, 'one standout');
    assert.equal(await section.locator('.btn.primary').textContent(), 'Use these');
    assert.equal(await section.locator('details.model-more').getAttribute('open'), null, 'the installed list is one layer down');
    if (shots) { await top(); await shoot(page, join(shots, 'models-recommended.png')); }

    await section.locator('[data-action="models-accept"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#models .model-role .pill.is-on').length === 3);
    assert.equal(await section.locator('.btn.primary').count(), 0, 'nothing left to recommend: no standout');
    assert.match((await reasoner.textContent()) ?? '', /example-deep:32b on .*\./);
    assert.match(await text(), /No cloud model is set, so everything runs on your devices/);

    // A download: asked for, then it waits for the OK, which is the view's standout.
    await section.locator('details.model-more summary').click();
    await section.locator('form[data-form="pull"] input[name="model"]').fill('example-new:7b');
    await section.locator('form[data-form="pull"] button[type="submit"]').click();
    const ask = section.locator('[data-action="models-approve"]');
    await ask.waitFor();
    assert.equal(await section.locator('.btn.primary').count(), 1);
    assert.match((await section.locator('.model-download').first().textContent()) ?? '', /Ollama downloads it from its library on the internet; nothing of yours is sent/);
    await ask.click();
    await section.locator('progress.model-progress').waitFor();
    await page.waitForFunction(() => { const p = document.querySelector('#models progress.model-progress') as HTMLProgressElement | null; return !!p && p.value > 0 && p.value < p.max; });
    if (shots) await shoot(page, join(shots, 'models-downloading.png'));
    await page.waitForFunction(() => /Digest sha256:[0-9a-f]{12}…, read by Nova from Ollama itself/.test(document.querySelector('#models')?.textContent ?? ''), null, { timeout: 30_000 });
    assert.match((await section.locator('.model-download').first().textContent()) ?? '', /Verified/);
    assert.ok(ollama.installed().includes('example-new:7b'));

    // The disk budget: a download that won't fit is refused at once, in words.
    await section.locator('form[data-form="disk"] input[name="gb"]').fill('1');
    await section.locator('form[data-form="disk"] button[type="submit"]').click();
    await page.waitForFunction(() => /of a 1 GB budget/.test(document.querySelector('#models')?.textContent ?? ''));
    if (!(await section.locator('details.model-more').getAttribute('open'))) await section.locator('details.model-more summary').click();
    await section.locator('form[data-form="pull"] input[name="model"]').fill('nomic-embed-text');
    await section.locator('form[data-form="pull"] button[type="submit"]').click();
    await page.waitForFunction(() => /Refused: nomic-embed-text takes about \d+ MB/.test(document.body.textContent ?? ''));

    // The cloud budget saves; no cloud model is set, so it stays all local.
    await section.locator('form[data-form="budget"] input[name="per_period_usd"]').fill('5');
    await section.locator('form[data-form="budget"] button[type="submit"]').click();
    await page.waitForFunction(() => (document.querySelector('#models form[data-form="budget"] input[name="per_period_usd"]') as HTMLInputElement | null)?.value === '5');
    if (shots) { await top(); await shoot(page, join(shots, 'models-assigned.png')); }
    // The refused download answered 409, which the browser logs; nothing else went wrong.
    assert.deepEqual(errors.filter((e) => !/status of 409/.test(e)), []);
    assert.equal(errors.length, 1);
  } finally {
    await stop(nova);
    await ollama.close();
    await b.close();
  }
});
