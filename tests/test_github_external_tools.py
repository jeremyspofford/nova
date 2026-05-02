"""GitHub external provider — READ tier tools against fake-github."""
from __future__ import annotations
import importlib.util
import sys
from pathlib import Path

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
