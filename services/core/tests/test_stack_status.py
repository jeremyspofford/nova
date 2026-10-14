"""S32.3 T12: stack_status — each service's running SHA and content hash,
from the containers' labels, against main's head (docs/plans/rebuild/s32/
spec.md §5.4, §6).

One `docker ps` through the repo machine's agent reads the containers'
compose and nova.* labels; only this checkout's stack (compose working_dir
== <checkout>/deploy) is read. Main's head is the checkout's origin/<main>
as last fetched, and a service's main hash is the git tree hash of its
source path there — install.sh's content hash of a clean tree. Real git in
tmp, a FAKE `docker` first on PATH; no container is touched.

Criteria:
  C6 Per service (core, gateway, memory, web): "same as main" only when its
     container is running, carries a non-empty nova.content-hash and it
     equals main's tree hash; differs names both hashes; no container is
     "not running"; a stopped container names its state; an empty label is
     "no nova.content-hash label"; a path main lacks is "main has no ...";
     the build SHA is named (main's head when equal); a summary count.
  C7 Only this checkout's stack is read: another project's containers never
     count, and when none match the other working dirs are named; docker or
     git failing is an Error in its words; a malformed or cut docker
     listing refuses.
  C8 SERVICE_SOURCES is install.sh's service_source_paths over
     SERVICE_BUILDS; the tool is a read with no parameters.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import tools
from app.landing_git import Ran
from app.tools import landing as landing_tools
from app.tools.base import RESULT_KIND_LISTING, ToolFailure
from tests import test_repo_land as _land
from tests.conftest import requires_db
from tests.test_devices_ws import _close, _person
from tests.test_repo_land import Agent, RealRunner, _ctx, _git, _serve, _turn
from tests.test_start_change import _connect

pytestmark = requires_db

repo = _land.repo

INSTALL_SH = Path(__file__).resolve().parents[3] / "deploy" / "install.sh"

FAKE_DOCKER = """\
import json, os, sys
with open(os.environ["FAKE_DOCKER_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:2] != ["ps"]:
    print("fake docker: only `ps` is expected", file=sys.stderr)
    sys.exit(2)
code = int(os.environ.get("FAKE_DOCKER_EXIT", "0"))
with open(os.environ["FAKE_DOCKER_OUT"]) as f:
    out = f.read()
(sys.stderr if code else sys.stdout).write(out)
sys.exit(code)
"""

FIELDS = (
    '{{.Label "com.docker.compose.service"}}',
    '{{.Label "com.docker.compose.project.working_dir"}}',
    "{{.State}}",
    '{{.Label "nova.build-sha"}}',
    '{{.Label "nova.content-hash"}}',
    "{{.Names}}",
)


class Docker:
    def __init__(self, tmp_path: Path, monkeypatch) -> None:
        bin_dir = tmp_path / "docker-bin"
        bin_dir.mkdir()
        exe = bin_dir / "docker"
        exe.write_text(f"#!{sys.executable}\n{FAKE_DOCKER}")
        exe.chmod(0o755)
        monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
        self.out = tmp_path / "docker.out"
        self.out.write_text("")
        self.log = tmp_path / "docker.log"
        monkeypatch.setenv("FAKE_DOCKER_OUT", str(self.out))
        monkeypatch.setenv("FAKE_DOCKER_LOG", str(self.log))
        self.monkeypatch = monkeypatch

    def containers(self, *rows: tuple[str, ...]) -> None:
        self.out.write_text("".join("\t".join(row) + "\n" for row in rows))

    def fail(self, words: str, code: int = 1) -> None:
        self.out.write_text(words)
        self.monkeypatch.setenv("FAKE_DOCKER_EXIT", str(code))

    def calls(self) -> list[list[str]]:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines() if line]


@pytest.fixture
def docker(tmp_path, monkeypatch) -> Docker:
    return Docker(tmp_path, monkeypatch)


@pytest.fixture
def stack(repo):
    """Main holds every service's source; returns (main sha, {svc: tree})."""
    repo.push_main(
        {
            "services/gateway/g.py": "G = 1\n",
            "services/memory/m.py": "M = 1\n",
            "apps/web/index.html": "<p>web</p>\n",
        },
        "every service",
    )
    _git(repo.checkout, "fetch", "-q", "origin")
    main = _git(repo.checkout, "rev-parse", "origin/main")
    trees = {
        svc: _git(repo.checkout, "rev-parse", f"{main}:{path}")
        for svc, path in landing_tools.SERVICE_SOURCES.items()
    }
    return main, trees


@pytest.fixture
def registered(monkeypatch):
    monkeypatch.setitem(tools.REGISTRY, landing_tools.STACK_STATUS, landing_tools.STACK_STATUS_TOOL)


def _deploy(repo) -> str:
    return f"{repo.checkout}/deploy"


def _row(repo, svc, *, state="running", sha="", content="", where=None, name=None):
    return (svc, where or _deploy(repo), state, sha, content, name or f"nova-{svc}-1")


async def _dispatch(pool):
    device, conn, task = await _connect(pool)
    agent = Agent()
    await _person(pool)
    turn = await _turn(pool)
    server = asyncio.create_task(_serve(conn, device, agent))
    try:
        result, ok = await asyncio.wait_for(
            tools.dispatch(landing_tools.STACK_STATUS, {}, _ctx(turn, [])), 30
        )
    finally:
        server.cancel()
        await _close(conn, task)
    return result, ok, agent


def _line(result: str, svc: str) -> str:
    lines = [line for line in result.splitlines() if line.startswith(f"- {svc} ")]
    assert len(lines) == 1, (svc, result)
    return lines[0]


def _all_on_main(repo, main, trees):
    return [_row(repo, svc, sha=main, content=trees[svc]) for svc in landing_tools.SERVICE_SOURCES]


# -- C6: each service against main ---------------------------------------------------


async def test_c6_every_service_on_mains_source_is_same(pool, repo, registered, docker, stack):
    main, trees = stack
    docker.containers(*_all_on_main(repo, main, trees))
    result, ok, _agent = await _dispatch(pool)
    assert ok is True, result
    assert main in result
    for svc in landing_tools.SERVICE_SOURCES:
        line = _line(result, svc)
        assert line.endswith("same as main"), line
        assert "running" in line and "main's head" in line
        assert trees[svc][:12] in line
    assert "4 of 4 services run main's source" in result


async def test_c6_a_differing_hash_names_both(pool, repo, registered, docker, stack):
    main, trees = stack
    # A core built before main's last core edit.
    old = trees["core"]
    repo.push_main({"services/core/app/x.py": "A = 9\n"}, "core moved on")
    _git(repo.checkout, "fetch", "-q", "origin")
    main = _git(repo.checkout, "rev-parse", "origin/main")
    trees = {**trees, "core": _git(repo.checkout, "rev-parse", f"{main}:services/core")}
    assert old != trees["core"]
    rows = _all_on_main(repo, main, trees)
    rows[0] = _row(repo, "core", sha=repo.main_before, content=old)
    docker.containers(*rows)
    result, ok, _agent = await _dispatch(pool)
    assert ok is True, result
    line = _line(result, "core")
    assert "differs from main" in line
    assert old[:12] in line and trees["core"][:12] in line
    assert f"built from {repo.main_before[:12]}" in line
    assert "main's head" not in line
    assert "same as main" not in line
    assert "3 of 4 services run main's source" in result


async def test_c6_a_service_with_no_container_is_not_running(pool, repo, registered, docker, stack):
    main, trees = stack
    docker.containers(*[r for r in _all_on_main(repo, main, trees) if r[0] != "gateway"])
    result, ok, _agent = await _dispatch(pool)
    assert ok is True, result
    line = _line(result, "gateway")
    assert "not running" in line and "same as main" not in line
    assert "3 of 4" in result


async def test_c6_a_stopped_container_names_its_state(pool, repo, registered, docker, stack):
    main, trees = stack
    rows = _all_on_main(repo, main, trees)
    rows[2] = _row(repo, "memory", state="exited", sha=main, content=trees["memory"])
    docker.containers(*rows)
    result, ok, _agent = await _dispatch(pool)
    assert ok is True, result
    line = _line(result, "memory")
    assert "exited" in line and "not running" in line
    assert "same as main" not in line
    assert "3 of 4" in result


async def test_c6_an_empty_label_is_no_content_hash(pool, repo, registered, docker, stack):
    main, trees = stack
    rows = _all_on_main(repo, main, trees)
    rows[3] = _row(repo, "web", sha="", content="")
    docker.containers(*rows)
    result, ok, _agent = await _dispatch(pool)
    assert ok is True, result
    line = _line(result, "web")
    assert "no nova.content-hash label" in line
    assert "no nova.build-sha label" in line
    assert "same as main" not in line
    assert "3 of 4" in result


async def test_c6_a_path_main_lacks_is_said(pool, repo, registered, docker):
    # Main holds only services/core (the repo fixture, no `stack`).
    main = _git(repo.checkout, "rev-parse", "origin/main")
    core = _git(repo.checkout, "rev-parse", f"{main}:services/core")
    docker.containers(
        _row(repo, "core", sha=main, content=core),
        _row(repo, "web", sha=main, content="f" * 40),
    )
    result, ok, _agent = await _dispatch(pool)
    assert ok is True, result
    assert _line(result, "core").endswith("same as main")
    web = _line(result, "web")
    assert "main has no apps/web" in web and "same as main" not in web
    assert "1 of 4" in result


async def test_c6_several_containers_of_one_service_are_each_named(
    pool, repo, registered, docker, stack
):
    main, trees = stack
    rows = _all_on_main(repo, main, trees)
    rows.append(_row(repo, "core", state="exited", sha=main, content="e" * 40, name="old-core"))
    docker.containers(*rows)
    result, ok, _agent = await _dispatch(pool)
    assert ok is True, result
    core = [line for line in result.splitlines() if line.startswith("- core ")]
    assert len(core) == 2
    assert any("nova-core-1" in line and line.endswith("same as main") for line in core)
    assert any("old-core" in line and "exited" in line for line in core)
    # A service counts once, and only when a running container is on main.
    assert "4 of 4" in result


# -- C7: only this stack; failures stated ------------------------------------------------


async def test_c7_another_projects_containers_are_never_the_stacks(
    pool, repo, registered, docker, stack
):
    main, trees = stack
    rows = [r for r in _all_on_main(repo, main, trees) if r[0] != "core"]
    rows.append(
        _row(repo, "core", sha=main, content=trees["core"], where="/elsewhere/deploy", name="e2e")
    )
    docker.containers(*rows)
    result, ok, _agent = await _dispatch(pool)
    assert ok is True, result
    core = _line(result, "core")
    assert "not running" in core and "e2e" not in core
    assert "3 of 4" in result


async def test_c7_when_no_container_matches_the_other_dirs_are_named(
    pool, repo, registered, docker, stack
):
    main, trees = stack
    docker.containers(
        _row(repo, "core", sha=main, content=trees["core"], where="/elsewhere/deploy"),
        _row(repo, "web", sha=main, content=trees["web"], where="/other/deploy"),
    )
    result, ok, _agent = await _dispatch(pool)
    assert ok is True, result
    assert f"No container of this checkout's stack ({_deploy(repo)})" in result
    assert "/elsewhere/deploy" in result and "/other/deploy" in result
    assert "0 of 4" in result


async def test_c7_the_docker_command_reads_labels_and_working_dir(
    pool, repo, registered, docker, stack
):
    main, trees = stack
    docker.containers(*_all_on_main(repo, main, trees))
    result, ok, agent = await _dispatch(pool)
    assert ok is True, result
    (call,) = docker.calls()
    assert call[:2] == ["ps", "--all"]
    assert "--filter" in call
    assert call[call.index("--filter") + 1] == "label=com.docker.compose.service"
    assert call[call.index("--format") + 1] == "\t".join(FIELDS)
    # Through the agent's shell.exec, on the host.
    assert any(e["args"]["argv"][0] == "docker" for e in agent.seen)


async def test_c7_docker_failing_is_an_error_in_its_words(pool, repo, registered, docker, stack):
    docker.fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n")
    result, ok, _agent = await _dispatch(pool)
    assert ok is False, result
    assert "Cannot connect to the Docker daemon" in result
    assert "same as main" not in result


async def test_c7_main_unreadable_is_an_error(pool, repo, registered, docker, stack):
    main, trees = stack
    docker.containers(*_all_on_main(repo, main, trees))
    _git(repo.checkout, "update-ref", "-d", "refs/remotes/origin/main")
    result, ok, _agent = await _dispatch(pool)
    assert ok is False, result
    assert "origin/main" in result and "exited" in result
    assert "same as main" not in result


async def test_c7_a_malformed_docker_line_refuses(pool, repo, registered, docker, stack):
    main, trees = stack
    rows = _all_on_main(repo, main, trees)
    docker.out.write_text("\t".join(rows[0]) + "\n" + "core\tonly-two\n")
    result, ok, _agent = await _dispatch(pool)
    assert ok is False, result
    assert "core\\tonly-two" in result or "'core\\tonly-two'" in result
    assert "same as main" not in result


async def test_c7_a_cut_docker_listing_refuses(repo, docker, stack):
    main, trees = stack
    docker.containers(*_all_on_main(repo, main, trees))
    inner = RealRunner()

    async def cutting(argv: list[str]) -> Ran:
        ran = await inner(argv)
        if argv[0] == "docker":
            return Ran(exit=ran.exit, output=ran.output, truncated=True)
        return ran

    with pytest.raises(ToolFailure, match="not complete"):
        await landing_tools.stack_text(cutting, checkout=str(repo.checkout), main="main")


# -- C8: parity and the tool ----------------------------------------------------------


def _install_sh(snippet: str) -> str:
    """Run install.sh's own definitions (extracted, not the script) in bash."""
    text = INSTALL_SH.read_text()
    start = text.index("service_source_paths() {")
    end = text.index("\n}\n", start) + 3
    builds = next(line for line in text.splitlines() if line.startswith("SERVICE_BUILDS="))
    script = f"{text[start:end]}\n{builds}\n{snippet}\n"
    done = subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=True)
    return done.stdout


def test_c8_service_sources_are_install_shs():
    order = _install_sh('printf "%s\\n" $SERVICE_BUILDS').split()
    assert list(landing_tools.SERVICE_SOURCES) == order
    for svc in order:
        paths = _install_sh(f"service_source_paths {svc}").split()
        assert paths == [landing_tools.SERVICE_SOURCES[svc]], svc


def test_c8_the_deploy_dir_holds_the_stacks_compose_file():
    root = INSTALL_SH.parents[1]
    assert (root / landing_tools.DEPLOY_DIR / "docker-compose.yml").is_file()
    assert INSTALL_SH.parent.name == landing_tools.DEPLOY_DIR


def test_c8_stack_status_is_a_read():
    tool = landing_tools.STACK_STATUS_TOOL
    assert tool.name == "stack_status"
    assert tool.reads_only is True
    assert tool.ephemeral is True
    assert tool.result_kind == RESULT_KIND_LISTING
    assert tool.parameters == {"type": "object", "properties": {}, "additionalProperties": False}
    assert "main" in tool.description and "content hash" in tool.description
