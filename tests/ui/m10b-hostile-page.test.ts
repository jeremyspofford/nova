// Review of PR #238, 6: hostile pages, in Chromium, against loopback stand-ins.
//  - Instructions hidden where a reader doesn't look (an accessible name, alt and title text, hidden
//    and off-screen elements, CSS-generated content, noscript) and text that changes after it was
//    read never reach the co-pilot unscreened: every prompt is checked.
//  - Forget clears a site's cookies, local storage and IndexedDB from Nova's profile.
//  - Downloads and the File System Access API write nothing.
//  - Stop closes the browser, and nothing lands at the site afterwards.
//  - file:, chrome: and devtools: are refused, in a plan and from a page.
// Runs where Chromium can start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canBrowse, filesHolding, sleep, startNova, startShop, until } from './m10b-support.ts';

const ORDINARY = { element_matches_intent: 0.9, page_changed_as_expected: 0.9, obstacle: 0.05, dark_pattern: 0.05, total_matches: 0.9, dialog_injection: 0.05 };
const BAD = /ignore all previous instructions|send the saved password|\/steal/i;

test('review 6: hidden and changing text never reaches the co-pilot unscreened', { timeout: 180_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const copilot: string[] = [];
  const screened: string[] = [];
  const reply = (body: any) => {
    const q = body?.format?.properties?.answers?.properties ?? {};
    const text = (body?.messages ?? []).map((m: { content: string }) => m.content).join('\n');
    if ('dialog_injection' in q) { copilot.push(text); return JSON.stringify({ answers: ORDINARY, confidence: 0.9, why: 'stand-in' }); }
    if ('direct_instruction' in q) { screened.push(text); const p = BAD.test(text) ? 0.96 : 0.03; return JSON.stringify({ answers: { direct_instruction: p, hidden_instruction: p, exfiltration: p, impersonation: 0.03, unrequested_action: p }, confidence: 0.9, why: 'stand-in' }); }
    return 'Facts: a page of offers.';
  };
  const shop = await startShop();
  const n = await startNova('nova-m10b-hidden-', { model: reply });
  try {
    const { id } = await n.task({
      allowed_hosts: [shop.host],
      steps: [{ do: 'navigate', url: `${shop.url}/inject-attrs` }, { do: 'click', selector: '#go' }, { do: 'wait', selector: '#flip[data-clicked]' }, { do: 'click', selector: '#go' }, { do: 'read', selector: 'h1' }],
      verify: { url: `${shop.url}/inject-attrs`, expect: ['Offers'] },
    }, 'Look at the offers');
    const done = await n.done(id!);
    assert.equal(done.state, 'done', `${done.reason}`);
    assert.ok(copilot.length >= 4, `the co-pilot was asked (${copilot.length})`);
    for (const p of copilot) assert.ok(!BAD.test(p), `a co-pilot prompt held unscreened text:\n${p.slice(0, 800)}`);
    assert.ok(screened.some((s) => BAD.test(s)), 'the screen saw it (that is its job), the co-pilot didn’t');
    assert.equal(shop.hits('/steal').length, 0);
  } finally {
    await n.close();
    await shop.close();
  }
});

test('review 6: Forget clears a site’s cookies, local storage and IndexedDB from Nova’s profile', { timeout: 180_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const n = await startNova('nova-m10b-forget-');
  try {
    const { m, api } = n;
    const look = async (write: boolean) => {
      const { id } = await n.task({ allowed_hosts: [shop.host], steps: [{ do: 'navigate', url: `${shop.url}/storage${write ? '?write=1' : ''}` }, { do: 'wait', selector: '#found[data-done]' }, { do: 'read', selector: '#found' }], verify: { expect: ['Storage'] } }, 'Look at the storage');
      const done = await n.done(id!);
      assert.equal(done.state, 'done', `${done.reason}`);
      const reads = JSON.parse((await import('node:fs')).readFileSync(`${m.home}/workers/browser/${id}/reads.json`, 'utf8'));
      return reads[0].text as string;
    };
    assert.equal(await look(true), 'cookie=yes local=yes idb=yes');
    assert.equal(await look(false), 'cookie=yes local=yes idb=yes', 'kept in Nova’s profile between tasks');
    const f = await m.send('POST', api(`/browser/sites/${shop.host}/forget`), { confirm: true });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(await look(false), 'cookie=no local=no idb=no', 'all three gone');
  } finally {
    await n.close();
    await shop.close();
  }
});

test('review 6: downloads and the File System Access API write nothing', { timeout: 120_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const n = await startNova('nova-m10b-download-');
  try {
    const { id } = await n.task({
      allowed_hosts: [shop.host],
      steps: [{ do: 'navigate', url: `${shop.url}/download` }, { do: 'click', selector: '#file' }, { do: 'navigate', url: `${shop.url}/download` }, { do: 'click', selector: '#save' }, { do: 'wait', selector: '#status[data-done]' }, { do: 'read', selector: '#status' }],
      verify: { url: `${shop.url}/download`, expect: ['Download'] },
    }, 'Get the file');
    const done = await n.done(id!);
    assert.equal(done.state, 'done', `${done.reason}`);
    await sleep(500);
    assert.deepEqual(filesHolding(n.m.dir, ['EXAMPLE-FILE-DOWNLOAD-CONTENT', 'EXAMPLE-BLOB-DOWNLOAD-CONTENT', 'EXAMPLE-FSA-CONTENT']), [], 'nothing written anywhere in the machine’s folder');
    const reads = JSON.parse((await import('node:fs')).readFileSync(`${n.m.home}/workers/browser/${id}/reads.json`, 'utf8'));
    assert.match(reads[0].text, /^refused/, 'the save was refused');
  } finally {
    await n.close();
    await shop.close();
  }
});

test('review 6: Stop closes the browser and nothing lands at the site afterwards', { timeout: 120_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const n = await startNova('nova-m10b-stop-');
  try {
    const { m, api } = n;
    const { id } = await n.task({ allowed_hosts: [shop.host], steps: [{ do: 'navigate', url: `${shop.url}/chatty` }, { do: 'wait', selector: '#never', timeout_ms: 60_000 }], verify: { expect: ['Chatty'] } }, 'Watch a chatty page');
    await until(() => m.get(api(`/browser/tasks/${id}`)), (v) => v.step?.n === 2);
    await until(async () => shop.hits('/tick').length, (k) => k >= 5, 10_000);
    assert.equal((await m.send('POST', api(`/browser/tasks/${id}/stop`))).status, 200);
    const stopped = Date.now();
    await until(() => m.get(api(`/browser/tasks/${id}`)), (v) => v.live === false, 10_000);
    await sleep(1500);
    const late = shop.log.filter((l: { path: string; at: string }) => (l.path === '/tick' || l.path === '/tock') && Date.parse(l.at) > stopped + 250);
    assert.deepEqual(late, [], 'nothing landed after the stop');
    assert.equal((await n.done(id!, 10_000)).state, 'cancelled');
  } finally {
    await n.close();
    await shop.close();
  }
});

test('review 6: file:, chrome: and devtools: are refused, in a plan and from a page', { timeout: 120_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const n = await startNova('nova-m10b-schemes-');
  try {
    const { m, api } = n;
    for (const url of ['file:///etc/hostname', 'chrome://settings', 'devtools://devtools/bundled/inspector.html', 'view-source:http://' + shop.host + '/']) {
      const r = await m.send('POST', api('/tasks'), { title: 'Open', owner: 'browser', goal: 'x', evidence_required: [{ kind: 'screenshot' }], inputs: { allowed_hosts: [shop.host], steps: [{ do: 'navigate', url }] } });
      assert.equal(r.status, 400, `${url}: ${JSON.stringify(r.body)}`);
    }
    const { id } = await n.task({ allowed_hosts: [shop.host], steps: [{ do: 'navigate', url: `${shop.url}/schemes` }, { do: 'wait', selector: '#later' }, { do: 'read', selector: 'main' }], verify: { expect: ['Schemes'] } }, 'Open a page that reaches for the browser’s own pages');
    const done = await n.done(id!);
    assert.equal(done.state, 'done', `${done.reason}`);
    const steps = JSON.parse((await import('node:fs')).readFileSync(`${m.home}/workers/browser/${id}/steps.json`, 'utf8')) as { url?: string }[];
    assert.ok(steps.every((s) => !s.url || /^http:\/\/127\.0\.0\.1:\d+\//.test(s.url)), JSON.stringify(steps.map((s) => s.url)));
  } finally {
    await n.close();
    await shop.close();
  }
});
