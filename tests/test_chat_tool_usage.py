"""Tool-use audit — single pytest entry under @pytest.mark.audit.

Discovers usable models via /providers, runs N=3 trials per (probe, model),
extracts outcomes from task_events, runs verifiers and cleanups, renders
the report. Skips gracefully if services are down."""
from __future__ import annotations
import asyncio
import datetime as dt
import hashlib
import os
import subprocess
import time
from pathlib import Path
import httpx
import pytest

from audit_tool_use.constants import TRIALS_PER_PROBE, OUTPUT_DIR_TEMPLATE, OUTPUT_MD_TEMPLATE
from audit_tool_use.env import resolve_repo_root, load_admin_secret
from audit_tool_use.harness import run_trial, AGENT_CORE
from audit_tool_use.models import discover_models
from audit_tool_use.probes import PROBES
from audit_tool_use.render import render_report


def _services_reachable() -> bool:
    try:
        r = httpx.get(f"{AGENT_CORE}/health/ready", timeout=3.0)
        return r.status_code == 200
    except Exception:
        return False


def _audit_script_sha() -> str:
    """Hash of the audit_tool_use package files for reproducibility metadata."""
    root = Path(__file__).parent / "audit_tool_use"
    h = hashlib.sha256()
    for p in sorted(root.rglob("*.py")):
        h.update(p.relative_to(root).as_posix().encode())
        h.update(b"\0")
        h.update(p.read_bytes())
    return h.hexdigest()[:12]


def _commit_sha(repo_root: Path) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"], text=True
        ).strip()[:12]
    except Exception:
        return "unknown"


@pytest.mark.audit
@pytest.mark.asyncio
async def test_chat_tool_use_audit():
    if not _services_reachable():
        out = Path("docs/audits/2026-05-22-tool-use-audit.md")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            f"# Tool-Use Audit — SKIPPED\n\n"
            f"Run at {dt.datetime.now().isoformat()}\n\n"
            f"Services were not reachable at {AGENT_CORE}. Audit is diagnostic, never CI-blocking.\n"
        )
        pytest.skip("services unavailable")

    repo_root = resolve_repo_root()
    admin_secret = load_admin_secret(repo_root=repo_root)
    admin_headers = {"X-Admin-Secret": admin_secret}
    models = await discover_models()
    if not models:
        pytest.skip("no LLM providers available")

    date = dt.date.today().isoformat()
    output_dir = repo_root / OUTPUT_DIR_TEMPLATE.format(date=date)
    trace_dir = output_dir / "traces"
    output_dir.mkdir(parents=True, exist_ok=True)
    trace_dir.mkdir(parents=True, exist_ok=True)

    start = time.monotonic()
    all_trials = []
    for model in models:
        for probe in PROBES:
            for trial_n in range(TRIALS_PER_PROBE):
                tr = await run_trial(probe, model, trial_n, admin_headers, trace_dir)
                all_trials.append(tr)
    duration = int(time.monotonic() - start)

    render_report(
        all_trials, output_dir=output_dir,
        date=date,
        commit_sha=_commit_sha(repo_root),
        audit_script_sha=_audit_script_sha(),
        llm_routing_strategy=os.getenv("LLM_ROUTING_STRATEGY", "unknown"),
        run_duration_seconds=duration,
    )

    # Sanity assertion: audit ran to completion and produced output
    assert (output_dir.parent / f"{date}-tool-use-audit.md").exists() or \
           (output_dir / f"{date}-tool-use-audit.md").exists()
