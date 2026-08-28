"""BM25Index: tokenization, ranking, recency boost, snippet extraction.
Hand-rolled, in-process — a pure scoring engine with no filesystem
knowledge (callers hand it rel_path + metadata + text)."""
from __future__ import annotations

from datetime import date, timedelta

from app.index import BM25Index, tokenize


def test_tokenize_lowercases_and_splits_on_alnum_runs():
    assert tokenize("Coffee, Pour-Over & Tea!") == ["coffee", "pour", "over", "tea"]


def test_exact_term_doc_outscores_unrelated_doc():
    idx = BM25Index()
    idx.upsert(
        "people/a/topics/coffee.md",
        title="Coffee preferences",
        kind="topic",
        created=date.today(),
        body="Alice drinks pour-over coffee every morning without fail.",
    )
    idx.upsert(
        "people/a/topics/weather.md",
        title="Weather notes",
        kind="topic",
        created=date.today(),
        body="It rained heavily in Seattle for most of the week.",
    )
    results = idx.search("coffee", scope_prefix="people/a/", k=5)
    assert results
    assert results[0]["path"] == "people/a/topics/coffee.md"


def test_recency_boost_same_text_new_created_wins(monkeypatch):
    idx = BM25Index()
    today = date(2026, 8, 27)
    old_created = today - timedelta(days=365)
    idx.upsert(
        "people/a/topics/old.md",
        title="Coffee note",
        kind="topic",
        created=old_created,
        body="Alice likes pour-over coffee brewed slowly each day.",
    )
    idx.upsert(
        "people/a/topics/new.md",
        title="Coffee note",
        kind="topic",
        created=today,
        body="Alice likes pour-over coffee brewed slowly each day.",
    )
    results = idx.search("coffee", scope_prefix="people/a/", k=5, today=today)
    assert [r["path"] for r in results] == ["people/a/topics/new.md", "people/a/topics/old.md"]
    assert results[0]["score"] > results[1]["score"]


def test_search_scope_prefix_excludes_other_people():
    idx = BM25Index()
    idx.upsert(
        "people/a/topics/coffee.md",
        title="Coffee",
        kind="topic",
        created=date.today(),
        body="a secret coffee blend recipe",
    )
    idx.upsert(
        "people/b/topics/coffee.md",
        title="Coffee",
        kind="topic",
        created=date.today(),
        body="a secret coffee blend recipe",
    )
    results = idx.search("secret coffee blend", scope_prefix="people/a/", k=5)
    assert [r["path"] for r in results] == ["people/a/topics/coffee.md"]


def test_remove_drops_doc_from_results():
    idx = BM25Index()
    idx.upsert(
        "people/a/topics/coffee.md",
        title="Coffee",
        kind="topic",
        created=date.today(),
        body="pour-over coffee notes",
    )
    idx.remove("people/a/topics/coffee.md")
    results = idx.search("coffee", scope_prefix="people/a/", k=5)
    assert results == []


def test_snippet_is_roughly_400_chars_around_best_match():
    idx = BM25Index()
    padding = "filler word " * 100
    body = f"{padding}the target phrase pour-over coffee sits here {padding}"
    idx.upsert(
        "people/a/topics/coffee.md",
        title="Notes",
        kind="topic",
        created=date.today(),
        body=body,
    )
    results = idx.search("pour-over coffee", scope_prefix="people/a/", k=5)
    assert results
    snippet = results[0]["snippet"]
    assert "pour-over coffee" in snippet
    assert len(snippet) <= 420
