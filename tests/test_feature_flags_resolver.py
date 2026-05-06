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
