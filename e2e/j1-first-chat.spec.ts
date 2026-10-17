// J1 — First chat (docs/18 §3, M1 exit criteria in docs/17).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { startHub, type RunningHub } from './support/hub.ts';

// One port per parallel worker so repeated or parallel runs never collide.
const portFor = (parallelIndex: number) => 7511 + parallelIndex;
let hub: RunningHub;

test.use({ colorScheme: 'light' });
test.describe.configure({ mode: 'serial' });

test.afterEach(async () => {
  await hub?.stop();
});

async function expectNoSeriousA11yIssues(page: Page, where: string) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = result.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map(
      (v) =>
        `${v.id}: ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(' ')}: ${n.failureSummary ?? ''}`).join('\n')}`,
    ),
    `axe on ${where}`,
  ).toEqual([]);
}

test('J1: onboard, stream, stop, restart, search, theme', async ({ page }, testInfo) => {
  const PORT = portFor(testInfo.parallelIndex);
  hub = await startHub({ port: PORT });
  // M1 exit criterion: cold start ≤ 3.0 s (relaxed budget; tightened in M9).
  expect(hub.startMs, 'Hub cold start').toBeLessThan(3000);
  expect(hub.setupCode).toBeTruthy();

  // 1. Fresh profile → setup → onboarding with the offline mock provider → set name.
  await page.goto(`${hub.url}/#setup=${hub.setupCode}`);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('Already connected:')).toBeVisible();
  await expect(page.getByText('Mock (offline)')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click(); // provider
  await page.getByRole('button', { name: 'Continue' }).click(); // default model
  await page.getByLabel('Display name').fill('Jordan');
  await page.getByRole('button', { name: 'Continue' }).click(); // profile
  await page.getByRole('button', { name: 'Continue' }).click(); // tools (later milestone)
  await page.getByRole('button', { name: 'Finish without the sample' }).click();

  // 2. Send "Hello" → tokens stream → reply completes.
  await page
    .getByRole('button', { name: /New chat/ })
    .first()
    .click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Hello');
  await composer.press('Enter');
  const messages = page.getByLabel('Messages');
  await expect(messages).toContainText('You said: Hello');
  await expectNoSeriousA11yIssues(page, 'chat');

  // Stop works and the partial reply is kept, marked "Stopped".
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  await composer.fill(long);
  await composer.press('Enter');
  await expect(messages).toContainText('You said: word0');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(messages.getByText('Stopped')).toBeVisible();
  const replies = messages.locator('[aria-label$=", stopped"]');
  await expect(replies).toHaveCount(1);
  const partial = (await replies.first().innerText()).length;
  expect(partial).toBeGreaterThan(10);
  expect(partial).toBeLessThan(long.length);

  // 3. Restart the Hub → reload → the chat is still there → search finds "Hello".
  const chatUrl = page.url();
  await hub.stop();
  hub = await startHub({ port: PORT, dataDir: hub.dataDir });
  expect(hub.setupCode, 'no new setup link while a session exists').toBeNull();
  await page.goto(chatUrl);
  await expect(page.getByLabel('Messages')).toContainText('You said: Hello');
  await expect(page.getByLabel('Messages').getByText('Stopped')).toBeVisible();
  await page
    .getByRole('button', { name: /Search/ })
    .first()
    .click();
  await page.getByPlaceholder('Search chats').fill('Hello');
  await expect(page.getByLabel('Search results')).toContainText('Hello');

  // 4. Toggle theme → colors change.
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search commands' }).fill('Toggle light and dark');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .not.toBe(before);

  // Settings pages meet the accessibility baseline too (M1 exit criterion).
  await page.goto(`${hub.url}/settings/appearance`);
  await expect(page.getByRole('heading', { name: /Appearance/ })).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'settings');
});
