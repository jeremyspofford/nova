import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderInline } from '../ui/js/markdown.js';

test('escapes HTML everywhere', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n**<img src=x onerror=1>**\n\n`<b>`');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<code>&lt;b&gt;</code>'));
});

test('links: only http, https and mailto', () => {
  assert.match(renderInline('[ok](https://a.com/x?y=1&z=2)'), /<a href="https:\/\/a.com\/x\?y=1&amp;z=2" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.equal(renderInline('[bad](javascript:alert(1))').includes('<a'), false);
  assert.match(renderInline('see https://example.com.'), /<a href="https:\/\/example.com"[^>]*>https:\/\/example.com<\/a>\.$/);
});

test('emphasis, code spans and line breaks', () => {
  assert.equal(renderInline('**b** and *i* and ~~s~~'), '<strong>b</strong> and <em>i</em> and <del>s</del>');
  assert.equal(renderInline('`a **not bold**`'), '<code>a **not bold**</code>');
  assert.equal(renderInline('one\ntwo'), 'one<br>two');
  assert.equal(renderInline('snake_case_name'), 'snake_case_name');
});

test('blocks: headings, lists, quotes, rules', () => {
  const html = renderMarkdown('# Title\n\n- a\n- b\n  - nested\n\n1. one\n2. two\n\n> quoted\n\n---');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<ul><li>a<\/li><li>b<ul><li>nested<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
});

test('ordered list keeps its start number', () => {
  assert.match(renderMarkdown('3. three\n4. four'), /<ol start="3">/);
});

test('fenced code, including an unclosed fence while streaming', () => {
  const closed = renderMarkdown('```js\nconst a = "<x>";\n```');
  assert.match(closed, /class="code-block"/);
  assert.match(closed, /<span class="code-lang">js<\/span>/);
  assert.match(closed, /const a = &quot;&lt;x&gt;&quot;;/);
  const open = renderMarkdown('```py\nprint(1)');
  assert.match(open, /code-block is-open/);
  assert.match(open, /print\(1\)/);
});

test('tables with alignment, wrapped for scrolling', () => {
  const html = renderMarkdown('| a | b |\n|:-|-:|\n| 1 | **2** |');
  assert.match(html, /<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table>/);
  assert.match(html, /<th style="text-align:right">b<\/th>/);
  assert.match(html, /<td style="text-align:right"><strong>2<\/strong><\/td>/);
});

test('empty and odd input does not throw', () => {
  for (const s of ['', null, undefined, '|', '```', '- ', '> ', '#', '[x](', '**']) assert.equal(typeof renderMarkdown(s), 'string');
});
