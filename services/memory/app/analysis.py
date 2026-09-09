"""The analysis chain recall runs over every document and every question.

Until this module existed the whole chain was `re.compile(r"[a-z0-9]+")`. The
measurement in docs/plans/rebuild/slice-13-memory.md says what that cost: asked
"how much RAM does my machine have", the terms *does, my, much, have, how*
supplied about 60% of the winning score and the one note that answers it ranked
seventh of seven. `does` alone outscored the correct note.

WHY THIS IS PURE PYTHON AND NOT POSTGRES

The obvious alternative was postgres — the running instance has snowball and
already bridges specs -> spec — and it was not taken, for a reason worth
stating rather than assuming. The memory service does not talk to postgres for
recall today: the index is built in-process by a full rescan at startup, and
/recall answers from memory with no database in the path at all (the service's
only DB use is its schema_migrations table). Putting the tokeniser in postgres
would put the database on the hot path of every turn's recall and add a THIRD
outcome to a route that is being made honest about the two it has: "the notes
held no answer" and "memory was down" would be joined by "the database that
tokenises the question was down", on a route whose whole point this slice is
that it must say which of those happened.

So the dependency stays what it was — none — and this module says so out loud:
it imports nothing but `re`, and the stemmer below is the classic Porter
algorithm, written out. It is not identical to snowball; it does not need to
be. What retrieval needs is that the SAME transformation is applied to the
question and to the notes, so "specs" in a question finds "spec" in a note, and
that is a property of applying one function twice.

WHY THE STOPWORD LIST IS A LIST

House rule: derived, never hardcoded — a check that reads a list somebody
maintains rots. It applies to the relevance floor (index.py derives that from
the live corpus every query, and it has no constant in it at all). It does not
apply here, and the difference is worth naming: the words below are English
function words. They are a fact about the language the questions are asked in,
not about this store, so nothing that happens to the notes can make this list
wrong. A df-derived list — "drop what appears in most documents" — WOULD move
with the store, and over eight documents it would also drop `nova`, `agent` and
`memory`, which are the subject rather than the filler.
"""

from __future__ import annotations

import re

_TOKEN_RE = re.compile(r"[a-z0-9]+")

# English function words: articles, pronouns, auxiliaries, prepositions,
# conjunctions, quantifiers, and the question openers a person actually says
# ("how much", "did I ever", "what kind of"), spelled out in the inflections
# people actually write, because the filter runs on the WRITTEN word — see
# analyze_positions for why it cannot run on the stem.
STOPWORDS: frozenset[str] = frozenset(
    """
    a about above after again against all also am an and another any anyone anything are aren
    as at back be because been before being below between both but by can cannot could couldn
    did didn do does doesn doing don down during each either else enough ever every everyone
    everything few for from further get got had hadn has hasn have haven having he her here
    hers herself him himself his how however i if in into is isn it its itself just kind lately
    let like ll m ma many may maybe me might mine more most much must mustn my myself need
    needn never no nor not now of off on once one only or other others ought our ours ourselves
    out over own please quite rather re really s same shan she should shouldn so some someone
    something still such t than that the their theirs them themselves then there these they
    thing things this those though through to too under until up us ve very was wasn we well
    were weren what whatever when where whether which while who whom whose why will with won
    would wouldn y you your yours yourself yourselves
    """.split()
)


def _is_consonant(word: str, i: int) -> bool:
    ch = word[i]
    if ch in "aeiou":
        return False
    if ch == "y":
        return i == 0 or not _is_consonant(word, i - 1)
    return True


def _measure(stem: str) -> int:
    """Porter's m: how many vowel-consonant sequences the stem is built from."""
    n = len(stem)
    i = 0
    while i < n and _is_consonant(stem, i):
        i += 1
    count = 0
    while i < n:
        while i < n and not _is_consonant(stem, i):
            i += 1
        if i >= n:
            break
        count += 1
        while i < n and _is_consonant(stem, i):
            i += 1
    return count


def _has_vowel(stem: str) -> bool:
    return any(not _is_consonant(stem, i) for i in range(len(stem)))


def _double_consonant(word: str) -> bool:
    return len(word) >= 2 and word[-1] == word[-2] and _is_consonant(word, len(word) - 1)


def _cvc(word: str) -> bool:
    """Ends consonant-vowel-consonant, the last one not w, x or y."""
    n = len(word)
    if n < 3:
        return False
    if not (
        _is_consonant(word, n - 3) and not _is_consonant(word, n - 2) and _is_consonant(word, n - 1)
    ):
        return False
    return word[-1] not in "wxy"


_STEP2 = (
    ("ational", "ate"),
    ("tional", "tion"),
    ("enci", "ence"),
    ("anci", "ance"),
    ("izer", "ize"),
    ("abli", "able"),
    ("alli", "al"),
    ("entli", "ent"),
    ("eli", "e"),
    ("ousli", "ous"),
    ("ization", "ize"),
    ("ation", "ate"),
    ("ator", "ate"),
    ("alism", "al"),
    ("iveness", "ive"),
    ("fulness", "ful"),
    ("ousness", "ous"),
    ("aliti", "al"),
    ("iviti", "ive"),
    ("biliti", "ble"),
)

_STEP3 = (
    ("icate", "ic"),
    ("ative", ""),
    ("alize", "al"),
    ("iciti", "ic"),
    ("ical", "ic"),
    ("ful", ""),
    ("ness", ""),
)

# Longest first, so "ement" is taken before "ment" and "ment" before "ent" —
# Porter considers exactly one step-4 suffix per word, the longest that fits.
# "ion" is not here: it carries an extra condition and is handled after.
_STEP4 = tuple(
    sorted(
        (
            "al",
            "ance",
            "ence",
            "er",
            "ic",
            "able",
            "ible",
            "ant",
            "ement",
            "ment",
            "ent",
            "ou",
            "ism",
            "ate",
            "iti",
            "ous",
            "ive",
            "ize",
        ),
        key=len,
        reverse=True,
    )
)


def stem(word: str) -> str:
    """Porter 1980, applied to an already-lowercased alphanumeric token.

    Short tokens and anything carrying a digit are returned untouched: "24gb",
    "8950" and "v3" are identifiers, and suffix-stripping an identifier only
    makes two different ones collide.
    """
    if len(word) <= 2 or any(ch.isdigit() for ch in word):
        return word

    # 1a
    if word.endswith("sses"):
        word = word[:-2]
    elif word.endswith("ies"):
        word = word[:-2]
    elif word.endswith("ss"):
        pass
    elif word.endswith("s"):
        word = word[:-1]

    # 1b
    if word.endswith("eed"):
        if _measure(word[:-3]) > 0:
            word = word[:-1]
    else:
        stripped = None
        if word.endswith("ed") and _has_vowel(word[:-2]):
            stripped = word[:-2]
        elif word.endswith("ing") and _has_vowel(word[:-3]):
            stripped = word[:-3]
        if stripped is not None:
            word = stripped
            if word.endswith(("at", "bl", "iz")):
                word += "e"
            elif _double_consonant(word) and not word.endswith(("l", "s", "z")):
                word = word[:-1]
            elif _measure(word) == 1 and _cvc(word):
                word += "e"

    # 1c
    if word.endswith("y") and _has_vowel(word[:-1]):
        word = word[:-1] + "i"

    # 2, 3: only when what is left is a real stem (m > 0)
    for suffix, replacement in _STEP2:
        if word.endswith(suffix) and _measure(word[: -len(suffix)]) > 0:
            word = word[: -len(suffix)] + replacement
            break
    for suffix, replacement in _STEP3:
        if word.endswith(suffix) and _measure(word[: -len(suffix)]) > 0:
            word = word[: -len(suffix)] + replacement
            break

    # 4: strip only from a stem that survives it (m > 1), one suffix per word
    for suffix in _STEP4:
        if word.endswith(suffix):
            if _measure(word[: -len(suffix)]) > 1:
                word = word[: -len(suffix)]
            break
    else:
        if word.endswith("ion") and word[-4:-3] in ("s", "t") and _measure(word[:-3]) > 1:
            word = word[:-3]

    # 5a, 5b
    if word.endswith("e"):
        m = _measure(word[:-1])
        if m > 1 or (m == 1 and not _cvc(word[:-1])):
            word = word[:-1]
    if _measure(word) > 1 and _double_consonant(word) and word.endswith("l"):
        word = word[:-1]
    return word


def analyze(text: str) -> list[str]:
    """Text -> the terms recall actually scores on. Applied to BOTH sides."""
    return [term for _pos, term in analyze_positions(text)]


def analyze_positions(text: str) -> list[tuple[int, str]]:
    """The same terms, each with the character offset of the raw token it came
    from — what the snippet scan needs to point at the right part of a note
    once the term it matched on no longer looks like the word on the page."""
    out: list[tuple[int, str]] = []
    for match in _TOKEN_RE.finditer(text.lower()):
        token = match.group(0)
        # Dropped BEFORE stemming, never after: "us" the pronoun and "use" the
        # verb share the stem "us", so a stopword filter applied to stems would
        # take the verb out of the index along with the pronoun. Filtering the
        # written word keeps the collision harmless — the pronoun never reaches
        # the index, and the verb keeps whatever stem it lands on.
        if token in STOPWORDS:
            continue
        out.append((match.start(), stem(token)))
    return out
