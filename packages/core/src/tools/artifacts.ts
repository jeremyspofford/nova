// Artifacts (FR-038): structured outputs shown in the artifacts pane: Markdown, code with its
// language, HTML, SVG, images, chart specs, PDFs and other files. Each artifact is versioned;
// creating one with the id of an existing artifact adds a version. Bytes are stored as blobs
// through the attachment blob store (which encrypts at rest, ADR-090).
import { and, asc, desc, eq } from 'drizzle-orm';
import { NovaError, uuidv7, type ArtifactKind, type ArtifactView } from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';
import { readAttachmentBlob, writeAttachmentBlob } from '../attachments.ts';
import type { EventSink } from '../events.ts';
import { argsOf, builtinDescriptor, extrasOf, fail, ok, str, type BuiltinTool } from './builtin.ts';

const { artifact, artifactVersion } = schema;

export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export const ARTIFACT_KINDS = [
  'markdown',
  'code',
  'html',
  'svg',
  'image',
  'chart',
  'pdf',
  'file',
] as const satisfies readonly ArtifactKind[];

const IMAGE_MIMES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
};

export interface CreateArtifactInput {
  accountId: string;
  threadId: string | null;
  messageId: string | null;
  turnId?: string | null;
  kind: ArtifactKind;
  title: string | null;
  content: string;
  encoding?: 'utf8' | 'base64';
  language?: string | null;
  mime?: string | null;
  /** Add a version to this artifact instead of creating one. */
  artifactId?: string | null;
}

type ArtifactRow = typeof artifact.$inferSelect;

export interface ArtifactServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  dataDir: string;
  now?: () => Date;
}

export class ArtifactService {
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  readonly #dataDir: string;
  readonly #now: () => Date;

  constructor(opts: ArtifactServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#dataDir = opts.dataDir;
    this.#now = opts.now ?? (() => new Date());
  }

  /** Create an artifact, or add a version to an existing one. Throws `validation`. */
  async save(input: CreateArtifactInput): Promise<ArtifactView> {
    const { bytes, mime } = encode(input);
    const blob = writeAttachmentBlob(this.#dataDir, bytes);
    const now = this.#now().toISOString();
    const meta = JSON.stringify({ language: input.language ?? null, size: bytes.length });
    let row: ArtifactRow;
    let created: boolean;
    if (input.artifactId) {
      const prev = await this.#row(input.accountId, input.artifactId);
      if (prev.threadId !== input.threadId)
        throw new NovaError('validation', 'that artifact belongs to another chat');
      if (prev.kind !== input.kind)
        throw new NovaError(
          'validation',
          `that artifact is ${prev.kind}; a new version must keep its kind`,
        );
      const version = prev.version + 1;
      await this.#db.transaction(async () => {
        await this.#db.orm
          .update(artifact)
          .set({
            title: input.title ?? prev.title,
            blobPath: blob.blobPath,
            mime,
            sha256: blob.sha256,
            version,
            metaJson: meta,
            messageId: input.messageId ?? prev.messageId,
            updatedAt: now,
          })
          .where(eq(artifact.id, prev.id));
        await this.#db.orm.insert(artifactVersion).values({
          artifactId: prev.id,
          version,
          messageId: input.messageId,
          blobPath: blob.blobPath,
          mime,
          sha256: blob.sha256,
          size: bytes.length,
          createdAt: now,
        });
      });
      row = await this.#row(input.accountId, prev.id);
      created = false;
    } else {
      const id = uuidv7();
      await this.#db.transaction(async () => {
        await this.#db.orm.insert(artifact).values({
          id,
          accountId: input.accountId,
          threadId: input.threadId,
          messageId: input.messageId,
          kind: input.kind,
          title: input.title,
          blobPath: blob.blobPath,
          mime,
          sha256: blob.sha256,
          version: 1,
          metaJson: meta,
          createdAt: now,
          updatedAt: now,
        });
        await this.#db.orm.insert(artifactVersion).values({
          artifactId: id,
          version: 1,
          messageId: input.messageId,
          blobPath: blob.blobPath,
          mime,
          sha256: blob.sha256,
          size: bytes.length,
          createdAt: now,
        });
      });
      row = await this.#row(input.accountId, id);
      created = true;
    }
    const e: { threadId?: string; turnId?: string } = {};
    if (row.threadId) e.threadId = row.threadId;
    if (input.turnId) e.turnId = input.turnId;
    await this.#events.emit({
      name: created ? 'artifact.created' : 'artifact.updated',
      accountId: input.accountId,
      ...(e.threadId ? { correlation: e } : {}),
      payload: {
        artifactId: row.id,
        threadId: row.threadId,
        kind: row.kind,
        version: row.version,
      },
    });
    return toArtifactView(row);
  }

  async list(accountId: string, threadId: string): Promise<ArtifactView[]> {
    const rows = await this.#db.orm
      .select()
      .from(artifact)
      .where(and(eq(artifact.accountId, accountId), eq(artifact.threadId, threadId)))
      .orderBy(asc(artifact.createdAt), asc(artifact.id));
    return rows.map(toArtifactView);
  }

  async get(accountId: string, id: string): Promise<ArtifactView> {
    return toArtifactView(await this.#row(accountId, id));
  }

  /** The bytes of the current version, or of `version`. */
  async content(
    accountId: string,
    id: string,
    version?: number,
  ): Promise<{ view: ArtifactView; mime: string; bytes: Buffer }> {
    const row = await this.#row(accountId, id);
    let blobPath = row.blobPath;
    let mime = row.mime ?? 'application/octet-stream';
    if (version !== undefined && version !== row.version) {
      const v = await this.#db.orm
        .select()
        .from(artifactVersion)
        .where(and(eq(artifactVersion.artifactId, id), eq(artifactVersion.version, version)))
        .limit(1);
      if (!v[0]) throw new NovaError('not_found', `version ${version} does not exist`);
      blobPath = v[0].blobPath;
      mime = v[0].mime;
    }
    if (!blobPath) throw new NovaError('not_found', 'the artifact has no content');
    return { view: toArtifactView(row), mime, bytes: readAttachmentBlob(this.#dataDir, blobPath) };
  }

  /** Newest artifacts of a thread first (mentions, diagnostics). */
  async latest(accountId: string, threadId: string, limit = 20): Promise<ArtifactView[]> {
    const rows = await this.#db.orm
      .select()
      .from(artifact)
      .where(and(eq(artifact.accountId, accountId), eq(artifact.threadId, threadId)))
      .orderBy(desc(artifact.updatedAt))
      .limit(limit);
    return rows.map(toArtifactView);
  }

  async #row(accountId: string, id: string): Promise<ArtifactRow> {
    const rows = await this.#db.orm
      .select()
      .from(artifact)
      .where(and(eq(artifact.id, id), eq(artifact.accountId, accountId)))
      .limit(1);
    const r = rows[0];
    if (!r) throw new NovaError('not_found', 'artifact not found');
    return r;
  }
}

export function toArtifactView(r: ArtifactRow): ArtifactView {
  let language: string | null = null;
  let size = 0;
  try {
    const meta = JSON.parse(r.metaJson ?? '{}') as { language?: unknown; size?: unknown };
    if (typeof meta.language === 'string') language = meta.language;
    if (typeof meta.size === 'number') size = meta.size;
  } catch {
    // keep the defaults
  }
  return {
    id: r.id,
    threadId: r.threadId,
    messageId: r.messageId,
    kind: r.kind as ArtifactKind,
    title: r.title,
    mime: r.mime ?? 'application/octet-stream',
    language,
    version: r.version,
    live: r.live,
    size,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Validate an artifact's content for its kind and return its bytes and media type. */
function encode(input: CreateArtifactInput): { bytes: Buffer; mime: string } {
  const binary = input.kind === 'image' || input.kind === 'pdf';
  const base64 = input.encoding === 'base64' || binary;
  let bytes: Buffer;
  if (base64) {
    const data = input.content.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0)
      throw new NovaError('validation', 'the content is not valid base64');
    bytes = Buffer.from(data, 'base64');
  } else bytes = Buffer.from(input.content, 'utf8');
  if (!bytes.length) throw new NovaError('validation', 'the artifact is empty');
  if (bytes.length > MAX_ARTIFACT_BYTES)
    throw new NovaError('validation', 'the artifact is larger than 5 MiB');
  switch (input.kind) {
    case 'markdown':
      return { bytes, mime: 'text/markdown; charset=utf-8' };
    case 'code':
      return { bytes, mime: 'text/plain; charset=utf-8' };
    case 'html':
      return { bytes, mime: 'text/html; charset=utf-8' };
    case 'svg':
      if (!/<svg[\s>]/i.test(bytes.subarray(0, 4096).toString('utf8')))
        throw new NovaError('validation', 'an SVG artifact must contain an <svg> element');
      return { bytes, mime: 'image/svg+xml' };
    case 'chart':
      try {
        const spec = JSON.parse(bytes.toString('utf8')) as unknown;
        if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) throw new Error();
      } catch {
        throw new NovaError('validation', 'a chart artifact is a JSON object (the chart spec)');
      }
      return { bytes, mime: 'application/json' };
    case 'image': {
      const mime = Object.keys(IMAGE_MIMES).find((m) => IMAGE_MIMES[m]!(bytes));
      if (!mime) throw new NovaError('validation', 'images must be PNG, JPEG, GIF or WebP');
      return { bytes, mime };
    }
    case 'pdf':
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
        throw new NovaError('validation', 'the content is not a PDF');
      return { bytes, mime: 'application/pdf' };
    default: {
      const mime = input.mime?.split(';')[0]?.trim().toLowerCase();
      const safe = mime && /^[a-z]+\/[a-z0-9.+-]+$/.test(mime) ? mime : null;
      return { bytes, mime: safe ?? (base64 ? 'application/octet-stream' : 'text/plain') };
    }
  }
}

/** The `artifact.create` tool (FR-038). */
export function artifactTool(service: ArtifactService): BuiltinTool {
  return {
    descriptor: builtinDescriptor({
      name: 'artifact.create',
      title: 'Create an artifact',
      description:
        'Show a document, code file, HTML page, SVG, image, chart spec (a JSON object), PDF or file in the artifacts pane. Images and PDFs are base64. Pass artifactId to save a new version of an artifact you created earlier.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { enum: [...ARTIFACT_KINDS] },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          content: { type: 'string', minLength: 1, maxLength: 7 * 1024 * 1024 },
          language: { type: 'string', maxLength: 40 },
          mime: { type: 'string', maxLength: 100 },
          encoding: { enum: ['utf8', 'base64'] },
          artifactId: { type: 'string', maxLength: 100 },
        },
        required: ['kind', 'title', 'content'],
        additionalProperties: false,
      },
      annotations: { action: 'write' },
      timeoutMs: 30_000,
    }),
    origin: null,
    handler: async (args, ctx) => {
      const a = argsOf(args);
      try {
        const encoding = a.encoding === 'base64' ? 'base64' : 'utf8';
        const view = await service.save({
          accountId: ctx.accountId,
          threadId: ctx.threadId || null,
          messageId: extrasOf(ctx)?.messageId ?? null,
          turnId: ctx.turnId || null,
          kind: a.kind as ArtifactKind,
          title: str(a.title) ?? null,
          content: str(a.content) ?? '',
          encoding,
          language: str(a.language) ?? null,
          mime: str(a.mime) ?? null,
          artifactId: str(a.artifactId) ?? null,
        });
        const verb = view.version > 1 ? `Saved version ${view.version} of` : 'Created';
        return ok(`${verb} the ${view.kind} artifact "${view.title ?? view.id}" (id ${view.id}).`, {
          artifact: { id: view.id, kind: view.kind, title: view.title, version: view.version },
        });
      } catch (err) {
        if (err instanceof NovaError) return fail(err.code, err.message);
        throw err;
      }
    },
  };
}
