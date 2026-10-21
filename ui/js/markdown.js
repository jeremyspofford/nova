// A small Markdown renderer for Nova's messages.
//
// Safe by construction: every piece of source text is HTML-escaped before any
// markup is added, so model output can never inject HTML. Links are limited to
// http, https and mailto. It is tolerant of half-written input, because it
// re-renders on every streamed chunk: an unclosed code fence renders as code.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$|^\s*\|\s*:?-+:?\s*\|\s*$/;

const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
const isBlank = (l) => /^\s*$/.test(l);
const ordered = (marker) => /\d/.test(marker);

function startsBlock(lines, i) {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST.test(l) ||
    (l.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]));
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    let m = line.match(FENCE);
    if (m) {
      const [, indent, fence, lang] = m;
      const body = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        const close = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) { closed = true; i++; break; }
        body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i].trimStart());
        i++;
      }
      blocks.push({ type: 'code', lang, text: body.join('\n'), closed });
      continue;
    }

    if ((m = line.match(HEADING))) {
      blocks.push({ type: 'heading', level: m[1].length, text: m[2] });
      i++;
      continue;
    }

    if (HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && !isBlank(lines[i]) && (QUOTE.test(lines[i]) || !startsBlock(lines, i))) {
        inner.push(lines[i].replace(QUOTE, ''));
        i++;
      }
      blocks.push({ type: 'quote', children: parseBlocks(inner) });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const split = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = split(line);
      const align = split(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null));
      const rows = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) { rows.push(split(lines[i])); i++; }
      blocks.push({ type: 'table', head, align, rows });
      continue;
    }

    if ((m = line.match(LIST))) {
      const base = indentOf(m[1]);
      const isOrdered = ordered(m[2]);
      const start = isOrdered ? parseInt(m[2], 10) : 1;
      const items = [];
      let loose = false;
      let cur = null;
      while (i < lines.length) {
        const l = lines[i];
        const lm = l.match(LIST);
        if (lm && indentOf(lm[1]) === base && ordered(lm[2]) === isOrdered) {
          cur = { lines: [l.slice(lm[0].length)], pad: lm[0].length };
          items.push(cur);
          i++;
          continue;
        }
        if (isBlank(l)) {
          const next = lines[i + 1];
          const nm = next?.match(LIST);
          const sameList = nm && indentOf(nm[1]) === base && ordered(nm[2]) === isOrdered;
          if (next !== undefined && !isBlank(next) && (indentOf(next) > base || sameList)) {
            loose = true;
            cur?.lines.push('');
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) > base) {
          cur.lines.push(l.slice(Math.min(indentOf(l), cur.pad)));
          i++;
          continue;
        }
        if (!startsBlock(lines, i) && cur && !isBlank(cur.lines[cur.lines.length - 1])) {
          cur.lines.push(l.trim()); // lazy continuation of the item's paragraph
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: 'list', ordered: isOrdered, start, loose, items: items.map((it) => parseBlocks(it.lines)) });
      continue;
    }

    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines, i))) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'para', text: para.join('\n') });
  }
  return blocks;
}

// Web and mail links, and links to Nova's own views (Skills, Memory, a conversation).
const IN_APP = /^\/(skills|memory|c\/[\w-]+)(#[\w-]*)?$/;
function safeUrl(url) {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) || IN_APP.test(u) ? u : null;
}

export function renderInline(src) {
  // Code spans first, so nothing inside them is treated as markup.
  const codes = [];
  let s = String(src).replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => {
    codes.push(`<code>${escapeHtml(code.trim() === '' ? code : code.replace(/^ (.*) $/, '$1'))}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const links = [];
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (all, text, url) => {
    const href = safeUrl(url);
    if (!href) return all;
    const away = IN_APP.test(href) ? '' : ' target="_blank" rel="noopener noreferrer"';
    links.push(`<a href="${escapeHtml(href)}"${away}>${renderEmphasis(escapeHtml(text))}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  s = s.replace(/\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g, (url) => {
    links.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  s = renderEmphasis(escapeHtml(s));
  s = s.replace(/ {2,}\n|\\\n/g, '<br>').replace(/\n/g, '<br>');
  return s
    .replace(/\u0001(\d+)\u0001/g, (_, n) => links[n])
    .replace(/\u0000(\d+)\u0000/g, (_, n) => codes[n]);
}

function renderEmphasis(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

function renderBlocks(blocks, tight = false) {
  return blocks.map((b) => {
    switch (b.type) {
      case 'heading': return `<h${b.level}>${renderInline(b.text)}</h${b.level}>`;
      case 'hr': return '<hr>';
      case 'para': return tight ? renderInline(b.text) : `<p>${renderInline(b.text)}</p>`;
      case 'quote': return `<blockquote>${renderBlocks(b.children)}</blockquote>`;
      case 'code': {
        const label = b.lang ? escapeHtml(b.lang) : 'code';
        return `<div class="code-block${b.closed ? '' : ' is-open'}"><div class="code-head"><span class="code-lang">${label}</span>` +
          `<button type="button" class="code-copy" data-action="copy-code">Copy</button></div>` +
          `<pre tabindex="0"><code>${escapeHtml(b.text)}</code></pre></div>`;
      }
      case 'table': {
        const cell = (tag, c, j) => `<${tag}${b.align[j] ? ` style="text-align:${b.align[j]}"` : ''}>${renderInline(c ?? '')}</${tag}>`;
        const head = `<tr>${b.head.map((c, j) => cell('th', c, j)).join('')}</tr>`;
        const rows = b.rows.map((r) => `<tr>${b.head.map((_, j) => cell('td', r[j], j)).join('')}</tr>`).join('');
        return `<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
      }
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
        const items = b.items.map((it) => `<li>${renderBlocks(it, !b.loose)}</li>`).join('');
        return `<${tag}${start}>${items}</${tag}>`;
      }
      default: return '';
    }
  }).join(tight ? '' : '\n');
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  return renderBlocks(parseBlocks(lines));
}
