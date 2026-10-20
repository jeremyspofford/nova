// The team area in the pseudo-locale (FR-016): every word of Team (/team: shared chats, team
// agents, an agent's page and provisioning), a shared chat and the share dialog, Settings →
// Members (people, invitations, removed members, sign-in providers), Settings → Account
// (identities, the public card), plugins per agent, the owner-only notice and the area's refusal
// words comes from messages. Fixture names, titles and Hub text are data; message bodies are the
// people's own words.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { pseudoLocalize } from '@nova/i18n';
import { ApiError } from '../src/api.ts';
import { AccountPage } from '../src/team/AccountPage.tsx';
import { AgentPluginsSection } from '../src/team/AgentPlugins.tsx';
import { MembersPage } from '../src/team/MembersPage.tsx';
import { ShareDialog } from '../src/team/ShareDialog.tsx';
import { SharedThreadPage } from '../src/team/SharedThreadPage.tsx';
import { TeamAgentPage } from '../src/team/TeamAgentPage.tsx';
import { NewTeamAgent, TeamAgentsList } from '../src/team/TeamAgentsList.tsx';
import { TeamSurface } from '../src/team/TeamSurface.tsx';
import { LoadError } from '../src/team/parts.tsx';
import { MemberGate } from '../src/team/role.tsx';
import {
  MEMBER_MODE_TEXT,
  OWNER_ONLY_TEXT,
  REMOVED_TEXT,
  TEAM_SECTION_INFO,
  TEAM_TEXT,
  invitationChip,
  oidcErrorText,
  providerChip,
  removedErrorMessage,
  taskChip,
  teamAgentChip,
  teamErrorMessage,
  untilText,
} from '../src/team/format.ts';
import { createHub, thread } from './fakes.ts';
import { plugin } from './fakes-m4-settings.ts';
import { removedMember, renderW11 } from './fakes-m8-appauth.ts';
import {
  MEMBER_ID,
  OWNER_ID,
  approval,
  auditEntry,
  identity,
  invitation,
  oidcProvider,
  person,
  renderWithTeam,
  sharedThread,
  teamAgent,
  teamTask,
} from './fakes-m7-team.ts';
import {
  activateTestLocale,
  expectFullyLocalized,
  resetTestLocale,
  unlocalizedResidue,
} from './i18n.ts';
import { clearViewport, resetDom, setViewport } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  clearViewport();
  window.history.replaceState(null, '', '/');
});

/** A message without placeholders as `en-XA` shows it (to find an element by its words). */
const xa = (source: string) => pseudoLocalize(source, 'en-XA');

/** The fixture people (Sam is the owner, Alex a member) and their usernames. */
const PEOPLE = ['Sam', 'Alex', 'Kim', 'sam'];

/** Fails on any word in `text` that is not pseudo-localized. */
function expectLocalizedText(text: string, data: readonly string[] = []) {
  expect(unlocalizedResidue(text, data), text).not.toMatch(/[A-Za-z]/);
}

const desk = () =>
  teamAgent({
    agentId: 'ta-1',
    name: 'Support desk',
    credentials: [
      {
        id: 'cred-1',
        kind: 'provider',
        label: 'OpenAI for support',
        refId: 'pa-9',
        secretRef: 'secret://providers/pa-9',
        createdAt: '2026-10-01T12:00:00.000Z',
      },
    ],
  });
const AGENT_DATA = [
  'Support desk',
  'OpenAI for support',
  'Answer the open support mail',
  'Answered 3 messages.',
  'Send an email to billing@example.com',
  'Sending mail leaves the Hub',
  'mail.send',
  // Technical examples in hints and checks (host names, a header, a model id).
  '*.example.com',
  'api.example.com',
  'X-Api-Key',
  'gpt-5',
  ...PEOPLE,
];

describe('Team (/team) in en-XA', () => {
  it('shows the tabs, the members link and the shared chats on desktop', async () => {
    setViewport(1300);
    await activateTestLocale('en-XA');
    await renderWithTeam(<TeamSurface section={null} />, {
      team: {
        threads: { 'st-1': sharedThread({ thread: thread({ id: 'st-1', title: 'Trip' }) }) },
      },
    });
    await screen.findByRole('link', { name: 'Trip' });
    expect(screen.getByRole('tab', { name: TEAM_SECTION_INFO.shared.label })).toBeTruthy();
    expect(screen.getByRole('link', { name: TEAM_TEXT.membersLink })).toBeTruthy();
    expectFullyLocalized(document.body, { data: ['Trip', ...PEOPLE] });
  });

  it('shows the section menu and a section page on a phone', async () => {
    setViewport(400);
    await activateTestLocale('en-XA');
    const r = await renderWithTeam(<TeamSurface section={null} />);
    expect(screen.getByRole('navigation', { name: xa('Team sections') })).toBeTruthy();
    expectFullyLocalized(document.body);
    r.unmount();
    await renderWithTeam(<TeamSurface section="agents" />, {
      team: {
        agents: [desk()],
        tasks: [teamTask({ agentId: 'ta-1' })],
      },
    });
    await screen.findByRole('link', { name: 'Support desk' });
    await screen.findByRole('link', { name: 'Answer the open support mail' });
    expectFullyLocalized(document.body, { data: AGENT_DATA });
  });

  it('shows a shared chat empty list with its way to Chat', async () => {
    await activateTestLocale('en-XA');
    await renderWithTeam(<TeamSurface section="shared" />, { as: 'member' });
    await screen.findByRole('link', { name: xa('Open Chat') });
    expectFullyLocalized(document.body, { data: PEOPLE });
  });
});

describe('team agents in en-XA', () => {
  it('lists agents and recent tasks for the owner and for a member', async () => {
    await activateTestLocale('en-XA');
    const team = {
      agents: [desk(), teamAgent({ agentId: 'ta-2', name: 'Calendar keeper', status: 'paused' })],
      tasks: [
        teamTask({ agentId: 'ta-1', requestedBy: MEMBER_ID }),
        teamTask({ id: 'task-x', agentId: 'ta-gone', status: 'weird_status' as never }),
      ],
    };
    const r = await renderWithTeam(<TeamAgentsList />, { team });
    await screen.findByRole('link', { name: 'Calendar keeper' });
    await screen.findAllByRole('link', { name: 'Answer the open support mail' });
    // An unknown status shows the Hub's raw word (data); everything else is localized.
    expectFullyLocalized(document.body, {
      data: [...AGENT_DATA, 'Calendar keeper', 'weird status'],
    });
    r.unmount();
    await renderWithTeam(<TeamAgentsList />, { as: 'member' });
    await screen.findByText(xa('The owner of this Hub has not set one up.'));
    expectFullyLocalized(document.body, { data: PEOPLE });
  });

  it('provisions an agent: the form, its responsibilities and its checks', async () => {
    await activateTestLocale('en-XA');
    await renderWithTeam(<NewTeamAgent />);
    await userEvent.click(screen.getByRole('button', { name: xa('Add a responsibility') }));
    await userEvent.click(screen.getByRole('button', { name: xa('Provision') }));
    await screen.findByText(xa('Give the agent a name.'));
    expectFullyLocalized(document.body, { data: AGENT_DATA });
    resetDom();
    await renderWithTeam(<NewTeamAgent />, { as: 'member', provider: true });
    await screen.findByRole('note');
    expectFullyLocalized(document.body);
  });

  const agentTeam = () => ({
    agents: [desk()],
    tasks: [
      teamTask({ id: 'task-1', agentId: 'ta-1', status: 'running', result: null, endedAt: null }),
      teamTask({ id: 'task-2', agentId: 'ta-1', requestedBy: 'acc-gone' }),
      teamTask({
        id: 'task-3',
        agentId: 'ta-1',
        status: 'failed',
        result: null,
        error: 'provider timed out',
      }),
    ],
    approvals: { 'ta-1': [approval({ id: 'ap-1' })] },
    audit: { 'ta-1': [auditEntry({ id: 'au-1' }), auditEntry({ id: 'au-2', resource: null })] },
  });

  it('shows an agent’s tasks, gives it a task and asks before removing it', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/team/agents/ta-1?tab=tasks');
    await renderWithTeam(<TeamAgentPage agentId="ta-1" />, { team: agentTeam() });
    const tasks = await screen.findByRole('list', { name: xa('Tasks') });
    await within(tasks).findAllByText('Answer the open support mail');
    const data = [...AGENT_DATA, 'provider timed out'];
    expectFullyLocalized(document.body, { data });
    await userEvent.type(document.querySelector('textarea')!, 'Sort the inbox');
    await userEvent.click(screen.getByRole('button', { name: xa('Give the task') }));
    await waitFor(() => expect(document.querySelector('.team-notice')).toBeTruthy());
    expectFullyLocalized(document.body, { data: [...data, 'Sort the inbox'] });
    await userEvent.click(screen.getByRole('button', { name: /Support desk/ }));
    const dialog = screen.getByRole('dialog');
    expectFullyLocalized(dialog, { data });
  });

  it('shows an agent’s approvals and audit', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/team/agents/ta-1?tab=approvals');
    const r = await renderWithTeam(<TeamAgentPage agentId="ta-1" />, { team: agentTeam() });
    await screen.findByRole('listitem', { name: 'Send an email to billing@example.com' });
    expectFullyLocalized(document.body, { data: AGENT_DATA });
    r.unmount();
    window.history.replaceState(null, '', '/team/agents/ta-1?tab=audit');
    await renderWithTeam(<TeamAgentPage agentId="ta-1" />, { team: agentTeam() });
    await screen.findByRole('table');
    expectFullyLocalized(document.body, { data: AGENT_DATA });
  });

  it('shows an agent’s credentials, the new-credential form and the removal question', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/team/agents/ta-1?tab=credentials');
    await renderWithTeam(<TeamAgentPage agentId="ta-1" />, { team: agentTeam() });
    await screen.findByRole('list', { name: xa('Credentials') });
    await userEvent.click(screen.getByRole('button', { name: xa('Add a credential') }));
    const form = screen.getByRole('form', { name: xa('New credential') });
    await userEvent.click(within(form).getByRole('button', { name: xa('Save credential') }));
    expectFullyLocalized(document.body, { data: AGENT_DATA });
    await userEvent.click(within(form).getByRole('radio', { name: xa('Website credential') }));
    await userEvent.selectOptions(within(form).getByRole('combobox'), 'header');
    await userEvent.click(within(form).getByRole('button', { name: xa('Save credential') }));
    await within(form).findByText(xa('Enter the secret value.'));
    expectFullyLocalized(document.body, { data: AGENT_DATA });
    await userEvent.click(screen.getByRole('button', { name: /OpenAI for support/ }));
    expectFullyLocalized(screen.getByRole('dialog'), { data: AGENT_DATA });
  });

  it('shows the plugins an agent may use', async () => {
    await activateTestLocale('en-XA');
    const hub = createHub();
    hub.state.m4.plugins = [
      plugin({ id: 'pl-mail', name: 'Mail tools', version: '1.2.0' }),
      plugin({ id: 'pl-cal', name: 'Calendar', version: '0.3.1', enabled: false }),
    ];
    const r = await renderWithTeam(<AgentPluginsSection agentId="ag-1" />, { hub });
    await userEvent.click(
      await screen.findByRole('radio', { name: xa('Only the plugins chosen here') }),
    );
    await screen.findByText(xa('With none chosen, it uses no plugin tools at all.'));
    expectFullyLocalized(document.body, { data: ['Mail tools', 'Calendar'] });
    r.unmount();
    await renderWithTeam(<AgentPluginsSection agentId="ag-1" />);
    await userEvent.click(
      await screen.findByRole('radio', { name: xa('Only the plugins chosen here') }),
    );
    await screen.findByText(xa('No plugins installed'));
    expectFullyLocalized(document.body);
  });
});

describe('shared chats in en-XA', () => {
  const seeded = () => ({
    threads: {
      'st-9': sharedThread({ thread: thread({ id: 'st-9', title: 'Trip planning' }) }),
    },
  });
  /** The people's own words in the conversation. */
  const BODIES = ['.team-msg-body'];

  it('shows a shared chat to its owner, with the take-out question and the share dialog', async () => {
    await activateTestLocale('en-XA');
    await renderWithTeam(<SharedThreadPage threadId="st-9" />, { team: seeded() });
    await screen.findByRole('heading', { name: 'Trip planning', level: 1 });
    const messages = screen.getByRole('list', { name: xa('Messages') });
    await waitFor(() => expect(within(messages).getAllByRole('listitem')).toHaveLength(2));
    const data = ['Trip planning', ...PEOPLE];
    expectFullyLocalized(document.body, { data, skip: BODIES });
    await userEvent.click(document.querySelector<HTMLButtonElement>('.team-chip-x')!);
    expectFullyLocalized(screen.getByRole('dialog'), { data });
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: xa('Cancel') }),
    );
    await userEvent.click(screen.getByRole('button', { name: xa('Add people') }));
    const share = await screen.findByRole('dialog', { name: xa('Share this chat') });
    await waitFor(() => expect(share.textContent).toContain(xa('In this chat')));
    expectFullyLocalized(share, { data });
  });

  it('shows a shared chat to a participant, with the leave question', async () => {
    await activateTestLocale('en-XA');
    await renderWithTeam(<SharedThreadPage threadId="st-9" />, { as: 'member', team: seeded() });
    await screen.findByRole('heading', { name: 'Trip planning', level: 1 });
    const messages = screen.getByRole('list', { name: xa('Messages') });
    await waitFor(() => expect(messages.textContent).toContain(xa('Nova, asked by you')));
    const data = ['Trip planning', ...PEOPLE];
    expectFullyLocalized(document.body, { data, skip: BODIES });
    await userEvent.click(screen.getByRole('button', { name: xa('Leave this chat') }));
    expectFullyLocalized(screen.getByRole('dialog'), { data });
  });

  it('says when a chat is not shared with you', async () => {
    await activateTestLocale('en-XA');
    await renderWithTeam(<SharedThreadPage threadId="st-none" />, { as: 'member' });
    await screen.findByText(xa('This chat is not shared with you'));
    expectFullyLocalized(document.body);
  });

  it('shows the share dialog: who can be chosen, what is not shared, and why some chats cannot be', async () => {
    await activateTestLocale('en-XA');
    const hub = createHub();
    const t = thread({ id: 'th-1', title: 'Trip planning' });
    hub.state.threads = [t];
    const people = [
      person({ accountId: OWNER_ID, displayName: 'Sam', role: 'owner' }),
      person({ accountId: MEMBER_ID, displayName: 'Alex' }),
      person({ accountId: 'acc-kim', displayName: 'Kim' }),
    ];
    const r = await renderWithTeam(<ShareDialog thread={t} onClose={() => undefined} />, {
      hub,
      team: { people },
    });
    const dialog = await screen.findByRole('dialog', { name: xa('Share this chat') });
    await within(dialog).findByRole('checkbox', { name: 'Kim' });
    await userEvent.click(within(dialog).getByRole('button', { name: xa('Share') }));
    await within(dialog).findByRole('alert');
    expectFullyLocalized(document.body, { data: ['Trip planning', ...PEOPLE] });
    r.unmount();
    const temp = thread({ id: 'th-2', title: 'Scratch', temporary: true });
    await renderWithTeam(<ShareDialog thread={temp} onClose={() => undefined} />);
    await screen.findByText(xa('A temporary chat cannot be shared.'));
    expectFullyLocalized(document.body, { data: ['Scratch', ...PEOPLE] });
  });
});

describe('Settings → Members in en-XA', () => {
  const team = () => ({
    people: [
      person({
        accountId: OWNER_ID,
        displayName: 'Sam',
        username: 'sam',
        role: 'owner' as const,
        joinedAt: null,
        invitedBy: null,
      }),
      person({ accountId: MEMBER_ID, displayName: 'Alex' }),
      person({ accountId: 'acc-kim', displayName: 'Kim', invitedBy: 'acc-gone' }),
    ],
    invitations: [
      invitation({ id: 'inv-a', label: 'Jordan', expiresAt: '2099-01-01T00:00:00.000Z' }),
      invitation({ id: 'inv-b', expiresAt: '2099-01-01T00:00:00.000Z' }),
      invitation({ id: 'inv-c', label: 'Kim', status: 'redeemed', redeemedBy: 'acc-kim' }),
      invitation({ id: 'inv-d', status: 'revoked' }),
      invitation({ id: 'inv-e', status: 'expired' }),
    ],
    providers: [
      oidcProvider({ id: 'oidc-1' }),
      oidcProvider({ id: 'oidc-2', label: 'Old sign-in', enabled: false, hasClientSecret: false }),
    ],
  });
  const data = [...PEOPLE, 'Jordan', 'Company sign-in', 'Old sign-in', 'nova-hub'];

  it('shows the people, the invitations and the sign-in providers to the owner', async () => {
    await activateTestLocale('en-XA');
    await renderWithTeam(<MembersPage />, { team: team() });
    await screen.findByRole('list', { name: xa('Invitations') });
    await screen.findByRole('listitem', { name: 'Old sign-in' });
    expectFullyLocalized(document.body, { data });
  });

  it('makes an invitation link and asks before withdrawing one or removing someone', async () => {
    await activateTestLocale('en-XA');
    await renderWithTeam(<MembersPage />, { team: team() });
    const people = await screen.findByRole('list', { name: xa('People of this Hub') });
    await userEvent.click(within(people).getAllByRole('button')[0]!);
    expectFullyLocalized(screen.getByRole('dialog'), { data });
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: xa('Cancel') }),
    );
    const invitations = await screen.findByRole('list', { name: xa('Invitations') });
    await userEvent.click(within(invitations).getAllByRole('button')[0]!);
    expectFullyLocalized(screen.getByRole('dialog'), { data });
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: xa('Cancel') }),
    );
    await userEvent.click(screen.getByRole('button', { name: xa('Invite someone') }));
    expectFullyLocalized(screen.getByRole('dialog'), { data });
    await userEvent.click(screen.getByRole('button', { name: xa('Make the link') }));
    const shown = await screen.findByRole('dialog', { name: xa('Send this link') });
    expectFullyLocalized(shown, { data });
  });

  it('adds, edits and tests a sign-in provider', async () => {
    await activateTestLocale('en-XA');
    await renderWithTeam(<MembersPage />, { team: team() });
    const row = await screen.findByRole('listitem', { name: 'Company sign-in' });
    await userEvent.click(within(row).getByRole('button', { name: xa('Test') }));
    await within(row).findByRole('status');
    expectFullyLocalized(row, { data });
    await userEvent.click(within(row).getByRole('button', { name: xa('Edit') }));
    const edit = screen.getByRole('dialog');
    await userEvent.click(within(edit).getByRole('button', { name: xa('Remove secret') }));
    expectFullyLocalized(edit, { data });
    await userEvent.click(within(edit).getByRole('button', { name: xa('Cancel') }));
    await userEvent.click(screen.getByRole('button', { name: xa('Add a provider') }));
    const add = screen.getByRole('dialog', { name: xa('Add a sign-in provider') });
    await userEvent.clear(within(add).getAllByRole('textbox').at(-1)!);
    await userEvent.click(within(add).getByRole('button', { name: TEAM_TEXT.save }));
    await within(add).findByText(xa('The scopes must include openid.'));
    expectFullyLocalized(add, { data });
    await userEvent.click(within(add).getByRole('button', { name: xa('Cancel') }));
    await userEvent.click(within(row).getByRole('button', { name: TEAM_TEXT.remove }));
    expectFullyLocalized(screen.getByRole('dialog'), { data });
  });

  it('shows the read-only people to a member', async () => {
    await activateTestLocale('en-XA');
    await renderWithTeam(<MembersPage />, { as: 'member', team: team() });
    await screen.findByRole('list', { name: xa('People of this Hub') });
    expectFullyLocalized(document.body, { data });
  });

  it('shows removed members, the purge question and the keep-days form', async () => {
    await activateTestLocale('en-XA');
    await renderW11(<MembersPage />, {
      appauth: {
        removed: [
          removedMember(),
          removedMember({
            accountId: 'acc-lee',
            displayName: 'Lee',
            status: 'kept',
            purgeAfter: null,
            exportable: false,
          }),
          removedMember({
            accountId: 'acc-pat',
            displayName: null,
            status: 'purged',
            purgedAt: new Date().toISOString(),
            cause: 'grace',
            cleanupPending: true,
            counts: { rows: { thread: 4 }, blobs: 1, secrets: 0, folders: 0 },
          }),
          removedMember({
            accountId: 'acc-max',
            displayName: 'Max',
            status: 'failed',
            error: 'disk full',
          }),
          removedMember({ accountId: 'acc-ida', displayName: 'Ida', purgeAfter: null }),
        ],
      },
    });
    const heading = await screen.findByRole('heading', { name: REMOVED_TEXT.heading });
    const section = heading.closest('section')!;
    await within(section).findByRole('listitem', { name: 'Robin' });
    const removedData = [...PEOPLE, 'Robin', 'Lee', 'Max', 'Ida', 'disk full'];
    expectFullyLocalized(section, { data: removedData });
    await userEvent.click(
      within(section).getByRole('button', { name: REMOVED_TEXT.purgeLabel({ name: 'Robin' }) }),
    );
    expectFullyLocalized(screen.getByRole('dialog'), { data: removedData });
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: REMOVED_TEXT.cancel }),
    );
    const field = within(section).getByLabelText(REMOVED_TEXT.keepLabel);
    await userEvent.clear(field);
    await userEvent.type(field, '9999');
    await userEvent.click(within(section).getByRole('button', { name: REMOVED_TEXT.save }));
    await within(section).findByText(REMOVED_TEXT.keepInvalid);
    expectFullyLocalized(section, { data: removedData });
  });
});

describe('Settings → Account in en-XA', () => {
  it('shows who you are, your identities and your public card, with what a sign-in returned', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/settings/account?oidc_error=oidc_signature');
    await renderWithTeam(<AccountPage />, {
      provider: true,
      team: {
        providers: [
          oidcProvider({ id: 'oidc-x' }),
          oidcProvider({ id: 'oidc-y', label: 'School sign-in' }),
        ],
        identities: { [OWNER_ID]: [identity({ providerId: 'oidc-x' })] },
        cards: { [OWNER_ID]: { enabled: true, handle: 'sam', showAvatar: false } },
        publicProfiles: true,
      },
      settings: { 'team.publicProfiles': false },
    });
    await screen.findByRole('switch', { name: xa('Show my public card') });
    await screen.findByRole('list', { name: xa('Linked identities') });
    await screen.findByRole('button', { name: /Ļîñķ School sign-in/ });
    const data = [...PEOPLE, 'Company sign-in', 'School sign-in', 'sam@example.com'];
    expectFullyLocalized(document.body, { data });
    await userEvent.click(
      screen.getByRole('switch', { name: xa('Allow public profile cards on this Hub') }),
    );
    expectFullyLocalized(screen.getByRole('dialog'), { data });
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: xa('Cancel') }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Ûñļîñķ Company sign-in/ }));
    expectFullyLocalized(screen.getByRole('dialog'), { data });
  });

  it('shows a member’s account after linking, and the handle check', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/settings/account?oidc=linked');
    await renderWithTeam(<AccountPage />, { as: 'member', provider: true });
    const handle = await screen.findByRole('textbox', { name: xa('Handle') });
    await screen.findByText(xa('No identity is linked to your account.'));
    await userEvent.type(handle, '-');
    await userEvent.click(screen.getByRole('button', { name: TEAM_TEXT.save }));
    await screen.findByText(
      xa('3 to 40 lowercase letters, digits, - or _, starting with a letter or digit.'),
    );
    expectFullyLocalized(document.body, { data: PEOPLE });
  });
});

describe('the owner-only notice and the team’s words in en-XA', () => {
  const refusal = (reason: string, details: Record<string, unknown> = {}) =>
    new ApiError(403, {
      code: 'policy_denied',
      message: 'refused',
      retryable: false,
      details: { reason, ...details },
    });

  it('shows the notice in place of a part a member may not change', async () => {
    await activateTestLocale('en-XA');
    await renderWithTeam(
      <>
        <MemberGate ownerOnly what={TEAM_SECTION_INFO.agents.label}>
          <p>hidden</p>
        </MemberGate>
        <LoadError error={refusal('owner_only')} fallback="x" onRetry={() => undefined} />
        <LoadError error={new Error('')} fallback={TEAM_TEXT.someone} onRetry={() => undefined} />
      </>,
      { as: 'member', provider: true },
    );
    await screen.findAllByRole('note');
    expectFullyLocalized(document.body);
  });

  it('words every refusal, sign-in return, chip and time', async () => {
    await activateTestLocale('en-XA');
    for (const reason of [
      'owner_only',
      'invitation_invalid',
      'rate_limited',
      'address_rate_limited',
      'not_shareable',
      'not_a_person',
      'setting_off',
      'account_closed',
      'identity_taken',
      'already_linked',
      'discovery',
      'capability_missing',
    ])
      expectLocalizedText(teamErrorMessage(refusal(reason)));
    expectLocalizedText(
      teamErrorMessage(refusal('unknown_plugin', { plugins: ['pl-a', 'pl-b'] })),
      ['pl-a', 'pl-b'],
    );
    expectLocalizedText(teamErrorMessage(refusal('unknown_plugin')));
    expectLocalizedText(teamErrorMessage(refusal('conflict', { field: 'handle' })));
    expectLocalizedText(teamErrorMessage(new Error('')));
    expectLocalizedText(removedErrorMessage(refusal('already_purged'), 'x'));
    expectLocalizedText(removedErrorMessage(refusal('export_unavailable'), 'x'));
    expectLocalizedText(
      removedErrorMessage(
        new ApiError(404, { code: 'not_found', message: 'x', retryable: false }),
        'x',
      ),
    );
    for (const reason of [
      'state_invalid',
      'provider_error',
      'provider_disabled',
      'not_linked',
      'account_closed',
      'identity_taken',
      'already_linked',
      'invitation_invalid',
      'oidc_discovery',
      'oidc_token_exchange',
      'oidc_expired',
      'oidc_not_yet_valid',
      'oidc_malformed',
      'oidc_algorithm',
      'oidc_key',
      'oidc_signature',
      'oidc_issuer',
      'oidc_audience',
      'oidc_nonce',
      'oidc_subject',
      'something_new',
      'other',
    ])
      expectLocalizedText(oidcErrorText(reason));
    for (const s of ['pending', 'redeemed', 'expired', 'revoked'])
      expectLocalizedText(invitationChip(s).text);
    for (const s of ['queued', 'running', 'done', 'failed', 'cancelled'])
      expectLocalizedText(taskChip(s).text);
    for (const s of ['active', 'paused', 'stopped']) expectLocalizedText(teamAgentChip(s).text);
    expectLocalizedText(providerChip({ enabled: true }).text);
    expectLocalizedText(providerChip({ enabled: false }).text);
    const now = Date.parse('2026-10-01T12:00:00Z');
    for (const at of ['2026-10-01T12:30:00Z', '2026-10-02T00:00:00Z', '2026-10-08T12:00:00Z'])
      expectLocalizedText(untilText(at, now));
    expectLocalizedText(untilText('2026-09-01T12:00:00Z', now));
    for (const text of Object.values(MEMBER_MODE_TEXT)) expectLocalizedText(text);
    // Other areas read the owner-only sentence as a string: it follows the active locale.
    expect(OWNER_ONLY_TEXT).toBe(TEAM_TEXT.ownerOnly);
    expectLocalizedText(OWNER_ONLY_TEXT);
    resetTestLocale();
    expect(OWNER_ONLY_TEXT).toBe('Only the owner of this Hub can change this.');
  });
});
