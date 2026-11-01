#!/usr/bin/env node
// Components consume design tokens only (DESIGN-SYSTEM §2, ADR-12). Fails on a raw colour, font
// name, radius, shadow, motion value or raw spacing anywhere in ui/, and on any var(--x) that
// isn't a token of the schema in src/core/design.ts (or a custom property ui/ itself declares).
// Breakpoints live only in the layout file (DESIGN-SYSTEM §5).
// The designed scales (DESIGN-SYSTEM §0, §2.1, owner direction 2026-11-01): spacing takes one step
// of the 4pt scale (or its negative), never a half step or a sum; type takes the type scale's own
// tokens; a radius is one radius token, by the component's size class, never a fraction of one and
// never the pill on something that grows; a gradient is the orb's light or the page's, never
// decoration; one icon set at one stroke weight; no emoji. In CSS, and in the styles scripts write.
// Usage: node scripts/lint-tokens.js [files...]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { ICON_STROKE, TOKEN_NAMES, cssVar } from '../src/core/index.ts';

const UI = 'ui';
export const LAYOUT_FILE = 'ui/styles/layout.css';
const SCHEMA = new Set(TOKEN_NAMES.map(cssVar));

const COLOR_PROPS = /^(color|background|background-color|border|border-(top|right|bottom|left)(-color)?|border-color|outline|outline-color|fill|stroke|text-decoration|text-decoration-color|caret-color|accent-color|column-rule|box-shadow|text-shadow)$/;
const NAMED = /\b(white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|brown|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/i;
const FONT_NAMES = /\b(serif|sans-serif|monospace|system-ui|ui-serif|ui-monospace|-apple-system|Georgia|Inter|Helvetica|Arial|Menlo|Consolas|Times|"SF [^"]+"|"New York"|"Iowan Old Style")\b/;
const SPACING = /^(padding|margin|gap|row-gap|column-gap|inset)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;
const ONLY_VARS = /^(?:\s*(?:var\(--[\w-]+\)|italic|\/)\s*)+$/;
const TYPE_SIZE = /^var\(--type-(h1|h2|h3|body|small|caption)\)$/;
const TYPE_LINE = /^var\(--type-line-(tight|body)\)$/;
const RADIUS_TOKEN = /^var\(--radius-(card|input|pill)\)$/;
// What can grow taller than one line, so must never take the pill (its radius follows the height:
// UX review 1, F0's ellipse). A container takes radius/card, a control radius/input.
const GROWS = /(^|[\s.#>+~(,])(textarea|composer|card|sheet|panel|bubble|banner|toast|btn|choice|input|field|dialog)(?![\w-])/;
// Gradients light the orb and the page behind everything; anywhere else they are decoration.
const GRADIENT_OK = /\.orb\b|\.orb-|^\s*(html|body)\s*$/;
const EMOJI_ALL = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}]/gu;

// Custom properties ui/ declares itself (in CSS, or with style.setProperty), e.g. --gutter.
function declared(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)) out.add(m[1]);
  for (const m of text.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) out.add(m[1]);
  return out;
}

function varProblems(text, lineOf, ctx) {
  const out = [];
  for (const m of text.matchAll(/var\((--[\w-]+)/g)) {
    const name = m[1];
    if (SCHEMA.has(name) || ctx.local.has(name)) continue;
    out.push([lineOf(m.index), `unknown token ${name}: components use only schema tokens (GET /api/v1/design-systems/schema)`]);
  }
  for (const m of text.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)) {
    if (SCHEMA.has(m[1])) out.push([lineOf(m.index), `${m[1]} is a design token; only a design system sets it`]);
  }
  return out;
}

// Motion (Amendment 2026-10-30-C Part 2, M9): only transform and opacity move; a transition or a
// one-off animation takes one of the 150–300 ms tokens as it is; a one-off never bounces. A loop
// (`infinite`) shows a state for as long as it lasts, so it may use the loop tokens.
const MOVES = new Set(['transform', 'translate', 'scale', 'rotate', 'opacity']);
const FINITE = /^var\(--motion-(transition|duration-fast|duration-slow)\)$/;
const ZERO = /^0m?s$/;
const TIME = /^(var\(--motion-(?!ease\))[\w-]+\)|calc\(.*\)|\d*\.?\d+m?s)$/;
const ANIM_WORDS = new Set(['none', 'infinite', 'alternate', 'alternate-reverse', 'normal', 'reverse', 'both', 'forwards', 'backwards', 'running', 'paused', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end']);
const ONLY = 'only transform and opacity animate';
const FINITE_SAY = 'a transition or one-off animation takes --motion-transition, --motion-duration-fast or --motion-duration-slow as it is (150–300 ms)';

// "a b(c, d) e" → ['a', 'b(c, d)', 'e']; and the same split on commas.
function split(s, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function transitionProblems(value, line, { propertyOnly = false } = {}) {
  const out = [];
  for (const part of split(value, ',')) {
    const words = split(part, ' ');
    const prop = propertyOnly ? part : words[0];
    if (!prop || prop === 'none') continue;
    const times = propertyOnly ? [] : words.filter((w) => TIME.test(w));
    if (prop === 'visibility') {
      if (!propertyOnly && !ZERO.test(times[0] ?? '')) out.push([line, 'visibility only flips: give it 0s and a delay, never a duration']);
      continue;
    }
    if (!MOVES.has(prop)) { out.push([line, `${ONLY}: ${prop}`]); continue; }
    if (times[0] && !FINITE.test(times[0])) out.push([line, `${FINITE_SAY}; got ${times[0]}`]);
  }
  return out;
}

const OFFSET = { from: 0, to: 100 };
function motionProblems(body, lineOf) {
  const out = [];
  const finite = new Set();
  for (const m of body.matchAll(/(?:^|[;{\s])(transition|transition-property|animation)\s*:\s*([^;{}]+)/g)) {
    const [, prop, raw] = m;
    const value = raw.trim();
    const line = lineOf(m.index);
    if (prop !== 'animation') { out.push(...transitionProblems(value, line, { propertyOnly: prop === 'transition-property' })); continue; }
    for (const part of split(value, ',')) {
      const words = split(part, ' ');
      if (words.length === 1 && words[0] === 'none') continue;
      const name = words.find((w) => !ANIM_WORDS.has(w) && !TIME.test(w) && !/^(var|calc)\(/.test(w) && !/^\d/.test(w));
      if (words.includes('infinite')) continue;
      if (name) finite.add(name);
      const time = words.find((w) => TIME.test(w));
      if (time && !FINITE.test(time)) out.push([line, `${FINITE_SAY}; got ${time}`]);
    }
  }
  for (const m of body.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    const name = m[1];
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < body.length && depth; i++) { if (body[i] === '{') depth++; if (body[i] === '}') depth--; }
    const inner = body.slice(start, i - 1);
    const steps = [];
    const bad = new Set();
    for (const s of inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const offsets = s[1].split(',').map((o) => o.trim()).map((o) => OFFSET[o] ?? Number.parseFloat(o));
      const decls = [...s[2].matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)].map(([, p, v]) => [p, v.trim()]);
      for (const [p] of decls) if (!MOVES.has(p) && !bad.has(p)) { bad.add(p); out.push([lineOf(m.index), `keyframes ${name}: ${ONLY}: ${p}`]); }
      for (const o of offsets) steps.push([o, decls]);
    }
    if (!finite.has(name)) continue;
    steps.sort((a, b) => a[0] - b[0]);
    for (const p of MOVES) {
      const values = steps.flatMap(([, d]) => d.filter(([q]) => q === p).map(([, v]) => v));
      const nums = values.map((v) => Number.parseFloat(v)).filter((n) => Number.isFinite(n));
      if (nums.length < 3) continue;
      const signs = new Set(nums.slice(1).map((n, k) => Math.sign(n - nums[k])).filter(Boolean));
      if (signs.size > 1) out.push([lineOf(m.index), `keyframes ${name} bounces: ${p} goes ${values.join(' → ')}; a one-off moves one way (no bounce or elastic)`]);
    }
  }
  return out;
}

// The designed scales, for one declaration. `local` is ui/'s own custom properties: an expression
// with one of them (a measured hit area, the orb's glow scale) or with env() or a layout token is
// derived geometry, not a spacing choice.
const VARS = /var\((--[\w-]+)\)/g;
// Every top-level calc(…) in a value, parentheses balanced.
function calcs(v) {
  const out = [];
  for (let i = v.indexOf('calc('); i !== -1; i = v.indexOf('calc(', i + 1)) {
    let depth = 0;
    let j = i + 4;
    for (; j < v.length; j++) { if (v[j] === '(') depth++; if (v[j] === ')' && --depth === 0) break; }
    out.push(v.slice(i, j + 1));
    i = j;
  }
  return out;
}
export function scaleProblems(prop, v, local = new Set()) {
  const out = [];
  // A name that isn't a token is already its own problem (unknown token); don't say it twice.
  if ([...v.matchAll(VARS)].some((m) => !SCHEMA.has(m[1]) && !local.has(m[1])) && !SPACING.test(prop)) return out;
  if (SPACING.test(prop)) {
    for (const m of v.matchAll(/var\(--(type|radius|shadow|motion|blur)-[\w-]+\)/g)) out.push(`off-scale spacing: ${prop} takes a space token, not ${m[0]}`);
    for (const c0 of calcs(v)) {
      // A hairline (± 1px) beside a step makes up for a border; it isn't a step of its own.
      const c = c0.replace(/\s*[-+]\s*1px\b/g, '');
      const names = [...c.matchAll(VARS)].map((m) => m[1]);
      const derived = /env\(/.test(c) || names.some((n) => n.startsWith('--layout-') || local.has(n));
      const negative = /^calc\(\s*-1\s*\*\s*var\(--space-[1-8]\)\s*\)$/.test(c) || /^calc\(\s*var\(--space-[1-8]\)\s*\*\s*-1\s*\)$/.test(c);
      if (!derived && !negative) out.push(`off-scale spacing: ${prop}: ${c0} isn't a step of the 4pt scale; use one space token (or calc(-1 * var(--space-n)))`);
    }
  }
  if (prop === 'font-size' && v !== 'inherit' && !TYPE_SIZE.test(v)) out.push(`off-scale type: font-size takes a type size token (--type-h1 … --type-caption); got ${v}`);
  if (prop === 'line-height' && v !== 'inherit' && !TYPE_LINE.test(v)) out.push(`off-scale type: line-height takes --type-line-tight or --type-line-body; got ${v}`);
  if (prop === 'font' && ONLY_VARS.test(v)) {
    const [size, line] = v.replace(/var\(--(font|type-weight)-[\w-]+\)|italic/g, '').trim().split('/').map((x) => x.trim());
    if (size && !TYPE_SIZE.test(size)) out.push(`off-scale type: font size ${size} isn't a step of the type scale`);
    if (line && !TYPE_LINE.test(line)) out.push(`off-scale type: line height ${line} isn't --type-line-tight or --type-line-body`);
  }
  if (/^border(-[a-z]+)*-radius$/.test(prop) && !/^(0|50%|inherit)$/.test(v)) {
    const parts = split(v, ' ');
    if (parts.some((x) => x !== '0' && !RADIUS_TOKEN.test(x))) out.push(`off-scale radius: ${prop}: ${v}; a radius is one radius token by size class, never a fraction or sum of one`);
  }
  return out;
}

function cssProblems(css, ctx) {
  const out = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lineOf = (i) => body.slice(0, i).split('\n').length;
  out.push(...varProblems(body, lineOf, ctx));
  out.push(...motionProblems(body, lineOf));
  for (const m of body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) out.push([lineOf(m.index), `raw color ${m[0]}`]);
  for (const m of body.matchAll(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g)) out.push([lineOf(m.index), `raw color ${m[1]}()`]);
  for (const m of body.matchAll(/cubic-bezier\(|steps\(/g)) out.push([lineOf(m.index), 'raw easing curve']);
  if (ctx.path !== LAYOUT_FILE) {
    for (const m of body.matchAll(/@(?:media|container)[^{]*\((?:min-|max-)?(?:width|height|inline-size)\s*[:<>]/g)) out.push([lineOf(m.index), `breakpoints belong in ${LAYOUT_FILE} (DESIGN-SYSTEM §5)`]);
  }
  // Per rule: the pill on something that grows, and gradients outside the orb and the page.
  for (const m of body.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (selector.startsWith('@')) continue;
    const line = lineOf(m.index + m[0].indexOf('{'));
    const sels = selector.split(',').map((x) => x.trim());
    if (/border(-[a-z]+)*-radius\s*:[^;]*var\(--radius-pill\)/.test(m[2])) {
      const grows = sels.filter((x) => GROWS.test(x.replace(/::?[\w-]+(\([^)]*\))?/g, '')) && !/::?(before|after)\b/.test(x));
      if (grows.length) out.push([line, `pill radius on something that grows (${grows.join(', ')}): a pill's radius follows its height; a container takes --radius-card, a control --radius-input`]);
    }
    if (/-gradient\(/.test(m[2]) && !sels.every((x) => GRADIENT_OK.test(x))) out.push([line, `decorative gradient on ${selector}: gradients are the orb's light and the page's, nothing else`]);
  }
  for (const m of body.matchAll(EMOJI_ALL)) out.push([lineOf(m.index), `emoji ${m[0]}: icons come from the one icon set`]);
  for (const m of body.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)) {
    const [, prop, value] = m;
    const line = lineOf(m.index);
    const v = value.trim();
    for (const msg of scaleProblems(prop, v, ctx.local)) out.push([line, msg]);
    if (COLOR_PROPS.test(prop) && NAMED.test(v.replace(/var\([^)]*\)/g, ''))) out.push([line, `named color in ${prop}: ${v}`]);
    if (prop === 'font-family' && !/^(var\(--font[\w-]*\)|inherit)$/.test(v)) out.push([line, `font-family must be a token: ${v}`]);
    if (prop === 'font' && !(ONLY_VARS.test(v) || v === 'inherit')) out.push([line, `font must be built from type tokens: ${v}`]);
    if (/^(font-size|line-height)$/.test(prop) && !/^(inherit|var\(--[\w-]+\))$/.test(v)) out.push([line, `${prop} outside the type scale: ${v}`]);
    if (FONT_NAMES.test(v) && /^font/.test(prop)) out.push([line, `font name in ${prop}`]);
    if (/^border(-[a-z]+)*-radius$/.test(prop) && !/var\(--(r|radius)-/.test(v) && !/^(0|50%|inherit)$/.test(v)) out.push([line, `radius must be a token: ${v}`]);
    if (prop === 'box-shadow' && !/^(var\(--shadow-[\w-]+\)|none)$/.test(v)) out.push([line, `shadow must be a token: ${v}`]);
    if (/^(transition|animation)(-duration|-delay)?$/.test(prop)) {
      const raw = v.replace(/var\([^)]*\)/g, '').replace(/calc\([^)]*\)/g, '').match(/\b(?!0m?s\b)\d*\.?\d+m?s\b/);
      if (raw) out.push([line, `motion duration must be a token: ${raw[0]}`]);
    }
    if (/^(transition|animation)(-timing-function)?$/.test(prop) && /\b(ease|ease-in|ease-out|ease-in-out)\b/.test(v.replace(/var\([^)]*\)/g, ''))) {
      out.push([line, `easing must be a token (var(--motion-ease)): ${v}`]);
    }
    if (SPACING.test(prop)) {
      const raw = v.replace(/var\([^)]*\)/g, '').replace(/calc\([^)]*\)/g, '').match(/(?<![\w-])(?!0(?:px)?\b|1px\b)\d*\.?\d+(px|rem|em)\b/);
      if (raw) out.push([line, `spacing must be a space token: ${prop}: ${v}`]);
    }
  }
  return out;
}

function jsProblems(js, ctx) {
  const out = [];
  const lineOf = (i) => js.slice(0, i).split('\n').length;
  out.push(...varProblems(js, lineOf, ctx).filter(([, msg]) => !msg.includes('only a design system sets it')));
  for (const m of js.matchAll(/['"`]#[0-9a-fA-F]{3,8}['"`]|\b(rgba?|hsla?)\(\s*\d/g)) out.push([lineOf(m.index), `raw color in script: ${m[0]}`]);
  for (const m of js.matchAll(/cubic-bezier\(/g)) out.push([lineOf(m.index), 'raw easing curve in script']);
  for (const m of js.matchAll(/(fill|stroke)="(?!currentColor|none)[^"]+"/g)) out.push([lineOf(m.index), `inline SVG color: ${m[0]}`]);
  for (const m of js.matchAll(/\.style\.(color|background|fontFamily|font|borderRadius|boxShadow|transition|animation)\s*=/g)) out.push([lineOf(m.index), `inline style.${m[1]} bypasses tokens`]);
  for (const m of js.matchAll(/\btransition:\s*([^;"'`]+)/g)) out.push(...transitionProblems(m[1].trim(), lineOf(m.index)));
  for (const m of js.matchAll(/\.animate\(/g)) out.push([lineOf(m.index), 'animate() bypasses the motion tokens: use a CSS class']);
  // Styles a script writes: the designed scales hold there too. A declaration whose value is
  // computed (\${…}) is measured geometry (a skeleton copying a layout), not a choice.
  for (const m of js.matchAll(/style="([^"]*)"/g)) {
    for (const d of m[1].matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)) {
      const v = d[2].trim();
      if (v.includes('${')) continue;
      for (const msg of scaleProblems(d[1], v, ctx.local)) out.push([lineOf(m.index), msg]);
    }
  }
  for (const m of js.matchAll(/\.style\.(padding|margin|gap|rowGap|columnGap|inset|fontSize|lineHeight|borderRadius)(\w*)\s*=\s*([^;\n]+)/g)) {
    const v = m[3].trim();
    if (/^['"`].*\d(px|rem|em)?['"`]$/.test(v) || /^\d/.test(v)) out.push([lineOf(m.index), `inline style.${m[1]}${m[2]} with a raw value bypasses the designed scales: ${v}`]);
  }
  // One icon set at one stroke weight (DESIGN-SYSTEM §2.1).
  for (const m of js.matchAll(/stroke-width="([\d.]+)"/g)) if (Number(m[1]) !== ICON_STROKE) out.push([lineOf(m.index), `icon stroke ${m[1]}: Nova's one icon set is drawn at ${ICON_STROKE} (ICONS in ui/js/components.js)`]);
  for (const m of js.matchAll(EMOJI_ALL)) out.push([lineOf(m.index), `emoji ${m[0]}: icons come from the one icon set`]);
  return out;
}

function htmlProblems(html, ctx) {
  const out = [];
  const lineOf = (i) => html.slice(0, i).split('\n').length;
  for (const m of html.matchAll(/stroke-width="([\d.]+)"/g)) if (Number(m[1]) !== ICON_STROKE) out.push([lineOf(m.index), `icon stroke ${m[1]}: Nova's one icon set is drawn at ${ICON_STROKE}`]);
  for (const m of html.matchAll(EMOJI_ALL)) out.push([lineOf(m.index), `emoji ${m[0]}: icons come from the one icon set`]);
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) out.push(...cssProblems(m[1], ctx));
  for (const m of html.matchAll(/style="([^"]*)"/g)) out.push(...cssProblems(`x{${m[1]}}`, ctx));
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) out.push(...jsProblems(m[1], ctx));
  return out;
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return ['.css', '.js', '.html'].includes(extname(p)) ? [p] : [];
  });
}

// `local` is every custom property ui/ declares; pass it when linting one file on its own.
export function lint(path, text = readFileSync(path, 'utf8'), local = declared(text)) {
  const rel = relative('.', path);
  const ctx = { path: rel, local };
  const ext = extname(path);
  return ext === '.css' ? cssProblems(text, ctx) : ext === '.js' ? jsProblems(text, ctx) : htmlProblems(text, ctx);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : files(UI);
  const local = new Set(files(UI).flatMap((f) => [...declared(readFileSync(f, 'utf8'))]).filter((n) => !SCHEMA.has(n)));
  let count = 0;
  for (const f of targets) {
    for (const [line, msg] of lint(f, readFileSync(f, 'utf8'), local)) { console.log(`${relative('.', f)}:${line}  ${msg}`); count++; }
  }
  if (count) { console.log(`\n✗ ${count} problem${count === 1 ? '' : 's'}. Use a token from the design-system schema (GET /api/v1/design-systems/schema).`); process.exit(1); }
  console.log(`✓ token lint: ${targets.length} files reference only schema tokens; no hardcoded colors, fonts, radii, shadows or motion values; spacing, type and radius on the designed scales; one icon stroke; no decorative gradients or emoji`);
}
