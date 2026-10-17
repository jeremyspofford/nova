// document.create and document.read through the tool runtime (FR-219, FR-038): a model call
// saves a document artifact with an artifact part in the reply, the UI path passes the same gate,
// reads come from artifacts or from files inside the turn's roots (and nowhere else), and the
// preview the Hub serves is built from the artifact's bytes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactDocumentPreview,
  documentFileName,
  documentTools,
  parseDocumentContent,
  readDocx,
  readPdf,
  writeDocx,
} from '../src/documents/index.ts';
import type { BuiltinTool } from '../src/index.ts';
import { ACCOUNT, makeToolEnv, type ToolEnv } from './helpers.ts';

const NOW = new Date('2026-10-17T09:30:00Z');

let env: ToolEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

async function setup(): Promise<ToolEnv> {
  let tools: BuiltinTool[] = [];
  const e = await makeToolEnv({
    sources: [{ source: 'builtin', list: () => Promise.resolve(tools) }],
  });
  const dataDir = dirname(e.workspace);
  tools = documentTools({
    artifacts: e.artifacts,
    paths: { denied: [dataDir], allowed: [e.workspace] },
    now: () => NOW,
  });
  return e;
}

async function call(e: ToolEnv, name: string, args: unknown, threadId?: string) {
  const { done } = await e.runtime.invoke({
    accountId: ACCOUNT,
    name,
    args,
    threadId: threadId ?? null,
    initiator: 'user',
  });
  return done;
}

const DOCX = {
  kind: 'docx',
  title: 'Report',
  content: {
    blocks: [
      { type: 'heading', text: 'Hello' },
      { type: 'paragraph', text: 'Body text.' },
    ],
  },
};

describe('document.create (FR-219)', () => {
  it('saves a DOCX artifact from a model call, with an artifact part in the reply', async () => {
    env = await setup();
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: `/tool document.create ${JSON.stringify(DOCX)}` });
    await env.chat.idle();
    const detail = await env.threads.detail(ACCOUNT, t.id);
    const reply = detail.messages[1]!;
    expect(reply.parts.find((p) => p.type === 'artifact')).toMatchObject({
      type: 'artifact',
      kind: 'file',
      title: 'Report.docx',
    });
    const [art] = await env.artifacts.list(ACCOUNT, t.id);
    expect(art).toMatchObject({
      kind: 'file',
      title: 'Report.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      messageId: reply.id,
    });
    const { bytes } = await env.artifacts.content(ACCOUNT, art!.id);
    expect(readDocx(bytes)).toMatchObject({
      title: 'Report',
      blocks: [
        { type: 'heading', level: 1, text: 'Hello' },
        { type: 'paragraph', text: 'Body text.' },
      ],
    });
    expect(env.events.events.some((e) => e.name === 'artifact.created')).toBe(true);
    expect(env.audit.find((a) => a.action === 'document.create')).toMatchObject({
      kind: 'tool_call',
      result: 'ok',
    });
  });

  it('saves PDFs as pdf artifacts and new versions with artifactId', async () => {
    env = await setup();
    const t = await env.threads.create(ACCOUNT, {});
    const first = await call(
      env,
      'document.create',
      { kind: 'pdf', title: 'Notes.pdf', content: { blocks: [{ type: 'paragraph', text: 'v1' }] } },
      t.id,
    );
    expect(first.ok).toBe(true);
    const [art] = await env.artifacts.list(ACCOUNT, t.id);
    expect(art).toMatchObject({ kind: 'pdf', title: 'Notes.pdf', mime: 'application/pdf' });
    expect(first.text).toContain(`Created the PDF "Notes.pdf" (artifact id ${art!.id}`);
    const second = await call(
      env,
      'document.create',
      {
        kind: 'pdf',
        title: 'Notes',
        content: { blocks: [{ type: 'paragraph', text: 'v2 Ω' }] },
        artifactId: art!.id,
      },
      t.id,
    );
    expect(second.text).toMatch(/^Saved version 2 of the PDF "Notes\.pdf".*printed as "\?"/);
    const { bytes, view } = await env.artifacts.content(ACCOUNT, art!.id);
    expect(view.version).toBe(2);
    expect(readPdf(bytes).pages![0]!.text).toContain('v2 ?');
  });

  it('refuses invalid content with the path of the problem', async () => {
    env = await setup();
    const bad = await call(env, 'document.create', {
      kind: 'xlsx',
      title: 'Book',
      content: { sheets: [{ name: 'A:B', rows: [] }] },
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(bad.error!.message).toMatch(/content\.sheets\[0\]\.name: sheet names/);
    const wrongKind = await call(env, 'document.create', { kind: 'odt', title: 'x', content: {} });
    expect(wrongKind.ok).toBe(false);
  });

  it('names files with their extension once', () => {
    expect(documentFileName(' Plan ', 'pptx')).toBe('Plan.pptx');
    expect(documentFileName('plan.PPTX', 'pptx')).toBe('plan.PPTX');
  });
});

describe('document.read (FR-219)', () => {
  it('reads an artifact by id and a file inside the roots, and nothing outside them', async () => {
    env = await setup();
    const t = await env.threads.create(ACCOUNT, {});
    await call(
      env,
      'document.create',
      {
        kind: 'pptx',
        title: 'Deck',
        content: { slides: [{ title: 'One', bullets: ['a', 'b'], notes: 'say it' }] },
      },
      t.id,
    );
    const [deck] = await env.artifacts.list(ACCOUNT, t.id);
    const byId = await call(env, 'document.read', { artifactId: deck!.id });
    expect(byId.ok).toBe(true);
    expect(byId.text).toContain('PPTX presentation artifact Deck.pptx');
    expect(byId.text).toContain('## Slide 1: One\n- a\n- b\nNotes: say it');

    const doc = parseDocumentContent('docx', { blocks: [{ type: 'paragraph', text: 'on disk' }] });
    mkdirSync(join(env.workspace, 'docs'), { recursive: true });
    writeFileSync(
      join(env.workspace, 'docs', 'memo.docx'),
      writeDocx(doc.content as never, { title: 'Memo', created: NOW }),
    );
    const byPath = await call(env, 'document.read', { path: 'docs/memo.docx' });
    expect(byPath.text).toBe('DOCX document docs/memo.docx\n\nTitle: Memo\n\non disk');

    writeFileSync(join(env.workspace, 'notes.txt'), 'plain');
    expect(await call(env, 'document.read', { path: 'notes.txt' })).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    });
    expect(await call(env, 'document.read', { path: '/etc/hostname' })).toMatchObject({
      ok: false,
      error: { code: 'path_denied' },
    });
    // The data folder holds the database and blobs; only its workspace is open to tools.
    writeFileSync(join(dirname(env.workspace), 'secret.docx'), 'x');
    expect(
      await call(env, 'document.read', { path: join(dirname(env.workspace), 'secret.docx') }),
    ).toMatchObject({ ok: false, error: { code: 'path_denied' } });
    expect(await call(env, 'document.read', { path: 'docs' })).toMatchObject({
      ok: false,
      error: { code: 'is_directory' },
    });
    expect(await call(env, 'document.read', { path: 'missing.pdf' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await call(env, 'document.read', {})).toMatchObject({
      ok: false,
      error: { code: 'validation', message: 'give either path or artifactId' },
    });
    expect(await call(env, 'document.read', { path: 'x', artifactId: deck!.id })).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    });
    expect(await call(env, 'document.read', { artifactId: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});

describe('artifact previews (FR-219, FR-038)', () => {
  it('builds previews for document artifacts only, for their owner only', async () => {
    env = await setup();
    const t = await env.threads.create(ACCOUNT, {});
    await call(
      env,
      'document.create',
      {
        kind: 'xlsx',
        title: 'Book',
        content: {
          sheets: [
            { name: 'S', columns: [{ header: 'n' }], rows: [[1], [2], [{ date: '2026-01-02' }]] },
          ],
        },
      },
      t.id,
    );
    const md = await env.artifacts.save({
      accountId: ACCOUNT,
      threadId: t.id,
      messageId: null,
      kind: 'markdown',
      title: 'Note',
      content: '# hi',
    });
    const [book] = (await env.artifacts.list(ACCOUNT, t.id)).filter((a) => a.kind === 'file');
    const preview = await artifactDocumentPreview(env.artifacts, ACCOUNT, book!.id);
    expect(preview).toMatchObject({
      format: 'xlsx',
      title: 'Book',
      sheets: [{ name: 'S', rows: [['n'], ['1'], ['2'], ['2026-01-02']], truncated: false }],
      truncated: false,
    });
    await expect(artifactDocumentPreview(env.artifacts, ACCOUNT, md.id)).rejects.toThrow(
      /not a document with a preview/,
    );
    await expect(
      artifactDocumentPreview(env.artifacts, '01920000-0000-7000-8000-0000000000ff', book!.id),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
