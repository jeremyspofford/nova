"""Capability platform redactor — masks secret-shaped values before audit storage."""
from __future__ import annotations

import sys
sys.path.insert(0, "/home/jeremy/workspace/nova/orchestrator")

from app.capabilities.redactor import redact_value, redact_dict


def test_redacts_github_token():
    out = redact_value("ghp_abcdefghijklmnop12345")
    assert out == "ghp_abcd…2345"
    assert "ghijklmnop" not in out


def test_redacts_authorization_header():
    out = redact_value("Bearer ghp_secrettoken_77777777")
    assert "secrettoken" not in out


def test_redacts_field_named_token():
    payload = {"label": "fine", "token": "supersecret_value", "url": "https://safe"}
    out = redact_dict(payload)
    assert out["label"] == "fine"
    assert out["url"] == "https://safe"
    assert "supersecret_value" not in str(out)


def test_redacts_nested():
    payload = {"creds": {"api_key": "abc123def456ghi789jkl"}}
    out = redact_dict(payload)
    assert "abc123def456" not in str(out)
