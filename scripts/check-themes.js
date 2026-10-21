#!/usr/bin/env node
// Theme acceptance checks (THEMING.md rule 4): every contract token present,
// contrast thresholds met in each mode, and a reduced-motion rule defined.
// Usage: node scripts/check-themes.js [ui/themes/x.css ...]
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

import { CONTRACT } from '../ui/js/contract.js';

export { CONTRACT };

// [foreground, background, minimum ratio, what it guards]
const PAIRS = [
  ['--text', '--bg', 4.5, 'body text on the app background'],
  ['--text', '--surface', 4.5, 'body text on the page'],
  ['--text', '--raised', 4.5, 'text on cards'],
  ['--text', '--wash', 4.5, 'your messages'],
  ['--text', '--code-bg', 4.5, 'code'],
  ['--text-2', '--bg', 4.5, 'secondary text in the sidebar'],
  ['--text-2', '--surface', 4.5, 'secondary text on the page'],
  ['--text-3', '--bg', 3, 'tertiary labels in the sidebar'],
  ['--text-3', '--surface', 3, 'tertiary labels and hints'],
  ['--accent', '--surface', 4.5, 'links and margin notes'],
  ['--accent', '--bg', 3, 'focus ring and active marker'],
  ['--accent-text', '--accent', 4.5, 'primary button label'],
  ['--danger', '--surface', 4.5, 'error text'],
];

export function parseTheme(css) {
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  while ((m = re.exec(body))) {
    const selector = m[1].trim();
    const decls = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      const k = d.slice(0, i).trim();
      if (k.startsWith('--')) decls[k] = d.slice(i + 1).trim();
    }
    blocks.push({ selector, decls });
  }
  const base = blocks.find((b) => /^:root\[data-theme="[\w-]+"\]$/.test(b.selector));
  const dark = blocks.find((b) => /\[data-mode="dark"\]/.test(b.selector));
  return {
    name: base?.selector.match(/data-theme="([\w-]+)"/)?.[1],
    light: { ...(base?.decls ?? {}) },
    dark: dark ? { ...base.decls, ...dark.decls } : null,
    reducedMotion: /prefers-reduced-motion:\s*reduce/.test(css),
  };
}

function parseColor(v) {
  v = v.trim();
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return null;
}

const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3])).concat(1);

function lum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Resolve a token to an opaque color. Translucent backgrounds sit on --bg.
function solid(tokens, name) {
  const c = parseColor(tokens[name] ?? '');
  if (!c) return null;
  const bg = parseColor(tokens['--bg']);
  return c[3] < 1 ? over(c, bg) : c;
}

export function checkTheme(css) {
  const t = parseTheme(css);
  const problems = [];
  const rows = [];
  const required = Object.values(CONTRACT).flat();
  for (const tok of required) if (!(tok in t.light)) problems.push(`missing token ${tok}`);
  if (!t.reducedMotion) problems.push('no prefers-reduced-motion rule');
  for (const [mode, tokens] of [['light', t.light], ['dark', t.dark]]) {
    if (!tokens) continue;
    for (const [fg, bg, min, what] of PAIRS) {
      const b = solid(tokens, bg);
      const f0 = parseColor(tokens[fg] ?? '');
      if (!b || !f0) { problems.push(`${mode}: cannot resolve ${fg} on ${bg}`); continue; }
      const ratio = contrast(f0[3] < 1 ? over(f0, b) : f0, b);
      const ok = ratio >= min;
      rows.push({ mode, pair: `${fg} on ${bg}`, ratio: ratio.toFixed(2), min, ok, what });
      if (!ok) problems.push(`${mode}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1 (${what})`);
    }
  }
  return { name: t.name, problems, rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = 'ui/themes';
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => join(dir, f));
  let failed = 0;
  for (const f of files) {
    const { name, problems, rows } = checkTheme(readFileSync(f, 'utf8'));
    const worst = rows.reduce((w, r) => (Number(r.ratio) / r.min < Number(w.ratio) / w.min ? r : w), rows[0]);
    if (problems.length) {
      failed++;
      console.log(`✗ ${basename(f)} (${name})`);
      for (const p of problems) console.log(`    ${p}`);
    } else {
      console.log(`✓ ${basename(f)} (${name}): all contract tokens present, ${rows.length} contrast pairs pass` +
        (worst ? ` (tightest: ${worst.mode} ${worst.pair} ${worst.ratio}:1 vs ${worst.min}:1)` : ''));
    }
  }
  process.exit(failed ? 1 : 0);
}
