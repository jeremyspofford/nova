// The gate job's decision (scripts/ci-gate.sh), owner pipeline ruling 2026-11-11: every combination
// of event, change kind and job result, so the one required check is tested, not only its YAML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RESULTS = ['success', 'failure', 'cancelled', 'skipped', ''];

function gate(env) {
  const r = spawnSync('sh', ['scripts/ci-gate.sh'], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  return { pass: r.status === 0, out: r.stdout + r.stderr, status: r.status };
}

// The rule, written out independently of the script: the combinations that pass.
function expected({ EVENT, CHANGES, HEAVY, UI_SURFACE, CHECKS, UI, SHOTS }) {
  if (CHANGES !== 'success') return false;
  if (HEAVY === 'false') return CHECKS === 'skipped' && UI === 'skipped' && SHOTS === 'skipped';
  if (HEAVY !== 'true') return false;
  const all = CHECKS === 'success' && UI === 'success' && SHOTS === 'success';
  if (EVENT === 'push') return all;
  if (EVENT !== 'pull_request') return false;
  if (UI_SURFACE === 'true') return all;
  if (UI_SURFACE === 'false') return CHECKS === 'success' && UI === 'skipped' && SHOTS === 'skipped';
  return false;
}

test('gate: every combination of event, kind and job results decides as the rule says', () => {
  let passes = 0, cases = 0;
  for (const EVENT of ['pull_request', 'push', 'workflow_dispatch'])
    for (const HEAVY of ['true', 'false', ''])
      for (const UI_SURFACE of ['true', 'false', ''])
        for (const CHECKS of RESULTS)
          for (const UI of RESULTS)
            for (const SHOTS of RESULTS) {
              const env = { EVENT, CHANGES: 'success', HEAVY, UI_SURFACE, CHECKS, UI, SHOTS };
              const r = gate(env);
              assert.equal(r.status === 0 || r.status === 1, true, `exits 0 or 1: ${JSON.stringify(env)}`);
              assert.equal(r.pass, expected(env), `${JSON.stringify(env)}\n${r.out}`);
              cases++; if (r.pass) passes++;
            }
  // Docs only passes with all three skipped for any event and UI value (3 × 3), plus one heavy pass
  // each for: PR + UI, PR + non-UI, push with ui true, false or empty (main ignores the UI value).
  assert.equal(passes, 9 + 1 + 1 + 3, `passing combinations out of ${cases}`);
});

test('gate: the change could not be sorted, so it fails whatever else passed', () => {
  for (const CHANGES of ['failure', 'cancelled', 'skipped', '']) {
    for (const EVENT of ['pull_request', 'push']) {
      const r = gate({ EVENT, CHANGES, HEAVY: 'true', UI_SURFACE: 'true', CHECKS: 'success', UI: 'success', SHOTS: 'success' });
      assert.equal(r.pass, false, `${CHANGES} ${EVENT}`);
      assert.match(r.out, /couldn't be sorted/);
    }
  }
});

test('gate: the named cases the pipeline doc describes', () => {
  const ok = (env) => gate({ CHANGES: 'success', ...env });
  // Non-UI pull request: checks alone, UI gate and shots skipped.
  assert.equal(ok({ EVENT: 'pull_request', HEAVY: 'true', UI_SURFACE: 'false', CHECKS: 'success', UI: 'skipped', SHOTS: 'skipped' }).pass, true);
  assert.match(ok({ EVENT: 'pull_request', HEAVY: 'true', UI_SURFACE: 'false', CHECKS: 'success', UI: 'skipped', SHOTS: 'skipped' }).out, /push to main/);
  // A non-UI pull request whose checks failed or were cancelled.
  for (const CHECKS of ['failure', 'cancelled', 'skipped'])
    assert.equal(ok({ EVENT: 'pull_request', HEAVY: 'true', UI_SURFACE: 'false', CHECKS, UI: 'skipped', SHOTS: 'skipped' }).pass, false, CHECKS);
  // A UI pull request whose UI gate was skipped: that is not green.
  assert.equal(ok({ EVENT: 'pull_request', HEAVY: 'true', UI_SURFACE: 'true', CHECKS: 'success', UI: 'skipped', SHOTS: 'skipped' }).pass, false);
  // One cancelled shard (the UI gate's result is cancelled) fails a UI pull request and main.
  assert.equal(ok({ EVENT: 'pull_request', HEAVY: 'true', UI_SURFACE: 'true', CHECKS: 'success', UI: 'cancelled', SHOTS: 'success' }).pass, false);
  assert.equal(ok({ EVENT: 'push', HEAVY: 'true', UI_SURFACE: 'false', CHECKS: 'success', UI: 'cancelled', SHOTS: 'success' }).pass, false);
  // Main skipping the UI gate is never green, even for a non-UI merge.
  assert.equal(ok({ EVENT: 'push', HEAVY: 'true', UI_SURFACE: 'false', CHECKS: 'success', UI: 'skipped', SHOTS: 'skipped' }).pass, false);
  assert.equal(ok({ EVENT: 'push', HEAVY: 'true', UI_SURFACE: 'false', CHECKS: 'success', UI: 'success', SHOTS: 'success' }).pass, true);
  // Docs only, unchanged: all skipped passes; a heavy job that ran anyway fails.
  assert.equal(ok({ EVENT: 'pull_request', HEAVY: 'false', UI_SURFACE: 'false', CHECKS: 'skipped', UI: 'skipped', SHOTS: 'skipped' }).pass, true);
  assert.equal(ok({ EVENT: 'push', HEAVY: 'false', UI_SURFACE: 'false', CHECKS: 'success', UI: 'skipped', SHOTS: 'skipped' }).pass, false);
});

test('gate: the workflow runs this script with every input it reads', () => {
  const yml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = /^  gate:\n([\s\S]*?)(?=^  [a-z][\w-]*:\n|(?![\s\S]))/m.exec(yml)?.[1];
  assert.ok(job, 'the gate job exists');
  assert.match(job, /run: sh scripts\/ci-gate\.sh/);
  assert.match(job, /needs: \[changes, checks, ui-gate, shots\]/);
  assert.match(job, /if: always\(\)/);
  for (const [k, v] of Object.entries({
    EVENT: 'github.event_name', CHANGES: 'needs.changes.result', HEAVY: 'needs.changes.outputs.heavy',
    UI_SURFACE: 'needs.changes.outputs.ui', CHECKS: 'needs.checks.result', UI: 'needs.ui-gate.result', SHOTS: 'needs.shots.result',
  })) assert.ok(job.includes(`${k}: \${{ ${v} }}`), `${k} comes from ${v}`);
  // The UI gate and shots run on a pull request only for a UI change, on main for every heavy merge.
  const cond = "needs.changes.outputs.heavy == 'true' && (github.event_name == 'push' || needs.changes.outputs.ui == 'true')";
  for (const name of ['ui-gate', 'shots']) {
    const j = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n)`, 'm').exec(yml)?.[1];
    assert.ok(j?.includes(`if: ${cond}`), `${name} runs on: ${cond}`);
  }
});
