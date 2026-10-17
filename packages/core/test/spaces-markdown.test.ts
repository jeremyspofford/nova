// The site Markdown renderer (FR-037) and comment anchors (FR-036): what pages use renders, and
// nothing in a page can become markup or script; anchors follow text through edits.
import { describe, expect, it } from 'vitest';
import {
  anchorForQuote,
  blocksOf,
  checkAnchor,
  markdownToHtml,
  reanchor,
  safeUrl,
} from '../src/index.ts';

describe('markdownToHtml', () => {
  it('renders headings, emphasis, code, links, lists, quotes, rules and tables', () => {
    const html = markdownToHtml(
      [
        '# Title',
        '',
        'Some **bold**, *em*, `code`, ~~gone~~ and a [link](https://example.com "Ex").',
        'Next line  ',
        'after break.',
        '',
        '- one',
        '- two',
        '  - nested',
        '- [x] done',
        '',
        '3. three',
        '4. four',
        '',
        '> quoted',
        '',
        '---',
        '',
        '| Name | Count |',
        '| :--- | ----: |',
        '| a \\| b | 2 |',
        '',
        '```ts',
        'const x = 1 < 2;',
        '```',
        '',
        '## Title',
      ].join('\n'),
    );
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain('<h2 id="title-2">Title</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain(
      '<a href="https://example.com" title="Ex" rel="noopener noreferrer">link</a>',
    );
    expect(html).toContain('Next line<br>after break.');
    expect(html).toMatch(/<ul><li>one<\/li><li>two\n?<ul><li>nested<\/li><\/ul><\/li>/);
    expect(html).toContain('<li><input type="checkbox" disabled checked> done</li>');
    expect(html).toContain('<ol start="3"><li>three</li><li>four</li></ol>');
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<th scope="col" style="text-align:left">Name</th>');
    expect(html).toContain('<td style="text-align:right">2</td>');
    expect(html).toContain('<td style="text-align:left">a | b</td>');
    expect(html).toContain('<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>');
  });

  it('never passes raw HTML, script URLs or attribute breakouts through', () => {
    const evil = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '[click](javascript:alert(1))',
      '[data](data:text/html,<script>alert(1)</script>)',
      '![x](javascript:alert(1))',
      '[t](https://ok.example "a\\" onmouseover=\\"x")',
      '[proto](//evil.example/x)',
      '<javascript:alert(1)>',
      '**<b>bold html</b>**',
      '```"><script>x</script>',
      'body',
      '```',
    ].join('\n\n');
    const html = markdownToHtml(evil);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img src=x/i);
    expect(html).not.toMatch(/href="javascript/i);
    expect(html).not.toMatch(/href="data:/i);
    expect(html).not.toMatch(/src="javascript/i);
    expect(html).not.toMatch(/href="\/\/evil/);
    // Attribute-looking text stays text: no tag carries an event handler.
    expect(html).not.toMatch(/<[^>]* on[a-z]+=/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<a href="#">click</a>');
  });

  it('lets the caller render fences and rewrite links', () => {
    const html = markdownToHtml('[About](about.html)\n\n```chart\n{}\n```', {
      fence: (lang, _info, body) => (lang === 'chart' ? `<figure>${body.length}</figure>` : null),
      link: (href) => (href === 'about.html' ? '#page-about' : href),
      idPrefix: 'p-',
    });
    expect(html).toContain('<a href="#page-about">About</a>');
    expect(html).toContain('<figure>2</figure>');
    expect(markdownToHtml('# Hi', { idPrefix: 'p-x--' })).toContain('id="p-x--hi"');
  });

  it('autolinks bare URLs without trailing punctuation', () => {
    expect(markdownToHtml('See https://example.com/a.')).toContain(
      '<a href="https://example.com/a" rel="noopener noreferrer">https://example.com/a</a>.',
    );
    expect(safeUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeUrl(' java\nscript:alert(1)')).toBeNull();
    expect(safeUrl('pages/a.html#x')).toBe('pages/a.html#x');
  });
});

describe('rendering cost', () => {
  // Site builds run in the Hub's event loop: adversarial pages must stay linear (no backtracking
  // blowups, no deep recursion).
  it.each([
    ['unclosed brackets', '['.repeat(200_000)],
    ['unmatched emphasis', '*a '.repeat(70_000)],
    ['underscores', '_a'.repeat(100_000)],
    ['backticks', '``x`'.repeat(50_000)],
    ['nested quotes', '>'.repeat(200_000)],
    ['nested list markers', `${'- '.repeat(100_000)}x`],
    ['repeated headings', '# h\n'.repeat(50_000)],
    ['hard breaks', 'ab  \n'.repeat(40_000)],
  ])('%s', (_name, text) => {
    const t0 = performance.now();
    const html = markdownToHtml(text);
    expect(html.length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(3_000);
  });
});

describe('comment anchors', () => {
  const text = 'Intro paragraph.\n\n```\ncode\n\nstill code\n```\n\n- a list\n- of items';

  it('splits blocks, keeping a fence whole', () => {
    expect(blocksOf(text).map((b) => b.text)).toEqual([
      'Intro paragraph.',
      '```\ncode\n\nstill code\n```',
      '- a list\n- of items',
    ]);
  });

  it('moves a range to the nearest occurrence of its quote', () => {
    const a = { kind: 'range' as const, start: 10, end: 13, quote: 'cat' };
    expect(reanchor(a, 'cat dog cat bird cat')).toEqual({
      anchor: { kind: 'range', start: 8, end: 11, quote: 'cat' },
      detached: false,
    });
    expect(reanchor(a, 'no felines').detached).toBe(true);
    expect(reanchor({ kind: 'page' }, 'x')).toEqual({ anchor: { kind: 'page' }, detached: false });
  });

  it('follows a block that keeps its opening words, else detaches', () => {
    const a = checkAnchor({ kind: 'block', index: 2, quote: '' }, text);
    expect(a).toEqual({ kind: 'block', index: 2, quote: '- a list\n- of items' });
    expect(
      reanchor(a, 'New.\n\nIntro paragraph.\n\n- a list\n- of items\n- more').anchor,
    ).toMatchObject({
      index: 2,
    });
    expect(reanchor(a, 'Nothing like it').detached).toBe(true);
  });

  it('anchors an agent comment by its quote', () => {
    expect(anchorForQuote(text, 'paragraph')).toEqual({
      kind: 'range',
      start: 6,
      end: 15,
      quote: 'paragraph',
    });
    expect(anchorForQuote(text, 'missing')).toBeNull();
    expect(anchorForQuote(text, '   ')).toBeNull();
  });
});
