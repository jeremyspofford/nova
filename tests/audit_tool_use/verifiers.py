"""Verifier strategies — three concrete classes + a SKIP sentinel."""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import httpx
from audit_tool_use.types import Verifier

Skip = Verifier.SKIP


@dataclass(frozen=True)
class FileExists:
    """Verifies a file is on disk and contains an expected substring."""
    path: str
    expect_content_contains: str

    async def verify(self, context: dict) -> tuple[bool, str | None]:
        p = Path(self.path)
        if not p.exists():
            return False, f"file not found at {self.path}"
        body = p.read_text(errors="replace")
        if self.expect_content_contains not in body:
            return False, f"token {self.expect_content_contains!r} not present in file"
        return True, None


@dataclass(frozen=True)
class ResponseContains:
    """Verifies the model's final assistant text contains an expected token verbatim."""
    token: str

    async def verify(self, context: dict) -> tuple[bool, str | None]:
        text = context.get("final_response") or ""
        if self.token not in text:
            return False, f"token {self.token!r} not echoed in final response"
        return True, None


@dataclass(frozen=True)
class DbContains:
    """Verifies a record exists via service HTTP. No direct DB access.

    `endpoint` is a full URL; `query` is the POST body (or query-string params for GET);
    `expect_field` is a JSON path expression checked on the response.
    """
    endpoint: str
    query: dict
    expect_field: str  # e.g. "results.0.id"
    method: str = "POST"

    async def verify(self, context: dict) -> tuple[bool, str | None]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            if self.method == "POST":
                r = await client.post(self.endpoint, json=self.query, headers=context.get("admin_headers", {}))
            else:
                r = await client.get(self.endpoint, params=self.query, headers=context.get("admin_headers", {}))
        if r.status_code >= 400:
            return False, f"{self.endpoint} returned {r.status_code}: {r.text[:200]}"
        body = r.json()
        # Walk the dotted path (numerics indicate list indexing)
        node = body
        for part in self.expect_field.split("."):
            try:
                node = node[int(part)] if part.isdigit() else node[part]
            except (KeyError, IndexError, TypeError):
                return False, f"field path {self.expect_field!r} missing in response {body!r}"
        return True, None
