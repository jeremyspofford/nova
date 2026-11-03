// Shared by the canonical crawl and focused guard controls; importing this starts no tests.
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { ready, still } from './support.ts';
import { registeredViewRoots } from '../support/navigation-registry.js';

// This function runs in the browser in both the crawl and the negative controls.
export async function activeViewReady(roots: Record<string, string>) {
  const { store } = await import(String('/js/surfaces.js'));
  const id = roots[document.body.dataset.view ?? ''];
  if (!id) return false;
  const root = document.getElementById(id);
  const visible = (element: HTMLElement) => !element.hidden && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  if (!root || !visible(root)) return false;
  const content = [...root.querySelectorAll<HTMLElement>('h2, .card, .empty, .empty-state, .turn')].some(visible);
  const pending = [...root.querySelectorAll<HTMLElement>('[data-skeleton], .view-waiting, [data-waiting], [data-topology-wait]')].some(visible);
  return store.loaded && !!store.health && content && !pending && !root.classList.contains('no-anim');
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
  await page.waitForFunction(activeViewReady, roots, { timeout: 20_000 });
  await still(page);
  await assertRetainedDocument(page);
}
