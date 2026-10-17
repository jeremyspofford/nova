// PPTX (FR-219): a minimal PresentationML package (one master, one title-and-content layout, a
// theme, 16:9 slides with a title, bullets and optional speaker notes) and a reader that returns
// each slide's title, text and notes in presentation order.
import { NovaError } from '@nova/shared';
import type { PptxContent } from './content.ts';
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
  type Relationship,
} from './ooxml.ts';
import type { DocumentMeta } from './docx.ts';
import type { ExtractedDocument, ExtractedSlide } from './types.ts';
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

const NSDECL =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** 16:9 in EMU. */
const SLIDE = { cx: 12192000, cy: 6858000 };
const TITLE_BOX = { x: 838200, y: 365125, cx: 10515600, cy: 1325563 };
const BODY_BOX = { x: 838200, y: 1825625, cx: 10515600, cy: 4351338 };
/** A slide with a subtitle and no bullets is laid out as a title slide. */
const COVER_TITLE = { x: 1524000, y: 1122363, cx: 9144000, cy: 2387600 };
const COVER_SUB = { x: 1524000, y: 3602038, cx: 9144000, cy: 1655762 };

type Box = { x: number; y: number; cx: number; cy: number };

const xfrm = (b: Box) =>
  `<a:xfrm><a:off x="${b.x}" y="${b.y}"/><a:ext cx="${b.cx}" cy="${b.cy}"/></a:xfrm>`;

const GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const CLR_MAP =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

function textRun(text: string, size: number, bold = false): string {
  return `<a:r><a:rPr lang="en-US" sz="${size}"${bold ? ' b="1"' : ''} dirty="0"/><a:t>${esc(text)}</a:t></a:r>`;
}

function para(text: string, size: number, pPr = '', bold = false): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const runs = lines
    .map(
      (l, i) =>
        (i ? '<a:br><a:rPr lang="en-US" dirty="0"/></a:br>' : '') +
        (l ? textRun(l, size, bold) : ''),
    )
    .join('');
  return `<a:p>${pPr}${runs}<a:endParaRPr lang="en-US" sz="${size}" dirty="0"/></a:p>`;
}

function placeholder(
  id: number,
  name: string,
  ph: string,
  box: Box | null,
  paragraphs: string,
  anchor?: 'ctr' | 't',
): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${box ? xfrm(box) : ''}</p:spPr>` +
    `<p:txBody><a:bodyPr${anchor ? ` anchor="${anchor}"` : ''}><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
}

function slideXml(s: PptxContent['slides'][number]): string {
  const bullets = s.bullets ?? [];
  const cover = !bullets.length && s.subtitle !== undefined;
  const title = placeholder(
    2,
    'Title 1',
    '<p:ph type="title"/>',
    cover ? COVER_TITLE : TITLE_BOX,
    para(s.title, cover ? 4400 : 3600, cover ? '<a:pPr algn="ctr"/>' : ''),
    cover ? 'ctr' : undefined,
  );
  let body = '';
  if (cover) {
    body = placeholder(
      3,
      'Subtitle 2',
      '<p:ph idx="1"/>',
      COVER_SUB,
      para(s.subtitle ?? '', 2400, '<a:pPr marL="0" indent="0" algn="ctr"><a:buNone/></a:pPr>'),
      't',
    );
  } else {
    const paras: string[] = [];
    if (s.subtitle)
      paras.push(para(s.subtitle, 2400, '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>', true));
    for (const b of bullets) {
      const { text, level } = typeof b === 'string' ? { text: b, level: 0 } : b;
      const marL = 342900 + level * 457200;
      paras.push(
        para(
          text,
          level ? 2000 : 2400,
          `<a:pPr marL="${marL}" lvl="${level}" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>`,
        ),
      );
    }
    if (paras.length)
      body = placeholder(3, 'Content 2', '<p:ph idx="1"/>', BODY_BOX, paras.join(''), 't');
  }
  return `${XML_DECL}<p:sld ${NSDECL}><p:cSld><p:spTree>${GROUP}${title}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function notesXml(notes: string): string {
  const paras = notes
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => para(l, 1200))
    .join('');
  return `${XML_DECL}<p:notes ${NSDECL}><p:cSld><p:spTree>${GROUP}${placeholder(
    2,
    'Notes Placeholder 1',
    '<p:ph type="body" idx="1"/>',
    { x: 685800, y: 4400550, cx: 5486400, cy: 3600450 },
    paras,
  )}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

function masterXml(): string {
  const levels = [0, 1, 2, 3, 4]
    .map(
      (l) =>
        `<a:lvl${l + 1}pPr marL="${342900 + l * 457200}" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="${l ? 2000 : 2400}"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl${l + 1}pPr>`,
    )
    .join('');
  return (
    `${XML_DECL}<p:sldMaster ${NSDECL}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}` +
    placeholder(
      2,
      'Title Placeholder 1',
      '<p:ph type="title"/>',
      TITLE_BOX,
      para('Title', 3600),
      'ctr',
    ) +
    placeholder(
      3,
      'Text Placeholder 2',
      '<p:ph type="body" idx="1"/>',
      BODY_BOX,
      para('Text', 2400),
      't',
    ) +
    `</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
    '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3600"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
    `<p:bodyStyle>${levels}</p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`
  );
}

function layoutXml(): string {
  return (
    `${XML_DECL}<p:sldLayout ${NSDECL} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${GROUP}` +
    placeholder(2, 'Title 1', '<p:ph type="title"/>', null, para('', 3600)) +
    placeholder(3, 'Content Placeholder 2', '<p:ph idx="1"/>', null, para('', 2400)) +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
  );
}

function notesMasterXml(): string {
  return (
    `${XML_DECL}<p:notesMaster ${NSDECL}><p:cSld><p:spTree>${GROUP}` +
    placeholder(
      2,
      'Notes Placeholder 1',
      '<p:ph type="body" idx="1"/>',
      { x: 685800, y: 4400550, cx: 5486400, cy: 3600450 },
      para('', 1200),
    ) +
    `</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/></p:notesMaster>`
  );
}

/** A plain theme: neutral colors, one sans-serif face, solid fills. */
function themeXml(): string {
  const colors: [string, string][] = [
    ['dk1', '1F2328'],
    ['lt1', 'FFFFFF'],
    ['dk2', '2F3B4C'],
    ['lt2', 'EEF1F5'],
    ['accent1', '3B6FD8'],
    ['accent2', 'D9822B'],
    ['accent3', '3A9D6A'],
    ['accent4', '8E5CC4'],
    ['accent5', 'C2464F'],
    ['accent6', '2A9BB0'],
    ['hlink', '2457C5'],
    ['folHlink', '7A4FB3'],
  ];
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const font = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>';
  return (
    `${XML_DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Nova"><a:themeElements>` +
    `<a:clrScheme name="Nova">${colors.map(([n, v]) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`).join('')}</a:clrScheme>` +
    `<a:fontScheme name="Nova"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="Nova"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst>` +
    `<a:lnStyleLst>${`<a:ln w="9525">${fill}</a:ln>`.repeat(3)}</a:lnStyleLst>` +
    `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>` +
    `<a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme>` +
    '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
  );
}

/** Write a PPTX file. `content` must already be validated (parseDocumentContent). */
export function writePptx(content: PptxContent, meta: DocumentMeta): Uint8Array {
  const slides = content.slides;
  const withNotes = slides.some((s) => s.notes?.trim());
  const overrides: [string, string][] = [
    ['ppt/presentation.xml', CT.pptxMain],
    ['ppt/slideMasters/slideMaster1.xml', CT.pptxMaster],
    ['ppt/slideLayouts/slideLayout1.xml', CT.pptxLayout],
    ['ppt/theme/theme1.xml', CT.theme],
    ['ppt/presProps.xml', CT.pptxPresProps],
    ['ppt/viewProps.xml', CT.pptxViewProps],
    ['docProps/core.xml', CT.core],
    ['docProps/app.xml', CT.app],
  ];
  if (withNotes)
    overrides.push(
      ['ppt/notesMasters/notesMaster1.xml', CT.pptxNotesMaster],
      ['ppt/theme/theme2.xml', CT.theme],
    );
  const presRels: Relationship[] = [
    { id: 'rId1', type: REL.slideMaster, target: 'slideMasters/slideMaster1.xml' },
    { id: 'rId2', type: REL.theme, target: 'theme/theme1.xml' },
    { id: 'rId3', type: REL.presProps, target: 'presProps.xml' },
    { id: 'rId4', type: REL.viewProps, target: 'viewProps.xml' },
  ];
  if (withNotes)
    presRels.push({ id: 'rId5', type: REL.notesMaster, target: 'notesMasters/notesMaster1.xml' });
  const parts: [string, string][] = [];
  slides.forEach((s, i) => {
    const n = i + 1;
    overrides.push([`ppt/slides/slide${n}.xml`, CT.pptxSlide]);
    presRels.push({ id: `rId${10 + n}`, type: REL.slide, target: `slides/slide${n}.xml` });
    const rels: Relationship[] = [
      { id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
    ];
    parts.push([`ppt/slides/slide${n}.xml`, slideXml(s)]);
    if (s.notes?.trim()) {
      overrides.push([`ppt/notesSlides/notesSlide${n}.xml`, CT.pptxNotes]);
      rels.push({ id: 'rId2', type: REL.notesSlide, target: `../notesSlides/notesSlide${n}.xml` });
      parts.push([`ppt/notesSlides/notesSlide${n}.xml`, notesXml(s.notes)]);
      parts.push([
        `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
        relationships([
          { id: 'rId1', type: REL.notesMaster, target: '../notesMasters/notesMaster1.xml' },
          { id: 'rId2', type: REL.slide, target: `../slides/slide${n}.xml` },
        ]),
      ]);
    }
    parts.push([`ppt/slides/_rels/slide${n}.xml.rels`, relationships(rels)]);
  });
  const presentation =
    `${XML_DECL}<p:presentation ${NSDECL} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    (withNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId5"/></p:notesMasterIdLst>' : '') +
    `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${11 + i}"/>`).join('')}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE.cx}" cy="${SLIDE.cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const files: [string, string][] = [
    ['[Content_Types].xml', contentTypes(overrides)],
    ['_rels/.rels', rootRels('ppt/presentation.xml')],
    ['ppt/presentation.xml', presentation],
    ['ppt/_rels/presentation.xml.rels', relationships(presRels)],
    ['ppt/presProps.xml', `${XML_DECL}<p:presentationPr ${NSDECL}/>`],
    ['ppt/viewProps.xml', `${XML_DECL}<p:viewPr ${NSDECL}/>`],
    ['ppt/slideMasters/slideMaster1.xml', masterXml()],
    [
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      relationships([
        { id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
        { id: 'rId2', type: REL.theme, target: '../theme/theme1.xml' },
      ]),
    ],
    ['ppt/slideLayouts/slideLayout1.xml', layoutXml()],
    [
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      relationships([
        { id: 'rId1', type: REL.slideMaster, target: '../slideMasters/slideMaster1.xml' },
      ]),
    ],
    ['ppt/theme/theme1.xml', themeXml()],
    ...parts,
  ];
  if (withNotes)
    files.push(
      ['ppt/notesMasters/notesMaster1.xml', notesMasterXml()],
      [
        'ppt/notesMasters/_rels/notesMaster1.xml.rels',
        relationships([{ id: 'rId1', type: REL.theme, target: '../theme/theme2.xml' }]),
      ],
      ['ppt/theme/theme2.xml', themeXml()],
    );
  files.push(
    ['docProps/core.xml', coreProps(meta.title, meta.created)],
    ['docProps/app.xml', appProps()],
  );
  return writeZip(files, meta.created);
}

// ---- reading -----------------------------------------------------------------------------------

function shapeParagraphs(sp: XmlElement): { text: string; level: number }[] {
  const body = firstChild(sp, 'txBody');
  if (!body) return [];
  return childElements(body, 'p').map((p) => {
    let text = '';
    for (const c of childElements(p)) {
      const n = localName(c.name);
      if (n === 'r' || n === 'fld') {
        const t = firstChild(c, 't');
        if (t) text += textContent(t);
      } else if (n === 'br') text += '\n';
    }
    const pPr = firstChild(p, 'pPr');
    const level = Number(pPr ? (attr(pPr, 'lvl') ?? 0) : 0);
    return { text, level: Number.isFinite(level) ? level : 0 };
  });
}

function placeholderType(sp: XmlElement): string | null {
  const ph = descendants(sp, 'ph')[0];
  if (!ph) return null;
  return attr(ph, 'type') ?? 'body';
}

function slideText(xml: string): {
  title: string | null;
  paragraphs: { text: string; level: number }[];
} {
  const root = parseXml(xml, 'slide');
  let title: string | null = null;
  const paragraphs: { text: string; level: number }[] = [];
  // Shapes in document order, including those inside groups and graphic frames' text.
  for (const sp of descendants(root, 'sp')) {
    const type = placeholderType(sp);
    const paras = shapeParagraphs(sp).filter((p) => p.text.trim());
    if ((type === 'title' || type === 'ctrTitle') && title === null) {
      title =
        paras
          .map((p) => p.text)
          .join(' ')
          .trim() || null;
      continue;
    }
    if (type === 'sldNum' || type === 'dt' || type === 'ftr') continue;
    paragraphs.push(...paras);
  }
  for (const tbl of descendants(root, 'tbl'))
    for (const tr of childElements(tbl, 'tr'))
      paragraphs.push({
        text: childElements(tr, 'tc')
          .map((tc) =>
            shapeParagraphs(tc)
              .map((p) => p.text)
              .join(' '),
          )
          .join('\t'),
        level: 0,
      });
  return { title, paragraphs };
}

/** Read every slide's title, text and notes. Throws `validation` for a damaged file. */
export function readPptx(bytes: Uint8Array): ExtractedDocument {
  const files = readZip(bytes, (n) => n.endsWith('.xml') || n.endsWith('.rels'));
  const main = mainPartOf(entryText(files, '_rels/.rels')) ?? 'ppt/presentation.xml';
  const presText = entryText(files, main);
  if (!presText) throw new NovaError('validation', 'the file is not a PPTX presentation');
  const rels = readRels(entryText(files, relsPathOf(main)), main);
  const pres = parseXml(presText, 'presentation');
  const list = firstChild(pres, 'sldIdLst');
  const slides: ExtractedSlide[] = [];
  for (const id of list ? childElements(list, 'sldId') : []) {
    // `r:id` (any prefix), not the slide's own numeric `id`.
    const rid = Object.entries(id.attrs).find(([k]) => k !== 'id' && localName(k) === 'id')?.[1];
    const target = rid ? rels.get(rid)?.target : undefined;
    const xml = target ? entryText(files, target) : null;
    if (!target || !xml) continue;
    const { title, paragraphs } = slideText(xml);
    let notes: string | null = null;
    for (const r of readRels(entryText(files, relsPathOf(target)), target).values()) {
      if (!r.type.endsWith('/notesSlide')) continue;
      const notesText = entryText(files, r.target);
      if (!notesText) continue;
      const root = parseXml(notesText, 'notes');
      const parts: string[] = [];
      for (const sp of descendants(root, 'sp'))
        if (placeholderType(sp) === 'body') parts.push(...shapeParagraphs(sp).map((p) => p.text));
      notes = parts.join('\n').trim() || null;
    }
    slides.push({ index: slides.length + 1, title, paragraphs, notes });
  }
  return {
    format: 'pptx',
    title: readTitle(entryText(files, 'docProps/core.xml')),
    slides,
    readable: true,
    note: slides.length ? null : 'The presentation has no slides.',
    truncated: false,
  };
}
