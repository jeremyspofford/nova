"""/api/v1/mcp — Settings → Connections, over the MCP servers store (S37a).

Adding a server here is the same path as her mcp_connect: the server is asked
what it offers before anything is saved, and a server that does not answer is
a 422 carrying the reason, with nothing written. Nothing here is a permission
(owner ruling 2026-09-03): she may replace or remove what is added here, and
when she does, the owner's Inbox says so (app/checks/mcp.py).

No response ever carries a token, a header value or a URL path:
`Server.view()` is the only shape returned, and `exc.reason` from the client
and the store is already credential-scrubbed at its own source (ruling T5-A).

A database refusal (the store's own ServerError for a write the database
itself refused) is never reported as "not found" — `test_server` and
`remove_server` look the name up first, so a 404 only ever means the name
truly is not connected; any other failure is a 422 carrying the store's
reason.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import db, identity
from app.identity import Person
from app.mcp import client
from app.mcp import servers as store

router = APIRouter(prefix="/api/v1/mcp", tags=["mcp"])

# Convenience only (plan decision P19): a preset fills the form, and nothing
# reads it to decide anything.
PRESETS: tuple[dict, ...] = (
    {
        "id": "github-ci",
        "label": "GitHub (CI)",
        "name": "github",
        "url": "https://api.githubcopilot.com/mcp/",
        "headers": {"X-MCP-Toolsets": "actions"},
        "token_hint": (
            "A fine-grained personal access token with Actions: Read on the repositories she "
            "should watch (Metadata: Read comes with it)."
        ),
    },
)

# The rejected list is bounded like her tool's (controller amendment): a
# hostile server can declare thousands of broken tool definitions, and every
# name and reason here is already clipped at the client's own source (ruling
# T7-A2) — this bounds the COUNT returned, never their length.
REJECTED_LISTED_UP_TO = 20


class AddBody(BaseModel):
    name: str
    url: str
    token: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)


@router.get("/servers")
async def list_servers(person: Person = Depends(identity.require_person)) -> dict:
    pool = await db.get_pool()
    return {"servers": [server.view() for server in await store.list_servers(pool)]}


@router.get("/presets")
async def presets(person: Person = Depends(identity.require_person)) -> dict:
    return {"presets": list(PRESETS)}


@router.post("/servers")
async def add_server(body: AddBody, person: Person = Depends(identity.require_person)) -> dict:
    pool = await db.get_pool()
    try:
        done = await store.connect(
            pool,
            name=body.name,
            url=body.url,
            token=body.token,
            headers=body.headers,
            added_by=store.BY_OWNER,
            actor=person.name,
        )
    except store.ServerError as exc:
        raise HTTPException(status_code=422, detail=exc.reason) from exc
    rejected = [
        {"name": name, "reason": why} for name, why in done.rejected[:REJECTED_LISTED_UP_TO]
    ]
    return {
        "server": done.server.view(),
        "replaced": None
        if done.previous is None
        else {"origin": done.previous.origin, "added_by": done.previous.added_by},
        "rejected": rejected,
        "rejected_more": max(0, len(done.rejected) - REJECTED_LISTED_UP_TO),
        "notice": done.notice,
    }


@router.post("/servers/{name}/test")
async def test_server(name: str, person: Person = Depends(identity.require_person)) -> dict:
    pool = await db.get_pool()
    server = await store.get(pool, name)
    if server is None:
        raise HTTPException(status_code=404, detail=await store.no_such_server(pool, name))
    try:
        server = await store.refresh_tools(pool, server, actor=person.name, probe=True)
    except client.ClientError as exc:
        # `server` here is still the snapshot `refresh_tools` was GIVEN
        # (the assignment above never lands when it raises) — the Server
        # carry from Task 5 (ruling T5-E): record_call takes the Server, not
        # the bare name, and scrubs with THIS call's own credentials.
        await store.record_call(pool, server, ok=False, reason=exc.reason)
        raise HTTPException(status_code=422, detail=exc.reason) from exc
    except store.ServerError as exc:
        raise HTTPException(status_code=422, detail=exc.reason) from exc
    return {"server": server.view()}


@router.delete("/servers/{name}")
async def remove_server(name: str, person: Person = Depends(identity.require_person)) -> dict:
    pool = await db.get_pool()
    server = await store.get(pool, name)
    if server is None:
        raise HTTPException(status_code=404, detail=await store.no_such_server(pool, name))
    try:
        done = await store.disconnect(pool, name=name, by=store.BY_OWNER, actor=person.name)
    except store.ServerError as exc:
        # A database refusal is not "not found" (controller amendment): the
        # name is known to exist (checked above), so any ServerError from
        # disconnect itself is a 422 carrying its own reason, never a 404.
        raise HTTPException(status_code=422, detail=exc.reason) from exc
    return {"removed": done.server.name}
