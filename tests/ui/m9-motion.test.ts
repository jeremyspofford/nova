// M9 gate, animation (Amendment 2026-10-30-C Part 2): in the real PWA, every transition and one-off
// animation a person sets off on the main views takes 150–300 ms and moves only transform and
// opacity; only state loops (the orb, a working pulse) repeat; under prefers-reduced-motion no loop
// runs and every change is near-instant. The tokens and the lint are tests/m9-motion.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { browser, device } from './support.ts';
import { MAIN, SIZES, VIEWS, seeded, settled } from './m9-support.ts';

const MOVES = ['transform', 'translate', 'scale', 'rotate', 'opacity'];

// Records every CSS animation and transition as it starts, with what it changes and for how long.
function recorder() {
  const seen: object[] = [];
  (window as any).__motion = seen;
  const note = (e: Event, kind: string) => {
    const t = e.target as Element;
    for (const a of t.getAnimations?.() ?? []) {
      const name = (a as any).animationName ?? (a as any).transitionProperty;
      const want = kind === 'animation' ? (e as AnimationEvent).animationName : (e as TransitionEvent).propertyName;
      if (name !== want) continue;
      const timing = a.effect!.getComputedTiming();
      const kf = (a.effect as KeyframeEffect).getKeyframes();
      const props = kind === 'animation' ? [...new Set(kf.flatMap((k) => Object.keys(k).filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p))))] : [want];
      // The duration as styled. (A transition reversed half-way runs for less, by design: CSS
      // shortens it in proportion, so the running effect's own duration isn't the token.)
      const cs = getComputedStyle(t);
      const list = (v: string) => v.split(',').map((x) => x.trim());
      const ms = (v: string) => (v.endsWith('ms') ? Number.parseFloat(v) : Number.parseFloat(v) * 1000);
      let duration = Number(timing.duration);
      if (kind === 'transition') {
        const names = list(cs.transitionProperty);
        const i = names.indexOf(want) >= 0 ? names.indexOf(want) : names.indexOf('all');
        const durs = list(cs.transitionDuration);
        if (i >= 0) duration = ms(durs[i % durs.length]!);
      }
      seen.push({ kind, name, props, duration, iterations: timing.iterations, target: `${t.tagName.toLowerCase()}.${[...t.classList].join('.')}` });
    }
  };
  document.addEventListener('animationstart', (e) => note(e, 'animation'), true);
  document.addEventListener('transitionrun', (e) => note(e, 'transition'), true);
}

type Seen = { kind: string; name: string; props: string[]; duration: number; iterations: number; target: string };

// Real actions on each main view: moving between them, the drawer, More, a task, Settings, a
// memory, hovering and typing.
async function drive(page: Page, base: string, size: string) {
  const nav = async (dest: string) => {
    const direct = page.locator(`#rail [data-dest="${dest}"], #tabs [data-dest="${dest}"]`).filter({ visible: true });
    if (await direct.count()) await direct.first().click();
    else { await page.click('#more-btn'); await page.locator(`#more [data-dest="${dest}"]`).click(); }
    await settled(page, dest === 'chat' ? 'chat' : dest);
  };
  await page.goto(`${base}${VIEWS.home}`);
  await settled(page, 'home');
  await page.waitForTimeout(400);
  for (const b of await page.locator('#home button, #home a, .card').filter({ visible: true }).all()) { if (size === 'desktop') await b.hover().catch(() => {}); }
  await nav('tasks');
  const task = page.locator('#tasks-view [data-action="open-task"]').first();
  if (await task.count()) {
    await task.click();
    await page.waitForSelector('#sheet[open]');
    await page.waitForTimeout(350);
    await page.keyboard.press('Escape');
  }
  await nav('memory');
  await page.locator('#memory .memory-item .memory-text').first().click();
  await page.keyboard.press('Escape');
  await nav('settings');
  await page.fill('#settings-search', 'theme');
  await page.locator('#settings-results .settings-result').first().click();
  await page.waitForTimeout(350);
  await page.goto(`${base}${VIEWS.chat}`);
  await settled(page, 'chat');
  await page.click('#input');
  await page.keyboard.type('a short note');
  if (await page.locator('#menu').isVisible()) {
    await page.click('#menu');
    await page.waitForTimeout(350);
    await page.keyboard.press('Escape');
  }
  if (await page.locator('#more-btn').isVisible()) {
    await page.click('#more-btn');
    await page.waitForTimeout(350);
    await page.keyboard.press('Escape');
  }
  for (const b of (await page.locator('#thread .act, #thread summary').filter({ visible: true }).all()).slice(0, 6)) { if (size === 'desktop') await b.hover().catch(() => {}); }
  await page.waitForTimeout(400);
}

test('M9 gate, motion: 150–300 ms, transform and opacity only, loops only for states; reduced motion is honoured', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-motion-');
  const rows: string[] = [];
  try {
    for (const [size, vp] of SIZES) {
      const d = await device(b, { ...vp, touch: size === 'phone' });
      await d.ctx.addInitScript(recorder);
      await drive(d.page, m.base, size);
      const seen = await d.page.evaluate(() => (window as any).__motion as Seen[]);
      const finite = seen.filter((s) => s.iterations !== Infinity && !(s.kind === 'transition' && s.name === 'visibility'));
      assert.ok(finite.length >= 5, `${size}: real actions set off motion (${finite.length} seen)`);
      for (const s of finite) {
        assert.ok(s.duration >= 150 && s.duration <= 300, `${size}: ${s.kind} ${s.name} on ${s.target} takes ${s.duration} ms`);
        assert.deepEqual(s.props.filter((p) => !MOVES.includes(p)), [], `${size}: ${s.kind} ${s.name} on ${s.target} changes ${s.props.join(', ')}`);
      }
      for (const s of seen.filter((x) => x.kind === 'transition' && x.name === 'visibility')) assert.equal(s.duration, 0, `${size}: visibility only flips (${s.target})`);
      for (const s of seen.filter((x) => x.iterations === Infinity)) {
        assert.match(s.target, /orb|pulse|caret|nav-badge/, `${size}: only a state loops (${s.name} on ${s.target})`);
        assert.deepEqual(s.props.filter((p) => !MOVES.includes(p)), [], `${size}: the loop ${s.name} changes ${s.props.join(', ')}`);
      }
      const kinds = [...new Set(finite.map((s) => `${s.kind}:${s.name}`))].sort();
      rows.push(`${size}: ${finite.length} one-off (${kinds.join(', ')}); ${seen.filter((x) => x.iterations === Infinity).length} loops`);
      assert.deepEqual(d.errors, [], `${size}: no errors in the page`);
      await d.ctx.close();

      // Reduced motion: nothing loops, everything is near-instant.
      const r = await b.newContext({ viewport: vp, reducedMotion: 'reduce', ...(size === 'phone' ? { hasTouch: true, isMobile: true } : {}) });
      await r.addInitScript(recorder);
      const page = await r.newPage();
      await drive(page, m.base, size);
      const calm = await page.evaluate(() => ({
        seen: (window as any).__motion as Seen[],
        running: document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations === Infinity).map((a) => (a as any).animationName),
      }));
      assert.deepEqual(calm.running, [], `${size}, reduced motion: no loop runs`);
      for (const s of calm.seen.filter((x) => !(x.kind === 'transition' && x.name === 'visibility'))) {
        assert.ok(s.duration <= 1 && s.iterations !== Infinity, `${size}, reduced motion: ${s.kind} ${s.name} on ${s.target} takes ${s.duration} ms × ${s.iterations}`);
      }
      rows.push(`${size}, reduced motion: ${calm.seen.length} changes, all ≤ 1 ms, no loops`);
      await r.close();
    }
    console.log(`motion:\n${rows.join('\n')}\nviews: ${MAIN.join(', ')}`);
  } finally {
    await b.close();
    await stop(nova);
  }
});
