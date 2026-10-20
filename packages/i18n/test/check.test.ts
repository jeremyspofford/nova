import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectFromSource, compareTranslation, runI18nCheck } from '../src/check.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'nova-i18n-'));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const opts = (root: string, write = false) => ({
  root,
  sources: ['src'],
  catalog: 'src/catalog.en.json',
  locales: 'src/locales',
  write,
});

const AREA = `import { defineMessages } from '@nova/i18n';
export const S = defineMessages('area', {
  title: 'Area',
  count: '{n, plural, one {# thing} other {# things}}',
  long: 'A long message ' + 'split in two',
  group: { label: 'Group {name}' },
});
`;

describe('collectFromSource', () => {
  it('collects literal messages with nested keys and concatenation', () => {
    const c = collectFromSource('src/a.ts', AREA);
    expect(c.problems).toEqual([]);
    expect(c.messages.map((m) => [m.id, m.source, m.line])).toEqual([
      ['area.title', 'Area', 3],
      ['area.count', '{n, plural, one {# thing} other {# things}}', 4],
      ['area.long', 'A long message split in two', 5],
      ['area.group.label', 'Group {name}', 6],
    ]);
  });

  it('rejects non-literal arguments, spreads, computed keys and bad syntax', () => {
    const c = collectFromSource(
      'src/b.tsx',
      `const ns = 'x';
defineMessages(ns, {});
defineMessages('ok', OTHER);
defineMessages('Bad', {});
defineMessages('fine', { ...base, [k]: 'v', a: label, b: \`t \${x}\`, c: 'broken {', 'd.e': 'x' });`,
    );
    expect(c.problems.join('\n')).toMatchInlineSnapshot(`
      "src/b.tsx:2: defineMessages needs a literal namespace as its first argument
      src/b.tsx:3: defineMessages("ok") needs a literal object
      src/b.tsx:4: invalid namespace "Bad" (lower camel case, dots between)
      src/b.tsx:5: fine: only "key: 'message'" entries are allowed (no spreads, shorthand or methods)
      src/b.tsx:5: fine: message keys must be literal (no computed keys)
      src/b.tsx:5: fine.a: the message must be a string literal, not an expression
      src/b.tsx:5: fine.b: the message must be a string literal, not an expression
      src/b.tsx:5: fine.c: expected an argument name at offset 8
      src/b.tsx:5: fine: key "d.e" may not contain dots or spaces"
    `);
  });

  it('accepts `as const` and `satisfies` around the literal', () => {
    const c = collectFromSource(
      'src/c.ts',
      `defineMessages('x', { a: 'A', b: { c: 'C' } as const } as const);\ndefineMessages('y', ({ d: 'D' }) satisfies object);`,
    );
    expect(c.problems).toEqual([]);
    expect(c.messages.map((m) => m.id)).toEqual(['x.a', 'x.b.c', 'y.d']);
  });

  it('skips files without defineMessages quickly', () => {
    expect(collectFromSource('src/c.ts', 'export const x = 1;')).toEqual({
      messages: [],
      namespaces: [],
      problems: [],
    });
  });
});

describe('runI18nCheck', () => {
  it('writes a sorted, stable catalog and then passes; a stale catalog fails', () => {
    const root = repo({ 'src/a.ts': AREA });
    expect(runI18nCheck(opts(root)).problems).toEqual([
      'src/catalog.en.json is out of date: run npm run i18n:write',
    ]);
    const wrote = runI18nCheck(opts(root, true));
    expect(wrote).toMatchObject({ ok: true, wrote: true, messages: 4 });
    const text = readFileSync(join(root, 'src/catalog.en.json'), 'utf8');
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'area.count',
      'area.group.label',
      'area.long',
      'area.title',
    ]);
    expect(runI18nCheck(opts(root, true)).wrote).toBe(false);
    expect(runI18nCheck(opts(root)).ok).toBe(true);
    writeFileSync(join(root, 'src/a.ts'), AREA.replace("'Area'", "'Area two'"));
    expect(runI18nCheck(opts(root)).ok).toBe(false);
  });

  it('fails on duplicate namespaces and ids, ignoring tests', () => {
    const root = repo({
      'src/a.ts': AREA,
      'src/b.ts': `defineMessages('area', { other: 'x' });\ndefineMessages('area.group', { label: 'y' });`,
      'src/a.test.ts': `defineMessages('area', { ignored: 'z' });`,
    });
    const r = runI18nCheck(opts(root, true));
    expect(r.problems).toEqual([
      'src/b.ts:1: namespace "area" is already used at src/a.ts:2',
      'src/b.ts:2: message id "area.group.label" is already used at src/a.ts:6',
    ]);
  });

  it('checks translations: unknown keys and namespaces, placeholders, plural forms; reports coverage', () => {
    const root = repo({
      'src/a.ts': AREA,
      'src/locales/ar/area.json': JSON.stringify({
        title: 'المنطقة',
        count:
          '{n, plural, zero {لا شيء} one {شيء} two {شيئان} few {# أشياء} many {# شيئًا} other {# شيء}}',
        'group.label': 'مجموعة {nom}',
        gone: 'x',
      }),
      'src/locales/ar/nowhere.json': '{}',
      'src/locales/fr/area.json': JSON.stringify({
        title: 'Zone',
        count: '{n, plural, one {# chose} few {# choses} other {# choses}}',
        long: 'Un {n} long',
      }),
    });
    const r = runI18nCheck(opts(root, true));
    expect(r.problems).toEqual([
      'src/locales/ar/area.json: "group.label": missing {name}',
      'src/locales/ar/area.json: "gone" is not a message of area (removed or renamed?)',
      'src/locales/ar/nowhere.json: no messages are defined in namespace "nowhere"',
      'src/locales/fr/area.json: "count": {n} uses the plural form "few", which fr does not have',
      'src/locales/fr/area.json: "long": unknown placeholder {n}',
    ]);
    expect(r.coverage).toEqual([
      { locale: 'ar', translated: 2, total: 4 },
      { locale: 'fr', translated: 1, total: 4 },
    ]);
  });
});

describe('compareTranslation', () => {
  it('requires the same placeholders of the same kinds', () => {
    expect(compareTranslation('Hi {name}', 'Salut {name}', 'fr')).toBeNull();
    expect(compareTranslation('{n, plural, one {#} other {#}}', '{n}', 'fr')).toBe(
      '{n} is a plural in English but a placeholder here',
    );
    expect(
      compareTranslation('{k, select, a {A} other {B}}', '{k, plural, one {#} other {#}}', 'fr'),
    ).toBe('{k} is a select in English but a plural here');
    expect(compareTranslation('Hi', 'Salut {', 'fr')).toMatch(/argument name/);
  });
});
