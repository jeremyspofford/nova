// J9 — Sync & multi-device (docs/18 §3; M7 exit criteria and demo in docs/17).
//
// 1. Two browser devices, A and B, each in its own browser context (own cookies and IndexedDB),
//    join through Add a device with the "Offline copy" scope, each approved by typing its code;
//    both open the app signed in, and Settings → Sync shows each copy (on the devices and on the
//    owner's browser, which keeps none).
// 2. A chat made on A reaches B's copy (B pulls on `sync.changed`) and B's Recent list, both
//    without a reload; B opens it from there.
// 3. A forced conflict: the same page is open on A and B, both go offline, each changes its text;
//    A comes back first, then B: the later write wins (last writer by HLC), Settings → Sync →
//    History on A shows both values and who set them, and Restore brings A's text back on both
//    devices (B's open editor follows live).
// 4. Offline queue: A offline sends three messages (the chat shows them "Queued") and renames the
//    chat; Settings → Sync lists them waiting, in order; on reconnect they reach the Hub in that
//    order (the Hub's thread and the UI), the last one is answered, the open chat leaves "Queued"
//    by itself, and a rename of a chat the owner deleted meanwhile is refused ("It was deleted on
//    the Hub.") and discarded.
// 5. Code handoff (FR-213): a session on a local branch with a commit no other clone has and an
//    uncommitted edit made through its own tools moves to another clone of the repository (the
//    other "device") through the Handoff dialog, keeping the source; the target is on the same
//    branch and commit with the edit applied, uncommitted; the Moves tab lists the move.
// 6. Cloud runner (FR-108): the runner on loopback is set up in Settings → Cloud runner, a cloud
//    environment is made from a repository (its setup script runs in the repository's folder), a
//    Code session on it runs a command (the Mock's exec.run, approved) that finishes on the runner
//    while the owner's browser (the "laptop") is offline; back online, the result and the run's
//    usage show. The Hub needs no sandbox of its own for that (the container's Hub has none).
// 7. The M7 demo: a phone (Pixel 7 profile) joins through the Relay and starts a Work run with
//    New task, while every request it makes to the Hub's own address is refused, so only the web
//    Relay transport can carry it; the approval it causes is answered on the owner's desktop from
//    the Approvals page; the phone sees the result, still connected through the Relay.
// Every page visited passes the axe checks.
//
// How the world is played, and what the Playwright container cannot do:
// - Every browser is at http://127.0.0.1 (loopback is a secure context, so the join page has Web
//   Crypto and the offline copy its encrypted IndexedDB store without any flag). Going offline is
//   Playwright's context.setOffline plus the end of the page's open event streams
//   (e2e/support/m7.ts `goOffline`): Chromium's offline emulation keeps an open stream delivering.
// - The cloud runner is services/runner on 127.0.0.1 with a token from its own CLI
//   (`nova-runner token add`). The container has neither bubblewrap nor a container runtime, so
//   there the runner's server runs with its documented host test double as the sandbox
//   (services/runner/test/host-substrate.ts, via e2e/support/runner-host.ts): commands run on
//   this machine without isolation. Where bubblewrap works the real `nova-runner` runs instead.
//   A command of a Code session on the real sandbox is apps/hub/test/cloudrun.test.ts (and
//   packages/core/test/cloudrun.test.ts); the sandbox itself is services/runner/test/.
// - The Relay is self-hosted (services/relay) on loopback, at a ws:// address (the loopback form
//   of the wss:// address the Relay settings suggest). An artifact's content is fetched by its
//   address, which the Relay tunnel does not carry yet (M7 known gap), so step 7 checks the
//   artifact's card only.
// - The Mock provider drives tool calls with `/tool <name> <json>` lines.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { devices, expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoSeriousA11yIssues } from './support/a11y.ts';
import { createFixtureRepo } from './support/fixture-repo.ts';
import { type RunningHub } from './support/hub.ts';
import { startRelayService } from './support/m65.ts';
import { json, setUpHub, toast, until } from './support/m6.ts';
import {
  addBrowserDevice,
  droppableStreams,
  git,
  goOffline,
  makeRepo,
  openSettings,
  ownerApi,
  send,
  sidebarLink,
  startRunnerService,
} from './support/m7.ts';

const portFor = (parallelIndex: number) => 7641 + parallelIndex;
let hub: RunningHub;

// A step that cannot act fails there instead of waiting for the test's timeout.
test.use({ colorScheme: 'light', actionTimeout: 30_000 });
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

test.afterEach(async () => {
  await hub?.stop();
});

/** One `/tool` line of the Mock's script. */
const call = (name: string, args: unknown) => `/tool ${name} ${JSON.stringify(args)}`;

const OFFLINE_TEXT = 'Offline: showing what this device has.';

interface ThreadJson {
  thread: { id: string; title: string | null };
  messages: {
    id: string;
    role: string;
    parentId?: string | null;
    provenance?: string;
    parts: { type: string; text?: string }[];
  }[];
}

const textOf = (m: ThreadJson['messages'][number]) =>
  m.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');

/** Settings → Sync's sections. */
const syncSection = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

/** Spaces (sidebar) → a space → a page: the page editor. */
async function openPage(page: Page, space: string, title: string) {
  await sidebarLink(page, 'Spaces').click();
  await page.getByRole('list', { name: 'Spaces' }).getByRole('link', { name: space }).click();
  await page.getByRole('list', { name: 'Pages' }).getByRole('link', { name: title }).click();
  await expect(page.getByRole('form', { name: 'Edit the page' })).toBeVisible();
  return page.getByRole('textbox', { name: 'Page text (Markdown)' });
}

/** Save the page editor's text. */
async function savePage(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'Page text (Markdown)' });
  await box.fill(text);
  await page
    .getByRole('form', { name: 'Edit the page' })
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(page.getByText('All changes saved')).toBeVisible();
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A chat in the sidebar's list (its name may go on with ", unread" and the like). */
const chatLink = (page: Page, title: string) =>
  page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('link', { name: new RegExp(`^${esc(title)}(,|$)`) });

test('J9: two devices keep an offline copy; a conflict is logged and restored; offline changes flush in order', async ({
  page,
  browser,
}, testInfo) => {
  hub = await setUpHub(page, portFor(testInfo.parallelIndex));
  const ctxA = await browser.newContext({ colorScheme: 'light' });
  const ctxB = await browser.newContext({ colorScheme: 'light' });
  await droppableStreams(ctxA);
  await droppableStreams(ctxB);
  try {
    // 1. The owner adds two browsers with the Offline copy scope; each approved by its code.
    const a = await addBrowserDevice(page, ctxA, { name: 'Laptop A', scopes: ['Offline copy'] });
    await expectNoSeriousA11yIssues(page, 'add a device: added');
    const b = await addBrowserDevice(page, ctxB, { name: 'Tablet B', scopes: ['Offline copy'] });
    for (const [d, name] of [
      [a, 'Laptop A'],
      [b, 'Tablet B'],
    ] as const) {
      await openSettings(d, 'Sync');
      const mine = syncSection(d, 'This device');
      await expect(mine).toContainText('Up to date', { timeout: 20_000 });
      await expect(mine).toContainText('encrypted on this device');
      await expect(
        syncSection(d, 'Devices with an offline copy')
          .getByRole('list', { name: 'Devices with an offline copy' })
          .getByRole('listitem', { name }),
      ).toContainText(`${name} (this device)`);
      await expectNoSeriousA11yIssues(d, `settings → sync on ${name}`);
    }
    //    The owner's own browser keeps no copy, and lists both devices' copies.
    await openSettings(page, 'Sync');
    await expect(syncSection(page, 'This device')).toContainText(
      'This browser is signed in to the Hub directly, not added as a device',
    );
    const replicas = page.getByRole('list', { name: 'Devices with an offline copy' });
    for (const name of ['Laptop A', 'Tablet B'])
      await expect(replicas.getByRole('listitem', { name })).toContainText('Synced');
    await expectNoSeriousA11yIssues(page, 'settings → sync on the owner');

    // 2. A chat made on A reaches B's copy without a reload of B (it pulls on `sync.changed`).
    await expect(syncSection(b, 'This device')).not.toContainText('1 chat');
    await a
      .getByRole('button', { name: /New chat/ })
      .first()
      .click();
    await send(a, 'Trip planning');
    await expect(a.getByRole('log', { name: 'Messages' })).toContainText('You said: Trip planning');
    await expect(syncSection(b, 'This device')).toContainText(/1 chat, 2 messages/, {
      timeout: 20_000,
    });
    //    B's Recent list shows it live too; B opens it from there, still without a reload.
    const tripOnB = chatLink(b, 'Trip planning');
    await expect(tripOnB).toBeVisible({ timeout: 20_000 });
    await tripOnB.click();
    await expect(b.getByRole('log', { name: 'Messages' })).toContainText('You said: Trip planning');

    // 3. A forced conflict. A makes a space and a page; both devices open it.
    await sidebarLink(a, 'Spaces').click();
    await a.getByRole('button', { name: 'New space' }).click();
    const newSpace = a.getByRole('dialog', { name: 'New space' });
    await newSpace.getByLabel('Name', { exact: true }).fill('Trip');
    await newSpace.getByRole('button', { name: 'Create space' }).click();
    await expect(a.getByRole('heading', { level: 1, name: 'Trip' })).toBeVisible();
    await a.getByRole('button', { name: 'New page' }).click();
    const newPage = a.getByRole('dialog', { name: 'New page' });
    await newPage.getByLabel('Title', { exact: true }).fill('Packing list');
    await newPage.getByRole('button', { name: 'Add page' }).click();
    await expect(a.getByRole('form', { name: 'Edit the page' })).toBeVisible();
    await savePage(a, 'Passport');
    const { pageId, spaceId } = (() => {
      const m = /\/spaces\/([^/]+)\/([^/?#]+)/.exec(a.url())!;
      return { spaceId: m[1]!, pageId: m[2]! };
    })();
    const hubText = async () =>
      (
        await json<{ content: string }>(
          await page.request.get(`${hub.url}/api/v1/spaces/${spaceId}/pages/${pageId}`),
        )
      ).content;
    //    Both copies hold the page before the devices go offline.
    await openSettings(b, 'Sync');
    await expect(syncSection(b, 'This device')).toContainText(/1 space, 1 page/, {
      timeout: 20_000,
    });
    const textB = await openPage(b, 'Trip', 'Packing list');
    await expect(textB).toHaveValue('Passport');
    await openSettings(a, 'Sync');
    await expect(syncSection(a, 'This device')).toContainText(/1 space, 1 page/);
    const textA = await openPage(a, 'Trip', 'Packing list');
    await expect(textA).toHaveValue('Passport');

    //    Both offline; each changes the same field; A's change is the earlier one.
    await goOffline(ctxA);
    await goOffline(ctxB);
    await savePage(a, 'Passport, tickets');
    await expect(a.getByText(OFFLINE_TEXT)).toBeVisible();
    await expect(a.getByRole('status', { name: 'Connection to the Hub' })).toContainText(
      '1 change waiting to send',
    );
    await expectNoSeriousA11yIssues(a, 'a page edited offline');
    await savePage(b, 'Passport, charger');
    await expect(b.getByText(OFFLINE_TEXT)).toBeVisible();
    expect(await hubText()).toBe('Passport');

    //    A comes back first: its change reaches the Hub. Then B: the later write wins.
    await ctxA.setOffline(false);
    await until(
      'A’s change reaches the Hub',
      async () => (await hubText()) === 'Passport, tickets',
    );
    await expect(a.getByText(OFFLINE_TEXT)).toBeHidden();
    await ctxB.setOffline(false);
    await until('B’s later change wins', async () => (await hubText()) === 'Passport, charger');
    await expect(textA).toHaveValue('Passport, charger', { timeout: 20_000 });

    //    History on A shows the conflict with both values; Restore brings A's text back.
    await openSettings(a, 'Sync');
    const log = syncSection(a, 'History').getByRole('list', { name: 'Merge log' });
    const entry = log.getByRole('listitem', { name: 'Page “Packing list” · Content' });
    await expect(entry).toContainText('Changed in two places at about the same time');
    await expect(entry.locator('[data-side="winner"]')).toContainText('Passport, charger');
    await expect(entry.locator('[data-side="winner"]')).toContainText('By Tablet B');
    await expect(entry.locator('[data-side="lost"]')).toContainText('Passport, tickets');
    await expect(entry.locator('[data-side="lost"]')).toContainText('By this device');
    await expectNoSeriousA11yIssues(a, 'settings → sync → history with a conflict');
    await entry.getByRole('button', { name: 'Restore the replaced value' }).click();
    const restore = a.getByRole('dialog', { name: 'Restore the replaced value?' });
    await expect(restore).toContainText('Passport, tickets');
    await expectNoSeriousA11yIssues(a, 'restore a replaced value');
    await restore.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(toast(a, 'Restored.')).toBeVisible();
    await until(
      'the restore reaches the Hub',
      async () => (await hubText()) === 'Passport, tickets',
    );
    //    Both devices show it: B's open editor follows live; A opens the page again.
    await expect(textB).toHaveValue('Passport, tickets', { timeout: 20_000 });
    await expect(await openPage(a, 'Trip', 'Packing list')).toHaveValue('Passport, tickets');

    // 4. The offline queue on A. A second chat, which the owner deletes while A is away.
    await a
      .getByRole('button', { name: /New chat/ })
      .first()
      .click();
    await send(a, 'Old notes');
    await expect(a.getByRole('log', { name: 'Messages' })).toContainText('You said: Old notes');
    await chatLink(a, 'Trip planning').click();
    await expect(a.getByRole('log', { name: 'Messages' })).toContainText('You said: Trip planning');
    const tripId = /\/chat\/([^/?#]+)/.exec(a.url())![1]!;
    await goOffline(ctxA);
    //    The owner deletes "Old notes" on the Hub meanwhile.
    await page.goto(`${hub.url}/`);
    await page.getByRole('button', { name: 'Actions for Old notes' }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    await page
      .getByRole('dialog', { name: 'Delete this chat?' })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(toast(page, 'Chat deleted.')).toBeVisible();
    //    Offline, A sends three messages in order and renames both chats.
    const stops = ['First stop: Lisbon', 'Second stop: Porto', 'Third stop: Faro'];
    for (const s of stops) await send(a, s);
    const queuedStrip = a.getByRole('region', { name: 'Queued messages' });
    await expect(queuedStrip).toContainText('Queued: 3');
    for (const s of stops) await expect(queuedStrip).toContainText(s);
    for (const [from, to] of [
      ['Trip planning', 'Lisbon trip'],
      ['Old notes', 'Old notes (kept)'],
    ] as const) {
      await a.getByRole('button', { name: `Actions for ${from}` }).click();
      await a.getByRole('menuitem', { name: 'Rename' }).click();
      const field = a.getByRole('textbox', { name: 'Chat name' });
      await field.fill(to);
      await field.press('Enter');
      await expect(chatLink(a, to)).toBeVisible();
    }
    await expect(a.getByText(OFFLINE_TEXT)).toBeVisible();
    //    Settings → Sync lists them waiting, in the order they go out.
    await openSettings(a, 'Sync');
    const waiting = a.getByRole('list', { name: 'Changes waiting to send' });
    const rows = waiting.getByRole('listitem');
    //    (The page edit of step 3 is listed as sent until cleared.)
    const sentEdit = waiting.getByRole('listitem', { name: 'Edit the page “Packing list”' });
    await expect(sentEdit).toContainText('Sent');
    await a.getByRole('button', { name: 'Clear sent' }).click();
    await expect(sentEdit).toHaveCount(0);
    await expect(rows).toHaveCount(5);
    const expected = [
      ...stops.map((s) => ['Message in “Trip planning”', s] as const),
      ['Rename “Trip planning” to “Lisbon trip”', 'Lisbon trip'],
      ['Rename “Old notes” to “Old notes (kept)”', 'Old notes (kept)'],
    ] as const;
    for (const [i, [label, text]] of expected.entries()) {
      await expect(rows.nth(i)).toHaveAccessibleName(label);
      await expect(rows.nth(i)).toContainText(text);
      await expect(rows.nth(i)).toContainText('Waiting to send');
    }
    await expect(syncSection(a, 'This device')).toContainText('5 changes');
    await expectNoSeriousA11yIssues(a, 'the queue of changes waiting to send');

    //    Back online: they go out in order; the rename of the deleted chat is refused.
    await ctxA.setOffline(false);
    for (const i of [0, 1, 2, 3])
      await expect(rows.nth(i)).toContainText('Sent', { timeout: 30_000 });
    await expect(rows.nth(2)).toContainText('Sent. The Hub is answering it now.');
    const refused = rows.nth(4);
    await expect(refused).toContainText('Not sent');
    await expect(refused).toContainText('It was deleted on the Hub.');
    await expectNoSeriousA11yIssues(a, 'the queue with a refused change');
    //    The Hub's thread has them in the order they were sent, then the answer to the last.
    const thread = await until('the answer to the last message', async () => {
      const t = await json<ThreadJson>(
        await page.request.get(`${hub.url}/api/v1/threads/${tripId}`),
      );
      return t.messages.length === 6 ? t : null;
    });
    expect(thread.thread.title).toBe('Lisbon trip');
    expect(thread.messages.map(textOf)).toEqual([
      'Trip planning',
      'You said: Trip planning',
      ...stops,
      'You said: Third stop: Faro',
    ]);
    for (const [i, m] of thread.messages.entries())
      if (i > 0) expect(m.parentId).toBe(thread.messages[i - 1]!.id);
    expect(thread.messages.slice(2, 5).map((m) => m.provenance)).toEqual(['sync', 'sync', 'sync']);
    //    Discard the refused change (it asks first).
    await refused.getByRole('button', { name: 'Discard' }).click();
    const discard = a.getByRole('dialog', { name: 'Discard this change?' });
    await expect(discard).toContainText('Old notes (kept)');
    await discard.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(
      waiting.getByRole('listitem', { name: 'Rename “Old notes” to “Old notes (kept)”' }),
    ).toHaveCount(0);
    //    The chat that was open while A was offline caught up by itself on reconnect: back in
    //    it (the same view, not opened again), nothing is "Queued" any more, and it shows the
    //    messages in that order with the answer, the offline ones labelled.
    await chatLink(a, 'Lisbon trip').click();
    await expect(queuedStrip).toHaveCount(0);
    const log2 = a.getByRole('log', { name: 'Messages' });
    await expect(log2).toContainText('You said: Third stop: Faro');
    const shown = await log2.innerText();
    const at = [...stops, 'You said: Third stop: Faro'].map((s) => shown.indexOf(s));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    await expect(log2.getByText('Written offline')).toHaveCount(3);
    await expectNoSeriousA11yIssues(a, 'a chat with messages written offline');
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

/** A Nova patch (docs/08 §1.3) that updates one file. */
const patch = (path: string, lines: string[]) => ({
  patch: ['%%% patch', `%%% update ${path}`, '@@', ...lines, '%%% end'].join('\n'),
});

/** Code (sidebar) → New session: the dialog. */
async function newCodeSession(page: Page) {
  await sidebarLink(page, 'Code').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Code' })).toBeVisible();
  await page.getByRole('button', { name: 'New session' }).click();
  return page.getByRole('dialog', { name: 'New Code session' });
}

/** Choose the option whose text starts with `label` in a native select. */
async function chooseOption(select: Locator, label: RegExp) {
  const value = await select.locator('option', { hasText: label }).first().getAttribute('value');
  expect(value, `an option ${label} in the select`).not.toBeNull();
  await select.selectOption(value);
}

test('J9: a Code session is handed off to another checkout with its branch and uncommitted change', async ({
  page,
}, testInfo) => {
  // The repository on "device A", and a clone of it on "device B" made before A's local commit.
  const fx = createFixtureRepo();
  const target = join(dirname(fx.repo), 'calc-on-b');
  git(dirname(fx.repo), 'clone', '-q', fx.repo, target);
  fx.git('checkout', '-q', '-b', 'trip-totals');
  writeFileSync(join(fx.repo, 'NOTES.md'), 'Totals per trip.\n');
  fx.git('add', 'NOTES.md');
  fx.git('commit', '-q', '-m', 'Notes for trip totals');
  const head = fx.git('rev-parse', 'HEAD').trim();
  hub = await setUpHub(page, portFor(testInfo.parallelIndex));

  // 5. A session in the repository, on its local branch; it edits a file (uncommitted).
  const dialog = await newCodeSession(page);
  await dialog.getByLabel('Folder path on the Hub').fill(fx.repo);
  await dialog.getByLabel('Permission mode').selectOption('accept_edits');
  await dialog.getByLabel('Title (optional)').fill('Trip totals');
  await dialog.getByRole('button', { name: 'Start session' }).click();
  const session = page.getByRole('region', { name: 'Code session: Trip totals' });
  await expect(session.locator('.code-header-meta')).toContainText('trip-totals');
  const messages = session.getByRole('log', { name: 'Messages' });
  await send(
    session,
    [
      'Fix add.',
      call('fs.edit', patch('src/math.js', ['-  return a - b;', '+  return a + b;'])),
    ].join('\n'),
  );
  await expect(messages).toContainText(
    'Tool fs.edit returned: Applied the patch: updated src/math.js',
  );
  expect(fx.git('status', '--porcelain')).toContain(' M src/math.js');

  //    Hand off… → another environment (this Hub), the clone's folder, keep the source.
  await session.getByRole('button', { name: 'Hand off…' }).first().click();
  const handoff = page.getByRole('dialog', { name: 'Hand off this session' });
  await expect(handoff.getByRole('radio', { name: 'Another environment' })).toBeChecked();
  await chooseOption(handoff.getByRole('combobox', { name: 'Environment' }), /^This Hub/);
  await handoff.getByLabel('Repository folder on This Hub').fill(target);
  await expect(handoff.getByRole('radio', { name: 'Keep them here too' })).toBeChecked();
  await expectNoSeriousA11yIssues(page, 'the Handoff dialog');
  await handoff.getByRole('button', { name: 'Move session' }).click();
  const moved = page.getByRole('dialog', { name: 'Session moved' });
  await expect(moved).toContainText(`It continues in ${target}.`, { timeout: 60_000 });
  await expect(moved).toContainText(
    `Branch trip-totals, commit ${head.slice(0, 7)}, 1 changed file`,
  );
  await expectNoSeriousA11yIssues(page, 'the Handoff dialog: moved');
  await moved.getByRole('button', { name: 'Close' }).click();

  //    The target is on the same branch and commit, with the change applied and uncommitted.
  expect(git(target, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('trip-totals');
  expect(git(target, 'rev-parse', 'HEAD').trim()).toBe(head);
  expect(git(target, 'diff', '--name-only').trim()).toBe('src/math.js');
  expect(git(target, 'diff')).toContain('+  return a + b;');
  expect(readFileSync(join(target, 'NOTES.md'), 'utf8')).toBe('Totals per trip.\n');
  //    The source kept its change.
  expect(fx.git('diff', '--name-only').trim()).toBe('src/math.js');
  //    The session now works there, and its history lists the move.
  await expect(session.locator('.code-header-meta')).toContainText('calc-on-b');
  await session.getByRole('tab', { name: 'Moves' }).click();
  const move = session.getByRole('list', { name: 'Moves' }).getByRole('listitem');
  await expect(move).toHaveCount(1);
  await expect(move).toContainText('Branch trip-totals');
  await expect(move).toContainText(`Commit ${head.slice(0, 7)}`);
  await expect(move).toContainText('Source kept');
  await expectNoSeriousA11yIssues(page, 'the session’s Moves tab');
});

test('J9: a cloud Code session keeps running on the runner while the laptop is offline', async ({
  page,
}, testInfo) => {
  const runner = await startRunnerService();
  testInfo.annotations.push({ type: 'runner sandbox', description: runner.substrate });
  try {
    makeRepo(
      runner.repos,
      'calc',
      { 'README.md': '# Calc\n', 'build.sh': '#!/bin/sh\nsleep 4\necho "built on the runner"\n' },
      ['build.sh'],
    );
    await droppableStreams(page.context());
    hub = await setUpHub(page, portFor(testInfo.parallelIndex));
    //    Whether the Hub has a sandbox of its own (the container has none, CI's runner has
    //    Docker): a cloud session's commands go to the runner either way.
    const diag = await json<{ sandbox: { available: boolean } }>(
      await page.request.get(`${hub.url}/api/v1/diagnostics`),
    );
    testInfo.annotations.push({
      type: 'Hub sandbox',
      description: diag.sandbox.available ? 'available' : 'none',
    });

    // 6. Settings → Cloud runner: its address and token, then on (asks first, tests it).
    await openSettings(page, 'Cloud runner');
    await expectNoSeriousA11yIssues(page, 'settings → cloud runner');
    await page.getByRole('textbox', { name: 'Runner address' }).fill(runner.url);
    await page.getByLabel('Runner token').fill(runner.token);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(toast(page, 'Runner saved.')).toBeVisible();
    await page.getByRole('switch', { name: 'Use the cloud runner' }).click();
    const turnOn = page.getByRole('dialog', { name: 'Turn on the cloud runner?' });
    await expect(turnOn).toContainText(runner.url);
    await turnOn.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByRole('switch', { name: 'Use the cloud runner' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.locator('.cl-facts').first()).toContainText('Ready');
    await expectNoSeriousA11yIssues(page, 'settings → cloud runner, on');

    //    A cloud environment from the repository (file:// from the runner's --local-repos).
    await page.getByRole('button', { name: 'New cloud environment' }).click();
    const create = page.getByRole('dialog', { name: 'New cloud environment' });
    await create.getByRole('textbox', { name: 'Name' }).fill('Calc (cloud)');
    await create
      .getByRole('textbox', { name: 'Repositories' })
      .fill(`file://${join(runner.repos, 'calc')}`);
    await create
      .getByRole('textbox', { name: 'Setup script (optional)' })
      // It runs in the first repository's folder.
      .fill('test -x build.sh && echo ready');
    await expectNoSeriousA11yIssues(page, 'new cloud environment');
    await create.getByRole('button', { name: 'Create environment' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Calc (cloud)' })).toBeVisible();
    await expect(page.locator('.ws-page-header')).toContainText('Ready', { timeout: 60_000 });
    await expectNoSeriousA11yIssues(page, 'a cloud environment');

    //    A Code session on it.
    const dialog = await newCodeSession(page);
    await chooseOption(dialog.getByRole('combobox', { name: 'Environment' }), /^Calc \(cloud\)/);
    await dialog.getByLabel('Folder path on Calc (cloud)').fill('/workspace/calc');
    await dialog.getByLabel('Title (optional)').fill('Cloud build');
    await dialog.getByRole('button', { name: 'Start session' }).click();
    const session = page.getByRole('region', { name: 'Code session: Cloud build' });
    await expect(session.getByText('No cloud run yet.')).toBeVisible();
    const sessionId = /\/code\/([^/?#]+)$/.exec(page.url())![1]!;
    const messages = session.getByRole('log', { name: 'Messages' });
    await send(session, call('exec.run', { cmd: './build.sh' }));
    const card = messages
      .getByRole('group', { name: /Approval needed/ })
      .filter({ hasText: 'exec.run' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(card).toHaveCount(0);

    //    The laptop goes offline at once (the command takes 4 s); it runs on the runner meanwhile.
    await goOffline(page.context());
    const api = await ownerApi(page.context(), hub.url);
    try {
      const { threadId } = await json<{ threadId: string }>(
        await api.get(`/api/v1/code/sessions/${sessionId}`),
      );
      await until(
        'the command finished on the runner',
        async () => {
          const t = await json<ThreadJson>(await api.get(`/api/v1/threads/${threadId}`));
          return JSON.stringify(t.messages).includes('built on the runner');
        },
        60_000,
      );
      const { items } = await json<{ items: { id: string; usage: { commands: number } }[] }>(
        await api.get(`/api/v1/cloud/runs?threadId=${threadId}`),
      );
      expect(items).toHaveLength(1);
      expect(items[0]!.usage.commands).toBeGreaterThanOrEqual(1);
    } finally {
      await api.dispose();
    }
    //    The page could not see it: it still shows what it had.
    await expect(page.getByText(OFFLINE_TEXT)).toBeVisible();
    await expect(messages).not.toContainText('built on the runner');

    //    Back online: the result and the run's usage show.
    await page.context().setOffline(false);
    await expect(messages).toContainText('built on the runner', { timeout: 30_000 });
    await expect(page.getByText(OFFLINE_TEXT)).toBeHidden();
    const run = session.getByRole('region', { name: 'Cloud run on Calc (cloud)' });
    await expect(run).toContainText('1 command');
    await expect(run).toContainText('Code session');
    await expectNoSeriousA11yIssues(page, 'a cloud Code session with its run');
    await session.getByRole('link', { name: 'Open the run’s page' }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Cloud run on Calc (cloud)' }),
    ).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Cloud build');
    await expectNoSeriousA11yIssues(page, 'a cloud run’s page');
  } finally {
    await runner.stop();
  }
});

/** Network (sidebar) → one of its sections; returns the section's panel. */
async function openNetwork(page: Page, section: string) {
  await sidebarLink(page, 'Network').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Network' })).toBeVisible();
  const tab = page.getByRole('tablist', { name: 'Network sections' }).getByRole('tab', {
    name: section,
  });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  return page.getByRole('tabpanel', { name: section });
}

const PACKING = '# Packing list\n\n- Passport\n- Charger';
const TASK = [
  'Make the packing list for the trip.',
  call('artifact.create', { kind: 'markdown', title: 'Packing list', content: PACKING }),
  call('run.complete', { summary: 'Packing list saved for the trip.' }),
].join('\n');

test('J9 demo: a phone starts a task through the Relay; the desktop approves it', async ({
  page,
  browser,
}, testInfo) => {
  const relay = await startRelayService();
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'light' });
  try {
    hub = await setUpHub(page, portFor(testInfo.parallelIndex));
    // 7. Network → Relay: the Hub connects to the self-hosted Relay (asks first).
    const panel = await openNetwork(page, 'Relay');
    await panel.getByRole('switch', { name: 'Use a Relay' }).click();
    await panel.getByRole('textbox', { name: 'Relay address' }).fill(relay.url);
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Connect this Hub to the Relay?' })
      .getByRole('button', { name: 'Connect' })
      .click();
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible({ timeout: 20_000 });

    //    The phone joins through the Relay. Every request it makes to the Hub's own address is
    //    refused, so the join, the app, New task and the run page work only through the web
    //    Relay transport; a fallback to the Hub's address has nowhere to go.
    let refused = 0;
    const phone = await addBrowserDevice(page, phoneCtx, {
      name: 'Pixel phone',
      relay: true,
      before: async () => {
        await phoneCtx.route(`${hub.url}/api/**`, (route) => {
          refused += 1;
          return route.abort('internetdisconnected');
        });
      },
    });
    expect(refused, 'the phone tried the Hub’s own address first').toBeGreaterThan(0);
    await phone.getByRole('button', { name: /^Account/ }).click();
    await expect(
      phone.getByRole('menuitem', { name: /Connected through the Relay/ }),
    ).toBeVisible();
    await phone.getByRole('menuitem', { name: 'Approvals' }).click();
    await expect(phone.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
    await expect(phone.getByText('Nothing is waiting for you')).toBeVisible();
    await expectNoSeriousA11yIssues(phone, 'approvals on the phone');

    //    New task → a Work run whose step asks for approval.
    await phone.getByRole('button', { name: 'New task' }).click();
    const sheet = phone.getByRole('dialog', { name: 'New task' });
    await expect(sheet.getByRole('radio', { name: 'Work run' })).toBeChecked();
    await sheet.getByRole('textbox', { name: 'What should it do?' }).fill(TASK);
    await expectNoSeriousA11yIssues(phone, 'the New task sheet');
    await sheet.getByRole('button', { name: 'Start' }).click();
    await expect(phone).toHaveURL(/\/work\/[^/?#]+$/);
    const runId = /\/work\/([^/?#]+)$/.exec(phone.url())![1]!;

    //    The desktop answers it on the Approvals page.
    await sidebarLink(page, 'Approvals').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
    const approval = page
      .getByRole('list', { name: 'Approvals' })
      .getByRole('group', { name: /Approval needed/ })
      .filter({ hasText: 'artifact.create' });
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('1 approval is waiting.')).toBeVisible();
    await expectNoSeriousA11yIssues(page, 'approvals on the desktop');
    await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(page.getByText('All answered.')).toBeVisible();

    //    The phone sees the result live, through the Relay. (An artifact's content is fetched by
    //    its address, which the tunnel does not carry yet (M7 known gap), so only its card.)
    const result = phone.getByRole('region', { name: 'Result' });
    await expect(result).toContainText('Packing list saved for the trip.', { timeout: 30_000 });
    await expect(result.getByRole('article', { name: 'Packing list', exact: true })).toBeVisible();
    await expectNoSeriousA11yIssues(phone, 'the finished run on the phone');
    const run = await json<{ status: string }>(
      await page.request.get(`${hub.url}/api/v1/runs/${runId}`),
    );
    expect(run.status).toBe('done');
    //    Still through the Relay, and the Hub lists the phone as a client of its Relay.
    await phone.getByRole('button', { name: /^Account/ }).click();
    await expect(
      phone.getByRole('menuitem', { name: /Connected through the Relay/ }),
    ).toBeVisible();
    await phone.keyboard.press('Escape');
    const relayPanel = await openNetwork(page, 'Relay');
    await expect(
      relayPanel
        .getByRole('list', { name: 'Paired clients' })
        .getByRole('listitem', { name: 'Pixel phone' }),
    ).toContainText('Active');
  } finally {
    await phoneCtx.close();
    await relay.stop();
  }
});
