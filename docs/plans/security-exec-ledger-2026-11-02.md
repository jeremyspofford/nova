# Child environment isolation and ledger execution ownership

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** complete owner IMMEDIATE S1 and S2 before W1/W2 or remaining orchestration work.

**Architecture:** one positive policy for inherited command environment feeds both Era2 paths and provider CLI defaults. Existing ledger task/lane scheduling retains ownership of actual live promises after timeout while revoking expired attempt authority; unrelated lanes remain schedulable. No second durable queue or approval model.

**Tech Stack:** existing JavaScript/TypeScript, Node26, standard library, current test harnesses.

**Spec:** owner priority insertion2026-11-02 and docs/reviews/nova-whole-app-review-2026-11-02.md backend findings1–2; packet OPERATING-RULES; existing WorkLedger/verification and effects/retry authority. Full continuing queue owner-priority-queue-2026-11-02.md.

## Global Constraints

- No runtime dependencies. Outside-core imports use src/core/index.ts. Existing public signatures/callers remain compatible unless a demonstrated security correction requires a documented narrowing.
- Failing actual behavioral test first, then fix; preserve every failed/interrupted run and don't claim isolated tests as full green.
- Inherited secrets are rejected by construction: a positive finite safe-variable policy, not a list of current provider keys or a broad name-prefix allow rule. Do not add parent secret values to logs/tests.
- Ledger timeout/cancel/halt revokes old attempt's authority. Do not retain #running solely to prevent overlap if that would keep committing/notStarted privileges alive.
- Actual live uncooperative promises retain their id and lane capacity until settlement. No blind retry, late report completion, starvation of independent lanes, false idle/drain, or weakened external-effect/approval rules.
- Synthetic canaries/private disposable parent environments/fake agents/workers/owned loopback only. No real provider/account/keychain/owner data/cloud/spend/tool/image/model pulls or protected preview changes. Default no-Kubernetes tripwire stays armed.
- Work only in owned isolated codex/security-exec-ledger checkout. Never owner clone/old worktrees/#207/#208/Serve/shim4319. One source writer at a time; root records only.
- Reuse exact-head main048's already green CI as baseline identity; focused existing coverage accompanies RED/GREEN. No redundant full baseline run or dependency reinstall. Final normal complete CI remains required.

## Review Focus

- Unknown innocently named parent canaries and provider/vault/token/session variables must never enter spawned children; safe PATH/HOME/locale behavior remains functional (Task1).
- Shell startup/runtime injection variables must not reconstruct the filtered environment; inspect exec login-shell behavior with a private controlled fixture, not owner startup files (Task1).
- A timed-out promise resolving/rejecting late cannot overlap a retry, finish its newer attempt or retain commit authority (Task2).
- Shared lane capacity, max>1 same-id exclusion and unrelated-lane progress; cleanup wakes exactly once without spin/unhandled rejection (Task2).
- Cancellation, halt and bounded handover drain cannot call orphaned work safely finished or hand off while conflicting work remains live (Task2).

### Task 1: S1 curated inherited environment

**Files:** modify src/agent.js(agentEnv/runAgent), src/tools.js(runCommand), src/core/providers/cli.ts(childEnv/default path); shared typed helper if needed and narrow src/core/index.ts export; tests existing tests/skills.test.js, tests/tools.test.js, tests/core/providers.test.ts or one targeted subprocess-environment regression file.
**Interfaces:** preserve agentEnv(env=process.env), runCommand(command,{cwd,signal,timeoutMs}), runAgent(options), childEnv(extra={},env=process.env). Canonical inherited-policy function is shared and exported through Coreindex for outside-core consumers; trusted explicit childEnv extras remain distinct from inherited parent data after caller audit. No caller currently supplies extras; verify this rather than spreading process.env through them.
- [x] **RED:** actual disposable server/parent process with minimal public environment plus synthetic secret canaries prints selected known child fields through exec and fake agent; both existing paths must demonstrably leak before fix. Include dynamically named innocent variable, NOVA_SECRET variants, mesh/callback/provider/auth/session/key material and runtime injection variables; no actual host env dump. Assert safe PATH/HOME/locale and no leaked canaries. Cover provider CLI default too if canonical policy changes there.
- [x] **GREEN:** replace inheritance/blacklist with finite positive policy; keep needed standard public process metadata, no broad LC_/XDG_/NOVA_ prefixes that permit arbitrary future secret keys. Audit all actual server secret sources by code, not reading owner values. Assess -lc/startup behavior under private fixture; preserve usable command execution and document any required shell narrowing. No new provider-auth backdoor or automatic runtime env forwarding.
- [x] **VERIFY:** new actual subprocess tests + directly affected complete skills/tools/providers/guard suites as appropriate, typecheck/syntax/diff and module boundary. No real Claude/Codex/provider calls, no full suite repeat here.
- [x] **REPORT/COMMIT:** source/tests only, actual RED/GREEN/covering commands/results/limits, env allowlist rationale and compatibility costs, all owned commands ended/RELEASE. Root supplies independent task review before acceptance.

### Task 2: S2 actual worker lifetime owns scheduling capacity

**Files:** src/core/ledger.ts; tests/core/ledger.test.ts, ledger-not-started.test.ts and narrowly relevant handover/effect tests.
**Interfaces:** keep Ledger public methods/task schema/approval and existing effect-classification contract. Track unresolved actual worker promise separately from expired attempt authority, using existing inflight ownership or a bounded-by-live-work orphan map; no persistent second registry.
- [x] **RED:** real Ledger + controlled first worker that ignores abort and stays pending; timeout/requeue then pump must currently dispatch overlapping retry. Also assert same-lane sibling safety, same-id exclusion when lane.max>1, independent-lane progress, late resolve/reject not changing report/state, and expired committing/notStarted refusal.
- [x] **GREEN:** reserve id/lane capacity until true underlying settlement; wake/pump after settle; keep timeout state/retry caps/effects checks honest. Revoke expired worker authority immediately. No busy loop or unhandled late rejection. Preserve cancellation/halt semantics and make bounded drain/idle accurately account for live orphans; do not hang unrelated lanes or report unsafe quiescence/handover.
- [x] **VERIFY:** final full ledger + not-started suites and affected existing effects/handover/recovery coverage, typecheck/module boundary/diff. Each covering run must target actual final amended source; no broad rerun of already green unrelated tests.
- [x] **REPORT/COMMIT:** source/tests only + full actual evidence/remaining limits; all processes/writes ended/RELEASE. Independent task review; scoped fixes if findings.

### Task 3: integration, adversarial review and merge

Coordinator archives complete reports/rulings/evidence; plain-language same-PR LEDGER; fresh most-capable whole-branch security/adversarial review of concrete S1/S2 code and actual controlled probes for unanswered risks. One consolidated test-first fix wave/scoped review if needed. Exact-head ordinary full unit/UI/typecheck/token/theme/audit and required gate must pass. Merge --merge --match-head-commit only after gates, restart authorized preview script4318/mesh4320 and verify clean merged head/root/health/mesh. Report merge one line, immediately start W1 then W2. Preserve ownerB work and Jdraft, never call full J passed.
- [x] Evidence/reviews/LEDGER and claims accurate.
- [x] Final independent adversarial review accepted.
- [ ] Exact-head ordinary CI and required gate green.
- [ ] Matched merge + authorized preview restart/verification.
- [ ] Continue next queued W1 without asking routine permission.


CI correction: original run41557701721 at a248 failed; four canary/rollback fixture failures and leaked setup cleanup causally isolated. Browser shared-close correction introduced a pending-launch leak, fixed at3d713478 and independently re-reviewed with no open findings. Original remote UI causality remains unproven. Full history/reports in docs/evidence/security-exec-ledger-ci-correction-2026-11-03.md. Final ordinary exact-head CI/merge/preview remain required.

Second CI41565401864 completedUI157/157 but unit1631pass/1dedupfixturefail/14unchangedskips; reviewed test-only4216de43 observes real completion and explicitly protects busy batching. Full history docs/evidence/security-exec-ledger-trigger-correction-2026-11-03.md. Fresh ordinary exact-headCI stillrequired.

Third CI41569116009 completedUI157/157 and unit1632pass/1codinghashfailure/14unchangedskips. ControlledactualGit2.56maintenance+noNova control provesfixturelocklifetime atsameassertion; c82e6cfc testhelperonlyjoinsmaintenance, allhash/refusal assertionsunchanged, independentreview0findings. OriginalCIpathUNKNOWN. FreshordinaryfullUI/unitstillrequired; causalrecord docs/evidence/security-exec-ledger-coding-fixture-2026-11-03.md.
