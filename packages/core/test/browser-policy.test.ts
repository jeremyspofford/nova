// Browser policy through the real policy gate (FR-094, FR-095, FR-189, docs/11 §4.4): the site
// lists and levels (as site-scoped rules), the new-site prompt, page writes at each level, the
// confirmation tiers the classifier sets, handoffs, the refused password, auto-review, developer-
// protocol mode, and failing closed without a gate.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Reviewer } from '../src/index.ts';
import { ACCOUNT, makeBrowserEnv, type BrowserEnv } from './browser-env.ts';
import type { FakePage } from './browser-fake.ts';

const SHOP: FakePage = {
  title: 'Shop',
  text: 'Welcome to the shop.',
  elements: [
    { role: 'link', tag: 'a', name: 'Next page', href: 'https://shop.example/2' },
    { role: 'button', tag: 'button', name: 'Buy now' },
    { role: 'textbox', tag: 'input', inputType: 'password', name: 'Password' },
    { role: 'iframe', tag: 'iframe', name: 'reCAPTCHA' },
    { role: 'link', tag: 'a', name: 'Elsewhere', href: 'https://other.example/' },
    { role: 'textbox', tag: 'input', name: 'Note' },
    { role: 'button', tag: 'button', name: 'Show details' },
  ],
  frames: ['https://www.google.com/recaptcha/api2/anchor'],
};

let env: BrowserEnv;

beforeEach(async () => {
  env = await makeBrowserEnv();
  env.driver.pages.set('https://shop.example/', SHOP);
  env.driver.pages.set('https://shop.example/2', { title: 'Page 2', text: 'two', elements: [] });
  env.driver.pages.set('https://other.example/', { title: 'Other', text: 'other', elements: [] });
});

afterEach(async () => {
  await env.close();
});

/** Allow the shop at a level and open it, then read it (refs). */
async function openShop(level: 'always_ask' | 'auto_review' | 'always_allow') {
  await env.service.sites.put(ACCOUNT, { pattern: 'shop.example', access: 'allow', level });
  const nav = await env.service.navigate(env.call(), 'https://shop.example/');
  expect(nav.ok).toBe(true);
  expect((await env.service.read(env.call())).ok).toBe(true);
}

describe('site lists and levels', () => {
  it('stores a level as a site-scoped rule on browser.act and removes it with the site', async () => {
    await env.service.sites.put(ACCOUNT, { pattern: 'Shop.Example', access: 'allow' });
    let rules = await env.store.listRules(ACCOUNT);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      scopeKind: 'site',
      scopeRef: 'shop.example',
      effect: 'ask',
      match: { tool: 'browser.act' },
    });
    const patched = await env.service.sites.patch(ACCOUNT, 'shop.example', {
      level: 'always_allow',
    });
    expect(patched.level).toBe('always_allow');
    rules = await env.store.listRules(ACCOUNT);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.effect).toBe('allow');
    // The user deleted the rule in Settings: setting a level writes it again.
    await env.store.deleteRule(ACCOUNT, rules[0]!.id);
    await env.service.sites.patch(ACCOUNT, 'shop.example', { level: 'auto_review' });
    expect((await env.store.listRules(ACCOUNT))[0]!.effect).toBe('allow');
    await env.service.sites.remove(ACCOUNT, 'shop.example');
    expect(await env.store.listRules(ACCOUNT)).toEqual([]);
    expect(env.service.sites.list(ACCOUNT)).toEqual([]);
    await expect(env.service.sites.remove(ACCOUNT, 'shop.example')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('decides: blocks win, exact beats wildcard, www is the same site, network settings count', async () => {
    await env.service.sites.put(ACCOUNT, {
      pattern: '*.example.com',
      access: 'allow',
      level: 'always_allow',
    });
    await env.service.sites.put(ACCOUNT, { pattern: 'docs.example.com', access: 'allow' });
    await env.service.sites.put(ACCOUNT, { pattern: 'bad.example.com', access: 'block' });
    const d = (h: string) => env.service.sites.decide(ACCOUNT, h);
    expect(await d('api.example.com')).toMatchObject({ access: 'allowed', level: 'always_allow' });
    expect(await d('docs.example.com')).toMatchObject({ access: 'allowed', level: 'always_ask' });
    expect(await d('bad.example.com')).toMatchObject({ access: 'blocked', source: 'site' });
    expect(await d('example.com')).toMatchObject({ access: 'unknown' });
    await env.service.sites.put(ACCOUNT, { pattern: 'news.example', access: 'allow' });
    expect(await d('www.news.example')).toMatchObject({ access: 'allowed' });
    env.settings['network.egressAllow'] = ['api.github.com'];
    env.settings['network.egressDeny'] = ['*.tracker.example'];
    expect(await d('api.github.com')).toMatchObject({ access: 'allowed', source: 'network' });
    expect(await d('x.tracker.example')).toMatchObject({ access: 'blocked', source: 'network' });
  });

  it('replaces the domain lists; a pattern on both is blocked', async () => {
    await env.service.sites.put(ACCOUNT, {
      pattern: 'keep.example',
      access: 'allow',
      level: 'always_allow',
    });
    const out = await env.service.sites.setDomains(ACCOUNT, {
      allow: ['keep.example', 'new.example', 'both.example'],
      deny: ['both.example', 'evil.example'],
    });
    expect(out).toEqual({
      allow: ['keep.example', 'new.example'],
      deny: ['both.example', 'evil.example'],
    });
    expect(env.service.sites.get(ACCOUNT, 'keep.example').level).toBe('always_allow');
    expect(env.service.sites.get(ACCOUNT, 'new.example').level).toBe('always_ask');
    expect(await env.service.sites.setDomains(ACCOUNT, { deny: [] })).toEqual({
      allow: ['keep.example', 'new.example'],
      deny: [],
    });
  });

  it('developer-protocol mode is never on a blocked site, and policy can turn it off', async () => {
    await expect(
      env.service.sites.put(ACCOUNT, { pattern: 'x.example', access: 'block', devProtocol: true }),
    ).rejects.toMatchObject({ code: 'validation' });
    env.settings['browser.devProtocol'] = false;
    await expect(
      env.service.sites.put(ACCOUNT, { pattern: 'x.example', access: 'allow', devProtocol: true }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(env.service.sites.patch(ACCOUNT, 'nope.example', {})).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('navigation', () => {
  it('a new site asks Allow once / Always allow / Deny; Always allow adds it at Always ask', async () => {
    const pending = env.service.navigate(env.call(), 'https://shop.example/');
    const asked = await env.answer('allow_always', { alwaysHost: 'shop.example' });
    expect(asked.action).toContain('shop.example');
    const out = await pending;
    expect(out.ok).toBe(true);
    const row = env.db.raw
      .prepare('SELECT options_json, always_scopes_json, tool_name FROM approval')
      .get() as { options_json: string; always_scopes_json: string; tool_name: string };
    expect(row.tool_name).toBe('browser.site');
    expect(JSON.parse(row.options_json)).toEqual(
      expect.arrayContaining(['allow_once', 'allow_session', 'allow_always', 'deny_continue']),
    );
    expect(JSON.stringify(JSON.parse(row.always_scopes_json))).toContain('"kind":"host"');
    expect(env.service.sites.get(ACCOUNT, 'shop.example')).toMatchObject({
      access: 'allow',
      level: 'always_ask',
    });
    // Known now: no second prompt.
    expect((await env.service.navigate(env.call(), 'https://shop.example/2')).ok).toBe(true);
    expect(env.approvals()).toHaveLength(1);
    const nav = env.events.events.filter((e) => e.name === 'browser.navigated');
    expect(nav.at(-1)!.payload).toMatchObject({ url: 'https://shop.example/2', allowed: true });
    expect(env.audit.some((a) => a.action === 'browser.site.set')).toBe(true);
  });

  it('Allow once lasts for the visit: links on the site work, other sites stay closed', async () => {
    const pending = env.service.navigate(env.call(), 'https://shop.example/');
    await env.answer('allow_once');
    expect((await pending).ok).toBe(true);
    expect(env.service.sites.list(ACCOUNT)).toEqual([]);
    await env.service.read(env.call());
    // A link to another site is blocked by the guard and reported.
    const pending2 = env.service.write(env.call(), { kind: 'click', ref: 'e5' });
    await env.answer('allow_once');
    const away = await pending2;
    expect(away.ok).toBe(false);
    expect(!away.ok && away.error.code).toBe('blocked_navigation');
    expect(!away.ok && away.error.message).toContain('other.example');
  });

  it('Deny refuses the navigation and records it', async () => {
    const pending = env.service.navigate(env.call(), 'https://shop.example/');
    await env.answer('deny_continue');
    const out = await pending;
    expect(out).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(env.driver.log).not.toContain('goto https://shop.example/');
    expect(env.service.recorder.list(ACCOUNT).at(-1)).toMatchObject({ result: 'denied' });
  });

  it('blocked sites and local addresses are refused without asking', async () => {
    await env.service.sites.put(ACCOUNT, { pattern: 'evil.example', access: 'block' });
    const blocked = await env.service.navigate(env.call(), 'https://evil.example/x');
    expect(blocked).toMatchObject({ ok: false, error: { code: 'blocked_site' } });
    const local = await env.service.navigate(env.call(), 'http://127.0.0.1:8080/');
    expect(local).toMatchObject({ ok: false, error: { code: 'blocked_site' } });
    expect(!local.ok && local.error.message).toContain('browser.allowLocalSites');
    expect(env.approvals()).toEqual([]);
    expect(env.audit.filter((a) => a.action === 'browser.navigation.blocked')).toHaveLength(2);
    expect(
      env.events.events.filter((e) => e.name === 'browser.navigated').map((e) => e.payload.allowed),
    ).toEqual([false, false]);
    for (const bad of ['ftp://x.example/', 'not a url', 'https://user:pw@shop.example/'])
      expect((await env.service.navigate(env.call(), bad)).ok).toBe(false);
  });
});

describe('page writes', () => {
  it('Always ask: every write asks with Allow once only, and Deny keeps the page untouched', async () => {
    await openShop('always_ask');
    const pending = env.service.write(env.call(), { kind: 'click', ref: 'e7' });
    const a = await env.answer('allow_once');
    expect(a.reason).toContain('Always ask');
    const row = env.db.raw
      .prepare('SELECT options_json, tool_name FROM approval WHERE id = ?')
      .get(a.approvalId) as {
      options_json: string;
      tool_name: string;
    };
    expect(row.tool_name).toBe('browser.act');
    expect(JSON.parse(row.options_json)).not.toContain('allow_session');
    const out = await pending;
    expect(out.ok).toBe(true);
    expect(env.driver.log).toContain('click e7');
    const second = env.service.write(env.call(), { kind: 'type', ref: 'e6', text: 'hello' });
    await env.answer('deny_continue');
    expect(await second).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(env.driver.fills).toEqual([]);
  });

  it('Always allow: unflagged writes run; a purchase still asks at the moment of action', async () => {
    await openShop('always_allow');
    expect((await env.service.write(env.call(), { kind: 'type', ref: 'e6', text: 'hi' })).ok).toBe(
      true,
    );
    expect(env.approvals()).toEqual([]);
    const buy = env.service.write(env.call(), { kind: 'click', ref: 'e2' });
    const a = await env.answer('deny_continue');
    expect(a.tier).toBe('confirm_at_action');
    expect(a.action).toContain('"Buy now"');
    expect(await buy).toMatchObject({ ok: false });
    expect(env.driver.log).not.toContain('click e2');
    const rec = env.service.recorder.list(ACCOUNT).at(-1)!;
    expect(rec).toMatchObject({ result: 'denied', target: 'button "Buy now"' });
    expect(rec.classification).toMatchObject({ flagged: true, effects: ['purchase'] });
    expect(env.approvals().at(-1)!.preview).toContain('looks like a purchase');
  });

  it('a CAPTCHA is handed off to the user, and a password is never typed', async () => {
    await openShop('always_allow');
    const captcha = env.service.write(env.call(), { kind: 'click', ref: 'e4' });
    const row = await (async () => {
      const a = await (async () => {
        for (;;) {
          const r = env.db.raw
            .prepare("SELECT id, tier FROM approval WHERE status = 'pending'")
            .get() as { id: string; tier: string } | undefined;
          if (r) return r;
          await new Promise((res) => setTimeout(res, 5));
        }
      })();
      return a;
    })();
    expect(row.tier).toBe('handoff_required');
    await env.gate.decide(ACCOUNT, { approvalId: row.id, decision: 'handoff' }, 'user');
    await env.gate.handoffDone(ACCOUNT, row.id, 'solved it');
    const out = await captcha;
    expect(out.ok).toBe(true);
    expect(out.ok && out.content[0]).toMatchObject({ text: expect.stringContaining('solved it') });
    expect(env.driver.log).not.toContain('click e4');
    // After a handoff the page may have changed: read it again.
    await env.service.read(env.call());
    const pw = await env.service.write(env.call(), { kind: 'type', ref: 'e3', text: 'hunter2' });
    expect(pw).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(!pw.ok && pw.error.message).toContain('browser.sign_in');
    expect(env.driver.fills).toEqual([]);
    expect(env.audit.find((a) => a.action === 'browser.action.denied')?.detail).toMatchObject({
      cause: 'password',
    });
  });

  it('stale refs and changed pages are refused; passive keys need no check', async () => {
    await openShop('always_ask');
    expect(await env.service.write(env.call(), { kind: 'click', ref: 'e99' })).toMatchObject({
      ok: false,
      error: { code: 'unknown_ref' },
    });
    SHOP.elements[0] = { ...SHOP.elements[0]!, name: 'Swapped' };
    try {
      expect(await env.service.write(env.call(), { kind: 'click', ref: 'e1' })).toMatchObject({
        ok: false,
        error: { code: 'page_changed' },
      });
    } finally {
      SHOP.elements[0] = { ...SHOP.elements[0], name: 'Next page' };
    }
    expect((await env.service.write(env.call(), { kind: 'press', key: 'Tab' })).ok).toBe(true);
    expect(env.approvals()).toEqual([]);
    expect((await env.service.scroll(env.call(), 'down', 400)).ok).toBe(true);
    expect(env.driver.log).toContain('scroll down 400');
  });

  it('fails closed without a policy gate', async () => {
    await env.close();
    env = await makeBrowserEnv({ gate: null });
    env.driver.pages.set('https://shop.example/', SHOP);
    await env.service.sites.put(ACCOUNT, {
      pattern: 'shop.example',
      access: 'allow',
      level: 'always_allow',
    });
    expect((await env.service.navigate(env.call(), 'https://shop.example/')).ok).toBe(true);
    await env.service.read(env.call());
    const out = await env.service.write(env.call(), { kind: 'click', ref: 'e1' });
    expect(out).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(!out.ok && out.error.message).toContain('policy gate is not connected');
    expect(await env.service.navigate(env.call(), 'https://unknown.example/')).toMatchObject({
      ok: false,
    });
  });
});

describe('Auto approve with review', () => {
  function reviewer(outcome: 'allow' | 'deny' | 'ask' | 'handoff'): Reviewer & { seen: number } {
    const r = {
      seen: 0,
      review: () => {
        r.seen++;
        return Promise.resolve({
          outcome,
          risk: 'low' as const,
          userAuthorization: 'unknown' as const,
          rationale: `reviewer said ${outcome}`,
          attempts: 1,
          failed: false,
        });
      },
    };
    return r;
  }

  it('runs an unflagged write the reviewer allows, and audits the verdict', async () => {
    const r = reviewer('allow');
    env.service.useReviewer(r);
    await openShop('auto_review');
    expect((await env.service.write(env.call(), { kind: 'click', ref: 'e1' })).ok).toBe(true);
    expect(r.seen).toBe(1);
    expect(env.approvals()).toEqual([]);
    expect(env.audit.some((a) => a.kind === 'review' && a.action === 'review.verdict')).toBe(true);
  });

  it('a reviewer deny refuses; an ask goes to the user; flagged actions skip it and ask', async () => {
    env.service.useReviewer(reviewer('deny'));
    await openShop('auto_review');
    const denied = await env.service.write(env.call(), { kind: 'click', ref: 'e1' });
    expect(denied).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(!denied.ok && denied.error.message).toContain('reviewer said deny');
    const asking = reviewer('ask');
    env.service.useReviewer(asking);
    const pending = env.service.write(env.call(), { kind: 'type', ref: 'e6', text: 'x' });
    const a = await env.answer('allow_once');
    expect(a.action).toContain('Auto-review asked');
    expect((await pending).ok).toBe(true);
    const buy = env.service.write(env.call(), { kind: 'click', ref: 'e2' });
    const b = await env.answer('deny_continue');
    expect(b.tier).toBe('confirm_at_action');
    await buy;
    expect(asking.seen).toBe(1);
  });

  it('without a reviewer the write goes to the user', async () => {
    await openShop('auto_review');
    const pending = env.service.write(env.call(), { kind: 'click', ref: 'e1' });
    const a = await env.answer('allow_once');
    expect(env.approvals().find((x) => x.action === a.action)?.preview).toContain(
      'Auto-review is not set up',
    );
    expect((await pending).ok).toBe(true);
  });
});

describe('developer-protocol mode', () => {
  it('evaluate needs the mode on for the site, and each run is checked', async () => {
    await openShop('always_ask');
    expect(await env.service.evaluate(env.call(), 'document.title')).toMatchObject({
      ok: false,
      error: { code: 'denied' },
    });
    await env.service.sites.patch(ACCOUNT, 'shop.example', { devProtocol: true });
    const pending = env.service.evaluate(env.call(), 'document.title');
    await env.answer('allow_once');
    const out = await pending;
    expect(out.ok).toBe(true);
    expect(out.ok && out.content[0]).toMatchObject({ text: expect.stringContaining('Result: 42') });
    env.settings['browser.devProtocol'] = false;
    expect((await env.service.evaluate(env.call(), '1')).ok).toBe(false);
  });
});
