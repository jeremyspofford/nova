### Task 3: Gateway routing walks engines, completions report where they ran, and connect failures are never walled

T3 changes seven things in the gateway:

- **Engine listings.** `routing.py` reads each engine's model list through `engines.observe`, whose cache also caches failures.
- **The serving switch.** `judge_link` gains a `switched_off` verdict.
- **Standby.** It only uses engines that are serving, and never picks a model whose `/api/show` says it is an embedder.
- **No wall on connect failures.** A connect-phase failure to an engine raises `ProviderUnreachable`, and `data_plane` records no wall for it.
- **Serving headers.** `data_plane` sets `X-Nova-Served-On` and `X-Nova-Served-Runtime`.
- **Ledger.** `usage_events.served_on` is written.
- **`resolve`.** Otherwise unchanged.

**Preconditions (checked in Step 0; if any fails, stop and report — do not work around it):**
- T1 is committed:
  - `migrations/009_engines.sql` adds `usage_events.served_on`.
  - `app/compute_id.py` exports `served_on`, `bundled_accelerators`, `cpu_slug`, `gpu_cuda`, `parse`.
  - `devices_vram._QUERY` ends `,uuid,name`, and `devices_vram.parse()` reads those two fields. `Vram.as_dict()` carries `"uuid"` and `"name"`.
  - `tests/conftest.py` `_TABLES` includes `engines` and `engine_models`.
- T2 is committed:
  - `app/engines.py` matches the contract.
  - The builtin is `hub`. `ensure_builtin` seeds `hub` plus its `engines` row.
  - Every gateway test fixture already says `hub:`, not `ollama:`.
  - The gateway suite is green at T2's HEAD. That includes `admin._refuse_name_that_shadows_a_local_tag` (`admin.py:665`), because every test that creates a cloud provider depends on it.

**Files:**
- Modify:
  - `services/gateway/app/adapters/base.py:19-27`: add `ProviderUnreachable` and `CONNECT_PHASE_ERRORS` after `ProviderRefused`.
  - `services/gateway/app/adapters/__init__.py:11-18,34-42`: export `ProviderUnreachable`.
  - `services/gateway/app/adapters/openai_chat.py:24-36` (imports), `:477-497` (`completions`/`_completions` get `engine=`), `:513-516` (the usage retry passes `engine` through).
  - `services/gateway/app/adapters/ollama.py`: add `suits_chat` after `show_to_facts` (`:193-228`). `completions` (`:345-352`) passes `engine=True`.
  - `services/gateway/app/routing.py`:
    - `:1-33`: docstring.
    - `:37-49`: imports.
    - `:71-72`: delete `TAGS_TTL_S` and `TAGS_CACHE`.
    - `:274-484`: the walk, rewritten.
    - `:511-512`: delete `clear_tags_cache`.
  - `services/gateway/app/data_plane.py`:
    - `:1-10`: docstring.
    - `:12-28`: imports and constants.
    - `:72-136`: `serve_by_role`.
    - `:139-184`: `serve_completion`.
    - A new stamp section after `serve_completion`.
  - `services/gateway/app/usage.py`: `:331-346` (`Event`), `:349-381` (`record`), `:432-467` (`observe`), `:1024-1028` (`events`).
  - `services/gateway/tests/conftest.py:80-109`: new `mount_transport` fixture. `fresh_upstream_caches` clears the engines cache and `SHOW_CACHE`. New autouse fixture `no_devices_under_the_desk`.
  - `services/gateway/tests/fakes.py`: add `FailingTransport` after `StreamingASGITransport` (`:21-119`).
  - `services/gateway/tests/test_routing.py`:
    - `:14-23`: imports.
    - `:50-57`: the `local` fixture.
    - `:138`, `:226-245`, `:349-352`, `:359`, `:391`: moved.
    - Seven new tests at the end.
  - `services/gateway/tests/test_providers.py:345`: moved.
  - `services/gateway/tests/test_usage.py`: new test after `:253`.
  - `services/gateway/tests/test_ollama_show.py`: new pure test after the `show_to_facts` tests.
- Create:
  - `services/gateway/tests/test_adapters_unreachable.py` (pure, no DB).
  - `services/gateway/tests/test_served_on.py` (DB tests are marked `@requires_db` one by one; the wiring test is pure).

**Interfaces:**
- **Consumes (T1):**
  - `compute_id.served_on(size: int | None, size_vram: int | None, accelerators: list[str], cpu: str | None) -> str | None`
  - `compute_id.bundled_accelerators(vram_reading: dict) -> list[str]`
  - `compute_id.cpu_slug(cpuinfo_text: str, meminfo_text: str, nproc: int) -> str`
  - `compute_id.gpu_cuda(uuid: str) -> str`
  - `devices_vram.parse(stdout)` reading `total,used,free,util,uuid,name`
- **Consumes (T2):**
  - `engines.BUILTIN` (`"hub"`), `engines.EngineView` (`.tags`, `.reason`, `.runtime`), `engines.UnknownEngine`
  - `engines.is_engine(row)`, `engines.rows(pool)`, `engines.get(pool, name)`
  - `engines.observe(app, pool, row, *, live)`, `engines.installed_sizes(app, pool, name)`
  - `engines.set_serving(pool, name, serving)`, `engines.clear_cache()`
  - `observe` must accept a row from `rows()` or `get()`, and must return `runtime="container"` for the builtin.
- **Produces (contract):**
  - `class ProviderUnreachable(ProviderRefused)` in `app/adapters/base.py`.
  - Headers `X-Nova-Served-By` (unchanged), `X-Nova-Served-On` (omitted when unknown) and `X-Nova-Served-Runtime` (omitted when the row is not an engine).
  - `usage_events.served_on` is written.
- **Produces (T3's own names, for T4/T5):**
  - `adapters.base.CONNECT_PHASE_ERRORS`
  - `openai_chat.OpenAIChat.completions(request, row, model, body, *, engine: bool = False)`
  - `ollama.suits_chat(capabilities: dict) -> bool`
  - `routing.switched_off(row) -> str | None`
  - `routing.judge_link(app, pool, link, by_name, walled, timezone, seen: dict[str, EngineView])`
  - `routing.resolve(..., skip=None, unreachable: dict[str, str] | None = None)`
  - `routing.standby(app, pool, fit_context, latest_probes, candidates: list[dict], seen)`
  - `routing.installed_sizes(app, pool, engine=engines.BUILTIN)`, a shim over `engines.installed_sizes`
  - In `data_plane`:
    - constants: `SERVED_ON_HEADER`, `SERVED_RUNTIME_HEADER`
    - `class Served(on, runtime).headers()`
    - `async served_stamp(app, pool, row, model) -> Served`
    - `async read_bundled_devices() -> tuple[list[str], str | None]`
    - `async bundled_devices()` (process cache, 300 s)
    - `clear_bundled_devices()`
    - `class EngineUnreachable(HTTPException)`
  - `usage.Event.served_on: str | None = None`, `usage.observe(..., served_on=None)`, and `usage.events()` returns `served_on`.

**CONTRACT PROBLEM 1 — ReadTimeout before headers.** The contract lists "ReadTimeout before headers" as `ProviderUnreachable`, which is never walled. On the bundled engine that error means ollama accepted the request and did not send headers within the 300 s read budget (`adapters/base.py:14`), which is a model still loading or processing a prompt. That is exactly the 2026-09-10 incident: `migrations/007_wall_scope.sql:3-9`, `routing.py:63-67`, `tests/test_routing.py:211-225`. The code walls that one model for 60 s on purpose, so the next turn falls to the next link instead of waiting 300 s again. Treating it as unreachable brings that regression back.
- **What T3 does:** `CONNECT_PHASE_ERRORS = (ConnectError, ConnectTimeout, ProxyError)`. On an engine, ReadTimeout stays `ProviderRefused(502)` and is still walled per model. `test_an_engine_that_took_the_request_and_then_failed_is_a_refusal` pins this.
- **Where ReadTimeout belongs:** it only means "unreachable" on a proxied dial (a tailnet CONNECT that never set up the tunnel). S43a, which adds proxied dials, should add it for those dials only.
- **If the integrator decides otherwise:** add `httpx.ReadTimeout` to the tuple and flip that test's parametrize.

**CONTRACT PROBLEM 2 — no seam for the bundled engine's devices, and a gap for T4.** The contract gives `compute_id.bundled_accelerators(vram_reading)` and `cpu_slug(...)`, which are pure, but nothing that holds this host's devices in process memory for per-request stamps. r2 §2.1 calls this "Bundled compute | gateway process memory". T3 adds `data_plane.read_bundled_devices()` / `bundled_devices()` / `clear_bundled_devices()` and `data_plane.served_stamp()`.
- **T4's probe stamp** should call `data_plane.served_stamp(app, pool, row, model)`, so a probe's `compute` and `runtime` come from the same source as the header. The probe's `path` is `'internal'` for the builtin.
- **If T2's `engines.py` already holds this inventory,** `read_bundled_devices` should delegate to it. The tests patch `data_plane.read_bundled_devices`, so they do not change.

**Clarification (not a contract problem): "data_plane never records a wall for it" holds exactly.** `ProviderUnreachable` is raised only for an engine: `ollama.completions` passes `engine=True` into the shared openai-chat path. A cloud provider's connect failure stays a plain `ProviderRefused(502)` and is walled per model, as it is today. `test_a_cloud_provider_that_cannot_be_reached_is_still_walled` pins this.

**Decision to flag: the serving switch governs the role walk only.** A request with no role (evals name their model, rail 17, `chat.py:2906-2924`; `model_read`) is served as named, exactly as a capped provider is refused and not substituted. With a role and a switched-off default engine but no chain, the result is a stated 503 (`switched_off`), never the switched-off engine.

**How standby knows a model is an embedder in S40.** `engine_models` is not read by routing in S40. Standby asks ollama's own `/api/show` capabilities through `ollama.facts_for_installed`, which is content-addressed by the `/api/tags` digest (`ollama.SHOW_CACHE`, the cache the catalogue fills). A model is a chat candidate only if `ollama.suits_chat`: `completion` is declared and `embedding` is not, the same rule as `catalog.local_row` (`catalog.py:125`). When `/api/show` cannot answer, a model is not assumed to chat. Once `engine_models` is populated (S44, so capabilities survive while an engine sleeps), standby should read it first.

---

- [ ] **Step 0: Scratch DB, a green baseline, and the preconditions.**
```bash
docker exec nova-scratch-pg psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='nova_gateway_s40_t3'" | grep -q 1 || docker exec nova-scratch-pg psql -U postgres -c "CREATE DATABASE nova_gateway_s40_t3"
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t3 uv run pytest -q
grep -n "def is_engine\|^async def rows\|^async def get\|^async def observe\|^async def installed_sizes\|^async def set_serving\|^def clear_cache\|^class EngineView\|^class UnknownEngine\|^BUILTIN" app/engines.py
grep -n "^def served_on\|^def bundled_accelerators\|^def cpu_slug\|^def gpu_cuda" app/compute_id.py
grep -n "served_on" migrations/009_engines.sql
grep -n "uuid,name" app/devices_vram.py
grep -rn "\"ollama:" tests/test_routing.py tests/test_data_plane.py tests/test_usage.py tests/test_providers.py
```
Expected:
- The suite is green; record the pass count.
- Every grep except the last finds its names.
- The last grep finds nothing (T2 moved the fixtures to `hub:`).
If any expectation fails, stop and report which one.

- [ ] **Step 1.1: Failing tests for the adapters.** Add the fixture to `tests/conftest.py`, directly after `mount_backend` (`:80-93`):
```python
@pytest.fixture
def mount_transport():
    """Mount a raw httpx transport at a base URL — for a peer that fails in a
    way no ASGI app can (a connection that is never accepted). Shares
    mount_backend's registry and its teardown."""

    def _mount(url: str, transport) -> None:
        transports = dict(getattr(app.state, "peer_transports", {}))
        transports[url] = transport
        app.state.peer_transports = transports

    yield _mount
    app.state.peer_transports = {}
```
Add to `tests/fakes.py` after `StreamingASGITransport`:
```python
class FailingTransport(httpx.AsyncBaseTransport):
    """A peer whose every request fails before any response exists, with
    `failure` — the shapes httpx's own transport raises: ConnectError (the
    connection refused), ConnectTimeout (nothing answered), ProxyError, or
    ReadTimeout / RemoteProtocolError / WriteError (it took the request and
    then failed). Counted, so a test can prove how often the gateway asked."""

    def __init__(self, failure: type[httpx.TransportError] = httpx.ConnectError) -> None:
        self.failure = failure
        self.requests: list[tuple[str, str]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.method, request.url.path))
        raise self.failure("simulated: no answer", request=request)
```
Create `tests/test_adapters_unreachable.py`:
```python
"""S40 / D21: an ENGINE that could not be reached at all is its own fact.

A connect-phase failure — the connection refused, never answered, or the
proxy that would carry it failing — is `ProviderUnreachable`, a
`ProviderRefused` so every path that relays a refusal still does. It is
raised only for an engine (a row on the ollama adapter), and data_plane
never walls it. An engine that ACCEPTED the request and then failed (a read
timeout while a model loads, a dropped connection) is still a plain refusal
that walls that model — the 2026-09-10 rule in 007_wall_scope.sql. A cloud
provider's connect failure is unchanged.
"""

from __future__ import annotations

import types

import httpx
import pytest

from app.adapters import ProviderRefused, ProviderUnreachable, ollama, openai_chat
from app.main import app
from tests.fakes import FailingTransport

REQUEST = types.SimpleNamespace(app=app)  # the adapters read only request.app
BODY = {"messages": [{"role": "user", "content": "hi"}], "stream": True}
ENGINE = {
    "name": "hub",
    "adapter": "ollama",
    "base_url": "",
    "auth_shape": "none",
    "api_key": None,
    "builtin": True,
    "local": True,
    "usage_supported": True,
}
CLOUD = {
    "name": "openrouter",
    "adapter": "openai-chat",
    "base_url": "http://cloud.test/v1",
    "auth_shape": "static-bearer",
    "api_key": "sk-1",
    "local": False,
    "usage_supported": True,
}


@pytest.fixture
def engine_url(monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    return "http://ollama.test/v1"


@pytest.mark.parametrize("failure", [httpx.ConnectError, httpx.ConnectTimeout, httpx.ProxyError])
async def test_an_engine_that_never_took_the_request_is_unreachable(
    engine_url, mount_transport, failure
):
    transport = FailingTransport(failure)
    mount_transport(engine_url, transport)

    with pytest.raises(ProviderUnreachable) as caught:
        await ollama.ADAPTER.completions(REQUEST, ENGINE, "qwen3:8b", BODY)

    assert isinstance(caught.value, ProviderRefused), "every relay path still catches it"
    assert caught.value.status == 502
    assert caught.value.detail.startswith(
        f"could not reach hub at {engine_url} — {failure.__name__}"
    )
    assert transport.requests == [("POST", "/v1/chat/completions")]


@pytest.mark.parametrize(
    "failure", [httpx.ReadTimeout, httpx.RemoteProtocolError, httpx.WriteError]
)
async def test_an_engine_that_took_the_request_and_then_failed_is_a_refusal(
    engine_url, mount_transport, failure
):
    mount_transport(engine_url, FailingTransport(failure))

    with pytest.raises(ProviderRefused) as caught:
        await ollama.ADAPTER.completions(REQUEST, ENGINE, "qwen3:8b", BODY)

    assert not isinstance(caught.value, ProviderUnreachable)
    assert caught.value.status == 502


async def test_a_cloud_provider_that_never_connects_is_the_refusal_it_always_was(mount_transport):
    mount_transport("http://cloud.test", FailingTransport(httpx.ConnectError))

    with pytest.raises(ProviderRefused) as caught:
        await openai_chat.ADAPTER.completions(REQUEST, CLOUD, "remote-model", BODY)

    assert not isinstance(caught.value, ProviderUnreachable)
    assert caught.value.detail.startswith(
        "could not reach openrouter at http://cloud.test/v1 — ConnectError"
    )
```
Append to `tests/test_ollama_show.py`, after the `show_to_facts` tests:
```python
def test_suits_chat_is_a_declared_completion_without_embedding():
    """The rule the routing standby uses, and the one catalog.local_row
    applies to suitability.chat: ollama's manifest must SAY completion and
    must not say embedding. A model that declares nothing is not a chat
    model — never guessed into one."""
    _f, chat = ollama.show_to_facts(QWEN3_8B_SHOW)
    _f, embedder = ollama.show_to_facts({**QWEN3_8B_SHOW, "capabilities": ["embedding"]})
    _f, both = ollama.show_to_facts(
        {**QWEN3_8B_SHOW, "capabilities": ["completion", "embedding"]}
    )
    _f, silent = ollama.show_to_facts({**QWEN3_8B_SHOW, "capabilities": []})

    assert ollama.suits_chat(chat) is True
    assert ollama.suits_chat(embedder) is False
    assert ollama.suits_chat(both) is False
    assert ollama.suits_chat(silent) is False
    assert ollama.suits_chat({}) is False
```

- [ ] **Step 1.2: Run red.**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && uv run pytest tests/test_adapters_unreachable.py tests/test_ollama_show.py -q
```
Expected:
- `ERROR collecting tests/test_adapters_unreachable.py — ImportError: cannot import name 'ProviderUnreachable' from 'app.adapters'`.
- `test_suits_chat_is_a_declared_completion_without_embedding` fails with `AttributeError: module 'app.adapters.ollama' has no attribute 'suits_chat'`.

- [ ] **Step 1.3: Implement.** In `app/adapters/base.py`, insert after `ProviderRefused` (after `:26`):
```python
class ProviderUnreachable(ProviderRefused):
    """An ENGINE that could not be reached at all: the connect phase failed
    (CONNECT_PHASE_ERRORS), so nothing was learned about any model on it.

    A ProviderRefused, so every path that relays a refusal still relays this
    one in the same words. It exists for one decision: data_plane never walls
    it (D21). A wall outlives the outage it describes — a local model's wall
    is never cleared by a success (routing.note_success clears cloud rows
    only) — while the engine's own observation (engines.observe, a failure
    cached 10 s) is the fact the next walk reads.

    Raised only for an engine. A cloud provider's connect failure stays a
    plain ProviderRefused and walls as it always has."""


# The failures that happen before a peer has taken the request at all. A
# ReadTimeout is NOT one of them: the engine accepted the request and then did
# not answer inside the read budget — on the bundled engine that is a model
# still loading, which walls THAT model (routing.OUTAGE_STEPS_S; the
# 2026-09-10 incident in migrations/007_wall_scope.sql).
CONNECT_PHASE_ERRORS: tuple[type[httpx.HTTPError], ...] = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ProxyError,
)
```
In `app/adapters/__init__.py`, add `ProviderUnreachable,` to the `from app.adapters.base import (...)` list (`:11-18`) and `"ProviderUnreachable",` to `__all__` (`:34-42`).

In `app/adapters/openai_chat.py`, add `CONNECT_PHASE_ERRORS,` and `ProviderUnreachable,` to the `from app.adapters.base import (...)` block (`:24-36`). Then replace `:477-497` with:
```python
    async def completions(
        self, request: Request, row: dict, model: str, body: dict, *, engine: bool = False
    ) -> Response:
        """`engine` is True when an ENGINE's chat rides this adapter (the ollama
        adapter's /v1): a connect-phase failure is then ProviderUnreachable —
        never a wall (D21) — instead of a refusal."""
        return await self._completions(request.app, row, model, body, engine=engine)

    async def _completions(
        self, app, row: dict, model: str, body: dict, *, engine: bool = False
    ) -> Response:
        url = base_url_of(row)
        if not url:
            raise ProviderRefused(502, f"provider {row['name']!r} has no base URL")
        body = dict(body, model=model) if model else dict(body)
        asked_for_usage = False
        if row.get("usage_supported") is not False:
            body, asked_for_usage = inject_usage(body, url)
        client = http_client(app, COMPLETIONS_TIMEOUT, base_url=url, headers=self.headers(row))
        try:
            upstream = await client.send(
                client.build_request("POST", "/chat/completions", json=body), stream=True
            )
        except httpx.HTTPError as exc:
            await client.aclose()
            detail = f"could not reach {row['name']} at {url} — {reason(exc)}"
            if engine and isinstance(exc, CONNECT_PHASE_ERRORS):
                raise ProviderUnreachable(502, detail) from exc
            raise ProviderRefused(502, detail) from exc
```
In the same file, the usage retry (`:514-516`) becomes:
```python
                return await self._completions(
                    app, dict(row, usage_supported=False), model, strip_usage(body), engine=engine
                )
```
In `app/adapters/ollama.py`, insert after `show_to_facts` (after `:228`):
```python
def suits_chat(capabilities: dict) -> bool:
    """ollama's own manifest says this model can hold a chat: `completion`
    declared and `embedding` not — the rule catalog.local_row applies to a
    row's suitability.chat. `capabilities` is show_to_facts' second half. A
    model that declares nothing is never assumed to chat."""

    def declared(key: str) -> bool:
        entry = capabilities.get(key)
        return isinstance(entry, dict) and entry.get("value") is True

    return declared("completion") and not declared("embedding")
```
Then replace `Ollama.completions` (`:345-352`) with:
```python
    async def completions(self, request: Request, row: dict, model: str, body: dict) -> Response:
        # Chat rides ollama's OpenAI-compatible surface at {OLLAMA_URL}/v1, as
        # an ENGINE: a connection that is never accepted is ProviderUnreachable
        # (never a wall), not a refusal.
        if not base_url_of(row):
            raise ProviderRefused(502, "OLLAMA_URL is unset — cannot reach ollama")
        chat_row = dict(
            row, adapter="openai-chat", base_url=f"{base_url_of(row)}/v1", auth_shape="none"
        )
        return await openai_chat.ADAPTER.completions(request, chat_row, model, body, engine=True)
```

- [ ] **Step 1.4: Run green.** Same command as Step 1.2. Expected: all pass, 7 parametrized cases plus 1.

- [ ] **Step 2.1: Failing test for the ledger column.** Add to `tests/test_usage.py` after `test_the_check_constraint_refuses_dollars_on_a_local_row` (`:241-253`):
```python
async def test_the_ledger_row_says_where_the_call_ran_and_null_when_not_known(pool):
    """S40 / D10: `served_on` is the compute a completion ran on, stamped
    when it ran. Not known is NULL — never '' and never a guess — and a row
    written before this column existed stays NULL: a measurement never
    changes meaning after it is written."""
    stamp = "gpu:cuda:GPU-8f0c1d2e-3a4b-5c6d-7e8f-90a1b2c3d4e5"
    event = dict(
        provider="hub",
        model="qwen3:8b",
        served_by="hub:qwen3:8b",
        kind="completion",
        attribution=usage.Attribution(purpose="chat"),
        duration_ms=1200,
        local=True,
        status=200,
    )
    assert await usage.record(pool, usage.Event(**event, served_on=stamp)) is True
    assert await usage.record(pool, usage.Event(**event)) is True

    assert [r["served_on"] for r in await _rows(pool)] == [stamp, None]
    assert [e["served_on"] for e in await usage.events(pool, limit=10)] == [None, stamp]
```

- [ ] **Step 2.2: Run red.**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t3 uv run pytest tests/test_usage.py -q -k served_on
```
Expected: `TypeError: Event.__init__() got an unexpected keyword argument 'served_on'`.

- [ ] **Step 2.3: Implement in `app/usage.py`.**
  - `Event` (`:331-346`): add `served_on: str | None = None` as the last field, with the comment `# D10 compute id (data_plane.served_stamp); None = not known, never guessed`.
  - `record` (`:355-381`): change the INSERT to:
```python
        await pool.execute(
            "INSERT INTO usage_events (provider, model, served_by, kind, purpose, role, turn_id, "
            "person_id, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, "
            "duration_ms, local, cost_usd, cost_basis, status, error, route_reason, route_link, "
            "served_on) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, $8::uuid, $9, $10, $11, $12, $13, $14, "
            "$15, $16, $17, $18, $19, $20, $21)",
            event.provider,
            event.model,
            event.served_by,
            event.kind,
            event.attribution.purpose,
            event.attribution.role,
            event.attribution.turn_id,
            event.attribution.person_id,
            c.prompt_tokens,
            c.completion_tokens,
            c.cache_read_tokens,
            c.cache_write_tokens,
            event.duration_ms,
            event.local,
            None if event.local else event.cost_usd,
            None if event.local else event.cost_basis,
            event.status,
            event.error,
            event.route_reason,
            event.route_link,
            event.served_on,
        )
```
  - `observe` (`:432-467`): add the keyword `served_on: str | None = None` after `route`. Add this sentence to the docstring: "`served_on` is where the call ran (data_plane stamps it before the first byte); a refusal is given None." In `base_event`, add `served_on=served_on,` to the `Event(...)` call.
  - `events` (`:1024-1028`): the SELECT's last line becomes `f"local, cost_usd, cost_basis, metered, status, error, route_reason, route_link, served_on "`.

- [ ] **Step 2.4: Run green.** Same command as Step 2.2. Expected: 1 passed. Then run all of `tests/test_usage.py`; expected green.

- [ ] **Step 3.1: Failing tests for routing, and the test moves that go with it.**
  - Change the `fresh_upstream_caches` fixture in `tests/conftest.py` (`:96-109`) to:
```python
@pytest.fixture(autouse=True)
def fresh_upstream_caches():
    """S10a's live-source caches (Hub pages and details, registry
    manifests) and the Hub request budget are process-local — cleared
    around every test so a page one test fetched can never answer
    another's assertion, and no test starts with a spent budget. S40 adds
    the engines' observations (a listing is cached 30 s, a failure 10 s)
    and ollama's /api/show answers — content-addressed by digest, and the
    fakes derive a digest from the tag name, so one test's faked
    capabilities would otherwise answer another's."""
    from app import engines, hf_hub, ollama_registry
    from app.adapters import ollama

    def _clear() -> None:
        hf_hub.clear()
        ollama_registry.clear()
        engines.clear_cache()
        ollama.SHOW_CACHE.clear()

    _clear()
    yield
    _clear()
```
  - `tests/test_routing.py` imports (`:16-23`) become:
```python
import json
from decimal import Decimal

import httpx
import pytest

from app import backends, engines, routing, usage
from app.adapters import ollama as ollama_mod
from tests.conftest import requires_db
from tests.fakes import FailingTransport, FakeOllama, FakeOpenAICompat
```
  - Moves in `tests/test_routing.py`:
    - `:56` and `:359`: `routing.clear_tags_cache()` becomes `engines.clear_cache()`. Routing no longer owns a listing cache; it lives in `engines`.
    - `:226-245`: the `by_name` row becomes `{"hub": {"name": "hub", "adapter": "ollama", "local": True, "is_default": True, "serving": True}}`, and every `judge_link(..., "UTC", ())` becomes `judge_link(..., "UTC", {})`. `judge_link` now reads the engine's switch and `adapter` off the row and takes each engine's observation as a map. The assertions (walled versus not walled) do not change.
    - `:349-352`: the expected string becomes `"fell back to local standby hub:qwen3:8b (hub's default model qwen3:8b)"`. The standby now names the engine it fell to. "The bundled ollama" stops being a unique name once machines are engines.
  - Append to `tests/test_routing.py`:
```python
async def test_a_switched_off_engine_is_skipped_by_name_and_never_called(
    client, pool, local, mount_backend
):
    """S40: `engines.serving` is the owner's "this machine runs chat models"
    switch — installed is not the same as used. A link on a switched-off
    engine is judged `switched_off` BEFORE anything is asked of it, the next
    link answers, and the route says which link was passed over and why. It
    is the owner's choice, not a failure: nothing is walled. Switched back
    on, it is link 1 again."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["openrouter:remote-model"]})
    stored = await engines.set_serving(pool, "hub", False)
    assert stored["serving"] is False

    resp = await _chat(client, "chat", model="hub:qwen3:8b")

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "openrouter:remote-model"
    route = _route_chunk(resp.content)
    assert route["link"] == 2
    assert "hub:qwen3:8b: hub is switched off" in route["reason"]
    assert not [p for p, _ in local.seen if p.endswith("/chat/completions")]
    assert await pool.fetch("SELECT provider FROM provider_walls") == []
    ex = (await client.get("/admin/route/explain?role=chat&model=hub:qwen3:8b")).json()
    assert [v["verdict"] for v in ex["chain"]] == ["switched_off", "runnable"]
    assert ex["would_serve"]["served_by"] == "openrouter:remote-model"

    await engines.set_serving(pool, "hub", True)
    resp = await _chat(client, "chat", model="hub:qwen3:8b")
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    assert resp.headers["x-nova-route"] == "role=chat;link=1"


async def test_a_switched_off_engine_with_nothing_behind_it_is_a_stated_503(client, pool, local):
    """With no other link, the walk says so — never the switched-off engine,
    whether the owner picked it or it is the default's model on a role
    with no chain at all."""
    await engines.set_serving(pool, "hub", False)

    picked = await _chat(client, "chat", model="hub:qwen3:8b")
    unpicked = await _chat(client, "scheduled")

    for resp in (picked, unpicked):
        assert resp.status_code == 503
        assert "hub is switched off" in resp.json()["error"]
    assert not [p for p, _ in local.seen if p.endswith("/chat/completions")]


async def test_an_engine_that_cannot_list_is_asked_once_per_failure_window(
    client, pool, local, mount_backend, mount_transport
):
    """The engine's listing is read through engines.observe, whose cache
    remembers a FAILURE too (10 s; a ready listing 30 s). Before S40 a
    failure was never cached (routing.py:293-294), so every routed turn
    waited out the listing timeout again. The link still says why it was
    passed over, naming the engine."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["openrouter:remote-model"]})
    down = FailingTransport(httpx.ConnectError)
    mount_transport("http://ollama.test", down)
    engines.clear_cache()

    first = await _chat(client, "chat", model="hub:qwen3:4b")
    asked = len(down.requests)
    second = await _chat(client, "chat", model="hub:qwen3:4b")

    for resp in (first, second):
        assert resp.headers["x-nova-served-by"] == "openrouter:remote-model"
        route = _route_chunk(resp.content)
        assert route["link"] == 2
        assert "hub could not be asked what is installed" in route["reason"]
    assert asked >= 1, "the first turn asked the engine"
    assert len(down.requests) == asked, "the second turn read the cached failure"
    assert await pool.fetch("SELECT provider FROM provider_walls") == []


async def test_the_standby_is_only_ever_a_serving_engine(client, pool, local, mount_backend):
    """The owner's switch holds on the standby path too: a chain with no
    runnable link does not fall to an engine that was switched off."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/judge", json={"chain": ["openrouter:remote-model"]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))
    await engines.set_serving(pool, "hub", False)

    resp = await _chat(client, "judge")

    assert resp.status_code == 503
    assert "over its monthly cap $0.00" in resp.json()["error"]
    assert not [p for p, _ in local.seen if p.endswith("/chat/completions")]


async def test_the_standby_never_hands_a_chat_turn_to_an_embedding_model(
    client, pool, mount_backend, monkeypatch
):
    """The bundled engine is also the embedder (D8), so an embedding model
    sits in its listing — and the old last resort, the first tag in sorted
    order (routing.py:388), handed a chat turn to whichever embedder sorted
    first. ollama's own /api/show says which models chat (completion
    without embedding); the standby reads that."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(tags=("all-minilm:latest", "zz-chat:1b"))
    fake.show["all-minilm:latest"]["capabilities"] = ["embedding"]
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})  # no default model on the engine
    ollama_mod.SHOW_CACHE.clear()
    engines.clear_cache()
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/judge", json={"chain": ["openrouter:remote-model"]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))

    resp = await _chat(client, "judge")

    assert resp.status_code == 200
    route = _route_chunk(resp.content)
    assert route["standby"] is True and route["served_by"] == "hub:zz-chat:1b"
    assert "the first installed chat model on hub, zz-chat:1b" in route["reason"]
    sent = [body for path, body in fake.seen if path == "/v1/chat/completions"]
    assert [body["model"] for body in sent] == ["zz-chat:1b"]
```

- [ ] **Step 3.2: Run red.**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t3 uv run pytest tests/test_routing.py -q
```
Expected failures:
- `test_a_switched_off_engine_is_skipped_by_name_and_never_called`: `assert 'hub:qwen3:8b' == 'openrouter:remote-model'`.
- `test_a_switched_off_engine_with_nothing_behind_it_is_a_stated_503`: `assert 200 == 503`.
- `test_an_engine_that_cannot_list_is_asked_once_per_failure_window`: the reason assertion (old text "ollama could not be asked…") or the request count.
- `test_the_standby_is_only_ever_a_serving_engine`: `assert 200 == 503`.
- `test_the_standby_never_hands_a_chat_turn_to_an_embedding_model`: `assert 'hub:all-minilm:latest' == 'hub:zz-chat:1b'`.
- `test_a_chain_with_no_runnable_and_no_local_link_falls_to_the_stated_standby`: the moved text.

Everything else stays green.

- [ ] **Step 3.3: Implement `app/routing.py`.**
  - **Docstring.** Change `:14-17` to:
    ```
      * a cloud provider must be under its monthly cap and the total cap
        (usage.over_cap — recorded spend only; a local provider is never
        capped in USD);
      * an ENGINE (a row on the ollama adapter) must be SERVING — its
        owner's switch, engines.serving — and must list the model
        (engines.observe: a listing cached 30 s, a failure 10 s).
    ```
    Change `:19-23` to:
    ```
    The first runnable link serves. When nothing in the chain can and the
    chain has no local link, a CROSS-TIER STANDBY is derived (a serving
    engine's default model if installed, else the best-fitting installed
    curated pick, else its first installed chat model — never an embedding
    model) and stated as such — never a cloud model the owner did not
    ```
  - **Imports** (`:37-49`): add `import asyncio`, add `engines` to the `from app import ...` lines, and delete `from app.cache import TTLCache`. Run `uv run ruff check --select I --fix app/routing.py` to order them.
  - **Cache constants:** delete `:71-72` (`TAGS_TTL_S`, `TAGS_CACHE`).
  - **The walk:** replace `:274-484` (from `# ── the walk` through the end of `resolve`) with:
```python
# ── the walk ───────────────────────────────────────────────────────────────

# How long the standby waits on ollama's own /api/show answers before it
# passes over an engine: a stalled engine costs its candidates, never the
# turn (catalog.SHOW_DEADLINE_S's reasoning, sized for a turn in flight).
STANDBY_SHOW_DEADLINE_S = 5.0


def _provider_of(link: str, by_name: dict[str, dict]) -> tuple[str | None, str]:
    """(provider name or None, model) for one chain link. A bare id is a
    model on the DEFAULT provider — the same rule providers.resolve applies
    to every request (a local tag like qwen3.8:27b has a colon of its own
    and no provider prefix)."""
    provider_name, model = providers.split_model_id(link, set(by_name))
    if provider_name is None and model:
        default = next((r for r in by_name.values() if r.get("is_default")), None)
        if default is not None:
            provider_name = default["name"]
    return provider_name, model


def switched_off(row: dict) -> str | None:
    """Why this engine serves nothing right now, or None. `serving` is the
    owner's switch (engines.serving; PUT /admin/engines/{name}) — installed
    is not the same as used. A row that is not an engine has no switch."""
    if engines.is_engine(row) and row.get("serving") is False:
        return (
            f"{row['name']} is switched off (serving=false) — it serves no models "
            "until it is switched back on"
        )
    return None


async def installed_sizes(
    app, pool: asyncpg.Pool, engine: str = engines.BUILTIN
) -> dict[str, int | None] | None:
    """{tag -> download size in bytes} for what `engine` lists (the bundled
    engine unless one is named), or None when it could not be asked — read
    through engines.observe, whose per-engine cache holds a ready listing
    30 s and a failure 10 s. admin._fit_context sizes models from it."""
    return await engines.installed_sizes(app, pool, engine)


def _installed(names: set[str] | None, model: str) -> bool | None:
    if names is None:
        return None
    return model in names or f"{model}:latest" in names


async def judge_link(
    app,
    pool,
    link: str,
    by_name: dict[str, dict],
    walled: dict,
    timezone: str,
    seen: dict[str, engines.EngineView],
) -> dict:
    """One link's live verdict: runnable, or why not — in words.

    `seen` is this walk's observation of each engine the chain names
    (engines.observe), keyed by engine name. An engine its owner switched
    off is judged first, and nothing is asked of it."""
    provider_name, model = _provider_of(link, by_name)
    if provider_name is None or not model:
        return {
            "id": link,
            "verdict": "unknown",
            "reason": f"{link!r} names no registered provider",
        }
    row = by_name[provider_name]
    entry = {"id": link, "provider": provider_name, "model": model, "local": bool(row.get("local"))}
    off = switched_off(row)
    if off is not None:
        return {**entry, "verdict": "switched_off", "reason": off}
    wall = wall_for(walled, provider_name, model)
    if wall is not None:
        left = int((wall["walled_until"] - datetime.now(UTC)).total_seconds() // 60) + 1
        return {
            **entry,
            "verdict": "walled",
            "reason": f"{wall['reason']} — walled for another {left} min",
            "walled_until": wall["walled_until"].isoformat(),
        }
    capped = await usage.over_cap(pool, row, timezone)
    if capped:
        return {**entry, "verdict": "over_cap", "reason": capped}
    if engines.is_engine(row):
        view = seen.get(provider_name)
        names = None if view is None or view.tags is None else set(view.tags)
        installed = _installed(names, model)
        if installed is False:
            return {
                **entry,
                "verdict": "not_installed",
                "reason": f"{model} is not installed on {provider_name}",
            }
        if installed is None:
            why = f" — {view.reason}" if view is not None and view.reason else ""
            return {
                **entry,
                "verdict": "unreachable",
                "reason": f"{provider_name} could not be asked what is installed{why}",
            }
    return {**entry, "verdict": "runnable", "reason": None}


async def _chat_models(app, row: dict, names: set[str]) -> set[str]:
    """The models among `names` that ollama's own /api/show declares fit for
    a chat turn (ollama.suits_chat: completion without embedding). A model
    whose show could not be read declares nothing and is left out — never
    guessed into a chat.

    The answers are content-addressed (ollama.SHOW_CACHE, keyed by the
    /api/tags digest — which is why the listing is read here rather than
    taken from the engine's cached name→size map), so once they are cached
    this costs one /api/tags read."""
    try:
        listing = await ollama.ADAPTER.list_models(app, row)
        rows = [m for m in listing.models if m["id"] in names]
        shown = await asyncio.wait_for(
            ollama.facts_for_installed(app, providers.base_url_of(row), rows),
            STANDBY_SHOW_DEADLINE_S,
        )
    except (ProviderRefused, TimeoutError) as exc:
        logger.warning("standby: %s could not say which models chat — %s", row["name"], exc)
        return set()
    return {
        name
        for name, facts in shown.items()
        if ollama.suits_chat(facts.get("capabilities") or {})
    }


async def standby(
    app,
    pool,
    fit_context,
    latest_probes,
    candidates: list[dict],
    seen: dict[str, engines.EngineView],
) -> tuple[dict, str, str] | None:
    """(row, model, why) — the local model to fall to when a chain has no
    runnable link and names no local model.

    Only an engine that is SERVING (its owner's switch) and whose listing
    could be read is considered, in engines.rows' order (the builtin
    first), and only a model ollama declares fit for chat: the bundled
    engine is also the embedder (D8), and the old last resort — the first
    tag in sorted order — would hand a chat turn to whichever embedder
    sorted first. On each engine: its default model if installed, else the
    best-fitting installed curated pick (curated order, first that is not
    wont_fit), else its first installed chat model."""
    curated = curated_mod.load_curated()
    ctx: dict | None = None
    probes: dict = {}
    for row in candidates:
        if switched_off(row) is not None:
            continue
        name = row["name"]
        view = seen.get(name) or await engines.observe(app, pool, row, live=False)
        if not view.tags:
            continue
        chat = await _chat_models(app, row, set(view.tags))
        if not chat:
            continue
        default = row.get("default_model")
        if default and _installed(chat, default):
            return row, default, f"{name}'s default model {default}"
        for entry in curated:
            slug = entry["slug"]
            if not _installed(chat, slug):
                continue
            if ctx is None:
                # Asked only when a curated pick is installed: the card is read
                # when a fit verdict is needed, never on the way past.
                ctx = await fit_context(app, pool)
                probes = await latest_probes(pool, [e["slug"] for e in curated])
            needed_gb, source = fit_mod.needed_gb_for(entry, probes.get(slug))
            verdict = fit_mod.compute_fit(
                needed_gb, ctx["free_gb"], ctx["total_gb"], source=source, reason=ctx["reason"]
            )
            if verdict.get("verdict") != "wont_fit":
                return (
                    row,
                    slug,
                    f"the best-fitting installed curated pick {slug} on {name} "
                    f"({verdict.get('verdict')})",
                )
        first = sorted(chat)[0]
        return row, first, f"the first installed chat model on {name}, {first}"
    return None


async def resolve(
    app,
    pool: asyncpg.Pool,
    *,
    role: str,
    requested: str | None,
    timezone: str,
    fit_context,
    latest_probes,
    skip: set[str] | None = None,
    unreachable: dict[str, str] | None = None,
) -> Decision:
    """The link that serves this call, decided BEFORE any provider is
    called. `skip` names links already refused in this request (the
    in-request fallback after a live refusal); `unreachable` maps links this
    request could not reach at all to the words why. Both are keyed by the
    served id (`provider:model`), so a bare link in the chain matches too,
    and neither is asked again in the same request."""
    validate_role(role)
    by_name = {r["name"]: r for r in await providers.list_rows(pool)}
    engine_names: list[str] = []
    for row in await engines.rows(pool):
        # The provider row plus its engines columns (serving, lifecycle, ...).
        by_name[row["name"]] = {**by_name.get(row["name"], {}), **row}
        engine_names.append(row["name"])
    all_chains = await chains(pool)
    chain = list(all_chains.get(role) or [])
    if not chain and role != "chat":
        chain = list(all_chains.get("chat") or [])
    if requested:
        # The explicit pick is link 1; the chain holds the fallbacks.
        chain = [requested] + [c for c in chain if c != requested]
    if not chain:
        # No pick and no chain: today's rule — the default provider's model,
        # unless the default is an engine its owner switched off.
        default = await providers.default_row(pool)
        model = default.get("default_model") or ""
        link_id = f"{default['name']}:{model}"
        off = switched_off(by_name.get(default["name"], default))
        if off is not None:
            raise NothingRunnable(
                role,
                [
                    {
                        "id": link_id,
                        "provider": default["name"],
                        "model": model,
                        "local": bool(default.get("local")),
                        "verdict": "switched_off",
                        "reason": off,
                        "link": 1,
                    }
                ],
            )
        return Decision(
            row=default,
            model=model,
            link=1,
            reason=None,
            role=role,
            verdicts=[
                {
                    "id": link_id,
                    "verdict": "runnable",
                    "reason": "no chain; the default provider's model",
                }
            ],
        )
    walled = await walls(pool)
    # Observe only the engines this chain names, once each, and never one
    # its owner switched off.
    seen: dict[str, engines.EngineView] = {}
    for link in chain:
        name, _model = _provider_of(link, by_name)
        row = by_name.get(name) if name else None
        if (
            row is not None
            and name not in seen
            and engines.is_engine(row)
            and switched_off(row) is None
        ):
            seen[name] = await engines.observe(app, pool, row, live=False)
    verdicts: list[dict] = []
    has_local = False
    for index, link in enumerate(chain, 1):
        verdict = await judge_link(app, pool, link, by_name, walled, timezone, seen)
        verdict["link"] = index
        served_as = f"{verdict['provider']}:{verdict['model']}" if verdict.get("provider") else link
        if unreachable and served_as in unreachable:
            verdict["verdict"] = "unreachable"
            verdict["reason"] = unreachable[served_as]
        elif skip and served_as in skip:
            verdict["verdict"] = "refused"
            verdict["reason"] = f"{link} refused this request"
        verdicts.append(verdict)
        has_local = has_local or bool(verdict.get("local"))
        if verdict["verdict"] == "runnable":
            reason = None
            if index > 1:
                skipped = "; ".join(f"{v['id']}: {v['reason']}" for v in verdicts[:-1])
                reason = f"fell back to link {index} ({link}) — {skipped}"
            return Decision(
                row=by_name[verdict["provider"]],
                model=verdict["model"],
                link=index,
                reason=reason,
                role=role,
                verdicts=verdicts,
            )
    if not has_local:
        candidates = [by_name[name] for name in engine_names]
        fallback = await standby(app, pool, fit_context, latest_probes, candidates, seen)
        if fallback is not None:
            row, model, why = fallback
            standby_id = f"{row['name']}:{model}"
            entry = {
                "id": standby_id,
                "provider": row["name"],
                "model": model,
                "local": True,
                "link": len(verdicts) + 1,
            }
            if unreachable and standby_id in unreachable:
                reason = f"standby: {unreachable[standby_id]}"
                verdicts.append({**entry, "verdict": "unreachable", "reason": reason})
            elif skip and standby_id in skip:
                reason = f"standby: {standby_id} refused this request"
                verdicts.append({**entry, "verdict": "refused", "reason": reason})
            else:
                skipped = "; ".join(f"{v['id']}: {v['reason']}" for v in verdicts)
                verdicts.append({**entry, "verdict": "runnable", "reason": f"standby: {why}"})
                return Decision(
                    row=row,
                    model=model,
                    link=len(verdicts),
                    reason=f"fell back to local standby {standby_id} ({why}) — {skipped}",
                    role=role,
                    verdicts=verdicts,
                    standby=True,
                )
    raise NothingRunnable(role, verdicts)
```
  - Delete `clear_tags_cache` (`:511-512`). Add `"switched_off"` to `__all__`.
  - Note that the qualified `served_as` key also fixes an existing gap. A bare link that refused (for example the owner's bare `chat.model`) never matched `skip`'s `provider:model` key, so it could be retried up to 6 times in one request.

- [ ] **Step 3.4: Run green.**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t3 uv run pytest tests/test_routing.py tests/test_catalog.py tests/test_admin_suggest_fit.py tests/test_admin_hardware_and_suggest.py tests/test_hardware_json_not_in_serving_path.py -q
```
Expected: all green. `admin._fit_context` still calls `routing.installed_sizes(app, pool)` through the shim.

- [ ] **Step 4.1: Failing tests for the data plane.** Create `tests/test_served_on.py`:
```python
"""S40 / D10: a completion an engine answered says WHERE it ran.

`X-Nova-Served-On` is the compute id (the grammar in
docs/contracts/compute_id_vectors.json) read for THIS request: ollama's own
/api/ps `size`/`size_vram` for the model that just answered, against this
host's devices. `X-Nova-Served-Runtime` is how the engine runs. The ledger
row keeps `served_on`. Anything not known is omitted — never guessed, never
the last value seen.
"""

from __future__ import annotations

import pytest

from app import backends, compute_id, data_plane, devices_vram
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

# The suite-wide fixture swaps this out (no devices under the desk); the
# wiring test below puts the real one back.
REAL_READ_BUNDLED = data_plane.read_bundled_devices

UUID = "GPU-8f0c1d2e-3a4b-5c6d-7e8f-90a1b2c3d4e5"
OTHER_UUID = "GPU-00000000-1111-2222-3333-444444444444"
GPU = compute_id.gpu_cuda(UUID)
CPUINFO = (
    "processor\t: 0\nvendor_id\t: GenuineIntel\n"
    "model name\t: 12th Gen Intel(R) Core(TM) i9-12900K\n\n"
    "processor\t: 1\nvendor_id\t: GenuineIntel\n"
    "model name\t: 12th Gen Intel(R) Core(TM) i9-12900K\n"
)
MEMINFO = "MemTotal:       32767916 kB\nMemFree:         2000000 kB\nMemAvailable:   20000000 kB\n"
CPU = compute_id.cpu_slug(CPUINFO, MEMINFO, 24)
CHAT = {"messages": [{"role": "user", "content": "hi"}], "stream": True}


def _devices(monkeypatch, accelerators: list[str], cpu: str | None) -> None:
    async def _read():
        return list(accelerators), cpu

    monkeypatch.setattr(data_plane, "read_bundled_devices", _read)
    data_plane.clear_bundled_devices()


def _resident(size: int, size_vram: int) -> list[dict]:
    return [{"name": "qwen3:8b", "model": "qwen3:8b", "size": size, "size_vram": size_vram}]


@pytest.fixture
async def hub(pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(ps_models=_resident(6_400_000_000, 6_400_000_000))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    return fake


@requires_db
async def test_an_engine_completion_says_where_it_ran_and_the_ledger_keeps_it(
    client, pool, hub, monkeypatch
):
    _devices(monkeypatch, [GPU], CPU)

    resp = await client.post("/v1/chat/completions", json=CHAT, headers={"X-Nova-Purpose": "chat"})

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    assert resp.headers["x-nova-served-on"] == GPU
    assert resp.headers["x-nova-served-runtime"] == "container"
    (row,) = await pool.fetch("SELECT served_on FROM usage_events WHERE kind = 'completion'")
    assert row["served_on"] == GPU
    paths = [path for path, _ in hub.seen]
    assert paths.index("/api/ps") > paths.index("/v1/chat/completions"), (
        "read after the engine answered — the model is resident by then"
    )


@requires_db
async def test_the_stamp_follows_size_vram_the_vendor_neutral_truth_about_offload(
    client, pool, hub, monkeypatch
):
    _devices(monkeypatch, [GPU], CPU)
    cases = [
        (6_400_000_000, 6_400_000_000, GPU),  # all of it on the card
        (9_000_000_000, 6_000_000_000, "+".join(sorted([CPU, GPU]))),  # part of it on the CPU
        (6_400_000_000, 0, CPU),  # the card never held it
    ]
    for size, size_vram, expected in cases:
        hub.ps_models = _resident(size, size_vram)
        resp = await client.post("/v1/chat/completions", json=CHAT)
        assert resp.status_code == 200
        assert resp.headers["x-nova-served-on"] == expected, (size, size_vram)
    rows = await pool.fetch(
        "SELECT served_on FROM usage_events WHERE kind = 'completion' ORDER BY id"
    )
    assert [r["served_on"] for r in rows] == [expected for _, _, expected in cases]


@requires_db
async def test_what_is_not_known_is_omitted_never_guessed(client, pool, hub, monkeypatch):
    _devices(monkeypatch, [GPU], CPU)
    hub.ps_models = []  # /api/ps does not list the model that answered
    resp = await client.post("/v1/chat/completions", json=CHAT)
    assert resp.status_code == 200
    assert "x-nova-served-on" not in resp.headers
    assert resp.headers["x-nova-served-runtime"] == "container"

    # On a card, but this host reads two: which one is not known.
    _devices(monkeypatch, [GPU, compute_id.gpu_cuda(OTHER_UUID)], CPU)
    hub.ps_models = _resident(6_400_000_000, 6_400_000_000)
    resp = await client.post("/v1/chat/completions", json=CHAT)
    assert "x-nova-served-on" not in resp.headers

    # On a card, and no card could be read here at all.
    _devices(monkeypatch, [], CPU)
    resp = await client.post("/v1/chat/completions", json=CHAT)
    assert "x-nova-served-on" not in resp.headers

    rows = await pool.fetch("SELECT served_on FROM usage_events WHERE kind = 'completion'")
    assert [r["served_on"] for r in rows] == [None, None, None]


@requires_db
async def test_a_refusal_ran_nowhere_and_a_cloud_reply_names_no_hardware(
    client, pool, hub, monkeypatch, mount_backend
):
    _devices(monkeypatch, [GPU], CPU)
    hub.probe_status = 503
    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": False})
    assert resp.status_code == 503
    assert "x-nova-served-on" not in resp.headers
    assert "/api/ps" not in [path for path, _ in hub.seen]

    mount_backend("http://cloud.test", FakeOpenAICompat().app)
    await backends.save_config(
        pool, {"kind": "cloud", "url": "http://cloud.test", "api_key": "sk-x", "model": "m"}
    )
    resp = await client.post("/v1/chat/completions", json=CHAT)
    assert resp.status_code == 200
    assert "x-nova-served-on" not in resp.headers
    assert "x-nova-served-runtime" not in resp.headers


async def test_the_bundled_devices_are_the_card_nvidia_smi_reads_and_the_cpu_proc_describes(
    monkeypatch,
):
    reads: list[int] = []
    reading = devices_vram.parse(f"24576, 1024, 23552, 3, {UUID}, NVIDIA GeForce RTX 3090\n")

    async def _read_vram():
        reads.append(1)
        return reading

    monkeypatch.setattr(devices_vram, "read_vram", _read_vram)
    monkeypatch.setattr(
        data_plane, "_proc_text", {"/proc/cpuinfo": CPUINFO, "/proc/meminfo": MEMINFO}.get
    )
    monkeypatch.setattr(data_plane.os, "cpu_count", lambda: 24)
    monkeypatch.setattr(data_plane, "read_bundled_devices", REAL_READ_BUNDLED)
    data_plane.clear_bundled_devices()

    first = await data_plane.bundled_devices()
    again = await data_plane.bundled_devices()

    assert first == ([GPU], CPU)
    assert again == first
    assert len(reads) == 1, "held in process memory: one nvidia-smi per window, not per reply"

    async def _no_card():
        return devices_vram.Vram(reason="nvidia-smi could not be run — [Errno 2] No such file")

    monkeypatch.setattr(devices_vram, "read_vram", _no_card)
    data_plane.clear_bundled_devices()
    assert await data_plane.bundled_devices() == ([], CPU), "no card read: none remembered"
```
Append to `tests/test_routing.py`:
```python
async def test_an_engine_that_cannot_be_reached_is_never_walled_and_the_next_link_answers(
    client, pool, local, mount_backend, mount_transport
):
    """D21: a connect failure to an engine is not a wall. A wall outlives the
    outage — a local model's wall is never cleared by a success — while the
    engine's own observation is re-read on the next walk. The ledger still
    has the refusal row; the route says why the link was passed over; the
    next turn asks the engine again, once, even through a bare id."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["openrouter:remote-model"]})
    refused = FailingTransport(httpx.ConnectError)
    mount_transport("http://ollama.test/v1", refused)  # chat never connects; /api/* answers

    resp = await _chat(client, "chat", model="hub:qwen3:8b")

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "openrouter:remote-model"
    route = _route_chunk(resp.content)
    assert route["link"] == 2
    assert (
        "hub:qwen3:8b: could not reach hub at http://ollama.test/v1 — ConnectError"
        in route["reason"]
    )
    assert await pool.fetch("SELECT provider, model FROM provider_walls") == []
    rows = await pool.fetch("SELECT kind, provider, status FROM usage_events ORDER BY id")
    assert [(r["kind"], r["provider"], r["status"]) for r in rows] == [
        ("refusal", "hub", 502),
        ("completion", "openrouter", 200),
    ]
    assert refused.requests == [("POST", "/v1/chat/completions")]

    resp = await _chat(client, "chat", model="qwen3:8b")
    assert resp.headers["x-nova-served-by"] == "openrouter:remote-model"
    assert refused.requests == [("POST", "/v1/chat/completions")] * 2
    assert await pool.fetch("SELECT provider FROM provider_walls") == []


async def test_a_cloud_provider_that_cannot_be_reached_is_still_walled(
    client, pool, local, mount_backend, mount_transport
):
    """Only an ENGINE's connect failure is exempt. A cloud provider's walls
    its model for the outage ladder, as before S40."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    mount_transport("http://openrouter.test", FailingTransport(httpx.ConnectError))

    resp = await _chat(client, "chat", model="openrouter:remote-model")

    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    walls = await pool.fetch("SELECT provider, model, status FROM provider_walls")
    assert [(w["provider"], w["model"], w["status"]) for w in walls] == [
        ("openrouter", "remote-model", 502)
    ]


async def test_an_unreachable_standby_is_tried_once_and_the_503_says_why(
    client, pool, local, mount_backend, mount_transport
):
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/judge", json={"chain": ["openrouter:remote-model"]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))
    refused = FailingTransport(httpx.ConnectError)
    mount_transport("http://ollama.test/v1", refused)

    resp = await _chat(client, "judge")

    assert resp.status_code == 503
    error = resp.json()["error"]
    assert "over its monthly cap $0.00" in error
    assert "hub:qwen3:8b: standby: could not reach hub" in error
    assert refused.requests == [("POST", "/v1/chat/completions")]
    assert await pool.fetch("SELECT provider FROM provider_walls") == []
```

- [ ] **Step 4.2: Run red.**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t3 uv run pytest tests/test_served_on.py tests/test_routing.py -q
```
Expected:
- `ERROR collecting tests/test_served_on.py — AttributeError: module 'app.data_plane' has no attribute 'read_bundled_devices'`.
- `test_an_engine_that_cannot_be_reached_is_never_walled_and_the_next_link_answers` fails on `provider_walls` (a `('hub','qwen3:8b')` wall is recorded).
- `test_an_unreachable_standby_is_tried_once_and_the_503_says_why` fails (the error says "standby: hub:qwen3:8b refused this request", and a wall exists).
- `test_a_cloud_provider_that_cannot_be_reached_is_still_walled` passes already. It pins existing behaviour.

- [ ] **Step 4.3: Implement `app/data_plane.py`.**
  - Append to the module docstring (`:1-10`):
    ```
    S40: a completion an ENGINE answered says where it ran — X-Nova-Served-On
    (the D10 compute id, from ollama's own /api/ps size/size_vram read after
    the engine answered, against this host's devices) and
    X-Nova-Served-Runtime — and its ledger row keeps `served_on`. Not known is
    omitted, never guessed. An engine that could not be reached at all
    (adapters.ProviderUnreachable) is relayed like any refusal, and never
    walled.
    ```
  - Replace imports and constants (`:12-28`) with:
```python
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from app import adapters, compute_id, db, devices_vram, engines, providers, routing, usage
from app.adapters import ListingUnavailable, ProviderRefused, ProviderUnreachable
from app.cache import TTLCache

router = APIRouter(tags=["data-plane"])
logger = logging.getLogger("gateway")

SERVED_BY_HEADER = "X-Nova-Served-By"
SERVED_ON_HEADER = "X-Nova-Served-On"
SERVED_RUNTIME_HEADER = "X-Nova-Served-Runtime"
ROUTE_HEADER = "X-Nova-Route"
# ollama's /api/ps is local and answers in milliseconds; bounded so a wedged
# engine costs the stamp (omitted), never the reply.
STAMP_TIMEOUT = httpx.Timeout(2.0)
# The card and the CPU do not change between replies, but nvidia-smi costs a
# process per read — so this host's devices are held in process memory, never
# in the database (a row moves with a backup; the hardware does not). A card
# that vanished (CUDA after a resume) is still stamped truthfully meanwhile:
# ollama then reports size_vram 0, and the stamp is the CPU.
BUNDLED_DEVICES_TTL_S = 300
_BUNDLED_DEVICES = TTLCache(ttl_s=BUNDLED_DEVICES_TTL_S, max_entries=1)


class EngineUnreachable(HTTPException):
    """An engine that could not be reached at all (adapters.ProviderUnreachable),
    relayed with the same status and words as any refusal — a caller with no
    role gets its stated 502. serve_by_role tells it apart for one reason: it
    is never a wall (D21)."""
```
  - Replace `serve_by_role` (`:72-136`) with:
```python
async def serve_by_role(
    request: Request, pool, role: str, requested, body, attribution
) -> Response:
    """Walk the role's chain (app/routing.py). A link that REFUSES before
    streaming is recorded, walled, and the next runnable link is tried in
    this same request — the reply then states the fallback (rail 20). An
    engine that could not be REACHED is recorded and passed over the same
    way, but never walled (D21)."""
    from app import admin  # the fit context and probe query /admin/suggest uses

    skip: set[str] = set()
    unreachable: dict[str, str] = {}
    try:
        routing.validate_role(role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    for _attempt in range(6):
        try:
            decision = await routing.resolve(
                request.app,
                pool,
                role=role,
                requested=requested,
                timezone=attribution.timezone,
                fit_context=admin._fit_context,
                latest_probes=admin._latest_probes,
                skip=skip,
                unreachable=unreachable,
            )
        except routing.NothingRunnable as exc:
            raise HTTPException(
                status_code=503,
                detail=f"{exc} — " + "; ".join(f"{v['id']}: {v['reason']}" for v in exc.verdicts),
            ) from exc
        link = f"{decision.row['name']}:{decision.model}"
        try:
            response = await serve_completion(
                request,
                pool,
                decision.row,
                decision.model,
                body,
                attribution,
                route=decision.as_route(),
            )
        except EngineUnreachable as exc:
            # Never a wall (D21). Forget what the engines last said, so the next
            # walk asks again instead of trusting a listing from before it went.
            engines.clear_cache()
            unreachable[link] = str(exc.detail)
            continue
        except HTTPException as exc:
            if exc.status_code in routing.WALL_STATUSES or exc.status_code >= 500:
                await routing.record_refusal(
                    pool, decision.row, exc.status_code, str(exc.detail), model=decision.model
                )
                skip.add(link)
                continue
            raise
        if response.status_code in routing.WALL_STATUSES or response.status_code >= 500:
            detail = ""
            body_bytes = getattr(response, "body", b"")
            if body_bytes:
                detail = body_bytes.decode(errors="replace")[:200]
            await routing.record_refusal(
                pool, decision.row, response.status_code, detail, model=decision.model
            )
            skip.add(link)
            continue
        if response.status_code == 200 and not decision.row.get("local"):
            await routing.note_success(pool, decision.row["name"], decision.model)
        response.headers[ROUTE_HEADER] = decision.header()
        return response
    raise HTTPException(
        status_code=503, detail=f"every link in the {role!r} chain refused this request"
    )
```
  - Replace `serve_completion` (`:139-184`) with:
```python
async def serve_completion(
    request: Request,
    pool,
    row: dict,
    model: str,
    body: dict,
    attribution,
    route: dict | None = None,
) -> Response:
    """One completion on `row`, METERED: the adapter's response passes
    through usage.observe, which reads the provider's usage off the
    stream, prices it, writes the ledger row when the stream ends, and
    appends the synthetic usage chunk core reads its cost from. A
    refusal is recorded too (kind refusal) before it is raised. A reply
    an engine answered is stamped with where it ran before its first
    byte — headers go first."""
    served_by = _served_by(row, model)
    started = time.monotonic()
    try:
        response = await adapters.for_row(row).completions(request, row, model, body)
    except ProviderRefused as exc:
        await usage.record_probe(
            pool,
            row=row,
            model=model,
            status=exc.status,
            body=b"",
            started=started,
            purpose=attribution.purpose,
            error=exc.detail,
        )
        relay = EngineUnreachable if isinstance(exc, ProviderUnreachable) else HTTPException
        raise relay(
            status_code=exc.status, detail=exc.detail, headers={SERVED_BY_HEADER: served_by}
        ) from exc
    # A refusal ran nowhere: only a 200 is stamped.
    if response.status_code == 200:
        served = await served_stamp(request.app, pool, row, model)
    else:
        served = Served()
    response = await usage.observe(
        pool,
        response,
        row=row,
        model=model,
        served_by=served_by,
        attribution=attribution,
        kind="completion",
        started=started,
        stream=bool(body.get("stream")),
        route=route,
        served_on=served.on,
    )
    response.headers[SERVED_BY_HEADER] = served_by
    for name, value in served.headers().items():
        response.headers[name] = value
    return response
```
  - Insert after `serve_completion`:
```python
# ── where a reply ran (D10) ────────────────────────────────────────────────


@dataclass(frozen=True)
class Served:
    """Where one completion ran: `on` is the D10 compute id, `runtime` how its
    engine runs (container | native | wsl). Either is None when it is not
    known, and its header is then omitted — never guessed."""

    on: str | None = None
    runtime: str | None = None

    def headers(self) -> dict[str, str]:
        out: dict[str, str] = {}
        if self.on:
            out[SERVED_ON_HEADER] = self.on
        if self.runtime:
            out[SERVED_RUNTIME_HEADER] = self.runtime
        return out


async def served_stamp(app, pool, row: dict, model: str) -> Served:
    """Where THIS completion ran, read after the engine answered — so the
    model is resident, and ollama's /api/ps states its `size` and
    `size_vram` (the vendor-neutral truth about offload, D10).

    Only an engine has a stamp: a cloud row's hardware is not ours to name.
    Only the BUILTIN is stamped from this host's devices — the bundled
    container runs here, so the card nvidia-smi reads and the CPU /proc
    describes are the ones it can use. Any other engine's devices are its
    own agent's to report (S44), never this host's guess."""
    if not engines.is_engine(row):
        return Served()
    try:
        engine = await engines.get(pool, row["name"])
    except engines.UnknownEngine:
        return Served()
    view = await engines.observe(app, pool, engine, live=False)
    if not row.get("builtin"):
        return Served(runtime=view.runtime)
    (size, size_vram), (accelerators, cpu) = await asyncio.gather(
        _resident_sizes(app, row, model), bundled_devices()
    )
    return Served(
        on=compute_id.served_on(size, size_vram, accelerators, cpu), runtime=view.runtime
    )


def _bytes(value: object) -> int | None:
    """A byte count ollama stated, or None. 0 is a real reading (size_vram 0:
    the card never held it); a bool is not a number."""
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


async def _resident_sizes(app, row: dict, model: str) -> tuple[int | None, int | None]:
    """(size, size_vram) that ollama's /api/ps states for `model`, or
    (None, None) when it cannot be read or does not list the model."""
    base_url = providers.base_url_of(row)
    if not base_url:
        return None, None
    client = adapters.http_client(
        app, STAMP_TIMEOUT, base_url=base_url, headers=adapters.for_row(row).headers(row)
    )
    try:
        async with client as c:
            resp = await c.get("/api/ps")
        body = resp.json() if resp.status_code == 200 else None
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("served-on: %s's /api/ps could not be read — %s", row["name"], exc)
        return None, None
    entries = body.get("models") if isinstance(body, dict) else None
    wanted = {model, f"{model}:latest"}
    for entry in entries if isinstance(entries, list) else []:
        if isinstance(entry, dict) and (entry.get("name") in wanted or entry.get("model") in wanted):
            return _bytes(entry.get("size")), _bytes(entry.get("size_vram"))
    return None, None


def _proc_text(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return None


async def read_bundled_devices() -> tuple[list[str], str | None]:
    """This host's devices as D10 names them, read now: the accelerator from
    the card nvidia-smi reports (devices_vram: a single card or none) and the
    CPU from /proc. Either half degrades to empty/None, never a guess."""
    reading = await devices_vram.read_vram()
    accelerators = compute_id.bundled_accelerators(reading.as_dict())
    cpuinfo, meminfo = _proc_text("/proc/cpuinfo"), _proc_text("/proc/meminfo")
    nproc = os.cpu_count()
    cpu = None
    if cpuinfo is not None and meminfo is not None and nproc:
        try:
            cpu = compute_id.cpu_slug(cpuinfo, meminfo, nproc)
        except ValueError as exc:
            logger.info("served-on: /proc does not name this CPU in the D10 grammar — %s", exc)
    return accelerators, cpu


async def bundled_devices() -> tuple[list[str], str | None]:
    """read_bundled_devices, held for BUNDLED_DEVICES_TTL_S."""
    hit = _BUNDLED_DEVICES.get("devices")
    if hit is not None:
        accelerators, cpu = hit[0]
    else:
        accelerators, cpu = await read_bundled_devices()
        _BUNDLED_DEVICES.put("devices", (list(accelerators), cpu))
    return list(accelerators), cpu


def clear_bundled_devices() -> None:
    _BUNDLED_DEVICES.clear()
```
  - Add to `tests/conftest.py`, after `fresh_upstream_caches`:
```python
@pytest.fixture(autouse=True)
def no_devices_under_the_desk(monkeypatch):
    """The served-on stamp (app/data_plane.py) names this host's card and
    CPU. A suite that read the real ones would pass or fail by the hardware
    under the desk (the rule tests/test_admin_suggest_fit.py states), so every
    test starts with NO devices read — a stamp is then omitted, never guessed
    — and a test that wants a card fakes it."""
    from app import data_plane

    async def _no_devices():
        return [], None

    monkeypatch.setattr(data_plane, "read_bundled_devices", _no_devices)
    data_plane.clear_bundled_devices()
    yield
    data_plane.clear_bundled_devices()
```

- [ ] **Step 4.4: Run green, then move the pinned tests this breaks.**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t3 uv run pytest tests/test_served_on.py tests/test_routing.py tests/test_providers.py tests/test_data_plane.py tests/test_usage.py -q
```
Expected: the new tests pass. Exactly three existing assertions fail with `TypeError: 'NoneType' object is not subscriptable`. The stamp now reads `/api/ps`, and possibly `/api/tags` through `engines.observe`, after the completion, so `seen[-1]` is no longer the completion. Move them to "the last completion the engine received":
  - `tests/test_routing.py:138`: `assert [b for p, b in local.seen if p == "/v1/chat/completions"][-1]["model"] == "qwen3:4b"`
  - `tests/test_routing.py:391`: `assert [b for p, b in local.seen if p == "/v1/chat/completions"][-1]["model"] == "qwen3:8b"`
  - `tests/test_providers.py:345`: `assert [b for p, b in ollama.seen if p == "/v1/chat/completions"][-1]["model"] == "qwen3.8:27b"`
Run the same command again. Expected: all green.

- [ ] **Step 5: Full gateway suite, then lint only the files this task edited.**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t3 uv run pytest -q
uv run ruff format app/adapters/base.py app/adapters/__init__.py app/adapters/openai_chat.py app/adapters/ollama.py app/routing.py app/data_plane.py app/usage.py tests/conftest.py tests/fakes.py tests/test_adapters_unreachable.py tests/test_served_on.py tests/test_routing.py tests/test_providers.py tests/test_usage.py tests/test_ollama_show.py
uv run ruff check .
grep -rn "clear_tags_cache\|TAGS_CACHE\|TAGS_TTL_S" app tests
```
Expected:
- The whole suite is green; the pass count is Step 0's plus the new tests (7 adapter cases, 1 `suits_chat`, 1 usage, 8 routing, 5 served-on).
- `ruff check` is clean.
- The last grep finds only `app/admin.py:265`, a docstring word. Change that to "cached by app/engines.py" only if T4 has not already rewritten `_fit_context`. Do not edit it in T3.

- [ ] **Step 6: Commit.**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff
git add services/gateway/app/adapters/base.py services/gateway/app/adapters/__init__.py services/gateway/app/adapters/openai_chat.py services/gateway/app/adapters/ollama.py services/gateway/app/routing.py services/gateway/app/data_plane.py services/gateway/app/usage.py services/gateway/tests/conftest.py services/gateway/tests/fakes.py services/gateway/tests/test_adapters_unreachable.py services/gateway/tests/test_served_on.py services/gateway/tests/test_routing.py services/gateway/tests/test_providers.py services/gateway/tests/test_usage.py services/gateway/tests/test_ollama_show.py
git diff --cached --stat   # exactly these 15 files; the worktree's unrelated core edits stay unstaged
git commit -m "$(cat <<'EOF'
feat(gateway): routing walks engines; replies say where they ran (S40 T3)

- judge_link: an engine its owner switched off (engines.serving=false) is
  `switched_off` before anything is asked of it; a listing is read per
  engine through engines.observe (ready 30 s, a failure 10 s)
- standby: serving engines only, and never a model ollama's /api/show
  does not declare fit for chat (completion without embedding)
- a connect-phase failure to an engine is ProviderUnreachable: recorded,
  passed over, never walled; a read timeout still walls that model
  (the 2026-09-10 rule); a cloud connect failure walls as before
- X-Nova-Served-On (D10, from /api/ps size/size_vram against this host's
  devices; omitted when not known) and X-Nova-Served-Runtime on engine
  replies; usage_events.served_on written

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

**Existing tests that move because of T3.** Found with `grep -n "seen\[-1\]\|clear_tags_cache\|judge_link\|bundled ollama's default" tests/*.py`. T2's `ollama:` to `hub:` moves are not repeated here.

| Test | Why it breaks | New value |
|---|---|---|
| `test_routing.py:56` (`local` fixture), `:359` | `routing.clear_tags_cache` is deleted; the cache belongs to `engines` | `engines.clear_cache()` |
| `test_routing.py:226-245` (`test_a_model_that_failed_does_not_wall_its_own_fallback`) | `judge_link`'s last argument is now the per-engine observation map, and it reads `adapter` and `serving` from the row | `()` becomes `{}`; the row gains `"adapter": "ollama", "serving": True` |
| `test_routing.py:349-352` | The standby names its engine | `"fell back to local standby hub:qwen3:8b (hub's default model qwen3:8b)"` |
| `test_routing.py:138`, `:391`, `test_providers.py:345` | `/api/ps` is read after the completion, so `seen[-1]` is not the completion | the last `/v1/chat/completions` body |

These were checked and do **not** break:
- `test_usage.py:210` and `test_data_plane.py:66,84` use `seen[0]`, and the completion is first.
- `test_providers.py:367,865` involve no engine completion.
- Walls that tests record directly through `record_refusal` are not affected.
- `test_hardware_json_not_in_serving_path` does not list `data_plane`.

**Notes for other tasks:**
- **T4:**
  - `admin._fit_context` still sizes models through the `routing.installed_sizes` shim; switch it to `engines.installed_sizes` for each engine, then delete the shim.
  - If `_fit_context` gains an engine parameter, change `routing.standby`'s `fit_context(app, pool)` call to pass `row`.
  - `catalog.py:125` can use `ollama.suits_chat`.
  - Probe stamps should use `data_plane.served_stamp` (Contract Problem 2).
- **T5/T6:** `core/app/tools/route.py:40-48` has no label for `switched_off`, so it prints the raw value. It still says "ollama could not be asked" for `unreachable`, but the gateway's reason now names the engine. Add `"switched_off": "skipped — switched off"` and reword `unreachable` to "skipped — could not be reached". `_gateway_round` reads the `x-nova-served-on` and `x-nova-served-runtime` headers; for cloud replies both are absent.
- **T8:** `apps/web/src/pages/settings/RoutingSection.tsx:66-74` `VERDICT_WORDS` needs `switched_off: 'switched off'`, and `unreachable` reworded from `'ollama unreachable'` to `'could not be reached'`.
- **T1:** `tests/conftest.py` `_TABLES` must include `engines` and `engine_models`. Otherwise a second run reuses a stale `engines` table that has lost its foreign key.

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/routing.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/data_plane.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/adapters/openai_chat.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/usage.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/tests/test_routing.py