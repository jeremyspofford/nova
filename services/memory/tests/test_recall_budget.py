"""The question's embedding budget shrinks as the corpus grows, and says so.

MINOR 6 of the adversarial review, 2026-09-10.

core gives the whole of /recall 2.0 s. memory reserved a flat 0.4 s of it for
its own work and handed the rest to the embedding model — and ranking, the
biggest thing in that reserve, is linear in the scope. Measured on this box:
48 ms at 1,000 units, 267 ms at 5,000, 504 ms at 10,000. Past roughly 8,000
units the reserve is spent before the model is asked, so a working embedder
would be given time /recall had already used, core would time the call out at
2.0 s, and nothing anywhere would say the corpus size was the reason.

Two properties here, and neither is about a constant:

  * the reserve is DERIVED — the live unit count times what ranking one unit
    actually costs in THIS process (BM25Index.note_rank_seconds), never a
    number somebody maintains;
  * when the budget moves, /recall says so in the sentence a caller repeats.
    A search given less time than the deployment configured is a fact about
    that answer.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.api import _query_budget
from app.embedding import (
    CORE_RECALL_TIMEOUT,
    MIN_QUERY_BUDGET,
    RANK_SECONDS_PER_UNIT_SEED,
    RECALL_RESERVE,
    EmbedConfig,
)
from app.index import BM25Index

SCOPE = "people/a/"


def _index(units: int) -> BM25Index:
    idx = BM25Index()
    for n in range(units):
        idx.upsert(
            f"{SCOPE}topics/n{n}.md",
            title=f"Note {n}",
            kind="topic",
            created=date.today(),
            body=f"the body of note {n}",
        )
    return idx


@pytest.fixture
def config(monkeypatch) -> EmbedConfig:
    monkeypatch.setenv("MEMORY_EMBED_URL", "http://embedder.test")
    monkeypatch.delenv("MEMORY_EMBED_QUERY_TIMEOUT", raising=False)
    return EmbedConfig.from_env()


def test_a_small_corpus_gets_the_whole_configured_budget_and_says_nothing(config):
    """Today's shape, unchanged. 47 units of ranking disappears into the floor,
    so the number the deployment configured is the number the model gets and
    there is nothing to report."""
    budget, note = _query_budget(_index(47), SCOPE, config)
    assert budget == pytest.approx(config.query_timeout, abs=0.01)
    assert note is None


def test_the_budget_is_cut_by_the_measured_cost_of_ranking_this_scope(config):
    """DERIVED: the same five notes, with ranking measured at a cost that makes
    them expensive, get a smaller budget. Nothing here is a constant about
    corpus size — the index was told what a search of it actually cost."""
    idx = _index(5)
    small, quiet = _query_budget(idx, SCOPE, config)
    assert quiet is None

    # A search of these five units took half a second: 0.1 s a unit.
    idx.note_rank_seconds(SCOPE, 0.5)
    assert idx.rank_seconds_per_unit() == pytest.approx(0.1)
    budget, note = _query_budget(idx, SCOPE, config)
    assert budget == pytest.approx(CORE_RECALL_TIMEOUT - RECALL_RESERVE - 0.5, abs=1e-6)
    assert budget < small
    assert note and "1.10s" in note and "0.50s" in note and "5 note(s)" in note


def test_a_corpus_too_big_to_leave_the_model_any_time_is_stated_not_guessed(config):
    """The end of the curve. There is not enough of core's two seconds left to
    ask the model at all, so the model is NOT asked — and the semantic half
    reports a corpus-size limit rather than a timeout, which is a sentence
    about the wrong thing."""
    idx = _index(5)
    idx.note_rank_seconds(SCOPE, 9.0)
    budget, note = _query_budget(idx, SCOPE, config)
    assert budget is None
    assert note and "matched by its words alone" in note
    assert "corpus size and not of the notes" in note


def test_the_seed_is_used_until_a_search_has_been_timed_and_never_below_it(config):
    """A process that has not ranked anything yet still reserves for ranking,
    from the measured seed — and a measurement FASTER than the seed does not
    talk the reserve down below what the table says."""
    idx = _index(10)
    assert idx.rank_seconds_per_unit() is None
    seeded, _note = _query_budget(idx, SCOPE, config)
    idx.note_rank_seconds(SCOPE, 10 * RANK_SECONDS_PER_UNIT_SEED / 100)
    faster, _note = _query_budget(idx, SCOPE, config)
    assert faster == pytest.approx(seeded, abs=1e-9)


def test_a_slow_search_raises_the_reserve_at_once_and_lets_it_back_down_slowly(config):
    """Up instantly, down by fifths. A budget sized on the average is the
    budget that overruns; a budget held down for ever by one stalled search is
    a feature that never comes back."""
    idx = _index(4)
    idx.note_rank_seconds(SCOPE, 0.8)  # 0.2 s a unit
    assert idx.rank_seconds_per_unit() == pytest.approx(0.2)
    for _ in range(3):
        idx.note_rank_seconds(SCOPE, 0.0004)  # 0.0001 s a unit
    assert idx.rank_seconds_per_unit() < 0.2
    assert idx.rank_seconds_per_unit() > 0.0001


def test_the_budget_never_exceeds_what_the_deployment_configured(monkeypatch):
    """MEMORY_EMBED_QUERY_TIMEOUT is a ceiling. The derivation may only ever
    come in under it — a deployment that asked for less does not get more
    because its corpus is small."""
    monkeypatch.setenv("MEMORY_EMBED_URL", "http://embedder.test")
    monkeypatch.setenv("MEMORY_EMBED_QUERY_TIMEOUT", "0.5")
    config = EmbedConfig.from_env()
    budget, note = _query_budget(_index(2), SCOPE, config)
    assert budget == pytest.approx(0.5)
    assert note is None
    assert MIN_QUERY_BUDGET < 0.5
