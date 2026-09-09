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

# One HTTP call's budget. A warm single-text embed measured 25-35 ms against
# the bundled ollama; the first call after the model is idle-unloaded measured
# 1.2 s, and a cold pull-then-load is slower still. 5 s is generous for the
# warm case and still returns a stated failure long before core's own 10 s
# ingest budget expires.
DEFAULT_TIMEOUT = 5.0

# The budget for the ONE call /recall makes — embedding the question. It is
# separate and much tighter than DEFAULT_TIMEOUT because it is the only
# embedding call on a turn's critical path, and core gives the whole of
# /recall 2.0 s (services/core/app/chat.py RECALL_TIMEOUT). An embedder that
# is merely slow must leave memory enough time to answer "I searched by words
# alone because the embedder did not answer in time" — if the call ran to the
# 5 s budget instead, core would time out and Nova would be told memory was
# unreachable, which is a different and false statement about what happened.
DEFAULT_QUERY_TIMEOUT = 1.5

# Texts per request. The whole 47-chunk fixture corpus in ONE request measured
# 4.0 s; sixteen at a time keeps any single call short enough that a budget
# can actually stop between batches instead of only after everything.
DEFAULT_BATCH = 16

# How long a backfill pass may spend embedding documents. Used at startup and
# on the write paths (/ingest, /save), never on /recall — see api.py. A pass
# that runs out of budget stops on a batch boundary and leaves the rest for
# the next write, so the corpus fills in over a few turns instead of one call
# blowing a caller's timeout.
DEFAULT_BACKFILL_SECONDS = 5.0


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
    backfill_seconds: float

    @classmethod
    def from_env(cls) -> EmbedConfig:
        return cls(
            url=os.environ.get("MEMORY_EMBED_URL", DEFAULT_URL).strip().rstrip("/"),
            model=os.environ.get("MEMORY_EMBED_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
            timeout=_float_env("MEMORY_EMBED_TIMEOUT", DEFAULT_TIMEOUT),
            query_timeout=_float_env("MEMORY_EMBED_QUERY_TIMEOUT", DEFAULT_QUERY_TIMEOUT),
            batch=max(1, int(_float_env("MEMORY_EMBED_BATCH", DEFAULT_BATCH))),
            backfill_seconds=_float_env("MEMORY_EMBED_BACKFILL_SECONDS", DEFAULT_BACKFILL_SECONDS),
        )

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    @property
    def model_slug(self) -> str:
        """The model name as a filename component — the cache is per model."""
        return "".join(ch if ch.isalnum() or ch in "-_." else "-" for ch in self.model)


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

    async def embed_query(self, text: str) -> list[float]:
        """The question, embedded under the tighter on-the-turn budget."""
        vectors = await self.embed([text], timeout=self.config.query_timeout)
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
            pass
        head, tail = _split_text(text)
        if head is None or tail is None:
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
        payload = {"model": self.config.model, "input": texts, "truncate": False}
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
    time cost: 4,700 vectors is 14 MB of float32, stored base64 in a JSONL
    file of about 19 MB, which loads in well under a second, and a restart
    re-embeds nothing at all.

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
        self._vectors: dict[str, list[float]] = {}
        self._loaded = False

    def load(self) -> dict[str, list[float]]:
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
                "embedding cache %s: kept %d vectors, dropped %d unreadable lines",
                self.path,
                kept,
                dropped,
            )
        return self._vectors

    def get(self, digest: str) -> list[float] | None:
        return self._vectors.get(digest)

    def add(self, pairs: list[tuple[str, list[float]]]) -> None:
        """Remember and append. Written as it is produced rather than at exit,
        so a service killed mid-backfill keeps what it had already paid for."""
        if not pairs:
            return
        for digest, vector in pairs:
            self._vectors[digest] = vector
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            for digest, vector in pairs:
                handle.write(_encode_line(digest, vector) + "\n")

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
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".jsonl.tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            for digest, vector in self._vectors.items():
                handle.write(_encode_line(digest, vector) + "\n")
        temporary.replace(self.path)
        return len(stale)


def cache_path(root: Path, config: EmbedConfig) -> Path:
    return root / ".embeddings" / f"{config.model_slug}.jsonl"


def _encode_line(digest: str, vector: list[float]) -> str:
    blob = base64.b64encode(array("f", vector).tobytes()).decode("ascii")
    return json.dumps({"h": digest, "d": len(vector), "v": blob}, separators=(",", ":"))


def _decode_line(line: str) -> tuple[str, list[float]] | None:
    try:
        record = json.loads(line)
        digest = record["h"]
        width = int(record["d"])
        raw = base64.b64decode(record["v"])
    except (ValueError, KeyError, TypeError):
        return None
    values = array("f")
    try:
        values.frombytes(raw)
    except ValueError:
        return None
    if len(values) != width or not width:
        return None
    return digest, list(values)


@dataclass
class BackfillReport:
    """What one embedding pass actually did — for the log and for the tests.

    `failed` is the sentence from EmbedderUnavailable, not a boolean: a pass
    that could not run has to be able to say which unavailability it hit, in
    the same words /recall will use.
    """

    requested: int = 0
    embedded: int = 0
    from_cache: int = 0
    failed: str | None = None
    seconds: float = 0.0
    out_of_budget: bool = False


async def backfill(
    embedder: Embedder,
    cache: VectorCache,
    missing: list[tuple[str, str]],
    *,
    apply,
    budget: float | None = None,
) -> BackfillReport:
    """Embed `missing` — (digest, text) pairs — and hand each vector to
    `apply(digest, vector)`.

    Cached digests are applied without a call. Everything else is embedded in
    batches until the budget runs out, and a pass that stops early says so:
    the next write picks up where it left off. A failure stops the pass and is
    reported, never swallowed — a backfill that quietly embedded nothing and
    said nothing is how recall ends up calling itself semantic over an empty
    vector space.
    """
    report = BackfillReport(requested=len(missing))
    started = time.monotonic()
    budget = embedder.config.backfill_seconds if budget is None else budget
    todo: list[tuple[str, str]] = []
    for dig, text in missing:
        cached = cache.get(dig)
        if cached is not None:
            apply(dig, cached)
            report.from_cache += 1
        else:
            todo.append((dig, text))
    if not todo:
        report.seconds = time.monotonic() - started
        return report
    off = embedder.unavailable_reason()
    if off:
        report.failed = off
        report.seconds = time.monotonic() - started
        return report
    batch = embedder.config.batch
    for start in range(0, len(todo), batch):
        if time.monotonic() - started >= budget:
            report.out_of_budget = True
            break
        window = todo[start : start + batch]
        try:
            vectors = await embedder.embed([text for _dig, text in window])
        except EmbedderUnavailable as exc:
            report.failed = str(exc)
            break
        pairs = [(dig, vector) for (dig, _text), vector in zip(window, vectors, strict=True)]
        cache.add(pairs)
        for dig, vector in pairs:
            apply(dig, vector)
        report.embedded += len(pairs)
    report.seconds = time.monotonic() - started
    return report
