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
# auto: merge the GPU override when the docker NVIDIA runtime exists;
# on/off force it either way (operator escape hatch for broken drivers)
OLLAMA_GPU = os.environ.get("OLLAMA_GPU", "auto").lower()
PROJECT = os.environ.get("COMPOSE_PROJECT", "nova")
SERVICE = "ollama"
PORT = 9911


def _use_gpu_file() -> bool:
    if OLLAMA_GPU == "off" or not os.path.exists(GPU_COMPOSE_FILE):
        return False
    if OLLAMA_GPU == "on":
        return True
    try:
        return _gpu_info()["nvidia_runtime"]
    except Exception:
        return False


def _compose_cmd() -> list:
    cmd = ["docker", "compose", "-f", COMPOSE_FILE]
    if _use_gpu_file():
        cmd += ["-f", GPU_COMPOSE_FILE]
    return cmd + ["--profile", "inference"]

_lock = threading.Lock()
_op: dict = {"verb": None, "error": None}


def _container_state() -> dict:
    proc = subprocess.run(
        ["docker", "ps", "-a",
         "--filter", f"label=com.docker.compose.project={PROJECT}",
         "--filter", f"label=com.docker.compose.service={SERVICE}",
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
        capture_output=True, text=True, timeout=20)
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
                              timeout=timeout)
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
        if self.path != "/status":
            return self._send(404, {"error": "not found"})
        try:
            state = _container_state()
        except Exception as e:
            return self._send(500, {"error": str(e)[:400]})
        self._send(200, {**state, "op": _op["verb"], "error": _op["error"]})

    def do_POST(self):
        if self.path not in ("/start", "/stop"):
            return self._send(404, {"error": "not found"})
        verb = self.path[1:]
        with _lock:
            if _op["verb"]:
                return self._send(
                    409, {"error": f"{_op['verb']} already in progress"})
            _op.update(verb=verb, error=None)
        threading.Thread(target=_run_op, args=(verb,), daemon=True).start()
        self._send(202, {"status": f"{verb} requested"})

    def log_message(self, fmt, *args):
        pass  # request lines are noise; ops are logged explicitly


if __name__ == "__main__":
    log.info("inference-control listening on :%d (project=%s service=%s)",
             PORT, PROJECT, SERVICE)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
