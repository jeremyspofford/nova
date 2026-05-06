"""GitHub external provider — READ + PROPOSE + MUTATE tier tools against fake-github."""
from __future__ import annotations

import importlib.util
import json
import sys
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

# Insert nova-contracts first so nova_contracts is importable
sys.path.insert(0, '/home/jeremy/workspace/nova/nova-contracts')
sys.path.insert(0, '/home/jeremy/workspace/nova/orchestrator')

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
_comment_on_pr = _mod._comment_on_pr
_open_fix_pr = _mod._open_fix_pr

# Shared constants (mirrors test_capability_consent.py)
TENANT = UUID("00000000-0000-0000-0000-000000000001")
USER = UUID("00000000-0000-0000-0000-000000000001")

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

# ── MUTATE tier: comment_on_pr + open_fix_pr ─────────────────────────────────

@pytest.mark.asyncio
async def test_comment_on_pr_against_fake_github():
    """comment_on_pr posts to the issues/comments endpoint and returns IDs."""
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    try:
        result = await _comment_on_pr(
            {"repo": "test-org/test-repo", "pr_number": 42, "body": "Diagnosis posted by Nova"},
            secret="ghp_validtoken",
            api_base=fake.base_url,
        )
        assert result["comment_id"] is not None
        assert "issuecomment" in result["comment_url"]
    finally:
        await fake.stop()


@pytest.mark.asyncio
async def test_open_fix_pr_against_fake_github_skips_git_push():
    """open_fix_pr in fake-github mode skips git entirely and returns a PR number."""
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    try:
        result = await _open_fix_pr(
            {
                "repo": "test-org/test-repo",
                "branch": "nova-fix-ci/abc123",
                "base": "feature-x",
                "patch": {
                    "files": [{"path": "src/utils.ts", "diff": "@@ -1,1 +1,1 @@\n-foo\n+bar\n"}],
                    "summary": "Fix lint errors",
                    "confidence": 0.8,
                },
                "title": "fix(lint): nova-proposed fix",
                "body": "Diagnosed by Nova: undefined identifier",
            },
            secret="ghp_validtoken",
            api_base=fake.base_url,
        )
        assert result["pr_number"] is not None
        assert result["branch_pushed"] == "nova-fix-ci/abc123"
        assert "fake-github" in result["pr_url"]
    finally:
        await fake.stop()


@pytest.mark.asyncio
async def test_open_fix_pr_via_executor_returns_consent_pending(pool):
    """When called through the platform executor (without an auto-approve rule),
    open_fix_pr returns consent_pending and does NOT call the underlying."""
    from app.capabilities.executor import execute_tool as _execute
    from nova_contracts import BlastRadius

    called = []

    async def underlying(args, secret):
        called.append(args)
        return {"pr_number": 1}

    result = await _execute(
        pool,
        tenant_id=TENANT, user_id=USER, task_id=None,
        actor_kind="agent", actor_id=f"executor-test-{uuid4().hex[:8]}",
        tool_name=f"test_open_fix_pr_{uuid4().hex[:8]}", tool_kind="native",
        blast_radius=BlastRadius.MUTATE, reversible=True,
        provider_kind="github", target="repos/test-org/test-repo",
        credential_id=None,
        args={"repo": "test-org/test-repo", "branch": "fix"},
        underlying=underlying,
    )
    assert result["status"] == "consent_pending"
    assert "approval_id" in result
    assert called == []  # underlying must NOT have been called
