// Work mode in the pseudo-locale (FR-016): the runs list, the New run dialog, a run's page (plan
// waiting for approval, goal, budget pause, sub-agents, result with Output missing, activity
// replay), Extend budget, Scheduled with a schedule's history, and the schedule dialog show every
// word through messages. Run titles, objectives, roles, schedule titles, timezones and the Hub's
// status reasons and activity titles are fixture data.
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunView } from '@nova/shared';
import { SIDEBAR_TEXT } from '../src/shell/strings.ts';
import { ACTIVITY_TEXT } from '../src/work/ActivityTrace.tsx';
import { WORK_TEXT } from '../src/work/format.ts';
import { GOAL_TEXT } from '../src/work/GoalPanel.tsx';
import { WORK_LIST_TEXT } from '../src/work/WorkList.tsx';
import { NEW_RUN_TEXT } from '../src/work/NewRunDialog.tsx';
import { PLAN_TEXT } from '../src/work/PlanCard.tsx';
import { RESULT_TEXT } from '../src/work/ResultCard.tsx';
import { RUN_TEXT } from '../src/work/RunPage.tsx';
import { SCHEDULED_TEXT } from '../src/work/ScheduledView.tsx';
import { SCHEDULE_DIALOG_TEXT } from '../src/work/ScheduleDialog.tsx';
import { EXTEND_TEXT } from '../src/work/ExtendBudgetDialog.tsx';
import { WEEKDAYS, weekdayNames } from '../src/work/schedule-when.ts';
import { createHub } from './fakes.ts';
import { m3State } from './fakes-m3.ts';
import {
  fireView,
  goalView,
  m5WorkState,
  planSteps,
  runView,
  scheduleView,
  subagentView,
  type M5WorkState,
} from './fakes-m5-work.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  window.history.replaceState(null, '', '/');
});

/** Fixture words: titles, objectives, roles, the Hub's status reasons and activity titles. */
const DATA = [
  'Reconcile Q3',
  'Summarize the report',
  'Summarize the attached report and save a Markdown artifact.',
  'Find Q3 invoices',
  'Reconcile totals',
  'Migrate the billing tests to the new fixtures',
  'researcher',
  'Find the Q3 invoices',
  'Plan to approve',
  'Output missing',
  'Run failed',
  'Approval needed',
  'Budget reached',
  'Morning digest',
  'UTC',
  'Turn started',
  'fs.read notes.md',
  'slack:#team',
];

/** Chat's own components inside a run (its messages and cards) belong to the chat area. */
const CHAT = ['.work-log'];

async function open(path: string, work: Partial<M5WorkState>, m3 = m3State()) {
  await activateTestLocale('en-XA');
  const hub = createHub({ m5work: m5WorkState(work), m3 });
  await renderApp({ hub, path, ready: false });
  await screen.findByRole('navigation', { name: SIDEBAR_TEXT.sidebar });
  return hub;
}

const page = () => document.querySelector<HTMLElement>('.work-page')!;

describe('Work mode in a pseudo-locale', () => {
  it('shows the runs list and the New run dialog', async () => {
    await open('/work', {
      runs: [
        runView({ id: 'r1', title: 'Reconcile Q3', status: 'planning', autonomy: 'ask_first' }),
        runView({
          id: 'r2',
          status: 'running',
          used: { timeSeconds: 600, tokens: 12_000, costUsd: 0.4 },
        }),
      ],
    });
    await screen.findByRole('list', { name: WORK_LIST_TEXT.runs });
    expectFullyLocalized(page(), { data: DATA, skip: CHAT });

    await userEvent.click(screen.getByRole('button', { name: WORK_LIST_TEXT.newRun }));
    const dialog = screen.getByRole('dialog', { name: NEW_RUN_TEXT.title });
    await userEvent.click(within(dialog).getByText(NEW_RUN_TEXT.more));
    expectFullyLocalized(dialog, { data: DATA });
  });

  it('shows an empty list', async () => {
    await open('/work', {});
    await screen.findByRole('heading', { name: WORK_LIST_TEXT.none });
    expectFullyLocalized(page());
  });

  it('shows a run waiting for its plan, with a goal and sub-agents', async () => {
    const run = runView({
      id: 'r1',
      title: 'Reconcile Q3',
      status: 'planning',
      autonomy: 'ask_first',
      plan: planSteps(['Find Q3 invoices', 'Reconcile totals']),
    });
    await open(`/work/${run.id}`, {
      runs: [run],
      goals: [goalView({ runId: run.id })],
      subagents: [subagentView({ runId: run.id })],
    });
    await screen.findByRole('heading', { name: 'Reconcile Q3', level: 1 });
    await screen.findByRole('region', { name: GOAL_TEXT.heading });
    await screen.findByRole('region', { name: RESULT_TEXT.subagents });
    expectFullyLocalized(page(), { data: DATA, skip: CHAT });

    await userEvent.click(screen.getByRole('button', { name: PLAN_TEXT.edit }));
    expectFullyLocalized(screen.getByRole('region', { name: PLAN_TEXT.heading }), { data: DATA });
  });

  it('shows a run paused at its budget and the Extend budget dialog', async () => {
    const run: RunView = runView({
      id: 'r3',
      status: 'paused',
      pauseReason: 'budget_time',
      used: { timeSeconds: 600, tokens: 5_000, costUsd: 0.4 },
      budgets: { timeSeconds: 600, tokens: 2_000_000, costUsd: null },
      derived: { status: 'blocked', reason: 'Budget reached' },
    });
    await open(`/work/${run.id}`, { runs: [run] });
    await screen.findByRole('button', { name: RUN_TEXT.extendMinutes({ n: 30 }) });
    expectFullyLocalized(page(), { data: DATA, skip: CHAT });

    await userEvent.click(screen.getByRole('button', { name: RUN_TEXT.extendBudget }));
    expectFullyLocalized(screen.getByRole('dialog', { name: EXTEND_TEXT.title }), { data: DATA });
  });

  it('shows a finished run whose output is missing, and the activity replay', async () => {
    const run = runView({
      id: 'r4',
      status: 'output_missing',
      expectedOutput: { kind: 'message', ref: 'slack:#team' },
      result: null,
    });
    const m3 = m3State();
    m3.activity.set(run.threadId, [
      {
        id: 'a1',
        kind: 'turn',
        title: 'Turn started',
        status: null,
        ts: '2026-10-01T12:00:00.000Z',
        turnId: 'turn-1',
        callId: null,
        detail: null,
      },
      {
        id: 'a2',
        kind: 'tool_call',
        title: 'fs.read notes.md',
        status: null,
        ts: '2026-10-01T12:00:05.000Z',
        turnId: 'turn-1',
        callId: 'c1',
        detail: null,
      },
    ] as never);
    await open(`/work/${run.id}`, { runs: [run] }, m3);
    const activity = await screen.findByRole('region', { name: ACTIVITY_TEXT.heading });
    await within(activity).findByRole('list', { name: ACTIVITY_TEXT.trace });
    await userEvent.click(within(activity).getByRole('button', { name: ACTIVITY_TEXT.replay }));
    expectFullyLocalized(page(), { data: DATA, skip: CHAT });
  });

  it('shows Scheduled with a history and the schedule dialog', async () => {
    await open('/work/scheduled', {
      schedules: [
        scheduleView({ id: 's1', title: 'Morning digest' }),
        scheduleView({
          id: 's2',
          title: 'Morning digest',
          enabled: false,
          when: { intervalSeconds: 7200 },
        }),
      ],
      fires: [
        fireView({
          scheduleId: 's1',
          kind: 'catch_up',
          runId: 'run-c',
          outcome: 'done',
          window: { first: '2026-09-28T09:00:00.000Z', last: '2026-09-30T09:00:00.000Z', count: 3 },
        }),
        fireView({ scheduleId: 's1', kind: 'fire', runId: 'run-x', outcome: 'output_missing' }),
      ],
    });
    const list = await screen.findByRole('list', { name: SCHEDULED_TEXT.list });
    const [first] = within(list).getAllByRole('listitem', { name: 'Morning digest' });
    await userEvent.click(
      within(first!).getByRole('button', {
        name: SCHEDULED_TEXT.historyOf({ title: 'Morning digest' }),
      }),
    );
    await within(first!).findAllByRole('link', { name: /./ });
    expectFullyLocalized(page(), { data: DATA, skip: CHAT });

    await userEvent.click(screen.getByRole('button', { name: SCHEDULED_TEXT.newSchedule }));
    const dialog = screen.getByRole('dialog', { name: SCHEDULE_DIALOG_TEXT.newTitle });
    await userEvent.selectOptions(
      within(dialog).getByLabelText(SCHEDULE_DIALOG_TEXT.repeat),
      'weekly',
    );
    expectFullyLocalized(dialog, {
      data: DATA,
      skip: ['select[aria-label] option', 'option[value*="/"]'],
    });
    // The weekdays follow the locale (a live binding for other areas, too).
    expect(WEEKDAYS).toEqual(weekdayNames());
    expect(WEEKDAYS[1]).not.toBe('Monday');
    expect(WORK_TEXT.cancel).not.toBe('Cancel');
  });
});
