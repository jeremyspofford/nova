// M10b gate 2 and the co-pilot: what pages put in Nova's way. An injected dialog (on the page and as
// an alert) is screened and blocked, nothing it asked for happens, and the co-pilot (a stand-in local
// model that keeps every prompt) only ever sees screened extracts, never the dialog's words. A
// CAPTCHA is the person's: Nova asks and waits. A model sure against Nova's own ground truth stops
// the step. Runs where Chromium can start (scripts/ui-test.sh; CI's UI gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canBrowse, sleep, startNova, startShop, until } from './m10b-support.ts';

const ORDINARY = { element_matches_intent: 0.9, page_changed_as_expected: 0.9, obstacle: 0.05, dark_pattern: 0.05, total_matches: 0.9, dialog_injection: 0.05 };
const asked = (body: any) => body?.format?.properties?.answers?.properties ?? {};
const said = (body: any) => (body?.messages ?? []).map((m: { content: string }) => m.content).join('\n');
// The ingest screen's stand-in: an injection phrase is one.
const screenReply = (text: string) => {
  const p = /ignore (all )?previous instructions/i.test(text) ? 0.96 : 0.03;
  return JSON.stringify({ answers: { direct_instruction: p, hidden_instruction: 0.03, exfiltration: p, impersonation: 0.03, unrequested_action: p }, confidence: 0.9, why: 'stand-in' });
};

test('M10b gate 2: an injected dialog is blocked; nothing it asked for happens; the co-pilot sees only screened extracts', { timeout: 180_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const copilot: string[] = [];
  const reply = (body: any) => {
    const q = asked(body);
    if ('dialog_injection' in q) {
      const text = said(body);
      copilot.push(text);
      return JSON.stringify({ answers: { ...ORDINARY, dialog_injection: /Nova blocked this/.test(text) ? 0.95 : 0.05 }, confidence: 0.9, why: 'stand-in' });
    }
    if ('direct_instruction' in q) return screenReply(said(body));
    return 'Facts: an example shop sells a mug and tea.';
  };
  const shop = await startShop({ injection: true });
  const n = await startNova('nova-m10b-inject-', { model: reply });
  try {
    const { m, api } = n;
    const plan = {
      allowed_hosts: [shop.host],
      steps: [{ do: 'navigate', url: `${shop.url}/cart/empty` }, { do: 'navigate', url: `${shop.url}/shop` }, { do: 'click', selector: '#add-mug', intent: 'add the mug to the cart' }, { do: 'read', selector: '#cart', expect: 'Example mug' }],
      verify: { url: `${shop.url}/cart`, expect: ['Example mug'] },
    };
    const { id } = await n.task(plan, 'Put a mug in the cart');
    const done = await n.done(id!);
    assert.equal(done.state, 'done', `${done.reason}`);
    const ev = await n.events(id!);
    const blocked = ev.filter((e) => e.kind === 'dialog_blocked');
    assert.deepEqual([...new Set(blocked.map((e) => e.detail.kind))].sort(), ['js-alert', 'page'], JSON.stringify(blocked.map((e) => e.detail)));
    assert.ok(blocked.every((e) => e.detail.screen), 'each blocked dialog has its screen on record');
    assert.match(done.report.summary, /Blocked 2 dialogs that tried to give instructions; nothing in them was followed/);
    // The screens are in the ingest record; the blocked page text opened a ledger entry.
    const screens = (await m.get(api('/ingest/screens'))) as { id: string; verdict: string }[];
    for (const b of blocked) assert.ok(screens.some((s) => s.id === b.detail.screen), b.detail.screen);
    const tasks = (await m.get(api('/tasks'))) as { owner: string; title: string }[];
    assert.ok(tasks.some((x) => x.owner === 'ingest' && x.title.includes(shop.host)), 'a block is in the Work Ledger');
    // Nothing it asked for happened.
    assert.equal(shop.hits('/steal').length, 0, 'no request to /steal');
    assert.equal(shop.paid(), 0);
    // The co-pilot was asked, and never saw the dialog's own words.
    assert.ok(copilot.length >= 4, `the co-pilot was asked (${copilot.length})`);
    for (const p of copilot) assert.ok(!/SYSTEM NOTICE|\/steal|ignore (all )?previous instructions/i.test(p), `a co-pilot prompt held raw page text:\n${p.slice(0, 600)}`);
    assert.ok(copilot.some((p) => /Nova blocked this/.test(p)), 'it saw the block line in its place');
    console.log(`  · Injection: ${blocked.length} dialogs blocked (a dialog on the page and an alert), each screened (${blocked.map((b) => b.detail.verdict).join(', ')}); /steal requests: 0; ${copilot.length} co-pilot prompts, none with the dialog's words.`);
  } finally {
    await n.close();
    await shop.close();
  }
});

test('M10b gate 2, with no local model: Nova’s own checks alone block the injected dialog', { timeout: 180_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop({ injection: true });
  const n = await startNova('nova-m10b-inject-nomodel-');
  try {
    const plan = {
      allowed_hosts: [shop.host],
      steps: [{ do: 'navigate', url: `${shop.url}/shop` }, { do: 'click', selector: '#add-mug' }, { do: 'read', selector: '#cart', expect: 'Example mug' }],
      verify: { url: `${shop.url}/cart`, expect: ['Example mug'] },
    };
    const { id } = await n.task(plan, 'Put a mug in the cart');
    const done = await n.done(id!);
    assert.equal(done.state, 'done', `${done.reason}`);
    const blocked = (await n.events(id!)).filter((e) => e.kind === 'dialog_blocked');
    assert.deepEqual([...new Set(blocked.map((e) => e.detail.kind))].sort(), ['js-alert', 'page']);
    assert.ok(blocked.every((e) => e.detail.flags.includes('instructions')), JSON.stringify(blocked.map((e) => e.detail)));
    assert.equal(shop.hits('/steal').length, 0);
  } finally {
    await n.close();
    await shop.close();
  }
});

test('a CAPTCHA is the person’s: Nova asks, waits while they solve it, and carries on', { timeout: 180_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const n = await startNova('nova-m10b-captcha-');
  try {
    const { m, api } = n;
    const { id } = await n.task({ allowed_hosts: [shop.host], steps: [{ do: 'navigate', url: `${shop.url}/captcha` }, { do: 'wait', selector: '#solved:not([hidden])' }], verify: { expect: ['Thanks'] } }, 'Open the page past its check');
    const view = await until(() => m.get(api(`/browser/tasks/${id}`)), (v) => v.mode === 'needs_person');
    assert.match(view.asked, /CAPTCHA .*Nova never solves one/);
    assert.ok((await n.events(id!)).some((e) => e.kind === 'captcha_found'));
    assert.equal(shop.solved(), false, 'Nova didn’t touch it');
    assert.equal((await m.send('POST', api(`/browser/tasks/${id}/takeover`))).status, 200);
    assert.equal((await m.send('POST', api(`/browser/tasks/${id}/input`), { type: 'click', x: 40 / 1280, y: 40 / 800 })).status, 200);
    await until(async () => shop.solved(), (v) => v, 10_000);
    await sleep(300);
    assert.equal((await m.send('POST', api(`/browser/tasks/${id}/handback`))).status, 200);
    const done = await n.done(id!);
    assert.equal(done.state, 'done', `${done.reason}`);
  } finally {
    await n.close();
    await shop.close();
  }
});

test('ground truth outranks the co-pilot: a model sure of an obstacle the page doesn’t have stops the step', { timeout: 180_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const reply = (body: any) => {
    const q = asked(body);
    if ('dialog_injection' in q) return JSON.stringify({ answers: { ...ORDINARY, obstacle: 0.97 }, confidence: 0.9, why: 'stand-in: sure of a wall' });
    if ('direct_instruction' in q) return screenReply(said(body));
    return 'Facts: an example shop.';
  };
  const shop = await startShop();
  const n = await startNova('nova-m10b-disagree-', { model: reply });
  try {
    const { id } = await n.task({ allowed_hosts: [shop.host], steps: [{ do: 'navigate', url: `${shop.url}/shop` }, { do: 'read', selector: 'h1', expect: 'Example shop' }], verify: { expect: ['Example shop'] } }, 'Open the shop');
    const done = await n.done(id!);
    assert.equal(done.state, 'failed');
    assert.match(done.reason ?? '', /own check and its co-pilot disagree about whether a sign-in, a CAPTCHA or a paywall is in the way.*The page itself says no/);
    const c = (await n.events(id!)).find((e) => e.kind === 'copilot')!;
    assert.deepEqual([c.detail.model, c.detail.checks.obstacle.truth, c.detail.checks.obstacle.p], [true, false, 0.97]);
  } finally {
    await n.close();
    await shop.close();
  }
});
