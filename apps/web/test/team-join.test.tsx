// Joining with an invitation (decision 5) and signing in with a provider (FR-113), without a
// session: `/join` reads the one-use token from the link and removes it from the address, checks
// it with the Hub, then joins with a display name or continues with a provider; used, withdrawn or
// expired links, too many tries and an unreachable Hub are said plainly. The sign-in screen offers
// the enabled providers and explains a refused return. `/profile/<handle>` shows a public card.
/* eslint-disable @typescript-eslint/require-await */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JoinPreviewView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { App } from '../src/App.tsx';
import { memberClient, type MemberClient } from '../src/joinmember/client.ts';
import {
  JoinMemberPage,
  isMemberJoinPath,
  readInvitation,
  tokenFromPaste,
} from '../src/joinmember/JoinMemberPage.tsx';
import { memberPublicPage } from '../src/joinmember/pages.tsx';
import { PublicProfilePage, profileHandleFrom } from '../src/joinmember/PublicProfilePage.tsx';
import { SignInOptions } from '../src/joinmember/SignInOptions.tsx';
import { browser } from '../src/team/leave.ts';
import { createHub, fakeEventSource } from './fakes.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const TOKEN = `nvi_${'a'.repeat(43)}`;
const preview = (over: Partial<JoinPreviewView> = {}): JoinPreviewView => ({
  valid: true,
  label: 'Alex',
  invitedBy: 'Sam',
  expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  providers: [],
  ...over,
});
const refusal = (status: number, code: string, reason?: string) =>
  new ApiError(status, {
    code,
    message: code.replace(/_/g, ' '),
    retryable: false,
    ...(reason ? { details: { reason } } : {}),
  });

function client(over: Partial<Record<keyof MemberClient, unknown>> = {}) {
  return {
    joinPreview: vi.fn(async () => preview()),
    join: vi.fn(async () => ({ accountId: 'acc-new', role: 'member' as const })),
    oidcProviders: vi.fn(async () => ({ items: [] as { id: string; label: string }[] })),
    oidcStart: vi.fn(async () => ({
      url: 'https://accounts.example.com/authorize?state=s',
      expiresAt: '2026-10-01T12:10:00.000Z',
    })),
    publicProfile: vi.fn(async () => ({ handle: 'sam', displayName: 'Sam', avatarPath: null })),
    ...over,
  } as unknown as MemberClient & Record<keyof MemberClient, ReturnType<typeof vi.fn>>;
}

describe('the invitation link', () => {
  it('reads the token from the fragment or the query, never a short one', () => {
    expect(readInvitation('', `#invite=${TOKEN}`)).toBe(TOKEN);
    expect(readInvitation(`?token=${TOKEN}`, '')).toBe(TOKEN);
    expect(readInvitation('', '#invite=short')).toBeNull();
    expect(tokenFromPaste(`https://hub.local/join#invite=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromPaste(TOKEN)).toBe(TOKEN);
    expect(tokenFromPaste('  ')).toBeNull();
    expect(tokenFromPaste('https://hub.local/chat')).toBeNull();
    expect(isMemberJoinPath('/join/')).toBe(true);
    expect(isMemberJoinPath('/joined')).toBe(false);
    expect(memberPublicPage('/join')).toEqual({ kind: 'join' });
    expect(memberPublicPage('/profile/sam-home')).toEqual({ kind: 'profile', handle: 'sam-home' });
    expect(memberPublicPage('/profile/A')).toBeNull();
    expect(memberPublicPage('/chat')).toBeNull();
    expect(profileHandleFrom('/profile/x')).toBeNull();
  });
});

describe('/join', () => {
  it('joins with a display name and opens Nova', async () => {
    const leave = vi.spyOn(browser, 'leaveTo').mockImplementation(() => undefined);
    const c = client();
    render(<JoinMemberPage client={c} search="" hash={`#invite=${TOKEN}`} />);
    expect(
      await screen.findByText(/Sam invited you \(Alex\)\. The invitation expires in 3 days\./),
    ).toBeTruthy();
    expect(screen.getByText(/your own chats, memory, connectors and settings/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(screen.getByText('Enter the name the people of this Hub will see.')).toBeTruthy();
    expect(c.join).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Your name'), 'Alex');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(c.join).toHaveBeenCalledWith(TOKEN, 'Alex');
    expect(await screen.findByRole('heading', { name: 'You joined' })).toBeTruthy();
    expect(leave).toHaveBeenCalledWith('/');
  });

  it('continues with a provider, carrying the invitation and the name', async () => {
    const leave = vi.spyOn(browser, 'leaveTo').mockImplementation(() => undefined);
    const c = client({
      joinPreview: vi.fn(async () => preview({ providers: [{ id: 'oidc-a', label: 'School' }] })),
    });
    render(<JoinMemberPage client={c} search="" hash={`#invite=${TOKEN}`} />);
    await userEvent.type(await screen.findByLabelText('Your name'), 'Alex');
    await userEvent.click(screen.getByRole('button', { name: 'Continue with School' }));
    expect(c.oidcStart).toHaveBeenCalledWith({
      providerId: 'oidc-a',
      flow: 'join',
      invitation: TOKEN,
      displayName: 'Alex',
    });
    expect(leave).toHaveBeenCalledWith('https://accounts.example.com/authorize?state=s');
  });

  it('says plainly when the link was used, withdrawn or expired', async () => {
    render(
      <JoinMemberPage
        client={client({ joinPreview: vi.fn(async () => preview({ valid: false })) })}
        search=""
        hash={`#invite=${TOKEN}`}
      />,
    );
    const h = await screen.findByRole('heading', { name: 'This invitation cannot be used' });
    expect(document.activeElement).toBe(h);
    expect(screen.getByRole('alert').textContent).toContain('used already, withdrawn by the owner');
    expect(screen.getByRole('link', { name: 'Open Nova' })).toBeTruthy();
  });

  it('goes to the used-link page when the Hub refuses the join itself', async () => {
    const c = client({
      join: vi.fn(async () => Promise.reject(refusal(401, 'auth_missing', 'invitation_invalid'))),
    });
    render(<JoinMemberPage client={c} search="" hash={`#invite=${TOKEN}`} />);
    await userEvent.type(await screen.findByLabelText('Your name'), 'Alex');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(
      await screen.findByRole('heading', { name: 'This invitation cannot be used' }),
    ).toBeTruthy();
  });

  it('says when there were too many tries, and retries', async () => {
    const c = client({
      joinPreview: vi
        .fn()
        .mockRejectedValueOnce(refusal(429, 'rate_limited', 'address_rate_limited'))
        .mockResolvedValueOnce(preview()),
    });
    render(<JoinMemberPage client={c} search="" hash={`#invite=${TOKEN}`} />);
    expect(await screen.findByRole('heading', { name: 'Too many tries' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(
      'Too many tries from this address. Wait a minute and try again.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Your name')).toBeTruthy();
  });

  it('keeps the form and the name when joining fails for another reason', async () => {
    const c = client({ join: vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))) });
    render(<JoinMemberPage client={c} search="" hash={`#invite=${TOKEN}`} />);
    const name = await screen.findByLabelText<HTMLInputElement>('Your name');
    await userEvent.type(name, 'Alex');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Cannot reach the Hub');
    expect(name.value).toBe('Alex');
  });

  it('asks for the link when there is none, and checks what is pasted', async () => {
    const c = client();
    render(<JoinMemberPage client={c} search="" hash="" />);
    await userEvent.type(screen.getByLabelText('Invitation link'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText(/That is not an invitation link/)).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('Invitation link'));
    await userEvent.type(
      screen.getByLabelText('Invitation link'),
      `https://hub.local/join#invite=${TOKEN}`,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText('Your name')).toBeTruthy();
    expect(c.joinPreview).toHaveBeenCalledWith(TOKEN);
  });

  it('removes the token from the address bar at once', async () => {
    window.history.replaceState(null, '', `/join#invite=${TOKEN}`);
    render(<JoinMemberPage client={client()} />);
    await screen.findByLabelText('Your name');
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/join');
  });
});

describe('the sign-in screen’s providers', () => {
  it('renders nothing without providers or a refusal', async () => {
    const c = client();
    const { container } = render(<SignInOptions client={c} search="" />);
    await waitFor(() => expect(c.oidcProviders).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('offers each enabled provider and leaves for it', async () => {
    const leave = vi.spyOn(browser, 'leaveTo').mockImplementation(() => undefined);
    const c = client({
      oidcProviders: vi.fn(async () => ({ items: [{ id: 'oidc-a', label: 'Company sign-in' }] })),
    });
    render(<SignInOptions client={c} search="" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Continue with Company sign-in' }),
    );
    expect(c.oidcStart).toHaveBeenCalledWith({ providerId: 'oidc-a', flow: 'sign_in' });
    expect(leave).toHaveBeenCalledWith('https://accounts.example.com/authorize?state=s');
  });

  it('explains a refused return, and a provider that cannot be reached', async () => {
    const c = client({
      oidcProviders: vi.fn(async () => ({ items: [{ id: 'oidc-a', label: 'Company sign-in' }] })),
      oidcStart: vi.fn(async () =>
        Promise.reject(
          new ApiError(503, {
            code: 'node_unavailable',
            message: 'the sign-in provider cannot be reached',
            retryable: true,
            details: { reason: 'discovery' },
          }),
        ),
      ),
    });
    render(<SignInOptions client={c} search="?oidc_error=not_linked" />);
    expect((await screen.findAllByRole('alert'))[0]!.textContent).toContain(
      'This identity is not linked to anyone on this Hub',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Continue with Company sign-in' }),
    );
    expect((await screen.findAllByRole('alert')).at(-1)!.textContent).toContain(
      'The Hub could not reach the sign-in provider',
    );
  });
});

describe('/profile/<handle>', () => {
  it('shows only the published name and handle, and the avatar from the Hub’s own route', async () => {
    const c = client({
      publicProfile: vi.fn(async () => ({
        handle: 'sam',
        displayName: 'Sam',
        avatarPath: '/api/v1/profiles/sam/avatar',
      })),
    });
    render(<PublicProfilePage handle="sam" client={c} />);
    expect(await screen.findByRole('heading', { name: 'Sam' })).toBeTruthy();
    expect(screen.getByText('@sam')).toBeTruthy();
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/api/v1/profiles/sam/avatar');
    resetDom();
    render(
      <PublicProfilePage
        handle="sam"
        client={client({
          publicProfile: vi.fn(async () => ({
            handle: 'sam',
            displayName: 'Sam',
            avatarPath: 'https://evil.example/x.png',
          })),
        })}
      />,
    );
    await screen.findByRole('heading', { name: 'Sam' });
    expect(document.querySelector('img')).toBeNull();
  });

  it('says when there is no card, and when the Hub refuses', async () => {
    render(
      <PublicProfilePage
        handle="nobody"
        client={client({
          publicProfile: vi.fn(async () => Promise.reject(refusal(404, 'not_found'))),
        })}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'No public card here' })).toBeTruthy();
    resetDom();
    render(
      <PublicProfilePage
        handle="sam"
        client={client({
          publicProfile: vi.fn(async () => Promise.reject(refusal(429, 'rate_limited'))),
        })}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('Too many tries');
  });
});

describe('the public client', () => {
  it('posts JSON and turns refusals into ApiErrors', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(
          JSON.stringify({
            error: { code: 'rate_limited', message: 'slow down', retryable: true },
          }),
          {
            status: 429,
          },
        );
      return new Response(JSON.stringify({ items: [{ id: 'oidc-a', label: 'School' }] }), {
        status: 200,
      });
    });
    const c = memberClient(fetchImpl as unknown as typeof fetch);
    expect((await c.oidcProviders()).items[0]!.label).toBe('School');
    await expect(c.join(TOKEN, 'Alex')).rejects.toMatchObject({ status: 429 });
    const [, init] = fetchImpl.mock.calls[1]!;
    expect(JSON.parse(init?.body as string)).toEqual({ token: TOKEN, displayName: 'Alex' });
    expect(fetchImpl.mock.calls[1]![0]).toBe('/api/v1/team/join');
  });
});

describe('App', () => {
  it('serves /join without a session', async () => {
    window.history.replaceState(null, '', `/join#invite=${TOKEN}`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(preview()), { status: 200 })),
    );
    const hub = createHub();
    render(<App api={hub.api} eventSource={fakeEventSource} takeSetupCode={() => null} />);
    expect(await screen.findByLabelText('Your name')).toBeTruthy();
    expect(hub.api.session).not.toHaveBeenCalled();
  });

  it('offers the providers on the signed-out screen, next to the setup code', async () => {
    window.history.replaceState(null, '', '/sign-in?oidc_error=state_invalid');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ items: [{ id: 'oidc-a', label: 'Company sign-in' }] }), {
            status: 200,
          }),
      ),
    );
    const hub = createHub();
    hub.api.session.mockRejectedValue(
      new ApiError(401, { code: 'token_required', message: 'sign in', retryable: false }),
    );
    render(<App api={hub.api} eventSource={fakeEventSource} takeSetupCode={() => null} />);
    const signIn = await screen.findByRole('region', { name: 'Sign in' });
    expect(within(signIn).getByRole('alert').textContent).toContain(
      'This sign-in expired or was already used. Start again.',
    );
    expect(
      await within(signIn).findByRole('button', { name: 'Continue with Company sign-in' }),
    ).toBeTruthy();
    expect(screen.getByLabelText('Setup code')).toBeTruthy();
    expect(window.location.search).toBe('');
  });
});
