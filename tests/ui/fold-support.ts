// Fold postures (UX review 2026-10-31, F8 and F9): what a posture looks like from inside the page.
// One in-page audit, shared by the gate (fold-postures.test.ts) and anything that wants the same
// numbers: the band the layout is in and the widths it derives, anything past the viewport with no
// way to scroll to it, text crushed under 8 characters a line, siblings drawn over each other, cards
// under their minimum width, and whether the right column scrolls or clips. Neutral placeholders only.
import type { BrowserContext, Page } from 'playwright-core';

// A mesh like the owner's in the review (F8: the hub, a desktop with a long name, a phone that went
// offline hours ago): the Devices card is where the right column crushed first.
export function meshFixture(now = Date.now()) {
  const iso = (ms: number) => new Date(now - ms).toISOString();
  return [
    { id: 'dev-hub', name: 'Hub', kind: 'computer', role: 'hub', trust: 'trusted', online: true, this: true, last_seen: iso(0) },
    { id: 'dev-desk', name: 'Study desktop 8950', kind: 'browser', role: 'member', trust: 'trusted', online: true, this: false, last_seen: iso(60_000) },
    { id: 'dev-fold', name: 'Folding phone', kind: 'phone', role: 'member', trust: 'trusted', online: false, this: false, last_seen: iso(3 * 3600_000) },
  ];
}

// Every page in this context sees that mesh.
export async function withMesh(ctx: BrowserContext) {
  await ctx.route('**/api/v1/mesh/devices', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(meshFixture()) }));
}

export interface FoldAudit {
  width: number;
  height: number;
  layout: string;
  aside: string;
  // The derived bands (px) and the regions they are the sum of; null before the fix existed.
  bands: { two: number; three: number; rail: number; main: number; asideMin: number; cardMin: number; scrollbar: number } | null;
  // Regions drawn side by side: rail, main, aside (tabs are below, not a column).
  columns: string[];
  regions: Record<string, number>;
  // Anything outside the viewport that no scroller can bring into view.
  overflow: string[];
  // A scroller that scrolls sideways when it isn't one meant to (a table, code).
  sideways: string[];
  // Content cut by a box that hides its overflow (not a scroller).
  clipped: string[];
  // Text blocks wrapping at under 8 characters a line: [text, characters per line, lines].
  crushed: [string, number, number][];
  minCpl: number | null;
  overlaps: string[];
  cardMin: number;
  narrowCards: [string, number][];
  rightColumn: { shown: boolean; width: number; scrollable: boolean; overflowing: boolean; clipped: boolean; bottom: number };
}

export function audit(page: Page): Promise<FoldAudit> {
  return page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const H = document.documentElement.clientHeight;
    const name = (e: Element) => {
      const t = (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 28);
      return `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${[...e.classList].slice(0, 2).map((c) => `.${c}`).join('')}${t ? ` “${t}”` : ''}`;
    };
    const hidden = (e: Element): boolean => {
      if (!(e as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true } as never)) return true;
      if (e.closest('.sr-only, [aria-hidden="true"], .skip-link, [inert], .band-probes')) return true;
      for (let x: Element | null = e; x && x !== document.body; x = x.parentElement) {
        const cs = getComputedStyle(x);
        if (cs.clipPath === 'inset(50%)' || /^rect\(0/.test(cs.clip)) return true;
      }
      const r = e.getBoundingClientRect();
      // A box crushed to nothing across is not hidden: its text still shows, spilling (F8's
      // device names were in a 1px column). Only a box that is nothing both ways is.
      return r.width <= 1 && r.height <= 1;
    };
    const scrolls = (v: string) => v === 'auto' || v === 'scroll';
    const cuts = (v: string) => v === 'hidden' || v === 'clip';
    const all = [...document.body.querySelectorAll('*')].filter((e) => !(e instanceof SVGElement && !(e instanceof SVGSVGElement)) && !hidden(e));

    // ---- the band and its regions --------------------------------------------------------------
    const box = (id: string) => { const e = document.getElementById(id); return e && !hidden(e) ? e.getBoundingClientRect() : null; };
    const regions: Record<string, number> = {};
    const columns: string[] = [];
    for (const id of ['rail', 'main', 'aside']) {
      const r = box(id);
      if (!r) continue;
      regions[id] = Math.round(r.width);
      if (!columns.length || r.left >= Math.max(...columns.map((c) => document.getElementById(c)!.getBoundingClientRect().right)) - 1) columns.push(id);
    }
    let bands: FoldAudit['bands'] = null;
    const probe = (v: string) => { const p = document.createElement('div'); p.style.cssText = `position:absolute;visibility:hidden;height:0;width:${v}`; document.body.append(p); const w = p.getBoundingClientRect().width; p.remove(); return Math.round(w * 10) / 10; };
    const root = getComputedStyle(document.documentElement);
    if (root.getPropertyValue('--band-three').trim()) {
      bands = {
        two: probe('var(--band-two)'),
        three: probe('var(--band-three)'),
        rail: probe('var(--layout-rail-width)'),
        main: probe('var(--region-main-min)'),
        asideMin: probe('var(--region-aside-min)'),
        cardMin: probe('var(--region-card-min)'),
        scrollbar: probe('var(--scrollbar-room)'),
      };
    }
    // Before the fix there was no card minimum; the same yardstick, so the numbers compare.
    const cardMin = probe('var(--region-card-min, calc(20ch + 2 * var(--space-5)))');

    // ---- past the viewport, cut, or scrolling sideways -----------------------------------------
    const overflow: string[] = [];
    const clipped: string[] = [];
    const sideways: string[] = [];
    // A table or code block scrolls sideways by design; so does a phone's view of a page Nova drives.
    const SIDEWAYS_OK = '.table-wrap, pre, .code-block, .takeover-screen, textarea';
    for (const e of all) {
      // The orb's glow is light, not content: it may fall past an edge.
      if (e.closest('.orb')) continue;
      const r = e.getBoundingClientRect();
      let sx = false; let sy = false;
      for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.position === 'fixed' && a !== e) { /* a fixed layer is its own viewport-sized frame */ }
        if (scrolls(cs.overflowX)) sx = true;
        if (scrolls(cs.overflowY)) sy = true;
        // Cut by a box that hides overflow (not one that scrolls), and not what it is meant to hide.
        if (a !== document.body && (cuts(cs.overflowX) || cuts(cs.overflowY))) {
          const b = a.getBoundingClientRect();
          const outX = cuts(cs.overflowX) && !sx && (r.left < b.left - 1 || r.right > b.right + 1);
          const outY = cuts(cs.overflowY) && !sy && (r.top < b.top - 1 || r.bottom > b.bottom + 1);
          if ((outX || outY) && (e.textContent ?? '').trim() && !e.closest('.orb')) clipped.push(`${name(e)} cut by ${name(a).split(' ')[0]}`);
        }
      }
      if (!sx && (r.left < -1 || r.right > W + 1)) overflow.push(`${name(e)} spans x ${Math.round(r.left)}–${Math.round(r.right)} of ${W}`);
      if (!sy && (r.top < -1 || r.bottom > H + 1)) overflow.push(`${name(e)} spans y ${Math.round(r.top)}–${Math.round(r.bottom)} of ${H}`);
      const cs = getComputedStyle(e);
      if (scrolls(cs.overflowX) && e.scrollWidth > e.clientWidth + 1 && !e.matches(SIDEWAYS_OK) && !e.closest(SIDEWAYS_OK)) sideways.push(`${name(e).split(' ')[0]} scrolls ${e.scrollWidth - e.clientWidth}px sideways`);
    }

    // ---- characters per line --------------------------------------------------------------------
    // A text block: the nearest box that isn't inline, and the text that flows in it (not in a
    // nested block). Its lines are the distinct rows its text's line boxes sit on.
    const blockOf = (n: Node) => { let x = n.parentElement; while (x && /^inline|^contents/.test(getComputedStyle(x).display) && !/inline-(block|flex|grid)/.test(getComputedStyle(x).display)) x = x.parentElement; return x; };
    const texts = new Map<Element, Text[]>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      if (!n.textContent!.trim()) continue;
      const p = n.parentElement!;
      if (hidden(p) || p.closest('textarea, script, style, .orb')) continue;
      const b = blockOf(n);
      if (!b || /pre/.test(getComputedStyle(b).whiteSpace)) continue;
      (texts.get(b) ?? texts.set(b, []).get(b)!).push(n);
    }
    const crushed: [string, number, number][] = [];
    let minCpl: number | null = null;
    for (const [b, nodes] of texts) {
      const rows: number[] = [];
      let chars = 0;
      for (const n of nodes) {
        chars += n.textContent!.replace(/\s+/g, ' ').length;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.width < 0.5 || r.height < 0.5) continue;
          const mid = r.top + r.height / 2;
          if (!rows.some((y) => Math.abs(y - mid) < r.height / 2)) rows.push(mid);
        }
      }
      const text = nodes.map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
      chars = text.length;
      if (rows.length < 2) continue;
      const cpl = Math.round((chars / rows.length) * 10) / 10;
      if (minCpl === null || cpl < minCpl) minCpl = cpl;
      if (cpl < 8) crushed.push([text.slice(0, 40), cpl, rows.length]);
    }

    // ---- siblings drawn over each other ---------------------------------------------------------
    // Each in-flow child of a box (its border box, its line boxes if inline, and any of its text
    // that spills out of it) against every other, and against the box's own loose text.
    const overlaps: string[] = [];
    const inFlow = (e: Element) => { const p = getComputedStyle(e).position; return p !== 'absolute' && p !== 'fixed'; };
    const spill = (e: Element) => {
      const own = e.getBoundingClientRect();
      const out: DOMRect[] = [];
      const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!n.textContent!.trim() || hidden(n.parentElement!)) continue;
        // Text a scroller (or a box that cuts) holds is bounded by it: scrolled away, not spilled.
        let held = false;
        for (let a = n.parentElement; a; a = a === e ? null : a.parentElement) { const cs = getComputedStyle(a); if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { held = true; break; } }
        if (held) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.left < own.left - 1 || r.right > own.right + 1 || r.top < own.top - 1 || r.bottom > own.bottom + 1) out.push(r);
      }
      return out;
    };
    const hits = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1.5;
    for (const p of all) {
      if (p.closest('.orb, svg, .band-probes') || p.matches('svg')) continue;
      const kids = [...p.children].filter((k) => !hidden(k) && inFlow(k) && !k.matches('svg *'));
      const loose = [...p.childNodes].filter((n) => n.nodeType === 3 && n.textContent!.trim());
      if (kids.length + loose.length < 2) continue;
      const items: { label: string; rects: DOMRect[] }[] = kids.map((k) => {
        const inline = getComputedStyle(k).display === 'inline';
        return { label: name(k), rects: [...(inline ? [...k.getClientRects()] : [k.getBoundingClientRect()]), ...spill(k)] };
      });
      for (const n of loose) { const range = document.createRange(); range.selectNodeContents(n); items.push({ label: `text “${n.textContent!.trim().slice(0, 20)}”`, rects: [...range.getClientRects()] }); }
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        if (items[i]!.rects.some((a) => items[j]!.rects.some((b) => hits(a, b)))) overlaps.push(`${items[i]!.label} / ${items[j]!.label}`);
      }
    }

    // ---- cards and the right column -------------------------------------------------------------
    const narrowCards: [string, number][] = [];
    for (const c of all.filter((e) => e.matches('.card'))) {
      const w = c.getBoundingClientRect().width;
      if (w < cardMin - 0.5) narrowCards.push([name(c).slice(0, 48), Math.round(w)]);
    }
    const aside = document.getElementById('aside')!;
    const ar = aside.getBoundingClientRect();
    const acs = getComputedStyle(aside);
    const shown = !hidden(aside);
    const overflowing = shown && aside.scrollHeight > aside.clientHeight + 1;
    const scrollable = shown && scrolls(acs.overflowY);
    const rightColumn = {
      shown,
      width: shown ? Math.round(ar.width) : 0,
      scrollable,
      overflowing,
      clipped: shown && ((overflowing && !scrollable) || ar.bottom > H + 1),
      bottom: shown ? Math.round(ar.bottom) : 0,
    };

    return {
      width: W, height: H,
      layout: document.body.dataset.layout ?? '', aside: document.body.dataset.aside ?? '',
      bands, columns, regions,
      overflow: [...new Set(overflow)], sideways: [...new Set(sideways)], clipped: [...new Set(clipped)],
      crushed, minCpl, overlaps: [...new Set(overlaps)], cardMin: Math.round(cardMin), narrowCards, rightColumn,
    };
  });
}

// What the gate refuses, as sentences.
export function problems(a: FoldAudit): string[] {
  const out: string[] = [];
  for (const o of a.overflow) out.push(`past the viewport, with nothing to scroll it into view: ${o}`);
  for (const s of a.sideways) out.push(`sideways scrolling inside the page: ${s}`);
  for (const c of a.clipped) out.push(`cut off: ${c}`);
  for (const [t, cpl, lines] of a.crushed) out.push(`“${t}” wraps at ${cpl} characters a line over ${lines} lines (8 at least)`);
  for (const o of a.overlaps) out.push(`drawn over each other: ${o}`);
  for (const [c, w] of a.narrowCards) out.push(`a card ${w}px wide, under its ${a.cardMin}px minimum: ${c}`);
  if (a.rightColumn.clipped) out.push(`the right column is cut off (bottom ${a.rightColumn.bottom} of ${a.height}, ${a.rightColumn.scrollable ? 'scrolls' : 'does not scroll'})`);
  if (a.rightColumn.shown && !(a.rightColumn.scrollable || !a.rightColumn.overflowing)) out.push('the right column holds more than it shows and does not scroll');
  if (a.bands) {
    // Three columns exactly when the derived band fits (a flat screen; a hinge has its own panes).
    const three = a.columns.length === 3;
    if (three && a.width < a.bands.three - 0.5) out.push(`three columns at ${a.width}px, under the derived ${a.bands.three}px`);
    if (three) {
      if (a.regions.main! < a.bands.main - 1) out.push(`the main column is ${a.regions.main}px, under its ${a.bands.main}px minimum`);
      if (a.regions.aside! < a.bands.asideMin - 1) out.push(`the right column is ${a.regions.aside}px, under its ${a.bands.asideMin}px minimum`);
    }
  }
  return out;
}

// One line for the record.
export function summary(a: FoldAudit) {
  return {
    layout: a.layout, columns: a.columns.join('+'), regions: a.regions,
    minCpl: a.minCpl, crushed: a.crushed.length, overflow: a.overflow.length, sideways: a.sideways.length, clipped: a.clipped.length,
    overlaps: a.overlaps.length, narrowCards: a.narrowCards.length, right: a.rightColumn.shown ? `${a.rightColumn.width}px ${a.rightColumn.clipped ? 'CLIPPED' : a.rightColumn.overflowing ? 'scrolls' : 'fits'}` : 'off',
  };
}
