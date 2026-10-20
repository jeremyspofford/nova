// secret-scan: fake-file (fixture names and addresses only)
// The channels area in the pseudo-locale (FR-016): Settings → Channels with its rows, settings,
// credentials, message log, OAuth panel, people, share asks and dialogs; Settings → Triggers with
// its rows, deliveries and dialogs; notification routing and quiet hours; a schedule's webhook
// secret. Channel names, ids, senders, file names and the Hub's own text are fixture data.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADD_CHANNEL_TEXT } from '../src/channels/AddChannelDialog.tsx';
import { CHANNELS_PAGE_TEXT, ChannelsPage } from '../src/channels/ChannelsPage.tsx';
import { KIND_TEXT, MAIL_OAUTH_TEXT } from '../src/channels/format.ts';
import { LOG_TEXT } from '../src/channels/MessageLog.tsx';
import {
  NotificationRoutingSection,
  ROUTING_TEXT,
} from '../src/channels/NotificationRoutingSection.tsx';
import { PEOPLE_TEXT } from '../src/channels/PeopleSection.tsx';
import { ASKS_TEXT } from '../src/channels/ShareAsks.tsx';
import { TRIGGER_DIALOG_TEXT } from '../src/channels/TriggerDialogs.tsx';
import { TRIGGERS_TEXT, TriggersPage } from '../src/channels/TriggersPage.tsx';
import { ScheduleWebhookSecret, WEBHOOK_SECRET_TEXT } from '../src/channels/WebhookSecret.tsx';
import { oauthRedirect } from '../src/settings/McpAuth.tsx';
import {
  agentChoice,
  bindingView,
  identityView,
  quietView,
  renderWithChannels,
  ruleView,
  shareAsk,
  subscriptionView,
  triggerEventView,
  triggerView,
} from './fakes-m6-channels.ts';
import { bindingM7, messageView, renderM7 } from './fakes-m7-misc.ts';
import { renderW11 } from './fakes-m8-appauth.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

beforeEach(() => {
  vi.spyOn(oauthRedirect, 'go').mockImplementation(() => undefined);
});
afterEach(() => {
  resetDom();
  resetTestLocale();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

/** A pattern matching text that starts with `text` (pseudo text is full of brackets). */
const starts = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const AGENT = agentChoice({ id: 'ag1', name: 'Research' });
const SLACK = bindingM7({
  id: 'b1',
  kind: 'slack',
  label: 'Slack #ops',
  externalRef: 'C0OPS',
  agentId: 'ag1',
  audience: 'shared',
  threadId: 't-ops',
  lastMessageAt: ago(5),
});
const TG = bindingM7({ id: 'tg1', kind: 'telegram', label: 'Telegram family', threadId: 't-tg' });
const MAIL = bindingM7({
  id: 'em1',
  kind: 'email',
  label: 'Email with Sam',
  status: 'disconnected',
  config: {
    address: 'agent@example.com',
    imapHost: 'imap.example.com',
    smtpHost: 'smtp.example.com',
    auth: 'oauth',
    oauthAuthUrl: 'https://login.mail.example.com/oauth2/authorize',
    oauthTokenUrl: 'https://login.mail.example.com/oauth2/token',
    oauthClientId: 'nova-client',
  },
});
const HOOK_CHANNEL = bindingM7({ id: 'wh1', kind: 'webhook', label: 'Support bot' });

const photo = {
  name: 'photo.jpg',
  size: 2048,
  contentType: 'image/jpeg',
  direction: 'in' as const,
  status: 'received' as const,
  attachmentId: 'att1',
};
const movie = {
  name: 'holiday.mov',
  size: null,
  contentType: 'video/quicktime',
  direction: 'in' as const,
  status: 'failed' as const,
  reason: 'too many files',
};
const MESSAGES = [
  messageView({
    id: 'm1',
    bindingId: 'tg1',
    sender: 'Kim',
    status: 'started',
    files: [photo, movie],
  }),
  messageView({
    id: 'm2',
    bindingId: 'tg1',
    direction: 'out',
    status: 'withheld',
    reason: 'denied',
    sender: null,
    conversation: null,
  }),
  messageView({
    id: 'm3',
    bindingId: 'tg1',
    sender: null,
    status: 'ignored',
    reason: 'unknown_sender',
  }),
];

/** Fixture strings that are data, not words of the UI. */
const DATA = [
  'Slack #ops',
  'C0OPS',
  'Research',
  'Telegram family',
  '-1001234567890',
  'Email with Sam',
  'sam@example.com',
  'Support bot',
  'C0X',
  'Kim',
  'photo.jpg',
  'holiday.mov',
  'Sam Lee',
  'U0SAM',
  'agent@example.com',
  'imap.example.com',
  'smtp.example.com',
  'nova-client',
  'xoxb-…',
  '123456789:AA…',
  'INBOX',
  'mx.google.com',
  'https://nova.example.com',
  'https://',
];

async function openChannels() {
  await activateTestLocale('en-XA');
  const r = await renderW11(<ChannelsPage />, {
    channels: {
      bindings: [SLACK, TG, MAIL, HOOK_CHANNEL],
      agents: [AGENT],
      identities: [
        identityView({ kind: 'slack', externalId: 'U0SAM', displayName: 'Sam Lee', role: 'owner' }),
      ],
    },
    misc: { messages: MESSAGES },
  });
  await screen.findByRole('heading', { name: CHANNELS_PAGE_TEXT.yourChannels });
  await screen.findByRole('listitem', { name: 'Slack #ops' });
  return r;
}

describe('Settings → Channels in a pseudo-locale', () => {
  it('shows the rows, settings, credentials, message log, OAuth panel and people localized', async () => {
    const { container } = await openChannels();
    expect(CHANNELS_PAGE_TEXT.title).toMatch(/^\[/);
    const S = CHANNELS_PAGE_TEXT;
    await userEvent.click(
      screen.getByRole('button', { name: S.settingsOf({ name: 'Slack #ops' }) }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: S.settingsOf({ name: 'Support bot' }) }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: S.settingsOf({ name: 'Email with Sam' }) }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: S.messagesOf({ name: 'Telegram family' }) }),
    );
    const log = await screen.findByRole('list', {
      name: LOG_TEXT.list({ name: 'Telegram family' }),
    });
    await within(log).findAllByRole('listitem');
    expect(
      screen.getByRole('group', { name: MAIL_OAUTH_TEXT.panelLabel({ label: 'Email with Sam' }) }),
    ).toBeTruthy();
    await screen.findByRole('list', { name: PEOPLE_TEXT.list });
    expectFullyLocalized(container, { data: DATA });
  });

  it('shows the Add channel dialog localized for every kind', async () => {
    await openChannels();
    const add = screen.getAllByRole<HTMLButtonElement>('button', {
      name: ADD_CHANNEL_TEXT.add,
    })[0]!;
    await waitFor(() => expect(add.disabled).toBe(false));
    await userEvent.click(add);
    const dialog = within(await screen.findByRole('dialog', { name: ADD_CHANNEL_TEXT.title }));
    expectFullyLocalized(dialog.getByRole('form'), { data: DATA });
    for (const kind of ['slack', 'telegram', 'webhook', 'email', 'teams', 'inapp'] as const) {
      const radio = dialog.queryByRole('radio', { name: KIND_TEXT[kind] });
      if (!radio) continue;
      await userEvent.click(radio);
      if (kind === 'email')
        await userEvent.click(dialog.getByRole('radio', { name: starts(MAIL_OAUTH_TEXT.oauth) }));
      expectFullyLocalized(screen.getByRole('dialog', { name: ADD_CHANNEL_TEXT.title }), {
        data: DATA,
      });
    }
  });

  it('shows the test and delete dialogs localized', async () => {
    await openChannels();
    const S = CHANNELS_PAGE_TEXT;
    await userEvent.click(
      screen.getByRole('button', { name: S.sendTestTo({ name: 'Slack #ops' }) }),
    );
    const test = await screen.findByRole('dialog', { name: S.test.title({ name: 'Slack #ops' }) });
    expectFullyLocalized(test, { data: DATA });
    await userEvent.click(within(test).getByRole('button', { name: S.cancel }));
    await userEvent.click(
      screen.getByRole('button', { name: S.deleteName({ name: 'Slack #ops' }) }),
    );
    const del = await screen.findByRole('dialog', { name: S.deleteTitle({ name: 'Slack #ops' }) });
    expectFullyLocalized(del, { data: DATA });
  });

  it('shows the share decisions localized', async () => {
    await activateTestLocale('en-XA');
    const question =
      'A reply in Slack #ops, a shared channel, uses private information (1 source). Share it there?';
    await renderWithChannels(<ChannelsPage />, {
      channels: { bindings: [bindingView({ id: 'b1', label: 'Slack #ops', threadId: 't-ops' })] },
      requests: [shareAsk('t-ops')],
    });
    const heading = await screen.findByRole('heading', { name: ASKS_TEXT.heading });
    const section = heading.closest('section')!;
    expect(within(section).getByRole('button', { name: ASKS_TEXT.share })).toBeTruthy();
    expectFullyLocalized(section, { data: [question, 'Slack #ops'] });
  });
});

describe('Settings → Triggers in a pseudo-locale', () => {
  const HOOK = triggerView({
    id: 'tr1',
    kind: 'webhook',
    title: 'Deploy hook',
    lastFiredAt: ago(120),
  });
  const MCP = triggerView({
    id: 'tr2',
    kind: 'mcp_event',
    title: 'New issues',
    action: 'wake',
    agentId: 'ag1',
    sourceRef: 'sub1',
  });
  const WATCH = triggerView({
    id: 'tr3',
    kind: 'connector_event',
    title: 'Ops watch',
    sourceRef: 'b1',
    config: { conversation: 'C0OPS', contains: 'deploy' },
    autonomy: 'ask_first',
  });
  const SUB = subscriptionView({
    id: 'sub1',
    triggerId: 'tr2',
    serverId: 'srv1',
    event: 'issue.created',
    lastDeliveryAt: ago(10),
  });
  const SOURCES = [
    {
      serverId: 'srv1',
      name: 'GitHub',
      events: [{ name: 'issue.created', description: 'A new issue was opened.' }],
    },
  ];
  const TDATA = [
    'Deploy hook',
    'New issues',
    'Ops watch',
    'Research',
    'GitHub',
    'issue.created',
    'A new issue was opened.',
    'Slack #ops',
    'C0OPS',
    'deploy',
    // The fixture triggers' instructions (the user's text).
    'Triage new issues',
    // The examples in the filter and event id fields: JSON and a JSON field name.
    '{"repo": "nova"}',
    'id',
  ];

  async function openTriggers() {
    await activateTestLocale('en-XA');
    const r = await renderWithChannels(<TriggersPage />, {
      channels: {
        triggers: [HOOK, MCP, WATCH],
        subscriptions: [SUB],
        sources: SOURCES,
        agents: [AGENT],
        bindings: [
          bindingView({ id: 'b1', kind: 'slack', label: 'Slack #ops', externalRef: 'C0OPS' }),
        ],
        triggerEvents: [
          triggerEventView({ triggerId: 'tr1', status: 'skipped', detail: 'rate_limited' }),
          triggerEventView({ triggerId: 'tr1', status: 'started', runId: 'run1', dedupeKey: 'e2' }),
        ],
      },
    });
    await screen.findByRole('listitem', { name: 'Deploy hook' });
    await screen.findByText(TRIGGERS_TEXT.wakes({ agent: 'Research' }));
    return r;
  }

  it('shows the triggers and a delivery log localized', async () => {
    const { container } = await openTriggers();
    await userEvent.click(
      screen.getByRole('button', { name: TRIGGERS_TEXT.deliveriesOf({ name: 'Deploy hook' }) }),
    );
    await screen.findByRole('list', { name: TRIGGERS_TEXT.deliveriesOf({ name: 'Deploy hook' }) });
    expectFullyLocalized(container, { data: TDATA });
  });

  it('shows the new, edit and confirmation dialogs localized', async () => {
    await openTriggers();
    const D = TRIGGER_DIALOG_TEXT;
    for (const [button, kind] of [
      [TRIGGERS_TEXT.webhook, 'webhook'],
      [TRIGGERS_TEXT.mcpEvent, 'mcp_event'],
      [TRIGGERS_TEXT.channelWatch, 'connector_event'],
    ] as const) {
      await userEvent.click(screen.getByRole('button', { name: button }));
      const dialog = await screen.findByRole('dialog', { name: D.newTitle[kind] });
      await userEvent.click(within(dialog).getByRole('radio', { name: starts(D.wake.label) }));
      expectFullyLocalized(dialog, { data: TDATA });
      await userEvent.click(within(dialog).getByRole('button', { name: D.cancel }));
    }
    await userEvent.click(
      screen.getByRole('button', { name: TRIGGERS_TEXT.editName({ name: 'Ops watch' }) }),
    );
    const edit = await screen.findByRole('dialog', { name: D.editTitle({ name: 'Ops watch' }) });
    expectFullyLocalized(edit, { data: TDATA });
    await userEvent.click(within(edit).getByRole('button', { name: D.cancel }));
    for (const [label, title] of [
      [
        TRIGGERS_TEXT.deleteName({ name: 'New issues' }),
        TRIGGERS_TEXT.deleteTitle({ name: 'New issues' }),
      ],
      [TRIGGERS_TEXT.unsubscribeName({ name: 'New issues' }), TRIGGERS_TEXT.unsubscribeTitle],
      [TRIGGERS_TEXT.newSecretFor({ name: 'Deploy hook' }), TRIGGERS_TEXT.rotateTitle],
    ]) {
      await userEvent.click(screen.getByRole('button', { name: label }));
      const dialog = await screen.findByRole('dialog', { name: title });
      expectFullyLocalized(dialog, { data: TDATA });
      await userEvent.click(within(dialog).getByRole('button', { name: TRIGGERS_TEXT.cancel }));
    }
  });
});

describe('routing, quiet hours and webhook secrets in a pseudo-locale', () => {
  it('shows notification routing, a test result and quiet hours localized', async () => {
    await activateTestLocale('en-XA');
    const { container } = await renderM7(<NotificationRoutingSection />, {
      channels: {
        bindings: [TG],
        rules: [ruleView('error', { isDefault: false, channels: ['tg1'] })],
        quietHours: quietView({ enabled: true, active: true, until: ago(-60) }),
      },
    });
    await screen.findByRole('heading', { name: ROUTING_TEXT.title });
    const buttons = await screen.findAllByRole('button', { name: /./ });
    const test = buttons.find((b) => b.textContent?.includes(ROUTING_TEXT.sendTest))!;
    await userEvent.click(test);
    await screen.findByText(starts(ROUTING_TEXT.testSent));
    expectFullyLocalized(container, { data: ['Telegram family', 'UTC'] });
  });

  it('shows a schedule’s webhook secret localized', async () => {
    await activateTestLocale('en-XA');
    const { container } = await renderM7(<ScheduleWebhookSecret scheduleId="s1" />, {
      misc: { schedules: { s1: { webhook: true } } },
    });
    await userEvent.click(screen.getByRole('button', { name: WEBHOOK_SECRET_TEXT.make }));
    expectFullyLocalized(container);
    await userEvent.click(
      within(screen.getByRole('group', { name: WEBHOOK_SECRET_TEXT.ask })).getByRole('button', {
        name: WEBHOOK_SECRET_TEXT.make,
      }),
    );
    await screen.findByRole('button', { name: WEBHOOK_SECRET_TEXT.another });
    expectFullyLocalized(container);
  });
});
