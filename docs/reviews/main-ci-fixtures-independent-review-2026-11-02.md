Spec compliance: FAIL (`specPass: false`). Task quality: Needs fixes (`qualityApproved: false`).

Reviewed Task 1 only: base `aacb78aac281989f35f00f374b1084cbbe2be330`, head `f98c5e0b7ef95421d6cc08b6a602e3f063bd6714`, supplied complete four-file diff (171 insertions, 15 deletions). One Important finding; zero Critical and zero Minor findings.

## Spec compliance

- The vault fix correctly awaits the existing returned promise and preserves every original secrecy/history assertion (`tests/core/vault.test.ts:263–279`). The new fixture-held real Git commit verifies pending completion, independent `ensureGit`, release/await, and actual history (`tests/core/vault.test.ts:234–256`). No production Git/vault/broker change appears in the diff.
- The fold helper uses an initial full load and then actual app navigation links, including Settings > Privacy > Capture; it rejects crossing origins (`tests/ui/fold-navigation.ts:37–58`). Intended URL/body view, visible seeded content or authoritative empty state, initial loaded health and seeded task data, no skeleton/waiting state, and finite animation completion are checked (`tests/ui/fold-navigation.ts:5–34`).
- The existing 184 posture/view/short-landscape audits remain; 180 fresh-context direct-load audits cover all nine routes at all ten postures in both engines (`tests/ui/fold-postures.test.ts:50–96`; unchanged route/posture definitions `tests/ui/axe-support.ts:14–26`). Error assertions are strengthened in short-landscape, design bands, baselines and safe-area contexts. Layout, right-column, safe-area and screenshot assertions are preserved in the supplied diff. There are no production auth/CORS changes, new filters/skips, swallowed readiness failures, timeout increases, or baseline updates in the diff.
- The real-browser regression invokes the actual shared helper, arms the diagnostic pagehide/actual `surfaces.load` hazard, dispatches the real production playbook listener, verifies completed responses, unchanged document and actual Tasks content, and retains the combined error collector (`tests/ui/fold-navigation.test.ts:10–40`). The separate CORS/403 negative control checks that collector (`tests/ui/fold-navigation.test.ts:43–65`).
- The all-design/all-width requirement is not fully synchronized: see Important 1.
- Limit: historical ordering in original CI run `41396575075` remains an inference, not a captured event trace. The report correctly states this (`task-1-report.md:7–11`), and diagnosis explicitly distinguishes exact controlled reproduction from historical attribution (`diagnosis.md:35–44,60–62`). No whole-branch/full-public-CI success is established by this task gate.

## Strengths

- The Git regression controls a real completion boundary rather than relying on elapsed time, and releases and awaits the held commit in `finally` (`tests/core/vault.test.ts:244–254`).
- The helper is small, test-owned, and checks actual rendered fixture content alongside the intended route; loaded task/health guards address the aside's initially empty cards (`tests/ui/fold-navigation.ts:16–34`; production load/render contract `ui/js/surfaces.js:32–70`, `ui/js/app.js:323–345`).
- The negative control tests genuine browser CORS reporting and a genuinely refused mutation; no error filtering or production relaxation is introduced (`tests/ui/fold-navigation.test.ts:43–65`; unchanged collector `tests/ui/support.ts:59–66`).

## Issues

### Critical

None.

### Important

1. `tests/ui/fold-postures.test.ts:118`: waiting for `document.documentElement.dataset.theme === id` does not wait for that design's CSS to be installed. Production `ui/js/theme.js:80` launches `swap()` and `refresh()` independently. `refresh()` writes `data-theme` at line 43 after API replies, while `swap()` separately awaits `/design-system.css` and its body before replacing `#ds` at lines 22–25. With the new same-document sweep, the metadata request can win and the first width(s) of a design can be measured using the previous design's CSS. The layout assertions derive expectations from whatever CSS is currently installed, so those measurements can pass under the wrong design and the intended design may miss its earliest widths entirely. This violates the explicit requirement to preserve correct design-apply behavior and makes the claimed every-design/every-width gate timing-dependent. Add a test-owned boundary that awaits installation of the CSS returned for the just-applied design before auditing (not metadata alone or a fixed delay); retain the actual production apply/event behavior. Validate with a focused regression that deliberately holds the owned design CSS response while metadata completes, proves the audit cannot proceed early, then releases it and checks the applied CSS. Existing final logs do not exercise this ordering.

### Minor

None.

## Evidence checked and limits

- Read the supplied task brief, implementation report, reviewer template, package manifest and complete diff. Initial combined tool output truncated the beginning of the diff and latter report text; only those cut-off portions were fetched again. No changed source file was reread separately. No Git command, suite, browser, cloud command, credential operation or subagent was run by this review.
- Named risk — returned Git completion contract: focused inspection of unchanged `src/home.js:104–134` confirms `ensureGit` is independent and `commitHome` returns its queued promise. Read `task-1-vault-red.ts` to verify the retained RED uses a fixture-owned real Git gate and releases/awaits it. `task-1-vault-red.log:6–23` retains the missing `/a turn/` failure with seed-only history and exit 1; `task-1-vault-green.log:10–24` records the real promise test and secrecy test passing, 11 passes / zero failures / one existing environmental secret-tool skip, exit 0.
- Named risk — true routing/data/aside readiness and refresh causality: focused unchanged application checks at `ui/js/app.js:270–355,1859–1874,2106–2125`, `ui/js/surfaces.js:17–70,139–142`, and shared stream/collector contracts confirm the helper operates the real route/render path, the original layout-ready marker precedes core completion, and the playbook event schedules real resilience/problems loads. Diagnosis was consulted for the named causality distinction, not used as proof of original CI timing.
- Named risk — preserving design apply after replacing full loads with SPA links: focused unchanged `ui/js/theme.js:20–44,72–80` establishes Important 1. No additional probe was needed because the two independent asynchronous completion paths are explicit in code. Recommend the focused delayed-CSS test described above; do not repeat the whole suite merely to reproduce scheduling luck.
- `task-1-navigation-red.log:1–38` records the exact resilience/problems access-control messages, one failed regression, passing genuine-error control, exit 1. `task-1-fold-final.log:1–3` records both focused browser cases passing for final source. Its matrix summary at line 368 and totals at lines 424–435 record 364 combinations, six passed, zero failures/skips and exit 0; lines 370–383 cover six designs and both live swaps, lines 385–404 contain 20 baseline comparisons, and lines 406–423 contain safe-area observations. These observed passes do not close Important 1.
- `task-1-typecheck-final.log:1–4` and `task-1-diff-check.log:1–2` record exit 0. `task-1-commit.log:1–6` records the four-file source commit. `task-1-final-self-check.log:1–12` records the cited HEAD, clean source worktree, correct source scope and no baseline diff, exit 0; these are retained implementer command results, not independently repeated Git checks.
- Retained intermediate noise is disclosed: `task-1-fold-green-attempt1.log:12–16` contains a failed matrix followed by owned-run termination exit 137, consistent with the report's corrected Capture selector explanation (`task-1-report.md:39`). Final source uses the real Privacy entry. Final UI log contains no warning/failure noise; vault's pre-existing unavailable desktop-keychain skip is the sole final environmental skip. The initial corrected TypeScript failure is disclosed in the report but its original log was overwritten (`task-1-report.md:29`); no hidden passing claim is inferred from it.

## Assessment

Task quality: Needs fixes. The actual vault and navigation synchronization repairs are well scoped and supported by retained RED/GREEN evidence, but the SPA conversion leaves the design CSS application boundary unguarded. Resolve Important 1 before recording this task gate as approved; whole-branch final checks remain the controller's separate responsibility.
