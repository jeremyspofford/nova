// secret-scan: fake-file (fixture tokens, passwords and key headers only)
// Settings → Channels (FR-088, FR-110, FR-100; docs/13 §4): bindings with kind, audience, agent,
// status and last message; adding one per kind with write-only credentials and the inbound address
// (a webhook's token and secret shown once); test, connect and disconnect, delete with a
// confirmation; settings and credentials; the people agents answer; the private-to-shared policy;
// the public address; and the owner's share decisions.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { ChannelsPage } from '../src/channels/ChannelsPage.tsx';
import { FakeEventSource } from './fakes.ts';
import {
  agentChoice,
  bindingView,
  identityView,
  renderWithChannels,
  shareAsk,
} from './fakes-m6-channels.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const AGENT = agentChoice({ id: 'ag1', name: 'Research' });
const SLACK = bindingView({
  id: 'b1',
  kind: 'slack',
  label: 'Slack #ops',
  externalRef: 'C0OPS',
  agentId: 'ag1',
  audience: 'shared',
  threadId: 't-ops',
  lastMessageAt: new Date(Date.now() - 5 * 60_000).toISOString(),
});
const DM = bindingView({
  id: 'b2',
  kind: 'slack',
  label: 'My Slack DM',
  externalRef: 'D0ME',
  agentId: 'ag1',
  audience: 'private',
  sharesCredentialsWith: 'b1',
  status: 'disconnected',
});

const row = (name: string) => screen.getByRole('listitem', { name });
const fail = (message: string, status = 500, details?: Record<string, unknown>) =>
  new ApiError(status, {
    code: status === 409 ? 'conflict' : status === 400 ? 'validation' : 'server_error',
    message,
    retryable: false,
    ...(details ? { details } : {}),
  });

/** Emit an event on every open stream (each only listens to its own names). */
function emitAll(name: string, payload: Record<string, unknown>) {
  for (const s of FakeEventSource.all.filter((x) => !x.closed)) s.emit(name, payload);
}

describe('the channel list (FR-088)', () => {
  it('shows kind, audience, agent, status and last message, and opens the thread', async () => {
    await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [SLACK, DM], agents: [AGENT] },
    });
    const ops = await screen.findByRole('listitem', { name: 'Slack #ops' });
    const t = within(ops);
    expect(t.getByText('Slack')).toBeTruthy();
    expect(t.getByText('Shared')).toBeTruthy();
    expect(t.getByText('Connected')).toBeTruthy();
    expect(await t.findByText('Research')).toBeTruthy();
    expect(t.getByText('Last message 5 min ago')).toBeTruthy();
    const dm = within(row('My Slack DM'));
    expect(dm.getByText('Private')).toBeTruthy();
    expect(dm.getByText('Disconnected')).toBeTruthy();
    expect(dm.getByText('No messages yet')).toBeTruthy();
    // No thread until the first message.
    expect(dm.queryByRole('button', { name: /Open the thread/ })).toBeNull();
    await userEvent.click(t.getByRole('button', { name: 'Open the thread of Slack #ops' }));
    expect(window.location.pathname).toBe('/chat/t-ops');
  });

  it('shows the empty state', async () => {
    await renderWithChannels(<ChannelsPage />);
    expect(await screen.findByRole('heading', { name: 'No channels yet' })).toBeTruthy();
  });

  it('shows a load error with retry', async () => {
    const { api } = await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [SLACK] },
      fail: { listChannels: fail('Hub is restarting') },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Hub is restarting');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add channel' }).disabled).toBe(
      true,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('listitem', { name: 'Slack #ops' })).toBeTruthy();
    expect(api.listChannels).toHaveBeenCalledTimes(2);
  });

  it('refetches when the event stream reconnects', async () => {
    const { api } = await renderWithChannels(<ChannelsPage />, { channels: { bindings: [SLACK] } });
    await screen.findByRole('listitem', { name: 'Slack #ops' });
    // Every open stream opens (the first load), then opens again (a reconnect).
    for (let i = 0; i < 2; i++)
      for (const s of FakeEventSource.all.filter((x) => !x.closed)) act(() => s.open());
    await waitFor(() => expect(api.listChannels.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('says when the agents cannot be listed', async () => {
    await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [SLACK], agentsAvailable: false },
    });
    expect(
      await within(await screen.findByRole('listitem', { name: 'Slack #ops' })).findByText(
        'An agent',
      ),
    ).toBeTruthy();
  });

  it('disconnects at once and connects again, reporting a credential problem', async () => {
    const { state, channels } = await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [SLACK] },
    });
    const r = within(await screen.findByRole('listitem', { name: 'Slack #ops' }));
    await userEvent.click(r.getByRole('button', { name: 'Disconnect Slack #ops' }));
    expect(await r.findByText('Disconnected')).toBeTruthy();
    expect(state.enabled.b1).toBe(false);
    expect(
      r.getByRole<HTMLButtonElement>('button', { name: 'Send a test to Slack #ops' }).disabled,
    ).toBe(true);
    channels.api.connectChannel.mockResolvedValueOnce({
      ...SLACK,
      statusDetail: 'Slack said: invalid_auth',
    });
    await userEvent.click(r.getByRole('button', { name: 'Connect Slack #ops' }));
    expect(await screen.findByText('Slack #ops is on, but: Slack said: invalid_auth')).toBeTruthy();
    expect(r.getByText('Slack said: invalid_auth')).toBeTruthy();
  });

  it('sends a test only after confirming, and reports a refusal', async () => {
    const { state, channels } = await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [SLACK] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Send a test to Slack #ops' }));
    const dialog = screen.getByRole('dialog', { name: 'Send a test to Slack #ops?' });
    expect(within(dialog).getByText('Everyone in this conversation will see it.')).toBeTruthy();
    channels.failNext.testChannel = fail('the channel is disconnected', 409);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send test' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'the channel is disconnected',
    );
    const text = within(dialog).getByLabelText('Message');
    await userEvent.clear(text);
    await userEvent.type(text, 'Hello from Nova');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send test' }));
    expect(await screen.findByText('Test sent to Slack #ops.')).toBeTruthy();
    expect(state.sent).toEqual([{ bindingId: 'b1', text: 'Hello from Nova' }]);
  });

  it('deletes a channel only after confirming', async () => {
    const { state } = await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [SLACK] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Slack #ops' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Slack #ops?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(state.bindings).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Delete Slack #ops' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete Slack #ops?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'No channels yet' })).toBeTruthy();
    expect(state.bindings).toHaveLength(0);
    // Its secrets went with it.
    expect(Object.keys(state.secrets)).toEqual([]);
  });

  it('refetches when a channel changes elsewhere', async () => {
    const { state } = await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [SLACK] },
    });
    await screen.findByRole('listitem', { name: 'Slack #ops' });
    state.bindings = [
      ...state.bindings,
      bindingView({ id: 'b9', kind: 'teams', label: 'Teams sales' }),
    ];
    emitAll('channel.binding.changed', { bindingId: 'b9', kind: 'teams', change: 'created' });
    expect(await screen.findByRole('listitem', { name: 'Teams sales' })).toBeTruthy();
  });
});

describe('adding a channel (FR-088)', () => {
  it('adds a Slack channel; secrets are sent, never shown, and the inbound address is given', async () => {
    const { state, api } = await renderWithChannels(<ChannelsPage />, {
      channels: { agents: [AGENT] },
    });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add channel' }))[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Add a channel' });
    const d = within(dialog);
    // Email is listed but not available, with the Hub's reason.
    const email = d.getByRole<HTMLInputElement>('radio', { name: 'Email' });
    expect(email.disabled).toBe(true);
    expect(
      d.getByText(/^Email channels are not available yet: they need a connected mailbox/),
    ).toBeTruthy();
    await userEvent.click(d.getByRole('radio', { name: 'Slack' }));
    await userEvent.selectOptions(d.getByLabelText('Agent'), 'ag1');
    // Missing fields are caught by the Hub's schema before anything is sent.
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    expect(api.createChannel).not.toHaveBeenCalled();
    expect(d.getAllByRole('alert').length).toBeGreaterThan(0);
    await userEvent.type(d.getByLabelText('Slack conversation ID'), 'C0OPS');
    await userEvent.type(d.getByLabelText('Bot token'), 'xoxb-secret-token-1');
    await userEvent.type(d.getByLabelText('Signing secret'), 'signing-secret-1');
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    expect(api.createChannel).toHaveBeenCalledWith({
      kind: 'slack',
      agentId: 'ag1',
      externalRef: 'C0OPS',
      audience: 'shared',
      credentials: { botToken: 'xoxb-secret-token-1', signingSecret: 'signing-secret-1' },
    });
    const done = await screen.findByRole('dialog', { name: 'Finish setting up Slack C0OPS' });
    const id = state.bindings[0]!.id;
    expect(
      within(done).getByText(`http://localhost:3000/api/v1/channels/${id}/inbound`),
    ).toBeTruthy();
    expect(within(done).getByText('Connected')).toBeTruthy();
    expect(document.body.textContent).not.toContain('xoxb-secret-token-1');
    expect(state.secrets[`${id}/botToken`]).toBe('xoxb-secret-token-1');
    await userEvent.click(within(done).getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('listitem', { name: 'Slack C0OPS' })).toBeTruthy();
  });

  it('reuses another Slack app and shows a conflict on the conversation field', async () => {
    const { api } = await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [SLACK] },
      settings: { 'channels.publicUrl': 'https://nova.example.com' },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add channel' }));
    const d = within(screen.getByRole('dialog', { name: 'Add a channel' }));
    await userEvent.click(d.getByRole('radio', { name: 'Slack' }));
    await userEvent.selectOptions(d.getByLabelText('Credentials'), 'b1');
    expect(d.queryByLabelText('Bot token')).toBeNull();
    await userEvent.type(d.getByLabelText('Slack conversation ID'), 'C0OPS');
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    expect((await d.findByRole('alert')).textContent).toBe('this conversation is already bound');
    expect(api.createChannel).toHaveBeenLastCalledWith(
      expect.objectContaining({ shareCredentialsWith: 'b1', externalRef: 'C0OPS' }),
    );
    const ref = d.getByLabelText('Slack conversation ID');
    await userEvent.clear(ref);
    await userEvent.type(ref, 'D0ME');
    await userEvent.click(d.getByRole('radio', { name: 'Private' }));
    await userEvent.click(d.getByRole('switch', { name: "Use the agent's main thread" }));
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    const done = await screen.findByRole('dialog', { name: /Finish setting up/ });
    expect(api.createChannel).toHaveBeenLastCalledWith({
      kind: 'slack',
      externalRef: 'D0ME',
      audience: 'private',
      sharePrimaryThread: true,
      shareCredentialsWith: 'b1',
    });
    expect(
      within(done).getByText(/^https:\/\/nova\.example\.com\/api\/v1\/channels\//),
    ).toBeTruthy();
  });

  it('adds a webhook channel with a token and secret made here and shown once', async () => {
    const { state, api } = await renderWithChannels(<ChannelsPage />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add channel' }))[0]!);
    const d = within(screen.getByRole('dialog', { name: 'Add a channel' }));
    await userEvent.click(d.getByRole('radio', { name: 'Webhook' }));
    await userEvent.type(d.getByLabelText('Conversation name'), 'support-bot');
    await userEvent.type(d.getByLabelText('Reply URL (optional)'), 'http://insecure.example');
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    // The Hub refuses a plain-http reply URL; the error lands on the field.
    expect((await d.findByRole('alert')).textContent).toBe('the URL must use https');
    const url = d.getByLabelText('Reply URL (optional)');
    await userEvent.clear(url);
    await userEvent.type(url, 'https://hooks.example.com/nova');
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    const done = within(await screen.findByRole('dialog', { name: /Finish setting up/ }));
    const body = api.createChannel.mock.lastCall![0] as unknown as {
      credentials: { token: string; secret: string };
    };
    expect(body.credentials.token.length).toBeGreaterThanOrEqual(24);
    expect(body.credentials.secret.length).toBeGreaterThanOrEqual(32);
    expect(done.getByText(body.credentials.token)).toBeTruthy();
    expect(done.getByText(body.credentials.secret)).toBeTruthy();
    expect(done.getByText(/shown only once/)).toBeTruthy();
    const id = state.bindings[0]!.id;
    expect(state.secrets[`${id}/secret`]).toBe(body.credentials.secret);
    await userEvent.click(done.getByRole('button', { name: 'Done' }));
    // Never shown again.
    expect(document.body.textContent).not.toContain(body.credentials.secret);
    await userEvent.click(screen.getByRole('button', { name: /Settings of / }));
    expect(screen.getAllByText('Set')).toHaveLength(2);
    expect(document.body.textContent).not.toContain(body.credentials.secret);
  });

  it('adds the in-app channel, which is always private', async () => {
    const { api } = await renderWithChannels(<ChannelsPage />, { channels: { agents: [AGENT] } });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add channel' }))[0]!);
    const d = within(screen.getByRole('dialog', { name: 'Add a channel' }));
    await userEvent.click(d.getByRole('radio', { name: 'In-app' }));
    expect(d.queryByRole('radio', { name: 'Shared' })).toBeNull();
    await userEvent.selectOptions(d.getByLabelText('Agent'), 'ag1');
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    expect(api.createChannel).toHaveBeenCalledWith({ kind: 'inapp', agentId: 'ag1' });
    expect(await screen.findByText('In-app added.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('adds a Teams channel and needs the app id', async () => {
    const { api } = await renderWithChannels(<ChannelsPage />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add channel' }))[0]!);
    const d = within(screen.getByRole('dialog', { name: 'Add a channel' }));
    await userEvent.click(d.getByRole('radio', { name: 'Microsoft Teams' }));
    await userEvent.type(d.getByLabelText('Teams conversation ID'), '19:abc@thread.tacv2');
    await userEvent.type(d.getByLabelText('App password'), 'app-password-1');
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    expect(api.createChannel).not.toHaveBeenCalled();
    await userEvent.type(d.getByLabelText('App ID'), 'app-123');
    await userEvent.click(d.getByRole('button', { name: 'Add channel' }));
    expect(api.createChannel).toHaveBeenCalledWith({
      kind: 'teams',
      externalRef: '19:abc@thread.tacv2',
      audience: 'shared',
      credentials: { appPassword: 'app-password-1' },
      config: { appId: 'app-123' },
    });
    expect(await screen.findByText(/messaging endpoint/)).toBeTruthy();
  });
});

describe('a channel’s settings', () => {
  it('saves only what changed and refuses a shared in-app channel', async () => {
    const { api, state } = await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [SLACK] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Settings of Slack #ops' }));
    const form = screen.getByRole('form', { name: 'Slack #ops settings' });
    const f = within(form);
    expect(f.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(true);
    await userEvent.click(f.getByRole('switch', { name: 'Answer people Nova does not know' }));
    const perMinute = f.getByLabelText('Per minute');
    await userEvent.clear(perMinute);
    await userEvent.type(perMinute, '5');
    await userEvent.type(f.getByLabelText('Bot user ID'), 'U0BOT');
    await userEvent.click(f.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.updateChannel).toHaveBeenCalledWith('b1', {
        allowUnknown: true,
        rateLimit: { perMinute: 5, perHour: 120 },
        config: { botUserId: 'U0BOT' },
      }),
    );
    expect(state.bindings[0]!.allowUnknown).toBe(true);
    expect(await screen.findByText('Slack #ops saved.')).toBeTruthy();
    // An out-of-range limit is caught before sending.
    await userEvent.clear(perMinute);
    await userEvent.type(perMinute, '0');
    await userEvent.click(f.getByRole('button', { name: 'Save changes' }));
    expect(f.getByRole('alert').textContent).toMatch(/1/);
    expect(api.updateChannel).toHaveBeenCalledTimes(1);
  });

  it('keeps unsaved edits when the channel list refreshes', async () => {
    const { api } = await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [SLACK] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Settings of Slack #ops' }));
    const f = within(screen.getByRole('form', { name: 'Slack #ops settings' }));
    await userEvent.type(f.getByLabelText('Bot user ID'), 'U0BOT');
    const lists = api.listChannels.mock.calls.length;
    emitAll('channel.binding.changed', { bindingId: 'other' });
    await waitFor(() => expect(api.listChannels.mock.calls.length).toBeGreaterThan(lists));
    expect(f.getByLabelText<HTMLInputElement>('Bot user ID').value).toBe('U0BOT');
    expect(f.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(false);
  });

  it('replaces a credential without ever showing it, and shows not-set ones', async () => {
    const { api, state } = await renderWithChannels(<ChannelsPage />, {
      channels: {
        bindings: [
          bindingView({
            ...SLACK,
            status: 'not_configured',
            credentials: [
              { name: 'botToken', set: true },
              { name: 'signingSecret', set: false },
            ],
          }),
        ],
      },
    });
    const r = within(await screen.findByRole('listitem', { name: 'Slack #ops' }));
    expect(r.getByText('Needs setup')).toBeTruthy();
    await userEvent.click(r.getByRole('button', { name: 'Settings of Slack #ops' }));
    const creds = within(screen.getByRole('list', { name: 'Credentials' }));
    expect(creds.getByText('Not set')).toBeTruthy();
    expect(document.body.textContent).not.toContain('stored-secret-value');
    await userEvent.click(creds.getByRole('button', { name: 'Replace signing secret' }));
    const input = creds.getByLabelText('New signing secret');
    expect(input.getAttribute('type')).toBe('password');
    await userEvent.type(input, 'short');
    await userEvent.click(creds.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter at least 8 characters.')).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, 'new-signing-secret');
    await userEvent.click(creds.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateChannel).toHaveBeenCalledWith('b1', {
        credentials: { signingSecret: 'new-signing-secret' },
      }),
    );
    expect(await r.findByText('Connected')).toBeTruthy();
    expect(state.secrets['b1/signingSecret']).toBe('new-signing-secret');
    expect(document.body.textContent).not.toContain('new-signing-secret');
  });

  it('makes a new webhook token and secret only after confirming', async () => {
    const hook = bindingView({
      id: 'w1',
      kind: 'webhook',
      label: 'Support bot',
      externalRef: 'support',
    });
    const { state } = await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [hook] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Settings of Support bot' }));
    expect(
      screen.getByText(/http:\/\/localhost:3000\/api\/v1\/channels\/w1\/inbound/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'New token and secret' }));
    const dialog = screen.getByRole('dialog', { name: 'Make a new token and secret?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make new ones' }));
    const once = within(await screen.findByRole('region', { name: 'Shown once' }));
    expect(once.getByText(state.secrets['w1/token']!)).toBeTruthy();
    expect(once.getByText(state.secrets['w1/secret']!)).toBeTruthy();
  });

  it('keeps the in-app channel private', async () => {
    const inapp = bindingView({ id: 'i1', kind: 'inapp', label: 'In-app', threadId: 't-main' });
    await renderWithChannels(<ChannelsPage />, { channels: { bindings: [inapp] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Settings of In-app' }));
    expect(screen.getByText('The in-app channel is always private.')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Shared' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send a test/ })).toBeNull();
  });
});

describe('people, policy and the public address', () => {
  it('adds and removes people with roles', async () => {
    const { api, state } = await renderWithChannels(<ChannelsPage />, {
      channels: {
        identities: [
          identityView({
            id: 'p1',
            kind: 'slack',
            externalId: 'U0ME',
            role: 'owner',
            displayName: 'Sam',
          }),
        ],
      },
    });
    const people = within(await screen.findByRole('list', { name: 'People' }));
    expect(people.getByText('Sam')).toBeTruthy();
    expect(people.getByText('Owner')).toBeTruthy();
    const form = within(screen.getByRole('form', { name: 'Add a person' }));
    await userEvent.click(form.getByRole('button', { name: 'Add person' }));
    expect(api.addChannelIdentity).not.toHaveBeenCalled();
    await userEvent.type(form.getByLabelText('Their ID'), 'U0ALEX');
    await userEvent.type(form.getByLabelText('Name (optional)'), 'Alex');
    await userEvent.click(form.getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText('Alex added as member.')).toBeTruthy();
    expect(state.identities).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Sam' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Remove Sam?' })).getByRole('button', {
        name: 'Remove',
      }),
    );
    await waitFor(() => expect(state.identities.map((i) => i.externalId)).toEqual(['U0ALEX']));
  });

  it('sets the private-to-shared policy, and shows a managed one as locked', async () => {
    const { hub } = await renderWithChannels(<ChannelsPage />);
    const ask = await screen.findByRole<HTMLInputElement>('radio', { name: 'Ask me' });
    expect(ask.checked).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: 'Never share' }));
    await waitFor(() => expect(hub.state.settings['channels.privateToShared']).toBe('deny'));
    resetDom();
    await renderWithChannels(<ChannelsPage />, {
      managed: { 'channels.privateToShared': 'allow' },
    });
    const allow = await screen.findByRole<HTMLInputElement>('radio', { name: 'Allow' });
    expect(allow.checked).toBe(true);
    expect(allow.disabled).toBe(true);
  });

  it('saves, checks and clears the public address', async () => {
    const { hub } = await renderWithChannels(<ChannelsPage />);
    const form = within(await screen.findByRole('form', { name: 'Public address' }));
    const input = form.getByLabelText('Public address');
    await userEvent.type(input, 'nova.example.com');
    await userEvent.click(form.getByRole('button', { name: 'Save' }));
    expect(form.getByRole('alert').textContent).toMatch(/full address/);
    await userEvent.clear(input);
    await userEvent.type(input, 'https://nova.example.com/');
    await userEvent.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(hub.state.settings['channels.publicUrl']).toBe('https://nova.example.com'),
    );
    await userEvent.click(await form.findByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(hub.state.settings['channels.publicUrl']).toBeNull());
  });
});

describe('share decisions (docs/13 §4, FR-088)', () => {
  it('lists a pending share ask for a shared channel and answers it', async () => {
    const ask = shareAsk('t-ops', { id: 'rq1' });
    const other = shareAsk('t-elsewhere', { id: 'rq2' });
    const { hub } = await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [SLACK] },
      requests: [ask, other],
    });
    const card = within(await screen.findByRole('article', { name: 'Share a private detail?' }));
    expect(card.getByText(/uses private information \(1 source\)/)).toBeTruthy();
    expect(card.getByText(/^Slack #ops ·/)).toBeTruthy();
    // Only the account's channel threads are listed here.
    expect(screen.getAllByRole('article')).toHaveLength(1);
    await userEvent.click(card.getByRole('button', { name: 'Do not share' }));
    await waitFor(() =>
      expect(hub.state.m5work.requests.find((r) => r.id === 'rq1')?.resolution?.result).toEqual({
        choice: 'Do not share',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
  });

  it('says when another device answered first', async () => {
    const { hub } = await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [SLACK] },
      requests: [shareAsk('t-ops', { id: 'rq1' })],
    });
    const card = within(await screen.findByRole('article', { name: 'Share a private detail?' }));
    hub.state.m5work.requests = hub.state.m5work.requests.map((r) => ({
      ...r,
      status: 'resolved' as const,
      resolution: { by: 'user', at: '2026-10-01T12:01:00.000Z', result: { choice: 'Share' } },
    }));
    await userEvent.click(card.getByRole('button', { name: 'Share' }));
    expect(await screen.findByText('This was already answered on another device.')).toBeTruthy();
  });
});
