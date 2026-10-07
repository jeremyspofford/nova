"""Workspace inverses (chat-rewind epic, T2).

workspace_write_file and workspace_delete each append ONE undo payload to
ctx.undo_sink as they change the disk, and each declares a Tool.revert that
puts the prior state back and VERIFIES it before saying so. A revert that
cannot act, or cannot verify, raises ToolFailure with the reason and changes
nothing — a rewind must never report undone what is not.

Payload contract (pinned here so T4 and the ledger read one shape):
  write  -> {"workspace_root": abs str, "path": rel str,
             "prior": base64 str | "absent", "sha256": hex of the bytes landed}
  delete -> {"workspace_root": abs str, "path": rel str, "trash": rel str}
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import uuid
from pathlib import Path

import pytest

from app import tools
from app.identity import Person
from app.tools import workspace
from app.tools.base import ToolContext, ToolFailure
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway


def _ctx(root: Path, sink: list | None = None) -> ToolContext:
    return ToolContext(
        app=None,
        person=Person(id=uuid.uuid4(), name="jeremy", role="owner"),
        workspace_root=root,
        facts_sink=[],
        undo_sink=sink,
    )


@pytest.fixture
def root(tmp_path) -> Path:
    r = tmp_path / "workspace"
    r.mkdir()
    return r


async def _write(ctx, path, content):
    return await tools.dispatch("workspace_write_file", {"path": path, "content": content}, ctx)


async def _delete(ctx, path, recursive=False):
    args = {"path": path}
    if recursive:
        args["recursive"] = True
    return await tools.dispatch("workspace_delete", args, ctx)


def _revert(name: str):
    fn = tools.REGISTRY[name].revert
    assert fn is not None, f"{name} declares no Tool.revert"
    return fn


def _one(sink: list) -> dict:
    assert len(sink) == 1, f"expected exactly one undo payload, got {sink!r}"
    return sink[0]


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# -- write: the payload -------------------------------------------------------


async def test_write_of_a_new_file_appends_one_payload_with_prior_absent(root):
    sink: list = []
    _, ok = await _write(_ctx(root, sink), "notes/a.md", "hello")
    assert ok is True
    assert len(sink) == 1
    payload = _one(sink)
    assert isinstance(payload, dict)
    json.dumps(payload)  # JSON-serialisable
    assert payload["workspace_root"] == str(root.resolve())
    assert Path(payload["workspace_root"]).is_absolute()
    assert payload["path"] == "notes/a.md"
    assert payload["prior"] == "absent"
    assert payload["sha256"] == _sha(b"hello")


async def test_write_over_an_existing_file_records_its_prior_bytes(root):
    (root / "a.md").write_bytes(b"old \xe2\x9c\x93 bytes")
    sink: list = []
    _, ok = await _write(_ctx(root, sink), "a.md", "new")
    assert ok is True
    assert len(sink) == 1
    assert base64.b64decode(_one(sink)["prior"]) == b"old \xe2\x9c\x93 bytes"
    assert _one(sink)["sha256"] == _sha(b"new")


async def test_a_refused_write_appends_nothing(root):
    sink: list = []
    (root / "dir").mkdir()
    for path, content in (
        ("big.md", "x" * (workspace.MAX_WRITE_BYTES + 1)),
        ("../out.md", "x"),
        ("dir", "x"),
    ):
        _, ok = await _write(_ctx(root, sink), path, content)
        assert ok is False
    assert sink == []
    # and a successful write afterwards does append — so the empty sink above
    # is the refusal, not a tool that never records anything
    _, ok = await _write(_ctx(root, sink), "fine.md", "x")
    assert ok is True
    assert len(sink) == 1


async def test_write_with_no_sink_behaves_as_before(root):
    result, ok = await _write(_ctx(root, None), "a.md", "hello")
    assert ok is True
    assert result == "Wrote a.md (5 bytes)"
    assert (root / "a.md").read_bytes() == b"hello"
    # the same call with a sink returns the same line and records one payload:
    # recording changes nothing the model sees
    sink: list = []
    result_with_sink, ok = await _write(_ctx(root, sink), "a.md", "hello")
    assert (ok, result_with_sink) == (True, result)
    assert _one(sink)["prior"] == base64.b64encode(b"hello").decode()


async def test_prior_bytes_over_the_write_cap_are_not_captured(root):
    (root / "huge.md").write_bytes(b"y" * (workspace.MAX_WRITE_BYTES + 10))
    sink: list = []
    _, ok = await _write(_ctx(root, sink), "fine.md", "x")
    assert ok is True and len(sink) == 1  # the tool records in general
    sink.clear()
    _, ok = await _write(_ctx(root, sink), "huge.md", "small")
    assert ok is True
    assert sink == []


# -- delete: the payload ------------------------------------------------------


async def test_delete_of_a_file_appends_one_payload_naming_the_trash_entry(root):
    (root / "a.md").write_text("bye", encoding="utf-8")
    sink: list = []
    _, ok = await _delete(_ctx(root, sink), "a.md")
    assert ok is True
    assert len(sink) == 1
    payload = _one(sink)
    json.dumps(payload)
    assert payload["workspace_root"] == str(root.resolve())
    assert payload["path"] == "a.md"
    trash = payload["trash"]
    assert not Path(trash).is_absolute()
    assert trash.startswith(workspace.TRASH_DIR + "/")
    assert (root / trash).read_text(encoding="utf-8") == "bye"


async def test_delete_of_a_directory_appends_one_payload(root):
    (root / "d" / "sub").mkdir(parents=True)
    (root / "d" / "sub" / "f.md").write_text("x", encoding="utf-8")
    sink: list = []
    _, ok = await _delete(_ctx(root, sink), "d", recursive=True)
    assert ok is True
    assert len(sink) == 1
    assert _one(sink)["path"] == "d"
    assert (root / _one(sink)["trash"] / "sub" / "f.md").is_file()


async def test_a_refused_delete_appends_nothing(root):
    (root / "full").mkdir()
    (root / "full" / "f.md").write_text("x", encoding="utf-8")
    sink: list = []
    for path in ("missing.md", "full", "../out", "."):
        _, ok = await _delete(_ctx(root, sink), path)
        assert ok is False
    assert sink == []
    (root / "ok.md").write_text("x", encoding="utf-8")
    _, ok = await _delete(_ctx(root, sink), "ok.md")
    assert ok is True
    assert len(sink) == 1


# -- the registered reverts ---------------------------------------------------


def test_only_write_and_delete_declare_a_revert():
    names = {t.name for t in workspace.TOOLS}
    reverting = {t.name for t in workspace.TOOLS if t.revert is not None}
    assert reverting == {"workspace_write_file", "workspace_delete"}
    assert names - reverting == {"workspace_read_file", "workspace_list_files"}
    assert tools.REGISTRY["workspace_write_file"].revert is not None
    assert tools.REGISTRY["workspace_delete"].revert is not None


async def test_write_revert_acts_on_the_payload_root_not_the_context_root(tmp_path):
    agent_root = tmp_path / "workspace" / "agents" / "scout"
    agent_root.mkdir(parents=True)
    other = tmp_path / "elsewhere"
    other.mkdir()
    sink: list = []
    await _write(_ctx(agent_root, sink), "a.md", "agent wrote this")
    (other / "a.md").write_text("untouched", encoding="utf-8")

    await _revert("workspace_write_file")(_one(sink), _ctx(other))
    assert not (agent_root / "a.md").exists()
    assert (other / "a.md").read_text(encoding="utf-8") == "untouched"


async def test_delete_revert_acts_on_the_payload_root_not_the_context_root(tmp_path):
    agent_root = tmp_path / "workspace" / "agents" / "scout"
    agent_root.mkdir(parents=True)
    (agent_root / "a.md").write_text("keep me", encoding="utf-8")
    other = tmp_path / "elsewhere"
    other.mkdir()
    sink: list = []
    await _delete(_ctx(agent_root, sink), "a.md")

    await _revert("workspace_delete")(_one(sink), _ctx(other))
    assert (agent_root / "a.md").read_text(encoding="utf-8") == "keep me"
    assert not (other / "a.md").exists()


@pytest.mark.parametrize("field", ["path", "workspace_root"])
async def test_write_revert_refuses_a_payload_path_outside_its_root(root, tmp_path, field):
    (tmp_path / "victim.md").write_text("outside", encoding="utf-8")
    sink: list = []
    await _write(_ctx(root, sink), "a.md", "x")
    payload = dict(_one(sink))
    if field == "path":
        payload["path"] = "../victim.md"
        payload["sha256"] = _sha(b"outside")
    else:
        payload["workspace_root"] = "relative/root"
    with pytest.raises(ToolFailure):
        await _revert("workspace_write_file")(payload, _ctx(root))
    assert (tmp_path / "victim.md").read_text(encoding="utf-8") == "outside"
    assert (root / "a.md").read_text(encoding="utf-8") == "x"


@pytest.mark.parametrize("field", ["path", "trash"])
async def test_delete_revert_refuses_a_payload_path_outside_its_root(root, tmp_path, field):
    (root / "a.md").write_text("x", encoding="utf-8")
    sink: list = []
    await _delete(_ctx(root, sink), "a.md")
    payload = dict(_one(sink))
    (tmp_path / "outside.md").write_text("outside", encoding="utf-8")
    payload[field] = "../outside.md"
    with pytest.raises(ToolFailure):
        await _revert("workspace_delete")(payload, _ctx(root))
    assert (tmp_path / "outside.md").read_text(encoding="utf-8") == "outside"
    assert (root / _one(sink)["trash"]).is_file()
    assert not (root / "a.md").exists()


# -- reverting a write --------------------------------------------------------


async def test_reverting_an_overwrite_restores_the_prior_bytes_exactly(root):
    prior = b"line one\n\xe2\x9c\x93 line two\n"
    (root / "a.md").write_bytes(prior)
    sink: list = []
    await _write(_ctx(root, sink), "a.md", "replaced")
    line = await _revert("workspace_write_file")(_one(sink), _ctx(root))
    assert (root / "a.md").read_bytes() == prior
    assert isinstance(line, str) and "a.md" in line


async def test_reverting_a_creation_removes_the_file(root):
    sink: list = []
    await _write(_ctx(root, sink), "new/a.md", "made")
    line = await _revert("workspace_write_file")(_one(sink), _ctx(root))
    assert not (root / "new" / "a.md").exists()
    assert isinstance(line, str) and "a.md" in line


async def test_chained_writes_revert_newest_first(root):
    sink: list = []
    await _write(_ctx(root, sink), "a.md", "one")
    await _write(_ctx(root, sink), "a.md", "two")
    revert = _revert("workspace_write_file")
    assert len(sink) == 2, sink
    await revert(sink[1], _ctx(root))
    assert (root / "a.md").read_text(encoding="utf-8") == "one"
    await revert(sink[0], _ctx(root))
    assert not (root / "a.md").exists()


async def test_write_revert_refuses_when_the_file_changed_since(root):
    (root / "a.md").write_text("prior", encoding="utf-8")
    sink: list = []
    await _write(_ctx(root, sink), "a.md", "hers")
    (root / "a.md").write_text("edited by someone else", encoding="utf-8")
    with pytest.raises(ToolFailure, match="changed"):
        await _revert("workspace_write_file")(_one(sink), _ctx(root))
    assert (root / "a.md").read_text(encoding="utf-8") == "edited by someone else"


async def test_write_revert_refuses_when_the_written_file_is_missing(root):
    (root / "a.md").write_text("prior", encoding="utf-8")
    sink: list = []
    await _write(_ctx(root, sink), "a.md", "hers")
    (root / "a.md").unlink()
    with pytest.raises(ToolFailure):
        await _revert("workspace_write_file")(_one(sink), _ctx(root))
    assert not (root / "a.md").exists()


async def test_write_revert_fails_when_the_restore_does_not_verify(root, monkeypatch):
    (root / "a.md").write_text("prior", encoding="utf-8")
    sink: list = []
    await _write(_ctx(root, sink), "a.md", "hers")
    monkeypatch.setattr(workspace, "_atomic_write", lambda path, data: None)
    with pytest.raises(ToolFailure, match="verif"):
        await _revert("workspace_write_file")(_one(sink), _ctx(root))


# -- reverting a delete -------------------------------------------------------


async def test_reverting_a_file_delete_moves_it_back_and_empties_the_trash_entry(root):
    (root / "notes").mkdir()
    (root / "notes" / "a.md").write_bytes(b"precious")
    sink: list = []
    await _delete(_ctx(root, sink), "notes/a.md")
    trash = root / _one(sink)["trash"]
    line = await _revert("workspace_delete")(_one(sink), _ctx(root))
    assert (root / "notes" / "a.md").read_bytes() == b"precious"
    assert not trash.exists()
    assert isinstance(line, str) and "a.md" in line


async def test_reverting_a_directory_delete_restores_the_tree(root):
    (root / "d" / "sub").mkdir(parents=True)
    (root / "d" / "sub" / "f.md").write_text("x", encoding="utf-8")
    sink: list = []
    await _delete(_ctx(root, sink), "d", recursive=True)
    await _revert("workspace_delete")(_one(sink), _ctx(root))
    assert (root / "d" / "sub" / "f.md").read_text(encoding="utf-8") == "x"
    assert not (root / _one(sink)["trash"]).exists()


async def test_delete_revert_recreates_missing_parent_dirs(root):
    (root / "p" / "q").mkdir(parents=True)
    (root / "p" / "q" / "a.md").write_text("x", encoding="utf-8")
    sink: list = []
    await _delete(_ctx(root, sink), "p/q/a.md")
    await _delete(_ctx(root, []), "p", recursive=True)
    await _revert("workspace_delete")(_one(sink), _ctx(root))
    assert (root / "p" / "q" / "a.md").read_text(encoding="utf-8") == "x"


async def test_delete_revert_refuses_when_the_trash_entry_is_gone(root):
    (root / "a.md").write_text("x", encoding="utf-8")
    sink: list = []
    await _delete(_ctx(root, sink), "a.md")
    os.unlink(root / _one(sink)["trash"])
    with pytest.raises(ToolFailure, match="trash"):
        await _revert("workspace_delete")(_one(sink), _ctx(root))
    assert not (root / "a.md").exists()


async def test_delete_revert_refuses_when_the_original_path_is_occupied(root):
    (root / "a.md").write_text("old", encoding="utf-8")
    sink: list = []
    await _delete(_ctx(root, sink), "a.md")
    (root / "a.md").write_text("a new one", encoding="utf-8")
    with pytest.raises(ToolFailure):
        await _revert("workspace_delete")(_one(sink), _ctx(root))
    assert (root / "a.md").read_text(encoding="utf-8") == "a new one"
    assert (root / _one(sink)["trash"]).read_text(encoding="utf-8") == "old"


async def test_delete_revert_fails_when_the_move_does_not_verify(root, monkeypatch):
    (root / "a.md").write_text("x", encoding="utf-8")
    sink: list = []
    await _delete(_ctx(root, sink), "a.md")
    monkeypatch.setattr(workspace.os, "replace", lambda src, dst: None)
    with pytest.raises(ToolFailure, match="verif"):
        await _revert("workspace_delete")(_one(sink), _ctx(root))


async def test_delete_revert_fails_when_the_trash_entry_is_still_there(root, monkeypatch):
    # a "move" that copies: the path is back but the trash entry was not
    # emptied — both ends must verify, not just the destination
    import shutil

    (root / "a.md").write_text("x", encoding="utf-8")
    sink: list = []
    await _delete(_ctx(root, sink), "a.md")
    monkeypatch.setattr(workspace.os, "replace", lambda src, dst: shutil.copy2(src, dst))
    with pytest.raises(ToolFailure, match="verif"):
        await _revert("workspace_delete")(_one(sink), _ctx(root))


async def test_write_revert_fails_when_the_removal_does_not_verify(root, monkeypatch):
    sink: list = []
    await _write(_ctx(root, sink), "a.md", "made")
    monkeypatch.setattr(Path, "unlink", lambda self, missing_ok=False: None)
    with pytest.raises(ToolFailure, match="verif"):
        await _revert("workspace_write_file")(_one(sink), _ctx(root))
    assert (root / "a.md").read_text(encoding="utf-8") == "made"


@pytest.mark.parametrize(
    ("field", "value"), [("trash", "b.md"), ("path", workspace.TRASH_DIR + "/moved.md")]
)
async def test_delete_revert_refuses_paths_inside_the_root_but_on_the_wrong_side_of_the_trash(
    root, field, value
):
    # inside the root, so plain containment passes — but the trash entry must
    # sit IN the trash and the restore target must sit OUTSIDE it
    (root / "a.md").write_text("x", encoding="utf-8")
    (root / "b.md").write_text("live file", encoding="utf-8")
    sink: list = []
    await _delete(_ctx(root, sink), "a.md")
    payload = dict(_one(sink))
    payload[field] = value
    with pytest.raises(ToolFailure, match="trash|restorable"):
        await _revert("workspace_delete")(payload, _ctx(root))
    assert (root / "b.md").read_text(encoding="utf-8") == "live file"
    assert (root / _one(sink)["trash"]).read_text(encoding="utf-8") == "x"
    assert not (root / "a.md").exists()
    assert not (root / workspace.TRASH_DIR / "moved.md").exists()


# -- end to end through the ledger --------------------------------------------


def _tool_call(call_id: str, name: str, arguments: dict) -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ]
                }
            }
        ]
    }


@requires_db
async def test_a_chat_write_lands_a_ledger_row_whose_undo_reverts_it(
    owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "list.md").write_text("milk", encoding="utf-8")
    monkeypatch.setenv("WORKSPACE_ROOT", str(ws))
    gateway = ScriptedGateway(
        rounds=(
            (_tool_call("c1", "workspace_write_file", {"path": "list.md", "content": "eggs"}),),
            ({"choices": [{"delta": {"content": "done"}}]},),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "write it"})
    assert resp.status_code == 200, resp.text
    assert (ws / "list.md").read_text(encoding="utf-8") == "eggs"

    rows = await pool.fetch("SELECT tool, ok, undo FROM turn_actions ORDER BY seq")
    assert len(rows) == 1
    undo = rows[0]["undo"]
    undo = json.loads(undo) if isinstance(undo, str) else undo
    assert isinstance(undo, dict)
    assert rows[0]["tool"] == "workspace_write_file" and rows[0]["ok"] is True

    await _revert("workspace_write_file")(undo, _ctx(tmp_path / "unrelated"))
    assert (ws / "list.md").read_text(encoding="utf-8") == "milk"
