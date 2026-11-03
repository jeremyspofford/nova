# Final whole-PR review — Health #285

Reviewed range: `702ddc4d5ce3ec097f4a4dda7427fb8bc277de25..6ea82d7b211375dc390aed44bb2f53fed4f51500`.

**Verdict: Needs fixes. Counts: 0 Critical, 1 Important, 1 Minor.** The Important finding is a concrete failure of the required visual qualification, not a claim that native Diagnostics download fails. No additional blocking production-code defect was established.

## Strengths

- The implementation uses the existing Core-owned Caps instance, profile timezone, routes, shared renderers and tokens. The actual createNova runner uses that same Caps instance. There is no second configuration system or new transport framework. The UI honestly distinguishes runner usage, conversations, excluded provider-managed reports/other nodes, and estimated/unpriced usage from complete billing.
- Caps editing handles the difficult boundaries deliberately: latest-response ownership, fresh preflight before PUT, stale/unavailable locking, duplicate-save prevention, draft revision preservation, and connected native number inputs during surrounding refreshes. The current tests exercise partial numeric buffers, caret position and an actual press/refresh/release race, rather than merely checking generated HTML.
- Both earlier Important findings are addressed in current source and recorded regressions: true Home entry refreshes spend after a real synthetic conversation, and a Caps-only failure no longer falsely marks the whole Core unreachable. The latter retains actual full-Core-outage coverage and fails closed for editing.
- Diagnostics reuses the person-authorized per-request attachment route. The service worker excludes current and query-string Diagnostics requests from both caching and offline fallback. Migration deletes only old Nova-owned shell caches; the recorded Chromium test installs v14, observes v15 control, preserves an unrelated cache and checks real outage behavior. The copy does not promise universal removal of arbitrary personal free text.
- The evidence preserves failed attempts, warnings and original captures. The current source hashes, command/output indexes, screenshot manifests and lossless review companion are internally consistent. Owner approval preceded application composition; the actual Home phone and rail doors are exercised.

## Issues

### Critical — must fix

None found.

### Important — should fix

**I1 — Current Chromium Diagnostics witnesses do not satisfy the required meaningful app/specimen visual match.**

- **Locations:** `docs/screenshots/health-caps-diagnostics-2026-11-03/app/fix-2/manifest.json:27` (phone) and `:18` (half-open); associated capture at `tests/ui/health-caps-diagnostics.test.ts:506`; qualification claim at `docs/evidence/health-app-2026-11-03/delivery.md:14`.
- **Observed:** The selected phone image, `app/fix-1/chromium/app-diagnostics-download-phone.png`, shows a blank teal Diagnostics panel between the Health header and Checks. The title, disclosure and Download action are absent. Its SHA-256 is `84255a754f4ea63d44d6b5b89124b89ba725391836929e1afd44f1b1a11fd7b3`. The selected half-open image, `app/fix-1/chromium/app-diagnostics-download-halfopen.png`, leaves a large blank/obscured region and partial copy on the right, without a visible Download action. Its SHA-256 is `279fe117fe776ef619befe5cf44ffbe764ecaae076d07f3c3f30c6841f0f6434`. Both exactly match the current fix-2 raw captures; these are not merely stale manifest references. Matching specimens display the complete component. Other sampled Diagnostics engine/posture captures display it correctly.
- **Impact:** The binding plan requires meaningful rendered states and app/specimen matching at phone, desktop, tablet and half-open postures. Hash integrity and successful functional assertions do not establish that a blank or obscured panel meets that visual requirement. The current matrix therefore cannot be accepted as fully qualified.
- **Required correction:** Narrowly diagnose these two capture/rendering cases. If they reveal a production rendering problem, fix it; if they reveal capture readiness/framing problems, correct that path with evidence of the cause. Supply source-linked witnesses showing the intended title, disclosure and native action in the required posture, and inspect them against the approved specimen. Preserve the current bad images and causal evidence. Do not mask the panel, force substitute DOM, weaken assertions or undertake a blanket screenshot refresh.
- **Limit:** I did not reproduce a runtime defect or establish a compositing, scrolling, timing or CSS root cause. The existing native-download functional proof remains credited. The issue is the demonstrated visual qualification gap; it must not be rewritten as either proven broken download or harmless screenshot noise without diagnosis.

### Minor — nice to have

**M1 — Node localStorage warning noise remains in current verification output.**

- **Location:** `docs/evidence/health-app-2026-11-03/fix-2-static-qualified/stdout.txt:3` and `:10`.
- **Observed:** Node 26 emits `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.` This is the still-relevant portion of the previously deferred warning-noise Minor.
- **Impact:** Nonblocking test-environment noise makes unexpected diagnostics harder to spot; it does not invalidate the passing tests or establish a browser/product failure.
- **Recommendation:** Diagnose the isolated test bootstrap when next editing that environment and choose an explicit appropriate setup. Do not suppress all stderr, add blanket warning allowlists, or rewrite historical output. The historical npm update notifier needs no separate release-blocking fix or rerun. Existing theme/browser debug diagnostics are retained as limits below, not promoted to new Health regressions.

## Review and verification scope

This was an independent read-only review. I did not run application/runtime suites, contact providers, open owner homes/keychains, modify source or Git, or dispatch subagents. The only written artifact is this report. Existing runtime results below are reviewed evidence, not tests I personally reran.

I read the whole binding plan and current delivery/rulings material, the changed production/controller/component/styleguide/service-worker/CSS code, changed tests and test fixture, runner and archived probe tooling, and changed explanatory documentation. I examined the current and preceding Task 4 review/report material and historical qualification evidence without treating earlier approvals as my verdict. The historical Ruling 4 is superseded: current Caps day-stop wording correctly distinguishes resuming in Tasks from room returning at the daily reset; restoring its obsolete wording is not required.

Bounded unchanged-source inspection covered `ui/js/core.js` request/auth/stale handling; `ui/js/app.js` stream, retry, reachability and refresh integration; relevant panel/visibility styles and screenshot settling helper; Core/createNova Caps construction, runner attachment, Caps validation/stop/routes; Diagnostics projection, secret scan and attachment route; API default person authorization, mutation guards and response headers; and the existing actual-Core-outage test. I did not conduct an open-ended review of the entire unchanged backend or application.

Independent read-only checks established:

- The 5,595,997-byte, 723-section master diff has the supplied SHA-256 `9f9146a8da21c78b51dce54b46c391ea969d4956966c9b4bb4686d6d29b77fff`. All 706 retained primary sections match the master after separating the explicit companion-index annotations. The 17 indexed omissions are three byte-identical baseline copies and fourteen losslessly reconstructed navigation roots; all fourteen reconstruct their original UTF-8 bytes exactly.
- All 123 changed JSON artifacts parse. All fourteen navigation roots have their required reachability assertions, no missing/forbidden entries, and actual Home/rail paths. The historical delivery crawl is labeled historical rather than represented as exact-final-head execution.
- All forty current screenshot entries match raw current output, PNG dimensions, lengths and hashes. All 816 PNGs tracked at `308c8873` are byte-preserved. I visually inspected 22 current app/specimen images across both surfaces and all four required postures, including the two failures above; I did not visually inspect every one of the forty images. The true F0 material was preserved by byte comparison, not rerendered.
- All 22 source-manifest entries match current bytes/Git blob identities. The seventeen source-start hashes recorded for each current browser/static/outage run match current source. All 83 command records preserve their argv, cached-image/no-network/user/CI constraints and zero-byte egress logs; present cleanup records show the named containers absent. All 83 command/stdout hash-index entries verify.
- All 675 noncomment screenshot-ignore entries name exact existing PNGs rather than broad source/test/log exclusions. The v14 worker fixture is byte-identical to the base worker. A targeted changed-source/test/style `git diff --check` passes. The whole-PR raw-output whitespace diagnostics remain explicitly disclosed; this is not a universal whitespace-clean claim.

For the app evidence I read all 1,333 distinct nonempty stdout lines across 83 outputs using exact-line deduplication, retaining unique failure/diagnostic lines. I read the historical evidence prose in bounded passes and inspected historical raw failure/diagnostic contexts, launch commands and reviewed qualification results; I did not manually reread every repeated successful line of the 2,552-line historical raw-output document. Generated metadata was structurally/hash checked rather than pretending to manually audit every repeated scalar. Initial reviewer comparison assumptions about companion annotations and trailing newlines were corrected; the artifacts themselves round-trip correctly.

Recorded current results support two browser engines/eight posture cases, eighteen focal static tests plus compilation, and one actual-Core-outage test covering two outage cycles. Their assertions include finite/null saves and reload, invalid no-PUT, connected numeric editing, held responses/newer drafts, unknown write outcome and stale locks, known save error retention, live health/SSE with Caps-only 503, native attachment privacy/headers, and installed-worker migration/exclusion. The last full all-view Home crawl is a historical fix-1 result; current Home-entry cases and unchanged adapter source do not substitute for final ordinary CI. Earlier 81-test static, 32-test API, two specimen and two offline/Topology qualifications retain their stated scope rather than becoming exact-final-head runs.

## Recommendations

Resolve I1 in one bounded fix/qualification pass and have the resulting source/evidence delta reviewed. Preserve the existing functional download credit and original failed visual witnesses. M1 may remain a disclosed nonblocking follow-up. Do not redesign the controller, broaden accounting claims, or alter production Topology to satisfy this review.

Ordinary hosted CI, the matching merge, and authorized preview remain Root's release gates. After this review Root reported that exact-head CI run `41680690628` was cancelled in the changes job at its five-minute deadline during full-history checkout, before unit/UI jobs ran. I did not independently review those private CI logs or any proposed checkout fix. This is an unqualified external gate, not a unit/UI pass or failure and not an additional source finding in this reviewed range. Any subsequent CI/source fix changes the reviewed head and needs appropriate delta review and qualification.

## Declined to judge

- Complete provider billing, provider-managed task-report reconciliation/loops, other-node totals and per-node failover budgets: explicitly excluded from this task; UI scope is honest, and broader accounting is a recorded follow-up.
- Universal privacy of arbitrary included personal log/problem text and configured names, or a full integrity scrub: not promised by this implementation; known-secret redaction and designated content exclusion were examined, and the residual limitation is disclosed.
- Physical-device behavior, IME-wide editing certification and installed WebKit-worker behavior: no corresponding device proof; recorded native numeric cases and Chromium installed-worker proof are narrower.
- The exact repeated-reload WebKit C++ failure cause or universal reload stability: reproduced with pinned prior frontend copies, not an independently built complete baseline; causality remains unproven.
- Broader Stage 2 hierarchy, orb, gradient, right-column design and new HTTP/morph architecture: existing queued work outside this slice; current component matching still must meet I1.
- A new full audit of unchanged Caps accounting, provider execution, authentication or storage under real identities/providers: bounded named-risk source inspection and existing qualified backend evidence only; no real-provider/owner data use was authorized.
- Independently exercising every midnight/timezone rollover and every authorization/cache failure permutation in a browser: not run in this review; current boundary code and scoped evidence do not constitute exhaustive scenario certification.
- A whole-application accessibility/theme audit or resolution of existing theme/debug/DBus diagnostics: bounded component/accessibility evidence only; no demonstrated new Health regression from those historical messages.
- Retrospective proof of source-at-start provenance for the early adaptive probes and omitted outage-test start hash: gaps are explicitly recorded; post-run byte equality cannot become a before-execution capture.
- A fresh visual rerender of true F0 or every historical screenshot: preservation was byte-verified; this review did not rerun their original environments.
- Final ordinary hosted-CI success, merge state and deployed preview, including the proposed checkout optimization: separate Root gates and outside this exact reviewed change; no approval inferred from focused local evidence.

## Assessment

**Ready to merge? With fixes — not ready at this head.**

The source and functional evidence show careful integration and credible coverage of the main concurrency, availability, authorization and cache risks. The required visual matrix nevertheless contains two demonstrably unusable Diagnostics witnesses; resolve I1 and review the resulting delta before technical approval, then satisfy the ordinary external release gates.

**RELEASE:** This reviewer has finished and relinquishes the checkout. No source/Git mutation or active runtime process was left by this review.
