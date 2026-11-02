# Task 1 independent spec and quality review

Reviewed source range `6d0a74a58a3a20df7f3718b2ade2413c1ba84e8a..7c8724965a34428b5267de3070d5e94895772956` in `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`. This is the Task 1 source review, not the later inventory/claims sweep or final whole-branch review. The root controller's uncommitted documentation was excluded. No tests were rerun and no production files were changed.

## Verdicts

- **Spec: PASS for Task 1 implementation and supplied focused evidence.** The requested Home, Settings Devices, and ordinary Capture homes exist; the required phone/rail rendered gate uses the actual production registration and fails on a future orphan. Ordinary exact-head public CI remains an integration condition, not a completed local result.
- **Quality: APPROVE WITH ONE MINOR FINDING.** No critical or important source issue found within this task's scope. The reload assertion described below overstates what it measures.

## Findings

### C — Critical

None.

### I — Important

None.

### M1 — Navigation-timing count does not detect a document reload

`tests/ui/navigation-reachability.test.ts:191` asserts that `performance.getEntriesByType('navigation').length === 1` means the router retained the document. A full document navigation starts a fresh performance timeline, which ordinarily also has one navigation entry. A future link-handler regression could reload between actual clicks while this assertion still passes. The current source's `inApp`/`followLink` handling (`ui/js/app.js:809–824`) supports in-app navigation, and the test itself has only the initial `goto`, so this does not invalidate the current reachability result. It does mean the report's claimed zero post-Home document reloads is not independently established by that assertion. Track main-frame document navigation requests after initial Home, or preserve an in-document boot marker and compare it after each press; use that evidence before claiming zero reloads.

## Verified requirements and evidence

- `ui/js/components.js:283` changes the existing Devices card action to **Machines and services** at `/topology`. `ui/js/surfaces.js:704` adds the same visible link inside Devices with target `devices-topology`. The final phone and rail JSON reports show actual required-door clicks from Home and Settings Devices using those sections.
- `ui/js/settings-ia.js:15` registers Capture as its own ordinary category, places it beside Devices in the existing group, and moves the existing Capture part out of Privacy. The existing app category/part renderer (`ui/js/app.js:1668–1704`) renders the same Capture implementation. The independent Capture-category paths in both final reports proceed from ordinary Settings navigation to Capture and then Open Capture.
- `ui/js/app.js:279` contains the actual 11-entry `VIEWS` registry; `tests/support/navigation-registry.js:4–10` reads that literal and fails closed on unsupported shape. The rendered gate obtains expected IDs from it (`tests/ui/navigation-reachability.test.ts:63`), observes actual `body[data-view]` after normal clicks/taps, and asserts no missing registration (`:193`). `DESTINATIONS` and `reachable()` are supplemental unit coverage, not the rendered oracle.
- The gate uses one initial Home `goto` per layout, then `press()` (`tests/ui/navigation-reachability.test.ts:43–54`) performs visible ordinary clicks/taps, including replay via Home. The browser route guard blocks non-GET and cross-origin requests. The existing `blank()` fixture (`tests/acceptance/support.ts:57–77`) supplies isolated temporary HOME/NOVA_HOME, file vault, and egress guard; the new fixture uses a fake agent and synthetic session. No owner data, form input/submission, capture start, or service action was found in the gate. Required-door checks and clicks are separate from broad view coverage.
- Normal `npm run test:ui` discovers `tests/ui/*.test.ts` (`package.json:21`); `.github/workflows/ci.yml:102` invokes it, and the required aggregate gate checks that UI result (`:127–142`). No optional-only test path was introduced.
- Read `red.log`, `red/{phone,rail}-report.json`, `red-final-harness.log`, `red-final/{phone,rail}-report.json`, `green.log`, `green/{phone,rail}-report.json`, `orphan.log`, and `orphan/{phone,rail}-report.json`. Original baseline: 11/11 reached in both layouts, no missing view, all three required homes false, real `healthMesh=true`. Final source: 11/11 reached, all three homes true, 26 states each, empty forbidden-request lists, and actual `/new`, synthetic `/c/:id`, and `/schedules` paths. Controlled orphan: 12 registered, 11 reached, only `orphaned` missing, all requested homes still true.
- Baseline reports preserve the actual legacy Health and Settings Services topology links and Privacy's Open Capture link. Baseline broad reachability was not falsely reported as nine views or as a missing Topology view.
- Inspected the controlled mutation in `orphan-probe.test.ts:14–19,81–91`: it supplies an additional real `VIEWS` entry, route registration, and hidden DOM view without a navigation door. The experiment uses an earlier form of the harness, separately retained, and fails at the same missing-view assertion. The committed oracle unit check independently adds a registration as well.
- Independently verified all 10 final source SHA-256 values against actual files and all six baseline module/index SHA-256 values against `git show` at the baseline pin. The baseline module overlays match exact pinned bytes. Git's source diff contains only the 10 declared navigation, Settings, and covering-test files; no dependency/runtime/auth/baseline/threshold/mask change is in the source commit.
- Raw validation summaries corroborate focused 52/52 unit pass, canonical 2/2 rendered pass, isolated ordinary-runner 43/43 pass, and final original-baseline 1/1 pass. Typecheck/token logs contain successful commands. The report preserves the initial layout-baseline failure and later passing final placement rather than regenerating baselines.

## Cannot verify / integration conditions

- **Ordinary exact-head `npm test` and full `npm run test:ui` success are pending.** The ordinary local npm attempt ended 143 after the fresh-user child stalled. The bounded full run reports 1626 tests, 1607 pass, 5 fail, and 14 skips. Four failures plus fresh-user/Capture passed in the isolated 43-test ordinary-runner check; the fifth stale Capture search expectation was fixed and covered by the 52-test pass. Those reruns do not prove a full ordinary suite pass or establish the root cause of the original failures.
- Original RED raw logs plus the retained source pin and exact baseline-byte recheck support the pre-change RED account. They do not constitute an independently observed chronology or a signed execution record; this review did not rerun that history.
- The fixture and reports establish navigation in the neutral test environment. They do not establish every effectful feature, conditional owner-data state, physical iPhone behavior, or final owner design approval. Those limits are explicit in the implementation report.
- The source and focused evidence meet this task's scope; root's Task 2 claims sweep and final exact-head required CI/whole-branch review remain outside this verdict.

Review complete; source ownership remains with the root controller.
