"""Per-task Docker sandbox container lifecycle."""
import logging
import httpx
from ...config import settings

logger = logging.getLogger(__name__)

SANDBOX_IMAGE = "nova-sandbox:latest"
_containers: dict[str, str] = {}


async def ensure_sandbox(task_id: str) -> str:
    if task_id in _containers:
        return _containers[task_id]

    proxy = settings.docker_socket_proxy_url
    if not proxy:
        raise RuntimeError("DOCKER_SOCKET_PROXY_URL not set — sandbox unavailable")

    workspace = settings.nova_workspace

    async with httpx.AsyncClient(base_url=proxy, timeout=30.0) as client:
        r = await client.post("/containers/create", json={
            "Image": SANDBOX_IMAGE,
            "Cmd": ["sleep", "infinity"],
            "NetworkDisabled": True,
            "User": "sandbox",
            "HostConfig": {
                "Memory": 2 * 1024 ** 3,
                "NanoCpus": 2_000_000_000,
                "ReadonlyRootfs": True,
                "Tmpfs": {"/tmp": "size=256m,uid=1000"},
                "Binds": [f"{workspace}:/workspace.in:ro"],
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"],
            },
        })
        r.raise_for_status()
        container_id: str = r.json()["Id"]
        await client.post(f"/containers/{container_id}/start")

    _containers[task_id] = container_id
    logger.info("sandbox started container=%s task=%s", container_id[:12], task_id[:8])
    return container_id


async def run_in_sandbox(task_id: str, command: str, kind: str) -> dict:
    try:
        container_id = await ensure_sandbox(task_id)
    except Exception as exc:
        return {"error": f"Sandbox unavailable: {exc}", "exit_code": -1}

    proxy = settings.docker_socket_proxy_url
    async with httpx.AsyncClient(base_url=proxy, timeout=120.0) as client:
        r = await client.post(f"/containers/{container_id}/exec", json={
            "Cmd": ["sh", "-c", command],
            "AttachStdout": True,
            "AttachStderr": True,
            "User": "sandbox",
            "Tty": True,   # disables 8-byte stream-framing headers, returns raw bytes
        })
        r.raise_for_status()
        exec_id: str = r.json()["Id"]

        r = await client.post(f"/exec/{exec_id}/start", json={"Detach": False, "Tty": True})
        output = r.content.decode(errors="replace")

        r = await client.get(f"/exec/{exec_id}/json")
        exit_code: int = r.json().get("ExitCode", -1)

    return {"exit_code": exit_code, "output": output, "kind": kind}


async def stop_sandbox(task_id: str) -> None:
    cid = _containers.pop(task_id, None)
    if not cid:
        return
    proxy = settings.docker_socket_proxy_url
    try:
        async with httpx.AsyncClient(base_url=proxy, timeout=15.0) as client:
            await client.delete(f"/containers/{cid}?force=true")
        logger.info("sandbox removed container=%s task=%s", cid[:12], task_id[:8])
    except Exception as exc:
        logger.warning("sandbox removal failed container=%s: %s", cid[:12], exc)
