"""Async docker compose CLI wrapper for profiled services."""

import asyncio
import logging
import os

logger = logging.getLogger("nova.recovery.compose")

COMPOSE_PROJECT_DIR = os.getenv("COMPOSE_PROJECT_DIR", "/project")
COMPOSE_FILE = os.path.join(COMPOSE_PROJECT_DIR, "docker-compose.yml")
COMPOSE_PROJECT_NAME = os.getenv("COMPOSE_PROJECT_NAME", "nova")


async def _run_compose(*args: str) -> tuple[int, str, str]:
    """Run a docker compose command and return (returncode, stdout, stderr)."""
    # No GPU overlays — Nova bundles no inference container to accelerate.
    cmd = ["docker", "compose", "-f", COMPOSE_FILE, "-p", COMPOSE_PROJECT_NAME, *args]
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
