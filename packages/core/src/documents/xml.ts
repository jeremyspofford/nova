// A small XML reader and writer helpers for the document formats (FR-219). Office files are zip
// packages of XML parts; reading them needs only elements, attributes and text, so this parser
// keeps to that: no DTDs (refused, so no entity expansion), no namespaces beyond the prefix in
// each name, the five predefined entities and character references. Limits bound the work.
import { NovaError } from '@nova/shared';

export interface XmlElement {
  /** The qualified name as written, e.g. `w:p`. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

export interface XmlLimits {
  maxNodes: number;
  maxDepth: number;
}

const DEFAULT_LIMITS: XmlLimits = { maxNodes: 4_000_000, maxDepth: 256 };

function bad(message: string, where?: string): NovaError {
  return new NovaError('validation', where ? `${where}: ${message}` : message);
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decode the predefined entities and character references in text or an attribute value. */
export function decodeEntities(s: string, where?: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);?/g, (m, body: string) => {
    if (!m.endsWith(';')) throw bad(`malformed entity "${m}"`, where);
    if (body.startsWith('#x') || body.startsWith('#')) {
      const code = body.startsWith('#x')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff)
        throw bad(`invalid character reference "${m}"`, where);
      return String.fromCodePoint(code);
    }
    const v = NAMED[body];
    if (v === undefined) throw bad(`undefined entity "${m}"`, where);
    return v;
  });
}

/**
 * Parse an XML document into its root element. Throws `validation` when it is not well formed
 * (mismatched tags, a DOCTYPE, text outside the root, unknown entities) or exceeds the limits.
 */
export function parseXml(
  text: string,
  where?: string,
  limits: XmlLimits = DEFAULT_LIMITS,
): XmlElement {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let nodes = 0;
  let i = 0;
  const n = src.length;
  const pushText = (t: string) => {
    if (!t) return;
    const top = stack.at(-1);
    if (!top) {
      if (t.trim()) throw bad('text outside the root element', where);
      return;
    }
    if (++nodes > limits.maxNodes) throw bad('too many XML nodes', where);
    top.children.push(t);
  };
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      pushText(decodeEntities(src.slice(i), where));
      break;
    }
    if (lt > i) pushText(decodeEntities(src.slice(i, lt), where));
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) throw bad('unterminated processing instruction', where);
      i = end + 2;
    } else if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) throw bad('unterminated comment', where);
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) throw bad('unterminated CDATA section', where);
      if (!stack.length) throw bad('CDATA outside the root element', where);
      pushText(src.slice(lt + 9, end));
      i = end + 3;
    } else if (src.startsWith('<!', lt)) {
      throw bad('document type declarations are not allowed', where);
    } else if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt + 2);
      if (end < 0) throw bad('unterminated end tag', where);
      const name = src.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name)
        throw bad(`end tag </${name}> does not match <${top?.name ?? ''}>`, where);
      i = end + 1;
    } else {
      // A start tag: name, attributes, then `>` or `/>`.
      let j = lt + 1;
      while (j < n && !/[\s/>]/.test(src[j]!)) j++;
      const name = src.slice(lt + 1, j);
      if (!/^[A-Za-z_][\w.:-]*$/.test(name)) throw bad(`invalid element name "${name}"`, where);
      const attrs: Record<string, string> = {};
      let selfClose = false;
      for (;;) {
        while (j < n && /\s/.test(src[j]!)) j++;
        if (j >= n) throw bad(`unterminated start tag <${name}>`, where);
        if (src[j] === '>') {
          j++;
          break;
        }
        if (src.startsWith('/>', j)) {
          selfClose = true;
          j += 2;
          break;
        }
        const eq = src.indexOf('=', j);
        if (eq < 0) throw bad(`malformed attribute in <${name}>`, where);
        const an = src.slice(j, eq).trim();
        if (!/^[A-Za-z_][\w.:-]*$/.test(an))
          throw bad(`invalid attribute name in <${name}>`, where);
        let k = eq + 1;
        while (k < n && /\s/.test(src[k]!)) k++;
        const q = src[k];
        if (q !== '"' && q !== "'") throw bad(`unquoted attribute ${an} in <${name}>`, where);
        const close = src.indexOf(q, k + 1);
        if (close < 0) throw bad(`unterminated attribute ${an} in <${name}>`, where);
        const raw = src.slice(k + 1, close);
        if (raw.includes('<')) throw bad(`"<" in attribute ${an} of <${name}>`, where);
        if (an in attrs) throw bad(`duplicate attribute ${an} in <${name}>`, where);
        attrs[an] = decodeEntities(raw, where);
        j = close + 1;
      }
      const el: XmlElement = { name, attrs, children: [] };
      if (++nodes > limits.maxNodes) throw bad('too many XML nodes', where);
      const parent = stack.at(-1);
      if (parent) parent.children.push(el);
      else if (root) throw bad('more than one root element', where);
      else root = el;
      if (!selfClose) {
        stack.push(el);
        if (stack.length > limits.maxDepth) throw bad('XML nested too deeply', where);
      }
      i = j;
    }
  }
  if (stack.length) throw bad(`unclosed element <${stack.at(-1)!.name}>`, where);
  if (!root) throw bad('no root element', where);
  return root;
}

/** The name without its prefix: `w:p` → `p`. */
export function localName(name: string): string {
  const c = name.indexOf(':');
  return c < 0 ? name : name.slice(c + 1);
}

function isElement(n: XmlNode): n is XmlElement {
  return typeof n !== 'string';
}

/** Child elements with this local name (all children when omitted). */
export function childElements(el: XmlElement, local?: string): XmlElement[] {
  return el.children.filter(
    (c): c is XmlElement => isElement(c) && (local === undefined || localName(c.name) === local),
  );
}

export function firstChild(el: XmlElement, local: string): XmlElement | null {
  for (const c of el.children) if (isElement(c) && localName(c.name) === local) return c;
  return null;
}

/** Descendant elements with this local name, in document order. */
export function descendants(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (!isElement(c)) continue;
      if (localName(c.name) === local) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

/** An attribute by local name (`w:val` matches `val`). */
export function attr(el: XmlElement, local: string): string | undefined {
  if (local in el.attrs) return el.attrs[local];
  for (const [k, v] of Object.entries(el.attrs)) if (localName(k) === local) return v;
  return undefined;
}

/** All text inside an element, concatenated. */
export function textContent(el: XmlElement): string {
  let out = '';
  for (const c of el.children) out += isElement(c) ? textContent(c) : c;
  return out;
}

// ---- writing --------------------------------------------------------------------------------------

/** Characters XML 1.0 cannot carry: C0 controls other than tab, LF and CR, and non-characters. */
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Drop characters XML cannot carry, including unpaired surrogates. */
export function xmlSafe(s: string): string {
  return s.replace(INVALID_XML, '').replace(/[\uD800-\uDFFF]/g, (ch, at: number, all: string) => {
    const code = ch.charCodeAt(0);
    if (code <= 0xdbff) {
      const next = all.charCodeAt(at + 1);
      return next >= 0xdc00 && next <= 0xdfff ? ch : '';
    }
    const prev = all.charCodeAt(at - 1);
    return prev >= 0xd800 && prev <= 0xdbff ? ch : '';
  });
}

/** Escape text or an attribute value. */
export function esc(s: string): string {
  return xmlSafe(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
