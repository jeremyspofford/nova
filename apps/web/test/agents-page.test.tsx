// One agent (FR-079..FR-090; docs/04 §2.5): the header with its status chip and own state, the
// controls (Pause stops its schedules until Resume, Stop, Research now, Delete with the Hub's
// notice), the conversation (its main thread with the chat's composer; another thread read-only),
// sections opened by `?tab=`, live updates, and the missing and failing cases.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_DELETE_NOTICE } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { AgentsView } from '../src/agents/AgentsView.tsx';
import { FakeEventSource, message } from './fakes.ts';
import { m5WorkState, scheduleView } from './fakes-m5-work.ts';
import {
  activityItem,
  agentThreadView,
  agentView,
  bindingView,
  renderWithAgents,
  type M6AgentsState,
} from './fakes-m6-agents.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const stream = () => FakeEventSource.for('/api/v1/events/stream');
const SCOUT = (over = {}) =>
  agentView({
    id: 'ag1',
    name: 'Scout',
    primaryThreadId: 't-main',
    lastActiveAt: '2026-10-01T11:00:00.000Z',
    usage: { timeSeconds: 7200, tokens: 1_200_000, costUsd: 0.4 },
    ...over,
  });

async function openAgent(
  path = '/agents/ag1',
  agents: Partial<Omit<M6AgentsState, 'work'>> = {},
  opts: Parameters<typeof renderWithAgents>[1] = {},
) {
  window.history.replaceState(null, '', path);
  const r = await renderWithAgents(<AgentsView id="ag1" />, {
    ...opts,
    agents: {
      agents: [SCOUT()],
      threads: [agentThreadView({ threadId: 't-main', agentId: 'ag1', kind: 'main' })],
      ...agents,
    },
  });
  const page = await screen.findByRole('region', { name: 'Agent: Scout' });
  return { ...r, page };
}

const controls = () => screen.getByRole('group', { name: 'Agent controls' });

describe('the agent page (FR-079, FR-090)', () => {
  it('shows who it is, its state and use, and its main thread with a composer', async () => {
    const { page, hub } = await openAgent('/agents/ag1', {
      agents: [
        SCOUT({
          derived: { status: 'needs_input', reason: 'Approval needed' },
          budgets: { timeSeconds: 1800, tokens: 500_000, costUsd: null },
        }),
      ],
    });
    expect(within(page).getByRole('heading', { name: 'Scout', level: 1 })).toBeTruthy();
    expect(within(page).getByText('Needs input: Approval needed')).toBeTruthy();
    expect(within(page).getByText('Autonomy: Standard')).toBeTruthy();
    expect(within(page).getByText('Used so far: 2 h · 1.2M tokens · $0.40')).toBeTruthy();
    expect(
      within(page).getByText('Each piece of work: 30 min · 0.5M tokens · provider spend cap'),
    ).toBeTruthy();
    // The main thread is the chat's own view: typing sends to the agent's thread.
    const input = await within(page).findByRole('textbox', { name: 'Message' });
    await userEvent.type(input, 'Check the inbox{Enter}');
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenCalledWith(
        't-main',
        expect.objectContaining({ text: 'Check the inbox' }),
      ),
    );
    // Activity is the first section.
    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('pauses with its schedules, resumes them, and says a paused agent will not answer', async () => {
    const { hub } = await openAgent(
      '/agents/ag1',
      {},
      {
        hub: {
          m5work: m5WorkState({
            schedules: [scheduleView({ id: 's1', agentId: 'ag1', title: 'Morning check' })],
          }),
        },
      },
    );
    await userEvent.click(within(controls()).getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('Paused', { selector: '.ws-badge' })).toBeTruthy();
    expect(screen.getByText('Paused: it will not answer until you resume it.')).toBeTruthy();
    expect(hub.state.m5work.schedules[0]?.enabled).toBe(false);
    // Research waits for the agent to resume.
    expect(
      within(controls()).getByRole<HTMLButtonElement>('button', { name: 'Research now' }).disabled,
    ).toBe(true);
    await userEvent.click(within(controls()).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(screen.queryByText('Paused', { selector: '.ws-badge' })).toBeNull());
    expect(hub.state.m5work.schedules[0]?.enabled).toBe(true);
  });

  it('stops current work, then resumes; a conflict from the Hub is reported', async () => {
    const r = await openAgent();
    await userEvent.click(within(controls()).getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped', { selector: '.ws-badge' })).toBeTruthy();
    expect(
      screen.getByText(/its current work was cancelled and partial results kept/),
    ).toBeTruthy();
    expect(within(controls()).queryByRole('button', { name: 'Stop' })).toBeNull();
    // Someone resumed it elsewhere: the Hub answers 409 and the page says so.
    r.state.agents = r.state.agents.map((a) => ({ ...a, status: 'active' as const }));
    const resume = within(controls()).getAllByRole('button', { name: 'Resume' })[0];
    if (!resume) throw new Error('no Resume button');
    await userEvent.click(resume);
    expect(await screen.findByText('Could not resume: the agent is not paused')).toBeTruthy();
  });

  it('starts research now, and says why when it cannot', async () => {
    const r = await openAgent();
    await userEvent.click(within(controls()).getByRole('button', { name: 'Research now' }));
    expect(
      await screen.findByText('Research started. Findings arrive as suggestions.'),
    ).toBeTruthy();
    expect(r.state.researching).toEqual(['ag1']);
    await userEvent.click(within(controls()).getByRole('button', { name: 'Research now' }));
    expect(
      await screen.findByText('Research did not start: research is already running.'),
    ).toBeTruthy();
  });

  it('deletes only after the confirmation with the Hub notice', async () => {
    const r = await openAgent();
    await userEvent.click(within(controls()).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Scout?' });
    expect(within(dialog).getByText(AGENT_DELETE_NOTICE)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep the agent' }));
    expect(r.api.deleteAgent).not.toHaveBeenCalled();
    await userEvent.click(within(controls()).getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(window.location.pathname).toBe('/agents'));
    expect(r.api.deleteAgent).toHaveBeenCalledWith('ag1');
    expect(r.state.agents).toHaveLength(0);
  });

  it('keeps the agent when the delete fails', async () => {
    await openAgent(
      '/agents/ag1',
      {},
      {
        failNext: {
          deleteAgent: new ApiError(500, {
            code: 'server_error',
            message: 'revoking its bindings failed; try again',
            retryable: true,
          }),
        },
      },
    );
    await userEvent.click(within(controls()).getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(
      await screen.findByText('Could not delete it: revoking its bindings failed; try again'),
    ).toBeTruthy();
    expect(window.location.pathname).toBe('/agents/ag1');
  });

  it('explains a safety pause', async () => {
    await openAgent('/agents/ag1', {
      agents: [
        SCOUT({
          status: 'paused',
          pauseReason: 'safety',
          statusDetail: 'Too many denied actions',
          derived: { status: 'blocked', reason: 'Paused for safety' },
        }),
      ],
    });
    expect(screen.getByText('Blocked: Paused for safety')).toBeTruthy();
    expect(screen.getByText(/Safety monitoring paused this agent/).textContent).toContain(
      'Safety monitoring paused this agent: Too many denied actions. Review its activity',
    );
  });

  it('opens a section from the address and keeps the choice in it', async () => {
    await openAgent('/agents/ag1?tab=rules');
    expect(screen.getByRole('tab', { name: 'Rules' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { name: 'Rules', level: 2 })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Memory' }));
    expect(window.location.search).toBe('?tab=memory');
    expect(await screen.findByRole('heading', { name: 'Memory', level: 2 })).toBeTruthy();
  });

  it('follows its events: a pause elsewhere, new activity, and its deletion', async () => {
    const r = await openAgent();
    expect(await screen.findByText(/Nothing yet/)).toBeTruthy();
    r.state.agents = r.state.agents.map((a) => ({
      ...a,
      status: 'paused' as const,
      pauseReason: 'user' as const,
    }));
    r.state.activity = { ag1: [activityItem({ title: 'Agent paused', status: 'paused' })] };
    stream().emit('agent.paused', { agentId: 'ag1', reason: 'user' });
    expect(await screen.findByText('Paused', { selector: '.ws-badge' })).toBeTruthy();
    expect(await screen.findByText('Agent paused')).toBeTruthy();
    // Another agent's events are ignored.
    const calls = r.api.getAgent.mock.calls.length;
    stream().emit('agent.updated', { agentId: 'other' });
    await new Promise((res) => setTimeout(res, 250));
    expect(r.api.getAgent.mock.calls.length).toBe(calls);
    stream().emit('agent.deleted', { agentId: 'ag1' });
    expect(await screen.findByText('This agent was deleted.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says when the agent does not exist, and retries other failures', async () => {
    window.history.replaceState(null, '', '/agents/ag9');
    await renderWithAgents(<AgentsView id="ag9" />);
    expect(await screen.findByText('This agent was deleted or does not exist.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    resetDom();

    window.history.replaceState(null, '', '/agents/ag1');
    await renderWithAgents(<AgentsView id="ag1" />, {
      agents: { agents: [SCOUT()] },
      failNext: {
        getAgent: new ApiError(500, { code: 'x', message: 'Hub is busy', retryable: true }),
      },
    });
    expect(await screen.findByText('Hub is busy')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Scout', level: 1 })).toBeTruthy();
  });

  it('shows a channel thread read-only with its approvals, and goes back to the main thread', async () => {
    const r = await openAgent('/agents/ag1?tab=threads', {
      threads: [
        agentThreadView({ threadId: 't-main', agentId: 'ag1', kind: 'main' }),
        agentThreadView({
          threadId: 't-slack',
          agentId: 'ag1',
          kind: 'binding',
          bindingRef: 'cb1',
          audience: 'shared',
        }),
      ],
      channels: [bindingView({ id: 'cb1', agentId: 'ag1', label: '#support' })],
    });
    r.hub.state.messages.set('t-slack', [
      message('t-slack', { role: 'user', parts: [{ type: 'text', text: 'Can you help?' }] }),
    ]);
    const list = await screen.findByRole('list', { name: 'Agent threads' });
    const row = await within(list).findByRole('listitem', { name: 'Slack · #support' });
    expect(within(row).getByText('Shared')).toBeTruthy();
    expect(
      within(within(list).getByRole('listitem', { name: 'Main thread' })).getByText(
        'Shown in the conversation',
      ),
    ).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Show Slack · #support' }));
    const log = await screen.findByRole('region', { name: 'Slack · #support' });
    expect(within(log).getByText(/Read-only here: answer in the channel/)).toBeTruthy();
    expect(await within(log).findByText('Can you help?')).toBeTruthy();
    expect(within(log).queryByRole('textbox', { name: 'Message' })).toBeNull();
    await userEvent.click(within(log).getByRole('button', { name: 'Main thread' }));
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeTruthy();
  });
});
