// Review of PR #238, 6: hostile sign-in pages, in Chromium, against loopback stand-ins and per-test
// fake credentials.
//  - A page reads back what Nova set every way it can (the value, input/change/keyup listeners, a
//    MutationObserver, polling, form serialisation), copies it into the title, the address and the
//    text, and tries to send it to another host, by beacon and by fetch: nothing reaches the other
//    host, the page's own non-GET sends are refused, and nothing Nova writes holds the value.
//  - A sign-in saved for host A is never typed on B: another port, a subdomain, a lookalike
//    (punycode) name, about:blank, a blob: page, a popup; a data: page, which Chromium won't let a
//    page open, gets nothing either.
//  - Fields in a cross-origin frame are never filled.
//  - A field swapped just before the fill is refused.
// What a page does with a value on its own site (a GET to itself) is the site's: it is the site the
// sign-in belongs to. Runs where Chromium can start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canBrowse, fakeLogin, filesHolding, startNova, startShop } from './m10b-support.ts';

const loginStep = { do: 'login', username: '#username', password: '#password', submit: '#signin', done_when: '#account' };

test('review 6: a page that reads back and tries to send a sign-in gets it nowhere off its site, and Nova writes it nowhere', { timeout: 180_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const cred = fakeLogin();
  const shop = await startShop({ ...cred });
  const other = await startShop();
  const n = await startNova('nova-m10b-exfil-');
  try {
    const { m, api } = n;
    assert.equal((await m.send('PUT', api(`/browser/logins/${shop.host}`), cred)).status, 200);
    const { id } = await n.task({
      allowed_hosts: [shop.host],
      steps: [{ do: 'navigate', url: `${shop.url}/exfil?other=${encodeURIComponent(other.url)}` }, loginStep, { do: 'read', selector: 'main' }],
      verify: { url: `${shop.url}/signins`, expect: ['Signed in: 1'] },
    }, 'Sign in on a page that reads back');
    const done = await n.done(id!);
    assert.equal(done.state, 'done', `${done.reason}`);
    assert.deepEqual(other.log, [], 'the other host got nothing');
    assert.equal(shop.hits('/collect').filter((h: { method: string }) => h.method !== 'GET').length, 0, 'the page’s own beacon and form serialisation were refused');
    const ev = await n.events(id!);
    assert.ok(ev.some((e) => e.kind === 'send_refused'), JSON.stringify(ev.map((e) => e.kind)));
    const secrets = [cred.password, cred.username];
    assert.deepEqual(filesHolding(m.dir, secrets), [], 'no file Nova wrote holds it (the title, address and text copies included)');
    assert.ok(!secrets.some((s) => JSON.stringify(ev).includes(s) || JSON.stringify(done).includes(s) || n.nova.out.join('').includes(s)));
  } finally {
    await n.close();
    await shop.close();
    await other.close();
  }
});

test('review 6: a sign-in saved for one host is never typed on another (port, subdomain, lookalike, about:blank, blob:, data:, popup) or into a cross-origin frame', { timeout: 300_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const cred = fakeLogin();
  const shop = await startShop({ ...cred });
  const other = await startShop({ ...cred });
  const n = await startNova('nova-m10b-hosts-');
  try {
    const { m, api } = n;
    const A = `localhost:${shop.port}`;
    assert.equal((await m.send('PUT', api(`/browser/logins/${A}`), cred)).status, 200);
    const cases: [string, string, string, RegExp][] = [
      ['another port', `localhost:${other.port}`, `http://localhost:${other.port}/login`, /no sign-in saved for localhost:\d+/],
      ['a subdomain', `sub.localhost:${shop.port}`, `http://sub.localhost:${shop.port}/login`, /no sign-in saved for sub\.localhost/],
      ['a lookalike', `lоcalhost.localhost:${shop.port}`, `http://lоcalhost.localhost:${shop.port}/login`, /no sign-in saved for xn--/],
      ['about:blank', A, `http://${A}/to-blank`, /isn’t a web page|Nothing on|isn’t on the page|can’t tell which site|isn’t where the plan expected/],
      ['a blob: page', A, `http://${A}/to-blob`, /isn’t a web page|Nothing on|isn’t on the page|can’t tell which site|isn’t where the plan expected/],

      ['a popup', A, `http://${A}/popup`, /Nothing on .* matches #username/],
      ['a cross-origin frame', A, `http://${A}/iframe-login?from=${encodeURIComponent(other.url)}`, /Nothing on .* matches #username/],
    ];
    for (const [what, host, url, reason] of cases) {
      const hosts = [...new Set([host, A, `127.0.0.1:${other.port}`])];
      const plan = { allowed_hosts: hosts, steps: [{ do: 'navigate', url }, { ...loginStep, timeout_ms: 2500 }], verify: { url: `http://${A}/signins`, expect: ['Signed in: 1'] } };
      const { id, created } = await n.task(plan, `Sign in (${what})`);
      assert.ok(id, `${what}: ${JSON.stringify(created.body)}`);
      const done = await n.done(id!);
      assert.equal(done.state, 'failed', `${what}: ${done.reason}`);
      assert.match(done.reason ?? '', reason, what);
      assert.ok(!(await n.events(id!)).some((e) => e.kind === 'signed_in_with'), `${what}: nothing was typed`);
    }
    // A data: page: Chromium refuses a page's own top-level navigation to one, so the page stays on A,
    // and a sign-in there is A's own. Whatever happens, nothing is typed anywhere but on A.
    const d = await n.task({ allowed_hosts: [A], steps: [{ do: 'navigate', url: `http://${A}/to-data` }, { ...loginStep, timeout_ms: 2500 }], verify: { url: `http://${A}/signins`, expect: ['Signed in: 1'] } }, 'Sign in (a data: page)');
    const dd = await n.done(d.id!);
    const typed = (await n.events(d.id!)).filter((e) => e.kind === 'signed_in_with');
    assert.ok(typed.every((e) => e.detail.site === A), `${dd.state}: ${JSON.stringify(typed)}`);
    assert.equal(shop.hits('/login').filter((h: { method: string }) => h.method === 'POST').length, typed.length, 'only a sign-in on A itself reached the stand-in');
    assert.equal(other.hits('/login').filter((h: { method: string }) => h.method === 'POST').length, 0, 'nor did the other host');
    assert.deepEqual(filesHolding(m.dir, [cred.password, cred.username]), []);
  } finally {
    await n.close();
    await shop.close();
    await other.close();
  }
});

test('review 6: a field swapped just before the fill is refused, and nothing is sent', { timeout: 120_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const cred = fakeLogin();
  const shop = await startShop({ ...cred });
  const n = await startNova('nova-m10b-swap-');
  try {
    const { m, api } = n;
    assert.equal((await m.send('PUT', api(`/browser/logins/${shop.host}`), cred)).status, 200);
    const { id } = await n.task({ allowed_hosts: [shop.host], steps: [{ do: 'navigate', url: `${shop.url}/swap-login` }, loginStep], verify: { url: `${shop.url}/signins`, expect: ['Signed in: 1'] } }, 'Sign in on a page that swaps its fields');
    const done = await n.done(id!);
    assert.equal(done.state, 'failed');
    assert.match(done.reason ?? '', /swapped|changed .* as Nova/);
    assert.equal(shop.hits('/login').filter((h: { method: string }) => h.method === 'POST').length, 0);
  } finally {
    await n.close();
    await shop.close();
  }
});
