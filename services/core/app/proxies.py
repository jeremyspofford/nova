"""Wizard passthroughs to the gateway.

Ruling R8: the browser only ever talks to core, so the wizard's hardware,
model and backend calls arrive here and are forwarded 1:1 over core's
gateway link. Nothing is interpreted on the way through — the gateway's
status and body are the answer, including its refusals. GET /routes and the
Jev Router switch are the exception: chat.model is a fact only core holds,
so they state it to the gateway, and the switch writes it back when the
gateway's answer names what it must become. GET /routes/explain is the
other: for the decision role it states the owner's two decision switches.
"""

from __future__ import annotations

import asyncio
import json
import logging
from urllib.parse import unquote_plus, urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.responses import Response

from app import chat, db, decisions, peers, settings_store

router = APIRouter(prefix="/api/v1", tags=["wizard"])
logger = logging.getLogger("core")

ADMIN_TIMEOUT = httpx.Timeout(5.0)
# The gateway's own probe work is bounded by its own PROBE_TIMEOUT=30.0
# (services/gateway/app/admin.py) plus a DB insert after — the READ side of
# this has to comfortably dominate that whole downstream budget, or a
# cold-model probe the gateway is still legitimately working on times out
# here first and gets reported as if the gateway itself were unreachable.
# Connect/write/pool stay at the same 5s as every other admin route: a
# dead gateway (nothing answering the TCP connect at all) is a fast, cheap
# fact, not something a 35s-wide flat timeout should make the wizard wait
# out — only the "still answering, just slow" case needs the wide budget.
PROBE_TIMEOUT = httpx.Timeout(connect=5.0, read=35.0, write=5.0, pool=5.0)
# verify_live's own inner liveness check is httpx.Timeout(5.0)
# (services/gateway/app/backends.py) plus a DB write after saving — same
# reasoning, smaller downstream budget, same tight connect/write/pool.
BACKEND_PUT_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)
# A pull can spend minutes between progress lines, so only the connect
# phase is bounded — a slow download is not a hang.
PULL_TIMEOUT = httpx.Timeout(connect=5.0, read=None, write=10.0, pool=5.0)


def _unreachable(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=502, detail=f"the gateway is unreachable — {peers.reason(exc)}"
    )


def _timed_out(path: str, timeout: httpx.Timeout) -> HTTPException:
    """A ReadTimeout is not the same fact as an unreachable gateway — the
    gateway answered the connection and may still be genuinely working (a
    cold-model probe, a slow verify-then-save); naming the route and the
    budget it was given says what actually happened instead of implying the
    gateway is down."""
    budget = "an unbounded read" if timeout.read is None else f"{timeout.read:g}s"
    return HTTPException(
        status_code=502, detail=f"the gateway timed out — {path} did not answer within {budget}"
    )


def _forward_headers(request: Request) -> dict[str, str]:
    content_type = request.headers.get("content-type")
    return {"content-type": content_type} if content_type else {}


async def _timezone_header() -> dict[str, str]:
    """The owner's zone on every gateway admin call (S10): the gateway keeps
    no settings, and its monthly caps reset on THIS zone's first."""
    try:
        zone = await settings_store.read_value(await db.get_pool(), "nova.timezone")
    except Exception:  # noqa: BLE001 — UTC is always a fact
        zone = None
    return {peers.HEADER_TIMEZONE: str(zone or "UTC")}


def _query_without(query: bytes, keys: frozenset[str]) -> bytes:
    """`query` with every parameter named in `keys` taken out — its name
    read the way the gateway reads it, percent- and plus-decoded, so an
    encoded spelling is taken out too — and every other part byte for byte."""

    def name(part: bytes) -> str:
        return unquote_plus(part.split(b"=", 1)[0].decode("latin-1"))

    return b"&".join(part for part in query.split(b"&") if name(part) not in keys)


def _target(
    request: Request,
    path: str,
    params: dict[str, str] | None = None,
    *,
    drop: frozenset[str] = frozenset(),
) -> httpx.URL:
    """The gateway path with this request's query string, byte for byte.

    Passed as raw bytes rather than re-parsed parameters so that whatever
    the browser sent — encodings included — is what the gateway sees.
    `params` are core's own, encoded after the browser's bytes and never
    mixed into them; `drop` names parameters only core may state, taken out
    of the browser's bytes first.
    """
    query = request.scope.get("query_string") or b""
    if drop:
        query = _query_without(query, drop)
    if params:
        query = b"&".join(part for part in (query, urlencode(params).encode()) if part)
    return httpx.URL(path, query=query) if query else httpx.URL(path)


async def _forward(
    request: Request,
    method: str,
    path: str,
    *,
    timeout: httpx.Timeout = ADMIN_TIMEOUT,
    content: bytes | None = None,
    params: dict[str, str] | None = None,
    drop: frozenset[str] = frozenset(),
) -> Response:
    """The request as the gateway gets it, and the gateway's answer as it
    came. `content` stands in for the request's own body and `params` are
    added after its query string — for a route that must state a fact only
    core holds, whose parameters (`drop`) are first taken out of the
    browser's query."""
    body = await request.body() if content is None else content
    try:
        async with peers.client(request.app, peers.GATEWAY, timeout) as client:
            upstream = await client.request(
                method,
                _target(request, path, params, drop=drop),
                content=body or None,
                headers={**_forward_headers(request), **(await _timezone_header())},
            )
    except httpx.ReadTimeout as exc:
        raise _timed_out(path, timeout) from exc
    except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
        raise _unreachable(exc) from exc
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )


@router.get("/system/hardware")
async def hardware(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/hardware")


@router.get("/models/suggest")
async def suggest(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/suggest")


# ── the model catalogue (S10a): Hugging Face search, a repo's quants, a
# typed ref resolved live — forwarded 1:1, query string byte-for-byte. The
# catalogue itself (GET /models/catalog) is NOT a bare forward: core adds
# the one fact only it holds (eval measurements) — see app/models_catalog.py.
CATALOG_HF_TIMEOUT = httpx.Timeout(connect=5.0, read=25.0, write=5.0, pool=5.0)


@router.get("/models/catalog/hf")
async def catalog_hf(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/catalog/hf", timeout=CATALOG_HF_TIMEOUT)


@router.get("/models/catalog/hf/{org}/{repo}")
async def catalog_hf_repo(org: str, repo: str, request: Request) -> Response:
    return await _forward(
        request, "GET", f"/admin/catalog/hf/{org}/{repo}", timeout=CATALOG_HF_TIMEOUT
    )


@router.get("/models/catalog/resolve")
async def catalog_resolve(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/catalog/resolve", timeout=CATALOG_HF_TIMEOUT)


# ── spend (S10): the ledger's rollups, events, caps and owner prices —
# forwarded 1:1 with the owner's zone. GET /api/v1/spend itself is a real
# handler in app/spend_api.py (it names the people).
@router.get("/spend/events")
async def spend_events(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/spend/events")


@router.get("/spend/caps")
async def spend_caps(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/spend/caps")


@router.put("/spend/caps")
async def put_spend_cap(request: Request) -> Response:
    return await _forward(request, "PUT", "/admin/spend/caps")


@router.get("/spend/prices")
async def spend_prices(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/spend/prices")


@router.put("/spend/prices")
async def put_spend_price(request: Request) -> Response:
    return await _forward(request, "PUT", "/admin/spend/prices")


@router.delete("/spend/prices")
async def delete_spend_price(request: Request) -> Response:
    return await _forward(request, "DELETE", "/admin/spend/prices")


# ── routing (S10-2): the role chains, the walk explained, the walls.
#
# chat.model is link 1 of every role whose turns send it (chat.CHAT_MODEL_ROLES),
# and the gateway reads none of core's settings — so the Jev Router switch
# (decision-role spec §4), which must read what those turns actually reach, is
# told it on both of its routes.
async def _chat_model() -> str:
    """chat.model, or '' when it names none (the gateway's default)."""
    return str(await settings_store.read_value(await db.get_pool(), "chat.model") or "")


#: The parameters GET /routes states chat.model in: core's alone to state.
CHAT_MODEL_PARAMS = frozenset({"chat_model", "chat_model_roles"})


async def _chat_model_params(chat_model: str | None = None) -> dict[str, str]:
    """`?chat_model=` and the roles it is link 1 of, or nothing while it is
    empty. `chat_model` is a value the caller already read, so one handler
    states the same chat.model it acts on."""
    if chat_model is None:
        chat_model = await _chat_model()
    if not chat_model:
        return {}
    return {"chat_model": chat_model, "chat_model_roles": ",".join(chat.CHAT_MODEL_ROLES)}


# Every write that moves chat.model together with a chain — a pick, and the
# Jev Router switch on a role whose turns send chat.model — runs one at a
# time: each reads chat.model and the chain, then writes, and two of them
# interleaving would each write from a read the other had already made stale.
_PICK_LOCK = asyncio.Lock()


@router.get("/routes")
async def routes(request: Request) -> Response:
    """Every role's chain, and the Jev Router switch's state where it is
    offered — read with chat.model as link 1 of the roles whose turns send it.
    chat.model is a fact only core holds, as on the switch (_switch_body): a
    browser's own `chat_model` or `chat_model_roles` never reaches the
    gateway, whether core states its own or, with chat.model empty, none."""
    return await _forward(
        request,
        "GET",
        "/admin/routes",
        params=await _chat_model_params(),
        drop=CHAT_MODEL_PARAMS,
    )


async def _refuse_an_agent_role_with_no_agent(role: str) -> None:
    """An agent's role (`agent_<name>`, S12) is refused HERE when no such agent
    exists — the Routing page is the only production caller, so a typo is
    refused where the owner types it, by name, instead of becoming a chain
    nobody walks. Every other role is the gateway's to judge."""
    from app import agents  # function-local: agents imports the store, not the proxies

    if role.startswith(agents.ROLE_PREFIX):
        name = role[len(agents.ROLE_PREFIX) :]
        live = await agents.names(await db.get_pool())
        if name not in live:
            roles = ", ".join(agents.ROLE_PREFIX + n for n in live) or "none yet"
            raise HTTPException(
                status_code=400, detail=f"no agent named {name!r} — live agent roles: {roles}"
            )


@router.put("/routes/{role}")
async def put_route(role: str, request: Request) -> Response:
    """Set a role's chain; the gateway's built-ins, its ROLE_RE and its
    protocol check answer verbatim."""
    await _refuse_an_agent_role_with_no_agent(role)
    return await _forward(request, "PUT", f"/admin/routes/{role}")


async def _switch_body(request: Request, role: str) -> bytes:
    """The switch's body as the gateway gets it. `chat_model` is chat.model,
    a fact only core holds, and the gateway takes it as core's — it would keep
    a client's value as the pick the router replaced and hand it back on OFF
    as chat.model. So whatever a client put there is dropped, for every role,
    and core states its own for a role whose turns send chat.model as link 1
    (none while it is empty). A body naming neither goes as it came, and so
    does one that is not a JSON object: the gateway refuses that in its own
    words."""
    raw = await request.body()
    try:
        body = json.loads(raw)
    except ValueError:
        return raw
    if not isinstance(body, dict):
        return raw
    stated = {key: value for key, value in body.items() if key != "chat_model"}
    chat_model = await _chat_model() if role in chat.CHAT_MODEL_ROLES else ""
    if chat_model:
        stated["chat_model"] = chat_model
    return raw if stated == body else json.dumps(stated).encode()


def _json_object(content: bytes) -> dict | None:
    """`content` as a JSON object, or None when it is not one."""
    try:
        parsed = json.loads(content)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


async def _write_chat_model(role: str, named: str) -> None:
    """chat.model, written as the switch's answer names it ('' is the
    gateway's default: a value, not an absence). Written through the settings
    writer PUT /settings uses, so it is checked exactly as a value typed there
    is. A write that fails is a 502 in words, never a 200 — the gateway keeps
    the link it would put back, so the switch still reads what the turns
    reach and can be flipped again."""
    try:
        await settings_store.write_setting(
            settings_store.SettingWrite(key="chat.model", value=named)
        )
    except Exception as exc:  # noqa: BLE001 - the reason is the answer
        reason = peers.reason(exc)
        logger.warning("jev router %s: chat.model could not be written — %s", role, reason)
        raise HTTPException(
            status_code=502,
            detail=(
                f"the gateway switched Jev Router, but chat.model could not be written — {reason}"
            ),
        ) from exc


async def _off_asked_again(request: Request, role: str, path: str) -> str | None:
    """The same OFF, sent once more now that chat.model is written: the
    switch reads off, so the gateway's OFF-while-off forgets the pick it kept
    for the chat model. None once it has answered 200; else why it did not,
    in the gateway's words."""
    try:
        again = await _forward(request, "PUT", path, content=await _switch_body(request, role))
    except HTTPException as exc:
        return str(exc.detail)
    if again.status_code == 200:
        return None
    said = _json_object(again.body) or {}
    return str(said.get("error") or f"the gateway answered {again.status_code}")


@router.put("/routes/{role}/jev-router")
async def put_jev_router(role: str, request: Request) -> Response:
    """The Jev Router switch (decision-role spec §4): an edit to the role's
    chain that the gateway makes and states, refusals included. For chat the
    cloud link can be chat.model itself, so the gateway's answer then names
    what chat.model must become, and core writes it before answering — for a
    role whose turns send chat.model and no other, and only off a 200.

    The gateway keeps the pick it replaced in the chat model until core has
    written it back, so an OFF whose write fails can be asked again. Once an
    OFF's chat model is written and the answer reads off, core sends the
    same OFF once more, and the gateway forgets that pick: a Jev Router
    picked by hand in chat later can never hand back a pick from this switch.
    The owner gets the first answer, which names the chat model; if the OFF
    asked again fails, the answer's note says so."""
    await _refuse_an_agent_role_with_no_agent(role)
    if role in chat.CHAT_MODEL_ROLES:
        async with _PICK_LOCK:
            return await _jev_router_switch(request, role)
    return await _jev_router_switch(request, role)


async def _jev_router_switch(request: Request, role: str) -> Response:
    """put_jev_router's work, under the pick lock for a chat-model role."""
    path = f"/admin/routes/{role}/jev-router"
    answer = await _forward(request, "PUT", path, content=await _switch_body(request, role))
    if answer.status_code != 200 or role not in chat.CHAT_MODEL_ROLES:
        return answer
    stated = _json_object(answer.body)
    named = stated.get("chat_model") if stated else None
    if not isinstance(named, str):
        return answer
    await _write_chat_model(role, named)
    router_now = stated.get("router")
    if not isinstance(router_now, dict) or router_now.get("on") is not False:
        # An ON, whose kept pick is the switch's live one — or an OFF that
        # left the switch on, whose next OFF forgets the pick anyway.
        return answer
    failed = await _off_asked_again(request, role, path)
    if failed is None:
        return answer
    logger.warning("jev router %s: the OFF asked again failed — %s", role, failed)
    said = (
        "chat.model is written, but asking the gateway to forget the model Jev Router "
        f"replaced failed — {failed}"
    )
    stated["note"] = f"{stated['note']}; {said}" if stated.get("note") else said
    return Response(content=json.dumps(stated), status_code=200, media_type="application/json")


async def _lists(request: Request, provider: str, model: str) -> bool:
    """Does `provider`'s own listing name `model`? False on any failure to
    read it — an unconfirmed model is never carried as a fallback."""
    try:
        answer = await _forward(
            request,
            "GET",
            f"/admin/providers/{provider}/models",
            content=b"",
            drop=CHAT_MODEL_PARAMS,
        )
    except HTTPException:
        return False
    if answer.status_code != 200:
        return False
    models = (_json_object(answer.body) or {}).get("models")
    return any(isinstance(m, dict) and m.get("id") == model for m in models or [])


def _gateway_words(answer: Response) -> str:
    """A gateway refusal's own words, for a note."""
    said = _json_object(answer.body) or {}
    words = said.get("error") or said.get("detail")
    return str(words) if words else f"the gateway answered {answer.status_code}"


@router.put("/routes/chat/primary")
async def put_chat_primary(request: Request) -> Response:
    """{model} becomes the chat model — link 1 of every chain chat.model
    leads — and the model it replaces becomes chat's FIRST fallback.

    The one write path for a pick: the chat picker, Models and Settings each
    wrote chat.model alone, so a pick replaced link 1 and the model it
    replaced was in no chain at all (2026-10-05: one pick in chat dropped the
    Dell's model, and nothing anywhere showed it). A model that is already a
    fallback leaves the fallbacks, so no chain names one model twice.

    The old pick is carried as the gateway reads it: a bare id (onboarding
    writes `qwen3:8b`) means the DEFAULT provider's model, so it is carried
    qualified with that provider's name — the gateway refuses a bare link in
    a chain. When the chain still cannot be stored (a link whose provider has
    since been removed), the pick is made anyway, as before this write
    existed, and the answer's `note` says what was not kept: a stale chain
    must never make every pick fail.

    While Jev Router holds chat's cloud link the switch owns that link, so a
    pick cannot run until it is off. The chain is read the way chat's turns
    walk it — with chat.model stated, as GET /routes reads it — so the switch
    reads true when it sits in the chat-model slot. A router the owner picked
    BY HAND (on, nothing kept) is a pick like any other, and replacing it is
    exactly what a pick is for."""
    try:
        body = await request.json()
    except ValueError:
        body = None
    model = body.get("model") if isinstance(body, dict) else None
    if not isinstance(model, str) or not model.strip():
        raise HTTPException(status_code=400, detail="name the model to pick: provider:model")
    model = model.strip()
    async with _PICK_LOCK:
        # chat.model is read ONCE: the switch state below and the pick carried
        # are judged against the same value.
        current = await _chat_model()
        listed = await _forward(
            request,
            "GET",
            "/admin/routes",
            content=b"",
            params=await _chat_model_params(current),
            drop=CHAT_MODEL_PARAMS,
        )
        if listed.status_code != 200:
            return listed
        roles = (_json_object(listed.body) or {}).get("roles")
        chat_row = next(
            (r for r in roles or [] if isinstance(r, dict) and r.get("role") == "chat"), None
        )
        if chat_row is None:
            raise HTTPException(status_code=502, detail="the gateway listed no chat route")
        router_state = chat_row.get("router") or {}
        if router_state.get("on") is True and router_state.get("kept") is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Jev Router is picking chat's cloud model — switch it off in Settings → "
                    "Models → Routing to pick one yourself"
                ),
            )
        known = await _forward(
            request, "GET", "/admin/providers", content=b"", drop=CHAT_MODEL_PARAMS
        )
        rows = (
            (_json_object(known.body) or {}).get("providers") if known.status_code == 200 else None
        )
        names = {
            r["name"] for r in rows or [] if isinstance(r, dict) and isinstance(r.get("name"), str)
        }
        default = next(
            (r["name"] for r in rows or [] if isinstance(r, dict) and r.get("is_default") is True),
            None,
        )

        def qualified(link: str) -> str:
            """`link` as the gateway resolves it (providers.split_model_id): a
            prefix naming a registered provider stays; anything else is the
            default provider's model."""
            prefix, colon, _ = link.partition(":")
            if colon and prefix in names:
                return link
            return f"{default}:{link}" if default else link

        stored = [link for link in chat_row.get("chain") or [] if isinstance(link, str)]
        note = None
        carry = None
        if current and qualified(current) != qualified(model):
            prefix, colon, _ = current.partition(":")
            if colon and prefix in names:
                carry = current
            elif default and await _lists(request, default, current):
                # A bare id (onboarding writes `qwen3:8b`): the gateway reads it
                # as the default provider's model and refuses it bare in a
                # chain, so it is carried qualified — once that provider was
                # seen to list it. A provider-qualified id whose provider is
                # gone looks the same and is NOT made up into `hub:dell:…`.
                carry = qualified(current)
            else:
                note = (
                    f"{current} names no registered provider"
                    + (f" and is not a model {default} lists" if default else "")
                    + ", so it was not kept as a fallback"
                )
        dropped = {qualified(model)} | ({carry} if carry else set())
        chain = [link for link in stored if qualified(link) not in dropped]
        if carry:
            chain = [carry, *chain]
        if chain != stored:
            written = await _forward(
                request, "PUT", "/admin/routes/chat", content=json.dumps({"chain": chain}).encode()
            )
            if written.status_code != 200:
                already = carry is not None and any(qualified(link) == carry for link in stored)
                kept_out = (
                    f"{current} was not kept as a fallback"
                    if carry and not already
                    else "the fallbacks are unchanged"
                )
                note = (
                    f"chat's fallbacks could not be saved — {_gateway_words(written)}; {kept_out}"
                )
                logger.warning("chat primary: %s", note)
                chain = stored
        if current != model:
            try:
                await settings_store.write_setting(
                    settings_store.SettingWrite(key="chat.model", value=model)
                )
            except Exception as exc:  # noqa: BLE001 - the reason is the answer
                reason = peers.reason(exc)
                logger.warning("chat primary: chat.model could not be written — %s", reason)
                raise HTTPException(
                    status_code=502,
                    detail=f"chat.model could not be written — {reason}",
                ) from exc
    answer: dict = {"chat_model": model, "chain": chain}
    if note:
        answer["note"] = note
    return Response(content=json.dumps(answer), status_code=200, media_type="application/json")


@router.delete("/routes/{role}")
async def delete_route(role: str, request: Request) -> Response:
    """Drop a role's chain row (S12-2). The gateway refuses a built-in and
    404s a role with no row; both come back verbatim. Used by the Routing
    page for a stray row (an agent that no longer exists)."""
    return await _forward(request, "DELETE", f"/admin/routes/{role}")


#: The parameter explain states the decision switches in: core's alone to state.
DECISION_KINDS_PARAMS = frozenset({"decision_kinds"})


@router.get("/routes/explain")
async def route_explain(request: Request) -> Response:
    """The walk a call for `?role=` would take right now. A decision call
    names the kinds of decision model the owner has switched on (decision-role
    spec §6), and the gateway reads none of core's settings — so the decision
    role's walk is explained with them too, and "right now: X would answer"
    names the link that would. A browser's own `decision_kinds` never reaches
    the gateway, for any role."""
    params: dict[str, str] = {}
    if (request.query_params.get("role") or "chat") == decisions.ROLE:
        kinds = await settings_store.decision_kinds(await db.get_pool())
        params["decision_kinds"] = decisions.kinds_value(kinds)
    return await _forward(
        request,
        "GET",
        "/admin/route/explain",
        timeout=CATALOG_HF_TIMEOUT,
        params=params,
        drop=DECISION_KINDS_PARAMS,
    )


@router.delete("/routes/walls/{provider}")
async def clear_wall(provider: str, request: Request) -> Response:
    return await _forward(request, "DELETE", f"/admin/routes/walls/{provider}")


@router.delete("/models")
async def remove_model(request: Request) -> Response:
    """Remove an installed model from the bundled ollama (`?model=`), verified
    by the gateway against /api/tags. 1:1."""
    return await _forward(request, "DELETE", "/admin/models", timeout=CATALOG_HF_TIMEOUT)


@router.post("/models/catalog/drift")
async def catalog_drift(request: Request) -> Response:
    """Has the source moved since a model was pulled (S10a-2)? 1:1."""
    return await _forward(request, "POST", "/admin/catalog/drift", timeout=CATALOG_HF_TIMEOUT)


@router.post("/models/probe")
async def probe(request: Request) -> Response:
    return await _forward(request, "POST", "/admin/probe", timeout=PROBE_TIMEOUT)


@router.get("/inference/backend")
async def get_backend(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/backend")


@router.get("/models")
async def list_models(request: Request) -> Response:
    """The gateway's OpenAI-compat GET /v1/models — not under /admin, since
    it is the data plane's own route (services/gateway/app/data_plane.py),
    but the browser still only ever reaches it through core (ruling R8).
    Settings -> Models uses this to know which curated slugs are already
    installed."""
    return await _forward(request, "GET", "/v1/models")


@router.put("/inference/backend")
async def put_backend(request: Request) -> Response:
    return await _forward(request, "PUT", "/admin/backend", timeout=BACKEND_PUT_TIMEOUT)


# ── the provider registry (S10-pre) — forwarded 1:1, ruling R8 ───────────
# Create/update run the gateway's verify-before-save (a live call to the
# provider), so their read budget dominates a slow provider's listing.
PROVIDER_WRITE_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=5.0, pool=5.0)
PROVIDER_LISTING_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=5.0, pool=5.0)


@router.get("/providers")
async def list_providers(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/providers")


@router.get("/providers/presets")
async def provider_presets(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/providers/presets")


@router.post("/providers")
async def create_provider(request: Request) -> Response:
    return await _forward(request, "POST", "/admin/providers", timeout=PROVIDER_WRITE_TIMEOUT)


@router.get("/providers/{name}")
async def get_provider(name: str, request: Request) -> Response:
    return await _forward(request, "GET", f"/admin/providers/{name}")


@router.put("/providers/{name}")
async def update_provider(name: str, request: Request) -> Response:
    return await _forward(
        request, "PUT", f"/admin/providers/{name}", timeout=PROVIDER_WRITE_TIMEOUT
    )


@router.delete("/providers/{name}")
async def delete_provider(name: str, request: Request) -> Response:
    return await _forward(request, "DELETE", f"/admin/providers/{name}")


@router.put("/providers/{name}/default")
async def make_default_provider(name: str, request: Request) -> Response:
    return await _forward(request, "PUT", f"/admin/providers/{name}/default")


@router.get("/providers/{name}/models")
async def provider_models(name: str, request: Request) -> Response:
    return await _forward(
        request, "GET", f"/admin/providers/{name}/models", timeout=PROVIDER_LISTING_TIMEOUT
    )


@router.post("/models/pull")
async def pull(request: Request) -> StreamingResponse:
    """Streamed through as it arrives — progress the wizard can show."""
    body = await request.body()
    try:
        client = peers.client(request.app, peers.GATEWAY, PULL_TIMEOUT)
        upstream = await client.send(
            client.build_request(
                "POST",
                _target(request, "/admin/pull"),
                content=body or None,
                headers=_forward_headers(request),
            ),
            stream=True,
        )
    except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
        raise _unreachable(exc) from exc

    async def relay():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        except httpx.HTTPError as exc:
            # The stream died partway: say so in the progress channel rather
            # than letting a truncated download look finished.
            reason = peers.reason(exc)
            logger.warning("model pull stream failed: %s", reason)
            yield json.dumps({"error": f"the pull stream failed — {reason}"}).encode() + b"\n"
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        relay(),
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )
