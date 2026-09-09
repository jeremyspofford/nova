"""BM25Index: tokenization, ranking, recency boost, snippet extraction.
Hand-rolled, in-process — a pure scoring engine with no filesystem
knowledge (callers hand it rel_path + metadata + text)."""

from __future__ import annotations

from datetime import date, timedelta

from app.index import SNIPPET_RADIUS, BM25Index, tokenize


def test_tokenize_drops_function_words_and_stems_the_rest():
    """S13: the analysis chain was `[a-z0-9]+` and nothing else, which is why
    "does" outscored the note that answered the question. It is now
    app/analysis.py — stopwords out, everything else stemmed — and the property
    that matters is that the SAME chain runs over the question and the note, so
    a plural in one finds a singular in the other."""
    # "over" is a function word and goes; the rest are lowercased and stemmed.
    assert tokenize("Coffee, Pour-Over & Tea!") == ["coffe", "pour", "tea"]
    # Ordinary question words carry no terms at all — which is what stops them
    # supplying the winning score.
    assert tokenize("how much does it have?") == []
    # The bridge: one written form in the question, another in the note.
    assert tokenize("my machines") == tokenize("the machine")
    assert tokenize("installing specs") == tokenize("installed spec")


def test_a_query_of_only_common_words_finds_nothing_and_says_so():
    idx = BM25Index()
    idx.upsert(
        "people/a/topics/coffee.md",
        title="Coffee",
        kind="topic",
        created=date.today(),
        body="Alice drinks pour-over coffee every morning.",
    )
    outcome = idx.search_detail("how much does it have?", scope_prefix="people/a/", k=5)
    assert outcome.hits == []
    assert "nothing searchable" in outcome.reason


def test_a_question_about_something_absent_returns_nothing_with_a_reason():
    """The relevance floor, derived: "cat" is a word these notes have never
    held, so it outweighs anything the question shares with them."""
    idx = BM25Index()
    idx.upsert(
        "people/a/journals/2026-09-09.md#10:00",
        title="Journal",
        kind="journal",
        created=date.today(),
        body="I did not mention anything important today.",
        document="people/a/journals/2026-09-09.md",
        fragment="10:00",
    )
    assert idx.search("mention", scope_prefix="people/a/", k=5)  # the word is there
    outcome = idx.search_detail("did I ever mention my cat?", scope_prefix="people/a/", k=5)
    assert outcome.hits == []
    assert "never contained" in outcome.reason


def test_one_partitions_documents_never_move_another_partitions_ranking():
    """avgdl and the document frequencies used to be averaged over every
    partition in the process, so an eval scratch account shifted Jeremy's
    results. Every statistic is now derived per scope, and this is the line
    that notices if that is ever undone: the same query over the same person's
    notes must score identically whether or not somebody else's are indexed."""

    def seed(idx):
        idx.upsert(
            "people/a/topics/coffee.md",
            title="Coffee",
            kind="topic",
            created=date.today(),
            body="Alice drinks pour-over coffee every single morning without fail.",
        )
        idx.upsert(
            "people/a/topics/tea.md",
            title="Tea",
            kind="topic",
            created=date.today(),
            body="Alice keeps a tin of loose leaf tea on the shelf.",
        )

    alone = BM25Index()
    seed(alone)
    crowded = BM25Index()
    seed(crowded)
    for i in range(40):
        crowded.upsert(
            f"people/scratch/topics/{i}.md",
            title="Eval scratch",
            kind="topic",
            created=date.today(),
            body="coffee " * (i + 1) + "eval scratch corpus padding text " * 20,
        )

    quiet = alone.search("pour-over coffee", scope_prefix="people/a/", k=5)
    loud = crowded.search("pour-over coffee", scope_prefix="people/a/", k=5)
    assert [h["path"] for h in quiet] == [h["path"] for h in loud]
    assert [round(h["score"], 9) for h in quiet] == [round(h["score"], 9) for h in loud]


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


def test_snippet_is_a_window_around_the_best_match_cut_at_word_boundaries():
    idx = BM25Index()
    padding = "filler word " * 400
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
    assert len(snippet) <= 2 * SNIPPET_RADIUS + 2  # the window, plus an ellipsis each end
    # Cut at word boundaries and marked as a cut: an excerpt sliced mid-word
    # reads to the model as a word the note does not contain.
    assert snippet.startswith("…") and snippet.endswith("…")
    assert "…word" not in snippet and "filler…" not in snippet


def test_a_journal_is_indexed_as_exchanges_and_forgotten_as_a_file():
    """Chunking is index-side only. Each '## HH:MM' exchange is its own unit
    with its own citable id, and removing the DOCUMENT removes all of them —
    /forget deletes a file, so the index must lose every span of it."""
    idx = BM25Index()
    document = "people/a/journals/2026-09-09.md"
    for fragment, body in (("10:00", "we talked about pour-over coffee"), ("11:00", "tea instead")):
        idx.upsert(
            f"{document}#{fragment}",
            title="Journal - 2026-09-09",
            kind="journal",
            created=date.today(),
            body=body,
            document=document,
            fragment=fragment,
        )
    (hit,) = idx.search("pour-over coffee", scope_prefix="people/a/", k=5)
    assert hit["path"] == f"{document}#10:00"
    assert hit["document"] == document and hit["fragment"] == "10:00"

    idx.remove(document)
    assert idx.units_for(document) == []
    assert idx.search("coffee", scope_prefix="people/a/", k=5) == []
    assert idx.search("tea", scope_prefix="people/a/", k=5) == []
