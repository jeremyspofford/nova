// Web tools (FR-029, docs/12 §8): SearXNG search with numbered citations, page fetching as
// Markdown or text with size caps, redirect re-checks, private-address refusal and the HTML
// converter.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '@nova/telemetry';
import {
  UnavailableSandbox,
  decodeEntities,
  htmlToMarkdown,
  isPrivateAddress,
  webTools,
  type BuiltinContext,
  type ToolResult,
  type WebToolOptions,
} from '../src/index.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function ctx(extra: Partial<BuiltinContext> = {}): BuiltinContext {
  return {
    accountId: 'a',
    threadId: 't',
    turnId: 'u',
    callId: 'c',
    projectId: null,
    origin: 'model',
    profile: { id: 'workspace', hash: 'h' },
    roots: [],
    sandbox: new UnavailableSandbox(),
    signal: new AbortController().signal,
    log: new Logger({ module: 'test', sinks: [] }),
    ...extra,
  };
}
const text = (r: ToolResult) =>
  r.ok ? r.content.map((p) => (p.type === 'text' ? p.text : '')).join('') : '';

function tools(opts: Partial<WebToolOptions> = {}) {
  const all = webTools({ searxngUrl: () => Promise.resolve(null), ...opts });
  return { search: all[0]!, fetch: all[1]! };
}

interface Reply {
  status?: number;
  type?: string;
  body?: string;
  location?: string;
}

/** Serve fixed routes on 127.0.0.1. */
async function serve(routes: Record<string, () => Reply>): Promise<string> {
  const server = createServer((req, res) => {
    const route = routes[req.url ?? ''] ?? ((): Reply => ({ status: 404, body: 'nope' }));
    const r = route();
    const headers: Record<string, string> = { 'content-type': r.type ?? 'text/html' };
    if (r.location) headers.location = r.location;
    res.writeHead(r.status ?? 200, headers);
    res.end(r.body ?? '');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

describe('web.search (FR-029)', () => {
  it('queries SearXNG and numbers the results through the turn', async () => {
    const base = await serve({
      '/searx/search?q=local+first&format=json&safesearch=1': () => ({
        type: 'application/json',
        body: JSON.stringify({
          results: [
            { url: 'https://a.example/x', title: 'A', content: 'first' },
            { url: 'javascript:alert(1)', title: 'bad' },
            { url: 'https://b.example/y', title: 'B', content: 'second' },
          ],
        }),
      }),
    });
    const { search } = tools({ searxngUrl: () => Promise.resolve(`${base}/searx`) });
    const cited: unknown[] = [];
    const r = await search.handler(
      { query: 'local first', limit: 5 },
      ctx({
        extras: {
          messageId: 'm',
          network: 'off',
          deny: [],
          cite: (items) => {
            cited.push(...items);
            return items.map((_, i) => i + 3);
          },
          searchTools: () => [],
        },
      }),
    );
    expect(text(r)).toBe(
      '[3] A\nhttps://a.example/x\nfirst\n\n[4] B\nhttps://b.example/y\nsecond\n\nCite the sources you use by number, like [3].',
    );
    expect(cited).toEqual([
      { url: 'https://a.example/x', title: 'A', snippet: 'first' },
      { url: 'https://b.example/y', title: 'B', snippet: 'second' },
    ]);
    expect(r.ok && r.meta?.citations).toEqual([
      expect.objectContaining({ idx: 3 }),
      expect.objectContaining({ idx: 4 }),
    ]);
  });

  it('reports no results, an unconfigured service and a failing one', async () => {
    const base = await serve({
      '/search?q=none&format=json&safesearch=1': () => ({
        type: 'application/json',
        body: '{"results":[]}',
      }),
      '/search?q=boom&format=json&safesearch=1': () => ({ status: 500 }),
    });
    const { search } = tools({ searxngUrl: () => Promise.resolve(base) });
    expect(text(await search.handler({ query: 'none' }, ctx()))).toBe('No results for "none".');
    expect(await search.handler({ query: 'boom' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'search_failed' },
    });
    expect(await tools().search.handler({ query: 'x' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'not_configured' },
    });
    const down = tools({ searxngUrl: () => Promise.resolve('http://127.0.0.1:1') });
    expect(await down.search.handler({ query: 'x' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'search_failed' },
    });
  });
});

describe('web.fetch', () => {
  const page = `<!doctype html><html><head><title>Nova &amp; friends</title>
    <style>body{color:red}</style><script>alert("x")</script></head>
    <body><h1>Hello</h1><p>Some <b>bold</b> and <a href="/docs">docs</a>.</p>
    <ul><li>one</li><li>two</li></ul><pre>code  here</pre><!-- hidden --></body></html>`;

  it('returns a page as Markdown or text, without scripts', async () => {
    const base = await serve({ '/': () => ({ body: page }) });
    const { fetch: f } = tools({ allowPrivateHosts: true });
    const md = text(await f.handler({ url: `${base}/` }, ctx()));
    expect(md).toBe(
      `# Nova & friends\nSource: ${base}/\n\n# Hello\n\nSome **bold** and [docs](${base}/docs).\n\n- one\n- two\n\n\`\`\`\ncode  here\n\`\`\``,
    );
    expect(md).not.toContain('alert');
    const plain = text(await f.handler({ url: `${base}/`, format: 'text' }, ctx()));
    expect(plain).toContain('Some bold and docs.');
    expect(plain).not.toContain('**');
  });

  it('caps the text and passes plain text and JSON through', async () => {
    const base = await serve({
      '/big': () => ({ type: 'text/plain', body: 'y'.repeat(5000) }),
      '/j': () => ({ type: 'application/json', body: '{"a":1}' }),
      '/img': () => ({ type: 'image/png', body: 'x' }),
      '/missing': () => ({ status: 404 }),
    });
    const { fetch: f } = tools({ allowPrivateHosts: true });
    const big = await f.handler({ url: `${base}/big`, maxChars: 1000 }, ctx());
    expect(text(big)).toContain('[... truncated ...]');
    expect(big.ok && big.meta?.truncated).toBe(true);
    expect(text(await f.handler({ url: `${base}/j` }, ctx()))).toContain('{"a":1}');
    expect(await f.handler({ url: `${base}/img` }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'unsupported_content' },
    });
    expect(await f.handler({ url: `${base}/missing` }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'http_error' },
    });
  });

  it('follows a redirect on the same host and hands one to another host back to the model', async () => {
    const base = await serve({
      '/old': () => ({ status: 301, location: '/new' }),
      '/new': () => ({ type: 'text/plain', body: 'moved here' }),
      '/away': () => ({ status: 302, location: 'https://elsewhere.example/page' }),
      '/loop': () => ({ status: 302, location: '/loop' }),
    });
    const { fetch: f } = tools({ allowPrivateHosts: true });
    expect(text(await f.handler({ url: `${base}/old` }, ctx()))).toContain('moved here');
    const away = await f.handler({ url: `${base}/away` }, ctx());
    expect(text(away)).toBe(
      'The page redirects to https://elsewhere.example/page, on another host. Call web.fetch with that URL to follow it.',
    );
    expect(await f.handler({ url: `${base}/loop` }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'too_many_redirects' },
    });
  });

  it('refuses private and local addresses, other schemes and credentials in URLs', async () => {
    const { fetch: f } = tools({
      resolveHost: (h) =>
        Promise.resolve(h === 'public.example' ? ['93.184.216.34'] : ['10.0.0.5']),
      fetchImpl: () =>
        Promise.resolve(new Response('public page', { headers: { 'content-type': 'text/plain' } })),
    });
    expect(await f.handler({ url: 'http://127.0.0.1:8080/' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'private_address' },
    });
    expect(await f.handler({ url: 'http://intranet.example/' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'private_address' },
    });
    expect(text(await f.handler({ url: 'https://public.example/' }, ctx()))).toContain(
      'public page',
    );
    expect(await f.handler({ url: 'file:///etc/passwd' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'invalid_url' },
    });
    expect(await f.handler({ url: 'https://u:p@public.example/' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'invalid_url' },
    });
    expect(await f.handler({ url: 'not a url' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'invalid_url' },
    });
    expect(f.resource!({ url: 'https://x.example/a' }, ctx())).toEqual({
      kind: 'host',
      value: 'x.example',
    });
    expect(f.resource!({ url: '::' }, ctx())).toBeUndefined();
  });

  it('classifies addresses (docs/12 §8)', () => {
    for (const a of [
      '10.1.2.3',
      '127.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:10.0.0.1',
      'garbage',
    ])
      expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])
      expect(isPrivateAddress(a), a).toBe(false);
  });
});

describe('HTML conversion', () => {
  it('handles entities, ordered lists, tables, images and unclosed markup without slowing down', () => {
    expect(decodeEntities('a &lt;b&gt; &#65;&#x42; &nbsp;&unknown;')).toBe('a <b> AB  &unknown;');
    const out = htmlToMarkdown(
      '<ol><li>first</li><li>second</li></ol><table><tr><td>a</td><td>b</td></tr></table><img alt="logo"><hr><br>x<i>y</i><svg/>after',
      'https://h.example/',
    );
    expect(out.text).toBe('1. first\n2. second\n\na | b |\n\n[image: logo]\n\n---\n\nx_y_after');
    const hostile = '<div>'.repeat(20_000) + '<script>'.repeat(5_000);
    const t0 = Date.now();
    htmlToMarkdown(hostile, 'https://h.example/');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(htmlToMarkdown('<p>unclosed <a href="javascript:x">link', 'https://h/').text).toBe(
      'unclosed link',
    );
  });
});
