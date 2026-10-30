// The review of the UI fixes (Amendment 2026-10-30-C Part 1), in the real PWA: Undo after Save
// puts back exactly what Save changed; focus lands somewhere sensible after each Appearance
// action; live regions keep their place; the contrast panel says when it couldn't check;
// Settings uses the sidebar from 840px, opens a category's link at its top, focuses whatever
// search jumps to, has listbox semantics and a result count, and doesn't jump when its data
// arrives late; a long press tolerates a little finger movement; every time on screen passes
// 4.5:1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready } from './support.ts';
import { ENTRIES } from '../../ui/js/settings-ia.js';

const at = (hm: string) => `2026-10-28T${hm}.000Z`;
const LOG = [
  { ts: at('09:00:00'), type: 'session', id: '2026-10-28-garden', title: 'Planning the garden', v: 1 },
  { ts: at('09:00:00'), type: 'user', turn: 't1', text: 'What should I plant first?' },
  { ts: at('09:00:03'), type: 'tool_call', turn: 't1', attempt: 0, id: 'c1', name: 'read_file', args: { path: 'notes/garden.md' } },
  { ts: at('09:00:05'), type: 'tool_result', turn: 't1', attempt: 0, id: 'c1', ok: true, output: 'beds: two' },
  { ts: at('09:00:09'), type: 'assistant', turn: 't1', attempt: 0, id: 'a1', text: 'Start with the peas.' },
  { ts: at('09:00:10'), type: 'done', turn: 't1', attempt: 0 },
  { ts: at('09:02:00'), type: 'user', turn: 't2', text: '', followup: 'h1' },
  { ts: at('09:02:30'), type: 'assistant', turn: 't2', attempt: 0, id: 'a2', text: 'One more thing: water them in the morning.' },
  { ts: at('09:02:31'), type: 'done', turn: 't2', attempt: 0 },
];

async function boot(prefix: string) {
  const m = blank(prefix);
  const nova = await m.start();
  await finishSetup(m);
  writeFileSync(join(m.home, 'sessions', '2026-10-28-garden.jsonl'), `${LOG.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return { m, nova };
}
const appearance = async (m: ReturnType<typeof blank>) => (await m.get('/api/v1/profile')).appearance ?? {};
const active = (page: Page) => page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}${a.dataset.action ? `[${a.dataset.action}]` : ''}${a.getAttribute('aria-pressed') === 'true' ? '[pressed]' : ''}` : ''; });
const pick = async (page: Page, scope: 'device' | 'user') => {
  await page.locator(`#appearance label.choice:has(input[name="ds-scope"][value="${scope}"])`).click();
  await page.waitForFunction((s) => (document.querySelector(`input[name="ds-scope"][value="${s}"]`) as HTMLInputElement)?.checked, scope);
};
const settled = (page: Page) => page.waitForTimeout(400);

// ---- Appearance ---------------------------------------------------------------------------------------

test('review: Undo after Save puts back exactly what Save changed; focus and live regions stay sensible', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await boot('nova-ui-review-look-');
  try {
    const d = await device(b, { width: 1280, height: 820 });
    // Synced: Paper. This device: its own Obsidian. Light and dark: auto.
    assert.equal((await m.send('POST', '/api/v1/design-systems/paper/apply', { scope: 'user' })).status, 200);
    assert.equal((await m.send('POST', '/api/v1/design-systems/obsidian/apply', { scope: 'device', device_id: d.id })).status, 200);
    await d.page.goto(`${m.base}/settings#appearance`);
    await ready(d.page);
    const look = d.page.locator('#appearance');
    await look.locator('.ds-card').first().waitFor();
    const live = await d.page.evaluate(() => { const w = window as any; w.__scope = document.getElementById('appearance-scope'); w.__bar = document.getElementById('appearance-bar'); w.__check = document.getElementById('contrast-check'); return !!(w.__scope && w.__bar && w.__check); });
    assert.ok(live, 'the scope, the bar and the contrast check are live regions on the page');

    // Save Aurora, dark, for all devices; this device follows. Undo: all three come back.
    await pick(d.page, 'user');
    await look.locator('.ds-card[data-ds="aurora"]').click();
    await look.locator('#appearance-mode label.choice:has(input[value="dark"])').click();
    await look.locator('[data-action="save-ds"]').click();
    await d.page.locator('#toast .toast-btn').waitFor();
    await settled(d.page);
    let a = await appearance(m);
    assert.deepEqual([a.design_system, a.mode, a.device_overrides?.[d.id] ?? null], ['aurora', 'dark', null], 'Save changed all three');
    assert.match(await active(d.page), /\[pick-ds\]\[pressed\]/, 'after Save, focus is on the design now in use');
    assert.ok(await d.page.evaluate(() => { const w = window as any; return w.__scope === document.getElementById('appearance-scope') && w.__bar === document.getElementById('appearance-bar') && w.__check === document.getElementById('contrast-check'); }), 'the live regions are the same elements, updated in place');
    await d.page.locator('#toast .toast-btn').click();
    for (let i = 0; i < 40; i++) { a = await appearance(m); if (a.mode === 'auto' && a.device_overrides?.[d.id] === 'obsidian' && a.design_system === 'paper') break; await d.page.waitForTimeout(100); }
    assert.deepEqual([a.design_system, a.mode, a.device_overrides?.[d.id] ?? null], ['paper', 'auto', 'obsidian'], 'Undo put back the synced design, the mode and this device’s own design');

    // Save the design that is already synced, with a new mode: Undo puts back only the mode.
    await m.send('POST', '/api/v1/design-systems/follow', { device_id: d.id });
    await settled(d.page);
    const previous = (await appearance(m)).previous;
    await pick(d.page, 'user');
    await look.locator('.ds-card[data-ds="paper"]').click();
    await look.locator('#appearance-mode label.choice:has(input[value="light"])').click();
    await look.locator('[data-action="save-ds"]').click();
    await d.page.locator('#toast .toast-btn').waitFor();
    await settled(d.page);
    assert.equal((await appearance(m)).mode, 'light');
    await d.page.locator('#toast .toast-btn').click();
    for (let i = 0; i < 40; i++) { a = await appearance(m); if (a.mode === 'auto') break; await d.page.waitForTimeout(100); }
    assert.deepEqual([a.design_system, a.mode, a.previous], ['paper', 'auto', previous], 'only the mode came back; the design and its rollback are untouched');

    // Cancel and Undo leave focus on the design shown.
    await look.locator('.ds-card[data-ds="nova"]').click();
    await look.locator('[data-action="cancel-ds"]').click();
    await settled(d.page);
    assert.match(await active(d.page), /\[pick-ds\]\[pressed\]/, 'after Cancel, focus is on the design shown');
    await pick(d.page, 'device');
    await look.locator('.ds-card[data-ds="nova"]').click();
    await look.locator('[data-action="undo-ds"]').click();
    await settled(d.page);
    assert.match(await active(d.page), /\[pick-ds\]\[pressed\]/, 'after Undo, focus is on the design shown');

    // The fix and its undo move focus to each other.
    const mist = JSON.parse(readFileSync(new URL('../core/fixtures/design-system.json', import.meta.url), 'utf8'));
    Object.assign(mist, { id: 'example.mist', name: 'Example Mist' });
    Object.assign(mist.tokens, { 'border/strong': '#d3d7dc', 'bg/raised': '#d9dde3', 'accent/primary': '#234a8c', 'text/secondary': '#5f6872' });
    assert.equal((await m.send('POST', '/api/v1/design-systems', { manifest: mist })).status, 201);
    assert.equal((await m.send('POST', '/api/v1/extensions/example.mist/enable')).status, 200);
    await settled(d.page);
    await look.locator('.ds-card[data-ds="example.mist"]').click();
    await d.page.waitForFunction(() => document.getElementById('contrast-check')?.dataset.ok === 'false');
    await look.locator('[data-action="fix-contrast"]').click();
    await d.page.waitForFunction(() => document.getElementById('contrast-check')?.dataset.ok === 'true');
    await settled(d.page);
    assert.match(await active(d.page), /\[undo-fix\]/, 'after the fix, focus is on its Undo');
    await look.locator('[data-action="undo-fix"]').click();
    await d.page.waitForFunction(() => document.getElementById('contrast-check')?.dataset.ok === 'false');
    await settled(d.page);
    assert.match(await active(d.page), /\[fix-contrast\]/, 'after Undo, focus is back on the fix');
    assert.deepEqual(d.errors, [], 'no errors in the page');
    await d.ctx.close();

    // With the checks out of reach, the panel says it couldn't check; it never says "passes".
    const blind = await device(b, { width: 1280, height: 820 });
    await blind.page.route('**/api/v1/design-systems/schema', (r) => r.fulfill({ status: 503, body: '{}' }));
    await blind.page.goto(`${m.base}/settings#appearance`);
    await ready(blind.page);
    await blind.page.locator('#contrast-check').waitFor();
    await settled(blind.page);
    assert.equal(await blind.page.locator('#contrast-check').getAttribute('data-ok'), 'unknown');
    assert.match((await blind.page.locator('#contrast-check').textContent()) ?? '', /couldn’t check/);
    await blind.ctx.close();
  } finally {
    await b.close();
    await stop(nova);
  }
});

// ---- Settings -------------------------------------------------------------------------------------------

test('review: Settings — the sidebar from 840px, links open at the top, search is a listbox that focuses what it finds, late data doesn’t jump', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await boot('nova-ui-review-settings-');
  try {
    for (const [width, want] of [[820, 'list'], [840, 'sidebar'], [900, 'sidebar'], [1280, 'sidebar']] as const) {
      const d = await device(b, { width, height: 820 });
      await d.page.goto(`${m.base}/settings`);
      await ready(d.page);
      await d.page.locator('#settings-nav .settings-cat').first().waitFor();
      assert.equal(await d.page.locator('#settings-view').getAttribute('data-layout'), want, `${width}px: ${want}`);
      if (want === 'sidebar') {
        const nav = await d.page.locator('#settings-nav').boundingBox();
        const detail = await d.page.locator('.settings-detail').boundingBox();
        assert.ok(nav && detail && nav.x + nav.width <= detail.x && detail.width >= 380, `${width}px: the detail has room beside the sidebar (${detail?.width}px)`);
      }
      await d.ctx.close();
    }

    const d = await device(b, { width: 1280, height: 820 });
    // A category's link opens it at its top, as a click does.
    await d.page.goto(`${m.base}/settings#models`);
    await ready(d.page);
    await d.page.locator('.settings-pane[data-cat="models"]:not([hidden])').waitFor();
    await d.page.waitForTimeout(800);
    assert.equal(await d.page.evaluate(() => document.getElementById('scroller')!.scrollTop), 0, '#models opens at the top');
    assert.equal(await d.page.locator('.is-found').count(), 0, 'and marks nothing');

    // Search: a combobox and a listbox, a count that is announced, arrows and Enter.
    const box = d.page.locator('#settings-search');
    assert.equal(await box.getAttribute('role'), 'combobox');
    assert.equal(await box.getAttribute('aria-expanded'), 'false');
    await d.page.evaluate(() => { (window as any).__count = document.getElementById('settings-count'); });
    await box.fill('dark');
    await d.page.locator('#settings-results [role="option"]').first().waitFor();
    assert.equal(await d.page.locator('#settings-results').getAttribute('role'), 'listbox');
    assert.equal(await box.getAttribute('aria-expanded'), 'true');
    assert.match((await d.page.locator('#settings-count').textContent()) ?? '', /^\d+ settings? found$/);
    assert.equal(await d.page.locator('#settings-count').getAttribute('role'), 'status');
    assert.equal(await d.page.locator('#settings-results').getAttribute('aria-live'), null, 'the list itself isn’t read out on every keystroke');
    await box.fill('dark mode');
    assert.ok(await d.page.evaluate(() => (window as any).__count === document.getElementById('settings-count')), 'the count is the same live region, updated in place');
    await box.press('ArrowDown');
    const first = await d.page.locator('#settings-results [role="option"]').first().getAttribute('id');
    assert.equal(await box.getAttribute('aria-activedescendant'), first);
    assert.equal(await d.page.locator(`#${first}`).getAttribute('aria-selected'), 'true');
    await box.press('Enter');
    await d.page.waitForFunction(() => document.getElementById('appearance-mode')?.classList.contains('is-found'));

    // Every setting search can reach: it opens, is marked, and has the focus.
    const entries = ENTRIES.map((e: { label: string; target: string }) => ({ label: e.label, target: e.target }));
    for (const e of entries) {
      await box.fill(e.label);
      const option = d.page.locator(`#settings-results [role="option"][data-target="${e.target}"]`);
      await option.waitFor({ timeout: 3000 });
      await option.click();
      await d.page.waitForFunction((id) => document.getElementById(id)?.classList.contains('is-found'), e.target, { timeout: 3000 });
      assert.ok(await d.page.evaluate((id) => { const el = document.getElementById(id); return !!el && el.contains(document.activeElement); }, e.target), `${e.label}: focus is on it`);
    }
    assert.deepEqual(d.errors, [], 'no errors in the page');
    await d.ctx.close();

    // Late data doesn't move focus or scroll once the person has started on something.
    const slow = await device(b, { width: 1280, height: 820 });
    await slow.page.route('**/api/permissions', async (r) => { await new Promise((x) => setTimeout(x, 1500)); await r.continue(); });
    await slow.page.goto(`${m.base}/settings#devices`);
    await ready(slow.page);
    await slow.page.locator('#settings-search').fill('backup');
    const before = await slow.page.evaluate(() => document.getElementById('scroller')!.scrollTop);
    await slow.page.waitForTimeout(2500);
    assert.equal(await active(slow.page), 'input#settings-search', 'focus stays in the search');
    assert.equal(await slow.page.inputValue('#settings-search'), 'backup');
    assert.equal(await slow.page.evaluate(() => document.getElementById('scroller')!.scrollTop), before, 'and the page stays put');
    await slow.ctx.close();
  } finally {
    await b.close();
    await stop(nova);
  }
});

// ---- Chat and times ------------------------------------------------------------------------------------

test('review: a long press tolerates a little movement; every time on screen passes 4.5:1', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await boot('nova-ui-review-times-');
  try {
    const offer = (await m.get('/api/schedules')).available?.[0];
    if (offer) assert.equal((await m.send('POST', `/api/schedules/${offer.id}/setup`, { time: '07:00', days: 'every' })).status, 200);
    const d = await device(b, { width: 390, height: 844, touch: true, timezone: 'UTC' });
    await d.page.goto(`${m.base}/c/2026-10-28-garden`);
    await ready(d.page);
    const msg = d.page.locator('.msg-nova:has(time[datetime="2026-10-28T09:02:30.000Z"])');
    await msg.waitFor();
    const press = (dx: number) => msg.locator('.prose').evaluate(async (el, move) => {
      const r = el.getBoundingClientRect();
      const o = { pointerType: 'touch', bubbles: true, clientX: r.left + 10, clientY: r.top + 5, pointerId: 7 };
      el.closest('.msg')!.classList.remove('show-time');
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      el.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: o.clientX + move }));
      await new Promise((x) => setTimeout(x, 650));
      const shown = el.closest('.msg')!.classList.contains('show-time');
      el.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: o.clientX + move }));
      return shown;
    }, dx);
    assert.equal(await press(6), true, 'a press that moves 6px still shows the time');
    assert.equal(await press(24), false, 'a 24px drag is a scroll, not a press');
    await d.ctx.close();

    // Every element whose own text is a time or a date, on the views that show them.
    const desk = await device(b, { width: 1280, height: 820, timezone: 'UTC' });
    const TIME = /\b\d{1,2}:\d{2}\s?(AM|PM)\b|\b(just now|\d+ (min|h) ago|today|yesterday|tomorrow)\b|\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}\b/i;
    for (const path of ['/', '/c/2026-10-28-garden', '/tasks', '/activity', '/automations', '/settings#checkpoints']) {
      await desk.page.goto(`${m.base}${path}`);
      await ready(desk.page);
      await desk.page.waitForTimeout(600);
      const low = await desk.page.evaluate((src) => {
        const re = new RegExp(src, 'i');
        const rgb = (s: string): number[] | null => { const m = /^rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]; };
        const probe = (v: string) => { const p = document.createElement('i'); p.style.color = v; document.body.append(p); const c = rgb(getComputedStyle(p).color)!; p.remove(); return c; };
        const over = (f: number[], bg: number[]) => [0, 1, 2].map((i) => f[i]! * f[3]! + bg[i]! * (1 - f[3]!)).concat(1);
        const lum = (c: number[]) => { const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!); };
        const ratio = (x: number[], y: number[]) => { const [p, q] = [lum(x), lum(y)].sort((u, v) => v - u); return (p! + 0.05) / (q! + 0.05); };
        const root = getComputedStyle(document.documentElement);
        const base = probe(root.getPropertyValue('--bg-base'));
        const raised = over(probe(root.getPropertyValue('--bg-raised')), base);
        const behind = (el: Element) => { for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c && c[3]! > 0) return [over(c, base)]; } return [base, raised]; };
        const own = (el: Element) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
        return [...document.querySelectorAll('#app *')].filter((el) => (el as HTMLElement).checkVisibility() && el.getBoundingClientRect().width > 4 && re.test(own(el))).map((el) => {
          const fg = rgb(getComputedStyle(el).color)!;
          const r = Math.min(...behind(el).map((bg) => ratio(fg[3]! < 1 ? over(fg, bg) : fg, bg)));
          return { text: own(el).trim().slice(0, 50), cls: el.className.toString(), ratio: Math.round(r * 100) / 100 };
        }).filter((x) => x.ratio < 4.5);
      }, TIME.source);
      assert.deepEqual(low, [], `${path}: every time on screen passes 4.5:1`);
    }
    await desk.ctx.close();
  } finally {
    await b.close();
    await stop(nova);
  }
});
