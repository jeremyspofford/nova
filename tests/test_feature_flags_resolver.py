"""Unit tests for the feature_flags SDK resolution order."""
from nova_worker_common.feature_flags import FlagDef


def test_flagdef_returns_default_when_no_resolver():
    flag = FlagDef(
        key="test.basic",
        type="bool",
        variants=None,
        default=False,
        description="basic test",
    )
    assert flag.value() is False
