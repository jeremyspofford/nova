"""Did the summary make that up? — the grounding gate.

    docker compose exec backend python tests/test_grounding.py

The first transcript summary Nova ever wrote listed a company called "Six
Labs" among the available models. Its transcript does not contain the phrase.
It also claimed a rate limit was "twice the usual", which the transcript does
not say either. The system prompt for that call read "Report only what the
transcript actually says... do not add context from your own knowledge."

So the prompt was already correct and already ignored, which is the whole
argument for this module existing. What makes a transcript summary checkable
where most summaries are not is that its ground truth is on disk beside it.

PRECISION IS THE DESIGN, and the measurements below are why. A naive first
pass over a genuinely excellent HTMX 4.0 summary flagged ten terms, of which
about one was real — the rest were the summary's own headings, punctuation on
units, and the file path in the header. Throwing that summary away would have
been worse than letting "Six Labs" through, because a check that eats good
work gets turned off. The tuned version flags zero on it and still catches
Six Labs.

The cases below are the real ones, kept verbatim so a future edit that
loosens precision fails here rather than in the corpus.
"""

import sys

sys.path.insert(0, "/app/backend")

from app import grounding          # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


# ── the incident, verbatim ───────────────────────────────────────────────
CLINE_SUMMARY = (
    "- The models include GLM5.2, Kimmy K3, DeepSeek V4 Pro, MiniMax M3, "
    "Qwen 3.7 Max, Six Labs, among others, all available within KleinPaaS.\n"
    "- Pricing is $9.99/month for access to the 11 models.\n"
    "The speaker recommends trying the service as an introductory 80% off deal.")

# what the transcript actually contains, in the phrasings whisper produced —
# note "GLM 5.2" spaced, where the summary wrote "GLM5.2"
CLINE_TRANSCRIPT = (
    "so KleinPaaS gives you eleven models including GLM 5.2 and Kimmy K3 and "
    "DeepSeek V4 Pro and MiniMax M3 and Qwen 3.7 Max for nine ninety nine a "
    "month and right now there's an 80% off introductory deal for $9.99")

HTMX_SUMMARY = (
    "Carson Gross skipped HTMX 3 because he had publicly promised there would "
    "not be one, making HTMX 4 the direct successor to HTMX 2.x.\n"
    "Key breaking changes:\n"
    "- Fetch replaces XMLHttpRequest: HTMX 2.10 minified is 50kb; HTMX 4 Beta "
    "6 is 35.4kb.\n"
    "- Settle delay drops from 20ms to 1ms.\n"
    "- Request timeout is now 60 seconds instead of infinite.")

HTMX_TRANSCRIPT = (
    "Carson Gross said there would never be an HTMX 3 so HTMX 4 follows HTMX "
    "2.x directly. they swapped XML HTTP request for fetch. htmx 2.10 minified "
    "is 50 KB and HTMX 4 beta 6 comes in at 35.4 kilobytes. the settle delay "
    "went from 20 milliseconds down to 1 millisecond and the request timeout "
    "is 60 seconds now instead of infinite")


def main() -> int:
    print("1. the incident — an invented vendor is caught")
    bad = grounding.ungrounded(CLINE_SUMMARY, CLINE_TRANSCRIPT)
    check("'Six Labs' appears nowhere in the transcript and is flagged",
          "Six Labs" in bad, str(bad))
    check("...and it is the ONLY thing flagged — every other name in that "
          "summary was real, and flagging them would train the operator to "
          "ignore this", bad == ["Six Labs"], str(bad))

    print("2. the good summary — zero false positives, or the check gets "
          "turned off")
    clean = grounding.ungrounded(HTMX_SUMMARY, HTMX_TRANSCRIPT)
    check("an accurate, detailed summary is flagged for nothing",
          clean == [], str(clean))

    print("3. why: speech-to-text spells things differently than a summary does")
    check("'GLM5.2' matches a transcript's 'GLM 5.2' — normalising both sides "
          "to alphanumerics is what makes spacing stop mattering",
          grounding._grounded("GLM5.2", grounding._norm("uses GLM 5.2 here")))
    check("'11 models' matches 'eleven models' — whisper spells numbers out",
          grounding._grounded("11", grounding._norm("there are eleven models")))
    check("'1ms' matches '1 millisecond' — the number is the claim, the unit "
          "is the summary's shorthand",
          grounding._grounded("1ms", grounding._norm("down to 1 millisecond")))
    check("'35.4kb' matches '35.4 kilobytes'",
          grounding._grounded("35.4kb", grounding._norm("about 35.4 kilobytes")))
    check("but an invented measurement is still caught",
          not grounding._grounded("512kb", grounding._norm("about 35.4 kilobytes")))

    print("4. the candidate set is narrow on purpose")
    cands = grounding.candidates(
        "Key points covered:\nSummary of the video.\nThe speaker explains it.")
    check("headings and list labels are not entities — these were 3 of the 10 "
          "false positives on the first pass", cands == set(), str(cands))
    check("a sentence-initial capital alone is not an entity",
          not grounding.candidates("Fetch replaces things."),
          str(grounding.candidates("Fetch replaces things.")))
    check("a real multi-word name mid-sentence IS a candidate",
          "Carson Gross" in grounding.candidates(
              "As of today Carson Gross said so."))
    check("a bare single digit is not a candidate — 'part 3' is not a claim",
          grounding.candidates("It covers 3 things.") == set(),
          str(grounding.candidates("It covers 3 things.")))
    check("a version number is a candidate",
          "5.6" in " ".join(grounding.candidates("It ships with GPT 5.6 now.")),
          str(grounding.candidates("It ships with GPT 5.6 now.")))

    print("4b. what a run over 86 real summaries taught, that two did not")
    # The first version was validated on two documents and looked perfect. At
    # scale it refused 12 summaries, of which roughly 7 were its own fault —
    # including the HTMX summary used above as the precision exemplar, killed
    # by "IS EVERY VERSION OF HTMX EVER PUBLISHED". Every case below is real.
    for caps in ("IS EVERY VERSION OF HTMX EVER PUBLISHED",
                 "CLAIMS MADE, FOR RESOLUTION, NAMES OR VERSIONS",
                 "US AI", "GB VRAM", "GB RAM"):
        check(f"ALL-CAPS is emphasis, not a name: {caps[:38]}",
              caps not in grounding.candidates(f"It needs {caps} for this."),
              str(grounding.candidates(f"It needs {caps} for this.")))
    check("a capitalised NAME has lowercase letters in it, so real entities "
          "survive the same rule",
          "Nvidia Spark" in grounding.candidates("It needs Nvidia Spark here."))
    check("'CRUD APIs' against a source saying 'a CRUD API' is not a "
          "fabrication — refusing a summary over an 's' is how a check gets "
          "switched off",
          grounding._grounded("CRUD APIs", grounding._norm("build a CRUD API")))
    check("but a plural that is genuinely absent is still caught",
          not grounding._grounded("Spark GPUs", grounding._norm("build a CRUD API")))

    print("4c. compaction — the highest-leverage place this check runs")
    # A rolling summary is injected into the system prompt of every later
    # turn, so a name invented here is read as established fact from then on
    # and is invisible. The source it must be graded against is the PREVIOUS
    # SUMMARY PLUS the newly aged-out messages: a correct update carries
    # facts forward out of the old summary, and grading against the new
    # messages alone would flag every one of them as invented.
    prev = "Jeremy works on Nova and prefers plain words over emojis."
    aged = ("User: let's use the qwen3:14b model for that\n\n"
            "Nova: understood, I'll switch the fallback")
    carried = ("Jeremy works on Nova and prefers plain words. He chose "
               "qwen3:14b for the fallback.")
    check("a fact carried forward from the previous summary is NOT a "
          "fabrication — grading against the new messages alone would flag "
          "every one of them",
          grounding.ungrounded(carried, f"{prev}\n\n{aged}") == [],
          str(grounding.ungrounded(carried, f"{prev}\n\n{aged}")))
    check("a name in NEITHER the previous summary nor the messages is caught "
          "even when it opens a sentence — the commonest shape of a "
          "fabricated name, and one an earlier version walked straight past",
          "Karen Wu" in grounding.ungrounded(
              f"{carried} Karen Wu approved it.", f"{prev}\n\n{aged}"),
          str(grounding.ungrounded(f"{carried} Karen Wu approved it.",
                                   f"{prev}\n\n{aged}")))
    check("...and a sentence-initial LIST HEADER is not mistaken for one",
          grounding.ungrounded("Key Points follow. Next Steps are listed.",
                               "unrelated source") == [],
          str(grounding.ungrounded("Key Points follow. Next Steps are listed.",
                                   "unrelated source")))

    print("5. the caller's own header is not the model's claim")
    header = "topics/some-video-full-transcript.md"
    check("a file path passed as `ignore` is not reported",
          grounding.ungrounded(f"See {header} for more.", "unrelated text",
                               ignore=[header]) == [],
          str(grounding.ungrounded(f"See {header} for more.", "unrelated text",
                                   ignore=[header])))

    print("6. edges")
    check("an empty summary flags nothing", grounding.ungrounded("", "x") == [])
    check("an empty source flags what the summary asserts",
          "Six Labs" in grounding.ungrounded("It uses Six Labs models.", ""))

    print("7. what this deliberately does NOT catch, stated so nobody "
          "believes otherwise")
    check("'twice the usual rate' — an invented quantity in words, with no "
          "name and no digit — passes. Catching it needs claim-level "
          "entailment, which is another model, which is the thing that failed.",
          grounding.ungrounded("Limits are twice the usual rate.",
                               "limits are generous") == [])

    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
