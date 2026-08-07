"""The heartbeat's quiet contract is code, and this is the code that pins it.

    docker compose exec backend python tests/test_heartbeat.py

The feature's whole promise is "quiet unless something needs attention,
and never silent when it does" (docs/plans/heartbeat.md). Both halves are
enforced in app/heartbeat.py rather than requested of the model, so both
halves are testable without a model: verdict() decides suppress-vs-deliver
on the reply text, and beat() owns delivery — including the rule that a
report NOBODY received is a FAILED run, not a green one with a sad log
line. That last case is this repo's signature defect shape, tested here on
purpose.
"""

import asyncio
import sys
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, "/app/backend")
sys.path.insert(0, ".")

from app import heartbeat  # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


print("1. verdict(): the quiet contract on reply text")
o, t = heartbeat.verdict("HEARTBEAT_OK")
check("the bare token is quiet", o == "quiet", f"{o}/{t}")
o, t = heartbeat.verdict("  HEARTBEAT_OK  \n")
check("...whitespace does not defeat it", o == "quiet")
o, t = heartbeat.verdict("")
check("an empty reply is quiet, never a push of nothing", o == "quiet")
o, t = heartbeat.verdict("The backup drill failed twice overnight.")
check("a real report is delivered", o == "notify", o)
check("...verbatim", t == "The backup drill failed twice overnight.")
long_report = ("Backups: the last three attempts failed with the same "
               "refusal, and the newest verified bundle is nine days old. "
               "Inbox: the 1Password card has been sitting unopened since "
               "Tuesday. Ingestion: the durable queue has 14 jobs parked "
               "as orphans after repeated interruptions, and the follow "
               "sources have not produced a fresh item in six days. "
               "HEARTBEAT_OK")
assert len(long_report) >= heartbeat.QUIET_MAX_CHARS, "fixture must sit over the line"
o, t = heartbeat.verdict(long_report)
check("a real report wearing the token is DELIVERED, not suppressed",
      o == "notify", o)
check("...with the token stripped", "HEARTBEAT_OK" not in t)
check("...and the report intact", t.startswith("Backups: the last three"))
o, t = heartbeat.verdict("HEARTBEAT_OK — all fine, nothing to report today.")
check("token + short pleasantries is still quiet (under the line)",
      o == "quiet", f"{o}")

print("2. within_active_hours(): the window, including overnight")
def at(hh, mm):
    return datetime(2026, 8, 7, hh, mm)
check("inside a day window", heartbeat.within_active_hours(at(12, 0), "08:00-22:00"))
check("before it", not heartbeat.within_active_hours(at(7, 59), "08:00-22:00"))
check("at the closing minute (exclusive)",
      not heartbeat.within_active_hours(at(22, 0), "08:00-22:00"))
check("overnight window, late side",
      heartbeat.within_active_hours(at(23, 30), "22:00-06:00"))
check("overnight window, early side",
      heartbeat.within_active_hours(at(5, 59), "22:00-06:00"))
check("overnight window, daytime excluded",
      not heartbeat.within_active_hours(at(12, 0), "22:00-06:00"))
check("empty spec is always active", heartbeat.within_active_hours(at(3, 0), ""))
check("garbage spec is always active, never silently off",
      heartbeat.within_active_hours(at(3, 0), "whenever"))

print("3. read_checklist(): seeds once, then reads what the operator wrote")
with tempfile.TemporaryDirectory() as td:
    tmp = Path(td) / "heartbeat.md"
    orig = heartbeat.checklist_path
    heartbeat.checklist_path = lambda: tmp
    try:
        first = heartbeat.read_checklist()
        check("first read seeds the starter", "Backups:" in first)
        check("...onto disk", tmp.exists())
        tmp.write_text("- only watch the oven\n")
        check("edits win over the seed",
              heartbeat.read_checklist() == "- only watch the oven\n")
    finally:
        heartbeat.checklist_path = orig

print("4. beat(): delivery is code, and undelivered is FAILED")


class _Turn:
    def set_error(self, *_): ...
    async def __aenter__(self):
        return self
    async def __aexit__(self, *_):
        return False


def _stub_beat_env(reply, *, push_ok=True, card_raises=False, hours="",
                   calls=None):
    """Wire beat()'s collaborators to stubs, recording what got called."""
    calls = calls if calls is not None else {}

    async def get_agent(name):
        return {"name": "main", "enabled": True, "model": "ollama:qwen3:8b"}

    async def run_agent(agent, messages, **kw):
        calls.setdefault("ran", []).append(messages[0]["content"])
        yield {"type": "final", "text": reply}

    async def send(message, **kw):
        calls.setdefault("notify", []).append(message)
        return {"ok": True} if push_ok else {"ok": False, "error": "no provider"}

    async def create(kind, title, body, **kw):
        if card_raises:
            raise ValueError("rate limit")
        calls.setdefault("cards", []).append((kind, body, kw.get("dedupe_key")))
        return {"id": "x"}

    heartbeat.agent_registry.get_agent_by_name = get_agent
    heartbeat.agent_runner.run_agent = run_agent
    heartbeat.notify.send = send
    heartbeat.recommendations.create = create
    heartbeat.trace.turn = lambda *a, **k: _Turn()
    sget = heartbeat.settings_store.get
    heartbeat.settings_store.get = lambda key: (
        hours if key == "heartbeat.active_hours"
        else "UTC" if key == "nova.timezone"
        else "" if key == "heartbeat.model" else sget(key))
    return calls


_orig = (heartbeat.agent_registry.get_agent_by_name,
         heartbeat.agent_runner.run_agent, heartbeat.notify.send,
         heartbeat.recommendations.create, heartbeat.trace.turn,
         heartbeat.settings_store.get)
_orig_read = heartbeat.read_checklist
heartbeat.read_checklist = lambda: "- watch the oven\n"
try:
    row = {"name": "heartbeat"}

    calls = _stub_beat_env("HEARTBEAT_OK")
    ok, summary = asyncio.run(heartbeat.beat(row))
    check("a quiet beat is an ok run that says quiet",
          ok and summary.startswith("quiet"), summary)
    check("...and delivered NOTHING", not calls.get("notify") and not calls.get("cards"))
    check("...but did actually run the agent", len(calls.get("ran", [])) == 1)
    check("...with the checklist in the prompt",
          "watch the oven" in calls["ran"][0])

    calls = _stub_beat_env("The drill failed and nobody was told.")
    ok, summary = asyncio.run(heartbeat.beat(row))
    check("a report beat delivers both channels",
          ok and calls.get("notify") and calls.get("cards"), summary)
    check("...the push carries the report text",
          calls["notify"][0].startswith("The drill failed"))
    check("...the card dedupe key is derived from the text",
          calls["cards"][0][2].startswith("heartbeat:"))
    check("...and the summary says notified", summary.startswith("notified"), summary)

    calls = _stub_beat_env("Something is wrong.", push_ok=False, card_raises=True)
    ok, summary = asyncio.run(heartbeat.beat(row))
    check("BOTH channels failing is a FAILED run, not quiet success",
          not ok, f"ok={ok} {summary}")

    calls = _stub_beat_env("Something is wrong.", push_ok=False)
    ok, summary = asyncio.run(heartbeat.beat(row))
    check("one surviving channel still counts as delivered",
          ok and "card" in summary, summary)

    # a one-minute window twelve hours from now — outside no matter when
    # this suite runs, without patching the clock
    far = (datetime.utcnow().hour + 12) % 24
    calls = _stub_beat_env("irrelevant", hours=f"{far:02d}:00-{far:02d}:01")
    ok, summary = asyncio.run(heartbeat.beat(row))
    check("outside active hours: quiet WITHOUT running the agent",
          ok and "active hours" in summary and not calls.get("ran"), summary)
finally:
    (heartbeat.agent_registry.get_agent_by_name,
     heartbeat.agent_runner.run_agent, heartbeat.notify.send,
     heartbeat.recommendations.create, heartbeat.trace.turn,
     heartbeat.settings_store.get) = _orig
    heartbeat.read_checklist = _orig_read

print("5. the scheduler actually knows the handler")
from app import scheduler  # noqa: E402
check("'heartbeat' is registered in MECHANICAL_HANDLERS",
      "heartbeat" in scheduler.MECHANICAL_HANDLERS)

print(f"\n{'all checks passed' if not FAILURES else 'FAILED (%d): %s' % (len(FAILURES), '; '.join(FAILURES))}")
sys.exit(1 if FAILURES else 0)
