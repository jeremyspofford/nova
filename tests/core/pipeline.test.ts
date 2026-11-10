// Where Nova stands (src/core/pipeline.ts, GET /api/v1/pipeline): generated from the roadmap, gate
// evidence, plans and the ledger, never kept by hand. Each state stands on a record; without one it
// is "designed" at best. A record that doesn't keep its shape is left out and said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipelineView, STATES, type Item } from '../../src/core/pipeline.ts';

const ROOT = join(import.meta.dirname, '..', '..');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nova-pipeline-'));
  const w = (p: string, text: string) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), text); };
  w('docs/builder-packet/ROADMAP-AND-GATES.md', [
    '# ROADMAP', '', 'Intro.', '',
    '## Owner roadmap — 2026-11-03', 'Goals.', '',
    '## M1 — Core skeleton', '- Gate: one task.', '',
    '## M2 — Memory (Amendment 2026-10-30-C Part 9)', '- Gate.', '',
    '## M3 — Design system', '- Gate.', '',
    '## Ingest security gate (Amendment 2026-10-30-C Part 3)', '- Screens.', '',
    '## M4 — Execution Plane', '- Built as phases M4a–M4c; M4d is named here.', '',
    '## Direction only (no work scheduled): reviews', 'Later.', '',
    '## Sequencing rules', '- Order.', '',
  ].join('\n'));
  w('docs/evidence/m2-gate.md', '# M2 gate — evidence\n\nRun.\n');
  w('docs/evidence/m4a-gate.md', '# M4a gate evidence: the computer\n');
  w('docs/evidence/ingest-gate.md', '# Ingest security gate — evidence (Amendment)\n');
  w('docs/evidence/untitled.md', 'No title here.\n');
  w('docs/plans/M3.md', '# M3 plan — design system\n');
  w('docs/plans/M4b.md', '# M4b plan: the browser\n');
  w('docs/LEDGER.md', [
    '# Ledger', '', '## What changed (plain language)', '',
    '**2026-10-30 · #213 · M1: the core, plainly**', '- What changed: a core.', '- What you can now do: chat.', '- Still unfinished: nothing.', '',
    '## Decisions', '', '**2026-10-29 · #1 · M3: not plain language, not read**', '- What changed: no.',
  ].join('\n'));
  const entry = (date: string, area: string, head: string) => `**${date} · ${area} · ${head}**\n- What changed: ${head}.\n- What you can now do: see it.\n- Still unfinished: more.\n- Checked: tests.\n`;
  w('docs/ledger/README.md', '# Ledger\n');
  w('docs/ledger/2026-11-06-ui-design.md', entry('2026-11-06', 'UI rebuild (design)', 'A proposed look'));
  w('docs/ledger/2026-11-07-ui-shell.md', entry('2026-11-07', 'UI rebuild', 'The shell takes the look'));
  w('docs/ledger/2026-11-07-t2-one.md', entry('2026-11-07', 'Passkeys (1 of 2)', 'Passkeys can be kept'));
  w('docs/ledger/2026-11-08-wol.md', entry('2026-11-08', 'Models', 'Waking computers: the design you approved, not built yet'));
  w('docs/ledger/2026-11-08-broken.md', 'Just text, no headline.\n');
  w('docs/ledger/Not-A-Name.md', entry('2026-11-08', 'UI', 'Misnamed'));
  return root;
}
const find = (items: Item[], id: string) => { const it = items.find((i) => i.id === id); assert.ok(it, `${id} is listed`); return it!; };

test('roadmap milestones take their state from gate evidence, the ledger and plans; phases make a milestone in progress', () => {
  const v = pipelineView(fixture());
  const road = v.workstreams[0]!;
  assert.equal(road.name, 'Roadmap');
  assert.deepEqual(road.items.map((i) => i.id), ['owner-roadmap', 'M1', 'M2', 'M3', 'ingest-security-gate', 'M4', 'M4a', 'M4b', 'M4c', 'M4d', 'direction-only-reviews'], 'roadmap order, phases after their milestone, no "Sequencing rules"');
  const m1 = find(road.items, 'M1');
  assert.deepEqual([m1.state, m1.evidence?.kind, m1.evidence?.path, m1.evidence?.pull, m1.evidence?.now], ['merged', 'ledger', 'docs/LEDGER.md', 213, 'chat.']);
  assert.deepEqual([find(road.items, 'M2').state, find(road.items, 'M2').evidence?.path, find(road.items, 'M2').name], ['merged', 'docs/evidence/m2-gate.md', 'M2 · Memory']);
  assert.deepEqual([find(road.items, 'M3').state, find(road.items, 'M3').evidence?.kind], ['designed', 'plan'], 'a plan without evidence is designed; the Decisions section is not read as history');
  assert.deepEqual([find(road.items, 'ingest-security-gate').state, find(road.items, 'ingest-security-gate').evidence?.path], ['merged', 'docs/evidence/ingest-gate.md']);
  assert.deepEqual(['M4a', 'M4b', 'M4c', 'M4d'].map((c) => find(road.items, c).state), ['merged', 'designed', 'none', 'none']);
  assert.equal(find(road.items, 'M4a').name, 'M4a · The computer');
  const m4 = find(road.items, 'M4');
  assert.equal(m4.state, 'progress');
  assert.match(m4.why, /1 of its 4 phases are merged; M4b, M4c, M4d not yet/);
  assert.deepEqual([find(road.items, 'owner-roadmap').state, find(road.items, 'owner-roadmap').name], ['designed', 'Owner roadmap'], 'a section of its own with no record is designed at best');
  assert.equal(find(road.items, 'direction-only-reviews').state, 'none');
  for (const it of road.items) assert.ok(it.evidence && it.why, `${it.id} says what its state stands on`);
});

test('the ledger: one workstream per area, newest first; designs are designed, an unfinished series in progress; bad files left out and said', () => {
  const v = pipelineView(fixture());
  const names = v.workstreams.slice(1).map((w) => w.name);
  assert.deepEqual(names, ['Models', 'UI rebuild', 'Passkeys'], 'newest area first, "(design)" folded into its area');
  const ui = v.workstreams.find((w) => w.name === 'UI rebuild')!;
  assert.deepEqual(ui.items.map((i) => [i.name, i.state]), [['The shell takes the look', 'merged'], ['A proposed look', 'designed']]);
  assert.deepEqual(ui.items[0]!.evidence, { kind: 'ledger', path: 'docs/ledger/2026-11-07-ui-shell.md', title: 'The shell takes the look', date: '2026-11-07', changed: 'The shell takes the look.', now: 'see it.', unfinished: 'more.', url: 'https://github.com/jeremyspofford/nova/blob/main/docs/ledger/2026-11-07-ui-shell.md' });
  assert.equal(v.workstreams.find((w) => w.name === 'Models')!.items[0]!.state, 'designed', 'a headline that says "not built yet" is a design');
  assert.equal(v.workstreams.find((w) => w.name === 'Passkeys')!.items[0]!.state, 'progress', 'part 1 of 2, with no part 2 in the ledger');
  assert.equal(v.problems.length, 3, v.problems.join('\n'));
  assert.ok(v.problems.some((p) => /2026-11-08-broken\.md doesn't start with/.test(p)));
  assert.ok(v.problems.some((p) => /Not-A-Name\.md isn't named/.test(p)));
  assert.ok(v.problems.some((p) => /untitled\.md has no "# " title/.test(p)));
  const total = v.workstreams.reduce((n, w) => n + w.items.length, 0);
  assert.equal(STATES.reduce((n, s) => n + v.counts[s], 0), total, 'the totals count every item once');
});

test('read-only and contained: deterministic, plain files only, nothing outside the fixed folders, no absolute paths', () => {
  const root = fixture();
  symlinkSync(join(root, 'docs', 'ledger', '2026-11-07-ui-shell.md'), join(root, 'docs', 'ledger', '2026-11-09-linked.md'));
  const a = pipelineView(root);
  assert.deepEqual(pipelineView(root), a, 'the same files give the same answer');
  assert.ok(!JSON.stringify(a).includes(root), 'no absolute path is returned');
  assert.ok(!a.workstreams.some((w) => w.items.some((i) => i.id === '2026-11-09-linked')), 'a link is not followed');
  const none = pipelineView(mkdtempSync(join(tmpdir(), 'nova-pipeline-empty-')));
  assert.deepEqual(none.workstreams, []);
  assert.match(none.problems[0]!, /ROADMAP-AND-GATES\.md isn’t in this build/);
});

test('this repository: every item’s evidence is a file that exists here, and nothing is left out', () => {
  const v = pipelineView(ROOT);
  assert.deepEqual(v.problems, []);
  assert.equal(v.workstreams[0]!.name, 'Roadmap');
  assert.ok(v.workstreams.length > 1, 'the ledger has workstreams');
  for (const w of v.workstreams) for (const it of w.items) {
    assert.ok(it.evidence, `${it.id} has evidence`);
    assert.ok(existsSync(join(ROOT, it.evidence!.path)), `${it.id}: ${it.evidence!.path} exists`);
    assert.ok(STATES.includes(it.state));
  }
  assert.ok(v.counts.merged > 0);
});

// ---- A-080 ≡ F-048: state from what the records can show, and links that open them -----------------

test('a gate evidence file that says the gate failed or passed in part is not merged; one that says passed is, and says emulated', () => {
  const root = fixture();
  const w = (p: string, text: string) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), text); };
  w('docs/evidence/m1-gate.md', '# M1 gate — evidence\n\nRun on the hub.\n\n**Result:** failed: the restart drill timed out.\n');
  w('docs/evidence/m3-gate.md', '# M3 gate — evidence\n\nResult: partial (emulated): two of three engines.\n');
  w('docs/evidence/m2-gate.md', '# M2 gate — evidence\n\nResult: passed (emulated phones)\n');
  const items = pipelineView(root).workstreams[0]!.items;
  assert.deepEqual([find(items, 'M1').state, find(items, 'M1').evidence?.result], ['progress', 'failed'], 'a failed gate never counts as merged, though the ledger history names M1');
  assert.match(find(items, 'M1').why, /says the gate failed/);
  assert.equal(find(items, 'M3').state, 'progress');
  assert.match(find(items, 'M3').why, /passed only in part/);
  assert.equal(find(items, 'M2').state, 'merged');
  assert.match(find(items, 'M2').why, /says the gate passed, on emulated devices/);
});

test('a ledger part that runs over several lines keeps every line', () => {
  const root = fixture();
  writeFileSync(join(root, 'docs', 'LEDGER.md'), [
    '# Ledger', '', '## What changed (plain language)', '',
    '**2026-10-30 · #213 · M1: the core, plainly**', '- What changed: a core.', '- What you can now do: chat.', '- Still unfinished: three things.', '  - the first;', '  - the second;', '  - the third.', '',
  ].join('\n'));
  assert.equal(find(pipelineView(root).workstreams[0]!.items, 'M1').evidence?.unfinished, 'three things. - the first; - the second; - the third.');
});

test('every record opens: a link to the file at the running commit (main without one), and a history entry\'s pull request', () => {
  const root = fixture();
  const items = (o?: { commit?: string | null }) => pipelineView(root, o).workstreams.flatMap((x) => x.items);
  for (const it of items({ commit: 'c0ffee1234567890' })) if (it.evidence) assert.equal(it.evidence.url, `https://github.com/jeremyspofford/nova/blob/c0ffee1234567890/${it.evidence.path}`, it.id);
  assert.equal(find(items(), 'M1').evidence?.url, 'https://github.com/jeremyspofford/nova/blob/main/docs/LEDGER.md');
  assert.equal(find(items(), 'M1').evidence?.pull_url, 'https://github.com/jeremyspofford/nova/pull/213');
  // A commit that isn't one is never put in a link.
  assert.match(find(items({ commit: '../../evil' }), 'M1').evidence!.url!, /\/blob\/main\//);
});

test('this repository: no ledger entry for the owner\'s reaction, proposed, or not built yet is counted merged, and each carries its design note', () => {
  const v = pipelineView(ROOT);
  const ledgerItems = v.workstreams.filter((w) => w.source === 'ledger').flatMap((w) => w.items);
  const designs = ledgerItems.filter((it) => /\b(not built yet|for (?:the )?owner(?:['’]s)? reaction|proposed for)\b/i.test(it.name));
  assert.ok(designs.length >= 15, `the compositions and proposals are found (${designs.length})`);
  for (const it of designs) assert.equal(it.state, 'designed', `${it.id}: ${it.name}`);
});
