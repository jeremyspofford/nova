// Document tools (FR-219): `document.create` writes a DOCX, PPTX, XLSX or PDF file from
// structured content and saves it as an artifact with a preview; `document.read` returns the text
// and tables of such a file from the turn's folders or from an artifact.
//
// Generation runs in the Hub process, not through exec.run in the sandbox (docs/08 §1.1 names
// that path): it turns validated data into a file with dependency-free writers, runs no code and
// imports no network module, so the sandbox's two guarantees (no code execution against the host,
// no network) hold by construction. Read results are file content, so they carry the `file` taint.
import { readFileSync, statSync } from 'node:fs';
import { NovaError, type ArtifactKind } from '@nova/shared';
import { buildDocument } from '../documents/build.ts';
import {
  DOCUMENT_CONTENT_JSON_SCHEMA,
  DOCUMENT_FORMATS,
  parseDocumentContent,
  type DocumentFormat,
} from '../documents/content.ts';
import { MAX_DOCUMENT_BYTES, documentText, extractDocument } from '../documents/extract.ts';
import type { ExtractedDocument } from '../documents/types.ts';
import type { ArtifactService } from './artifacts.ts';
import { argsOf, builtinDescriptor, extrasOf, fail, ok, str, type BuiltinTool } from './builtin.ts';
import { withDeny } from './fs.ts';
import { PathDenied, displayPath, resolveInRoots, type PathPolicy } from './roots.ts';
import { CHARS_PER_TOKEN, DEFAULT_OUTPUT_TOKENS } from './text.ts';
import type { GateRequest, ToolContext } from './types.ts';

/** Characters of document text returned to the model per read. */
export const MAX_DOCUMENT_CHARS = DEFAULT_OUTPUT_TOKENS * CHARS_PER_TOKEN;

const FORMAT_LABEL: Record<DocumentFormat, string> = {
  docx: 'DOCX document',
  pptx: 'PPTX presentation',
  xlsx: 'XLSX workbook',
  pdf: 'PDF',
};

export interface DocumentToolOptions {
  artifacts: ArtifactService;
  /** Directories no tool may touch even inside a root (the Nova data folder). */
  paths?: PathPolicy;
  now?: () => Date;
}

/** `Report` → `Report.docx`; a title that already ends with the extension is kept. */
export function documentFileName(title: string, format: DocumentFormat): string {
  const t = title.trim();
  return t.toLowerCase().endsWith(`.${format}`) ? t : `${t}.${format}`;
}

function summary(doc: ExtractedDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {
    format: doc.format,
    title: doc.title,
    readable: doc.readable,
  };
  if (doc.pages) out.pages = doc.pages.length;
  if (doc.slides) out.slides = doc.slides.length;
  if (doc.sheets) out.sheets = doc.sheets.map((s) => s.name);
  return out;
}

export function documentTools(opts: DocumentToolOptions): BuiltinTool[] {
  const now = opts.now ?? (() => new Date());
  const base = opts.paths ?? {};
  const resolve = (ctx: ToolContext, p: string) =>
    resolveInRoots(ctx.roots, p, 'read', withDeny(base, ctx));

  const create: BuiltinTool = {
    descriptor: builtinDescriptor({
      name: 'document.create',
      title: 'Create a document',
      description:
        'Create a DOCX document, PPTX presentation, XLSX workbook or PDF from structured content and show it in the artifacts pane with a preview and a download. Pass artifactId to save a new version of a document you created earlier.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { enum: [...DOCUMENT_FORMATS] },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          content: DOCUMENT_CONTENT_JSON_SCHEMA,
          artifactId: { type: 'string', maxLength: 100 },
        },
        required: ['kind', 'title', 'content'],
        additionalProperties: false,
      },
      annotations: { action: 'write' },
      timeoutMs: 60_000,
    }),
    origin: null,
    handler: async (args, ctx) => {
      const a = argsOf(args);
      try {
        const format = a.kind as DocumentFormat;
        if (!DOCUMENT_FORMATS.includes(format))
          return fail('validation', 'kind must be docx, pptx, xlsx or pdf');
        const title = documentFileName(str(a.title) ?? 'Document', format);
        const doc = parseDocumentContent(format, a.content);
        const built = buildDocument(doc, {
          title: title.replace(/\.[a-z]+$/i, ''),
          created: now(),
        });
        const kind: ArtifactKind = format === 'pdf' ? 'pdf' : 'file';
        const view = await opts.artifacts.save({
          accountId: ctx.accountId,
          threadId: ctx.threadId || null,
          messageId: extrasOf(ctx)?.messageId ?? null,
          turnId: ctx.turnId || null,
          kind,
          title,
          content: Buffer.from(built.bytes).toString('base64'),
          encoding: 'base64',
          mime: built.mime,
          artifactId: str(a.artifactId) ?? null,
        });
        const verb = view.version > 1 ? `Saved version ${view.version} of` : 'Created';
        const notes = built.notes.length ? ` ${built.notes.join(' ')}` : '';
        return ok(
          `${verb} the ${FORMAT_LABEL[format]} "${view.title ?? title}" (artifact id ${view.id}, ${built.bytes.length} bytes).${notes}`,
          {
            artifact: { id: view.id, kind: view.kind, title: view.title, version: view.version },
            format,
            mime: built.mime,
            size: built.bytes.length,
          },
        );
      } catch (err) {
        if (err instanceof NovaError) return fail(err.code, err.message, err.details);
        throw err;
      }
    },
  };

  const read: BuiltinTool = {
    descriptor: builtinDescriptor({
      name: 'document.read',
      title: 'Read a document',
      description:
        'Read the text of a DOCX, PPTX, XLSX or PDF file: headings, paragraphs and lists, slides with their notes, sheets as tab-separated rows, or PDF pages. Give a path in your folders or the id of an artifact.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 4096 },
          artifactId: { type: 'string', minLength: 1, maxLength: 100 },
        },
        additionalProperties: false,
      },
      annotations: { readOnly: true, idempotent: true, action: 'read' },
      timeoutMs: 60_000,
    }),
    origin: 'file',
    resource: (args, ctx): GateRequest['resource'] | undefined => {
      const p = str(argsOf(args).path);
      if (p === undefined) return undefined;
      try {
        return { kind: 'path', value: resolve(ctx, p).path };
      } catch {
        return { kind: 'path', value: p };
      }
    },
    handler: async (args, ctx) => {
      const a = argsOf(args);
      const path = str(a.path);
      const artifactId = str(a.artifactId);
      if ((path === undefined) === (artifactId === undefined))
        return fail('validation', 'give either path or artifactId');
      try {
        let doc: ExtractedDocument;
        let source: string;
        if (path !== undefined) {
          const p = resolve(ctx, path);
          const st = statSync(p.path);
          if (st.isDirectory())
            return fail('is_directory', `${displayPath(ctx.roots, p)} is a folder`);
          if (st.size > MAX_DOCUMENT_BYTES)
            return fail('too_large', `${displayPath(ctx.roots, p)} is larger than 25 MB`);
          doc = extractDocument(readFileSync(p.path), { name: p.path });
          source = displayPath(ctx.roots, p);
        } else {
          const { view, mime, bytes } = await opts.artifacts.content(ctx.accountId, artifactId!);
          doc = extractDocument(bytes, { mime, name: view.title });
          source = `artifact ${view.title ?? view.id}`;
        }
        const { text, truncated } = documentText(doc, MAX_DOCUMENT_CHARS);
        const head = `${FORMAT_LABEL[doc.format]} ${source}${doc.readable ? '' : ' (no readable text)'}`;
        return ok(`${head}\n\n${text}`, { ...summary(doc), truncated });
      } catch (err) {
        if (err instanceof PathDenied) return fail('path_denied', err.message);
        if (err instanceof NovaError) return fail(err.code, err.message);
        const code = (err as { code?: unknown }).code;
        if (code === 'ENOENT') return fail('not_found', 'no such file');
        if (code === 'EACCES' || code === 'EPERM')
          return fail('permission_denied', 'permission denied');
        throw err;
      }
    },
  };

  return [create, read];
}
