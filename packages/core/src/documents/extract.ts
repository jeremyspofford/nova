// Reading documents (FR-219): detect the format of some bytes, extract their text and tables,
// render that as text for the model (headings, lists, TSV tables, one section per slide, sheet
// or page), and trim it for the artifact preview the Hub serves.
import { NovaError } from '@nova/shared';
import { DOCUMENT_MIME, formatOfMime, type DocumentFormat } from './content.ts';
import { readDocx } from './docx.ts';
import { readPdf } from './pdf.ts';
import { readPptx } from './pptx.ts';
import type { ExtractedDocument } from './types.ts';
import { readXlsx } from './xlsx.ts';
import { mainPartOf } from './ooxml.ts';
import { entryText, isZip, readZip } from './zip.ts';

/** Largest file the readers open (document.read, previews). */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const EXTENSIONS: Record<string, DocumentFormat> = {
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
  '.pdf': 'pdf',
};

/** The format named by a file name's extension, or null. */
export function formatOfName(name: string | null | undefined): DocumentFormat | null {
  const m = name ? /\.[A-Za-z]+$/.exec(name) : null;
  return m ? (EXTENSIONS[m[0].toLowerCase()] ?? null) : null;
}

/**
 * The format of some bytes: PDF by its header, Office files by the main part in the zip. `hint`
 * (a media type or file name) only breaks ties; the content decides.
 */
export function detectFormat(
  bytes: Uint8Array,
  hint?: { mime?: string | null; name?: string | null },
): DocumentFormat | null {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';
  if (!isZip(bytes)) return null;
  let names: string[];
  try {
    names = listZipNames(bytes);
  } catch {
    return null;
  }
  const has = (p: string) => names.includes(p);
  const byHint = formatOfMime(hint?.mime) ?? formatOfName(hint?.name);
  if (byHint && byHint !== 'pdf' && has(MAIN_PART[byHint])) return byHint;
  for (const f of ['docx', 'pptx', 'xlsx'] as const) if (has(MAIN_PART[f])) return f;
  // A main part with another name: the package relationships say where it is.
  try {
    const main = mainPartOf(
      entryText(
        readZip(bytes, (n) => n === '_rels/.rels'),
        '_rels/.rels',
      ),
    );
    const top = main?.split('/')[0];
    if (main && has(main))
      return top === 'word' ? 'docx' : top === 'ppt' ? 'pptx' : top === 'xl' ? 'xlsx' : null;
  } catch {
    // an unreadable relationships part leaves the format unknown
  }
  return null;
}

const MAIN_PART: Record<'docx' | 'pptx' | 'xlsx', string> = {
  docx: 'word/document.xml',
  pptx: 'ppt/presentation.xml',
  xlsx: 'xl/workbook.xml',
};

/** Every entry name, without inflating anything. */
function listZipNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  readZip(bytes, (n) => {
    names.push(n);
    return false;
  });
  return names;
}

/** Read a document's text and tables. Throws `validation` for an unknown or damaged file. */
export function extractDocument(
  bytes: Uint8Array,
  hint?: { mime?: string | null; name?: string | null },
): ExtractedDocument {
  if (bytes.length > MAX_DOCUMENT_BYTES)
    throw new NovaError('validation', 'the file is larger than 25 MB');
  const format = detectFormat(bytes, hint);
  switch (format) {
    case 'docx':
      return readDocx(bytes);
    case 'pptx':
      return readPptx(bytes);
    case 'xlsx':
      return readXlsx(bytes);
    case 'pdf':
      return readPdf(bytes);
    case null:
      throw new NovaError(
        'validation',
        'not a document Nova can read: DOCX, PPTX, XLSX and PDF files are supported',
      );
  }
}

const cellText = (s: string) => s.replace(/[\t\r\n]+/g, ' ');

/** The document as text for the model: Markdown-like structure, tables as TSV. */
export function documentText(
  doc: ExtractedDocument,
  maxChars: number,
): { text: string; truncated: boolean } {
  const out: string[] = [];
  if (doc.title) out.push(`Title: ${doc.title}`);
  for (const b of doc.blocks ?? []) {
    if (b.type === 'heading') out.push(`${'#'.repeat(Math.min(6, b.level))} ${b.text}`);
    else if (b.type === 'paragraph') out.push(b.text);
    else if (b.type === 'list')
      out.push(b.items.map((t, i) => `${b.ordered ? `${i + 1}.` : '-'} ${t}`).join('\n'));
    else out.push(b.rows.map((r) => r.map(cellText).join('\t')).join('\n'));
  }
  for (const s of doc.slides ?? []) {
    const lines = [`## Slide ${s.index}${s.title ? `: ${s.title}` : ''}`];
    for (const p of s.paragraphs) lines.push(`${'  '.repeat(p.level)}- ${p.text}`);
    if (s.notes) lines.push(`Notes: ${s.notes}`);
    out.push(lines.join('\n'));
  }
  for (const s of doc.sheets ?? []) {
    const cols = Math.max(0, ...s.rows.map((r) => r.length));
    out.push(
      `## Sheet: ${s.name} (${s.rows.length} rows, ${cols} columns${s.truncated ? ', cut at the reading limit' : ''})\n` +
        s.rows.map((r) => r.map(cellText).join('\t')).join('\n'),
    );
  }
  for (const p of doc.pages ?? []) out.push(`## Page ${p.index}\n${p.text}`);
  if (doc.note) out.push(`(${doc.note})`);
  const text = out.join('\n\n');
  if (text.length <= maxChars) return { text, truncated: doc.truncated };
  const shown = text.slice(0, Math.max(0, maxChars - 80));
  return {
    text: `${shown}\n[... ${text.length - shown.length} more characters not shown ...]`,
    truncated: true,
  };
}

export interface PreviewLimits {
  /** Characters of text across blocks, slides or pages. */
  maxChars: number;
  maxRows: number;
  maxCols: number;
}

export const PREVIEW_LIMITS: PreviewLimits = { maxChars: 200_000, maxRows: 500, maxCols: 50 };

/** A copy of the document small enough for the artifact preview. */
export function trimForPreview(
  doc: ExtractedDocument,
  limits: PreviewLimits = PREVIEW_LIMITS,
): ExtractedDocument {
  let budget = limits.maxChars;
  let truncated = doc.truncated;
  const take = (s: string) => {
    if (budget <= 0) {
      truncated = true;
      return null;
    }
    const t = s.length > budget ? `${s.slice(0, budget)}…` : s;
    if (s.length > budget) truncated = true;
    budget -= t.length;
    return t;
  };
  const out: ExtractedDocument = { ...doc };
  if (doc.blocks) {
    out.blocks = [];
    for (const b of doc.blocks) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      if (b.type === 'table') {
        const rows = b.rows
          .slice(0, limits.maxRows)
          .map((r) => r.slice(0, limits.maxCols).map((c) => take(c) ?? ''));
        if (rows.length < b.rows.length) truncated = true;
        out.blocks.push({ type: 'table', rows });
      } else if (b.type === 'list') {
        out.blocks.push({ ...b, items: b.items.map((t) => take(t) ?? '') });
      } else {
        const t = take(b.text);
        if (t !== null) out.blocks.push({ ...b, text: t });
      }
    }
  }
  if (doc.slides)
    out.slides = doc.slides.map((s) => ({
      ...s,
      paragraphs: s.paragraphs.map((p) => ({ ...p, text: take(p.text) ?? '' })),
      notes: s.notes === null ? null : take(s.notes),
    }));
  if (doc.sheets)
    out.sheets = doc.sheets.map((s) => {
      const cut = s.rows.length > limits.maxRows || s.rows.some((r) => r.length > limits.maxCols);
      return {
        name: s.name,
        rows: s.rows.slice(0, limits.maxRows).map((r) => r.slice(0, limits.maxCols)),
        truncated: s.truncated || cut,
      };
    });
  if (doc.pages) out.pages = doc.pages.map((p) => ({ index: p.index, text: take(p.text) ?? '' }));
  out.truncated = truncated || (out.sheets?.some((s) => s.truncated) ?? false);
  return out;
}

/** The media type of a document format. */
export function documentMime(format: DocumentFormat): string {
  return DOCUMENT_MIME[format];
}
