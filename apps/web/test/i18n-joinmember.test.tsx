// The team's pages without a session in the pseudo-locale (FR-016): joining with an invitation
// (asking for the link, the form, a used link, a joined member), the sign-in screen's providers
// and a public profile card come from messages. Names, labels and providers are data.
/* eslint-disable @typescript-eslint/require-await */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { JoinPreviewView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import type { MemberClient } from '../src/joinmember/client.ts';
import { JoinMemberPage } from '../src/joinmember/JoinMemberPage.tsx';
import { PublicProfilePage } from '../src/joinmember/PublicProfilePage.tsx';
import { SignInOptions } from '../src/joinmember/SignInOptions.tsx';
import { JOIN_MEMBER_TEXT, PROFILE_TEXT, SIGN_IN_TEXT } from '../src/joinmember/strings.ts';
import { browser } from '../src/team/leave.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  vi.restoreAllMocks();
});

const TOKEN = `nvi_${'a'.repeat(43)}`;
/** Who invited, the invitation's label, providers and the profile's names. */
const DATA = ['Sam', 'Alex', 'School', 'Company sign-in'];

const preview = (over: Partial<JoinPreviewView> = {}): JoinPreviewView => ({
  valid: true,
  label: 'Alex',
  invitedBy: 'Sam',
  expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  providers: [{ id: 'oidc-a', label: 'School' }],
  ...over,
});

function client(over: Partial<Record<keyof MemberClient, unknown>> = {}) {
  return {
    joinPreview: vi.fn(async () => preview()),
    join: vi.fn(async () => ({ accountId: 'acc-new', role: 'member' as const })),
    oidcProviders: vi.fn(async () => ({
      items: [{ id: 'oidc-a', label: 'Company sign-in' }],
    })),
    oidcStart: vi.fn(async () => ({
      url: 'https://accounts.example.com/authorize?state=s',
      expiresAt: '2026-10-01T12:10:00.000Z',
    })),
    publicProfile: vi.fn(async () => ({ handle: 'sam', displayName: 'Sam', avatarPath: null })),
    ...over,
  } as unknown as MemberClient;
}

describe('the team’s public pages in a pseudo-locale', () => {
  it('shows the invitation form, the name check and the joined page localized', async () => {
    vi.spyOn(browser, 'leaveTo').mockImplementation(() => undefined);
    await activateTestLocale('en-XA');
    const { container } = render(
      <JoinMemberPage client={client()} search="" hash={`#invite=${TOKEN}`} />,
    );
    await screen.findByRole('button', { name: JOIN_MEMBER_TEXT.join });
    expect(container.textContent).toContain(
      JOIN_MEMBER_TEXT.invited.byWithLabel({ name: 'Sam', label: 'Alex' }),
    );
    await userEvent.click(screen.getByRole('button', { name: JOIN_MEMBER_TEXT.join }));
    expect(screen.getByText(JOIN_MEMBER_TEXT.enterName)).toBeTruthy();
    expectFullyLocalized(container, { data: DATA });

    await userEvent.type(screen.getByLabelText(JOIN_MEMBER_TEXT.yourName), 'Alex');
    await userEvent.click(screen.getByRole('button', { name: JOIN_MEMBER_TEXT.join }));
    await screen.findByRole('heading', { name: JOIN_MEMBER_TEXT.joinedTitle });
    expectFullyLocalized(container, { data: DATA });
  });

  it('asks for the link, and says when it cannot be used, localized', async () => {
    await activateTestLocale('en-XA');
    const { container } = render(<JoinMemberPage client={client()} search="" hash="" />);
    await userEvent.type(screen.getByLabelText(JOIN_MEMBER_TEXT.linkLabel), 'hello');
    await userEvent.click(screen.getByRole('button', { name: JOIN_MEMBER_TEXT.continue }));
    expect(screen.getByText(JOIN_MEMBER_TEXT.notInvitation)).toBeTruthy();
    expectFullyLocalized(container, { data: DATA });

    resetDom();
    const used = render(
      <JoinMemberPage
        client={client({ joinPreview: vi.fn(async () => preview({ valid: false })) })}
        search=""
        hash={`#invite=${TOKEN}`}
      />,
    );
    await screen.findByRole('heading', { name: JOIN_MEMBER_TEXT.invalidTitle });
    expectFullyLocalized(used.container, { data: DATA });
  });

  it('shows the sign-in providers and a public card localized', async () => {
    await activateTestLocale('en-XA');
    const signIn = render(<SignInOptions client={client()} search="?oidc_error=not_linked" />);
    await screen.findByRole('heading', { name: SIGN_IN_TEXT.title });
    await screen.findByRole('button', {
      name: JOIN_MEMBER_TEXT.continueWith({ provider: 'Company sign-in' }),
    });
    expectFullyLocalized(signIn.container, { data: DATA });

    resetDom();
    const card = render(<PublicProfilePage handle="sam" client={client()} />);
    await screen.findByRole('heading', { name: 'Sam' });
    expectFullyLocalized(card.container, { data: [...DATA, 'sam'] });

    resetDom();
    const missing = render(
      <PublicProfilePage
        handle="nobody"
        client={client({
          publicProfile: vi.fn(async () =>
            Promise.reject(
              new ApiError(404, { code: 'not_found', message: 'not found', retryable: false }),
            ),
          ),
        })}
      />,
    );
    await screen.findByRole('heading', { name: PROFILE_TEXT.missingTitle });
    expectFullyLocalized(missing.container);
  });
});
