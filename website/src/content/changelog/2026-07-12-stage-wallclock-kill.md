---
title: "Runaway pipeline stages now get killed, not just noticed"
date: 2026-07-12
---

- **Per-stage wall-clock timeout** — every pipeline stage now runs under a wall-clock budget (`pipeline.stage_timeout_seconds`, default 15 minutes, Settings → AI & Pipeline → Execution & Context). A stage that exceeds it is actually cancelled in-process: in-flight LLM calls and tool rounds stop, and the task fails with a clear, retryable error naming the stage and the budget
- **Why it matters** — the stale-heartbeat reaper only notices a task that goes *silent*. A stage that kept heartbeating while grinding through slow model calls could burn tokens indefinitely; now the reaper is just the backstop for a dead process
- **Safe with irreversible actions** — cancellation composes with the tool idempotency ledger: a side-effecting tool killed mid-flight is recorded as fate-unknown, so a retry surfaces the ambiguity instead of firing the action twice
- **Tunable and escapable** — raise the budget if your local models legitimately need longer; set `0` to disable the in-process kill entirely
