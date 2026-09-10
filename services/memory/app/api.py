"""HTTP surface: /ingest, /recall, /forget, /export.

store.py and index.py are pure concerns that know nothing about each
other or about HTTP; this module is the only place that wires them
together, and it owns keeping the index consistent with the filesystem
after every write/delete (the brief: "updated on every write/delete").

Bearer auth on every one of these routes is handled upstream by
app.auth.bearer_auth_middleware (mounted once in main.py) — nothing here
re-checks it.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from starlette.responses import StreamingResponse

from app.embedding import (
    BackfillReport,
    EmbedConfig,
    Embedder,
    EmbedderUnavailable,
    VectorCache,
    backfill,
    cache_path,
)
from app.index import BM25Index, RetrieverReport
from app.store import MemoryStore, PathEscape, StoredFile, split_entries

logger = logging.getLogger("memory.api")

router = APIRouter()

DEFAULT_ROOT = "/data/memory"

# Keyed by resolved root path. A real deployment has exactly one
# MEMORY_ROOT for the process's whole life, so the first request that
# needs it does the "full rescan at startup" the brief asks for — see
# warm_context(), called from main.py's lifespan, for making that
# literally true rather than merely true-on-first-request. Tests use a
# fresh tmp-dir root per test, so they always hit a cold build here too,
# which is exactly how "restart rescan" is exercised without any special
# reset hook.
_contexts: dict[str, Context] = {}


@dataclass
class Context:
    """Everything one MEMORY_ROOT needs to answer with: the files, the index
    over them, the embedder, and the vector cache beside them."""

    store: MemoryStore
    index: BM25Index
    embedder: Embedder
    cache: VectorCache


def _current_root() -> Path:
    return Path(os.environ.get("MEMORY_ROOT", DEFAULT_ROOT)).resolve()


def _index_document(index: BM25Index, stored: StoredFile) -> list[str]:
    """Put one file into the index as its EXCHANGES, and return their unit ids.

    A day of conversation is one file — up to 21 KB of it — and indexing it
    whole was measured (docs/plans/rebuild/slice-13-memory.md) to put the
    400-character excerpt an average of thousands of characters away from the
    answer, because the excerpt centres on wherever the question's ordinary
    words happen to cluster and in a transcript that is almost never near the
    fact. So the INDEX is chunked at the '## HH:MM' headings the store already
    writes; the file on disk is untouched, iter_all still yields whole files,
    and /forget still deletes whole files.

    Every unit keeps the file's title, kind and date, so a hit still says which
    day it came from, and carries the file as its `document` so scope, deletion
    and re-indexing all still work on files.

    Units already indexed for this document and no longer present (a journal
    re-read after an append, an exchange edited out by hand) are retired first:
    an index that only ever gains chunks would go on citing spans that are not
    in the file any more.
    """
    entries = split_entries(stored.body)
    title = stored.meta.get("title", "")
    kind = stored.meta.get("kind", "topic")
    created = stored.meta.get("created")
    if not entries:
        # A topic note has no headings: one unit, id == the file's own path,
        # exactly as before chunking existed.
        index.remove(stored.rel_path)
        index.upsert(stored.rel_path, title=title, kind=kind, created=created, body=stored.body)
        return [stored.rel_path]
    live = set()
    for entry in entries:
        unit_id = f"{stored.rel_path}#{entry.fragment}"
        live.add(unit_id)
        index.upsert(
            unit_id,
            title=title,
            kind=kind,
            created=created,
            body=entry.text,
            document=stored.rel_path,
            fragment=entry.fragment,
        )
    for stale in index.units_for(stored.rel_path):
        if stale not in live:
            index.remove_unit(stale)
    return [f"{stored.rel_path}#{entry.fragment}" for entry in entries]


def _build_context(root: Path) -> Context:
    store = MemoryStore(root)
    index = BM25Index()
    for stored in store.iter_all():
        # store.iter_all() only guarantees the YAML frontmatter block
        # parsed as a mapping — it does not validate individual fields.
        # A file with valid structure but a missing/unparseable
        # `created` (hand-edited, corrupted, from a future schema) makes
        # index.upsert()'s date coercion raise. That is exactly the same
        # class of problem as a file that fails to parse at all: log it,
        # name it, skip it, and keep the rest of the store intact —
        # never let one bad file take down a full rescan (startup via
        # warm_context(), or a request via the lazy path here).
        try:
            _index_document(index, stored)
        except ValueError as exc:
            logger.warning("skipping unindexable memory file %s: %s", stored.rel_path, exc)
    config = EmbedConfig.from_env()
    cache = VectorCache(cache_path(root, config))
    # Vectors that were paid for on an earlier run, handed straight to the
    # index. Only the ones whose text is still indexed are applied — a cache
    # that outlived its note contributes nothing and is pruned below.
    live = index.live_digests()
    for digest, windows in cache.load().items():
        if digest in live:
            index.set_vectors(digest, windows)
    return Context(store=store, index=index, embedder=Embedder(config), cache=cache)


def _context() -> Context:
    root = _current_root()
    key = str(root)
    ctx = _contexts.get(key)
    if ctx is None:
        ctx = _build_context(root)
        _contexts[key] = ctx
    return ctx


def warm_context() -> None:
    """Force the full rescan now instead of on the first request. Called
    from main.py's lifespan so "built by full rescan at startup" is true
    of the real deployment, not just of the lazy-init fallback."""
    _context()


# THE BACKGROUND EMBEDDING PASS, and the failure that made it one.
#
# Until 2026-09-09 the backlog was filled by a bounded pass awaited at boot and
# again on every write. Measured on the running stack the day the model was
# pulled, that shape produced this in the log:
#
#     embedding pass covered 16/75 units and then stopped:
#     the embedding service did not answer within 5s (ReadTimeout)
#
# Nothing was broken. The service answered every call; a batch of sixteen
# contended chunks simply took longer than the five seconds the pass allowed
# itself, and the pass then treated its own budget as a fault and gave up
# until the next restart. Recall afterwards was correct and useless: 0 of 49
# notes embedded, so semantic matching honestly refused to run, for ever.
#
# Three things fix it, and all three are here rather than in a bigger number:
#
#   1. the budget is per CALL (embedding.DEFAULT_TIMEOUT), so it means "this
#      call is not coming back" and nothing else;
#   2. the pass runs in the BACKGROUND and boot does not wait for it, so it
#      may take as long as the work takes;
#   3. it RETRIES a stated failure instead of parking it until the next boot,
#      because the failures it actually meets — the model is not pulled yet, a
#      27B is holding the GPU — resolve on their own.
#
# What makes all of that safe to re-run is the content-keyed cache: a re-run
# costs one dictionary lookup per unit already embedded, so continuing is
# always cheaper than deciding whether to continue.
#
# MEASURED, both shapes, on a read-only copy of the real notes with the local
# 27B chat model resident and the GPU contended:
#
#   old shape (5 s whole-pass budget, batch 16, 5 s per call)
#       "embedding pass covered 64/75 units and then stopped: the embedding
#        service did not answer within 5s (ReadTimeout)" — coverage 38 of 49
#       in Jeremy's scope, so recall still refuses to match by meaning. Under
#       the heavier contention of the original run it was 16 of 75.
#
#   this shape (per-call 30 s, batch 8, background, no pass budget)
#       start_vector_backfill returned in 0.1 ms with the task not yet run —
#       boot was not waiting — and the pass finished the whole corpus in
#       35.6 s. Coverage 0 of 49 -> 49 of 49.
_passes: dict[str, asyncio.Task] = {}

# Roots with a pass mid-flight. Set and cleared with no await between, so this
# is a mutual exclusion in asyncio without a lock, and it is what stops a
# write-path slice and the background pass from paying for the same vector
# twice.
_filling: set[str] = set()

# Digests the embedder has REFUSED — a unit past the model's context with no
# white space to split on. Learned from the pass that met them, never guessed.
# Without this the background pass would ask for them again on every round and
# never reach "done"; with it they stay unembedded and every recall over that
# scope keeps saying so through vector_coverage.
_unembeddable: dict[str, set[str]] = {}


async def warm_vectors(*, slice_seconds: float | None = None) -> BackfillReport:
    """Fill the backlog now, awaited, and prune what the notes no longer hold.

    This is the pass itself. `start_vector_backfill` is what the running
    service uses — it puts this on a background task so boot does not wait —
    and this is what a caller that genuinely wants to wait for the vectors
    (a measurement, a test) calls directly.

    Deliberately NOT fatal and deliberately NOT silent. The embedding model is
    pulled by the owner, not installed by this service, so "no embedder yet"
    is an ordinary state for a running deployment — memory must serve lexical
    recall through it and every /recall must SAY that is what it is doing. So
    the pass logs which of the stated unavailabilities it hit and returns;
    what it must never do is fail quietly and leave recall calling itself
    semantic over an empty vector space.
    """
    ctx = _context()
    key = str(_current_root())
    report = await _fill_vectors(ctx, key, slice_seconds=slice_seconds)
    if not report.deferred:
        _prune_vectors(ctx)
    return report


def start_vector_backfill() -> asyncio.Task | None:
    """Put the backlog pass on a background task and return immediately.

    Called from main.py's lifespan INSTEAD of awaiting the pass, so a corpus
    that takes four minutes to embed does not hold up a startup a healthcheck
    is waiting on — and called again from the write paths, so an embedder that
    appears while the service is running (the owner pulls the model) is picked
    up without a restart.

    Returns the task rather than swallowing it: a caller that wants to wait —
    a test, a measurement — can, and the running service simply does not.
    Never starts a second pass over the same root.
    """
    key = str(_current_root())
    running = _passes.get(key)
    if running is not None and not running.done():
        return running
    task = asyncio.ensure_future(_backfill_loop(key))
    _passes[key] = task
    return task


async def _backfill_loop(key: str) -> None:
    """Embed until there is nothing left to embed, retrying stated failures.

    The loop's own honesty rule: it may retry, and it may give up, but it may
    never end quietly. Every exit writes a log line saying which of the three
    it was — finished, gave up after N attempts and why, or the notes it is
    working on were rebuilt underneath it.
    """
    attempts = 0
    while True:
        ctx = _contexts.get(key)
        if ctx is None:
            # The context was cleared (a rebuild, a test). Whatever rebuilt it
            # starts its own pass; this one has nothing left to work on.
            logger.info("embedding pass for %s stopped: its index was rebuilt", key)
            return
        switched_off = ctx.embedder.unavailable_reason()
        if switched_off:
            # Read from configuration, so it cannot become true while this
            # process runs. Retrying it twenty times over twenty minutes would
            # be a loop that could never succeed, and the deployment already
            # knows: every /recall says the search was the reduced one.
            logger.info("embedding pass not started: %s", switched_off)
            return
        report = await _fill_vectors(ctx, key)
        if report.deferred:
            logger.info("embedding pass stopped: %s", report.deferred)
            return
        if report.failed:
            attempts += 1
            config = ctx.embedder.config
            if attempts >= config.max_attempts:
                logger.warning(
                    "embedding pass gave up after %d attempts with %d note(s) still unembedded: "
                    "%s — recall keeps saying it matched words alone until this is fixed and the "
                    "service restarted or another note written",
                    attempts,
                    report.remaining,
                    report.failed,
                )
                return
            logger.warning(
                "embedding pass stopped with %d note(s) left (attempt %d of %d), retrying in "
                "%.0fs: %s",
                report.remaining,
                attempts,
                config.max_attempts,
                config.retry_seconds,
                report.failed,
            )
            await asyncio.sleep(config.retry_seconds)
            continue
        if report.remaining:
            # Only a slice budget can leave work behind without a failure, and
            # this pass sets none. Named rather than looped on, because a loop
            # that cannot say why it is going round again is a spin.
            logger.warning(
                "embedding pass ended with %d note(s) unembedded and no reason given — "
                "not retrying",
                report.remaining,
            )
            return
        _prune_vectors(ctx)
        if not report.embedded:
            # Nothing needed embedding, so no call was made, so the model is
            # still cold — and the next thing to ask for it is a turn, under a
            # budget that a cold load does not fit (embedding.py's comment on
            # DEFAULT_QUERY_TIMEOUT). One throwaway embed here pays the ~1.5 s
            # load off the critical path and leaves it resident.
            await _warm_model(ctx)
        logger.info(
            "embedding pass finished: %d embedded, %d already cached, %d note(s) the model "
            "cannot read",
            report.embedded,
            report.from_cache,
            len(_unembeddable.get(key, ())),
        )
        return


async def _warm_model(ctx: Context) -> None:
    """One call whose only purpose is to leave the model loaded.

    Reported, never assumed: this is also the first honest answer to "is the
    embedding model actually installed", asked at boot instead of on the
    owner's first question.
    """
    try:
        # The BACKFILL's per-call budget, not the query's. This call is on
        # nobody's critical path, and the whole point of it is to absorb a cold
        # load that the query budget deliberately cannot — putting it under
        # 1.6 s would make it fail exactly when it was most needed.
        await ctx.embedder.embed(["warm"])
    except EmbedderUnavailable as exc:
        logger.warning("the embedding model could not be warmed: %s", exc)
        return
    keep_alive = ctx.embedder.config.keep_alive_seconds
    logger.info(
        "the embedding model %s answered and is asked to stay resident for %s",
        ctx.embedder.config.model,
        "as long as it can" if keep_alive < 0 else f"{keep_alive:g}s",
    )


def _prune_vectors(ctx: Context) -> None:
    """Drop vectors for text the notes no longer hold.

    Run at the end of a pass, when the live set is complete and nothing else
    is writing. A cache that is never pruned keeps a vector for every exchange
    ever edited and every note ever forgotten.
    """
    live = ctx.index.live_digests()
    dropped_memory = ctx.index.retain_vectors(live)
    dropped_disk = ctx.cache.prune(live)
    if dropped_memory or dropped_disk:
        logger.info(
            "embedding cache pruned: %d vectors dropped from memory, %d from %s",
            dropped_memory,
            dropped_disk,
            ctx.cache.path,
        )


async def _fill_vectors(
    ctx: Context,
    key: str,
    scope_prefix: str = "",
    *,
    slice_seconds: float | None = None,
) -> BackfillReport:
    """One embedding pass over the units that have no vector yet.

    `slice_seconds` is the wall clock the CALLER is prepared to wait, and only
    the write paths pass one — the background pass runs unbounded, because
    nothing is waiting on it. Never called from /recall: /recall embeds the
    question and nothing else.
    """
    refused = _unembeddable.setdefault(key, set())
    missing = [
        (digest, text)
        for digest, text in ctx.index.missing_vectors(scope_prefix)
        if digest not in refused
    ]
    if not missing:
        return BackfillReport()
    if key in _filling:
        # No await between this check and the add below, so two coroutines
        # cannot both get past it.
        return BackfillReport(
            requested=len(missing),
            remaining=len(missing),
            deferred=(
                f"another embedding pass over these notes is already running, so this call "
                f"left the remaining {len(missing)} note(s) to it"
            ),
        )
    _filling.add(key)
    try:
        report = await backfill(
            ctx.embedder,
            ctx.cache,
            missing,
            apply=ctx.index.set_vectors,
            slice_seconds=slice_seconds,
        )
    finally:
        _filling.discard(key)
    refused.update(report.unembeddable)
    if report.too_long:
        # Not a failure of the pass, and not silent either: these units have
        # no vector, so every recall over this scope reports its coverage as
        # short of the whole. The sentences say which notes and why.
        logger.warning(
            "%d note(s) could not be embedded at all: %s",
            len(report.too_long),
            "; ".join(report.too_long),
        )
    if report.failed:
        # Named, at warning level, every time. This is the line that turns "we
        # shipped semantic recall and it never ran" into something visible.
        logger.warning(
            "embedding pass covered %d/%d units and then stopped: %s",
            report.embedded + report.from_cache,
            report.requested,
            report.failed,
        )
    elif report.out_of_budget:
        # A budget that cut real work, said as a budget. It is NOT logged at
        # warning level and it does not carry a failure sentence, because the
        # service did nothing wrong — the caller was simply not prepared to
        # wait, and the background pass has the rest.
        logger.info("embedding pass: %s", report.budget_note)
    elif report.embedded:
        logger.info(
            "embedding pass: %d embedded, %d from cache, %d requested, %.2fs",
            report.embedded,
            report.from_cache,
            report.requested,
            report.seconds,
        )
    return report


async def _fill_after_write(ctx: Context) -> BackfillReport:
    """What a write path does about vectors: a short slice, then hand over.

    core awaits /ingest inside a 10 s budget and the new exchange is one call
    (~25 ms warm), so a one-second slice embeds it and forty more like it
    without making anyone wait. Anything still missing goes to the background
    pass, which is started here — so an owner who pulls the embedding model
    mid-session gets the whole corpus filled from the next turn, with no
    restart.
    """
    report = await _fill_vectors(
        ctx, str(_current_root()), slice_seconds=ctx.embedder.config.slice_seconds
    )
    if report.remaining:
        start_vector_backfill()
    return report


class Exchange(BaseModel):
    user: str
    assistant: str


class IngestRequest(BaseModel):
    person_id: str
    conversation_id: str
    exchange: Exchange


class RecallRequest(BaseModel):
    query: str
    person_id: str
    k: int = 5


class SaveRequest(BaseModel):
    person_id: str
    title: str
    content: str


class ForgetRequest(BaseModel):
    person_id: str
    path: str


@router.post("/ingest")
async def ingest(req: IngestRequest) -> dict:
    ctx = _context()
    store, index = ctx.store, ctx.index
    user_text = req.exchange.user.strip()
    assistant_text = req.exchange.assistant.strip()
    entry = f"User: {user_text}\n\nAssistant: {assistant_text}"

    try:
        abs_path, _created_new = store.append_journal(req.person_id, entry)
    except PathEscape as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    # Verify mechanically before reporting success: re-read the file
    # from disk and confirm both halves of the exchange actually landed.
    # Never report an append that was not checked.
    on_disk = abs_path.read_text(encoding="utf-8")
    if user_text not in on_disk or assistant_text not in on_disk:
        raise HTTPException(status_code=500, detail="ingest write did not verify")

    stored = store.read(abs_path)
    units = _index_document(index, stored)
    # State what is true, then check it anyway. append_journal writes the
    # "## HH:MM" heading and split_entries reads it; if those two ever stop
    # agreeing, this file falls back to being indexed whole and chunking is
    # silently off — recall gets worse and nothing says why. A journal that
    # did not come out as exchanges is a fault, not a quieter success.
    if not any("#" in unit for unit in units):
        raise HTTPException(
            status_code=500,
            detail="the exchange was written but the journal was not indexed as exchanges",
        )
    # The new exchange's vector, and any the corpus is still missing. Off the
    # reply path (core awaits /ingest after the turn, with a 10 s budget) and
    # bounded, so this is where a corpus catches up after the owner pulls the
    # embedding model — no restart, and no embedding on /recall.
    await _fill_after_write(ctx)
    return {"path": stored.rel_path, "appended": True}


@router.post("/save")
async def save(req: SaveRequest) -> dict:
    """Write one topic note for a person and confirm it landed.

    This is what a caller uses to record something deliberately, as
    opposed to /ingest's automatic journalling of an exchange. It never
    replaces an existing note: a title whose slug is taken gets a
    numbered sibling, because the caller asked to save something, not to
    lose something.
    """
    ctx = _context()
    store, index = ctx.store, ctx.index
    title = req.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is empty — a note needs a name")
    content = req.content.strip()
    if not content:
        # Nothing to write means nothing to verify, and a save that cannot
        # be checked must not answer "saved".
        raise HTTPException(status_code=400, detail="content is empty — there is nothing to save")

    try:
        abs_path = store.create_topic(req.person_id, title, content)
    except PathEscape as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"could not write the note: {exc}") from None

    # Verify mechanically before reporting success — re-read from disk and
    # confirm the body is actually in the file, exactly as /ingest does.
    if not abs_path.is_file():
        raise HTTPException(status_code=500, detail="the save did not verify — no file on disk")
    if content not in abs_path.read_text(encoding="utf-8"):
        raise HTTPException(
            status_code=500, detail="the save did not verify — the note's content is not in it"
        )

    stored = store.read(abs_path)
    _index_document(index, stored)
    await _fill_after_write(ctx)
    return {"path": stored.rel_path, "saved": True}


@router.post("/recall")
async def recall(req: RecallRequest) -> dict:
    """What these notes hold on a question — or a stated nothing.

    The answer is {hits, found, statement, retrievers}, not a bare list,
    because a bare list could only ever say "no hits" and this route has four
    different things to say: here is what matched; the notes hold no answer,
    and here is why; here is what matched but only ONE of the two searches
    ran, so a note phrased differently may have been missed; and (as an HTTP
    failure, never as an empty list) the notes could not be read at all.

    `retrievers` is the mechanical half of that. It says which searches
    actually ran on THIS call — not which are configured, not which are
    intended — and names the reason for any that did not. Whether the
    embedding model is installed is a fact this service can only learn by
    asking, so it asks on every recall, and what it learns travels: an answer
    found by word matching alone is marked as one, and core turns that into a
    sentence in the prompt. Degrading to lexical while still calling itself
    semantic is the single easiest lie in this feature, and this is the line
    of code that refuses to tell it.

    `statement` is the sentence a caller can repeat — the relevance floor and
    the embedder are both this service's business, so the words for them
    belong here and not in whatever calls it.
    """
    ctx = _context()
    store, index = ctx.store, ctx.index
    try:
        person_root = store.person_root(req.person_id)
    except PathEscape as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    # The question, embedded — the ONE embedding call on a turn's critical
    # path, under its own tighter budget (see DEFAULT_QUERY_TIMEOUT). A
    # failure here is never fatal and never silent: it becomes the sentence
    # the semantic retriever reports for not having run.
    query_vector = None
    semantic_unavailable = None
    try:
        query_vector = await ctx.embedder.embed_query(req.query)
    except EmbedderUnavailable as exc:
        semantic_unavailable = str(exc)

    scope_prefix = store.rel_path(person_root) + "/"
    outcome = index.search_detail(
        req.query,
        scope_prefix=scope_prefix,
        k=max(req.k, 0),
        query_vector=query_vector,
        semantic_unavailable=semantic_unavailable,
    )
    hits = outcome.hits

    # Scope is mechanical: re-assert the resolved path of every hit
    # before it leaves the process, even though the index was only ever
    # asked to search inside scope_prefix. This is the load-bearing
    # check, not the index's own filtering.
    safe_hits = []
    for hit in hits:
        # A hit's id names an exchange ("...md#16:32"); the FILE is what the
        # scope check resolves, and the index hands it over as its own field
        # rather than the check re-splitting the id and getting the rule
        # slightly different from the one that built it.
        try:
            resolved = store.resolve_in_person(req.person_id, hit["document"])
        except PathEscape:
            logger.error("index produced an out-of-scope hit: %s", hit["document"])
            continue
        if not resolved.is_file():
            continue
        safe_hits.append(hit)

    retrievers = [_retriever_payload(report) for report in outcome.retrievers]
    caveat = _search_caveat(outcome.retrievers)

    if safe_hits:
        statement = (
            f"{len(safe_hits)} note(s) matched and cleared the relevance floor, best match first."
        )
        if caveat:
            statement = f"{statement} {caveat}"
        return {
            "hits": safe_hits,
            "found": True,
            "statement": statement,
            "retrievers": retrievers,
        }
    # No hits: say WHICH nothing this is. index.search_detail gives the reason
    # when it found nothing; when it found something and every hit was then
    # dropped by the scope re-check above, the index and the disk disagree, and
    # that is a fault to name rather than an answer to report as an empty one.
    reason = outcome.reason or (
        "the notes that matched are no longer on disk, so this search could not be completed"
    )
    statement = f"These notes hold no answer to that — {reason}."
    if caveat:
        statement = f"{statement} {caveat}"
    return {
        "hits": [],
        "found": False,
        "statement": statement,
        "retrievers": retrievers,
    }


def _retriever_payload(report: RetrieverReport) -> dict:
    """One retriever's report, as facts. `ranked` is a count of units, never a
    score, and no similarity of any kind appears here: a cosine is not a
    confidence and must not be handed to anything that would show it as one."""
    payload: dict = {"name": report.name, "ran": report.ran}
    if report.ran:
        payload["ranked"] = report.ranked
    if report.reason:
        payload["reason"] = report.reason
    if report.coverage:
        payload["coverage"] = report.coverage
    return payload


def _search_caveat(reports: tuple[RetrieverReport, ...]) -> str | None:
    """The sentence that says this search was not the search it could have been.

    Composed here rather than in core because the reason belongs to this
    service — it is the one that knows whether the embedding model is
    installed. It says what was NOT done and why; it never claims the notes
    hold nothing, because a search that could not run properly has established
    nothing at all about the notes.
    """
    absent = [report for report in reports if not report.ran and report.reason]
    partial = [report for report in reports if report.ran and report.coverage]
    parts = []
    if absent:
        missed = ", ".join(f"{report.name} ({report.reason})" for report in absent)
        parts.append(
            f"This search did not use every retriever it has: {missed}. A note that says the "
            "same thing in different words could have been missed."
        )
    for report in partial:
        parts.append(
            f"The {report.name} search covered only part of the notes — {report.coverage}."
        )
    return " ".join(parts) or None


@router.post("/forget")
async def forget(req: ForgetRequest) -> dict:
    ctx = _context()
    store, index = ctx.store, ctx.index
    try:
        resolved = store.resolve_in_person(req.person_id, req.path)
    except PathEscape as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="no such memory file")

    canonical = store.rel_path(resolved)
    store.delete(resolved)
    if resolved.exists():
        raise HTTPException(status_code=500, detail="forget did not verify deletion")

    index.remove(canonical)
    return {"path": canonical, "deleted": True}


@router.get("/export")
async def export(person_id: str = Query(...)) -> StreamingResponse:
    store = _context().store
    try:
        data = store.export_tar_gz(person_id)
    except PathEscape as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{person_id}.tar.gz"'},
    )
