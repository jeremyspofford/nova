// The design review's screenshots (DESIGN-SYSTEM §0, OPERATING-RULES "Design-first"): the main
// surfaces and the styleguide, in the lead package (Orb Teal), at a desktop's width and a phone's,
// against the UX review's seeded profile, plus onboarding on a blank one and the composer grown by
// a long message (UX review F0). Not a gate: it writes pictures for a person to look at.
//   node tests/ui/design-shots.ts <folder>      (in scripts/ui-test.sh's image, which has the browser)
// Each styleguide entry is also captured on its own, from its anchor (#sg-<entry>), so the owner can
// approve one entry at a time.
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { ROOT, blank, browser, device, still } from './support.ts';
import { reviewProfile } from './axe-support.ts';
import { withMesh } from './fold-support.ts';

const out = resolve(ROOT, process.argv[2] ?? 'docs/screenshots/design-quality/after');
mkdirSync(out, { recursive: true });
const SIZES = { desktop: { width: 1440, height: 900, touch: false }, phone: { width: 390, height: 844, touch: true } } as const;
const VIEWS: [string, string][] = [['home', '/'], ['chat', '/chat'], ['tasks', '/tasks'], ['health', '/health'], ['activity', '/activity'], ['settings', '/settings'], ['appearance', '/settings#appearance']];

async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('html[data-ready]', { timeout: 20_000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[data-skeleton]'), null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(600);
  await still(page);
}

async function surfaces(b: Browser, base: string) {
  for (const [size, s] of Object.entries(SIZES)) {
    const d = await device(b, { ...s, scheme: 'dark', serviceWorkers: 'block' });
    await withMesh(d.ctx);
    await d.page.clock.setFixedTime(new Date('2026-10-31T12:00:00.000Z'));
    for (const [name, path] of VIEWS) {
      await open(d.page, base + path);
      await d.page.screenshot({ path: join(out, `${name}-${size}.png`), animations: 'disabled', caret: 'hide' });
    }
    // F0: the composer with a long message in it.
    await open(d.page, `${base}/chat`);
    const box = d.page.locator('#composer textarea').first();
    if (await box.count()) {
      await box.fill(Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of a long note about the week: what is due, what is waiting on someone else, and what can wait.`).join('\n'));
      await d.page.waitForTimeout(300);
      await d.page.screenshot({ path: join(out, `composer-long-${size}.png`), animations: 'disabled', caret: 'hide' });
    }
    // The styleguide, whole, and on a desktop each entry on its own.
    await open(d.page, `${base}/styleguide`);
    await d.page.waitForSelector('.sg-section', { timeout: 15_000 });
    await d.page.waitForTimeout(400);
    await d.page.screenshot({ path: join(out, `styleguide-${size}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
    if (size === 'desktop') {
      const ids = await d.page.$$eval('.sg-entry[id^="sg-"]', (xs) => xs.map((x) => x.id));
      if (ids.length) mkdirSync(join(out, 'styleguide'), { recursive: true });
      for (const id of ids) {
        const el = d.page.locator(`#${id}`);
        await el.scrollIntoViewIfNeeded();
        await el.screenshot({ path: join(out, 'styleguide', `${id.slice(3)}.png`), animations: 'disabled', caret: 'hide' }).catch((e) => console.log(`${id}: ${(e as Error).message.split('\n')[0]}`));
      }
    }
    await d.ctx.close();
  }
}

// Onboarding: the first screen a blank profile shows.
async function onboarding(b: Browser) {
  const m = blank('nova-design-onboard-');
  const nova = await m.start();
  try {
    for (const [size, s] of Object.entries(SIZES)) {
      const d = await device(b, { ...s, scheme: 'dark', serviceWorkers: 'block' });
      await d.page.goto(`${m.base}/`, { waitUntil: 'load' });
      await d.page.waitForSelector('#setup:not([hidden])', { timeout: 20_000 });
      await d.page.waitForTimeout(800);
      await still(d.page);
      await d.page.screenshot({ path: join(out, `onboarding-${size}.png`), animations: 'disabled', caret: 'hide' });
      await d.ctx.close();
    }
  } finally {
    await stop(nova);
    rmSync(m.dir, { recursive: true, force: true });
  }
}

const b = await browser();
if (typeof b === 'string') { console.log(`design shots: no browser (${b})`); process.exit(1); }
const { m, nova } = await reviewProfile('nova-design-shots-');
try {
  await surfaces(b, m.base);
  await onboarding(b);
} finally {
  await b.close();
  await stop(nova);
  rmSync(m.dir, { recursive: true, force: true });
}
console.log(`design shots written to ${out}`);
process.exit(0);
