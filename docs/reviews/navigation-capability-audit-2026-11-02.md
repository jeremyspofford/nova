> Independent static audit, retained in full. Final rendered reconciliation and current app-shipping decisions are in [the surface mapping](../evidence/navigation-capability-surfaces-2026-11-02.md). Candidate selectors below are not runtime passes. The final navigation fix moves Capture into its own visible category and adds the requested Topology doors; baseline source descriptions below are historical.

# Independent capability claim and rendered-surface audit

Checkout: `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`
Branch: `codex/navigation-reachability`
Observed HEAD: `6d0a74a58a3a20df7f3718b2ade2413c1ba84e8a`
Inventory SHA-256 when read: `cefbe03bf72ffd9b9b67a09bc1bb6c40fa2016bc874e9686e6a29be7c3c005bd`
Audit date: 2026-11-02. Static source review of the baseline/source observed before the implementation agent completes its concurrent navigation changes. Source line references describe that audit baseline; this report does not certify the final working-tree implementation. Static source review only. No servers, tests, credentials, browser sessions, runtime writes, source edits, inventory edits, or commits were performed by this reviewer. Only this report was written.

## Verdict and evidence rules

All **51 inventory capability rows** (lines 12–74), the explanatory/history text, and the three explicit exclusions (lines 77–79) were read. The complete original 79-line inventory is preserved in the appendix, so every individual subclaim and qualifier can be compared against this mapping without relying on condensed row names. Long cells were read in bounded chunks; no truncated table cell was accepted as coverage.

A single `Have` column currently mixes implementation evidence, APIs, CI mechanisms, gated existing-task controls, and discoverable product workflows. Add **Current app shipping / surface** as a separate column on **every** row. Rename/explain Existing (verified) as **Implementation evidence and history**. A new column must enumerate the unshipped/API-only pieces rather than placing one vague Chat or Health label on a broad row. Preserve all `UNPROVEN`, stand-in-only, live-owner checks, unsupported adapters and security limits. Prior backend/test history was not rerun or independently re-proven here; the appendix records what it claimed, while actual route/control composition is separately inspected.

**Zero rendered-crawl passes are asserted by this report.** “App candidate” means an actual rendered selector plus click path exists in source and must still be exercised from Home in both layouts. “Partial” is not permission to leave the rest implied shipped. An existing-task sheet is a real surface for review/approval; it does not establish creation/discoverability of that task type. A generic Chat input is not a coding/browser/infra/network/account/delegation affordance unless a visible capability-specific prompt or control leads there. A backend automatic safety mechanism may remain documented as implementation evidence, but its invisible internals are not separately app-shipped controls. No secret values or personal runtime data were read.

## Shared concrete doors (used by every mapping below)

All paths and source references in this report resolve against the explicit checkout above. Selector IDs are source values, not proof of runtime presence. The source root for every relative source citation is `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/`.

- **N**: From rendered Home, phone tabs expose `[data-dest=chat/tasks/memory]`; `#more-btn` opens `#more`, then `[data-dest=automations/skills/activity/health/settings]`. Rail exposes Home orb, Chat/Tasks/Memory/Automations; `#more-btn` exposes Skills/Activity/Health; foot exposes Settings. Evidence: `ui/js/nav.js:3–36`, `ui/js/shell.js:99–160` (real anchor/buttons), `ui/js/app.js:257–277` (route dispatch). Arrays alone are not crawl evidence.
- **P**: N → Settings → `a.settings-cat[href="/settings#<category>"][data-cat]`, visible grouped list on phone/sidebar on expanded rail; one selected `.settings-pane[data-cat]`. Categories: you, appearance, privacy, connections, models, devices, services, backups, danger. Evidence: `ui/js/settings-ia.js:9–20`, `ui/js/app.js:1556–1591,1644–1705`. Search `#settings-search` gives actual target/category results; hidden panes and direct hash navigation are not substitutes for clicks.
- **T**: N → Tasks `/tasks` → existing task `[data-action=open-task][data-task]`; sheet branches on approval owner and task state. Evidence `ui/js/surfaces.js:156–225`; `ui/js/components.js:144–175,504–720`. Empty Tasks has only generic “Ask Nova to do something”, not capability prompts.
- **M**: N → Memory `/memory`; edit/forget/provenance/candidates from `ui/js/view.js:437–510`, dispatched `ui/js/app.js:931–1047`. Empty Memory explicitly offers “Tell Nova something to remember”; that is genuine memory discoverability.
- **A**: N → Automations `/automations`; generic rule list above schedules. `ui/js/surfaces.js:411–432`, `ui/js/components.js:725–734`, `ui/js/view.js:705–722`. Schedules explicitly offer a reminder example and available workflow setup; generic rules do not offer creation.
- **H**: N → Health `/health`; Problems/Checks/Keeping Nova running from `ui/js/surfaces.js:330–407`. A Health check count is not a detailed record browser or a feature-start control.
- **B**: P → Backups and changes `[data-cat=backups]`; `#checkpoints`, `#changes`. Concrete checkpoint/changes controls are distinct from absent nightly-backup configuration.
- **C**: P → Privacy and permissions `[data-cat=privacy]` → `#capture` → `a[href="/capture"]` Open Capture; conditional global `#capture-ind[href="/capture"]` is a second door only while active/unknown. `ui/js/capture.js:77–97,173–224,326–388`, `ui/js/app.js:1891–1918`. This is an actual secondary view beyond the nine primary destinations.
- **Y**: P → Services `[data-cat=services]` → `a[href="/topology"]` View machines and services; H → Devices check same link. `ui/js/services.js:27–45`, `ui/js/surfaces.js:338`; `ui/js/topology.js:75,183–197`, `ui/js/topology-view.js:39–65`. Then `[data-topology-machine]`, `[data-topology-service]`, `[data-topology-version]`, review promotion/rollback; Refresh/Download Mermaid. Eligible data, freshness and policy determine enabled state. Cluster fixture sites do not prove production cluster support.
- **X**: P → Start over `[data-cat=danger]` → `[data-action=reset-start]` → Export everything first `.reset-sheet[data-step=export]`. This is a genuine export surface nested inside a destructive-reset flow, not a standalone Memory export button. `ui/js/reset.js:37–64`. Do not confirm erase in a crawl.

## Complete mapping: each original inventory row and shipped subclaims

“Correction” is recommended **new current-app-column copy and corresponding stale-claim repair**, not a claim this reviewer edited the inventory. Phone and rail share each suffix after N/P; final crawl must prove both separately. Conditional task/device/model/connector states require fixtures and must remain explicit.

| Original line / capability | Original current label | Shipped/implemented subclaims, with scope and gaps | Actual surface and source evidence | Proposed precise current-app status/correction |
|---|---|---|---|---|
| C01 / L12 — Chat with a swappable agent (`agent_cmd`) | Have (M5a v1) | Registry/custom-cli default and swappable chat model; shared scheduled/helper routing; egress/receipts; provider recommendation; unported adapters/catalogue. | P → Models and providers → #providers: [data-action=provider-choose], details All providers, provider-setup/on/off; Chat #composer #input #send. surfaces.js:959–1068; models.js:193–229; app.js:727. | Partial app surface pending crawl: chat and provider setup/choice are concrete. Registry/identity/egress mechanisms are implementation evidence. Detailed per-call receipts API-only (O07). Preserve named unported adapters. |
| C02 / L13 — Multi-agent delegation (brief-in/report-out) | Partial (M1 plus historical runtime helper description) | Structured brief/report envelope and one local worker; old text says helpers outside ledger/in-memory; no structured historical evidence. | Activity → helper entries → Every step/Read report, stop-helper/retry-helper; Tasks → task sheet → The ledger entry. view.js:356–382,803–847; surfaces.js:172–225. src/tools.js:227 exposes delegate only to agent. | Partial: existing helper follow-up/status controls visible when a helper exists; initiating delegation is tool-only, no discoverable helper-start prompt/control found (O01). Update stale helpers-outside-ledger assertion: server.js:57,128–131 binds helpers and schedules to ledger. Do not label full delegation shipped. |
| C03 / L14 — Work Ledger (durable tasks) | Partial (M1) | Durable SQLite states/events/gates/retries/recovery; old one-at-a-time/schedules/helpers/no-UI gaps. | T: grouped task rows [data-action=open-task][data-task], approval/evidence/history/retry/cancel. surfaces.js:156–225; components.js:144–175,504–540. | Partial app: task review/status/approval/evidence/retry/cancel are concrete, runtime persistence remains implementation evidence. Generic task/structured brief creation has no rendered form (O02). Remove stale no-UI M3 and schedules/helpers-not-on-ledger as current gaps; retain dated history. |
| C04 / L15 — Verification / evidence layer | Partial (M1) | Read-back verifier; unsupported historical evidence kinds; prior artifact/string evidence. | T → task row → .evidence, How Nova checked .checks, details The ledger entry; components.js:144–175. | App evidence review candidate pending crawl, not evidence that every checker exists or every capability can be initiated. Keep read-back/current-checker support described as backend evidence; historical unsupported kinds must not override later added checkers. |
| C05 / L16 — Decision journal + calibration | New | Journal absent; template-use statistics only. | No decision journal route or control found. Template stats are in backend records; no general template stats UI. | Not shipped. Preserve template statistics as implementation-only. No new product door required for a capability already marked New. |
| C06 / L17 — Trigger engine (reactive/proactive/event/heartbeat) | Have (M2 v1) | Reactive/proactive/event/heartbeat engine; visible registry; per-firing records, dedup/cooldown/batching/quiet hours/token hooks. | A: Rules .trigger-row [data-action=pause-rule/resume-rule/delete-rule]; surfaces.js:411–432; components.js:725–734. Schedules offer setup forms plus Run now/Pause/Resume/Remove and explicit reminder prompt, view.js:705–722. | Partial app: list/pause/resume/delete existing generic rules and scheduled workflows are visible. Generic rule creation/edit/dedup/cooldown/fire/webhook setup and firing/triage history are API-only (O03–O06). Core mechanisms are implementation evidence, not independently shipped settings. |
| C07 / L18 — Long-term memory w/ provenance | Have (M2 v1) | Provenance records; correction history; forget incl backups UNPROVEN; JSON/Markdown export. | M: .memory-source, edit-memory/forget-memory, Keep/Drop candidate buttons; view.js:437–510, app.js:931–1028. X export sheet writes memories as plain files (reset.js:51–64). | Partial app: memory view/edit/forget/provenance/candidates reachable; full correction history/confidence inspection absent (O08); standalone memory export API-only (O09). Export is also reachable only inside reset initiation, not a standalone memory export flow. Preserve UNPROVEN and avoid proving backup deletion from a Forget button. |
| C08 / L19 — Context receipts | Have (M2 v1) | Every chat model call records context receipt; ?egress=remote egress log. | H Checks can show Context receipts counts via components.js:455 and surfaces.js:315,338; src/core/index.ts:1229–1237 GET /receipts. No receipt list/detail/filter UI. | API-only receipt/egress-log capability; Health receipt counts are only a narrow status surface (O07). Do not mark full context receipts app-shipped. |
| C09 / L20 — Identity/persona layer (model-independent) | Have (M1 v1) | Fixed charter/profile tuning every model; chat uses it; configurable Nova name. | P → You and Nova: #nova-name #you-name Save, #directness select; surfaces.js:437–444; Chat #composer. | App identity/tone/name controls candidate pending crawl; model-independent prompt enforcement remains backend evidence, not separately inspectable charter editor. |
| C10 / L21 — Deliberation + critic pass | New | Deliberation/critic pass absent; adjacent action reviewer history only. | No deliberation/critic control found. | Not shipped; historical fail-closed reviewer is not a shipped deliberation pass. |
| C11 / L22 — Decision Model Provider (Jev-class System 1) | Partial (M2) | DecisionProvider interface, local rules, Jev stub; Noul/Choice/Score. | P → Models → #decision-model, form[data-form=decisions], Jev route/model/key, Tev1 size and opt-in controls. models.js:130–163. | Partial app configuration/advisory status only; interface/question types/rules are backend mechanisms. Jev live service unverified/not shipped as real integration. No general decision-request or template-authoring UI (O10). |
| C12 / L23 — Ingest security gate (prompt-injection screen for outside content) | Have (v1, gate follow-up) | Outside reads/each chunk checked; deterministic + model scores/thresholds; mode routing/opt-ins/taint; outbound secrets guard; memory approvals; screen and decision records; corpus/matrix/eval tests; timing/local-capture limits. | H → Checks → Outside content detail and seat lines (surfaces.js:315–322); P → Models #decision-model screening opt-in; M Waiting for your OK Keep/Drop; Chat tool approval cards; C event screening/provenance details. models.js:130–163; view.js:464–475; capture.js:247–293. | Partial app: concrete visible status/config/approval/per-capture verdict. Automatic safety behavior remains implementation evidence; full ingest_screen/decision_record per-read audit browser is absent (O11). Preserve every trust/eval/time limit and do not use Health alone as proof of all guards. |
| C13 / L24 — Local decision provider for the Jev seat (Tev1 via Ollama) | Have (v1 advisory) | Local Ollama Tev1 interface/caps/overlap/availability; both v1 eval sizes failed; advisory scores; cloud stand-in only; Health/device lines. | P → Models #decision-model: Tev1 size, availability, per-template trust scorecards; Your devices decision_model line (models.js:73–80,130–163); H Outside content seat lines. | Partial app advisory configuration/status candidate; no trusted ingest-screen model or live cloud Jev shipping claim. Download through ordinary model pull form, not a separate Tev1 provisioning wizard. Evaluation values retained as dated evidence. |
| C14 / L25 — Decision Service (registry, seats, decision log) | Have (DS1) plus DS2/capture/memory follow-ups | Registry/versioned templates/truth-table policies/seats/log/consumer boundary; ingest v1/v2 failures; capture-sensitive pass 4b/fail 0.8b and live intake/promotion consumers; local routing/cache/backoff/provenance; memory-gate pass but NOT live; recall/cloud-opt-in/eval gaps. | P → Models #decision-model seat setup, scorecards, screening/box inputs; H Outside content; C event screening details (.capture-screen, template/seat/model/provenance) plus held notices, memory-review/capture proposal controls. models.js:130–163; capture.js:247–356. | Partial app seats/scorecards/capture verdict/review, not a general registry/template/policy/log editor (O10–O11). Memory-gate runtime explicitly not shipped; capture recall screening/per-source cloud opt-in explicitly not shipped. Correct blanket no-template-has-passing-eval to ingest-screen v1/v2 have no passing eval; capture-sensitive and memory-gate have scoped passes. |
| C15 / L26 — Golden-task eval harness (regression gate, capability suite, injection suite) | Have (v1) | 28 task harness; CI regression stand-ins; opt-in real runs; 99-case injection suite; Models scorecard route/display. | P → Models role .model-score for assigned/recommended model; #decision-model .model-cards; Providers recommendation text. models.js:28–34,65–95,130–163; surfaces.js:969–1002; core/index.ts:1501–1506. | CI/developer mechanism, not an app-run eval suite. App scorecard summary candidate pending crawl. No suite/run case history or Run evaluation UI (O12). Preserve stand-in/live separation. |
| C16 / L27 — Model-swap scorecard per provider/model | Have (v1 data only), claims route/display unwired | Per-provider/model stored scorecards; current/stale/none; scripts/evals.sh. | Same actual scorecard summary surfaces as L26: Models fetches /evals/scorecards and scoreLine; Providers fetches /evals/scorecards/status; server wires scorecardRoutes. | Partial app summary display is wired: remove stale route/display-not-wired gap. Full provider/model card explorer/run history remains API/data/developer-only (O12); no arbitrary model-switch safety guarantee inferred. |
| C17 / L28 — Claims register (capabilities claimed vs. what the suite demonstrates) | Have (v1 enforced user-facing text) | 71 claims, counts/backed/softened/instruction; CI detection of unbacked or prohibited strong words; old 18/28 history. | No claims-register product destination/editor. Source tests/evals/claims.ts and npm test gate only. | CI/developer-only; not an app capability. Preserve historical counts explicitly dated instead of implying current live UI register (O13). |
| C18 / L29 — Cost ceilings on autonomous work (per task and per day: steps, tokens, priced dollars), loop detector, resume as a new approval | Built inert until wired | Per-task/day steps/tokens/dollars ceilings, loop detector, new approval resume; core/hooks/tests; gaps wiring/limits/Health/provider/replicated usage. | No autonomy-steps/tokens/day limits UI; Models Cloud budget form covers a different per-task/per-period inference budget (models.js:217–224). core/index.ts:183 exports caps but does not compose capsRoutes/new Caps. | Not shipped/inert implementation. Do not equate model Cloud budget with autonomous-run caps (O14). Preserve all wiring gaps. |
| C19 / L30 — One-click diagnostics bundle, redacted by construction (no secret, no personal content, local only) | Built, missing route/link | Redacted/local diagnostic bundle; tests; integrity scrub not built. | No Health download link. core/index.ts:186 exports diagnosticsRoutes but does not compose it. | Not shipped/inert diagnostics implementation; route and Health UI pending, integrity scrub not built (O15). |
| C20 / L31 — Decision templates (cached, validated, versioned) | Have (M2 v1) plus M7 templates via change pipeline | Cache-miss authoring/schema/dry-run/activation; triage@1; version ship/rollback; no drift/retirement. | B → Changes: template-labelled records, Evidence for every stage, Ship it and Roll back if record exists; Tasks activation approval/evidence. changes.js:34–111. No template authoring or registry surface. | Partial app review/ship/rollback of already proposed template changes only. Authoring/registry/cache/statistics/dry-runs are API/backend-only (O10,O16); calibration drift and retirement not shipped. |
| C21 / L32 — Approval tiers (NOVA-SPEC §6) | Partial (M1) | Ledger tiers 0–3, tier 2 OK/tier 3 confirmation; full per-capability policy absent; old yes/ask tool permissions. | T → approval-sheet [data-action=approve], tier3 input[name=confirm]; Chat approval [data-action=allow/deny]; P → Privacy #perms .switch[data-action=toggle-permission]. components.js:504–540; view.js:182–212,855–864. | Partial app approval interaction and legacy tool yes/ask switches; tier enforcement backend evidence. Full four-tier per-capability policy settings not shipped (O17). |
| C22 / L33 — Governed self-modification (ADR-9 pipeline) + the foundry | Have (M7a v1) | Versioned five change kinds/replication; sandbox/tests/contracts/health/release approval/canary/promotion/auto rollback/manual rollback; frozen guards; foundry generates four pack kinds; declarative extensions only. | B → #changes: Ship it [changes-ship], checkbox changes-confirm, Not now, stage Evidence details, live canary, changes-rollback/rollback-yes. changes.js:34–139. | Partial app pipeline review/approval/evidence/rollback candidate. Propose arbitrary change and invoke foundry have no rendered start control (O16,O18). Preserve all pipeline mechanics as backend history and no-code-extension limitation; do not mark foundry authoring app-shipped. |
| C23 / L34 — Service orchestration: the Service Manager and its drivers (owner input 2026-10-31) | Partial M10e–M10i | Definitions/validation and chart mapping; driver interface/manager stages; local supervisor slots/pinned artifacts/ports/argv/soak/rollback/recover; placement/roles/hardware; native signed device rollout and Screenpipe stand-in; map source ages/health/Mermaid/actions; extensive not-built/OS limits. | P → Services #services-backend → View machines and services; H → Devices check same link; Y map → data-topology-machine → data-topology-service → data-topology-version/promote/rollback; data-topology-refresh/export; services.js:27–45; topology.js:75,126–197; topology-view.js:39–65. | Partial app: backend explanation, observed machine/service/version map, Mermaid and review of existing eligible promotions/rollbacks. Service definition create/register/plan/deploy/recover/placement simulation/argv review remain API/CLI-only (O19–O23). K3s/service change kind/services.git/image/Docker/https/secrets/floating multi-copy remain not shipped. Map fixture-only cluster sites are not a production cluster driver. Do not rewrite plain programs as enforced egress/OS sandboxing. |
| C24 / L39 — Device pairing (QR / code / command) + hub approval | Have (M4a) plus M10f roles | QR/code/command enroll; digits/approval/keys/sessions/revocation; device roles/defaults/edits/candidate confirmation; join.sh/agent. | P → Devices Add a device; QR/address/code/command sheet, copy-command; review-request + join approval digits/roles; edit-roles/confirm; revoke-device; allow-approve. surfaces.js:653–711; components.js:247–318,427–446; /pair via generated URL or QR external-device enrollment. | Partial app reachable pairing/approval/roles/revoke candidate with proper prerequisites. Actual other-device pairing is external navigation/another client and must be separate crawl evidence; mesh listener configuration is env/CLI only (O24). Preserve security protections as implementation evidence. |
| C25 / L40 — Device mesh + hub-as-role + failover | Partial M4 mesh + M10g promotion | Planned promotion checks/drain/catch-up/signed epochs/rollback/settlement; emergency backup restore; trust/fencing/split/DNS driver; standby replication/failover; promotion drill and gaps. | P → Devices promote-device, promotion status/cancel/take-back; banner promote/promote-cold when standby/demoted; roles and tasks evidence; H Devices/Keeping Nova running. surfaces.js:676–686,872–947; app.js:619–639. | Partial app promotion/pre-check/settlement/status controls conditional on standby/candidate/banners. Standby enrollment, automatic-failover policy, promotion rehearsal, stable mesh-name driver/window settings remain CLI/API/env-only or unbuilt (O25–O29). Historic M4 re-enroll gap should be dated because planned handover now makes old hub live standby. |
| C26 / L41 — Two device agents (boot + runtime, never merged) | Have (M4b) plus M7b/M10h | Boot/runtime split/keys/join/signed roster/bundles/watchdog/permission sandbox/heartbeat/offline queue; workload verbs/runtime rollout; capture carrier; safe-mode recovery. | P → Devices Add a device command sheet, online/safe-mode registry row; H problem playbooks/repair where applicable; Y native workload/version observations. | Partial app installation instructions and status/problem visibility. Runtime bundle publishing/install/queue management/workload deployment lack rendered controls (O23,O30). Automatic carrier/watchdog/sandbox mechanisms are implementation evidence, not a user-operated agent-manager surface. Keep Linux-only cleanup and workloads-as-person limits. |
| C27 / L42 — Capture API + Screenpipe ingest | Have (M6a) plus M10h spokes/screening | API consent/pause/indicator/private-window exclusion/rules/spaces/retention/forget/promotion/triage/events; Screenpipe cursor/outage; spoke signed sync/queue/provenance/lag/tombstone/raw fetch/cloud refusal; sensitive-app drops/pattern redaction/local verdict/holds; adapters not built. | P → Privacy #capture: screenpipe form/edit/key, source Turn on/Pause/Off, exclusion/allow/signal/space/retention; Open Capture anchor. C: Remember/Forget, proposal Remember this/Not this, Which space, held/review panels, provenance/screen details. Y machine Capture lag. capture.js:113–224,247–388; topology-view.js:50. | Partial app settings/timeline/consent/promote/forget/verdict/lag candidate. Raw-original request and per-spoke deletion acknowledgement/queue diagnostics have no dedicated UI (O31–O33). Correct lag on Health or map not built: map does show lag now. Keep native desktop/Android/other adapters/real Screenpipe check and UNPROVEN. Resolve held-not-kept wording versus held text stored locally; do not imply hard private-window guarantees beyond best effort. |
| C28 / L43 — Local model management (detect HW, recommend, download, serve) | Have (M6b) | HW/device map/recommendations/role assignment/disk-budgeted verified downloads/remove/version; inference role; WOL/measured wake/small jobs; local decision sorting role; no transcriber. | P → Models Your devices/What runs where/Use these; models-pull/remove/approve/cancel, form[data-form=pull/disk], installed disclosure and download progress. models.js:73–124,193–229,260–284. | Partial app recommendations/accept/download/remove/status/budget candidate. Arbitrary manual role/model/device/address assignments and WOL configuration only through API/profile absent rendered form (O34–O35); automatic inference/wake behavior is backend history. Preserve no transcription, stand-ins/LAN check, UNPROVEN recommendation claim. |
| C29 / L44 — Cloud/local provider fallback chains | Have (M6b) | Privacy-scoped local/cloud fallback; local-only wait; local-preferred receipt/problem; cloud-allowed local note; cloud budgets/usage/waiting; before-output single-cloud limits. | P → Privacy name=privacy radios; P → Models form[data-form=budget] per-task/period US$, Cloud words; T waiting reason/retry; H model problem. models.js:217–224; surfaces.js:448–456,211; raw receipt via API only. | Partial app mode/cloud budget/wait/problem visibility. Detailed fallback-chain/usage/receipt log and configuration of cloud chain are not a rendered explorer (O07,O36). Single-cloud/pre-output limitations remain; local-only routing still UNPROVEN in inventory evidence terms. |
| C30 / L45 — Voice chat | New absent | Voice chat absent. | Chat #mic is browser SpeechRecognition dictation; app.js:1817–1859 explains browser/network requirements. P Privacy and permissions search includes voice; no Nova speech conversation/response voice. | Not shipped voice chat. Narrow existing dictation control can be recorded as browser-dependent text input only, not spoken conversational channel (O37). |
| C31 / L50 — Extension host (MCP, plugins, connectors, skills) | Partial M1 host skeleton + M5 connector kind | Manifest install disabled/review/enable/disable/remove; host executes no plugin/MCP code; skills; HA/Gmail connector attach/removal/revoke. | P → Connections forms, connected What it can do/Disconnect; Skills Install/Remove/Turn it on plus Choose folder/zip; view.js:523–635; connections.js:47–145. | Partial app connectors/skills lifecycle only. Generic extension manifest install/review/enable/disable/remove is API-only (O38); MCP/plugin execution not shipped. A connector setup form does not cover arbitrary extension host management. |
| C32 / L51 — Extension manifest + lifecycle (install/enable/remove cleanly) | Partial M1 + M7 updates | Validated full manifest/on_remove cleanup; change-pipeline update/canary/rollback; no runtime enforcement. | B Changes existing extension update Ship it/evidence/Roll back; Skills install/remove; Connections Disconnect only for their own kinds. | Partial app existing extension-change review/update rollback; generic lifecycle/permission-diff/import remains API-only (O38), update proposal API-only (O16). Preserve declarative tests/probe and no execution/runtime enforcement. |
| C33 / L52 — Agent adapters: Claude Code, Codex, ChatGPT/dots, Gemini, Copilot | Partial M5a + M10c workIn | Claude Code/Codex/OpenAI-compatible/custom-cli task workers/temp scopes/privacy/receipts/verify copyback; coding agent workIn; stand-ins/real Ollama; missing ChatGPT/Gemini/Copilot/real owner runs. | P → Models Providers All providers Turn on/Settings/Turn off, coding provider recommendation; T approval/test/evidence for existing tasks. surfaces.js:959–1068; openTask:172–225. | Partial app adapter config/status and existing task review; start standalone agent task/coding run lacks discoverable feature prompt/control (O01,O39). Keep named unbuilt adapters and live owner-validation gaps; receipts detail API-only. |
| C34 / L53 — Automation adapters: n8n / Zapier / Make (webhooks) | Partial n8n M5a | HMAC outbound n8n webhook, signed token callback/confirmation/trigger records; stand-in; Zapier/Make absent. | P → Models Providers All providers n8n Settings/on/off; provider setup can offer callback-token display (surfaces.js:1048–1115). Generic trigger registry shows existing callbacks/rules only. | Partial app n8n config/token viewing candidate; start automation adapter task/workflow and inspect signed callback/firing history are tool/API-only (O04,O40). No Zapier/Make; real workflow unverified. |
| C35 / L54 — Smart-home bridges (Home Assistant, Apple Home via bridges, Scrypted) | Have HA M5 + designed M11 Home | HA address/token/states/service tier2/tier3/readback/live events/reconnect/remove; Apple Home/Scrypted/cameras not built. | P → Connections HA setup .conn-form[data-connector] fields, What it can do, Connect/Disconnect and live status; connections.js:47–105. No HA state/device/action surface or home-service chat tool in tools.js. | Partial app connect/disconnect/status only. States list/service calls/live entity-rule creation API-only (O41). Smart Home page/Apple Home/Scrypted/cameras not shipped; HA real-device behavior stand-in-only evidence. |
| C36 / L55 — Gmail connector | Have M5, one account | Gmail reads/drafts/organize no send/delete UNPROVEN; vault migration/OAuth or IMAP; events; Connections. | P → Connections Gmail link/setup/Disconnect/What it can do; Skills Gmail setup OAuth-client/app-password forms; Skills installed Try prompt for mail skills; tools.js gmail read/draft/organize; view.js:538–605. | Partial app connection and concrete skill Try prompts if available, chat execution only where prompt/control discovered. No generic Gmail mailbox/draft/label dashboard; missing initial mail skill/data prerequisites must be explicit (O42). Preserve one account, no send/delete and UNPROVEN. |
| C37 / L56 — Browser/computer use with human takeover | Have M5c browser + M10b persistent profile | CDP step-plan worker/hosts guards/screens/evidence; live takeover/handback/roles/pause/resume/stop; no desktop control; restart restarts task. | T → existing open browser task → .takeover, live .takeover-frame, take-over/hand-back/pause-browser/resume-browser/stop-browser/type controls; surfaces.js:201–208; components.js:656–720; takeover.js:100–156. | Partial app existing task live control/evidence candidate. New general browser task/step plan is API-only with no browser_start chat tool or prompt/control (O43); desktop/screen control not shipped. |
| C38 / L57 — Nova Computer: sandboxed workspaces per project (Execution Plane) | Have M10a, explicitly API/no UI | Docker interface/create/exec/checkpoint/reset/destroy; sandbox/limits/proxy/tiers/read evidence/hash/output screening/undo; actual Docker tests; noted gaps. | No computer PWA route, card, setup control or chat tool found. API routes computer/routes.ts:1–50 create/workspace/exec/checkpoints/reset/destroy/runs/undo; Tasks can only review already created tasks. | API-only/not app-shipped for every workspace action (O44). Preserve historical real-Docker verification and limits; coding runs do not use M10a, so Coding through chat cannot stand in for this row. |
| C39 / L58 — Nova Browser: Nova's own browser, co-pilot, vault logins, site templates, checkout stop (Execution Plane) | Have M10b | Persistent profile/privacy/cookies cleanup; DOM/a11y/vision placeholder driving; live control; saved vault login; ingest/local co-pilot checks/CAPTCHA/paywall/dialog; learned flow templates; checkout structural network stop; adversarial stand-ins/limits. | P → Connections Site sign-ins Save a sign-in .site-login and forget-site; T existing browser task takeover controls/evidence; generic steps and learned flows only browser API/worker. sites.js:28–116; components.js:656–720. | Partial app sign-in storage/forget plus existing browser task live control. Browser task/checkout/flow learn/replay starts and learned-flow list API-only (O43,O45); no vision model; co-pilot only stand-in. Keep screenshot/live-view/GET/storage/real-site limitations. Saved sign-in UI does not demonstrate full Browser shipping. |
| C40 / L59 — Coding through chat (Execution Plane) | Have M10c | Chat code_change/code_status; write/check/merge chain; Nova worktree/plain copy/path protections; test/preview approvals; exact commit CAS merge/no push; Tasks coding sheets; limits/PR hardening. | Chat composer is generic, no coding example/action found in Home/Chat/Tasks empty states. T existing coding check/merge sheet .coding-sheet with full diff/test/preview, approve/decline merge; components.js:550–593 and surfaces.js:178–180,274. src/tools.js:270–299 binds tools. | Partial: tool-accessible coding start/status, not discoverably app-shipped start. Existing coding review/approve/decline surfaces candidate (O39). Wider editable file allowance API-only (O46). Paired-phone preview not built, agent-code-as-person risk remains explicit; no inference that M10a sandbox is used. |
| C41 / L60 — Infrastructure through chat (Execution Plane) | Have M10d | Project registration/month budget/prices/provider secret names API; OpenTofu plan/apply chain/saved-plan hash/state checkpoint/readback; whole-project pricing/alerts; chat plan/status; stand-in only; no projects Settings. | T existing infra apply .infra-sheet, full OpenTofu plan/resources/month budget/checkpoint, confirm/approve/Don’t apply; components.js:603–625. src/tools.js:305–331 tools exist but no visible infrastructure prompt/control. | API-only project/budget/price/secret setup and tool-only plan/status; partial existing-task approval UI only (O47–O49). No end-to-end discoverable Home-start workflow; no real provider. Preserve costs-as-sheet-not-bill and code-as-person behavior. |
| C42 / L61 — Networking changes with a dead-man's switch (Execution Plane) | Have M10d | Target adapter/API registration/token; snapshot sealed diff/apply CAS/approval/checkpoint/readback; trusted off-hub contact window/kinds; deadman revert/retry/conflict settle; chat change/status; no vendor adapter/Settings. | T existing .network-sheet diff/contact/deadline confirmation/Don’t apply, or keep change on revert; H problem status; components.js:630–651. src/tools.js:334–360 tool exists but no visible network prompt. | API-only target/token/contact policy/settle/manual revert; tool-only initiate/status; partial existing-task approval UI (O50–O53). No end-to-end discoverable workflow; vendor adapters and real network validation not shipped. |
| C43 / L62 — Account management through chat (Execution Plane) | Have M10d | Connector/OAuth Settings; browser account new_password/create_account/code; 10-minute tier3; vault secrets/no chat plan credentials; account_change tool/API; pending-password settlement API only. | P Connections + Site sign-ins forms; T existing account task generic approval/live takeover and person code input. src/tools.js:363–376 account_change exists; browser/routes.ts:40–44. No password/create/MFA prompt/button found. | Partial connector/sign-in/existing account task control only. Account initiation tool/API-only without discoverable prompt (O54), pending-password recovery API-only (O55). Keep stand-in/expiry/no secret chat protections. |
| C44 / L63 — Relay integration | Partial M8b + M10c Relay coding | Loopback Relay contract adapter/remote-egress gate/fresh state repo/worker polling/cancel/busy/walk diff evidence; Relay coding workIn, Nova merge; live real Relay/cleanup gaps/naming hazard. | P → Providers All providers Relay settings/on/off; T .evidence Relay run id/branch plus file_diff/test result; surfaces.js:959–1068; components.js:146,172. | Partial app configuration/existing-result evidence; Relay work initiation shares undiscoverable standalone/coding start (O39); real Relay gate/worktree cleanup not shipped. Do not infer adapter evidence from historical standalone Relay or transport relay. |
| C45 / L68 — PWA client (responsive, posture-aware) | Have M3 + M9 gates | Manifest/SW/cache exclusions; phone/tablet/desktop/postures/nine destinations; vitals/skeletons/progress/motion/contrast/hit targets/fold state/expanded pane/hinge/rem; real device gaps. | N covers nine primary destinations; C and Y are additional routed secondary destinations; index.html, nav.js:1–62, shell.js:99–160, layout.js/layout.css and app.js:257–277. | App shell/layout candidate pending Home-start phone+rail crawl. Say nine primary destinations plus Capture and Topology secondary views; parity not established by reachable() array or tests cited in history. Prior browser metrics/evidence remain dated; real phone/foldable unverified. |
| C46 / L69 — Design-system packages + hot swap | Have M3 + M7/M9/orb rules | Validated seven orb states/shape-motion contrast; token transitions/gradient/rem; six built-ins/apply per person/device/live swap/rollback; change pipeline/foundry variants. | P → Appearance pick-ds cards, scope device/all, mode radios, save-ds/cancel-ds/undo-ds/fix-contrast/undo-fix; drawAppearance surfaces.js:486–638; theme.js. B Changes existing design changes ship/rollback. | Partial app built-in selection/mode/scope/live contrast/undo candidate. Custom package import/author/validation is API/foundry-only (O18,O56); tests and orb contract are backend/CI evidence, not a claim every visual state is crawl-reached. Preserve code and motion limits. |
| C47 / L70 — Themes with identical features per layout | Have M3, every layout same nine destinations tested | Theme tokens only; identical features across layouts; historical Stellar Map PR. | Shared nav.js PLACES + destinations and shell.js renderNav; nine primary destinations N plus secondary C/Y doors in settings. | Pending rendered-crawl parity, not proved shipped by shared data. Correct wording nine primary destinations plus secondary views. Existing provider/task/role prerequisite differences must not be mislabeled layout differences; unavailable surfaces remain explicitly unavailable. |
| C48 / L71 — Observability/health UI (errors surfaced in UI) | Have M3/M7b + M10e service playbooks | Problems/toasts/Health/orb states; supervisor safe mode/restart/code release canary/rollback; playbooks/repair/evidence; backup/drill status; other-service problems; no OS unit. | H Problems resolve-problem/repair-problem details, Checks, #h-keep data-resilience, task evidence, conditional backup-now/drill-now; surfaces.js:330–407. Y machines/services; orb chrome. | Partial app status/problem/repair/backup/drill controls candidate. New tagged code release deploy/rollback and backup setup/recovery settings have no rendered controls (O57,O58–O60). Do not equate Changes extension rollout with console code releases; supervisor startup/OS units CLI/not built. |
| C49 / L72 — Setup/onboarding (conversational, fresh-user test) | Have M3 + M10f | Full-screen scripted onboarding OS/hub/roles/backend; explicit discovery; consent import; first task chosen from regression suite; choices/first-view/empty states; fresh-user timings; multicast/install/front-door gaps. | Fresh setup overlay #setup-form #setup-input setup-pick/setup-many/setup-first/setup-continue; setup.js:59–64,78–94,124–132,149–188. Normal Home after setup has no replay/setup door. | Onboarding-only app surface, not reachable from already-onboarded Home via ordinary nav. Must crawl fresh-user state separately from Home-start normal app; discover/import again no rendered independent control (O61). Preserve scripted/non-model nature and stand-in/human-time/installer limits. |
| C50 / L73 — Storage (ADR-4: SQLite + plain files) | Have M1 storage + M7b backup | SQLite/checksummed migrations/pre-upgrade backup/restore; plain human files; nightly target/retention/encrypted target/recovery manifest/drill; forgetting backups UNPROVEN; no remote target. | B → Checkpoints cp-take/cp-restore/cp-delete with confirmation; H #h-keep backup status/backup-now/drill-now if configured. checkpoints.js:32–187; surfaces.js:370–407. | Partial app checkpoint operations + conditional backup/drill visibility. Backup folder/retention/encrypted-target/recovery-key/encrypted drill selection API-only (O58–O60). Storage/migration/hash/encryption mechanisms implementation evidence, UNPROVEN unchanged; no remote target. |
| C51 / L74 — Secrets (vault, referenced by name) | Have M5 + designed broker/vault replacement | AES-GCM secrets/keychain/file fallback UNPROVEN; secret references/redaction/git exclusion/standby-sealed sync; approved exec can read key; broker not built. | P Connections vault notice/token fields; P Models Providers Settings secret/password fields, Jev key; Site sign-ins password field; Capture API key. H Vault status. No general names/reference/reset management UI. | Partial app purpose-specific secret entry/status; generic vault names CRUD/reset API-only (O62). Broker replacement not shipped; preserve UNPROVEN, real-Windows gap, key-file/approved-exec caveat; do not claim app enforces OS access secrecy. |


## Additional orphan/action register

**70 narrow orphan or scope-boundary findings** are recorded below, including already-honest not-built limits and small controls hidden by a broad row label. These are not 70 new feature requests and are not all implementation defects: the valid remedy is often an explicit API-only/developer-only/not-shipped label. Only O42 depends on actual skill catalog/fixture content; do not invent or remove a real skill affordance. No absent control is established merely by an API search: each was compared against the relevant actual renderer described above.

| ID | Original line(s) | Narrow capability/action | Evidence / exact scope correction |
|---|---|---|---|
| O01 | 13,52 | Delegate/helper/standalone agent task initiation | Agent-only delegate in src/tools.js:227; generic Chat and Activity history lack helper-start example. Existing helper records do not prove start discoverability. |
| O02 | 14 | Generic structured ledger brief/task creation | POST /tasks in src/core/index.ts:1115. Tasks only renders groups/empty generic Chat link and task sheets. |
| O03 | 17 | Generic reactive/event/heartbeat rule creation and token webhook setup | POST /triggers/rules and one-time hook token, core/index.ts:1171–1177; no rule create form in renderRules. |
| O04 | 17,53 | Firing/triage/dedup decision history and rule-change history | GET /triggers, /triggers/{id}, /triggers/rules/{id}; no corresponding visible record row/drilldown; Activity is conversation logs, not generic trigger records. |
| O05 | 17 | Edit name/schedule/action/dedup/cooldown generic rule | PUT /triggers/rules/{id}, core/index.ts:1179. Generic rule row only Pause/Resume/Delete. |
| O06 | 17 | Fire a generic rule now and quiet-hours/batching policy configuration | POST /triggers/rules/{id}/fire; no button; schedules Run now is a separate path. Quiet-hour/batching controls not found. Treat implementation-only configuration unless separately proven. |
| O07 | 12,19,23,44,52 | Per-call context receipts and remote egress log/filter | GET /receipts (?egress/task/session) at core/index.ts:1229; Health Context receipts count only, no receipt row viewer or filtering. |
| O08 | 18 | Full memory supersession/correction history and core confidence metadata | Core memory APIs have richer record/history than .memory-source/current entries; no history/confidence disclosure found. Existing edit does not demonstrate previous versions. |
| O09 | 18 | Standalone active-memory JSON/Markdown export | POST /memory/export at core/index.ts:1224 absent Memory control. Reset export has real reachability but only via reset-start; annotate that caveat. |
| O10 | 22,25,31 | General decision/template registry/question schema/policy authoring and template-use stats | Templates/Decisions classes in core/decide.ts, DecisionService registry/log. Models has seat configuration and scorecards only; no general template registry/editor. No standalone template API route is assumed here. |
| O11 | 23,25 | Full ingest-screen/decision-record history browser | ingest_screen and decision_record backend logging; Health aggregate/seat lines and per-capture verdict are narrower than a general screen/decision log. |
| O12 | 26,27 | Run evaluation and inspect every case/run/provider/model card history | scripts/evals.sh and scorecard storage/routes; Models summaries do not provide an eval runner or case/run explorer. |
| O13 | 28 | Claims register UI | tests/evals/claims.ts is CI/developer-only; no app register view. |
| O14 | 29 | Autonomous-run task/day steps/tokens/dollars caps, loop-resume approval settings | core/caps exports/hooks are inert in composition. Models cloud budget is a different mechanism; no caps form/Health spend/replicated usage. |
| O15 | 30 | One-click diagnostic download/integrity scrub | diagnosticsRoutes exported but not composed; no Health link. Scrub itself not built per inventory. |
| O16 | 31,33,51 | Propose a template/extension/config/rules/design change and configure its declarative tests/probe | POST /changes (changes/pipeline.ts:367); Changes list can review/ship existing records, not author one. |
| O17 | 32 | Full four-tier per-capability policy editor | Only legacy tool yes/ask switches at #perms and task approval sheets; full policy explicitly not built. |
| O18 | 33,69 | Foundry need/kind/model authoring invocation | POST /foundry core/index.ts:1516–1518. No foundry UI or chat tool in src/tools.js. |
| O19 | 34 | Service definition create/register/version import/manifest validation | Local CLI/definition files and device deploy API; Services settings only backend explanation/map. No definition editor/import. |
| O20 | 34 | Service plan/exact argv/never-approved-command review | service plan CLI; no plan form/exact argv viewer in Services/map. Map promotion has its own limited version review. |
| O21 | 34 | Local service alongside/deploy, recovery and soak configuration | Supervisor service plan/deploy/recover command paths; topology only existing eligible promotion/rollback, not initial install/deploy/recover. |
| O22 | 34 | Placement simulator and per-device eligibility reasons for an arbitrary proposed definition | POST /services/placement core/index.ts:1238; map shows existing placement, not request form. |
| O23 | 34,41 | Initial native workload deploy/sign/install assignment | POST /services/devices/deploy; map shows reports/promote/rollback, no initial native deployment form. No secret delivery or container deployment supported. |
| O24 | 39 | Mesh listener/public address/TLS-proxy/network enrollment prerequisites setup | Devices says start with NOVA_MESH_URL; no configuration control. Normal blank local home has no Add a device button until listening. |
| O25 | 40 | Create/enroll live standby (promotion prerequisite step 0) | boot join --kind standby CLI; Add device sheet computer command does not by itself make a live Nova-home standby. Inventory explicitly says step not automated. |
| O26 | 40 | Enable automatic failover policy | Backend opt-in/runtime configuration; no UI toggle found. Manual banner promotion is separate. |
| O27 | 40 | Stable mesh-name control driver/token setup and real DNS/tailnet support | NOVA_MESH_NAME_CONTROL/TOKEN env and loopback driver only; no UI; real driver not owner-approved/built here. |
| O28 | 40 | Promotion rehearsal/drill action | Script/test only; inventory explicitly no Settings rehearsal. Restore drill button does not rehearse hub promotion. |
| O29 | 40 | Promotion verification-window person setting | Not built per inventory; no UI. Do not confuse network deadman contact_window_s. |
| O30 | 41 | Agent runtime bundle publish/update/rollback/offline queue inspection | Signed boot/runtime IPC/heartbeat mechanisms; Devices status and Health repair do not provide management controls. |
| O31 | 42 | Request capture raw original with a reason | Raw retrieval backend/ledger mechanism, no request control on Capture event row. Raw archive explicitly not built. |
| O32 | 42 | Inspect signed per-spoke delete acknowledgements/tombstones/queue backlog | Event Forget is concrete but per-device acknowledgement and full queue state UI not found; do not promise deleted everywhere from a local success toast alone. |
| O33 | 42 | Configure spoke carrier/source sequencing/raw data policy | Device/backend mechanism, not an app source carrier configuration flow. Keep lag view separate; lag does exist on map. |
| O34 | 43 | Arbitrary model-role/device/address/manual hub-small-job assignment | UI Use these accepts recommendation set; no individual role/model/device/address form found. Profile/API mechanism remains broader. |
| O35 | 43 | Wake-on-LAN MAC/broadcast/wake-model setup | Models displays wake capability/reason; no WOL settings controls found. Successful automatic wake remains backend/LAN verification claim. |
| O36 | 44 | Detailed fallback history/provider usage/remote spend ledger and alternate chain editor | Models displays mode/budget/summary; raw receipts and calls backend-only; one-cloud fallback is explicitly a limit. |
| O37 | 45 | Voice conversational channel/response speech | #mic uses browser SpeechRecognition for dictation; no Nova voice session. Existing dictation must not flip Voice chat to Have. |
| O38 | 50,51 | Generic extension manifest installation/permission review/enable/disable/remove | core/index.ts:1131–1135 APIs; Skills/Connectors are kind-specific surfaces, not generic extension manager. |
| O39 | 52,59,63 | Coding run initiation/status feature discovery | code_change/code_status tools exist, but Home/Tasks/Chat empty states lack coding-specific prompt/action. Existing check/merge sheets only conditional task reviews. |
| O40 | 53 | Start automation-adapter task / create external n8n workflow | Provider setup plus token receipt is genuine but no automation-run start control found; real workflow stand-in-only; Zapier/Make not built. |
| O41 | 54 | HA state/entity list, service action initiation, entity event-rule setup | Connector routes /states,/services and generic trigger API; Connections can connect/disconnect and explain can-do only. |
| O42 | 55 | Gmail operation discovery independent of an installed skill Try prompt | Concrete Skills Try prompts count only when installed visible skills provide them; generic Chat alone does not demonstrate read/draft/organize workflows. No mailbox/label/draft surface inferred. |
| O43 | 56,58 | Start ordinary browser task/plan/checkout | Generic task API/browser worker; no browser task start form/tool in src/tools.js. T takeover requires existing open browser task; account_change tool is narrower. |
| O44 | 57 | All Nova Computer workspace actions | computer/routes.ts: create/list/detail/exec/checkpoint/reset/destroy/run-output/undo all API-only. No Computer route/control/chat tool. Docker historical verification remains valid as history. |
| O45 | 58 | Learn/list/version/replay site templates | GET /browser/flows and backend plan learn/flow; Site sign-ins only manages credentials/storage; no flow library controls. |
| O46 | 59 | Widen coding editable file/test allow-list | POST /coding editable API; src/tools.js:278 expressly refuses editable from chat; no owner-facing control. |
| O47 | 60 | Infrastructure project registration / folder selection | POST /infra/projects; no projects Settings form and tool forbids registering a project. |
| O48 | 60 | Project monthly budget / price-sheet update / provider secret entry | PUT project/secrets APIs infra/routes.ts:16–17; generic provider secret form cannot stand in for project-specific secret names/prices. |
| O49 | 60 | Infra plan/status feature initiation/discovery | infra_plan/infra_status tool-only; no visible infra example/action. Existing infra-sheet is a concrete conditional review path only. |
| O50 | 61 | Network target registration / adapter/address/bearer token setup | POST /network/targets, PUT token; network/routes.ts:10–16. No Settings form. |
| O51 | 61 | Deadman contact-window/device-kind policy configuration | Profile mesh.contact_window_s/contact_kinds; sheet states them, no settings editor found. |
| O52 | 61 | Network-change initiation/status feature discovery | network_change/network_status tool-only; no visible example/action. Existing network approval sheets are conditional review, not creation. |
| O53 | 61 | Settle failed/conflicted revert or request manual revert of kept change | /network/changes/{id}/settle,/revert APIs; Health Mark as dealt with only resolves a problem, not network target settlement. Existing revert Cancel/Keep change is narrower. |
| O54 | 62 | Password/account creation/MFA change initiation discovery | account_change tool/API only; no account-change-specific prompt/button. Stored login creation is separate from site account creation. |
| O55 | 62 | Pending password accept/drop recovery | POST /browser/logins/{host}/pending, browser/routes.ts:40; absent Site sign-ins and takeover controls. Security-sensitive incomplete credential state stays explicit. |
| O56 | 69 | Custom design-system manifest install/validation/foundry creation | POST /design-systems and /validate; Appearance only existing package pick/mode/scope/contrast/undo, Changes only existing proposals. |
| O57 | 71 | Deploy/rollback tagged Nova console code release | Supervisor CLI/resilience deployment routes; Health status/canary and extension Changes Ship it do not initiate code release deployment. |
| O58 | 71,73 | Set nightly backup target/retention/encrypted destination | PUT /backups/settings; Health displays API instruction when unset. Checkpoint named backup is not nightly-folder configuration. |
| O59 | 73 | Reveal/export/recover encrypted-copy recovery key | POST /backups/recovery-key; no control. Reset encrypted-export flow is separate and does not demonstrate nightly-copy recovery-key management. |
| O60 | 71,73 | Select encrypted source for restore drill / inspect full backup manifests/owed folder deletions | API supports drill source encrypted, GET /backups details; Health button sends no source and displays narrow status. Backup/forget claims remain UNPROVEN as noted. |
| O61 | 72 | Reopen discovery/import/onboarding after normal Home | Setup is gated fresh-user overlay, not normal Home route. No standalone discovery/import door; resetting is not a normal repeat-import workflow. |
| O62 | 74 | Generic vault names/secret CRUD/reset/unopenable-vault recovery | GET /vault, PUT/DELETE /vault/{name}, POST /vault/reset; purpose-specific fields/Health status don't expose generic vault management. |
| O63 | 12,52,53,63 | Explicit provider Check now | POST /providers/{id}/check exists, but provider setup renders Save/Cancel only; no check button. Saving may update health but is not this separate action. |
| O64 | 12,32,52 | Provider task-test approval policy editing | PUT /providers/policy; Providers only prints task_tests current state. Legacy #perms command switch is a different policy. |
| O65 | 53 | Regenerate/revoke n8n callback token | POST /providers/{id}/callback-token; provider save can display initial token, but no regeneration action found. |
| O66 | 54 | Change HA domains that demand tier3 | HA connector /settings GET/PUT; Connections can-do disclosure not an editor; do not imply fixed locks/alarms list configurable in product. |
| O67 | 17 | Full proactive/held-message inbox/history beyond Home banners | GET /messages with held filter. Home renders only up to two unread/approval banners; no full inbox/history route found. |
| O68 | 18 | Explicit core memory Confirm action and typed provenance/kind manual entry | Core /memory/{id}/confirm and rich POST /memory API; Memory Keep candidate is a distinct flow, existing manual Edit is not full confidence/provenance input UI. |
| O69 | 34 | Service chart generation / image-only/Docker/https/secrets/multi-copy/K3s/service change history | Inventory explicitly not built or mapping-only. Never count visible backend description or map cluster stand-in as these shipping. |
| O70 | 42 | Raw archive/pruning/cold tiers/encryption-before-upload/spoke-local-delete propagation | Inventory explicitly not built. Existing derived text sync, retention sweep and Forget are different capabilities. |


## Rendered evidence still required and realistic blank-home limits

All checks below are **conditional / not proved by this static audit**, for phone and rail separately. Read-only seeded fixtures are required for record-dependent states. A crawl must discover an anchor/button from the currently rendered view; it must not directly navigate to a hash/path, execute a private navigation function, or inspect a hidden node and call that reachability.

| Surface family | Visible selector/heading that the crawl must assert after clicking from Home | Blank-home / prerequisite behavior | Fixture-dependent checks that must remain conditional until exercised |
|---|---|---|---|
| Nine primary destinations | #more-btn and visible #more a[data-dest]; current destination heading; Chat #composer; Memory .memory-empty or .memory-section; Tasks .task-group or .empty-state | Main nav shell should exist after completed setup. Backend failures can replace content with retry state. | Run same click graph for phone and rail; primary destination equality is necessary but not sufficient for section parity. |
| Settings all nine categories | a.settings-cat[data-cat] clicked; visible .settings-pane[data-cat] and its actual h2; never merely count hidden panes | Phone initially shows category list; expanded rail defaults You; categories only reveal chosen pane | Check #you, #appearance-design/#appearance-mode/#contrast-check, #privacy/#perms/#capture, #connections/#browser-sites, #providers/#models/#decision-model, #devices/#install-row, #services/#services-backend, #checkpoints/#changes, #danger-zone. |
| Task evidence/approval/timeline | [data-action=open-task][data-task] → visible .evidence/.approval-sheet/.coding-sheet/.infra-sheet/.network-sheet/.takeover and What happened details | No existing tasks means no task rows/owner-specific sheets. Generic Ask Nova link does not prove task creation. | Each owner/state separately; evidence checks, tier2/tier3 confirmation, running/waiting/verified/failure, browser live stream, cancellation/retry. Open/review only; no approve/merge/apply/cancel side effects in read-only audit. |
| Memory/candidate/provenance | .memory-source; [data-action=edit-memory/forget-memory]; #waiting candidate Keep/Drop | Empty memory legitimately has no records/actions, but explicit remember prompt is visible | Seed active memory, superseded/corrected record, tainted/import/device candidates; full history/confirmation metadata remains unproved if no control exists. |
| Rules/schedules/activity | .trigger-row controls; Schedules heading/offered setup forms; .act-entry links | No rules means no Pause/Delete; no helper means no helper status/report controls; schedules offers depend source catalog | Generic rule create/history still API-only; existing helper/task details do not prove initiation. |
| Models/provider controls | #providers details summary All providers; provider-setup/on/off; #models role/device/installed disclosures, forms[data-form=disk/budget/pull], #decision-model | No Ollama can yield unavailable advice; Use these/pull/remove depend recommendations/install state; provider controls may be disabled honestly | Seed recommendation + installed + current/stale/no scorecard and configured decision settings; verify each actual score summary renders without claiming live provider eval or trusted ingest. |
| Connections/Site sign-ins | #connections .conn-offer/.conn-form plus Other connections; #browser-sites details Save a sign-in → .site-login | No connections yields setup offers, no Disconnect; unavailable by privacy policy must remain blocked state | Seed connected/broken HA/Gmail, site credential/storage; inspect no secrets; do not Connect/Save/Forget. Gmail skill Try prompt must actually exist to grant specific chat discovery. |
| Pairing/roles/promotion | #devices Add device, Review, Roles, Revoke, Promote to hub; conditional #banner promote/cold buttons | Local-only listener unset: Add device absent with start-env instruction; normal phone cannot approve unless allowed; no standby means no eligible promotion | Fixtures must distinguish approver/non-approver, candidate/standby/demoted, pending request/digits and stale registry. Generating pairing code mutates runtime; do not do it in this static audit. |
| Capture settings/view | #capture forms, source controls; click Open Capture → Capture heading, #cap-recent/#cap-held/#cap-review etc. | Capture indicator normally hidden while off; settings door should still reach Capture. No source/events means no event Remember/Forget/verdict details | Seed source + retained/held/redacted/excluded events + proposal/unclassified/review. Excluded-at-intake event absence is not proof of a deletion guarantee; inspect appropriate state evidence. |
| Services/topology | #services #services-backend; click link → Topology heading/System topology; data-topology-machine/service and version/action buttons | Local supervised or unsupervised observations may be limited; no deployment means no eligible promote/rollback; empty map must tell truth | Machine/service/version observation fixtures; source ages/partial/stale/error disable policy; Mermaid export only when current; no real cluster claim from fixture. |
| Changes/checkpoints | #changes Evidence for every stage, changes-ship/rollback; #checkpoints cp-take and conditional cp-restore/delete | Empty Changes is honest list/no proposal control; checkpoint creation available but not invoked; paired phone may see hub-only restore notice | Existing proposed/active/refused/canary/rolledback changes and named/automatic checkpoints; do not ship/restore/delete/take checkpoint in read-only review. |
| Health/resilience | #h-problems #h-checks #h-keep; Technical detail/playbook; conditional backup-now/drill-now | No configured target: no Backup now/Run drill, only PUT API instruction. No supervisor: CLI instruction only. No problems: no repairs. | Seed stopping/nonstopping problem, playbook, configured backups/drill/canary, mesh lag. Counts/lines are status only; no diagnostics/download/deploy/setup surface implied. |
| Setup/export | Fresh-user #setup-form and setup-pick/many/first/continue; normal X reset-start → export-step field and Export | Completed Home has no Setup/Discover/Import again. Export/reset operations hub-only; paired client sees restriction. | Separate fresh-user onboarding crawl; inspect reset export sheet but do not export/erase. Hub-only product restrictions must not be presented as layout failures. |

## Required textual repairs in addition to the new column

1. L3–5: define Have as historical implementation verification only, never rendered app shipping; keep M0/Era historical provenance dates and links.
2. L13–14: old helpers/schedules-off-ledger and no-UI gaps are dated M1 history. Current server.js:57,128–131 and Tasks renderer provide contrary current composition; keep history but remove ambiguity.
3. L25: qualify “no template has a passing eval” to ingest-screen v1/v2, since same row documents capture-sensitive and memory-gate eval passes; memory-gate still not live.
4. L26–27: route and Models score summaries are wired, including role assigned/recommended scores and decision template scores, plus recommended Chat provider status. Do not retain adjacent “not wired” statement as current. No eval runner/full card/run browser implied.
5. L34: earlier “nothing deployed yet (M10h)” is historical; later paragraph explicitly implements native device workloads. State chronology clearly. Preserve every current unsupported K3s/image/OS/egress/setsid limitation.
6. L40: M4 “must enroll stepped-down hub again” is historical; M10g planned handover explicitly makes the old hub live standby. Emergency/demoted cases are different, so avoid global claim in either direction.
7. L42: lag on map is present via topology presentation; current “not built … lag on Health or map” is stale. Restrict to Health if not present there; include actual map door. Held text language contradicts “not kept” in inventory while Capture copy says held on devices. Name stored/held/not indexed/not remembered precisely; do not imply held content vanished.
8. L45: browser dictation exists but voice chat is still not built. Clarify to avoid implying microphone means end-to-end voice conversation.
9. L68/L70: nine primary destinations are real source entries, but Capture and Topology are additional routed secondary views; “every feature reachable” requires doors/controls beyond the nine-entry array.
10. L71/L73: named Checkpoints, nightly backups, encrypted-copy recovery, console code releases and generic extension Changes are separate flows. Each gets its own exact current status, not blanket Backups/Health/Changes shipped.
11. L74: preserve unbuilt broker, UNPROVEN encryption-at-rest eval, file-key/approved-exec caveat, real Windows gap and standby sealing scope. A password field demonstrates entry, not the security guarantee itself.

## Compact machine-readable mapping

This JSON is a companion embedded in the sole report file. `rendered_phone` and `rendered_rail` are null deliberately. Integrate actual later crawl evidence per C ID; do not convert static selectors into passed runtime observations. Orphan IDs cross-reference the detailed register. Source-line identity is pinned to the captured inventory below even if tracked docs later change.

```json
{
  "version": 1,
  "base_head": "6d0a74a58a3a20df7f3718b2ade2413c1ba84e8a",
  "inventory_rows": 51,
  "orphan_scope_findings": 70,
  "mappings": [
    {
      "id": "C01",
      "original_line": 12,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O07",
        "O63",
        "O64"
      ]
    },
    {
      "id": "C02",
      "original_line": 13,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O01"
      ]
    },
    {
      "id": "C03",
      "original_line": 14,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O02"
      ]
    },
    {
      "id": "C04",
      "original_line": 15,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": []
    },
    {
      "id": "C05",
      "original_line": 16,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": []
    },
    {
      "id": "C06",
      "original_line": 17,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O03",
        "O04",
        "O05",
        "O06",
        "O67"
      ]
    },
    {
      "id": "C07",
      "original_line": 18,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O08",
        "O09",
        "O68"
      ]
    },
    {
      "id": "C08",
      "original_line": 19,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O07"
      ]
    },
    {
      "id": "C09",
      "original_line": 20,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": []
    },
    {
      "id": "C10",
      "original_line": 21,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": []
    },
    {
      "id": "C11",
      "original_line": 22,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O10"
      ]
    },
    {
      "id": "C12",
      "original_line": 23,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O07",
        "O11"
      ]
    },
    {
      "id": "C13",
      "original_line": 24,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": []
    },
    {
      "id": "C14",
      "original_line": 25,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O10",
        "O11"
      ]
    },
    {
      "id": "C15",
      "original_line": 26,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O12"
      ]
    },
    {
      "id": "C16",
      "original_line": 27,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O12"
      ]
    },
    {
      "id": "C17",
      "original_line": 28,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O13"
      ]
    },
    {
      "id": "C18",
      "original_line": 29,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O14"
      ]
    },
    {
      "id": "C19",
      "original_line": 30,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O15"
      ]
    },
    {
      "id": "C20",
      "original_line": 31,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O10",
        "O16"
      ]
    },
    {
      "id": "C21",
      "original_line": 32,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O17",
        "O64"
      ]
    },
    {
      "id": "C22",
      "original_line": 33,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O16",
        "O18"
      ]
    },
    {
      "id": "C23",
      "original_line": 34,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O19",
        "O20",
        "O21",
        "O22",
        "O23",
        "O69"
      ]
    },
    {
      "id": "C24",
      "original_line": 39,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O24"
      ]
    },
    {
      "id": "C25",
      "original_line": 40,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O25",
        "O26",
        "O27",
        "O28",
        "O29"
      ]
    },
    {
      "id": "C26",
      "original_line": 41,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O23",
        "O30"
      ]
    },
    {
      "id": "C27",
      "original_line": 42,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O31",
        "O32",
        "O33",
        "O70"
      ]
    },
    {
      "id": "C28",
      "original_line": 43,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O34",
        "O35"
      ]
    },
    {
      "id": "C29",
      "original_line": 44,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O07",
        "O36"
      ]
    },
    {
      "id": "C30",
      "original_line": 45,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O37"
      ]
    },
    {
      "id": "C31",
      "original_line": 50,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O38"
      ]
    },
    {
      "id": "C32",
      "original_line": 51,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O16",
        "O38"
      ]
    },
    {
      "id": "C33",
      "original_line": 52,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O01",
        "O07",
        "O39",
        "O63",
        "O64"
      ]
    },
    {
      "id": "C34",
      "original_line": 53,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O04",
        "O40",
        "O63",
        "O65"
      ]
    },
    {
      "id": "C35",
      "original_line": 54,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O41",
        "O66"
      ]
    },
    {
      "id": "C36",
      "original_line": 55,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O42"
      ]
    },
    {
      "id": "C37",
      "original_line": 56,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O43"
      ]
    },
    {
      "id": "C38",
      "original_line": 57,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O44"
      ]
    },
    {
      "id": "C39",
      "original_line": 58,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O43",
        "O45"
      ]
    },
    {
      "id": "C40",
      "original_line": 59,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O39",
        "O46"
      ]
    },
    {
      "id": "C41",
      "original_line": 60,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O47",
        "O48",
        "O49"
      ]
    },
    {
      "id": "C42",
      "original_line": 61,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O50",
        "O51",
        "O52",
        "O53"
      ]
    },
    {
      "id": "C43",
      "original_line": 62,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O54",
        "O55"
      ]
    },
    {
      "id": "C44",
      "original_line": 63,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O39",
        "O63"
      ]
    },
    {
      "id": "C45",
      "original_line": 68,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": []
    },
    {
      "id": "C46",
      "original_line": 69,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O18",
        "O56"
      ]
    },
    {
      "id": "C47",
      "original_line": 70,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": []
    },
    {
      "id": "C48",
      "original_line": 71,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O57",
        "O58",
        "O60"
      ]
    },
    {
      "id": "C49",
      "original_line": 72,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O61"
      ]
    },
    {
      "id": "C50",
      "original_line": 73,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O58",
        "O59",
        "O60"
      ]
    },
    {
      "id": "C51",
      "original_line": 74,
      "rendered_phone": null,
      "rendered_rail": null,
      "static_status": "conditional_not_proved",
      "orphan_ids": [
        "O62"
      ]
    }
  ]
}
```

## Original inventory, complete verbatim content with original line numbers

The following is an immutable audit snapshot of the read source, including all subclaims, historical Have labels, exact gaps, percentages, guarantees and UNPROVEN tags. It is not a second shipping claim.

```text
01 # CAPABILITY INVENTORY — target vs. existing
02
03 Status key: **Have** (exists and verified) · **Partial** (exists, needs work) · **New** (build) · **Later** (specified, not in early milestones).
04
05 **Verified at M0 (2026-10-29) against the code, not the docs.** Era 2 = `origin/main` HEAD `04512c07` (plain JS, Node built-ins only, 127 tests). Era 1 = last Era 1 commit `6e2cf142` (TypeScript monorepo + Rust `novad`, ~465k lines TS + 24k Rust, all four CI jobs green on GitHub at that commit; deleted from the tree by `7ea842b5` "clean slate"). Evidence paths for every row are in `docs/inventory/M0-DELTA.md`. Rows marked **▲ corrected** changed at M0; rows marked **● M1** changed when the M1 core landed (`src/core`, 2026-10-29); **◆ M2** when triggers, memory and triage landed; **■ M3** when design systems and the PWA landed. Rows marked **★ M4** changed when the device mesh landed (M4a: enrollment, the registry, sessions, the access policy). Rows marked **✦ M5** changed when agents and integrations landed (M5b: the vault and connectors). Rows marked **⬢ M6** changed when capture and local models landed (M6a: the Capture API, consent and Screenpipe ingest; M6b: the local model manager). Rows marked **⬣ M7** changed when governed self-modification landed (M7a: the change pipeline, the foundry and Settings › Changes). Rows marked **⬡ M8** changed when the Relay adapter landed (M8b: the `relay` provider, tested against a stand-in of Relay's contract v1). Rows marked **✧ M9** changed with Feel & Polish (Amendment 2026-10-30-C Part 2). Rows marked **⬟ M10** changed with the Execution Plane (Amendment 2026-10-30-C Part 4; M10a: Nova Computer; M10b: Nova Browser; M10c: coding through chat; M10d: infrastructure, networking and accounts through chat; M10e: the Service Manager and the supervisor driver; M10f: device roles, placement and onboarding; M10g: hub promotion, planned and emergency; M10h: native workloads on devices and the capture pilot).
06
07 "Reuse" names the component a milestone should start from. Reuse is per component: Era 1 code is ported in only with its tests and only where it fits the contracts here; its dependency footprint (React, Electron, Fastify, drizzle, QuickJS) does not come with it.
08
09 ## Core loop and platform
10 | Capability | Target | Existing (verified) | Reuse |
11 |---|---|---|---|
12 | Chat with a swappable agent (`agent_cmd`) | Core, generalized into a provider registry | **✦ M5 (M5a): Have (v1)** — `src/core/providers/*`: a provider registry of agent- and automation-adapter extensions; `agent_cmd` is the `custom-cli` provider and stays the default chat model, run by Era 2's runner exactly as before; the profile can name another chat model (the `openai-compatible` one, Ollama by default), and Era 2's chat, scheduled runs and helpers then go through it with its egress and receipts. Settings › Providers recommends one. Era 1's registry shape and its OpenAI-compatible adapter (fetch + SSE) ported; its other adapters (Anthropic API, mock, llama.cpp kind) and model catalogue not. Before M5: Partial — Era 2 `agent_cmd` swap point works (Claude CLI + fake agent tested; one command for all roles, config edit + restart). Era 1 had a full provider registry (Anthropic, OpenAI-compatible, Ollama, llama.cpp, mock) with conformance tests | Era 2 swap point now; Era 1 registry shape at M5 |
13 | Multi-agent delegation (brief-in/report-out) | Core task contracts | Partial — **● M1:** CONTRACTS §1 envelope v1 (`src/core/envelope.ts`, validated, plus optional `inputs`); one local worker. Era 2 helpers still run outside the ledger (moves to the ledger in M2). Before M1: **▲ corrected:** the Era 2 `handoffs/` mailbox is a builder-side GitHub Actions process, not runtime. Runtime delegation is Era 2 `helpers` (in-memory queue, lost on restart; report is a handoff event) and Era 1 `task.spawn` (result is a plain string). Neither has a structured brief/report or `evidence[]` | New envelope at M1 |
14 | Work Ledger (durable tasks) | Core | Partial — **● M1:** v1 in `src/core/ledger.ts`: durable SQLite tasks, enforced states, append-only events, approval and privacy gates, retries, restart recovery. Gaps: one task at a time; schedules and helpers not on it yet (M2); no UI yet (M3). Before M1: **▲ corrected:** Era 1 had durable runs with states and restart recovery (scoped to runs/goals, not a general ledger). Era 2 has none; only JSONL logs and a derived activity view | New at M1; Era 1 state model as reference |
15 | Verification / evidence layer | Core | Partial — **● M1:** `src/core/verify.ts` checks read-back evidence by re-reading the target; other evidence kinds fail as uncheckable until a checker exists. Before M1: **▲ corrected:** Era 1 verified one declared output per run (artifact exists, sha256, delivery receipt) as free-text evidence strings. Era 2 none | New at M1 |
16 | Decision journal + calibration | Core | New — confirmed absent in both eras. ◆ M2: template stats (uses) exist; the journal itself is not built yet | Later milestone |
17 | Trigger engine (reactive/proactive/event/heartbeat) | Core | **◆ M2: Have (v1)** — `src/core/triggers.ts`: all four classes, visible registry, records per firing, dedup, cooldown, batching, quiet hours, claim-once heartbeat, token webhooks; gate-tested. Before M2: Partial — Era 2: cron-only markdown schedules, enqueue-once dedup, no cooldown, no events. **▲ corrected:** Era 1 had webhook/connector/MCP event triggers with per-key dedupe and an hourly rate cap, plus proactive checks; no per-trigger cooldown | M2; Era 1 dedupe design as reference |
18 | Long-term memory w/ provenance | Core | **◆ M2: Have (v1)** — `src/core/memory.ts`: CONTRACTS §7 records, corrections keep history, real forgetting (including backups) **UNPROVEN** (no eval yet: `claim.forget-reaches-backups`), export to JSON + Markdown. Before M2: Partial — Era 2: markdown entries with id/source/time, correction via `replaces`, forget + undo; no export endpoint, no confidence. Era 1: SQLite `memory_item` with source, confidence, supersedes, status; export only via whole-account archive | M2 |
19 | Context receipts | Core | **◆ M2: Have (v1)** — `src/core/receipts.ts`; every chat model call records one; `?egress=remote` is the egress log. Before M2: New | — |
20 | Identity/persona layer (model-independent) | Core | **● M1: Have (v1)** — `src/core/identity.ts`: fixed charter + profile tuning rendered for every model; chat uses it. Name configurable. Before M1: Partial — Era 2 standing files (`SOUL.md`, `IDENTITY.md`, `USER.md`…) re-read every turn; name "Nova" also hard-coded in prompt and UI strings. Era 1 hard-coded default prompt + per-agent instructions | Era 2 standing files at M1 |
21 | Deliberation + critic pass | Core | New — Era 1 has an adjacent fail-closed action reviewer only | — |
22 | Decision Model Provider (Jev-class System 1) | Pluggable provider | **◆ M2: Partial** — interface + local rules provider; Jev is a stub (owner's decision: no account yet); Noul, Choice, Score | Jev when the owner decides |
23 | Ingest security gate (prompt-injection screen for outside content) | Capability | **Have (v1), Amendment C Part 3; on the Decision Service since the gate follow-up (PR #258):** `src/core/ingest/` (`checks.ts`, `screen.ts`, `outbound.ts`, `index.ts`), migration 0013. Every read of outside content is screened before a model acts on it: the agent's web fetches and searches, mail, `read_file` on anything not the person's own, command output, helpers' and scheduled runs' reports, uploaded skills, captured text, device notes and browser page reads. **The deterministic layer** (`checks.ts`): hidden text and instructions, protocol tags, invisible, direction and tag characters, encoded text, link mismatches, failing DMARC, Reply-To swaps; a blocking flag blocks without any model. **The Noul screen:** the template `ingest-screen` (five questions), asked of the Decision Service one fenced chunk at a time; **every chunk** is screened (3,000 characters, overlapping by 200, a pool of 2; no sampling), and an answer is used only when the service trusts it (a decision model that passed this template's eval on that exact model, or the sorting model until one has). The highest probability decides: below 0.2 with nothing flagged, pass (wrapped as data); 0.2–0.8, a quarantining flag, or no trusted answer, quarantine (instruction-like spans and hidden text removed, listed by kind); 0.8 or a blocking flag, block (one line, and a verified Work Ledger entry). The thresholds are constants in code. **Routing** follows the owner's decisions through the service, never looser than the run's or task's own mode, re-read before every cloud send: cloud mode screens with cloud Jev once it is set up; local modes use Tev1 and the sorting model, and Jev only with the screening opt-in (off by default; its receipt names the opt-in and the task); capture-derived text never goes to a cloud seat. **Taint** (`src/runner.js`): the sources a conversation read, carried into handoffs and helpers; while tainted, commands, mail, schedules, standing-file writes and anything needing an OK ask, naming the source. **The outbound guard** (`outbound.ts`): secrets always, and memory and standing-file text and encoded blobs in a tainted run. **Memory:** a tainted run's `<remember>`, `<note>` and `<forget>` wait for the person. **Records:** every screen in `ingest_screen` (never the content), naming the seat and model that answered; every decision in `decision_record`. **Tested:** the corpus and canary suites, and both again in every privacy mode with each seat state (unavailable, untrusted, a trusted stand-in: `tests/ingest/fallback-matrix.test.ts`, `tests/ingest/canary-matrix.test.js`), the egress tripwire, and the eval harness's injection suite on Part 1's 99 cases. **Gaps:** no decision model has passed `ingest-screen` v1's eval (both Tev1 sizes failed; Jev never called for real), so without a sorting model outside content is held back as unsure; screening a 2,000,000-character document with a trusted Tev1 is about 2,100 requests, past the 180 s limit a screen has, so such a document is held back; an untrusted seat is asked only for a sample (2 chunks per piece of content, 200 asks per seat per day); capture-derived text is screened on arrival by local seats only (the owner's rule; its per-source cloud opt-in, and screening at indexing and recall, are follow-ups). | Amendment C |
24 | Local decision provider for the Jev seat (Tev1 via Ollama) | Capability | **Have (v1, advisory), Amendment B Part 1:** `src/core/decision-service/` (moved from `src/core/jev/` in DS1). `Tev1Provider` implements the Jev interface (DecisionProvider) against Ollama's `/v1/systemone`. It is local only; it answers the ingest screen's five Noul questions in one request per piece (≤ 64 questions), screens every piece of long content (2,000-token and 64 KiB caps, 200-character overlap, worst score wins), uses `tev1:4b` (`tev1:0.8b` only where memory requires), and is unavailable in plain words below Ollama 0.40.4, when unreachable, or when not downloaded. Reliance follows the injection eval's recorded verdict per size and digest (`src/core/decision-service/tev1-verdicts.json`, recomputed in CI). The eval (99 cases, bounds fixed in `6d8a8e97`) ran on 2026-10-31: **both sizes failed** (100% false positives; ECE 0.106 and 0.286), so Tev1 is **advisory**: its scores are logged, and the deterministic layer plus quarantine decide. Tested against a loopback stand-in in CI. **Gaps:** the cloud Jev seat is tested only against a stand-in (no account). The gate wiring, Health and device-record lines, every-chunk screening and the 200-character overlap landed with the gate's move onto the Decision Service. | Amendment B |
25 | Decision Service (registry, seats, decision log) | Capability | **Have (v1, DS1)**: `src/core/decision-service/`. Versioned templates checked against authoring rules; policies as enumerated truth tables mapped onto the tiers; seats for cloud Jev (pinned versioned model, stand-in tested, no live calls), Tev1 (Part 1, moved) and the stub, plus the sorting model until each template's eval passes; routing by mode and per-feature opt-ins; a decision record with no content; a boundary test so no feature calls a provider ad hoc. **Gaps:** the ingest gate is its first consumer (with the decision_record table, receipts' opt-in, Health, the device record and Settings › Models › Decision model); the browser co-pilot and triage are still on the old stack until DS2–DS3; no template has a passing eval yet (ingest-screen v1 failed on Tev1; v2 in DS2); no local image seat. **DS2:** `ingest-screen` v2 (re-authored, six Nouls, truth-table rule, `templates/ingest-screen-v2.ts`) failed its pre-registered fresh eval on both Tev1 sizes. tev1:4b: 24% false positives against a 10% bound; detection 97.7%, ECE 0.037, steering 8/8. tev1:0.8b: 82.7% false positives, ECE 0.135. It is evidence only; v1 is still asked while the sorting model serves it. The service picks versions by verdict. **Gap:** the gate uses the service's outcome for v2 and later (NOTE 1) once a version passes. **Capture screening, job 1:** `capture-sensitive` v1 (`templates/capture-sensitive.ts`). The deterministic app exclusion and pattern redaction come first; four Nouls for the grey area. **Passed** its pre-registered eval on tev1:4b `7954dce2…` (detection 97.4%, false holds 2.5%, ECE 0.032; 39 grey cases, one author), so it is trusted on that build; tev1:0.8b failed (79.5%). Never routed to a cloud seat in local modes. **Consumers on** (Track 1, `docs/plans/capture-screening-consumers.md`): capture drops sensitive apps at intake and redacts pattern findings before storing; every stored event is checked before triage or promotion; outcomes applied (index, redact, hold, exclude); with no trusted model every event is held (option B) with the owner's notice; the check reads the window title and address too; failures back off without starving newer events; a per-home HMAC content-hash cache per source; decision records go with their event; the timeline labels each verdict with its provenance (migration 0022). Reviewed (2063c4d8; evidence `docs/evidence/capture-screening-review.md`). **Gaps:** no per-source cloud opt-in; titles and addresses are judged but the eval measured words alone; an independent case set would strengthen the pass; recall-path screening (job 2). **Memory gate (#277):** `memory-gate` v1, deterministic exact-duplicate merges, four Nouls, saving only on a confident yes. Its preregistered evaluation passed on the recorded `tev1:4b` digest (0/49 false saves, 25/26 recall, ECE 0.082); `tev1:0.8b` failed. **Not live:** runner/server wiring and candidate reasons remain Track 1 work. Small sample (false-save interval to 7.3%), three contradictions skipped and one author. | DS1 |
26 | Golden-task eval harness (regression gate, capability suite, injection suite) | Core | **Have (v1), Amendment B Part 4:** `src/core/evals/`, `tests/evals/`. 28 tasks from failures on record (23 regression, 5 capability), graded by code. The regression suite gates CI through `npm test`, with stand-ins playing the model; real models are scored only in opt-in local runs. The injection suite runs Part 1's 99-case set. Settings › Models shows each model's scorecard before a switch (`GET /api/v1/evals/scorecards`). Verified by `tests/acceptance/evals-regression.test.ts` and `tests/core/evals.test.ts`. | Amendment B |
27 | Model-swap scorecard per provider/model | Core | **Have (v1, data only):** `src/core/evals/scorecards.ts`, files under `workers/evals/` (current, stale or none), written by `sh scripts/evals.sh`. **Gap:** its route and the Settings › Models display aren't wired yet. | Amendment B |
28 | Claims register (capabilities claimed vs. what the suite demonstrates) | Core | **Have (v1, enforced for user-facing text; owner decision 2026-10-31, `docs/plans/honest-claims.md`):** `tests/evals/claims.ts`, 71 claims: 16 backed, 54 softened in the copy to what the evidence supports (each with its old strong words, its eval case `claim.<slug>` for Track 3 and a priority), 1 instruction to the model; 0 unbacked. CI fails on an unbacked claim in user-facing text, or on a softened claim's strong words anywhere a person reads. The false one (every shell command waits for approval) is fixed. Before: reporting only, 18 of 28 not backed. | Amendment B closing rule |
29 | Cost ceilings on autonomous work (per task and per day: steps, tokens, priced dollars), loop detector, resume as a new approval | Core | **Built, inert until wired (Amendment B Part 5, #256):** `src/core/caps/`, with hooks in `src/runner.js` and `src/chat-run.js`. Verified by `tests/core/caps.test.ts`, `tests/acceptance/caps.test.ts` and the eval task `safety.runaway-loop-stopped`. **Gaps:** the wiring, the Settings limits form, Health spend, provider-task usage, and replicated spend. | Amendment B |
30 | One-click diagnostics bundle, redacted by construction (no secret, no personal content, local only) | Core | **Built (Amendment B Part 6, #259):** `src/core/diagnostics/`. Verified by `tests/core/diagnostics.test.ts` and the eval task `safety.diagnostics-no-canary`. **Gaps:** the route and the Health download link aren't wired (Track 1 follow-up); the integrity scrub isn't built. | Amendment B |
31 | Decision templates (cached, validated, versioned) | Core mechanism | **⬣ M7:** a template can ship through the change pipeline; a rollback reinstates the previous version. **◆ M2: Have (v1)** — cache-miss authoring, schema check, dry runs, activation as a verified ledger task, `triage@1` built in. Calibration drift and retirement not yet | — |
32 | Approval tiers (NOVA-SPEC §6) | Core mechanism | Partial — **● M1:** tiers 0–3 on ledger tasks (2 waits for OK, 3 needs explicit confirmation); per-capability policy not yet. Before M1: **▲ added:** Era 2 has two tiers (`yes`/`ask`) per tool in a hand-editable file, plus a taint rule after mail is read. Era 1 had policy, persistent grants and approvals. Neither has the four-tier model | M1 (tiers on tasks), full policy later |
33 | Governed self-modification (ADR-9 pipeline) + the foundry | Core | **⬣ M7: Have (v1, M7a)** — `src/core/changes/*`: a change (extension, design system, setting, decision template, trigger-rule pack) is one versioned record (migration 0011, replicated to the standby) through fixed stages, each a ledger event with evidence: a sandbox Nova process on a `VACUUM INTO` snapshot made inert (nothing queued runs, the person's rules paused, providers and connectors off, no device addresses, no vault); the change's own tests, contract checks (manifest, permissions, egress, privacy) and Nova's checks on the copy; health gates (`/health` plus fixed smoke probes: setup, ledger, memory, an approval, a privacy refusal, and the change's own declarative probe); a versioned release committed to the home's history (files only; a change carrying a secret's value fails its privacy check); approval at tier (anything the foundry or a provider proposed, privacy and policy settings, and widened extension permissions are tier 3, confirmed every time, after the sandbox evidence); a canary in a limited scope per kind with probes (health, problems in the touched area, its error rate, its own probe) over a minimum window and at least three passing runs; promotion, or automatic rollback restoring exactly the previous version, the Ship task ending Failed with the probe's reason and a problem opened. Rolling back by hand is tier 2. The gates are frozen constants in core; a change that names one, shortens the canary, targets the pipeline's settings or records, or tries to skip a stage is refused and kept on the record. The foundry writes trigger-rule packs, decision templates, skill packs and design-system variants with their manifest, tests and probe through M5's providers (the local model by default, or the chat model), in a folder of its own, and proposes them through the pipeline (never core). Settings › Changes shows it all with one standout, “Ship it”. Tested in process, with real server processes (egress tripwire, hub and standby) and in Chromium. Gaps: extensions run no code, so an extension's tests and probe are declarative; code releases are M7b's. Before M7: New | M7 |
34 | Service orchestration: the Service Manager and its drivers (owner input 2026-10-31) | Core, optional K3s driver | **⬟ M10: Partial (M10e–M10i)** — `src/core/services/*` and `src/supervisor/services.ts`; plan `docs/plans/M10e.md`, evidence `docs/evidence/m10e-gate.md`. **The definition:** one JSON file per service and version in the ADR's format, validated in plain words (the ADR's four refusals: a floating service with state, an image-only service pinned to a macOS or Windows device, a placement no device's roles allow, a secret written as a value; and every malformed field). Its mapping to the future `nova-service` chart's values is written down beside the code; nothing renders it. **The driver interface** (`available`, `plan`, `apply`, `status`, `switch`, `rollback`) and a shared contract test every driver must pass (`tests/support/service-driver-contract.ts`). **The Service Manager:** the registry of definitions (one file per version, registered once), the first driver that can run one, and the stages at their tiers: alongside with no traffic (tier 1), promotion typed every time (`<service>@<version>`; tier 2, tier 3 for the console and anything with secrets or OS permissions), only a version that passed its contract tests and health offered, a rollback asked for (tier 2). **The supervisor driver:** the supervisor generalised from one child to many, by the same rules (backoff, held after three crashes in a minute, health polled, restart on failed health; `CrashWindow` and `ServerProcess` shared). The console is `nova-console`, started from its definition (its command and health check), its deploy path unchanged. Other services are plain programs: a slot per version installed once from a `file:` artifact pinned by SHA-256; alongside `full`, `shadow`, `copy` or `none`; a stable port on 127.0.0.1 forwarded to the live version; a canary that points back by itself; the previous version kept, stopped, for `soak_s`, and failed health or a crash loop in that time goes back in one step from the kept slot; the slot removed after the soak. Each service runs in its own process group with none of the supervisor's environment; the group is ended with it, and a killed supervisor's leftovers are ended by the next one (Linux, known by pid and start time). **What runs is the pinned program:** the artifact itself, or Nova's own Node with it as the script, checked by the validator, the plan and at every start (a regular file in the slot, the pinned SHA-256); the plan shows the exact argv and a command no approved version ran asks first, typed. One queue per service for changes, restarts and soak ends; a failed switch never touches the live version's stable ports and says what is true (held, with a problem, when the old version doesn't start again). Ports below 1024 and Nova's own are refused. Commands: `services`, `service plan|deploy|promote|rollback|recover`. **M10f: placement** (`services/placement.ts`): a pure resolver from a definition's placement (pinned; preferred plus failover past a window; floating, stateless) to devices, against their roles, hardware (`device_hardware`; Apple's unified memory counted at three quarters) and health, each device's reason in words; a thin client or a device with no workload role never receives one. Checked today by `POST /services/placement` (tier 0, advisory) and the device agent; the supervisor's command line keeps M10e's "this hub only" rule, and the Service Manager's `placement` option is wired to it with M10h. Roles bound the work already reaching a computer: model roles, downloads and inference need compute, capture needs capture source. Checked by the device agent (`trust.ts assignmentAllowed`, against roles kept in `device.json` from the approval and every heartbeat answer). Nothing is deployed to other devices yet (M10h). The validator places by workload roles only and names a need it can't check. **No Kubernetes:** `npm test` and the UI gate run under `scripts/tripwire.sh` (stand-in `kubectl`, `helm`, `flux`, `k3s` first on PATH; any call fails the run; `KUBECONFIG` unset). **⬟ M10h: native workloads on devices** (`src/core/services/workloads.ts`, `src/device/{workloads,rollout}.ts`; plan `docs/plans/M10h.md`, evidence `docs/evidence/m10h-gate.md`): a definition placed on a device other than the hub goes to the `device` driver, one per device, each with its own Service Manager and registry, at the same tiers; the hub signs a manifest for that device and platform (files pinned by SHA-256, the one command, ports, health, roles) and serves the program exactly as published (never re-signed); the device's boot agent has five verbs (install, start, stop, switch, probe), for hub-signed workloads only, refusing any other verb, any request carrying a command, an unpinned key, a hash, another device's or platform's manifest, a role it doesn't hold, and root; the runtime decides each step of the update pipeline (alongside, shadow or none; health three times; switch after the promotion; back to the kept version by itself on failed health, downloading nothing) and reports in its heartbeat. Placement: containers on no device yet (only Linux, with the K3s driver), native programs onto any device whose roles allow, never a thin client, capture only onto a capture source, no secrets to a device. The pilot is Screenpipe's definition (`services/screenpipe.ts`) on a stand-in. **M10i: system map** (`src/core/services/topology.ts`, `ui/js/topology*.js`; evidence `docs/evidence/m10i-gate.md`): Settings › Services and Health › Devices open a three-layer machine/service/version map, SVG on desktop and rows on phone. Actual device heartbeats, local supervisor state, native workload reports and capture lag retain independent source ages/reasons; worse-of-two health and explicit cluster sites are tested through a trusted stand-in seam, with no production cluster driver yet. Mermaid text comes from the displayed snapshot; stale/error overlays disable export and actions. Existing manager-backed promotion and rollback use their actual policy tiers. Accepted hub changes and device assignments do not claim observed serving. **Not built:** the `service` change kind and `services.git` (M10j/M10k), image-only services and Docker runs under the supervisor, secrets handed to services (none to a device: owner decision Q5), `https:` artifacts (on the hub and to devices), floating copies of one definition on several devices, the K3s driver (M10j). Egress and OS permissions are declared, not enforced, for a plain program; a process that leaves its group (`setsid`) outlives it all; the tripwire sees PATH lookups only. Before M10e: New; the supervisor ran exactly one program, the console. | M10e; M10f–M10k |
35
36 ## Devices, capture, models
37 | Capability | Target | Existing (verified) | Reuse |
38 |---|---|---|---|
39 | Device pairing (QR / code / command) + hub approval | Core | **⬟ M10 (M10f):** device roles at pairing (`mesh/purposes.ts`, migration 0020): the device says what it is for (`claims.purposes`; `/pair` says a phone or browser is a thin client; `boot.ts join --roles`), the hub's approval sheet offers what that kind may hold and the person confirms or changes them there; a computer as hub candidate is confirmed on its own (tier 3, Decision 2) and its key is listed in the next signed roster (`candidates`). Roles are editable in Settings › Devices: widening tier 3, narrowing tier 2 saying what it stops. Devices paired before: phones and browsers thin clients, the standby a hub candidate, computers none, the hub hub candidate and general server. **★ M4: Have (v1, M4a)** — `src/core/mesh/{wire,enroll,devices,identity}.ts`: device-made Ed25519 + X25519 keys, single-use 8-character codes (5 min, stored hashed), commit-then-reveal six digits on both screens, tier-3 approval on the hub (or a device allowed to approve), signed status polls, a signed roster, 12-hour sessions (cookie or bearer, stored hashed), rate limits, revocation that ends sessions and closes streams at once. PWA: Settings › Devices (QR drawn by `ui/js/qr.js`, address + code, the one-line command, the warning), the approval sheet with digits, `/pair` with non-extractable WebCrypto keys. Era 1's code primitives and vectors ported. Tested in core and in Chromium (`tests/ui/m4a-devices.test.ts`). The command door's `/join.sh` and the agent it installs arrived with M4b (see "Two device agents"). Before M4: **▲ corrected to Have (Era 1, needs porting)** — Era 1 pairing matched CONTRACTS §5 closely; not in the tree | M4 |
40 | Device mesh + hub-as-role + failover | Core | **⬟ M10 (M10g): hub promotion** (`src/core/mesh/handover.ts`; plan `docs/plans/M10g.md`, evidence `docs/evidence/m10g-gate.md`). **Planned** ("Promote to hub" in Settings › Devices on the hub, tier 3 every time): pre-checks in words (role: a trusted hub candidate that is the live standby, else a refusal saying to make it the standby first; free disk at least 3× the home and 2 GB of memory as the candidate reports them; the same release and schema; a backup in the last 24 h whose restore drill passed), catch-up, a drain (`ledger.drain`: nothing new starts, running work gets a bound then is handed over to the new hub's recovery, work past its commit point is never cut), writes held (409 with the reason), a signed hand-over at epoch + 1, the old hub a live standby of the new one, and a verification window watched by the old hub (30 min; shorter only in tests and the drill) with an automatic roll-back at epoch + 2 (tier 1, a problem) only on positive evidence: the new hub, reached and authenticated, says it is failing and acknowledges standing down; a new hub that can't be reached stays the hub, and the person may take the hub back (tier 3); a node that steps down keeps in a named checkpoint whatever the other never copied, and says so; a hand-over whose outcome is unknown is settled by the candidate's signed word, or cancelled at tier 3; every step a ledger task in one chain. **Emergency** (the hub can't be reached, and this node holds no live copy): the latest backup passes its restore drill, is staged like a checkpoint restore and swapped in at a restart; this node keeps its own keys and takes max + 1 of every epoch it knows; the sheet states the backup's time, what was lost and that connectors sign in again (no vault-key escrow, Decision 5). **Trust:** device agents pin every hub candidate the roster lists (runtime bundles stay hub- and standby-signed), follow another hub only at a strictly higher epoch (at most 3 past what they know unless the current hub signed it, or a chain of hand-over links, each signed by the hub before it, leads to it), and take a changed roster within a heartbeat (in safe mode too); signed answers are bound to their request, so none can be replayed; fencing treats every pinned candidate as a possible successor, asks the stable mesh name, and breaks an equal-epoch tie by a fixed rule, the winner going one epoch higher; an emergency promotion's epoch is above any roster a paired device showed that node, signed by that device. **During a split**, two hubs can briefly accept writes; when contact returns it settles to one, the stable name is pointed at it, and the loser's changes are kept and named, never merged automatically (no lease or third vote: the owner's decision). The stable name moves only through a driver (`NOVA_MESH_NAME_CONTROL` with `NOVA_MESH_NAME_TOKEN`, https or this machine), here only a loopback stand-in; an automatic failover doesn't move it. **The promotion drill** (two Nova homes in temp folders, real processes, a stand-in computer and phone, a stand-in stable name): a script and a test, recorded in the evidence. Gaps: step 0 (enrolling a candidate as the standby) isn't automated; a computer with only the device agent can't be promoted (no Nova home); no rehearsal from Settings; no person's setting for the window; a real DNS or tailnet driver and a real promotion between the owner's devices are the owner's call. **⬣ M7 (M7b):** the chaos pass covers it: a dead hub fails over (with the `hub-failover` playbook), a partitioned standby is a problem on both sides that closes when it copies again (`resync`), a slow link keeps up with no false failover. Partial — **★ M4 (M4a):** the trust and transport model: a console listener (loopback only, no proxy) and an optional mesh listener (HTTPS, or HTTP only when a TLS proxy or encrypted network is stated; anything else refused at startup); every request is console, a paired device scoped by kind, or public; `mesh_state` (epoch, role) and a signed roster exist; HLC and sealed boxes are in `wire.ts` for sync. **★ M4 (M4c):** a sync log filled by triggers on every replicated table plus a journal of the home's files, pulled by a standby (enrolled with `boot.ts join --kind standby`, read-only, "This is the standby; … is the hub") sealed to its key; forgetting reaches the standby and its backups; promotion (tier 3, or opt-in automatic failover) raises the epoch, signs a new roster with the standby's own pinned key, recovers the ledger and records itself as a verified ledger task; a hub that finds a higher epoch among its peers steps down (fencing). Tested with two real processes and SIGKILL: no loss by content hash, revoked stays revoked. Gap: a hub that stepped down must be enrolled again to become a standby. Before M4: Era 1 hub-and-spoke, mesh VPN adapters, encrypted sync (HLC, LWW, hub canonical). Failover/standby: New (zero hits) | M4 |
41 | Two device agents (boot + runtime, never merged) | Core | **⬟ M10 (M10h):** the boot agent gains five verbs for hub-signed native workloads (`src/device/workloads.ts`: a slot per version, re-verified at every start, started as the person's user, never root, in its own process group with none of the agent's environment, under the watchdog; a killed agent's leftovers ended by the next one on Linux) and the capture carrier (`src/device/carrier.ts`: it holds no new key, signs with the device's own, moves data and starts nothing); the runtime gains `rollout.ts` (it decides and asks over IPC; still no network and no child processes: the M4b sandbox test, run again, covers the new folders; `RUNTIME_CALLS` unchanged). A workload isn't sandboxed beyond running as the person: only hub-signed, pinned programs run. **⬣ M7 (M7b):** a computer in safe mode is a problem with a playbook; the hub asks its boot agent once, in the heartbeat reply, to restart the runtime (`recover`); the watchdog's limit still holds. **★ M4: Have (v1, M4b)** — `src/device/{boot,runtime,queue,trust,watchdog}.ts`, TypeScript on Node (decision in `docs/LEDGER.md`): the boot agent holds the keys (0600), joins by the one-line command (`/join.sh`, `/device-agent.tar`, built by the hub), pins the roster, signs sessions only for a node that proves a pinned key, follows the roster to a promoted standby (never a lower epoch), installs runtime bundles only when a pinned key signed them (refusals reported), and runs the runtime under a watchdog (backoff; three crashes a minute is safe mode). The runtime runs under Node's permission model (reads runtime/ and state/, writes state/, no child processes or addons; tested with `ERR_ACCESS_DENIED`), heartbeats (Online in the registry) and flushes an offline queue (JSON files; the boot agent makes its hub calls, the runtime has no network or `node:sqlite`) to the hub's inbox, exactly once per key. Tested with stand-in nodes and against the real server, over HTTP and HTTPS. Before M4: New as specified — Era 1 `novad` (Rust) has a supervisor + signed modules + signed updates, which is the nearest seed; no boot/runtime split | M4, `novad` as reference |
42 | Capture API + Screenpipe ingest | Core API; ingest first | **⬟ M10 (M10h): the capture data path from spokes** (`src/core/capture/sync.ts`, `src/device/carrier.ts`, migration 0023): derived capture (text, transcripts) pulled from the live capture workload on 127.0.0.1 for the kinds that are on, after their consent, private windows dropped on the device, queued by device sequence and sent in batches whose manifest is signed with the device's key; the hub verifies it against the enrolled device and the session before anything is kept (an unknown, revoked or other device's, or a bad signature or checksum: refused and logged), takes each item once through `ingest` (consent, rules, screening), answers every item, and keeps provenance with the event (device, source, sequence, batch, both clocks); offline the device queues and resumes without loss or duplicate, a full queue pauses and says so; lag per device in numbers and words (`GET /capture/devices`); a forget of what a spoke holds is a tombstone it carries out and acknowledges, signed, and only then "deleted everywhere"; a raw original is fetched only when the person asks, with a reason, as a ledger task verified by Nova's own check; local-only with a cloud hub (`NOVA_MESH_SITE=cloud`) queues on the device and is refused at the hub. Not built: the raw archive, pruning, cold tiers, encryption before upload, a spoke's own delete reaching the hub, the lag on Health or the map. **⬢ M6: Have (v1, M6a)** — `src/core/capture/`: one API (`capture.stream(device, kind)`, normalized events with timestamps, device, space, consent and provenance); consent off by default per source and per device **UNPROVEN** (no eval yet: `claim.capture-nothing-before-consent`), pause, an indicator on every page while anything captures; private and incognito windows dropped before storage; exclusions per app, site, space and time window; classification only by the person's signals (app, device, hours, the explicit switch), ambiguous stays unclassified; stored on the hub (migration 0009) and replicated to the standby; retention swept; forgetting is real deletion (write-ahead log, backups, standby; capture is never in the home's history); promotion to memory deliberate, with CONTRACTS §7 provenance back to the events, and a triage decision only proposes; capture feeds event rules. **Screening, job 1** (`capture-sensitive` v1; plan `docs/plans/capture-screening-consumers.md`): password managers, banking and payment apps, web vaults and bank sites dropped at intake (best effort; the person can let one back in per source); key, token, card and similar shapes redacted in the words, title and address before storing; each event checked by a trusted local model before it can be triaged or remembered, its outcome (index, redact, hold, exclude) and provenance on the event and shown in the Capture view; with no trusted model on the device every event is held, not kept, with a notice (option B), until one can check it or retention deletes it. Adapters: Screenpipe's REST API pulled with its own cursor (an outage is a problem, not a crash; refused under local-only when remote), and device agents' `capture_event` through the M4 inbox, exactly once. PWA: Settings › Capture and the Capture view. Tested against a stand-in Screenpipe (`scripts/fake-screenpipe.js`) in process, with real server processes (egress tripwire, hub and standby) and in Chromium. Gaps: native desktop app activity (ADR-2), Android, and meeting/browser/sensor adapters; a real Screenpipe is the owner's check. Before M6: New in Nova — zero hits in both eras (Screenpipe exists only in the user's own stack) | M6 |
43 | Local model management (detect HW, recommend, download, serve) | Core | **⬢ M6: Have (v1, M6b)** — `src/core/models/`: hardware per device (nvidia-smi, rocm-smi, system_profiler, /proc, statfs; paired computers send theirs in the heartbeat, read by the boot agent) as a device map; one recommendation per role (`triage-text`, `reasoner`, `embedder`, `transcriber`) fitted to VRAM/RAM, installed models first, with the trade-off in words **UNPROVEN** (no eval yet: `claim.model-recommendation-fits-job`); transcription says plainly it has no runtime and stays off; roles assigned in the profile (hub or a paired computer at one of its own addresses); downloads (Ollama `/api/pull`, streamed progress) and removal as tier-2 ledger tasks, verified against Nova's own reading of `/api/tags` (digest, a pinned digest checked), versions recorded, a disk budget refused up front or mid-download; one inference API by role used by chat and by the `openai-compatible` provider set to a role; a GPU spoke woken by Wake-on-LAN, waited for as long as its measured wake took (said when unmeasured), small jobs kept on the hub; the local Decision Model Provider on the sorting role. PWA: Settings › Models. Tested against a stand-in Ollama and a loopback Wake-on-LAN listener (`scripts/stand-ins/`), in process, with the real server (egress tripwire) and in Chromium; checked read-only against the real Ollama. Gaps: no transcription adapter (whisper); downloads only through Ollama; a real GPU spoke over a LAN is the owner's check. Before M6: Partial — **▲ corrected:** Era 1 detects running Ollama/llama.cpp servers and GPU VRAM; no recommendation, download or serving lifecycle. Era 2 none | M6 |
44 | Cloud/local provider fallback chains | Core | **⬢ M6: Have (v1, M6b)** — `models.infer` works the chain inside the task's privacy mode, as LOCAL-MODELS' worked examples: local-only never reaches the cloud (the task waits "on local capacity", the person is told, and it runs when capacity returns; tested with the cloud stand-in getting zero requests) **UNPROVEN** (no eval yet: `claim.local-only-no-cloud-fallback`); local-preferred falls back to the person's cloud model with the receipt saying so and a problem for the local fault; cloud-allowed falls back to local with a note that the answer may be less thorough. Cloud budgets per task and per period, usage tracked from every call and every remote report; over budget the work waits with the reason and local stays the answer. Gaps: fallback is per call, before any output, as Era 1's; one cloud model, not a chain of them. Before M6: Partial — **▲ corrected:** Era 1 router falls back before first output and fails closed when cloud is disallowed (one global boolean, not per-task privacy modes) | M6, Era 1 router as reference |
45 | Voice chat | Core channel | New — confirmed absent | — |
46
47 ## Extensions and integrations
48 | Capability | Target | Existing (verified) | Reuse |
49 |---|---|---|---|
50 | Extension host (MCP, plugins, connectors, skills) | Core | Partial — **✦ M5:** the connector kind (`src/core/connectors/`): a connector is in the host while connected, keeps its secrets in the vault, turns what it sees into M2 event triggers, and its removal (Disconnect, or `DELETE /extensions/{id}`) signs out at the service and deletes its secrets, rules and settings; a kind can revoke on removal (`defineKind({revoke})`). Built in: Home Assistant and Gmail. MCP servers and plugins still run no code. **● M1:** host skeleton (`src/core/extensions.ts`): install disabled, permission review, enable with OK, disable, remove; runs no extension code yet. Before M1: Era 2: skills only (Claude `SKILL.md` format, install/add/remove/undo, clean removal); connectors hard-wired. Era 1: MCP client (stdio/HTTP/OAuth), skills, sandboxed extension SDK (QuickJS/WASM) with declared permissions | M1 skeleton; Era 2 skills; Era 1 MCP later |
51 | Extension manifest + lifecycle (install/enable/remove cleanly) | Core | **⬣ M7:** updates are versioned and go through the change pipeline (sandbox, tests, health gates, release, approval, canary, automatic rollback to the previous manifest and files); an extension's tests and health probe are declarative. Partial — **● M1:** CONTRACTS §4 manifest validated in full; `on_remove` followed exactly, no residue (tested). Update path and runtime enforcement not yet. Before M1: Era 1 manifest has permissions, signed bundles, permission-diff on update, uninstall with data removal, but no `on_remove` declaration and two separate manifest formats. Era 2 skills have no manifest | New manifest per CONTRACTS §4 at M1 |
52 | Agent adapters: Claude Code, Codex, ChatGPT/dots, Gemini, Copilot | Adapters | **⬟ M10 (M10c):** the same adapters also write coding runs’ changes, through `Providers.workIn` (the registry’s own gates, receipt and adapters, factored out of its run as `#prelude`), in a plain copy of a git worktree of Nova’s own; see “Coding through chat” below. **✦ M5 (M5a): Partial (v1)** — `claude-code` (`claude -p --output-format stream-json`), `codex` (`codex exec --json`), `openai-compatible` (the JSON files contract, applied by Nova with every path checked) and `custom-cli`: each enabled one a ledger worker in a per-task folder (`workspace/tasks/<id>/`), gated by `permits(privacy, egress)`, a receipt per call, verified by Nova (it runs the brief's test command itself, tier 2, and checks the diff), results copied back only after verification. Tested against stand-ins speaking each CLI's real protocol (`scripts/stand-ins/`); the OpenAI-compatible path also checked for real against the local Ollama. Not built: ChatGPT/dots, Gemini, Copilot; real Claude Code and Codex runs need the owner (subscription; Codex isn't installed). Before M5: Partial — Claude path exists (Era 2 `agent_cmd`). Era 1 had a generic ACP stdio adapter host (off by default); no named adapters | M5 |
53 | Automation adapters: n8n / Zapier / Make (webhooks) | Adapters | **✦ M5 (M5a): Partial (v1)** — `n8n`: the brief POSTed to a workflow webhook signed with HMAC-SHA256; the report comes back through M2's token webhook (`/api/v1/hooks/n8n-callback`), signed, carrying a `confirmation` Nova checks against the signed callback it kept; each callback is a trigger record. Tested against a stand-in n8n; a real workflow is the owner's check. Zapier and Make not built (the same adapter shape would serve). Before M5: Partial — Era 1 has an HMAC-signed generic webhook channel; no n8n integration | M5 |
54 | Smart-home bridges (Home Assistant, Apple Home via bridges, Scrypted) | Connectors | **✦ M5: Have (v1, Home Assistant)** — `src/core/connectors/home-assistant.ts`: address + long-lived token (in the vault); states (tier 0); service calls as ledger tasks at tier 2, tier 3 for marked domains (locks and alarms to start), verified by Nova’s own read-back; `state_changed` over the WebSocket API as event trigger records for the entities a rule listens to, reconnecting after a drop; egress local for this network or the mesh; removal deletes the token at Home Assistant. Tested against `scripts/fake-home-assistant.js` only: a real Home Assistant is the owner’s manual check. Apple Home and Scrypted: not built. Before M5: New — confirmed absent **Designed (2026-10-31), M11 — Home:** the device model, the Smart Home page, Scrypted and cameras (`docs/plans/smart-home.md`); not built yet. | M5|
55 | Gmail connector | Connector | **✦ M5: Have (v1)** — repackaged as a connector (`src/connectors/gmail-connector.js`): the same reads, drafts and organizing, never sending or deleting **UNPROVEN** (no eval yet: `claim.gmail-read-draft-organize`); its OAuth client, refresh token and app password in the vault (Era 2’s plaintext files move in on start and are deleted); new mail as an event trigger while a rule listens; Settings › Connections. Still one account. Before M5: Partial — **▲ corrected:** Era 2 has both Gmail API (OAuth PKCE) and IMAP app-password paths; reads, drafts and organizes, never sends or deletes (enforced in code; the `gmail.modify` scope itself would allow sending). One account | M5 |
56 | Browser/computer use with human takeover | Capability | **⬟ M10 (M10b):** Nova Browser (the row below) grows this worker: Nova's own persistent profile by default (`profile: "fresh"` keeps the throwaway one), pause, resume and stop beside takeover. **✦ M5 (M5c): Have (v1) for the browser** — `src/core/browser/*`: a ledger worker that drives Chromium over CDP itself (`--remote-debugging-pipe`, no Playwright at run time) through step plans (navigate, fill, click, select, wait, read, a step for a person); each task's declared hosts enforced with CDP Fetch, and a refusing proxy behind it, every refusal recorded; page content is data only. Takeover: the person at any time, or when the worker asks (Needs you); live screencast frames on a per-task event stream, pointer and keys through `Input.dispatch*`, the worker idle while held, hand-back resumes from the page as left; `takeover_started`/`takeover_ended` with who and how long; only the console and `can_approve` devices; frames never cached. Evidence: a screenshot in the task's folder and the final page read afresh by Nova (re-fetch inside the declared hosts, or the final DOM). Tested in Chromium in the Playwright container against a local form site (`scripts/form-site.js`). Gaps: screen (desktop) control is not built; a plan's steps never come from a page, and since the ingest gate (Amendment C Part 3) every page read is screened as it is taken, its verdict kept with it; a restart starts a browser task over. Before M5: **▲ corrected to Have (Era 1, needs porting)** — Era 1 Playwright browser with egress proxy, injection guards, takeover pause/resume and frame stream; screen control with kill key. Not in the current tree | Port at M5 |
57 | Nova Computer: sandboxed workspaces per project (Execution Plane) | Capability | **⬟ M10: Have (v1, M10a)** — `src/core/computer/*`. **The interface:** a `Computer` interface (`create`, `exec`, `checkpoint`, `reset`, `destroy`) with one adapter so far: Docker on this machine, through its CLI. Calls are argv arrays and always name `-H unix://…`; a remote `DOCKER_HOST` is refused. **The workspace:** a container from one pinned image (`node:26-trixie@sha256:6d2c7d5d…`: Node, git, a shell). Only the project folder is mounted: Nova's own empty one, or a folder of the person's that is never their home, a hidden folder, Nova's home or a system folder. It always runs with `--network none`, as Nova's own uid (never root), with `--cap-drop ALL`, no-new-privileges, memory, CPU, process and open-file limits, and no Docker socket. **Egress** is declared: none, registries, or declared hosts. A relay inside, running as `nobody`, carries connections over its `docker exec` stdio to Nova's proxy. The proxy accepts CONNECT only and applies safe-fetch's rules: the host and port must be declared, every resolved address must be public, private names are refused, and the connection goes to the address that was checked. Every attempt is recorded. **Tasks and tiers:** every action is a ledger task for the `computer` worker. A read is tier 0 and is checked afterwards to have changed nothing. A write is do, notify, undo: a checkpoint first, then it runs at ledger tier 1. Egress and deleting a workspace are tier 3. A folder of the person's asks first. Local-only refuses egress twice: in the ledger and in the computer. **Evidence:** a command's output is kept as a file that Nova verifies by hash (a `confirmation` from `nova-computer`), and the ingest gate screens it as tool output. **Checkpoint and reset:** a checkpoint is an image commit plus a copy of the folder. A reset recreates the machine and puts the folder back, verified byte for byte. **Surface:** the API under `/computer`; no UI in M10a. **Tested** with real Docker: a reset byte for byte (the folder, and the container through `docker export`); each escape attempted, with a positive control; the proxy from inside with Node and curl; through the ledger; and end to end through the real server for a fresh user. **Gaps:** no disk quota; the read check can miss a change to a container file that had already changed; checkpoint copies are full copies; no agent tool drives it yet (M10c); after a factory reset, containers are removed only the next time the computer is used. Before M10: New. Era 1's sandbox runner isn't in the tree, and `changes/sandbox.ts` isolates a copy of Nova, not a toolchain. | M10a |
58 | Nova Browser: Nova's own browser, co-pilot, vault logins, site templates, checkout stop (Execution Plane) | Capability | **⬟ M10: Have (v1, M10b)** — the M5c worker in `src/core/browser/*`, grown, not forked. **The profile:** one persistent Chromium profile owned by Nova at `<home>/workers/browser-profile` (never the person's own), one browser on it at a time; sign-ins kept per site between tasks and deletable from Settings (the owner's open question 3, answered with the ADR's proposed default until the owner says otherwise). It keeps only cookies and site storage: password manager, autofill and history off; the HTTP cache a throwaway folder per launch; history, top sites, favicons and session-restore files removed on close. **Driving:** CSS selectors (DOM) or accessibility targets (`{role, name}` through `Accessibility.queryAXTree`), each step recorded `via: dom` or `a11y`; a vision hook (`locate`) is a fallback only, marked `via: vision, fallback: true` (no vision model ships). Clicks are checked first: not covered (`elementFromPoint`), not a pay control. **The person in control:** watch live, pause, resume, stop, take over and hand back (UI: the takeover sheet). **Logins:** saved by the person in Settings › Connections › Site sign-ins or `PUT /browser/logins/{host}`, in the vault under their host; a `login` step names fields only; the worker sets the values through `Runtime.callFunctionOn` arguments only on a page of that host, into the field the plan names (one that swaps itself on focus is refused), masks the fields on the page, and redacts them from everything a session writes; https only, or plain http to loopback; a screenshot after a sign-in is covered whole, in the PNG, by Nova itself. **Screening:** every co-pilot input (element name, page text, dialog) passes the ingest screen; only extracts reach the model. **The Noul co-pilot:** the built-in `browser-step` template (six Noul questions: element matches intent, page changed as expected, obstacle, dark pattern, total matches, dialog injection), asked of the local sorting model only, before and after each acting step, against Nova's own ground truth (DOM, URL, parsed totals); ground truth always decides, and a model sure of the opposite stops the step. CAPTCHA and a sign-in wall ask the person; a paywall stops; a pre-ticked extra is flagged and the person's to untick; an instructing dialog (alert or on the page) is blocked and never followed. **Site templates:** a verified flow with `learn` becomes `browser-site.<host>.<name>` vN through propose, dry runs (the flow's steps and ground truth, plus negative controls) and the activation ledger task; `flow: {name, site, version}` runs it with every step re-checked by its rule; a changed site stops it. **Checkout:** a `checkout` step reads and parses the itemised lines and total (must add up and match the quote) and is where Nova stops; a plan with one is tier 3. The pay control is refused structurally (after the adversarial review of PR #238): while Nova drives, nothing that isn't a GET leaves unless the acting step accounts for it (its declared `sends`; outside a checkout flow, its own submit form), once per declared address and from the page's main frame, nothing while paused or waiting for the person, nothing at all after the checkout stop, no GET to a pay-like address, nothing once stopped, and no WebSocket, WebTransport or WebRTC at all (after the second review); while the person holds the browser, a pay address goes only as their own navigation; the plan validator (whatever a template says) and the click-time check by name, id, class, form action or card fields are a signal on top. Seven hostile stand-in variants (a token fetched to /charge from "Continue", "Complete" to /api/orders, "Pagar ahora", GETs to pay addresses, sendBeacon, a self-submitting form, a link dressed as a button) never reach the stand-in. **Tested** in Chromium in the Playwright container against loopback stand-ins (`scripts/stand-ins/shop-site.js`: shop, sign-in, CAPTCHA, injected dialog, pre-ticked upsell, a pay trap), with a stand-in local model, each guard removed in turn and seen failing. **Gaps:** a page has the values it is given and may use them on its own site; after a sign-in the screenshot shows nothing, and the person's live view isn't covered; GETs carry what their addresses carry (only pay-like addresses refused); no sockets even for the person; first-party Cache Storage doesn't outlive a task; no vision model; the co-pilot tested only with a stand-in model; intent ground truth is a word match; learnt flows replay their recorded values; cookies are forgotten per host name, not per port; no real site, login, CAPTCHA or purchase was tried (Hard limits). Before M10: Partial (M5c's worker with a throwaway profile). | M10b |
59 | Coding through chat (Execution Plane) | Capability | **⬟ M10: Have (v1, M10c)** — `src/core/coding/*`, plan `docs/plans/M10c.md`, evidence `docs/evidence/m10c-gate.md`. **The control plane:** the chat agent's `code_change` tool (and `POST /api/v1/coding`) makes a coding run: a plan recorded in the Work Ledger as a chain of internal tasks for the `coding` worker, each made only when the one before is verified. **Write** (tier 1, undone by discarding): Nova fetches the branch into a bare repository of its own (`workers/coding/repos/`), makes a git worktree on `nova/<run>`, and a coding agent (Claude Code, Codex, Relay, or a chat model through the JSON files contract) changes a plain copy of it, with no `.git`; Nova reads the copy itself (no link followed, `.git`, hard links, special files and links out refused; the task folder's rule that the tests aren't the agent's to change), commits it, and checks its own walk and git's list against what it took. **Check** (tier 2, asks first: it runs the agent's code as the person): Nova's own test run at exactly that commit (`nova-coding-run:` evidence) and the preview command on `127.0.0.1` and a free port, which must answer and, on Linux, listen on loopback only (`/proc/net`). **Merge** (tier 3, every time): only after the check is verified; the person sees the reviewed diff, the test result and the preview link; Nova moves the branch to exactly the reviewed commit (a compare-and-swap of the ref, or a fast-forward of a clean checkout), reads it back, never pushes. Declining leaves the person's repository byte-identical; a branch that moved after review starts a new round that asks again. Nova's git runs no hooks, no fsmonitor, no system or personal config, and local paths only. **Reused:** the ledger (tiers, privacy gate, `internal` workers, recovery, `committing`), the provider registry and its adapters (`workIn`), `taskspace.ts` (`scopeOf`, `outOfScope`, `safePath`), `checks.ts` (`testEnv`), `cli.ts`, `children.ts`, `computer/policy.ts` (`checkFolder`), the trigger engine's proactive message, the ingest gate's guarded steps and outbound guard, the approval sheet. **New:** the coding module, migration 0017, Nova's own git (`coding/git.ts`), the preview (`coding/preview.ts`), two chat tools, the coding sheets in Tasks. **Not reused, on evidence:** the provider task flow through `workspace/` (it would put a worktree where the chat agent can write), the change pipeline (it ships changes to Nova itself), M10a workspaces for the tests and preview (no network and no published port, so a preview there can't be reached). **Not built:** deploy and push (tier 3, no target named); tests and preview inside an M10a workspace; a preview reachable from a paired phone. **After the review of PR #239** (branch `m10c/review-fixes`): a merge past its commit point refuses cancel, decline and discard (the ledger’s new `uncancellable`); the merge is always a ref compare-and-swap, its objects carried as a pack (no fetch in the person’s repository), each transport refused by name; links followed through the tree; files over 50 MB never read; test-runner configuration protected by name for every provider task (`runsTests`) and, for coding runs, an allow-list by extension; chat can’t widen it; a diff over 512 KB never offered; a preview’s whole process group stopped with it, and after a crash only if still Nova’s; every listener of the group checked; records and Nova’s copies of repositories pruned. The check sheet says the tier-2 OK lets the agent’s code do what the person can, Nova’s own files included. |
60 | Infrastructure through chat (Execution Plane) | Capability | **⬟ M10: Have (v1, M10d)** — `src/core/infra/*`, plan `docs/plans/M10d.md`, evidence `docs/evidence/m10d-gate.md`. **Projects:** a folder of the person's with OpenTofu configuration, a monthly budget, a price sheet and the names of its provider secrets (values in the vault, `infra/<project>/<NAME>`), registered through `POST /api/v1/infra/projects` (never chat). **Runs:** a chain of internal ledger tasks for the `infra` worker: plan (tier 1: `tofu init`, `plan -out=<Nova's file>`, `show -json`/`show`; changes nothing) and apply (tier 3, every time: exactly that saved plan, its sha256 checked, the budget checked again, `Checkpoints.auto` and a copy of the state first; Nova reads the state back as its evidence). **Budget guardrails and alerts** (the month priced from the plan's whole before and after, every resource whoever made it; review of PR #241): every resource Nova provisions is recorded with its monthly price under its project; a plan over budget, or with a resource the sheet can't price, is never offered and raises a problem and a message; 80 % is said in the ask; a project's own level raises an alert once per level. **The adapter (ADR-8):** `PlanApplyTool`, one adapter (OpenTofu's CLI on PATH: argv, a minimal environment with only the project's secrets, everything it says redacted). Chat: `infra_plan`, `infra_status`. **Tested only against a stand-in `tofu`** (`scripts/stand-ins/fake-tofu.js`); no provider is chosen (the owner's open question 1). **Limits:** prices are the person's sheet, not a bill; the tool runs on this computer; no Settings page for projects yet. | M10d |
61 | Networking changes with a dead-man's switch (Execution Plane) | Capability | **⬟ M10: Have (v1, M10d)** — `src/core/network/*`. **Targets:** a router, DNS, a firewall or a tailnet's policy, through an adapter (`http-config`: JSON with ETag and If-Match, a bearer token from the vault, plain http only to this machine), registered through the API. **Changes:** a JSON merge patch, as a chain of internal ledger tasks for the `network` worker, in order: prepare (tier 1: the snapshot, sealed on disk with a per-change vault key, and the diff with secret values masked; a patch that sets a secret is refused), apply (tier 3, every time: a compare-and-swap on the snapshot's version, a checkpoint, the write, the read-back), then the **dead-man's switch**: without contact from one of the person's devices within `mesh.contact_window_s` (5 minutes by default; the owner's open question 2), Nova makes the revert itself (tier 1), reads the snapshot back, raises a problem and tells the person. **Contact** (tightened by the review of PR #241) is a new, successful request on the mesh listener under the session of a device trusted at the apply, of a kind the person counts (phones and browsers by default, `mesh.contact_kinds`), from off the hub's machine; the console, a refused request and a computer's own heartbeat never count. A failed revert is tried again while contact is lost, and the problem stays open until it lands or the person settles it. Secrets are refused in patches at any depth, never changed by a change, masked failing closed, and the snapshot, patch and diff are sealed; a revert writes the snapshot's own bytes. No paired device, no change. A revert never overwrites someone else's later change. Chat: `network_change`, `network_status`. **Tested only against a loopback stand-in target** (`scripts/stand-ins/fake-netconfig.js`); no real network setting was touched. **Not built:** a vendor's own interface (a router's API, the Tailscale policy API's HuJSON), each an adapter; a Settings page. | M10d |
62 | Account management through chat (Execution Plane) | Capability | **⬟ M10: Have (v1, M10d)** — connectors and OAuth as M5b built them (secrets into the vault from Settings), and **account steps in Nova Browser** (`src/core/browser/plan.ts`, `worker.ts`): `new_password` (Nova makes the password, keeps it aside in the vault before sending, and makes it the site's once the page shows it took), `create_account` (the account's name and a new password, saved as the site's sign-in), `code` (the person types the code through takeover; Nova never reads or types one). Tier 3 always, and only within 10 minutes of the confirmation (else it stops before a browser opens and asks again). A password or code is never in a plan or a chat: the validator refuses a `fill` into such a field, the page refuses a plan's value in a password field, the redactor masks every value a session used. `POST /api/v1/browser/accounts`; chat: `account_change`. **Tested only on a loopback stand-in site** (`scripts/stand-ins/account-site.js`). **Limits:** a pending password is settled through the API only. | M10d |
63 | Relay integration | Adapter (last) | **⬟ M10 (M10c):** Relay is one of the agents a coding run can use (`agent: relay`), unchanged: it is handed the run’s plain copy and copies its listed files back, as for its own tasks; Nova then commits them in its worktree. Relay’s own accept/merge is still not used: the merge is Nova’s, tier 3. **⬡ M8: Partial (M8b)** — the adapter: `src/core/providers/relay.ts`, a built-in coding-agent provider over Relay's HTTP contract v1, at a loopback address only. A run commits the task's files into a fresh repository under Nova's state (never in the task's folder), connects it, makes a ready task and starts a worker with check `none` and a `requestId` derived from the brief; Nova polls the run, cancels it when the task is cancelled, waits and asks again when Relay is busy, and copies Relay's listed files back (deletions included) only when the list matches the worktree, which Nova reads itself. Where the data goes is Relay's own `workerEgress`, checked again at every run, so local-only work never reaches a remote worker. The run is kept as a `relay-run` artifact (id, branch, worktree, Relay's diff), shown in the task's evidence; Nova's own `file_diff` and `test_result` decide. CI tests it against `scripts/stand-ins/fake-relay.js`, validated against a copy of Relay v0.9.0's `contract/v1.json`. Gaps: the real-Relay gate (M8c), worktree cleanup, accept/merge into a real repository. Before M8: Relay itself: Have (v0.8, tested, live-verified 2026-10-24) — stabilize standalone first. **▲ naming hazard:** Era 1's `packages/relay` / `services/relay` is an encrypted transport relay (LOCAL-FIRST §5's optional cloud relay), not the Relay worker service | M8 |
64
65 ## Product surfaces
66 | Capability | Target | Existing (verified) | Reuse |
67 |---|---|---|---|
68 | PWA client (responsive, posture-aware) | Core | **✧ M9 (Feel & Polish):** gated in the browser in CI: Core Web Vitals at p75 (LCP, INP, CLS, 12 runs per view, Home, chat, Tasks, Settings and Memory at 390×844 and 1280×820); DESIGN-SYSTEM §1's progress bands in one module (`ui/js/wait.js`) with skeletons drawn from the view's own last layout (`ui/js/skeleton.js`), matched to the final geometry to the pixel; motion 150–300 ms, transform and opacity only; contrast in every built-in look and every state; 44×44 (48×48 on touch) hit areas measured with elementFromPoint; state kept across fold, unfold and resize; a second pane at every expanded width; nothing under a real emulated hinge (viewport segments); 200% text (type tokens in rem). Gaps: a real foldable and a real phone remain the owner's check (pairing deferred). **■ M3: Have (v1)** — `ui/`: manifest, service worker (memory and receipts never cached), phone / tablet-foldable / desktop layouts from viewport and posture, nine destinations in every layout; gate-tested in Chromium across 7 widths × 4 postures (`tests/ui`). Foldables are emulated (`?posture=`), not tried on a device. Before M3: Partial — **▲ corrected:** Era 2 web UI is responsive (breakpoints, mobile drawer, reduced motion) but is **not a PWA** (no manifest, no service worker). Era 1 had manifest + service worker (React app). No posture awareness in either | M3 |
69 | Design-system packages + hot swap | Core | **Orb states (owner decision 2026-10-31):** every package declares the orb's seven fixed states (`orb_states{}`); validation fails one that adds, removes or omits a state, lets two differ by colour alone (with motion or under reduced motion), or lets another state share stopped's motion, light or mark; `tests/ui/orb-states.test.ts` checks it in the browser (`docs/plans/orb-states.md`). **✧ M9:** validation adds motion (transitions 150–300 ms, no overshooting curve) and sees see-through surfaces over both ends of the page gradient; the live check adds hover, popover and card-link pairs; type sizes go out in rem. **⬣ M7:** a new or changed package can go through the change pipeline: validated in a sandbox, canaried on one device, then everyone, rolled back on a failed live check; the foundry authors variants. **■ M3: Have (v1)** — `src/core/design.ts`: DESIGN-SYSTEM §2 schema, validated packages (contrast, reduced motion), six built-ins (Orb Teal default, Companion Light, Era 2's four converted), apply per person or per device, rollback, live swap with no reload or restart (gate-tested). Before M3: Partial — Era 2: four token themes, runtime swap with no reload (`data-theme`), `lint:tokens` and `check:themes` (contract + WCAG contrast) in CI. Token names differ from DESIGN-SYSTEM §2; missing `bg/overlay`, `surface/card-hover`, `border/strong`, `accent/secondary`, `status/working`, `status/waiting`, all `orb/*`, `space/8`, most `layout/*`. Not packaged as extensions | M3 |
70 | Themes with identical features per layout | Core rule | **■ M3: Have** — design systems change tokens only; every layout reaches the same nine destinations (tested). Before M3: Partial — Era 2 themes change values only. Stellar Map lives in open PR #207, not on `main` | M3 |
71 | Observability/health UI (errors surfaced in UI) | Core | **⬟ M10 (M10e):** the supervisor runs other services besides Nova by the same rules (see “Service orchestration”); their problems carry playbooks (`service-crashed`, `service-held`, `service-stopped`, `service-rolled-back`). **⬣ M7: Have (v1, M7b)** — supervised process (`src/supervisor/`: restart with backoff, health checks, safe mode with its reason at Nova's address), repair playbooks on every problem they fit (steps for the person, safe automatic repairs, each recorded), Health › Keeping Nova running (supervisor, releases and a canary, backups, the last drill); a problem the full database can't take is still shown. Code releases: tagged slots, tier-3 deploy, sandbox, canary, automatic rollback, no silent data loss across a migration. Gaps: one supervisor per machine, no OS service unit (start it as you start Nova). **■ M3: Have (v1)** — every problem shows as a toast, on the Health destination and in the orb: red (stopped) only for a problem raised as stopping Nova, amber (needs-you) for every other (owner decision 2026-10-31, `docs/plans/orb-states.md`). Before M3: Partial — **● M1:** `/api/v1/health` checks each part in plain words; problems are stored, streamed and listed (`/api/v1/problems`), never only logged; JSON-lines log with secret redaction. Not in the UI yet (M3); Era 2 helper failures still log-only (M3). Before M1: **▲ corrected:** the known defect is narrower than stated. Era 2 chat/agent errors and failed scheduled runs *do* reach the UI (alert with details + retry). Still log-only or silent: helper report failures (`src/helpers.js:69`), helper follow-ups (`:99`, `:108`), home git commit failures. `/api/health` only proves the process is up. Era 1 had diagnostics, structured logs and a health page | M1 (health + structured errors), M3 (UI) |
72 | Setup/onboarding (conversational, fresh-user test) | Core | **⬟ M10 (M10f):** onboarding in the same conversation (`src/core/setup.ts`, `src/core/onboard/`; plan `docs/plans/M10f.md`, evidence `docs/evidence/m10f-gate.md`), in the orchestration ADR's order: the device detected (Linux, macOS, Windows, WSL2 counted as Windows), a new network with this computer as hub ("join" explains the device route) and the hub's roles recommended from its hardware, the backend per OS worded to the evidence (the supervisor pre-selected and the only choice; K3s shown on Linux as not available yet, not offered elsewhere; switching said to be in Settings › Services, which now exists, minimal, saying there is nothing to switch to yet). Then Amendment B Part 2: discovery only when asked (one GET per known local service, one DNS-SD query by mDNS on the network; found, never connected), a consent-first import (notes folders, `.ics` files, Chromium-family and Firefox bookmarks, listed without reading; what is picked passes the ingest gate and waits in Memory for the person's OK), the populated first view with one action chosen only among intents the regression suite demonstrates, empty states on the first session's path with one action. A question's set answers are offered as choices in the PWA. The fresh-user test times the first win (the person keeps an imported note and Nova finds it): measured at machine speed with the path recorded, and the human path estimated. Gaps: discovery's real multicast path has not run on a real network; the empty-state pattern is applied on the first session's path only; one installer for every platform and a PowerShell front door aren't built. **■ M3: Have (v1)** — the same conversation full-screen in the PWA, completed by typing and clicking in every layout (gate-tested); still a scripted interview, not model-driven. Before M3: Partial — **● M1:** conversational setup over the API, offline, writing profile records; passes fresh-user test #1. A scripted interview, not model-driven; no PWA screen yet (M3). Before M1: **▲ corrected:** Era 2 has no first-run flow (seeds empty files). Era 1 had a resumable form wizard, not a conversation | New conversational setup at M1 |
73 | Storage (ADR-4: SQLite + plain files) | Core | **⬣ M7 (M7b):** nightly backups to a folder the person names (snapshot + files + a manifest of hashes; never the vault key or private keys), retention by sequence, an AES-256-GCM copy to a second folder, forgetting carried into both **UNPROVEN** (no eval yet: `claim.forget-reaches-backups`), and a restore drill (weekly and on demand) that restores into a scratch home, checks it and starts a sandbox Nova on it; a corrupted backup fails it. Gap: no remote target (the owner's choice later). **● M1: Have** — `src/core/db.ts`: `node:sqlite`, forward-only checksummed migrations, backup before upgrade, restore tested (ported from Era 1). Era 2's plain files remain for human content. Before M1: Partial — **▲ added:** Era 2 is plain files only (markdown + JSONL in a home git repo). Era 1 used Node's built-in `node:sqlite` with forward-only checksummed migrations and a pre-upgrade backup | M1, Era 1 migration design as reference |
74 | Secrets (vault, referenced by name) | Core | **Designed (2026-10-31):** the Credential Broker and Nova Vault (`docs/plans/vault-broker.md`), which replace this vault's read path; not built yet. **✦ M5: Have (v1)** — `src/core/vault.ts`: AES-256-GCM at rest in `home/vault/` (0600) **UNPROVEN** (no eval yet: `claim.vault-encrypted-at-rest`); the key in the OS keychain (secret-tool; macOS `security`; Windows Credential Locker through PowerShell, untested on real Windows) or `vault/key` (0600) with a plain notice; `secret://` names; out of git history (tested); values redacted from the log, problems and receipts; replicated to a standby sealed in the sync batch (the key never in a sync log), so connectors work after a failover. Approved `exec` runs as the person and can still read a key file. Before M5: Partial — **▲ added:** Era 2 stores connector secrets as 0600 plaintext files, blocked from file tools but readable via approved `exec`. Era 1 had an encrypted file vault + OS keychain with `secret://` references and redaction | Port Era 1 vault when the first secret-bearing extension lands |
75
76 ## Explicitly out of Nova core
77 - Resume/job-search workflows (later workflow on top of connectors).
78 - WorkLedger timecard/standup generation (later workflow; evidence service may be built standalone first under the registry process).
79 - Cortex memory protocol (parked research; consume later only if specified).
```
