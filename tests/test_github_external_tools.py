"""GitHub external provider — READ + PROPOSE tier tools against fake-github."""
from __future__ import annotations
import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

# Insert nova-contracts first so nova_contracts is importable
sys.path.insert(0, '/home/jeremy/workspace/nova/nova-contracts')

# Load github_external_tools directly (bypasses app.tools.__init__ which has
# transitive deps on nova_worker_common that aren't installed in the test env)
_spec = importlib.util.spec_from_file_location(
    "app.tools.github_external_tools",
    "/home/jeremy/workspace/nova/orchestrator/app/tools/github_external_tools.py",
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

_list_workflow_runs = _mod._list_workflow_runs
_get_workflow_run = _mod._get_workflow_run
_get_run_logs = _mod._get_run_logs
_compare_to_main = _mod._compare_to_main
_diagnose_failure = _mod._diagnose_failure
_draft_fix = _mod._draft_fix

import pytest

from fixtures.fake_github.server import FakeGitHubServer, load_scenario


@pytest.mark.asyncio
async def test_list_workflow_runs_against_fake_github():
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    try:
        result = await _list_workflow_runs(
            {"repo": "test-org/test-repo"},
            secret="ghp_validtoken",
            api_base=fake.base_url,
        )
        assert result["total_count"] == 1
        assert result["workflow_runs"][0]["id"] == 12345
    finally:
        await fake.stop()


@pytest.mark.asyncio
async def test_get_run_logs_returns_text():
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    try:
        result = await _get_run_logs(
            {"repo": "test-org/test-repo", "run_id": 12345},
            secret="ghp_validtoken",
            api_base=fake.base_url,
        )
        assert "ESLint" in result["text"]
    finally:
        await fake.stop()


@pytest.mark.asyncio
async def test_compare_to_main_bug_in_pr():
    """Lint failure scenario — main passes, so bug is on the branch."""
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    try:
        result = await _compare_to_main(
            {"repo": "test-org/test-repo", "run_id": 12345},
            secret="ghp_validtoken",
            api_base=fake.base_url,
        )
        assert result["bug_location"] == "branch"
    finally:
        await fake.stop()


@pytest.mark.asyncio
async def test_compare_to_main_bug_on_main():
    """bug_on_main scenario — main has the same failure signature."""
    scenarios = load_scenario("bug_on_main")
    # Augment scenarios so main ALSO has a failing run with matching signature.
    # The signature extracted from run 12346's logs is the first line containing
    # 'fail': "FAIL  test/unrelated_module.test.ts"
    scenarios["workflow_runs"].append({
        "id": 99999,
        "conclusion": "failure",
        "head_branch": "main",
        "head_sha": "main-sha",
        "name": "tests",
    })
    scenarios["logs"]["99999"] = (
        "FAIL  test/unrelated_module.test.ts\n"
        "  ● unrelated_module > test_thing\n"
        "    expected truthy received undefined\n"
    )
    fake = FakeGitHubServer(scenarios=scenarios)
    await fake.start()
    try:
        result = await _compare_to_main(
            {"repo": "test-org/test-repo", "run_id": 12346},
            secret="ghp_validtoken",
            api_base=fake.base_url,
        )
        assert result["bug_location"] == "main", \
            f"Expected bug_location=main; got {result}"
    finally:
        await fake.stop()


@pytest.mark.asyncio
async def test_get_workflow_run_returns_run():
    """get_workflow_run fetches a single run by ID."""
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    try:
        result = await _get_workflow_run(
            {"repo": "test-org/test-repo", "run_id": 12345},
            secret="ghp_validtoken",
            api_base=fake.base_url,
        )
        assert result["id"] == 12345
        assert result["conclusion"] == "failure"
        assert result["head_branch"] == "feature-x"
    finally:
        await fake.stop()


# ── PROPOSE tier: diagnose_failure + draft_fix ────────────────────────────────

@pytest.mark.asyncio
async def test_diagnose_failure_classifies_lint():
    """When given lint-style logs, diagnosis returns category=lint."""
    fake_llm_response = json.dumps({
        "category": "lint",
        "suspected_files": ["src/utils.ts"],
        "root_cause": "ESLint reports 3 errors in src/utils.ts",
        "severity": "low",
        "confidence": 0.9,
    })
    # The module was loaded via importlib — patch.object on the module is the
    # only reliable way to intercept _call_llm_gateway in this test environment.
    with patch.object(_mod, "_call_llm_gateway", new=AsyncMock(return_value=fake_llm_response)):
        result = await _diagnose_failure({
            "logs": "ESLint: 3 errors\n  src/utils.ts:12:5 'foo' is not defined\n",
            "context": {"repo": "test-org/test-repo"},
        })
    assert result["category"] == "lint"
    assert "src/utils.ts" in result["suspected_files"]
    assert result["confidence"] == 0.9


@pytest.mark.asyncio
async def test_diagnose_failure_handles_non_json_response():
    """When LLM returns non-JSON garbage, diagnose_failure returns category=unknown gracefully."""
    with patch.object(_mod, "_call_llm_gateway", new=AsyncMock(return_value="I'm sorry, I cannot help with that.")):
        result = await _diagnose_failure({"logs": "anything"})
    assert result["category"] == "unknown"
    assert result["confidence"] == 0.0
    assert result["suspected_files"] == []


@pytest.mark.asyncio
async def test_draft_fix_returns_files():
    """draft_fix parses the LLM response and returns the files list."""
    fake_response = json.dumps({
        "files": [{"path": "src/utils.ts",
                   "diff": "@@ -12,5 +12,5 @@\n-foo\n+bar\n"}],
        "summary": "Fix undefined 'foo' by renaming to 'bar'",
        "confidence": 0.85,
    })
    with patch.object(_mod, "_call_llm_gateway", new=AsyncMock(return_value=fake_response)):
        result = await _draft_fix({
            "diagnosis": {"category": "lint", "root_cause": "undefined foo"},
            "file_contents": {"src/utils.ts": "const x = foo + 1;"},
        })
    assert len(result["files"]) == 1
    assert result["files"][0]["path"] == "src/utils.ts"
    assert "@@ -12" in result["files"][0]["diff"]
    assert result["confidence"] == 0.85
