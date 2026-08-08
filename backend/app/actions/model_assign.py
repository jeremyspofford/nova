"""The model.assign action: she proposes the assignment, his click performs it.

THE FAILURE THIS CLOSES (2026-08-07, reconstructed from the live DB). Jeremy
asked Nova for "the latest DeepSeek flash". She spent 31 minutes telling him
which buttons to press — including an edit mode that had been deleted from
the UI — because she was mechanically right that she could not do it: no
agent may write `agents.model` on a system agent (_SYSTEM_PROTECTED), and no
agent could write the curated table at all. He gave up, inserted the row by
hand with a malformed '~' slug, and repointed `main` at it 21 seconds later.
Both halves of that hand-work now have a mechanical path: the pool write is
`manage_curated_models` (catalog-verified), and the assignment is this card.

THE GUARD STAYS. This executor does not weaken _SYSTEM_PROTECTED — it is the
sanctioned route AROUND it: the runs are claimed only while the
recommendation is `approved` by `operator` (action_worker), so the click IS
the operator decision the guard reserves, and the write goes through
`update_agent(operator=True)` exactly as the Settings PATCH does. The same
route also records the capability_events row, so an approved assignment and
a Settings assignment leave the same trail.

VERIFIED, NOT TRUSTED, at both ends: the id is resolved against the live
provider catalog at preflight AND again at execute (DNS moves; catalogs
move; a card can sit for days), and after the write the agent row is read
back — "wrote it" and "it now reads back" are different facts and only the
second is reported.
"""

from __future__ import annotations

import logging

from app.actions.schemas import ModelAssign

log = logging.getLogger(__name__)


def describe(doc: ModelAssign) -> str:
    return "\n".join([
        f'Point agent "{doc.agent}" at a different model',
        f"    Model       {doc.model}",
        f"    Why         {doc.why}",
        "    Verified    the id is checked against the live provider "
        "catalog before you read this card, and re-checked when you approve "
        "— an id the provider does not serve blocks instead of running.",
        "    Not touched tools, prompt, standby, enabled — this card can "
        "only move the one field it names.",
    ])


async def preflight(doc: ModelAssign, *, operator: bool = False
                    ) -> tuple[str, str, None]:
    """Does the agent exist, and does the id resolve? Both are things a model
    can be confidently wrong about, and the whole incident this action comes
    from was an id that resolved nowhere."""
    from app import models_catalog
    from app.agents import registry as agent_registry

    agent = await agent_registry.get_agent_by_name(doc.agent)
    if agent is None:
        return "blocked", f"no agent named '{doc.agent}'", None

    canonical, why = await models_catalog.resolve_id(doc.model)
    if canonical is None:
        return "blocked", why, None

    current = str(agent.get("model") or "")
    if current == canonical:
        return ("blocked",
                f"'{doc.agent}' already runs {canonical} — nothing to change",
                None)
    detail = f"ready: {doc.agent} moves from {current} to {canonical}"
    if canonical != doc.model:
        detail += f" ({why})"
    return "ready", detail, None


async def execute(doc: ModelAssign, rec: dict, *, step) -> dict:
    """Resolve again, write via the operator path, read it back. One shot —
    a single UPDATE either lands or it does not; there is no partial state
    for steps to resume from."""
    from app import models_catalog
    from app.agents import registry as agent_registry

    agent = await agent_registry.get_agent_by_name(doc.agent)
    if agent is None:
        raise RuntimeError(f"no agent named '{doc.agent}' — it existed when "
                           f"this card was raised and does not now")

    # RE-CHECKED AT EXECUTE TIME, not trusted from the preflight, for the
    # same reason code_change.land re-reads its verdicts: the approval is a
    # standing precondition, and the catalog this id was verified against is
    # minutes or days older than this click.
    canonical, why = await models_catalog.resolve_id(doc.model)
    if canonical is None:
        raise RuntimeError(why)
    await step("verify", "ok", why)

    prev = str(agent.get("model") or "")
    ok = await agent_registry.update_agent(
        agent["id"], operator=True,
        # update_agent records the capability_events row (kind=agent, the
        # model delta) under this actor string — the same trail entry a
        # Settings PATCH leaves, which is the point: an approved card and a
        # hand assignment must be indistinguishable in authority and equally
        # visible in the audit.
        actor=f"operator (approved recommendation {rec.get('id')})",
        model=canonical)
    if not ok:
        raise RuntimeError("the update wrote nothing — the agent row "
                           "vanished between the read and the write")

    # Read the LIVE row back. "I issued an UPDATE" is a claim; the row is
    # the fact — and migration triggers (e.g. 082 blanking a standby that
    # now matches the model) mean the row after a write is not always the
    # write.
    live = await agent_registry.get_agent_by_name(doc.agent)
    if not live or str(live.get("model") or "") != canonical:
        raise RuntimeError(
            f"wrote {canonical} but the agent row reads "
            f"{(live or {}).get('model')!r} — the assignment did NOT take")
    await step("assign", "ok", f"{doc.agent}: {prev} -> {canonical}")

    return {"status": "ok", "agent": doc.agent, "model": canonical,
            "previous": prev,
            "detail": (f"{doc.agent} now runs {canonical} (was {prev}). "
                       f"Fitness advisories, if any, appear in Settings → "
                       f"Models.")}
