// Memory consolidation (FR-204, ADR-069): the extract phase (idle detection, read marks,
// exclusions, project-only isolation), the consolidate phase (dedupe, updates, aging, pinned and
// edited items untouched, topic preferences, summary budget), the offline heuristic, the model
// path with a scripted provider, the summary in context, scheduling and run bookkeeping.
import { afterEach, describe, expect, it } from 'vitest';
import { MockProvider, type MockScript } from '@nova/providers';
import {
  CONSOLIDATION_LIMITS,
  ConsolidationService,
  categorize,
  heuristicMerge,
  detectPlan,
  factSubject,
  findDate,
  heuristicCandidates,
  heuristicSummary,
  matchesTopic,
  parseConsolidation,
  parseExtraction,
  similar,
  thirdPerson,
  type ConsolidationSettings,
} from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env, type EnvOptions } from './helpers.ts';

const HOUR = 3_600_000;

interface Setup {
  env: Env;
  svc: ConsolidationService;
  clock: { now: Date };
  settings: ConsolidationSettings;
  model: { ref: string | null };
}

let s = null as unknown as Setup;
afterEach(async () => {
  if (s) {
    await s.svc.stop();
    await s.env.close();
  }
  s = null as unknown as Setup;
});

/** An environment whose chats do not extract memory themselves, so only consolidation does. */
async function setup(opts: EnvOptions & { m2Memory?: boolean } = {}): Promise<Setup> {
  const env = await makeEnv({
    ...opts,
    ...(opts.m2Memory ? {} : { chat: { ...opts.chat, memory: undefined } }),
  });
  const clock = { now: new Date(Date.now() + 2 * HOUR) };
  const settings: ConsolidationSettings = { enabled: true, idleMinutes: 60 };
  const model = { ref: null as string | null };
  const svc = new ConsolidationService({
    db: env.db,
    events: env.events,
    memory: env.memory,
    router: env.router,
    model: async (accountId) => model.ref ?? (await env.threads.defaultModel(accountId)),
    settings: () => Promise.resolve({ ...settings }),
    now: () => clock.now,
  });
  return { env, svc, clock, settings, model };
}

async function chat(text: string | string[], body: Parameters<Env['threads']['create']>[1] = {}) {
  const t = await s.env.threads.create(ACCOUNT, body);
  for (const line of Array.isArray(text) ? text : [text]) {
    await s.env.chat.send(ACCOUNT, t.id, { text: line });
    await s.env.chat.idle();
  }
  return t;
}

const items = async (status: 'active' | 'dismissed' = 'active') =>
  (await s.env.memory.list(ACCOUNT, { status })).map((m) => m.content).sort();

const global = { scopeKind: 'global', scopeRef: null } as const;

const raw = <T>(sql: string, ...params: (string | number | null)[]) =>
  s.env.db.raw.prepare(sql).all(...params) as T[];

describe('helpers', () => {
  it('finds dates and dated plans', () => {
    const ref = new Date('2026-04-01T12:00:00Z');
    expect(findDate('on 2026-09-10', ref)?.toISOString()).toBe('2026-09-10T00:00:00.000Z');
    expect(findDate('September 10, 2026', ref)?.toISOString()).toBe('2026-09-10T00:00:00.000Z');
    expect(findDate('the 3rd of May', ref)?.toISOString()).toBe('2026-05-03T00:00:00.000Z');
    // Without a year: the next such day on or after the reference.
    expect(findDate('Jan 5', ref)?.toISOString()).toBe('2027-01-05T00:00:00.000Z');
    expect(findDate('2026-02-30', ref)).toBeNull();
    expect(findDate('no date here', ref)).toBeNull();
    const now = new Date('2026-10-17T00:00:00Z');
    expect(detectPlan('The user is flying to Lisbon on 2026-09-10.', ref, now)).toEqual({
      kind: 'past_event',
      validUntil: '2026-09-11T00:00:00.000Z',
    });
    expect(detectPlan('Q3 launch on 2026-11-02', ref, now)).toMatchObject({ kind: 'plan' });
    // A birthday has a date but is not a plan.
    expect(detectPlan("The user's birthday is May 3.", ref, now)).toBeNull();
  });

  it('rewrites first-person clauses, categorizes and compares facts', () => {
    expect(thirdPerson("I'm flying to Lisbon with my sister")).toBe(
      'The user is flying to Lisbon with their sister',
    );
    expect(thirdPerson('I plan to visit Rome')).toBe('The user plans to visit Rome');
    expect(thirdPerson('I really go hiking a lot')).toBe('The user goes hiking a lot');
    expect(thirdPerson('My dog loves me')).toBe("The user's dog loves them");
    expect(thirdPerson('We are going')).toBeNull();
    expect(categorize('The user works at Acme.')).toBe('work');
    expect(categorize('The user is allergic to peanuts.')).toBe('health');
    expect(categorize("The user's sister's birthday is May 3.")).toBe('family');
    expect(categorize('The sky is blue.')).toBeNull();
    expect(factSubject("The user's name is Ann.")).toBe("user's name");
    expect(factSubject('The user lives in Berlin.')).toBe('user lives in');
    expect(factSubject('The user prefers tea.')).toBeNull();
    expect(
      similar(
        'The user prefers very short written answers.',
        'The user always prefers very short written answers',
      ),
    ).toBe(true);
    // Strict: a different value, a number or an added detail is a different fact.
    expect(
      similar(
        'The user prefers very short written answers.',
        'The user prefers long written answers.',
      ),
    ).toBe(false);
    expect(similar('Item 1 is great fun here', 'Item 2 is great fun here')).toBe(false);
    expect(
      similar('The user prefers short answers', 'The user prefers short answers in German'),
    ).toBe(false);
    expect(matchesTopic({ content: 'Has two dogs', category: null }, 'dog')).toBe(true);
    expect(matchesTopic({ content: 'x', category: 'Work' }, 'work')).toBe(true);
    expect(matchesTopic({ content: 'Doghouse', category: null }, 'dog')).toBe(false);
  });

  it('extracts stated facts, dated plans and "remember more" statements from user text only', () => {
    const out = heuristicCandidates(
      't1',
      [
        {
          id: 'm1',
          role: 'user',
          createdAt: '2026-04-01T10:00:00.000Z',
          text: "My name is Ann. I'm flying to Lisbon on 2026-09-10. I planted tomatoes in my garden. Where is it?",
        },
        {
          id: 'm2',
          role: 'assistant',
          createdAt: '2026-04-01T10:00:01.000Z',
          text: 'I live in Mars.',
        },
      ],
      [{ topic: 'garden', preference: 'more' }],
    );
    expect(out.map((c) => [c.content, c.category, c.sourceMessageId])).toEqual([
      ["The user's name is Ann.", 'identity', 'm1'],
      ['The user is flying to Lisbon on 2026-09-10.', 'travel', 'm1'],
      ['The user planted tomatoes in their garden.', 'hobbies', 'm1'],
    ]);
  });

  it('stays fast on hostile text and large merges (it runs in the Hub event loop)', () => {
    const msg = (text: string) => [
      { id: 'm', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', text },
    ];
    for (const text of [
      `I ${' '.repeat(100_000)}x`,
      `I ${'\t '.repeat(50_000)}, and my x`,
      'May '.repeat(30_000),
      ', and I'.repeat(30_000),
      "the user's ".repeat(20_000),
    ]) {
      const t0 = performance.now();
      heuristicCandidates('t', msg(text), [{ topic: 'tea time', preference: 'more' }]);
      // Each case takes a few ms alone; the budget leaves room for a loaded CI run with coverage
      // while still catching the regressions this guards (8.6 s for one text, unloaded).
      expect(performance.now() - t0).toBeLessThan(4_000);
    }
    const row = (i: number) =>
      ({
        id: `i${i}`,
        content: `The user likes thing number ${i} quite a lot`,
        contentKey: `the user likes thing number ${i} quite a lot`,
        status: 'active',
        pinned: false,
        userEdited: false,
        kind: null,
        validUntil: null,
        category: null,
        asOf: null,
        createdAt: '2026-01-01',
        supersedesId: null,
      }) as unknown as Parameters<typeof heuristicMerge>[0]['items'][number];
    const t0 = performance.now();
    const plan = heuristicMerge({
      items: Array.from({ length: 2_000 }, (_, i) => row(i)),
      candidates: Array.from({ length: 500 }, (_, i) => ({
        ref: `c${i}`,
        content: `The user enjoys item ${i} a great deal`,
        category: null,
        kind: null,
        validUntil: null,
        asOf: '2026-01-02',
        sourceThreadId: null,
        sourceMessageId: null,
      })),
      topics: [],
      now: new Date(),
    });
    // About 100 ms alone; the old merge took 2.4 s unloaded and far longer under load.
    expect(performance.now() - t0).toBeLessThan(8_000);
    expect(plan.creates).toHaveLength(500);
  }, 60_000); // the per-case budgets above are the assertions; the whole test may take longer

  it('parses model replies strictly', () => {
    expect(
      parseExtraction(
        '{"facts":[{"content":"Likes tea","category":"food","validUntil":"2026-09-11"}]}',
      ),
    ).toEqual([{ content: 'Likes tea', category: 'food', validUntil: '2026-09-11T00:00:00.000Z' }]);
    expect(parseExtraction('```json\n["a", 3, {"x":1}]\n```')).toEqual([
      { content: 'a', category: null, validUntil: null },
    ]);
    expect(parseExtraction('Sure, here you go')).toBeNull();
    expect(parseExtraction('{"other":[]}')).toBeNull();
    expect(parseConsolidation('{"items":[{"content":"A","replaces":"x"}],"summary":"S"}')).toEqual({
      items: [{ content: 'A', category: null, validUntil: null, replaces: 'x', from: null }],
      summary: 'S',
    });
    expect(parseConsolidation('{"items":[]}')).toBeNull();
    expect(parseConsolidation('[1,2]')).toBeNull();
    expect(parseConsolidation('nope')).toBeNull();
  });

  it('keeps the summary within 2,500 tokens and leaves out pinned and "less" topics', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      content: `The user remembers fact number ${i} about a rather long subject with details.`,
      category: i % 2 ? 'work' : 'travel',
      kind: null,
      pinned: 0,
      updatedAt: '2026-01-01',
    }));
    const summary = heuristicSummary(many, [])!;
    expect(summary.length).toBeLessThanOrEqual(CONSOLIDATION_LIMITS.summaryChars);
    expect(Math.ceil(summary.length / 4)).toBeLessThanOrEqual(2_500);
    const small = heuristicSummary(
      [
        { content: 'Pinned thing', category: 'work', kind: null, pinned: 1, updatedAt: '' },
        {
          content: 'Trip to Rome',
          category: 'travel',
          kind: 'past_event',
          pinned: 0,
          updatedAt: '',
        },
        { content: 'Has a dog', category: 'pets', kind: null, pinned: 0, updatedAt: '' },
        { content: 'Likes jazz', category: null, kind: null, pinned: 0, updatedAt: '' },
      ],
      [
        { topic: 'pets', preference: 'less' },
        { topic: 'jazz', preference: 'more' },
      ],
    );
    expect(small).toBe('### Other\n- Likes jazz\n### Travel\n- Trip to Rome (past event)');
    expect(heuristicSummary([], [])).toBeNull();
  });
});

describe('extract phase', () => {
  it('reads only idle threads, once, and again only for new messages', async () => {
    s = await setup();
    const t = await chat('My name is Ann.');
    // Not idle yet.
    s.clock.now = new Date();
    let r = await s.svc.run(ACCOUNT, global);
    expect(r.extract).toMatchObject({ status: 'completed', threadsScanned: 0 });
    expect(await items()).toEqual([]);
    s.clock.now = new Date(Date.now() + 2 * HOUR);
    r = await s.svc.run(ACCOUNT, global);
    expect(r.extract).toMatchObject({ phase: 'extract', status: 'completed', threadsScanned: 1 });
    expect(r.consolidate).toMatchObject({
      phase: 'consolidate',
      status: 'completed',
      itemsCreated: 1,
    });
    expect(await items()).toEqual(["The user's name is Ann."]);
    const item = (await s.env.memory.list(ACCOUNT))[0]!;
    expect(item).toMatchObject({
      sourceKind: 'consolidation',
      sourceThreadId: t.id,
      category: 'identity',
    });
    // Already read.
    r = await s.svc.run(ACCOUNT, global);
    expect(r.extract.threadsScanned).toBe(0);
    // A new message makes the thread eligible again after its idle window; only new text is read.
    await s.env.chat.send(ACCOUNT, t.id, { text: 'I live in Lisbon.' });
    await s.env.chat.idle();
    s.clock.now = new Date(Date.now() + 3 * HOUR);
    r = await s.svc.run(ACCOUNT, global);
    expect(r.extract.threadsScanned).toBe(1);
    expect(r.consolidate!.itemsCreated).toBe(1);
    expect(await items()).toEqual(['The user lives in Lisbon.', "The user's name is Ann."]);
  });

  it("reads only what the user typed: never a hook's, goal's, sub-agent's, run's or schedule's text", async () => {
    s = await setup();
    const t = await chat('I work at Acme.');
    for (const kind of ['goal', 'subagent', 'run', 'schedule', 'system'] as const)
      await s.env.chat.turnStarter.startTurn({
        accountId: ACCOUNT,
        threadId: t.id,
        text: `My name is ${kind}.`,
        trigger: 'goal',
        authority: { kind: 'none', origin: 'tool' },
        authorKind: kind,
      });
    await s.env.chat.idle();
    const r = await s.svc.run(ACCOUNT, global);
    expect(r.extract.threadsScanned).toBe(1);
    expect(await items()).toEqual(['The user works at Acme.']);
  });

  it('never reads temporary, side, opted-out, deleted or agent threads, or deleted messages', async () => {
    s = await setup();
    await chat('My name is Temp.', { temporary: true });
    await chat('My name is Optout.', { memoryOptOut: true });
    await chat('My name is Agent.', { mode: 'agent' });
    const gone = await chat('My name is Gone.');
    await s.env.chat.deleteThread(ACCOUNT, gone.id);
    const parent = await chat('hello');
    await s.env.chat.sideChat(ACCOUNT, parent.id, { text: 'My name is Side.' });
    await s.env.chat.idle();
    const keep = await chat(['I work at Acme.', 'My name is Deleted.']);
    const detail = await s.env.threads.detail(ACCOUNT, keep.id);
    const deleted = detail.messages.find(
      (m) =>
        m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text.includes('Deleted')),
    )!;
    await s.env.chat.deleteMessage(ACCOUNT, keep.id, deleted.id);
    const r = await s.svc.run(ACCOUNT, global);
    expect(r.extract.threadsScanned).toBe(2);
    expect(await items()).toEqual(['The user works at Acme.']);
  });

  it('keeps project-only chats in their project and shared projects in global memory (FR-205)', async () => {
    s = await setup();
    const only = await s.env.projects.create(ACCOUNT, {
      name: 'Secret',
      memoryScope: 'project_only',
    });
    const shared = await s.env.projects.create(ACCOUNT, { name: 'Open' });
    await chat('Remember that the code name is Bluebird.', { projectId: only.id });
    await chat('I work at Acme.', { projectId: shared.id });
    const g = await s.svc.run(ACCOUNT, global);
    expect(g.extract.threadsScanned).toBe(1);
    const p = await s.svc.run(ACCOUNT, { scopeKind: 'project', scopeRef: only.id });
    expect(p.extract.threadsScanned).toBe(1);
    expect(
      (await s.env.memory.list(ACCOUNT)).map((m) => [m.content, m.scopeKind, m.scopeRef]).sort(),
    ).toEqual([
      ['The code name is Bluebird.', 'project', only.id],
      ['The user works at Acme.', 'global', null],
    ]);
    // A shared project has no chats of its own to read.
    const sp = await s.svc.run(ACCOUNT, { scopeKind: 'project', scopeRef: shared.id });
    expect(sp.extract.threadsScanned).toBe(0);
    // The global summary never carries project-only memory.
    expect((await s.svc.summary(ACCOUNT)).summary).not.toContain('Bluebird');
    expect(
      (await s.svc.summary(ACCOUNT, { scopeKind: 'project', scopeRef: only.id })).summary,
    ).toContain('Bluebird');
    await expect(
      s.svc.run(ACCOUNT, { scopeKind: 'project', scopeRef: 'missing' }),
    ).rejects.toMatchObject({ details: { reason: 'project' } });
    await expect(s.svc.summary(ACCOUNT, { scopeKind: 'project' })).rejects.toMatchObject({
      details: { reason: 'scope' },
    });
  });

  it('redacts secrets before anything is stored', async () => {
    s = await setup();
    await chat('Remember that my api_key=sk-live-abcdefghijklmnop123456 is for the lab.');
    await s.svc.run(ACCOUNT, global);
    const all = (await items()).join(' ');
    expect(all).toContain('[REDACTED]');
    expect(all).not.toContain('sk-live-abcdefghijklmnop123456');
    expect(JSON.stringify(raw('SELECT summary FROM memory_consolidation_run'))).not.toContain(
      'sk-live',
    );
  });

  it('reads nothing while memory is off, and never reads what was said meanwhile', async () => {
    s = await setup();
    await chat('My name is Off.');
    s.env.settings.memoryEnabled = false;
    // The schedule still marks the idle chat read (nothing else is due while memory is off).
    expect(await s.svc.tick()).toBe(1);
    expect(await s.svc.tick()).toBe(0);
    const r = s.svc.runs(ACCOUNT);
    expect(r.map((x) => [x.phase, x.status, x.threadsScanned, x.itemsCreated])).toEqual([
      ['consolidate', 'completed', 0, 0],
      ['extract', 'completed', 0, 0],
    ]);
    s.env.settings.memoryEnabled = true;
    expect((await s.svc.run(ACCOUNT, global)).extract.threadsScanned).toBe(0);
    expect(await items()).toEqual([]);
  });
});

describe('consolidate phase', () => {
  it('dedupes against saved items, exact and near', async () => {
    s = await setup();
    await s.env.memory.create(ACCOUNT, {
      content: 'The user always prefers very short written answers',
    });
    await s.env.memory.create(ACCOUNT, { content: "The user's name is Ann." });
    await chat("My name is Ann. I prefer very short written answers. I'm allergic to cats.");
    const r = await s.svc.run(ACCOUNT, global);
    expect(r.consolidate!.itemsCreated).toBe(1);
    expect(await items()).toEqual([
      'The user always prefers very short written answers',
      'The user is allergic to cats.',
      "The user's name is Ann.",
    ]);
  });

  it('lets a newer fact retire an older one about the same subject, keeping history', async () => {
    s = await setup();
    const old = await s.env.memory.create(ACCOUNT, { content: 'The user lives in Columbus.' });
    await chat('I live in Berlin.');
    const r = await s.svc.run(ACCOUNT, global);
    expect(r.consolidate).toMatchObject({ itemsCreated: 1, itemsUpdated: 1 });
    expect(await items()).toEqual(['The user lives in Berlin.']);
    expect(await items('dismissed')).toEqual(['The user lives in Columbus.']);
    const row = raw<{ supersedes_id: string }>(
      "SELECT supersedes_id FROM memory_item WHERE content = 'The user lives in Berlin.'",
    )[0]!;
    expect(row.supersedes_id).toBe(old.id);
    // Two saved items that disagree: the newer wins.
    await s.env.memory.create(ACCOUNT, { content: 'The user works at Initech.' });
    s.clock.now = new Date(Date.now() + 3 * HOUR);
    await new Promise((r) => setTimeout(r, 5));
    await s.env.memory.create(ACCOUNT, { content: 'The user works at Globex.' });
    await s.svc.run(ACCOUNT, global);
    expect(await items()).toContain('The user works at Globex.');
    expect(await items()).not.toContain('The user works at Initech.');
  });

  it('never rewrites pinned or edited items; a contradicting candidate is dropped', async () => {
    s = await setup();
    const pinned = await s.env.memory.create(ACCOUNT, {
      content: 'The user lives in Porto.',
      pinned: true,
    });
    const edited = await s.env.memory.create(ACCOUNT, { content: 'tmp' });
    await s.env.memory.update(ACCOUNT, edited.id, {
      content: 'The user is flying to Oslo on 2026-01-05.',
    });
    const before = raw(
      'SELECT * FROM memory_item WHERE id IN (?, ?) ORDER BY id',
      pinned.id,
      edited.id,
    );
    await chat('I live in Berlin.');
    const r = await s.svc.run(ACCOUNT, global);
    expect(r.consolidate).toMatchObject({ itemsCreated: 0, itemsUpdated: 0, itemsAged: 0 });
    expect(
      raw('SELECT * FROM memory_item WHERE id IN (?, ?) ORDER BY id', pinned.id, edited.id),
    ).toEqual(before);
    expect(await items()).toEqual([
      'The user is flying to Oslo on 2026-01-05.',
      'The user lives in Porto.',
    ]);
  });

  it('ages dated plans into past events and categorizes items', async () => {
    s = await setup();
    s.clock.now = new Date('2026-10-17T12:00:00Z');
    await s.env.memory.create(ACCOUNT, { content: 'The user is flying to Lisbon on 2026-09-10.' });
    await s.env.memory.create(ACCOUNT, { content: 'The Q3 launch is on 2026-11-02.' });
    await s.env.memory.create(ACCOUNT, { content: 'The user keeps bees.' });
    let r = await s.svc.run(ACCOUNT, global);
    // All three were categorized; the Lisbon trip also aged.
    expect(r.consolidate).toMatchObject({ itemsAged: 1, itemsUpdated: 3 });
    const rows = () =>
      raw<{
        content: string;
        kind: string | null;
        category: string | null;
        valid_until: string | null;
      }>('SELECT content, kind, category, valid_until FROM memory_item ORDER BY content');
    expect(rows()).toEqual([
      {
        content: 'The Q3 launch is on 2026-11-02.',
        kind: 'plan',
        category: 'work',
        valid_until: '2026-11-03T00:00:00.000Z',
      },
      {
        content: 'The user is flying to Lisbon on 2026-09-10.',
        kind: 'past_event',
        category: 'travel',
        valid_until: '2026-09-11T00:00:00.000Z',
      },
      { content: 'The user keeps bees.', kind: null, category: 'hobbies', valid_until: null },
    ]);
    expect(r.consolidate!.summaryTokens).toBeGreaterThan(0);
    expect((await s.svc.summary(ACCOUNT)).summary).toContain(
      'The user is flying to Lisbon on 2026-09-10. (past event)',
    );
    // Once the launch day passes, the plan ages too.
    s.clock.now = new Date('2026-11-05T00:00:00Z');
    r = await s.svc.run(ACCOUNT, global);
    expect(r.consolidate).toMatchObject({ itemsAged: 1, itemsUpdated: 0 });
    expect(rows()[0]!.kind).toBe('past_event');
  });

  it('follows "remember more / less about this topic"', async () => {
    s = await setup();
    await s.svc.setTopic(ACCOUNT, { topic: 'Garden', preference: 'more' });
    await s.svc.setTopic(ACCOUNT, { topic: 'cats', preference: 'less' });
    await s.svc.setTopic(ACCOUNT, { topic: 'jazz', preference: 'less' });
    expect(await s.svc.setTopic(ACCOUNT, { topic: 'jazz', preference: 'default' })).toEqual({
      topic: 'jazz',
      preference: 'default',
    });
    expect(s.svc.topics(ACCOUNT)).toEqual([
      { topic: 'cats', preference: 'less' },
      { topic: 'Garden', preference: 'more' },
    ]);
    await s.env.memory.create(ACCOUNT, { content: 'The user has two cats', category: 'pets' });
    await chat("I planted tomatoes in my garden. I'm allergic to cats. I work at Acme.");
    await s.svc.run(ACCOUNT, global);
    expect(await items()).toEqual([
      'The user has two cats',
      'The user planted tomatoes in their garden.',
      'The user works at Acme.',
    ]);
    const summary = (await s.svc.summary(ACCOUNT)).summary!;
    expect(summary.indexOf('tomatoes')).toBeLessThan(summary.indexOf('Acme'));
    expect(summary).not.toContain('cats');
  });

  it('only ever writes memory tables: never skills or anything else (ADR-069)', async () => {
    s = await setup();
    await chat('My name is Ann. I live in Berlin.');
    const tables = raw<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%'",
    ).map((t) => t.name);
    const counts = () =>
      Object.fromEntries(
        tables.map((t) => [t, raw<{ n: number }>(`SELECT count(*) AS n FROM "${t}"`)[0]!.n]),
      );
    const before = counts();
    await s.svc.run(ACCOUNT, global);
    const after = counts();
    const changed = tables.filter((t) => before[t] !== after[t]).sort();
    expect(changed).toEqual(['memory_consolidation_run', 'memory_item', 'memory_thread_mark']);
  });
});

describe('summary in context', () => {
  const systemText = () =>
    s.env.mock.requests
      .at(-1)!
      .messages[0]!.content.map((p) => (p.type === 'text' ? p.text : ''))
      .join('');

  it('injects the latest summary with pinned and relevant items; corrections drop it', async () => {
    s = await setup({ m2Memory: true });
    await chat('I work at Acme. Remember that I keep bees.');
    await s.svc.run(ACCOUNT, global);
    await s.env.memory.create(ACCOUNT, { content: 'Lives near a river', pinned: true });
    await chat('Tell me about honey and my bees');
    let text = systemText();
    expect(text).toContain('Pinned:\n- Lives near a river');
    expect(text).toContain('Summary:\n### ');
    expect(text).toContain('- The user works at Acme.');
    expect(text.indexOf('Lives near a river')).toBeLessThan(text.indexOf('Summary:'));
    // A dismissed item must not linger in the injected summary.
    const acme = (await s.env.memory.list(ACCOUNT)).find((m) => m.content.includes('Acme'))!;
    await s.env.memory.update(ACCOUNT, acme.id, { status: 'dismissed' });
    expect((await s.svc.summary(ACCOUNT)).summary).toBeNull();
    await chat('hello again');
    text = systemText();
    expect(text).not.toContain('Acme');
    expect(text).not.toContain('Summary:');
    // The next run writes a fresh one; a deletion drops it as well.
    await s.svc.run(ACCOUNT, global);
    const fresh = await s.svc.summary(ACCOUNT);
    expect(fresh.summary).toContain('bees');
    expect(fresh.summary).not.toContain('Acme');
    const bees = (await s.env.memory.list(ACCOUNT)).find((m) => m.content.includes('bees'))!;
    await s.env.memory.remove(ACCOUNT, bees.id);
    expect((await s.svc.summary(ACCOUNT)).summary).toBeNull();
  });

  it('never injects a project-only summary outside its project', async () => {
    s = await setup({ m2Memory: true });
    const only = await s.env.projects.create(ACCOUNT, { name: 'S', memoryScope: 'project_only' });
    await chat('Remember that the vault code word is Heron.', { projectId: only.id });
    await chat('I work at Acme.');
    await s.svc.run(ACCOUNT, { scopeKind: 'project', scopeRef: only.id });
    await s.svc.run(ACCOUNT, global);
    await chat('hello there');
    expect(systemText()).toContain('Acme');
    expect(systemText()).not.toContain('Heron');
    await chat('hello there', { projectId: only.id });
    expect(systemText()).toContain('Heron');
    expect(systemText()).not.toContain('Acme');
  });
});

describe('model path', () => {
  async function realModel(scripts: MockScript[]) {
    const real = new MockProvider({ id: 'real', scripts });
    s = await setup({
      factory: ({ row }) => (row.provider === 'openai_compatible' ? real : undefined),
    });
    const acct = await s.env.registry.create(ACCOUNT, {
      provider: 'openai_compatible',
      label: 'Local',
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    s.model.ref = `${acct.id}/mock-fast`;
    return real;
  }
  const say = (text: string) => [{ type: 'text_delta' as const, text }];

  it('uses the model for candidates, merges and the summary, checking every proposal', async () => {
    const scripts: MockScript[] = [
      {
        when: /Transcript \(data\)/,
        steps: say(
          '{"facts":[{"content":"The user is training for a marathon.","category":"health"},{"content":"The user flies to Oslo.","category":"travel","validUntil":"2026-01-06"}]}',
        ),
      },
    ];
    const real = await realModel(scripts);
    const pinned = await s.env.memory.create(ACCOUNT, {
      content: 'The user lives in Porto.',
      pinned: true,
    });
    await s.env.memory.create(ACCOUNT, { content: 'The user prefers tea.' });
    // The provider keeps the script list, so the reply can name the pinned item's id.
    scripts.push({
      when: /Saved items \(data\)/,
      steps: say(
        JSON.stringify({
          items: [
            { content: 'The user is training for a marathon.', category: 'health', from: 'c1' },
            { content: 'The user flies to Oslo.', category: 'travel', validUntil: '2026-01-06' },
            { content: 'The user lives in Faro.', replaces: pinned.id },
            { content: 'The user prefers tea.', category: 'food' },
            { content: 'x'.repeat(400) },
          ],
          summary: '### Health\n- Training for a marathon (token sk-live-abcdefghijklmnop123456)',
        }),
      ),
    });
    const t = await chat('I run every morning before work.');
    const r = await s.svc.run(ACCOUNT, global);
    expect(r.extract).toMatchObject({ status: 'completed', threadsScanned: 1 });
    expect(r.consolidate).toMatchObject({ status: 'completed', itemsCreated: 2, itemsAged: 0 });
    const rows = raw<{ content: string; kind: string | null; source_thread_id: string | null }>(
      "SELECT content, kind, source_thread_id FROM memory_item WHERE source_kind = 'consolidation' ORDER BY content",
    );
    expect(rows).toEqual([
      { content: 'The user flies to Oslo.', kind: 'past_event', source_thread_id: null },
      { content: 'The user is training for a marathon.', kind: null, source_thread_id: t.id },
    ]);
    expect(await items()).toContain('The user lives in Porto.');
    const summary = (await s.svc.summary(ACCOUNT)).summary!;
    expect(summary).toContain('Training for a marathon');
    expect(summary).not.toContain('sk-live');
    // Both requests are accounted for and labelled the transcript as data.
    expect(
      raw("SELECT count(*) AS n FROM usage_event WHERE provider = 'openai_compatible'"),
    ).toEqual([{ n: 2 }]);
    const extractReq = real.requests.find((q) =>
      q.messages.some((m) => m.content.some((p) => p.type === 'text' && p.text.includes('<<<'))),
    )!;
    expect(extractReq.messages[0]!.content[0]).toMatchObject({ type: 'text' });
    expect(r.extract.id).toBeTruthy();
    expect(raw('SELECT model_id FROM memory_consolidation_run')).toEqual([
      { model_id: 'openai_compatible/mock-fast' },
      { model_id: 'openai_compatible/mock-fast' },
    ]);
  });

  it('a model reply that is not JSON fails the run cleanly and the threads are read again', async () => {
    await realModel([
      { when: /Transcript \(data\)/, once: true, steps: say('I found some facts!') },
      { when: /Transcript \(data\)/, steps: say('{"facts":[]}') },
      { when: /Saved items \(data\)/, once: true, steps: say('{"items": oops') },
      {
        when: /Saved items \(data\)/,
        steps: say(
          '{"items":[{"content":"The user works at Acme.","category":"work","from":"c1"}],"summary":"### Work\\n- Acme"}',
        ),
      },
    ]);
    await chat('I work at Acme.');
    let r = await s.svc.run(ACCOUNT, global);
    expect(r.extract).toMatchObject({
      status: 'failed',
      error: 'the model reply was not the JSON asked for',
    });
    expect(r.consolidate).toBeNull();
    expect(raw('SELECT count(*) AS n FROM memory_thread_mark')).toEqual([{ n: 0 }]);
    r = await s.svc.run(ACCOUNT, global);
    expect(r.extract).toMatchObject({ status: 'completed', threadsScanned: 1 });
    expect(r.consolidate).toMatchObject({ status: 'failed', summaryTokens: null });
    expect(await items()).toEqual([]);
    expect(raw('SELECT count(*) AS n FROM memory_thread_mark')).toEqual([{ n: 0 }]);
    r = await s.svc.run(ACCOUNT, global);
    expect(r.consolidate).toMatchObject({ status: 'completed', itemsCreated: 1 });
    expect(await items()).toEqual(['The user works at Acme.']);
    expect((await s.svc.summary(ACCOUNT)).summary).toBe('### Work\n- Acme');
    const names = s.env.events.events
      .filter((e) => e.name === 'memory.consolidated')
      .map((e) => [e.payload.phase, e.payload.status]);
    expect(names).toEqual([
      ['extract', 'failed'],
      ['extract', 'completed'],
      ['consolidate', 'failed'],
      ['extract', 'completed'],
      ['consolidate', 'completed'],
    ]);
  });

  it('falls back to the offline summary when the model gives none', async () => {
    await realModel([
      { when: /Transcript \(data\)/, steps: say('{"facts":[]}') },
      { when: /Saved items \(data\)/, steps: say('{"items":[],"summary":"   "}') },
    ]);
    await s.env.memory.create(ACCOUNT, { content: 'The user keeps bees.' });
    const r = await s.svc.run(ACCOUNT, global);
    expect(r.consolidate).toMatchObject({ status: 'completed', itemsCreated: 0 });
    // The model path leaves saved categories alone; the fallback groups what is there.
    expect((await s.svc.summary(ACCOUNT)).summary).toBe('### Other\n- The user keeps bees.');
  });

  it('a provider error fails the run with its message', async () => {
    const real = new MockProvider({
      id: 'real',
      failWith: { code: 'provider_error', message: 'down' },
    });
    s = await setup({
      factory: ({ row }) => (row.provider === 'openai_compatible' ? real : undefined),
    });
    const acct = await s.env.registry.create(ACCOUNT, {
      provider: 'openai_compatible',
      label: 'Local',
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    s.model.ref = `${acct.id}/mock-fast`;
    await chat('I work at Acme.');
    const r = await s.svc.run(ACCOUNT, global);
    expect(r.extract).toMatchObject({ status: 'failed', error: 'down' });
    // An unknown model falls back to the offline heuristic.
    s.model.ref = 'nope/nothing';
    const h = await s.svc.run(ACCOUNT, global);
    expect(h.consolidate).toMatchObject({ status: 'completed', itemsCreated: 1 });
  });
});

describe('runs, scheduling and topics', () => {
  it('starts in the background, returns the queued run for a repeat, and lists runs', async () => {
    s = await setup();
    await chat('I work at Acme.');
    const run = await s.svc.start(ACCOUNT, {});
    expect(run).toMatchObject({ phase: 'extract', status: 'running', scopeKind: 'global' });
    expect((await s.svc.start(ACCOUNT, { scopeKind: 'global' })).id).toBe(run.id);
    await s.svc.idle();
    const runs = s.svc.runs(ACCOUNT);
    expect(runs.map((r) => [r.phase, r.status])).toEqual([
      ['consolidate', 'completed'],
      ['extract', 'completed'],
    ]);
    expect(s.svc.getRun(ACCOUNT, run.id)).toMatchObject({ status: 'completed', threadsScanned: 1 });
    expect(() => s.svc.getRun('other', run.id)).toThrow(/not found/);
    const summary = await s.svc.summary(ACCOUNT);
    expect(summary).toMatchObject({ scopeKind: 'global', runId: runs[0]!.id });
    expect(summary.summaryTokens).toBe(Math.ceil(summary.summary!.length / 4));
    const created = s.env.events.events.find((e) => e.name === 'memory.consolidated')!;
    expect(created.payload).toMatchObject({
      runId: run.id,
      scope: { kind: 'global', ref: null },
      phase: 'extract',
      created: 0,
    });
  });

  it('runs on the schedule only where there is work, and backs off after a failure', async () => {
    s = await setup();
    expect(await s.svc.tick()).toBe(0);
    await chat('I work at Acme.');
    s.settings.enabled = false;
    expect(await s.svc.tick()).toBe(0);
    s.settings.enabled = true;
    expect(await s.svc.tick()).toBe(1);
    expect(await s.svc.tick()).toBe(0);
    // A plan whose day passed is work.
    s.clock.now = new Date('2030-01-01T00:00:00Z');
    raw("UPDATE memory_item SET kind = 'plan', valid_until = '2029-01-01T00:00:00.000Z'");
    expect(await s.svc.tick()).toBe(1);
    // A scope without a summary is work; after a recent failure it waits.
    raw('UPDATE memory_consolidation_run SET summary = NULL');
    raw(
      "UPDATE memory_consolidation_run SET status = 'failed', ended_at = ? WHERE phase = 'consolidate'",
      s.clock.now.toISOString(),
    );
    expect(await s.svc.tick()).toBe(0);
    s.clock.now = new Date('2030-01-01T02:00:00Z');
    expect(await s.svc.tick()).toBe(1);
  });

  it('recovers runs interrupted by a restart and refuses work while stopping', async () => {
    s = await setup();
    await s.svc.start(ACCOUNT, {});
    await s.svc.idle();
    raw("UPDATE memory_consolidation_run SET status = 'running', ended_at = NULL");
    expect(await s.svc.recover()).toBe(2);
    expect(
      s.svc.runs(ACCOUNT).every((r) => r.status === 'failed' && r.error === 'interrupted'),
    ).toBe(true);
    await s.svc.stop();
    await expect(s.svc.start(ACCOUNT, {})).rejects.toMatchObject({ code: 'conflict' });
    expect(await s.svc.tick()).toBe(0);
  });

  it('validates topics', async () => {
    s = await setup();
    await expect(
      s.svc.setTopic(ACCOUNT, { topic: '   ', preference: 'more' }),
    ).rejects.toMatchObject({
      code: 'validation',
    });
    await s.svc.setTopic(ACCOUNT, { topic: 'Work  Stuff', preference: 'more' });
    await s.svc.setTopic(ACCOUNT, { topic: 'work stuff', preference: 'less' });
    expect(s.svc.topics(ACCOUNT)).toEqual([{ topic: 'work stuff', preference: 'less' }]);
  });
});
