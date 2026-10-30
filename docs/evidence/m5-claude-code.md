# M5 evidence — real Claude Code

Run 2026-10-30T10:14:35.306Z, 18 s. Provider `claude-code` → the real `claude` CLI (one small run, OK’d by the owner on their subscription), task privacy cloud-allowed. Not part of CI.

- **Brief:** Make the failing test in calc/ pass (`node --test calc/sum.test.mjs`, evidence: test_result + file_diff).
- **Asked before running Claude Code's code:** calc/sum.mjs — “This runs code the provider wrote, as you, with access to your files.”
- **Outcome:** done — You OK’d running `node --test calc/sum.test.mjs` on what Claude Code wrote. Nova ran `node --test calc/sum.test.mjs` itself: it passed.
- **test_result:** passed — Nova ran `node --test calc/sum.test.mjs` itself in the task’s folder: it passed (exit 0, 0.1 s).
- **file_diff:** passed — Nova compared calc/sum.mjs in the task’s folder with the copy it started from: 1 line added, 1 removed, as reported.
- **Receipts:** claude-code (egress remote:anthropic).
- **Events:** created → dispatched → test_run_asked → reported → partial → cloud_usage → test_run_approved → retried → dispatched → reported → verifying → verified → copied_back → cloud_usage.
