# S40 final fix wave — report

Base 5b8e1a48 -> head fba702bb (lane branch claude/nova-gateway-local-inference-1094ff).
12 commits, staged by path, none pushed. Every item was written test-first and run red, then green.
Scratch DBs: nova_gateway_s40_fix, nova_core_s40_fix (nova-scratch-pg :55432).
Commands: `GW` = `cd services/gateway && TEST_DATABASE_URL=…/nova_gateway_s40_fix uv run pytest -q -p no:cacheprovider`;
`CORE` = the same in services/core with nova_core_s40_fix; `WEB` = `cd apps/web && npx vitest run <files>`.

| commit | items |
|---|---|
| ad5e09cc | A1 + B9 |
| 58825e6f | A2 |
| f8a63dae | A3 |
| df1eb231 | B1 |
| b37c7cf3 | B2 + B3 |
| 6ff6d6df | B4 |
| 574c3231 | B5 (web), B6, B7, B8 (core + web), C4 |
| 61e7dd39 | B5, gateway half (see "Beyond the brief") |
| d37c82de | C1 |
| 464e7f34 | C2 |
| c42e7257 | C3 |
| fba702bb | C3 follow-up: test_chat_attachments fixture carries `kind: local` (found by the full core suite) |

## A1: stack_ollama must not hide a dead embedder

**Decision.** I did not derive "did it answer" from `observed_at set, tags None`. The EngineView now states two facts:
- `answered` — did the engine answer this reading. None means it was not asked.
- `builtin` — needed because "non-builtin switched-off nodes stay silent" cannot be derived from anything else core has without writing a name into code.

The contract file lists both. It is now version 2, with a `meanings` block.

**What changed:**
- docs/contracts/engine_view.json — `builtin` added after `name`, `answered` added after `observed_at`, version 2, a `meanings` block.
- services/gateway/app/engines.py:
  - :91 the EngineView gains `builtin` and `answered`;
  - :463 `_view` sets `answered=reading.ok`;
  - :491 `_unobserved` sets `answered=None`;
  - both set `builtin=bool(row["builtin"])`.
- services/core/app/checks/stack.py:
  - :232 new `_embedder_down(view)`: the view is switched_off, builtin and `answered is False`;
  - :245 `ollama()` raises `peer_down:<name>` for it. `facts["serving"]` is False and the title reads "<name> is switched off and not answering the gateway — <reason>" (:271). Unreachable findings are unchanged, so their fingerprints are unchanged;
  - the check's `describe` now names the exception.
- services/core/app/tools/machines.py:51 `_answering` reads the explicit `answered`. A wake-on-LAN machine's stored list is no longer counted as a fresh answer.
- Core mirrors carry the new fields:
  - tests/fakes.py `engine_view`: `builtin = name == "hub"` (migration 009's own CHECK); `answered` follows the state unless the test gives it;
  - machines._FIXTURE_DEFAULTS (:218, :224): builtin False, answered True. FixturePlant derives `answered` from the declared state (:281);
  - evals/cases.py FixtureMachine.as_row (:332, :338).

**Tests:**
- Pinned test replaced (reason written beside it in tests/test_checks.py):
  - `test_a_machine_switched_off_on_purpose_that_still_answers_is_not_an_outage`;
  - `test_the_bundled_machine_switched_off_and_not_answering_is_still_down`;
  - `test_another_machine_switched_off_and_not_answering_stays_silent`.
- Gateway assertions added in test_engines.py (ready / unreachable / switched-off-answering / switched-off-not-answering / unobserved and live).
- test_eval_predicates' literal field set now reads the contract file (moved, with the reason). test_eval_corpus `_hub_row` mirrors the contract.

**RED:**
- `GW tests/test_engines.py` → 6 failed, 31 passed (contract pin; AttributeError `builtin` / `answered`).
- `CORE tests/test_machines.py tests/test_checks.py -k "contract or state_core or switched_off or not_answering"` → 2 failed, 5 passed:
  - `test_cores_mirrors_of_the_engine_view_are_the_contract`;
  - `test_the_bundled_machine_switched_off_and_not_answering_is_still_down` (expected [peer_down:hub], got []).

**GREEN:**
- `GW tests/test_engines.py` → 37 passed. Full gateway afterwards: 640 passed.
- `CORE test_machines test_checks test_tools_machines test_eval_predicates test_eval_corpus test_eval_runner test_machines_api test_resources_api test_checks_inference` → 223 passed.

## B9: core pins its EngineView mirror against the contract

**What changed.** Tests only, in services/core/tests/test_machines.py:
- `test_cores_mirrors_of_the_engine_view_are_the_contract` — the keys of each of these equal the contract's `fields`:
  - `fakes.engine_view()` (in order);
  - `_FIXTURE_DEFAULTS ∪ {name}`;
  - `FixtureMachine.as_row()`;
  - a FixturePlant view.
- `test_every_state_core_writes_or_reads_is_one_the_gateway_can_state`:
  - states emitted by the fake, the plant and as_row are all in `states`;
  - the states tools/machines, checks/stack and machines branch on are read out of their source (`state == "x"`, `.get("state") in (…)`) and are all in `states`;
  - a guard asserts all four states are actually found, so the check is not vacuous.

**RED:** the A1 core run above. The pin failed the moment the contract gained the two fields, before core moved. **GREEN:** as for A1.

## A2: pull/remove narration backing uses the resolved target

**What changed:**
- services/core/app/guards.py:
  - :158 `RESOLVED_MODEL_FACT = "resolved_model"`;
  - `_target_of` (:1041) reads a model_pull / model_remove span's `meta.facts[].resolved_model` BEFORE the raw argument.
- services/core/app/tools/models.py:
  - model_pull (:764) appends `{resolved_model: row["id"]}` (the catalogue row that confirmed the pull) after confirmation;
  - model_remove (:651) appends `{resolved_model: f"{engine}:{removed}"}` from the gateway's verified answer;
  - nothing is recorded when nothing was confirmed. The guard stays pure (stdlib only); the tool imports the constant from it.

**Tests:**
- test_guards.py:
  - `test_a_pull_is_backed_by_the_id_the_tool_resolved_not_the_raw_argument` — "I pulled hub:qwen3:4b." is backed by model_pull('library:qwen3:4b') and by model_pull('ollama:qwen3:4b'), each as the executor leaves the span. It still fires against model_pull('dell:qwen3:4b'), a resolution on dell, a different model, and a failed span;
  - `test_a_remove_is_backed_by_the_id_the_tool_resolved_not_the_raw_argument`.
- test_tools_models.py:
  - `test_a_confirmed_pull_records_the_machine_qualified_id_it_acted_on` — library:, ollama: and bare all record `hub:qwen3:4b`; an unconfirmed pull records nothing;
  - `test_a_verified_remove_records_the_machine_and_model_it_removed`.

**RED:**
- `CORE tests/test_guards.py tests/test_tools_models.py -k "resolved or records"` → 4 failed.
- The first run of the tool tests failed on the test's own FrozenInstanceError (ToolContext is frozen). I fixed the tests with dataclasses.replace, then reverted models.py to HEAD and re-ran. The genuine red was 2 failed: `assert [] == [{'resolved_model': 'hub:qwen3:4b'}]`. The patch was then re-applied.

**GREEN:** `CORE tests/test_guards.py tests/test_tools_models.py` → 710 passed.

## A3: machine_configure capability pattern is generic only

**What changed.** In services/core/app/guards.py:1595 both alternatives now take only `(a|any) machine(s)` or bare plural `machines`. The determiners the/this/that/your/my are gone, and the header comment says why.

**Tests** (test_capability_guard.py):
- MUST_NOT_FIRE +6, her relayed refusals:
  - "…on that machine — the gateway has no machine named dell."
  - "I'm unable to stop this machine from running chat models: the gateway refused the change."
  - "…on this machine right now — the gateway couldn't be reached."
  - "I can't turn off serving for your machine — hub's switch is not confirmed set."
  - "…on this machine until the gateway is back."
  - "I can't stop the machine from running models until the gateway is reachable."
- MUST_FIRE +2 for the general forms kept ("any machine"; "machines"). No existing MUST_FIRE used a specific determiner.

**RED:** `CORE tests/test_capability_guard.py` → 6 failed, 115 passed (the six relays). **GREEN:** `CORE test_capability_guard test_guards test_eval_corpus` → 835 passed; `test_tools_registry test_tools_machines test_eval_predicates` → 65 passed.

## B1: served_stamp bounded at 2 s total

**What changed.** services/gateway/app/data_plane.py:
- :49 `STAMP_BUDGET_S = 2.0`;
- serve_completion wraps the whole `served_stamp` (the engine's observation plus its /api/ps) in `asyncio.wait_for(…, STAMP_BUDGET_S)`. On TimeoutError it logs the reason, leaves `Served()` in place, and so omits served_on, served_runtime and the ledger's served_on.

**Tests** (test_served_on.py):
- `test_a_stamp_that_stalls_costs_the_stamp_never_the_reply` — the stalled fake observe never returns, with a 0.05 s budget. The reply is 200, served-by is named, there are no stamp headers, and served_on is NULL. The request is itself wrapped in a 5 s wait_for, so an unbounded stamp shows up as a red test rather than a hung suite;
- `test_the_stamps_whole_budget_is_two_seconds`.

**RED:** `GW tests/test_served_on.py -k "stall or budget"` → 2 failed (TimeoutError: the reply hung behind the stamp; no STAMP_BUDGET_S). **GREEN:** `GW tests/test_served_on.py tests/test_data_plane.py` → 24 passed.

## B2: every eval turn runs under a FixturePlant

**What changed.** services/core/app/evals/runner.py:381: `_install_fixture_plant` always installs `FixturePlant({declared…})`, and it is empty when the case declares no machines. The module docstring's "THE DECLARED MACHINES" section and the plant_token comment now say this is enforced.

**Test.** The pinned test is replaced (reason in its docstring): `test_every_case_runs_under_a_plant_so_no_eval_switches_a_real_machine`.
- In a no-machines case, the tool inside the turn sees a FixturePlant.
- The real `machine_configure({'machine': 'hub', 'serving': False})` is refused with "hub's switch is not confirmed set — cannot: 'hub' is not one of the machines that can be switched here".
- GatewayPlant.set_serving is an alarm and is never reached.
- The process plant is restored after the case.

**RED:** `CORE … -k "plant or refusal or fixture or eval_machine"` → the new runner test failed (`isinstance(GatewayPlant, FixturePlant)` False). **GREEN:** `CORE test_eval_runner test_machines test_tools_machines test_eval_corpus` → 108 passed.

## B3: no test-awareness leakage from the plant

**What changed.** services/core/app/machines.py:
- :327 the refusal is now "cannot: '<name>' is not one of the machines that can be switched here";
- :313 a declared machine's card reason is "no card reading for <name>";
- the eval explanation ("… not one of this case's declared machines, and an eval never changes a real machine") goes only to `logger.info` (logger "core").

**Tests:**
- `test_the_refusal_names_the_machine_and_why_in_words` (exact string moved, reason beside it).
- New `test_nothing_the_fixture_plant_says_to_a_tool_mentions_evals`. The card reason and the refusal contain no "eval" once the declared name is removed, and the explanation is in the log records.
- test_tools_machines' match moved to the new wording.

**RED/GREEN:** the same runs as B2 (3 of the 4 red were B3's).

## B4: the true rule for model ids

**What changed:**
- services/core/app/chat.py:879: the prompt now reads "a model id qualified with a machine's name (machine:model) names that machine; a bare id, whose own colon is its tag (qwen3.8:27b), means the default machine."
- services/core/app/tools/machines.py:32 `_ID_RULE` holds the same sentence once, used by machine_status's description and its result header (which keeps "<first>:<model> runs on <first>").

**Tests** (test_tools_machines.py; TRUE_RULE / FALSE_RULE constants):
- the prompt test moved from the false sentence to the true one;
- the header and the description are pinned;
- "names its machine before its first colon" is asserted absent in all three.

**RED:** `CORE tests/test_tools_machines.py` → 3 failed. **GREEN:** 14 passed. Every test that reads the prompt or tool descriptions: 183 passed.

## B5, B6, B7, B8, C4: web (and B8's core half)

**What changed:**
- apps/web/src/pages/settings/machinesFormat.ts:
  - `machineStateLabel` returns `{text, color, line}`;
  - switched_off → "switched off — chat routing passes over it" (:19), with `line: true`. It is a sentence, so it gets its own line rather than a one-line badge;
  - `line` is also true for any label that carries a reason. The tile's old `carriesReason` computation is replaced by it.
- apps/web/src/pages/settings/MachinesSection.tsx:
  - description (:108): "Where Nova's models run. Chat routing passes over a machine that is switched off: the next link in the role's chain answers instead, and a role with no other link fails and says why." The "names its model directly is still served there" sentence is removed (B5);
  - a failed PATCH (:175) reads "Could not confirm <name>'s switch: <reason>". The tile then calls the section's `reread` (GET, cached reading) and shows the true position. If the re-read fails, " — reading it again failed too: <reason>" is appended (B6);
  - the Toggle label is `${name}: chat routing uses this machine` (:234), which gives each switch its own accessible name (B7);
  - `models === null` renders "Could not list its models: <reason, or 'the gateway gave no reason'>" (:216); "No models listed." is kept for a real empty list (B8);
  - the Refresh row renders whenever `machines !== null || loadError` (:117). The count shows only when there is a list (C4).
- apps/web/src/lib/api.ts:1199: `Machine.models` is `…[] | null`, and the doc says what null means.
- services/core/app/machines.py:355: `machine_json` returns `models: None` when tags is not a dict (it was []).

**Tests:**
- machinesFormat.test.ts:
  - every label pinned with `line`;
  - the switched_off pin moved (reason beside it) and asserts no "not running" / "no model calls".
- MachinesSection.test.tsx:
  - description test moved (asserts the new sentence and the absence of "still served there");
  - `theSwitch` queries by the machine-named label;
  - the failed-write test now expects "Could not confirm hub's switch: …" plus a second getMachines call;
  - new: a stored-but-unconfirmed write shows the re-read position; a failed re-read is said; two machines' switches named separately; models null says "Could not list its models: …"; an empty list still says "No models listed."; Refresh after a failed load (and a good read clears the alert); Refresh on an empty list.
- Core test_machines.py `test_the_web_shape_…`: `tags=None` → `models is None` (moved, with the reason), `tags={}` → `[]`.

**RED:**
- `WEB src/pages/settings/MachinesSection.test.tsx src/pages/settings/machinesFormat.test.ts` → 15 failed, 14 passed.
- `CORE tests/test_machines.py -k web_shape` → 1 failed (`assert [] is None`).

**GREEN:**
- `WEB` (the same two files) → 29 passed; `npx tsc --noEmit` clean.
- `CORE test_machines test_machines_api` → 27 passed.

## C1: standby asks /api/show about the default alone first

**What changed.** services/gateway/app/routing.py:429 (`standby`):
- `_chat_models` is asked about only the tags that are the default (`default` or `default:latest`) first, and the default is returned when it chats;
- the other tags are asked about only when the default is not installed or does not chat.

**Tests** (test_routing.py):
- `test_the_standby_asks_about_its_default_model_alone_first` — the only /api/show asked is qwen3:8b's;
- `test_a_default_that_does_not_chat_fans_out_to_the_rest` — the embedding default is asked about first, then the rest, and zz-chat:1b answers.

**RED:** `GW tests/test_routing.py -k "alone_first or fans_out"` → 1 failed (`['qwen3:8b', 'qwen3:4b'] == ['qwen3:8b']`). **GREEN:** `GW tests/test_routing.py` → 25 passed.

## C2: pull accepts `library:<tag>`; dead engines.installed_sizes deleted

**What changed:**
- services/gateway/app/catalog.py:692 `engine_and_model` reads a `library:` id as the model after it, bound as a bare ref is (the unique engine, or refused by name when there are several). This covers pull, remove and drift, which share it.
- services/gateway/app/engines.py: `installed_sizes` deleted. services/gateway/tests/test_engines.py: its test deleted.

**Tests** (test_admin_pull.py):
- `test_a_library_rows_own_id_pulls_its_model_onto_the_machine` (200, engine hub, /api/pull qwen3:8b);
- `test_a_library_id_with_two_machines_is_refused_naming_both`.

**RED:** `GW tests/test_admin_pull.py -k library_` → 2 failed (400 "model must look like … got 'library:qwen3:8b'"). **GREEN:** full gateway → 645 passed.

## C3: one card-selection helper; vision bare tails against LOCAL rows only

**What changed:**
- services/core/app/machines.py:184 `the_card(pairs) -> (view, detail) | reason`:
  - it chooses by readability (`vram.total_mb is not None`);
  - exactly one readable → that one;
  - more than one readable → "N machines report a card that can be read, and which one is meant is not matched here";
  - none readable and exactly one read → that one, so its own `vram.reason` is carried;
  - none read → "the gateway lists no machine whose card could be read";
  - several unreadable → each reason, by name.
- It is used by checks/inference.py:110 (`_card_facts`) and resources_api.py:88 (`_card`). Both copies of the count-and-pick code are gone.
- services/core/app/vision.py:176:
  - `bares` holds only tails of `kind == "local"` rows;
  - `preferred` matches a bare tail only on a local row;
  - a cloud row is matched by its whole id.

**Tests:**
- test_machines.py: six the_card tests, covering readability over count, a single failed machine carried, two readable not guessed, several unreadable each named, nothing listed or all asleep, and both readers going through the helper.
- test_checks_inference.py / test_resources_api.py:
  - the hub's card is read beside a machine whose card is not;
  - the "2 machines report a card" wording moved to the helper's (reason beside each).
- test_vision.py:
  - `test_a_bare_setting_is_matched_against_local_rows_only`: a cloud row ending in qwen3.8:27b no longer makes the local, blind qwen3.8:27b "able", nor becomes his preference; named whole, it is still matched;
  - the `row()` helper and the S40 rows carry the gateway's `kind: local`.

**RED:** `CORE test_machines test_checks_inference test_resources_api test_vision` → 11 failed, 63 passed (the_card missing; both readers returned "2 machines report a card" for hub + dell; the vision cloud-tail match). **GREEN:** the same files plus test_models_vision → 79 passed.

**Follow-up (fba702bb).** The first full core run failed `test_chat_attachments::test_the_vision_model_he_chose_is_the_one_that_answers` (`'qwen3.8:27b' in 'ollama:gemma4:31b'`). That file's catalogue rows carried no `kind`, a shape the gateway never publishes (`base_row` requires one), so the bare chat.vision_model no longer matched its row. The fixture now carries `kind: local`. `CORE test_chat_attachments test_live_facts test_threads test_settings test_models_vision test_tools_route` → 94 passed.

## Beyond the brief (flagged for review)

**Gateway wording (commit 61e7dd39).** `engines.switched_off_reason` read "it runs no models until switched back on". The final review's B5 triage line says to "align that sentence in the same pass". The sentence now surfaces in A1's new notice title, the routing 503 and the observe reason. It now reads "<name> is switched off (serving=false): chat routing passes over it".
- Pin: test_engines `test_switched_off_has_one_wording`.
- RED: `GW tests/test_engines.py -k one_wording` → 1 failed ('runs no models' contained).
- GREEN: full gateway 642 at that point. Core's test_checks fixture text follows.

**Contract version bump.** Two fields were added to EngineView (A1): version 1 → 2, with a `meanings` block. Nothing reads `version`.

## Final full suites (at fba702bb)

- gateway: 645 passed (baseline 640). +2 served_on, +2 routing, +2 pull, −1 installed_sizes.
- web: 78 files / 1,157 tests passed (baseline 1,149), `npx tsc --noEmit` clean.
- core: 3,161 passed, 0 failed (baseline 3,134; +27), 14:19, run alone on nova_core_s40_fix at fba702bb. tests/test_no_approvals.py is inside it and green.
- gateway and web were run at c42e7257. The only later commit (fba702bb) touches one core test file, so they stand.
- The first full core run (at c42e7257) was spoiled by my own mistake. I ran targeted core tests against the SAME scratch DB while it was running, so the conftest's schema reset under it produced 1,094 errors ("relation people does not exist", then event-loop cascades). The one real failure in it was the fixture above. The suite was then re-run alone.
- ruff check + ruff format ran on every edited Python file only. No unrelated reformatting landed: each diff was checked with --diff first.

## Could not do / notes

- **Found in passing (pre-existing, not touched).**
  - test_chat_attachments.py has an unused `from tests import fakes` (ruff F401), also present at 5b8e1a48.
  - `test_the_vision_model_he_chose_is_the_one_that_answers` logs "chat turn … failed unexpectedly — TypeError: sequence item 0: expected str instance, dict found" (chat.py:4143 `"".join(parts)`) while passing. That happens at 5b8e1a48 too, checked by running base vision.py plus the base fixture.

- Nothing in the list was left undone.
- **Refused-write wording.** A refused FixturePlant write reaches her as "hub's switch is not confirmed set — cannot: …". That is machine_configure's existing mapping of PlantUnavailable. It is true (nothing was set) but reads a little indirect for a refusal; I left it alone because it is outside the brief.
- **Layout not re-measured.** The switched_off label moved from a badge to its own line, and the toggle label is longer ("hub: chat routing uses this machine"). I did not re-run the 280/393 px layout measurement; the 393 px check is already owed at T9.
- **Case-file comment.** The checks-where-models-run-before-saying case file still says "it reads the owner's real plant, read-only". That is now enforced (B2), so the comment was left as is and suite_version is unchanged (no case or contract moved).

## Follow-up: echo backing

Three small fixes on top of the fix wave above, each test-first.

**1. Resolved id OR raw argument backs a pull/remove claim (`app/guards.py`).**
`_target_of` (was lines 1051-1056, unchanged) still prefers `RESOLVED_MODEL_FACT`
when present, but `_backed` (`app/guards.py:1115`) now also tries the raw
argument the tool was actually called with when the resolved id doesn't back
the claim — through two new helpers, `_raw_model_arg_of` (`guards.py:1090`)
and `_argument_echoes` (`guards.py:1102`, engine-STRICT: a bare raw argument
does not rescue a machine-qualified claim, unlike `_same_model`'s leniency).
This fixes the case where a reply echoes exactly what she called the tool
with (`model_pull(model='ollama:qwen3:4b')` resolving to `hub:qwen3:4b`,
reply "I pulled ollama:qwen3:4b.") — previously wrongly corrected because
only the resolved id counted.

Pins added in `tests/test_guards.py` beside the existing `resolved_model`
tests: `test_a_pull_is_also_backed_by_echoing_the_raw_argument_she_was_given`
(ollama: and library: echoes) and
`test_a_remove_is_also_backed_by_echoing_the_raw_argument_she_was_given`
(ollama: echo). The existing MUST-fire pin at `test_guards.py:1720`
(`hub:qwen3:4b` claim, span resolved to `dell:qwen3:4b`, bare raw arg
`qwen3:4b`) stays green — the engine-strict raw check does not treat a bare
argument as naming any machine.

- RED: `TEST_DATABASE_URL=... uv run pytest -q -p no:cacheprovider tests/test_guards.py -k echoing_the_raw_argument` → `2 failed, 686 deselected` (both new pins: `Correction(... 'I did not actually do that ...')` where `None` was expected).
- GREEN: same command → after the fix, `tests/test_guards.py` full file → `688 passed`.

**2. Machine-status header: example follows the clause it illustrates
(`app/tools/machines.py`).** `_ID_RULE` (was one string, `machines.py:31-34`)
split into `_ID_RULE_QUALIFIED` and `_ID_RULE_BARE` (`machines.py:35-37`,
concatenated back into `_ID_RULE` unchanged for the static tool
description). The per-call header (`machines.py:121-122`, was 118-119) now
reads "...names that machine ({first}:<model> runs on {first}); a bare
id...means the default machine" instead of putting the `{first}` example
after the bare-id clause, where `machine="dell"` made the header read as if
the filtered machine were the default.

Pin adjusted in `tests/test_tools_machines.py`: the old
`assert TRUE_RULE in said` (a contiguous-string pin that no longer matches
once the example is interleaved) replaced with a new `HEADER_RULE` constant
matching the reordered sentence, used only in
`test_status_reads_every_machine_live_and_leaves_a_fact_for_each`; `TRUE_RULE`
itself is untouched and still pins the static tool description and system
prompt (which never reorder).

- RED: `TEST_DATABASE_URL=... uv run pytest -q -p no:cacheprovider tests/test_tools_machines.py::test_status_reads_every_machine_live_and_leaves_a_fact_for_each` → `1 failed` (`HEADER_RULE` substring not found; old order still present).
- GREEN: `TEST_DATABASE_URL=... uv run pytest -q -p no:cacheprovider tests/test_tools_machines.py` → `14 passed`.

**3. Eval-runner wording scoped to what's enforced (`app/evals/runner.py`).**
Both the module docstring's "THE DECLARED MACHINES (S40)" section
(`runner.py:65-77`, was 65-74) and `_install_fixture_plant`'s docstring
(`runner.py:386-398`, was 381-390) said "an eval never changes/writes ...
the gateway/a real machine" as a blanket claim. Reworded both to say
explicitly that only `machine_configure`'s serving switch is intercepted by
the `FixturePlant`, and that `model_pull`/`model_remove` are also offered in
every eval turn and DO reach the real gateway, unchanged by this note. No
behaviour changed — `app/machines.py`'s `FixturePlant`/`PlantUnavailable`
wording (which is accurate in its own, narrower domain: it only ever
handles `set_serving`) was left untouched, as were its tests.

New pins in `tests/test_eval_runner.py` (needed `import inspect`):
`test_the_fixture_plant_docstring_scopes_its_guarantee_to_the_serving_switch`
and `test_the_module_docstring_scopes_the_never_changes_a_real_machine_claim`,
both asserting `model_pull`/`model_remove` appear in the relevant docstring.

- RED: `TEST_DATABASE_URL=... uv run pytest -q -p no:cacheprovider tests/test_eval_runner.py -k docstring_scopes` → `2 failed, 49 deselected` (`'model_pull' in <old docstring>` False both times).
- GREEN: same command → `2 passed, 49 deselected`.

## Targeted + full suite (this follow-up)

- Targeted: `tests/test_eval_runner.py tests/test_guards.py tests/test_tools_machines.py tests/test_tools_models.py tests/test_capability_guard.py tests/test_no_approvals.py` → `911 passed`.
- `uv run ruff check` + `ruff format --diff` on the 6 edited files (3 app, 3 test) → clean, no reformatting.
- Full core suite (`nova_core_s40_echo`, alone): `3165 passed, 12 warnings in 896.33s (0:14:56)`, exit code 0. The 12 warnings are pre-existing `@pytest.mark.asyncio` marks on non-async functions in `tests/test_model_speed.py`, unrelated to this change.
