// The Agents list and the sidebar rows (FR-079, FR-090, FR-215; docs/04 §1, §1.1): status chips
// with Needs input first, the agent's own state as a badge, empty and error states, live updates;
// and creating an agent (FR-079) with the defaults from Settings → Agents, the Hub's refusal of an
// autonomous agent without a reviewer model, and an optional first goal.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { AgentsView } from '../src/agents/AgentsView.tsx';
import { SidebarAgents } from '../src/agents/SidebarAgents.tsx';
import { FakeEventSource } from './fakes.ts';
import {
  agentView,
  renderWithAgents,
  responsibilityView,
  suggestionView,
} from './fakes-m6-agents.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const at = (path: string) => window.history.replaceState(null, '', path);
const stream = () => FakeEventSource.for('/api/v1/events/stream');

describe('the Agents list (FR-079, FR-215)', () => {
  it('lists agents by status with their state, activity and suggestions', async () => {
    at('/agents');
    await renderWithAgents(<AgentsView id={null} />, {
      agents: {
        agents: [
          agentView({ id: 'a1', name: 'Ready one', lastActiveAt: '2026-10-01T11:00:00.000Z' }),
          agentView({
            id: 'a2',
            name: 'Waiting one',
            derived: { status: 'needs_input', reason: 'Approval needed' },
            openSuggestions: 2,
          }),
          agentView({
            id: 'a3',
            name: 'Paused one',
            status: 'paused',
            pauseReason: 'safety',
            derived: { status: 'blocked', reason: 'Paused for safety' },
            responsibilities: [responsibilityView({ agentId: 'a3' })],
          }),
        ],
        suggestions: [],
      },
    });
    const list = await screen.findByRole('list', { name: 'Agents' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByRole('link').textContent)).toEqual([
      'Waiting one',
      'Paused one',
      'Ready one',
    ]);
    const [waiting, paused, ready] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(waiting).getByText('Needs input: Approval needed')).toBeTruthy();
    expect(within(paused).getByText('Paused for safety', { selector: '.ws-badge' })).toBeTruthy();
    expect(within(paused).getByText('1 responsibility')).toBeTruthy();
    expect(within(paused).getByText('Not active yet')).toBeTruthy();
    expect(within(ready).getByText('Ready')).toBeTruthy();
    expect(within(ready).getByText(/^Active /)).toBeTruthy();
    expect(within(ready).getByRole('link').getAttribute('href')).toBe('/agents/a1');
  });

  it('counts open suggestions from the Hub', async () => {
    at('/agents');
    await renderWithAgents(<AgentsView id={null} />, {
      agents: {
        agents: [agentView({ id: 'a1', name: 'Scout' })],
        suggestions: [suggestionView({ agentId: 'a1' }), suggestionView({ agentId: 'a1' })],
      },
    });
    expect(await screen.findByText('2 suggestions')).toBeTruthy();
  });

  it('starts empty with a way to create one', async () => {
    at('/agents');
    await renderWithAgents(<AgentsView id={null} />);
    expect(await screen.findByRole('heading', { name: 'No agents yet' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Create an agent' }));
    expect(window.location.pathname).toBe('/agents/new');
  });

  it('reports a load failure and retries', async () => {
    at('/agents');
    await renderWithAgents(<AgentsView id={null} />, {
      agents: { agents: [agentView({ id: 'a1', name: 'Scout' })] },
      failNext: {
        listAgents: new ApiError(500, {
          code: 'server_error',
          message: 'Hub is busy',
          retryable: true,
        }),
      },
    });
    expect(await screen.findByText('Hub is busy')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Scout' })).toBeTruthy();
    expect(screen.queryByText('Hub is busy')).toBeNull();
  });

  it('follows agent events and status changes of their threads', async () => {
    at('/agents');
    const r = await renderWithAgents(<AgentsView id={null} />, {
      agents: { agents: [agentView({ id: 'a1', name: 'Scout' })] },
    });
    await screen.findByRole('link', { name: 'Scout' });
    r.state.agents = [
      ...r.state.agents,
      agentView({ id: 'a2', name: 'Herald', derived: { status: 'running', reason: null } }),
    ];
    stream().emit('agent.created', { agentId: 'a2' });
    expect(await screen.findByRole('link', { name: 'Herald' })).toBeTruthy();
    r.state.agents = r.state.agents.map((a) =>
      a.id === 'a1' ? { ...a, derived: { status: 'needs_input', reason: null } } : a,
    );
    stream().emit('thread.status.changed', { ref: { kind: 'thread', id: 't-a1' } });
    await waitFor(() => {
      const rows = within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('listitem');
      expect(within(rows[0] as HTMLElement).getByText('Needs input')).toBeTruthy();
    });
  });
});

describe('the sidebar rows (FR-215)', () => {
  it('lists agents with avatars, marks and chips, and nothing when there are none', async () => {
    const r = await renderWithAgents(<SidebarAgents selectedId="a2" />, {
      agents: {
        agents: [
          agentView({ id: 'a1', name: 'Scout', hasAvatar: true }),
          agentView({
            id: 'a2',
            name: 'Herald',
            status: 'stopped',
            derived: { status: 'running', reason: null },
          }),
        ],
      },
    });
    const list = await screen.findByRole('list', { name: 'Agents' });
    const herald = within(list).getByRole('link', { name: /Herald/ });
    expect(herald.getAttribute('aria-current')).toBe('page');
    expect(herald.textContent).toContain(', stopped');
    expect(within(herald).getByText('Running')).toBeTruthy();
    const scout = within(list).getByRole('link', { name: /Scout/ });
    expect(scout.querySelector('img')?.getAttribute('src')).toMatch(
      /^\/api\/v1\/agents\/a1\/avatar\?v=/,
    );
    // Ready agents carry no chip.
    expect(within(scout).queryByText('Ready')).toBeNull();
    await userEvent.click(scout);
    expect(window.location.pathname).toBe('/agents/a1');
    r.unmount();
  });

  it('renders nothing without agents', async () => {
    const r = await renderWithAgents(<SidebarAgents selectedId={null} />);
    await waitFor(() => expect(r.api.listAgents).toHaveBeenCalled());
    expect(screen.queryByRole('list', { name: 'Agents' })).toBeNull();
  });
});

describe('creating an agent (FR-079)', () => {
  it('starts from the Settings defaults and creates the agent with its responsibilities', async () => {
    at('/agents/new');
    const r = await renderWithAgents(<AgentsView id="new" />, {
      settings: {
        'agents.autonomy': 'ask_first',
        'agents.defaultBudgets': { timeSeconds: 600, tokens: 20_000, costUsd: 2 },
        'agents.proactive': { enabledByDefault: false, intervalMinutes: 60 },
      },
    });
    await screen.findByRole('heading', { name: 'New agent', level: 1 });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Ask first' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Time (minutes)' }).value).toBe(
      '10',
    );
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Tokens' }).value).toBe('20000');
    expect(
      screen.getByRole('switch', { name: 'Proactive research' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.getByRole('switch', { name: 'Memory' }).getAttribute('aria-checked')).toBe(
      'true',
    );

    // A name is required.
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(await screen.findByText('Give the agent a name.')).toBeTruthy();
    expect(r.api.createAgent).not.toHaveBeenCalled();

    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Scout');
    await userEvent.type(screen.getByRole('textbox', { name: 'Instructions' }), 'Watch #help.');
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Responsibility 1' }),
      'Answer support questions',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add a responsibility' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Responsibility 2' }),
      'Weekly digest',
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Goal (optional)' }),
      'Clear the support backlog',
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Proactive research' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(r.api.createAgent).toHaveBeenCalled());
    expect(r.api.createAgent).toHaveBeenCalledWith({
      name: 'Scout',
      instructions: 'Watch #help.',
      responsibilities: [{ title: 'Answer support questions' }, { title: 'Weekly digest' }],
      autonomy: 'ask_first',
      budgets: { timeSeconds: 600, tokens: 20_000, costUsd: 2 },
      proactive: true,
      memoryEnabled: true,
    });
    const created = r.state.agents[0];
    expect(created?.name).toBe('Scout');
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${created?.id ?? ''}`));
    // The goal is held by the first responsibility.
    expect(r.api.setAgentGoal).toHaveBeenCalledWith(created?.id, {
      objective: 'Clear the support backlog',
      responsibilityId: created?.responsibilities[0]?.id,
    });
    expect(r.hub.state.m5work.goals[0]?.objective).toBe('Clear the support backlog');
  });

  it('checks budgets, and shows the Hub refusing an autonomous agent without a reviewer', async () => {
    at('/agents/new');
    const r = await renderWithAgents(<AgentsView id="new" />);
    await screen.findByRole('heading', { name: 'New agent', level: 1 });
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Scout');
    const tokens = screen.getByRole('textbox', { name: 'Tokens' });
    await userEvent.clear(tokens);
    await userEvent.type(tokens, '50');
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(await screen.findByText('Enter tokens from 1,000 to 100,000,000.')).toBeTruthy();
    expect(r.api.createAgent).not.toHaveBeenCalled();
    await userEvent.clear(tokens);
    await userEvent.type(tokens, '5000');

    await userEvent.click(screen.getByRole('radio', { name: 'Autonomous' }));
    expect(screen.getByRole('note').textContent).toContain('No reviewer model is chosen yet');
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(
      await screen.findByText('an autonomous agent needs a reviewer model: choose one in Settings'),
    ).toBeTruthy();
    expect(r.state.agents).toHaveLength(0);
    expect(window.location.pathname).toBe('/agents/new');
  });

  it('removes a responsibility row and cancels back to the list', async () => {
    at('/agents/new');
    await renderWithAgents(<AgentsView id="new" />);
    await screen.findByRole('heading', { name: 'New agent', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Add a responsibility' }));
    expect(screen.getByRole('textbox', { name: 'Responsibility 2' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove responsibility 2' }));
    expect(screen.queryByRole('textbox', { name: 'Responsibility 2' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(window.location.pathname).toBe('/agents');
  });

  it('previews a chosen avatar and refuses files that are not images or too large', async () => {
    at('/agents/new');
    const r = await renderWithAgents(<AgentsView id="new" />);
    await screen.findByRole('heading', { name: 'New agent', level: 1 });
    const input = screen.getByLabelText<HTMLInputElement>('Avatar image');
    await userEvent.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }), {
      applyAccept: false,
    });
    expect(await screen.findByText('Choose a PNG, JPEG or WebP image.')).toBeTruthy();
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    await userEvent.upload(input, big);
    expect(await screen.findByText(/the limit is 2 MB/)).toBeTruthy();
    await userEvent.upload(input, new File(['png'], 'me.png', { type: 'image/png' }));
    const preview = await screen.findByRole('img', { name: 'New avatar preview' });
    expect(preview.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Scout');
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(r.api.createAgent).toHaveBeenCalled());
    expect(r.state.agents[0]?.hasAvatar).toBe(true);
  });
});
