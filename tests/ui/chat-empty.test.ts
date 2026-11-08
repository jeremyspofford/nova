// UI rebuild PR 4: the empty chat and the thread. An empty chat shows the hero orb and nothing else
// that is an orb (owner, 2026-11-08: one orb per view at every width), a greeting, the composer in
// the middle with two rows, and three suggestions that fill it and never send. A thread with turns
// docks the composer, says "Reply to Nova…", gets the rail's (or the top bar's) orb back, and folds
// a turn's finished steps into one collapsed "N steps · time" line. Neutral placeholders only.
// With NOVA_UI_SHOTS set it also writes the PR's screenshots (Nebula, light and dark).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const CHAT = '2026-11-06-friday';
const at = (hms: string) => `2026-11-06T${hms}.000Z`;
const LOG = [
  { ts: at('09:00:00'), type: 'session', id: CHAT, title: 'Friday plan', v: 1 },
  { ts: at('09:00:00'), type: 'user', turn: 't1', text: 'What does Friday look like? Check my notes.' },
  { ts: at('09:00:01'), type: 'tool_call', turn: 't1', attempt: 0, id: 'c1', name: 'read_file', args: { path: 'notes/friday.md' } },
  { ts: at('09:00:02'), type: 'tool_result', turn: 't1', attempt: 0, id: 'c1', ok: true, output: '- client migration, about two hours\n- car service at 9:00' },
  { ts: at('09:00:03'), type: 'tool_call', turn: 't1', attempt: 0, id: 'c2', name: 'read_file', args: { path: 'notes/errands.md' } },
  { ts: at('09:00:05'), type: 'tool_result', turn: 't1', attempt: 0, id: 'c2', ok: true, output: '- pick up the parcel' },
  { ts: at('09:00:06'), type: 'assistant', turn: 't1', attempt: 0, id: 'a1', text: 'Friday has the client migration, about two hours, and the car service at 9:00, so the migration fits best after 11.' },
  { ts: at('09:00:07'), type: 'done', turn: 't1', attempt: 0 },
];

// Every orb a person can see, and where it is.
const orbs = (page: Page) => page.$$eval('.orb', (els) => els.filter((e) => (e as HTMLElement).checkVisibility({ visibilityProperty: true } as any) && e.getBoundingClientRect().width > 0)
  .map((e) => (e.closest('.chat-hero') ? 'hero' : e.closest('.rail-home') ? 'rail' : e.closest('#topbar-orb') ? 'topbar' : 'other')));

test('an empty chat: one orb, a greeting, the composer centred, suggestions that fill it; a thread docks it and groups its steps', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-chat-');
  const nova = await m.start();
  const shots = shotsDir();
  try {
    await finishSetup(m);
    writeFileSync(join(m.home, 'sessions', `${CHAT}.jsonl`), `${LOG.map((e) => JSON.stringify(e)).join('\n')}\n`);
    const r = await m.send('POST', '/api/v1/design-systems/nebula/apply', { scope: 'user' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const [size, vp] of [['1440x900', WIDE], ['390x844', PHONE]] as const) {
      for (const scheme of ['light', 'dark'] as const) {
        const where = `${size} ${scheme}`;
        const d = await device(b, { ...vp, scheme });
        let sent = 0;
        d.page.on('request', (q) => { if (q.method() === 'POST' && new URL(q.url()).pathname === '/api/sessions') sent++; });

        // The empty chat.
        await d.page.goto(`${m.base}/new`);
        await ready(d.page);
        await d.page.locator('#thread .empty.chat-empty .chat-hero .orb').waitFor();
        assert.deepEqual(await orbs(d.page), ['hero'], `${where}: an empty chat shows the hero orb and no other`);
        assert.equal(await d.page.locator('#thread .empty h2.greeting').count(), 1, `${where}: the greeting is a heading under the page’s h1`);
        assert.equal((await d.page.textContent('#title'))?.trim(), 'New chat', `${where}: a fresh conversation is a new chat`);
        if (size === '1440x900') {
          const home = d.page.locator('#rail .rail-home');
          assert.ok(await home.isVisible(), `${where}: the rail’s Home link is still there`);
          assert.match((await home.getAttribute('aria-label')) ?? '', /^Home\./, `${where}: and still named`);
          assert.ok(await home.locator('.icon').isVisible(), `${where}: drawn as the plain Home icon`);
        }
        const input = d.page.locator('#input');
        assert.equal(await input.getAttribute('placeholder'), 'Ask Nova anything…');
        assert.equal(await input.getAttribute('rows'), '2', `${where}: two rows while centred`);
        const box = {
          greet: (await d.page.locator('#thread .greeting').boundingBox())!,
          composer: (await d.page.locator('#composer').boundingBox())!,
          chips: (await d.page.locator('#dock .chips').boundingBox())!,
        };
        assert.ok(box.greet.y + box.greet.height <= box.composer.y && box.composer.y + box.composer.height <= box.chips.y, `${where}: greeting, then the composer, then the suggestions`);
        assert.ok(box.chips.y + box.chips.height < vp.height - 40, `${where}: the composer isn’t docked at the foot`);
        for (const note of ['#voice-note', '#hint']) {
          if (!(await d.page.locator(note).isVisible())) continue;
          const n = (await d.page.locator(note).boundingBox())!;
          assert.ok(Math.abs(n.x - box.composer.x) <= 1 && Math.abs(n.width - box.composer.width) <= 1, `${where}: ${note} lines up with the composer (${n.x}/${n.width} vs ${box.composer.x}/${box.composer.width})`);
        }
        const chips = d.page.locator('#dock .chips[role="group"][aria-label="Suggestions"] button.chip');
        assert.equal(await chips.count(), 3, `${where}: three suggestions`);
        for (const c of await chips.all()) assert.ok(((await c.boundingBox())?.height ?? 0) >= 44, `${where}: a suggestion is a full target`);
        if (shots) await shoot(d.page, join(shots, `empty-chat-${size}-nebula-${scheme}.png`));
        await chips.first().click();
        assert.equal(await input.inputValue(), await chips.first().textContent(), `${where}: a suggestion fills the composer`);
        assert.equal(await d.page.evaluate(() => document.activeElement?.id), 'input', `${where}: and focuses it`);
        await d.page.waitForTimeout(300);
        assert.equal(sent, 0, `${where}: it never sends`);
        await input.fill('');

        // A thread with turns.
        await d.page.goto(`${m.base}/c/${CHAT}`);
        await ready(d.page);
        await d.page.locator('#thread .turn').first().waitFor();
        assert.equal(await d.page.locator('body[data-empty]').count(), 0, `${where}: a thread is not an empty chat`);
        assert.deepEqual(await orbs(d.page), [size === '1440x900' ? 'rail' : 'topbar'], `${where}: a thread gets its one orb back`);
        assert.equal(await input.getAttribute('placeholder'), 'Reply to Nova…');
        assert.equal((await d.page.textContent('#title'))?.trim(), 'Friday plan');
        assert.ok(!(await d.page.locator('#dock .chips').isVisible()), `${where}: no suggestions in a thread`);
        const steps = d.page.locator('#thread details.steps');
        assert.equal(await steps.count(), 1, `${where}: a turn’s finished steps are one group`);
        assert.equal((await steps.locator(':scope > summary').textContent())?.trim(), '2 steps · 4 s');
        assert.equal(await steps.evaluate((e) => (e as HTMLDetailsElement).open), false, `${where}: collapsed`);
        assert.ok(!(await steps.locator('.record[data-tool="c1"]').isVisible()), `${where}: its steps are inside`);
        const composer = (await d.page.locator('#composer').boundingBox())!;
        assert.ok(composer.y + composer.height > vp.height - 140, `${where}: the composer is docked at the foot`);
        // A click on the summary leaves the pointer over Nova's message, which shows its exact time
        // (a hover); the shots open the group without a pointer or focus on the thread.
        await steps.locator(':scope > summary').click();
        assert.equal(await steps.evaluate((e) => (e as HTMLDetailsElement).open), true, `${where}: the group opens`);
        assert.ok(await steps.locator('.record[data-tool="c1"]').isVisible(), `${where}: and shows its steps`);
        await steps.evaluate((e) => { (e as HTMLDetailsElement).open = false; });
        await d.page.mouse.move(0, vp.height - 1);
        await d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        if (shots && size === '1440x900' && scheme === 'dark') await shoot(d.page, join(shots, `thread-steps-collapsed-${size}-nebula-${scheme}.png`));
        if (shots && ((size === '1440x900' && scheme === 'light') || (size === '390x844' && scheme === 'dark'))) {
          await steps.evaluate((e) => { (e as HTMLDetailsElement).open = true; });
          await shoot(d.page, join(shots, `thread-steps-open-${size}-nebula-${scheme}.png`));
        }
        assert.deepEqual(d.errors, [], `${where}: no errors in the page`);
        await d.ctx.close();
      }
    }
  } finally {
    await b.close();
    await stop(nova);
  }
});
