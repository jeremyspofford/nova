// Team agents (FR-091) and plugins per agent (FR-045): everyone sees the team agents and gives
// them tasks (which run under the agent's identity); the owner provisions them, binds write-only
// credentials, answers their approvals and reads their audit; a member never sees those owner
// sections. An agent's page in Agents chooses which plugins it may use.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { AgentPluginsSection } from '../src/team/AgentPlugins.tsx';
import { TeamAgentPage } from '../src/team/TeamAgentPage.tsx';
import { NewTeamAgent, TeamAgentsList } from '../src/team/TeamAgentsList.tsx';
import { FakeEventSource, createHub } from './fakes.ts';
import { plugin } from './fakes-m4-settings.ts';
import {
  MEMBER_ID,
  OWNER_ID,
  approval,
  auditEntry,
  renderWithTeam,
  teamAgent,
  teamTask,
} from './fakes-m7-team.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const events = () => FakeEventSource.for('/api/v1/events/stream');
const desk = () =>
  teamAgent({
    agentId: 'ta-1',
    name: 'Support desk',
    credentials: [
      {
        id: 'cred-1',
        kind: 'provider',
        label: 'OpenAI for support',
        refId: 'pa-9',
        secretRef: 'secret://providers/pa-9',
        createdAt: '2026-10-01T12:00:00.000Z',
      },
    ],
  });

describe('Team → Team agents', () => {
  it('lists agents for everyone; only the owner can provision', async () => {
    await renderWithTeam(<TeamAgentsList />, { team: { agents: [desk()] } });
    const list = await screen.findByRole('list', { name: 'Team agents' });
    expect(within(list).getByRole('link', { name: 'Support desk' }).getAttribute('href')).toBe(
      '/team/agents/ta-1',
    );
    expect(list.textContent).toContain('1 credential');
    expect(screen.getByRole('link', { name: 'Provision an agent' })).toBeTruthy();
    resetDom();
    await renderWithTeam(<TeamAgentsList />, { as: 'member', team: { agents: [desk()] } });
    const memberList = await screen.findByRole('list', { name: 'Team agents' });
    // A member never sees the credentials, not even how many.
    expect(memberList.textContent).not.toContain('credential');
    expect(screen.queryByRole('link', { name: 'Provision an agent' })).toBeNull();
  });

  it('says what to do when there are none, and shows recent tasks live', async () => {
    const { state } = await renderWithTeam(<TeamAgentsList />, { as: 'member' });
    expect(await screen.findByText('The owner of this Hub has not set one up.')).toBeTruthy();
    expect(screen.getByText('No tasks yet. Open an agent to give it one.')).toBeTruthy();
    state.agents = [desk()];
    state.tasks = [teamTask({ id: 'task-1', agentId: 'ta-1', requestedBy: MEMBER_ID })];
    events().emit('team.task.updated', { taskId: 'task-1', agentId: 'ta-1', status: 'done' });
    const tasks = await screen.findByRole('list', { name: 'Recent tasks' });
    expect(tasks.textContent).toContain('Answer the open support mail');
    expect(tasks.textContent).toContain('Support desk');
    expect(tasks.textContent).toContain('Done');
  });

  it('provisions an agent with responsibilities and opens its credentials', async () => {
    const { api } = await renderWithTeam(<NewTeamAgent />);
    await userEvent.click(screen.getByRole('button', { name: 'Provision' }));
    expect(screen.getByText('Give the agent a name.')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Name'), 'Support desk');
    await userEvent.type(screen.getByLabelText('Responsibility 1'), 'Answer support mail');
    await userEvent.click(screen.getByRole('button', { name: 'Add a responsibility' }));
    await userEvent.type(screen.getByLabelText('Responsibility 2'), 'Weekly summary');
    await userEvent.click(screen.getByRole('button', { name: 'Remove responsibility 2' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Ask first' }));
    await userEvent.type(screen.getByLabelText('Model (optional)'), 'gpt-5');
    await userEvent.click(screen.getByRole('button', { name: 'Provision' }));
    await waitFor(() =>
      expect(api.provisionTeamAgent).toHaveBeenCalledWith({
        name: 'Support desk',
        autonomy: 'ask_first',
        responsibilities: [{ title: 'Answer support mail' }],
        model: 'gpt-5',
      }),
    );
    await waitFor(() => expect(window.location.search).toBe('?tab=credentials'));
    expect(window.location.pathname).toMatch(/^\/team\/agents\/ta/);
  });

  it('shows a member the owner-only notice instead of the provisioning form', async () => {
    await renderWithTeam(<NewTeamAgent />, { as: 'member', provider: true });
    expect((await screen.findByRole('note')).textContent).toContain(
      'Only the owner of this Hub can change this.',
    );
    expect(screen.queryByRole('button', { name: 'Provision' })).toBeNull();
  });
});

describe('a team agent’s page', () => {
  it('lets a member give a task and see only their own tasks', async () => {
    const { api, state } = await renderWithTeam(<TeamAgentPage agentId="ta-1" />, {
      as: 'member',
      team: {
        agents: [desk()],
        tasks: [
          teamTask({ id: 'task-o', agentId: 'ta-1', requestedBy: OWNER_ID, text: 'Owner task' }),
        ],
      },
    });
    expect(await screen.findByRole('heading', { name: 'Support desk', level: 1 })).toBeTruthy();
    expect(screen.getByText(/uses no person’s account, memory or connectors/)).toBeTruthy();
    const tabs = screen.getByRole('tablist', { name: 'Agent sections' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Your tasks']);
    expect(await screen.findByText('Tasks you give it appear here.')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Task for Support desk'), 'Summarize this week');
    await userEvent.click(screen.getByRole('button', { name: 'Give the task' }));
    await waitFor(() =>
      expect(api.giveTeamTask).toHaveBeenCalledWith('ta-1', 'Summarize this week'),
    );
    expect((await screen.findByRole('status')).textContent).toContain('Task given');
    const list = await screen.findByRole('list', { name: 'Tasks' });
    expect(list.textContent).toContain('Summarize this week');
    expect(list.textContent).toContain('Asked by Alex');
    expect(list.textContent).not.toContain('Owner task');
    await userEvent.click(within(list).getByRole('button', { name: /^Cancel the task/ }));
    await waitFor(() => expect(state.tasks[0]!.status).toBe('cancelled'));
    expect(await within(list).findByText('Cancelled')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Remove Support desk/ })).toBeNull();
  });

  it('answers the agent’s approvals as the owner, and shows a conflict', async () => {
    window.history.replaceState(null, '', '/team/agents/ta-1?tab=approvals');
    const { api, team } = await renderWithTeam(<TeamAgentPage agentId="ta-1" />, {
      team: {
        agents: [desk()],
        approvals: {
          'ta-1': [
            approval({ id: 'ap-1', action: 'Send an email to billing@example.com' }),
            approval({
              id: 'ap-2',
              action: 'Delete old drafts',
              options: ['allow_once', 'deny_stop'],
            }),
          ],
        },
      },
    });
    const card = await screen.findByRole('listitem', {
      name: 'Send an email to billing@example.com',
    });
    expect(card.textContent).toContain('Sending mail leaves the Hub');
    expect(card.textContent).toContain('{"to":"billing@example.com"}');
    await userEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    await waitFor(() =>
      expect(api.decideTeamAgentApproval).toHaveBeenCalledWith('ta-1', 'ap-1', {
        decision: 'allow_once',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('listitem', { name: /billing/ })).toBeNull());
    const other = screen.getByRole('listitem', { name: 'Delete old drafts' });
    expect(within(other).queryByRole('button', { name: 'Allow for this session' })).toBeNull();
    team.failNext.decideTeamAgentApproval = new ApiError(409, {
      code: 'conflict',
      message: 'this approval was already answered',
      retryable: false,
    });
    await userEvent.click(within(other).getByRole('button', { name: 'Deny and stop' }));
    expect((await within(other).findByRole('alert')).textContent).toBe(
      'This approval was already answered.',
    );
  });

  it('binds write-only credentials and removes one after asking', async () => {
    window.history.replaceState(null, '', '/team/agents/ta-1?tab=credentials');
    const { api } = await renderWithTeam(<TeamAgentPage agentId="ta-1" />, {
      team: { agents: [desk()] },
    });
    const list = await screen.findByRole('list', { name: 'Credentials' });
    expect(list.textContent).toContain('secret://providers/pa-9');
    await userEvent.click(screen.getByRole('button', { name: 'Add a credential' }));
    const form = screen.getByRole('form', { name: 'New credential' });
    await userEvent.type(within(form).getByLabelText('Name'), 'Anthropic');
    await userEvent.selectOptions(within(form).getByLabelText('Provider'), 'anthropic');
    await userEvent.type(within(form).getByLabelText('API key'), 'sk-ant-secret');
    await userEvent.click(within(form).getByRole('button', { name: 'Save credential' }));
    await waitFor(() =>
      expect(api.addTeamAgentCredential).toHaveBeenCalledWith('ta-1', {
        kind: 'provider',
        provider: 'anthropic',
        label: 'Anthropic',
        apiKey: 'sk-ant-secret',
      }),
    );
    expect(
      await screen.findByText('Anthropic saved. Only its reference is kept here.'),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('sk-ant-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Remove OpenAI for support' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove OpenAI for support?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(api.removeTeamAgentCredential).toHaveBeenCalledWith('ta-1', 'cred-1'),
    );
  });

  it('checks a website credential’s hosts and header before sending', async () => {
    window.history.replaceState(null, '', '/team/agents/ta-1?tab=credentials');
    const { api } = await renderWithTeam(<TeamAgentPage agentId="ta-1" />, {
      team: { agents: [desk()] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add a credential' }));
    const form = screen.getByRole('form', { name: 'New credential' });
    await userEvent.click(within(form).getByRole('radio', { name: 'Website credential' }));
    await userEvent.type(within(form).getByLabelText('Name'), 'Help desk API');
    await userEvent.selectOptions(within(form).getByLabelText('How it is sent'), 'header');
    await userEvent.click(within(form).getByRole('button', { name: 'Save credential' }));
    expect(within(form).getByText('Name at least one host, like api.example.com.')).toBeTruthy();
    expect(within(form).getByText('Enter the header name, like X-Api-Key.')).toBeTruthy();
    expect(api.addTeamAgentCredential).not.toHaveBeenCalled();
    await userEvent.type(within(form).getByLabelText('Hosts'), 'api.helpdesk.example');
    await userEvent.type(within(form).getByLabelText('Header name'), 'X-Api-Key');
    await userEvent.type(within(form).getByLabelText('Secret value'), 'hd-123');
    await userEvent.click(within(form).getByRole('button', { name: 'Save credential' }));
    await waitFor(() =>
      expect(api.addTeamAgentCredential).toHaveBeenCalledWith('ta-1', {
        kind: 'egress',
        label: 'Help desk API',
        hosts: ['api.helpdesk.example'],
        scheme: 'header',
        header: 'X-Api-Key',
        value: 'hd-123',
      }),
    );
  });

  it('shows the audit with older entries on demand, and removes the agent after asking', async () => {
    window.history.replaceState(null, '', '/team/agents/ta-1?tab=audit');
    const entries = Array.from({ length: 55 }, (_, i) =>
      auditEntry({ id: `au-${i}`, action: i === 54 ? 'team_task.start' : 'tool.call' }),
    );
    const { api } = await renderWithTeam(<TeamAgentPage agentId="ta-1" />, {
      team: { agents: [desk()], audit: { 'ta-1': entries } },
    });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(51);
    await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(56));
    expect(table.textContent).toContain('team_task.start');
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Support desk' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Support desk?' });
    expect(dialog.textContent).toContain('its credentials leave the vault');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removeTeamAgent).toHaveBeenCalledWith('ta-1'));
    await waitFor(() => expect(window.location.pathname).toBe('/team/agents'));
  });

  it('says why an agent cannot load, and that a paused one takes no tasks', async () => {
    await renderWithTeam(<TeamAgentPage agentId="ta-404" />);
    expect((await screen.findByRole('alert')).textContent).toContain('Team agent not found.');
    resetDom();
    await renderWithTeam(<TeamAgentPage agentId="ta-1" />, {
      team: { agents: [{ ...desk(), status: 'paused' }] },
    });
    expect(await screen.findByText('It is paused, so it does not take tasks now.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Give the task' }).disabled).toBe(
      true,
    );
  });
});

describe('plugins per agent', () => {
  it('limits an agent to chosen plugins, and back to all', async () => {
    const hub = createHub();
    hub.state.m4.plugins = [
      plugin({ id: 'pl-mail', name: 'Mail tools' }),
      plugin({ id: 'pl-cal', name: 'Calendar', enabled: false }),
    ];
    const { api, state } = await renderWithTeam(<AgentPluginsSection agentId="ag-1" />, { hub });
    const all = await screen.findByRole('radio', { name: 'Every plugin you turned on' });
    expect((all as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: 'Only the plugins chosen here' }));
    expect(screen.getByText('With none chosen, it uses no plugin tools at all.')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Calendar/ }).parentElement?.textContent).toContain(
      'turned off',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /Mail tools/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setAgentPlugins).toHaveBeenCalledWith('ag-1', ['pl-mail']));
    expect(state.agentPlugins['ag-1']).toEqual(['pl-mail']);
    expect(await screen.findByText('It uses 1 plugin.')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Every plugin you turned on' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setAgentPlugins).toHaveBeenLastCalledWith('ag-1', null));
  });

  it('names a plugin that is no longer installed', async () => {
    const hub = createHub();
    hub.state.m4.plugins = [plugin({ id: 'pl-mail', name: 'Mail tools' })];
    const { state } = await renderWithTeam(<AgentPluginsSection agentId="ag-1" />, { hub });
    await userEvent.click(
      await screen.findByRole('radio', { name: 'Only the plugins chosen here' }),
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /Mail tools/ }));
    hub.state.m4.plugins = [];
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'These plugins are no longer installed: pl-mail.',
    );
    expect(state.agentPlugins['ag-1']).toBeUndefined();
  });

  it('points to installing plugins when there are none', async () => {
    await renderWithTeam(<AgentPluginsSection agentId="ag-1" />);
    await userEvent.click(
      await screen.findByRole('radio', { name: 'Only the plugins chosen here' }),
    );
    expect(screen.getByText('No plugins installed')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings → Plugins & skills' })).toBeTruthy();
  });
});
