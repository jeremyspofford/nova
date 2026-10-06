"""The hub's build of Nova's agent (S42b, D13): served only when every file
matches its manifest, the manifest signed by core's own key, on seven exact
public paths — and a missing or broken build is said, never served.

These are unauthenticated paths that serve executables, so beside the brief's
pins this file holds the ones a download path needs (S42b Task 18, security):

  * only the six exact names are ever a file — a caller's name is looked up,
    never joined into a path, so `..`, an encoded slash, an absolute path and
    a NUL reach nothing;
  * one file missing, unreadable, linked or changed makes the WHOLE build a
    stated 503, and a download is re-hashed as it streams, so a response that
    completes is the manifest's bytes;
  * the 30-a-minute limit is per client as nginx saw it (X-Real-IP, believed
    only from web's fixed address), with a visitor through a relay counted
    apart (network.bucket_of), so a header cannot buy a new budget or spend
    the hub's own loopback's;
  * no reason names a host path, a user or a key — anyone can read them;
  * the golden manifest novad's Go suite reads is what core's signer makes
    today (tests/fixtures/gen_manifest_golden.py).
"""

from __future__ import annotations

import getpass
import hashlib
import json
import logging
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import unquote

import httpx
import pytest

from app import (
    agent_card,
    agent_dist,
    agent_dist_api,
    devices,
    envelopes,
    identity,
    network,
    platform_walks,
)
from app.main import app as core_app
from tests.conftest import BASE_URL, SERVICE_TOKEN, requires_db
from tests.fixtures import gen_manifest_golden

VERSION = "aaaaaaaaaaaa"
BEARER = {"Authorization": f"Bearer {SERVICE_TOKEN}"}

# RFC 5737 addresses: web (nginx) at its fixed address, and the two doors
# nginx's $remote_addr names behind it.
WEB = "192.0.2.10"
LOOPBACK_DOOR = "198.51.100.1"
TAILNET_DOOR = "198.51.100.20"


@pytest.fixture(autouse=True)
def _fresh_limiter_and_hashes():
    """Both are process-global by design; no test leaves its hits or hashes to
    the next one."""
    agent_dist._HASHES.clear()
    agent_dist_api._HITS.clear()
    yield
    agent_dist_api._HITS.clear()


@pytest.fixture
def dist(tmp_path, monkeypatch):
    """A complete fake build on disk, laid out as agent-dist writes it."""
    monkeypatch.setenv(agent_dist.DIST_DIR_ENV, str(tmp_path))
    agent_dist._HASHES.clear()
    build = tmp_path / VERSION
    build.mkdir()
    files = {}
    for goos, arch in agent_dist.TARGETS:
        name = agent_dist.file_name(goos, arch)
        body = f"build of {goos}/{arch}".encode()
        (build / name).write_bytes(body)
        files[agent_dist.file_key(goos, arch)] = {
            "name": name,
            "sha256": hashlib.sha256(body).hexdigest(),
            "size": len(body),
        }
    (build / "manifest.json").write_text(
        json.dumps(
            {
                "v": 1,
                "version": VERSION,
                "built_at": "2026-09-28T12:00:00Z",
                "go": "go1.27.1",
                "files": files,
            }
        )
    )
    (tmp_path / "current").write_text(VERSION + "\n")
    return tmp_path


def _manifest_of(dist: Path) -> dict:
    return json.loads((dist / VERSION / "manifest.json").read_text())


def _write_manifest(dist: Path, manifest: dict) -> None:
    (dist / VERSION / "manifest.json").write_text(json.dumps(manifest))


def test_the_current_build_is_read_and_checked(dist):
    build = agent_dist.current()
    assert build.version == VERSION
    assert build.file_for("windows", "amd64")["name"] == "novad-windows-amd64.exe"
    assert build.file_for("plan9", "amd64") is None


def test_a_file_whose_bytes_do_not_match_its_manifest_makes_the_build_unavailable(dist):
    (dist / VERSION / "novad-linux-amd64").write_bytes(b"something else")
    with pytest.raises(agent_dist.DistUnavailable, match="does not match its manifest"):
        agent_dist.current()


def test_no_build_is_stated_not_guessed(tmp_path, monkeypatch):
    monkeypatch.setenv(agent_dist.DIST_DIR_ENV, str(tmp_path))
    with pytest.raises(agent_dist.DistUnavailable, match="no agent build on this hub yet"):
        agent_dist.current()
    assert agent_dist.current_version() is None


def test_the_seven_public_paths_are_exact():
    assert len(agent_dist.PUBLIC_PATHS) == 7
    assert agent_dist.PUBLIC_PATHS <= identity.PUBLIC_PATHS
    assert identity.PUBLIC_PATHS - agent_dist.PUBLIC_PATHS == {
        "/api/v1/auth/state",
        "/api/v1/auth/register",
        "/api/v1/auth/login",
        "/api/v1/devices/enroll",
    }


@requires_db
async def test_the_manifest_is_signed_by_cores_key(dist, pool):
    signed = await agent_dist.signed_manifest(pool)
    assert signed["manifest"]["version"] == VERSION
    assert envelopes.verify(
        await devices.core_public_key_hex(pool), signed["manifest"], signed["sig"]
    )


@requires_db
async def test_the_manifest_and_a_binary_are_public(client, dist):
    resp = await client.get("/api/v1/agent/manifest")
    assert resp.status_code == 200, resp.text
    assert set(resp.json()) >= {"manifest", "sig"}
    resp = await client.get("/api/v1/agent/dist/novad-linux-amd64")
    assert resp.status_code == 200 and resp.content == b"build of linux/amd64"


@requires_db
async def test_a_name_outside_the_build_is_not_public(client, dist):
    assert (await client.get("/api/v1/agent/dist/novad-linux-amd64x")).status_code == 401


@requires_db
async def test_downloads_are_rate_limited(client, dist, monkeypatch):
    monkeypatch.setattr(agent_dist_api, "RATE_PER_MINUTE", 2)
    now = [1000.0]
    monkeypatch.setattr(agent_dist_api, "_clock", lambda: now[0])

    async def download() -> httpx.Response:
        return await client.get("/api/v1/agent/dist/novad-linux-amd64")

    answers = []
    for step in (0.0, 10.4, 9.8):  # asked at 1000.0, 1010.4 and 1020.2
        now[0] += step
        answers.append(await download())
    assert [a.status_code for a in answers] == [200, 200, 429]
    # Fix round 1: Retry-After is the seconds until the oldest hit (1000.0)
    # leaves this client's minute — 39.8, rounded up...
    assert answers[2].headers["retry-after"] == "40"
    # ...and never 0: half a second to go reads 1.
    now[0] = 1059.5
    late = await download()
    assert late.status_code == 429 and late.headers["retry-after"] == "1"
    now[0] = 1060.0  # the oldest hit has left the window
    assert (await download()).status_code == 200


@requires_db
async def test_no_build_is_a_stated_503(client, tmp_path, monkeypatch):
    monkeypatch.setenv(agent_dist.DIST_DIR_ENV, str(tmp_path))
    resp = await client.get("/api/v1/agent/manifest")
    assert resp.status_code == 503 and "no agent build" in resp.json()["error"]


# -- every name is a lookup, never a path ------------------------------------

# Requests whose name is not one of the six. Each reaches the router with
# exactly this decoded name (uvicorn percent-decodes the target and does not
# remove dot segments; nginx proxies $request_uri, the target as sent).
TRICKS = [
    "/api/v1/agent/dist/%2e%2e",  # `..`
    "/api/v1/agent/dist/%2e%2e%2fmanifest.json",  # an encoded slash
    "/api/v1/agent/dist/..%2F..%2Fcurrent",
    "/api/v1/agent/dist/%2Fetc%2Fpasswd",  # an absolute path
    "/api/v1/agent/dist//etc/passwd",
    "/api/v1/agent/dist/novad-linux-amd64%00",  # a NUL
    "/api/v1/agent/dist/%00",
    "/api/v1/agent/dist/manifest.json",
    "/api/v1/agent/dist/current",
    "/api/v1/agent/dist/NOVAD-LINUX-AMD64",
    "/api/v1/agent/dist/novad-linux-amd64.exe",
    # A decoded `?` or `#` made request.url.path read as the exact public
    # path; identity now matches the path the router matches (Task 26 fix
    # round 1, I3), so these are not public either — and the route's own
    # exact-name check would still refuse them.
    "/api/v1/agent/dist/novad-linux-amd64%3F",
    "/api/v1/agent/dist/novad-linux-amd64%23x",
]


def _sentinel(dist: Path) -> bytes:
    """Bytes beside the build that a traversal would reach."""
    body = b"sentinel bytes outside the build"
    (dist / "sentinel.txt").write_bytes(body)
    return body


def _no_build_bytes(body: bytes, sentinel: bytes) -> None:
    assert sentinel not in body
    assert b"build of " not in body
    assert b'"files"' not in body


async def _raw_get(
    raw_path: bytes, headers: dict[str, str] | None = None, *, method: str = "GET"
) -> tuple[int, bytes]:
    """One request (a GET unless `method` says) straight into the ASGI app
    with the target exactly as a client sent it: httpx removes dot segments
    before it sends, a raw client (and nginx's $request_uri) does not. The
    scope is built the way uvicorn builds it — `path` is the percent-decoded
    target, nothing normalized."""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": unquote(raw_path.decode("ascii")),
        "raw_path": raw_path,
        "root_path": "",
        "query_string": b"",
        "headers": [
            (b"host", b"test"),
            *((k.lower().encode(), v.encode()) for k, v in (headers or {}).items()),
        ],
        "client": ("127.0.0.1", 40000),
        "server": ("test", 80),
        "state": {},
    }
    sent: list[dict] = []

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    await core_app(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start["status"], body


def _anon_client(peer: str = "127.0.0.1") -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=core_app, client=(peer, 40000)), base_url=BASE_URL
    )


@pytest.mark.parametrize("path", TRICKS)
async def test_a_name_that_is_not_one_of_the_six_reaches_no_file(dist, path, monkeypatch):
    monkeypatch.setenv("SERVICE_TOKEN", SERVICE_TOKEN)
    sentinel = _sentinel(dist)
    async with _anon_client() as anon:
        resp = await anon.get(path)
        # Not public: none of these is an exact public path to the router.
        assert resp.status_code == 401, (path, resp.status_code)
        _no_build_bytes(resp.content, sentinel)
        resp = await anon.get(path, headers=BEARER)
        assert resp.status_code == 404, (path, resp.status_code, resp.text)
        _no_build_bytes(resp.content, sentinel)


@pytest.mark.parametrize(
    "raw",
    [
        b"/api/v1/agent/dist/..",
        b"/api/v1/agent/dist/../manifest.json",
        b"/api/v1/agent/dist/../../sentinel.txt",
        b"/api/v1/agent/dist/./novad-linux-amd64",
    ],
)
async def test_a_literal_dot_segment_reaches_no_file(dist, raw, monkeypatch):
    monkeypatch.setenv("SERVICE_TOKEN", SERVICE_TOKEN)
    sentinel = _sentinel(dist)
    status, body = await _raw_get(raw)
    assert status == 401, (raw, status)
    _no_build_bytes(body, sentinel)
    status, body = await _raw_get(raw, BEARER)
    assert status == 404, (raw, status, body)
    _no_build_bytes(body, sentinel)


@pytest.mark.parametrize(
    "method,raw",
    [
        ("GET", b"/api/v1/devices/pairing-code/../../agent/manifest"),
        ("GET", b"/api/v1/devices/pairing-code/%2e%2e/%2e%2e/agent/manifest"),
        ("GET", b"/api/v1/devices/pairing-code/../enroll"),
        # Fix round 1 (I3): a decoded `?` or `#` — or a tab, newline or
        # return, which a URL parser drops — made request.url.path read as
        # the exact public path while the router matched the whole path.
        ("GET", b"/api/v1/agent/manifest%3F/x"),
        ("GET", b"/api/v1/agent/manifest%23/x"),
        ("GET", b"/api/v1/agent/dist/novad-linux-amd64%3Fx"),
        ("GET", b"/api/v1/agent/mani%0Afest"),
        ("GET", b"/api/v1/agent/mani%09fest"),
        ("GET", b"/api/v1/agent/mani%0Dfest"),
        ("POST", b"/api/v1/devices/enroll%3F/../enroll"),
        ("PATCH", b"/api/v1/devices/enroll%3F/../enroll"),
    ],
)
async def test_a_path_nginx_resolves_into_a_carve_out_is_not_public_to_core(
    method, raw, monkeypatch
):
    """S42b Task 26 (R5): nginx resolves dot segments (and decodes `%3F` and
    `%0A` into the path) to pick a location, so each of these lands in one of
    its gate carve-outs (`/api/v1/agent/`, `= /api/v1/devices/enroll`) — and
    it forwards $request_uri, the target AS SENT (gate_test.sh pins that
    half). Core is the backstop: it serves without an identity exactly the
    paths in identity.PUBLIC_PATHS, matched on the path its router matches,
    so none of these is one."""
    monkeypatch.setenv("SERVICE_TOKEN", SERVICE_TOKEN)
    status, body = await _raw_get(raw, method=method)
    assert status == 401, (method, raw, status, body)
    assert b"bearer" in body  # identity's refusal, never a route's answer


@pytest.mark.parametrize("path", sorted(identity.PUBLIC_PATHS))
def test_every_public_path_is_still_public(path):
    """I3's other half: matching on the router's path keeps each exact
    public path public (the routes themselves are walked by their own tests:
    auth, enroll, the manifest and the builds)."""
    assert identity.is_public({"type": "http", "path": path, "root_path": ""})
    assert not identity.is_public({"type": "http", "path": f"{path}?x", "root_path": ""})


@pytest.mark.parametrize(
    "name",
    [
        "..",
        "../current",
        "/etc/passwd",
        "novad-linux-amd64\x00",
        "",
        "sentinel.txt",
        "manifest.json",
    ],
)
def test_the_reader_refuses_any_other_name_before_it_touches_a_file(tmp_path, monkeypatch, name):
    # A dist dir that does not exist: a reader that went to the disk would
    # say "no agent build on this hub yet" instead.
    monkeypatch.setenv(agent_dist.DIST_DIR_ENV, str(tmp_path / "absent"))
    with pytest.raises(agent_dist.DistUnavailable, match="not one of the agent's builds"):
        agent_dist.open_file(name)


# -- the whole build or none of it --------------------------------------------


def test_one_broken_file_makes_every_file_unavailable(dist):
    (dist / VERSION / "novad-windows-arm64.exe").write_bytes(b"something else")
    for name in agent_dist.FILE_NAMES:
        with pytest.raises(
            agent_dist.DistUnavailable,
            match=r"novad-windows-arm64\.exe in the agent build aaaaaaaaaaaa does not match",
        ):
            agent_dist.open_file(name)


async def test_a_broken_build_is_a_stated_503_for_every_download(dist):
    (dist / VERSION / "novad-darwin-amd64").unlink()
    async with _anon_client() as anon:
        for name in sorted(agent_dist.FILE_NAMES):
            resp = await anon.get(f"/api/v1/agent/dist/{name}")
            assert resp.status_code == 503, (name, resp.status_code)
            assert resp.json()["error"] == (
                "novad-darwin-amd64 is missing from the agent build aaaaaaaaaaaa"
            )


def test_a_size_the_manifest_misstates_makes_the_build_unavailable(dist):
    manifest = _manifest_of(dist)
    manifest["files"]["linux-arm64"]["size"] += 1
    _write_manifest(dist, manifest)
    with pytest.raises(
        agent_dist.DistUnavailable,
        match=r"novad-linux-arm64 in the agent build aaaaaaaaaaaa does not match its "
        r"manifest \(size 20, manifest 21\)",
    ):
        agent_dist.current()


@pytest.mark.parametrize(
    ("change", "said"),
    [
        (lambda m: m.update(v=2), "is not version 1"),
        (lambda m: m.update(v=True), "is not version 1"),
        (lambda m: m.update(version="bbbbbbbbbbbb"), "does not describe it"),
        (lambda m: m.update(files=[]), "does not describe it"),
        (lambda m: m["files"].pop("darwin-arm64"), "does not describe darwin-arm64"),
        # Fix round 1: a file this core does not serve is refused, never dropped
        # from what core signs — the reviewer's case (no such file on disk)...
        (
            lambda m: m["files"].update(
                {"plan9-amd64": {"name": "novad-plan9-amd64", "sha256": "a" * 64, "size": 5}}
            ),
            "describes files this core does not serve",
        ),
        # ...and a well-formed entry whose file is there.
        (
            lambda m: m["files"].update({"linux-386": dict(m["files"]["linux-amd64"])}),
            "describes files this core does not serve",
        ),
        (lambda m: m["files"]["linux-amd64"].update(size=True), "does not describe linux-amd64"),
        (lambda m: m["files"]["linux-amd64"].update(size=-1), "does not describe linux-amd64"),
        (
            lambda m: m["files"]["linux-amd64"].update(
                sha256=m["files"]["linux-amd64"]["sha256"] + "\n"
            ),
            "does not describe linux-amd64",
        ),
        (
            lambda m: m["files"]["linux-amd64"].update(name="../novad-linux-amd64"),
            "does not describe linux-amd64",
        ),
    ],
)
def test_a_manifest_that_does_not_describe_the_build_is_refused(dist, change, said):
    manifest = _manifest_of(dist)
    change(manifest)
    _write_manifest(dist, manifest)
    with pytest.raises(agent_dist.DistUnavailable, match=said):
        agent_dist.current()


def test_a_file_that_cannot_be_read_makes_the_build_unavailable(dist):
    target = dist / VERSION / "novad-darwin-arm64"
    target.chmod(0)
    try:
        if os.access(target, os.R_OK):
            pytest.skip("this test runs as a user who can read a mode-0 file (root)")
        with pytest.raises(
            agent_dist.DistUnavailable,
            match=r"novad-darwin-arm64 in the agent build aaaaaaaaaaaa could not be read "
            r"\(Permission denied\)",
        ):
            agent_dist.current()
    finally:
        target.chmod(0o644)


def test_a_symlink_in_the_build_is_never_followed(dist, tmp_path_factory):
    # The link's target holds the very bytes the manifest names: a reader that
    # followed it would call the build good.
    elsewhere = tmp_path_factory.mktemp("elsewhere") / "novad"
    elsewhere.write_bytes(b"build of linux/amd64")
    target = dist / VERSION / "novad-linux-amd64"
    target.unlink()
    target.symlink_to(elsewhere)
    with pytest.raises(
        agent_dist.DistUnavailable,
        match="novad-linux-amd64 in the agent build aaaaaaaaaaaa is a symbolic link",
    ):
        agent_dist.current()


def test_a_fifo_in_the_build_is_refused_without_waiting_for_a_writer(dist):
    target = dist / VERSION / "novad-linux-amd64"
    target.unlink()
    os.mkfifo(target)
    with pytest.raises(
        agent_dist.DistUnavailable,
        match="novad-linux-amd64 in the agent build aaaaaaaaaaaa is not a regular file",
    ):
        agent_dist.current()


def test_a_file_replaced_with_its_old_size_and_mtime_is_hashed_again(dist):
    """The hash cache is keyed by the open file's identity and times, never
    by (path, mtime, size) alone: a file replaced by one of the same size
    with its mtime copied over (cp -p, rsync -a, tar) is a new inode."""
    agent_dist.current()
    target = dist / VERSION / "novad-linux-amd64"
    before = target.stat()
    swap = dist / VERSION / "swap"
    swap.write_bytes(b"BUILD OF LINUX/AMD64")  # the same 20 bytes' length
    os.utime(swap, ns=(before.st_atime_ns, before.st_mtime_ns))
    os.replace(swap, target)
    with pytest.raises(agent_dist.DistUnavailable, match="does not match its manifest"):
        agent_dist.current()


def test_a_file_rewritten_in_place_with_its_mtime_put_back_is_hashed_again(dist):
    """The same inode, the same size, the mtime put back: only the ctime,
    which nothing in userspace can set, says the bytes changed."""
    agent_dist.current()
    target = dist / VERSION / "novad-linux-amd64"
    before = target.stat()
    # A filesystem's clock can be as coarse as a few milliseconds: wait one
    # out, so the rewrite's ctime cannot equal the hashed state's.
    time.sleep(0.05)
    target.write_bytes(b"BUILD OF LINUX/AMD64")
    os.utime(target, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert target.stat().st_mtime_ns == before.st_mtime_ns
    with pytest.raises(agent_dist.DistUnavailable, match="does not match its manifest"):
        agent_dist.current()


# -- what is served is what was checked ---------------------------------------


async def _drain(opened: agent_dist.OpenFile, chunk_size: int) -> tuple[bytes, Exception | None]:
    got = b""
    try:
        async for chunk in agent_dist.stream(opened, chunk_size=chunk_size):
            got += chunk
    except agent_dist.DistUnavailable as exc:
        return got, exc
    return got, None


async def test_a_download_streams_exactly_the_checked_bytes(dist):
    opened = agent_dist.open_file("novad-linux-amd64")
    got, failed = await _drain(opened, chunk_size=3)
    assert failed is None and got == b"build of linux/amd64"
    assert opened.file.closed


async def test_a_file_changed_after_its_check_is_never_served_whole(dist):
    opened = agent_dist.open_file("novad-linux-amd64")
    # Rewritten in place under the open file: the same size, other bytes.
    (dist / VERSION / "novad-linux-amd64").write_bytes(b"BUILD OF LINUX/AMD64")
    got, failed = await _drain(opened, chunk_size=3)
    assert isinstance(failed, agent_dist.DistUnavailable)
    assert "changed while it was being sent" in str(failed)
    assert len(got) < opened.size  # the response never completes
    assert opened.file.closed


async def test_a_file_that_grows_after_its_check_is_never_served_whole(dist):
    opened = agent_dist.open_file("novad-linux-amd64")
    with (dist / VERSION / "novad-linux-amd64").open("ab") as f:
        f.write(b" and more")
    got, failed = await _drain(opened, chunk_size=4)
    assert isinstance(failed, agent_dist.DistUnavailable)
    assert len(got) < opened.size


async def test_the_download_route_states_its_length_and_name(dist):
    async with _anon_client() as anon:
        resp = await anon.get("/api/v1/agent/dist/novad-windows-arm64.exe")
    assert resp.status_code == 200
    assert resp.content == b"build of windows/arm64"
    assert resp.headers["content-length"] == str(len(b"build of windows/arm64"))
    assert resp.headers["content-type"] == "application/octet-stream"
    assert 'filename="novad-windows-arm64.exe"' in resp.headers["content-disposition"]


async def test_a_download_whose_file_changes_under_it_never_completes(dist, monkeypatch, caplog):
    """Through the whole app, middleware and all: the file is checked and
    opened, then rewritten in place before a byte goes out. The request
    fails instead of answering a 200 — and the reason is in core's log,
    because behind the identity middleware an exception raised mid-stream
    reaches no other log (on the wire uvicorn cuts the client off at the
    stated Content-Length; checked by hand, see the task report)."""
    real_open = agent_dist.open_file

    def open_then_change(name: str) -> agent_dist.OpenFile:
        opened = real_open(name)
        (dist / VERSION / name).write_bytes(b"BUILD OF LINUX/AMD64")  # in place, same size
        return opened

    monkeypatch.setattr(agent_dist, "open_file", open_then_change)
    with caplog.at_level(logging.ERROR, logger="core"):
        async with _anon_client() as anon:
            with pytest.raises(agent_dist.DistUnavailable, match="changed while it was being sent"):
                await anon.get("/api/v1/agent/dist/novad-linux-amd64")
    said = [r.getMessage() for r in caplog.records if r.name == "core"]
    assert said == [
        "novad-linux-amd64 in the agent build aaaaaaaaaaaa changed while it was being sent "
        "— the download was stopped"
    ]


# -- the limit is per client, as nginx saw it ---------------------------------


async def _status(client: httpx.AsyncClient, real_ip: str | None = None) -> int:
    headers = {"X-Real-IP": real_ip} if real_ip else {}
    return (await client.get("/api/v1/agent/dist/novad-linux-amd64", headers=headers)).status_code


async def test_one_door_spending_its_minute_never_locks_out_the_hubs_own_loopback(
    dist, monkeypatch
):
    monkeypatch.setenv(network.WEB_ADDR_ENV, WEB)
    monkeypatch.setattr(agent_dist_api, "RATE_PER_MINUTE", 2)
    async with _anon_client(WEB) as nginx:
        assert [await _status(nginx, TAILNET_DOOR) for _ in range(3)] == [200, 200, 429]
        assert await _status(nginx, LOOPBACK_DOOR) == 200


async def test_a_header_the_caller_wrote_never_picks_its_budget(dist, monkeypatch):
    monkeypatch.setenv(network.WEB_ADDR_ENV, WEB)
    monkeypatch.setattr(agent_dist_api, "RATE_PER_MINUTE", 2)
    # Not nginx: a new X-Real-IP on every request buys no new budget...
    async with _anon_client("192.0.2.77") as direct:
        codes = [await _status(direct, f"203.0.113.{i}") for i in range(3)]
    assert codes == [200, 200, 429]
    # ...and naming the hub's loopback door spends no budget but the caller's own.
    async with _anon_client("192.0.2.78") as forger:
        assert [await _status(forger, LOOPBACK_DOOR) for _ in range(2)] == [200, 200]
    async with _anon_client(WEB) as nginx:
        assert await _status(nginx, LOOPBACK_DOOR) == 200


async def _download(client: httpx.AsyncClient, headers: dict[str, str]) -> httpx.Response:
    return await client.get("/api/v1/agent/dist/novad-linux-amd64", headers=headers)


async def test_relayed_visitors_spend_a_minute_of_their_own_never_the_hub_loopbacks(
    dist, monkeypatch
):
    """S42b Task 26 (R2): a stranger on the owner's tunnel reaches web from
    the hub's own loopback door, the door ./install uses. Counted by the door
    alone, a stranger asking 30 times a minute would hold ./install's
    download off for as long as it kept asking. A request that came through
    a relay is counted apart (network.bucket_of): the 31st relayed request
    in a minute is refused, and ./install is still served that minute."""
    monkeypatch.setenv(network.WEB_ADDR_ENV, WEB)
    monkeypatch.setenv(network.GATEWAY_ENV, LOOPBACK_DOOR)
    monkeypatch.setenv(network.TAILSCALE_ADDR_ENV, TAILNET_DOOR)
    monkeypatch.setattr(agent_dist_api, "_clock", lambda: 1000.0)  # one minute, throughout
    tunnel = {"X-Real-IP": LOOPBACK_DOOR, "Cf-Connecting-IP": "203.0.113.9"}
    async with _anon_client(WEB) as nginx:
        rate = agent_dist_api.RATE_PER_MINUTE  # 30
        served = [await _download(nginx, tunnel) for _ in range(rate)]
        assert [r.status_code for r in served] == [200] * rate
        refused = await _download(nginx, tunnel)
        assert refused.status_code == 429
        assert refused.headers["retry-after"] == "60"
        # Another stranger on the tunnel: the same bucket — the header's value
        # names nothing.
        other = {"X-Real-IP": LOOPBACK_DOOR, "Cf-Connecting-IP": "203.0.113.10"}
        assert (await _download(nginx, other)).status_code == 429
        # ./install through web, the same minute: served.
        assert (await _download(nginx, {"X-Real-IP": LOOPBACK_DOOR})).status_code == 200
        # Funnel's strangers have a relayed bucket of their own (one per door).
        assert (await _download(nginx, {"X-Real-IP": TAILNET_DOOR})).status_code == 200
    # ./install straight to core's own port: served too.
    async with _anon_client(LOOPBACK_DOOR) as install:
        assert (await _download(install, {})).status_code == 200


async def test_a_minute_later_the_client_is_served_again_and_nothing_is_kept(dist, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(agent_dist_api, "_clock", lambda: now[0])
    monkeypatch.setattr(agent_dist_api, "RATE_PER_MINUTE", 1)
    async with _anon_client("192.0.2.77") as one:
        assert await _status(one) == 200
        assert await _status(one) == 429
        now[0] += 61
        assert await _status(one) == 200
    now[0] += 61
    async with _anon_client("192.0.2.99") as two:
        assert await _status(two) == 200
    # The first client's minute is over: it left nothing behind.
    assert set(agent_dist_api._HITS) == {"192.0.2.99"}


def test_core_believes_x_forwarded_for_only_from_inside_its_own_container():
    """The limit's client starts from request.client, which uvicorn rewrites
    from X-Forwarded-For when the peer is a proxy it trusts. Core's uvicorn
    trusts only its default, 127.0.0.1 — inside the core container, the
    container itself — so every peer from outside is the TCP peer: nginx at
    web's fixed address (whose X-Real-IP network.client_of then reads), or
    the subnet gateway for the published port. Widening that trust (a
    --forwarded-allow-ips flag, or FORWARDED_ALLOW_IPS reaching core) would
    let a caller write its own client address and walk around the limit."""
    repo = Path(__file__).resolve().parents[3]
    dockerfile = (repo / "services" / "core" / "Dockerfile").read_text()
    compose = (repo / "deploy" / "docker-compose.yml").read_text()
    assert "forwarded-allow-ips" not in dockerfile
    assert "FORWARDED_ALLOW_IPS" not in dockerfile and "FORWARDED_ALLOW_IPS" not in compose
    core = compose[compose.index("\n  core:\n") : compose.index("\n  gateway:\n")]
    assert "env_file" not in core  # an .env value reaches core only by name


@requires_db
async def test_the_manifest_and_the_downloads_share_one_budget(client, dist, monkeypatch):
    monkeypatch.setattr(agent_dist_api, "RATE_PER_MINUTE", 2)
    assert (await client.get("/api/v1/agent/manifest")).status_code == 200
    assert (await client.get("/api/v1/agent/dist/novad-linux-amd64")).status_code == 200
    assert (await client.get("/api/v1/agent/manifest")).status_code == 429


# -- every reason is public, so none names a path, a user or a key ------------


def _unlink(path: Path) -> None:
    path.unlink()


def _to_dir(path: Path) -> None:
    path.unlink()
    path.mkdir()


def _extra_entry(d: Path, key: str) -> None:
    manifest = _manifest_of(d)
    manifest["files"][key] = dict(manifest["files"]["linux-amd64"])
    _write_manifest(d, manifest)


BREAKAGES = {
    "no current pointer": lambda d: _unlink(d / "current"),
    "a current pointer that is a directory": lambda d: _to_dir(d / "current"),
    "a current pointer holding a path": lambda d: (d / "current").write_text(str(d) + "\n"),
    "no manifest": lambda d: _unlink(d / VERSION / "manifest.json"),
    "a manifest that is a directory": lambda d: _to_dir(d / VERSION / "manifest.json"),
    "a manifest that is not JSON": lambda d: (d / VERSION / "manifest.json").write_text("{"),
    "a manifest nested past parsing": lambda d: (d / VERSION / "manifest.json").write_text(
        "[" * 100000
    ),
    "a missing file": lambda d: _unlink(d / VERSION / "novad-linux-amd64"),
    "a file that is a directory": lambda d: _to_dir(d / VERSION / "novad-linux-amd64"),
    "a changed file": lambda d: (d / VERSION / "novad-linux-amd64").write_bytes(b"x" * 20),
    # The keys are never echoed: this one is a host path.
    "a manifest entry this core does not serve": lambda d: _extra_entry(d, str(d)),
}


@pytest.mark.parametrize("breakage", sorted(BREAKAGES))
def test_no_reason_names_a_host_path_a_user_or_a_key(dist, breakage):
    BREAKAGES[breakage](dist)
    with pytest.raises(agent_dist.DistUnavailable) as caught:
        agent_dist.current()
    reason = str(caught.value)
    assert reason
    assert str(dist) not in reason and str(dist.parent) not in reason
    assert getpass.getuser() not in reason
    assert os.path.expanduser("~") not in reason


@requires_db
async def test_the_manifests_503_carries_only_the_reason(client, dist, pool):
    (dist / VERSION / "novad-linux-amd64").chmod(0)
    try:
        resp = await client.get("/api/v1/agent/manifest")
    finally:
        (dist / VERSION / "novad-linux-amd64").chmod(0o644)
    assert resp.status_code == 503
    body = resp.text
    key = await devices.signing_key(pool)
    assert key.private_bytes_raw().hex() not in body
    assert await devices.core_public_key_hex(pool) not in body
    assert str(dist) not in body and getpass.getuser() not in body


# -- the listings compare each agent with the hub's build ---------------------


async def _paired(pool, name: str, version: str) -> None:
    minted = await devices.mint_pairing_code(pool, created_by=None)
    enrolled = await devices.enroll(
        pool,
        code=minted["code"],
        pubkey=hashlib.sha256(name.encode()).hexdigest(),
        name=name,
        platform="linux",
        hostname=name.upper(),
    )
    await pool.execute(
        "UPDATE devices SET facts = $2, facts_at = now() WHERE id = $1",
        uuid.UUID(enrolled["device_id"]),
        {"v": 2, "agent": {"version": version, "mode": "foreground"}},
    )


@requires_db
async def test_the_device_list_says_each_agent_against_the_hubs_build(owner_client, dist, pool):
    await _paired(pool, "on-the-build", VERSION)
    await _paired(pool, "on-another", "0a0a0a0a0a0a")
    resp = await owner_client.get("/api/v1/devices")
    assert resp.status_code == 200, resp.text
    by_name = {d["name"]: d for d in resp.json()["devices"]}
    assert by_name["on-the-build"]["build_state"] == "current"
    assert by_name["on-another"]["build_state"] == "behind"
    assert {d["hub_version"] for d in by_name.values()} == {VERSION}


@requires_db
async def test_with_no_build_the_device_list_says_unknown_not_behind(
    owner_client, tmp_path, monkeypatch, pool
):
    monkeypatch.setenv(agent_dist.DIST_DIR_ENV, str(tmp_path))
    await _paired(pool, "laptop", VERSION)
    resp = await owner_client.get("/api/v1/devices")
    [device] = resp.json()["devices"]
    assert device["build_state"] == "unknown" and device["hub_version"] is None


# -- the golden manifest novad's Go suite reads -------------------------------


async def test_the_golden_manifest_novad_reads_is_what_core_signs_today():
    """apps/novad/internal/install/testdata/manifest_golden.json is core's
    signer's output (agent_dist.signed_manifest, with the fixture's throwaway
    key), committed so novad's CheckManifest can be held to it in Go. If this
    goes red, core's manifest moved: regenerate it with
    `uv run python tests/fixtures/gen_manifest_golden.py` and run novad's Go
    suite — that is what says whether the agent still reads what core signs."""
    fresh = gen_manifest_golden.render(await gen_manifest_golden.golden_document())
    committed = gen_manifest_golden.GOLDEN.read_text(encoding="utf-8")
    assert fresh == committed, "the golden manifest is stale — see this test's docstring"
    golden = json.loads(committed)
    assert envelopes.verify(
        golden["public_key_hex"], golden["response"]["manifest"], golden["response"]["sig"]
    )
    # A throwaway key, never core's: it is the fixture seed's.
    assert (
        golden["public_key_hex"]
        == gen_manifest_golden.fixture_key().public_key().public_bytes_raw().hex()
    )


# -- the card's commands on the public manifest (S42b Task 19, P18) -----------

NOVA = "https://nova.fake-tailnet.ts.net"


def _tailnet(tmp_path: Path, monkeypatch) -> None:
    """The sidecar's status file, fresh: Nova's address is NOVA."""
    status = tmp_path / "tailscale.json"
    status.write_text(
        json.dumps(
            {
                "version": 1,
                "backend_state": "Running",
                "dns_name": "nova.fake-tailnet.ts.net",
                "serve_ok": True,
                "https_cert": True,
                "written_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        )
    )
    monkeypatch.setenv(network.STATUS_FILE_ENV, str(status))


@requires_db
async def test_the_manifest_carries_the_commands_with_a_code_slot_and_the_walks(
    client, dist, monkeypatch, tmp_path
):
    monkeypatch.setenv(network.STATUS_FILE_ENV, str(tmp_path / "absent.json"))
    resp = await client.get("/api/v1/agent/manifest?origin=loopback")
    body = resp.json()
    assert (
        "--hub http://127.0.0.1:3000" in body["commands"]["linux"]
        and "{CODE}" in body["commands"]["windows"]
    )
    assert set(body["walks"]) == {"linux", "macos", "windows"} and body["version"] == VERSION
    assert set(body["notes"]) == {"linux", "macos", "windows"}
    # No tailnet: the loopback is the only locator the hub's own agent gets.
    assert "install --hub http://127.0.0.1:3000 --code {CODE};" in body["commands"]["linux"]
    assert body["commands_reason"] is None


@requires_db
async def test_the_manifests_commands_download_from_novas_address(
    client, dist, monkeypatch, tmp_path
):
    _tailnet(tmp_path, monkeypatch)
    body = (await client.get("/api/v1/agent/manifest")).json()
    assert set(body["commands"]) == {"linux", "macos", "windows"}
    for os_key, command in body["commands"].items():
        assert f"{NOVA}/api/v1/agent/dist/novad-" in command, os_key
        assert f"install --hub {NOVA} --code {{CODE}}" in command, os_key
        assert "127.0.0.1" not in command, os_key
    assert body["commands_reason"] is None
    assert body["walks"] == platform_walks.statuses() and body["notes"] == agent_card.notes()


@requires_db
async def test_the_hub_machines_command_tries_its_loopback_then_the_tailnet(
    client, dist, monkeypatch, tmp_path
):
    """?origin=loopback (F9): the command for the machine running the stack —
    a WSL hub's Windows side — downloads through the hub's own door and is
    given the tailnet after it, so that PC's agent reads Hub."""
    _tailnet(tmp_path, monkeypatch)
    body = (await client.get("/api/v1/agent/manifest?origin=loopback")).json()
    for os_key, command in body["commands"].items():
        assert "http://127.0.0.1:3000/api/v1/agent/dist/novad-" in command, os_key
        assert f"install --hub http://127.0.0.1:3000 --hub {NOVA} --code {{CODE}}" in command, (
            os_key
        )


_READER_OPENS = "manifest_reader() {\n  cat <<'PY'\n"


def _install_manifest_reader() -> str:
    """The program ./install hands core's Python to read the served manifest
    (deploy/install.sh, manifest_reader): the text of its one heredoc."""
    script = (Path(__file__).resolve().parents[3] / "deploy" / "install.sh").read_text()
    start = script.index(_READER_OPENS) + len(_READER_OPENS)
    return script[start : script.index("\nPY\n}", start)]


@requires_db
async def test_installs_reader_reads_the_manifest_core_really_serves(
    client, dist, monkeypatch, tmp_path
):
    """./install reads the served manifest with a JSON parser, never a pattern
    over its text (S42b Task 27, C3). Its cases feed that reader manifests
    written by hand; this feeds it the body this route really sends, so a key
    it reads that core renames or moves goes red here, not on a hub."""
    _tailnet(tmp_path, monkeypatch)
    raw = (await client.get("/api/v1/agent/manifest?origin=loopback")).content
    program = _install_manifest_reader()

    def read(*ask: str) -> tuple[int, str]:
        done = subprocess.run(
            [sys.executable, "-c", program, *ask], input=raw, capture_output=True, timeout=30
        )
        return done.returncode, done.stdout.decode().rstrip("\n")

    assert read("version") == (0, VERSION)
    files = _manifest_of(dist)["files"]
    for goos, arch in agent_dist.TARGETS:
        key, name = agent_dist.file_key(goos, arch), agent_dist.file_name(goos, arch)
        assert read("sha256", key, name) == (0, files[key]["sha256"]), key
    windows = json.loads(raw)["commands"]["windows"]
    assert "--hub http://127.0.0.1:3000" in windows and "{CODE}" in windows
    assert read("windows") == (0, windows)


@requires_db
async def test_with_no_address_the_manifest_says_why_there_is_no_command(
    client, dist, monkeypatch, tmp_path
):
    monkeypatch.setenv(network.STATUS_FILE_ENV, str(tmp_path / "absent.json"))
    resp = await client.get("/api/v1/agent/manifest")
    assert resp.status_code == 200
    body = resp.json()
    assert body["commands"] is None and body["commands_reason"] == network.NO_FILE
    assert body["version"] == VERSION and set(body["walks"]) == {"linux", "macos", "windows"}
    assert set(body) >= {"manifest", "sig"}


@requires_db
async def test_an_origin_the_manifest_does_not_know_is_refused(client, dist):
    resp = await client.get("/api/v1/agent/manifest?origin=lan")
    assert resp.status_code == 400 and "loopback" in resp.json()["error"]


@requires_db
async def test_the_manifest_signs_the_very_build_it_describes(
    client, dist, pool, monkeypatch, tmp_path
):
    """Sign the build you read, once (Task 18's carry): the route reads the
    build ONE time and signs exactly that Build. A second read could find
    /dist/current flipped to another build, and the signed manifest would
    then name one build while the version and the commands beside it name
    another."""
    _tailnet(tmp_path, monkeypatch)
    first = agent_dist.current()
    other = agent_dist.Build(
        version="bbbbbbbbbbbb",
        built_at=first.built_at,
        go=first.go,
        files={key: {**entry, "sha256": "b" * 64} for key, entry in first.files.items()},
    )
    reads: list = []

    async def flipping() -> agent_dist.Build:
        reads.append(1)
        return first if len(reads) == 1 else other

    monkeypatch.setattr(agent_dist, "read", flipping)
    body = (await client.get("/api/v1/agent/manifest")).json()
    assert len(reads) == 1
    assert body["version"] == body["manifest"]["version"] == VERSION
    assert envelopes.verify(await devices.core_public_key_hex(pool), body["manifest"], body["sig"])
    for os_key, goos in (("linux", "linux"), ("macos", "darwin"), ("windows", "windows")):
        for arch in ("amd64", "arm64"):
            assert body["manifest"]["files"][f"{goos}-{arch}"]["sha256"] in body["commands"][os_key]
    assert "b" * 64 not in json.dumps(body)
