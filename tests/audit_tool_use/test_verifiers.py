import pytest
import tempfile
from pathlib import Path
from audit_tool_use.verifiers import FileExists, ResponseContains, DbContains, Skip
from audit_tool_use.types import Verifier


@pytest.mark.asyncio
async def test_file_exists_passes_when_file_present_with_token(tmp_path):
    p = tmp_path / "f.txt"
    p.write_text("hello TOKEN-abc world")
    v = FileExists(path=str(p), expect_content_contains="TOKEN-abc")
    ok, reason = await v.verify(context={})
    assert ok is True
    assert reason is None


@pytest.mark.asyncio
async def test_file_exists_fails_when_missing(tmp_path):
    v = FileExists(path=str(tmp_path / "nope.txt"), expect_content_contains="x")
    ok, reason = await v.verify(context={})
    assert ok is False
    assert "not found" in reason.lower()


@pytest.mark.asyncio
async def test_file_exists_fails_when_content_missing(tmp_path):
    p = tmp_path / "f.txt"
    p.write_text("nothing useful")
    v = FileExists(path=str(p), expect_content_contains="TOKEN-xyz")
    ok, reason = await v.verify(context={})
    assert ok is False
    assert "token" in reason.lower()


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
