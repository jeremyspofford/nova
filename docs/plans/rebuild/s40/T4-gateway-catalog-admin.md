### Task 4: Gateway catalogue, fit, probe, pull, remove and drift per engine; delete `/admin/vram`; shadow-name check

**Files**
- Modify `services/gateway/app/admin.py`:
  - imports `:23-40`
  - `_resident_models` `:110-138`
  - `_free_and_total_vram_gb` `:141-185`
  - `vram_route` `:188-227` (DELETED; `engine_card` replaces it)
  - `_latest_probes` `:230-256`
  - `_fit_context` `:259-277`
  - `suggest_route` `:280-301`
  - `_PULLS_IN_FLIGHT` `:304-310`
  - `_preflight_line` `:313-361`
  - `pull` `:364-462`
  - `_footprint_vram_mb` `:465-499` (becomes `_footprint`)
  - `probe` `:502-589`
  - `_refuse_name_that_shadows_a_local_tag` `:659-681`
  - `create_provider` `:696-711`
  - `remove_model` `:1128-1158`
- Modify `services/gateway/app/catalog.py`:
  - docstring and imports `:1-45`
  - `local_row` `:77-89`
  - `library_row` `:167-176`
  - `_probes_by_model` `:288-303`
  - `build` `:317-417`
  - `hf_page_rows`, `hf_repo_row`, `mark_hub_installed`, `installed_names` `:423-467`
  - `check_drift` `:567-609`
  - new `engine_and_model`
- Modify `services/gateway/app/catalog_row.py` after `:36`: `LIBRARY`.
- Modify `services/gateway/app/hf_hub.py:36,572`: row id `library:…`.
- Modify `services/gateway/app/usage.py:557-590`: `record_probe(..., served_on=None)`.
- Modify `services/gateway/app/routing.py`: the `latest_probes(...)` call inside `standby`. It is at `:373` today; T3 may have moved it.
- Modify `services/gateway/app/engines_api.py` (from T2): `GET /admin/engines/{name}` gets `vram` and `fit_frame` from `admin.engine_card`.
- Modify `services/gateway/app/engines.py` (from T2): `bundled_devices()`, **only if absent** (see CONTRACT PROBLEM 1).
- Tests:
  - Create `services/gateway/tests/test_engine_card.py`.
  - Modify `tests/conftest.py:84-109`, `tests/test_admin_suggest_fit.py`, `tests/test_admin_probe.py`, `tests/test_admin_pull.py`, `tests/test_catalog.py`, `tests/test_hf_hub.py:402-405` and `tests/test_providers.py:270-292,839-853`.

**Interfaces**

*Consumes, from T1:*
- `compute_id.served_on(size, size_vram, accelerators, cpu) -> str | None`
- `compute_id.bundled_accelerators(vram_reading: dict) -> list[str]`
- `compute_id.gpu_cuda(uuid) -> str`
- `compute_id.cpu_slug(cpuinfo_text, meminfo_text, nproc) -> str`
- `compute_id.parse(value) -> list[str]`
- `devices_vram.Vram(..., uuid=, name=)`, with `as_dict()` carrying `uuid` and `name`
- `probes` columns `provider, compute, runtime, path`
- providers CHECK `name <> 'library'`
- conftest `_TABLES` including `engines` and `engine_models`

*Consumes, from T2:*
- `engines.BUILTIN == "hub"`
- `engines.is_engine(row) -> bool`
- `async engines.rows(pool) -> list[dict]` (builtin first)
- `async engines.get(pool, name) -> dict`, raising `engines.UnknownEngine`
- `async engines.installed_sizes(app, pool, name) -> dict[str, int | None] | None`
- `engines.clear_cache() -> None`
- `engines.observe(...)` and `EngineView` (inside `engines_api`)
- `providers.base_url_of`: the builtin by flag, others by their stored `base_url`
- `backends.save_config({"kind":"ollama"})` targets `hub`
- `ensure_builtin` seeds `hub` plus its `engines` row

*Consumes, from T3:*
- `usage.Event.served_on`, written by `usage.record`
- `routing.standby` still receives `fit_context` / `latest_probes` callables

*Produces:*
- `admin._fit_context(app, pool, row: dict | None = None) -> dict` with keys `{engine, compute, fit_frame, free_gb, total_gb, reason, sizes}`. `row=None` means the builtin.
- `admin._latest_probes(pool, slugs: list[str], *, compute: str | None) -> dict[str, dict]` (`compute` is keyword-only and required).
- `admin.engine_card(app, row) -> {"vram": {...}, "fit_frame": "vram" | "ram" | None}`. `vram` is a superset of the old `/admin/vram` body: `total_mb, used_mb, free_mb, util_pct, reason, total_gb, free_gb, used_gb, resident, resident_reason, free_after_switch_gb` (+ `uuid`, `name`). Each resident entry is `{model, vram_mb, size_bytes, size_vram_bytes}`.
- `catalog.engine_and_model(pool, raw) -> tuple[dict, str]`: raises `ValueError`, which becomes a 400.
- `catalog.installed_names(app, pool) -> dict[str, set[str] | None]`
- `catalog.LIBRARY == catalog_row.LIBRARY == "library"`
- Catalogue shape:
  - each engine source is `{"key": <engine>, "kind": "engine", ok, rows, fetched_at[, note]}`;
  - local rows are id `"{engine}:{tag}"` with `provider` = engine;
  - library rows are id `"library:{slug}"` with `provider` `"library"`;
  - HF rows are `"library:hf.co/…"`;
  - each row's `probe` block gains `compute`.
- `POST /admin/probe` response and `probes` row gain `provider, compute, runtime, path`. The probe's `usage_events.served_on` = `compute`.
- `DELETE /admin/models` returns `{"engine", "removed", "verified", "installed_now"}`.
- `/admin/catalog/drift` body gains `"engine"`.
- The pull preflight line gains `"engine"`.
- `admin._PULLS_IN_FLIGHT: dict[tuple[str, str], str]`, keyed by `(engine, canonical_ref)`.
- `GET /admin/vram` returns 404.
- `usage.record_probe(..., served_on: str | None = None)`.
- `engines.bundled_devices() -> tuple[list[str], str | None]` (CONTRACT PROBLEM 1).

**CONTRACT PROBLEMS / NOTES**

1. **No shared function for the bundled engine's live devices.** The contract gives compute_id's building blocks but no function that returns the bundled engine's `(accelerators, cpu)` right now. T3 needs it (`X-Nova-Served-On` in data_plane) and T4 needs it (the probe stamp). Two private copies could let a response header and a probe row disagree about the same hardware.
   - Resolution: T4 calls `engines.bundled_devices()`.
   - At step 4.0, run `grep -rn "bundled_accelerators(" services/gateway/app`.
   - If T3 already wrote an equivalent under another name, T4 calls that one and does not add a second.
   - If none exists, T4 adds it (code in 4.2) and points T3's call site at it in the same commit.
2. **`fit_frame` for another machine.** The contract says `"vram" | "ram"`. For an engine whose card this hub cannot read (any non-builtin before S44; in S40 only test rows), T4 returns **None** (omitted, never guessed). The builtin always gets `"vram"` or `"ram"`.
3. **The RAM frame's maths are not in S40.** With `fit_frame == "ram"` the builtin's verdicts stay `unknown` with the card's own reason, as today. The first CPU engine is S44/S45's N150. Carry: "RAM-frame fit: MemAvailable + resident sizes".
4. **Qualified ids.** `remove_model`, `check_drift` and `pull` accept `engine:tag`. A bare tag resolves to **the only engine** and is refused by name when there are several. This keeps core `tools/models.py:438-457` and web `ModelsPage.tsx:308,324,637` working (they send bare tags) until T5/T8/S44.
5. **The shadow check reads the default engine live** through its adapter, not `observe`, so it does not depend on whether T2's `EngineView.tags` carries `last_tags` while unreachable. The `last_tags` fallback is S46's.
6. **The pull free-space check** still reads the gateway's own `/models` (`admin.py:56-57,341-343`; the wrong volume, a pre-existing carry) for the builtin, and **skips it for another machine**, saying so.
7. **Do not deploy between T4 and T5.** Core `tools/inference.py:36`, `checks/inference.py:66` and `resources_api.py:35` still call `/admin/vram`, and `checks/stack.py:49-50,211,259` still reads the catalogue source key `ollama`.

---

#### 4.0 Preconditions and scratch DB

- [ ] Verify that T1–T3 produced what T4 consumes. Each grep must print a hit; stop and reconcile if one is missing:
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway
grep -n '^BUILTIN\|^def is_engine\|^async def rows\|^async def get\|^class UnknownEngine\|^async def installed_sizes\|^def clear_cache\|^async def observe' app/engines.py
grep -n '^def served_on\|^def bundled_accelerators\|^def gpu_cuda\|^def cpu_slug\|^def parse' app/compute_id.py
grep -n 'uuid' app/devices_vram.py
grep -n 'served_on' app/usage.py
grep -n '"engines"\|"engine_models"' tests/conftest.py
grep -n 'engines/{name}' app/engines_api.py
grep -rn 'bundled_accelerators(' app/            # CONTRACT PROBLEM 1: reuse T3's if present
grep -n 'latest_probes(' app/routing.py           # the standby call site T4 edits
uv run python -c "from app import providers; assert providers.base_url_of({'adapter':'ollama','builtin':False,'base_url':'http://dell.test/'})=='http://dell.test'"
```
- [ ] Create T4's own scratch DB:
```bash
docker exec nova-scratch-pg psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='nova_gateway_s40_t4'" | grep -q 1 || docker exec nova-scratch-pg createdb -U postgres nova_gateway_s40_t4
```
- [ ] In `tests/conftest.py`, make `fresh_upstream_caches` also clear the engines cache (skip if T2 already did), and add a `second_engine` fixture:
```python
@pytest.fixture(autouse=True)
def fresh_upstream_caches():
    """... (docstring kept) — and the per-engine tags cache (S40), so one
    test's listing never answers another's."""
    from app import engines, hf_hub, ollama_registry

    hf_hub.clear()
    ollama_registry.clear()
    engines.clear_cache()
    yield
    hf_hub.clear()
    ollama_registry.clear()
    engines.clear_cache()


@pytest.fixture
async def second_engine(pool, mount_backend):
    """A second machine that runs models, `dell`, as ROWS ONLY. S40 builds no
    way to link one (S44 does); these rows are how every per-engine site
    proves it is not the builtin under another name. Its ollama is a fake at
    http://dell.test listing the 27B."""
    from tests.fakes import FakeOllama

    fake = FakeOllama(tags=("qwen3.8:27b",))
    mount_backend("http://dell.test", fake.app)
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key, builtin, local, "
        "is_default) VALUES ('dell', 'ollama', 'http://dell.test', 'static-bearer', "
        "'dell-token', false, true, false)"
    )
    await pool.execute("INSERT INTO engines (provider) VALUES ('dell') ON CONFLICT DO NOTHING")
    return fake
```

#### 4.1 Fit per engine, keyed by (compute, model)

- [ ] **Failing tests** in `tests/test_admin_suggest_fit.py`.
  - Replace `:14-35` with:
```python
from app import backends, compute_id, devices_vram
from app import curated as curated_mod
from tests.conftest import requires_db
from tests.fakes import FakeOllama

pytestmark = requires_db

IDLE_FREE_MB = 21914.0
# The card every test here fakes, by the id nvidia-smi gives it. S40 keys fit
# by (compute, model) (D10): a probe row is read for a model only when it was
# taken on THIS card, and the CUDA uuid is how the card is named.
CARD_UUID = "GPU-8a1c2f3e-5b6d-4c7e-9f80-1a2b3c4d5e6f"
COMPUTE = compute_id.gpu_cuda(CARD_UUID)


def _card(monkeypatch, total_mb: float, free_mb: float, uuid: str | None = CARD_UUID) -> None:
    """Fake the one live nvidia-smi read the whole fit path now shares."""

    async def _read():
        return devices_vram.Vram(
            total_mb=total_mb,
            used_mb=total_mb - free_mb,
            free_mb=free_mb,
            uuid=uuid,
            name="NVIDIA GeForce RTX 3090",
        )

    monkeypatch.setattr(devices_vram, "read_vram", _read)


async def _insert_probe(
    pool,
    model: str,
    vram_mb: int | None,
    *,
    ok: bool = True,
    error: str | None = None,
    age_days: int = 0,
    frame: str = "model",
    provider: str | None = "hub",
    compute: str | None = COMPUTE,
) -> None:
    """A probes row as POST /admin/probe writes it since S40: stamped with the
    engine it ran on and the card that held it."""
    await pool.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error, frame, provider, "
        "compute, created_at) VALUES ($1, 'ollama', $2, 100, $3, $4, $5, $6, $7, "
        "now() - make_interval(days => $8))",
        model, ok, vram_mb, error, frame, provider, compute, age_days,
    )
```
  - Rewrite these raw `INSERT INTO probes` statements to use the helper:
    - `:133-136` becomes `await _insert_probe(pool, "huge:70b", 30720)`.
    - `:172-175` becomes `await _insert_probe(pool, "qwen3:8b", 9508)`.
    - `:193-206` becomes:
      - `await _insert_probe(pool, "qwen3:8b", None, ok=False, error="timed out")`
      - `await _insert_probe(pool, "qwen3:8b", 8000, age_days=1)`
      - `await _insert_probe(pool, "qwen3:8b", 9508)`
    - `:294-297` becomes `await _insert_probe(pool, "qwen3.8:27b", 22369, frame="whole_card")`.
    - `:317-320` stays a raw INSERT **without** `frame` (that is what the test pins) but gains `provider, compute`:
```python
    await pool.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error, provider, compute) "
        "VALUES ('qwen3.8:27b', 'ollama', true, 100, 17818, NULL, 'hub', $1)",
        COMPUTE,
    )
```
  - **Replace** `test_non_ollama_backend_is_unknown_but_states_why` (`:234-246`) and append the new tests:
```python
async def test_a_remote_default_does_not_hide_the_hub_card(client, pool, monkeypatch, mount_backend):
    """Replaces test_non_ollama_backend_is_unknown_but_states_why (S40, on purpose).

    That test pinned "free VRAM isn't observable" whenever the DEFAULT provider
    was not the bundled ollama — true only while one backend was the whole
    world. The hub's card and its /api/ps belong to the machine, not to whichever
    provider answers a bare id, and /admin/suggest sizes models for the hub."""
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    mount_backend("http://ollama.test", FakeOllama(ps_models=[]).app)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    fit = _fit_for((await client.get("/admin/suggest")).json(), "qwen3.8:27b")

    assert fit == {
        "verdict": "tight",
        "needed_gb": 18.0,
        "free_gb": 21.4,
        "total_gb": 24.0,
        "source": "estimated",
        "reason": None,
    }


async def test_a_reading_with_no_compute_is_never_this_engines(
    client, pool, monkeypatch, mount_backend
):
    """The legacy-probe isolation S40 promised. A row written before migration
    009 names no compute: nothing says which card held it, or whether it was
    this machine at all (the hub may since have moved). A 19,000 MB reading of
    qwen3:8b is therefore never read as the hub's measurement — fit falls back
    to the download's own size, `estimated`, until it is re-probed (the 008
    precedent). The row stays: it was true when it was taken."""
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    mount_backend("http://ollama.test", FakeOllama(ps_models=[]).app)
    await backends.save_config(pool, {"kind": "ollama"})
    await _insert_probe(pool, "qwen3:8b", 19000, provider=None, compute=None)

    fit = _fit_for((await client.get("/admin/suggest")).json(), "qwen3:8b")

    assert fit["source"] == "estimated"
    assert fit["needed_gb"] == 4.9, "the download's own size, not 18.6 GB nobody can place"


async def test_a_reading_taken_on_another_card_is_never_this_engines(
    client, pool, monkeypatch, mount_backend
):
    """Fit is keyed by (compute, model): a reading from a different card — the
    3090 before a move, a node's card — is that card's fact, not this one's."""
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    mount_backend("http://ollama.test", FakeOllama(ps_models=[]).app)
    await backends.save_config(pool, {"kind": "ollama"})
    other = compute_id.gpu_cuda("GPU-00000000-1111-2222-3333-444444444444")
    await _insert_probe(pool, "qwen3:8b", 9508, compute=other)

    fit = _fit_for((await client.get("/admin/suggest")).json(), "qwen3:8b")

    assert fit["source"] == "estimated" and fit["needed_gb"] == 4.9


async def test_a_card_that_states_no_uuid_reads_no_probe(client, pool, monkeypatch, mount_backend):
    """D10: a card's key is its CUDA uuid; the PCI fallback needs a bus id this
    reading does not carry. A card that answered without one cannot be named,
    so no reading can be proven to be its own — omitted, never guessed. Its
    memory is still read: free_gb stays a fact."""
    _card(monkeypatch, 24576, IDLE_FREE_MB, uuid=None)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    mount_backend("http://ollama.test", FakeOllama(ps_models=[]).app)
    await backends.save_config(pool, {"kind": "ollama"})
    await _insert_probe(pool, "qwen3:8b", 9508)

    fit = _fit_for((await client.get("/admin/suggest")).json(), "qwen3:8b")

    assert fit["source"] == "estimated" and fit["free_gb"] == 21.4
```
- [ ] **Run red:**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t4 uv run pytest tests/test_admin_suggest_fit.py -q
```
  Expected failures:
  - `test_a_remote_default_does_not_hide_the_hub_card` fails: `free_gb None`, reason "the active backend is remote…".
  - `test_a_reading_with_no_compute…`, `…another_card…` and `…no_uuid…` fail: `source == 'verified'`, because `_latest_probes` filters only `kind='ollama'` (`admin.py:249-255`).
  - All other tests pass.
- [ ] **Implement** in `app/admin.py`.
  - Imports `:23-35`: add `compute_id, engines`.
  - Replace `:110-185` with:
```python
# The hub reads exactly ONE card: its own, through nvidia-smi in this
# container. Every other engine's card is on another machine, and reading this
# one for it would describe the hub's GPU as that machine's — the failure
# hardware.json was taken out of the serving path for. A node's card arrives
# with its agent's facts (S44); until then it is a stated unknown.
NOT_THIS_CARD = "{name}'s card cannot be read from this hub — only the hub's own card is read here"


def _no_address(row: dict) -> str:
    if row.get("builtin"):
        return "OLLAMA_URL is unset — cannot read what's resident"
    return f"{row['name']} has no address — cannot read what's resident"


async def _resident_models(app, row: dict) -> tuple[list[dict] | None, str | None]:
    """(every model THIS ENGINE's /api/ps reports resident, reason-if-unreadable).

    Each entry is `{"model", "vram_mb", "size_bytes", "size_vram_bytes"}` — a
    per-model TABLE, not a pre-summed total: `fit.free_gb_after_switch` adds
    back what a switch would evict, and `_footprint` picks out the ONE model
    that just answered. The raw byte counts ride along because the D10 stamp
    (compute_id.served_on) decides offload from exactly them — `size_vram <
    size` is a model partly in system memory. A count /api/ps did not state is
    None, never 0. It is the only per-model VRAM figure on this host that can be
    attributed to anything: the card's own counter sees every process and,
    under WSL2, can name none of them. Read from the ENGINE's own address, so
    probing or sizing `dell:x` never reads the hub's /api/ps (S40).
    """
    base_url = providers.base_url_of(row)
    if not base_url:
        return None, _no_address(row)
    client = backends.http_client(app, PS_TIMEOUT, base_url=base_url)
    try:
        async with client as c:
            resp = await c.get("/api/ps")
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        return None, f"could not reach {row['name']}'s /api/ps — {backends.reason(exc)}"
    resident = []
    for entry in resp.json().get("models", []):
        size_vram = entry.get("size_vram")
        if size_vram is None:
            continue
        size = entry.get("size")
        resident.append(
            {
                "model": entry.get("name") or entry.get("model"),
                "vram_mb": size_vram / (1024 * 1024),
                "size_vram_bytes": int(size_vram),
                "size_bytes": int(size)
                if isinstance(size, int | float) and not isinstance(size, bool)
                else None,
            }
        )
    return resident, None


def _fit_frame(row: dict, vram: devices_vram.Vram) -> str | None:
    """Which memory a fit verdict for this engine is about: `vram` when the
    hub's card answered; `ram` when the bundled engine has no card this
    container can read (the GPU overlay that gives ollama a card gives the
    gateway the same one); None for another machine, whose card this hub cannot
    read at all — omitted, never guessed. S40 computes verdicts in the `vram`
    frame only; a `ram` frame's verdicts stay `unknown` with the card's reason
    until a CPU engine exists to walk it (S44/S45)."""
    if not row.get("builtin"):
        return None
    return "vram" if vram.known else "ram"


async def _free_and_total_vram_gb(
    app, row: dict
) -> tuple[float | None, float | None, str | None, devices_vram.Vram]:
    """(free_gb, total_gb, reason-if-free-is-unknown, the card reading) for ONE
    engine — read from the card.

    (Owner ruling 2026-09-14 kept verbatim in spirit: both numbers come from ONE
    live `nvidia-smi` call at the moment of the question, never hardware.json;
    "Nova should do the work ad-hoc to get the resources live, not read stale
    shit.") `free_gb` answers "how much after a switch" (ruling S2f-R2): the
    card's live free memory plus what this engine holds resident, so this
    engine's /api/ps being unreachable leaves free unknown while `total_gb`
    survives. S40: the question is about an ENGINE, not about whichever
    provider is the default — a cloud default no longer hides the hub's card.
    Only the builtin's card is readable here (NOT_THIS_CARD).
    """
    if not row.get("builtin"):
        vram = devices_vram.Vram(reason=NOT_THIS_CARD.format(name=row["name"]))
        return None, None, vram.reason, vram
    vram = await devices_vram.read_vram()
    if not vram.known:
        return None, None, vram.reason or "the GPU could not be read", vram
    total_gb = vram.total_mb / 1024
    resident, reason = await _resident_models(app, row)
    if resident is None:
        return None, total_gb, reason, vram
    return fit_mod.free_gb_after_switch(vram.free_mb, resident), total_gb, None, vram
```
  - Delete `vram_route` (`:188-227`). Its body moves to `engine_card` in 4.3.
  - Replace `_latest_probes` and `_fit_context` (`:230-277`):
```python
async def _latest_probes(pool, slugs: list[str], *, compute: str | None) -> dict[str, dict]:
    """The newest OK probe row per slug, IN THE CURRENT FRAME, TAKEN ON `compute`.

    A failed probe (ok=false) never counts as a measurement, and an older
    successful one loses to a newer one for the same model. `frame = 'model'`
    is the S22 filter (whole-card readings from before it read ~2.6 GB high —
    the 27B's 21.8 GB once made it `wont_fit` on a card where it runs).

    `compute = $2` is S40's (D10: fit is keyed by (compute, model)). A reading
    belongs to the card that held it: one from another card, or from before
    migration 009 with no compute at all, is not a measurement of THIS
    engine's card and is never read — the model falls back to its download
    size or the curated estimate until it is re-probed, exactly as 008 did.
    A partly-offloaded probe is stamped `cpu:…+gpu:…` and so never matches a
    card either: its size_vram understates what the model needs. `compute`
    None (a card that cannot be named) reads nothing — omitted, never guessed.
    """
    if not slugs or compute is None:
        return {}
    rows = await pool.fetch(
        "SELECT DISTINCT ON (model) model, vram_mb, created_at FROM probes "
        "WHERE model = ANY($1) AND compute = $2 AND ok = true AND vram_mb IS NOT NULL "
        "AND frame = 'model' "
        "ORDER BY model, created_at DESC",
        slugs,
        compute,
    )
    return {row["model"]: dict(row) for row in rows}


async def _fit_context(app, pool, row: dict | None = None) -> dict:
    """The numbers every fit verdict for ONE engine is computed against — read
    once per request and shared by /admin/suggest, the catalogue and the
    standby, so no two surfaces disagree about the same card or model size.

    `row` is the engine; None means the builtin (what /admin/suggest and the
    standby ask about). `compute` is the engine's card id (D10) when exactly
    one card is read — the key `_latest_probes` reads by; None when it cannot
    be named. `sizes` is this engine's installed download bytes from its
    /api/tags (engines' per-engine cache).
    """
    if row is None:
        row = await engines.get(pool, engines.BUILTIN)
    free_gb, total_gb, reason, vram = await _free_and_total_vram_gb(app, row)
    accelerators = compute_id.bundled_accelerators(vram.as_dict()) if row.get("builtin") else []
    sizes = await engines.installed_sizes(app, pool, row["name"])
    return {
        "engine": row["name"],
        "compute": accelerators[0] if len(accelerators) == 1 else None,
        "fit_frame": _fit_frame(row, vram),
        "free_gb": free_gb,
        "total_gb": total_gb,
        "reason": reason,
        "sizes": sizes or {},
    }
```
  - In `suggest_route` (`:292`): `probes_by_model = await _latest_probes(pool, [m["slug"] for m in result["models"]], compute=ctx["compute"])`.
  - In `app/catalog.py`, pass the same argument at both `latest_probes` calls (`:357` and `:406`): `compute=fit_ctx["compute"]`. This is an interim edit; 4.4 rewrites `build`.
  - In `app/routing.py` `standby`, change every `latest_probes(pool, …)` call to `latest_probes(pool, [e["slug"] for e in curated], compute=ctx["compute"])`. `ctx` is the `fit_context(...)` result that the verdict in the same function already uses.
- [ ] **Run green:** the same command, then the guard and the routing tests:
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t4 uv run pytest tests/test_admin_suggest_fit.py tests/test_admin_hardware_and_suggest.py tests/test_hardware_json_not_in_serving_path.py tests/test_routing.py -q
```
  All pass. `test_the_fit_path_asks_the_card_and_nothing_else` stays green: the literal `devices_vram.read_vram()` is still in `_free_and_total_vram_gb`, and it has no `hardware` arg.

#### 4.2 Probe rows say where they ran

- [ ] **Failing tests** in `tests/test_admin_probe.py`.
  - Imports:
```python
from app import admin, backends, compute_id, devices_vram, engines
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat
from tests.test_admin_suggest_fit import CARD_UUID, COMPUTE, IDLE_FREE_MB, _card, _fit_for
```
  - Rewrite the spy in `test_probe_against_a_remote_backend_never_reads_this_hosts_gpu` (`:150-154`):
```python
    async def _spy(app, row, model):
        calls.append(1)
        return {"vram_mb": 1234, "size_bytes": None, "size_vram_bytes": None}

    monkeypatch.setattr(admin, "_footprint", _spy)
```
  - Append:
```python
GIB = 1024**3
# A CPU the D10 grammar accepts, for the stamps that need one.
CPU = "cpu:amd-ryzen-9-5950x|32c|64g"


def _bundled(monkeypatch, accelerators, cpu):
    async def _devices():
        return accelerators, cpu

    monkeypatch.setattr(engines, "bundled_devices", _devices)


async def _hub_probe(client, pool, monkeypatch, mount_backend, ps_models):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_model_name="qwen3:8b", ps_models=ps_models)
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})
    resp = await client.post("/admin/probe", json={"model": "hub:qwen3:8b"})
    assert resp.status_code == 200, resp.text
    return resp.json(), fake


async def test_a_probe_row_says_where_it_ran(client, pool, monkeypatch, mount_backend):
    """The DoD's own row (D10): provider hub, compute the card's CUDA uuid,
    runtime container, path internal. The 8B sits wholly on the card
    (size_vram == size), so the stamp is that one device and nothing else —
    and the probe's ledger row carries the same served_on."""
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    full = [{"name": "qwen3:8b", "size": 9_970_000_000, "size_vram": 9_970_000_000}]

    body, _fake = await _hub_probe(client, pool, monkeypatch, mount_backend, full)

    assert body["ok"] is True
    expected = {
        "provider": "hub",
        "compute": f"gpu:cuda:{CARD_UUID}",
        "runtime": "container",
        "path": "internal",
    }
    assert {k: body[k] for k in expected} == expected
    stored = await pool.fetchrow(
        "SELECT provider, compute, runtime, path FROM probes WHERE id = $1", body["id"]
    )
    assert dict(stored) == expected
    ledger = await pool.fetchval("SELECT served_on FROM usage_events WHERE purpose = 'probe'")
    assert ledger == f"gpu:cuda:{CARD_UUID}"


async def test_a_probe_taken_now_is_what_fit_reads(client, pool, monkeypatch, mount_backend):
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    full = [{"name": "qwen3:8b", "size": 9_970_000_000, "size_vram": 9_970_000_000}]
    await _hub_probe(client, pool, monkeypatch, mount_backend, full)

    fit = _fit_for((await client.get("/admin/suggest")).json(), "qwen3:8b")

    assert fit["source"] == "verified" and fit["needed_gb"] == 9.3


async def test_a_model_partly_in_system_memory_is_stamped_with_both_and_fit_skips_it(
    client, pool, monkeypatch, mount_backend
):
    """size_vram < size: part of the model runs on the CPU. The stamp names
    both devices, sorted (D10), and fit does not read it — its size_vram
    understates what the model needs on this card."""
    compute_id.parse(CPU)  # the fixture itself obeys the grammar
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    _bundled(monkeypatch, [COMPUTE], CPU)
    partial = [{"name": "qwen3:8b", "size": 10 * GIB, "size_vram": 6 * GIB}]

    body, _fake = await _hub_probe(client, pool, monkeypatch, mount_backend, partial)

    assert body["compute"] == f"{CPU}+{COMPUTE}"
    assert body["vram_mb"] == 6 * 1024
    fit = _fit_for((await client.get("/admin/suggest")).json(), "qwen3:8b")
    assert fit["source"] == "estimated"


async def test_a_model_wholly_on_the_cpu_is_stamped_with_the_cpu(
    client, pool, monkeypatch, mount_backend
):
    _bundled(monkeypatch, [COMPUTE], CPU)
    cpu_only = [{"name": "qwen3:8b", "size": 5 * GIB, "size_vram": 0}]

    body, _fake = await _hub_probe(client, pool, monkeypatch, mount_backend, cpu_only)

    assert body["compute"] == CPU and body["vram_mb"] is None


async def test_a_model_not_resident_leaves_compute_unstated(
    client, pool, monkeypatch, mount_backend
):
    _bundled(monkeypatch, [COMPUTE], CPU)

    body, _fake = await _hub_probe(client, pool, monkeypatch, mount_backend, [])

    assert body["compute"] is None
    assert (body["provider"], body["runtime"], body["path"]) == ("hub", "container", "internal")


async def test_probing_the_hub_reads_its_own_ps_whatever_the_default(
    client, pool, monkeypatch, mount_backend
):
    """Before S40 the footprint was read at the DEFAULT backend's address, so
    with a cloud default a hub probe asked the cloud for /api/ps and stored no
    reading. A probe of hub:x is a question about the hub."""
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(
        probe_model_name="qwen3:8b",
        ps_models=[{"name": "qwen3:8b", "size": 9_970_000_000, "size_vram": 9_970_000_000}],
    )
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    body = (await client.post("/admin/probe", json={"model": "hub:qwen3:8b"})).json()

    assert body["vram_mb"] == int(9_970_000_000 / (1024 * 1024))
    assert ("/api/ps", None) in fake.seen


async def test_a_cloud_probe_names_its_provider_and_nothing_it_cannot_know(
    client, pool, monkeypatch, mount_backend
):
    reads: list[int] = []

    async def _spy():
        reads.append(1)
        return [], None

    monkeypatch.setattr(engines, "bundled_devices", _spy)
    mount_backend("http://remote.test", FakeOpenAICompat().app)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    body = (await client.post("/admin/probe", json={"model": "some-model"})).json()

    assert (body["provider"], body["compute"], body["runtime"], body["path"]) == (
        "remote", None, None, None,
    )
    assert reads == [], "a cloud call ran on no device of this host"


async def test_a_probe_on_another_machine_never_reads_this_hubs_card(
    client, pool, monkeypatch, second_engine
):
    """dell's reading comes from dell's own /api/ps. Its compute and runtime
    come from its agent (S44): absent here, never the hub's card."""
    reads: list[int] = []

    async def _read():
        reads.append(1)
        return devices_vram.Vram(total_mb=24576.0, used_mb=0.0, free_mb=24576.0, uuid=CARD_UUID)

    monkeypatch.setattr(devices_vram, "read_vram", _read)
    second_engine.probe_model_name = "qwen3.8:27b"
    second_engine.ps_models = [{"name": "qwen3.8:27b", "size": 17 * GIB, "size_vram": 17 * GIB}]

    body = (await client.post("/admin/probe", json={"model": "dell:qwen3.8:27b"})).json()

    assert body["ok"] is True and body["vram_mb"] == 17 * 1024
    assert (body["provider"], body["compute"], body["runtime"], body["path"]) == (
        "dell", None, None, None,
    )
    assert reads == []
```
- [ ] **Run red:**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t4 uv run pytest tests/test_admin_probe.py -q
```
  Expected failures:
  - `KeyError: 'provider'` on every new test. The response carries no stamp, because the INSERT at `admin.py:578-588` writes none.
  - `AttributeError: … has no attribute '_footprint'` in the spy test.
  - `test_probing_the_hub_reads_its_own_ps…` fails: `vram_mb None`, because the read goes to `backends.resolve_base_url(default)` at `admin.py:555`.
- [ ] **Implement.**
  - (a) If CONTRACT PROBLEM 1 needs it, add to `app/engines.py`. It must call `devices_vram.read_vram()` through the module attribute, so tests can monkeypatch it:
```python
import os
from pathlib import Path

from app import compute_id, devices_vram

PROC_CPUINFO = Path("/proc/cpuinfo")
PROC_MEMINFO = Path("/proc/meminfo")


async def bundled_devices() -> tuple[list[str], str | None]:
    """The bundled engine's devices at this instant, for a D10 stamp:
    (accelerators, cpu). Read live every call and never stored — an id kept in
    .env or a row would travel with a restore to another machine and name the
    wrong hardware. The accelerators are the vendor inventory (nvidia-smi via
    devices_vram: one card or none); the CPU is this kernel's /proc, which in a
    container is the host's. A half that cannot be read is omitted, never
    guessed."""
    vram = await devices_vram.read_vram()
    accelerators = compute_id.bundled_accelerators(vram.as_dict())
    try:
        cpu = compute_id.cpu_slug(
            PROC_CPUINFO.read_text(encoding="utf-8"),
            PROC_MEMINFO.read_text(encoding="utf-8"),
            os.cpu_count() or 0,
        )
    except (OSError, ValueError):
        cpu = None
    return accelerators, cpu
```
  - (b) In `app/usage.py:557-590`, `record_probe` gains `served_on: str | None = None` (after `error`), and passes `served_on=served_on` into `Event(...)`. Add one docstring sentence: "`served_on` is where an admin probe ran (D10), None when unknown or a cloud call."
  - (c) In `app/admin.py`, replace `_footprint_vram_mb` (`:465-499`; keep its docstring history and append the S40 paragraph) with:
```python
async def _footprint(app, row: dict, model: str) -> dict | None:
    """The just-answered model's own /api/ps entry on THIS engine:
    `{"vram_mb": int | None, "size_bytes", "size_vram_bytes"}` — one reading,
    so the VRAM figure and the D10 stamp describe the same instant.
    (… S22 frame / eviction-immunity paragraphs from _footprint_vram_mb kept …)
    None when the model is not in the table. A non-positive size_vram is not
    a VRAM measurement (vram_mb None) but IS the fact the stamp reads: the
    model is wholly in system memory."""
    resident, _reason = await _resident_models(app, row)
    for entry in resident or []:
        if entry.get("model") == model:
            vram_mb = entry.get("vram_mb")
            return {
                "vram_mb": int(vram_mb) if vram_mb and vram_mb > 0 else None,
                "size_bytes": entry.get("size_bytes"),
                "size_vram_bytes": entry.get("size_vram_bytes"),
            }
    return None
```
  - In `probe` (`:502-589`), after `kind = backends.kind_of(row)` add:
```python
    on_engine = engines.is_engine(row)
    # Where the call ran, on the row (D10). The engine's name always. The
    # bundled engine is by definition the container on the compose network
    # (D8/D9), so its runtime and path are known; another machine's arrive with
    # its agent (S44) — absent until then, never guessed.
    runtime = "container" if on_engine and row.get("builtin") else None
    path = "internal" if on_engine and row.get("builtin") else None
    compute: str | None = None
```
  - Replace the `elif kind == "ollama":` branch (`:551-557`):
```python
        elif on_engine:
            # Read AFTER the request answers, from THIS engine's /api/ps — never
            # the default provider's address: probing hub:x while a cloud
            # provider is the default is still a question about the hub.
            footprint = await _footprint(request.app, row, target_model)
            if footprint is not None:
                vram_mb = footprint["vram_mb"]
                if row.get("builtin"):
                    accelerators, cpu = await engines.bundled_devices()
                    compute = compute_id.served_on(
                        footprint["size_bytes"], footprint["size_vram_bytes"], accelerators, cpu
                    )
```
  - Pass `served_on=compute` to `usage.record_probe(...)`, and replace the INSERT with:
```python
    row_out = await pool.fetchrow(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error, provider, compute, "
        "runtime, path) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) "
        "RETURNING id, model, kind, ok, latency_ms, vram_mb, error, provider, compute, "
        "runtime, path, created_at",
        target_model, kind, ok, latency_ms, vram_mb, error, row["name"], compute, runtime, path,
    )
```
- [ ] **Run green:** the same command, plus `tests/test_usage.py -q` (`test_the_admin_probe_is_a_ledger_row_too` stays green; its fake `/api/ps` states no `size`, so `served_on` is None).

#### 4.3 `/admin/vram` deleted; its card lives on `GET /admin/engines/{name}`

No gateway test hit `/admin/vram`: `grep -rn "admin/vram" services/gateway/tests` is empty. Its only tests were core fakes (`services/core/tests/test_tools_inference.py:56,240`, which T5 moves). The "moved" tests are therefore new tests on the new route.

- [ ] **Failing tests:** create `tests/test_engine_card.py`:
```python
"""GET /admin/engines/{name}'s card: what GET /admin/vram answered, per engine.

S40 deleted /admin/vram. It answered about ONE thing — "the active backend",
the default provider — so the moment the default was a cloud provider its
resident table read "the active backend is remote, not local ollama" while the
bundled engine sat holding 17 GB. The card belongs to the machine, not to
whichever provider is the default. The block keeps every key core read off
/admin/vram, so its readers (inference_health, the inference_degraded check,
the resources panel) move by path alone.
"""

from __future__ import annotations

from app import backends, devices_vram
from tests.conftest import requires_db
from tests.fakes import FakeOllama
from tests.test_admin_suggest_fit import CARD_UUID, IDLE_FREE_MB, _card

pytestmark = requires_db

GIB = 1024**3
VRAM_KEYS = {
    "total_mb", "used_mb", "free_mb", "util_pct", "reason", "total_gb", "free_gb",
    "used_gb", "resident", "resident_reason", "free_after_switch_gb",
}


async def test_the_deleted_route_is_gone(client):
    assert (await client.get("/admin/vram")).status_code == 404


async def test_the_hub_card_is_read_whatever_the_default_provider_is(
    client, pool, monkeypatch, mount_backend
):
    _card(monkeypatch, 24576, IDLE_FREE_MB - 17.4 * 1024)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    held = int(17.4 * GIB)
    fake = FakeOllama(ps_models=[{"name": "qwen3.8:27b", "size": held, "size_vram": held}])
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    resp = await client.get("/admin/engines/hub")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["fit_frame"] == "vram"
    card = body["vram"]
    assert VRAM_KEYS <= set(card)
    assert card["uuid"] == CARD_UUID
    assert card["total_gb"] == 24.0 and card["reason"] is None
    assert [e["model"] for e in card["resident"]] == ["qwen3.8:27b"]
    assert card["resident_reason"] is None
    assert card["free_after_switch_gb"] == 21.4


async def test_an_unreadable_card_keeps_its_words_and_the_resident_table_still_reads(
    client, pool, monkeypatch, mount_backend
):
    async def _read():
        return devices_vram.Vram(
            reason="nvidia-smi could not be run — [Errno 2] No such file or directory"
        )

    monkeypatch.setattr(devices_vram, "read_vram", _read)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    mount_backend("http://ollama.test", FakeOllama(ps_models=[]).app)

    body = (await client.get("/admin/engines/hub")).json()

    assert body["fit_frame"] == "ram"
    assert body["vram"]["total_mb"] is None
    assert "nvidia-smi could not be run" in body["vram"]["reason"]
    assert body["vram"]["resident"] == [] and body["vram"]["free_after_switch_gb"] is None


async def test_an_unreachable_engine_says_so_and_the_card_still_answers(
    client, pool, monkeypatch
):
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")

    card = (await client.get("/admin/engines/hub")).json()["vram"]

    assert card["total_gb"] == 24.0
    assert card["resident"] is None and card["free_after_switch_gb"] is None
    assert "could not reach hub's /api/ps" in card["resident_reason"]


async def test_another_machines_card_is_never_this_hubs(client, pool, monkeypatch, second_engine):
    reads: list[int] = []

    async def _read():
        reads.append(1)
        return devices_vram.Vram(total_mb=24576.0, used_mb=0.0, free_mb=24576.0, uuid=CARD_UUID)

    monkeypatch.setattr(devices_vram, "read_vram", _read)
    second_engine.ps_models = [{"name": "qwen3.8:27b", "size": 10 * GIB, "size_vram": 10 * GIB}]

    body = (await client.get("/admin/engines/dell")).json()

    assert reads == [], "the hub's nvidia-smi describes the hub, never dell"
    assert body["fit_frame"] is None
    assert body["vram"]["total_mb"] is None
    assert "dell's card cannot be read from this hub" in body["vram"]["reason"]
    assert [e["model"] for e in body["vram"]["resident"]] == ["qwen3.8:27b"]
```
- [ ] **Run red:** the same command with `tests/test_engine_card.py`.
  - `test_the_deleted_route_is_gone` fails with 200.
  - The others fail on missing or different `vram` / `fit_frame`, whatever T2 filled in: `KeyError: 'uuid'` / `'fit_frame'`, `fit_frame None`, or `reads == [1]`.
  - If `…another_machines…` fails *only* because T2's `engines.observe` called `read_vram` for dell, fix `observe`: it must not read the hub's card for a non-builtin row.
- [ ] **Implement.** Add to `app/admin.py`, where `vram_route` was:
```python
async def engine_card(app, row: dict) -> dict:
    """GET /admin/engines/{name}'s `vram` and `fit_frame`: what GET /admin/vram
    answered, for ONE engine (S40 deleted the route). The card right now plus
    what THIS engine holds on it — one route so every caller gets the SAME
    instant. Both halves degrade independently with their own reasons: the card
    can be readable while the engine is down, and `free_after_switch_gb` is
    absent when it is, because a number that needs the resident table cannot
    be invented without it. Another machine's card is not this hub's to read
    (NOT_THIS_CARD); its /api/ps is. Nothing here decides anything (owner
    ruling 2026-09-03)."""
    if row.get("builtin"):
        vram = await devices_vram.read_vram()
    else:
        vram = devices_vram.Vram(reason=NOT_THIS_CARD.format(name=row["name"]))
    out: dict = vram.as_dict()
    out["total_gb"] = round(vram.total_mb / 1024, 1) if vram.total_mb is not None else None
    out["free_gb"] = round(vram.free_mb / 1024, 1) if vram.free_mb is not None else None
    out["used_gb"] = round(vram.used_mb / 1024, 1) if vram.used_mb is not None else None
    resident, reason = await _resident_models(app, row)
    out["resident"] = resident
    out["resident_reason"] = reason
    out["free_after_switch_gb"] = (
        round(fit_mod.free_gb_after_switch(vram.free_mb, resident), 1)
        if resident is not None and vram.free_mb is not None
        else None
    )
    return {"vram": out, "fit_frame": _fit_frame(row, vram)}
```
  In `app/engines_api.py`'s `GET /admin/engines/{name}` handler, build the response as `{**<EngineView as dict>, **await admin.engine_card(request.app, row)}`. Add `from app import admin`; there is no cycle, because admin imports `engines`, not `engines_api`. This replaces whatever T2 used for `vram` / `fit_frame` (`grep -n '"vram"\|fit_frame' app/engines_api.py`).
- [ ] **Run green:** the same command.

#### 4.4 Catalogue per engine; `library:` rows; Hub rows

- [ ] **Failing tests.**
  - `tests/test_catalog.py` imports:
```python
from app import admin, backends, catalog, engines, hf_hub, ollama_registry
from tests.test_admin_suggest_fit import COMPUTE, IDLE_FREE_MB, _card
```
  - Mechanical moves (each is the pinned id changing on purpose):
    - `:88`, `:120-122`, `:128`, `:169`, `:181`, `:192`, `:241`, `:296`: `"ollama:…"` becomes `"hub:…"`.
    - `:118`: `sources["hub"]["ok"] is True and sources["hub"]["rows"] == 2 and sources["hub"]["kind"] == "engine"`.
    - `:281`, `:294`: `["ollama"]` becomes `["hub"]`.
    - `:316`, `:365`: `"library:hf.co/…"`.
    - `:339`: `f"installed as hub:hf.co/{repo}:Q4_K_M"`.
    - `:167-168`: `row = cat.get(f"hub:{slug}") or cat[f"library:{slug}"]; assert row["fit"] == fit, slug`.
    - `:153-160`: add `, provider, compute` columns with values `'hub', $1` and pass `COMPUTE`.
    - `:174-184`: insert `provider='remote'`, and add `_card(monkeypatch, 24576, IDLE_FREE_MB)` (the test needs `monkeypatch`).
    - `:187-195`: add `_card(...)`; insert `provider='hub', compute=COMPUTE`; also `assert row["probe"]["compute"] == COMPUTE`.
    - `:135-143`: also `assert row["id"] == f"library:{row['model']}" and row["provider"] == catalog.LIBRARY`.
    - `:526`: `rows["library:qwen3:4b"]["installed"] is False` and `"hub:qwen3:4b" not in rows`.
  - `tests/test_hf_hub.py:404-405`:
```python
    assert row["id"] == "library:hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF"
    assert row["provider"] == "library"
```
  - Append to `tests/test_catalog.py`:
```python
async def test_each_machine_is_its_own_source_and_names_its_own_rows(client, local, second_engine):
    """S40: every site that assumed ONE builtin named 'ollama' reads engines.
    Two engines are two sources keyed by their names, and each installed model's
    id is `{engine}:{tag}` — the id a chain link or chat.model names it by. dell
    is a machine, never a cloud listing: its rows are `local`, and its fit never
    borrows the hub's card."""
    body = (await client.get("/admin/catalog")).json()

    sources = {s["key"]: s for s in body["sources"]}
    assert "ollama" not in sources
    assert sources["hub"]["kind"] == "engine" and sources["hub"]["rows"] == 2
    assert sources["dell"]["kind"] == "engine" and sources["dell"]["rows"] == 1
    assert [s["key"] for s in body["sources"]].count("dell") == 1
    installed = {r["id"] for r in body["rows"] if r["kind"] == "local" and r["installed"]}
    assert installed == {"hub:qwen3:8b", "hub:qwen3:4b", "dell:qwen3.8:27b"}
    dell = _rows_by_id(body)["dell:qwen3.8:27b"]
    assert dell["provider"] == "dell" and dell["model"] == "qwen3.8:27b"
    assert set(dell) == catalog.ROW_KEYS
    assert dell["fit"]["verdict"] == "unknown"
    assert "dell's card cannot be read from this hub" in dell["fit"]["reason"]


async def test_a_library_row_is_a_curated_pick_no_machine_holds(client, local, second_engine):
    body = (await client.get("/admin/catalog")).json()

    library = [r for r in body["rows"] if r["provider"] == catalog.LIBRARY]

    assert {r["model"] for r in library} == {"qwen3:14b", "gemma4:12b", "llama3.1:8b", "qwen3:1.7b"}
    for row in library:
        assert row["id"] == f"library:{row['model']}"
        assert row["kind"] == "local" and row["installed"] is False and row["actions"] == ["pull"]


async def test_a_reading_with_no_compute_is_never_this_rows_measurement(
    client, local, pool, monkeypatch
):
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    await pool.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error) "
        "VALUES ('qwen3:8b', 'ollama', true, 100, 19000, NULL)"
    )

    row = _rows_by_id((await client.get("/admin/catalog")).json())["hub:qwen3:8b"]

    assert row["probe"] is None, "a row from before 009 names no engine"
    assert row["fit"]["source"] == "estimated"
    assert row["facts"].get("vram_gb", {}).get("basis") != "measured"


async def test_hub_rows_say_installed_on_which_machine(client, local, second_engine, mount_backend):
    repo = HUB_ENTRY["id"]
    second_engine.tags = (f"hf.co/{repo}:Q8_0",)
    mount_backend(hf_hub.HF_BASE, FakeHFHub(pages=([HUB_ENTRY],)).app)

    row = (await client.get("/admin/catalog/hf?q=qwen")).json()["rows"][0]

    assert row["installed"] is True
    assert row["note"] == f"installed as dell:hf.co/{repo}:Q8_0"
```
- [ ] **Run red:**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t4 uv run pytest tests/test_catalog.py tests/test_hf_hub.py -q
```
  Expected failures:
  - `KeyError: 'hub:qwen3:8b'` (ids are still `ollama:` at `catalog.py:89`).
  - `KeyError: 'hub'` in sources (`:345,373`).
  - Library ids `ollama:…` (`:171`).
  - HF id `ollama:hf.co/…` (`hf_hub.py:572`).
  - dell listed as a `cloud` row via `one()` (`:397`).
  - `AttributeError: module 'app.catalog' has no attribute 'LIBRARY'`.
- [ ] **Implement.**
  - `app/catalog_row.py`, after `KINDS`:
```python
# The provider name of rows on no machine yet — a curated pick or a Hub repo:
# pullable, not installed, served by nothing. Reserved (migration 009's
# providers CHECK `name <> 'library'`), so an id `library:x` can never be read
# as a provider's model.
LIBRARY = "library"
```
  - `app/hf_hub.py`:
    - `:36` becomes `from app.catalog_row import LIBRARY, base_row`.
    - `:572` becomes `row = base_row(f"{LIBRARY}:{model}", LIBRARY, model, repo_id.rpartition("/")[2], "hub")`, with the comment: "a Hub repo is on no machine: named `library:` like a curated pick not installed; `installed` is derived per engine by the catalogue routes."
  - `app/catalog.py`:
    - Imports:
```python
from app import adapters, engines, hf_hub, ollama_registry, providers, pulls
...
from app.catalog_row import BASES, LIBRARY, ROW_KEYS, base_row, fact  # noqa: F401 — the shared shape
```
    - `local_row` gains keyword `engine: str`; `:88-89` becomes:
```python
    """One installed model from ONE engine's own state (+ the vetted layer). Its
    id is `{engine}:{tag}` — what a chain link or chat.model names it by."""
    name = tags_row["id"]
    row = _base_row(f"{engine}:{name}", engine, name, name, "local")
```
    - `library_row` `:170-171`:
```python
    slug = curated_entry["slug"]
    row = _base_row(f"{LIBRARY}:{slug}", LIBRARY, slug, curated_entry.get("label") or slug, "local")
```
    - In the `probe` block (`:134-141`), add `"compute": probe_row.get("compute"),`.
    - `_probes_by_model`:
```python
async def _probes_by_model(pool, names: list[str], provider: str) -> dict[str, dict]:
    """The newest OK probe per name taken ON THIS ENGINE (`probes.provider`,
    stamped since 009), with latency, time and the compute it ran on for the
    row's `probe` block. A row from before 009 names no engine and is nobody's
    until re-probed. Fit does NOT read this: it reads admin._latest_probes
    (keyed by compute), the same query /admin/suggest uses."""
    if not names:
        return {}
    rows = await pool.fetch(
        "SELECT DISTINCT ON (model) model, vram_mb, latency_ms, compute, created_at FROM probes "
        "WHERE model = ANY($1) AND provider = $2 AND ok = true "
        "ORDER BY model, created_at DESC",
        names,
        provider,
    )
    return {row["model"]: dict(row) for row in rows}
```
    - `build` (`:317-417`):
```python
_NO_ENGINE = {
    "engine": None, "compute": None, "fit_frame": None, "free_gb": None, "total_gb": None,
    "reason": "no machine here runs models", "sizes": {},
}


async def build(app, pool, *, fit_context, listing_for, latest_probes) -> dict:
    """The whole catalogue. `fit_context(app, pool, engine_row)`, `listing_for(app,
    pool, row)` and `latest_probes(pool, names, *, compute)` are admin.py's own
    helpers, passed in so this module owns no HTTP of its own and the numbers
    agree with /admin/suggest by construction. One section per ENGINE (S40),
    each its own source keyed by the engine's name, and the provider listings,
    all CONCURRENTLY; the show fan-out is bounded by SHOW_DEADLINE_S. Library
    rows are the curated picks no engine lists; their fit is the builtin's —
    the machine a bare pull lands on while it is the only one (S44 adds a fit
    per engine)."""
    fetched_at = _now()
    sources: list[dict] = []
    rows: list[dict] = []
    curated = curated_mod.load_curated()
    by_slug = {entry["slug"]: entry for entry in curated}
    engine_rows = await engines.rows(pool)
    contexts = await asyncio.gather(*(fit_context(app, pool, r) for r in engine_rows))
    fit_by_engine = {r["name"]: ctx for r, ctx in zip(engine_rows, contexts, strict=True)}

    async def engine_section(engine_row: dict) -> tuple[dict, list[dict], set[str] | None]:
        engine = engine_row["name"]
        fit_ctx = fit_by_engine[engine]
        try:
            tags = await ollama.ADAPTER.list_models(app, engine_row)
        except ProviderRefused as exc:
            failed = {"key": engine, "kind": "engine", "ok": False, "rows": 0, "note": exc.detail}
            return {**failed, "fetched_at": fetched_at}, [], None
        names = [m["id"] for m in tags.models]
        note = None
        try:
            shown = await asyncio.wait_for(
                ollama.facts_for_installed(app, providers.base_url_of(engine_row), tags.models),
                SHOW_DEADLINE_S,
            )
        except TimeoutError:
            shown = _show_timed_out(names)
            note = f"/api/show did not answer within {SHOW_DEADLINE_S:g} s — /api/tags facts only"
        probe_blocks = await _probes_by_model(pool, names, engine)
        fit_probes = await latest_probes(pool, names, compute=fit_ctx["compute"])
        local_rows = [
            local_row(
                tags_row,
                shown.get(tags_row["id"]),
                by_slug.get(tags_row["id"]),
                probe_blocks.get(tags_row["id"]),
                fit_probes.get(tags_row["id"]),
                fit_ctx,
                tags_fetched_at=tags.fetched_at,
                engine=engine,
            )
            for tags_row in tags.models
        ]
        failed = sum(1 for v in shown.values() if v.get("note"))
        if failed and note is None:
            note = f"/api/show failed for {failed} model(s)"
        source = {"key": engine, "kind": "engine", "ok": True, "rows": len(tags.models)}
        source["fetched_at"] = tags.fetched_at
        if note:
            source["note"] = note
        return source, local_rows, set(names)

    async def one(provider_row: dict) -> tuple[dict, list[dict]]:
        ...  # unchanged (:379-395)

    cloud_rows = [r for r in await providers.list_rows(pool) if not engines.is_engine(r)]
    results = await asyncio.gather(
        *(engine_section(r) for r in engine_rows), *(one(r) for r in cloud_rows)
    )
    installed_anywhere: set[str] = set()
    for source, local_rows, installed in results[: len(engine_rows)]:
        sources.append(source)
        rows.extend(local_rows)
        installed_anywhere |= installed or set()

    library = [entry for entry in curated if entry["slug"] not in installed_anywhere]
    library_ctx = fit_by_engine[engine_rows[0]["name"]] if engine_rows else _NO_ENGINE
    fit_probes = await latest_probes(
        pool, [entry["slug"] for entry in library], compute=library_ctx["compute"]
    )
    for entry in library:
        rows.append(library_row(entry, library_ctx, fit_probes.get(entry["slug"])))
    sources.append(
        {"key": SOURCE_CURATED, "ok": True, "rows": len(library), "url": "curated_models.json"}
    )

    for source, provider_models in results[len(engine_rows) :]:
        sources.append(source)
        rows.extend(provider_models)

    return {"fetched_at": fetched_at, "sources": sources, "rows": rows}
```
    - `:423-467`:
```python
def hf_page_rows(page: hf_hub.HfPage, installed: dict[str, set[str] | None] | None) -> list[dict]:
    ...  # body unchanged (mark_hub_installed(row, installed))


def hf_repo_row(repo: hf_hub.HfRepo, installed: dict[str, set[str] | None] | None) -> dict:
    ...  # body unchanged


def mark_hub_installed(row: dict, installed: dict[str, set[str] | None] | None) -> None:
    """`installed` on a Hub row is a fact about THIS hub's machines, never the
    Hub's: True when any engine's own tags list the repo under any quant,
    naming each as `{engine}:{tag}` (the id to use); False when every engine's
    tags were read and none lists it; None (unstated) when one could not be read
    and none that could lists it."""
    if not installed:
        return
    prefix = f"{row['model']}:"
    hits = sorted(
        f"{engine}:{name}"
        for engine, names in installed.items()
        for name in names or ()
        if name == row["model"] or name.startswith(prefix)
    )
    if hits:
        row["installed"] = True
        row["note"] = "installed as " + ", ".join(hits)
    elif all(names is not None for names in installed.values()):
        row["installed"] = False


async def installed_names(app, pool) -> dict[str, set[str] | None]:
    """{engine: what it lists right now, or None when it could not be asked} —
    one entry per machine that runs models, read live."""
    out: dict[str, set[str] | None] = {}
    for engine_row in await engines.rows(pool):
        try:
            listing = await ollama.ADAPTER.list_models(app, engine_row)
        except ProviderRefused:
            out[engine_row["name"]] = None
        else:
            out[engine_row["name"]] = {m["id"] for m in listing.models}
    return out
```
    - Update the module docstring (`:3-5`): "installed models on every engine (each engine's /api/tags + /api/show, ids `{engine}:{tag}`), the curated picks no engine holds (`library:{slug}`)…".
- [ ] **Run green:** the same command.

#### 4.5 Qualified ids: pull (keyed per engine and ref), remove, drift

- [ ] **Failing tests.**
  - `tests/test_admin_pull.py`:
    - Import `engines`: `from app import admin, backends, engines, hf_hub, ollama_registry, pulls`.
    - **Delete** `test_pull_is_refused_for_a_non_ollama_backend` (`:102-110`); the replacements are below.
    - Parametrize list `:350`: add `"hub:qwen3:8b:extra"` and `"hub:"`.
    - `:376,379`: `("hub", "library/qwen3:8b") in admin._PULLS_IN_FLIGHT`, message `"keyed on the ENGINE and the CANONICAL ref"`.
    - Append:
```python
async def test_a_cloud_default_no_longer_blocks_a_pull_to_the_machine(client, pool, ollama):
    """Replaces test_pull_is_refused_for_a_non_ollama_backend (S40, on purpose).

    That pinned "pull is only supported for the ollama backend" — a rule about
    which provider was the DEFAULT, from when the default was the only backend.
    A pull is about a machine: with a cloud default the hub still runs models,
    and a bare ref means the one machine there is."""
    await backends.save_config(
        pool, {"kind": "cloud", "url": "https://x", "api_key": "sk-x", "model": "m"}
    )

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    assert _lines(resp.content)[0]["engine"] == "hub"
    assert ollama.seen[-1] == ("/api/pull", {"model": "qwen3:8b"})


async def test_a_cloud_providers_prefix_names_no_machine(client, pool, ollama):
    await backends.save_config(
        pool, {"kind": "cloud", "url": "https://x", "api_key": "sk-x", "model": "m"}
    )

    resp = await client.post("/admin/pull", json={"model": "cloud:qwen3:8b"})

    assert resp.status_code == 400
    assert "'cloud' is not a machine that runs models" in resp.json()["error"]
    assert ollama.seen == []


async def test_a_bare_ref_with_two_machines_is_refused_naming_both(
    client, ollama, second_engine, upstreams
):
    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    assert resp.status_code == 400
    error = resp.json()["error"]
    assert "hub:qwen3:8b" in error and "dell:qwen3:8b" in error
    assert ollama.seen == [] and second_engine.seen == []
    assert upstreams.registry.seen == [], "refused before anything was sized"


async def test_a_qualified_pull_goes_to_that_machine(
    client, ollama, second_engine, monkeypatch, tmp_path
):
    monkeypatch.setattr(admin, "MODELS_DIR", tmp_path)

    resp = await client.post("/admin/pull", json={"model": "dell:qwen3:8b"})

    assert resp.status_code == 200
    line = _lines(resp.content)[0]
    assert line["engine"] == "dell" and line["size_source"] == "ollama-registry"
    assert "required_gb" not in line, "this hub's disk is not dell's"
    assert "free space on dell cannot be read from this hub" in line["note"]
    assert second_engine.seen[-1] == ("/api/pull", {"model": "qwen3:8b"})
    assert not any(path == "/api/pull" for path, _ in ollama.seen)


async def test_the_same_ref_onto_two_machines_is_two_pulls(
    client, pool, monkeypatch, mount_backend, second_engine
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    gate = asyncio.Event()
    hub = FakeOllama(pull_gate=gate)
    mount_backend("http://ollama.test", hub.app)

    first = asyncio.create_task(client.post("/admin/pull", json={"model": "hub:qwen3:8b"}))
    for _ in range(500):
        if ("hub", "library/qwen3:8b") in admin._PULLS_IN_FLIGHT:
            break
        await asyncio.sleep(0.01)
    assert ("hub", "library/qwen3:8b") in admin._PULLS_IN_FLIGHT

    onto_dell = await client.post("/admin/pull", json={"model": "dell:qwen3:8b"})
    assert onto_dell.status_code == 200, "a download onto dell is not the hub's download"
    again = await client.post("/admin/pull", json={"model": "hub:qwen3:8b"})
    assert again.status_code == 409

    gate.set()
    assert (await first).status_code == 200
    assert admin._PULLS_IN_FLIGHT == {}


async def test_a_finished_pull_drops_the_cached_tags(client, ollama, monkeypatch):
    """Routing reads installed tags through the engines cache (30 s when
    ready): a model just pulled must not read `not_installed` for that long."""
    cleared: list[int] = []
    monkeypatch.setattr(engines, "clear_cache", lambda: cleared.append(1))

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    assert _lines(resp.content)[-1] == {"status": "success"}
    assert cleared == [1]
```
  - `tests/test_catalog.py`:
    - `:523` becomes `assert resp.json() == {"engine": "hub", "removed": "qwen3:4b", "verified": True, "installed_now": 1}`.
    - Append:
```python
async def test_remove_takes_a_qualified_id_and_names_the_machine(client, local, second_engine):
    resp = await client.delete("/admin/models?model=dell:qwen3.8:27b")

    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "engine": "dell", "removed": "qwen3.8:27b", "verified": True, "installed_now": 0,
    }
    assert ("/api/delete", {"model": "qwen3.8:27b"}) in second_engine.seen
    assert not any(path == "/api/delete" for path, _ in local.seen), "hub was never asked"
    bare = await client.delete("/admin/models?model=qwen3:4b")
    assert bare.status_code == 400
    assert "hub:qwen3:4b" in bare.json()["error"] and "dell:qwen3:4b" in bare.json()["error"]


async def test_nothing_is_removed_from_a_cloud(client, local, pool):
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    resp = await client.delete("/admin/models?model=remote:qwen3:4b")

    assert resp.status_code == 400
    assert "'remote' is not a machine that runs models" in resp.json()["error"]
    assert not any(path == "/api/delete" for path, _ in local.seen)


async def test_a_removal_drops_the_cached_tags(client, local, monkeypatch):
    cleared: list[int] = []
    monkeypatch.setattr(engines, "clear_cache", lambda: cleared.append(1))

    assert (await client.delete("/admin/models?model=hub:qwen3:4b")).status_code == 200
    assert cleared == [1]


async def test_drift_takes_a_qualified_id(client, local, mount_backend):
    local.show["qwen3:8b"]["modelfile"] = WEIGHTS_BLOB
    registry = FakeOllamaRegistry(manifests={"library/qwen3/8b": MANIFEST})
    mount_backend(ollama_registry.REGISTRY_BASE, registry.app)

    body = (await client.post("/admin/catalog/drift", json={"model": "hub:qwen3:8b"})).json()

    assert body["engine"] == "hub" and body["model"] == "qwen3:8b"
    assert body["moved"] is False
```
- [ ] **Run red:** the same command with `tests/test_admin_pull.py tests/test_catalog.py`.
  - Qualified ids are a 400 today: `pulls.MODEL_RE` allows one colon (`pulls.py:29`), so `validate_model("hub:qwen3:8b")` refuses.
  - The key is `str` at `admin.py:375`.
  - A cloud default is a 400 at `admin.py:389-396`.
  - There is no `engine` key.
  - `clear_cache` is never called.
- [ ] **Implement.**
  - `app/catalog.py`: add after `NotInstalled` (or near the drift code):
```python
async def engine_and_model(pool, raw: object) -> tuple[dict, str]:
    """(engine row, bare model) for the model a pull, a removal or an update
    check names. `hub:qwen3:8b` names its engine; a bare `qwen3:8b` means the
    one machine there is, and is refused by name when there are several — which
    machine would be a guess. A cloud provider's prefix is refused: a cloud
    model is used directly. The ref is validated AFTER the engine prefix is
    split off (pulls.MODEL_RE allows one colon, the tag's own). Raises
    ValueError with the reason (a 400)."""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("model is required — e.g. hub:qwen3:8b")
    raw = raw.strip()
    rows = await providers.list_rows(pool)
    by_name = {r["name"]: r for r in rows}
    prefix, bare = providers.split_model_id(raw, set(by_name))
    if prefix is not None:
        row = by_name[prefix]
        if not engines.is_engine(row):
            raise ValueError(
                f"{prefix!r} is not a machine that runs models — a cloud model is used "
                "directly; it cannot be pulled, removed or checked for updates"
            )
    else:
        machines = [r for r in rows if engines.is_engine(r)]
        if not machines:
            raise ValueError("no machine here runs models — there is nothing to pull to")
        if len(machines) > 1:
            named = " or ".join(f"{r['name']}:{raw}" for r in machines)
            raise ValueError(f"{raw!r} does not say which machine — name it: {named}")
        row = machines[0]
    return row, pulls.validate_model(bare)
```
  - `check_drift` `:573-580`:
```python
    row, model = await engine_and_model(pool, model)
    listing = await ollama.ADAPTER.list_models(app, row)
    name = installed_name(listing.models, model)
    if name is None:
        raise NotInstalled(f"{model!r} is not installed on {row['name']}")
    checked_at = _now()
    show = await ollama.show(app, providers.base_url_of(row), name)
    installed = installed_weights_digest(show)
    result = {
        "engine": row["name"],
        "model": name,
        ...  # rest unchanged
```
  - `app/admin.py`:
    - `_PULLS_IN_FLIGHT` (`:304-310`): `_PULLS_IN_FLIGHT: dict[tuple[str, str], str] = {}`. The comment becomes: "(engine, canonical ref) -> when it started … ollama on ONE machine would run two downloads against the same blobs; the same ref onto two machines is two downloads (S40)".
    - `_preflight_line(app, model, row)`: set `line: dict = {"status": "preflight", "engine": row["name"]}`. Insert before the `os.statvfs` block:
```python
    if not row.get("builtin"):
        # This hub's /models is its own disk; another machine's free space is
        # read on that machine (its agent, S44). Sizing a pull against ours
        # would compare dell's download with the hub's disk.
        notes.append(
            f"free space on {row['name']} cannot be read from this hub; "
            "skipping the free-space check"
        )
        line["note"] = "; ".join(notes)
        line["size_bytes"] = size_bytes
        line["size_source"] = sized["size_source"]
        return line
```
    - `pull` `:366-400`:
```python
    body = await request.json()
    raw = body.get("model") if isinstance(body, dict) else None
    if not raw:
        raise HTTPException(status_code=400, detail="model is required")
    pool = await db.get_pool()
    try:
        row, model = await catalog.engine_and_model(pool, raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    key = (row["name"], pulls_mod.canonical_ref(model))
    started_at = _PULLS_IN_FLIGHT.get(key)
    if started_at is not None:
        raise HTTPException(
            status_code=409,
            detail=f"a pull of {model!r} has been in flight since {started_at} on "
            f"{row['name']} — wait for it to finish",
        )
    _PULLS_IN_FLIGHT[key] = datetime.now(UTC).isoformat()
    released = False
    try:
        ollama_url = providers.base_url_of(row)
        if not ollama_url:
            raise HTTPException(
                status_code=502,
                detail="OLLAMA_URL is unset — cannot reach ollama"
                if row.get("builtin")
                else f"{row['name']} has no address — cannot reach it",
            )
        preflight = await _preflight_line(request.app, model, row)
        # … (absent → 404 block unchanged)
```
    - The connect-error detail at `:429` becomes `f"could not reach {row['name']}'s ollama — {backends.reason(exc)}"`.
    - In `relay()`'s `finally` add `engines.clear_cache()` next to `_PULLS_IN_FLIGHT.pop(key, None)`.
    - `remove_model` `:1135-1158`:
```python
    raw = request.query_params.get("model") or ""
    pool = await db.get_pool()
    try:
        row, model = await catalog.engine_and_model(pool, raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    base_url = providers.base_url_of(row)
    try:
        before = await ollama.ADAPTER.list_models(request.app, row)
        name = catalog.installed_name(before.models, model)
        if name is None:
            raise HTTPException(
                status_code=404, detail=f"{model!r} is not installed on {row['name']}"
            )
        await ollama.delete(request.app, base_url, name)
        # What is installed changed (or ollama claims so): the cached tags
        # routing reads are dropped either way, never served stale.
        engines.clear_cache()
        after = await ollama.ADAPTER.list_models(request.app, row)
    except adapters.ProviderRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    if catalog.installed_name(after.models, name) is not None:
        raise HTTPException(
            status_code=502,
            detail=f"ollama on {row['name']} answered 200 to the delete but /api/tags still "
            f"lists {name!r}",
        )
    logger.info("model removed: %s from %s", name, row["name"])
    return {
        "engine": row["name"],
        "removed": name,
        "verified": True,
        "installed_now": len(after.models),
    }
```
    `test_catalog.py:544` asserts `"still lists 'qwen3:4b'"`; the new detail still contains that substring.
    - Update the docstrings of `remove_model` and `catalog_drift` to say "the named engine (`hub:x`; a bare id means the only one)". `catalog_drift` already maps `ValueError` to 400.
- [ ] **Run green:** the same command.

#### 4.6 Shadow check reads only the default engine; reserved names

- [ ] **Failing tests** in `tests/test_providers.py`.
  - Rewrite `:283-292`, the second half of `test_create_refuses_a_duplicate_and_the_builtin_name`, and rename the test `test_create_refuses_a_duplicate_and_the_reserved_names`:
```python
    for reserved, words in (
        ("hub", "'hub' is the builtin engine"),
        ("library", "'library' is reserved"),
    ):
        resp = await client.post(
            "/admin/providers",
            json={"name": reserved, "adapter": "openai-chat", "base_url": "http://x/v1",
                  "auth_shape": "none"},
        )
        assert resp.status_code == 409 and words in resp.json()["error"], reserved
```
  - At `:853` add `assert "on hub" in resp.json()["error"]`.
  - Append:
```python
async def test_with_a_cloud_default_no_machine_is_asked_and_the_name_saves(
    client, pool, mount_backend, local_tags, monkeypatch
):
    """S40: only a BARE id can be shadowed, and a bare id means the default
    provider. With a cloud default the machines' tags are not what a bare id
    names, so none is asked — the owner can add a provider while the hub's
    ollama is down (and, from S46, while a machine sleeps). Before S40 this was
    a 502: every create read the builtin's tags."""
    await _add_openrouter(client, mount_backend)
    assert (await client.put("/admin/providers/openrouter/default")).status_code == 200
    local_tags.tags = ("mistral:7b",)
    local_tags.seen.clear()
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")
    mount_backend("http://mistral.test", FakeOpenAICompat().app)

    resp = await client.post(
        "/admin/providers",
        json={"name": "mistral", "adapter": "openai-chat", "base_url": "http://mistral.test/v1",
              "auth_shape": "none"},
    )

    assert resp.status_code == 200, resp.text
    assert local_tags.seen == []
```
- [ ] **Run red:** the same command with `tests/test_providers.py`.
  - The new test fails with 502 "cannot check 'mistral' against the local model tags", from `admin.py:665-672`.
  - `hub` gets "a provider named 'hub' already exists", not the builtin wording.
  - `library` gets 502 (the verify ran).
- [ ] **Implement** in `app/admin.py`.
  - `:659-681`:
```python
async def _refuse_name_that_shadows_a_local_tag(app, pool, name: str) -> None:
    """A model id is split on its FIRST colon against the provider names, so a
    provider called `mistral` would turn the bare id `mistral:7b` into "model 7b
    on Mistral's cloud". Only a BARE id can be shadowed, and a bare id means the
    DEFAULT provider (S40) — so the tags that matter are the default's, and only
    when the default is a machine that runs models. A cloud default has no tags
    to shadow and no machine is asked: a machine that is down or asleep never
    blocks adding a cloud provider. The default engine's listing is read live —
    derived, never a maintained list — and one that cannot be read is a stated
    refusal, not a skipped check."""
    default = await providers.default_row(pool)
    if not engines.is_engine(default):
        return
    try:
        listing = await adapters.for_row(default).list_models(app, default)
    except adapters.ProviderRefused as exc:
        raise HTTPException(
            status_code=502,
            detail=f"cannot check {name!r} against the local model tags on "
            f"{default['name']} — {exc.detail}",
        ) from exc
    shadowed = sorted(
        m["id"] for m in listing.models if m["id"].partition(":")[0] == name and ":" in m["id"]
    )
    if shadowed:
        raise HTTPException(
            status_code=409,
            detail=f"{name!r} would shadow the model tag(s) {', '.join(shadowed)} on "
            f"{default['name']} — a bare id like {shadowed[0]!r} would stop meaning that "
            "model; pick another name",
        )
```
  - `:702-703`:
```python
    if name == engines.BUILTIN:
        raise HTTPException(status_code=409, detail=f"{name!r} is the builtin engine")
    if name == catalog.LIBRARY:
        raise HTTPException(
            status_code=409,
            detail=f"{name!r} is reserved — it names the models on no machine yet",
        )
```
- [ ] **Run green:** the same command. The existing `test_a_name_that_is_a_local_tags_prefix_is_refused` (`:818`) stays green: the default is `hub`, an engine, and `"mistral:7b" in error` still holds.

#### 4.7 Full gateway suite, lint, pinned moves, commit

- [ ] Run everything:
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t4 uv run pytest -q
```
  Expected: all green and **0 skipped DB tests** (a skip means `TEST_DATABASE_URL` did not reach them).
- [ ] Lint only what T4 edited:
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && uv run ruff format app/admin.py app/catalog.py app/catalog_row.py app/hf_hub.py app/usage.py app/routing.py app/engines_api.py app/engines.py tests/conftest.py tests/test_engine_card.py tests/test_admin_suggest_fit.py tests/test_admin_probe.py tests/test_admin_pull.py tests/test_catalog.py tests/test_hf_hub.py tests/test_providers.py && uv run ruff check .
```
  Drop `app/engines.py` from the list if T4 did not edit it.
- [ ] Confirm nothing in the gateway still hardcodes the old builtin or the deleted route. Both commands should print nothing except `adapters/ollama.py`'s adapter `name`, `backends.KINDS` / `kind_of` (the legacy S1 kind names), and `suggest.py:157` (`engine_suggestion: "ollama"`, the wizard's kind):
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && grep -rn 'get_row(pool, "ollama")\|"ollama:\|f"ollama:\|/vram"' app/ ; grep -rn '"ollama:' tests/test_catalog.py tests/test_hf_hub.py tests/test_admin_*.py
```
- [ ] **Pinned tests moved on purpose (the reason is recorded in each test's docstring or comment):**

| Test | Moves to | Reason |
|---|---|---|
| `test_catalog.py:88,120-122,128,168-169,181,192,241,296,526` | `hub:` / `library:` ids | Catalogue ids name the engine (D21 first-colon ids); a curated pick on no machine is `library:` |
| `test_catalog.py:118,281,294` | source key `hub`, `kind:"engine"` | One source per engine |
| `test_catalog.py:152-160,174-195` | probes inserted with `provider` / `compute`; `_card` added | Fit keyed by (compute, model); the probe block keyed by provider |
| `test_catalog.py:316,339,365`; `test_hf_hub.py:404-405` | `library:hf.co/…`; note `installed as hub:…` | A Hub repo is on no machine; `installed` names the machine |
| `test_catalog.py:523` | `+ "engine": "hub"` | Removal names the machine it verified against |
| `test_admin_suggest_fit.py:29-35` (`_card` gains `uuid`), `:133-136,172-175,193-206,294-297,317-320` (compute-stamped inserts) | — | D10 fit identity |
| `test_admin_suggest_fit.py:234-246` | replaced by `test_a_remote_default_does_not_hide_the_hub_card` | Fit belongs to the engine, not the default provider |
| `test_admin_probe.py:150-154` | spy on `_footprint(app, row, model)` | One `/api/ps` read yields the VRAM figure and the D10 stamp |
| `test_admin_pull.py:102-110` | replaced by the two cloud-default / cloud-prefix tests | The default-kind gate was single-backend |
| `test_admin_pull.py:376,379` | tuple key `("hub", "library/qwen3:8b")` | In-flight is per (engine, ref) |
| `test_providers.py:270-292` | reserved `hub` / `library` | Builtin renamed (D21); `library` reserved (009 CHECK) |
| `test_providers.py:853` | `+ "on hub"` | The refusal names the engine asked |

  - Unchanged and verified green: `test_hardware_json_not_in_serving_path.py` (the literal `devices_vram.read_vram()` and no `hardware` arg), `test_admin_hardware_and_suggest.py`, `test_routing.py` (after the `latest_probes(..., compute=)` edit), `test_usage.py:557-563`.
  - The other `"ollama:"` fixtures in `test_routing.py`, `test_data_plane.py:58,83`, `test_usage.py:245,499,504,528,538` and `test_providers.py:95,174-176,194,226,267,344,373,378,522-526,653,683,752,1077` belong to T2/T3.
- [ ] Cross-service consumers T4's output changes, for T5 and T8 to move. No core or web test breaks from T4, because both use fakes.
  - Core:
    - `tools/inference.py:36`, `checks/inference.py:66`, `resources_api.py:35`: read `/admin/engines/hub` → `body["vram"]` (same keys).
    - `checks/stack.py:49-50,211,259`: the source with `kind == "engine"`, row providers = engine names.
    - `models_catalog.py:34-41`, `tools/models.py:43,446,477,567`, `vision.py:113-118`.
  - Web:
    - `pages/models/ModelsPage.tsx:140` (`r.provider === 'ollama'`), `pages/settings/modelsFormat.ts:8`, `pages/chat/ContextGauge.tsx:61`.
    - Carry for S44: `ModelsPage.tsx:308,324,637` send the bare `row.model` for remove/drift/pull, which is accepted only while one engine exists. S44 must send `row.id`.
- [ ] Commit by path:
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff && git add services/gateway/app/admin.py services/gateway/app/catalog.py services/gateway/app/catalog_row.py services/gateway/app/hf_hub.py services/gateway/app/usage.py services/gateway/app/routing.py services/gateway/app/engines_api.py services/gateway/app/engines.py services/gateway/tests/conftest.py services/gateway/tests/test_engine_card.py services/gateway/tests/test_admin_suggest_fit.py services/gateway/tests/test_admin_probe.py services/gateway/tests/test_admin_pull.py services/gateway/tests/test_catalog.py services/gateway/tests/test_hf_hub.py services/gateway/tests/test_providers.py && git commit -m "$(cat <<'EOF'
feat(gateway): S40 T4 — catalogue, fit, probes and model admin per engine

Catalogue rows are {engine}:{tag} (hub:qwen3:8b); curated picks and Hub
repos on no machine are library:{slug}; each engine is its own source
(kind "engine"). Fit is per engine and keyed by (compute, model) (D10): a
probe row is read only when taken on the card the engine has now, so a
pre-009 reading with no compute is never read as hub's, and a partly
offloaded one never sizes a card. Probes are stamped provider/compute/
runtime/path and their ledger row carries served_on. /admin/vram is
deleted; GET /admin/engines/{name} carries its card with every key core
read. Pull/remove/drift take engine-qualified ids (a bare id means the one
engine, refused by name when there are several); pulls are keyed per
(engine, ref); both drop the engines tag cache. The shadow-name check
reads only the default provider's tags, and only when it is an engine: a
cloud provider saves while a machine's ollama is down. 'hub' and
'library' are reserved provider names.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
  Drop `services/gateway/app/engines.py` from `git add` if T4 did not edit it.

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/admin.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/catalog.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/tests/test_catalog.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/tests/test_admin_suggest_fit.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/tests/conftest.py