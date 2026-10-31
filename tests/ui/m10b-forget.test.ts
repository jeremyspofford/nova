// The second review of PR #238, 8: Forget, against everything a site can keep in Nova's profile:
// a partitioned (CHIPS) cookie and an ordinary one, local storage, IndexedDB, Cache Storage and the
// origin-private file system, both first-party and partitioned under another top-level site (the
// site embedded in a page of another site Nova visited). The stand-in page reads every store back
// and reports what it found to its own server. Runs where Chromium can start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canBrowse, startNova, startShop, type Shop } from './m10b-support.ts';

const STORES = ['part', 'plain', 'local', 'idb', 'cache', 'opfs'];
const report = (shop: Shop, label: string) => {
  const r = shop.log.filter((l: { path: string; query: string }) => l.path === '/r2-report' && new URLSearchParams(l.query).get('label') === label).at(-1);
  return r ? Object.fromEntries(new URLSearchParams(r.query)) : null;
};

test('second review 8: Forget clears first-party and partitioned cookies and storage, caches and OPFS', { timeout: 240_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const site = await startShop();
  const other = await startShop();
  const n = await startNova('nova-m10b-forget2-');
  try {
    const { m, api } = n;
    const X = `localhost:${site.port}`;
    const Y = `127.0.0.1:${other.port}`;
    const visit = async (write: boolean, tag: string) => {
      const store = (label: string) => `http://${X}/r2store?write=${write ? 1 : 0}&label=${label}`;
      const { id } = await n.task({
        allowed_hosts: [X, Y],
        steps: [
          { do: 'navigate', url: store(`${tag}-first`) }, { do: 'wait', selector: '#done' },
          { do: 'navigate', url: `http://${Y}/r2embed?src=${encodeURIComponent(store(`${tag}-under-other`))}` }, { do: 'wait', selector: '#done' },
        ],
        verify: { expect: ['Embed'] },
      }, `Visit the site (${tag})`);
      const done = await n.done(id!);
      assert.equal(done.state, 'done', `${tag}: ${done.reason}`);
      return { first: report(site, `${tag}-first`), under: report(site, `${tag}-under-other`) };
    };
    await visit(true, 'write');
    const before = await visit(false, 'before');
    console.log(`  · before Forget: first-party ${JSON.stringify(before.first)}; under another site ${JSON.stringify(before.under)}`);
    // First-party Cache Storage lives with service workers, which no task carries to the next, so it
    // is already gone; everything else was kept.
    for (const k of ['part', 'local', 'idb', 'opfs']) assert.equal(before.first?.[k], 'yes', `first-party ${k} was kept`);
    for (const k of ['part', 'local', 'idb', 'cache', 'opfs']) assert.equal(before.under?.[k], 'yes', `partitioned ${k} was kept`);
    const f = await m.send('POST', api(`/browser/sites/${X}/forget`), { confirm: true });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    const after = await visit(false, 'after');
    console.log(`  · after Forget: first-party ${JSON.stringify(after.first)}; under another site ${JSON.stringify(after.under)}`);
    for (const k of STORES) {
      assert.notEqual(after.first?.[k], 'yes', `first-party ${k} gone`);
      assert.notEqual(after.under?.[k], 'yes', `partitioned ${k} gone`);
    }
  } finally {
    await n.close();
    await site.close();
    await other.close();
  }
});
