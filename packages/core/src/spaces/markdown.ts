// A small, safe Markdown to HTML renderer for generated sites (FR-037). It covers what pages use:
// headings, paragraphs, emphasis, code, links, images, lists (nested, tasks), quotes, rules, fenced
// code and tables. Raw HTML is never passed through: every character of the source is escaped, and
// only http(s), mailto, relative and in-page URLs survive, so a page cannot add script or markup.
// Fenced blocks can be replaced by the caller (charts, diagrams and data tables).
import { escapeXml } from '@nova/shared';

export interface MarkdownOptions {
  /** HTML for a fenced block, or null for an ordinary code block. Must escape its own text. */
  fence?: (lang: string, info: string, body: string) => string | null;
  /** Rewrite a safe link target (e.g. `about.html` to `#about` in a one-document preview). */
  link?: (href: string) => string;
  /** Prefix for heading ids, so several pages can share one document. */
  idPrefix?: string;
}

const esc = escapeXml;

/** Only schemes that cannot run code; anything else becomes a plain `#`. */
export function safeUrl(raw: string): string | null {
  const url = raw.trim().replace(/[\p{Cc}\s]/gu, '');
  if (!url) return null;
  if (/^(https?:|mailto:)/i.test(url)) return url;
  // No scheme: a relative path, a query or an in-page anchor.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  if (url.startsWith('//')) return null;
  return url;
}

/** The id a heading gets, for in-page links. */
export function headingId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'section'
  );
}

export function markdownToHtml(src: string, opts: MarkdownOptions = {}): string {
  const lines = src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  return renderBlocks(lines, opts, new Map(), 0);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})[ ]*([^`\n]*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ ]+(.*?))?(?:[ ]+#+)?[ ]*$/;
const HR = /^ {0,3}([-*_])(?:[ ]*\1){2,}[ ]*$/;
const QUOTE = /^ {0,3}>[ ]?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ ]+|$)(.*)$/;
const TABLE_SEP = /^ {0,3}\|?[ ]*:?-+:?[ ]*(\|[ ]*:?-+:?[ ]*)*\|?[ ]*$/;

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line)
  );
}

function renderBlocks(
  lines: string[],
  opts: MarkdownOptions,
  /** Heading ids in use, each with the next suffix to try. */
  ids: Map<string, number>,
  depth: number,
): string {
  // Deeper nesting than anyone writes is shown as text, so no input can exhaust the stack.
  if (depth > MAX_DEPTH) return `<p>${esc(lines.join('\n'))}</p>`;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const info = (fence[2] ?? '').trim();
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? '';
        const close = /^ {0,3}(`{3,}|~{3,})[ ]*$/.exec(l);
        if (close?.[1] && close[1][0] === marker[0] && close[1].length >= marker.length) {
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      const lang = info.split(/\s+/)[0]?.toLowerCase() ?? '';
      const text = body.join('\n');
      const custom = opts.fence?.(lang, info, text) ?? null;
      out.push(
        custom ??
          `<pre><code${lang ? ` class="language-${esc(lang.replace(/[^a-z0-9_-]/g, ''))}"` : ''}>${esc(text)}</code></pre>`,
      );
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const html = inline(heading[2] ?? '', opts);
      const base = `${opts.idPrefix ?? ''}${headingId(html)}`;
      let id = base;
      for (let n = ids.get(base) ?? 2; ids.has(id); n++) {
        id = `${base}-${n}`;
        ids.set(base, n + 1);
      }
      ids.set(id, ids.get(id) ?? 2);
      out.push(`<h${level} id="${esc(id)}">${html}</h${level}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        inner.push((lines[i] ?? '').replace(QUOTE, ''));
        i++;
      }
      out.push(`<blockquote>${renderBlocks(inner, opts, ids, depth + 1)}</blockquote>`);
      continue;
    }
    if (
      line.includes('|') &&
      TABLE_SEP.test(lines[i + 1] ?? '') &&
      (lines[i + 1] ?? '').includes('-')
    ) {
      const head = cells(line);
      const aligns = cells(lines[i + 1] ?? '').map((c) =>
        c.startsWith(':') && c.endsWith(':')
          ? 'center'
          : c.endsWith(':')
            ? 'right'
            : c.startsWith(':')
              ? 'left'
              : null,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').trim() && (lines[i] ?? '').includes('|')) {
        rows.push(cells(lines[i] ?? ''));
        i++;
      }
      const td = (tag: 'th' | 'td', c: string, k: number) => {
        const a = aligns[k];
        return `<${tag}${tag === 'th' ? ' scope="col"' : ''}${a ? ` style="text-align:${a}"` : ''}>${inline(c, opts)}</${tag}>`;
      };
      out.push(
        `<div class="table"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2] ?? '');
      const indent = item[1]?.length ?? 0;
      const items: { lines: string[]; loose: boolean }[] = [];
      const start = ordered ? Number.parseInt(item[2] ?? '1', 10) : 1;
      while (i < lines.length) {
        const m = ITEM.exec(lines[i] ?? '');
        if (!m || (m[1]?.length ?? 0) !== indent || /\d/.test(m[2] ?? '') !== ordered) break;
        const col = indent + (m[2]?.length ?? 1) + Math.max(1, Math.min(4, m[3]?.length ?? 1));
        const body = [m[4] ?? ''];
        let loose = false;
        i++;
        while (i < lines.length) {
          const l = lines[i] ?? '';
          if (!l.trim()) {
            const next = lines[i + 1] ?? '';
            if (next.trim() && leading(next) >= col) {
              body.push('');
              loose = true;
              i++;
              continue;
            }
            break;
          }
          if (leading(l) >= col) {
            body.push(l.slice(col));
            i++;
            continue;
          }
          // Lazy continuation of the item's paragraph.
          if (!startsBlock(l) && (body.at(-1) ?? '').trim()) {
            body.push(l.trim());
            i++;
            continue;
          }
          break;
        }
        items.push({ lines: body, loose });
        // A blank line between items makes the list loose; the next item continues the list.
        if (!(lines[i] ?? '').trim() && ITEM.test(lines[i + 1] ?? '')) {
          const m2 = ITEM.exec(lines[i + 1] ?? '');
          if (m2 && (m2[1]?.length ?? 0) === indent) i++;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
      out.push(
        `<${tag}${startAttr}>${items
          .map((it) => {
            let first = it.lines[0] ?? '';
            let task = '';
            const t = /^\[([ xX])\][ ]+/.exec(first);
            if (t) {
              task = `<input type="checkbox" disabled${t[1] === ' ' ? '' : ' checked'}> `;
              first = first.slice(t[0].length);
            }
            let html = renderBlocks([first, ...it.lines.slice(1)], opts, ids, depth + 1);
            if (!it.loose) html = html.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
            return `<li>${task}${html}</li>`;
          })
          .join('')}</${tag}>`,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (!l.trim() || (para.length && startsBlock(l))) break;
      if (para.length && l.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) break;
      para.push(l.trim() ? l.replace(/^ {1,3}/, '') : l);
      i++;
    }
    out.push(`<p>${inline(para.join('\n'), opts)}</p>`);
  }
  return out.join('\n');
}

function leading(s: string): number {
  return s.length - s.trimStart().length;
}

function cells(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  for (let k = 0; k < r.length; k++) {
    const c = r[k];
    if (c === '\\' && r[k + 1] === '|') {
      cur += '|';
      k++;
    } else if (c === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const PUNCT = /[!-/:-@[-`{-~]/;
/** How far an opener looks for its closer, and how deep markup nests: work stays linear. */
const WINDOW = 4000;
const MAX_DEPTH = 16;

/** The first `needle` after `from`, within the window; -1 when there is none. */
function find(src: string, needle: string, from: number): number {
  const at = src.slice(from, from + WINDOW).indexOf(needle);
  return at < 0 ? -1 : from + at;
}

/** For each `[`, the index of its matching `]` (or -1): one pass, so links stay linear. */
function matchBrackets(src: string): Int32Array {
  const match = new Int32Array(src.length).fill(-1);
  const stack: number[] = [];
  for (let k = 0; k < src.length; k++) {
    const ch = src[k];
    if (ch === '\\') k++;
    else if (ch === '[') stack.push(k);
    else if (ch === ']') {
      const open = stack.pop();
      if (open !== undefined) match[open] = k;
    }
  }
  return match;
}

/** Inline Markdown to HTML. Everything that is not markup is escaped. */
export function inline(src: string, opts: MarkdownOptions = {}, depth = 0): string {
  if (depth > MAX_DEPTH) return esc(src);
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  let brackets: Int32Array | null = null;
  // Valid closers of each emphasis delimiter, found once (whether a closer is valid does not
  // depend on its opener), so many unmatched openers stay linear.
  const closers = new Map<string, number[]>();
  const closerAfter = (d: string, from: number): number => {
    let list = closers.get(d);
    if (!list) {
      list = [];
      const c = d[0];
      const strong = d.length === 2;
      for (let p = src.indexOf(d); p >= 0; p = src.indexOf(d, p + 1)) {
        const before = src[p - 1] ?? ' ';
        const next = src[p + d.length] ?? ' ';
        if (
          /\S/.test(before) &&
          !(c === '_' && /[A-Za-z0-9]/.test(next)) &&
          // A single * must not be the start of a ** run.
          (strong || src[p + 1] !== c || src[p - 1] === c)
        )
          list.push(p);
      }
      closers.set(d, list);
    }
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid] ?? 0) < from) lo = mid + 1;
      else hi = mid;
    }
    const at = list[lo];
    return at === undefined || at - from > WINDOW ? -1 : at;
  };
  while (i < n) {
    const c = src[i] ?? '';
    if (c === '\\') {
      const next = src[i + 1] ?? '';
      if (next === '\n') {
        out.push('<br>');
        i += 2;
        continue;
      }
      if (PUNCT.test(next)) {
        out.push(esc(next));
        i += 2;
        continue;
      }
    }
    if (c === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const close = find(src, fence, i + run);
      if (close > 0 && src[close + run] !== '`') {
        let code = src.slice(i + run, close).replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        out.push(`<code>${esc(code)}</code>`);
        i = close + run;
        continue;
      }
      out.push(esc(fence));
      i += run;
      continue;
    }
    if ((c === '!' && src[i + 1] === '[') || c === '[') {
      const image = c === '!';
      brackets ??= matchBrackets(src);
      const link = parseLink(src, image ? i + 1 : i, brackets);
      if (link) {
        const href = safeUrl(link.url);
        if (image) {
          out.push(
            href
              ? `<img src="${esc(href)}" alt="${esc(plain(link.text))}"${link.title ? ` title="${esc(link.title)}"` : ''}>`
              : esc(plain(link.text)),
          );
        } else {
          const target = href ? (opts.link ? opts.link(href) : href) : '#';
          const external = /^(https?:)?\/\//i.test(target);
          out.push(
            `<a href="${esc(target)}"${link.title ? ` title="${esc(link.title)}"` : ''}${
              external ? ' rel="noopener noreferrer"' : ''
            }>${inline(link.text, opts, depth + 1)}</a>`,
          );
        }
        i = link.end;
        continue;
      }
    }
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i, i + 2048));
      if (m?.[1]) {
        out.push(`<a href="${esc(m[1])}" rel="noopener noreferrer">${esc(m[1])}</a>`);
        i += m[0].length;
        continue;
      }
    }
    if (c === '~' && src[i + 1] === '~') {
      const close = find(src, '~~', i + 2);
      if (close > i + 2) {
        out.push(`<del>${inline(src.slice(i + 2, close), opts, depth + 1)}</del>`);
        i = close + 2;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const strong = src[i + 1] === c;
      const d = strong ? c + c : c;
      const prev = src[i - 1] ?? ' ';
      const after = src[i + d.length] ?? ' ';
      const opens = /\S/.test(after) && !(c === '_' && /[A-Za-z0-9]/.test(prev));
      if (opens) {
        const close = closerAfter(d, i + d.length + 1);
        if (close > i + d.length) {
          const tag = strong ? 'strong' : 'em';
          out.push(`<${tag}>${inline(src.slice(i + d.length, close), opts, depth + 1)}</${tag}>`);
          i = close + d.length;
          continue;
        }
      }
    }
    if (c === '\n') {
      // Two trailing spaces before a line end make a hard break.
      if (out.at(-1) === ' ' && out.at(-2) === ' ') {
        while (out.at(-1) === ' ') out.pop();
        out.push('<br>');
      } else out.push('\n');
      i++;
      continue;
    }
    if (
      c === 'h' &&
      (src.startsWith('http://', i) || src.startsWith('https://', i)) &&
      !/[A-Za-z0-9]/.test(src[i - 1] ?? ' ')
    ) {
      const m = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/i.exec(src.slice(i, i + 2048));
      if (m) {
        out.push(`<a href="${esc(m[0])}" rel="noopener noreferrer">${esc(m[0])}</a>`);
        i += m[0].length;
        continue;
      }
    }
    out.push(esc(c));
    i++;
  }
  return out.join('');
}

/** The text of inline Markdown without markup (alt text). */
function plain(s: string): string {
  return s.replace(/[*_`~[\]]/g, '');
}

function parseLink(
  src: string,
  at: number,
  brackets: Int32Array,
): { text: string; url: string; title: string | null; end: number } | null {
  if (src[at] !== '[') return null;
  const k = brackets[at] ?? -1;
  if (k < 0 || src[k + 1] !== '(') return null;
  const text = src.slice(at + 1, k);
  const rest = src.slice(k + 2, k + 2 + 2048);
  const m =
    /^[ ]*(?:<([^<>\n]*)>|([^\s()]*(?:\([^\s()]*\)[^\s()]*)*))(?:[ ]+"([^"\n]*)")?[ ]*\)/.exec(
      rest,
    );
  if (!m) return null;
  return { text, url: m[1] ?? m[2] ?? '', title: m[3] ?? null, end: k + 2 + m[0].length };
}
