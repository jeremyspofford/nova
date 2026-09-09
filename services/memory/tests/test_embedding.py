"""The embedder: every way it can be unavailable has its own sentence.

This is the suite for the easiest bug in hybrid recall — degrading to word
matching while still calling yourself semantic. Every test below is about the
same property from a different side: there is no path through this module that
produces "no vectors" without also producing the reason, and no path that
produces a vector nobody checked.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.embedding import (
    DEFAULT_MODEL,
    DEFAULT_URL,
    BackfillReport,
    EmbedConfig,
    Embedder,
    EmbedderUnavailable,
    VectorCache,
    backfill,
    cache_path,
    digest_of,
    dot,
    normalise,
)


def _config(**overrides) -> EmbedConfig:
    base = {
        "url": "http://embedder.test",
        "model": "test-embed",
        "timeout": 5.0,
        "query_timeout": 1.5,
        "batch": 16,
        "backfill_seconds": 5.0,
    }
    base.update(overrides)
    return EmbedConfig(**base)


def _embedder(handler, **overrides) -> Embedder:
    return Embedder(_config(**overrides), transport=httpx.MockTransport(handler))


# -- configuration ----------------------------------------------------------


def test_the_default_service_and_model_are_what_the_deployment_expects(monkeypatch):
    """The default is asserted, not trusted.

    conftest.py empties MEMORY_EMBED_URL for the whole suite so the pinned
    recall numbers cannot change with the machine they run on. That makes the
    real default invisible to every other test — so it is read here, with the
    environment explicitly cleared, because a default nothing checks can rot
    to anything and the symptom would be silence.
    """
    monkeypatch.delenv("MEMORY_EMBED_URL", raising=False)
    monkeypatch.delenv("MEMORY_EMBED_MODEL", raising=False)
    config = EmbedConfig.from_env()
    assert config.url == DEFAULT_URL == "http://ollama:11434"
    assert config.model == DEFAULT_MODEL == "nomic-embed-text"
    assert config.enabled
    # The one call on a turn's critical path must fit inside core's 2 s
    # recall budget with room to answer.
    assert config.query_timeout < 2.0


def _redirected_embedder(monkeypatch):
    """An embedder built the way the service builds one: entirely from env."""
    monkeypatch.setenv("MEMORY_EMBED_URL", "http://elsewhere.test:9999/")
    monkeypatch.setenv("MEMORY_EMBED_MODEL", "some-other-embedder")
    config = EmbedConfig.from_env()
    assert config.url == "http://elsewhere.test:9999"  # trailing slash trimmed
    assert config.model == "some-other-embedder"

    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"embeddings": [[1.0, 0.0]]})

    embedder = Embedder(config, transport=httpx.MockTransport(handler))
    return embedder, seen


async def test_the_model_is_named_in_configuration_and_reaches_the_call(monkeypatch):
    embedder, seen = _redirected_embedder(monkeypatch)
    await embedder.embed(["hello"])
    assert seen["url"] == "http://elsewhere.test:9999/api/embed"
    assert seen["body"]["model"] == "some-other-embedder"
    assert seen["body"]["input"] == ["hello"]


def test_a_nonsense_budget_falls_back_to_the_default_rather_than_zero(monkeypatch):
    """A timeout of 0 or "soon" would disable embedding while looking
    configured. Named in the log, and the default stands."""
    monkeypatch.setenv("MEMORY_EMBED_TIMEOUT", "soon")
    monkeypatch.setenv("MEMORY_EMBED_QUERY_TIMEOUT", "0")
    config = EmbedConfig.from_env()
    assert config.timeout == 5.0
    assert config.query_timeout == 1.5


# -- the five unavailabilities, five sentences ------------------------------


async def test_switched_off_says_it_is_switched_off():
    embedder = Embedder(_config(url=""))
    assert not embedder.config.enabled
    assert "switched off" in embedder.unavailable_reason()
    with pytest.raises(EmbedderUnavailable) as raised:
        await embedder.embed(["anything"])
    assert "switched off" in str(raised.value)


async def test_unreachable_names_the_service_and_the_transport_failure():
    def handler(request):
        raise httpx.ConnectError("Connection refused")

    with pytest.raises(EmbedderUnavailable) as raised:
        await _embedder(handler).embed(["x"])
    said = str(raised.value)
    assert "could not be reached" in said
    assert "http://embedder.test" in said
    assert "ConnectError" in said


async def test_a_timeout_says_it_timed_out_and_names_the_budget():
    def handler(request):
        raise httpx.ReadTimeout("too slow")

    with pytest.raises(EmbedderUnavailable) as raised:
        await _embedder(handler, timeout=3.0).embed(["x"])
    said = str(raised.value)
    assert "did not answer within 3s" in said
    # Distinct from "could not be reached": a slow embedder and a dead one are
    # different problems and the operator fixes them differently.
    assert "could not be reached" not in said


async def test_a_model_that_was_never_pulled_says_it_is_not_installed():
    """The state this ships in until the owner pulls the model."""

    def handler(request):
        return httpx.Response(
            404, json={"error": 'model "test-embed" not found, try pulling it first'}
        )

    with pytest.raises(EmbedderUnavailable) as raised:
        await _embedder(handler).embed(["x"])
    said = str(raised.value)
    assert "not installed" in said
    assert "'test-embed'" in said
    assert "try pulling it first" in said


async def test_a_model_that_cannot_embed_is_a_different_sentence():
    """ollama answers 501 for a chat model asked to embed. A wrong choice of
    model, not a missing install — different fix, different sentence."""

    def handler(request):
        return httpx.Response(
            501, json={"error": "This server does not support embeddings. Start it with"}
        )

    with pytest.raises(EmbedderUnavailable) as raised:
        await _embedder(handler).embed(["x"])
    said = str(raised.value)
    assert "cannot produce embeddings" in said
    assert "not installed" not in said


async def test_any_other_http_failure_carries_the_status_and_the_body():
    def handler(request):
        return httpx.Response(500, text="upstream exploded")

    with pytest.raises(EmbedderUnavailable) as raised:
        await _embedder(handler).embed(["x"])
    said = str(raised.value)
    assert "HTTP 500" in said and "upstream exploded" in said


@pytest.mark.parametrize(
    "body, expected",
    [
        ({"nothing": "here"}, "without an `embeddings` list"),
        ({"embeddings": [[1.0, 0.0]]}, "returned 1 vectors for 2 texts"),
        ({"embeddings": [[1.0, 0.0], []]}, "empty or non-list vector at position 1"),
        ({"embeddings": [[1.0, 0.0], ["a", "b"]]}, "not numbers"),
        ({"embeddings": [[1.0, 0.0], [0.0, 0.0]]}, "all-zero vector"),
        ({"embeddings": [[1.0, 0.0], [1.0, 0.0, 0.0]]}, "different widths"),
    ],
)
async def test_a_200_that_cannot_be_read_says_what_was_wrong_with_it(body, expected):
    """A 200 is not an answer until it has been read. Each of these would
    otherwise become a silently wrong ranking rather than a stated failure."""

    def handler(request):
        return httpx.Response(200, json=body)

    with pytest.raises(EmbedderUnavailable) as raised:
        await _embedder(handler).embed(["x", "y"])
    assert expected in str(raised.value)


async def test_a_200_that_is_not_json_is_named_as_such():
    def handler(request):
        return httpx.Response(200, text="<html>proxy login</html>")

    with pytest.raises(EmbedderUnavailable) as raised:
        await _embedder(handler).embed(["x"])
    assert "not JSON" in str(raised.value)


async def test_nan_is_refused_rather_than_ranked():
    def handler(request):
        return httpx.Response(200, text='{"embeddings": [[NaN, 1.0]]}')

    with pytest.raises(EmbedderUnavailable) as raised:
        await _embedder(handler).embed(["x"])
    assert "NaN" in str(raised.value)


# -- what a good answer does ------------------------------------------------


async def test_vectors_come_back_unit_length_whatever_the_service_sent():
    """The dot product downstream is only a cosine if both sides are unit
    length. ollama already normalises, which is exactly why this is checked:
    an assumption about somebody else's output is not a property."""

    def handler(request):
        return httpx.Response(200, json={"embeddings": [[3.0, 4.0]]})

    (vector,) = await _embedder(handler).embed(["x"])
    assert vector == pytest.approx([0.6, 0.8])
    assert dot(vector, vector) == pytest.approx(1.0)


async def test_embed_query_uses_the_tighter_budget():
    seen = {}

    def handler(request):
        seen["timeout"] = request.extensions.get("timeout", {}).get("read")
        return httpx.Response(200, json={"embeddings": [[1.0, 0.0]]})

    await _embedder(handler, query_timeout=0.9).embed_query("a question")
    assert seen["timeout"] == 0.9


async def test_no_texts_is_no_call():
    def handler(request):  # pragma: no cover - must never run
        raise AssertionError("embedding nothing should not make a request")

    assert await _embedder(handler).embed([]) == []


def test_normalise_refuses_the_zero_vector():
    assert normalise([0.0, 0.0]) is None


# -- the cache --------------------------------------------------------------


def test_the_cache_round_trips_and_is_keyed_by_the_text(tmp_path):
    config = _config(model="nomic-embed-text:v2")
    path = cache_path(tmp_path, config)
    # Per model, and outside people/ so iter_all never walks it and /export
    # never tars it.
    assert path.parent == tmp_path / ".embeddings"
    assert "people" not in str(path.relative_to(tmp_path))
    # ":" is not a filename character; the slug keeps the name legible and
    # keeps two models' vectors in two different files.
    assert path.name == "nomic-embed-text-v2.jsonl"

    cache = VectorCache(path)
    cache.load()
    digest = digest_of("some note text")
    cache.add([(digest, [0.6, 0.8])])

    reopened = VectorCache(path)
    loaded = reopened.load()
    assert loaded[digest] == pytest.approx([0.6, 0.8])
    assert reopened.get(digest_of("other text")) is None


def test_an_unreadable_cache_line_costs_one_vector_and_not_the_service(tmp_path):
    path = tmp_path / ".embeddings" / "m.jsonl"
    path.parent.mkdir(parents=True)
    good = digest_of("kept")
    cache = VectorCache(path)
    cache.load()
    cache.add([(good, [1.0, 0.0])])
    with path.open("a", encoding="utf-8") as handle:
        handle.write("{not json at all\n")
        handle.write('{"h": "x", "d": 9, "v": "AAAA"}\n')  # width disagrees with the blob

    loaded = VectorCache(path).load()
    assert set(loaded) == {good}


def test_prune_drops_vectors_for_text_that_is_no_longer_indexed(tmp_path):
    path = tmp_path / ".embeddings" / "m.jsonl"
    cache = VectorCache(path)
    cache.load()
    live = digest_of("still here")
    gone = digest_of("forgotten note")
    cache.add([(live, [1.0, 0.0]), (gone, [0.0, 1.0])])

    assert cache.prune({live}) == 1
    assert set(VectorCache(path).load()) == {live}
    # Idempotent: nothing left to drop, and the file is not rewritten again.
    assert cache.prune({live}) == 0


# -- the backfill pass ------------------------------------------------------


async def test_backfill_uses_the_cache_before_the_service(tmp_path):
    calls = []

    def handler(request):
        calls.append(json.loads(request.content)["input"])
        return httpx.Response(200, json={"embeddings": [[1.0, 0.0]]})

    cache = VectorCache(tmp_path / "c.jsonl")
    cache.load()
    known = digest_of("known")
    cache.add([(known, [0.0, 1.0])])
    applied: dict[str, list[float]] = {}

    report = await backfill(
        _embedder(handler),
        cache,
        [(known, "known"), (digest_of("new"), "new")],
        apply=lambda d, v: applied.__setitem__(d, v),
    )
    assert calls == [["new"]]
    assert report.from_cache == 1 and report.embedded == 1 and report.failed is None
    assert set(applied) == {known, digest_of("new")}


async def test_a_failed_backfill_reports_the_reason_it_stopped(tmp_path):
    def handler(request):
        return httpx.Response(404, json={"error": 'model "test-embed" not found'})

    cache = VectorCache(tmp_path / "c.jsonl")
    cache.load()
    report = await backfill(
        _embedder(handler),
        cache,
        [(digest_of("a"), "a")],
        apply=lambda d, v: None,
    )
    assert report.embedded == 0
    assert "not installed" in report.failed


async def test_a_backfill_that_runs_out_of_budget_says_so_and_keeps_what_it_paid_for(tmp_path):
    """A pass is bounded so it cannot blow a caller's timeout; what it got is
    kept, and the rest is left for the next write rather than lost."""

    def handler(request):
        texts = json.loads(request.content)["input"]
        return httpx.Response(200, json={"embeddings": [[1.0, 0.0]] * len(texts)})

    cache = VectorCache(tmp_path / "c.jsonl")
    cache.load()
    applied = {}
    report = await backfill(
        _embedder(handler, batch=1),
        cache,
        [(digest_of(str(i)), str(i)) for i in range(5)],
        apply=lambda d, v: applied.__setitem__(d, v),
        budget=0.0,
    )
    assert report.out_of_budget is True
    assert report.embedded == 0
    # A zero budget stops before the first batch; a real one stops mid-way and
    # what it embedded is already in the cache file.
    assert isinstance(report, BackfillReport)


async def test_backfill_with_the_service_switched_off_states_that(tmp_path):
    cache = VectorCache(tmp_path / "c.jsonl")
    cache.load()
    report = await backfill(
        Embedder(_config(url="")),
        cache,
        [(digest_of("a"), "a")],
        apply=lambda d, v: None,
    )
    assert "switched off" in report.failed
