// Right-to-left layout (FR-016; docs/18 "RTL layout has no overlap/clipping on core screens").
// The Hub is switched to the right-to-left pseudo-locale `ar-XB` (every string mirrored) and to
// Arabic (`ar`, partly translated) through the `appearance.locale` setting, and the core screens
// are checked at a desktop and a phone size: the shell, a chat with a long thread and a code
// block, the composer, Settings (navigation, Appearance, Models, Permissions), the Marketplace,
// Work, a Code session with a diff, Devices, onboarding, the command palette and a dialog.
// On each: <html dir="rtl">, the sidebar at the inline start (the right), no sideways page
// overflow and nothing outside the viewport, no clipped text (overflow hidden without an
// ellipsis), and no two interactive controls overlapping. A screenshot of each screen is saved
// in the test output (test-results/, never committed).
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { createFixtureRepo } from './support/fixture-repo.ts';
import { startHub, type RunningHub } from './support/hub.ts';

const portFor = (parallelIndex: number) => 7821 + parallelIndex;
const DESKTOP = { width: 1366, height: 820 };
const TABLET = { width: 900, height: 700 };
const PHONE = { width: 390, height: 844 };

let hub: RunningHub;
/** The owner's session (cookies), the chat with the long thread and the code session. */
let ownerState: Awaited<ReturnType<BrowserContext['storageState']>>;
let threadPath = '/chat';
let sessionPath = '/code';

test.use({ colorScheme: 'light', viewport: DESKTOP });
test.describe.configure({ mode: 'serial' });

// ---- helpers ----------------------------------------------------------------------------------

/** Navigate inside the app (no reload), as a link in the app does. */
async function go(p: Page, path: string) {
  await p.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new Event('nova:navigate'));
  }, path);
}

/** Wait until the page stops loading: no busy region and no "Loading" text in the main area. */
async function settle(p: Page) {
  await expect
    .poll(
      () =>
        p.evaluate(() => {
          const main = document.querySelector('main') ?? document.body;
          if (main.querySelector('[aria-busy="true"]')) return false;
          const text = [...main.querySelectorAll('p, span, div')]
            .filter((e) => e.checkVisibility() && e.children.length === 0)
            .map((e) => (e.textContent ?? '').replace(/[\u200f\u202e\u202c]/g, ''));
          return !text.some((t) => /^\s*(Loading|Connecting|Checking)\b/.test(t));
        }),
      { timeout: 5_000 },
    )
    .toBe(true)
    .catch(() => undefined);
  await p.waitForTimeout(200);
}

/**
 * A name in any of the three locales: English, or `ar-XB`, which wraps every word in bidi
 * controls (RLM, RLO … PDF, RLM) and keeps its letters.
 */
function named(text: string): RegExp {
  const bidi = '[\\u200f\\u202e\\u202c]*';
  const words = text
    .split(/\s+/)
    .map((w) => bidi + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + bidi);
  return new RegExp(words.join('\\s+'));
}

/** A page signed in as the owner at this size. */
async function ownerPage(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({
    colorScheme: 'light',
    viewport,
    storageState: ownerState,
  });
  return { context, page: await context.newPage() };
}

async function setLocale(p: Page, locale: string) {
  const res = await p.request.patch(`${hub.url}/api/v1/settings`, {
    data: { key: 'appearance.locale', value: locale },
  });
  expect(res.ok(), `appearance.locale = ${locale}`).toBe(true);
}

/** Everything the layout check found on the current screen, as readable lines. */
async function layoutProblems(p: Page): Promise<string[]> {
  return p.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const describe = (el: Element) => {
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
          : '';
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? '')
        .replace(/[\u200f\u202e\u202c]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50);
      return `<${el.tagName.toLowerCase()}${cls}> "${name}"`;
    };
    const visible = (el: Element) =>
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
      el.getClientRects().length > 0;
    /** Visually hidden on purpose (screen-reader text), so neither clipped nor overlapping. */
    const srOnly = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return (
        (r.width <= 2 && r.height <= 2) ||
        cs.clipPath !== 'none' ||
        (cs.clip !== 'auto' && cs.position === 'absolute')
      );
    };
    /** The part of `el` its clipping ancestors leave visible (null when none is). */
    const shown = (el: Element): DOMRect | null => {
      let r = el.getBoundingClientRect();
      let left = r.left;
      let right = r.right;
      let top = r.top;
      let bottom = r.bottom;
      for (let a = el.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.position === 'fixed') break;
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          r = a.getBoundingClientRect();
          left = Math.max(left, r.left);
          right = Math.min(right, r.right);
          top = Math.max(top, r.top);
          bottom = Math.min(bottom, r.bottom);
        }
      }
      left = Math.max(left, 0);
      right = Math.min(right, vw);
      top = Math.max(top, 0);
      bottom = Math.min(bottom, window.innerHeight);
      return right - left > 0.5 && bottom - top > 0.5
        ? new DOMRect(left, top, right - left, bottom - top)
        : null;
    };

    // 1. The document is right to left.
    if (document.documentElement.dir !== 'rtl')
      out.push(`<html dir="${document.documentElement.dir}">, expected rtl`);

    // 2. The sidebar is at the inline start: the right edge (a phone shows it as a full page).
    const sidebar = document.querySelector('nav.sidebar');
    const main = document.querySelector('main');
    if (sidebar && visible(sidebar)) {
      const s = sidebar.getBoundingClientRect();
      if (Math.abs(s.right - vw) > 1)
        out.push(`sidebar ends at ${s.right}, not the right edge ${vw}`);
      const m = main?.getBoundingClientRect();
      if (m && s.width < vw - 1 && m.left > s.left)
        out.push(`main (${m.left}) is right of the sidebar (${s.left})`);
    }

    // 3. No sideways page overflow, and nothing visible outside the viewport. In right to left
    //    only the overflow to the left scrolls; what sticks out to the right is cut off, so
    //    every element is checked against the viewport unless a scroller or clipping box (not
    //    the page itself) holds it.
    const se = document.scrollingElement ?? document.documentElement;
    if (se.scrollWidth > se.clientWidth + 1)
      out.push(`the page scrolls sideways: ${se.scrollWidth} > ${se.clientWidth}`);
    const outside = new Set<Element>();
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el) || srOnly(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left >= -1 && r.right <= vw + 1) continue;
      let held = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (outside.has(a) || getComputedStyle(a).overflowX !== 'visible') held = true;
        if (held) break;
      }
      if (held) continue;
      outside.add(el);
      out.push(
        `outside the viewport (${Math.round(r.left)}..${Math.round(r.right)}): ${describe(el)}`,
      );
    }

    // 4. No clipped text: overflow hidden (or clip) without an ellipsis cutting off text.
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el) || srOnly(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'hidden' && cs.overflowX !== 'clip') continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const box = el.getBoundingClientRect();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim()) continue;
        const parent = n.parentElement;
        if (!parent || !visible(parent) || srOnly(parent)) continue;
        // Text truncated on purpose: an ellipsis or a line clamp on the way.
        let intended = false;
        for (let a: Element | null = parent; a && a !== el.parentElement; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none') intended = true;
          // A scroller inside `el` keeps its text reachable.
          if (a !== el && (s.overflowX === 'auto' || s.overflowX === 'scroll')) intended = true;
        }
        if (intended) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const rects = [...range.getClientRects()];
        if (rects.some((r) => r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1))) {
          out.push(`clipped text in ${describe(el)}: "${n.textContent.trim().slice(0, 40)}"`);
          break;
        }
      }
    }

    // 5. No two interactive controls overlap, in the top layer (an open dialog, or the page).
    //    Between phone and desktop sizes the open sidebar lies over the page like a dialog.
    const layer =
      [
        ...document.querySelectorAll(
          '[role="dialog"][aria-modal="true"], dialog[open], .app[data-layout="compact"][data-sidebar="open"] nav.sidebar',
        ),
      ]
        .filter(visible)
        .at(-1) ?? document.body;
    const controls = [
      ...layer.querySelectorAll(
        'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [role="separator"][tabindex], [tabindex="0"]',
      ),
    ].filter(
      (el) =>
        visible(el) &&
        !srOnly(el) &&
        !el.closest('[inert], [aria-hidden="true"]') &&
        getComputedStyle(el).pointerEvents !== 'none',
    );
    const boxes = controls.map((el) => ({ el, r: shown(el) }));
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i]!;
      if (!a.r) continue;
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j]!;
        if (!b.r || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        // A control and the label wrapping it count as one target.
        const la = a.el.closest('label');
        if (la && la === b.el.closest('label')) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 2 && h > 2)
          out.push(
            `overlap ${Math.round(w)}x${Math.round(h)}: ${describe(a.el)} and ${describe(b.el)}`,
          );
      }
    }
    return [...new Set(out)];
  });
}

/** Check the current screen and save its screenshot; problems fail softly so all are listed. */
async function check(p: Page, testInfo: TestInfo, name: string) {
  await settle(p);
  const problems = await layoutProblems(p);
  await p.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  expect.soft(problems, `layout of ${name}`).toEqual([]);
}

// ---- the Hub, a long thread and a code session (made once, in English) --------------------------

const CODE = [
  'Here is the function, with a comment longer than the column:',
  '',
  '```js',
  'export function add(a, b) {',
  '  return a + b; // adds two numbers; this comment runs well past the edge of the reply column so the block scrolls',
  '}',
  '```',
].join('\n');
const THREAD = [
  'Hello',
  'مرحبا، كيف حالك اليوم؟ هذه رسالة باللغة العربية لاختبار الاتجاه.',
  CODE,
  'A long address without spaces: https://example.com/a/very/long/path/that/keeps/going/and/going/without/any/break/at/all',
  'Mixed: the file src/math.js has 2 functions and the model local-test:1b answered in 3 seconds.',
  'One more message so the thread is long enough to scroll on a phone, with a few more words in it.',
];

const it = test.extend<object, { setup: void }>({
  setup: [
    async ({ browser }, use, workerInfo) => {
      hub = await startHub({ port: portFor(workerInfo.parallelIndex) });
      const ctx = await browser.newContext({ colorScheme: 'light', viewport: DESKTOP });
      const page = await ctx.newPage();
      await page.goto(`${hub.url}/#setup=${hub.setupCode}`);
      await page.getByRole('button', { name: 'Finish setup' }).click();
      await page.getByRole('button', { name: 'Skip setup' }).click();

      // A long thread (the offline Mock echoes each message) with a code block in a reply.
      await page
        .getByRole('button', { name: /New chat/ })
        .first()
        .click();
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      const messages = page.getByLabel('Messages');
      for (const text of THREAD) {
        await composer.fill(text);
        await composer.press('Enter');
        await expect(messages).toContainText(`You said: ${text.slice(0, 16)}`);
        await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
      }
      await expect(messages.locator('pre').first()).toBeVisible();
      threadPath = new URL(page.url()).pathname;

      // A Code session in a fixture repository with two edited files in its diff.
      const fx = createFixtureRepo();
      await page.goto(`${hub.url}/code`);
      await page.getByRole('button', { name: 'New session' }).click();
      const dialog = page.getByRole('dialog', { name: 'New Code session' });
      await dialog.getByLabel('Folder path on the Hub').fill(fx.repo);
      await dialog.getByLabel('Permission mode').selectOption('accept_edits');
      await dialog.getByLabel('Title (optional)').fill('Calc fix');
      await dialog.getByRole('button', { name: 'Start session' }).click();
      await expect(page).toHaveURL(/\/code\/[^/]+$/);
      const session = page.getByRole('region', { name: 'Code session: Calc fix' });
      const patch = (path: string, lines: string[]) =>
        `/tool fs.edit ${JSON.stringify({ patch: ['%%% patch', `%%% update ${path}`, '@@', ...lines, '%%% end'].join('\n') })}`;
      const box = session.getByRole('textbox', { name: 'Message', exact: true });
      await box.fill(
        [
          'Fix the failing test.',
          patch('src/math.js', ['-  return a - b;', '+  return a + b;']),
          patch('src/label.js', ["-  return n + ' item';", "+  return n + ' items';"]),
        ].join('\n'),
      );
      await box.press('Enter');
      await expect(session.getByRole('tab', { name: 'Diff (2)' })).toBeVisible({ timeout: 30_000 });
      sessionPath = new URL(page.url()).pathname;
      ownerState = await ctx.storageState();
      await ctx.close();

      await use();
      await hub.stop();
    },
    { scope: 'worker', auto: true, timeout: 180_000 },
  ],
});

/** The core screens, in the current locale and viewport. */
async function sweep(page: Page, testInfo: TestInfo, tag: string) {
  const phone = (page.viewportSize()?.width ?? 0) < 640;
  await page.goto(`${hub.url}${threadPath}`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByLabel(named('Messages')).locator('pre').first()).toBeVisible();
  await check(page, testInfo, `${tag}-chat-thread`);

  // The code block stays left to right inside the right-to-left reply.
  const pre = page.getByLabel(named('Messages')).locator('pre').first();
  expect.soft(await pre.evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');

  // The composer, with Arabic text typed in (it follows the text's own direction).
  const composer = page.getByRole('textbox', { name: named('Message') }).first();
  const direction = () => composer.evaluate((el) => getComputedStyle(el).direction);
  expect.soft(await composer.evaluate((el) => (el as HTMLElement).dir)).toBe('auto');
  expect.soft(await direction(), 'an empty composer reads right to left').toBe('rtl');
  await composer.fill('Hello there');
  expect.soft(await direction(), 'English typed in reads left to right').toBe('ltr');
  await composer.fill('مرحبا بالعالم');
  expect.soft(await direction()).toBe('rtl');
  await check(page, testInfo, `${tag}-composer`);
  await composer.fill('');

  // The shell with the sidebar open (a phone shows it as a full page).
  if (phone) {
    const menu = page.locator('button[aria-controls="sidebar"]');
    await menu.click();
    await expect(page.locator('nav.sidebar')).toBeVisible();
    await check(page, testInfo, `${tag}-sidebar`);
    await menu.click();
  }

  // The command palette.
  await page
    .locator('main')
    .first()
    .click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Control+k');
  const search = page.locator('.palette-input');
  await expect(search).toBeFocused();
  await search.fill('a');
  await check(page, testInfo, `${tag}-command-palette`);
  await page.keyboard.press('Escape');

  for (const [path, name] of [
    ['/settings/general', 'settings-nav'],
    ['/settings/appearance', 'settings-appearance'],
    ['/settings/models', 'settings-models'],
    ['/settings/permissions', 'settings-permissions'],
    ['/marketplace/plugins', 'marketplace'],
    ['/work', 'work'],
    [sessionPath, 'code-session'],
    ['/devices', 'devices'],
    ['/onboarding', 'onboarding'],
  ] as const) {
    await go(page, path);
    await check(page, testInfo, `${tag}-${name}`);
  }

  // A dialog: New Code session.
  await go(page, '/code');
  await settle(page);
  await page
    .getByRole('button', { name: named('New session') })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await check(page, testInfo, `${tag}-dialog`);
  await page.keyboard.press('Escape');
}

it('the layout check finds a misplaced sidebar, overflow, clipped text and overlap', async ({
  browser,
}) => {
  // A check that never fails proves nothing: it must see each kind of defect on a page made
  // to have them, and pass what is intended (an ellipsis, a scroller, screen-reader text).
  const context = await browser.newContext({ viewport: { width: 600, height: 400 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html dir="rtl"><body style="margin:0">
    <nav class="sidebar" style="position:absolute;left:0;top:0;width:100px;height:100px"></nav>
    <main style="position:absolute;right:0;top:0;width:400px;height:300px">
      <button style="position:absolute;left:10px;top:10px;width:80px;height:30px">One</button>
      <button style="position:absolute;left:40px;top:20px;width:80px;height:30px">Two</button>
      <p style="width:60px;overflow:hidden;white-space:nowrap">A sentence too long for its box</p>
      <p style="width:60px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">Cut on purpose</p>
      <div style="width:60px;overflow-x:auto;white-space:nowrap">A long line that scrolls</div>
      <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)">Hidden label text</span>
      <div style="position:absolute;right:-300px;top:200px;width:100px">Out of view</div>
      <div style="position:absolute;left:-300px;top:250px;width:100px">Off to the left</div>
    </main></body></html>`);
  const found = (await layoutProblems(page)).join('\n');
  expect(found).toMatch(/sidebar ends at 100, not the right edge/);
  expect(found).toMatch(/the page scrolls sideways/);
  expect(found).toMatch(/outside the viewport .*"Out of view"/);
  expect(found).toMatch(/outside the viewport .*"Off to the left"/);
  expect(found).toMatch(/clipped text .*"A sentence too long for its box"/);
  expect(found).toMatch(/overlap \d+x\d+: <button> "One" and <button> "Two"/);
  expect(found).not.toMatch(/Cut on purpose|A long line that scrolls|Hidden label text/);
  await page.evaluate(() => document.documentElement.setAttribute('dir', 'ltr'));
  expect((await layoutProblems(page)).join('\n')).toMatch(/<html dir="ltr">, expected rtl/);
  await context.close();
});

it('ar-XB at desktop size: every core screen mirrors without overlap or clipping', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const { context, page } = await ownerPage(browser, DESKTOP);
  await setLocale(page, 'ar-XB');
  await sweep(page, testInfo, 'ar-XB-desktop');
  await context.close();
});

it('ar-XB at phone size: every core screen mirrors without overlap or clipping', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const { context, page } = await ownerPage(browser, PHONE);
  await setLocale(page, 'ar-XB');
  await sweep(page, testInfo, 'ar-XB-phone');
  await context.close();
});

it('Arabic shell at desktop, tablet and phone size', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const { context, page } = await ownerPage(browser, DESKTOP);
  await setLocale(page, 'ar');
  for (const [size, viewport] of [
    ['desktop', DESKTOP],
    ['tablet', TABLET],
    ['phone', PHONE],
  ] as const) {
    await page.setViewportSize(viewport);
    await page.goto(`${hub.url}${threadPath}`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await check(page, testInfo, `ar-${size}-chat`);
    if (size === 'tablet') {
      // The collapsed sidebar opens over the content from the right.
      const toggle = page.locator('button[aria-controls="sidebar"]');
      await toggle.click();
      await expect(page.locator('nav.sidebar')).toBeVisible();
      await check(page, testInfo, `ar-${size}-sidebar-open`);
      await toggle.click();
    }
    await go(page, '/settings/appearance');
    await check(page, testInfo, `ar-${size}-settings-appearance`);
    await go(page, '/marketplace/plugins');
    await check(page, testInfo, `ar-${size}-marketplace`);
  }
  await context.close();
});
