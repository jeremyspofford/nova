"""The write-time detectors: a topic that stores a figure it calls wrong,
and a topic whose tags leave it unconnected in the graph.

    docker compose exec backend python tests/test_durability.py

The bar for a heuristic like this is precision, not recall — it fires into
a tool result the model then acts on, so a false positive sends the model
rewriting a topic that was already right. Every case below is either an
observed failure or the legitimate write most likely to be confused with
one.
"""

import sys

sys.path.insert(0, "/app/backend")

from app import durability, tagging                        # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def test_catches_the_real_thing():
    print("1. the observed failure, verbatim from a graded run")
    body = ("Kimi K3 is Moonshot AI's third-generation open-weight LLM.\n"
            "- 1.2 trillion total parameters; 32 billion active per token.\n"
            "- Note: a May 2026 rumor/leak had claimed 2T params and 1M "
            "context for a Q4 launch — those figures are superseded by the "
            "official announcement and not accurate.")
    found = durability.detect(body)
    check("the disowned-figure sentence is flagged", found is not None)
    check("...and it is the NOTE line, not the correct facts above",
          found is not None and "superseded" in found, str(found)[:80])

    check("the same shape in a shorter form",
          durability.detect("Early leaks said 2T params; that was wrong.") is not None)
    check("a debunked price",
          durability.detect("The $99 figure was debunked after launch.") is not None)


def test_leaves_correct_writes_alone():
    print("2. correct topics are not touched")
    clean = ("Kimi K3 is a sparse MoE transformer with 1.2 trillion total "
             "parameters and 32 billion active per token. Context window: "
             "768K tokens. Hosted pricing is $0.40 per million input tokens.")
    check("a topic with only true figures", durability.detect(clean) is None,
          str(durability.detect(clean)))

    # a leak mentioned with NO number is not the harm this guards against —
    # the damage is a figure surviving in the search index
    check("prose about a leak carrying no figure",
          durability.detect("The release followed months of leaks and rumor.") is None)

    # disowning language about something that is not a measurement
    check("a wrong NAME is not a figure",
          durability.detect("Early reports named the wrong lab; that was inaccurate.") is None)

    check("empty content", durability.detect("") is None)
    check("plain hours (the other rail's business, not this one)",
          durability.detect("Open 10:00 am to 4:30 pm daily.") is None)


def test_sentence_scoped():
    print("3. scoped to a sentence, so distance means innocence")
    # true numbers in one place, an unrelated retraction elsewhere: the two
    # never share a sentence, so nothing fires
    body = ("The model ships with 768K context.\n\n"
            "Separately, the lab retracted an unrelated benchmark claim.")
    check("a retraction with no figure beside it stays quiet",
          durability.detect(body) is None, str(durability.detect(body)))

    # ...but the same retraction WITH the number does fire
    body2 = ("The model ships with 768K context.\n\n"
             "The lab retracted its earlier 1M context claim.")
    check("the same retraction carrying the number fires",
          durability.detect(body2) is not None)


def test_warning_text():
    print("4. the warning tells the model what to do about it")
    msg = durability.WARNING.format(found="a leak claimed 2T params",
                                    item_id="topics/kimi-k3.md")
    check("names the item to rewrite", "topics/kimi-k3.md" in msg)
    check("explains WHY snippets make it harmful", "snippet" in msg.lower())
    check("leaves the legitimate case open", "genuinely is the subject" in msg)


def test_tag_hygiene():
    print("5. tag hygiene: a topic whose tags are ALL generic floats alone")
    # the Bear Mountain incident's tag set — every one of these is a
    # category, none of them a subject
    check("all-generic tags are flagged",
          tagging.detect(["zoo", "new-york", "nature"]) is not None)
    check("...and the flag names them",
          set(tagging.detect(["zoo", "new-york"])) == {"zoo", "new-york"})

    # ONE specific tag is enough to connect the note; broad labels alongside
    # it are normal and useful for search
    check("one specific tag among generic ones is fine",
          tagging.detect(["bear-mountain", "zoo", "new-york"]) is None)
    check("entirely specific tags are fine",
          tagging.detect(["kimi-k3", "moe-models"]) is None)

    check("no tags at all is the write path's business, not this check",
          tagging.detect([]) is None and tagging.detect(None) is None)
    check("case and whitespace do not smuggle a generic tag past it",
          tagging.detect(["  ZOO  "]) is not None)


def test_tag_warning_text():
    print("6. the tag warning says what to do")
    msg = tagging.WARNING.format(found="zoo, new-york", item_id="topics/x.md")
    check("names the item", "topics/x.md" in msg)
    check("explains the graph consequence", "edges" in msg)
    check("keeps broad tags legitimate", "Keep the broad ones" in msg)


def main():
    for t in (test_catches_the_real_thing, test_leaves_correct_writes_alone,
              test_sentence_scoped, test_warning_text, test_tag_hygiene,
              test_tag_warning_text):
        t()
        print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
