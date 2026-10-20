// DOM checks for localization tests (FR-016, D9), shared by apps/web and packages/ui tests:
// `findUnlocalized` lists every visible text and accessible name under a container that did not
// come through messages in a pseudo-locale. Allowed as they are: fixture `data`, numbers, URLs,
// `ext:`/`mcp:`-style ids, the product name, `<kbd>`, `<code>`, `<pre>`, anything under
// `translate="no"`, and single-character key caps in key-combination labels.
import { isUnlocalized } from './residue.ts';

export { isUnlocalized, unlocalizedResidue } from './residue.ts';

const ATTRIBUTES = [
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'title',
  'placeholder',
  'alt',
];
const ALWAYS_SKIP = 'kbd, code, pre, script, style, [translate="no"]';

/** Key caps that are names of their own (a letter, a digit, F1 to F24). */
const KEY_CAP = /^(?:.|F\d{1,2})$/u;

function describeElement(el: Element): string {
  const cls = el.getAttribute('class')?.trim().split(/\s+/)[0];
  return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}>`;
}

export interface LocalizedOptions {
  /** Fixture strings that may appear as they are (thread titles, names, Hub messages). */
  data?: readonly string[];
  /** Selectors of regions owned by areas not converted yet. */
  skip?: readonly string[];
}

/** Every text and accessible name under `container` that is not localized. */
export function findUnlocalized(container: Element, opts: LocalizedOptions = {}): string[] {
  const data = opts.data ?? [];
  const skip = [ALWAYS_SKIP, ...(opts.skip ?? [])].join(', ');
  const doc = container.ownerDocument;
  const out: string[] = [];
  const walker = doc.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    const text = n.textContent ?? '';
    if (!parent || parent.closest(skip) || !isUnlocalized(text, data)) continue;
    out.push(`text "${text.trim()}" in ${describeElement(parent)}`);
  }
  const elements = [container, ...container.querySelectorAll('*')];
  for (const el of elements) {
    if (el.closest(skip)) continue;
    // A key combination's label names its caps: single-letter caps are names, not words.
    const caps = [...el.querySelectorAll('kbd')]
      .map((k) => (k.textContent ?? '').trim())
      .filter((t) => KEY_CAP.test(t));
    const allowed = caps.length ? [...data, ...caps] : data;
    for (const attr of ATTRIBUTES) {
      const v = el.getAttribute(attr);
      if (v && isUnlocalized(v, allowed)) out.push(`${attr} "${v}" on ${describeElement(el)}`);
    }
    const value = (el as { value?: unknown }).value;
    const isButtonValue =
      el.tagName === 'INPUT' &&
      ['button', 'submit', 'reset'].includes((el.getAttribute('type') ?? '').toLowerCase());
    if (isButtonValue && typeof value === 'string' && value && isUnlocalized(value, data))
      out.push(`value "${value}" on ${describeElement(el)}`);
  }
  return out;
}
