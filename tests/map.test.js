import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMap, readEntityFile } from '../src/map.js';
import { layout, bounds } from '../ui/js/stellar/layout.js';
import { writeSampleHome } from '../scripts/sample-home.js';

const NOW = new Date('2026-10-26T12:00:00Z');
const sample = () => { const h = mkdtempSync(join(tmpdir(), 'nova-map-')); writeSampleHome(h, NOW); return h; };
const build = (h) => buildMap(h, { now: NOW, timezone: 'America/New_York' });
const node = (m, id) => m.nodes.find((n) => n.id === id);

test('every body comes from a file, and says which', () => {
  const m = build(sample());
  for (const n of m.nodes) if (n.kind !== 'stack') assert.ok(n.source, `${n.id} has no source`);
  assert.equal(node(m, 'core').type, 'core');
  assert.equal(node(m, 'you').name, 'Sam Rivera');
  assert.equal(node(m, 'you').source, 'USER.md');
  assert.equal(node(m, 'you').pinned, true);
  assert.equal(node(m, 'person:ana-rivera').source, 'memory/people/ana-rivera.md');
  assert.equal(node(m, 'topic:northwind').type, 'planet');
  assert.equal(node(m, 'goal:remote-platform-role').type, 'star');
  assert.deepEqual(['file:IDENTITY.md', 'file:SOUL.md', 'file:AGENTS.md'].map((id) => node(m, id)?.parent), ['core', 'core', 'core']);
});

test('people are planets linked to each other, never through the core', () => {
  const m = build(sample());
  assert.ok(m.links.some((l) => [l.a, l.b].includes('you') && [l.a, l.b].includes('person:leo-rivera')));
  assert.ok(!m.links.some((l) => l.a === 'core' || l.b === 'core'));
  assert.deepEqual(m.clusters.map((c) => c.name), ['Family']);
  assert.ok(m.clusters[0].members.includes('you'));
});

test('memories orbit what they name; facts naming no one orbit you', () => {
  const m = build(sample());
  assert.equal(node(m, 'm:m2b3c4d5e').parent, 'person:leo-rivera');       // Leo's inhaler
  assert.equal(node(m, 'm:m1a2b3c4d').parent, 'you');                     // coffee: about the owner
  assert.equal(node(m, 'm:m8192a3b4').parent, 'person:dana-okafor');      // full name
  assert.match(node(m, 'm:m1a2b3c4d').reason, /names no one else/);
});

test('recent days are comets; old notes naming no one are asteroids', () => {
  const m = build(sample());
  const comets = m.nodes.filter((n) => n.type === 'comet');
  assert.equal(comets.length, 3);
  assert.ok(comets.every((c) => c.age < 30));
  assert.ok(comets.find((c) => c.near.includes('person:leo-rivera')));
  assert.equal(node(m, 'm:n4e5f6071').parent, 'person:leo-rivera');      // 45 days old, names Leo: a moon
  assert.equal(node(m, 'm:n5f607182').type, 'asteroid');                  // 45 days old, names no one
});

test('rebuildable: the same files give the same sky, and a deleted file takes its body with it', () => {
  const h = sample();
  const a = build(h); const b = build(h);
  assert.deepEqual(a, b);
  const la = layout(a); const lb = layout(b);
  assert.deepEqual([...la.pos], [...lb.pos]);
  rmSync(join(h, 'memory', 'people', 'mia-rivera.md'));
  const c = build(h);
  assert.equal(node(c, 'person:mia-rivera'), undefined);
  assert.equal(node(c, 'm:m6f708192').parent, 'you'); // Mia's note now names no one with a file
});

test('names: whole words with their capitals, [[slug]] links, and "Also called"', () => {
  const h = sample();
  appendFileSync(join(h, 'MEMORY.md'), '- Annie booked the dentist. <!-- id=m00000001 at=2026-10-20T10:00:00Z -->\n- The northwind blew all night. <!-- id=m00000002 at=2026-10-20T10:00:00Z -->\n- See [[ana-rivera]] about Thursday. <!-- id=m00000003 at=2026-10-20T10:00:00Z -->\n');
  const m = build(h);
  assert.equal(node(m, 'm:m00000001').parent, 'person:ana-rivera');
  assert.equal(node(m, 'm:m00000002').parent, 'you');
  assert.equal(node(m, 'm:m00000003').parent, 'person:ana-rivera');
  assert.deepEqual(readEntityFile('---\npinned: yes\naka: Kate, K\n---\n# Katherine\n', 'kate'), { name: 'Katherine', aka: ['Kate', 'K'].filter((s) => s.length >= 2), pinned: true, front: { pinned: 'yes', aka: 'Kate, K' } });
});

test('size is salience: relative, inspectable, and the owner is never small', () => {
  const m = build(sample());
  const planets = m.nodes.filter((n) => n.type === 'planet');
  for (const p of planets) { assert.ok(p.salience > 0 && p.salience <= 1); assert.ok(p.why && typeof p.why.mentions === 'number'); }
  assert.equal(Math.max(...planets.map((p) => p.salience)), node(m, 'you').salience);
});

test('dense skies gather moons and asteroids into stacks past ~300 bodies', () => {
  const h = sample();
  const lines = Array.from({ length: 320 }, (_, i) => `- Leo note ${i}. <!-- id=m${(0x10000000 + i).toString(16)} at=2026-10-01T10:00:00Z -->`);
  appendFileSync(join(h, 'MEMORY.md'), `${lines.join('\n')}\n`);
  const m = build(h);
  assert.ok(m.nodes.length <= 300, `${m.nodes.length} bodies`);
  const stack = node(m, 'stack:person:leo-rivera');
  assert.ok(stack && stack.count > 300 - 12 && stack.entries.length === stack.count);
});

test('an empty home is just the Nova and its own files', () => {
  const h = mkdtempSync(join(tmpdir(), 'nova-map-empty-'));
  for (const f of ['USER.md', 'IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'MEMORY.md']) copyFileSync(new URL(`../templates/home/${f}`, import.meta.url).pathname, join(h, f));
  mkdirSync(join(h, 'memory'));
  const m = build(h);
  assert.deepEqual(m.nodes.map((n) => n.id).sort(), ['core', 'file:AGENTS.md', 'file:IDENTITY.md', 'file:SOUL.md', 'you'].sort());
  assert.equal(node(m, 'you').name, 'You');
});

test('layout: the core at the centre, nothing on top of anything', () => {
  const m = build(sample());
  const lay = layout(m);
  assert.deepEqual([lay.pos.get('core').x, lay.pos.get('core').y], [0, 0]);
  const tops = m.nodes.filter((n) => n.type === 'planet' || n.type === 'star').map((n) => ({ id: n.id, ...lay.pos.get(n.id) }));
  for (let i = 0; i < tops.length; i++) {
    assert.ok(Math.hypot(tops[i].x, tops[i].y) > tops[i].r + 40, `${tops[i].id} sits in the core`);
    for (let j = i + 1; j < tops.length; j++) {
      const d = Math.hypot(tops[i].x - tops[j].x, tops[i].y - tops[j].y);
      assert.ok(d > tops[i].r + tops[j].r, `${tops[i].id} overlaps ${tops[j].id}`);
    }
  }
  const b = bounds(lay, m);
  assert.ok(b.x0 < 0 && b.x1 > 0);
});
