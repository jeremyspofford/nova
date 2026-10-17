// One Work run (FR-051..FR-054, FR-057, FR-181, FR-182, FR-187; docs/04 §2.3, §2.3.1): plan
// approval, budget pause and extend, controls and redirect, goal actions, sub-agents, the result
// card, the conversation, the Activity replay and live updates.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ActivityItemView, ArtifactView, MessageView, RunView } from '@nova/shared';
import { approvalView, artifactView, toolPart } from './chat-m3-helpers.tsx';
import { FakeEventSource, createHub, message, thread } from './fakes.ts';
import { m3State, type M3State } from './fakes-m3.ts';
import {
  goalView,
  m5WorkState,
  planSteps,
  runView,
  subagentView,
  type M5WorkState,
} from './fakes-m5-work.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const workStream = () => {
  const s = FakeEventSource.all.find((x) => !x.closed && x.listeners.has('run.status.changed'));
  if (!s) throw new Error('no work stream');
  return s;
};

async function openRun(
  run: RunView,
  opts: {
    work?: Partial<M5WorkState>;
    m3?: Partial<M3State>;
    messages?: MessageView[];
  } = {},
) {
  const hub = createHub({
    m5work: m5WorkState({ runs: [run], ...opts.work }),
    m3: m3State(opts.m3),
  });
  if (opts.messages) {
    hub.state.threads = [thread({ id: run.threadId, mode: 'work', title: 'Run thread' })];
    hub.state.messages.set(run.threadId, opts.messages);
  }
  const r = await renderApp({ hub, path: `/work/${run.id}` });
  await screen.findByRole('heading', { name: run.title, level: 1 });
  return { ...r, hub };
}

const section = (name: string) => screen.getByRole('region', { name });

describe('run header, plan and controls (FR-051, FR-019)', () => {
  it('waits for plan approval on an ask_first run, edits the plan, then starts', async () => {
    const run = runView({
      id: 'r1',
      title: 'Reconcile Q3',
      status: 'planning',
      autonomy: 'ask_first',
      plan: planSteps(['Find Q3 invoices', 'Reconcile totals']),
    });
    const { hub } = await openRun(run);
    expect(within(screen.getByRole('main')).getByText('Needs input: Plan to approve')).toBeTruthy();
    const plan = section('Plan');
    expect(within(plan).getByText('Review the plan, then start the run.')).toBeTruthy();
    const steps = within(plan).getByRole('list', { name: 'Plan steps' });
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['To doFind Q3 invoices', 'To doReconcile totals']);

    await userEvent.click(within(plan).getByRole('button', { name: 'Edit plan' }));
    const second = within(plan).getByRole('textbox', { name: 'Step 2' });
    await userEvent.clear(second);
    await userEvent.type(second, 'Reconcile totals by vendor');
    await userEvent.click(within(plan).getByRole('button', { name: 'Add step' }));
    expect(document.activeElement).toBe(within(plan).getByRole('textbox', { name: 'Step 3' }));
    await userEvent.keyboard('Draft a memo');
    await userEvent.click(within(plan).getByRole('button', { name: 'Remove step 1' }));
    await userEvent.click(within(plan).getByRole('button', { name: 'Save plan' }));
    await waitFor(() =>
      expect(hub.api.updateRunPlan).toHaveBeenCalledWith('r1', {
        steps: [{ title: 'Reconcile totals by vendor' }, { title: 'Draft a memo' }],
      }),
    );
    expect(await within(plan).findByText('Draft a memo')).toBeTruthy();

    await userEvent.click(within(plan).getByRole('button', { name: 'Approve and start' }));
    await waitFor(() => expect(hub.api.startRun).toHaveBeenCalledWith('r1'));
    expect(await screen.findByText('Running · 0 min · 0 tokens')).toBeTruthy();
    expect(within(section('Plan')).queryByRole('button', { name: 'Approve and start' })).toBeNull();
  });

  it('starts a run that a chat proposed, before it has a plan', async () => {
    const run = runView({
      id: 'r1b',
      title: 'From a chat',
      status: 'planning',
      origin: 'chat_escalation',
      originRef: 'chat-1',
    });
    const { hub } = await openRun(run);
    const plan = section('Plan');
    expect(
      within(plan).getByText('This run was proposed in a chat. It starts when you accept it.'),
    ).toBeTruthy();
    expect(within(plan).getByText('The run writes its plan when it starts.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Started from a chat' }).getAttribute('href')).toBe(
      '/chat/chat-1',
    );
    await userEvent.click(within(plan).getByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(hub.api.startRun).toHaveBeenCalledWith('r1b'));
    expect(await screen.findByText('The run is starting.')).toBeTruthy();
  });

  it('pauses, resumes, redirects and cancels; a finished run has no controls', async () => {
    const run = runView({ id: 'r2', title: 'Tidy the notes', status: 'running' });
    const { hub } = await openRun(run);
    const controls = screen.getByRole('group', { name: 'Run controls' });
    await userEvent.click(within(controls).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(hub.api.controlRun).toHaveBeenCalledWith('r2', 'pause'));
    expect(await screen.findByText('Paused by you · 0 min · 0 tokens')).toBeTruthy();
    expect(screen.getByTestId('announcer').textContent).toContain(
      'Run Tidy the notes: Paused by you.',
    );
    await userEvent.click(within(controls).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(hub.api.controlRun).toHaveBeenCalledWith('r2', 'resume'));

    await userEvent.click(within(controls).getByRole('button', { name: 'Redirect…' }));
    const box = screen.getByRole('textbox', { name: 'New instructions' });
    expect(document.activeElement).toBe(box);
    await userEvent.type(box, 'Only the 2026 notes');
    await userEvent.click(screen.getByRole('button', { name: 'Send instructions' }));
    await waitFor(() =>
      expect(hub.api.controlRun).toHaveBeenCalledWith('r2', 'redirect', 'Only the 2026 notes'),
    );
    expect(hub.state.m5work.redirects).toEqual([{ runId: 'r2', text: 'Only the 2026 notes' }]);
    expect(screen.queryByRole('textbox', { name: 'New instructions' })).toBeNull();

    await userEvent.click(within(controls).getByRole('button', { name: 'Cancel run' }));
    const confirm = screen.getByRole('dialog', { name: 'Cancel this run?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Keep running' }));
    expect(hub.api.controlRun).not.toHaveBeenCalledWith('r2', 'cancel');
    await userEvent.click(within(controls).getByRole('button', { name: 'Cancel run' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Cancel this run?' })).getByRole('button', {
        name: 'Cancel run',
      }),
    );
    await waitFor(() => expect(hub.api.controlRun).toHaveBeenCalledWith('r2', 'cancel'));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Run controls' })).toBeNull());
    expect(within(section('Result')).getByText(/The run was cancelled/)).toBeTruthy();
  });

  it('says why a control failed and keeps the run as it was', async () => {
    const run = runView({ id: 'r3', title: 'Fragile', status: 'running' });
    const { hub } = await openRun(run);
    hub.state.failNext.controlRun = new Error('Hub is restarting');
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('Could not change the run: Hub is restarting')).toBeTruthy();
    expect(screen.getByText('Running · 0 min · 0 tokens')).toBeTruthy();
  });

  it('reports a run that does not exist', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/work/nope' });
    expect(await screen.findByText('This run was deleted or does not exist.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: 'Work' }));
    expect(window.location.pathname).toBe('/work');
  });
});

describe('budgets (FR-182)', () => {
  it('pauses at the time budget as Blocked, offers Extend, and continues only after it', async () => {
    const run = runView({
      id: 'r4',
      title: 'Migrate fixtures',
      status: 'paused',
      pauseReason: 'budget_time',
      derived: { status: 'blocked', reason: 'Budget reached' },
      budgets: { timeSeconds: 600, tokens: 2_000_000, costUsd: null },
      used: { timeSeconds: 600, tokens: 400_000, costUsd: 0.4 },
      result: { summary: '14 of 20 files migrated', artifactIds: [], evidence: [] },
    });
    const { hub } = await openRun(run);
    const banner = section('Budget reached: time (10 / 10 min)');
    expect(within(banner).getByText('Blocked: Budget reached')).toBeTruthy();
    expect(within(banner).getByText('14 of 20 files migrated')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    const meters = section('Budget use');
    expect(within(meters).getByText(/^10 \/ 10 min/)).toBeTruthy();
    expect(within(meters).getByText('0.4M / 2M')).toBeTruthy();
    expect(within(meters).getByText('$0.40 (limit: provider spend cap)')).toBeTruthy();
    expect(within(meters).getByText(/not counted/)).toBeTruthy();

    await userEvent.click(within(banner).getByRole('button', { name: 'Extend 30 min' }));
    await waitFor(() =>
      expect(hub.api.extendRunBudget).toHaveBeenCalledWith('r4', { timeSeconds: 1800 }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /Budget reached/ })).toBeNull(),
    );
    expect(within(section('Budget use')).getByText(/^10 \/ 40 min/)).toBeTruthy();
  });

  it('extends tokens with the dialog, refusing amounts outside the bounds', async () => {
    const run = runView({
      id: 'r5',
      title: 'Big crawl',
      status: 'paused',
      pauseReason: 'budget_tokens',
      used: { timeSeconds: 60, tokens: 2_000_000, costUsd: 0 },
    });
    const { hub } = await openRun(run);
    const banner = section('Budget reached: tokens (2M / 2M tokens)');
    await userEvent.click(within(banner).getByRole('button', { name: 'Extend budget…' }));
    const dialog = screen.getByRole('dialog', { name: 'Extend budget' });
    expect(within(dialog).getByText(/Current budgets: 1 h · 2M tokens/)).toBeTruthy();
    const tokens = within(dialog).getByRole('spinbutton', { name: 'Add tokens' });
    await userEvent.type(tokens, '10');
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'Add tokens from 1,000 to 100,000,000.',
    );
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Extend' }).disabled).toBe(
      true,
    );
    await userEvent.type(tokens, '00000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Extend' }));
    await waitFor(() =>
      expect(hub.api.extendRunBudget).toHaveBeenCalledWith('r5', { tokens: 1_000_000 }),
    );
    expect(await screen.findByText('Budget extended.')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Extend budget' })).toBeNull();
  });

  it('offers Continue after the 200-step backstop', async () => {
    const run = runView({
      id: 'r6',
      title: 'Long loop',
      status: 'paused',
      pauseReason: 'backstop',
    });
    const { hub } = await openRun(run);
    const banner = section('Step limit reached');
    await userEvent.click(within(banner).getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(hub.api.extendRunBudget).toHaveBeenCalledWith('r6', { steps: true }),
    );
  });

  it('updates the meters from usage events and refetches on a status change', async () => {
    const run = runView({ id: 'r7', title: 'Live one', status: 'running' });
    const { hub } = await openRun(run);
    const es = workStream();
    es.emit('run.budget.usage', {
      runId: 'r7',
      usage: { tokens: 250_000, timeSeconds: 300, costUsd: 0.05 },
      budgets: run.budgets,
    });
    expect(await within(section('Budget use')).findByText(/^5 \/ 60 min/)).toBeTruthy();
    expect(screen.getByText('Running · 5 min · 0.25M tokens')).toBeTruthy();
    expect(hub.api.getRun).toHaveBeenCalledTimes(1);
    // Another run's events are not this run's.
    es.emit('run.status.changed', { runId: 'other', from: 'running', to: 'paused' });
    hub.state.m5work.runs = [
      {
        ...run,
        status: 'paused',
        pauseReason: 'budget_cost',
        used: { timeSeconds: 300, tokens: 250_000, costUsd: 5 },
      },
    ];
    es.emit('run.status.changed', {
      runId: 'r7',
      from: 'running',
      to: 'paused',
      pauseReason: 'budget_cost',
    });
    expect(
      await screen.findByRole('region', { name: 'Budget reached: cost ($5.00)' }),
    ).toBeTruthy();
    expect(hub.api.getRun).toHaveBeenCalledTimes(2);
    // A question for the run (correlated in the payload) refreshes its status too.
    es.emit('request.created', {
      requestId: 'q1',
      kind: 'user_input',
      correlation: { runId: 'r7', callId: 'c9' },
      payload: {},
    });
    await waitFor(() => expect(hub.api.getRun).toHaveBeenCalledTimes(3));
  });
});

describe('goal (FR-181)', () => {
  it('sets, edits, pauses, resumes, completes and clears the goal', async () => {
    const run = runView({ id: 'g1', title: 'Billing tests', status: 'running' });
    const { hub } = await openRun(run);
    const goal = section('Goal');
    expect(await within(goal).findByText(/No goal/)).toBeTruthy();
    await userEvent.click(within(goal).getByRole('button', { name: 'Set a goal' }));
    const box = within(goal).getByRole('textbox', { name: 'Goal objective' });
    expect(document.activeElement).toBe(box);
    await userEvent.type(box, 'All billing tests use the new fixtures');
    expect(within(goal).getByText(/38 \/ 4,000 characters/)).toBeTruthy();
    await userEvent.click(within(goal).getByRole('button', { name: 'Set goal' }));
    await waitFor(() =>
      expect(hub.api.setRunGoal).toHaveBeenCalledWith('g1', {
        objective: 'All billing tests use the new fixtures',
      }),
    );
    expect(await within(goal).findByText('All billing tests use the new fixtures')).toBeTruthy();
    expect(within(goal).getByText('Active')).toBeTruthy();

    await userEvent.click(within(goal).getByRole('button', { name: 'Edit' }));
    const edit = within(goal).getByRole('textbox', { name: 'Goal objective' });
    await userEvent.clear(edit);
    await userEvent.type(edit, 'All billing and tax tests');
    await userEvent.click(within(goal).getByRole('button', { name: 'Save goal' }));
    const id = hub.state.m5work.goals[0]!.id;
    await waitFor(() =>
      expect(hub.api.updateGoal).toHaveBeenCalledWith(id, {
        objective: 'All billing and tax tests',
      }),
    );
    expect(await within(goal).findByText('All billing and tax tests')).toBeTruthy();

    await userEvent.click(within(goal).getByRole('button', { name: 'Pause goal' }));
    expect(await within(goal).findByText('Paused')).toBeTruthy();
    await userEvent.click(within(goal).getByRole('button', { name: 'Resume goal' }));
    expect(await within(goal).findByText('Active')).toBeTruthy();
    await userEvent.click(within(goal).getByRole('button', { name: 'Mark complete' }));
    expect(await within(goal).findByText('Complete')).toBeTruthy();
    expect(hub.api.goalAction).toHaveBeenCalledWith(id, 'complete');
    expect(within(goal).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(goal).getByRole('button', { name: 'Reopen goal' })).toBeTruthy();

    await userEvent.click(within(goal).getByRole('button', { name: 'Clear goal' }));
    const confirm = screen.getByRole('dialog', { name: 'Clear the goal?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Clear goal' }));
    await waitFor(() => expect(hub.api.clearRunGoal).toHaveBeenCalledWith('g1'));
    expect(await within(section('Goal')).findByText(/No goal/)).toBeTruthy();
  });

  it('shows a blocked goal with its blocker, the progress note and Extend budget', async () => {
    const run = runView({ id: 'g2', title: 'Stuck', status: 'running', goalId: 'goal-x' });
    const g = goalView({
      id: 'goal-x',
      runId: 'g2',
      status: 'blocked',
      blocker: { key: 'ci', description: 'CI credentials are missing', count: 3 },
      progressNote: '14 of 20 files migrated',
    });
    const { hub } = await openRun(run, { work: { goals: [g] } });
    const goal = section('Goal');
    expect(
      await within(goal).findByText('Blocked: CI credentials are missing (reported 3 times)'),
    ).toBeTruthy();
    expect(within(goal).getByText('14 of 20 files migrated')).toBeTruthy();
    expect(within(goal).getByText('Blocked')).toBeTruthy();
    hub.state.failNext.goalAction = new Error('Not allowed now');
    await userEvent.click(within(goal).getByRole('button', { name: 'Resume goal' }));
    expect(await screen.findByText('Could not change the goal: Not allowed now')).toBeTruthy();
    await userEvent.click(within(goal).getByRole('button', { name: 'Extend budget…' }));
    expect(screen.getByRole('dialog', { name: 'Extend budget' })).toBeTruthy();
  });

  it('refetches the goal on goal events', async () => {
    const g = goalView({ id: 'goal-y', runId: 'g3', progressNote: 'Started' });
    const run = runView({ id: 'g3', title: 'Progressing', goalId: 'goal-y' });
    const { hub } = await openRun(run, { work: { goals: [g] } });
    expect(await within(section('Goal')).findByText('Started')).toBeTruthy();
    hub.state.m5work.goals = [{ ...g, progressNote: 'Half done' }];
    workStream().emit('goal.updated', { goalId: 'goal-y', changed: ['progressNote'] });
    expect(await within(section('Goal')).findByText('Half done')).toBeTruthy();
  });
});

describe('sub-agents, result and conversation (FR-053, FR-054, FR-187)', () => {
  it('lists sub-agents and shows the result with artifact previews and evidence', async () => {
    const art: ArtifactView = artifactView('r8-thread', {
      id: 'art-chart',
      kind: 'image',
      title: 'Totals chart',
      mime: 'image/png',
    });
    const run = runView({
      id: 'r8',
      title: 'Q3 report',
      status: 'done',
      result: {
        summary: 'Totals **reconciled**.',
        artifactIds: ['art-chart'],
        evidence: ['https://example.com/ledger', 'ledger.csv row 12'],
      },
    });
    const { hub } = await openRun(run, {
      work: {
        subagents: [
          subagentView({
            runId: 'r8',
            role: 'researcher',
            status: 'done',
            threadId: 'sub-t',
            result: 'Found 12 invoices',
          }),
          subagentView({
            runId: 'r8',
            role: 'critic',
            objective: 'Check the totals',
            status: 'running',
          }),
        ],
      },
      m3: { artifacts: [art] },
    });
    const subs = await screen.findByRole('list', { name: 'Sub-agents' });
    const rows = within(subs).getAllByRole('listitem');
    expect(rows[0]!.getAttribute('aria-label')).toBe('researcher: Find the Q3 invoices');
    expect(within(rows[0]!).getByText('Done')).toBeTruthy();
    expect(within(rows[1]!).getByText('Running')).toBeTruthy();
    expect(within(rows[0]!).getByText('Found 12 invoices').tagName).toBe('PRE');
    await userEvent.click(
      within(rows[0]!).getByRole('link', { name: 'Open thread of researcher' }),
    );
    expect(window.location.pathname).toBe('/chat/sub-t');
    window.history.back();
    await screen.findByRole('heading', { name: 'Q3 report', level: 1 });

    const result = section('Result');
    expect(within(result).getByText('reconciled').tagName).toBe('STRONG');
    expect(await within(result).findByRole('img', { name: 'Totals chart' })).toBeTruthy();
    const link = within(result).getByRole('link', { name: /example\.com\/ledger/ });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(result).getByText('ledger.csv row 12').tagName).toBe('LI');
    expect(screen.queryByRole('group', { name: 'Run controls' })).toBeNull();

    // Schedule it: the new schedule starts from the run's objective.
    await userEvent.click(within(result).getByRole('button', { name: 'Schedule it' }));
    const dialog = await screen.findByRole('dialog', { name: 'New schedule' });
    expect(
      within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: 'Instructions' }).value,
    ).toBe(run.objective);
    expect(
      within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Title (optional)' }).value,
    ).toBe('Q3 report');
    expect(window.location.pathname).toBe('/work/scheduled');
    expect(window.location.search).toBe('');
    expect(hub.api.getRun).toHaveBeenCalledWith('r8');
  });

  it('ends as Output missing with the trace linked, never as done', async () => {
    const run = runView({
      id: 'r9',
      title: 'Nightly digest',
      status: 'output_missing',
      expectedOutput: { kind: 'message', ref: 'slack:#team' },
      derived: { status: 'blocked', reason: 'Output missing' },
    });
    await openRun(run, {
      m3: {
        activity: new Map([
          [
            run.threadId,
            [
              {
                id: 'a1',
                ts: '2026-10-01T12:00:00.000Z',
                kind: 'notice',
                title: 'Delivery had no receipt',
                detail: null,
                status: 'failed',
                callId: null,
                turnId: 'turn1',
              },
            ],
          ],
        ]),
      },
    });
    const result = section('Result');
    expect(
      within(result).getByText(/could not verify its delivered message \(slack:#team\)/),
    ).toBeTruthy();
    await userEvent.click(within(result).getByRole('link', { name: 'See the trace' }));
    expect(document.activeElement).toBe(section('Activity'));
    expect(within(section('Activity')).getByText('Delivery had no receipt')).toBeTruthy();
  });

  it('shows the run thread with tool cards and its approval inline', async () => {
    const run = runView({ id: 'r10', title: 'Writes a plan', status: 'waiting_approval' });
    const tid = run.threadId;
    await openRun(run, {
      messages: [
        message(tid, {
          role: 'user',
          provenance: 'run',
          parts: [{ type: 'text', text: 'Write the plan' }],
        }),
        message(tid, {
          role: 'assistant',
          status: 'streaming',
          parts: [
            { type: 'text', text: 'Writing it now.' },
            toolPart({
              callId: 'call1',
              tool: 'fs.write',
              title: 'Write file',
              status: 'awaiting_approval',
              approvalId: 'ap1',
            }),
          ],
        }),
      ],
      m3: { approvals: [approvalView(tid)] },
    });
    const log = await screen.findByRole('log', { name: 'Run conversation' });
    expect(await within(log).findByText('Write the plan')).toBeTruthy();
    expect(within(log).getByText('Writing it now.')).toBeTruthy();
    const card = within(log).getByRole('group', { name: 'Tool call: Write file' });
    expect(await within(card).findByRole('button', { name: /Allow once/ })).toBeTruthy();
    // Read-only: no message actions in a run.
    expect(within(log).queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

describe('Activity replay (FR-057)', () => {
  const items: ActivityItemView[] = [
    {
      id: 'a1',
      ts: '2026-10-01T12:00:00.000Z',
      kind: 'turn',
      title: 'Turn started',
      detail: null,
      status: null,
      callId: null,
      turnId: 't1',
    },
    {
      id: 'a2',
      ts: '2026-10-01T12:00:01.000Z',
      kind: 'tool_call',
      title: 'fs.read notes.md',
      detail: '{"path":"notes.md"}',
      status: 'ok',
      callId: 'c1',
      turnId: 't1',
    },
    {
      id: 'a3',
      ts: '2026-10-01T12:00:02.000Z',
      kind: 'approval',
      title: 'Approval for fs.write',
      detail: null,
      status: 'allow_once',
      callId: 'c2',
      turnId: 't1',
    },
  ];

  it('steps through the recorded items without running anything, and plays them', async () => {
    const run = runView({ id: 'r11', title: 'Traced', status: 'done' });
    const { hub } = await openRun(run, { m3: { activity: new Map([[run.threadId, items]]) } });
    const act = section('Activity');
    const trace = await within(act).findByRole('list', { name: 'Activity trace' });
    expect(within(trace).getAllByRole('listitem')).toHaveLength(3);
    // A step opens to its recorded details.
    await userEvent.click(within(trace).getByRole('button', { name: /fs\.read notes\.md/ }));
    expect(within(trace).getByText('{"path":"notes.md"}').tagName).toBe('PRE');
    expect(within(trace).getByText('c1')).toBeTruthy();

    await userEvent.click(within(act).getByRole('button', { name: 'Replay' }));
    const replay = within(act).getByRole('group', { name: 'Replay' });
    expect(within(replay).getByRole('status').textContent).toBe('Step 1 of 3: Turn, Turn started');
    expect(within(trace).getAllByRole('listitem')).toHaveLength(1);
    expect(within(trace).getByRole('listitem').getAttribute('aria-current')).toBe('step');
    await userEvent.click(within(replay).getByRole('button', { name: /Next step/ }));
    expect(within(replay).getByRole('status').textContent).toBe(
      'Step 2 of 3: Tool call, fs.read notes.md',
    );
    await userEvent.click(within(replay).getByRole('button', { name: /Previous step/ }));
    expect(within(replay).getByRole('status').textContent).toContain('Step 1 of 3');
    await userEvent.click(within(replay).getByRole('button', { name: /Next step/ }));
    await userEvent.click(within(replay).getByRole('button', { name: 'Play' }));
    await waitFor(
      () => expect(within(replay).getByRole('status').textContent).toContain('Step 3 of 3'),
      { timeout: 4000 },
    );
    await waitFor(() =>
      expect(within(replay).getByRole<HTMLButtonElement>('button', { name: 'Play' }).disabled).toBe(
        true,
      ),
    );
    await userEvent.click(within(replay).getByRole('button', { name: 'Exit replay' }));
    expect(within(act).queryByRole('group', { name: 'Replay' })).toBeNull();
    // Replay never wrote anything: only reads happened.
    expect(hub.api.controlRun).not.toHaveBeenCalled();
    expect(hub.api.startRun).not.toHaveBeenCalled();
    expect(hub.api.activity).toHaveBeenCalledWith(run.threadId);
  });

  it('reports a trace that cannot load and retries', async () => {
    const run = runView({ id: 'r12', title: 'No trace', status: 'done' });
    const hub = createHub({ m5work: m5WorkState({ runs: [run] }) });
    hub.state.failNext.activity = new Error('Trace store offline');
    await renderApp({ hub, path: '/work/r12' });
    const act = await screen.findByRole('region', { name: 'Activity' });
    expect(await within(act).findByText('Trace store offline')).toBeTruthy();
    await userEvent.click(within(act).getByRole('button', { name: 'Retry' }));
    expect(await within(act).findByText('Nothing has happened in this run yet.')).toBeTruthy();
  });
});
