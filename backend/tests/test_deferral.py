"""Deferral detector — she offered to look instead of looking.

    docker compose exec backend python tests/test_deferral.py

The incident, 2026-08-05 14:09, turn 9991f720-9f1c-43ac-bd35-98810dffc77f.
Jeremy asked "Is ossinsight usable now. And what is it". Nova answered from
knowledge and closed with "I can check whether it's reachable from my side.
Want me to try?" — holding fetch_url and web_search, past every gate. Three
spans, ONE llm_call, tool_calls_requested: 0. He had to say "yes" and wait a
second turn for an answer the first turn could have given.

Fifth member of the guard family and the only one whose consequence is a
FORCED ROUND, so the trade is different from narration's: a wrong fire here
does not accuse her of anything, it discards a good answer and spends a
round. Still expensive, so PRECISION IS STILL THE DESIGN — but the thing
being protected is her willingness to ask before she WRITES, which this must
never touch.

Layers, in order of what would hurt most if it broke:

  1. MUST FIRE — the incident verbatim, plus the retrieval offers around it.
     §1.1 is the whole reason the unit is a tail WINDOW and not a clause:
     "Want me to try?" and the verb it refers to are different sentences, and
     every clause-scoped detector written for this failed on it.
  2. MUST NOT FIRE — every offer that precedes a write, a deletion, a
     schedule or a notification. These are correct behaviour and firing at
     them would train her out of asking at all.
  3. DERIVED, not listed — a read-only MCP server widens the set with no edit
     to any module; a non-read-only one never does.
  4. THE INVARIANTS — `reads_only` cross-checked against three independently
     maintained sets, so the day someone mislabels a tool this suite fails
     instead of the fence.
  5. END TO END — the real runner, a scripted model, and the retract event
     the browser needs to unwind a draft it already drew.
"""

import asyncio
import json
import sys
import tempfile

sys.path.insert(0, "/app/backend")

from app import deferral, narration, settings_store, trace   # noqa: E402
from app.agents import runner                                # noqa: E402
from app.llm import router as llm_router                     # noqa: E402
from app.memory import memory as memory_mod                  # noqa: E402
from app.tools import fixtures, scopes                       # noqa: E402
from app.tools import registry as tool_registry              # noqa: E402
from app.tools.builtin import BUILTIN_TOOLS                  # noqa: E402

FAILURES: list[str] = []
SCRATCH_MEM = tempfile.mkdtemp(prefix="nova-deferral-")

AGENT = {"id": "a1", "name": "main", "model": "openrouter:test",
         "system_prompt": "You coordinate.", "allowed_tools": None}

# The live shape: name -> its name tokens, exactly what unattended_tools
# returns. Synthetic here so the vocabulary layer is testable without a DB.
UNATTENDED = {
    "fetch_url": {"fetch", "url"},
    "web_search": {"web", "search"},
    "diagnose": {"diagnose"},
    "search_memory": {"search", "memory"},
    "service_status": {"service", "status"},
    "list_models": {"list", "models"},
}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def fires(text, unattended=None, already=()):
    """(window, covered) for a zero-tool-call round."""
    window = deferral.offer(text, 0)
    if not window:
        return None, []
    return window, deferral.satisfied(
        window, UNATTENDED if unattended is None else unattended,
        already_called=already)


# ── 1. must fire: offers to look at something she was free to look at ─────

INCIDENT = ('As for "usable now" — if you mean the public site at '
            "ossinsight.io, I can check whether it's reachable from my side. "
            "Want me to try?")

MUST_FIRE = [
    # §1.1 THE INCIDENT, VERBATIM. The offer marker is in the last clause and
    # the retrieval verb is two clauses earlier; `ossinsight.io` is itself
    # split on the dot. Any detector scoped to a single clause returns None
    # here — measured, and it is why _WINDOW exists.
    (INCIDENT, "fetch_url"),
    ("Want me to search the web for what OSS Insight is?", "web_search"),
    ("Shall I check my notes for what you told me about your GPU?",
     "search_memory"),
    ("I could run diagnose to see what's failing — want me to?", "diagnose"),
    ("Would you like me to check if searxng is up?", "service_status"),
    ("I don't know offhand whether that page still exists. "
     "Let me know if you want me to look it up.", "fetch_url"),
]

# ── 2. must NOT fire: asking before doing something that is not a read ────

MUST_NOT_FIRE = [
    # every one of these precedes a decision only Jeremy can make
    "Want me to delete those three memory items?",
    "Shall I create an automation to poll that nightly?",
    "Want me to schedule that poll nightly?",
    "Want me to save that to memory?",
    "Want me to check with Jeremy before I change the rule?",
    "Want me to notify you when it finishes?",
    "Should I register that MCP server for you?",
    # the uncommitted ingest-dismissal lane depends on her NOT re-offering
    # dismissed work; the mutation veto is what keeps this out
    "Those three ingests are ones you dismissed. Let me know if you want "
    "them re-queued.",
    # no retrieval verb at all — an offer to summarise what she already has
    "I found 3 candidates — want me to summarise them?",
    # KNOWN MISS, PINNED DELIBERATELY. `schedul\w*` has to stay in the
    # mutation veto or "Want me to schedule that nightly?" (two lines up)
    # fires at manage_automations, which IS in the unattended set via
    # scopes.READ_ACTIONS. Catching this one costs that one. Precision over
    # recall — do not "fix" this without reading _SATISFIERS' comment.
    "Want me to check what's scheduled?",
    # THE SECOND KNOWN MISS, same shape and pinned for the same reason.
    # `install\w*` has to stay in the veto or "want me to search for and
    # install that MCP server?" matches the docs/search row and she is told
    # nothing was stopping her, against an offer whose object is a write. The
    # cost is the most natural phrasing for list_models. The satisfier row that
    # tried to catch it (`installed\s+model`) was unreachable text and has been
    # removed — the veto runs over the whole window before any satisfier is
    # consulted, so it could never have fired.
    "I can check which models are installed. Want me to look?",
    # an offer whose subject nothing in the toolset serves: fails CLOSED
    "I could look at your Gmail for the receipt — want me to?",
    "Would you like me to keep watching that job and tell you when it "
    "finishes?",
]


def test_vocabulary():
    print("1. must fire — a retrieval offer she was already cleared to make")
    for text, expect in MUST_FIRE:
        window, covered = fires(text)
        check(f"fires: {text[:58]!r}", bool(window) and expect in covered,
              f"window={bool(window)} covered={covered}")

    print("2. must NOT fire — asking first about anything that is not a read")
    for text in MUST_NOT_FIRE:
        window, covered = fires(text)
        check(f"silent: {text[:58]!r}", not covered,
              f"window={window!r} covered={covered}")


def test_gate():
    print("3. the gates — a round that called a tool is never a deferral")
    check("a tool call this round suppresses it",
          deferral.offer(INCIDENT, 1) is None)
    check("empty text is not an offer", deferral.offer("", 0) is None)

    # 12c5511 Failure A in this module's shape: an offer to do MORE, after
    # she already did the thing, is not an offer INSTEAD OF.
    more = ("I checked the site — it's up, 200 in 240 ms. "
            "Want me to pull the star history too?")
    _w, covered = fires(more, already=["fetch_url", "web_search"])
    check("a tool already called this turn cannot satisfy the offer",
          covered == [], str(covered))

    # the offer must END the round; one answered mid-reply does not count
    buried = ("Want me to check? I did — it is up. "
              "The last release was in March. That is everything.")
    check("an offer buried above the tail is not a deferral",
          deferral.offer(buried, 0) is None, repr(deferral.offer(buried, 0)))

    # fails closed on an empty toolset, whatever the text says
    check("no unattended tools means no fire",
          deferral.satisfied(INCIDENT, {}) == [])


def test_derived():
    print("4. derived, not listed — the set is read from live state")
    # A read-only MCP server widens it with NO edit to deferral.py. The name
    # is the REAL one registered on this box (context7, read_only=t) rather
    # than a synthetic stand-in — a made-up name would have let the token set
    # pass while the only documentation tool she actually holds stayed
    # unreachable, which is exactly what happened on the first run.
    docs_tool = "mcp:context7/query-docs"
    widened = dict(UNATTENDED)
    widened[docs_tool] = set(narration._TOKEN_SPLIT.findall(docs_tool.lower()))
    _w, covered = fires("Want me to look up that page in the docs?", widened)
    check("a read-only MCP tool satisfies a docs offer with no module edit",
          docs_tool in covered, str(covered))

    # `memory` is deliberately not a recall token — narration.py:107-110
    _w, covered = fires("Shall I check my notes for that?",
                        {"write_memory": {"write", "memory"}})
    check("write_memory can never satisfy a recall offer", covered == [],
          str(covered))

    # reads_only is a DECLARATION beside the tool: absent means no
    check("an undeclared builtin is not read-only",
          not tool_registry.reads_only("write_memory"))
    check("a declared one is", tool_registry.reads_only("fetch_url"))
    check("an unknown name is not", not tool_registry.reads_only("no_such_tool"))

    # arg-aware: the goal-scoped verbs enter only through their read actions
    check("manage_automations{list} reads",
          tool_registry.reads_only("manage_automations", {"action": "list"}))
    check("manage_automations{create} does not",
          not tool_registry.reads_only("manage_automations",
                                       {"action": "create"}))
    for verb in ("pull_model", "deploy_workload", "delegate_coding_task"):
        check(f"{verb} never reads", not tool_registry.reads_only(verb))

    # an MCP tool on a server not marked read-only stays out
    check("an MCP tool on an unlisted server is not read-only",
          not tool_registry.reads_only("mcp:whatever/thing", None, None, set()))


def test_invariants():
    print("5. invariants — three independently maintained sets must agree")
    ro = {n for n, s in BUILTIN_TOOLS.items() if s.get("reads_only")}
    check("nothing read-only is refused outright in an eval replay",
          not (ro & fixtures.NEVER_EXECUTE), str(ro & fixtures.NEVER_EXECUTE))
    check("nothing read-only creates capability (ACTOR_TOOLS)",
          not (ro & tool_registry.ACTOR_TOOLS),
          str(ro & tool_registry.ACTOR_TOOLS))
    check("nothing read-only sits behind a goal",
          not (ro & scopes.GOAL_SCOPED_TOOLS),
          str(ro & scopes.GOAL_SCOPED_TOOLS))
    # PINS THE DELIBERATE OVERLAP. web_search/fetch_url/get_weather read the
    # world and taint the turn. A read that taints is still a read; if this
    # ever becomes empty somebody has "fixed" the wrong side.
    check("reads that taint the turn stay reads",
          bool(ro & tool_registry._UNTRUSTED_SOURCE_TOOLS),
          str(sorted(ro & tool_registry._UNTRUSTED_SOURCE_TOOLS)))
    # 21, not 22. `check_coding_session` shipped with the flag and had to lose
    # it: called with a session_id it runs `coder.refresh`, which persists a
    # TERMINAL state='failed' on a broker 404. A bare count is a mystery
    # constant, so the reason lives here — if this number moves, someone
    # declared a tool read-only and owes the same trace.
    check("the declared read-only set is the expected size",
          len(ro) == 21, str(len(ro)))
    check("check_coding_session is not in it — it writes a session state",
          "check_coding_session" not in ro)


def test_narration_compat():
    print("6. narration is untouched — four suites stub its signature")
    check("detect still takes (text, calls, called_tools, round_text)",
          narration.detect("hello", 0, [], "hello") is None)
    # the shared definitions
    check("clauses() is the same splitter",
          list(narration.clauses("A. B?")) == list(narration._clauses("A. B?")))
    check("is_offer() is the same marker set",
          narration.is_offer("Want me to try?")
          and not narration.is_offer("I'll dispatch that."))
    # AND the exemption it was built for still holds: narration must stay
    # silent on an offer, whatever deferral does with it.
    check("narration still exempts a permission request",
          narration.detect("Want me to create that note?", 0) is None)


# ── 7. end to end: the real runner, and the retract the browser needs ─────

class Script:
    """Round 1 offers instead of acting; round 2 calls the tool."""

    def __init__(self, first, then_call=True):
        self.first = first
        self.then_call = then_call
        self.calls = 0

    def stream_chat(self, *a, **kw):
        self.calls += 1
        n = self.calls
        first, then_call = self.first, self.then_call

        async def gen():
            if n == 1:
                for token in first.split(" "):
                    yield {"type": "text", "text": token + " "}
            elif n == 2 and then_call:
                yield {"type": "tool_calls", "tool_calls": [
                    {"id": "f0", "name": "fetch_url",
                     "arguments": json.dumps({"url": "https://ossinsight.io"})}]}
            elif n == 2:
                # offers a second time — the retry budget is spent, turn ends
                for token in first.split(" "):
                    yield {"type": "text", "text": token + " "}
            else:
                for token in ["It", "is", "up", "-", "200", "in", "240ms."]:
                    yield {"type": "text", "text": token + " "}
        return gen()


def install(script):
    llm_router.stream_chat = script.stream_chat
    llm_router.effective_model = lambda m: m
    settings_store._cache["agents.tool_concurrency"] = 1
    settings_store._cache["agents.max_dispatches_per_turn"] = 3
    # NOT set here: §8 turns it off and then calls run_turn, so forcing it on
    # inside install() would make the off-switch test pass against a switch
    # that was never off.
    settings_store._cache.setdefault("autonomy.act_on_reads", True)
    trace._flush = lambda t: asyncio.sleep(0)

    async def get_agent_tools(agent, exclude=None):
        return [{"type": "function", "function": {
            "name": "fetch_url", "description": "d", "parameters": {}}}]

    tool_registry.get_agent_tools = get_agent_tools

    # The derivation is exercised for real in §4; here it is pinned so the
    # end-to-end asserts the WIRING, not the database.
    async def unattended(ctx):
        return {"fetch_url": {"fetch", "url"}}

    tool_registry.unattended_tools = unattended

    async def ran(name, args, ctx):
        return "200 OK. OSSInsight is reachable."

    tool_registry.execute_tool = ran

    async def _empty(*a, **kw):
        return ""

    runner._platform_block = _empty
    runner._entities_block = _empty
    runner._mcp_index_block = _empty


async def run_turn(script):
    install(script)
    events = []
    with memory_mod.sandbox(memory_mod.OkfMemory(base_dir=SCRATCH_MEM)):
        async with trace.turn("test"):
            async for ev in runner.run_agent(
                    AGENT, [{"role": "user", "content": "is ossinsight usable"}]):
                events.append(ev)
    return events


def retries(events):
    return [e for e in events if e.get("type") == "activity"
            and e.get("kind") == "deferral_retry"]


def final_text(events):
    finals = [e for e in events if e.get("type") == "final"]
    return finals[-1]["text"] if finals else ""


async def test_end_to_end():
    print("7. end to end — the forced round leaves the real runner")
    events = await run_turn(Script(INCIDENT))
    hits = retries(events)
    check("the incident forces exactly one retry", len(hits) == 1,
          f"{len(hits)} retries")
    if hits:
        check("it carries a retract count for the client to unwind",
              hits[0].get("retract", 0) > 0, str(hits[0].get("retract")))
        check("…and names the tool that needed no approval",
              "fetch_url" in hits[0].get("detail", ""), hits[0].get("detail"))
    text = final_text(events)
    check("the answer is round 2's, not two drafts joined",
          "240ms" in text and "Want me to try" not in text, repr(text[-90:]))
    # the doubling regression 12c5511 fixed for narration, pinned here too
    check("the retracted draft appears nowhere in the final text",
          text.count("usable now") == 0, repr(text[:90]))

    print("   …and a clean answer is left alone")
    events = await run_turn(Script("OSSInsight is a GitHub analytics site.",
                                   then_call=False))
    check("an ordinary answer forces nothing", retries(events) == [],
          str(retries(events)))

    print("   …and the budget is one retry, not a loop")
    events = await run_turn(Script(INCIDENT, then_call=False))
    check("offering twice still ends the turn", len(retries(events)) == 1,
          f"{len(retries(events))} retries")


async def test_setting_is_the_off_switch():
    print("8. the operator's switch actually switches it off")
    settings_store._cache["autonomy.act_on_reads"] = False
    try:
        events = await run_turn(Script(INCIDENT))
        check("off means the old two-step behaviour returns",
              retries(events) == [], str(retries(events)))
    finally:
        settings_store._cache["autonomy.act_on_reads"] = True


def main() -> int:
    test_vocabulary()
    test_gate()
    test_derived()
    test_invariants()
    test_narration_compat()
    asyncio.run(test_end_to_end())
    asyncio.run(test_setting_is_the_off_switch())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:6]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
