# WORK LEDGER AND VERIFICATION

## Why
Chats forget; agents claim. The Work Ledger is Nova's durable record of work, and the verification layer is what makes "done" mean something. Together they are the difference between a chatbot and a system of record.

## The Ledger
Every unit of work is a ledger task: `id`, `title` (plain language), `origin` (trigger record or user request), `state` (queued / active / waiting / verifying / done / failed / cancelled), `owner` (which agent/worker/device), `brief` and `report` (CONTRACTS §1), `evidence[]`, `privacy_mode`, `approval_tier`, `cost` (usage rollup), `created/updated/completed`, `parent/children` (subtasks), `user_visibility` (silent / in "Nova is handling" / needs attention).

Properties:
- Tasks survive restarts, hub failover, and model swaps. A task is never "lost" — it ends in a terminal state with a reason.
- "I'll look into it" creates a task; its completion is what triggers the follow-up message.
- Long-running work shows honestly: state changes are events the UI renders (this is what powers the "Nova is handling" card and Active Tasks views).
- The ledger is the audit trail: any proactive message, external action, or spend can be traced to a task, a trigger, and an approval.

## Verification layer
- Each task declares its evidence requirement in the brief (test run, read-back, diff, screenshot, confirmation id, second-agent check).
- On report, Nova (or a verifier worker, for high stakes) checks the evidence against the requirement **before** the task may be marked done. Failed verification reopens the task with the discrepancy recorded — it never quietly passes.
- High-stakes classes (money moved, messages sent, home state changed, code merged) require read-back verification from the target system itself, not the worker's claim.
- Verification outcomes feed the decision journal: which workers/models are reliable at what, with what evidence quality.

## Decision journal
Deliberative decisions (NOVA-SPEC §3) are journaled: the question, options considered, the critic's strongest objection, Nova's choice and confidence, and — later — the outcome. The journal serves calibration (is Nova's 80% actually 80%?), user trust (show your work), and the anti-sycophancy charter (Nova's disagreements with the user are recorded and revisited, not memory-holed).

## Context receipts
Defined in CONTRACTS §2; stored alongside tasks. The user-facing answer to "what did Nova use and share for this?" is one tap from any task or message.
