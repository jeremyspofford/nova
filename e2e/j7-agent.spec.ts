// J7 — Agent (docs/18 §3; M6 exit criteria and demo in docs/17): an agent on the mock cloud
// computer, with the mock calendar MCP server connected (e2e/support/calendar-mcp-server.mjs),
// does read-only proactive research on the calendar and surfaces a finding; an MCP event trigger
// wakes it when the calendar delivers a signed event, and it books the meeting, asking before it
// creates the event and before it sends the invite (the M6 demo), while unsigned, oversized and
// repeated deliveries start nothing; it sets its own wake, which the user cancels in Scheduled.
// From the mock Slack (e2e/support/mock-slack.ts) the owner messages it in a DM and in a shared
// channel: two threads under the agent with one memory, private notes stay out of the channel, a
// custom rule makes it ask before it posts to the channel, Slack answers deny and then allow
// once, and the owner decides whether the DM's detail may reach the channel. On a connected device
// (the fake novad, FakeDevice) the agent stages a write with its device tool, shown as a diff that
// lands on Commit; a write outside its folders asks for folder access, and once allowed the agent
// stages it again and commits it on the owner's approval. Its computer is taken over and
// returned, and the audit log shows it. The offline Mock provider drives every call with `/tool <name> <json>` lines
// (packages/providers mock).
//
// How the outside world is played, and what the UI cannot do:
// - The Hub has no setting for the Slack Web API address, so it runs with
//   e2e/support/slack-api-redirect.ts, which sends its https://slack.com/api calls to the mock.
//   Slack messages and MCP event deliveries are signed and posted to the Hub's public endpoints as
//   Slack and the calendar would.
// - Research turns act on `/tool` lines of the agent's responsibilities; the responsibility
//   Details field is a single line, so the scripted lines are set through the API.
// - The journey sends the DM more than its default 10 messages a minute: the limit is raised in
//   the channel's settings.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FakeDevice } from '../packages/core/src/devices/fake-device.ts';
import { expectNoSeriousA11yIssues } from './support/a11y.ts';
import type { RunningHub } from './support/hub.ts';
import {
  addCalendarServer,
  agentRegion,
  agentComputer,
  calendarControl,
  call,
  createAgent,
  decide,
  getAgent,
  json,
  messages,
  openAgentTab,
  send,
  setUpHub,
  toast,
  until,
  useCloudComputers,
} from './support/m6.ts';
import {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  startMockSlack,
  type MockSlack,
} from './support/mock-slack.ts';

const portFor = (parallelIndex: number) => 7591 + parallelIndex;
let hub: RunningHub;

test.use({ colorScheme: 'light' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

test.afterEach(async () => {
  await hub?.stop();
});

const AGENT = 'Scout';

test('J7: research on the calendar, MCP events wake it to book a meeting, a self-set wake', async ({
  page,
}, testInfo) => {
  const cal = calendarControl();
  hub = await setUpHub(page, portFor(testInfo.parallelIndex));

  // 1. The agent on the mock cloud computer, with the mock calendar connected: list_events is
  //    marked "Reads only" by the owner.
  await useCloudComputers(page, hub);
  await expectNoSeriousA11yIssues(page, 'computers');
  await addCalendarServer(page, hub, cal);
  await expectNoSeriousA11yIssues(page, 'settings/tools with the calendar tools');
  const agentId = await createAgent(page, hub, {
    name: AGENT,
    instructions: 'Keep my calendar in order and tell me what needs preparing.',
    responsibility: 'Watch my calendar',
    details: 'Flag meetings that need preparation.',
  });
  const computer = await agentComputer(page, hub, agentId);
  expect(computer.kind).toBe('cloud');
  const computerTab = await openAgentTab(page, 'Computer');
  await expect(computerTab).toContainText('Cloud computer');
  await expect(page.getByText('Proactive research on')).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'agent page');

  // 2. Proactive research reads the calendar (the owner's read-only tool) and surfaces a finding;
  //    the write it tries is refused and never reaches the calendar. The Mock acts on `/tool`
  //    lines of the research turn, which come from the responsibility's details: the Details
  //    field is one line, so the scripted lines are added through the API.
  const { responsibilities } = await getAgent(page, hub, agentId);
  await json(
    await page.request.patch(
      `${hub.url}/api/v1/agents/${agentId}/responsibilities/${responsibilities[0]!.id}`,
      {
        data: {
          instructions: [
            'Flag meetings that need preparation.',
            call('mcp:calendar.list_events', {}),
            call('mcp:calendar.send_invite', { eventId: 'evt_1' }),
          ].join('\n'),
        },
      },
    ),
  );
  await page
    .getByRole('group', { name: 'Agent controls' })
    .getByRole('button', { name: 'Research now' })
    .click();
  await expect(toast(page, 'Research started. Findings arrive as suggestions.')).toBeVisible();
  const suggestions = await openAgentTab(page, /^Suggestions/);
  const finding = suggestions
    .getByRole('list', { name: 'Suggestions' })
    .getByRole('listitem')
    .filter({ hasText: 'Tool mcp:calendar.list_events returned:' });
  await expect(finding).toContainText('Quarterly planning', { timeout: 30_000 });
  await expect(finding).toContainText('Tool mcp:calendar.send_invite returned: Error');
  await expect(finding.getByRole('button', { name: /^Accept:/ })).toBeVisible();
  const afterResearch = await cal.state();
  expect(afterResearch.calls.map((c) => c.tool)).toEqual(['list_events']);
  await expectNoSeriousA11yIssues(page, 'agent suggestions');

  // 5 and the M6 demo. An MCP event trigger (Settings > Triggers) wakes the agent when the
  //    calendar delivers a signed `invite.received`: it books the meeting, asking before it
  //    creates the event and before it sends the invite. An unsigned or oversized delivery is
  //    refused; a repeated delivery id starts nothing.
  await page.goto(`${hub.url}/settings/triggers`);
  await page
    .getByRole('group', { name: 'New trigger' })
    .getByRole('button', { name: 'MCP event' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'New MCP event trigger' });
  await dialog.getByLabel('MCP server').selectOption({ label: 'calendar' });
  await dialog.getByLabel('Event', { exact: true }).selectOption('invite.received');
  await dialog.getByRole('radio', { name: 'Wake an agent' }).check();
  await dialog.getByLabel('Agent', { exact: true }).selectOption({ label: AGENT });
  await dialog.getByLabel('Instructions', { exact: true }).fill(
    [
      'Someone sent a meeting invite: put the meeting on the calendar and send the invite.',
      call('mcp:calendar.create_event', {
        title: 'Design review',
        start: '2026-10-22T16:00:00Z',
        attendees: ['sam@example.com'],
      }),
      call('mcp:calendar.send_invite', { eventId: 'evt_3' }),
    ].join('\n'),
  );
  await dialog.getByLabel('Name (optional)').fill('Meeting invites');
  await expectNoSeriousA11yIssues(page, 'New MCP event trigger dialog');
  await dialog.getByRole('button', { name: 'Subscribe' }).click();
  const trigger = page.getByRole('list', { name: 'Triggers' }).getByRole('listitem', {
    name: 'Meeting invites',
  });
  await expect(trigger).toContainText('Active');
  await expect(trigger).toContainText(`Wakes ${AGENT}`);
  await expect(trigger).toContainText('calendar · invite.received');
  const sub = await until('the calendar has a subscriber', async () => {
    const s = await cal.state();
    return s.subscriptions.find((x) => x.event === 'invite.received') ?? null;
  });
  expect(sub.url).toMatch(/\/api\/v1\/mcp\/events\/[^/]+$/);

  const unsigned = await cal.emit({
    event: 'invite.received',
    data: { from: 'sam' },
    unsigned: true,
  });
  expect(unsigned.map((d) => d.status)).toEqual([401]);
  const oversized = await cal.emit({ event: 'invite.received', padBytes: 300_000 });
  expect(oversized.map((d) => d.status)).toEqual([413]);
  const data = { from: 'sam@example.com', title: 'Design review' };
  const first = await cal.emit({ event: 'invite.received', data, deliveryId: 'dlv-invite-1' });
  expect(first.map((d) => d.status)).toEqual([200]);
  expect(JSON.parse(first[0]!.body)).toMatchObject({ duplicate: false, outcome: 'started' });
  const again = await cal.emit({ event: 'invite.received', data, deliveryId: 'dlv-invite-1' });
  expect(again.map((d) => d.status)).toEqual([200]);
  expect(JSON.parse(again[0]!.body)).toMatchObject({ duplicate: true });

  await page.reload();
  await trigger.getByRole('button', { name: 'Deliveries of Meeting invites' }).click();
  const deliveries = page.getByRole('list', { name: 'Deliveries of Meeting invites' });
  await expect(deliveries.getByRole('listitem')).toHaveCount(1);
  await expect(deliveries).toContainText('Started');
  await expect(trigger).toContainText('a delivery was refused');
  await expectNoSeriousA11yIssues(page, 'settings/triggers with deliveries');

  // The woken agent asks in its conversation: allow the event, then the invite (the demo).
  await page.goto(`${hub.url}/agents/${agentId}`);
  const scout = agentRegion(page, AGENT);
  await decide(scout, 'mcp:calendar.create_event', 'Allow once');
  await expectNoSeriousA11yIssues(page, 'agent conversation with an approval');
  await decide(scout, 'mcp:calendar.send_invite', 'Allow once');
  await expect(messages(scout)).toContainText(
    'Tool mcp:calendar.send_invite returned: Invite for Design review sent to sam@example.com',
  );
  const booked = await cal.state();
  expect(booked.calls.map((c) => c.tool)).toEqual(['list_events', 'create_event', 'send_invite']);
  expect(booked.events.map((e) => e.title)).toContain('Design review');

  // 6. The agent sets its own next wake; Scheduled lists it as set by the agent; the user
  //    cancels it there.
  const reason = 'Check whether Sam accepted the invite';
  await send(scout, call('schedule.wake', { in: '2h', reason }));
  await expect(messages(scout)).toContainText('Tool schedule.wake returned: Wake-up set for');
  await page.goto(`${hub.url}/work/scheduled`);
  const wake = page.getByRole('list', { name: 'Schedules' }).getByRole('listitem', {
    name: `${AGENT}: ${reason}`,
  });
  await expect(wake.getByRole('link', { name: `Set by ${AGENT}` })).toBeVisible();
  await expect(wake).toContainText(`Reason: ${reason}`);
  await expectNoSeriousA11yIssues(page, 'scheduled with an agent wake');
  await wake.getByRole('button', { name: `Delete ${AGENT}: ${reason}` }).click();
  await page
    .getByRole('dialog', { name: 'Delete this schedule?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(wake).toHaveCount(0);
  const { items: schedules } = await json<{ items: { agentId: string | null }[] }>(
    await page.request.get(`${hub.url}/api/v1/schedules`),
  );
  expect(schedules.filter((s) => s.agentId === agentId)).toEqual([]);
});

// ---- Slack ----------------------------------------------------------------------------------

const OWNER = 'UOWNER';
const DM = 'DOWNER';
const TEAM = 'CTEAM';

/** Settings > Channels > Add channel: a Slack conversation of the agent; returns its inbound URL. */
async function addSlackChannel(
  page: Page,
  c: { name: string; conversation: string; audience: 'Private' | 'Shared' },
): Promise<string> {
  await page.getByRole('button', { name: 'Add channel' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a channel' });
  await dialog.getByRole('radio', { name: 'Slack', exact: true }).check();
  await dialog.getByLabel('Agent', { exact: true }).selectOption({ label: AGENT });
  await dialog.getByLabel('Name (optional)').fill(c.name);
  await dialog.getByLabel('Slack conversation ID').fill(c.conversation);
  await dialog.getByRole('radio', { name: c.audience, exact: true }).check();
  await dialog.getByLabel('Bot token').fill(SLACK_BOT_TOKEN);
  await dialog.getByLabel('Signing secret').fill(SLACK_SIGNING_SECRET);
  await dialog.getByLabel('Bot user ID (optional)').fill('UNOVABOT');
  await dialog.getByRole('button', { name: 'Add channel' }).click();
  const done = page.getByRole('dialog', { name: `Finish setting up ${c.name}` });
  await expect(done).toContainText('Connected');
  const inbound = (
    await done.getByRole('group', { name: 'Inbound address' }).locator('code').textContent()
  )?.trim();
  expect(inbound).toMatch(/\/api\/v1\/channels\/[^/]+\/inbound$/);
  await done.getByRole('button', { name: 'Done' }).click();
  return inbound!;
}

/** Wait for the agent's next post to a Slack conversation that contains `text`. */
async function slackPost(slack: MockSlack, channel: string, text: string | RegExp) {
  return until(`a Slack post in ${channel} with ${String(text)}`, () =>
    Promise.resolve(
      slack.posts.find(
        (p) =>
          p.channel === channel &&
          (typeof text === 'string' ? p.text.includes(text) : text.test(p.text)),
      ) ?? null,
    ),
  );
}

/**
 * Settings > Channels: the owner's Slack identity, the owner's DM with the bot (private, with a
 * higher rate limit) and the team channel (shared), both answered by the agent; a test message
 * reaches the channel. Returns senders for what the owner writes in Slack.
 */
async function connectSlack(page: Page, slack: MockSlack) {
  await page.goto(`${hub.url}/settings/channels`);
  const person = page.getByRole('form', { name: 'Add a person' });
  await person.getByLabel('Where').selectOption({ label: 'Slack' });
  await person.getByLabel('Their ID').fill(OWNER);
  await person.getByLabel('Name (optional)').fill('Jeremy');
  await person.getByLabel('Role').selectOption({ label: 'Owner (you)' });
  await person.getByRole('button', { name: 'Add person' }).click();
  await expect(page.getByRole('list', { name: 'People' })).toContainText('Jeremy');
  const dmUrl = await addSlackChannel(page, {
    name: 'Scout DM',
    conversation: DM,
    audience: 'Private',
  });
  await expectNoSeriousA11yIssues(page, 'settings/channels');
  const teamUrl = await addSlackChannel(page, {
    name: 'team',
    conversation: TEAM,
    audience: 'Shared',
  });
  const channels = page.getByRole('list', { name: 'Channels' });
  for (const label of ['Scout DM', 'team'])
    await expect(channels.getByRole('listitem', { name: label })).toContainText('Connected');
  // The DM carries a dozen messages a minute in this journey: above its default rate limit.
  const dmRow = channels.getByRole('listitem', { name: 'Scout DM' });
  await dmRow.getByRole('button', { name: 'Settings of Scout DM' }).click();
  const dmSettings = dmRow.getByRole('form', { name: 'Scout DM settings' });
  // The list refetches on channel events and the open form then starts over: fill again
  // until the edit holds.
  await expect(async () => {
    await dmSettings.getByLabel('Per minute').fill('30');
    await dmSettings.getByRole('button', { name: 'Save changes' }).click({ timeout: 1_000 });
    const { items } = await json<{ items: { label: string; rateLimit: { perMinute: number } }[] }>(
      await page.request.get(`${hub.url}/api/v1/channels`),
    );
    expect(items.find((b) => b.label === 'Scout DM')?.rateLimit.perMinute).toBe(30);
  }).toPass();
  // The Hub reaches Slack: a test message arrives in the channel.
  await channels.getByRole('button', { name: 'Send a test to team' }).click();
  await page
    .getByRole('dialog', { name: 'Send a test to team?' })
    .getByRole('button', { name: 'Send test' })
    .click();
  await slackPost(slack, TEAM, 'Nova is connected to this conversation.');

  return {
    /** The owner's direct message to the bot. */
    dm: (text: string) => slack.deliver(dmUrl, SLACK_SIGNING_SECRET, slack.dm(OWNER, DM, text)),
    /** The owner's message mentioning the bot in the team channel. */
    team: (text: string) =>
      slack.deliver(teamUrl, SLACK_SIGNING_SECRET, slack.mention(OWNER, TEAM, text)),
  };
}

test('J7: Slack DM and channel share memory, not private details; a rule asks and Slack answers', async ({
  page,
}, testInfo) => {
  const slack = await startMockSlack();
  try {
    hub = await setUpHub(page, portFor(testInfo.parallelIndex), { slackApi: slack.api });
    const agentId = await createAgent(page, hub, {
      name: AGENT,
      responsibility: 'Keep the team informed',
      proactive: false,
    });

    // 1. Connect the mock Slack: the owner's Slack identity, the owner's DM with the bot
    //    (private) and the team channel (shared), both answered by the agent.
    const { dm, team } = await connectSlack(page, slack);

    // 3. A DM and a shared channel message: two threads under the agent, with one memory. A note
    //    made in the DM is private; one made in the channel is shared. In the channel the agent
    //    reads only the shared note; in the DM it reads both.
    expect(await dm(call('agent.note', { content: 'My locker code is 4417' }))).toMatchObject({
      status: 200,
      body: { ok: true, status: 'started' },
    });
    await slackPost(slack, DM, 'Tool agent.note returned: Note saved');
    expect(
      (await team(call('agent.note', { content: 'The team offsite moved to Friday' }))).status,
    ).toBe(200);
    await slackPost(slack, TEAM, 'Tool agent.note returned: Note saved');
    await team(call('agent.notes', {}));
    const teamNotes = await slackPost(slack, TEAM, 'Tool agent.notes returned:');
    expect(teamNotes.text).toContain('The team offsite moved to Friday');
    expect(teamNotes.text).not.toContain('4417');
    await dm(call('agent.notes', {}));
    const dmNotes = await slackPost(slack, DM, 'Tool agent.notes returned:');
    expect(dmNotes.text).toContain('The team offsite moved to Friday');
    expect(dmNotes.text).toContain('My locker code is 4417');

    await page.goto(`${hub.url}/agents/${agentId}`);
    const threads = await openAgentTab(page, 'Threads');
    const list = threads.getByRole('list', { name: 'Agent threads' });
    await expect(list.getByRole('listitem', { name: 'Slack · Scout DM' })).toBeVisible();
    await expect(list.getByRole('listitem', { name: 'Slack · team' })).toBeVisible();
    await list.getByRole('button', { name: 'Show Slack · team' }).click();
    const teamLog = page.getByRole('log', { name: 'Slack · team messages' });
    await expect(teamLog).toContainText('The team offsite moved to Friday');
    await expect(
      page.getByText('Read-only here: answer in the channel. Shared with others in the channel.'),
    ).toBeVisible();
    await expectNoSeriousA11yIssues(page, 'agent page with a channel thread');

    // 4. Ask it (from the DM) to message the team channel. Rule "Post updates in #team" lets it
    //    post there; a stricter custom rule makes it ask first. Slack answers: deny, then allow
    //    once. Allowed, the message carries the DM's private detail, so the owner decides
    //    before it reaches the shared channel (FR-088): Do not share, then Share.
    const rules = await openAgentTab(page, 'Rules');
    const addRule = async (r: {
      text: string;
      effect: string;
      tools?: string;
      channel?: string;
      priority?: string;
    }) => {
      await rules.getByRole('button', { name: 'Add a rule' }).click();
      const form = rules.getByRole('form', { name: 'New rule' });
      await form.getByLabel('Rule', { exact: true }).fill(r.text);
      await form.getByRole('radio', { name: r.effect, exact: true }).check();
      if (r.tools) await form.getByLabel('Tools', { exact: true }).fill(r.tools);
      if (r.channel) {
        await form.getByRole('button', { name: 'Add a channel' }).click();
        await form.getByLabel('Channel 1', { exact: true }).selectOption({ label: 'Slack' });
        await form.getByLabel('Conversation for channel 1 (optional)').fill(r.channel);
      }
      if (r.priority) {
        await form.locator('summary', { hasText: 'Advanced' }).click();
        await form.getByLabel('Priority').fill(r.priority);
      }
      await form.getByRole('button', { name: 'Add rule' }).click();
      await expect(
        rules.getByRole('list', { name: 'Rules' }).getByRole('listitem', { name: r.text }),
      ).toBeVisible();
    };
    await addRule({
      text: 'Post updates in #team',
      effect: 'Take action without asking',
      channel: TEAM,
    });
    await addRule({
      text: 'Ask before sending channel messages',
      effect: 'Ask before taking action',
      tools: 'channel.send',
      priority: '10',
    });
    await expectNoSeriousA11yIssues(page, 'agent rules');
    const { items: ruleItems } = await json<{ items: { id: string; description: string }[] }>(
      await page.request.get(`${hub.url}/api/v1/agents/${agentId}/rules`),
    );
    const askRule = ruleItems.find((r) => r.description === 'Ask before sending channel messages')!;

    // A denied call is not asked again in the thread, so each request words it anew.
    const WORDING = ['Heads up', 'Reminder', 'For the record'];
    /** Ask for the send from the DM; returns the approval's code from the Slack prompt. */
    const askToSend = async (round: number) => {
      const before = slack.posts.length;
      const text = `${WORDING[round - 1]}: my locker code is 4417`;
      expect((await dm(call('channel.send', { channel: 'team', text }))).body).toMatchObject({
        status: 'started',
      });
      const prompt = await until(`approval prompt ${round} in the DM`, () =>
        Promise.resolve(
          slack.posts
            .slice(before)
            .find((p) => p.channel === DM && p.text.startsWith('Approval needed')) ?? null,
        ),
      );
      const code = /"deny ([0-9a-f]{6})"/.exec(prompt.text)?.[1];
      expect(prompt.text, 'the prompt offers answers in Slack').toMatch(
        /Reply "allow [0-9a-f]{6}"/,
      );
      expect(code).toBeTruthy();
      const { items } = await json<{ items: { tool: string; ruleId: string | null }[] }>(
        await page.request.get(`${hub.url}/api/v1/approvals?status=pending`),
      );
      expect(items.find((a) => a.tool === 'channel.send')?.ruleId).toContain(askRule.id);
      return code!;
    };
    const teamPosts = () =>
      slack.posts.filter((p) => p.channel === TEAM && p.text.includes('4417'));

    const deny = await askToSend(1);
    await dm(`deny ${deny}`);
    await slackPost(slack, DM, /^Denied\.$/);
    await slackPost(slack, DM, /Tool channel\.send returned: .*Denied/);
    expect(teamPosts()).toEqual([]);

    for (const choice of ['Do not share', 'Share'] as const) {
      const code = await askToSend(choice === 'Share' ? 3 : 2);
      await dm(`allow ${code}`);
      await slackPost(slack, DM, /^Allowed once\.$/);
      await page.goto(`${hub.url}/settings/channels`);
      const ask = page.getByRole('article').filter({ hasText: 'Share a private detail?' });
      // The DM's thread and its private note both hold the detail.
      await expect(ask).toContainText(
        'A reply in team, a shared channel, uses private information (2 sources). Share it there?',
      );
      if (choice === 'Share')
        await expectNoSeriousA11yIssues(page, 'settings/channels with a share question');
      await ask
        .getByRole('group', { name: 'Answers' })
        .getByRole('button', { name: choice, exact: true })
        .click();
      await expect(ask).toHaveCount(0);
      if (choice === 'Do not share') {
        await slackPost(slack, DM, /Tool channel\.send returned: .*not sent/);
        expect(teamPosts()).toEqual([]);
      }
    }
    await slackPost(slack, TEAM, 'For the record: my locker code is 4417');
    await slackPost(slack, DM, 'Tool channel.send returned: Sent to team.');
  } finally {
    await slack.stop();
  }
});

test('J7: a channel reply that would carry a DM detail waits for the owner (FR-088)', async ({
  page,
}, testInfo) => {
  const slack = await startMockSlack();
  try {
    hub = await setUpHub(page, portFor(testInfo.parallelIndex), { slackApi: slack.api });
    await createAgent(page, hub, { name: AGENT, proactive: false });
    const { dm, team } = await connectSlack(page, slack);
    await dm('My locker code is 4417');
    await slackPost(slack, DM, 'You said:');
    const { items } = await json<{ items: { label: string; threadId: string | null }[] }>(
      await page.request.get(`${hub.url}/api/v1/channels`),
    );
    const dmThread = items.find((b) => b.label === 'Scout DM')!.threadId!;
    // In the channel the agent reads the DM's session: its reply would quote the code.
    await team(call('sessions.read', { threadId: dmThread }));
    await page.goto(`${hub.url}/settings/channels`);
    const ask = page.getByRole('article').filter({ hasText: 'Share a private detail?' });
    await expect(ask).toContainText('A reply in team, a shared channel, uses private information');
    expect(slack.posts.filter((p) => p.channel === TEAM && p.text.includes('4417'))).toEqual([]);
    await ask
      .getByRole('group', { name: 'Answers' })
      .getByRole('button', { name: 'Do not share' })
      .click();
    await slackPost(slack, TEAM, "I can't share that here.");
    expect(slack.posts.filter((p) => p.channel === TEAM && p.text.includes('4417'))).toEqual([]);
  } finally {
    await slack.stop();
  }
});

// ---- the connected device and the agent's computer ---------------------------------------------

/** A project on the "device" (this process's disk, where the fake novad serves files). */
function deviceProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'nova-e2e-device-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src', 'notes.md'), '# Notes\n\nfirst\n');
  return root;
}

test('J7: staged writes on the connected device; taking over the agent computer is audited', async ({
  page,
}, testInfo) => {
  hub = await setUpHub(page, portFor(testInfo.parallelIndex));
  await useCloudComputers(page, hub);
  const agentId = await createAgent(page, hub, {
    name: AGENT,
    responsibility: 'Keep the project notes current',
    proactive: false,
  });
  const project = deviceProject();
  const notes = join(project, 'src', 'notes.md');
  const plan = join(project, 'docs', 'plan.md');

  // 7. Add the mock device (a fake novad) from the Devices page, connect the agent to it and
  //    share the project's src folder with the agent, read and change.
  await page.goto(`${hub.url}/devices`);
  await page.getByRole('button', { name: 'Add device' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add a device' })).toBeVisible();
  // The scripted path: a one-use command instead of a code (M6.5 made the code the default).
  await page.getByRole('link', { name: 'Use a one-use command instead' }).click();
  const client = page.getByRole('checkbox', { name: 'Client' });
  if (!(await client.isChecked())) await client.check();
  await page.getByRole('button', { name: 'Create command' }).click();
  const command = await page
    .getByRole('region', { name: 'Enrollment command' })
    .locator('code')
    .textContent();
  const token = /--token (\S+)/.exec(command ?? '')?.[1];
  expect(token, command ?? '').toBeTruthy();
  const device = new FakeDevice({ name: 'Laptop' });
  await device.enroll(hub.url, token!);
  // novad heartbeats; the Hub marks a silent device offline after 30 s.
  const beat = setInterval(() => void device.heartbeat().catch(() => undefined), 5_000);
  try {
    await expect(page.getByRole('heading', { level: 1, name: 'Laptop is added' })).toBeVisible({
      timeout: 20_000,
    });
    await expectNoSeriousA11yIssues(page, 'device added');
    await page.getByRole('button', { name: 'Open Laptop' }).click();
    const sections = page.getByRole('tablist', { name: 'Device sections' });
    await sections.getByRole('tab', { name: 'Agents' }).click();
    await page.getByRole('button', { name: 'Connect an agent' }).click();
    const connect = page.getByRole('dialog', { name: 'Connect an agent to Laptop' });
    await connect.getByLabel('Agent', { exact: true }).selectOption({ label: AGENT });
    await expect(connect.getByRole('checkbox', { name: 'Staged writes' })).toBeChecked();
    await connect.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByRole('list', { name: 'Connected agents' })).toContainText(AGENT);
    await sections.getByRole('tab', { name: 'Files' }).click();
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const share = page.getByRole('dialog', { name: 'Share on Laptop' });
    await share.getByLabel('With').selectOption({ label: 'Agent' });
    await share.getByLabel('Agent', { exact: true }).selectOption({ label: AGENT });
    await share.getByLabel('What').selectOption({ label: 'A folder' });
    await share.getByLabel('Folder', { exact: true }).fill(join(project, 'src'));
    await share
      .getByLabel('Access')
      .selectOption({ label: 'Read and change (changes are staged for review)' });
    await share.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Grants' })).toContainText(join(project, 'src'));

    const filesPage = page.url();

    //    In its conversation the agent stages a write with its device tool: it waits as a diff,
    //    nothing on disk until the owner commits it on the device page.
    await page.goto(`${hub.url}/agents/${agentId}`);
    const scout = agentRegion(page, AGENT);
    await send(
      scout,
      call('device.files.stage_write', { path: notes, content: '# Notes\n\nsecond\n' }),
    );
    await expect(messages(scout)).toContainText(
      `Tool device.files.stage_write returned: Staged a write to ${notes} on Laptop`,
    );
    expect(readFileSync(notes, 'utf8')).toBe('# Notes\n\nfirst\n');
    await expectNoSeriousA11yIssues(page, 'agent conversation with a staged device write');
    await page.goto(filesPage);
    const writes = page.getByRole('list', { name: 'Staged writes' });
    await writes.getByRole('button', { name: `Review ${notes}` }).click();
    const diff = page.getByLabel(`Changes to ${notes}`);
    await expect(diff).toContainText('Removed: first');
    await expect(diff).toContainText('Added: second');
    expect(readFileSync(notes, 'utf8')).toBe('# Notes\n\nfirst\n');
    await expectNoSeriousA11yIssues(page, 'device staged write');
    await page.getByRole('button', { name: 'Commit', exact: true }).click();
    await expect(toast(page, `Written to ${notes}.`)).toBeVisible();
    expect(readFileSync(notes, 'utf8')).toBe('# Notes\n\nsecond\n');

    //    A write outside the shared folder writes nothing and asks for folder access; once the
    //    owner allows it on the device page, the agent stages it again and commits it, which the
    //    owner approves in the conversation.
    await page.goto(`${hub.url}/agents/${agentId}`);
    await send(scout, call('device.files.stage_write', { path: plan, content: 'plan\n' }));
    await expect(messages(scout)).toContainText(
      `Tool device.files.stage_write returned: Error (folder_access_required): ${join(project, 'docs')} on Laptop is outside the folders shared with you.`,
    );
    expect(existsSync(plan)).toBe(false);
    await page.goto(filesPage);
    const requests = page.getByRole('list', { name: 'Access requests' });
    const request = requests.getByRole('listitem', {
      name: `Agent ${AGENT} asks for ${join(project, 'docs')}`,
    });
    await expect(request).toContainText('a write outside the granted folders');
    await expectNoSeriousA11yIssues(page, 'device access request');
    await request
      .getByRole('button', {
        name: `Allow Agent ${AGENT} to read and change ${join(project, 'docs')}`,
      })
      .click();
    await until('the folder access is granted', async () => {
      const { items } = await json<{ items: { status: string; target: string }[] }>(
        await page.request.get(`${hub.url}/api/v1/devices/${device.deviceId}/grants`),
      );
      return items.some((g) => g.status === 'granted' && g.target === join(project, 'docs'));
    });
    await page.goto(`${hub.url}/agents/${agentId}`);
    await send(scout, call('device.files.stage_write', { path: plan, content: 'plan\n' }));
    await expect(messages(scout)).toContainText(
      `Tool device.files.stage_write returned: Staged a write to ${plan} on Laptop`,
    );
    const { items: staged } = await json<{ items: { id: string; path: string }[] }>(
      await page.request.get(`${hub.url}/api/v1/devices/${device.deviceId}/staged?status=staged`),
    );
    const stagedId = staged.find((w) => w.path === plan)?.id;
    expect(stagedId, JSON.stringify(staged)).toBeTruthy();
    await send(scout, call('device.files.commit', { stagedId }));
    await decide(scout, 'device.files.commit', 'Allow once');
    await expect(messages(scout)).toContainText(
      `Tool device.files.commit returned: Wrote ${plan} on Laptop`,
    );
    expect(readFileSync(plan, 'utf8')).toBe('plan\n');
  } finally {
    clearInterval(beat);
    await device.close();
  }

  // 8. Open the agent's computer from its page; take over the desktop, return control; the
  //    takeover is in the audit log, which verifies.
  await page.goto(`${hub.url}/agents/${agentId}`);
  const computerTab = await openAgentTab(page, 'Computer');
  await computerTab.getByRole('link', { name: 'Open the computer' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `${AGENT}'s computer` })).toBeVisible();
  const screen = page.getByRole('region', { name: 'Computer use' });
  await screen.getByRole('button', { name: 'Take over' }).click();
  const takeover = screen.getByRole('group', { name: 'Takeover' });
  await expect(takeover).toContainText('You have control.');
  await expectNoSeriousA11yIssues(page, 'computer page during a takeover');
  await takeover.getByRole('button', { name: 'Return control' }).click();
  await expect(toast(page, 'Control returned to Nova.')).toBeVisible();
  await expect(takeover).toHaveCount(0);

  await page.goto(`${hub.url}/settings/diagnostics`);
  const entries = page.getByRole('list', { name: 'Audit entries' });
  await expect(
    entries.getByRole('listitem', { name: 'computer: computer.takeover.started' }),
  ).toBeVisible();
  await expect(
    entries.getByRole('listitem', { name: 'computer: computer.takeover.ended' }),
  ).toContainText('Result: returned');
  await expect(
    entries.getByRole('listitem', { name: 'device: device.write.commit' }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(page.getByText(/The audit log is intact/)).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'settings/diagnostics audit log');
});
