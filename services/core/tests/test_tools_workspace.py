"""The three workspace tools: containment, caps, and verified writes.

The containment matrix mirrors the memory service's store tests
(traversal, absolute escape, symlink pointing out) because it is the same
mechanical gate — resolve the path and require the realpath to stay
inside the root — and a filesystem tool the model drives needs it proven
in its own suite, not by reference to another service's.
"""
from __future__ import annotations

import pytest

from app import tools
from app.tools import workspace
from app.tools.base import ToolContext
from tests.conftest import requires_db

# dispatch() authorizes every call now, and the workspace tools are all
# disposition=auto in the seeded action-class table — so these need a live DB
# for the kernel to read that seed and allow the executor to run. The pool
# fixture builds and seeds it; the autouse dependency below makes db.get_pool()
# (which policy.authorize calls) resolve to it.
pytestmark = requires_db


@pytest.fixture(autouse=True)
async def _authorized(pool):
    return pool


def _ctx(tmp_path) -> ToolContext:
    root = tmp_path / "workspace"
    root.mkdir()
    return ToolContext(app=None, person=None, workspace_root=root)


async def _call(name: str, args: dict, ctx: ToolContext) -> tuple[str, bool]:
    return await tools.dispatch(name, args, ctx)


# -- containment -----------------------------------------------------------

ESCAPES = [
    ("traversal", "../escaped.md"),
    ("nested traversal", "notes/../../escaped.md"),
    ("absolute", "/etc/passwd"),
    ("absolute into tmp", "/tmp/escaped.md"),
]


@pytest.mark.parametrize(("label", "path"), ESCAPES, ids=[e[0] for e in ESCAPES])
async def test_write_refuses_paths_that_leave_the_workspace(tmp_path, label, path):
    ctx = _ctx(tmp_path)
    result, ok = await _call("workspace_write_file", {"path": path, "content": "x"}, ctx)
    assert ok is False
    assert result.startswith("Error: ")
    assert "workspace" in result
    assert not (tmp_path / "escaped.md").exists()
    assert list(ctx.workspace_root.rglob("*")) == []


@pytest.mark.parametrize(("label", "path"), ESCAPES, ids=[e[0] for e in ESCAPES])
async def test_read_refuses_paths_that_leave_the_workspace(tmp_path, label, path):
    ctx = _ctx(tmp_path)
    (tmp_path / "escaped.md").write_text("a secret outside", encoding="utf-8")
    result, ok = await _call("workspace_read_file", {"path": path}, ctx)
    assert ok is False
    assert "a secret outside" not in result


async def test_write_refuses_a_symlink_pointing_out_of_the_workspace(tmp_path):
    ctx = _ctx(tmp_path)
    outside = tmp_path / "outside.md"
    outside.write_text("untouched", encoding="utf-8")
    (ctx.workspace_root / "escape.md").symlink_to(outside)

    result, ok = await _call(
        "workspace_write_file", {"path": "escape.md", "content": "overwritten"}, ctx
    )
    assert ok is False
    assert outside.read_text(encoding="utf-8") == "untouched"


async def test_read_refuses_a_symlink_pointing_out_of_the_workspace(tmp_path):
    ctx = _ctx(tmp_path)
    outside = tmp_path / "outside.md"
    outside.write_text("a secret outside", encoding="utf-8")
    (ctx.workspace_root / "escape.md").symlink_to(outside)

    result, ok = await _call("workspace_read_file", {"path": "escape.md"}, ctx)
    assert ok is False
    assert "a secret outside" not in result


async def test_listing_never_follows_a_symlink_out_of_the_workspace(tmp_path):
    ctx = _ctx(tmp_path)
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    (outside_dir / "secret.md").write_text("secret", encoding="utf-8")
    (ctx.workspace_root / "linked").symlink_to(outside_dir)
    (ctx.workspace_root / "real.md").write_text("mine", encoding="utf-8")

    result, ok = await _call("workspace_list_files", {}, ctx)
    assert ok is True
    assert "real.md" in result
    assert "secret.md" not in result


async def test_an_empty_path_is_refused_by_name(tmp_path):
    ctx = _ctx(tmp_path)
    result, ok = await _call("workspace_write_file", {"path": "", "content": "x"}, ctx)
    assert ok is False
    assert "empty" in result


# -- writes ----------------------------------------------------------------


async def test_a_write_creates_parents_and_reports_the_verified_size(tmp_path):
    ctx = _ctx(tmp_path)
    result, ok = await _call(
        "workspace_write_file", {"path": "lists/groceries.md", "content": "- milk\n"}, ctx
    )
    assert ok is True
    written = ctx.workspace_root / "lists" / "groceries.md"
    assert written.read_text(encoding="utf-8") == "- milk\n"
    assert "lists/groceries.md" in result
    assert str(len("- milk\n")) in result


async def test_a_write_leaves_no_temporary_files_behind(tmp_path):
    ctx = _ctx(tmp_path)
    await _call("workspace_write_file", {"path": "notes.md", "content": "hello"}, ctx)
    names = [p.name for p in ctx.workspace_root.iterdir()]
    assert names == ["notes.md"]


async def test_a_write_that_cannot_be_verified_is_a_failure_not_a_success(tmp_path, monkeypatch):
    """os.replace succeeding is not proof the file is there — say so if it isn't."""
    ctx = _ctx(tmp_path)

    real_replace = workspace.os.replace

    def vanishing_replace(src, dst):
        real_replace(src, dst)
        workspace.os.unlink(dst)

    monkeypatch.setattr(workspace.os, "replace", vanishing_replace)
    result, ok = await _call("workspace_write_file", {"path": "gone.md", "content": "x"}, ctx)
    assert ok is False
    assert "verify" in result


async def test_a_crash_between_tmp_and_rename_leaves_the_previous_file_intact(
    tmp_path, monkeypatch
):
    ctx = _ctx(tmp_path)
    await _call("workspace_write_file", {"path": "notes.md", "content": "original"}, ctx)

    def boom(src, dst):
        raise OSError("simulated crash between tmp-write and rename")

    monkeypatch.setattr(workspace.os, "replace", boom)
    result, ok = await _call("workspace_write_file", {"path": "notes.md", "content": "new"}, ctx)
    assert ok is False
    assert (ctx.workspace_root / "notes.md").read_text(encoding="utf-8") == "original"
    assert [p.name for p in ctx.workspace_root.iterdir()] == ["notes.md"]


async def test_content_over_the_cap_is_refused_never_truncated(tmp_path):
    ctx = _ctx(tmp_path)
    oversized = "x" * (workspace.MAX_WRITE_BYTES + 1)
    result, ok = await _call(
        "workspace_write_file", {"path": "big.md", "content": oversized}, ctx
    )
    assert ok is False
    assert str(workspace.MAX_WRITE_BYTES) in result
    assert not (ctx.workspace_root / "big.md").exists()


async def test_the_cap_counts_bytes_not_characters(tmp_path):
    """A multi-byte character costs what it costs on disk."""
    ctx = _ctx(tmp_path)
    # Each snowman is 3 UTF-8 bytes, so this is just over the cap in bytes
    # while being comfortably under it in characters.
    content = "☃" * (workspace.MAX_WRITE_BYTES // 3 + 1)
    assert len(content) < workspace.MAX_WRITE_BYTES
    result, ok = await _call("workspace_write_file", {"path": "snow.md", "content": content}, ctx)
    assert ok is False
    assert not (ctx.workspace_root / "snow.md").exists()


async def test_writing_over_a_directory_is_refused(tmp_path):
    ctx = _ctx(tmp_path)
    (ctx.workspace_root / "lists").mkdir()
    result, ok = await _call("workspace_write_file", {"path": "lists", "content": "x"}, ctx)
    assert ok is False
    assert "directory" in result


# -- reads -----------------------------------------------------------------


async def test_write_then_read_round_trips(tmp_path):
    ctx = _ctx(tmp_path)
    body = "- milk\n- eggs\n- bread\n- rice\n- salt\n"
    await _call("workspace_write_file", {"path": "groceries.md", "content": body}, ctx)
    result, ok = await _call("workspace_read_file", {"path": "groceries.md"}, ctx)
    assert ok is True
    assert result == body


async def test_reading_a_missing_file_is_a_stated_error(tmp_path):
    ctx = _ctx(tmp_path)
    result, ok = await _call("workspace_read_file", {"path": "nope.md"}, ctx)
    assert ok is False
    assert "nope.md" in result


async def test_a_large_file_is_truncated_and_says_so(tmp_path):
    ctx = _ctx(tmp_path)
    size = workspace.MAX_READ_BYTES + 500
    (ctx.workspace_root / "big.md").write_text("y" * size, encoding="utf-8")

    result, ok = await _call("workspace_read_file", {"path": "big.md"}, ctx)
    assert ok is True
    head, _, note = result.partition("\n[truncated:")
    assert head == "y" * workspace.MAX_READ_BYTES
    assert note.strip() == f"file is {size} bytes]"


async def test_a_file_exactly_at_the_cap_is_not_truncated(tmp_path):
    ctx = _ctx(tmp_path)
    (ctx.workspace_root / "edge.md").write_text("z" * workspace.MAX_READ_BYTES, encoding="utf-8")
    result, ok = await _call("workspace_read_file", {"path": "edge.md"}, ctx)
    assert ok is True
    assert "truncated" not in result


async def test_reading_a_directory_is_a_stated_error(tmp_path):
    ctx = _ctx(tmp_path)
    (ctx.workspace_root / "lists").mkdir()
    result, ok = await _call("workspace_read_file", {"path": "lists"}, ctx)
    assert ok is False


# -- listing ---------------------------------------------------------------


async def test_listing_is_recursive_with_sizes(tmp_path):
    ctx = _ctx(tmp_path)
    await _call("workspace_write_file", {"path": "a.md", "content": "12345"}, ctx)
    await _call("workspace_write_file", {"path": "sub/b.md", "content": "123"}, ctx)

    result, ok = await _call("workspace_list_files", {}, ctx)
    assert ok is True
    assert "a.md" in result and "5 bytes" in result
    assert "sub/b.md" in result and "3 bytes" in result


async def test_listing_a_subdirectory_scopes_the_result(tmp_path):
    ctx = _ctx(tmp_path)
    await _call("workspace_write_file", {"path": "a.md", "content": "1"}, ctx)
    await _call("workspace_write_file", {"path": "sub/b.md", "content": "1"}, ctx)

    result, ok = await _call("workspace_list_files", {"path": "sub"}, ctx)
    assert ok is True
    assert "sub/b.md" in result
    assert "a.md" not in result.replace("sub/b.md", "")


async def test_an_empty_workspace_says_so_rather_than_answering_nothing(tmp_path):
    ctx = _ctx(tmp_path)
    result, ok = await _call("workspace_list_files", {}, ctx)
    assert ok is True
    assert result.strip()
    assert "no files" in result.lower()


async def test_a_missing_workspace_root_lists_as_empty_rather_than_failing(tmp_path):
    """Nothing has been written yet, so the volume is bare — that is empty,
    not broken."""
    ctx = ToolContext(app=None, person=None, workspace_root=tmp_path / "never-created")
    result, ok = await _call("workspace_list_files", {}, ctx)
    assert ok is True
    assert "no files" in result.lower()


async def test_listing_is_capped_and_states_the_truncation(tmp_path):
    ctx = _ctx(tmp_path)
    for index in range(workspace.MAX_LIST_ENTRIES + 5):
        (ctx.workspace_root / f"file{index:03d}.md").write_text("x", encoding="utf-8")

    result, ok = await _call("workspace_list_files", {}, ctx)
    assert ok is True
    listed = [line for line in result.splitlines() if line.startswith("file")]
    assert len(listed) == workspace.MAX_LIST_ENTRIES
    assert "5 more" in result


async def test_listing_a_missing_directory_is_a_stated_error(tmp_path):
    ctx = _ctx(tmp_path)
    result, ok = await _call("workspace_list_files", {"path": "nowhere"}, ctx)
    assert ok is False
    assert "nowhere" in result
