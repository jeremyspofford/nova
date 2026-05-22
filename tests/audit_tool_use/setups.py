"""Setup strategies — create fixtures BEFORE a probe runs. Mirror of cleanups."""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import httpx
from audit_tool_use.types import Setup

NoSetup = Setup.NONE


@dataclass(frozen=True)
class SeedFile:
    """Seed a file inside the agent-core container so a fs.read probe finds it.

    The agent's /workspace is container-side; we write through `docker exec`
    so the path the probe references is the same filesystem the agent reads.
    """
    path: str
    content: str

    async def run(self, context: dict) -> tuple[bool, str | None]:
        from audit_tool_use.container import write_file_in_container
        ok, err = write_file_in_container(self.path, self.content)
        if not ok:
            return False, f"seed file failed: {err}"
        return True, None


@dataclass(frozen=True)
class SeedMemory:
    """POST a memory to memory-service so a memory.search-style probe finds it."""
    memory_url: str
    content: str
    source_kind: str = "audit_fixture"

    async def run(self, context: dict) -> tuple[bool, str | None]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.post(
                    f"{self.memory_url}/memories",
                    json={"content": self.content, "source_kind": self.source_kind, "tags": ["audit"]},
                )
            if r.status_code not in (200, 201):
                return False, f"seed memory returned {r.status_code}: {r.text[:200]}"
            return True, None
        except Exception as e:
            return False, str(e)


@dataclass(frozen=True)
class SeedSecret:
    """POST a secret to agent-core so a nova.secrets.read-style probe can resolve it."""
    base_url: str
    name: str
    value: str
    purpose: str = "audit_fixture"

    async def run(self, context: dict) -> tuple[bool, str | None]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.post(
                    f"{self.base_url}/api/v1/secrets",
                    json={"name": self.name, "value": self.value, "purpose": self.purpose},
                    headers=context.get("admin_headers", {}),
                )
            if r.status_code not in (200, 201):
                return False, f"seed secret returned {r.status_code}: {r.text[:200]}"
            return True, None
        except Exception as e:
            return False, str(e)
