// Settings → Members (decision 5 of ADR-095; FR-217): the people with their roles; the owner's
// one-use invitation links (shown once, with Copy and an expiry), withdrawing one, and removing
// a member (their sessions end, so it asks first); a member sees the people read-only and none
// of the owner's controls; joins arrive live; failures say what happened and offer Retry.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { MembersPage } from '../src/team/MembersPage.tsx';
import { FakeEventSource } from './fakes.ts';
import { MEMBER_ID, invitation, person, renderWithTeam } from './fakes-m7-team.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const region = (name: string) => screen.getByRole('region', { name });
const stream = () => FakeEventSource.for('/api/v1/events/stream');

async function open(opts: Parameters<typeof renderWithTeam>[1] = {}) {
  const r = await renderWithTeam(<MembersPage />, opts);
  await screen.findByRole('list', { name: 'People of this Hub' });
  return r;
}

describe('Settings → Members, as the owner', () => {
  it('lists the people with their roles and who invited them', async () => {
    await open();
    const people = within(screen.getByRole('list', { name: 'People of this Hub' }));
    const rows = people.getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('Sam (you)');
    expect(rows[0]!.textContent).toContain('Owner');
    expect(rows[1]!.textContent).toContain('Alex');
    expect(rows[1]!.textContent).toContain('Member');
    expect(rows[1]!.textContent).toContain('Invited by Sam');
    // The owner is never offered to remove themself.
    expect(people.queryByRole('button', { name: 'Remove Sam' })).toBeNull();
    expect(people.getByRole('button', { name: 'Remove Alex' })).toBeTruthy();
  });

  it('makes a one-use link, shows it once with Copy, and lists the invitation', async () => {
    const { api } = await open();
    await screen.findByText('No invitations yet');
    await userEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    const dialog = screen.getByRole('dialog', { name: 'Invite someone' });
    await userEvent.type(within(dialog).getByLabelText('Who it is for (optional)'), 'Jordan');
    await userEvent.selectOptions(within(dialog).getByLabelText('The link works for'), '168');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make the link' }));
    expect(api.createTeamInvitation).toHaveBeenCalledWith({ label: 'Jordan', ttlHours: 168 });
    const shown = await screen.findByRole('dialog', { name: 'Send this link' });
    const link = within(shown).getByTestId('invitation-link').textContent ?? '';
    expect(link).toMatch(/\/join#invite=/);
    expect(shown.textContent).toContain('works once');
    expect(shown.textContent).toContain('shown only now');
    expect(shown.textContent).toContain('Anyone with this link can join');
    expect(within(shown).getByRole('button', { name: 'Copy invitation link' })).toBeTruthy();
    await userEvent.click(within(shown).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The token never shows again: the list has the label and status only.
    const list = screen.getByRole('list', { name: 'Invitations' });
    expect(list.textContent).toContain('Jordan');
    expect(list.textContent).toContain('Waiting to be used');
    expect(document.body.textContent).not.toContain(link);
  });

  it('defaults the expiry to the Hub setting and keeps a failure in the dialog', async () => {
    const { api, team } = await open({ settings: { 'team.invitationHours': 24 } });
    await userEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    const dialog = screen.getByRole('dialog', { name: 'Invite someone' });
    expect(within(dialog).getByLabelText<HTMLSelectElement>('The link works for').value).toBe('24');
    team.failNext.createTeamInvitation = new ApiError(500, {
      code: 'server_error',
      message: 'disk full',
      retryable: true,
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make the link' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Disk full.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make the link' }));
    expect(api.createTeamInvitation).toHaveBeenLastCalledWith({ ttlHours: 24 });
    expect(await screen.findByRole('dialog', { name: 'Send this link' })).toBeTruthy();
  });

  it('withdraws a pending invitation after asking; used ones have no Withdraw', async () => {
    const { api, state } = await open({
      team: {
        invitations: [
          invitation({ id: 'inv-a', label: 'Jordan' }),
          invitation({ id: 'inv-b', label: 'Kim', status: 'redeemed', redeemedBy: MEMBER_ID }),
        ],
      },
    });
    const list = await screen.findByRole('list', { name: 'Invitations' });
    expect(list.textContent).toContain('Used by Alex');
    expect(within(list).queryByRole('button', { name: 'Withdraw Kim' })).toBeNull();
    await userEvent.click(within(list).getByRole('button', { name: 'Withdraw Jordan' }));
    const dialog = screen.getByRole('dialog', { name: 'Withdraw this invitation?' });
    expect(dialog.textContent).toContain('The link stops working');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.revokeTeamInvitation).toHaveBeenCalledWith('inv-a');
    expect(state.invitations[0]!.status).toBe('revoked');
    expect(screen.getByRole('list', { name: 'Invitations' }).textContent).toContain('Withdrawn');
  });

  it('removes a member only after saying their sessions end, and reports how many', async () => {
    const { api, state, team } = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Alex' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Alex from this Hub?' });
    expect(dialog.textContent).toContain('Their sessions end at once on every device');
    team.failNext.removeTeamMember = new ApiError(503, {
      code: 'server_error',
      message: 'the Hub is busy',
      retryable: true,
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('The Hub is busy.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.removeTeamMember).toHaveBeenLastCalledWith(MEMBER_ID);
    expect(state.people.find((p) => p.accountId === MEMBER_ID)?.removed).toBe(true);
    const toasts = screen.getByRole('region', { name: 'Notifications' });
    expect(await within(toasts).findByText('Alex was removed. 2 sessions ended.')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'People of this Hub' }).textContent).not.toContain(
      'Alex',
    );
  });

  it('refreshes the people when someone joins, live', async () => {
    const { state } = await open();
    state.people.push(person({ accountId: 'acc-kim', displayName: 'Kim' }));
    stream().emit('team.member.joined', { accountId: 'acc-kim', invitationId: 'inv-a' });
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'People of this Hub' }).textContent).toContain('Kim'),
    );
  });

  it('says why the people cannot load, and retries', async () => {
    await renderWithTeam(<MembersPage />, {
      prepare: (team) => {
        team.failNext.listTeamMembers = new TypeError('Failed to fetch');
      },
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Cannot reach the Hub. Check your connection and try again.',
    );
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'People of this Hub' })).toBeTruthy();
  });

  it('shows the owner-only notice when the Hub refuses the invitations', async () => {
    await renderWithTeam(<MembersPage />, {
      prepare: (team) => {
        team.failNext.listTeamInvitations = new ApiError(403, {
          code: 'policy_denied',
          message: 'only the owner of this Hub can do that',
          retryable: false,
          details: { reason: 'owner_only' },
        });
      },
    });
    expect((await screen.findByRole('note')).textContent).toContain(
      'Only the owner of this Hub can change this.',
    );
  });
});

describe('Settings → Members, as a member', () => {
  it('shows the people read-only and none of the owner’s controls', async () => {
    const { api } = await open({ as: 'member' });
    expect(screen.getByRole('note').textContent).toContain('You are a member of this Hub');
    const people = screen.getByRole('list', { name: 'People of this Hub' });
    expect(people.textContent).toContain('Alex (you)');
    expect(within(people).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite someone' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sign-in providers' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Invitations' })).toBeNull();
    // It never asks for what the Hub would refuse.
    expect(api.listTeamInvitations).not.toHaveBeenCalled();
    expect(api.listOidcProviders).not.toHaveBeenCalled();
  });
});

describe('region helper', () => {
  it('finds labelled sections', async () => {
    await open();
    expect(region('People')).toBeTruthy();
    expect(region('Invitations')).toBeTruthy();
    expect(region('Sign-in providers')).toBeTruthy();
  });
});
