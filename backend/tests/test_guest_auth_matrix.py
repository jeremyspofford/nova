"""The live auth matrix: what a guest token actually gets through the app.

    docker compose exec backend python tests/test_guest_auth_matrix.py

`test_guest_sessions.py` proves the PIECES — the time box, the wipe, the
route marker. This one drives the assembled ASGI application, so it also
proves the two things a unit test cannot: that `auth_middleware`'s new branch
is reached at all, and that it runs BEFORE anything else can answer.

The plan (docs/plans/public-access-and-guests.md §3) says why that ordering is
the whole feature:

    "A guest branch added without simultaneous route-role gating hands guests
     /api/v1/auth/token — which returns the *admin* token — and
     /api/v1/secrets/{name}/reveal. A guest token that reaches those routes is
     an admin token."

So the matrix below asks, over the real middleware stack:

  * no token            -> 401
  * the admin token     -> 200
  * a guest token       -> 200 on the four guest routes, 403 on everything else
  * an EXPIRED guest    -> 401, on a guest route
  * a REVOKED guest     -> 401
  * a guest token on `GET /api/v1/auth/token` -> 403, and the admin token is
    NOT in the body. That is the specific hole, asserted by its consequence
    rather than by its status code.

Throwaway database, throwaway memory root, both repointed BEFORE the first
app import — pydantic reads the environment once.
"""

import asyncio
import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []
DB_NAME = f"nova_gauth_{uuid.uuid4().hex[:8]}"
SCRATCH = tempfile.mkdtemp(prefix="nova-guest-auth-")
os.environ["OKF_MEMORY_DIR"] = str(Path(SCRATCH) / "memory")
# The matrix is meaningless on an install with no token (that install is
# open), and it must not depend on the operator's real one either.
os.environ["NOVA_AUTH_TOKEN"] = "suite-admin-token-" + uuid.uuid4().hex
# Localhost trust would make every request operator regardless of headers,
# which is exactly the confound this matrix is about.
os.environ["NOVA_TRUST_LOCALHOST"] = "false"

ADMIN = os.environ["NOVA_AUTH_TOKEN"]
# a Host the app answers to; anything else is a 400 before auth is consulted
HOST = "localhost:8000"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _admin_url() -> str:
    return os.environ["DATABASE_URL"].rsplit("/", 1)[0] + "/postgres"


async def _make_db() -> None:
    import asyncpg
    admin = await asyncpg.connect(_admin_url())
    await admin.execute(f'CREATE DATABASE "{DB_NAME}"')
    await admin.close()
    os.environ["DATABASE_URL"] = (
        os.environ["DATABASE_URL"].rsplit("/", 1)[0] + "/" + DB_NAME)


async def _drop_db() -> None:
    import asyncpg
    admin = await asyncpg.connect(_admin_url())
    await admin.execute(f'DROP DATABASE IF EXISTS "{DB_NAME}" WITH (FORCE)')
    await admin.close()


async def run() -> None:
    import httpx
    from app import db, guests, settings_store
    from app.main import app
    await db.init_pool()
    await db.run_migrations()
    await settings_store.warm()

    transport = httpx.ASGITransport(app=app)

    async def call(method, path, token=None, json=None):
        headers = {"host": HOST}
        if token:
            headers["authorization"] = f"Bearer {token}"
        async with httpx.AsyncClient(transport=transport,
                                     base_url="http://localhost:8000") as c:
            return await c.request(method, path, headers=headers, json=json)

    session = await guests.mint("matrix guest", minutes=30,
                                allowed_models=["ollama:qwen3:8b"])
    gtok = session["token"]

    print("1. the wall is still a wall")
    r = await call("GET", "/api/v1/settings")
    check("no token is 401", r.status_code == 401, str(r.status_code))
    r = await call("GET", "/api/v1/settings", ADMIN)
    check("the admin token is 200", r.status_code == 200, str(r.status_code))

    print("2. a guest reaches its own four routes")
    for path in ("/api/v1/guest/session", "/api/v1/conversations/active"):
        r = await call("GET", path, gtok)
        check(f"guest 200 on GET {path}", r.status_code == 200,
              f"{r.status_code} {r.text[:120]}")
    r = await call("GET", "/api/v1/guest/session", gtok)
    body = r.json()
    check("the session describes itself honestly",
          body.get("allowed_models") == ["ollama:qwen3:8b"], str(body))
    check("...and names the model it will actually run",
          body.get("model") == "ollama:qwen3:8b", str(body))

    print("3. a guest is refused on every operator route")
    matrix = [
        ("GET", "/api/v1/auth/token"),
        ("GET", "/api/v1/secrets"),
        ("POST", "/api/v1/secrets/anything/reveal"),
        ("GET", "/api/v1/settings"),
        ("GET", "/api/v1/agents"),
        ("GET", "/api/v1/models"),
        ("GET", "/api/v1/traces"),
        ("GET", "/api/v1/guests"),
        ("POST", "/api/v1/guests"),
        ("GET", "/api/v1/memory/graph"),
        ("GET", "/api/v1/files/roots"),
        ("POST", "/api/v1/commands/backup"),
        ("GET", "/api/v1/voice/wake-status"),
        ("POST", "/api/v1/attachments"),
        ("GET", "/api/v1/backups"),
        ("GET", "/api/v1/automations"),
        ("GET", "/api/v1/consents/pending"),
        ("GET", "/api/v1/goals"),
        ("GET", "/api/v1/recommendations"),
        ("GET", "/api/v1/health/services"),
    ]
    for method, path in matrix:
        r = await call(method, path, gtok)
        check(f"guest refused on {method} {path}", r.status_code == 403,
              f"{r.status_code} {r.text[:100]}")

    print("4. the specific hole the plan named")
    r = await call("GET", "/api/v1/auth/token", gtok)
    check("a guest asking for the admin token gets 403", r.status_code == 403,
          str(r.status_code))
    check("...and the admin token is NOT in the body it got back",
          ADMIN not in r.text, r.text[:120])
    # ...and the route really does hand out the admin token to the operator,
    # so the check above is testing something that exists.
    r = await call("GET", "/api/v1/auth/token", ADMIN)
    check("the route really does return the admin token to the operator",
          ADMIN in r.text, f"{r.status_code} {r.text[:60]}")

    print("5. a guest cannot read the operator's conversation")
    from app import conversations
    op = await conversations.get_or_create_active_conversation()
    r = await call("GET", f"/api/v1/conversations/{op['id']}/messages", gtok)
    check("guest 403 on the operator's transcript", r.status_code == 403,
          f"{r.status_code} {r.text[:100]}")
    r = await call("GET", "/api/v1/conversations/active", gtok)
    gid = r.json()["id"]
    check("...and the active conversation it IS given is not his",
          gid != op["id"], f"{gid} vs {op['id']}")
    r = await call("GET", f"/api/v1/conversations/{gid}/messages", gtok)
    check("...but its own transcript is readable", r.status_code == 200,
          f"{r.status_code} {r.text[:100]}")

    print("6. the time box, over the wire")
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE guest_sessions SET created_at = now() - interval '2 hours', "
            "expires_at = now() - interval '1 second' WHERE id = $1",
            uuid.UUID(session["id"]))
    r = await call("GET", "/api/v1/guest/session", gtok)
    check("an expired guest token is 401", r.status_code == 401, str(r.status_code))
    check("...and is told why, without naming anything else",
          "expired" in r.text or "revoked" in r.text, r.text[:120])

    other = await guests.mint("revoke me", minutes=30, allowed_models=["m"])
    r = await call("GET", "/api/v1/guest/session", other["token"])
    check("a fresh second guest works", r.status_code == 200, str(r.status_code))
    await guests.revoke(other["id"])
    r = await call("GET", "/api/v1/guest/session", other["token"])
    check("a revoked guest token is 401", r.status_code == 401, str(r.status_code))

    print("7. a guest token never becomes an admin token")
    r = await call("GET", "/api/v1/settings", guests.TOKEN_PREFIX + "made-up")
    check("an unknown guest-shaped token is 401, not 'wrong admin token'",
          r.status_code == 401, str(r.status_code))
    # the important half: it must not fall through to any operator path
    check("...and it did not reach the route", "sections" not in r.text,
          r.text[:100])

    print("8. minting is operator-only, and the token is shown once")
    r = await call("POST", "/api/v1/guests", ADMIN,
                   json={"label": "from the api", "minutes": 15,
                         "allowed_models": ["ollama:qwen3:8b"]})
    check("the operator can mint", r.status_code == 201, f"{r.status_code} {r.text[:120]}")
    minted = r.json()
    check("the response carries the raw token", str(minted.get("token", "")).startswith(
        guests.TOKEN_PREFIX), str(minted)[:120])
    r = await call("GET", "/api/v1/guests", ADMIN)
    listed = next(g for g in r.json()["guests"] if g["id"] == minted["id"])
    check("...and the listing never shows it again",
          minted["token"] not in str(listed), str(listed)[:160])
    r = await call("POST", "/api/v1/guests", ADMIN,
                   json={"label": "no models", "minutes": 15, "allowed_models": []})
    check("minting with no model named is refused", r.status_code == 422,
          str(r.status_code))
    r = await call("POST", "/api/v1/guests", ADMIN,
                   json={"label": "forever", "minutes": 0,
                         "allowed_models": ["ollama:qwen3:8b"]})
    check("minting with no time box is refused", r.status_code == 422,
          str(r.status_code))

    print("9. a guest's turn writes into a sandbox, over the real stream")
    # THE CHECK THAT CANNOT BE REASONED ABOUT. `memory.sandbox` is a
    # contextvar bound inside an async generator that Starlette iterates
    # later, on its own — so whether the binding survives from the first
    # `__anext__` to the end-of-turn journal write is a property of the
    # runtime, not of the code reading well. If it does not, a guest's
    # conversation is written into the operator's memory, which is the
    # opposite of what this lane is for. The model round is stubbed; the
    # whole HTTP path, the generator, and the persistence are real.
    from app import conversations as convs
    from app import router_chat
    from app.config import settings

    async def fake_run_agent(agent, turn_messages, **kw):
        yield {"type": "text", "text": "sky is teal"}
        yield {"type": "final", "text": "sky is teal"}

    live = await guests.mint("stream probe", minutes=30,
                             allowed_models=["ollama:qwen3:8b"])
    real_run = router_chat.agent_runner.run_agent
    router_chat.agent_runner.run_agent = fake_run_agent
    try:
        r = await call("POST", "/api/v1/chat/stream", live["token"],
                       json={"message": "what colour is the sky"})
        body = r.text
    finally:
        router_chat.agent_runner.run_agent = real_run
    check("the guest's turn streamed", r.status_code == 200 and "[DONE]" in body,
          f"{r.status_code} {body[:160]}")
    check("...and the reply came back on it", "sky is teal" in body, body[:200])

    groot = guests.memory_root(live["id"])
    guest_notes = [p for p in groot.rglob("*.md")
                   if "sky is teal" in p.read_text(errors="ignore")]
    check("the turn was journalled into the GUEST's namespace",
          bool(guest_notes), str(groot))
    real_root = Path(settings.okf_memory_dir).resolve()
    leaked = [p for p in real_root.rglob("*.md")
              if "sky is teal" in p.read_text(errors="ignore")]
    check("...and NOWHERE in the operator's memory dir", not leaked, str(leaked))

    # and the transcript is in the guest's conversation, not the operator's
    op2 = await convs.get_or_create_active_conversation()
    async with db.acquire() as conn:
        in_op = await conn.fetchval(
            "SELECT count(*) FROM messages WHERE conversation_id = $1 "
            "AND content LIKE '%sky%'", uuid.UUID(op2["id"]))
    check("the guest's words are not in the operator's conversation",
          in_op == 0, str(in_op))

    print("10. the binding does not outlive the turn")
    # A contextvar set inside a generator can leak into whatever runs next in
    # the same task. Proven by writing as the OPERATOR immediately after, and
    # checking it landed in the real store.
    from app.memory.memory import memory as memory_proxy
    await memory_proxy.write("operator note after a guest turn",
                             type="topic", title="after-guest")
    check("an operator write after a guest turn lands in the real store",
          any(p.name.startswith("after-guest") for p in real_root.rglob("*.md")),
          str(real_root))
    check("...and not in the guest's namespace",
          not any(p.name.startswith("after-guest") for p in groot.rglob("*.md")))

    await db.close_pool()


def main() -> int:
    asyncio.run(_make_db())
    try:
        asyncio.run(run())
    finally:
        asyncio.run(_drop_db())
        shutil.rmtree(SCRATCH, ignore_errors=True)
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
