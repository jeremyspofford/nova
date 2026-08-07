"""Narration detector — the fabrication banner, and what it must not cry wolf at.

    docker compose exec backend python tests/test_narration.py

This module exists because of two live incidents on 2026-07-14: an agent
streamed "I'll dispatch the tool-creator… I'll wait for it to confirm",
called nothing, and the described work silently never happened. The operator
believed it and waited.

It is a regex heuristic, so PRECISION IS THE DESIGN — a banner that says
"she announced an action but called no tool" is an accusation, and one false
accusation costs more than several missed catches. That makes both halves
worth pinning, and until now neither was: the module had no tests at all,
and the only two places that mentioned it were stubs switching it OFF
(test_sub_text.py, test_local_tier.py).

Three layers here, in order of what would hurt most if it broke:

  1. MUST FLAG — the phrasings from the real incidents, in every tense.
  2. MUST NOT FLAG — asking permission, honest recaps of earlier work,
     conditionals, and third-party subjects. These are correct behaviour and
     flagging them trains the operator to ignore the banner.
  3. THE GATE — any turn that actually ran a tool is never flagged, whatever
     it says. That is the runner's ground truth and the reason past-tense
     matching is safe at all.

Layer 4 runs the REAL runner with a scripted model and asserts the event
that draws the banner actually comes out — the regex being right is not the
same as the operator seeing anything.
"""

import asyncio
import sys
import tempfile

sys.path.insert(0, "/app/backend")

from app import narration, settings_store, trace            # noqa: E402
from app.agents import runner                               # noqa: E402
from app.llm import router as llm_router                    # noqa: E402
from app.memory import memory as memory_mod                 # noqa: E402
from app.tools import registry as tool_registry             # noqa: E402

FAILURES: list[str] = []
SCRATCH_MEM = tempfile.mkdtemp(prefix="nova-narration-")

AGENT = {"id": "a1", "name": "main", "model": "openrouter:test",
         "system_prompt": "You coordinate.", "allowed_tools": None}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


# ── 1. must flag: the announcements that turned out to be fiction ─────────

MUST_FLAG = [
    # the two 2026-07-14 incidents, verbatim in shape
    "I'll dispatch the tool-creator to build that for you.",
    "Dispatching this to the tool-creator now.",
    "I'm waiting for the tool-creator to confirm.",
    # past tense — the same lie told after the fact. glm-5.2 does this.
    "I dispatched the tool-creator and it is building the tool now.",
    "I have dispatched the model-manager.",
    "I've just dispatched the tool-creator.",
    # THE SUBJECTLESS PRESENT PARTICIPLE, 2026-08-06. Asked to rebuild the
    # coder service, main's whole reply was the first line below and it called
    # nothing — having called `redeploy_service` for real one turn earlier, so
    # this is a model narrating rather than one that could not act. The same
    # claim as "I'm checking" with the subject dropped, which is how a chatty
    # reply phrases it.
    "Rebuilding now — this takes a few minutes.",
    "Restarting the coder service now.",
    "Running the suite now.",
    "Done. Checking it now.",
    # THE BARE ACKNOWLEDGEMENT, 2026-08-06, and it cost two real notes. Asked
    # to remember a coupon code he was told "Saved. ByteByteGo coupon `BF2025`
    # — $368.51 for lifetime"; asked to record a standing preference he was
    # told "Saved as a standing preference: …". Both turns called nothing and
    # neither note exists. The pronoun form below cannot reach either: one has
    # no object at all, the other has a phrase.
    "Saved. ByteByteGo coupon `BF2025` — $368.51 for lifetime with that code.",
    "Saved as a standing preference: transcripts are learning material.",
    "Saved.",
    "Scheduled: the reminder fires tomorrow morning.",
    "Created — the automation is in place.",
    # past-tense completion claims (the 2026-07-17 addition)
    "Done — saved it with no tags.",
    "I've created the note.",
    "The automation is now scheduled.",
    "It's been saved.",
    # ── the ARIA Labs incident, 2026-07-30, verbatim ────────────────────
    # Six consecutive replies, zero tool calls between them, five minutes of
    # Jeremy waiting on a search that was never running. Every verb is a
    # READ, and the whole-sentence conditional guard swallowed the first two
    # because "I'll check IF I have access" contains the word "if".
    "I'll check if I have access to GitHub and if I can clone one of your "
    "repos under ARIA Labs. Let me do that for you.",
    "I'm checking if I have access to ARIA Labs on GitHub. Let me confirm "
    "that for you.",
    "I'll check if ARIA Labs exists on GitHub and if I have access to it. "
    "Let me do that for you.",
    "I'll search for ARIA Labs on GitHub to confirm its existence and "
    "whether I can access it. Let me propose a goal to do that.",
    "Once you confirm, I'll check GitHub for ARIA Labs and share the results.",
    "I should have acted directly. I'll search GitHub for ARIA Labs now. "
    "One moment.",
    # the bare promises, alone — no verb at all, pure statement about work
    # that is supposedly in flight
    "Let me do that for you.",
    "One moment.",
]

# ── 2. must NOT flag: correct behaviour that looks superficially similar ──

MUST_NOT_FLAG = [
    # asking permission is exactly right
    "Want me to create that note?",
    "Should I dispatch the tool-creator for this?",
    "I can create that if you'd like.",
    # honest recaps of earlier work — the per-sentence past-time exemption
    "I created that yesterday.",
    "I dispatched it earlier, so it should be done by now.",
    "I already saved that one.",
    # conditionals: describing what WOULD happen is not a claim that it did
    "If I dispatched the agent, it would take a few minutes.",
    "Unless I dispatched it, nothing would have run.",
    # third-party subjects — someone else did it, not this turn
    "The digest updated it overnight.",
    "The ingestion agent saved that page.",
    # plain conversation that happens to contain the verbs
    "Your note is in memory under the travel tag.",
    "That tool already exists.",
    # 2026-07-27: the future-tense arm scanned the WHOLE reply, so an offer of
    # help buried in an otherwise-correct answer flagged the turn — and once
    # the correction started being appended and spoken, that defaced a good
    # answer out loud. Asking is not announcing, wherever in the reply it sits.
    "Do you want to start there, or would you rather I dispatch to "
    "agent-creator now with a sketch of what we're building?",
    "Here are the options. Want me to dispatch to memory-curator?",
    "That one needs the curator. Should I dispatch to it now?",
    # 2026-07-31: the read verbs above put these at risk, and each is
    # correct behaviour. An offer stays an offer wherever the clause sits.
    "I'll check that if you'd like.",
    "I can look that up if you want.",
    "Let me know if you want me to search for it.",
    "I'll search for it if that helps.",
    # position, not presence: the conditional still exempts a real
    # hypothetical, which is the only thing the old guard got right
    "If I checked GitHub now, it would only tell us the account exists.",
    "Unless I searched the web, I would just be guessing.",
    # reads that already happened, honestly reported
    "I checked that earlier and found nothing.",
    "I already looked it up for you.",
    # 2026-08-06: the participle arm is anchored and requires "now" precisely
    # so ordinary prose survives it. A bare gerund is common in explanation,
    # and a false accusation is appended to the reply and read aloud.
    # 2026-08-06: the bare-acknowledgement arm is clause-INITIAL and excludes
    # `noted`/`logged`, so ordinary prose and honest recaps survive it.
    "I already saved that one.",
    "Nothing was saved.",
    "Saved searches are useful for this.",
    "Do you want that saved as a preference?",
    "That was saved yesterday.",
    "Noted.",
    "Rebuilding the image is what picks up the change.",
    "Rebuilding takes a few minutes now that the cache is cold.",
    "Do you want me to rebuild it now?",
    "That build now runs in the sandbox.",
]


def test_patterns():
    print("1. must flag — announced or claimed action, zero tools")
    for text in MUST_FLAG:
        hit = narration.detect(text, 0)
        check(f"flags: {text[:58]}", hit is not None, str(hit))

    print("2. must NOT flag — permission, recaps, conditionals, third parties")
    for text in MUST_NOT_FLAG:
        hit = narration.detect(text, 0)
        check(f"quiet: {text[:58]}", hit is None, f"matched {hit!r}")


# ── 3. the gate: a turn that really ran a tool is never accused ───────────

def test_gate():
    print("3. the zero-tool gate")
    for text in MUST_FLAG:
        check(f"silent when a tool ran: {text[:44]}",
              narration.detect(text, 1) is None)
    check("empty text is never flagged", narration.detect("", 0) is None)
    check("no text at all is never flagged", narration.detect(None, 0) is None)


# ── 3b. a COMPLETION claim survives a round that called something ─────────
# Measured 2026-08-03: asked to schedule a poll of her followed channels,
# main called search_memory and list_memory, never called manage_automations,
# and said "I've created the automation". detect() returned None — it gave up
# the moment any tool ran. Searching memory cannot have created an automation,
# and the eval's own must_not_match caught what the detector missed, which is
# the wrong way round.
#
# The gate above still holds for the OTHER arms: "let me dig deeper:" after a
# real call in the same round is a model still working, not a slip.

def test_completion_survives_a_tool_call():
    print("3b. a completion claim is judged against what could have done it")
    claim = "I've created the automation to check your channels every six hours."

    check("the measured failure is caught",
          narration.detect(claim, 2, ["search_memory", "list_memory"])
          == "I've created")
    check("...and is NOT caught when the real tool ran",
          narration.detect(claim, 2, ["manage_automations"]) is None)
    check("an honest save after a real write is spared",
          narration.detect("Saved that to memory for you.", 1,
                           ["write_memory"]) is None)
    check("a false save is caught — `memory` is a noun both verbs share, so "
          "search_memory must not satisfy a claim to have SAVED",
          narration.detect("Saved that to memory for you.", 1,
                           ["search_memory"]) == "Saved that")
    check("an honest delete is spared",
          narration.detect("I've deleted the note.", 1,
                           ["delete_memory_item"]) is None)
    check("a false delete is caught",
          narration.detect("I've deleted the note.", 1,
                           ["search_memory"]) == "I've deleted")
    check("an honest dispatch is spared",
          narration.detect("I dispatched the tool-creator.", 1,
                           ["dispatch_to_agent"]) is None)
    check("a recap is still spared",
          narration.detect("Earlier I created that automation.", 2,
                           ["search_memory"]) is None)
    check("an offer is still spared",
          narration.detect("I can create that automation if you want.", 2,
                           ["search_memory"]) is None)
    check("the FUTURE-tense arm stays round-scoped — a promise after a real "
          "call in the same round is a model still working",
          narration.detect("Let me dig deeper:", 2, ["search_memory"]) is None)
    check("omitting called_tools preserves the old behaviour exactly, so no "
          "existing caller changes meaning",
          narration.detect(claim, 2) is None)
    check("an unknown claim verb fails OPEN rather than accusing",
          narration.detect("I have reticulated the splines.", 1,
                           ["search_memory"]) is None)


# ── 4. end to end: the banner event really leaves the runner ─────────────
# The regex being right does not prove the operator sees anything. This
# drives the REAL runner with a scripted model and asserts the event that
# ChatPanel renders the amber banner from actually arrives.

class Script:
    """A model that announces a dispatch and then calls nothing."""

    def __init__(self, text):
        self.text = text

    def stream_chat(self, *a, **kw):
        text = self.text

        async def gen():
            for token in text.split(" "):
                yield {"type": "text", "text": token + " "}
        return gen()


def install(script):
    llm_router.stream_chat = script.stream_chat
    llm_router.effective_model = lambda m: m
    settings_store._cache["agents.tool_concurrency"] = 1
    settings_store._cache["agents.max_dispatches_per_turn"] = 3
    trace._flush = lambda t: asyncio.sleep(0)

    from app.agents import registry as agent_registry

    async def get_agent(name):
        return {"id": name, "name": name, "enabled": True,
                "model": "openrouter:test", "system_prompt": "s",
                "allowed_tools": []}

    agent_registry.get_agent_by_name = get_agent

    async def get_agent_tools(agent, exclude=None):
        return [{"type": "function", "function": {
            "name": "dispatch_to_agent", "description": "d", "parameters": {}}}]

    tool_registry.get_agent_tools = get_agent_tools

    async def _empty(*a, **kw):
        return ""

    runner._platform_block = _empty
    runner._entities_block = _empty
    runner._mcp_index_block = _empty


async def run_turn(text):
    install(Script(text))
    events = []
    with memory_mod.sandbox(memory_mod.OkfMemory(base_dir=SCRATCH_MEM)):
        async with trace.turn("test"):
            async for ev in runner.run_agent(
                    AGENT, [{"role": "user", "content": "go"}]):
                events.append(ev)
    return events


def narration_events(events):
    # the runner yields the activity FLAT — {"type": "activity", "kind": ...}
    # — and router_chat re-wraps it for the SSE stream, so this is the shape
    # at this layer, not the nested one the browser sees
    return [e for e in events
            if e.get("type") == "activity" and e.get("kind") == "narration"]


async def test_end_to_end():
    print("4. end to end — the banner event leaves the real runner")
    events = await run_turn(
        "I dispatched the tool-creator and it is building the tool now.")
    hits = narration_events(events)
    check("a past-tense dispatch claim with no tool call raises the banner",
          len(hits) == 1, f"{len(hits)} narration events")

    events = await run_turn("Your note is in memory under the travel tag.")
    check("an ordinary answer raises nothing",
          narration_events(events) == [], str(narration_events(events)))


def final_text(events):
    finals = [e for e in events if e.get("type") == "final"]
    return finals[-1]["text"] if finals else ""


async def test_correction_is_in_the_reply():
    # The banner alone was not enough. It persists as a role='tool' row, and
    # the chat history loader keeps only user/assistant rows — so the model
    # re-read its own promise on every later turn and never the correction.
    # The contradiction has to travel with the text it contradicts.
    print("5. the correction is stamped into the reply, not only the banner")
    events = await run_turn(
        "I dispatched the tool-creator and it is building the tool now.")
    text = final_text(events)
    check("the flagged reply ends with the correction",
          "did not happen" in text, repr(text[-90:]))
    check("…and it is STREAMED too, so it reaches the operator and the speaker",
          any(e.get("type") == "text" and "did not happen" in e.get("text", "")
              for e in events))

    events = await run_turn("Your note is in memory under the travel tag.")
    check("a clean answer is left exactly as written",
          "did not happen" not in final_text(events),
          repr(final_text(events)))


def test_invented_identifiers():
    """An id nothing gave her. Set membership, not a vocabulary."""
    print("6. identifiers are read, never authored")
    shown = ('the operator asked for a session\n'
             'tool result: {"session_id": '
             '"11111111-2222-3333-4444-555555555555", "state": "running"}')

    # The live reply, 2026-08-06, verbatim in shape. `tools_called: 0`, and
    # the id and the branch derived from it were both invented. Note the `_`
    # in front: a \b-anchored pattern finds nothing here, because `_` is a
    # word character — which is how the first version of this check passed on
    # the exact reply it was written for.
    live = ("Started.\n- **Session:** `a]_07eb8f3a-7c2d-4f7a-9c1e-5b2e0f8d1a3c`"
            "\n- **Branch:** `nova/f8d1a3c`\nI'll stop here.")
    check("6.1 the live fabrication is caught",
          narration.invented_ids(live, shown) ==
          ["07eb8f3a-7c2d-4f7a-9c1e-5b2e0f8d1a3c"],
          str(narration.invented_ids(live, shown)))

    # …and the mirror half, which matters more: an id she really was handed
    # must never be called invented. The correction is appended to the reply
    # and read aloud, so a false accusation is the expensive error.
    check("6.2 an id a tool returned is quiet",
          narration.invented_ids(
              "Started session 11111111-2222-3333-4444-555555555555.",
              shown) == [])
    check("6.3 …however she re-cases it",
          narration.invented_ids(
              "Session 11111111-2222-3333-4444-555555555555".upper(),
              shown) == [])
    check("6.4 a reply with no identifiers is quiet",
          narration.invented_ids("Rebuilt it; it came back up.", shown) == [])
    check("6.5 a short hex word is not a uuid",
          narration.invented_ids("Commit a3f9c21 is the one.", shown) == [],
          "commit shapes collide with prose, so only uuids are checked")
    check("6.6 the same invention is reported once, not per mention",
          len(narration.invented_ids(live + "\n" + live, shown)) == 1)
    check("6.7 nothing shown means nothing can be verified — all are invented",
          narration.invented_ids(
              "Session 11111111-2222-3333-4444-555555555555.", "") ==
          ["11111111-2222-3333-4444-555555555555"])


def test_memory_claim_unread():
    """Nova has a store; the model has weights. Only one of them is hers."""
    print("7. \"from memory\" when no memory was read")
    claims = [
        # the live reply, 2026-08-06: the GLM-4.x band came from training,
        # while the real note with the real price sat unread in her own store
        "What I can tell you from memory: the GLM-4.x line sat in the "
        "$0.10-$0.50 band.",
        "From my notes, the price was $0.60 per million.",
        "My records say it was reviewed quarterly.",
        "I have it stored as $0.60.",
        "According to my memory, that ran in July.",
    ]
    for text in claims:
        check(f"7.1 flags: {text[:44]}",
              narration.memory_claim_unread(text, []) is not None)

    # The half that matters more. This correction is appended to the reply and
    # read aloud, so a false accusation costs more than a missed catch — and
    # every line below is an honest answer.
    honest = [
        "I have nothing stored on that.",
        "I have no memory of that conversation.",
        "There is nothing in my notes about it.",
        "Do you want me to check my notes?",
        "I can't answer from memory — I never recorded it.",
        "I searched the web, not my memory.",
    ]
    for text in honest:
        check(f"7.2 quiet: {text[:44]}",
              narration.memory_claim_unread(text, []) is None,
              str(narration.memory_claim_unread(text, [])))

    check("7.3 silent when a memory tool actually ran",
          narration.memory_claim_unread(claims[0], ["search_memory"]) is None,
          "the claim is true then, and saying otherwise defaces a good answer")
    check("7.4 web_search does NOT satisfy it",
          narration.memory_claim_unread(claims[0], ["web_search"]) is not None,
          "searching the web and calling it memory is the exact confusion")
    check("7.5 every satisfying tool reads memory rather than writing it",
          "write_memory" not in narration.MEMORY_READS,
          "writing a note is not having read one")


# ── 8. the memory-claim guard actually fires from the runner ──────────────
# Section 7 proves the regex; this proves the WIRING. _build_system_prompt
# wrote memory_suppressed/memory_shown into `signals`, but the ctx dict
# copied only untrusted_context out of prompt_signals — so the guard's
# condition read keys that never existed and the sixth retry budget was dead
# code from the day it landed. No unit test could see that: only driving the
# real runner with retrieval that withholds notes does.

class MemoryScript:
    """Round 1 quotes "memory" it never read; round 2 answers honestly."""

    def __init__(self):
        self.calls = 0

    def stream_chat(self, *a, **kw):
        self.calls += 1
        n = self.calls

        async def gen():
            if n == 1:
                text = "From my notes, the price was $0.60 per million."
            else:
                text = "That is general knowledge; I have nothing stored on that."
            for token in text.split(" "):
                yield {"type": "text", "text": token + " "}
        return gen()


class WithheldMemory(memory_mod.OkfMemory):
    """Retrieval that puts NOTHING in the prompt while notes sit withheld."""

    async def context(self, query, max_chars=None, origins=None):
        return {"context": "", "suppressed": 2, "untrusted": False,
                "origins": []}


async def test_memory_guard_end_to_end():
    print("8. end to end — the memory-claim retry leaves the real runner")
    install(MemoryScript())
    events = []
    with memory_mod.sandbox(WithheldMemory(base_dir=SCRATCH_MEM)):
        async with trace.turn("test"):
            async for ev in runner.run_agent(
                    AGENT, [{"role": "user", "content": "what did it cost"}]):
                events.append(ev)
    hits = [e for e in events if e.get("type") == "activity"
            and e.get("kind") == "memory_claim_retry"]
    check("withheld notes + empty retrieval + no tool forces the retry",
          len(hits) == 1, f"{len(hits)} memory_claim_retry events")
    check("the false claim is retracted from the final reply",
          "From my notes" not in final_text(events),
          repr(final_text(events)[:70]))
    check("round 2's honest answer is what persists",
          "general knowledge" in final_text(events),
          repr(final_text(events)[:70]))


# ── 9. the round seam — rounds join with a break, stream == persisted ─────
# The live row of 2026-08-07 00:45:35 read "Doing it now.Card is in your
# chat": each round's text was appended onto final_text with plain +=, while
# every injected note nearby carries its own \n\n. The separator must live
# INSIDE the round's slice, so a retraction removes it with the round — and
# it must be streamed as well as persisted, because a stream that reads
# differently from the saved row is its own defect.

class ToolThenTextScript:
    """Round 1 talks mid-sentence and calls a tool; round 2 answers."""

    def __init__(self):
        self.calls = 0

    def stream_chat(self, *a, **kw):
        self.calls += 1
        n = self.calls

        async def gen():
            if n == 1:
                for token in "Doing it now.".split(" "):
                    yield {"type": "text", "text": token + " "}
                yield {"type": "tool_calls", "tool_calls": [
                    {"id": "c1", "name": "fetch_url",
                     "arguments": '{"url": "https://example.com"}'}]}
            else:
                for token in "The page returned 200 and looks healthy.".split(" "):
                    yield {"type": "text", "text": token + " "}
        return gen()


async def test_round_seam():
    print("9. a two-round reply carries the separator, and the stream matches")
    install(ToolThenTextScript())

    async def one_tool(agent, exclude=None):
        return [{"type": "function", "function": {
            "name": "fetch_url", "description": "d", "parameters": {}}}]

    tool_registry.get_agent_tools = one_tool

    async def ran(name, args, ctx):
        return "200 OK"

    tool_registry.execute_tool = ran

    async def unattended(ctx):
        return {}

    tool_registry.unattended_tools = unattended

    events = []
    with memory_mod.sandbox(memory_mod.OkfMemory(base_dir=SCRATCH_MEM)):
        async with trace.turn("test"):
            async for ev in runner.run_agent(
                    AGENT, [{"role": "user", "content": "check the page"}]):
                events.append(ev)
    text = final_text(events)
    check("the rounds are separated, not fused mid-sentence",
          "now. \n\nThe page" in text, repr(text))
    streamed = "".join(e.get("text", "") for e in events
                       if e.get("type") == "text")
    check("the stream reads exactly what is persisted", streamed == text,
          f"streamed {streamed[-40:]!r} vs final {text[-40:]!r}")


def main() -> int:
    test_patterns()
    test_gate()
    test_completion_survives_a_tool_call()
    test_invented_identifiers()
    test_memory_claim_unread()
    asyncio.run(test_end_to_end())
    asyncio.run(test_correction_is_in_the_reply())
    asyncio.run(test_memory_guard_end_to_end())
    asyncio.run(test_round_seam())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:6]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
