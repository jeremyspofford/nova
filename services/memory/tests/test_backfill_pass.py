"""The backlog gets embedded, and slow never reads as broken.

THE FAILURE THIS FILE PINS

Measured on the running stack the day nomic-embed-text was pulled, boot logged:

    embedding pass covered 16/75 units and then stopped:
    the embedding service did not answer within 5s (ReadTimeout)

Nothing was wrong with the embedder. The pass was awaited at startup under a
budget that belonged to the WHOLE pass, so a corpus that simply took longer
than five seconds looked like a service that had failed — and because the pass
gave up until the next boot, the backlog never filled. Recall afterwards was
correct and useless: "only 0 of 49 notes in this scope have been embedded so
far", every time, for ever.

Four properties fix it and each has a test here:

  * boot does not wait for the pass;
  * the budget is on the CALL, and a slice that stops a caller says so as a
    budget rather than as a failure;
  * the pass CONTINUES — it retries a stated failure instead of parking it
    until somebody restarts the service;
  * a note the model provably cannot read is taken off the list, so "keeps
    going" cannot become "goes round for ever".
"""

from __future__ import annotations

import asyncio
import json
import logging

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from app import api
from app.embedding import Embedder
from app.main import app
from app.store import MemoryStore

TOKEN = "backfill-token"
PERSON = "alice"

WIDTH = 4


def _vector(text: str, width: int = WIDTH) -> list[float]:
    """A direction per text. Nothing here measures quality, so any stable
    unit vector will do — what is under test is the pass, not the ranking."""
    total = sum(ord(ch) for ch in text)
    axis = total % width
    return [1.0 if i == axis else 0.0 for i in range(width)]


class Service:
    """A stand-in ollama that can be made to fail, and counts what it was asked.

    Sits behind httpx.MockTransport in front of the REAL Embedder, so the
    payload, the error mapping and the normalisation under test are the
    shipping ones.
    """

    def __init__(self, width: int = WIDTH, fail_every: int = 0):
        self.calls: list[list[str]] = []
        self.keep_alive: list[object] = []
        self.fail_for = 0  # answer this many more calls with a stated failure
        # The dimension of the vectors this stand-in answers with. A model
        # re-pulled at another dimension is the failure MAJOR 1 is about, and
        # it is expressed here rather than in a second mock.
        self.width = width
        # Fail every Nth call, for ever. A pass that keeps meeting a budget
        # while embedding real work every time is what the attempt cap used to
        # abandon.
        self.fail_every = fail_every

    @property
    def texts(self) -> list[str]:
        return [text for call in self.calls for text in call]

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.calls.append(list(body["input"]))
        self.keep_alive.append(body.get("keep_alive"))
        if self.fail_for > 0:
            self.fail_for -= 1
            return httpx.Response(503, json={"error": "the GPU is busy"})
        if self.fail_every and len(self.calls) % self.fail_every == 0:
            return httpx.Response(503, json={"error": "the GPU is busy"})
        return httpx.Response(
            200, json={"embeddings": [_vector(text, self.width) for text in body["input"]]}
        )


@pytest.fixture
def wired(monkeypatch, tmp_path):
    """MEMORY_ROOT, auth, and a factory that swaps in a mock-transport
    Embedder the way the service builds its own."""
    monkeypatch.setenv("SERVICE_TOKEN", TOKEN)
    monkeypatch.setenv("MEMORY_ROOT", str(tmp_path))
    monkeypatch.setenv("MEMORY_EMBED_URL", "http://embedder.test")
    # Small but positive: a retry interval of 0 is refused by the config's
    # positive-only guard and falls back to the shipping 60 s, which would make
    # every retry test here sit for a minute.
    monkeypatch.setenv("MEMORY_EMBED_RETRY_SECONDS", "0.001")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    api._contexts.clear()
    api._passes.clear()
    api._filling.clear()
    api._unembeddable.clear()

    def use(service: Service) -> Service:
        monkeypatch.setattr(
            api,
            "Embedder",
            lambda config: Embedder(config, transport=httpx.MockTransport(service.handler)),
        )
        api._contexts.clear()
        return service

    yield use
    for task in api._passes.values():
        task.cancel()
    api._contexts.clear()
    api._passes.clear()
    api._filling.clear()
    api._unembeddable.clear()


def _seed(tmp_path, count: int) -> MemoryStore:
    store = MemoryStore(tmp_path)
    for index in range(count):
        store.write_topic(PERSON, f"n{index}", f"Note {index}", f"the body of note {index}")
    return store


def _coverage(tmp_path) -> tuple[int, int]:
    return api._context().index.vector_coverage(f"people/{PERSON}/")


# -- boot does not wait -----------------------------------------------------


async def test_the_boot_pass_is_a_background_task_and_boot_does_not_await_it(wired, tmp_path):
    """The one that would have caught it. Startup schedules the pass; it does
    not stand in front of it."""
    service = wired(Service())
    _seed(tmp_path, 12)
    api.warm_context()
    task = api.start_vector_backfill()
    assert task is not None
    assert not task.done(), "start_vector_backfill blocked instead of scheduling"
    assert service.calls == [], "the pass had already run before anything awaited it"
    await task
    assert _coverage(tmp_path) == (12, 12)


async def test_a_second_start_joins_the_pass_already_running(wired, tmp_path):
    """A write during a backfill must not start a second one over the same
    notes — two passes would pay for the same vectors twice."""
    service = wired(Service())
    _seed(tmp_path, 8)
    api.warm_context()
    first = api.start_vector_backfill()
    second = api.start_vector_backfill()
    assert first is second
    await first
    assert sorted(service.texts) == sorted(set(service.texts)), "a text was embedded twice"


# -- it continues -----------------------------------------------------------


async def test_a_stated_failure_is_retried_rather_than_parked_until_the_next_boot(
    wired, tmp_path, caplog
):
    """The behaviour the old shape lacked. A backfill that stopped on "the GPU
    is busy" used to wait for a restart; the corpus filled on the next attempt
    instead."""
    service = wired(Service())
    service.fail_for = 2
    _seed(tmp_path, 6)
    api.warm_context()
    with caplog.at_level(logging.WARNING, logger="memory.api"):
        await api.start_vector_backfill()
    assert _coverage(tmp_path) == (6, 6)
    assert any("retrying" in record.message for record in caplog.records)
    assert any("the GPU is busy" in str(record.getMessage()) for record in caplog.records)


async def test_a_pass_that_gives_up_says_so_and_says_what_is_still_unembedded(
    wired, tmp_path, caplog
):
    """It may give up. It may not give up quietly — a pass that ended in
    silence is indistinguishable from one that finished."""
    service = wired(Service())
    service.fail_for = 10_000
    _seed(tmp_path, 3)
    api.warm_context()
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("MEMORY_EMBED_MAX_ATTEMPTS", "2")
        api._contexts.clear()
        api.warm_context()
        with caplog.at_level(logging.WARNING, logger="memory.api"):
            await api.start_vector_backfill()
    assert _coverage(tmp_path) == (0, 3)
    gave_up = [r for r in caplog.records if "gave up" in r.getMessage()]
    assert gave_up, "the pass stopped without saying it had stopped"
    assert "3 note(s) still unembedded" in gave_up[0].getMessage()
    assert "the GPU is busy" in gave_up[0].getMessage()


async def test_a_note_the_model_cannot_read_does_not_make_the_pass_go_round_for_ever(
    wired, tmp_path
):
    """ "It keeps going" must not become "it never stops".

    A unit past the model's context with no white space to split on can never
    be embedded. The pass learns which one from the refusal, takes it off its
    own list, and finishes — leaving that note unembedded, which every recall
    over the scope then states through its coverage line.
    """
    service = Service()
    limit = 40

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        service.calls.append(list(body["input"]))
        if any(len(text) > limit for text in body["input"]):
            return httpx.Response(
                400, json={"error": "the input length exceeds the context length"}
            )
        return httpx.Response(200, json={"embeddings": [_vector(text) for text in body["input"]]})

    service.handler = handler  # type: ignore[method-assign]
    wired(service)
    store = MemoryStore(tmp_path)
    store.write_topic(PERSON, "ok", "Fine", "short")
    store.write_topic(PERSON, "big", "Big", "x" * (limit * 4))
    api.warm_context()
    await asyncio.wait_for(api.start_vector_backfill(), timeout=5)
    have, total = _coverage(tmp_path)
    assert (have, total) == (1, 2)
    asked = [text for call in service.calls for text in call]
    # A second pass must not ask for it again — it makes only the warm-up call
    # of a pass with nothing left to do.
    await asyncio.wait_for(api.start_vector_backfill(), timeout=5)
    assert service.calls[-1] == ["warm"]
    later = [text for call in service.calls for text in call][len(asked) :]
    assert not any(len(text) > limit for text in later), (
        "the pass asked again for a note the model had already refused"
    )


# -- a budget is not a failure ----------------------------------------------


async def test_a_write_path_slice_that_ran_out_says_budget_not_failure(wired, tmp_path):
    """The distinction the old log conflated.

    /ingest embeds what a second buys and hands the rest over. That is the
    caller's budget, not the embedder's fault, and the report has to say which.
    """
    wired(Service())
    _seed(tmp_path, 20)
    api.warm_context()
    report = await api.warm_vectors(slice_seconds=0.0)
    assert report.out_of_budget is True
    assert report.failed is None
    assert report.budget_note and "background pass continues" in report.budget_note
    assert report.remaining == 20


async def test_a_write_hands_the_rest_of_the_backlog_to_the_background_pass(wired, tmp_path):
    """An owner who pulls the embedding model mid-session gets the whole
    corpus filled from the next turn, with no restart."""
    wired(Service())
    _seed(tmp_path, 30)
    api.warm_context()
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("MEMORY_EMBED_SLICE_SECONDS", "0")
        api._contexts.clear()
        api.warm_context()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/ingest",
                headers={"Authorization": f"Bearer {TOKEN}"},
                json={
                    "person_id": PERSON,
                    "conversation_id": "c1",
                    "exchange": {"user": "hello", "assistant": "hi"},
                },
            )
        assert response.status_code == 200, response.text
        # The write started a pass and did not wait for it. Whether the loop
        # has already finished by the time this line runs is timing, not the
        # property — that a pass exists at all is the property, because
        # without it the 30 notes would sit unembedded until the next restart.
        key = str(api._current_root())
        assert key in api._passes, "the write did not hand the backlog to a background pass"
        await api._passes[key]
    have, total = _coverage(tmp_path)
    assert have == total and total >= 31


async def test_a_pass_already_running_defers_rather_than_paying_twice(wired, tmp_path):
    """Two coroutines, one backlog. The second one says what it did — deferred
    is not a failure and not a budget, it is "somebody else has this"."""
    wired(Service())
    _seed(tmp_path, 6)
    api.warm_context()
    key = str(api._current_root())
    api._filling.add(key)
    try:
        report = await api.warm_vectors()
    finally:
        api._filling.discard(key)
    assert report.deferred and "already running" in report.deferred
    assert report.failed is None
    assert report.out_of_budget is False
    assert report.remaining == 6


# -- staying warm -----------------------------------------------------------


async def test_a_restart_with_every_vector_cached_still_warms_the_model(wired, tmp_path):
    """A cached corpus means no embedding call, which means the model is still
    cold when the first question arrives — under a budget a cold load does not
    fit. One throwaway call at the end of the pass pays that off the critical
    path."""
    service = wired(Service())
    _seed(tmp_path, 4)
    api.warm_context()
    await api.start_vector_backfill()
    api._contexts.clear()
    api._passes.clear()
    api._unembeddable.clear()
    api.warm_context()
    service.calls.clear()
    await api.start_vector_backfill()
    assert service.calls == [["warm"]], (
        "a restart over a full cache made no call at all, so the model stays cold "
        "until the owner's first question pays for it"
    )


async def test_every_call_the_pass_makes_asks_the_model_to_stay_resident(wired, tmp_path):
    """keep_alive is on the backfill's calls too, not only the query's — the
    pass that fills the corpus at boot is also what leaves the model warm."""
    service = wired(Service())
    _seed(tmp_path, 5)
    api.warm_context()
    await api.start_vector_backfill()
    assert service.keep_alive, "the pass made no call"
    expected = api.EmbedConfig.from_env().keep_alive_seconds
    assert all(value == expected for value in service.keep_alive)


async def test_a_deployment_with_no_embedder_says_so_once_and_does_not_loop(
    wired, tmp_path, caplog
):
    """ "Semantic search is switched off" is configuration, not a fault.

    It cannot become false while the process runs, so retrying it twenty times
    over twenty minutes would be a loop that could never succeed. It is stated
    once and the pass ends — and every /recall keeps saying the search it did
    was the reduced one, which is where an owner sees it.
    """
    service = wired(Service())
    _seed(tmp_path, 3)
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("MEMORY_EMBED_URL", "")
        api._contexts.clear()
        api.warm_context()
        with caplog.at_level(logging.INFO, logger="memory.api"):
            await asyncio.wait_for(api.start_vector_backfill(), timeout=5)
    assert service.calls == []
    said = [r.getMessage() for r in caplog.records if "switched off" in r.getMessage()]
    assert said, "the pass ended without saying why it never started"
    assert len(said) == 1, "it said it more than once, so it went round"


# -- a vector of the wrong width is not a vector ----------------------------
#
# MAJOR 1, from the adversarial review of 2026-09-10. The index decided
# "embedded" on the PRESENCE of a digest, and `_semantic` correctly refused to
# compare a vector of another width to the question — so after a model was
# re-pulled at a different dimension the corpus read as 47 of 47 embedded, the
# pass logged "0 embedded", and semantic recall was dead for as long as the
# notes went unedited. Nothing in the service said a word about it.


async def test_a_corpus_embedded_at_another_width_is_re_embedded_not_counted_as_done(
    wired, tmp_path, caplog
):
    """The reviewer's repro: fill the corpus, narrow the model, restart.

    Everything the pass sees on the second boot is a cache hit, so without the
    width rule there is nothing to embed and nothing to say. What must happen
    instead is that the warm-up's own answer settles the live width, every
    vector of the old one is dropped from the index AND from the cache file,
    and the pass goes round again and re-embeds the corpus.
    """
    wired(Service())
    _seed(tmp_path, 5)
    api.warm_context()
    await asyncio.wait_for(api.start_vector_backfill(), timeout=5)
    assert _coverage(tmp_path) == (5, 5)

    # The same MEMORY_ROOT, the same cache file, a model of another dimension.
    narrow = Service(width=2)
    wired(narrow)
    api._passes.clear()
    api._unembeddable.clear()
    api.warm_context()
    with caplog.at_level(logging.WARNING, logger="memory.api"):
        await asyncio.wait_for(api.start_vector_backfill(), timeout=5)

    assert _coverage(tmp_path) == (5, 5)
    assert api._context().index.vector_width() == 2
    embedded = [text for call in narrow.calls for text in call if text != "warm"]
    assert len(embedded) == 5, (
        "the pass believed the old vectors and embedded nothing, so semantic recall is dead "
        f"and nothing says so: {narrow.calls!r}"
    )
    said = [r.getMessage() for r in caplog.records if "another width" in r.getMessage()]
    assert said, "the corpus was silently invalidated"


async def test_the_cache_file_loses_the_wrong_width_lines_rather_than_reloading_them(
    wired, tmp_path
):
    """Dropping them from the index alone would put the corpus straight back
    into the broken state on the next boot, because the cache is read into the
    index while the index is being built."""
    wired(Service())
    _seed(tmp_path, 3)
    api.warm_context()
    await asyncio.wait_for(api.start_vector_backfill(), timeout=5)
    cache_file = tmp_path / ".embeddings" / "nomic-embed-text.jsonl"
    widths = {json.loads(line)["d"] for line in cache_file.read_text().splitlines() if line.strip()}
    assert widths == {WIDTH}

    wired(Service(width=2))
    api._passes.clear()
    api._unembeddable.clear()
    api.warm_context()
    await asyncio.wait_for(api.start_vector_backfill(), timeout=5)
    widths = {json.loads(line)["d"] for line in cache_file.read_text().splitlines() if line.strip()}
    assert widths == {2}, f"a vector the live model cannot match is still on disk: {widths}"

    # And a third boot over that cache is a no-op, so this cannot become a
    # corpus that re-embeds itself for ever.
    third = Service(width=2)
    wired(third)
    api._passes.clear()
    api._unembeddable.clear()
    api.warm_context()
    await asyncio.wait_for(api.start_vector_backfill(), timeout=5)
    assert third.calls == [["warm"]], f"the pass re-embedded a corpus it already had: {third.calls}"


# -- the attempt cap counts attempts that got NOWHERE -----------------------


async def test_a_pass_that_keeps_embedding_is_not_abandoned_at_the_attempt_cap(
    wired, tmp_path, caplog
):
    """MINOR 5, from the same review.

    The loop counted TOTAL failures. At the scale the cache comment plans for —
    about 4,700 chunks — every attempt embeds hundreds of units and then meets
    the per-call budget, so twenty attempts that each did real work would
    abandon a corpus that was filling normally, and the log would say "gave up
    after 20 attempts" about a service that never failed to do anything.

    Here: 24 notes, batch 8, a service that answers one call and refuses the
    next, for ever. Every attempt embeds eight notes. With a cap of two, the
    old shape stopped at sixteen; the cap now means what its own log line says,
    so the corpus finishes.
    """
    service = Service(fail_every=2)
    wired(service)
    _seed(tmp_path, 24)
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("MEMORY_EMBED_MAX_ATTEMPTS", "2")
        patch.setenv("MEMORY_EMBED_BATCH", "8")
        api._contexts.clear()
        api.warm_context()
        with caplog.at_level(logging.WARNING, logger="memory.api"):
            await asyncio.wait_for(api.start_vector_backfill(), timeout=10)
    assert _coverage(tmp_path) == (24, 24)
    gave_up = [r.getMessage() for r in caplog.records if "gave up" in r.getMessage()]
    assert not gave_up, f"a pass that embedded on every attempt was abandoned: {gave_up}"


async def test_a_pass_that_embeds_nothing_still_gives_up_at_the_cap(wired, tmp_path, caplog):
    """The other half of the same rule: resetting on progress must not turn the
    cap into "never give up". A pass getting nowhere still stops, and still
    says how many notes it left."""
    service = Service()
    service.fail_for = 10_000
    wired(service)
    _seed(tmp_path, 3)
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("MEMORY_EMBED_MAX_ATTEMPTS", "2")
        api._contexts.clear()
        api.warm_context()
        with caplog.at_level(logging.WARNING, logger="memory.api"):
            await asyncio.wait_for(api.start_vector_backfill(), timeout=10)
    gave_up = [r.getMessage() for r in caplog.records if "gave up" in r.getMessage()]
    assert gave_up and "3 note(s) still unembedded" in gave_up[0]
    assert "embedded nothing" in gave_up[0]
