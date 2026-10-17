// YAML front-matter for SKILL.md, command and role files (FR-046, docs/08 §3.1, §4). Skills
// from other tools use a small part of YAML: `key: value` pairs, quoted strings, flow lists and
// maps, block lists, nested maps and block scalars. This parser covers that subset without a
// dependency. Colons inside an unquoted value are kept (docs/08 §4); anything it cannot read is
// an error, never a guess.

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

export interface ParsedMarkdown {
  /** The front-matter mapping; empty when the file has none. */
  data: Record<string, YamlValue>;
  /** The text after the front-matter. */
  body: string;
  /** Whether the file starts with a front-matter block. */
  hasFrontmatter: boolean;
}

export class FrontmatterError extends Error {}

const FENCE = /^---[ \t]*$/;

/** Split a Markdown file into its front-matter mapping and body. */
export function parseFrontmatterMarkdown(text: string): ParsedMarkdown {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (!FENCE.test(lines[0] ?? '')) return { data: {}, body: src, hasFrontmatter: false };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i]!) || /^\.\.\.[ \t]*$/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new FrontmatterError('the front-matter block is not closed with ---');
  const yaml = lines.slice(1, end).join('\n');
  const parsed = parseYamlSubset(yaml);
  if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed)))
    throw new FrontmatterError('the front-matter must be a mapping of keys to values');
  return {
    data: parsed ?? {},
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n+/, ''),
    hasFrontmatter: true,
  };
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

/** Parse the YAML subset; null for an empty document. */
export function parseYamlSubset(yaml: string): Record<string, YamlValue> | YamlValue[] | null {
  const lines: Line[] = [];
  yaml.split('\n').forEach((raw, i) => {
    if (/\t/.test(raw.match(/^\s*/)?.[0] ?? ''))
      throw new FrontmatterError(`line ${i + 1}: tabs are not allowed for indentation`);
    const text = raw.trimEnd();
    if (text.trim() === '' || /^\s*#/.test(text)) {
      // Blank lines and comments are kept as markers only inside block scalars.
      lines.push({ indent: -1, text: '', no: i + 1 });
      return;
    }
    lines.push({
      indent: text.length - text.trimStart().length,
      text: text.trimStart(),
      no: i + 1,
    });
  });
  const p = new Parser(lines, yaml.split('\n'));
  const first = p.nextContent();
  if (first < 0) return null;
  const value = p.block(lines[first]!.indent);
  if (p.nextContent() >= 0)
    throw new FrontmatterError(`line ${lines[p.nextContent()]!.no}: unexpected indentation`);
  return value as Record<string, YamlValue> | YamlValue[];
}

class Parser {
  #i = 0;
  readonly #lines: Line[];
  readonly #raw: string[];

  constructor(lines: Line[], raw: string[]) {
    this.#lines = lines;
    this.#raw = raw;
  }

  /** Index of the next non-blank line at or after the cursor, or -1. */
  nextContent(): number {
    let j = this.#i;
    while (j < this.#lines.length && this.#lines[j]!.indent < 0) j++;
    if (j >= this.#lines.length) return -1;
    this.#i = j;
    return j;
  }

  /** A mapping or a sequence whose lines start at `indent`. */
  block(indent: number): YamlValue {
    const at = this.nextContent();
    const line = this.#lines[at]!;
    if (line.text === '-' || line.text.startsWith('- ')) return this.#sequence(indent);
    return this.#mapping(indent);
  }

  #sequence(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (;;) {
      const at = this.nextContent();
      if (at < 0) break;
      const line = this.#lines[at]!;
      if (line.indent < indent) break;
      if (line.indent > indent)
        throw new FrontmatterError(`line ${line.no}: unexpected indentation`);
      if (!(line.text === '-' || line.text.startsWith('- '))) break;
      const rest = line.text.slice(1).trimStart();
      this.#i = at + 1;
      if (rest === '') {
        const next = this.nextContent();
        out.push(
          next >= 0 && this.#lines[next]!.indent > indent
            ? this.block(this.#lines[next]!.indent)
            : null,
        );
        continue;
      }
      if (keyOf(rest)) {
        // `- key: value` starts a mapping whose other keys align with `key`.
        const childIndent = indent + (line.text.length - rest.length);
        this.#i = at;
        this.#lines[at] = { indent: childIndent, text: rest, no: line.no };
        out.push(this.#mapping(childIndent));
        continue;
      }
      out.push(this.#scalarValue(rest, line, indent));
    }
    return out;
  }

  #mapping(indent: number): Record<string, YamlValue> {
    const out: Record<string, YamlValue> = {};
    for (;;) {
      const at = this.nextContent();
      if (at < 0) break;
      const line = this.#lines[at]!;
      if (line.indent < indent) break;
      if (line.indent > indent)
        throw new FrontmatterError(`line ${line.no}: unexpected indentation`);
      const kv = keyOf(line.text);
      if (!kv) throw new FrontmatterError(`line ${line.no}: expected "key: value"`);
      if (Object.hasOwn(out, kv.key))
        throw new FrontmatterError(`line ${line.no}: duplicate key ${kv.key}`);
      this.#i = at + 1;
      if (kv.rest === '') {
        const next = this.nextContent();
        if (next >= 0) {
          const n = this.#lines[next]!;
          const isSeq = n.text === '-' || n.text.startsWith('- ');
          // A block list may sit at the same indentation as its key.
          if (n.indent > indent || (isSeq && n.indent === indent)) {
            out[kv.key] = this.block(n.indent);
            continue;
          }
        }
        out[kv.key] = null;
        continue;
      }
      out[kv.key] = this.#scalarValue(kv.rest, line, indent);
    }
    return out;
  }

  /** A value on the same line as its key or dash, with block scalars and plain continuations. */
  #scalarValue(rest: string, line: Line, indent: number): YamlValue {
    const block = /^([|>])([+-]?)\s*(#.*)?$/.exec(rest);
    if (block) return this.#blockScalar(block[1] === '>', block[2] ?? '', indent);
    if (rest.startsWith('[') || rest.startsWith('{')) return this.#flow(rest, line);
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const { value, end } = quoted(rest, 0, line.no);
      const tail = rest.slice(end).trim();
      if (tail && !tail.startsWith('#'))
        throw new FrontmatterError(`line ${line.no}: text after a quoted value`);
      return value;
    }
    // A plain scalar may continue on more-indented lines (folded with spaces).
    let text = stripComment(rest);
    for (;;) {
      const next = this.nextContent();
      if (next < 0) break;
      const n = this.#lines[next]!;
      if (n.indent <= indent || keyOf(n.text) || n.text.startsWith('- ')) break;
      text += ` ${stripComment(n.text)}`;
      this.#i = next + 1;
    }
    return plain(text);
  }

  #blockScalar(folded: boolean, chomp: string, indent: number): string {
    const parts: string[] = [];
    let blockIndent = -1;
    let j = this.#i;
    for (; j < this.#lines.length; j++) {
      const l = this.#lines[j]!;
      const raw = this.#raw[l.no - 1] ?? '';
      if (raw.trim() === '') {
        parts.push('');
        continue;
      }
      const ind = raw.length - raw.trimStart().length;
      if (ind <= indent) break;
      if (blockIndent < 0) blockIndent = ind;
      if (ind < blockIndent) break;
      parts.push(raw.slice(blockIndent).trimEnd());
    }
    this.#i = j;
    while (parts.length && parts.at(-1) === '') parts.pop();
    let text = folded ? fold(parts) : parts.join('\n');
    if (chomp !== '-') text += '\n';
    return text;
  }

  #flow(rest: string, line: Line): YamlValue {
    // A flow collection may span lines until its brackets balance.
    let src = rest;
    while (!balanced(src)) {
      const next = this.nextContent();
      if (next < 0) throw new FrontmatterError(`line ${line.no}: unclosed ${rest[0]}`);
      src += ` ${this.#lines[next]!.text}`;
      this.#i = next + 1;
    }
    const r = new FlowReader(src, line.no);
    const value = r.value();
    r.skipSpace();
    if (r.pos < src.length && src[r.pos] !== '#')
      throw new FrontmatterError(`line ${line.no}: text after a flow value`);
    return value;
  }
}

function keyOf(text: string): { key: string; rest: string } | null {
  if (text.startsWith('"') || text.startsWith("'")) {
    try {
      const { value, end } = quoted(text, 0, 0);
      const after = text.slice(end);
      if (after === ':' || after.startsWith(': '))
        return { key: value, rest: after.slice(1).trim() };
    } catch {
      return null;
    }
    return null;
  }
  const m = /^([A-Za-z0-9_][A-Za-z0-9_.\- ]*?)\s*:(?:\s+(.*))?$/.exec(text);
  if (!m) return null;
  return { key: m[1]!, rest: (m[2] ?? '').trim() };
}

function stripComment(text: string): string {
  const i = text.search(/\s#/);
  return (i >= 0 ? text.slice(0, i) : text).trim();
}

function plain(text: string): YamlValue {
  const t = text.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(t)) return Number(t);
  if (/^[-+]?([0-9]*\.[0-9]+|[0-9]+\.[0-9]*)([eE][-+]?[0-9]+)?$/.test(t)) return Number(t);
  return t;
}

function fold(parts: string[]): string {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (i === 0) out = p;
    else if (p === '') out += '\n';
    else out += out.endsWith('\n') || out === '' ? p : ` ${p}`;
  }
  return out;
}

function balanced(src: string): boolean {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'") {
      try {
        i = quoted(src, i, 0).end - 1;
      } catch {
        return false;
      }
      continue;
    }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

/** A quoted string starting at `start`; `end` is the index after the closing quote. */
function quoted(src: string, start: number, lineNo: number): { value: string; end: number } {
  const q = src[start];
  let out = '';
  let i = start + 1;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (q === "'") {
      if (c === "'") {
        if (src[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return { value: out, end: i + 1 };
      }
      out += c;
      continue;
    }
    if (c === '"') return { value: out, end: i + 1 };
    if (c === '\\') {
      const n = src[++i];
      const map: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        '"': '"',
        '\\': '\\',
        '/': '/',
        '0': '\0',
      };
      if (n === 'u') {
        const hex = src.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex))
          throw new FrontmatterError(`line ${lineNo}: bad \\u escape`);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        continue;
      }
      if (n === undefined || !(n in map)) throw new FrontmatterError(`line ${lineNo}: bad escape`);
      out += map[n];
      continue;
    }
    out += c;
  }
  throw new FrontmatterError(`line ${lineNo}: unclosed quote`);
}

class FlowReader {
  pos = 0;
  readonly #src: string;
  readonly #line: number;

  constructor(src: string, line: number) {
    this.#src = src;
    this.#line = line;
  }

  skipSpace(): void {
    while (this.pos < this.#src.length && /\s/.test(this.#src[this.pos]!)) this.pos++;
  }

  value(): YamlValue {
    this.skipSpace();
    const c = this.#src[this.pos];
    if (c === '[') return this.#list();
    if (c === '{') return this.#map();
    if (c === '"' || c === "'") {
      const { value, end } = quoted(this.#src, this.pos, this.#line);
      this.pos = end;
      return value;
    }
    const start = this.pos;
    while (this.pos < this.#src.length && !',]}'.includes(this.#src[this.pos]!)) this.pos++;
    return plain(this.#src.slice(start, this.pos));
  }

  #list(): YamlValue[] {
    const out: YamlValue[] = [];
    this.pos++;
    for (;;) {
      this.skipSpace();
      if (this.#src[this.pos] === ']') {
        this.pos++;
        return out;
      }
      out.push(this.value());
      this.skipSpace();
      const c = this.#src[this.pos];
      if (c === ',') this.pos++;
      else if (c !== ']')
        throw new FrontmatterError(`line ${this.#line}: expected , or ] in a list`);
    }
  }

  #map(): Record<string, YamlValue> {
    const out: Record<string, YamlValue> = {};
    this.pos++;
    for (;;) {
      this.skipSpace();
      if (this.#src[this.pos] === '}') {
        this.pos++;
        return out;
      }
      let key: string;
      const c = this.#src[this.pos];
      if (c === '"' || c === "'") {
        const q = quoted(this.#src, this.pos, this.#line);
        key = q.value;
        this.pos = q.end;
      } else {
        const start = this.pos;
        while (this.pos < this.#src.length && !':,}'.includes(this.#src[this.pos]!)) this.pos++;
        key = this.#src.slice(start, this.pos).trim();
      }
      this.skipSpace();
      if (this.#src[this.pos] !== ':' || !key)
        throw new FrontmatterError(`line ${this.#line}: expected key: value in a map`);
      this.pos++;
      out[key] = this.value();
      this.skipSpace();
      const d = this.#src[this.pos];
      if (d === ',') this.pos++;
      else if (d !== '}')
        throw new FrontmatterError(`line ${this.#line}: expected , or } in a map`);
    }
  }
}

/** Front-matter text for generated files (converted commands, new skills): JSON scalars are YAML. */
export function renderFrontmatter(data: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}
