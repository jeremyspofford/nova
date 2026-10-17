// Memory (FR-032): deterministic and model extraction, opt-outs, temporary and side chats,
// project-only isolation (FR-205), dedupe, use in context, CRUD and import.
import { afterEach, describe, expect, it } from 'vitest';
import { MockProvider, type MockScript } from '@nova/providers';
import { extractFacts, memoryKey, parseModelFacts } from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

// Some tests are pure functions and never open an environment.
let env = null as unknown as Env;
afterEach(async () => {
  if (env) await env.close();
  env = null as unknown as Env;
});

const contents = async (opts: Parameters<Env['memory']['list']>[1] = {}) =>
  (await env.memory.list(ACCOUNT, opts)).map((m) => m.content);
const systemText = (mock = env.mock) =>
  mock.requests
    .at(-1)!
    .messages[0]!.content.map((p) => (p.type === 'text' ? p.text : ''))
    .join('');

async function chat(text: string, body: Parameters<Env['threads']['create']>[1] = {}) {
  const t = await env.threads.create(ACCOUNT, body);
  await env.chat.send(ACCOUNT, t.id, { text });
  await env.chat.idle();
  return t;
}

describe('deterministic extraction', () => {
  it('finds explicit statements, one per clause, and ignores questions and requests', () => {
    expect(
      extractFacts(
        "Hi, my name is Jeremy and I live in Columbus. I prefer metric units! Remember that my sister's birthday is May 3.",
      ),
    ).toEqual([
      { content: "The user's name is Jeremy.", category: 'identity' },
      { content: 'The user lives in Columbus.', category: 'location' },
      { content: 'The user prefers metric units.', category: 'preferences' },
      { content: "My sister's birthday is May 3.", category: null },
    ]);
    expect(extractFacts('Call me Jay. I work at Acme Corp, I work as a nurse.')).toEqual([
      { content: 'The user likes to be called Jay.', category: 'identity' },
      { content: 'The user works at Acme Corp.', category: 'work' },
      { content: 'The user works as a nurse.', category: 'work' },
    ]);
    expect(
      extractFacts("I'm allergic to peanuts. My favorite color is green. I don't like olives."),
    ).toEqual([
      { content: 'The user is allergic to peanuts.', category: 'health' },
      { content: "The user's favorite color is green.", category: 'preferences' },
      { content: 'The user dislikes olives.', category: 'preferences' },
    ]);
    expect(extractFacts('REMEMBER THAT the wifi is on channel 6')).toEqual([
      { content: 'The wifi is on channel 6.', category: null },
    ]);
    expect(extractFacts("I'm from Lisbon. My birthday is June 1")).toHaveLength(2);
    // Not facts.
    expect(extractFacts('Do you remember that movie?')).toEqual([]);
    expect(extractFacts('Remember to buy milk.')).toEqual([]);
    expect(extractFacts('What is my name?')).toEqual([]);
    expect(extractFacts('my name is not important to this question')).toEqual([]);
    expect(extractFacts('Tell me about the weather')).toEqual([]);
    expect(extractFacts(`Remember that ${'x'.repeat(400)}`)).toEqual([]);
    // Duplicates within one message collapse.
    expect(extractFacts('My name is Ann. my name is ann')).toHaveLength(1);
  });

  it('normalizes content for dedupe and parses model output strictly', () => {
    expect(memoryKey('  The user’s NAME is   Ann. ')).toBe("the user's name is ann");
    expect(
      parseModelFacts('{"facts":[{"content":"Likes tea","category":"food"},"Has a cat"]}'),
    ).toEqual([
      { content: 'Likes tea', category: 'food' },
      { content: 'Has a cat', category: null },
    ]);
    expect(parseModelFacts('```json\n["a"]\n```')).toEqual([{ content: 'a', category: null }]);
    expect(parseModelFacts('Sure! Here are the facts: ...')).toBeNull();
    expect(parseModelFacts('{"other":1}')).toBeNull();
    expect(
      parseModelFacts(JSON.stringify(Array.from({ length: 9 }, (_, i) => `f${i}`))),
    ).toHaveLength(5);
  });
});

describe('extraction after a turn (FR-032)', () => {
  it('stores facts from a completed turn, dedupes, and emits events', async () => {
    env = await makeEnv();
    const t = await chat('My name is Jeremy. I prefer short answers.');
    const items = await env.memory.list(ACCOUNT);
    // Newest first: both were stored together, the later one sorts first.
    expect(items.map((m) => [m.content, m.scopeKind, m.sourceKind, m.sourceThreadId])).toEqual([
      ['The user prefers short answers.', 'global', 'chat', t.id],
      ["The user's name is Jeremy.", 'global', 'chat', t.id],
    ]);
    expect(items.every((m) => m.sourceMessageId)).toBe(true);
    await chat('my name is jeremy');
    expect(await env.memory.list(ACCOUNT)).toHaveLength(2);
    const created = env.events.events.filter((e) => e.name === 'memory.item.created');
    expect(created).toHaveLength(2);
    expect(created[0]!.payload).toMatchObject({ scopeKind: 'global' });
  });

  it('saves stated facts at once, before a slow model extraction answers', async () => {
    env = await makeEnv();
    let answer!: (text: string) => void;
    const reply = new Promise<string>((r) => (answer = r));
    const job = env.memory.extractFromTurn({
      accountId: ACCOUNT,
      threadId: '01920000-0000-7000-8000-0000000000aa',
      messageId: '01920000-0000-7000-8000-0000000000ab',
      scope: { projectId: null, memoryScope: 'shared' },
      userTexts: ['I prefer window seats.'],
      assistantText: 'Noted.',
      complete: () => reply,
    });
    await expect
      .poll(async () => (await env.memory.list(ACCOUNT)).map((m) => m.content))
      .toEqual(['The user prefers window seats.']);
    answer('{"facts":[{"content":"The user travels often.","category":"travel"}]}');
    expect(await job).toBe(2);
    expect((await env.memory.list(ACCOUNT)).map((m) => m.content).sort()).toEqual([
      'The user prefers window seats.',
      'The user travels often.',
    ]);
  });

  it('uses memory in later chats as a system section', async () => {
    env = await makeEnv();
    await chat('Remember that I keep bees.');
    await chat('Any tips for my hobby?');
    expect(systemText()).toContain('## What you know about the user');
    expect(systemText()).toContain('- I keep bees.');
    // Pinned items always come first.
    const items = await env.memory.list(ACCOUNT);
    await env.memory.create(ACCOUNT, { content: 'Lives near a river', pinned: true });
    await chat('hello');
    const section = systemText();
    expect(section.indexOf('Lives near a river')).toBeLessThan(section.indexOf('I keep bees'));
    expect(items).toHaveLength(1);
  });

  it('writes and reads nothing when memory is off, for opt-out, temporary and side chats', async () => {
    env = await makeEnv();
    env.settings.memoryEnabled = false;
    await chat('My name is Off.');
    expect(await env.memory.list(ACCOUNT)).toEqual([]);
    env.settings.memoryEnabled = true;
    await env.memory.create(ACCOUNT, { content: 'Known fact' });
    env.settings.memoryEnabled = false;
    await chat('hello');
    expect(systemText()).not.toContain('Known fact');
    env.settings.memoryEnabled = true;

    await chat('My name is Optout.', { memoryOptOut: true });
    await chat('My name is Temp.', { temporary: true });
    expect(systemText()).not.toContain('Known fact');
    const parent = await chat('hello');
    await env.chat.sideChat(ACCOUNT, parent.id, { text: 'My name is Side.' });
    await env.chat.idle();
    expect(await contents()).toEqual(['Known fact']);
  });

  it('keeps project-only memory inside its project (FR-205)', async () => {
    env = await makeEnv();
    const only = await env.projects.create(ACCOUNT, {
      name: 'Secret',
      memoryScope: 'project_only',
    });
    const shared = await env.projects.create(ACCOUNT, { name: 'Open' });
    await chat('Remember that the launch code name is Bluebird.', { projectId: only.id });
    await chat('Remember that I like jazz.');
    const items = await env.memory.list(ACCOUNT);
    expect(items.map((m) => [m.content, m.scopeKind, m.scopeRef])).toEqual(
      expect.arrayContaining([
        ['The launch code name is Bluebird.', 'project', only.id],
        ['I like jazz.', 'global', null],
      ]),
    );
    // Global chats and shared projects never see project-only memory.
    await chat('hello there');
    expect(systemText()).toContain('I like jazz.');
    expect(systemText()).not.toContain('Bluebird');
    await chat('hello there', { projectId: shared.id });
    expect(systemText()).toContain('I like jazz.');
    expect(systemText()).not.toContain('Bluebird');
    // Inside the project-only project: only its own memory.
    await chat('hello there', { projectId: only.id });
    expect(systemText()).toContain('Bluebird');
    expect(systemText()).not.toContain('jazz');
  });

  it('asks a real model for more facts and ignores replies that are not JSON', async () => {
    const scripts: MockScript[] = [
      {
        when: /^User:\n/,
        once: true,
        steps: [
          {
            type: 'text_delta',
            text: '{"facts":[{"content":"The user is training for a marathon.","category":"health"},{"content":"api_key=sk-live-abcdefghijklmnop123456 is theirs"}]}',
          },
        ],
      },
      { when: /^User:\n/, steps: [{ type: 'text_delta', text: 'I could not find any.' }] },
    ];
    const real = new MockProvider({ id: 'real', scripts });
    env = await makeEnv({
      factory: ({ row }) => (row.provider === 'openai_compatible' ? real : undefined),
    });
    const acct = await env.registry.create(ACCOUNT, {
      provider: 'openai_compatible',
      label: 'Local',
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    const model = `${acct.id}/mock-fast`;
    await chat('I run every morning before work.', { model });
    const items = await contents();
    expect(items).toContain('The user is training for a marathon.');
    // Secrets are redacted before anything is stored.
    expect(items.join(' ')).not.toContain('sk-live-abcdefghijklmnop123456');
    const extraction = real.requests.find((r) =>
      r.messages.some((m) =>
        m.content.some((p) => p.type === 'text' && p.text.startsWith('User:')),
      ),
    )!;
    expect(extraction.messages[0]!.content[0]).toMatchObject({ type: 'text' });
    expect(
      env.db.raw
        .prepare('SELECT count(*) AS n FROM usage_event WHERE provider = ?')
        .get('openai_compatible'),
    ).toEqual({ n: 2 });
    const before = items.length;
    await chat('Nothing to note.', { model });
    expect(await contents()).toHaveLength(before);
  });
});

describe('memory items (CRUD, import)', () => {
  it('creates, lists, pins, edits, dismisses and deletes', async () => {
    env = await makeEnv();
    const a = await env.memory.create(ACCOUNT, { content: 'Prefers tea', category: 'food' });
    expect(a).toMatchObject({
      scopeKind: 'global',
      sourceKind: 'manual',
      pinned: false,
      status: 'active',
    });
    const same = await env.memory.create(ACCOUNT, { content: 'prefers tea.' });
    expect(same.id).toBe(a.id);
    const b = await env.memory.create(ACCOUNT, { content: 'Has two dogs' });
    await env.memory.update(ACCOUNT, a.id, { pinned: true });
    expect(await contents()).toEqual(['Prefers tea', 'Has two dogs']);
    expect(await contents({ q: 'dog' })).toEqual(['Has two dogs']);
    expect(await contents({ category: 'food' })).toEqual(['Prefers tea']);
    expect(await contents({ q: 'zzz' })).toEqual([]);
    const edited = await env.memory.update(ACCOUNT, b.id, {
      content: 'Has three dogs',
      category: null,
    });
    expect(edited.content).toBe('Has three dogs');
    expect(await contents({ q: 'three' })).toEqual(['Has three dogs']);
    await env.memory.update(ACCOUNT, b.id, { status: 'dismissed' });
    expect(await contents()).toEqual(['Prefers tea']);
    expect(await contents({ status: 'dismissed' })).toEqual(['Has three dogs']);
    await env.memory.remove(ACCOUNT, b.id);
    await expect(env.memory.remove(ACCOUNT, b.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(env.events.names().filter((n) => n.startsWith('memory.item.'))).toEqual([
      'memory.item.created',
      'memory.item.created',
      'memory.item.updated',
      'memory.item.updated',
      'memory.item.updated',
      'memory.item.deleted',
    ]);
    await expect(env.memory.update('other', a.id, { pinned: false })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('validates project scopes', async () => {
    env = await makeEnv();
    const p = await env.projects.create(ACCOUNT, { name: 'P', memoryScope: 'project_only' });
    const item = await env.memory.create(ACCOUNT, {
      content: 'Deadline is Friday',
      scopeKind: 'project',
      scopeRef: p.id,
    });
    expect(item).toMatchObject({ scopeKind: 'project', scopeRef: p.id });
    expect(await contents({ scopeKind: 'project', scopeRef: p.id })).toEqual([
      'Deadline is Friday',
    ]);
    expect(await contents({ scopeKind: 'global' })).toEqual([]);
    await expect(
      env.memory.create(ACCOUNT, { content: 'x', scopeKind: 'project' }),
    ).rejects.toMatchObject({ details: { reason: 'scope' } });
    await expect(
      env.memory.create(ACCOUNT, { content: 'x', scopeKind: 'project', scopeRef: 'nope' }),
    ).rejects.toMatchObject({ details: { reason: 'project' } });
  });

  it('imports JSON and text, skipping duplicates and invalid entries, redacting secrets', async () => {
    env = await makeEnv();
    await env.memory.create(ACCOUNT, { content: 'Likes hiking' });
    const json = await env.memory.import(ACCOUNT, {
      format: 'json',
      data: JSON.stringify([
        'likes hiking',
        { content: 'Speaks Portuguese', category: 'languages' },
        { nope: 1 },
        42,
        'password: hunter2secret',
      ]),
    });
    expect(json).toEqual({ imported: 2, skipped: 3 });
    const text = await env.memory.import(ACCOUNT, {
      format: 'text',
      data: '- Plays guitar\n\n* Speaks Portuguese\n1. Owns a bike\n',
    });
    expect(text).toEqual({ imported: 2, skipped: 1 });
    const items = await env.memory.list(ACCOUNT);
    expect(items.filter((m) => m.sourceKind === 'import')).toHaveLength(4);
    expect(items.map((m) => m.content).join(' ')).not.toContain('hunter2secret');
    expect(items.find((m) => m.content === 'Speaks Portuguese')!.category).toBe('languages');
    await expect(
      env.memory.import(ACCOUNT, { format: 'json', data: '{oops' }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      env.memory.import(ACCOUNT, { format: 'json', data: '{"a":1}' }),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});
