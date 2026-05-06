"""Unit tests for the feature_flags SDK resolution order."""
import asyncio

import pytest
from nova_worker_common import feature_flags as ff
from nova_worker_common.feature_flags import (
    FlagDef,
    flag_override,
    register_flag,
)
from nova_worker_common.feature_flags_testing import registry_clear


def test_registry_clear_not_exported_from_production_module():
    """Test-only helpers must live in feature_flags_testing, never the prod module."""
    assert not hasattr(ff, "_registry_clear"), (
        "_registry_clear must live in nova_worker_common.feature_flags_testing, "
        "not feature_flags — moving it prevents accidental production imports."
    )
    assert not hasattr(ff, "registry_clear"), (
        "registry_clear must not be exported from the prod module either."
    )


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
