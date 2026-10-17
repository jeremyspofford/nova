// Parts every Office Open XML package shares (FR-219): content types, relationships and the
// document properties. Relationship targets resolve against the part that owns them.
import { posix } from 'node:path';
import { XML_DECL, attr, childElements, esc, parseXml, textContent, firstChild } from './xml.ts';

export const NS = {
  rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  pkgRel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
};

export const REL = {
  officeDocument: `${NS.rel}/officeDocument`,
  core: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  app: `${NS.rel}/extended-properties`,
  styles: `${NS.rel}/styles`,
  numbering: `${NS.rel}/numbering`,
  worksheet: `${NS.rel}/worksheet`,
  sharedStrings: `${NS.rel}/sharedStrings`,
  slide: `${NS.rel}/slide`,
  slideLayout: `${NS.rel}/slideLayout`,
  slideMaster: `${NS.rel}/slideMaster`,
  notesSlide: `${NS.rel}/notesSlide`,
  notesMaster: `${NS.rel}/notesMaster`,
  theme: `${NS.rel}/theme`,
  presProps: `${NS.rel}/presProps`,
  viewProps: `${NS.rel}/viewProps`,
};

const OD = 'application/vnd.openxmlformats-officedocument';
export const CT = {
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
  xml: 'application/xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: `${OD}.extended-properties+xml`,
  docxMain: `${OD}.wordprocessingml.document.main+xml`,
  docxStyles: `${OD}.wordprocessingml.styles+xml`,
  docxNumbering: `${OD}.wordprocessingml.numbering+xml`,
  xlsxMain: `${OD}.spreadsheetml.sheet.main+xml`,
  xlsxSheet: `${OD}.spreadsheetml.worksheet+xml`,
  xlsxStyles: `${OD}.spreadsheetml.styles+xml`,
  xlsxStrings: `${OD}.spreadsheetml.sharedStrings+xml`,
  pptxMain: `${OD}.presentationml.presentation.main+xml`,
  pptxSlide: `${OD}.presentationml.slide+xml`,
  pptxLayout: `${OD}.presentationml.slideLayout+xml`,
  pptxMaster: `${OD}.presentationml.slideMaster+xml`,
  pptxNotes: `${OD}.presentationml.notesSlide+xml`,
  pptxNotesMaster: `${OD}.presentationml.notesMaster+xml`,
  pptxPresProps: `${OD}.presentationml.presProps+xml`,
  pptxViewProps: `${OD}.presentationml.viewProps+xml`,
  theme: `${OD}.theme+xml`,
};

/** `[Content_Types].xml` with the two defaults and an override per part. */
export function contentTypes(overrides: [part: string, type: string][]): string {
  return (
    `${XML_DECL}<Types xmlns="${NS.ct}">` +
    `<Default Extension="rels" ContentType="${CT.rels}"/>` +
    `<Default Extension="xml" ContentType="${CT.xml}"/>` +
    overrides.map(([p, t]) => `<Override PartName="/${esc(p)}" ContentType="${t}"/>`).join('') +
    '</Types>'
  );
}

export interface Relationship {
  id: string;
  type: string;
  target: string;
}

export function relationships(rels: Relationship[]): string {
  return (
    `${XML_DECL}<Relationships xmlns="${NS.pkgRel}">` +
    rels
      .map((r) => `<Relationship Id="${esc(r.id)}" Type="${r.type}" Target="${esc(r.target)}"/>`)
      .join('') +
    '</Relationships>'
  );
}

/** W3C date-time without fractions, as the core properties expect. */
export function w3cDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function coreProps(title: string, created: Date): string {
  const when = w3cDate(created);
  return (
    `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${esc(title)}</dc:title><dc:creator>Nova</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

export function appProps(): string {
  return `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Nova</Application></Properties>`;
}

/** The package-level relationships: the main part and the two property parts. */
export function rootRels(mainPart: string): string {
  return relationships([
    { id: 'rId1', type: REL.officeDocument, target: mainPart },
    { id: 'rId2', type: REL.core, target: 'docProps/core.xml' },
    { id: 'rId3', type: REL.app, target: 'docProps/app.xml' },
  ]);
}

// ---- reading -----------------------------------------------------------------------------------

/** The rels part of a part: `word/document.xml` → `word/_rels/document.xml.rels`. */
export function relsPathOf(part: string): string {
  const dir = posix.dirname(part);
  return posix.join(dir === '.' ? '' : dir, '_rels', `${posix.basename(part)}.rels`);
}

/** A part's relationships, with targets resolved to package paths (external ones dropped). */
export function readRels(
  text: string | null,
  ownerPart: string,
): Map<string, { type: string; target: string }> {
  const out = new Map<string, { type: string; target: string }>();
  if (!text) return out;
  const root = parseXml(text, 'relationships');
  const base = posix.dirname(ownerPart);
  for (const r of childElements(root, 'Relationship')) {
    const id = attr(r, 'Id');
    const target = attr(r, 'Target');
    if (!id || !target || attr(r, 'TargetMode') === 'External') continue;
    const resolved = target.startsWith('/')
      ? target.slice(1)
      : posix.normalize(posix.join(base === '.' ? '' : base, target));
    out.set(id, { type: attr(r, 'Type') ?? '', target: resolved });
  }
  return out;
}

/** The main part a package's root relationships name, or null. */
export function mainPartOf(rootRelsText: string | null): string | null {
  for (const r of readRels(rootRelsText, '').values())
    if (r.type.endsWith('/officeDocument')) return r.target;
  return null;
}

/** `dc:title` from docProps/core.xml, or null. */
export function readTitle(coreText: string | null): string | null {
  if (!coreText) return null;
  try {
    const t = firstChild(parseXml(coreText, 'core properties'), 'title');
    const s = t ? textContent(t).trim() : '';
    return s || null;
  } catch {
    return null;
  }
}
