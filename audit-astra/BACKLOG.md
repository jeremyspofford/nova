# Prioritized implementation backlog

Audit only. All records concern merged `d948aa0a442a9f930b86f4516eeea21981b76714`; runtime evidence is disposable and synthetic unless stated. Owner-deployed applicability is unknown. No item is implemented. The project builder owns implementation after consolidation. Research Part 3 is a parked owner decision and is deliberately absent from this implementation backlog.

Severity is consequence, priority is sequence. Potential severity belongs to investigations and is not a confirmed incident. Estimates assume one familiar builder and existing harnesses; they exclude review/access delays and overlap. Graph estimates are proposals after existing ADR/owner gates. The index below is the consolidated triage authority if a working contribution uses a different priority.

| ID | Category | Severity | Priority | Finding |
|---|---|---|---|---|
| [NOVA-001](#nova-001) | defect | high | P0 | Revalidate privacy before an inference fallback sends context |
| [NOVA-020](#nova-020) | defect | high | P1 | Dated-note paths do not honor the core memory deletion lifecycle |
| [NOVA-023](#nova-023) | defect | high | P1 | A forgotten note remains in the next step of an active chat |
| [NOVA-021](#nova-021) | defect | medium | P1 | Capture reports global deletion while a backup still owes it |
| [NOVA-005](#nova-005) | unmet commitment | high | P1 | Preserve capture provenance and screen it at recall before model context |
| [NOVA-002](#nova-002) | investigation | high | P1 | Resolve “local-only” versus the cloud-screening exception |
| [NOVA-003](#nova-003) | unmet commitment | high | P1 | Complete broker consumer migration before claiming broker-only credential access |
| [NOVA-004](#nova-004) | investigation | high potential | P1 | Establish all-process local-only enforcement and evidence |
| [NOVA-081](#nova-081) | defect | medium | P1 | Older Memory reads can redraw content after a newer read removed it |
| [NOVA-086](#nova-086) | defect | medium | P1 | Keeping an imported memory changes its source label to a conversation |
| [NOVA-085](#nova-085) | defect | medium | P1 | First-use import instructions name the wrong host folder |
| [NOVA-084](#nova-084) | defect | medium | P1 | Home implies a daily Brief can be configured, but the card has no workflow |
| [NOVA-040](#nova-040) | defect | medium | P1 | Replace the obsolete entry-point documentation with the current product contract |
| [NOVA-082](#nova-082) | unmet commitment | medium | P1 | Finish the Memory workflow before expanding the knowledge graph |
| [NOVA-083](#nova-083) | unmet commitment | medium | P2 | Complete ordinary rule authoring instead of exposing an empty rule collection |
| [NOVA-080](#nova-080) | defect | medium | P1 | Pipeline misclassifies design work and hides the evidence needed to judge it |
| [NOVA-041](#nova-041) | unmet commitment | medium | P2 | Complete the promised release version/tag workflow |
| [NOVA-006](#nova-006) | improvement | medium | P2 | Explain what cloud chat receives before the first send |
| [NOVA-042](#nova-042) | improvement | medium | P2 | Make new serious accessibility regressions fail a targeted CI gate |
| [NOVA-120](#nova-120) | defect | medium | P2 | idle and thinking are visually identical in the Canvas2D fallback |
| [NOVA-121](#nova-121) | improvement | medium | P2 | Home's first short-height viewport contains no useful action or work state |
| [NOVA-100](#nova-100) | improvement | medium | P2 | Distinguish running health from capability readiness |
| [NOVA-044](#nova-044) | improvement | medium | P2 | Qualify Docker capabilities before reporting Nova Computer available |
| [NOVA-043](#nova-043) | defect | low | P2 | Send M9 screenshots to the configured evidence directory |
| [NOVA-045](#nova-045) | investigation | high potential | P1 | Qualify the failed process-lifecycle checks on a compatible host |
| [NOVA-046](#nova-046) | investigation | low | P3 | Recheck narrow-tablet prose width with the optional pane open |
| [NOVA-022](#nova-022) | improvement | low | P3 | Explain the boundary of user-requested memory exports |
| [NOVA-060](#nova-060) | investigation | medium planning risk | P2 gated | Establish the real graph baseline and its gated design |
| [NOVA-061](#nova-061) | improvement | opportunity | P2 gated | Make a memory's source trail a small usable graph/list |
| [NOVA-062](#nova-062) | improvement | opportunity | P3 gated | Build the bounded 2D knowledge workspace |
| [NOVA-063](#nova-063) | improvement | opportunity | P3 gated | Add an operational and temporal lens before evaluating3D |

<a id="nova-001"></a>
## NOVA-001 — Revalidate privacy before an inference fallback sends context

Consolidated triage: **defect · severity high · P0**. Supporting review: [source](contributions/privacy.md).

- **Category:** defect. **Severity:** high (private context can leave after a local-only change). **Priority:** P0, immediate before broader privacy claims. **Confidence:** high. **Evidence:** observed synthetic runtime + code + documented requirement. **Status:** open, reproduced; no implementation attempted.
- **Affected user/consequence:** anyone switching to local-only while a slow/failing local model has a cloud fallback configured. Their current request may still go to cloud and its receipt describes the earlier mode.
- **Baseline:** merged d948aa0a and disposable Core instances of it; owner's deployed build unknown.
- **Reproduce:** run `PATH=/workspace/.nova-tools/node-v26.3.1-linux-x64/bin:$PATH node audit-astra/diagnostics/privacy-mode-race.mjs`. Start reasoner inference with local-preferred and configured cloud; hold local HTTP response; save local-only; return local 500. **Observed:** live profile local-only, one cloud-class route request with canary, receipt local-preferred. **Expected:** no new remote send after policy tightens; wait/retry locally with an accurate receipt. Control starting local-only correctly makes zero cloud requests.
- **Evidence/root cause:** `evidence/privacy-mode-race.json`; `src/core/models/index.ts:691` snapshots mode and `:693` order before awaiting local work; `:890`/#cloud uses the stale mode; `src/core/receipts.ts:107` live-mode recheck applies only to Jev/opt-in receipts, so ordinary cloud fallback slips through.
- **Smallest coherent closure/components:** re-read the strictest live/run/task privacy immediately before every remote attempt; make receipt enforcement a live policy backstop for all remote providers. Update Models, Receipts, and the model-manager integration test. Do not merely change the displayed receipt or disable cloud fallback globally.
- **Dependencies/decisions:** no owner policy decision needed for this race; it violates even the current promise. Keep NOVA-002's deliberate screening exception separately accounted for until resolved.
- **Acceptance/regression:** controlled local-response barrier; change to local-only, then fail local; assert zero cloud HTTP requests, no allowed remote receipt, actionable waiting state. Include unchanged local-preferred success control, starting-local-only control, multiple concurrent requests, task stricter than profile, and profile/provider changes while awaiting local/wake work. No real model calls.
- **Effort:** 1–3 engineer days including focused integration tests/review; assumes existing policy/receipt APIs can take a live getter. A centralized transport redesign is not required to close this defect.

<a id="nova-020"></a>
## NOVA-020 — Dated-note paths do not honor the core memory deletion lifecycle

Consolidated triage: **defect · severity high · P1**. Supporting review: [source](contributions/data-integrity.md).

- **Category / gap:** defect; C, exposed behavior incomplete. Two symptoms share the legacy file-note lifecycle and should close together.
- **Severity / priority:** high privacy and recovery integrity; P1, immediate committed-product repair.
- **Confidence / evidence:** high; synthetic observed behavior plus established code path and documented complete-forgetting requirement. No owner-preview claim.
- **Affected user / consequence:** anyone who edits or forgets remembered information or a dated note. A prior wording remains searchable after “Forgotten”; a directly deleted day note survives in an existing backup and is restored later.
- **Baseline:** merged `d948aa0a…`; disposable module-composed runtime of that source. Deployed build unknown.
- **Reproduction A:** create a fact and a day note with the same content and source; correct the fact to materially different words with a newer source; invoke `runner.memory.forget(newId)` (the Memory UI's `/api/memory/:id/forget` path); search for the original words. Observed: core memory list empty, old dated note returned. Expected: every wording and its corresponding note copy are no longer recalled.
- **Reproduction B:** create a dated note, take a nightly backup, forget the note through the same public method, restore that backup into another disposable home. Observed: live note removed, backup and restored home retain `AUDIT_CANARY_DAYNOTE`. Expected: a Nova-managed backup cannot resurrect a forgotten note, or deletion must visibly remain pending if a copy cannot be reached.
- **Evidence:** `evidence/data-forget-probe.log`; `src/memory.js:383` branches note-only deletion straight to `removeEntry`; `:394` suppresses the core all-record file callback; `:402` removes twins only for the latest wording; `:407` otherwise handles every history record. `src/server.js:419` routes Memory UI forget through this method; `ui/js/app.js:1043` calls it and `:1048` says “Forgotten.”
- **Root cause:** two memory representations share a UI but not a single deletion contract. Direct notes do not enter backup deletion; the UI/undo path bypasses the all-history cleanup used by core API deletion. Lexical twin detection is not durable provenance and should not be the only way to find derived copies.
- **Smallest coherent repair:** make both current routes invoke one deletion coordinator that snapshots the whole affected chain and explicit note identities before deleting, scrubs dated-note copies, recovery copies and sync carriers, and produces a result with remaining obligations. Preserve explicit temporary Undo without allowing old backups to silently recreate deleted data. Immediate fix may keep dated notes as files; do not require a graph rebuild first.
- **Likely components:** `src/memory.js`, `src/server.js`, core memory/backups, nightly/checkpoints, sync, Memory forget/undo UI.
- **Dependencies / decisions:** coordinate with NOVA-021 completion status and NOVA-023 prompt invalidation. Clarify the narrow lifetime of an intentional Undo payload; user-owned exported copies are a separate boundary (NOVA-022), not permission to purge arbitrary files.
- **Acceptance criteria:** reproduce both cases through actual HTTP and Memory UI; after success neither wording is in search or subsequent prompt assembly; nightly and encrypted backups and checkpoints restored into fresh homes do not recover either canary; absent disks produce pending status and are cleaned before restore/use on return; unrelated notes remain. Restart and second-device sync must not recreate the items. A user can use Undo once and sees exactly what is restored.
- **Regression verification:** add behavioral cases to existing memory/API and recovery suites, with literal-byte scan of synthetic fixtures plus actual restore/read-back. Include old/new wording with low lexical overlap, a direct note, hand-written note and correction chain, and a retained unrelated note. Existing green tests only cover uncorrected twins or core API deletion and did not catch these paths.
- **Effort / status:** 3–6 engineering days including affected regression matrix, assuming no schema migration; more if replacing heuristic note relationships. Open, confirmed, audit only.

<a id="nova-023"></a>
## NOVA-023 — A forgotten note remains in the next step of an active chat

Consolidated triage: **defect · severity high · P1**. Supporting review: [source](contributions/data-integrity.md).

- **Category / gap:** defect; C, deletion lifecycle incomplete for in-flight context.
- **Severity / priority:** high privacy risk; P1, immediate committed-product repair.
- **Confidence / evidence:** high; real createNova with a scripted in-process actor. This proves prompt contents, not a remote provider transmission or ability to retract context already delivered.
- **Affected user / consequence:** someone forgets a note while Nova is working or waiting between tools. Nova can re-send the deleted note to its next model call even though current search is empty. A cloud actor would receive newly assembled deleted content; previous model calls cannot be undone.
- **Baseline:** merged `d948aa0a…`; disposable loopback server, local-only fake actor.
- **Reproduction:** plant a dated note older than yesterday, ask a matching question, pause the fake actor's first response, forget the note, confirm live search is empty, release the actor with a benign `nova_devices` tool call, inspect its next prompt. Observed: two actor calls; second prompt still contains canary. Expected: after deletion commits, any subsequent prompt assembly omits it and the affected run is invalidated or rebuilt.
- **Evidence:** `evidence/data-recall-probe.log`, second scenario; `src/runner.js:357` reads `recall` once before the loop; `:392` reuses that array on every step; `src/context.js:145` serializes its content directly. `src/runner.js:391` does refresh curated MEMORY.md, so this is specifically stale recalled-note data and other preassembled state, not a claim that all memory is frozen.
- **Root cause:** run-level recall is a content snapshot without a deletion/version check or forget subscription. Deleting storage does not invalidate active run context.
- **Smallest coherent repair:** resolve recalled IDs against current authoritative state before every model call, removing missing/superseded items and reapplying privacy/screening policy; subscribe active runs to deletion/version changes or cancel/rebuild a pending step. Hash/version checks must occur after asynchronous preparation and immediately before dispatch. Do not promise to retract bytes already sent.
- **Likely components:** runner loop/context builder, memory/file-note IDs and versioning, deletion coordinator/receipts.
- **Dependencies / decisions:** align NOVA-020 note identity and privacy agent's capture-recall gate. Define a visible message when a turn is restarted because its source context was removed; no owner policy decision needed to stop future sends of already forgotten data.
- **Acceptance criteria:** forgetting before first dispatch, during a tool wait, between steps and during a provider retry prevents canary from appearing in every later dispatched prompt. Current receipt hashes match the filtered context. A changed correction is used only if still authorized. Existing completed turns remain honest about already-used sources and show deleted-source references without content.
- **Regression verification:** deterministic fake-actor barriers, no sleeps or real models; pair deletion with unrelated retained note positive control; run under local and remote-labeled stand-ins and capture actual dispatch arguments.
- **Effort / status:** 2–4 days assuming stable IDs for dated notes; overlap with NOVA-020 and recall-gate work can reduce duplication. Open, confirmed.

<a id="nova-021"></a>
## NOVA-021 — Capture reports global deletion while a backup still owes it

Consolidated triage: **defect · severity medium · P1**. Supporting review: [source](contributions/data-integrity.md).

- **Category / gap:** defect; C, misleading completion status.
- **Severity / priority:** medium integrity/trust risk (retained data exists); P1, immediate alongside deletion repairs.
- **Confidence / evidence:** high; direct synthetic observation and code. The eventual backup cleanup succeeds; do not describe it as a failure of that cleanup.
- **Affected user / consequence:** a person forgetting capture while a backup drive is unavailable can believe all retained copies are gone and stop following up.
- **Baseline:** merged `d948aa0a…`; disposable core, no deployed-preview claim.
- **Reproduction:** ingest one synthetic local event; take a nightly backup; rename only the fixture backup directory to simulate an unavailable drive; call capture forget; inspect response and owed backups. Observed `everywhere:true`, `said:"Deleted everywhere."`, one owed deletion, and canary still in backup DB. On restoring the directory and applying owed deletion the row disappears. Expected: “Deleted here; waiting for the backup folder…” and global completion only after all recorded holders acknowledge.
- **Evidence:** `evidence/data-capture-forget-probe.log`; `src/core/capture/capture.ts:680` computes completion solely from device acknowledgements; `src/core/resilience/backup.ts:382` maintains a separate owed list; `:411` exposes it; `:424` applies it when available.
- **Root cause:** capture's success result has no backup/checkpoint obligation input. Comment describes the stronger global rule, calculation implements only device completion.
- **Smallest coherent repair:** carry a shared deletion operation/result through backup and device handlers; report local deletion plus pending holders. Avoid saying “everywhere” if any cleanup failed or is owed. Link the result to Health/Backups for the remaining action and update it when the folder returns.
- **Likely components:** capture deletion response/routes, backup coordinator, Health/Capture status rendering, deletion event persistence.
- **Dependencies / decisions:** NOVA-020 should use the same status contract; define unknown holder state conservatively, while making explicit exports a documented exception.
- **Acceptance criteria:** a synthetic unavailable backup and an offline device each prevent global-success wording; neither one is hidden when both exist. Returning the backup changes its obligation to complete only after verified cleanup; failed cleanup names the remaining action. Users can find which copy is outstanding from the forget result without searching logs.
- **Regression verification:** API/UI assertions against returned pending state, actual backup-byte check before/after, restart persistence, combined device+backup scenario and a fully cleaned positive control.
- **Effort / status:** 1–3 days if existing owed metadata can be joined into a durable operation; 3–5 if a shared completion record is required. Open, confirmed.

<a id="nova-005"></a>
## NOVA-005 — Preserve capture provenance and screen it at recall before model context

Consolidated triage: **unmet commitment · severity high · P1**. Supporting review: [source](contributions/privacy.md).

- **Category:** unmet commitment. **Severity:** high for captured outside content reaching an acting model; **Priority:** P1 before expanding automatic recall/graph answers. **Confidence:** high for missing recall gate; medium for specific real-world exploitation risk. **Evidence:** code + explicit unshipped requirement; synthetic context witness from data-integrity contribution. **Status:** open; no real cloud disclosure attempted.
- **Affected user/consequence:** capture-derived memories can become ordinary `MEMORY.md`/recent-note context; an ingest sensitivity pass is not an injection screen at later use. Under cloud-permitting chat, that text also becomes cloud context.
- **Baseline:** merged d948aa0a. **Reproduce/source:** run `diagnostics/data-recall-probe.mjs` (first scenario); evidence shows promoted capture canary in the actor system prompt and zero additional ingest screens. Capture promotion `src/core/capture/capture.ts:1063` writes a core memory with `capture:` provenance; runner recalls at `src/runner.js:357`, context assembles standing/recent memory at `src/context.js:78`/`:88`, then sends at `src/runner.js:404`. No recall screen is on that assembly path. **Expected:** `docs/plans/decision-service.md:196` says captured screen text passes the injection battery before entering model context; `docs/plans/capture-screening-consumers.md:214` explicitly lists this as next job.
- **Root cause/components:** capture-class/provenance is flattened at the file/context boundary; screening is attached to ingest consumers rather than common context assembly. Capture, Memory context interface, runner/context builder, ingest and receipts.
- **Smallest coherent closure:** retain structured content class and source IDs through recall and standing-memory assembly; screen all capture-derived context immediately before use, cached by content hash+screen version. Show held content and recovery action. Do not bypass global model privacy or conflate safety-screening opt-in with consent to send capture to a cloud actor.
- **Dependencies/decisions:** define whether deliberate promotion authorizes ordinary cloud-memory use or preserves a capture privacy floor. The committed per-source switch governs screening; the audit does not assume it already governs every actor. Coordinate deletion closure and graph provenance work.
- **Acceptance/regression:** synthetic capture with harmless fact+instruction is promoted by controlled fixture, then recalled through both memory search and full standing-file inclusion; actor receives only permitted screened data and taint; missing/untrusted screen fails closed with an explanation; deletion removes cached extract; local-only/local-preferred/cloud and sensitive-source decisions proven without real models.
- **Effort:** 4–8 days for structured recall gate and tests assuming existing screen cache is reusable; broader memory unification may increase it.

<a id="nova-002"></a>
## NOVA-002 — Resolve “local-only” versus the cloud-screening exception

Consolidated triage: **investigation · severity high · P1**. Supporting review: [source](contributions/privacy.md).

- **Category:** investigation (a verified policy inconsistency, not a hidden-fallback allegation). **Severity:** high if users interpret the top-level setting literally; **Priority:** P1 owner decision and repair design. **Confidence:** high. **Evidence:** code, existing synthetic runtime test, contradictory product wording/older ADR. **Status:** owner decision required.
- **Affected user/consequence:** people who enabled Jev screening and later choose local-only can have pages, mail, local files and tool output sent to a remote screening provider. The switch text explicitly warns this; the exception is intentional and disclosed.
- **Baseline:** merged d948aa0a and existing loopback DecisionService test; deployed settings unknown.
- **Reproduce/observed:** `tests/core/decision-service.test.ts:151` passes by asserting Jev answers local-only when screening opt-in is on. `service.ts:127` permits it; `receipts.ts:111` exempts it. **Expected under this review's strict local-only interpretation:** no remote processing. **Historical requirement:** `docs/plans/decision-service.md:187` allows the opt-in, while `LOCAL-FIRST-AND-DEVICE-MESH.md:8` says nothing leaves the mesh; `settings.ts:65` says local-only is not strictly local for screening.
- **Smallest closure/components:** owner confirms one mode contract, preferably make local-only absolute and preserve screening opt-in only in a cloud-permitting mode; disable/refuse incompatible saved opt-ins when local-only is selected and explain what changed. Settings, DecisionService, Receipts, copy, receipts UI, migration tests.
- **Dependencies:** owner reconciliation of earlier ADR exception with present constraint. This audit neither authorizes the exception nor silently rewrites historical decisions.
- **Acceptance/regression:** a person can state which processors may receive each data class after changing mode; tests cross product of three modes, screening/image/capture/private classes, old opt-in profiles, retries and mid-call changes. Under an absolute mode, the remote stand-in receives zero content in local-only while loopback/permitted LAN inference still works.
- **Effort:** decision packet 0.5–1 day; implementation 2–4 days after decision, assuming no new migration format.

<a id="nova-003"></a>
## NOVA-003 — Complete broker consumer migration before claiming broker-only credential access

Consolidated triage: **unmet commitment · severity high · P1**. Supporting review: [source](contributions/privacy.md).

- **Category:** unmet commitment. **Severity:** high trust-boundary limitation; **Priority:** P1 planned repair before credential-heavy expansion. **Confidence:** high. **Evidence:** code + explicit unfinished requirement; broker controls separately tested. **Status:** open, known staged architecture.
- **Affected user/consequence:** users connecting provider/accounts expect credential confinement; current Core still needs plaintext legacy credentials. A compromised Core has a wider credential capability than the intended broker design.
- **Baseline:** merged d948aa0a; no real credentials accessed. **Reproduce:** inspect production Core construction and providers (`src/core/index.ts:409`, `:410`, `:515`, `:551`) and credential setter `:1590`; compare client-only broker boundary `src/core/broker/client.ts:1`. **Observed:** broker isolation is real for migrated/broker operations; legacy consumers directly read values. **Expected final commitment:** refs/metadata in Core, credential use only inside broker/launcher.
- **Evidence/root cause:** consumer migration P1b and whole-product qualification P1c remain distinct from broker-module safety; `docs/plans/vault-broker.md:67` already says full claim is unmet. Do not treat stale ledger allegations about reset/delete tiers as current defects; latest code makes these approver/Tier3 actions.
- **Smallest coherent closure/components:** resume the existing consumer-by-consumer migration rather than create a second secret store. Start one common provider credential path; replace direct secret resolution with broker use while preserving exact target/policy and nonsecret responses. Keep migration recovery/rollback evidence. Update visible claim state for paths still legacy.
- **Dependencies/decisions:** existing broker P1b/P1c sequence, credentialed service/browser integrations, OS deployment isolation decision. Full threat-model review remains unavailable to this cloud reviewer.
- **Acceptance/regression:** synthetic canary crosses every migrated production path; never in Core heap/model prompt/log/receipt/bundle; use succeeds only at bound target with authorized scope; failure/restart/downgrade and backup restore preserve ownership. Complete the existing whole-product gate before widening the claim.
- **Effort:** first production provider slice 3–6 days; complete mixed consumer migration and qualification 2–4 weeks, assuming existing broker verbs cover needed target operations. Do not estimate the entire program as a small UI fix.

<a id="nova-004"></a>
## NOVA-004 — Establish all-process local-only enforcement and evidence

Consolidated triage: **investigation · severity high potential · P1**. Supporting review: [source](contributions/privacy.md).

- **Category:** investigation. **Severity:** high potential privacy impact; **Priority:** P1 bounded investigation/design, follow current architecture queue. **Confidence:** high that enforcement/coverage is fragmented; external leakage through host commands was **not** tested. **Evidence:** code + test-boundary inspection. **Status:** open investigation.
- **Affected user/consequence:** local-only users enabling host commands or custom providers may infer a network boundary that those processes do not have. An allowed command can run arbitrary host networking; a custom CLI's egress is declared, not confined.
- **Baseline:** merged d948aa0a; no external command probe or network disruption performed. **Reproduce/source:** `src/tools.js:542` deliberately retains exec under local-only; `:688` launches `/bin/sh` on host with no network namespace. `src/core/providers/registry.ts:249` trusts custom CLI egress. Acceptance egress guard `tests/acceptance/egress-guard.ts:1` monkeypatches Node TCP, not all native children/UDP/DNS. **Expected:** define and prove the promised local-only boundary while allowing loopback and permitted LAN traffic.
- **Root cause:** independent policy points across runner, providers, models, broker, browser and Nova Computer; the Computer network-none proxy is stronger than host exec. A model-call receipt list is not a complete network egress ledger.
- **Smallest investigation/components:** in disposable network namespaces, enumerate every network-capable adapter/child and metadata-only background call; controlled local, allowed-LAN and prohibited-external sinks; prove refusal and recovery; document residual trust in operator-installed commands. Produce the existing T4-style ADR, not ad hoc shell string filtering.
- **Dependencies:** reconcile NOVA-002 first, coordinate broker P1b/Phase2 and deployment platforms. No real integration or physical-network disruption required.
- **Acceptance:** matrix covers model requests/embeddings, redirects/retries, browser/computer, shell/custom/native children, DNS/UDP, metadata/telemetry, fallbacks and live policy changes; synthetic external sinks get zero prohibited bytes in local-only; approved LAN remains usable; results identify instance/build and actual enforcement layer. Audit every egress claim against the measured matrix.
- **Effort:** bounded investigation/ADR 2–4 days; implementation range intentionally deferred until platform scope is chosen (likely multi-week). Do not call the investigation a reproduced exfiltration defect.

<a id="nova-081"></a>
## NOVA-081 — Older Memory reads can redraw content after a newer read removed it

Consolidated triage: **defect · severity medium · P1**. Supporting review: [source](contributions/product-map.md).

- **Category / gap:** defect; C.
- **Severity / priority:** Medium / P1. Transient UI resurrection, not demonstrated database restoration.
- **Confidence / evidence:** High; reproduced in the real app in Chromium at 1440×900 with controlled synthetic GET responses. `audit-astra/evidence/product-memory-browser.json`, `product-memory-race.png`, and `diagnostics/product-memory-browser.mjs`. The independent source diagnostic also executes the exact baseline `loadMemory` function in a VM with deferred GET promises (`product-probes.json`). `ui/js/app.js:113` and SSE callback `:229`; compare generation checks already used by `ui/js/about.js:35`.
- **Affected user / consequence:** A person editing/forgetting memory while another refresh is in flight can see obsolete content return until the next successful refresh, undermining deletion confidence. This evidence does not claim that the backend forget operation is undone or data is sent to a model.
- **Reproduce:** Open `/memory`: boot and routing issue two GETs. Hold the first, fulfill the second with empty sections, observe “Nothing kept yet,” then fulfill the older request with one synthetic entry. The real screen redraws that older entry with Edit/Forget controls and no browser error. The diagnostic uses the actual response shape (sections, days, candidates, titles), simulating the responses before/after a mutation; no real backend-forget operation was performed in this probe.
- **Observed / expected:** Old response replaces `state.memory` and triggers another render. Latest applicable revision should win; completion order must not make state older.
- **Root cause:** `loadMemory` stores a promise but has no request generation/revision check, cancellation or invalidation across mutations.
- **Smallest coherent change:** Add a Memory request generation and invalidate on mutation/navigation as appropriate; preserve the established inline editing behavior. Prefer a monotonic server revision where concurrent devices matter. Apply the same agreed lifecycle to peers only after auditing them.
- **Components:** app Memory loader and mutation handlers; shared view loading helper if extracted narrowly.
- **Dependencies / decisions:** None. Browser interception established the visible race; the builder's regression should additionally exercise an actual synthetic forget with the earlier response held.
- **Acceptance:** Deferred pre-forget/pre-correction read never overwrites the post-mutation state; two out-of-order loads retain the newer result; old failure cannot replace newer success; latest genuine failure remains visible; inline edit/focus preserved.
- **Regression:** Browser with two deliberately delayed API responses, a real synthetic forget, rendered assertion after old response arrives; unit check for request generation. Verify no additional backend resurrection claim is made.
- **Effort / status:** 0.5–1.5 days. Source and controlled-response browser diagnostics reproduced; open.

<a id="nova-086"></a>
## NOVA-086 — Keeping an imported memory changes its source label to a conversation

Consolidated triage: **defect · severity medium · P1**. Supporting review: [source](contributions/product-map.md).

- **Category / gap:** defect; C, misleading provenance.
- **Severity / priority:** Medium / P1. This is a false source attribution in the trust-critical inspection path, not evidence of underlying source-record corruption.
- **Confidence / evidence:** High, actual browser Keep action and canonical core API read-back on an owned disposable instance. `audit-astra/evidence/product-workflows.json`, rows `candidates-before`, `kept-and-dismissed`, and `correction-reload`; screenshots `product-workflow-candidates-before.png` and `product-workflow-kept-and-dismissed.png`. Reproducer `diagnostics/product-workflows.mjs`. Source: `ui/js/view.js:485`–495.
- **Affected user / consequence:** A user verifying what Nova learned sees the correct file provenance while reviewing a candidate, but after approving it is told the fact came from a conversation. They can no longer distinguish imported evidence from a statement in chat, weakening correction, trust and future graph evidence inspection.
- **Source/runtime baseline:** Merged `d948aa0a…`, disposable audit instance with synthetic `seedUserHome` notes, local-only mode, no model calls. Owner-host deployed applicability unverified.
- **Reproduction:** Create the two neutral note fixtures with `seedUserHome`; during setup discover only controlled loopback stand-ins, import notes; visit Memory from Home; click Keep for Garden plans and Drop for Reading list; inspect the kept item and `/api/v1/memory`.
- **Observed:** Candidate names `imported from ~/Notes/garden/plants.md`; after Keep the rendered source is `from a conversation, today`. The canonical record still has `source: "imported from ~/Notes/garden/plants.md"`, `user_state: "confirmed"`. The core data and UI disagree. Correction/reload retains the same misleading label. No broken conversation-link navigation is claimed: this branch renders plain text when no conversation title matches.
- **Expected:** The item remains clearly labeled as imported from that file, with its original source and timestamps; conversational sources alone are described as conversations. Do not expose private host paths beyond the already-authorized reader.
- **Root cause:** `memorySource` splits every nonempty `e.from` on `/` and, absent a matching conversation title, unconditionally falls back to “from a conversation.” Import and device provenance are not distinguished.
- **Smallest coherent change:** Normalize source-kind information in the Memory projection and render import/device/capture/conversation origins explicitly; maintain compatibility with historical strings. A short-term classified renderer fix can ship before the full Memory workflow. Do not invent clickable filesystem/HTTP links from untrusted source text.
- **Likely components:** Legacy memory projection (`src/memory.js`), Memory source renderer (`ui/js/view.js`), canonical memory detail when NOVA-082 lands.
- **Dependencies / unresolved decisions:** No owner decision required for accurate labeling. NOVA-082 should reuse the corrected source contract; graph evidence inspection depends on it. A future “Open source” action needs an authorized canonical target, not string concatenation.
- **Acceptance criteria:** A synthetic note approved through the UI still names the imported file afterward and after correction/reload; device/capture/manual/chat origins render their actual kind; only a known authorized conversation gets a conversation link; malformed or old source strings say unknown/source unavailable rather than inventing a chat. Preserve the actual stored source and confirmation state.
- **Regression verification:** Browser workflow import→Keep→inspect/reload plus unit table over source kinds and old-format examples. Verify source display is escaped and no arbitrary link becomes clickable.
- **Effort / status:** 0.5–1.5 days for safe labels; 2–3 days if projection contract migration is included. Confirmed, open; product unchanged.

<a id="nova-085"></a>
## NOVA-085 — First-use import instructions name the wrong host folder

Consolidated triage: **defect · severity medium · P1**. Supporting review: [source](contributions/product-map.md).

- **Category / gap:** defect; C.
- **Severity / priority:** Medium / P1, immediate first-use repair.
- **Confidence / evidence:** High source diagnostic and primary auditor UI observation. `src/core/onboard/first.ts:21`–22; `src/core/setup.ts:137`; `src/config.js:29`; `src/core/self.ts:36`, `:395` and `:487`. `product-probes.json` shows the displayed string unchanged with custom `/tmp/audit-synthetic-nova-home`; the actual import folder is that home plus `workspace/import`. Primary auditor saw this in `evidence/setup-workflow.json` and `setup-finish.png`, with disposable runtime home `/tmp/nova-astra-main-20261109`.
- **Affected user / consequence:** New self-hoster copies notes into OS `~/workspace/import`, while Nova reads its configured data home. Default data home is `~/Nova`, so the default real path is `~/Nova/workspace/import`. The fallback first action opens Memory even though instructions say to tell Nova in Chat, adding a second handoff.
- **Reproduce:** Finish setup without imports under a custom NOVA_HOME. Click Bring in your notes; read the path and destination. Compare with Nova's actual import directory.
- **Observed / expected:** Static pseudo-home path and Memory destination. Expected actual configured host location (and clearly which computer owns it) with a usable next step.
- **Root cause:** Agent-facing `~` shorthand reused in user-facing setup; first action is restricted to `go: 'memory'` rather than an import workflow.
- **Smallest coherent change:** Inject actual import location into setup view; show/copy it only to authorized users, identify host versus this browser, and link to the available import/chat handoff. If chat is unavailable locally, offer direct deterministic file import or an explicit model-setup action before implying completion.
- **Components:** setup core view, onboarding first action, import tool copy, setup UI. Do not expose arbitrary paths pre-auth.
- **Dependencies / decisions:** Decide whether first small slice is correct path plus Chat handoff or direct upload; the former is a repair, the latter an enhancement.
- **Acceptance:** Default and custom-home user follows the displayed path and Nova finds a synthetic note; no hidden knowledge of runtime home is needed. Phone copy says the folder is on the hub. Action reaches the promised next step; absent chat model has a precise recovery route. A record remains quarantined until approved.
- **Regression:** Default/custom home, spaced path, remote paired user, local-only without model, known import fixture. No actual provider call required.
- **Effort / status:** 0.5–1.5 days for path/handoff, 2–4 days if deterministic upload is added. Open.

<a id="nova-084"></a>
## NOVA-084 — Home implies a daily Brief can be configured, but the card has no workflow

Consolidated triage: **defect · severity medium · P1**. Supporting review: [source](contributions/product-map.md).

- **Category / gap:** defect; C (misleading empty state); connecting a real brief is a later improvement.
- **Severity / priority:** Medium / P1 for copy/action; P2 for real digest integration.
- **Confidence / evidence:** High code plus primary auditor/visual auditor runtime observation. `ui/js/components.js:99` explicitly says no brief workflow exists; `:103` nevertheless says a daily brief arrives once set up; sole production call is `ui/js/surfaces.js:145` with no argument. File-backed schedule copy says reports arrive in main conversation (`ui/js/view.js:765`).
- **Affected user / consequence:** Home's most prominent daily-use card tells a new user to configure something with no action and no mechanism to populate it. A successful morning digest still cannot satisfy this promise.
- **Reproduce:** Open Home on a fresh instance and read Brief. Inspect Automations morning digest destination; production Home never receives brief data.
- **Observed / expected:** Permanent "No brief yet" plus implied setup. A first-use state should offer a real next action and accurately state where the result will appear.
- **Root cause:** Placeholder survived while schedule/digest implementation uses a different presentation path.
- **Smallest coherent change:** Remove unsupported arrival claim and link to the real Automations/digest workflow with explicit conversation destination, or hide the placeholder until an actual brief exists. Later connect the latest successful digest with source/time and stale/failure states; do not add a new model feature merely to fill a card.
- **Components:** Home Brief component, schedule result reference, navigation.
- **Dependencies / decisions:** Product choice: remove placeholder now versus connect existing digest. Existing mark/artwork stays intact.
- **Acceptance:** No Home copy promises an unavailable setup; one action reaches the real control. When integration is implemented, a successful synthetic digest shows the same result id/text/time on Home and its conversation, failures preserve and label the last successful brief, and users can open supporting evidence.
- **Regression:** Fresh-user Home, setup link from Home, completed/failing digest fixture. Avoid screenshot-only correctness claims.
- **Effort / status:** 0.5 day copy/action; 2–4 days to connect existing digest. Open.

<a id="nova-040"></a>
## NOVA-040 — Replace the obsolete entry-point documentation with the current product contract

Consolidated triage: **defect · severity medium · P1**. Supporting review: [source](contributions/qa-delivery.md).

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

<a id="nova-082"></a>
## NOVA-082 — Finish the Memory workflow before expanding the knowledge graph

Consolidated triage: **unmet commitment · severity medium · P1**. Supporting review: [source](contributions/product-map.md).

- **Category / gap:** unmet commitment; A/B (existing backend capabilities absent from the app).
- **Severity / priority:** Medium / P1, before graph expansion.
- **Confidence / evidence:** High code/requirement. Owner queue item 4; `src/core/index.ts:1334`–1350 exposes state filters/search/export/correct/confirm; `ui/js/app.js:113` reads `/api/memory`; `ui/js/view.js:531` only lists sections/days and candidates; Nov 9 Memory composition explicitly remains unwired. No new browser functional claim in this contribution.
- **Affected user / consequence:** A growing memory collection can be edited/forgotten, but finding a specific item, reviewing confidence/state, confirming it and exporting it from its canonical screen requires chat/API/file knowledge. That blocks the daily recall/triage loop more directly than missing 3D exploration.
- **Reproduce:** Open Memory with several records; look for search, state/scope filters, confirmed status and export. Inspect the current API routes to see the existing operations.
- **Observed / expected:** Source renders a long grouped list and Keep/Drop candidates; expected core memory search/export/confirm/correct workflow is explicitly queued and designed, not yet shipped. The stale edit issue in the earlier composition was fixed at this baseline and is excluded.
- **Root cause:** UI still uses the Era 2 projection while the core contract has richer state and operations.
- **Smallest coherent change:** Implement the approved Memory composition against one canonical typed projection; begin with search, source/state detail, confirm, correct and downloadable export. Preserve candidate quarantine, lineage and deletion safeguards.
- **Components:** Memory UI/API adapter, core memory query/export attachment, canonical deep links.
- **Dependencies / decisions:** Existing rendered-entry owner reaction; data deletion/receipt findings from other audit work; export must download a safe artifact rather than expose a filesystem path only.
- **Acceptance:** Starting at Home, a self-hoster finds a known item among 100 synthetic records, sees original source and current state, confirms/corrects it, exports readable JSON/Markdown, and can return through browser Back with query intact. Corrected/forgotten items follow existing lineage/deletion rules. All actions keyboard operable at desktop/390px/short cover viewport.
- **Regression:** Home-start workflow with populated fixture; invalid query, empty/no-results, late response, offline failure and stale correction; exported file read-back; permission matrix.
- **Effort / status:** 3–6 days after rendered approval, assuming backend semantics retained. Known queued commitment, not an undiscovered regression.

<a id="nova-083"></a>
## NOVA-083 — Complete ordinary rule authoring instead of exposing an empty rule collection

Consolidated triage: **unmet commitment · severity medium · P2**. Supporting review: [source](contributions/product-map.md).

- **Category / gap:** unmet commitment; A/B.
- **Severity / priority:** Medium / P2, after Memory and truthful first-use guidance.
- **Confidence / evidence:** High code/requirement; `ui/js/surfaces.js:560` renders list and pause/resume/delete only, `:567` handlers; `docs/ledger/2026-11-09-automations-editor.md` distinguishes existing backend from proposed token hint/rotation. Owner queue item 4.
- **Affected user / consequence:** A user sees that rules start work when something happens but cannot create/edit a rule from that screen. The separate schedule catalog partly supports repeating use but does not explain this capability boundary.
- **Reproduce:** Open empty Automations, attempt to create a core rule or edit a populated one; existing source has no controls. Compare the styleguide editor, explicitly demo-only.
- **Observed / expected:** Rules can be paused or removed. The committed editor workflow is designed but not wired. Do not promise conditions or token rotation as already supported.
- **Root cause:** App wiring queue incomplete; two scheduling concepts coexist.
- **Smallest coherent change:** Wire create/edit and allowed Run now for schedule/proactive rules using the existing schema; keep irreversible token exposure clear. Explain event/webhook versus timed triggers in one creation flow. Token rotation is a separately bounded backend change.
- **Components:** Automations view, core triggers, reusable form validation, token reveal policy.
- **Dependencies / decisions:** Owner rendered-entry reaction; explicit decision on rotate versus recreate semantics.
- **Acceptance:** User creates a daily synthetic rule, sees next run and destination, edits it, runs it when allowed, follows its task, pauses it and sees no further trigger. Webhook/connection rules explain why Run now is unavailable. Invalid inputs stay in the form with field-level messages; no lost draft on refresh.
- **Regression:** Fake clock/worker; one firing exactly once; UI reload/back; failed task creation; token not in subsequent reads/logs.
- **Effort / status:** 3–5 days without rotation, 1–2 additional days if rotation is chosen. Known queued commitment.

<a id="nova-080"></a>
## NOVA-080 — Pipeline misclassifies design work and hides the evidence needed to judge it

Consolidated triage: **defect · severity medium · P1**. Supporting review: [source](contributions/product-map.md).

- **Category / gap:** defect; C (exposed but misleading/incomplete).
- **Severity / priority:** Medium / P1, after privacy/data integrity repairs and alongside accurate capability copy.
- **Confidence / evidence:** High; executed production generator against baseline records, source inspection, requirement. Evidence: `audit-astra/evidence/product-probes.json`; `src/core/pipeline.ts:69`, `:187`, `:242`; `ui/js/components.js:1217`; delta spec `docs/builder-packet/nova-about-deploy-visibility-delta-2026-11-06.md:27`.
- **Affected user / consequence:** Owner or self-hoster checking what is usable sees designs mixed into Merged totals, cannot open referenced records, and can miss unfinished details. This weakens the mechanism intended to prevent stale or exaggerated progress claims.
- **Reproduce:** Run `node audit-astra/diagnostics/product-probes.mjs` under Node 26, or open `/pipeline` and expand Provider plurality ADR, Memory compositions, and Jarvis compositions.
- **Observed:** All three are `merged`; the first explicitly says nothing is implemented and the second says nothing is wired. Generator recognizes design only when the area's parenthesized note contains `design|adr` or the headline contains the precise phrase `not built yet`. `entryParts` reads only the first physical line, so Jarvis's `Still unfinished: three things.` loses the actual list. `pipelineRow` prints the evidence path and PR number as spans/plain text, not navigable evidence links. Gate presence implies Merged without encoding gate result/physical-vs-emulated coverage; M4's cell therefore does not itself preserve its physical-device limitation.
- **Expected:** A design-only record is Designed even if the document was merged; product completion is distinct from document merging. Users can inspect complete safe evidence and see explicit limits.
- **Root cause:** Display status and evidence are inferred from prose conventions rather than a validated minimal record contract.
- **Smallest coherent change:** Add validated status/area/evidence metadata to the existing per-merge ledger format and gate records; generate from those same files (no parallel progress list). Preserve full section content or link to a fixed allowlisted source viewer/source-commit URL. Never expose arbitrary repository files or the restricted threat model. Old entries with ambiguous state become Designed/Unknown with an explanation, not inferred complete.
- **Components:** pipeline generator, ledger/changelog checks, About UI, safe source link renderer.
- **Dependencies / decisions:** Agree meanings of Designed versus merged artifact; do not infer owner approval from a merged composition. Safe evidence allowlist is required, not a general file browser.
- **Acceptance:** Current A1, Memory and Jarvis records display Designed/awaiting reaction; a built capability remains Merged; multiline unfinished notes retain all bullets; every evidence control is keyboard-activatable and opens the exact pinned allowed source; no sensitive file can be requested; counts derive from the same states. A failed or partial gate cannot satisfy a completed gate.
- **Regression:** Parser fixtures for mixed artifact/product states, multiline notes, malformed/unknown metadata, failed gate; browser test follows one evidence link on phone/desktop; auth/path-traversal tests for any local viewer.
- **Effort / status:** 2–4 days including metadata backfill for active records. Open; audit only.

<a id="nova-041"></a>
## NOVA-041 — Complete the promised release version/tag workflow

Consolidated triage: **unmet commitment · severity medium · P2**. Supporting review: [source](contributions/qa-delivery.md).

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

<a id="nova-006"></a>
## NOVA-006 — Explain what cloud chat receives before the first send

Consolidated triage: **improvement · severity medium · P2**. Supporting review: [source](contributions/privacy.md).

- **Category:** improvement. **Severity:** medium user-understanding/privacy expectation risk; **Priority:** P2 next release, after routing repairs. **Confidence:** high that inclusion occurs; usability impact requires user validation. **Evidence:** synthetic production-runner witness + code; proposed UX enhancement. **Status:** proposed.
- **Affected user/consequence:** a self-hoster may believe “local files” stay local while chatting with a cloud model. Even a greeting sends standing files and memory; file tools add contents to later calls.
- **Baseline:** merged d948aa0a; no physical/runtime owner configuration tested. **Reproduce:** `diagnostics/privacy-context-disclosure.mjs` puts a synthetic private note in USER.md and sends “Hello” to a synthetic cloud-class agent. **Observed:** system parameter contains note, receipt lists USER.md. **Expected proposed experience:** before enabling cloud chat, the user can identify that file/memory contents travel, which provider receives them, and how to stay local.
- **Smallest closure/components:** destination label at chat, first cloud-use disclosure with concrete data categories, a readable context receipt accessible from that turn, and a local-only control/recovery route. Use actual runtime provider and sent context, not a static “Tev1/local” badge; avoid repeated confirmation on every safe turn.
- **Dependencies:** NOVA-001 and policy reconciliation; receipt source visibility. Preserve concise chat and existing global consent rather than add approval fatigue.
- **Acceptance/regression:** five unfamiliar self-hosters can correctly identify chat vs screening destination, name at least standing files+memory as sent classes, locate the receipt, and choose a viable local alternative without source reading. Browser test proves destination updates when fallback occurs and no private content is rendered to unauthorized callers.
- **Effort:** 2–4 days after approved styleguide entry; no new model feature needed.

<a id="nova-042"></a>
## NOVA-042 — Make new serious accessibility regressions fail a targeted CI gate

Consolidated triage: **improvement · severity medium · P2**. Supporting review: [source](contributions/qa-delivery.md).

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

<a id="nova-120"></a>
## NOVA-120 — idle and thinking are visually identical in the Canvas2D fallback

Consolidated triage: **defect · severity medium · P2**. Supporting review: [source](contributions/visual-review.md).

- Category: defect. Gap class C (exposed state treatment incomplete).
- Severity: medium. Implementation priority: P2, after privacy/deletion repairs and before broad device-readiness claims.
- Confidence: high. Evidence classification: observed isolated browser-rendering diagnostic plus established code cause.
- Affected user/consequence: users on clients without working WebGL, including GPU-disabled browser environments, cannot distinguish “nothing is happening” from “thinking” by the status artwork. ARIA labels still differ; this is not a claim that all progress feedback or assistive access is absent.
- Baseline: frozen merged source and disposable audit server at that source; owner-deployed version unverified.
- Reproduction: run `node audit-astra/diagnostics/visual-mark-fallback.mjs` with the pinned Node26 and Chromium. The script launches a separate browser process, blocks service workers, forces reduced motion, deliberately refuses only WebGL contexts, opens the read-only styleguide, then renders eight existing `statusIcon()` states at 96px using the production component. It compares the canvases' PNG data and saves their appearance. No Nova data or product files are modified.
- Observed: renderer reports `canvas2d`; idle and thinking PNG pixels are byte-identical. Their accessible labels are respectively idle and thinking. Other sampled pairs differ. The diagnostic does not establish a perceptual threshold for the other differences.
- Expected: the fallback should preserve a perceptible distinction between these semantic states, including reduced motion, while using the owner's artwork unchanged. The state still needs a readable name. This follows DESIGN-SYSTEM §1's requirement that states remain distinct without relying solely on hue/motion; thinking is the app's finer-grained working state.
- Evidence: `evidence/visual-mark-fallback.json`, `evidence/visual-mark-fallback.png`, `evidence/visual-mark-fallback.log`; reproducible audit script `diagnostics/visual-mark-fallback.mjs`.
- Root cause: thinking differs from idle only in hue/twirl (`ui/js/status-icon.js:83–89`); the Canvas2D compositor applies saturation/tint/brightness but none of hue/twirl/pulse (`:290–303`). Thus those states collapse to the same pixels in fallback. Existing fallback tests assert that every state is drawn, not pairwise distinguishability (`tests/ui/status-icon.test.ts:340–361`).
- Smallest coherent change: give thinking a fallback-compatible treatment with a meaningful brightness/tint distinction and retain/readably expose the state name; do not redraw the mark. Avoid attempting to recreate a shader with new geometry.
- Components: status-icon renderer, status treatment contract, status-icon styleguide/test coverage; possibly text placement in shell if adding always-visible status words.
- Dependencies/decisions: no owner-artwork redesign approval needed; exact treatment should follow the existing rendered styleguide recognition process through the builder.
- Acceptance: deliberately refuse WebGL; at 16/24/48/96px, confirm idle and thinking differ in both normal and reduced-motion modes; confirm stopped remains reserved for stopping failures and needs-you remains amber; verify accessible names still match source state. Have a reviewer identify the two states without relying on color in a labeled comparison. Do not equate nonidentical hashes alone with a perceptual pass.
- Regression: extend the existing fallback test to compare relevant pairs and capture the actual artwork at small sizes; retain shader-path tests. No additional model calls.
- Effort: 0.5–2 engineering days plus rendered review, assuming treatment-only change and existing test harness.
- Status: confirmed; not implemented.

<a id="nova-121"></a>
## NOVA-121 — Home's first short-height viewport contains no useful action or work state

Consolidated triage: **improvement · severity medium · P2**. Supporting review: [source](contributions/visual-review.md).

- Category: improvement. Severity: medium usability impact; implementation priority P2. Confidence: high for appearance, moderate for the proposed benefit until user observation.
- Affected user/consequence: people opening Nova on a short foldable cover screen must scroll past a full viewport of identity/greeting before finding work, a result or a next action. This is not a claim of inaccessible scrolling or data loss.
- Baseline/evidence: this audit's merged-source instance, Chromium-emulated 360×360, Nebula dark/reduced-motion. `evidence/screens/cover-home.png`, contrasted with `phone-home.png`; `evidence/ui-sweep.json` records viewport/document widths of360 with no horizontal document overflow. Owner-deployed and physical-device behavior unverified.
- Reproduction/observed: open Home at360×360 on the fresh setup profile. First viewport contains menu,112px artwork, greeting and date/status sentence; the first Brief/work/action row is below it. At390×844 the same hero consumes roughly the first350px. Expected design outcome: immediate access to the most relevant work or action on a short viewport while retaining Nova's identity.
- Root cause: Home's fixed hero size plus spacing is driven by width layout, with no short-height composition (`ui/styles/components.css:489–494`, `ui/styles/layout.css:137–154`; hero source `ui/js/surfaces.js:138–145`). Chat's captured short composition prioritizes the composer via flex allocation (`components.css:464–466`), providing a useful outcome to emulate without claiming an explicit height breakpoint exists there.
- Smallest coherent change: a short-height Home composition with the same artwork at the small status size and a compact greeting, then the highest-priority work or next-action row. Keep the normal phone hero when space permits. Do not redraw the artwork or add animation.
- Affected components: Home composition, shell/status placement, responsive styleguide specimen and posture tests.
- Dependencies: coordinate with NOVA-084 so the newly exposed row is truthful/useful; rendered-entry owner recognition follows the project's builder workflow.
- Acceptance: at340–390px viewport heights and340–390px widths, the first viewport shows one meaningful action or current work/result row in addition to navigation; no duplicate status artwork; no hidden controls under safe areas; text zoom200% still allows all content/actions via normal scroll. Compare390×844 and desktop to ensure normal layouts keep their hierarchy. Have a reviewer complete “find what needs me / start the next useful action” from Home in each posture.
- Verification: browser screenshots plus actual taps/keyboard navigation; physical foldable remains a separate qualification check. Automated bounding-box assertions alone do not establish usability.
- Effort:1–3 engineering days including styleguide/review and posture regressions; assumes no new backend.
- Status: proposed improvement, not implemented.

<a id="nova-100"></a>
## NOVA-100 — Distinguish running health from capability readiness

Consolidated triage: **improvement · severity medium · P2**. Supporting review: [source](contributions/runtime-experience.md).

- **Category/gap:** improvement; D. **Severity:** medium comprehension risk. **Priority:** P2 next release. **Confidence:** high for current wording, medium for user impact; no usability participants were recruited. **Evidence:** observed default runtime + code-supported health shape. **Status:** proposed.
- **Affected user/consequence:** a new self-hoster sees Home's “All systems normal” and “19 workers are fine” although no decision model is reachable, no backup folder is set, no supervisor runs and some workers have not checked their dependency. They must reconcile a green summary with the next action failing or waiting.
- **Baseline:** frozen merged source and its disposable instance, not the owner deployment. **Reproduction:** complete setup with no integrations/model runtime; open Home then Health. `runtime-health.json`, `ui-sweep.json` desktop `/health`, `screens/desktop-health.png`. Health does disclose individual limitations; this is not a concealed fault or justification to paint optional setup red.
- **Observed/expected:** process health, registration and configured readiness share “Fine/ready” summary language. Proposed behavior: explain “Nova is running” separately from “Ready to chat / screen captures / restore data”, naming the missing dependency and one relevant next step.
- **Root cause/components:** summaries aggregate worker health flags while some worker health deliberately means not configured or not yet checked. Core health/readiness projection, Home/Health components and first-use guidance.
- **Smallest change:** expose a small ready/not-configured/not-checked/unavailable capability state beside the existing process-health state; derive it from actual checks. Preserve no-problem silence for deliberately disabled features. No fake scan or progress animation.
- **Dependencies/decisions:** align capability definitions with NOVA-080/040 and separate chat from screening. No need to add another dashboard.
- **Acceptance:** in five unfamiliar-self-hoster trials, at least four identify whether this installation can reply locally and whether it has a recoverable backup within30seconds; each unavailable capability has a working recovery link. A missing optional model never becomes a red stopped-Nova state; a real stopping failure remains red and attention remains amber.
- **Regression:** positive/absent/unreachable/unverified capability fixtures, rendered Home/Health consistency, state refresh after dependency recovery, keyboard and short-height checks.
- **Effort:**1–3 builder days if existing health details can supply structured states;3–5 if separate probes are needed. Do not make network probes more aggressive to decorate the screen.

<a id="nova-044"></a>
## NOVA-044 — Qualify Docker capabilities before reporting Nova Computer available

Consolidated triage: **improvement · severity medium · P2**. Supporting review: [source](contributions/qa-delivery.md).

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

<a id="nova-043"></a>
## NOVA-043 — Send M9 screenshots to the configured evidence directory

Consolidated triage: **defect · severity low · P2**. Supporting review: [source](contributions/qa-delivery.md).

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

<a id="nova-045"></a>
## NOVA-045 — Qualify the failed process-lifecycle checks on a compatible host

Consolidated triage: **investigation · severity high potential · P1**. Supporting review: [source](contributions/runtime-experience.md).

- **Category:** investigation. **Severity:** high potential if a real orphan-process leak is established; no such deployed leak is claimed here. **Priority:** P1 qualification before resilience claims. **Confidence:** high that local tests failed, low that each failure has a product cause. **Status:** open bounded investigation.
- **Affected user/consequence:** self-hosters depend on workers and supervisors ending old process groups before starting replacements; the local failures leave that qualification unresolved in this host class.
- **Baseline/evidence:** merged d948aa0a; `evidence/qa-check-summary.json`, `qa-check.log`, `qa-interrupted-fixture.json`; six non-Docker liveness assertions among forty failed tests. Exact-baseline CI passed. The managed host has unreaped zombies; `tests/acceptance/m4b-device-agent.test.ts:21` uses kill(pid,0), with a focused failure at line103. This explains a plausible measurement problem, not every supervisor failure.
- **Reproduction/observed/expected:** rerun the named failed files from the retained log on an isolated normal reaping host using pinned Node26.3.1, then on this managed host. Record live versus zombie process state, parent/group IDs and sockets. Expected gate evidence must distinguish terminated-but-unreaped processes from executing survivors. Never inspect or kill owner processes.
- **Root cause:** unresolved per test. Do not change lifecycle code or weaken assertions merely because the environment differs.
- **Smallest closure/components:** a compatibility evidence report for acceptance M4b/provider guard/supervisor tests and their liveness helpers; fix production behavior only if a live survivor reproduces, otherwise improve fixture detection/cleanup with explicit supported-host criteria.
- **Dependencies/decisions:** a compatible isolated host; no real models, credentials or deployment changes. Keep Docker capability failures separate (NOVA-044).
- **Acceptance/regression:** each of the six failures has a per-case disposition and repeatable evidence; normal-exit/zombie/live-orphan negative controls distinguish process states; a genuinely running child still fails the test. Final full gate result and environment are recorded without reclassifying this audit's failed run as passed.
- **Effort:**0.5–2 days investigation; any production fix estimated only after reproduction.

<a id="nova-046"></a>
## NOVA-046 — Recheck narrow-tablet prose width with the optional pane open

Consolidated triage: **investigation · severity low · P3**. Supporting review: [source](contributions/runtime-experience.md).

- **Category:** investigation. **Severity:** low layout-contract deviation; **Priority:** P3. **Confidence:** high measurement, medium cross-browser generality. **Status:** open bounded qualification.
- **Affected user/consequence:** readers at840px can get a narrower chat column than the agreed45–75ch range when they explicitly expand the optional pane. No clipped content or inability to act was observed.
- **Baseline/evidence/reproduction:** merged d948aa0a; Chromium155,840px, pane expanded; `evidence/qa-prose-width.json`, `qa-prose-width-default.json`, `qa-prose-840.png`, `diagnostics/qa-prose-width.mjs`. Observed41.70ch expanded versus69.97ch default;1024px expanded55.70ch. Current pinned CI passed.
- **Expected/root cause:** preserve the documented readable width; exact browser/font/breakpoint interaction needs qualification rather than an assumed rendering regression.
- **Smallest closure/components:** compare the same fixture in pinned Chromium/WebKit and Chromium155, then adjust pane-availability/minimum-width rules only if the same product condition fails. UI layout bands, text measure, M9 fold assertion; no redesign.
- **Dependencies:** existing layout/styleguide approval if behavior changes; do not compromise draft/scroll/focus preservation.
- **Acceptance/regression:** expanded/default at840/1024/1280px have an explicit agreed result; when the pane cannot fit, a reachable toggle or layout alternative preserves the reading column and all controls. Actual screenshots and keyboard/touch toggling accompany width measurements; no test-threshold weakening without an explicit design decision.
- **Effort:**0.5–1 day qualification,1–2 additional days if a breakpoint repair is needed.

<a id="nova-022"></a>
## NOVA-022 — Explain the boundary of user-requested memory exports

Consolidated triage: **improvement · severity low · P3**. Supporting review: [source](contributions/data-integrity.md).

- **Category / gap:** improvement; D, clarity opportunity. Export persistence is intentional snapshot behavior, not by itself a deletion defect.
- **Severity / priority:** low; P3, with Memory export wiring/copy.
- **Confidence / evidence:** high for persistence; user comprehension not tested.
- **Affected user / consequence:** a technical self-hoster may reasonably confuse files under `Nova/exports` with Nova-managed recovery copies and assume Forget updates them.
- **Baseline:** merged backend `d948aa0a…`; export function exercised in disposable core. Current export compositions are design examples; do not claim a shipped export button from this diagnostic.
- **Reproduction / observed:** export a synthetic memory, forget it, read exported JSON/Markdown. Both retain canary (`data-forget-probe.log`). `src/core/memory.ts:239` writes independent snapshots; `src/core/resilience/backup.ts:86` explicitly excludes exports because they are copies made on request.
- **Expected / smallest change:** at export and in deletion help, state that an export is an independent copy the user manages and that later edits/forgetting do not change it. Show destination and an explicit manage/remove affordance for Nova-created export folders when that feature is authorized; do not silently erase external user copies.
- **Root cause / components:** a genuine ownership boundary exists in backend but is not represented in the deletion promise. Memory export API and future reachable export UI/help.
- **Acceptance criteria:** in a five-user comprehension check, all participants can identify which copies Forget covers, where exports live, and how to remove the exported snapshot. Snapshot format remains portable and metadata makes creation time/scope explicit.
- **Regression verification:** export/forget persistence test documents intended behavior, and copy/UI test checks the independent-copy disclosure is present before export. No claim that user files outside Nova can be erased.
- **Dependencies / effort / status:** align with NOVA-020/021 terminology and the already proposed Memory surface; 0.5–1.5 days for copy/metadata, excluding a new file-management UI. Open recommendation.

<a id="nova-060"></a>
## NOVA-060 — Establish the real graph baseline and its gated design

Consolidated triage: **investigation · severity medium planning risk · P2 gated**. Supporting review: [source](contributions/knowledge-plan.md).

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

<a id="nova-061"></a>
## NOVA-061 — Make a memory's source trail a small usable graph/list

Consolidated triage: **improvement · severity opportunity · P2 gated**. Supporting review: [source](contributions/knowledge-plan.md).

- **Category / gap:** improvement / D; low severity, P2 after committed repairs; high confidence in technical feasibility, medium in usability benefit pending trials.
- **Evidence / baseline / consequence:** source-backed opportunity at merged d948aa0a; current capture_promotion/provenance and correction APIs can support a contextual journey. Users otherwise must reconcile concepts across surfaces; no runtime failure is asserted by this record.
- **Repro / observed / expected:** inspect capture/routes.ts:52 and memory.ts:189 alongside current Memory detail. Existing relationships are stored; proposed expectation is the Slice 1 journey, not a previously agreed shipped graph requirement.
- **Root cause / smallest change:** relationships are subsystem-specific; add one authorized projection and Sources & connections detail in existing Memory. Do not duplicate record contents or mutation handlers.
- **Components / dependencies:** SQLite/core capture+memory query adapters, Memory UI/styleguide, existing delete/restore and auth boundaries; NOVA-060 and Slice 1 dependencies.
- **Acceptance / regression / effort:** all [Slice 1 criteria](KNOWLEDGE-PLAN.md#three-independently-useful-shippable-slices), including permission/deletion canaries and observable user task; 5–8 engineering days under stated assumptions.
- **Status:** proposed expansion; no implementation.

<a id="nova-062"></a>
## NOVA-062 — Build the bounded 2D knowledge workspace

Consolidated triage: **improvement · severity opportunity · P3 gated**. Supporting review: [source](contributions/knowledge-plan.md).

- **Category / gap:** improvement / D (aligned with queued graph direction); medium product opportunity, P3 until repairs and Slice 1 response; medium confidence in user value.
- **Evidence / baseline / consequence:** source relations described in KNOWLEDGE-PLAN.md, merged d948aa0a; no deployed graph test. Cross-system explanation requires joining records conceptually; a unified projection can reduce this work.
- **Repro / observed / expected:** follow existing task report, receipt and capture references across canonical APIs; no generic graph tables/query UI exists. Expected is proposed Slice 2, not a claim that the roadmap already shipped it.
- **Root cause / smallest coherent change:** no shared reference/relationship projection. Add the scoped graph contract, deterministic typed querying, bounded 2D/list navigation and source-version inspector. Preserve each source as authority.
- **Components / dependencies:** core graph adapters/SQLite migrations, event/outbox integration, navigation/styleguide, privacy/redaction/restore; NOVA-060/061 and deletion fixes. Do not infer historical G2 traces.
- **Acceptance / regression / effort:** [Slice 2 criteria](KNOWLEDGE-PLAN.md#three-independently-useful-shippable-slices); 3–5 weeks, one engineer plus design/QA, no real model evals.
- **Status:** proposed, gated architecture expansion.

<a id="nova-063"></a>
## NOVA-063 — Add an operational and temporal lens before evaluating3D

Consolidated triage: **improvement · severity opportunity · P3 gated**. Supporting review: [source](contributions/knowledge-plan.md).

- **Category / gap:** improvement with bounded follow-on investigation / D; low severity, P3; medium confidence in 2D value, low confidence in 3D benefit.
- **Evidence / baseline / consequence:** topology.ts:25,55,70 and PR207 reference patches; merged d948aa0a plus PR207 head 5e0fe8b8; deployed unknown. Current observations can explain machines but cannot provide historical impact without prospective data.
- **Repro / observed / expected:** inspect topology freshness and assignment-vs-live fields; no generic temporal graph exists. Proposed expectation is Slice 3's honest impact journey; 3D is not an unmet commitment.
- **Root cause / smallest change:** persist authorized observation/run-placement references and expose timeline/impact lens over the same 2D/list graph. Evaluate constrained 3D separately against explicit tasks, never as default navigation.
- **Components / dependencies:** topology/service/run producers, retention and time queries, graph/list UI, optional renderer. Slices 1–2; owner decision on retention and 3D usefulness. PR207 stays untouched.
- **Acceptance / regression / effort:** [Slice 3 criteria](KNOWLEDGE-PLAN.md#three-independently-useful-shippable-slices); 2–4 weeks for shippable 2D operations lens, 2–5 additional days for a nonshipping 3D prototype and study preparation; study/recruitment time separate. Ship 3D only if the stated benefit/accessibility gate passes.
- **Status:** proposed; 3D benefit unverified.
