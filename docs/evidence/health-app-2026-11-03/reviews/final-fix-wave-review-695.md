# Scoped final fix-wave review — Health #285

Range: `6ea82d7b211375dc390aed44bb2f53fed4f51500..69566bfe7013947c882d3f36eb8c8fdfcfa8bf14` (three commits).

**Technical verdict: APPROVED with nonblocking Minors. Original I1: ADDRESSED. Open counts: 0 Critical, 0 Important, 2 Minor (one retained, one new documentation finding).** Ordinary exact-head hosted CI, matching merge and authorized preview remain required Root release gates. This report does not claim those gates passed.

## Original I1 — addressed

The corrected capture at `tests/ui/health-caps-diagnostics.test.ts:514` includes the containing panel, then performs native heading/action scrolling and stability checks before one full-viewport screenshot. The assertion at `:524`, using `tests/ui/health-diagnostics-visual.ts:5`, rejects out-of-scroller, occluded or unpainted title/disclosure/action targets. It does not retry screenshots until green, mask/crop the image, replace DOM, override CSS, flatten the fold or introduce sleeps/timeouts.

The retained initial RED reproduces the old phone image byte-for-byte and rejects the actual zero-ink disclosure/action plus clipped heading. The two same-page probes distinguish the initial missing raster text from later painted text and demonstrate that old component-start framing clips the containing heading. That supports a bounded capture-path correction; it does not identify an engine/compositor root cause or prove a production download failure.

I manually viewed these four public images and compared them on their merits:

- `docs/screenshots/health-caps-diagnostics-2026-11-03/app/final-wave/chromium/app-diagnostics-download-phone.png`
- `docs/screenshots/health-caps-diagnostics-2026-11-03/app/fix-1/chromium/styleguide-diagnostics-phone.png`
- `docs/screenshots/health-caps-diagnostics-2026-11-03/app/final-wave/chromium/app-diagnostics-download-halfopen.png`
- `docs/screenshots/health-caps-diagnostics-2026-11-03/app/fix-1/chromium/styleguide-diagnostics-halfopen.png`

The app now displays the title, privacy copy, disclosure and native action clearly. Phone navigation remains present; half-open retains its real 285.5-pixel main scroller and separate lower pane. Component content and treatment match the approved specimens despite different host widths and wrapping. The phone and half-open app hashes are respectively `cda96136d9b0a67ad28f53a974b059a350d89e582437ab43005057bd721c0b61` and `a73c8d3683bfc5212a74ade4e74455997e61d921afe0ba94e0547d3259122caa`. Original bad witnesses remain unchanged. Native functional-download credit is retained.

The matrix accurately distinguishes four current-run entries (two new app images, two byte-identical reused specimens) from thirty-six historical entries on unchanged production UI/styles. The additional dedicated capture verification executes all eight engine/posture raster branches and passes all twenty-four targets. This is adequate to close the specific visual qualification finding; it is not universal legibility or device certification.

## CI checkout change — approved

`.github/workflows/ci.yml:27` changes only the changes-job fetch depth from zero to two. The classifier, other checkouts/jobs, deadlines and required gate are byte-unchanged. `tests/ci-changes.test.js:50` and `:58` use actual workflow depth and shell with real private local Git merge repositories: first-parent source change selects heavy/computer; known-parent documentation selects docs-only; absent older push BEFORE selects the existing fail-closed heavy fallback.

The RED/GREEN outputs establish meaningful shallow-history behavior rather than a mocked file-list assertion. Missing older push history can cost extra heavy runs, but does not silently skip required source/UI qualification. The computer flag controls eager image pulling, not exclusion of computer tests. Local fixtures cannot establish hosted checkout duration; ordinary hosted CI remains mandatory.

## Findings

### Critical / Important

No open Critical or Important finding. No new blocking source or test regression found in this delta.

### Minor

**M1 — retained: Node localStorage warning noise.** `docs/evidence/health-app-2026-11-03/final-wave-static-qualified/stdout.txt:5` and `:12` retain the same nonblocking environment warning. Root Ruling 27 explicitly defers it to a future isolated-bootstrap change. This wave correctly neither suppresses stderr nor rewrites historical output; the original finding remains open, not silently closed.

**M2 — new: documentation calls dedicated raster verification “default-CI” coverage.** `docs/evidence/health-app-2026-11-03/delivery.md:14` says the extra run closes “default-CI capture branches.” However, `tests/ui/health-caps-diagnostics.test.ts:143` enables captures only with `NOVA_HEALTH_APP_SHOTS`; the new check is inside that artifact block at `:509`. Ordinary `.github/workflows/ci.yml:104` supplies only `NOVA_UI_SHOTS`. Thus ordinary CI runs the functional Health cases but does not automatically execute this raster gate. The twenty-four dedicated target checks are valid; the CI description is inaccurate and could mislead future maintainers about ongoing coverage. Correct the documentation/PR language to distinguish dedicated Health capture qualification from ordinary functional/crawl CI. No additional source change or rerun is needed just to correct that statement. Root acknowledged this finding during review and plans a documentation-only correction plus fresh exact-head CI; that prospective correction is not credited as already present at `69566bfe`.

## Scope and verification

This is the requested single scoped re-review of I1, the new checkout policy and fix-introduced breakage, not a repeated whole-PR audit. I read the dispatches, original task brief/review, complete appended combined-wave and post-wave report sections, all changed source/tooling, archived RED/probe source deltas, all eight new raw stdout files, changed explanatory documentation, and all eleven Root dispositions. I inspected the unchanged workflow/classifier, PNG decoder, browser context/settling helper and capture initialization only for concrete new risks.

I independently performed read-only artifact checks:

- The 538,157-byte package contains the exact unmodified `git diff -U10` for this range. Package SHA-256: `89ef4c9f65bc5fcc4fa3762279ffae77e838f4777f5c0f410f22174e381f6f6f`. All thirty-eight changed JSON documents parse. Repeated metadata was structurally/hash checked rather than manually rereading every duplicated scalar.
- Production `ui/`, `src/`, dependencies and classifier are unchanged; the workflow is exactly the single depth replacement. All thirty-one current source-manifest hashes/blob identities match. The archived prior manifest is byte-exact. Final qualified/static/additional-run source hashes match current bytes; earlier CI and visual variants match their respective base/archived source, rather than being misrepresented as final source.
- All eight command/stdout hash records, command displays, recorded exit codes, isolation flags, source-commit/runner hashes, zero-byte egress records and absent-container cleanup records verify. I read every line of those eight stdout files; no runtime tests were rerun by this reviewer.
- All forty public matrix entries match their recorded dimensions, lengths, hashes and corresponding raw capture bytes; their current/historical flags yield four/thirty-six. All 818 PNGs tracked at the review base remain byte-identical. All thirty-four new private intermediate/verification PNGs match their manifests and exact image-only ignore entries. All eight additional raster audits verify three in-bounds, hit-testable targets with sufficient recorded ink and no failures.
- The public implementation report is complete after normalizing its evidence-link targets; the published original final review is byte-identical. The thirty-eight immutable whole-PR whitespace artifact hashes verify. A targeted changed-source/tooling diff check passes; I make no universal raw-artifact whitespace-clean claim.

My first mechanical comparisons assumed default Git context, final UI bytes for the earlier CI-only run, and unanchored ignore paths. Those assumptions were corrected against the explicit ten-line diff context, per-run source timing and anchored ignore syntax; they were reviewer-script errors, not evidence defects.

Reviewed recorded results: CI fixtures 2/2, focal static 20/20 plus syntax/compiler exit zero, corrected-witness browser run 2/2 across eight functional cases, and the additional eight-case/24-target capture run 2/2. Existing entry-spend, partial-Caps/live-Core, mutation/draft/caret/SSE, native attachment and installed Chromium-worker controls remain in source and these outputs. I did not independently rerun them or inspect all sixteen additional private images visually; the manual visual scope is the four public images listed above.

## Declined-to-judge behavior and residual limits

All eleven exclusions in the original whole review remain explicitly accounted for by `docs/evidence/health-app-2026-11-03/reviews/root-final-dispositions.md`: broader provider/node billing; universal free-text privacy/integrity scrub; physical devices/IME/installed WebKit; repeated-reload WebKit root cause; later Stage 2/refactors; a whole unchanged-backend/real-identity audit; exhaustive rollover/auth/cache permutations; whole-app accessibility/theme cleanup; retrospective missing start hashes; fresh F0/all-historical rerenders; and hosted CI/merge/preview. Their stated reasons and limits remain valid; none is silently converted to a pass. The last category is an active release requirement, not waived scope.

Additional scoped limits: five foreground pixels plus geometry/hit testing detect this observed blank/obscured witness, not every possible text defect; the engine-level initial-paint cause remains unproven; dedicated raster execution is not an always-on ordinary CI gate; local shallow Git fixtures do not certify network checkout time. I found no reason to expand this review into a new production redesign or second source fix wave.

## Assessment

**Ready for the next release gates: Yes.** I1 is addressed and the new checkout policy preserves qualification semantics. Correct the nonblocking M2 wording, retain deferred M1 and all stated limits, then require ordinary CI on the resulting exact head and the matching merge/preview. Approval applies to this reviewed technical delta, not to unrun release actions.

**RELEASE:** Scoped review complete; checkout relinquished. Only this report was written. No source/Git mutation, test rerun, subagent or live process was created or left by this review.
