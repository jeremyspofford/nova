# Subprocess environment and execution ownership evidence

Owner IMMEDIATE S1/S2, based on the whole-app review of main `048eea0ee043f43d01bc9a36bed601ce9805373b`. This record distinguishes completed task checks from the final PR gate. S1 source: `0714b489f0376c112e2d9db8bb6ff046fe04877b`. S2 source: `7055737e3d2571df279574847107c83b2acfc6e6`. Both independent task reviews are approved. The final independent adversarial review also approved source `7055737e`; ordinary exact-head CI, same-PR LEDGER and merge/preview completion remain pending. No merge or complete-CI claim is made by the task reports below.

## S1 full implementer report

# S1 implementation report — curated inherited environment

Status: implementation and focused verification complete; awaiting root's independent review. Source ownership release is recorded at the end after the commit identity is known.

Base: `048eea0ee043f43d01bc9a36bed601ce9805373b`.
Branch and owned checkout: `codex/security-exec-ledger`, `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`.
Scope: S1 only. No ledger/S2 changes. Source/test-only commit; controller docs remain untracked and unstaged.

## Change and exact inherited policy

`src/core/child-env.ts` defines the canonical typed `inheritedChildEnv(env = process.env)` helper. Outside-core callers import its narrow export from `src/core/index.ts`. `agentEnv(env = process.env)` delegates to it; `runCommand` passes its output explicitly; provider `childEnv(extra = {}, env = process.env)` applies trusted explicit extras after it. `runLines` still uses `childEnv()` by default. Public function signatures are unchanged.

Only these 20 exact names can be inherited, and only when their value is not undefined:

```
PATH HOME USER LOGNAME
TMPDIR TMP TEMP
LANG LANGUAGE LC_ALL LC_CTYPE LC_COLLATE LC_MESSAGES LC_MONETARY LC_NUMERIC LC_TIME TZ
TERM COLORTERM NO_COLOR
```

PATH retains command discovery; HOME retains the existing home/config location contract; USER/LOGNAME retain ordinary OS account metadata (not CLI session email); temporary-directory variables keep scratch placement; the named locales/timezone preserve text/date behavior; terminal/color fields preserve rendering conventions. There are no prefix rules. Unknown innocent names, unknown future LC_/XDG_/NOVA_ names, all provider API/auth/session credentials, SSH agent handles, runtime injection settings (NODE_OPTIONS, loader paths, Python paths, Git configuration), and shell startup selectors are omitted by construction. Only selected synthetic fields were printed by tests; no host env dump occurred.

`childEnv` callers audited with `rg -n 'childEnv\(' src tests`: Claude Code, Codex, and custom-cli each call `childEnv()` without extras; `runLines` defaults to `childEnv()` without extras. No production caller supplies extras. The explicit extras contract is preserved and regression-tested: an explicit synthetic API key and HOME override survive, whereas unknown parent data does not. No process.env spread was introduced through extras. Existing explicit runLines environments for test checks/coding/infra remain their separate caller-owned contracts.

## Secret-source audit (code only)

- `src/server.js:75-79`: provider secret fallback reads `process.env[NOVA_SECRET_<name>]`. `src/core/index.ts:365-377` first reads `provider/<name>` from the vault, then this fallback, registering returned values for redaction. Both the existing and future NOVA_SECRET names are outside the inherited policy.
- `src/core/index.ts:761-792`: stable-name control reads `NOVA_MESH_NAME_TOKEN` from the server environment. It is excluded, alongside all NOVA configuration fields. TLS certificate/private-key file paths originate in `src/config.js:77-78` and are not forwarded.
- `src/core/providers/registry.ts:376-392`: callback tokens are generated with randomBytes and only their hash is saved in the profile; n8n signing secrets resolve through the provider secret callback. These are not ambient public metadata; synthetic callback/signing/session/key cases exercise the inherited boundary even when their names differ.
- `src/connectors/gmail.js`: OAuth client credentials, refresh tokens and app passwords map into vault names; access tokens are in process memory. `src/core/connectors/home-assistant.ts` reads/stores its long-lived token through the connector vault API. No secret values were read.
- `src/core/vault.ts`: encrypted secret map in home/vault/secrets.json; the key is obtained from a file or platform keychain. `NOVA_VAULT_KEY` selects a mode (it is not the encryption key); it is still excluded. DBUS/keychain session env is not inherited into agent/tool/provider children. Existing vault platform-helper processes themselves are outside this S1 change.
- `src/core/mesh/identity.ts`: private signing/sealing keys are generated or loaded from home/mesh/identity.json; `devices.ts` creates random device-session tokens and stores their hashes. No actual key files, owner profiles, sessions or keychain were accessed. Synthetic PRIVATE_KEY/SESSION_COOKIE canaries do not imply those are actual server env names.

The resulting policy does not depend on enumerating today's secrets. File-backed secrets and same-user filesystem authority remain outside an environment filtering guarantee.

## Shell startup assessment and compatibility

Before changing production code, the test used actual `/usr/bin/zsh -lc` with HOME and ZDOTDIR pointing solely at its disposable fixture. Private .zshenv/.zprofile files exported STARTUP_SECRET. The exec child received it, proving startup files can reintroduce private data after an env filter. No owner profile was read. The committed regression uses a portable executable fixture shell that always sources its private startup file, representing zsh's .zshenv behavior without adding a zsh CI dependency.

Exec now uses fixed `/bin/sh -c`, matching the existing agent shell convention, and a filtered env. Merely removing `-l` while honoring SHELL would still allow zsh's non-login .zshenv, so honoring arbitrary SHELL would leave this boundary open. Compatibility intentionally narrows: no login profile aliases/functions, shell-specific syntax, startup-derived PATH, or ambient provider API keys/proxy/custom certificate/runtime variables are automatically supplied. Standard shell syntax, pipelines, cwd, exit status, timeout/cancel plumbing, PATH, HOME and named locale values remain usable. Callers must use POSIX syntax or explicitly choose an interpreter in an approved command. This is not a filesystem sandbox; an explicitly approved command or trusted configured agent command can still deliberately load files or start another shell. No auth forwarding mechanism was added; existing HOME-based CLI configuration remains possible under its existing contract, without being exercised against a real account.

## TDD and verification commands / actual results

Every command ran with explicit workdir set to the owned checkout. Node selection for all test/typecheck commands:

```
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH
```

All test runs used `sh scripts/test.sh ...` with the default tripwire armed. No tripwire waiver or baseline edits. Each log ends `no-Kubernetes tripwire: never fired`.

1. Initial RED, actual zsh fixture, before production edits: `sh scripts/test.sh tests/subprocess-environment.test.js > /tmp/nova-s1-red.log 2>&1`, followed by `cat` in the same shell invocation. Actual runner output: tests 5, pass 0, fail 5, cancelled 0, skipped 0, todo 0; 1411.888875 ms. The trailing cat made the wrapper exit 0; this was recognized and not treated as passing. Full initial output remains in the tool transcript; the log path was reused by the next RED. The five failed names were exec, agent, provider-default, provider-childEnv (each `subprocess inherits public metadata and no private parent canaries`), and `provider explicit extras remain trusted, separate from inherited parent data`. Exec exposed every selected private canary plus STARTUP_SECRET; agent exposed unknown/provider/runtime canaries; both provider variants exposed unknown/non-NOVA/provider/runtime canaries; the extras test retained UNKNOWN_SETTING.
2. RED rerun without trailing cat, still before production edits, same command: exit 1; tests 5, pass 0, fail 5, cancelled/skipped/todo 0. Exact full output saved as `task-1-red.log`. Exec again included STARTUP_SECRET from the real zsh fixture. This confirmed the runner failure exit directly.
3. Portable-fixture RED, still before production edits: `sh scripts/test.sh tests/subprocess-environment.test.js > /tmp/nova-s1-red-portable.log 2>&1`, exit 1; tests 5, pass 0, fail 5, cancelled/skipped/todo 0. Exact output `task-1-red-portable.log`. Same five behavioral failures, including exec startup secret.
4. Initial GREEN after the fix: same focused test command, output redirected to `/tmp/nova-s1-green.log`, exit 0; tests/pass 5, fail/cancelled/skipped/todo 0. Full output `task-1-green.log`.
5. Complete affected suites: `sh scripts/test.sh tests/subprocess-environment.test.js tests/skills.test.js tests/tools.test.js tests/core/providers.test.ts tests/core/provider-guard.test.ts tests/core/api.test.ts > /tmp/nova-s1-affected.log 2>&1`, exit 0. Actual output: tests 65, pass 65, fail 0, cancelled 0, skipped 0, todo 0, duration 4017.629174 ms. Includes the actual module-boundary test and all tool execution/timeout, fake provider protocols and provider guard tests. Full output `task-1-affected.log`.
6. Fake integration coverage: `sh scripts/test.sh tests/helpers.test.js tests/skills-api.test.js tests/core/provider-vault.test.ts tests/core/restart-work.test.ts > /tmp/nova-s1-integration.log 2>&1`, exit 0. Actual output: tests 24, pass 24, fail 0, cancelled 0, skipped 0, todo 0, duration 7475.651466 ms. Exercises fake agents through HTTP, helpers, fake Gmail/search, synthetic provider-vault routing/redaction and child stop behavior. Full output `task-1-integration.log`.
7. `npm run typecheck > /tmp/nova-s1-typecheck.log 2>&1`, exit 0. Actual output: `npm notice run nova@0.1.0 typecheck` / `npm notice run tsc -p tsconfig.json`.
8. Syntax diagnostic attempt: `node --check src/core/child-env.ts` failed exit 1 with `SyntaxError: Unexpected identifier 'as'` at the erasable `] as const;` annotation on Node 26.3.1. An initial multi-command invocation finished exit 0 because a later JS check passed; its visible syntax error was recognized. Standalone reruns with `node --check src/core/child-env.ts` and `node --experimental-strip-types --check src/core/child-env.ts` each exited 1 (logs `task-1-syntax-attempt.log` and `task-1-syntax-strip-attempt.log`). Actual TS imports and tsc already passed. Removed the unnecessary type-only const assertion; runtime policy is unchanged.
9. Final verification used `set -e`, then `node --check` individually for src/agent.js, src/tools.js, src/core/child-env.ts, src/core/providers/cli.ts and tests/subprocess-environment.test.js, then `npm run typecheck > /tmp/nova-s1-typecheck-final.log 2>&1`, then `sh scripts/test.sh tests/subprocess-environment.test.js > /tmp/nova-s1-green-final.log 2>&1`, then `git diff --check`. Entire invocation exit 0. Checks/diff produced no output; tsc output matches (7); focused test output: tests/pass 5, fail/cancelled/skipped/todo 0, duration 1414.134388 ms. Logs copied here as task-1-typecheck-final.log and task-1-green-final.log.

No test was skipped/cancelled and no test emitted a runtime warning. npm's two notice lines are recorded above. All RED and diagnostic failures are accounted for; there were no interrupted test runs. Broader successful suites preceded only the removal of an erasable const assertion; final focused tests/typecheck/syntax/diff followed it.

## Limits and handoff

No full suite or browser run was performed, per the explicit task constraints. Root owns independent S1 review, final adversarial/full CI and later integration. No dependency installation, real model/provider/CLI auth/keychain/cloud call, owner data access, protected preview, service change, push/PR/merge/rebase/amend occurred. The inherited cwd was inspected read-only before selecting the correct checkout; all edits were in the owned checkout. No other checkout was modified. No subagents were spawned.

Remaining security scope: environment filtering does not prevent an authorized same-user process from deliberately reading accessible files or credential stores, or a trusted explicit env/command from intentionally supplying a credential. Other internal subprocesses (e.g. vault platform helpers and relay's internal Git commands) retain their existing contracts and were not rewritten. No SDK/provider architecture work or S2 ledger behavior was included.

## Source identity and RELEASE

Source/test-only commit: `0714b489f0376c112e2d9db8bb6ff046fe04877b` (`fix(security): curate inherited subprocess environments`). Exactly six source/test files committed; the three controller docs remain the only untracked paths. No push/PR/merge performed.

All owned exec sessions have exited (affected tests, typecheck, supplemental integration, final verification). No further owned command, test, write or process remains active. This report append is the final owned write. **RELEASE: source ownership returned to root for independent S1 review and subsequent work.**


## S1 full independent task review

### Spec Compliance

- Spec compliant. **specPass: true.** Reviewed packaged base `048eea0ee043f43d01bc9a36bed601ce9805373b` → head `0714b489f0376c112e2d9db8bb6ff046fe04877b`, S1 only. Binding intent checked against `docs/reviews/nova-whole-app-review-2026-11-02.md`, section 1 correctness/security finding 1, the controller's verbatim latest owner S1, and `task-1-brief.md`/`constraints.md` in this directory.
- `src/core/child-env.ts:4-18` implements one finite positive inherited policy with exactly the reported 20 names and no prefix allowance or parent spread. Its undefined-value handling preserves the declared string-valued environment contract. Arbitrarily named future secrets are excluded without enumerating credentials.
- `src/agent.js:16-17,29`, `src/tools.js:597`, and `src/core/providers/cli.ts:44-45,56` connect Era 2 agent, Era 2 exec, explicit provider filtering, and provider default launch to that policy. `src/core/index.ts:158` exposes the helper through the required outside-core boundary. Public signatures remain intact.
- `src/tools.js:595-597` deliberately narrows exec to `/bin/sh -c`. The private startup fixture at `tests/subprocess-environment.test.js:30-40,48` exercises a shell that sources startup data even for non-login execution. This closes the demonstrated shell-selection/startup bypass while retaining the existing agent/provider POSIX-shell convention (`src/agent.js:29`; `src/core/providers/cli.ts:55`). The report explicitly documents shell syntax, startup-derived PATH, ambient authentication/proxy/certificate/runtime and session compatibility costs.
- `tests/subprocess-environment.test.js:15-66` launches actual disposable parents with an explicit minimal environment and actual fake children. It checks preserved public metadata and omission of selected synthetic unknown/provider/mesh/vault/session/runtime/startup canaries on all four paths. `tests/subprocess-environment.test.js:70-74` independently protects the trusted explicit extras contract.
- Caller audit found no production `childEnv` extras: `src/core/providers/claude-code.ts:52`, `codex.ts:41`, `custom-cli.ts:47`, and `cli.ts:56` all call `childEnv()` without arguments. Separate explicit `runLines` environments in checks/coding/infra remain existing caller contracts; the diff introduces no automatic auth forwarding.
- Code-only secret-source check supports the policy rationale: provider vault/environment fallback (`src/server.js:79`; `src/core/index.ts:365-377`), mesh control token (`src/core/index.ts:761-792`), TLS key paths (`src/config.js:77-78`), callback generation/hash (`src/core/providers/registry.ts:376-392`), Gmail vault names (`src/connectors/gmail.js:42-45`), Home Assistant vault access (`src/core/connectors/home-assistant.ts:118`), vault key storage/mode (`src/core/vault.ts:5-8,189-193`), mesh private identity (`src/core/mesh/identity.ts:2-3,77-80`), and device session generation/hash (`src/core/mesh/devices.ts:254-273`). None requires an inherited name beyond the finite public contract. No actual environment values, keychain, profiles or secret files were inspected.

### Strengths

- `src/core/child-env.ts:4-18` makes the security rule small and auditable; all callers reuse it instead of maintaining divergent credential blacklists.
- `tests/subprocess-environment.test.js:19-29,41-64` verifies behavior across real process boundaries, including a randomized innocently named key, valid runtime options installed after parent startup, finite public-field assertions, and selected-field-only output. The temporary home is removed in `finally` at line 66.
- Archived RED evidence (`task-1-red.log:2-14`, `task-1-red-portable.log:2-14`) records all five expected failures, including exec STARTUP_SECRET at line 20; final focused evidence (`task-1-green-final.log:2-15`) records five passes with zero failures/cancellations/skips/todos and the tripwire never firing.
- Covering evidence is substantive: `task-1-affected.log:2-75` records 65 passes including module boundary, exec approval/cwd/exit/timeout, fake provider protocols and guard behavior; `task-1-integration.log:2-34` records 24 passes including HTTP fake agents, vault routing/redaction and stop behavior. Both have zero failures/cancellations/skips/todos and tripwire never fired. No runtime warnings appear; typecheck evidence contains only the two disclosed npm notice lines (`task-1-typecheck-final.log:1-2`).
- `task-1-report.md` preserves the failed syntax diagnostics and explains the final erasable-annotation-only adjustment rather than presenting those attempts as passing. It distinguishes focused verification from later complete CI and documents same-user filesystem/explicit trusted-command limits.

### Issues

#### Critical (Must Fix)

- None. Count: **0**.

#### Important (Should Fix)

- None. Count: **0**.

#### Minor (Nice to Have)

- None. Count: **0**.

### Verification Scope and Cannot-Verify Items

- Read the complete supplied diff once and checked every changed file against S1. The diff truncates the agent and provider launch functions before their spawn options; focused reads of `src/agent.js:20-100` and `src/core/providers/cli.ts:49-92` were necessary to verify actual env plumbing. No broader changed-file reread or git command was used.
- Named cross-file risk: preserving a trusted extras hook could bypass filtering if a production caller supplied parent data. Checked `childEnv(` in `src`/`tests` and `runLines(` in `src/core`; the findings above close that risk for actual current callers.
- Named cross-file risk: a permitted public name might actually contain a server secret, or a credential source could be missed by a blacklist-style audit. Checked the report's concrete server/config/provider/vault/connector/mesh code sources listed above. This is an environment-inheritance guarantee, not a guarantee against deliberate reads of files or credential stores through retained HOME/same-user authority.
- Named compatibility risk: fixed shell and smaller env could break supported launch paths. Checked actual agent/provider spawn conventions, caller contracts and existing covering test output. POSIX launch compatibility and the deliberate narrowing are supported; **real authenticated Claude/Codex/custom CLI behavior and every supported OS/shell installation cannot be independently verified here**, because real provider/account/keychain/profile access is expressly forbidden and only fake executable coverage was authorized. Retained HOME does not itself prove every authentication backend works; the report does not claim it does.
- **The overwritten first transient RED log and the original real-zsh fixture source/command cannot be reconstructed from the final diff.** The report discloses this and points to the implementation transcript. The archived rerun and portable-fixture RED independently establish all five actual behavioral failures, including startup leakage; this limitation does not invalidate the S1 TDD evidence. Controller can cross-check the initial transcript if retaining that first attempt's full output is required.
- **Final syntax/diff-check command exit status, source-only commit identity, and complete initial transient transcript cannot be independently authenticated from the diff/log bodies alone.** The report explicitly gives the final `set -e` command sequence and exit 0; final typecheck/focused logs are present. Controller holds source identity and the original command transcript. I did not rerun green checks or git commands to regenerate them.
- **Complete final CI/adversarial integration is not verified by this task review**, because it is a later controller gate and the task explicitly forbids a redundant full suite here. The 65+24 covering runs preceded only removal of an erasable const assertion; final focused/typecheck evidence followed it.
- No additional test/probe was warranted by a concrete unanswered code risk. Ran only bounded read commands and this authorized ignored report write. Two attempted documentation reads named nonexistent `docs/PROVIDERS.md` / `docs/OPERATING-RULES.md`; their read commands exited 2, changed nothing, and were not treated as validation. All commands exited. No source/index/HEAD/PR mutation, external provider execution, owner-data access or subagent dispatch occurred.

### Assessment

- **Task quality: Approved. qualityApproved: true.**
- Reasoning: S1 fixes the inherited-secret boundary by construction across all intended launch paths and addresses startup reconstruction with a documented, justified shell narrowing. Actual subprocess regressions and the preserved targeted covering evidence support the behavior without adding dependencies or an ambient credential exception.
- **RELEASE:** all reviewer commands and writes have ended; no process or source ownership is retained. This report is the only reviewer write.


## Retained S1 evidence digests

These logs are retained in the plan workspace until integration archives them; SHA-256 identifies the exact observed output. The full reports distinguish early diagnostics, pre-final erasable-only adjustment coverage and final focused checks.

| File | Bytes | SHA-256 |
|---|---:|---|
| `task-1-affected.log` | 6653 | `c649d063e8a04bab6b500e0ca001fe5928f51135e66844192e08443143ac8464` |
| `task-1-green-final.log` | 753 | `e75572d5ddf20d423ea1afa9836c0a71a9171316c3857c70e32106ad1c1a17b4` |
| `task-1-green.log` | 753 | `caa22e1b13e70ac11a427682f7fa08742e261cc50954b454e8287f51236e2df3` |
| `task-1-integration.log` | 2633 | `194569a0e89784a1b4fcbfeb6213a11434d959b69a0b803a537caf92c90a89e3` |
| `task-1-red-portable.log` | 11031 | `f441cd921e2ebd0fea9e76e68a221dfc8df8dffa4d99835b4c739a174e0a489c` |
| `task-1-red.log` | 11031 | `08f9922888def8522073423c7331d3155245b3cec6d27caa4b381f1fda0d51f5` |
| `task-1-syntax-attempt.log` | 280 | `c01d656dd566300f308c33685a6e7ed62d2a41ad5db651fab39a1aa7e861ae94` |
| `task-1-syntax-strip-attempt.log` | 280 | `c01d656dd566300f308c33685a6e7ed62d2a41ad5db651fab39a1aa7e861ae94` |
| `task-1-typecheck-final.log` | 72 | `e8180baa00ad9e924316d504d52e1481d7865b7c7920b00f90f09701440c5da0` |
| `task-1-typecheck.log` | 72 | `e8180baa00ad9e924316d504d52e1481d7865b7c7920b00f90f09701440c5da0` |


## S2 full implementer report

# Task 2 — S2 actual worker lifetime owns capacity

Status: implemented, verified, committed; independent review remains with controller.

Worktree: `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`
Branch: `codex/security-exec-ledger`
Accepted S1/base: `0714b489f0376c112e2d9db8bb6ff046fe04877b`
S2 source commit: `7055737e3d2571df279574847107c83b2acfc6e6`

Only source/test paths committed:
- `src/core/ledger.ts`
- `src/core/mesh/handover.ts`
- `tests/core/ledger.test.ts`
- `tests/core/effects.test.ts`
- `tests/core/mesh-promotion.test.ts`

S1 source was neither changed nor redundantly validated. Controller docs were not staged, changed, or committed. The controller's additional untracked evidence file was also left untouched. No push, PR, merge, amend, rebase, or history rewrite.

## Root cause and implementation

`#inflight` formerly tracked the timeout race rather than physical worker lifetime. `#runOne` finished at timeout and its scheduler cleanup freed both id and lane, while the worker could still run. `drain` checked `#running`, which represented attempt authority and likewise disappeared early.

The existing `#inflight` record now remains until the real worker promise settles. The private run routine handles timeout/error/state promptly but awaits physical settlement in `finally`, observing late rejection without accepting a late report. It uses the existing scheduler's per-id exclusion and lane accounting; no second registry, persistence layer, public schema, dependency, or task API was added. Physical occupancy is bounded by actual outstanding work.

An abort listener revokes the matching `#running` authority synchronously, before notifying worker listeners. Timeout/cancel/halt therefore refuse `committing` and `notStarted` immediately. Normal completion removes the listener, preventing an old deadline from revoking later work. A resolved report is also rejected if its signal expired before the continuation resumed.

Actual settlement deletes the inflight record and wakes the pump. Retained ids block retry even in lanes with max > 1; other lanes continue. `retry` also refuses manual overlap while an expired external worker remains alive. Existing running/needs-person error wording stays compatible.

`halt` returns physically inflight ids. `idle` stays pending while physical work remains. `drain` waits on inflight records, gives noncommitted aborted workers a bounded settlement grace, and returns still-live work as `stuck`. It cannot report an unresolved worker as finished or handed. Existing committed-worker no-cut behavior remains.

`recover` skips physically live active and needs-person work. `resume` after interruption recovers already-settled work; an interrupted worker that settles after resume triggers recovery at inflight cleanup. This avoids stranding cooperative tasks after a refused drain and applies the existing attempt cap, not-started giveback, effects, approval, and commit reconciliation rules. Calling resume during ordinary startup still leaves initial recovery to its existing explicit caller.

The controller explicitly authorized the narrow handover caller wording correction: `stuck` now includes uncooperative timeout/cancellation work, so promotion no longer falsely claims every such task passed a commit point. The existing refusal/resume control path is preserved.

Callers inspected: core stopWork/startHub/close, mesh planned promotion/resume/rollback, browser needs-person/recovery, existing ledger/not-started/effects tests, restart-work, mesh promotion and acceptance recovery scenarios.

## Behavioral evidence

Before any production fix, real Ledger tests with controlled abort-ignoring promises failed:
- Four combinations (lane max 1/2 × late resolve/reject) observed 2 dispatches instead of 1 while the first worker remained pending.
- Drain returned no stuck work despite the live timed-out promise.

After the fix these cover same-id exclusion, same-lane capacity, independent-lane progress, truthful idle, immediate authority revocation, late result/rejection suppression, automatic wake/retry after settlement, and refused-drain cooperative recovery.

Additional regressions cover final-attempt timeout retaining capacity, cancellation retaining capacity, halt/resume recovering only after settlement, and real promotion across disposable loopback cores refusing the live orphan while keeping the original hub usable. Existing unsafe never-settling timeout/cancel tests were replaced with controlled deferred settlement while preserving deadline/cancel assertions. The effects timeout fixture is similarly explicitly settled before a manual second attempt, and now asserts manual retry refusal while live.

The promotion caller regression first failed against its old commit-only refusal claim, then passed after the wording correction. It also proves no role/name transfer, no overlapping retry, and resumed operation after settlement.

## Exact validation commands and logs

All commands ran in the worktree above. Every Node test command used this exact prefix:

`PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH`

All test options preceded file paths. Every test went through `sh scripts/test.sh`, with the no-Kubernetes tripwire armed and never fired. Each command's stdout and stderr were redirected to the corresponding retained log, then printed and its actual exit code returned.

Log directory: `.superpowers/sdd/security-exec-ledger-2026-11-02/s2-logs/`

1. `sh scripts/test.sh --test-timeout=15000 --test-name-pattern='timeout retains|drain refuses' tests/core/ledger.test.ts`
   - `01-red.log`: exit 1, 0 pass / 5 fail. Actual behavioral RED on unchanged production source.
2. Same command after initial production fix.
   - `02-green-focused.log`: exit 0, 5/5 pass.
3. `sh scripts/test.sh --test-timeout=20000 tests/core/ledger.test.ts tests/core/ledger-not-started.test.ts`
   - `03-ledger-complete.log`: exit 0, 38/38 pass. Intermediate complete Ledger coverage, not represented as final source coverage.
4. `sh scripts/test.sh --test-timeout=40000 --test-name-pattern='planned promotion refuses' tests/core/mesh-promotion.test.ts`
   - `04-handover-wording-red.log`: exit 1, 1 failure. Real promotion safely refused but falsely reported work past its commit point.
5. Same promotion command after caller wording fix.
   - `05-handover-wording-green.log`: exit 0, 1/1 pass.
6. `sh scripts/test.sh --test-timeout=60000 tests/core/ledger.test.ts tests/core/ledger-not-started.test.ts tests/core/effects.test.ts tests/core/mesh-promotion.test.ts tests/core/restart-work.test.ts tests/core/browser.test.ts tests/acceptance/restart-waiting.test.ts`
   - `06-final-affected.log`: exit 0, 77/77 pass, no skips/cancellations. Full final-source Ledger + not-started + effects + mesh promotion + restart-work + browser suites and hard-restart waiting scenario.
7. `npm run typecheck`
   - `07-typecheck.log`: exit 1. New promotion test fake lacked required Worker.health; this was a test fixture typing error. Added `health: () => ({ ok: true })`; no production changes.
8. `sh scripts/test.sh --test-timeout=30000 --test-name-pattern='module boundary' tests/core/api.test.ts`
   - `08-boundary.log`: exit 0, 1/1 pass.
9. `sh scripts/test.sh --test-timeout=120000 --test-name-pattern='R5|R7|R9|restart|stale' tests/acceptance/m10g-review.test.ts`
   - `09-handover-recovery.log`: exit 0, 4/4 pass, no skips/cancellations. Old-hub restart during transfer; candidate death and refusal release; candidate taking role then erroring; stale record/restart. All selected scenarios completed (80.36 s total).
10. `npm run typecheck`
    - `10-typecheck-final.log`: exit 0, final fixture/source.
11. `sh scripts/test.sh --test-timeout=60000 tests/core/mesh-promotion.test.ts`
    - `11-promotion-final.log`: exit 0, 11/11 pass, full suite after final health fixture addition. Supersedes promotion membership of run 06; production source unchanged since run 06.
12. `git diff --check`
    - `12-diff-check.log`: exit 0, no whitespace errors. Rechecked immediately before commit.

No failed/interrupted test was hidden; there were no interrupted runs. Read-only inspection glob/path diagnostics were retained in `00-inspection-diagnostics.log` and the full tool transcript. `13-final.patch` retains the full final diff; `14-final-source-sha256.log` pins exact validated content. `15-commit.log` records the source-only commit. This task deliberately did not run a blanket suite, reinstall dependencies, or repeat S1's already accepted validation. Final normal complete CI remains a controller/integration requirement; this report does not claim that CI passed.

Source/test SHA-256 hashes (also rechecked after commit):

```
bcb3c0f2a92d0476015a4119055e9a376e351fd171a861cf3af0052c222d023d  src/core/ledger.ts
2fe5e780a5f942e0d7896fd55a644d28c5318da7682263f86b8023d5ad2b01b0  src/core/mesh/handover.ts
a749833817c20c219166de46f60083337a94714f095f43ed2da128b07ccda6c9  tests/core/ledger.test.ts
87d7fb2080297553b5dd5a6eaba49afe6a028b511dca7340dfd1e7ca5d1be57d  tests/core/effects.test.ts
2a510ada1e707d640a1c3933d84c81cf8221f9c5c3f2f644e4c4f4bb28827ae8  tests/core/mesh-promotion.test.ts
```

Commit commands were explicit `git add` of the five listed paths and `git commit -m "fix(ledger): retain worker capacity until physical settlement"`. Postcommit `git diff --exit-code`, `git diff --cached --exit-code`, and `sha256sum -c .../14-final-source-sha256.log` all exited 0. Tracked worktree/index are clean; only controller-owned untracked docs remain.

## Liveness costs and limits

- A worker that truly never settles permanently reserves its id and one slot in its lane for that Ledger instance. Its same-lane siblings can use only remaining capacity. Independent lanes remain available.
- `idle()` intentionally stays unresolved for such physical work. It has no timeout parameter; bounded callers continue to use their existing race. It no longer gives a false quiescence result.
- Handover is refused while that physical work survives. Drain is bounded by `boundMs` plus up to one `commitMs` wait for committed work and one `commitMs` post-abort settlement grace, subject to normal scheduling delay. Thus worst-case configured drain duration increases to `boundMs + 2*commitMs` (the production defaults can be 11 minutes). No busy polling: the bounded wait sleeps up to 50 ms per check; the pump waits for wake/settlement.
- JavaScript cannot force an arbitrary uncooperative promise to stop. Authority revocation prevents Ledger commit/not-started claims, but cannot undo effects a misbehaving worker performs outside the Ledger. This fix prevents overlapping redispatch/handover instead of pretending abort killed the work.
- Existing process-stop and bounded restart mechanisms were preserved and tested with disposable commands. No new cross-process durable worker registry or kill mechanism was added.
- No public signatures/schema/effect classification/approval rules were weakened. No runtime dependency added.

## Safety and release

Only fake workers, disposable private test homes, synthetic fixture identities, fake agents, and loopback stand-ins were used. No real provider, keys/accounts, cloud/spend, image/model pulls, devices, or Kubernetes calls. No owner clone, other worktree, protected preview/Serve/shim, #207/#208, or external publishing action was touched. No subagents were spawned.

All launched test and typecheck sessions have completed, and all shell commands/writes end with this report delivery. Sole production-writer ownership is explicitly **RELEASED** to the controller. No background writer or running validation remains. Independent task review is pending.


## Exact retained output

The complete available test and diagnostic log bodies are archived in [the output record](security-exec-ledger-test-output-2026-11-02.md), including RED and failed typing/syntax attempts. No passing suite was regenerated for this archive.


## S2 full independent task review

# Task 2 review — spec and quality

Spec compliance: PASS. `specPass: true`.
Task quality: APPROVED. `qualityApproved: true`.
Severity counts: Critical 0; Important 0; Minor 0.

Scope: Task 2 only, base `0714b489f0376c112e2d9db8bb6ff046fe04877b` to head `7055737e3d2571df279574847107c83b2acfc6e6`. This is not the final whole-branch or merge review. Final normal CI and the controller's final adversarial review remain outstanding.

## Spec compliance and strengths

- The existing physical-work registry now owns occupancy: `src/core/ledger.ts:403` excludes an inflight id, the adjacent lane check counts inflight records, and `src/core/ledger.ts:547` creates the separately observed worker promise. The `#runOne` finalizer waits for that promise before pump cleanup deletes its record. No persistent registry, task schema, dependency, or public method signature was added.
- Authority and occupancy are separate. The abort handler at `src/core/ledger.ts:539` removes only its matching controller immediately; the guarded continuation at `src/core/ledger.ts:552` refuses a report whose signal expired before processing. Existing `committing` and `notStarted` checks (`src/core/ledger.ts:313`, `src/core/ledger.ts:287`) therefore reject expired attempts while the physical record remains live.
- Manual retries also refuse physical overlap (`src/core/ledger.ts:253`). Retry/effect/approval decisions still use the existing `#retryOrFail`, `#mayRerun`, and `#requeue` paths (`src/core/ledger.ts:615` onward); no blind external-effect retry was introduced.
- Settlement cleanup explicitly wakes the pump (`src/core/ledger.ts:411` onward). Blocked ids are skipped rather than dispatched or repeatedly made dirty; the existing wait races actual completion and explicit wakeups. Independent lanes remain schedulable.
- Halt and drain count physical work (`src/core/ledger.ts:445`, `src/core/ledger.ts:460` onward), so a timeout cannot falsely make a live worker finished or handed. The drain refuses handover if physical work survives the grace period. Promotion preserves that refusal and now explains it accurately (`src/core/mesh/handover.ts:630`).
- Interrupted recovery is coherent: recover skips physically live active/needs-person work (`src/core/ledger.ts:341`, `src/core/ledger.ts:361`); resume recovers settled interruptions (`src/core/ledger.ts:491` onward); completion cleanup recovers an interruption that settles after resume (`src/core/ledger.ts:414`). The existing attempt cap, not-started giveback, external-effect hold, and approval paths remain in use.
- Tests use real Ledger instances and controlled promises, not assertions against scheduler mocks. The max-1/max-2 and late-resolve/late-reject matrix checks id exclusion, lane occupancy, independent progress, refused expired claims, report suppression, truthful idle, and wakeup (`tests/core/ledger.test.ts:451` onward). Terminal timeout and cancellation tests preserve deadline/state assertions while requiring physical settlement (`tests/core/ledger.test.ts:224`, `tests/core/ledger.test.ts:244`). Refused-drain and halt/resume tests cover settled and still-live interruptions (`tests/core/ledger.test.ts:511`, `tests/core/ledger.test.ts:556`).
- External-effect retry refusal is tested before the fake pending worker settles (`tests/core/effects.test.ts:75`); the real disposable-core promotion regression proves refusal, unchanged roles/name, continued usability, and retry only after settlement (`tests/core/mesh-promotion.test.ts:458`).
- The brief names the unchanged not-started suite as relevant validation, not a mandatory source edit. Its actual final-source run is preserved in `s2-logs/06-final-affected.log:29` through `:32`; new expired-not-started assertions live with the timeout/cancel/halt tests. No missing file change was inferred merely from leaving that suite unchanged.

## Drain bound and caller contract

The documented worst case is accurate: initial `boundMs`, one `commitMs` for committed workers, then one `commitMs` for physical settlement after abort. The second interval is reachable if committed work finishes near the first interval's end while another worker remains. Defaults at `src/core/mesh/handover.ts:629` give 60 seconds + 300 seconds + 300 seconds = 11 minutes, plus ordinary scheduling delay.

This is a deliberate liveness cost, not a hidden unbounded wait. The original method signature promises no smaller total deadline; the new method comment documents the additional grace. `Promotions.start_` starts `#planned` in its own tracked promise and returns its view (`src/core/mesh/handover.ts:609`), so the longer drain is not running inside an awaited HTTP-response deadline. It remains before writes are held or the role/name moves. A refusal calls `#resume` (`src/core/mesh/handover.ts:762`) and restarts hub services. A forever-unsettling worker intentionally retains its id and one lane slot, prevents truthful idle, and blocks handover; other lanes can progress. No evidence supports claiming arbitrary JavaScript workers can be forcibly stopped.

The committed-work early return still refuses handover without aborting that work. Ordinary cooperative aborts now physically settle before being handed. The retained tests cover both paths (`s2-logs/11-promotion-final.log:5`). No blocking caller-contract violation was found.

## Issues

Critical: none.
Important: none.
Minor: none.

## Concrete cross-file checks and narrowly expanded context

1. Risk: the longer drain might exceed an enclosing promotion timeout or transfer authority before settlement. Checked `src/core/mesh/handover.ts:594-622`, `:752-778`, `:850-875`, `:1260-1328`, and the drain-call hunk. Promotion is asynchronous; refusal resumes; promotion records use their own lane; actual handover follows the drain result. The small changed handover hunk did not include these enclosing/callee functions, so this was necessary caller context, not a redundant changed-file read.
2. Risk: recovery-on-resume could replay live work or bypass effect/approval rules. Checked the omitted ends of recover and its effect helpers in `src/core/ledger.ts:285-334`, `:365-397`, `:610-730`, plus the beginning of the type/transition definitions. The diff cut recover and omitted these helper bodies. The retained existing effect/not-started/restart logs cover their normal contracts; inflight checks prevent a still-live active task from recovery replay.
3. Risk: bounded stop/close could now wait forever or leave an unhandled late rejection. Checked `src/core/index.ts:802-807`, `:1567-1599`, `:1650-1654`, `:1710-1736` and the promotion construction callbacks. Stop retains its bounded idle race and process-stop path. Close retains its bounded idle race. See the single new probe below for the late-close limit.
4. Risk: test execution could bypass the mandatory Kubernetes tripwire. Read `scripts/test.sh`; it executes tests through `scripts/tripwire.sh` with a private temporary directory. Actual preserved test logs explicitly show armed/never-fired markers.
5. Requirement provenance: read the named original review finding 2 in `docs/reviews/nova-whole-app-review-2026-11-02.md:26`; the clarified brief extends its id/lane exclusion requirement to truthful drain and recovery. No broader finding in that document was reviewed for this task.

## Evidence examined; no covering suite rerun

- Read the full task-reviewer template, Task 2 brief, binding constraints, and implementer report.
- Read the packaged diff once. The tool output truncated the handover/effects section; recovered only that missing section from the same package. No git diff, git log, checkout, index, HEAD, or branch operation was run.
- Read the actual behavioral RED log `s2-logs/01-red.log`: four overlapping-dispatch failures (2 versus 1) and one false-empty-stuck failure; 0 pass / 5 fail, tripwire never fired.
- Inspected retained summaries across `s2-logs/*.log`, then actual full relevant logs: `06-final-affected.log` (77 pass, 0 fail/skip/cancel), `09-handover-recovery.log` (4 pass), `11-promotion-final.log` (11 pass after the final fixture change), `08-boundary.log` (1 pass), `10-typecheck-final.log`, and empty `12-diff-check.log`. Also read recorded source hashes and the source-only commit log. The controller already holds pinned source identity; no redundant hash or git check was run here.
- The earlier typecheck failure is explicitly preserved: the fake worker lacked `health`; final fixture/typecheck and promotion-suite results supersede it. No unexplained warning or failure appeared in the examined final covering output. Standard npm command notices are present in the typecheck log, not compiler warnings.
- The acceptance evidence covers old-hub restart while held, candidate death/refusal release, candidate taking the role before error, and stale records. It does not constitute complete final CI.

### Single new focused probe

Unanswered doubt: after an already-timed-out worker remains physically live beyond a caller's bounded close, does settlement access the closed database?

Command: `PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/tripwire.sh node --input-type=module` with an inline stdin program importing Db, Log, and Ledger. It created only an in-memory DB and fake deferred worker, used a 10 ms timeout / maxAttempts 1, awaited 40 ms, asserted terminal failure, attached an explicit pump rejection observer, closed the DB, then resolved the fake promise. There were no provider, device, network, model, shell worker, or cloud operations and no fixture files written.

Observed stdout:

```text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
{"stateBeforeClose":"failed","lateSettlement":{"ok":false,"error":"database is not open"}}
no-Kubernetes tripwire: never fired
```

Command completed successfully. This shows that a retained pump can reject after DB close. It does not establish an unhandled rejection in Core.close: the existing `Promise.race` retains the rejection observer on `ledger.idle()`, which itself awaits the pump, even after the timeout branch wins. No new user-visible task-scoped failure was demonstrated, so this is recorded as a limitation/observation, not inflated into a blocking finding. The probe did not instantiate a real Core or independently verify every shutdown caller.

## Cannot verify / limits

- Final complete CI, final adversarial review, and a whole-branch merge assessment are not performed or claimed here.
- Arbitrary out-of-band effects after a worker's abort cannot be disproved or undone by Ledger authority revocation. The reviewed guarantee concerns the tracked underlying worker promise; detached work after its settlement is outside this contract.
- The 11-minute production bound was derived from the actual wait sequence and defaults, not exercised as an eleven-minute test. Small-bound refusal and committed/cooperative cases have preserved passing evidence.
- Exact final-source validation identity relies on the controller's pinned source and the preserved source/commit evidence; this reviewer intentionally did not repeat git/hash verification or regenerate green logs.
- This task review does not prove general cross-process orphan handling or safety of arbitrary consumers that close their own database without observing an outstanding Ledger promise. Existing bounded stop/close paths inspected here remain bounded.

## Commands and release

All commands used workdir `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`. Read commands were `pwd`, `cat` for the named template/brief/constraints/report/diff/logs, targeted `sed`, and targeted `rg`. One initial caller `rg` also named nonexistent `src/core/core.ts` and returned a path diagnostic; actual core callers were then read from `src/core/index.ts`. A broad initial tool-output cap truncated part of the package, which was recovered as described; no required function remains unread because of that truncation. The only execution beyond reads was the focused in-memory tripwire probe. No suite, typecheck, package install, dependency operation, AI subagent, real integration, provider, key/account, owner data, protected preview, old worktree, Kubernetes, or external publishing action was performed.

The sole persistent write is this authorized ignored report. Source, index, HEAD, and branch were not changed. All commands have ended; no test, background process, or pending file write remains. **RELEASE: all commands and writes are released to the controller.**


## Full final independent adversarial review

# Final independent adversarial review — S1/S2

**Verdict: APPROVED for the S1/S2 source change. Spec compliance: PASS. Critical 0; Important 0; Minor 0.** Merge readiness remains conditional on the controller's ordinary exact-head CI, accurate same-PR LEDGER, and normal merge gates. This report is not a claim that those later gates have passed.

Reviewed base `048eea0ee043f43d01bc9a36bed601ce9805373b` through source head `7055737e3d2571df279574847107c83b2acfc6e6`, in `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`. Read the supplied whole-branch source package first, then final-review-context, constraints, plan and the requesting-code-review/code-reviewer rubric. Confirmed HEAD matches the dispatch; status contained only controller-owned untracked documentation. Those documents were treated as requirements/evidence, not additional implemented code.

## Strengths and spec compliance

- **S1 rejects inherited credentials by construction.** `src/core/child-env.ts:4` defines 20 exact public names; the loop at `:14` copies only defined values for those names. There is no parent spread, credential-name blacklist, or prefix allowance. An unknown innocently named parent secret is excluded by the same rule as the known provider, Nova, session and runtime-injection settings.
- **The real launch sites use that policy.** `src/tools.js:597` supplies `inheritedChildEnv()` to the actual spawn; `src/agent.js:16` delegates to the helper and `:29` supplies that result to spawn; `src/core/providers/cli.ts:44` constructs the filtered provider environment and `:56` uses it by default. `src/core/index.ts:158` preserves the required public module boundary. No runtime dependency or new configuration surface is introduced.
- **Startup reconstruction is addressed.** `src/tools.js:597` selects `/bin/sh -c`, instead of the ambient SHELL and login mode. Merely removing `-l` while retaining arbitrary SHELL would not have excluded non-login startup files. This intentional syntax/profile narrowing matches the existing agent/provider POSIX shell convention. The retained tests use a private startup-loading fixture and actual child processes; they do not inspect owner profiles or dump parent secrets (`tests/subprocess-environment.test.js:15`).
- **S2 separates permission from occupancy.** The matching controller is removed synchronously on abort at `src/core/ledger.ts:540`; `committing` (`:312`), `notStarted` (`:287`) and needs-person authority (`:269`) continue to require a running controller. The separately captured worker promise at `:547` remains awaited by the finalizer at `:595`. The inflight id and lane are therefore retained after timeout/cancellation until actual settlement, without keeping commit authority alive.
- **Redispatch and late results are controlled.** Pump excludes the same inflight id at `src/core/ledger.ts:404`, and counts its lane at `:406`; manual retry refuses it at `:253`. A signal that expired before the result continuation is rejected at `:552`. Late resolution/rejection is observed only for settlement, not report acceptance. Deleting occupancy and waking the pump at `:411` happens after that settlement. The existing wake race and dirty flag remain coherent: completion wakes a sleeping pump, and queued work in unrelated lanes can be admitted while another promise stays pending.
- **Recovery retains effects/approval rules.** `recover()` skips live active and needs-person tasks at `src/core/ledger.ts:342` and `:361`. Resume recovers settled interruptions (`:491`); a later-settling interrupted worker requests recovery after its inflight entry is removed (`:414`). Existing `#mayRerun`, `#retryOrFail`, not-started giveback, attempt limits, external-effect hold and tier-3 reapproval remain the decision paths (`:614`, `:632`, `:657`). No new automatic external-effect replay is introduced.
- **Handover consumes the strengthened contract.** `src/core/ledger.ts:460` drains physical inflight records and returns unresolved work as stuck. `src/core/mesh/handover.ts:630` refuses before writes are held or authority/name transfers and calls the existing resume path (`:762`). Updated wording describes both committed work and uncooperative timeout/cancellation accurately. Promotion records have their own lane (`:1288`), so a retained ordinary lane cannot prevent refusal records from running.
- **Regression evidence tests behavior.** The max-1/max-2 × late-resolve/late-reject matrix (`tests/core/ledger.test.ts:451`) exercises id exclusion, capacity, independent progress, expired authority, idle, late report suppression and wakeup. Cancellation, terminal timeout, refused drain, halt/resume, external-effect manual retry refusal and real disposable-core promotion cover the surrounding contracts. The modified old hang tests now release controlled promises rather than demanding false idle or freeing live work.

## Cross-file adversarial judgments

**Explicit environment overrides:** I searched production `childEnv` and `runLines` callers. Claude Code, Codex and custom-cli adapters supply `childEnv()` with no extras (`src/core/providers/claude-code.ts:52`, `codex.ts:41`, `custom-cli.ts:47`). The separate checks/coding environment is already finite and uses a private home (`src/core/providers/checks.ts:26`); infra supplies its explicit project credential environment (`src/core/infra/tool.ts:113`, `:128`). These are existing intentional caller contracts, not an ambient-parent escape introduced by this branch. Retaining trusted `childEnv(extra, env)` is compliant and tested.

**Actual secret sources:** Code-only checks of `src/server.js:79`, `src/core/index.ts:365`, `src/core/index.ts:773`, `src/core/providers/registry.ts:376`, and vault storage/key-mode code confirm provider fallback names and mesh tokens fall outside the finite inherited policy, while callback/vault values are not automatically exported through it. The policy excludes future names without having to enumerate every source. No actual credentials, host environment dump, keychain or owner files were accessed.

**Integration with task events/retries:** I inspected the current task listeners in coding, browser, infra, network, changes and decisions, and automatic retry sites in models/repairs/privacy handling. I found no new production listener that requires an expired physical worker to relinquish its id immediately. Ordinary completed workers release occupancy in the ensuing promise cleanup; public asynchronous retry requests and automatic capacity checks retain their established behavior. No new hook or second queue is needed.

**Drain liveness:** The maximum configured wait is `boundMs + 2 * commitMs`, plus event-loop scheduling delay: one normal interval, one interval for committed work, then one post-abort settlement interval. With defaults at `src/core/mesh/handover.ts:629`, this can be **11 minutes**. It is a deliberate increase, not an unbounded drain or an HTTP response timeout: promotion starts its own promise and returns its view (`:609`). During the drain hub background work is stopped; refusal restores it (`:767`). Truly uncooperative work can reserve one lane slot indefinitely, keep `idle()` pending and prevent handover. Independent lanes remain schedulable after resume. This is an explicit safety/liveness tradeoff required by physical ownership; no blocker was found.

**Known closed-database limit — independently adjudicated:** The task-2 reviewer actually observed a retained pump reject `database is not open` when a directly owned Db was closed before the timed-out worker settled. That is credible and consistent with the next pump scan at `src/core/ledger.ts:401`; it is not silently discarded. The production `Core.close()` path at `src/core/index.ts:1734` attaches `ticking.then(() => ledger.idle())` to its bounded `Promise.race`. A losing race branch remains rejection-observed, and `idle()` awaits the pump. `stopWork()` also uses a bounded observed idle race (`:806`). Thus the retained observation does **not** demonstrate a new Core.close unhandled rejection or a task-scoped merge blocker. It does demonstrate that arbitrary Db-owning consumers must not interpret an early DB close as successful Ledger quiescence. I did not rerun that already answered probe or claim every shutdown combination is proven safe.

## Issues

- Critical: none.
- Important: none.
- Minor: none.

## Evidence and verification limits

This final review performed code/caller/evidence inspection, not another test run. No concrete unanswered risk remained that warranted duplicating the controlled subprocess, Ledger or promotion packages already accepted by the task reviews. No new probe, blanket suite, typecheck, dependency install or expensive iteration was run.

Read both implementation reports and independent reviews. Spot-checked retained actual final-output summaries: S1 focused 5 passes; S2 affected 77 passes; final promotion 11 passes; final typecheck output contains the npm invocation notices and no compiler diagnostic. Their reported failures/skips/cancellations are zero and test logs state the tripwire never fired. The accepted reports retain the behavioral RED failures, final covering commands, source identity and intermediate diagnostics. The S1 erasable-annotation syntax attempts and S2 missing-health fixture typecheck failure are disclosed and superseded by the final evidence; they are not being relabeled as successes.

Cannot independently verify in this review:

- Ordinary complete exact-head CI, UI/token/theme/audit/required gates, final LEDGER contents, publishing, merge or post-merge preview health. These remain controller work.
- Actual authenticated CLI/provider behavior, every supported OS's shell/runtime/keychain behavior, or physical-device/cloud integration. These operations were expressly prohibited; fake-process evidence is not proof of real authentication compatibility.
- An eleven-minute real-time drain. Its upper bound is derived from the wait sequence; retained tests use short bounds.
- Every arbitrary DB-owning shutdown consumer or cross-process orphan scenario. The concrete known Db-close observation is recorded above; no real Core late-close probe was performed here.
- Recovery of the overwritten first transient S1 RED log or its original fixture source from the final tree. The implementation report discloses that limitation; retained rerun/portable RED evidence establishes the actual failure independently. Complete historical shell exit status/source-timing claims still depend on the controller's preserved transcript and records.

Initial output truncation was resolved with targeted package/source reads. An initial attempt to read `task1-review.md`/`task2-review.md` returned missing-file diagnostics; the actual hyphenated filenames were then located and read. These were read-only inspection errors, not test results.

## Declined to judge / outside this fix — controller ruling requested

Each item below was considered and deliberately not represented as delivered or disproven by S1/S2:

1. Same-user filesystem/keychain access, credentials deliberately supplied by an approved command, or a trusted command explicitly starting another shell: environment isolation is not an OS sandbox or broad DLP boundary; retained HOME/PATH are an explicit compatibility contract.
2. Full authenticated CLI/profile/proxy/custom-CA/session compatibility after allowlisting, and arbitrary SHELL-specific syntax: automatic ambient forwarding/login startup is intentionally removed; real-account testing is prohibited. Record this compatibility cost in LEDGER rather than add a secret-forwarding exception.
3. Rewriting other internal subprocess environments, including platform vault helpers and internal Git commands: those distinct existing contracts are outside the owner-selected exec/agent/provider inheritance paths. No blanket claim about every spawned process is made.
4. Work detached by a worker after its returned promise has settled, deliberate process-group escape, direct effects performed despite abort, or durable ownership across independent Ledger instances/process restarts: this fix tracks the returned live promise and revokes Ledger permission; it cannot forcibly stop arbitrary JavaScript or undo outside effects.
5. Automatically restarting/killing Nova to free a permanently occupied lane, or blindly replaying external effects: neither is authorized by this task, and either would require a separate recovery policy. The visible liveness cost remains explicit.
6. A universal close protocol for arbitrary callers that close Db while Ledger work is live: the concrete pump rejection is retained above; no production Core.close unhandled defect was demonstrated. Broad shutdown redesign is not silently required or claimed here.
7. General scheduler performance redesign, malicious/reentrant third-party event-listener hardening, and mutable lane policies beyond existing worker contracts: no new concrete regression was found in current callers; S2 fixes ownership with the existing queue and lane policy.
8. W1/W2, other whole-app-review findings (including agent scratch/quoting, real CLI sandbox flags, API/SSRF/UI concerns), and the remaining orchestration queue: separately ordered future work. This review approves only the complete S1/S2 branch and does not certify the whole application.

## Assessment and release

**Ready to merge? Yes for source quality and S1/S2 compliance, subject to the later ordinary exact-head CI and accurate same-PR LEDGER gates.** The finite inherited policy closes the selected environment leak, while the existing inflight registry now owns actual worker lifetime without extending expired authority. Cross-file handover/recovery checks and retained behavioral evidence support that conclusion; the shutdown observation and liveness/compatibility limits remain explicit.

The sole reviewer persistent write is this authorized report. No source, index, HEAD, branch, provider/account, owner data, protected preview, other worktree or external service was changed. No subagent was dispatched. All commands and this write have ended; no reviewer process or pending write remains. **RELEASE.**


## Rulings I made

Exhaustive controller decisions in their original order; the owner's instruction limits chat reports to merge lines and blockers, so the reviewable PR record carries this full list.

1. Ruling: the owner's explicit ordered fixes and continuous-execution instruction authorize this implementation directly; no duplicate brainstorming/plan confirmation round. Existing review is the design; engineering details independently reviewed. Cost ifwrong: visibleimplementationrework; actualnewrenderedpatterns/designstage2/architectureowner-gates persist.

2. Ruling: reuse our own completedNavworktree on a freshcodex branch fromoriginmain, never oldownercheckout. Cost: directorynamestillmain-ci-fixtures; branch/plan/nativeattachment identifycurrentsecuritywork.

3. Ruling: use a positive finite inheritedenvironment policy sharedacrossbothrequestedpaths andproviderCLIdefaults instead of guessingallsecretkeynames. Cost: commandsrelyingonunknownambientsettings needexplicitdocumentedconfiguration; do not silentlyreallowprovidersecrets. Trustedexplicitextrasremainseparateperexistingcontractafteraudit.

4. Ruling: treat liveuncooperativeworkersasowningid/lane untilrealsettlementwhileimmediatelyrevokingexpiredattemptauthority. Unrelatedlanescontinue; handovermustnotsayfinishedwhileconflictingworklives. Cost: a forever-uncooperativeworker canholditsownlane/handoveruntilprocessisactuallystopped; safetywins overoverlappingwrites. No arbitraryautomaticrestartornewpersistentqueue.

5. Ruling: exec now uses fixed non-login /bin/sh -c because the actual private zsh fixture reintroduced a startup secret after environment filtering. Cost: shell-specific syntax, startup aliases/functions and startup-derived PATH are no longer implicit; an approved command can explicitly select an interpreter. This prevents automatic reintroduction without pretending to sandbox same-user file access.

6. Ruling: include narrowly necessary handover refusal wording in S2 because physical stuck work may be pre-commit and the old claim would be false. Cost: operator-visible diagnostic changes alongside the concurrency fix; no approval/effect authority or new UI pattern changed.

7. Ruling: accept documented bounded drain up to boundMs+2commitMs (production11min) because promotion is asynchronous and no role/name/writes transfer occurs before safe drain; no smaller public total deadline was promised. Cost: a long noncooperative attempt can delay refusal and own-lane progress; independent lanes still work, no false safe handover.

8. Ruling: retain the observed late-pump rejection after direct premature database closure as an explicit limitation for final review, not a demonstrated Core.close unhandled-rejection defect; existing Core.close rejection observer remains attached. Cost if wrong: a shutdown caller outside observed contract could need a scoped robustness fix; final reviewer must judge the concrete observation.

9. Ruling: Scope the inheritance guarantee to the automatic environment boundary, preserving deliberate same-user command/file authority. — The owner selected environment leakage, not an OS sandbox. — Cost if wrong: Explicit approved commands can still access readable files or invoke interpreters; no DLP claim.

10. Ruling: Keep authenticated CLI/profile/proxy/custom-CA compatibility unproven rather than automatically restoring ambient settings. — Real accounts/keychains were prohibited and automatic forwarding would reopen S1. — Cost if wrong: Some installations require explicit safe configuration; no secret-forwarding exception is silently added.

11. Ruling: Leave distinct platform-keychain/internal-Git subprocess contracts outside this selected inheritance change. — No concrete new regression was found there and this branch makes no every-process claim. — Cost if wrong: Separate contracts still need their own focused review if changed.

12. Ruling: Limit occupancy to the actual returned worker promise and retain existing cross-process/effect reconciliation. — JavaScript cannot track arbitrary detached work or undo side effects despite abort. — Cost if wrong: Deliberate detached work and independent-instance ownership are not solved by this patch.

13. Ruling: Do not add automatic process restart/kill or blind effect replay to free a held lane. — Those require a recovery policy beyond the selected fix. — Cost if wrong: A permanently uncooperative worker may require an intentional process stop; its lane/handovers stay held meanwhile.

14. Ruling: Retain existing bounded Core stop/close rather than redesign every arbitrary database consumer. — The observed premature-close pump rejection is handled by the inspected production idle races; no production failure was shown. — Cost if wrong: A different DB owner must observe live Ledger work and may need its own close protocol.

15. Ruling: Preserve existing scheduling/event-listener/lane-policy contracts rather than redesign them. — Final review found no concrete new current-caller regression. — Cost if wrong: Malicious reentrant plugins or newly mutable lane contracts would require separate hardening.

16. Ruling: Approve only S1/S2 and keep W1/W2 and the remaining ordered queue separate. — Owner explicitly prioritized these two fixes; the whole-app review is not a blanket completed-app certificate. — Cost if wrong: Other known review findings and unmounted capabilities remain unfinished until their own work/gates land.
