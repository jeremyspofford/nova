"""The replayed record of what ran in each past turn.

    docker compose exec backend python tests/test_tool_activity_notes.py

Self-contained, no DB and no network — every case feeds
`tool_activity_notes` / `to_llm_history` the row shapes `load_tool_activity`
produces.

This path had NO tests, which is how it came to tell her a refused call had
succeeded. It exists because she said "let me dig deeper" four times after
list_egress had already returned: without a mechanical record of her own
tool history she invents one. So a note that is WRONG is worse than no note
at all — it is invented history with the authority of a machine record.
"""

import sys

sys.path.insert(0, "/app/backend")

from app import conversations                               # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def user(at, text="q", trace=None):
    return {"role": "user", "content": text, "created_at": at,
            "metadata": {"trace_id": trace} if trace else {}}


def assistant(at, text="a", trace=None):
    return {"role": "assistant", "content": text, "created_at": at,
            "metadata": {"trace_id": trace} if trace else {}}


def act(at, name, kind, content, trace=None):
    return {"name": name, "kind": kind, "content": content,
            "created_at": at, "trace_id": trace}


print("1. an outcome comes from a RESULT, never from a call")
# The regression: a tool_start's content is the ARGUMENTS. `{"action":"list"}`
# does not begin with "error", so _outcome scored it ok — and every refused
# call was reported as both ok AND error, in the same line.
hist = [user("2026-08-04 23:02:44"), assistant("2026-08-04 23:03:41")]
activity = [
    act("2026-08-04 23:02:50", "manage_tools", "tool_start", '{"action": "list"}'),
    act("2026-08-04 23:02:51", "manage_tools", "tool_result",
        "Error: 'manage_tools' changes what this system can do"),
]
note = conversations.tool_activity_notes(hist, activity)["2026-08-04 23:02:44"]
check("a refused call reports error and ONLY error",
      "manage_tools -> error" in note and "manage_tools -> ok" not in note, note)

print("2. a call with no result says so, rather than inventing a verdict")
activity = [act("2026-08-04 23:02:50", "web_search", "tool_start", '{"q": "x"}')]
note = conversations.tool_activity_notes(hist, activity)["2026-08-04 23:02:44"]
check("started with nothing back is neither ok nor error",
      "started, no result recorded" in note, note)
check("...and is not scored ok", "web_search -> ok" not in note, note)

print("3. a successful call is reported once")
activity = [
    act("2026-08-04 23:02:50", "web_search", "tool_start", '{"q": "x"}'),
    act("2026-08-04 23:02:51", "web_search", "tool_result", "Search results for: x"),
]
note = conversations.tool_activity_notes(hist, activity)["2026-08-04 23:02:44"]
check("one entry, not two", note.count("web_search") == 1, note)
check("and it is ok", "web_search -> ok" in note, note)

print("4. rows are filed by TRACE when they carry one")
# The live misfiling: 18 tool rows from a 57s turn were attributed to the
# "Say ACK" turn that overtook it, because bucketing was a guess from clocks.
hist = [user("23:02:44", "configure it"), user("23:02:48", "Say ACK"),
        assistant("23:02:52", "ACK", trace="T-ack"),
        assistant("23:03:41", "I can't", trace="T-long")]
activity = [act("23:02:53", "web_search", "tool_result", "results", trace="T-long"),
            act("23:03:20", "manage_tools", "tool_result", "Error: refused", trace="T-long")]
notes = conversations.tool_activity_notes(hist, activity)
check("the note is keyed by the trace, not by the nearer question",
      "T-long" in notes and "23:02:48" not in notes, str(list(notes)))
replayed = conversations.to_llm_history(hist, activity)
ack = next(m for m in replayed if m["content"].startswith("ACK"))
long = next(m for m in replayed if m["content"].startswith("I can't"))
check("the short turn is NOT told it ran those tools",
      "web_search" not in ack["content"], ack["content"][:60])
check("the long turn IS", "web_search -> ok" in long["content"], long["content"][:80])

print("5. rows with no trace still file by timestamp (history cannot be restamped)")
hist = [user("23:02:44"), assistant("23:03:41")]
activity = [act("23:02:53", "web_search", "tool_result", "results")]
replayed = conversations.to_llm_history(hist, activity)
check("the legacy path still attaches",
      "web_search -> ok" in replayed[1]["content"], replayed[1]["content"][:60])

print("6. a guard violation is never replayed as a tool that ran")
# `capability` rows are written under name='main' with a violation as their
# content, so they scored `main -> ok`: the finding that she claimed
# something false, handed back as evidence for it.
import inspect                                              # noqa: E402
src = inspect.getsource(conversations.load_tool_activity)
check("'capability' is not in the replay filter", "'capability'" not in src.split("AND tool_calls")[1].split("AND created_at")[0])
check("'narration' is not either", "narration'" not in src.split("AND tool_calls")[1].split("AND created_at")[0])

print("7. the row cap keeps the NEWEST activity")
check("ORDER BY is DESC inside the subquery, re-sorted ASC outside",
      "created_at DESC" in src and "recent ORDER BY created_at ASC" in src)

print(f"\n{'all checks passed' if not FAILURES else 'FAILED (%d): %s' % (len(FAILURES), '; '.join(FAILURES))}")
sys.exit(1 if FAILURES else 0)
