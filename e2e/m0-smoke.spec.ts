import { expect, test } from '@playwright/test';

// The Hub started by playwright.config.ts serves the UI and refuses unauthenticated API calls.
test('serves the web shell', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Nova');
});

test('the API refuses requests without a session', async ({ request }) => {
  const res = await request.get('/api/v1/settings');
  expect(res.status()).toBe(401);
});
