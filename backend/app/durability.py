"""Durability detector — flags a topic that stores a claim the writer has
just labelled as WRONG.

The failure class (measured 2026-07-24, 5 of 10 graded runs): asked to
research a subject whose mini-web plants a superseded pre-release leak, the
agent writes a clean topic and then appends "a May 2026 leak claimed 2T
params / 1M context — superseded and inaccurate". The caveat reads fine in
the file and is useless everywhere else: memory retrieval returns SNIPPETS,
and a later search for those figures surfaces the number without the
sentence that disowns it. It is the over-linking incident in a different
costume — a stray token creating a false association that outlives the
qualifier attached to it.

Four attempts to fix this with instructions did not move the rate: a rule
added to the agent prompt (migration 051), tightened (052), moved to the
END of the prompt where this codebase's must-win rules live (053), and
finally placed in write_memory's own description at the point of use. All
sat at 30–50% across ten graded runs each. So this is the same move the
narration detector made for a different silent failure: stop asking, and
check.

Deliberately a WARNING, not a block and never a silent edit:

* Precision is not achievable here. "The paper was retracted after the 2T
  figure was found to be fabricated" is a legitimate durable record, and
  the shape is identical to the failure. A false positive costs one
  sentence in a tool result; a false block costs a write the operator
  wanted.
* The warning goes back as part of the tool result, which is the one moment
  the model can still act on it — it holds the item_id and can rewrite in
  the same turn.

Journals are exempt by construction (the caller only checks topics): a
journal IS the record of what happened, including what turned out to be
wrong.
"""

import re

# Words that mark the writer disowning the claim in the same breath. Kept
# tight on purpose — "reportedly" and "claims" are NOT here, because a topic
# may legitimately attribute a live claim it is not disowning.
_DISOWNED = re.compile(
    r"\b(?:leak(?:ed|s)?|rumou?r(?:ed|s)?|superseded|debunked|retracted|"
    r"disproven|pre-release (?:claim|number|figure|spec)s?|"
    r"(?:turned out|proved|proven|found) (?:to be )?(?:wrong|false|incorrect)|"
    r"(?:was|were|is|are) (?:wrong|false|inaccurate|incorrect)|"
    r"not accurate|since corrected|later corrected|no longer (?:accurate|current))\b",
    re.IGNORECASE)

# ...paired with an actual figure in the same sentence. Prose that merely
# mentions a leak ("the release followed a leak") carries no number and is
# not what this is for — the harm is the NUMBER surviving in the index.
_FIGURE = re.compile(
    r"\d[\d,.]*\s*(?:[kKmMbBtT]\b|billion|million|trillion|%|percent|"
    r"tokens?|params?|parameters?|GB|MB|TB)|[$£€]\s*\d")

_SENTENCES = re.compile(r"(?<=[.!?])\s+|\n+")


def detect(content: str) -> str | None:
    """The offending sentence when a topic body records a figure it also
    calls wrong; None otherwise.

    Sentence-scoped on purpose: a topic that states the true numbers in one
    paragraph and discusses a retraction three paragraphs later is not what
    this catches, and should not be.
    """
    if not content:
        return None
    for sentence in _SENTENCES.split(content):
        if _DISOWNED.search(sentence) and _FIGURE.search(sentence):
            return " ".join(sentence.split())[:200]
    return None


WARNING = (
    "This topic records a figure it also calls wrong or superseded: {found!r}. "
    "Memory search returns snippets, so that number will come back to a "
    "future reader WITHOUT the sentence disowning it. Rewrite this item "
    "(write_memory with item_id={item_id!r}) leaving the superseded figure "
    "out entirely — put it in your reply to the operator instead. If the "
    "correction genuinely is the subject of the topic, keep it and say so.")
