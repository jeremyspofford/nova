"""Async docker compose CLI wrapper for profiled services."""

import asyncio
import logging
import os

logger = logging.getLogger("nova.recovery.compose")

COMPOSE_PROJECT_DIR = os.getenv("COMPOSE_PROJECT_DIR", "/project")
COMPOSE_PROJECT_NAME = os.getenv("COMPOSE_PROJECT_NAME", "nova")
ENV_FILE = os.getenv("NOVA_ENV_FILE", os.path.join(COMPOSE_PROJECT_DIR, ".env"))


def _compose_files() -> list[str]:
    """Resolve the compose file list, honoring a colon-separated COMPOSE_FILE.

    COMPOSE_FILE lives in the project .env (the installer writes the GPU
    overlay there: docker-compose.yml:docker-compose.gpu.yml). It's read per
    call so an .env change takes effect without restarting recovery.
    """
    value = os.getenv("COMPOSE_FILE", "")
    if not value:
        try:
            with open(ENV_FILE) as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("COMPOSE_FILE="):
                        value = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break
        except FileNotFoundError:
            pass
    if not value:
        return [os.path.join(COMPOSE_PROJECT_DIR, "docker-compose.yml")]
    return [
        f if os.path.isabs(f) else os.path.join(COMPOSE_PROJECT_DIR, f)
        for f in value.split(":") if f
    ]


async def _run_compose(*args: str) -> tuple[int, str, str]:
    """Run a docker compose command and return (returncode, stdout, stderr)."""
    cmd = ["docker", "compose"]
    for f in _compose_files():
        cmd += ["-f", f]
    cmd += ["-p", COMPOSE_PROJECT_NAME, *args]
    logger.info("Running: %s", " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=COMPOSE_PROJECT_DIR,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode or 0, stdout.decode(), stderr.decode()


async def start_profiled_service(profile: str, service: str) -> dict:
    """Start a profiled service via docker compose up -d.

    Uses --no-build because the recovery container lacks the full build
    context.  If the image hasn't been built yet, we detect it and return
    an actionable error message.
    """
    code, stdout, stderr = await _run_compose(
        "--profile", profile, "up", "-d", "--no-build", service,
    )
    if code != 0:
        err = stderr.strip()
        logger.error("compose up failed: %s", err)
        err_lower = err.lower()
        if "no such image" in err_lower or ("image" in err_lower and "not found" in err_lower):
            return {
                "ok": False,
                "error": (
                    f"Image for '{service}' not found. "
                    f"Build it on the host first: "
                    f"docker compose --profile {profile} build {service}"
                ),
            }
        if "is not healthy" in err_lower or "dependency" in err_lower:
            return {
                "ok": False,
                "error": (
                    f"Cannot start '{service}': a dependency is not healthy. "
                    f"Check that orchestrator and redis are running."
                ),
            }
        return {"ok": False, "error": err}
    return {"ok": True, "output": stdout.strip() or stderr.strip()}


async def stop_profiled_service(profile: str, service: str) -> dict:
    """Stop and remove a profiled service."""
    code, stdout, stderr = await _run_compose(
        "--profile", profile, "rm", "-sf", service,
    )
    if code != 0:
        logger.error("compose rm failed: %s", stderr)
        return {"ok": False, "error": stderr.strip()}
    return {"ok": True, "output": stdout.strip() or stderr.strip()}


async def profiled_service_status(service: str) -> str:
    """Return a compose service's container state ("running", "exited", …).

    Empty string when no container exists for the service.
    """
    code, stdout, _ = await _run_compose("ps", "--all", "--format", "json", service)
    if code != 0 or not stdout.strip():
        return ""
    import json as _json
    try:
        parsed = _json.loads(stdout)
        rows = parsed if isinstance(parsed, list) else [parsed]
    except _json.JSONDecodeError:
        # docker compose >= 2.21 emits one JSON object per line
        rows = []
        for line in stdout.strip().splitlines():
            try:
                rows.append(_json.loads(line))
            except _json.JSONDecodeError:
                continue
    for row in rows:
        if row.get("Service") == service or row.get("Name", "").endswith(service):
            return (row.get("State") or "").lower()
    return ""
