"""Goal-scoped autonomy — approval given once, spent many times, bounded.

Jeremy's model, 2026-07-28: research is always allowed; everything that
changes the system needs approval; and a GOAL can carry that approval ahead
of time, "but only for the goal".

`consents.py` is the single-use sibling: one operation, one click, burned.
This is the standing form. The rails are the same ones, because they are the
ones that work:

* **Scope is a list of verbs, not a description.** "Only for the goal" cannot
  mean "the model believes this serves the goal" — that is the model marking
  its own homework, and it is defeated by any argument it finds persuasive,
  including one written by a web page it just read. It means: this verb is in
  the array the operator approved, or it is refused.
* **Spending is an atomic UPDATE.** `actions_used` increments in the same
  statement that selects the goal, so two concurrent turns cannot both spend
  the last action. Consents burn the same way and for the same reason.
* **Every bound is a column.** Expiry and action count live in the row, not
  in a heuristic. A goal nobody closed goes quiet on its own.

What this deliberately does NOT do: decide that a goal is finished. The
target is recorded in the operator's words and closing is an explicit act.
A model that can declare its own goal complete has an incentive to, and
`narration.py` exists because that incentive already produced fiction here.
"""

from __future__ import annotations

import logging
import uuid as uuid_mod
from typing import Optional

from app import db

log = logging.getLogger(__name__)

_FIELDS = ("id", "title", "target", "status", "approved_verbs", "max_actions",
           "actions_used", "expires_at", "proposed_by", "rationale",
           "created_at", "activated_at", "closed_at")

# How long an approved goal stays spendable when the operator does not say.
# Long enough for real work, short enough that a forgotten goal is not a
# standing grant: the failure mode to avoid is an approval from three weeks
# ago quietly authorising something today.
DEFAULT_TTL_HOURS = 72
DEFAULT_MAX_ACTIONS = 25


def _row(r) -> dict:
    d = {k: r[k] for k in _FIELDS}
    d["id"] = str(d["id"])
    d["approved_verbs"] = list(d["approved_verbs"] or [])
    for k in ("expires_at", "created_at", "activated_at", "closed_at"):
        d[k] = str(d[k]) if d[k] else None
    return d


async def propose(title: str, target: str, verbs: list[str], *,
                  rationale: str = "", proposed_by: Optional[str] = None,
                  max_actions: int = DEFAULT_MAX_ACTIONS) -> dict:
    """Record a goal awaiting the operator's decision. Grants nothing."""
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """INSERT INTO goals (title, target, approved_verbs, rationale,
                                  proposed_by, max_actions, status)
               VALUES ($1, $2, $3, $4, $5, $6, 'proposed') RETURNING *""",
            title.strip()[:200], (target or "").strip()[:1000],
            sorted(set(verbs or [])), (rationale or "").strip()[:2000],
            proposed_by, max(1, min(int(max_actions), 500)))
    log.info("Goal proposed: %s (%s)", r["title"], ", ".join(r["approved_verbs"]))
    return _row(r)


async def pending_for(verb: str, agent_name: Optional[str]) -> Optional[dict]:
    """A goal already awaiting the operator that would cover `verb`.

    The idempotency the gate needs. Without it a model that retries a refused
    call — and the refusal text used to ask it to do exactly that — raises a
    fresh card every attempt, which is how an approval queue becomes noise the
    operator stops reading.
    """
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            "SELECT * FROM goals WHERE status = 'proposed' "
            "  AND $1 = ANY(approved_verbs) "
            "  AND proposed_by IS NOT DISTINCT FROM $2 "
            " ORDER BY created_at DESC LIMIT 1", verb, agent_name)
    return _row(r) if r else None


async def card_for_refusal(verb: str, *, agent_name: Optional[str],
                           conversation_id: Optional[str] = None,
                           args: Optional[dict] = None) -> tuple[dict, bool]:
    """Raise the operator card the gate's refusal used to only ASK for.

    Returns (goal, created). Until now a refusal returned a string telling the
    model to call `propose_goal` — a prompt doing a control's job, and by the
    plan's own evidence it did not get called: the refusal dead-ended and left
    NO operator-visible artifact at all. The gate already knows the verb, the
    agent, the conversation and the refused arguments, so it can raise the
    card itself and the operator learns something was attempted.

    The card is honest about where it came from. A goal proposed by the model
    carries a title and a checkable target it chose; this one has neither, so
    it says so rather than inventing a finish line. The refused ARGUMENTS are
    the useful part — "what did it actually try to do" — and they are redacted
    through the same helper the trace uses, because arguments are exactly
    where a secret would be.
    """
    from app import consents, trace
    from app.tools import scopes

    existing = await pending_for(verb, agent_name)
    if existing:
        return existing, False

    who = agent_name or "An agent"
    goal = await propose(
        f"{who} tried to {verb}", "",
        [verb],
        rationale=(f"Raised automatically: {who} called `{verb}` with no goal "
                   f"covering it. It did not propose one itself, so this card "
                   f"exists in place of a refusal nobody would have seen."),
        proposed_by=agent_name)

    shown = ""
    try:
        # redact_args returns a scrubbed JSON STRING, not a dict — arguments
        # are exactly where a secret would be, so it goes through the same
        # scrubber the trace uses rather than being formatted by hand.
        redacted = trace.redact_args(args or {})
        if redacted and redacted not in ("{}", ""):
            shown = f"\n\nIt was called with:\n  {redacted[:400]}"
    except Exception:  # noqa: BLE001 — the card matters more than its detail
        log.debug("could not render refused args", exc_info=True)

    effects = "\n".join(f"  • {c}" for c in scopes.consequences([verb]))
    await consents.create(
        "goal.activate", goal["id"],
        (f"{who} tried to use `{verb}` and was refused — nothing has "
         f"happened.{shown}\n\nApproving this lets it:\n{effects}\n\n"
         f"Up to {goal['max_actions']} actions, for {DEFAULT_TTL_HOURS} "
         f"hours. It did not propose a goal of its own, so there is no stated "
         f"finish line here — approve only if the call above is what you "
         f"wanted."),
        requested_by=agent_name or "unknown",
        conversation_id=conversation_id)
    return goal, True


async def activate(goal_id: str, *, ttl_hours: int = DEFAULT_TTL_HOURS,
                   verbs: Optional[list[str]] = None,
                   max_actions: Optional[int] = None) -> Optional[dict]:
    """The operator's yes. Only a proposed or paused goal can become active —
    a closed goal is never revived, because "reopen" and "approve" would then
    be the same click on a row whose scope was agreed for different work."""
    try:
        gid = uuid_mod.UUID(str(goal_id))
    except ValueError:
        return None
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """UPDATE goals
                  SET status = 'active',
                      activated_at = coalesce(activated_at, now()),
                      expires_at = now() + make_interval(hours => $2),
                      approved_verbs = coalesce($3, approved_verbs),
                      max_actions = coalesce($4, max_actions),
                      updated_at = now()
                WHERE id = $1 AND status IN ('proposed','paused')
            RETURNING *""",
            gid, max(1, int(ttl_hours)),
            sorted(set(verbs)) if verbs is not None else None,
            int(max_actions) if max_actions is not None else None)
    if r:
        log.info("Goal ACTIVE: %s — verbs=%s actions=%d/%d", r["title"],
                 ",".join(r["approved_verbs"]), r["actions_used"], r["max_actions"])
    return _row(r) if r else None


async def close(goal_id: str, status: str = "done") -> Optional[dict]:
    if status not in ("done", "abandoned", "paused"):
        raise ValueError("status must be done, abandoned, or paused")
    try:
        gid = uuid_mod.UUID(str(goal_id))
    except ValueError:
        return None
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """UPDATE goals SET status = $2, updated_at = now(),
                      closed_at = CASE WHEN $2 = 'paused' THEN NULL ELSE now() END
                WHERE id = $1 RETURNING *""", gid, status)
    if r:
        log.info("Goal %s: %s", status, r["title"])
    return _row(r) if r else None


async def spend(verb: str, *, agent_name: Optional[str] = None) -> Optional[dict]:
    """Charge one pre-approved action for `verb`, or return None.

    THE control. Everything else in this module is bookkeeping around it.

    One statement selects and charges, so the last action of a goal cannot be
    spent twice by two turns racing. `FOR UPDATE SKIP LOCKED` matches the
    consent burn: under contention a caller takes a different goal rather
    than blocking, and if there is no other it is simply refused — which is
    the safe direction.

    Oldest active goal first, so a long-running goal is not starved by a
    newer one that happens to share a verb.

    BOUND TO THE ASKER. Until 2026-08-04 the match was on VERB ALONE —
    `agent_name` was accepted and then used only in the log line below. So an
    approval the operator granted to one agent in chat was spendable by every
    other agent and by every scheduled automation, silently, for its whole
    72-hour TTL. `pending_for` had always matched on `proposed_by`; `spend`,
    the control, had not. A goal now charges only for the agent that proposed
    it.

    A goal with `proposed_by IS NULL` is one the operator created himself
    rather than one an agent asked for, so it stays spendable by anyone —
    that is a deliberate grant, not a leak.
    """
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """UPDATE goals SET actions_used = actions_used + 1,
                                updated_at = now()
                WHERE id = (
                  SELECT id FROM goals
                   WHERE status = 'active'
                     AND $1 = ANY(approved_verbs)
                     AND (proposed_by IS NULL
                          OR proposed_by IS NOT DISTINCT FROM $2)
                     AND actions_used < max_actions
                     AND (expires_at IS NULL OR expires_at > now())
                   ORDER BY activated_at
                   LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING *""", verb, agent_name)
    if r:
        log.info("Goal action spent: %s on '%s' by %s (%d/%d)", verb,
                 r["title"], agent_name, r["actions_used"], r["max_actions"])
    return _row(r) if r else None


async def active() -> list[dict]:
    """Live goals, newest first. Read-only — never charges.

    Expiry is READ-TIME, the same shape as consents: run-out and past-deadline
    goals are filtered here and refused independently in `spend`, so neither
    depends on a sweep having run. There used to be an `expire_stale()`
    housekeeping UPDATE alongside this, whose own docstring conceded it was
    cosmetic; it had no caller of any kind between 2026-07-29 and 2026-08-05
    and no UI to be cosmetic FOR, so it was deleted rather than wired — a
    row's `status` column staying 'active' past its deadline is legible to
    nothing that reads goals, because everything that reads goals reads it
    through one of these two filters.
    """
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT * FROM goals
                WHERE status = 'active'
                  AND actions_used < max_actions
                  AND (expires_at IS NULL OR expires_at > now())
                ORDER BY activated_at DESC""")
    return [_row(r) for r in rows]


async def list_all(limit: int = 50) -> list[dict]:
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM goals ORDER BY created_at DESC LIMIT $1", limit)
    return [_row(r) for r in rows]


async def get(goal_id: str) -> Optional[dict]:
    try:
        gid = uuid_mod.UUID(str(goal_id))
    except ValueError:
        return None
    async with db.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM goals WHERE id = $1", gid)
    return _row(r) if r else None
