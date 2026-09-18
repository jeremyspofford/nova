# S40 core plan: Tasks 5 and 6

## Notes for the integrator (read before Task 5)

**Preconditions**
- Item 0 is still uncommitted in this worktree: `services/core/app/chat.py`, `pyproject.toml`, `uv.lock`, `tests/test_chat_agents.py`, `tests/test_timers_api.py`, and the new `tests/test_chat_background.py`. Both tasks edit `app/chat.py` and use `git add` by path. Task 5 must start only after item 0 is committed.
- The `chat.py` line numbers below are from the working tree. That tree includes item 0's +15 lines at `:470`, so at HEAD `6abf58fa` subtract 15 from any line after 470.

**How core knows which providers are engines (never a name written in core)**
- (a) Code that classifies a free-standing id (a setting or a tool argument) asks the gateway's `GET /admin/engines` through `app/machines.py` (`plant().engines`, `machines.split`).
- (b) Code that already holds catalogue rows reads the rows. A row with `kind == "local"` is on an engine (`catalog_row.KINDS`). A catalogue id is always `<provider>:<model>` split at the first colon (`catalog_row.base_row`). That rule is only ever applied to catalogue ids, never to a setting's value, because a bare `qwen3.8:27b` has its own colon.
- One consequence: `vision.py`, `models_catalog.py` and `test_vision.py` need no fixture changes at all. They prove the rule is derived because the old `ollama:` fixtures still pass.

**CONTRACT PROBLEM (additive, nothing renamed)**
- The contract gives `GatewayPlant` only `engines` and `set_serving`. `inference_health`, `inference_degraded` and `resources_api` also need one engine's card, so I add `async def engine(self, app, name: str) -> dict` (GET `/admin/engines/{name}`).
- I also add these to `app/machines.py`: `PlantUnavailable(RuntimeError)`, `UnknownMachine(LookupError)`, `split`, `cards` and `machine_json`.

**Cross-part assumptions (T2, T3 and T4 must hold these)**
1. **T4:** the `"vram"` object in `GET /admin/engines/{name}` carries exactly the old `/admin/vram` body keys (`admin.py:188-227`): `total_mb, used_mb, free_mb, util_pct, reason, total_gb, used_gb, free_gb, resident[{model, vram_mb}]|None, resident_reason, free_after_switch_gb`.
2. **T4:** `/admin/pull`, `DELETE /admin/models?model=` and `POST /admin/catalog/drift` accept an engine-qualified id `hub:qwen3:4b`, and also a bare ref, which means the builtin/default engine.
   - Core sends `<engine>:<model>` only when she named a listed engine.
   - Otherwise core sends the bare model. That includes the part after a non-engine prefix such as `library:` or a stale `ollama:`.
3. **T4:** the catalogue keys each engine's source by the engine name (`{"key":"hub",...}`).
   - `stack_chat_model` also falls back to the engine view's state, so a different key only degrades that check to reading engine state.
4. **T2:** `EngineView.reason` is stable text with no clock in it. `stack_ollama` puts it in a fingerprinted finding, so a clock value would re-raise the notice every beat.
5. **T2/T3:** the state values are exactly `ready | unreachable | switched_off | unobserved`. `GET /admin/engines` accepts `?live=true|false`. The 404 body is `{"error": ...}`.
6. **T3:** `judge_link` verdict `switched_off` (worded in core by `tools/route.py`).
7. **T7 consumes** `machines.FixturePlant(fixtures)` and `token = machines.PLANT.set(...)` / `machines.PLANT.reset(token)` around a case replay.

**Deploy note for T9:** core 035 and gateway 009 must go out together. A core that has migrated alone would ask the gateway for `hub:` before the rename exists.

---

### Task 5: core migration 035, where a round ran, keyed speed, the engines reader, and `LOCAL_PROVIDER` generalised

**Files:**
- Create: `services/core/migrations/035_hub_engine.sql`, `services/core/app/machines.py`
- Modify: `services/core/app/chat.py:2658-2663` (`_gateway_round` headers), `:2974-2979` (`_collect_completion` headers), `:2886-2896` (`_note_route`; add `_note_served` after it)
- Modify: `services/core/app/model_speed.py:1-64` (docstring), `:110-192` (`Speed`, `_RATES_SQL`, `_rates`, `speed_of`, `speeds`), plus `Serving` and `latest_serving` appended after `:192`
- Modify: `services/core/app/tools/inference.py:15-20,29-37,132-178`
- Modify: `services/core/app/checks/inference.py:56-67,92-143,192-243`
- Modify: `services/core/app/resources_api.py:23-105`
- Modify: `services/core/app/checks/stack.py:13-18,27-53,141-259,262-331,333-352`
- Modify: `services/core/app/models_catalog.py:1-14,34,38-47`
- Modify: `services/core/app/vision.py:103-185`
- Modify: `services/core/app/tools/models.py:1-17,26,43,436-483,526-587,672-677,789-868`
- Test (create): `tests/test_migration_035_hub_engine.py`, `tests/test_machines.py`, `tests/test_resources_api.py`
- Test (modify): `tests/fakes.py:138-305`, `tests/test_chat_served_by.py` (append), `tests/test_model_speed.py:63-190,226`, `tests/test_tools_inference.py:21-88,240`, `tests/test_checks_inference.py:18-43` (+ append), `tests/test_checks.py:82-96,404-413,450-582` (+ append), `tests/test_models_catalog.py` (append), `tests/test_vision.py` (append), `tests/test_tools_models.py:138-145,257-263,322,452,473-483` (+ append)

**Interfaces:**
- **Consumes (gateway contract):**
  - `GET /admin/engines?live=true|false` → `{"engines":[EngineView]}`
  - `GET /admin/engines/{name}` → EngineView + `{"vram":{...},"fit_frame":"vram"|"ram"}`
  - response headers `X-Nova-Served-By`, `X-Nova-Served-On`, `X-Nova-Served-Runtime`
- **Produces, `app/machines.py`:**
  - `PLANT: ContextVar[GatewayPlant]`
  - `def plant() -> GatewayPlant`
  - `class GatewayPlant` with `async def engines(self, app, *, live: bool) -> list[dict]` and `async def engine(self, app, name: str) -> dict`
  - `class PlantUnavailable(RuntimeError)`, `class UnknownMachine(LookupError)`
  - `def split(model: str, engines: Collection[str]) -> tuple[str | None, str]`
  - `async def cards(app) -> list[tuple[dict, dict | None]]`
- **Produces, `app/model_speed.py`:**
  - `Key = tuple[str, str, str | None]`
  - `Speed(..., served_on: str | None = None, runtime: str | None = None)`
  - `async def speed_of(pool, model: str, served_on: str, runtime: str | None) -> Speed`
  - `async def speeds(pool, model: str | None = None) -> dict[Key, Speed]`
  - `@dataclass(frozen=True) class Serving(engine, model, served_on, runtime)` with `.key`
  - `async def latest_serving(pool, requested: str) -> Serving | None`
- **Produces, `app/chat.py`:** `span.meta["served_on"]` and `span.meta["served_runtime"]`, each only when its header is present (`_note_served(span, headers)`).
- **Produces, `tests/fakes.py`:**
  - `ENGINE_AT`, `ENGINE_GPU`, `def engine_view(name="hub", **over) -> dict`
  - `FakeGateway(served_on=, served_runtime=, engines=, engine_details=)`

- [ ] **Step 0: create this task's scratch DB (one-time)**

  ```bash
  docker exec nova-scratch-pg psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='nova_core_s40_t5'" | grep -q 1 || docker exec nova-scratch-pg createdb -U postgres nova_core_s40_t5
  ```

#### 5.1 Core migration 035

- [ ] **Step 1: write the failing test** `services/core/tests/test_migration_035_hub_engine.py`

  ```python
  """Core migration 035 (S40): the bundled engine is named `hub`.

  Gateway 009 renames the builtin provider `ollama` -> `hub`; a chat setting that
  named the old provider would ask for a provider that no longer exists. Only a
  value that NAMED it moves — a bare id already means "the default provider"."""

  from __future__ import annotations

  from app.main import MIGRATIONS_DIR
  from tests.conftest import requires_db

  pytestmark = requires_db

  MIGRATION = MIGRATIONS_DIR / "035_hub_engine.sql"


  async def _set(pool, key: str, value: str) -> None:
      await pool.execute(
          "INSERT INTO settings (key, value) VALUES ($1, $2) "
          "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
          key,
          value,
      )


  async def _get(pool, key: str):
      return await pool.fetchval("SELECT value FROM settings WHERE key = $1", key)


  async def test_a_setting_that_named_the_old_builtin_names_hub(pool):
      await _set(pool, "chat.model", "ollama:qwen3.8:27b")
      await _set(pool, "chat.vision_model", "ollama:gemma4:12b")
      await pool.execute(MIGRATION.read_text())
      assert await _get(pool, "chat.model") == "hub:qwen3.8:27b"
      assert await _get(pool, "chat.vision_model") == "hub:gemma4:12b"


  async def test_bare_and_cloud_values_are_left_as_the_owner_wrote_them(pool):
      await _set(pool, "chat.model", "qwen3.8:27b")
      await _set(pool, "chat.vision_model", "openrouter:openai/gpt-x")
      await pool.execute(MIGRATION.read_text())
      assert await _get(pool, "chat.model") == "qwen3.8:27b"
      assert await _get(pool, "chat.vision_model") == "openrouter:openai/gpt-x"


  async def test_no_other_key_is_touched(pool):
      await _set(pool, "nova.timezone", "ollama:not-a-model")
      await pool.execute(MIGRATION.read_text())
      assert await _get(pool, "nova.timezone") == "ollama:not-a-model"


  async def test_applied_twice_it_changes_nothing_more(pool):
      await _set(pool, "chat.model", "ollama:qwen3:8b")
      sql = MIGRATION.read_text()
      await pool.execute(sql)
      await pool.execute(sql)
      assert await _get(pool, "chat.model") == "hub:qwen3:8b"


  async def test_the_runner_applies_it(pool):
      names = {r["filename"] for r in await pool.fetch("SELECT filename FROM schema_migrations")}
      assert "035_hub_engine.sql" in names
  ```

- [ ] **Step 2: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t5" uv run pytest tests/test_migration_035_hub_engine.py -q
  ```

  Expected: 5 failed. Four with `FileNotFoundError: .../035_hub_engine.sql`, and `test_the_runner_applies_it` with `AssertionError`.

- [ ] **Step 3: implement** `services/core/migrations/035_hub_engine.sql`

  ```sql
  -- S40 (the hub lane): the bundled engine is named `hub`.
  --
  -- Gateway migration 009 renames the builtin provider row `ollama` -> `hub`
  -- (owner decision 1, 2026-09-18: every model id names the machine that runs
  -- it, and `ollama:` named no machine). A setting holding the old id would
  -- then ask the gateway for a provider that no longer exists, so the two
  -- settings that hold a model id follow the rename here. The literal `hub` is
  -- that rename's mirror: two databases, and no SQL here can ask the other.
  --
  -- Only a value that NAMED the old provider moves. A bare id (`qwen3.8:27b`)
  -- already means "the default provider" and stays as the owner wrote it; a
  -- cloud id (`openrouter:…`) names a provider this knows nothing about.
  -- Nothing else in core stores a model id as configuration: an agent's chain
  -- lives in the gateway's routes (009 rewrites them), and eval_runs /
  -- turn_spans keep `ollama:` because that is what served then — a measurement
  -- row never changes meaning.
  --
  -- Idempotent: a second run finds no value starting `ollama:`.
  UPDATE settings
     SET value = to_jsonb('hub:' || substr(value #>> '{}', length('ollama:') + 1)),
         updated_at = now()
   WHERE key IN ('chat.model', 'chat.vision_model')
     AND jsonb_typeof(value) = 'string'
     AND (value #>> '{}') LIKE 'ollama:%';
  ```

- [ ] **Step 4: run green.** Run the same command as Step 2. Expected: `5 passed`.

#### 5.2 Where a round ran, on its span

- [ ] **Step 5: extend the fake** (test infrastructure, not the implementation)

  In `tests/fakes.py` `FakeGateway`, after `health_status: int = 200` (line 201), add:

  ```python
      # S40: where a served round ran — X-Nova-Served-On / -Runtime on a
      # completion. None sends no header, which is what the gateway does when it
      # cannot tell (a cloud model, more than one accelerator).
      served_on: str | None = None
      served_runtime: str | None = None
  ```

  In `_completions`, replace line 299 (`headers = {"X-Nova-Served-By": self.served_by}`) with:

  ```python
          headers = {"X-Nova-Served-By": self.served_by}
          if self.served_on is not None:
              headers["X-Nova-Served-On"] = self.served_on
          if self.served_runtime is not None:
              headers["X-Nova-Served-Runtime"] = self.served_runtime
  ```

- [ ] **Step 6: write the failing test.** Append to `tests/test_chat_served_by.py`, and add `from types import SimpleNamespace`, `import httpx` and `from app import chat` to its imports.

  ```python
  async def test_the_round_records_where_it_ran_when_the_gateway_says(
      owner_client, mount_peers, pool
  ):
      """S40, D10: the compute id and runtime the gateway stamped go on the
      llm_call span — model_speed keys every rate by them."""
      gateway = FakeGateway(
          deltas=("Hi",),
          served_by="hub:qwen3:8b",
          served_on="gpu:cuda:GPU-8d3c5a2e-7f41-4b8e-9c55-000000000001",
          served_runtime="container",
      )
      mount_peers(gateway=gateway, memory=FakeMemory())
      resp = await owner_client.post("/api/v1/chat/stream", json={"message": "hello"})
      assert resp.status_code == 200
      meta = await pool.fetchval(
          "SELECT meta FROM turn_spans WHERE kind = 'llm_call' ORDER BY started_at LIMIT 1"
      )
      assert meta["served_on"] == "gpu:cuda:GPU-8d3c5a2e-7f41-4b8e-9c55-000000000001"
      assert meta["served_runtime"] == "container"


  async def test_nothing_is_recorded_where_the_gateway_said_nothing(
      owner_client, mount_peers, pool
  ):
      """Omitted, never guessed: a missing header means the gateway could not
      tell, and a guessed compute would file the rate under another machine."""
      gateway = FakeGateway(deltas=("Hi",), served_by="openrouter:openai/gpt-x")
      mount_peers(gateway=gateway, memory=FakeMemory())
      await owner_client.post("/api/v1/chat/stream", json={"message": "hello"})
      meta = await pool.fetchval(
          "SELECT meta FROM turn_spans WHERE kind = 'llm_call' ORDER BY started_at LIMIT 1"
      )
      assert "served_on" not in meta and "served_runtime" not in meta


  def test_note_served_takes_only_what_the_headers_state():
      span = SimpleNamespace(meta={})
      chat._note_served(
          span,
          httpx.Headers(
              {
                  "X-Nova-Served-By": "hub:qwen3:8b",
                  "X-Nova-Served-On": "cpu:intel-n150|4c|16g",
                  "X-Nova-Served-Runtime": "container",
              }
          ),
      )
      assert span.meta == {
          "served_by": "hub:qwen3:8b",
          "served_on": "cpu:intel-n150|4c|16g",
          "served_runtime": "container",
      }
      empty = SimpleNamespace(meta={})
      chat._note_served(empty, httpx.Headers({}))
      assert empty.meta == {}
  ```

- [ ] **Step 7: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t5" uv run pytest tests/test_chat_served_by.py -q
  ```

  Expected failures:
  - `KeyError: 'served_on'` in the first new test.
  - `AttributeError: module 'app.chat' has no attribute '_note_served'` in the unit test.
  - The six existing tests stay green.

- [ ] **Step 8: implement** in `app/chat.py`.

  After `_note_route` (ends line 2896), add:

  ```python
  def _note_served(span, headers) -> None:
      """WHO served this round, and WHERE (S40, D10), off the gateway's headers.

      X-Nova-Served-By is `provider:model`. X-Nova-Served-On is the compute id
      the gateway stamped (`gpu:cuda:<uuid>`, `cpu:<slug>|<n>c|<GiB>g`, joined
      with `+` on a partial offload) and X-Nova-Served-Runtime the runtime it ran
      in. Each is recorded ONLY when the gateway said it: an omitted header means
      the gateway could not tell (more than one accelerator, a cloud model), and
      model_speed keys every rate by these — a guessed compute would file a round
      under a machine it never ran on.
      """
      served_by = headers.get("x-nova-served-by")
      if served_by:
          span.meta["served_by"] = served_by
      served_on = headers.get("x-nova-served-on")
      if served_on:
          span.meta["served_on"] = served_on
      runtime = headers.get("x-nova-served-runtime")
      if runtime:
          span.meta["served_runtime"] = runtime
  ```

  Replace lines 2660-2662 (in `_gateway_round`) with:

  ```python
                      _note_served(span, response.headers)
  ```

  Replace lines 2976-2978 (in `_collect_completion`) the same way. That way judge and redirect rounds are attributed identically.

- [ ] **Step 9: run green.** Run the same command as Step 7. Expected: `9 passed`.

#### 5.3 Speed keyed by (bare model, `served_on`, runtime)

- [ ] **Step 10: move the pinned helper and write the failing tests** in `tests/test_model_speed.py`.

  Replace `_span` (lines 63-81) with:

  ```python
  GPU = "gpu:cuda:GPU-8d3c5a2e-7f41-4b8e-9c55-000000000001"
  CPU = "cpu:intel-n150|4c|16g"
  CONTAINER = "container"


  async def _span(
      pool,
      *,
      model: str,
      rate: float | None,
      hours_ago: float,
      engine: str = "hub",
      served_on: str | None = GPU,
      runtime: str | None = CONTAINER,
      requested: str | None = None,
  ) -> None:
      """One llm_call span, exactly as chat.py files it — since S40 with WHERE
      it ran (chat._note_served): served_by `<engine>:<model>`, served_on,
      served_runtime."""
      turn_id = uuid.uuid4()
      await pool.execute(
          "INSERT INTO turns (id, started_at, status, kind) VALUES ($1, $2, 'ok', 'chat')",
          turn_id,
          datetime.now(UTC) - timedelta(hours=hours_ago),
      )
      meta: dict = {
          "model": requested if requested is not None else model,
          "served_by": f"{engine}:{model}",
      }
      if served_on is not None:
          meta["served_on"] = served_on
      if runtime is not None:
          meta["served_runtime"] = runtime
      if rate is not None:
          meta["tok_per_s"] = rate
      await pool.execute(
          "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
          "VALUES ($1, 'llm_call', $2, $3, 1000, $4)",
          turn_id,
          model,
          datetime.now(UTC) - timedelta(hours=hours_ago),
          meta,
      )
  ```

  Pinned lines that move. Reason: D10 makes a rate a fact about a model on a compute in a runtime, so `speed_of` needs the place and `speeds` is keyed by it.
  - Every `model_speed.speed_of(pool, "<m>")` becomes `model_speed.speed_of(pool, "<m>", GPU, CONTAINER)`. The sites are lines 93, 108, 122, 131, 143, 157, 166, 182 and 226.
  - Lines 177-178:

    ```python
            assert every[("qwen3.8:27b", GPU, CONTAINER)].baseline == 67.5
            assert every[("qwen3:8b", GPU, CONTAINER)].baseline == 120.0
    ```

  - Lines 182-190:

    ```python
        speed = await model_speed.speed_of(pool, "never-run:1b", GPU, CONTAINER)
        assert speed.as_dict() == {
            "model": "never-run:1b",
            "served_on": GPU,
            "runtime": CONTAINER,
            "recent_tok_per_s": None,
            "recent_rounds": 0,
            "baseline_tok_per_s": None,
            "baseline_rounds": 0,
            "ratio": None,
        }
    ```

  Append:

  ```python
  class TestWhereItRan:
      """S40, D10: a rate is a fact about a model ON a compute, in a runtime —
      the N150's 3 tok/s must never be averaged into the 3090's 67."""

      async def test_a_round_the_gateway_could_not_place_is_not_a_measurement(self, pool):
          for _ in range(20):
              await _span(pool, model="qwen3:8b", rate=40.0, hours_ago=48, served_on=None)
          assert await model_speed.speeds(pool) == {}

      async def test_the_same_model_on_two_computes_keeps_two_histories(self, pool):
          for _ in range(20):
              await _span(pool, model="qwen3:8b", rate=120.0, hours_ago=48)
              await _span(pool, model="qwen3:8b", rate=3.0, hours_ago=48, served_on=CPU)
          for _ in range(5):
              await _span(pool, model="qwen3:8b", rate=3.0, hours_ago=0.5, served_on=CPU)
          on_cpu = await model_speed.speed_of(pool, "qwen3:8b", CPU, CONTAINER)
          on_gpu = await model_speed.speed_of(pool, "qwen3:8b", GPU, CONTAINER)
          assert on_cpu.baseline == 3.0 and on_cpu.ratio == 1.0
          assert on_gpu.baseline == 120.0 and on_gpu.recent is None

      async def test_the_runtime_is_part_of_where_it_ran(self, pool):
          for _ in range(10):
              await _span(pool, model="qwen3:8b", rate=100.0, hours_ago=48, runtime="container")
              await _span(pool, model="qwen3:8b", rate=80.0, hours_ago=48, runtime="native")
          every = await model_speed.speeds(pool)
          assert every[("qwen3:8b", GPU, "container")].baseline == 100.0
          assert every[("qwen3:8b", GPU, "native")].baseline == 80.0

      async def test_the_engine_name_is_not_part_of_it(self, pool):
          """The same weights on the same card are one measurement whatever the
          engine is called — what lets a baseline survive the hub move."""
          for _ in range(5):
              await _span(pool, model="qwen3.8:27b", rate=67.5, hours_ago=48, engine="hub")
              await _span(pool, model="qwen3.8:27b", rate=67.5, hours_ago=48, engine="dell")
          speed = await model_speed.speed_of(pool, "qwen3.8:27b", GPU, CONTAINER)
          assert speed.baseline_rounds == 10 and speed.baseline == 67.5

      async def test_the_models_own_colon_survives_the_engine_coming_off(self, pool):
          await _span(pool, model="qwen3.8:27b", rate=67.5, hours_ago=0.5)
          assert set(await model_speed.speeds(pool)) == {("qwen3.8:27b", GPU, CONTAINER)}

      async def test_where_a_requested_model_last_ran_is_its_newest_placed_round(self, pool):
          await _span(pool, model="qwen3:8b", rate=40.0, hours_ago=2, served_on=CPU,
                      requested="hub:qwen3:8b")
          await _span(pool, model="qwen3:8b", rate=100.0, hours_ago=1, requested="hub:qwen3:8b")
          serving = await model_speed.latest_serving(pool, "hub:qwen3:8b")
          assert serving == model_speed.Serving(
              engine="hub", model="qwen3:8b", served_on=GPU, runtime=CONTAINER
          )
          assert serving.key == ("qwen3:8b", GPU, CONTAINER)

      async def test_a_model_never_placed_has_nowhere_it_last_ran(self, pool):
          await _span(pool, model="qwen3:8b", rate=40.0, hours_ago=1, served_on=None,
                      requested="qwen3:8b")
          assert await model_speed.latest_serving(pool, "qwen3:8b") is None
          assert await model_speed.latest_serving(pool, "never-run:1b") is None
  ```

- [ ] **Step 11: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t5" uv run pytest tests/test_model_speed.py -q
  ```

  Expected failures:
  - `TypeError: speed_of() takes 2 positional arguments but 4 were given`
  - `AttributeError: ... 'latest_serving'`
  - `KeyError: ('qwen3.8:27b', ...)`

- [ ] **Step 12: implement** `app/model_speed.py`.

  Append this to the module docstring (after line 63):

  ```
  ## Keyed by where it ran (S40)
  A rate is a fact about a model ON a machine. It was keyed by the model the
  turn ASKED for, which held while one card served everything and is a lie the
  day one model runs on two machines. So a rate is filed under three things the
  gateway stamps on the round: the model that answered, without its engine
  prefix (the same weights on the same card are one measurement whatever the
  engine is called — what lets history survive the hub move); `served_on`, the
  compute id (D10); and the runtime. A round without `served_on` is not counted:
  the gateway omits it exactly when it cannot tell where the round ran, and a
  guessed compute would file a rate under a machine it never ran on. History
  from before S40 is therefore not read, and each (model, compute, runtime)
  builds its own baseline from its first MIN_ROUNDS_BASELINE rounds.
  ```

  Replace lines 110-192 with:

  ```python
  #: What a rate is filed under: (model without its engine prefix, served_on, runtime).
  Key = tuple[str, str, str | None]


  @dataclass(frozen=True)
  class Speed:
      """One model's throughput on one compute. Every field is a fact or a None."""

      model: str
      recent: float | None
      recent_rounds: int
      baseline: float | None
      baseline_rounds: int
      # Where the rounds ran (S40, D10) — part of the identity, not decoration:
      # the same model on another card is another Speed.
      served_on: str | None = None
      runtime: str | None = None

      @property
      def ratio(self) -> float | None:
          """How many times slower than usual, or None when either half is
          unknown. Greater than 1 means slower than this machine's normal."""
          if self.recent is None or not self.baseline:
              return None
          if self.recent <= 0:
              return None
          return round(self.baseline / self.recent, 1)

      def as_dict(self) -> dict:
          return {
              "model": self.model,
              "served_on": self.served_on,
              "runtime": self.runtime,
              "recent_tok_per_s": self.recent,
              "recent_rounds": self.recent_rounds,
              "baseline_tok_per_s": self.baseline,
              "baseline_rounds": self.baseline_rounds,
              "ratio": self.ratio,
          }


  # The model that ANSWERED, without its engine: X-Nova-Served-By is always
  # `<provider>:<model>` (gateway providers.served_by), so its FIRST colon is the
  # provider's — `hub:qwen3.8:27b` -> `qwen3.8:27b`, whose own colon is kept.
  _BARE_SERVED = "substr(meta->>'served_by', strpos(meta->>'served_by', ':') + 1)"

  _RATES_SQL = f"""
      SELECT {_BARE_SERVED} AS model,
             meta->>'served_on' AS served_on,
             meta->>'served_runtime' AS runtime,
             (meta->>'tok_per_s')::float8 AS rate
        FROM turn_spans
       WHERE kind = 'llm_call'
         AND meta ? 'tok_per_s'
         AND meta ? 'served_on'
         AND strpos(meta->>'served_by', ':') > 0
         AND started_at >= now() - ($1 || ' hours')::interval
         AND ($2::text IS NULL OR {_BARE_SERVED} = $2)
  """


  async def _rates(pool: asyncpg.Pool, hours: int, model: str | None) -> dict[Key, list[float]]:
      rows = await pool.fetch(_RATES_SQL, str(hours), model)
      out: dict[Key, list[float]] = {}
      for row in rows:
          if row["model"] and row["served_on"] and row["rate"]:
              key = (row["model"], row["served_on"], row["runtime"])
              out.setdefault(key, []).append(row["rate"])
      return out


  async def speed_of(pool: asyncpg.Pool, model: str, served_on: str, runtime: str | None) -> Speed:
      """One model's recent and baseline medians on one compute, in one runtime."""
      found = (await speeds(pool, model=model)).get((model, served_on, runtime))
      return found or Speed(model, None, 0, None, 0, served_on, runtime)


  async def speeds(pool: asyncpg.Pool, model: str | None = None) -> dict[Key, Speed]:
      """Every (model, compute, runtime) with rounds in the baseline window.

      Two queries, not one per key: a beat check runs over whatever has been
      serving lately and must not turn into a query per name.
      """
      recent = await _rates(pool, RECENT_HOURS, model)
      baseline = await _rates(pool, BASELINE_HOURS, model)
      out: dict[Key, Speed] = {}
      for key in set(recent) | set(baseline):
          name, served_on, runtime = key
          recent_rates = recent.get(key, [])
          baseline_rates = baseline.get(key, [])
          out[key] = Speed(
              model=name,
              recent=(
                  round(statistics.median(recent_rates), 2)
                  if len(recent_rates) >= MIN_ROUNDS_RECENT
                  else None
              ),
              recent_rounds=len(recent_rates),
              baseline=(
                  round(statistics.median(baseline_rates), 2)
                  if len(baseline_rates) >= MIN_ROUNDS_BASELINE
                  else None
              ),
              baseline_rounds=len(baseline_rates),
              served_on=served_on,
              runtime=runtime,
          )
      return out


  @dataclass(frozen=True)
  class Serving:
      """Where a requested model's newest placed round ran."""

      engine: str
      model: str
      served_on: str
      runtime: str | None

      @property
      def key(self) -> Key:
          return (self.model, self.served_on, self.runtime)


  _LATEST_SQL = f"""
      SELECT split_part(meta->>'served_by', ':', 1) AS engine,
             {_BARE_SERVED} AS model,
             meta->>'served_on' AS served_on,
             meta->>'served_runtime' AS runtime
        FROM turn_spans
       WHERE kind = 'llm_call'
         AND meta->>'model' = $1
         AND meta ? 'served_on'
         AND strpos(meta->>'served_by', ':') > 0
         AND started_at >= now() - ($2 || ' hours')::interval
    ORDER BY started_at DESC
       LIMIT 1
  """


  async def latest_serving(pool: asyncpg.Pool, requested: str) -> Serving | None:
      """Where the model a turn ASKS for (chat.model, as the span recorded it)
      last ran within the baseline window, or None when no round of it was ever
      placed. How a caller holding a SETTING finds the Speed to read, without
      parsing an engine out of an id itself."""
      row = await pool.fetchrow(_LATEST_SQL, requested, str(BASELINE_HOURS))
      if row is None or not row["model"] or not row["served_on"]:
          return None
      return Serving(
          engine=row["engine"], model=row["model"], served_on=row["served_on"], runtime=row["runtime"]
      )
  ```

  **Do not merge this step without 5.5-5.7.** `tools/inference.py:152` and `resources_api.py:92-93` call the old signature. They are fixed in Steps 21-29 before the commit at Step 30.

- [ ] **Step 13: run green.** Run the same command as Step 11. Expected: `31 passed`.

#### 5.4 `app/machines.py`, core's one reader of the engines

- [ ] **Step 14: extend the fake.** In `tests/fakes.py`:

  After `_sse` (line 139-140), add:

  ```python
  # S40: one engine exactly as the gateway's GET /admin/engines lists it
  # (services/gateway/app/engines.py EngineView). A mirror, not an invention: a
  # test that needs another state says so by name, over these defaults.
  ENGINE_AT = "2026-09-18T10:00:00+00:00"
  ENGINE_GPU = "gpu:cuda:GPU-8d3c5a2e-7f41-4b8e-9c55-000000000001"


  def engine_view(name: str = "hub", **over) -> dict:
      view = {
          "name": name,
          "lifecycle": "always_on",
          "serving": True,
          "state": "ready",
          "reason": None,
          "observed_at": ENGINE_AT,
          "tags": {"qwen3:8b": 5_225_388_164},
          "tags_as_of": ENGINE_AT,
          "compute": ENGINE_GPU,
          "runtime": "container",
          "facts": {},
      }
      view.update(over)
      return view
  ```

  `FakeGateway` fields, after the `served_runtime` field added in Step 5:

  ```python
      # S40: the engines GET /admin/engines lists (EngineView dicts, see
      # engine_view), and per name the detail-only keys GET /admin/engines/{name}
      # adds (vram, fit_frame). None falls back to the admin echo, like the
      # catalogue — a body that names no engines.
      engines: list[dict] | None = None
      engine_details: dict[str, dict] = field(default_factory=dict)
  ```

  Add to the routes list (after line 238):

  ```python
                  Route("/admin/engines", self._engines, methods=["GET"]),
                  Route("/admin/engines/{name}", self._engine, methods=["GET"]),
  ```

  Add handlers after `_catalog`:

  ```python
      async def _engines(self, request):
          if self.engines is None:
              return await self._admin(request)
          await self._record(request)
          if not _bearer_ok(request, GATEWAY_TOKEN):
              return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
          return JSONResponse({"engines": self.engines})

      async def _engine(self, request):
          if self.engines is None:
              return await self._admin(request)
          await self._record(request)
          if not _bearer_ok(request, GATEWAY_TOKEN):
              return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
          name = request.path_params["name"]
          view = next((e for e in self.engines if e["name"] == name), None)
          if view is None:
              return JSONResponse({"error": f"no engine named {name!r}"}, status_code=404)
          return JSONResponse({**view, **self.engine_details.get(name, {})})
  ```

- [ ] **Step 15: write the failing test** `tests/test_machines.py`

  ```python
  """app/machines.py — core's one reader of the gateway's engines (S40).

  Which providers are engines is the gateway's to say: nothing here names one.
  Every failure to ask is a stated PlantUnavailable, never an empty list that
  reads as "no machines"."""

  from __future__ import annotations

  import httpx
  import pytest

  from app import machines
  from app.main import app as core_app
  from tests import fakes
  from tests.fakes import FakeGateway

  CARD = {
      "total_mb": 24576.0, "used_mb": 2662.0, "free_mb": 21914.0, "util_pct": 3.0,
      "reason": None, "resident": [], "resident_reason": None, "free_after_switch_gb": 21.4,
  }


  class _Dead(httpx.AsyncBaseTransport):
      async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
          raise httpx.ConnectError("connection refused", request=request)


  async def test_the_list_is_the_gateways_own_and_says_whether_it_was_read_live(mount_peers):
      gateway = FakeGateway(engines=[fakes.engine_view()])
      mount_peers(gateway=gateway)
      assert await machines.plant().engines(core_app, live=False) == [fakes.engine_view()]
      assert gateway.seen[-1][0] == "/admin/engines" and gateway.queries[-1] == b"live=false"
      await machines.plant().engines(core_app, live=True)
      assert gateway.queries[-1] == b"live=true"


  async def test_a_body_that_names_no_engines_is_a_failure_never_an_empty_list(mount_peers):
      mount_peers(gateway=FakeGateway())  # engines=None: the admin echo, {"gpus": []}
      with pytest.raises(machines.PlantUnavailable, match="did not name its engines"):
          await machines.plant().engines(core_app, live=False)


  async def test_an_unreachable_or_unconfigured_gateway_is_stated(mount_peers, monkeypatch):
      mount_peers(gateway=FakeGateway(engines=[]))
      core_app.state.peer_transports[fakes.GATEWAY_URL] = _Dead()
      with pytest.raises(machines.PlantUnavailable, match="could not be reached — ConnectError"):
          await machines.plant().engines(core_app, live=False)
      monkeypatch.delenv("GATEWAY_URL")
      with pytest.raises(machines.PlantUnavailable, match="not configured"):
          await machines.plant().engines(core_app, live=False)


  async def test_one_engine_in_full_and_an_unknown_name_is_its_own_error(mount_peers):
      gateway = FakeGateway(
          engines=[fakes.engine_view()],
          engine_details={"hub": {"vram": CARD, "fit_frame": "vram"}},
      )
      mount_peers(gateway=gateway)
      detail = await machines.plant().engine(core_app, "hub")
      assert detail["name"] == "hub" and detail["vram"] == CARD and detail["fit_frame"] == "vram"
      with pytest.raises(machines.UnknownMachine, match="no engine named 'dell'"):
          await machines.plant().engine(core_app, "dell")


  def test_split_reads_a_machine_only_when_the_gateway_lists_one():
      engines = frozenset({"hub", "dell"})
      assert machines.split("hub:qwen3.8:27b", engines) == ("hub", "qwen3.8:27b")
      assert machines.split("dell:qwen3:8b", engines) == ("dell", "qwen3:8b")
      assert machines.split("qwen3.8:27b", engines) == (None, "qwen3.8:27b")
      assert machines.split("qwen3:8b", engines) == (None, "qwen3:8b")
      assert machines.split("openrouter:openai/gpt-x", engines) == (
          None, "openrouter:openai/gpt-x"
      )


  async def test_cards_never_wake_a_machine_that_sleeps_to_read_it(mount_peers):
      gateway = FakeGateway(
          engines=[
              fakes.engine_view(),
              fakes.engine_view("dell", lifecycle="wake_on_lan", state="unobserved",
                                observed_at=None),
          ],
          engine_details={"hub": {"vram": CARD, "fit_frame": "vram"}},
      )
      mount_peers(gateway=gateway)
      pairs = await machines.cards(core_app)
      assert [(view["name"], detail is not None) for view, detail in pairs] == [
          ("hub", True), ("dell", False),
      ]
      assert pairs[0][1]["vram"] == CARD
      assert "/admin/engines/dell" not in [path for path, _ in gateway.seen]
      assert gateway.queries[0] == b"live=false"


  async def test_a_card_one_machine_could_not_give_is_carried_with_its_reason(mount_peers):
      gateway = FakeGateway(engines=[fakes.engine_view(), fakes.engine_view("box")])
      mount_peers(gateway=gateway)
      gateway.engines.pop()  # listed, then gone before its own read: a 404
      gateway.engines.append(fakes.engine_view("hub2"))
      pairs = await machines.cards(core_app)
      assert [view["name"] for view, _ in pairs] == ["hub", "hub2"]
  ```

  The last test only proves one failed read does not drop the list. `cards` reads the list once, then one detail per listed view.

- [ ] **Step 16: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t5" uv run pytest tests/test_machines.py -q
  ```

  Expected: collection error `ImportError: cannot import name 'machines' from 'app'`.

- [ ] **Step 17: implement** `services/core/app/machines.py`

  ```python
  """The machines that run models — core's one reader of the gateway's engines (S40).

  An ENGINE is a provider the gateway serves models through with the ollama
  adapter (gateway app/engines.py); the bundled one is `hub`, and S44 adds one
  per machine. The gateway owns every fact about one — lifecycle, the serving
  switch, whether it answered and when, what is installed, what it computes
  on — and core stores none of them. It asks, here, so there is one shape for
  the answer and one place a failure to ask is stated.

  HOW CORE KNOWS WHICH PROVIDERS ARE ENGINES — never a name written in core:

    * code that classifies a free-standing id (a setting, a tool argument) asks
      this module for the gateway's list: `hub:qwen3:8b` names a machine only
      because `hub` is in it (`split`);
    * code that already holds catalogue rows reads the rows instead, which
      needs no second call: a `kind: local` row is on an engine, and a
      catalogue id is always `<provider>:<model>` split at its FIRST colon.

  `PLANT` says which reader a task talks to. A ContextVar, so an eval replay
  can put its own `eval_*` machines in front of the real list for its own task
  and nothing else in the process sees them.
  """

  from __future__ import annotations

  from collections.abc import Collection
  from contextvars import ContextVar
  from urllib.parse import quote

  import httpx

  from app import peers

  ENGINES_PATH = "/admin/engines"
  # One read of a short list or of one machine's card: the gateway answers from
  # its per-engine cache (ready 30 s, failure 10 s) or one bounded observation.
  TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)


  class PlantUnavailable(RuntimeError):
      """The gateway could not be asked, refused, or answered something that is
      not what was asked for. The message is the reason, in words — a caller
      states it; it never reads it as "no machines"."""


  class UnknownMachine(LookupError):
      """No engine by that name (the gateway's 404, in its own words)."""


  def _error_of(response: httpx.Response) -> str:
      try:
          body = response.json()
      except ValueError:
          body = None
      if isinstance(body, dict) and body.get("error"):
          return str(body["error"])
      return f"{response.status_code} {response.reason_phrase}".strip()


  def _engine_path(name: str) -> str:
      return f"{ENGINES_PATH}/{quote(name, safe='')}"


  class GatewayPlant:
      """The real machines, as the gateway reads them."""

      async def _request(self, app, method: str, path: str, **kwargs) -> httpx.Response:
          try:
              async with peers.client(app, peers.GATEWAY, TIMEOUT) as client:
                  return await client.request(method, path, **kwargs)
          except peers.PeerUnconfigured as exc:
              raise PlantUnavailable(f"the gateway link is not configured — {exc}") from exc
          except httpx.HTTPError as exc:
              raise PlantUnavailable(
                  f"the gateway could not be reached — {peers.reason(exc)}"
              ) from exc

      @staticmethod
      def _object(response: httpx.Response, what: str) -> dict:
          try:
              body = response.json()
          except ValueError as exc:
              raise PlantUnavailable(f"the gateway's {what} was not JSON") from exc
          if not isinstance(body, dict):
              raise PlantUnavailable(f"the gateway's {what} was not an object")
          return body

      async def engines(self, app, *, live: bool) -> list[dict]:
          """Every engine, builtin first. `live` asks the gateway to observe each
          one now instead of answering from its cache."""
          response = await self._request(
              app, "GET", ENGINES_PATH, params={"live": "true" if live else "false"}
          )
          if response.status_code != 200:
              raise PlantUnavailable(f"the gateway refused {ENGINES_PATH} — {_error_of(response)}")
          found = self._object(response, "engine list").get("engines")
          if not isinstance(found, list) or not all(
              isinstance(view, dict) and isinstance(view.get("name"), str) and view["name"]
              for view in found
          ):
              raise PlantUnavailable("the gateway's engine list did not name its engines")
          return found

      async def engine(self, app, name: str) -> dict:
          """One engine in full: its view plus its card (`vram`, `fit_frame`)."""
          path = _engine_path(name)
          response = await self._request(app, "GET", path)
          if response.status_code == 404:
              raise UnknownMachine(_error_of(response))
          if response.status_code != 200:
              raise PlantUnavailable(f"the gateway refused {path} — {_error_of(response)}")
          return self._object(response, f"reading of {name}")


  PLANT: ContextVar[GatewayPlant] = ContextVar("machines_plant", default=GatewayPlant())


  def plant() -> GatewayPlant:
      """The reader this task talks to: the gateway, or an eval's overlay."""
      return PLANT.get()


  def split(model: str, engines: Collection[str]) -> tuple[str | None, str]:
      """(machine, the rest) when `model` names one of `engines` before its
      first colon; (None, model) otherwise. `qwen3.8:27b` and `qwen3:8b` keep
      their own colon: only the gateway's list can tell a machine from a name."""
      head, sep, rest = model.partition(":")
      if sep and rest and head in engines:
          return head, rest
      return None, model


  async def cards(app) -> list[tuple[dict, dict | None]]:
      """Every engine with its full reading (the card: `vram`, `fit_frame`) —
      or None for a machine that sleeps on its own and is not answering now,
      which is never woken just to be read.

      A reading one machine could not give is carried as a reading with its
      reason (`vram.reason`), never as a missing machine: the others still
      answered. Only the LIST failing raises (PlantUnavailable)."""
      reader = plant()
      out: list[tuple[dict, dict | None]] = []
      for view in await reader.engines(app, live=False):
          if view.get("lifecycle") == "wake_on_lan" and view.get("state") != "ready":
              out.append((view, None))
              continue
          try:
              detail = await reader.engine(app, view["name"])
          except (PlantUnavailable, UnknownMachine) as exc:
              detail = {**view, "vram": {"total_mb": None, "reason": str(exc)}}
          out.append((view, detail))
      return out
  ```

- [ ] **Step 18: run green.** Run the same command as Step 16. Expected: `7 passed`.

#### 5.5 `inference_health` reads `/admin/engines`

- [ ] **Step 19: move the pinned fake and write the failing tests** in `tests/test_tools_inference.py`.

  Add `from tests import fakes` and `from tests.fakes import FakeGateway` to the imports.

  Replace `_Gateway` (lines 48-56) with:

  ```python
  class _Gateway:
      """The two routes this tool reads (S40: the engine list and one engine's
      card; /admin/vram is gone), as a local ASGI stand-in. `mount_peers` takes
      an object carrying `.app`, the same shape tests/fakes.py uses."""

      def __init__(self, body: dict, status: int = 200) -> None:
          async def listing(_request):
              return JSONResponse({"engines": [fakes.engine_view()]})

          async def card(_request):
              return JSONResponse(
                  {**fakes.engine_view(), "vram": body, "fit_frame": "vram"}, status_code=status
              )

          self.app = Starlette(
              routes=[
                  Route("/admin/engines", listing, methods=["GET"]),
                  Route("/admin/engines/{name}", card, methods=["GET"]),
              ]
          )
  ```

  In `_rounds` (lines 72-88), replace the meta literal `{"model": model, "tok_per_s": rate}` with:

  ```python
              {
                  "model": model,
                  "served_by": f"hub:{model}",
                  "served_on": fakes.ENGINE_GPU,
                  "served_runtime": "container",
                  "tok_per_s": rate,
              },
  ```

  At line 240, `Route("/admin/vram", boom, methods=["GET"])` becomes `Route("/admin/engines", boom, methods=["GET"])`.

  Append:

  ```python
  async def test_every_machines_card_is_named(ask):
      said = await ask(CARD)
      assert said.startswith("hub: The card has 21.4 GB free of 24.0 GB")


  async def test_a_machine_that_sleeps_on_its_own_is_not_woken_to_read_its_card(
      mount_peers, pool
  ):
      gateway = FakeGateway(
          engines=[
              fakes.engine_view(),
              fakes.engine_view("dell", lifecycle="wake_on_lan", state="unobserved"),
          ],
          engine_details={"hub": {"vram": CARD, "fit_frame": "vram"}},
      )
      mount_peers(gateway=gateway)
      said = await tools.REGISTRY["inference_health"].executor(
          {}, tools.context_for(core_app, _owner())
      )
      assert "dell: its card was not read — it is unobserved" in said
      assert "/admin/engines/dell" not in [path for path, _ in gateway.seen]
  ```

- [ ] **Step 20: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t5" uv run pytest tests/test_tools_inference.py -q
  ```

  Expected: every `ask`-based test fails, because the tool still GETs `/admin/vram`, which returns 404, which becomes a `ToolFailure` saying "could not be asked about the GPU". The speed tests fail with `TypeError: speed_of()`.

- [ ] **Step 21: implement** `app/tools/inference.py`.

  Lines 15-20 of the docstring become:

  ```
  ## One read, no arguments
  Every machine's card and resident table come from the gateway's engine
  readings (GET /admin/engines, then /admin/engines/{name}, through
  app/machines.py — core has no route to a GPU of its own; /admin/vram is gone
  since S40); the throughput comes from the `llm_call` spans, keyed by where
  the chat model's rounds last ran (model_speed.latest_serving).
  ```

  Lines 31-37 become:

  ```python
  import httpx  # noqa: F401  (kept out: remove this line if nothing else imports httpx here)
  ```

  Delete that `httpx` import instead if nothing else in the file uses it. After the change the import block is:

  ```python
  from app import db, machines, model_speed, settings_store
  from app.tools.base import Tool, ToolContext, ToolFailure
  ```

  `VRAM_PATH` and `VRAM_TIMEOUT` are deleted.

  Replace `inference_health` (132-156) with:

  ```python
  async def inference_health(_args: dict, ctx: ToolContext) -> str:
      """Every machine's card, what is on it, and how fast the chat model is going."""
      pool = await db.get_pool()
      try:
          pairs = await machines.cards(ctx.app)
      except machines.PlantUnavailable as exc:
          # A stated refusal, in the Error: shape every tool uses when a call
          # CANNOT run. Not a guess about the card, and not a silent empty.
          raise ToolFailure(f"the gateway could not be asked about the GPU — {exc}") from exc

      lines: list[str] = []
      if not pairs:
          lines.append("The gateway lists no machine that runs models, so there is no card to read.")
      for view, detail in pairs:
          if detail is None:
              lines.append(
                  f"{view['name']}: its card was not read — it is {view.get('state')}, and a "
                  "machine that sleeps on its own is never woken just to be read."
              )
              continue
          vram = detail.get("vram") if isinstance(detail.get("vram"), dict) else {}
          lines.append(f"{view['name']}: " + " ".join(_card_lines(vram)))

      model = await settings_store.read_value(pool, "chat.model")
      if model:
          factor = await settings_store.read_value(pool, "inference.degraded_factor")
          stall = (await model_speed.stalls(pool)).get(model)
          # Where the chat model's rounds last ran decides which history is its
          # normal (S40, D10) — the same model on another card is another Speed.
          serving = await model_speed.latest_serving(pool, model)
          speed = (
              await model_speed.speed_of(pool, *serving.key)
              if serving is not None
              else model_speed.Speed(model, None, 0, None, 0)
          )
          lines.extend(_speed_lines(speed, factor, stall))
      else:
          lines.append("No chat model is configured, so there is no throughput to report.")

      return " ".join(lines)
  ```

  The description (lines 162-169) becomes:

  ```python
          description=(
              "How the GPU is doing right now on every machine that runs models: how much "
              "VRAM is free of the card's total, which models ollama is holding and how big "
              "they are, whether something other than ollama is using the card, and how fast "
              "the chat model is generating compared with its usual speed where it runs. Use "
              "it when a reply is taking a long time, when asked why things are slow, before "
              "starting something heavy, or when asked what is on the GPU."
          ),
  ```

- [ ] **Step 22: run green.** Run the same command as Step 20. Expected: `16 passed`.

#### 5.6 `inference_degraded` reads the machine's card and the keyed speeds

- [ ] **Step 23: move the pinned helper and write the failing tests** in `tests/test_checks_inference.py`.

  Add `from tests import fakes` to the imports.

  Replace `_rounds` (27-43) with:

  ```python
  GPU = fakes.ENGINE_GPU
  CPU = "cpu:intel-n150|4c|16g"


  async def _rounds(
      pool, *, model: str, rate: float, count: int, hours_ago: float,
      served_on: str | None = GPU, runtime: str = "container",
  ) -> None:
      """Rounds as chat.py files them since S40: with where they ran. A round
      the gateway could not place carries no served_on and is not measured."""
      for _ in range(count):
          turn_id = uuid.uuid4()
          when = datetime.now(UTC) - timedelta(hours=hours_ago)
          await pool.execute(
              "INSERT INTO turns (id, started_at, status, kind) VALUES ($1, $2, 'ok', 'chat')",
              turn_id,
              when,
          )
          meta: dict = {"model": model, "served_by": f"hub:{model}",
                        "served_runtime": runtime, "tok_per_s": rate}
          if served_on is not None:
              meta["served_on"] = served_on
          await pool.execute(
              "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
              "VALUES ($1, 'llm_call', $2, $3, 1000, $4)",
              turn_id,
              model,
              when,
              meta,
          )
  ```

  Append:

  ```python
  async def test_the_finding_names_where_the_rounds_ran(pool, card):
      await _healthy_history(pool)
      await _rounds(pool, model="qwen3.8:27b", rate=0.25, count=5, hours_ago=0.5)
      finding = (await inference.degraded(core_app, pool))[0]
      assert finding.key == "inference_degraded:qwen3.8:27b"
      assert finding.facts["served_on"] == GPU and finding.facts["runtime"] == "container"


  async def test_one_model_slow_on_two_computes_is_one_finding_the_worse_one(pool, card):
      await _rounds(pool, model="qwen3:8b", rate=100.0, count=20, hours_ago=48)
      await _rounds(pool, model="qwen3:8b", rate=10.0, count=20, hours_ago=48, served_on=CPU)
      await _rounds(pool, model="qwen3:8b", rate=1.0, count=5, hours_ago=0.5)
      await _rounds(pool, model="qwen3:8b", rate=1.0, count=5, hours_ago=0.5, served_on=CPU)
      findings = await inference.degraded(core_app, pool)
      assert [f.key for f in findings] == ["inference_degraded:qwen3:8b"]
      assert findings[0].facts["served_on"] == GPU  # 100x on the GPU beats 10x on the CPU


  async def test_rounds_the_gateway_could_not_place_are_never_compared(pool, card):
      await _rounds(pool, model="qwen3:8b", rate=100.0, count=20, hours_ago=48, served_on=None)
      await _rounds(pool, model="qwen3:8b", rate=1.0, count=5, hours_ago=0.5, served_on=None)
      with pytest.raises(CannotCheck):
          await inference.degraded(core_app, pool)


  VRAM = {
      "total_mb": 24576.0, "used_mb": 24166.4, "free_mb": 409.6, "util_pct": 99.0,
      "reason": None, "resident": [{"model": "qwen3.8:27b", "vram_mb": 17203.2}],
      "resident_reason": None, "free_after_switch_gb": 17.2,
  }


  async def test_the_card_is_read_from_the_machine_the_gateway_lists(mount_peers):
      mount_peers(
          gateway=FakeGateway(
              engines=[fakes.engine_view()],
              engine_details={"hub": {"vram": VRAM, "fit_frame": "vram"}},
          ),
          memory=FakeMemory(),
      )
      card = await inference._card_facts(core_app)
      assert card["free_gb"] == 17.2 and card["util_pct"] == 99.0
      assert card["facts"] == {
          "free_vram_gb": 17.2, "non_ollama_vram_gb": 6.8, "gpu_utilisation_pct": 99,
      }


  async def test_two_readable_cards_are_not_guessed_between(mount_peers):
      mount_peers(
          gateway=FakeGateway(
              engines=[fakes.engine_view(), fakes.engine_view("box")],
              engine_details={"hub": {"vram": VRAM}, "box": {"vram": VRAM}},
          ),
          memory=FakeMemory(),
      )
      card = await inference._card_facts(core_app)
      assert card["free_gb"] is None and "2 machines report a card" in card["reason"]
  ```

- [ ] **Step 24: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t5" uv run pytest tests/test_checks_inference.py -q
  ```

  Expected failures:
  - `KeyError: 'served_on'` in the facts.
  - Two findings instead of one in the two-compute test.
  - The card tests get `free_gb None`, because `_card_facts` still GETs `/admin/vram` and the fake 404s it.

- [ ] **Step 25: implement** `app/checks/inference.py`.

  Lines 58-67 become:

  ```python
  from app import machines, model_speed, settings_store
  from app.checks import CannotCheck, Check, Finding

  DEGRADED_FACTOR_KEY = "inference.degraded_factor"
  ```

  `import httpx`, `peers`, `VRAM_PATH` and `VRAM_TIMEOUT` are deleted.

  In `_card_facts`, replace lines 104-114 (from `blank = ...` through `body = resp.json()`) with:

  ```python
      blank = {"free_gb": None, "others_gb": None, "util_pct": None, "reason": None, "facts": {}}
      try:
          pairs = await machines.cards(app)
      except machines.PlantUnavailable as exc:
          return {**blank, "reason": f"the gateway could not be asked about the card — {exc}"}
      # The card of THE machine: while one machine's card can be read, it is the
      # card these rounds ran on. Two are never guessed between — which one
      # served is a match of served_on to a machine's compute, not made here.
      read = [detail for _view, detail in pairs if detail is not None]
      if len(read) != 1:
          reason = (
              "the gateway lists no machine whose card could be read"
              if not read
              else f"{len(read)} machines report a card, and which one ran these rounds "
              "is not matched here"
          )
          return {**blank, "reason": reason}
      body = read[0].get("vram") if isinstance(read[0].get("vram"), dict) else {}
  ```

  Lines 115-143 are unchanged.

  In `degraded`, replace lines 202-243 with:

  ```python
      hard_stops = [s for s in stalled.values() if s.walled >= model_speed.MIN_STALLED_ROUNDS]
      comparable = [s for s in speeds.values() if s.ratio is not None]
      slow = [s for s in comparable if s.ratio >= factor]
      # ONE finding per MODEL — the worst of the computes it is slow on (S40:
      # a Speed is per (model, served_on, runtime)) — so the notice keeps one
      # key per model and the compute it was measured on rides in the facts.
      worst: dict[str, model_speed.Speed] = {}
      for speed in slow:
          if speed.model not in worst or speed.ratio > worst[speed.model].ratio:
              worst[speed.model] = speed

      if not comparable and not hard_stops:
          raise CannotCheck(
              "no model has both recent rounds and enough history to compare them against, "
              "and none has stalled — nothing to measure (needs "
              f"{model_speed.MIN_ROUNDS_RECENT} rounds in the last "
              f"{model_speed.RECENT_HOURS} h and {model_speed.MIN_ROUNDS_BASELINE} in the last "
              f"{model_speed.BASELINE_HOURS // 24} days on one compute, or "
              f"{model_speed.MIN_STALLED_ROUNDS} rounds that produced nothing)"
          )
      if not worst and not hard_stops:
          return []

      card = await _card_facts(app)
      findings = [
          _stalled_finding(stall, card) for stall in sorted(hard_stops, key=lambda s: -s.walled)
      ]
      free_gb, vram_reason = card["free_gb"], card["reason"]
      for speed in sorted(worst.values(), key=lambda s: -s.ratio):
          facts: dict = {
              "model": speed.model,
              # Where it ran (D10): stable per machine, so it changes the
              # fingerprint only when the compute does — which IS new news.
              "served_on": speed.served_on,
              "runtime": speed.runtime,
              # The bucket, not the rate — see `_bucket`.
              "slowdown_bucket": _bucket(speed.ratio),
          }
          facts["recent_tok_per_s"] = speed.recent
          facts["baseline_tok_per_s"] = speed.baseline
          facts["recent_rounds"] = speed.recent_rounds
          facts["baseline_rounds"] = speed.baseline_rounds
          facts.update(card["facts"])
          if free_gb is None:
              facts["free_vram_reason"] = vram_reason
          findings.append(
              Finding(
                  key=f"inference_degraded:{speed.model}",
                  title=_title(speed, card),
                  facts=facts,
              )
          )
      return findings
  ```

- [ ] **Step 26: run green.** Run the same command as Step 24. Expected: `26 passed`.

#### 5.7 The resources panel reads `/admin/engines`

- [ ] **Step 27: write the failing test** `tests/test_resources_api.py`

  ```python
  """GET /api/v1/system/resources (S40): the card is the machine's own reading,
  the throughput is the chat model's speed WHERE it last ran."""

  from __future__ import annotations

  import uuid
  from datetime import UTC, datetime, timedelta

  from tests import fakes
  from tests.conftest import requires_db
  from tests.fakes import FakeGateway

  pytestmark = requires_db

  CARD = {
      "total_mb": 24576.0, "used_mb": 2662.0, "free_mb": 21914.0, "util_pct": 7.0,
      "reason": None, "total_gb": 24.0, "used_gb": 2.6, "free_gb": 21.4,
      "resident": [{"model": "qwen3.8:27b", "vram_mb": 1024.0}],
      "resident_reason": None, "free_after_switch_gb": 22.4,
  }


  async def _round(pool, *, rate: float, hours_ago: float, served_on=fakes.ENGINE_GPU) -> None:
      turn_id = uuid.uuid4()
      when = datetime.now(UTC) - timedelta(hours=hours_ago)
      await pool.execute(
          "INSERT INTO turns (id, started_at, status, kind) VALUES ($1, $2, 'ok', 'chat')",
          turn_id, when,
      )
      meta: dict = {"model": "hub:qwen3.8:27b", "served_by": "hub:qwen3.8:27b",
                    "served_runtime": "container", "tok_per_s": rate}
      if served_on is not None:
          meta["served_on"] = served_on
      await pool.execute(
          "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
          "VALUES ($1, 'llm_call', 'hub:qwen3.8:27b', $2, 1000, $3)",
          turn_id, when, meta,
      )


  async def _chat_model(owner_client) -> None:
      resp = await owner_client.put(
          "/api/v1/settings", json={"key": "chat.model", "value": "hub:qwen3.8:27b"}
      )
      assert resp.status_code == 200


  async def test_the_card_is_the_machines_and_the_speed_is_where_the_model_ran(
      owner_client, mount_peers, pool
  ):
      mount_peers(
          gateway=FakeGateway(
              engines=[fakes.engine_view()],
              engine_details={"hub": {"vram": CARD, "fit_frame": "vram"}},
          )
      )
      await _chat_model(owner_client)
      for _ in range(10):
          await _round(pool, rate=67.5, hours_ago=48)
      for _ in range(3):
          await _round(pool, rate=60.0, hours_ago=0.5)

      body = (await owner_client.get("/api/v1/system/resources")).json()

      assert body["card"] == {
          "machine": "hub", "free_gb": 21.4, "total_gb": 24.0, "used_gb": 2.6,
          "utilisation_pct": 7.0, "non_ollama_gb": 1.6,
          "resident": [{"model": "qwen3.8:27b", "vram_gb": 1.0}], "reason": None,
      }
      assert body["throughput"] == {
          "model": "qwen3.8:27b", "served_on": fakes.ENGINE_GPU, "runtime": "container",
          "recent_tok_per_s": 60.0, "recent_rounds": 3, "baseline_tok_per_s": 67.5,
          "baseline_rounds": 13, "ratio": 1.1,
      }


  async def test_a_gateway_that_names_no_engines_is_a_stated_blank(owner_client, mount_peers):
      mount_peers(gateway=FakeGateway())
      body = (await owner_client.get("/api/v1/system/resources")).json()
      assert body["card"] == {
          "reason": "the gateway could not be asked — the gateway's engine list did not name "
          "its engines"
      }
      assert body["throughput"] is None


  async def test_a_model_never_placed_on_a_compute_has_no_throughput_not_a_zero(
      owner_client, mount_peers, pool
  ):
      mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
      await _chat_model(owner_client)
      for _ in range(12):
          await _round(pool, rate=40.0, hours_ago=1, served_on=None)
      assert (await owner_client.get("/api/v1/system/resources")).json()["throughput"] is None
  ```

- [ ] **Step 28: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t5" uv run pytest tests/test_resources_api.py -q
  ```

  Expected: the first two fail. The card still comes from `/admin/vram`, and `speeds(...).get(model)` raises nothing but returns `None`. The third may pass by accident, which is fine.

- [ ] **Step 29: implement** `app/resources_api.py`. Replace lines 23-105 with:

  ```python
  from __future__ import annotations

  import httpx
  from fastapi import APIRouter, Depends, Request

  from app import db, identity, machines, model_speed, peers, settings_store
  from app.identity import Person

  router = APIRouter(prefix="/api/v1/system", tags=["system"])

  #: The gateway is the only thing that reads this host's /proc; the card is the
  #: gateway's reading of each machine (app/machines.py, S40 — /admin/vram is gone).
  MACHINE_PATH = "/admin/machine"

  #: Short: a panel opening on a click must not hang on a busy peer. A slow
  #: read costs its own section, which says so.
  TIMEOUT = httpx.Timeout(connect=3.0, read=8.0, write=3.0, pool=3.0)


  async def _from_gateway(app, path: str) -> tuple[dict | None, str | None]:
      try:
          async with peers.client(app, peers.GATEWAY, TIMEOUT) as client:
              resp = await client.get(path)
              resp.raise_for_status()
      except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
          return None, f"the gateway could not be asked — {peers.reason(exc)}"
      return resp.json(), None


  def _card_words(body: dict) -> dict:
      """(docstring of the old `_card`, unchanged)"""
      free = body.get("free_gb")
      used_mb, resident = body.get("used_mb"), body.get("resident") or []
      held_mb = sum(entry.get("vram_mb") or 0 for entry in resident)
      others = (used_mb - held_mb) / 1024 if used_mb is not None else None
      return {
          "free_gb": free,
          "total_gb": body.get("total_gb"),
          "used_gb": body.get("used_gb"),
          "utilisation_pct": body.get("util_pct"),
          "non_ollama_gb": round(others, 1) if others is not None else None,
          "resident": [
              {"model": entry.get("model"), "vram_gb": round((entry.get("vram_mb") or 0) / 1024, 1)}
              for entry in resident
          ],
          "reason": body.get("reason") or body.get("resident_reason"),
      }


  async def _card(app) -> dict:
      """The card of THE machine whose card can be read, named — or a reason.
      Two readable cards are not guessed between (the panel shows one)."""
      try:
          pairs = await machines.cards(app)
      except machines.PlantUnavailable as exc:
          return {"reason": f"the gateway could not be asked — {exc}"}
      read = [(view, detail) for view, detail in pairs if detail is not None]
      if len(read) != 1:
          return {
              "reason": "the gateway lists no machine whose card could be read"
              if not read
              else f"{len(read)} machines report a card; the panel shows one only when there is one"
          }
      view, detail = read[0]
      body = detail.get("vram") if isinstance(detail.get("vram"), dict) else {}
      return {"machine": view["name"], **_card_words(body)}


  @router.get("/resources")
  async def resources(request: Request, person: Person = Depends(identity.require_person)) -> dict:
      """The card, the machine, and how fast the chat model is generating."""
      pool = await db.get_pool()

      card = await _card(request.app)
      machine, machine_error = await _from_gateway(request.app, MACHINE_PATH)

      model = await settings_store.read_value(pool, "chat.model")
      speed = None
      if model:
          # Where its rounds last ran decides whose normal it is (S40, D10).
          serving = await model_speed.latest_serving(pool, model)
          if serving is not None:
              speed = (await model_speed.speed_of(pool, *serving.key)).as_dict()

      return {
          "card": card,
          "machine": machine if machine is not None else {"reason": machine_error},
          # None when this model has no placed history here yet — never a zero.
          "throughput": speed,
          "model": model or None,
      }
  ```

- [ ] **Step 30: run green, then commit the measurement identity and the engines reader**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t5" uv run pytest tests/test_resources_api.py tests/test_machines.py tests/test_model_speed.py tests/test_tools_inference.py tests/test_checks_inference.py tests/test_chat_served_by.py tests/test_migration_035_hub_engine.py tests/test_chat.py tests/test_chat_throughput.py -q
  ```

  Expected: all passed.

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && uv run ruff format migrations/035_hub_engine.sql app/machines.py app/chat.py app/model_speed.py app/tools/inference.py app/checks/inference.py app/resources_api.py tests/fakes.py tests/test_chat_served_by.py tests/test_model_speed.py tests/test_tools_inference.py tests/test_checks_inference.py tests/test_machines.py tests/test_resources_api.py tests/test_migration_035_hub_engine.py 2>/dev/null; uv run ruff check app/machines.py app/chat.py app/model_speed.py app/tools/inference.py app/checks/inference.py app/resources_api.py tests/fakes.py tests/test_chat_served_by.py tests/test_model_speed.py tests/test_tools_inference.py tests/test_checks_inference.py tests/test_machines.py tests/test_resources_api.py tests/test_migration_035_hub_engine.py
  ```

  ruff skips the `.sql` file. Run format only on the `.py` files listed.

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff && git add services/core/migrations/035_hub_engine.sql services/core/app/machines.py services/core/app/chat.py services/core/app/model_speed.py services/core/app/tools/inference.py services/core/app/checks/inference.py services/core/app/resources_api.py services/core/tests/fakes.py services/core/tests/test_chat_served_by.py services/core/tests/test_model_speed.py services/core/tests/test_tools_inference.py services/core/tests/test_checks_inference.py services/core/tests/test_machines.py services/core/tests/test_resources_api.py services/core/tests/test_migration_035_hub_engine.py && git commit -m "$(printf 'feat(core): S40 measurement identity and the engines reader\n\nCore 035 moves chat.model / chat.vision_model ollama:X -> hub:X (bare\nvalues untouched). llm_call spans record served_on / served_runtime from the\ngateway headers, omitted when absent. model_speed keys every rate by\n(model without its engine, served_on, runtime) and drops rounds the gateway\ncould not place. app/machines.py is core'"'"'s one reader of /admin/engines;\ninference_health, inference_degraded and the resources panel read each\nmachine'"'"'s card there instead of the deleted /admin/vram.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
  ```

#### 5.8 `checks/stack.py`: engines come from the gateway

- [ ] **Step 31: move the pinned fixtures and tests, and write the failing ones** in `tests/test_checks.py`.

  Lines 82-96 become:

  ```python
  def _local(model: str, *, installed: bool = True) -> dict:
      # S40: the bundled engine is `hub` (gateway 009), and a row on it is
      # `kind: local` — the word the checks read, never the provider's name.
      return {
          "id": f"hub:{model}",
          "provider": "hub",
          "model": model,
          "kind": "local",
          "installed": installed,
      }


  def _catalog(*rows: dict, hub_ok: bool = True, note: str | None = None) -> dict:
      # The catalogue keys each engine's source by the engine's name (T4).
      source: dict = {"key": "hub", "ok": hub_ok, "rows": len(rows)}
      if note is not None:
          source["note"] = note
      return {"fetched_at": "2026-09-08T00:00:00+00:00", "sources": [source], "rows": list(rows)}


  def _engine_calls(gateway: FakeGateway) -> int:
      return sum(1 for path, _ in gateway.seen if path == "/admin/engines")
  ```

  Changes at lines 404-413, `test_the_stack_is_quiet_when_every_peer_answers`:
  - `FakeGateway(catalog_body=_catalog(_local("qwen3:8b")))` becomes `FakeGateway(catalog_body=_catalog(_local("qwen3:8b")), engines=[fakes.engine_view()])`.
  - The `value="ollama:qwen3:8b"` argument becomes `value="hub:qwen3:8b"`.

  Replace lines 450-460 (`test_ollama_is_read_from_the_gateways_own_catalogue`) with:

  ```python
  @requires_db
  async def test_an_engine_that_did_not_answer_is_read_from_the_gateways_engine_list(
      pool, mount_peers
  ):
      view = fakes.engine_view(state="unreachable", reason="ConnectError: connection refused")
      mount_peers(gateway=FakeGateway(engines=[view]), memory=FakeMemory())
      run = await checks.run_one(core_app, pool, "stack_ollama")
      assert run.ran and [f.key for f in run.findings] == ["peer_down:hub"]
      assert run.findings[0].facts == {
          "peer": "hub",
          "reason": "ConnectError: connection refused",
          "basis": "the gateway's own engine reading",
      }
      assert run.findings[0].urgent is True


  @requires_db
  async def test_a_machine_switched_off_on_purpose_is_not_an_outage(pool, mount_peers):
      """The owner's switch (S40): a machine he told to stop running models is
      not down, and an urgent push at 3am saying so would be the lie."""
      view = fakes.engine_view(serving=False, state="switched_off")
      mount_peers(gateway=FakeGateway(engines=[view]), memory=FakeMemory())
      run = await checks.run_one(core_app, pool, "stack_ollama")
      assert run.ran and run.findings == ()


  @requires_db
  async def test_every_engine_is_its_own_subject_and_none_is_named_here(pool, mount_peers):
      views = [
          fakes.engine_view(),
          fakes.engine_view("box", state="unreachable", reason="ConnectTimeout"),
          fakes.engine_view("dell", lifecycle="wake_on_lan", state="unobserved"),
      ]
      mount_peers(gateway=FakeGateway(engines=views), memory=FakeMemory())
      run = await checks.run_one(core_app, pool, "stack_ollama")
      assert [f.key for f in run.findings] == ["peer_down:box"]
  ```

  At lines 470-489 (`test_a_chat_model_the_catalogue_does_not_list_is_a_finding`), add `engines=[fakes.engine_view()]` to both `FakeGateway(...)` calls.

  Replace lines 509-523 (`test_a_missing_model_is_not_claimed_when_ollama_never_answered`) with:

  ```python
  @requires_db
  async def test_a_missing_model_is_not_claimed_when_its_engine_never_answered(pool, mount_peers):
      """The catalogue with no local rows would make ANY local model look
      uninstalled. That is the silent fallback this slice forbids: the check
      did not run, and says which engine's silence stopped it."""
      body = _catalog(hub_ok=False, note="ollama refused: connection refused")
      view = fakes.engine_view(state="unreachable", reason="ConnectError: connection refused")
      mount_peers(gateway=FakeGateway(catalog_body=body, engines=[view]), memory=FakeMemory())
      await settings_store.write_setting(
          settings_store.SettingWrite(key="chat.model", value="qwen3:8b")
      )
      run = await checks.run_one(core_app, pool, "stack_chat_model")
      assert not run.ran and run.findings == ()
      assert "hub (ollama refused: connection refused) did not answer the gateway" in run.reason
      assert "qwen3:8b" in run.reason
  ```

  Replace lines 535-561 (`test_the_catalogue_is_assembled_once_per_beat_and_not_across_beats`) with:

  ```python
  @requires_db
  async def test_each_gateway_reading_is_made_once_per_beat_and_not_across_beats(
      pool, mount_peers, only
  ):
      """stack_chat_model reads the catalogue, stack_ollama the engine list (S40);
      each is made once per beat and again the next beat, because a cached probe
      is a probe that was not made this beat."""
      gateway = FakeGateway(catalog_body=_catalog(_local("qwen3:8b")), engines=[fakes.engine_view()])
      mount_peers(gateway=gateway, memory=FakeMemory())
      await settings_store.write_setting(
          settings_store.SettingWrite(key="chat.model", value="hub:qwen3:8b")
      )
      only(checks.REGISTRY["stack_chat_model"], checks.REGISTRY["stack_ollama"])
      runs = await checks.run_all(core_app, pool)
      assert [(r.check, r.ran, r.findings) for r in runs] == [
          ("stack_chat_model", True, ()),
          ("stack_ollama", True, ()),
      ]
      assert (_catalog_calls(gateway), _engine_calls(gateway)) == (1, 1)
      await checks.run_all(core_app, pool)
      assert (_catalog_calls(gateway), _engine_calls(gateway)) == (2, 2)
      await checks.run_one(core_app, pool, "stack_ollama")
      await checks.run_one(core_app, pool, "stack_ollama")
      assert (_catalog_calls(gateway), _engine_calls(gateway)) == (2, 4)
  ```

  Replace lines 564-582 (`test_a_shared_catalogue_still_lets_each_subject_tell_its_own_truth`) with:

  ```python
  @requires_db
  async def test_one_beat_lets_each_subject_tell_its_own_truth(pool, mount_peers, only):
      """On the SAME beat, an engine not answering is an urgent FINDING while
      whether the chat model is installed is a check that COULD NOT RUN — and
      the engine list is read once for both."""
      gateway = FakeGateway(
          catalog_body=_catalog(hub_ok=False, note="ollama refused: connection refused"),
          engines=[fakes.engine_view(state="unreachable", reason="ConnectError: refused")],
      )
      mount_peers(gateway=gateway, memory=FakeMemory())
      await settings_store.write_setting(
          settings_store.SettingWrite(key="chat.model", value="qwen3:8b")
      )
      only(checks.REGISTRY["stack_chat_model"], checks.REGISTRY["stack_ollama"])
      model_run, ollama_run = await checks.run_all(core_app, pool)
      assert (_catalog_calls(gateway), _engine_calls(gateway)) == (1, 1)
      assert ollama_run.ran and ollama_run.findings[0].key == "peer_down:hub"
      assert ollama_run.findings[0].urgent is True
      assert not model_run.ran and "did not answer the gateway" in model_run.reason
  ```

  Append:

  ```python
  @requires_db
  async def test_a_bare_tag_matches_a_local_row_on_whichever_engine_lists_it(pool, mount_peers):
      row = {**_local("qwen3:8b"), "id": "box:qwen3:8b", "provider": "box"}
      mount_peers(
          gateway=FakeGateway(catalog_body=_catalog(row), engines=[fakes.engine_view("box")]),
          memory=FakeMemory(),
      )
      await settings_store.write_setting(
          settings_store.SettingWrite(key="chat.model", value="qwen3:8b")
      )
      run = await checks.run_one(core_app, pool, "stack_chat_model")
      assert run.ran and run.findings == ()


  @requires_db
  async def test_a_cloud_model_missing_while_its_own_listing_failed_is_not_claimed(
      pool, mount_peers
  ):
      body = _catalog(_local("qwen3:8b"))
      body["sources"].append(
          {"key": "openrouter", "ok": False, "rows": 0, "note": "the listing was refused (401)"}
      )
      mount_peers(gateway=FakeGateway(catalog_body=body, engines=[fakes.engine_view()]),
                  memory=FakeMemory())
      await settings_store.write_setting(
          settings_store.SettingWrite(key="chat.model", value="openrouter:openai/gpt-x")
      )
      run = await checks.run_one(core_app, pool, "stack_chat_model")
      assert not run.ran
      assert "openrouter (the listing was refused (401)) did not answer the gateway" in run.reason
  ```

- [ ] **Step 32: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t5" uv run pytest tests/test_checks.py -q -k "stack or engine or chat_model or bare or beat or subject or catalogue"
  ```

  Expected failures:
  - `stack_ollama` raises `CannotCheck("the gateway's catalogue named no ollama source…")`.
  - The bare-tag test on `box` finds no row, because it still reads `provider == "ollama"`.
  - The CannotCheck reasons still say "ollama did not answer".

- [ ] **Step 33: implement** `app/checks/stack.py`.

  In the docstring, lines 13-18: "an ollama that could not be asked" becomes "an engine that could not be asked".

  Line 27 becomes `from app import machines, peers, settings_store`.

  Replace lines 44-53 with:

  ```python
  # Whether an ENGINE answers is the gateway's own reading of it (GET
  # /admin/engines through app/machines.py). Core has no route to any engine —
  # the gateway is the only thing that talks to one — and which providers ARE
  # engines is whatever that list says, never a name written here (S40: the
  # bundled one is `hub`; S44 adds one per machine).

  # Where the catalogue and the engine list are shared for the length of ONE
  # beat (checks.run_cache).
  CATALOGUE_KEY = "stack.catalogue"
  ENGINES_KEY = "stack.engines"
  ```

  Replace `_catalogue` (141-172, keeping its docstring) with:

  ```python
  async def _shared(app, key: str, fetch):
      """One fetch per beat per key, shared by every check that reads it.

      What is cached is the in-flight TASK, not its result: callers start within
      microseconds of each other, so caching the result alone would have them
      both miss and both fetch. A caller that hits its own deadline is shielded
      out of the await rather than cancelling the fetch another is waiting on.
      """
      cache = run_cache()
      task = cache.get(key)
      if not isinstance(task, asyncio.Task):
          task = asyncio.ensure_future(fetch(app))
          task.add_done_callback(_settled)
          cache[key] = task
      return await asyncio.shield(task)


  async def _catalogue(app) -> dict:
      """The gateway's /admin/catalog, assembled ONCE per beat. (The old
      docstring's argument for sharing the FETCH but not the CheckRun stands.)"""
      return await _shared(app, CATALOGUE_KEY, _fetch_catalogue)


  async def _engines(app) -> list[dict]:
      """The gateway's engine list, read ONCE per beat: stack_ollama always,
      stack_chat_model only when it has a missing model to explain."""
      return await _shared(app, ENGINES_KEY, _fetch_engines)


  async def _fetch_engines(app) -> list[dict]:
      try:
          return await machines.plant().engines(app, live=False)
      except machines.PlantUnavailable as exc:
          raise CannotCheck(
              f"the gateway could not be asked which machines run models — {exc}"
          ) from exc
  ```

  Replace `_ollama_source` and `ollama` (208-240) with:

  ```python
  async def ollama(app, pool) -> list[Finding]:
      """Does every machine that runs models answer the gateway?

      Read from the gateway's own engine list (S40) — one finding per engine
      that did not answer, keyed by its name. Two states are deliberately NOT
      findings. `switched_off` is the owner's switch: a machine he told to stop
      running models is not down, and an urgent push at 3am saying so would be
      the lie. `unobserved` is a machine that sleeps on its own and was not
      contacted: nothing was learned about it, and it is never woken just to be
      checked.
      """
      findings: list[Finding] = []
      for view in await _engines(app):
          if view.get("state") != "unreachable":
              continue
          name = view["name"]
          why = str(view.get("reason") or "").strip() or "the gateway stated no reason"
          findings.append(
              Finding(
                  key=f"peer_down:{name}",
                  title=f"{name} did not answer the gateway — {why}",
                  facts={"peer": name, "reason": why, "basis": "the gateway's own engine reading"},
              )
          )
      return findings
  ```

  In `_row_for` (244-261): the docstring's "a bare ollama tag (`qwen3:8b`) is a local row's `model`" becomes "a bare tag (`qwen3:8b`) is a LOCAL row's `model` — local in the catalogue's own word (`kind`), on whichever engine lists it". Line 259 becomes:

  ```python
          if row.get("kind") == "local" and row.get("model") in bare:
  ```

  Add after `_row_for`:

  ```python
  async def _silent_listings(app, body: dict, wanted: str) -> list[tuple[str, str]]:
      """The listings that could have named `wanted` and did not answer, as
      (name, reason). Which ones: the provider an id names before its first
      colon when the catalogue has a source for it (`hub:…` -> hub,
      `openrouter:…` -> openrouter); otherwise — a bare tag, which resolves on
      an engine — every engine the gateway lists. An engine is silent when its
      catalogue source failed OR the gateway's own reading says it did not
      answer (a switched-off engine still lists what it has)."""
      sources = {s.get("key"): s for s in body.get("sources") or [] if isinstance(s, dict)}
      head, sep, _rest = wanted.partition(":")
      views: dict[str, dict] = {}
      if sep and head in sources:
          asked = [head]
      else:
          views = {view["name"]: view for view in await _engines(app)}
          asked = [head] if sep and head in views else sorted(views)
      silent: list[tuple[str, str]] = []
      for name in asked:
          source, view = sources.get(name), views.get(name)
          if source is not None and source.get("ok") is not True:
              silent.append((name, str(source.get("note") or "no reason stated").strip()))
          elif view is not None and view.get("state") not in ("ready", "switched_off"):
              silent.append((name, str(view.get("reason") or view.get("state")).strip()))
      return silent
  ```

  In `chat_model`:
  - The docstring's "UNLESS ollama could not be asked" becomes "UNLESS a listing that could have named it did not answer".
  - Replace lines 294-302 (`if row is None:` through its `raise CannotCheck(...)`) with:

  ```python
      if row is None:
          silent = await _silent_listings(app, body, wanted)
          if silent:
              who = "; ".join(f"{name} ({why})" for name, why in silent)
              raise CannotCheck(
                  f"{who} did not answer the gateway, so the catalogue lists no installed model "
                  f"to compare {wanted!r} against"
              )
  ```

  At lines 347-350 the `describe` of `stack_ollama` becomes `"Every machine that runs models, unless it is switched off, answers the gateway."`.

- [ ] **Step 34: run green**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t5" uv run pytest tests/test_checks.py tests/test_beats.py -q
  ```

  Expected: all passed. The urgent-set pin at `:220` is derived from `stack.NAMES` and does not move.

#### 5.9 Catalogue measurements and vision: read the rows, not a name

- [ ] **Step 35: write the failing tests.**

  Append to `tests/test_models_catalog.py`:

  ```python
  def test_a_bare_measurement_belongs_to_a_local_row_on_any_engine_never_by_name():
      """S40: the local row is `kind: local` in the catalogue's own word — hub,
      or a machine added tomorrow — never a provider name kept in core."""
      measured = {"qwen3:8b": {SUITE: {"pass_rate": 0.5}}}
      for provider in ("hub", "dell"):
          row = {**_row(f"{provider}:qwen3:8b", provider, "qwen3:8b"), "kind": "local"}
          assert measured_for(row, measured) == {SUITE: {"pass_rate": 0.5}}
  ```

  Append to `tests/test_vision.py`:

  ```python
  def test_the_prefix_is_whatever_the_catalogue_says_never_a_name_kept_here():
      """S40: the catalogue says `hub:` (or any machine) and a setting may be
      bare or qualified. The catalogue id splits at its FIRST colon; a setting
      is never split — `qwen3.8:27b`'s colon is its own."""
      rows = [
          {"id": "hub:qwen3.8:27b", "installed": True,
           "capabilities": {"vision": {"value": True}}},
          {"id": "dell:gemma4:12b", "installed": True,
           "capabilities": {"vision": {"value": True}}},
          {"id": "hub:qwen3:8b", "installed": True, "capabilities": {"tools": {"value": True}}},
      ]
      assert vision.bare("hub:qwen3.8:27b") == "qwen3.8:27b"
      assert vision.choose(rows, wanted="hub:qwen3.8:27b").note is None
      assert vision.choose(rows, wanted="qwen3.8:27b").note is None
      swapped = vision.choose(rows, wanted="hub:qwen3:8b", preferred="gemma4:12b")
      assert swapped.model == "dell:gemma4:12b"
      assert "running on gemma4:12b rather than qwen3:8b" in swapped.note
  ```

- [ ] **Step 36: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t5" uv run pytest tests/test_models_catalog.py tests/test_vision.py tests/test_models_vision.py -q
  ```

  Expected failures:
  - `measured_for` returns `{}` for `hub`/`dell`.
  - `vision.bare("hub:…")` returns the whole id.
  - `choose(wanted="qwen3.8:27b")` swaps.

- [ ] **Step 37: implement.**

  `app/models_catalog.py`:
  - Lines 8-10 of the docstring become "row's `provider:model`, or (a run recorded with a bare id) equals a LOCAL row's bare model — local in the catalogue's own word, on whichever engine lists it — never a guessed prefix."
  - Delete line 34 (`LOCAL_PROVIDER`).
  - Lines 38-47 become:

  ```python
  def measured_for(row: dict, measured: dict[str, dict[str, dict]]) -> dict[str, dict]:
      """The measured entries that belong to `row`, keyed by suite. A bare id
      measured whatever local engine answered it; a row on an engine says so in
      its own `kind` (S40) — never a provider name kept here."""
      candidates = [row.get("id")]
      if row.get("kind") == "local":
          candidates.append(row.get("model"))
      found: dict[str, dict] = {}
      for key in candidates:
          for suite, entry in (measured.get(key) or {}).items():
              found.setdefault(suite, entry)
      return found
  ```

  `app/vision.py`: replace lines 103-113 with:

  ```python
  def bare(model: str) -> str:
      """A catalogue id without its provider. The gateway builds every id as
      `<provider>:<model>` (catalog_row.base_row), so the FIRST colon is the
      provider's — `hub:qwen3.8:27b` -> `qwen3.8:27b`, whatever the machine is
      called (S40). Only for catalogue ids: a setting may be bare (`qwen3.8:27b`),
      whose first colon is the tag's own, and `choose` matches it against both
      halves instead of splitting it. Public because the picker in Settings
      writes what this returns."""
      _provider, sep, rest = model.partition(":")
      return rest if sep and rest else model


  def _said(model: str, rows: list[dict]) -> str:
      """How a person reads a model named in a SETTING: without its provider
      when the catalogue lists a row under that provider, as-is otherwise — only
      the rows can tell `hub:` (a machine) from `qwen3.8:` (a model's own name)."""
      head, sep, rest = model.partition(":")
      if sep and rest and any(
          isinstance(r, dict) and str(r.get("id") or "").startswith(f"{head}:") for r in rows
      ):
          return rest
      return model
  ```

  In `choose`, replace lines 156-185 (from `able = …` to the end) with:

  ```python
      able = capable(rows, capability)
      bares = {bare(m) for m in able}
      # A setting names a catalogue row exactly (`hub:qwen3.8:27b`) or by its
      # model alone (`qwen3.8:27b`). Never split: its first colon may be the
      # tag's own.
      if wanted in able or wanted in bares:
          return Choice(model=wanted, note=None, can_see=True)
      if not able:
          return Choice(
              model=wanted,
              note=(
                  f"No model installed on this machine reports the {capability} capability, so "
                  "the attachment below is NOT in this turn. Say that; do not describe it."
              ),
              can_see=False,
          )
      picked = able[0]
      if preferred:
          for model in able:
              if model == preferred or bare(model) == preferred:
                  picked = model
                  break
      said = _said(wanted, rows)
      return Choice(
          model=picked,
          note=(
              f"This turn is running on {bare(picked)} rather than {said}, because "
              f"{said} cannot see images and {bare(picked)} can. Say so in the reply."
          ),
          can_see=True,
      )
  ```

- [ ] **Step 38: run green.** Run the same command as Step 36, plus `tests/test_chat_attachments.py`. Expected: all passed, with none of the existing `ollama:` fixtures edited.

#### 5.10 The model tools: machine-qualified ids, derived

- [ ] **Step 39: move the pinned lines and write the failing tests** in `tests/test_tools_models.py`.

  Line 141 becomes `fake = fakes.FakeGateway(catalog_body=CATALOG, hf_body=HF_PAGE, engines=[fakes.engine_view()])`.

  Lines 257-263 become:

  ```python
  async def test_a_cloud_id_is_refused_before_anything_is_pulled(gateway):
      fake, ctx, _ = gateway
      text, ok = await _run(models.model_pull, ctx, model="openrouter:openai/gpt-6-astra")
      assert not ok and "is a cloud provider's model" in text and "(hub)" in text
      # Only the machine list was read (S40: needed to tell a machine from a cloud).
      assert [path for path, _ in fake.seen] == ["/admin/engines"]
      text, ok = await _run(models.model_pull, ctx, model="   ")
      assert not ok and "needs a model reference" in text
  ```

  More moves:
  - Line 322 becomes `assert [p for p, _ in fake.seen] == ["/admin/engines", "/admin/pull", "/admin/catalog"]`.
  - Lines 452 and 483: `"only the bundled ollama" in text` becomes `"is a cloud provider's model" in text`.
  - Line 479 (`assert len(fake.seen) == calls`) becomes `assert "/admin/models" not in [p for p, _ in fake.seen[calls:]]`.

  Reason for the moves: the engine list is read before anything moves, and the refusal names the machines instead of "the bundled ollama". The `ollama:huge:70b` → `{"model": "huge:70b"}` pin at 276 and the drift pin at 427 do not move, because a non-engine prefix before a whole model ref is resolved to the model after it.

  Append:

  ```python
  async def test_a_model_on_a_named_machine_goes_to_the_gateway_whole(gateway):
      fake, ctx, _ = gateway
      fake.pull_lines = ('{"status":"success"}',)
      fake.catalog_body = {
          **CATALOG, "rows": [{**PULLED_4B, "id": "hub:qwen3:4b", "provider": "hub"}],
      }
      text, ok = await _run(models.model_pull, ctx, model="hub:qwen3:4b")
      assert ok, text
      assert ("/admin/pull", {"model": "hub:qwen3:4b"}) in fake.seen
      assert text.startswith("Pulled hub:qwen3:4b")


  async def test_the_catalogue_confirms_a_pull_only_on_the_machine_it_was_asked_for(gateway):
      fake, ctx, _ = gateway
      fake.engines.append(fakes.engine_view("box"))
      fake.pull_lines = ('{"status":"success"}',)
      fake.catalog_body = {
          **CATALOG, "rows": [{**PULLED_4B, "id": "box:qwen3:4b", "provider": "box"}],
      }
      text, ok = await _run(models.model_pull, ctx, model="hub:qwen3:4b")
      assert not ok and "does not list hub:qwen3:4b as installed" in text


  async def test_a_library_id_or_an_old_ollama_id_pulls_the_model_after_the_colon(gateway):
      fake, ctx, _ = gateway
      fake.pull_lines = ('{"status":"success"}',)
      fake.catalog_body = {**CATALOG, "rows": [PULLED_4B]}
      for given in ("library:qwen3:4b", "ollama:qwen3:4b"):
          text, ok = await _run(models.model_pull, ctx, model=given)
          assert ok, text
          assert fake.seen[-2] == ("/admin/pull", {"model": "qwen3:4b"})


  async def test_an_unreadable_machine_list_stops_the_pull_before_anything_moves(gateway):
      fake, ctx, _ = gateway
      fake.engines = None  # the admin echo: a body that names no engines
      text, ok = await _run(models.model_pull, ctx, model="qwen3:4b")
      assert not ok and "could not ask the model gateway which machines run models" in text
      assert "/admin/pull" not in [p for p, _ in fake.seen]


  @requires_db
  async def test_remove_refuses_the_chat_model_on_its_machine_and_nowhere_else(gateway, pool):
      fake, ctx, _ = gateway
      fake.engines.append(fakes.engine_view("box"))
      await pool.execute(
          "INSERT INTO settings (key, value) VALUES ('chat.model', '\"hub:qwen3:8b\"'::jsonb) "
          "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
      )
      for given in ("hub:qwen3:8b", "qwen3:8b"):
          text, ok = await _run(models.model_remove, ctx, model=given)
          assert not ok and "is the current chat model" in text, given
      fake.admin_body = {"removed": "box:qwen3:8b", "verified": True, "installed_now": 0}
      text, ok = await _run(models.model_remove, ctx, model="box:qwen3:8b")
      assert ok, text
      assert fake.queries[-1] == b"model=box%3Aqwen3%3A8b"
  ```

- [ ] **Step 40: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t5" uv run pytest tests/test_tools_models.py -q
  ```

  Expected failures:
  - `/admin/engines` is never requested.
  - `hub:qwen3:4b` is sent whole but `_installed_row` needs `provider == "ollama"`.
  - `library:qwen3:4b` is sent whole.
  - The remove test for `hub:qwen3:8b` does not refuse.

- [ ] **Step 41: implement** `app/tools/models.py`.

  Docstring line 1: "pull a model into the bundled ollama" becomes "pull a model onto a machine that runs models".

  Line 26 becomes `from app import db, machines, peers, settings_store`. Delete line 43 (`LOCAL_PROVIDER`).

  Replace `_target_of` (439-458) with:

  ```python
  # The shapes a Hugging Face GGUF ref starts with (the gateway's
  # pulls.HUB_PREFIXES): a path, never a cloud provider's model.
  _HUB_REFS = ("hf.co/", "huggingface.co/")


  async def _engines(ctx: ToolContext) -> frozenset[str]:
      """The machines that run models, as the gateway lists them now (S40) —
      the only way to tell `hub:qwen3:4b` (qwen3:4b on hub) from `qwen3:4b` (a
      tag whose colon is its own), and never a name kept here. Unreadable is a
      stated failure BEFORE anything moves: a guess would pull onto the wrong
      machine or remove the chat model from under the next turn."""
      try:
          views = await machines.plant().engines(ctx.app, live=False)
      except machines.PlantUnavailable as exc:
          raise ToolFailure(
              f"could not ask the model gateway which machines run models — {exc}"
          ) from exc
      return frozenset(view["name"] for view in views)


  def _given(args: dict) -> str:
      model = str(args.get("model") or "").strip()
      if not model:
          raise ToolFailure("model_pull needs a model reference, e.g. qwen3:4b or hf.co/org/repo")
      return model


  def _cloud_shaped(rest: str) -> bool:
      return "/" in rest and not rest.startswith(_HUB_REFS)


  def _parts(model: str, engines: frozenset[str]) -> tuple[str | None, str]:
      """(machine, model as that machine names it).

      `hub:qwen3:4b` -> ("hub", "qwen3:4b") because hub is a machine. A prefix
      that is NOT a machine but is followed by a whole model ref — the curated
      library's catalogue ids (`library:qwen3:4b`), an id from before the
      builtin was renamed (`ollama:qwen3:4b`) — names the model after it, bound
      for the gateway's default machine. Anything else is the model as given:
      `qwen3:4b`, `llama3.2:3b`, `user/model:tag`, `hf.co/org/repo:Q4_K_M`."""
      engine, rest = machines.split(model, engines)
      if engine is not None:
          return engine, rest
      head, sep, rest = model.partition(":")
      if (
          sep
          and head.isalnum()
          and (":" in rest or rest.startswith(_HUB_REFS))
          and not _cloud_shaped(rest)
      ):
          return None, rest
      return None, model


  def _target_of(model: str, engines: frozenset[str]) -> str:
      """The ref the gateway is sent: machine-qualified when she named a machine
      (so the gateway acts on THAT one), the bare model otherwise (the gateway's
      default). A cloud-qualified id is refused — a cloud model is used, never
      pulled."""
      head, sep, rest = model.partition(":")
      if sep and rest and head not in engines and head.isalnum() and _cloud_shaped(rest):
          raise ToolFailure(
              f"{model!r} is a cloud provider's model — only a machine that runs models "
              f"({', '.join(sorted(engines)) or 'none is listed'}) can pull one, and a cloud "
              "model is used directly, never pulled"
          )
      engine, ref = _parts(model, engines)
      return f"{engine}:{ref}" if engine else ref


  def _same_model(a: str, b: str, engines: frozenset[str]) -> bool:
      """Do two ids name the same model on the same machine? A side that names
      no machine could be on any (a bare id is the gateway's default), so only
      two DIFFERENT named machines make two models."""
      a_engine, a_ref = _parts(a, engines)
      b_engine, b_ref = _parts(b, engines)
      if a_engine and b_engine and a_engine != b_engine:
          return False
      return a_ref in (b_ref, f"{b_ref}:latest") or b_ref in (a_ref, f"{a_ref}:latest")
  ```

  Replace `_installed_row` (470-481) with:

  ```python
  def _installed_row(catalog: dict, target: str, engines: frozenset[str]) -> dict | None:
      """The row that confirms `target` installed: a local row (the catalogue's
      own word) for that model, on the machine the target names — or on any
      machine when it names none (the gateway's default took it)."""
      engine, ref = _parts(target, engines)
      wanted = {ref, f"{ref}:latest"}
      for row in catalog.get("rows") or []:
          if (
              isinstance(row, dict)
              and row.get("kind") == "local"
              and row.get("installed") is True
              and row.get("model") in wanted
              and (engine is None or row.get("provider") == engine)
          ):
              return row
      return None
  ```

  Line 530 (in `model_check_update`) becomes:

  ```python
      target = _target_of(_given(args), await _engines(ctx))
  ```

  Replace lines 564-572 (in `model_remove`) with:

  ```python
      model = _given(args)
      engines = await _engines(ctx)
      target = _target_of(model, engines)
      pool = await db.get_pool()
      current = str(await settings_store.read_value(pool, "chat.model") or "")
      if current and _same_model(current, target, engines):
          raise ToolFailure(
              f"{target} is the current chat model (chat.model = {current!r}) — switch to "
              "another model first, then remove it"
          )
  ```

  Line 587 (in `model_pull`) becomes:

  ```python
      model = _given(args)
      engines = await _engines(ctx)
      target = _target_of(model, engines)
  ```

  Line 674 becomes `row = _installed_row(catalog, target, engines)`.

  Descriptions:
  - `model_catalog_search` (716): "what is installed on the local ollama" becomes "what is installed on each machine that runs models".
  - `model_pull` (792-797):

    ```python
            "Download a model onto a machine that runs models so it can be used: a library "
            "tag like qwen3:4b (onto the default machine), the same behind a machine's name "
            "(<machine>:qwen3:4b), a namespaced user/model:tag, or a Hugging Face GGUF repo "
            "as hf.co/org/repo[:QUANT]. Downloads gigabytes and reports progress as it runs. "
            "The result line states what the catalogue lists as installed (size, quant, "
            "digest) — say what was pulled only from that line. Cloud models are never "
            "pulled; use them directly."
    ```

  - The `set_as_chat_model` description at 811-812 becomes "(chat.model = the catalogue id, <machine>:<model>), read back."
  - `model_remove` (847): "from the local ollama" becomes "from a machine that runs models (name it <machine>:<model> to pick one)".

- [ ] **Step 42: run green.** Run the same command as Step 40. Expected: all passed.

- [ ] **Step 43: the full core suite, then commit**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t5" uv run pytest -q
  ```

  Expected: all passed. Item 0 made the full run possible, and `pytest-timeout` names any hang.

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && uv run ruff format app/checks/stack.py app/models_catalog.py app/vision.py app/tools/models.py tests/test_checks.py tests/test_models_catalog.py tests/test_vision.py tests/test_tools_models.py && uv run ruff check app/checks/stack.py app/models_catalog.py app/vision.py app/tools/models.py tests/test_checks.py tests/test_models_catalog.py tests/test_vision.py tests/test_tools_models.py
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff && git add services/core/app/checks/stack.py services/core/app/models_catalog.py services/core/app/vision.py services/core/app/tools/models.py services/core/tests/test_checks.py services/core/tests/test_models_catalog.py services/core/tests/test_vision.py services/core/tests/test_tools_models.py && git commit -m "$(printf 'feat(core): S40 which providers are engines is the gateway'"'"'s to say\n\nLOCAL_PROVIDER is gone from models_catalog, tools/models, checks/stack and\nvision. Catalogue rows are read by their own kind and first-colon ids; a\nfree-standing id asks /admin/engines. stack_ollama reads each engine'"'"'s state\n(a switched-off machine is not an outage); a missing chat model names the\nlisting that did not answer. Model tools send <machine>:<model> whole and\nconfirm the pull on that machine.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
  ```

**Existing core tests that hardcode `ollama:` or `/admin/vram`, and their disposition**

Moved in Task 5, with the reasons given above:
- `test_tools_inference.py:56,240`
- `test_tools_models.py:141,257-263,322,452,479,483`
- `test_checks.py:82-96,404-413,450-460,470-489,509-523,535-582`
- `test_model_speed.py` helper and every `speed_of` call
- `test_checks_inference.py:27-43`

Unaffected and deliberately left alone. Core treats these strings opaquely, or the derived rules still hold for `ollama:`:
- `fakes.py:148,617` (the default `served_by`)
- `test_chat.py:129,301,498`
- `test_chat_model_failure.py:112,267,272,310`
- `test_chat_served_by.py:58-61`
- `test_chat_route.py:21-100`
- `test_tools_route.py:14-61`
- `test_agents.py:103-648`, `test_agents_api.py:84-238`
- `test_tools_agents.py:404-435`, `test_chat_agents.py:77-82`
- `test_proxies.py:58`
- `test_tools_spend.py:22-80`
- `test_chat_throughput.py:49-252`
- `test_chat_attachments.py:31-476`
- `test_vision.py:17-182`, `test_models_vision.py:19`
- `test_models_catalog.py:27-75`
- `test_guards.py:1624`
- `test_tools_peers.py:97-115` and `test_checks_review.py:250-265` (the embedder hostname `http://ollama:11434`, which is unchanged)

Carry: sweep the opaque fake defaults to `hub:` in a later cosmetic pass.

---

### Task 6: the machines plant, API, two tools, guards, registry, AUTO_RUN and prompt pins

**Files:**
- Modify: `services/core/app/machines.py` (append `set_serving`, `FixturePlant`, `machine_json`)
- Create: `services/core/app/machines_api.py`, `services/core/app/tools/machines.py`
- Modify: `services/core/app/main.py:16-42` (imports), `:125-143` (`include_router`)
- Modify: `services/core/app/tools/__init__.py:38-54,80-111`
- Modify: `services/core/app/live_facts.py:79-111`
- Modify: `services/core/app/guards.py:58-74,116-134,818-827,870-907,1188-1364,1860-1862`
- Modify: `services/core/app/chat.py:861-869`
- Modify: `services/core/app/tools/route.py:40-49`
- Test (create): `tests/test_tools_machines.py`, `tests/test_machines_api.py`
- Test (modify): `tests/test_machines.py` (append), `tests/fakes.py` (PUT branch), `tests/test_tools_registry.py:72-114,115-185,501-547,550-571`, `tests/test_capability_guard.py:36-76,95-145`, `tests/test_guards.py:24-32` (+ append), `tests/test_tools_route.py` (append)

**Interfaces:**
- **Consumes:** `PUT /admin/engines/{name} {"serving": bool}` → the stored row (404 unknown, 400 empty); Task 5's `app/machines.py`.
- **Produces, `app/machines.py`:**
  - `async def GatewayPlant.set_serving(self, app, name: str, serving: bool) -> dict` (PUT then GET; returns the GET)
  - `class FixturePlant(GatewayPlant)` with `__init__(self, fixtures: dict[str, dict])` (overlays `eval_*` names only)
  - `def machine_json(view: dict) -> dict`
- **Produces, `app/machines_api.py`:** `GET /api/v1/machines[?live=]` → `{"machines":[Machine]}`; `PATCH /api/v1/machines/{name} {"serving": bool}` → the read-back `Machine`. `Machine = {name, lifecycle, serving, state, reason, observed_at, compute, runtime, models:[{name, size_bytes}]}`.
- **Produces, `app/tools/machines.py`:**
  - `MACHINE_STATUS`, `MACHINE_CONFIGURE`, `TOOLS = (MACHINE_STATUS, MACHINE_CONFIGURE)`
  - `machine_status(args {machine?})`: `reads_only=True`, `ephemeral=True`, `result_kind=RESULT_KIND_LISTING`. Appends `{"machine","answering","checked_now","at"}` to `ctx.facts_sink`.
  - `machine_configure(args {machine, serving})`: `reads_only=False`, `ephemeral=False`. Its text states the value read back.
- **Produces, `guards`:** narration kind `configured_machine` → `{machine_configure}`, and two `_CAPABILITY_TOOLS` entries.
- **Produces, `route.py`:** the `switched_off` verdict in words.

- [ ] **Step 0: scratch DB**

  ```bash
  docker exec nova-scratch-pg psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='nova_core_s40_t6'" | grep -q 1 || docker exec nova-scratch-pg createdb -U postgres nova_core_s40_t6
  ```

#### 6.1 The plant writes and the eval overlay

- [ ] **Step 1: extend the fake with the gateway's PUT.** In `tests/fakes.py` `FakeGateway`:

  Add a field after `engine_details`:

  ```python
      # A PUT that does not store what was asked — the read-back mismatch a
      # write must never report as done.
      engine_put_sticks: bool = True
  ```

  Change the route to `Route("/admin/engines/{name}", self._engine, methods=["GET", "PUT"])`.

  In `_engine`, replace `await self._record(request)` with `body = await self._record(request)`, and insert before the final `return`:

  ```python
          if request.method == "PUT":
              if not isinstance(body, dict) or not isinstance(body.get("serving"), bool):
                  return JSONResponse({"error": "serving (true or false) is required"},
                                      status_code=400)
              if self.engine_put_sticks:
                  view["serving"] = body["serving"]
                  view["state"] = "ready" if body["serving"] else "switched_off"
              return JSONResponse({"provider": name, "serving": view["serving"],
                                   "lifecycle": view.get("lifecycle")})
  ```

- [ ] **Step 2: write the failing tests.** Append to `tests/test_machines.py`:

  ```python
  async def test_the_switch_is_set_and_what_comes_back_is_the_read_back(mount_peers):
      gateway = FakeGateway(engines=[fakes.engine_view()])
      mount_peers(gateway=gateway)
      back = await machines.plant().set_serving(core_app, "hub", False)
      assert back["serving"] is False and back["state"] == "switched_off"
      assert gateway.seen[-2:] == [
          ("/admin/engines/hub", {"serving": False}), ("/admin/engines/hub", None),
      ]


  async def test_a_switch_that_did_not_stick_comes_back_as_it_reads(mount_peers):
      mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()], engine_put_sticks=False))
      back = await machines.plant().set_serving(core_app, "hub", False)
      assert back["serving"] is True  # the read-back, never the value sent


  async def test_an_unknown_machine_cannot_be_switched(mount_peers):
      mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
      with pytest.raises(machines.UnknownMachine, match="no engine named 'dell'"):
          await machines.plant().set_serving(core_app, "dell", False)


  async def test_the_eval_world_overlays_only_eval_names_and_delegates_the_rest(mount_peers):
      gateway = FakeGateway(engines=[fakes.engine_view()])
      mount_peers(gateway=gateway)
      token = machines.PLANT.set(
          machines.FixturePlant({"eval_box": {"compute": "cpu:eval|4c|16g",
                                              "tags": {"qwen3:4b": 2_497_293_444}}})
      )
      try:
          views = await machines.plant().engines(core_app, live=True)
          assert [view["name"] for view in views] == ["hub", "eval_box"]
          assert views[1]["state"] == "ready" and views[1]["observed_at"]
          back = await machines.plant().set_serving(core_app, "eval_box", False)
          assert back["serving"] is False and back["state"] == "switched_off"
          assert "/admin/engines/eval_box" not in [path for path, _ in gateway.seen]
          await machines.plant().set_serving(core_app, "hub", False)
          assert ("/admin/engines/hub", {"serving": False}) in gateway.seen
          with pytest.raises(machines.UnknownMachine):
              await machines.plant().set_serving(core_app, "eval_other", True)
      finally:
          machines.PLANT.reset(token)
      assert type(machines.plant()) is machines.GatewayPlant


  def test_a_fixture_machine_must_carry_the_eval_prefix():
      with pytest.raises(ValueError, match="eval_"):
          machines.FixturePlant({"box": {}})


  def test_the_web_shape_lists_models_by_name_with_their_size_or_none():
      view = fakes.engine_view(tags={"qwen3:8b": 5_225_388_164, "nomic-embed-text:latest": None})
      assert machines.machine_json(view) == {
          "name": "hub", "lifecycle": "always_on", "serving": True, "state": "ready",
          "reason": None, "observed_at": fakes.ENGINE_AT, "compute": fakes.ENGINE_GPU,
          "runtime": "container",
          "models": [
              {"name": "nomic-embed-text:latest", "size_bytes": None},
              {"name": "qwen3:8b", "size_bytes": 5_225_388_164},
          ],
      }
      assert machines.machine_json(fakes.engine_view(tags=None))["models"] == []
  ```

- [ ] **Step 3: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t6" uv run pytest tests/test_machines.py -q
  ```

  Expected: `AttributeError: 'GatewayPlant' object has no attribute 'set_serving'`, and likewise for `FixturePlant` and `machine_json`.

- [ ] **Step 4: implement.**

  Add to `GatewayPlant` in `app/machines.py`:

  ```python
      async def set_serving(self, app, name: str, serving: bool) -> dict:
          """Set one machine's serving switch, then READ IT BACK: PUT, then GET,
          and what is returned is the GET — never the value that was sent."""
          path = _engine_path(name)
          response = await self._request(app, "PUT", path, json={"serving": serving})
          if response.status_code == 404:
              raise UnknownMachine(_error_of(response))
          if response.status_code != 200:
              raise PlantUnavailable(
                  f"the gateway refused to set {name}'s switch — {_error_of(response)}"
              )
          return await self.engine(app, name)
  ```

  Add `import copy` and `from datetime import UTC, datetime` to the imports. Append after `plant()`:

  ```python
  # A declared eval machine starts as a live, always-on one that answered now.
  _FIXTURE_DEFAULTS: dict = {
      "lifecycle": "always_on", "serving": True, "state": "ready", "reason": None,
      "observed_at": None, "tags": {}, "tags_as_of": None, "compute": None,
      "runtime": None, "facts": {},
  }


  class FixturePlant(GatewayPlant):
      """The eval harness's world: named `eval_*` machines that exist only for
      one replay, overlaid on the real list. Anything else is the gateway's,
      delegated untouched — a case measures her real tools against a machine it
      declared, and never flips a real machine's switch by being scored."""

      def __init__(self, fixtures: dict[str, dict]) -> None:
          # The roster's own reserved prefix (agents.EVAL_FIXTURE_PREFIX), read
          # here rather than retyped. Imported in the call: app.agents imports
          # app.tools, which imports the tool module that imports this one.
          from app import agents

          self._prefix = agents.EVAL_FIXTURE_PREFIX
          wrong = sorted(name for name in fixtures if not name.startswith(self._prefix))
          if wrong:
              raise ValueError(
                  f"a fixture machine must be named {self._prefix}…, got {', '.join(wrong)}"
              )
          self._views = {
              name: {**copy.deepcopy(_FIXTURE_DEFAULTS), **copy.deepcopy(spec), "name": name}
              for name, spec in fixtures.items()
          }

      def _mine(self, name: str) -> bool:
          return name.startswith(self._prefix)

      @staticmethod
      def _stamped(view: dict) -> dict:
          out = copy.deepcopy(view)
          if out["observed_at"] is None:
              out["observed_at"] = datetime.now(UTC).isoformat()
          return out

      async def engines(self, app, *, live: bool) -> list[dict]:
          real = [view for view in await super().engines(app, live=live)
                  if not self._mine(view["name"])]
          return real + [self._stamped(view) for view in self._views.values()]

      async def engine(self, app, name: str) -> dict:
          if not self._mine(name):
              return await super().engine(app, name)
          if name not in self._views:
              raise UnknownMachine(f"no engine named {name!r}")
          return {
              **self._stamped(self._views[name]),
              "vram": {"total_mb": None, "reason": "a declared eval machine has no card"},
              "fit_frame": None,
          }

      async def set_serving(self, app, name: str, serving: bool) -> dict:
          if not self._mine(name):
              return await super().set_serving(app, name, serving)
          if name not in self._views:
              raise UnknownMachine(f"no engine named {name!r}")
          self._views[name]["serving"] = serving
          self._views[name]["state"] = "ready" if serving else "switched_off"
          return await self.engine(app, name)


  def machine_json(view: dict) -> dict:
      """One machine in the shape the Settings tile reads (web api.ts Machine)."""
      tags = view.get("tags")
      models = (
          [
              {
                  "name": model,
                  "size_bytes": size if isinstance(size, int) and not isinstance(size, bool)
                  else None,
              }
              for model, size in sorted(tags.items())
          ]
          if isinstance(tags, dict)
          else []
      )
      return {
          "name": view["name"],
          "lifecycle": view.get("lifecycle"),
          "serving": view.get("serving"),
          "state": view.get("state"),
          "reason": view.get("reason"),
          "observed_at": view.get("observed_at"),
          "compute": view.get("compute"),
          "runtime": view.get("runtime"),
          "models": models,
      }
  ```

  Also extend the module docstring. "FixturePlant, S40 T6" becomes "FixturePlant".

- [ ] **Step 5: run green.** Run the same command as Step 3. Expected: `13 passed`.

#### 6.2 `/api/v1/machines`

- [ ] **Step 6: write the failing test** `tests/test_machines_api.py`

  ```python
  """S40 — GET/PATCH /api/v1/machines: the Settings tile's surface over the
  gateway's engines. The switch answers with what the gateway READS BACK."""

  from __future__ import annotations

  from tests import fakes
  from tests.conftest import requires_db
  from tests.fakes import FakeGateway

  pytestmark = requires_db


  def _machine(**over) -> dict:
      out = {
          "name": "hub", "lifecycle": "always_on", "serving": True, "state": "ready",
          "reason": None, "observed_at": fakes.ENGINE_AT, "compute": fakes.ENGINE_GPU,
          "runtime": "container", "models": [{"name": "qwen3:8b", "size_bytes": 5_225_388_164}],
      }
      out.update(over)
      return out


  async def test_the_tile_lists_every_machine_in_one_shape(owner_client, mount_peers):
      gateway = FakeGateway(engines=[fakes.engine_view()])
      mount_peers(gateway=gateway)
      resp = await owner_client.get("/api/v1/machines")
      assert resp.status_code == 200, resp.text
      assert resp.json() == {"machines": [_machine()]}
      assert gateway.queries[-1] == b"live=false"
      await owner_client.get("/api/v1/machines", params={"live": "true"})
      assert gateway.queries[-1] == b"live=true"


  async def test_the_switch_answers_with_what_the_gateway_reads_back(owner_client, mount_peers):
      gateway = FakeGateway(engines=[fakes.engine_view()])
      mount_peers(gateway=gateway)
      resp = await owner_client.patch("/api/v1/machines/hub", json={"serving": False})
      assert resp.status_code == 200, resp.text
      assert resp.json() == _machine(serving=False, state="switched_off")
      assert gateway.seen[-2:] == [
          ("/admin/engines/hub", {"serving": False}), ("/admin/engines/hub", None),
      ]


  async def test_a_switch_that_did_not_stick_is_shown_as_it_reads(owner_client, mount_peers):
      mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()], engine_put_sticks=False))
      resp = await owner_client.patch("/api/v1/machines/hub", json={"serving": False})
      assert resp.status_code == 200 and resp.json()["serving"] is True


  async def test_an_unknown_machine_is_a_404_in_the_gateways_words(owner_client, mount_peers):
      mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
      resp = await owner_client.patch("/api/v1/machines/dell", json={"serving": False})
      assert resp.status_code == 404 and resp.json() == {"error": "no engine named 'dell'"}


  async def test_a_body_without_serving_flips_nothing(owner_client, mount_peers):
      gateway = FakeGateway(engines=[fakes.engine_view()])
      mount_peers(gateway=gateway)
      resp = await owner_client.patch("/api/v1/machines/hub", json={})
      assert resp.status_code == 422
      assert gateway.seen == []


  async def test_a_gateway_that_names_no_engines_is_a_stated_502(owner_client, mount_peers):
      mount_peers(gateway=FakeGateway())
      resp = await owner_client.get("/api/v1/machines")
      assert resp.status_code == 502 and "did not name its engines" in resp.json()["error"]


  async def test_the_surface_needs_a_session(client):
      assert (await client.get("/api/v1/machines")).status_code == 401
      assert (
          await client.patch("/api/v1/machines/hub", json={"serving": False})
      ).status_code == 401
  ```

- [ ] **Step 7: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t6" uv run pytest tests/test_machines_api.py -q
  ```

  Expected: 404s from core (no such route), except the 401 test.

- [ ] **Step 8: implement** `services/core/app/machines_api.py`

  ```python
  """/api/v1/machines — the Settings tile's surface over the machines that run
  models (S40). Every answer is the gateway's reading through app/machines.py;
  the one write is the serving switch, answered with the value READ BACK.

  The switch is availability, never permission (D2): the gateway's routing is
  its only reader, and nothing anywhere waits on it."""

  from __future__ import annotations

  from fastapi import APIRouter, Depends, HTTPException, Request
  from pydantic import BaseModel

  from app import identity, machines
  from app.identity import Person

  router = APIRouter(prefix="/api/v1/machines", tags=["machines"])


  class ServingBody(BaseModel):
      # Required: a body without it is a 422, so a client that forgot the field
      # can never flip a machine's switch by accident (notices_api.MuteBody).
      serving: bool


  @router.get("")
  async def list_machines(
      request: Request, live: bool = False, person: Person = Depends(identity.require_person)
  ) -> dict:
      try:
          views = await machines.plant().engines(request.app, live=live)
      except machines.PlantUnavailable as exc:
          raise HTTPException(status_code=502, detail=str(exc)) from exc
      return {"machines": [machines.machine_json(view) for view in views]}


  @router.patch("/{name}")
  async def set_serving(
      name: str,
      body: ServingBody,
      request: Request,
      person: Person = Depends(identity.require_person),
  ) -> dict:
      try:
          back = await machines.plant().set_serving(request.app, name, body.serving)
      except machines.UnknownMachine as exc:
          raise HTTPException(status_code=404, detail=str(exc)) from exc
      except machines.PlantUnavailable as exc:
          raise HTTPException(status_code=502, detail=str(exc)) from exc
      return machines.machine_json(back)
  ```

  In `app/main.py`:
  - Add `machines_api,` to the `from app import (...)` block (between `governance_api,` and `models_catalog,`).
  - Add `app.include_router(machines_api.router)` after line 136 (`resources_api.router`).

- [ ] **Step 9: run green.** Run the same command as Step 7. Expected: `7 passed`.

#### 6.3 The two tools, the registry, AUTO_RUN and the prompt

- [ ] **Step 10: write the failing tests.** Create `tests/test_tools_machines.py`:

  ```python
  """S40 — her machines: where models run, and the one switch on each.

  Both tools read and write through app/machines.py against the fake gateway's
  /admin/engines — the same fixture the Settings tile's API is pinned on, so
  what she says and what the page shows cannot come from two readings."""

  from __future__ import annotations

  import inspect
  import uuid

  import httpx
  import pytest

  from app import chat, machines, tools
  from app.identity import Person
  from app.main import app as core_app
  from app.tools.base import ToolFailure
  from tests import fakes
  from tests.fakes import FakeGateway


  def _owner() -> Person:
      return Person(id=uuid.uuid4(), name="jeremy", role="owner")


  class _Dead(httpx.AsyncBaseTransport):
      async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
          raise httpx.ConnectError("connection refused", request=request)


  async def _call(name: str, args: dict, sink: list | None = None) -> str:
      ctx = tools.context_for(core_app, _owner(), facts_sink=sink)
      return await tools.REGISTRY[name].executor(args, ctx)


  async def test_status_reads_every_machine_live_and_leaves_a_fact_for_each(mount_peers):
      gateway = FakeGateway(engines=[
          fakes.engine_view(tags={"qwen3.8:27b": 17_817_600_000, "qwen3:8b": 5_225_388_164})
      ])
      mount_peers(gateway=gateway)
      sink: list[dict] = []
      said = await _call("machine_status", {}, sink)
      assert gateway.queries[-1] == b"live=true"
      assert f"hub: answering (checked now, {fakes.ENGINE_AT})" in said
      assert "serving is on" in said and "always on" in said
      assert f"computes on {fakes.ENGINE_GPU}" in said and "runtime container" in said
      assert "qwen3.8:27b (16.6 GB)" in said and "qwen3:8b (4.9 GB)" in said
      assert "hub:<model> runs on hub" in said
      assert sink == [
          {"machine": "hub", "answering": True, "checked_now": True, "at": fakes.ENGINE_AT}
      ]


  async def test_a_machine_that_did_not_answer_is_said_in_the_gateways_words(mount_peers):
      view = fakes.engine_view(state="unreachable", reason="ConnectError: connection refused",
                               tags=None)
      mount_peers(gateway=FakeGateway(engines=[view]))
      sink: list[dict] = []
      said = await _call("machine_status", {}, sink)
      assert "hub: NOT answering" in said and "ConnectError: connection refused" in said
      assert "what is installed could not be read" in said
      assert sink[0]["answering"] is False and sink[0]["checked_now"] is True


  async def test_a_switched_off_machine_says_routing_skips_it(mount_peers):
      view = fakes.engine_view(serving=False, state="switched_off")
      mount_peers(gateway=FakeGateway(engines=[view]))
      sink: list[dict] = []
      said = await _call("machine_status", {}, sink)
      assert "hub: switched off for models, so routing skips it" in said
      assert "serving is off" in said
      assert sink[0]["answering"] is True  # its installed list came back


  async def test_one_machine_by_name_and_an_unlisted_name_is_a_stated_failure(mount_peers):
      mount_peers(gateway=FakeGateway(engines=[fakes.engine_view(), fakes.engine_view("box")]))
      said = await _call("machine_status", {"machine": "box"})
      assert "box: answering" in said and "hub: answering" not in said
      with pytest.raises(ToolFailure, match="no machine named 'dell' runs models — the gateway "
                                            "lists: hub, box"):
          await _call("machine_status", {"machine": "dell"})


  async def test_a_gateway_that_cannot_be_asked_is_a_failure_never_no_machines(mount_peers):
      mount_peers(gateway=FakeGateway(engines=[]))
      core_app.state.peer_transports[fakes.GATEWAY_URL] = _Dead()
      sink: list[dict] = []
      with pytest.raises(ToolFailure, match="could not ask the gateway where models run — "
                                            "the gateway could not be reached"):
          await _call("machine_status", {}, sink)
      assert sink == []  # nothing was established, so nothing is recorded


  async def test_configure_switches_off_and_says_the_value_it_read_back(mount_peers):
      gateway = FakeGateway(engines=[fakes.engine_view()])
      mount_peers(gateway=gateway)
      said = await _call("machine_configure", {"machine": "hub", "serving": False})
      assert said.startswith(
          "hub is switched off for models: serving read back as false (state switched_off)"
      )
      assert gateway.seen[-2:] == [
          ("/admin/engines/hub", {"serving": False}), ("/admin/engines/hub", None),
      ]


  async def test_a_switch_that_does_not_read_back_is_a_failure_nothing_called_changed(
      mount_peers
  ):
      mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()], engine_put_sticks=False))
      with pytest.raises(ToolFailure, match=r"did not read back as off \(it reads True\) — "
                                            "nothing is confirmed changed"):
          await _call("machine_configure", {"machine": "hub", "serving": False})


  async def test_an_unknown_machine_is_refused_in_the_gateways_words(mount_peers):
      mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
      with pytest.raises(ToolFailure, match="no machine named 'dell' runs models — "
                                            "no engine named 'dell'"):
          await _call("machine_configure", {"machine": "dell", "serving": False})


  async def test_a_call_that_does_not_fit_the_schema_moves_nothing(mount_peers):
      gateway = FakeGateway(engines=[fakes.engine_view()])
      mount_peers(gateway=gateway)
      ctx = tools.context_for(core_app, _owner())
      result, ok = await tools.dispatch("machine_configure", '{"machine": "hub"}', ctx)
      assert not ok and result.startswith("Error: ")
      result, ok = await tools.dispatch(
          "machine_configure", '{"machine": "hub", "serving": "no"}', ctx
      )
      assert not ok
      assert gateway.seen == []


  def test_the_tools_say_which_side_they_are_on():
      status, configure = tools.REGISTRY["machine_status"], tools.REGISTRY["machine_configure"]
      assert status.reads_only is True and status.ephemeral is True
      assert status.result_kind == tools.RESULT_KIND_LISTING
      assert configure.reads_only is False and configure.ephemeral is False
      assert configure.parameters["required"] == ["machine", "serving"]
      assert configure.parameters["properties"]["serving"]["type"] == "boolean"


  async def test_an_eval_machine_is_switched_in_the_fixture_never_at_the_gateway(mount_peers):
      gateway = FakeGateway(engines=[fakes.engine_view()])
      mount_peers(gateway=gateway)
      token = machines.PLANT.set(machines.FixturePlant({"eval_box": {}}))
      try:
          sink: list[dict] = []
          said = await _call("machine_status", {}, sink)
          assert "hub: answering" in said and "eval_box: answering" in said
          assert [fact["machine"] for fact in sink] == ["hub", "eval_box"]
          back = await _call("machine_configure", {"machine": "eval_box", "serving": False})
          assert "serving read back as false" in back
          assert not any(path.startswith("/admin/engines/") for path, _ in gateway.seen)
      finally:
          machines.PLANT.reset(token)


  def test_the_prompt_says_where_models_run_from_the_tools_own_names():
      prompt = chat.stable_system_prompt("m", tools.tool_names())
      assert "a model id names its machine before its first colon" in prompt
      assert "only from machine_status" in prompt
      assert "only with machine_configure, reporting the value it read back" in prompt
      assert "names its machine" not in chat.stable_system_prompt("m", ("get_time",))
      source = inspect.getsource(chat.stable_system_prompt)
      assert '"machine_status"' not in source and '"machine_configure"' not in source
  ```

  In `tests/test_tools_registry.py`, the pinned sets move. Reason: two registered tools, 39 → 41. Insert this history note after line 113, before `assert set(tools.REGISTRY) == {`, adding the landing date in the same `(slice N, YYYY-MM-DD)` form the neighbouring notes use:

  ```python
      #
      # Deliberate snapshot update (slice 40): machine_status and
      # machine_configure (tools/machines.py), so THIRTY-NINE -> FORTY-ONE:
      # machines. The hub lane names every model by the machine that runs it
      # (hub:qwen3:8b), and she could neither say where a model ran nor take a
      # machine out of the chains — the owner would have opened Settings for a
      # question he had asked her. The switch is availability, never permission
      # (D2): the gateway's routing is its only reader and nothing waits on him,
      # which is why test_no_approvals stays green beside this.
  ```

  In the set, after `"notice_seen",` at line 184:

  ```python
          # S40: where models run, and the one switch per machine.
          # THIRTY-NINE -> FORTY-ONE.
          "machine_status",
          "machine_configure",
  ```

  In the `reads_only` pin, after `"notices",` at line 546:

  ```python
          # S40: reading the gateway's engine list changes nothing. Its twin,
          # machine_configure, is deliberately NOT here — it flips a switch.
          "machine_status",
  ```

  In the changes list, after `"delegate_to_agent",` at line 569, add `"machine_configure",`.

- [ ] **Step 11: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t6" uv run pytest tests/test_tools_machines.py tests/test_tools_registry.py tests/test_live_facts.py -q
  ```

  Expected failures:
  - `KeyError: 'machine_status'` in `REGISTRY`.
  - Registry set equality: the two names are missing.
  - `test_live_facts` stays green for now.

- [ ] **Step 12: implement.** Create `services/core/app/tools/machines.py`:

  ```python
  """Her machines: where models run, and the one switch she may set on each (S40).

  A MACHINE here is an engine the gateway serves models through (the bundled
  `hub` today; S44 adds one per paired machine). Everything she says about one
  is read from the gateway at the moment she is asked, through app/machines.py
  — core's one reader — and nothing is kept between turns.

  machine_status reads. It changes nothing, reaches only the gateway's own
  list, and its one argument is a name checked against that list, which is why
  the backend may run it unasked (live_facts.AUTO_RUN). Each machine it reports
  leaves a structured fact on the span — {"machine", "answering",
  "checked_now", "at"} — so what she then says about it is checkable against a
  record rather than a sentence.

  machine_configure sets `serving`: whether that machine runs models for the
  routing chains. It reports the value the gateway READS BACK, never the value
  it sent (the models.py chat.model pattern), and a read-back that disagrees is
  a failure, stated, with nothing called changed. Neither is an approval of
  anything (owner ruling 2026-09-03).
  """

  from __future__ import annotations

  from datetime import UTC, datetime

  from app import machines
  from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure


  def _now() -> str:
      return datetime.now(UTC).isoformat()


  def _size(size: object) -> str:
      if isinstance(size, int) and not isinstance(size, bool):
          return f"{size / 1024**3:.1f} GB"
      return "size not stated"


  def _switch(serving: bool) -> str:
      return "on" if serving else "off"


  def _answering(view: dict) -> bool | None:
      """Did it answer the gateway? Only what the reading says: True or False
      from the state, True for a switched-off machine whose list came back,
      None when nothing tells — never guessed."""
      state = view.get("state")
      if state == "ready":
          return True
      if state == "unreachable":
          return False
      if state == "switched_off" and view.get("tags") is not None:
          return True
      return None


  def _describe(view: dict, checked_now: bool) -> str:
      name, state = view["name"], view.get("state")
      when = view.get("observed_at") or "never"
      heard = f"checked now, {when}" if checked_now else f"not checked now — last read {when}"
      if state == "ready":
          head = f"{name}: answering ({heard})"
      elif state == "unreachable":
          reason = view.get("reason") or "the gateway stated no reason"
          head = f"{name}: NOT answering ({heard}) — {reason}"
      elif state == "switched_off":
          head = f"{name}: switched off for models, so routing skips it ({heard})"
      else:
          reason = view.get("reason") or "the gateway did not contact it"
          head = f"{name}: not checked now — {reason}; last read {when}"
      serving = view.get("serving")
      bits = [
          "serving is on" if serving is True else "serving is off" if serving is False
          else "serving not stated",
          "always on" if view.get("lifecycle") == "always_on"
          else f"lifecycle {view.get('lifecycle')}",
          f"computes on {view['compute']}" if view.get("compute") else "compute not stated",
          f"runtime {view['runtime']}" if view.get("runtime") else "runtime not stated",
      ]
      tags = view.get("tags")
      if isinstance(tags, dict) and tags:
          listed = ", ".join(f"{model} ({_size(size)})" for model, size in sorted(tags.items()))
          as_of = view.get("tags_as_of")
          bits.append(f"installed{f' as of {as_of}' if as_of else ''}: {listed}")
      elif isinstance(tags, dict):
          bits.append("no models installed")
      else:
          bits.append("what is installed could not be read")
      return f"{head}; " + "; ".join(bits) + "."


  async def machine_status(args: dict, ctx: ToolContext) -> str:
      wanted = str(args.get("machine") or "").strip()
      try:
          views = await machines.plant().engines(ctx.app, live=True)
      except machines.PlantUnavailable as exc:
          raise ToolFailure(f"could not ask the gateway where models run — {exc}") from exc
      if wanted:
          named = [view for view in views if view["name"] == wanted]
          if not named:
              listed = ", ".join(view["name"] for view in views) or "none"
              raise ToolFailure(
                  f"no machine named {wanted!r} runs models — the gateway lists: {listed}"
              )
          views = named
      if not views:
          return "The gateway lists no machine that runs models."
      first = views[0]["name"]
      lines = [
          f"{len(views)} machine(s) run models for Nova, read from the gateway now. A model "
          f"id names its machine before its first colon ({first}:<model> runs on {first})."
      ]
      for view in views:
          checked_now = view.get("state") != "unobserved"
          lines.append(_describe(view, checked_now))
          if ctx.facts_sink is not None:
              ctx.facts_sink.append(
                  {
                      "machine": view["name"],
                      "answering": _answering(view),
                      "checked_now": checked_now,
                      "at": view.get("observed_at") or _now(),
                  }
              )
      return "\n".join(lines)


  async def machine_configure(args: dict, ctx: ToolContext) -> str:
      name = str(args.get("machine") or "").strip()
      if not name:
          raise ToolFailure("machine_configure needs a machine's name — machine_status lists them")
      serving = args.get("serving")
      if not isinstance(serving, bool):
          raise ToolFailure("serving must be true or false")
      try:
          back = await machines.plant().set_serving(ctx.app, name, serving)
      except machines.UnknownMachine as exc:
          raise ToolFailure(f"no machine named {name!r} runs models — {exc}") from exc
      except machines.PlantUnavailable as exc:
          raise ToolFailure(f"{name}'s switch is not confirmed set — {exc}") from exc
      read = back.get("serving")
      if read is not serving:
          raise ToolFailure(
              f"{name}'s serving switch did not read back as {_switch(serving)} (it reads "
              f"{read!r}) — nothing is confirmed changed"
          )
      effect = (
          "the gateway's routing skips every link on it until it is switched back on"
          if not serving
          else "the gateway's routing may use it again"
      )
      return (
          f"{name} is switched {_switch(serving)} for models: serving read back as "
          f"{str(read).lower()} (state {back.get('state')}); {effect}."
      )


  MACHINE_STATUS = Tool(
      name="machine_status",
      description=(
          "Where Nova's models run, read from the gateway right now: every machine that runs "
          "models, whether it is answering (checked now), whether it is switched on for "
          "models, what it computes on and in which runtime, and which models it has "
          "installed. A model id names its machine before its first colon. Use it before "
          "saying where a model runs, whether a machine is up, or what is installed on it. "
          "Reads only."
      ),
      parameters={
          "type": "object",
          "properties": {
              "machine": {
                  "type": "string",
                  "description": "One machine, by the name this tool lists; omit for every one.",
              },
          },
          "additionalProperties": False,
      },
      executor=machine_status,
      # A live, point-in-time reading: "hub is answering" recalled a week later
      # is exactly the stale present `ephemeral` exists to stop.
      ephemeral=True,
      reads_only=True,
      # It enumerates machines and their installed models (with sizes); declared
      # so a list she presents from it is never read as one nothing produced.
      result_kind=RESULT_KIND_LISTING,
  )

  MACHINE_CONFIGURE = Tool(
      name="machine_configure",
      description=(
          "Switch whether a machine runs models for Nova (its serving switch). Off: the "
          "gateway's routing skips every link on that machine and the next link in each chain "
          "answers. On: it may serve again. The result states the value the gateway read "
          "back — say what changed only from that line."
      ),
      parameters={
          "type": "object",
          "properties": {
              "machine": {"type": "string",
                          "description": "The machine, by the name machine_status lists."},
              "serving": {"type": "boolean",
                          "description": "true lets it run models; false switches it off."},
          },
          "required": ["machine", "serving"],
          "additionalProperties": False,
      },
      executor=machine_configure,
  )

  TOOLS: tuple[Tool, ...] = (MACHINE_STATUS, MACHINE_CONFIGURE)
  ```

  In `app/tools/__init__.py`:
  - Add `machines,` to the import tuple (lines 38-54, between `inference,` and `memory_tools,`).
  - In `REGISTRY` after `*inference.TOOLS,` (line 95), add:

  ```python
          # S40: where models run, and the one switch on each machine
          # (tools/machines.py) — read and set through app/machines.py.
          *machines.TOOLS,
  ```

  In `app/chat.py`, insert this between lines 868 and 869 (after the delegation block, before `if agent_block:`):

  ```python
      # S40: the machine sentence, keyed on the tools' own constants like the
      # delegation one — a rename moves the sentence with it, and an agent whose
      # subset lacks the tool is never told to use it.
      status_tool = tools.machines.MACHINE_STATUS.name
      configure_tool = tools.machines.MACHINE_CONFIGURE.name
      if status_tool in tool_names:
          prompt += (
              " Models run on machines, and a model id names its machine before its first "
              f"colon: say where a model runs, or whether a machine is answering, only from "
              f"{status_tool}"
              + (
                  f", and switch a machine's models on or off only with {configure_tool}, "
                  "reporting the value it read back"
                  if configure_tool in tool_names
                  else ""
              )
              + "."
          )
  ```

- [ ] **Step 13: run and see the classification tripwire fire.** Run the same command as Step 11. Expected: `tests/test_live_facts.py::test_every_read_only_tool_is_classified_one_way_or_the_other` fails with `['machine_status']`. That is the intended alarm. Everything else passes.

- [ ] **Step 14: classify it.** In `app/live_facts.py` `AUTO_RUN`, after `"list_timers",` (line 99):

  ```python
          # S40. Where a model runs is answered by the gateway's own reading of
          # its machines, and a recalled "the 27B runs on hub" is exactly a claim
          # this settles. Its one argument is a machine name checked against that
          # same list, so a wrong name is a stated failure; in S40 every machine
          # it reads is the bundled engine on this host. (Carried to S44/S46: once
          # a machine can be asleep, re-decide whether an UNASKED live read may
          # reach it.)
          "machine_status",
  ```

- [ ] **Step 15: run green.** Run the same command as Step 11, plus `tests/test_chat_agents.py tests/test_eval_runner.py tests/test_no_approvals.py tests/test_distil.py tests/test_agents.py tests/test_agents_api.py`. Expected: all passed.

#### 6.4 Route verdict in words

- [ ] **Step 16: write the failing test.** Append to `tests/test_tools_route.py`:

  ```python
  def test_a_machine_switched_off_is_said_in_words():
      body = {
          "role": "chat",
          "chain": [
              {"link": 1, "id": "hub:qwen3.8:27b", "verdict": "switched_off",
               "reason": "hub is switched off for models"},
              {"link": 2, "id": "openrouter:gpt-x", "verdict": "runnable", "reason": None},
          ],
          "would_serve": {"served_by": "openrouter:gpt-x", "reason": "fell back to link 2"},
          "reason": "fell back to link 2",
      }
      text = route.describe(body)
      assert ("1. hub:qwen3.8:27b: skipped — its machine is switched off for models "
              "(hub is switched off for models)") in text
      unreachable = {**body, "chain": [{**body["chain"][0], "verdict": "unreachable"}]}
      assert "skipped — its machine did not answer" in route.describe(unreachable)
  ```

- [ ] **Step 17: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t6" uv run pytest tests/test_tools_route.py -q
  ```

  Expected: the text reads `switched_off` raw and "ollama could not be asked".

- [ ] **Step 18: implement.** In `app/tools/route.py`'s verdict map (lines 40-49), replace the `"unreachable"` entry and add `"switched_off"`:

  ```python
              "unreachable": "skipped — its machine did not answer",
              "switched_off": "skipped — its machine is switched off for models",
  ```

  Run the same command as Step 17. Expected: all passed.

- [ ] **Step 19: commit the tools and the surface**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && uv run ruff format app/machines.py app/machines_api.py app/tools/machines.py app/tools/__init__.py app/main.py app/live_facts.py app/chat.py app/tools/route.py tests/fakes.py tests/test_machines.py tests/test_machines_api.py tests/test_tools_machines.py tests/test_tools_registry.py tests/test_tools_route.py && uv run ruff check app/machines.py app/machines_api.py app/tools/machines.py app/tools/__init__.py app/main.py app/live_facts.py app/chat.py app/tools/route.py tests/fakes.py tests/test_machines.py tests/test_machines_api.py tests/test_tools_machines.py tests/test_tools_registry.py tests/test_tools_route.py
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff && git add services/core/app/machines.py services/core/app/machines_api.py services/core/app/tools/machines.py services/core/app/tools/__init__.py services/core/app/main.py services/core/app/live_facts.py services/core/app/chat.py services/core/app/tools/route.py services/core/tests/fakes.py services/core/tests/test_machines.py services/core/tests/test_machines_api.py services/core/tests/test_tools_machines.py services/core/tests/test_tools_registry.py services/core/tests/test_tools_route.py && git commit -m "$(printf 'feat(core): S40 machines — machine_status and machine_configure (39 -> 41)\n\nmachine_status reads every engine live and leaves {machine, answering,\nchecked_now, at} per machine (AUTO_RUN). machine_configure sets serving and\nreports the value the gateway reads back; a mismatch is a failure. GET/PATCH\n/api/v1/machines for the Settings tile. FixturePlant overlays eval_* machines\nfor a replay. One prompt sentence, keyed on the tools'"'"' own constants; the\nroute walk says switched_off in words.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
  ```

#### 6.5 Guards: any machine's prefix, an unbacked switch, and a disowned machine tool

- [ ] **Step 20: write the failing tests.**

  In `tests/test_guards.py`, replace `tool_span` (lines 24-32) with:

  ```python
  def tool_span(name: str, *, ok: bool = True, path=None, url=None, model=None,
                machine=None, serving=None):
      args: dict = {}
      if path is not None:
          args["path"] = path
      if url is not None:
          args["url"] = url
      if model is not None:
          args["model"] = model
      if machine is not None:
          args["machine"] = machine
      if serving is not None:
          args["serving"] = serving
      return SimpleNamespace(kind="tool", name=name, meta={"ok": ok, "args_redacted": args})
  ```

  Append after line 1655:

  ```python
  # -- S40: a model on a named machine, and a machine's switch ----------------


  def test_a_machine_qualified_model_claim_is_read_whole():
      """`hub:qwen3.8:27b` was cut at its second colon when only `ollama:` was
      read, so a pull of qwen3.8:4b backed a claim about qwen3.8:27b."""
      reply = "I pulled hub:qwen3.8:27b and it is ready."
      flagged = guards.narration_check(reply, [other_span()])
      assert flagged is not None and targets(flagged) == ["hub:qwen3.8:27b"]
      assert guards.narration_check(reply, [tool_span("model_pull", model="hub:qwen3.8:27b")]) is None
      assert guards.narration_check(reply, [tool_span("model_pull", model="qwen3.8:27b")]) is None
      assert guards.narration_check(reply, [tool_span("model_pull", model="hub:qwen3.8:4b")])
      # A pull on ANOTHER named machine does not back a claim naming this one.
      assert guards.narration_check(reply, [tool_span("model_pull", model="dell:qwen3.8:27b")])
      assert re.fullmatch(guards._MODEL_REF, "dell:hf.co/org/repo:Q4_K_M")


  def test_a_switch_claim_with_no_configure_span_is_flagged():
      for reply in (
          "I've switched chat models off on hub.",
          "Done — I turned off chat models for hub.",
          "I stopped hub from running chat models.",
          "I switched hub's chat models off.",
          "I switched hub off for chat models.",
      ):
          correction = guards.narration_check(reply, [other_span()])
          assert correction is not None, reply
          assert kinds(correction) == ["configured_machine"], reply
          assert targets(correction) == ["hub"], reply


  def test_a_switch_claim_is_backed_by_a_configure_span_naming_that_machine():
      reply = "I've switched chat models off on hub."
      backed = [tool_span("machine_configure", machine="hub", serving=False)]
      assert guards.narration_check(reply, backed) is None
      wrong = guards.narration_check(
          reply, [tool_span("machine_configure", machine="dell", serving=False)]
      )
      assert wrong is not None and targets(wrong) == ["hub"]
      failed = [tool_span("machine_configure", ok=False, machine="hub", serving=False)]
      assert guards.narration_check(reply, failed) is not None
      # "here" names no machine: any configure span backs it.
      assert guards.narration_check("I turned off chat models here.", backed) is None


  def test_ordinary_switch_talk_never_fires():
      for reply in (
          "I switched the lights off.",
          "You can switch chat models off on hub from Settings.",
          "Should I switch chat models off on hub?",
          "I'll switch chat models off on hub.",
          "I haven't switched anything off.",
          "The timer stopped running.",
          "I stopped the timer from running.",
      ):
          assert guards.narration_check(reply, [other_span()]) is None, reply
  ```

  Add `import re` to the imports of `test_guards.py` if it is missing.

  In `tests/test_capability_guard.py`, insert before the closing `]` of `MUST_FIRE` (line 76):

  ```python
      # S40: her machine tools are registered, so disowning them is a false denial.
      ("cant_see_where_models_run", "I can't see which machine your models run on.",
       "machine_status"),
      ("unable_to_check_where_models_run", "I'm unable to check where the models are running.",
       "machine_status"),
      ("no_access_to_machine_status", "I don't have access to the status of your machines.",
       "machine_status"),
      ("cant_switch_models_off_on_a_machine", "I can't switch off chat models on a machine.",
       "machine_configure"),
      ("not_able_to_stop_a_machine_serving", "I'm not able to stop a machine from running models.",
       "machine_configure"),
      ("changing_which_machine_trailing",
       "Changing which machine runs the models is not something I can do.", "machine_configure"),
  ```

  Insert before the closing `]` of `MUST_NOT_FIRE` (line 145):

  ```python
      # S40: no wake tool yet (S46) — honest. A scope limit — honest. A past,
      # specific failed switch — an honest report of one try.
      ("honest_no_wake_tool", "I can't wake machines up."),
      ("machine_scope_other_network", "I can't check where models run on another network."),
      ("machine_specific_past", "I couldn't switch off chat models on hub — the gateway refused."),
  ```

- [ ] **Step 21: run it and see it fail**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t6" uv run pytest tests/test_guards.py tests/test_capability_guard.py -q
  ```

  Expected failures:
  - `targets == ['hub:qwen3.8']`, and the bare-backed claim is flagged.
  - No `configured_machine` kind exists.
  - The six new MUST_FIRE cases get `None`.
  - The MUST_NOT_FIRE cases already pass.

- [ ] **Step 22: implement** in `app/guards.py`.

  Lines 58-74: add `_CONFIGURE_TOOLS = frozenset({"machine_configure"})` after `_REMOVE_TOOLS`, and add this `_KIND_TOOLS` entry:

  ```python
      "configured_machine": _CONFIGURE_TOOLS,
  ```

  Replace lines 116-134 (the comment, `_PULLED_MODEL` and `_REMOVED_MODEL`) with:

  ```python
  # A model reference, optionally machine-qualified: `qwen3:4b`, `user/name:tag`,
  # `hf.co/org/repo[:quant]`, or any of those behind the name of the machine
  # (the provider) that runs it — `hub:qwen3.8:27b`, `dell:qwen3:8b` (S40). The
  # prefix is a SHAPE, never a list of names: machines are whatever the gateway
  # lists, and a guard that knew them would be wrong the day one is added.
  # Before S40 only `ollama:` was read, so `hub:qwen3.8:27b` was cut at its
  # second colon and a claim about one tag was backed by a pull of another.
  # Anchored on a MODEL REFERENCE token — never a bare noun, so "I installed the
  # update" is ordinary chat and never fires.
  _ENGINE_PREFIX = r"[a-z0-9][a-z0-9_-]{0,31}:"
  _MODEL_BODY = r"(?:hf\.co/[\w.-]+/[\w.-]+(?::[\w.-]+)?|[\w.-]+(?:/[\w.-]+)?:[\w.-]+)"
  _ENGINE_QUALIFIED = re.compile(
      r"(?P<engine>[a-z0-9][a-z0-9_-]{0,31}):(?P<bare>" + _MODEL_BODY + r")", re.I
  )
  _PULLED_MODEL = re.compile(
      r"\bi(?:'ve|\s+have|\s+just|\s+have\s+just)?\s+(?:just\s+)?"
      r"(?:pulled|downloaded|installed)\s+(?:the\s+)?(?:model\s+)?"
      r"(?P<ref>(?:" + _ENGINE_PREFIX + r")?" + _MODEL_BODY + r")",
      re.I,
  )
  # "I removed / deleted / uninstalled <model ref>": the same anchor, backed
  # only by a successful model_remove span naming that ref.
  _REMOVED_MODEL = re.compile(
      r"\bi(?:'ve|\s+have|\s+just|\s+have\s+just)?\s+(?:just\s+)?"
      r"(?:removed|deleted|uninstalled)\s+(?:the\s+)?(?:model\s+)?"
      r"(?P<ref>(?:" + _ENGINE_PREFIX + r")?" + _MODEL_BODY + r")",
      re.I,
  )
  _MODEL_CLAIMS = frozenset({"pulled_model", "removed_model"})

  # "I switched chat models off on hub", "I turned off models for hub", "I
  # stopped hub from running chat models", "I switched hub off for chat models"
  # (S40): a completed change to a machine's serving switch. Anchored on a
  # SERVING noun so "I switched the lights off" stays ordinary chat; backed only
  # by a successful machine_configure span naming that machine. A clause that
  # names no machine ("here", "this machine") still claims the kind, and any
  # configure span backs it.
  _MACHINE_SERVING = (
      r"(?:(?:the|chat|local|ai)\s+){0,2}(?:models?|model\s+serving|serving|inference)"
  )
  _CONFIGURED_MACHINE = re.compile(
      r"\bi(?:['’]ve|\s+have|\s+just|\s+have\s+just)?\s+(?:just\s+)?(?:"
      + r"(?:switched|turned)\s+(?:off|on)\s+" + _MACHINE_SERVING
      + r"(?:\s+(?:on|for|at)\s+(?:the\s+)?(?P<m1>[\w.-]+))?"
      + r"|(?:switched|turned)\s+" + _MACHINE_SERVING + r"\s+(?:off|on)"
      + r"(?:\s+(?:on|for|at)\s+(?:the\s+)?(?P<m2>[\w.-]+))?"
      + r"|(?:switched|turned)\s+(?P<m3>[\w.-]+)['’]s\s+" + _MACHINE_SERVING + r"\s+(?:off|on)"
      + r"|(?:switched|turned)\s+(?:the\s+)?(?P<m4>[\w.-]+)\s+(?:off|on)\s+for\s+"
      + _MACHINE_SERVING
      + r"|stopped\s+(?:the\s+)?(?P<m5>[\w.-]+)\s+from\s+(?:running|serving)\s+"
      + _MACHINE_SERVING
      + r")",
      re.I,
  )
  _MACHINE_GROUPS = ("m1", "m2", "m3", "m4", "m5")
  # Words that sit where a machine's name would and name none.
  _NOT_A_MACHINE = frozenset(
      {"here", "there", "it", "this", "that", "them", "you", "me", "us", "now", "chat", "all",
       "every", "everything", "machine", "computer", "box", "pc", "server", "host", "engine"}
  )
  ```

  In `_claims_in`, after the `_REMOVED_MODEL` loop (line 825), add:

  ```python
      # changed a machine's serving switch (S40): the machine when one is named.
      for cm in _CONFIGURED_MACHINE.finditer(clause):
          named = next((cm.group(g) for g in _MACHINE_GROUPS if cm.group(g)), None)
          named = _strip_trailing_punct(named) if named else None
          if named and named.lower() in _NOT_A_MACHINE:
              named = None
          claims.append(("configured_machine", named, cm.group(0)))
  ```

  In `_target_of` (870-890), before the final `return None`:

  ```python
      if span.name == "machine_configure":
          machine = args.get("machine")
          return machine if isinstance(machine, str) else None
  ```

  Before `_backed` (line 893), add:

  ```python
  def _model_parts(ref: str) -> tuple[str | None, str]:
      """(machine, model) of a model reference — the machine only when the ref
      carries one (`hub:qwen3:8b`); a bare tag's colon is its own (`qwen3:8b`)."""
      ref = _strip_trailing_punct(ref.strip())
      m = _ENGINE_QUALIFIED.fullmatch(ref)
      return (m.group("engine").lower(), m.group("bare")) if m else (None, ref)


  def _same_model(claimed: str, touched: str) -> bool:
      c_engine, c_bare = _model_parts(claimed)
      t_engine, t_bare = _model_parts(touched)
      if c_engine and t_engine and c_engine != t_engine:
          return False  # a pull on another machine does not back this one
      return c_bare.rsplit("/", 1)[-1].lower() in t_bare.lower()
  ```

  In `_backed`, after the `if any(t is None ...) or not target: return True` block (lines 900-901):

  ```python
      if kind in _MODEL_CLAIMS:
          return any(_same_model(target, t) for t in span_targets)
      if kind == "configured_machine":
          return any(target.strip().lower() == (t or "").strip().lower() for t in span_targets)
  ```

  In `_CAPABILITY_TOOLS`, insert before the closing `)` at line 1364:

  ```python
      # S40 (the hub lane): her machine tools. "Where do your models run?" and
      # "stop running chat models here" are hers to answer and to do the moment
      # machine_status / machine_configure are registered, and a denial of either
      # is the S12 failure again. GENERAL nouns only (machines, models) — never a
      # machine's name — so an honest report about one machine is left alone.
      (
          re.compile(
              r"(?:see|seeing|check|checking|tell|telling|know|knowing|say|saying|find\s+out)\s+"
              r"(?:where|which\s+machines?|what\s+machines?|on\s+which\s+machines?)\s+"
              r"(?:(?:my|your|the|our|local|ai|language|chat)\s+){0,2}models?\s+"
              r"(?:run|runs|are\s+running|is\s+running|live|lives|are|is)\b"
              r"|(?:the\s+)?(?:status|state)\s+of\s+(?:(?:my|your|the|our|any)\s+)?machines\b",
              re.I,
          ),
          "machine_status",
      ),
      (
          re.compile(
              r"(?:switch|switching|turn|turning)\s+(?:off|on)\s+"
              r"(?:(?:the|local|chat|ai)\s+){0,2}(?:models?|model\s+serving|serving|inference)\s+"
              r"(?:on|for)\s+(?:a|any|the|your|my|this|that)\s+machines?\b"
              r"|(?:stop|stopping|start|starting)\s+(?:(?:a|any|the|your|this)\s+)?machines?\s+"
              r"from\s+(?:running|serving)\s+(?:(?:chat|local|ai)\s+)?models?\b"
              r"|(?:change|changing|control|controlling|configure|configuring|choose|choosing)\s+"
              r"(?:which|what)\s+machines?\s+(?:runs?|serves?)\s+"
              r"(?:(?:the|chat|local|your|my)\s+){0,2}models?\b",
              re.I,
          ),
          "machine_configure",
      ),
  ```

  Replace line 1862 with:

  ```python
  _MODEL_REF = r"(?:" + _ENGINE_PREFIX + r")?" + _MODEL_BODY
  ```

- [ ] **Step 23: run green.** Run the same command as Step 21, plus `tests/test_chat_honesty.py tests/test_chat_deferral.py tests/test_chat_bare_intent.py tests/test_state_guard.py`. Expected: all passed.

- [ ] **Step 24: the full core suite, then commit**

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && TEST_DATABASE_URL="postgresql://postgres:$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')@127.0.0.1:55432/nova_core_s40_t6" uv run pytest -q
  ```

  Expected: all passed. `test_eval_corpus` pins do not move here; T7 moves them. `test_no_approvals` stays green.

  ```bash
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core && uv run ruff format app/guards.py tests/test_guards.py tests/test_capability_guard.py && uv run ruff check app/guards.py tests/test_guards.py tests/test_capability_guard.py
  cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff && git add services/core/app/guards.py services/core/tests/test_guards.py services/core/tests/test_capability_guard.py && git commit -m "$(printf 'feat(core): S40 guards read any machine'"'"'s prefix and back a switch claim\n\nThe model-reference prefix is a shape, not ollama: (hub:qwen3.8:27b is read\nwhole; a pull on another named machine does not back it). Narration kind\nconfigured_machine is backed only by a machine_configure span naming that\nmachine. Two capability phrases (where models run / a machine'"'"'s serving)\nwith MUST_FIRE and MUST_NOT_FIRE cases.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
  ```

**Pinned tests that move in Task 6, with their reasons**
- `test_tools_registry.py` `:72-114` (history note), `:115-185` (+2), `:501-547` (+`machine_status`), `:550-571` (+`machine_configure`). Reason: two registered tools.
- `test_capability_guard.py` MUST_FIRE +6 and MUST_NOT_FIRE +3. Reason: new phrases need their calibration corpus.
- `test_guards.py:24-32`: the helper gains `machine`/`serving`.
- `test_live_facts.py` is not edited. It goes red at Step 13 by design and green at Step 15.
- Stays green without edits: `test_no_approvals.py`, `test_chat_agents.py` (the delegation and AST pins), `test_eval_runner.py:456-480` (the prompt is computed on both sides), `test_agents*.py` (listing sets are derived).

**Carries for T9's close-out**
1. `stack_claim_check` is not scoped to machines. After "stop running chat models here", a cloud-served turn saying "the model is unavailable" is corrected. r1's design scoped it; S40 does not.
2. Decide whether `machine_status` may do an unasked live read before any `wake_on_lan` engine exists (S44/S46, P0-2).
3. Once there are two or more machines, the vision picker should write qualified ids.
4. `inference_degraded` and `resources` read the one readable card. S44 must match `served_on` devices to an engine's `compute`.
5. A bare-vs-qualified `model_remove` is refused conservatively when two machines hold the same model.
6. Sweep the opaque `ollama:` strings in core fixtures.
7. Speed baselines restart from zero after deploy, by design. Note it in ROADMAP.

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/machines.py (new: the plant, `split`, `cards`, `FixturePlant`, `machine_json`)
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/model_speed.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/checks/stack.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/guards.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/tests/fakes.py