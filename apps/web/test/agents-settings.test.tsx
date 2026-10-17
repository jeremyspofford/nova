// Settings → Agents (FR-079, FR-082, FR-182, FR-206) and external agents (FR-194); and what an
// agent works through: its background runs (FR-083), channel bindings (FR-088) and computer
// (FR-080), each linking to the area that manages it.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { AgentBackground, AgentChannels, AgentComputer } from '../src/agents/AgentLinks.tsx';
import { AgentsSettings, ExternalAgentsSection } from '../src/agents/AgentsSettings.tsx';
import {
  agentThreadView,
  agentView,
  backgroundView,
  bindingView,
  computerView,
  renderWithAgents,
} from './fakes-m6-agents.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

describe('Settings → Agents', () => {
  it('changes what new agents start with', async () => {
    const r = await renderWithAgents(<AgentsSettings />, {
      settings: { 'review.model': null },
    });
    const autonomy = await screen.findByRole('combobox', { name: 'Autonomy' });
    // Autonomous needs a reviewer model first.
    const auto = within(autonomy).getByRole<HTMLOptionElement>('option', {
      name: 'Autonomous (needs a reviewer model)',
    });
    expect(auto.disabled).toBe(true);
    await userEvent.selectOptions(autonomy, 'ask_first');
    await waitFor(() => expect(r.hub.state.settings['agents.autonomy']).toBe('ask_first'));

    const minutes = screen.getByRole('textbox', { name: 'Time (minutes)' });
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '45');
    const cost = screen.getByRole('textbox', { name: 'Cost (US dollars)' });
    await userEvent.type(cost, '3');
    await userEvent.click(screen.getByRole('button', { name: 'Save budgets' }));
    await waitFor(() =>
      expect(r.hub.state.settings['agents.defaultBudgets']).toEqual({
        timeSeconds: 2700,
        tokens: 500_000,
        costUsd: 3,
      }),
    );

    await userEvent.click(
      screen.getByRole('switch', { name: 'Proactive research for new agents' }),
    );
    await waitFor(() =>
      expect(r.hub.state.settings['agents.proactive']).toEqual({
        enabledByDefault: false,
        intervalMinutes: 60,
      }),
    );
    const every = screen.getByRole('textbox', { name: 'Research at most every (minutes)' });
    await userEvent.clear(every);
    await userEvent.type(every, '5{Enter}');
    expect(screen.getByText('Enter whole minutes, from 15 to 10,080 (7 days).')).toBeTruthy();
    await userEvent.clear(every);
    await userEvent.type(every, '120{Enter}');
    await waitFor(() =>
      expect(r.hub.state.settings['agents.proactive']).toEqual({
        enabledByDefault: false,
        intervalMinutes: 120,
      }),
    );
  });

  it('limits self-set wakes, and shows them locked by policy', async () => {
    const r = await renderWithAgents(<AgentsSettings />);
    const per = await screen.findByRole('textbox', { name: 'Most per agent per day' });
    await userEvent.clear(per);
    await userEvent.type(per, '30');
    await userEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    expect(screen.getByText('An agent can set from 0 to 24 wake-ups a day.')).toBeTruthy();
    await userEvent.clear(per);
    await userEvent.type(per, '6');
    await userEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() =>
      expect(r.hub.state.settings['agents.wakes']).toEqual({
        minMinutes: 5,
        horizonDays: 30,
        perDay: 6,
      }),
    );
    resetDom();

    await renderWithAgents(<AgentsSettings />, {
      managed: { 'agents.wakes': { minMinutes: 60, horizonDays: 7, perDay: 2 } },
    });
    const locked = await screen.findByRole('textbox', { name: 'Most per agent per day' });
    expect((locked as HTMLInputElement).value).toBe('2');
    expect((locked as HTMLInputElement).closest('fieldset')?.disabled).toBe(true);
    expect(screen.getByText('Managed by your organization')).toBeTruthy();
  });
});

describe('external agents (FR-194)', () => {
  it('adds, dedupes and removes the agents the user names', async () => {
    const r = await renderWithAgents(<ExternalAgentsSection />);
    expect(await screen.findByText('None yet.')).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Add an external agent' });
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'Address or name' }),
      'The Billing Agent',
    );
    await userEvent.type(within(form).getByRole('textbox', { name: 'Label (optional)' }), 'Vendor');
    await userEvent.click(within(form).getByRole('button', { name: 'Add' }));
    const list = await screen.findByRole('list', { name: 'External agents' });
    const row = within(list).getByRole('listitem', { name: 'Vendor' });
    // The Hub keeps the address normalized.
    expect(within(row).getByText('billing agent')).toBeTruthy();

    await userEvent.type(
      within(form).getByRole('textbox', { name: 'Address or name' }),
      'billing agent',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(r.api.addExternalAgent).toHaveBeenCalledTimes(2));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);

    await userEvent.click(within(row).getByRole('button', { name: 'Remove Vendor' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Remove this external agent?' })).getByRole(
        'button',
        { name: 'Remove' },
      ),
    );
    expect(await screen.findByText('None yet.')).toBeTruthy();
    expect(r.state.external).toHaveLength(0);
  });

  it('shows a refusal and a load failure', async () => {
    const r = await renderWithAgents(<ExternalAgentsSection />, {
      failNext: {
        listExternalAgents: new ApiError(500, {
          code: 'x',
          message: 'Hub is busy',
          retryable: true,
        }),
      },
    });
    expect(await screen.findByText('Hub is busy')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('None yet.');
    r.agents.failNext.addExternalAgent = new ApiError(400, {
      code: 'validation',
      message: 'an address is required',
      retryable: false,
    });
    await userEvent.type(screen.getByRole('textbox', { name: 'Address or name' }), '!!!');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('an address is required')).toBeTruthy();
  });
});

describe('what an agent works through (FR-080, FR-083, FR-088)', () => {
  it('lists background runs with links to Work', async () => {
    await renderWithAgents(<AgentBackground agentId="ag1" version={0} />, {
      agents: {
        agents: [agentView({ id: 'ag1' })],
        background: {
          ag1: [
            backgroundView({ runId: 'run1', title: 'Vendor contracts', status: 'running' }),
            backgroundView({
              runId: 'run2',
              title: 'Old report',
              status: 'done',
              endedAt: '2026-10-01T12:00:00.000Z',
            }),
          ],
        },
      },
    });
    const list = await screen.findByRole('list', { name: 'Background work' });
    expect(within(list).getByRole('link', { name: 'Vendor contracts' }).getAttribute('href')).toBe(
      '/work/run1',
    );
    expect(within(list).getByText('Done')).toBeTruthy();
    expect(within(list).getByText('Running')).toBeTruthy();
  });

  it('says when there is no background work', async () => {
    await renderWithAgents(<AgentBackground agentId="ag1" version={0} />, {
      agents: { agents: [agentView({ id: 'ag1' })] },
    });
    expect(await screen.findByText('Nothing in the background yet.')).toBeTruthy();
  });

  it('lists channel bindings, links to Settings and shows a binding’s thread', async () => {
    const shown: string[] = [];
    await renderWithAgents(
      <AgentChannels
        channels={[
          bindingView({ id: 'cb1', label: '#support', lastMessageAt: '2026-10-01T11:00:00.000Z' }),
          bindingView({
            id: 'cb2',
            kind: 'email',
            label: 'Inbox',
            status: 'not_configured',
            statusDetail: 'Add the SMTP password',
            audience: 'private',
          }),
        ]}
        error={null}
        threads={[agentThreadView({ threadId: 't9', kind: 'binding', bindingRef: 'cb1' })]}
        onShowThread={(t) => shown.push(t.threadId)}
        onRetry={() => undefined}
      />,
    );
    const list = screen.getByRole('list', { name: 'Channel bindings' });
    const slack = within(list).getByRole('listitem', { name: 'Slack #support' });
    expect(within(slack).getByText('Connected')).toBeTruthy();
    expect(within(slack).getByText('Shared')).toBeTruthy();
    await userEvent.click(
      within(slack).getByRole('button', { name: 'Show the thread of #support' }),
    );
    expect(shown).toEqual(['t9']);
    const email = within(list).getByRole('listitem', { name: 'Email Inbox' });
    expect(within(email).getByText('Needs setup')).toBeTruthy();
    expect(within(email).getByText('Add the SMTP password')).toBeTruthy();
    expect(within(email).queryByRole('button')).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: 'Manage channels' }));
    expect(window.location.pathname).toBe('/settings/channels');
  });

  it('shows no channels and a load failure', async () => {
    let retried = false;
    await renderWithAgents(
      <AgentChannels
        channels={[]}
        error={null}
        threads={[]}
        onShowThread={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText(/No channels yet/)).toBeTruthy();
    resetDom();
    await renderWithAgents(
      <AgentChannels
        channels={null}
        error="Could not load the channels."
        threads={null}
        onShowThread={() => undefined}
        onRetry={() => (retried = true)}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retried).toBe(true);
  });

  it('summarizes the agent’s computer and links to it', async () => {
    const agent = agentView({ id: 'ag1', computerId: 'cmp1' });
    await renderWithAgents(<AgentComputer agent={agent} />, {
      agents: {
        agents: [agent],
        computers: [computerView({ id: 'cmp1', state: 'degraded', detail: 'Disk almost full' })],
      },
    });
    expect(await screen.findByText('Degraded')).toBeTruthy();
    expect(screen.getByText('Disk almost full')).toBeTruthy();
    expect(screen.getByText('Cloud computer')).toBeTruthy();
    const open = screen.getByRole('link', { name: 'Open the computer' });
    expect(open.getAttribute('href')).toBe('/computers/cmp1');
  });

  it('says when the computer is still being set up or is gone', async () => {
    await renderWithAgents(<AgentComputer agent={agentView({ id: 'ag1', computerId: null })} />);
    expect(screen.getByText(/Its computer is being set up/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open the computer' })).toBeNull();
    resetDom();
    await renderWithAgents(<AgentComputer agent={agentView({ id: 'ag1', computerId: 'cmp9' })} />);
    expect(await screen.findByText('This computer no longer exists.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open the computer' })).toBeNull();
  });
});
