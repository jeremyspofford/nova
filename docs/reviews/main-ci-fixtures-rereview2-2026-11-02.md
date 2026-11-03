Scoped spec compliance: PASS (`specPass: true`). Scoped quality: Approved (`qualityApproved: true`). I2 and I3 are addressed; zero new Critical, Important or Minor findings. The affected local gate is GREEN (9/9, 364 audits, 20 unchanged baselines). Full public CI and whole-branch approval remain pending controller work.

Reviewed only I2 (scheduled Chat rendering), I3 (detached card style read), and direct new breakage in the supplied complete package `ad3f0f9b5241bd9c907c5db390fab54eade1897e..5771cdd8df18ab9c36bb0f2973c188afe2446806`: two preserved follow-up commits, three assigned test/helper files, 135 additions / seven deletions. I1's CSS installation guard remains closed and unchanged. Read the scoped fix brief and actual report append/logs; no original full re-review or broad crawl.

## Spec compliance and strengths

- I2 addressed: `tests/ui/fold-navigation.ts:32` excludes an active Chat `#thread.no-anim` marker from readiness. The following Chat-only two-frame checkpoint lets style/animation registration occur before the existing finite-animation drain. It waits for the actual pending callback instead of inferring readiness from opacity, DOM content or the current animation list. The real route/data checks and I1 guard remain intact; no sleep, production animation override or ignored readiness failure is introduced.
- The new real-browser regression (`tests/ui/fold-render.test.ts:30`) holds only the real callback that removes `el.thread`'s `no-anim`, asserts a genuine single interception, populated intended content, marker/opacity/current-animation state, and invokes the committed `openFoldView`. It proves the helper remains pending, releases the actual callback, awaits navigation, then verifies the existing baseline comparison, actual visible content and empty genuine error collector. The original screenshot masks/channel threshold/2% tolerance are retained (`:18–27,72–80`); held callbacks are released, the frame method restored, navigation awaited and owned browser/server closed in `finally` (`:81–85`).
- I3 addressed: `tests/ui/fold-navigation.ts:82` queries the current Home card, requires connection, and reads its computed radius in one synchronous browser evaluation. There is no asynchronous ElementHandle gap, empty-value fallback, retry, sleep, timeout increase or style mutation.
- The strengthened both-engine held-CSS regression (`tests/ui/fold-navigation.test.ts:69`) forces a real task event/production rerender while the measurement operation is held. It strictly proves old detached node/empty old radius versus current connected node/12px radius, then demands that the actual atomic reader returns the unchanged previous radius. Exact installed-CSS and intended-manifest radius assertions remain strict after CSS delivery. The local locator-instance wrapper is restored and all gates/pending work released/awaited in `finally`; neither the library nor a prototype is modified. The already-approved I1 generation/install boundary is not weakened.
- This is the authorized I2+I3 scope. The diff introduces no production code, auth/CORS relaxation, error filter, new skip, raised timeout, mask/tolerance/baseline change or unrelated feature. The real navigation/playbook and genuine CORS/403 controls remain unchanged.

## Issues

### Critical

None.

### Important

None.

### Minor

None.

## Focused evidence and checks

- Named risk — whether the pending marker corresponds to a real future animation boundary: focused unchanged `ui/js/app.js:432–441` rebuilds the thread, applies `no-anim`, schedules the removal and adds `view-enter`; `ui/styles/views.css:733` disables animations while marked, and `ui/styles/components.css:838–842` defines the opacity-zero entrance. The new predicate/checkpoint/finite-animation sequence matches that actual boundary.
- Named risk — whether I3's test truly holds the real resolved-handle gap without a library patch: focused unchanged installed `node_modules/playwright-core/lib/client/locator.js:58–71,100–101` confirms `_withElement` resolves a real ElementHandle before invoking the supplied task and `Locator.evaluate` delegates to that handle. The test wraps one local instance and restores its original method, while the new reader evaluates a fresh DOM query atomically. The real core task refresh/render contract was already established in the original scoped review; no repeated production crawl was needed.
- Named risk — screenshot comparison strength: focused unchanged `tests/ui/fold-postures.test.ts:176–189,198–208` matches the new test's exact mask, channel threshold48, 2% share, fixed date and screenshot options. No baseline was generated or changed by this review.
- `task-1-fix2-red.log:2–33`: old actual helper resolves `early`, generates share0.02268421052631579 and fails the intended pending-callback assertion, exit1. The retained PNG is byte-identical to the original failed covering PNG: independent read-only `sha256sum` on the original retained artifact, diagnostic held-frame artifact and new RED `fold-frame-early.png` gives `be1d613e0c588c3362e8446752c0b4f43b544cee3bea0ca623877007349b1900` for all three; `cmp` between original and new RED exits0. The final held-frame PNG hashes to `13a0a496f301f5233ba969680c69622e943880583515cb8feec186d60aa32eb5`.
- `task-1-fix2-card-diagnosis.log:2–15`: real WebKit task rerender detaches the old12px card; its style becomes empty while the current connected card remains12px, with the intended Nova metadata already present; one pass, exit0. `task-1-fix2-i3-red.log:4–7,17–59` retains the same real detached/current evidence and both engines' precise empty-string-versus12px failures under the legacy measurement, exit1; the original navigation/error controls pass.
- `task-1-fix2-i3-focused-green.log:2–22`: final source passes all five focused cases, including real detached/current-node controls in both engines, exact installed CSS/rendered manifest assertions, the held-render regression and genuine-error controls; zero failures/skips, exit0. The controlled settled PNG share is0.0039795321637426904.
- `task-1-fix2-i3-fold-green.log:2–7,372–441`: exact final-source covering run passes all9 tests with zero failures/skips, exit0. It records all364 audits, six designs in both engines and both live swaps (`:374–387`), all20 unchanged baseline comparisons (`:389–408`; Chromium duo-cover Chat0.4%), safe area (`:428`), and the held-render PNG/share (`:429–430`). This is actual affected-gate evidence, not a full public-CI result.
- `task-1-fix2-i3-typecheck.log:1–4` and `task-1-fix2-i3-diff-check.log:1–2` record exit0. `task-1-fix2-i3-commit.log:1–5` records the preserved I3 follow-up. `task-1-fix2-final-self-check.log:1–14` records exact HEAD5771cdd8/parent801c1a62, clean worktree, assigned three-file package, unchanged I1 guard and tracked baselines, exit0. These are retained implementer command results; this review did not repeat Git commands or suites.

## Limits and retained failures

The prior7/8 screenshot failure and the subsequent8/9 empty-radius failure remain failed evidence (`task-1-fix1-fold-green.log`, `task-1-fix2-fold-green.log:441–458`). They have controlled reproductions and justified source repairs, rather than a retry or waiver. The final run's passes do not erase them.

The exact I2 byte reproduction and I3 detached-handle control demonstrate sufficient causal orderings. Neither recovers an event/frame trace from the earlier failed covering run. The original CI41396575075 refresh ordering remains inferred, and earlier aborted-run/overwritten-typecheck-log caveats remain retained. No universal production lifecycle correctness, failure-rate estimate or full public-CI success is claimed.

No tests, browsers, public gates, real resources, credentials, other worktree operations, subagents, Git commands or source/index/HEAD mutations were performed by this review. Read-only targeted source/log/artifact inspection and hash/byte comparison were sufficient; this requested ignored report is the sole write. No additional suite rerun is warranted by this scoped review.

## Assessment

Approve I2 and I3; zero new findings. The previous local affected-gate blocker is resolved by the retained final9/9 run with unchanged20 baselines. Proceed to the controller's separate whole-branch/public-CI gate without treating this scoped review as overall approval.
