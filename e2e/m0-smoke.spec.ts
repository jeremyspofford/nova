import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { E2E_DATA_DIR } from '../playwright.config.ts';

// M0 exit criterion: the Hub serves the web shell; the command palette opens; the theme toggles.
function setupCode(): string {
  return execFileSync(process.execPath, ['apps/hub/src/main.ts', 'code'], {
    env: { ...process.env, NOVA_DATA_DIR: E2E_DATA_DIR },
  })
    .toString()
    .trim();
}

test.use({ colorScheme: 'light' });

test('first run: set up, open the palette, toggle the theme', async ({ page }) => {
  await page.goto(`/#setup=${setupCode()}`);
  await expect(page.getByText('Setup link detected')).toBeVisible();
  await page.getByLabel('Your name (optional)').fill('E2E');
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, E2E' })).toBeVisible();
  expect(page.url()).not.toContain('setup=');

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toContainText('No commands yet');
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  // Theme cycles System -> Light -> Dark. With the OS set to light, "System" already shows the
  // light theme, so the first visible change happens on the second click.
  const html = page.locator('html');
  const theme = page.getByRole('button', { name: /^Theme:/ });
  await expect(html).toHaveAttribute('data-theme', 'nova.light');
  await theme.click();
  await expect(theme).toHaveText('Theme: Light');
  await theme.click();
  await expect(theme).toHaveText('Theme: Dark');
  await expect(html).toHaveAttribute('data-theme', 'nova.dark');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(14, 15, 18)');

  // The choice is stored on the Hub, so a reload keeps it.
  const chosen = await html.getAttribute('data-theme');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', chosen ?? '');
});

test('the API refuses requests without a session', async ({ request }) => {
  const res = await request.get('/api/v1/settings');
  expect(res.status()).toBe(401);
});
