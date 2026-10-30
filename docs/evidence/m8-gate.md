# M8 gate evidence — Nova and the real Relay

Written by `tests/acceptance/m8-relay-real.test.ts` (opt-in: `NOVA_RELAY_DIR`, and `NOVA_RELAY_MODEL` for the model run). Not part of CI; the CI half is `tests/acceptance/m8-relay.test.ts` against the stand-in.

Worktree paths are in the test run’s own temporary folder, removed when the run ends. `costUsd` is what the engine reports: the claude CLI prices tokens from its own table by model name, so a local model shows a nominal cost although nothing is billed. Relay enforces no cost cap.

<!-- fake -->
## Relay’s fake worker (no model)

Run 2026-10-30T14:09:23.294Z, 1 s from brief to verified. Nova commit `4f21ddb4`; Relay 0.9.0 at `4add265` (/home/jeremy/workspace/nova-build/.claude/relay-build), on an ephemeral port with a fresh data folder. `RELAY_CLAUDE_BIN` is Relay’s `test/fixtures/fake-claude-worker.mjs` (its honest default: it fixes calc/sum.mjs); `ANTHROPIC_BASE_URL=http://127.0.0.1:9`, so Relay reports local.

- **Relay status:** api 1, workerEgress `local`, engines: claude (workers, 0.0.0 (Relay fake worker fixture)), codex (no workers).
- **Brief:** Make the failing test in calc/ pass, privacy local-only (`node --test calc/sum.test.mjs`, evidence: test_result + file_diff).
- **Asked before running the worker's code:** calc/sum.mjs — “This runs code the provider wrote, as you, with access to your files.”.
- **Outcome:** done — You OK’d running `node --test calc/sum.test.mjs` on what Relay wrote. Nova ran `node --test calc/sum.test.mjs` itself: it passed.
- **test_result:** passed — Nova ran `node --test calc/sum.test.mjs` itself in the task’s folder: it passed (exit 0, 0.1 s).
- **file_diff:** passed — Nova compared calc/sum.mjs in the task’s folder with the copy it started from: 1 line added, 1 removed, as reported.
- **Relay run:** `61700bc8-eabe-4b4d-95cc-6400ec8382bd`, status completed, branch `relay/61700bc8-eabe-4b4d-95cc-6400ec8382bd` (the worktree's HEAD: `relay/61700bc8-eabe-4b4d-95cc-6400ec8382bd`), worktree `/tmp/nova-test-fd2G2f/nova-m8-relay-7KOm6J/data/worktrees/61700bc8-eabe-4b4d-95cc-6400ec8382bd`, base `fa1cbc1c6b17`, files ["calc/sum.mjs"], usage {"inputTokens":352,"outputTokens":20}, costUsd 0. Relay's summary: “Fixed calc/sum.mjs: it subtracted instead of adding.”.
- **Workspace after:** calc/sum.mjs is the fix.
- **Receipts:** relay / Relay worker (egress local).
- **Events:** created → dispatched → test_run_asked → reported → partial → test_run_approved → retried → dispatched → reported → verifying → verified → copied_back.
- **Egress tripwire:** Nova: nothing tried to leave this machine. Relay's own process: nothing tried to leave this machine.

Relay's diff (provider-reported, kept in the `relay-run` artifact):

```diff
 calc/sum.mjs | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/calc/sum.mjs b/calc/sum.mjs
index 2abed46..bc5f04d 100644
--- a/calc/sum.mjs
+++ b/calc/sum.mjs
@@ -1 +1 @@
-export const sum = (a, b) => a - b;
+export const sum = (a, b) => a + b;
```

<!-- /fake -->

<!-- model -->
## The real claude CLI on a local model (qwen3-coder:30b)

Run 2026-10-30T14:02:46.378Z, 4 s from brief to verified. Nova commit `e917f08b`; Relay 0.9.0 at `4add265` (/home/jeremy/workspace/nova-build/.claude/relay-build), on an ephemeral port with a fresh data folder. `RELAY_CLAUDE_BIN` unset (Relay runs `claude`, 2.1.259 (Claude Code)), `ANTHROPIC_BASE_URL=http://127.0.0.1:11434` (Ollama 0.40.0), `ANTHROPIC_AUTH_TOKEN=ollama`, `ANTHROPIC_API_KEY` empty, `ANTHROPIC_MODEL=qwen3-coder:30b`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and a fresh empty `HOME`: no sign-in, no subscription.

- **Relay status:** api 1, workerEgress `local`, engines: claude (workers, 2.1.259 (Claude Code)), codex (no workers).
- **Brief:** Make the failing test in calc/ pass, privacy local-only (`node --test calc/sum.test.mjs`, evidence: test_result + file_diff).
- **Asked before running the worker's code:** calc/sum.mjs — “This runs code the provider wrote, as you, with access to your files.”.
- **Outcome:** done — You OK’d running `node --test calc/sum.test.mjs` on what Relay wrote. Nova ran `node --test calc/sum.test.mjs` itself: it passed.
- **test_result:** passed — Nova ran `node --test calc/sum.test.mjs` itself in the task’s folder: it passed (exit 0, 0.1 s).
- **file_diff:** passed — Nova compared calc/sum.mjs in the task’s folder with the copy it started from: 1 line added, 1 removed, as reported.
- **Relay run:** `da148bbb-ba8f-41c9-a69c-38ec0fb4313e`, status completed, branch `relay/da148bbb-ba8f-41c9-a69c-38ec0fb4313e` (the worktree's HEAD: `relay/da148bbb-ba8f-41c9-a69c-38ec0fb4313e`), worktree `/tmp/nova-test-82AMON/nova-m8-relay-PKzguJ/data/worktrees/da148bbb-ba8f-41c9-a69c-38ec0fb4313e`, base `8d19dd195bc6`, files ["calc/sum.mjs"], usage {"inputTokens":659,"outputTokens":355}, costUsd 0.017739. Relay's summary: “I've fixed the bug in `calc/sum.mjs`. The function was incorrectly implemented as subtraction (`a - b`) instead of addition (`a + b`). Now it correctly implements addition, which will make the test pass.

The change I made:
- Modified line 1 in `calc/sum.mjs` from `export const sum = (a, b) => a - b;` to `export const sum = (a, b) => a + b;`

This single-line fix ensures that `sum(2, 3)` now returns `5` as expected by the test, rather than `-1`.”.
- **Workspace after:** calc/sum.mjs is the fix.
- **Receipts:** relay / Relay worker (egress local).
- **Events:** created → dispatched → test_run_asked → reported → partial → test_run_approved → retried → dispatched → reported → verifying → verified → copied_back.
- **Egress tripwire:** Nova: nothing tried to leave this machine. Relay's own process: nothing tried to leave this machine.

Relay's diff (provider-reported, kept in the `relay-run` artifact):

```diff
 calc/sum.mjs | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/calc/sum.mjs b/calc/sum.mjs
index 2abed46..bc5f04d 100644
--- a/calc/sum.mjs
+++ b/calc/sum.mjs
@@ -1 +1 @@
-export const sum = (a, b) => a - b;
+export const sum = (a, b) => a + b;
```

<!-- /model -->
