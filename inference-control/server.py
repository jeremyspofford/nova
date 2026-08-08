"""Nova inference-control sidecar — the only holder of the Docker socket.

The socket is root-equivalent on the host, so the backend never mounts it.
Instead this tiny service exposes a fixed set of endpoints on the
compose-internal network (no published ports):

    GET  /status     -> {present, running, state, op, error}
    GET  /gpu        -> {nvidia_runtime}   (docker info runtime check)
    GET  /vram       -> {gpus: [{name, vram_total_gb}]}   (nvidia-smi in ollama)
    GET  /gpu-stats  -> live GPU used/total VRAM, util %, temp (nvidia-smi)
    GET  /containers -> per-service state + live CPU/mem (docker ps + stats)
    GET  /disk       -> docker-managed disk sizes (docker system df) + store free
    POST /start      -> docker compose --profile inference up -d ollama
    POST /stop       -> docker compose --profile inference stop ollama

Nothing is parameterized by the request: the compose file, project, and
service name are baked in. A fully compromised client can at worst toggle
the bundled ollama on and off. Start/stop shell out to compose against the
mounted docker-compose.yml, so operator edits to the ollama service (e.g. a
GPU reservation block) are honored without duplicating config here.
"""

import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("inference-control")

COMPOSE_FILE = os.environ.get("COMPOSE_FILE", "/compose/docker-compose.yml")
GPU_COMPOSE_FILE = os.environ.get("GPU_COMPOSE_FILE",
                                  "/compose/docker-compose.gpu.yml")
MODELS_COMPOSE_FILE = os.environ.get("MODELS_COMPOSE_FILE",
                                     "/compose/docker-compose.models.yml")
# auto: merge the GPU override when the docker NVIDIA runtime exists;
# on/off force it either way (operator escape hatch for broken drivers)
OLLAMA_GPU = os.environ.get("OLLAMA_GPU", "auto").lower()
# Operator-chosen model-store path. Source of truth is /state/models_dir,
# written by the backend from the UI (Settings → Inference). NOVA_MODELS_DIR
# is the deployment-time fallback (the .env path). Read fresh on every use so
# a relocation takes effect without restarting this sidecar.
STATE_MODELS_FILE = os.environ.get("STATE_MODELS_FILE", "/state/models_dir")
# Nova-derived ntfy base-url (Settings-driven, written by the backend). Read
# fresh on every notify recreate so the self-hosted server's public URL always
# matches what the phone subscribes to — the iOS APNs relay hashes a sync-topic
# from it, so a mismatch silently breaks background push. Empty = leave the
# compose default.
STATE_NTFY_BASE_URL_FILE = os.environ.get("STATE_NTFY_BASE_URL_FILE", "/state/ntfy_base_url")
# Same handoff as the ntfy base-url: the backend owns the setting, writes it
# to the shared /state volume, and this sidecar reads it fresh at each start.
# The sidecar has no database and must never grow one.
STATE_HOME_TZ_FILE = os.environ.get("STATE_HOME_TZ_FILE", "/state/home_timezone")
PROJECT = os.environ.get("COMPOSE_PROJECT", "nova")
# Absolute path to the repo ON THE HOST, so relative bind mounts in the
# compose file resolve to the operator's real directories rather than to
# paths inside this container. See _compose_cmd.
HOST_ROOT = os.environ.get("NOVA_HOST_ROOT", "").strip()
# THIS container's view of the same repo (`.:/repo:ro`), which is what a build
# context has to be packaged from. See `_redeploy` for why the two cannot be
# one value.
REPO_ROOT = os.environ.get("NOVA_REPO_ROOT", "/repo").strip()
SERVICE = "ollama"                       # the toggle target (start/stop)
OLLAMA_TARGET = "/root/.ollama"          # where ollama keeps its store
PORT = 9911

# Every model-bearing service the store spans, and how to relocate each: the
# in-container store path, the subdir under $NOVA_MODELS_DIR it binds to, and
# the compose profile that owns it. A relocate migrates + rebinds each of these
# that is currently present (voice services only when the voice profile is up).
MANAGED = [
    {"service": "ollama",  "dest": "/root/.ollama", "sub": "ollama",  "profile": "inference"},
    {"service": "kokoro",  "dest": "/models",       "sub": "kokoro",  "profile": "voice"},
    {"service": "whisper", "dest": "/models",       "sub": "whisper", "profile": "voice"},
]


def _models_dir() -> str:
    """Effective absolute host path for the bundled model store, or "" for the
    default docker volume. UI setting (/state/models_dir) wins over the
    deployment NOVA_MODELS_DIR. Relative values are refused: compose runs from
    THIS sidecar's workdir, where a relative bind source resolves to the wrong
    host path — the default volume is the safe fallback."""
    try:
        with open(STATE_MODELS_FILE) as f:
            val = f.read().strip()   # file present = authoritative ("" = default)
    except OSError:
        val = os.environ.get("NOVA_MODELS_DIR", "").strip()   # deployment fallback
    return val if val.startswith("/") else ""


def _ntfy_base_url() -> str:
    """Operator/derived ntfy public URL (Settings → Notifications, written by the
    backend). Read fresh each recreate. Empty = keep the compose default."""
    try:
        with open(STATE_NTFY_BASE_URL_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


def _use_gpu_file() -> bool:
    if OLLAMA_GPU == "off" or not os.path.exists(GPU_COMPOSE_FILE):
        return False
    if OLLAMA_GPU == "on":
        return True
    try:
        return _gpu_info()["nvidia_runtime"]
    except Exception:
        return False


def _use_models_file() -> bool:
    """Merge the model-store relocation override when a model path is set."""
    return bool(_models_dir()) and os.path.exists(MODELS_COMPOSE_FILE)


def _compose_env() -> dict:
    """Environment for compose subprocesses: inject the current model path so
    docker-compose.models.yml interpolates ${NOVA_MODELS_DIR} to the live
    value, whether it came from the UI state file or the deployment env."""
    return {**os.environ, "NOVA_MODELS_DIR": _models_dir()}


def _env_file_args() -> list:
    """`--env-file`, pointing at the copy THIS container can read.

    Compose loads `.env` from `--project-directory`, and that directory is a
    HOST path that does not exist in here — so every `${VAR}` in the compose
    file interpolated to empty and compose said nothing, because a missing
    `.env` is not an error to it.

    MEASURED 2026-08-06, on the first real use of `/service/redeploy`: the
    coder sidecar was rebuilt and came back with `NOVA_CODER_TOKEN` unset, so
    the broker refused every request — "a token that defaults to off is not a
    control" working exactly as designed, against a container that had simply
    been recreated with its configuration silently removed. The ollama toggle
    has had the same defect since `--project-directory` was introduced; it went
    unnoticed only because that service block interpolates almost nothing.

    The repo is mounted read-only at `/repo`, so this file exists precisely
    when the operator's does, and passing it is the whole fix.
    """
    path = os.path.join(REPO_ROOT, ".env")
    return ["--env-file", path] if os.path.exists(path) else []


def _compose_cmd(profile: str = "inference") -> list:
    # --project-directory, and it is load-bearing. Compose resolves RELATIVE
    # bind mounts against the compose file's directory, which here is
    # `/compose` INSIDE this container. Every service this sidecar started
    # until 2026-08-05 used named volumes (ollama_models, ntfy_cache) so
    # nothing noticed; Home Assistant is the first with a relative bind, and
    # it came up mounted from `/compose/data/home-assistant` — a path in this
    # container's own filesystem. Its entire configuration would have been
    # deleted by the next `docker compose build inference-control`, silently,
    # and the backend could never have read it.
    #
    # Pointing the project directory at the real host root makes `./data/...`
    # in the compose file mean what it says in every other context.
    cmd = ["docker", "compose"]
    if HOST_ROOT:
        cmd += ["--project-directory", HOST_ROOT]
    cmd += _env_file_args()
    cmd += ["-f", COMPOSE_FILE]
    if _use_gpu_file():
        cmd += ["-f", GPU_COMPOSE_FILE]
    if _use_models_file():
        cmd += ["-f", MODELS_COMPOSE_FILE]
    return cmd + ["--profile", profile]

_lock = threading.Lock()
_op: dict = {"verb": None, "error": None}

# ONE SANDBOX RUN AT A TIME. Every run uses the same compose project name —
# `-p nova-sandbox`, which is the whole isolation mechanism — so two
# concurrent runs are two processes driving ONE stack: the first one's
# teardown removes the second's containers, and both report nonsense.
#
# Nova hit this by retrying a check three times after a transient error. The
# retries collided, each killed the others, and every attempt came back
# "server disconnected without sending a response" — an infrastructure
# symptom with a concurrency cause, which is the worst kind to debug.
#
# A separate lock from `_lock` on purpose: a sandbox run takes minutes and
# must not block an ollama toggle, and vice versa. Non-blocking, because a
# caller that waits ten minutes for a slot has no way to tell that from a
# hang — being told "one is already running" is actionable.
_sandbox_lock = threading.Lock()

#: Same argument, different resource: two `compose up` runs against the same
#: project race, and the loser reports a state the winner has already replaced.
_redeploy_lock = threading.Lock()

#: The outcome of the last DETACHED redeploy, held until somebody reads it.
#:
#: The backend cannot redeploy itself synchronously — recreating it kills the
#: process that would report what happened, and this repo's oldest rule is that
#: a step which cannot verify its own result must not claim one. So the answer
#: outlives the caller HERE, in the process that does not restart, and whoever
#: asks next takes it: the backend after it comes back, or the same backend
#: still running because the build failed and it was never brought down.
#:
#: READ-AND-CLEAR, so exactly one reader gets it. Two notifications for one
#: redeploy is a small lie about how many things happened.
_last_detached: dict | None = None
_detached_lock = threading.Lock()


def _container_state(service: str = SERVICE) -> dict:
    proc = subprocess.run(
        ["docker", "ps", "-a",
         "--filter", f"label=com.docker.compose.project={PROJECT}",
         "--filter", f"label=com.docker.compose.service={service}",
         "--format", "{{.State}}"],
        capture_output=True, text=True, timeout=10)
    lines = [l.strip() for l in proc.stdout.splitlines() if l.strip()]
    state = lines[0] if lines else ""
    return {"present": bool(state), "running": state == "running",
            "state": state or "absent"}


def _gpu_info() -> dict:
    """Whether docker can hand a container an NVIDIA GPU. Presence of the
    runtime is the honest answer available without launching probe containers;
    actual VRAM is observed empirically by the backend during model probes."""
    proc = subprocess.run(["docker", "info", "--format", "{{json .Runtimes}}"],
                          capture_output=True, text=True, timeout=10)
    try:
        runtimes = json.loads(proc.stdout.strip() or "{}")
    except json.JSONDecodeError:
        runtimes = {}
    return {"nvidia_runtime": "nvidia" in runtimes}


def _vram_info() -> dict:
    """GPU name + total VRAM, measured by nvidia-smi INSIDE the ollama
    container (the nvidia runtime injects the binary when the container has
    GPU access). Fixed command, nothing parameterized. Fails soft: a stopped
    or CPU-only container reports an error, never a guess."""
    proc = subprocess.run(
        _compose_cmd() + ["exec", "-T", SERVICE, "nvidia-smi",
                          "--query-gpu=name,memory.total",
                          "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=20, env=_compose_env())
    if proc.returncode != 0:
        return {"gpus": [],
                "error": (proc.stderr or proc.stdout)[-300:].strip()
                or "nvidia-smi unavailable in the ollama container"}
    gpus = []
    for line in proc.stdout.splitlines():
        if "," not in line:
            continue
        name, mib = line.rsplit(",", 1)
        try:
            gpus.append({"name": name.strip(),
                         "vram_total_gb": round(float(mib.strip()) / 1024, 1)})
        except ValueError:
            continue
    return {"gpus": gpus}


def _gpu_stats() -> dict:
    """LIVE GPU utilization (vs. /vram's static capacity): per-GPU used/total
    VRAM, core util %, and temperature, from nvidia-smi inside the ollama
    container. Same fail-soft contract as /vram — a stopped or CPU-only
    container returns {gpus: []}, never a guess. Feeds the Observability
    board's live gauges (docs/plans/observability-board.md)."""
    proc = subprocess.run(
        _compose_cmd() + ["exec", "-T", SERVICE, "nvidia-smi",
                          "--query-gpu=name,memory.used,memory.total,"
                          "utilization.gpu,temperature.gpu",
                          "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=20, env=_compose_env())
    if proc.returncode != 0:
        return {"gpus": [],
                "error": (proc.stderr or proc.stdout)[-300:].strip()
                or "nvidia-smi unavailable in the ollama container"}
    gpus = []
    for line in proc.stdout.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 5:
            continue
        name, used, total, util, temp = parts
        try:
            gpus.append({"name": name,
                         "mem_used_gb": round(float(used) / 1024, 1),
                         "mem_total_gb": round(float(total) / 1024, 1),
                         "util_pct": float(util),
                         "temp_c": float(temp)})
        except ValueError:
            continue
    return {"gpus": gpus}


def _parse_bytes(s: str) -> float | None:
    """docker's human sizes ('1.23GiB', '512MiB', '0B') → GiB."""
    s = s.strip()
    units = {"B": 1, "KIB": 1024, "MIB": 1024**2, "GIB": 1024**3, "TIB": 1024**4,
             "KB": 1000, "MB": 1000**2, "GB": 1000**3, "TB": 1000**4}
    for suffix, mult in sorted(units.items(), key=lambda kv: -len(kv[0])):
        if s.upper().endswith(suffix):
            try:
                return float(s[:-len(suffix)]) * mult / (1024**3)
            except ValueError:
                return None
    return None


def _health(status: str) -> str | None:
    """docker's healthcheck verdict, dug out of the Status string.

    `{{.State}}` is only "running" / "exited" — a container whose healthcheck
    has been failing for an hour still reports "running", so a board built on
    State alone shows a confident green for a service that is down. The
    verdict only exists in `{{.Status}}` ("Up 5 minutes (unhealthy)").
    None means the service declares no healthcheck, which is honestly
    different from passing one and must not be coloured as if it were.
    """
    low = status.lower()
    if "(healthy)" in low:
        return "healthy"
    if "(unhealthy)" in low:
        return "unhealthy"
    if "health: starting" in low:
        return "starting"
    return None


def _stopped_detail(names: list[str]) -> dict[str, dict]:
    """Exit code and docker's own error string, for containers that are down.

    `docker ps` cannot give either: `{{.Status}}` carries "Exited (127) 2 days
    ago" at best, and `.State.Error` — the sentence that says WHY, verbatim —
    appears nowhere in ps output at all. It is the whole diagnosis for the
    class of failure that cost this install 43 hours: a single-file bind mount
    whose inode was recycled dies with exit 127 and an error naming the mount,
    and every layer above it could only report that the service was missing.

    Inspect is only run for containers that are NOT running, which is normally
    none, so the common path pays one `docker ps` exactly as before.
    """
    if not names:
        return {}
    out: dict[str, dict] = {}
    try:
        r = subprocess.run(
            ["docker", "inspect", "--format",
             "{{.Name}}\t{{.State.ExitCode}}\t{{.State.Error}}", *names],
            capture_output=True, text=True, timeout=15)
        for line in r.stdout.splitlines():
            cols = line.split("\t")
            if len(cols) != 3:
                continue
            name, code, err = cols
            name = name.lstrip("/")
            try:
                exit_code = int(code)
            except ValueError:
                exit_code = None
            out[name] = {"exit_code": exit_code, "error": err.strip() or None}
    except Exception:
        pass          # a missing detail must not cost the caller the whole list
    return out


def _containers() -> dict:
    """Per-service state + live CPU/mem for this instance's compose project.
    `docker ps -a` gives every service (incl. stopped); `docker stats` adds
    CPU/mem for the running ones. Merged by container name."""
    ps = subprocess.run(
        ["docker", "ps", "-a",
         "--filter", f"label=com.docker.compose.project={PROJECT}",
         "--format", '{{.Names}}\t{{.Label "com.docker.compose.service"}}'
                     '\t{{.State}}\t{{.Status}}'],
        capture_output=True, text=True, timeout=10)
    rows: dict[str, dict] = {}
    for line in ps.stdout.splitlines():
        cols = line.split("\t")
        if len(cols) != 4 or not cols[0]:
            continue
        name, service, state, status = cols
        rows[name] = {"name": name, "service": service, "state": state,
                      "status": status, "health": _health(status),
                      "exit_code": None, "error": None,
                      "cpu_pct": None, "mem_used_gb": None, "mem_total_gb": None}
    for name, detail in _stopped_detail(
            [n for n, r in rows.items() if r["state"] != "running"]).items():
        if name in rows:
            rows[name].update(detail)
    stats = subprocess.run(
        ["docker", "stats", "--no-stream", "--format",
         "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"],
        capture_output=True, text=True, timeout=20)
    for line in stats.stdout.splitlines():
        cols = line.split("\t")
        if len(cols) != 3 or cols[0] not in rows:
            continue
        name, cpu, mem = cols
        try:
            rows[name]["cpu_pct"] = float(cpu.strip().rstrip("%"))
        except ValueError:
            pass
        if "/" in mem:
            used, total = mem.split("/", 1)
            rows[name]["mem_used_gb"] = _round1(_parse_bytes(used))
            rows[name]["mem_total_gb"] = _round1(_parse_bytes(total))
    return {"containers": sorted(rows.values(), key=lambda r: r["service"] or r["name"])}


def _service_names() -> set[str]:
    """Every service in THIS compose project, from docker's own labels.

    The closed set `_service_logs` validates against. Derived, never listed:
    a service added to docker-compose.yml is readable the day it exists, and
    nothing outside this project ever is.
    """
    proc = subprocess.run(
        ["docker", "ps", "-a",
         "--filter", f"label=com.docker.compose.project={PROJECT}",
         "--format", '{{.Label "com.docker.compose.service"}}'],
        capture_output=True, text=True, timeout=10)
    return {s.strip() for s in proc.stdout.splitlines() if s.strip()}


def _self_service() -> str:
    """This sidecar's own compose service, from docker's own labels.

    DERIVED, not written down. It is the one name `/service/redeploy` must
    refuse, and a rename in docker-compose.yml must not silently disarm that
    — a hardcoded string would keep matching nothing and the endpoint would
    happily recreate the container serving the request.

    An empty answer fails the endpoint CLOSED: not knowing which service is
    us is exactly the state in which redeploying anything is unsafe.
    """
    cid = os.environ.get("HOSTNAME", "").strip()
    if not cid:
        return ""
    proc = subprocess.run(
        ["docker", "inspect", "--format",
         '{{index .Config.Labels "com.docker.compose.service"}}', cid],
        capture_output=True, text=True, timeout=10)
    return proc.stdout.strip()


def _all_profiles() -> set[str]:
    """Every profile named in the compose file, so any service is addressable.

    Derived by reading the file this sidecar already mounts. `_compose_cmd`
    enables only `inference`, which is right for the ollama toggle and wrong
    here: `coder`, `voice` and the rest would be invisible, and a redeploy
    that cannot see a service reports "unknown service" for one that is
    plainly running.
    """
    try:
        text = open(COMPOSE_FILE).read()
    except OSError:
        return set()
    out: set[str] = set()
    for m in re.finditer(r"^\s*profiles:\s*\[([^\]]*)\]", text, re.M):
        out |= {p.strip().strip("\"'") for p in m.group(1).split(",")
                if p.strip()}
    return out


def _builds(cmd: list, service: str) -> bool:
    """Does this service build from source, or is it a pulled image?

    Asked rather than assumed, because `docker compose build postgres` is an
    error and swallowing it would be the fallback-that-reads-as-success this
    file keeps having to remove.
    """
    proc = subprocess.run(cmd + ["config", "--format", "json"],
                          capture_output=True, text=True, timeout=120,
                          env=_compose_env())
    try:
        conf = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return False
    return bool((conf.get("services") or {}).get(service, {}).get("build"))


def _redeploy(service: str) -> dict:
    """Rebuild ONE service of this project from source and bring it back up.

    THE STEP BETWEEN "her code landed" AND "her code is running". The
    self-improvement loop could write a change, boot it in a sandbox, have a
    second model read it and put it on a branch in his repo — and then stopped,
    because nothing she holds could make the running stack pick it up. Every
    change she made reached production by Jeremy typing `docker compose build`,
    which is the capability gap wearing a shipped feature as a disguise.

    PARAMETERIZED, on a socket-holding sidecar, which this file argues against
    everywhere else. The argument for the exception is the same one
    `_service_logs` makes and it has to be as strong, because this one WRITES:

      * the name is checked against the project's own container labels before
        it reaches a subprocess, so an unknown value is an error and never an
        argument;
      * `--no-deps` keeps the blast radius to the service named — a redeploy
        of `web` must not recreate postgres underneath a running backend;
      * this sidecar refuses ITSELF, derived from its own labels, because a
        process cannot report the outcome of its own recreation;
      * `up -d`, never `restart`: restart does not re-read `.env`, so a
        redeploy that appeared to work would run the old configuration.

    Synchronous, like `/sandbox/`: the answer is "is it up on the new image",
    which is not knowable at request time, and a caller polling a status flag
    would learn less than one that waits.
    """
    me = _self_service()
    if not me:
        return {"error": ("this sidecar cannot identify its own container, so "
                          "it cannot tell whether you are asking it to "
                          "recreate itself. Refusing every redeploy until it "
                          "can.")}
    if service == me:
        return {"error": (f"{service} is this sidecar. Recreating it would "
                          f"kill the process handling this request, and a "
                          f"redeploy that cannot report its own outcome is "
                          f"worse than one that did not happen. Ask the "
                          f"operator to run it.")}
    known = _service_names()
    if service not in known:
        return {"error": (f"no service {service!r} in this project. Only "
                          f"something already deployed can be redeployed."),
                "known": sorted(known)}

    # BUILD AND RUN NEED DIFFERENT VIEWS OF THE SAME DIRECTORY — the same trap
    # `_sandbox` documents at length, hit again here on the first live call.
    # A build CONTEXT is packaged by the compose client and streamed to the
    # daemon, so `./coder` has to resolve to a path THIS container can read
    # (`/repo/coder`). A bind MOUNT is created by the daemon on the host, so it
    # has to resolve to the host's path. One `--project-directory` cannot be
    # both, and pointed at the host the build fails with "path not found" for
    # a directory that plainly exists.
    def _base(project_dir: str) -> list:
        cmd = ["docker", "compose"]
        if project_dir:
            cmd += ["--project-directory", project_dir]
        # Without this the recreated container comes back with every `${VAR}`
        # in its block empty — see `_env_file_args`, which this endpoint is
        # what discovered.
        cmd += _env_file_args()
        cmd += ["-f", COMPOSE_FILE]
        if _use_gpu_file():
            cmd += ["-f", GPU_COMPOSE_FILE]
        if _use_models_file():
            cmd += ["-f", MODELS_COMPOSE_FILE]
        # Every profile the compose file names, so a service under `coder` or
        # `voice` is addressable at all. Derived by reading the file rather
        # than listed, so a profile added tomorrow works tomorrow.
        for p in sorted(_all_profiles()):
            cmd += ["--profile", p]
        return cmd

    build_cmd = _base(REPO_ROOT)
    up_cmd = _base(HOST_ROOT)

    steps: list[dict] = []

    def run(name, cmd, args, timeout):
        p = subprocess.run(cmd + args, capture_output=True, text=True,
                           timeout=timeout, env=_compose_env())
        so, se = (p.stdout or "").strip(), (p.stderr or "").strip()
        steps.append({"step": name, "ok": p.returncode == 0,
                      "output": (se or so)[-1200:]})
        return p.returncode == 0

    try:
        if _builds(build_cmd, service):
            if not run("build", build_cmd, ["build", service], 3600):
                return {"status": "failed", "stage": "build", "steps": steps}
        else:
            steps.append({"step": "build", "ok": True,
                          "output": "pulled image, nothing to build"})
        if not run("up", up_cmd, ["up", "-d", "--no-deps", service], 900):
            return {"status": "failed", "stage": "up", "steps": steps}
    except subprocess.TimeoutExpired as e:
        return {"status": "failed", "stage": "timeout",
                "steps": steps + [{"step": "timeout", "ok": False,
                                   "output": str(e)[:300]}]}

    # AND THEN CHECK IT CAME UP. `docker compose up -d` returns as soon as it
    # has asked, not when the container is serving — this repo has already
    # logged "git daemon serving" for a binary that had died and reported
    # "import ok" for a load that never happened. A container that exits three
    # seconds later must not be reported as a successful redeploy.
    deadline = time.time() + 120
    state = _container_state(service)
    while time.time() < deadline:
        state = _container_state(service)
        if state.get("running"):
            health = _service_health(service)
            if health in (None, "healthy"):
                break
            if health == "unhealthy":
                break
        time.sleep(3)
    health = _service_health(service)
    ok = bool(state.get("running")) and health != "unhealthy"
    return {"status": "ok" if ok else "failed",
            "stage": "complete" if ok else "verify",
            "service": service, "state": state.get("state"),
            "health": health, "steps": steps,
            "detail": (f"{service} is {state.get('state')}"
                       + (f" ({health})" if health else "")
                       + ("" if ok else " — it did not come back up"))}


def _redeploy_detached(service: str) -> None:
    """Run a redeploy on a thread and park the verdict for whoever asks.

    The lock is taken HERE rather than by the caller: the caller has already
    returned 202 by the time this starts, so a second request must be refused
    against the work actually in flight.
    """
    global _last_detached
    if not _redeploy_lock.acquire(blocking=False):
        with _detached_lock:
            _last_detached = {"service": service, "status": "failed",
                              "detail": ("a redeploy was already in progress, "
                                         "so this one never started")}
        return
    try:
        out = _redeploy(service)
    except Exception as e:                           # noqa: BLE001
        log.exception("detached redeploy of %s crashed", service)
        out = {"status": "failed", "stage": "crashed", "detail": str(e)[:300]}
    finally:
        _redeploy_lock.release()
    failing = next((s for s in (out.get("steps") or []) if not s.get("ok")), {})
    with _detached_lock:
        _last_detached = {
            "service": service,
            "status": out.get("status") or ("failed" if out.get("error") else "ok"),
            "stage": out.get("stage"),
            "state": out.get("state"),
            "health": out.get("health"),
            "detail": (out.get("detail") or out.get("error")
                       or (failing.get("output") or "")[-600:]),
        }
    log.info("detached redeploy of %s finished: %s", service, out.get("status"))


def _service_health(service: str) -> str | None:
    """The healthcheck verdict for one service, or None if it declares none."""
    proc = subprocess.run(
        ["docker", "ps", "-a",
         "--filter", f"label=com.docker.compose.project={PROJECT}",
         "--filter", f"label=com.docker.compose.service={service}",
         "--format", "{{.Status}}"],
        capture_output=True, text=True, timeout=10)
    lines = [l.strip() for l in proc.stdout.splitlines() if l.strip()]
    return _health(lines[0]) if lines else None


def _service_logs(service: str, lines: int = 80) -> dict:
    """Recent stdout/stderr of ONE service in this project. Read-only.

    THE ONE PARAMETERIZED ENDPOINT HERE, and the exception is argued rather
    than assumed. Every other verb on this socket-holding sidecar is fixed,
    because a parameter plus a docker socket is a way to run anything. This
    one takes a service name and is still safe for a reason that does not
    depend on the caller being careful: the name is checked for membership in
    the project's OWN service labels before it reaches a subprocess, so an
    unknown value is a 404 and never an argument. `docker logs` reads; it
    cannot start, stop or change anything.

    It exists because Nova could not answer "why did that not come up".
    `service_status` gives her container state and `workload_logs` covers her
    Kubernetes pods, but the compose services this install is MADE of had no
    log surface at all — so every diagnosis of a failed start was a human
    reading `docker compose logs`, which is the exact failure Jeremy named on
    2026-08-05: the capability gap gets papered over by a person and she stays
    unable.
    """
    known = _service_names()
    if service not in known:
        return {"error": f"unknown service {service!r}",
                "known": sorted(known)}
    n = max(1, min(int(lines or 80), 400))
    # `docker logs <container>`, not `docker compose logs <service>`: compose
    # refuses a service whose PROFILE is not enabled, and every optional
    # service here (home, notify, media, voice, coder) lives behind one — so
    # the compose form fails on exactly the services most likely to need
    # diagnosing. Resolve the container by label and read it directly.
    ps = subprocess.run(
        ["docker", "ps", "-a", "--filter",
         f"label=com.docker.compose.project={PROJECT}", "--filter",
         f"label=com.docker.compose.service={service}",
         "--format", "{{.Names}}"],
        capture_output=True, text=True, timeout=10)
    names = [x.strip() for x in ps.stdout.splitlines() if x.strip()]
    if not names:
        return {"service": service, "lines": n, "logs": "",
                "note": "no container exists for this service yet"}
    proc = subprocess.run(
        ["docker", "logs", "--tail", str(n), names[0]],
        capture_output=True, text=True, timeout=60)
    out = (proc.stdout or "") + (proc.stderr or "")
    return {"service": service, "container": names[0], "lines": n,
            "logs": out[-20000:]}


def _reachable(service: str) -> dict:
    """Can this service actually be reached — locally, and from the tailnet?

    "Is it running" and "can Jeremy open it on his phone" are different
    questions, and the second is the one he asks. A container can be healthy
    with no published port, or published and not served on the tailnet, or
    served and answering 400 because the app refuses proxied requests — all
    three happened on 2026-08-05 and every one was diagnosed by a human with
    curl, which is the gap this closes.

    `fetch_url` cannot answer it and must not learn how: `net_guard`
    allow-lists globally routable addresses only, and CGNAT — 100.64.0.0/10,
    exactly Tailscale's range — is excluded on purpose so the model cannot
    reach tailnet peers. This asks about THIS INSTALL'S OWN services, by name,
    from the closed set docker reports. It is not a URL fetcher and cannot be
    turned into one.
    """
    known = _service_names()
    if service not in known:
        return {"error": f"unknown service {service!r}", "known": sorted(known)}

    ports = subprocess.run(
        ["docker", "ps", "--filter",
         f"label=com.docker.compose.project={PROJECT}", "--filter",
         f"label=com.docker.compose.service={service}",
         "--format", "{{.Ports}}"],
        capture_output=True, text=True, timeout=10).stdout.strip()
    # "127.0.0.1:8123->8123/tcp" -> 8123. Only published ports are reachable
    # from outside the compose network, which is what this is about.
    host_ports = sorted({int(m) for m in re.findall(r":(\d+)->", ports)})

    # urllib, not curl: this image is alpine + docker-cli and has no curl.
    # An HTTP status of any kind answers the question — 200, 302 and 401 all
    # mean something is listening and speaking HTTP, which is what "can it be
    # reached" asks. Only a transport failure is unreachable.
    local: list[dict] = []
    for p in host_ports:
        code, err = None, None
        url = f"http://host.docker.internal:{p}/"
        try:
            with urllib.request.urlopen(url, timeout=8) as resp:
                code = resp.status
        except urllib.error.HTTPError as e:
            code = e.code                    # reached it; it said no
        except Exception as e:               # noqa: BLE001 — transport failure
            err = f"{type(e).__name__}: {str(e)[:100]}"
        local.append({"port": p, "url": url, "http_status": code, "error": err})

    # ...and whether tailscale is serving it, which is the half that decides
    # whether another device can see it at all.
    served: list[str] = []
    if _container_state("tailscale")["running"]:
        try:
            st = subprocess.run(
                _compose_cmd("tailscale") + ["exec", "-T", "tailscale",
                                             "tailscale", "serve", "status"],
                capture_output=True, text=True, timeout=30).stdout
            for line in st.splitlines():
                if service in line or any(f":{p}" in line for p in host_ports):
                    served.append(line.strip())
        except Exception:                            # noqa: BLE001
            served = []

    return {"service": service, "published_ports": host_ports,
            "local": local, "tailnet_routes": served,
            "tailscale_running": _container_state("tailscale")["running"]}


SANDBOX_PROJECT = "nova-sandbox"
# `nova/<slug>` slugs only. The path is COMPOSED here from a validated slug,
# never accepted as a path — a caller cannot point this at a directory of its
# choosing, which matters because what happens next is `docker compose up`.
_SLUG_OK = re.compile(r"^[a-z0-9][a-z0-9._-]{0,60}$")


# NEVER COPIED INTO A SANDBOX. Four tables, four different reasons, and the
# reasoning matters more than the list because the list will grow.
#
#   secrets             encrypted, but a sandbox holding the key too can spend
#                       what they protect. A sandbox that can spend his
#                       credentials is not a sandbox.
#   llm_providers       API keys. A loop that misbehaves in here bills him.
#   push_subscriptions  a test run pushing to his phone.
#   user_profiles       voiceprints and household facts, inside a stack whose
#                       whole purpose is running code a model just wrote.
#
# Everything else copies verbatim, and that is the point: conversations,
# memory, agents, tools, rules, goals and recommendations are what make
# retrieval, clustering and compaction behave like his install rather than
# like a fixture pack. Jeremy overrode the original "seed it, never copy"
# decision on exactly that ground and was right.
_SANDBOX_EXCLUDE = ("secrets", "llm_providers", "push_subscriptions",
                    "user_profiles")

_PROD_DB = ("nova-postgres-1", "nova", "nova")      # container, user, db


def _import_production_data(base: list, env: dict, record) -> bool:
    """Copy his data into the sandbox, minus the credentials.

    BEFORE THE BACKEND BOOTS, deliberately. Migrations run at backend startup,
    so importing first means the candidate branch's migrations run against his
    REAL schema and REAL rows — which is the question actually worth asking. A
    migration that works on an empty database and fails on 2,890 messages is
    exactly the failure this whole gate exists to catch, and it is invisible
    to an empty sandbox.

    `docker exec` on the two postgres containers rather than a client here:
    the client is then the same binary as the server, which sidesteps the
    version-skew trap that made every backup on this install unrestorable
    (client 17 against server 16, silently).
    """
    sandbox_pg = f"{SANDBOX_PROJECT}-postgres-1"
    container, user, dbname = _PROD_DB

    # WAIT FOR IT TO ACCEPT CONNECTIONS, not merely to exist. `compose up -d`
    # returns when the container has STARTED, and postgres then spends several
    # seconds initialising — so the load ran against a socket that was not
    # there yet and psql failed with "No such file or directory".
    #
    # That run reported IMPORT OK, because the summary fell back to a friendly
    # word when its verification query produced nothing. The gate was green
    # and the data had never landed. Both halves are fixed here: this waits,
    # and the caller no longer accepts an unreadable result as success.
    import time as _t
    for _ in range(60):
        ready = subprocess.run(
            ["docker", "exec", sandbox_pg, "pg_isready", "-U", user,
             "-d", dbname],
            capture_output=True, text=True, timeout=30)
        if ready.returncode == 0:
            break
        _t.sleep(2)
    else:
        record("import", False,
               "the sandbox database never accepted connections")
        return False
    excludes = []
    for t in _SANDBOX_EXCLUDE:
        excludes += ["--exclude-table-data", f"public.{t}"]

    # Schema AND data: the sandbox database is empty, and letting his schema
    # arrive with it is what makes the migration test real. --exclude-table-DATA
    # rather than --exclude-table so the tables still EXIST — the backend
    # queries them at boot and a missing table is a crash, not an isolation.
    dump = subprocess.run(
        ["docker", "exec", container, "pg_dump", "-U", user, "-d", dbname,
         "--no-owner", "--no-privileges", *excludes],
        capture_output=True, text=True, timeout=600)
    if dump.returncode != 0:
        record("import", False, (dump.stderr or "")[-800:])
        return False

    load = subprocess.run(
        ["docker", "exec", "-i", sandbox_pg, "psql", "-U", user, "-d", dbname,
         "-v", "ON_ERROR_STOP=0", "-q"],
        input=dump.stdout, capture_output=True, text=True, timeout=900)

    # AUTOMATIONS OFF, and this is not tidiness. An imported automation is a
    # standing claim on a scheduler that will start running agent turns inside
    # a sandbox — spending his model budget and, before notify was excluded,
    # reaching his phone. Disabled at import so the rows are there to be read
    # and nothing acts on them.
    subprocess.run(
        ["docker", "exec", sandbox_pg, "psql", "-U", user, "-d", dbname, "-q",
         "-c", "UPDATE automations SET enabled = false;"],
        capture_output=True, text=True, timeout=120)

    # COUNTED, AND THE COUNT IS THE RECEIPT. The first version fell back to
    # the word "imported" when this query produced nothing, which is how a
    # gate reports success it did not verify — the same defect this codebase
    # keeps finding in the model. If the numbers cannot be read, the step says
    # so and fails, because "his data is in there" is the whole claim.
    counts = subprocess.run(
        ["docker", "exec", sandbox_pg, "psql", "-U", user, "-d", dbname,
         "-tAc",
         "SELECT (SELECT count(*) FROM messages) || ' messages / ' || "
         "(SELECT count(*) FROM agents) || ' agents / ' || "
         "(SELECT count(*) FROM secrets) || ' secrets / ' || "
         "(SELECT count(*) FROM llm_providers) || ' providers / ' || "
         "(SELECT count(*) FROM push_subscriptions) || ' push / ' || "
         "(SELECT count(*) FROM user_profiles) || ' profiles'"],
        capture_output=True, text=True, timeout=120)
    summary = (counts.stdout or "").strip()
    if not summary:
        record("import", False,
               "the import ran but its result could not be read: "
               + ((counts.stderr or "").strip()[-600:] or "no output")
               + " | load stderr: " + (load.stderr or "").strip()[-600:])
        return False

    # THE EXCLUSIONS, ASSERTED. Not trusted from the pg_dump flags — a typo in
    # a table name would silently copy his API keys into a stack that runs
    # model-authored code, and nothing downstream would notice.
    nums = [int(n) for n in re.findall(r"(\d+) (?:secrets|providers|push|profiles)",
                                       summary)]
    if any(n > 0 for n in nums):
        record("import", False,
               f"REFUSED: credential tables are not empty in the sandbox "
               f"({summary}). Nothing may run against this.")
        return False
    record("import", True, f"{summary}; automations disabled")
    if load.returncode != 0:
        log.warning("sandbox import reported errors: %s",
                    (load.stderr or "")[-300:])
    return True


#: The one machine-readable line `backend/tests/eval_floor.py` prints. Parsed
#: rather than inferred from the exit code alone, because "why" is the useful
#: half and an exit code cannot carry it.
_EVAL_MARKER = "EVAL_FLOOR_RESULT "
#: Eval suites are model turns, so this is the slowest stage by far. Long
#: enough for a real suite, bounded so a hung provider cannot hold the sandbox
#: lock all night.
_EVAL_TIMEOUT_S = 2400


def _eval_floor(base: list, env: dict, steps: list) -> dict:
    """Run the eval floor inside the candidate stack and read its verdict.

    ROADMAP #47 rail 2. Returns `{"state": ok|below|unmeasured, "detail":...}`
    and always appends a step, including on every failure path — a stage that
    produced nothing is reported as `unmeasured` WITH the reason, never as
    silence and never as a pass.

    The three outcomes are kept apart on purpose. `below` is a verdict about
    the change; `unmeasured` is a verdict about the machine; collapsing them
    would let a missing API key read as a regression, or worse, the reverse.
    """
    try:
        p = subprocess.run(
            base + ["exec", "-T", "backend", "python", "tests/eval_floor.py"],
            capture_output=True, text=True, timeout=_EVAL_TIMEOUT_S, env=env)
        so, se = (p.stdout or "").strip(), (p.stderr or "").strip()
        code = p.returncode
    except subprocess.TimeoutExpired:
        out = {"state": "unmeasured",
               "detail": (f"the eval stage did not finish within "
                          f"{_EVAL_TIMEOUT_S}s — nothing was measured")}
        steps.append({"step": "eval-floor", "ok": False,
                      "summary": out["detail"], "stdout": "", "stderr": ""})
        return out

    line = next((ln for ln in so.splitlines()
                 if ln.startswith(_EVAL_MARKER)), "")
    if line:
        try:
            out = json.loads(line[len(_EVAL_MARKER):])
        except ValueError as e:
            out = {"state": "unmeasured",
                   "detail": f"the eval verdict line was unreadable: {e}"}
    else:
        # NO VERDICT IS NOT A PASS. The script prints the marker on every
        # path it can reach, so its absence means the stage died before
        # deciding anything — an import error, a missing file, a container
        # that is not there. Saying "ok" here would be the fallback that reads
        # as success this repo keeps deleting.
        out = {"state": "unmeasured",
               "detail": (f"the eval stage produced no verdict line (exit "
                          f"{code}). stdout tail: {so[-400:] or '(empty)'} | "
                          f"stderr tail: {se[-400:] or '(empty)'}")}
    steps.append({"step": "eval-floor", "ok": out.get("state") == "ok",
                  "summary": f"{out.get('state')}: {out.get('detail', '')}"[:1500],
                  "stdout": so[-2500:], "stderr": se[-1200:]})
    return out


def _sandbox(slug: str, verb: str) -> dict:
    """Boot her candidate code in an isolated stack, and report three facts.

    `docs/plans/sandbox-instance.md` phase 1. Her only test surface before
    this was a coding agent running unit tests in a private clone, and of the
    six real failures on 2026-08-05 that would have caught exactly one. The
    rest — a bind mount resolving inside the wrong container, a config key
    that made tailscale discard its whole serve config, a service that would
    not start — were only visible in a running stack.

    THE ISOLATION IS THE PROJECT NAME. `-p nova-sandbox` gives every container
    and every volume a different namespace, so the sandbox cannot touch the
    live database, the live memory volume or the live state volume. It is the
    single most important flag here.

    Deliberately NOT the whole stack: postgres and backend only. That is
    enough to answer the three questions worth asking of a candidate branch —
    do the migrations apply, does the backend boot, does the suite pass — and
    it leaves out every service that would contend for the GPU, hold his ntfy
    topic or take a tailnet name.
    """
    if not _SLUG_OK.match(slug or ""):
        return {"error": f"slug {slug!r} is not allowed"}
    if not HOST_ROOT:
        return {"error": "NOVA_HOST_ROOT is unset; the worktree path cannot "
                         "be composed"}
    # TWO PATHS TO THE SAME DIRECTORY, and they are not interchangeable.
    # `-f` is read by the compose CLI running INSIDE this container, so it
    # must be the container's view (`/repo/...`, via the read-only mount).
    # `--project-directory` is what relative bind mounts resolve against, and
    # those are created by the docker DAEMON on the host, so it must be the
    # host's view. Passing the host path to `-f` fails with "no such file"
    # against a path that plainly exists — measured on the first run.
    work = f"{HOST_ROOT}/.worktrees/sandbox-{slug}"
    local = f"/repo/.worktrees/sandbox-{slug}"
    compose = f"{local}/docker-compose.yml"
    base = ["docker", "compose", "--project-directory", work,
            "-f", compose, "-p", SANDBOX_PROJECT]
    # BUILD AND RUN NEED DIFFERENT VIEWS OF THE SAME DIRECTORY, and the reason
    # is not arbitrary. A build CONTEXT is packaged by the compose client and
    # sent to the daemon, so it must be a path this container can read
    # (`/repo/...`). A bind MOUNT is created by the daemon on the host, so it
    # must be a host path (`/home/...`). One `--project-directory` cannot be
    # both: pointed at the host it fails with "path not found" packaging the
    # context, pointed at the container it silently mounts directories from
    # inside this sidecar — the same class of bug that nearly deleted Home
    # Assistant's config.
    # THE OVERRIDE. Written into the worktree (which is disposable) rather
    # than shipped in the repo, because it is derived from what the sandbox
    # must not do rather than authored per branch.
    #
    # Only PORTS need overriding, and understanding why the rest does not is
    # the interesting part: `--project-directory` is the worktree, and a
    # worktree contains no `data/` (it is gitignored), so every `./data/...`
    # bind resolves to a fresh empty directory beside the candidate code. The
    # sandbox therefore gets its own memory, attachments and workspace for
    # free, by construction, without a line of configuration. Volumes are
    # namespaced by `-p nova-sandbox` for the same reason.
    #
    # Published ports are the one thing that cannot isolate itself: they are
    # host-global, so the sandbox postgres collided with the live one on
    # 127.0.0.1:5432 and the whole stack failed to start. Nothing outside
    # needs to reach the sandbox — the suite runs INSIDE it via `compose
    # exec` — so the correct number of published ports is zero.
    # WRITTEN BY git-landing, not here. This container mounts the repo
    # READ-ONLY on purpose — it holds the docker socket, and the two
    # capabilities stay apart — so the container that owns repository writes
    # produces the override when it creates the worktree. Trying to write it
    # from here failed with EROFS, which is the split working rather than a
    # problem to route around.
    override = f"{local}/docker-compose.sandbox.yml"
    if not os.path.exists(override):
        return {"error": (f"no sandbox override at {override} — the worktree "
                          f"must be created through git-landing's /worktree, "
                          f"which writes it")}

    base += ["-f", override]
    build_base = ["docker", "compose", "--project-directory", local,
                  "-f", compose, "-f", override, "-p", SANDBOX_PROJECT]

    if verb == "down":
        # -v so the sandbox's volumes go with it. They are its own (the
        # project name saw to that), and leaving them behind is how a second
        # database quietly accumulates on his disk.
        proc = subprocess.run(base + ["down", "-v", "--remove-orphans"],
                              capture_output=True, text=True, timeout=600)
        return {"status": "ok" if proc.returncode == 0 else "error",
                "detail": (proc.stderr or proc.stdout)[-400:].strip()}

    env = {**os.environ,
           # Its own credentials and its own ports. A sandbox that answered on
           # the live port would be reachable as if it were Nova.
           "NOVA_AUTH_TOKEN": "sandbox-" + slug,
           "POSTGRES_PORT": "0", "BACKEND_PORT": "0"}
    steps: list[dict] = []

    def run(name, args, timeout, cmd=None):
        p = subprocess.run((cmd or base) + args, capture_output=True,
                           text=True, timeout=timeout, env=env)
        # STDOUT AND STDERR SEPARATELY, and stdout wins the space. The first
        # version concatenated them and kept the last 1500 characters — which
        # is the tail of STDERR, so a failed suite reported a wall of routine
        # log noise while the line that names the failing suites (printed on
        # stdout, at the end) was cut. A gate that cannot say why it failed is
        # barely better than no gate.
        so, se = (p.stdout or "").strip(), (p.stderr or "").strip()
        # The lines a reader actually needs: verdicts and failures, wherever
        # they appear. Falls back to the plain tail when nothing matches, so
        # this can never hide output it did not recognise.
        keep = [ln for ln in so.splitlines()
                if ("FAIL" in ln or "passed" in ln or "Error" in ln
                    or "error" in ln)]
        steps.append({"step": name, "ok": p.returncode == 0,
                      "summary": "\n".join(keep[-12:]) or so[-600:],
                      "stdout": so[-2500:], "stderr": se[-1200:]})
        return p.returncode == 0

    try:
        # Always start from nothing: a previous run's containers would make
        # "it boots" a statement about the wrong code.
        subprocess.run(base + ["down", "-v", "--remove-orphans"],
                       capture_output=True, text=True, timeout=600, env=env)
        # `web` too: building it runs the real vite build, so a TypeScript
        # error or a broken import fails HERE rather than reaching him as a
        # blank page. That is a verdict the backend suite cannot produce.
        if not run("build", ["build", "backend", "web"], 3600, cmd=build_base):
            return {"status": "failed", "stage": "build", "steps": steps}
        # Migrations run at backend startup, so "up" IS the migration test.
        # POSTGRES FIRST, ALONE. His data has to be in place before the
        # backend starts, because migrations run at backend startup — and
        # running the candidate branch's migrations against his REAL rows is
        # the question worth asking. A migration that works on an empty
        # database and fails on 2,890 messages is exactly what this gate
        # exists to catch, and an empty sandbox cannot see it.
        if not run("up-db", ["up", "-d", "postgres"], 600):
            return {"status": "failed", "stage": "up-db", "steps": steps}

        def _record(name, ok, out):
            steps.append({"step": name, "ok": ok, "summary": out[-1500:],
                          "stdout": out[-2500:], "stderr": ""})

        if not _import_production_data(base, env, _record):
            return {"status": "failed", "stage": "import", "steps": steps}

        if not run("up", ["up", "-d", "backend", "web"], 1200):
            return {"status": "failed", "stage": "up", "steps": steps}
        if not run("health", ["exec", "-T", "backend", "sh", "-c",
                              "for i in $(seq 1 60); do "
                              "curl -sf http://localhost:8000/health && exit 0; "
                              "sleep 3; done; exit 1"], 300):
            run("boot-logs", ["logs", "--tail", "60", "backend"], 120)
            return {"status": "failed", "stage": "boot", "steps": steps}
        if not run("suite", ["exec", "-T", "backend", "python",
                             "tests/run_all.py"], 2400):
            return {"status": "failed", "stage": "suite", "steps": steps}

        # THE FOURTH VERDICT, and the one that makes "green" mean what its
        # name implies. Until this ran, a passing gate meant the UNIT TESTS
        # passed — a change could blank the settings page or ship a bundle
        # that never paints and the gate would wave it through. The e2e suite
        # opens the app in a real browser against this sandbox's own `web`.
        #
        # `run --rm`, not `up`: it is a test with an exit code, not a service.
        # --profile e2e because the service is opt-in; the sandbox is the one
        # place it should always run.
        ok = run("e2e", ["--profile", "e2e", "run", "--rm", "-T", "e2e"], 2400)
        if not ok:
            return {"status": "failed", "stage": "e2e", "steps": steps}

        # THE FIFTH VERDICT: did it get WORSE at being Nova? (ROADMAP #47 rail
        # 2.) Everything above answers "does it work". A candidate can pass
        # every unit test and every browser check and still answer worse, and
        # nothing here could see that until this stage existed.
        ev = _eval_floor(base, env, steps)
        # A MEASURED REGRESSION IS A FAILED SANDBOX. Not a note on a card: the
        # floor is the recorded best this suite has honestly reached, and
        # dropping below it is the same class of fact as a failing test.
        if ev["state"] == "below":
            return {"status": "failed", "stage": "eval", "steps": steps,
                    "eval": ev}
        # 'unmeasured' does NOT fail the build/boot verdict, and the asymmetry
        # is deliberate rather than lenient. This same verdict gates the
        # OPERATOR'S landing card, and inside a sandbox the usual reason
        # nothing can be measured is environmental — `llm_providers` is one of
        # the four credential tables `_SANDBOX_EXCLUDE` holds out, so every
        # cloud model reads as unconfigured in here, and the sandbox stack
        # starts no ollama. Turning his pipeline red for that would be a gate
        # failing on a fact about the machine rather than about his change.
        #
        # It is NOT rounded to a pass either: the verdict travels back with
        # the result, `coder.sandbox_check` records it on the session, and
        # `code_change` REFUSES an autonomous landing on anything but 'ok'.
        # Never-checked is treated exactly like failed in the lane where
        # nobody is reading the diff.
        return {"status": "ok", "stage": "complete", "steps": steps,
                "eval": ev}
    except subprocess.TimeoutExpired as e:
        steps.append({"step": "timeout", "ok": False, "output": str(e)[:400]})
        return {"status": "failed", "stage": "timeout", "steps": steps}
    finally:
        # ALWAYS, including on failure and including on an exception. A
        # sandbox left running is a second attack surface and a disk drain,
        # and "I will clean it up later" is how one ends up running for a week.
        subprocess.run(base + ["down", "-v", "--remove-orphans"],
                       capture_output=True, text=True, timeout=600, env=env)


def _round1(v: float | None) -> float | None:
    return round(v, 2) if v is not None else None


def _disk_info() -> dict:
    """Docker-managed disk (where the bundled model store lives when using the
    default volume) via `docker system df`, plus the model-store path's free
    space when that path is visible to this sidecar."""
    out: dict = {}
    df = subprocess.run(["docker", "system", "df", "--format", "{{json .}}"],
                        capture_output=True, text=True, timeout=15)
    docker: dict = {}
    for line in df.stdout.splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        key = {"Images": "images_gb", "Local Volumes": "volumes_gb",
               "Build Cache": "build_cache_gb", "Containers": "containers_gb"}.get(row.get("Type"))
        if key:
            docker[key] = _round1(_parse_bytes(row.get("Size", "0B")))
            if row.get("Type") == "Local Volumes":
                # Reclaimable looks like "12.3GB (50%)" — keep just the size
                recl = row.get("Reclaimable", "0B").split(" ")[0]
                docker["volumes_reclaimable_gb"] = _round1(_parse_bytes(recl))
    if docker:
        out["docker"] = docker
    md = _models_dir()
    if md and os.path.isdir(md):
        try:
            du = shutil.disk_usage(md)
            out["model_store"] = {"path": md,
                                  "free_gb": round(du.free / (1024**3), 1),
                                  "total_gb": round(du.total / (1024**3), 1)}
        except OSError:
            pass
    return out


def _run_op(verb: str):
    cmd = _compose_cmd() + (["up", "-d", SERVICE] if verb == "start"
                            else ["stop", SERVICE])
    # first start may pull the ollama image (~GBs) — allow it time
    timeout = 1800 if verb == "start" else 120
    log.info("%s: %s", verb, " ".join(cmd))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout, env=_compose_env())
        if proc.returncode == 0:
            _op["error"] = None
            log.info("%s: done", verb)
        else:
            _op["error"] = (proc.stderr or proc.stdout)[-400:].strip()
            log.warning("%s failed: %s", verb, _op["error"])
    except Exception as e:
        _op["error"] = str(e)[:400]
        log.exception("%s crashed", verb)
    finally:
        _op["verb"] = None


def _tailnet_ntfy_route() -> bool:
    """Whether the :8443 -> ntfy route is currently served on the tailnet, read
    LIVE via the serve CLI. Gives the reachability panel a real signal instead
    of a guess. False (not an error) when tailscale is down."""
    if not _container_state("tailscale")["running"]:
        return False
    try:
        proc = subprocess.run(
            _compose_cmd("tailscale") + ["exec", "-T", "tailscale",
                                         "tailscale", "serve", "status"],
            capture_output=True, text=True, timeout=15)
        return "ntfy" in proc.stdout
    except Exception:
        return False


def _expose_ntfy_route() -> None:
    """Apply the :8443 -> ntfy tailnet route LIVE via the serve CLI — a
    `docker compose exec`, NEVER a recreate, so the sidecar's missing host .env
    can't blank tailscale's auth/config (the incident that made phase 4 use this
    path). Idempotent; the same route also lives in serve.json for fresh
    tailscale starts. Non-fatal: logs and returns if tailscale is down."""
    if not _container_state("tailscale")["running"]:
        log.info("expose: tailscale down — route deferred to serve.json on its next start")
        return
    proc = subprocess.run(
        _compose_cmd("tailscale") + ["exec", "-T", "tailscale", "tailscale",
                                     "serve", "--bg", "--https=8443", "http://ntfy:80"],
        capture_output=True, text=True, timeout=30)
    if proc.returncode == 0:
        log.info("expose: :8443 -> ntfy route applied live")
    else:
        log.warning("expose: failed (non-fatal): %s",
                    (proc.stderr or proc.stdout)[-200:].strip())


def _expose_home_route() -> None:
    """Apply the :8123 -> home-assistant tailnet route LIVE via the serve CLI.

    Same path and same reasoning as `_expose_ntfy_route`: a `docker compose
    exec`, NEVER a recreate, because this sidecar has no host .env and
    recreating tailscale once wiped its serve config and tailnet auth.
    Idempotent; the route also lives in serve.json for fresh starts.

    Reaching it from another device is the whole point of running it here —
    Jeremy, 2026-08-05: "I'm not at that device, I need to see things like
    this from other devices." A published port bound to 127.0.0.1 is not an
    answer to that on its own.
    """
    if not _container_state("tailscale")["running"]:
        log.info("expose: tailscale down — :8123 route deferred to serve.json")
        return
    proc = subprocess.run(
        _compose_cmd("tailscale") + ["exec", "-T", "tailscale", "tailscale",
                                     "serve", "--bg", "--https=8123",
                                     "http://home-assistant:8123"],
        capture_output=True, text=True, timeout=30)
    if proc.returncode == 0:
        log.info("expose: :8123 -> home-assistant route applied live")
    else:
        log.warning("expose: :8123 failed (non-fatal): %s",
                    (proc.stderr or proc.stdout)[-200:].strip())


def _notify_status() -> dict:
    """State of the notification-reachability services: the self-hosted ntfy
    server, the tailscale node, and whether the :8443 route is actually served.
    Read-only."""
    return {"ntfy": _container_state("ntfy"),
            "tailscale": _container_state("tailscale"),
            "tailnet_route": _tailnet_ntfy_route(),
            "base_url": _ntfy_base_url(),
            "op": _op["verb"], "error": _op["error"]}


def _run_notify(verb: str):
    """Fixed ntfy-service ops (nothing parameterized by the request):
      notify_up   -> recreate ONLY ntfy so it picks up the Nova-derived base-url
                     (from the /state control file).
      notify_down -> stop ntfy.

    Deliberately never touches the tailscale service. Tailscale is the shared
    reachability backbone (it also serves the app itself), its identity/auth
    key live in the host .env which this sidecar does NOT have, and recreating
    it here wiped the whole serve config + tailnet auth once — a real incident.
    Ntfy is exposed by whatever serve.json the running tailscale already holds;
    exposing it is the operator's tailscale concern, not this toggle's.

    Same shape as _run_op: sets _op['error'] on failure, clears verb when done.
    """
    try:
        if verb == "notify_expose":
            # apply just the tailnet route, live (no ntfy recreate)
            _expose_ntfy_route()
            _op["error"] = None
            return
        if verb == "notify_up":
            env = _compose_env()
            base_url = _ntfy_base_url()
            if base_url:
                env["NTFY_BASE_URL"] = base_url
            # first start pulls the ntfy image; force-recreate so a changed
            # base-url is actually applied to a running container
            cmd, timeout = (_compose_cmd("notify")
                            + ["up", "-d", "--force-recreate", "ntfy"], 600)
        elif verb == "notify_down":
            cmd, timeout, env = (_compose_cmd("notify") + ["stop", "ntfy"],
                                 120, _compose_env())
        else:
            _op["error"] = f"unknown notify verb {verb}"
            return
        log.info("%s: %s", verb, " ".join(cmd))
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout, env=env)
        if proc.returncode != 0:
            _op["error"] = (proc.stderr or proc.stdout)[-400:].strip()
            log.warning("%s failed: %s", verb, _op["error"])
            return
        # after starting ntfy, ensure it's exposed on the tailnet — live via the
        # serve CLI, never a recreate (see _expose_ntfy_route). Non-fatal.
        if verb == "notify_up":
            _expose_ntfy_route()
        _op["error"] = None
        log.info("%s: done", verb)
    except Exception as e:
        _op["error"] = str(e)[:400]
        log.exception("%s crashed", verb)
    finally:
        _op["verb"] = None


HOME_SERVICE = "home-assistant"          # the profile `home` toggle target


def _home_timezone() -> str:
    """Operator's Home Assistant timezone (Settings → Home, written by the
    backend). Read fresh each start. Empty = keep the compose default."""
    try:
        with open(STATE_HOME_TZ_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


def _home_status() -> dict:
    """State of the Home Assistant container. Read-only.

    `url` is what the operator opens, and it is stated here rather than
    derived in the backend so the port cannot drift from the compose block
    this sidecar actually runs.
    """
    return {**_container_state(HOME_SERVICE),
            "url": "http://127.0.0.1:8123",
            "op": _op["verb"], "error": _op["error"]}


def _run_home(verb: str):
    """Fixed Home Assistant ops — nothing parameterized by the request.

    ROADMAP #35. The service block lives in docker-compose.yml, reviewed and
    in git; this only brings it up or stops it. That split is the whole
    security argument for the feature (Jeremy, 2026-08-05, choosing typed
    executors over letting Nova write compose YAML to the host): the sidecar
    holds the docker socket, which is root-equivalent, so its API stays a
    FIXED VERB LIST exactly as the compose comment above this container
    promises. A `/profile/<name>/up` endpoint would have been one parameter
    away from starting anything on the box.

    So the next service gets its own verb and its own review, and that cost
    is deliberate.

    Same shape as _run_op and _run_notify: sets _op['error'] on failure,
    clears verb when done.
    """
    try:
        env = _compose_env()
        if verb == "home_up":
            tz = _home_timezone()
            if tz:
                env["NOVA_TZ"] = tz
            # first start pulls the HA image (~1.5GB) and builds its frontend.
            # force-recreate so a changed timezone actually reaches a container
            # that is already up — the same reason notify_up does it.
            cmd, timeout = (_compose_cmd("home")
                            + ["up", "-d", "--force-recreate", HOME_SERVICE],
                            1800)
        elif verb == "home_down":
            cmd, timeout = (_compose_cmd("home") + ["stop", HOME_SERVICE], 120)
        else:
            _op["error"] = f"unknown home verb {verb}"
            return
        log.info("%s: %s", verb, " ".join(cmd))
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout, env=env)
        if proc.returncode != 0:
            _op["error"] = (proc.stderr or proc.stdout)[-400:].strip()
            log.warning("%s failed: %s", verb, _op["error"])
            return
        # ...and make it reachable from his other devices, live. Non-fatal:
        # a running instance he can only reach on the host still beats a
        # failed start.
        if verb == "home_up":
            _expose_home_route()
        _op["error"] = None
        log.info("%s: done", verb)
    except Exception as e:
        _op["error"] = str(e)[:400]
        log.exception("%s crashed", verb)
    finally:
        _op["verb"] = None


def _service_mount(service: str, dest: str) -> dict:
    """The current host source of `service`'s store (the mount at `dest`), so a
    relocate knows what to migrate FROM. Returns {type, name, source} or {} if
    there is no container yet (fresh install / profile off → nothing to move)."""
    proc = subprocess.run(
        ["docker", "ps", "-a",
         "--filter", f"label=com.docker.compose.project={PROJECT}",
         "--filter", f"label=com.docker.compose.service={service}",
         "--format", "{{.ID}}"],
        capture_output=True, text=True, timeout=10)
    cid = proc.stdout.strip().splitlines()
    if not cid:
        return {}
    fmt = ('{{range .Mounts}}{{if eq .Destination "%s"}}'
           '{{.Type}}|{{.Name}}|{{.Source}}{{end}}{{end}}') % dest
    ins = subprocess.run(["docker", "inspect", "--format", fmt, cid[0].strip()],
                         capture_output=True, text=True, timeout=10)
    parts = ins.stdout.strip().split("|")
    if len(parts) != 3 or not parts[0]:
        return {}
    return {"type": parts[0], "name": parts[1], "source": parts[2]}


def _migrate_service(m: dict, target: str):
    """Relocate one managed service to `target` (or back to its default volume
    when target is ""). Skips services with no container (e.g. the voice
    profile isn't running). Copy is NON-DESTRUCTIVE and only fills an empty
    destination, so the old store survives and a populated target is adopted."""
    svc, dest, profile = m["service"], m["dest"], m["profile"]
    state = _container_state(svc)
    if not state["present"]:
        log.info("relocate[%s]: no container (profile off) — skipped", svc)
        return
    cur = _service_mount(svc, dest)
    new_bind = os.path.join(target, m["sub"]) if target else ""

    if target and cur.get("type") == "bind" and cur.get("source") == new_bind:
        log.info("relocate[%s]: already at %s", svc, new_bind)
        return

    if target:
        # copy the current store into the new path IF that path is empty
        src_mount = (f"{cur['name']}:/from:ro" if cur.get("type") == "volume"
                     else f"{cur['source']}:/from:ro" if cur.get("source")
                     else "")
        if src_mount:
            log.info("relocate[%s]: copy %s -> %s (if empty)", svc,
                     cur.get("name") or cur.get("source"), new_bind)
            cp = subprocess.run(
                ["docker", "run", "--rm", "-v", src_mount, "-v",
                 f"{new_bind}:/to", "alpine", "sh", "-c",
                 'mkdir -p /to && [ -z "$(ls -A /to)" ] && cp -a /from/. /to/ '
                 '|| echo "target not empty — adopting as-is"'],
                capture_output=True, text=True, timeout=7200)
            if cp.returncode != 0:
                raise RuntimeError(f"{svc} copy failed: "
                                   + (cp.stderr or cp.stdout)[-300:].strip())

    # recreate the service bound to the new path (or default volume when target
    # is ""). Existing image is reused — the sidecar has no build context.
    _compose(["stop", svc], profile)
    _compose(["up", "-d", "--no-build", svc], profile)
    log.info("relocate[%s]: now bound to %s", svc, new_bind or "default volume")


def _relocate():
    """Move the bundled model store to the operator-chosen path (already written
    to /state/models_dir) and recreate every present model service bound there —
    ollama plus the kokoro/whisper voice services when they're running. Empty
    target resets to the default docker volumes. Each service migrates
    independently and NON-DESTRUCTIVELY: on any failure the old stores are still
    intact where they were."""
    target = _models_dir()
    try:
        for m in MANAGED:
            _migrate_service(m, target)
        _op["error"] = None
        log.info("relocate: done (%s)", target or "default volumes")
    except Exception as e:
        _op["error"] = str(e)[:400]
        log.exception("relocate failed")
    finally:
        _op["verb"] = None


def _compose(args: list, profile: str = "inference"):
    """Run a compose subprocess with the live model path injected; raise on
    non-zero so a relocate stops before recreating on a broken step."""
    proc = subprocess.run(_compose_cmd(profile) + args, capture_output=True,
                          text=True, timeout=1800, env=_compose_env())
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout)[-300:].strip())


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/gpu":
            try:
                return self._send(200, _gpu_info())
            except Exception as e:
                return self._send(500, {"error": str(e)[:400]})
        if self.path == "/vram":
            try:
                return self._send(200, _vram_info())
            except Exception as e:
                return self._send(500, {"error": str(e)[:400]})
        if self.path == "/notify/status":
            try:
                return self._send(200, _notify_status())
            except Exception as e:
                return self._send(500, {"error": str(e)[:400]})
        if self.path == "/home/status":
            try:
                return self._send(200, _home_status())
            except Exception as e:
                return self._send(500, {"error": str(e)[:400]})
        if self.path.startswith("/reachable"):
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            svc = (q.get("service") or [""])[0]
            if not svc:
                return self._send(400, {"error": "service is required",
                                        "known": sorted(_service_names())})
            try:
                out = _reachable(svc)
                return self._send(404 if out.get("error") else 200, out)
            except Exception as e:
                return self._send(500, {"error": str(e)[:400]})
        if self.path.startswith("/logs"):
            # /logs?service=<name>&lines=<n> — the only endpoint here that
            # reads a parameter, validated against the project's own service
            # labels before it reaches a subprocess. See _service_logs.
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            svc = (q.get("service") or [""])[0]
            try:
                n = int((q.get("lines") or ["80"])[0])
            except ValueError:
                n = 80
            if not svc:
                return self._send(400, {"error": "service is required",
                                        "known": sorted(_service_names())})
            try:
                out = _service_logs(svc, n)
                return self._send(404 if out.get("error") else 200, out)
            except Exception as e:
                return self._send(500, {"error": str(e)[:400]})
        if self.path == "/gpu-stats":
            try:
                return self._send(200, _gpu_stats())
            except Exception as e:
                return self._send(500, {"error": str(e)[:400]})
        if self.path == "/containers":
            try:
                return self._send(200, _containers())
            except Exception as e:
                return self._send(500, {"error": str(e)[:400]})
        if self.path == "/service/redeploy/last":
            # READ AND CLEAR. Exactly one reader gets each verdict, so a
            # backend that restarts twice cannot report one redeploy twice.
            global _last_detached
            with _detached_lock:
                out, _last_detached = _last_detached, None
            return self._send(200, out or {"status": "none"})
        if self.path == "/disk":
            try:
                return self._send(200, _disk_info())
            except Exception as e:
                return self._send(500, {"error": str(e)[:400]})
        if self.path != "/status":
            return self._send(404, {"error": "not found"})
        try:
            state = _container_state()
        except Exception as e:
            return self._send(500, {"error": str(e)[:400]})
        self._send(200, {**state, "op": _op["verb"], "error": _op["error"],
                         "models_dir": _models_dir()})

    def do_POST(self):
        if self.path == "/relocate":
            verb = "relocate"
        elif self.path in ("/start", "/stop"):
            verb = self.path[1:]
        elif self.path in ("/notify/up", "/notify/down", "/notify/expose"):
            verb = {"/notify/up": "notify_up", "/notify/down": "notify_down",
                    "/notify/expose": "notify_expose"}[self.path]
        elif self.path in ("/home/up", "/home/down"):
            verb = {"/home/up": "home_up", "/home/down": "home_down"}[self.path]
        elif self.path == "/service/redeploy":
            # Synchronous for the same reason as `/sandbox/`: the answer is
            # "is it up on the new image", which is minutes away and is the
            # only thing worth returning. Outside `_lock` because a redeploy
            # of `coder` and an ollama toggle touch nothing in common, and
            # inside its own lock because two concurrent `compose up`s on one
            # project fight.
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
            except Exception as e:
                return self._send(400, {"error": f"unreadable body: {e}"})
            service = str(body.get("service") or "")
            if body.get("detach"):
                # For the one service whose redeploy kills its own caller. The
                # verdict is parked in `_last_detached` instead of returned,
                # because there will be nobody on this connection to receive
                # it. 202 here means REQUESTED and says so — it is not a claim
                # that anything worked.
                threading.Thread(target=_redeploy_detached, args=(service,),
                                 daemon=True).start()
                return self._send(202, {
                    "status": "requested", "service": service,
                    "detail": ("running in the background; the outcome is at "
                               "GET /service/redeploy/last, once, for whoever "
                               "asks first")})
            if not _redeploy_lock.acquire(blocking=False):
                return self._send(409, {
                    "error": "a redeploy is already in progress",
                    "detail": ("Two `compose up` runs against one project "
                               "race each other. Wait for the first.")})
            try:
                out = _redeploy(service)
                return self._send(400 if out.get("error") else 200, out)
            except Exception as e:
                return self._send(500, {"error": str(e)[:400]})
            finally:
                _redeploy_lock.release()
        elif self.path.startswith("/sandbox/"):
            # SYNCHRONOUS, unlike every other verb here. A sandbox run is the
            # answer to a question ("does her branch boot?") rather than a
            # state change to poll for, and the caller is a background task
            # that is already prepared to wait minutes. Handled before the
            # single-op lock below so a sandbox run and an ollama toggle do
            # not exclude each other — they touch nothing in common.
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
            except Exception as e:
                return self._send(400, {"error": f"unreadable body: {e}"})
            which = self.path.rsplit("/", 1)[-1]
            if which not in ("check", "down"):
                return self._send(404, {"error": "not found"})
            if not _sandbox_lock.acquire(blocking=False):
                return self._send(409, {
                    "error": "a sandbox run is already in progress",
                    "detail": ("Every run uses the same compose project, so a "
                               "second one would tear down the first. Wait for "
                               "it to finish rather than retrying.")})
            try:
                out = _sandbox(str(body.get("slug") or ""),
                               "down" if which == "down" else "check")
                return self._send(400 if out.get("error") else 200, out)
            except Exception as e:
                return self._send(500, {"error": str(e)[:400]})
            finally:
                _sandbox_lock.release()
        else:
            return self._send(404, {"error": "not found"})
        with _lock:
            if _op["verb"]:
                return self._send(
                    409, {"error": f"{_op['verb']} already in progress"})
            _op.update(verb=verb, error=None)
        if verb == "relocate":
            target = _relocate
        elif verb.startswith("notify_"):
            target = lambda: _run_notify(verb)  # noqa: E731
        elif verb.startswith("home_"):
            target = lambda: _run_home(verb)    # noqa: E731
        else:
            target = lambda: _run_op(verb)      # noqa: E731
        threading.Thread(target=target, daemon=True).start()
        self._send(202, {"status": f"{verb} requested"})

    def log_message(self, fmt, *args):
        pass  # request lines are noise; ops are logged explicitly


if __name__ == "__main__":
    log.info("inference-control listening on :%d (project=%s service=%s)",
             PORT, PROJECT, SERVICE)
    _md = _models_dir()
    log.info("model store: %s", f"{_md}/ollama" if _md else "default docker volume")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
