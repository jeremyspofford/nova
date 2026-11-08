// Navigation/readiness for the seeded fold review, owned by the tests.
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { still, until } from './support.ts';

const CONTENT: Record<string, [string, string, string?]> = {
  '/': ['home', '#home .home-cards .card'],
  '/chat': ['chat', '#thread .turn table', 'And plan 3?'],
  '/tasks': ['tasks', '#tasks-view .task-list', 'Save the shopping list'],
  '/memory': ['memory', '#memory .memory-item', 'Prefers tea in the afternoon.'],
  '/automations': ['automations', '#schedules #sc-set'],
  '/activity': ['activity', '#activity .act-entry, #activity .act-empty'],
  '/health': ['health', '#health-view [data-resilience]'],
  '/settings': ['settings', '#settings-view .settings-cat'],
  '/capture': ['capture', '#capture-view .empty-state, #capture-view .capture-card'],
};

export async function foldViewReady(page: Page, url: string) {
  const path = new URL(url).pathname;
  const content = CONTENT[path];
  if (!content) throw new Error(`No fold readiness contract for ${path}`);
  await page.waitForURL(url);
  await page.waitForSelector('html[data-ready]', { timeout: 20_000 });
  // The aside renders cards even before its first answers: no-skeleton alone is insufficient.
  await until(page, async () => {
    const { store } = await import(String('/js/surfaces.js'));
    return store.loaded && store.health && store.tasks.some((task: { title: string }) => task.title === 'Save the shopping list');
  }, null, { timeout: 15_000 });
  await page.waitForFunction(([view, selector, text]) => {
    const root = document.querySelector<HTMLElement>(`body[data-view="${view}"]`);
    const drawn = document.querySelector<HTMLElement>(selector!);
    const renderPending = view === 'chat' && document.getElementById('thread')?.classList.contains('no-anim');
    return !!root && !!drawn && drawn.checkVisibility() && (!text || root.innerText.includes(text)) && !renderPending && !document.querySelector('[data-skeleton], .view-waiting');
  }, content, { timeout: 15_000 });
  // renderAll enables entrance animations on a scheduled frame. Register them before draining.
  if (path === '/chat') await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await still(page);
}

// One full boot; subsequent view changes click the app's real links/router. Repeated document
// teardown cannot synchronize an EventSource refresh that may begin after any drain of reads.
export async function openFoldView(page: Page, url: string) {
  const target = new URL(url);
  if (page.url() === 'about:blank') {
    await page.goto(url, { waitUntil: 'load' });
  } else {
    if (new URL(page.url()).origin !== target.origin) throw new Error('Fold navigation must stay in the seeded app');
    if (target.pathname === '/capture') {
      await openFoldView(page, `${target.origin}/settings`);
      await page.locator('#settings-nav a[href="/settings#capture"]').click({ timeout: 15_000 });
      await page.locator('#settings-capture a[href="/capture"]').click({ timeout: 15_000 });
    } else {
      const direct = page.locator(`#rail a[href="${target.pathname}"]`).filter({ visible: true });
      if (await page.locator('#nav-menu').isVisible()) {
        // A phone or a cover screen: the rail is the title bar's drawer.
        await page.locator('#nav-menu').click({ timeout: 15_000 });
        await page.locator(`#rail a[href="${target.pathname}"]`).click({ timeout: 15_000 });
      } else if (await direct.count()) await direct.first().click({ timeout: 15_000 });
      else {
        await page.locator('#more-btn').click({ timeout: 15_000 });
        await page.locator(`#more a[href="${target.pathname}"]`).click({ timeout: 15_000 });
      }
    }
  }
  await foldViewReady(page, url);
}

// Metadata and CSS arrive independently. Compare the installed sheet with the server's actual
// generation for this device/design; production's event handler must still perform the swap.
export async function foldDesignReady(page: Page, id: string, device: string) {
  await page.waitForFunction((id) => document.documentElement.dataset.theme === id, id);
  const response = await page.request.get(`${new URL(page.url()).origin}/design-system.css?device=${encodeURIComponent(device)}`);
  assert.equal(response.status(), 200, 'the applied device CSS is available');
  const css = await response.text();
  assert.ok(css.split('\n')[0]?.includes(`(${id}), mode `), `the CSS generation belongs to ${id}`);
  await page.waitForFunction(({ css, id, device }) => {
    const style = document.querySelector<HTMLStyleElement>('#ds');
    return document.documentElement.dataset.theme === id && localStorage.getItem('nova.device') === device &&
      !!style?.sheet && !style.sheet.disabled && style.sheet.cssRules.length > 0 && style.textContent === css && !document.getElementById('ds-boot');
  }, { css, id, device }, { timeout: 15_000 });
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await still(page);
}

// Resolve and measure in the same browser turn: a real core refresh can replace Home's cards.
export async function foldCardRadius(page: Page): Promise<string> {
  return page.evaluate(() => {
    const card = document.querySelector('#home .card');
    if (!card?.isConnected) throw new Error('No connected Home card to measure');
    return getComputedStyle(card).borderTopLeftRadius;
  });
}
