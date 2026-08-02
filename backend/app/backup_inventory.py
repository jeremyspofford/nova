"""Reading this stack's real persistent state (roadmap #31, phase 1).

The adapters for `backup_coverage`, kept separate so the decision table can
be tested with no docker, no git and no running stack — and so the messy
part, which is genuinely environment-specific, is isolated where it can be
argued with.

Everything here is READ-ONLY: `docker compose config`, `docker ps -a`,
`git ls-files`/`check-ignore`. Nothing starts, stops, writes or dumps.

Two inventory sources, unioned, because each has a blind spot the other
covers and BOTH were measured on 2026-08-02:

  * `docker compose config` sees services that are DOWN — four were, and one
    of them owns `tailscale_state`, the tailnet node's private key. A
    running-container enumeration would have dropped it silently.
  * live container mounts see anonymous and image-declared volumes, which
    never appear in a compose file at all.

Deliberately NOT used as a source, having been measured and rejected:
`docker volume ls --filter label=com.docker.compose.project=nova`. It misses
`nova_postgres_data` — the volume predates compose labelling volumes and its
labels are null — while including `nova_ollama-data`, a stale volume no
compose file references. A backup derived from it omits the database and
reports success, which is the exact failure mode this lane exists to remove.
"""

import json
import logging
import os
import re
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)


def _git(root: str, *args: str) -> list[str]:
    """A git invocation that works on a repo the container does not own.

    The project is bind-mounted from the host user's checkout while this
    process runs as root, so git's dubious-ownership guard refuses. Scoped to
    this one directory per call rather than set globally in the image: the
    guard exists for a reason, and disabling it everywhere to satisfy one
    read is how it stops protecting anything.
    """
    return ["git", "-c", f"safe.directory={root}", *args]


def _run(args: list[str], cwd: str) -> str:
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        raise RuntimeError(f"{' '.join(args[:3])} failed: {p.stderr.strip()[:300]}")
    return p.stdout


def from_compose(project_dir: str, profiles: list[str]) -> list[dict]:
    """Every bind and named volume the project DECLARES, all profiles.

    `--profiles` is not optional: a profile-gated service that is switched
    off still owns its volume, and its data does not become less precious
    for the service being down.
    """
    args = ["docker", "compose"]
    for p in profiles:
        args += ["--profile", p]
    args += ["config", "--format", "json"]
    cfg = json.loads(_run(args, project_dir))
    out: list[dict] = []
    for svc_name, svc in (cfg.get("services") or {}).items():
        for vol in svc.get("volumes") or []:
            src, typ = vol.get("source"), vol.get("type")
            if not src:
                continue          # anonymous; the container source catches it
            out.append({"kind": "bind" if typ == "bind" else "volume",
                        "name": src, "source": "compose",
                        "service": svc_name, "mounted_at": vol.get("target"),
                        "project": cfg.get("name", "")})
    return out


_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


def _expand(value: str) -> str:
    """Expand ${VAR} / ${VAR:-default} from THIS process's environment.

    The default is used only when the variable is genuinely absent from the
    environment — which for the memory store means the operator never set
    NOVA_MEMORY_DIR and ./data/memory really is where it lives. When the
    variable IS set, its value wins, so pointing memory at a NAS does not
    silently snapshot the local default instead. Anything still unexpanded
    after this reaches backup_coverage and refuses there.
    """
    def sub(m):
        name, default = m.group(1), m.group(2)
        return os.environ.get(name, default if default is not None else m.group(0))
    return _VAR.sub(sub, value)


def from_compose_file(project_dir: str) -> list[dict]:
    """The same inventory, by READING docker-compose.yml instead of asking
    docker for it.

    The backend has no docker CLI and must never hold the socket — only
    `inference-control` does, deliberately, because the socket is
    root-equivalent on the host. So inside the container the compose file is
    parsed directly.

    This is weaker than `docker compose config` in one way and stronger in
    another. Weaker: no profile merging, no variable expansion, no override
    files. Stronger: an unexpanded ${VAR} survives into the entry and
    `backup_coverage` REFUSES on it, where the CLI would silently apply the
    compose default and snapshot the wrong directory.
    """
    import yaml
    root = Path(project_dir)
    cfg = yaml.safe_load((root / "docker-compose.yml").read_text()) or {}
    project = cfg.get("name", "")
    out: list[dict] = []
    for svc_name, svc in (cfg.get("services") or {}).items():
        for vol in svc.get("volumes") or []:
            if isinstance(vol, str):
                # EXPAND BEFORE SPLITTING. `${NOVA_MEMORY_DIR:-./data/memory}`
                # contains a colon, so splitting first mangles the source into
                # `${NOVA_MEMORY_DIR` — which then reads as an unclassifiable
                # path and refuses, taking the memory tree out of every
                # bundle. Measured: it did exactly that.
                parts = _expand(vol).split(":")
                src, target = parts[0], (parts[1] if len(parts) > 1 else "")
            elif isinstance(vol, dict):
                src, target = vol.get("source", ""), vol.get("target", "")
            else:
                continue
            if not src:
                continue
            is_bind = src.startswith((".", "/", "$")) or "${" in src
            name = str((root / src).resolve()) if is_bind and not src.startswith("$") else src
            out.append({"kind": "bind" if is_bind else "volume",
                        "name": name, "source": "compose-file",
                        "service": svc_name, "mounted_at": target,
                        "project": project})
    # named volumes declared but attached to no service still hold data
    for vol_name in (cfg.get("volumes") or {}):
        out.append({"kind": "volume", "name": vol_name,
                    "source": "compose-file", "service": None,
                    "mounted_at": None, "project": project})
    return out


def from_containers(project: str) -> list[dict]:
    """Live mounts of every container in the project, INCLUDING exited ones.

    A container that crashed still names the volume it was using, and that
    volume still holds data.
    """
    ids = _run(["docker", "ps", "-a", "--filter",
                f"label=com.docker.compose.project={project}",
                "--format", "{{.ID}}"], ".").split()
    if not ids:
        return []
    raw = _run(["docker", "inspect", *ids], ".")
    out: list[dict] = []
    for c in json.loads(raw):
        svc = (c.get("Config", {}).get("Labels", {})
               .get("com.docker.compose.service"))
        for m in c.get("Mounts") or []:
            if m.get("Type") == "volume":
                out.append({"kind": "volume", "name": m.get("Name", ""),
                            "source": "container", "service": svc,
                            "mounted_at": m.get("Destination"),
                            "project": project})
            # Bind SOURCES from `docker inspect` are not usable here: on this
            # machine they render as
            # /run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/... which
            # does not exist on the host. Compose is the honest source for
            # binds; containers are only consulted for volumes.
    return out


def git_status_fn(project_dir: str):
    """tracked / ignored / unknown for a host path, from git itself."""
    root = Path(project_dir).resolve()

    def status(path: str) -> str:
        p = Path(path)
        if not p.is_absolute():
            p = (root / path).resolve()
        try:
            p.relative_to(root)
        except ValueError:
            return "unknown"       # outside the repo; git has no opinion
        rel = str(p.relative_to(root))
        chk = subprocess.run(_git(str(root), "check-ignore", "-q", rel),
                             cwd=str(root), capture_output=True)
        if chk.returncode == 0:
            return "ignored"
        ls = subprocess.run(_git(str(root), "ls-files", "--error-unmatch", rel),
                            cwd=str(root), capture_output=True)
        if ls.returncode == 0:
            return "tracked"
        # a directory is never "tracked" by ls-files; ask whether it holds
        # tracked files instead
        any_tracked = subprocess.run(_git(str(root), "ls-files", rel),
                                     cwd=str(root), capture_output=True, text=True)
        return "tracked" if any_tracked.stdout.strip() else "unknown"

    return status


def ignored_top_level(project_dir: str) -> list[str]:
    """Gitignored paths in the project that nothing may have mounted.

    This is how `.env` — the Postgres password and the auth token, mounted by
    no container — becomes visible to a system whose other signals are all
    derived from docker.
    """
    root = Path(project_dir).resolve()
    out = []
    raw = _run(_git(str(root), "status", "--porcelain", "--ignored=matching", "-z"),
               str(root))
    for item in raw.split("\0"):
        if not item.startswith("!! "):
            continue
        rel = item[3:].rstrip("/")
        if not rel or rel.startswith(".worktrees"):
            continue              # our own scratch checkouts are not state
        out.append(str(root / rel))
    return out


def collect(project_dir: str, project: str = "nova",
            profiles: tuple[str, ...] = ("coder", "inference", "media",
                                         "notify", "tailscale", "voice")) -> dict:
    """The full, derived coverage answer for a real stack."""
    from app import backup_coverage as bc
    inventory = from_compose(project_dir, list(profiles))
    try:
        inventory += from_containers(project)
    except Exception:
        # A missing docker socket is a real limitation, not a reason to
        # produce a narrower answer silently — it costs the anonymous-volume
        # blind spot, so say so rather than shrinking the universe quietly.
        log.warning("live container mounts unavailable; inventory is "
                    "compose-only and cannot see anonymous volumes",
                    exc_info=True)
    return bc.report(inventory,
                     project_dir=project_dir,
                     git_status=git_status_fn(project_dir),
                     ignored_paths=ignored_top_level(project_dir),
                     readable=lambda p: os.path.exists(p))
