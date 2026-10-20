// In-page probes for the checks axe cannot make (e2e/a11y-sweep.spec.ts, FR-015, WCAG 2.2 AA):
// focus indicators (2.4.7, 2.4.13 where feasible), focus not obscured (2.4.11), target size
// (2.5.8), reflow (1.4.10), text spacing (1.4.12) and running animations (2.3.3, reduced motion).
// `installA11yProbes(context)` adds `window.__a11y` to every page of the context.
import type { BrowserContext, Page } from '@playwright/test';

export interface FocusStop {
  /** Stable per element for the life of the page (a data attribute the probe sets). */
  key: string;
  desc: string;
  /** Where the element sits: skip, topbar, sidebar, main, composer, inspector, dialog or other. */
  region: string;
  /** Why the focus indicator is missing or weak, or null when it is fine. */
  indicator: string | null;
  /** True when the focused element is entirely hidden (behind other content or off screen). */
  obscured: boolean;
}

export interface A11yProbes {
  describe(el: Element | null): string;
  focusState(): FocusStop | null;
  targetSize(scope?: string): string[];
  smallTargets(scope?: string): string[];
  reflow(scope?: string): string[];
  clipped(scope?: string): string[];
  fieldContrast(scope?: string): string[];
  runningAnimations(): string[];
}

declare global {
  interface Window {
    __a11y: A11yProbes;
  }
}

/** Runs in the page. Everything it needs is defined inside it. */
function probes() {
  type RGBA = [number, number, number, number];

  const describe = (el: Element | null): string => {
    if (!el) return '(none)';
    const h = el as HTMLElement;
    const name = (
      h.getAttribute('aria-label') ??
      h.getAttribute('title') ??
      (h.textContent ?? '').trim().replace(/\s+/g, ' ')
    ).slice(0, 48);
    const id = h.id ? `#${h.id}` : '';
    const cls =
      typeof h.className === 'string' && h.className.trim()
        ? `.${h.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
    const role = h.getAttribute('role') ? `[role=${h.getAttribute('role')}]` : '';
    return `${h.tagName.toLowerCase()}${id}${cls}${role} "${name}"`;
  };

  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };

  /** Visually hidden helpers (`.nv-vh`, clip rect 0) never take part in layout checks. */
  const srOnly = (el: Element): boolean => {
    for (let x: Element | null = el; x; x = x.parentElement) {
      const cs = getComputedStyle(x);
      if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') return true;
      if (x.classList.contains('nv-vh')) return true;
    }
    return false;
  };

  const parseColor = (c: string): RGBA | null => {
    let m = /^rgba?\(([^)]+)\)$/.exec(c.trim());
    if (m) {
      const p = m[1]!
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    }
    m = /^color\(srgb ([^)]+)\)$/.exec(c.trim());
    if (m) {
      const p = m[1]!
        .split(/[\s/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0]! * 255, p[1]! * 255, p[2]! * 255, p[3] ?? 1];
    }
    return null;
  };
  const over = (top: RGBA, under: RGBA): RGBA => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const mix = (i: number) => (top[i]! * top[3] + under[i]! * under[3] * (1 - top[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  };
  /** The color painted behind `el` (its own background composited over its ancestors'). */
  const backgroundOf = (el: Element | null): RGBA => {
    const layers: RGBA[] = [];
    for (let x = el; x; x = x.parentElement) {
      const c = parseColor(getComputedStyle(x).backgroundColor);
      if (c && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
    }
    let out: RGBA = [255, 255, 255, 1];
    for (const l of layers.reverse()) out = over(l, out);
    return out;
  };
  const lum = (c: RGBA) => {
    const ch = (v: number) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
  };
  const contrast = (a: RGBA, b: RGBA) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  /** The focus ring an element draws: an outline, or a box-shadow ring, at least 2px wide. */
  const ringOf = (el: Element): { width: number; color: RGBA; inset: boolean } | null => {
    const cs = getComputedStyle(el);
    const ow = parseFloat(cs.outlineWidth) || 0;
    const oc = parseColor(cs.outlineColor);
    if (cs.outlineStyle !== 'none' && ow > 0 && oc && oc[3] > 0)
      return { width: ow, color: oc, inset: parseFloat(cs.outlineOffset) < 0 };
    if (cs.boxShadow && cs.boxShadow !== 'none') {
      // "rgb(…) 0px 0px 0px 2px [inset]", one per shadow.
      for (const part of cs.boxShadow.split(/,(?![^(]*\))/)) {
        const color = parseColor(/(rgba?\([^)]*\)|color\([^)]*\))/.exec(part)?.[1] ?? '');
        const nums = part
          .replace(/(rgba?\([^)]*\)|color\([^)]*\))/, '')
          .trim()
          .split(/\s+/)
          .filter((t) => t.endsWith('px'))
          .map(parseFloat);
        const spread = nums[3] ?? 0;
        if (color && color[3] > 0 && spread > 0)
          return { width: spread, color, inset: part.includes('inset') };
      }
    }
    return null;
  };

  /** Why the focused element's indicator is missing or weak (null when it is fine). */
  const indicatorProblem = (el: Element): string | null => {
    // The ring may be on the element, its first child (tree rows) or a wrapper (the composer).
    const candidates = [
      el,
      el.firstElementChild,
      el.parentElement,
      el.parentElement?.parentElement,
    ];
    for (const c of candidates) {
      if (!c) continue;
      const ring = ringOf(c);
      if (!ring) continue;
      if (ring.width < 2) return `ring ${ring.width}px on ${describe(c)}`;
      // The pixels the ring paints were the background before (2.4.13: 3:1 change).
      const behind = ring.inset ? backgroundOf(c) : backgroundOf(c.parentElement);
      const ratio = contrast(over(ring.color, behind), behind);
      if (ratio < 3) return `ring contrast ${ratio.toFixed(2)}:1 on ${describe(c)}`;
      return null;
    }
    return 'no visible focus ring';
  };

  const regionOf = (el: Element): string => {
    if (el.closest('.skip-link')) return 'skip';
    if (el.closest('[role="dialog"]')) return 'dialog';
    if (el.closest('header.topbar')) return 'topbar';
    if (el.closest('#sidebar')) return 'sidebar';
    if (el.closest('.composer')) return 'composer';
    if (el.closest('#main')) return 'main';
    if (el.closest('#inspector')) return 'inspector';
    return 'other';
  };

  /** Fixed and sticky boxes outside `el` that can paint over it (the companion has no pointer events). */
  const overlaysFor = (el: Element): DOMRect[] => {
    const out: DOMRect[] = [];
    for (const x of document.body.querySelectorAll('*')) {
      const pos = getComputedStyle(x).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      if (x.contains(el) || el.contains(x) || !shown(x)) continue;
      out.push(x.getBoundingClientRect());
    }
    return out;
  };

  /** 2.4.11: true when no part of the element can be seen. */
  const obscured = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return true;
    const overlays = overlaysFor(el);
    const pts: [number, number][] = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 2, r.top + 2],
      [r.right - 2, r.top + 2],
      [r.left + 2, r.bottom - 2],
      [r.right - 2, r.bottom - 2],
    ];
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      if (overlays.some((o) => x >= o.left && x <= o.right && y >= o.top && y <= o.bottom))
        continue;
      const top = document.elementFromPoint(x, y);
      if (top && (top === el || el.contains(top) || top.contains(el))) return false;
    }
    return true;
  };

  let walkCounter = 0;
  const focusState = () => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const h = el as HTMLElement;
    if (!h.dataset.a11yWalk) h.dataset.a11yWalk = String(++walkCounter);
    return {
      key: h.dataset.a11yWalk,
      desc: describe(el),
      region: regionOf(el),
      indicator: indicatorProblem(el),
      obscured: obscured(el),
    };
  };

  const TARGETS = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="option"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="treeitem"]',
  ].join(',');

  /** 2.5.8 exceptions that can be decided from the page. */
  const exempt = (el: Element): boolean => {
    const h = el as HTMLElement;
    // User-agent controls the author did not resize: native checkboxes, radios, file and range.
    if (
      el instanceof HTMLInputElement &&
      ['checkbox', 'radio', 'range', 'color', 'file'].includes(el.type) &&
      getComputedStyle(el).appearance !== 'none'
    )
      return true;
    // Inline: a link inside a sentence, sized by the line of text around it.
    if (getComputedStyle(h).display === 'inline') {
      const block = h.parentElement;
      const own = (h.textContent ?? '').trim().length;
      const around = (block?.textContent ?? '').trim().length;
      if (block && around > own + 3) return true;
    }
    return false;
  };

  /** Every undersized target and why it passes (for the debug log). */
  const smallTargets = (scope = 'body'): string[] => {
    const root = document.querySelector(scope) ?? document.body;
    return [...root.querySelectorAll(TARGETS)]
      .filter((el) => shown(el) && !srOnly(el))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width < 23.5 || r.height < 23.5)
      .map(
        ({ el, r }) =>
          `${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)}${exempt(el) ? ' (exempt)' : ''}`,
      );
  };

  const targetSize = (scope = 'body'): string[] => {
    const root = document.querySelector(scope) ?? document.body;
    const all = [...root.querySelectorAll(TARGETS)].filter(
      (el) =>
        shown(el) &&
        !srOnly(el) &&
        !(el as HTMLElement).closest('[aria-hidden="true"], [inert]') &&
        !(el as HTMLButtonElement).disabled,
    );
    const boxes = all.map((el) => ({ el, r: el.getBoundingClientRect() }));
    const small = boxes.filter(({ el, r }) => (r.width < 23.5 || r.height < 23.5) && !exempt(el));
    const out: string[] = [];
    const center = (r: DOMRect) => [r.left + r.width / 2, r.top + r.height / 2] as const;
    for (const s of small) {
      const [cx, cy] = center(s.r);
      const clash = boxes.find(({ el, r }) => {
        if (el === s.el || el.contains(s.el) || s.el.contains(el)) return false;
        const smallToo = small.some((x) => x.el === el);
        if (smallToo) {
          const [ox, oy] = center(r);
          return Math.hypot(ox - cx, oy - cy) < 24;
        }
        const dx = Math.max(r.left - cx, 0, cx - r.right);
        const dy = Math.max(r.top - cy, 0, cy - r.bottom);
        return Math.hypot(dx, dy) < 12;
      });
      if (clash)
        out.push(
          `${describe(s.el)} is ${Math.round(s.r.width)}x${Math.round(s.r.height)} and too close to ${describe(clash.el)}`,
        );
    }
    return out;
  };

  /** Content that needs two dimensions to make sense (exempt from 1.4.10). */
  const TWO_D = 'pre, code, table, svg, canvas, iframe, video, img, .xterm, [role="grid"]';

  const reflow = (scope = 'body'): string[] => {
    const W = document.documentElement.clientWidth;
    const out: string[] = [];
    if (document.documentElement.scrollWidth > W + 1)
      out.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${W})`);
    const root = document.querySelector(scope) ?? document.body;
    for (const el of root.querySelectorAll('*')) {
      if (!shown(el) || srOnly(el) || el.closest(TWO_D)) continue;
      const r = el.getBoundingClientRect();
      if (r.right <= W + 1 && r.left >= -1) continue;
      const parent = el.parentElement;
      if (parent && parent !== root) {
        const pr = parent.getBoundingClientRect();
        if (pr.right > W + 1 || pr.left < -1) continue; // report the outermost only
      }
      out.push(`${describe(el)} spans ${Math.round(r.left)}..${Math.round(r.right)} of ${W}`);
    }
    return out;
  };

  /** 1.4.12: text that no longer fits its box and is cut off (no ellipsis intent). */
  const clipped = (scope = 'body'): string[] => {
    const root = document.querySelector(scope) ?? document.body;
    const out: string[] = [];
    for (const el of root.querySelectorAll('*')) {
      if (!shown(el) || srOnly(el)) continue;
      const cs = getComputedStyle(el);
      const hx = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      const hy = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
      if (!hx && !hy) continue;
      if (!(el.textContent ?? '').trim()) continue;
      const h = el as HTMLElement;
      // Text that ends in an ellipsis is a deliberate truncation with the full text elsewhere.
      const ellipsis = cs.textOverflow === 'ellipsis';
      // Only text inside the element counts: a scrolling child keeps its own content reachable.
      const lostY = hy && h.scrollHeight > h.clientHeight + 1;
      const lostX = hx && !ellipsis && h.scrollWidth > h.clientWidth + 1;
      if (!lostY && !lostX) continue;
      const scroller = [...el.children].some((c) => {
        const ccs = getComputedStyle(c);
        return /(auto|scroll)/.test(ccs.overflowY + ccs.overflowX);
      });
      if (scroller) continue;
      out.push(
        `${describe(el)} ${lostY ? `height ${h.scrollHeight}>${h.clientHeight}` : ''}${lostX ? ` width ${h.scrollWidth}>${h.clientWidth}` : ''}`,
      );
    }
    return out;
  };

  /**
   * 1.4.3 for hints in empty fields and 1.4.11 for the edges of text fields: placeholder text at
   * 4.5:1 on the field, and the field's border at 3:1 against the surface around it.
   */
  const fieldContrast = (scope = 'body'): string[] => {
    const root = document.querySelector(scope) ?? document.body;
    const out: string[] = [];
    const fields = [
      ...root.querySelectorAll<HTMLElement>(
        'input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="password"], input[type="number"], textarea, select',
      ),
    ].filter((el) => shown(el) && !srOnly(el));
    for (const el of fields) {
      const own = backgroundOf(el);
      const ph = el.getAttribute('placeholder');
      if (ph) {
        const c = parseColor(getComputedStyle(el, '::placeholder').color);
        if (c) {
          const ratio = contrast(over(c, own), own);
          if (ratio < 4.5) out.push(`${describe(el)} placeholder ${ratio.toFixed(2)}:1`);
        }
      }
      // Fields drawn as a box: the edge must show (the composer's box is its wrapper's).
      const cs = getComputedStyle(el);
      const box = parseFloat(cs.borderTopWidth) > 0 ? el : null;
      if (!box) continue;
      const edge = parseColor(cs.borderTopColor);
      const around = backgroundOf(el.parentElement);
      if (edge) {
        const ratio = contrast(over(edge, around), around);
        if (ratio < 3) out.push(`${describe(el)} edge ${ratio.toFixed(2)}:1`);
      }
    }
    return out;
  };

  const runningAnimations = (): string[] =>
    document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => {
        const name =
          (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? 'script';
        const target = (a.effect as KeyframeEffect | null)?.target ?? null;
        return `${name} on ${describe(target)}`;
      });

  window.__a11y = {
    describe,
    focusState,
    targetSize,
    smallTargets,
    reflow,
    clipped,
    fieldContrast,
    runningAnimations,
  };
}

export async function installA11yProbes(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(probes);
}

/** For a page that loaded before the probes were installed. */
export async function ensureA11yProbes(page: Page): Promise<void> {
  if (await page.evaluate(() => typeof window.__a11y === 'undefined')) await page.evaluate(probes);
}
