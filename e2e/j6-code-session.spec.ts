// J6 — Code session (docs/18 §3, M5 exit criteria in docs/17): a session in Accept edits mode on a
// fixture Git repository (built at runtime, e2e/support/fixture-repo.ts) fixes a failing test by
// editing two files, which show as reviewable hunks; the repository's instruction file is read
// within its budget; writes to `.git` and `.nova` are denied as protected paths with no approval
// offered; an interactive exec session is started, polled, written to and killed; the
// repository's Git hooks never run for Nova's status, diff, worktree or commit operations; a
// diff comment sent to the agent makes it revise; tests run; and the commit lands on a new
// `nova/…` branch, never on the default branch. The offline Mock provider drives every call with
// `/tool <name> <json>` lines (packages/providers mock).
//
// What this environment cannot show, and where it is covered instead:
// - Commands run in the Hub's container sandbox. The Playwright container has no container
//   runtime, so `exec.run` and `test.run` fail closed there with "no sandbox", while CI runners
//   have one: the journey asserts whichever the Hub reports (GET /diagnostics), like J4. With a
//   sandbox it checks the session id after the yield time, exec.poll, exec.write and Kill. The
//   sandbox image has no Node, so `test.run` (npm test) reports a failed run there; the journey
//   checks that it ran and proves the fix with the suite itself (`node --test` in this process).
//   Session lifecycles are also packages/core/test/exec-sessions.test.ts.
// - The instruction file is in the system context, which the Mock does not echo. The file is
//   longer than the 32 KiB budget, so the reply carries Nova's "truncated" notice, which shows it
//   was found and read within the budget; root-to-working-folder order across nested files is
//   packages/core/test/context-instructions.test.ts.
// - Commit hooks run only inside a sandbox that has Git (docs/10 §8); the sandbox image has none,
//   so in both environments the Hub commits with hooks off and the dialog says so.
// - The pull request step (a mock Git host and its CI status) is not part of M5.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoSeriousA11yIssues } from './support/a11y.ts';
import { createFixtureRepo, type FixtureRepo } from './support/fixture-repo.ts';
import { startHub, type RunningHub } from './support/hub.ts';

const portFor = (parallelIndex: number) => 7581 + parallelIndex;
let hub: RunningHub;

test.use({ colorScheme: 'light' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

test.afterEach(async () => {
  await hub?.stop();
});

/** One `/tool` line of the Mock's script. */
const call = (name: string, args: unknown) => `/tool ${name} ${JSON.stringify(args)}`;
/** A Nova patch (docs/08 §1.3) that updates one file. */
const patch = (path: string, lines: string[]) => ({
  patch: ['%%% patch', `%%% update ${path}`, '@@', ...lines, '%%% end'].join('\n'),
});

const FIX = [
  'Fix the failing test.',
  call('fs.edit', patch('src/math.js', ['-  return a - b;', '+  return a + b;'])),
  call('fs.edit', patch('src/label.js', ["-  return n + ' item';", "+  return n + ' items';"])),
].join('\n');
/** A review comment: the user's words, then the line the Mock acts on. */
const COMMENT = [
  'Name the parameters for what they are.',
  call(
    'fs.edit',
    patch('src/math.js', [
      '-export function add(a, b) {',
      '-  return a + b;',
      '+export function add(left, right) {',
      '+  return left + right;',
    ]),
  ),
].join('\n');
/** Prints a line, then echoes each line of input: a long-running command to drive. */
const ECHO = 'echo ready; while read line; do echo "got $line"; done';

async function send(session: Locator, text: string) {
  const box = session.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill(text);
  await box.press('Enter');
}

async function allowOnce(messages: Locator, tool: string) {
  const card = messages.getByRole('group', { name: /Approval needed/ }).filter({ hasText: tool });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(card).toHaveCount(0);
}

async function sandboxAvailable(page: Page): Promise<boolean> {
  const res = await page.request.get(`${hub.url}/api/v1/diagnostics`);
  return ((await res.json()) as { sandbox: { available: boolean } }).sandbox.available;
}

/** The hooks that ran so far (none, as long as Nova never runs them). */
const hooksRan = (fx: FixtureRepo) =>
  existsSync(fx.marker) ? readFileSync(fx.marker, 'utf8') : '';

async function newSession(
  page: Page,
  f: { folder: string; title: string; mode?: string; worktree?: boolean },
) {
  await page.goto(`${hub.url}/code`);
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Code session' });
  await dialog.getByLabel('Folder path on the Hub').fill(f.folder);
  if (f.mode) await dialog.getByLabel('Permission mode').selectOption(f.mode);
  await dialog.getByLabel('Title (optional)').fill(f.title);
  if (f.worktree)
    await dialog.getByRole('checkbox', { name: 'Work in a new Git worktree' }).check();
  return dialog;
}

test('J6: Code session edits, protected paths, exec, hooks, comments, tests, commit', async ({
  page,
}, testInfo) => {
  const fx = createFixtureRepo();
  expect(fx.testsPass(), 'the fixture starts with a failing test').toBe(false);
  hub = await startHub({ port: portFor(testInfo.parallelIndex) });
  await page.goto(`${hub.url}/#setup=${hub.setupCode}`);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByRole('button', { name: 'Skip setup' }).click();
  // exec.run hands back a session id after one second instead of ten (FR-184).
  const yieldSetting = await page.request.patch(`${hub.url}/api/v1/settings`, {
    data: { key: 'exec.sessions', value: { yieldMs: 1000, outputTokens: 10_000 } },
  });
  expect(yieldSetting.ok()).toBe(true);
  const sandbox = await sandboxAvailable(page);
  testInfo.annotations.push({ type: 'sandbox', description: sandbox ? 'available' : 'none' });

  // 1. A new session in the fixture repository, in Accept edits mode.
  await page.goto(`${hub.url}/code`);
  await expect(page.getByRole('heading', { level: 1, name: 'Code' })).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'code sessions');
  const dialog = await newSession(page, {
    folder: fx.repo,
    title: 'Calc fix',
    mode: 'accept_edits',
  });
  await expect(
    dialog.getByText('File edits in the project are made and shown as diffs.'),
  ).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'New Code session dialog');
  await dialog.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/code\/[^/]+$/);
  const sessionId = /\/code\/([^/?#]+)$/.exec(page.url())?.[1] ?? '';
  const session = page.getByRole('region', { name: 'Code session: Calc fix' });
  await expect(session.getByRole('heading', { level: 1, name: 'Calc fix' })).toBeVisible();
  await expect(session.locator('.code-header-meta')).toContainText('main');
  await expect(session.getByLabel('Permission mode')).toHaveValue('accept_edits');
  const view = (await (
    await page.request.get(`${hub.url}/api/v1/code/sessions/${sessionId}`)
  ).json()) as {
    threadId: string;
  };

  // 2. Ask to fix the failing test: two files are edited without asking (Accept edits) and show
  //    as hunks in the Diff pane. The instruction file was read, within its budget.
  const messages = session.getByLabel('Messages', { exact: true });
  await send(session, FIX);
  await expect(messages).toContainText(
    'Tool fs.edit returned: Applied the patch: updated src/label.js',
  );
  await expect(messages.getByRole('group', { name: /Approval needed/ })).toHaveCount(0);
  await expect(
    messages
      .getByRole('note')
      .filter({
        hasText: 'Instruction files exceed their 32768-byte budget: AGENTS.md was truncated.',
      })
      .first(),
  ).toBeVisible();
  await expect(session.getByRole('tab', { name: 'Diff (2)' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const diff = session.getByRole('region', { name: 'Diff' });
  const files = diff.getByRole('navigation', { name: 'Changed files' });
  await expect(files).toContainText('src/math.js');
  await expect(files).toContainText('src/label.js');
  const mathHunk = diff.getByRole('group', { name: 'hunk 1 of src/math.js' });
  await expect(mathHunk).toContainText('Removed: return a - b;');
  await expect(mathHunk).toContainText('Added: return a + b;');
  await expect(mathHunk).toContainText('Pending');
  await expect(diff.getByRole('group', { name: 'hunk 1 of src/label.js' })).toContainText(
    "Added: return n + ' items';",
  );
  expect(fx.testsPass(), 'the edits fix the test').toBe(true);
  await expectNoSeriousA11yIssues(page, 'Code session with a diff');

  // 3. Writes to `.git/config` and `.nova/` are denied as protected paths: no approval is
  //    offered, nothing is written, and the denials are audited.
  const gitConfig = readFileSync(join(fx.repo, '.git', 'config'), 'utf8');
  await send(
    session,
    [
      call('fs.write', { path: '.git/config', content: '[core]\n\thooksPath = /tmp\n' }),
      call('fs.write', { path: '.nova/x', content: 'x' }),
    ].join('\n'),
  );
  const writes = messages.getByRole('group', { name: 'Tool call: Write a file' });
  await expect(writes).toHaveCount(2);
  for (const [i, dir] of ['.git', '.nova'].entries()) {
    await expect(writes.nth(i).locator('.tool-card-status')).toHaveText('Denied');
    await expect(writes.nth(i)).toContainText(`${dir} stays read-only`);
  }
  await expect(messages.getByRole('group', { name: /Approval needed/ })).toHaveCount(0);
  expect(readFileSync(join(fx.repo, '.git', 'config'), 'utf8')).toBe(gitConfig);
  expect(existsSync(join(fx.repo, '.nova', 'x'))).toBe(false);
  const audit = (await (await page.request.get(`${hub.url}/api/v1/audit?limit=200`)).json()) as {
    items: { action: string; decision: string | null }[];
  };
  expect(
    audit.items.filter((e) => e.action === 'fs.write' && e.decision === 'deny').length,
  ).toBeGreaterThanOrEqual(2);

  // 4. exec.run starts a long-running command. With a sandbox it returns a session id after the
  //    yield time, exec.poll reads it, exec.write sends a line, and Kill ends it. Without one the
  //    command fails closed and the terminal says why.
  await send(session, call('exec.run', { cmd: ECHO }));
  await allowOnce(messages, 'exec.run');
  await session.getByRole('tab', { name: 'Terminal' }).click();
  const agentCommands = session.getByRole('region', { name: 'Agent commands' });
  if (!sandbox) {
    const run = messages.getByRole('group', { name: 'Tool call: Run a command' });
    await expect(run).toContainText('Failed');
    await expect(run).toContainText('No sandbox is available on this Hub');
    await expect(agentCommands).toContainText('The agent has no commands running in this session.');
    await session.getByRole('button', { name: 'Start a terminal' }).click();
    await expect(session.getByRole('note').filter({ hasText: 'this Hub has none' })).toBeVisible();
  } else {
    await expect(messages).toContainText(/Tool exec\.run returned: Still running \(session /, {
      timeout: 90_000,
    });
    await expect(messages).toContainText('ready');
    const listed = await page.request.get(
      `${hub.url}/api/v1/exec/sessions?threadId=${view.threadId}`,
    );
    const { items } = (await listed.json()) as { items: { id: string; cmd: string }[] };
    expect(items).toHaveLength(1);
    const execId = items[0]!.id;
    await agentCommands.getByRole('button', { name: 'Refresh' }).click();
    const row = agentCommands.getByRole('listitem', { name: ECHO });
    await expect(row).toContainText('agent');
    await send(
      session,
      [
        call('exec.poll', { sessionId: execId }),
        call('exec.write', { sessionId: execId, text: 'hello\n' }),
      ].join('\n'),
    );
    await allowOnce(messages, 'exec.write');
    await expect(messages).toContainText('got hello', { timeout: 30_000 });
    await row.getByRole('button', { name: `Kill ${ECHO}` }).click();
    await expect(agentCommands).toContainText('The agent has no commands running in this session.');
    const after = await page.request.get(
      `${hub.url}/api/v1/exec/sessions?threadId=${view.threadId}`,
    );
    expect(((await after.json()) as { items: unknown[] }).items).toEqual([]);
  }

  // 5. Nova's status and diff reads never ran the repository's hooks or its fsmonitor.
  expect(hooksRan(fx)).toBe('');

  // 6. A comment on a diff line goes to the agent, which revises the change.
  await session.getByRole('tab', { name: /^Diff/ }).click();
  await diff.getByRole('button', { name: 'Comment on line 2 of src/math.js' }).click();
  await diff.getByRole('textbox', { name: 'Comment on line 2 of src/math.js' }).fill(COMMENT);
  await diff.getByRole('button', { name: 'Add comment' }).click();
  const batch = diff.getByRole('region', { name: 'Pending comments' });
  await expect(batch).toContainText('1 comment ready.');
  await batch.getByRole('button', { name: 'Send 1 comment' }).click();
  await expect(messages).toContainText(
    'Please revise your changes to address these review comments on the diff:',
  );
  await expect(messages).toContainText(
    'Tool fs.edit returned: Applied the patch: updated src/math.js (+2 -2).',
  );
  await expect(mathHunk).toContainText('Added: return left + right;');
  await expect(diff).toContainText('Name the parameters for what they are.');
  expect(fx.testsPass(), 'the revised code still passes').toBe(true);

  //    Run the tests: in the sandbox when there is one.
  await send(session, call('test.run', {}));
  await allowOnce(messages, 'test.run');
  const tests = messages.getByRole('group', { name: 'Tool call: Run the tests' });
  if (!sandbox) {
    await expect(tests).toContainText('Failed');
    await expect(tests).toContainText('No sandbox is available on this Hub');
  } else {
    await expect(messages).toContainText('Tool test.run returned: npm test:', { timeout: 90_000 });
  }

  // 7. Commit: accept the hunks; the Hub refuses the default branch; the Commit dialog refuses it
  //    too and commits on a new `nova/…` branch, saying the hooks did not run.
  await diff.getByRole('button', { name: 'Accept all' }).click();
  await expect(mathHunk).toContainText('Accepted');
  const refused = await page.request.post(`${hub.url}/api/v1/code/sessions/${sessionId}/commit`, {
    data: { message: 'Fix add and label' },
  });
  expect(refused.status()).toBe(403);
  expect(
    ((await refused.json()) as { error: { details: { reason: string } } }).error.details.reason,
  ).toBe('default_branch');
  await session.getByRole('button', { name: 'Commit…' }).click();
  const commit = page.getByRole('dialog', { name: 'Commit changes' });
  await expect(commit).toContainText('You are on main, the default branch.');
  await commit.getByLabel('Commit message').fill('Fix add and label');
  const branch = commit.getByLabel('New branch');
  await expect(branch).toHaveValue('nova/fix-add-and-label');
  await branch.fill('main');
  await expect(commit).toContainText('Choose a branch other than main.');
  await expect(commit.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
  await branch.fill('nova/fix-add-and-label');
  await expectNoSeriousA11yIssues(page, 'Commit dialog');
  await commit.getByRole('button', { name: 'Commit', exact: true }).click();
  const committed = page.getByRole('dialog', { name: 'Committed' });
  await expect(committed.getByRole('status')).toContainText(
    'Committed 2 files to nova/fix-add-and-label as',
  );
  await expect(committed.getByRole('note')).toContainText('hooks did not run');
  await committed.getByRole('button', { name: 'Done' }).click();
  expect(fx.git('log', '-1', '--format=%s', 'nova/fix-add-and-label').trim()).toBe(
    'Fix add and label',
  );
  expect(fx.git('show', 'nova/fix-add-and-label:src/math.js')).toContain('return left + right;');
  expect(fx.git('show', 'nova/fix-add-and-label:src/label.js')).toContain("' items'");
  expect(fx.git('log', '-1', '--format=%s', 'main').trim()).toBe('Initial calc');

  // 8. A second session in a new Git worktree (on its own `nova/…` branch): Nova's worktree,
  //    status, diff and commit operations never ran a hook or the fsmonitor command.
  const wt = await newSession(page, { folder: fx.repo, title: 'Calc worktree', worktree: true });
  await wt.getByRole('button', { name: 'Start session' }).click();
  const second = page.getByRole('region', { name: 'Code session: Calc worktree' });
  await expect(second.locator('.code-header-meta')).toContainText('nova/calc-worktree');
  await expect(second.locator('.code-header-meta')).toContainText('.nova/worktrees/');
  expect(fx.git('worktree', 'list')).toContain('nova/calc-worktree');
  expect(hooksRan(fx)).toBe('');
});
