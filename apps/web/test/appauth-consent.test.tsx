// The consent page apps open (`/authorize`, FR-222): what the app asks for in plain words, Allow
// (all or some scopes) and Deny with the browser sent back to the app's verified redirect, the
// requests the Hub cannot trust (never answered), the refusals that go back to the app, a member,
// and the words and checks behind it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { AuthorizePage, consentRedirect } from '../src/appauth/AuthorizePage.tsx';
import {
  APPS_TEXT,
  CONSENT_TEXT,
  appErrorMessage,
  backText,
  refusalRedirect,
  sameTarget,
  scopeText,
} from '../src/appauth/format.ts';
import { appClient, appGrant, consentQuery, renderW11 } from './fakes-m8-appauth.ts';
import { resetDom } from './render.tsx';

let go: ReturnType<typeof vi.fn<(url: string) => void>>;
const realGo = consentRedirect.go;

beforeEach(() => {
  go = vi.fn<(url: string) => void>();
  consentRedirect.go = go;
});
afterEach(() => {
  consentRedirect.go = realGo;
  resetDom();
  vi.restoreAllMocks();
});

const params = (url: string) => new URL(url).searchParams;

describe('the consent page (FR-222)', () => {
  it('says what the app asks for and sends the browser back with a code on Allow', async () => {
    const q = consentQuery();
    const { api, state } = await renderW11(<AuthorizePage query={`?${q}`} />);
    const heading = await screen.findByRole('heading', {
      name: 'Allow Notes Desk to use your Hub?',
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(api.getAppConsent).toHaveBeenCalledWith(q);
    expect(screen.getByText(CONSENT_TEXT.intro('Notes Desk'))).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain(CONSENT_TEXT.nameCaution);
    expect(
      screen.getByText(
        'When you answer, Nova sends you back to an app on the computer you are using (127.0.0.1:53682).',
      ),
    ).toBeTruthy();
    const asks = screen.getByRole('group', { name: 'It asks to' });
    const name = within(asks).getByRole('checkbox', { name: 'See your name and picture' });
    const chats = within(asks).getByRole('checkbox', { name: 'Read your chats' });
    expect((name as HTMLInputElement).checked).toBe(true);
    expect((chats as HTMLInputElement).checked).toBe(true);
    expect(chats.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      screen.getByText('Your chats, their messages, attachments and artifacts, and chat search.'),
    ).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(api.decideAppConsent).toHaveBeenCalledWith({ query: q, decision: 'approve' });
    const target = params(go.mock.calls[0]![0]);
    expect(target.get('code')).toBe(state.codes[0]);
    expect(target.get('state')).toBe('xyz');
    expect(target.get('iss')).toBe(window.location.origin);
    expect(go.mock.calls[0]![0].startsWith('http://127.0.0.1:53682/callback?')).toBe(true);
    expect(screen.getByRole('status').textContent).toBe(CONSENT_TEXT.allowed('Notes Desk'));
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(state.grants.map((g) => g.scopes)).toEqual([['account:read', 'threads:read']]);
  });

  it('allows only what is still ticked, and needs at least one', async () => {
    const q = consentQuery();
    const { api, state } = await renderW11(<AuthorizePage query={q} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Read your chats' }));
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(go).toHaveBeenCalled());
    expect(api.decideAppConsent).toHaveBeenCalledWith({
      query: q,
      decision: 'approve',
      scopes: ['account:read'],
    });
    expect(state.grants[0]?.scopes).toEqual(['account:read']);
    resetDom();
    await renderW11(<AuthorizePage query={q} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Read your chats' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'See your name and picture' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow' }).disabled).toBe(true);
    expect(screen.getByText(CONSENT_TEXT.keepOne)).toBeTruthy();
  });

  it('denies: the app is told no and nothing is granted', async () => {
    const q = consentQuery();
    const { state } = await renderW11(<AuthorizePage query={q} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    const target = params(go.mock.calls[0]![0]);
    expect(target.get('error')).toBe('access_denied');
    expect(target.get('state')).toBe('xyz');
    expect(target.get('code')).toBeNull();
    expect(state.grants).toEqual([]);
    expect(screen.getByRole('status').textContent).toBe(CONSENT_TEXT.denied('Notes Desk'));
  });

  it('marks what an earlier approval allowed and says allowing again adds to it', async () => {
    await renderW11(<AuthorizePage query={consentQuery()} />, {
      appauth: { grants: [appGrant({ scopes: ['threads:read'] })] },
    });
    await screen.findByRole('heading', { name: 'Allow Notes Desk to use your Hub?' });
    expect(screen.getByText(CONSENT_TEXT.authorizedBefore)).toBeTruthy();
    const chats = screen.getByRole('checkbox', { name: 'Read your chats' }).closest('li')!;
    expect(within(chats).getByText(CONSENT_TEXT.alreadyAllowed)).toBeTruthy();
    const name = screen.getByRole('checkbox', { name: 'See your name and picture' }).closest('li')!;
    expect(within(name).queryByText(CONSENT_TEXT.alreadyAllowed)).toBeNull();
  });

  it('says which app a private-use scheme opens', async () => {
    await renderW11(
      <AuthorizePage query={consentQuery({ redirect_uri: 'com.example.notes:/oauth' })} />,
      { appauth: { clients: [appClient({ redirectUris: ['com.example.notes:/oauth'] })] } },
    );
    expect(
      await screen.findByText(
        'When you answer, Nova sends you back to the app that opens com.example.notes: links.',
      ),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(go).toHaveBeenCalled());
    expect(go.mock.calls[0]![0].startsWith('com.example.notes:/oauth?code=')).toBe(true);
  });

  it('never answers a request it cannot trust: an unknown app or an unregistered redirect', async () => {
    await renderW11(<AuthorizePage query={consentQuery({ client_id: 'app_other' })} />);
    expect(await screen.findByRole('heading', { name: CONSENT_TEXT.refusedTitle })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      'This app is not registered with this Hub, or it was removed. Start the sign-in again from the app.',
    );
    expect(screen.queryByRole('button', { name: CONSENT_TEXT.tellApp })).toBeNull();
    resetDom();
    await renderW11(
      <AuthorizePage query={consentQuery({ redirect_uri: 'http://evil.example/cb' })} />,
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The request asks to send you back to an address this app did not register. Nothing was sent there.',
    );
    expect(screen.queryByRole('button', { name: CONSENT_TEXT.tellApp })).toBeNull();
    resetDom();
    await renderW11(<AuthorizePage query={consentQuery({ redirect_uri: null })} />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The request does not say where to send you back, so it cannot be answered.',
    );
    expect(go).not.toHaveBeenCalled();
  });

  it('explains app access turned off and lets the app hear it', async () => {
    await renderW11(<AuthorizePage query={consentQuery()} />, {
      settings: { 'apps.enabled': false },
    });
    expect((await screen.findByRole('alert')).textContent).toBe(
      'App access is turned off on this Hub. The owner can turn it on in Settings → Apps.',
    );
    expect(screen.getByText(CONSENT_TEXT.tellAppHint)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: CONSENT_TEXT.tellApp }));
    expect(go).toHaveBeenCalledTimes(1);
    const target = params(go.mock.calls[0]![0]);
    expect(target.get('error')).toBe('access_denied');
    expect(target.get('state')).toBe('xyz');
  });

  it('names managed policy, and a malformed request, in plain words', async () => {
    await renderW11(<AuthorizePage query={consentQuery()} />, {
      settings: {},
      managed: {
        'managed.restrict': { layers: [{ apps: false }], failClosed: null },
        'apps.enabled': false,
      },
    });
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your organization’s managed policy does not allow this.',
    );
    resetDom();
    await renderW11(<AuthorizePage query={consentQuery({ scope: 'threads:write' })} />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The app asked for access it did not register, or that Nova does not offer.',
    );
    await userEvent.click(screen.getByRole('button', { name: CONSENT_TEXT.tellApp }));
    expect(params(go.mock.calls[0]![0]).get('error')).toBe('invalid_scope');
    resetDom();
    await renderW11(<AuthorizePage query={consentQuery({ code_challenge_method: 'plain' })} />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The app’s request is incomplete or malformed. Start the sign-in again from the app.',
    );
  });

  it('shows the refusal when access is turned off between loading and the answer', async () => {
    const { hub, api } = await renderW11(<AuthorizePage query={consentQuery()} />);
    await screen.findByRole('heading', { name: 'Allow Notes Desk to use your Hub?' });
    hub.state.settings = { ...hub.state.settings, 'apps.enabled': false };
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(await screen.findByRole('heading', { name: CONSENT_TEXT.refusedTitle })).toBeTruthy();
    expect(api.decideAppConsent).toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
  });

  it('keeps the form and says why when the answer fails, and refuses a foreign redirect', async () => {
    const { api } = await renderW11(<AuthorizePage query={consentQuery()} />, {
      fail: {
        decideAppConsent: new ApiError(400, {
          code: 'validation',
          message: 'the app did not ask for usage:read',
          retryable: false,
          details: { field: 'scopes', reason: 'not_requested' },
        }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You can only allow what the app asked for.',
    );
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    api.decideAppConsent.mockResolvedValueOnce({ redirectTo: 'https://evil.example/cb?code=1' });
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(CONSENT_TEXT.badRedirect),
    );
    expect(go).not.toHaveBeenCalled();
  });

  it('has nothing to answer without a request, and is the owner’s alone', async () => {
    const { api } = await renderW11(<AuthorizePage query="" />);
    expect(await screen.findByRole('heading', { name: CONSENT_TEXT.noRequest })).toBeTruthy();
    expect(api.getAppConsent).not.toHaveBeenCalled();
    resetDom();
    const member = await renderW11(<AuthorizePage query={consentQuery()} />, { member: true });
    expect(await screen.findByRole('heading', { name: CONSENT_TEXT.ownerOnly })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe(CONSENT_TEXT.ownerOnlyDetail);
    expect(member.api.getAppConsent).not.toHaveBeenCalled();
  });
});

describe('the words and checks behind it', () => {
  it('compares the target with the app’s redirect by scheme, host and path', () => {
    expect(sameTarget('http://127.0.0.1:5000/cb?code=1', 'http://127.0.0.1:5000/cb')).toBe(true);
    expect(sameTarget('http://127.0.0.1:5001/cb?code=1', 'http://127.0.0.1:5000/cb')).toBe(false);
    expect(sameTarget('com.example.app:/cb?code=1', 'com.example.app:/cb')).toBe(true);
    expect(sameTarget('com.other.app:/cb?code=1', 'com.example.app:/cb')).toBe(false);
    expect(sameTarget('not a url', 'com.example.app:/cb')).toBe(false);
  });

  it('says where the browser goes and what each scope means', () => {
    expect(backText({ redirectUri: 'http://[::1]:8080/cb', redirectKind: 'loopback' })).toContain(
      '([::1]:8080)',
    );
    expect(backText({ redirectUri: '::bad', redirectKind: 'private_scheme' })).toBe(
      CONSENT_TEXT.backScheme(''),
    );
    expect(scopeText('usage:read').label).toBe('See your usage');
    expect(scopeText('devices:read')).toEqual({ label: 'devices:read', description: '' });
  });

  it('turns every refusal into plain words, never a raw code', () => {
    const e = (status: number, code: string, details?: Record<string, unknown>, message = 'x') =>
      new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });
    expect(appErrorMessage(e(403, 'policy_denied', { reason: 'owner_only' }))).toBe(
      'Only the owner of this Hub can change this.',
    );
    expect(appErrorMessage(e(429, 'rate_limited', { reason: 'address_rate_limited' }))).toBe(
      'Too many requests from this address. Wait a minute and try again.',
    );
    expect(appErrorMessage(e(404, 'not_found'))).toBe('It is no longer there. Refresh the page.');
    expect(
      appErrorMessage(e(400, 'validation', { issues: [{ path: 'endpoint', message: 'bad' }] })),
    ).toContain('https://');
    expect(appErrorMessage(e(400, 'validation', { field: 'headers' }))).toBe('At most 20 headers.');
    expect(
      appErrorMessage(e(400, 'validation', { issues: [{ path: 'headers.x y', message: 'bad' }] })),
    ).toContain('letters, digits and hyphens');
    expect(appErrorMessage(e(500, 'server_error', undefined, 'boom'))).toBe('boom');
    expect(appErrorMessage(new Error('Failed to fetch'))).toContain('Cannot reach the Hub');
    expect(refusalRedirect(e(403, 'policy_denied', { redirectTo: 'app:/x?error=a' }))).toBe(
      'app:/x?error=a',
    );
    expect(refusalRedirect(new Error('x'))).toBeNull();
    expect(APPS_TEXT.revokeWhat('Notes', 0)).toContain('its tokens stop working');
    expect(APPS_TEXT.revokeWhat('Notes', 2)).toContain('its 2 sign-ins end');
  });
});
