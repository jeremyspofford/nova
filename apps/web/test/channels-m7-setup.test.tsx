// secret-scan: fake-file (fixture tokens, passwords and key headers only)
// Telegram and email channels (FR-110, docs/13 §4): adding a Telegram chat with the bot's token
// (polling by default; webhook mode needs an https public address), reusing a bot; adding an email
// correspondent with the mailbox (servers checked with the Hub's schema and TLS rule; the Hub's
// mailbox refusal shown), reusing a mailbox; approvals by email only through the signed link
// (never a reply); a Telegram binding's settings (the Hub-made webhook secret is never replaced
// by hand; the delivery mode changes); an email binding's mailbox settings; and mapping a
// Telegram user under People. An email binding's sender check: "From address only" asks first and
// sends `confirmSenderCheckNone` only once confirmed (cancelling keeps the DMARC default), on
// create, on a shared mailbox whose check is off, and in its settings; the Hub's `confirm_required`
// refusal is shown in plain words; the Authentication-Results name round-trips.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { ChannelsPage } from '../src/channels/ChannelsPage.tsx';
import { messageReason } from '../src/channels/format.ts';
import { bindingM7, renderM7 } from './fakes-m7-misc.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const TOKEN = '123456789:AAHfakeTelegramBotTokenValue_abcdef';

/** The toolbar's Add channel (the empty state has one too). */
const addButton = () =>
  screen.getAllByRole<HTMLButtonElement>('button', { name: 'Add channel' })[0]!;

const open = async (opts: Parameters<typeof renderM7>[1] = {}) => {
  const r = await renderM7(<ChannelsPage />, opts);
  await screen.findByRole('heading', { name: 'Your channels' });
  await waitFor(() => expect(addButton().disabled).toBe(false));
  return r;
};

const addDialog = async () => {
  await userEvent.click(addButton());
  return screen.getByRole('dialog', { name: 'Add a channel' });
};

describe('adding a Telegram chat (FR-110)', () => {
  it('adds a chat with the bot token, polling by default, and says how approvals work', async () => {
    const { channels, api } = await open();
    const dialog = await addDialog();
    const d = within(dialog);
    await userEvent.click(d.getByRole('radio', { name: 'Telegram' }));
    expect(d.getByText('A private chat or a group with your Telegram bot.')).toBeTruthy();
    await userEvent.type(d.getByLabelText('Telegram chat ID'), '-1001234567890');
    await userEvent.click(d.getByRole('radio', { name: /Private/ }));
    // Polling is the default; webhook needs an https public address, which is not set.
    expect(d.getByRole<HTMLInputElement>('radio', { name: /Polling \(default\)/ }).checked).toBe(
      true,
    );
    const webhook = d.getByRole<HTMLInputElement>('radio', { name: /^Webhook\s*Telegram posts/ });
    expect(webhook.disabled).toBe(true);
    expect(d.getByText('Needs an https public address, set on the Channels page.')).toBeTruthy();
    expect(d.getByText(/only people listed as owners can press them/)).toBeTruthy();
    // A token that is not a bot token is refused before anything is sent.
    await userEvent.type(d.getByLabelText('Bot token'), 'not-a-token');
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    expect(await d.findByText('A Telegram bot token.')).toBeTruthy();
    expect(api.createChannel).not.toHaveBeenCalled();
    await userEvent.clear(d.getByLabelText('Bot token'));
    await userEvent.type(d.getByLabelText('Bot token'), TOKEN);
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    const done = await screen.findByRole('dialog', { name: /Finish setting up/ });
    expect(api.createChannel).toHaveBeenCalledWith({
      kind: 'telegram',
      externalRef: '-1001234567890',
      audience: 'private',
      credentials: { botToken: TOKEN },
    });
    // No inbound address to paste in polling mode, and the token is never shown.
    expect(within(done).queryByText('Inbound address')).toBeNull();
    expect(done.textContent).not.toContain(TOKEN);
    expect(done.textContent).toContain('Connecting checks the bot token');
    const made = channels.bindings.at(-1)!;
    expect(channels.secrets[`${made.id}/botToken`]).toBe(TOKEN);
    expect(channels.secrets[`${made.id}/webhookSecret`]).toBeTruthy();
    await userEvent.click(within(done).getByRole('button', { name: 'Done' }));
    const row = await screen.findByRole('listitem', { name: 'Telegram -1001234567890' });
    expect(within(row).getByText('Telegram')).toBeTruthy();
    expect(within(row).getByText('Connected')).toBeTruthy();
  });

  it('uses webhook mode with an https public address, and shows that Nova registers it', async () => {
    const { api } = await open({ settings: { 'channels.publicUrl': 'https://nova.example.com' } });
    const d = within(await addDialog());
    await userEvent.click(d.getByRole('radio', { name: 'Telegram' }));
    await userEvent.type(d.getByLabelText('Telegram chat ID'), '42');
    await userEvent.type(d.getByLabelText('Bot token'), TOKEN);
    await userEvent.click(d.getByRole('radio', { name: /^Webhook\s*Telegram posts/ }));
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    const done = within(await screen.findByRole('dialog', { name: /Finish setting up/ }));
    expect(api.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ config: { mode: 'webhook' } }),
    );
    expect(
      done.getByText(/^https:\/\/nova\.example\.com\/api\/v1\/channels\/.+\/inbound$/),
    ).toBeTruthy();
    expect(done.getByText(/there is nothing to paste/)).toBeTruthy();
  });

  it('reuses another chat’s bot, and shows the Hub’s refusal of a chat bound twice', async () => {
    const FAMILY = bindingM7({ id: 'tg1', label: 'Telegram family', externalRef: '-100777' });
    const { api } = await open({ channels: { bindings: [FAMILY] } });
    const d = within(await addDialog());
    await userEvent.click(d.getByRole('radio', { name: 'Telegram' }));
    await userEvent.selectOptions(d.getByLabelText('Bot'), 'tg1');
    expect(d.queryByLabelText('Bot token')).toBeNull();
    expect(d.getByText('This channel uses that bot’s stored token and settings.')).toBeTruthy();
    await userEvent.type(d.getByLabelText('Telegram chat ID'), '-100777');
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    expect(await d.findByText('this conversation is already bound')).toBeTruthy();
    expect(api.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ shareCredentialsWith: 'tg1' }),
    );
  });
});

describe('adding an email correspondent (FR-110)', () => {
  const fillMailbox = async (d: ReturnType<typeof within>) => {
    await userEvent.type(d.getByLabelText('Their email address'), 'Sam@Example.com');
    await userEvent.type(d.getByLabelText('Mailbox address'), 'agent@example.com');
    await userEvent.type(d.getByLabelText('Password'), 'app-password-1');
    await userEvent.type(d.getByLabelText('IMAP server'), 'imap.example.com');
    await userEvent.type(d.getByLabelText('SMTP server'), 'smtp.example.com');
  };

  it('adds one with the mailbox; the password is kept, never shown, and approvals use the link', async () => {
    const { api, channels } = await open();
    const d = within(await addDialog());
    await userEvent.click(d.getByRole('radio', { name: 'Email' }));
    expect(d.getByText(/A reply to the email never answers an approval/)).toBeTruthy();
    await fillMailbox(d);
    await userEvent.click(d.getByText('More mailbox settings'));
    await userEvent.selectOptions(d.getByLabelText('Checking for mail'), 'polling');
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    const done = await screen.findByRole('dialog', { name: /Finish setting up/ });
    expect(api.createChannel).toHaveBeenCalledWith({
      kind: 'email',
      externalRef: 'sam@example.com',
      audience: 'shared',
      credentials: { password: 'app-password-1' },
      config: {
        address: 'agent@example.com',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
        mode: 'polling',
      },
    });
    expect(done.textContent).not.toContain('app-password-1');
    expect(done.textContent).toContain('signed, one-use link');
    expect(done.textContent).not.toMatch(/reply (yes|no|to approve)/i);
    const made = channels.bindings.at(-1)!;
    expect(channels.secrets[`${made.id}/password`]).toBe('app-password-1');
  });

  it('refuses a server without TLS away from this machine, and shows the Hub’s mailbox refusal', async () => {
    const { api, failNext } = await open();
    const d = within(await addDialog());
    await userEvent.click(d.getByRole('radio', { name: 'Email' }));
    await fillMailbox(d);
    await userEvent.selectOptions(d.getByLabelText('IMAP security'), 'none');
    expect(
      d.getByText('Without TLS only works for a server on this machine. Choose TLS or STARTTLS.'),
    ).toBeTruthy();
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    // The Hub says the same with field `config`.
    expect(
      await d.findByText('IMAP without TLS is only allowed on this machine; use tls or starttls'),
    ).toBeTruthy();
    await userEvent.selectOptions(d.getByLabelText('IMAP security'), '');
    expect(api.createChannel).toHaveBeenCalledTimes(1);
    failNext.createChannel = new (await import('../src/api.ts')).ApiError(400, {
      code: 'validation',
      message: 'an email binding needs its mailbox: address, imapHost and smtpHost',
      retryable: false,
      details: { field: 'config' },
    });
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    expect(await d.findByText(/needs its mailbox/)).toBeTruthy();
  });

  it('checks the addresses with the Hub’s schema before sending', async () => {
    const { api } = await open();
    const d = within(await addDialog());
    await userEvent.click(d.getByRole('radio', { name: 'Email' }));
    await userEvent.type(d.getByLabelText('Their email address'), 'not an address');
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    expect(await d.findByText('Invalid email address.')).toBeTruthy();
    expect(api.createChannel).not.toHaveBeenCalled();
  });

  it('reuses another binding’s mailbox', async () => {
    const MAIL = bindingM7({
      id: 'em1',
      kind: 'email',
      label: 'Email with Sam',
      config: {
        address: 'agent@example.com',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
      },
    });
    const { api } = await open({ channels: { bindings: [MAIL] } });
    const d = within(await addDialog());
    await userEvent.click(d.getByRole('radio', { name: 'Email' }));
    await userEvent.selectOptions(d.getByLabelText('Mailbox'), 'em1');
    expect(d.queryByLabelText('IMAP server')).toBeNull();
    await userEvent.type(d.getByLabelText('Their email address'), 'kim@example.com');
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    await screen.findByRole('dialog', { name: /Finish setting up/ });
    expect(api.createChannel).toHaveBeenCalledWith({
      kind: 'email',
      externalRef: 'kim@example.com',
      audience: 'shared',
      shareCredentialsWith: 'em1',
    });
  });
});

describe('Telegram and email settings (FR-110)', () => {
  it('shows the Hub-made webhook secret as set, never replaceable, and changes the mode', async () => {
    const TG = bindingM7({
      id: 'tg1',
      label: 'Telegram family',
      config: { botUsername: 'family_nova_bot' },
    });
    const { api } = await open({
      channels: { bindings: [TG] },
      settings: { 'channels.publicUrl': 'https://nova.example.com' },
    });
    const row = await screen.findByRole('listitem', { name: 'Telegram family' });
    await userEvent.click(within(row).getByRole('button', { name: 'Settings of Telegram family' }));
    const r = within(row);
    expect(r.getByText('@family_nova_bot')).toBeTruthy();
    const creds = within(r.getByRole('list', { name: 'Credentials' }));
    expect(creds.getByText('Webhook secret')).toBeTruthy();
    expect(creds.getByText('Made by Nova')).toBeTruthy();
    expect(creds.queryByRole('button', { name: 'Replace webhook secret' })).toBeNull();
    expect(creds.getByRole('button', { name: 'Replace bot token' })).toBeTruthy();
    // The Hub refuses it too: a hand-set webhook secret is a validation error on that field.
    await expect(
      api.updateChannel('tg1', { credentials: { webhookSecret: 'hand-made-secret' } }),
    ).rejects.toMatchObject({
      status: 400,
      body: { details: { field: 'credentials.webhookSecret' } },
    });
    api.updateChannel.mockClear();
    expect(r.queryByText('Inbound address')).toBeNull();
    await userEvent.selectOptions(r.getByLabelText('How messages arrive'), 'webhook');
    await userEvent.click(r.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.updateChannel).toHaveBeenCalledWith('tg1', { config: { mode: 'webhook' } }),
    );
    // Webhook mode gives it an inbound address, which Nova registers itself.
    expect(await r.findByText('Inbound address')).toBeTruthy();
    expect(r.getByText(/there is nothing to paste/)).toBeTruthy();
  });

  it('edits an email binding’s mailbox and shows the Hub’s refusal of an incomplete one', async () => {
    const MAIL = bindingM7({
      id: 'em1',
      kind: 'email',
      label: 'Email with Sam',
      config: {
        address: 'agent@example.com',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
      },
    });
    const { api } = await open({ channels: { bindings: [MAIL] } });
    const row = await screen.findByRole('listitem', { name: 'Email with Sam' });
    await userEvent.click(within(row).getByRole('button', { name: 'Settings of Email with Sam' }));
    const r = within(row);
    expect(r.getByText(/A reply to the email never answers an approval/)).toBeTruthy();
    expect(
      within(r.getByRole('list', { name: 'Credentials' })).getByText('Mailbox password'),
    ).toBeTruthy();
    await userEvent.clear(r.getByLabelText('SMTP server'));
    await userEvent.click(r.getByRole('button', { name: 'Save changes' }));
    expect(
      (await r.findByText(/needs its mailbox: address, imapHost and smtpHost/)).getAttribute(
        'role',
      ),
    ).toBe('alert');
    await userEvent.type(r.getByLabelText('SMTP server'), 'mail.example.com');
    await userEvent.selectOptions(r.getByLabelText('SMTP security'), 'starttls');
    await userEvent.click(r.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.updateChannel).toHaveBeenLastCalledWith('em1', {
        config: { smtpHost: 'mail.example.com', smtpSecurity: 'starttls' },
      }),
    );
  });

  it('emails a test to the correspondent after confirming', async () => {
    const MAIL = bindingM7({ id: 'em1', kind: 'email', label: 'Email with Sam' });
    const { channels } = await open({ channels: { bindings: [MAIL] } });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Send a test to Email with Sam' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Send a test to Email with Sam?' });
    expect(within(dialog).getByText('It is emailed to sam@example.com.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send test' }));
    await waitFor(() => expect(channels.sent).toHaveLength(1));
  });
});

const CONFIRM_REQUIRED = () =>
  new ApiError(400, {
    code: 'validation',
    message:
      'turning the sender check off trusts every From address; confirm it with confirmSenderCheckNone',
    retryable: false,
    details: { field: 'confirmSenderCheckNone', reason: 'confirm_required' },
  });

const MAILBOX = {
  address: 'agent@example.com',
  imapHost: 'imap.example.com',
  smtpHost: 'smtp.example.com',
};

describe('an email binding’s sender check (FR-110)', () => {
  const fill = async (d: ReturnType<typeof within>) => {
    await userEvent.click(d.getByRole('radio', { name: 'Email' }));
    await userEvent.type(d.getByLabelText('Their email address'), 'sam@example.com');
    await userEvent.type(d.getByLabelText('Mailbox address'), 'agent@example.com');
    await userEvent.type(d.getByLabelText('Password'), 'app-password-1');
    await userEvent.type(d.getByLabelText('IMAP server'), 'imap.example.com');
    await userEvent.type(d.getByLabelText('SMTP server'), 'smtp.example.com');
    await userEvent.click(d.getByText('More mailbox settings'));
  };

  it('asks before trusting the From address; cancelling keeps checking senders', async () => {
    const { api } = await open();
    const d = within(await addDialog());
    await fill(d);
    const check = d.getByLabelText<HTMLSelectElement>('Who counts as a known sender');
    await userEvent.selectOptions(check, 'none');
    const ask = d.getByRole('group', { name: 'Trust the From address?' });
    expect(ask.textContent).toContain('Anyone can then write as a person listed under People');
    expect(document.activeElement).toBe(
      within(ask).getByRole('button', { name: 'Keep checking senders' }),
    );
    // Nothing changed until confirmed.
    expect(check.value).toBe('');
    await userEvent.click(within(ask).getByRole('button', { name: 'Keep checking senders' }));
    expect(d.queryByRole('group', { name: 'Trust the From address?' })).toBeNull();
    expect(check.value).toBe('');
    expect(d.queryByText(/The sender check is off/)).toBeNull();
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    await screen.findByRole('dialog', { name: /Finish setting up/ });
    const body = (api.createChannel.mock.calls as unknown[][])[0]![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('confirmSenderCheckNone');
    expect(body.config).toEqual(MAILBOX);
  });

  it('sends the confirmation only after the user confirms', async () => {
    const { api } = await open();
    const d = within(await addDialog());
    await fill(d);
    await userEvent.selectOptions(d.getByLabelText('Who counts as a known sender'), 'none');
    await userEvent.click(
      within(d.getByRole('group', { name: 'Trust the From address?' })).getByRole('button', {
        name: 'Trust the From address',
      }),
    );
    expect(d.getByLabelText<HTMLSelectElement>('Who counts as a known sender').value).toBe('none');
    expect(d.getByRole('note').textContent).toContain(
      'The sender check is off: anyone can write as a known sender.',
    );
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    await screen.findByRole('dialog', { name: /Finish setting up/ });
    expect(api.createChannel).toHaveBeenCalledWith({
      kind: 'email',
      externalRef: 'sam@example.com',
      audience: 'shared',
      credentials: { password: 'app-password-1' },
      config: { ...MAILBOX, senderCheck: 'none' },
      confirmSenderCheckNone: true,
    });
  });

  it('shows the Hub’s confirm_required refusal in plain words', async () => {
    const { failNext } = await open();
    const d = within(await addDialog());
    await fill(d);
    failNext.createChannel = CONFIRM_REQUIRED();
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    expect(
      await d.findByText(
        'The Hub needs your confirmation before it trusts the From address. Choose “From address only” again and confirm.',
      ),
    ).toBeTruthy();
    expect(d.queryByText(/confirmSenderCheckNone/)).toBeNull();
  });

  it('asks before adding to a shared mailbox that trusts the From address', async () => {
    const OPEN_MAIL = bindingM7({
      id: 'em1',
      kind: 'email',
      label: 'Email with Sam',
      config: { ...MAILBOX, senderCheck: 'none' },
    });
    const { api } = await open({ channels: { bindings: [OPEN_MAIL] } });
    const d = within(await addDialog());
    await userEvent.click(d.getByRole('radio', { name: 'Email' }));
    await userEvent.type(d.getByLabelText('Their email address'), 'kim@example.com');
    await userEvent.selectOptions(d.getByLabelText('Mailbox'), 'em1');
    expect(d.getByRole('group', { name: 'Trust the From address?' })).toBeTruthy();
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    expect(await d.findByText(/That mailbox trusts the From address/)).toBeTruthy();
    expect(api.createChannel).not.toHaveBeenCalled();
    await userEvent.click(d.getByRole('button', { name: 'Trust the From address' }));
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    await screen.findByRole('dialog', { name: /Finish setting up/ });
    expect(api.createChannel).toHaveBeenCalledWith({
      kind: 'email',
      externalRef: 'kim@example.com',
      audience: 'shared',
      shareCredentialsWith: 'em1',
      confirmSenderCheckNone: true,
    });
  });

  it('keeps the Authentication-Results name from create to settings, and changes it', async () => {
    const { api, channels } = await open();
    const d = within(await addDialog());
    await fill(d);
    expect(d.getByText(/Mail from big providers stays unverified until it is set/)).toBeTruthy();
    await userEvent.type(
      d.getByLabelText('Authentication-Results name (optional)'),
      'MX.Google.com',
    );
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    const done = await screen.findByRole('dialog', { name: /Finish setting up/ });
    expect(api.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ config: { ...MAILBOX, authservId: 'mx.google.com' } }),
    );
    const made = channels.bindings.at(-1)!;
    await userEvent.click(within(done).getByRole('button', { name: 'Done' }));
    const row = await screen.findByRole('listitem', { name: made.label });
    await userEvent.click(within(row).getByRole('button', { name: `Settings of ${made.label}` }));
    const field = within(row).getByLabelText<HTMLInputElement>('Authentication-Results name');
    expect(field.value).toBe('mx.google.com');
    await userEvent.clear(field);
    await userEvent.type(field, 'mx.example.net');
    await userEvent.click(within(row).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.updateChannel).toHaveBeenCalledWith(made.id, {
        config: { authservId: 'mx.example.net' },
      }),
    );
  });

  it('in settings, turns the check off only after confirming, and shows the Hub’s refusal', async () => {
    const MAIL = bindingM7({ id: 'em1', kind: 'email', label: 'Email with Sam', config: MAILBOX });
    const { api, failNext } = await open({ channels: { bindings: [MAIL] } });
    const row = within(await screen.findByRole('listitem', { name: 'Email with Sam' }));
    await userEvent.click(row.getByRole('button', { name: 'Settings of Email with Sam' }));
    const check = row.getByLabelText<HTMLSelectElement>('Check senders');
    await userEvent.selectOptions(check, 'none');
    await userEvent.click(row.getByRole('button', { name: 'Keep checking senders' }));
    expect(check.value).toBe('');
    expect(row.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(
      true,
    );
    // The Hub refuses an unconfirmed change (for example from another client).
    failNext.updateChannel = CONFIRM_REQUIRED();
    await userEvent.selectOptions(check, 'none');
    await userEvent.click(row.getByRole('button', { name: 'Trust the From address' }));
    expect(row.getByText(/The sender check is off/)).toBeTruthy();
    await userEvent.click(row.getByRole('button', { name: 'Save changes' }));
    expect(await row.findByText(/The Hub needs your confirmation/)).toBeTruthy();
    await userEvent.click(row.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.updateChannel).toHaveBeenLastCalledWith('em1', {
        config: { senderCheck: 'none' },
        confirmSenderCheckNone: true,
      }),
    );
    // Turning it back on needs no confirmation.
    await waitFor(() => expect(check.value).toBe('none'));
    await userEvent.selectOptions(check, '');
    await userEvent.click(row.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.updateChannel).toHaveBeenLastCalledWith('em1', { config: { senderCheck: null } }),
    );
  });

  it('labels mail taken on its From address in the message log', () => {
    expect(messageReason({ reason: 'sender_unchecked' })).toBe(
      'Taken on its From address alone: the sender check is off for this mailbox, so the sender was not verified.',
    );
  });
});

describe('People: Telegram users', () => {
  it('maps a Telegram user id to a role', async () => {
    const { api } = await open();
    const form = within(screen.getByRole('form', { name: 'Add a person' }));
    await userEvent.selectOptions(form.getByLabelText('Where'), 'telegram');
    expect(form.getByText('Their Telegram user ID, a number (not their @name).')).toBeTruthy();
    await userEvent.type(form.getByLabelText('Their ID'), '99887766');
    await userEvent.type(form.getByLabelText('Name (optional)'), 'Sam');
    await userEvent.selectOptions(form.getByLabelText('Role'), 'owner');
    await userEvent.click(form.getByRole('button', { name: 'Add person' }));
    const people = await screen.findByRole('list', { name: 'People' });
    expect(within(people).getByText('Telegram')).toBeTruthy();
    expect(api.addChannelIdentity).toHaveBeenCalledWith({
      kind: 'telegram',
      externalId: '99887766',
      displayName: 'Sam',
      role: 'owner',
    });
  });
});
