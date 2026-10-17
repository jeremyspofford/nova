// CodeBlock and the built-in highlighter (FR-038, docs/04 §4.2).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CodeBlock, HIGHLIGHT_LIMIT, highlight, normalizeLanguage } from '../src/index.ts';

afterEach(cleanup);

const types = (code: string, lang: string) =>
  highlight(code, lang)
    .filter((t) => t.type !== 'plain')
    .map((t) => [t.type, t.text]);

describe('highlight', () => {
  it('normalizes names, aliases and extensions', () => {
    expect(normalizeLanguage('TypeScript')).toBe('js');
    expect(normalizeLanguage('.tsx')).toBe('js');
    expect(normalizeLanguage('language-py')).toBe('python');
    expect(normalizeLanguage('yml')).toBe('yaml');
    expect(normalizeLanguage('brainfuck')).toBeNull();
    expect(normalizeLanguage(null)).toBeNull();
    expect(normalizeLanguage('')).toBeNull();
  });

  it('classifies keywords, strings, numbers, comments and literals in TypeScript', () => {
    expect(types('const x = "a\\"b"; // note\nreturn 42 + 0x1f ?? null;', 'ts')).toEqual([
      ['keyword', 'const'],
      ['string', '"a\\"b"'],
      ['comment', '// note'],
      ['keyword', 'return'],
      ['number', '42'],
      ['number', '0x1f'],
      ['literal', 'null'],
    ]);
    // Words that only contain a keyword stay plain.
    expect(types('constant iffy', 'js')).toEqual([]);
  });

  it('keeps every character, in order', () => {
    const code = 'def f(x):\n    """doc"""\n    return x * 2  # twice\n';
    expect(
      highlight(code, 'python')
        .map((t) => t.text)
        .join(''),
    ).toBe(code);
    expect(types(code, 'python')).toEqual([
      ['keyword', 'def'],
      ['string', '"""doc"""'],
      ['keyword', 'return'],
      ['number', '2'],
      ['comment', '# twice'],
    ]);
  });

  it.each([
    [
      'json',
      '{"a": [1, true, "s"]}',
      [
        ['attr', '"a"'],
        ['number', '1'],
        ['literal', 'true'],
        ['string', '"s"'],
      ],
    ],
    [
      'bash',
      'echo "$HOME" # hi\nif [ -f x ]; then exit 1; fi',
      [
        ['string', '"$HOME"'],
        ['comment', '# hi'],
        ['keyword', 'if'],
        ['keyword', 'then'],
        ['keyword', 'exit'],
        ['number', '1'],
        ['keyword', 'fi'],
      ],
    ],
    [
      'sql',
      "SELECT name FROM t WHERE id = 3 -- one\n AND x = 'y'",
      [
        ['keyword', 'SELECT'],
        ['keyword', 'FROM'],
        ['keyword', 'WHERE'],
        ['number', '3'],
        ['comment', '-- one'],
        ['keyword', 'AND'],
        ['string', "'y'"],
      ],
    ],
    [
      'html',
      '<a href="x">hi</a><!-- c -->',
      [
        ['tag', '<a'],
        ['attr', 'href'],
        ['string', '"x"'],
        ['tag', '>'],
        ['tag', '</a>'],
        ['comment', '<!-- c -->'],
      ],
    ],
    [
      'css',
      '@media x { a { color: #fff; margin: 4px; } }',
      [
        ['keyword', '@media'],
        ['attr', 'color'],
        ['number', '#fff'],
        ['attr', 'margin'],
        ['number', '4px'],
      ],
    ],
    [
      'yaml',
      'name: nova # app\nport: 80\non: true',
      [
        ['attr', 'name'],
        ['comment', '# app'],
        ['attr', 'port'],
        ['number', '80'],
        ['attr', 'on'],
        ['literal', 'true'],
      ],
    ],
    [
      'toml',
      '[server]\nport = 8080\nname = "x"',
      [
        ['tag', '[server]'],
        ['attr', 'port'],
        ['number', '8080'],
        ['attr', 'name'],
        ['string', '"x"'],
      ],
    ],
    [
      'go',
      'func main() { s := `raw`; return nil }',
      [
        ['keyword', 'func'],
        ['string', '`raw`'],
        ['keyword', 'return'],
        ['literal', 'nil'],
      ],
    ],
    [
      'rust',
      "#[derive(Debug)]\nfn f<'a>() -> Option<u8> { Some(1) }",
      [
        ['attr', '#[derive(Debug)]'],
        ['keyword', 'fn'],
        ['attr', "'a"],
        ['keyword', 'Option'],
        ['keyword', 'u8'],
        ['literal', 'Some'],
        ['number', '1'],
      ],
    ],
    [
      'java',
      '@Override public int f() { return 1; }',
      [
        ['attr', '@Override'],
        ['keyword', 'public'],
        ['keyword', 'int'],
        ['keyword', 'return'],
        ['number', '1'],
      ],
    ],
    [
      'c',
      '#include <stdio.h>\nint main() { return 0; }',
      [
        ['keyword', '#include'],
        ['keyword', 'int'],
        ['keyword', 'return'],
        ['number', '0'],
      ],
    ],
  ])('highlights %s', (lang, code, expected) => {
    expect(types(code, lang)).toEqual(expected);
  });

  it('returns plain text for unknown languages, empty input and oversized input', () => {
    expect(highlight('const x', 'cobol')).toEqual([{ type: 'plain', text: 'const x' }]);
    expect(highlight('', 'ts')).toEqual([]);
    const big = 'a'.repeat(HIGHLIGHT_LIMIT + 1);
    expect(highlight(big, 'ts')).toEqual([{ type: 'plain', text: big }]);
  });

  it('survives unterminated strings and comments', () => {
    expect(types('x = "open', 'js')).toEqual([['string', '"open']]);
    expect(types('/* never closed', 'js')).toEqual([['comment', '/* never closed']]);
  });
});

describe('CodeBlock', () => {
  it('renders tokens as text, never as markup, and is focusable for scrolling', () => {
    const { container } = render(
      <CodeBlock code={'const s = "<img src=x onerror=alert(1)>";'} language="ts" label="Code" />,
    );
    const pre = screen.getByLabelText('Code');
    expect(pre.tagName).toBe('PRE');
    expect(pre.tabIndex).toBe(0);
    expect(pre.dataset.language).toBe('js');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.nv-tok-keyword')?.textContent).toBe('const');
    expect(container.querySelector('.nv-tok-string')?.textContent).toBe(
      '"<img src=x onerror=alert(1)>"',
    );
    expect(pre.textContent).toBe('const s = "<img src=x onerror=alert(1)>";');
  });

  it('renders unknown languages as plain text', () => {
    const { container } = render(<CodeBlock code="plain words" language={null} className="x" />);
    const pre = container.querySelector('pre')!;
    expect(pre.className).toBe('nv-code x');
    expect(pre.dataset.language).toBeUndefined();
    expect(container.querySelector('.nv-tok')).toBeNull();
  });
});
