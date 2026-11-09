# Independent Nova audit — Astra

2026-11-09 · frozen merged build `d948aa0a442a9f930b86f4516eeea21981b76714` · audit only

## 1. Assessment

Nova's strongest promises—local-only processing and complete forgetting—have reproducible edge-case failures that should precede expansion.
A model fallback can use the old privacy mode after the user selects local-only; dated notes can survive forgetting and backup restoration.
An active conversation can also reuse a just-deleted note in its next model prompt.
The foundations are substantial: verified task completion, explicit privacy refusals, capture quarantine, correction history, backup obligations and device authorization are real.
The basic chat/task experience is usable; everyday memory, import and digest journeys still have misleading or missing connections.
The pipeline exists, but its classification can overstate readiness; Jarvis is a composition, and the generic graph layer is still planned.
Fix trust boundaries and connect one complete daily loop before adding a large knowledge canvas.
This review qualifies the frozen source and disposable instances; it does not qualify the inaccessible owner preview, physical devices or real models.

## 2. What Nova is ready for

**An engineering alpha for a technical self-hoster using controlled data and explicit configuration.** The audit completed rendered first-run setup, a real deterministic task with independent file read-back, synthetic actor chat/memory, error recovery, Settings and memory actions, and broad navigation. These results justify continued focused use and iteration. They do not justify an unqualified promise that every forgotten item stays gone or that changing to local-only stops every future remote attempt.

Preserve these strengths:

- **Evidence is an actual task boundary.** The workspace task reached done only after Nova independently read39 bytes and matched its SHA-256. Its Verified button opened those checks. An outside-workspace target waited with a specific reason. See [workflow evidence](evidence/ui-workflows.json).
- **Local-only has useful working refusals.** Ordinary remote chat is refused, voice is disabled because browser recognition may use cloud, unavailable trusted capture screening holds content, and embeddings do not choose cloud. The new race is a missing send-time recheck, not proof that every privacy path is absent. [Privacy evidence](contributions/privacy.md).
- **Deletion/recovery machinery deserves repair, not replacement.** Core correction-chain removal, tombstones, secure deletion, backup scrubbing and owed cleanup are implemented and extensively tested. The defects are at the file-note, prompt-snapshot and completion-status seams. [Data evidence](contributions/data-integrity.md).
- **The UI has a coherent base.** Nebula, restrained chat, the owner artwork, semantic state vocabulary, shared components/tokens, Settings search, phone drawer and canonical navigation are worth preserving. No broad visual or framework rewrite is warranted.
- **SQLite and the modular monolith remain appropriate.** Existing IDs and relational provenance provide a sensible basis for bounded graph views; a server graph database would add cost without solving the observed problems.

Nova is **not yet qualified by this audit** for sensitive unattended end-to-end work, full broker-only credential confinement, physical-phone mesh use, real-model quality, or all-process no-egress guarantees. Those limits have specific evidence and follow-up checks; they are not blanket claims that the capabilities fail.

## 3. Baseline, product map and coverage

### Source and runtime truth

| Item | Established fact |
|---|---|
| Repository | `jeremyspofford/nova`, reached at `/workspace/nova` rather than the supplied expected host path |
| Fresh source | Fetched `origin/main`; clean detached `/workspace/nova-audit-astra` at full SHA above; PR #438 merge. End-of-review fetch still resolves to the same SHA. |
| Existing work | Existing checkout preserved. No product implementation or remote PR mutation. Audit-generated tracked test screenshots were copied into evidence and restored in this isolated worktree. |
| Owner preview | `localhost:4318` refused connection here; host deploy-watcher log absent. Owner running commit, Health stamp and watcher behavior remain blocked. This is an access gap, not a demonstrated deployment failure. |
| Audit runtime | New home `/tmp/nova-astra-main-20261109`, port 4418. `/api/v1/version` reports `d948aa0a`; rendered Health/About report the same. Latest merged build is honestly unknown because this direct-start fixture has no watcher/deploy record. [Version](evidence/runtime-version.json), [Health](evidence/runtime-health.json). |
| Toolchain | Node 26.3.1, baseline lockfile; Linux Chromium 155. CI uses its pinned Playwright image, so browser/runtime parity is limited. |
| Security boundary | No real accounts, credentials, model calls, model pulls, external integrations, shared-home deletion or network interruption. Restricted whole-system threat model not ingested. PR #207 inspected read-only. |

Every finding in [BACKLOG.md](BACKLOG.md) identifies the frozen merged baseline. Runtime witnesses mean a disposable instance or synthetic composition of that source. **None establishes applicability to the owner-deployed build**, whose commit was unavailable. [BASELINE.md](BASELINE.md) retains the protocol and [EVIDENCE.md](EVIDENCE.md) identifies reproducible witnesses.

### Actual surfaces

| Family | Current surfaces and boundaries |
|---|---|
| Daily work | Home; Chat/main/new/saved conversation; Tasks and verification sheet; Memory sections/day notes/candidate review; Automations with rule list plus Markdown schedules/digest; Skills; Activity |
| Operations | Health, work limits/diagnostics/recovery information; Capture; Machines and services/Topology |
| Settings | You and Nova; Appearance; Privacy and permissions; Connections; Models and providers; Devices and device-model detail; Capture; Services; About Nova; Security; Backups and changes; Configuration; Start over |
| Product truth | About; What's new/changelog; Where Nova stands/pipeline; version footer and Health stamp |
| Separate/public/design | Pairing page; styleguide; Jarvis and queued compositions. A styleguide example is not a working product control. `/schedules` remains an Automations alias. |

The [coverage matrix](COVERAGE.csv) records surface/workflow, role/mode, theme/viewport, state, result, evidence and instance. It includes explicit blocked/untested combinations. The main appearance sweep covers17 routes plus13 actual Settings categories at 1440×900,390×844 and360×360:90 visits. Additional light-theme, alias, styleguide and interactive workflow evidence is separate. Early `/settings?cat=...` attempts did not select categories and are excluded; corrected `/settings#...` traversal supplies that coverage.

**Depth:** first-run invalid input/reload/first result; draft/resize/reload; synthetic chat/memory/error/recovery; deterministic task creation and evidence; import Keep/Drop/edit/forget/Undo; Settings save/reload and per-device theme apply/Undo; daily schedule enable/pause; browser Back and palette keyboard controls; Home-start navigation; offline/reconnect/late response; fold/hinge/200%text; isolated deletion/restore/privacy races and source boundaries. Real chat quality, real Tev1/Ollama operation, real cloud providers and real capture hardware were not exercised.

**Accessibility:**56 initial desktop/phone states passed this audit's WCAG-tagged axe checks; no page-width overflow at the sampled sizes. This excludes dynamic/seeded states, nonvisual assistive use and many manual WCAG criteria. Exact-baseline CI's broader advisory reports23 violating nodes (including Health accessible-name and Activity heading-order checks) while remaining green. Treat those as triage evidence, not a claim that the whole app conforms or that every advisory is a manually confirmed failure. [CI excerpt](evidence/qa-ci-accessibility.log).

**Performance:**12 local samples at 390px gave view-state readiness381–626 ms, observed LCP436–796 ms and observed CLS 0 over a short window. Home transferred about1.17 MB/79 resource requests. These measurements used headless Chromium, new contexts, localhost, reduced motion and shared audit load; they are not field p75, INP or constrained-phone proof. [Conditions and samples](evidence/ui-performance.json).

### Previously raised concerns, rechecked

- **Local chat:** an Ollama/local-provider implementation path exists; the runner uses the selected chat provider and its egress. The default command in `src/config.js` is Claude CLI, with undeclared egress treated as remote. This audit used an explicitly synthetic local actor and had no real Ollama service, so it does not establish real local-chat quality or the owner's selected provider. A local Tev1 decision seat does not establish that chat is local.
- **Research verification:** current committed local eval records failed; full Part 3 remains parked. No model eval was run here. See section 8.
- **Real-phone pairing:** browser and synthetic mesh coverage exist; physical phone enrollment/revocation/passkeys remain blocked in this environment. Historical untested hardware concerns are not presented as reproduced failures.
- **Pipeline dashboard:** it is reachable and implemented. NOVA-080 concerns the truth and usability of its classifications/evidence, not an absent screen.

### QA and delivery

Exact-source GitHub Actions run [42692472653](https://github.com/jeremyspofford/nova/actions/runs/42692472653) was successful. Required checks prove the committed synthetic test matrix and configured browser shards, not model quality, physical phones, owner-host redeployment or all-process egress. Accessibility remains advisory; research real-call tests are opt-in and were not run. Dependency installation in an isolated manifest directory succeeded using the existing pinned Node toolchain; a clean-OS installation was not performed; the current registry audit reported no advisories.

The local broad `npm run check` is **not green**: 2,214 passed, 40 failed and 15 skipped (2,269 reported tests; exit 1). Docker process-inspection and orphan-process tests fail in this managed environment; one stalled audit-owned Docker fixture required termination. Focused Chromium checks finished8 pass / 1 fail: both Home crawls reached14/14 registered views, Settings and offline/recovery passed, as did fold state/hinge/200%text. The failed45–75 ch check measures41.70 ch only when the optional right pane is expanded at 840px; default chat measures69.97 ch. This is a bounded layout/compatibility qualification issue (NOVA-046), not evidence of clipping. The full run took 1,021 seconds; its interrupted fixture means it was not an uninterrupted gate completion. Final counts and unresolved diagnosis live in [QA validation](contributions/qa-delivery.md) and its logs; do not replace local failure evidence with the green remote run.

The rootless Docker limitation is concrete: `docker top` cannot resolve this container's cgroup path. Nova refuses to execute when it cannot inspect processes, preserving the safety boundary. Its earlier ready indication can still improve (NOVA-044). Supervisor process-liveness failures (NOVA-045) need qualification on a normal reaping host; they are not classified as confirmed deployed regressions. [Docker evidence](evidence/qa-docker-environment.json).

## 4. Prioritized findings and distinct gaps

Severity describes consequence; priority describes sequence. P0 means immediate repair, P1 the next safety/core workflow tranche, P2 next release or gated proposal, P3 lower-risk follow-up. Confidence and evidence class remain separate. The detailed backlog contains reproduction, observed/expected behavior, source lines, cause, smallest closure, components, decisions, acceptance, regression and effort for every ID.

| Order | Finding | Consequence | Evidence |
|---|---|---|---|
| 1 | NOVA-001 · stale privacy on model fallback | Context can reach a cloud-class route after local-only is saved | Controlled local failure:0 remote sends in control,1 with canary after mid-flight policy change |
| 2 | NOVA-020/023 · incomplete forgetting across notes/recovery/current turn | Forgotten wording remains searchable, restores from a backup, or enters the next actor prompt | Three isolated canary witnesses; existing core deletion tests still pass |
| 3 | NOVA-021 · false global deletion completion | “Deleted everywhere” while a backup still contains the item and owes cleanup | Unavailable fixture backup; eventual cleanup succeeds |
| 4 | NOVA-005 · missing capture recall screen | Promoted capture reaches actor context without the promised use-time screen | Actor prompt canary,zero additional ingest screens; documented remaining consumer |
| 5 | NOVA-003/004 · broker migration and egress assurance | Intended secret/network boundaries exceed current whole-product evidence | Direct legacy Core secret readers; bounded all-process investigation, not a claimed exploit |
| 6 | NOVA-081/086 · memory truth in the UI | Old read redraws removed content; imported source is mislabeled as a conversation | Real browser with controlled out-of-order reads; real import Keep and core-source comparison |
| 7 | NOVA-082/083 · incomplete daily workflows | Memory search/state/export and ordinary rule authoring require knowledge outside their screens | Runtime surface inspection and explicit queued compositions/backend APIs |
| 8 | NOVA-084/085/040 · first-use dead ends | Home promises an unconnected Brief; setup names the wrong host import path; README teaches an obsolete architecture | Rendered setup/Home plus current source |
| 9 | NOVA-080/041 · readiness/release truth | Design-only work appears Merged; shipped behavior keeps the same alpha version | Baseline pipeline generator; version/tag/changelog history |
| 10 | NOVA-120/121/042 · state/accessibility/device polish | Idle/thinking identical without WebGL; short Home hides useful next action; advisory regressions do not block CI | Pixel-identical fallback diagnostic; short-cover screenshot; CI configuration/results |

**A. Required or promised but missing:** complete forgetting in every path (020/023); recall-time capture screen (005); full broker consumer migration (003); reachable core Memory workflow (082); ordinary rule editor (083); release advancement (041). Some other designed surfaces—receipts/inbox, vault management, browser/computer start, infrastructure forms, supervisor controls and run lists—remain in the existing wiring queue; preserve their actual ledger status rather than treating their design pages as finished. Generic graph implementation is a **queued future commitment**, not a current regression.

**B. Implemented but inaccessible/undiscoverable:** richer core memory search/confirm/export and rule CRUD are API capabilities without corresponding current-screen controls. A source file path in pipeline evidence is not an openable evidence affordance. Backend presence does not qualify app shipping. Existing Tasks/Health/Capture/Topology navigation doors were reached and should not be reported missing.

**C. Exposed but broken/misleading/incomplete:**001,020,021,023,080,081,084,085,086,120. The UI memory race is temporary display regression, not proven database resurrection. Capture's owed-backup cleanup works; the global success statement is wrong. Import provenance remains in the core; its rendered attribution is wrong. These distinctions determine the smallest fixes.

**D. New opportunities beyond current commitments:** concrete cloud-context disclosure (006); export-ownership explanation (022); explicit capability readiness (100/044); compact short-height Home (121); the proposed knowledge navigation slices (061–063). Their design/owner gates remain intact. No tour, gamification, decorative animation or extra model feature is needed to repair the daily loop.

### Three consequential maintenance problems

1. **The same policy/data has several lifecycles.** Runner, Models and Receipts recheck privacy differently; core records, file notes and assembled prompts implement different deletion paths. The observed privacy and forgetting failures follow directly. Establish live send-time policy and a common source/version/deletion contract at those boundaries. Keep plain-file interoperability, but make it a projection with provenance. `src/core/models/index.ts:691`, `src/core/receipts.ts:107`, `src/memory.js:383`, `src/runner.js:357`.
2. **View state is owned independently by each screen.** Memory lacks the request-generation guard already present in About; Models and Capture have separate draft-preservation logic. Standardize a small latest-read/dirty-form/focus contract while fixing demonstrated races. The shared HTTP client has already landed; replacing it again is stale advice. `ui/js/app.js:113`, `ui/js/about.js:35`, `ui/js/app.js:1834`.
3. **Human prose is a runtime status schema without validation.** Pipeline uses heading/first-line heuristics, README reflects an older era, and versioning is a separate manual promise. Add minimal validated metadata to the existing canonical records and link their narrative evidence. Avoid a second roadmap database. `src/core/pipeline.ts:69`,`:106`,`:242`; `README.md:3`; `package.json:3`.

## 5. User-understanding plan

Lead with an outcome: **“Nova keeps your context on your hub, turns requests into tracked work, and shows what it used and checked.”** Then say which of those actions this installation can perform now. Introduce the OS metaphor after the first result.

| Concept | Plain explanation and placement |
|---|---|
| Hub / paired device | The computer storing Nova's records versus the device viewing or helping it. Name the actual host in import, backup and pairing instructions. |
| Chat / decision model | Chat writes replies; decision models screen/check small choices. A local checker does not make cloud chat local. Keep seat IDs in details. |
| Privacy | Local only / Local first / Cloud allowed, with actual destination and data classes. Reading a local file into a cloud model is disclosure of its contents. |
| Capture / memory | Capture is source material; memory is what Nova retains for later. Carry the same source identity through screening, approval, correction and recall. |
| Capture classes / scope | Explain the source and sensitivity before technical labels. Show what may be captured, retained, promoted and sent for this class, with examples and exclusions. |
| Tiers | Runs silently / runs and tells you / asks first / explicit confirmation every time. Show the proposed action and consequence; tier numbers are secondary. |
| Verified | Nova checked the evidence required for this task. Show which checks and their limits; never equate an unverified model answer with completion. |
| Health / readiness | Nova can be running while local chat, screening, pairing or restoration is not configured. Give one exact recovery link, using amber for attention and red only for a stopping problem. |

Connect two concrete journeys. First: **import one chosen note → inspect its real source → keep or dismiss → find it again**; make this usable without a chat model. Next: **request work → see real progress or a specific blocker → inspect the verified result → reach it again from Memory/Home**. A digest should be one existing schedule/report surfaced consistently, not another independent summary store.

Use Linear's peer-row discipline for tasks, Things 3's calm selection/triage for memory, and Claude.ai's composer restraint for chat. Preserve Nova's supplied artwork; alter its size/treatment only where the state or viewport requires it. A useful empty state gives one available next action; a recovery state preserves the user's input and says what will happen on retry.

Validation proposal, not work already performed: five unfamiliar technical self-hosters; at least four identify their hub and active chat destination, approve/find a source-backed memory, predict approval behavior, and recover from unavailable local capacity without source reading. Record completion, first wrong turn and assistance. Do not replace this with a guided tour that hides failures.

## 6. Immersive knowledge experience

The complete substantial design is [KNOWLEDGE-PLAN.md](KNOWLEDGE-PLAN.md). It specifies concrete questions, node/edge authority, identity, confidence, time, authorization, deletion, incremental loading, stable layout, search, evidence inspection, accessible alternatives and optional 3D. It is a proposal for the builder/owner sequence, not implementation authorization.

**Baseline correction:** running all 27 SQLite migrations produces no generic `graph_nodes`/`graph_edges` tables, no FTS5/vector index and no full bitemporal graph. Tasks, memory corrections, capture promotions, receipts, decision records and topology provide partial relationships. Model-embedding support is not an existing vector retrieval index. [Schema evidence](evidence/graph-schema.json).

Start with “Why does Nova believe this?”, “What did it use or send?”, “What is waiting for me?”, “Which service affected this work?” and “What changes if I forget this?”. The primary graph workspace is bounded 2D with a semantic list and canonical screens always available. Search anchors one object; named expansion actions reveal a one/two-hop neighborhood; the inspector opens actual evidence and the canonical action. Back restores selection/filter/view history.

Use stable source IDs, typed directional edges and source-version pointers. Recorded relationships are distinct from suggested/inferred ones; confidence is attached only when meaningful. “True at” and “known by” are separate times; unknown history stays unknown. Authorize source objects and edges **before** returning labels, counts, paths or layout data. Forgetting overrides time travel and invalidates projections, caches, exports under Nova's managed boundary and restored indexes. Layout/search can operate locally with no model. All optional answer prose must cite the same authorized evidence.

**PR #207 Stellar Map:** read-only open draft, old base `04512c07`, head `5e0fe8b8…`; never treated as merged. Borrow focus, hover inspection, spatial overview and transitions into detail where they help a question. Its per-request file-derived topology, naming-based relationships, partial300-node aggregation, theme gating and silent refresh fallback do not satisfy current identity/provenance/privacy/freshness contracts. Do not merge or reuse the draft wholesale. [Assessment and source references](KNOWLEDGE-PLAN.md#read-only-assessment-of-pr-207-stellar-map).

| Slice | Independently useful outcome | Scope and acceptance | Effort after prerequisites |
|---|---|---|---|
| 1 · Explain one memory | Find its actual source and correction trail | Memory detail, small one-hop diagram plus list, source inspector and canonical open. No inference/model call. Four of five users identify source/uncertainty within 60 seconds; deleted/unauthorized sources disclose no labels/edges; keyboard/phone/short-height journey works. |5–8 engineering days |
| 2 · Connected work in2D | Find a prior verified result and see what it used | Knowledge destination, typed search/question lenses, filters, bounded expansion, inspector/history, task/receipt/skill/schedule adapters. Evidence reached within 3 intentional selections in four of five trials; bounded 10k/100k fixtures, privacy/deletion and nonvisual navigation pass. |3–5 engineering weeks |
| 3 · Operations and time | Explain changed services and recorded affected work | Health/Topology entries, device→service→run/task paths, independently aged observations and before/after lens. Distinguish assignment from actual serving; identify next action within 90 seconds; no fabricated historical placements or approval bypasses. |2–4 engineering weeks |

The first slice can use query-time projections over current relationships under an agreed DTO/identity contract. Do not make it wait for a universe of nodes. Prerequisites are the existing A1/A2 architecture queue, graph ADR/second-model review, source authorization/deletion contract and rendered-entry recognition. The existing graph-compilation pilot remains a distinct gated track.

Optional3D should earn its place through a bounded comparison task—such as tracing spatial service dependencies—with the same selected object, filters, breadcrumb, reset view and evidence inspector as 2D. Use stable anchors, no auto-flight, no forced motion; touch/keyboard/list modes remain complete. A 2–5 day prototype after the operational slice can test whether3D improves task success/orientation. If it does not, retain2D and stop. It does not justify a new graph database, cloud layout service or artwork redesign.

## 7. Top ten changes and dependency-ordered roadmap

1. Recheck live privacy immediately before every remote send/fallback, with receipts enforcing the same rule (001); reconcile the explicit screening exception (002).
2. Close forgetting across correction chains, dated notes, backups/restores and active-turn context; report pending holders truthfully (020,023,021).
3. Preserve capture provenance into a fail-closed recall screen before any acting model receives it (005).
4. Finish the existing broker consumer migration and qualify all-process egress on a disposable network lab (003,004).
5. Make Memory display current state and actual source kind; prevent old responses from restoring obsolete content (081,086).
6. Wire the existing search/confirm/correct/export Memory workflow before building graph exploration (082,022).
7. Repair the import path/handoff and obsolete entry docs; connect a truthful Home/digest/Automations loop (085,040,084,083,006).
8. Make pipeline completion, version/tag advancement and capability-readiness claims match evidence (080,041,100,044).
9. Close the demonstrated status fallback/short-height issues and establish a targeted accessibility regression gate; preserve generated QA artifacts (120,121,042,043).
10. After those foundations and required design gates, ship the small memory-provenance slice and react to real use before broader2D/optional 3D (060–063).

**Immediate:**001 →020+023 →021 →005. Alongside review of each small repair, use the cheap confirmed copy/source-label corrections085/084/086 and stale-read fix081 to remove misleading behavior. Keep cloud-screening policy002 explicit; do not treat its historically disclosed opt-in as a newly discovered silent fallback. Verification must reproduce the failing canaries through production composition and actual API/UI paths.

**Next release:** broker migration/egress qualification; canonical Memory workflow; actual first-use import and schedule/result loop; README/pipeline/release metadata; capability readiness, status/accessibility fixes and deployment verification on the owner host. Preserve the existing builder's owner-approved queue and rendered-review requirements. Do not start a competing implementation track. Efforts in BACKLOG are bounded estimates for one familiar builder, exclude approval wait/physical-device access, and overlap; they must not be summed as a fixed delivery promise.

**Longer term:** approved architecture/graph ADR → slice 1 feedback → bounded 2D slice 2 → operational/time slice 3 → optional 3D decision from measured benefit. Provider plurality and MCP architecture stay prerequisites where already required. No wholesale rewrite, new server graph database or extra AI feature is a prerequisite for the first useful provenance journey.

## 8. Decisions, unverified claims and remaining limits

- **Parked research Part 3:** remains an owner decision, not an actionable gap to close. No eval ran in this audit. Current committed Nov 7 Tev1 records show verify-transfer recall 25%, ECE .290 and outbound-check ECE .153: both failed and remain untrusted. Those historical files do not authorize the proposed local-only test exception or full Part 3 A/B/golden verification. Keep the feature default-off and the existing bounds.
- **Privacy contract:** determine the treatment of previously enabled cloud-screening opt-ins under local-only; recommended end state is an absolute local-only mode. Distinguish this disclosed historical exception from confirmed race001. Decide whether promoting capture preserves its privacy floor for later actor context.
- **Memory gate:** the consumer is now wired but defaults off by current choice. The recorded pass belongs to a specific template/model digest and has documented sample/authoring limits; it is not universal Tev1 verification. Default-on is an owner/product decision.
- **Graph:** generic tables are not shipped. Confirm scope/terminology and the small slice through the required ADR/design process. PR #207stays untouched. Optional3Dneeds task evidence.
- **Deployment:** owner-host Health/version/watcher comparison, actual running chat and decision-seat configuration, and latest-merged-to-preview behavior are blocked here. The audit runtime's unknown-latest message is expected and truthful, not a proven watcher failure.
- **Security and hardware:** restricted whole-system threat model intentionally unread; no OS-level all-process egress test, real credentialed integration, real-model quality test, physical-phone pairing/revoke, actual foldable hinge/safe-area, installed-iOS status bar or assistive-technology session. Session expiry and non-console role/UI combinations are not exhaustively exercised; synthetic boundary tests are identified separately.
- **Local QA qualification:** Docker/cgroup and orphan-process failures plus the optional-pane prose-width failure remain visible in the validation register. A compatible-host rerun is required before claiming local gate parity. The audit does not alter product code to make tests pass.

The audit package is complete for the accessible scope, with blocked and untested coverage explicitly retained. [CHECKPOINT.md](CHECKPOINT.md) gives exact follow-up verification steps. Implementation remains permanently assigned to the project's existing builder; this audit neither starts it nor offers a parallel build.
