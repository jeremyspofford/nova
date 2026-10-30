// Shared by the provider tests and the M5 gate: the "make the failing test in calc/ pass" brief,
// its workspace files, and scripts for the stand-in agents (scripts/stand-ins/).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const FAKE_CLAUDE = join(ROOT, 'scripts/stand-ins/fake-claude.js');
export const FAKE_CODEX = join(ROOT, 'scripts/stand-ins/fake-codex.js');

export const BROKEN_SUM = 'export const sum = (a, b) => a - b;\n';
export const FIXED_SUM = 'export const sum = (a, b) => a + b;\n';
export const SUM_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.mjs';\n\ntest('adds', () => assert.equal(sum(2, 3), 5));\n";

// The calc/ folder in a workspace, with one failing test.
export function writeCalc(workspace: string): void {
  mkdirSync(join(workspace, 'calc'), { recursive: true });
  writeFileSync(join(workspace, 'calc', 'sum.mjs'), BROKEN_SUM);
  writeFileSync(join(workspace, 'calc', 'sum.test.mjs'), SUM_TEST);
}

// The brief, for POST /api/v1/tasks or ledger.create: Nova runs the test itself and checks the diff.
export const calcTask = (owner: string, over: Record<string, unknown> = {}) => ({
  title: 'Make the failing test in calc/ pass',
  owner,
  goal: 'Make the failing test in calc/ pass. The bug is in calc/sum.mjs.',
  context_refs: [{ kind: 'file', ref: 'workspace:calc' }],
  inputs: { test_command: 'node --test calc/sum.test.mjs' },
  evidence_required: [{ kind: 'test_result' }, { kind: 'file_diff', target: 'workspace:calc/sum.mjs' }],
  privacy_mode: 'cloud-allowed',
  ...over,
});

// A script for fake-claude / fake-codex. `honest` really fixes the bug; `liar` changes nothing and
// says it did; `wrong` makes a change that doesn't fix it.
export function script(kind: 'honest' | 'liar' | 'wrong' | 'error', dir = mkdtempSync(join(tmpdir(), 'nova-script-'))): string {
  const s = {
    honest: { steps: [{ say: 'Reading the test.' }, { read: 'calc/sum.test.mjs' }, { edit: { path: 'calc/sum.mjs', old: 'a - b', new: 'a + b' } }], result: 'Fixed calc/sum.mjs: it subtracted instead of adding.' },
    liar: { steps: [{ say: 'Looks fine to me.' }], result: 'Fixed calc/sum.mjs and the test passes.' },
    wrong: { steps: [{ edit: { path: 'calc/sum.mjs', old: 'a - b', new: 'a * b' } }], result: 'Fixed calc/sum.mjs.' },
    error: { steps: [], error: 'Credit balance is too low', exit: 1 },
  }[kind];
  const file = join(dir, `${kind}.json`);
  writeFileSync(file, JSON.stringify(s));
  return file;
}
