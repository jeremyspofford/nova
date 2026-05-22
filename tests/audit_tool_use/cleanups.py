"""Cleanup strategies. All best-effort: failure → warn, not fail."""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import httpx
from audit_tool_use.types import Cleanup

NoCleanup = Cleanup.NONE


@dataclass(frozen=True)
class DeleteFile:
    """Delete a file inside the agent-core container (idempotent — missing OK).

    Mirrors SeedFile / FileExists — all three operate via `docker exec` because
    /workspace is container-side, not host-mounted.
    """
    path: str

    async def cleanup(self, context: dict) -> tuple[bool, str | None]:
        from audit_tool_use.container import delete_file_in_container
        ok, err = delete_file_in_container(self.path)
        if not ok:
            return False, f"delete failed: {err}"
        return True, None


@dataclass(frozen=True)
class DeleteMemory:
    memory_url: str
    content_match: str

    async def cleanup(self, context: dict) -> tuple[bool, str | None]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.post(
                    f"{self.memory_url}/memories/search",
                    json={"query": self.content_match, "limit": 50},
                )
                if r.status_code != 200:
                    return False, f"search returned {r.status_code}"
                # memory-service wraps results in {"results": [...]}
                body = r.json()
                results = body.get("results", body) if isinstance(body, dict) else body
                for m in results:
                    if self.content_match in (m.get("content") or ""):
                        await client.delete(f"{self.memory_url}/memories/{m['id']}")
            return True, None
        except Exception as e:
            return False, str(e)


@dataclass(frozen=True)
class DeleteSecret:
    base_url: str
    name: str

    async def cleanup(self, context: dict) -> tuple[bool, str | None]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.delete(
                    f"{self.base_url}/api/v1/secrets/{self.name}",
                    headers=context.get("admin_headers", {}),
                )
            if r.status_code not in (200, 204, 404):
                return False, f"delete returned {r.status_code}"
            return True, None
        except Exception as e:
            return False, str(e)
