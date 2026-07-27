# Transcript summaries

Decided 2026-07-27. Jeremy: "raw video transcripts should be summarized. If
Nova needs to get more details regarding a specific video — let's say Nova
recommends a new idea based on a video — then she can read the summary, then
go out and re-read the entire transcript or re-watch the video while
generating the plan."

## What is actually wrong

70% of memory by volume is raw video transcripts: 82 documents, 1.38 MB, from
4 followed YouTube channels. Nothing distils them.

The cause is a fork in the ingest path, not neglect:

* `ingest_media` (interactive) writes the full transcript mechanically and
  then hands the agent a chunking instruction — "Preserve the transcript's
  actual wording per chunk; light cleanup only, never summarize away content"
  (builtin.py, `_ingest_media`).
* follow/poll (batch) calls `_ingest_media_core` directly and stops there. The
  comment says why: "skipping per-item LLM chunking keeps a batch fast/
  reliable."

Every one of the 82 arrived through the batch path. So the corpus holds
verbatim speech and no understanding of it, and chunking — which the other
path does — is explicitly NOT summarising anyway.

## What this is not

**Not a crowding fix.** That was the prior framing and it is obsolete: the
catalogue shipped in c54f26f collapses all 82 into 4 collection lines, so the
whole corpus is legible in ~1,500 tokens on a local model. Crowding is solved.

**Not a reason to unindex transcripts.** Considered and rejected. Moving them
out of `TYPE_DIRS` would make them invisible to the index by construction,
which is tempting and mechanical — but BM25 searches transcript bodies today,
and that is how "which video mentioned Kimi K3" gets answered. A summary
cannot replace that. Transcripts stay where they are, indexed and searchable;
the summary is added alongside as the entry point.

## The shape

After the mechanical transcript write succeeds, the ingest worker produces one
summary topic per video:

* written by the `ingestion` agent's model, from the transcript, in the
  durable queue — never inline in poll, so a batch stays fast and a failed
  summary retries on its own instead of losing the ingest
* linked to its transcript by item id, and carrying the video's `source_url`,
  so "go read the whole thing" and "go re-watch it" are both one hop
* tagged with the same per-video and per-source tags, so it clusters with its
  transcript in the graph rather than floating

**A summary is marked as a summary.** It states that it is one, names the
video it came from, and stays `third_party` — it is derived from fetched
content and inherits that content's trust, not the writer's. A distillation
presented as knowledge is laundering with an extra step, and it is the exact
risk that deferred the librarian.

## Order

1. The mechanism, on new ingests only. Verify on one real video.
2. Backfill the 82 through the same queue. This writes to live memory, so it
   runs only with the operator's explicit go-ahead, and the transcripts are
   untouched by it — a bad summary is deletable without losing anything.

## Open

* Whether automatic retrieval should prefer summaries over raw transcript
  text once both exist. Likely yes, and measurable: compare what
  `memory.context()` returns for the same query before and after. Not part of
  step 1.

## Measured: the summariser invents things (2026-07-27)

First summary written, checked entity-by-entity against its own transcript:

| in the summary | occurrences in the transcript |
|---|---|
| "Six Labs", listed as one of the models | **0 — invented** |
| "twice the usual rate" | **0 — unsupported** |
| KleinPaaS, Kimmy K3, DeepSeek V4, MiniMax M3, Qwen 3.7, GLM 5.2, $9.99, 80%, 11 models | grounded |

Two fabrications in one summary, with "report only what the transcript
actually says" in the system prompt. The prompt is a request, not a control —
again.

This is why the backfill is gated. A summary is DENSER than its transcript, so
BM25 finds it more readily; mass-producing 82 of them would put text that is
more retrievable and less true in front of the text it came from.

**The check that makes summaries safe.** A transcript summary is unusually
verifiable: unlike a summary of the world, its ground truth is on disk beside
it. So no summary is written until every proper noun, number and version in it
is found in the source. Ungrounded terms are stripped, or the summary is
rejected. Matching must normalise case and whitespace — "GLM5.2" against the
transcript's "GLM 5.2" is a false positive, and precision matters here for the
same reason it does in narration.py.

Also open: `_split` produced the description "The main points are:" — a
lead-in, not a description, and worse than the template descriptions removed
in c54f26f. Fix before the backfill.

## Why Nova never proposed this herself (2026-07-27)

Jeremy: "back when I asked it to follow these videos, Nova should be thinking
about ways that it can use them, and the best way to use them — maybe Nova
should have recommended creating a summariser feature for long documents and
then attached it to the automation."

Correct, and the reason she did not is mechanical rather than a failure of
character.

* `poll-followed-sources` runs every 6h on `ingestion` and its job is to
  FETCH. None of the four live automations reviews anything; they all do work.
* `ingestion` already holds `raise_recommendation`, and the recommendation
  inbox already ships. The output path was never the blocker.
* **Nothing records WHICH documents are retrieved.** The `memory_retrieval`
  span carries `memory_chars` and `memory_origins`, not doc ids. So "82
  transcripts ingested since July, none ever used in an answer" is not a fact
  anybody — her or the operator — can currently compute.

She cannot notice a pattern nobody measures. The fix is not an instruction to
be thoughtful; it is the measurement that makes the gap self-evident:

1. Record retrieved doc ids on the existing memory_retrieval span.
2. A review automation whose instruction is explicitly NOT to do work, but to
   compare what is accumulating against what is being used, and raise
   recommendations.
3. `raise_recommendation` — already built.

Had this existed in week one it would have produced: "47 transcripts from 4
channels, none used in an answer — either these channels are not earning their
slot, or I need to distil them." Which is this document, three months early.
