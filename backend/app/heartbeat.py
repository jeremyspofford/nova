"""The heartbeat — she looks around on her own, and CODE decides whether
what she found reaches the operator. Spec: docs/plans/heartbeat.md.

The shape every surveyed assistant converged on (OpenClaw, Hermes, Vellum):
a periodic agent turn over an operator-editable checklist, quiet unless
something needs attention. The part that must be mechanical is the QUIET
CONTRACT: the model is asked to answer HEARTBEAT_OK when nothing matters,
but the decision to suppress or deliver is made HERE, on the reply text —
a prompt is a request, not a control. Same for repetition: phase 3 adds a
fingerprint memory so an identical alert cannot nag twice; until then the
card's dedupe key (a hash of the delivered text) is the narrow version.

Runs as a MECHANICAL_HANDLERS entry on a real automation row ('heartbeat',
migration 113), so the schedule is visible in Library -> Automations, the
run history shows every beat's outcome ('quiet - ...' / 'notified - ...'),
the kill switch and auto-disable apply, and only a migration can rebind
the row to code. Delivery is web push + an inbox card (Jeremy's pick,
2026-08-07) through the existing seams — notify.send and
recommendations.create — never a bespoke channel.
"""

import hashlib
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from app import notifications, notify, recommendations, settings_store, trace
from app.agents import registry as agent_registry
from app.agents import runner as agent_runner
from app.config import settings
from app.llm import router as llm_router

log = logging.getLogger(__name__)

#: The reply that means "nothing needs attention". Under this length the
#: whole reply is ceremony and is suppressed; at or over it the model said
#: something real AND appended the token, so the token goes and the text
#: stays. 300 is OpenClaw's measured line, adopted as-is.
QUIET_TOKEN = "HEARTBEAT_OK"
QUIET_MAX_CHARS = 300

#: Where the checklist lives: beside soul.md in the memory root, so
#: Library -> Files edits it and a backup bundle carries it.
CHECKLIST_NAME = "heartbeat.md"

SEED = """\
# Heartbeat checklist

Nova reads this file on every heartbeat (Library -> Automations ->
heartbeat sets the cadence) and checks ONLY what it names. Edit freely —
plain markdown, one concern per line. She may append items here when asked
to "keep an eye on" something.

- Backups: is the newest verified bundle older than the configured
  cadence, or did the last attempt fail? (check_backups / diagnose)
- Inbox: are there cards older than a day that were never opened?
- Background work: is anything failing repeatedly — ingestion, automations,
  evals, MCP servers? (diagnose carries the failure census)
"""

PROMPT = """\
This is your heartbeat — a scheduled look around, not a message from the
operator. Work through the checklist below and nothing else. Use your
read-only tools to CHECK, never to act; do not infer or repeat concerns
from prior conversations.

If nothing on the list needs the operator's attention right now, reply
with exactly HEARTBEAT_OK and nothing else. Otherwise reply with a short,
concrete report of only the items that need attention — it will be pushed
to their phone, so lead with what matters.

CHECKLIST
---------
{checklist}"""


def checklist_path() -> Path:
    return Path(settings.okf_memory_dir) / CHECKLIST_NAME


def read_checklist() -> str:
    """The checklist text, seeding the file on first use.

    Seeded rather than shipped: the memory dir is operator data, not repo
    content, and an install that never enables the heartbeat should still
    get the starter the first time a beat actually runs.
    """
    path = checklist_path()
    try:
        return path.read_text()
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(SEED)
        return SEED


def verdict(reply: str) -> tuple[str, str]:
    """The quiet contract, applied to a finished reply.

    Returns (outcome, text): ('quiet', why) suppresses delivery entirely;
    ('notify', text) delivers text. Pure — the tests pin it directly.
    """
    cleaned = (reply or "").strip()
    if not cleaned:
        return "quiet", "empty reply"
    if QUIET_TOKEN in cleaned:
        if len(cleaned) < QUIET_MAX_CHARS:
            return "quiet", "nothing needs attention"
        # Real content wearing the token: the token goes, the report stays.
        stripped = cleaned.replace(QUIET_TOKEN, "").strip(" \n-—:")
        if not stripped:
            return "quiet", "nothing needs attention"
        return "notify", stripped
    return "notify", cleaned


def within_active_hours(now: datetime, spec: str) -> bool:
    """Whether `now` (already operator-local) falls inside "HH:MM-HH:MM".

    An unparseable spec is treated as always-active and logged — a typo in
    a settings field must not silently turn the feature off forever.
    Overnight windows ("22:00-06:00") work by inversion.
    """
    spec = (spec or "").strip()
    if not spec:
        return True
    try:
        lo_s, hi_s = spec.split("-", 1)
        lo_h, lo_m = (int(x) for x in lo_s.strip().split(":", 1))
        hi_h, hi_m = (int(x) for x in hi_s.strip().split(":", 1))
    except ValueError:
        log.warning("heartbeat.active_hours %r is not HH:MM-HH:MM — "
                    "treating as always active", spec)
        return True
    lo, hi, cur = lo_h * 60 + lo_m, hi_h * 60 + hi_m, now.hour * 60 + now.minute
    if lo == hi:
        return True
    if lo < hi:
        return lo <= cur < hi
    return cur >= lo or cur < hi          # overnight window


def model_wrote_nothing(spans) -> bool:
    """Was the delivered text written by any model this turn? True means no.

    THE INCIDENT: at 12:15Z on 2026-08-08 a beat delivered "[This turn
    produced no reply. …]" to the phone as a real alert and recorded
    ok/notified. That sentence is the runner's empty-final floor — harness
    prose, inline in run_agent, not a constant anything can import — so it is
    detected STRUCTURALLY instead of by matching a copied string: every
    llm_call span records `completion_chars` for its round, and the floor is
    applied exactly when no round contributed any kept text. When every
    llm_call span this turn says zero, whatever `final` carries was written
    by the harness.

    True only when llm_call spans EXIST and all of them say zero. No spans at
    all is indeterminate (a stubbed trace, a broken one), and indeterminate
    must not suppress a real report — the honest failure here is a floor
    delivered as news, never news withheld.
    """
    llm = [s for s in (spans or ()) if s.get("kind") == "llm_call"]
    if not llm:
        return False
    return all(not (s.get("detail") or {}).get("completion_chars")
               for s in llm)


# ── one durable record per standing fault, not a push per tick ───────────────

#: How long repeats of one standing fault keep folding onto a single
#: notification row. A day: the walls this covers (a billing wall, the
#: operator's own dirty tree, a spent ceiling, a model returning nothing)
#: persist across many ticks, and each tick re-announcing them produced 24+
#: pushes about one unchanged fact in one night (2026-08-08). A fault that
#: comes back after a quiet day is news again and gets a fresh row.
REPEAT_WINDOW_S = 24 * 3600


async def raise_once(fp: str, message: str, *, title: str,
                     source: str = "improvement") -> None:
    """First occurrence notifies; every repeat increments the SAME row.

    Built from the notifications module's own fingerprint/repeats mechanism
    (`find_repeat` / `note_repeat`) rather than `notify.send`'s dedupe alone,
    because that window is 300 seconds — sized for one event fanning out
    through two callers, not for a wall still standing at the next
    ninety-minute tick. The repeats column is the count of times the fault
    was re-hit, on one row the operator reads once.

    Never raises: the caller is a tick or a beat, and a fault he was not
    told about is bad, but a tick that dies telling him is worse.
    """
    try:
        prior = await notifications.find_repeat(fp, window_s=REPEAT_WINDOW_S)
        if prior is not None:
            await notifications.note_repeat(prior["id"])
            return
        await notify.send(message, title=title, tags=["warning"],
                          kind="improvement", source=source, dedupe_key=fp)
    except Exception:                                        # noqa: BLE001
        log.exception("could not record the standing fault %s", fp)


# ── the self-improvement clock ───────────────────────────────────────────────
#
# ROADMAP #47 rail 4. Jeremy, 2026-08-07: "that needs to be a continuous
# ongoing process that I don't even think about or approve." Something has to
# be the thing that starts it, and the heartbeat already is that thing: it is
# leader-gated, it survives restarts, it has a schedule the operator can see
# and move in Library -> Automations, and it has a kill switch.
#
# ENTIRELY MECHANICAL, and that is why it runs BESIDE the agent turn rather
# than inside it. Not one word of the decision to start a pass is asked of a
# model: a live goal carrying `improve_self` is charged atomically, a spend
# ceiling is checked against a ledger, a database index refuses a second
# concurrent run, and a card is raised. The checklist turn below cannot start
# a pass, cannot stop one, and is never shown that one happened.
#
# It also runs BEFORE the active-hours gate. Active hours decide when she may
# INTERRUPT him; they have nothing to do with when a machine may work, and
# skipping the loop overnight would waste the quietest hours on the box.


async def improve_tick() -> tuple[bool, str]:
    """Start at most one self-improvement pass. Returns (started, why).

    Every refusal path returns a REASON rather than silence, because the
    interesting question about an autonomous loop is almost always "why is it
    not doing anything", and the answer has to be in the run history rather
    than in somebody's head. The six reasons, in the order they are checked:

        no goal        nobody has approved the standing goal (the normal
                       state, and not a failure — it is the off switch)
        already busy   a pass is queued or running; one at a time
        walled         the last pass died at a wall (billing, credentials)
                       and the escalating backoff has not expired
        over budget    the daily spend ceiling refuses to start another
        dirty repo     the operator's own working tree has uncommitted
                       changes, so the landing sidecar would refuse to stage
                       anything this pass built
        goal spent     the goal exists but its actions or its clock ran out
        card raised    the plan did not preflight ready, so it is in his inbox

    `started` is False for all of them, and the caller reports it as a normal
    quiet beat — none of these is a broken heartbeat. The wall-shaped ones
    (walled, over budget, dirty repo) additionally keep ONE durable
    notification per wall kind via `raise_once`: a standing wall must reach
    him once and then count its repeats, never page him per tick — and none
    of them may raise the per-pass card, because no pass exists.
    """
    from app import action_worker, db, goals, spend

    # 1. IS THERE A STANDING APPROVAL AT ALL? Read-only first, so the three
    #    "no" answers below can be told apart. `standing_for` refuses any verb
    #    that names a tool, so this cannot be pointed at anything else.
    goal = await goals.standing_for(goals.IMPROVE_SELF)
    if goal is None:
        return False, "no live goal authorises self-improvement"

    # 2. ONE AT A TIME. The unique index in migration 116 is the real refusal
    #    — two schedulers cannot both insert — and this is the cheap check
    #    that avoids charging a goal action for a pass the index would reject.
    async with db.acquire() as conn:
        busy = await conn.fetchval(
            "SELECT 1 FROM action_runs WHERE lane = 'goal' "
            "  AND status IN ('queued', 'running', 'blocked') LIMIT 1")
    if busy:
        return False, "an improvement pass is already in flight"

    # 3. THE WALLS AND THE CEILING (rail 3). All checked BEFORE the goal is
    #    charged, so a pass that may not start does not consume the standing
    #    approval — and before any card exists, so a refused tick raises no
    #    per-pass card/notification pair, only the one durable wall record.
    #
    #    The wall is read separately from `may_start` (which also refuses on
    #    it) because its KIND is what the durable record is keyed on: five
    #    ticks against one billing wall must be one row counting five, not
    #    five pushes.
    wall = await spend.active_wall(spend.LANE_IMPROVE)
    if wall is not None:
        await raise_once(f"improve-wall:{wall['wall']}",
                         f"Self-improvement is paused at a wall: "
                         f"{wall['note']}",
                         title="Self-improvement hit a wall")
        return False, wall["note"]
    allowed, why = await spend.may_start(spend.LANE_IMPROVE)
    if not allowed:
        await raise_once(f"improve-wall:{spend.WALL_CEILING}",
                         f"Self-improvement is paused: {why}",
                         title="Self-improvement hit its ceiling")
        return False, why

    # 3b. THE OPERATOR'S OWN TREE, before his budget is spent on a doomed
    #     pass. MEASURED 2026-08-08: thirteen passes said 'ready' in
    #     preflight and every one died at the staging step, because
    #     git-landing refuses to stage onto a dirty host repo and nothing
    #     asked until after an action was charged and an hour-long paid
    #     coding session had run.
    dirty = await host_repo_wall()
    if dirty is not None:
        await raise_once(f"improve-wall:{spend.WALL_DIRTY_REPO}",
                         f"Self-improvement is paused: {dirty}",
                         title="Self-improvement is waiting on your tree")
        return False, dirty

    # 4. CHARGE IT. Atomic — `actions_used` increments in the same statement
    #    that selects the goal, so two beats racing cannot both spend the last
    #    action. Everything above this line is advisory; this is the control.
    charged = await goals.spend_standing(goals.IMPROVE_SELF, lane="heartbeat")
    if charged is None:
        return False, (f"the goal \"{goal['title']}\" is out of actions or has "
                       f"expired — approve a new one to continue")

    # 5. THE WORK, DERIVED FROM THE GOAL ROW. Never from prose an agent wrote
    #    in a conversation: the spec's line is that the handoff from research
    #    to build "passes through a goal row, never through prose an agent
    #    wrote", and the goal's title, target and description are the
    #    operator's own words about what he approved.
    action = {
        "type": "code_change.build",
        "workspace": DEFAULT_WORKSPACE,
        "task": _build_task(charged),
        "attempts": 3,
        "why": f"self-improvement pass {charged['actions_used']} of "
               f"{charged['max_actions']}"[:280],
        "goal_id": str(charged["id"]),
    }
    try:
        out = await action_worker.enqueue_goal_run(
            charged, action,
            title=f"Self-improvement pass {charged['actions_used']}: "
                  f"{charged['title']}"[:200],
            body=(f"Started under the standing goal \"{charged['title']}\" "
                  f"(action {charged['actions_used']} of "
                  f"{charged['max_actions']}). {why}"),
            source="improvement")
    except Exception as e:                                   # noqa: BLE001
        # The action was already charged. Say so rather than swallowing it —
        # a silently burnt action is a budget that drains with nothing to show.
        log.exception("the improvement pass could not be enqueued")
        return False, (f"charged one action and then failed to start the pass: "
                       f"{e}")
    if out["status"] == "queued":
        return True, f"improvement pass started (run {out['run'][:8]})"
    return False, f"pass not started — {out['detail']}"


async def host_repo_wall() -> Optional[str]:
    """Why a pass would die at the landing step, or None if it would not.

    Asks the SAME sidecar route the landing preflight reads (git-landing's
    GET /status, via `coder.repo_status`) — the check reads the live tree,
    never a cached judgement about it, so committing or stashing clears it
    at the very next tick with nothing to reset.

    FAIL-OPEN, DELIBERATELY, and only because this is spend protection
    rather than enforcement: an unreachable sidecar, or one whose image
    predates the `dirty` field, is UNKNOWN, and unknown proceeds. The
    landing gate inside git-landing stays the thing that refuses — a spend
    guard that turned "could not ask" into "refused" would stall the whole
    loop on every sidecar restart. The one thing this must never do is read
    an unknown as CLEAN and say so.
    """
    from app import coder
    st = await coder.repo_status()
    if st.get("error") or "dirty" not in st:
        return None
    if not st.get("dirty"):
        return None
    n = st.get("dirty_files")
    sample = ", ".join(str(p) for p in (st.get("dirty_sample") or [])[:3])
    counted = (f"{n} file(s) of uncommitted changes" if n
               else "uncommitted changes")
    return (f"your own working tree on {st.get('branch') or 'the host repo'} "
            f"has {counted}{f' ({sample}, …)' if sample else ''} — the "
            f"landing sidecar refuses to stage a pass on top of them, so no "
            f"action was charged and no session was paid for. Commit or "
            f"stash, and the loop resumes on its own.")


#: Which repository a pass works in. The workspace name, not a URL: `coder`
#: resolves it against the `workspaces` table and refuses one that is not
#: registered and enabled, which is where that decision belongs.
DEFAULT_WORKSPACE = "nova"

#: How much of the goal reaches the coding agent. A goal's description can be
#: an approved idea's whole body, and a task that buries its instruction in
#: four thousand characters of context is a worse task.
_TASK_MAX = 3000


def _build_task(goal: dict) -> str:
    """The instruction one pass is given, built from the goal ROW.

    A pure function of the row so it is testable without a database, and so
    that what the coding agent is asked can be read here rather than
    reconstructed from a log. `schemas.CodeChangeBuild` requires at least 20
    characters, so the goal's title is always included even when every other
    field is empty.
    """
    parts = [f"Goal: {goal.get('title') or '(untitled)'}"]
    if (goal.get("target") or "").strip():
        parts.append(f"\nWhat done looks like:\n{goal['target'].strip()}")
    if (goal.get("description") or "").strip():
        parts.append(f"\nContext:\n{goal['description'].strip()}")
    parts.append(
        "\nMake ONE self-contained improvement that serves this goal, and "
        "stop. Keep it small enough that a person could review the diff in a "
        "few minutes. Run the test suite you affect. If you cannot find a "
        "change worth making, say so plainly and change nothing — an honest "
        "no-op is a better answer than a change nobody asked for.")
    return "\n".join(parts)[:_TASK_MAX]


async def beat(automation: dict) -> tuple[bool, str]:
    """One heartbeat: the MECHANICAL_HANDLERS entry.

    Returns (ok, summary) exactly like every other handler; the summary is
    what the run history shows, so it always says which way the contract
    went rather than a bare 'ok'.
    """
    # THE IMPROVEMENT CLOCK, first and mechanical. Its outcome rides in the
    # summary either way, so the run history answers "is the loop running?"
    # without anybody opening a database. It can never fail the beat: a
    # heartbeat that went red because no improvement goal is approved would
    # auto-disable the automation that also does the checking.
    improve_note = ""
    try:
        _started, improve_why = await improve_tick()
        improve_note = f" [improve: {improve_why}]"
    except Exception as e:                                   # noqa: BLE001
        log.exception("the improvement tick failed")
        improve_note = f" [improve: FAILED — {e}]"

    tz = settings_store.get("nova.timezone") or "UTC"
    try:
        now_local = datetime.now(ZoneInfo(tz))
    except Exception:  # noqa: BLE001 — a broken tz name must not kill beats
        now_local = datetime.now(ZoneInfo("UTC"))
    hours = settings_store.get("heartbeat.active_hours")
    if not within_active_hours(now_local, hours):
        return True, f"quiet — outside active hours ({hours}){improve_note}"

    agent = await agent_registry.get_agent_by_name("main")
    if not agent or not agent["enabled"]:
        return False, "the main agent is missing or disabled" + improve_note
    override = (settings_store.get("heartbeat.model") or "").strip()
    if override:
        agent = {**agent, "model": override}

    prompt = PROMPT.format(checklist=read_checklist())
    final, errors = "", []

    # Its own trace source: a beat must never read as the operator's turn
    # in the ledger or the journal tooling (the probe-noise lesson).
    async with trace.turn("heartbeat", automation=automation["name"],
                          model=llm_router.effective_model(agent["model"])) as t:
        async for event in agent_runner.run_agent(
                agent, [{"role": "user", "content": prompt}],
                dispatch_depth=1, automation=automation["name"]):
            if event["type"] == "final":
                final = event["text"]
            elif event["type"] == "error":
                errors.append(event["error"])
                t.set_error(event["error"])

    if errors and not final:
        return False, "; ".join(errors)[:500] + improve_note

    outcome, text = verdict(final)
    if outcome == "quiet":
        return True, f"quiet — {text}{improve_note}"

    # A BEAT THAT CHECKED NOTHING MUST NOT REPORT. When no model wrote the
    # text about to be delivered (see `model_wrote_nothing`), it is the
    # runner's floor, not a finding — pushing it as a report is how harness
    # prose reached the phone as an alert. The beat records itself UNABLE
    # (a failure, because the checklist was not checked), and the broken
    # model reaches him through one escalating record: five broken beats
    # are one row counting five, not five pushes.
    if model_wrote_nothing(getattr(t, "spans", None)):
        await raise_once(
            "heartbeat:no-reply",
            "The heartbeat could not check anything: its checklist turn "
            "produced no reply — the model returned no text at all. The "
            "checklist was NOT verified. Repeats fold onto this "
            "notification until the model answers again.",
            title="The heartbeat cannot check", source="heartbeat")
        return False, ("unable — the checklist turn produced no reply"
                       + improve_note)

    # Delivery: push AND card AND — since migration 125 — the conversation.
    # The card is the one that survives being missed; its dedupe key is the
    # text's own hash, so the same report refreshes one card instead of
    # stacking copies (real fingerprint dedupe — suppression BEFORE the model
    # is even asked — is phase 3).
    digest = hashlib.sha256(text.encode()).hexdigest()[:12]
    delivered: list[str] = []
    failed: list[str] = []

    # PUSH FIRST, CARD SECOND — the order changed with migration 125 and the
    # reason is a race, not taste. `recommendations.create` bg.spawns its own
    # "Nova recommends: …" push carrying the same sentence, so a beat that
    # found something buzzed the phone twice with the same words. notify.send
    # now collapses identical news by content fingerprint, but which of the
    # two calls records the row decides which one gets a real delivery
    # outcome — and the card's ping is fire-and-forget and reports to nobody.
    # Raising here first makes this beat the one that records and reports,
    # deterministically, and leaves the card's ping to dedupe onto it.
    push = await notify.send(text, title="Nova heartbeat", tags=["heartbeat"],
                             kind="heartbeat", source="heartbeat")
    # A DEDUPED PUSH IS NOT A PUSH THIS BEAT MADE. notify.send returns ok:True
    # when it folded this text onto an identical notification raised minutes
    # ago — the provider was never asked. Recording that as a plain "push" in
    # the run summary would put the word for a delivery this beat did not
    # perform into the automation history, which is where a later reader (or
    # she herself) goes to find out whether the operator was told.
    if push.get("deduped"):
        state = push.get("delivery_label") or "in an unknown state"
        (delivered if push.get("ok") else failed).append(
            "push: not published by this beat — the identical alert was "
            f"already raised and is {state}")
    elif push.get("ok"):
        delivered.append("push")
    else:
        failed.append(f"push: {push.get('error')}")
    # The conversation is its own channel and reported as its own: "in chat"
    # is the surface Jeremy asked for, and a beat whose transcript row failed
    # to write while the push went out is a real, separate half-failure.
    if push.get("in_chat"):
        delivered.append("chat")
    else:
        failed.append("chat: " + (
            push.get("chat_error") or push.get("record_error")
            or ("the notification was not placed in the conversation"
                if "in_chat" in push
                # Distinct from a failure: the send path said NOTHING about
                # the conversation. Named rather than folded into the line
                # above, because "it did not land" and "nobody reported" are
                # different faults and only one of them is notify.send's.
                else "the send path reported nothing about the conversation")))

    try:
        card = await recommendations.create(
            "heartbeat", "Heartbeat: something needs your attention",
            text, source="heartbeat", dedupe_key=f"heartbeat:{digest}")
        delivered.append("card")
        # Tie the two halves of one finding together, so reading it in chat
        # retires the card from the bell rather than leaving the same news
        # demanding attention in two places.
        if push.get("notification_id"):
            await notifications.link_recommendation(
                push["notification_id"], card["id"])
    except Exception as e:  # noqa: BLE001 — rate limit or closed inbox
        failed.append(f"card: {e}")

    summary = f"notified ({', '.join(delivered)}) — {text[:200]}{improve_note}"
    if failed:
        summary += f" [failed: {'; '.join(failed)[:200]}]"
    # Both channels failing IS a failed run: she noticed something and the
    # operator was never told — the exact false-success shape this repo
    # documents. One channel is enough to count as delivered.
    return (bool(delivered), summary)
