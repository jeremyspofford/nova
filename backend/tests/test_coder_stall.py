"""A coding session that died says so, and only after somebody looked.

    docker compose exec backend python tests/test_coder_stall.py

MEASURED 2026-08-07. Session 6d085e4f was started at 18:34:08, ran `ls
/workspaces/`, hit a permission error, and stopped. Twenty-four minutes later
its row still read `state = 'running'`, and Nova — asked how it was going —
reported it as still running, because that is what the row said. Nothing in
the system could tell a session that was thinking from a session that was
dead.

Two properties are defended here, and the second is the one that is easy to
get wrong:

1. The progress clock moves on PROGRESS, not on attention. `updated_at` could
   not answer this: `_update` stamps it on every write and `refresh` writes on
   every poll, so it measures who is watching. Polling a wedged session in a
   loop kept it looking alive; not polling a healthy one made it look dead.

2. `stalled` is only ever written after a live poll. Marking a row stalled
   because nobody refreshed it would convert "we stopped looking" into "it
   died" — an answer that is wrong in the reassuring direction, which is the
   failure mode this repo keeps rediscovering.
"""

import sys

sys.path.insert(0, "/app/backend")

from app import coder, db                                # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


print("\nfingerprint — what counts as progress")

base = {"state": "running", "commit": "", "diffstat": "",
        "commands": ["ls"], "denials": []}

check("identical polls produce an identical fingerprint",
      coder._fingerprint(base) == coder._fingerprint(dict(base)))

check("a new command moves it",
      coder._fingerprint(base)
      != coder._fingerprint({**base, "commands": ["ls", "cat x"]}))

check("a new denial moves it",
      coder._fingerprint(base)
      != coder._fingerprint({**base, "denials": ["write /etc"]}))

check("a commit moves it",
      coder._fingerprint(base)
      != coder._fingerprint({**base, "commit": "abc123"}))

check("a state change moves it",
      coder._fingerprint(base)
      != coder._fingerprint({**base, "state": "done"}))

check("a diffstat change moves it",
      coder._fingerprint(base)
      != coder._fingerprint({**base, "diffstat": "3 files changed"}))

# The broker returns the WHOLE list every poll, so a fingerprint over contents
# would compare a growing prefix against itself. Counts are what actually move.
check("re-reporting the same command list is NOT progress",
      coder._fingerprint({**base, "commands": ["ls"]})
      == coder._fingerprint({**base, "commands": ["ls"]}))

check("an empty body fingerprints without raising",
      isinstance(coder._fingerprint({}), str))


print("\nstall window")

check("the window is minutes, not seconds — a compile is not a death",
      coder._STALL_AFTER_S >= 300,
      f"{coder._STALL_AFTER_S}s")

check("'stalled' is terminal, so refresh stops polling it",
      "stalled" in coder.TERMINAL)

check("the live states are still non-terminal",
      not {"running", "starting"} & coder.TERMINAL)


print("\nreconcile refuses rather than reporting a comfortable zero")


def _run(coro):
    import asyncio
    return asyncio.get_event_loop().run_until_complete(coro)


_run(db.init_pool())

_real_configured = coder.configured
try:
    coder.configured = lambda: False
    ok, summary = _run(coder.reconcile_stalled())
    # With live sessions on the box this must FAIL: rows claiming to be
    # running with no broker to ask are unknown, not fine. With none, there
    # is genuinely nothing to do and failing five times would auto-disable
    # the automation on an install that simply does not use delegation.
    if "no live coding sessions" in summary:
        check("an idle install is a clean run, not a false alarm", ok is True,
              summary)
    else:
        check("live sessions with no broker is a FAILED run, not '0 stalled'",
              ok is False, summary)
        check("...and the summary says their state is UNKNOWN, not fine",
              "unknown" in summary.lower(), summary)
finally:
    coder.configured = _real_configured


print("\nrepo facts are read, not remembered")
facts = _run(coder._repo_facts())
check("names the real migrations directory",
      "backend/app/migrations/" in facts)
check("states plainly that there is no Alembic",
      "alembic" in facts.lower() and "no alembic" in facts.lower())
check("carries a concrete next migration number",
      any(c.isdigit() for c in facts.split("next free number is")[-1][:12]),
      facts.split("next free number is")[-1][:20].strip())
check("lists real tables from the live database",
      "coding_sessions" in facts and "curated_models" in facts)
check("the task text follows the facts",
      facts.rstrip().endswith("## The task"))

# ── the 2026-08-09 race: writers and reconcilers against a mid-judged row ────
#
# The improve pass that clobbered its own runner left one invariant behind
# (see the note at coder.TERMINAL): a row may only become terminal-done
# carrying the broker's finalize results, and nothing may mark a live-broker
# session terminal without the broker's own testimony. These checks run the
# REAL functions against the live schema, with the broker stubbed at the
# httpx seam and every inserted row deleted in the finally below.

print("\nthe 2026-08-09 race: writers, judges and the reconciler")

import json as _json                                     # noqa: E402
import uuid as _uuid                                     # noqa: E402

import httpx as _httpx                                   # noqa: E402

_test_ids: list = []


async def _insert_session(state, broker_id, *, progress_age_s=0, commit=None,
                          requested_by=None, workspace_id=None):
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO coding_sessions
                   (workspace_id, task, state, broker_session_id, commit_sha,
                    requested_by, progress_at)
               VALUES ($1, $2, $3, $4, $5, $6,
                       now() - ($7::int * interval '1 second'))
               RETURNING id""",
            workspace_id, "TEST ROW (test_coder_stall) — safe to delete",
            state, broker_id, commit, requested_by, int(progress_age_s))
    _test_ids.append(row["id"])
    return row["id"]


async def _session_state(sid):
    async with db.acquire() as conn:
        return await conn.fetchrow(
            "SELECT state, commit_sha, patch FROM coding_sessions "
            "WHERE id = $1", sid)


class _Resp:
    def __init__(self, code, body):
        self.status_code = code
        self._body = body
        self.text = _json.dumps(body)

    def json(self):
        return self._body


class _FakeClient:
    """Stands in for httpx.AsyncClient at coder's own seam. Session polls pop
    a script; /patch always answers with a small real-looking patch."""
    session_script: list = []

    def __init__(self, timeout=None):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, headers=None):
        if url.endswith("/patch"):
            return _Resp(200, {"patch": "diff --git a/x b/x\n--- a/x\n"
                                        "+++ b/x\n"})
        return _Resp(200, _FakeClient.session_script.pop(0))


class _DeadClient(_FakeClient):
    async def get(self, url, headers=None):
        raise _httpx.ConnectError("broker unreachable (test)")


class _FakeHttpx:
    HTTPError = _httpx.HTTPError
    AsyncClient = _FakeClient


_saved_httpx = coder.httpx
_saved_grace = coder._FINALIZE_GRACE_S
_saved_refresh = coder.refresh
_saved_configured = coder.configured
try:
    tag = _uuid.uuid4().hex[:8]

    # 1. THE RECONCILER: a stale poll is "could not look", never a checked one.
    sid_a = _run(_insert_session("running", f"test-broker-a-{tag}",
                                 progress_age_s=7200))
    polled = []

    async def _stale_refresh(session_id):
        polled.append(str(session_id))
        return {"state": "running", "stale": True,
                "detail": "broker unreachable (test)"}

    coder.refresh = _stale_refresh
    coder.configured = lambda: True
    ok, summary = _run(coder.reconcile_stalled())
    row_a = _run(_session_state(sid_a))
    check("a stale poll counts UNREACHABLE and fails the run, never '0 stalled'",
          ok is False and "unreachable" in summary, summary)
    check("…and the overdue row was NOT marked stalled off the row alone",
          row_a["state"] == "running", row_a["state"])
    check("…though the reconciler did poll it",
          str(sid_a) in polled, f"{len(polled)} poll(s)")

    # …while a LIVE poll that finds no progress still stalls it: the guard
    # narrows what may testify, not the stall window itself.
    async def _live_refresh(session_id):
        if str(session_id) == str(sid_a):
            return {"state": "running"}
        return {"state": "running", "stale": True, "detail": "not this row"}

    coder.refresh = _live_refresh
    _ok2, _summary2 = _run(coder.reconcile_stalled())
    row_a = _run(_session_state(sid_a))
    check("a LIVE poll that finds no progress still stalls it",
          row_a["state"] == "stalled", row_a["state"])
    coder.refresh = _saved_refresh
    coder.configured = _saved_configured

    # 2. THE WRITER: refresh re-reads a done-without-commit snapshot before
    # the row becomes terminal, so a mid-finalize poll cannot blind it.
    sid_b = _run(_insert_session("running", f"test-broker-b-{tag}"))
    coder.httpx = _FakeHttpx
    coder._FINALIZE_GRACE_S = 0.0
    _FakeClient.session_script = [
        {"state": "done", "commit": "", "diffstat": "",
         "commands": [], "denials": []},
        {"state": "done", "commit": "cafef00d1234", "diffstat": "1 file "
         "changed", "commands": [], "denials": []},
    ]
    out_b = _run(coder.refresh(str(sid_b)))
    row_b = _run(_session_state(sid_b))
    check("refresh re-polls a 'done, no commit' snapshot before persisting it",
          out_b.get("commit") == "cafef00d1234", str(out_b.get("commit")))
    check("…the row went terminal-done WITH the broker's finalize results",
          row_b["state"] == "done" and row_b["commit_sha"] == "cafef00d1234")
    check("…and the patch was captured on that same poll",
          (row_b["patch"] or "").startswith("diff --git"))

    # 3. THE JUDGE'S RE-READ: a poisoned terminal row (done, NULL commit — the
    # racing writer's artifact) is repaired from the broker, not believed.
    sid_c = _run(_insert_session("done", f"test-broker-c-{tag}"))
    _FakeClient.session_script = [
        {"state": "done", "commit": "beefcafe0042",
         "diffstat": "2 files changed"},
    ]
    got_c = _run(coder.confirm_no_work(str(sid_c)))
    row_c = _run(_session_state(sid_c))
    check("confirm_no_work asks the BROKER, not the poisoned row",
          got_c.get("no_work") is False and got_c.get("checked") == "broker",
          str({k: got_c.get(k) for k in ('no_work', 'checked')}))
    check("…and repairs the row, undoing the blinding",
          row_c["commit_sha"] == "beefcafe0042", str(row_c["commit_sha"]))
    out_c = _run(coder.refresh(str(sid_c)))
    check("…so even the terminal short-circuit now shows the work",
          out_c.get("commit") == "beefcafe0042")

    # 4. HONEST FALLBACK: an unaskable broker cannot confirm a no-op, and the
    # answer says only the ROW testified — and nothing is downgraded.
    coder.httpx = type("X", (), {"HTTPError": _httpx.HTTPError,
                                 "AsyncClient": _DeadClient})
    got_a = _run(coder.confirm_no_work(str(sid_a)))
    row_a = _run(_session_state(sid_a))
    check("an unreachable broker means the verdict is row-only, and says so",
          got_a.get("no_work") is True and got_a.get("checked") == "row",
          str(got_a.get("detail"))[:60])
    check("…and confirm_no_work never rewrites the row it was asked about",
          row_a["state"] == "stalled", row_a["state"])
    coder.httpx = _saved_httpx

    # 5. THE STRANDED-WORK LOOKUP, against the live schema. Uses any real
    # action_runs row purely as a time bound — our session rows are newer.
    from app.actions import code_change as _cc               # noqa: E402
    async def _bounds():
        async with db.acquire() as conn:
            run = await conn.fetchrow(
                "SELECT id FROM action_runs ORDER BY created_at LIMIT 1")
            ws = await conn.fetchrow("SELECT id, name FROM workspaces LIMIT 1")
        return run, ws
    run_row, ws_row = _run(_bounds())
    if run_row and ws_row:
        sid_d = _run(_insert_session(
            "done", f"test-broker-d-{tag}", commit="deadbeef01",
            requested_by="code_change.build", workspace_id=ws_row["id"]))
        found = _run(_cc._stranded_sessions(
            str(run_row["id"]), ws_row["name"], None))
        check("the stranded-work lookup finds a committed terminal session "
              "on the live schema",
              any(str(r["id"]) == str(sid_d) for r in found),
              f"{len(found)} row(s)")
        other_goal = _run(_cc._stranded_sessions(
            str(run_row["id"]), ws_row["name"], str(_uuid.uuid4())))
        check("…and the goal filter excludes other goals' sessions",
              all(str(r["id"]) != str(sid_d) for r in other_goal))
    else:
        print("  SKIP  no action_runs/workspaces rows on this install")
finally:
    coder.httpx = _saved_httpx
    coder._FINALIZE_GRACE_S = _saved_grace
    coder.refresh = _saved_refresh
    coder.configured = _saved_configured

    async def _cleanup():
        async with db.acquire() as conn:
            await conn.execute(
                "DELETE FROM coding_sessions WHERE id = ANY($1::uuid[])",
                _test_ids)
    _run(_cleanup())


print()
if FAILURES:
    print(f"FAILED: {len(FAILURES)}")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all checks passed")
