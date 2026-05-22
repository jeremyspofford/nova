import importlib
import pytest


def test_default_deadlines(monkeypatch):
    monkeypatch.delenv("AUDIT_READ_DEADLINE_S", raising=False)
    monkeypatch.delenv("AUDIT_MUTATE_DEADLINE_S", raising=False)
    import audit_tool_use.constants as c
    importlib.reload(c)
    assert c.READ_DEADLINE_S == 90
    assert c.MUTATE_DEADLINE_S == 120


def test_env_override(monkeypatch):
    monkeypatch.setenv("AUDIT_READ_DEADLINE_S", "30")
    monkeypatch.setenv("AUDIT_MUTATE_DEADLINE_S", "60")
    import audit_tool_use.constants as c
    importlib.reload(c)
    assert c.READ_DEADLINE_S == 30
    assert c.MUTATE_DEADLINE_S == 60


def test_run_id_prefix_format():
    import audit_tool_use.constants as c
    importlib.reload(c)
    assert c.RUN_ID_PREFIX_TEMPLATE.startswith("nova-audit-")
    assert "{run_id}" in c.RUN_ID_PREFIX_TEMPLATE
