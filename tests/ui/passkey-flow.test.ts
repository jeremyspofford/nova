// Insertion #3 T2, part 2, in Chromium against the real server: tier 3 on Nova's own screen is
// approved with a passkey. With none yet, nothing tier-3 runs and the sheet says so. Settings ›
// Security adds them (the first on trust, the second approved by the first; setup is complete with
// two), and Health warns while there is only one. The sheet's step: waiting hides "Cancel the task",
// "Stop waiting" approves nothing, a passkey signed for another request is refused by the server,
// and the real one approves the task. The test authenticator is support.ts's: Playwright's WebKit
// has no virtual authenticator, so a software one stands in for the platform's in both engines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stop, until } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

test('T2: tier 3 on Nova’s own screen waits for a passkey; Security adds two; the sheet’s step approves exactly its request', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-passkey-');
  const nova = await m.start();
  const shots = shotsDir();
  try {
    await finishSetup(m, { passkeys: false });
    // A passkey works on a name, never an address: Nova's own screen is opened at localhost.
    const base = m.base.replace('//127.0.0.1', '//localhost');
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    const created = (await m.send('POST', '/api/v1/tasks', {
      title: 'Save the vault notes', owner: 'workspace', goal: 'The notes are saved.', approval_tier: 3,
      evidence_required: [{ kind: 'read_back', target: 'workspace:notes/vault.md' }], inputs: { action: 'write', path: 'notes/vault.md', content: '- one\n' },
    })).body;
    const task = await until<any>(() => m.get(`/api/v1/tasks/${created.id}`), (x) => x.state === 'waiting');
    assert.equal(task.approval_tier, 3);
    const sheet = page.locator(`#sheet .approval-sheet[data-task="${created.id}"]`);
    const openSheet = async () => {
      await page.goto(`${base}/tasks`);
      await ready(page);
      await page.locator(`[data-action="open-task"][data-task="${created.id}"]`).first().click();
      await sheet.waitFor();
      await sheet.locator('input[name="confirm"]').check();
    };
    const line = sheet.locator('.passkey-line');

    // No passkey yet: nothing tier-3 runs, and the sheet says where to add one.
    await openSheet();
    await sheet.locator('[data-action="approve"]').click();
    await sheet.locator('.passkey-line[data-passkey-state="no-passkey"]').waitFor();
    assert.equal(await sheet.locator('[data-passkey-add]').getAttribute('href'), '/settings#security');
    if (shots) await shoot(page, join(shots, 'passkey-no-passkey.png'));
    assert.equal((await m.get(`/api/v1/tasks/${created.id}`)).state, 'waiting', 'not approved');

    // Settings › Security: the first on trust, then a second; Health warns in between.
    await page.goto(`${base}/settings#security`);
    await ready(page);
    const setup = page.locator('#security .passkey-setup');
    await setup.waitFor();
    assert.equal(await setup.getAttribute('data-passkey-count'), '0');
    await setup.locator('[data-action="passkey-setup"]').click();
    await page.locator('#security .passkey-setup[data-passkey-count="1"] [data-passkey-setup-state="added"]').waitFor();
    assert.match((await page.locator('#security').textContent()) ?? '', /Now add a second one: setup is complete with two\./);
    assert.match((await page.locator('#security').textContent()) ?? '', /the first, taken on trust/);
    const health = (await m.get('/api/v1/health')).checks.passkeys;
    assert.equal(health.count, 1);
    assert.match(health.detail, /1 passkey, added \d{4}-\d{2}-\d{2} on trust\. Add a second/);
    await page.goto(`${base}/health`);
    await ready(page);
    await page.locator('.settings-row', { hasText: 'Passkeys' }).locator('.pill.is-warn').waitFor();
    await page.goto(`${base}/settings#security`);
    await ready(page);
    await page.locator('#security [data-action="passkey-setup"]').click();
    await page.locator('#security .passkey-setup[data-passkey-count="2"] [data-passkey-setup-state="added"]').waitFor();
    assert.match((await page.locator('#security').textContent()) ?? '', /Setup is complete: 2 passkeys\./);
    if (shots) await shoot(page, join(shots, 'passkey-security-complete.png'));
    assert.equal((await m.get('/api/v1/health')).checks.passkeys.complete, true);

    // A passkey signed for another request is refused by the server, whatever the page sends.
    const other = await page.evaluate(async (id) => {
      (window as unknown as { __novaPasskey: object }).__novaPasskey = {};
      // The page's own modules, as the app loads them (strings, so the type checker leaves them be).
      const [pk, core] = ['/js/passkey.js', '/js/core.js'];
      const { approvalFor } = await import(pk);
      const { api } = await import(core);
      const a = await approvalFor(api, 'POST', `/tasks/${id}/approve`, { confirm: true });
      const res = await fetch(`/api/v1/tasks/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify({ confirm: true, note: 'not what was signed', passkey_approval: a }) });
      return { status: res.status, error: (await res.json()).error };
    }, created.id);
    assert.equal(other.status, 403);
    assert.match(other.error, /That passkey didn’t confirm this request \(made for another action\), so nothing was approved\./);
    assert.equal((await m.get(`/api/v1/tasks/${created.id}`)).state, 'waiting');

    // The step: waiting hides "Cancel the task"; "Stop waiting" approves nothing.
    await openSheet();
    await page.evaluate(() => { (window as unknown as { __novaPasskey: object }).__novaPasskey = { mode: 'hang' }; });
    await sheet.locator('[data-action="approve"]').click();
    await sheet.locator('.passkey-line[data-passkey-state="waiting"]').waitFor();
    assert.equal(await sheet.locator('[data-action="cancel-task"]').isVisible(), false, 'Cancel the task is hidden while waiting');
    assert.equal(await sheet.locator('[data-action="close-sheet"]', { hasText: 'Not now' }).isVisible(), true, 'Not now stays');
    if (shots) await shoot(page, join(shots, 'passkey-waiting.png'));
    await sheet.locator('[data-action="passkey-stop"]').click();
    await sheet.locator('.passkey-line[data-passkey-state="cancelled"]').waitFor();
    assert.equal(await sheet.locator('[data-action="cancel-task"]').isVisible(), true, 'Cancel the task is back once the wait ends');
    assert.equal((await m.get(`/api/v1/tasks/${created.id}`)).state, 'waiting', 'stopping approved nothing');

    // The real thing: confirmed with the passkey, the task goes ahead.
    await page.evaluate(() => { (window as unknown as { __novaPasskey: object }).__novaPasskey = {}; });
    await sheet.locator('[data-action="approve"]').click();
    const done = await until<any>(() => m.get(`/api/v1/tasks/${created.id}`), (x) => x.state === 'done');
    assert.equal(done.state, 'done');
    assert.deepEqual(errors.filter((e) => !/403|Forbidden/.test(e)), []);
  } finally {
    await b.close();
    await stop(nova);
  }
});
