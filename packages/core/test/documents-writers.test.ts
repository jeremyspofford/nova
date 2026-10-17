// Document writers (FR-219): each format round-trips through its reader, and each package is
// structurally sound the way office suites require: the content-types part first, every part
// well-formed XML with a content type, every relationship target present, and the PDF's cross-
// reference table pointing at its objects.
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  extractDocument,
  parseDocumentContent,
  readDocx,
  readPdf,
  readPptx,
  readXlsx,
  writePdf,
  type DocumentFormat,
} from '../src/documents/index.ts';
import { readRels } from '../src/documents/ooxml.ts';
import { attr, childElements, descendants, parseXml } from '../src/documents/xml.ts';
import { columnIndex, columnName } from '../src/documents/xlsx.ts';

const META = { title: 'Quarterly report', created: new Date('2026-10-17T09:30:00Z') };

function build(format: DocumentFormat, content: unknown) {
  return buildDocument(parseDocumentContent(format, content), META);
}

/** Structural checks every Office Open XML package must pass. */
function checkPackage(bytes: Uint8Array): Record<string, string> {
  const raw = unzipSync(bytes);
  const names = Object.keys(raw);
  expect(names[0]).toBe('[Content_Types].xml');
  const text: Record<string, string> = {};
  for (const n of names) {
    text[n] = strFromU8(raw[n]!);
    if (n.endsWith('.xml') || n.endsWith('.rels')) parseXml(text[n], n);
  }
  const ct = parseXml(text['[Content_Types].xml']!);
  const overrides = childElements(ct, 'Override').map((o) => attr(o, 'PartName')!.slice(1));
  expect(childElements(ct, 'Default').map((d) => attr(d, 'Extension'))).toEqual(['rels', 'xml']);
  for (const o of overrides) expect(names, `override ${o}`).toContain(o);
  for (const n of names)
    if (n.endsWith('.xml') && n !== '[Content_Types].xml')
      expect(overrides, `content type for ${n}`).toContain(n);
  for (const n of names.filter((x) => x.endsWith('.rels'))) {
    const owner = n.replace(/(^|\/)_rels\//, '$1').replace(/\.rels$/, '');
    const rels = readRels(text[n]!, owner);
    expect(rels.size).toBeGreaterThan(0);
    for (const r of rels.values()) expect(names, `${n} → ${r.target}`).toContain(r.target);
  }
  const root = readRels(text['_rels/.rels']!, '');
  expect([...root.values()].map((r) => r.target)).toEqual(
    expect.arrayContaining(['docProps/core.xml', 'docProps/app.xml']),
  );
  expect(text['docProps/core.xml']).toContain('<dc:title>Quarterly report</dc:title>');
  expect(text['docProps/core.xml']).toContain('2026-10-17T09:30:00Z');
  return text;
}

describe('DOCX (FR-219)', () => {
  const content = {
    blocks: [
      { type: 'heading', level: 1, text: 'Summary' },
      {
        type: 'paragraph',
        text: [
          { text: 'Revenue grew ' },
          { text: '12%', bold: true },
          { text: ' in Q3', italic: true },
        ],
      },
      { type: 'bullets', items: ['North & South', 'East <West>'] },
      { type: 'numbered', items: ['First', 'Second'] },
      { type: 'numbered', items: ['Again one'] },
      { type: 'heading', level: 2, text: 'Numbers' },
      {
        type: 'table',
        header: ['Region', 'Sales'],
        rows: [
          ['North', 120],
          ['South', '95'],
        ],
      },
    ],
  };

  it('writes a minimal valid package and reads it back block by block', () => {
    const built = build('docx', content);
    expect(built.mime).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const parts = checkPackage(built.bytes);
    expect(Object.keys(parts).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/app.xml',
      'docProps/core.xml',
      'word/_rels/document.xml.rels',
      'word/document.xml',
      'word/numbering.xml',
      'word/styles.xml',
    ]);
    const doc = parts['word/document.xml']!;
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
    expect(doc).toContain('<w:b/><w:bCs/>');
    expect(doc).toContain('<w:i/><w:iCs/>');
    expect(doc).toContain('North &amp; South');
    expect(doc).toContain('East &lt;West&gt;');
    expect(doc).toContain('<w:tblHeader/>');
    // The body ends with a paragraph, then the section properties (A4 by default).
    expect(doc).toMatch(/<\/w:tbl><w:p\/><w:sectPr><w:pgSz w:w="11906" w:h="16838"\/>/);
    // Each numbered list restarts: two instances of the decimal list.
    const numbering = parseXml(parts['word/numbering.xml']!);
    expect(childElements(numbering, 'num').map((n) => attr(n, 'numId'))).toEqual(['1', '2', '3']);
    expect(descendants(numbering, 'startOverride')).toHaveLength(2);

    const read = readDocx(built.bytes);
    expect(read.title).toBe('Quarterly report');
    expect(read.blocks).toEqual([
      { type: 'heading', level: 1, text: 'Summary' },
      { type: 'paragraph', text: 'Revenue grew 12% in Q3' },
      { type: 'list', ordered: false, items: ['North & South', 'East <West>'] },
      { type: 'list', ordered: true, items: ['First', 'Second', 'Again one'] },
      { type: 'heading', level: 2, text: 'Numbers' },
      {
        type: 'table',
        rows: [
          ['Region', 'Sales'],
          ['North', '120'],
          ['South', '95'],
        ],
      },
    ]);
  });

  it('uses Letter pages, keeps line breaks and tabs, and drops characters XML cannot carry', () => {
    const built = build('docx', {
      pageSize: 'letter',
      blocks: [{ type: 'paragraph', text: 'a\tb\nc\u0001d' }],
    });
    const doc = checkPackage(built.bytes)['word/document.xml']!;
    expect(doc).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
    expect(doc).toContain('<w:tab/>');
    expect(doc).toContain('<w:br/>');
    expect(readDocx(built.bytes).blocks).toEqual([{ type: 'paragraph', text: 'a\tb\ncd' }]);
  });
});

describe('PPTX (FR-219)', () => {
  const content = {
    slides: [
      { title: 'Launch plan', subtitle: 'October review' },
      {
        title: 'Goals',
        bullets: ['Ship the beta', { text: 'Fix the top bugs', level: 1 }, 'Hire'],
        notes: 'Mention the budget.\nKeep it short.',
      },
      { title: 'Questions?' },
    ],
  };

  it('writes slides with a master, layout, theme and notes, and reads them back in order', () => {
    const built = build('pptx', content);
    const parts = checkPackage(built.bytes);
    expect(Object.keys(parts)).toEqual(
      expect.arrayContaining([
        'ppt/presentation.xml',
        'ppt/slideMasters/slideMaster1.xml',
        'ppt/slideLayouts/slideLayout1.xml',
        'ppt/theme/theme1.xml',
        'ppt/theme/theme2.xml',
        'ppt/notesMasters/notesMaster1.xml',
        'ppt/notesSlides/notesSlide2.xml',
        'ppt/slides/slide3.xml',
      ]),
    );
    expect(Object.keys(parts)).not.toContain('ppt/notesSlides/notesSlide1.xml');
    const pres = parseXml(parts['ppt/presentation.xml']!);
    const ids = descendants(pres, 'sldId').map((s) => attr(s, 'id'));
    expect(ids).toEqual(['256', '257', '258']);
    expect(descendants(pres, 'notesMasterId')).toHaveLength(1);
    // Every slide id points at a slide relationship.
    const rels = readRels(parts['ppt/_rels/presentation.xml.rels']!, 'ppt/presentation.xml');
    for (const s of descendants(pres, 'sldId'))
      expect(rels.get(s.attrs['r:id']!)?.type).toMatch(/\/slide$/);
    // The theme lists its 12 colors and three of each format style.
    const theme = parseXml(parts['ppt/theme/theme1.xml']!);
    expect(childElements(descendants(theme, 'clrScheme')[0]!)).toHaveLength(12);
    expect(childElements(descendants(theme, 'fillStyleLst')[0]!)).toHaveLength(3);

    const read = readPptx(built.bytes);
    expect(read.slides).toEqual([
      {
        index: 1,
        title: 'Launch plan',
        paragraphs: [{ text: 'October review', level: 0 }],
        notes: null,
      },
      {
        index: 2,
        title: 'Goals',
        paragraphs: [
          { text: 'Ship the beta', level: 0 },
          { text: 'Fix the top bugs', level: 1 },
          { text: 'Hire', level: 0 },
        ],
        notes: 'Mention the budget.\nKeep it short.',
      },
      { index: 3, title: 'Questions?', paragraphs: [], notes: null },
    ]);
  });

  it('leaves the notes master out when no slide has notes', () => {
    const parts = checkPackage(build('pptx', { slides: [{ title: 'Only' }] }).bytes);
    expect(Object.keys(parts)).not.toContain('ppt/notesMasters/notesMaster1.xml');
    expect(parts['ppt/presentation.xml']).not.toContain('notesMasterIdLst');
  });
});

describe('XLSX (FR-219)', () => {
  it('writes typed cells, a bold frozen header and widths, and reads them back as text', () => {
    const built = build('xlsx', {
      sheets: [
        {
          name: 'Sales',
          columns: [
            { header: 'Region', width: 24 },
            { header: 'Amount' },
            { header: 'Paid' },
            { header: 'Due' },
          ],
          rows: [
            ['North', 120.5, true, { date: '2026-10-17' }],
            ['South', -3, false, { date: '2026-10-17T09:30' }],
            [null, 7],
          ],
        },
        { name: 'Notes', rows: [['plain', 'text & <tags>']] },
      ],
    });
    const parts = checkPackage(built.bytes);
    const sheet = parts['xl/worksheets/sheet1.xml']!;
    expect(sheet).toContain(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    );
    expect(sheet).toContain('<col min="1" max="1" width="24" customWidth="1"/>');
    expect(sheet).toContain('<c r="A1" t="s" s="1">');
    expect(sheet).toContain('<c r="B2"><v>120.5</v></c>');
    expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>');
    // 2026-10-17 is serial day 46312; the time of day is the fraction.
    expect(sheet).toContain('<c r="D2" s="2"><v>46312</v></c>');
    expect(sheet).toMatch(/<c r="D3" s="3"><v>46312\.3958333/);
    expect(sheet).toContain('<dimension ref="A1:D4"/>');
    expect(parts['xl/worksheets/sheet2.xml']).not.toContain('<pane');
    const sst = parseXml(parts['xl/sharedStrings.xml']!);
    expect(attr(sst, 'uniqueCount')).toBe('8');

    const read = readXlsx(built.bytes);
    expect(read.sheets).toEqual([
      {
        name: 'Sales',
        rows: [
          ['Region', 'Amount', 'Paid', 'Due'],
          ['North', '120.5', 'TRUE', '2026-10-17'],
          ['South', '-3', 'FALSE', '2026-10-17T09:30:00'],
          ['', '7'],
        ],
        truncated: false,
      },
      { name: 'Notes', rows: [['plain', 'text & <tags>']], truncated: false },
    ]);
  });

  it('names columns both ways', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
    expect(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'].map(columnIndex)).toEqual([0, 25, 26, 27, 701, 702]);
    expect(columnIndex('a1')).toBe(-1);
  });
});

describe('PDF (FR-219)', () => {
  const content = {
    blocks: [
      { type: 'heading', level: 1, text: 'Field notes' },
      {
        type: 'paragraph',
        text: [
          { text: 'Plain, ' },
          { text: 'bold', bold: true },
          { text: ' and ' },
          { text: 'italic', italic: true },
          { text: ' (with parens) and a back\\slash.' },
        ],
      },
      { type: 'bullets', items: ['Café “quotes” – dash'] },
      { type: 'numbered', items: ['one', 'two'] },
      {
        type: 'table',
        header: ['Name', 'Value'],
        rows: [
          ['alpha', '1'],
          ['beta', '2'],
        ],
      },
    ],
  };

  it('writes a well-formed file whose cross-references point at its objects', () => {
    const { bytes, replaced } = writePdf(
      parseDocumentContent('pdf', content).content as never,
      META,
    );
    expect(replaced).toBe(0);
    const src = Buffer.from(bytes).toString('latin1');
    expect(src.startsWith('%PDF-1.4\n')).toBe(true);
    expect(src.trimEnd().endsWith('%%EOF')).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(src)![1]);
    expect(src.slice(startxref, startxref + 4)).toBe('xref');
    const table = src.slice(startxref).split('\n');
    const count = Number(table[1]!.split(' ')[1]);
    for (let id = 1; id < count; id++) {
      const entry = table[2 + id]!;
      expect(entry).toMatch(/^\d{10} 00000 n $/);
      const off = Number(entry.slice(0, 10));
      expect(src.slice(off, off + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
    }
    expect(src).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(src).toContain('/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding');
    expect(src).toContain('/Filter /FlateDecode');
  });

  it('reads its own output back, with page numbers', () => {
    const built = build('pdf', content);
    const read = readPdf(built.bytes);
    expect(read).toMatchObject({
      format: 'pdf',
      title: 'Quarterly report',
      readable: true,
      note: null,
    });
    const text = read.pages![0]!.text;
    expect(text).toContain('Field notes');
    expect(text).toContain('Plain, bold and italic (with parens) and a back\\slash.');
    expect(text).toContain('• Café “quotes” – dash');
    expect(text).toContain('1. one');
    expect(text).toContain('Name Value');
    expect(text).toContain('beta 2');
    expect(text).toContain('1 / 1');
  });

  it('wraps long text onto more pages, on Letter, and repeats a table header', () => {
    const long = 'word '.repeat(4000);
    const built = build('pdf', {
      pageSize: 'letter',
      blocks: [
        { type: 'paragraph', text: long },
        {
          type: 'table',
          header: ['H1', 'H2'],
          rows: Array.from({ length: 80 }, (_, i) => [`r${i}`, `${i}`]),
        },
        { type: 'paragraph', text: 'x'.repeat(500) },
      ],
    });
    const src = Buffer.from(built.bytes).toString('latin1');
    expect(src).toContain('/MediaBox [0 0 612 792]');
    const read = readPdf(built.bytes);
    expect(read.pages!.length).toBeGreaterThan(3);
    const n = read.pages!.length;
    expect(read.pages!.at(-1)!.text).toContain(`${n} / ${n}`);
    const headers = read.pages!.filter((p) => p.text.includes('H1 H2')).length;
    expect(headers).toBeGreaterThan(1);
    // Every word made it, none lost at line or page breaks.
    const words =
      read
        .pages!.map((p) => p.text)
        .join(' ')
        .match(/\bword\b/g) ?? [];
    expect(words).toHaveLength(4000);
  });

  it('counts characters the standard font cannot show and says so', () => {
    const built = build('pdf', { blocks: [{ type: 'paragraph', text: 'Hello 世界 → ok' }] });
    expect(built.notes).toEqual([
      '2 characters outside the PDF\'s standard font (Western European text) were printed as "?". Use DOCX for other scripts.',
    ]);
    expect(readPdf(built.bytes).pages![0]!.text).toContain('Hello ?? -> ok');
  });
});

describe('content validation (FR-219)', () => {
  it.each([
    ['docx', { blocks: [] }, /content\.blocks: /],
    ['docx', { blocks: [{ type: 'heading', level: 7, text: 'x' }] }, /content\.blocks\[0\]\.level/],
    ['docx', { slides: [{ title: 'x' }] }, /content\.blocks/],
    ['pptx', { slides: [{ title: 'x', bullets: [{ text: 'y', level: 9 }] }] }, /level/],
    ['xlsx', { sheets: [{ name: 'a/b', rows: [] }] }, /sheet names/],
    [
      'xlsx',
      {
        sheets: [
          { name: 'A', rows: [] },
          { name: 'a', rows: [] },
        ],
      },
      /duplicate sheet name/,
    ],
    ['xlsx', { sheets: [{ name: 'A', rows: [[{ date: '2026-02-30' }]] }] }, /expected a date/],
    ['xlsx', { sheets: [{ name: "'quoted'", rows: [] }] }, /apostrophe/],
  ] as const)('refuses invalid %s content (%#)', (format, content, message) => {
    expect(() => parseDocumentContent(format, content)).toThrow(message);
  });

  it('extractDocument refuses what it cannot read', () => {
    expect(() => extractDocument(new TextEncoder().encode('hello'))).toThrow(
      /not a document Nova can read/,
    );
  });
});
