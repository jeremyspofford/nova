// The agents area in the pseudo-locale (FR-016): the Agents list, the sidebar's agents, a new
// agent, one agent's page with each of its sections and dialogs, and Settings → Agents show
// every word through messages. Fixture names and Hub text are `data`; values another area formats
// (Work's spans, tokens, costs, run states and schedule wording) are computed here in the same
// locale, so they count as localized once that area is; regions other areas own are skipped.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_DELETE_NOTICE } from '@nova/shared';
import { ACTIVITY_TEXT } from '../src/agents/AgentActivity.tsx';
import { CONVERSATION_TEXT } from '../src/agents/AgentConversation.tsx';
import { GOAL_TEXT } from '../src/agents/AgentGoal.tsx';
import {
  BACKGROUND_TEXT,
  CHANNELS_TEXT,
  COMPUTER_TEXT,
  THREADS_TEXT,
} from '../src/agents/AgentLinks.tsx';
import { LIST_TEXT } from '../src/agents/AgentList.tsx';
import { MEMORY_PURGE_NOTICE, MEMORY_TEXT } from '../src/agents/AgentMemory.tsx';
import { PAGE_TEXT } from '../src/agents/AgentPage.tsx';
import { PROFILE_TEXT } from '../src/agents/AgentProfile.tsx';
import { RESP_TEXT } from '../src/agents/AgentResponsibilities.tsx';
import { RULES_TEXT } from '../src/agents/AgentRules.tsx';
import { SCHEDULES_TEXT } from '../src/agents/AgentSchedules.tsx';
import { SUGGESTIONS_TEXT } from '../src/agents/AgentSuggestions.tsx';
import { AgentsSettings, EXTERNAL_TEXT, SETTINGS_TEXT } from '../src/agents/AgentsSettings.tsx';
import { AgentsView } from '../src/agents/AgentsView.tsx';
import { FIELDS_TEXT } from '../src/agents/fields.tsx';
import {
  AGENT_AUTONOMY_TEXT,
  AGENT_STATE_TEXT,
  AGENTS_TEXT,
  CHANNEL_KIND_TEXT,
  matchText,
  RULE_EFFECT_TEXT,
} from '../src/agents/format.ts';
import { NEW_AGENT_TEXT } from '../src/agents/NewAgentPage.tsx';
import { SidebarAgents } from '../src/agents/SidebarAgents.tsx';
import { EFFECT_CLASS_TEXT } from '../src/settings/policy-text.ts';
import {
  budgetLine,
  formatCost,
  formatDateTime,
  formatSpan,
  formatTokens,
  RUN_STATUS_TEXT,
} from '../src/work/format.ts';
import { REPEAT_TEXT, whenText } from '../src/work/schedule-when.ts';
import { message } from './fakes.ts';
import { goalView, m5WorkState, scheduleView } from './fakes-m5-work.ts';
import {
  activityItem,
  agentThreadView,
  agentView,
  backgroundView,
  bindingView,
  computerView,
  memoryView,
  renderWithAgents,
  responsibilityView,
  ruleView,
  suggestionView,
} from './fakes-m6-agents.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  window.history.replaceState(null, '', '/');
});

const T = '2026-10-01T11:00:00.000Z';

/** An avatar without an image shows the name's first letter: data, not a word. */
const AVATAR = '.agent-avatar';
/** Work's goal badge, the chat embedded as the main thread, and other areas' sections. */
const OTHER_AREAS = [AVATAR, '.work-badge[data-goal]', '.chat', '.brw-scope-levels', 'optgroup'];

/** Make en-XA active and render `ui` with the agents fakes. */
async function renderPseudo(...args: Parameters<typeof renderWithAgents>) {
  await activateTestLocale('en-XA');
  return renderWithAgents(...args);
}

describe('the agents area in a pseudo-locale', () => {
  it('lists agents with their state, activity and counts', async () => {
    window.history.replaceState(null, '', '/agents');
    await renderPseudo(<AgentsView id={null} />, {
      agents: {
        agents: [
          agentView({
            id: 'a1',
            name: 'Scout',
            lastActiveAt: T,
            derived: { status: 'needs_input', reason: 'Approval needed' },
            responsibilities: [responsibilityView({ agentId: 'a1' })],
          }),
          agentView({
            id: 'a2',
            name: 'Ledger',
            status: 'paused',
            pauseReason: 'safety',
            derived: { status: 'blocked', reason: 'Paused for safety' },
          }),
          agentView({ id: 'a3', name: 'Courier', status: 'stopped' }),
        ],
        suggestions: [
          suggestionView({ agentId: 'a1' }),
          suggestionView({ agentId: 'a1', title: 'Second finding' }),
        ],
      },
    });
    expect(AGENTS_TEXT.agents).toMatch(/^\[/);
    const list = await screen.findByRole('list', { name: AGENTS_TEXT.agents });
    expect(within(list).getByText(LIST_TEXT.suggestions({ n: 2 }))).toBeTruthy();
    expect(within(list).getByText(AGENT_STATE_TEXT.pausedSafety)).toBeTruthy();
    const page = list.closest('.agents-page');
    expect(page).toBeTruthy();
    expectFullyLocalized(page!, {
      data: ['Scout', 'Ledger', 'Courier', 'Approval needed', 'Paused for safety'],
      skip: [AVATAR],
    });
  });

  it('shows the empty list and the sidebar’s agents', async () => {
    window.history.replaceState(null, '', '/agents');
    await renderPseudo(<AgentsView id={null} />);
    expect(await screen.findByText(LIST_TEXT.emptyTitle)).toBeTruthy();
    expectFullyLocalized(document.querySelector('.agents-page')!);
    resetDom();

    await renderPseudo(<SidebarAgents selectedId={null} />, {
      agents: {
        agents: [
          agentView({ id: 'a1', name: 'Scout', status: 'paused', pauseReason: 'user' }),
          agentView({
            id: 'a2',
            name: 'Ledger',
            derived: { status: 'needs_input', reason: 'Approval needed' },
          }),
        ],
      },
    });
    const side = await screen.findByRole('list', { name: AGENTS_TEXT.agents });
    expect(within(side).getByText(AGENT_STATE_TEXT.after.paused)).toBeTruthy();
    expectFullyLocalized(side, { data: ['Scout', 'Ledger', 'Approval needed'], skip: [AVATAR] });
  });

  it('creates an agent: the form, its warnings and its errors', async () => {
    window.history.replaceState(null, '', '/agents/new');
    await renderPseudo(<AgentsView id="new" />, { settings: { 'review.model': null } });
    const form = await screen.findByRole('form', { name: NEW_AGENT_TEXT.heading });
    // Autonomous without a reviewer model warns, with a link to Settings.
    await userEvent.click(
      within(form).getByRole('radio', { name: new RegExp(escape(autonomyLabel('autonomous'))) }),
    );
    expect(within(form).getByRole('link', { name: FIELDS_TEXT.codeSettings })).toBeTruthy();
    // A second responsibility row, and the budget and name errors.
    await userEvent.click(within(form).getByRole('button', { name: NEW_AGENT_TEXT.addResp }));
    const tokens = within(form).getByRole('textbox', { name: FIELDS_TEXT.tokens });
    await userEvent.clear(tokens);
    await userEvent.type(tokens, '50');
    await userEvent.click(within(form).getByRole('button', { name: NEW_AGENT_TEXT.create }));
    expect(
      await within(form).findByText(FIELDS_TEXT.tokensError({ min: 1_000, max: 100_000_000 })),
    ).toBeTruthy();
    expect(within(form).getByText(AGENTS_TEXT.nameRequired)).toBeTruthy();
    expectFullyLocalized(form.closest('.agents-page')!, { skip: OTHER_AREAS });
  });

  it('shows one agent: header, controls, conversation and each section', async () => {
    const budgets = { timeSeconds: 1_800, tokens: 500_000, costUsd: null };
    const usage = { timeSeconds: 7_200, tokens: 1_200_000, costUsd: 0.4 };
    const wake = scheduleView({
      id: 's1',
      title: 'Check back on the build',
      when: { at: '2026-10-20T09:00:00.000Z' },
      origin: 'agent_self',
      agentId: 'ag1',
      wakeReason: 'The CI run takes an hour',
      instructions: 'Look at the CI result',
      lastRunAt: T,
    });
    const mine = scheduleView({ id: 's2', title: 'Morning check', agentId: 'ag1', enabled: false });
    const goal = goalView({
      id: 'g1',
      agentId: 'ag1',
      objective: 'Ship the report',
      status: 'blocked',
      blocker: { key: 'no-access', description: 'No access to the drive', count: 3 },
      progressNote: 'Outline done',
      budgets: { tokens: 10_000 },
      usage: { tokens: 2_500 },
    });
    const preview = {
      callId: 'c1',
      threadId: 't1',
      tool: 'email.send',
      status: 'done',
      decision: 'ask',
      createdAt: T,
    };
    window.history.replaceState(null, '', '/agents/ag1');
    const r = await renderPseudo(<AgentsView id="ag1" />, {
      settings: { 'review.model': null },
      agents: {
        agents: [
          agentView({
            id: 'ag1',
            name: 'Scout',
            status: 'paused',
            pauseReason: 'safety',
            statusDetail: 'Too many denied actions',
            derived: { status: 'needs_input', reason: 'Approval needed' },
            primaryThreadId: 't-main',
            computerId: 'cmp1',
            goalId: 'g1',
            lastActiveAt: T,
            budgets,
            usage,
            responsibilities: [
              responsibilityView({
                id: 'r1',
                agentId: 'ag1',
                title: 'Weekly digest',
                instructions: 'Every Friday',
                goalId: 'g1',
                progressNote: 'Drafted 3 of 5 sections',
              }),
            ],
          }),
        ],
        threads: [
          agentThreadView({ threadId: 't-main', agentId: 'ag1', kind: 'main' }),
          agentThreadView({
            threadId: 't-slack',
            agentId: 'ag1',
            kind: 'binding',
            bindingRef: 'cb1',
            audience: 'shared',
          }),
          agentThreadView({
            threadId: 't-research',
            agentId: 'ag1',
            kind: 'proactive',
            title: 'Vendor news',
          }),
          agentThreadView({
            threadId: 't-bg',
            agentId: 'ag1',
            kind: 'background',
            runId: 'run1',
            title: 'Contract summary',
          }),
        ],
        channels: [
          bindingView({ id: 'cb1', agentId: 'ag1', label: '#support', lastMessageAt: T }),
          bindingView({
            id: 'cb2',
            agentId: 'ag1',
            kind: 'email',
            label: 'Inbox',
            status: 'not_configured',
            statusDetail: 'Add the SMTP password',
            audience: 'private',
            sharePrimaryThread: true,
          }),
        ],
        activity: {
          ag1: [
            activityItem({ kind: 'notice', title: 'Agent created' }),
            activityItem({
              kind: 'tool_call',
              title: 'email.send',
              status: 'done',
              callId: 'call-1',
              detail: '{"to":"team@example.com"}',
            }),
          ],
        },
        rules: [
          ruleView({ id: 'rule1', agentId: 'ag1', priority: 50 }),
          ruleView({
            id: 'rule2',
            agentId: 'ag1',
            description: 'Run git status freely',
            effect: 'act',
            match: { tools: ['exec.run'], channels: [{ kind: 'slack', conversation: '#ops' }] },
            command: {
              pattern: ['git', ['status', 'diff']],
              matchExamples: ['git status'],
              notMatchExamples: ['git push'],
            },
            enabled: false,
          }),
        ],
        previews: { rule1: [preview] },
        memory: [
          memoryView({ id: 'm1', agentId: 'ag1', pinned: true }),
          memoryView({
            id: 'm2',
            agentId: 'ag1',
            kind: 'observation',
            author: 'agent',
            source: 'tool',
            originAudience: 'shared',
            content: 'Globex pays late.',
          }),
          memoryView({
            id: 'm3',
            agentId: 'ag1',
            store: 'conversation',
            kind: 'preference',
            source: 'conversation',
            content: 'Prefers short summaries.',
          }),
        ],
        suggestions: [suggestionView({ id: 'sg1', agentId: 'ag1' })],
        background: {
          ag1: [backgroundView({ runId: 'run1', title: 'Contract summary', endedAt: T })],
        },
        computers: [
          computerView({
            id: 'cmp1',
            state: 'degraded',
            detail: 'Disk almost full',
            snapshotCount: 2,
            lastUsedAt: T,
          }),
        ],
      },
      hub: { m5work: m5WorkState({ goals: [goal], schedules: [wake, mine] }) },
    });
    r.hub.state.messages.set('t-slack', [
      message('t-slack', { role: 'user', parts: [{ type: 'text', text: 'Can you help?' }] }),
    ]);

    // Values Work formats, in the same locale.
    const work = [
      formatSpan(usage.timeSeconds),
      formatTokens(usage.tokens),
      formatCost(usage.costUsd),
      budgetLine(budgets),
      formatSpan(0),
      formatTokens(2_500),
      formatTokens(10_000),
      formatCost(0),
      RUN_STATUS_TEXT.running,
      whenText(wake.when),
      whenText(mine.when),
      formatDateTime(wake.nextRunAt),
      formatDateTime(T),
      ...Object.values(REPEAT_TEXT),
      ...Object.values(EFFECT_CLASS_TEXT),
    ];
    const data = [
      ...work,
      'Scout',
      'Approval needed',
      'Too many denied actions',
      '#support',
      '#ops',
      'Inbox',
      'Add the SMTP password',
      'Vendor news',
      'Contract summary',
      'Agent created',
      'email.send',
      'exec.run',
      'done',
      'ask',
      'Weekly digest',
      'Every Friday',
      'Drafted 3 of 5 sections',
      'Ship the report',
      'No access to the drive',
      'Outline done',
      'Ask before messaging customers',
      'Run git status freely',
      '*.customer.com',
      'The weekly report goes out on Fridays.',
      'Globex pays late.',
      'Prefers short summaries.',
      'Two invoices are overdue',
      'Acme and Globex have not paid. Want me to draft reminders?',
      'Check back on the build',
      'The CI run takes an hour',
      'Look at the CI result',
      'Morning check',
      'UTC',
      'Disk almost full',
      'Can you help?',
      'Keep an eye on the team inbox.',
    ];

    const page = await screen.findByRole('region', { name: PAGE_TEXT.region({ name: 'Scout' }) });
    expect(
      within(page).getByText(PAGE_TEXT.autonomy({ level: autonomyLabel('standard') })),
    ).toBeTruthy();
    expect(within(page).getByText(/Too many denied actions/)).toBeTruthy();
    const check = (el: Element, skip: string[] = []) =>
      expectFullyLocalized(el, { data, skip: [...OTHER_AREAS, ...skip] });

    // Header, controls, the tabs and the conversation (its chat is the chat area's).
    await within(page).findByRole('list', { name: ACTIVITY_TEXT.list });
    check(page.querySelector('.agent-header')!);
    check(within(page).getByRole('tablist'));
    check(page.querySelector('.agent-conversation')!);

    const open = async (tab: string) => {
      await userEvent.click(within(page).getByRole('tab', { name: tab }));
      return screen.getByRole('tabpanel');
    };

    // Activity, with an entry opened.
    let panel = screen.getByRole('tabpanel');
    const entry = await within(panel).findByRole('button', { name: /email\.send/ });
    await userEvent.click(entry);
    expect(within(panel).getByText(ACTIVITY_TEXT.details)).toBeTruthy();
    check(panel);

    // Responsibilities.
    panel = await open(PAGE_TEXT.tabs.responsibilities);
    await within(panel).findByRole('list', { name: RESP_TEXT.list });
    expect(within(panel).getByText(RESP_TEXT.progressSpoken)).toBeTruthy();
    check(panel);
    await userEvent.click(within(panel).getByRole('button', { name: RESP_TEXT.add }));
    check(within(panel).getByRole('form', { name: RESP_TEXT.newForm }));
    await userEvent.click(
      within(panel).getByRole('button', { name: RESP_TEXT.deleteOf({ title: 'Weekly digest' }) }),
    );
    check(screen.getByRole('dialog', { name: RESP_TEXT.deleteTitle }));
    await userEvent.keyboard('{Escape}');

    // Goal: blocked, its budget dialog and the clear confirmation.
    panel = await open(PAGE_TEXT.tabs.goal);
    expect(await within(panel).findByText('No access to the drive')).toBeTruthy();
    check(panel);
    await userEvent.click(within(panel).getByRole('button', { name: GOAL_TEXT.budget }));
    check(screen.getByRole('dialog', { name: GOAL_TEXT.budgetTitle }));
    const goalTokens = within(screen.getByRole('dialog')).getByRole('textbox', {
      name: FIELDS_TEXT.tokens,
    });
    await userEvent.clear(goalTokens);
    await userEvent.type(goalTokens, '5');
    expect(screen.getByText(GOAL_TEXT.tokensError({ min: 1_000 }))).toBeTruthy();
    check(screen.getByRole('dialog', { name: GOAL_TEXT.budgetTitle }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(panel).getByRole('button', { name: GOAL_TEXT.clear }));
    check(screen.getByRole('dialog', { name: GOAL_TEXT.clearTitle }));
    await userEvent.keyboard('{Escape}');

    // Rules: the list, a preview, the form and the delete confirmation.
    panel = await open(PAGE_TEXT.tabs.rules);
    await within(panel).findByRole('list', { name: RULES_TEXT.list });
    expect(
      within(panel).getByText(
        RULES_TEXT.appliesTo({
          match: matchText({ actions: ['send'], hosts: ['*.customer.com'] }),
        }),
      ),
    ).toBeTruthy();
    await userEvent.click(
      within(panel).getByRole('button', {
        name: RULES_TEXT.previewOf({ rule: 'Ask before messaging customers' }),
      }),
    );
    await within(panel).findByText(RULES_TEXT.previewHeading);
    await within(panel).findByText('email.send');
    check(panel);
    await userEvent.click(within(panel).getByRole('button', { name: RULES_TEXT.add }));
    const ruleForm = within(panel).getByRole('form', { name: RULES_TEXT.newForm });
    await userEvent.click(within(ruleForm).getByRole('button', { name: RULES_TEXT.addChannel }));
    await userEvent.click(
      within(ruleForm).getByRole('radio', { name: new RegExp(escape(effectLabel('handoff'))) }),
    );
    await userEvent.click(within(ruleForm).getByRole('button', { name: RULES_TEXT.addRule }));
    expect(within(ruleForm).getByText(RULES_TEXT.descriptionRequired)).toBeTruthy();
    check(ruleForm);
    await userEvent.click(within(ruleForm).getByRole('button', { name: AGENTS_TEXT.cancel }));
    await userEvent.click(
      within(panel).getByRole('button', {
        name: RULES_TEXT.deleteOf({ rule: 'Run git status freely' }),
      }),
    );
    check(screen.getByRole('dialog', { name: RULES_TEXT.deleteTitle }));
    await userEvent.keyboard('{Escape}');

    // Memory: notes, what it learned, the add form and both confirmations.
    panel = await open(PAGE_TEXT.tabs.memory);
    await within(panel).findByRole('list', { name: MEMORY_TEXT.notes });
    check(panel);
    await userEvent.click(within(panel).getByRole('button', { name: MEMORY_TEXT.addNote }));
    check(within(panel).getByRole('form', { name: MEMORY_TEXT.newNote }));
    await userEvent.click(
      within(panel).getByRole('button', {
        name: MEMORY_TEXT.editOf({ text: 'Globex pays late.' }),
      }),
    );
    expect(
      within(panel).getByRole('textbox', { name: MEMORY_TEXT.editKind({ kind: 'observation' }) }),
    ).toBeTruthy();
    check(panel);
    await userEvent.click(
      within(panel).getByRole('button', {
        name: MEMORY_TEXT.forgetOf({ text: 'Prefers short summaries.' }),
      }),
    );
    check(screen.getByRole('dialog', { name: MEMORY_TEXT.forgetTitle }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(panel).getByRole('switch', { name: AGENTS_TEXT.memory }));
    check(screen.getByRole('dialog', { name: MEMORY_TEXT.offTitle }));
    await userEvent.keyboard('{Escape}');

    // Suggestions, open and all.
    panel = await open(PAGE_TEXT.tabs.suggestionsOpen({ n: 1 }));
    await within(panel).findByRole('list', { name: SUGGESTIONS_TEXT.list });
    check(panel);

    // Schedules and wakes, and the dialogs to change and cancel one.
    panel = await open(PAGE_TEXT.tabs.schedules);
    const schedules = await within(panel).findByRole('list', { name: SCHEDULES_TEXT.list });
    expect(within(schedules).getByText(SCHEDULES_TEXT.setBy({ name: 'Scout' }))).toBeTruthy();
    check(panel);
    await userEvent.click(
      within(panel).getByRole('button', {
        name: SCHEDULES_TEXT.changeOf({ title: 'Check back on the build' }),
      }),
    );
    check(screen.getByRole('dialog', { name: SCHEDULES_TEXT.changeTitle }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(panel).getByRole('button', { name: SCHEDULES_TEXT.new }));
    check(screen.getByRole('dialog', { name: SCHEDULES_TEXT.newTitle }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(
      within(panel).getByRole('button', {
        name: SCHEDULES_TEXT.cancelOf({ title: 'Morning check' }),
      }),
    );
    check(screen.getByRole('dialog', { name: SCHEDULES_TEXT.cancelTitle }));
    await userEvent.keyboard('{Escape}');

    // Background work.
    panel = await open(PAGE_TEXT.tabs.background);
    await within(panel).findByRole('list', { name: BACKGROUND_TEXT.list });
    check(panel);

    // Threads, then a channel's thread read-only in the conversation.
    panel = await open(PAGE_TEXT.tabs.threads);
    const threads = await within(panel).findByRole('list', { name: THREADS_TEXT.list });
    check(panel);
    const slackName = CONVERSATION_TEXT.binding({ kind: channelKind('slack'), label: '#support' });
    await userEvent.click(
      within(threads).getByRole('button', { name: THREADS_TEXT.showOf({ label: slackName }) }),
    );
    const log = await screen.findByRole('region', { name: slackName });
    await within(log).findByText('Can you help?');
    // The messages are the chat area's.
    check(log, ['.work-log > *']);

    // Channels.
    panel = await open(PAGE_TEXT.tabs.channels);
    expect(within(panel).getByRole('link', { name: CHANNELS_TEXT.settingsLink })).toBeTruthy();
    check(panel);

    // Computer (its own computers part is the devices area's, the site levels the browser's).
    panel = await open(PAGE_TEXT.tabs.computer);
    await within(panel).findByText(COMPUTER_TEXT.kind.cloud);
    check(panel, ['.devices-flat']);

    // Profile.
    panel = await open(PAGE_TEXT.tabs.profile);
    expect(within(panel).getByRole('heading', { name: PROFILE_TEXT.heading })).toBeTruthy();
    check(panel);

    // Delete, with the Hub's notice.
    await userEvent.click(
      within(within(page).getByRole('group', { name: PAGE_TEXT.controls })).getByRole('button', {
        name: AGENTS_TEXT.delete,
      }),
    );
    check(screen.getByRole('dialog', { name: PAGE_TEXT.deleteTitle({ name: 'Scout' }) }));
  });

  it('says why a stopped agent stopped', async () => {
    window.history.replaceState(null, '', '/agents/ag1');
    await renderPseudo(<AgentsView id="ag1" />, {
      agents: { agents: [agentView({ id: 'ag1', name: 'Scout', status: 'stopped' })] },
    });
    const page = await screen.findByRole('region', { name: PAGE_TEXT.region({ name: 'Scout' }) });
    expect(within(page).getByText(PAGE_TEXT.stoppedNote)).toBeTruthy();
    expectFullyLocalized(page.querySelector('.agent-header')!, {
      data: ['Scout', ...[formatSpan(0), formatTokens(0), formatCost(0)]].concat(
        budgetLine({ timeSeconds: 1_800, tokens: 500_000, costUsd: null }),
      ),
      skip: OTHER_AREAS,
    });
  });

  it('shows Settings → Agents with its limits and external agents', async () => {
    const r = await renderPseudo(<AgentsSettings />, {
      settings: { 'review.model': null },
      managed: { 'agents.wakes': { minMinutes: 30, horizonDays: 7, perDay: 4 } },
      agents: {
        external: [
          {
            id: 'x1',
            address: 'billing-bot@vendor.com',
            label: 'Billing bot',
            createdAt: T,
          },
        ],
      },
    });
    const page = (await screen.findByRole('heading', { name: SETTINGS_TEXT.newAgents })).closest(
      '.settings-page',
    )!;
    await screen.findByRole('list', { name: EXTERNAL_TEXT.list });
    expect(screen.getByText(SETTINGS_TEXT.managed)).toBeTruthy();
    const autonomy = screen.getByRole('combobox', { name: SETTINGS_TEXT.autonomy });
    expect(
      within(autonomy).getByRole('option', {
        name: SETTINGS_TEXT.needsReviewer({ level: autonomyLabel('autonomous') }),
      }),
    ).toBeTruthy();
    // An interval out of range explains itself.
    const every = screen.getByRole('textbox', { name: SETTINGS_TEXT.interval });
    await userEvent.clear(every);
    await userEvent.type(every, '5{Enter}');
    expect(
      screen.getByText(FIELDS_TEXT.minutesError({ min: 15, max: 10_080, days: 7 })),
    ).toBeTruthy();
    const data = ['billing-bot@vendor.com', 'Billing bot'];
    expectFullyLocalized(page, { data, skip: OTHER_AREAS });
    await userEvent.click(
      screen.getByRole('button', { name: EXTERNAL_TEXT.removeOf({ name: 'Billing bot' }) }),
    );
    expectFullyLocalized(screen.getByRole('dialog', { name: EXTERNAL_TEXT.removeTitle }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(r.api.listExternalAgents).toHaveBeenCalled());
  });

  it('keeps the English of the Hub’s notices', () => {
    // In English the messages read as the contract's own wording.
    expect(PAGE_TEXT.deleteNotice).toBe(AGENT_DELETE_NOTICE);
    expect(MEMORY_TEXT.purgeNotice).toBe(MEMORY_PURGE_NOTICE);
  });
});

/** Labels read at call time, so the active locale applies. */
function autonomyLabel(level: 'ask_first' | 'standard' | 'autonomous'): string {
  return AGENT_AUTONOMY_TEXT[level].label;
}

function effectLabel(effect: 'act' | 'act_on_request' | 'ask' | 'handoff'): string {
  return RULE_EFFECT_TEXT[effect].label;
}

function channelKind(kind: 'slack' | 'email'): string {
  return CHANNEL_KIND_TEXT[kind];
}

/** `text` as a literal pattern for a RegExp. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
