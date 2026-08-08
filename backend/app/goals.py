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
           "created_at", "activated_at", "closed_at", "description",
           "created_by", "source_recommendation_id")

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
    d["source_recommendation_id"] = (str(d["source_recommendation_id"])
                                     if d.get("source_recommendation_id") else None)
    for k in ("expires_at", "created_at", "activated_at", "closed_at"):
        d[k] = str(d[k]) if d[k] else None
    # What this goal AUTHORISES, said once here rather than re-derived by the
    # UI, the tool and whoever reads it next. An empty verb list is a tracked
    # intention; a non-empty one is a standing pre-approval being drawn down.
    d["authorises"] = bool(d["approved_verbs"])
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


#: How long a proposed goal counts as "in front of the operator".
#:
#: MEASURED, and it cost him a working feature. A phantom card raised by an
#: eval run on 2026-08-04 16:16 (the incident registry.py:860 records) sat
#: `proposed` forever, and `pending_for` matched it — so for two days every
#: refusal of `manage_automations` told the model "an approval card for this is
#: ALREADY in front of the operator", which was false. He was waiting for a
#: card that did not exist and she was telling him it did.
#:
#: A card nobody has decided in a week is not awaiting a decision; it is
#: litter, and litter that suppresses real requests is worse than no
#: idempotency at all. Matched to the consent decide window for goals, because
#: they are the same question asked in two places.
_PROPOSED_TTL_DAYS = 7


async def pending_for(verb: str, agent_name: Optional[str] = None) -> Optional[dict]:
    # `agent_name` is no longer part of the match — see the query below — but
    # it stays in the signature because callers pass it positionally and a
    # silent arity change is a worse trade than an unused argument.
    """A goal already awaiting the operator that would cover `verb`.

    The idempotency the gate needs. Without it a model that retries a refused
    call — and the refusal text used to ask it to do exactly that — raises a
    fresh card every attempt, which is how an approval queue becomes noise the
    operator stops reading.

    FRESH ONES ONLY. An ancient proposal is not idempotency, it is a card that
    suppresses the one he would actually see. Stale rows are abandoned on the
    way past, the same lazy sweep `consents.list_pending` uses, so the queue
    cleans itself without a job somebody has to remember to run.
    """
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE goals SET status = 'abandoned', updated_at = now() "
            "WHERE status = 'proposed' "
            f"  AND created_at <= now() - interval '{_PROPOSED_TTL_DAYS} days'")
        # ANSWERED, NOT JUST OLD. An auto-raised refusal card is a note that
        # something was attempted; once the operator has approved a goal
        # covering the same verb, he has answered it, and leaving it
        # `proposed` makes it suppress every card raised afterwards. That is
        # the bug this whole function grew: two cards from 2026-08-04 — one an
        # eval-run artifact — silently absorbed every later refusal of
        # `manage_automations`, so the model kept reporting a card was in front
        # of him and none was.
        #
        # ONLY the auto-raised ones (`target = ''`, which `card_for_refusal`
        # writes because it has no finish line to invent). A goal the model
        # PROPOSED carries a title and a checkable target and is a real ask
        # about specific work — an unrelated approval must not discard it.
        await conn.execute(
            """UPDATE goals g SET status = 'abandoned', updated_at = now()
                WHERE g.status = 'proposed' AND coalesce(g.target, '') = ''
                  AND EXISTS (SELECT 1 FROM goals a
                               WHERE a.activated_at IS NOT NULL
                                 AND a.activated_at > g.created_at
                                 AND a.approved_verbs && g.approved_verbs)""")
        # AND THE CARD GOES WITH THE GOAL. A retired goal whose consent stayed
        # `pending` leaves an Approve button in his chat for something that no
        # longer exists — and clicking it would do NOTHING, because
        # `consents.decide` calls `goals.activate`, which refuses anything that
        # is not proposed or paused. A button that silently does nothing is the
        # exact shape this codebase keeps deleting. Measured 2026-08-06: he
        # approved one of two duplicate cards and the other stayed on screen.
        await conn.execute(
            """UPDATE consents SET status = 'expired'
                WHERE status = 'pending' AND kind = 'goal.activate'
                  AND subject IN (SELECT id::text FROM goals
                                   WHERE status IN ('abandoned', 'done'))""")
        # KEYED ON THE VERB ALONE. It used to also match `proposed_by`, so one
        # refusal arriving without an agent name and another as `main` raised
        # TWO cards for the same question, seconds apart — measured
        # 2026-08-06 23:08:57 and 23:09:52, both asking him to approve
        # `manage_automations` for the same edit. Who attempted it belongs in
        # the card's body; it is not part of what he is being asked. And the
        # approval is verb-scoped anyway: activating the goal lets any agent
        # spend it, so a second card could only ever be the same yes twice.
        r = await conn.fetchrow(
            "SELECT * FROM goals WHERE status = 'proposed' "
            "  AND $1 = ANY(approved_verbs) "
            " ORDER BY created_at DESC LIMIT 1", verb)
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


#: Verbs an unattended LANE may spend, as opposed to an agent.
#:
#: The membership test `spend_standing` runs, and it is deliberately a
#: hardcoded set rather than "anything in GOAL_SCOPED_TOOLS": every other verb
#: there names a TOOL, and a tool call must stay bound to the agent the
#: operator approved it for (the 2026-08-04 leak `spend`'s docstring records).
#: These name no tool at all, so there is no agent to bind to — the spender is
#: a scheduler tick, and binding it to a name would only mean the loop stops
#: working when the goal was proposed from a different place.
#:
#: `tests/test_improvement_lane.py` asserts every entry here names nothing in
#: `BUILTIN_TOOLS`, so a future tool cannot quietly acquire an agent-free
#: spending path by reusing one of these names.
#: The self-improvement lane's verb. ONE definition — `scopes.py` offers it,
#: `action_worker.claim_next` re-checks it in SQL and the heartbeat spends it,
#: and a string literal in any of those three would be the drift `scopes.py`'s
#: whole docstring is about.
IMPROVE_SELF = "improve_self"

STANDING_VERBS = frozenset({IMPROVE_SELF})


async def spend_standing(verb: str, *, lane: str) -> Optional[dict]:
    """Charge one pre-approved action for an unattended lane, or return None.

    Same atomic UPDATE as `spend`, same `FOR UPDATE SKIP LOCKED`, same
    read-time expiry and budget filters — the ONLY difference is that
    `proposed_by` is not part of the match, because the spender is not an
    agent and has no name to match against.

    REFUSES ANY VERB THAT NAMES A TOOL. Without that line this would be a
    general-purpose way around the agent binding: pass `manage_agents` and a
    goal the operator approved for one agent becomes spendable by a scheduler.
    So the widening is scoped to verbs that no `execute_tool` path can ever
    reach, and the refusal is a ValueError rather than a None, because a
    caller asking for the wrong thing deserves to fail loudly rather than to
    read "no goal covers this".
    """
    if verb not in STANDING_VERBS:
        raise ValueError(
            f"{verb!r} is not a standing-lane verb — it names a tool, and a "
            f"goal approved for an agent must not be spendable by a scheduler. "
            f"Standing verbs: {', '.join(sorted(STANDING_VERBS))}")
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """UPDATE goals SET actions_used = actions_used + 1,
                                updated_at = now()
                WHERE id = (
                  SELECT id FROM goals
                   WHERE status = 'active'
                     AND $1 = ANY(approved_verbs)
                     AND actions_used < max_actions
                     AND (expires_at IS NULL OR expires_at > now())
                   ORDER BY activated_at
                   LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING *""", verb)
    if r:
        log.info("Standing goal action spent: %s by lane %s on '%s' (%d/%d)",
                 verb, lane, r["title"], r["actions_used"], r["max_actions"])
    return _row(r) if r else None


async def refund_action(goal_id: str, *, run_id: Optional[str],
                        reason: str, lane: str = "goal") -> dict:
    """Give back one action a pass never got to use. Exactly once per run.

    MEASURED 2026-08-07. Four self-improvement passes died on an HTTP 402 from
    the model provider — twelve coding sessions that never ran a line of work —
    and each one had already charged a goal action before it found out. The
    goal's budget is the operator's statement of how much unattended work he
    wants; spending it on a provider refusing to be paid measures nothing.

    NARROW ON PURPOSE. This is not a general "undo": the caller must have
    established that the pass produced NO work, and the only caller today is
    the terminal-provider-refusal path in `actions/code_change`. A refund that
    could be reached from a failure which HAD done work would turn the action
    ceiling into a suggestion.

    EXACTLY ONCE, AND MECHANICALLY SO. `goal_action_refunds` has the run id as
    its primary key, the insert is `ON CONFLICT DO NOTHING`, and the decrement
    only happens in the transaction where the insert actually took a row. A
    retried or duplicated run therefore cannot hand the budget back twice —
    which is the shape that turns a ceiling into free credit.

    A RUN ID IS REQUIRED for exactly that reason. Without one there is nothing
    to make the refund idempotent, so it is REFUSED and says so rather than
    guessing; an unrefunded action is a small loss, and a repeatable refund is
    an unbounded one.
    """
    if not goal_id:
        return {"refunded": False, "detail": "no goal to refund"}
    if not run_id:
        return {"refunded": False,
                "detail": ("refused to refund a goal action with no run id — "
                           "nothing would stop it being refunded twice")}
    try:
        async with db.acquire() as conn:
            async with conn.transaction():
                claimed = await conn.fetchval(
                    """INSERT INTO goal_action_refunds
                           (run_id, goal_id, lane, reason)
                       VALUES ($1::uuid, $2::uuid, $3, $4)
                       ON CONFLICT (run_id) DO NOTHING
                    RETURNING run_id""",
                    str(run_id), str(goal_id), lane, reason[:500])
                if claimed is None:
                    return {"refunded": False,
                            "detail": "this run's action was already refunded"}
                r = await conn.fetchrow(
                    """UPDATE goals
                          SET actions_used = greatest(actions_used - 1, 0),
                              updated_at = now()
                        WHERE id = $1::uuid
                    RETURNING title, actions_used, max_actions""",
                    str(goal_id))
                if r is None:
                    # The refund row would otherwise record a refund that never
                    # happened. Rolling back is what keeps the ledger true.
                    raise ValueError(f"no goal {goal_id} to refund")
    except Exception as e:                                   # noqa: BLE001
        log.exception("could not refund a goal action")
        return {"refunded": False, "detail": f"the refund failed: {e}"}
    log.info("refunded one action on goal '%s' (%d/%d used) — %s",
             r["title"], r["actions_used"], r["max_actions"], reason[:120])
    return {"refunded": True, "title": r["title"],
            "actions_used": r["actions_used"], "max_actions": r["max_actions"],
            "detail": (f"the goal action was given back — "
                       f"{r['actions_used']} of {r['max_actions']} used")}


async def standing_for(verb: str) -> Optional[dict]:
    """The live goal a standing lane WOULD spend, without charging it.

    Read-only, and it exists so a refusal can say which of the several
    possible reasons applies. "No goal covers this" and "the goal is out of
    actions" send the operator to completely different places.
    """
    if verb not in STANDING_VERBS:
        raise ValueError(f"{verb!r} is not a standing-lane verb")
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """SELECT * FROM goals
                WHERE status = 'active' AND $1 = ANY(approved_verbs)
                  AND actions_used < max_actions
                  AND (expires_at IS NULL OR expires_at > now())
                ORDER BY activated_at LIMIT 1""", verb)
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


# ── the operator's own list ──────────────────────────────────────────────────
#
# Goals have existed since 2026-07-29 with NO UI AT ALL. He approves a card in
# chat and then has no way to see what is active, what it authorises, how much
# of its budget is left or when it expires — which is exactly what bit him on
# 2026-08-06: a goal sat at 3/3 actions, every further attempt was refused, and
# the only visible symptom was Nova saying she was blocked.

#: What the operator may edit by hand. Deliberately NOT `approved_verbs`,
#: `max_actions` or `expires_at`: those are the authorisation, and widening a
#: standing grant is a decision that belongs on an approval card, not in a
#: text field. `status` is here because closing or reopening the WORK is his
#: to say — and `activate` still guards the transition that grants anything.
EDITABLE = {"title", "description", "target", "status"}

#: Statuses the operator may set directly. `active` is absent on purpose: it is
#: what activation produces, and letting a UI write it would be a way to grant
#: a goal's verbs without the consent that exists to grant them.
SETTABLE_STATUS = ("proposed", "paused", "done", "abandoned")


async def create(title: str, *, description: str = "", target: str = "",
                 created_by: str = "operator",
                 source_recommendation_id: Optional[str] = None) -> dict:
    """A tracked goal that authorises NOTHING.

    No verbs, no action budget, no expiry — `approved_verbs` is empty, which
    `spend` can never match and `_row` reports as `authorises: false`. This is
    the shape an approved idea becomes, and the shape the operator gets when he
    writes one down himself. Turning it into a standing grant is `activate`,
    which is reached only through a consent he clicks.
    """
    src = None
    if source_recommendation_id:
        try:
            src = uuid_mod.UUID(str(source_recommendation_id))
        except ValueError:
            src = None
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """INSERT INTO goals (title, description, target, approved_verbs,
                                  status, created_by, source_recommendation_id)
               VALUES ($1, $2, $3, ARRAY[]::text[], 'proposed', $4, $5)
               ON CONFLICT (source_recommendation_id)
                    WHERE source_recommendation_id IS NOT NULL
                    DO NOTHING
               RETURNING *""",
            title.strip()[:200], (description or "").strip()[:8000],
            (target or "").strip()[:1000], created_by, src)
    if r is None:
        # The card already produced a goal. Returning the existing one rather
        # than raising: a second approval of the same idea is a double-click or
        # a re-approval after `later`, and neither is an error worth showing.
        return await from_recommendation(str(src)) or {}
    log.info("Goal created: %s (by %s)", r["title"], created_by)
    return _row(r)


async def reconcile_approved_ideas() -> int:
    """Every approved idea has a goal. Convergent, not event-driven.

    The decide seam creates the goal at the moment of approval, and on
    2026-08-07 Jeremy found two approved ideas with no goal behind them — the
    backend had been recreated overnight and whatever went wrong at 23:52 went
    with the logs. That is the weakness of a fire-and-forget side effect: when
    it misses once, the miss is permanent and invisible.

    So the STATE is the contract now: this derives the missing rows from the
    recommendations table itself, idempotently (the partial unique index on
    source_recommendation_id makes the INSERT a no-op for anything already
    linked). Called from the OPERATOR'S goals route, so opening the tab heals
    the list and the seam's failure mode becomes a delay rather than a loss.

    Deliberately NOT called from `list_all`: the model's `list_goals` tool is
    declared read-only and runs in the parallel set, and hanging a write off it
    turned that declaration into a lie — `test_parallel_tools` went red on this
    exact line the first time it ran, which is the pinned-suite tripwire doing
    its job. A model listing goals must never be the thing that mutates them.
    """
    async with db.acquire() as conn:
        out = await conn.execute(
            """INSERT INTO goals (title, description, target, approved_verbs,
                                  status, created_by, source_recommendation_id)
               SELECT left(r.title, 200), coalesce(r.body, ''), '',
                      ARRAY[]::text[], 'proposed',
                      coalesce(r.source, 'ideator'), r.id
                 FROM recommendations r
                WHERE r.kind = 'idea' AND r.status = 'approved'
                  AND NOT EXISTS (SELECT 1 FROM goals g
                                   WHERE g.source_recommendation_id = r.id)
               ON CONFLICT (source_recommendation_id)
                    WHERE source_recommendation_id IS NOT NULL
                    DO NOTHING""")
    n = int(out.split()[-1] or 0)
    if n:
        log.info("reconciled %d approved idea(s) that had no goal", n)
        # Journaled for the same reason the seam failure is: a heal is the
        # visible half of a miss that was silent, and the journal outlives
        # the container that logged it.
        try:
            from app.memory.memory import memory
            await memory.write(
                f"Goal reconciliation created {n} goal(s) for approved "
                f"idea(s) that had none — the approval seam missed them.",
                type="journal", source_type="system")
        except Exception:                                # noqa: BLE001
            log.exception("could not journal the reconcile")
    return n


async def sessions_for(goal_id: str) -> list[dict]:
    """The coding work done under this goal — what came of it.

    The answer to "I approved that idea weeks ago, did anything happen?"
    Read from `coding_sessions.goal_id` (migration 111) rather than inferred
    from titles, so a renamed goal keeps its history.
    """
    try:
        gid = uuid_mod.UUID(str(goal_id))
    except ValueError:
        return []
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, state, branch, commit_sha, sandbox_status, "
            "       review_status, created_at "
            "  FROM coding_sessions WHERE goal_id = $1 "
            " ORDER BY created_at DESC LIMIT 20", gid)
    return [{"session_id": str(r["id"]), "state": r["state"],
             "branch": r["branch"], "commit": r["commit_sha"],
             "sandbox": r["sandbox_status"], "review": r["review_status"],
             "created_at": str(r["created_at"])} for r in rows]


async def from_recommendation(rec_id: str) -> Optional[dict]:
    """The goal an idea card produced, if it produced one."""
    try:
        rid = uuid_mod.UUID(str(rec_id))
    except ValueError:
        return None
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            "SELECT * FROM goals WHERE source_recommendation_id = $1", rid)
    return _row(r) if r else None


async def edit(goal_id: str, **updates) -> Optional[dict]:
    """Operator edits. Everything that grants anything is out of reach."""
    updates = {k: v for k, v in updates.items() if k in EDITABLE}
    if not updates:
        return None
    if "status" in updates and updates["status"] not in SETTABLE_STATUS:
        raise ValueError(
            f"status must be one of {', '.join(SETTABLE_STATUS)} — `active` is "
            f"reached by approving the goal, not by setting a field")
    try:
        gid = uuid_mod.UUID(str(goal_id))
    except ValueError:
        return None
    clauses, params = [], [gid]
    for i, (k, v) in enumerate(updates.items(), start=2):
        clauses.append(f"{k} = ${i}")
        params.append(v)
    # closed_at follows status rather than being set separately, so a goal
    # cannot report itself finished with no time attached to that claim.
    extra = (", closed_at = now()"
             if updates.get("status") in ("done", "abandoned") else "")
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            f"UPDATE goals SET {', '.join(clauses)}{extra}, updated_at = now() "
            f"WHERE id = $1 RETURNING *", *params)
    return _row(r) if r else None


async def delete(goal_id: str) -> bool:
    """Remove a goal outright. Only the operator's route reaches this."""
    try:
        gid = uuid_mod.UUID(str(goal_id))
    except ValueError:
        return False
    async with db.acquire() as conn:
        out = await conn.execute("DELETE FROM goals WHERE id = $1", gid)
    return out.endswith("1")
