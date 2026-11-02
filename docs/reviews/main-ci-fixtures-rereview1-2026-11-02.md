Scoped spec compliance: PASS (`specPass: true`). Scoped fix quality: Approved (`qualityApproved: true`). Original Important 1 is addressed. Full Task 1 affected UI gate remains BLOCKED (`fullGateApproved: false`) by the retained screenshot failure; this is not a full task/branch approval.

Scope: only Important 1 (CSS installation versus metadata), its fix and new breakage from `f98c5e0b7ef95421d6cc08b6a602e3f063bd6714` to `ad3f0f9b5241bd9c907c5db390fab54eade1897e`. Read the supplied complete three-file diff (82 additions, four deletions), fix brief, implementation report append and actual fix logs. No initial full re-review, changed-file reread, broader code crawl, probe, suite, Git command, source mutation or subagent was performed. This requested ignored review report is the only write.

## Spec compliance and strengths

- Important 1 is closed: `tests/ui/fold-navigation.ts:63–76` waits for intended metadata, requests the real device-specific CSS, checks HTTP 200 and the intended design in its generated header, then requires the matching device identity and complete CSS text in the actual `#ds`, an enabled parsed nonempty stylesheet, and removal of `#ds-boot`. Two animation frames plus finite-animation completion follow installation. Metadata alone cannot satisfy this boundary. The helper reads expected CSS; it does not install CSS or call production swap/event functions.
- `tests/ui/fold-postures.test.ts:118` invokes that boundary before each design/view width sweep, and line 144 invokes it for the existing live swap. The real apply API/event route remains responsible for installing the CSS. Six designs, all widths/views, both engines, live-swap band assertion and existing error assertions remain in place. No production/auth/CORS change, test switch, error filter, tolerance change or baseline update appears in the delta.
- `tests/ui/fold-navigation.test.ts:68–126` adds a real held-response regression in each engine. It fetches and holds the production CSS response unchanged, permits actual apply-event metadata to complete, calls the actual shared boundary, verifies that it remains pending and the prior design is painted, then releases delivery and verifies exact installed bytes and actual rendered card radius against the intended manifest. The gate is released and owned delivery/readiness/browser/server cleanup is awaited in `finally`.
- The original real navigation/playbook and genuine CORS/403 controls are unchanged apart from imports (`tests/ui/fold-navigation.test.ts:1–65`). New fixture helpers and checks are test-owned and limited to the requested seam.

## Issues

### Critical

None.

### Important

No new code finding in this scoped delta. The separate failed covering check below remains a blocking validation result and is not waived by scoped approval.

### Minor

None.

## Retained covering blocker

1. `task-1-fix1-fold-green.log:388,407,439–460`: Chromium duo-cover `/chat` differs by 2.27% against the unchanged 2% limit. The covering command exits 1 with seven passes, one failure and zero skips (`:427–435,460`); 19 of 20 baseline comparisons pass. Full affected-gate approval must remain blocked pending diagnosis and resolution. Keep the baseline, threshold and failure evidence intact.

The code delta does not establish this failure's cause. The new CSS boundary is called only by design-band/live-swap checks; the baseline test and its navigation/readiness path are not changed in this fix diff. New regression contexts use fixture-owned profiles and device-scoped design application, not shared baseline devices. Thus there is no direct changed screenshot path or demonstrated state contamination explaining the mismatch, but a passed focused run and absence of a direct path are not proof that the screenshot failure is harmless or unrelated. The report's image description (`task-1-report.md:78`) remains an implementer observation; image/cause diagnosis is separately owned by the controller and was not duplicated here.

## Evidence checked

- `task-1-fix1-red.log:2–5,15–59`: the two original controls pass; both engine cases fail at the precise held-CSS assertion with `early` versus `held`, exit 1. This reproduces the reviewed metadata race with the actual helper and real browser/CSS response.
- `task-1-fix1-focused-green.log:2–17`: all four cases pass, zero failures/skips, exit 0, including exact installed bytes/rendered radius and unchanged genuine-error controls.
- `task-1-fix1-fold-green.log:2–5,370–386`: all four focused cases, 364 posture/view audits, the actual CSS-bound six-design/all-width sweep and both live swaps pass. Safe-area passes at line 426. These are actual observed passes, alongside—not in place of—the failed screenshot gate.
- `task-1-fix1-typecheck.log:1–4` and `task-1-fix1-diff-check.log:1–2`: exit 0.
- `task-1-fix1-final-self-check.log:1–16`: retained implementer commands record exact new HEAD and preserved parent, clean worktree, source-only three-file scope, diff check and no tracked baseline difference, exit 0. No Git check was repeated by this reviewer.
- The implementation report correctly supersedes its earlier all-design proof claim (`task-1-report.md:53–55`) and explicitly reports the covering run as RED (`:74–86`). Prior runs retain their actual outcomes; no full UI/public CI success is inferred. Original CI event ordering remains an inference.

## Assessment

Approve the narrow CSS boundary fix and close original Important 1. Zero new Critical/Important/Minor code findings. Keep the overall Task 1 covering gate blocked on the recorded Chromium duo-cover Chat screenshot failure; this scoped approval does not certify the full task, baseline gate or whole branch. No suite rerun is recommended merely to seek a passing screenshot; diagnose the retained image failure first, as the controller is doing.
