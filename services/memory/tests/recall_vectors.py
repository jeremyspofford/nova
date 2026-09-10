"""Recorded vectors: the semantic half of recall, measured without a model.

WHY A RECORDING RATHER THAN A LIVE CALL

The hybrid numbers in test_recall_quality.py were only ever measurable on a
machine that had ollama running and nomic-embed-text pulled. Everywhere else
the pass skipped, which meant the number that justifies this whole sub-slice —
answer-in-context with meaning turned on — was checked on one laptop and
nowhere else, and a regression in fusion, in the floor, or in the coverage
rule would reach main without anything noticing.

The alternative that does NOT work is a hand-built vector space. There is one
already, in test_hybrid_recall.py, and it is right for what it does: it pins
the ARITHMETIC of the floor against a geometry chosen to exercise it. It
cannot measure quality, because the answer it gives is the answer its author
built into it. A quality number has to come from the model.

So the model's real answers are recorded once, against the fixture corpus, and
replayed. What is replayed is a fact the model produced, not a shape somebody
chose, and it costs no network and no GPU to check.

WHAT IS RECORDED, AND THE ONE THING THAT IS NOT VERBATIM

Every text /recall would embed for the fixture corpus: the 47 chunk texts and
the 26 question texts. Each is stored as the exact float32 vector
nomic-embed-text returned for it.

The key is a hash of the text with every ISO date replaced by a placeholder,
and that is the one concession. The fixture rebases its journals so the corpus
is always the same age relative to today — which is what keeps the recency
multiplier, and therefore the LEXICAL half, constant from one day to the next.
The cost is that a chunk's text carries its own date in its title, so a
verbatim key would stop matching tomorrow. Normalising the date makes the key
stable, and the vector then belongs to the text as it stood on the recording
day rather than to the text as built today. Those differ in ten characters of
a title out of a few hundred, and nowhere in the sentences a question is
matched against.

That is stated because it is a fidelity claim, and this file's own rule is
that a miss is LOUD: a text with no recorded vector raises, naming the text.
There is no path here that returns a zero vector, an empty list, or a
plausible-looking substitute — a fake embedder that quietly invents an answer
would turn this suite into the exact silent-fallback lie the feature it
measures exists to prevent.

RE-RECORDING

    MEMORY_RECALL_EMBED_URL=http://127.0.0.1:11434 \
        uv run python -m tests.recall_vectors

from services/memory, with the model pulled. It rewrites the file below and
prints what it wrote. Re-record when the fixture corpus changes, when the
model changes, or when a question is added — and then re-measure the pinned
numbers in test_recall_quality.py and say in the commit which way they moved.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import os
import re
import sys
from array import array
from dataclasses import dataclass
from pathlib import Path

import httpx

FIXTURES = Path(__file__).resolve().parent / "fixtures"
MODEL = "nomic-embed-text"


def path_for(model: str = MODEL) -> Path:
    """One file per model. Vectors from two models share no space, and mixing
    them would produce a ranking that looks fine and means nothing."""
    slug = "".join(ch if ch.isalnum() or ch in "-_." else "-" for ch in model)
    return FIXTURES / f"recall_vectors.{slug}.json.gz"


_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def key(text: str) -> str:
    """The lookup key: the text with its dates normalised, hashed.

    See the module docstring for why the dates come out. Everything else is
    verbatim, so an edit to a fixture exchange changes its key and the recorded
    vector for the old wording stops being found — loudly, which is correct: a
    vector for text nobody embeds any more is not evidence about anything.
    """
    return hashlib.sha256(_ISO_DATE.sub("<date>", text).encode("utf-8")).hexdigest()


def load(model: str = MODEL) -> Recording:
    file = path_for(model)
    if not file.is_file():
        raise FileNotFoundError(
            f"no recorded vectors at {file} — re-record them with "
            f"`MEMORY_RECALL_EMBED_URL=... uv run python -m tests.recall_vectors`"
        )
    with gzip.open(file, "rt", encoding="utf-8") as handle:
        record = json.load(handle)
    width = int(record["width"])
    vectors = {}
    for digest, blob in record["vectors"].items():
        values = array("f")
        values.frombytes(base64.b64decode(blob))
        if len(values) != width:
            raise ValueError(f"{file}: vector {digest} is {len(values)} wide, expected {width}")
        vectors[digest] = list(values)
    return Recording(vectors=vectors, refused=dict(record.get("refused", {})))


@dataclass(frozen=True)
class Recording:
    """What the model answered, both ways it can answer.

    `refused` is not an afterthought: one fixture chunk is longer than
    nomic-embed-text's context, and the shipping code learns that from the
    service REFUSING it and then embeds the halves instead. A replay that
    only held vectors would never produce that refusal, so the windowing path
    would go unexercised and the over-long chunk would silently have no
    vector — which is the coverage bug this suite is supposed to catch.
    """

    vectors: dict[str, list[float]]
    refused: dict[str, str]


def handler(recording: Recording, calls: list[list[str]] | None = None):
    """An httpx handler that answers only with what the model actually said.

    Put in front of the REAL Embedder, so what the suite exercises is the
    shipping client, its truncate=false payload, its error mapping and its
    normalisation — everything except the model itself.

    A text with no recorded answer of EITHER kind raises. It does not guess,
    and it does not return a 500 either, because a 500 would be mapped to a
    stated unavailability and the pass would go on and score a lexical-only run
    under a hybrid name. It has to stop the test.
    """

    def respond(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        texts = body["input"]
        if calls is not None:
            calls.append(list(texts))
        rows = []
        for text in texts:
            digest = key(text)
            if digest in recording.refused:
                # ollama fails the whole request when any input is too long,
                # exactly as recorded here.
                return httpx.Response(400, json={"error": recording.refused[digest]})
            vector = recording.vectors.get(digest)
            if vector is None:
                raise AssertionError(
                    "no recorded answer for a text this suite embedded — re-record with "
                    "`MEMORY_RECALL_EMBED_URL=... uv run python tests/recall_vectors.py`. "
                    f"The text starts: {text[:160]!r}"
                )
            rows.append(vector)
        return httpx.Response(200, json={"embeddings": rows})

    return respond


# -- recording --------------------------------------------------------------


def _corpus_context(root: Path):
    """The fixture corpus, built and indexed exactly as the service indexes it."""
    import recall_corpus as corpus  # noqa: PLC0415 — only the recorder needs it

    from app.api import _build_context  # noqa: PLC0415

    corpus.build(root)
    return corpus, _build_context(root)


def record(url: str, model: str = MODEL) -> Path:
    """Record every vector the REAL code paths ask for, by proxying them.

    Not a list of texts assembled here — that was the first attempt and it was
    already wrong: one fixture chunk is longer than the model's context, so the
    backfill splits it and embeds two WINDOW texts that no list would have
    contained. So the recorder runs `backfill` and `embed_query` themselves,
    behind a transport that forwards each call to the live service and keeps
    what came back. Whatever the shipping code embeds is what gets recorded, by
    construction, including the day somebody changes how it chunks.
    """
    import asyncio  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    from app.embedding import EmbedConfig, Embedder, VectorCache, backfill  # noqa: PLC0415

    os.environ["MEMORY_EMBED_URL"] = url
    os.environ["MEMORY_EMBED_MODEL"] = model
    # Generous, because this is a recording and not a turn: on a box whose GPU
    # is busy with a chat model a single embed call was probed at 5-31 s.
    os.environ["MEMORY_EMBED_TIMEOUT"] = "300"
    os.environ["MEMORY_EMBED_QUERY_TIMEOUT"] = "300"
    root = Path(tempfile.mkdtemp()) / "root"
    corpus, context = _corpus_context(root)
    seen: dict[str, list[float]] = {}
    refused: dict[str, str] = {}
    widths: set[int] = set()

    async def proxy(request: httpx.Request) -> httpx.Response:
        async with httpx.AsyncClient(timeout=300.0) as client:
            upstream = await client.post(
                str(request.url),
                content=request.content,
                headers={"Content-Type": "application/json"},
            )
        inputs = json.loads(request.content)["input"]
        if upstream.status_code == 200:
            body = upstream.json()
            for text, vector in zip(inputs, body["embeddings"], strict=True):
                seen[key(text)] = [float(value) for value in vector]
                widths.add(len(vector))
        elif len(inputs) == 1:
            # A single-text refusal names THIS text. A batched one does not say
            # which input was at fault, and the shipping code retries such a
            # batch one text at a time, so the singles are where the fact is.
            said = (
                upstream.json().get("error", "")
                if upstream.headers.get("content-type", "").startswith("application/json")
                else upstream.text
            )
            refused[key(inputs[0])] = said
        # Forwarded verbatim, failures included: a "context length" refusal is
        # what makes embed_windows split, and inventing a 200 here would record
        # a corpus the running service could never produce.
        return httpx.Response(upstream.status_code, content=upstream.content)

    embedder = Embedder(EmbedConfig.from_env(), transport=httpx.MockTransport(proxy))

    async def run() -> None:
        cache = VectorCache(Path(tempfile.mkdtemp()) / "cache.jsonl")
        cache.load()
        report = await backfill(
            embedder, cache, context.index.missing_vectors(), apply=lambda digest, windows: None
        )
        if report.failed:
            raise SystemExit(f"the embedder at {url} could not embed the fixture: {report.failed}")
        for case in list(corpus.CASES) + list(corpus.ABSENT_CASES):
            await embedder.embed_query(case.question)
        # What api._warm_model embeds at boot, so a test that exercises the
        # warm-up does not have to special-case it.
        await embedder.embed_query("warm")

    asyncio.run(run())
    if len(widths) != 1:
        raise SystemExit(f"the service returned vectors of different widths: {sorted(widths)}")
    payload = {
        "model": model,
        "width": widths.pop(),
        "note": (
            "Recorded from a live ollama for services/memory/tests/test_recall_quality.py. "
            "Keys are sha256 of the text with ISO dates normalised — see tests/recall_vectors.py."
        ),
        "vectors": {
            digest: base64.b64encode(array("f", vector).tobytes()).decode("ascii")
            for digest, vector in seen.items()
        },
        "refused": refused,
    }
    file = path_for(model)
    file.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(file, "wt", encoding="utf-8") as handle:
        json.dump(payload, handle)
    return file


def main() -> None:
    url = os.environ.get("MEMORY_RECALL_EMBED_URL", "").strip()
    if not url:
        raise SystemExit(
            "set MEMORY_RECALL_EMBED_URL to a reachable ollama (and optionally "
            "MEMORY_RECALL_EMBED_MODEL) — this records from a live model on purpose"
        )
    model = os.environ.get("MEMORY_RECALL_EMBED_MODEL", "").strip() or MODEL
    file = record(url, model)
    recording = load(model)
    print(
        f"recorded {len(recording.vectors)} vectors and {len(recording.refused)} refusal(s) "
        f"({file.stat().st_size / 1024:.0f} KiB) to {file}"
    )


if __name__ == "__main__":
    # Run as a script from services/memory, so `app` and the sibling test
    # modules both have to be importable before anything else happens.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    main()
