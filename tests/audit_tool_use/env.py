"""Environment resolution for the audit. Fails loud on missing config."""
from __future__ import annotations
import os
from pathlib import Path
from dotenv import dotenv_values


def resolve_repo_root(start_from: Path | None = None) -> Path:
    """Walk up from `start_from` (or this file) looking for a directory that
    contains both `.env` and `docker-compose.yml` — the real Nova repo root.
    Worktrees don't satisfy this (no .env), so the search keeps walking past them.
    """
    here = Path(start_from or __file__).resolve()
    for candidate in [here] + list(here.parents):
        if (candidate / ".env").exists() and (candidate / "docker-compose.yml").exists():
            return candidate
    raise RuntimeError(
        f"Could not locate repo root from {here}. "
        "Expected a directory with both .env and docker-compose.yml."
    )


def load_admin_secret(repo_root: Path | None = None) -> str:
    """Return NOVA_ADMIN_SECRET. Env var wins; .env is fallback; missing → RuntimeError."""
    override = os.getenv("NOVA_ADMIN_SECRET")
    if override:
        return override
    root = repo_root or resolve_repo_root()
    env = dotenv_values(root / ".env") if (root / ".env").exists() else {}
    val = env.get("NOVA_ADMIN_SECRET")
    if not val:
        raise RuntimeError(
            "NOVA_ADMIN_SECRET not set in environment or .env. "
            "Set it before running the audit; never fall back to a default secret."
        )
    return val
