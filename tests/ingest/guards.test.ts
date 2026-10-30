// The outbound guard (plan §7), holds for things from outside (§6), memory candidates (§8) and file
// provenance (§9), on the Ingest module directly. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../src/core/db.ts';
import { Ingest } from '../../src/core/ingest/screen.ts';

const SECRET = 'canary-vault-7f3e9a1c55d2';
const NOTE = 'Keeps the spare key under the blue flowerpot by the shed';
const STANDING = '# USER.md\n\nWorks nights at the example observatory on the north ridge.\n';

function setup() {
  const db = new Db(':memory:');
  db.migrate();
  const ingest = new Ingest({ db, secrets: () => [SECRET], memory: () => [NOTE], standing: () => [STANDING] });
  return { db, ingest };
}

test('a secret never leaves: plain, in a query, or encoded, tainted or not', () => {
  const { ingest } = setup();
  for (const tainted of [true, false]) {
    for (const text of [
      `https://collector.example/c?d=${SECRET}`,
      `https://collector.example/${Buffer.from(SECRET).toString('base64')}`,
      `https://collector.example/x?h=${Buffer.from(SECRET).toString('hex')}`,
      `https://collector.example/x?u=${[...SECRET].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('')}`,
      `Subject: hello\n\nThe code is ${SECRET.toUpperCase()}`,
    ]) {
      const r = ingest.outbound({ text }, { tainted });
      assert.equal(r.ok, false, text);
      assert.deepEqual(r.matched.map((m) => m.kind), ['secret'], text);
      assert.match(r.matched[0]!.words, /saved password or key/);
    }
  }
});

test('memory or standing-file content leaves a tainted run only with the person’s OK; 24 characters is enough', () => {
  const { ingest } = setup();
  const leak = `https://collector.example/c?d=${encodeURIComponent('spare key under the blue flowerpot')}`;
  const r = ingest.outbound({ text: leak }, { tainted: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.matched.map((m) => m.kind), ['memory']);
  assert.match(r.matched[0]!.words, /from your memory/);
  assert.equal(ingest.outbound({ text: 'q=works+nights+at+the+example+observatory' }, { tainted: true }).ok, false);
  // A short overlap is ordinary words.
  assert.equal(ingest.outbound({ text: 'https://www.example.org/search?q=blue+flowerpot' }, { tainted: true }).ok, true);
  // An untainted run, to a place the person gave, can share their own notes when they ask to.
  assert.equal(ingest.outbound({ text: leak }, { tainted: false }).ok, true);
});

test('long encoded blobs leave a tainted run only with an OK; ordinary research goes', () => {
  const { ingest } = setup();
  const blob = Buffer.from('a long run of words that someone wanted to smuggle out').toString('base64');
  const r = ingest.outbound({ text: `https://collector.example/p/${blob}` }, { tainted: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.matched.map((m) => m.kind), ['encoded']);
  for (const text of ['https://www.example.org/wiki/Bread', 'best merino wool hiking socks 2026', 'https://docs.example.com/api/v2/reference?lang=en#auth']) {
    assert.deepEqual(ingest.outbound({ text }, { tainted: true }), { ok: true, matched: [] }, text);
  }
});

test('holds: a thing from outside waits, with its reasons, until the person turns it on', () => {
  const { ingest } = setup();
  assert.equal(ingest.held('skill', 'example-skill'), null);
  ingest.hold('skill', 'example-skill', { id: 'scr-1', flags: [{ kind: 'instructions', level: 'quarantine', count: 1 }] });
  assert.deepEqual(ingest.held('skill', 'example-skill'), { screen: 'scr-1', reasons: ['instruction-like text'] });
  assert.deepEqual(ingest.holds('skill').map((h) => h.ref), ['example-skill']);
  ingest.release('skill', 'example-skill');
  assert.equal(ingest.held('skill', 'example-skill'), null);
});

test('memory candidates wait with their provenance, and only the person keeps or drops them', () => {
  const { ingest } = setup();
  const taint = [{ screen: 'scr-9', kind: 'web' as const, origin: 'www.example.org', verdict: 'quarantine' as const, max: null }];
  const id = ingest.candidate({ op: 'remember', kind: 'fact', content: 'The shop opens at nine.', source: 's1/t1', taint });
  const list = ingest.candidates();
  assert.equal(list.length, 1);
  assert.deepEqual([list[0]!.id, list[0]!.op, list[0]!.content, list[0]!.taint[0]!.origin], [id, 'remember', 'The shop opens at nine.', 'www.example.org']);
  const taken = ingest.takeCandidate(id);
  assert.equal(taken?.content, 'The shop opens at nine.');
  assert.equal(ingest.candidates().length, 0);
  const again = ingest.candidate({ op: 'forget', target: 'm1234', source: 's1/t2', taint });
  assert.equal(ingest.dropCandidate(again), true);
  assert.equal(ingest.dropCandidate(again), false);
});

test('file provenance: Nova’s own files by content hash; a changed file is unknown again', () => {
  const { ingest } = setup();
  assert.equal(ingest.isOwn('workspace/plan.md', 'a'.repeat(64)), false);
  ingest.markOwn('workspace/plan.md', 'a'.repeat(64));
  assert.equal(ingest.isOwn('workspace/plan.md', 'a'.repeat(64)), true);
  assert.equal(ingest.isOwn('workspace/plan.md', 'b'.repeat(64)), false);
  ingest.clearOwn('workspace/plan.md');
  assert.equal(ingest.isOwn('workspace/plan.md', 'a'.repeat(64)), false);
});
