// Settings › Privacy and permissions › Approvals, wired to #438's routes and drawn to the approved
// compositions (sg-approval-tiers.js, #435). The screen draws whatever GET /api/v1/approvals lists,
// grouped by area: here a stubbed answer with two of Nova's built-ins (one with a stale floor, so the
// server's own refusal can be seen) and two capabilities an extension registered, which appear with
// no change to the UI. Raising saves at once with no confirm; lowering says what changes and
// confirms first, with the passkey on Nova's own screen (against the real server, which checks the
// signature and the floor) and with the box alone on a paired device. A redraw keeps what was picked;
// Settings search finds it; a phone and a Duo's cover lay it out with nothing sideways and 44 px targets.
// Neutral placeholders only. With NOVA_UI_SHOTS set it writes the PR's screenshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page, Request, Route } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shortTargets, shotsDir, until } from './support.ts';
import { searchSettings } from '../../ui/js/settings-ia.js';

type View = Record<string, any>;
const GET = /\/api\/v1\/approvals$/;
const PUT = /\/api\/v1\/approvals\/[^/?]+$/;
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.getElementById('scroller')!.scrollWidth > document.getElementById('scroller')!.clientWidth);
const row = (page: Page, slug: string) => page.locator(`#approvals #appr-${slug}`);

// An extension's capabilities, as the server would list them once it registered them.
const WORDS: Record<number, string> = { 0: 'Silent: does it without telling you', 1: 'Does it and tells you', 2: 'Asks first', 3: 'Confirms every time' };
function extension(id: string, name: string, effect: string, floor: number, def: number, tiers: number[], why: string): View {
  return { id: `example-garden.${id}`, area: 'Example Garden', name, effect, effect_words: effect === 'delete' ? 'it deletes data or credentials, which can’t be brought back' : 'it acts outside or can’t be undone: sending, spending, devices, accounts, running code',
    origin: 'extension:example-garden', default: def, floor, floor_why: why, override: null, effective: def, tiers,
    words: { default: WORDS[def], floor: WORDS[floor], override: null, effective: WORDS[def] } };
}

// GET answered from `stub` (every context blocks the service worker: page.route never sees what a
// worker fetches, so once it took over, a reload would reach the real list); a PUT for a built-in goes to the real server (its answer kept in the
// stub, so a reload shows it), one for the extension is answered here as the server would.
async function stubApprovals(page: Page, stub: { capabilities: View[] }, puts: Request[]) {
  await page.route(GET, (r: Route) => (r.request().method() === 'GET' ? r.fulfill({ json: stub }) : r.continue()));
  await page.route(PUT, async (r: Route) => {
    const req = r.request();
    if (req.method() !== 'PUT') return r.continue();
    puts.push(req);
    const id = decodeURIComponent(new URL(req.url()).pathname.split('/').pop()!);
    const at = stub.capabilities.findIndex((c) => c.id === id);
    if (!id.startsWith('example-garden.')) {
      const res = await r.fetch();
      const json = await res.json();
      if (res.ok() && at >= 0) stub.capabilities[at] = json;
      return r.fulfill({ response: res, json });
    }
    const c = stub.capabilities[at]!;
    const body = req.postDataJSON();
    const effective = Math.max(c.floor, body.tier ?? c.default);
    if (effective < c.effective && body.confirm !== true) return r.fulfill({ status: 400, json: { error: `Lowering “${c.name}” loosens a gate: send confirm: true to do that.` } });
    stub.capabilities[at] = { ...c, override: body.tier, effective, words: { ...c.words, override: body.tier === null ? null : WORDS[body.tier], effective: WORDS[effective] } };
    return r.fulfill({ json: stub.capabilities[at] });
  });
}

test('Settings › Approvals: drawn from GET /approvals, raise free, lower confirms (passkey here, the box on a paired device), server refusals in its words', { timeout: 300_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-approvals-');
  const nova = await m.start();
  const shots = shotsDir();
  try {
    await finishSetup(m);
    const real = (await m.plain('GET', '/api/v1/approvals')).body;
    const builtin = (id: string) => real.capabilities.find((c: View) => c.id === id);
    const check = builtin('coding.check');
    assert.equal(check.effective, 2, 'coding.check starts at Asks first');
    const write = builtin('computer.write');
    assert.equal(write.floor, 1);
    const stub = () => ({ ...real, capabilities: [
      { ...check },
      // A stale floor: the screen offers Just does it; the server refuses it, in its own words.
      { ...write, floor: 0, tiers: [0, 1, 2, 3] },
      extension('water', 'Water the garden on a schedule', 'irreversible', 1, 3, [1, 2, 3], 'tier 0 (silent, without telling you) isn’t offered yet; that is the owner’s to decide'),
      extension('wipe', 'Erase the watering history', 'delete', 3, 3, [3], 'it deletes data or credentials, which can’t be brought back (the vault ruling, decision 2)'),
    ] });

    // ---- Nova's own screen (localhost: the passkey's relying party) --------------------------------
    {
      const base = m.base.replace('//127.0.0.1', '//localhost');
      const { page, errors } = await device(b, { width: 1440, height: 900, serviceWorkers: 'block' });
      const puts: Request[] = [];
      const data = stub();
      await stubApprovals(page, data, puts);
      await page.goto(`${base}/settings#approvals`);
      await ready(page);
      await page.locator('#approvals .appr-cap').nth(3).waitFor();

      // Every capability listed, grouped by area; the extension's with no UI change.
      assert.deepEqual(await page.locator('#approvals .appr-area').allTextContents(), ['Coding', 'Nova’s computer', 'Example Garden']);
      assert.equal(await page.locator('#approvals .appr-cap').count(), 4);
      const water = row(page, 'example-garden-water');
      assert.match((await water.textContent()) ?? '', /Water the garden on a schedule/);
      assert.match((await water.locator('.settings-note').first().textContent()) ?? '', /^Confirms every time · From an extension you added\. You can change this\./);
      assert.deepEqual(await water.locator('input[type="radio"]').evaluateAll((r) => r.map((x) => (x as HTMLInputElement).value)), ['1', '2', '3'], 'only the allowed tiers at or above the floor');
      assert.deepEqual(await water.locator('.choice-name').allTextContents(), ['Does it and tells you', 'Asks first', 'Confirms every time · the default']);
      const wipe = row(page, 'example-garden-wipe');
      assert.equal(await wipe.getAttribute('data-adjustable'), 'no');
      assert.equal(await wipe.locator('input, button').count(), 0, 'a fixed one has no control');
      assert.match((await wipe.textContent()) ?? '', /Confirms every time · From an extension you added\. Fixed: it deletes data or credentials, which can’t be brought back \(the vault ruling, decision 2\)\./);
      // Always shown, with no switch: the outside-content guard and Nova never presses pay.
      const always = page.locator('#approvals .appr-always');
      assert.match((await always.textContent()) ?? '', /Nova never presses pay/);
      assert.match((await always.textContent()) ?? '', /After Nova has read outside content/);
      assert.equal(await always.locator('input, button, [role="switch"]').count(), 0);
      // The conversation's switches stay where they are, linked as "Steps in a conversation".
      assert.equal(await page.locator('#approvals a', { hasText: 'Steps in a conversation' }).getAttribute('href'), '/settings#perms');
      assert.equal(await page.locator('.settings-pane[data-cat="privacy"] #perms').count(), 1);
      assert.deepEqual(await shortTargets(page, '#approvals a, #approvals button, #approvals input', { visible: true, label: true }), [], '44 px targets');
      if (shots) await shoot(page, join(shots, 'desktop-1440x900-approvals.png'));

      // Raising is free: saved at once, with no confirm.
      const checkRow = row(page, 'coding-check');
      await checkRow.locator('input[value="3"]').check();
      await checkRow.locator('.appr-said', { hasText: 'Saved: Confirms every time.' }).waitFor();
      assert.equal(puts.length, 1);
      assert.deepEqual(puts[0]!.postDataJSON(), { tier: 3 }, 'raising sends no confirm');
      assert.equal((await m.plain('GET', '/api/v1/approvals')).body.capabilities.find((c: View) => c.id === 'coding.check').override, 3);

      // Lowering on Nova's own screen: the consequence, then the box and the passkey.
      await checkRow.locator('input[value="1"]').check();
      const lower = checkRow.locator('form.appr-confirm');
      await lower.waitFor();
      assert.equal(puts.length, 1, 'nothing is sent before the confirmation');
      assert.match((await lower.textContent()) ?? '', /It goes from Confirms every time to Does it and tells you\./);
      assert.match((await lower.textContent()) ?? '', /On Nova’s own screen, every confirmation like this one takes your passkey/);
      await lower.locator('.passkey-line[data-passkey-state="ready"]').waitFor();
      const go = lower.locator('[data-action="passkey-confirm"]');
      assert.equal(await go.isDisabled(), true, 'locked until the box is ticked');
      await lower.locator('input[name="confirm"]').check();
      assert.equal(await go.isDisabled(), false);
      if (shots) await shoot(page, join(shots, 'desktop-1440x900-approvals-lower-passkey.png'));
      // The passkey step waits for the person; Stop waiting approves nothing, in the step's own words.
      await page.evaluate(() => { (window as unknown as { __novaPasskey: object }).__novaPasskey = { mode: 'hang' }; });
      await go.click();
      await lower.locator('.passkey-line[data-passkey-state="waiting"]').waitFor();
      await lower.locator('[data-action="passkey-stop"]').click();
      await checkRow.locator('.appr-said[role="alert"]', { hasText: 'No passkey was used, so nothing was approved.' }).waitFor();
      assert.equal(await checkRow.locator('input[value="1"]').isChecked(), true, 'the choice is kept');
      assert.equal(puts.length, 1, 'nothing was sent');
      // Then confirmed: the server checks the signature, and the tier is lowered.
      await page.evaluate(() => { (window as unknown as { __novaPasskey: object }).__novaPasskey = {}; });
      await lower.locator('[data-action="passkey-confirm"]').click();
      await checkRow.locator('.appr-said', { hasText: 'Saved: Does it and tells you.' }).waitFor();
      const sent = puts[1]!.postDataJSON();
      assert.equal(sent.tier, 1);
      assert.equal(sent.confirm, true);
      assert.ok(sent.passkey_approval?.signature, 'the passkey’s approval went with it');
      assert.equal((await m.plain('GET', '/api/v1/approvals')).body.capabilities.find((c: View) => c.id === 'coding.check').override, 1);
      assert.equal(await checkRow.locator('form.appr-confirm').count(), 0);

      // A refusal below the floor: the server's own words, and the choice stays chosen. A redraw
      // underneath (a change made elsewhere) keeps the pick and the ticked box (keepEdits).
      const writeRow = row(page, 'computer-write');
      await writeRow.locator('input[value="0"]').check();
      const lowerWrite = writeRow.locator('form.appr-confirm');
      await lowerWrite.locator('input[name="confirm"]').check();
      await page.evaluate(() => { document.getElementById('approvals')!.dataset.before = 'yes'; });
      const reloaded = page.waitForResponse((r) => GET.test(new URL(r.url()).pathname) && r.request().method() === 'GET');
      assert.equal((await m.send('PUT', '/api/v1/approvals/infra.apply', { tier: 3 })).status, 200);
      await reloaded;
      await until(page, () => !document.getElementById('approvals')?.dataset.before);
      assert.equal(await writeRow.locator('input[value="0"]').isChecked(), true, 'the pick survives the redraw');
      assert.equal(await lowerWrite.locator('input[name="confirm"]').isChecked(), true, 'and the ticked box');
      await lowerWrite.locator('[data-action="passkey-confirm"]').click();
      const refusal = writeRow.locator('.appr-said[role="alert"]');
      await refusal.waitFor();
      assert.match((await refusal.textContent()) ?? '', /can’t go below tier 1 \(does it and tells you\): tier 0 \(silent, without telling you\) isn’t offered yet; that is the owner’s to decide\./);
      assert.equal(await writeRow.locator('input[value="0"]').isChecked(), true, 'what was chosen stays chosen');
      assert.equal((await m.plain('GET', '/api/v1/approvals')).body.capabilities.find((c: View) => c.id === 'computer.write').override, null, 'nothing changed');
      if (shots) await shoot(page, join(shots, 'desktop-1440x900-approvals-refused.png'));
      await writeRow.locator('[data-action="appr-cancel"]').click();
      await until(page, () => (document.querySelector('#appr-computer-write input[value="1"]') as HTMLInputElement | null)?.checked === true);

      // Settings search finds it by the words people use.
      for (const q of ['approvals', 'ask first', 'tier', 'asks first', 'confirm every time']) assert.equal(searchSettings(q)[0]?.target, 'approvals', q);
      await page.fill('#settings-search', 'ask first');
      await page.waitForSelector('#approvals[data-match]');
      await page.press('#settings-search', 'Enter');
      await page.waitForFunction(() => document.getElementById('approvals')?.contains(document.activeElement));
      assert.deepEqual(errors.filter((e) => !/status of 4\d\d/.test(e)), [], 'no errors in the page');
      await page.context().close();
    }

    // ---- a paired phone or browser: the box alone, no passkey ---------------------------------------
    {
      const { ctx, page, errors } = await device(b, { width: 1280, height: 900, serviceWorkers: 'block' });
      await ctx.addInitScript(() => { try { localStorage.setItem('nova.session', new Date(Date.now() + 10 * 3600_000).toISOString()); } catch { /* storage off */ } });
      // The hub refuses the passkey routes to a paired device (passkey.js approvalFor: null there).
      await page.route(/\/api\/v1\/security\/passkeys$/, (r) => r.fulfill({ status: 403, json: { error: 'Passkeys are Nova’s own screen’s.' } }));
      const puts: Request[] = [];
      await stubApprovals(page, stub(), puts);
      await page.goto(`${m.base}/settings#approvals`);
      await ready(page);
      const water = row(page, 'example-garden-water');
      await water.waitFor();
      await water.locator('input[value="2"]').check();
      const lower = water.locator('form.appr-confirm');
      await lower.waitFor();
      assert.equal(await lower.locator('.passkey-line').count(), 0, 'no passkey on a paired device');
      assert.match((await lower.textContent()) ?? '', /On a paired phone or browser, the box alone confirms it/);
      const go = lower.locator('[data-action="appr-confirm"]');
      assert.equal(await go.isDisabled(), true);
      await lower.locator('input[name="confirm"]').check();
      if (shots) await shoot(page, join(shots, 'desktop-1280x900-approvals-lower-paired.png'));
      await go.click();
      await water.locator('.appr-said', { hasText: 'Saved: Asks first.' }).waitFor();
      assert.deepEqual(puts[0]!.postDataJSON(), { tier: 2, confirm: true }, 'the confirm alone, no passkey approval');
      // Back to default: raising again, so no confirm; it sends tier null.
      await water.locator('[data-action="appr-default"]').click();
      await water.locator('.appr-said', { hasText: 'Saved: Confirms every time.' }).waitFor();
      assert.deepEqual(puts[1]!.postDataJSON(), { tier: null });
      assert.deepEqual(errors.filter((e) => !/status of 4\d\d/.test(e)), [], 'no errors in the page');
      await ctx.close();
    }

    // ---- a phone and a Duo's cover --------------------------------------------------------------
    for (const [name, vp, scheme] of [['phone-390x844', { width: 390, height: 844 }, 'dark'], ['duo-cover-380x900', { width: 380, height: 900 }, 'light']] as const) {
      const { ctx, page, errors } = await device(b, { ...vp, scheme, touch: true, serviceWorkers: 'block' });
      await stubApprovals(page, stub(), []);
      await page.goto(`${m.base.replace('//127.0.0.1', '//localhost')}/settings#approvals`);
      await ready(page);
      await page.locator('#approvals .appr-cap').nth(3).waitFor();
      await page.locator('.settings-side').waitFor({ state: 'hidden' });
      // Settings has finished loading (the conversation's switches come last, in the same part).
      await page.locator('.settings-pane[data-cat="privacy"] #perms').waitFor();
      await page.evaluate(() => document.getElementById('approvals')?.scrollIntoView());
      assert.equal(await sideways(page), false, `${name}: nothing sideways`);
      assert.deepEqual(await shortTargets(page, '#approvals a, #approvals button, #approvals input', { visible: true, label: true }), [], `${name}: 44 px targets`);
      if (shots) await shoot(page, join(shots, `${name}-approvals-${scheme}.png`));
      const water = row(page, 'example-garden-water');
      await water.locator('input[value="1"]').check();
      await water.locator('form.appr-confirm').waitFor();
      await page.evaluate(() => document.querySelector('#appr-example-garden-water form.appr-confirm')?.scrollIntoView({ block: 'center' }));
      assert.equal(await sideways(page), false, `${name}: the confirmation fits`);
      assert.deepEqual(await shortTargets(page, '#approvals a, #approvals button, #approvals input', { visible: true, label: true }), [], `${name}: 44 px targets in the confirmation`);
      if (shots) await shoot(page, join(shots, `${name}-approvals-lower-${scheme}.png`));
      assert.deepEqual(errors, [], `${name}: no errors`);
      await ctx.close();
    }
  } finally {
    await stop(nova);
    await b.close();
  }
});
