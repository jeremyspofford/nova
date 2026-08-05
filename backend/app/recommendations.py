"""Recommendations — Nova's proactive output channel.

An agent or automation RAISES a recommendation via the raise_recommendation
builtin; the operator SEES it as a card in chat and DECIDES (approve / later /
dismiss) through the authenticated operator API. Agents never decide — the
decide path is operator-only, the same boundary that protects settings.

Dedupe: a stable dedupe_key (e.g. "mcp:github") means a weekly automation
re-raising the same finding refreshes the one live row instead of stacking
duplicates — and never resurrects one the operator already dismissed
(docs/plans/recommendation-surface.md).
"""

import hashlib
import json
import logging
import uuid as uuid_mod
from typing import Optional

from app import bg, db

log = logging.getLogger(__name__)

CREATE_LIMIT_PER_HOUR = 12   # card-spam / operator-fatigue guard, per source
_ACTIONABLE = ("new", "seen", "later")
_CHOICE = {"approve": "approved", "later": "later",
           "dismiss": "dismissed", "done": "done"}

_FIELDS = ("id", "kind", "title", "body", "source", "status", "action",
           "priority", "dedupe_key", "created_at", "decided_at", "decided_by",
           "action_state", "action_detail", "action_checked_at", "action_tools")

_RUN_FIELDS = ("id", "status", "steps", "result", "error",
               "created_at", "finished_at")


class PlanChanged(Exception):
    """The card's plan is not the one the operator was looking at."""


def action_digest(action: Optional[dict]) -> Optional[str]:
    """Fingerprint of the plan, DERIVED on every read and never stored.

    It exists so that what the operator approves is what runs. `create()`'s
    ON CONFLICT branch rewrites a live card's action in place, so the weekly
    discovery automation can change a plan between the moment the card was
    rendered and the moment the button is clicked. The frontend echoes this
    digest back with the decision and `decide()` compares; a mismatch is a
    409, not an execution.

    Never stored, because a stored copy is a second source of truth that can
    drift from the column it describes. Never accepted from the client for
    anything except comparison.
    """
    if action is None:
        return None
    material = json.dumps(action, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(material.encode()).hexdigest()


def _json(v):
    return json.loads(v) if isinstance(v, str) else v


def _row(r, run=None) -> dict:
    d = {k: r[k] for k in _FIELDS if k in r}
    d["id"] = str(d["id"])
    d["action"] = _json(d["action"])
    d["action_tools"] = _json(d.get("action_tools"))
    for k in ("created_at", "decided_at", "action_checked_at"):
        d[k] = str(d[k]) if d.get(k) else None
    d["action_digest"] = action_digest(d["action"])
    # Rendered here, not in the frontend: the card and the executor must not
    # be able to disagree about what Approve does, and they cannot disagree
    # if only one of them is allowed to describe the plan.
    from app import actions
    d["action_plan"] = actions.describe(d["action"])
    d["action_executable"] = actions.is_executable(d["action"])
    d["run"] = _run_row(run) if run else None
    return d


def _run_row(r) -> dict:
    d = {k: r[k] for k in _RUN_FIELDS if k in r}
    d["id"] = str(d["id"])
    d["steps"] = _json(d.get("steps")) or []
    d["result"] = _json(d.get("result"))
    for k in ("created_at", "finished_at"):
        d[k] = str(d[k]) if d.get(k) else None
    return d


def _cid(value):
    """A conversation id as a UUID, or None. Never raises: a card raised from
    an automation has no conversation, and a malformed one must not stop the
    card from existing — it only means the question has nowhere to go, which
    `_block` already handles by leaving it on the row for the inbox."""
    import uuid as _u
    try:
        return _u.UUID(str(value)) if value else None
    except (ValueError, AttributeError, TypeError):
        return None


async def create(kind: str, title: str, body: str, *, source: str,
                 action: Optional[dict] = None, priority: int = 0,
                 dedupe_key: Optional[str] = None,
                 conversation_id: Optional[str] = None) -> dict:
    dedupe_key = (dedupe_key or "").strip() or None
    if action is not None:
        # THE DOOR IN. A plan that does not typecheck never becomes a card,
        # and the ValueError text names the field — so a model that got it
        # wrong is told which field and why, in the same turn, and can
        # re-raise against the same dedupe key.
        from app import actions
        actions.parse(action)
    action_json = json.dumps(action) if action is not None else None
    async with db.acquire() as conn:
        # fatigue guard: an agent hammering out cards is broken or being steered
        recent = await conn.fetchval(
            "SELECT count(*) FROM recommendations WHERE source = $1 "
            "AND created_at > now() - interval '1 hour'", source)
        if recent >= CREATE_LIMIT_PER_HOUR:
            raise ValueError(
                f"recommendation rate limit: {source} already raised {recent} "
                f"this hour — stop and tell the operator directly")
        if dedupe_key is None:
            r = await conn.fetchrow(
                "INSERT INTO recommendations (kind, title, body, source, action, "
                "priority, conversation_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
                kind, title, body, source, action_json, priority, _cid(conversation_id))
        else:
            # Refresh the live row; never resurrect a decided/dismissed one.
            #
            # A CHANGED PLAN LOSES ITS VERDICT. This used to rewrite `action`
            # and leave `action_state`, `action_detail`, `action_tools` and
            # `action_checked_at` describing the SUPERSEDED one — so between
            # a re-raise and the re-spawned preflight finishing, the card
            # showed plan B carrying plan A's `ready` and plan A's reviewed
            # tool list. It fails closed if approved in that window (the
            # executor's digest and tool-hash compares both refuse), so this
            # is not a hole; it is the card stating something that is not
            # true, which is the thing this lane exists to prevent.
            #
            # Only when the plan actually differs: an unchanged re-raise
            # keeps its verdict rather than blanking a good one and making
            # the operator wait out a preflight for no reason.
            r = await conn.fetchrow(
                "INSERT INTO recommendations (kind, title, body, source, action, "
                "priority, dedupe_key, conversation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) "
                "ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL "
                "DO UPDATE SET title=EXCLUDED.title, body=EXCLUDED.body, "
                "  source=EXCLUDED.source, action=EXCLUDED.action, "
                "  priority=EXCLUDED.priority, status='new', created_at=now(), "
                "  action_state = CASE WHEN recommendations.action "
                "      IS DISTINCT FROM EXCLUDED.action THEN 'none' "
                "      ELSE recommendations.action_state END, "
                "  action_detail = CASE WHEN recommendations.action "
                "      IS DISTINCT FROM EXCLUDED.action THEN NULL "
                "      ELSE recommendations.action_detail END, "
                "  action_tools = CASE WHEN recommendations.action "
                "      IS DISTINCT FROM EXCLUDED.action THEN NULL "
                "      ELSE recommendations.action_tools END, "
                "  action_checked_at = CASE WHEN recommendations.action "
                "      IS DISTINCT FROM EXCLUDED.action THEN NULL "
                "      ELSE recommendations.action_checked_at END "
                "  , conversation_id = COALESCE(EXCLUDED.conversation_id, "
                "      recommendations.conversation_id) "
                "WHERE recommendations.status = ANY($9) RETURNING *",
                kind, title, body, source, action_json, priority, dedupe_key,
                _cid(conversation_id), list(_ACTIONABLE))
            if r is None:   # conflict on an already-decided row → leave it be
                r = await conn.fetchrow(
                    "SELECT * FROM recommendations WHERE dedupe_key = $1", dedupe_key)
    log.info("Recommendation raised: %s %r by %s", kind, title, source)
    row = _row(r)
    # reach the operator's devices too — the card is the durable surface,
    # the push is the nudge. Fire-and-forget; a decided dedupe row (create
    # left it untouched) must not re-ping.
    if row["status"] == "new":
        async def _ping():
            from app import notify
            await notify.send(body[:140], title=f"Nova recommends: {title}"[:90],
                              tags=["bulb"], click="/chat?inbox=open")
        bg.spawn(_ping(), name="recommendation-ping")
    # Check the plan against the network NOW, so a card whose endpoint does
    # not answer arrives already marked blocked with the reason on it. The
    # model's confidence about a URL is not evidence; this is.
    if row["status"] == "new" and row["action"] is not None:
        from app import actions
        bg.spawn(actions.preflight(row["id"]), name="action-preflight")
    return row


async def list_all(status: str = "new") -> list[dict]:
    """`new` = the banner queue: undecided AND unsnoozed — 'later' means the
    operator asked the banner to stop showing it, so only the inbox lists it
    until a dedupe re-raise resets it to 'new'. `all` = the inbox view:
    everything actionable (snoozed included) plus the last 30 days of
    decided rows."""
    async with db.acquire() as conn:
        if status == "all":
            rows = await conn.fetch(
                "SELECT * FROM recommendations "
                "WHERE status IN ('new','seen','later') "
                "   OR decided_at > now() - interval '30 days' "
                "ORDER BY (status IN ('new','seen','later')) DESC, "
                "         priority DESC, coalesce(decided_at, created_at) DESC")
        else:
            rows = await conn.fetch(
                "SELECT * FROM recommendations WHERE status IN ('new','seen') "
                "ORDER BY priority DESC, created_at DESC")
        # Latest run per card, joined on rather than duplicated into a status
        # column: run state lives in exactly one table.
        runs = await conn.fetch(
            "SELECT DISTINCT ON (recommendation_id) * FROM action_runs "
            "WHERE recommendation_id = ANY($1::uuid[]) "
            "ORDER BY recommendation_id, created_at DESC",
            [r["id"] for r in rows])
    by_rec = {str(r["recommendation_id"]): r for r in runs}
    return [_row(r, by_rec.get(str(r["id"]))) for r in rows]


async def decide(rec_id: str, choice: str,
                 expected_digest: Optional[str] = None) -> Optional[dict]:
    """The operator's decision, and — for an approved card with a runnable
    plan — the enqueue of the run that carries it out.

    The digest compare, the status flip and the run insert happen in ONE
    transaction under `SELECT ... FOR UPDATE`, because `create()`'s ON
    CONFLICT branch can rewrite a live card's action between the moment the
    frontend rendered it and the moment this is called. Without the compare,
    the weekly discovery automation could change a plan under the operator
    and this function would execute one he never read.

    A caller that omits the digest for a card that HAS an action is refused
    (None != digest), so an old client fails closed rather than silently
    skipping the check.
    """
    new_status = _CHOICE.get(choice)
    if not new_status:
        raise ValueError(f"choice must be one of {list(_CHOICE)}")
    try:
        rid = uuid_mod.UUID(str(rec_id))
    except ValueError:
        return None

    from app import actions, settings_store
    async with db.acquire() as conn:
        async with conn.transaction():
            cur = await conn.fetchrow(
                "SELECT action, action_state, conversation_id FROM recommendations "
                "WHERE id = $1 FOR UPDATE", rid)
            if cur is None:
                return None
            action = _json(cur["action"])
            if action is not None and expected_digest != action_digest(action):
                raise PlanChanged(
                    "this card's plan changed since you looked at it — "
                    "reload the inbox and read it again")
            r = await conn.fetchrow(
                "UPDATE recommendations SET status=$2, decided_at=now(), "
                "decided_by='operator' WHERE id=$1 RETURNING *", rid, new_status)
            runnable = (new_status == "approved" and action is not None
                        and cur["action_state"] == "ready"
                        and actions.is_executable(action)
                        and settings_store.get("actions.enabled") is not False)
            if runnable:
                # ON CONFLICT DO NOTHING pairs with the partial unique index:
                # a double-click cannot start two runs.
                await conn.execute(
                    # conversation_id rides along so a step that needs to
                    # ASK has somewhere to ask (phase 3). NULL is fine and
                    # means "raised by an automation" — the question then
                    # waits on the row rather than being posted anywhere.
                    "INSERT INTO action_runs (recommendation_id, action, "
                    "action_type, conversation_id) "
                    "VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
                    rid, json.dumps(action), action["type"],
                    cur["conversation_id"] if cur else None)
    if r:
        await _receipt(_row(r), new_status)
    return (await get(str(rid))) if r else None


async def get(rec_id: str) -> Optional[dict]:
    try:
        rid = uuid_mod.UUID(str(rec_id))
    except ValueError:
        return None
    async with db.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM recommendations WHERE id = $1", rid)
        if r is None:
            return None
        run = await conn.fetchrow(
            "SELECT * FROM action_runs WHERE recommendation_id = $1 "
            "ORDER BY created_at DESC LIMIT 1", rid)
    return _row(r, run)


async def requeue(rec_id: str) -> Optional[dict]:
    """Re-run a failed action. Operator-only, via the card's Run again button."""
    try:
        rid = uuid_mod.UUID(str(rec_id))
    except ValueError:
        return None
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE action_runs SET status='queued', error=NULL, steps='[]', "
            "started_at=NULL, finished_at=NULL, updated_at=now() "
            "WHERE recommendation_id = $1 AND status = 'failed' "
            "  AND id = (SELECT id FROM action_runs WHERE recommendation_id = $1 "
            "            ORDER BY created_at DESC LIMIT 1)", rid)
    return await get(str(rid))


async def record_run_outcome(rec_id: str, summary: str) -> None:
    """Tell HER what came of her own proposal.

    `capability_events.prompt_block()` rides in every agent's FACTS slot, so
    this is the channel by which the outcome reaches the model. Without it an
    approved card produced a journal line saying the operator approved it and
    she had no way to learn it then failed — which is exactly the shape of
    the silent no-op this lane exists to remove.
    """
    from app import capability_events
    async with db.acquire() as conn:
        title = await conn.fetchval(
            "SELECT title FROM recommendations WHERE id = $1::uuid", rec_id) or ""
    try:
        capability_events.record(
            capability_events.RECOMMENDATION, title[:160], "acted on",
            actor="operator (approved)", detail={"outcome": summary[:300]})
    except Exception:
        log.exception("capability event for action outcome failed")
    try:
        from app.memory.memory import memory
        await memory.write(
            f"The action on the approved recommendation \"{title}\" {summary}.",
            type="journal", source_type="chat")
    except Exception:
        log.exception("journal write for action outcome failed")


async def _receipt(rec: dict, status: str) -> None:
    """Leave a trace of the operator's decision. Three of them, deliberately.

    Jeremy, 2026-07-30, after approving a card: "I don't see a trace of it. i
    don't see it in logs or in chat or in the ui where I thought I might see
    it." All three were true. `decide()` was a single UPDATE of a status
    column: no log line, no journal, no event, and nothing acted on it. The
    card simply left the banner. This is the operator-visible-outcomes rule
    pointed the other way round — usually the worry is Nova claiming an
    outcome she did not achieve; here HE performed an action and the system
    kept no receipt of it.

    So:

    * a LOG LINE, because that is the first place anyone looks;
    * a JOURNAL entry, because that is durable, searchable and in the graph —
      the thing that is still there tomorrow;
    * a CAPABILITY EVENT, which is the load-bearing one. `capability_events.
      prompt_block()` already rides in every agent's FACTS slot, so this is
      the channel by which his answer reaches HER. Without it, approval was a
      decision she could never learn — she proposed, he agreed, and she went
      on not knowing. An approval nobody can act on is not an approval.

    Never raises: a decision that fails to leave a receipt is a missing line,
    a decision that fails BECAUSE of one is a broken button.
    """
    from app import capability_events
    verb = {"approved": "approved", "dismissed": "dismissed",
            "later": "deferred"}.get(status, status)
    log.info("Recommendation %s by operator: %s", verb, rec["title"])
    try:
        capability_events.record(
            capability_events.RECOMMENDATION, rec["title"][:160], verb,
            actor="operator",
            detail={"kind": rec["kind"], "raised_by": rec.get("source")})
    except Exception:
        log.exception("capability event for recommendation decision failed")
    try:
        from app.memory.memory import memory
        await memory.write(
            f"The operator {verb} the recommendation \"{rec['title']}\" "
            f"(raised by {rec.get('source') or 'unknown'}). "
            + (f"Its content: {rec['body'][:400]}" if verb == "approved" else ""),
            type="journal", source_type="chat")
    except Exception:
        log.exception("journal write for recommendation decision failed")


async def count_new() -> int:
    async with db.acquire() as conn:
        return await conn.fetchval(
            "SELECT count(*) FROM recommendations WHERE status = 'new'") or 0
