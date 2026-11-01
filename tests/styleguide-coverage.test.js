// OPERATING-RULES (owner direction 2026-11-01): a component that isn't in the styleguide doesn't ship.
// Every component the UI exports (ui/js/components.js, and the views in ui/js/view.js) is drawn by
// the living styleguide (ui/js/styleguide.js), or is a helper named here with what it is. A new
// component fails this until its styleguide entry exists, which is the design-first workflow's
// first deliverable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exports that aren't components: words, logic, or a piece drawn only inside a component that is.
const HELPERS = {
  'ui/js/components.js': {
    card: 'the frame every card is drawn in (BriefCard, HandlingCard, …)', deviceDetail: 'words inside DeviceRow', pickedRoles: 'reads a form',
    takeoverState: 'what the takeover panel says', takeoverActions: 'buttons inside the takeover panel', takeoverRefused: 'a line inside the takeover panel',
    problemsSummary: 'words inside HealthCard', voiceState: 'words beside the composer',
    // Known debt, said plainly: exported but drawn nowhere in the app (the shell draws its own toast).
    toast: 'unused: the app’s toast is drawn by shell.js, whose markup the styleguide shows',
  },
  'ui/js/view.js': {
    longDate: 'words', shortDay: 'words', exactTime: 'words', msgTime: 'words', toolLabel: 'words', toolState: 'logic', relWhen: 'words', took: 'words', daySentence: 'words',
    renderNotes: 'drawn inside renderTurn', collapseLines: 'logic', renderKept: 'drawn inside renderTurn', renderSkillNote: 'drawn inside renderTurn',
    renderBlocks: 'the thread, made of renderTurn', renderThread: 'the thread, made of renderTurn', memoryIndex: 'logic', activityEntry: 'drawn inside renderActivity',
    // Known debt: the Gmail connection's card in Settings › Connections has no entry yet.
    renderGmail: 'not yet in the styleguide (conformed opportunistically, per the UX fix list)',
  },
};

const guide = readFileSync('ui/js/styleguide.js', 'utf8');

for (const [file, helpers] of Object.entries(HELPERS)) {
  test(`every component ${file} exports is in the styleguide`, () => {
    const exported = [...readFileSync(file, 'utf8').matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
    assert.ok(exported.length > 5, `${file} exports components`);
    const missing = exported.filter((name) => !(name in helpers) && !new RegExp(`\\b${name}\\(`).test(guide));
    assert.deepEqual(missing, [], `drawn by ui/js/styleguide.js, or named as a helper here with what it is`);
    // The helper list only names what still exists.
    assert.deepEqual(Object.keys(helpers).filter((h) => !exported.includes(h)), [], 'no stale helper names');
  });
}

test('each styleguide entry has its own anchor and address, so it can be approved alone', () => {
  const ids = [...guide.matchAll(/^\s+\['([a-z][a-z-]*)', '[^']+', '/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 30, `entries: ${ids.join(', ')}`);
  assert.equal(new Set(ids).size, ids.length, 'entry ids are unique');
  for (const reserved of ['ds', 'mode']) assert.ok(!ids.includes(reserved), `#sg-${reserved} is the design switch`);
  assert.match(guide, /id="sg-\$\{id\}"/);
  assert.match(guide, /href="\?entry=\$\{id\}"/);
});

test('the styleguide’s content is neutral: no real people, services or data', () => {
  for (const word of ['Flying Tools', 'Dana', 'kindergarten', 'Maple Street', 'inhaler', 'Lisbon', 'amazon.com']) assert.ok(!guide.includes(word), word);
});
