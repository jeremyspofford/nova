"""Setup strategies — create fixtures BEFORE a probe runs. Mirror of cleanups."""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import httpx
from audit_tool_use.types import Setup

NoSetup = Setup.NONE


@dataclass(frozen=True)
class SeedFile:
    """Write a file to disk so a fs.read-style probe has something to read."""
    path: str
    content: str

    async def run(self, context: dict) -> tuple[bool, str | None]:
        try:
            p = Path(self.path)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(self.content)
            return True, None
        except OSError as e:
            return False, f"seed file failed: {e}"


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
