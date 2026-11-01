// The token lint's designed-scale rules (DESIGN-SYSTEM §0 and §2.1; owner direction 2026-11-01):
// off-scale spacing, type and radius, the pill on something that grows, decorative gradients, a
// second icon stroke and emoji, in CSS and in the styles scripts write. Each fails with file:line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { lint, scaleProblems } from '../scripts/lint-tokens.js';
import { ICON_STROKE, SPACE_SCALE, packageScaleFindings, scaleFindings } from '../src/core/index.ts';

const msgs = (text, path = 'ui/x.css') => lint(path, text).map((p) => p[1]);
const one = (text, re, path) => {
  const m = msgs(text, path);
  assert.equal(m.length, 1, `${text}: ${JSON.stringify(m)}`);
  assert.match(m[0], re);
};

test('spacing: one step of the 4pt scale, never a half step, a sum or another family', () => {
  one('.a{gap:calc(var(--space-1) / 2)}', /off-scale spacing: gap: calc\(var\(--space-1\) \/ 2\)/);
  one('.a{padding:calc(var(--space-1) / 2) var(--space-3)}', /off-scale spacing/);
  one('.a{margin:calc(var(--space-4) + var(--space-1))}', /off-scale spacing/);
  one('.a{margin-top:calc(var(--space-2) * 1.5)}', /off-scale spacing/);
  one('.a{padding:var(--type-body)}', /takes a space token, not var\(--type-body\)/);
  one('.a{padding:13px}', /spacing must be a space token/);
  // On the scale: a step, its negative, a hairline beside it, safe areas and derived geometry.
  for (const ok of ['.a{padding:var(--space-3) var(--space-5)}', '.a{margin:0 calc(-1 * var(--space-3))}', '.a{margin:calc(-1 * var(--space-1) - 1px) 0}',
    '.a{padding-bottom:calc(var(--space-2) + env(safe-area-inset-bottom))}', '.a{inset:auto auto var(--space-5) calc(var(--layout-rail-width) + var(--space-2))}',
    '.a{--hit:44px}.b{padding-block:max(0px, calc((var(--hit) - 1lh) / 2))}', '.a{padding:0 1px}']) assert.deepEqual(msgs(ok), [], ok);
});

test('type: the type scale’s own tokens for size and line height', () => {
  one('.a{font-size:var(--space-4)}', /off-scale type: font-size takes a type size token/);
  one('.a{line-height:var(--space-5)}', /off-scale type: line-height/);
  one('.a{font:var(--type-weight-regular) var(--space-4)/var(--type-line-body) var(--font-body)}', /off-scale type: font size var\(--space-4\)/);
  one('.a{font:var(--type-weight-regular) var(--type-body)/var(--space-5) var(--font-body)}', /off-scale type: line height var\(--space-5\)/);
  assert.deepEqual(msgs('.a{font:var(--type-weight-strong) var(--type-h3)/var(--type-line-tight) var(--font-display)}'), []);
});

test('radius: one token by size class; never a fraction, and never the pill on what grows', () => {
  one('.a{border-radius:calc(var(--radius-input) * 0.5)}', /off-scale radius/);
  assert.ok(msgs('.a{border-radius:var(--space-2)}').some((m) => /off-scale radius/.test(m)), 'a space token is not a radius');
  one('.composer{border-radius:var(--radius-pill)}', /pill radius on something that grows \(\.composer\)/);
  one('.composer.is-grown, textarea{border-radius:var(--radius-pill)}', /pill radius on something that grows/);
  one('.btn{border-radius:var(--radius-pill)}', /pill radius/);
  one('.toast{border-radius:var(--radius-pill)}', /a container takes --radius-card, a control --radius-input/);
  for (const ok of ['.status{border-radius:var(--radius-pill)}', '.icon-btn{border-radius:var(--radius-pill)}', '.toast::before{border-radius:var(--radius-pill)}',
    '.card{border-radius:var(--radius-card)}', '.sheet{border-radius:var(--radius-card) var(--radius-card) 0 0}', '.orb{border-radius:50%}']) assert.deepEqual(msgs(ok), [], ok);
});

test('gradients light the orb and the page, nothing else; no emoji', () => {
  one('.card{background:linear-gradient(var(--bg-base), var(--bg-raised))}', /decorative gradient on \.card/);
  assert.deepEqual(msgs('body{background:linear-gradient(var(--bg-raised), var(--bg-base))}.orb-core{background:radial-gradient(var(--orb-core), var(--orb-glow))}'), []);
  one('.a::before{content:"✨"}', /emoji/);
  one('const x = `<span>🚀 Done</span>`;', /emoji 🚀: icons come from the one icon set/, 'ui/x.js');
});

test('scripts: the styles they write and the icons they draw', () => {
  one('const x = `<p style="padding: calc(var(--space-1) / 2)">`;', /off-scale spacing/, 'ui/x.js');
  one('const x = `<p style="font-size: var(--space-4)">`;', /off-scale type/, 'ui/x.js');
  one('el.style.padding = "13px";', /inline style\.padding with a raw value/, 'ui/x.js');
  one(`const i = '<svg><path stroke-width="1.8"/></svg>';`, new RegExp(`icon stroke 1.8: .* drawn at ${ICON_STROKE}`), 'ui/x.js');
  // Measured geometry is not a choice: a skeleton copying a layout.
  assert.deepEqual(msgs('const x = `<i style="left: ${x}px; border-radius: ${b.radius}">`;', 'ui/x.js'), []);
  assert.deepEqual(msgs(`const i = '<svg><g stroke-width="${ICON_STROKE}"/></svg>'; el.style.height = \`\${h}px\`;`, 'ui/x.js'), []);
});

test('the command fails on an off-scale value, with file:line, and passes once it is gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-lint-scales-'));
  try {
    const f = join(dir, 'probe.css');
    writeFileSync(f, '.probe {\n  padding: var(--space-3);\n  gap: calc(var(--space-1) / 2);\n}\n');
    let out = '';
    let code = 0;
    try { execFileSync(process.execPath, ['scripts/lint-tokens.js', f], { encoding: 'utf8' }); } catch (e) { out = e.stdout; code = e.status; }
    assert.equal(code, 1);
    assert.match(out, /probe\.css:3 {2}off-scale spacing: gap: calc\(var\(--space-1\) \/ 2\)/);
    writeFileSync(f, '.probe {\n  padding: var(--space-3);\n  gap: var(--space-1);\n}\n');
    assert.match(execFileSync(process.execPath, ['scripts/lint-tokens.js', f], { encoding: 'utf8' }), /✓ token lint/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('all of ui/ is on the designed scales', () => {
  const files = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : ['.css', '.js', '.html'].includes(extname(p)) ? [p] : []; });
  const off = files('ui').flatMap((f) => lint(f).filter(([, m]) => /off-scale|pill radius|decorative gradient|icon stroke|emoji/.test(m)).map(([l, m]) => `${f}:${l} ${m}`));
  assert.deepEqual(off, []);
  assert.deepEqual(scaleProblems('gap', 'var(--space-2)'), []);
});

test('the packages: the lead is on the scales; spacing is the system’s in every package', () => {
  const pkg = (id) => JSON.parse(readFileSync(`design-systems/${id}.json`, 'utf8'));
  assert.deepEqual(packageScaleFindings(pkg('orb-teal')), []);
  for (const f of readdirSync('design-systems')) {
    const t = JSON.parse(readFileSync(`design-systems/${f}`, 'utf8')).tokens;
    for (const [n, { px }] of Object.entries(SPACE_SCALE)) assert.equal(t[n], `${px}px`, `${f} ${n}`);
  }
  const lead = pkg('orb-teal').tokens;
  assert.match(scaleFindings({ ...lead, 'type/h3': '17px' }).join(' '), /type\/h3 is 17px/);
  assert.match(scaleFindings({ ...lead, 'radius/card': '6px' }).join(' '), /radius\/card|smaller than radius\/card/);
  assert.match(scaleFindings({ ...lead, 'shadow/raised': '0 1px 1px rgba(0, 0, 0, 0.2)' }).join(' '), /two levels/);
  assert.match(scaleFindings({ ...lead, 'motion/pulse': '1700ms' }).join(' '), /whole multiple/);
  assert.match(scaleFindings({ ...lead, 'space/3': '10px' }).join(' '), /spacing scale is the system’s/);
});
