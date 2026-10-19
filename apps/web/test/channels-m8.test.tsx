// Channels in M8 (FR-110): email that signs in with OAuth (the provider's settings, the redirect
// URI to register, Authorize with the browser sent to the provider, the return, the state, Sign
// out that asks first, the write-only client secret), Telegram files in the message log, and a
// member's Channels page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ChannelBindingViewM7 } from '@nova/shared';
import { ChannelsPage } from '../src/channels/ChannelsPage.tsx';
import { MAIL_OAUTH_TEXT, isFileRow, mailOAuthRedirectUri } from '../src/channels/format.ts';
import { mailOAuthRowNote, usesMailOAuth } from '../src/channels/MailOAuth.tsx';
import { oauthRedirect } from '../src/settings/McpAuth.tsx';
import { MEMBER_MODE_TEXT } from '../src/team/format.ts';
import { FakeEventSource } from './fakes.ts';
import { bindingM7, messageView } from './fakes-m7-misc.ts';
import { renderW11 } from './fakes-m8-appauth.ts';
import { resetDom } from './render.tsx';

let go: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  go = vi.spyOn(oauthRedirect, 'go').mockImplementation(() => undefined);
});
afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const MAILBOX = {
  address: 'agent@example.com',
  imapHost: 'imap.example.com',
  smtpHost: 'smtp.example.com',
};
const OAUTH = {
  ...MAILBOX,
  auth: 'oauth',
  oauthAuthUrl: 'https://login.mail.example.com/oauth2/authorize',
  oauthTokenUrl: 'https://login.mail.example.com/oauth2/token',
  oauthClientId: 'nova-client',
  oauthScopes: 'https://mail.example.com/imap https://mail.example.com/smtp',
};
const oauthMail = (over: Partial<ChannelBindingViewM7> = {}) =>
  bindingM7({
    id: 'em1',
    kind: 'email',
    label: 'Email with Sam',
    config: OAUTH,
    ...over,
  });

const addButton = () =>
  screen.getAllByRole<HTMLButtonElement>('button', { name: 'Add channel' })[0]!;

const open = async (opts: Parameters<typeof renderW11>[1] = {}) => {
  const r = await renderW11(<ChannelsPage />, opts);
  await screen.findByRole('heading', { name: 'Your channels' });
  await waitFor(() => expect(addButton().disabled).toBe(false));
  return r;
};

/** Pastes into a field: typing long URLs key by key re-renders the dialog hundreds of times. */
async function fill(el: HTMLElement, value: string) {
  await userEvent.click(el);
  await userEvent.paste(value);
}

describe('email OAuth (FR-110, M8)', () => {
  it('adds a mailbox that signs in with OAuth, then sends the browser to the provider', async () => {
    const { api, channels, state } = await open();
    await userEvent.click(addButton());
    const d = within(screen.getByRole('dialog', { name: 'Add a channel' }));
    await userEvent.click(d.getByRole('radio', { name: 'Email' }));
    await fill(d.getByLabelText('Their email address'), 'sam@example.com');
    await fill(d.getByLabelText('Mailbox address'), 'agent@example.com');
    await userEvent.click(d.getByRole('radio', { name: MAIL_OAUTH_TEXT.oauth }));
    expect(d.queryByLabelText('Password', { selector: 'input[type=password]' })).toBeNull();
    expect(d.getByText(mailOAuthRedirectUri())).toBeTruthy();
    expect(d.getByText(MAIL_OAUTH_TEXT.redirectHint)).toBeTruthy();
    await fill(d.getByLabelText('IMAP server'), 'imap.example.com');
    await fill(d.getByLabelText('SMTP server'), 'smtp.example.com');
    // The provider's endpoints and the client ID are needed; nothing is sent without them.
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    expect(await d.findByText('Enter the authorization URL.')).toBeTruthy();
    expect(d.getByText('Enter the client ID.')).toBeTruthy();
    expect(api.createChannel).not.toHaveBeenCalled();
    await fill(d.getByLabelText('Authorization URL'), OAUTH.oauthAuthUrl);
    await fill(d.getByLabelText('Token URL'), OAUTH.oauthTokenUrl);
    await fill(d.getByLabelText('Client ID'), 'nova-client');
    await fill(d.getByLabelText('Scopes'), 'imap smtp');
    await fill(d.getByLabelText(MAIL_OAUTH_TEXT.clientSecret), 'shh-secret');
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    const done = within(await screen.findByRole('dialog', { name: /Finish setting up/ }));
    expect(api.createChannel).toHaveBeenCalledWith({
      kind: 'email',
      externalRef: 'sam@example.com',
      audience: 'shared',
      config: {
        address: 'agent@example.com',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
        auth: 'oauth',
        oauthAuthUrl: OAUTH.oauthAuthUrl,
        oauthTokenUrl: OAUTH.oauthTokenUrl,
        oauthClientId: 'nova-client',
        oauthScopes: 'imap smtp',
      },
      oauthClientSecret: 'shh-secret',
    });
    const made = channels.bindings.at(-1)!;
    expect(channels.secrets[`${made.id}/oauthClientSecret`]).toBe('shh-secret');
    expect(channels.secrets[`${made.id}/password`]).toBeUndefined();
    expect(done.getByText('Not authorized yet')).toBeTruthy();
    await userEvent.click(
      done.getByRole('button', { name: MAIL_OAUTH_TEXT.authorizeLabel(made.label) }),
    );
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(api.startChannelOAuth).toHaveBeenCalledWith(made.id);
    expect(String(go.mock.calls[0]![0])).toMatch(
      new RegExp(`^${state.providerUrl.replace(/[?.]/g, '\\$&')}&state=`),
    );
  });

  it('shows a mailbox waiting to be authorized in its row, and Connected once it is', async () => {
    const { api } = await open({ channels: { bindings: [oauthMail()] } });
    const row = await screen.findByRole('listitem', { name: 'Email with Sam' });
    expect(within(row).getByText(MAIL_OAUTH_TEXT.rowNeeds)).toBeTruthy();
    expect(within(row).getByText('Needs setup')).toBeTruthy();
    await userEvent.click(
      within(row).getByRole('button', { name: MAIL_OAUTH_TEXT.authorizeLabel('Email with Sam') }),
    );
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    // The provider sends the browser back; the Hub stored the tokens.
    api.authorizeMailbox('em1');
    FakeEventSource.for('/api/v1/events/stream').emit('channel.binding.changed', {
      bindingId: 'em1',
    });
    await waitFor(() => expect(within(row).getByText('Connected')).toBeTruthy());
    expect(within(row).queryByText(MAIL_OAUTH_TEXT.rowNeeds)).toBeNull();
    expect(within(row).queryByRole('button', { name: /^Authorize/ })).toBeNull();
  });

  it('says what came back from the provider, once, and cleans the address', async () => {
    window.history.replaceState(null, '', '/settings/channels?oauth=ok');
    await open();
    expect(await screen.findByText(MAIL_OAUTH_TEXT.returnedOk)).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.pathname).toBe('/settings/channels');
    resetDom();
    window.history.replaceState(null, '', '/settings/channels?oauth=error');
    await open();
    expect(await screen.findByText(MAIL_OAUTH_TEXT.returnedError)).toBeTruthy();
  });

  it('shows the authorization in the settings, signs out only after asking', async () => {
    const { api, state } = await open({
      channels: { bindings: [oauthMail()] },
      appauth: {
        mailOAuth: {
          em1: {
            status: 'connected',
            scopes: ['imap', 'smtp'],
            expiresAt: null,
            authorizedAt: '2026-10-01T12:00:00.000Z',
            lastError: null,
          },
        },
      },
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Settings of Email with Sam' }),
    );
    const panel = await screen.findByRole('group', {
      name: MAIL_OAUTH_TEXT.panelLabel('Email with Sam'),
    });
    expect(within(panel).getByText('Authorized')).toBeTruthy();
    expect(within(panel).getByText(MAIL_OAUTH_TEXT.scopes('imap smtp'))).toBeTruthy();
    expect(within(panel).getByText(MAIL_OAUTH_TEXT.renews)).toBeTruthy();
    // The provider's settings show because this mailbox uses OAuth.
    expect(screen.getByLabelText<HTMLInputElement>('Authorization URL').value).toBe(
      OAUTH.oauthAuthUrl,
    );
    await userEvent.click(
      within(panel).getByRole('button', { name: MAIL_OAUTH_TEXT.signOutLabel('Email with Sam') }),
    );
    const dialog = screen.getByRole('dialog', { name: MAIL_OAUTH_TEXT.signOutTitle });
    expect(dialog.textContent).toContain(MAIL_OAUTH_TEXT.signOutWhat);
    expect(api.revokeChannelOAuth).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: MAIL_OAUTH_TEXT.signOut }));
    await waitFor(() => expect(api.revokeChannelOAuth).toHaveBeenCalledWith('em1'));
    expect(await screen.findByText(MAIL_OAUTH_TEXT.signedOut('Email with Sam'))).toBeTruthy();
    expect(state.mailOAuth.em1?.status).toBe('needs_auth');
    expect(await within(panel).findByText('Not authorized yet')).toBeTruthy();
  });

  it('asks to authorize again when the provider no longer accepts the sign-in', async () => {
    await open({
      channels: { bindings: [oauthMail()] },
      appauth: {
        mailOAuth: {
          em1: {
            status: 'expired',
            scopes: [],
            expiresAt: null,
            authorizedAt: null,
            lastError: 'invalid_grant',
          },
        },
      },
    });
    const row = await screen.findByRole('listitem', { name: 'Email with Sam' });
    expect(within(row).getByText(MAIL_OAUTH_TEXT.rowExpired)).toBeTruthy();
    expect(
      within(row).getByRole('button', {
        name: MAIL_OAUTH_TEXT.authorizeAgainLabel('Email with Sam'),
      }),
    ).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Settings of Email with Sam' }));
    const panel = await screen.findByRole('group', {
      name: MAIL_OAUTH_TEXT.panelLabel('Email with Sam'),
    });
    expect(within(panel).getByText('Authorization expired')).toBeTruthy();
    expect(within(panel).getByText(MAIL_OAUTH_TEXT.expiredHelp)).toBeTruthy();
    expect(within(panel).getByText(MAIL_OAUTH_TEXT.lastError('invalid_grant'))).toBeTruthy();
    await userEvent.click(
      within(panel).getByRole('button', {
        name: MAIL_OAUTH_TEXT.authorizeAgainLabel('Email with Sam'),
      }),
    );
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
  });

  it('keeps the client secret write-only and replaces it', async () => {
    const { channels, api } = await open({ channels: { bindings: [oauthMail()] } });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Settings of Email with Sam' }),
    );
    const creds = await screen.findByRole('list', { name: 'Credentials' });
    expect(within(creds).getByText('OAuth client secret')).toBeTruthy();
    expect(within(creds).getByText('Not set')).toBeTruthy();
    await userEvent.click(
      within(creds).getByRole('button', { name: 'Replace oauth client secret' }),
    );
    await userEvent.type(screen.getByLabelText('New oauth client secret'), 'a-new-secret');
    await userEvent.click(within(creds).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(channels.secrets['em1/oauthClientSecret']).toBe('a-new-secret'));
    expect(api.updateChannel).toHaveBeenCalledWith('em1', {
      credentials: { oauthClientSecret: 'a-new-secret' },
    });
    expect(document.body.textContent).not.toContain('a-new-secret');
  });

  it('switches a password mailbox to OAuth, and shows the Hub’s refusal at its field', async () => {
    const MAIL = bindingM7({ id: 'em2', kind: 'email', label: 'Email with Kim', config: MAILBOX });
    const { api } = await open({ channels: { bindings: [MAIL] } });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Settings of Email with Kim' }),
    );
    expect(screen.queryByLabelText('Authorization URL')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('How Nova signs in'), 'oauth');
    expect(screen.getByLabelText('Authorization URL')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('OAuth sign-in needs oauthAuthUrl')).toBeTruthy();
    expect(api.updateChannel).toHaveBeenCalledWith('em2', { config: { auth: 'oauth' } });
    await userEvent.type(screen.getByLabelText('Authorization URL'), OAUTH.oauthAuthUrl);
    await userEvent.type(screen.getByLabelText('Token URL'), OAUTH.oauthTokenUrl);
    await userEvent.type(screen.getByLabelText('Client ID'), 'nova-client');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Email with Kim saved.')).toBeTruthy();
    expect(
      await screen.findByRole('group', { name: MAIL_OAUTH_TEXT.panelLabel('Email with Kim') }),
    ).toBeTruthy();
  });

  it('refuses an unsafe provider page and says why a start failed', async () => {
    const { state } = await open({ channels: { bindings: [oauthMail()] } });
    state.providerUrl = 'http://login.mail.example.com/authorize?x=1';
    const row = await screen.findByRole('listitem', { name: 'Email with Sam' });
    await userEvent.click(
      within(row).getByRole('button', { name: MAIL_OAUTH_TEXT.authorizeLabel('Email with Sam') }),
    );
    expect(await screen.findByText(MAIL_OAUTH_TEXT.unsafeUrl)).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
  });

  it('knows which bindings use OAuth and what their rows say', () => {
    const base = oauthMail() as unknown as ChannelBindingViewM7;
    expect(usesMailOAuth(base)).toBe(true);
    expect(usesMailOAuth({ ...base, kind: 'telegram' })).toBe(false);
    expect(mailOAuthRowNote({ ...base, oauth: null })).toBe(MAIL_OAUTH_TEXT.rowNeeds);
    expect(
      mailOAuthRowNote({
        ...base,
        oauth: {
          status: 'expired',
          scopes: [],
          expiresAt: null,
          authorizedAt: null,
          lastError: null,
        },
      }),
    ).toBe(MAIL_OAUTH_TEXT.rowExpired);
    expect(
      mailOAuthRowNote({
        ...base,
        oauth: {
          status: 'connected',
          scopes: [],
          expiresAt: null,
          authorizedAt: null,
          lastError: null,
        },
      }),
    ).toBeNull();
    expect(mailOAuthRedirectUri('https://nova.example.com/')).toBe(
      'https://nova.example.com/api/v1/channels/oauth/callback',
    );
  });
});

describe('files in the message log (FR-110, M8)', () => {
  it('marks a file the agent sent and explains held-back files', async () => {
    const TG = bindingM7({ id: 'tg1', kind: 'telegram', label: 'Telegram family' });
    await open({
      channels: { bindings: [TG] },
      misc: {
        messages: [
          messageView({ bindingId: 'tg1', direction: 'in', status: 'started' }),
          messageView({
            bindingId: 'tg1',
            direction: 'out',
            status: 'sent',
            reason: 'file',
            conversation: '-100777',
          }),
          messageView({
            bindingId: 'tg1',
            direction: 'out',
            status: 'withheld',
            reason: 'files_not_supported',
          }),
        ],
      },
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Messages of Telegram family' }),
    );
    const log = await screen.findByRole('list', { name: /Messages of Telegram family/ });
    expect(within(log).getAllByRole('listitem')).toHaveLength(3);
    const file = within(log).getByText('A file from the agent’s reply.').closest('li')!;
    expect(within(file).getByText('File')).toBeTruthy();
    expect(within(file).getByText('Sent', { selector: '.nv-chip span' })).toBeTruthy();
    expect(within(log).getAllByText('File')).toHaveLength(1);
    expect(within(log).getByText('This channel does not carry files.')).toBeTruthy();
    expect(isFileRow({ direction: 'in', reason: 'file' })).toBe(false);
  });
});

describe('a member’s Channels page (ADR-097 D7)', () => {
  it('shows their own channels and people, and says who sets the Hub’s parts', async () => {
    await open({ member: true });
    expect(await screen.findByText(MEMBER_MODE_TEXT.channels)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'People' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Public address' })).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Private details in shared channels' }),
    ).toBeNull();
    expect(screen.getByText(MEMBER_MODE_TEXT.channelsOwner)).toBeTruthy();
    await userEvent.click(addButton());
    const d = within(screen.getByRole('dialog', { name: 'Add a channel' }));
    await userEvent.click(d.getByRole('radio', { name: 'Email' }));
    expect(d.getByText(MEMBER_MODE_TEXT.mailAddresses)).toBeTruthy();
  });

  it('shows the owner every part', async () => {
    await open();
    expect(await screen.findByRole('heading', { name: 'Public address' })).toBeTruthy();
    expect(screen.queryByText(MEMBER_MODE_TEXT.channels)).toBeNull();
  });
});
