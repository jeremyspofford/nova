"""Unit tests for verifier strategies.

`FileExists` operates on the agent-core container filesystem (not the host),
so its tests round-trip through `docker exec`. Tests skip if docker isn't
available — they're integration with a real container, not unit tests with
mocks.

`ResponseContains` and `DbContains` are tested with fixture data only since
they're pure logic / HTTP shape checks.
"""
from __future__ import annotations

import shutil
import subprocess
import uuid
from typing import Iterator

import pytest
import respx

from audit_tool_use.types import Verifier
from audit_tool_use.verifiers import DbContains, FileExists, ResponseContains, Skip

# ── FileExists (container round-trip) ────────────────────────────────────


def _docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        r = subprocess.run(
            ["docker", "ps", "--filter", "name=agent-core", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=3.0, check=False,
        )
        return bool(r.stdout.strip())
    except Exception:
        return False


_skip_no_docker = pytest.mark.skipif(
    not _docker_available(), reason="docker / agent-core container unavailable"
)


@pytest.fixture
def container_path() -> Iterator[str]:
    """Yield a unique container path; clean it up after the test."""
    from audit_tool_use.container import delete_file_in_container
    path = f"/tmp/audit-test-{uuid.uuid4().hex[:8]}.txt"
    yield path
    delete_file_in_container(path)


@_skip_no_docker
@pytest.mark.asyncio
async def test_file_exists_passes_when_file_present_with_token(container_path):
    from audit_tool_use.container import write_file_in_container
    ok, _ = write_file_in_container(container_path, "hello TOKEN-abc world")
    assert ok, "container write must succeed before we can test verifier"
    v = FileExists(path=container_path, expect_content_contains="TOKEN-abc")
    ok, reason = await v.verify(context={})
    assert ok is True
    assert reason is None


@_skip_no_docker
@pytest.mark.asyncio
async def test_file_exists_fails_when_missing(container_path):
    # container_path fixture cleans up — we never write here, so file is absent
    v = FileExists(path=container_path, expect_content_contains="x")
    ok, reason = await v.verify(context={})
    assert ok is False
    assert "not found" in reason.lower()


@_skip_no_docker
@pytest.mark.asyncio
async def test_file_exists_fails_when_content_missing(container_path):
    from audit_tool_use.container import write_file_in_container
    write_file_in_container(container_path, "nothing useful here")
    v = FileExists(path=container_path, expect_content_contains="TOKEN-xyz")
    ok, reason = await v.verify(context={})
    assert ok is False
    assert "token" in reason.lower()


# ── ResponseContains (pure logic) ────────────────────────────────────────


@pytest.mark.asyncio
async def test_response_contains_passes_when_token_present():
    v = ResponseContains(token="UUID-abc")
    ok, _ = await v.verify(context={"final_response": "I retrieved UUID-abc successfully"})
    assert ok is True


@pytest.mark.asyncio
async def test_response_contains_fails_when_token_absent():
    v = ResponseContains(token="UUID-abc")
    ok, reason = await v.verify(context={"final_response": "Sorry, I couldn't find it"})
    assert ok is False
    assert "UUID-abc" in reason


def test_skip_is_recognized_sentinel():
    assert Skip is Verifier.SKIP


# ── DbContains (wrapper handling) ────────────────────────────────────────


@pytest.mark.asyncio
async def test_db_contains_unwraps_results_wrapper_when_walking_numeric_path():
    """Live memory-service returns {"results": [...]}. DbContains must unwrap
    when the expect_field starts with a numeric index (list-like)."""
    import respx
    v = DbContains(
        endpoint="http://test-host/memories/search",
        query={"query": "x"},
        expect_field="0.id",
    )
    with respx.mock:
        respx.post("http://test-host/memories/search").respond(
            200, json={"results": [{"id": "found-it", "content": "x"}]}
        )
        ok, reason = await v.verify(context={})
    assert ok is True, f"expected ok, got reason: {reason}"


@pytest.mark.asyncio
async def test_db_contains_does_not_unwrap_for_field_path():
    """When expect_field is a plain field name (not numeric), don't unwrap —
    the field should be at the top level of the response."""
    v = DbContains(
        endpoint="http://test-host/secrets/resolve",
        query={"name": "x"},
        expect_field="value",
    )
    with respx.mock:
        respx.post("http://test-host/secrets/resolve").respond(
            200, json={"name": "x", "value": "the-secret"}
        )
        ok, reason = await v.verify(context={})
    assert ok is True, f"expected ok, got reason: {reason}"


@pytest.mark.asyncio
async def test_db_contains_fails_when_field_missing():
    v = DbContains(
        endpoint="http://test-host/foo",
        query={},
        expect_field="0.id",
    )
    with respx.mock:
        respx.post("http://test-host/foo").respond(200, json={"results": []})
        ok, reason = await v.verify(context={})
    assert ok is False
    assert "0.id" in reason
