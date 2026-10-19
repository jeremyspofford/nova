// Telegram files (M8; FR-110, docs/13 §4) against the mock Bot API: photos, documents, voice and
// video notes are downloaded only once a message will start a turn, size-capped (the declared
// size and while reading), checked like uploads and kept as thread attachments; notes are kept
// but are not model input. The artifacts a channel turn made go back with its reply as photos or
// documents, text files redacted, and a shared group checks them first (files it cannot read
// count as private). `channel.send` sends the files it names from its own chat only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import {
  ArtifactService,
  MemoryEventSink,
  TelegramAdapter,
  artifactFileName,
  isTextLike,
  prepareNote,
  readAttachmentBlob,
  type StartTurnInput,
} from '../src/index.ts';
import { ACCOUNT, serviceEnv, type ServiceEnv } from './fixtures/channels/env.ts';
import { startMockSlack, type MockSlack } from './fixtures/channels/mock-slack.ts';
import { startMockTelegram, type MockTelegram } from './fixtures/channels/mock-telegram.ts';

let env: ServiceEnv;
let tg: MockTelegram;
let dataDir: string;

beforeEach(async () => {
  tg = await startMockTelegram();
  dataDir = mkdtempSync(join(tmpdir(), 'nova-tg-files-'));
  env = await serviceEnv({ telegramApi: tg.api, publicBase: 'https://hub.example.com', dataDir });
});

afterEach(async () => {
  await env.service.close();
  env.db.close();
  await tg.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const OWNER = 42;
const MEMBER = 43;
const STRANGER = 99;
const GROUP = -100777;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 3)]);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.alloc(40),
]);

async function setup(opts: { group?: boolean } = {}) {
  await env.service.addIdentity(ACCOUNT, {
    kind: 'telegram',
    externalId: String(OWNER),
    role: 'owner',
  });
  await env.service.addIdentity(ACCOUNT, {
    kind: 'telegram',
    externalId: String(MEMBER),
    role: 'member',
  });
  const b = await env.service.create(ACCOUNT, {
    kind: 'telegram',
    externalRef: String(OWNER),
    label: 'Jeremy on Telegram',
    audience: 'private',
    credentials: { botToken: tg.botToken },
  });
  await env.service.setEnabled(ACCOUNT, b.id, true);
  if (!opts.group) return { b, g: null };
  const g = await env.service.create(ACCOUNT, {
    kind: 'telegram',
    externalRef: String(GROUP),
    label: 'Team group',
    shareCredentialsWith: b.id,
  });
  await env.service.setEnabled(ACCOUNT, g.id, true);
  return { b, g };
}

async function deliver(bindingId: string, update: Record<string, unknown>) {
  const secret = (await env.secrets.get(`secret://channel/${bindingId}/webhookSecret`))!;
  const out = await env.service.receive(bindingId, tg.webhook(update, secret));
  if (!env.turns.hold) await env.service.idle();
  return out;
}

function attachments(threadId: string) {
  return env.db.raw
    .prepare('SELECT * FROM attachment WHERE thread_id = ? ORDER BY created_at, id')
    .all(threadId) as {
    id: string;
    name: string;
    mime: string;
    origin: string;
    blob_path: string;
  }[];
}

describe('inbound files', () => {
  it('downloads a photo (the largest size within the cap) and gives it to the turn', async () => {
    const { b } = await setup();
    const small = tg.addFile(JPEG.subarray(0, 40));
    const big = tg.addFile(JPEG);
    const huge = tg.addFile(JPEG, { size: 30 * 1024 * 1024 });
    const out = await deliver(
      b.id,
      tg.message({ chat: OWNER, from: OWNER, caption: 'what is this?', photo: [small, big, huge] }),
    );
    expect(out).toMatchObject({ status: 'started' });
    const call = env.turns.calls.at(-1)!;
    expect(call.text).toContain('what is this?');
    expect(call.attachmentIds).toHaveLength(1);
    const [stored] = attachments(call.threadId);
    expect(stored).toMatchObject({
      id: call.attachmentIds![0],
      mime: 'image/jpeg',
      origin: 'import',
    });
    expect(readAttachmentBlob(dataDir, stored!.blob_path)).toEqual(JPEG);
    expect(tg.of('getFile')).toEqual([{ file_id: big.fileId }]);
    // The log entry names the file it kept (M8).
    const [entry] = env.service.messages(ACCOUNT, b.id, { limit: 5, direction: 'in' });
    expect(entry!.file).toEqual({
      name: expect.stringMatching(/^photo-\d+\.jpg$/),
      size: JPEG.length,
      contentType: 'image/jpeg',
      direction: 'in',
      status: 'received',
      attachmentId: call.attachmentIds![0],
    });
    expect(entry!.files).toBeUndefined();
    // The bot token is in the download path only, never in what is stored or logged.
    expect(JSON.stringify(env.db.raw.prepare('SELECT * FROM channel_message').all())).not.toContain(
      tg.botToken,
    );
  });

  it('keeps documents checked like uploads, and voice and video notes without giving them to the model', async () => {
    const { b } = await setup();
    const md = tg.addFile(Buffer.from('# Notes\nbuy milk\n'));
    await deliver(
      b.id,
      tg.message({
        chat: OWNER,
        from: OWNER,
        document: { ...md, name: 'notes.md', mime: 'text/markdown' },
      }),
    );
    let call = env.turns.calls.at(-1)!;
    expect(call.attachmentIds).toHaveLength(1);
    expect(attachments(call.threadId).at(-1)).toMatchObject({
      name: 'notes.md',
      mime: 'text/markdown',
    });

    const voice = tg.addFile(OGG);
    await deliver(b.id, tg.message({ chat: OWNER, from: OWNER, voice: { ...voice, duration: 7 } }));
    call = env.turns.calls.at(-1)!;
    expect(call.attachmentIds ?? []).toEqual([]);
    expect(call.text).toMatch(/\[Voice note \(7 s\) kept with this chat's files as voice-\d+\.ogg/);
    expect(attachments(call.threadId).at(-1)).toMatchObject({
      mime: 'audio/ogg',
      origin: 'import',
    });

    const note = tg.addFile(MP4);
    await deliver(b.id, tg.message({ chat: OWNER, from: OWNER, videoNote: note }));
    call = env.turns.calls.at(-1)!;
    expect(call.text).toMatch(
      /\[Video note \(4 s\) kept with this chat's files as video-note-\d+\.mp4/,
    );
    expect(attachments(call.threadId).at(-1)).toMatchObject({ mime: 'video/mp4' });
  });

  it('refuses what is too large without downloading it, and content that is not what it claims', async () => {
    const { b } = await setup();
    const big = tg.addFile(Buffer.from('%PDF-1.7 tiny'), { size: 25 * 1024 * 1024 });
    await deliver(
      b.id,
      tg.message({
        chat: OWNER,
        from: OWNER,
        caption: 'read this',
        document: { ...big, name: 'big.pdf', mime: 'application/pdf' },
      }),
    );
    let call = env.turns.calls.at(-1)!;
    expect(call.text).toMatch(
      /Attachments not accepted: big\.pdf \(.*25\.0 MB; the limit is 20\.0 MB/,
    );
    expect(tg.of('getFile')).toEqual([]);
    expect(tg.downloads).toEqual([]);
    expect(env.service.messages(ACCOUNT, b.id, { limit: 1, direction: 'in' })[0]!.file).toEqual({
      name: 'big.pdf',
      size: 25 * 1024 * 1024,
      contentType: 'application/pdf',
      direction: 'in',
      status: 'failed',
      reason: expect.stringContaining('the limit is 20.0 MB'),
    });

    // getFile may name a size the message did not.
    const lying = tg.addFile(Buffer.from('%PDF-1.7 tiny'), { size: 21 * 1024 * 1024 });
    await deliver(
      b.id,
      tg.message({
        chat: OWNER,
        from: OWNER,
        document: { fileId: lying.fileId, name: 'l.pdf', mime: 'application/pdf' },
      }),
    );
    expect(env.turns.calls.at(-1)!.text).toMatch(/l\.pdf \(.*the limit is 20\.0 MB/);
    expect(tg.downloads).toEqual([]);

    const fakePng = tg.addFile(Buffer.from('not a png at all'));
    const fakeVoice = tg.addFile(Buffer.from('not ogg'));
    await deliver(
      b.id,
      tg.message({
        chat: OWNER,
        from: OWNER,
        document: { ...fakePng, name: 'x.png', mime: 'image/png' },
      }),
    );
    call = env.turns.calls.at(-1)!;
    expect(call.text).toMatch(/x\.png \("x\.png" does not look like a image\/png image\)/);
    expect(call.attachmentIds ?? []).toEqual([]);
    await deliver(b.id, tg.message({ chat: OWNER, from: OWNER, voice: fakeVoice }));
    expect(env.turns.calls.at(-1)!.text).toMatch(/does not look like an Ogg voice note/);
    const docx = tg.addFile(Buffer.from('PK\x03\x04 zip'));
    await deliver(
      b.id,
      tg.message({ chat: OWNER, from: OWNER, document: { ...docx, name: 'report.docx' } }),
    );
    expect(env.turns.calls.at(-1)!.text).toMatch(/report\.docx \(.*not a supported file type/);
    // Media that is not read is named, so the agent can say so.
    await deliver(
      b.id,
      tg.message({ chat: OWNER, from: OWNER, extra: { sticker: { file_id: 's1' } } }),
    );
    expect(env.turns.calls.at(-1)!.text).toMatch(
      /Attachments not accepted: a sticker \(a sticker is not read\)/,
    );
  });

  it('lists every file of an entry that carried several, kept or refused', async () => {
    const { b } = await setup();
    await env.service.receiveFrom(b.id, {
      kind: 'telegram',
      conversation: String(OWNER),
      visibility: 'private',
      sender: { externalId: String(OWNER), displayName: null },
      addressed: true,
      text: 'two files',
      messageId: `${OWNER}:9001`,
      threadRef: null,
      receivedAt: new Date().toISOString(),
      attachments: [
        { name: 'a.txt', mime: 'text/plain', bytes: Buffer.from('alpha') },
        { name: 'b.bin', mime: 'application/octet-stream', bytes: Buffer.from([0, 1, 2]) },
      ],
    });
    await env.service.idle();
    const [entry] = env.service.messages(ACCOUNT, b.id, { limit: 1, direction: 'in' });
    expect(entry!.file).toMatchObject({ name: 'a.txt', status: 'received', size: 5 });
    expect(entry!.files!.map((f) => [f.name, f.status])).toEqual([
      ['a.txt', 'received'],
      ['b.bin', 'failed'],
    ]);
    expect(entry!.files![1]!.reason).toMatch(/not a supported file type/);
  });

  it('downloads nothing for a message that starts no turn', async () => {
    const { b } = await setup({ group: true });
    const photo = tg.addFile(JPEG);
    // Not addressed in a group, from an unknown sender, or on a disconnected binding.
    await deliver(b.id, tg.message({ chat: GROUP, from: MEMBER, photo: [photo] }));
    await deliver(b.id, tg.message({ chat: OWNER, from: STRANGER, photo: [photo] }));
    await env.service.setEnabled(ACCOUNT, b.id, false);
    await deliver(b.id, tg.message({ chat: OWNER, from: OWNER, photo: [photo] }));
    expect(tg.of('getFile')).toEqual([]);
    expect(tg.downloads).toEqual([]);
    expect(env.turns.calls).toHaveLength(0);
  });

  it('keeps nothing when the Hub keeps no files (and downloads nothing)', async () => {
    await env.service.close();
    env.db.close();
    env = await serviceEnv({ telegramApi: tg.api, publicBase: 'https://hub.example.com' });
    const { b } = await setup();
    const photo = tg.addFile(JPEG);
    await deliver(b.id, tg.message({ chat: OWNER, from: OWNER, photo: [photo] }));
    expect(env.turns.calls.at(-1)!.text).toMatch(/files are not kept here/);
    expect(tg.downloads).toEqual([]);
  });
});

describe('the download cap while reading', () => {
  it('stops reading past the cap whatever the service said, and keeps the token out of errors', async () => {
    const token = '123456:FakeTokenForTheCapTest_0123456789'; // secret-scan: fake
    const seen: string[] = [];
    const adapter = new TelegramAdapter({
      credentials: {
        secret: () => Promise.resolve(token),
        config: () => Promise.resolve({}),
        remember: () => Promise.resolve(),
      },
      apiBase: 'https://tg.invalid',
      fetch: (input) => {
        const url = String(input);
        seen.push(url);
        if (url.endsWith('/getFile'))
          return Promise.resolve(
            Response.json({
              ok: true,
              result: { file_id: 'a', file_size: 10, file_path: 'docs/a' },
            }),
          );
        // A body that never ends, with no length: 1 MiB chunks.
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            sent++;
            c.enqueue(new Uint8Array(1024 * 1024));
          },
        });
        void sent;
        return Promise.resolve(new Response(body));
      },
    });
    const file = {
      ref: 'a',
      kind: 'document' as const,
      name: 'a.txt',
      mime: 'text/plain',
      size: 10,
    };
    const err = await adapter
      .download('b1', file, AbortSignal.timeout(10_000))
      .catch((e: Error) => e);
    expect(err).toMatchObject({
      code: 'validation',
      message: expect.stringContaining('the limit is 20.0 MB'),
    });
    expect(String((err as Error).message)).not.toContain(token);
    expect(seen.at(-1)).toBe(`https://tg.invalid/file/bot${token}/docs/a`);
    // A path that tries to leave the file area is refused before anything is fetched.
    const bad = new TelegramAdapter({
      credentials: {
        secret: () => Promise.resolve(token),
        config: () => Promise.resolve({}),
        remember: () => Promise.resolve(),
      },
      apiBase: 'https://tg.invalid',
      fetch: () =>
        Promise.resolve(
          Response.json({ ok: true, result: { file_id: 'a', file_path: '../../etc/passwd' } }),
        ),
    });
    await expect(bad.download('b1', file, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'unavailable' },
    });
  });

  it('checks notes for their container and size', () => {
    expect(
      prepareNote({
        name: 'v.ogg',
        mime: 'audio/ogg',
        bytes: OGG,
        note: { kind: 'voice', seconds: 1 },
      }),
    ).toMatchObject({ mime: 'audio/ogg' });
    expect(() =>
      prepareNote({
        name: 'v.ogg',
        mime: 'audio/ogg',
        bytes: Buffer.alloc(0),
        note: { kind: 'voice', seconds: 1 },
      }),
    ).toThrow(/empty/);
    expect(() =>
      prepareNote({
        name: 'n.mp4',
        mime: 'video/mp4',
        bytes: OGG,
        note: { kind: 'video_note', seconds: 1 },
      }),
    ).toThrow(/MP4/);
    expect(isTextLike('text/markdown; charset=utf-8')).toBe(true);
    expect(isTextLike('image/svg+xml')).toBe(true);
    expect(isTextLike('image/png')).toBe(false);
    expect(
      artifactFileName({ kind: 'code', title: 'a/b: c', mime: 'text/plain', language: 'python' }),
    ).toBe('a b c.py');
    expect(
      artifactFileName({ kind: 'image', title: null, mime: 'image/png', language: null }),
    ).toBe('image.png');
  });
});

/** Make a held turn create artifacts, then let it finish. */
async function turnMakes(
  out: { turnId?: string },
  make: (
    a: ArtifactService,
    at: { threadId: string; messageId: string; turnId: string },
  ) => Promise<unknown>,
) {
  const turnId = out.turnId!;
  const threadId = env.turns.calls.at(-1)!.threadId;
  const messageId = uuidv7();
  const now = new Date().toISOString();
  env.db.raw
    .prepare(
      `INSERT INTO turn (id, thread_id, idx, trigger, execution_location, started_at, created_at,
         updated_at)
       VALUES (?, ?, (SELECT count(*) FROM turn WHERE thread_id = ?), 'channel', 'hub', ?, ?, ?)`,
    )
    .run(turnId, threadId, threadId, now, now, now);
  env.db.raw
    .prepare(
      "INSERT INTO message (id, thread_id, turn_id, role, created_at, updated_at) VALUES (?, ?, ?, 'assistant', ?, ?)",
    )
    .run(messageId, threadId, turnId, now, now);
  const artifacts = new ArtifactService({ db: env.db, events: new MemoryEventSink(), dataDir });
  await make(artifacts, { threadId, messageId, turnId });
  env.turns.release(turnId);
  await env.service.idle();
}

describe('outbound files', () => {
  beforeEach(() => {
    env.turns.hold = true;
  });

  it("sends the turn's artifacts after its reply: images as photos, the rest as documents", async () => {
    const { b } = await setup();
    const out = await deliver(
      b.id,
      tg.message({ chat: OWNER, from: OWNER, text: 'make me a plan' }),
    );
    await turnMakes(out, async (a, at) => {
      const base = { accountId: ACCOUNT, threadId: at.threadId, messageId: at.messageId };
      const plan = await a.save({ ...base, kind: 'markdown', title: 'Plan', content: '# v1' });
      await a.save({
        ...base,
        kind: 'markdown',
        title: 'Plan',
        content: '# v2',
        artifactId: plan.id,
      });
      await a.save({
        ...base,
        kind: 'image',
        title: 'Chart',
        content: PNG.toString('base64'),
        encoding: 'base64',
      });
    });
    expect(String(tg.of('sendMessage').at(-1)!.text)).toContain('You said:');
    expect(tg.uploads.map((u) => [u.method, u.name, u.mime, u.chatId])).toEqual([
      ['sendDocument', 'Plan.md', 'text/markdown', String(OWNER)],
      ['sendPhoto', 'Chart.png', 'image/png', String(OWNER)],
    ]);
    // The newest version in the turn.
    expect(tg.uploads[0]!.bytes.toString()).toBe('# v2');
    expect(tg.uploads[1]!.bytes).toEqual(PNG);
    const log = env.service.messages(ACCOUNT, b.id, { limit: 20 });
    const sent = log.filter((m) => m.direction === 'out' && m.reason === 'file');
    expect(sent.map((m) => m.file).reverse()).toEqual([
      {
        name: 'Plan.md',
        size: 4,
        contentType: 'text/markdown',
        direction: 'out',
        status: 'sent',
        artifactId: expect.any(String),
      },
      {
        name: 'Chart.png',
        size: PNG.length,
        contentType: 'image/png',
        direction: 'out',
        status: 'sent',
        artifactId: expect.any(String),
      },
    ]);
    // The reply's own entry carries no file.
    expect(log.find((m) => m.direction === 'out' && m.reason === null)!.file).toBeUndefined();
    expect(env.events.events.filter((e) => e.name === 'channel.message.sent')).toHaveLength(3);
  });

  it('redacts text files, falls back to a document when a photo is refused, and logs a failure', async () => {
    const { b } = await setup();
    const first = await deliver(b.id, tg.message({ chat: OWNER, from: OWNER, text: 'go' }));
    const key = 'ghp_FakeTokenForRedactionTest0000000001'; // secret-scan: fake
    tg.failNext = { method: 'sendPhoto', description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' };
    await turnMakes(first, async (a, at) => {
      const base = { accountId: ACCOUNT, threadId: at.threadId, messageId: at.messageId };
      await a.save({
        ...base,
        kind: 'code',
        title: 'deploy',
        language: 'shell',
        content: `TOKEN=${key}\n`,
      });
      await a.save({
        ...base,
        kind: 'image',
        title: 'Wide',
        content: PNG.toString('base64'),
        encoding: 'base64',
      });
    });
    expect(tg.uploads[0]!.name).toBe('deploy.sh');
    expect(tg.uploads[0]!.bytes.toString()).not.toContain(key);
    expect(tg.uploads[1]).toMatchObject({ method: 'sendDocument', name: 'Wide.png' });

    // A send that fails is logged as failed with the reason.
    const second = await deliver(b.id, tg.message({ chat: OWNER, from: OWNER, text: 'again' }));
    tg.failNext = { method: 'sendDocument', description: 'Bad Request: file is gone' };
    await turnMakes(second, (a, at) =>
      a.save({
        accountId: ACCOUNT,
        threadId: at.threadId,
        messageId: at.messageId,
        kind: 'markdown',
        title: 'X',
        content: 'x',
      }),
    );
    const failed = env.service.messages(ACCOUNT, b.id, { limit: 50, status: 'failed' });
    expect(failed.map((m) => m.reason)).toEqual([expect.stringContaining('file is gone')]);
    expect(failed[0]!.file).toMatchObject({
      name: 'X.md',
      direction: 'out',
      status: 'failed',
      reason: expect.stringContaining('file is gone'),
    });
  });

  it('in a shared group, files the check cannot read count as private', async () => {
    const { b, g } = await setup({ group: true });
    const mention = () =>
      tg.message({ chat: GROUP, from: MEMBER, text: `@${tg.botUsername} chart please` });
    const one = await deliver(b.id, mention());
    await turnMakes(one, (a, at) =>
      a.save({
        accountId: ACCOUNT,
        threadId: at.threadId,
        messageId: at.messageId,
        kind: 'image',
        title: 'Chart',
        content: PNG.toString('base64'),
        encoding: 'base64',
      }),
    );
    // The default asks the owner; with no one to ask, the files are withheld and the group told.
    expect(tg.uploads).toEqual([]);
    expect(tg.of('sendMessage').map((m) => m.text)).toContain("I can't share those files here.");
    const check = env.audit.filter((r) => r.action === 'channel.share.check').at(-1)!;
    expect(check).toMatchObject({ decision: 'deny' });
    expect(JSON.stringify(check.detail)).toMatch(/file:artifact:/);
    const withheld = env.service.messages(ACCOUNT, g!.id, { limit: 20, status: 'withheld' });
    expect(withheld.map((m) => m.reason)).toEqual(['denied']);
    expect(withheld[0]!.file).toMatchObject({
      name: 'Chart.png',
      contentType: 'image/png',
      direction: 'out',
      status: 'withheld',
      reason: 'denied',
      artifactId: expect.any(String),
    });

    // When the owner's policy allows private content in shared channels, they go.
    env.settings['channels.privateToShared'] = 'allow';
    const two = await deliver(b.id, mention());
    await turnMakes(two, (a, at) =>
      a.save({
        accountId: ACCOUNT,
        threadId: at.threadId,
        messageId: at.messageId,
        kind: 'image',
        title: 'Chart 2',
        content: PNG.toString('base64'),
        encoding: 'base64',
      }),
    );
    expect(tg.uploads.map((u) => u.name)).toEqual(['Chart 2.png']);
    expect(tg.uploads[0]!.replyParameters).toContain('message_id');
  });

  it('a text file with nothing private goes to a shared group without asking', async () => {
    const { b } = await setup({ group: true });
    const out = await deliver(
      b.id,
      tg.message({ chat: GROUP, from: MEMBER, text: `@${tg.botUsername} list` }),
    );
    await turnMakes(out, (a, at) =>
      a.save({
        accountId: ACCOUNT,
        threadId: at.threadId,
        messageId: at.messageId,
        kind: 'markdown',
        title: 'Shopping',
        content: '- apples\n- pears\n',
      }),
    );
    expect(tg.uploads.map((u) => u.name)).toEqual(['Shopping.md']);
  });
});

describe('channel.send with files', () => {
  let slack: MockSlack;
  beforeEach(async () => {
    slack = await startMockSlack();
  });
  afterEach(async () => {
    await slack.close();
  });

  it('sends the named files of its own chat after the text, and only those', async () => {
    const { b } = await setup();
    const threadId = await deliverAndThread(b.id);
    const artifacts = new ArtifactService({ db: env.db, events: new MemoryEventSink(), dataDir });
    const report = await artifacts.save({
      accountId: ACCOUNT,
      threadId,
      messageId: null,
      kind: 'markdown',
      title: 'Report',
      content: '# done',
    });
    const receipt = await env.service.sendAsAgent({
      accountId: ACCOUNT,
      threadId,
      turnId: null,
      bindingId: b.id,
      text: 'Here is the report.',
      files: [report.id],
    });
    expect(receipt.id).toMatch(/^tg:42:/);
    expect(tg.uploads.map((u) => u.name)).toEqual(['Report.md']);
    // Another chat's artifact, or one that does not exist, is not found.
    const other = await artifacts.save({
      accountId: ACCOUNT,
      threadId: null,
      messageId: null,
      kind: 'markdown',
      title: 'Elsewhere',
      content: 'x',
    });
    for (const id of [other.id, uuidv7()])
      await expect(
        env.service.sendAsAgent({
          accountId: ACCOUNT,
          threadId,
          turnId: null,
          bindingId: b.id,
          text: 'x',
          files: [id],
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    expect(tg.uploads).toHaveLength(1);
  });

  it('refuses files on a channel that cannot carry them', async () => {
    await env.service.close();
    env.db.close();
    env = await serviceEnv({ telegramApi: tg.api, slackApi: slack.api, dataDir });
    const c = await env.service.create(ACCOUNT, {
      kind: 'slack',
      externalRef: 'C1',
      credentials: { botToken: 'xoxb-fake-test-1', signingSecret: 'fake-signing-secret-1' }, // secret-scan: fake
    });
    await expect(
      env.service.sendAsAgent({
        accountId: ACCOUNT,
        threadId: uuidv7(),
        turnId: null,
        bindingId: c.id,
        text: 'x',
        files: [uuidv7()],
      }),
    ).rejects.toMatchObject({ code: 'capability_missing' });
  });
});

async function deliverAndThread(bindingId: string): Promise<string> {
  env.turns.hold = false;
  await deliver(bindingId, tg.message({ chat: OWNER, from: OWNER, text: 'hello' }));
  return (env.turns.calls.at(-1) as StartTurnInput).threadId;
}
