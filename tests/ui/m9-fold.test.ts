// M9 gate, foldable and responsive (Amendment 2026-10-30-C Part 2; UX-RESEARCH §7), in the order
// the amendment gives:
//   1. state survives fold, unfold and resize: the reader's place, a draft, a Settings edit;
//   2. no stretched single column on expanded widths: prose 45–75ch, the extra width a second pane;
//   3. nothing under the hinge: a real hinge, emulated through Chromium's display feature (which
//      gives the page real viewport segments and env(viewport-segment-*) values);
//   4. 200% text survives: the browser's default text size doubled, as a person's setting does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CDPSession, Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { browser, device, still } from './support.ts';
import { CHAT, CONTROLS, VIEWS, seeded, settled } from './m9-support.ts';

const ALL = ['activity', 'automations', 'chat', 'health', 'home', 'memory', 'settings', 'skills', 'tasks'];
type Hinge = { orientation: 'vertical' | 'horizontal'; offset: number; maskLength: number };

// The screen: a size, and a hinge if the device has one open.
async function screen(page: Page, cdp: CDPSession, width: number, height: number, hinge?: Hinge) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, ...(hinge ? { displayFeature: hinge } : {}) });
  await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height]);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(150);
}

test('M9 gate, foldable 1: the reader’s place, a draft and a Settings edit survive fold, unfold and resize', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-fold1-');
  // folded (the cover screen) → unfolded → half-open, a hinge down the middle → a laptop's window → folded again.
  const STEPS: [string, number, number, Hinge?][] = [
    ['unfolded', 884, 1104],
    ['half-open', 884, 1104, { orientation: 'vertical', offset: 430, maskLength: 24 }],
    ['a desktop window', 1280, 820],
    ['folded again', 390, 844],
  ];
  const rows: string[] = [];
  try {
    const d = await device(b, { width: 390, height: 844 });
    const cdp = await d.ctx.newCDPSession(d.page);
    await screen(d.page, cdp, 390, 844);
    // A conversation, read part way, with a reply half written.
    await d.page.goto(`${m.base}/c/${CHAT}`);
    await settled(d.page, 'chat');
    await still(d.page);
    await d.page.evaluate(() => { const s = document.getElementById('scroller')!; const t = document.getElementById('t-t5')!; s.scrollTop += t.getBoundingClientRect().top - s.getBoundingClientRect().top + 4; });
    await d.page.waitForTimeout(200);
    await d.page.fill('#input', 'Half a thought about the beans');
    await d.page.evaluate(() => (document.activeElement as HTMLElement).blur());
    const offset = () => d.page.evaluate(() => Math.round(document.getElementById('t-t5')!.getBoundingClientRect().top - document.getElementById('scroller')!.getBoundingClientRect().top));
    const start = await offset();
    for (const [what, w, h, hinge] of STEPS) {
      await screen(d.page, cdp, w, h, hinge);
      const now = await offset();
      assert.ok(Math.abs(now - start) <= 2, `${what}: the message at the top stays there (${start} → ${now} px)`);
      assert.equal(await d.page.inputValue('#input'), 'Half a thought about the beans', `${what}: the draft is intact`);
      assert.equal(new URL(d.page.url()).pathname, `/c/${CHAT}`, `${what}: the same conversation`);
      rows.push(`chat, ${what} (${w}×${h}${hinge ? ', hinge' : ''}): place ${start} → ${now} px, draft kept`);
    }
    // Settings: a name typed and not yet saved, with the field still in use.
    await screen(d.page, cdp, 390, 844);
    await d.page.goto(`${m.base}/settings#you`);
    await settled(d.page, 'settings');
    await d.page.waitForSelector('#you-name');
    await d.page.fill('#you-name', 'Sam');
    for (const [what, w, h, hinge] of STEPS) {
      await screen(d.page, cdp, w, h, hinge);
      assert.equal(await d.page.inputValue('#you-name'), 'Sam', `${what}: the unsaved edit is intact`);
      assert.equal(await d.page.evaluate(() => document.activeElement?.id), 'you-name', `${what}: and still has the focus`);
      assert.equal(await d.page.locator('.settings-pane[data-cat="you"]').isVisible(), true, `${what}: its category is still open`);
      rows.push(`settings, ${what}: edit and focus kept`);
    }
    assert.deepEqual(d.errors, [], 'no errors in the page');
    console.log(`state:\n${rows.join('\n')}`);
  } finally {
    await b.close();
    await stop(nova);
  }
});

test('M9 gate, foldable 2: no stretched single column — prose at 45–75ch, the extra width a second pane', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-fold2-');
  const rows: string[] = [];
  try {
    for (const width of [840, 1024, 1280, 1920]) {
      const d = await device(b, { width, height: 900 });
      for (const [view, path] of Object.entries(VIEWS)) {
        await d.page.goto(`${m.base}${path}`);
        await settled(d.page, view);
        await still(d.page);
        const r = await d.page.evaluate(() => {
          const shown = (e: Element | null) => !!e && (e as HTMLElement).checkVisibility() && e.getBoundingClientRect().width > 0;
          // A second pane beside the main column: the right column, or Settings' sidebar.
          const main = document.querySelector('#scroller')!.getBoundingClientRect();
          const aside = document.getElementById('aside');
          const nav = document.getElementById('settings-nav');
          const detail = document.querySelector('.settings-detail');
          let second = '';
          if (shown(aside) && aside!.getBoundingClientRect().width >= 200 && aside!.getBoundingClientRect().left >= main.right - 1) second = `the right column (${Math.round(aside!.getBoundingClientRect().width)} px)`;
          else if (shown(nav) && shown(detail) && nav!.getBoundingClientRect().right <= detail!.getBoundingClientRect().left + 1) second = `the Settings sidebar (${Math.round(nav!.getBoundingClientRect().width)} px)`;
          // Prose: paragraphs long enough to wrap, measured in their own font's ch.
          const measures = [...document.querySelectorAll('#main p, #main li')].filter((e) => shown(e) && (e.textContent ?? '').trim().length >= 160).map((e) => {
            const probe = document.createElement('span');
            probe.textContent = '0';
            probe.style.font = getComputedStyle(e).font;
            probe.style.position = 'absolute';
            document.body.append(probe);
            const ch = probe.getBoundingClientRect().width;
            probe.remove();
            return Math.round((e.getBoundingClientRect().width - parseFloat(getComputedStyle(e).paddingLeft) - parseFloat(getComputedStyle(e).paddingRight)) / ch);
          });
          return { second, measures };
        });
        assert.ok(r.second, `${width}px, ${view}: a second pane takes the extra width`);
        for (const n of r.measures) assert.ok(n >= 45 && n <= 75, `${width}px, ${view}: prose is ${n}ch wide (45–75)`);
        rows.push(`${String(width).padStart(4)}px ${view.padEnd(8)} second pane: ${r.second}; prose ${r.measures.length ? `${Math.min(...r.measures)}–${Math.max(...r.measures)}ch` : '(none long)'}`);
      }
      assert.deepEqual(d.errors, [], `${width}px: no errors in the page`);
      await d.ctx.close();
    }
    console.log(`measure and panes:\n${rows.join('\n')}`);
  } finally {
    await b.close();
    await stop(nova);
  }
});

// Everything a person reads or presses that overlaps the hinge.
function underHinge(page: Page, hinge: { x: number; y: number; w: number; h: number }) {
  return page.evaluate((g) => {
    const clip = (e: Element, r: DOMRect) => {
      let c = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      for (let x = e.parentElement; x; x = x.parentElement) {
        const cs = getComputedStyle(x);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const b = x.getBoundingClientRect();
        c = { left: Math.max(c.left, b.left), top: Math.max(c.top, b.top), right: Math.min(c.right, b.right), bottom: Math.min(c.bottom, b.bottom) };
      }
      return c;
    };
    const hitIn = (e: Element) => (r: DOMRect) => { const c = clip(e, r); return c.right - c.left > 0 && c.bottom - c.top > 0 && c.left < g.x + g.w && c.right > g.x && c.top < g.y + g.h && c.bottom > g.y; };
    const out: string[] = [];
    const name = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}.${[...e.classList].slice(0, 2).join('.')}`;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent!.trim()) continue;
      const p = n.parentElement!;
      if (!p.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || p.closest('.sr-only, [aria-hidden="true"]')) continue;
      // Visually hidden until asked for (a message's exact time): clipped to nothing.
      if (getComputedStyle(p).clipPath === 'inset(50%)' || p.getBoundingClientRect().width <= 1) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      if ([...range.getClientRects()].some(hitIn(p))) out.push(`text “${n.textContent!.trim().slice(0, 24)}” in ${name(p)}`);
    }
    for (const e of document.querySelectorAll('button, a[href], input, textarea, select, img, svg, .orb, video, canvas')) {
      if (!(e as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      if (hitIn(e)(e.getBoundingClientRect())) out.push(name(e));
    }
    return [...new Set(out)];
  }, hinge);
}

test('M9 gate, foldable 3: nothing under the hinge, in the book and laptop postures', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-fold3-');
  const rows: string[] = [];
  const POSTURES: [string, number, number, Hinge, { x: number; y: number; w: number; h: number }, string][] = [
    ['book (side by side)', 1200, 800, { orientation: 'vertical', offset: 588, maskLength: 24 }, { x: 588, y: 0, w: 24, h: 800 }, 'half-open-horizontal'],
    ['laptop (one above the other)', 800, 1200, { orientation: 'horizontal', offset: 588, maskLength: 24 }, { x: 0, y: 588, w: 800, h: 24 }, 'half-open-vertical'],
  ];
  try {
    for (const [what, w, h, hinge, rect, posture] of POSTURES) {
      const d = await device(b, { width: w, height: h });
      const cdp = await d.ctx.newCDPSession(d.page);
      await screen(d.page, cdp, w, h, hinge);
      const check = async (state: string) => {
        await still(d.page);
        const under = await underHinge(d.page, rect);
        assert.deepEqual(under, [], `${what}, ${state}: nothing under the hinge`);
        rows.push(`${what}, ${state}: clear`);
      };
      for (const [view, path] of Object.entries(VIEWS)) {
        await d.page.goto(`${m.base}${path}`);
        await settled(d.page, view);
        assert.equal(await d.page.evaluate(() => document.body.dataset.posture), posture, `${what}: the browser reports the posture`);
        await check(view);
      }
      // Open things: the conversations drawer, More, a task's sheet, a toast.
      await d.page.goto(`${m.base}/c/${CHAT}`);
      await settled(d.page, 'chat');
      await d.page.click('#menu');
      await d.page.waitForSelector('.app.drawer-open');
      await check('conversations open');
      await d.page.keyboard.press('Escape');
      await d.page.click('#more-btn');
      await d.page.waitForSelector('#more:not([hidden])');
      await check('More open');
      await d.page.keyboard.press('Escape');
      await d.page.goto(`${m.base}/tasks`);
      await settled(d.page, 'tasks');
      await d.page.locator('#tasks-view [data-action="open-task"]').first().click();
      await d.page.waitForSelector('#sheet[open]');
      await check('a task open');
      await d.page.keyboard.press('Escape');
      await d.page.evaluate(async () => (await import(String('/js/shell.js'))).toast('Saved. Nova will use it from the next message.'));
      await d.page.waitForSelector('#toast:not([hidden])');
      await check('a toast');
      assert.deepEqual(d.errors, [], `${what}: no errors in the page`);
      await d.ctx.close();
    }
    console.log(`hinge:\n${rows.join('\n')}`);
  } finally {
    await b.close();
    await stop(nova);
  }
});

test('M9 gate, foldable 4: 200% text survives, at a phone’s width and a desktop’s', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-fold4-');
  const rows: string[] = [];
  try {
    for (const [size, w, h] of [['phone', 390, 844], ['desktop', 1280, 820]] as const) {
      const d = await device(b, { width: w, height: h, touch: size === 'phone' });
      const cdp = await d.ctx.newCDPSession(d.page);
      // A person's text size at 200%: the browser's default font size doubled (16 → 32 px).
      await cdp.send('Page.setFontSizes', { fontSizes: { standard: 32, fixed: 26 } });
      for (const [view, path] of Object.entries(VIEWS)) {
        await d.page.goto(`${m.base}${path}`);
        await settled(d.page, view);
        await still(d.page);
        const r = await d.page.evaluate((controls) => {
          const shown = (e: Element) => (e as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getBoundingClientRect().width > 0 && !e.closest('[inert], .sr-only');
          const body = parseFloat(getComputedStyle(document.body).fontSize);
          const sideways = document.documentElement.scrollWidth - innerWidth;
          // Text cut off by its own box (hidden or clipped overflow, an ellipsis).
          const clipped = [...document.querySelectorAll('#app *')].filter((e) => shown(e) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())).filter((e) => {
            const cs = getComputedStyle(e);
            // Hidden for the eye on purpose: a time until asked for, a title only for screen readers.
            if (cs.clipPath === 'inset(50%)' || /^rect\(0/.test(cs.clip) || e.getBoundingClientRect().width <= 1) return false;
            const cuts = /hidden|clip/.test(cs.overflowX + cs.overflowY) || cs.textOverflow === 'ellipsis';
            return cuts && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1);
          }).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} “${(e.textContent ?? '').trim().slice(0, 24)}”`);
          // Controls drawn over one another, as far as each is seen (a scroller clips what it scrolls).
          const seen = (e: Element) => {
            let r = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
            for (let x: Element | null = e; x; x = x.parentElement) {
              const cs = getComputedStyle(x);
              if (x === e || /visible/.test(cs.overflowX + cs.overflowY) && cs.overflowX === 'visible' && cs.overflowY === 'visible') { if (x !== e) continue; }
              const b = x.getBoundingClientRect();
              r = { left: Math.max(r.left, b.left), top: Math.max(r.top, b.top), right: Math.min(r.right, b.right), bottom: Math.min(r.bottom, b.bottom) };
            }
            return r;
          };
          const list = [...document.querySelectorAll(controls)].filter(shown);
          const overlaps: string[] = [];
          for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
            const a = list[i]!; const c = list[j]!;
            if (a.contains(c) || c.contains(a)) continue;
            const p = seen(a); const q = seen(c);
            const x = Math.min(p.right, q.right) - Math.max(p.left, q.left);
            const y = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
            if (x > 2 && y > 2) overlaps.push(`${a.textContent?.trim().slice(0, 16) || a.getAttribute('aria-label')} / ${c.textContent?.trim().slice(0, 16) || c.getAttribute('aria-label')}`);
          }
          return { body, sideways, clipped: [...new Set(clipped)], overlaps };
        }, CONTROLS);
        assert.ok(r.body >= 31, `${size}, ${view}: the text is twice as big (${r.body}px)`);
        assert.ok(r.sideways <= 0, `${size}, ${view}: no sideways scrolling (${r.sideways}px)`);
        assert.deepEqual(r.clipped, [], `${size}, ${view}: no text cut off`);
        assert.deepEqual(r.overlaps, [], `${size}, ${view}: no control over another`);
        rows.push(`${size}, ${view}: text ${r.body}px, nothing cut off or overlapping`);
      }
      // Every destination is still within reach.
      const seen = new Set(await d.page.$$eval('#rail [data-dest], #tabs [data-dest]', (els) => els.filter((e) => (e as HTMLElement).checkVisibility()).map((e) => (e as HTMLElement).dataset.dest!)));
      if (await d.page.locator('#more-btn').isVisible()) {
        await d.page.click('#more-btn');
        for (const x of await d.page.$$eval('#more [data-dest]', (els) => els.filter((e) => (e as HTMLElement).checkVisibility()).map((e) => (e as HTMLElement).dataset.dest!))) seen.add(x);
        await d.page.keyboard.press('Escape');
      }
      assert.deepEqual([...seen].sort(), ALL, `${size}: every destination is reachable`);
      assert.deepEqual(d.errors, [], `${size}: no errors in the page`);
      await d.ctx.close();
    }
    console.log(`200% text:\n${rows.join('\n')}`);
  } finally {
    await b.close();
    await stop(nova);
  }
});
