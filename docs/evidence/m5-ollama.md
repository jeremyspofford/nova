# M5 evidence — a real local model

Run 2026-10-30T06:21:40.021Z, 1 s. Provider `openai-compatible` → Ollama at http://127.0.0.1:11434/v1, model `qwen3-coder:30b`, task privacy local-only. Not part of CI.

- **Brief:** Make the failing test in calc/ pass (`node --test calc/sum.test.mjs`, evidence: test_result + file_diff).
- **Asked before running the model's code:** calc/sum.mjs — “This runs code the provider wrote, as you, with access to your files.”.
- **Outcome:** done — You OK’d running `node --test calc/sum.test.mjs` on what Local model (Ollama or compatible) wrote. Nova ran `node --test calc/sum.test.mjs` itself: it passed.
- **test_result:** passed — Nova ran `node --test calc/sum.test.mjs` itself in the task’s folder: it passed (exit 0, 0.1 s).
- **file_diff:** passed — Nova compared calc/sum.mjs in the task’s folder with the copy it started from: 1 line added, 2 removed, as reported.
- **Receipts:** openai-compatible (egress local).
- **Events:** created → dispatched → test_run_asked → reported → partial → test_run_approved → retried → dispatched → reported → verifying → verified → copied_back.
- **Egress tripwire:** nothing tried to leave this machine.
