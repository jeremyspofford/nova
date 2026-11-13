// Health › the Claude seat's problem (design amendment 2026-11-12; src/core/claude-seat.ts). An
// expired sign-in is one named problem with one action, Sign in again, and no "Mark as dealt with"
// (only Nova's own check call closes it). Sign in again opens a sheet with Claude's sign-in page as
// a link for any device and a field for the code; the code goes to Nova and the sheet waits for
// Nova's check, not the login's word. The real server underneath; the problem, its playbook and the
// sign-in's answers are fixtures, so no `claude` runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready } from './support.ts';
import { PLAYBOOKS } from '../../src/core/resilience/playbooks.ts';

const PROBLEM_ID = 9101;
const problem = {
  id: PROBLEM_ID, at: '2026-11-12T09:00:00.000Z', source: 'seat', stops: 1, resolved_at: null, task_id: null,
  message: 'My Claude sign-in expired, so I can’t answer anything until you sign in again.',
  detail: 'Failed to authenticate: OAuth session expired and could not be refreshed',
};
const playbook = { ...PLAYBOOKS['seat-sign-in'], subject: 'claude-cli', repairs: [], check: 'Nova’s own check call to Claude succeeds after you sign in' };
const URL_SHOWN = 'https://claude.example/cai/oauth/authorize?code=true&state=fixture';

test('Health: the expired Claude sign-in is one stop problem with Sign in again; the sheet takes the code and waits for Nova’s check', { timeout: 300_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-seat-sign-in-');
  const nova = await m.start();
  try {
    await finishSetup(m);
    const d = await device(b, { width: 1280, height: 820, serviceWorkers: 'block' });
    await d.ctx.route('**/api/v1/problems*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([problem]) }));
    await d.ctx.route('**/api/v1/resilience', async (r) => {
      const response = await r.fetch();
      const body = await response.json();
      await r.fulfill({ response, body: JSON.stringify({ ...body, playbooks: { [PROBLEM_ID]: playbook } }) });
    });
    let polls = 0;
    const codes: unknown[] = [];
    await d.ctx.route('**/api/v1/seats/claude-cli/sign-in', (r) => r.request().method() === 'POST'
      ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'waiting', said: 'Open the sign-in page on any device, approve, then paste the code it shows here.', url: URL_SHOWN }) })
      : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(++polls < 2 ? { state: 'checking', said: 'Signed in. Nova is checking that Claude answers…' } : { state: 'done', said: 'Signed in, and Claude answered Nova’s check call.' }) }));
    await d.ctx.route('**/api/v1/seats/claude-cli/sign-in/code', (r) => { codes.push(r.request().postDataJSON()); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'checking', said: 'Checking the code…' }) }); });

    await d.page.goto(`${m.base}/health`);
    await ready(d.page);
    const row = d.page.locator(`#pr-${PROBLEM_ID}`);
    await row.waitFor();
    const text = await row.innerText();
    assert.match(text, /My Claude sign-in expired/);
    assert.match(text, /Failed/, 'stop-class: marked Failed (red)');
    assert.match(text, /last one in the wrong place/, 'it says this is one more sign-in, in Nova’s own folder');
    assert.equal(await row.getByRole('button', { name: 'Sign in again' }).count(), 1);
    assert.equal(await row.getByRole('button', { name: 'Mark as dealt with' }).count(), 0, 'only Nova’s check closes it');

    await row.getByRole('button', { name: 'Sign in again' }).click();
    const sheet = d.page.locator('#sheet [data-seat-sign-in]');
    await sheet.waitFor();
    const link = sheet.getByRole('link', { name: 'Open Claude’s sign-in page' });
    assert.equal(await link.getAttribute('href'), URL_SHOWN);
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.match((await link.getAttribute('rel')) ?? '', /noopener/);
    await sheet.getByLabel('The code from the sign-in page').fill('GOODCODE#fixture');
    await sheet.getByRole('button', { name: 'Finish signing in' }).click();
    await d.page.locator('#sheet [data-seat-sign-in][data-state="done"]').waitFor({ timeout: 15_000 });
    assert.deepEqual(codes, [{ code: 'GOODCODE#fixture' }]);
    assert.match(await d.page.locator('#sheet [data-seat-sign-in]').innerText(), /Claude answered Nova’s check call/);
    assert.deepEqual(d.errors, []);
    await d.ctx.close();
  } finally {
    await b.close();
    await stop(nova);
  }
});
