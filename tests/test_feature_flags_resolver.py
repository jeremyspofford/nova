"""Unit tests for the feature_flags SDK resolution order."""
import asyncio

import pytest
from nova_contracts import feature_flags as ff
from nova_contracts.feature_flags import (
    FlagDef,
    flag_override,
    register_flag,
)
from nova_contracts.feature_flags_testing import registry_clear


def test_registry_clear_not_exported_from_production_module():
    """Test-only helpers must live in feature_flags_testing, never the prod module."""
    assert not hasattr(ff, "_registry_clear"), (
        "_registry_clear must live in nova_contracts.feature_flags_testing, "
        "not feature_flags — moving it prevents accidental production imports."
    )
    assert not hasattr(ff, "registry_clear"), (
        "registry_clear must not be exported from the prod module either."
    )


def test_sdk_lives_in_nova_contracts_not_nova_worker_common():
    """SDK location is nova-contracts (Pydantic-only contract package).
    nova-worker-common is for shared async utilities, which the SDK isn't.
    """
    import importlib
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("nova_worker_common.feature_flags")


@pytest.fixture(autouse=True)
def clean_registry():
    registry_clear()
    yield
    registry_clear()


def test_flagdef_returns_default_when_no_resolver():
    flag = FlagDef(
        key="test.basic",
        type="bool",
        variants=None,
        default=False,
        description="basic test",
    )
    assert flag.value() is False


def test_register_flag_returns_flagdef():
    flag = register_flag(
        key="test.register",
        type="bool",
        default=False,
        description="test",
    )
    assert flag.key == "test.register"
    assert flag.value() is False


def test_register_flag_idempotent():
    a = register_flag(key="test.dup", type="bool", default=False, description="x")
    b = register_flag(key="test.dup", type="bool", default=False, description="x")
    assert a is b


def test_register_flag_rejects_schema_mismatch():
    register_flag(key="test.mismatch", type="bool", default=False, description="x")
    with pytest.raises(ValueError, match="schema mismatch"):
        register_flag(key="test.mismatch", type="bool", default=True, description="x")


def test_register_flag_rejects_default_not_in_variants():
    with pytest.raises(ValueError, match="default .* not in variants"):
        register_flag(
            key="test.bad_enum",
            type="enum",
            variants=["a", "b"],
            default="c",
            description="x",
        )


def test_register_flag_rejects_bool_with_non_bool_default():
    with pytest.raises(ValueError, match="bool flag .* must have bool default"):
        register_flag(
            key="test.bad_bool",
            type="bool",
            default="true",  # string, not bool
            description="x",
        )


def test_flag_override_returns_overridden_value():
    flag = register_flag(
        key="test.override_basic",
        type="bool",
        default=False,
        description="override basic",
    )
    assert flag.value() is False
    with flag_override("test.override_basic", True):
        assert flag.value() is True
    assert flag.value() is False  # cleared on context exit


def test_flag_override_nested_overrides_innermost_wins():
    flag = register_flag(
        key="test.override_nested",
        type="enum",
        variants=["a", "b", "c"],
        default="a",
        description="nested overrides",
    )
    with flag_override("test.override_nested", "b"):
        assert flag.value() == "b"
        with flag_override("test.override_nested", "c"):
            assert flag.value() == "c"
        assert flag.value() == "b"  # inner restored
    assert flag.value() == "a"  # default restored


def test_flag_override_only_affects_named_key():
    a = register_flag(key="test.scope_a", type="bool", default=False, description="")
    b = register_flag(key="test.scope_b", type="bool", default=False, description="")
    with flag_override("test.scope_a", True):
        assert a.value() is True
        assert b.value() is False  # untouched


def test_flag_override_is_contextvar_safe_across_async_tasks():
    """Two concurrent async tasks must see independent override stacks."""
    flag = register_flag(
        key="test.override_async",
        type="bool",
        default=False,
        description="async-safe override",
    )

    async def in_override() -> bool:
        with flag_override("test.override_async", True):
            await asyncio.sleep(0)  # yield to scheduler
            return flag.value()

    async def outside_override() -> bool:
        await asyncio.sleep(0)
        return flag.value()

    async def main() -> tuple[bool, bool]:
        async with asyncio.TaskGroup() as tg:
            inside = tg.create_task(in_override())
            outside = tg.create_task(outside_override())
        return inside.result(), outside.result()

    inside_val, outside_val = asyncio.run(main())
    assert inside_val is True
    assert outside_val is False


def test_flag_override_clears_even_on_exception():
    flag = register_flag(
        key="test.override_cleanup",
        type="bool",
        default=False,
        description="cleanup on raise",
    )
    with pytest.raises(RuntimeError, match="boom"):
        with flag_override("test.override_cleanup", True):
            raise RuntimeError("boom")
    assert flag.value() is False  # override removed despite exception


# ----------------------------------------------------------------------------
# B3a: in-process cache + env-var override + structured INFO log on cache update
# ----------------------------------------------------------------------------

from nova_contracts.feature_flags import populate_cache, cache_clear


@pytest.fixture(autouse=True)
def _clean_cache():
    """Reset the in-process cache between tests so cross-contamination
    can't mask correctness."""
    cache_clear()
    yield
    cache_clear()


# --- Cache layer ---

def test_cache_populated_value_overrides_default():
    flag = register_flag(
        key="cache.basic", type="bool", default=False, description=""
    )
    assert flag.value() is False
    populate_cache({"cache.basic": True})
    assert flag.value() is True


def test_cache_clear_reverts_to_default():
    flag = register_flag(
        key="cache.clearable", type="bool", default=False, description=""
    )
    populate_cache({"cache.clearable": True})
    assert flag.value() is True
    cache_clear()
    assert flag.value() is False


def test_populate_cache_emits_info_on_value_change(caplog):
    register_flag(key="cache.logged", type="bool", default=False, description="")
    with caplog.at_level("INFO", logger="nova_contracts.feature_flags"):
        populate_cache({"cache.logged": True})
    matching = [r for r in caplog.records if r.message and "cache.logged" in r.message]
    assert any(r.levelname == "INFO" for r in matching), (
        f"populate_cache must emit INFO when a value changes; got {[r.message for r in caplog.records]}"
    )


def test_populate_cache_silent_when_value_unchanged(caplog):
    register_flag(key="cache.same", type="bool", default=False, description="")
    populate_cache({"cache.same": True})  # initial set
    caplog.clear()
    with caplog.at_level("INFO", logger="nova_contracts.feature_flags"):
        populate_cache({"cache.same": True})  # same value
    info_records = [r for r in caplog.records if r.levelname == "INFO"
                    and r.message and "cache.same" in r.message]
    assert info_records == [], "no log should fire when value is unchanged"


# --- Env-var override ---

def test_envvar_override_bool_true(monkeypatch):
    flag = register_flag(key="env.b1", type="bool", default=False, description="")
    monkeypatch.setenv("NOVA_FLAG_ENV_B1", "true")
    assert flag.value() is True


def test_envvar_override_bool_false(monkeypatch):
    flag = register_flag(key="env.b2", type="bool", default=True, description="")
    monkeypatch.setenv("NOVA_FLAG_ENV_B2", "false")
    assert flag.value() is False


@pytest.mark.parametrize("raw,expected", [
    ("true", True), ("True", True), ("TRUE", True), ("1", True), ("yes", True),
    ("false", False), ("False", False), ("FALSE", False), ("0", False), ("no", False),
])
def test_envvar_override_bool_coercion(monkeypatch, raw, expected):
    flag = register_flag(key="env.coerce", type="bool", default=not expected, description="")
    monkeypatch.setenv("NOVA_FLAG_ENV_COERCE", raw)
    assert flag.value() is expected


def test_envvar_override_bool_invalid_falls_through_to_cache(monkeypatch):
    flag = register_flag(key="env.bad", type="bool", default=False, description="")
    populate_cache({"env.bad": True})
    monkeypatch.setenv("NOVA_FLAG_ENV_BAD", "maybe-truthy")
    # invalid env-var coercion → falls through to cache (which has True)
    assert flag.value() is True


def test_envvar_override_enum_match(monkeypatch):
    flag = register_flag(
        key="env.mode",
        type="enum",
        variants=["inject", "tools"],
        default="inject",
        description="",
    )
    monkeypatch.setenv("NOVA_FLAG_ENV_MODE", "tools")
    assert flag.value() == "tools"


def test_envvar_override_enum_mismatch_falls_through(monkeypatch):
    flag = register_flag(
        key="env.mode2",
        type="enum",
        variants=["inject", "tools"],
        default="inject",
        description="",
    )
    monkeypatch.setenv("NOVA_FLAG_ENV_MODE2", "lobotomized")
    populate_cache({"env.mode2": "tools"})
    # invalid variant → falls through to cache
    assert flag.value() == "tools"


def test_envvar_override_emits_warning_on_every_read(monkeypatch, caplog):
    """Security blocker S2: env-var override is an audit-bypass path. Every
    resolution via env-var must emit a structured WARN so log aggregation
    can alert on it."""
    flag = register_flag(key="env.audited", type="bool", default=False, description="")
    monkeypatch.setenv("NOVA_FLAG_ENV_AUDITED", "true")
    with caplog.at_level("WARNING", logger="nova_contracts.feature_flags"):
        flag.value()
        flag.value()  # second read also warns
    warns = [r for r in caplog.records if r.levelname == "WARNING"
             and r.message and "env.audited" in r.message]
    assert len(warns) == 2, (
        f"every env-var-resolved read must WARN; got {[r.message for r in caplog.records]}"
    )


def test_envvar_override_logs_when_invalid_value_seen(monkeypatch, caplog):
    flag = register_flag(key="env.bad2", type="bool", default=False, description="")
    monkeypatch.setenv("NOVA_FLAG_ENV_BAD2", "definitely-not-bool")
    with caplog.at_level("WARNING", logger="nova_contracts.feature_flags"):
        flag.value()
    warns = [r for r in caplog.records if r.levelname == "WARNING"
             and r.message and "env.bad2" in r.message]
    assert warns, (
        f"invalid env-var value must WARN before fall-through; got {[r.message for r in caplog.records]}"
    )


def test_envvar_override_takes_precedence_over_cache(monkeypatch):
    flag = register_flag(key="env.precedence1", type="bool", default=False, description="")
    populate_cache({"env.precedence1": False})
    monkeypatch.setenv("NOVA_FLAG_ENV_PRECEDENCE1", "true")
    assert flag.value() is True  # env-var wins over cache


def test_flag_override_takes_precedence_over_envvar(monkeypatch):
    """Test override (highest layer) wins even when env-var is set."""
    flag = register_flag(key="env.precedence2", type="bool", default=False, description="")
    monkeypatch.setenv("NOVA_FLAG_ENV_PRECEDENCE2", "true")
    with flag_override("env.precedence2", False):
        assert flag.value() is False


def test_envvar_key_translation_dots_become_underscores(monkeypatch):
    """Flag key 'kill.intel_worker.poll' resolves to env-var
    NOVA_FLAG_KILL_INTEL_WORKER_POLL (matches spec §First Flags to Ship)."""
    flag = register_flag(
        key="kill.intel_worker.poll", type="bool", default=False, description=""
    )
    monkeypatch.setenv("NOVA_FLAG_KILL_INTEL_WORKER_POLL", "true")
    assert flag.value() is True


# ----------------------------------------------------------------------------
# B3b: OpenFeature-shaped FlagResolver Protocol — swap-out boundary
# ----------------------------------------------------------------------------

from nova_contracts.feature_flags import (
    FlagResolver,
    DefaultResolver,
    set_resolver,
    get_resolver,
)


@pytest.fixture(autouse=True)
def _reset_resolver():
    """Restore the default resolver between tests so plug-in tests
    don't leak across the suite."""
    yield
    set_resolver(DefaultResolver())


def test_default_resolver_returns_cache_when_present():
    populate_cache({"r.cached": True})
    resolver = DefaultResolver()
    assert resolver.resolve_bool("r.cached", default=False) is True


def test_default_resolver_returns_default_on_miss():
    resolver = DefaultResolver()
    assert resolver.resolve_bool("r.never_cached", default=True) is True
    assert resolver.resolve_string("r.never_cached", default="fallback") == "fallback"


def test_resolver_is_consulted_after_envvar(monkeypatch):
    """Resolution order: override > env-var > resolver > in-code default.
    Resolver layer is between env-var (S2 audit-bypass path) and the
    in-code default."""

    class CountingResolver:
        calls: list[str] = []

        def resolve_bool(self, key: str, default: bool,
                         *, tenant_id=None, user_id=None) -> bool:
            self.calls.append(key)
            return True

        def resolve_string(self, key: str, default: str,
                           *, tenant_id=None, user_id=None) -> str:
            self.calls.append(key)
            return default

    counting = CountingResolver()
    set_resolver(counting)

    flag = register_flag(
        key="r.consulted", type="bool", default=False, description=""
    )
    # No override, no env-var → resolver is consulted.
    assert flag.value() is True
    assert counting.calls == ["r.consulted"]


def test_resolver_is_skipped_when_envvar_set(monkeypatch):
    class FailingResolver:
        def resolve_bool(self, key, default, *, tenant_id=None, user_id=None):
            raise AssertionError("must not be called when env-var override is set")
        def resolve_string(self, key, default, *, tenant_id=None, user_id=None):
            raise AssertionError("must not be called when env-var override is set")

    set_resolver(FailingResolver())
    monkeypatch.setenv("NOVA_FLAG_R_SKIP", "true")
    flag = register_flag(key="r.skip", type="bool", default=False, description="")
    assert flag.value() is True


def test_resolver_is_skipped_when_test_override_set():
    class FailingResolver:
        def resolve_bool(self, key, default, *, tenant_id=None, user_id=None):
            raise AssertionError("must not be called inside flag_override")
        def resolve_string(self, key, default, *, tenant_id=None, user_id=None):
            raise AssertionError("must not be called inside flag_override")

    set_resolver(FailingResolver())
    flag = register_flag(key="r.skip2", type="bool", default=False, description="")
    with flag_override("r.skip2", False):
        assert flag.value() is False


def test_get_resolver_returns_currently_registered():
    custom = DefaultResolver()
    set_resolver(custom)
    assert get_resolver() is custom


def test_resolver_protocol_runtime_checkable():
    """Any object that implements both resolve_bool and resolve_string
    should satisfy the Protocol — no inheritance required."""

    class DuckTyped:
        def resolve_bool(self, key, default, *, tenant_id=None, user_id=None):
            return default
        def resolve_string(self, key, default, *, tenant_id=None, user_id=None):
            return default

    assert isinstance(DuckTyped(), FlagResolver)


def test_enum_flag_routes_to_resolve_string():
    """Enum-typed flags consult resolve_string, not resolve_bool."""

    class TypeWatcher:
        method_called: list[str] = []

        def resolve_bool(self, key, default, *, tenant_id=None, user_id=None):
            self.method_called.append("bool")
            return default
        def resolve_string(self, key, default, *, tenant_id=None, user_id=None):
            self.method_called.append("string")
            return default

    watcher = TypeWatcher()
    set_resolver(watcher)

    flag = register_flag(
        key="r.enum",
        type="enum",
        variants=["a", "b"],
        default="a",
        description="",
    )
    flag.value()
    assert watcher.method_called == ["string"]


# ----------------------------------------------------------------------------
# B3d: last-seen cache file fallback (SR3 — the kill-switch fail-closed fix)
# ----------------------------------------------------------------------------

import json

from nova_contracts.feature_flags import init_cache_file


@pytest.fixture(autouse=True)
def _reset_cache_file():
    """Each test starts with no file persistence configured."""
    init_cache_file(None)
    yield
    init_cache_file(None)


def test_init_cache_file_loads_existing_json(tmp_path):
    """A previously-written cache file populates _cache at startup —
    this is the partition-fallback path: even if orchestrator/Redis
    are unreachable on cold boot, last-seen kill-switch values apply."""
    cache_path = tmp_path / "orchestrator.json"
    cache_path.write_text(json.dumps({
        "kill.intel_worker.poll": True,
        "memory.retrieval_mode": "tools",
    }))

    init_cache_file(cache_path)

    bool_flag = register_flag(
        key="kill.intel_worker.poll", type="bool", default=False,
        description="",
    )
    enum_flag = register_flag(
        key="memory.retrieval_mode", type="enum",
        variants=["inject", "tools"], default="inject", description="",
    )
    assert bool_flag.value() is True   # NOT the in-code default False
    assert enum_flag.value() == "tools"


def test_init_cache_file_silent_when_missing(tmp_path):
    """Cold boot with no cache file is fine — defaults apply, no error."""
    init_cache_file(tmp_path / "never-written.json")
    flag = register_flag(key="cf.cold", type="bool", default=False, description="")
    assert flag.value() is False


def test_init_cache_file_warns_on_corrupt_json(tmp_path, caplog):
    cache_path = tmp_path / "corrupt.json"
    cache_path.write_text("{not valid json")
    with caplog.at_level("WARNING", logger="nova_contracts.feature_flags"):
        init_cache_file(cache_path)
    warns = [r for r in caplog.records if r.levelname == "WARNING"
             and r.message and "flag_cache_file_corrupt" in r.message]
    assert warns, (
        f"corrupt cache file must WARN; got {[r.message for r in caplog.records]}"
    )
    # Cache is empty; defaults apply.
    flag = register_flag(key="cf.corrupt", type="bool", default=False, description="")
    assert flag.value() is False


def test_populate_cache_writes_to_file_when_configured(tmp_path):
    cache_path = tmp_path / "persist.json"
    init_cache_file(cache_path)

    populate_cache({"persist.k1": True, "persist.k2": "tools"})

    on_disk = json.loads(cache_path.read_text())
    assert on_disk == {"persist.k1": True, "persist.k2": "tools"}


def test_populate_cache_no_disk_write_when_file_disabled(tmp_path):
    """init_cache_file(None) means in-memory only; nothing persists."""
    init_cache_file(None)
    populate_cache({"nopersist.k": True})
    # No assertion on disk — but ensure no exception was raised.
    assert _read_cache_dict_for_test()["nopersist.k"] is True


def test_partition_fallback_kill_switch_stays_armed(tmp_path):
    """SR3 acceptance scenario: kill switch is set in the cache file
    (a previous online state), then the service cold-boots in a
    partition (no orchestrator reachable). The cached True must apply,
    NOT the in-code default of False — because the in-code default
    'feature-enabled' would silently disarm the kill switch."""

    cache_path = tmp_path / "orchestrator.json"
    cache_path.write_text(json.dumps({
        "kill.engram.ingestion": True,  # someone flipped this online
    }))

    # Simulate a cold boot (cache empty before init).
    cache_clear()
    init_cache_file(cache_path)

    flag = register_flag(
        key="kill.engram.ingestion", type="bool", default=False,
        description="kill ingestion",
    )
    # Even without any HTTP success, the kill switch is still armed.
    assert flag.value() is True


def test_init_cache_file_overwrites_previous_path(tmp_path):
    """Switching the cache-file path (e.g. on test re-init) clears any
    in-memory cache from the previous file."""
    first = tmp_path / "a.json"
    second = tmp_path / "b.json"
    first.write_text(json.dumps({"sw.k": True}))
    second.write_text(json.dumps({"sw.k": False}))

    init_cache_file(first)
    flag = register_flag(key="sw.k", type="bool", default=False, description="")
    assert flag.value() is True

    init_cache_file(second)
    assert flag.value() is False


def _read_cache_dict_for_test():
    """Test helper: peek at the SDK's in-memory cache directly."""
    from nova_contracts.feature_flags import _cache
    return dict(_cache)


# ----------------------------------------------------------------------------
# B3c: HTTP-based bulk pre-warm — populates the in-process cache from
# orchestrator's GET /api/v1/feature-flags/ at FastAPI lifespan startup.
# ----------------------------------------------------------------------------

import httpx

from nova_contracts.feature_flags_http import warm_cache_from_http


def _stub_transport(response_factory):
    """Build a MockTransport that calls response_factory(request) -> Response."""
    return httpx.MockTransport(response_factory)


@pytest.mark.asyncio
async def test_warm_cache_populates_from_orchestrator_response():
    """Happy path: GET /api/v1/feature-flags/ returns current values; the
    SDK's cache mirrors what the orchestrator currently believes is live."""

    captured_request: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_request["url"] = str(request.url)
        captured_request["method"] = request.method
        return httpx.Response(
            200,
            json=[
                {"key": "kill.intel_worker.poll", "current_value": True, "is_override": True},
                {"key": "memory.retrieval_mode", "current_value": "tools", "is_override": True},
                {"key": "pipeline.guardrail_strict_mode", "current_value": False, "is_override": False},
            ],
        )

    async with httpx.AsyncClient(transport=_stub_transport(handler)) as client:
        await warm_cache_from_http(client, "http://orchestrator:8000")

    assert captured_request["method"] == "GET"
    assert "/api/v1/feature-flags/" in captured_request["url"]

    cache = _read_cache_dict_for_test()
    assert cache == {
        "kill.intel_worker.poll": True,
        "memory.retrieval_mode": "tools",
        "pipeline.guardrail_strict_mode": False,
    }


@pytest.mark.asyncio
async def test_warm_cache_logs_warning_on_connection_failure(caplog):
    """B2: orchestrator unreachable at startup is non-fatal. Service starts
    with whatever the cache file (B3d) gave it; in-code defaults if no file."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    async with httpx.AsyncClient(transport=_stub_transport(handler)) as client:
        with caplog.at_level("WARNING", logger="nova_contracts.feature_flags_http"):
            # Must NOT raise — service startup proceeds.
            await warm_cache_from_http(client, "http://orchestrator:8000")

    warns = [r for r in caplog.records if r.levelname == "WARNING"
             and r.message and "flag_cache_warm_failed" in r.message]
    assert warns, (
        f"connection failure must WARN; got {[r.message for r in caplog.records]}"
    )


@pytest.mark.asyncio
async def test_warm_cache_logs_warning_on_5xx_response(caplog):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="service unavailable")

    async with httpx.AsyncClient(transport=_stub_transport(handler)) as client:
        with caplog.at_level("WARNING", logger="nova_contracts.feature_flags_http"):
            await warm_cache_from_http(client, "http://orchestrator:8000")

    warns = [r for r in caplog.records if r.levelname == "WARNING"
             and r.message and "flag_cache_warm_failed" in r.message]
    assert warns


@pytest.mark.asyncio
async def test_warm_cache_logs_warning_on_malformed_json(caplog):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not json at all")

    async with httpx.AsyncClient(transport=_stub_transport(handler)) as client:
        with caplog.at_level("WARNING", logger="nova_contracts.feature_flags_http"):
            await warm_cache_from_http(client, "http://orchestrator:8000")

    warns = [r for r in caplog.records if r.levelname == "WARNING"
             and r.message and "flag_cache_warm_failed" in r.message]
    assert warns


@pytest.mark.asyncio
async def test_warm_cache_persists_to_file_when_configured(tmp_path):
    """The cache-file fallback (B3d) writes after every populate_cache.
    Verify the warm path triggers the same persistence."""

    cache_path = tmp_path / "warm.json"
    init_cache_file(cache_path)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[{"key": "warm.k", "current_value": True}],
        )

    async with httpx.AsyncClient(transport=_stub_transport(handler)) as client:
        await warm_cache_from_http(client, "http://orchestrator:8000")

    assert cache_path.exists()
    on_disk = json.loads(cache_path.read_text())
    assert on_disk == {"warm.k": True}


@pytest.mark.asyncio
async def test_warm_cache_includes_admin_secret_when_set(monkeypatch):
    """Per spec: all admin endpoints require X-Admin-Secret. The SDK reads
    NOVA_ADMIN_SECRET and includes it in warm requests so the call succeeds
    even when REQUIRE_AUTH is true."""

    monkeypatch.setenv("NOVA_ADMIN_SECRET", "test-secret-abc")

    captured_headers: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        for k, v in request.headers.items():
            captured_headers[k.lower()] = v
        return httpx.Response(200, json=[])

    async with httpx.AsyncClient(transport=_stub_transport(handler)) as client:
        await warm_cache_from_http(client, "http://orchestrator:8000")

    assert captured_headers.get("x-admin-secret") == "test-secret-abc"
