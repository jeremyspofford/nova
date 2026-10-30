// The M3 gate drives the real PWA in Chromium against the real server process. Chromium is found
// at $CHROMIUM, or where `playwright-core install chromium` puts it. With no usable browser the
// suite is skipped with a loud notice on a developer machine, and fails in CI: the gate never
// passes by not running. scripts/ui-test.sh runs it in a container that has the browser.
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { ROOT, blank } from '../acceptance/support.ts';

export { ROOT, blank };

const CI = !!process.env.CI;

// Where the test's Chromium is (also handed to Nova's browser worker as NOVA_CHROMIUM).
export const chromiumPath = (): string => process.env.CHROMIUM || chromium.executablePath();

// The browser, or a reason there isn't one.
export async function browser(): Promise<Browser | string> {
  const path = chromiumPath();
  if (!path || !existsSync(path)) return missing(`no Chromium at ${path || '(none)'}`);
  try {
    return await chromium.launch({ executablePath: path, args: ['--disable-background-networking'] });
  } catch (e) {
    return missing(`Chromium at ${path} would not start: ${(e as Error).message.split('\n')[0]}`);
  }
}

function missing(why: string): string {
  if (CI) throw new Error(`The M3 UI gate needs a browser in CI: ${why}`);
  const line = '!'.repeat(78);
  console.error(`\n${line}\n  M3 UI GATE SKIPPED: ${why}.\n  Run scripts/ui-test.sh (Docker) or set CHROMIUM=/path/to/chrome.\n${line}\n`);
  return why;
}

// Where evidence screenshots go: only when NOVA_UI_SHOTS names a folder (scripts/ui-test.sh sets
// docs/screenshots/m3), so a plain test run never rewrites tracked files.
export function shotsDir(): string | null {
  const dir = process.env.NOVA_UI_SHOTS;
  if (!dir) return null;
  const abs = resolve(ROOT, dir);
  mkdirSync(abs, { recursive: true });
  return abs;
}

// A browser context is one device: it gets its own device id, as the PWA keeps it in localStorage.
export async function device(b: Browser, { width = 1280, height = 820, id = `ui-test-${Math.random().toString(36).slice(2, 10)}` } = {}): Promise<{ ctx: BrowserContext; page: Page; id: string; errors: string[] }> {
  const ctx = await b.newContext({ viewport: { width, height }, colorScheme: 'light' });
  await ctx.addInitScript((d) => { try { localStorage.setItem('nova.device', d); } catch { /* a sandboxed frame */ } }, id);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return { ctx, page, id, errors };
}

export const ready = (page: Page) => page.waitForSelector('html[data-ready]');
// Before a screenshot: every finite animation (an entrance, a fade) has finished. The orb's
// breathing never finishes, so it doesn't count.
export const still = (page: Page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
export const shoot = async (page: Page, path: string) => { await still(page); await page.screenshot({ path }); };
export const cssVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase(), name);

// Setup answered over the API, for tests about everything after it.
export async function finishSetup(m: ReturnType<typeof blank>) {
  for (const text of ['Hi, I am Alex.', 'yes', 'keep', 'plainly', 'keep everything on this machine', 'no']) {
    const r = await m.send('POST', '/api/v1/setup/messages', { text });
    if (r.status !== 200) throw new Error(`setup answer "${text}" failed: ${JSON.stringify(r.body)}`);
  }
}
