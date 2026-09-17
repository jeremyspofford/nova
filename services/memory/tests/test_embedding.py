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

from app import embedding
from app.embedding import (
    DEFAULT_MODEL,
    DEFAULT_URL,
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
        "slice_seconds": 5.0,
        # 0 rather than the shipping default: the mock transport does not care,
        # and a test that hard-codes 90 minutes would have to be edited the day
        # the cadence it is derived from changes.
        "keep_alive_seconds": 0.0,
        "retry_seconds": 0.0,
        "max_attempts": 3,
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
    assert config.timeout == embedding.DEFAULT_TIMEOUT
    assert config.query_timeout == embedding.DEFAULT_QUERY_TIMEOUT


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


# -- a note longer than the model can read ---------------------------------
#
# ollama's default is truncate=true: a text past the model's context comes
# back 200 OK, embedded from its head, with nothing in the answer saying so.
# Probed against this deployment on 2026-09-09 — a 4,500-word input answered
# 200 with prompt_eval_count 2048, and truncate=false answered 400 "the input
# length exceeds the context length". The live corpus holds one 11 KB pasted
# exchange, so this is not hypothetical: without the split below, a third of
# that note is represented by nothing while recall goes on saying "no note
# here resembles the question", which is a claim about text nobody embedded.

CONTEXT = 200  # characters the fake model can read at once


def _context_limited(seen: list[dict] | None = None):
    """A service that refuses an over-long text the way ollama does.

    Every accepted text is embedded as a vector pointing at the axis of its
    first word, so a caller can tell WHICH piece of a split note came back.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if seen is not None:
            seen.append(body)
        for text in body["input"]:
            if len(text) > CONTEXT:
                return httpx.Response(
                    400, json={"error": "the input length exceeds the context length"}
                )
        return httpx.Response(
            200,
            json={
                "embeddings": [
                    [float(len(text.split()[0])), float(len(text))] for text in body["input"]
                ]
            },
        )

    return handler


async def test_the_service_is_told_never_to_truncate_silently():
    seen: list[dict] = []
    await _embedder(_context_limited(seen)).embed(["short enough"])
    assert seen[0]["truncate"] is False


async def test_a_note_past_the_context_is_embedded_in_pieces(tmp_path):
    """The whole note is covered, and nothing is embedded truncated."""
    seen: list[dict] = []
    embedder = _embedder(_context_limited(seen))
    note = " ".join(f"sentence{i} about something" for i in range(40))
    assert len(note) > CONTEXT * 3

    windows = await embedder.embed_windows(note)

    assert len(windows) >= 4
    # The pieces that were actually embedded are the whole note, in order,
    # and every one of them fits the model — which is the property truncation
    # silently broke: the note back from its own windows, nothing missing.
    embedded = [text for call in seen for text in call["input"] if len(text) <= CONTEXT]
    assert len(embedded) == len(windows)
    assert " ".join(embedded).split() == note.split()


async def test_a_batch_holding_one_long_note_still_embeds_the_others(tmp_path):
    """A batch is all-or-nothing at the service, so one long note used to be
    able to take fifteen short ones down with it."""
    cache = VectorCache(tmp_path / "c.jsonl")
    cache.load()
    long_note = " ".join(f"word{i}" for i in range(200))
    texts = [("d-short-1", "a short note"), ("d-long", long_note), ("d-short-2", "another note")]
    applied: dict[str, list[list[float]]] = {}

    report = await backfill(
        _embedder(_context_limited()),
        cache,
        texts,
        apply=lambda d, v: applied.__setitem__(d, v),
    )

    assert report.failed is None and report.too_long == ()
    assert set(applied) == {"d-short-1", "d-long", "d-short-2"}
    assert len(applied["d-short-1"]) == 1
    assert len(applied["d-long"]) > 1
    # Cached as windows, so the next boot pays nothing for the split either.
    assert len(VectorCache(cache.path).load()["d-long"]) == len(applied["d-long"])


async def test_a_note_that_cannot_be_split_is_left_unembedded_and_named(tmp_path):
    """The one text that cannot be covered: no white space to cut on.

    It gets NO vector rather than a vector of its first 200 characters, so
    vector_coverage reports the scope as short of the whole and recall says so.
    A pass is not a failure over it — everything else is embedded — and the
    sentence names the note in the log.
    """
    cache = VectorCache(tmp_path / "c.jsonl")
    cache.load()
    applied: dict[str, list[list[float]]] = {}
    report = await backfill(
        _embedder(_context_limited()),
        cache,
        [("d-wall", "x" * (CONTEXT * 3)), ("d-fine", "a short note")],
        apply=lambda d, v: applied.__setitem__(d, v),
    )
    assert report.failed is None
    assert len(report.too_long) == 1
    assert "no white space to split on" in report.too_long[0]
    assert set(applied) == {"d-fine"}
    assert cache.get("d-wall") is None


async def test_a_service_that_goes_away_mid_split_is_still_a_stated_failure(tmp_path):
    """The split path has its own unavailability, and it is not swallowed."""
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(
                400, json={"error": "the input length exceeds the context length"}
            )
        raise httpx.ConnectError("Connection refused")

    cache = VectorCache(tmp_path / "c.jsonl")
    cache.load()
    report = await backfill(
        _embedder(handler),
        cache,
        [("d", "a long note with spaces in it")],
        apply=lambda d, v: None,
    )
    assert report.embedded == 0
    assert "could not be reached" in report.failed


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
    # A unit's value is its WINDOWS: one for a note the model can read whole,
    # two for one that had to be split to be covered at all.
    cache.add([(digest, [[0.6, 0.8]])])

    reopened = VectorCache(path)
    loaded = reopened.load()
    assert [pytest.approx(window) for window in loaded[digest]] == [[0.6, 0.8]]
    assert reopened.get(digest_of("other text")) is None

    long_note = digest_of("a much longer note")
    cache.add([(long_note, [[1.0, 0.0], [0.0, 1.0]])])
    reloaded = VectorCache(path).load()[long_note]
    assert [pytest.approx(window) for window in reloaded] == [[1.0, 0.0], [0.0, 1.0]]


def test_an_unreadable_cache_line_costs_one_vector_and_not_the_service(tmp_path):
    path = tmp_path / ".embeddings" / "m.jsonl"
    path.parent.mkdir(parents=True)
    good = digest_of("kept")
    cache = VectorCache(path)
    cache.load()
    cache.add([(good, [[1.0, 0.0]])])
    with path.open("a", encoding="utf-8") as handle:
        handle.write("{not json at all\n")
        handle.write('{"f": 2, "h": "x", "d": 9, "v": ["AAAA"]}\n')  # width vs blob disagree
        # Format 1: one vector, written while the embedder still let ollama
        # truncate silently. A line for a long text is that text's HEAD and
        # nothing says so, so it is not trusted — dropped and re-embedded.
        handle.write('{"h": "old", "d": 2, "v": "AAAAAAAAAAAAAAA="}\n')

    loaded = VectorCache(path).load()
    assert set(loaded) == {good}


def test_prune_drops_vectors_for_text_that_is_no_longer_indexed(tmp_path):
    path = tmp_path / ".embeddings" / "m.jsonl"
    cache = VectorCache(path)
    cache.load()
    live = digest_of("still here")
    gone = digest_of("forgotten note")
    cache.add([(live, [[1.0, 0.0]]), (gone, [[0.0, 1.0]])])

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
    cache.add([(known, [[0.0, 1.0]])])
    applied: dict[str, list[list[float]]] = {}

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


async def test_a_slice_budget_that_cut_work_says_so_as_a_budget_not_a_failure(tmp_path):
    """The distinction that made a healthy embedder read as a broken one.

    Boot on 2026-09-09 logged "embedding pass covered 16/75 units and then
    stopped: the embedding service did not answer within 5s". The service had
    answered every call; the PASS had a five-second budget and treated running
    out of it as a fault. So a pass that stops on its own budget must carry a
    budget sentence and NO failure — those are two different facts and only one
    of them is about the embedder.
    """

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
        slice_seconds=0.0,
    )
    assert report.out_of_budget is True
    assert report.failed is None, "a budget is not a failure of the embedding service"
    assert report.budget_note and "0s" in report.budget_note
    assert "still waiting" in report.budget_note
    assert "answered every call" in report.budget_note
    assert report.remaining == 5
    assert report.done is False
    assert report.embedded == 0


async def test_a_pass_with_no_slice_budget_embeds_everything_however_long_it_takes(tmp_path):
    """The background pass's shape: nothing is waiting on it, so nothing cuts
    it short. Slow is not broken."""

    def handler(request):
        texts = json.loads(request.content)["input"]
        return httpx.Response(200, json={"embeddings": [[1.0, 0.0]] * len(texts)})

    cache = VectorCache(tmp_path / "c.jsonl")
    cache.load()
    applied = {}
    report = await backfill(
        _embedder(handler, batch=2),
        cache,
        [(digest_of(str(i)), str(i)) for i in range(9)],
        apply=lambda d, v: applied.__setitem__(d, v),
    )
    assert report.embedded == 9
    assert report.remaining == 0
    assert report.out_of_budget is False
    assert report.done is True
    assert len(applied) == 9


async def test_a_budget_belongs_to_the_call_and_a_timeout_names_that_one(tmp_path):
    """A per-CALL budget, said in the sentence. Whatever a pass is given, the
    number a timeout reports is the one HTTP call's, because that is the only
    number that means "this call is not coming back"."""

    def handler(request):
        raise httpx.ReadTimeout("too slow", request=request)

    cache = VectorCache(tmp_path / "c.jsonl")
    cache.load()
    report = await backfill(
        _embedder(handler, timeout=17.0),
        cache,
        [(digest_of("a"), "a")],
        apply=lambda d, v: None,
        slice_seconds=900.0,
    )
    assert report.failed and "within 17s" in report.failed
    assert "900" not in report.failed
    assert report.remaining == 1


async def test_a_note_the_model_cannot_read_is_named_so_a_pass_can_stop_asking(tmp_path):
    """A unit with no white space to split on can never be embedded, so a
    background pass that kept asking for it would never finish. The pass hands
    back the digest it refused, which is how the loop learns."""
    long_word = "x" * (CONTEXT * 3)
    cache = VectorCache(tmp_path / "c.jsonl")
    cache.load()
    report = await backfill(
        _embedder(_context_limited(), batch=1),
        cache,
        [(digest_of(long_word), long_word)],
        apply=lambda d, v: None,
    )
    assert report.unembeddable == (digest_of(long_word),)
    assert report.too_long and "no white space" in report.too_long[0]
    assert report.failed is None
    assert report.remaining == 0, "a note that provably cannot be embedded is not still waiting"
    assert report.done is True


# -- staying warm -----------------------------------------------------------


async def test_every_call_asks_the_model_to_stay_resident(tmp_path):
    """keep_alive, on the backfill's calls as well as the query's.

    Measured reason (embedding.DEFAULT_KEEP_ALIVE_SECONDS): ollama unloads an
    idle model after five minutes, the proactive beat asks hourly, and the
    first call after an unload measured 1,444-1,728 ms against 17-26 ms warm.
    Without this every proactive recall pays that, and the query budget cannot
    absorb it — which is exactly what "semantic ran=false, did not answer
    within 1.5s" was on the running stack.
    """
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append(body)
        return httpx.Response(200, json={"embeddings": [[1.0, 0.0]] * len(body["input"])})

    embedder = _embedder(handler, keep_alive_seconds=5400.0)
    await embedder.embed_query("a question")
    cache = VectorCache(tmp_path / "c.jsonl")
    cache.load()
    await backfill(embedder, cache, [(digest_of("n"), "n")], apply=lambda d, v: None)
    assert len(seen) == 2
    assert [body["keep_alive"] for body in seen] == [5400.0, 5400.0]


def test_the_resident_duration_outlasts_the_cadence_that_wakes_it(monkeypatch):
    """The default is DERIVED from a cadence, and this is where the derivation
    is checked rather than asserted in a comment.

    services/core/app/beats.py schedules the watch beat hourly
    (WATCH_SCHEDULE = {"kind": "hour", "minute": 5}) and its review check
    recalls from memory. A keep_alive shorter than that gap means every
    proactive recall meets a cold model, which is the whole defect. A
    different service, so the number cannot be imported; if the beat stops
    being hourly this test is where somebody has to think about it.
    """
    monkeypatch.delenv("MEMORY_EMBED_KEEP_ALIVE_SECONDS", raising=False)
    config = EmbedConfig.from_env()
    assert config.keep_alive_seconds > 3600, (
        "the embedding model must stay resident longer than the hourly beat that asks for it"
    )
    # And not for ever by default: 0.32 GB of somebody else's VRAM, held
    # indefinitely, is a claim this service is not entitled to make on its own.
    assert config.keep_alive_seconds > 0


def test_for_ever_is_available_and_nonsense_is_not(monkeypatch):
    """-1 is ollama's "resident until something evicts it" and a deployment
    may ask for it. Anything below that is not a duration at all."""
    monkeypatch.setenv("MEMORY_EMBED_KEEP_ALIVE_SECONDS", "-1")
    assert EmbedConfig.from_env().keep_alive_seconds == -1
    monkeypatch.setenv("MEMORY_EMBED_KEEP_ALIVE_SECONDS", "0")
    assert EmbedConfig.from_env().keep_alive_seconds == 0
    monkeypatch.setenv("MEMORY_EMBED_KEEP_ALIVE_SECONDS", "-30")
    assert EmbedConfig.from_env().keep_alive_seconds == embedding.DEFAULT_KEEP_ALIVE_SECONDS
    monkeypatch.setenv("MEMORY_EMBED_KEEP_ALIVE_SECONDS", "soon")
    assert EmbedConfig.from_env().keep_alive_seconds == embedding.DEFAULT_KEEP_ALIVE_SECONDS


# -- the budgets are derived, not chosen ------------------------------------


def test_the_query_budget_is_core_s_budget_minus_what_recall_needs():
    """DERIVED, and the derivation is the test.

    core gives /recall 2.0 s (services/core/app/chat.py RECALL_TIMEOUT). If the
    question's embed call could run past that, core would time out and Nova
    would be told memory was UNREACHABLE — a different and false statement
    about what happened, in place of "I searched by words alone". So the budget
    is core's minus a reserve, and the reserve is measured: /recall's own
    ranking is 4.5 ms (docs/plans/rebuild/slice-13-memory.md).
    """
    assert embedding.CORE_RECALL_TIMEOUT == 2.0
    assert (
        embedding.DEFAULT_QUERY_TIMEOUT == embedding.CORE_RECALL_TIMEOUT - embedding.RECALL_RESERVE
    )
    assert embedding.DEFAULT_QUERY_TIMEOUT < embedding.CORE_RECALL_TIMEOUT
    # Ninety times the measured 4.5 ms of ranking is the headroom, so the
    # reserve is not a guess that happens to be large enough.
    assert embedding.RECALL_RESERVE > 0.0045 * 50


def test_the_backfill_call_budget_is_far_larger_than_the_query_s():
    """They are different jobs and they must not converge.

    A query is on a turn's critical path and answers late by saying so; a
    backfill call is on nobody's path and only needs to outlast a contended
    GPU, which was probed at 5-31 s for a single call.
    """
    assert embedding.DEFAULT_TIMEOUT >= 30.0
    assert embedding.DEFAULT_TIMEOUT > 10 * embedding.DEFAULT_QUERY_TIMEOUT


def test_the_batch_is_sized_for_resumption_because_batching_buys_nothing():
    """Measured, not assumed — the assumption was wrong in both directions.

    Timed on this box 2026-09-09 over the real 74-chunk corpus with the GPU
    idle, one batched request against the same texts sent one at a time:
    n=4 0.92x, n=8 1.13x, n=16 1.13x, n=32 1.08x, n=74 1.04x. ollama embeds a
    batch's inputs one after another; all a batch saves is the HTTP round trip.
    So the batch is not a throughput decision. It is sized so that ONE call is
    short enough to lose little when it times out and so the pass can stop
    between calls.
    """
    assert 1 < embedding.DEFAULT_BATCH <= 16


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
