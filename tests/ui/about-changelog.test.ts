// About Nova, What's new and Where Nova stands, in the real app against the real server
// (docs/builder-packet/nova-versioning-changelog-2026-11-03.md and its 2026-11-06 delta). On a phone
// (the navigation drawer) and a desktop (the open rail), in Nebula dark and light:
//   - the version stamp shows on each and opens About;
//   - About says the build is the latest merged one, then, once the deploy step records a newer
//     merge, "redeploy pending", and the stamp turns with it;
//   - What's new renders CHANGELOG.md's entries, newest first, the running version pinned;
//   - Where Nova stands shows its four state columns and its workstreams;
//   - Settings › About Nova leads to About; the styleguide entry draws every state.
// With NOVA_UI_SHOTS set (scripts/ui-test.sh sets it), each of those is also a screenshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { ROOT, blank, browser, device, finishSetup, shotsDir, shortTargets, still, until } from './support.ts';
import { drawn, press, trackDocument } from './navigation-support.ts';
import { parseChangelog } from '../../src/core/changelog.ts';

const RUNNING = 'c0ffee12'.padEnd(40, '0');
const NEWER = 'deadbeef'.padEnd(40, '1');
const LAYOUTS = [['phone', 390, 844, true], ['desktop', 1440, 900, false]] as const;
const versions = parseChangelog(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')).versions;

async function shot(page: Page, dir: string | null, name: string, fullPage = false) {
  if (!dir) return;
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage, animations: 'disabled', caret: 'hide' });
}

test('About, What’s new, Where Nova stands and the version stamp, on a phone and a desktop, dark and light', { timeout: 600_000 }, async () => {
  const b = await browser();
  assert.notEqual(typeof b, 'string', 'needs a real browser');
  if (typeof b === 'string') throw new Error(b);
  const m = blank('nova-about-');
  const nova = await m.start({ NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none', NOVA_BUILD_COMMIT: RUNNING, NOVA_BUILD_DATE: '2026-11-08T21:02:00Z' });
  const out = shotsDir();
  const dir = out ? join(out, 'about-changelog') : null;
  if (dir) mkdirSync(dir, { recursive: true });
  const latest = (commit: string) => { mkdirSync(join(m.home, 'deploy'), { recursive: true }); writeFileSync(join(m.home, 'deploy', 'latest.json'), JSON.stringify({ commit, merged_at: '2026-11-08T21:00:00Z' })); };
  try {
    await finishSetup(m);
    for (const scheme of ['dark', 'light'] as const) for (const [layout, width, height, touch] of LAYOUTS) {
      const tag = `${layout}-${scheme}`;
      latest(RUNNING);
      const d = await device(b, { width, height, touch, scheme, serviceWorkers: 'block' });
      const page = d.page;
      const outside: string[] = [];
      await d.ctx.route('**/*', (route) => { if (new URL(route.request().url()).origin === m.base) return route.continue(); outside.push(route.request().url()); return route.abort(); });
      trackDocument(page);
      await page.goto(`${m.base}/`);
      await drawn(page);

      // The stamp: in the rail's foot on a desktop; at the foot of the navigation drawer on a phone.
      if (touch) await press(page, { button: '#nav-menu', label: 'Navigation' }, true);
      const stamp = page.locator('#rail a.rail-stamp');
      await stamp.waitFor({ state: 'visible' });
      assert.equal(await stamp.getAttribute('href'), '/about', `${tag}: the stamp links to About`);
      assert.equal(await page.locator('#rail .rail-stamp-commit').textContent(), RUNNING.slice(0, 8), `${tag}: the stamp shows the running commit`);
      assert.match(await stamp.innerText(), /0\.1\.0-alpha\.\d+/, `${tag}: and the version`);
      assert.equal(await stamp.getAttribute('data-pending'), null);
      assert.deepEqual(await shortTargets(page, '#rail a.rail-stamp'), [], `${tag}: the stamp is a full-size target`);
      if (dir) {
        if (touch) await shot(page, dir, `stamp-${tag}`);
        else { await still(page); await page.locator('#rail').screenshot({ path: join(dir, `stamp-${tag}.png`), animations: 'disabled' }); }
      }
      await press(page, { href: '/about', label: 'About Nova', section: '' }, touch);
      assert.equal(await page.getAttribute('body', 'data-view'), 'about');
      assert.equal(await page.locator('.app.nav-open').count(), 0, `${tag}: choosing the stamp closes the drawer`);

      // About: the latest merged build.
      const card = page.locator('#about-view .about-card');
      await until(page, () => document.querySelector('#about-view .about-card')?.getAttribute('data-about-state') === 'current');
      assert.match(await card.locator('.about-state').innerText(), new RegExp(`Running ${RUNNING.slice(0, 8)}, the latest merged build\\.`));
      assert.match(await card.innerText(), /Built\s+2026-11-08 21:02 UTC/);
      await shot(page, dir, `about-current-${tag}`, true);

      // The deploy step records a newer merge: About says a redeploy is pending, and so does the stamp.
      latest(NEWER);
      await press(page, { href: '/changelog', label: 'What’s new', section: 'about-view' }, touch);
      await press(page, { href: '/about', label: 'About Nova', section: 'changelog-view' }, touch);
      await until(page, () => document.querySelector('#about-view .about-card')?.getAttribute('data-about-state') === 'pending');
      assert.match(await card.locator('.about-state').innerText(), new RegExp(`Running ${RUNNING.slice(0, 8)}, latest merged ${NEWER.slice(0, 8)} — redeploy pending\\.`));
      assert.match(await card.innerText(), /newer merged build is waiting to be deployed/);
      await until(page, () => document.querySelector('#rail a.rail-stamp')?.hasAttribute('data-pending'));
      await shot(page, dir, `about-pending-${tag}`, true);
      if (dir && touch) { await press(page, { button: '#nav-menu', label: 'Navigation' }, true); await shot(page, dir, `stamp-pending-${tag}`); await press(page, { button: '#nav-close', label: 'Close navigation' }, true); }
      else if (dir) await page.locator('#rail').screenshot({ path: join(dir, `stamp-pending-${tag}.png`), animations: 'disabled' });
      latest(RUNNING);

      // What's new: CHANGELOG.md's versions, newest first, the running version pinned.
      await press(page, { href: '/changelog', label: 'What’s new', section: 'about-view' }, touch);
      assert.equal(await page.getAttribute('body', 'data-view'), 'changelog');
      const shown = await page.locator('#changelog-view .changelog-entry[data-version]').evaluateAll((es) => es.map((e) => e.getAttribute('data-version')));
      assert.deepEqual(shown, versions.map((v) => v.version), `${tag}: every version, newest first`);
      assert.ok(shown.length > 0);
      const first = page.locator('#changelog-view .changelog-entry[data-version]').first();
      assert.equal(await first.locator('.changelog-items li').count(), versions[0]!.sections.reduce((n, s) => n + s.items.length, 0), `${tag}: every item of the newest version`);
      assert.match(await page.locator('#changelog-view .changelog-pin').innerText(), new RegExp(`Nova ${versions[0]!.version.replace(/\./g, '\\.')}`));
      await shot(page, dir, `changelog-${tag}`, true);

      // Where Nova stands: its four columns, and its workstreams, the roadmap first.
      await press(page, { href: '/about', label: 'About Nova', section: 'changelog-view' }, touch);
      await press(page, { href: '/pipeline', label: 'Where Nova stands', section: 'about-view' }, touch);
      assert.equal(await page.getAttribute('body', 'data-view'), 'pipeline');
      assert.deepEqual(await page.locator('#pipeline-view .pipeline-col-name').allInnerTexts(), ['Merged', 'In progress', 'Designed', 'Not started']);
      const counts = (await page.locator('#pipeline-view .pipeline-col-n').allInnerTexts()).map(Number);
      assert.equal(counts.reduce((a, n) => a + n, 0), await page.locator('#pipeline-view .pipeline-row').count(), `${tag}: the columns count every row`);
      assert.match(await page.locator('#pipeline-view .pipeline-stream-head').first().innerText(), /^Roadmap/);
      assert.ok(await page.locator('#pipeline-view .pipeline-stream').count() > 1);
      await shot(page, dir, `pipeline-${tag}`, true);
      const row = page.locator('#pipeline-view .pipeline-row summary').first();
      if (touch) await row.tap(); else await row.click();
      assert.match(await page.locator('#pipeline-view .pipeline-row').first().locator('.pipeline-ev').innerText(), /docs\//, `${tag}: a row opens its evidence`);
      // The evidence opens: a link to the record at the running commit, in a tab of its own (A-080).
      const evLink = page.locator('#pipeline-view .pipeline-row').first().locator('a.pipeline-ev-path');
      assert.equal(await evLink.getAttribute('href'), `https://github.com/jeremyspofford/nova/blob/${RUNNING}/${await evLink.innerText()}`, `${tag}: the evidence links to its file at the running commit`);
      assert.deepEqual([await evLink.getAttribute('target'), await evLink.getAttribute('rel')], ['_blank', 'noopener noreferrer']);
      if (touch) await row.tap(); else await row.click();

      // Settings › About Nova is About's door from Settings.
      if (touch) await press(page, { button: '#nav-menu', label: 'Navigation' }, true);
      await press(page, { href: '/settings', label: 'Settings', section: 'rail' }, touch);
      await press(page, { href: '/settings#about', label: 'About Nova', section: 'settings-nav' }, touch);
      await page.locator('#settings-about [data-build-stamp]').waitFor({ state: 'visible' });
      assert.match(await page.locator('#settings-about [data-build-stamp]').innerText(), new RegExp(RUNNING.slice(0, 8)));
      await press(page, { href: '/about', label: 'Open About Nova', section: 'settings-about' }, touch);
      assert.equal(await page.getAttribute('body', 'data-view'), 'about');

      assert.deepEqual(outside, [], `${tag}: nothing leaves the app`);
      assert.deepEqual(d.errors, [], `${tag}: no page errors`);
      await d.ctx.close();

      // The styleguide entry: every state, drawn by the app's own components.
      if (layout === 'desktop' || dir) {
        const g = await device(b, { width, height, touch, scheme, serviceWorkers: 'block' });
        await g.page.goto(`${m.base}/styleguide?entry=about-nova`);
        await g.page.waitForSelector('#sg-about-nova .about-card[data-about-state="pending"]');
        assert.equal(await g.page.locator('#sg-about-nova .sg-broken').count(), 0);
        assert.deepEqual((await g.page.locator('#sg-about-nova .about-card').evaluateAll((es) => es.map((e) => e.getAttribute('data-about-state') ?? 'loading'))), ['current', 'pending', 'unknown', 'loading', 'failed']);
        assert.equal(await g.page.locator('#sg-about-nova .rail-stamp').count(), 4);
        assert.equal(await g.page.locator('#sg-about-nova .changelog-entry').count(), 2);
        assert.deepEqual(await g.page.locator('#sg-about-nova .pipeline-state').allInnerTexts(), ['Merged', 'In progress', 'Designed', 'Not started']);
        await shot(g.page, dir, `styleguide-${tag}`, true);
        assert.deepEqual(g.errors, []);
        await g.ctx.close();
      }
    }
  } finally {
    await b.close();
    await stop(nova);
    rmSync(m.dir, { recursive: true, force: true });
  }
});
