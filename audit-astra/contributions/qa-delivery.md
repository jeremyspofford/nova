# QA, delivery, and maintainability review

Baseline: merged `d948aa0a442a9f930b86f4516eeea21981b76714` (PR #438). This contribution does not establish the owner's deployed build. The owner host at localhost:4318 and its deploy watcher are inaccessible from this cloud machine. Product code is unchanged. All new evidence belongs to `audit-astra/`; test fixtures use the existing temporary-home harness.

## Verification register

| Check | Result | Evidence and scope |
|---|---|---|
| Exact baseline GitHub push CI | tested-pass (remote CI record) | `evidence/qa-ci-runs.json`, `evidence/qa-ci-jobs.json`; [run 42692472653](https://github.com/jeremyspofford/nova/actions/runs/42692472653), all required jobs including four UI shards and Era-2 walkthrough succeeded. This is retrieved CI evidence, not a locally repeated browser run. |
| Local `npm run check` | tested-fail, with one fixture interruption | `evidence/qa-check.log`, `qa-check-summary.json`: reporter 2,269 tests, 2,214 pass, 40 fail, 15 skip; exit1 after1,021.0s. Pinned Node26.3.1, inherited `NOVA_*` removed, no real-model flags. A failed Docker fixture retained handles and was externally stopped after9m58s; do not describe this as an uninterrupted full-gate completion. |
| Dependency advisory query | tested-pass | `evidence/qa-npm-audit.json`: zero known vulnerabilities reported by npm on this date; this is not a security certification. |
| Changelog generated-file consistency | tested-pass | `evidence/qa-extra-checks.json`: `node scripts/changelog.js --check`. |
| AGENTS/CLAUDE pointer consistency | tested-pass | Same file: `node scripts/agent-pointers.js --check`. |
| JavaScript syntax | tested-pass | Same file: CI's 204-file JavaScript parse loop, zero failures. |
| Fresh dependency install | tested-pass | `evidence/qa-install-summary.json`, `qa-install.log`; `npm ci --no-fund` in a new manifest/lock directory, 2.13 s. Existing pinned Node26 was used; this is not a clean operating-system provisioning test. |
| Focused Chromium UI set | tested-fail overall: 8 pass, 1 fail, 0 skip | `evidence/qa-ui-summary.json`, `qa-ui-check.log`; 188.25 s; Chromium 155.0.8059.79 on Linux, browser emulation. Detailed passing/failing coverage below. |
| Owner preview/watcher freshness | blocked | Parent's connection-refused probe at :4318; host deploy watcher is not present in this environment. No deployment failure is inferred. |

## What CI establishes and does not establish

The pipeline has substantive protection. Changes to unfamiliar paths default to the heavy jobs (`scripts/ci-changes.sh:21–43`), rather than silently bypassing them. `gate` depends on every required job and rejects failed/cancelled jobs (`.github/workflows/ci.yml:168–191`). Main runs are not cancelled by subsequent merges. Toolchain and browser image versions are pinned. Runtime-folder Markdown is treated as code. Tests create independent homes, and the Kubernetes tripwire makes an unintended kubectl/helm/flux/k3s dependency fail (`scripts/test.sh`, `scripts/tripwire.sh`). These safeguards should be preserved.

The local check was **not green**. Token lint (78 UI files), theme checks and strict TypeScript passed. Most failures are Nova Computer tests stopped by this runtime's missing Docker cgroup/process-list/pause capabilities: direct `docker top` on this run's synthetic container reproduces the daemon error, while ordinary `docker exec id` and folder access work. Nova refuses work when it cannot establish process isolation. Six non-Docker failures assert orphan/background processes have disappeared (M4b, provider guard, supervisor). M4b reproduced in a focused two-test rerun (one pass, one failure at `tests/acceptance/m4b-device-agent.test.ts:103`, whose liveness helper at `:21` is `kill(pid,0)`). This managed host contains many unreaped zombies under PID1, making that helper environment-sensitive; the exact cause of each individual supervisor failure is not proven. Treat those as qualification investigations, not established deployed process leaks. One `computer-egress-bounds` process finished its failed test bodies but retained open handles; only that verified audit-owned process was terminated after9m58s, allowing the remaining suite to complete. The complete logs, final reporter counts and interruption record are retained. All opt-in real models/evals, including Interstitial Research, were skipped. The no-Kubernetes tripwire never fired.

CI proves token rules, the implemented theme contract, strict TypeScript checks, parse validity of selected JavaScript, unit/API/acceptance behavior under test fixtures, Chromium/WebKit test assertions, and the scripted Era-2 walkthrough. The browser helper refuses to silently skip a missing browser in CI (`tests/ui/support.ts:68–95`). Existing performance tests use 12 synthetic repetitions per view/width, p75, phone CPU throttling and trusted interaction (`tests/ui/m9-vitals.test.ts:1–13,70–95`). Those are useful laboratory measurements, not field performance or real-model latency.

CI does not prove physical-phone enrollment, platform passkeys, installed iOS PWA behavior, owner-host watcher health, live cloud/local model quality, real integration credentials, or the prohibited Part 3 research evaluation. It deliberately skips opt-in real-provider tests when their environment flags are absent. JavaScript correctness is not typechecked (`tsconfig.json:17–22`), and automated accessibility findings are advisory (`.github/workflows/ci.yml:125–137`; `tests/ui/axe-advisory.ts:31–37`). Passing a screenshot command demonstrates an image was produced and the stated assertions passed; it does not establish functional correctness for every depicted state.

## Current-state rechecks

**New independently exercised browser coverage.** The actual Home-start crawler reached all 14 registered views at 390px phone and 1440px rail layouts, using a single document and actual links/taps; required Home/Settings topology, Capture category, Backups controls, Health cost/diagnostic doors all passed. Phone traversal recorded 32 states, rail 31 (`evidence/qa-ui/navigation/`). The Settings test passed dark/light desktop, phone/tablet layouts, search keyboard shortcut, result counts, back navigation, target sizes and reachability. Offline tests killed and restarted only their own synthetic server twice, including an out-of-order response, and confirmed the status mark stayed offline until real reconnection. Fold tests preserved draft, scroll position and unsaved setting/focus; hinge avoidance and 200% text checks passed. These are the existing tests' assertions, not a complete manual accessibility assessment.

The one focused UI failure was the prose-width rule with the optional right pane open at 840px (41.70ch vs the required 45–75ch). Independent diagnostic `diagnostics/qa-prose-width.mjs` reproduces it. Default chat at the same width measures 69.97ch. With the pane open, 1024px measures 55.70ch and 1280px 69.97ch (`evidence/qa-prose-width.json`, `qa-prose-width-default.json`, `qa-prose-840.png`). No clipped text or page error was established. Keep this as a narrow layout/browser-compatibility investigation, not a high-severity usability or WCAG claim; the current-baseline pinned CI browser image passed its suite.

**Pipeline dashboard is implemented.** `/pipeline` is a real registered view (`ui/js/app.js:295`), rendered by `ui/js/about.js:100–114`, using `/api/v1/pipeline`. It is generated from the roadmap, evidence headings, and ledger (`src/core/pipeline.ts:166–255`). Its copy explicitly says it cannot see open PRs (`ui/js/about.js:107`). Do not repeat a historical missing-dashboard claim. A limitation remains: labels describe repository records, not a live CI/deploy/task monitor. Gate-file existence determines a milestone's “Merged” label (`src/core/pipeline.ts:187–190`); this should not be reinterpreted as fresh certification of every gate. No concrete falsely-merged milestone was established in this review.

**Interstitial research is still a parked owner decision, not a backlog gap to implement.** The feature is default-off (`src/config.js:44–48`). Contrary to the older Nov 6 ledger entry, current committed verdicts contain two failed local `tev1:4b` eval records dated `2026-11-07T04:26:50.751Z` (`src/core/decision-service/verdicts-interstitial.json:12–35`). Verify-transfer's use recall is 25% against a 50% minimum and its ECE .290 exceeds .15; outbound-check ECE .153 exceeds .15. Neither is trusted. The template policy keeps untrusted transfer claims quarantined and outbound searches withheld (`src/core/decision-service/templates/interstitial.ts:13–23`). This does not establish the full Part 3 A/B/golden verification, nor does this reviewer infer approval for any further model calls from a stored result. The errata explicitly keeps authorization separate (`docs/builder-packet/interstitial-research/ERRATA-2026-11-06.md:45–52`); the current user's instruction controls. No real eval was run. Ordinary-test log shows `NOVA_REAL_INTERSTITIAL` test skipped.

**Version visibility is implemented, deployment freshness is not verified here.** The Build object captures the running commit once and reads the latest-merged record on each request; it distinguishes a start time from a build date and unknown freshness from current (`src/core/build.ts:64–72,99–121`). This is good honesty. `/api/v1/version` does not ask GitHub. Freshness therefore depends on the external writer, not this API alone. `scripts/preview.sh` is an older configurable launcher defaulting to 4317 and checks HTTP health; it does not itself write the deploy record. The documented merge queue/owner watcher is the missing operational evidence, so do not call the owner's deployment stale because this cloud machine has no listener.

## Findings / backlog candidates

### NOVA-040 — Replace the obsolete entry-point documentation with the current product contract

- Category: defect (documentation); gap C (exposed and misleading).
- Severity: Medium. Priority: P1, with onboarding/understanding repairs. Confidence: High. Evidence: documented text versus implementation; no user study claimed.
- Affected user and consequence: a new technical self-hoster learns the wrong data and provider model before installation, and may choose an unsupported backup practice based on incomplete instructions.
- Baseline: merged source `d948aa0a`; deployed applicability unverified.
- Reproduction: read README's introduction, data-home section and Configure section, then inspect the current server composition. README says plain files are the only source of truth, its build plan lives outside the repo, and `agent_cmd` is the one place a model is chosen. The implementation stores structured state in SQLite, treats core memory as canonical with a file mirror, and routes chat through a configurable provider registry.
- Observed evidence: `README.md:3–9,28–35,148–151`; `src/core/db.ts:1–5,38–50`; `src/server.js:111–130`. README's backup recommendation names NAS/iCloud/Obsidian without the implemented checkpoint/restore/deletion contract.
- Expected: the entry point accurately explains what Nova is, what is canonical, which local/cloud modes work under which setup, and how to install/backup it without reading the builder packet.
- Established cause: Era-2 opening documentation survived the core/provider changes; no claim inventory links those statements to the current system.
- Smallest coherent change: rewrite the opening, installation/model choice, storage and backup sections; link the current supported onboarding and recovery paths. Keep deep technical packet material out of the getting-started narrative.
- Components: README, current getting-started/recovery docs, package description; no product redesign required.
- Dependencies/decisions: use the audit's verified local-chat and broker limitations; do not claim pending provider-plurality ADR as implemented.
- Acceptance criteria: a fresh reader can identify the required runtime, start a disposable instance, choose a supported local or cloud chat path, locate SQLite/standing files, and identify the documented supported backup/restore and forgetting limits. Every capability claim cites current implementation or a current verified workflow. A self-hoster unfamiliar with Nova follows the documented path without a builder explanation.
- Regression verification: a lightweight documentation/runbook smoke walkthrough on a blank home; verify any shell commands. Avoid a test merely grepping the rewritten prose.
- Effort: 1–2 builder days including a fresh-user walkthrough, assuming current runtime paths remain stable.
- Status: Open; audit proposal only.

### NOVA-041 — Complete the promised release version/tag workflow

- Category: unmet commitment; gap A.
- Severity: Medium. Priority: P2 (next release, before release/update claims). Confidence: High. Evidence: source, Git refs, documented requirement.
- Affected user and consequence: two substantially different installations can both report `0.1.0-alpha.1`; support and release comparisons require commit hashes. The hash mitigates ambiguity but does not fulfill SemVer promises.
- Baseline: merged source `d948aa0a`; deployed applicability unverified.
- Reproduction: inspect package.json's version and `docs/changelog/` at the baseline; compare with tag `v0.1.0-alpha.1` (peeled commit `7dece0a10d327f4f7ed3431eb164a926396a8979`). There are 60 waiting changelog fragments and 248 commits after that tag, with the version still `0.1.0-alpha.1`.
- Observed versus expected: current UI correctly exposes pending fragments; the binding versioning item requires bumping alpha on each merge changing shipped behavior and tagging the bump (`docs/builder-packet/nova-versioning-changelog-2026-11-03.md:28–34`). This is a release-process gap, not a defect in the Build API's commit display.
- Root cause: release generation is provided, but bump/tag ownership remains a manual lead/merge-queue step (`docs/plans/versioning-deploy.md`, “Versions, the changelog and tags”); ordinary CI validates fragments, not advancement of the release identity.
- Smallest coherent change: have the single merge/release owner execute or automate one serialized version/fragment/tag transaction for behavior merges, write the latest-merged record, and verify running commit after deployment. Never rewrite the old tag.
- Components: merge/release workflow, `scripts/changelog.js`, package versions, deploy-record integration.
- Dependencies/decisions: retain the owner's stated policy unless the owner explicitly changes cadence; coordinate with the external watcher, whose behavior is not verified here.
- Acceptance criteria: two successive behavior merges yield distinct monotonically increasing versions and tags, each generated changelog matches its released fragments; non-behavior changes follow an explicit rule; restart/version readback matches the tag/commit; retries do not duplicate releases.
- Regression verification: dry-run against a disposable local repository with duplicate delivery/retry and concurrent merge cases; production evidence comes from the next authorized actual release, through the builder.
- Effort: 1–3 builder days if the merge queue can be modified; 3–5 if its operational ownership first needs consolidation.
- Status: Open; audit proposal only.

### NOVA-042 — Make new serious accessibility regressions fail a targeted CI gate

- Category: improvement to verification; gap A for the promised M9 AA gate. This does not itself establish a particular WCAG violation.
- Severity: Medium systemic risk. Priority: P2; raise with any independently reproduced blocking keyboard/contrast defect. Confidence: High in CI behavior. Evidence: code and requirements.
- Affected user and consequence: keyboard/screen-reader/low-vision users can receive new inaccessible behavior despite a green required gate.
- Baseline: merged `d948aa0a`; deployed applicability unverified.
- Reproduction: read `.github/workflows/ci.yml:125–137` and `tests/ui/axe-advisory.ts:31–37`: the advisory uses `continue-on-error` and returns 0 even when its run crashes. The required gate observes only that successful job. Existing M9 asserts selected contrast/focus behavior, but the default axe sweep cannot block regrowth.
- Current example: the exact baseline's successful GitHub run reports 23 axe violating nodes (18 label-content-name-mismatch instances on `a[data-dest="health"]`, five heading-order instances at Activity's `#handling-card-title`). The original CI excerpt is in `evidence/qa-ci-accessibility.log`. These are retrieved automated findings; manual verification is delegated to the UI audit. This turns the gate concern into an observed current example without treating every axe warning as an established WCAG failure.
- Expected: the documented AA commitment has an explicit enforcement boundary, including failures to execute the mandatory scan, while manually untestable accessibility remains a manual gate.
- Root cause: a deliberate advisory rollout has no separate regression threshold.
- Smallest coherent change: establish reviewed baseline violations and fail a small required gate on new serious/critical issues in key workflows, plus scan failure. Keep the wider advisory report. Add keyboard/focus task assertions for the high-risk journeys instead of treating axe as complete WCAG proof.
- Components: CI workflow, axe harness/baseline, targeted browser interaction tests.
- Dependencies: fold in the audit's actual accessibility findings; prioritize remediation over freezing unexplained exceptions.
- Acceptance criteria: an intentionally introduced unlabeled control/focus trap causes the appropriate gate to fail; a scanner crash fails; reviewed exceptions are scoped with owner, reason and expiry; critical Home/setup/chat/task/approval flows work by keyboard at phone and desktop layouts.
- Regression verification: negative controls in the scanner harness and an actual keyboard walkthrough; no new real model calls.
- Effort: 2–4 builder days for gate and initial triage; remediation effort belongs to each reproduced issue.
- Status: Open; audit proposal only.

### NOVA-043 — Send M9 screenshots to the configured evidence directory

- Category: defect; gap C (QA artifact output). Severity: Low. Priority: P2. Confidence: High, observed plus code.
- Baseline: merged `d948aa0a`, isolated Chromium test run; owner deployment not implicated.
- Affected user: reviewers/builders who need the promised posture evidence; configured screenshot output omits M9 images and local checks dirty tracked baseline files.
- Reproduction: set `NOVA_UI_SHOTS` to an audit directory and run `tests/ui/m9-fold.test.ts`. Eighteen screenshots instead overwrite `docs/screenshots/m9/*.png`.
- Evidence/root cause: `tests/ui/m9-support.ts:9–14` calls `shotsDir()` only as a boolean, then hardcodes `ROOT/docs/screenshots/m9`. CI uploads `$RUNNER_TEMP/ui-shots` (`.github/workflows/ci.yml:129–144`), so these images are outside the configured artifact tree. `evidence/qa-m9-screenshot-restoration.json` records the 18 observed changes and restoration; generated images are preserved in `evidence/qa-m9-shots/`.
- Expected/smallest change: use the configured screenshot directory (with an M9 subdirectory if needed); baseline regeneration must be a separate explicit command.
- Components: M9 support helper and CI artifact checks. Dependencies/decisions: none beyond preserving the baseline-regeneration workflow.
- Acceptance criteria: ordinary screenshot-enabled UI runs leave `git diff` empty; all M9 captures appear beneath the configured output directory and in the CI artifact; deliberate baseline regeneration remains explicit.
- Regression: run a single screenshot-producing M9 case with a temporary output path, assert output placement and clean tracked tree.
- Effort: 0.5–1 builder day. Status: Open, audit proposal only. The reviewer restored only the known audit-generated PNGs; no product patch was made.

### NOVA-044 — Qualify Docker capabilities before reporting Nova Computer available

- Category: improvement, with a bounded compatibility investigation; gap C for readiness language. Severity: Medium. Priority: P2. Confidence: High for this environment, unverified for other rootless hosts.
- Baseline: merged `d948aa0a` and an isolated instance/adapter on this managed Linux Docker 29.9.2 runtime; not the owner preview.
- Affected user: self-hosters with a daemon that answers basic requests but lacks process/cgroup support; Nova announces availability, then work cannot start.
- Reproduction: on this runtime, `DockerComputer.available()` returns `{ok:true, detail:"Docker 29.9.2, with Nova’s computer image."}`; a created synthetic container can execute `id` and access its writable folder, but `docker top <id>` fails because its cgroup path cannot be read. Nova's execution guard then correctly refuses to run work.
- Evidence: `evidence/qa-docker-readiness.json`, `evidence/qa-docker-environment.json`; `src/core/computer/docker.ts:146–153` checks only daemon version and image, while `:231–265` requires process enumeration and refuses when it cannot establish it. This is **not** evidence that Nova's isolation failed. Fail-closed behavior is a strength.
- Root cause: readiness reports daemon/image presence rather than the adapter's required capability set. The cloud environment's underlying cgroup defect is outside Nova; whether other rootless configurations are supported is unverified.
- Smallest coherent change: bounded disposable preflight for required process enumeration, non-root bind access and checkpoint/pause operations, cached by daemon configuration; expose unavailable/degraded capability with the actionable failed operation. Keep all security checks in execution.
- Components: Docker adapter availability, Computer/Health diagnostics, supported-environment documentation. Dependencies/decisions: define the supported rootless/rootful matrix; do not weaken process checks to make a test pass.
- Acceptance criteria: this capability failure is shown before a user starts work; supported Docker completes create/execute/checkpoint/reset; an unavailable daemon/cgroup/proc-list never yields a generic “ready”; Nova's remaining features work without Docker.
- Regression: fake command-level refusal tests plus one supported rootful and one declared-supported rootless integration environment; preserve fail-closed negative controls.
- Effort: 1–2 days investigation and 2–4 days diagnostic/preflight implementation, assuming no new sandbox backend. Status: Open; no runtime repair or daemon restart attempted.

## Three consequential maintenance concerns

These are change-cost risks supported by structure, not defects inferred from file length. Preserve the modular-monolith and SQLite design while reducing the costly seams.

1. **Runtime composition and lifecycle are concentrated across a typed core and an unchecked runner/server boundary.** `src/core/index.ts` has 1,928 lines of composition, routes, recovery, heartbeat and shutdown; `src/server.js:111–145` injects capabilities by mutation into the runner. `tsconfig.json:17–22` leaves this JavaScript unchecked. The cost is auditing whether a new service is wired into every privacy, standby, failure and close path. Add explicit typed dependency/lifecycle contracts at that boundary and move composition sections into focused factories when touched; do not rewrite every subsystem. Verify a production-composition test for initialization, degraded startup, promotion/standby and shutdown ownership.
2. **UI request/state ownership is spread through the large shell and subsystem modules.** `ui/js/app.js:1733–1758` launches 14 subsystem operations on entering Settings and has its own touched/view/hash guards; other view modules have separate generation guards (e.g. `ui/js/about.js:25`). This makes stale completion, in-progress edits and recovery behavior expensive to maintain consistently. Standardize the existing HTTP client's lifecycle/abort/generation contract and category-level loading when each surface is repaired; preserve useful state instead of broad rerenders. Test navigate-away/in-flight edit/retry examples, not implementation-shaped mocks.
3. **Capability/release truth is reconstructed from multiple human texts.** README is obsolete (NOVA-040); pipeline states are inferred from evidence titles/ledger wording (`src/core/pipeline.ts:106–120,184–206,218–244`), while release advancement is a separate manual obligation (NOVA-041). A minimal capability/release metadata schema, authoritative only for machine-consumed status, would reduce ambiguity; prose and actual evidence remain linked. Begin with version advancement and currently shipped capability status; do not invent a parallel roadmap system.

## Coverage rows for consolidation

| Surface/workflow | Role/mode | Theme/viewport | State | Result | Evidence |
|---|---|---|---|---|---|
| Baseline CI | repository reader | n/a | exact merged SHA | tested-pass | qa-ci-runs.json; qa-ci-jobs.json |
| Local checks | isolated synthetic homes; no real-model flags | n/a | pinned Node26; managed Docker | tested-fail | qa-check.log; qa-check-summary.json; qa-interrupted-fixture.json |
| Dependency advisories | lockfile reader | n/a | current registry response | tested-pass | qa-npm-audit.json |
| Changelog/agent pointers/JS parse | isolated source reader | n/a | baseline | tested-pass | qa-extra-checks.json |
| Dependency installation | fresh audit-only manifest/lock directory | n/a | blank node_modules; existing Node26 | tested-pass | qa-install-summary.json; qa-install.log |
| Home navigation reachability | synthetic console person; no real models | phone390/rail1440; baseline theme | all14 registered views, safe GET crawl | tested-pass | qa-ui-check.log; qa-ui/navigation/phone-report.json and rail-report.json |
| Settings | synthetic console person | Nebula dark/light; desktop/tablet/phone/Duo width | search, keyboard shortcut, back, category reachability,44px targets | tested-pass | qa-ui-check.log; qa-ui screenshots |
| Offline/reconnect | synthetic console person | desktop1280 | two server outages, cached view, restart, late response | tested-pass | qa-ui-check.log; qa-ui/offline-server-down.png |
| Fold state/hinge/text | synthetic console person | browser-emulated fold/postures,200%text | drafts/scroll/settings focus, hinge avoidance, enlarged text | tested-pass | qa-ui-check.log; qa-m9-shots |
| Prose width with optional pane | synthetic console person | Chromium155;840px viewport | right pane expanded | tested-fail | qa-ui-check.log; qa-prose-width.json; qa-prose-840.png |
| Nova Computer | synthetic isolated workspaces | managed rootless Docker29.9.2 | create passes; required process listing fails | blocked for full behavior | qa-docker-environment.json; qa-docker-readiness.json |
| Physical-phone pairing | real person/device | physical phone | enrollment/revoke/passkey | blocked | No physical phone or owner machine access; browser emulation is separate |
| Owner watcher and deployment | owner host | preview :4318 | version vs latest | blocked | Parent's baseline connection probe; watcher unavailable |
| Research Part3 | local real model | n/a | A/B/golden eval | blocked | Explicit owner decision; no eval run; current committed failed verdicts inspected |
| Pipeline dashboard | source inspection only | n/a | implemented route/data assembly | untested (runtime delegated to parent) | ui/js/about.js; src/core/pipeline.ts |

## Continuation checkpoint

This sub-review's commands are finished. Product tracked files are unchanged. The18 screenshot files generated by M9 were copied into audit evidence and restored to their exact baseline; only this run's leftover M10a disposable container was removed (`evidence/qa-fixture-cleanup.json`). Pre-existing containers/images/homes were left alone.

Remaining audit coverage requires the correct owner machine or a supported environment: read-only compare preview Health/About and `/api/v1/version` to the selected merged commit and watcher log; run the Docker/supervisor failures on a host with working cgroup process enumeration, pause and a reaping init; inspect the optional-right-pane42ch measurement in the supported browser matrix before choosing a product change. Real-phone pairing/installed PWA/platform passkeys require physical-device evidence. Research Part3 stays a separate owner decision; do not run its evals. Root should merge overlapping documentation/accessibility findings and preserve the final failure qualifications when consolidating.
