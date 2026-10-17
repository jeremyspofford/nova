// Usage insights (FR-114): totals, by provider and model, by project, by day, active days, the
// streak (with a grace day for today) and the longest completed turn, computed from seeded
// usage_event and turn rows; and a year of data stays fast.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import { UsageService } from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

const NOW = new Date('2026-10-17T12:00:00.000Z');

let env: Env;
let usage: UsageService;
beforeEach(async () => {
  env = await makeEnv();
  usage = new UsageService({ db: env.db, now: () => NOW });
});
afterEach(() => env.close());

function thread(projectId: string | null, deleted = false): string {
  const id = uuidv7();
  const at = NOW.toISOString();
  env.db.raw
    .prepare(
      `INSERT INTO thread (id, account_id, project_id, mode, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 'chat', ?, ?, ?)`,
    )
    .run(id, ACCOUNT, projectId, at, at, deleted ? at : null);
  return id;
}

function project(name: string): string {
  const id = uuidv7();
  const at = NOW.toISOString();
  env.db.raw
    .prepare(
      'INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, ACCOUNT, name, at, at);
  return id;
}

let turnIdx = 0;
function turn(threadId: string, start: string, seconds: number, status = 'completed'): string {
  const id = uuidv7();
  const end = new Date(Date.parse(start) + seconds * 1000).toISOString();
  env.db.raw
    .prepare(
      `INSERT INTO turn (id, thread_id, idx, status, execution_location, started_at, ended_at,
         created_at, updated_at) VALUES (?, ?, ?, ?, 'hub', ?, ?, ?, ?)`,
    )
    .run(id, threadId, turnIdx++, status, start, end, start, end);
  return id;
}

function use(
  at: string,
  o: {
    provider?: string;
    model?: string;
    threadId?: string | null;
    turnId?: string | null;
    input?: number;
    output?: number;
    cached?: number;
    cost?: number | null;
    account?: string;
  } = {},
): void {
  env.db.raw
    .prepare(
      `INSERT INTO usage_event (id, account_id, provider, model, thread_id, turn_id, input_tokens,
         output_tokens, cached_tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      uuidv7(),
      o.account ?? ACCOUNT,
      o.provider ?? 'openai',
      o.model ?? 'gpt-a',
      o.threadId ?? null,
      o.turnId ?? null,
      o.input ?? 10,
      o.output ?? 5,
      o.cached ?? 0,
      o.cost === undefined ? 0.01 : o.cost,
      at,
    );
}

describe('UsageService.summary', () => {
  it('aggregates totals, models, projects and days over the last 30 days', () => {
    const alpha = project('Alpha');
    const t1 = thread(alpha);
    const t2 = thread(null);
    const k1 = turn(t1, '2026-10-17T09:00:00.000Z', 90);
    const k2 = turn(t2, '2026-10-16T09:00:00.000Z', 30);
    // Two model steps of one turn count as one turn.
    use('2026-10-17T09:00:10.000Z', {
      threadId: t1,
      turnId: k1,
      input: 100,
      output: 50,
      cost: 0.5,
    });
    use('2026-10-17T09:00:20.000Z', {
      threadId: t1,
      turnId: k1,
      input: 20,
      output: 10,
      cached: 7,
      cost: 0.1,
    });
    use('2026-10-16T09:00:00.000Z', {
      provider: 'anthropic',
      model: 'm-b',
      threadId: t2,
      turnId: k2,
      input: 1000,
      output: 400,
      cost: null,
    });
    // Memory extraction: no thread, no turn.
    use('2026-10-15T08:00:00.000Z', {
      provider: 'mock',
      model: 'mock-fast',
      input: 3,
      output: 1,
      cost: 0,
    });
    // Out of range, and another account.
    use('2026-08-01T08:00:00.000Z', { input: 9999 });
    use('2026-10-17T08:00:00.000Z', { input: 7777, account: 'someone-else' });

    const s = usage.summary(ACCOUNT);
    expect(s.from).toBe('2026-09-17T12:00:00.000Z');
    expect(s.to).toBe(NOW.toISOString());
    expect(s.totals).toEqual({
      inputTokens: 1123,
      outputTokens: 461,
      cachedTokens: 7,
      costUsd: 0.6,
      turns: 2,
    });
    expect(s.byModel).toEqual([
      {
        provider: 'anthropic',
        model: 'm-b',
        inputTokens: 1000,
        outputTokens: 400,
        costUsd: 0,
        turns: 1,
      },
      {
        provider: 'openai',
        model: 'gpt-a',
        inputTokens: 120,
        outputTokens: 60,
        costUsd: 0.6,
        turns: 1,
      },
      {
        provider: 'mock',
        model: 'mock-fast',
        inputTokens: 3,
        outputTokens: 1,
        costUsd: 0,
        turns: 0,
      },
    ]);
    expect(s.byProject).toEqual([
      { projectId: null, name: null, inputTokens: 1003, outputTokens: 401, costUsd: 0 },
      { projectId: alpha, name: 'Alpha', inputTokens: 120, outputTokens: 60, costUsd: 0.6 },
    ]);
    expect(s.byDay).toEqual([
      { day: '2026-10-15', inputTokens: 3, outputTokens: 1, costUsd: 0 },
      { day: '2026-10-16', inputTokens: 1000, outputTokens: 400, costUsd: 0 },
      { day: '2026-10-17', inputTokens: 120, outputTokens: 60, costUsd: 0.6 },
    ]);
    expect(s.activeDays).toBe(3);
    expect(s.streak).toBe(3);
    expect(s.longestTurn).toEqual({ threadId: t1, turnId: k1, seconds: 90 });
  });

  it('counts the streak through yesterday until today is over, and stops at a gap', () => {
    for (const d of ['2026-10-16', '2026-10-15', '2026-10-13']) use(`${d}T10:00:00.000Z`);
    expect(usage.summary(ACCOUNT).streak).toBe(2);
    // A streak longer than the range is followed past its start.
    const long = new UsageService({ db: env.db, now: () => NOW });
    // 10-12 back to 09-12, joining 10-13.
    for (let i = 4; i <= 34; i++)
      use(new Date(Date.parse('2026-10-16T10:00:00Z') - i * 86_400_000).toISOString());
    use('2026-10-14T10:00:00.000Z');
    expect(long.summary(ACCOUNT, { from: '2026-10-10' }).streak).toBe(4 + 31);
    // Nothing yesterday or today: no streak.
    const later = new UsageService({ db: env.db, now: () => new Date('2026-10-20T12:00:00Z') });
    expect(later.summary(ACCOUNT).streak).toBe(0);
  });

  it('picks the longest completed turn in a live thread', () => {
    const live = thread(null);
    const gone = thread(null, true);
    const short = turn(live, '2026-10-17T01:00:00.000Z', 12.34);
    turn(live, '2026-10-17T02:00:00.000Z', 600, 'interrupted');
    turn(gone, '2026-10-17T03:00:00.000Z', 900);
    turn(live, '2026-08-01T03:00:00.000Z', 900); // before the range
    expect(usage.summary(ACCOUNT).longestTurn).toEqual({
      threadId: live,
      turnId: short,
      seconds: 12.3,
    });
    expect(
      new UsageService({ db: env.db, now: () => NOW }).summary('nobody').longestTurn,
    ).toBeNull();
  });

  it('takes date or timestamp bounds and refuses bad ones', () => {
    use('2026-10-01T10:00:00.000Z', { input: 1 });
    use('2026-10-02T23:59:59.000Z', { input: 2 });
    use('2026-10-03T00:00:00.000Z', { input: 4 });
    const s = usage.summary(ACCOUNT, { from: '2026-10-01', to: '2026-10-02' });
    expect(s.totals.inputTokens).toBe(3);
    expect(s.to).toBe('2026-10-03T00:00:00.000Z');
    expect(
      usage.summary(ACCOUNT, { from: '2026-10-02T00:00:00Z', to: '2026-10-03T00:00:00Z' }).totals
        .inputTokens,
    ).toBe(2);
    expect(() => usage.summary(ACCOUNT, { from: 'yesterday' })).toThrow(/from is not a date/);
    expect(() => usage.summary(ACCOUNT, { from: '2026-10-05', to: '2026-10-01' })).toThrow(
      /before/,
    );
    const empty = usage.summary('nobody');
    expect(empty).toMatchObject({
      byModel: [],
      byProject: [],
      byDay: [],
      activeDays: 0,
      streak: 0,
    });
    expect(empty.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      turns: 0,
    });
  });

  // Seeding takes a second or two; the test timeout leaves room for a busy runner.
  it('stays fast for a year of data', { timeout: 60_000 }, () => {
    const projects = [project('A'), project('B'), null];
    const threads = projects.flatMap((p) => [thread(p), thread(p)]);
    const insert = env.db.raw.prepare(
      `INSERT INTO usage_event (id, account_id, provider, model, thread_id, turn_id, input_tokens,
         output_tokens, cached_tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const start = Date.parse('2025-10-18T00:00:00Z');
    const rows = 120_000;
    env.db.raw.exec('BEGIN');
    for (let i = 0; i < rows; i++) {
      const at = new Date(start + Math.floor((i / rows) * 365 * 86_400_000)).toISOString();
      insert.run(
        uuidv7(),
        ACCOUNT,
        i % 3 ? 'openai' : 'anthropic',
        `m-${i % 7}`,
        threads[i % threads.length]!,
        `turn-${i >> 1}`,
        100,
        50,
        0,
        0.001,
        at,
      );
    }
    env.db.raw.exec('COMMIT');
    const t0 = performance.now();
    const s = usage.summary(ACCOUNT, { from: '2025-10-17', to: '2026-10-17' });
    const ms = performance.now() - t0;
    expect(s.totals.turns).toBe(rows / 2);
    expect(s.activeDays).toBeGreaterThan(360);
    expect(s.byModel).toHaveLength(7 + 7);
    // About 0.3-0.5 s locally for 120,000 rows; the bound is generous for loaded CI runners.
    expect(ms).toBeLessThan(5_000);
  });
});
