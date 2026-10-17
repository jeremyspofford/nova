// XLSX (FR-219): a minimal SpreadsheetML package with typed cells (text, numbers, booleans,
// dates), a bold frozen header row and column widths, and a reader that returns each sheet's
// cells as text rows (dates as ISO text) for TSV output and table previews.
import { NovaError } from '@nova/shared';
import { parseDateText, type SheetCell, type XlsxContent } from './content.ts';
import {
  CT,
  REL,
  appProps,
  contentTypes,
  coreProps,
  mainPartOf,
  readRels,
  readTitle,
  relationships,
  relsPathOf,
  rootRels,
} from './ooxml.ts';
import type { DocumentMeta } from './docx.ts';
import type { ExtractedDocument, ExtractedSheet } from './types.ts';
import {
  XML_DECL,
  attr,
  childElements,
  descendants,
  esc,
  firstChild,
  localName,
  parseXml,
  textContent,
  type XmlElement,
} from './xml.ts';
import { entryText, readZip, writeZip } from './zip.ts';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Style indexes in styles.xml (cellXfs). */
const STYLE = { normal: 0, header: 1, date: 2, dateTime: 3 } as const;
const DAY_MS = 86_400_000;
/** Serial dates count days from 1899-12-30 (the 1900 leap-year quirk is before any date we write). */
const EPOCH = Date.UTC(1899, 11, 30);

/** `0` → `A`, `27` → `AB`. */
export function columnName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** `AB` → `27`; -1 when it is not a column name. */
export function columnIndex(name: string): number {
  if (!/^[A-Z]{1,3}$/.test(name)) return -1;
  let n = 0;
  for (const ch of name) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function stylesXml(): string {
  const font = (bold: boolean) =>
    `<font>${bold ? '<b/>' : ''}<sz val="11"/><name val="Arial"/><family val="2"/></font>`;
  return (
    `${XML_DECL}<styleSheet xmlns="${MAIN}">` +
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>' +
    `<fonts count="2">${font(false)}${font(true)}</fonts>` +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

class SharedStrings {
  readonly #index = new Map<string, number>();
  readonly #list: string[] = [];
  count = 0;
  id(s: string): number {
    this.count++;
    let i = this.#index.get(s);
    if (i === undefined) {
      i = this.#list.length;
      this.#list.push(s);
      this.#index.set(s, i);
    }
    return i;
  }
  xml(): string {
    return `${XML_DECL}<sst xmlns="${MAIN}" count="${this.count}" uniqueCount="${this.#list.length}">${this.#list
      .map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
      .join('')}</sst>`;
  }
}

function cellXml(ref: string, v: SheetCell, sst: SharedStrings, header: boolean): string {
  if (v === null) return '';
  if (typeof v === 'string') {
    if (v === '') return '';
    return `<c r="${ref}" t="s"${header ? ` s="${STYLE.header}"` : ''}><v>${sst.id(v)}</v></c>`;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    return `<c r="${ref}"><v>${v}</v></c>`;
  }
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  const d = parseDateText(v.date);
  if (!d) return '';
  const serial = (Date.UTC(d.y, d.m - 1, d.d, d.hh, d.mm, d.ss) - EPOCH) / DAY_MS;
  return `<c r="${ref}" s="${d.hasTime ? STYLE.dateTime : STYLE.date}"><v>${serial}</v></c>`;
}

function displayLength(v: SheetCell): number {
  if (v === null) return 0;
  if (typeof v === 'object') return parseDateText(v.date)?.hasTime ? 19 : 10;
  return Math.min(80, String(v).length);
}

function sheetXml(s: XlsxContent['sheets'][number], first: boolean, sst: SharedStrings): string {
  const header = s.columns?.length ? s.columns.map((c) => c.header) : null;
  const rows: SheetCell[][] = header ? [header, ...s.rows] : s.rows;
  const cols = Math.max(1, s.columns?.length ?? 0, ...rows.map((r) => r.length));
  // Widths in characters: as given, else fitted to the first 200 rows.
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    const given = s.columns?.[c]?.width;
    if (given !== undefined) widths.push(given);
    else {
      let w = 0;
      for (const r of rows.slice(0, 200)) w = Math.max(w, displayLength(r[c] ?? null));
      widths.push(Math.min(60, Math.max(8, w + 2)));
    }
  }
  const lastRef = `${columnName(cols - 1)}${Math.max(1, rows.length)}`;
  const pane = header
    ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
    : '';
  const data = rows
    .map((r, i) => {
      const cells = r
        .map((v, c) => cellXml(`${columnName(c)}${i + 1}`, v, sst, header !== null && i === 0))
        .join('');
      return `<row r="${i + 1}">${cells}</row>`;
    })
    .join('');
  return (
    `${XML_DECL}<worksheet xmlns="${MAIN}" xmlns:r="${RNS}">` +
    `<dimension ref="A1:${lastRef}"/>` +
    `<sheetViews><sheetView${first ? ' tabSelected="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${data}</sheetData></worksheet>`
  );
}

/** Write an XLSX file. `content` must already be validated (parseDocumentContent). */
export function writeXlsx(content: XlsxContent, meta: DocumentMeta): Uint8Array {
  const sst = new SharedStrings();
  const sheets = content.sheets.map((s, i) => sheetXml(s, i === 0, sst));
  const n = sheets.length;
  const workbook =
    `${XML_DECL}<workbook xmlns="${MAIN}" xmlns:r="${RNS}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>` +
    content.sheets
      .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('') +
    '</sheets></workbook>';
  return writeZip(
    [
      [
        '[Content_Types].xml',
        contentTypes([
          ['xl/workbook.xml', CT.xlsxMain],
          ...sheets.map((_, i): [string, string] => [
            `xl/worksheets/sheet${i + 1}.xml`,
            CT.xlsxSheet,
          ]),
          ['xl/styles.xml', CT.xlsxStyles],
          ['xl/sharedStrings.xml', CT.xlsxStrings],
          ['docProps/core.xml', CT.core],
          ['docProps/app.xml', CT.app],
        ]),
      ],
      ['_rels/.rels', rootRels('xl/workbook.xml')],
      ['xl/workbook.xml', workbook],
      [
        'xl/_rels/workbook.xml.rels',
        relationships([
          ...sheets.map((_, i) => ({
            id: `rId${i + 1}`,
            type: REL.worksheet,
            target: `worksheets/sheet${i + 1}.xml`,
          })),
          { id: `rId${n + 1}`, type: REL.styles, target: 'styles.xml' },
          { id: `rId${n + 2}`, type: REL.sharedStrings, target: 'sharedStrings.xml' },
        ]),
      ],
      ...sheets.map((x, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, x]),
      ['xl/styles.xml', stylesXml()],
      ['xl/sharedStrings.xml', sst.xml()],
      ['docProps/core.xml', coreProps(meta.title, meta.created)],
      ['docProps/app.xml', appProps()],
    ],
    meta.created,
  );
}

// ---- reading -----------------------------------------------------------------------------------

export interface XlsxReadLimits {
  maxRows: number;
  maxCols: number;
}

const READ_LIMITS: XlsxReadLimits = { maxRows: 100_000, maxCols: 1000 };

/** Built-in number formats that show dates or times. */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function isDateFormat(code: string): boolean {
  // Strip quoted text, escapes and colors before looking for date and time tokens.
  const bare = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(bare) && !/^[#0.,%E+\- ]*$/i.test(bare);
}

function dateStyles(stylesText: string | null): Set<number> {
  const out = new Set<number>();
  if (!stylesText) return out;
  const root = parseXml(stylesText, 'styles');
  const custom = new Map<number, string>();
  const fmts = firstChild(root, 'numFmts');
  for (const f of fmts ? childElements(fmts, 'numFmt') : [])
    custom.set(Number(attr(f, 'numFmtId')), attr(f, 'formatCode') ?? '');
  const xfs = firstChild(root, 'cellXfs');
  if (!xfs) return out;
  childElements(xfs, 'xf').forEach((xf, i) => {
    const id = Number(attr(xf, 'numFmtId') ?? 0);
    const code = custom.get(id);
    if (DATE_FORMAT_IDS.has(id) || (code !== undefined && isDateFormat(code))) out.add(i);
  });
  return out;
}

function serialToIso(serial: number): string {
  const ms = Math.round(EPOCH + serial * DAY_MS);
  const iso = new Date(ms).toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19);
}

function sharedStrings(text: string | null): string[] {
  if (!text) return [];
  // A string item is its own <t> or the <t> of each rich-text run; phonetic runs are skipped.
  return childElements(parseXml(text, 'shared strings'), 'si').map((si) =>
    childElements(si)
      .map((c) => {
        const n = localName(c.name);
        if (n === 't') return textContent(c);
        if (n === 'r') return descendants(c, 't').map(textContent).join('');
        return '';
      })
      .join(''),
  );
}

function cellValue(c: XmlElement, strings: string[], dates: Set<number>): string {
  const t = attr(c, 't') ?? 'n';
  const v = firstChild(c, 'v');
  const raw = v ? textContent(v) : '';
  switch (t) {
    case 's':
      return strings[Number(raw)] ?? '';
    case 'inlineStr': {
      const is = firstChild(c, 'is');
      return is ? descendants(is, 't').map(textContent).join('') : '';
    }
    case 'b':
      return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
    case 'str':
    case 'e':
      return raw;
    default: {
      const num = Number(raw);
      if (raw !== '' && Number.isFinite(num) && dates.has(Number(attr(c, 's') ?? 0)))
        return serialToIso(num);
      return raw;
    }
  }
}

function readSheet(
  xml: string,
  name: string,
  strings: string[],
  dates: Set<number>,
  limits: XlsxReadLimits,
): ExtractedSheet {
  const root = parseXml(xml, `sheet ${name}`);
  const data = firstChild(root, 'sheetData');
  const rows: string[][] = [];
  let truncated = false;
  let nextRow = 0;
  for (const row of data ? childElements(data, 'row') : []) {
    const r = Number(attr(row, 'r') ?? nextRow + 1) - 1;
    nextRow = r + 1;
    if (r >= limits.maxRows || r < 0) {
      truncated = true;
      break;
    }
    const cells: string[] = [];
    let nextCol = 0;
    for (const c of childElements(row, 'c')) {
      const ref = attr(c, 'r');
      const col = ref ? columnIndex(/^[A-Z]+/.exec(ref)?.[0] ?? '') : nextCol;
      nextCol = (col < 0 ? nextCol : col) + 1;
      if (col < 0) continue;
      if (col >= limits.maxCols) {
        truncated = true;
        continue;
      }
      const value = cellValue(c, strings, dates);
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    while (rows.length < r) rows.push([]);
    rows[r] = cells;
  }
  // Trailing empty cells and rows carry nothing.
  for (const r of rows) while (r.length && r.at(-1) === '') r.pop();
  while (rows.length && rows.at(-1)!.length === 0) rows.pop();
  return { name, rows, truncated };
}

/** Read every sheet's cells as text. Throws `validation` for a damaged file. */
export function readXlsx(
  bytes: Uint8Array,
  limits: XlsxReadLimits = READ_LIMITS,
): ExtractedDocument {
  const files = readZip(bytes, (n) => n.endsWith('.xml') || n.endsWith('.rels'));
  const main = mainPartOf(entryText(files, '_rels/.rels')) ?? 'xl/workbook.xml';
  const wbText = entryText(files, main);
  if (!wbText) throw new NovaError('validation', 'the file is not an XLSX workbook');
  const rels = readRels(entryText(files, relsPathOf(main)), main);
  let strings: string[] = [];
  let dates = new Set<number>();
  for (const r of rels.values()) {
    if (r.type.endsWith('/sharedStrings')) strings = sharedStrings(entryText(files, r.target));
    if (r.type.endsWith('/styles')) dates = dateStyles(entryText(files, r.target));
  }
  const wb = parseXml(wbText, 'workbook');
  const list = firstChild(wb, 'sheets');
  const sheets: ExtractedSheet[] = [];
  for (const s of list ? childElements(list, 'sheet') : []) {
    const rid = Object.entries(s.attrs).find(([k]) => k !== 'id' && localName(k) === 'id')?.[1];
    const target = rid ? rels.get(rid)?.target : undefined;
    const xml = target ? entryText(files, target) : null;
    if (!xml) continue;
    sheets.push(
      readSheet(xml, attr(s, 'name') ?? `Sheet${sheets.length + 1}`, strings, dates, limits),
    );
  }
  return {
    format: 'xlsx',
    title: readTitle(entryText(files, 'docProps/core.xml')),
    sheets,
    readable: true,
    note: sheets.length ? null : 'The workbook has no worksheets.',
    truncated: sheets.some((s) => s.truncated),
  };
}
