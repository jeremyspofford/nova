// UI fixes gate (Amendment 2026-10-30-C Part 1; ROADMAP "UI fixes"): each of the six items in the
// real PWA, at a phone's width (390×844) and a desktop's (1280×820), in both starter packages.
//   1. the orb once per view;  2. chat in the AI-chat style;  3. timestamps;
//   4. Settings: one structure, two layouts, search;  5. Appearance applied live, with Undo,
//   Save, the scope, the live contrast check and one recommendation;  6. one scroller per view.
// Evidence screenshots go to NOVA_UI_SHOTS (docs/screenshots/ui-fixes for the evidence run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, cssVar, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 820 };
const SIZES = [['phone', PHONE], ['desktop', DESKTOP]] as const;
const STARTERS = ['orb-teal', 'companion-light'];
const ALL = ['home', 'chat', 'tasks', 'memory', 'automations', 'skills', 'activity', 'health', 'settings'];
const PATHS: Record<string, string> = { home: '/', chat: '/c/2026-10-28-garden', settings: '/settings' };

// A conversation over two days, written as Nova writes its logs: a tool step, a follow-up from Nova
// two minutes after its reply, a long gap, a code block and a table that are wider than the page.
const at = (hm: string, day = 28) => `2026-10-${day}T${hm}.000Z`;
const WIDE = 'x'.repeat(260);
const LOG = [
  { ts: at('09:00:00'), type: 'session', id: '2026-10-28-garden', title: 'Planning the garden', v: 1 },
  { ts: at('09:00:00'), type: 'user', turn: 't1', text: 'What should I plant first?' },
  { ts: at('09:00:03'), type: 'tool_call', turn: 't1', attempt: 0, id: 'c1', name: 'read_file', args: { path: 'notes/garden.md' } },
  { ts: at('09:00:05'), type: 'tool_result', turn: 't1', attempt: 0, id: 'c1', ok: true, output: Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') },
  { ts: at('09:00:09'), type: 'assistant', turn: 't1', attempt: 0, id: 'a1', text: `Start with the peas. They like the cool weather, and they put nitrogen back into the soil for whatever you plant after them, so the bed is better for the beans in summer and the squash after that. Sow them an inch deep and two inches apart.\n\n\`\`\`text\n${WIDE}\n\`\`\`\n\n| Bed | Spring | Summer | Autumn | Notes |\n| --- | --- | --- | --- | --- |\n| One | Peas | Beans | Garlic | ${'y'.repeat(200)} |` },
  { ts: at('09:00:10'), type: 'done', turn: 't1', attempt: 0 },
  { ts: at('09:02:00'), type: 'user', turn: 't2', text: '', followup: 'h1' },
  { ts: at('09:02:30'), type: 'assistant', turn: 't2', attempt: 0, id: 'a2', text: 'One more thing: water them in the morning.' },
  { ts: at('09:02:31'), type: 'done', turn: 't2', attempt: 0 },
  { ts: at('09:03:00'), type: 'user', turn: 't3', text: 'And after that?' },
  { ts: at('09:03:20'), type: 'assistant', turn: 't3', attempt: 0, id: 'a3', text: 'Beans, once the soil is warm.' },
  { ts: at('09:03:21'), type: 'done', turn: 't3', attempt: 0 },
  { ts: at('11:30:00'), type: 'user', turn: 't4', text: 'Thanks!' },
  { ts: at('11:30:05'), type: 'assistant', turn: 't4', attempt: 0, id: 'a4', text: 'Any time.' },
  { ts: at('11:30:06'), type: 'done', turn: 't4', attempt: 0 },
  { ts: at('08:00:00', 29), type: 'user', turn: 't5', text: 'Good morning' },
  { ts: at('08:00:04', 29), type: 'assistant', turn: 't5', attempt: 0, id: 'a5', text: 'Morning. The peas are up.' },
  { ts: at('08:00:05', 29), type: 'done', turn: 't5', attempt: 0 },
];

// A design a person could install: valid, so it applies, but its secondary text is hard to read on
// raised surfaces and its field outlines nearly vanish.
function misty() {
  const p = JSON.parse(readFileSync(new URL('../core/fixtures/design-system.json', import.meta.url), 'utf8'));
  Object.assign(p, { id: 'example.mist', name: 'Example Mist' });
  Object.assign(p.tokens, { 'border/strong': '#d3d7dc', 'bg/raised': '#d9dde3', 'accent/primary': '#234a8c', 'text/secondary': '#5f6872' });
  return p;
}

async function boot(prefix: string) {
  const m = blank(prefix);
  const nova = await m.start();
  await finishSetup(m);
  writeFileSync(join(m.home, 'sessions', '2026-10-28-garden.jsonl'), `${LOG.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return { m, nova };
}

const useDesign = async (m: ReturnType<typeof blank>, id: string) => {
  const r = await m.send('POST', `/api/v1/design-systems/${id}/apply`, { scope: 'user' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
const bgOf = async (m: ReturnType<typeof blank>, id: string) => String((await m.get(`/api/v1/design-systems/${id}`)).manifest.tokens['bg/base']).toLowerCase();
const showing = (page: Page, bg: string) => page.waitForFunction((want) => getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim().toLowerCase() === want, bg, { timeout: 5000 });

async function go(page: Page, dest: string) {
  await page.goto(`${(new URL(page.url())).origin}${PATHS[dest] ?? `/${dest}`}`);
  await ready(page);
  await page.waitForTimeout(150);
}

// ---- in the page: contrast of what is drawn ----------------------------------------------------

// The lowest contrast of each element's text against what is behind it: its nearest painted
// background, or, on the page itself, both ends of the page's gradient (bg/raised to bg/base).
function contrastOf(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const rgb = (s: string): number[] | null => {
      let m = /^rgba?\(([^)]+)\)/.exec(s);
      if (m) { const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]; }
      m = /^color\(srgb ([^)]+)\)/.exec(s);
      if (m) { const p = m[1]!.split(/[\s/]+/).filter(Boolean).map(Number); return [p[0]! * 255, p[1]! * 255, p[2]! * 255, p[3] ?? 1]; }
      return null;
    };
    const probe = (v: string) => { const p = document.createElement('i'); p.style.color = v; document.body.append(p); const c = rgb(getComputedStyle(p).color); p.remove(); return c!; };
    const over = (f: number[], b: number[]) => [0, 1, 2].map((i) => f[i]! * f[3]! + b[i]! * (1 - f[3]!)).concat(1);
    const lum = (c: number[]) => { const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!); };
    const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
    const root = getComputedStyle(document.documentElement);
    const base = probe(root.getPropertyValue('--bg-base'));
    const raised = over(probe(root.getPropertyValue('--bg-raised')), base);
    const behind = (el: Element) => {
      for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor);
        if (c && c[3]! > 0) return [over(c, base)];
      }
      return [base, raised];
    };
    return [...document.querySelectorAll(sel)].filter((e) => (e as HTMLElement).checkVisibility() && e.getBoundingClientRect().width > 4).map((e) => {
      const fg = rgb(getComputedStyle(e).color)!;
      const r = Math.min(...behind(e).map((b) => ratio(fg[3]! < 1 ? over(fg, b) : fg, b)));
      return { text: (e.textContent ?? '').trim().slice(0, 40), ratio: Math.round(r * 100) / 100 };
    });
  }, selector);
}

// The scope line follows a change within moments (the CSS swaps first, then the state arrives).
async function scopeSays(page: Page, re: RegExp, what: string) {
  const ok = await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('appearance-scope')?.textContent ?? ''), re.source, { timeout: 3000 }).then(() => true, () => false);
  assert.ok(ok, `${what}: “${await page.locator('#appearance-scope').textContent()}”`);
}

const visibleOrbs = (page: Page) => page.$$eval('.orb', (els) => els.filter((e) => (e as HTMLElement).checkVisibility() && e.getBoundingClientRect().width > 0).length);

// ---- 1, 2, 3: the orb, chat, timestamps ------------------------------------------------------------

test('UI fixes 1–3: the orb once per view; chat in the AI-chat style; grouped, readable timestamps', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await boot('nova-ui-fixes-chat-');
  const shots = shotsDir();
  try {
    for (const design of STARTERS) {
      await useDesign(m, design);
      for (const [size, vp] of SIZES) {
        const where = `${design}, ${size}`;
        const d = await device(b, { ...vp, timezone: 'UTC' });
        await d.page.goto(`${m.base}/`);
        await ready(d.page);
        await showing(d.page, await bgOf(m, design));

        // 1. Every destination shows the orb exactly once.
        for (const dest of ALL) {
          await go(d.page, dest);
          if (dest === 'home') await d.page.waitForFunction(() => [...document.querySelectorAll('.orb')].some((o) => (o as HTMLElement).checkVisibility()), null, { timeout: 5000 }).catch(() => {});
          assert.equal(await visibleOrbs(d.page), 1, `${where}: ${dest} shows the orb once`);
        }

        // 2. The conversation.
        await go(d.page, 'chat');
        await d.page.locator('.msg-nova').first().waitFor();
        assert.equal(await d.page.locator('#thread .orb, #thread .msg-avatar').count(), 0, `${where}: no orb or avatar on a message`);
        const shape = await d.page.evaluate(() => {
          const thread = document.getElementById('thread')!;
          const cs = getComputedStyle(thread);
          const inner = { left: thread.getBoundingClientRect().left + parseFloat(cs.paddingLeft), right: thread.getBoundingClientRect().right - parseFloat(cs.paddingRight) };
          const bubble = document.querySelector('.msg-user .bubble')!;
          const bs = getComputedStyle(bubble);
          const nova = document.querySelector('.msg-nova')!;
          const prose = nova.querySelector('.prose')!;
          const ps = getComputedStyle(prose);
          const ch = (() => { const s = document.createElement('span'); s.textContent = '0'.repeat(100); s.style.font = ps.font; s.style.position = 'absolute'; prose.append(s); const w = s.getBoundingClientRect().width / 100; s.remove(); return w; })();
          // From the end of one turn's reply to the next turn's first message, and from your
          // message to Nova's reply inside a turn.
          const [first, second] = [...document.querySelectorAll('.turn')];
          const user = first!.querySelector('.msg-user')!.getBoundingClientRect();
          const reply = first!.querySelector('.msg-nova')!.getBoundingClientRect();
          const next = second!.querySelector('.msg')!.getBoundingClientRect();
          return {
            bubbleBg: bs.backgroundColor, radii: [bs.borderTopLeftRadius, bs.borderTopRightRadius, bs.borderBottomRightRadius, bs.borderBottomLeftRadius],
            bubbleRight: bubble.getBoundingClientRect().right, bubbleLeft: bubble.getBoundingClientRect().left, inner,
            novaLeft: nova.getBoundingClientRect().left, novaWidth: nova.getBoundingClientRect().width,
            proseBg: ps.backgroundColor, proseBorder: ps.borderTopWidth, proseWidth: prose.getBoundingClientRect().width, ch,
            between: next.top - reply.bottom, within: reply.top - user.bottom,
          };
        });
        assert.doesNotMatch(shape.bubbleBg, /rgba\(0, 0, 0, 0\)|transparent/, `${where}: your turn is a tinted bubble`);
        assert.equal(new Set(shape.radii).size, 1, `${where}: no tail: every corner of your bubble is the same (${shape.radii})`);
        assert.ok(Math.abs(shape.bubbleRight - shape.inner.right) <= 2, `${where}: your bubble sits on the right`);
        assert.ok(shape.bubbleLeft > shape.inner.left + 20, `${where}: and doesn’t fill the row`);
        assert.ok(Math.abs(shape.novaLeft - shape.inner.left) <= 2, `${where}: Nova’s turn starts at the left edge`);
        assert.ok(shape.novaWidth >= shape.inner.right - shape.inner.left - 2, `${where}: Nova’s turn is full width`);
        assert.match(shape.proseBg, /rgba\(0, 0, 0, 0\)|transparent/, `${where}: Nova’s words have no bubble`);
        assert.equal(shape.proseBorder, '0px', `${where}: and no box`);
        assert.ok(shape.proseWidth <= 76 * shape.ch, `${where}: Nova’s prose keeps a readable measure (${Math.round(shape.proseWidth / shape.ch)}ch)`);
        assert.ok(shape.between >= 2 * shape.within && shape.between >= 24, `${where}: turns stand apart (${shape.between}px between, ${shape.within}px within)`);

        // 3. Timestamps: a divider per day and for the long gap; the time on each group’s first message.
        assert.equal(await d.page.locator('#thread .dateline').count(), 2, `${where}: a date divider per day`);
        assert.deepEqual(await d.page.locator('#thread .gap-divider').allTextContents(), ['11:30 AM'], `${where}: a divider for the long gap`);
        const leads = await d.page.$$eval('.when.is-lead .when-short', (els) => els.filter((e) => (e as HTMLElement).checkVisibility()).map((e) => e.textContent));
        assert.deepEqual(leads, ['9:00 AM', '9:00 AM', '9:03 AM', '9:03 AM', '11:30 AM', '11:30 AM', '8:00 AM', '8:00 AM'], `${where}: the time on each group’s first message`);
        // Nova’s follow-up joins its group: no time on show, but its exact time is a hover, a tap
        // or a focus away.
        const follow = d.page.locator('.msg-nova:has(time[datetime="2026-10-28T09:02:30.000Z"])');
        const exact = follow.locator('.when-exact');
        const shown = () => exact.evaluate((e) => e.getBoundingClientRect().width > 20 && getComputedStyle(e).opacity !== '0');
        assert.equal(await shown(), false, `${where}: the follow-up’s time isn’t on show`);
        await follow.locator('.prose').hover();
        assert.equal(await shown(), true, `${where}: hover shows the exact time`);
        assert.match((await exact.textContent()) ?? '', /October 28, 2026, 9:02:30 AM/);
        await d.page.mouse.move(0, 0);
        await follow.locator('time.when').focus();
        assert.equal(await shown(), true, `${where}: keyboard focus shows it`);
        await d.page.locator('#input').focus();
        // Work trail: how long a step took and when it finished.
        assert.match((await d.page.locator('.record[data-tool="c1"] .record-time').textContent()) ?? '', /took 2 s, finished 9:00 AM/);
        // Contrast: every timestamp on screen at 4.5:1 against what is behind it.
        await d.page.evaluate(() => document.querySelectorAll('.msg').forEach((x) => x.classList.add('show-time')));
        const stamps = await contrastOf(d.page, '.when-short, .when-exact, .gap-divider, .dateline, .record-time');
        assert.ok(stamps.length >= 10, `${where}: timestamps were measured`);
        for (const s of stamps) assert.ok(s.ratio >= 4.5, `${where}: “${s.text}” is ${s.ratio}:1`);
        await d.page.evaluate(() => document.querySelectorAll('.msg').forEach((x) => x.classList.remove('show-time')));
        if (shots) {
          await d.page.evaluate(() => { document.getElementById('scroller')!.scrollTop = 0; });
          await shoot(d.page, join(shots, `chat-${size}-${design}.png`));
        }
        assert.deepEqual(d.errors, [], `${where}: no errors in the page`);
        await d.ctx.close();
      }
    }

    // On a phone you tap: a tap (or a long press) shows a message’s exact time.
    const touch = await device(b, { ...PHONE, touch: true, timezone: 'UTC' });
    await touch.page.goto(`${m.base}${PATHS.chat}`);
    await ready(touch.page);
    const follow = touch.page.locator('.msg-nova:has(time[datetime="2026-10-28T09:02:30.000Z"])');
    await follow.scrollIntoViewIfNeeded();
    const exact = follow.locator('.when-exact');
    assert.equal(await exact.evaluate((e) => e.getBoundingClientRect().width > 20), false);
    await follow.locator('.prose').tap();
    // The tap itself, not the hover a tap also gives, shows it.
    assert.equal(await follow.evaluate((e) => e.classList.contains('show-time')), true, 'a tap shows the exact time');
    assert.equal(await exact.evaluate((e) => e.getBoundingClientRect().width > 20 && getComputedStyle(e).opacity !== '0'), true, 'and it is on screen');
    if (shots) await shoot(touch.page, join(shots, 'chat-phone-tapped-time.png'));
    assert.deepEqual(touch.errors, []);
    await touch.ctx.close();
  } finally {
    await b.close();
    await stop(nova);
  }
});

// ---- 4: Settings ------------------------------------------------------------------------------------

test('UI fixes 4: Settings is one structure in two layouts, with a search that knows people’s words', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await boot('nova-ui-fixes-settings-');
  const shots = shotsDir();
  try {
    const cats: Record<string, string[]> = {};
    for (const design of STARTERS) {
      await useDesign(m, design);
      for (const [size, vp] of SIZES) {
        const where = `${design}, ${size}`;
        const d = await device(b, vp);
        await d.page.goto(`${m.base}/settings`);
        await ready(d.page);
        await d.page.locator('#settings-nav .settings-cat').first().waitFor();
        const nav = d.page.locator('#settings-nav');
        cats[where] = await nav.locator('.settings-cat .cat-label').allTextContents();
        assert.ok(await d.page.locator('#settings-search').isVisible(), `${where}: search is there`);
        assert.ok((await nav.locator('.settings-group-title').count()) >= 2, `${where}: a grouped list`);
        // One level: a category opens its page; nothing inside opens another.
        if (size === 'phone') {
          assert.ok(await nav.isVisible(), `${where}: the phone starts on the grouped list`);
          assert.equal(await d.page.locator('.settings-pane:not([hidden])').count(), 0, `${where}: no page open yet`);
          if (shots && design === 'orb-teal') await shoot(d.page, join(shots, 'settings-phone-list.png'));
          await nav.locator('.settings-cat[data-cat="appearance"]').click();
          await d.page.locator('#appearance').waitFor();
          assert.equal(await nav.isVisible(), false, `${where}: the page replaces the list`);
          assert.ok(await d.page.locator('#settings-back').isVisible(), `${where}: with a way back`);
          await d.page.click('#settings-back');
          await nav.waitFor();
          assert.ok(await nav.isVisible(), `${where}: back to the list`);
        } else {
          const box = { nav: await nav.boundingBox(), detail: await d.page.locator('.settings-detail').boundingBox() };
          assert.ok(box.nav && box.detail && box.nav.x + box.nav.width <= box.detail.x, `${where}: a sidebar beside the detail`);
          assert.equal(await d.page.locator('.settings-pane:not([hidden])').count(), 1, `${where}: one category at a time`);
          assert.equal(await nav.locator('[aria-current="page"]').getAttribute('data-cat'), 'you', `${where}: the first category is open`);
          await nav.locator('.settings-cat[data-cat="devices"]').click();
          await d.page.locator('#devices').waitFor();
          assert.equal(await nav.locator('[aria-current="page"]').getAttribute('data-cat'), 'devices');
          assert.equal(await nav.evaluate((e) => getComputedStyle(e).overflowY), 'visible', `${where}: the sidebar doesn’t scroll on its own`);
          if (shots && design === 'orb-teal') await shoot(d.page, join(shots, 'settings-desktop.png'));
        }
        assert.equal(await d.page.locator('.settings-detail #settings-nav, .settings-pane .settings-cat').count(), 0, `${where}: no second level`);

        // Search: synonyms, the path, and a jump that highlights the control.
        for (const [q, path] of [['theme', 'Appearance › Theme'], ['dark mode', 'Appearance › Light and dark'], ['colours', 'Appearance'], ['phone', 'Devices'], ['pair', 'Devices']] as const) {
          await d.page.fill('#settings-search', q);
          const first = d.page.locator('#settings-results .settings-result').first();
          await first.waitFor();
          assert.match((await first.locator('.result-path').textContent()) ?? '', new RegExp(`^${path.replace(/[›]/g, '\\$&')}`), `${where}: “${q}” finds ${path}`);
        }
        await d.page.fill('#settings-search', 'dark mode');
        if (shots && design === 'orb-teal') await shoot(d.page, join(shots, `settings-${size}-search.png`));
        await d.page.locator('#settings-results .settings-result').first().click();
        const target = d.page.locator('#appearance-mode');
        await target.waitFor();
        await d.page.waitForFunction(() => document.getElementById('appearance-mode')?.classList.contains('is-found'));
        assert.ok(await target.evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), `${where}: the setting is on screen`);
        assert.ok(await target.evaluate((e) => e.contains(document.activeElement)), `${where}: and has focus`);
        assert.equal(await d.page.inputValue('#settings-search'), '', `${where}: the search clears`);
        // Deep links keep working.
        await d.page.goto(`${m.base}/settings#devices`);
        await ready(d.page);
        await d.page.locator('#devices').waitFor({ state: 'visible' });
        assert.deepEqual(d.errors, [], `${where}: no errors in the page`);
        await d.ctx.close();
      }
    }
    const lists = Object.values(cats);
    for (const l of lists) assert.deepEqual(l, lists[0], 'the same categories, in the same order, at every width and in every design');
  } finally {
    await b.close();
    await stop(nova);
  }
});

// ---- 5: Appearance -----------------------------------------------------------------------------------

test('UI fixes 5: Appearance applies live, Undo for this device, Save for all, the scope, a contrast check, one recommendation', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await boot('nova-ui-fixes-look-');
  const shots = shotsDir();
  try {
    const bg = { teal: await bgOf(m, 'orb-teal'), light: await bgOf(m, 'companion-light'), paper: await bgOf(m, 'paper') };
    for (const [size, vp] of SIZES) {
      for (const design of STARTERS) {
        await useDesign(m, design);
        const where = `${design}, ${size}`;
        const d = await device(b, vp);
        const other = await device(b, vp);
        await other.page.goto(`${m.base}/`);
        await ready(other.page);
        await d.page.goto(`${m.base}/settings#appearance`);
        await ready(d.page);
        const look = d.page.locator('#appearance');
        await look.locator('.ds-card').first().waitFor();
        const start = design === 'orb-teal' ? bg.teal : bg.light;
        await showing(d.page, start);

        // The embedded preview is gone; swatches stay, as thumbnails on the picker.
        assert.equal(await d.page.locator('#settings-view iframe').count(), 0, `${where}: no preview frame`);
        assert.ok((await look.locator('.ds-card .ds-chips').count()) >= 6, `${where}: each design has its swatch thumbnail`);
        // One recommendation, with a reason; the rest are secondary.
        assert.equal(await look.locator('.ds-recommended .ds-card').count(), 1, `${where}: one recommended design`);
        assert.equal(await look.locator('.ds-recommended .ds-card').getAttribute('data-ds'), 'orb-teal', `${where}: Orb Teal leads even on a light system`);
        assert.match((await look.locator('.ds-reason').textContent()) ?? '', /lead design.*contrast/i, `${where}: with its reason`);
        assert.ok(await look.locator('.ds-others .ds-card').count() >= 5, `${where}: the others listed below it`);
        const sizeOf = (sel: string) => look.locator(sel).first().evaluate((e) => e.getBoundingClientRect().height);
        assert.ok(await sizeOf('.ds-recommended .ds-card') > await sizeOf('.ds-others .ds-card'), `${where}: the others are secondary`);
        // The scope, always on show.
        assert.match((await look.locator('#appearance-scope').textContent()) ?? '', /synced/, `${where}: synced to begin with`);
        // The contrast check passes for a starter.
        assert.equal(await look.locator('#contrast-check').getAttribute('data-ok'), 'true', `${where}: ${design} passes the live check`);

        // This device: applies at once, with a visible Undo; nothing else changes.
        assert.equal(await look.locator('input[name="ds-scope"][value="device"]').isChecked(), true, `${where}: this device is the default`);
        await look.locator('.ds-card[data-ds="paper"]').click();
        await showing(d.page, bg.paper);
        await scopeSays(d.page, /Paper.*this device only/, `${where}: the scope says so`);
        const undo = look.locator('[data-action="undo-ds"]');
        await undo.waitFor({ timeout: 2000 }).catch(() => {});
        assert.ok(await undo.isVisible(), `${where}: Undo is right there`);
        assert.equal(await cssVar(other.page, '--bg-base'), start, `${where}: another device is untouched`);
        if (shots && design === 'orb-teal') { await d.page.evaluate(() => document.getElementById('appearance-scope')!.scrollIntoView({ block: 'start' })); await shoot(d.page, join(shots, `appearance-${size}-undo.png`)); }
        await undo.click();
        await showing(d.page, start);

        // All devices: shows here at once, and nothing is kept until Save.
        await look.locator('label.choice:has(input[name="ds-scope"][value="user"])').click();
        await d.page.waitForFunction(() => (document.querySelector('input[name="ds-scope"][value="user"]') as HTMLInputElement)?.checked);
        await look.locator('.ds-card[data-ds="paper"]').click();
        await showing(d.page, bg.paper);
        const save = look.locator('[data-action="save-ds"]');
        await save.waitFor({ timeout: 2000 }).catch(() => {});
        assert.ok(await save.isVisible(), `${where}: Save is offered`);
        assert.equal((await m.get('/api/v1/design-systems/active')).id, design, `${where}: nothing is saved yet`);
        await other.page.waitForTimeout(200);
        assert.equal(await cssVar(other.page, '--bg-base'), start, `${where}: so other devices don’t change`);
        if (shots && design === 'orb-teal') { await d.page.evaluate(() => document.getElementById('appearance-scope')!.scrollIntoView({ block: 'start' })); await shoot(d.page, join(shots, `appearance-${size}-save.png`)); }
        await save.click();
        await showing(other.page, bg.paper);
        assert.equal((await m.get('/api/v1/design-systems/active')).id, 'paper', `${where}: saved for every device`);
        await scopeSays(d.page, /Paper.*synced/, `${where}: and is synced`);
        assert.deepEqual([...d.errors, ...other.errors], [], `${where}: no errors in the page`);
        await d.ctx.close();
        await other.ctx.close();
      }

      // The live check: a design that is hard to read warns, and one tap fixes it on this device.
      const d = await device(b, vp);
      if ((await m.get('/api/v1/design-systems')).every((x: { id: string }) => x.id !== 'example.mist')) {
        assert.equal((await m.send('POST', '/api/v1/design-systems', { manifest: misty() })).status, 201);
        assert.equal((await m.send('POST', '/api/v1/extensions/example.mist/enable')).status, 200);
      }
      await d.page.goto(`${m.base}/settings#appearance`);
      await ready(d.page);
      const look = d.page.locator('#appearance');
      await look.locator('.ds-card[data-ds="example.mist"]').click();
      const check = look.locator('#contrast-check');
      await d.page.waitForFunction(() => document.getElementById('contrast-check')?.dataset.ok === 'false');
      const warning = (await check.textContent()) ?? '';
      assert.match(warning, /4\.15:1/, `${size}: names the body text that is too faint`);
      assert.match(warning, /4\.5:1/);
      assert.match(warning, /Outlines.*3:1/, `${size}: and the outlines`);
      if (shots) { await d.page.evaluate(() => document.getElementById('contrast-check')!.scrollIntoView({ block: 'center' })); await shoot(d.page, join(shots, `appearance-${size}-contrast-warning.png`)); }
      const before = await cssVar(d.page, '--border-strong');
      await check.locator('[data-action="fix-contrast"]').click();
      await d.page.waitForFunction(() => document.getElementById('contrast-check')?.dataset.ok === 'true');
      assert.notEqual(await cssVar(d.page, '--border-strong'), before, `${size}: the outline colour moved`);
      assert.ok(await check.locator('[data-action="undo-fix"]').isVisible(), `${size}: the fix can be undone`);
      if (shots) { await d.page.evaluate(() => document.getElementById('contrast-check')!.scrollIntoView({ block: 'center' })); await shoot(d.page, join(shots, `appearance-${size}-contrast-fixed.png`)); }
      await check.locator('[data-action="undo-fix"]').click();
      await d.page.waitForFunction(() => document.getElementById('contrast-check')?.dataset.ok === 'false');
      await m.send('POST', '/api/v1/design-systems/rollback', { scope: 'device', device_id: d.id });
      assert.deepEqual(d.errors, [], `${size}: no errors in the page`);
      await d.ctx.close();
    }
    // A dark system gets the dark starter.
    const dark = await device(b, { ...DESKTOP, scheme: 'dark' });
    await dark.page.goto(`${m.base}/settings#appearance`);
    await ready(dark.page);
    await dark.page.locator('.ds-recommended .ds-card').waitFor();
    assert.equal(await dark.page.locator('.ds-recommended .ds-card').getAttribute('data-ds'), 'orb-teal');
    await dark.ctx.close();
  } finally {
    await b.close();
    await stop(nova);
  }
});

// ---- 6: scrolling ------------------------------------------------------------------------------------

test('UI fixes 6: one scroll container per view, the OS scrollbar, a stable gutter', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await boot('nova-ui-fixes-scroll-');
  try {
    for (const design of STARTERS) {
      await useDesign(m, design);
      for (const [size, vp] of SIZES) {
        const d = await device(b, vp);
        await d.page.goto(`${m.base}/`);
        await ready(d.page);
        for (const dest of ALL) {
          const where = `${design}, ${size}, ${dest}`;
          await go(d.page, dest);
          if (dest === 'chat') {
            await d.page.locator('.record[data-tool="c1"]').waitFor();
            // The oldest turn, with the wide code and table, laid out (older turns are skipped
            // while off screen).
            await d.page.evaluate(() => { for (const x of document.querySelectorAll('details')) (x as HTMLDetailsElement).open = true; document.getElementById('scroller')!.scrollTop = 0; });
            await d.page.waitForTimeout(100);
          }
          const found = await d.page.evaluate(() => {
            const scroller = document.getElementById('scroller')!;
            const all = [...document.querySelectorAll('body *')].filter((e) => (e as HTMLElement).checkVisibility() && !e.closest('dialog:not([open])') && e.tagName !== 'TEXTAREA');
            const vertical = (e: Element) => ['auto', 'scroll'].includes(getComputedStyle(e).overflowY);
            return {
              inner: all.filter((e) => scroller.contains(e) && e !== scroller && vertical(e)).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`),
              scrolling: all.filter((e) => vertical(e) && e.scrollHeight > e.clientHeight + 1).map((e) => e.id || e.className.toString()),
              gutter: getComputedStyle(scroller).scrollbarGutter,
              width: getComputedStyle(scroller).scrollbarWidth,
              custom: [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules].map((r) => r.cssText); } catch { return []; } }).filter((c) => /scrollbar-(width|color)|::-webkit-scrollbar/.test(c)),
              wide: [...scroller.querySelectorAll('.code-block pre, .table-wrap')].filter((e) => e.scrollWidth > e.clientWidth).map((e) => getComputedStyle(e).overflowY),
              boxes: [...scroller.querySelectorAll('.code-block pre, .table-wrap')].map((e) => `${e.className || e.tagName}:${e.scrollWidth}/${e.clientWidth}`),
            };
          });
          assert.deepEqual(found.inner, [], `${where}: nothing inside the view scrolls up and down`);
          assert.ok(found.scrolling.every((x) => x === 'scroller'), `${where}: only the view scrolls (${found.scrolling})`);
          assert.match(found.gutter, /^stable/, `${where}: scrollbar-gutter: stable`);
          assert.equal(found.width, 'auto', `${where}: the OS scrollbar`);
          assert.deepEqual(found.custom, [], `${where}: no custom scrollbar rules`);
          if (dest === 'chat') {
            assert.ok(found.wide.length >= 2, `${where}: the wide code and table scroll sideways (${found.boxes})`);
            assert.ok(found.wide.every((y) => y === 'hidden'), `${where}: and only sideways`);
          }
        }
        assert.deepEqual(d.errors, [], `${design}, ${size}: no errors in the page`);
        await d.ctx.close();
      }
    }
  } finally {
    await b.close();
    await stop(nova);
  }
});
