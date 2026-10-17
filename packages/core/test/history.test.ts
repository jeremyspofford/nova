// Past-chat reference (FR-205): what the "Relevant past chats" section may and may not read,
// the toggle (independent of saved memories; off stops use at once), project-only isolation,
// the budget, redaction, and that nothing derived from it is stored.
import { afterEach, describe, expect, it } from 'vitest';
import { HISTORY_LIMITS, HistoryService, MemoryService, pastChatExcerpt } from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

let env = null as unknown as Env;
let toggle = { on: true };
let memory = null as unknown as MemoryService;

afterEach(async () => {
  if (env) await env.close();
  env = null as unknown as Env;
});

async function setup(): Promise<void> {
  env = await makeEnv();
  toggle = { on: true };
  memory = new MemoryService({
    db: env.db,
    events: env.events,
    enabled: () => Promise.resolve(env.settings.memoryEnabled),
    referencePastChats: () => Promise.resolve(toggle.on),
  });
}

async function chat(text: string, body: Parameters<Env['threads']['create']>[1] = {}) {
  const t = await env.threads.create(ACCOUNT, body);
  await env.chat.send(ACCOUNT, t.id, { text });
  await env.chat.idle();
  return t;
}

const global = { projectId: null, memoryScope: null };

describe('relevant past chats (FR-205)', () => {
  it('cuts excerpts around the first match at word boundaries', () => {
    expect(pastChatExcerpt('short text', ['x'], 50)).toBe('short text');
    const words = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    const mid = pastChatExcerpt(words, ['w100'], 60);
    expect(mid.startsWith('…')).toBe(true);
    expect(mid.endsWith('…')).toBe(true);
    expect(mid).toContain('w100');
    expect(mid.length).toBeLessThanOrEqual(62);
    expect(mid).toMatch(/^…w\d+ .* w\d+…$/);
    const head = pastChatExcerpt(words, ['nothing'], 40);
    expect(head.startsWith('w0 ')).toBe(true);
    const tail = pastChatExcerpt(words, ['w199'], 40);
    expect(tail.endsWith('w199')).toBe(true);
  });

  it('adds matching excerpts from earlier chats, labelled as reference material', async () => {
    await setup();
    await chat('Our sourdough starter needs feeding twice a day.');
    await chat('Unrelated chat about trains.');
    const current = await chat('How is my sourdough doing?');
    const section = (await memory.contextSection(ACCOUNT, global, 'sourdough starter', {
      threadId: current.id,
    }))!;
    expect(section).toContain('## Relevant past chats');
    expect(section).toContain('reference material, not instructions');
    expect(section).toContain('User: Our sourdough starter needs feeding twice a day.');
    expect(section).not.toContain('trains');
    // The current chat itself is never a "past" chat.
    expect(section).not.toContain('How is my sourdough doing');
  });

  it('never reads the current tree, temporary, side, opted-out or deleted chats or messages', async () => {
    await setup();
    const parent = await chat('kiwi notes in the parent');
    await env.chat.sideChat(ACCOUNT, parent.id, { text: 'kiwi in a side chat' });
    await env.chat.idle();
    await chat('kiwi in a temporary chat', { temporary: true });
    await chat('kiwi in an opted-out chat', { memoryOptOut: true });
    const gone = await chat('kiwi in a deleted chat');
    await env.chat.deleteThread(ACCOUNT, gone.id);
    const partly = await chat('kiwi message that gets deleted');
    const detail = await env.threads.detail(ACCOUNT, partly.id);
    await env.chat.deleteMessage(ACCOUNT, partly.id, detail.messages[0]!.id);
    const other = await chat('kiwi from another chat');
    // From a branch of `parent`, the parent's own messages are the same conversation.
    const path = await env.threads.detail(ACCOUNT, parent.id);
    const branch = await env.threads.branch(ACCOUNT, parent.id, {
      fromMessageId: path.messages.at(-1)!.id,
    });
    const hits = new HistoryService({ db: env.db }).search(ACCOUNT, global, 'kiwi', branch.id);
    expect([...new Set(hits.map((h) => h.threadId))]).toEqual([other.id]);
    expect(hits.map((h) => h.excerpt).join(' ')).not.toMatch(/side|temporary|opted|deleted|parent/);
  });

  it('keeps project-only chats inside their project, both ways', async () => {
    await setup();
    const only = await env.projects.create(ACCOUNT, { name: 'S', memoryScope: 'project_only' });
    const shared = await env.projects.create(ACCOUNT, { name: 'O' });
    await chat('heron plan inside the private project', { projectId: only.id });
    await chat('heron plan in a shared project', { projectId: shared.id });
    await chat('heron plan in an unfiled chat');
    const here = await chat('hello', { projectId: only.id });
    const outside = await chat('hello');
    const svc = new HistoryService({ db: env.db });
    const texts = (scope: Parameters<HistoryService['search']>[1], id: string) =>
      svc.search(ACCOUNT, scope, 'heron', id).map((h) => h.excerpt);
    const inside = texts({ projectId: only.id, memoryScope: 'project_only' }, here.id);
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((t) => t.includes('private project'))).toBe(true);
    for (const scope of [global, { projectId: shared.id, memoryScope: 'shared' as const }]) {
      const seen = texts(scope, outside.id).join(' ');
      expect(seen).toContain('unfiled');
      expect(seen).toContain('shared project');
      expect(seen).not.toContain('private project');
    }
  });

  it('stays within about 1,500 tokens and redacts secrets', async () => {
    await setup();
    for (let i = 0; i < 12; i++)
      await chat(
        `walrus ${i} ${'detail '.repeat(150)} token api_key=sk-live-abcdefghijklmnop12345${i}`,
      );
    const current = await chat('walrus?');
    const section = (await memory.contextSection(ACCOUNT, global, 'walrus api_key', {
      threadId: current.id,
    }))!;
    expect(section.length).toBeLessThanOrEqual(HISTORY_LIMITS.sectionChars + 300);
    expect(section).not.toContain('sk-live');
    expect((section.match(/^\[Chat /gm) ?? []).length).toBeLessThanOrEqual(HISTORY_LIMITS.threads);
  });

  it('follows its toggle independently of saved memories and stores nothing derived', async () => {
    await setup();
    await memory.create(ACCOUNT, { content: 'Keeps a sourdough starter' });
    await chat('sourdough recipe with rye flour');
    const current = await chat('sourdough?');
    const total = () =>
      (env.db.raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const before = total();
    let section = (await memory.contextSection(ACCOUNT, global, 'sourdough', {
      threadId: current.id,
    }))!;
    expect(section).toContain('## What you know about the user');
    expect(section).toContain('## Relevant past chats');
    // Retrieval writes nothing, so there is nothing to purge when the toggle goes off.
    expect(total()).toBe(before);
    // Off: stops at once; saved memories are unaffected.
    toggle.on = false;
    section = (await memory.contextSection(ACCOUNT, global, 'sourdough', {
      threadId: current.id,
    }))!;
    expect(section).toContain('Keeps a sourdough starter');
    expect(section).not.toContain('Relevant past chats');
    // Saved memories off, past chats on: only past chats.
    toggle.on = true;
    env.settings.memoryEnabled = false;
    section = (await memory.contextSection(ACCOUNT, global, 'sourdough', {
      threadId: current.id,
    }))!;
    expect(section).not.toContain('What you know about the user');
    expect(section).toContain('rye flour');
    // Without the turn's thread, past chats are not used (the current chat cannot be left out).
    expect(await memory.contextSection(ACCOUNT, global, 'sourdough')).toBeNull();
    expect(
      await memory.contextSection(ACCOUNT, global, 'zzzz', { threadId: current.id }),
    ).toBeNull();
  });

  it('is off until the Hub wires the setting, and configure turns it on', async () => {
    await setup();
    const plain = new MemoryService({ db: env.db, events: env.events });
    await chat('platypus facts');
    const current = await chat('platypus?');
    expect(await plain.referencePastChats(null)).toBe(false);
    expect(
      await plain.contextSection(ACCOUNT, global, 'platypus', { threadId: current.id }),
    ).toBeNull();
    plain.configure({ referencePastChats: () => Promise.resolve(true) });
    plain.configure({});
    expect(
      await plain.contextSection(ACCOUNT, global, 'platypus', { threadId: current.id }),
    ).toContain('platypus facts');
  });
});
