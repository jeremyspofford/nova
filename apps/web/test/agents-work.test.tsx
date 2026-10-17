// What an agent works on: responsibilities (FR-079), its goal (FR-181) and its schedules and
// self-set wakes (FR-059, FR-206, FR-189), plus the Scheduled list naming the agent that set a
// wake and why. Goals and schedules live in the Work state, as /goals and /schedules act on them.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentGoal } from '../src/agents/AgentGoal.tsx';
import { AgentResponsibilities } from '../src/agents/AgentResponsibilities.tsx';
import { AgentSchedules } from '../src/agents/AgentSchedules.tsx';
import { ScheduledView } from '../src/work/ScheduledView.tsx';
import { goalView, m5WorkState, scheduleView } from './fakes-m5-work.ts';
import { agentView, renderWithAgents, responsibilityView } from './fakes-m6-agents.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

describe('responsibilities (FR-079)', () => {
  const AG = () =>
    agentView({
      id: 'ag1',
      responsibilities: [
        responsibilityView({ id: 'r1', agentId: 'ag1', title: 'Watch the inbox', position: 0 }),
        responsibilityView({
          id: 'r2',
          agentId: 'ag1',
          title: 'Weekly digest',
          position: 1,
          goalId: 'g1',
          progressNote: 'Drafted 3 of 5 sections',
        }),
      ],
    });

  it('lists them with the agent’s progress and the goal they hold', async () => {
    let opened = false;
    await renderWithAgents(
      <AgentResponsibilities
        agentId="ag1"
        goalId="g1"
        version={0}
        onOpenGoal={() => (opened = true)}
      />,
      { agents: { agents: [AG()] } },
    );
    const digest = await screen.findByRole('listitem', { name: 'Weekly digest' });
    expect(within(digest).getByText('Drafted 3 of 5 sections')).toBeTruthy();
    await userEvent.click(within(digest).getByRole('button', { name: /Holds the agent/ }));
    expect(opened).toBe(true);
  });

  it('adds, edits, reorders, changes status and deletes', async () => {
    const r = await renderWithAgents(
      <AgentResponsibilities
        agentId="ag1"
        goalId={null}
        version={0}
        onOpenGoal={() => undefined}
      />,
      { agents: { agents: [AG()] } },
    );
    await screen.findByRole('list', { name: 'Responsibilities' });
    await userEvent.click(screen.getByRole('button', { name: 'Add a responsibility' }));
    const form = screen.getByRole('form', { name: 'New responsibility' });
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'Responsibility' }),
      'Triage bugs',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('listitem', { name: 'Triage bugs' })).toBeTruthy();

    const inbox = screen.getByRole('listitem', { name: 'Watch the inbox' });
    await userEvent.selectOptions(
      within(inbox).getByRole('combobox', { name: 'Status of Watch the inbox' }),
      'paused',
    );
    await waitFor(() =>
      expect(r.state.agents[0]?.responsibilities.find((x) => x.id === 'r1')?.status).toBe('paused'),
    );

    await userEvent.click(within(inbox).getByRole('button', { name: 'Move Watch the inbox down' }));
    await waitFor(() => {
      const names = within(screen.getByRole('list', { name: 'Responsibilities' }))
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-label'));
      expect(names.slice(0, 2)).toEqual(['Weekly digest', 'Watch the inbox']);
    });
    await waitFor(() =>
      expect(r.state.agents[0]?.responsibilities.find((x) => x.id === 'r1')?.position).toBe(1),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Edit Weekly digest' }));
    const edit = screen.getByRole('form', { name: 'Edit Weekly digest' });
    const title = within(edit).getByRole('textbox', { name: 'Responsibility' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Monthly digest');
    await userEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('listitem', { name: 'Monthly digest' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Delete Monthly digest' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete this responsibility?' })).getByRole(
        'button',
        { name: 'Delete' },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'Monthly digest' })).toBeNull(),
    );
    expect(r.state.agents[0]?.responsibilities.map((x) => x.title)).toEqual([
      'Watch the inbox',
      'Triage bugs',
    ]);
  });
});

describe('the agent goal (FR-181)', () => {
  it('sets a goal held by a responsibility, edits it, pauses it and sets its budget', async () => {
    let changes = 0;
    const r = await renderWithAgents(
      <AgentGoal agentId="ag1" version={0} onChanged={() => (changes += 1)} />,
      {
        agents: {
          agents: [
            agentView({
              id: 'ag1',
              responsibilities: [responsibilityView({ id: 'r1', agentId: 'ag1', title: 'Inbox' })],
            }),
          ],
        },
      },
    );
    await screen.findByText(/No goal\./);
    await userEvent.click(screen.getByRole('button', { name: 'Set a goal' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Goal objective' }),
      'Reach inbox zero',
    );
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Held by' }), 'r1');
    await userEvent.click(screen.getByRole('button', { name: 'Set goal' }));
    expect(await screen.findByText('Reach inbox zero')).toBeTruthy();
    expect(r.api.setAgentGoal).toHaveBeenCalledWith('ag1', {
      objective: 'Reach inbox zero',
      responsibilityId: 'r1',
    });
    const goal = r.hub.state.m5work.goals[0];
    expect(goal?.agentId).toBe('ag1');

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const text = screen.getByRole('textbox', { name: 'Goal objective' });
    await userEvent.clear(text);
    await userEvent.type(text, 'Reach inbox zero by Friday');
    await userEvent.click(screen.getByRole('button', { name: 'Save goal' }));
    expect(await screen.findByText('Reach inbox zero by Friday')).toBeTruthy();
    expect(r.hub.api.updateGoal).toHaveBeenCalledWith(goal?.id, {
      objective: 'Reach inbox zero by Friday',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Pause goal' }));
    expect(await screen.findByRole('button', { name: 'Resume goal' })).toBeTruthy();
    expect(r.hub.state.m5work.goals[0]?.status).toBe('paused');

    await userEvent.click(screen.getByRole('button', { name: 'Goal budget…' }));
    const dialog = screen.getByRole('dialog', { name: 'Goal budget' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Tokens' }), '500');
    expect(within(dialog).getByText('Enter at least 1,000 tokens.')).toBeTruthy();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Tokens' }), '00');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Time (minutes)' }), '90');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save budget' }));
    await waitFor(() =>
      expect(r.hub.state.m5work.goals[0]?.budgets).toEqual({ timeSeconds: 5400, tokens: 50_000 }),
    );
    expect(await screen.findByText(/of 1 h 30 min/)).toBeTruthy();
    expect(changes).toBeGreaterThanOrEqual(4);
  });

  it('shows a blocked goal and its blocker, clears it after a confirmation', async () => {
    const r = await renderWithAgents(
      <AgentGoal agentId="ag1" version={0} onChanged={() => undefined} />,
      {
        agents: { agents: [agentView({ id: 'ag1' })] },
        hub: {
          m5work: m5WorkState({
            goals: [
              goalView({
                id: 'g1',
                agentId: 'ag1',
                objective: 'Ship the report',
                status: 'blocked',
                blocker: { key: 'no-access', description: 'No access to the drive', count: 3 },
                progressNote: 'Outline done',
              }),
            ],
          }),
        },
      },
    );
    expect(await screen.findByText('No access to the drive')).toBeTruthy();
    expect(screen.getByText('Outline done')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume goal' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Clear goal' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear the goal?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear goal' }));
    expect(await screen.findByText(/No goal\./)).toBeTruthy();
    expect(r.hub.state.m5work.goals).toHaveLength(0);
  });

  it('keeps a completed goal readable and offers a new one', async () => {
    const r = await renderWithAgents(
      <AgentGoal agentId="ag1" version={0} onChanged={() => undefined} />,
      {
        agents: { agents: [agentView({ id: 'ag1' })] },
        hub: {
          m5work: m5WorkState({
            goals: [
              goalView({
                id: 'g1',
                agentId: 'ag1',
                objective: 'Old goal',
                status: 'complete',
                completionSummary: 'All done',
              }),
            ],
          }),
        },
      },
    );
    expect(await screen.findByText('All done')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear goal' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Set a new goal' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Goal objective' }), 'New goal');
    await userEvent.click(screen.getByRole('button', { name: 'Set goal' }));
    expect(await screen.findByText('New goal')).toBeTruthy();
    expect(r.hub.state.m5work.goals.map((g) => g.objective)).toEqual(['Old goal', 'New goal']);
  });
});

describe('schedules and self-set wakes (FR-059, FR-206)', () => {
  const work = () =>
    m5WorkState({
      schedules: [
        scheduleView({
          id: 's1',
          title: 'Check back on the build',
          when: { at: '2026-10-20T09:00:00.000Z' },
          origin: 'agent_self',
          agentId: 'ag1',
          wakeReason: 'The CI run takes an hour',
          instructions: 'Look at the CI result',
        }),
        scheduleView({
          id: 's2',
          title: 'Morning check',
          agentId: 'ag1',
          origin: 'user',
        }),
        scheduleView({ id: 's3', title: 'Someone else', agentId: 'ag2', origin: 'agent_self' }),
      ],
    });

  it('marks who set each one and why, and pauses and cancels them', async () => {
    const agent = agentView({ id: 'ag1', name: 'Scout' });
    const r = await renderWithAgents(<AgentSchedules agent={agent} version={0} />, {
      agents: { agents: [agent] },
      hub: { m5work: work() },
    });
    const list = await screen.findByRole('list', { name: 'Agent schedules' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    const wake = within(list).getByRole('listitem', { name: 'Check back on the build' });
    expect(within(wake).getByText('Set by Scout')).toBeTruthy();
    expect(within(wake).getByText('The CI run takes an hour')).toBeTruthy();
    const mine = within(list).getByRole('listitem', { name: 'Morning check' });
    expect(within(mine).getByText('Set by you')).toBeTruthy();

    await userEvent.click(within(mine).getByRole('button', { name: 'Pause Morning check' }));
    await waitFor(() =>
      expect(r.hub.state.m5work.schedules.find((s) => s.id === 's2')?.enabled).toBe(false),
    );
    expect(await within(mine).findByText('Next: Paused')).toBeTruthy();

    await userEvent.click(
      within(wake).getByRole('button', { name: 'Cancel Check back on the build' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Cancel this schedule?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel schedule' }));
    await waitFor(() =>
      expect(r.hub.state.m5work.schedules.some((s) => s.id === 's1')).toBe(false),
    );
  });

  it('changes only the time of a wake the agent set', async () => {
    const agent = agentView({ id: 'ag1', name: 'Scout' });
    const r = await renderWithAgents(<AgentSchedules agent={agent} version={0} />, {
      agents: { agents: [agent] },
      hub: { m5work: work() },
    });
    const wake = await screen.findByRole('listitem', { name: 'Check back on the build' });
    await userEvent.click(
      within(wake).getByRole('button', { name: 'Change Check back on the build' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Change the time' });
    expect(within(dialog).getByText('Look at the CI result')).toBeTruthy();
    expect(within(dialog).queryByRole('textbox', { name: 'Instructions' })).toBeNull();
    const at = within(dialog).getByLabelText<HTMLInputElement>('Date and time');
    await userEvent.clear(at);
    await userEvent.type(at, '2026-10-21T10:30');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(r.hub.api.updateSchedule).toHaveBeenCalled());
    const [, body] = r.hub.api.updateSchedule.mock.calls[0] ?? [];
    expect(body).not.toHaveProperty('instructions');
    expect(body).toHaveProperty('when.at');
  });

  it('creates a schedule that wakes the agent, and is paused with it', async () => {
    const agent = agentView({ id: 'ag1', name: 'Scout', status: 'paused', pauseReason: 'user' });
    const r = await renderWithAgents(<AgentSchedules agent={agent} version={0} />, {
      agents: { agents: [agent] },
    });
    expect(await screen.findByText(/Nothing scheduled\./)).toBeTruthy();
    expect(screen.getByText('Paused with the agent. They go on when you resume it.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'New schedule' }));
    const dialog = screen.getByRole('dialog', { name: 'New schedule' });
    const save = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Schedule' });
    expect(save.disabled).toBe(true);
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Instructions' }),
      'Summarize new tickets',
    );
    await userEvent.click(save);
    await waitFor(() => expect(r.api.createAgentSchedule).toHaveBeenCalled());
    expect(r.api.createAgentSchedule).toHaveBeenCalledWith(
      'ag1',
      expect.objectContaining({
        instructions: 'Summarize new tickets',
        when: { cron: '0 9 * * *' },
      }),
    );
    expect(r.hub.state.m5work.schedules[0]).toMatchObject({ agentId: 'ag1', origin: 'user' });
    expect(await screen.findByRole('list', { name: 'Agent schedules' })).toBeTruthy();
  });
});

describe('the Scheduled list names the agent (FR-206)', () => {
  it('shows "Set by <agent>" with the wake reason and links to the agent', async () => {
    window.history.replaceState(null, '', '/work/scheduled');
    await renderWithAgents(<ScheduledView />, {
      agents: { agents: [agentView({ id: 'ag1', name: 'Scout' })] },
      hub: {
        m5work: m5WorkState({
          schedules: [
            scheduleView({
              id: 's1',
              title: 'Check back on the build',
              origin: 'agent_self',
              agentId: 'ag1',
              wakeReason: 'The CI run takes an hour',
            }),
            scheduleView({ id: 's2', title: 'For the agent', origin: 'user', agentId: 'ag1' }),
            scheduleView({ id: 's3', title: 'Gone agent', origin: 'agent_self', agentId: 'ag9' }),
            scheduleView({ id: 's4', title: 'Plain' }),
          ],
        }),
      },
    });
    const list = await screen.findByRole('list', { name: 'Schedules' });
    const wake = within(list).getByRole('listitem', { name: 'Check back on the build' });
    const link = await within(wake).findByRole('link', { name: 'Set by Scout' });
    expect(link.getAttribute('href')).toBe('/agents/ag1');
    expect(within(wake).getByText('The CI run takes an hour')).toBeTruthy();
    expect(
      within(within(list).getByRole('listitem', { name: 'For the agent' })).getByText('For Scout'),
    ).toBeTruthy();
    // An agent that no longer exists keeps the plain words.
    expect(
      within(within(list).getByRole('listitem', { name: 'Gone agent' })).getByText('Set by agent'),
    ).toBeTruthy();
    expect(
      within(within(list).getByRole('listitem', { name: 'Plain' })).queryByText(/Set by|For /),
    ).toBeNull();
  });
});
