// PDF (FR-219). The writer lays out headings, wrapped paragraphs with bold and italic runs,
// lists and simple tables on A4 or Letter pages in the standard sans-serif fonts (not embedded),
// with compressed content streams and page numbers. The reader extracts text from simple PDFs:
// it walks the page tree, inflates content streams and decodes the strings that Tj, TJ, ' and "
// show, through each font's ToUnicode map or its simple encoding. When text cannot be read (a
// scan, fonts without a character map, encryption, an unsupported compression) it says so.
import { zlibSync } from 'fflate';
import { NovaError } from '@nova/shared';
import {
  inlineRuns,
  type DocBlock,
  type InlineText,
  type PageSize,
  type PdfContent,
} from './content.ts';
import type { DocumentMeta } from './docx.ts';
import { decodeWinAnsi, encodeWinAnsi, textWidth } from './pdf-fonts.ts';
import type { ExtractedDocument, ExtractedPage } from './types.ts';
import { inflateBounded } from './zip.ts';

// ---- writing -----------------------------------------------------------------------------------

const PAGE_PT: Record<PageSize, { w: number; h: number }> = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
};
const MARGIN = 56;
const BODY = 11;
const LEADING = 1.4;
const HEADING_SIZE = [0, 20, 16, 13];
const TABLE_SIZE = 9.5;
const CELL_PAD = 4;
const LIST_INDENT = 18;

type FontKey = 'F1' | 'F2' | 'F3' | 'F4';
const FONTS: [FontKey, string][] = [
  ['F1', 'Helvetica'],
  ['F2', 'Helvetica-Bold'],
  ['F3', 'Helvetica-Oblique'],
  ['F4', 'Helvetica-BoldOblique'],
];

function fontOf(bold?: boolean, italic?: boolean): FontKey {
  if (bold && italic) return 'F4';
  if (bold) return 'F2';
  if (italic) return 'F3';
  return 'F1';
}

const isBold = (f: FontKey) => f === 'F2' || f === 'F4';

interface Segment {
  font: FontKey;
  bytes: number[];
}

/** A PDF literal string body for WinAnsi bytes. */
function pdfString(bytes: readonly number[]): string {
  let s = '';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) s += `\\${b.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(b);
  }
  return `(${s})`;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();

class PdfLayout {
  readonly pages: string[][] = [];
  readonly page: { w: number; h: number };
  replaced = 0;
  #y = 0;
  #ops: string[] = [];

  constructor(size: PageSize) {
    this.page = PAGE_PT[size];
    this.newPage();
  }

  get width(): number {
    return this.page.w - 2 * MARGIN;
  }

  newPage(): void {
    this.#ops = [];
    this.pages.push(this.#ops);
    this.#y = this.page.h - MARGIN;
  }

  /** Start a new page unless `h` points fit; returns whether it moved. */
  ensure(h: number): boolean {
    if (this.#y - h >= MARGIN || this.#atTop()) return false;
    this.newPage();
    return true;
  }

  #atTop(): boolean {
    return this.#y >= this.page.h - MARGIN - 0.01;
  }

  gap(h: number): void {
    if (!this.#atTop()) this.#y -= h;
  }

  encode(text: string): number[] {
    const r = encodeWinAnsi(text);
    this.replaced += r.replaced;
    return r.bytes;
  }

  /** Break runs into lines no wider than `width`; `\n` forces a break. */
  wrap(runs: { text: string; font: FontKey }[], size: number, width: number): Segment[][] {
    const lines: Segment[][] = [[]];
    let lineW = 0;
    const push = (font: FontKey, bytes: number[]) => {
      const line = lines.at(-1)!;
      const last = line.at(-1);
      if (last && last.font === font) last.bytes.push(...bytes);
      else line.push({ font, bytes: [...bytes] });
    };
    const breakLine = () => {
      const line = lines.at(-1)!;
      // Trailing spaces do not count.
      const last = line.at(-1);
      while (last && last.bytes.at(-1) === 0x20) last.bytes.pop();
      lines.push([]);
      lineW = 0;
    };
    for (const run of runs) {
      const pieces = run.text.replace(/\r\n?/g, '\n').split(/(\n| +)/);
      for (const piece of pieces) {
        if (!piece) continue;
        if (piece === '\n') {
          breakLine();
          continue;
        }
        const bytes = this.encode(piece);
        const w = textWidth(bytes, size, isBold(run.font));
        if (piece.startsWith(' ')) {
          if (lineW === 0) continue;
          if (lineW + w > width) breakLine();
          else {
            push(run.font, bytes);
            lineW += w;
          }
          continue;
        }
        if (lineW + w <= width) {
          push(run.font, bytes);
          lineW += w;
          continue;
        }
        if (lineW > 0) breakLine();
        // A word wider than the line is split by characters.
        let part: number[] = [];
        let partW = 0;
        for (const b of bytes) {
          const bw = textWidth([b], size, isBold(run.font));
          if (partW + bw > width && part.length) {
            push(run.font, part);
            breakLine();
            part = [];
            partW = 0;
          }
          part.push(b);
          partW += bw;
        }
        if (part.length) {
          push(run.font, part);
          lineW = partW;
        }
      }
    }
    const last = lines.at(-1)!;
    if (!last.length && lines.length > 1) lines.pop();
    return lines;
  }

  /** Draw lines at `x`, starting a new page when the next line does not fit. */
  lines(
    lines: Segment[][],
    x: number,
    size: number,
    prefix?: { text: number[]; font: FontKey; x: number },
  ): void {
    const lh = size * LEADING;
    lines.forEach((segs, i) => {
      this.ensure(lh);
      this.#y -= lh;
      const baseline = this.#y + (lh - size) / 2 + size * 0.22;
      if (i === 0 && prefix)
        this.#text([{ font: prefix.font, bytes: prefix.text }], prefix.x, baseline, size);
      this.#text(segs, x, baseline, size);
    });
  }

  #text(segs: Segment[], x: number, y: number, size: number): void {
    if (!segs.some((s) => s.bytes.length)) return;
    let ops = `BT 1 0 0 1 ${num(x)} ${num(y)} Tm`;
    for (const s of segs)
      if (s.bytes.length) ops += ` /${s.font} ${num(size)} Tf ${pdfString(s.bytes)} Tj`;
    this.#ops.push(`${ops} ET`);
  }

  table(b: Extract<DocBlock, { type: 'table' }>): void {
    const rows = b.header ? [b.header, ...b.rows] : b.rows;
    if (!rows.length) return;
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const colW = this.width / cols;
    const lh = TABLE_SIZE * LEADING;
    const maxLines = Math.max(1, Math.floor((this.page.h - 2 * MARGIN - 2 * CELL_PAD) / lh) - 1);
    const layout = (cells: string[], header: boolean) =>
      Array.from({ length: cols }, (_, c) =>
        this.wrap(
          [{ text: cells[c] ?? '', font: header ? 'F2' : 'F1' }],
          TABLE_SIZE,
          colW - 2 * CELL_PAD,
        ).slice(0, maxLines),
      );
    const headerCells = b.header ? layout(b.header, true) : null;
    const drawRow = (cells: Segment[][][]) => {
      const h = Math.max(1, ...cells.map((c) => c.length)) * lh + 2 * CELL_PAD;
      const top = this.#y;
      cells.forEach((lines, c) => {
        const x = MARGIN + c * colW;
        lines.forEach((segs, i) => {
          const baseline =
            top - CELL_PAD - (i + 1) * lh + (lh - TABLE_SIZE) / 2 + TABLE_SIZE * 0.22;
          this.#text(segs, x + CELL_PAD, baseline, TABLE_SIZE);
        });
        this.#ops.push(`0.6 G 0.5 w ${num(x)} ${num(top - h)} ${num(colW)} ${num(h)} re S 0 G`);
      });
      this.#y -= h;
    };
    rows.forEach((r, i) => {
      const header = i === 0 && !!b.header;
      const cells = header && headerCells ? headerCells : layout(r, false);
      const h = Math.max(1, ...cells.map((c) => c.length)) * lh + 2 * CELL_PAD;
      // A table continued on a new page repeats its header row.
      if (this.ensure(h) && headerCells && !header) drawRow(headerCells);
      drawRow(cells);
    });
  }

  /** Small centered page numbers once the page count is known. */
  footers(): void {
    const n = this.pages.length;
    this.pages.forEach((ops, i) => {
      const label = this.encode(`${i + 1} / ${n}`);
      const w = textWidth(label, 8, false);
      ops.push(
        `BT 0.45 g 1 0 0 1 ${num((this.page.w - w) / 2)} ${num(MARGIN / 2)} Tm /F1 8 Tf ${pdfString(label)} Tj ET 0 g`,
      );
    });
  }
}

function runsOf(t: InlineText): { text: string; font: FontKey }[] {
  return inlineRuns(t).map((r) => ({ text: r.text, font: fontOf(r.bold, r.italic) }));
}

/** A PDF text string for the document information dictionary (UTF-16BE with a BOM). */
function infoString(s: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++)
    hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

function pdfDate(d: Date): string {
  const iso = d.toISOString();
  return `(D:${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z)`;
}

/**
 * Write a PDF. `content` must already be validated (parseDocumentContent). `replaced` counts
 * characters the standard fonts cannot show (printed as `?`).
 */
export function writePdf(
  content: PdfContent,
  meta: DocumentMeta,
): { bytes: Uint8Array; replaced: number } {
  const L = new PdfLayout(content.pageSize);
  for (const b of content.blocks) {
    switch (b.type) {
      case 'heading': {
        const size = HEADING_SIZE[b.level] ?? BODY;
        L.gap(size * 0.9);
        const lines = L.wrap([{ text: b.text, font: 'F2' }], size, L.width);
        // Keep a heading with at least one following line.
        L.ensure(lines.length * size * LEADING + BODY * LEADING);
        L.lines(lines, MARGIN, size);
        L.gap(size * 0.3);
        break;
      }
      case 'paragraph':
        L.lines(L.wrap(runsOf(b.text), BODY, L.width), MARGIN, BODY);
        L.gap(BODY * 0.7);
        break;
      case 'bullets':
      case 'numbered':
        b.items.forEach((item, i) => {
          const marker = L.encode(b.type === 'bullets' ? '•' : `${i + 1}.`);
          L.lines(
            L.wrap(runsOf(item), BODY, L.width - 2 * LIST_INDENT),
            MARGIN + 2 * LIST_INDENT,
            BODY,
            {
              text: marker,
              font: 'F1',
              x: MARGIN + LIST_INDENT - 4,
            },
          );
          L.gap(BODY * 0.2);
        });
        L.gap(BODY * 0.5);
        break;
      case 'table':
        L.table(b);
        L.gap(BODY * 0.8);
        break;
    }
  }
  L.footers();

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  const enc = new TextEncoder();
  const write = (data: string | Uint8Array) => {
    // Every string written here is ASCII (text is escaped to octal), so UTF-8 encoding is exact.
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    at += bytes.length;
  };
  const obj = (id: number, body: string) => {
    offsets[id] = at;
    write(`${id} 0 obj\n${body}\nendobj\n`);
  };
  write('%PDF-1.4\n');
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const pageCount = L.pages.length;
  const firstPage = 8;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(
    2,
    `<< /Type /Pages /Kids [${L.pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  );
  FONTS.forEach(([, base], i) =>
    obj(3 + i, `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`),
  );
  obj(
    7,
    `<< /Title ${infoString(meta.title)} /Producer (Nova) /Creator (Nova) /CreationDate ${pdfDate(meta.created)} >>`,
  );
  const fontRes = FONTS.map(([k], i) => `/${k} ${3 + i} 0 R`).join(' ');
  L.pages.forEach((ops, i) => {
    const pageId = firstPage + i * 2;
    obj(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(L.page.w)} ${num(L.page.h)}] /Resources << /Font << ${fontRes} >> >> /Contents ${pageId + 1} 0 R >>`,
    );
    const data = zlibSync(enc.encode(ops.join('\n')), { level: 6 });
    offsets[pageId + 1] = at;
    write(`${pageId + 1} 0 obj\n<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`);
    write(data);
    write('\nendstream\nendobj\n');
  });
  const size = firstPage + pageCount * 2;
  const xref = at;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++)
    table += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
  write(table);
  write(`trailer\n<< /Size ${size} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(at);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return { bytes: out, replaced: L.replaced };
}

// ---- reading -----------------------------------------------------------------------------------

type PdfValue =
  | number
  | boolean
  | null
  | { t: 'name'; v: string }
  | { t: 'str'; v: string }
  | { t: 'ref'; n: number }
  | { t: 'dict'; v: Map<string, PdfValue> }
  | { t: 'op'; v: string }
  | PdfValue[];

type PdfDict = Map<string, PdfValue>;

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

function isWs(src: string, i: number): boolean {
  return WS.has(src.charCodeAt(i));
}

function skipWs(src: string, i: number): number {
  for (;;) {
    while (i < src.length && isWs(src, i)) i++;
    if (src[i] !== '%') return i;
    while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
  }
}

function readWord(src: string, i: number): number {
  while (i < src.length && !isWs(src, i) && !DELIM.has(src[i]!)) i++;
  return i;
}

function literalString(src: string, i: number): { v: string; end: number } {
  // `i` is just past the opening parenthesis; strings nest balanced parentheses.
  let depth = 1;
  let out = '';
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\') {
      const nx = src[i + 1];
      i += 2;
      switch (nx) {
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case '\r':
          if (src[i] === '\n') i++;
          break;
        case '\n':
          break;
        default:
          if (nx !== undefined && /[0-7]/.test(nx)) {
            let oct = nx;
            while (oct.length < 3 && /[0-7]/.test(src[i] ?? '')) oct += src[i++];
            out += String.fromCharCode(Number.parseInt(oct, 8) & 0xff);
          } else if (nx !== undefined) out += nx;
      }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return { v: out, end: i + 1 };
    out += ch;
    i++;
  }
  return { v: out, end: i };
}

function hexString(src: string, i: number): { v: string; end: number } {
  const close = src.indexOf('>', i);
  const end = close < 0 ? src.length : close;
  let hex = src.slice(i, end).replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length % 2) hex += '0';
  let out = '';
  for (let k = 0; k < hex.length; k += 2)
    out += String.fromCharCode(Number.parseInt(hex.slice(k, k + 2), 16));
  return { v: out, end: end + 1 };
}

/** Parse one value (or a content-stream operator) at `i`; null at the end of input. */
function parseValue(src: string, start: number, depth = 0): { v: PdfValue; end: number } | null {
  const i = skipWs(src, start);
  if (i >= src.length || depth > 64) return null;
  const ch = src[i]!;
  if (ch === '/') {
    const end = readWord(src, i + 1);
    const name = src
      .slice(i + 1, end)
      .replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
    return { v: { t: 'name', v: name }, end };
  }
  if (ch === '(') {
    const s = literalString(src, i + 1);
    return { v: { t: 'str', v: s.v }, end: s.end };
  }
  if (ch === '<' && src[i + 1] === '<') {
    const map: PdfDict = new Map();
    let j = i + 2;
    for (;;) {
      j = skipWs(src, j);
      if (j >= src.length) return { v: { t: 'dict', v: map }, end: j };
      if (src[j] === '>' && src[j + 1] === '>') return { v: { t: 'dict', v: map }, end: j + 2 };
      const key = parseValue(src, j, depth + 1);
      if (!key) return { v: { t: 'dict', v: map }, end: src.length };
      const val = parseValue(src, key.end, depth + 1);
      if (!val) return { v: { t: 'dict', v: map }, end: src.length };
      if (
        typeof key.v === 'object' &&
        key.v !== null &&
        !Array.isArray(key.v) &&
        key.v.t === 'name'
      )
        map.set(key.v.v, val.v);
      j = val.end;
    }
  }
  if (ch === '<') {
    const s = hexString(src, i + 1);
    return { v: { t: 'str', v: s.v }, end: s.end };
  }
  if (ch === '[') {
    const arr: PdfValue[] = [];
    let j = i + 1;
    for (;;) {
      j = skipWs(src, j);
      if (j >= src.length) return { v: arr, end: j };
      if (src[j] === ']') return { v: arr, end: j + 1 };
      const val = parseValue(src, j, depth + 1);
      if (!val) return { v: arr, end: src.length };
      arr.push(val.v);
      j = val.end;
    }
  }
  if (ch === ']' || ch === '>' || ch === ')' || ch === '{' || ch === '}') {
    return { v: { t: 'op', v: ch }, end: i + 1 };
  }
  const end = Math.max(readWord(src, i), i + 1);
  const word = src.slice(i, end);
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
    const n = Number(word);
    // `n g R` is an indirect reference.
    if (/^\d+$/.test(word)) {
      const g = skipWs(src, end);
      const gEnd = readWord(src, g);
      if (/^\d+$/.test(src.slice(g, gEnd))) {
        const r = skipWs(src, gEnd);
        if (src[r] === 'R' && (r + 1 >= src.length || isWs(src, r + 1) || DELIM.has(src[r + 1]!)))
          return { v: { t: 'ref', n }, end: r + 1 };
      }
    }
    return { v: n, end };
  }
  if (word === 'true') return { v: true, end };
  if (word === 'false') return { v: false, end };
  if (word === 'null') return { v: null, end };
  return { v: { t: 'op', v: word }, end };
}

interface PdfObject {
  value: PdfValue;
  stream: Uint8Array | null;
}

const isDict = (v: PdfValue | undefined): v is { t: 'dict'; v: PdfDict } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === 'dict';
const nameOf = (v: PdfValue | undefined): string | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === 'name' ? v.v : null;

const MAX_STREAM = 32 * 1024 * 1024;
const MAX_DECODED = 96 * 1024 * 1024;

class PdfFile {
  readonly objects = new Map<number, PdfObject>();
  readonly src: string;
  readonly bytes: Uint8Array;
  trailer: PdfDict | null = null;
  decoded = 0;
  unsupported = false;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.src = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
    this.#scan();
  }

  #scan(): void {
    const src = this.src;
    const re = /(?<!\d)(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const id = Number(m[1]);
      const parsed = parseValue(src, re.lastIndex);
      if (!parsed) break;
      let end = parsed.end;
      let stream: Uint8Array | null = null;
      const k = skipWs(src, end);
      if (isDict(parsed.v) && src.startsWith('stream', k)) {
        let start = k + 6;
        if (src[start] === '\r') start++;
        if (src[start] === '\n') start++;
        const len = parsed.v.v.get('Length');
        let stop = -1;
        if (
          typeof len === 'number' &&
          len >= 0 &&
          src.startsWith('endstream', skipWs(src, start + len))
        )
          stop = start + len;
        if (stop < 0) {
          const e = src.indexOf('endstream', start);
          stop = e < 0 ? src.length : e;
          if (src[stop - 1] === '\n') stop--;
          if (src[stop - 1] === '\r') stop--;
        }
        stream = this.bytes.subarray(start, stop);
        const after = src.indexOf('endstream', stop);
        end = after < 0 ? src.length : after + 9;
      }
      this.objects.set(id, { value: parsed.v, stream });
      re.lastIndex = Math.max(re.lastIndex, end);
    }
    // The trailer: the last `trailer` dictionary, or the last cross-reference stream's.
    const t = src.lastIndexOf('trailer');
    if (t >= 0) {
      const v = parseValue(src, t + 7);
      if (v && isDict(v.v)) this.trailer = v.v.v;
    }
    if (!this.trailer) {
      for (const o of this.objects.values())
        if (isDict(o.value) && nameOf(o.value.v.get('Type')) === 'XRef') this.trailer = o.value.v;
    }
    this.#objectStreams();
  }

  /** Objects packed in object streams (PDF 1.5) fill ids not defined directly. */
  #objectStreams(): void {
    for (const o of [...this.objects.values()]) {
      if (!isDict(o.value) || nameOf(o.value.v.get('Type')) !== 'ObjStm') continue;
      const data = this.decode(o);
      if (!data) continue;
      const text = Buffer.from(data).toString('latin1');
      const n = this.number(o.value.v.get('N'));
      const first = this.number(o.value.v.get('First'));
      if (n === null || first === null) continue;
      let p = 0;
      const pairs: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const a = parseValue(text, p);
        const b = a ? parseValue(text, a.end) : null;
        if (!a || !b || typeof a.v !== 'number' || typeof b.v !== 'number') break;
        pairs.push([a.v, b.v]);
        p = b.end;
      }
      for (const [id, off] of pairs) {
        if (this.objects.has(id)) continue;
        const v = parseValue(text, first + off);
        if (v) this.objects.set(id, { value: v.v, stream: null });
      }
    }
  }

  number(v: PdfValue | undefined): number | null {
    const r = this.resolve(v);
    return typeof r === 'number' ? r : null;
  }

  resolve(v: PdfValue | undefined, depth = 0): PdfValue | undefined {
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === 'ref') {
      if (depth > 16) return undefined;
      return this.resolve(this.objects.get(v.n)?.value, depth + 1);
    }
    return v;
  }

  dict(v: PdfValue | undefined): PdfDict | null {
    const r = this.resolve(v);
    return isDict(r) ? r.v : null;
  }

  object(v: PdfValue | undefined): PdfObject | null {
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === 'ref')
      return this.objects.get(v.n) ?? null;
    return null;
  }

  /** A stream's decoded bytes; null (and `unsupported`) for filters this reader lacks. */
  decode(o: PdfObject): Uint8Array | null {
    if (!o.stream || !isDict(o.value)) return null;
    const d = o.value.v;
    const f = this.resolve(d.get('Filter'));
    const filters = (Array.isArray(f) ? f : f === undefined ? [] : [f]).map((x) =>
      nameOf(this.resolve(x)),
    );
    let data: Uint8Array = o.stream;
    for (const name of filters) {
      if (name === 'FlateDecode' || name === 'Fl') {
        const parms = this.dict(d.get('DecodeParms'));
        if (parms && (this.number(parms.get('Predictor')) ?? 1) > 1) {
          this.unsupported = true;
          return null;
        }
        data = inflateBounded(data, { zlib: true, max: MAX_STREAM });
      } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
        data = Uint8Array.from(hexString(Buffer.from(data).toString('latin1'), 0).v, (c) =>
          c.charCodeAt(0),
        );
      } else if (name === 'ASCII85Decode' || name === 'A85') {
        data = ascii85(data);
      } else {
        this.unsupported = true;
        return null;
      }
    }
    this.decoded += data.length;
    if (this.decoded > MAX_DECODED)
      throw new NovaError('validation', 'the PDF expands to too much data');
    return data;
  }
}

function ascii85(data: Uint8Array): Uint8Array {
  const src = Buffer.from(data).toString('latin1').replace(/\s+/g, '');
  const end = src.indexOf('~>');
  const s = (src.startsWith('<~') ? src.slice(2) : src).slice(
    0,
    end < 0 ? undefined : end - (src.startsWith('<~') ? 2 : 0),
  );
  const out: number[] = [];
  let group: number[] = [];
  const flush = (count: number) => {
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const c of group) v = v * 85 + c;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...bytes.slice(0, count));
    group = [];
  };
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) flush(4);
  }
  if (group.length) flush(group.length - 1);
  return Uint8Array.from(out);
}

// ---- fonts ---------------------------------------------------------------------------------------

/** Glyph names that appear in /Differences, mapped to text. */
const GLYPHS: Record<string, string> = {
  space: ' ',
  exclam: '!',
  quotedbl: '"',
  numbersign: '#',
  dollar: '$',
  percent: '%',
  ampersand: '&',
  quotesingle: "'",
  quoteright: '’',
  quoteleft: '‘',
  parenleft: '(',
  parenright: ')',
  asterisk: '*',
  plus: '+',
  comma: ',',
  hyphen: '-',
  minus: '-',
  period: '.',
  slash: '/',
  colon: ':',
  semicolon: ';',
  less: '<',
  equal: '=',
  greater: '>',
  question: '?',
  at: '@',
  bracketleft: '[',
  backslash: '\\',
  bracketright: ']',
  asciicircum: '^',
  underscore: '_',
  grave: '`',
  braceleft: '{',
  bar: '|',
  braceright: '}',
  asciitilde: '~',
  bullet: '•',
  endash: '–',
  emdash: '—',
  quotedblleft: '“',
  quotedblright: '”',
  ellipsis: '…',
  fi: 'fi',
  fl: 'fl',
  ff: 'ff',
  ffi: 'ffi',
  ffl: 'ffl',
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

function glyphText(name: string): string | null {
  if (/^[A-Za-z]$/.test(name)) return name;
  const g = GLYPHS[name];
  if (g !== undefined) return g;
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) return String.fromCodePoint(Number.parseInt(uni[1]!, 16));
  return null;
}

interface FontDecoder {
  /** Text of a shown string; unknown codes become U+FFFD. */
  decode(bytes: string): string;
}

function utf16be(bytes: string): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2)
    out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
  return out;
}

/** A ToUnicode CMap: code lengths from the codespace ranges, bfchar and bfrange entries. */
function parseToUnicode(text: string): { lengths: number[]; map: Map<string, string> } {
  const map = new Map<string, string>();
  const lengths = new Set<number>();
  const hex = (h: string) => {
    let s = '';
    const clean = h.replace(/\s+/g, '');
    for (let i = 0; i + 1 < clean.length; i += 2)
      s += String.fromCharCode(Number.parseInt(clean.slice(i, i + 2), 16));
    return s;
  };
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g))
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f\s]+)>\s*<[0-9A-Fa-f\s]+>/g))
      lengths.add(m[1]!.replace(/\s+/g, '').length / 2);
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]*)>/g))
      map.set(hex(m[1]!), utf16be(hex(m[2]!)));
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(
      /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*(<[0-9A-Fa-f\s]*>|\[[^\]]*\])/g,
    )) {
      const lo = Number.parseInt(m[1]!.replace(/\s+/g, ''), 16);
      const hi = Number.parseInt(m[2]!.replace(/\s+/g, ''), 16);
      const width = m[1]!.replace(/\s+/g, '').length;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65_535) continue;
      const dst = m[3]!;
      const list = dst.startsWith('[')
        ? [...dst.matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((x) => x[1]!)
        : null;
      for (let c = lo; c <= hi; c++) {
        const code = hex(c.toString(16).padStart(width, '0'));
        if (list) {
          const d = list[c - lo];
          if (d !== undefined) map.set(code, utf16be(hex(d)));
        } else {
          const base = utf16be(hex(dst.slice(1, -1)));
          // The last UTF-16 unit counts up through the range.
          const last = base.charCodeAt(base.length - 1) + (c - lo);
          map.set(code, base.slice(0, -1) + String.fromCharCode(last));
        }
      }
    }
  }
  return { lengths: [...lengths].sort((a, b) => a - b), map };
}

function fontDecoder(pdf: PdfFile, fontDict: PdfDict | null): FontDecoder {
  const unknown = '�';
  if (!fontDict)
    return { decode: (s) => [...s].map((c) => decodeWinAnsi(c.charCodeAt(0))).join('') };
  const subtype = nameOf(pdf.resolve(fontDict.get('Subtype')));
  const toUni = pdf.object(fontDict.get('ToUnicode'));
  const encodingValue = pdf.resolve(fontDict.get('Encoding'));
  if (toUni) {
    const data = pdf.decode(toUni);
    if (data) {
      const cmap = parseToUnicode(Buffer.from(data).toString('latin1'));
      const lengths = cmap.lengths.length ? cmap.lengths : [subtype === 'Type0' ? 2 : 1];
      return {
        decode: (s) => {
          let out = '';
          let i = 0;
          while (i < s.length) {
            let hit: string | undefined;
            let used = lengths[0] ?? 1;
            for (const len of lengths) {
              const v = cmap.map.get(s.slice(i, i + len));
              if (v !== undefined) {
                hit = v;
                used = len;
                break;
              }
            }
            if (hit === undefined && subtype !== 'Type0' && used === 1)
              hit = decodeWinAnsi(s.charCodeAt(i));
            out += hit ?? unknown;
            i += used;
          }
          return out;
        },
      };
    }
  }
  if (subtype === 'Type0') {
    const enc = nameOf(encodingValue) ?? '';
    if (/UCS2|UTF16/i.test(enc)) return { decode: utf16be };
    // Two-byte glyph ids with no map to characters cannot be read.
    return { decode: (s) => unknown.repeat(Math.ceil(s.length / 2)) };
  }
  const differences = new Map<number, string>();
  const encDict = isDict(encodingValue) ? encodingValue.v : null;
  const diffs = encDict ? pdf.resolve(encDict.get('Differences')) : undefined;
  if (Array.isArray(diffs)) {
    let code = 0;
    for (const d of diffs) {
      if (typeof d === 'number') code = d;
      else {
        const name = nameOf(d);
        if (name !== null) {
          const t = glyphText(name);
          if (t !== null) differences.set(code, t);
          code++;
        }
      }
    }
  }
  const base =
    nameOf(encodingValue) ?? (encDict ? nameOf(pdf.resolve(encDict.get('BaseEncoding'))) : null);
  return {
    decode: (s) =>
      [...s]
        .map((c) => {
          const b = c.charCodeAt(0);
          const d = differences.get(b);
          if (d !== undefined) return d;
          if (base === 'StandardEncoding' || base === null) {
            if (b === 0x27) return '’';
            if (b === 0x60) return '‘';
          }
          return decodeWinAnsi(b);
        })
        .join(''),
  };
}

// ---- text ------------------------------------------------------------------------------------------

function pageText(pdf: PdfFile, content: string, fonts: PdfDict | null): string {
  const decoders = new Map<string, FontDecoder>();
  const decoderFor = (name: string): FontDecoder => {
    let d = decoders.get(name);
    if (!d) {
      d = fontDecoder(pdf, fonts ? pdf.dict(fonts.get(name)) : null);
      decoders.set(name, d);
    }
    return d;
  };
  let font: FontDecoder = decoderFor('');
  let out = '';
  let y: number | null = null;
  const newline = () => {
    if (out && !out.endsWith('\n')) out += '\n';
  };
  const space = () => {
    if (out && !/\s$/.test(out)) out += ' ';
  };
  const show = (s: string) => {
    out += font.decode(s);
  };
  const stack: PdfValue[] = [];
  let i = 0;
  for (;;) {
    const tok = parseValue(content, i);
    if (!tok) break;
    i = tok.end;
    const v = tok.v;
    if (!(typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === 'op')) {
      stack.push(v);
      if (stack.length > 64) stack.shift();
      continue;
    }
    const args = stack.splice(0);
    const strArg = (k: number) => {
      const a = args.at(k);
      return typeof a === 'object' && a !== null && !Array.isArray(a) && a.t === 'str' ? a.v : null;
    };
    switch (v.v) {
      case 'Tf': {
        const name = nameOf(args.at(-2));
        if (name !== null) font = decoderFor(name);
        break;
      }
      case 'Tj': {
        const s = strArg(-1);
        if (s !== null) show(s);
        break;
      }
      case "'":
      case '"': {
        newline();
        const s = strArg(-1);
        if (s !== null) show(s);
        break;
      }
      case 'TJ': {
        const arr = args.at(-1);
        if (Array.isArray(arr))
          for (const part of arr) {
            if (typeof part === 'number') {
              if (part < -250) space();
            } else if (
              typeof part === 'object' &&
              part !== null &&
              !Array.isArray(part) &&
              part.t === 'str'
            )
              show(part.v);
          }
        break;
      }
      case 'Td':
      case 'TD': {
        const ty = args.at(-1);
        if (typeof ty === 'number' && Math.abs(ty) > 0.01) {
          newline();
          y = (y ?? 0) + ty;
        } else space();
        break;
      }
      case 'Tm': {
        const f = args.at(-1);
        if (typeof f === 'number') {
          if (y !== null && Math.abs(f - y) > 1) newline();
          else space();
          y = f;
        }
        break;
      }
      case 'T*':
        newline();
        break;
      case 'ID': {
        // Inline image data: skip to the `EI` that ends it.
        const m = /\sEI(?=[\s/[<(]|$)/.exec(content.slice(i));
        i = m ? i + m.index + 3 : content.length;
        break;
      }
      default:
        break;
    }
  }
  return out
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Pages in order, each with its inherited resources. */
function pageList(pdf: PdfFile): { page: PdfDict; resources: PdfDict | null }[] {
  const out: { page: PdfDict; resources: PdfDict | null }[] = [];
  const seen = new Set<PdfDict>();
  const walk = (node: PdfDict | null, inherited: PdfDict | null, depth: number) => {
    if (!node || seen.has(node) || depth > 64 || out.length >= 10_000) return;
    seen.add(node);
    const resources = pdf.dict(node.get('Resources')) ?? inherited;
    const type = nameOf(pdf.resolve(node.get('Type')));
    const kids = pdf.resolve(node.get('Kids'));
    if (type === 'Pages' || Array.isArray(kids)) {
      if (Array.isArray(kids)) for (const k of kids) walk(pdf.dict(k), resources, depth + 1);
    } else out.push({ page: node, resources });
  };
  const root = pdf.trailer ? pdf.dict(pdf.trailer.get('Root')) : null;
  let catalog = root;
  if (!catalog)
    for (const o of pdf.objects.values())
      if (isDict(o.value) && nameOf(o.value.v.get('Type')) === 'Catalog') catalog = o.value.v;
  walk(catalog ? pdf.dict(catalog.get('Pages')) : null, null, 0);
  if (!out.length) {
    // No usable page tree: take page objects in file order.
    const ids = [...pdf.objects.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const v = pdf.objects.get(id)!.value;
      if (isDict(v) && nameOf(v.v.get('Type')) === 'Page')
        out.push({ page: v.v, resources: pdf.dict(v.v.get('Resources')) });
    }
  }
  return out;
}

function infoTitle(pdf: PdfFile): string | null {
  const info = pdf.trailer ? pdf.dict(pdf.trailer.get('Info')) : null;
  const t = info ? pdf.resolve(info.get('Title')) : undefined;
  if (!(typeof t === 'object' && t !== null && !Array.isArray(t) && t.t === 'str')) return null;
  const s = t.v.startsWith('þÿ')
    ? utf16be(t.v.slice(2))
    : [...t.v].map((c) => decodeWinAnsi(c.charCodeAt(0))).join('');
  return s.trim() || null;
}

export const NO_TEXT_NOTE =
  'This PDF has no text Nova can read. It may be a scan or a picture of text, or its fonts do not say which characters they draw.';

/** Extract the text of each page. Throws `validation` when the file is not a PDF. */
export function readPdf(bytes: Uint8Array): ExtractedDocument {
  if (Buffer.from(bytes.subarray(0, 1024)).toString('latin1').indexOf('%PDF-') < 0)
    throw new NovaError('validation', 'the file is not a PDF');
  const pdf = new PdfFile(bytes);
  const title = infoTitle(pdf);
  if (pdf.trailer?.has('Encrypt'))
    return {
      format: 'pdf',
      title,
      pages: [],
      readable: false,
      note: 'This PDF is encrypted, so Nova cannot read its text.',
      truncated: false,
    };
  const pages: ExtractedPage[] = [];
  let unknown = 0;
  let total = 0;
  for (const [i, p] of pageList(pdf).entries()) {
    const contents = pdf.resolve(p.page.get('Contents'));
    const refs = Array.isArray(contents) ? contents : [p.page.get('Contents')];
    const parts: string[] = [];
    for (const r of refs) {
      const o = pdf.object(r);
      const data = o ? pdf.decode(o) : null;
      if (data) parts.push(Buffer.from(data).toString('latin1'));
    }
    const fonts = p.resources ? pdf.dict(p.resources.get('Font')) : null;
    const text = pageText(pdf, parts.join('\n'), fonts);
    for (const ch of text) {
      if (/\s/.test(ch)) continue;
      total++;
      if (ch === '�') unknown++;
    }
    pages.push({ index: i + 1, text: text.replace(/�+/g, '�') });
  }
  let readable = true;
  let note: string | null = null;
  if (total === 0 || unknown / total > 0.3) {
    readable = false;
    note = NO_TEXT_NOTE;
  } else if (pdf.unsupported) {
    note =
      'Some of this PDF uses a compression Nova cannot read, so part of its text may be missing.';
  } else if (unknown) {
    note = 'Some characters in this PDF could not be read and are shown as �.';
  }
  return { format: 'pdf', title, pages, readable, note, truncated: false };
}
