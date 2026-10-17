// Document readers (FR-219) on files Nova did not write: PDFs with TJ arrays, ToUnicode maps,
// object streams, inline images, encryption and scans; Office files laid out differently from
// Nova's own; plus the zip and XML limits that keep a crafted file from exhausting the Hub, and
// the text and preview shapes built from what was read.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  NO_TEXT_NOTE,
  detectFormat,
  documentText,
  extractDocument,
  readDocx,
  readPdf,
  readPptx,
  readXlsx,
  trimForPreview,
  type ExtractedDocument,
} from '../src/documents/index.ts';
import { decodeEntities, parseXml, textContent, xmlSafe } from '../src/documents/xml.ts';
import { inflateBounded, readZip } from '../src/documents/zip.ts';

// ---- a tiny PDF assembler --------------------------------------------------------------------

type Obj = string | { dict: string; stream: Uint8Array | string };

function pdf(objects: Obj[], trailer = '/Root 1 0 R'): Uint8Array {
  const parts: Uint8Array[] = [];
  let at = 0;
  const push = (d: string | Uint8Array) => {
    const b = typeof d === 'string' ? Buffer.from(d, 'latin1') : d;
    parts.push(b);
    at += b.length;
  };
  const offsets: number[] = [];
  push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  objects.forEach((o, i) => {
    offsets.push(at);
    if (typeof o === 'string') push(`${i + 1} 0 obj\n${o}\nendobj\n`);
    else {
      const data = typeof o.stream === 'string' ? Buffer.from(o.stream, 'latin1') : o.stream;
      push(`${i + 1} 0 obj\n<< ${o.dict} /Length ${data.length} >>\nstream\n`);
      push(data);
      push('\nendstream\nendobj\n');
    }
  });
  const xref = at;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) push(`${String(off).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const flate = (s: string) => zlibSync(Buffer.from(s, 'latin1'));

/** ASCII85 with the `<~ ~>` brackets. */
function a85(s: string): string {
  const b = Buffer.from(s, 'latin1');
  let out = '<~';
  for (let i = 0; i < b.length; i += 4) {
    const chunk = [...b.subarray(i, i + 4)];
    const n = chunk.length;
    while (chunk.length < 4) chunk.push(0);
    let v = ((chunk[0]! << 24) >>> 0) + (chunk[1]! << 16) + (chunk[2]! << 8) + chunk[3]!;
    if (v === 0 && n === 4) {
      out += 'z';
      continue;
    }
    const digits: number[] = [];
    for (let k = 0; k < 5; k++) {
      digits.unshift(v % 85);
      v = Math.floor(v / 85);
    }
    out += digits
      .slice(0, n + 1)
      .map((d) => String.fromCharCode(d + 33))
      .join('');
  }
  return `${out}~>`;
}

/** Catalog, pages, one page using font F1 (object 4) and content (object 5). */
function onePage(font: string, content: Obj, extra: Obj[] = []): Uint8Array {
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 4 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>',
    font,
    content,
    ...extra,
  ]);
}

describe('PDF reader (FR-219)', () => {
  it('reads Tj, TJ, quote operators and line moves with a Differences encoding', () => {
    const bytes = onePage(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [128 /bullet /uni2192 /fi] >> >>',
      {
        dict: '',
        stream:
          "BT /F1 12 Tf 72 700 Td (Hello) Tj [(W) 120 (orld) -400 (again)] TJ T* (Next \\(line\\)) Tj 0 -14 Td (Third) Tj (\\101\\102) ' ET\n" +
          'BT 1 0 0 1 72 600 Tm (\\200 item \\201 \\202nd) Tj ET % a comment\n' +
          'BT 1 0 0 1 72 580 Tm <48 69> Tj 1 0 0 1 120 580 Tm (there) Tj ET',
      },
    );
    const doc = readPdf(bytes);
    expect(doc).toMatchObject({ readable: true, note: null, title: null });
    expect(doc.pages).toEqual([
      {
        index: 1,
        text: 'HelloWorld again\nNext (line)\nThird\nAB\n• item → find\nHi there',
      },
    ]);
  });

  it('decodes two-byte fonts through ToUnicode maps (bfchar, bfrange, arrays)', () => {
    const cmap = [
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
      '1 begincodespacerange <0000> <FFFF> endcodespacerange',
      '2 beginbfchar <0003> <0048> <0004> <00690021> endbfchar',
      '2 beginbfrange <0010> <0012> <0061> <0020> <0021> [<263A> <D83DDE00>] endbfrange',
      'endcmap end end',
    ].join('\n');
    const bytes = onePage(
      '<< /Type /Font /Subtype /Type0 /BaseFont /Embedded /Encoding /Identity-H /ToUnicode 6 0 R >>',
      {
        dict: '/Filter /FlateDecode',
        stream: flate(
          'BT /F1 10 Tf 10 10 Td <00030004> Tj [<0010> -300 <00110012>] TJ T* <00200021> Tj <0099> Tj ET',
        ),
      },
      [{ dict: '/Filter /FlateDecode', stream: flate(cmap) }],
    );
    const doc = readPdf(bytes);
    expect(doc.pages![0]!.text).toBe('Hi!a bc\n☺😀�');
    expect(doc.readable).toBe(true);
    expect(doc.note).toMatch(/could not be read/);
  });

  it('says plainly when a two-byte font has no character map', () => {
    const bytes = onePage(
      '<< /Type /Font /Subtype /Type0 /BaseFont /Embedded /Encoding /Identity-H >>',
      { dict: '', stream: 'BT /F1 10 Tf <00030004000500060007> Tj ET' },
    );
    expect(readPdf(bytes)).toMatchObject({ readable: false, note: NO_TEXT_NOTE });
  });

  it('decodes UCS-2 CMaps directly', () => {
    const bytes = onePage(
      '<< /Type /Font /Subtype /Type0 /BaseFont /Song /Encoding /UniGB-UCS2-H >>',
      { dict: '', stream: 'BT /F1 10 Tf <4E2D6587> Tj ET' },
    );
    expect(readPdf(bytes).pages![0]!.text).toBe('中文');
  });

  it('reports a scan (no text) and an encrypted file without guessing', () => {
    const scan = onePage('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', {
      dict: '',
      stream: 'q 612 0 0 792 0 0 cm /Im1 Do Q',
    });
    expect(readPdf(scan)).toMatchObject({ readable: false, note: NO_TEXT_NOTE });
    const locked = pdf(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [] /Count 0 >>',
        '<< /Filter /Standard /V 2 >>',
      ],
      '/Root 1 0 R /Encrypt 3 0 R',
    );
    expect(readPdf(locked)).toMatchObject({
      readable: false,
      pages: [],
      note: 'This PDF is encrypted, so Nova cannot read its text.',
    });
  });

  it('skips inline images, reads ASCIIHex and ASCII85 streams, and notes unsupported filters', () => {
    const hex = Buffer.from('BT /F1 9 Tf 1 0 0 1 9 9 Tm (hex text) Tj ET', 'latin1').toString(
      'hex',
    );
    const bytes = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 7 0 R 8 0 R] /Count 3 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [5 0 R 6 0 R] >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      {
        dict: '',
        stream: 'BI /W 2 /H 1 /BPC 8 /CS /G ID \x00\xff) ( EI BT /F1 9 Tf (after image) Tj ET',
      },
      { dict: '/Filter /ASCIIHexDecode', stream: `${hex}>` },
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 9 0 R >>',
      '<< /Type /Page /Parent 2 0 R /Contents 10 0 R >>',
      { dict: '/Filter /ASCII85Decode', stream: a85('BT /F1 9 Tf (eighty-five) Tj ET') },
      { dict: '/Filter /LZWDecode', stream: 'garbage' },
    ]);
    const doc = readPdf(bytes);
    expect(doc.pages!.map((p) => p.text)).toEqual(['after image hex text', 'eighty-five', '']);
    expect(doc.note).toMatch(/compression Nova cannot read/);
    expect(doc.readable).toBe(true);
  });

  it('finds pages inside compressed object streams with a cross-reference stream trailer', () => {
    const pages = '<< /Type /Pages /Kids [4 0 R] /Count 1 >>';
    const page =
      '<< /Type /Page /Parent 3 0 R /Contents 6 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
    const header = `3 0 4 ${pages.length + 1} `;
    const objstm = flate(`${header}${pages} ${page}`);
    const bytes = Buffer.concat([
      Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n', 'latin1'),
      Buffer.from(
        `2 0 obj\n<< /Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode /Length ${objstm.length} >>\nstream\n`,
        'latin1',
      ),
      objstm,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
      Buffer.from(
        '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
        'latin1',
      ),
      // An indirect /Length: the reader finds `endstream` itself.
      Buffer.from(
        '6 0 obj\n<< /Length 7 0 R >>\nstream\nBT /F1 9 Tf (packed page) Tj ET\nendstream\nendobj\n',
        'latin1',
      ),
      Buffer.from('7 0 obj\n32\nendobj\n', 'latin1'),
      Buffer.from(
        '8 0 obj\n<< /Type /XRef /Root 1 0 R /Info 9 0 R /Size 10 /Length 0 >>\nstream\n\nendstream\nendobj\n',
        'latin1',
      ),
      Buffer.from('9 0 obj\n<< /Title <FEFF0050006C0061006E> >>\nendobj\n%%EOF\n', 'latin1'),
    ]);
    const doc = readPdf(bytes);
    expect(doc.title).toBe('Plan');
    expect(doc.pages).toEqual([{ index: 1, text: 'packed page' }]);
  });

  it('falls back to page objects in file order without a page tree, and refuses non-PDFs', () => {
    const bytes = pdf(
      [
        '<< /Type /Page /Contents 2 0 R /Resources << /Font << /F1 3 0 R >> >> >>',
        { dict: '', stream: 'BT /F1 9 Tf (loose page) Tj ET' },
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /StandardEncoding >>',
      ],
      '/Info << /Title (Old \\(1\\)) >>',
    );
    const doc = readPdf(bytes);
    expect(doc.pages).toEqual([{ index: 1, text: 'loose page' }]);
    expect(doc.title).toBe('Old (1)');
    expect(() => readPdf(new TextEncoder().encode('just text'))).toThrow(/not a PDF/);
  });

  // Compressing and inflating 40 MiB is CPU-bound: allow for a loaded runner (R-011).
  it('refuses a stream that inflates past the cap', () => {
    const big = zlibSync(new Uint8Array(40 * 1024 * 1024));
    const bytes = onePage('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', {
      dict: '/Filter /FlateDecode',
      stream: big,
    });
    expect(() => readPdf(bytes)).toThrow(/expands to too much data/);
  }, 30_000);
});

// ---- Office files laid out differently -----------------------------------------------------------

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const rel = (id: string, type: string, target: string, external = false) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`;

function pkg(files: Record<string, string>): Uint8Array {
  const z: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    ),
  };
  for (const [k, v] of Object.entries(files)) z[k] = strToU8(v);
  return zipSync(z);
}

describe('DOCX reader (FR-219)', () => {
  it('reads content controls, title style, outline levels, list kinds, tabs, breaks and tables', () => {
    const doc = `<?xml version="1.0"?><w:document ${W}><w:body>
      <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Big title</w:t></w:r></w:p>
      <w:sdt><w:sdtContent><w:p><w:r><w:t xml:space="preserve">In a control </w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:fldChar/><w:instrText>PAGE</w:instrText><w:t>kept</w:t></w:r></w:p></w:sdtContent></w:sdt>
      <w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>Outline two</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>step a</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>step b</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="6"/></w:numPr></w:pPr><w:r><w:t>dot</w:t></w:r></w:p>
      <w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>
      <w:p/>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p><w:p><w:r><w:t>y</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>
    </w:body></w:document>`;
    const numbering = `<w:numbering ${W}>
      <w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="11"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
      <w:num w:numId="5"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="6"><w:abstractNumId w:val="11"/></w:num>
    </w:numbering>`;
    const bytes = pkg({
      '_rels/.rels': `<Relationships ${REL_NS}>${rel('r1', 'officeDocument', 'word/main.xml')}</Relationships>`,
      'word/main.xml': doc,
      'word/_rels/main.xml.rels': `<Relationships ${REL_NS}>${rel('n', 'numbering', 'lists.xml')}${rel('h', 'hyperlink', 'https://example.com', true)}</Relationships>`,
      'word/lists.xml': numbering,
    });
    expect(detectFormat(bytes)).toBe('docx');
    const read = readDocx(bytes);
    expect(read.title).toBeNull();
    expect(read.blocks).toEqual([
      { type: 'heading', level: 1, text: 'Big title' },
      { type: 'paragraph', text: 'In a control kept' },
      { type: 'heading', level: 2, text: 'Outline two' },
      { type: 'list', ordered: true, items: ['step a', 'step b'] },
      { type: 'list', ordered: false, items: ['dot'] },
      { type: 'paragraph', text: 'a\tb\nc' },
      { type: 'table', rows: [['x y', '']] },
    ]);
  });

  it('refuses a zip without a document part, and says when a document is empty', () => {
    expect(() => readDocx(pkg({ 'other.xml': '<a/>' }))).toThrow(/not a DOCX/);
    const empty = readDocx(pkg({ 'word/document.xml': `<w:document ${W}><w:body/></w:document>` }));
    expect(empty).toMatchObject({ blocks: [], note: 'The document has no text.' });
  });
});

const S =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

describe('XLSX reader (FR-219)', () => {
  function workbook(sheet: string) {
    return pkg({
      '_rels/.rels': `<Relationships ${REL_NS}>${rel('r1', 'officeDocument', '/xl/book.xml')}</Relationships>`,
      'xl/book.xml': `<workbook ${S}><sheets><sheet name="Data" sheetId="7" r:id="s1"/><sheet name="Missing" sheetId="8" r:id="nope"/></sheets></workbook>`,
      'xl/_rels/book.xml.rels': `<Relationships ${REL_NS}>${rel('s1', 'worksheet', 'sheets/one.xml')}${rel('st', 'styles', 'st.xml')}${rel('ss', 'sharedStrings', 'ss.xml')}</Relationships>`,
      'xl/sheets/one.xml': sheet,
      'xl/st.xml': `<styleSheet ${S}><numFmts count="2"><numFmt numFmtId="170" formatCode="d/m/yyyy"/><numFmt numFmtId="171" formatCode="&quot;y&quot;0.00"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="170"/><xf numFmtId="14"/><xf numFmtId="171"/></cellXfs></styleSheet>`,
      'xl/ss.xml': `<sst ${S}><si><t>plain</t></si><si><r><t>rich </t></r><r><rPr><b/></rPr><t>text</t></r><rPh><t>skip</t></rPh></si></sst>`,
    });
  }

  it('reads shared, rich and inline strings, dates by format, formulas, errors and sparse cells', () => {
    const bytes = workbook(`<worksheet ${S}><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
      <row r="3"><c r="A3" s="1"><v>46312</v></c><c s="2"><v>46312.5</v></c><c s="3"><v>2.5</v></c><c t="inlineStr"><is><t>inline</t></is></c></row>
      <row><c r="B4" t="str"><f>A1</f><v>calc</v></c><c r="C4" t="e"><v>#DIV/0!</v></c><c r="D4" t="b"><v>1</v></c><c r="E4"/></row>
      <row r="6"><c r="A6"><v></v></c></row>
    </sheetData></worksheet>`);
    const read = readXlsx(bytes);
    expect(read.sheets).toEqual([
      {
        name: 'Data',
        rows: [
          ['plain', '', 'rich text'],
          [],
          ['2026-10-17', '2026-10-17T12:00:00', '2.5', 'inline'],
          ['', 'calc', '#DIV/0!', 'TRUE'],
        ],
        truncated: false,
      },
    ]);
    const text = documentText(read, 10_000).text;
    expect(text).toContain('## Sheet: Data (4 rows, 4 columns)');
    expect(text).toContain('2026-10-17\t2026-10-17T12:00:00\t2.5\tinline');
  });

  it('cuts rows and columns at the reading limits and says so', () => {
    const bytes = workbook(`<worksheet ${S}><sheetData>
      <row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"><v>3</v></c></row>
      <row r="2"><c r="A2"><v>4</v></c></row><row r="3"><c r="A3"><v>5</v></c></row>
    </sheetData></worksheet>`);
    const read = readXlsx(bytes, { maxRows: 2, maxCols: 2 });
    expect(read.sheets![0]).toEqual({ name: 'Data', rows: [['1', '2'], ['4']], truncated: true });
    expect(read.truncated).toBe(true);
    expect(documentText(read, 10_000).text).toContain('cut at the reading limit');
  });
});

const P =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

describe('PPTX reader (FR-219)', () => {
  it('follows the slide list order and reads groups, tables, fields and notes', () => {
    const sp = (ph: string, text: string, lvl = '') =>
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ''}<a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const slideA = `<p:sld ${P}><p:cSld><p:spTree>${sp('<p:ph type="ctrTitle"/>', 'Cover')}${sp('<p:ph type="sldNum"/>', '7')}<p:grpSp>${sp('', 'Grouped', '1')}</p:grpSp><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>c1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:fld><a:t>c2</a:t></a:fld></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`;
    const slideB = `<p:sld ${P}><p:cSld><p:spTree>${sp('<p:ph type="title"/>', 'Second')}</p:spTree></p:cSld></p:sld>`;
    const notes = `<p:notes ${P}><p:cSld><p:spTree>${sp('<p:ph type="sldImg"/>', 'image')}${sp('<p:ph type="body" idx="1"/>', 'Say hello')}</p:spTree></p:cSld></p:notes>`;
    const bytes = pkg({
      '_rels/.rels': `<Relationships ${REL_NS}>${rel('r1', 'officeDocument', 'ppt/presentation.xml')}</Relationships>`,
      'ppt/presentation.xml': `<p:presentation ${P}><p:sldIdLst><p:sldId id="300" r:id="b"/><p:sldId id="301" r:id="a"/><p:sldId id="302" r:id="gone"/></p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': `<Relationships ${REL_NS}>${rel('a', 'slide', 'slides/slide1.xml')}${rel('b', 'slide', 'slides/slide2.xml')}</Relationships>`,
      'ppt/slides/slide1.xml': slideA,
      'ppt/slides/slide2.xml': slideB,
      'ppt/slides/_rels/slide2.xml.rels': `<Relationships ${REL_NS}>${rel('n', 'notesSlide', '../notesSlides/n2.xml')}</Relationships>`,
      'ppt/notesSlides/n2.xml': notes,
    });
    expect(detectFormat(bytes)).toBe('pptx');
    const read = readPptx(bytes);
    expect(read.slides).toEqual([
      { index: 1, title: 'Second', paragraphs: [], notes: 'Say hello' },
      {
        index: 2,
        title: 'Cover',
        paragraphs: [
          { text: 'Grouped', level: 1 },
          { text: 'c1\tc2', level: 0 },
        ],
        notes: null,
      },
    ]);
    const text = documentText(read, 10_000).text;
    expect(text).toBe(
      '## Slide 1: Second\nNotes: Say hello\n\n## Slide 2: Cover\n  - Grouped\n- c1\tc2',
    );
  });

  it('refuses a zip without a presentation part', () => {
    expect(() => readPptx(pkg({ 'x.xml': '<a/>' }))).toThrow(/not a PPTX/);
    expect(() => readXlsx(pkg({ 'x.xml': '<a/>' }))).toThrow(/not an XLSX/);
  });
});

// ---- detection, limits, text and previews --------------------------------------------------------

describe('detection and limits (FR-219)', () => {
  it('detects formats by content and uses the hint only to break ties', () => {
    const docx = pkg({ 'word/document.xml': `<w:document ${W}><w:body/></w:document>` });
    expect(detectFormat(docx)).toBe('docx');
    expect(detectFormat(docx, { name: 'x.xlsx' })).toBe('docx');
    const both = pkg({ 'word/document.xml': '<a/>', 'xl/workbook.xml': '<b/>' });
    expect(
      detectFormat(both, {
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ).toBe('xlsx');
    expect(detectFormat(both, { name: 'book.XLSX' })).toBe('xlsx');
    expect(detectFormat(pkg({ 'a.txt': 'x' }))).toBeNull();
    expect(detectFormat(Buffer.from('PK\u0003\u0004garbage', 'latin1'))).toBeNull();
    expect(detectFormat(Buffer.from('%PDF-1.4'))).toBe('pdf');
    expect(() => extractDocument(new Uint8Array(26 * 1024 * 1024))).toThrow(/larger than 25 MB/);
  });

  it('refuses archives past the entry and size limits, and damaged archives', () => {
    const two = zipSync({ 'a.xml': strToU8('<a/>'), 'b.xml': strToU8('<b/>') });
    expect(() =>
      readZip(two, () => true, { maxEntries: 1, maxEntryBytes: 100, maxTotalBytes: 100 }),
    ).toThrow(/too many parts/);
    expect(() =>
      readZip(two, () => true, { maxEntries: 5, maxEntryBytes: 2, maxTotalBytes: 100 }),
    ).toThrow(/too large \(a\.xml\)/);
    expect(() =>
      readZip(two, () => true, { maxEntries: 5, maxEntryBytes: 10, maxTotalBytes: 6 }),
    ).toThrow(/too much data/);
    expect(readZip(two, (n) => n === 'b.xml').size).toBe(1);
    expect(() => readZip(new Uint8Array(30))).toThrow(/not a valid zip package/);
  });

  it('inflates within a cap and keeps what a damaged stream yields', () => {
    // Pseudo-random bytes barely compress, so the stream spans many inflate steps.
    let seed = 7;
    const noise = Uint8Array.from(
      { length: 100_000 },
      () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24,
    );
    const data = zlibSync(noise);
    expect(inflateBounded(data, { zlib: true, max: 200_000 })).toEqual(noise);
    expect(() => inflateBounded(data, { zlib: true, max: 1000 })).toThrow(/too much data/);
    expect(() => inflateBounded(new Uint8Array([1, 2, 3, 4]), { zlib: true, max: 10 })).toThrow(
      /damaged/,
    );
    const partial = inflateBounded(data.subarray(0, data.length - 30), {
      zlib: true,
      max: 200_000,
    });
    expect(partial.length).toBeGreaterThan(50_000);
    expect(partial).toEqual(noise.subarray(0, partial.length));
    // Inflating the capped stream is CPU-bound: generous under a loaded machine.
  }, 30_000);
});

describe('XML parsing (FR-219)', () => {
  it('reads entities, CDATA and comments, and refuses what is not well formed', () => {
    const el = parseXml(
      '﻿<?xml version="1.0"?><!-- c --><a x="&quot;1&#x41;&#66;&apos;"><![CDATA[<raw>]]>&amp;&lt;&gt;</a>',
    );
    expect(el.attrs.x).toBe('"1AB\'');
    expect(textContent(el)).toBe('<raw>&<>');
    for (const bad of [
      '<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>',
      '<a><b></a></b>',
      '<a>&nope;</a>',
      '<a>&amp</a>',
      '<a x=1/>',
      '<a x="1" x="2"/>',
      '<a/><b/>',
      'text<a/>',
      '<a>',
      '',
      '<a x="<"/>',
      '<1a/>',
      '<a><!-- open</a>',
      '<a>&#xFFFFFF;</a>',
    ])
      expect(() => parseXml(bad), bad).toThrow();
    expect(() => parseXml('<a><a><a></a></a></a>', 'deep', { maxNodes: 100, maxDepth: 2 })).toThrow(
      /nested too deeply/,
    );
    expect(() => parseXml('<a><b/><b/><b/></a>', 'many', { maxNodes: 3, maxDepth: 10 })).toThrow(
      /too many/,
    );
    expect(decodeEntities('plain')).toBe('plain');
    expect(xmlSafe('a\u0000b\ud800c\udc00d😀')).toBe('abcd😀');
  });
});

describe('text for the model and the preview (FR-219)', () => {
  const doc: ExtractedDocument = {
    format: 'docx',
    title: 'T',
    blocks: [
      { type: 'heading', level: 2, text: 'H' },
      { type: 'paragraph', text: 'p'.repeat(50) },
      { type: 'list', ordered: true, items: ['a', 'b'] },
      {
        type: 'table',
        rows: [
          ['x\ty', 'z'],
          ['1', '2'],
          ['3', '4'],
        ],
      },
    ],
    readable: true,
    note: null,
    truncated: false,
  };

  it('renders structure as text and cuts it with a marker', () => {
    expect(documentText(doc, 10_000)).toEqual({
      text: `Title: T\n\n## H\n\n${'p'.repeat(50)}\n\n1. a\n2. b\n\nx y\tz\n1\t2\n3\t4`,
      truncated: false,
    });
    const cut = documentText(doc, 90);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toMatch(/\[\.\.\. \d+ more characters not shown \.\.\.\]$/);
    const pdfDoc: ExtractedDocument = {
      format: 'pdf',
      title: null,
      pages: [{ index: 1, text: 'one' }],
      readable: false,
      note: 'n',
      truncated: false,
    };
    expect(documentText(pdfDoc, 100).text).toBe('## Page 1\none\n\n(n)');
  });

  it('trims previews to their limits', () => {
    const t = trimForPreview(doc, { maxChars: 30, maxRows: 2, maxCols: 1 });
    expect(t.truncated).toBe(true);
    expect(t.blocks![0]).toEqual({ type: 'heading', level: 2, text: 'H' });
    expect((t.blocks![1] as { text: string }).text).toHaveLength(30);
    expect(t.blocks).toHaveLength(2);
    const sheets = trimForPreview(
      {
        format: 'xlsx',
        title: null,
        sheets: [{ name: 'S', rows: [['1', '2'], ['3'], ['4']], truncated: false }],
        readable: true,
        note: null,
        truncated: false,
      },
      { maxChars: 100, maxRows: 2, maxCols: 1 },
    );
    expect(sheets.sheets).toEqual([{ name: 'S', rows: [['1'], ['3']], truncated: true }]);
    expect(sheets.truncated).toBe(true);
    const slides = trimForPreview(
      {
        format: 'pptx',
        title: null,
        slides: [{ index: 1, title: 'x', paragraphs: [{ text: 'abc', level: 0 }], notes: 'nn' }],
        readable: true,
        note: null,
        truncated: false,
      },
      { maxChars: 100, maxRows: 2, maxCols: 1 },
    );
    expect(slides.slides![0]).toEqual({
      index: 1,
      title: 'x',
      paragraphs: [{ text: 'abc', level: 0 }],
      notes: 'nn',
    });
    const pages = trimForPreview(
      {
        format: 'pdf',
        title: null,
        pages: [
          { index: 1, text: 'abcdef' },
          { index: 2, text: 'gh' },
        ],
        readable: true,
        note: null,
        truncated: false,
      },
      { maxChars: 4, maxRows: 2, maxCols: 1 },
    );
    expect(pages.pages).toEqual([
      { index: 1, text: 'abcd…' },
      { index: 2, text: '' },
    ]);
  });
});

describe('no network in document generation (FR-219)', () => {
  it('imports no network module and calls no fetch', () => {
    const src = join(import.meta.dirname, '../src');
    const files = [
      ...readdirSync(join(src, 'documents')).map((f) => join(src, 'documents', f)),
      join(src, 'tools/documents.ts'),
    ];
    const NETWORK =
      /^(node:)?(http|https|http2|net|dgram|tls|dns|undici|ws)$|^@nova\/(mcp|providers|compute)/;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      for (const i of imports) expect(NETWORK.test(i), `${f} imports ${i}`).toBe(false);
      expect(text, f).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|child_process/);
    }
    expect(files.length).toBeGreaterThan(10);
  });
});
