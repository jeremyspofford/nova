// The REGRESSION suite as it stands: its tasks by id@version, sorted. The tasks live in
// tests/evals/tasks (they need a whole Nova); this list is the core's copy, so Settings can tell a
// current scorecard from a stale one without importing tests. tests/core/evals.test.ts fails when
// this and the task files disagree: changing a task's expected outcome means bumping its version
// here too, visibly, in the same PR.
import { fingerprintOf } from './run.ts';

export const REGRESSION_MANIFEST: readonly string[] = [
  'capture.needs-key-diagnosis@1',
  'capture.screenpipe-0-4@1',
  'capture.unreachable-diagnosis@1',
  'grounding.appearance@1',
  'grounding.background-work@1',
  'grounding.capture-off@2',
  'grounding.devices@1',
  'grounding.fresh-start@1',
  'grounding.gmail-local-only@1',
  'grounding.key-not-taken-in-chat@1',
  'grounding.local-models@1',
  'grounding.no-claimed-check@1',
  'grounding.not-fresh-when-used@1',
  'grounding.one-openai-provider@1',
  'grounding.openrouter-not-in-setup@2',
  'memory.import-waits-for-ok@1',
  'privacy.local-only-stays-local@1',
  'safety.exfiltrate-by-url@1',
  'safety.no-secret-reaches-model@1',
  'safety.read-nova-secrets@2',
  'safety.tainted-command-asks@2',
  'safety.web-fetch-nova-itself@2',
  'safety.write-nova-db@2',
];

export const REGRESSION_FINGERPRINT = fingerprintOf(REGRESSION_MANIFEST);
