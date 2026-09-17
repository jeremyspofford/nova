"""The meaning half of recall: vectors from a local embedding model.

WHY THIS EXISTS, measured rather than assumed
---------------------------------------------

S13-2 did the mechanical work — chunking at "## HH:MM", stopwords, Porter
stemming, a derived relevance floor, a wider excerpt — and it moved
answer-in-context from 6/20 to 8/20 on the fixture and 6/18 to 8/18 on
Jeremy's real notes. What it left behind is not a tuning problem. Seven of the
twenty questions now honestly come back with nothing, and every one of them is
a VOCABULARY gap: the question says "graphics memory" and the note says VRAM,
the question says "short poem about the cold season" and the note says haiku,
the question says "money burned through" and the note says spend. No amount of
BM25 tuning bridges a word that is not in the text. That is what an embedder
is for, and it is the reason this module exists rather than a sixth attempt at
the ranker.

WHAT THIS MODULE IS RESPONSIBLE FOR

  * config (which service, which model, which budgets) — read from the
    environment, never a literal in a call site;
  * one HTTP call to ollama's /api/embed, and the mapping from everything
    that can go wrong to a SENTENCE that says which thing went wrong;
  * covering a note the model cannot read in one go — the service is told
    never to truncate, and a long note is embedded as windows instead;
  * the on-disk vector cache, keyed by a hash of the exact text embedded.

It does NOT rank anything. Ranking and fusion live in app/index.py beside
BM25, because a hit has to be scored against both signals in one place.

THE HONESTY RULE THIS FILE EXISTS TO KEEP

An embedder that is missing, unreachable, or answering nonsense must make
recall SAY it fell back to word matching. Silently degrading to lexical while
calling itself semantic is the exact lie this repo is built to prevent: "she
could not find it" and "she could not look properly" are different facts and
she has to be able to tell someone which one happened. So every failure path
below raises EmbedderUnavailable carrying a finished sentence — there is no
path that returns an empty list and lets the caller guess. The three the brief
names are three different sentences here, and there are five:

  the service is switched off | unreachable | did not answer in time |
  the model is not installed  | the model cannot embed at all |
  the answer was not something this service could read

NEVER A CONFIDENCE

A cosine similarity is not a probability and is not a confidence. Nothing in
this module hands one to a caller that would show it to the model or the
owner; index.py uses them to ORDER and to threshold, and what leaves the
service is a rank, not a number about how sure anybody is.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import math
import os
import time
from array import array
from dataclasses import dataclass
from pathlib import Path

import httpx

logger = logging.getLogger("memory.embedding")

# The bundled inference container, on the compose network. A deployment that
# runs ollama somewhere else sets MEMORY_EMBED_URL; a deployment that wants no
# semantic recall at all sets it empty, and recall says so in those words
# rather than looking like a search that found nothing.
DEFAULT_URL = "http://ollama:11434"

# nomic-embed-text: 768 dimensions, ~274 MB, 8k context, unit-normalised
# output. Named here as a DEFAULT and nowhere else — no call site spells a
# model name — so pointing this deployment at a different embedder is one
# environment variable and not a code change. Changing it also changes the
# cache file (see cache_path), because vectors from two models are not
# comparable and mixing them would silently corrupt every ranking.
DEFAULT_MODEL = "nomic-embed-text"

# HOW LONG THE MODEL STAYS RESIDENT, and why it is not ollama's default.
#
# ollama unloads an idle model after 5 minutes. Measured on this box
# 2026-09-09, with the GPU otherwise idle, over three unload-then-embed
# trials: the first call after an unload took 1,444 / 1,455 / 1,728 ms, and
# every call after it took 17-26 ms. So a cold load costs roughly SIXTY times
# a warm call, and it is paid by whoever asks first.
#
# Who asks first, on a quiet machine, is the hourly watch beat
# (services/core/app/beats.py WATCH_SCHEDULE = every hour at minute 5), which
# runs the checks and whose review check recalls from memory. An hour is
# twelve times ollama's idle window, so WITHOUT this every proactive recall
# pays the cold load — and the query budget below cannot absorb one, which is
# how "semantic ran=false, the embedding service did not answer within 1.5s"
# came to be the normal state of a working deployment rather than a fault.
#
# 90 minutes, deliberately, derived from that cadence: comfortably past the
# hourly beat with half an hour of slack for a late one, and short enough that
# a machine which has genuinely gone quiet for an hour and a half gives the
# VRAM back rather than holding it for ever.
#
# WHAT IT COSTS, measured rather than estimated: /api/ps reports
# nomic-embed-text resident at 323,150,151 bytes — 0.32 GB — beside
# qwen3.8:27b at 17.4 GB on a 24 GB card. Keeping the embedder warm costs 1.3%
# of the card and does not change which chat model fits. Verified live after
# this landed: /api/ps showed the embedder expiring 90 minutes after its last
# call while the 27B beside it expired in five, which is the difference this
# constant buys.
#
# It is sent as a number of seconds because ollama accepts one. -1 (for ever)
# is available to a deployment that wants it and is not the default, because
# "for ever" is a claim on somebody else's VRAM that nothing here is entitled
# to make.
DEFAULT_KEEP_ALIVE_SECONDS = 90 * 60

# ONE CALL's budget on the backfill path — per CALL, never per pass.
#
# This was a per-pass budget until 2026-09-09, and the failure it produced is
# the reason for the distinction. At boot the pass got 5 s for the WHOLE
# corpus, embedded 16 of 75 units, and logged "the embedding service did not
# answer within 5s" — so a service that was working perfectly reported a
# timeout, the backlog never filled, and every recall afterwards correctly but
# uselessly refused to match by meaning because almost nothing was embedded.
# A budget belongs on one call, where it means "this call is not coming back";
# how long the whole job takes is the background pass's business and nobody
# is waiting on it.
#
# 30 s, from the measured spread rather than from the warm case. A batch of 8
# real chunks measured 300 ms with the GPU idle; with a 27B chat model
# resident and busy, a single embed call was probed at 5-31 s. A budget under
# the contended figure would turn "the GPU is busy" into a stated failure and
# stop a pass that would have finished, so it is set above it.
DEFAULT_TIMEOUT = 30.0

# The budget for the ONE call /recall makes — embedding the question.
#
# DERIVED, not chosen: core gives the whole of /recall 2.0 s
# (services/core/app/chat.py RECALL_TIMEOUT), and memory must answer inside
# that even when the embedder does not, because "I searched by words alone,
# the embedder did not answer in time" and "memory was unreachable" are
# different facts and only the first one is true. So the question's budget is
# core's budget minus what the rest of /recall needs, and the rest of /recall
# was measured at 4.5 ms of ranking (docs/plans/rebuild/slice-13-memory.md).
# 400 ms of reserve is roughly ninety times that, which covers the HTTP round
# trip, the scope re-check and the JSON with room to spare.
#
# WHAT IT DOES NOT COVER, stated because the number looks like it should: a
# COLD load measured 1,444-1,728 ms here, so a question that arrives while the
# model is unloaded will sometimes miss even this budget. Raising it is not
# the fix — past 2.0 s core times out and Nova is told something false. The
# fix is that the model should not be cold, which is what
# DEFAULT_KEEP_ALIVE_SECONDS and the boot warm-up in api.py are for, and when
# it is cold anyway recall says which half of the search it did.
CORE_RECALL_TIMEOUT = 2.0

# THE RESERVE: a measured floor, plus a term that GROWS WITH THE CORPUS.
#
# It was a flat 0.4 until 2026-09-10, and the review named what that promises.
# 0.4 s was reserved for a ranking cost measured at 4.5 ms over 47 units — and
# ranking is linear in the scope, which only ever grows. Measured on this box,
# one scope, warm:
#
#     units      ranking
#      1,000       48 ms
#      5,000      267 ms
#     10,000      504 ms
#
# — about 50 us a unit. Past roughly 8,000 units the ranking alone spends the
# whole reserve, so the embedder is handed a budget the rest of /recall has
# already used, core times the request out at 2.0 s, and nothing anywhere says
# the reason was that the corpus got big.
#
# So 0.4 stays as the FLOOR — it is the measured round trip, scope re-check and
# JSON, and at today's corpus the budget is byte-identical to what it was — and
# above it the reserve is derived per call from the live scope, preferring what
# this process has actually TIMED (BM25Index.note_rank_seconds) over the seed
# below. api._query_budget does the arithmetic and /recall states it when the
# corpus is what cut the budget.
RECALL_RESERVE = 0.4

# The seed for the per-unit ranking cost, from the table above. Used only until
# this process has timed a search of its own, and then only if it is the larger
# of the two. 2026-09-10.
RANK_SECONDS_PER_UNIT_SEED = 50e-6

# The smallest budget worth handing the embedder at all. A warm embed measured
# 17-26 ms here, so this is roughly ten warm calls of headroom; below it a call
# fails on the clock rather than on the model, and "the embedding service did
# not answer within 0.03s" is a sentence about the wrong thing. When the
# derived budget falls under this, /recall does not call the embedder at all
# and says that ranking this many notes is why. 2026-09-10.
MIN_QUERY_BUDGET = 0.25

# The ceiling: what the question's budget is over a scope small enough that its
# ranking disappears into the floor above. MEMORY_EMBED_QUERY_TIMEOUT overrides
# it, and the derived budget can only ever come in UNDER it.
DEFAULT_QUERY_TIMEOUT = CORE_RECALL_TIMEOUT - RECALL_RESERVE

# Texts per request. MEASURED, because the assumption was wrong in both
# directions.
#
# The claim this batch size inherited was that one big request amortises the
# model's cost. The counter-claim, from a probe taken while the GPU was busy,
# was that a batch of 40 took 5,167 ms — 130 ms an item against 8-10 ms for a
# warm single — and that batching was therefore a pessimisation. Neither
# survived measurement. Timed on this box 2026-09-09 over the real 74-chunk
# corpus, GPU idle, batched request against the same texts sent one at a time:
#
#     n    batched          singles          ratio
#     4    176 ms  (44/item)  163 ms (41/item)  0.92
#     8    300 ms  (38/item)  339 ms (42/item)  1.13
#    16    586 ms  (37/item)  664 ms (42/item)  1.13
#    32  1,343 ms  (42/item) 1,454 ms (45/item) 1.08
#    74  1,978 ms  (27/item) 2,058 ms (28/item) 1.04
#
# Batching is a WASH — 0.9x to 1.3x across a second run too. ollama embeds the
# inputs one after another; all a batch saves is the HTTP round trip. The
# 130 ms an item in the contended probe was the GPU, not the batch: the same
# contention makes a single call take 5-31 s.
#
# So the batch size is not a throughput decision, because there is no
# throughput to win. It is chosen for RESUMPTION GRANULARITY: a call that
# times out loses everything in it, and the pass can only stop between calls.
# Eight is ~300 ms of work idle, a few seconds contended, and eight units of
# loss in the worst case.
DEFAULT_BATCH = 8

# What a WRITE path may spend embedding inline before handing the rest to the
# background pass. /ingest and /save are awaited by core inside its 10 s
# budget, and the new exchange is one call (~25 ms warm), so a second is forty
# warm units of margin. A slice that runs out is not a failure and does not
# read as one — see BackfillReport.out_of_budget and the sentence beside it.
DEFAULT_SLICE_SECONDS = 1.0

# How long the background pass waits before trying again after a STATED
# failure, and how many times. The failures it actually meets resolve on their
# own — the owner has not pulled the model yet, or a 27B is holding the GPU —
# so giving up on the first one would mean waiting for the next restart, which
# is the behaviour this pass exists to replace. It gives up eventually rather
# than never, and says so in the log when it does, because a pass that retried
# for ever would be indistinguishable from one that was working.
DEFAULT_RETRY_SECONDS = 60.0
DEFAULT_MAX_ATTEMPTS = 20


class EmbedderUnavailable(Exception):
    """No vectors, and the finished sentence saying why not.

    `str(exc)` is what reaches /recall's `retrievers` and, through core, the
    prompt. It is written to be repeatable by Nova to the owner as-is.
    """


class TextTooLong(EmbedderUnavailable):
    """ONE text is longer than the model's context — not an unavailability.

    Its own class because it is the one failure with a fix that is not "tell
    somebody": the text can be embedded in pieces (see `embed_windows`). It
    subclasses EmbedderUnavailable so a caller that only knows about the
    general case still gets a stated sentence rather than an unhandled crash.
    """


@dataclass(frozen=True)
class EmbedConfig:
    url: str
    model: str
    timeout: float
    query_timeout: float
    batch: int
    slice_seconds: float
    keep_alive_seconds: float
    retry_seconds: float
    max_attempts: int

    @classmethod
    def from_env(cls) -> EmbedConfig:
        return cls(
            url=os.environ.get("MEMORY_EMBED_URL", DEFAULT_URL).strip().rstrip("/"),
            model=os.environ.get("MEMORY_EMBED_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
            timeout=_float_env("MEMORY_EMBED_TIMEOUT", DEFAULT_TIMEOUT),
            query_timeout=_float_env("MEMORY_EMBED_QUERY_TIMEOUT", DEFAULT_QUERY_TIMEOUT),
            batch=max(1, int(_float_env("MEMORY_EMBED_BATCH", DEFAULT_BATCH))),
            # Zero is a real setting here, unlike every other budget: it
            # means "embed nothing inline, hand the whole backlog to the
            # background pass", which is what a deployment that never wants a
            # write to wait would ask for.
            slice_seconds=_nonnegative_env("MEMORY_EMBED_SLICE_SECONDS", DEFAULT_SLICE_SECONDS),
            # The one budget that may legitimately be negative: -1 is ollama's
            # "keep it resident until something evicts it", so this reads the
            # value itself rather than going through _float_env's positive-only
            # guard, and 0 (unload immediately after the call) stays available
            # to a deployment that wants the VRAM back between turns.
            keep_alive_seconds=_keep_alive_env(
                "MEMORY_EMBED_KEEP_ALIVE_SECONDS", DEFAULT_KEEP_ALIVE_SECONDS
            ),
            retry_seconds=_float_env("MEMORY_EMBED_RETRY_SECONDS", DEFAULT_RETRY_SECONDS),
            max_attempts=max(1, int(_float_env("MEMORY_EMBED_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS))),
        )

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    @property
    def model_slug(self) -> str:
        """The model name as a filename component — the cache is per model."""
        return "".join(ch if ch.isalnum() or ch in "-_." else "-" for ch in self.model)


def _nonnegative_env(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("%s=%r is not a number — using %s", name, raw, default)
        return default
    if value < 0:
        logger.warning("%s=%r is negative — using %s", name, raw, default)
        return default
    return value


def _keep_alive_env(name: str, default: float) -> float:
    """How long the model stays resident, in seconds. -1 means "for ever"."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("%s=%r is not a number — using %s", name, raw, default)
        return default
    if value < -1:
        logger.warning(
            "%s=%r is not a duration (only -1, meaning for ever, is negative) — using %s",
            name,
            raw,
            default,
        )
        return default
    return value


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("%s=%r is not a number — using %s", name, raw, default)
        return default
    if value <= 0:
        logger.warning("%s=%r is not positive — using %s", name, raw, default)
        return default
    return value


def digest_of(text: str) -> str:
    """The cache key: a hash of the EXACT text that gets embedded.

    Re-indexing rewrites every unit of a journal on every append — the file is
    re-read whole — so without this every ingest would re-embed the whole day.
    Keyed on the text and not on the unit id, because an id is a place and the
    vector is a property of the words: an exchange that moves, or a note that
    is re-saved unchanged, keeps its vector.
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class Embedder:
    """One ollama /api/embed endpoint, and the sentences for its failures."""

    def __init__(self, config: EmbedConfig, *, transport: httpx.AsyncBaseTransport | None = None):
        self.config = config
        # Injected only by tests (httpx.MockTransport), so the error mapping
        # below is exercised against the real client code rather than a stub
        # that re-states the mapping and can drift from it.
        self._transport = transport

    def unavailable_reason(self) -> str | None:
        """Why semantic recall cannot run at all, before any call is made."""
        if not self.config.enabled:
            return (
                "semantic search is switched off in this deployment — no embedding service "
                "is configured (MEMORY_EMBED_URL is empty)"
            )
        return None

    async def embed_query(self, text: str, *, timeout: float | None = None) -> list[float]:
        """The question, embedded under the tighter on-the-turn budget.

        `timeout` is that budget when the caller derived one from the live
        corpus (api._query_budget) — ranking grows with the scope and what is
        left for the model shrinks with it. None uses the configured ceiling.

        Not windowed, unlike a note: a question is one thing being asked, and
        half of it is not a smaller version of it. One past the model's
        context gets its own sentence rather than the note-shaped one from
        `embed`, because "the question was too long to match by meaning" and
        "one of these notes is too long" are different facts and only one of
        them is true here.
        """
        ceiling = self.config.query_timeout
        budget = ceiling if timeout is None else min(timeout, ceiling)
        try:
            vectors = await self.embed([text], timeout=budget)
        except TextTooLong as exc:
            raise TextTooLong(
                f"the question is longer than {self.config.model!r} can read in one go, so it "
                f"could not be matched by meaning at all — {self.config.url} refused it"
            ) from exc
        return vectors[0]

    async def embed_windows(self, text: str) -> list[list[float]]:
        """Vectors covering ALL of `text` — one when it fits, more when not.

        A unit longer than the model's context is split at white space near
        its middle and each half embedded, recursively, so the whole text is
        represented instead of its first 2,048 tokens. The window count is
        derived from the service's own refusals: nothing here knows or
        configures a context length, which is what keeps it right when the
        deployment is pointed at a different embedder tomorrow.

        Raises TextTooLong only for a text with no white space to split on,
        which leaves that unit with no vector — and `vector_coverage` then
        says so on every recall, rather than a partial vector pretending to
        stand for the whole note.
        """
        try:
            return await self.embed([text])
        except TextTooLong:
            head, tail = _split_text(text)
            if head is None or tail is None:
                # Nothing to split on: the caller keeps the stated sentence
                # and this unit stays unembedded, which recall reports.
                raise
        return await self.embed_windows(head) + await self.embed_windows(tail)

    async def embed(self, texts: list[str], *, timeout: float | None = None) -> list[list[float]]:
        """Vectors for `texts`, in order. Raises EmbedderUnavailable, never
        returns a short or empty list to be interpreted by the caller."""
        off = self.unavailable_reason()
        if off:
            raise EmbedderUnavailable(off)
        if not texts:
            return []
        budget = self.config.timeout if timeout is None else timeout
        url = f"{self.config.url}/api/embed"
        # truncate=False is the whole reason this is spelled out.
        #
        # ollama's default is truncate=true: a text past the model's context
        # is silently embedded from its head, 200 OK, no field saying so.
        # Measured against this deployment (nomic-embed-text, 2048 tokens): a
        # 4,500-word input answered 200 with prompt_eval_count 2048, and the
        # live corpus holds one 11 KB exchange — a pasted review — that would
        # have had its last 3 KB represented by nothing. The retriever would
        # then rank that note on two thirds of its words and, when the answer
        # was in the missing third, say "no note here resembles the question",
        # which is a claim about text nobody ever embedded. So the service is
        # told to refuse instead, and `embed_windows` embeds the pieces.
        # keep_alive, on EVERY call, for the reason measured beside
        # DEFAULT_KEEP_ALIVE_SECONDS: ollama unloads an idle model after five
        # minutes, the proactive beat asks hourly, and a cold load costs
        # ~1.5 s against a warm call's ~20 ms. Sent on the backfill's calls as
        # well as the query's, so the pass that fills the corpus at boot is
        # also what leaves the model warm for the first question.
        payload = {
            "model": self.config.model,
            "input": texts,
            "truncate": False,
            "keep_alive": self.config.keep_alive_seconds,
        }
        try:
            async with httpx.AsyncClient(timeout=budget, transport=self._transport) as client:
                response = await client.post(url, json=payload)
        except httpx.TimeoutException as exc:
            raise EmbedderUnavailable(
                f"the embedding service at {self.config.url} did not answer within "
                f"{budget:g}s ({type(exc).__name__})"
            ) from exc
        except httpx.HTTPError as exc:
            raise EmbedderUnavailable(
                f"the embedding service at {self.config.url} could not be reached "
                f"({type(exc).__name__}: {exc})"
            ) from exc
        if response.status_code != 200:
            raise EmbedderUnavailable(self._failure_sentence(response))
        return self._vectors_from(response, len(texts))

    def _failure_sentence(self, response: httpx.Response) -> str:
        """Which non-200 this is. Three distinct facts, not one.

        ollama answers a model it has never pulled with 404 and
        `model "x" not found, try pulling it first`, and a model that exists
        but cannot embed (a chat model) with 501 `This server does not support
        embeddings`. Those are a missing install and a wrong choice of model —
        different problems with different fixes, so they get different
        sentences. The status codes are checked with the message rather than
        instead of it, so a server that changes its wording still lands
        somewhere true.
        """
        said = _error_text(response)
        model = self.config.model
        where = self.config.url
        lowered = said.lower()
        if "context length" in lowered or "too long" in lowered:
            # Raised, and caught by embed_windows, which splits and retries.
            # It reaches a caller only when a text cannot be split at all.
            raise TextTooLong(
                f"one of these notes is longer than {model!r} can read in one go, and it has no "
                f"white space to split on — {where} answered: {said}"
            )
        if response.status_code == 404 or "not found" in lowered:
            return (
                f"the embedding model {model!r} is not installed on the embedding service "
                f"at {where} — it answered: {said}"
            )
        if response.status_code == 501 or "does not support embeddings" in lowered:
            return (
                f"the model {model!r} on {where} cannot produce embeddings at all — "
                f"it answered: {said}"
            )
        return (
            f"the embedding service at {where} answered HTTP {response.status_code} "
            f"for model {model!r}: {said}"
        )

    def _vectors_from(self, response: httpx.Response, expected: int) -> list[list[float]]:
        """A 200 is not an answer until it has been read.

        Everything here is a way for a 200 to be useless — a body that is not
        JSON, an `embeddings` that is missing or the wrong length, a row that
        is not numbers, a vector of zeros that cannot be normalised. Each one
        raises with what was actually wrong, because "the embedder answered
        something unexpected" on its own is not a fact anybody can act on.
        """
        where = self.config.url
        try:
            body = response.json()
        except ValueError as exc:
            raise EmbedderUnavailable(
                f"the embedding service at {where} answered 200 with something that is not "
                f"JSON ({exc})"
            ) from exc
        if not isinstance(body, dict) or not isinstance(body.get("embeddings"), list):
            raise EmbedderUnavailable(
                f"the embedding service at {where} answered 200 without an `embeddings` list "
                f"(keys: {sorted(body) if isinstance(body, dict) else type(body).__name__})"
            )
        rows = body["embeddings"]
        if len(rows) != expected:
            raise EmbedderUnavailable(
                f"the embedding service at {where} returned {len(rows)} vectors for "
                f"{expected} texts"
            )
        vectors: list[list[float]] = []
        for position, row in enumerate(rows):
            if not isinstance(row, list) or not row:
                raise EmbedderUnavailable(
                    f"the embedding service at {where} returned an empty or non-list vector "
                    f"at position {position}"
                )
            try:
                vector = [float(value) for value in row]
            except (TypeError, ValueError) as exc:
                raise EmbedderUnavailable(
                    f"the embedding service at {where} returned a vector at position "
                    f"{position} that is not numbers ({exc})"
                ) from exc
            if not all(math.isfinite(value) for value in vector):
                raise EmbedderUnavailable(
                    f"the embedding service at {where} returned a vector at position "
                    f"{position} containing NaN or infinity"
                )
            normalised = normalise(vector)
            if normalised is None:
                raise EmbedderUnavailable(
                    f"the embedding service at {where} returned an all-zero vector at "
                    f"position {position}, which has no direction to compare"
                )
            vectors.append(normalised)
        widths = {len(vector) for vector in vectors}
        if len(widths) > 1:
            raise EmbedderUnavailable(
                f"the embedding service at {where} returned vectors of different widths "
                f"({sorted(widths)}) in one answer"
            )
        return vectors


def _error_text(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text.strip()[:200] or "(no body)"
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        return body["error"].strip()[:200]
    return str(body)[:200]


def normalise(vector: list[float]) -> list[float] | None:
    """Unit-length copy, or None for the zero vector.

    ollama already returns unit vectors, which is exactly why this runs
    anyway: an assumption about somebody else's output that nothing checks is
    how a dot product silently stops being a cosine the day a different
    embedder is configured.
    """
    norm = math.sqrt(sum(value * value for value in vector))
    if norm <= 0.0:
        return None
    if abs(norm - 1.0) < 1e-6:
        return vector
    return [value / norm for value in vector]


def dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def _split_text(text: str) -> tuple[str | None, str | None]:
    """Halve `text` at the white space nearest its middle.

    A blank line first, then any newline, then a space — the boundaries a
    transcript actually has, in the order that keeps a window readable. The
    halves are what get embedded, so a split through the middle of a sentence
    costs the meaning of that sentence in one window; a split between
    paragraphs costs nothing.

    (None, None) when there is no white space to cut on, which is the one case
    a unit cannot be embedded at all.
    """
    middle = len(text) // 2
    for separator in ("\n\n", "\n", " "):
        left = text.rfind(separator, 0, middle)
        right = text.find(separator, middle)
        candidates = [pos for pos in (left, right) if pos > 0]
        if not candidates:
            continue
        best = min(candidates, key=lambda pos: abs(pos - middle))
        head = text[:best].strip()
        tail = text[best + len(separator) :].strip()
        if head and tail:
            return head, tail
    return None, None


class VectorCache:
    """digest -> vector, held in memory and written beside the notes.

    THE PERSISTENCE DECISION, and what it costs at 100x this corpus.

    The live corpus is 47 chunks. Embedding all of them measured 4.0 s in one
    request, so embedding at every boot would be nearly free and no cache
    would be needed. It is cached anyway, because the shape of the bill is the
    problem and not its size today: the cost is linear in the corpus and it is
    paid at EVERY start, while the corpus only ever grows. A hundred times
    this corpus is 4,700 chunks — roughly a year of journals at the current
    rate — which is about 6.5 minutes of embedding on every restart, in front
    of a startup that a healthcheck is waiting on. With the cache it is a one
    time cost. Measured on his real corpus rather than estimated: the cache
    for 74 units is 314 KB, 4,247 bytes a unit, so a hundred times this
    corpus is a 20 MB file that loads in well under a second and a restart
    re-embeds nothing at all. (A unit that had to be split carries a vector
    per window; one note in 48 does today, which is where the 4,247 sits
    above the 3,157 bytes a single 768-float vector costs.)

    The file lives at MEMORY_ROOT/.embeddings/<model>.jsonl — beside the notes
    and inside the service's own volume, but OUTSIDE people/, so it is not
    walked by iter_all (which globs people/**/*.md) and not swept into
    /export's tar of a person's files. Per model, because vectors from two
    models share no space and mixing them would produce rankings that look
    fine and mean nothing.

    Not postgres, deliberately. The service's whole recall path is in-process
    with no database in it — app/analysis.py says why that matters: /recall
    must be able to say WHICH nothing it found, and a database on the read
    path adds a third failure that is neither. The cache is read once at
    startup and appended on write, so a file gets the same durability with
    none of that.
    """

    def __init__(self, path: Path):
        self.path = path
        # digest -> the WINDOWS covering that text. One entry for a note that
        # fits the model's context, more for one that had to be split (see
        # Embedder.embed_windows) — the unit's vector is a list because a
        # single vector could only ever stand for part of a long note.
        self._vectors: dict[str, list[list[float]]] = {}
        self._loaded = False

    def load(self) -> dict[str, list[list[float]]]:
        """Read the cache file. A corrupt line is dropped and named, never
        fatal: a half-written vector costs one re-embed, and refusing to start
        over it would cost the whole service."""
        self._vectors = {}
        self._loaded = True
        if not self.path.is_file():
            return self._vectors
        kept = 0
        dropped = 0
        for line in self.path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            vector = _decode_line(line)
            if vector is None:
                dropped += 1
                continue
            digest, values = vector
            self._vectors[digest] = values
            kept += 1
        if dropped:
            logger.warning(
                "embedding cache %s: kept %d vectors, dropped %d lines that were unreadable or "
                "written in an older format (those are re-embedded, because a vector from a "
                "version that could truncate silently cannot be told from a whole one)",
                self.path,
                kept,
                dropped,
            )
        return self._vectors

    def get(self, digest: str) -> list[list[float]] | None:
        return self._vectors.get(digest)

    def add(self, pairs: list[tuple[str, list[list[float]]]]) -> None:
        """Remember and append. Written as it is produced rather than at exit,
        so a service killed mid-backfill keeps what it had already paid for."""
        if not pairs:
            return
        for digest, windows in pairs:
            self._vectors[digest] = windows
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            for digest, windows in pairs:
                handle.write(_encode_line(digest, windows) + "\n")

    def drop(self, digests: set[str]) -> int:
        """Forget specific vectors and rewrite the file without them.

        `prune` removes what the NOTES no longer hold; this removes what the
        MODEL no longer produces — windows of a width the live embedder cannot
        answer with any more (BM25Index.set_vector_width). Both have to exist:
        leaving a wrong-width line on disk means the next boot reads it back
        in, the index counts the unit as embedded, the backfill finds nothing
        to do, and semantic recall is dead until somebody edits the note.
        2026-09-10.
        """
        if not self._loaded:
            return 0
        gone = [digest for digest in digests if digest in self._vectors]
        if not gone:
            return 0
        for digest in gone:
            del self._vectors[digest]
        self._rewrite()
        return len(gone)

    def _rewrite(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".jsonl.tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            for digest, windows in self._vectors.items():
                handle.write(_encode_line(digest, windows) + "\n")
        temporary.replace(self.path)

    def prune(self, live: set[str]) -> int:
        """Rewrite the file with only the vectors still in the index.

        Without this the file grows forever: every edited exchange and every
        forgotten note leaves its vector behind, and at a year of journals
        that is most of the file. Called once after the startup pass, when the
        live set is known and nothing is mid-write.
        """
        if not self._loaded:
            return 0
        stale = [digest for digest in self._vectors if digest not in live]
        if not stale:
            return 0
        for digest in stale:
            del self._vectors[digest]
        self._rewrite()
        return len(stale)


def cache_path(root: Path, config: EmbedConfig) -> Path:
    return root / ".embeddings" / f"{config.model_slug}.jsonl"


# The cache line format, and why a line has to carry it.
#
# Format 1 was one vector per text, written while the embedder let ollama
# truncate silently — so a line for a text longer than the model's context is
# a vector of its first 2,048 tokens and NOTHING in the line says so. It
# cannot be told from a good one, so it is not trusted: format 1 lines are
# dropped on load and re-embedded (47 chunks, seconds). Trusting them would
# keep exactly the silent half-vector this change exists to remove, and keep
# it for as long as the note goes unedited.
CACHE_FORMAT = 2


def _width_of(pairs: list[tuple[str, list[list[float]]]]) -> int | None:
    """The width of vectors the model just produced, from the answer itself."""
    for _digest, windows in pairs:
        for window in windows:
            if window:
                return len(window)
    return None


def _encode_line(digest: str, windows: list[list[float]]) -> str:
    """One cache line: the format, the text hash, the width, and the windows."""
    blobs = [base64.b64encode(array("f", window).tobytes()).decode("ascii") for window in windows]
    width = len(windows[0]) if windows else 0
    return json.dumps(
        {"f": CACHE_FORMAT, "h": digest, "d": width, "v": blobs}, separators=(",", ":")
    )


def _decode_line(line: str) -> tuple[str, list[list[float]]] | None:
    try:
        record = json.loads(line)
        if record.get("f") != CACHE_FORMAT:
            return None
        digest = record["h"]
        width = int(record["d"])
        blobs = record["v"]
    except (ValueError, KeyError, TypeError, AttributeError):
        return None
    if not isinstance(blobs, list) or not blobs or not width:
        return None
    windows = []
    for blob in blobs:
        values = array("f")
        try:
            values.frombytes(base64.b64decode(blob))
        except (ValueError, TypeError):
            return None
        if len(values) != width:
            return None
        windows.append(list(values))
    return digest, windows


@dataclass
class BackfillReport:
    """What one embedding pass actually did — for the log and for the tests.

    THREE OUTCOMES THAT MUST NOT LOOK ALIKE, which is why this is a record and
    not a boolean:

      * `failed` — the sentence from EmbedderUnavailable. Something is wrong
        with the service and the pass could not go on.
      * `out_of_budget` — the pass was WORKING and a slice budget stopped it
        on a batch boundary. `budget_note` is the sentence for it, and it says
        so in those words, because a slice that cut real work reading as a
        failure is exactly the confusion that made a healthy embedder look
        broken at boot on 2026-09-09.
      * `deferred` — nothing was attempted because another pass over the same
        notes is already running. Not a failure and not a budget; the work is
        happening, just not here.

    `remaining` is how many units still have no vector when the pass stopped —
    the number that says whether anything is left to do, rather than leaving a
    caller to subtract.
    """

    requested: int = 0
    embedded: int = 0
    from_cache: int = 0
    failed: str | None = None
    seconds: float = 0.0
    out_of_budget: bool = False
    budget_note: str | None = None
    deferred: str | None = None
    remaining: int = 0
    # Units the embedder refused because they exceed its context and have no
    # white space to split on. NOT a `failed`: the pass ran and everything
    # else is embedded. Each one leaves a unit with no vector, which
    # BM25Index.vector_coverage then states on every recall — the sentences
    # are here so a log says which note it was.
    too_long: tuple[str, ...] = ()
    # The digests of those units. A background pass that keeps asking for them
    # would never finish, so it takes them off its own list — and this is how
    # it learns which ones, from the pass that actually met them, rather than
    # from a rule that guesses.
    unembeddable: tuple[str, ...] = ()
    # The WIDTH of the vectors this pass actually got back, or None when it
    # made no successful call. This is the only place the live model's width is
    # a fact rather than an assumption, and api.py hands it to
    # BM25Index.set_vector_width so a corpus embedded at another width is
    # invalidated instead of counting as done for ever. 2026-09-10.
    width: int | None = None
    # Vectors dropped because they were that other width. Not a failure — the
    # work simply has to be done again — but the pass must go round once more,
    # and the caller can only know that from here.
    stale_width: int = 0

    @property
    def done(self) -> bool:
        """Every unit this pass was given now has a vector, or provably cannot.

        `stale_width` counts against it: a pass whose vectors came back at a new
        width has just invalidated notes that are not in `remaining`, and there
        is more to do. 2026-09-10.
        """
        return (
            self.remaining == 0 and not self.stale_width and not self.failed and not self.deferred
        )


async def backfill(
    embedder: Embedder,
    cache: VectorCache,
    missing: list[tuple[str, str]],
    *,
    apply,
    slice_seconds: float | None = None,
) -> BackfillReport:
    """Embed `missing` — (digest, text) pairs — and hand each vector to
    `apply(digest, vector)`.

    A vector is a LIST of windows: one for a note that fits the model's
    context, more for one that had to be split to be covered whole.

    THE BUDGET IS ON THE CALL, NOT ON THE PASS. Every HTTP call is bounded by
    `embedder.config.timeout`, which is what "the service did not answer"
    means. `slice_seconds` is a different thing and is optional: it is the
    wall clock a CALLER is prepared to wait, and it exists for the write paths
    that core is awaiting. The background pass passes None and simply runs
    until the work is done, because nothing is waiting on it and a job that
    takes four minutes is not a job that failed.

    Cached digests are applied without a call. A slice that runs out stops on
    a batch boundary and says so as a budget rather than as a failure. A
    service failure stops the pass and is reported, never swallowed — a
    backfill that quietly embedded nothing and said nothing is how recall ends
    up calling itself semantic over an empty vector space.
    """
    report = BackfillReport(requested=len(missing))
    started = time.monotonic()
    todo: list[tuple[str, str]] = []
    for dig, text in missing:
        cached = cache.get(dig)
        if cached is not None:
            apply(dig, cached)
            report.from_cache += 1
        else:
            todo.append((dig, text))
    too_long: list[str] = []
    unembeddable: list[str] = []
    if not todo:
        report.seconds = time.monotonic() - started
        return report
    off = embedder.unavailable_reason()
    if off:
        report.failed = off
        report.remaining = len(todo)
        report.seconds = time.monotonic() - started
        return report
    batch = embedder.config.batch
    done = 0
    for start in range(0, len(todo), batch):
        if slice_seconds is not None and time.monotonic() - started >= slice_seconds:
            report.out_of_budget = True
            report.budget_note = (
                f"this pass was given {slice_seconds:g}s and used it; "
                f"{len(todo) - done} note(s) are still waiting for a vector and a background "
                f"pass continues from here — the embedding service answered every call it was "
                f"asked"
            )
            break
        chunk = todo[start : start + batch]
        try:
            vectors = await embedder.embed([text for _dig, text in chunk])
            pairs = [(dig, [vector]) for (dig, _text), vector in zip(chunk, vectors, strict=True)]
        except TextTooLong:
            # One text in the batch is past the model's context, and a batch
            # is all-or-nothing, so the batch is retried one text at a time —
            # each split into windows if it needs to be. Only the long ones
            # pay the extra calls, and only when there are any.
            pairs = []
            refused = 0
            for dig, text in chunk:
                try:
                    pairs.append((dig, await embedder.embed_windows(text)))
                except TextTooLong as exc:
                    too_long.append(str(exc))
                    unembeddable.append(dig)
                    refused += 1
                except EmbedderUnavailable as exc:
                    report.failed = str(exc)
                    break
            done += len(pairs) + refused
            if pairs:
                cache.add(pairs)
                for dig, windows in pairs:
                    apply(dig, windows)
                report.embedded += len(pairs)
                report.width = _width_of(pairs) or report.width
            if report.failed:
                break
            continue
        except EmbedderUnavailable as exc:
            report.failed = str(exc)
            break
        cache.add(pairs)
        for dig, windows in pairs:
            apply(dig, windows)
        report.embedded += len(pairs)
        report.width = _width_of(pairs) or report.width
        done += len(chunk)
    report.too_long = tuple(too_long)
    report.unembeddable = tuple(unembeddable)
    report.remaining = max(0, len(todo) - report.embedded - len(unembeddable))
    report.seconds = time.monotonic() - started
    return report
