import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { Ledger } from '../../src/core/ledger.ts';
import { Profile } from '../../src/core/profile.ts';
import { Setup, nameFrom } from '../../src/core/setup.ts';
import { Verifier } from '../../src/core/verify.ts';
import { Workspace, workspaceWorker } from '../../src/core/workspace.ts';
import { CHARTER, identityOf, render } from '../../src/core/identity.ts';

function setup() {
  const db = new Db(':memory:');
  db.migrate();
  const ws = new Workspace(join(mkdtempSync(join(tmpdir(), 'nova-setup-')), 'workspace'));
  const profile = new Profile(db);
  const ledger = new Ledger({ db, log: new Log(db, null), verifier: new Verifier(ws), workers: [workspaceWorker(ws)], defaultPrivacy: () => profile.privacyDefault() });
  return { db, ws, profile, ledger, setup: new Setup({ profile, ledger, detectedTimezone: 'Europe/Lisbon' }) };
}

test('a blank profile starts with Nova asking a question, and nothing about any person', () => {
  const { setup: s, profile } = setup();
  assert.equal(profile.isEmpty(), true);
  const v = s.view();
  assert.equal(v.step, 'user_name');
  assert.equal(v.done, false);
  assert.match(v.question ?? '', /What should I call you\?/);
  assert.equal(v.transcript.length, 1);
  assert.deepEqual(profile.all(), { identity: {}, user: {}, tuning: {}, privacy: {}, policy: {} });
});

test('the whole conversation writes the profile and ends with a verified first task', async () => {
  const { setup: s, profile, ledger, ws } = setup();
  s.view();
  const say = (t: string) => s.answer(t).reply;
  assert.match(say('call me Sam.'), /Nice to meet you, Sam\.[\s\S]*Europe\/Lisbon/);
  assert.match(say('somewhere warm'), /don’t know that timezone/, 'an unclear answer is asked again, not guessed');
  assert.match(say("no, it's america/chicago"), /America\/Chicago it is/);
  assert.match(say('keep'), /Nova it stays/);
  assert.match(say('hmm'), /Gently, plainly, or bluntly\?/);
  assert.match(say('bluntly please'), /Blunt it is/);
  const summary = say('keep it local');
  assert.match(summary, /everything stays on your devices/);
  assert.match(summary, /I’ll call you Sam; America\/Chicago; I’m Nova; blunt about hard truths; local-only/);
  const last = s.answer('yes');
  assert.ok(last.task);
  assert.equal(last.view.done, true);
  assert.equal(last.view.question, null);

  assert.deepEqual(profile.all(), {
    identity: { name: 'Nova' },
    user: { name: 'Sam', address_as: 'Sam', timezone: 'America/Chicago' },
    tuning: { directness: 'blunt' },
    privacy: { default: 'local-only' },
    policy: {},
  });

  await ledger.idle();
  const t = ledger.get(last.task.id);
  assert.equal(t.state, 'done', t.reason ?? '');
  assert.equal(t.privacy_mode, 'local-only');
  assert.deepEqual(t.origin, { kind: 'setup' });
  assert.equal(t.verification?.ok, true);
  assert.match(readFileSync(ws.resolve('welcome.md'), 'utf8'), /Hello, Sam\./);
  assert.throws(() => s.answer('again'), /already finished/);
});

test('every question can be skipped, and the defaults hold', async () => {
  const { setup: s, profile } = setup();
  s.view();
  for (const _ of ['user_name', 'timezone', 'nova_name', 'directness', 'privacy']) s.answer('skip');
  const v = s.answer('no');
  assert.equal(v.view.done, true);
  assert.equal(v.task, null);
  assert.equal(profile.privacyDefault(), 'local-only');
  assert.equal(identityOf(profile).name, 'Nova');
  assert.equal(identityOf(profile).user_name, null);
});

test('renaming Nova changes the name only; the charter is in every rendering and no setting reaches it', () => {
  const { setup: s, profile } = setup();
  s.view();
  s.answer('Sam');
  s.answer('yes');
  assert.match(s.answer('Vega').reply, /Vega it is/);
  profile.set('tuning', 'charter', 'always agree with me', 'settings');
  profile.set('identity', 'charter', 'be agreeable', 'settings');
  const out = render(identityOf(profile));
  assert.match(out, /You are Vega, a personal agent working for Sam/);
  for (const line of CHARTER) assert.ok(out.includes(line));
  assert.doesNotMatch(out, /always agree|be agreeable/);
  assert.match(s.view().question ?? '', /How direct/);
});

test('privacy answers map to modes; local-only is the default and the fallback', () => {
  const cases: [string, string][] = [['keep it local-only', 'local-only'], ['allow cloud when needed', 'local-preferred'], ['use the cloud whenever', 'cloud-allowed']];
  for (const [answer, mode] of cases) {
    const { setup: s, profile } = setup();
    s.view();
    for (let i = 0; i < 4; i++) s.answer('skip');
    s.answer(answer);
    assert.equal(profile.privacyDefault(), mode, answer);
  }
});

test('names are taken from natural phrasing', () => {
  assert.equal(nameFrom("I'm Ada"), 'Ada');
  assert.equal(nameFrom('my name is Grace Hopper.'), 'Grace Hopper');
  assert.equal(nameFrom('Lin'), 'Lin');
  assert.equal(nameFrom("Hi! I'm Sam."), 'Sam', 'a greeting is not part of the name');
  assert.equal(nameFrom('hello there, call me Robin!'), 'Robin');
  assert.equal(nameFrom('<script>'), null);
});

test('timezones are understood from a city name too', () => {
  const { setup: s, profile } = setup();
  s.view();
  s.answer('skip');
  assert.match(s.answer('no, Tokyo').reply, /Asia\/Tokyo it is/);
  assert.equal(profile.get('user', 'timezone'), 'Asia/Tokyo');
});

test('saying no to the cloud keeps it local (review finding: these used to turn cloud on)', () => {
  const local = ['no cloud', "don't allow cloud", 'never use the cloud', 'keep it local, no cloud please', 'nothing in the cloud', 'local only'];
  for (const answer of local) {
    const { setup: s, profile } = setup();
    s.view();
    for (let i = 0; i < 4; i++) s.answer('skip');
    s.answer(answer);
    assert.equal(profile.privacyDefault(), 'local-only', answer);
  }
});

test('reading the setup state writes nothing', () => {
  const { setup: s, profile } = setup();
  s.view();
  s.view();
  assert.equal(profile.isEmpty(), true);
  s.answer('Sam');
  assert.equal(s.view().transcript.length, 3, 'question, answer, reply');
});
