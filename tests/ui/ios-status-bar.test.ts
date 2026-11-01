// The installed iPhone app's status bar, per design (DESIGN-SYSTEM §5, owner decision 2026-10-31,
// option C): a dark design draws behind it (apple-mobile-web-app-status-bar-style
// black-translucent), a light one keeps iOS's own strip (default). A design with a light and a
// dark look follows the appearance the page shows. The tag is in the page as the server sends it
// (iOS reads it at launch) and is kept current on a live swap.
//
// What this can't show: no test browser runs as an installed iOS app, so whether iOS honours the
// tag (and when it reads it again) is for a real iPhone. WebKit here reports no safe-area insets;
// Chromium can (DevTools' safe-area override, as an installed app with viewport-fit=cover gets
// them), so the top padding is measured there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, webkitBrowser } from './support.ts';

const META = '#ios-status-bar';
const BLACK = 'black-translucent';
// Each design, and what its tag says in each appearance: [mode, the system's scheme, value].
const LOOKS: [string, 'auto' | 'light' | 'dark', 'light' | 'dark', string][] = [
  ...['orb-teal', 'nova', 'obsidian'].flatMap((id) => [[id, 'auto', 'light', BLACK], [id, 'auto', 'dark', BLACK], [id, 'light', 'light', BLACK]] as [string, 'auto', 'light', string][]),
  ['companion-light', 'auto', 'light', 'default'], ['companion-light', 'auto', 'dark', 'default'], ['companion-light', 'dark', 'dark', 'default'],
  ...['aurora', 'paper'].flatMap((id) => [[id, 'auto', 'light', 'default'], [id, 'auto', 'dark', BLACK], [id, 'light', 'dark', 'default'], [id, 'dark', 'light', BLACK]] as [string, 'auto', 'light', string][]),
];

const tagOf = (html: string) => html.match(/<meta name="apple-mobile-web-app-status-bar-style"[^>]*>/g) ?? [];
const content = (page: Page) => page.evaluate((sel) => (document.querySelector(sel) as HTMLMetaElement | null)?.content ?? null, META);

async function applyFor(m: ReturnType<typeof blank>, id: string, mode: string) {
  const a = await m.send('POST', `/api/v1/design-systems/${id}/apply`, { scope: 'user' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await m.send('PUT', '/api/v1/profile/appearance/mode', { value: mode });
  assert.equal(b.status, 200, JSON.stringify(b.body));
}

test('the iOS status bar tag follows each design, as sent and once loaded, in Chromium and WebKit', { timeout: 300_000 }, async (t) => {
  const c = await browser();
  if (typeof c === 'string') return t.skip(c);
  const w = await webkitBrowser();
  if (typeof w === 'string') { await c.close(); return t.skip(w); }
  const m = blank('nova-ui-statusbar-');
  const nova = await m.start();
  const bad: string[] = [];
  try {
    await finishSetup(m);
    for (const [id, mode, scheme, want] of LOOKS) {
      await applyFor(m, id, mode);
      // As sent: exactly one tag, holding the design's words (the server writes them in).
      const html = await (await fetch(`${m.base}/`)).text();
      const tags = tagOf(html);
      if (tags.length !== 1) bad.push(`${id} ${mode}: ${tags.length} status bar tags in the page`);
      // Where the appearance is known without the device (one look, or a fixed mode), the value is
      // already right before any script runs.
      const sure = mode !== 'auto' || ['orb-teal', 'nova', 'obsidian', 'companion-light'].includes(id);
      if (sure && !tags[0]?.includes(`content="${want}"`)) bad.push(`${id} ${mode}: sent ${tags[0]}, want content="${want}"`);
      for (const [engine, b] of [['chromium', c], ['webkit', w]] as [string, Browser][]) {
        const d = await device(b, { width: 390, height: 844, scheme, touch: true, serviceWorkers: 'block' });
        // Before the app has asked the core anything: the page's own picker (the system's scheme
        // under auto), on the server's words.
        await d.page.goto(`${m.base}/`, { waitUntil: 'domcontentloaded' });
        const early = await content(d.page);
        await ready(d.page);
        await d.page.waitForFunction(([sel, v]) => (document.querySelector(sel!) as HTMLMetaElement).content === v, [META, want], { timeout: 5000 }).catch(() => {});
        const late = await content(d.page);
        console.log(`STATUSBAR ${engine} ${id} mode=${mode} scheme=${scheme}: early=${early} loaded=${late} want=${want}`);
        if (early !== want) bad.push(`${engine} ${id} ${mode}/${scheme}: ${early} at first parse, want ${want}`);
        if (late !== want) bad.push(`${engine} ${id} ${mode}/${scheme}: ${late} once loaded, want ${want}`);
        if (d.errors.length) bad.push(`${engine} ${id}: page errors ${d.errors.join(' | ')}`);
        await d.ctx.close();
      }
    }
    assert.deepEqual(bad, [], 'the status bar tag per design');
  } finally {
    await c.close();
    await w.close();
    await stop(nova);
  }
});

test('a live design swap updates the tag with no reload, for every device and for this device only', { timeout: 120_000 }, async (t) => {
  const c = await browser();
  if (typeof c === 'string') return t.skip(c);
  const m = blank('nova-ui-statusbar-swap-');
  const nova = await m.start();
  try {
    await finishSetup(m);
    await applyFor(m, 'orb-teal', 'auto');
    const d = await device(c, { width: 390, height: 844, scheme: 'light', touch: true, serviceWorkers: 'block' });
    await d.page.goto(`${m.base}/`);
    await ready(d.page);
    await d.page.evaluate(() => { (window as unknown as { __boot: string }).__boot = 'first-load'; });
    const waitFor = (v: string) => d.page.waitForFunction(([sel, want]) => (document.querySelector(sel!) as HTMLMetaElement).content === want, [META, v], { timeout: 5000 });
    assert.equal(await content(d.page), BLACK, 'Orb Teal draws behind the status bar');
    // For every device: a light design keeps iOS's strip.
    assert.equal((await m.send('POST', '/api/v1/design-systems/companion-light/apply', { scope: 'user' })).status, 200);
    await waitFor('default');
    // This device only: its own dark design. The page corrects the tag at once, and the next launch's
    // page carries it as sent (the appearance cookie); a browser without the cookie gets the
    // person's design.
    assert.equal((await m.send('POST', '/api/v1/design-systems/obsidian/apply', { scope: 'device', device_id: d.id })).status, 200);
    await waitFor(BLACK);
    assert.match(tagOf(await (await d.page.request.get(`${m.base}/`)).text())[0] ?? '', /content="black-translucent"/, 'the next launch, as sent, for this device');
    assert.match(tagOf(await (await fetch(`${m.base}/`)).text())[0] ?? '', /content="default"/, 'another browser, as sent');
    // The mode: Paper, dark on purpose, then following the system (light here).
    assert.equal((await m.send('POST', '/api/v1/design-systems/paper/apply', { scope: 'device', device_id: d.id })).status, 200);
    assert.equal((await m.send('PUT', '/api/v1/profile/appearance/mode', { value: 'dark' })).status, 200);
    await waitFor(BLACK);
    assert.equal((await m.send('PUT', '/api/v1/profile/appearance/mode', { value: 'auto' })).status, 200);
    await waitFor('default');
    // And the system turning dark under auto.
    await d.page.emulateMedia({ colorScheme: 'dark' });
    await waitFor(BLACK);
    assert.equal(await d.page.evaluate(() => (window as unknown as { __boot: string }).__boot), 'first-load', 'no reload');
    assert.deepEqual(d.errors, []);
    await d.ctx.close();
  } finally {
    await c.close();
    await stop(nova);
  }
});

// Drawn behind the status bar, Nova's background reaches the top edge and its own top bar is
// pushed down by the inset exactly once (the shell's padding, PR #267); no control is in the inset.
test('behind the status bar: the background reaches the top edge, the top bar clears the inset once, no control under it', { timeout: 180_000 }, async (t) => {
  const c = await browser();
  if (typeof c === 'string') return t.skip(c);
  const m = blank('nova-ui-statusbar-inset-');
  const nova = await m.start();
  const bad: string[] = [];
  try {
    await finishSetup(m);
    const insets: [string, { width: number; height: number }, { top: number; bottom: number; left: number; right: number }][] = [
      ['iphone', { width: 390, height: 844 }, { top: 47, bottom: 34, left: 0, right: 0 }],
      ['iphone landscape', { width: 844, height: 390 }, { top: 0, bottom: 21, left: 47, right: 47 }],
      ['iphone 15 pro', { width: 393, height: 852 }, { top: 59, bottom: 34, left: 0, right: 0 }],
    ];
    for (const id of ['orb-teal', 'companion-light']) {
      await applyFor(m, id, 'auto');
      for (const [what, size, inset] of insets) {
        const d = await device(c, { ...size, scheme: 'light', touch: true, serviceWorkers: 'block' });
        const cdp = await d.ctx.newCDPSession(d.page);
        // Never passes by not running: a Chromium that can't report insets fails it.
        try { await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: inset } as never); } catch (e) { bad.push(`chromium ${what}: can't emulate safe-area insets (${(e as Error).message.split('\n')[0]})`); await d.ctx.close(); continue; }
        for (const view of ['/', '/chat', '/settings']) {
          await d.page.goto(`${m.base}${view}`);
          await ready(d.page);
          await d.page.waitForTimeout(300);
          const g = await d.page.evaluate((inset) => {
            const shell = getComputedStyle(document.querySelector('.shell')!);
            const bar = document.querySelector('.topbar')!.getBoundingClientRect();
            // What of each control shows: its box cut to every scrolling box it sits in (a rail or a
            // view scrolled past its end draws nothing outside its own box).
            const shown = (e: Element) => {
              const r = e.getBoundingClientRect();
              let [top, bottom, left, right] = [r.top, r.bottom, r.left, r.right];
              for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
                const cs = getComputedStyle(p);
                if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
                const c = p.getBoundingClientRect();
                [top, bottom, left, right] = [Math.max(top, c.top), Math.min(bottom, c.bottom), Math.max(left, c.left), Math.min(right, c.right)];
              }
              return { top, bottom, left, right };
            };
            const visible = (sel: string) => [...document.querySelectorAll(sel)].filter((e) => (e as HTMLElement).checkVisibility()).map(shown).filter((r) => r.bottom - r.top > 0 && r.right - r.left > 0);
            const under = inset.top > 0 ? document.elementFromPoint(innerWidth / 2, inset.top / 2) : null;
            return {
              padTop: parseFloat(shell.paddingTop), padLeft: parseFloat(shell.paddingLeft), padRight: parseFloat(shell.paddingRight),
              barTop: bar.height > 0 ? bar.top : null,
              htmlTop: document.documentElement.getBoundingClientRect().top, bodyTop: document.body.getBoundingClientRect().top,
              htmlBg: getComputedStyle(document.documentElement).backgroundColor,
              under: under ? `${under.tagName.toLowerCase()}${under.id ? `#${under.id}` : ''}.${[...under.classList].join('.')}` : null,
              controls: visible('#rail .nav-item, #rail .rail-home, #tabs .nav-item, #composer button, .topbar button, .topbar a, .settings-search, #main input'),
              vw: innerWidth, vh: innerHeight,
            };
          }, inset);
          console.log(`STATUSBAR inset ${id} ${what} ${view}: ${JSON.stringify({ padTop: g.padTop, barTop: g.barTop, under: g.under, controls: g.controls.length })}`);
          const at = `${id} ${what} ${view}`;
          if (Math.abs(g.padTop - inset.top) > 0.5) bad.push(`${at}: the shell keeps ${g.padTop}px clear at the top for a ${inset.top}px inset (want exactly once)`);
          if (g.barTop !== null && Math.abs(g.barTop - inset.top) > 0.5) bad.push(`${at}: the top bar starts at ${g.barTop}px, not right under the ${inset.top}px inset`);
          if (Math.abs(g.padLeft - inset.left) > 0.5 || Math.abs(g.padRight - inset.right) > 0.5) bad.push(`${at}: side padding ${g.padLeft}/${g.padRight} for insets ${inset.left}/${inset.right}`);
          if (g.htmlTop !== 0 || g.bodyTop !== 0) bad.push(`${at}: the page starts at ${g.htmlTop}/${g.bodyTop}px, not the top edge`);
          if (!g.htmlBg || g.htmlBg === 'rgba(0, 0, 0, 0)') bad.push(`${at}: nothing paints the top edge (html background ${g.htmlBg})`);
          // What sits in the status bar's band is the page's own background, never a control.
          if (g.under && !/^(html|body)\b|^div#app\.shell\b/.test(g.under)) bad.push(`${at}: ${g.under} sits under the status bar`);
          for (const r of g.controls) {
            if (r.top < inset.top - 0.5 || r.bottom > g.vh - inset.bottom + 0.5 || r.left < inset.left - 0.5 || r.right > g.vw - inset.right + 0.5) bad.push(`${at}: a control at ${JSON.stringify(r)} sits in the safe-area inset`);
          }
        }
        if (d.errors.length) bad.push(`${id} ${what}: page errors ${d.errors.join(' | ')}`);
        await d.ctx.close();
      }
    }
    assert.deepEqual(bad, [], 'behind the status bar');
  } finally {
    await c.close();
    await stop(nova);
  }
});
