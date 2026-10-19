// OIDC sign-in (FR-113, docs/13 §7): the owner's providers in Settings → Members (issuer checked
// as the Hub checks it, a write-only client secret that shows only as Set or Not set and can be
// replaced or removed, on and off, a test that reaches the provider without signing anyone in,
// removal after asking), and each person's linked identities in Settings → Account (link at an
// enabled provider, unlink after asking, and what the provider's return means).
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountPage } from '../src/team/AccountPage.tsx';
import { browser } from '../src/team/leave.ts';
import { OidcProvidersSection } from '../src/team/OidcProviders.tsx';
import { MEMBER_ID, OWNER_ID, identity, oidcProvider, renderWithTeam } from './fakes-m7-team.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

async function providers(opts: Parameters<typeof renderWithTeam>[1] = {}) {
  const r = await renderWithTeam(<OidcProvidersSection />, opts);
  await screen.findByRole('heading', { name: 'Sign-in providers' });
  await waitFor(() => expect(screen.queryByText('Loading sign-in providers')).toBeNull());
  return r;
}

describe('sign-in providers (owner)', () => {
  it('adds a provider: checks the issuer, keeps the secret write-only', async () => {
    const { api, state } = await providers();
    expect(screen.getByText('No sign-in providers')).toBeTruthy();
    expect(document.body.textContent).toContain('/api/v1/auth/oidc/callback');
    await userEvent.click(screen.getByRole('button', { name: 'Add a provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a sign-in provider' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Company sign-in');
    await userEvent.type(within(dialog).getByLabelText('Issuer'), 'http://idp.example.com');
    await userEvent.type(within(dialog).getByLabelText('Client id'), 'nova-hub');
    await userEvent.type(within(dialog).getByLabelText('Client secret'), 's3cret-value');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText(/Enter the issuer’s https:\/\/ address/)).toBeTruthy();
    expect(api.createOidcProvider).not.toHaveBeenCalled();
    await userEvent.clear(within(dialog).getByLabelText('Issuer'));
    await userEvent.type(within(dialog).getByLabelText('Issuer'), 'https://idp.example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.createOidcProvider).toHaveBeenCalledWith({
      label: 'Company sign-in',
      issuer: 'https://idp.example.com',
      clientId: 'nova-hub',
      scopes: ['openid', 'profile', 'email'],
      enabled: true,
      clientSecret: 's3cret-value', // secret-scan: fake
    });
    expect(state.providers[0]!.secret).toBe('s3cret-value');
    const card = screen.getByRole('listitem', { name: 'Company sign-in' });
    expect(within(card).getByText('Set')).toBeTruthy();
    expect(document.body.textContent).not.toContain('s3cret-value');
  });

  it('requires openid and shows the Hub’s refusal of a second issuer', async () => {
    await providers({ team: { providers: [oidcProvider({ issuer: 'https://idp.example.com' })] } });
    await userEvent.click(screen.getByRole('button', { name: 'Add a provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a sign-in provider' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Again');
    await userEvent.type(within(dialog).getByLabelText('Issuer'), 'https://idp.example.com');
    await userEvent.type(within(dialog).getByLabelText('Client id'), 'x');
    await userEvent.clear(within(dialog).getByLabelText('Scopes'));
    await userEvent.type(within(dialog).getByLabelText('Scopes'), 'email');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('The scopes must include openid.')).toBeTruthy();
    await userEvent.clear(within(dialog).getByLabelText('Scopes'));
    await userEvent.type(within(dialog).getByLabelText('Scopes'), 'openid email');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This issuer is already configured.',
    );
  });

  it('replaces or removes the secret, never showing it', async () => {
    const p = oidcProvider({ id: 'oidc-a', label: 'Company sign-in' });
    const { api, state } = await providers({ team: { providers: [p] } });
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    let dialog = screen.getByRole('dialog', { name: 'Edit Company sign-in' });
    expect(within(dialog).queryByLabelText('Issuer')).toBeNull();
    expect(dialog.textContent).toContain('https://accounts.example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove secret' }));
    expect(dialog.textContent).toContain('Will be removed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.updateOidcProvider).toHaveBeenCalledWith('oidc-a', { clientSecret: null });
    expect(
      within(screen.getByRole('listitem', { name: 'Company sign-in' })).getByText('Not set'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    dialog = screen.getByRole('dialog', { name: 'Edit Company sign-in' });
    await userEvent.type(within(dialog).getByLabelText('Client secret'), 'new-secret');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.updateOidcProvider).toHaveBeenLastCalledWith('oidc-a', {
      clientSecret: 'new-secret',
    });
    expect(state.providers[0]!.secret).toBe('new-secret');
    expect(document.body.textContent).not.toContain('new-secret');
  });

  it('turns a provider off and on; Test needs it on and says what it found', async () => {
    const p = oidcProvider({ id: 'oidc-a', label: 'Company sign-in' });
    const { api, state } = await providers({ team: { providers: [p] } });
    const card = screen.getByRole('listitem', { name: 'Company sign-in' });
    await userEvent.click(within(card).getByRole('button', { name: 'Test' }));
    expect((await within(card).findByRole('status')).textContent).toContain(
      'The Hub reached https://accounts.example.com',
    );
    expect(api.startOidc).toHaveBeenCalledWith({ providerId: 'oidc-a', flow: 'sign_in' });
    state.reachable = false;
    await userEvent.click(within(card).getByRole('button', { name: 'Test' }));
    expect((await within(card).findByRole('alert')).textContent).toContain(
      'The Hub could not reach the sign-in provider',
    );
    await userEvent.click(within(card).getByRole('switch', { name: 'Allow signing in with it' }));
    await waitFor(() =>
      expect(api.updateOidcProvider).toHaveBeenCalledWith('oidc-a', { enabled: false }),
    );
    expect(await within(card).findByText('Off')).toBeTruthy();
    expect(within(card).getByRole<HTMLButtonElement>('button', { name: 'Test' }).disabled).toBe(
      true,
    );
    expect(within(card).getByText('Turn it on to test it.')).toBeTruthy();
  });

  it('removes a provider after saying what stops working', async () => {
    const p = oidcProvider({ id: 'oidc-a', label: 'Company sign-in' });
    const { api } = await providers({ team: { providers: [p] } });
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Company sign-in?' });
    expect(dialog.textContent).toContain('identities linked to it stop working');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.deleteOidcProvider).toHaveBeenCalledWith('oidc-a');
    expect(await screen.findByText('No sign-in providers')).toBeTruthy();
  });

  it('shows the owner-only notice to a member who reaches it', async () => {
    await renderWithTeam(<OidcProvidersSection />, { as: 'member' });
    expect((await screen.findByRole('note')).textContent).toContain(
      'Only the owner of this Hub can change this.',
    );
  });
});

describe('Settings → Account: linked identities', () => {
  it('lists identities, links at a provider and unlinks after asking', async () => {
    const leave = vi.spyOn(browser, 'leaveTo').mockImplementation(() => undefined);
    const linked = oidcProvider({ id: 'oidc-a', label: 'Company sign-in' });
    const other = oidcProvider({ id: 'oidc-b', label: 'School', issuer: 'https://school.example' });
    const { api, state } = await renderWithTeam(<AccountPage />, {
      team: {
        providers: [linked, other],
        identities: {
          [OWNER_ID]: [identity({ id: 'idn-1', providerId: 'oidc-a', email: 'sam@example.com' })],
        },
      },
    });
    const list = await screen.findByRole('list', { name: 'Linked identities' });
    expect(list.textContent).toContain('Company sign-in');
    expect(list.textContent).toContain('sam@example.com');
    // Only providers not linked yet are offered.
    expect(screen.queryByRole('button', { name: 'Link Company sign-in' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Link School' }));
    expect(api.startOidc).toHaveBeenCalledWith({ providerId: 'oidc-b', flow: 'link' });
    expect(leave).toHaveBeenCalledWith('https://accounts.example.com/authorize?state=s1');
    await userEvent.click(within(list).getByRole('button', { name: 'Unlink Company sign-in' }));
    const dialog = screen.getByRole('dialog', { name: 'Unlink Company sign-in?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.unlinkOidcIdentity).toHaveBeenCalledWith('idn-1');
    expect(state.identities[OWNER_ID]).toEqual([]);
    expect(await screen.findByText('No identity is linked to your account.')).toBeTruthy();
  });

  it('never follows an address that is not http(s)', async () => {
    const leave = vi.spyOn(browser, 'leaveTo').mockImplementation(() => undefined);
    await renderWithTeam(<AccountPage />, {
      team: {
        providers: [oidcProvider({ id: 'oidc-a', label: 'Company sign-in' })],
        authorizeUrl: 'javascript:alert(1)',
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Link Company sign-in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('will not open');
    expect(leave).not.toHaveBeenCalled();
  });

  it('warns a member that unlinking may end their way in, and explains no providers', async () => {
    await renderWithTeam(<AccountPage />, {
      as: 'member',
      team: {
        identities: { [MEMBER_ID]: [identity({ id: 'idn-2', providerLabel: 'School' })] },
      },
    });
    expect(await screen.findByText('The owner of this Hub has not set one up.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Unlink School' }));
    expect(screen.getByRole('dialog', { name: 'Unlink School?' }).textContent).toContain(
      'you will need a new invitation',
    );
  });

  it('says the identity was linked, then cleans the address', async () => {
    window.history.replaceState(null, '', '/settings/account?oidc=linked');
    await renderWithTeam(<AccountPage />);
    expect((await screen.findByRole('status')).textContent).toContain('Your identity is linked');
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.pathname).toBe('/settings/account');
  });

  it('explains a refused return in plain words', async () => {
    window.history.replaceState(null, '', '/sign-in?oidc_error=identity_taken');
    await renderWithTeam(<AccountPage />);
    expect((await screen.findAllByRole('alert'))[0]!.textContent).toContain(
      'This identity is already linked to someone else on this Hub.',
    );
  });
});
