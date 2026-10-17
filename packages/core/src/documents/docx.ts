// DOCX (FR-219): a minimal WordprocessingML package written from structured blocks (headings,
// paragraphs with bold and italic runs, bullet and numbered lists, tables), and a reader that
// returns the same kinds of blocks from any DOCX. The package holds only the main document,
// styles, numbering and the two property parts: no macros, fields or external references.
import { NovaError } from '@nova/shared';
import {
  inlineRuns,
  type DocBlock,
  type DocxContent,
  type InlineText,
  type PageSize,
} from './content.ts';
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
import type { ExtractedBlock, ExtractedDocument } from './types.ts';
import {
  XML_DECL,
  attr,
  childElements,
  esc,
  firstChild,
  localName,
  parseXml,
  type XmlElement,
} from './xml.ts';
import { entryText, readZip, writeZip } from './zip.ts';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Page size and margins in twentieths of a point. */
const PAGE: Record<PageSize, { w: number; h: number }> = {
  a4: { w: 11906, h: 16838 },
  letter: { w: 12240, h: 15840 },
};
const MARGIN = 1440;

export interface DocumentMeta {
  title: string;
  created: Date;
}

function runXml(text: string, bold?: boolean, italic?: boolean): string {
  const props = `${bold ? '<w:b/><w:bCs/>' : ''}${italic ? '<w:i/><w:iCs/>' : ''}`;
  const rPr = props ? `<w:rPr>${props}</w:rPr>` : '';
  // Line breaks and tabs are elements, not characters, in WordprocessingML.
  const parts = text.split(/(\n|\t)/);
  let body = '';
  for (const p of parts) {
    if (p === '\n') body += '<w:br/>';
    else if (p === '\t') body += '<w:tab/>';
    else if (p) body += `<w:t xml:space="preserve">${esc(p)}</w:t>`;
  }
  return `<w:r>${rPr}${body}</w:r>`;
}

function inlineXml(t: InlineText): string {
  return inlineRuns(t)
    .map((r) => runXml(r.text.replace(/\r\n?/g, '\n'), r.bold, r.italic))
    .join('');
}

function paragraph(pPr: string, content: string): string {
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;
}

function tableXml(b: Extract<DocBlock, { type: 'table' }>, textWidth: number): string {
  const rows = b.header ? [b.header, ...b.rows] : b.rows;
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const colW = Math.floor(textWidth / cols);
  const grid = `<w:tblGrid>${`<w:gridCol w:w="${colW}"/>`.repeat(cols)}</w:tblGrid>`;
  const rowXml = (cells: string[], header: boolean) => {
    const padded = [...cells, ...Array<string>(cols - cells.length).fill('')];
    const trPr = header ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
    return `<w:tr>${trPr}${padded
      .map(
        (c) =>
          `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/></w:tcPr>${paragraph(
            '<w:spacing w:after="0"/>',
            c ? runXml(c, header) : '',
          )}</w:tc>`,
      )
      .join('')}</w:tr>`;
  };
  const body = rows.map((r, i) => rowXml(r, i === 0 && !!b.header)).join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr>${grid}${body}</w:tbl>`;
}

function documentXml(content: DocxContent): { xml: string; numbered: number } {
  const page = PAGE[content.pageSize];
  const textWidth = page.w - 2 * MARGIN;
  let numbered = 0;
  const out: string[] = [];
  content.blocks.forEach((b, i) => {
    switch (b.type) {
      case 'heading':
        out.push(paragraph(`<w:pStyle w:val="Heading${b.level}"/>`, runXml(b.text)));
        break;
      case 'paragraph':
        out.push(paragraph('', inlineXml(b.text)));
        break;
      case 'bullets':
      case 'numbered': {
        // Each numbered list restarts at 1: it gets its own numbering instance.
        const numId = b.type === 'bullets' ? 1 : 2 + numbered++;
        for (const item of b.items)
          out.push(
            paragraph(
              `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`,
              inlineXml(item),
            ),
          );
        break;
      }
      case 'table':
        out.push(tableXml(b, textWidth));
        // A document body ends with a paragraph, not a table.
        if (i === content.blocks.length - 1) out.push('<w:p/>');
        break;
    }
  });
  const sect = `<w:sectPr><w:pgSz w:w="${page.w}" w:h="${page.h}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  return {
    xml: `${XML_DECL}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${out.join('')}${sect}</w:body></w:document>`,
    numbered,
  };
}

const BORDER = (side: string) =>
  `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;

function stylesXml(): string {
  const heading = (n: number, size: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return (
    `${XML_DECL}<w:styles xmlns:w="${W}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    heading(1, 32) +
    heading(2, 28) +
    heading(3, 24) +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(BORDER).join('')}</w:tblBorders></w:tblPr></w:style>` +
    '</w:styles>'
  );
}

function numberingXml(numbered: number): string {
  const lvl = (fmt: string, text: string) =>
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>`;
  let nums = '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
  for (let k = 0; k < numbered; k++)
    nums += `<w:num w:numId="${2 + k}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`;
  return (
    `${XML_DECL}<w:numbering xmlns:w="${W}">` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>${lvl('bullet', '•')}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>${lvl('decimal', '%1.')}</w:abstractNum>` +
    `${nums}</w:numbering>`
  );
}

/** Write a DOCX file. `content` must already be validated (parseDocumentContent). */
export function writeDocx(content: DocxContent, meta: DocumentMeta): Uint8Array {
  const doc = documentXml(content);
  return writeZip(
    [
      [
        '[Content_Types].xml',
        contentTypes([
          ['word/document.xml', CT.docxMain],
          ['word/styles.xml', CT.docxStyles],
          ['word/numbering.xml', CT.docxNumbering],
          ['docProps/core.xml', CT.core],
          ['docProps/app.xml', CT.app],
        ]),
      ],
      ['_rels/.rels', rootRels('word/document.xml')],
      [
        'word/_rels/document.xml.rels',
        relationships([
          { id: 'rId1', type: REL.styles, target: 'styles.xml' },
          { id: 'rId2', type: REL.numbering, target: 'numbering.xml' },
        ]),
      ],
      ['word/document.xml', doc.xml],
      ['word/styles.xml', stylesXml()],
      ['word/numbering.xml', numberingXml(doc.numbered)],
      ['docProps/core.xml', coreProps(meta.title, meta.created)],
      ['docProps/app.xml', appProps()],
    ],
    meta.created,
  );
}

// ---- reading -----------------------------------------------------------------------------------

/** Text of a paragraph: runs, tabs and breaks; deleted text and field codes are skipped. */
function paragraphText(p: XmlElement): string {
  let out = '';
  const walk = (el: XmlElement) => {
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      const n = localName(c.name);
      if (n === 't') out += c.children.filter((x) => typeof x === 'string').join('');
      else if (n === 'tab') out += '\t';
      else if (n === 'br' || n === 'cr') out += '\n';
      else if (n === 'del' || n === 'instrText' || n === 'pPr' || n === 'rPr') continue;
      else walk(c);
    }
  };
  walk(p);
  return out;
}

interface Numbering {
  /** numId → whether level 0 (or the level used) is a bullet. */
  bullet: (numId: string, ilvl: string) => boolean;
}

function readNumbering(text: string | null): Numbering {
  if (!text) return { bullet: () => true };
  const root = parseXml(text, 'numbering');
  const abstract = new Map<string, Map<string, string>>();
  for (const a of childElements(root, 'abstractNum')) {
    const levels = new Map<string, string>();
    for (const l of childElements(a, 'lvl')) {
      const fmt = firstChild(l, 'numFmt');
      levels.set(attr(l, 'ilvl') ?? '0', (fmt && attr(fmt, 'val')) ?? 'decimal');
    }
    abstract.set(attr(a, 'abstractNumId') ?? '', levels);
  }
  const nums = new Map<string, string>();
  for (const n of childElements(root, 'num')) {
    const a = firstChild(n, 'abstractNumId');
    nums.set(attr(n, 'numId') ?? '', (a && attr(a, 'val')) ?? '');
  }
  return {
    bullet: (numId, ilvl) => {
      const fmt = abstract.get(nums.get(numId) ?? '')?.get(ilvl);
      return fmt === undefined || fmt === 'bullet' || fmt === 'none';
    },
  };
}

function headingLevel(pPr: XmlElement | null): number | null {
  if (!pPr) return null;
  const style = firstChild(pPr, 'pStyle');
  const v = style ? (attr(style, 'val') ?? '') : '';
  const m = /^heading\s*(\d)$/i.exec(v);
  if (m) return Math.min(6, Number(m[1]));
  if (/^title$/i.test(v)) return 1;
  const outline = firstChild(pPr, 'outlineLvl');
  const lvl = outline ? Number(attr(outline, 'val')) : NaN;
  return Number.isInteger(lvl) && lvl >= 0 && lvl < 6 ? lvl + 1 : null;
}

function tableRows(tbl: XmlElement): string[][] {
  return childElements(tbl, 'tr').map((tr) =>
    childElements(tr, 'tc').map((tc) =>
      childElements(tc, 'p').map(paragraphText).join(' ').replace(/\s+/g, ' ').trim(),
    ),
  );
}

/** Read the text and tables of a DOCX file, in order. Throws `validation` for a damaged file. */
export function readDocx(bytes: Uint8Array): ExtractedDocument {
  const files = readZip(bytes, (n) => n.endsWith('.xml') || n.endsWith('.rels'));
  const main = mainPartOf(entryText(files, '_rels/.rels')) ?? 'word/document.xml';
  const docText = entryText(files, main);
  if (!docText) throw new NovaError('validation', 'the file is not a DOCX document');
  const rels = readRels(entryText(files, relsPathOf(main)), main);
  let numberingPart: string | null = null;
  for (const r of rels.values()) if (r.type.endsWith('/numbering')) numberingPart = r.target;
  const numbering = readNumbering(numberingPart ? entryText(files, numberingPart) : null);
  const root = parseXml(docText, 'document');
  const body = firstChild(root, 'body');
  const blocks: ExtractedBlock[] = [];
  const visit = (container: XmlElement) => {
    for (const el of childElements(container)) {
      const n = localName(el.name);
      if (n === 'sdt') {
        const c = firstChild(el, 'sdtContent');
        if (c) visit(c);
      } else if (n === 'tbl') {
        blocks.push({ type: 'table', rows: tableRows(el) });
      } else if (n === 'p') {
        const pPr = firstChild(el, 'pPr');
        const text = paragraphText(el);
        const level = headingLevel(pPr);
        const numPr = pPr ? firstChild(pPr, 'numPr') : null;
        if (level !== null && text.trim()) {
          blocks.push({ type: 'heading', level, text: text.trim() });
        } else if (numPr) {
          const numId = attr(firstChild(numPr, 'numId') ?? numPr, 'val') ?? '';
          const ilvl = attr(firstChild(numPr, 'ilvl') ?? numPr, 'val') ?? '0';
          const ordered = !numbering.bullet(numId, ilvl);
          const last = blocks.at(-1);
          if (last?.type === 'list' && last.ordered === ordered) last.items.push(text);
          else blocks.push({ type: 'list', ordered, items: [text] });
        } else if (text.trim()) {
          blocks.push({ type: 'paragraph', text });
        }
      }
    }
  };
  if (body) visit(body);
  return {
    format: 'docx',
    title: readTitle(entryText(files, 'docProps/core.xml')),
    blocks,
    readable: true,
    note: blocks.length ? null : 'The document has no text.',
    truncated: false,
  };
}
