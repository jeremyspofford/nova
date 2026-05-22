"""Unit tests for setup strategies.

SeedFile operates on the agent-core container filesystem (not the host),
so its tests round-trip through `docker exec`. Tests skip if docker isn't
available.
"""
from __future__ import annotations

import shutil
import subprocess
import uuid
from typing import Iterator

import pytest

from audit_tool_use.setups import NoSetup, SeedFile
from audit_tool_use.types import Setup


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
async def test_seed_file_creates_with_content(container_path):
    from audit_tool_use.container import (
        file_exists_in_container,
        read_file_in_container,
    )
    s = SeedFile(path=container_path, content="HELLO-TOKEN-abc")
    ok, msg = await s.run(context={})
    assert ok is True, f"seed failed: {msg}"
    assert file_exists_in_container(container_path)
    read_ok, content = read_file_in_container(container_path)
    assert read_ok and content == "HELLO-TOKEN-abc"


@_skip_no_docker
@pytest.mark.asyncio
async def test_seed_file_overwrites_existing(container_path):
    from audit_tool_use.container import read_file_in_container, write_file_in_container
    write_file_in_container(container_path, "old")
    s = SeedFile(path=container_path, content="new")
    ok, _ = await s.run(context={})
    assert ok is True
    _, content = read_file_in_container(container_path)
    assert content == "new"


def test_no_setup_is_sentinel():
    assert NoSetup is Setup.NONE
