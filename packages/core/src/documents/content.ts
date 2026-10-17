// The structured content `document.create` accepts per format (FR-219), validated with zod, and
// the JSON Schema the model sees. Documents are built from data, never from code: a writer turns
// this content into a file with no script, macro or external reference in it.
import { z } from 'zod';
import { NovaError } from '@nova/shared';

export const DOCUMENT_FORMATS = ['docx', 'pptx', 'xlsx', 'pdf'] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const DOCUMENT_MIME: Record<DocumentFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/** The format a media type names, or null. */
export function formatOfMime(mime: string | null | undefined): DocumentFormat | null {
  const m = mime?.split(';')[0]?.trim().toLowerCase();
  for (const f of DOCUMENT_FORMATS) if (DOCUMENT_MIME[f] === m) return f;
  return null;
}

const run = z.strictObject({
  text: z.string().max(20_000),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
});
export type TextRun = z.infer<typeof run>;

/** A string, or runs for mixed bold and italic text. */
const inline = z.union([z.string().max(50_000), z.array(run).min(1).max(500)]);
export type InlineText = z.infer<typeof inline>;

const cellText = z.union([z.string().max(10_000), z.number(), z.boolean()]).transform(String);

const block = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('heading'),
    level: z.number().int().min(1).max(3).default(1),
    text: z.string().min(1).max(1000),
  }),
  z.strictObject({ type: z.literal('paragraph'), text: inline }),
  z.strictObject({ type: z.literal('bullets'), items: z.array(inline).min(1).max(1000) }),
  z.strictObject({ type: z.literal('numbered'), items: z.array(inline).min(1).max(1000) }),
  z.strictObject({
    type: z.literal('table'),
    header: z.array(cellText).min(1).max(30).optional(),
    rows: z.array(z.array(cellText).max(30)).max(5000),
  }),
]);
export type DocBlock = z.infer<typeof block>;

const pageSize = z.enum(['a4', 'letter']).default('a4');
export type PageSize = z.infer<typeof pageSize>;

export const docxContentSchema = z.strictObject({
  blocks: z.array(block).min(1).max(10_000),
  pageSize,
});
export type DocxContent = z.infer<typeof docxContentSchema>;

export const pdfContentSchema = docxContentSchema;
export type PdfContent = DocxContent;

const bullet = z.union([
  z.string().max(5000),
  z.strictObject({ text: z.string().max(5000), level: z.number().int().min(0).max(4).default(0) }),
]);

export const pptxContentSchema = z.strictObject({
  slides: z
    .array(
      z.strictObject({
        title: z.string().max(500),
        subtitle: z.string().max(1000).optional(),
        bullets: z.array(bullet).max(40).optional(),
        notes: z.string().max(50_000).optional(),
      }),
    )
    .min(1)
    .max(300),
});
export type PptxContent = z.infer<typeof pptxContentSchema>;

/** `YYYY-MM-DD`, optionally with `THH:MM[:SS]` and an ignored zone; kept as written. */
const DATE_TEXT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const dateCell = z.strictObject({ date: z.string().max(40) }).superRefine((v, ctx) => {
  if (!parseDateText(v.date))
    ctx.addIssue({
      code: 'custom',
      message: 'expected a date like 2026-10-17 or 2026-10-17T09:30',
    });
});

const cell = z.union([z.string().max(32_767), z.number(), z.boolean(), z.null(), dateCell]);
export type SheetCell = z.infer<typeof cell>;

const SHEET_NAME = /^[^[\]:*?/\\]{1,31}$/;

export const xlsxContentSchema = z
  .strictObject({
    sheets: z
      .array(
        z.strictObject({
          name: z
            .string()
            .regex(SHEET_NAME, 'sheet names are 1 to 31 characters without [ ] : * ? / \\')
            .refine((s) => !s.startsWith("'") && !s.endsWith("'"), 'no apostrophe at either end'),
          columns: z
            .array(
              z.strictObject({
                header: z.string().max(255),
                width: z.number().min(1).max(255).optional(),
              }),
            )
            .max(1000)
            .optional(),
          rows: z.array(z.array(cell).max(1000)).max(100_000),
        }),
      )
      .min(1)
      .max(50),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    let cells = 0;
    v.sheets.forEach((s, i) => {
      const key = s.name.toLowerCase();
      if (seen.has(key))
        ctx.addIssue({
          code: 'custom',
          path: ['sheets', i, 'name'],
          message: 'duplicate sheet name',
        });
      seen.add(key);
      for (const r of s.rows) cells += r.length;
    });
    if (cells > 500_000)
      ctx.addIssue({ code: 'custom', path: ['sheets'], message: 'more than 500,000 cells' });
  });
export type XlsxContent = z.infer<typeof xlsxContentSchema>;

export interface DateParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  hasTime: boolean;
}

/** The parts of a date cell's text, or null when it is not a real date. */
export function parseDateText(s: string): DateParts | null {
  const m = DATE_TEXT.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, hh, mi, ss] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) =>
    x === undefined ? 0 : Number(x),
  ) as [number, number, number, number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d, hh, mi, ss));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  if (hh > 23 || mi > 59 || ss > 59 || y < 1900 || y > 9999) return null;
  return { y, m: mo, d, hh, mm: mi, ss, hasTime: m[4] !== undefined };
}

export type DocumentContent =
  | { format: 'docx'; content: DocxContent }
  | { format: 'pptx'; content: PptxContent }
  | { format: 'xlsx'; content: XlsxContent }
  | { format: 'pdf'; content: PdfContent };

const SCHEMAS = {
  docx: docxContentSchema,
  pptx: pptxContentSchema,
  xlsx: xlsxContentSchema,
  pdf: pdfContentSchema,
} as const;

function issuePath(path: readonly PropertyKey[]): string {
  let out = 'content';
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : `.${String(p)}`;
  return out;
}

/** Validate content for a format; throws `validation` naming the first problems. */
export function parseDocumentContent(format: DocumentFormat, content: unknown): DocumentContent {
  const r = SCHEMAS[format].safeParse(content);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => `${issuePath(i.path)}: ${i.message}`);
    throw new NovaError('validation', `the ${format} content is not valid: ${issues.join('; ')}`, {
      details: { issues },
    });
  }
  return { format, content: r.data } as DocumentContent;
}

/** Plain text of inline content. */
export function inlinePlain(t: InlineText): string {
  return typeof t === 'string' ? t : t.map((r) => r.text).join('');
}

/** Inline content as runs. */
export function inlineRuns(t: InlineText): TextRun[] {
  return typeof t === 'string' ? [{ text: t }] : t;
}

// ---- the JSON Schema the model sees (kept short: the zod schemas are the authority) ------------

const RUNS = {
  description: 'Plain text, or runs [{text, bold?, italic?}] for mixed formatting.',
  anyOf: [
    { type: 'string' },
    {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          bold: { type: 'boolean' },
          italic: { type: 'boolean' },
        },
        required: ['text'],
      },
    },
  ],
};

const BLOCKS = {
  type: 'array',
  description:
    'Blocks in order: {type:"heading", level 1-3, text}, {type:"paragraph", text}, {type:"bullets", items}, {type:"numbered", items}, {type:"table", header?, rows (arrays of cell text)}.',
  items: {
    type: 'object',
    properties: {
      type: { enum: ['heading', 'paragraph', 'bullets', 'numbered', 'table'] },
      level: { type: 'integer', minimum: 1, maximum: 3 },
      text: RUNS,
      items: { type: 'array', items: RUNS },
      header: { type: 'array', items: { type: 'string' } },
      rows: { type: 'array', items: { type: 'array' } },
    },
    required: ['type'],
  },
};

export const DOCUMENT_CONTENT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description:
    'docx and pdf: {blocks, pageSize?: "a4"|"letter"}. pptx: {slides: [{title, subtitle?, bullets? (strings or {text, level 0-4}), notes?}]}. xlsx: {sheets: [{name, columns?: [{header, width?}], rows: [[cell]]}]} where a cell is a string, number, boolean, null or {date: "YYYY-MM-DD[THH:MM[:SS]]"}.',
  properties: {
    blocks: BLOCKS,
    pageSize: { enum: ['a4', 'letter'] },
    slides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          bullets: { type: 'array' },
          notes: { type: 'string' },
        },
        required: ['title'],
      },
    },
    sheets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          columns: { type: 'array' },
          rows: { type: 'array', items: { type: 'array' } },
        },
        required: ['name', 'rows'],
      },
    },
  },
};
