"""Her routing tool: why a role's call goes where it goes (S10-2).

Reads the gateway's explain walk — the same one the Routing page shows —
and says every link's verdict in words. Nothing is called, nothing is
charged; a fallback reason is the gateway's own sentence, quoted. The
decision role's walk follows the owner's two decision switches (decision-role
spec §6), so it is explained with them, read here.
"""

from __future__ import annotations

from collections.abc import Collection

import httpx

from app import db, decisions, peers, settings_store
from app.tools.base import Tool, ToolContext, ToolFailure

# No list of roles here (S12-2): the gateway is the one rule — built-ins plus
# any agent's derived role `agent_<name>` — and its refusal is quoted below.
EXPLAIN_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)
# With both decision models switched off the step does not run at all, which
# is the answer — not merely that no link in the chain can serve.
STEP_OFF = (
    "Answer: the decision step is switched off — both decision models, local and cloud, are "
    "switched off in Settings, so no decision model is asked before a reply and it costs "
    "nothing."
)


def describe(body: dict, *, kinds: Collection[str] | None = None) -> str:
    """The walk in words. `kinds` is the decision switches the walk was
    explained with (the decision role only); empty says the step is off."""
    role = body.get("role")
    chain = body.get("chain") or []
    serve = body.get("would_serve")
    # The answer FIRST, in one sentence — a small model reads the top line
    # and stops; the walk below is the evidence.
    if kinds is not None and not kinds:
        lines = [STEP_OFF]
    elif serve and serve.get("reason"):
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
            "unreachable": "skipped — its machine did not answer",
            "switched_off": "skipped — its machine is switched off for models",
            "unknown": "skipped — no such provider",
            "refused": "refused this request",
            "wrong_protocol": "skipped — it cannot answer this role",
            "kind_off": "skipped — the owner switched this kind of decision model off",
        }.get(verdict, str(verdict))
        lines.append(
            f"  {v.get('link')}. {v.get('id')}: {state}" + (f" ({reason})" if reason else "")
        )
    return "\n".join(lines)


async def route_explain(args: dict, ctx: ToolContext) -> str:
    role = str(args.get("role") or "chat").strip()
    params = {"role": role}
    model = str(args.get("model") or "")
    # Function-local: a cold `import app.tools` must not load app.chat
    # (tests/test_tools_agents.py).
    from app import chat

    if not model and role in chat.CHAT_MODEL_ROLES:
        # Link 1 of every role whose turns send chat.model (chat, scheduled,
        # beat) is the model picked in chat — read here, never left for her to
        # remember to pass (the first live walk asked without it and was told
        # about the fallbacks alone).
        try:
            model = str(await settings_store.read_value(await db.get_pool(), "chat.model") or "")
        except Exception:  # noqa: BLE001 — the walk still answers, about the chain
            model = ""
    if model:
        params["model"] = model
    kinds: frozenset[str] | None = None
    if role == decisions.ROLE:
        # His two switches, read as a decision call reads them. A read that
        # fails is said: a walk explained without them would name a link he
        # switched off as the one that answers.
        try:
            kinds = await settings_store.decision_kinds(await db.get_pool())
        except Exception as exc:  # noqa: BLE001 — the reason is the answer
            raise ToolFailure(
                "the decision switches in Settings could not be read, so the decisions walk "
                f"cannot be explained — {peers.reason(exc)}"
            ) from exc
        params["decision_kinds"] = decisions.kinds_value(kinds)
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
    return describe(body, kinds=kinds)


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="route_explain",
        description=(
            "Why a call for a role (chat, scheduled, judge, decisions — the decision "
            "model that reads each message before she answers — or an agent's role "
            "agent_<name>) goes to the model it goes to: "
            "each link in the role's chain with its live verdict — would serve, over its "
            "monthly cap, the provider refused recently (walled), not installed, cannot "
            "answer this role, its kind of decision model switched off in Settings (local "
            "and cloud each have a switch) — and the gateway's stated reason for any "
            "fallback. Use it to "
            "answer 'why did that come from the local model' or 'which model will answer "
            "next'. Reads only."
        ),
        parameters={
            "type": "object",
            "properties": {
                "role": {
                    "type": "string",
                    "description": (
                        "The role to explain (default chat): chat, scheduled, judge, decisions, "
                        "or an agent's role agent_<name>."
                    ),
                },
                "model": {
                    "type": "string",
                    "description": "The explicit pick to treat as link 1 (chat's current model).",
                },
            },
            "additionalProperties": False,
        },
        executor=route_explain,
        reads_only=True,
        ephemeral=True,
        # Each link's verdict states its machine's state as the gateway sees
        # it now ("skipped — its machine did not answer", "switched off for
        # models"): a read of those machines for the state guard (S40b fix
        # wave C2).
        reads_machines=True,
    ),
)
