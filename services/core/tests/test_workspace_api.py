"""GET /api/v1/workspace/{files,file,raw} — the operator's read-only window
into what Nova wrote into her workspace (services/core/app/tools/workspace.py).

Every path-taking route here is contained through THAT module's gate,
`_resolve_within` — imported, never re-derived — so the containment matrix
is the same one test_tools_workspace.py already proved for the tools
themselves: traversal, absolute escape, symlink pointing out. This suite
does not re-litigate whether the gate works; it proves this module actually
calls it, on both path-taking routes, before touching the filesystem.

None of these tests use the DB-backed `pool`/`owner_client` fixtures from
activity.py's suite — workspace_api reads nothing from postgres — but they
still go through `client`/`owner_client` for the same auth path every other
route uses, per conftest.py.
"""
from __future__ import annotations

import re
from urllib.parse import quote

import pytest

from app import workspace_api
from tests.conftest import requires_db

pytestmark = requires_db


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


# -- auth --------------------------------------------------------------


async def test_every_route_needs_an_identity(client, workspace):
    assert (await client.get("/api/v1/workspace/files")).status_code == 401
    assert (await client.get("/api/v1/workspace/file?path=a.md")).status_code == 401
    assert (await client.get("/api/v1/workspace/raw?path=a.md")).status_code == 401


# -- GET /files ----------------------------------------------------------


async def test_an_empty_workspace_lists_as_empty_not_broken(owner_client, workspace):
    resp = await owner_client.get("/api/v1/workspace/files")
    assert resp.status_code == 200
    assert resp.json() == {"files": [], "total": 0, "truncated": False}


async def test_a_workspace_that_was_never_created_also_lists_as_empty(
    owner_client, tmp_path, monkeypatch
):
    # Nothing has been written yet — root_from_env() names a directory that
    # does not exist on disk at all. That is an empty workspace, not a
    # broken one (same stance as the tool's list_files).
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "never-created"))
    resp = await owner_client.get("/api/v1/workspace/files")
    assert resp.status_code == 200
    assert resp.json() == {"files": [], "total": 0, "truncated": False}


async def test_listing_is_recursive_with_size_and_modified(owner_client, workspace):
    (workspace / "sub").mkdir(parents=True)
    (workspace / "a.md").write_text("12345", encoding="utf-8")
    (workspace / "sub" / "b.md").write_text("123", encoding="utf-8")

    resp = await owner_client.get("/api/v1/workspace/files")
    body = resp.json()
    by_path = {f["path"]: f for f in body["files"]}
    assert by_path.keys() == {"a.md", "sub/b.md"}
    assert by_path["a.md"]["size"] == 5
    assert by_path["sub/b.md"]["size"] == 3
    # A real timestamp, not a fabricated one — parseable ISO 8601.
    for entry in body["files"]:
        assert "T" in entry["modified"]
    assert body["total"] == 2
    assert body["truncated"] is False


async def test_listing_never_follows_a_symlink_out_of_the_workspace(owner_client, workspace):
    outside = workspace.parent / "outside"
    outside.mkdir()
    (outside / "secret.md").write_text("secret", encoding="utf-8")
    (workspace / "linked").symlink_to(outside)
    (workspace / "real.md").write_text("mine", encoding="utf-8")

    resp = await owner_client.get("/api/v1/workspace/files")
    paths = {f["path"] for f in resp.json()["files"]}
    assert paths == {"real.md"}


async def test_listing_is_capped_and_states_the_truncation(owner_client, workspace):
    for index in range(workspace_api.MAX_LIST_ENTRIES + 5):
        (workspace / f"file{index:04d}.md").write_text("x", encoding="utf-8")

    resp = await owner_client.get("/api/v1/workspace/files")
    body = resp.json()
    assert len(body["files"]) == workspace_api.MAX_LIST_ENTRIES
    assert body["total"] == workspace_api.MAX_LIST_ENTRIES + 5
    assert body["truncated"] is True


# -- GET /file -------------------------------------------------------------


async def test_a_small_text_file_returns_its_contents(owner_client, workspace):
    (workspace / "notes.md").write_text("- milk\n- eggs\n", encoding="utf-8")
    resp = await owner_client.get("/api/v1/workspace/file?path=notes.md")
    assert resp.status_code == 200
    body = resp.json()
    assert body["path"] == "notes.md"
    assert body["size"] == len("- milk\n- eggs\n")
    assert body["text"] == "- milk\n- eggs\n"
    assert body["binary"] is False
    assert body["too_large"] is False


async def test_a_binary_file_is_flagged_never_dumped_as_text(owner_client, workspace):
    (workspace / "photo.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\xff\xfe\x00\x01")
    resp = await owner_client.get("/api/v1/workspace/file?path=photo.png")
    assert resp.status_code == 200
    body = resp.json()
    assert body["text"] is None
    assert body["binary"] is True
    assert body["too_large"] is False
    assert body["size"] == 13


async def test_a_file_over_the_text_cap_is_flagged_not_truncated_into_view(
    owner_client, workspace, monkeypatch
):
    monkeypatch.setattr(workspace_api, "MAX_TEXT_BYTES", 10)
    (workspace / "big.md").write_text("x" * 50, encoding="utf-8")
    resp = await owner_client.get("/api/v1/workspace/file?path=big.md")
    body = resp.json()
    assert body["text"] is None
    assert body["too_large"] is True
    assert body["binary"] is False
    assert body["size"] == 50


async def test_a_file_exactly_at_the_text_cap_is_shown(owner_client, workspace, monkeypatch):
    monkeypatch.setattr(workspace_api, "MAX_TEXT_BYTES", 10)
    (workspace / "edge.md").write_text("x" * 10, encoding="utf-8")
    resp = await owner_client.get("/api/v1/workspace/file?path=edge.md")
    body = resp.json()
    assert body["too_large"] is False
    assert body["text"] == "x" * 10


async def test_a_missing_file_is_a_404(owner_client, workspace):
    resp = await owner_client.get("/api/v1/workspace/file?path=nope.md")
    assert resp.status_code == 404


async def test_a_directory_path_is_a_named_400_not_a_500(owner_client, workspace):
    (workspace / "lists").mkdir()
    resp = await owner_client.get("/api/v1/workspace/file?path=lists")
    assert resp.status_code == 400
    assert "directory" in resp.json()["error"]


ESCAPES = [
    ("traversal", "../escaped.md"),
    ("nested traversal", "notes/../../escaped.md"),
    ("absolute", "/etc/passwd"),
    ("empty", ""),
]


@pytest.mark.parametrize(("label", "path"), ESCAPES, ids=[e[0] for e in ESCAPES])
async def test_file_route_refuses_paths_that_leave_the_workspace(
    owner_client, workspace, label, path
):
    resp = await owner_client.get(f"/api/v1/workspace/file?path={path}")
    assert resp.status_code == 400
    assert "workspace" in resp.json()["error"] or "empty" in resp.json()["error"]


async def test_file_route_refuses_a_symlink_pointing_out_of_the_workspace(owner_client, workspace):
    outside = workspace.parent / "outside.md"
    outside.write_text("a secret outside", encoding="utf-8")
    (workspace / "escape.md").symlink_to(outside)

    resp = await owner_client.get("/api/v1/workspace/file?path=escape.md")
    assert resp.status_code == 400
    assert "a secret outside" not in resp.text


# -- GET /raw ----------------------------------------------------------------


async def test_raw_streams_the_exact_bytes_with_a_download_header(owner_client, workspace):
    (workspace / "groceries.md").write_bytes(b"- milk\n- eggs\n")
    resp = await owner_client.get("/api/v1/workspace/raw?path=groceries.md")
    assert resp.status_code == 200
    assert resp.content == b"- milk\n- eggs\n"
    disposition = resp.headers["content-disposition"]
    assert "attachment" in disposition
    assert "groceries.md" in disposition


async def test_raw_serves_a_file_over_the_text_cap_in_full(owner_client, workspace, monkeypatch):
    """The text cap governs the /file preview only — /raw exists precisely
    so a file too big (or too binary) to preview can still be retrieved."""
    monkeypatch.setattr(workspace_api, "MAX_TEXT_BYTES", 10)
    body = b"y" * 500
    (workspace / "big.bin").write_bytes(body)
    resp = await owner_client.get("/api/v1/workspace/raw?path=big.bin")
    assert resp.status_code == 200
    assert resp.content == body


async def test_raw_a_missing_file_is_a_404(owner_client, workspace):
    resp = await owner_client.get("/api/v1/workspace/raw?path=nope.md")
    assert resp.status_code == 404


async def test_raw_a_directory_path_is_a_named_400(owner_client, workspace):
    (workspace / "lists").mkdir()
    resp = await owner_client.get("/api/v1/workspace/raw?path=lists")
    assert resp.status_code == 400
    assert "directory" in resp.json()["error"]


@pytest.mark.parametrize(("label", "path"), ESCAPES, ids=[e[0] for e in ESCAPES])
async def test_raw_route_refuses_paths_that_leave_the_workspace(
    owner_client, workspace, label, path
):
    resp = await owner_client.get(f"/api/v1/workspace/raw?path={path}")
    assert resp.status_code == 400


# -- Content-Disposition: a filename is not a trusted string ----------------
#
# workspace_write_file's own path argument goes through _resolve_within, but
# that gate only forbids ESCAPING the root — it says nothing about which
# characters make up the final path component, and _atomic_write does not
# either. A POSIX filename may legally contain a double-quote or raw CR/LF,
# so both files below are created directly on disk (bypassing the write
# tool entirely, which never rejects them either) to prove the /raw route
# cannot be made to emit a malformed or injected header no matter what name
# Nova gave the file.


async def test_raw_content_disposition_is_well_formed_for_a_quote_in_the_filename(
    owner_client, workspace
):
    name = 'evil".md'
    (workspace / name).write_bytes(b"data")

    resp = await owner_client.get(f"/api/v1/workspace/raw?path={quote(name, safe='')}")
    assert resp.status_code == 200
    assert resp.content == b"data"

    disposition = resp.headers["content-disposition"]
    assert "\r" not in disposition
    assert "\n" not in disposition
    # The ascii filename="..." parameter must be a well-formed quoted
    # string: exactly one opening and one closing quote, nothing in
    # between that could terminate the value early or start a new
    # parameter.
    match = re.search(r'filename="([^"]*)"', disposition)
    assert match is not None, f"no well-formed filename= parameter in {disposition!r}"
    assert '"' not in match.group(1)
    # The real name survives intact in the RFC 5987 parameter, which
    # percent-encodes the quote rather than ever emitting it raw.
    assert "filename*=UTF-8''" in disposition
    assert quote(name, safe="") in disposition


async def test_raw_content_disposition_is_well_formed_for_crlf_in_the_filename(
    owner_client, workspace
):
    name = "evil\r\nX-Injected: yes.md"
    (workspace / name).write_bytes(b"data")

    resp = await owner_client.get(f"/api/v1/workspace/raw?path={quote(name, safe='')}")
    assert resp.status_code == 200
    assert resp.content == b"data"

    disposition = resp.headers["content-disposition"]
    # No raw CR or LF anywhere in the header value — that byte pair is
    # exactly what turns one header into an injected second one. The
    # literal text "X-Injected: yes.md" is fine to see here as long as it
    # stays inert prose inside a single well-formed filename= value —
    # which the two checks below are what actually proves.
    assert "\r" not in disposition
    assert "\n" not in disposition
    match = re.search(r'filename="([^"]*)"', disposition)
    assert match is not None, f"no well-formed filename= parameter in {disposition!r}"
    assert '"' not in match.group(1)
    # The real name (CRLF and all) survives, percent-encoded, in filename*.
    assert quote(name, safe="") in disposition


# -- never writes ------------------------------------------------------------


def test_the_module_holds_no_write_statements():
    """Mechanical pin, not a style opinion: a reviewer greps for these
    verbs so a read-only module cannot regress into a write path without
    the diff saying so out loud."""
    import inspect

    source = inspect.getsource(workspace_api)
    for verb in ("INSERT ", "UPDATE ", "DELETE ", "write_text(", "write_bytes(", "os.replace("):
        assert verb not in source, f"{verb!r} found in a module that must never write"
