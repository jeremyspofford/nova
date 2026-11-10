// Status icons part B (owner, 2026-11-08): the app's live state is drawn as the status icon
// (ui/js/status-icon.js) where the orb was: the rail's Home, the phone's top bar, the hero of an
// empty chat (and of Home on a phone), and a task row's own state at 16 px. Never on a message,
// one live icon per view, at most one hero. Every live icon takes the one state status.js orbState
// gives, with its words; a task row shows its task's own. Each is the mark's inline SVG (UI item 24),
// so no WebGL context is made; many 16 px rows keep the frame rate; under reduced motion nothing moves.
// With NOVA_UI_SHOTS set it writes the PR's screenshots (Nebula, light and dark).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

function shots(): string | null {
  const m3 = shotsDir();
  if (!m3) return null;
  const dir = join(dirname(m3), 'status-icons-b-2026-11-08');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const at = '2026-11-08T09:00:00.000Z';
const task = (id: string, title: string, state: string, more: Record<string, unknown> = {}) => ({ id, title, state, reason: null, owner: 'workspace', approval_tier: 1, approved_at: null, user_visibility: 'handling', privacy_mode: 'local-only', brief: { goal: title }, report: null, verification: null, created_at: at, updated_at: at, ...more });
const MIXED = [
  task('t-work', 'Summarize the week’s notes', 'active'),
  task('t-ok', 'Send the draft reply to Sam', 'waiting', { approval_tier: 2 }),
  task('t-queue', 'Index the photo folder', 'queued'),
  task('t-lane', 'Back up the vault', 'waiting', { reason: 'Waiting on local capacity.' }),
  task('t-fail', 'Renew the certificate', 'failed', { reason: 'The DNS check never passed.' }),
  task('t-done', 'Tidy the downloads folder', 'done', { verification: { ok: true, at, checks: [] } }),
  task('t-gone', 'Draft the newsletter', 'cancelled', { reason: 'You cancelled it.' }),
];
const WANT: Record<string, string | null> = { 't-work': 'working', 't-ok': 'needs-you', 't-queue': 'idle', 't-lane': 'idle', 't-fail': 'needs-you', 't-done': null, 't-gone': null };

// The live icons a person can see (task rows' own icons aside), and the heroes among them.
const liveIcons = (page: Page) => page.$$eval('.status-icon[data-presence]', (els) => els.filter((e) => (e as HTMLElement).checkVisibility() && e.getBoundingClientRect().width > 0)
  .map((e) => `${(e as HTMLElement).dataset.size}:${e.closest('.chat-hero') ? 'chat' : e.closest('.home-hero') ? 'home' : e.closest('.rail-home') ? 'rail' : e.closest('#topbar-orb') ? 'topbar' : 'other'}`));
// The app's own live state, set as app.js sets it, for the states a test can't stage end to end.
const signal = (page: Page, patch: Record<string, unknown>) => page.evaluate(async ([p, url]) => (await import(url)).signal(p), [patch, '/js/shell.js'] as const);
const QUIET = { reachable: true, listening: false, stopped: 0, needsYou: 0, speaking: false, working: 0, thinking: false };
const rowIcon = (page: Page, id: string) => page.locator(`#tasks-view .task-row[data-task="${id}"] .task-icon`);

test('status icons part B: the live state in the rail, the top bar and the hero; a task row’s own state; SVG, no WebGL', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-status-icons-b-');
  const nova = await m.start();
  const dir = shots();
  let tasks: unknown[] = MIXED;
  try {
    await finishSetup(m);
    const r = await m.send('POST', '/api/v1/design-systems/nebula/apply', { scope: 'user' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const scheme of ['dark', 'light'] as const) {
      // ---- desktop: the rail ----------------------------------------------------------------------
      {
        const where = `1440x900 ${scheme}`;
        const d = await device(b, { ...WIDE, scheme, serviceWorkers: 'block' });
        await d.ctx.addInitScript(() => {
          const real = HTMLCanvasElement.prototype.getContext;
          (window as any).__gl = 0;
          HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) { if (/webgl/.test(kind)) (window as any).__gl++; return (real as any).call(this, kind, ...rest); } as any;
        });
        await d.ctx.route((u) => u.pathname === '/api/v1/tasks' && u.searchParams.get('limit') === '100', (route) => route.fulfill({ json: tasks }));
        // The rail's Home: the status icon, named by its link, from the one live state.
        tasks = [];
        await d.page.goto(`${m.base}/tasks`);
        await ready(d.page);
        const home = d.page.locator('#rail .rail-home');
        const railIcon = home.locator('.status-icon[data-presence]');
        await railIcon.waitFor();
        assert.ok(await railIcon.isVisible(), `${where}: the rail’s Home is the status icon`);
        assert.equal(await railIcon.getAttribute('aria-hidden'), 'true', `${where}: decorative; the link says it`);
        assert.equal(Math.round((await railIcon.boundingBox())!.width), 32, `${where}: rail size`);
        assert.equal(await d.page.locator('#rail .orb').count(), 0, `${where}: no orb left in the rail`);
        assert.deepEqual(await liveIcons(d.page), ['rail:rail'], `${where}: one live icon in the view`);
        assert.equal(await home.getAttribute('aria-label'), 'Home. Nova is quiet', `${where}: Home says Nova is quiet`);
        assert.equal(await railIcon.getAttribute('data-status'), 'idle');
        assert.equal(await railIcon.getAttribute('data-state'), 'idle');
        if (dir) await shoot(d.page, join(dir, `rail-idle-1440x900-nebula-${scheme}.png`));

        // The live state: every live icon and the rail's name follow it, thinking only while working.
        await signal(d.page, { ...QUIET, working: 1 });
        assert.equal(await home.getAttribute('aria-label'), 'Home. Nova is working', `${where}: working`);
        assert.equal(await railIcon.getAttribute('data-status'), 'working');
        assert.equal(await railIcon.getAttribute('data-state'), 'working');
        if (dir) { await d.page.waitForTimeout(900); await shoot(d.page, join(dir, `rail-working-1440x900-nebula-${scheme}.png`)); }
        await signal(d.page, { ...QUIET, working: 1, thinking: true });
        assert.equal(await home.getAttribute('aria-label'), 'Home. Nova is thinking', `${where}: thinking while the reply has no words yet`);
        assert.equal(await railIcon.getAttribute('data-status'), 'thinking');
        assert.equal(await railIcon.getAttribute('data-state'), 'working', `${where}: the same one live state underneath`);
        await signal(d.page, { ...QUIET, working: 1, thinking: true, needsYou: 1 });
        assert.equal(await railIcon.getAttribute('data-status'), 'needs-you', `${where}: thinking never hides something more urgent`);
        await signal(d.page, { ...QUIET, reachable: false });
        assert.equal(await home.getAttribute('aria-label'), 'Home. Nova isn’t reachable');
        assert.equal(await railIcon.getAttribute('data-status'), 'offline');
        await signal(d.page, QUIET);

        // Tasks, from the ledger: each row its own state; the rail the one live state they make.
        tasks = MIXED;
        await d.page.goto(`${m.base}/tasks`);
        await ready(d.page);
        await rowIcon(d.page, 't-work').waitFor();
        await d.page.waitForFunction(() => document.querySelector('#rail .rail-home .status-icon[data-presence]')?.getAttribute('data-state') === 'needs-you', null, { timeout: 5000 })
          .catch(() => assert.fail(`${where}: an OK waiting makes the live state needs-you`));
        assert.equal(await home.getAttribute('aria-label'), 'Home. Something needs you');
        assert.deepEqual(await liveIcons(d.page), ['rail:rail'], `${where}: still one live icon in the view`);
        // Task rows: each its task's own state, decorative (the status beside it says it), 16 px.
        for (const [id, want] of Object.entries(WANT)) {
          const icon = rowIcon(d.page, id);
          if (!want) { assert.equal(await icon.count(), 0, `${where}: ${id} has no icon`); continue; }
          assert.equal(await icon.getAttribute('data-status'), want, `${where}: ${id} shows ${want}`);
          assert.equal(await icon.getAttribute('aria-hidden'), 'true', `${where}: ${id}’s icon is decorative`);
          assert.equal(Math.round((await icon.boundingBox())!.width), 16, `${where}: ${id} at 16 px`);
        }
        // Every icon on the page is the mark's inline SVG; none makes a WebGL context.
        const renderers = await d.page.$$eval('.status-icon', (els) => [...new Set(els.map((e) => (e as HTMLElement).dataset.renderer))]);
        assert.deepEqual(renderers, ['svg'], `${where}: every icon is the SVG (${renderers})`);
        assert.equal(await d.page.evaluate(() => (window as any).__gl), 0, `${where}: no WebGL context`);
        if (dir) { await d.page.waitForTimeout(900); await shoot(d.page, join(dir, `tasks-mixed-1440x900-nebula-${scheme}.png`)); }

        // A task that finishes while its row is shown: the success flourish, settling to idle.
        tasks = MIXED.map((x) => (x.id === 't-work' ? { ...x, state: 'done', verification: { ok: true, at, checks: [] } } : x));
        await d.page.evaluate(async (url) => { const s = await import(url); await s.load(['tasks']); s.renderTasks(document.getElementById('tasks-view')); }, '/js/surfaces.js');
        assert.equal(await rowIcon(d.page, 't-work').getAttribute('data-status'), 'success', `${where}: a task seen finishing flourishes`);
        await d.page.waitForFunction(() => document.querySelector('#tasks-view .task-row[data-task="t-work"] .task-icon')?.getAttribute('data-status') === 'idle', null, { timeout: 5000 });
        assert.equal(await rowIcon(d.page, 't-done').count(), 0, `${where}: one already done when first seen shows its Verified status alone`);

        // The empty chat: the hero is the one live icon; the rail draws its plain Home icon. The hero
        // says the live state the ledger makes (the OK still waiting), then quiet once it is empty.
        await d.page.goto(`${m.base}/new`);
        await ready(d.page);
        const hero = d.page.locator('#thread .chat-hero .status-icon[data-presence]');
        await hero.waitFor();
        assert.deepEqual(await liveIcons(d.page), ['hero:chat'], `${where}: the hero alone`);
        await d.page.waitForFunction(() => document.querySelector('#thread .chat-hero .status-icon[data-presence]')?.getAttribute('aria-label') === 'Something needs you', null, { timeout: 5000 })
          .catch(() => assert.fail(`${where}: the hero says the ledger’s live state`));
        tasks = [];
        await d.page.reload();
        await ready(d.page);
        await hero.waitFor();
        await d.page.waitForTimeout(500);
        assert.equal(await hero.getAttribute('aria-label'), 'Nova is quiet', `${where}: and quiet with nothing on`);
        if (dir) await shoot(d.page, join(dir, `empty-chat-1440x900-nebula-${scheme}.png`));
        assert.deepEqual(d.errors, [], `${where}: no errors in the page`);
        await d.ctx.close();
      }

      // ---- phone: the top bar, Home's hero, and the empty chat --------------------------------------
      {
        const where = `390x844 ${scheme}`;
        const d = await device(b, { ...PHONE, scheme, touch: true, serviceWorkers: 'block' });
        await d.ctx.route((u) => u.pathname === '/api/v1/tasks' && u.searchParams.get('limit') === '100', (route) => route.fulfill({ json: MIXED }));
        await d.page.goto(`${m.base}/tasks`);
        await ready(d.page);
        await rowIcon(d.page, 't-work').waitFor();
        const top = d.page.locator('#topbar-orb .status-icon[data-presence]');
        assert.deepEqual(await liveIcons(d.page), ['mini:topbar'], `${where}: the top bar’s small icon, alone`);
        assert.equal(Math.round((await top.boundingBox())!.width), 24, `${where}: 24 px`);
        assert.equal(await top.getAttribute('role'), 'img');
        assert.equal(await top.getAttribute('aria-label'), 'Something needs you', `${where}: the live state the ledger makes (an OK waiting)`);
        assert.equal(await top.getAttribute('data-status'), 'needs-you');
        if (dir) await shoot(d.page, join(dir, `phone-topbar-390x844-nebula-${scheme}.png`));

        await d.page.goto(`${m.base}/`);
        await ready(d.page);
        await d.page.locator('.home-hero .status-icon[data-presence]').waitFor();
        assert.deepEqual(await liveIcons(d.page), ['hero:home'], `${where}: Home’s hero, and no top-bar icon beside it`);
        await d.page.goto(`${m.base}/new`);
        await ready(d.page);
        await d.page.locator('#thread .chat-hero .status-icon[data-presence]').waitFor();
        assert.deepEqual(await liveIcons(d.page), ['hero:chat'], `${where}: an empty chat’s hero, and no top-bar icon`);
        if (dir) await shoot(d.page, join(dir, `phone-empty-chat-390x844-nebula-${scheme}.png`));
        assert.deepEqual(d.errors, [], `${where}: no errors in the page`);
        await d.ctx.close();
      }
    }

    // ---- performance: sixty running rows, and reduced motion -----------------------------------------
    {
      const many = Array.from({ length: 60 }, (_, i) => task(`p-${i}`, `Running job ${i + 1}`, i % 5 === 0 ? 'waiting' : 'active', i % 5 === 0 ? { approval_tier: 2 } : {}));
      const d = await device(b, { ...WIDE, scheme: 'dark', serviceWorkers: 'block' });
      await d.ctx.route((u) => u.pathname === '/api/v1/tasks' && u.searchParams.get('limit') === '100', (route) => route.fulfill({ json: many }));
      await d.page.goto(`${m.base}/tasks`);
      await ready(d.page);
      await d.page.waitForFunction(() => document.querySelectorAll('#tasks-view .task-icon').length === 60);
      const fps = await d.page.evaluate(() => new Promise<{ frames: number; worst: number; p95: number }>((done) => {
        const gaps: number[] = [];
        let last = performance.now();
        const start = last;
        const tick = (now: number) => { gaps.push(now - last); last = now; if (now - start < 3000) requestAnimationFrame(tick); else { gaps.sort((a, b) => a - b); done({ frames: gaps.length, worst: Math.round(gaps.at(-1)!), p95: Math.round(gaps[Math.floor(gaps.length * 0.95)]!) }); } };
        requestAnimationFrame(tick);
      }));
      const renderer = await d.page.locator('#tasks-view .task-icon').first().getAttribute('data-renderer');
      console.log(`status icons part B: 60 rows (${renderer}), ${fps.frames} frames in 3 s, p95 ${fps.p95} ms, worst ${fps.worst} ms`);
      assert.ok(fps.frames >= 120, `60 running rows keep at least 40 fps (${fps.frames} frames in 3 s)`);
      assert.ok(fps.p95 <= 50, `and the 95th-percentile frame is within three vsyncs (${fps.p95} ms)`);
      // Under reduced motion nothing moves: two pictures of a running row's icon, apart, are the same.
      await d.page.emulateMedia({ reducedMotion: 'reduce' });
      await d.page.waitForTimeout(1200);
      const pic = () => d.page.evaluate(() => document.querySelector('#tasks-view .task-icon svg')!.outerHTML);
      const a = await pic();
      await d.page.waitForTimeout(700);
      assert.equal(await pic(), a, 'reduced motion: a running row’s icon is still');
      assert.deepEqual(d.errors, [], 'no errors in the page');
      await d.ctx.close();
    }
  } finally {
    await b.close();
    await stop(nova);
  }
});
