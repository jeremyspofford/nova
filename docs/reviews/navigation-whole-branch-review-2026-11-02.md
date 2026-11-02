# Independent whole-branch final review — PR #282

Reviewed 2026-11-02, read-only except this report. Checkout: `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`. Base `6d0a74a58a3a20df7f3718b2ade2413c1ba84e8a`; reviewed HEAD `e6ba2e2fbc50caf96e79de6b93f4bde889a535a2`; application/test source checkpoint `7c8724965a34428b5267de3070d5e94895772956`. Independent review of final source and records; prior PASS verdicts were not treated as authority.

## Strengths

- The four production-file changes implement the specified homes with existing components: Home Devices → Machines and services; Settings Devices → Machines and services; a normal Capture category beside Devices. The existing Capture renderer and event handlers remain intact. Capture hashes/search resolve through the category machinery; route aliases remain recognized. Rail/tab placement and density are unchanged.
- Expected coverage comes from the actual production `VIEWS` registration, separately from `DESTINATIONS` and `reachable()`. The literal reader fails closed on unsupported shapes and duplicate registrations. The crawl performs real phone taps/rail clicks, replays through Home, opens real More/conversation controls, and covers representative `/new`, `/c/:id`, and `/schedules` families. The controlled registered-and-routed orphan experiment really adds a DOM root and lacks a door; it records 12 registered/11 reached in both arrangements. It is not merely a model-only demonstration.
- Browser exploration is bounded to recognized same-origin app links and named navigation controls. Non-GET/other-origin requests fail the run, no form or service action is submitted, and fake-agent/Core egress checks remain. No runtime dependency, API/auth policy, production service configuration, baseline image, mask, or threshold is changed.
- The before-state is honest: all 11 views already reached through Health/Services/Privacy; the three required ordinary homes independently failed. The pre-edit 25-state evidence and later pinned-byte 26-state recheck remain distinct. The final recorded runs reach 26 states/11 views/all three homes in both arrangements.
- Every one of the 51 inventory rows has an explicit current app-surface status; all 70 narrow findings remain visible. The reconciliation distinguishes actual controls, closed disclosures, existing-record-only review, tool/API/CLI-only initiation, CI mechanisms, inert work, and unbuilt features. Generic Chat/Health are not used to certify unrelated workflows. Historical backend evidence, UNPROVEN/advisory/stand-in limits, memory-gate-not-live and broker/credential gaps remain.
- Local failures are retained rather than overwritten by isolated passes: ordinary run 1608 pass/4 fail/1 cancelled/14 skips after termination, bounded run 1607 pass/5 fail/14 skips, original Settings-position failures, and the narrower 43-test serial success. Full ordinary public CI remains an explicit condition. The Home hierarchy FAIL remains inherited and open in stage 2.

## Issues

### Critical (must fix)

None found.

### Important (should fix before integration)

**I1 — Readiness accepts hidden content from another view, so an empty active destination can count as rendered.**

- File: `tests/ui/navigation-reachability.test.ts:28` (predicate), `:30` (acceptance), `:118`–`:120` (coverage credit); owner-door checks at `:163`, `:172`, and `:184` likewise only compare `body[data-view]` after this predicate.
- `#main > *` includes the visible `#scroller` container. Its `querySelector('h2, .card, .empty, .empty-state, .turn')` searches hidden descendants too. Once Home has rendered, its hidden heading/card can satisfy this condition while the selected destination is entirely empty. Even restricting the root candidates to direct view children would still require visibility checks on the matched content itself.
- Concrete focused probe in cached Chromium used the real DOM structure: `body[data-view=topology]`, a visible `#main > #scroller`, hidden `#home` containing `<h2>Previous Home</h2>`, and empty visible `#topology-view`. The exact predicate returned `{ acceptedRoot: "scroller", acceptedContent: "Previous Home", activeView: "topology", activeViewContent: "" }`. No app server, owner service, source edit, or full-suite rerun was involved. Loaded store/health can remain true after Home and there is no pending marker in this state.
- Impact: a navigation regression that selects a registered view but fails to render it, or leaves it hidden without throwing, can still receive reachability credit. Capturing headings/controls does not rescue the check because their destination-specific presence is not asserted. The owner explicitly requires rendered destination readiness; route-state metadata alone is insufficient. This does not invalidate the existing recorded screenshots/control data or the missing-door orphan result, but it leaves the new required gate unable to enforce the promised rendered contract.
- Fix: resolve the active registered view to its real DOM root, require that root to be visible and its relevant content actually visible within that root, and scope readiness/pending checks appropriately. Do not accept the shared scroller or hidden sibling content. Preserve legitimate empty-state rendering, Chat/New, Settings, aliases, and navigation overlays. Add a focused negative probe where a known destination is selected but empty/hidden while an old view retains content; it must fail before the view receives coverage credit. Then run the revised two-arrangement gate and scoped review. No new runtime abstraction/dependency is necessary.

### Minor (nice to have)

**M1 — Navigation timing length does not prove the document was retained.**

- File: `tests/ui/navigation-reachability.test.ts:191`; related evidence wording: `docs/reviews/navigation-reachability-implementation-2026-11-02.md:23`.
- `performance.getEntriesByType('navigation')` belongs to the current document. A full navigation creates another document whose own count is normally one. A focused cached-Chromium probe navigated to two different data documents and observed `1` after each. Thus the assertion cannot detect a reload between app clicks, although the report says it does.
- Impact: a regression from client-side navigation to full document loads can pass this particular assertion. This does not turn the actual clicks into direct-URL shortcuts or defeat the independent missing-view oracle, so this finding is Minor rather than a product/reachability blocker on its own.
- Fix: track main-frame document navigation requests across the page lifetime, or set a per-document sentinel once after initial Home and verify it survives every step. Distinguish same-document hash/history changes from document replacement. Include one negative reload check. Correct/qualify the old zero-reload evidence claim; historical raw runs must remain historical rather than being rewritten as passes of the improved measurement. Since I1 already needs a source fix, resolving this in the same consolidated wave is sensible.

## Review evidence and boundaries

Read the owner plan, both task briefs/reports, progress, complete substantive source diff, current mapping/status cells, 70-item register, source audit/subclaim treatment, retained experiment sources/results, integration records, and PR draft. The supplied 751,188-byte package's diff portion exactly matches `git diff -U10 6d0a74a5..e6ba2e2f`; its header adds commit/stat information. Repeated data was mechanically checked instead of reprinting it.

Independent mechanical checks completed:

- All 10 final source-file hashes match both checkout bytes and source checkpoint `7c872496`; all six baseline module hashes match `git show` at `6d0a74a5`.
- All six normalized artifact hashes match, and the complete numbered 79-line original inventory appendix matches the baseline after its documented trailing-whitespace normalization.
- All six published red/green/baseline-fixture crawl projections equal their raw reports (view sets, required results, missing sets, mesh truth, forbidden requests, paths, steps and sections). Both final heading/control projections reconstruct the raw metadata exactly through the 120-entry catalog.
- All 51 current status strings match the inventory; every referenced surface exists in the appropriate phone/rail snapshot; O01–O70 are contiguous. The substantive current statuses and narrow findings were read, not accepted from counts alone.
- `git diff --check 6d0a74a5..e6ba2e2f` is clean. The checkout was clean before this ignored report.
- Viewed neutral rail Home Devices, phone Settings category list and phone Settings Devices images. They show the requested ordinary controls and the inherited Home card-weight limitation. No new screenshot or baseline was produced.
- Read actual PR #282 with `/home/jeremy/.local/share/mise/installs/gh/latest/gh_2.95.0_linux_amd64/bin/gh`. At inspection it was draft, published head `f3ca9d386e78c9c85054ffe1f589810217bc7252`; body exactly equalled the 33,884-character draft, including all 51 mapping rows, all 70 register rows, before/after, failed-local-run limits and stage-2 scope. CI run `41504500273` had changes success and both heavy jobs in progress. That older-head run is not evidence of final-head success. The body's pending-review text/links still need the normal final integration update.

Only one named focused browser probe was run: readiness hidden-sibling false positive plus navigation-entry reset. It used cached `mcr.microsoft.com/playwright:v1.56.1-noble`, `--pull=never`, Node 26.3.1, non-root user, a read-only source mount, a temporary browser page and no app server. No already-reported suite was rerun. I have not independently re-proven historical feature/security/eval operation by executing it.

## Recommendations and integration conditions

1. Use one consolidated source/evidence fix wave for I1 and, preferably, M1. Preserve all original failed runs and source pins, adding a clear new checkpoint for any updated tests/evidence rather than relabelling old output.
2. Obtain scoped independent re-review of active-root readiness, the negative probes, and any changed evidence statements. Keep production registration as the oracle and the genuine 11/11 baseline truth intact.
3. Publish the final reviewed head and require ordinary public checks, UI gate, and aggregate gate to pass for that exact head. The local 43 passes, current older-head CI, or force-exit full diagnostic cannot substitute. Investigate actual CI failures if they occur; do not dismiss them as the already-known local load hypothesis.
4. Update PR review status and evidence links to the final checkpoint while retaining the complete 51/70 mapping and before/after. Merge only the matching verified head with same-PR LEDGER. Complete the already-authorized preview restart/verification at the integration stage before claiming the owner's work complete; preserve #275 B and the M10j credential block.

## Declined to judge

- Live account/provider/Relay/Ollama/Screenpipe/cluster/device operations and credentials: prohibited by this task's isolated-fixture boundary; visible setup fields are not operational/security proof.
- Populated task approval/merge/apply/takeover, device enrollment/promotion, memory/capture records, installed-model actions and expanded provider/sign-in disclosures: not exercised by this blank crawl and explicitly limited in the inventory; implementing or proving all of them is outside this navigation repair.
- Historical backend, cryptographic, egress, forget-through-backups and model-eval guarantees: checked for preservation and honest qualification, not re-evaluated; unchanged implementation and old verification claims require their own evidence.
- Fresh-user onboarding, external `/pair`, `/styleguide`, native installation/offline behavior and real phone/foldable behavior: separate surfaces/hardware outside ordinary post-setup app VIEWS; no new completion claim is made.
- Turning all 70 scope findings into new features: owner permits explicit not-shipped/API-only reconciliation; the present repair does not authorize 70 additional workflows.
- Inherited Home hierarchy, rail-orb depth and background-light stage-2 work: observed and retained as unfinished, not solved or approved by adding these links.
- Ordinary-suite fixture leak/port reuse and unrelated timing repairs: retained failures/diagnosis are honest; source unchanged, cause not globally established, and independent repair was not authorized in this review. Required final CI is still binding.
- #275 findings B and M10j credentialed K3s completion: explicitly parked/not passed; no evidence here changes those gates.
- Final publication, merge, preview and final-head CI completion: controller integration actions still pending at the reviewed snapshot; not silently treated as passes or as source-code defects.

## Assessment

**Ready to merge? With fixes.**

**Spec:** the production homes and claims reconciliation meet the requested scope, but the new gate's active-destination rendering check needs I1 fixed before it enforces the full promised contract. **Quality:** zero Critical, one Important (I1), one Minor (M1). After a scoped fix/re-review and exact-final-head ordinary public green CI, no other reviewed change blocks integration. This is not permission to merge the currently published or locally reviewed head before those conditions are met.
