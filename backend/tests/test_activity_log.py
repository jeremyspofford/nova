"""A refusal, a failure and a stalled session all reach the log, with reasons.

    docker compose exec backend python tests/test_activity_log.py

MEASURED 2026-08-07, and it is the reason the surface exists. Jeremy: "She
cannot be silent on her actions. We lack logging." On this install that day,
`manage_curated_models` was refused twice by the goal gate and `pull_model`
once, `manage_automations` twice the day before — and her replies described
the work as attempted or done. Nothing in the product showed him a refusal:
`turn_traces.status` reads 'ok' for a turn whose every write was refused,
because the refusal lives one level down in `turn_spans.detail.error`, behind
a click into a one-turn-at-a-time inspector.

THE LOAD-BEARING PART IS THE FIRST SECTION. `activity_log` decides refused-vs
-failed by reading the string a gate returned, because `_run_tool` records
`detail.error` and nothing tags WHICH gate produced it. A text classifier goes
stale silently — so this suite does not assert against strings copied out of
registry.py. It drives the REAL gates through `registry.execute_tool` and
feeds whatever they actually return to the classifier. Reword a refusal
without teaching activity_log about it and this goes red, which is the only
reason the classifier is allowed to exist.

The asymmetry that makes staleness survivable is pinned too: an unrecognised
error must classify as `failed`, never as `ok`. A gate this module has fallen
behind on still shows up as a problem with its real text attached — the label
degrades, the action never disappears.
"""

import asyncio
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, "/app/backend")

from app import activity_log, db                            # noqa: E402
from app.tools import fixtures as tool_fixtures             # noqa: E402
from app.tools import registry as tool_registry             # noqa: E402
from app.tools import scopes                                # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def run(coro):
    return LOOP.run_until_complete(coro)


LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(LOOP)
run(db.init_pool())


# ── 1. the classifier, against what the gates REALLY say ─────────────────
#
# Each case drives execute_tool into one gate and hands the returned string
# straight to the classifier. Nothing here quotes a refusal sentence.

print("\nevery real gate's refusal is recognised AS a refusal")

#: THE PROBES RUN UNDER AN EMPTY REPLAY FIXTURE, and that is a safety
#: property, not tidiness. Two live side effects are otherwise on the table:
#:
#:   * the goal gate RAISES AN APPROVAL CARD when it refuses. registry.py
#:     documents exactly this going wrong — "a card timestamped 16:16:32
#:     landed inside the eval run that started at 16:16:10 ... nobody asked
#:     for either, and both sat in the inbox as real requests". A suite that
#:     posts decisions into Jeremy's inbox every time it runs is worse than
#:     no suite.
#:   * the goal-gate probe below WALKS the goal-scoped verbs looking for one
#:     the gate still refuses. On an install where the early verbs are
#:     pre-approved, the walk reaches a verb whose gate is OPEN — and without
#:     this guard `execute_tool` would then genuinely create an agent.
#:
#: The gates all fire ABOVE the fixture hook (registry.py says so at the goal
#: gate), so the real refusal strings are still produced and still classified.
#: This only removes the side effects of the calls that get PAST them.
PROBE_FIXTURE = tool_fixtures.Fixtures.for_replay([])


def refusal_from(name: str, args: dict, ctx: dict) -> str:
    """Call execute_tool and return what it refused with (or '' if it ran)."""
    async def _call():
        with tool_fixtures.using(PROBE_FIXTURE):
            return await tool_registry.execute_tool(name, args, ctx)
    out = run(_call())
    return out if tool_registry.is_error_result(out) else ""


# grant gate — a tool the calling agent does not hold
grant_refusal = refusal_from(
    "pull_model", {"name": "tinyllama"},
    {"granted": {"search_memory"}, "agent_name": "main"})
check("the grant gate produced a refusal at all", bool(grant_refusal),
      grant_refusal[:70])
if grant_refusal:
    outcome, reason = activity_log.classify_tool_error(grant_refusal)
    check("grant refusal classifies as REFUSED, not failed",
          outcome == activity_log.REFUSED, f"{outcome}: {grant_refusal[:60]}")
    check("the grant gate is named as the gate",
          activity_log.gate_of(grant_refusal) == "grant",
          str(activity_log.gate_of(grant_refusal)))
    check("the reason says what would change the answer", bool(reason), reason)

# containment fence — an ACTOR verb on a turn holding outside text
contain_refusal = refusal_from(
    "manage_tools", {"action": "create", "name": "x"},
    {"granted": {"manage_tools"}, "agent_name": "main",
     "untrusted_context": True})
check("the containment fence produced a refusal at all", bool(contain_refusal),
      contain_refusal[:70])
if contain_refusal:
    outcome, reason = activity_log.classify_tool_error(contain_refusal)
    check("containment refusal classifies as REFUSED",
          outcome == activity_log.REFUSED, f"{outcome}: {contain_refusal[:60]}")
    check("the containment fence is named as the gate",
          activity_log.gate_of(contain_refusal) == "containment",
          str(activity_log.gate_of(contain_refusal)))

# goal gate — the one that fired three times on 2026-08-07, and therefore the
# case this suite most needs to exercise.
#
# It only refuses when goal-scoped actions are on AND no active goal covers
# the verb, so naming ONE verb made the check skip itself the first time it
# ran: a live goal happened to cover `manage_tool_hosts`. Derived instead —
# walk the live goal-scoped set and take the first verb the gate actually
# refuses. `improve_self` is excluded because it deliberately names no tool
# (scopes.py), so execute_tool can never route to it.
goal_verb, goal_refusal = None, ""
for verb in sorted(scopes.GOAL_SCOPED_TOOLS - {"improve_self"}):
    said = refusal_from(verb, {"action": "add", "name": "activity-log-probe"},
                        {"granted": {verb}, "agent_name": "main"})
    if said and activity_log.gate_of(said) == "goal":
        goal_verb, goal_refusal = verb, said
        break
if goal_refusal:
    outcome, reason = activity_log.classify_tool_error(goal_refusal)
    check("goal-gate refusal classifies as REFUSED",
          outcome == activity_log.REFUSED, f"{outcome}: {goal_refusal[:60]}")
    check("the goal gate's reason names the missing approval",
          reason is not None and "goal" in reason.lower(), reason)
    # The reason must REPORT what the gate said about the card, never assert
    # that one is waiting — that is a claim about Jeremy's inbox, and it was
    # false for two days the last time something asserted it (registry.py).
    # Under this suite's replay fixture no card is raised, and the reason has
    # to say so rather than reassure.
    check("it does not claim a card is waiting when none was raised",
          "waiting for you" not in (reason or ""), reason)
else:
    # Every goal-scoped verb is currently pre-approved, or the setting is off.
    # That is a real state of the install and not a defect in this module — so
    # it is reported as unexercised rather than allowed to read like a pass.
    # A silent skip here would hide the exact gate this lane was built for.
    print("  ....  the goal gate refused none of "
          f"{len(scopes.GOAL_SCOPED_TOOLS) - 1} goal-scoped verbs — either "
          "autonomy.goal_scoped_actions is off or every verb is covered by an "
          "active goal. Classification NOT exercised.")

check("every verb the goal gate can refuse has a plain-language phrase",
      all(scopes.consequences([v]) or v == "improve_self"
          for v in scopes.GOAL_SCOPED_TOOLS),
      "so no refusal can render as a bare tool name")


print("\nan unrecognised error degrades to FAILED — never to ok")

for text in ("Error: item not found",
             "Error: HTTP 403 from https://example.invalid/x",
             "Error: duplicate key value violates unique constraint",
             "Error: something nobody has written yet",
             ""):
    outcome, _ = activity_log.classify_tool_error(text)
    check(f"{text[:44] or '(empty)'!r} is not reported as ok",
          outcome != activity_log.OK, outcome)

check("failed and refused are both inside the 'problems' filter",
      {activity_log.REFUSED, activity_log.FAILED} <= activity_log.PROBLEM_OUTCOMES,
      "so a stale label cannot hide an action from the default view")

check("a stalled coding session is a problem too",
      activity_log.STALLED in activity_log.PROBLEM_OUTCOMES)


# ── 2. the three shapes actually reach the page ──────────────────────────
#
# Real rows in the real tables, read back through the real read model, then
# removed. Nothing is asserted from a mock: the whole point of this lane is
# that the log describes what the system recorded.

print("\na refusal, a failure and a stalled session all appear, with reasons")

MARK = f"activity-log-suite-{uuid.uuid4().hex[:8]}"
trace_id = uuid.uuid4()
now = datetime.now(timezone.utc)
session_id = None
consent_id = None


def seed():
    async def _seed():
        global session_id, consent_id
        async with db.acquire() as conn:
            await conn.execute(
                "INSERT INTO turn_traces (id, source, model, status, started_at, "
                "finished_at) VALUES ($1, 'chat', 'suite', 'ok', $2, $2)",
                trace_id, now)
            # A REFUSAL: the goal gate's own sentence, taken from the live
            # gate above where it fired, so this row is not a fabrication of
            # what a refusal looks like.
            refusal_text = (goal_refusal or grant_refusal
                            or "Error: tool 'x' is not granted to this agent")
            await conn.executemany(
                "INSERT INTO turn_spans (id, trace_id, seq, kind, name, status, "
                "started_at, finished_at, detail) "
                "VALUES ($1, $2, $3, 'tool', $4, $5, $6, $6, $7)",
                [
                    (uuid.uuid4(), trace_id, 1, "pull_model", "error", now,
                     json.dumps({"agent": MARK, "args": '{"name": "tinyllama"}',
                                 "error": refusal_text})),
                    (uuid.uuid4(), trace_id, 2, "fetch_url", "error", now,
                     json.dumps({"agent": MARK,
                                 "args": '{"url": "https://example.invalid"}',
                                 "error": "Error: HTTP 403 from "
                                          "https://example.invalid/x"})),
                    (uuid.uuid4(), trace_id, 3, "search_memory", "ok", now,
                     json.dumps({"agent": MARK, "args": '{"query": "hi"}',
                                 "result_size": 12})),
                ])
            # A STALLED session: up for a while, nothing run. `state` is what
            # the reconciler writes after a LIVE poll found no progress.
            session_id = await conn.fetchval(
                "INSERT INTO coding_sessions (task, state, requested_by, "
                "created_at, updated_at, progress_at, error, commands, denials) "
                "VALUES ($1, 'stalled', $2, $3, $4, $4, $5, '[]'::jsonb, "
                "'[]'::jsonb) RETURNING id",
                "## The task\nMake the thing better", MARK,
                now - timedelta(minutes=31), now,
                "no progress for 30 minutes; last activity: none recorded")
            # A LAGGED CONSENT: raised well outside the 1h window, decided
            # inside it. Migration 123 indexes consents on COALESCE(decided_at,
            # created_at) precisely so "a consent raised on Monday and approved
            # on Wednesday lands on Wednesday" — but the read model filtered the
            # window on created_at while ordering on the COALESCE, so the
            # operator's own decision was absent from every window shorter than
            # the lag and then appeared, at its decision time, in a longer one.
            consent_id = await conn.fetchval(
                "INSERT INTO consents (kind, subject, question, requested_by, "
                "status, chosen, created_at, decided_at) "
                "VALUES ('delete', $1, 'May I?', $2, 'decided', 'approve', "
                "$3, $4) RETURNING id",
                f"{MARK}-lagged", MARK, now - timedelta(hours=20),
                now - timedelta(minutes=2))
    run(_seed())


def cleanup():
    async def _clean():
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM turn_traces WHERE id = $1", trace_id)
            if session_id:
                await conn.execute(
                    "DELETE FROM coding_sessions WHERE id = $1", session_id)
            if consent_id:
                await conn.execute("DELETE FROM consents WHERE id = $1",
                                   consent_id)
    run(_clean())


seed()
try:
    page = run(activity_log.fetch(window="1h", limit=200, agent=MARK))
    rows = {r.get("tool") or r["kind"]: r for r in page["rows"]}

    check("the refused tool call is on the page", "pull_model" in rows)
    if "pull_model" in rows:
        r = rows["pull_model"]
        check("it reads as REFUSED", r["outcome"] == activity_log.REFUSED,
              r["outcome"])
        check("it carries a reason", bool(r["reason"]), (r["reason"] or "")[:70])
        check("it names the gate", bool(r["gate"]), str(r["gate"]))
        check("it links to the full trace", r["trace_id"] == str(trace_id))
        check("it is in PLAIN LANGUAGE, not the tool name",
              "pull_model" not in r["title"], r["title"])
        check("the plain language is the approval card's own wording",
              r["title"] == scopes.consequences(["pull_model"])[0], r["title"])
        check("the arguments that matter are shown",
              "tinyllama" in r["detail"], r["detail"])

    check("the failed tool call is on the page", "fetch_url" in rows)
    if "fetch_url" in rows:
        r = rows["fetch_url"]
        check("it reads as FAILED, distinct from refused",
              r["outcome"] == activity_log.FAILED, r["outcome"])
        check("its reason is the real error text",
              "403" in (r["reason"] or ""), (r["reason"] or "")[:70])

    check("the successful call is on the page too", "search_memory" in rows)
    if "search_memory" in rows:
        check("and reads as ok", rows["search_memory"]["outcome"] == activity_log.OK)

    check("the stalled coding session is on the page", "coding" in rows)
    if "coding" in rows:
        r = rows["coding"]
        check("it reads as STALLED, not running", r["outcome"] == activity_log.STALLED,
              r["outcome"])
        check("it says WHY it is stalled", "no progress" in (r["reason"] or "").lower(),
              (r["reason"] or "")[:70])
        # Requirement 3: long-running work shows progress, not a state word.
        check("it shows progress, not just a state word",
              "command" in r["detail"], r["detail"])

    print("\nthe default view is the problems, and it excludes the successes")
    only = run(activity_log.fetch(window="1h", limit=200, agent=MARK,
                                  outcome="problems"))
    kinds = {r.get("tool") or r["kind"] for r in only["rows"]}
    check("refusal, failure and stall are all in 'problems'",
          {"pull_model", "fetch_url", "coding"} <= kinds, str(sorted(kinds)))
    check("the successful call is NOT", "search_memory" not in kinds)

    refused = run(activity_log.fetch(window="1h", limit=200, agent=MARK,
                                     outcome="refused"))
    names = {r.get("tool") for r in refused["rows"]}
    check("filtering to 'refused' excludes the failure",
          "pull_model" in names and "fetch_url" not in names, str(sorted(names)))

    print("\nit says what it capped rather than truncating quietly")
    small = run(activity_log.fetch(window="1h", limit=1, agent=MARK))
    check("a page that cut rows reports itself incomplete",
          small["complete"] is False, f"complete={small['complete']}")
    check("and names the sources it capped", bool(small["capped_sources"]),
          str(small["capped_sources"]))
    check("a page that cut nothing reports itself complete",
          page["complete"] is True, f"complete={page['complete']}")

    # THE HOLE THIS CLOSED. `problems_only` used to be pushed into SQL for
    # tool spans alone; every other source fetched its whole cap and was
    # narrowed in Python. A source that filled its cap with SUCCESSES then
    # contributed nothing to a problems page and was indistinguishable from a
    # source that had nothing wrong — so older failures inside the window did
    # not exist, and the page called itself complete. Every source now says
    # "not ok" in its own vocabulary, so a capped source on a problems page
    # really did fill its cap with problems.
    probs = run(activity_log.fetch(window="1h", limit=200, agent=MARK,
                                   outcome="problems"))
    check("a problems page fetches problems, not a page of successes to sift",
          all(r["outcome"] in activity_log.PROBLEM_OUTCOMES
              for r in probs["rows"] if r["kind"] != "meta"),
          str({r["outcome"] for r in probs["rows"]}))
    check("...and does not report itself capped when it was not",
          probs["complete"] is True, str(probs["capped_sources"]))

    print("\nfilters refuse what they do not understand")
    for bad, kwargs in (("window", {"window": "42y"}),
                        ("outcome", {"outcome": "fine"}),
                        ("kind", {"kinds": ["telepathy"]})):
        raised = False
        try:
            run(activity_log.fetch(**kwargs))
        except ValueError:
            raised = True
        check(f"an unknown {bad} raises rather than silently widening", raised)

    print("\nrows are attributed to who actually acted")
    check("every row carries an actor",
          all(r["actor"] for r in page["rows"]))
    check("the agent filter is honoured in SQL, not after the page cap",
          all(r["actor"] == MARK for r in page["rows"]))

    # ── the counts are the WINDOW's, not the page's ──────────────────────
    #
    # MEASURED on this install before the fix, same module, same window:
    #
    #   ?window=7d&limit=150          -> counts refused 4,  failed 27
    #   ?window=7d&outcome=problems   -> counts refused 15, failed 67
    #
    # `counts` was tallied over rows each source had already truncated at its
    # per-source ceiling, so the footer and the "problems N" chip reported the
    # newest slice and called it the window — while `complete` said True. The
    # number an operator reads must not move when the page size does.
    print("\nthe counts are the window's, and do not move with the page size")
    wide = run(activity_log.fetch(window="1h", limit=200, agent=MARK))
    tiny = run(activity_log.fetch(window="1h", limit=1, agent=MARK))
    check("a 1-row page reports the same counts as a 200-row page",
          tiny["counts"] == wide["counts"],
          f"{tiny['counts']} vs {wide['counts']}")
    check("...and the same matched total",
          tiny["matched"] == wide["matched"],
          f"{tiny['matched']} vs {wide['matched']}")
    check("the counts really did count every seeded row",
          wide["counts"].get("refused") == 1 and wide["counts"].get("failed") == 1
          and wide["counts"].get("stalled") == 1, str(wide["counts"]))

    probs_chip = sum(wide["counts"].get(k, 0)
                     for k in wide["problem_outcomes"])
    narrow_page = run(activity_log.fetch(window="1h", limit=200, agent=MARK,
                                         outcome="problems"))
    check("the 'problems N' chip equals what the problems filter returns",
          probs_chip == narrow_page["matched"],
          f"chip={probs_chip} filter={narrow_page['matched']}")
    ref_page = run(activity_log.fetch(window="1h", limit=200, agent=MARK,
                                      outcome="refused"))
    check("and the refused total equals what the refused filter returns",
          wide["counts"].get("refused", 0) == ref_page["matched"],
          f"{wide['counts'].get('refused')} vs {ref_page['matched']}")
    check("every source has a counter, so no source can go untallied",
          set(activity_log.COUNTERS) == set(activity_log.SOURCES),
          str(set(activity_log.SOURCES) ^ set(activity_log.COUNTERS)))
    check("the counts say whether they are whole",
          wide["counts_complete"] is True)

    # ── a cut page says so, and the cut rows are REACHABLE ───────────────
    #
    # It returned 150 of 383 with complete: True and no offset parameter, so
    # nothing told the operator 233 rows inside the window were missing and
    # nothing could have shown them to him if it had.
    print("\na cut page says so, and the rows it cut can be paged to")
    check("a page smaller than what matched is NOT called complete",
          tiny["complete"] is False, f"complete={tiny['complete']}")
    check("...and it says how many it is not showing",
          tiny["matched"] > tiny["returned"],
          f"matched={tiny['matched']} returned={tiny['returned']}")

    paged, seen = [], set()
    for off in range(0, wide["matched"]):
        one = run(activity_log.fetch(window="1h", limit=1, offset=off,
                                     agent=MARK))
        paged += [r["id"] for r in one["rows"]]
        seen |= {r["id"] for r in one["rows"]}
    check("paging one row at a time reaches every row, in the same order",
          paged == [r["id"] for r in wide["rows"]],
          f"{len(paged)} paged vs {wide['matched']} matched")
    check("no row is served twice while paging", len(paged) == len(seen))
    mid = run(activity_log.fetch(window="1h", limit=1, offset=1, agent=MARK))
    check("an offset page never claims to be the whole window",
          mid["complete"] is False)

    deep = False
    try:
        run(activity_log.fetch(window="1h", limit=activity_log.MAX_LIMIT,
                               offset=activity_log.MAX_SPAN))
    except ValueError:
        deep = True
    check("paging deeper than the merge can order is refused, not clamped",
          deep, "a clamped offset returns the wrong page and looks right")

    # ── the operator's own decision lands when he made it ────────────────
    print("\na consent decided inside the window is inside the window")
    lagged = f"consent:{consent_id}"
    hour = run(activity_log.fetch(window="1h", limit=200, kinds=["consent"],
                                  agent=MARK))
    ids = {r["id"] for r in hour["rows"]}
    check("a consent raised 20h ago and approved 2m ago is on the 1h page",
          lagged in ids, str(sorted(ids))[:120])
    row = next((r for r in hour["rows"] if r["id"] == lagged), None)
    check("and it is timestamped at the decision, matching migration 123",
          row is not None and abs((row["at"] - (now - timedelta(minutes=2)))
                                  .total_seconds()) < 5,
          str(row["at"]) if row else "absent")
finally:
    cleanup()


# ── a source that CRASHES is not a source that hit a page cap ────────────
#
# The notice reading "This part of the log is MISSING, not empty" was written
# with at=None and then sorted by `(at is not None, at)` DESC — which ranks it
# BELOW every real row, so it sorted to the bottom and fell off any full page.
# Verified in-process before the fix: a source patched to raise, fetch(limit=
# 200) -> 200 rows and zero notices. The crashed source was also filed under
# `capped_sources`, so the operator's only signal was a banner telling him to
# narrow the window — a crash reported as pagination, with advice that could
# never fix it.

print("\na source that cannot be read says so AT THE TOP, on every page size")

VICTIM = "ingest"
real_source = activity_log.SOURCES[VICTIM]


async def _raiser(*_a, **_k):
    raise RuntimeError("suite: this source is deliberately unreadable")


activity_log.SOURCES[VICTIM] = _raiser
try:
    for lim in (200, 1):
        d = run(activity_log.fetch(window="24h", limit=lim))
        meta = [r for r in d["rows"] if r["kind"] == "meta"]
        check(f"limit={lim}: the notice is on the page",
              len(meta) == 1, f"{len(meta)} notice(s) in {len(d['rows'])} rows")
        check(f"limit={lim}: and it is the FIRST row",
              bool(d["rows"]) and d["rows"][0]["kind"] == "meta",
              d["rows"][0]["kind"] if d["rows"] else "empty")
        check(f"limit={lim}: the page is not called complete",
              d["complete"] is False)
        check(f"limit={lim}: the crash is named as unreadable",
              VICTIM in d["unreadable_sources"], str(d["unreadable_sources"]))
        check(f"limit={lim}: and NOT as a source that hit the page cap",
              VICTIM not in d["capped_sources"], str(d["capped_sources"]))
finally:
    activity_log.SOURCES[VICTIM] = real_source


print()
if FAILURES:
    print(f"FAILED: {len(FAILURES)}")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all checks passed")
