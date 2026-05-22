import pytest
from pathlib import Path
from audit_tool_use.setups import SeedFile, NoSetup
from audit_tool_use.types import Setup


@pytest.mark.asyncio
async def test_seed_file_creates_with_content(tmp_path):
    p = tmp_path / "fixture.txt"
    s = SeedFile(path=str(p), content="HELLO-TOKEN-abc")
    ok, msg = await s.run(context={})
    assert ok is True
    assert p.read_text() == "HELLO-TOKEN-abc"


@pytest.mark.asyncio
async def test_seed_file_overwrites_existing(tmp_path):
    p = tmp_path / "fixture.txt"
    p.write_text("old")
    s = SeedFile(path=str(p), content="new")
    ok, _ = await s.run(context={})
    assert ok is True
    assert p.read_text() == "new"


def test_no_setup_is_sentinel():
    assert NoSetup is Setup.NONE
