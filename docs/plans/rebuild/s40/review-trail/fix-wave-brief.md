# S40 final fix wave — the complete list (one dispatch)

Base: 5b8e1a48 (lane branch claude/nova-gateway-local-inference-1094ff, all of S40 merged).
Details and verifier reasoning for A1-A3: final-review.md (same directory). Plan + rulings: docs/plans/rebuild/slice-40-engines.md.

## A. Confirmed by the final review (must fix)
A1. stack_ollama must not hide a dead embedder: a builtin engine that is switched_off AND was observed without answering (observed_at set, tags None — or add an explicit `answered` bool to EngineView and use it) still raises peer_down:<name>; serving=false goes in the facts so the title says "switched off and not answering". Non-builtin switched-off nodes stay silent. Replace the pinned test with the pair: switched off + answering = no finding; switched off + not answering = finding. (services/core/app/checks/stack.py:248-251, tests/test_checks.py)
A2. Pull/remove narration backing must use the target the tool RESOLVED, not the raw argument: model_pull / model_remove record the machine-qualified id they acted on (facts_sink or span meta) and guards._target_of reads that first. Pins: "I pulled hub:qwen3:4b." is backed by model_pull(model='library:qwen3:4b') and by model_pull(model='ollama:qwen3:4b'); still fires against model_pull(model='dell:qwen3:4b'). (guards.py:1059-1072, tools/models.py:470-491,754)
A3. The machine_configure capability pattern must not "correct" her honest relay of a refusal or a failed switch: tighten the denial pattern to GENERIC self-denial of the capability (per the guard header's own rule), and add MUST_NOT_FIRE pins for relaying a machine_configure refusal and a failed switch. (guards.py:1575-1576, tests/test_capability_guard.py)

## B. Final-review minors ruled into this wave
B1. data_plane.served_stamp: bound the stamp's engines.observe (and resident read) at 2 s total; on timeout OMIT served_on/served_runtime (omitted, never guessed). Test with a stalled fake. (controller ruling in progress.md)
B2. EVERY eval turn runs under a FixturePlant, not only cases that declare machines: _install_fixture_plant always installs one (empty fixtures when none declared), so a write to any non-eval_ name is refused before HTTP in every case. Update test_a_case_that_declares_no_machines_never_builds_a_plant accordingly (the invariant: an eval never changes a real machine).
B3. No test-awareness leakage anywhere a model can read: the FixturePlant refusal reads "cannot: '<name>' is not one of the machines that can be switched here" and the eval machine card reason must not mention evals (e.g. "no card reading for <name>"); the eval-specific explanation may stay in logs/span meta only. (machines.py FixturePlant, runner)
B4. Her system-prompt sentence (chat.py:872-883) and machine_status's description/result header must state the TRUE rule: a qualified id "machine:model" names its machine; a bare id (whose own colon is the tag, e.g. qwen3.8:27b) means the default machine.
B5. Web copy says only what is enforced: the switched_off badge/label and the section description say that chat routing passes over a switched-off machine (the next link in the role's chain answers); do not claim it receives "no model calls". Remove the "A call that names its model directly is still served there" sentence (chat.model is link 1 of the role chain, so it is misleading). (machinesFormat.ts:12, MachinesSection.tsx:95,193-199)
B6. Web: a failed PATCH is worded "Could not confirm <name>'s switch" and the tile RE-READS the machine (GET) to show the true state, since core's read-back can fail after the gateway stored the change. (MachinesSection.tsx:148-149)
B7. Web a11y: each tile's switch has an accessible name that includes the machine's name (e.g. "hub: runs chat models").
B8. "Could not be asked" is not "no models": core machine_json carries models: null when the engine's tags are None; the web Machine type allows null and the tile says "Could not list its models: <reason>" instead of "No models listed." (machines.py:276-289, api.ts, MachinesSection.tsx:181-192)
B9. A core test pins core's EngineView mirror against docs/contracts/engine_view.json: fakes.engine_view's keys and machines._FIXTURE_DEFAULTS' keys equal the contract's `fields` (and the states it may emit are in `states`).

## C. Controller's earlier final-wave rulings (from progress.md)
C1. T3 standby asks /api/show for the DEFAULT model alone first and fans out only when the default is not a chat model (a slow show after a restart must not 503 a standby that worked).
C2. T4: pull accepts a `library:<tag>` id as bare (target = default / unique engine); delete the now-dead engines.installed_sizes and its test.
C3. T5: one card-selection helper in machines.py (e.g. machines.the_card) used by checks/inference and resources_api; choose by readability (vram.total_mb is not None) and still carry a single listed machine's failure reason. vision.choose matches bare tails against LOCAL rows only (+ a cloud-row test).
C4. T8: the Refresh button renders whenever `machines !== null || loadError` (also on empty/error).

## Not in this wave (carried to slice-40-carries by the controller)
Rollback procedure (#4 — controller fixes in T9 docs and drills it); standby 503 omits the standby's own words; resources panel sequential slow reads; `by <gerund>` exemption in _claims_in; Routing verdicts stale after a switch; switch read-back latency; isolated-gpu e2e compose semantics; facts block not crossing to core; shadow check on make_default; catalogue reads bypass the wake guard; cross-machine bare pull/claim backing; natural "I switched hub off" fabrications; checks case vs cloud model; EngineView shape thrice in evals; engines.client sends no bearer to non-builtin engines.
