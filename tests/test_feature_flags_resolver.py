"""Unit tests for the feature_flags SDK resolution order."""
import pytest
from nova_worker_common.feature_flags import FlagDef, register_flag, _registry_clear


@pytest.fixture(autouse=True)
def clean_registry():
    _registry_clear()
    yield
    _registry_clear()


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
