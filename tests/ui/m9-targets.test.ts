// M9 gate, hit areas (Amendment 2026-10-30-C Part 2; UX-RESEARCH §7): at a phone's width every
// control a person can press has a 44×44 hit area (Apple 44 pt; Material's 48 dp on touch is met
// where the control sits in a 48 px row). Measured in the browser, not read from CSS: a 5×5 grid
// of points over a 44×44 box centred on the control must all land on it (or its label, or
// something inside it). So a small-looking button with a larger invisible hit area passes, and
// two controls whose boxes overlap fail. Links inside running text are exempt, as in WCAG 2.5.8's
// inline exception.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { browser, device, still } from './support.ts';
import { CONTROLS, PHONE, VIEWS, seeded, settled } from './m9-support.ts';

// Every visible control's hit area, in the page: 44×44, or 48×48 where the pointer is a finger.
// `scope`: an open overlay (the drawer, More, a sheet) is all that can be pressed while it's open.
// Returns the ones that miss.
function probe(page: Page, where: string, scope = 'body') {
  return page.evaluate(({ sel, where, scope }) => {
    const size = matchMedia('(pointer: coarse)').matches ? 48 : 44;
    const out: { where: string; what: string; box: string; missed: number; instead: string }[] = [];
    const inline = (el: Element) => {
      if (el.tagName !== 'A') return false;
      if (getComputedStyle(el).display !== 'inline') return false;
      const p = el.parentElement!;
      const text = [...p.childNodes].filter((n) => n !== el && n.nodeType === Node.TEXT_NODE && n.textContent!.trim()).length;
      return text > 0;
    };
    // An input drawn by its label (a radio or checkbox hidden inside a choice) is pressed there.
    const target = (el: Element): Element => (el instanceof HTMLInputElement && el.labels?.length && el.getBoundingClientRect().width < 4 ? el.labels[0]! : el);
    const seen = new Set<Element>();
    // Not counted: scroll regions that take focus only for the keyboard (a code block, a view), and
    // a message's time, which a finger reveals by pressing the whole message (Part 1).
    const all = [...document.querySelector(scope)!.querySelectorAll(sel)].filter((e) => (e as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !(e as HTMLElement).closest('[inert]') && !e.matches('pre[tabindex], .thread[tabindex], .view[tabindex], section[tabindex], time[tabindex]'));
    for (const raw of all) {
      const el = target(raw);
      if (seen.has(el) || inline(el)) continue;
      seen.add(el);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Off the screen until the keyboard reaches it (Skip to content): nothing for a finger to press.
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
      const cx = Math.min(Math.max(r.left + r.width / 2, size / 2), innerWidth - size / 2);
      const cy = Math.min(Math.max(r.top + r.height / 2, size / 2), innerHeight - size / 2);
      let missed = 0;
      const instead = new Set<string>();
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          const x = cx - size / 2 + 1 + (i * (size - 2)) / 4;
          const y = cy - size / 2 + 1 + (j * (size - 2)) / 4;
          const hit = document.elementFromPoint(x, y);
          const ok = !!hit && (el === hit || el.contains(hit) || (raw instanceof HTMLInputElement && [...(raw.labels ?? [])].some((l) => l === hit || l.contains(hit))));
          if (!ok) { missed++; instead.add(hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join('.')}` : 'nothing'); }
        }
      }
      if (missed) {
        const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
        out.push({ where, what: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].join('.')} “${label}”`, box: `${Math.round(r.width)}×${Math.round(r.height)}`, missed, instead: [...instead].join(', ') });
      }
    }
    return { misses: out, count: seen.size, size };
  }, { sel: CONTROLS, where, scope });
}

test('M9 gate, hit areas: every control at a phone’s width is 44×44, 48×48 to a finger', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-targets-');
  const misses: string[] = [];
  const counts: string[] = [];
  try {
    const d = await device(b, { ...PHONE, touch: true });
    const page = d.page;
    const check = async (where: string, scope = 'body') => {
      await still(page);
      const r = await probe(page, where, scope);
      counts.push(`${where}: ${r.count} at ${r.size}×${r.size}`);
      for (const x of r.misses) misses.push(`${x.where}: ${x.what} ${x.box} misses ${x.missed} of 25 (lands on ${x.instead})`);
    };
    for (const [view, path] of Object.entries(VIEWS)) {
      await page.goto(`${m.base}${path}`);
      await settled(page, view);
      await check(view);
    }
    // Open states: the composer with words in it, the conversations drawer, a revealed time.
    await page.goto(`${m.base}${VIEWS.chat}`);
    await settled(page, 'chat');
    await page.fill('#input', 'a note');
    await check('chat, typing');
    await page.locator('#thread .msg-user .bubble').first().tap();
    await check('chat, a message tapped');
    await page.click('#menu');
    await page.waitForSelector('.app.drawer-open');
    await check('chat, conversations open', '#sidebar');
    await page.keyboard.press('Escape');
    // More, and a task's sheet.
    await page.goto(`${m.base}/tasks`);
    await settled(page, 'tasks');
    await page.click('#more-btn');
    await page.waitForSelector('#more:not([hidden])');
    await check('More', '#more');
    await page.keyboard.press('Escape');
    await page.locator('#tasks-view [data-action="open-task"]').first().click();
    await page.waitForSelector('#sheet[open]');
    await check('a task', '#sheet');
    await page.keyboard.press('Escape');
    // Every Settings category, and search results.
    await page.goto(`${m.base}/settings`);
    await settled(page, 'settings');
    await page.fill('#settings-search', 'theme');
    await page.waitForSelector('#settings-results .settings-result');
    await check('Settings search');
    await page.fill('#settings-search', '');
    const cats = await page.$$eval('#settings-view .settings-cat', (as) => as.map((a) => (a as HTMLElement).dataset.cat!));
    for (const cat of cats) {
      await page.goto(`${m.base}/settings#${cat}`);
      await settled(page, 'settings');
      await page.waitForFunction((c) => !(document.querySelector(`.settings-pane[data-cat="${c}"]`) as HTMLElement)?.hidden, cat);
      await page.waitForTimeout(300);
      await check(`Settings › ${cat}`);
    }
    // A memory being edited.
    await page.goto(`${m.base}/memory`);
    await settled(page, 'memory');
    await page.locator('#memory .memory-item .memory-text').first().tap();
    await check('memory, editing');
    assert.deepEqual(d.errors, [], 'no errors in the page');
    console.log(`hit areas: controls checked per state\n${counts.join('\n')}`);
    assert.deepEqual(misses, [], `${misses.length} controls have less than 44×44 to press`);
  } finally {
    await b.close();
    await stop(nova);
  }
});
