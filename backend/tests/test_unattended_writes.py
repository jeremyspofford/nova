"""Writes she may make without asking, and the ones she still may not.

    docker compose exec backend python tests/test_unattended_writes.py

Jeremy, 2026-08-05, reading migration 092 the same day it landed:

    "I would say some of her writes to go unasked ... nova needs to be
     capable, proactive, reactive, autonomous, thoughtful, creative,
     asumptive (to a productive use), and anything else that makes her more
     human."

092 had drawn the line at read-vs-write. This suite defends where it moved
to: REVERSIBLE-AND-HERS vs IRREVERSIBLE-OR-OUTWARD-FACING.

The danger in a lane like this is one-directional, so the suite is weighted
that way. Widening `unattended` too far means she deletes, overwrites or
notifies with nobody's say-so; widening it too little just means she asks a
question Jeremy finds annoying. Layers:

  1. THE PREDICATE — which SHAPES of write_memory qualify. An arg-level
     question, which is why the declaration is a callable and not a bool.
  2. THE SEPARATION — `reads_only` must NOT have grown. It feeds
     `runner._PARALLEL_TOOLS`, and a write in that set is two memory writes
     racing over one index. This is the check that fails if someone
     "simplifies" the two declarations into one.
  3. MUST NOT BE UNATTENDED — the four neighbours that look similar and are
     not: delete_memory_item, follow_source, remember_speaker,
     notify_operator.
  4. THE DETECTOR — `write_offer` fires on offering to remember, and is deaf
     to every other kind of offer. Its own veto, so `offer()`'s `_MUTATION`
     list stays untouched.
  5. DERIVED — a rule that blocks write_memory takes it out of the set with
     no edit here, exactly like the read half.
  6. THE MEASUREMENT — reply_shape records, and changes nothing.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

from app import deferral, settings_store                     # noqa: E402
from app.agents import runner                                # noqa: E402
from app.tools import registry as tool_registry              # noqa: E402
from app.tools.builtin import BUILTIN_TOOLS, _write_memory_unattended  # noqa: E402

FAILURES: list[str] = []

# What `unattended_tools` would return with the write half live. Hand-built
# so the detector tests do not depend on the database.
UNATTENDED = {
    "write_memory": {"write", "memory"},
    "remember_about_me": {"remember", "about", "me"},
    "fetch_url": {"fetch", "url"},
    "search_memory": {"search", "memory"},
}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def w_fires(text, unattended=None, already=()):
    """(window, covered) for a zero-tool-call round."""
    window = deferral.write_offer(text, 0)
    if not window:
        return None, []
    return window, deferral.write_satisfied(
        window, UNATTENDED if unattended is None else unattended,
        already_called=already)


# ── 1. the predicate ────────────────────────────────────────────────────────

def test_predicate():
    print("\n1. WHICH SHAPES OF write_memory GO UNASKED")

    check("1.1 a new note qualifies",
          _write_memory_unattended({"type": "topic", "title": "x", "content": "y"}))
    check("1.2 a journal note qualifies",
          _write_memory_unattended({"type": "journal", "content": "y"}))
    check("1.3 no args at all qualifies (the probe shape)",
          _write_memory_unattended({}))

    # Appending is the shape the flag exists for — running digests, logs.
    check("1.4 append to an existing item qualifies",
          _write_memory_unattended({"item_id": "topics/a.md", "append": True,
                                    "content": "new entry"}))
    check("1.5 prepend to an existing item qualifies",
          _write_memory_unattended({"item_id": "topics/a.md", "prepend": True,
                                    "content": "new entry"}))

    # THE TWO CARVE-OUTS. Both are cases where reversible-and-hers fails.
    check("1.6 REPLACING an existing item does NOT qualify",
          not _write_memory_unattended({"item_id": "topics/a.md",
                                        "content": "whole new body"}),
          "item_id without append/prepend overwrites a file he may have written")
    check("1.7 writing a SKILL does NOT qualify",
          not _write_memory_unattended({"type": "skill", "title": "x",
                                        "content": "y"}),
          "guidance other agents retrieve and follow is nearer capability")
    check("1.8 a skill is refused even in append mode",
          not _write_memory_unattended({"type": "skill", "item_id": "skills/a.md",
                                        "append": True, "content": "y"}))


# ── 2. the separation from reads_only ───────────────────────────────────────

def test_separation():
    print("\n2. `reads_only` MUST NOT HAVE GROWN")

    # This is the one that matters most. `reads_only` has three consumers and
    # the third is `runner._PARALLEL_TOOLS`; a write there runs concurrently
    # with everything else in its round.
    for name in ("write_memory", "remember_about_me", "ingest_media",
                 "retry_ingest_job"):
        check(f"2.1 {name} is NOT reads_only",
              not tool_registry.reads_only(name),
              "would make it parallel-safe")
        check(f"2.2 {name} IS unattended",
              tool_registry.needs_no_decision(
                  name, tool_registry._UNATTENDED_PROBE.get(name)))

    check("2.3 none of the unattended writes reached _PARALLEL_TOOLS",
          not ({"write_memory", "remember_about_me", "ingest_media",
                "retry_ingest_job"} & set(runner._PARALLEL_TOOLS)),
          sorted(runner._PARALLEL_TOOLS))

    # And the union really is a union — reads still qualify.
    check("2.4 a plain read is still unattended",
          tool_registry.needs_no_decision("fetch_url"))


# ── 3. what must never join the set ─────────────────────────────────────────

def test_must_not_be_unattended():
    print("\n3. THE NEIGHBOURS THAT LOOK SIMILAR AND ARE NOT")

    cases = [
        ("delete_memory_item", "erasing his record is never unattended"),
        ("follow_source", "a RECURRING commitment, not one fetch"),
        ("remember_speaker", "biometric enrolment of a person"),
        ("notify_operator", "reaches his phone and cannot be un-sent"),
        ("raise_recommendation", "spends his attention"),
        ("manage_rules", "the strictest gate in the system"),
        ("deploy_workload", "goal-scoped, largest thing she does unattended"),
        ("delegate_coding_task", "goal-scoped"),
    ]
    for name, why in cases:
        check(f"3.1 {name} is NOT unattended",
              not tool_registry.needs_no_decision(name), why)

    # The generic form: absent means False, so a tool added tomorrow does not
    # widen the set by existing.
    undeclared = [n for n, s in BUILTIN_TOOLS.items()
                  if isinstance(s, dict) and not s.get("reads_only")
                  and not s.get("unattended")]
    check("3.2 every builtin that declares neither flag is gated",
          all(not tool_registry.needs_no_decision(n) for n in undeclared),
          f"{len(undeclared)} undeclared builtins")


# ── 4. the detector ─────────────────────────────────────────────────────────

def test_detector():
    print("\n4. write_offer FIRES ON OFFERING TO REMEMBER")

    must_fire = [
        ("4.1 the plain case",
         "That's a useful detail about your setup. Want me to remember that?"),
        ("4.2 save, not remember",
         "Good to know you prefer the 14b for ingestion. Should I save that?"),
        ("4.3 the window, not the clause — offer trails its verb",
         "I can note that down for next time. Want me to?"),
        ("4.4 make a note",
         "You've said that twice now. Shall I make a note of it?"),
        ("4.5 keep it",
         "That's the third time this week. Would you like me to keep that?"),
    ]
    for label, text in must_fire:
        window, covered = w_fires(text)
        check(label, bool(covered), f"window={window!r} covered={covered}")

    print("\n   MUST NOT FIRE — real consent requests")
    must_not = [
        ("4.6 deleting", "That topic looks stale. Want me to delete it?"),
        ("4.7 scheduling", "I could run that nightly. Want me to schedule it?"),
        ("4.8 following a source", "Want me to follow that channel?"),
        ("4.9 notifying", "Want me to notify you when it finishes?"),
        ("4.10 creating", "Want me to create an agent for that?"),
        ("4.11 replacing", "Want me to update that note and remove the old text?"),
        ("4.12 a pure read offer stays with the READ detector",
         "I can check whether it's reachable from my side. Want me to try?"),
        ("4.13 no offer marker at all",
         "I remembered that already — it's in your notes from Tuesday."),
    ]
    for label, text in must_not:
        window, covered = w_fires(text)
        check(label, not covered, f"window={window!r} covered={covered}")

    # Round-scoped on BOTH sides — the bug commit 12c5511 exists for.
    # An offer she then ANSWERED is caught by this and not by the text: with
    # a call in the round there is nothing to correct, and with NO call the
    # narration guard owns it (she announced a save that never happened) —
    # which is why that branch runs before this one in the round loop.
    check("4.14 an offer she already answered, having called",
          not deferral.write_offer(
              "Want me to remember that? I did — saved it as a topic.", 1))
    check("4.15 a round that called a tool never fires",
          not deferral.write_offer("Want me to remember that?", 2))

    # already_called: an offer to do MORE is not an offer INSTEAD OF.
    _, covered = w_fires("Saved that one. Want me to remember the other too?",
                         already=("write_memory",))
    check("4.16 subtracts what she already called this turn", not covered)


# ── 5. derived, not listed ──────────────────────────────────────────────────

def test_derived():
    print("\n5. DERIVED FROM THE LIVE SET")

    # A rule blocking write_memory takes it out with no edit here — modelled
    # by handing the detector a set that lacks it, which is exactly what
    # `unattended_tools` returns when `gate_refusing` says "rule:...".
    without = {k: v for k, v in UNATTENDED.items() if k != "write_memory"}
    _, covered = w_fires("Want me to remember that?", unattended=without)
    check("5.1 write_memory blocked by a rule -> remember_about_me still covers",
          covered == ["remember_about_me"], covered)

    _, covered = w_fires("Want me to remember that?", unattended={"fetch_url": {"fetch"}})
    check("5.2 neither note tool free -> does not fire", not covered)

    check("5.3 the probe shape is what the derivation asks with",
          tool_registry._UNATTENDED_PROBE.get("write_memory") == {"type": "topic"})


# ── 6. the measurement changes nothing ──────────────────────────────────────

def test_measurement():
    print("\n6. reply_shape RECORDS AND DOES NOT GATE")

    check("6.1 a list request is marked structure_asked",
          bool(runner._STRUCTURE_ASKED.search("give me a list of my automations")))
    check("6.2 a comparison is marked",
          bool(runner._STRUCTURE_ASKED.search("compare qwen3 and glm")))
    check("6.3 a bare follow-up is NOT",
          not runner._STRUCTURE_ASKED.search("and QUIC?"),
          "the turn the whole measurement exists for")
    check("6.4 counts bullets, dash and numbered",
          len(runner._BULLET_LINE.findall("- a\n- b\n1. c\n* d\nplain")) == 4)
    check("6.5 the setting exists and defaults on",
          settings_store.get("observability.measure_reply_shape") is not False)


def test_past_tense_retrieval():
    """The failure mode this lane CREATES, and the arm that catches it.

    Removing the friction of "want me to check?" changes how she fails: she
    stops offering and starts asserting. Measured live 2026-08-05, the hour
    the lane landed — "Just checked it again — yes, ossinsight.io is up and
    fully functional right now", `tools_called: 0`, contradicting a real
    fetch from an hour earlier. Nothing fired: narration had read verbs in
    the FUTURE tense only.

    This section is the reason the autonomy half is safe to ship. Without it
    the lane trades a question for an invention.
    """
    print("\n8. SHE CLAIMED A READ SHE DID NOT DO")
    from app import narration

    fire = [
        ("8.1 the live incident, verbatim",
         "Just checked it again — yes, ossinsight.io is up and fully "
         "functional right now.", []),
        ("8.2 plain past tense", "I checked ossinsight.io and it is up.", []),
        ("8.3 fetched", "I just fetched the page and it loads fine.", []),
        ("8.4 a WRITE does not satisfy a read claim",
         "I searched for it and found nothing.", ["write_memory"]),
    ]
    for label, text, tools in fire:
        check(label, bool(narration.detect(text, 0, tools)),
              repr(narration.detect(text, 0, tools)))

    print("   MUST NOT FIRE — she really did look")
    quiet = [
        ("8.5 a real fetch ran", "Just checked it — it is up.", ["fetch_url"]),
        ("8.6 a search ran", "I searched and found three.", ["web_search"]),
        ("8.7 an MCP read ran — derived, not listed",
         "I checked the docs.", ["mcp:context7/query-docs"]),
        ("8.8 honest recap of an earlier turn",
         "I checked that earlier and it was up.", []),
        ("8.9 'already' is a recap marker", "I already checked it.", []),
        ("8.10 a third-party subject", "The digest updated it overnight.", []),
        ("8.11 an ordinary answer",
         "OSSInsight is an analytics platform built by PingCAP.", []),
    ]
    for label, text, tools in quiet:
        check(label, not narration.detect(text, 0, tools),
              repr(narration.detect(text, 0, tools)))


async def test_off_switch():
    print("\n7. THE OPERATOR'S SWITCH")
    settings_store._cache["autonomy.act_on_writes"] = False
    try:
        check("7.1 flag off is readable as off",
              settings_store.get("autonomy.act_on_writes") is False)
    finally:
        settings_store._cache["autonomy.act_on_writes"] = True
    check("7.2 restored", settings_store.get("autonomy.act_on_writes") is True)


def main() -> int:
    test_predicate()
    test_separation()
    test_must_not_be_unattended()
    test_detector()
    test_derived()
    test_measurement()
    test_past_tense_retrieval()
    asyncio.run(test_off_switch())
    if FAILURES:
        print(f"\nFAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
