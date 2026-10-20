// Accessibility sweep (FR-015, WCAG 2.2 AA; docs/04 §4.4, docs/18 §5).
// 1. axe with every WCAG 2.0, 2.1 and 2.2 A and AA rule on every top-level surface, every Settings
//    section and the key dialogs: as the owner, as a member, on a phone, and in the dark and
//    high-contrast themes. A violation of any impact fails.
// 2. What axe cannot check: the keyboard walk of the shell (order, skip link, no trap, Escape
//    returns focus), visible focus rings, focus not obscured, target size, drag alternatives,
//    reduced motion, reflow at 320 px, text spacing, accessible authentication and status
//    messages. One Hub and one owner page serve the whole file.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { SETTINGS_SECTIONS } from '../apps/web/src/router.ts';
import { installA11yProbes, type FocusStop } from './support/a11y-probes.ts';
import { startFakeOllama, type FakeServer } from './support/fake-providers.ts';
import { startHub, type RunningHub } from './support/hub.ts';
import { freePort } from './support/m65.ts';
import { policyFile, writePolicy } from './support/m8.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Confirmed axe false positives, each with its reason. A node is left out only when its rule and
 * its target match. Keep this list short; a real violation is fixed, never listed.
 */
const FALSE_POSITIVES: readonly { rule: string; target: RegExp; reason: string }[] = [];

/** Every marketplace tab (apps/web/src/market/format.ts MARKET_TABS). */
const MARKET_TABS = ['plugins', 'skills', 'themes', 'pets', 'mcp', 'installed', 'catalogs'];
/** Every Network section (apps/web/src/netsurface/format.ts NETWORK_SECTIONS). */
const NETWORK_SECTIONS = ['overview', 'setup', 'trust', 'relay', 'wake'];

let hub: RunningHub;
let ollama: FakeServer;
let ctx: BrowserContext;
let page: Page;
/** The chat with a thread every check returns to. */
let threadPath = '/chat';
/** The test policy file the Hub reads (empty until the last test locks every setting). */
let policyPath = '';

test.use({ colorScheme: 'light' });

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
            .map((e) => e.textContent ?? '');
          return !text.some((t) => /^\s*(Loading|Connecting|Checking)\b/.test(t));
        }),
      { timeout: 5_000 },
    )
    .toBe(true)
    .catch(() => undefined);
  await p.waitForTimeout(150);
}

type Violations = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'];

function describeViolations(violations: Violations): string[] {
  const out: string[] = [];
  for (const v of violations) {
    const nodes = v.nodes.filter(
      (n) =>
        !FALSE_POSITIVES.some(
          (f) => f.rule === v.id && f.target.test(n.target.map(String).join(' ')),
        ),
    );
    if (!nodes.length) continue;
    const shown = nodes
      .slice(0, 8)
      .map(
        (n) => `  ${n.target.join(' ')}\n    ${(n.failureSummary ?? '').replace(/\n/g, '\n    ')}`,
      )
      .join('\n');
    const more = nodes.length > 8 ? `\n  …and ${nodes.length - 8} more` : '';
    out.push(`${v.id} (${v.impact ?? 'n/a'}): ${v.help}\n${shown}${more}`);
  }
  return out;
}

/** axe with every WCAG A and AA tag; every violation of any impact fails (softly, to list all). */
async function scan(p: Page, where: string) {
  await settle(p);
  const result = await new AxeBuilder({ page: p }).withTags(TAGS).analyze();
  expect.soft(describeViolations(result.violations), `axe on ${where}`).toEqual([]);
}

/** Placeholder text (4.5:1) and text field edges (3:1, WCAG 1.4.11), which axe does not check. */
async function fields(p: Page, where: string) {
  expect
    .soft(await p.evaluate(() => window.__a11y.fieldContrast()), `field contrast on ${where}`)
    .toEqual([]);
}

/** A Hub setting, through the Hub's API with this page's session. */
async function setSetting(p: Page, key: string, value: unknown) {
  await p.evaluate(
    async ([k, v]) => {
      const res = await fetch('/api/v1/settings', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ key: k, value: v }),
      });
      if (!res.ok) throw new Error(`setting ${String(k)}: ${res.status} ${await res.text()}`);
    },
    [key, value] as const,
  );
}

/** A page of a new context signed in as the owner (the owner's cookies), with the probes. */
async function ownerPage(
  browser: Browser,
  opts: Parameters<Browser['newContext']>[0] = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    colorScheme: 'light',
    ...opts,
    storageState: await ctx.storageState(),
  });
  await installA11yProbes(context);
  return { context, page: await context.newPage() };
}

async function reloadAt(p: Page, path: string) {
  await p.goto(`${hub.url}${path}`);
  await expect(p.locator('main').first()).toBeVisible();
  await settle(p);
}

/**
 * Tab (or Shift+Tab) until focus leaves the page or comes back to where it started. A key press
 * a component uses once without moving focus (the composer takes a suggested follow-up with Tab,
 * docs/04 §2.2) is noted; focus that stays put for three presses, or that comes back to an
 * earlier stop, is a trap.
 */
async function tabWalk(p: Page, key: 'Tab' | 'Shift+Tab', max = 300) {
  const stops: FocusStop[] = [];
  const consumed: string[] = [];
  const seen = new Set<string>();
  let still = 0;
  for (let i = 0; i < max; i++) {
    await p.keyboard.press(key);
    const s = await p.evaluate(() => window.__a11y.focusState());
    if (!s) return { stops, consumed, ended: 'left the page' as const };
    if (s.key === stops.at(-1)?.key) {
      consumed.push(s.desc);
      if (++still >= 3) return { stops, consumed, ended: 'trapped' as const, at: s };
      continue;
    }
    still = 0;
    if (seen.has(s.key))
      return {
        stops,
        consumed,
        ended: s.key === stops[0]?.key ? ('wrapped' as const) : ('trapped' as const),
        at: s,
      };
    seen.add(s.key);
    stops.push(s);
  }
  return { stops, consumed, ended: 'too many stops' as const };
}

const RANK: Record<string, number> = {
  skip: 0,
  topbar: 1,
  sidebar: 2,
  main: 3,
  composer: 3,
  inspector: 4,
  other: 5,
};

// ---- lifecycle --------------------------------------------------------------------------------

/** axe findings of the setup and onboarding steps, made once per worker (the first test asserts). */
const setupFindings: [string, string[]][] = [];

async function findings(p: Page): Promise<string[]> {
  await settle(p);
  return describeViolations(
    (await new AxeBuilder({ page: p }).withTags(TAGS).analyze()).violations,
  );
}

/**
 * One Hub and one owner page per worker: set up through the setup link and onboarding (scanned on
 * the way), a fake local model server added through Add a provider, and a chat with one reply. A
 * failed test restarts the worker, so the remaining tests still run (on a fresh Hub).
 */
const it = test.extend<object, { owner: void }>({
  owner: [
    async ({ browser }, use) => {
      ollama = await startFakeOllama('local-test:1b');
      // A port the system picks, so this never collides with another run on the machine.
      // The Hub honours a test policy file (support/m8.ts), empty until the last test fills it.
      policyPath = policyFile();
      writePolicy(policyPath, { version: 1, serial: 1 });
      hub = await startHub({
        port: await freePort(),
        env: { NOVA_MANAGED_SETTINGS_FILE: policyPath },
        args: ['--allow-test-policy'],
      });
      ctx = await browser.newContext({ colorScheme: 'light' });
      await installA11yProbes(ctx);
      page = await ctx.newPage();
      setupFindings.length = 0;

      await page.goto(`${hub.url}/#setup=${hub.setupCode}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Set up Nova' })).toBeVisible();
      setupFindings.push(['setup', await findings(page)]);
      await page.getByRole('button', { name: 'Finish setup' }).click();
      // Onboarding, each step.
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      setupFindings.push(['onboarding: provider', await findings(page)]);
      await page.getByRole('button', { name: 'Continue' }).click();
      setupFindings.push(['onboarding: default model', await findings(page)]);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByLabel('Display name').fill('Jordan');
      setupFindings.push(['onboarding: profile', await findings(page)]);
      await page.getByRole('button', { name: 'Continue' }).click();
      setupFindings.push(['onboarding: tools', await findings(page)]);
      await page.getByRole('button', { name: 'Continue' }).click();
      setupFindings.push(['onboarding: sample', await findings(page)]);
      await page.getByRole('button', { name: 'Finish without the sample' }).click();
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/chat/);

      // A fake local server as a second provider, through the Add a provider dialog.
      await go(page, '/settings/accounts');
      await page.getByRole('button', { name: 'Add a provider' }).click();
      await page.getByRole('radio', { name: 'Ollama' }).check();
      await page.getByLabel('Name', { exact: true }).fill('Local test');
      const advanced = page.locator('summary', { hasText: 'Advanced' });
      if (await advanced.isVisible()) await advanced.click();
      await page.getByLabel('Base URL').fill(ollama.url);
      setupFindings.push(['dialog: add a provider', await findings(page)]);
      await page.getByRole('button', { name: 'Save and test' }).click();
      await expect(page.getByText('Local test connected')).toBeVisible();

      // A chat with a thread, answered by the fake server (the default model once it was added).
      await go(page, '/chat');
      await page
        .getByRole('button', { name: /New chat/ })
        .first()
        .click();
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      await composer.fill('Hello');
      await composer.press('Enter');
      await expect(page.getByLabel('Messages')).toContainText('Seen 1 user messages');
      threadPath = new URL(page.url()).pathname;
      expect(threadPath).toMatch(/^\/chat\/.+/);

      await use();

      await ctx.close();
      await hub.stop();
      await ollama.stop();
    },
    { scope: 'worker', auto: true, timeout: 120_000 },
  ],
});

// ---- 1. axe -----------------------------------------------------------------------------------

it('setup, onboarding and the Add a provider dialog', () => {
  for (const [where, found] of setupFindings) expect.soft(found, `axe on ${where}`).toEqual([]);
});

it('every top-level surface (owner)', async () => {
  test.setTimeout(180_000);
  await go(page, threadPath);
  await scan(page, 'chat with a thread');
  await fields(page, 'chat with a thread');
  const surfaces: [string, string][] = [
    ['/chat', 'new chat'],
    ['/work', 'work'],
    ['/work/scheduled', 'work: scheduled'],
    ['/code', 'code'],
    ['/agents', 'agents'],
    ['/projects', 'projects'],
    ['/library', 'library'],
    ['/spaces', 'spaces'],
    ['/sites', 'sites'],
    ['/apps', 'apps'],
    ...MARKET_TABS.map((t): [string, string] => [`/marketplace/${t}`, `marketplace: ${t}`]),
    ['/computers', 'computers'],
    ['/devices', 'devices'],
    ['/devices/add', 'devices: add a device'],
    ...NETWORK_SECTIONS.map((s): [string, string] => [`/network/${s}`, `network: ${s}`]),
    ['/approvals', 'approvals'],
    ['/team/shared', 'team: shared'],
    ['/team/agents', 'team: agents'],
    ['/onboarding', 'onboarding (revisited)'],
  ];
  for (const [path, where] of surfaces) {
    await go(page, path);
    await scan(page, where);
    // Each page names the browser tab (2.4.2).
    expect.soft(await page.title(), `title of ${where}`).toMatch(/^\S.* - Nova$/);
  }
});

it('every Settings section (owner)', async () => {
  test.setTimeout(180_000);
  for (const section of SETTINGS_SECTIONS) {
    await go(page, `/settings/${section}`);
    await expect(
      page.getByRole('navigation', { name: 'Settings sections' }).locator('a[aria-current="page"]'),
    ).toHaveAttribute('href', `/settings/${section}`);
    await scan(page, `settings: ${section}`);
    await fields(page, `settings: ${section}`);
  }
});

it('key dialogs and menus (owner); Escape returns focus to the opener', async () => {
  test.setTimeout(120_000);
  await go(page, threadPath);
  await settle(page);

  // The command palette, from the top bar.
  const commands = page.getByRole('button', { name: 'Commands', exact: true });
  await commands.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Search commands' })).toBeFocused();
  await scan(page, 'dialog: command palette');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();
  await expect.soft(commands).toBeFocused();

  // A menu (the account menu) and the notification center.
  const account = page.getByRole('button', { name: 'Account: Jordan' });
  await account.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: 'Account: Jordan' })).toBeVisible();
  await scan(page, 'menu: account');
  await page.keyboard.press('Escape');
  await expect.soft(account).toBeFocused();
  const bell = page.getByRole('button', { name: /^Notifications/ }).first();
  await bell.click();
  await scan(page, 'notification center');
  await page.keyboard.press('Escape');

  // A confirmation dialog: delete a chat, from its row menu. Focus starts on Cancel.
  const more = page.getByRole('button', { name: 'Actions for Hello' });
  await more.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this chat?' });
  await expect(confirm).toBeVisible();
  await expect.soft(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await scan(page, 'dialog: delete a chat');
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect.soft(more).toBeFocused();

  // The extension install preview (a signed sample bundle from the repository).
  await go(page, '/settings/extensions');
  await settle(page);
  const choose = page.getByRole('button', { name: /Choose a .novax file/i });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), choose.click()]);
  await chooser.setFiles('examples/catalog/word-count-1.0.0.novax');
  const preview = page.getByRole('dialog');
  await expect(preview).toBeVisible();
  await scan(page, 'dialog: extension install preview');
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect.soft(choose).toBeFocused();

  // Delete-all asks for the Hub's name.
  await go(page, '/settings/data');
  await settle(page);
  const deleteAll = page.getByRole('button', { name: 'Delete all data…' });
  await deleteAll.click();
  const wipe = page.getByRole('dialog', { name: 'Delete everything on this Hub?' });
  await expect(wipe).toBeVisible();
  await scan(page, 'dialog: delete all data');
  await page.keyboard.press('Escape');
  await expect(wipe).toBeHidden();
  await expect.soft(deleteAll).toBeFocused();

  // The theme editor: colors, and a theme to import with its contrast check.
  await go(page, '/settings/appearance');
  await settle(page);
  await page.getByLabel('Theme link or theme JSON').fill(
    JSON.stringify({
      schemaVersion: 1,
      id: 'user.sweep',
      name: 'Sweep pale',
      variant: 'light',
      extends: 'nova.light',
      tokens: { '--u-text-muted': '#c8c8c8' },
    }),
  );
  await page.getByRole('button', { name: 'Check theme' }).click();
  await expect(
    page.getByRole('group', { name: 'Theme to import' }).or(page.getByRole('alert')),
  ).toBeVisible();
  await scan(page, 'theme editor: import check');

  // The consent page a third-party app sends the owner to.
  const clientId = await page.evaluate(async () => {
    const res = await fetch('/api/v1/apps/register', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        name: 'Sweep notes',
        redirectUris: ['http://127.0.0.1:8765/callback'],
        scopes: ['threads:read', 'projects:read'],
      }),
    });
    if (!res.ok) throw new Error(`register: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { client_id: string }).client_id;
  });
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'http://127.0.0.1:8765/callback',
    scope: 'threads:read projects:read',
    state: 'sweep-state',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  });
  await go(page, `/authorize?${q.toString()}`);
  await expect(page.getByRole('heading', { name: /Sweep notes/ }).first()).toBeVisible();
  await scan(page, 'app consent page');
});

// ---- 2. keyboard, focus -----------------------------------------------------------------------

it('keyboard: skip link, tab order, no trap, visible and unobscured focus', async () => {
  test.setTimeout(150_000);
  // The companion is on, so the check covers what it could hide.
  await setSetting(page, 'appearance.pet', 'sprout');
  await reloadAt(page, threadPath);
  await expect(page.locator('.pet')).toBeVisible();

  // The first Tab reaches the skip link, which is shown and moves focus to the main area.
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  const box = await skip.boundingBox();
  expect(box && box.y >= 0 && box.y + box.height <= 844, 'skip link on screen').toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await page.keyboard.press('Tab');
  expect((await page.evaluate(() => window.__a11y.focusState()))?.region).toMatch(/main|composer/);

  for (const path of [threadPath, '/settings/general']) {
    await reloadAt(page, path);
    const forward = await tabWalk(page, 'Tab');
    if (process.env.A11Y_DEBUG)
      console.log(
        `WALK ${path} ${forward.ended} at ${'at' in forward ? forward.at?.desc : ''}\n${forward.stops
          .map((s) => `  ${s.key} ${s.region} ${s.desc}`)
          .join('\n')}`,
      );
    expect
      .soft(forward.ended, `${path}: Tab ends (stops: ${forward.stops.length})`)
      .not.toBe('trapped');
    expect.soft(forward.ended, `${path}: Tab ends`).not.toBe('too many stops');
    const regions = forward.stops.map((s) => s.region);
    for (const r of ['skip', 'topbar', 'sidebar', 'main'])
      expect.soft(regions, `${path}: Tab reaches ${r}`).toContain(r);
    if (path === threadPath)
      expect.soft(regions, `${path}: Tab reaches the composer`).toContain('composer');
    // Regions come in reading order: skip link, top bar, sidebar, main (composer), inspector.
    const order = forward.stops.filter(
      (s, i) => i > 0 && RANK[s.region]! < RANK[forward.stops[i - 1]!.region]!,
    );
    expect
      .soft(
        order.map((s) => `${s.region}: ${s.desc}`),
        `${path}: focus never goes back to an earlier region`,
      )
      .toEqual([]);
    expect
      .soft(
        forward.stops.filter((s) => s.indicator).map((s) => `${s.desc}: ${s.indicator}`),
        `${path}: every focus stop shows a ring of at least 2px at 3:1`,
      )
      .toEqual([]);
    expect
      .soft(
        forward.stops.filter((s) => s.obscured).map((s) => s.desc),
        `${path}: no focused element is hidden behind other content`,
      )
      .toEqual([]);
    // Shift+Tab walks the same stops backwards (those still on the page: the composer's
    // follow-up chips go once it holds text).
    const back = await tabWalk(page, 'Shift+Tab');
    const present = await page.evaluate(
      (keys) =>
        keys.filter((k) => document.querySelector(`[data-a11y-walk="${k}"]`)?.checkVisibility()),
      forward.stops.map((s) => s.key),
    );
    expect
      .soft(
        back.stops.map((s) => s.key),
        `${path}: Shift+Tab is Tab reversed`,
      )
      .toEqual(present.reverse());
  }
  await setSetting(page, 'appearance.pet', 'off');
});

it('target size: 24 by 24 px or spaced (shell, chat, settings)', async () => {
  test.setTimeout(120_000);
  await reloadAt(page, threadPath);
  // Message actions show on hover and focus.
  await page.getByLabel('Messages').locator('.msg').last().hover();
  if (process.env.A11Y_DEBUG)
    console.log(
      `SMALL chat\n  ${(await page.evaluate(() => window.__a11y.smallTargets())).join('\n  ')}`,
    );
  expect.soft(await page.evaluate(() => window.__a11y.targetSize()), 'chat').toEqual([]);
  for (const section of SETTINGS_SECTIONS) {
    await go(page, `/settings/${section}`);
    await settle(page);
    if (process.env.A11Y_DEBUG)
      console.log(
        `SMALL ${section}\n  ${(await page.evaluate(() => window.__a11y.smallTargets())).join('\n  ')}`,
      );
    expect
      .soft(await page.evaluate(() => window.__a11y.targetSize()), `settings: ${section}`)
      .toEqual([]);
  }
});

it('drag alternatives: pane resize and reorder work without dragging', async () => {
  test.setTimeout(60_000);
  await reloadAt(page, threadPath);
  // Two panes side by side.
  await page.getByRole('button', { name: 'Layout' }).click();
  await page.getByRole('menuitem', { name: 'Split right' }).click();
  const splitter = page.getByRole('separator', { name: /^Resize / }).first();
  await expect(splitter).toBeVisible();
  const value = async () => Number(await splitter.getAttribute('aria-valuenow'));
  // Keyboard.
  const v0 = await value();
  await splitter.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(value).toBeGreaterThan(v0);
  // A single pointer: the pane's menu makes it larger or smaller, and moves it.
  const v1 = await value();
  const paneMenu = page.getByRole('button', { name: 'More actions for Chat' });
  await paneMenu.click();
  await expect(page.getByRole('menuitem', { name: 'Move right' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Make smaller' }).click();
  await expect.poll(value).toBeLessThan(v1);
  await paneMenu.click();
  await page.getByRole('menuitem', { name: 'Make larger' }).click();
  await expect.poll(value).toBeCloseTo(v1, 0);
  // The bottom panel: keyboard and a single pointer.
  await page.getByRole('button', { name: 'Toggle bottom panel' }).click();
  const bottom = page.getByRole('separator', { name: 'Resize the bottom panel' });
  await expect(bottom).toBeVisible();
  const b = async () => Number(await bottom.getAttribute('aria-valuenow'));
  const b0 = await b();
  // A panel that has just opened may not take the first key yet (seen on CI): press until it does.
  await expect(async () => {
    await bottom.press('ArrowUp');
    expect(await b()).toBeLessThan(b0);
  }).toPass({ timeout: 10_000 });
  const b1 = await b();
  await page.getByRole('button', { name: 'More actions for the bottom panel' }).click();
  await page.getByRole('menuitem', { name: 'Make taller' }).click();
  await expect.poll(b).toBeLessThan(b1);
  await page.getByRole('button', { name: 'Close the bottom panel' }).click();
  await page.getByRole('button', { name: 'Layout' }).click();
  await page.getByRole('menuitem', { name: 'Reset layout' }).click();
  await expect(page.getByRole('separator')).toHaveCount(0);
});

it('reduced motion stops animation and the companion', async () => {
  test.setTimeout(60_000);
  await setSetting(page, 'appearance.pet', 'sprout');
  // Full motion first, to show the check can see animation at all.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await reloadAt(page, threadPath);
  await expect(page.locator('.pet')).toHaveAttribute('data-animate', 'true');
  expect(await page.evaluate(() => window.__a11y.runningAnimations())).not.toEqual([]);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.pet')).toHaveAttribute('data-animate', 'false');
  expect
    .soft(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--u-dur'),
      ),
    )
    .toMatch(/^0m?s$/);
  // While a reply streams (spinners, the companion thinking), nothing moves.
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('[slow] Tell me more');
  await composer.press('Enter');
  await expect(page.locator('.pet')).toHaveAttribute('data-state', 'thinking');
  const pet = page.locator('.pet svg');
  const first = await pet.boundingBox();
  await page.waitForTimeout(600);
  expect.soft(await pet.boundingBox(), 'the companion holds still').toEqual(first);
  expect.soft(await page.evaluate(() => window.__a11y.runningAnimations()), 'running').toEqual([]);
  await expect(page.getByLabel('Messages')).toContainText('Seen 2 user messages', {
    timeout: 20_000,
  });
  await page.emulateMedia({ reducedMotion: null });
  await setSetting(page, 'appearance.pet', 'off');
});

it('status messages: toasts and streaming use live regions', async () => {
  test.setTimeout(60_000);
  await reloadAt(page, threadPath);
  // The live regions exist before anything is announced.
  const live = page.locator('[aria-live="polite"], [aria-live="assertive"], [role="status"]');
  expect(await live.count()).toBeGreaterThan(0);
  const announcer = page.getByTestId('announcer');
  await expect(announcer).toHaveAttribute('aria-live', 'polite');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('[slow] And once more');
  await composer.press('Enter');
  await expect(announcer).toContainText('Assistant is responding.');
  await expect(announcer).toContainText('Response complete.', { timeout: 20_000 });

  // A toast lands inside a live region that was already there.
  await go(page, '/settings/appearance');
  await settle(page);
  await page.getByRole('button', { name: 'Copy theme link' }).click();
  const toast = page.locator('.nv-toast').first();
  await expect(toast).toBeVisible();
  expect(
    await toast.evaluate((t) => !!t.closest('[aria-live="polite"], [aria-live="assertive"]')),
  ).toBe(true);
});

it('text spacing (1.4.12) does not cut off text', async () => {
  test.setTimeout(90_000);
  await reloadAt(page, threadPath);
  // The WCAG 1.4.12 values, as a user style sheet would set them (CSSOM, so the Hub's CSP allows it).
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`* { line-height: 1.5 !important; letter-spacing: 0.12em !important;
      word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
  await page.waitForTimeout(200);
  expect.soft(await page.evaluate(() => window.__a11y.clipped()), 'chat').toEqual([]);
  for (const section of ['general', 'appearance', 'models', 'permissions', 'data', 'extensions']) {
    await go(page, `/settings/${section}`);
    await settle(page);
    expect
      .soft(await page.evaluate(() => window.__a11y.clipped()), `settings: ${section}`)
      .toEqual([]);
  }
  await page.reload();
});

// ---- 3. other sizes, themes and people --------------------------------------------------------

it('phone (390 x 844): shell, chat and settings', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page: phone } = await ownerPage(browser, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    await phone.goto(`${hub.url}${threadPath}`);
    await expect(phone.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await scan(phone, 'phone: chat');
    expect
      .soft(await phone.evaluate(() => window.__a11y.targetSize()), 'phone: chat targets')
      .toEqual([]);
    await phone.getByRole('button', { name: 'Open menu' }).click();
    await scan(phone, 'phone: menu');
    expect
      .soft(await phone.evaluate(() => window.__a11y.targetSize()), 'phone: menu targets')
      .toEqual([]);
    for (const path of [
      '/settings',
      '/settings/general',
      '/settings/appearance',
      '/settings/data',
    ]) {
      await go(phone, path);
      await scan(phone, `phone: ${path}`);
      expect
        .soft(await phone.evaluate(() => window.__a11y.targetSize()), `phone: ${path} targets`)
        .toEqual([]);
    }
  } finally {
    await context.close();
  }
});

it('reflow at 320 px: no sideways scrolling in chat and settings', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page: narrow } = await ownerPage(browser, {
    viewport: { width: 320, height: 640 },
  });
  try {
    await narrow.goto(`${hub.url}${threadPath}`);
    await expect(narrow.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await settle(narrow);
    expect.soft(await narrow.evaluate(() => window.__a11y.reflow()), 'chat').toEqual([]);
    for (const section of SETTINGS_SECTIONS) {
      await go(narrow, `/settings/${section}`);
      await settle(narrow);
      const found = await narrow.evaluate(() => window.__a11y.reflow());
      if (process.env.A11Y_DEBUG && found.length)
        console.log(
          `REFLOW ${section}\n${(
            await narrow.evaluate(() => {
              const W = document.documentElement.clientWidth;
              return [...document.querySelectorAll('main *')]
                .filter((e) => e.getBoundingClientRect().right > W + 1 && e.checkVisibility())
                .filter(
                  (e) => ![...e.children].some((c) => c.getBoundingClientRect().right > W + 1),
                )
                .slice(0, 12)
                .map((e) => {
                  const cs = getComputedStyle(e);
                  return `  ${window.__a11y.describe(e)} w=${Math.round(e.getBoundingClientRect().width)} display=${cs.display} ws=${cs.whiteSpace} minw=${cs.minWidth}`;
                });
            })
          ).join('\n')}`,
        );
      expect.soft(found, `settings: ${section}`).toEqual([]);
    }
  } finally {
    await context.close();
  }
});

it('dark (forced) and high-contrast themes', async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page: dark } = await ownerPage(browser, { colorScheme: 'dark' });
  const paths = [
    threadPath,
    '/work',
    '/marketplace/plugins',
    '/devices',
    '/settings/general',
    '/settings/appearance',
    '/settings/extensions',
    '/settings/data',
  ];
  try {
    for (const theme of ['system', 'high-contrast-dark', 'high-contrast-light']) {
      await setSetting(page, 'appearance.theme', theme);
      await dark.goto(`${hub.url}${threadPath}`);
      await expect(dark.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
      for (const path of paths) {
        await go(dark, path);
        await scan(dark, `${theme === 'system' ? 'dark' : theme}: ${path}`);
        await fields(dark, `${theme === 'system' ? 'dark' : theme}: ${path}`);
      }
    }
  } finally {
    await setSetting(page, 'appearance.theme', 'system');
    await context.close();
  }
});

it('a member: owner-only notices and their own sections', async ({ browser }) => {
  test.setTimeout(120_000);
  const invite = await page.evaluate(async () => {
    const res = await fetch('/api/v1/team/invitations', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ label: 'Sweep' }),
    });
    if (!res.ok) throw new Error(`invite: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { url: string }).url;
  });
  const context = await browser.newContext({ colorScheme: 'light' });
  await installA11yProbes(context);
  const member = await context.newPage();
  try {
    await member.goto(invite);
    await expect(member.getByRole('heading', { level: 1, name: 'Join this Hub' })).toBeVisible();
    await scan(member, 'member: join');
    await member.getByLabel('Your name').fill('Sam');
    await member.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(member.getByRole('navigation', { name: 'Sidebar' })).toBeVisible({
      timeout: 20_000,
    });
    for (const path of [
      '/chat',
      '/library',
      '/devices',
      '/network',
      '/code',
      '/marketplace',
      '/settings/general',
      '/settings/account',
      '/settings/profile',
      '/settings/managed',
      '/settings/tools',
      '/team/shared',
    ]) {
      await go(member, path);
      await scan(member, `member: ${path}`);
    }
    await go(member, '/devices');
    await expect(
      member.getByText('Only the owner of this Hub can change this.').filter({ visible: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

it('accessible authentication (3.3.8): sign-in and pairing allow paste and autofill', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ colorScheme: 'light' });
  const visitor = await context.newPage();
  /** The field takes pasted text and a password manager may fill it. */
  const pasteAndFill = async (label: string, autocomplete: RegExp) => {
    const field = visitor.getByLabel(label, { exact: true });
    await expect(field).toBeEditable();
    const pasted = await field.evaluate((el: HTMLInputElement) => {
      el.focus();
      const data = new DataTransfer();
      data.setData('text/plain', 'ABCD-EFGH');
      const ev = new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      return el.dispatchEvent(ev);
    });
    expect.soft(pasted, `${label}: paste is not blocked`).toBe(true);
    expect
      .soft(await field.getAttribute('autocomplete'), `${label}: autocomplete`)
      .toMatch(autocomplete);
  };
  try {
    // Signed out: the setup code (one-time code) and the sign-in options.
    await visitor.goto(hub.url);
    await expect(visitor.getByRole('heading', { level: 1, name: 'Set up Nova' })).toBeVisible();
    await scan(visitor, 'signed out: sign in and setup');
    await pasteAndFill('Setup code', /^one-time-code$/);
    // A device joining: the code the Hub shows.
    await visitor.goto(`${hub.url}/add-device`);
    await expect(visitor.getByRole('heading', { level: 1 })).toBeVisible();
    await scan(visitor, 'device join');
    await pasteAndFill('Code shown on the Hub', /^one-time-code$/);
    // A member joining without a link: the invitation link is pasted.
    await visitor.goto(`${hub.url}/join`);
    await expect(visitor.getByRole('heading', { level: 1, name: 'Join this Hub' })).toBeVisible();
    await scan(visitor, 'member join without a link');
    await pasteAndFill('Invitation link', /^(off|url)$/);
  } finally {
    await context.close();
  }
});

// Last, as it locks every setting: each lock note names the policy's source and is linked to its
// control (WCAG 1.3.1, 4.1.2; FR-106).
it('managed policy: every lock note in Settings names its source and is linked', async () => {
  test.setTimeout(150_000);
  await reloadAt(page, '/settings/general');
  const all = await page.evaluate(async () => {
    const res = await fetch('/api/v1/settings', { credentials: 'same-origin' });
    return ((await res.json()) as { settings: { key: string; value: unknown }[] }).settings;
  });
  // The policy sets every setting to the value it has now, so nothing loosens (UI state left out).
  const settings = Object.fromEntries(
    all
      .filter((x) => !/^(workspace\.|onboarding\.|managed\.)/.test(x.key))
      .map((x) => [x.key, x.value]),
  );
  writePolicy(policyPath, { version: 1, serial: 2, settings });
  const reloaded = await page.evaluate(async () => {
    const res = await fetch('/api/v1/managed/reload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    return res.status;
  });
  expect(reloaded).toBeLessThan(300);
  await reloadAt(page, '/settings/general');
  let notes = 0;
  for (const section of SETTINGS_SECTIONS) {
    if (section === 'managed') continue;
    await go(page, `/settings/${section}`);
    await settle(page);
    const found = await page.evaluate(() => {
      const out: { problems: string[]; notes: number } = { problems: [], notes: 0 };
      const body = document.querySelector('.settings-body');
      for (const note of body?.querySelectorAll<HTMLElement>('.nv-field-lock') ?? []) {
        if (!note.checkVisibility()) continue;
        out.notes += 1;
        const text = (note.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!/Managed by your organization\s*\(test policy file\)/.test(text))
          out.problems.push(`no source: "${text}"`);
        const linked =
          note.id &&
          [...document.querySelectorAll('[aria-describedby]')].some((el) =>
            (el.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(note.id),
          );
        if (!linked) out.problems.push(`not linked to a control: "${text}"`);
      }
      return out;
    });
    notes += found.notes;
    expect.soft(found.problems, `lock notes on settings: ${section}`).toEqual([]);
  }
  // The policy locked controls on many pages, so the check saw notes.
  expect(notes).toBeGreaterThan(20);
});
