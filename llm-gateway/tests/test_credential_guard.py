"""Unit tests for the credential-rejection guard (stdlib-only module)."""
from __future__ import annotations

import importlib.util
import time
from pathlib import Path

# Load the guard module by file path — it is deliberately stdlib-only, and
# importing it through the package would execute app/providers/__init__.py
# (litellm, httpx, ...). This keeps the test runnable with bare pytest.
_spec = importlib.util.spec_from_file_location(
    "credential_guard",
    Path(__file__).resolve().parents[1] / "app" / "providers" / "credential_guard.py",
)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)


class AuthenticationError(Exception):
    """Name matches litellm's class — detection is by class name, not import."""


def setup_function(_fn):
    guard.clear()


def test_detects_by_class_name():
    assert guard.is_credential_error(AuthenticationError("nope"))


def test_detects_groq_invalid_api_key_message():
    # litellm maps Groq's 401 to BadRequestError with this body (observed
    # 2026-07-05): detection must work on the message alone.
    e = RuntimeError(
        'litellm.BadRequestError: GroqException - {"error":{"message":'
        '"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}'
    )
    assert guard.is_credential_error(e)


def test_ignores_unrelated_errors():
    assert not guard.is_credential_error(TimeoutError("read timed out"))
    assert not guard.is_credential_error(RuntimeError("model not found"))


def test_mark_and_cooldown_expiry(monkeypatch):
    guard.mark_credential_invalid("groq")
    assert guard.credential_invalid("groq")
    assert not guard.credential_invalid("ollama")

    # Jump past the cooldown — the entry expires and is removed.
    real_monotonic = time.monotonic
    monkeypatch.setattr(
        guard.time, "monotonic",
        lambda: real_monotonic() + guard.CREDENTIAL_COOLDOWN_SECONDS + 1,
    )
    assert not guard.credential_invalid("groq")


def test_clear_single_and_all():
    guard.mark_credential_invalid("a")
    guard.mark_credential_invalid("b")
    guard.clear("a")
    assert not guard.credential_invalid("a")
    assert guard.credential_invalid("b")
    guard.clear()
    assert not guard.credential_invalid("b")
