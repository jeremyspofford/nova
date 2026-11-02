// Guard probes use synthetic documents only. They are not Home-start coverage paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registeredViewRoots } from '../support/navigation-registry.js';
import { browser } from './support.ts';
import { activeViewReady, trackDocument, assertRetainedDocument, documentRequests } from './navigation-support.ts';

async function fixture() {
  const b = await browser();
  assert.notEqual(typeof b, 'string', 'Guard controls require a real browser');
  if (typeof b === 'string') throw new Error(b);
  const page = await b.newPage();
  await page.route('http://navigation-guard.test/**', route => {
    const module = new URL(route.request().url()).pathname === '/js/surfaces.js';
    return route.fulfill({ contentType: module ? 'application/javascript' : 'text/html', body: module ? 'export const store = { loaded: true, health: {} };' : '<!doctype html><html data-ready><body data-view="topology"><main id="main"><div id="scroller"><section id="home" hidden><h2>Previous Home</h2></section><section id="topology-view"></section></div></main></body></html>' });
  });
  trackDocument(page);
  await page.goto('http://navigation-guard.test/');
  return { b, page };
}

test('selected empty destination cannot borrow hidden previous-view content', async () => {
  const { b, page } = await fixture();
  try { assert.equal(await page.evaluate(activeViewReady, registeredViewRoots()), false, 'Empty Topology must not receive coverage credit from hidden Home'); }
  finally { await b.close(); }
});

test('hidden active root and hidden active content cannot receive coverage credit', async () => {
  const { b, page } = await fixture();
  try {
    await page.locator('#topology-view').evaluate(el => { el.innerHTML = '<h2>Hidden Topology</h2>'; el.setAttribute('hidden', ''); });
    assert.equal(await page.evaluate(activeViewReady, registeredViewRoots()), false, 'Hidden active root must fail');
    await page.locator('#topology-view').evaluate(el => { el.removeAttribute('hidden'); el.innerHTML = '<div hidden><h2>Hidden descendant</h2></div>'; });
    assert.equal(await page.evaluate(activeViewReady, registeredViewRoots()), false, 'Hidden active descendant must fail');
  } finally { await b.close(); }
});

test('actual visible empty-state content is ready; only active visible pending markers block it', async () => {
  const { b, page } = await fixture();
  try {
    await page.locator('#topology-view').evaluate(el => { el.innerHTML = '<div class="empty-state">No machines yet</div><div hidden data-topology-wait></div>'; });
    await page.locator('#home').evaluate(el => { el.innerHTML += '<div data-skeleton>Old pending Home</div>'; });
    assert.equal(await page.evaluate(activeViewReady, registeredViewRoots()), true, 'Visible active empty state is a real rendered result');
    await page.locator('#topology-view').evaluate(el => { el.innerHTML += '<div data-topology-wait>Still loading</div>'; });
    assert.equal(await page.evaluate(activeViewReady, registeredViewRoots()), false, 'Active visible waiting marker blocks coverage');
  } finally { await b.close(); }
});

test('document guard preserves real same-document history and hash changes, then rejects reload', async () => {
  const { b, page } = await fixture();
  try {
    await assertRetainedDocument(page);
    await page.evaluate(() => { history.pushState({}, '', '/settings'); location.hash = 'devices'; });
    await assertRetainedDocument(page);
    assert.equal(documentRequests(page).length, 1, 'SPA transition issues no second document request');
    await page.reload();
    assert.equal(documentRequests(page).length, 2, 'Negative control actually replaced the main document');
    console.log(`DOCUMENT GUARD: same-document requests=1 reload requests=${documentRequests(page).length} current navigation entries=${await page.evaluate(() => performance.getEntriesByType('navigation').length)}`);
    await assert.rejects(assertRetainedDocument(page), /actual router retains the document/, 'Reload must be rejected even though navigation timing resets to one');
  } finally { await b.close(); }
});
