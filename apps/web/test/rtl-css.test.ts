// Right-to-left layout guard (FR-016, D9; docs/04 §4.5). Every stylesheet of the web UI, the
// shared components and the desktop renderer, and every inline `style={…}` in their TSX, uses
// logical properties (`margin-inline-start`, `inset-inline-end`, `text-align: start`,
// `border-start-start-radius`…), so the layout mirrors by itself under `dir="rtl"`. A physical
// left or right is allowed only where it is listed below with its reason.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const SCANNED = ['packages/ui/src', 'apps/web/src', 'apps/desktop/src'];

/**
 * Genuinely physical declarations: the file, the rule's selector (CSS) or `style` (TSX), the
 * property, and why it must not follow the reading direction.
 */
const ALLOWED: readonly { file: string; where: string; property: string; reason: string }[] = [
  {
    file: 'packages/ui/src/tokens.css',
    where: '.nv-tooltip',
    property: 'left',
    reason:
      'centred over its anchor: left 50% with translateX(-50%) is the same in both directions',
  },
  {
    file: 'packages/ui/src/tokens.css',
    where: '.nv-tooltip',
    property: 'transform',
    reason: 'the -50% shift that centres the tooltip (see left)',
  },
  {
    file: 'apps/web/src/computers/computers.css',
    where: '.shot-img',
    property: 'object-position',
    reason: 'a thumbnail of another computer’s screen keeps that screen’s top-left corner',
  },
  {
    file: 'packages/ui/src/components/Menu.tsx',
    where: 'style',
    property: 'left',
    reason: 'a context menu opens at the pointer, whose clientX is a physical coordinate',
  },
  {
    file: 'apps/web/src/apps/McpAppFrame.tsx',
    where: 'style',
    property: 'right',
    reason:
      'a free-floating picture-in-picture window the user drags; its offset is physical pixels',
  },
  {
    file: 'apps/web/src/spaces/Visualization.tsx',
    where: 'style',
    property: 'left',
    reason: 'a label placed over an SVG point, in the drawing’s own (unmirrored) coordinates',
  },
];

interface Finding {
  file: string;
  line: number;
  where: string;
  property: string;
  value: string;
  why: string;
}

// ---- CSS ------------------------------------------------------------------------------------------

interface Declaration {
  selector: string;
  property: string;
  value: string;
  line: number;
}

/** The declarations of a stylesheet with the selector of the rule each sits in (no nesting). */
function declarations(css: string): Declaration[] {
  // Comments become spaces of the same length, newlines kept, so offsets keep their line.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out: Declaration[] = [];
  const stack: string[] = [];
  let buf = '';
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  const lineAt = (i: number) => text.slice(0, i).split('\n').length;
  const flush = () => {
    const at = buf.search(/\S/);
    const decl = buf.trim();
    const colon = decl.indexOf(':');
    if (colon > 0 && stack.length) {
      out.push({
        selector: stack[stack.length - 1]!,
        property: decl.slice(0, colon).trim().toLowerCase(),
        value: decl.slice(colon + 1).trim(),
        line: lineAt(start + Math.max(0, at)),
      });
    }
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!buf) start = i;
    if (quote) {
      if (c === quote) quote = null;
      buf += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && c === '{') {
      stack.push(buf.trim().replace(/\s+/g, ' '));
      buf = '';
      continue;
    } else if (depth === 0 && c === ';') {
      flush();
      continue;
    } else if (depth === 0 && c === '}') {
      flush();
      stack.pop();
      continue;
    }
    buf += c;
  }
  return out;
}

/** Top-level space-separated tokens of a value (parentheses kept whole). */
function tokens(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const c of value) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && /\s/.test(c)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const isZero = (t: string | undefined) => t === undefined || /^[-+]?0+(\.0+)?[a-z%]*$/i.test(t);

const SIDES =
  /^(margin|padding|inset|scroll-margin|scroll-padding|border-width|border-style|border-color)$/;
const SIDE_KEYWORDS =
  /^(text-align|text-align-last|float|clear|justify-content|justify-items|justify-self|caption-side)$/;
const POSITIONS =
  /^(background|background-position|background-position-x|transform-origin|object-position|mask|mask-position|perspective-origin|offset-position)$/;

/** Why a CSS declaration is physical (left or right), or null when it is logical or symmetric. */
function physicalCss(property: string, value: string): string | null {
  if (property.startsWith('--')) return null;
  if (/(^|-)(left|right)(-|$)/.test(property)) return `${property} is a physical side`;
  if (SIDE_KEYWORDS.test(property) && /\b(left|right)\b/.test(value))
    return `${property}: ${value} names a physical side (use start/end)`;
  if (POSITIONS.test(property) && /\b(left|right)\b/.test(value))
    return `${property} positions from a physical side`;
  if (/\bto\s+(left|right)\b/.test(value) || /\bat\s+(left|right)\b/.test(value))
    return 'a gradient toward a physical side';
  if (property === 'cursor' && /(^|\s)(e|w|ne|nw|se|sw)-resize\b/.test(value))
    return 'a one-sided resize cursor';
  if (SIDES.test(property)) {
    const t = tokens(value);
    if (t.length === 4 && t[1] !== t[3]) return `${property} with different right and left values`;
  }
  if (property === 'border-radius') {
    for (const part of value.split('/')) {
      const t = tokens(part.trim());
      const lopsided =
        (t.length === 2 && t[0] !== t[1]) ||
        (t.length === 3 && !(t[0] === t[1] && t[1] === t[2])) ||
        (t.length === 4 && (t[0] !== t[1] || t[2] !== t[3]));
      if (lopsided) return 'border-radius rounding one side (use border-start-start-radius…)';
    }
  }
  if (property === 'translate' && !isZero(tokens(value)[0])) return 'a horizontal translation';
  if (property === 'transform') {
    for (const m of value.matchAll(/translate(?:X|3d)?\(\s*([^,)\s]+)/g))
      if (!isZero(m[1])) return 'a horizontal translation';
  }
  if (property === 'box-shadow' || property === 'text-shadow') {
    for (const shadow of value.split(/,(?![^(]*\))/)) {
      const lengths = tokens(shadow.trim()).filter((t) => t !== 'inset' && /^[-+]?[\d.]/.test(t));
      if (lengths.length >= 2 && !isZero(lengths[0])) return 'a shadow offset to one side';
    }
  }
  return null;
}

// ---- inline styles (TSX) --------------------------------------------------------------------------

/** Why an inline-style property (camelCase) with this literal value is physical, or null. */
function physicalStyle(property: string, value: string | null): string | null {
  if (/^(left|right)$/.test(property) || /(Left|Right)(?=[A-Z]|$)/.test(property))
    return `${property} is a physical side`;
  if (/^(textAlign|float|clear|justifyContent|justifyItems|justifySelf)$/.test(property) && value)
    if (/\b(left|right)\b/.test(value)) return `${property}: '${value}' names a physical side`;
  if ((property === 'transform' || property === 'translate') && value)
    return physicalCss(property, value);
  return null;
}

function inlineStyleFindings(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Finding[] = [];
  const literal = (e: ts.Expression | undefined): string | null =>
    e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null;
  const visitStyle = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const p of node.properties) {
        if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) continue;
        const name =
          ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : p.name.getText(sf);
        const value = ts.isPropertyAssignment(p) ? literal(p.initializer) : null;
        const why = physicalStyle(name, value);
        if (why) {
          out.push({
            file,
            line: sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1,
            where: 'style',
            property: name,
            value: ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : name,
            why,
          });
        }
      }
    }
    ts.forEachChild(node, visitStyle);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'style' && node.initializer)
      visitStyle(node.initializer);
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ---- the scan -------------------------------------------------------------------------------------

function walk(dir: string, ext: RegExp, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage')
      continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, ext, acc);
    else if (ext.test(entry.name)) acc.push(path);
  }
  return acc;
}

const rel = (path: string) => relative(ROOT, path).split('\\').join('/');
const cssFiles = SCANNED.flatMap((d) => walk(join(ROOT, d), /\.css$/)).map(rel);
const tsxFiles = SCANNED.flatMap((d) => walk(join(ROOT, d), /\.tsx$/)).map(rel);

function cssFindings(file: string): Finding[] {
  return declarations(readFileSync(join(ROOT, file), 'utf8')).flatMap((d) => {
    const why = physicalCss(d.property, d.value);
    return why
      ? [{ file, line: d.line, where: d.selector, property: d.property, value: d.value, why }]
      : [];
  });
}

const allowed = (f: Finding) =>
  ALLOWED.some((a) => a.file === f.file && a.where === f.where && a.property === f.property);

const show = (f: Finding) =>
  `${f.file}:${f.line} ${f.where} { ${f.property}: ${f.value} }: ${f.why}`;

describe('right-to-left layout: logical properties only (FR-016)', () => {
  it('finds the stylesheets and components to scan', () => {
    expect(cssFiles).toContain('packages/ui/src/tokens.css');
    expect(cssFiles).toContain('apps/web/src/app.css');
    expect(cssFiles).toContain('apps/desktop/src/renderer/shell.css');
    expect(tsxFiles.length).toBeGreaterThan(100);
  });

  it('every stylesheet uses logical properties', () => {
    const found = cssFiles.flatMap(cssFindings).filter((f) => !allowed(f));
    expect(found.map(show)).toEqual([]);
  });

  it('every inline style uses logical properties', () => {
    const found = tsxFiles
      .flatMap((f) => inlineStyleFindings(f, readFileSync(join(ROOT, f), 'utf8')))
      .filter((f) => !allowed(f));
    expect(found.map(show)).toEqual([]);
  });

  it('every allowlist entry still matches something (no stale reasons)', () => {
    const all = [
      ...cssFiles.flatMap(cssFindings),
      ...tsxFiles.flatMap((f) => inlineStyleFindings(f, readFileSync(join(ROOT, f), 'utf8'))),
    ];
    const stale = ALLOWED.filter(
      (a) =>
        !all.some((f) => a.file === f.file && a.where === f.where && a.property === f.property),
    );
    expect(stale.map((a) => `${a.file} ${a.where} ${a.property}`)).toEqual([]);
  });
});

describe('the physical-property detector', () => {
  it.each([
    ['margin-left', '4px'],
    ['padding-right', '0'],
    ['left', '0'],
    ['right', 'auto'],
    ['border-left', '4px solid red'],
    ['border-left-color', 'red'],
    ['border-top-right-radius', '4px'],
    ['scroll-margin-left', '8px'],
    ['text-align', 'left'],
    ['text-align', 'right'],
    ['float', 'left'],
    ['clear', 'right'],
    ['padding', '1px 2px 3px 4px'],
    ['margin', '0 auto 0 8px'],
    ['inset', '0 0 auto 0px'],
    ['border-radius', '4px 0 0 4px'],
    ['border-radius', '4px 0'],
    ['transform', 'translateX(16px)'],
    ['transform', 'scale(1.1) translate(-4px, 2px)'],
    ['translate', '-50% 0'],
    ['background-position', 'right 8px center'],
    ['background', 'linear-gradient(to right, red, blue)'],
    ['transform-origin', 'left center'],
    ['box-shadow', '2px 0 4px black'],
    ['cursor', 'w-resize'],
  ])('flags %s: %s', (property, value) => {
    expect(physicalCss(property, value)).not.toBeNull();
  });

  it.each([
    ['margin-inline-start', '4px'],
    ['inset-inline-end', '0'],
    ['border-inline-start', '4px solid red'],
    ['border-start-end-radius', '4px'],
    ['text-align', 'start'],
    ['text-align', 'center'],
    ['float', 'inline-start'],
    ['padding', '1px 2px 3px 2px'],
    ['margin', '0 auto'],
    ['inset', '0'],
    ['border-radius', '4px'],
    ['border-radius', '50% / 4px'],
    ['transform', 'translateY(-2px) rotate(5deg)'],
    ['transform', 'translateX(0)'],
    ['transform', 'scaleY(0.94)'],
    ['transform-origin', '50% 100%'],
    ['box-shadow', '0 8px 24px color-mix(in srgb, red 60%, transparent)'],
    ['box-shadow', 'inset 0 -2px 0 var(--u-accent)'],
    ['cursor', 'col-resize'],
    ['--u-left', '4px'],
    ['flex-direction', 'row'],
  ])('allows %s: %s', (property, value) => {
    expect(physicalCss(property, value)).toBeNull();
  });

  it('reads selectors, properties and lines, skipping comments and strings', () => {
    const css = [
      '/* left: 0 in a comment */',
      '.a,',
      '.b { margin-left: 4px; color: red }',
      "@media (max-width: 600px) { .c::after { content: 'x;y'; right: 0; } }",
    ].join('\n');
    expect(declarations(css)).toEqual([
      { selector: '.a, .b', property: 'margin-left', value: '4px', line: 3 },
      { selector: '.a, .b', property: 'color', value: 'red', line: 3 },
      { selector: '.c::after', property: 'content', value: "'x;y'", line: 4 },
      { selector: '.c::after', property: 'right', value: '0', line: 4 },
    ]);
  });

  it('finds physical inline styles in JSX, literal or computed', () => {
    const src = [
      'export const A = () => (',
      '  <div style={{ marginLeft: 4, insetInlineStart: 0, textAlign: "right" }}>',
      '    <span style={open ? { left: x } : { paddingInlineEnd: 2 }} />',
      '    <i style={{ textAlign: "start", transform: "translateX(8px)" }} />',
      '  </div>',
      ');',
    ].join('\n');
    const found = inlineStyleFindings('x.tsx', src).map((f) => `${f.line} ${f.property}`);
    expect(found).toEqual(['2 marginLeft', '2 textAlign', '3 left', '4 transform']);
  });
});
