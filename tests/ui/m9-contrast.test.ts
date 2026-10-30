// M9 gate, contrast (Amendment 2026-10-30-C Part 2; UX-RESEARCH §7): every theme in every state at
// WCAG AA. Part 1 checks the token pairs (src/core/design.ts LIVE_CHECKS) and every time on screen;
// this measures what is actually drawn, in each built-in design and each look it has, on the main
// views, in each state a control is drawn in:
//   at rest · hovered · focused (keyboard) · selected · disabled · error and warning · placeholder.
// Text is held to 4.5:1 (3:1 when large: 24 px, or 18.66 px bold); an icon that is the whole label
// of a button, and a focus indicator against what is next to it, to 3:1 (WCAG 1.4.3, 1.4.11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { browser, device, still } from './support.ts';
import { CONTROLS, DESKTOP, VIEWS, seeded, settled } from './m9-support.ts';

// In the page: the colour actually seen, for text and for what is behind it.
function measures() {
  type C = number[];
  const rgb = (s: string): C | null => {
    let m = /^rgba?\(([^)]+)\)/.exec(s);
    if (m) { const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]; }
    m = /^color\(srgb ([^)]+)\)/.exec(s);
    if (m) { const p = m[1]!.split(/[\s/]+/).filter(Boolean).map(Number); return [p[0]! * 255, p[1]! * 255, p[2]! * 255, p[3] ?? 1]; }
    return null;
  };
  const probe = (v: string) => { const p = document.createElement('i'); p.style.color = v; document.body.append(p); const c = rgb(getComputedStyle(p).color); p.remove(); return c!; };
  const over = (f: C, b: C): C => [0, 1, 2].map((i) => f[i]! * f[3]! + b[i]! * (1 - f[3]!)).concat(1);
  const lum = (c: C) => { const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!); };
  const ratio = (a: C, b: C) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
  const page = () => {
    const root = getComputedStyle(document.documentElement);
    const base = probe(root.getPropertyValue('--bg-base'));
    return [base, over(probe(root.getPropertyValue('--bg-raised')), base)];
  };
  // How opaque an element is, all its ancestors' opacity included.
  const opacity = (el: Element | null) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  // What is painted behind an element: every background under it, each at its own opacity, down to
  // the page (both ends of the page's gradient, so the worse one counts).
  const behind = (el: Element): C[] => {
    const layers: [C, number][] = [];
    for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
      const c = rgb(getComputedStyle(e).backgroundColor);
      if (c && c[3]! > 0) layers.push([c, opacity(e)]);
      if (c && c[3] === 1 && opacity(e) === 1) break;
    }
    return page().map((p) => layers.reverse().reduce((b, [c, o]) => over([c[0]!, c[1]!, c[2]!, c[3]! * o], b), p));
  };
  const seen = (fg: C, el: Element, bgs: C[]) => Math.min(...bgs.map((b) => ratio(over([fg[0]!, fg[1]!, fg[2]!, fg[3]! * opacity(el)], b), b)));
  const large = (cs: CSSStyleDeclaration) => { const px = Number.parseFloat(cs.fontSize); return px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700); };
  const shown = (e: Element) => (e as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) && e.getBoundingClientRect().width > 4 && !e.closest('[aria-hidden="true"], .sr-only, [inert]') && getComputedStyle(e).clipPath !== 'inset(50%)';
  const label = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${[...e.classList].slice(0, 3).map((c) => `.${c}`).join('')} “${(e.textContent ?? e.getAttribute('aria-label') ?? '').trim().replace(/\s+/g, ' ').slice(0, 32)}”`;
  // Every element on screen that holds text of its own, under `root`.
  const texts = (root: Element) => [...root.querySelectorAll('*')].filter((e) => [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim()) && shown(e) && !['SCRIPT', 'STYLE', 'OPTION'].includes(e.tagName));
  (window as any).__c = {
    // Text in `root` that reads below its minimum: [what, ratio, minimum].
    text(root: Element = document.body) {
      return texts(root).map((e) => {
        const cs = getComputedStyle(e);
        const min = large(cs) ? 3 : 4.5;
        const r = seen(rgb(cs.color)!, e, behind(e));
        return [label(e), Math.round(r * 100) / 100, min] as const;
      }).filter(([, r, min]) => r < min);
    },
    count(root: Element = document.body) { return texts(root).length; },
    // Placeholder text of empty fields.
    placeholders() {
      return [...document.querySelectorAll('input[placeholder], textarea[placeholder]')].filter((e) => shown(e) && !(e as HTMLInputElement).value).map((e) => {
        const r = seen(rgb(getComputedStyle(e, '::placeholder').color)!, e, behind(e));
        return [label(e), Math.round(r * 100) / 100, 4.5] as const;
      });
    },
    // A button whose whole label is an icon: the icon at 3:1.
    icons() {
      return [...document.querySelectorAll('button, a[href]')].filter((e) => shown(e) && e.querySelector('svg') && !(e.textContent ?? '').trim()).map((e) => {
        const svg = e.querySelector('svg')!;
        const r = seen(rgb(getComputedStyle(svg).color)!, e, behind(e));
        return [`${label(e)}${(e as HTMLButtonElement).disabled ? ' (disabled)' : ''}`, Math.round(r * 100) / 100, 3] as const;
      });
    },
    // The focused element's indicator, against what is next to it: what changed when it took focus.
    indicator(before: Record<string, string>[]) {
      const el = document.activeElement as HTMLElement;
      const cands = this.candidates(el);
      const now = cands.map((c) => this.ring(c));
      for (let i = 0; i < cands.length; i++) {
        // A control drawn by something else (a radio inside its choice) shows focus there.
        if (opacity(cands[i]!) === 0 || cands[i]!.getBoundingClientRect().width < 4) continue;
        const a = before[i]!;
        const b = now[i]!;
        const changed = Object.keys(b).find((k) => b[k] !== a[k] && b[k] !== 'none');
        if (!changed) continue;
        const color = /outline/.test(changed) ? b.outline! : /border/.test(changed) ? b.border! : b.shadow!;
        const c = rgb(color.match(/(rgba?\([^)]*\)|color\([^)]*\))/)?.[1] ?? color);
        if (!c) continue;
        const next = cands[i]!.parentElement ?? cands[i]!;
        return [label(el), Math.round(seen(c, cands[i]!, behind(next)) * 100) / 100, 3] as const;
      }
      return [label(el), 0, 3] as const;
    },
    candidates(el: HTMLElement) {
      const c: Element[] = [el];
      if (el instanceof HTMLInputElement && el.labels?.length) c.push(el.labels[0]!);
      if (el.parentElement) c.push(el.parentElement);
      if (el.parentElement?.parentElement) c.push(el.parentElement.parentElement);
      const exact = el.querySelector('.when-exact');
      if (exact) c.push(exact);
      return c;
    },
    ring(e: Element) {
      const cs = getComputedStyle(e);
      return { outline: cs.outlineStyle === 'none' || cs.outlineWidth === '0px' ? 'none' : cs.outlineColor, border: cs.borderTopStyle === 'none' ? 'none' : cs.borderTopColor, shadow: cs.boxShadow };
    },
    before() { return this.candidates(document.activeElement as HTMLElement).map((c) => this.ring(c)); },
  };
}

type Row = readonly [string, number, number];

// One look of one design: the main views, each state.
async function audit(page: Page, base: string, look: string) {
  const fails: string[] = [];
  const states: Record<string, number> = { rest: 0, hover: 0, focus: 0, selected: 0, disabled: 0, error: 0, placeholder: 0, icon: 0 };
  const add = (state: string, rows: readonly Row[], where: string) => {
    for (const [what, r, min] of rows) if (r < min) fails.push(`${look} · ${where} · ${state}: ${what} ${r}:1 (needs ${min}:1)`);
  };
  const states_ = async () => page.evaluate(() => ({
    selected: document.querySelectorAll('[aria-current="page"], [aria-pressed="true"], [aria-selected="true"], [aria-checked="true"], .choice:has(input:checked)').length,
    disabled: [...document.querySelectorAll('button:disabled, input:disabled, select:disabled')].filter((e) => (e as HTMLElement).checkVisibility()).length,
    error: [...document.querySelectorAll('.error, .is-warn, .act-problem, [data-status="failed"], [data-status="needs-you"], .danger')].filter((e) => (e as HTMLElement).checkVisibility()).length,
  }));
  const views: [string, string, (() => Promise<void>)?][] = [
    ['home', VIEWS.home!],
    ['chat', VIEWS.chat!],
    ['tasks', VIEWS.tasks!],
    ['memory', VIEWS.memory!],
    ['settings', VIEWS.settings!, async () => { await page.fill('#settings-search', 'theme'); await page.press('#settings-search', 'ArrowDown'); }],
    ['settings › appearance', '/settings#appearance'],
    ['settings › privacy', '/settings#privacy'],
    ['settings › backups', '/settings#backups'],
  ];
  for (const [where, path, set] of views) {
    await page.goto('about:blank');
    await page.goto(`${base}${path}`);
    await settled(page, where.startsWith('settings') ? 'settings' : where);
    await page.waitForTimeout(300);
    if (set) await set();
    await still(page);
    const rest = await page.evaluate(() => (window as any).__c.text());
    add('at rest', rest, where);
    states.rest += await page.evaluate(() => (window as any).__c.count());
    const s = await states_();
    states.selected += s.selected;
    states.disabled += s.disabled;
    states.error += s.error;
    const ph = await page.evaluate(() => (window as any).__c.placeholders());
    states.placeholder += ph.length;
    add('placeholder', ph, where);
    const ic = await page.evaluate(() => (window as any).__c.icons());
    states.icon += ic.length;
    add('icon', ic, where);

    // Hover: one of each kind of control.
    const kinds = await page.$$eval(CONTROLS, (els) => {
      const seen = new Map<string, number>();
      els.forEach((e, i) => {
        const k = `${e.tagName}.${[...e.classList].sort().join('.')}`;
        if (!seen.has(k) && (e as HTMLElement).checkVisibility() && !(e as HTMLElement).closest('[inert]') && e.getBoundingClientRect().width > 4) seen.set(k, i);
      });
      return [...seen.values()];
    });
    for (const i of kinds) {
      const el = page.locator(CONTROLS).nth(i);
      try { await el.hover({ timeout: 1000 }); } catch { continue; }
      await still(page);
      const rows = await el.evaluate((e) => (window as any).__c.text(e));
      states.hover++;
      add('hover', rows, where);
    }
    await page.mouse.move(0, 0);

    // Focus: the keyboard through the view.
    await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const ok = await page.evaluate(() => { const a = document.activeElement; return !!a && a !== document.body && (a as HTMLElement).checkVisibility() && a.matches(':focus-visible'); });
      if (!ok) continue;
      // What the indicator looks like unfocused, then focused again from the keyboard.
      const before = await page.evaluate(() => { const c = (window as any).__c; const a = document.activeElement as HTMLElement; a.blur(); const b = c.candidates(a).map((x: Element) => c.ring(x)); (window as any).__last = a; return b; });
      await page.evaluate(() => (window as any).__last.focus());
      await still(page);
      const rows = await page.evaluate((b) => { const c = (window as any).__c; return [c.indicator(b), ...c.text(document.activeElement)]; }, before);
      states.focus++;
      add('focus', rows.slice(0, 1).map(([w, r, m]: Row) => [`${w} (its focus indicator)`, r, m] as const), where);
      add('focus', rows.slice(1), where);
    }
  }
  return { fails, states };
}

test('M9 gate, contrast: every built-in design, in every look, in every state, at WCAG AA', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-contrast-');
  const fails: string[] = [];
  const rows: string[] = [];
  try {
    const designs: { id: string; name: string }[] = (await m.get('/api/v1/design-systems')).filter((d: any) => d.valid);
    assert.equal(designs.length, 6, 'all six built-ins');
    for (const ds of designs) {
      assert.equal((await m.send('POST', `/api/v1/design-systems/${ds.id}/apply`, { scope: 'user' })).status, 200);
      const looks = new Set<string>();
      for (const scheme of ['light', 'dark'] as const) {
        const d = await device(b, { ...DESKTOP, scheme });
        await d.ctx.addInitScript(measures);
        await d.page.goto(`${m.base}/`);
        await settled(d.page, 'home');
        await d.page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim() !== '');
        const bg = await d.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim());
        if (looks.has(bg)) { await d.ctx.close(); continue; }
        looks.add(bg);
        const look = `${ds.name}${scheme === 'dark' ? ' (dark system)' : ' (light system)'}`;
        const r = await audit(d.page, m.base, look);
        fails.push(...r.fails);
        rows.push(`${look.padEnd(32)} ${Object.entries(r.states).map(([k, v]) => `${k} ${v}`).join(' · ')}${r.fails.length ? ` · ${r.fails.length} below` : ' · all pass'}`);
        for (const [k, v] of Object.entries(r.states)) assert.ok(v > 0, `${look}: the ${k} state was measured`);
        assert.deepEqual(d.errors, [], `${look}: no errors in the page`);
        await d.ctx.close();
      }
    }
    console.log(`contrast: measured per look (views: home, chat, tasks, memory, settings and three of its categories)\n${rows.join('\n')}`);
    assert.deepEqual([...new Set(fails)], [], `${new Set(fails).size} places read below WCAG AA`);
  } finally {
    await b.close();
    await stop(nova);
  }
});
