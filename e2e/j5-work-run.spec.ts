// J5 — Work run (docs/18 §3, M5 exit criteria in docs/17): a run from the New run dialog with a
// goal and budgets that shows its plan, makes tool calls with approvals, pauses at a budget until
// the user extends it, and ends with its artifacts previewed, a replayable Activity trace and a
// daily schedule made from it; a scheduled run whose declared output is missing ends Output
// missing with its trace linked; an Ask first run that waits with its plan until Approve and
// start; a chat that hands multi-step work to an inline run card; and a deep research run with
// sub-agents and a cited report. The offline Mock provider drives every
// call with `/tool <name> <json>` lines (packages/providers mock): a run's first turn text is its
// objective, so the objective carries the calls.
//
// What a browser test cannot wait for, and where it is covered instead:
// - The New run dialog takes no attachments, so "the attached report" is a workspace file the run
//   reads with fs.read. Both artifact tools (artifact.create, document.create) ask in the default
//   policy, so the run waits for two approvals, one after the other.
// - The 10-minute time budget is set in the dialog, but a real clock cannot wait 10 minutes. The
//   run gets the smallest token budget the API allows (1,000), and the objective is long enough
//   that the Mock's first model step uses more than that, so the run pauses at the next step with
//   "Budget reached" until Extend. The 10-minute case under a simulated clock is
//   packages/core/test/runs-budgets.test.ts ("pauses at 10 minutes with a summary; nothing runs
//   until the user extends it").
// - The sidebar chip goes Running → Needs input → Running between approvals faster than the
//   sidebar refreshes: the journey sees Needs input there while an approval waits, and reads the
//   whole sequence from the thread's `thread.status.changed` events, which drive the chip.
// - A webhook that accepts a delivery but sends no receipt needs a public HTTPS endpoint: the
//   webhook refuses private and loopback addresses by design. The journey covers Output missing
//   with a declared artifact the scheduled run does not save; the missing receipt is
//   packages/core/test/scheduler-service.test.ts ("ends output_missing when the channel accepts
//   but returns no receipt (J5 step 5)").
// - Web tools are offline, so the deep research run's researchers read the fixture corpus with
//   fs.read; the Mock writes the cited report, the run verifies it was saved.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoSeriousA11yIssues } from './support/a11y.ts';
import { startHub, type RunningHub } from './support/hub.ts';

const portFor = (parallelIndex: number) => 7571 + parallelIndex;
let hub: RunningHub;

test.use({ colorScheme: 'light' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

test.afterEach(async () => {
  await hub?.stop();
});

/** One `/tool` line of the Mock's script. */
const call = (name: string, args: unknown) => `/tool ${name} ${JSON.stringify(args)}`;

const REPORT_SUMMARY = '# Report summary\n\nRevenue grew 12 percent while costs fell.';
/** Long enough that the first model step alone uses more than a 1,000-token budget. */
const BACKGROUND = `Background: ${'The quarterly report covers revenue, costs and the outlook for every region. '.repeat(30)}`;
const SUMMARY_OBJECTIVE = [
  'Summarize the attached report and save a Markdown artifact and a DOCX copy.',
  BACKGROUND.trim(),
  call('plan.set', {
    steps: [{ title: 'Read the report' }, { title: 'Write the summary' }, { title: 'Save it' }],
  }),
  call('fs.read', { path: 'report.md' }),
  call('artifact.create', { kind: 'markdown', title: 'Report summary', content: REPORT_SUMMARY }),
  call('document.create', {
    kind: 'docx',
    title: 'Report summary',
    content: {
      blocks: [
        { type: 'heading', level: 1, text: 'Report summary' },
        { type: 'paragraph', text: 'Revenue grew 12 percent while costs fell.' },
      ],
    },
  }),
  call('plan.update', { idx: 0, status: 'done' }),
  call('plan.update', { idx: 1, status: 'done' }),
  call('plan.update', { idx: 2, status: 'done' }),
  call('goal.update', { status: 'complete', progressNote: 'Summary saved as Markdown and DOCX.' }),
  call('run.complete', {
    summary: 'Saved the report summary as Markdown and as a DOCX copy.',
    evidence: ['Read report.md'],
  }),
].join('\n');

const REPORT = [
  '# Renewables report',
  '',
  'Solar capacity doubled since 2020 [1]. Offshore wind grew 30 percent [2].',
  '',
  '## Sources',
  '',
  '1. Solar notes, corpus/solar.md',
  '2. Wind notes, corpus/wind.md',
].join('\n');
const RESEARCH_OBJECTIVE = [
  'Which renewable sources grew fastest? Use the fixture corpus.',
  call('plan.set', {
    steps: [
      { title: 'How fast did solar grow?' },
      { title: 'How fast did wind grow?' },
      { title: 'Write the cited report' },
    ],
  }),
  ...['solar', 'wind'].map((topic) =>
    call('task.spawn', {
      role: 'researcher',
      objective: `How fast did ${topic} grow?\n${call('fs.read', { path: `corpus/${topic}.md` })}`,
      tools: ['fs.read', 'fs.list', 'fs.search'],
    }),
  ),
  call('plan.update', { idx: 0, status: 'done' }),
  call('plan.update', { idx: 1, status: 'done' }),
  call('artifact.create', { kind: 'markdown', title: 'Renewables report', content: REPORT }),
  call('plan.update', { idx: 2, status: 'done' }),
  call('run.complete', { summary: 'Solar grew fastest; the cited report is saved.' }),
].join('\n');

async function setUp(page: Page, parallelIndex: number) {
  hub = await startHub({ port: portFor(parallelIndex) });
  const workspace = join(hub.dataDir, 'workspace');
  mkdirSync(join(workspace, 'corpus'), { recursive: true });
  writeFileSync(join(workspace, 'report.md'), '# Q3 report\n\nRevenue grew 12 percent.\n');
  writeFileSync(join(workspace, 'corpus', 'solar.md'), '# Solar\n\nCapacity doubled since 2020.\n');
  writeFileSync(join(workspace, 'corpus', 'wind.md'), '# Wind\n\nOffshore wind grew 30 percent.\n');
  await page.goto(`${hub.url}/#setup=${hub.setupCode}`);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByRole('button', { name: 'Skip setup' }).click();
}

interface RunJson {
  id: string;
  threadId: string;
  status: string;
  pauseReason: string | null;
  used: { tokens: number };
}

async function getRun(page: Page, id: string): Promise<RunJson> {
  const res = await page.request.get(`${hub.url}/api/v1/runs/${id}`);
  return (await res.json()) as RunJson;
}

const runIdOf = (page: Page) => /\/work\/([^/?#]+)$/.exec(page.url())?.[1] ?? '';

/** The New run dialog, filled and started. */
async function startRun(
  page: Page,
  f: {
    objective: string;
    title: string;
    template?: string;
    autonomy?: string;
    minutes?: string;
    tokens?: string;
  },
  extra?: (dialog: Locator) => Promise<void>,
) {
  await page.goto(`${hub.url}/work`);
  await page.getByRole('button', { name: 'New run', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New run' });
  await dialog.getByLabel('What should the run do?').fill(f.objective);
  await dialog.getByLabel('Title (optional)').fill(f.title);
  if (f.template) await dialog.getByRole('radio', { name: f.template, exact: true }).check();
  await dialog.getByRole('radio', { name: f.autonomy ?? 'Standard', exact: true }).check();
  if (f.minutes) await dialog.getByLabel('Time (minutes)').fill(f.minutes);
  if (f.tokens) await dialog.getByLabel('Tokens').fill(f.tokens);
  await extra?.(dialog);
  await dialog.getByRole('button', { name: 'Start run' }).click();
  await expect(page).toHaveURL(/\/work\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1, name: f.title })).toBeVisible();
}

test('J5: plan, approvals, budget pause and Extend, result, trace, schedules', async ({
  page,
}, testInfo) => {
  await setUp(page, testInfo.parallelIndex);
  await page.goto(`${hub.url}/work`);
  await expect(page.getByRole('heading', { level: 1, name: 'Work' })).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'work list');

  // 1. New run: the objective, a goal, a 10-minute time budget and a 1,000-token budget, and a
  //    declared artifact output.
  await startRun(
    page,
    {
      objective: SUMMARY_OBJECTIVE,
      title: 'Quarterly summary',
      minutes: '10',
      tokens: '1000',
    },
    async (dialog) => {
      await dialog.locator('summary', { hasText: 'Goal and expected output' }).click();
      await dialog.getByLabel('Goal', { exact: true }).fill('A short summary of the Q3 report');
      await dialog.getByLabel('Expected output').selectOption('artifact');
      await dialog.getByLabel('Output name or path (optional)').fill('Report summary');
      await expectNoSeriousA11yIssues(page, 'New run dialog');
    },
  );
  const runId = runIdOf(page);
  const run = await getRun(page, runId);

  // 2. The plan appears (Standard autonomy shows it and starts); tool calls run; the artifact
  //    tools ask. The sidebar's run chip says Needs input while an approval waits.
  const plan = page.getByRole('list', { name: 'Plan steps' });
  await expect(plan.getByRole('listitem')).toHaveCount(3);
  await expect(plan).toContainText('Read the report');
  await expect(page.getByText('Autonomy: Standard')).toBeVisible();
  const goal = page.getByRole('region', { name: 'Goal' });
  await expect(goal).toContainText('A short summary of the Q3 report');
  const conversation = page.getByRole('log', { name: 'Run conversation' });
  const approval = conversation.getByRole('group', { name: /Approval needed/ });
  const sidebarRun = page
    .getByRole('list', { name: 'Active runs' })
    .getByRole('link', { name: /Quarterly summary/ });
  for (const [i, tool] of ['artifact.create', 'document.create'].entries()) {
    const card = approval.filter({ hasText: tool });
    await expect(card).toBeVisible();
    await expect(sidebarRun).toContainText('Needs input');
    if (i === 0) await expectNoSeriousA11yIssues(page, 'run page with an approval');
    await card.getByRole('button', { name: 'Allow once', exact: true }).click();
  }
  for (const tool of ['Set the run plan', 'Read a file', 'Create a document', 'Report the result'])
    await expect(conversation.getByRole('group', { name: `Tool call: ${tool}` })).toContainText(
      'Done',
    );

  // 3. The first model step used the token budget: the run pauses with "Budget reached", offers
  //    Extend, sends a progress summary, and nothing runs until the user extends it.
  const banner = page.getByRole('region', { name: /^Budget reached: tokens/ });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Nothing runs until you extend the budget.');
  await expect(page.getByRole('heading', { level: 1, name: 'Quarterly summary' })).toBeVisible();
  await expect(sidebarRun).toContainText('Blocked: Budget reached');
  const paused = await getRun(page, runId);
  expect(paused).toMatchObject({ status: 'paused', pauseReason: 'budget_tokens' });
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const budgetNote = page
    .getByRole('list', { name: 'Notifications' })
    .getByRole('listitem', { name: 'Budget reached' });
  await expect(budgetNote).toContainText('Paused (budget reached) after 1 model steps.');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2_000);
  expect(await getRun(page, runId)).toMatchObject({
    status: 'paused',
    used: { tokens: paused.used.tokens },
  });
  await expectNoSeriousA11yIssues(page, 'run page at a budget');
  await banner.getByRole('button', { name: 'Extend 1M tokens' }).click();

  // 4. The run finishes: the result card shows both artifacts with previews, the chip is Ready,
  //    the Activity trace replays, and "Schedule it" makes a daily schedule from the run.
  const result = page.getByRole('region', { name: 'Result' });
  await expect(result).toContainText('Done', { timeout: 30_000 });
  await expect(result).toContainText('Saved the report summary as Markdown and as a DOCX copy.');
  await expect(page.locator('.work-run-header .nv-chip')).toHaveText('Ready');
  const markdown = result.getByRole('article', { name: 'Report summary', exact: true });
  await expect(markdown).toContainText('Revenue grew 12 percent while costs fell.');
  const docx = result.getByRole('article', { name: 'Report summary.docx', exact: true });
  await expect(docx).toContainText('Document (DOCX)');
  await expect(docx).toContainText('Revenue grew 12 percent while costs fell.');
  await expect(result).toContainText(/artifact \S+ saved/);
  await expect(page.getByRole('region', { name: 'Plan' })).toContainText('3 of 3 steps done');
  await expect(page.getByRole('list', { name: 'Active runs' })).toHaveCount(0);

  // The thread's status went Running → Needs input → Running → Blocked → Running → Ready.
  const statuses = await threadStatuses(page, run.threadId);
  const sequence = ['running', 'needs_input', 'running', 'blocked', 'running', 'ready'];
  expect(subsequence(statuses, sequence), statuses.join(' → ')).toBe(true);

  const trace = page.getByRole('list', { name: 'Activity trace' });
  await expect(trace).toContainText('artifact.create');
  await page.getByRole('button', { name: 'Replay' }).click();
  const replay = page.getByRole('group', { name: 'Replay' });
  const step = replay.getByRole('status');
  await expect(step).toContainText(/^Step 1 of \d+/);
  await replay.getByRole('button', { name: /Next step/ }).click();
  await expect(step).toContainText(/^Step 2 of \d+/);
  await expect(trace.getByRole('listitem')).toHaveCount(2);
  await replay.getByRole('button', { name: 'Exit replay' }).click();
  await expectNoSeriousA11yIssues(page, 'finished run page');

  await result.getByRole('button', { name: 'Schedule it' }).click();
  await expect(page).toHaveURL(/\/work\/scheduled$/);
  const fromRun = page.getByRole('dialog', { name: 'New schedule' });
  await expect(fromRun.getByLabel('Title (optional)')).toHaveValue('Quarterly summary');
  await expect(fromRun.getByLabel('Instructions', { exact: true })).toHaveValue(SUMMARY_OBJECTIVE);
  await expect(fromRun.getByLabel('Repeat')).toHaveValue('daily');
  await fromRun.getByLabel('Time', { exact: true }).fill(farFromNow());
  await expectNoSeriousA11yIssues(page, 'New schedule dialog');
  await fromRun.getByRole('button', { name: 'Create schedule' }).click();
  const schedules = page.getByRole('list', { name: 'Schedules' });
  await expect(schedules.getByRole('listitem', { name: 'Quarterly summary' })).toContainText(
    /Every day at \d\d:\d\d/,
  );

  // 5. A scheduled run that does not save its declared output ends Output missing, with the run
  //    and its trace linked from the schedule's history. Fired with Run now.
  await page.getByRole('button', { name: 'New schedule' }).click();
  const digest = page.getByRole('dialog', { name: 'New schedule' });
  await digest.getByLabel('Title (optional)').fill('Weekly digest');
  await digest
    .getByLabel('Instructions', { exact: true })
    .fill(`Check the corpus for news.\n${call('fs.read', { path: 'corpus/solar.md' })}`);
  await digest.getByLabel('Repeat').selectOption('weekly');
  await digest.getByLabel('Time', { exact: true }).fill(farFromNow());
  await digest.getByLabel('Expected output').selectOption('artifact');
  await digest.getByLabel('Output name or path (optional)').fill('Weekly digest');
  await digest.getByRole('button', { name: 'Create schedule' }).click();
  const row = schedules.getByRole('listitem', { name: 'Weekly digest' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Run now: Weekly digest' }).click();
  await row.getByRole('button', { name: 'History of Weekly digest' }).click();
  const fire = row.locator('.work-fire').first();
  await expect(fire).toContainText('Output missing', { timeout: 30_000 });
  await expect(row).toContainText('Last outcome: Output missing');
  await expectNoSeriousA11yIssues(page, 'scheduled with history');
  await fire.getByRole('link', { name: 'Open run and its trace' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Weekly digest' })).toBeVisible();
  const missing = page.getByRole('region', { name: 'Result' });
  await expect(missing).toContainText('Output missing: the run could not verify its artifact');
  await expect(missing).toContainText('(Weekly digest)');
  await expect(page.getByText('Started by a schedule')).toBeVisible();
  await missing.getByRole('link', { name: 'See the trace' }).click();
  await expect(page.getByRole('region', { name: 'Activity' })).toBeFocused();
  await expect(page.getByRole('list', { name: 'Activity trace' })).toContainText('fs.read');
});

test('J5: an Ask first plan, a run proposed in a chat, a cited deep research report', async ({
  page,
}, testInfo) => {
  await setUp(page, testInfo.parallelIndex);

  // 2 (Ask first). The run proposes its plan and waits, Needs input, until Approve and start.
  await startRun(page, {
    objective: `Tidy the notes folder.\n${call('plan.set', { steps: [{ title: 'List the notes' }, { title: 'Group them by topic' }] })}`,
    title: 'Tidy notes',
    autonomy: 'Ask first',
  });
  const askFirst = page.getByRole('region', { name: 'Plan' });
  await expect(askFirst).toContainText('Review the plan, then start the run.');
  await expect(askFirst.getByRole('list', { name: 'Plan steps' })).toContainText('List the notes');
  await expect(page.locator('.work-run-header .nv-chip')).toHaveText(
    'Needs input: Plan ready for review',
  );
  await askFirst.getByRole('button', { name: 'Approve and start' }).click();
  await expect(page.getByRole('region', { name: 'Result' })).toContainText('Done', {
    timeout: 30_000,
  });
  await expect(page.getByRole('log', { name: 'Run conversation' })).toContainText(
    'The plan is approved. Carry it out now.',
  );

  // 6. A chat asks for multi-step work: the Mock calls work.start, the chat shows a proposed run
  //    card; Start run; the run completes inside the chat and is listed under Work.
  await page.goto(`${hub.url}/chat`);
  await page
    .getByRole('button', { name: /New chat/ })
    .first()
    .click();
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill(
    call('work.start', {
      title: 'Trip checklist',
      objective: `Draft the packing checklist for the trip.\n${call('run.complete', { summary: 'Checklist drafted: passport, charger, tickets.' })}`,
      plan: [{ title: 'List the essentials' }, { title: 'Write the checklist' }],
    }),
  );
  await box.press('Enter');
  const messages = page.getByLabel('Messages', { exact: true });
  const card = messages.getByRole('group', { name: /Work run: Trip checklist/ });
  await expect(card).toContainText('This needs several steps. Run it as a Work run?');
  await expect(card.getByRole('list', { name: 'Plan' })).toContainText('List the essentials');
  await expectNoSeriousA11yIssues(page, 'chat with a proposed run card');
  await card.getByRole('button', { name: 'Start run' }).click();
  await expect(card).toContainText('Done.', { timeout: 30_000 });
  await expect(card).toContainText('Checklist drafted: passport, charger, tickets.');
  await card.getByRole('link', { name: /Open in Work/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trip checklist' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Started from a chat' })).toBeVisible();
  await page.goto(`${hub.url}/work`);
  await expect(page.getByRole('list', { name: 'Runs' })).toContainText('Trip checklist');

  // 7. Deep research on the fixture corpus: sub-questions as the plan, read-only researcher
  //    sub-agents, and a report with bracketed citations and a source list, verified as saved.
  await startRun(page, {
    objective: RESEARCH_OBJECTIVE,
    title: 'Renewables research',
    template: 'Deep research',
  });
  const plan = page.getByRole('list', { name: 'Plan steps' });
  await expect(plan).toContainText('How fast did wind grow?');
  const subagents = page.getByRole('list', { name: 'Sub-agents' });
  await expect(subagents.getByRole('listitem')).toHaveCount(2);
  for (const topic of ['solar', 'wind'])
    await expect(
      subagents.getByRole('listitem', { name: new RegExp(`^researcher: How fast did ${topic}`) }),
    ).toContainText('Done');
  const approval = page
    .getByRole('log', { name: 'Run conversation' })
    .getByRole('group', { name: /Approval needed/ });
  await expect(approval).toContainText('artifact.create');
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
  const result = page.getByRole('region', { name: 'Result' });
  await expect(result).toContainText('Done', { timeout: 30_000 });
  const report = result.getByRole('article', { name: 'Renewables report' });
  await expect(report).toContainText('Solar capacity doubled since 2020 [1].');
  await expect(report.getByRole('heading', { name: 'Sources' })).toBeVisible();
  await expect(report).toContainText('corpus/wind.md');
  await expect(result).toContainText(/artifact \S+ saved/);
  await expect(page.getByRole('region', { name: 'Plan' })).toContainText('3 of 3 steps done');
  await expectNoSeriousA11yIssues(page, 'deep research run');
});

/** The statuses a thread went through, from its `thread.status.changed` events. */
async function threadStatuses(page: Page, threadId: string): Promise<string[]> {
  const out: string[] = [];
  let after: string | null = null;
  for (;;) {
    const q: string = after ? `&after=${after}` : '';
    const res = await page.request.get(`${hub.url}/api/v1/events?limit=500${q}`);
    const { events } = (await res.json()) as {
      events: { id: string; name: string; payload: { ref?: { id?: string }; status?: string } }[];
    };
    for (const e of events)
      if (e.name === 'thread.status.changed' && e.payload.ref?.id === threadId && e.payload.status)
        out.push(e.payload.status);
    if (events.length < 500) return out;
    after = events.at(-1)!.id;
  }
}

/** Whether `want` appears in `list` in order (other items may come between). */
function subsequence(list: readonly string[], want: readonly string[]): boolean {
  let i = 0;
  for (const s of list) if (s === want[i]) i++;
  return i === want.length;
}

/** A time of day twelve hours from now, so a daily schedule cannot fire during the journey. */
function farFromNow(): string {
  const d = new Date(Date.now() + 12 * 3_600_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
