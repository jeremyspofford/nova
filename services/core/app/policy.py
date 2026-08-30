"""The policy kernel — the ONE place a request becomes an allowed action.

D-012 made real: everything else in this service may only ADD refusals;
`authorize` is the only function that ever returns an ALLOW. It reads the
action-class table (the disposition is DATA, not an if-chain) and the live
consent state, and it decides — it does not execute. The funnel (tools.dispatch)
calls it between schema-validation and the executor, and runs the tool ONLY on
an ALLOW.

    disposition = auto     -> ALLOW
    disposition = consent  -> burn a valid, args-bound, single-use, requestor-
                              bound approval and ALLOW; else raise a card and
                              REQUIRE_CONSENT
    disposition = deny,
    no row, anything else  -> DENY (fail-closed: an unclassified tool is never
                              auto by accident)

The single-authorizer property is pinned by a grep test: `Decision(outcome=
ALLOW)` appears in this file and nowhere else under app/. The burn and every
denial are recorded in the governance ledger; auto-allows are not — the ledger
is for decisions an operator must be able to audit, not for every read.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from app import consents, db, governance

if TYPE_CHECKING:  # only for the type hint; avoids importing the tools package here
    from app.tools.base import ToolContext

# Decision outcomes. ALLOW is deliberately a named constant so the grep pin
# ("only policy constructs an allow") has one exact token to look for.
ALLOW = "allow"
REQUIRE_CONSENT = "require_consent"
DENY = "deny"

_SUMMARY_VALUE_CAP = 200


@dataclass(frozen=True)
class Decision:
    """What the kernel decided. `card_spec` rides a REQUIRE_CONSENT (the shape
    the funnel hands its caller and T2 renders); `reason` rides a DENY (the
    stated refusal the model is told)."""

    outcome: str
    reason: str | None = None
    card_spec: dict | None = None

    @property
    def is_allow(self) -> bool:
        return self.outcome == ALLOW


async def _disposition(pool, action_class: str) -> str | None:
    """The tool's disposition from the action-class table, or None when it has
    no row at all — which the caller treats as DENY (fail-closed)."""
    row = await pool.fetchrow(
        "SELECT disposition FROM action_classes WHERE action_class = $1", action_class
    )
    return row["disposition"] if row is not None else None


def _summary(action_class: str, args: dict[str, Any]) -> str:
    """A one-line human summary of exactly what will happen if approved —
    derived from the call, so the card never claims more than the args say."""
    if not args:
        return f"Run {action_class}"
    parts = []
    for key, value in args.items():
        text = value if isinstance(value, str) else json.dumps(value, default=str)
        if len(text) > _SUMMARY_VALUE_CAP:
            text = text[:_SUMMARY_VALUE_CAP] + "…"
        parts.append(f"{key}={text}")
    return f"Run {action_class} with {', '.join(parts)}"


def _deny_reason(action_class: str, disposition: str | None) -> str:
    if disposition is None:
        return (
            f"{action_class} has no action class defined, so it is refused by "
            "default — a tool must be classified before it can run"
        )
    return f"{action_class} is classified deny and cannot be run"


async def authorize(ctx: ToolContext, action_class: str, args: dict[str, Any]) -> Decision:
    """The kernel. Pure over the action-class table + live consent state: it
    reads, it may burn a consent (and record that burn atomically), and it
    returns a decision — it never runs the tool."""
    pool = await db.get_pool()
    disposition = await _disposition(pool, action_class)
    person = getattr(ctx, "person", None)
    person_id = getattr(person, "id", None)
    agent = getattr(ctx, "agent", "chat")

    if disposition == "auto":
        return Decision(outcome=ALLOW)

    if disposition == "consent":
        if person_id is None:
            # A consent must bind to a requestor; with no identity there is
            # nothing to bind, so it cannot be granted.
            await governance.append(
                pool,
                kind=governance.POLICY_DENIED,
                action_class=action_class,
                meta={"reason": "no requestor identity to bind a consent to"},
            )
            return Decision(
                outcome=DENY,
                reason=(
                    f"{action_class} needs your approval, but this turn has no "
                    "identity to bind an approval to"
                ),
            )
        hashed = consents.args_hash(args)
        burned = await consents.validate_and_use(
            pool,
            action_class=action_class,
            args_hash=hashed,
            person_id=person_id,
            agent=agent,
        )
        if burned:
            return Decision(outcome=ALLOW)
        card = await consents.raise_consent(
            pool,
            action_class=action_class,
            args=args,
            summary=_summary(action_class, args),
            person_id=person_id,
            agent=agent,
            conversation_id=getattr(ctx, "conversation_id", None),
        )
        return Decision(outcome=REQUIRE_CONSENT, card_spec=card)

    # disposition is None (no row), 'deny', or a value this kernel does not
    # handle: refuse, and record the denial for the audit.
    reason = _deny_reason(action_class, disposition)
    await governance.append(
        pool,
        kind=governance.POLICY_DENIED,
        action_class=action_class,
        actor=str(person_id) if person_id is not None else None,
        meta={"reason": reason, "disposition": disposition},
    )
    return Decision(outcome=DENY, reason=reason)
