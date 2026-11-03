# Consolidated final-review fix report

Status: DONE — I1/M1 fixed and committed; source RELEASED. I1 and M1 addressed in the one authorized final fix wave. No subagent/reviewer, push, PR, merge, preview, or other-worktree write. This report is ignored local audit material, not hosted evidence or final-head CI.

## Authority, scope, source identity

Sole writing checkout `/home/jeremy/.codex/worktrees/nova-health-backend-wiring/nova-build`, branch `codex/health-backend-wiring`. Clean FIX_BASE `f9ffbb0c2b241b60ba5161cc55bbdb8c3462b819` confirmed before writes. Read complete final-fix brief first (verbatim I1/M1, all original Global Constraints and root override), complete final review, and Task 1 main report/harness appendix; bounded rereads recovered combined-output truncations. Did not read the parent UI plan. Applied systematic-debugging, test-driven-development and verification-before-completion skills. Root's explicit bounded-check/no-subagent instructions govern over generic whole-suite or delegation suggestions.

Root narrowed exact-picks-only authorization to required diagnostics scan failure contract/tests/docs and Caps availability copy/assertion/README. No #284 environment/physical-ledger change, scrubber shape/form/key matching change, raw secret API, store, dependency, protocol, UI, provider accounting or limits/resume mechanism change. The two original `-x` commits and original evidence remain intact. Initial eleven-blob equality was true at its pinned source; it is **historical proof**, not a current-source equality claim after this fix.

Root confirmed required scan classification during implementation: vault list/get/partial entry, keyForStandby read, non-ENOENT key-file inspection and actual existing mesh secret identity must fail closed; genuinely empty vault/confirmed absent optional files remain valid. Inspected `src/core/mesh/identity.ts` loadIdentity and `src/core/mesh/wire.ts:161–190`: Core creates/loads `ed25519.private` and `x25519.private` and imports both during startup; there is no supported metadata-only identity state. Therefore this existing identity's read/parse/incomplete-private-field failure is required-scan failure. No non-secret optional metadata probe behavior was changed.

## Implementation and self-review

- `src/core/diagnostics/index.ts`: required scan completes before included metadata/free-text projection. Vault enumeration, every enumerated value, existing standby-key read and key-file/mesh private sources either yield a complete set or throw an internal fixed `SecretScanUnavailable` without raw cause/details. A missing listed entry is incomplete, not an empty vault. Missing optional file key (`ENOENT`) is normal; other file read errors refuse. Genuinely empty vaults remain valid. Existing short-secret/encoding/shape matching rules are unchanged.
- The existing mounted person-only route catches only that internal scan failure and returns JSON `{error: fixed message}` with status503, inherited `no-store`, no attachment and no raw exception warning or new error log. Other unexpected errors retain existing API handling. Authorization executes before the handler. No cached or persisted bundle is added. Successful bundle schema and empty warnings array remain compatible.
- `tests/core/diagnostics-composition.test.ts`: real createNova HTTP/private file-vault controls prove empty200 and readable200/redaction, then close, move only fixture key and restart. Unavailable populated vault must return503/no attachment/no canary/path. Eight further cases cover enumeration throw, second lookup throw/null, standby-key throw, unreadable file key, unreadable/malformed/incomplete identity. Only bounded vault source-read faults are injected where needed; route/builder/vault in real-key-loss case/scrubber are real. A spy verifies included models metadata is not read on failed scan. Exact error-only body, no raw error in service logs and no newly persisted file are asserted. Existing encoding and excluded-store assertions are intact.
- `src/core/caps/index.ts` and `tests/acceptance/caps.test.ts`: remove the phantom Health limits destination. Keep the actual daily stop, before-first-model-call refusal, Tasks approval, available-budget and midnight-reset language; preserve waiting resume and existing tier2 approved-resume checks. No ceiling or behavior implementation changed.
- `docs/plans/diagnostics.md`: replace the contradictory warning-and-download failure contract with fixed503/no attachment; retain free-text limitations and valid empty/optional-file semantics.
- `src/core/README.md`: Caps APIs are active/person-only and use the single Core Caps; Health UI/approval/crawl remain pending285. Diagnostics entry records fail-closed scan behavior.

Self-review covered every changed hunk, all required source failure paths, empty control, success/attachment and failure/no-attachment branches, guard-before-handler flow, raw-error propagation and log side effects, same-instance Caps ownership, unchanged stop/resume limits and original canaries. SecretScanUnavailable carries only a literal message; its raw underlying exception is discarded. Scrubber prefix (including forms, shapes, key handling and length thresholds) is byte-equal to FIX_BASE. Unknown free text remains outside known-secret guarantees.

## RED/GREEN chronology

1. Saved dedicated launcher/own synthetic Git identity while source was clean at FIX_BASE. Added tests only, then `red-i1`: exit1, **0/10 pass** (two top-level tests plus eight children). Empty/readable HTTP controls passed within the first test before real key-loss assertion failed on exposed private data. List/second lookup throw/null also failed on exposure. Key/identity source cases failed on200 versus503. No setup failure; full stdout/stderr retained.
2. `red-m1`: exit1, **0/1 pass**, actual day-stop message still named Health. Stop/no-first-call assertions before the changed copy assertion passed. No production edit had occurred before either RED.
3. Made one source/docs fix wave. `green-focused`: exit0, **28/28 pass**, zero skips/cancellations/todo. Includes diagnostics composition, real key loss and all partial/error cases, existing known-secret encodings/excluded stores, Caps API/auth/validation/restart, Caps composition/timezone, loop/day ceilings, uncapped conversations and tier2 approved resume.
4. Compiler run once against final source: exit0. Ordinary `npm notice run nova@0.1.0 typecheck` and `npm notice run tsc -p tsconfig.json` retained; no compiler error or available-update notice.
5. Runtime/identity probe exit0: Node **v26.3.1**, actual FIX_BASE identity **f9ffbb0c2b241b60ba5161cc55bbdb8c3462b819**. Every run's tripwire printed **never fired**. No broad passing-suite repeats.

## Safe launcher and exact provenance

`evidence/final-fix/launcher.py` was saved before invocation, derived from the preserved task1 launcher. Each unique label refuses overwrite, records full argv/environment/cwd/start before execution, retains separate complete stdout/stderr, and appends actual status/end. It also records real host HEAD and uncommitted per-file blob hashes before each invocation. Test flags precede paths. Source remained unchanged between final focused/compile/probe and commit.

Cached `mcr.microsoft.com/playwright:v1.56.1-noble`, `--pull=never --network=none --user=1000:1000 --read-only`; private writable tmpfs `/tmp`; own code, matching dependencies and Node26 readonly. Dependencies explicitly bind `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/node_modules` to `/workspace/node_modules`; package/lock bytes matched before runs, no install/resolution workaround/source substitution. Host ignored node_modules mountpoint stays empty. Host env only PATH `/usr/bin:/bin`, unique private temporary HOME and LANG. Container HOME private, PATH `/opt/node/bin:/usr/bin:/bin`, NOVA_VAULT_KEY=file, NPM_CONFIG_UPDATE_NOTIFIER=false, TZ=UTC, LANG=C.UTF-8. Test runs preload existing TCP egress guard and use existing tripwire; no external network namespace access. No real owner home/keychain/service/account/model/provider/device/cloud data/actions, network/image pulls or preview.

The sole `.git` overlay points to own readonly evidence with actual FIX_BASE detached HEAD, one SHA1-verified real commit object, empty refs and minimal local config. No shared gitdir/history/credentials/config mount. This is actual FIX_BASE plus explicitly recorded uncommitted blobs, **not** a claim that the then-uncommitted source had final commit identity. About.build assertion is unchanged. Root owns exact-final-head CI later.

## Failures, warnings, omissions and retained history

All two expected RED invocations are retained without replacement, along with every successful invocation. No intermediate source-fix failure or test setup error occurred. One exploration read used mistaken `evidence/task-1/launch.py` and exited1 with `cat: ... No such file or directory`; corrected to existing `launcher.py` once, before execution. Several initial combined tool read outputs truncated; bounded reads recovered required report/skill/source contents. These are exploration issues, not suppressed test output. No actual test run used the nonexistent path. Compiler's ordinary notices remain verbatim below. No test skip, test weakening, bypass, raw probe bundle/private key print, or canary removal.

Original task1 sealed evidence hashes verified unchanged, including preserved original45-file/144285-byte history and initial failures/warnings. Full final-review evidence and reports remain untouched. No attempt to upgrade old launcher limitations or original source equality into current proof.

## Remaining limits / root-owned work

This is backend/API-only. Health rendered-entry approval, save/download browser interactions, controls, Home phone/rail crawl and W1/W2 completion remain285. C18/O14/C19/O15 app-not-shipped status remains unchanged. Provider-managed reports remain separate in Models and excluded from day/month/live Caps (`this-node-runner`, `provider_reports_included:false`); estimated/unpriced and other-node limits remain. No second store or budget/broker work.

Known-secret source refusal is deliberate reduced availability when a required scan cannot complete. It does not classify arbitrary unknown personal text in included messages/names; documented synthetic host/IP/model metadata remains allowed. Partial source faults are bounded injections; real key-loss case is nonmocked. No full ordinary final-head CI, independent rereview, push/PR/merge, matching-tree or preview was performed. Root owns scoped rereview and those remaining gates.

Tracked `docs/evidence/health-backend-wiring-2026-11-03.md` contains initial equality/unchanged-source statements; they must be scoped to historical integration in root's evidence-publication update. Root was notified. I left that controller-owned publication, LEDGER, inventory and controller plan untouched. Exact deviations below supersede current equality assumptions; original statements remain historically true at pinned source.

## Changed blob mapping

| Path | Reviewed285 blob | FIX_BASE blob | Tested final blob |
| --- | --- | --- | --- |
| `docs/plans/diagnostics.md` | `86f65a0bc2ddf94ed6403493f22d1a8c48612d8b` | `86f65a0bc2ddf94ed6403493f22d1a8c48612d8b` | `5d162b5917da0a27c73a6adf3521805e5a8bd9da` |
| `src/core/README.md` | `36afb4a5f9ad17743361a140d50ec5bfea214fbe` | `36afb4a5f9ad17743361a140d50ec5bfea214fbe` | `7c7ac92fddefdf1cca28e7964a835cfda23d9ac5` |
| `src/core/caps/index.ts` | `cb75d02b5fcec82073335ce1bb92a466d62d07ab` | `cb75d02b5fcec82073335ce1bb92a466d62d07ab` | `2d7456c53a1064d9d9898aa02fce9ca3ca71d2c2` |
| `src/core/diagnostics/index.ts` | `ab7afafd3e9e63201c04875ff02fc3ebdcb43167` | `ab7afafd3e9e63201c04875ff02fc3ebdcb43167` | `101fb1e5f2d92add5f4e6e6c7ad99f13de1dc2b0` |
| `tests/acceptance/caps.test.ts` | `f599f7c9441ce8605a934954bd1729a9087fbd4f` | `f599f7c9441ce8605a934954bd1729a9087fbd4f` | `bc65764080338e7d3a9357f6ff4a03dc08b634c3` |
| `tests/core/diagnostics-composition.test.ts` | `dc7a72f589b2e4cdcb7476dc3989717dde2872a0` | `dc7a72f589b2e4cdcb7476dc3989717dde2872a0` | `6f60245bc7761be0486914abdb6bf2524e31c0ec` |

Five of the eleven originally picked files now differ; six remain equal. The additional diagnostics builder file was unchanged by original picks and now has the authorized scan fix. `provenance.json` lists all eleven explicitly. No other tracked file differs from FIX_BASE. Historical sealed files verified: 79, mismatches0.

## Exact commands, outcomes and evidence links

Each command runs with explicit sole-checkout cwd through `python3 .superpowers/sdd/health-backend-wiring-2026-11-03/evidence/final-fix/launcher.py LABEL`. The saved launcher and each JSON record give the full enumerated environment/Docker argv/cwd/timestamps/status and uncommitted source hashes. Complete stdout/stderr remain separate, unedited files.

| Label | Command after label | Result | Complete record and output |
| --- | --- | --- | --- |
| red-i1 | `sh scripts/test.sh --import ./tests/acceptance/egress-guard.ts --test-concurrency=1 '--test-name-pattern=production diagnostics (refuses\|rejects)' tests/core/diagnostics-composition.test.ts` | exit1; 0/10 | [json](evidence/final-fix/red-i1.json), [stdout](evidence/final-fix/red-i1.stdout), [stderr](evidence/final-fix/red-i1.stderr) |
| red-m1 | `sh scripts/test.sh --import ./tests/acceptance/egress-guard.ts --test-concurrency=1 '--test-name-pattern=the day’s ceiling stops' tests/acceptance/caps.test.ts` | exit1; 0/1 | [json](evidence/final-fix/red-m1.json), [stdout](evidence/final-fix/red-m1.stdout), [stderr](evidence/final-fix/red-m1.stderr) |
| green-focused | `sh scripts/test.sh --import ./tests/acceptance/egress-guard.ts --test-concurrency=1 tests/core/diagnostics-composition.test.ts tests/core/diagnostics.test.ts tests/acceptance/caps.test.ts tests/acceptance/caps-api.test.ts tests/core/caps-composition.test.ts tests/core/caps.test.ts` | exit0; 28/28; no skips | [json](evidence/final-fix/green-focused.json), [stdout](evidence/final-fix/green-focused.stdout), [stderr](evidence/final-fix/green-focused.stderr) |
| compiler | `sh scripts/tripwire.sh npm run typecheck` | exit0; ordinary npm invocation notices | [json](evidence/final-fix/compiler.json), [stdout](evidence/final-fix/compiler.stdout), [stderr](evidence/final-fix/compiler.stderr) |
| runtime-identity | `sh scripts/tripwire.sh sh -c 'node --version && git -C /workspace rev-parse HEAD'` | exit0; v26.3.1; f9ffbb0c2b241b60ba5161cc55bbdb8c3462b819 | [json](evidence/final-fix/runtime-identity.json), [stdout](evidence/final-fix/runtime-identity.stdout), [stderr](evidence/final-fix/runtime-identity.stderr) |

RED assertion excerpts (complete stack traces and raw records linked above):

```text
red-i1, real key loss + list/second lookup faults:
AssertionError [ERR_ASSERTION]: failed scan response exposed private data
red-i1, key/identity source faults:
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
200 !== 503
red-m1:
AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /Health/.
... Resuming waits for your OK in Tasks, and runs once there is room under today’s ceiling (it starts again at midnight); the ceilings are in Health.
```

Final focused output summary:

```text
ℹ tests 28
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
no-Kubernetes tripwire: never fired
```

Compiler stderr, retained without filtering:

```text
npm notice run nova@0.1.0 typecheck
npm notice run tsc -p tsconfig.json
```

[Launcher](evidence/final-fix/launcher.py), [isolated Git identity record](evidence/final-fix/git-identity.json), [full provenance/eleven original blob mappings/precommit checks](evidence/final-fix/provenance.json), [immutable tested source diff](evidence/final-fix/source.diff). `git diff --check` exit0. Every run printed the tripwire never fired. The SHA256 manifest is sealed after commit/handoff checks below.

## Final commit and RELEASE

Commit **`4e7278d1b662a376ea3c6d2fe2e543830e2b55a8`** (`fix: refuse diagnostics with incomplete secret scans`), tree `1b0b0dc6d44a7b5e83dffd9379dfb6363ffd129b`.

[Commit commands and full outputs](evidence/final-fix/commit.json): add exactly six files, cached diff check0, commit0; 167 insertions/20 deletions. [Postcommit commands/results](evidence/final-fix/postcommit.json): branch correct, tracked worktree clean, diff check0, exact six-file scope from FIX_BASE, every committed changed blob equals the final focused/compiler invocation's recorded blob. All other tracked paths are unchanged from FIX_BASE. No post-test production/test change occurred. The test Git fixture truthfully remains FIX_BASE; source equality to this committed result is proven separately, without claiming exact-final-head CI.

[SHA256 evidence manifest](evidence/final-fix/sha256.json) seals every final-fix artifact except the manifest itself and includes this report. The original task1 seal still verifies79/79 unchanged. No original evidence or historical claim was rewritten.

RELEASE: sole-writer task complete; no further tracked source/test/docs/index/branch changes planned. Root resumes branch ownership for scoped independent rereview, current evidence correction and remaining CI/PR/merge/preview gates. No implementation blocker remains known; stated privacy/accounting/UI/verification limits remain.
