// Building a document file from validated content (FR-219), and the preview of a document
// artifact the Hub serves (GET /artifacts/:id/preview). Generation is pure data-to-file work in
// this process: no code runs, nothing is fetched and nothing outside the content is read.
import { NovaError } from '@nova/shared';
import type { ArtifactService } from '../tools/artifacts.ts';
import {
  DOCUMENT_MIME,
  formatOfMime,
  type DocumentContent,
  type DocumentFormat,
} from './content.ts';
import { writeDocx, type DocumentMeta } from './docx.ts';
import { extractDocument, formatOfName, trimForPreview } from './extract.ts';
import { writePdf } from './pdf.ts';
import { writePptx } from './pptx.ts';
import type { ExtractedDocument } from './types.ts';
import { writeXlsx } from './xlsx.ts';

export interface BuiltDocument {
  format: DocumentFormat;
  bytes: Uint8Array;
  mime: string;
  /** Plain-words notes about the output (characters a PDF font could not show). */
  notes: string[];
}

/** Write the file for validated content (parseDocumentContent). */
export function buildDocument(doc: DocumentContent, meta: DocumentMeta): BuiltDocument {
  const notes: string[] = [];
  let bytes: Uint8Array;
  switch (doc.format) {
    case 'docx':
      bytes = writeDocx(doc.content, meta);
      break;
    case 'pptx':
      bytes = writePptx(doc.content, meta);
      break;
    case 'xlsx':
      bytes = writeXlsx(doc.content, meta);
      break;
    case 'pdf': {
      const r = writePdf(doc.content, meta);
      bytes = r.bytes;
      if (r.replaced)
        notes.push(
          `${r.replaced} character${r.replaced === 1 ? '' : 's'} outside the PDF's standard font (Western European text) ${r.replaced === 1 ? 'was' : 'were'} printed as "?". Use DOCX for other scripts.`,
        );
      break;
    }
  }
  return { format: doc.format, bytes, mime: DOCUMENT_MIME[doc.format], notes };
}

/** The document format of an artifact, from its kind and media type (or title), or null. */
export function artifactDocumentFormat(a: {
  kind: string;
  mime: string | null;
  title: string | null;
}): DocumentFormat | null {
  if (a.kind === 'pdf') return 'pdf';
  if (a.kind !== 'file') return null;
  const f = formatOfMime(a.mime) ?? formatOfName(a.title);
  return f === 'pdf' ? null : f;
}

/**
 * The text and tables of a document artifact, trimmed for the preview pane. Throws `not_found`
 * for another account's artifact and `validation` for one that is not a document.
 */
export async function artifactDocumentPreview(
  artifacts: ArtifactService,
  accountId: string,
  id: string,
  version?: number,
): Promise<ExtractedDocument> {
  const { view, mime, bytes } = await artifacts.content(accountId, id, version);
  const format = artifactDocumentFormat({ kind: view.kind, mime, title: view.title });
  if (!format) throw new NovaError('validation', 'this artifact is not a document with a preview');
  return trimForPreview(extractDocument(bytes, { mime, name: view.title }));
}
