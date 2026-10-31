// Setup's two consent questions (M10f review, finding 1): whether to look, and where; and what to
// bring in. Consent is explicit and fails closed: anything Nova can't read as an unambiguous yes is a
// no or a question back. A negation before a source (not, no, don't, without, except, never) leaves it
// out; "only" leaves out everything else; "sure, but not X" is everything but X. Looking on the
// network needs a network yes, and under local-only the warning acknowledged too. A recording
// onboarding stands in for discovery and import, so nothing touches the network or reads a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { Ledger } from '../../src/core/ledger.ts';
import { Profile } from '../../src/core/profile.ts';
import { Setup, quietOnboarding } from '../../src/core/setup.ts';
import { Verifier } from '../../src/core/verify.ts';
import { Workspace, workspaceWorker } from '../../src/core/workspace.ts';
import { readPicks, readScope } from '../../src/core/onboard/consent.ts';

const SOURCES = [
  { id: 'notes:Notes', kind: 'notes', label: 'notes in ~/Notes', path: '/nonexistent/Notes', files: 3, app: null },
  { id: 'calendar:~/a.ics', kind: 'calendar', label: 'a calendar file, ~/a.ics', path: '/nonexistent/a.ics', files: 1, app: null },
  { id: 'bookmarks:chrome', kind: 'bookmarks', label: 'bookmarks from Chrome', path: '/nonexistent/Bookmarks', files: 1, app: 'Chrome' },
  { id: 'bookmarks:firefox', kind: 'bookmarks', label: 'bookmarks from Firefox', path: '/nonexistent/places.sqlite', files: 1, app: 'Firefox' },
] as const;

async function setupTo(privacy: string) {
  const db = new Db(':memory:');
  db.migrate();
  const ws = new Workspace(join(mkdtempSync(join(tmpdir(), 'nova-consent-')), 'workspace'));
  const profile = new Profile(db);
  const ledger = new Ledger({ db, log: new Log(db, null), verifier: new Verifier(ws), workers: [workspaceWorker(ws)], defaultPrivacy: () => profile.privacyDefault() });
  const seen: { scopes: string[]; picked: string[][] } = { scopes: [], picked: [] };
  const on = {
    ...quietOnboarding({ os: 'linux' }),
    discover: async (scope: 'device' | 'network') => { seen.scopes.push(scope); return { scope, found: [], looked: [], transport: 'test', bound: null, at: new Date().toISOString() }; },
    sources: () => SOURCES as never,
    import: async (picked: { id: string }[]) => { seen.picked.push(picked.map((p) => p.id)); return []; },
  };
  const s = new Setup({ profile, ledger, detectedTimezone: 'UTC', onboarding: on });
  for (const t of ['new', 'yes', 'yes', 'Sam', 'yes', 'keep', 'plainly', privacy]) await s.answer(t);
  assert.equal(s.view().step, 'discover');
  return { s, seen };
}

test('where to look: “not the network”, “only this computer” and the like never look on the network; unclear asks again', () => {
  const device = ['Just this computer, not the network.', 'Only this computer please, no network', 'this computer too', 'yes, but not the network', 'yes', 'this computer', 'here only, without the network', 'locally, never the network', 'This computer'];
  for (const t of device) assert.equal(readScope(t), 'device', t);
  const network = ['the network too', 'this computer and the network', 'both', 'The network too', 'yes, the network as well', 'network too please'];
  for (const t of network) assert.equal(readScope(t), 'network', t);
  const none = ['no', 'No', 'skip', 'not now', 'no thanks', 'nothing', 'don’t look', 'neither'];
  for (const t of none) assert.equal(readScope(t), 'none', t);
  const unclear = ['hmm', 'network? no', 'maybe', 'the network, no wait', 'everything', 'what does that mean', 'not this computer'];
  for (const t of unclear) assert.equal(readScope(t), 'unclear', t);
});

test('what to bring in: negations leave a source out, “only” leaves the rest out, and a bare refusal reads nothing', () => {
  const ids = (t: string) => { const r = readPicks(t, SOURCES as never); return r.kind === 'picked' ? r.ids : r.kind; };
  assert.deepEqual(ids('Notes only, no bookmarks'), ['notes:Notes']);
  assert.deepEqual(ids('sure, but not the calendar'), ['notes:Notes', 'bookmarks:chrome', 'bookmarks:firefox']);
  assert.equal(ids('I don’t want the calendar'), 'unclear', 'a refusal of one thing is not a yes to the rest');
  assert.deepEqual(ids('all'), ['notes:Notes', 'calendar:~/a.ics', 'bookmarks:chrome', 'bookmarks:firefox']);
  assert.deepEqual(ids('everything except the bookmarks'), ['notes:Notes', 'calendar:~/a.ics']);
  assert.deepEqual(ids('notes and the calendar'), ['notes:Notes', 'calendar:~/a.ics']);
  assert.deepEqual(ids('only the calendar'), ['calendar:~/a.ics']);
  assert.deepEqual(ids('bookmarks from Chrome'), ['bookmarks:chrome'], 'a source named exactly is that source only');
  assert.deepEqual(ids('Chrome bookmarks, not Firefox'), ['bookmarks:chrome']);
  assert.deepEqual(ids('yes, without the notes'), ['calendar:~/a.ics', 'bookmarks:chrome', 'bookmarks:firefox']);
  assert.deepEqual(ids('notes, never bookmarks'), ['notes:Notes']);
  assert.equal(ids('none'), 'none');
  assert.equal(ids('no'), 'none');
  assert.equal(ids('no thanks'), 'none');
  assert.equal(ids('not the notes'), 'unclear');
  assert.equal(ids('hmm'), 'unclear');
  assert.equal(ids('notes? no'), 'unclear', 'a mention and a bare no together are unclear');
  // What a screen sends: the labels picked, joined.
  assert.deepEqual(ids('notes in ~/Notes, bookmarks from Firefox'), ['notes:Notes', 'bookmarks:firefox']);
});

test('in setup: the reviewer’s phrasings look and read only what was said yes to', async () => {
  for (const [answer, scope] of [['Just this computer, not the network.', 'device'], ['Only this computer please, no network', 'device'], ['this computer too', 'device'], ['yes, but not the network', 'device']] as const) {
    const { s, seen } = await setupTo('allow cloud when needed');
    await s.answer(answer);
    assert.deepEqual(seen.scopes, [scope], answer);
    assert.equal(s.view().step, 'import');
  }
  for (const [answer, picked] of [['Notes only, no bookmarks', ['notes:Notes']], ['sure, but not the calendar', ['notes:Notes', 'bookmarks:chrome', 'bookmarks:firefox']]] as const) {
    const { s, seen } = await setupTo('allow cloud when needed');
    await s.answer('this computer');
    await s.answer(answer);
    assert.deepEqual(seen.picked, [picked], answer);
  }
  const { s, seen } = await setupTo('allow cloud when needed');
  await s.answer('this computer');
  const r = await s.answer('I don’t want the calendar');
  assert.deepEqual(seen.picked, [], 'nothing read');
  assert.equal(r.view.step, 'import', 'asked again');
  assert.match(r.reply, /Which/);
  // An unclear scope asks again, and looks at nothing.
  const u = await setupTo('allow cloud when needed');
  const q = await u.s.answer('network? no');
  assert.deepEqual(u.seen.scopes, []);
  assert.equal(q.view.step, 'discover');
});

test('under local-only, looking on the network waits for the warning to be acknowledged; anything else looks on this computer only or asks', async () => {
  const yes = await setupTo('keep everything on this machine');
  const asked = await yes.s.answer('the network too');
  assert.deepEqual(yes.seen.scopes, [], 'nothing sent yet');
  assert.equal(asked.view.step, 'discover');
  assert.match(asked.reply, /sends one short query[\s\S]*beyond this machine/);
  assert.deepEqual(asked.view.options!.choices.map((c) => c.id), ['network-ok', 'device', 'no']);
  await yes.s.answer('yes, look on the network');
  assert.deepEqual(yes.seen.scopes, ['network']);

  const back = await setupTo('keep everything on this machine');
  await back.s.answer('the network too');
  await back.s.answer('this computer only');
  assert.deepEqual(back.seen.scopes, ['device']);

  const no = await setupTo('keep everything on this machine');
  await no.s.answer('the network too');
  await no.s.answer('no');
  assert.deepEqual(no.seen.scopes, [], 'a no to the warning looks nowhere');
  assert.equal(no.s.view().step, 'first_task');

  const unclear = await setupTo('keep everything on this machine');
  await unclear.s.answer('the network too');
  const again = await unclear.s.answer('hmm');
  assert.deepEqual(unclear.seen.scopes, []);
  assert.equal(again.view.step, 'discover');

  // Outside local-only, a network yes is enough.
  const open = await setupTo('allow cloud when needed');
  await open.s.answer('the network too');
  assert.deepEqual(open.seen.scopes, ['network']);
});
