"""Tests for NOVA_INFERENCE_MODE → LLM_ROUTING_STRATEGY derivation in install.sh.

Nova bundles no inference server, so the coarse mode no longer touches
COMPOSE_PROFILES — it only maps to the gateway routing strategy. Uses the
--derive-mode-only fast path so tests don't touch Docker.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


def _read_env_var(env_path: Path, key: str) -> str | None:
    """Return the value of KEY in a .env-style file, or None if absent."""
    if not env_path.exists():
        return None
    for line in env_path.read_text().splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1]
    return None


@pytest.fixture
def isolated_env(tmp_path):
    """A temporary .env for install.sh to write into."""
    env_path = tmp_path / ".env"
    if (REPO_ROOT / ".env.example").exists():
        shutil.copy(REPO_ROOT / ".env.example", env_path)
    else:
        env_path.write_text("NOVA_ADMIN_SECRET=test\nPOSTGRES_PASSWORD=test\n")
    return env_path


def _run_derive_mode(env_file: Path, mode: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "NOVA_INFERENCE_MODE": mode, "ENV_FILE": str(env_file)}
    return subprocess.run(
        ["bash", str(REPO_ROOT / "scripts/install.sh"), "--derive-mode-only"],
        env=env, capture_output=True, text=True, cwd=REPO_ROOT,
    )


@pytest.mark.parametrize("mode,expected_strategy", [
    ("hybrid", "local-first"),
    ("local-only", "local-only"),
    ("cloud-only", "cloud-only"),
])
def test_install_writes_routing_strategy(isolated_env, mode, expected_strategy):
    """Each mode maps to the right LLM_ROUTING_STRATEGY and never adds an
    inference compose profile — local inference is external/user-run."""
    result = _run_derive_mode(isolated_env, mode)
    assert result.returncode == 0, f"install.sh failed: stderr={result.stderr[:500]}"

    assert _read_env_var(isolated_env, "NOVA_INFERENCE_MODE") == mode
    assert _read_env_var(isolated_env, "LLM_ROUTING_STRATEGY") == expected_strategy

    profiles = _read_env_var(isolated_env, "COMPOSE_PROFILES") or ""
    assert "local-ollama" not in profiles, (
        f"inference must not add a compose profile (external inference): {profiles!r}"
    )


def test_install_idempotent(isolated_env):
    """Re-running with the same mode must not duplicate keys in .env."""
    for _ in range(3):
        result = _run_derive_mode(isolated_env, "hybrid")
        assert result.returncode == 0, f"install.sh failed: {result.stderr[:200]}"

    content = isolated_env.read_text()
    for key in ("NOVA_INFERENCE_MODE", "LLM_ROUTING_STRATEGY"):
        count = content.count(f"\n{key}=") + (1 if content.startswith(f"{key}=") else 0)
        assert count == 1, f"{key} appears {count} times after 3 runs; expected 1"


def test_invalid_mode_rejected(isolated_env):
    """An unknown NOVA_INFERENCE_MODE must abort with a clear error."""
    result = _run_derive_mode(isolated_env, "bogus-mode")
    assert result.returncode != 0, "install.sh accepted invalid mode"
    assert "invalid NOVA_INFERENCE_MODE" in (result.stderr + result.stdout), (
        f"Expected error not in output. stderr={result.stderr[:300]} stdout={result.stdout[:300]}"
    )
