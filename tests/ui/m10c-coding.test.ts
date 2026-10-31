// Coding through chat (M10c), in Chromium against the real server: a coding request made in chat
// links to Tasks; the check step's sheet shows what the agent changed and that running it runs the
// agent's code; the merge sheet shows the reviewed diff, Nova's test result and the live preview link
// before the person can confirm, with Merge disabled until the box is ticked. "Don't merge" leaves the
// branch as it was; a second run, confirmed in the sheet, merges the reviewed commit. Throwaway
// repositories in a temp folder; the agent is Claude Code's stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stop, until } from '../acceptance/support.ts';
import { ROOT, blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';
import { FAKE_CLAUDE, agentScript, git, makeRepos, treeHash } from '../support/coding.ts';

test('M10c: the check and merge sheets show the diff, the tests and the preview before the OK; Don’t merge leaves the branch as it was', { timeout: 300_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-coding-');
  const repos = makeRepos('nova-ui-coding-repos-');
  const nova = await m.start({ NOVA_AGENT_CMD: `node ${join(ROOT, 'scripts/stand-ins/fake-coder-chat.js')}`, NOVA_AGENT_EGRESS: 'none' });
  const shots = shotsDir();
  const api = (p: string) => `/api/v1${p}`;
  const task = (id: string) => m.get(api(`/tasks/${id}`));
  const stepOf = async (run: string, step: string) => {
    const v = await until<any>(() => m.get(api(`/coding/runs/${run}`)), (x) => x.tasks.some((y: { step: string }) => y.step === step), 800);
    const ref = v.tasks.filter((y: { step: string }) => y.step === step).at(-1);
    return until<any>(() => task(ref.id), (x) => ['waiting', 'done', 'failed', 'cancelled'].includes(x.state), 800);
  };
  const request = `In the repository at ${repos.person}, make greet() say “Hello, <name>!” as its test expects. Test with \`node --test\`, preview with \`node server.mjs\`.`;
  try {
    await finishSetup(m);
    await m.send('PUT', api('/profile/privacy/default'), { value: 'cloud-allowed' });
    await m.send('PUT', api('/providers/claude-code/config'), { config: { command: `node ${FAKE_CLAUDE} --script ${agentScript('fix', join(repos.dir, 'scripts'))}` } });
    await m.send('POST', api('/providers/claude-code/enable'), { approved: true });
    const { page, errors } = await device(b, { width: 1280, height: 1000 });

    // The request in chat: the tool step says where to follow it.
    const { body } = await m.send('POST', '/api/sessions', { text: request });
    await until<any>(() => m.get(`/api/sessions/${body.id}`), (x) => x.live === null, 800);
    await page.goto(`${m.base}/c/${body.id}`);
    await ready(page);
    const followed = page.locator('a.record-link', { hasText: 'Follow it in Tasks' });
    await followed.waitFor();
    assert.equal(await followed.getAttribute('href'), '/tasks');
    const before = treeHash(repos.person);
    const base = git(repos.person, 'rev-parse', 'main');
    const run = (await m.get(api('/coding'))).runs[0].id;

    // The check: asked first, with the change and what running it means.
    const check = await stepOf(run, 'check');
    assert.equal(check.state, 'waiting');
    await page.goto(`${m.base}/tasks`);
    await ready(page);
    await page.locator(`[data-action="open-task"][data-task="${check.id}"]`).first().click();
    const ask = page.locator(`.coding-sheet[data-task="${check.id}"]`);
    await ask.waitFor();
    const words = (await ask.textContent()) ?? '';
    assert.match(words, /This runs code the coding agent wrote, as you, with access to your files\./);
    assert.match(words, /Nothing in your repository has changed\./);
    assert.match(words, /app\.mjs · changed · \+1 −1/);
    assert.match(words, /Nova runs node --test and then starts the preview node server\.mjs/);
    await ask.locator('summary', { hasText: 'The whole diff' }).click();
    assert.match((await ask.locator('.coding-diff pre').textContent()) ?? '', /\+export const greet = \(name\) => `Hello, \$\{name\}!`;/);
    if (shots) await shoot(page, join(shots, 'm10c-check.png'));
    await ask.locator('[data-action="approve"]').click();
    await page.locator('.toast', { hasText: 'Approved' }).waitFor();

    // The merge: the reviewed diff, the test result and the preview link, then the confirmation.
    const merge = await stepOf(run, 'merge');
    assert.equal(merge.state, 'waiting');
    assert.equal(merge.approval_tier, 3);
    await page.goto(`${m.base}/tasks`);
    await ready(page);
    await page.locator(`[data-action="open-task"][data-task="${merge.id}"]`).first().click();
    const sheet = page.locator(`.coding-sheet[data-task="${merge.id}"]`);
    await sheet.waitFor();
    const said = (await sheet.textContent()) ?? '';
    assert.match(said, /Merging moves main in .* from [0-9a-f]{7} to [0-9a-f]{7}: exactly this diff\. Nova doesn’t push\./);
    assert.match(said, /Nova ran node --test itself on [0-9a-f]{7}: it passed/);
    assert.ok(await sheet.locator('.coding-diff[open] pre').isVisible(), 'the diff is open in front of the person');
    const link = sheet.locator('.coding-preview a');
    const url = (await m.get(api(`/coding/runs/${run}`))).preview.url;
    assert.equal(await link.getAttribute('href'), url);
    assert.equal(await link.getAttribute('target'), '_blank');
    const merging = sheet.locator('[data-action="approve"]');
    assert.equal(await merging.isDisabled(), true, 'Merge waits for the box');
    await sheet.locator('input[name="confirm"]').check();
    assert.equal(await merging.isDisabled(), false);
    if (shots) await shoot(page, join(shots, 'm10c-merge.png'));
    // The preview link opens the running preview.
    const opened = await page.context().newPage();
    await opened.goto(url);
    assert.equal(await opened.textContent('body'), 'Hello, preview!');
    await opened.close();

    // Don't merge: nothing merged, the branch as it was.
    await sheet.locator('[data-action="decline-merge"]').click();
    await page.locator('.toast', { hasText: 'Not merged' }).waitFor();
    assert.equal((await task(merge.id)).state, 'cancelled');
    assert.equal(git(repos.person, 'rev-parse', 'main'), base);
    assert.equal(treeHash(repos.person), before);

    // A second run, confirmed in the sheet: merged, exactly the reviewed commit.
    await m.send('POST', '/api/sessions', { text: request });
    const run2 = await until<string>(async () => (await m.get(api('/coding'))).runs[0].id, (x) => x !== run, 800);
    const check2 = await stepOf(run2, 'check');
    await m.send('POST', api(`/tasks/${check2.id}/approve`), {});
    const merge2 = await stepOf(run2, 'merge');
    await page.goto(`${m.base}/tasks`);
    await ready(page);
    await page.locator(`[data-action="open-task"][data-task="${merge2.id}"]`).first().click();
    const sheet2 = page.locator(`.coding-sheet[data-task="${merge2.id}"]`);
    await sheet2.waitFor();
    await sheet2.locator('input[name="confirm"]').check();
    await sheet2.locator('[data-action="approve"]').click();
    await page.locator('.toast', { hasText: 'Approved' }).waitFor();
    const merged = await until<any>(() => task(merge2.id), (x) => ['done', 'failed'].includes(x.state), 800);
    assert.equal(merged.state, 'done', merged.reason);
    assert.equal(git(repos.person, 'rev-parse', 'main'), (await m.get(api(`/coding/runs/${run2}`))).head);
    assert.deepEqual(errors, [], 'no errors in the page');
  } finally {
    await b.close();
    await stop(nova);
  }
});
