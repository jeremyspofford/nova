"""`list_recent_actions` answers "what did you do?" from the ledger, honestly.

    docker compose exec backend python tests/test_recent_actions_tool.py

The tool exists because of the forged-receipt failure class: she has claimed
refused calls as done, quoted a diffstat nobody produced, and invented a
session id — each time answering from the transcript, where her own claims
live. The tool wraps `activity_log.fetch`, so the ROWS are that module's
problem (tests/test_activity_log.py); what this suite defends is the
wrapper's own honesty contract:

  1. THE DECLARATION — read-only, and the schema's window/kind choices are
     DERIVED from activity_log's own tables, not a second list that drifts.
  2. NO SILENT TRUNCATION — `shown` vs `matched` plus a CAPPED note whenever
     the page is not the whole answer, including when the trim to the turn's
     context window is what cut it. The trim once deleted 10-at-a-time past
     its own floor (10 rows -> 0), which is a page that reads as "nothing
     happened"; pinned here.
  3. MISSING IS SAID — an unreadable source and an uncountable source each
     produce a note; meta rows never masquerade as actions.
  4. REFUSED INPUT, NOT GUESSED — a wrong window comes back as fetch's own
     error naming the accepted values.
  5. LIVE WIRING — through `registry.execute_tool` with main's real resolved
     grants, the same gate path a turn takes (a tool is not a capability
     until an agent holds it — migration 129 is what granted this one).
"""

import asyncio
import datetime
import json
import sys

sys.path.insert(0, "/app/backend")

from app import activity_log                                  # noqa: E402
from app.agents import context_trim                           # noqa: E402
from app.tools.builtin import (                               # noqa: E402
    BUILTIN_TOOLS, _ACTION_ROWS_CAP, _list_recent_actions)

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _canned(rows, matched, **over):
    out = {"window": "24h", "matched": matched, "rows": rows,
           "counts": {"ok": matched}, "counts_complete": True,
           "capped_sources": [], "unreadable_sources": []}
    out.update(over)
    return out


def _row(i, reason=""):
    return {"id": f"tool:{i}",
            "at": datetime.datetime(2026, 8, 8, 12, 0, tzinfo=datetime.timezone.utc),
            "kind": "tool", "actor": "main", "title": f"do thing {i}",
            "outcome": "ok", "detail": "", "reason": reason or None}


async def _call(args, fetch_result=None, ceiling=None):
    """Run the executor with fetch and the context ceiling stubbed."""
    real_fetch, real_ceiling = activity_log.fetch, context_trim.ceiling_for
    try:
        if fetch_result is not None:
            async def fake(**kw):
                return fetch_result
            activity_log.fetch = fake
        if ceiling is not None:
            context_trim.ceiling_for = lambda model: ceiling
        return await _list_recent_actions(args, {"model": ""})
    finally:
        activity_log.fetch = real_fetch
        context_trim.ceiling_for = real_ceiling


def test_declaration():
    print("1. the declaration — read-only, choices derived")
    spec = BUILTIN_TOOLS["list_recent_actions"]
    check("declared reads_only — every query behind it is activity_log's, "
          "a read model with no write path", spec.get("reads_only") is True)
    props = spec["parameters"]["properties"]
    check("window choices ARE activity_log.WINDOWS — one list, no copy",
          props["window"]["enum"] == list(activity_log.WINDOWS),
          str(props["window"]["enum"]))
    check("kind choices ARE activity_log.SOURCES — a source added there "
          "appears here with no edit",
          props["kind"]["enum"] == sorted(activity_log.SOURCES),
          str(props["kind"]["enum"]))
    check("the tool asks fetch for no more than its own cap allows",
          _ACTION_ROWS_CAP <= activity_log.MAX_LIMIT,
          f"{_ACTION_ROWS_CAP} <= {activity_log.MAX_LIMIT}")


def test_capping_is_said():
    print("2. no silent truncation")
    # More matched than shown, nothing trimmed locally: the note must name
    # both numbers, because "3 rows" with no context reads as "3 actions".
    out = json.loads(asyncio.run(_call(
        {"window": "24h"}, _canned([_row(i) for i in range(3)], matched=999))))
    check("shown counts the rows on the page", out["shown"] == 3)
    check("matched is fetch's whole-window total, not the page's",
          out["matched"] == 999)
    check("a CAPPED note appears whenever shown < matched",
          any("CAPPED" in n for n in out.get("notes", [])),
          str(out.get("notes")))

    # The context trim: 60 fat rows against a floor-sized budget. The cut
    # must stop at the floor, never below it — from 10 rows, `del rows[-10:]`
    # left an empty page that read as "nothing happened".
    fat = [_row(i, reason="x" * 300) for i in range(_ACTION_ROWS_CAP)]
    out = json.loads(asyncio.run(_call(
        {"window": "24h"}, _canned(fat, matched=_ACTION_ROWS_CAP), ceiling=500)))
    check("the trim fired", out["shown"] < _ACTION_ROWS_CAP, str(out["shown"]))
    check("...and stopped at the floor, not zero", out["shown"] >= 5,
          str(out["shown"]))
    check("the trimmed page says CAPPED too",
          any("CAPPED" in n for n in out.get("notes", [])))
    check("newest rows survive the cut (the question is about recent work)",
          out["rows"][0]["did"] == "do thing 0")

    # A page that IS the whole answer carries no note at all.
    out = json.loads(asyncio.run(_call(
        {"window": "24h"}, _canned([_row(1)], matched=1))))
    check("a complete page carries no notes", "notes" not in out, str(out.get("notes")))


def test_missing_is_said():
    print("3. an unreadable source is MISSING, not empty")
    meta = {"id": "error:coding", "at": None, "kind": "meta",
            "actor": "activity-log", "title": "could not read", "outcome":
            "failed", "detail": "", "reason": "missing"}
    out = json.loads(asyncio.run(_call(
        {"window": "24h"},
        _canned([meta, _row(1)], matched=1, unreadable_sources=["coding"],
                counts_complete=False))))
    check("a meta notice is never presented as an action",
          all(r["kind"] != "meta" for r in out["rows"]))
    check("the unreadable source is named in a note",
          any("coding" in n and "MISSING" in n for n in out.get("notes", [])),
          str(out.get("notes")))
    check("uncountable -> the counts are called a FLOOR",
          any("FLOOR" in n for n in out.get("notes", [])))


def test_bad_input_refused():
    print("4. wrong input is refused with fetch's own words")
    # fetch validates the window before touching the database, so this needs
    # no pool — and the error names the accepted values, which is the whole
    # point of passing it through instead of restating a list here.
    out = asyncio.run(_call({"window": "2h"}))
    check("a bad window is an Error naming the accepted windows",
          out.startswith("Error:") and "1h" in out and "unknown window" in out,
          out[:90])


async def _live():
    from app import db, settings_store
    from app.agents import registry as agent_registry
    from app.tools import registry as tool_registry
    await db.init_pool()
    await settings_store.warm()
    try:
        agents = {a["name"]: a for a in
                  await agent_registry.list_agents(enabled_only=False)}
        granted = {tool_registry.canonical_name(t["function"]["name"])
                   for t in await tool_registry.get_agent_tools(agents["main"])}
        check("main HOLDS the tool (migration 129) — it is not a capability "
              "until an agent does", "list_recent_actions" in granted)
        out = await tool_registry.execute_tool(
            "list_recent_actions", {"window": "24h"},
            {"granted": granted, "agent_name": "main",
             "conversation_id": None, "dispatch_depth": 0,
             "model": agents["main"].get("model")})
        data = json.loads(out)
        check("the live call answers with the honest arithmetic",
              {"window", "matched", "shown", "counts", "rows"} <= set(data),
              str(sorted(data)))
        check("shown is the rows on the page", data["shown"] == len(data["rows"]))
        check("shown never exceeds matched", data["shown"] <= data["matched"],
              f"{data['shown']} vs {data['matched']}")
        check("every row is action-shaped",
              all({"at", "kind", "actor", "outcome", "did"} <= set(r)
                  for r in data["rows"]))
        # fetch validates kinds only after it has read the clock, so this
        # refusal needs the pool — which is why it lives here and not in §4.
        out = await _call({"window": "24h", "kind": "nope"})
        check("a bad kind is an Error naming the sources",
              out.startswith("Error:") and "unknown activity source" in out,
              out[:90])
    finally:
        await db.close_pool()


def main() -> int:
    test_declaration()
    test_capping_is_said()
    test_missing_is_said()
    test_bad_input_refused()
    print("5. live — through execute_tool with main's real grants")
    asyncio.run(_live())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
