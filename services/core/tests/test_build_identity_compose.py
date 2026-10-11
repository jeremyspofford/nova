"""Build identity as deployed (S32.1), pinned from the files a human edits.

Each of the four built services names its image by the content hash ./install
recorded (nova-<svc>:h-<hash>), so an unchanged service keeps its image and is
not recreated, and the previous build stays for S33's rollback; the commit and
the hash are handed to the build as args. And no bind mount anywhere resolves
from compose's project directory: every host path is rooted at the checkout
./install recorded (NOVA_CHECKOUT), and a render without it fails loudly.

Read the way test_browser_compose.py reads deploy/: from the file, so a hand
edit that drops one goes red here.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[3]
COMPOSE = yaml.safe_load((ROOT / "deploy" / "docker-compose.yml").read_text())
ENV_EXAMPLE = (ROOT / "deploy" / ".env.example").read_text()
ISOLATED = ROOT / "tests" / "e2e" / "isolated.sh"

BUILT = {
    "core": "../services/core",
    "gateway": "../services/gateway",
    "memory": "../services/memory",
    "web": "../apps/web",
}
CHECKOUT = "${NOVA_CHECKOUT:?NOVA_CHECKOUT is unset - run ./install}"

# The five host paths the stack mounts, by service and target, and where each
# must resolve from. The backup rows (x-nova-backup) ride on the same mount.
BINDS = {
    ("postgres", "/docker-entrypoint-initdb.d"): ("/deploy/postgres-init", "exclude-code"),
    ("agent-dist", "/build"): ("/deploy/agent-dist", "exclude-code"),
    ("gateway", "/data"): ("/data", "exclude-derived"),
    ("searxng", "/etc/searxng"): ("/searxng", "exclude-code"),
    ("tailscale", "/config"): ("/deploy/tailscale", "exclude-code"),
}


def _service(name: str) -> dict:
    return COMPOSE["services"][name]


def _host_mounts(service: dict) -> list[tuple[str, dict | str]]:
    """(source, mount) for every mount of `service` that names a host path:
    a long-syntax `type: bind`, or a short-syntax entry whose source is a
    path rather than a volume name."""
    found = []
    for mount in service.get("volumes") or []:
        if isinstance(mount, dict):
            if mount.get("type") == "bind":
                found.append((str(mount.get("source", "")), mount))
            continue
        source = str(mount).split(":", 1)[0]
        if source.startswith((".", "/", "~", "$")):
            found.append((source, mount))
    return found


@pytest.mark.parametrize("svc", sorted(BUILT))
def test_each_built_service_is_tagged_by_its_content_hash(svc):
    key = f"NOVA_HASH_{svc.upper()}"
    assert _service(svc).get("image") == f"nova-{svc}:h-${{{key}:-unhashed}}"


@pytest.mark.parametrize("svc", sorted(BUILT))
def test_each_built_service_gets_the_commit_and_its_hash_as_build_args(svc):
    build = _service(svc)["build"]
    assert build["context"] == BUILT[svc]
    assert build.get("args") == {
        "NOVA_BUILD_SHA": "${NOVA_COMMIT:-}",
        "NOVA_CONTENT_HASH": f"${{NOVA_HASH_{svc.upper()}:-}}",
    }


def test_no_service_mounts_a_host_path_relative_to_the_project_directory():
    # Derived over every service in the file: a sixth bind added later with a
    # relative source fails here without anyone remembering to list it.
    relative = []
    for name, service in COMPOSE["services"].items():
        for source, _ in _host_mounts(service):
            if not source.startswith("${NOVA_CHECKOUT"):
                relative.append(f"{name}: {source}")
    assert not relative, relative


@pytest.mark.parametrize("where", sorted(BINDS), ids=lambda w: f"{w[0]}:{w[1]}")
def test_each_bind_resolves_from_the_recorded_checkout(where):
    svc, target = where
    tail, disposition = BINDS[where]
    mounts = [
        m
        for _, m in _host_mounts(_service(svc))
        if isinstance(m, dict) and m.get("target") == target
    ]
    assert len(mounts) == 1, f"{svc} has {len(mounts)} host mounts at {target}"
    mount = mounts[0]
    # The :? form, so a render without NOVA_CHECKOUT dies naming it rather than
    # binding "/deploy/postgres-init" at the filesystem root.
    assert mount["source"] == CHECKOUT + tail
    assert mount["read_only"] is True
    assert mount["x-nova-backup"] == disposition
    assert mount["x-nova-backup-reason"].strip()


def test_the_host_mount_census_is_exactly_the_five():
    seen = {
        (name, m["target"] if isinstance(m, dict) else str(m).split(":")[1])
        for name, service in COMPOSE["services"].items()
        for _, m in _host_mounts(service)
    }
    assert seen == set(BINDS)


@pytest.mark.parametrize("svc", sorted(BUILT))
def test_each_hash_key_is_declared_host_local_in_the_example(svc):
    # Without a `# nova-backup:` line the first ./install backup after T2 wrote
    # the key refuses (deploy/backup/tests/test_policy.py). `host`: the target
    # machine's installer computes its own from its own checkout.
    key = f"NOVA_HASH_{svc.upper()}"
    assert f"# nova-backup: host\n# {key}=\n" in ENV_EXAMPLE


@pytest.mark.parametrize("caller", ["/somewhere/else", None], ids=["stale", "absent"])
def test_the_installer_hands_every_compose_call_the_checkout_path(tmp_path, caller):
    # Every compose render ./install makes before record_build writes .env on a
    # first install (refuse_if_moved, decide_tailnet) must still render: the
    # value has to reach a CHILD process (compose), not just the shell, and a
    # stale value in the caller's environment must not win.
    probe = tmp_path / "probe.sh"
    probe.write_text('. "$1"; sh -c \'printf "%s" "${NOVA_CHECKOUT-<unset>}"\'\n')
    env = {k: v for k, v in os.environ.items() if k != "NOVA_CHECKOUT"}
    if caller is not None:
        env["NOVA_CHECKOUT"] = caller
    out = subprocess.run(
        ["bash", str(probe), str(ROOT / "deploy" / "install.sh")],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout == str(ROOT)


# ── tests/e2e/isolated.sh: its own env, never the hub's ─────────────────────


def _isolated_world(tmp_path: Path) -> tuple[Path, Path, Path]:
    """A copy of isolated.sh in a throwaway tree, with a `docker` on PATH that
    records what compose would have been given instead of running it."""
    repo = tmp_path / "repo"
    script = repo / "tests" / "e2e" / "isolated.sh"
    script.parent.mkdir(parents=True)
    shutil.copy(ISOLATED, script)
    record = tmp_path / "docker.log"
    bindir = tmp_path / "bin"
    bindir.mkdir()
    fake = bindir / "docker"
    fake.write_text(
        "#!/bin/sh\n"
        f'{{ echo "argv: $*"; echo "env NOVA_CHECKOUT=${{NOVA_CHECKOUT-<unset>}}";'
        f' echo "env NOVA_HASH_CORE=${{NOVA_HASH_CORE-<unset>}}"; }} >> "{record}"\n'
    )
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    return repo, script, record


def _run_isolated(script: Path, tmp_path: Path, **extra: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "PATH": f"{tmp_path / 'bin'}{os.pathsep}{os.environ['PATH']}", **extra}
    return subprocess.run(
        ["bash", str(script), "dc", "config"], env=env, capture_output=True, text=True, check=False
    )


def _env_lines(repo: Path) -> list[str]:
    return (repo / "tests" / "e2e" / ".isolated" / ".env").read_text().splitlines()


def test_isolated_env_records_its_own_checkout(tmp_path):
    repo, script, record = _isolated_world(tmp_path)
    out = _run_isolated(script, tmp_path)
    assert out.returncode == 0, out.stderr
    assert f"NOVA_CHECKOUT={repo}" in _env_lines(repo)
    assert "--env-file" in record.read_text()


def test_isolated_env_written_before_this_gains_the_checkout_once(tmp_path):
    # `up` after `down` keeps the generated file, so one written before
    # NOVA_CHECKOUT existed has to gain it — once, secrets untouched.
    repo, script, _ = _isolated_world(tmp_path)
    env_file = repo / "tests" / "e2e" / ".isolated" / ".env"
    env_file.parent.mkdir(parents=True)
    env_file.write_text("POSTGRES_PASSWORD=kept\n")
    for _ in range(2):
        out = _run_isolated(script, tmp_path)
        assert out.returncode == 0, out.stderr
    lines = _env_lines(repo)
    assert "POSTGRES_PASSWORD=kept" in lines
    recorded = [line for line in lines if line.startswith("NOVA_CHECKOUT=")]
    assert recorded == [f"NOVA_CHECKOUT={repo}"]


def test_isolated_stack_never_takes_the_hubs_hashes(tmp_path):
    # A shell that exported the hub's NOVA_HASH_CORE (or NOVA_CHECKOUT) must
    # not tag the test stack's images as the hub's: compose prefers the shell
    # over --env-file, so the script has to drop them itself.
    repo, script, record = _isolated_world(tmp_path)
    out = _run_isolated(script, tmp_path, NOVA_HASH_CORE="a" * 40, NOVA_CHECKOUT="/hub/checkout")
    assert out.returncode == 0, out.stderr
    seen = record.read_text()
    assert "env NOVA_HASH_CORE=<unset>" in seen
    assert f"env NOVA_CHECKOUT={repo}" in seen


# --- T4: the Dockerfiles take the two args and bake them in ------------------
#
# Read as instructions (comments and blank lines dropped). The args land after
# the LAST RUN: a RUN that follows an ARG gets it in its environment, so a new
# commit would miss the cache on that layer (uv sync, useradd) every deploy.
# deploy/build_identity_test.sh builds the real images and reads them back.

PYTHON_SERVICES = ("core", "gateway", "memory")
CI = yaml.safe_load((ROOT / ".github" / "workflows" / "rebuild-ci.yml").read_text())


def _dockerfile(svc: str) -> list[str]:
    """Instructions of services/<svc>/Dockerfile, one per entry, with
    backslash continuations joined and whitespace collapsed."""
    joined = (ROOT / "services" / svc / "Dockerfile").read_text().replace("\\\n", " ")
    return [
        " ".join(line.split())
        for line in joined.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def _index(lines: list[str], instruction: str) -> int:
    assert instruction in lines, f"missing: {instruction}"
    return lines.index(instruction)


@pytest.mark.parametrize("svc", PYTHON_SERVICES)
def test_the_build_args_come_after_every_run_and_copy(svc):
    lines = _dockerfile(svc)
    sha = _index(lines, "ARG NOVA_BUILD_SHA=")
    content = _index(lines, "ARG NOVA_CONTENT_HASH=")
    first_arg = min(sha, content)
    assert _index(lines, "RUN uv sync --frozen --no-dev") < first_arg
    later = [line for line in lines[first_arg:] if line.startswith(("RUN", "COPY", "ADD"))]
    assert later == [], f"a layer after the build args misses the cache per commit: {later}"


@pytest.mark.parametrize("svc", PYTHON_SERVICES)
def test_the_build_args_reach_the_running_process_as_env(svc):
    lines = _dockerfile(svc)
    env = 'ENV NOVA_BUILD_SHA="$NOVA_BUILD_SHA" NOVA_CONTENT_HASH="$NOVA_CONTENT_HASH"'
    assert _index(lines, env) > _index(lines, "ARG NOVA_CONTENT_HASH=")
    assert _index(lines, env) > _index(lines, "ARG NOVA_BUILD_SHA=")


@pytest.mark.parametrize("svc", PYTHON_SERVICES)
def test_the_build_args_are_labels_on_the_image(svc):
    lines = _dockerfile(svc)
    label = 'LABEL nova.build-sha="$NOVA_BUILD_SHA" nova.content-hash="$NOVA_CONTENT_HASH"'
    assert _index(lines, label) > _index(lines, "ARG NOVA_CONTENT_HASH=")
    assert _index(lines, label) > _index(lines, "ARG NOVA_BUILD_SHA=")


def test_ci_builds_the_images_and_reads_their_identity_back():
    steps = CI["jobs"]["web"]["steps"]
    assert {"run": "bash ../../deploy/build_identity_test.sh"} in steps
    assert (ROOT / "deploy" / "build_identity_test.sh").is_file()


# ── T6: web's build identity (apps/web/Dockerfile, nginx.conf.template) ──
# The ARGs live in the final nginx stage, after every COPY: an ARG declared
# in the npm stage would rebuild the bundle per commit. The one RUN after them
# writes build.json (it must: the file IS the identity). gate_test.sh builds
# the real image and reads /build.json back; these pin the shape.

WEB = ROOT / "apps" / "web"


def _web_dockerfile() -> list[str]:
    joined = (WEB / "Dockerfile").read_text().replace("\\\n", " ")
    return [
        " ".join(line.split())
        for line in joined.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def test_web_build_args_sit_in_the_final_stage_after_every_copy():
    lines = _web_dockerfile()
    final_from = max(i for i, line in enumerate(lines) if line.startswith("FROM "))
    sha = _index(lines, "ARG NOVA_BUILD_SHA=")
    content = _index(lines, "ARG NOVA_CONTENT_HASH=")
    first_arg = min(sha, content)
    assert first_arg > final_from, "an identity ARG in the npm stage rebuilds the bundle per commit"
    assert _index(lines, "COPY --from=build /app/dist /usr/share/nginx/html") < first_arg
    later = [line for line in lines[first_arg:] if line.startswith(("COPY", "ADD"))]
    assert later == [], f"a COPY after the build args misses the cache per commit: {later}"
    runs = [line for line in lines[first_arg:] if line.startswith("RUN")]
    assert len(runs) == 1 and "/usr/share/nginx/html/build.json" in runs[0], runs


def test_web_build_args_are_labels_on_the_image():
    lines = _web_dockerfile()
    label = 'LABEL nova.build-sha="$NOVA_BUILD_SHA" nova.content-hash="$NOVA_CONTENT_HASH"'
    assert _index(lines, label) > _index(lines, "ARG NOVA_CONTENT_HASH=")
    assert _index(lines, label) > _index(lines, "ARG NOVA_BUILD_SHA=")


def _web_location(path: str) -> list[str]:
    text = (WEB / "nginx.conf.template").read_text()
    head = f"location = {path} {{"
    assert head in text, f"missing: {head}"
    body = text.split(head, 1)[1].split("}", 1)[0]
    return [" ".join(line.split()) for line in body.splitlines() if line.strip()]


def test_web_serves_build_json_gated_as_json_never_the_spa_fallback():
    body = _web_location("/build.json")
    assert "include /etc/nginx/gate/gate_check.conf;" in body
    assert "default_type application/json;" in body
    assert 'add_header Cache-Control "no-cache";' in body
    assert "try_files $uri =404;" in body
    assert not any("index.html" in line for line in body), body
