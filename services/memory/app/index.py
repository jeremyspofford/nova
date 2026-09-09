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
from app.embedding import digest_of, dot

# BM25 constants (Task 5 brief, verbatim).
K1 = 1.5
B = 0.75

# -- the semantic half (S13-5) ---------------------------------------------
#
# BM25 is kept, and kept as an equal, because the two retrievers fail in
# opposite directions. BM25 is the one that wins on an exact token — a file
# path, DELL-XPS-8950, qwen3:27b, $0.0005 — where an embedder is vague and
# will happily rank a paragraph about a different machine alongside the right
# one. The embedder is the one that wins where the word is simply not in the
# note: "graphics memory" against VRAM, "short poem about the cold season"
# against a haiku about winter, "money burned through" against spend. Neither
# subsumes the other, so the answer is a fusion and not a replacement.

# RECIPROCAL RANK FUSION, and why it is not a weighted sum.
#
# A BM25 score is an unbounded sum of idf terms; a cosine is a number in
# [-1, 1] whose useful range for one embedder is perhaps [0.4, 0.9]. Adding
# them requires normalising two distributions that move independently — with
# the corpus, with the question, and with whichever embedding model is
# configured — and every normalisation anybody actually ships (min-max over
# the returned window, z-scores over the candidates) is unstable exactly where
# it matters, at the top of a short list. RRF (Cormack, Clarke & Buettcher
# 2009) throws the scores away and fuses the RANKS: a unit's score is the sum
# over retrievers of 1/(RRF_K + rank). It needs no normalisation, no weight
# per retriever, and no knowledge of either scale, which is why it is the
# fusion this ships with. 60 is the constant from that paper and the one every
# implementation since has used; it is a damping term, and what it buys is
# that agreement between the two lists beats a single list's top hit.
RRF_K = 60

# THE SEMANTIC FLOOR, and why it is not a similarity threshold.
#
# An embedder always has a nearest neighbour. Ask "did I ever mention my cat"
# of notes with no cat in them and cosine will still order all 47 chunks and
# put something first — so without a floor of its own, semantic recall takes
# the absent-answer count straight from 0/6 back to 6/6 and undoes the one
# decision this slice was built around. That is measured, not feared: with no
# semantic floor the suite scores 15/20 answer-in-context and 6/6 confident
# answers to questions with no answer.
#
# The first floor tried was the shape every retrieval paper reaches for — a
# hit must be an OUTLIER of this query's similarity distribution, above
# mean + z standard deviations. It does not work, and the measurement says
# why in one line: the top hit's z-score for the twenty answerable questions
# is 1.48 to 4.40, and for the six unanswerable ones it is 1.76 to 2.98. The
# distributions overlap almost completely, because the SHAPE of a similarity
# distribution says nothing about whether the corpus holds the answer — every
# z from 0.5 to 1.45 scored 15-16/20 with 6/6 false positives, and every z
# above it lost the answers and the false positives together.
#
# What does separate them is scale, and the corpus supplies its own. The mean
# similarity between two DIFFERENT notes in this scope is what "related, in
# the way everything this person writes is related" measures on this
# embedder: 0.598 on the fixture corpus. Against that line the twenty
# answerable questions' best hits run 0.471 to 0.700 and the six unanswerable
# ones run 0.452 to 0.551 — every absent question falls below it and nine of
# the answerable ones clear it, including all three the mechanical work left
# with nothing (graphics memory / VRAM, the repeating nudge / the blink
# reminder, the cold-season poem / the winter haiku).
#
# So: a unit is a semantic candidate when the question is MORE like it than
# two of these notes are like each other. There is no similarity constant in
# that sentence. The number it compares against is read from the live corpus
# on every query, moves on its own as the notes change, and is in the
# embedder's own units — point this deployment at a different model tomorrow
# and the line moves with it, because both sides of the comparison come from
# the same model. A corpus that is all one subject raises its own bar; a
# varied one lowers it, which is the right direction: in a varied corpus a
# given resemblance means more.
#
# Computed in O(n·d), not O(n²·d): every vector is unit length, so the mean
# over ordered pairs i≠j of <vi,vj> is (‖Σv‖² − n) / (n(n−1)), one sum and
# one dot product. See _background.

# Below this many embedded units in a scope there is no "how alike are two of
# these notes" to speak of — the mean over one pair is that pair — so
# semantic recall states that it did not run rather than thresholding noise.
# A store this small is also one where BM25 over everything is already
# handing over most of it.
SEMANTIC_MIN_SAMPLE = 3

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
class RetrieverReport:
    """WHICH searches actually ran, and what each one found.

    This is the mechanical half of the honesty rule for hybrid recall. A
    recall answered by word matching alone, because the embedding model was
    never pulled or the inference container is down, must not be
    indistinguishable from a recall that had both. `ran` is a fact about this
    call — not about configuration, not about intent — and when it is False,
    `reason` is the finished sentence saying which unavailability it was.

    `ranked` is how many units this retriever put forward BEFORE fusion and
    before k. It is a count, never a score: no similarity, and nothing that
    could be read as a confidence, leaves this service.
    """

    name: str
    ran: bool
    ranked: int = 0
    reason: str | None = None
    # "12 of 47 notes in this scope have been embedded" — stated whenever the
    # semantic retriever ran over less than the whole scope, because ranking
    # part of a corpus and ranking all of it are different searches.
    coverage: str | None = None


@dataclass(frozen=True)
class Outcome:
    """A search's hits, WHICH retrievers produced them, and — when there are
    none — WHY there are none.

    "The notes hold no answer" and "the notes were never asked" are different
    facts about the world, and a bare empty list says neither of them. The
    reason is what /recall turns into a sentence the model can repeat.
    """

    hits: list[dict]
    reason: str | None
    retrievers: tuple[RetrieverReport, ...] = ()


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
    # The cache key for this unit's vector: a hash of `text`. Held on the unit
    # so that re-indexing a journal (which re-reads and re-upserts every
    # exchange in it on every append) costs an embedding call only for the
    # exchange whose text actually changed.
    digest: str = ""


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
        # digest -> unit vector. Keyed by the hash of the text rather than by
        # the unit id, so an exchange that is re-indexed unchanged, or a note
        # saved again under a new name, keeps the vector that was already paid
        # for. Filled by set_vector() from the cache at startup and from the
        # embedder on the write paths; empty until then, and recall says so.
        self._vectors: dict[str, list[float]] = {}
        # Per-scope "how alike are two of these notes", the semantic floor.
        # Dropped whole on any change to the units or their vectors, for the
        # same reason _stats is (see above): a cache that is only ever
        # discarded cannot describe a corpus it no longer matches.
        self._background: dict[str, float | None] = {}

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
            digest=digest_of(text),
        )
        self._docs[unit_id] = doc
        self._stats.clear()
        self._background.clear()

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
        self._background.clear()

    def units_for(self, document: str) -> list[str]:
        """Every unit id currently indexed for one document.

        api.py re-indexes a journal on every append, and an exchange edited out
        by hand would otherwise stay in the index forever; this is how the
        caller knows what to retire.
        """
        return [uid for uid, doc in self._docs.items() if doc.document == document]

    # -- vectors ---------------------------------------------------------

    def set_vector(self, digest: str, vector: list[float]) -> None:
        """Attach one embedded vector, by text hash."""
        self._vectors[digest] = vector
        self._background.clear()

    def has_vector(self, digest: str) -> bool:
        return digest in self._vectors

    def live_digests(self) -> set[str]:
        """Every text hash currently indexed — what the caches may keep."""
        return {doc.digest for doc in self._docs.values()}

    def retain_vectors(self, live: set[str]) -> int:
        """Drop in-process vectors for text that is no longer indexed.

        A forgotten note or an edited exchange leaves its vector behind
        otherwise, and at 768 float32 per vector a year of edits is real
        memory held for text nothing can ever return. Returns how many went.
        """
        stale = [digest for digest in self._vectors if digest not in live]
        for digest in stale:
            del self._vectors[digest]
        if stale:
            self._background.clear()
        return len(stale)

    def missing_vectors(self, scope_prefix: str = "") -> list[tuple[str, str]]:
        """(digest, text) for every indexed unit in scope with no vector yet.

        De-duplicated by digest: two identical exchanges are one embedding
        call, not two.
        """
        missing: dict[str, str] = {}
        for unit_id, doc in self._docs.items():
            if scope_prefix and not unit_id.startswith(scope_prefix):
                continue
            if doc.digest in self._vectors or doc.digest in missing:
                continue
            missing[doc.digest] = doc.text
        return list(missing.items())

    def vector_coverage(self, scope_prefix: str) -> tuple[int, int]:
        """(units with a vector, units) for one scope — the honest denominator
        behind "semantic recall ran over 12 of 47 notes"."""
        have = 0
        total = 0
        for unit_id, doc in self._docs.items():
            if not unit_id.startswith(scope_prefix):
                continue
            total += 1
            if doc.digest in self._vectors:
                have += 1
        return have, total

    def _background_similarity(
        self, scope_prefix: str, sims: list[tuple[float, _Doc]]
    ) -> float | None:
        """How alike two DIFFERENT notes in this scope are, on average.

        The semantic floor (see the comment on SEMANTIC_MIN_SAMPLE above). Not
        an approximation: every vector is unit length, so

            mean over i != j of <vi, vj>  =  (‖Σv‖² − n) / (n(n − 1))

        which is one vector sum and one dot product — O(n·d), the same order
        as the search itself, rather than the O(n²·d) the definition suggests.
        Cached per scope and dropped on any write, because it describes the
        corpus and the corpus is what changes.

        None when the scope holds too few embedded notes to have a "between
        two of them" at all.
        """
        cached = self._background.get(scope_prefix, ...)
        if cached is not ...:
            return cached
        vectors = [self._vectors[doc.digest] for _value, doc in sims]
        n = len(vectors)
        if n < SEMANTIC_MIN_SAMPLE:
            self._background[scope_prefix] = None
            return None
        width = len(vectors[0])
        total = [0.0] * width
        for vector in vectors:
            for i, value in enumerate(vector):
                total[i] += value
        mass = sum(value * value for value in total)
        background = (mass - n) / (n * (n - 1))
        self._background[scope_prefix] = background
        return background

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
        and the retriever report attached, and /recall uses that — a caller
        that only wants the list cannot accidentally read "no hits" as
        "nothing matched", nor a lexical-only answer as a hybrid one."""
        return self.search_detail(query, scope_prefix=scope_prefix, k=k, today=today).hits

    def search_detail(
        self,
        query: str,
        *,
        scope_prefix: str,
        k: int = 5,
        today: date | None = None,
        query_vector: list[float] | None = None,
        semantic_unavailable: str | None = None,
    ) -> Outcome:
        """Both retrievers, fused, with a report of which of them ran.

        `query_vector` is the embedded question when the caller could get one;
        `semantic_unavailable` is the finished sentence when it could not.
        Exactly one of them is meaningful, and passing NEITHER is itself a
        stated state ("semantic recall was not asked for on this call") rather
        than a silent lexical answer — this method has no way to pretend a
        search happened.
        """
        scope = [doc for unit_id, doc in self._docs.items() if unit_id.startswith(scope_prefix)]
        today = today or datetime.now(UTC).date()

        lexical, lexical_report, lexical_reason = self._lexical(query, scope, scope_prefix, today)
        semantic, semantic_report, semantic_reason = self._semantic(
            query_vector, scope, scope_prefix, semantic_unavailable
        )
        reports = (lexical_report, semantic_report)

        if not lexical and not semantic:
            return Outcome(
                hits=[], reason=_merge_reasons(lexical_reason, semantic_reason), retrievers=reports
            )

        fused = _fuse(lexical, semantic)
        top = fused[: max(k, 0)]
        if not top:
            # k of zero or less. Notes DID rank; none were asked for. Saying
            # "the notes hold no answer" here would be a false statement about
            # the corpus produced by the caller's own argument.
            return Outcome(
                hits=[],
                reason=f"{len(fused)} note(s) matched, but none were asked for (k={k})",
                retrievers=reports,
            )
        terms = tokenize(query)
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
                    # The fused RANK score. An ordering key and nothing else:
                    # it is not a similarity, not a probability, and never to
                    # be shown to the model or the owner as a confidence.
                    "score": score,
                    # Which retrievers put this unit forward. A fact about how
                    # it was found, which is what lets a caller tell a note
                    # matched word for word from one matched by meaning alone.
                    "retrievers": names,
                }
                for score, names, doc in top
            ],
            reason=None,
            retrievers=reports,
        )

    # -- the two retrievers ----------------------------------------------

    def _lexical(
        self, query: str, scope: list[_Doc], scope_prefix: str, today: date
    ) -> tuple[list[_Doc], RetrieverReport, str | None]:
        """BM25 over the scope, recency-boosted, above the derived floor.

        Returns the units in rank order — the SCORES do not leave this method,
        because fusion is over ranks (see RRF_K) and a BM25 score on its own
        means nothing outside the query that produced it.
        """
        terms = tokenize(query)
        if not terms:
            return (
                [],
                RetrieverReport(
                    name="lexical",
                    ran=False,
                    reason="the question has no searchable "
                    "words in it — every word is one of the ordinary ones this index "
                    "does not score on",
                ),
                "there was nothing searchable in the question — every word in it is one "
                "of the ordinary ones this index does not score on",
            )
        stats = self._scope_stats(scope_prefix)
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
        for doc in scope:
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
        ranked = [doc for _score, doc in scored]
        reason = None
        if not ranked:
            reason = (
                "what matched was worth less than the words in the question these notes "
                "have never contained, so nothing here is an answer to it"
                if matched_anything
                else "nothing in these notes contains any of the words that were asked about"
            )
        return ranked, RetrieverReport(name="lexical", ran=True, ranked=len(ranked)), reason

    def _semantic(
        self,
        query_vector: list[float] | None,
        scope: list[_Doc],
        scope_prefix: str,
        unavailable: str | None,
    ) -> tuple[list[_Doc], RetrieverReport, str | None]:
        """Cosine over the embedded units in scope, above the derived outlier
        floor (see the comment above SEMANTIC_MIN_SAMPLE).

        Every path that produces no ranking says which one it was. There is
        deliberately no branch here that returns an empty list with `ran` True
        and no reason: that is the shape of the silent degradation this whole
        module exists to make impossible.
        """
        if query_vector is None:
            reason = unavailable or (
                "semantic search was not asked for on this call, so the question was matched "
                "by its words alone"
            )
            return [], RetrieverReport(name="semantic", ran=False, reason=reason), None
        sims: list[tuple[float, _Doc]] = []
        for doc in scope:
            vector = self._vectors.get(doc.digest)
            if vector is None:
                continue
            sims.append((dot(query_vector, vector), doc))
        have, total = len(sims), len(scope)
        coverage = None if have == total else f"{have} of {total} notes in this scope are embedded"
        # ONE gate, and it is the floor's own: below SEMANTIC_MIN_SAMPLE
        # embedded notes there is no "how alike are two of these" to measure
        # a resemblance against, so the retriever says it did not run rather
        # than ranking on a threshold it could not derive.
        floor = self._background_similarity(scope_prefix, sims)
        if floor is None:
            return (
                [],
                RetrieverReport(
                    name="semantic",
                    ran=False,
                    reason=(
                        f"only {have} of {total} notes in this scope have been embedded so far — "
                        "too few to tell a real resemblance from the ordinary resemblance "
                        "between any two of these notes"
                    ),
                    coverage=coverage,
                ),
                None,
            )
        candidates = [(value, doc) for value, doc in sims if value > floor]
        candidates.sort(key=lambda pair: pair[0], reverse=True)
        ranked = [doc for _value, doc in candidates]
        reason = None
        if not ranked:
            reason = (
                "nothing in these notes is about that either — no note resembles the question "
                "more than these notes resemble each other, which is what a corpus that has "
                "not seen the subject looks like"
            )
        return (
            ranked,
            RetrieverReport(name="semantic", ran=True, ranked=len(ranked), coverage=coverage),
            reason,
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


def _fuse(lexical: list[_Doc], semantic: list[_Doc]) -> list[tuple[float, list[str], _Doc]]:
    """Reciprocal rank fusion of the two ranked lists.

    score(unit) = sum over the retrievers that ranked it of 1 / (RRF_K + rank).
    Nothing is normalised and nothing is weighted, because neither retriever's
    score is on a scale the other's can be compared to — see RRF_K. A unit
    both lists rank beats a unit only one of them ranks unless the single list
    put it a long way higher, which is the behaviour that makes the fusion
    worth having: agreement is evidence.

    Ties are broken by lexical rank and then by unit id, so the order is
    total and a run is reproducible.
    """
    scores: dict[str, float] = {}
    names: dict[str, list[str]] = {}
    docs: dict[str, _Doc] = {}
    lexical_rank: dict[str, int] = {}
    for retriever, ranking in (("lexical", lexical), ("semantic", semantic)):
        for rank, doc in enumerate(ranking, 1):
            scores[doc.unit_id] = scores.get(doc.unit_id, 0.0) + 1.0 / (RRF_K + rank)
            names.setdefault(doc.unit_id, []).append(retriever)
            docs[doc.unit_id] = doc
            if retriever == "lexical":
                lexical_rank[doc.unit_id] = rank
    order = sorted(
        docs,
        key=lambda unit_id: (
            -scores[unit_id],
            lexical_rank.get(unit_id, len(lexical) + 1),
            unit_id,
        ),
    )
    return [(scores[unit_id], names[unit_id], docs[unit_id]) for unit_id in order]


def _merge_reasons(lexical: str | None, semantic: str | None) -> str:
    """One sentence for "nothing came back", naming both retrievers when both
    looked and neither found anything.

    The lexical reason alone used to be the whole story; with a second
    retriever it would be a half-truth — and the half it leaves out is
    precisely whether the meaning search happened at all.
    """
    parts = [reason for reason in (lexical, semantic) if reason]
    if not parts:
        return "nothing in these notes ranked for that question"
    return "; and ".join(parts)


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
