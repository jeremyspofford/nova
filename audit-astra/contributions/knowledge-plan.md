# Knowledge experience: an evidence space, with a graph when it helps

Audit contribution at merged source **d948aa0a442a9f930b86f4516eeea21981b76714**. This is a design proposal and source assessment, not an implemented feature, usability test, or authorization to build. The deployed owner preview was not reachable from this environment. PR #207 was inspected read-only; it remains an independent design reference, not shipped functionality. The restricted whole-system threat model was not read.

## What the baseline actually contains

**SQLite is established; a generic SQLite graph is not.** Running every current migration against an isolated in-memory database produced schema version 27 and no graph_nodes or graph_edges tables. The result is preserved in evidence/graph-schema.json; diagnostics/graph-baseline.mjs reproduces it. A source search across src, tests and ui also found no generic graph implementation or valid_at/invalid_at/expired_at fields. This resolves a supplied starting claim without treating the future architecture queue as a present defect.

There are useful authoritative relationships already:

- Tasks have parent IDs, brief/report/verification, event history, privacy mode and approval tier: src/core/migrations/0001_core.sql:15, src/core/ledger.ts.
- Memory has stable record IDs, source, observed_at, created_at, correction links, confidence, scope and expiry: migrations/0003_memory.sql:6; memory.ts:35. Correction makes a new record; history is preserved until forgetting the chain (memory.ts:115,156).
- Captures have source/device IDs, capture and receipt times, and explicit promotion records linking memories to captures: migrations/0009_capture.sql:33,68. GET /capture/memory/{id} already returns this provenance (capture/routes.ts:52).
- Receipts associate tasks/sessions with provider, model, egress and context references plus hashes, without copying the context: migrations/0003_memory.sql:34; receipts.ts:16,37,123.
- Decision Service records are prospective, with template/version, seat, model, probability answers, trust, policy outcome and task/source linkage. They retain hashes and field names, not state content: migrations/0019_decision_record.sql:4; decision-service/log.ts:28. This is not yet the richer G2 record of actual alternatives, precedent, policy and outcomes. Missing historical alternatives must remain unknown.
- Topology is a bounded projection of device/service observations with independent freshness. Its actions refer back to mutation authorities that recheck permissions; intended placement and observed serving state differ: services/topology.ts:25,55,62. The existing accessible machine/service list, stale observation language and no-invented-hub behavior are strengths to preserve (ui/js/topology-view.js:31,45,57).
- Skills remain Markdown playbooks and schedules remain a mixture of Markdown schedules and SQL trigger rules (src/skills.js:1; src/schedules.js:74; core/triggers.ts:36). A graph must refer to both without inventing a second source of truth.

The owner graph addendum is explicit that it is queued requirements, not shipped capability; it requires an ADR and second-model review after A1/A2 before graph code (docs/plans/owner-graph-engineering-addendum-2026-11-03.md:3,5,58). Its SQLite-only, reference-only, bounded traversal and deletion rules constrain this proposal. FTS5/sqlite-vec are named in that future design, but current core memory search loads active rows and scores token overlap (memory.ts:214–225), and no FTS5/vector index appeared in the schema. An embedding model API is not evidence of a vector retrieval index. Establish that migration separately; do not label it an already available dependency.

## Start with questions, not a universe of dots

The primary outcome is being able to explain and act on Nova's work without remembering which subsystem owns each fragment.

| User question | Smallest useful journey | Success evidence |
|---|---|---|
| Why does Nova think this is true? | Memory → supporting capture or file → recorded source, date and correction history | The person identifies the source, distinguishes direct evidence from a suggestion, and opens the original record |
| What did it use or send for this answer? | Task/answer → context receipt → source versions and processing destination | The person names the actual destination and sees the exact referenced versions or an honest unavailable state |
| What is waiting for me, and why? | Task → blocker/approval → canonical review action | The person completes the existing approval flow without a graph-specific permission bypass |
| What changed since yesterday? | Known object → event timeline → before/after facts | The person can distinguish a real-world change from a late observation |
| Which devices and services make this possible? | Task/provider → observed service placement → device status | The person sees independently aged observations and does not mistake assigned work for healthy service |
| If I forget this, what else uses it? | Memory/capture → recorded derivation closure → deletion review | The person sees supported dependencies, unknown coverage and the scope of deletion; no fabricated complete guarantee |
| Have we solved something like this before? | Search → one relevant task → evidence-backed neighbors | The person reaches a relevant verified result faster than with separate lists |
| Which routine made this task? | Task → trigger/run → schedule/skill version | The person can inspect and pause the canonical routine |

Use these as benchmark tasks with neutral fixtures first, then owner-approved use. The graph need not beat a list for every task. Search, a chronological list and direct links remain first-class.

## One workspace, several useful entrances

Call the destination **Knowledge** or **Explore connections** in user testing; choose one name before shipping. Do not require people to learn graph terminology. Add contextual **Sources & connections** to Memory and Tasks before a new global destination. The full workspace later receives an ordinary rail/drawer link, following the no-overflow-navigation ruling.

Desktop: familiar navigation rail; central 2D canvas or equivalent list; an inspector on the right when an object is selected. A search line and the active question sit above the canvas. Filters sit in a compact row, not a cockpit. The inspector shows title, kind, observed status, why it is connected, evidence, timestamps and one primary canonical action. The rest are quiet text actions. No equal-weight card dashboard.

At about 390px: start with results and the selected object's relationship list. **Show map** is optional; selecting a node opens a full-height detail screen with explicit Back, preserving map focus and scroll. At 340–390px height, the relationship list remains the useful default; controls stay reachable without an inspector overlay consuming the canvas. A portrait tablet may show list + inspector before canvas + inspector. Physical-device testing remains required.

Empty states state what is true: “No source is recorded for this memory” with “Open memory”; “No connections within these filters” with “Clear filters”; “This capture is no longer retained” with the surviving permitted provenance. No constellation is invented for an empty account. Loading says “Loading sources” and shows the retained object; it does not animate relationships as if processing progress were known. Partial/error states name unavailable sources and preserve a dated last observation. Refresh never silently presents an old graph as current.

Use the owner-supplied status artwork unchanged, once in the app's established location. A graph root is a selected task or memory, not a redrawn Nova mark. Status colors retain their established meaning: red only for stopped Nova/work as defined by the status model; amber for attention while running. Entity types use labels, shapes and line patterns, not competing status colors. Nebula and any later approved Jarvis treatment style the same objects and interactions; a theme must not determine feature availability.

## A reference model with explicit authority

A graph node has an opaque stable ID, kind, source pointer (ref_table/ref_id or ref_path), source version, privacy classification and projection revision. Persist relationships, identity mappings and layout preferences; resolve labels/content from their authorized canonical stores at read time. Do not copy source text into graph metadata. Renaming a label never changes identity. A file move updates a registered file identity; path alone cannot provide stable identity. Migration/import needs an explicit mapping and collision tests, not content-hash identity (two identical records may be distinct, and edits must not create unrelated objects).

| Node kind | Authoritative source and identity | Caveat |
|---|---|---|
| Device | device.id plus enrollment lineage | Re-enrollment with a new key creates a new identity; never merge by display name |
| Service / service version | existing topology service identity (machine ID/service ID), version/assignment references | Topology is an observation projection; persist observation IDs/times if historical comparison is added |
| Memory / memory version | memory.id and its correction chain | Record-level identity stays distinct from an optional concept grouping |
| Capture / capture source | capture_event.id / capture_source.id | Respect screening, consent, retention and source permissions |
| Task / run / outcome | task.id and canonical run/event IDs | “Done” and “verified” use existing verifier results, never graph inference |
| Evidence | reference to task report evidence, receipt item, capture promotion or registered artifact version | Some evidence is embedded JSON today; a versioned reference adapter is needed, not guessed IDs |
| Decision | decision_record.id | Only recorded candidates/thresholds can be shown; missing historical detail is labeled |
| Approval / policy version | canonical approval event and versioned policy record | Durable IDs for some policy versions may be new work; graph records authority and never grants it |
| Skill / skill version | installed skill ID + registered version/hash of its Markdown package | Versions are immutable; never call a filename alone a version |
| Schedule / trigger / firing | trigger_rule.id, trigger_id; registered identity for Markdown schedule | Do not collapse a definition and its individual executions |
| File / source version | governed file_provenance plus path/version adapter | Treat arbitrary file contents as untrusted, permission-checked source data |

Stable graph IDs can be namespaced UUIDs derived from a source namespace and canonical immutable ID. Do not expose raw hashes of low-entropy private titles as public identifiers. Composite service IDs remain stable across label changes, but promotion changes the observed service version; it does not silently rewrite past observations.

Edges carry an explicit direction and verb, endpoints, authoritative source reference, assertion method, provenance, confidence (nullable when not meaningful), source revision, valid_at/invalid_at, created_at/expired_at and deleted_at. G1 requires source_id/confidence for inferred edges. Keep a separate method/basis field so a model score cannot impersonate a verified relationship.

Initial edge vocabulary:

- **DERIVED_FROM** memory → capture/file/artifact, from capture_promotion or recorded derivation.
- **SUPERSEDES** memory version → earlier version, directly from correction links.
- **USED_CONTEXT** task/answer → receipt; **REFERENCES** receipt → source version, directly from stored context items.
- **TRIGGERED** firing → task/message; **INSTANCE_OF** firing → schedule/rule.
- **RUN_ON** run → observed device/service, only when the execution record names it.
- **USES_SKILL** run → exact skill version, only when recorded.
- **BASED_ON**, **CITES_PRECEDENT**, **GOVERNED_BY**, **APPROVED_BY**, **PRODUCED**, **EVALUATES** use prospective G2 records. Never reverse-engineer an unrecorded decision from prose logs.
- **HOSTS** device → service is an explicitly dated observation; **ASSIGNED_TO** is separate intent.
- **MENTIONS** or **SUGGESTED_RELATED** are optional inferred relationships. Their names never imply causation, ownership or agreement. Whole-corpus extraction and cluster summaries stay out of scope under the owner's addendum.

Observed edges use solid strokes and an “Recorded” label; inferred edges use dashed strokes and a “Suggested” label. Both open **Why connected?** with the actual source, method, source version and relevant text after authorization. A direct file mention is a recorded mention, not a verified real-world relationship. Co-occurrence is weaker still. Do not display an invented 100% certainty for deterministic database joins. Noul probability remains the probability of its stated yes/no question; graph relationship confidence is a different quantity and must not reuse that number without an explicit definition.

Suggested relationships remain excluded from answers and destructive dependency previews by default. If enabled later, confirming one records a new person assertion with attribution; dismissing one records dismissal without destroying the underlying source. Deleting a person assertion is distinct from deleting the source object.

## Time without false precision

Keep two questions separate: **When was this true?** (valid time) and **When did Nova learn it?** (recorded time). Current memory observed_at/created_at and capture at/received_at support a useful distinction, but do not constitute a fully bitemporal graph. Existing correction links preserve versions; current topology snapshots do not establish a historical series by themselves.

New edges have world-truth intervals valid_at ≤ t < invalid_at and record-truth intervals created_at ≤ r < expired_at, plus deletion state. Unknown valid time stays unknown; file modification time is not evidence of when its claim became true. A late capture can be valid yesterday and recorded today. A correction expires the old assertion's recorded interval while preserving what was believed then, subject to privacy deletion. “As observed on Tuesday” and “Believed true on Tuesday” must be distinct controls. Default is current active information, with an explicit History lens; no silently stale truth.

Forgetting takes precedence over historical exploration. Time travel must not reconstruct deleted content or labels from graph snapshots, caches, logs, exports or source-version previews.

## Search, expansion, explanation and action

Start with deterministic typed search and existing retrieval, using visible scope (this task / personal / work / all permitted), kind and date filters. Selecting a result anchors its one-hop neighborhood. Offer named actions such as **Show sources**, **Show outcomes**, **Show related tasks**, and **Show device dependencies**, rather than an unexplained “Expand” button alone. A two-hop path says what each edge means. Path length never becomes truth or relevance on its own.

Question-driven navigation can begin with explicit query templates for the questions above. Natural-language answers are a later optional interface over exactly the same authorized result set. Each answer claim links to its supporting path and canonical evidence; unsupported or contradictory evidence is disclosed. The answer records retrieval time, source versions and processing destination. Local-only queries and layout never invoke a cloud model. A configured local provider may help phrase an answer, but graph browsing, search and evidence access work without any model. A cloud-assisted question receives only the explicitly permitted scoped context; reading a local private file with a cloud model is disclosure, even if the file stays on disk.

A focus trail records anchor, filters, selected path, view mode and camera state. Back/Forward restores them. Pinning objects affects layout only, not importance or truth. Refresh holds surviving nodes in place; deleted objects leave immediately and selection becomes a content-free explanation. Saved views contain IDs and filters, not cached private titles, and must reauthorize every opening. Sharing/export is an explicit separately scoped action and not implied by a saved view.

“Open in Memory”, “Review task”, “View capture”, “Pause automation” and “Inspect device” navigate to canonical surfaces; the existing surface owns mutation, approval, stale-state checking and confirmation. A graph click cannot approve a task, bypass a tier or reveal a secret. Do not duplicate every form in the inspector.

## Privacy and deletion must shape the graph

Filter server-side before returning nodes, edges, counts, paths or layout inputs. Both endpoints and the relationship itself need permission. A visible object with a hidden neighbor must not disclose the neighbor's title, type, degree, existence, timing or a revealing “1 private connection” placeholder. Omit unauthorized edges before computing counts/ranking; do not send them to the browser and hide them with CSS. Do not reveal a hidden object through a path between two visible objects. Autocomplete, empty messages, snapshots and saved-view names need the same policy. Cross-scope expansion is an explicit control, not a default surprise.

Apply capture screening and memory eligibility at retrieval as well as ingest. Keep quarantined evidence out of model context and default knowledge results. An authorized inspection action can show a clearly labeled quarantine state through its existing review surface. Credentials, broker handles and secrets never become graph content; at most a permitted task may reference a nonsecret capability label.

Use the owner's invalidate → tombstone → purge design. A revoked/deleted source is suppressed immediately on every online query and subscription; tombstones synchronize through the existing mesh, never through graph traversal. Offline spokes retain non-content tombstones until acknowledged; purge/rebuild cannot resurrect source rows from old graph indexes. Traverse recorded DERIVED_FROM closure: sole-source derivatives are removed, multi-source derivatives are re-derived without the deleted source, ambiguous derivations await explicit review. The interface can say “Removed here; waiting for 1 offline device” only to an authorized owner, without retaining forgotten content. The exact offline-spoke retention/acknowledgment policy requires the graph ADR and deletion owner's review.

Graph indexes, layouts containing labels, screenshots, search/vector indexes, summaries, model prompt caches, old backups and checkpoint restores all enter the deletion inventory. Redaction of a node label alone is inadequate. Restore must apply current tombstones before serving any graph query. A privacy revocation invalidates open browser caches; an SSE disconnect must force reauthorization before reuse. Export artifacts already taken outside Nova have a separately stated boundary; never claim to retract copies Nova cannot control.

No data leaves for graph analytics, layout, fonts or telemetry. Compute layout locally in a browser worker over an authorized bounded subgraph. If permitted LAN model/services are used, classify them separately from external egress. Optional remote answering must show the destination and source scope and record a receipt; retries/fallbacks keep the effective privacy policy.

## Scale and accessibility are part of the first version

The following are proposed acceptance targets, not measurements from this audit. Start at 50 nodes, allow 200 expanded visible nodes / 1,000 edges per focus view, and page neighbors in stable groups of 25. Explain truncated results and provide filter/search instead of a silent hard cap. Keep a server hop cap of two for ordinary exploration; bounded TypeScript BFS has a visited set, fan-out/node/time caps and cancellation. If any recursive CTE is used, keep the owner's maximum of three hops. Index endpoint+relation+active-time lookups. Keyset cursors and query revisions prevent duplicate or lost neighbors during updates. Benchmark 10k/100k reference records and hubs with many links; graph query p95 <200ms and interactive input <200ms on the agreed modest-hub test machine are initial engineering budgets, to validate rather than claim.

Do not load the whole graph or all source text to draw a neighborhood. Chunk changes by authorized revision; rebuild projections idempotently from authoritative records; write source relationship events transactionally or with a durable outbox so an index can catch up after a crash. Record lag and expose it. Keep node coordinates by stable ID and view scope; newly expanded nodes arrange around the anchor without moving the existing neighborhood. Layout remains deterministic within a view revision. Stop work for hidden tabs, cancel stale requests and degrade to list rendering on resource pressure.

The nonvisual representation is an equivalent semantic relationship list: object heading → grouped named outgoing/incoming relationships → evidence → canonical actions. It has identical filtering, pagination and permissions. Canvas is supplemental. Keyboard users can search, choose a result, Tab among controls, open relationship groups, select neighbors and return with Escape/Back without a global application-role trap. Arrow traversal is optional within a clearly labeled map mode and never the only route to disconnected nodes. Announce selection/result counts and completion briefly; do not narrate continuous layout changes.

Use visible focus that survives inspection and reload; 24 CSS px is the WCAG 2.2 minimum target subject to its exceptions, but Nova's existing 44/48px design target is the implementation goal. No drag-only operation: offer buttons to pan/zoom, Fit selected, Reset view and a list alternative (WCAG 2.5.7). Preserve text at 200%/400% zoom, 320px reflow, contrast, labels, and focus not obscured by inspectors. Phone gestures must not prevent ordinary page scrolling. Reduced motion disables drift, auto-orbit, parallax and animated travel entirely; transitions can be immediate. Respect battery/resource constraints regardless of motion preference. Test screen reader journeys, keyboard-only, touch and high contrast separately; screenshot approval cannot establish these properties.

## Optional immersive 3D: a question to validate

3D is a different view of the same authorized nodes, edges, filters and selection, not another ontology or storage engine. Its credible potential is spatial separation of crossing dependency paths: for example devices/services on one layer, tasks/runs on a second, evidence on a third. A fixed up direction, named layers and the selected path can help a user follow a device failure into affected work and supporting evidence. This is a hypothesis. It is less useful for reading prose or comparing timestamps, so lists and 2D remain the default for those jobs.

Start with a constrained 2.5D layer view, not free-flight space. Offer rotate by fixed steps, zoom, fit selected path, named layer buttons, Home and a breadcrumb trail. A small orientation indicator, persistent anchor label and selected path keep location clear; Back restores the prior pose. No automatic camera travel, idle orbital animation or decorative particle field. The chosen source/evidence inspector stays a standard accessible panel. Switching 2D ↔ 3D preserves objects, filters and history; unsupported WebGL, reduced motion or low resources always have an immediate complete 2D/list path. User-supplied status artwork remains an image asset in the app shell, not a procedural sun.

Before product investment, compare constrained 3D against the 2D dependency lens on three tasks: identify the failing service, enumerate affected tasks, and explain one evidence path. Use at least five representative self-hosters, record completion/error/orientation recovery and a motion-comfort check. A proposed advancement threshold is at least 20% median improvement on one dependency task with no increase in errors or abandonment, and full task parity through the accessible representation. These are prospective decision criteria, not research findings. If it misses them, retain the useful 2D layer lens and park 3D. There is no basis here to recommend ambient animation, gamification, whole-corpus AI extraction or a mandatory tour.

## Read-only assessment of PR #207: Stellar Map

The GitHub connector reported an **open draft, unmerged, nonmergeable** PR with head **5e0fe8b8de4a429bf1613d0da8abfcebdc6114c1**, base **04512c07c39b7cda45894f87b031b00e091e3979**, and 33 changed files. Metadata and selected patches are saved under evidence/pr207-*. No PR mutation, branch checkout or live PR interaction was performed. Its screenshot/test/performance statements are the PR author's claims, not tests reproduced by this audit.

Useful ideas worth carrying into a new approved design:

- A reason and source in the inspector for every body; direct editing/forgetting via the same existing memory mechanisms.
- Search that brings a relevant object into focus, small/medium/large scales, deterministic placement seeds and a List alternative.
- Keyboard travel, pinch/drag, reduced-motion paths and WebGL fallback are present in code. They establish implementation intent, not accessibility conformance.
- Density reduction acknowledges that a full graph cannot remain legible at arbitrary size.

Limitations and incompatibilities:

1. Its data path is src/map.js buildMap(home), reading files synchronously and rebuilding the entire map per GET /api/map. It neither consumes the current SQL memory/capture/receipt/decision relations nor implements the queued graph tables. Port the useful interaction ideas through the new adapters; do not merge its data plane as the architecture.
2. People/topics/groups/goals depend on a proposed file convention and prompt/tool writes. Names and first-name matches create “stated” links; co-mentions create “together” links, and a memory orbits the first matched entity (src/map.js new lines 128–205). An unmentioned MEMORY.md entry is assumed to be about the owner. These heuristics are not authoritative knowledge or causal relationships.
3. “Strength” is a salience formula over link counts, not calibrated confidence. File paths/mentions in a short why list cannot stand in for edge evidence, valid time, policy or source version. The map must not make this look more certain than the underlying data.
4. It is Nova-theme-only by PR design; this conflicts with equal capabilities across themes. Its procedural core/body rendering is not an acceptable replacement for the owner's current status artwork. Preserve the image asset and derive graph styling from the approved current design.
5. MAX_VISIBLE=300 triggers aggregation only for certain moon/asteroid classes (src/map.js new lines 229–237). It is not a total response/node bound; people/topics/goals and underlying reads can grow without it. Aggregates embed entry text. Authorization before expansion and deletion propagation require new architecture, not just a visual stack.
6. Refresh failure keeps the last sky with an empty catch (ui/js/stellar/map.js new lines 226–233). Carrying over this interaction would hide freshness and deletion failures. Add a dated stale state and privacy invalidation behavior.
7. Canvas and labels are aria-hidden and root uses role=application with neighbor-arrow navigation (new lines 62–90,566–595). There is a List fallback and live text, but equivalent traversable relationships and disconnected-node discoverability need validation. The PR's stated software-renderer speed is not device performance evidence; physical phone and modest-hub testing remain necessary.

Recommendation: leave #207 untouched. Preserve it as a visual research reference. Reuse ideas selectively after the current graph ADR and rendered-entry review; do not treat draft existence as a missing shipped feature to force through.

## Three independently useful, shippable slices

Efforts are builder engineering ranges, assuming one experienced engineer with design/QA support, no product repairs folded into them, no new graph database, and the required ADR/rendered approvals already obtained. The prior owner queue remains authoritative. The graph compilation pilot is a separate gated track; these navigation slices do not authorize it or bypass its one-week real-run observation.

### Slice 1 — Explain one memory (5–8 engineering days)

**Outcome:** From an existing memory, identify its actual sources and open them without learning the whole system.

**Surfaces/interactions:** Memory detail → Sources & connections; a small 2D one-hop diagram and equivalent list; source inspector; Open capture; corrected-version history; Back restores memory location. Reuse current capture provenance and correction APIs. A user sees “No source recorded” for unsupported cases, not invented links.

**Data:** Minimal reference-only graph adapters/schema approved in the ADR; memory.id, capture_promotion, source retention/screen state and correction links. Do not add inference, cloud calls, full-text/vector replacement or a general natural-language answerer. A query-time projection over existing relationships can keep the first slice small, provided it uses the agreed graph DTO/identity contract and does not become a second persistent graph.

**Acceptance:** On neutral fixtures with direct source, corrected memory, expired capture, unauthorized capture and no source, a new user identifies provenance and uncertainty in ≤60 seconds without help in four of five trials. All source opens land on the canonical record. Keyboard and semantic-list users complete the same flow. Deleted/revoked sources disappear from open views after reauthorization, counts and paths included. At desktop, 390px wide and a 360px-high viewport, no required control is hidden. No egress occurs for browsing; an isolated forget/restore canary does not resurrect a label or edge. Source integration tests plus browser journey/read-back cover these cases.

**Dependencies/decision:** Graph ADR + source-pointer contract, source permission policy, any deletion repairs from this audit, rendered styleguide approval. The first owner response should be to this working narrow journey, not an elaborate universe.

### Slice 2 — Find connected work in 2D (3–5 engineering weeks)

**Outcome:** Answer “Have we done this before?” and “What did this result use?” across tasks, memories, captures, receipts, skills and schedule firings.

**Surfaces/interactions:** A normal Knowledge rail/drawer destination; typed search, one/two-hop question lenses, filters, neighborhood paging, inspector, history and canonical actions. Task/receipt deep links enter at the matching anchor. Saved views keep IDs/filters only. Accessible list and 2D share the same response.

**Data:** Versioned adapters for task/evidence/receipt/trigger/skill references; source authorization before graph queries; incremental updates/outbox and deletion closure. Preserve the current search implementation until measured needs justify the separately scoped FTS5/vector migration; no unbuilt dependency is assumed. Prospective G2 fields are added only where producers can record them truthfully.

**Acceptance:** The eight question templates above each have a fixture showing supported answer/path or a precise unavailable state. Users reach the correct evidence from a task in ≤3 intentional selections in four of five trials. Browser Back restores anchor/filter/selection. Under 10k and 100k synthetic references, bounded requests meet agreed p95 latency and never exceed declared node/edge/hop caps; cancellation stops obsolete work. Hidden-neighbor/path/count canaries disclose nothing. Offline/retry/restore tests preserve deletions. Keyboard/screen-reader workflows, touch, 200%/400% zoom, both approved themes and reduced motion pass. No model is required for the end-to-end journey.

**Dependencies/decision:** Slice 1 identity/policy, evidence version adapter, transaction/outbox strategy, affordable local search measurements. Candidate/precedent data that was never recorded stays absent; do not backfill it by inference.

### Slice 3 — Explain system changes and affected work (2–4 engineering weeks)

**Outcome:** From a failing or changed service, see the work it actually affected and distinguish current state from late or stale observations.

**Surfaces/interactions:** Knowledge Operations lens; entry from Health/Topology; device → service → run/task paths; a temporal list and bounded before/after comparison; Open device/Review task/Review deployment links. Compare intended assignment with observed service state. This slice is valuable in 2D even if immersive 3D is never built.

**Data:** Canonical topology snapshot/service identities, durable observation IDs, actual run placement links, prospective validity/record times and source versions. Preserve per-source freshness instead of merging all observations into a timeless healthy edge. Link only observed run placement; show unrecorded where not available.

**Acceptance:** Synthetic service-failure, assigned-but-not-running, stale heartbeat, delayed report and recovery scenarios produce correct paths and explicitly bounded impact (“3 recorded runs affected; other runs have no placement record”). A user identifies the correct next action in ≤90 seconds in four of five trials. Time controls distinguish “true at” and “known by” using a delayed-observation fixture. No mutation bypasses existing approvals. Repeated refresh leaves unchanged nodes stable, invalidates revoked source data and preserves keyboard focus. Same local-only/network and accessible alternatives as slice2.

**Dependencies/decision:** Slices 1–2, observation retention policy, prospective placement/decision data quality and privacy-safe historical queries. A separate 2–5 day constrained 3D prototype may evaluate the task benefit after this slice; shipping3D remains a later owner choice backed by that result.

## Backlog records for consolidation

### NOVA-060 — Establish the real graph baseline and its gated design

- **Category / gap:** investigation; supplied assumption correction and prerequisite for proposed expansion (D), not a confirmed current product defect.
- **Severity / priority:** moderate planning risk / P2, before any graph implementation; high confidence.
- **Evidence class / baseline:** observed isolated schema + source + documented future requirement; merged d948aa0a; deployed unknown.
- **Affected user / consequence:** owner/builder could size a graph UI as a view over nonexistent graph tables, duplicating storage or skipping deletion/permission design.
- **Repro / observed / expected:** Run diagnostics/graph-baseline.mjs; version27 contains no graph_nodes/edges. Source search confirms absence. Expected audit baseline accurately distinguishes existing relational foundations from planned G1–G6.
- **Evidence/root cause:** graph-schema.json; core/db.ts:24,106; graph addendum:3,17. The starting description conflates the SQLite substrate and queued graph design; no faulty product root cause is established.
- **Smallest coherent change / components:** publish an ADR/current-capability inventory that maps canonical entities, missing identity/time/provenance fields, privacy and tombstones; no code in this task. Architecture docs and future SQLite adapters.
- **Dependencies / decisions:** after A1/A2 per owner queue; required second-model review; reconcile whether FTS5/sqlite-vec migration belongs in the first graph slice. Restricted threat-model owner-side review remains needed.
- **Acceptance / verification:** every proposed node/edge names a verified producer or explicitly new work; schema check and source inventory match the pinned release; owner/builder can estimate slice1 without assuming graph tables or vector indexes exist.
- **Effort / status:** 2–4 engineering/design days for ADR/inventory, excluding review latency; proposed, audit complete.

### NOVA-061 — Make a memory's source trail a small usable graph/list

- **Category / gap:** improvement / D; low severity, P2 after committed repairs; high confidence in technical feasibility, medium in usability benefit pending trials.
- **Evidence / baseline / consequence:** source-backed opportunity at merged d948aa0a; current capture_promotion/provenance and correction APIs can support a contextual journey. Users otherwise must reconcile concepts across surfaces; no runtime failure is asserted by this record.
- **Repro / observed / expected:** inspect capture/routes.ts:52 and memory.ts:189 alongside current Memory detail. Existing relationships are stored; proposed expectation is the Slice 1 journey, not a previously agreed shipped graph requirement.
- **Root cause / smallest change:** relationships are subsystem-specific; add one authorized projection and Sources & connections detail in existing Memory. Do not duplicate record contents or mutation handlers.
- **Components / dependencies:** SQLite/core capture+memory query adapters, Memory UI/styleguide, existing delete/restore and auth boundaries; NOVA-060 and Slice 1 dependencies.
- **Acceptance / regression / effort:** all Slice 1 criteria above, including permission/deletion canaries and observable user task; 5–8 engineering days under stated assumptions.
- **Status:** proposed expansion; no implementation.

### NOVA-062 — Build the bounded 2D knowledge workspace

- **Category / gap:** improvement / D (aligned with queued graph direction); medium product opportunity, P3 until repairs and Slice 1 response; medium confidence in user value.
- **Evidence / baseline / consequence:** source relations described above, merged d948aa0a; no deployed graph test. Cross-system explanation requires joining records conceptually; a unified projection can reduce this work.
- **Repro / observed / expected:** follow existing task report, receipt and capture references across canonical APIs; no generic graph tables/query UI exists. Expected is proposed Slice 2, not a claim that the roadmap already shipped it.
- **Root cause / smallest coherent change:** no shared reference/relationship projection. Add the scoped graph contract, deterministic typed querying, bounded 2D/list navigation and source-version inspector. Preserve each source as authority.
- **Components / dependencies:** core graph adapters/SQLite migrations, event/outbox integration, navigation/styleguide, privacy/redaction/restore; NOVA-060/061 and deletion fixes. Do not infer historical G2 traces.
- **Acceptance / regression / effort:** Slice 2 criteria; 3–5 weeks, one engineer plus design/QA, no real model evals.
- **Status:** proposed, gated architecture expansion.

### NOVA-063 — Add an operational and temporal lens before evaluating3D

- **Category / gap:** improvement with bounded follow-on investigation / D; low severity, P3; medium confidence in 2D value, low confidence in 3D benefit.
- **Evidence / baseline / consequence:** topology.ts:25,55,70 and PR207 reference patches; merged d948aa0a plus PR207 head 5e0fe8b8; deployed unknown. Current observations can explain machines but cannot provide historical impact without prospective data.
- **Repro / observed / expected:** inspect topology freshness and assignment-vs-live fields; no generic temporal graph exists. Proposed expectation is Slice 3's honest impact journey; 3D is not an unmet commitment.
- **Root cause / smallest change:** persist authorized observation/run-placement references and expose timeline/impact lens over the same 2D/list graph. Evaluate constrained 3D separately against explicit tasks, never as default navigation.
- **Components / dependencies:** topology/service/run producers, retention and time queries, graph/list UI, optional renderer. Slices 1–2; owner decision on retention and 3D usefulness. PR207 stays untouched.
- **Acceptance / regression / effort:** Slice 3 criteria; 2–4 weeks for shippable 2D operations lens, 2–5 additional days for a nonshipping 3D prototype and study preparation; study/recruitment time separate. Ship 3D only if the stated benefit/accessibility gate passes.
- **Status:** proposed; 3D benefit unverified.

## Coverage and limitations

| Surface/workflow | Role/mode | Theme/viewport | State | Result | Evidence |
|---|---|---|---|---|---|
| Fresh SQLite schema inventory | isolated synthetic DB; no network/model | N/A | migration 0→27 | tested-pass | graph-schema.json and graph-baseline.mjs |
| Named generic graph table claim | source + isolated DB | N/A | current merged build | tested-fail (starting claim only) | no graph_nodes/graph_edges after all migrations |
| Existing memory/capture/receipt/decision relations | static source review | N/A | current implementation | untested (runtime); code-inspected | file:line references above |
| Current topology projection semantics | static source review | N/A | fresh/stale/assigned/live branches | untested (runtime); code-inspected | services/topology.ts:25,55,62; topology-view.js:31 |
| PR207 metadata and selected code | read-only GitHub; draft head 5e0fe8b8 | Nova-theme proposal | unmerged | tested-pass (read-only retrieval only) | pr207-metadata.json; four patch files |
| PR207 rendering/interactions/performance/accessibility | none | no runtime/physical device | draft | untested | no claims of reproduced PR author tests |
| Full knowledge/2D/3D plan | proposed design | desktop/phone/short-fold target | not built | untested | acceptance targets above, not measurements |
| Owner preview and deployed graph state | host unavailable | unknown | unknown | blocked | root baseline records |

No external threat-model content, owner memory, actual credentials or live model data was used. All fixture execution was an in-memory schema migration; no product code was edited. These knowledge findings are design/backlog contributions to the audit, not a substitute for the root review's running-app evidence.
