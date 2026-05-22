"""Unit tests for cleanup strategies.

DeleteFile operates on the agent-core container filesystem (not the host),
so its tests round-trip through `docker exec`. Tests skip if docker isn't
available.
"""
from __future__ import annotations
import shutil
import subprocess
import uuid
from typing import Iterator

import pytest
from audit_tool_use.cleanups import DeleteFile, NoCleanup
from audit_tool_use.types import Cleanup


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
    from audit_tool_use.container import delete_file_in_container
    path = f"/tmp/audit-test-{uuid.uuid4().hex[:8]}.txt"
    yield path
    delete_file_in_container(path)


@_skip_no_docker
@pytest.mark.asyncio
async def test_delete_file_removes_existing(container_path):
    from audit_tool_use.container import file_exists_in_container, write_file_in_container
    write_file_in_container(container_path, "hi")
    assert file_exists_in_container(container_path)
    c = DeleteFile(path=container_path)
    ok, _ = await c.cleanup(context={})
    assert ok is True
    assert not file_exists_in_container(container_path)


@_skip_no_docker
@pytest.mark.asyncio
async def test_delete_file_is_idempotent_when_missing(container_path):
    c = DeleteFile(path=container_path)  # no write — file doesn't exist
    ok, _ = await c.cleanup(context={})
    assert ok is True  # rm -f succeeds even on missing


def test_no_cleanup_is_sentinel():
    assert NoCleanup is Cleanup.NONE
