"""Does the answer actually reach the model? The suite recall never had.

The roadmap said from S1 that "BM25 recall misses conversational phrasings".
Nobody measured it, so nobody fixed it, and the one number anybody could quote
— the right FILE is in the top five, 19 times in 20 — turned out to be nearly
meaningless: the store is eight documents and k is five, so chance alone scores
fourteen. The number that matters is different and much worse. It is measured
here, against a fixture corpus shaped like the real one (see recall_corpus.py),
so it is reproducible on a clean checkout instead of only on Jeremy's disk.

WHAT IS SCORED

  answer-in-context   for each of the twenty questions, did the TEXT that
                      answers it appear inside a snippet that came back — the
                      snippets composed exactly the way core composes them
                      before they go in front of the model
                      (services/core/app/chat.py::_snippets). This is the
                      number. Everything else is diagnosis.

  file-in-top-k       did a document that holds the answer come back at all.
                      Reported, never asserted: with eight documents and k=5
                      it mostly measures the size of the store, and the GAP
                      between it and answer-in-context is the finding.

  whole-store         answer-in-context with k set to the entire store. If
                      this is barely better than answer-in-context at k=5,
                      ranking is not the binding constraint and a better
                      ranker cannot fix it.

  absent-answer       six questions whose answer is genuinely nowhere in the
                      corpus, checked mechanically to be nowhere. How often
                      does recall hand back confident hits anyway? Decision 1
                      of this slice ("recall may return nothing, and says so")
                      is only real if this number exists.

FIDELITY, STATED RATHER THAN ASSUMED

The fixture reproduced the live failure in the aggregate, which is what made it
worth pinning: on the code as it stood when this suite landed, 6 of 20
answer-in-context against the live 6 of 20, 19 of 20 file-in-top-5 against 19,
7 of 20 with the whole store against 8, and per-file sizes within 14% of the
real ones (99% of the real corpus in total). (Those are the BEFORE numbers;
what the constants below hold now is the state after S13-2.) It does
NOT reproduce it case by case — the live run got the answer through on
Q01/Q02/Q04/Q05/Q15/Q20 and this one gets it through on
Q08/Q13/Q16/Q17/Q18/Q20 — because the prose is written for the fixture and
only the facts are his. Six is six for the same mechanical reasons, not
because the same six questions happen to win.

Per-case agreement is not claimed after S13-2 either, and could not be: the
mechanical work changes which questions win, in the fixture and on the live
corpus alike. The aggregate is the measurement.

One shape detail worth knowing before you read a per-case row: the newest
journal restates some earlier subjects, because it ends with a long pasted
review of the conversation, exactly as the real one does. It was checked
against the real file subject by subject — the real newest day repeats the
agent names, the machine name, the model and the money ceiling, and does NOT
repeat the hardware numbers, the workspace path, the reminders or the round
limit — and the fixture was corrected to match before the numbers below were
taken. So an answer can legitimately reach the model from a document that is
not a target, and answer-in-context counts it, which is what the live
measurement did too.

THE PINS

Two constants, both measured on the day this was written, both ratchets: a
regression fails the floor test, and an IMPROVEMENT fails the ratchet test
until somebody moves the constant and says in the commit by how much it moved.
That is the point — the previous number survived twelve slices precisely
because nothing was watching it.
"""

from __future__ import annotations

import asyncio
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import pytest
import recall_corpus as corpus
from httpx import ASGITransport, AsyncClient

from app.main import app

TOKEN = "recall-quality-token"
BASE_URL = "http://test"

# What core asks for on every turn: services/core/app/chat.py RECALL_K = 5.
# A different service, so it cannot be imported; if that constant moves, this
# one moves with it and the numbers below are re-measured.
K = 5

# ---------------------------------------------------------------------------
# THE PINNED NUMBERS.
#
# Measured 2026-09-09 at the head of slice/s13, before S13-2 (the state this
# suite was written to pin):
#
#   answer-in-context   6 of 20   (the live corpus measured 6 of 20)
#   absent-answer hits  6 of 6    (every question with no answer got five
#                                  confident hits, because recall had no way
#                                  to say it found nothing)
#   file-in-top-5      19 of 20   against 14.2 by chance — nearly meaningless
#   whole store         7 of 20   ranking is not the binding constraint
#
# Re-measured 2026-09-09 after S13-2, which is what the constants below now
# hold. Each step measured on its own, so the commit can say what bought what:
#
#   chunking the index at "## HH:MM"      6 -> 9   (whole store 7 -> 11)
#   stopwords + stemming                  9 -> 9   NO MOVEMENT on this number;
#                                                  it moved whole store 11 -> 12
#                                                  and absent hits 6/6 -> 5/6
#   the derived relevance floor           9 -> 7   and absent hits 5/6 -> 0/6
#   per-scope corpus statistics           7 -> 7   NO MOVEMENT (one partition in
#                                                  the fixture; it is a
#                                                  correctness fix, pinned by
#                                                  test_index.py instead)
#   excerpt window sized to an exchange   7 -> 8
#
#   answer-in-context   8 of 20
#   absent-answer hits  0 of 6
#
# Two reported and not pinned. Handing over the whole store now reaches 10 of
# 20 (was 7), so the ceiling the measurement found moved as well as the number
# under it. And file-in-top-5 FELL, 19 to 12, to just under the 12.9 that
# chance now scores — which is the floor working rather than a regression:
# three questions (Q04, Q08, Q13) now come back with nothing at all instead of
# five wrong notes, and a refusal counts as a file miss. It is also why that
# row is a diagnostic and never an assertion.
#
# Move a constant only with a measurement beside it, and say in the commit
# which way it went.
# ---------------------------------------------------------------------------
ANSWER_IN_CONTEXT_FLOOR = 8
ABSENT_ANSWER_HITS_CEILING = 0


@dataclass
class Result:
    case_id: str
    question: str
    answer_says: str
    returned: list[str] = field(default_factory=list)  # fixture keys, best first
    answer_rank: int | None = None  # 1-based rank of the first snippet holding it
    file_rank: int | None = None  # 1-based rank of the first target document
    whole_store_answer: bool = False


@dataclass
class AbsentResult:
    case_id: str
    question: str
    hits: int
    top_score: float | None


@dataclass
class Scorecard:
    results: list[Result]
    absent: list[AbsentResult]
    doc_count: int
    # What recall actually ranks. Eight documents, but S13 indexes a journal as
    # its "## HH:MM" exchanges, so the store is dozens of units — and "the whole
    # store" and "by chance" are statements about units, not files.
    units_by_key: dict[str, int] = field(default_factory=dict)

    @property
    def unit_count(self) -> int:
        return sum(self.units_by_key.values())

    @property
    def answer_in_context(self) -> int:
        return sum(1 for r in self.results if r.answer_rank is not None)

    @property
    def file_in_top_k(self) -> int:
        return sum(1 for r in self.results if r.file_rank is not None)

    @property
    def whole_store(self) -> int:
        return sum(1 for r in self.results if r.whole_store_answer)

    @property
    def absent_with_hits(self) -> int:
        return sum(1 for a in self.absent if a.hits > 0)

    @property
    def file_in_top_k_by_chance(self) -> float:
        """What "the right file is in the top k" scores with NO ranking at all.

        Derived from the live corpus — the number of UNITS recall ranks, k, and
        how many of those units belong to each question's target documents —
        never a remembered constant, because the day the store grows, or the
        day the indexing unit changes again, this number has to move on its own.
        """
        total = 0.0
        for result in self.results:
            targets = sum(self.units_by_key[key] for key in _case(result.case_id).targets)
            misses = self.unit_count - targets
            if misses < K:
                total += 1.0
                continue
            # P(at least one target unit in a random k-subset).
            total += 1.0 - math.comb(misses, K) / math.comb(self.unit_count, K)
        return total


def _case(case_id: str) -> corpus.Case:
    return next(c for c in corpus.CASES if c.id == case_id)


def _model_sees(hit: dict) -> str:
    """One hit as the model receives it.

    Mirrors services/core/app/chat.py::_snippets, which labels each hit with
    its title before handing it to the prompt. Scoring the raw snippet instead
    would measure something the model never sees.
    """
    body = hit.get("snippet") or ""
    label = hit.get("title") or hit.get("path") or ""
    return f"{label}: {body}" if label and body else (body or label)


def _document(path: str) -> str:
    """The document a hit belongs to.

    Chunked recall (S13-2) is expected to return ids like
    ".../2026-09-09.md#16:32"; the document is the part before the fragment, so
    file-level scoring keeps working across that change instead of silently
    reading zero the day chunk ids land.
    """
    return path.split("#", 1)[0]


async def _recall(client: AsyncClient, question: str, k: int) -> list[dict]:
    response = await client.post(
        "/recall",
        json={"query": question, "person_id": corpus.PERSON_ID, "k": k},
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    # A recall that failed must never be scored as a recall that found
    # nothing — "memory had nothing" and "memory was down" are different
    # facts, and a suite that averages them measures neither.
    if response.status_code != 200:
        raise AssertionError(
            f"/recall failed for {question!r}: HTTP {response.status_code} {response.text}"
        )
    body = response.json()
    # S13 made that distinction the route's own: the answer carries `found` and
    # a `statement` saying which nothing it is. Checked here on every one of the
    # 50-odd calls this suite makes, so a route that quietly went back to a bare
    # list — or to an empty result with no reason attached — fails here rather
    # than scoring as a corpus that holds nothing.
    if not isinstance(body, dict) or "hits" not in body:
        raise AssertionError(f"/recall answered without an envelope for {question!r}: {body!r}")
    hits = body["hits"]
    if bool(hits) != bool(body.get("found")):
        raise AssertionError(f"/recall disagreed with itself about `found` for {question!r}")
    if not hits and not str(body.get("statement", "")).strip():
        raise AssertionError(f"/recall found nothing for {question!r} and did not say why")
    return hits


async def _measure(rel_paths: dict[str, str], units_by_key: dict[str, int]) -> Scorecard:
    # Hits come back as rel paths whose journal names are rebased dates; the
    # report names fixture keys instead ("day-00"), so a run next year reads
    # the same as a run today.
    keys = {rel: key for key, rel in rel_paths.items()}
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE_URL) as client:
        results = []
        for case in corpus.CASES:
            hits = await _recall(client, case.question, K)
            targets = {rel_paths[key] for key in case.targets}
            answer = re.compile(case.answer, re.I)
            result = Result(
                case_id=case.id,
                question=case.question,
                answer_says=case.answer_says,
                returned=[keys[_document(h["path"])] for h in hits],
            )
            for rank, hit in enumerate(hits, 1):
                if result.answer_rank is None and answer.search(_model_sees(hit)):
                    result.answer_rank = rank
                if result.file_rank is None and _document(hit["path"]) in targets:
                    result.file_rank = rank
            # The same question with the WHOLE store handed over: if this is
            # no better, no ranker can fix it. k is the UNIT count, which is
            # what "everything" means to a chunked index — asking for the
            # document count would hand over eight of forty-odd exchanges and
            # quietly stop being the whole store.
            everything = await _recall(client, case.question, sum(units_by_key.values()))
            result.whole_store_answer = any(answer.search(_model_sees(h)) for h in everything)
            results.append(result)

        absent = []
        for case in corpus.ABSENT_CASES:
            hits = await _recall(client, case.question, K)
            absent.append(
                AbsentResult(
                    case_id=case.id,
                    question=case.question,
                    hits=len(hits),
                    top_score=round(float(hits[0]["score"]), 2) if hits else None,
                )
            )
    return Scorecard(
        results=results,
        absent=absent,
        doc_count=len(units_by_key),
        units_by_key=units_by_key,
    )


@pytest.fixture(scope="module")
def scorecard(tmp_path_factory) -> Scorecard:
    """Build the fixture corpus once, ask all twenty-six questions, score them.

    Module-scoped because building the store and the index is the expensive
    part and nothing here mutates it. The env is set with pytest's own
    MonkeyPatch context so MEMORY_ROOT and SERVICE_TOKEN are restored
    afterwards, exactly as the function-scoped monkeypatch does elsewhere in
    this suite.
    """
    root = Path(tmp_path_factory.mktemp("recall-quality")) / "root"
    rel_paths = corpus.build(root)
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("SERVICE_TOKEN", TOKEN)
        patch.setenv("MEMORY_ROOT", str(root))
        patch.delenv("DATABASE_URL", raising=False)
        doc_count = len(list(root.rglob("*.md")))
        # The shape is the diagnosis: eight documents, k=5. If the fixture
        # ever stops being eight documents the numbers below stop being
        # comparable to the baseline, and that must fail loudly here.
        expected = len(corpus.fixture_files())
        if doc_count != expected:
            raise AssertionError(f"fixture built {doc_count} documents, expected {expected}")
        return asyncio.run(_measure(rel_paths, corpus.units_by_key(root, rel_paths)))


# -- the corpus is what it claims to be ------------------------------------


def test_every_question_has_its_answer_in_a_target_document():
    """The measurement is worthless if the fact is not in the corpus.

    Checked against the fixture SOURCE text, per target document, so a case
    whose answer was edited out of the fixture fails here rather than quietly
    scoring zero for the rest of the slice.
    """
    files = corpus.fixture_files()
    for case in corpus.CASES:
        found_in = [
            key
            for key in case.targets
            if re.search(case.answer, files[key].read_text(encoding="utf-8"), re.I)
        ]
        assert found_in, (
            f"{case.id}: no target document contains {case.answer!r} "
            f"({case.answer_says}) — the fixture does not hold the answer it is asked for"
        )


def test_absent_questions_are_genuinely_unanswerable():
    """ "The answer is nowhere" is a checked property, not a claim."""
    text = corpus.fixture_text()
    for case in corpus.ABSENT_CASES:
        for pattern in case.forbidden:
            assert not re.search(pattern, text, re.I), (
                f"{case.id}: {pattern!r} appears in the corpus — "
                f"{case.question!r} is answerable and cannot score a false positive"
            )


def test_suite_still_asks_the_questions_the_baseline_measured():
    """The cases here are the twenty from recall_baseline_2026-09-09.json.

    Ids, question text and target documents are compared against the committed
    baseline — the fixture renames files by day offset, so the comparison goes
    through that translation rather than trusting either side. A case that
    drifts from the measurement it descends from is no longer the same
    measurement, and this is what refuses.
    """
    rows = {row["id"]: row for row in corpus.baseline_rows()}
    assert {c.id for c in corpus.CASES} == set(rows), "case ids differ from the baseline"
    for case in corpus.CASES:
        row = rows[case.id]
        assert case.question == row["q"], f"{case.id}: question text differs from the baseline"
        assert set(case.targets) == corpus.baseline_target_keys(row), (
            f"{case.id}: target documents differ from the baseline"
        )


# -- the pinned numbers -----------------------------------------------------


def test_answer_in_context_meets_the_pinned_floor(scorecard: Scorecard):
    """THE number: how often the text that answers the question reaches the
    model. A floor that only moves up."""
    assert scorecard.answer_in_context >= ANSWER_IN_CONTEXT_FLOOR, (
        f"answer-in-context fell to {scorecard.answer_in_context}/{len(corpus.CASES)}, "
        f"below the pinned floor of {ANSWER_IN_CONTEXT_FLOOR}. Recall got worse.\n\n"
        + report(scorecard)
    )


def test_answer_in_context_gain_must_move_the_pin(scorecard: Scorecard):
    """An improvement that nobody records is an improvement nobody can defend
    later. Raising the floor is one constant and one line in the commit."""
    assert scorecard.answer_in_context <= ANSWER_IN_CONTEXT_FLOOR, (
        f"answer-in-context is now {scorecard.answer_in_context}/{len(corpus.CASES)}, above the "
        f"pinned {ANSWER_IN_CONTEXT_FLOOR}. Raise ANSWER_IN_CONTEXT_FLOOR to "
        f"{scorecard.answer_in_context} and say in the commit what moved it.\n\n"
        + report(scorecard)
    )


def test_absent_answer_false_positives_stay_under_the_ceiling(scorecard: Scorecard):
    """The false-positive count: questions with no answer that got hits anyway.

    A ceiling that only moves down. Today every one of them comes back with a
    full set of hits, because recall has no way to say it found nothing — that
    is the behaviour decision 1 changes, and this is the line that will notice.
    """
    assert scorecard.absent_with_hits <= ABSENT_ANSWER_HITS_CEILING, (
        f"{scorecard.absent_with_hits}/{len(corpus.ABSENT_CASES)} unanswerable questions came "
        f"back with hits, above the pinned ceiling of {ABSENT_ANSWER_HITS_CEILING}. Recall got "
        f"more confident about things it does not know.\n\n" + report(scorecard)
    )


def test_absent_answer_gain_must_move_the_pin(scorecard: Scorecard):
    assert scorecard.absent_with_hits >= ABSENT_ANSWER_HITS_CEILING, (
        f"only {scorecard.absent_with_hits}/{len(corpus.ABSENT_CASES)} unanswerable questions "
        f"came back with hits, below the pinned {ABSENT_ANSWER_HITS_CEILING}. Lower "
        f"ABSENT_ANSWER_HITS_CEILING to {scorecard.absent_with_hits} and say so in the "
        f"commit.\n\n" + report(scorecard)
    )


# -- the diagnosis, reported beside the number ------------------------------


def test_report(scorecard: Scorecard, capsys):
    """Print the whole scorecard. Not an assertion — the run of this suite is
    where the next builder reads what moved and what did not (`pytest -s`, or
    any failure above, which carries the same table)."""
    with capsys.disabled():
        print("\n" + report(scorecard))


def report(scorecard: Scorecard) -> str:
    lines = [
        f"recall quality — {scorecard.doc_count} documents indexed as "
        f"{scorecard.unit_count} units, k={K}",
        "",
        f"{'case':5} {'answer@':8} {'file@':7} {'whole':6} {'top hit':14} question",
    ]
    for result in scorecard.results:
        lines.append(
            f"{result.case_id:5} "
            f"{('-' if result.answer_rank is None else str(result.answer_rank)):8} "
            f"{('-' if result.file_rank is None else str(result.file_rank)):7} "
            f"{('yes' if result.whole_store_answer else '-'):6} "
            f"{(result.returned[0] if result.returned else '-'):14} "
            f"{result.question}"
        )
    total = len(scorecard.results)
    refused = sum(1 for r in scorecard.results if not r.returned)
    lines += [
        "",
        f"answered with nothing  {refused}/{total}"
        "   (recall said the notes hold no answer, rather than guessing)",
        f"answer-in-context      {scorecard.answer_in_context}/{total}"
        f"   (pinned floor {ANSWER_IN_CONTEXT_FLOOR})",
        f"file-in-top-{K}          {scorecard.file_in_top_k}/{total}"
        f"   (by chance alone {scorecard.file_in_top_k_by_chance:.1f}/{total} — "
        "reported, never asserted)",
        f"answer, whole store    {scorecard.whole_store}/{total}"
        "   (if this is no better, ranking is not the constraint)",
        "",
        f"{'case':5} {'hits':5} {'top score':10} question with no answer in the corpus",
    ]
    for absent in scorecard.absent:
        lines.append(
            f"{absent.case_id:5} {absent.hits:<5} "
            f"{('-' if absent.top_score is None else str(absent.top_score)):10} {absent.question}"
        )
    lines.append("")
    lines.append(
        f"absent-answer hits     {scorecard.absent_with_hits}/{len(scorecard.absent)}"
        f"   (pinned ceiling {ABSENT_ANSWER_HITS_CEILING})"
    )
    return "\n".join(lines)
