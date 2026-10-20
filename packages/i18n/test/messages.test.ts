import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  MessageSyntaxError,
  PDF,
  RLO,
  defineMessages,
  getLocale,
  loadLocale,
  localeDirection,
  messageArgs,
  messageFor,
  parseMessage,
  richMessage,
  pseudoLocalize,
  registerCatalog,
  resetI18n,
  serializeMessage,
  setCatalogLoader,
  setLocale,
  subscribe,
  type MessageParamsOf,
} from '../src/index.ts';

afterEach(() => resetI18n());

const S = defineMessages('test.basic', {
  title: 'Marketplace',
  resets: 'Resets {date}',
  items: '{n, plural, =0 {No items} one {# item} other {# items}}',
  kind: '{kind, select, editor {Editor pane} preview {Preview pane} other {Pane}}',
  nested: '{n, plural, one {# file in {folder}} other {# files in {folder}}}',
  quoted: "Use '{'braces'}' and don't worry",
  group: { label: 'Label', hint: 'Hint for {name}' },
});

describe('defineMessages', () => {
  it('reads plain messages as strings and placeholder messages as functions', () => {
    expect(S.title).toBe('Marketplace');
    expect(S.resets({ date: 'Oct 5' })).toBe('Resets Oct 5');
    expect(S.group.label).toBe('Label');
    expect(S.group.hint({ name: 'Pat' })).toBe('Hint for Pat');
  });

  it('types placeholders from the literal', () => {
    expectTypeOf(S.title).toEqualTypeOf<string>();
    expectTypeOf(S.resets).parameter(0).toEqualTypeOf<{ date: string | number }>();
    expectTypeOf(S.items).parameter(0).toEqualTypeOf<{ n: number }>();
    expectTypeOf(S.kind).parameter(0).toEqualTypeOf<{ kind: string }>();
    expectTypeOf(S.nested).parameter(0).toEqualTypeOf<{ n: number; folder: string | number }>();
    expectTypeOf(S.quoted).toEqualTypeOf<string>();
    expectTypeOf<MessageParamsOf<"It's {a} and '{'b'}'">>().toEqualTypeOf<{
      a: string | number;
    }>();
    // @ts-expect-error a message with placeholders needs its params
    S.resets();
    // @ts-expect-error a plural argument is a number
    S.items({ n: 'two' });
  });

  it('formats plurals with #, =N and the locale categories', () => {
    expect(S.items({ n: 0 })).toBe('No items');
    expect(S.items({ n: 1 })).toBe('1 item');
    expect(S.items({ n: 1234 })).toBe('1,234 items');
    expect(S.nested({ n: 2, folder: 'docs' })).toBe('2 files in docs');
  });

  it('formats selects with an other fallback', () => {
    expect(S.kind({ kind: 'editor' })).toBe('Editor pane');
    expect(S.kind({ kind: 'nothing-like-it' })).toBe('Pane');
  });

  it('keeps quoted braces literal and apostrophes as text', () => {
    expect(S.quoted).toBe("Use {braces} and don't worry");
  });

  it('shows a missing param as its placeholder instead of failing', () => {
    const loose = S.resets as unknown as (p: object) => string;
    expect(loose({})).toBe('Resets {date}');
    const plural = S.items as unknown as (p: object) => string;
    expect(plural({})).toBe('{n}');
  });

  it('refuses a bad namespace or key', () => {
    expect(() => defineMessages('Bad Name', { a: 'x' })).toThrow(/namespace/);
    expect(() => defineMessages('test.badKey', { 'a.b': 'x' })).toThrow(/key/);
  });
});

describe('the ICU subset parser', () => {
  it('reports syntax errors with an offset', () => {
    expect(() => parseMessage('Hello {name')).toThrow(MessageSyntaxError);
    expect(() => parseMessage('Hello }')).toThrow(/unmatched/);
    expect(() => parseMessage('{n, plural, one {x}}')).toThrow(/other/);
    expect(() => parseMessage('{n, plural, lots {x} other {y}}')).toThrow(/plural category/);
    expect(() => parseMessage('{n, number}')).toThrow(/unsupported/);
    expect(() => parseMessage("'{unterminated")).toThrow(/quote/);
  });

  it('lists arguments with their strongest kind', () => {
    const args = messageArgs(
      parseMessage('{n, plural, one {{n} and {who}} other {#}} {g, select, a {} other {}}'),
    );
    expect(Object.fromEntries(args)).toEqual({ n: 'plural', who: 'arg', g: 'select' });
  });

  it('serializes back to an equivalent message', () => {
    const src = "{n, plural, =0 {none '#'} one {# it''s {x}} other {'{'#'}'}}";
    const again = serializeMessage(parseMessage(src));
    expect(parseMessage(again)).toEqual(parseMessage(src));
  });

  it('keeps literal braces and apostrophes side by side when serializing', () => {
    for (const text of ['}}', '{{', "}'}", "{'", "'{", "a {b} c '}' d", "x''y", '#{#}#']) {
      const nodes = [{ type: 'text' as const, value: text }];
      expect(parseMessage(serializeMessage(nodes)), text).toEqual(nodes);
      // Inside a plural, `#` is syntax too.
      const plural = parseMessage(`{n, plural, other {${serializeMessage(nodes, true)}}}`)[0];
      expect(plural?.type === 'plural' && plural.options['other'], text).toEqual(nodes);
    }
  });
});

describe('locales and catalogs', () => {
  it('notifies subscribers and canonicalizes tags', () => {
    const seen: string[] = [];
    const off = subscribe(() => seen.push(getLocale()));
    setLocale('AR');
    setLocale('ar');
    off();
    setLocale('en');
    expect(seen).toEqual(['ar']);
  });

  it('translates from a registered catalog and falls back to the source', () => {
    registerCatalog('ar', 'test.basic', { title: 'المتجر', 'group.label': 'التسمية' });
    setLocale('ar');
    expect(S.title).toBe('المتجر');
    expect(S.group.label).toBe('التسمية');
    // Not translated: English, with English plural rules.
    expect(S.items({ n: 2 })).toBe('2 items');
    // A regional tag uses the base language's catalog.
    setLocale('ar-EG');
    expect(S.title).toBe('المتجر');
  });

  it('uses the six Arabic plural forms', () => {
    const P = defineMessages('test.arPlural', {
      files: '{n, plural, one {# file} other {# files}}',
    });
    registerCatalog('ar', 'test.arPlural', {
      files:
        '{n, plural, zero {لا ملفات} one {ملف واحد} two {ملفان} few {# ملفات} many {# ملفًا} other {# ملف}}',
    });
    setLocale('ar');
    const out = [0, 1, 2, 3, 11, 100].map((n) => P.files({ n }));
    expect(out[0]).toBe('لا ملفات');
    expect(out[1]).toBe('ملف واحد');
    expect(out[2]).toBe('ملفان');
    expect(out[3]).toMatch(/ملفات$/);
    expect(out[4]).toMatch(/ملفًا$/);
    expect(out[5]).toMatch(/ملف$/);
    // English has only one and other.
    setLocale('en');
    expect([0, 1, 2].map((n) => P.files({ n }))).toEqual(['0 files', '1 file', '2 files']);
  });

  it('falls back to the source when a translation does not parse', () => {
    registerCatalog('ar', 'test.basic', { resets: 'broken {date' });
    setLocale('ar');
    expect(S.resets({ date: 'x' })).toBe('Resets x');
  });

  it('ignores unknown keys in a catalog', () => {
    registerCatalog('ar', 'test.basic', { nope: 'لا' });
    setLocale('ar');
    expect(S.title).toBe('Marketplace');
  });

  it('loads catalogs once through the loader, the base language too', async () => {
    const asked: string[] = [];
    setCatalogLoader((locale) => {
      asked.push(locale);
      return Promise.resolve(
        locale === 'ar' ? [{ namespace: 'test.basic', entries: { title: 'المتجر' } }] : [],
      );
    });
    await loadLocale('ar-EG');
    await loadLocale('ar');
    await loadLocale('en');
    await loadLocale('en-XA');
    expect(asked.sort()).toEqual(['ar', 'ar-EG']);
    setLocale('ar-EG');
    expect(S.title).toBe('المتجر');
  });

  it('lets a failed load be retried', async () => {
    let fail = true;
    setCatalogLoader(() => (fail ? Promise.reject(new Error('offline')) : Promise.resolve([])));
    await expect(loadLocale('ar')).rejects.toThrow('offline');
    fail = false;
    await expect(loadLocale('ar')).resolves.toBeUndefined();
  });

  it('knows each locale’s direction', () => {
    expect(localeDirection('en')).toBe('ltr');
    expect(localeDirection('en-XA')).toBe('ltr');
    expect(localeDirection('ar')).toBe('rtl');
    expect(localeDirection('ar-XB')).toBe('rtl');
    expect(localeDirection('he')).toBe('rtl');
    expect(localeDirection('fa')).toBe('rtl');
    expect(localeDirection('ur')).toBe('rtl');
    expect(localeDirection('dv')).toBe('rtl');
    expect(localeDirection('ja')).toBe('ltr');
    expect(localeDirection('not a tag')).toBe('ltr');
  });
});

describe('pseudo-locales', () => {
  it('en-XA accents, brackets and lengthens while keeping placeholders and syntax', () => {
    const out = pseudoLocalize('Resets {date}', 'en-XA');
    expect(out).toMatch(/^\[Ŕéšéţš \{date\} .+\]$/);
    expect(out.length).toBeGreaterThan('Resets {date}'.length);
    const plural = pseudoLocalize('{n, plural, one {# item} other {# items}}', 'en-XA');
    expect(messageArgs(parseMessage(plural))).toEqual(new Map([['n', 'plural']]));
    expect(plural).toContain('# îţéɱ');
  });

  it('en-XA output of a whole screen string has no plain ASCII letters', () => {
    setLocale('en-XA');
    expect(S.title).not.toMatch(/[A-Za-z]/);
    expect(S.items({ n: 3 })).not.toMatch(/[A-Za-z]/);
    expect(S.resets({ date: 'Oct 5' })).toContain('Oct 5');
    expect(S.quoted).toContain('{ƀŕåçéš}');
  });

  it('ar-XB mirrors every word between bidi controls and keeps placeholders', () => {
    const out = pseudoLocalize('Hint for {name}', 'ar-XB');
    expect(out).toContain('{name}');
    expect(out).toContain(`${RLO}Hint${PDF}`);
    setLocale('ar-XB');
    const text = S.group.hint({ name: 'Pat' });
    expect(text.replace(/\u200F\u202E[^\u202C]*\u202C\u200F/g, '')).toBe('  Pat');
  });

  it('leaves a message that does not parse alone', () => {
    expect(pseudoLocalize('broken {', 'en-XA')).toBe('broken {');
  });
});

describe('messageFor', () => {
  it('reads a message by a runtime key, translated, or undefined', () => {
    const R = defineMessages('test.lookup', { not_found: 'Not found', group: { a: 'A' } });
    registerCatalog('ar', 'test.lookup', { not_found: 'غير موجود' });
    expect(messageFor(R, 'not_found')).toBe('Not found');
    expect(messageFor(R, 'nope')).toBeUndefined();
    expect(messageFor(R, 'group')).toBeUndefined();
    expect(messageFor(R, 'toString')).toBeUndefined();
    setLocale('ar');
    expect(messageFor(R, 'not_found')).toBe('غير موجود');
  });
});

describe('richMessage', () => {
  const R = defineMessages('test.rich', {
    press: 'Press {stop} or {key} to stop.',
    swapped: '{b} then {a}',
    files:
      '{n, plural, one {# file} other {# files}} in {link}; {kind, select, mine {yours} other {shared}}',
  });

  it('puts element values where the placeholders fall, in the translation’s order', () => {
    const stop = { el: 'strong' };
    const key = { el: 'kbd' };
    expect(richMessage(R.press, { stop, key })).toEqual(['Press ', stop, ' or ', key, ' to stop.']);
    registerCatalog('ar', 'test.rich', { swapped: 'أولًا {a} ثم {b}' });
    setLocale('ar');
    const a = { el: 'a' };
    const b = { el: 'b' };
    expect(richMessage(R.swapped, { a, b })).toEqual(['أولًا ', a, ' ثم ', b]);
  });

  it('passes strings and numbers into the message, so plural and select still choose', () => {
    const link = { el: 'a' };
    expect(richMessage(R.files, { n: 1, link, kind: 'mine' })).toEqual([
      '1 file in ',
      link,
      '; yours',
    ]);
    expect(richMessage(R.files, { n: 3, link, kind: 'team' })).toEqual([
      '3 files in ',
      link,
      '; shared',
    ]);
  });

  it('keeps placeholders intact under the pseudo-locales', () => {
    setLocale('en-XA');
    const stop = { el: 'strong' };
    const parts = richMessage(R.press, { stop, key: 'K' });
    expect(parts).toContain(stop);
    expect(parts.map((p) => (typeof p === 'string' ? p : 'S')).join('')).toMatch(
      /^\[Þŕéšš S öŕ K ţö šţöþ\. .*\]$/,
    );
  });
});
