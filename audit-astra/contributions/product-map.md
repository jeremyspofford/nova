# Product, commitments, understanding, and maintenance contribution

Baseline: merged source `d948aa0a442a9f930b86f4516eeea21981b76714`, isolated worktree `/workspace/nova-audit-astra`. This contribution inspected source and safe repository requirements/ledger, viewed the filed Things 3, Claude.ai and Linear references, ran the synthetic source diagnostics in `audit-astra/diagnostics/product-probes.mjs`, and reproduced the Memory response-ordering defect in Chromium against the audit's disposable instance at port 4418 using controlled synthetic GET responses. It did not read the other review, restricted whole-system threat model, or any `docs/reviews` content. It made no model calls and changed no product files. It does not independently certify the owner's deployed preview. Additional runtime observations from the primary auditor are explicitly attributed below.

## Product map and actual doors

The product is a local-first agent workbench: conversation starts work; a durable task records execution and evidence; captured or imported context can become reviewed memory; schedules repeat work; devices provide computation and services. Its strongest useful distinction is the combination of a task record, evidence, and explicit authority/privacy. Its least coherent area is the bridge from those backend capabilities to ordinary daily actions.

The registered app destinations are in `ui/js/nav.js:4` and `ui/js/app.js:295`. There are fourteen destination names, plus conversation aliases and the separate setup/pair/styleguide surfaces:

| Surface | Route | Current source-backed purpose and boundary |
|---|---|---|
| Home | `/` | Status, Brief placeholder, work, devices, memory highlight, Health. `surfaces.js:128`. Brief has no production data source. |
| Chat | `/chat`, `/new`, `/c/:id` | Conversation and tool approvals; main, empty and named conversations. Local/cloud eligibility checked separately from decision seats. |
| Tasks | `/tasks` | Durable ledger grouped by needs-you, working, waiting, verified, failed, cancelled. Conditional evidence/approval/task-specific sheets. No universal manual to-do editor is established by this route. |
| Memory | `/memory` | Curated facts/preferences/decisions/commitments, day notes, candidate Keep/Drop, edit/forget. Uses the older `/api/memory` projection. Core search/confirm/export/state UI is not wired. |
| Automations | `/automations`, `/schedules` alias | Core rule list with pause/resume/delete plus the separate file-backed schedules catalog. No core rule create/edit/run form. |
| Skills | `/skills` | Installed/catalog skills, playbooks, install/remove and folder/zip upload; Gmail connection also appears here. Interstitial skill hidden while its switch is off. |
| Activity | `/activity` | Conversation/helper/scheduled-run trail, expandable steps, historical pagination; not a universal ledger of every network egress. |
| Health | `/health` | Component problems, status, costs/caps and diagnostics. Supervisor deploy/rollback remains a composition, not a functioning Health control. |
| Settings | `/settings#<category>` | Thirteen categories below, device-specific model planner at `#models-on-<device>`. |
| Capture | `/capture` | Source consent, exclusions, captures and screening/provenance. Reachable from Settings Capture. |
| Machines and services | `/topology` | Device/service topology, reached from Devices/Services. Not the proposed general knowledge graph. |
| About Nova | `/about` | Running/latest build, version and links to Health/changelog/pipeline. |
| What's new | `/changelog` | Generated changelog and unversioned fragments. |
| Where Nova stands | `/pipeline` | Generated roadmap/ledger dashboard, with evidence-quality defects below; it is implemented. |
| Setup | full-screen onboarding on blank profile | Deterministic conversational setup, not dependent on a model; first task and next action. |
| Pair | `/pair` | Separate pre-auth enrollment client with separate permitted public assets. |
| Styleguide | `/styleguide?entry=<id>` | Rendered design/reference environment. It must never be counted as a shipped app workflow. |

Settings categories (`ui/js/settings-ia.js:8`): You and Nova (`you`); Appearance (`appearance`); Privacy and permissions (`privacy`); Connections (`connections`); Models and providers (`models`); Devices (`devices`); Capture (`capture`); Services (`services`); About Nova (`about`); Security (`security`); Backups and changes (`backups`); Configuration (`config`); Start over (`danger`). Search synonyms and paths already exist and should be preserved. There is no need to invent a new settings hierarchy.

### Current design-only surfaces

The Nov 9 per-merge ledger explicitly identifies the following as compositions awaiting owner reaction, not wired app capabilities: `automations-editor`, `inbox`, `receipts`, `infra-forms`, `computer-door`, `browser-tasks`, `supervisor`, `task-runs`, `memory-surface`, `providers`, `vault`, `home-assistant`. The corresponding documents are `docs/ledger/2026-11-09-<name>-compositions.md` (Automations is `2026-11-09-automations-editor.md`). Approval-tier compositions also landed, but baseline includes a later tier-settings implementation, so the earlier composition's open security questions cannot establish current defects. The security auditor is checking that later state. Similarly, Nov 9 Memory's stale-edit defect was repaired later the same day; it is not repeated here.

Jarvis is a styleguide-only ring composition at `/styleguide?entry=jarvis`, with no theme manifest or Appearance entry (`docs/ledger/2026-11-08-jarvis-compositions.md:2`, `ui/js/sg-jarvis.js`). The Nov 8 ledger records size/greyscale limitations and owner reaction pending. Assess this as an optional design proposal, not a second deployed theme. Preserve the existing owner-supplied Nebula artwork; any concern is about size, placement, contrast, semantic state and treatment, not redrawing the mark.

## Previously raised concerns, rechecked

| Concern | Current evidence | Disposition |
|---|---|---|
| Research Part 3 verification | Nov 7 ledger and `docs/evidence/interstitial-eval.md:3` record a local Tev1 run, fixed preregistered bounds, both template failures, no cloud run. verify-transfer recall 25%, ECE .290; outbound-check recall 2/3, ECE .153. `src/config.js:44` keeps the feature off unless explicitly enabled. | Do not repeat the old claim that no eval artifacts exist. They do. The current request still parks authorization for future real-model verification; no eval was run in this audit. Reconcile recorded history and authorization with the owner, keep disabled, and do not make this a gap to close autonomously. |
| Local chat | `src/runner.js:283` obtains a selected chat provider; `privacyFor` at 292 refuses a provider or command disallowed by the mode. Model-manager local inference exists. | Local chat is implemented as a configurable path; whether the owner's preview currently selects cloud chat and local Tev1 cannot be inferred from this cloud checkout. Primary auditor used a fake-agent orchestration fixture, not real Ollama. |
| Real-phone pairing | `docs/evidence/m4-gate.md` explicitly used a phone-sized browser; `docs/plans/M4.md:285` calls the real camera/phone check manual. `docs/LEDGER.md:662` records the historical iPhone fix and deferred physical retest. | Browser-level evidence exists; real-device completion is still unverified in reviewed records. Do not label the old failure current. Physical phone/installed PWA check remains blocked here. |
| Pipeline dashboard | Actual route `/pipeline`, backend generator and UI (`src/core/pipeline.ts`, `ui/js/about.js`). | Implemented; repair evidence fidelity (NOVA-080), do not backlog building it anew. |

## Findings and implementation backlog

Severity describes harm; priority describes implementation sequence. Effort assumes one builder familiar with this repository, existing test harnesses, and no redesign of unrelated screens. All findings below apply to merged baseline source, with only the stated disposable-runtime evidence. Owner-host deployed applicability is unknown.

### NOVA-080 — Pipeline misclassifies design work and hides the evidence needed to judge it

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

### NOVA-081 — Older Memory reads can redraw content after a newer read removed it

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

### NOVA-082 — Finish the Memory workflow before expanding the knowledge graph

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

### NOVA-083 — Complete ordinary rule authoring instead of exposing an empty rule collection

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

### NOVA-084 — Home implies a daily Brief can be configured, but the card has no workflow

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

### NOVA-085 — First-use import instructions name the wrong host folder

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

### NOVA-086 — Keeping an imported memory changes its source label to a conversation

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

## Three consequential maintenance problems

1. **Parallel API projections let safety and usability semantics diverge.** `src/server.js:388` serves old `/api/memory`; `src/core/index.ts:1334` serves richer `/api/v1/memory`; `src/memory.js` adapts file-backed memory and the core. The actual app consumes the old projection (`app.js:113`). Nov 9's stale-correction fix explicitly says core already rejected stale writes but the old route did not. This is demonstrated change-cost and reliability risk, not a complaint about file length. Close NOVA-082 by migrating one workflow to the canonical contract with compatibility tests, then retire the redundant mutation route when old clients have a transition path. Keep plain-file interoperability and SQLite authority.
2. **View data/focus/draft lifecycles are screen-specific and easy to get wrong.** `app.js:113` lacks the generation protection in `about.js:35`; `app.js:1834`/`:1862` preserves drafts for Models/Capture only; surfaces Backups maintains its own epochs/revisions (`surfaces.js:581`); schedules manually restore fields (`app.js:1365`). The Nov 9 Models lost-edit/focus repair and NOVA-081 show practical consequences. Extract a small shared lifecycle contract (latest read, durable dirty form, explicit mutation refresh, focus key), not a framework rewrite. Exercise delayed reads and focus traversal as behavior tests. Effort 2–4 days incrementally across touched surfaces, after the narrow race fix.
3. **Human prose is also an unvalidated runtime data contract.** `pipeline.ts` heuristics turn ledger headings/first lines into completion states; composed designs get Merged and unfinished lists disappear. This makes a documentation edit alter user-visible product truth without a type or schema check. Fix NOVA-080 with a few validated metadata fields in the existing canonical ledger. Preserve plain-language narrative and generated views; do not create a second tracking database merely to avoid parsing Markdown.

Strengths worth preserving: the November shared HTTP client already landed (`docs/ledger/2026-11-09-http-client.md`), so “unify all HTTP clients” is stale advice; pairing deliberately retains a public-only client. Per-screen modules, shared semantic components/tokens, centralized navigation/search, actual Home-start reachability tests, and evidence-backed state vocabulary are useful foundations. No big-bang UI rewrite or microservice split is justified by these findings.

## User-understanding plan

Start with one sentence close to the first useful action: **“Nova keeps your context on your hub, turns requests into tracked work, and shows what it used and checked.”** Follow it with the capabilities this installation can actually perform now. Do not teach the complete OS metaphor before a user gets a result.

| Concept | User-facing explanation | Context and next action |
|---|---|---|
| Hub | “The computer that keeps your Nova running and stores its records.” | Setup/Devices; name it, say which browser is merely connected, show offline recovery. |
| Device roles | “What Nova is allowed to do on this computer.” | Keep existing role explanations; progressive details for compute/storage/capture. |
| Chat model vs decision model | “The chat model writes replies. The decision model checks small choices and screening questions.” | Composer status details shows active chat destination; Models shows separate rows and unverified/advisory state. A local checker does not make cloud chat local. |
| Seat | Advanced term for a configured decision provider | Label ordinary settings “Decision model”; use seat/provider id only in expandable technical details. |
| Privacy modes | Local only / Local first / Cloud allowed, each stating when data may leave | At mode switch and immediately before exceptional disclosure; failures say why and link to the exact recoverable setting. |
| Capture vs memory | “Capture is source material. Memory is what Nova keeps for later use.” | Capture item → screening/provenance → review candidate → kept memory; identical source link throughout. |
| Tiers | “Runs silently / Runs and tells you / Asks first / Requires explicit confirmation” | Show concrete action and consequence on approval; retain tier number in details. Do not make users memorize numbers. |
| Verified | “Nova checked the evidence required for this task.” | Show what was checked and what was not; don't imply a model's confident reply is verification. |
| Automation | “A trigger that starts tracked work or sends a message.” | Explain daily schedule versus external event at creation, then one destination/task trail. |

The first useful loop should be deterministic and small: import one synthetic/user-chosen note → inspect its source → approve it → find it again. This is usable even if no chat model is installed. The next loop is ask for a task → see running/waiting/failed state → inspect evidence → return to the conversation. Returning Home should prioritize actual needs-you, latest checked outcome and the next real scheduled item; empty cards should either teach one available action or disappear. Do not require a tour, animation or gamification to compensate for absent actions.

Apply the references in their relevant roles: Linear's aligned peer rows and status grouping suit Tasks/Activity; Things 3's quiet list with contextual selection actions suits Memory triage; Claude.ai's single composer and restrained empty chat suit conversation. The filed Linear image's More menu is not permission to copy it: Nova's later owner ruling explicitly bans overflow navigation. Its color choices similarly do not override Nova's red-stops/amber-attention semantics. These are layout principles, not reskin instructions. Keep the owner artwork as the presence asset and let text/action hierarchy carry comprehension.

Observable usability acceptance for this plan: with five technical self-hosters who have not used Nova, at least four can explain which computer stores data, identify the active chat destination independently of the screening model, find a source-backed memory, predict whether a proposed action asks for approval, and recover from an unavailable model using only the interface. Record task completion, first wrong turn, and assistance needed; this is proposed research, not testing performed in the audit.

## Separate gap lists

- **A — Required/promised but missing:** ordinary Memory search/confirm/export workflow; core rule editor; queued receipts/inbox/task-run/Computer/browser/supervisor workflow wiring. These are explicit queued commitments, many already at owner-gated design stage, not regressions discovered through screenshots.
- **B — Implemented but inaccessible/undiscoverable:** core memory search/confirm/export and rich record state; rule create/update/fire API; several task-specific operations requiring backend/API setup before their conditional UI appears. Complete the canonical action doors before adding another broad dashboard.
- **C — Exposed but broken/misleading/incomplete:** pipeline design-state/evidence fidelity; stale Memory read ordering; unsupported Home Brief setup promise; incorrect first-import path and handoff.
- **D — New opportunities:** deterministic one-note first-use loop; unified next-action/state/evidence details across daily workflow; optional graph exploration (separate knowledge-plan contribution); real digest → Home integration beyond immediate honest-copy repair.

## Coverage rows contributed

| Surface/workflow | Role/mode | Theme/viewport | State | Result | Evidence and exact boundary |
|---|---|---|---|---|---|
| Destination/settings inventory | source | n/a | registered | tested-pass | Imported/read production route registry and category definitions; not a browser click crawl. |
| Pipeline status generation | source, no network | n/a | real baseline records | tested-fail | `product-probes.json`: design-only items classified Merged. |
| Pipeline evidence inspection | source | n/a | nested evidence | tested-fail | components:1220 plain spans; pipeline:69 first-line parser. Browser accessibility not independently exercised here. |
| Memory response ordering | audit console; controlled synthetic GETs plus source VM | Chromium 1440×900, dark, reduced motion | older response after newer | tested-fail | `product-memory-browser.json` and screenshot: empty screen overwritten by old entry; two requests, no JS errors. GET interception only, not backend restoration. |
| Memory search/confirm/export | source | n/a | populated capabilities | untested | App/source route mismatch established; root's runtime sweep supplies actual visit. |
| Automations create/edit | source | n/a | absent editor | untested | Source has list/pause/resume/delete; design-only editor. No real schedule run performed here. |
| First-run import path | synthetic config plus primary auditor runtime | root's setup viewport | custom home | tested-fail | static string vs actual configured path; primary `setup-workflow.json`, `setup-finish.png`. |
| Home Brief | source plus primary/visual runtime | root's viewports | fresh | tested-fail | permanent default card; no production brief data argument. |
| Local/cloud chat | source | n/a | routing | untested | paths traced; real model/runtime configuration not observed here. |
| Research Part 3 | source/recorded evidence | n/a | disabled, failed templates | blocked | Current instruction parks authorization; no eval run; existing November artifacts reviewed only. |
| Real-phone pairing | physical device | physical phone/PWA | pair/reload/revoke | blocked | No physical device or owner's preview; historical emulation evidence distinguished. |
| Jarvis | source/ledger | styleguide only | composition | untested | No implemented app theme to select; primary visual audit assesses rendered composition. |
| Filed design references | visual files | static reference | appearance | tested-pass | Three references viewed; AVIF converted to `product-linear-reference.png` only for inspection. This proves reference appearance, not product correctness. |

## Decisions and limitations

The current user instruction, rather than older ledger statements, controls authorization: no live research eval or model call was performed or authorized. The owner should reconcile the parked Part 3/no-model-tests decision with the Nov 7 recorded runs, then decide any future exception explicitly. Failed local templates stay disabled/untrusted. No findings here require that decision to be resolved before fixing first-use copy, Memory freshness, pipeline evidence or existing workflow wiring.

No deployed owner-host configuration, watcher health, real phone, actual Ollama conversation quality, remote provider behavior, or external integration correctness was inferred. Root owns the wider live disposable-browser observations and full coverage matrix; this contribution additionally supplies the controlled-response Memory browser reproduction. No production implementation is part of this contribution.

## Follow-up: actual Memory, settings, schedule and theme workflows

The primary auditor requested a bounded functional follow-up, completed using an independent synthetic home at `/tmp/nova-astra-product-workflows-NzankK/nova-home`. The server was stopped between follow-ups and restarted only against that owned home on an ephemeral loopback port; all instance URLs are recorded in `audit-astra/evidence/product-workflows.json`. No mutation was made to shared audit instance 4418 or any owner/preview home. `seedUserHome` supplied neutral notes; setup was prepared over the real API. Local discovery was pointed at an owned HTTP 404 stand-in for all service types, so no real Ollama, Screenpipe or Home Assistant was contacted. The acceptance harness egress guard remained active and its log remained empty. `fake-agent.js` was configured; the digest was enabled/paused but not run, and no model call occurred.

After setup, every named mutation below was a real Playwright click/keypress in the app, followed by rendered and/or canonical API read-back. Service workers were blocked in these contexts, so these results do not prove offline/PWA behavior. All screenshots were written to `audit-astra/evidence/product-workflow-*.png`; no tracked product screenshots were overwritten. Scripts: `diagnostics/product-workflows.mjs`, `product-theme-workflow.mjs`, `product-settings-child.mjs`. Server and execution logs are alongside the JSON.

| Workflow | Role/mode | Theme/viewport | State and observed result | Result | Evidence row |
|---|---|---|---|---|---|
| Approve imported candidate | Console/local-only | Nebula dark, Chromium 1440×900 | Two notes began outside active memory; Keep on Garden plans removed its candidate and produced a confirmed record. | tested-pass | `candidates-before`, `kept-and-dismissed` |
| Dismiss imported candidate | Console/local-only | Nebula dark, Chromium 1440×900 | Drop on Reading list removed the candidate without adding an active record. | tested-pass | `kept-and-dismissed` |
| Inspect imported provenance after Keep | Console/local-only | Nebula dark, Chromium 1440×900 | UI incorrectly says “from a conversation, today”; stored canonical source remains the imported file. | tested-fail | `kept-and-dismissed`, `source-label-dom`; NOVA-086 |
| Correct and reload Memory | Console/local-only | Nebula dark, Chromium 1440×900 | Edit→Enter saved neutral correction; reload preserved wording; core retained lineage. | tested-pass | `correction-reload` |
| Forget and Undo | Console/local-only | Nebula dark, Chromium 1440×900 | Forget removed active entry; actual visible Undo restored it, with canonical read-backs before and after. | tested-pass | `forgotten`, `forget-undo` |
| Save a labeled setting | Console/local-only | Nebula dark, Chromium 1440×900 | “Your name” textbox→its Save→reload retained Audit Rowan; core profile matched. | tested-pass | `setting-reload` |
| Enable and pause morning digest | Console/local-only, fake actor configured | Nebula dark, Chromium 1440×900 | Turn on exposed scheduled entry/next time and Pause; Pause changed to Resume and survived reload. Digest content/execution not tested. | tested-pass | `digest-enabled`, `digest-paused-reload` |
| Apply device-only theme | Console/local-only | Touch-emulated Chromium 390×844, Nebula→Orb Teal | This device scope applied instantly and displayed Undo. | tested-pass | `theme-device-applied` |
| Undo theme | Console/local-only | Touch-emulated Chromium 390×844 | Visible Undo restored Nebula. | tested-pass | `theme-undo` |
| Persist device theme | Console/local-only | Touch-emulated Chromium 390×844, Orb Teal | Reapply and reload kept Orb Teal; no-device API still reported Nebula as synced default. | tested-pass | `theme-device-reload` |
| Devices→hub Models→Back | Console/local-only | Nebula dark, Chromium 1440×900 | Actual Settings→Devices→Models click opened `/settings#models-on-hub`; in-view Back returned to `#devices`. No model pull/assignment performed. | tested-pass | `hub-models-child`, `hub-models-back` |

The source-label DOM follow-up confirmed zero source anchors on the imported item: `from a conversation, today` was plain text. Therefore NOVA-086 is false attribution and missing source access, not a tested broken conversation-link click. The first Models-child harness selector matched a hidden button in another settings pane and timed out; this is preserved in raw evidence and explicitly marked a harness error. Scoping to the visible Devices pane produced successful actual clicks and Back navigation. No product failure is inferred from that timeout.

These passes narrow the findings: Memory Keep/Drop, edit, forget and Undo do work in a normal serial workflow. NOVA-081 concerns out-of-order reads, and NOVA-082 concerns the richer search/confirm/export/state workflow; neither should be described as all Memory being broken. Morning digest scheduling is usable through its catalog even though arbitrary core-rule editing remains absent. Theme scope, immediate application, Undo and persistence are strengths worth preserving. The incorrect imported-source label is a newly observed independent defect, NOVA-086, and should be repaired before a graph treats the rendered provenance as authoritative.
