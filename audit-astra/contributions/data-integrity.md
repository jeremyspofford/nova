# Data integrity, memory, capture and recovery audit contribution

Baseline: merged source `d948aa0a442a9f930b86f4516eeea21981b76714`, isolated checkout `/workspace/nova-audit-astra`. All runtime results below use disposable synthetic homes, in-process cores or ephemeral loopback servers on this cloud executor. They do **not** establish behavior of the owner's deployed preview. Node 26.3.1. No product edits, real models, paid services, real captures, owner backups, private threat-model contents or other independent reviewer material were used.

## Assessment

Nova's core memory and backup machinery is materially stronger than a simple file-deletion implementation: correction chains, content-free deletion events, secure SQLite deletion, backup rewriting, encrypted-copy cleanup, restore staging, revocation preservation and unavailable-disk obligations all exist. Focused current tests passed. The main weakness is that dated notes and the chat runner still use a parallel lifecycle. That leaves demonstrable gaps in the advertised meaning of “forgotten”: old wording can remain searchable, directly removed notes can return from backup, and an in-flight conversation can send deleted recall to its next model step. Separately, capture reports “Deleted everywhere” even when a backup is still unavailable and owes deletion.

## Evidence inventory and test boundary

| Evidence | What it establishes | Limits |
|---|---|---|
| `evidence/data-existing-tests.log` | 76 passing existing tests across memory, core backup, nightly/encrypted backup, checkpoint restoration, capture and privacy regressions; no-Kubernetes tripwire did not fire | Functional synthetic tests; not disk forensic erasure, real capture hardware or real provider evaluation |
| `evidence/data-ledger-screen-tests.log` | 63 additional passing ledger, memory API and capture screening tests, no failures/skips; tripwire did not fire | Same synthetic boundary |
| `diagnostics/data-forget-probe.mjs`, `evidence/data-forget-probe.log` | Correction-chain/day-note leak, direct day-note backup resurrection, export persistence | Public module methods composed as server does; browser clicks not claimed |
| `diagnostics/data-capture-forget-probe.mjs`, `evidence/data-capture-forget-probe.log` | False global deletion completion with unavailable backup; eventual cleanup succeeds on return | Fixture folder renamed to simulate disconnection; no real disk/network disrupted |
| `diagnostics/data-recall-probe.mjs`, `evidence/data-recall-probe.log` | Real createNova/scripted actor: capture promotion reaches prompt with no additional screen; forgotten dated note persists in subsequent step prompt | Actor is in-process fake. Tev1 is a loopback probability stand-in, not a model. No remote disclosure is claimed |
| `evidence/data-recall-probe-initial-error.log` | Initial diagnostic had a nonexistent `ingest.records()` call and stopped; corrected to query screen count | Tooling error preserved; not a product failure |

Commands:

```sh
PATH=/workspace/.nova-tools/node-v26.3.1-linux-x64/bin:$PATH sh scripts/test.sh tests/core/memory.test.ts tests/core/backups.test.ts tests/core/resilience-backups.test.ts tests/core/checkpoints-restore.test.ts tests/core/capture.test.ts tests/core/capture-privacy-regressions.test.ts tests/memory.test.js
PATH=/workspace/.nova-tools/node-v26.3.1-linux-x64/bin:$PATH sh scripts/test.sh tests/core/ledger.test.ts tests/core/ledger-not-started.test.ts tests/core/memory-api.test.ts tests/core/capture-screening.test.ts tests/core/capture-screening-review.test.ts
PATH=/workspace/.nova-tools/node-v26.3.1-linux-x64/bin:$PATH sh scripts/tripwire.sh node audit-astra/diagnostics/data-forget-probe.mjs
PATH=/workspace/.nova-tools/node-v26.3.1-linux-x64/bin:$PATH sh scripts/tripwire.sh node audit-astra/diagnostics/data-capture-forget-probe.mjs
PATH=/workspace/.nova-tools/node-v26.3.1-linux-x64/bin:$PATH sh scripts/tripwire.sh node audit-astra/diagnostics/data-recall-probe.mjs
```

## Strengths worth preserving

1. **Memory is inspectable and correction history is explicit.** `src/core/memory.ts:112` creates a new record on correction; `:190` exposes the chain; migration `0003_memory.sql:7` stores stable ID, kind, source, observed/created time, recorder, confidence, scope, supersession, expiry and review state. Existing tests independently prove history and stale-correction refusal. This is an appropriate SQLite basis for provenance navigation; it is not a general knowledge graph or bitemporal relationship store yet.
2. **Core forgetting reaches recovery copies.** `src/core/memory.ts:156` removes the entire chain and checkpoints the WAL. `src/core/backups.ts:62` cleans DB snapshots or destroys uncleanable ones. `src/core/resilience/backup.ts:382` rewrites nightly/encrypted copies and remembers unavailable folders. `src/core/resilience/checkpoints.ts:366` propagates deletion into checkpoints and staged restores. Existing tests pass for normal correction chains and restoration, including encrypted copies. Preserve these guarantees while unifying dated-note deletion.
3. **Recovery protects newer trust decisions.** `tests/core/checkpoints-restore.test.ts` passed restore/restart cases preserving device revocations, forgotten items, problems, epoch advancement and a before-restore checkpoint; damaged checkpoints refuse restoration, and simulated partial swaps complete on next startup. This is useful recovery behavior, not just a backup button.
4. **Capture has a real consent and evidence model.** Capture defaults off; consent/pause/exclusions/private-context tests passed. `src/core/capture/capture.ts:533` is a common ingest path; `:1063` requires checked events for promotion and stores promotion links. The UI/API can explain source, device, received time, local screening seat, pinned model, decision and outcome. Unchecked content is held rather than silently promoted. Pattern checks remain best effort, not proof that arbitrary secrets are recognized.
5. **“Done” is structurally verified.** `src/core/ledger.ts:163` refuses tasks without evidence requirements; transitions route completion through verification. `src/core/verify.ts:100` matches evidence to requirements and fails unsupported evidence. A read-back hashes actual workspace content; confirmations/test results require registered checkers. This is stronger than trusting a worker's free-form success message. It proves registered checks, not semantic correctness of all answers or every external service.

## Findings for the consolidated backlog

### NOVA-020 — Dated-note paths do not honor the core memory deletion lifecycle

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

### NOVA-021 — Capture reports global deletion while a backup still owes it

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

### NOVA-022 — Explain the boundary of user-requested memory exports

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

### NOVA-023 — A forgotten note remains in the next step of an active chat

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

## Additional shared finding evidence

The privacy reviewer owns the capture recall-screening item. `data-recall-probe.log` proves a normal synthetic capture, trusted **stand-in** screening, deliberate promotion and a subsequent chat system prompt containing that memory with zero additional ingest screens. `src/context.js:78` includes MEMORY.md wholesale. `docs/plans/capture-screening-consumers.md:214` explicitly describes checking recalled capture as the next job. This establishes an unmet recall-gate commitment; deliberate promotion may authorize general memory use, so the evidence does not by itself establish unauthorized cloud disclosure. Decision-seat capture opt-in and actor context policy must be explained separately.

## Coverage rows for consolidation

| Surface/workflow | Role/mode | Theme/viewport | State | Result | Evidence |
|---|---|---|---|---|---|
| Core memory create/correct/confirm/search/export | Console synthetic core | n/a | Success, invalid data, stale correction, expiry, provenance | tested-pass | 76-test log; core memory tests |
| Core API memory deletion and restoration | Console; synthetic | n/a | Correction chain; DB snapshots/nightly/encrypted copies/checkpoints | tested-pass | Existing test logs; checkpoint restoration tests |
| Memory UI API's corrected-memory deletion path | Console composition; synthetic | n/a (no browser claim) | Different old/new wording + old day note | tested-fail | NOVA-020 diagnostic |
| Dated-note direct deletion → nightly restore | Console composition; synthetic | n/a | Backup exists before forget | tested-fail | NOVA-020 diagnostic |
| Memory export then forget | Console synthetic core | n/a | Snapshot persists intentionally | tested-pass | NOVA-022 diagnostic; clarity improvement remains |
| Capture source consent/pause/exclusions/private windows | Synthetic console and paired test device | n/a | Empty/off/on/paused/invalid input | tested-pass | Existing capture tests |
| Capture screening and promotion gates | Synthetic console; local stand-in | n/a | Held/index/redact/exclude; no trusted answer | tested-pass | Additional screening log; no real-model accuracy claim |
| Capture raw replica copy forgetting | Synthetic hub and standby | n/a | Raw fetch deletion, policy transitions | tested-pass | Capture privacy regression tests |
| Capture forget with absent backup | Console synthetic core | n/a | Pending backup obligation, eventual return | tested-fail | NOVA-021 false completion; actual cleanup tested-pass |
| Capture promotion → actor recall screen | Synthetic cloud-allowed profile; actor in-process fake | n/a | Promoted checked item | tested-fail | Recall witness; unmet commitment owned by privacy reviewer |
| Forget between active chat model steps | Synthetic local-only actor | n/a | Tool loop; note removed midturn | tested-fail | NOVA-023 diagnostic |
| Task verification/recovery | Synthetic local workers | n/a | Done gate, missing/false evidence, retries/restart | tested-pass | Additional ledger log: 63/63 pass, zero skipped |
| Physical backup drive errors/actual standby host/real capture source | Real device | n/a | Disconnect, hardware interruption | blocked | No direct owner host/device access; synthetic simulation used explicitly |
| Disk-forensic erasure, SSD remanence, external user exports | System/physical media | n/a | Post-delete forensic recovery | untested | Beyond observed secure_delete/VACUUM/WAL functional checks |
| Owner deployed preview deletion/recovery | Owner preview | n/a | Destructive scenarios | untested | Intentionally excluded; disposable instance boundary |

## Maintenance implications and ordering

The most consequential maintenance concern in this scope is **two memory lifecycles**: typed core records plus plain-file notes plus the runner's in-memory snapshots. Each path must independently remember backup cleanup, note twins, sync logs, UI Undo and prompt invalidation. NOVA-020 and NOVA-023 are concrete consequences. Introduce one deletion and source-version contract before adding graph caches, embeddings or 3D relationships; otherwise every new derived store multiplies the places deletion must reach.

A second concern is **success status assembled separately from work completion**. Capture counts device acknowledgements, backups separately track owed folders, and Memory UI treats HTTP 200 as “Forgotten.” A shared durable deletion operation should project a single honest status into each screen without collapsing “deleted here” and “deleted everywhere.” Preserve existing encrypted obligations and backup read-back tests.

A third concern is **promoted capture losing its processing boundary in generic memory rendering**. SQLite already stores the capture→memory link, but prompt assembly reads formatted text rather than authoritative source records/policies. Keep source identity and authorization attached through retrieval, rendering, receipts and future graph projections. This need not replace SQLite or rewrite the whole product.

Suggested local sequence: fix NOVA-020 and NOVA-023 together around authoritative note identity/deletion; connect NOVA-021 to that result; integrate capture-aware recall screening; add the NOVA-022 export disclosure when the reachable Memory export surface is delivered. Only then add derived graph indexes/embeddings with the same deletion/version contract.
