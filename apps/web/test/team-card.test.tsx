// The public profile card (FR-113): off by default; the owner's Hub-wide switch asks before
// allowing cards; each person opts in with a handle and chooses whether the avatar shows; the
// preview shows exactly what is public; the Hub's refusals (switch off, handle taken) read
// plainly. Who you are on the Hub heads Settings → Account.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountPage } from '../src/team/AccountPage.tsx';
import { MEMBER_ID, OWNER_ID, renderWithTeam } from './fakes-m7-team.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const cardSection = () => screen.getByRole('region', { name: 'Public profile card' });

async function open(opts: Parameters<typeof renderWithTeam>[1] = {}) {
  const r = await renderWithTeam(<AccountPage />, opts);
  await screen.findByRole('switch', { name: 'Show my public card' });
  return r;
}

describe('the public profile card', () => {
  it('lets the owner allow cards only after asking, then publish their own', async () => {
    const { api, hub, state } = await open();
    expect(screen.getByRole('region', { name: 'You on this Hub' }).textContent).toContain(
      'You own this Hub',
    );
    const section = cardSection();
    const hubSwitch = within(section).getByRole('switch', {
      name: 'Allow public profile cards on this Hub',
    });
    expect(hubSwitch.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(hubSwitch);
    const dialog = screen.getByRole('dialog', { name: 'Allow public profile cards?' });
    expect(dialog.textContent).toContain('without signing in');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(hub.state.settings['team.publicProfiles']).toBe(true));
    // The person's own card: a handle, the avatar choice, and a preview of what is public.
    await userEvent.click(within(section).getByRole('switch', { name: 'Show my public card' }));
    await userEvent.type(within(section).getByLabelText('Handle'), 'Sam-Home');
    const preview = within(section).getByTestId('card-preview');
    expect(preview.textContent).toContain('Sam');
    expect(preview.textContent).toContain('@sam-home');
    expect(section.textContent).toContain('Nothing else is public');
    await userEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.setProfileCard).toHaveBeenCalledWith({
        enabled: true,
        handle: 'sam-home',
        showAvatar: true,
      }),
    );
    expect(state.cards[OWNER_ID]?.enabled).toBe(true);
    expect(await within(section).findByText(/\/profile\/sam-home$/)).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Copy card address' })).toBeTruthy();
  });

  it('checks the handle before saving and shows a taken handle plainly', async () => {
    const { api } = await open({
      settings: { 'team.publicProfiles': true },
      team: { cards: { [MEMBER_ID]: { enabled: true, handle: 'alex', showAvatar: true } } },
    });
    const section = cardSection();
    await userEvent.type(within(section).getByLabelText('Handle'), 'a');
    await userEvent.click(within(section).getByRole('button', { name: 'Save' }));
    expect(
      within(section).getByText(/3 to 40 lowercase letters/, { selector: '.nv-field-error' }),
    ).toBeTruthy();
    expect(api.setProfileCard).not.toHaveBeenCalled();
    await userEvent.clear(within(section).getByLabelText('Handle'));
    await userEvent.type(within(section).getByLabelText('Handle'), 'alex');
    await userEvent.click(within(section).getByRole('button', { name: 'Save' }));
    expect(
      (await within(section).findByText('This handle is taken. Choose another.')).getAttribute(
        'role',
      ),
    ).toBe('alert');
  });

  it('shows a member no Hub switch, and says when the owner keeps cards off', async () => {
    await open({ as: 'member' });
    expect(screen.getByRole('region', { name: 'You on this Hub' }).textContent).toContain(
      'You are a member',
    );
    const section = cardSection();
    expect(
      within(section).queryByRole('switch', { name: 'Allow public profile cards on this Hub' }),
    ).toBeNull();
    await userEvent.click(within(section).getByRole('switch', { name: 'Show my public card' }));
    await userEvent.type(within(section).getByLabelText('Handle'), 'alex');
    // Without an avatar, the preview never shows an image.
    expect(within(section).getByTestId('card-preview').querySelector('img')).toBeNull();
    await userEvent.click(within(section).getByRole('button', { name: 'Save' }));
    expect(
      await within(section).findByText(
        'Public profile cards are turned off on this Hub. The owner can turn them on.',
      ),
    ).toBeTruthy();
  });

  it('turns the Hub switch off without asking, and says when it cannot load the card', async () => {
    const { hub } = await open({ settings: { 'team.publicProfiles': true } });
    await userEvent.click(
      within(cardSection()).getByRole('switch', { name: 'Allow public profile cards on this Hub' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(hub.state.settings['team.publicProfiles']).toBe(false));
  });

  it('offers Retry when the card cannot load', async () => {
    await renderWithTeam(<AccountPage />, {
      prepare: (team) => {
        team.failNext.getProfileCard = new TypeError('Failed to fetch');
      },
    });
    const section = await screen.findByRole('region', { name: 'Public profile card' });
    const alert = await within(section).findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(
      await within(section).findByRole('switch', { name: 'Show my public card' }),
    ).toBeTruthy();
  });
});
