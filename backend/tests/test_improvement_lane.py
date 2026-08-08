"""She improves herself unattended — and every rail that replaces the click.

    docker compose exec -T backend python tests/test_improvement_lane.py

ROADMAP #47 rails 2, 3 and 4, plus rail 1 finally becoming a GATE rather than
the annotation it shipped as. Spec: docs/plans/autonomous-improvement.md.

Jeremy removed the approval click on 2026-08-07: "that needs to be a
continuous ongoing process that I don't even think about or approve."
Removing an approval does not remove a control; it moves the control from a
human to a line of code. Every check below is one of those lines, and the four
that matter most are:

  * `action_worker.claim_next` STILL requires `rec.decided_by = 'operator'`
    for the operator's lane. The autonomous lane was added beside it, not on
    top of it. If that string ever leaves the SQL, the two authorities have
    been merged and the audit trail can no longer tell them apart.
  * `improve_self` names no tool. That is what makes it safe for
    `goals.spend_standing` to match on the verb alone rather than binding to
    an agent — the moment a tool takes that name, a scheduler could spend an
    approval the operator gave an agent, and this file goes red.
  * the tripwire protects the loop's own brakes, its scoreboard AND its
    budget. A pass that can edit `spend.py` has no ceiling.
  * an unmetered pass is recorded as unmetered, never as zero tokens. A
    ledger that reports a pass it could not measure as free is the
    fallback-that-reads-as-success this repo keeps deleting.

Runs entirely offline: pure functions, source-level assertions and the
migration's own text. No docker, no database, no model.
"""

import ast
import asyncio
import json
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "/app/backend")
sys.path.insert(0, str(Path(__file__).parent))

from app import goals, heartbeat, spend, tripwire            # noqa: E402
from app.actions import code_change                          # noqa: E402
from app.actions.schemas import CodeChangeBuild              # noqa: E402
from app.tools import scopes                                 # noqa: E402
from app.tools.builtin import BUILTIN_TOOLS                  # noqa: E402

import eval_floor                                            # noqa: E402

FAILURES: list[str] = []

REPO = Path("/app/backend")
MIGRATION = REPO / "app" / "migrations" / \
    "116_she_improves_herself_within_a_budget.sql"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def diff(*paths):
    """A minimal but real `git diff` over the given paths."""
    out = []
    for p in paths:
        out += [f"diff --git a/{p} b/{p}",
                "index 1111111..2222222 100644",
                f"--- a/{p}", f"+++ b/{p}",
                "@@ -1,3 +1,3 @@", " context", "-old", "+new"]
    return "\n".join(out) + "\n"


# ── 1. the verb, and why it is safe to spend without an agent ────────────────

print("\n1. improve_self is a lane, not a tool")

check("it is a verb a goal may pre-authorise",
      "improve_self" in scopes.GOAL_SCOPED_TOOLS)
check("...and one definition feeds the SQL, the scopes table and the "
      "heartbeat", goals.IMPROVE_SELF == "improve_self")
check("it names NO builtin tool — which is the entire safety argument for "
      "spending it without an agent name attached",
      "improve_self" not in BUILTIN_TOOLS)
check("every standing-lane verb names no tool, not just this one",
      not (goals.STANDING_VERBS & set(BUILTIN_TOOLS)),
      str(goals.STANDING_VERBS & set(BUILTIN_TOOLS)))
check("standing verbs are a SUBSET of the goal-scoped set — a lane cannot "
      "spend an authority a goal could never carry",
      goals.STANDING_VERBS <= scopes.GOAL_SCOPED_TOOLS)
check("it has no read exemption, so nothing about it is default-allowed",
      "improve_self" not in scopes.READ_ACTIONS)
check("needs_goal says so: with no goal, this authority does not exist",
      scopes.needs_goal("improve_self") is True)


print("\n2. the operator's card says what he is actually agreeing to")

effects = scopes.consequences(["improve_self"])
check("there is a consequence line at all", len(effects) == 1, str(effects))
check("...and it leads with the loop, because that is the biggest thing in "
      "the set", "self-improvement loop" in effects[0], effects[0][:80])
check("...and it states the two refusals he is relying on",
      "main" in effects[0] and "card" in effects[0], effects[0][:120])
mixed = scopes.consequences(["improve_self", "manage_tools"])
check("worst-first ordering puts it above tool management",
      mixed[0] == effects[0], str(mixed[:1]))


print("\n3. spend_standing refuses anything that names a tool")

try:
    asyncio.run(goals.spend_standing("manage_agents", lane="heartbeat"))
    check("a tool verb is refused", False, "it did not raise")
except ValueError as e:
    check("a tool verb is refused BEFORE any query — a goal approved for one "
          "agent must never be spendable by a scheduler", True, str(e)[:70])
except Exception as e:                                       # noqa: BLE001
    check("a tool verb is refused", False, f"wrong exception: {e!r}")

try:
    asyncio.run(goals.standing_for("pull_model"))
    check("the read-only sibling refuses it too", False, "it did not raise")
except ValueError:
    check("the read-only sibling refuses it too", True)
except Exception as e:                                       # noqa: BLE001
    check("the read-only sibling refuses it too", False, repr(e))


# ── 4. the claim gate: two lanes, and the first one is untouched ─────────────

print("\n4. claim_next keeps the operator lane and adds one beside it")

src = (REPO / "app" / "action_worker.py").read_text()
claim = src.split("async def claim_next")[1].split("async def ")[0]

check("the operator's approval is STILL required in SQL — deleting this line "
      "is what merges the two authorities",
      "rec.decided_by = 'operator'" in claim)
check("the operator lane is bound to lane = 'operator'",
      "r0.lane = 'operator'" in claim)
check("the goal lane exists and is bound to lane = 'goal'",
      "r0.lane = 'goal'" in claim)
check("...and requires its recommendation to have been decided by the goal, "
      "never by a person who did not decide it",
      "rec.decided_by = 'goal'" in claim)
check("the goal itself is re-read at claim time, so revoking it stops the "
      "loop with no code change",
      "g.status = 'active'" in claim and "g.expires_at" in claim)
check("...and the verb is checked against the goal's own array",
      "= ANY(g.approved_verbs)" in claim)
check("the verb is passed in rather than typed into the SQL",
      "goals.IMPROVE_SELF" in claim)
check("claims stay atomic across two backends",
      "FOR UPDATE SKIP LOCKED" in claim)

enq = src.split("async def enqueue_goal_run")[1].split("\nasync def ")[0]
check("the goal-lane enqueue only ever approves a plan that preflighted "
      "ready — the same check the operator's cards get",
      'state != "ready"' in enq)
check("...and re-asserts the goal is live inside the approving transaction",
      "status = 'active'" in enq and "conn.transaction()" in enq)
check("...and refuses to overwrite a decision the operator already made",
      "status = 'new' RETURNING id" in enq)


# ── 5. the tripwire covers the loop's brakes, scoreboard and wallet ─────────

print("\n5. a pass cannot edit its own brakes, scoreboard or budget")

for path, why in (
        ("backend/app/tripwire.py", "its own brakes"),
        ("backend/app/spend.py", "its own ceiling"),
        ("backend/app/heartbeat.py", "the clock that starts it"),
        ("backend/app/action_worker.py", "the claim gate"),
        ("backend/app/actions/code_change.py", "the executor"),
        ("backend/tests/eval_floor.json", "its own scoreboard"),
        ("backend/tests/eval_floor.py", "the thing that reads the scoreboard"),
        ("backend/tests/run_all.py",
         "the script the sandbox's suite stage actually runs, out of the "
         "candidate tree — edit it and 'the suite passed' means whatever "
         "the pass decided it means"),
        ("backend/app/coder.py",
         "the client that asks the sidecars for a verdict and writes the "
         "answer down; sandbox_verdict, eval_verdict and review_verdict are "
         "three of the four facts that stand in for him reading the diff"),
        ("backend/app/migrations/116_she_improves_herself_within_a_budget.sql",
         "the schema the lane runs on")):
    ok, _ = tripwire.may_land_unattended(diff(path))
    check(f"{path} does not land unattended — {why}", ok is False)

ok, _ = tripwire.may_land_unattended(diff("backend/app/summariser.py"))
check("...while ordinary code still flows, which is the point of a list "
      "rather than a lock", ok is True)


# ── 6. the eval floor is a ratchet, and 'unmeasured' is not a pass ──────────

print("\n6. the eval floor only moves up")

tmp = Path(tempfile.mkdtemp(prefix="floor-")) / "eval_floor.json"
real_floor = eval_floor.FLOOR_FILE
try:
    eval_floor.FLOOR_FILE = tmp
    check("a missing floor file reads as no floors, not as a crash",
          eval_floor.read_floors() == {})

    moves = eval_floor.write_floors({"main": 0.8}, {})
    check("a first measurement seeds a floor", eval_floor.read_floors()
          == {"main": 0.8}, str(moves))

    eval_floor.write_floors({"main": 0.6}, {"main": 0.8})
    check("a LOWER measurement never lowers the floor — a floor someone can "
          "quietly lower reads as green while eroding",
          eval_floor.read_floors() == {"main": 0.8})

    eval_floor.write_floors({"main": 0.9}, {"main": 0.8})
    check("a higher one raises it", eval_floor.read_floors() == {"main": 0.9})

    tmp.write_text("{ not json")
    try:
        eval_floor.read_floors()
        check("a corrupt floor file FAILS rather than reading as no floors",
              False, "it returned quietly")
    except SystemExit:
        check("a corrupt floor file FAILS rather than reading as no floors",
              True)
finally:
    eval_floor.FLOOR_FILE = real_floor

check("the three verdicts have distinct exit codes, so 'the machine could "
      "not measure' cannot be read as 'the change is bad'",
      len(set(eval_floor.EXIT.values())) == 3
      and eval_floor.EXIT["ok"] == 0 and eval_floor.EXIT["below"] != 0
      and eval_floor.EXIT["unmeasured"] != eval_floor.EXIT["below"])

shipped = json.loads(real_floor.read_text())
check("the shipped floor file parses", isinstance(shipped.get("suites"), dict))
check("...and ships EMPTY, because a floor invented rather than measured is "
      "a gate calibrated against nothing", shipped["suites"] == {})

#: The sidecar's source, from the checkout mounted at /app/project — the same
#: place `test_compose_contract` finds the compose file. A bare image with no
#: checkout has nothing to read and says so rather than passing silently.
sandbox_src = next((p for p in (Path("/app/project/inference-control/server.py"),
                                Path("/repo/inference-control/server.py"))
                    if p.exists()), None)
if sandbox_src:
    s = sandbox_src.read_text()
    check("the sandbox runs the eval floor as a stage",
          "tests/eval_floor.py" in s)
    check("...a measured regression FAILS the sandbox",
          'ev["state"] == "below"' in s)
    check("...and a missing verdict line is 'unmeasured', never 'ok'",
          '"state": "unmeasured"' in s)
else:
    print("  SKIP  the sandbox stage is checked from the repo mount, which is "
          "not present in this container")


# ── 7. the spend meter: unmetered is not zero ───────────────────────────────

print("\n7. what could not be measured is not reported as free")

check("no usage anywhere returns None, not a zeroed dict",
      spend.usage_from_updates([{"tool": "bash"}, {"permission": "allowed"}])
      is None)
check("a non-list returns None rather than exploding",
      spend.usage_from_updates("nope") is None
      and spend.usage_from_updates(None) is None)

acp = [{"usage": {"inputTokens": 10, "outputTokens": 2}},
       {"tool": "bash"},
       {"usage": {"inputTokens": 90, "outputTokens": 30,
                  "cachedReadTokens": 5}}]
got = spend.usage_from_updates(acp)
check("the LAST usage frame wins — ACP counts are cumulative, so summing "
      "them would multiply a session's cost by how often it reported",
      got == {"tokens_in": 90, "tokens_out": 30, "cached_tokens": 5}, str(got))
check("snake_case and the OpenAI spelling are understood too — three "
      "adapters exist and they do not agree",
      spend.usage_from_updates([{"prompt_tokens": 4, "completion_tokens": 1}])
      == {"tokens_in": 4, "tokens_out": 1, "cached_tokens": None})

print("\n8. the ceiling fails closed")


def _day(**over):
    """A `spend.today()` result. Every key the real one returns, so a stub
    that has drifted from the function it impersonates fails here rather than
    quietly answering a question `may_start` no longer asks."""
    base = {"lane": spend.LANE_IMPROVE, "passes": 0, "attempts": 0,
            "entries": 0, "unmetered": 0, "tokens_in": 0, "tokens_out": 0,
            "tokens": 0, "usd": 0.0}
    base.update(over)
    return base


async def _ceiling_cases():
    out = {}
    orig_c, orig_t = spend.ceilings, spend.today
    orig_w = spend.active_wall

    # The wall backoff reads the LIVE ledger when a database is reachable —
    # and in the backend container one is, complete with whatever refusals
    # last night really recorded. These cases are about the CEILING, so the
    # wall is stubbed clear, the same way ceilings/today are; the backoff has
    # its own suite (test_improve_walls.py).
    async def _no_wall(lane=spend.LANE_IMPROVE, **_):
        return None
    spend.active_wall = _no_wall

    async def _raises(lane=spend.LANE_IMPROVE, **_):
        raise spend.NoCeiling("the row is gone")
    spend.ceilings = _raises
    out["unreadable"] = await spend.may_start()

    async def _cap(lane=spend.LANE_IMPROVE, **_):
        return {"lane": lane, "max_passes": 4, "max_tokens": 100,
                "max_usd": 5.0, "updated_at": None, "updated_by": "t"}

    def _spender(**over):
        async def _f(lane=spend.LANE_IMPROVE, *, exclude_run=None):
            out.setdefault("seen_exclude", []).append(exclude_run)
            return _day(lane=lane, **over)
        return _f

    spend.ceilings = _cap
    spend.today = _spender(passes=4, attempts=4, entries=4, unmetered=4)
    out["passes"] = await spend.may_start()

    spend.today = _spender(passes=1, attempts=3, entries=3,
                           tokens_in=60, tokens_out=60, tokens=120)
    out["tokens"] = await spend.may_start()

    spend.today = _spender(passes=1, attempts=3, entries=3, unmetered=2,
                           tokens_in=5, tokens_out=5, tokens=10, usd=0.5)
    out["fine"] = await spend.may_start()

    # THE DEFECT THIS PINS. One pass that retried three times writes three
    # `coding_session` rows. When those rows were counted as passes, this
    # state refused — three of the operator's four spent on ONE pass, while
    # the consent card promised him four.
    spend.today = _spender(passes=1, attempts=3, entries=3, unmetered=3)
    out["retried"] = await spend.may_start()

    # ...and the ceiling still binds on PASSES, whatever the attempts did.
    spend.today = _spender(passes=4, attempts=12, entries=12, unmetered=12)
    out["four_passes"] = await spend.may_start()

    # A pass re-checking the ceiling mid-flight hands its own run id down.
    out["seen_exclude"] = []
    spend.today = _spender(passes=0, attempts=1, entries=1)
    await spend.may_start(exclude_run="a-run-id")

    spend.ceilings, spend.today = orig_c, orig_t
    spend.active_wall = orig_w
    return out


cases = asyncio.run(_ceiling_cases())
check("a ceiling that cannot be read REFUSES — 'I could not find out what "
      "the limit is' and 'the limit is fine' are not the same answer",
      cases["unreadable"][0] is False, cases["unreadable"][1][:60])
check("the pass ceiling refuses, and names both numbers",
      cases["passes"][0] is False and "4" in cases["passes"][1])
check("the token ceiling refuses on measured tokens alone",
      cases["tokens"][0] is False and "token" in cases["tokens"][1])
check("under every ceiling it allows the pass", cases["fine"][0] is True)
check("...and SAYS how much of the day it could not measure, so a small "
      "number is not mistaken for a small bill",
      "no usage figures" in cases["fine"][1], cases["fine"][1][-90:])

check("ONE pass that retried three times is one pass, not three — the "
      "number on the consent card has to be the number the code enforces",
      cases["retried"][0] is True, cases["retried"][1][:80])
check("...and it SAYS what was really run, so 'pass 2 of 4' cannot hide "
      "three coding sessions",
      "3 coding attempts" in cases["retried"][1], cases["retried"][1][:90])
check("four passes still refuse however many attempts they took",
      cases["four_passes"][0] is False
      and "12 coding attempts" in cases["four_passes"][1],
      cases["four_passes"][1][:90])
check("a mid-flight re-check excludes its own run, so the pass the ceiling "
      "just authorised is not refused by its own existence",
      cases["seen_exclude"] == ["a-run-id"], str(cases["seen_exclude"]))

# The SQL is the thing that actually counts, and it is the only part of this
# no-database suite that cannot be executed here. Read it instead: `passes`
# must be a DISTINCT count over runs, and `attempts` the row count. The
# defect was `count(*) FILTER (WHERE kind = $2) AS passes`.
_sql = " ".join(spend._TODAY_SQL.split())
check("passes is counted DISTINCT over the run, not per ledger row",
      "count(DISTINCT coalesce(run_id::text" in _sql, _sql[:120])
check("...and the attempts beside it are the row count",
      "count(*) FILTER (WHERE kind = $2) AS attempts" in _sql)
check("...and a row with no run_id gets its own bucket rather than being "
      "folded into somebody else's pass",
      "'row:' || id::text" in _sql)

# ...and the writer. If `run_id` stops being written, every entry falls back
# to its own bucket and the ceiling silently returns to counting attempts.
_build_src = ast.get_source_segment(
    (REPO / "app" / "actions" / "code_change.py").read_text(),
    next(n for n in ast.parse(
        (REPO / "app" / "actions" / "code_change.py").read_text()).body
         if isinstance(n, ast.AsyncFunctionDef) and n.name == "_step_build"))
check("the build loop writes run_id on every ledger entry — without it "
      "nothing downstream can tell three attempts from three passes",
      "run_id=run_id" in _build_src)
check("...and re-checks the ceiling excluding its own run",
      "exclude_run=run_id" in _build_src)


# ── 9. the migration, and the numbers agreeing with the code ────────────────

print("\n9. migration 116 carries the schema, and the grant")

sql = MIGRATION.read_text()
check("the lane column exists and defaults to the lane that needs a human",
      "lane text NOT NULL DEFAULT 'operator'" in sql)
check("a goal-lane run with no goal is UNREPRESENTABLE, not merely unusual",
      "action_runs_goal_lane_has_goal" in sql and
      "lane <> 'goal' OR goal_id IS NOT NULL" in sql)
check("one improvement run at a time, refused by an index rather than by a "
      "check two schedulers could both pass",
      "action_runs_one_live_goal_run" in sql and "UNIQUE INDEX" in sql)
check("the ledger's token columns are NULLABLE — a zero would read as free",
      re.search(r"tokens_in\s+bigint,", sql) is not None)
check("...and every row records whether it was metered at all",
      "metered     boolean NOT NULL DEFAULT false" in sql)
check("the ceiling lives in a row so lowering it takes effect on the next "
      "check, not the next deploy", "CREATE TABLE IF NOT EXISTS spend_ceilings" in sql)

seeded = re.search(r"VALUES \('improve', (\d+), (\d+), ([\d.]+)\)", sql)
check("the seeded ceiling is readable from the migration", seeded is not None)
if seeded:
    check("...and spend.SEEDED states the same numbers the migration writes",
          spend.SEEDED == {"max_passes": int(seeded.group(1)),
                           "max_tokens": int(seeded.group(2)),
                           "max_usd": float(seeded.group(3))},
          f"{spend.SEEDED} vs {seeded.groups()}")

check("the eval verdict is recorded per commit, like the sandbox's",
      "eval_commit" in sql and "eval_status" in sql)

check("THE GRANT: the migration proposes the goal that carries the verb — a "
      "capability nothing holds is not a capability",
      "improve_self" in sql and "INSERT INTO goals" in sql)
check("...and raises the consent card that activates it",
      "INSERT INTO consents" in sql and "goal.activate" in sql)
check("...and the goal is inserted as 'proposed' — the migration proposes, "
      "it does not decide",
      re.search(r"INSERT INTO goals.*?'proposed'", sql, re.S) is not None)
check("...and NOTHING here activates a goal, which would be this file "
      "granting his approval on his behalf",
      "UPDATE goals" not in sql and "activated_at" not in sql
      and "= 'active'" not in sql)
check("the card states the refusals he is relying on rather than only the "
      "permission he is giving",
      "does NOT land" in sql and "merges to main" in sql)


# ── 10. the executors: the lane decides, and the operator's path is intact ──

print("\n10. the tripwire is a GATE in the goal lane and a NOTE in his")

check("an absent lane means the operator's — the safe direction for every "
      "caller that predates the column",
      code_change._lane({}) == "operator"
      and code_change._lane(None) == "operator"
      and code_change._lane({"lane": None}) == "operator")
check("...and a goal-lane run says so", code_change._lane({"lane": "goal"})
      == "goal")

check("the build action has two steps now: write it, then decide whether it "
      "may land itself",
      [n for n, _ in code_change.BUILD_STEPS] == ["build", "verify-and-land"])


class _Ctx:
    def __init__(self):
        self.scratch = {}
        self.recorded = []

    async def record(self, *a):
        self.recorded.append(a)


operator_result = asyncio.run(code_change._step_verify_and_land(
    CodeChangeBuild(type="code_change.build", workspace="nova",
                    task="x" * 30, why="t"),
    {"lane": "operator"}, _Ctx()))
check("an operator-lane build lands NOTHING — his flow is untouched, and "
      "this step must never grow a behaviour there",
      operator_result["landed"] is False
      and operator_result["status"] == "ok", str(operator_result)[:90])

land_src = (REPO / "app" / "actions" / "code_change.py").read_text()
gate = land_src.split("async def _step_verify_and_land")[1]
check("the autonomous path re-reads the sandbox verdict rather than trusting "
      "the step before it", "sandbox_verdict" in gate)
check("...requires the eval floor to be exactly 'ok', so 'unmeasured' is "
      "treated like failed where nobody is reading",
      'evd.get("state") != "ok"' in gate)
check("...requires a different model to have passed it",
      'rv.get("state") != "pass"' in gate)
check("...and reviews BEFORE checking the floor, so every card its refusal "
      "path raises is one he can actually approve — a code_change.land "
      "preflight refuses an unreviewed session",
      gate.index("review_verdict") < gate.index("eval_verdict"))
check("...and computes the protected paths FROM THE DIFF, never from what "
      "the coding agent said it changed",
      "tripwire.may_land_unattended" in gate and "coder.patch" in gate)
check("a blocked change becomes a CARD rather than a failure — 'it becomes a "
      "card and waits for Jeremy' is the spec's own sentence",
      gate.count("_card_instead") >= 3)

card_src = land_src.split("async def _card_instead")[1].split("\nasync def ")[0]
check("and if that card cannot be raised, the run FAILS — a verified, "
      "unlanded, invisible change is the silent no-op this lane removes",
      '"status": "error"' in card_src)


# ── 11. the heartbeat is the clock, and it is mechanical ───────────────────

print("\n11. the clock: no model decides whether a pass starts")

hb = (REPO / "app" / "heartbeat.py").read_text()
tick = hb.split("async def improve_tick")[1].split("\nasync def ")[0]
check("the tick charges the goal atomically", "spend_standing" in tick)
check("...only after the ceiling has cleared it, so a refused pass does not "
      "consume the standing approval",
      tick.index("may_start") < tick.index("spend_standing"))
check("...and refuses to start a second concurrent pass",
      "lane = 'goal'" in tick and "'queued', 'running', 'blocked'" in tick)
check("no agent, no model and no prompt appears in the decision to start",
      "run_agent" not in tick and "PROMPT" not in tick)
check("a charged action that then fails to start is REPORTED, not swallowed",
      "charged one action and then failed" in tick)
check("the beat runs the tick before the active-hours gate — active hours "
      "govern interrupting him, not when a machine may work",
      hb.index("improve_tick()") < hb.index("within_active_hours(now_local"))
check("a broken tick can never fail the heartbeat, which would auto-disable "
      "the automation that also does the checking",
      "improve: FAILED" in hb)

task = heartbeat._build_task(
    {"title": "Make retrieval better", "target": "recall@5 above 0.8",
     "description": "the ranking test is flaky"})
check("the task is built from the GOAL ROW, never from prose an agent wrote",
      "Make retrieval better" in task and "recall@5" in task
      and "the ranking test is flaky" in task)
check("...and tells the agent an honest no-op beats an invented change",
      "no-op" in task)
bare = heartbeat._build_task({"title": "x"})
check("a bare goal still clears the schema's 20-character minimum",
      len(bare) >= 20, str(len(bare)))
try:
    CodeChangeBuild(type="code_change.build", workspace="nova", task=bare,
                    attempts=3, why="pass 1")
    check("...and the whole action typechecks against the schema door", True)
except Exception as e:                                       # noqa: BLE001
    check("...and the whole action typechecks against the schema door",
          False, repr(e))
check("the task is bounded — the schema caps it at 4000 and this caps it "
      "lower, so a huge goal description cannot make the plan unparseable",
      len(heartbeat._build_task({"title": "t", "description": "y" * 9000}))
      <= 3000)


# ── 12. actions/ still holds no model ──────────────────────────────────────

print("\n12. the executor package still cannot run a model itself")

banned = ("app.llm", "app.agents.runner", "openai", "anthropic")
tree = ast.parse(land_src)
imported = set()
for node in ast.walk(tree):
    if isinstance(node, ast.ImportFrom) and node.module:
        imported.add(node.module)
    elif isinstance(node, ast.Import):
        imported.update(a.name for a in node.names)
check("code_change imports no LLM client at any depth — the review runs "
      "inside coder.review, which is a different module for this reason",
      not any(m == b or m.startswith(b + ".")
              for m in imported for b in banned),
      str(sorted(imported)))


print()
if FAILURES:
    print(f"FAILED: {len(FAILURES)}")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all checks passed")
