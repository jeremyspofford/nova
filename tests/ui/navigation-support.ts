// Shared by the canonical crawl and focused guard controls; importing this starts no tests.
import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright-core';
import { ready, still, until } from './support.ts';
import { registeredViewRoots } from '../support/navigation-registry.js';

export type Door = { href: string; label: string; section: string };
export type Step = Door | { button: string; label: string };

// One real tap or click, then the page it leads to, drawn. A link's route changes a moment after
// the tap (the router runs in a later task), and until then the page it left still reads as ready:
// so wait for the address to move first (or to be where the link points already).
export async function press(page: Page, step: Step, touch: boolean) {
  let el: Locator;
  if ('button' in step) el = page.locator(step.button);
  else {
    const link = `a[href=${JSON.stringify(step.href)}]`;
    const scope = step.section ? `[id=${JSON.stringify(step.section)}] ${link}, ${link}[id=${JSON.stringify(step.section)}]` : link;
    el = page.locator(scope).filter({ visible: true }).first();
  }
  assert.ok(await el.isVisible(), `Visible door: ${JSON.stringify(step)}`);
  const before = await page.evaluate(() => location.pathname + location.hash);
  if (touch) await el.tap(); else await el.click();
  if (!('button' in step)) {
    const href = new URL(step.href, page.url());
    await page.waitForFunction(([was, to]) => { const now = location.pathname + location.hash; return now !== was || now === to; }, [before, href.pathname + href.hash] as const, { timeout: 20_000 });
  }
  await drawn(page);
}

// This function runs in the browser in both the crawl and the negative controls.
export async function activeViewReady(roots: Record<string, string>) {
  const { store } = await import(String('/js/surfaces.js'));
  const id = roots[document.body.dataset.view ?? ''];
  if (!id) return false;
  const root = document.getElementById(id);
  const visible = (element: HTMLElement) => !element.hidden && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  if (!root || !visible(root)) return false;
  // A view's "nothing here yet" line (.memory-none: Memory, Skills, Automations, Activity) is a real result.
  const content = [...root.querySelectorAll<HTMLElement>('h2, .card, .empty, .empty-state, .memory-none, .turn')].some(visible);
  const pending = [...root.querySelectorAll<HTMLElement>('[data-skeleton], .view-waiting, [data-waiting], [data-topology-wait]')].some(visible);
  // A conversation drawn whole holds its entrance off until the next frame (app.js renderAll puts
  // no-anim on #thread, not on the view's root); until then the fade from opacity 0 hasn't begun.
  const entrancePending = !!document.querySelector('#thread.no-anim');
  return store.loaded && !!store.health && content && !pending && !root.classList.contains('no-anim') && !entrancePending;
}

const documents = new WeakMap<Page, string[]>();
export function trackDocument(page: Page) {
  const requests: string[] = [];
  documents.set(page, requests);
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) requests.push(request.url());
  });
}
export function documentRequests(page: Page) {
  const requests = documents.get(page);
  assert.ok(requests, 'Document tracking must start before initial Home navigation');
  return requests;
}
export async function assertRetainedDocument(page: Page) {
  assert.equal(documentRequests(page).length, 1, 'actual router retains the document: exactly one lifetime main-document request');
}
export async function drawn(page: Page, roots = registeredViewRoots()) {
  await assertRetainedDocument(page);
  await ready(page);
  await until(page, activeViewReady, roots, { timeout: 20_000 });
  // An entrance enabled on a scheduled frame registers on the next one: let it, then drain it (as
  // fold-navigation.ts does). Without this a crawl read could land on the fade's first frame, where
  // opacity 0 hides every link (the #356 phone failure: the schedule link "missing").
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await still(page);
  await assertRetainedDocument(page);
}
