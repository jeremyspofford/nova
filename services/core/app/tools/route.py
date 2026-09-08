"""Her routing tool: why a role's call goes where it goes (S10-2).

Reads the gateway's explain walk — the same one the Routing page shows —
and says every link's verdict in words. Nothing is called, nothing is
charged; a fallback reason is the gateway's own sentence, quoted.
"""

from __future__ import annotations

import httpx

from app import db, peers, settings_store
from app.tools.base import Tool, ToolContext, ToolFailure

ROLES = ("chat", "scheduled", "judge", "coding", "vision")
EXPLAIN_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)


def describe(body: dict) -> str:
    role = body.get("role")
    chain = body.get("chain") or []
    serve = body.get("would_serve")
    # The answer FIRST, in one sentence — a small model reads the top line
    # and stops; the walk below is the evidence.
    if serve and serve.get("reason"):
        lines = [
            f"Answer: {serve.get('served_by')} serves the {role} role right now because it "
            f"{serve['reason']}."
        ]
    elif serve:
        lines = [
            f"Answer: {serve.get('served_by')} serves the {role} role right now (its first choice)."
        ]
    else:
        lines = [f"Answer: nothing can serve the {role} role right now — {body.get('reason')}."]
    lines.append(f"The {role} chain, link by link:")
    for v in chain:
        verdict = v.get("verdict")
        reason = v.get("reason")
        state = {
            "runnable": "would serve",
            "over_cap": "skipped — over its cap",
            "walled": "skipped — the provider refused recently",
            "not_installed": "skipped — not installed",
            "unreachable": "skipped — ollama could not be asked",
            "unknown": "skipped — no such provider",
            "refused": "refused this request",
        }.get(verdict, str(verdict))
        lines.append(
            f"  {v.get('link')}. {v.get('id')}: {state}" + (f" ({reason})" if reason else "")
        )
    return "\n".join(lines)


async def route_explain(args: dict, ctx: ToolContext) -> str:
    role = str(args.get("role") or "chat")
    if role not in ROLES:
        raise ToolFailure(f"role must be one of {', '.join(ROLES)}")
    params = {"role": role}
    model = str(args.get("model") or "")
    if not model and role == "chat":
        # The chat chain's link 1 is the model picked in chat — read here,
        # never left for her to remember to pass (the first live walk asked
        # without it and was told about the fallbacks alone).
        try:
            model = str(await settings_store.read_value(await db.get_pool(), "chat.model") or "")
        except Exception:  # noqa: BLE001 — the walk still answers, about the chain
            model = ""
    if model:
        params["model"] = model
    try:
        async with peers.client(ctx.app, peers.GATEWAY, EXPLAIN_TIMEOUT) as client:
            resp = await client.get("/admin/route/explain", params=params)
    except peers.PeerUnconfigured as exc:
        raise ToolFailure(f"the model gateway is not configured — {exc}") from exc
    except httpx.HTTPError as exc:
        raise ToolFailure(f"could not reach the model gateway — {peers.reason(exc)}") from exc
    if resp.status_code != 200:
        try:
            detail = resp.json().get("error") or resp.text[:200]
        except ValueError:
            detail = resp.text[:200]
        raise ToolFailure(f"the routing check was refused — {detail}")
    try:
        body = resp.json()
    except ValueError as exc:
        raise ToolFailure("the gateway's routing answer was not JSON") from exc
    return describe(body)


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="route_explain",
        description=(
            "Why a call for a role (chat, scheduled, judge) goes to the model it goes to: "
            "each link in the role's chain with its live verdict — would serve, over its "
            "monthly cap, the provider refused recently (walled), not installed — and the "
            "gateway's stated reason for any fallback. Use it to answer 'why did that come "
            "from the local model' or 'which model will answer next'. Reads only."
        ),
        parameters={
            "type": "object",
            "properties": {
                "role": {
                    "type": "string",
                    "enum": list(ROLES),
                    "description": "The role to explain (default chat).",
                },
                "model": {
                    "type": "string",
                    "description": "The explicit pick to treat as link 1 (chat's current model).",
                },
            },
            "additionalProperties": False,
        },
        executor=route_explain,
        ephemeral=True,
    ),
)
