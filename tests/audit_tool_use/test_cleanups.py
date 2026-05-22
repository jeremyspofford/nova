import pytest
from pathlib import Path
from audit_tool_use.cleanups import DeleteFile, NoCleanup
from audit_tool_use.types import Cleanup


@pytest.mark.asyncio
async def test_delete_file_removes_existing(tmp_path):
    p = tmp_path / "x.txt"
    p.write_text("hi")
    c = DeleteFile(path=str(p))
    ok, msg = await c.cleanup(context={})
    assert ok is True
    assert not p.exists()


@pytest.mark.asyncio
async def test_delete_file_is_idempotent_when_missing(tmp_path):
    c = DeleteFile(path=str(tmp_path / "nope.txt"))
    ok, msg = await c.cleanup(context={})
    assert ok is True


def test_no_cleanup_is_sentinel():
    assert NoCleanup is Cleanup.NONE
