# S40 plan review

## 1. Contract consistency: conflicts and the ruling on each

**C1. Three readers of the hub's devices; there must be one.**
- The parts define three:
  - T2: `engines._builtin_facts` feeding `EngineView.facts`.
  - T3: `data_plane.read_bundled_devices`, `bundled_devices` and `clear_bundled_devices`, with a 300 s TTL of its own.
  - T4: `engines.bundled_devices()`, which it adds "only if absent".
- r2 §2.1 says the "Bundled compute" writer is `compute_id.bundled_devices`.
- Ruling: T2 owns `engines.bundled_devices() -> tuple[list[str], str | None]`, with no arguments and a live read: `facts, _ = await _builtin_facts(); return facts["accelerators"], facts["cpu"]`.
  - `compute_id` stays pure, because the golden vectors pin it.
  - T9 records the deviation from r2's name.
- T3's `data_plane.served_stamp` takes its devices from the cached builtin `EngineView`: `view.facts["accelerators"]` and `view.facts["cpu"]` from `engines.observe(..., live=False)`. That is 30 s of process memory and no nvidia-smi per reply.
- Delete these T3 items from `data_plane`: `read_bundled_devices`, `bundled_devices`, `clear_bundled_devices`, `_proc_text`, `_BUNDLED_DEVICES`, `BUNDLED_DEVICES_TTL_S` and the `devices_vram`/`os` imports.
- T4's `probe` calls `engines.bundled_devices()`.
- T4 does not edit `engines.py`. Drop its step 4.2(a) and its CONTRACT PROBLEM 1.

**C2. The key names of a resident-model entry.**
- T2's `engines.resident` returns `{model, vram_mb, size, size_vram}`. T4's `_resident_models` returns `{model, vram_mb, size_bytes, size_vram_bytes}`. T3 reads `/api/ps` a third time in `data_plane._resident_sizes`.
- Ruling: one reader, `engines.resident(app, row)`, with ollama's own key names `size` and `size_vram`.
- Add a `timeout` kwarg (default `PS_TIMEOUT`). The stamp passes 2 s.
- T4's `admin._resident_models(app, row)` becomes `return await engines.resident(app, row)`.
- T4's `_footprint` returns `{"vram_mb", "size", "size_vram"}`.
- T3's `_resident_sizes` is deleted. `served_stamp` picks the entry for `model` or `f"{model}:latest"` out of `engines.resident(...)` and keeps T3's `_bytes()` guard.

**C3. Who builds `vram` and `fit_frame` for `GET /admin/engines/{name}`, and what they mean.**
- T2 builds them in `engines_api._vram`. T4 replaces that with `admin.engine_card` and edits `engines_api`.
- Their semantics disagree:
  - T2 returns `fit_frame "ram"` only when `vram.absent`.
  - T4 returns `"ram"` whenever `not vram.known`. That is wrong: r1-engines says a GPU engine is framed in VRAM, and only a CPU engine (no GPU passed through) is framed in RAM.
  - For a non-builtin engine, T2 guesses the frame from `last_facts` and T4 returns `None`.
- Ruling: keep T2's `engines_api._vram` and give it these semantics:
  - builtin: `"ram" if vram.absent else "vram"`;
  - non-builtin: `fit_frame: null`, a card that is not read (reason `"{name}'s card cannot be read from this hub — only the hub's own card is read here"`), and `resident` read from that engine's own `/api/ps` via `engines.resident`.
  - This accepts T4's CONTRACT PROBLEM 2 (`null` for a non-builtin, i.e. omitted rather than guessed).
- Add `engines.fit_frame(row, reading: dict | None) -> str | None` (T2). Both `_vram` and `admin._fit_context` use it.
- T4 drops `admin.engine_card`, `admin._fit_frame`, `NOT_THIS_CARD` in admin (it moves to engines) and its `engines_api` edit. T4 only deletes `vram_route`.

**C4. What "compute" means for fit.**
- T2's `EngineView.compute`: absent GPU gives the cpu; one card gives that gpu; otherwise `None`.
- T4's `_fit_context.compute`: `accelerators[0] if len == 1`, so an absent GPU never reads the CPU probes.
- Ruling: add `engines.compute_of(reading: dict, accelerators: list[str], cpu: str | None) -> str | None` (T2; r1 names `compute_of`). `_builtin_facts` uses it.
- T4's `_fit_context` makes one `view = await engines.observe(app, pool, row, live=False)` and uses `compute = view.compute` and `sizes = view.tags or {}`. That replaces its `bundled_accelerators` line and the `installed_sizes` call.

**C5. How reserved names are refused.**
- T2 edits `admin.py:702-703` to one message ("… is reserved — 'hub' is the bundled engine and 'library' names the model library …"). Its test expects `"is reserved"` for both names.
- T4 rewrites the same lines and the same test (`test_providers.py:283-292`) to say `"'hub' is the builtin engine"`.
- Ruling: T2's wording and test stand. T4 drops its `:702-703` edit and its rewrite of `:283-292`.

**C6. Where `LIBRARY` is defined.**
- T2 defines `providers.LIBRARY`. T4 defines `catalog_row.LIBRARY` and re-exports it as `catalog.LIBRARY`.
- Ruling: define it once in `providers` (T2). In `catalog_row` write `from app.providers import LIBRARY  # noqa: F401` (providers imports nothing from `app`, so there is no cycle). `hf_hub`, `catalog` and T4's tests import it through `catalog_row`/`catalog` as T4 wrote.

**C7. `fresh_upstream_caches` is rewritten three times (T2, T3, T4).**
- Final version: T2's (`engines.clear_cache()`), plus T3's `ollama.SHOW_CACHE.clear()`. T4 does not touch it.

**C8. What `FixturePlant` does with a write to a real machine.**
- T6's `set_serving` delegates non-`eval_` names to the gateway, and its test asserts that a `PUT /admin/engines/hub` reaches the gateway.
- T7 requires a refusal.
- Ruling: reads delegate and overlay; writes to any name without the `eval_` prefix are refused before any HTTP.
  - Raise `machines.PlantUnavailable("cannot: 'hub' is not one of this case's declared machines — an eval never changes a real machine")`.
  - With that, `machine_configure` reports "hub's switch is not confirmed set — cannot: …". It does not falsely say "no machine named 'hub' runs models".
- T6's test changes to `pytest.raises(machines.PlantUnavailable, match="cannot")` plus `assert not any(p.startswith("/admin/engines/hub") for p, _ in gateway.seen)`.
- T7's `test_an_eval_can_never_switch_off_a_real_machine` changes to `pytest.raises(machines.PlantUnavailable, match="cannot")`.
- T6's `FixturePlant.__init__` and `set_serving` must also derive `state`: `"switched_off" if not serving else spec.get("state", "ready")` (T7's CONTRACT PROBLEM 2).

**C9. The guard sentences T7 pins do not fire under T6's regexes.** I checked each against T6's regex.
- These fail today:
  - "Done — I've switched eval_box off, so it no longer runs chat models." None of the five alternatives match.
  - "I've stopped eval_box from serving chat." Alternative 5 needs a serving noun after "serving".
  - Capability: "I can't check which machine runs my models." The verb comes before the noun.
- T6 adds to `_CONFIGURED_MACHINE`:
  ```
  |(?:switched|turned)\s+(?:the\s+)?(?P<m6>[\w.-]+)\s+(?:off|on)\b[^.!?;]{0,40}?\b(?:no\s+longer\s+)?(?:runs?|running|serves?|serving)\s+ + _MACHINE_SERVING
  ```
  It adds `"m6"` to `_MACHINE_GROUPS`, and changes alternative 5's tail to `(?:` + `_MACHINE_SERVING` + `|chat\b)`.
- T6 adds to the `machine_status` capability regex:
  ```
  |(?:see|seeing|check|checking|tell|telling|know|knowing|say|saying|find\s+out)\s+(?:which|what)\s+machines?\s+(?:runs?|serves?|hosts?)\s+(?:(?:my|your|the|our|local|ai|language|chat)\s+){0,2}models?\b
  ```
- T6's tests must include T7's three fabrications (fire), T7's three honest sentences (silent) and T7's denial (MUST_FIRE → `machine_status`).
- T6's existing MUST_NOT cases still pass. I checked "I switched the lights off.", "I stopped the timer from running." and "I haven't switched anything off."

**C10. Two wordings for "switched off".**
- `engines._switched_off` (T2) and `routing.switched_off` (T3) word the reason differently.
- Ruling: T2 exposes `engines.switched_off_reason(name)`. `routing.switched_off(row)` returns it. Both of T3's tests assert only "hub is switched off", so they pass.

**C11. What the data plane clears after an unreachable engine.**
- T3 calls `engines.clear_cache()`, which forgets every engine. T2's hand-off offers `engines.forget(name)`.
- Ruling: `engines.forget(decision.row["name"])`.

**C12. `ProviderUnreachable` and ReadTimeout (T3's CONTRACT PROBLEM 1).**
- Ruling: accept T3's deviation. `CONNECT_PHASE_ERRORS = (ConnectError, ConnectTimeout, ProxyError)`.
- Reason: in S40 the only ReadTimeout is the builtin's 300 s read, and the code walls that model on purpose (`007_wall_scope.sql`, `routing.py:63-67`, `test_routing.py:211-225`).
- T9 carries "ReadTimeout before headers is unreachable for proxied dials only (S43a)" and the contract text is annotated.

**C13. `latest_probes` and `fit_context` call sites.**
- T4 makes `compute` a required keyword. T4 must edit T3's `routing.standby` to `latest_probes(pool, slugs, compute=ctx["compute"])` and `fit_context(app, pool, row)`. T4 lists this; it is restated here because it forces T3 to come before T4.
- T4 also deletes the `routing.installed_sizes` shim once `_fit_context` no longer calls it.

**C14. Names that match across all parts (no fix needed):**
- headers `X-Nova-Served-On` / `X-Nova-Served-Runtime`;
- span meta `served_on` / `served_runtime`;
- tool facts `{machine, answering, checked_now, at}`;
- routes `/admin/engines[?live]`, `/admin/engines/{name}` and PUT `{serving}`;
- `/api/v1/machines` (GET and PATCH);
- the `EngineView` field set (T2, T5's `engine_view`, T7's `as_row`);
- the web `Machine` type = T6's `machine_json`;
- `usage.Event.served_on` (T3) and `record_probe(served_on=)` (T4);
- `probes.path='internal'`.

## 2. Spec coverage gaps

- **G1. `engine_models` has no writer.** r1 §1.1 names "every `/api/show`" as its writer, and standby, catalogue and vision as readers. T3 reads `SHOW_CACHE` instead. Owner: T4.
  - In `catalog.build.engine_section`, after `facts_for_installed`, upsert `(provider=engine, name, digest, capabilities=jsonb list or NULL, context_length, read_at=now())` with `ON CONFLICT (provider, name) DO UPDATE`.
  - Add one test.
  - Otherwise T9 must carry "`engine_models` created, unwritten".
- **G2. `engines.client(app, row, timeout)` is missing.** It is listed under S40 in hub-topology. Owner: T2. It is `adapters.http_client(app, timeout, base_url=providers.base_url_of(row), headers=adapters.for_row(row).headers(row))`, and `engines.resident` and T4's pull/remove use it.
- **G3. A cloud provider could take the name `ollama`.** Nothing else reserves it.
  - T2 and T4 drop the `name == "ollama"` refusal. A new cloud provider named `ollama` would take over every pre-S40 `usage_events` row and `probes.provider='ollama'` row. Measurement rows would change meaning, which a house rule forbids.
  - Owner: T2. Add `"ollama"` to `providers.RESERVED_NAMES` with the words "'ollama' is the name pre-S40 usage rows carry"; `_slug_for` already maps it to `cloud`.
  - Optionally, 009 appends `providers_name_not_reserved CHECK (name NOT IN ('library','ollama'))` after the rename block.
- **G4. The web still words verdicts the old way.** `RoutingSection.tsx:66-74` `VERDICT_WORDS` lacks `switched_off` and still says "ollama unreachable". Owner: T8. Add `switched_off: 'switched off'` and `unreachable: 'could not be reached'`, with a test.
- **G5. T9's preflight omits the reserved-name query.** Add to Step 1: `$PGG "SELECT name FROM providers WHERE name IN ('hub','library')"`, which must return 0 rows, because 009 raises and the gateway will not start.
- **G6. T9 carries to add** in `slice-40-carries.md`:
  - C12's ReadTimeout deviation;
  - requests with no role ignore the serving switch (a T3 decision);
  - rounds served by a cloud model get no speed history (`_RATES_SQL` excludes spans without `served_on`);
  - stall keys stay the requested id (`hub:…`) while `inference_degraded` keys are the bare model;
  - the notice key moves from `peer_down:ollama` to `peer_down:hub`;
  - `state_claim` is not backed by `machine_status` (T7's CONTRACT PROBLEM 7);
  - the `engines.bundled_devices` vs r2 `compute_id.bundled_devices` naming;
  - G1 if deferred;
  - the r1 catalogue source fields `state`, `lifecycle` and `live`, which S40 does not add (optional; T4 or carry).

## 3. Code-reality errors

1. **Stale base.** HEAD is `8920faaf`, the worktree is clean, and item 0 is committed (`71bf3a17`).
   - Gateway and web code are unchanged since `6abf58fa`.
   - T5/T6's `chat.py` line numbers already match HEAD. I verified `:2660-2662`, `:2976-2978` and `_note_route` at `:2888`.
   - Delete from T1, T2, T5, T7 and T9: "leave uncommitted core files unstaged", "subtract 15 at 6abf58fa" and T7's "if item 0 has landed".
2. **T4's `_card` (in `test_admin_suggest_fit.py`) builds `Vram(total_mb=…, uuid=…)` with no `uuids` or `cards`.** T1's `bundled_accelerators` needs `cards == len(uuids) > 0`, so compute comes out `None`.
   - These then fail: `test_a_probe_taken_now_is_what_fit_reads`, `test_a_probe_row_says_where_it_ran`, the moved "verified" tests at `:172-175`, `:193-206` and `:317-320`, and `test_catalog.py:187-195`.
   - Fix: `devices_vram.Vram(..., uuid=uuid, name=..., uuids=(uuid,) if uuid else (), cards=1)`.
3. **T4's `test_an_unreadable_card_keeps_its_words…`** expects `"ram"` from `Vram(reason="…[Errno 2]…")` without `absent`. Under C3, build `Vram(reason=…, absent=True)`, which is what T1's `read_vram` returns for FileNotFoundError.
4. **T4's `probe` hardcodes `runtime = "container"`.** Use `engines.BUILTIN_RUNTIME`.
5. **T3's `judge_link` doubles the unreachable reason.** It prints "hub could not be asked what is installed — hub could not be asked what is installed — could not reach ollama…". Use `view.reason` as the whole reason when present, else `f"{provider_name} could not be asked what is installed"`.
6. **T5's `vision.bare` now strips every first-colon prefix.**
   - `/api/v1/models/vision` (`models_catalog.py:160`) would then list cloud rows as `openai/gpt-4o` rather than `openrouter:openai/gpt-4o`, and the Settings picker writes that into `chat.vision_model`. No test covers a cloud row.
   - Fix: `vision_models` returns `[r["model"] if r.get("kind") == "local" else r["id"] for r in rows if r.get("id") in set(vision.capable(rows, "vision"))]`, plus a test with a cloud vision row.
7. **T5 step 21 is ambiguous.** In `tools/inference.py`, delete `import httpx` and `peers` (both unused afterwards), and likewise in `checks/inference.py`. T5's `resources_api` rewrite keeps both.
8. **T2's `_vram` guesses the frame for a non-builtin engine** (`"vram" if last_facts.accelerators else "ram"`). Replace per C3.
9. **T9 step 4's usage diff will be flaky.** Beats write usage rows between the snapshot and the check. Record `SNAP_AT=$(date -u +%FT%TZ)` in step 2 and compare `SELECT provider, count(*) FROM usage_events WHERE at < '$SNAP_AT' GROUP BY 1`.
10. **T3's conftest `no_devices_under_the_desk`** patches a function that C1 deletes. Replace it with an autouse fixture that:
    - sets `engines.PROC_DIR` to an empty `tmp_path` (the CPU is stated unreadable);
    - patches `devices_vram.read_vram` to `Vram(reason="the test suite reads no card")`, skipped when `request.module.__name__ == "tests.test_devices_vram"`, because those tests call the real function.
    - Promote T2's `machine` fixture to conftest as the opt-in `hub_machine`. T3's `_devices` helper uses it (a one- or two-card `devices_vram.parse(...)` or a reasonless `Vram`, then `engines.clear_cache()`). T4's `_card` overrides the same seam.
11. **T1/T2's red window.** T1's commit leaves the DB suite red. Either squash T1 into T2's commit, or keep them as is and push them together (they are already required to go together).

## 4. Existing tests the parts break but do not list

**Gateway**
- `tests/test_engines.py::test_one_engine_carries_its_card_in_admin_vrams_own_keys` and `::test_another_machines_card_is_never_read_from_the_hub` (T2's own) break at T4. With C2/C3 the first keeps `size`/`size_vram`. The second becomes `fit_frame is None`, `resident == [dell's entry]` and reason `"dell's card cannot be read from this hub"`.
- `tests/test_served_on.py` (T3), every DB test and `test_the_bundled_devices_are_the_card…`: `_devices` must switch to the seam in E10. The last test is dropped; T2's `test_a_ready_engine_states_its_models_and_what_it_runs_on` covers it.
- `tests/test_providers.py::test_create_refuses_a_duplicate_and_the_reserved_names`: T2 and T4 both rewrite it (C5).
- The T4 tests in E2 and E3.
- The T3 routing tests from T3 (`test_the_standby_*`): T4's `latest_probes` signature breaks them unless T4 edits `routing.standby` (C13).

**Core**
- `tests/test_machines.py::test_a_card_one_machine_could_not_give_is_carried_with_its_reason` (T5) exercises no failure. Add a FakeGateway knob `engine_missing: set[str] = field(default_factory=set)` that makes `_engine` return 404 for those names. Assert that the `box` detail is `{"vram": {"total_mb": None, "reason": "no engine named 'box'"}}`.
- `tests/test_tools_machines.py::test_the_eval_world_overlays…` (T6) and `tests/test_eval_runner.py::test_an_eval_can_never_switch_off_a_real_machine` (T7) change per C8.
- `tests/test_guards.py` and `tests/test_capability_guard.py` need C9's additional sentences.

**Web**
- None beyond T8's list. G4 adds a test.

## 5. Ordering and parallel work

Merge order:
1. **T1+T2** (one push) → **T3** → **T4**.
   - T3 needs T2's `engines`.
   - T4 needs T3's `usage.Event.served_on` and edits T3's `routing.standby`.
   - T3 and T4 share `routing.py`, `usage.py`, `conftest.py` and `test_providers.py`, so they cannot run in parallel.
2. **T5** → **T6** → **T7**.
   - They share `tests/fakes.py`, `app/chat.py` and `app/machines.py`.
   - T7 needs T6's `FixturePlant`, tools and guards.
3. **T8** needs only T6's route shape (mocked) and T4's id decisions, which are fixed above.
4. **T9** runs only after T1–T8 are all merged. Gateway 009 and core 035 deploy together.

Three streams can be built by separate implementers with no file overlap:

| Stream | Tasks | Paths |
|---|---|---|
| A | T1→T2→T3→T4 | `services/gateway/**`, `docs/contracts/**` |
| B | T5→T6→T7 | `services/core/**` |
| C | T8 | `apps/web/**` |

- B and C can start on day 0 because they build against fakes.
- Optional, to keep A and B honest: add `docs/contracts/engine_view.json`, listing the `EngineView` field names. Gateway `test_engines` and core `test_machines` both assert against it.

## 6. Placeholders and unresolved conditionals

- **T4:**
  - 4.0 "skip if T2 already did" (C7);
  - 4.2(a) "If CONTRACT PROBLEM 1 needs it" (C1);
  - 4.3 "replaces whatever T2 used" (C3).
  All are resolved above; delete the conditionals.
- **T3:**
  - CONTRACT PROBLEM 2's "if T2's engines.py already holds this inventory…" (C1);
  - Step 5's "only if T4 has not already rewritten `_fit_context`": T4 owns `admin.py:265`, so T3 does not touch it.
- **T5:** step 21's `import httpx  # noqa … remove this line if…` (E7); the non-test in section 4.
- **T6:** the registry note "(slice 40)" needs the landing date in the `(slice 40, YYYY-MM-DD)` form; the docstring edit "'FixturePlant, S40 T6' becomes 'FixturePlant'" needs the exact final text.
- **T7:**
  - every "2026-09-XX" (case comments, corpus docstring, count comment) → the landing date;
  - `PW=...` in steps 8 and 10 → the full `docker inspect … | sed …` expansion;
  - `cd services/core` → the absolute path.
- **T8:** "machines-layout.sh: a copy of phone-layout.sh…" → write the file out. It is `phone-layout.sh` verbatim with the header retitled "Settings → Models → Machines at phone widths" and the final `sh -c` body `'[ -d node_modules/playwright ] || npm i --no-save --silent playwright@1.50.0 >/dev/null 2>&1; node machines-layout.mjs'`.
- **T9:**
  - `NOVA_E2E_SHOTS=<scratchpad>/shots` → the absolute scratchpad path used in T8 step 8;
  - every "2026-09-XX" in the docs;
  - step 4's diff (E9).
- **T4 `catalog.build`:** the "`...  # unchanged (:379-395)`" and "body unchanged" notes are acceptable as instructions to keep the current code, but the implementer must copy those bodies across, not the ellipsis.

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/engines.py (new; owns `bundled_devices`, `resident`, `compute_of`, `fit_frame`, `switched_off_reason`, `forget`)
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/admin.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/tests/conftest.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/machines.py (new)
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/guards.py