// An agent's profile (FR-079, FR-085, FR-182): only what changed is sent; the avatar can be
// replaced or removed; Autonomous needs a reviewer model. And its Activity (FR-090): newest first,
// each entry opening to what the runtime recorded, shown as text.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { AgentActivity } from '../src/agents/AgentActivity.tsx';
import { AgentProfile } from '../src/agents/AgentProfile.tsx';
import { activityItem, agentView, renderWithAgents } from './fakes-m6-agents.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

describe('the agent profile (FR-079)', () => {
  it('sends only what changed and can remove the avatar', async () => {
    const agent = agentView({ id: 'ag1', name: 'Scout', hasAvatar: true, model: null });
    let saved: AgentView | null = null;
    const r = await renderWithAgents(<AgentProfile agent={agent} onAgent={(a) => (saved = a)} />, {
      agents: { agents: [agent] },
    });
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save profile' });
    expect(save.disabled).toBe(true);
    const name = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Scout Two');
    await userEvent.click(screen.getByRole('switch', { name: 'Proactive research' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove avatar' }));
    expect(screen.getByRole('button', { name: 'Keep the current avatar' })).toBeTruthy();
    await userEvent.click(save);
    await waitFor(() =>
      expect(r.api.updateAgent).toHaveBeenCalledWith('ag1', {
        name: 'Scout Two',
        avatar: null,
        proactive: false,
      }),
    );
    expect((saved as AgentView | null)?.hasAvatar).toBe(false);
    expect(await screen.findByText('Profile saved.')).toBeTruthy();
  });

  it('discards changes, checks budgets, and shows the Hub refusing Autonomous', async () => {
    const agent = agentView({ id: 'ag1', name: 'Scout' });
    const r = await renderWithAgents(<AgentProfile agent={agent} onAgent={() => undefined} />, {
      agents: { agents: [agent] },
    });
    const name = screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
    await userEvent.type(name, ' X');
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(name.value).toBe('Scout');

    const minutes = screen.getByRole('textbox', { name: 'Time (minutes)' });
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(screen.getByText('Enter whole minutes, from 1 to 10,080 (7 days).')).toBeTruthy();
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '30');

    await userEvent.click(screen.getByRole('radio', { name: 'Autonomous' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(
      await screen.findByText('an autonomous agent needs a reviewer model: choose one in Settings'),
    ).toBeTruthy();
    expect(r.state.agents[0]?.autonomy).toBe('standard');
  });

  it('saves Autonomous once a reviewer model is chosen', async () => {
    const agent = agentView({ id: 'ag1', name: 'Scout' });
    const r = await renderWithAgents(<AgentProfile agent={agent} onAgent={() => undefined} />, {
      agents: { agents: [agent] },
      settings: { 'review.model': 'pa1/mock-smart' },
    });
    await userEvent.click(screen.getByRole('radio', { name: 'Autonomous' }));
    expect(screen.queryByRole('note')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(r.state.agents[0]?.autonomy).toBe('autonomous'));
  });
});

describe('the agent activity (FR-090)', () => {
  it('lists newest first and opens an entry to its recorded details', async () => {
    await renderWithAgents(<AgentActivity agentId="ag1" version={0} />, {
      agents: {
        agents: [agentView({ id: 'ag1' })],
        activity: {
          ag1: [
            activityItem({ id: 'e1', title: 'Agent created', ts: '2026-10-01T09:00:00.000Z' }),
            activityItem({
              id: 'e2',
              kind: 'tool_call',
              title: 'email.send',
              status: 'denied',
              detail: '<b>not html</b>',
              callId: 'call-7',
              ts: '2026-10-01T10:00:00.000Z',
            }),
          ],
        },
      },
    });
    const list = await screen.findByRole('list', { name: 'Agent activity' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('email.send');
    const step = within(items[0] as HTMLElement).getByRole('button', { expanded: false });
    await userEvent.click(step);
    expect(step.getAttribute('aria-expanded')).toBe('true');
    // Recorded details are text, never markup.
    expect(within(list).getByText('<b>not html</b>')).toBeTruthy();
    expect(within(list).getByText('call-7')).toBeTruthy();
  });

  it('shows an empty state, and a failure with a retry', async () => {
    await renderWithAgents(<AgentActivity agentId="ag1" version={0} />, {
      agents: { agents: [agentView({ id: 'ag1' })] },
      failNext: {
        agentActivity: new ApiError(500, { code: 'x', message: 'Hub is busy', retryable: true }),
      },
    });
    expect(await screen.findByText('Hub is busy')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Nothing yet\./)).toBeTruthy();
  });
});
