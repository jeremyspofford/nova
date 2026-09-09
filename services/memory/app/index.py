"""Hand-rolled BM25 index over memory documents, in-process only.

This is a pure scoring engine — it knows nothing about the filesystem or
person scoping. Callers (api.py) hand it a unit id + metadata + text on
upsert, and pass a scope_prefix on every search; it is the caller's job
to keep the index synced (upsert/remove on every store write/delete) and
to re-verify scope on the results it hands back (belt and suspenders —
see api.py).

Still deliberately small — no embeddings, no external search engine, no
runtime dependency of any kind — but no longer only "tokenizer + BM25 +
recency + a snippet window". S13 measured what recall was actually doing
(docs/plans/rebuild/slice-13-memory.md) and four things changed:

  * the UNIT is an exchange, not a file. api.py splits a journal at the
    "## HH:MM" headings the store writes and upserts each one under a
    citable id ("people/x/journals/2026-09-09.md#16:32"); this module
    keeps the document each unit came from, so `remove` still takes a
    file and drops all of it;
  * the analysis chain is app/analysis.py — stopwords and stemming —
    instead of `[a-z0-9]+`, which is why "does" used to outscore the
    note that answered the question;
  * every corpus statistic is derived PER SCOPE (see _Stats). They used
    to be process-wide, so one partition's notes moved another's ranking;
  * a search can now come back with nothing AND SAY WHY (see Outcome and
    the floor in search_detail). "The notes hold no answer" is a real
    answer, and it is the one recall could never give.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime

from app.analysis import analyze, analyze_positions

# BM25 constants (Task 5 brief, verbatim).
K1 = 1.5
B = 0.75

# Recency boost: final = bm25 * (1 + RECENCY_WEIGHT * exp(-age_days / RECENCY_DECAY_DAYS))
RECENCY_WEIGHT = 0.5
RECENCY_DECAY_DAYS = 30.0

# Excerpt window: SNIPPET_RADIUS chars on each side of the best-matching term
# run, so an excerpt is at most 2 * SNIPPET_RADIUS characters.
#
# It was 200 when a document was a whole day of conversation and the window was
# the only thing standing between the model and 21 KB of transcript. Now the
# indexed unit is one exchange, and the window's job has changed: it is a cap
# on a single exchange, and most exchanges are shorter than it, so a hit
# usually arrives whole rather than sliced.
#
# Sized by measuring, on the suite's corpus, what actually reaches the model.
# Answer-in-context against the excerpt each radius produces:
#
#   200 -> 7/20   (median excerpt 392 chars)
#   400 -> 7/20   (median 668)
#   800 -> 8/20   (median 917, mean 967, largest 1,600)
#  2000 -> 9/20   (mean 1,624, largest 3,997)
#  no cap -> 10/20 (mean 2,578, largest 10,255)
#
# 800 is where a typical exchange stops being cut in half; past it the curve
# keeps rising, and it is paid for in prompt: five hits at no cap is ~13 KB in
# front of the model on every turn, which is a bigger bill than the three extra
# answers are worth until distillation (S13-4) shortens what is being excerpted
# in the first place.
SNIPPET_RADIUS = 800


def tokenize(text: str) -> list[str]:
    """The terms this index scores on — see app/analysis.py.

    Kept as the name the rest of the service and its tests already call, so the
    analysis chain could be replaced in one place rather than in every caller.
    """
    return analyze(text)


def _coerce_date(value: object) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        return date.fromisoformat(value[:10])
    raise ValueError(f"unparseable created date: {value!r}")


@dataclass(frozen=True)
class Outcome:
    """A search's hits, and — when there are none — WHY there are none.

    "The notes hold no answer" and "the notes were never asked" are different
    facts about the world, and a bare empty list says neither of them. The
    reason is what /recall turns into a sentence the model can repeat.
    """

    hits: list[dict]
    reason: str | None


@dataclass
class _Doc:
    """One indexed UNIT — a journal exchange, or a whole note that has none.

    `unit_id` is what recall hands back and what a later slice cites: the
    document's rel_path, plus "#<fragment>" when the unit is one chunk of it.
    `document` is the file the unit came from, and it is what /forget removes
    by: the files on disk are still whole files, only the index is chunked.
    """

    unit_id: str
    document: str
    fragment: str | None
    title: str
    kind: str
    created: date
    text: str  # title + body — the one source both tokens and snippets come from
    term_freq: Counter
    length: int


@dataclass(frozen=True)
class _Stats:
    """The corpus statistics BM25 needs, for ONE scope.

    Every one of them used to be computed over every document in the process.
    That is a live bug, not a tidiness point: an eval scratch account's notes
    moved Jeremy's ranking, because his documents were scored against an
    average length and a document frequency that included somebody else's. A
    partition is a separate corpus and has to be scored as one.
    """

    n: int
    df: Counter
    avgdl: float


class BM25Index:
    def __init__(self) -> None:
        self._docs: dict[str, _Doc] = {}
        # Per-scope statistics, computed on demand and thrown away whole on any
        # write. A scope is asked for on nearly every request and the store
        # changes once per exchange, so in practice this is recomputed per
        # recall — and a cache that is only ever dropped, never patched, cannot
        # drift from the documents it describes, which incremental counters
        # (what this replaced) demonstrably could.
        #
        # The cost is linear in the scope: one pass over its units, one
        # increment per distinct term. Measured on the real corpus — 47 units
        # after twelve days of use — the whole suite's 50-odd recalls plus the
        # corpus build run in well under a second, against a 2,000 ms budget.
        # At a few thousand units it is still milliseconds; if a partition ever
        # reaches a size where it is not, the fix is to keep per-scope counters
        # and invalidate one scope at a time, not to go back to sharing them.
        self._stats: dict[str, _Stats] = {}

    def upsert(
        self,
        unit_id: str,
        *,
        title: str,
        kind: str,
        created: object,
        body: str,
        document: str | None = None,
        fragment: str | None = None,
    ) -> None:
        self.remove_unit(unit_id)
        text = f"{title}\n\n{body}"
        tf = Counter(tokenize(text))
        doc = _Doc(
            unit_id=unit_id,
            document=document or unit_id,
            fragment=fragment,
            title=title,
            kind=kind,
            created=_coerce_date(created),
            text=text,
            term_freq=tf,
            length=sum(tf.values()),
        )
        self._docs[unit_id] = doc
        self._stats.clear()

    def remove(self, document: str) -> None:
        """Drop a whole DOCUMENT — every unit chunked out of it.

        /forget deletes a file, so the index has to lose all of it. Removing
        one chunk id and leaving the others would leave recall citing spans of
        a file that is gone, which is the deletion reporting a success it did
        not achieve.
        """
        for unit_id in [uid for uid, doc in self._docs.items() if doc.document == document]:
            self.remove_unit(unit_id)

    def remove_unit(self, unit_id: str) -> None:
        if self._docs.pop(unit_id, None) is None:
            return
        self._stats.clear()

    def units_for(self, document: str) -> list[str]:
        """Every unit id currently indexed for one document.

        api.py re-indexes a journal on every append, and an exchange edited out
        by hand would otherwise stay in the index forever; this is how the
        caller knows what to retire.
        """
        return [uid for uid, doc in self._docs.items() if doc.document == document]

    def _scope_stats(self, scope_prefix: str) -> _Stats:
        """Document count, document frequencies and average length, over the
        documents in ONE scope."""
        cached = self._stats.get(scope_prefix)
        if cached is not None:
            return cached
        df: Counter = Counter()
        total = 0
        n = 0
        for unit_id, doc in self._docs.items():
            if not unit_id.startswith(scope_prefix):
                continue
            n += 1
            total += doc.length
            for term in doc.term_freq:
                df[term] += 1
        stats = _Stats(n=n, df=df, avgdl=(total / n if n else 0.0))
        self._stats[scope_prefix] = stats
        return stats

    def search(
        self, query: str, *, scope_prefix: str, k: int = 5, today: date | None = None
    ) -> list[dict]:
        """The hits alone. search_detail() is the same search with the reason
        attached, and /recall uses that — a caller that only wants the list
        cannot accidentally read "no hits" as "nothing matched"."""
        return self.search_detail(query, scope_prefix=scope_prefix, k=k, today=today).hits

    def search_detail(
        self, query: str, *, scope_prefix: str, k: int = 5, today: date | None = None
    ) -> Outcome:
        terms = tokenize(query)
        if not terms:
            return Outcome(
                hits=[],
                reason=(
                    "there was nothing searchable in the question — every word in it is one "
                    "of the ordinary ones this index does not score on"
                ),
            )
        stats = self._scope_stats(scope_prefix)
        today = today or datetime.now(UTC).date()
        # What the question is WORTH, term by term, in this scope: the same idf
        # the ranker uses, so the floor below is measured in the ranker's own
        # units and nothing has to be kept in step with anything.
        weights = {term: _idf(term, stats) for term in set(terms)}
        # THE FLOOR, derived per question from the live corpus.
        #
        # A note is an answer only if what it DID match is worth more than the
        # single biggest thing the question asked about that these notes have
        # never contained. Asked about a cat, "cat" is a word this person's
        # notes have never held, so it is the most informative term in the
        # question (see _idf); a note matching only "mention" is worth less
        # than that, and does not come back. Asked "where do I keep all my
        # projects", every word is one the notes use, the floor is zero, and
        # nothing is filtered — a corpus that has seen every word of a question
        # has no ignorance to declare.
        #
        # Every number in it is read from the corpus at query time: there is no
        # constant to tune and none to rot, and it moves on its own as the
        # notes do. It is the biggest UNSEEN term rather than the sum of them,
        # deliberately — a person's paraphrase ("my note taker", "how much
        # money have I burned") routinely contains a word the notes never use,
        # and summing them would refuse every conversationally-phrased question
        # in the suite. Measured: the sum costs five of the twenty answers,
        # the maximum costs two.
        #
        # Deliberately NOT applied to the recency-boosted score: recency
        # decides which of two answers is fresher and must never be able to
        # push a note that does not answer the question over the line.
        unseen = [weight for term, weight in weights.items() if stats.df.get(term, 0) == 0]
        floor = max(unseen, default=0.0)
        scored: list[tuple[float, _Doc]] = []
        matched_anything = False
        for rel_path, doc in self._docs.items():
            if not rel_path.startswith(scope_prefix):
                continue
            raw = self._bm25(terms, doc, stats)
            if raw <= 0:
                continue
            matched_anything = True
            covered = sum(weight for term, weight in weights.items() if doc.term_freq.get(term))
            if covered <= floor:
                continue
            boosted = raw * self._recency_multiplier(doc.created, today)
            scored.append((boosted, doc))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        if not scored:
            return Outcome(
                hits=[],
                reason=(
                    "what matched was worth less than the words in the question these notes "
                    "have never contained, so nothing here is an answer to it"
                    if matched_anything
                    else "nothing in these notes contains any of the words that were asked about"
                ),
            )
        top = scored[: max(k, 0)]
        if not top:
            # k of zero or less. Notes DID match; none were asked for. Saying
            # "the notes hold no answer" here would be a false statement about
            # the corpus produced by the caller's own argument.
            return Outcome(
                hits=[],
                reason=f"{len(scored)} note(s) matched, but none were asked for (k={k})",
            )
        return Outcome(
            hits=[
                {
                    # The citable id: the file, plus the exchange inside it.
                    "path": doc.unit_id,
                    # The file itself — what /forget deletes and what scope is
                    # re-checked against, never re-derived by splitting the id.
                    "document": doc.document,
                    "fragment": doc.fragment,
                    "title": doc.title,
                    "kind": doc.kind,
                    "created": doc.created.isoformat(),
                    "snippet": _snippet(doc.text, terms),
                    "score": score,
                }
                for score, doc in top
            ],
            reason=None,
        )

    @staticmethod
    def _bm25(terms: list[str], doc: _Doc, stats: _Stats) -> float:
        score = 0.0
        for term in set(terms):
            if stats.df.get(term, 0) == 0:
                continue
            tf = doc.term_freq.get(term, 0)
            if tf == 0:
                continue
            denom = tf + K1 * (1 - B + B * (doc.length / stats.avgdl if stats.avgdl else 1.0))
            score += _idf(term, stats) * (tf * (K1 + 1)) / denom
        return score

    @staticmethod
    def _recency_multiplier(created: date, today: date) -> float:
        age_days = max((today - created).days, 0)
        return 1 + RECENCY_WEIGHT * math.exp(-age_days / RECENCY_DECAY_DAYS)


def _idf(term: str, stats: _Stats) -> float:
    """How much this term tells you, in this scope.

    A term the corpus has NEVER seen gets the value the formula gives at df=0 —
    the largest it can produce — rather than being dropped as unscoreable. That
    is the honest reading: a word that appears nowhere in someone's notes is
    the strongest evidence there is that the notes do not hold the answer, and
    the floor in search_detail is what acts on it.
    """
    df = stats.df.get(term, 0)
    return math.log(1 + (stats.n - df + 0.5) / (df + 0.5))


def _snippet(text: str, terms: list[str]) -> str:
    """±SNIPPET_RADIUS chars around the best-matching token run: the
    hit position with the most other hits within SNIPPET_RADIUS chars of
    it, earliest position on ties.

    Positions come from the analyzer, not from a second regex here: the term
    that matched is a STEM, so "machin" has to be found at the offset of the
    word "machines" as it is written on the page.

    Both ends are pulled back to a whitespace boundary and marked with an
    ellipsis when the excerpt is a cut. The measurement found excerpts sliced
    mid-word, which reads to the model as a different word than the note
    contains — an excerpt that is a cut should say it is one.
    """
    term_set = set(terms)
    hits = [pos for pos, term in analyze_positions(text) if term in term_set]
    if not hits:
        return _trim(text, 0, min(len(text), SNIPPET_RADIUS * 2))
    best_start = hits[0]
    best_count = -1
    for center in hits:
        count = sum(1 for h in hits if abs(h - center) <= SNIPPET_RADIUS)
        if count > best_count:
            best_count = count
            best_start = center
    start = max(0, best_start - SNIPPET_RADIUS)
    end = min(len(text), best_start + SNIPPET_RADIUS)
    return _trim(text, start, end)


def _trim(text: str, start: int, end: int) -> str:
    """text[start:end], snapped off whole words, with "…" where it was cut."""
    if start > 0:
        space = text.find(" ", start)
        start = space + 1 if 0 <= space < end else start
    if end < len(text):
        space = text.rfind(" ", start, end)
        end = space if space > start else end
    excerpt = text[start:end].strip()
    if not excerpt:
        # Snapping to word boundaries ate the whole window (a very long
        # unbroken run). Hand back the raw slice rather than nothing: an empty
        # excerpt would put a hit in front of the model with no content in it.
        return text[start:end]
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    return f"{prefix}{excerpt}{suffix}"
