"""Nova inference-control sidecar — the only holder of the Docker socket.

The socket is root-equivalent on the host, so the backend never mounts it.
Instead this tiny service exposes exactly four fixed endpoints on the
compose-internal network (no published ports):

    GET  /status  -> {present, running, state, op, error}
    GET  /gpu     -> {nvidia_runtime}   (docker info runtime check)
    GET  /vram    -> {gpus: [{name, vram_total_gb}]}   (nvidia-smi in ollama)
    POST /start   -> docker compose --profile inference up -d ollama
    POST /stop    -> docker compose --profile inference stop ollama

Nothing is parameterized by the request: the compose file, project, and
service name are baked in. A fully compromised client can at worst toggle
the bundled ollama on and off. Start/stop shell out to compose against the
mounted docker-compose.yml, so operator edits to the ollama service (e.g. a
GPU reservation block) are honored without duplicating config here.
"""

import json
import logging
import os
import subprocess
import threading
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
PROJECT = os.environ.get("COMPOSE_PROJECT", "nova")
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


def _compose_cmd(profile: str = "inference") -> list:
    cmd = ["docker", "compose", "-f", COMPOSE_FILE]
    if _use_gpu_file():
        cmd += ["-f", GPU_COMPOSE_FILE]
    if _use_models_file():
        cmd += ["-f", MODELS_COMPOSE_FILE]
    return cmd + ["--profile", profile]

_lock = threading.Lock()
_op: dict = {"verb": None, "error": None}


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
