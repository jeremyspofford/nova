// Pure helpers of the Work UI (FR-051, FR-055, FR-182, FR-186, FR-188, FR-215): wording, budgets,
// the schedule picker, run ids in tool results, status sorting and the shared event stream.
import { afterEach, describe, expect, it } from 'vitest';
import type { EventEnvelope, ThreadView } from '@nova/shared';
import { planFromArgs, runIdIn } from '../src/chat/RunCard.tsx';
import { answerText } from '../src/chat/UserAskCard.tsx';
import { sortByThreadStatus, threadStatus, threadStatusReason } from '../src/chat/status.ts';
import { needsInputTargets, nextTarget } from '../src/shell/SidebarStatus.ts';
import { parseExtension } from '../src/work/ExtendBudgetDialog.tsx';
import { eventCorrelation, eventRunId, subscribeWorkEvents } from '../src/work/events.ts';
import {
  amountsText,
  budgetBound,
  budgetLine,
  formatCost,
  formatDateTime,
  formatSpan,
  formatTokens,
  isFinal,
  progressLine,
  runStatusLine,
  sortByStatus,
  stepLine,
  usageLine,
  webLink,
} from '../src/work/format.ts';
import { parseBudgets } from '../src/work/NewRunDialog.tsx';
import {
  draftFromWhen,
  localDateTime,
  whenFromDraft,
  whenText,
  type WhenDraft,
} from '../src/work/schedule-when.ts';
import { FakeEventSource, fakeEventSource, thread } from './fakes.ts';
import { planSteps, runView } from './fakes-m5-work.ts';

afterEach(() => FakeEventSource.reset());

describe('run wording and budgets (FR-182)', () => {
  it('formats time, tokens and cost the way the run header shows them', () => {
    expect(formatSpan(45 * 60)).toBe('45 min');
    expect(formatSpan(3600)).toBe('1 h');
    expect(formatSpan(5400)).toBe('1 h 30 min');
    expect(formatSpan(86_400)).toBe('1 day');
    expect(formatSpan(7 * 86_400)).toBe('7 days');
    expect(formatTokens(800)).toBe('800');
    expect(formatTokens(12_400)).toBe('12.4K');
    expect(formatTokens(500_000)).toBe('0.5M');
    expect(formatTokens(2_000_000)).toBe('2M');
    expect(formatCost(1.8)).toBe('$1.80');
    expect(amountsText({ timeSeconds: 1800, tokens: 1_000_000, costUsd: 2 })).toBe(
      '30 min, 1M tokens, $2.00',
    );
  });

  it('describes budgets and use, with the provider spend cap when no cost limit is set', () => {
    const r = runView({
      budgets: { timeSeconds: 3600, tokens: 2_000_000, costUsd: null },
      used: { timeSeconds: 720, tokens: 300_000, costUsd: 0.12 },
    });
    expect(budgetLine(r.budgets)).toBe('1 h · 2M tokens · provider spend cap');
    expect(budgetLine({ ...r.budgets, costUsd: 5 })).toBe('1 h · 2M tokens · $5.00 limit');
    expect(usageLine(r.used, r.budgets)).toBe('12 / 60 min · 0.3M / 2M tokens · $0.12');
    expect(usageLine(r.used, { ...r.budgets, costUsd: 5 })).toContain('$0.12 / $5.00');
  });

  it('names statuses, pauses and bounds, and counts plan steps', () => {
    expect(runStatusLine({ status: 'paused', pauseReason: 'budget_time' })).toBe(
      'Budget reached: time',
    );
    expect(runStatusLine({ status: 'paused', pauseReason: null })).toBe('Paused');
    expect(runStatusLine({ status: 'output_missing', pauseReason: null })).toBe('Output missing');
    expect(budgetBound('budget_tokens')).toBe('tokens');
    expect(budgetBound('budget_cost')).toBe('cost');
    expect(budgetBound('backstop')).toBe('backstop');
    expect(budgetBound('user')).toBeNull();
    expect(isFinal('done')).toBe(true);
    expect(isFinal('paused')).toBe(false);
    expect(stepLine(null)).toBeNull();
    const plan = planSteps(['Find', 'Reconcile', 'Draft'], (i) =>
      i === 0 ? 'done' : i === 1 ? 'running' : 'pending',
    );
    expect(stepLine(plan)).toBe('Step 2 of 3');
    expect(stepLine(planSteps(['a', 'b'], () => 'done'))).toBe('2 of 2 steps done');
    expect(
      progressLine(runView({ plan, used: { timeSeconds: 720, tokens: 300_000, costUsd: 0 } })),
    ).toBe('Running · step 2 of 3 · 12 min · 0.3M tokens');
  });

  it('sorts Needs input first, then Blocked, Running and Ready, newest first within each', () => {
    const list = [
      runView({
        id: 'a',
        derived: { status: 'ready', reason: null },
        updatedAt: '2026-10-01T12:00:05Z',
      }),
      runView({ id: 'b', derived: { status: 'running', reason: null } }),
      runView({
        id: 'c',
        derived: { status: 'needs_input', reason: null },
        updatedAt: '2026-10-01T11:00:00Z',
      }),
      runView({ id: 'd', derived: { status: 'blocked', reason: null } }),
      runView({
        id: 'e',
        derived: { status: 'needs_input', reason: null },
        updatedAt: '2026-10-01T13:00:00Z',
      }),
    ];
    expect(sortByStatus(list).map((r) => r.id)).toEqual(['e', 'c', 'd', 'b', 'a']);
  });

  it('follows only web links in evidence and formats missing times', () => {
    expect(webLink('https://example.com/a')).toBe('https://example.com/a');
    expect(webLink('javascript:alert(1)')).toBeNull();
    expect(webLink('notes/a.md')).toBeNull();
    expect(formatDateTime(null)).toBe('Not scheduled');
    expect(formatDateTime('nonsense')).toBe('nonsense');
  });

  it('checks new-run budgets and extensions against the schema bounds', () => {
    expect(parseBudgets({ minutes: '10', tokens: '2000000', cost: '' })).toEqual({
      budgets: { timeSeconds: 600, tokens: 2_000_000, costUsd: null },
    });
    expect(parseBudgets({ minutes: '10', tokens: '2000000', cost: '2.5' })).toEqual({
      budgets: { timeSeconds: 600, tokens: 2_000_000, costUsd: 2.5 },
    });
    expect(parseBudgets({ minutes: '0', tokens: '2000000', cost: '' })).toHaveProperty('error');
    expect(parseBudgets({ minutes: '1.5', tokens: '2000000', cost: '' })).toHaveProperty('error');
    expect(parseBudgets({ minutes: '10', tokens: '10', cost: '' })).toHaveProperty('error');
    expect(parseBudgets({ minutes: '10', tokens: '2000', cost: '-1' })).toHaveProperty('error');
    expect(parseExtension({ minutes: '30', tokens: '', cost: '' })).toEqual({
      body: { timeSeconds: 1800 },
    });
    expect(parseExtension({ minutes: '', tokens: '5000', cost: '1.5' })).toEqual({
      body: { tokens: 5000, costUsd: 1.5 },
    });
    expect(parseExtension({ minutes: '', tokens: '', cost: '' })).toEqual({
      error: 'Add time, tokens or cost.',
    });
    expect(parseExtension({ minutes: '', tokens: '10', cost: '' })).toHaveProperty('error');
    expect(parseExtension({ minutes: '', tokens: '', cost: '0' })).toHaveProperty('error');
    expect(parseExtension({ minutes: 'x', tokens: '', cost: '' })).toHaveProperty('error');
  });
});

describe('schedule picker (FR-055)', () => {
  const now = new Date(2026, 9, 17, 15, 0);
  const draft = (over: Partial<WhenDraft>): WhenDraft => ({ ...draftFromWhen(null, now), ...over });

  it('builds cron, intervals and one-shot times from the friendly choices', () => {
    expect(whenFromDraft(draft({ repeat: 'daily', time: '07:30' }))).toEqual({
      when: { cron: '30 7 * * *' },
    });
    expect(whenFromDraft(draft({ repeat: 'weekdays', time: '09:00' }))).toEqual({
      when: { cron: '0 9 * * 1-5' },
    });
    expect(whenFromDraft(draft({ repeat: 'weekly', day: 1, time: '18:05' }))).toEqual({
      when: { cron: '5 18 * * 1' },
    });
    expect(whenFromDraft(draft({ repeat: 'interval', every: '2', unit: 'hours' }))).toEqual({
      when: { intervalSeconds: 7200 },
    });
    expect(whenFromDraft(draft({ repeat: 'interval', every: '15', unit: 'minutes' }))).toEqual({
      when: { intervalSeconds: 900 },
    });
    const at = whenFromDraft(draft({ repeat: 'once', at: '2026-10-20T09:00' }));
    expect(at).toEqual({ when: { at: new Date(2026, 9, 20, 9, 0).toISOString() } });
    expect(whenFromDraft(draft({ repeat: 'advanced', expr: 'FREQ=MONTHLY;BYMONTHDAY=1' }))).toEqual(
      { when: { rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' } },
    );
    expect(whenFromDraft(draft({ repeat: 'advanced', expr: '*/5 * * * *' }))).toEqual({
      when: { cron: '*/5 * * * *' },
    });
  });

  it('refuses times, intervals and expressions it cannot use', () => {
    expect(whenFromDraft(draft({ repeat: 'daily', time: '25:00' }))).toHaveProperty('error');
    expect(whenFromDraft(draft({ repeat: 'interval', every: '0' }))).toHaveProperty('error');
    expect(
      whenFromDraft(draft({ repeat: 'interval', every: '9000', unit: 'hours' })),
    ).toHaveProperty('error');
    expect(whenFromDraft(draft({ repeat: 'once', at: '' }))).toHaveProperty('error');
    expect(whenFromDraft(draft({ repeat: 'advanced', expr: 'every day' }))).toHaveProperty('error');
  });

  it('reads existing rules back into the picker, and anything else as advanced', () => {
    expect(draftFromWhen({ cron: '0 9 * * *' }, now)).toMatchObject({
      repeat: 'daily',
      time: '09:00',
    });
    expect(draftFromWhen({ cron: '30 8 * * 1-5' }, now)).toMatchObject({
      repeat: 'weekdays',
      time: '08:30',
    });
    expect(draftFromWhen({ cron: '0 7 * * 3' }, now)).toMatchObject({ repeat: 'weekly', day: 3 });
    expect(draftFromWhen({ cron: '0 7 1 * *' }, now)).toMatchObject({
      repeat: 'advanced',
      expr: '0 7 1 * *',
    });
    expect(draftFromWhen({ rrule: 'FREQ=DAILY' }, now)).toMatchObject({ repeat: 'advanced' });
    expect(draftFromWhen({ intervalSeconds: 7200 }, now)).toMatchObject({
      repeat: 'interval',
      every: '2',
      unit: 'hours',
    });
    expect(draftFromWhen({ intervalSeconds: 900 }, now)).toMatchObject({
      every: '15',
      unit: 'minutes',
    });
    const at = new Date(2026, 9, 20, 9, 0);
    expect(draftFromWhen({ at: at.toISOString() }, now)).toMatchObject({
      repeat: 'once',
      at: localDateTime(at),
    });
  });

  it('says a rule in words', () => {
    expect(whenText({ cron: '0 9 * * *' })).toBe('Every day at 09:00');
    expect(whenText({ cron: '0 9 * * 1-5' })).toBe('Weekdays at 09:00');
    expect(whenText({ cron: '30 8 * * 1' })).toBe('Every Monday at 08:30');
    expect(whenText({ cron: '0 7 1 * *' })).toBe('Cron: 0 7 1 * *');
    expect(whenText({ intervalSeconds: 3600 })).toBe('Every hour');
    expect(whenText({ intervalSeconds: 7200 })).toBe('Every 2 hours');
    expect(whenText({ intervalSeconds: 900 })).toBe('Every 15 minutes');
    expect(whenText({ rrule: 'FREQ=DAILY' })).toBe('Rule: FREQ=DAILY');
    expect(whenText({ at: '2026-10-20T09:00:00Z' })).toMatch(/^Once on /);
  });
});

describe('chat cards (FR-186, FR-188)', () => {
  it('finds the run id in a result, a truncated result or progress text', () => {
    expect(runIdIn('{"runId":"run-7","status":"planning"}')).toBe('run-7');
    expect(runIdIn('{"runId":"run-7","objective":"Summ')).toBe('run-7');
    expect(runIdIn('Started run')).toBeNull();
    expect(runIdIn(null)).toBeNull();
    expect(runIdIn('{"runId":5}')).toBeNull();
  });

  it('reads plan steps as strings or titled objects', () => {
    expect(planFromArgs({ plan: ['Find', { title: 'Draft' }, 3] })).toEqual(['Find', 'Draft']);
    expect(planFromArgs({ steps: [{ title: 'One' }] })).toEqual(['One']);
    expect(planFromArgs({})).toEqual([]);
  });

  it('reads the answer of a request result', () => {
    expect(answerText({ choice: 'Q4' })).toBe('Q4');
    expect(answerText({ text: 'The third one' })).toBe('The third one');
    expect(answerText('plain')).toBe('plain');
    expect(answerText({ other: 1 })).toBeNull();
    expect(answerText(null)).toBeNull();
  });
});

describe('thread status (FR-215)', () => {
  const t = (over: Partial<ThreadView>) => thread(over);

  it('prefers the derived status, and the open chat streaming shows Running', () => {
    expect(threadStatus(t({ state: 'idle' }))).toBe('ready');
    expect(threadStatus(t({ state: 'waiting_input' }))).toBe('needs_input');
    expect(threadStatus(t({ state: 'error' }))).toBe('blocked');
    expect(threadStatus(t({ state: 'idle' }), true)).toBe('running');
    const blocked = t({ state: 'idle', derived: { status: 'blocked', reason: 'Budget reached' } });
    expect(threadStatus(blocked, true)).toBe('blocked');
    expect(threadStatusReason(blocked)).toBe('Budget reached');
    expect(threadStatusReason(t({}))).toBeUndefined();
  });

  it('sorts by precedence and keeps the list order within a status', () => {
    const a = t({ id: 'a' });
    const b = t({ id: 'b', derived: { status: 'needs_input', reason: null } });
    const c = t({ id: 'c', state: 'streaming' });
    const d = t({ id: 'd', derived: { status: 'needs_input', reason: null } });
    const e = t({ id: 'e', state: 'error' });
    expect(sortByThreadStatus([a, b, c, d, e]).map((x) => x.id)).toEqual(['b', 'd', 'e', 'c', 'a']);
    expect(sortByThreadStatus([a, c], 'a').map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('cycles through what needs input, chats first', () => {
    const waiting = t({ id: 'w', derived: { status: 'needs_input', reason: null } });
    const targets = needsInputTargets([t({ id: 'x' }), waiting], ['r1']);
    expect(targets).toEqual(['/chat/w', '/work/r1']);
    expect(nextTarget(targets, '/settings/general')).toBe('/chat/w');
    expect(nextTarget(targets, '/chat/w')).toBe('/work/r1');
    expect(nextTarget(targets, '/work/r1')).toBe('/chat/w');
    expect(nextTarget([], '/chat')).toBeNull();
  });
});

describe('shared event stream', () => {
  const env = (name: string, payload: Record<string, unknown>, correlation?: object) =>
    ({
      id: name,
      name,
      schemaVersion: 1,
      ts: '',
      actor: 'system',
      payload,
      correlation,
    }) as EventEnvelope;

  it('opens one stream for every listener and closes it with the last', () => {
    const seen: string[] = [];
    const offA = subscribeWorkEvents(fakeEventSource, { onEvent: (e) => seen.push(`a:${e.name}`) });
    const offB = subscribeWorkEvents(fakeEventSource, {
      onEvent: (e) => seen.push(`b:${e.name}`),
      onOpen: () => seen.push('b:open'),
    });
    expect(FakeEventSource.all).toHaveLength(1);
    const es = FakeEventSource.all[0]!;
    expect(es.url).toBe('/api/v1/events/stream');
    expect(es.listeners.has('run.status.changed')).toBe(true);
    es.open();
    es.emit('run.status.changed', { runId: 'r1' });
    expect(seen).toEqual(['b:open', 'a:run.status.changed', 'b:run.status.changed']);
    offA();
    expect(es.closed).toBe(false);
    offB();
    expect(es.closed).toBe(true);
    // A new listener opens a fresh stream.
    const offC = subscribeWorkEvents(fakeEventSource, { onEvent: () => undefined });
    expect(FakeEventSource.all).toHaveLength(2);
    offC();
  });

  it('reads the run and the correlation of an event', () => {
    expect(eventRunId(env('run.completed', { runId: 'r1' }))).toBe('r1');
    expect(eventRunId(env('approval.requested', {}, { runId: 'r2' }))).toBe('r2');
    expect(eventRunId(env('x', {}))).toBeNull();
    expect(
      eventCorrelation(env('request.created', { correlation: { callId: 'c1', runId: 'r1' } })),
    ).toEqual({ callId: 'c1', runId: 'r1' });
    expect(eventCorrelation(env('request.resolved', {}, { callId: 'c2' }))).toEqual({
      callId: 'c2',
      runId: null,
    });
  });
});
