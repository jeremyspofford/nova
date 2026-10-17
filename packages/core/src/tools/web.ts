// Web tools (docs/08 §1.1): web.search asks a SearXNG instance (`search.searxngUrl`) and its
// results become numbered citations of the reply (FR-029); web.fetch reads one page as Markdown
// or text. Both return page content, which carries the `page` taint (FR-189). web.fetch refuses
// private and loopback addresses and does not follow a redirect to another host: the model must
// fetch that URL itself, so the new host passes the policy gate like any call (docs/12 §8).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  argsOf,
  builtinDescriptor,
  extrasOf,
  fail,
  num,
  ok,
  str,
  type BuiltinTool,
  type WebCitation,
} from './builtin.ts';
import { clip } from './text.ts';
import type { ToolResult } from './types.ts';

export const MAX_FETCH_BYTES = 2 * 1024 * 1024;
export const DEFAULT_FETCH_CHARS = 20_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Nova (local assistant; +https://arialabs.ai)';

export interface WebToolOptions {
  /** The SearXNG base URL; web.search is not listed while it is null (FR-029). */
  searxngUrl: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Resolve a host name to addresses (tests replace DNS). */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Allow private and loopback addresses (tests only). */
  allowPrivateHosts?: boolean;
}

export function webTools(opts: WebToolOptions): BuiltinTool[] {
  const doFetch = opts.fetchImpl ?? fetch;
  const resolveHost =
    opts.resolveHost ??
    (async (host: string) => (await lookup(host, { all: true })).map((a) => a.address));

  const search: BuiltinTool = {
    descriptor: builtinDescriptor({
      name: 'web.search',
      title: 'Search the web',
      description:
        'Search the web. Returns numbered results; cite the ones you use by number, like [1].',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500 },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnly: true, requiresNetwork: true, action: 'read' },
      effects: ['network'],
      timeoutMs: 30_000,
    }),
    origin: 'page',
    handler: async (args, ctx) => {
      const a = argsOf(args);
      const base = await opts.searxngUrl();
      if (!base) return fail('not_configured', 'web search is not set up (search.searxngUrl)');
      const query = str(a.query) ?? '';
      const limit = num(a.limit) ?? 5;
      const url = new URL('search', base.endsWith('/') ? base : `${base}/`);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('safesearch', '1');
      let body: unknown;
      try {
        const res = await doFetch(url, {
          signal: ctx.signal,
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        });
        if (!res.ok) return fail('search_failed', `the search service answered ${res.status}`);
        body = JSON.parse(await readCapped(res, MAX_FETCH_BYTES).then((r) => r.text)) as unknown;
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        return fail('search_failed', `the search service could not be reached: ${message(err)}`);
      }
      const raw = (body as { results?: unknown }).results;
      const items: WebCitation[] = (Array.isArray(raw) ? raw : [])
        .flatMap((r: unknown) => {
          const o = argsOf(r);
          const u = str(o.url);
          if (!u || !/^https?:\/\//i.test(u)) return [];
          return [
            {
              url: u,
              title: str(o.title) ? clip(str(o.title)!, 200) : null,
              snippet: str(o.content) ? clip(str(o.content)!, 500) : null,
            },
          ];
        })
        .slice(0, limit);
      if (!items.length) return ok(`No results for "${query}".`, { query, results: 0 });
      const numbers = extrasOf(ctx)?.cite(items) ?? items.map((_, i) => i + 1);
      const text = items
        .map(
          (r, i) =>
            `[${numbers[i]}] ${r.title ?? r.url}\n${r.url}${r.snippet ? `\n${clip(r.snippet, 300)}` : ''}`,
        )
        .join('\n\n');
      return ok(`${text}\n\nCite the sources you use by number, like [${numbers[0]}].`, {
        query,
        results: items.length,
        citations: items.map((r, i) => ({ ...r, idx: numbers[i] })),
      });
    },
  };

  const fetchTool: BuiltinTool = {
    descriptor: builtinDescriptor({
      name: 'web.fetch',
      title: 'Read a web page',
      description:
        'Fetch a web page (http or https) and return it as Markdown, or plain text with format: "text".',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', minLength: 1, maxLength: 4000 },
          format: { enum: ['markdown', 'text'] },
          maxChars: { type: 'integer', minimum: 500, maximum: 100_000 },
        },
        required: ['url'],
        additionalProperties: false,
      },
      annotations: { readOnly: true, requiresNetwork: true, action: 'read' },
      effects: ['network'],
      timeoutMs: 60_000,
    }),
    origin: 'page',
    resource: (args) => {
      try {
        return { kind: 'host', value: new URL(str(argsOf(args).url) ?? '').hostname };
      } catch {
        return undefined;
      }
    },
    handler: async (args, ctx) => {
      const a = argsOf(args);
      const plain = a.format === 'text';
      const maxChars = num(a.maxChars) ?? DEFAULT_FETCH_CHARS;
      let current: URL;
      try {
        current = new URL(str(a.url) ?? '');
      } catch {
        return fail('invalid_url', 'not a valid URL');
      }
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const refused = await checkUrl(current, opts.allowPrivateHosts === true, resolveHost);
        if (refused) return refused;
        let res: Response;
        try {
          res = await doFetch(current, {
            redirect: 'manual',
            signal: ctx.signal,
            headers: {
              'user-agent': USER_AGENT,
              accept: 'text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.1',
            },
          });
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          return fail('fetch_failed', `the page could not be fetched: ${message(err)}`);
        }
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel().catch(() => undefined);
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            return fail('fetch_failed', 'the page redirects to an invalid URL');
          }
          // Redirect targets are checked as new requests (docs/12 §8); another host goes back
          // to the model so the policy evaluates it.
          if (next.hostname !== current.hostname)
            return ok(
              `The page redirects to ${next.href}, on another host. Call web.fetch with that URL to follow it.`,
              { url: current.href, redirect: next.href, status: res.status },
            );
          current = next;
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return fail('http_error', `the server answered ${res.status} for ${current.href}`);
        }
        const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (!isTextual(type)) {
          await res.body?.cancel().catch(() => undefined);
          return fail('unsupported_content', `${type || 'this content'} cannot be read as text`);
        }
        const body = await readCapped(res, MAX_FETCH_BYTES);
        let title: string | null = null;
        let text = body.text;
        if (type === 'text/html' || type === 'application/xhtml+xml') {
          const page = htmlToMarkdown(body.text, current.href, plain);
          title = page.title;
          text = page.text;
        }
        let truncated = body.truncated;
        if (text.length > maxChars) {
          text = `${text.slice(0, maxChars)}\n[... truncated ...]`;
          truncated = true;
        }
        const header = `${title ? `# ${title}\n` : ''}Source: ${current.href}\n\n`;
        return ok(header + text, {
          url: current.href,
          status: res.status,
          contentType: type,
          title,
          truncated,
        });
      }
      return fail('too_many_redirects', `more than ${MAX_REDIRECTS} redirects`);
    },
  };

  return [search, fetchTool];
}

function message(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  return err instanceof Error ? err.message : String(err);
}

function isTextual(type: string): boolean {
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/xhtml+xml' ||
    type === 'application/xml' ||
    type === ''
  );
}

async function checkUrl(
  url: URL,
  allowPrivate: boolean,
  resolveHost: (host: string) => Promise<string[]>,
): Promise<ToolResult | null> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return fail('invalid_url', 'only http and https URLs can be fetched');
  if (url.username || url.password)
    return fail('invalid_url', 'URLs with credentials cannot be fetched');
  if (allowPrivate) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolveHost(host);
  } catch {
    return fail('fetch_failed', `${host} could not be resolved`);
  }
  if (!addresses.length || addresses.some(isPrivateAddress))
    return fail(
      'private_address',
      `${host} is a private or local address; web.fetch only reads public pages`,
    );
  return null;
}

/** Private, loopback, link-local, carrier-grade NAT, unique-local or multicast (docs/12 §8). */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number) as [number, number];
    return (
      p === 0 ||
      p === 10 ||
      p === 127 ||
      (p === 100 && q >= 64 && q <= 127) ||
      (p === 169 && q === 254) ||
      (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) ||
      p >= 224
    );
  }
  if (isIP(a) === 6) {
    return (
      a === '::' ||
      a === '::1' ||
      a.startsWith('fc') ||
      a.startsWith('fd') ||
      /^fe[89ab]/.test(a) ||
      a.startsWith('ff')
    );
  }
  return true;
}

async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const buf = Buffer.concat(chunks).subarray(0, maxBytes);
  return { text: buf.toString('utf8'), truncated };
}

// ---- HTML to Markdown -------------------------------------------------------------------------

const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'object',
  'canvas',
]);
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'nav',
  'aside',
  'ul',
  'ol',
  'table',
  'tr',
  'blockquote',
  'form',
  'figure',
  'figcaption',
  'dl',
  'dd',
  'dt',
  'details',
  'summary',
]);
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * A single linear pass over the markup: no regular expression scans the document, so hostile
 * pages cannot make conversion slow. Scripts, styles and embedded content are dropped.
 */
export function htmlToMarkdown(
  html: string,
  baseUrl: string,
  plain = false,
): { title: string | null; text: string } {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let title: string | null = null;
  let pre = 0;
  const links: (string | null)[] = [];
  const lists: { ordered: boolean; n: number }[] = [];
  /** Newlines at the end of the output so far (whitespace between them ignored). */
  const trailing = (): number => {
    let count = 0;
    for (let k = out.length - 1; k >= 0; k--) {
      const c = out[k]!;
      for (let j = c.length - 1; j >= 0; j--) {
        if (c[j] === '\n') count++;
        else if (c[j] !== ' ' && c[j] !== '\t') return count;
      }
    }
    return out.length ? count : Infinity;
  };
  const newline = (n: number) => {
    for (let k = trailing(); k < n; k++) out.push('\n');
  };
  const emitText = (raw: string) => {
    if (!raw) return;
    const decoded = decodeEntities(raw);
    if (pre) {
      out.push(decoded);
      return;
    }
    const t = decoded.replace(/\s+/g, ' ');
    if (t === ' ' && (!out.length || /\s$/.test(out.at(-1)!))) return;
    out.push(t);
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      emitText(html.slice(i));
      break;
    }
    emitText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const gt = tagEnd(html, lt);
    if (gt < 0) {
      emitText(html.slice(lt));
      break;
    }
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('!') || raw.startsWith('?')) continue;
    const closing = raw.startsWith('/');
    const m = /^\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
    if (!m) {
      emitText(`<${raw}>`);
      continue;
    }
    const name = m[1]!.toLowerCase();
    const selfClosing = raw.trimEnd().endsWith('/');
    if (!closing && !selfClosing && (SKIP.has(name) || name === 'title' || name === 'head')) {
      const close = lower.indexOf(`</${name}`, i);
      const inner = html.slice(i, close < 0 ? html.length : close);
      if (name === 'title') title = clip(decodeEntities(inner).replace(/\s+/g, ' ').trim(), 200);
      if (name === 'head') {
        const ts = lower.indexOf('<title', i);
        if (ts >= 0 && (close < 0 || ts < close)) {
          const tgt = html.indexOf('>', ts);
          const te = lower.indexOf('</title', tgt);
          if (tgt >= 0 && te >= 0)
            title = clip(
              decodeEntities(html.slice(tgt + 1, te))
                .replace(/\s+/g, ' ')
                .trim(),
              200,
            );
        }
      }
      i = close < 0 ? html.length : Math.max(i, html.indexOf('>', close) + 1 || html.length);
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      newline(2);
      if (!closing && !plain) out.push(`${'#'.repeat(Number(name[1]))} `);
      continue;
    }
    switch (name) {
      case 'br':
        out.push('\n');
        continue;
      case 'hr':
        newline(2);
        if (!plain) out.push('---');
        newline(2);
        continue;
      case 'li': {
        if (closing) {
          newline(1);
          continue;
        }
        newline(1);
        const list = lists.at(-1);
        const indent = '  '.repeat(Math.max(0, lists.length - 1));
        if (list?.ordered) out.push(`${indent}${++list.n}. `);
        else out.push(`${indent}- `);
        continue;
      }
      case 'ul':
      case 'ol':
        if (closing) lists.pop();
        else lists.push({ ordered: name === 'ol', n: 0 });
        newline(lists.length ? 1 : 2);
        continue;
      case 'pre':
        if (closing) {
          pre = Math.max(0, pre - 1);
          newline(1);
          if (!plain) out.push('```');
          newline(2);
        } else {
          newline(2);
          pre++;
          if (!plain) out.push('```\n');
        }
        continue;
      case 'code':
        if (!pre && !plain) out.push('`');
        continue;
      case 'strong':
      case 'b':
        if (!plain) out.push('**');
        continue;
      case 'em':
      case 'i':
        if (!plain) out.push('_');
        continue;
      case 'a': {
        if (closing) {
          const href = links.pop();
          if (href && !plain) out.push(`](${href})`);
          continue;
        }
        const href = attr(raw, 'href');
        let abs: string | null = null;
        if (href) {
          try {
            const u = new URL(href, baseUrl);
            if (u.protocol === 'http:' || u.protocol === 'https:') abs = u.href;
          } catch {
            // not a link we keep
          }
        }
        links.push(abs);
        if (abs && !plain) out.push('[');
        continue;
      }
      case 'img': {
        const alt = attr(raw, 'alt');
        if (alt) out.push(plain ? alt : `[image: ${alt}]`);
        continue;
      }
      case 'td':
      case 'th':
        if (closing) out.push(' | ');
        continue;
      default:
        if (BLOCK.has(name)) newline(name === 'div' || name === 'tr' ? 1 : 2);
    }
  }
  const text = out
    .join('')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

/** Index of the `>` closing the tag at `lt`, skipping quoted attribute values; -1 if none. */
function tagEnd(html: string, lt: number): number {
  let quote: string | null = null;
  const limit = Math.min(html.length, lt + 10_000);
  for (let k = lt + 1; k < limit; k++) {
    const c = html[k];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return k;
  }
  return -1;
}

function attr(raw: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(raw);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}
