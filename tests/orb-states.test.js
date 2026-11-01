// The orb's fixed semantic states (DESIGN-SYSTEM §1; owner decision 2026-10-31), as the theme
// check enforces them: every design system shows exactly the seven states, each different from the
// others in more than colour (with motion, and under reduced motion), with stopped unmistakable and
// red reserved for it. `npm run check:themes` runs the same validatePackage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { checkPackage } from '../scripts/check-themes.js';
import { ORB_STATES as SYSTEM_STATES, generateCss } from '../src/core/index.ts';
import { ORB_STATES as UI_STATES } from '../ui/js/status.js';

const orbTeal = () => JSON.parse(readFileSync('design-systems/orb-teal.json', 'utf8'));
const problems = (pkg) => checkPackage(pkg).problems.filter((p) => p.startsWith('orb_states'));

test('the state set is one list: the system’s, the UI’s and the owner’s', () => {
  assert.deepEqual([...SYSTEM_STATES], ['idle', 'listening', 'working', 'speaking', 'needs-you', 'stopped', 'offline']);
  assert.deepEqual([...UI_STATES], [...SYSTEM_STATES]);
});

test('every shipped design system declares exactly the seven states', () => {
  for (const f of readdirSync('design-systems').filter((x) => x.endsWith('.json'))) {
    const pkg = JSON.parse(readFileSync(join('design-systems', f), 'utf8'));
    assert.deepEqual(Object.keys(pkg.orb_states).sort(), [...SYSTEM_STATES].sort(), f);
    assert.deepEqual(problems(pkg), [], f);
  }
});

test('a design system that adds, removes or omits a state fails the check', () => {
  const added = orbTeal();
  added.orb_states.sparkling = { ...added.orb_states.idle, light: 'bright', mark: 'ring' };
  assert.ok(problems(added).some((p) => /orb_states\.sparkling isn’t one of the orb’s states.*can’t add one/.test(p)), problems(added).join('\n'));

  const removed = orbTeal();
  delete removed.orb_states.offline;
  assert.ok(problems(removed).some((p) => /orb_states\.offline is missing/.test(p)));

  const none = orbTeal();
  delete none.orb_states;
  assert.ok(checkPackage(none).problems.some((p) => /orb_states must be an object with the orb’s 7 states/.test(p)));

  const renamed = orbTeal();
  renamed.orb_states.alert = renamed.orb_states.stopped;
  delete renamed.orb_states.stopped;
  const said = problems(renamed);
  assert.ok(said.some((p) => /orb_states\.alert isn’t one of the orb’s states/.test(p)) && said.some((p) => /orb_states\.stopped is missing/.test(p)), said.join('\n'));
});

test('every state has a reduced-motion equivalent, and names only what the renderer draws', () => {
  const noReduced = orbTeal();
  delete noReduced.orb_states.working.reduced;
  assert.ok(problems(noReduced).some((p) => /orb_states\.working\.reduced is missing/.test(p)));
  const odd = orbTeal();
  odd.orb_states.idle.motion = 'wobble';
  odd.orb_states.idle.color = '#ff0000';
  odd.orb_states.idle.css = 'animation: x';
  const said = problems(odd);
  assert.ok(said.some((p) => /idle\.motion must be one of breathe, swirl/.test(p)));
  assert.ok(said.some((p) => /idle\.color must name a colour token/.test(p)));
  assert.ok(said.some((p) => /idle\.css isn’t part of a state’s look/.test(p)));
});

test('states may not differ by colour alone, with motion or under reduced motion', () => {
  const sameMoving = orbTeal();
  sameMoving.orb_states.working = { ...sameMoving.orb_states.listening, color: 'orb/core', reduced: { light: 'full', mark: 'dashed' } };
  assert.ok(problems(sameMoving).some((p) => /listening and working look the same apart from their colour/.test(p)), problems(sameMoving).join('\n'));
  const sameResting = orbTeal();
  sameResting.orb_states.working.reduced = { light: 'full', mark: 'none' };
  assert.ok(problems(sameResting).some((p) => /under reduced motion, listening and working look the same apart from their colour/.test(p)));
});

test('stopped is unmistakable: it shares no motion, light or mark with another state, and red is only its', () => {
  for (const [field, value, what] of [['motion', 'alarm', 'motion'], ['light', 'stark', 'light'], ['mark', 'ring', 'mark']]) {
    const pkg = orbTeal();
    pkg.orb_states.offline[field] = value;
    assert.ok(problems(pkg).some((p) => new RegExp(`stopped must be unmistakable, so no other state shares its ${what} \\(${value}\\); offline does`).test(p)), `${field}: ${problems(pkg).join('\n')}`);
  }
  const resting = orbTeal();
  resting.orb_states.speaking.reduced = { light: 'bright', mark: 'ring' };
  assert.ok(problems(resting).some((p) => /no other state shares its reduced mark \(ring\); speaking does/.test(p)));
  const blue = orbTeal();
  blue.orb_states.stopped.color = 'orb/core';
  assert.ok(problems(blue).some((p) => /orb_states\.stopped\.color must be status\/error/.test(p)));
  const redIdle = orbTeal();
  redIdle.orb_states.idle.color = 'status/error';
  assert.ok(problems(redIdle).some((p) => /idle\.color can’t be status\/error: red is reserved for stopped/.test(p)));
  const notAmber = orbTeal();
  notAmber.orb_states['needs-you'].color = 'accent/primary';
  assert.ok(problems(notAmber).some((p) => /needs-you\.color must be orb\/attention or status\/attention/.test(p)));
});

test('the generated CSS draws every state, and its reduced-motion equivalent', () => {
  const css = generateCss(orbTeal());
  for (const s of SYSTEM_STATES) assert.match(css, new RegExp(`\\.orb\\[data-state="${s}"\\] \\{`), s);
  assert.match(css, /\.orb\[data-state="stopped"\] \{[^}]*--orb-c: var\(--status-error\);[^}]*--orb-glow-anim: orb-alarm [^}]*--orb-mark: solid;/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const s of SYSTEM_STATES) assert.match(reduced, new RegExp(`\\.orb\\[data-state="${s}"\\] \\{[^}]*--orb-mark:`), `${s} under reduced motion`);
  // Under reduced motion only the brightness pattern is set: nothing that moves.
  assert.doesNotMatch(reduced, /--orb-glow-anim/);
});

test('npm run check:themes fails a design system that omits a state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-orb-'));
  const pkg = orbTeal();
  delete pkg.orb_states.speaking;
  const file = join(dir, 'broken.json');
  writeFileSync(file, JSON.stringify(pkg));
  let out = '';
  let code = 0;
  try { out = execFileSync(process.execPath, ['scripts/check-themes.js', file], { encoding: 'utf8' }); } catch (e) { code = e.status; out = e.stdout; }
  assert.equal(code, 1);
  assert.match(out, /orb_states\.speaking is missing/);
});
