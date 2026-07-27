"""Is this summary supported by the thing it summarises?

Sibling of narration.py and capability_claims.py, and the same shape: a
mechanical check against ground truth, not an instruction to be careful.

The instruction was already there. `transcript_summary._SYSTEM` says "Report
only what the transcript actually says... do not add context from your own
knowledge", and the first summary ever written under it listed a company
called "Six Labs" that appears nowhere in its transcript, and claimed a rate
limit was "twice the usual" when the transcript never says so. A prompt is a
request.

What makes THIS checkable where most summaries are not: a transcript summary
has its ground truth sitting on disk beside it. So the question "did you make
that up" has a real answer, computable, no model involved.

PRECISION IS THE DESIGN, and here it is unusually easy to get wrong. A naive
pass over a genuinely excellent HTMX 4.0 summary flagged ten terms, of which
roughly one was real: `Key` and `Summary` were the summary's own headings,
`35.4kb.` and `20ms` were punctuation and unit artifacts, and one was the
file path in the header this module's caller writes. Rejecting that summary
would have been the worst outcome — the check exists to keep good summaries
honest, not to throw them away.

So the candidate set is deliberately narrow:

  * MULTI-WORD capitalised runs — "Six Labs", "Claude Code". This is where
    invented products, vendors and people live, and a two-word proper noun is
    almost never an accident of formatting.
  * Tokens carrying DIGITS — versions, prices, counts, percentages. A
    fabricated number is as damaging as a fabricated name and far easier to
    miss on a read-through.

Single ordinary capitalised words are NOT candidates. They are overwhelmingly
sentence starts, headings and list labels, and checking them buys one real
catch for ten false ones.

WHAT THIS DOES NOT CATCH, stated rather than papered over: "twice the usual
rate" — an invented quantity expressed in words, attached to no name and no
digit. Catching that needs claim-level entailment, which is another model,
which is the thing that failed. A narrower check that always means something
beats a broad one that has to be argued with.
"""

from __future__ import annotations

import re
from typing import Iterable

# Digits spelled out. English orthography, not domain configuration — a
# whisper transcript says "eleven models" where a summary writes "11 models",
# and without this that correct summary reads as a fabrication.
_NUMBER_WORDS = {
    "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
    "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
    "10": "ten", "11": "eleven", "12": "twelve", "13": "thirteen",
    "14": "fourteen", "15": "fifteen", "16": "sixteen", "17": "seventeen",
    "18": "eighteen", "19": "nineteen", "20": "twenty", "30": "thirty",
    "40": "forty", "50": "fifty", "60": "sixty", "70": "seventy",
    "80": "eighty", "90": "ninety", "100": "hundred", "1000": "thousand",
}

# Capitalised words that begin a line, a sentence or a bullet prove nothing
# about entities, and neither do the words a summary uses to organise itself.
_STRUCTURAL = frozenset({
    "the", "this", "that", "these", "those", "it", "its", "he", "she", "they",
    "key", "summary", "overview", "note", "notes", "video", "speaker",
    "what", "why", "how", "when", "where", "who", "which", "there", "here",
    "and", "but", "for", "with", "without", "also", "however", "overall",
    "in", "on", "at", "by", "as", "an", "a", "of", "to", "from", "is", "are",
    "was", "were", "not", "no", "all", "some", "most", "other", "another",
    "first", "second", "third", "next", "last", "new", "old", "main",
})

_MULTIWORD = re.compile(
    r"\b[A-Z][A-Za-z0-9]*(?:[.\-][A-Za-z0-9]+)*"
    r"(?:\s+[A-Z][A-Za-z0-9]*(?:[.\-][A-Za-z0-9]+)*)+")
_DIGIT_TOKEN = re.compile(r"[A-Za-z]*\d[A-Za-z0-9]*(?:[.\-][A-Za-z0-9]+)*%?")
_SENTENCE_SPLIT = re.compile(r"[.!?\n]+")
_ALNUM = re.compile(r"[^a-z0-9]+")


def _norm(text: str) -> str:
    """Lowercase, alphanumerics only.

    Doing this to BOTH sides is what makes "GLM5.2" match a transcript's
    "GLM 5.2", and "35.4kb." match "35.4 KB". Spacing and punctuation in
    speech-to-text output are not evidence of anything.
    """
    return _ALNUM.sub("", text.lower())


def candidates(text: str) -> set[str]:
    """The claims in `text` worth checking against a source."""
    found: set[str] = set()
    for sentence in _SENTENCE_SPLIT.split(text):
        stripped = sentence.strip().lstrip("*-#> \t")
        if not stripped:
            continue
        for match in _MULTIWORD.finditer(stripped):
            phrase = match.group().strip()
            # drop a run that only exists because the sentence started
            if stripped.startswith(phrase):
                words = phrase.split()
                if len(words) < 3:
                    continue
                phrase = " ".join(words[1:])
            if all(w.lower() in _STRUCTURAL for w in phrase.split()):
                continue
            found.add(phrase)
    for match in _DIGIT_TOKEN.finditer(text):
        token = match.group().strip(".,;:()[]")
        # a bare single digit is noise ("part 3", "4 ways") — anything longer
        # is a version, price, count or percentage worth standing behind
        if len(token) > 1:
            found.add(token)
    return found


def _grounded(candidate: str, source_norm: str) -> bool:
    normalised = _norm(candidate)
    if not normalised:
        return True
    if normalised in source_norm:
        return True
    # a summary's "11" against a transcript's "eleven"
    word = _NUMBER_WORDS.get(normalised)
    if word and word in source_norm:
        return True
    # A MEASUREMENT — digits with a unit glued on, "35.4kb", "1ms", "60s".
    # The number is the claim; the unit is the summary's own shorthand for
    # whatever the speaker said out loud ("kilobytes", "milliseconds"). Match
    # on the number alone, at any length: "1ms" was the single false positive
    # on an otherwise clean HTMX 4.0 summary, and rejecting a good summary
    # over a settle delay is exactly the failure this check must not have.
    if re.search(r"\d", candidate) and re.search(r"[A-Za-z]", candidate):
        digits = re.sub(r"[^0-9.]", "", candidate).strip(".")
        if digits and _norm(digits) in source_norm:
            return True
    return False


def ungrounded(summary: str, source: str,
               ignore: Iterable[str] = ()) -> list[str]:
    """Claims in `summary` that do not appear in `source`.

    `ignore` exists for the header the caller writes itself — a file path and
    a video title in the preamble are not claims the model made.
    """
    source_norm = _norm(source) + " " + _norm(" ".join(ignore))
    return sorted(c for c in candidates(summary)
                  if not _grounded(c, source_norm))
