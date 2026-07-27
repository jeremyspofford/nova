"""One summary per ingested video — docs/plans/transcript-summaries.md.

70% of memory by volume was raw video transcripts with nothing distilling
them: 82 documents, 1.38 MB, from four followed channels. The cause is a fork
in the ingest path rather than neglect. `ingest_media` writes the transcript
mechanically and then asks the agent to CHUNK it — "Preserve the transcript's
actual wording per chunk; light cleanup only, never summarize away content" —
while follow/poll calls `_ingest_media_core` and stops, deliberately, to keep
a batch fast. Every one of the 82 came in through the batch path, so the
corpus held verbatim speech and no understanding of it.

Three things this is careful about:

* A SUMMARY IS MARKED A SUMMARY, and stays third_party. It is derived from
  fetched content and inherits that content's trust, never the writer's. A
  distillation presented as knowledge is laundering with one extra step.
* THE TRANSCRIPT IS NOT REPLACED. It stays indexed and searchable, and the
  summary links to it by id. Unindexing was considered and rejected: BM25
  searches transcript bodies, which is how "which video mentioned X" is
  answered, and a summary cannot stand in for that.
* IT RUNS IN THE QUEUE, never inline in poll. A failed summary retries on its
  own row instead of taking an ingest down with it, and a batch stays fast.
"""

from __future__ import annotations

import logging
import re
from typing import Optional

log = logging.getLogger(__name__)

# Share of the summarising model's window one transcript part may fill. Well
# under the read fraction: this prompt carries instructions and, on the
# combine pass, every part summary alongside.
_PART_FRACTION = 0.30

# A "summary" this close to its source is not a summary — the model echoed
# the transcript back, which is a real and quiet failure mode. Rejected
# rather than written, because a 40k-token note titled "summary" is worse
# than no note.
_MAX_SUMMARY_RATIO = 0.5

_SYSTEM = (
    "You summarise video transcripts. Report only what the transcript "
    "actually says. Do not add context, corrections or background from your "
    "own knowledge, and do not resolve a claim you cannot verify from the "
    "text in front of you — if the transcript is unclear, vague, or is "
    "making a claim rather than showing evidence, say so plainly. "
    "Attribute claims to the speaker rather than stating them as fact.")

_ONE_PASS = (
    "Summarise this video transcript.\n\n"
    "Write the FIRST line as a single sentence naming what the video is "
    "about and what it claims — no label, no prefix, just the sentence.\n"
    "Then a blank line, then the summary itself: what is covered, the "
    "specific claims made, any tools/models/products named, and anything "
    "concrete enough to act on. Keep the speaker's specifics — names, "
    "numbers, versions. Drop the filler, the sponsor reads and the "
    "self-promotion.\n\n"
    "TRANSCRIPT:\n{body}")

_PART = (
    "This is part {n} of {total} of one video transcript. Summarise ONLY "
    "this part. Keep names, numbers, versions and specific claims; drop "
    "filler and sponsor reads. Do not speculate about what the other parts "
    "contain.\n\nTRANSCRIPT PART {n}/{total}:\n{body}")

_REGROUND = (
    "These terms appear in your summary but NOT anywhere in the transcript "
    "you were given:\n\n{terms}\n\n"
    "You invented them. Rewrite the summary with every one of them removed, "
    "along with any claim that depended on them. Change nothing else — keep "
    "the same structure, and keep the first line as the one-sentence "
    "description. If removing them leaves a section empty, drop the section.\n\n"
    "YOUR SUMMARY:\n{draft}")

_COMBINE = (
    "Below are summaries of the {total} sequential parts of one video "
    "transcript, in order. Merge them into one summary of the whole video.\n\n"
    "Write the FIRST line as a single sentence naming what the video is "
    "about and what it claims — no label, no prefix, just the sentence.\n"
    "Then a blank line, then the merged summary. Keep every specific claim, "
    "name, number and version. Remove repetition across parts. Do not add "
    "anything that is not in the part summaries.\n\nPART SUMMARIES:\n{body}")


async def _complete(messages: list[dict], model: str) -> Optional[str]:
    """One non-streaming completion. None on any provider failure."""
    from app.llm import router as llm_router
    out: list[str] = []
    async for event in llm_router.stream_chat(messages, model, tools=None):
        kind = event.get("type")
        if kind == "text":
            out.append(event.get("text") or "")
        elif kind == "error":
            log.warning("summary: model call failed on %s: %s", model,
                        str(event.get("error"))[:200])
            return None
    text = "".join(out).strip()
    return text or None


def _split(text: str) -> tuple[str, str]:
    """(one-line description, body).

    The description lands in the catalogue, so it has to stand alone. The
    first attempt took the whole first line and produced "The video claims to
    provide an affordable way to use 11 curated open models with a single
    login and harness for coding tasks. The main points are:" — a lead-in to
    a list that is not there, which is worse than the template descriptions
    removed in c54f26f. A trailing clause that announces what follows is
    dropped.
    """
    lines = [ln.strip() for ln in text.splitlines()]
    first = next((ln for ln in lines if ln), "")
    rest = text.split(first, 1)[1].strip() if first else text
    head = first.lstrip("#*- ").strip()
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", head) if s.strip()]
    while sentences and sentences[-1].rstrip().endswith(":"):
        sentences.pop()
    desc = " ".join(sentences).strip()[:240]
    return desc or head[:240], (rest or text)


async def summarise(transcript_item_id: str, *, title: str, url: str,
                    tags: list[str], model: str) -> Optional[str]:
    """Write one summary topic for an already-ingested transcript.

    Returns the summary's item id, or None if nothing was written — a failure
    here must never cost the ingest, which has already succeeded by the time
    this runs.
    """
    from app.agents import context_trim
    from app.memory.memory import memory

    item = await memory.read_item(transcript_item_id)
    if not item:
        log.warning("summary: transcript %s is gone", transcript_item_id)
        return None
    body = (item.get("content") or "").strip()
    if not body:
        return None

    cap = max(4000, int(context_trim.ceiling_for(model) * _PART_FRACTION)
              * context_trim._CHARS_PER_TOKEN)
    parts = context_trim.paginate(body, cap)

    if len(parts) == 1:
        text = await _complete(
            [{"role": "system", "content": _SYSTEM},
             {"role": "user", "content": _ONE_PASS.format(body=parts[0])}],
            model)
    else:
        # Map then reduce. This is the read-part / summarise / continue shape,
        # and it carries the risk that shape always carries: a fabricated part
        # summary becomes "the transcript" for the combine pass, which cannot
        # see the source. Hence the attribution instruction on every hop and
        # the summary's own third_party tier — nothing here is ever promoted
        # to fact by being restated.
        log.info("summary: %s is %d parts on %s", transcript_item_id,
                 len(parts), model)
        pieces = []
        for n, part in enumerate(parts, 1):
            got = await _complete(
                [{"role": "system", "content": _SYSTEM},
                 {"role": "user", "content": _PART.format(
                     n=n, total=len(parts), body=part)}], model)
            if got:
                pieces.append(f"[part {n}/{len(parts)}]\n{got}")
        if not pieces:
            return None
        text = await _complete(
            [{"role": "system", "content": _SYSTEM},
             {"role": "user", "content": _COMBINE.format(
                 total=len(parts), body="\n\n".join(pieces))}], model)

    if not text:
        return None

    # The grounding gate. The system prompt already says "report only what
    # the transcript actually says", and the first summary written under it
    # invented a vendor — so the prompt is not the control, this is. One
    # correction pass naming exactly what was not found (the verifier-loop
    # shape used elsewhere here: tell it what is wrong while it can still fix
    # it), then refuse. A video with no summary is a gap; a video with a
    # fabricated summary is a lie that outranks its own transcript in search.
    from app import grounding
    invented = grounding.ungrounded(text, body)
    if invented:
        log.warning("summary: %d unsupported terms in %s (%s) — asking for a "
                    "correction", len(invented), transcript_item_id,
                    ", ".join(invented[:6]))
        fixed = await _complete(
            [{"role": "system", "content": _SYSTEM},
             # the transcript is deliberately NOT resent: the task is to
             # delete what was never in it, which needs the draft, not the
             # source, and a 40k-token resend per retry is not free
             {"role": "user", "content": _REGROUND.format(
                 terms="\n".join(f"- {t}" for t in invented), draft=text)}],
            model)
        if fixed:
            text = fixed
        invented = grounding.ungrounded(text, body)
        if invented:
            log.warning("summary REFUSED for %s — still unsupported after a "
                        "correction pass: %s", transcript_item_id,
                        ", ".join(invented[:6]))
            return None

    if len(text) > len(body) * _MAX_SUMMARY_RATIO:
        log.warning("summary: rejected for %s — %d chars against a %d-char "
                    "transcript is a copy, not a summary",
                    transcript_item_id, len(text), len(body))
        return None

    description, summary_body = _split(text)
    note = (f"Summary of the video **{title}**.\n\n"
            f"This is a summary of third-party content, not a first-hand "
            f"record. Full transcript: `{transcript_item_id}`"
            + (f"\nVideo: {url}" if url else "") + "\n\n" + summary_body)

    written = await memory.write(
        note, type="topic", replace=True,
        title=f"{title} — summary",
        description=description,
        category="knowledge",
        # the transcript's own tags, so the summary clusters with it and with
        # its channel instead of floating alone in the graph
        tags=list(tags),
        source_url=url or None,
        # third_party, derived the same way the transcript is: this text came
        # from that video, whatever wrote it down
        source_type="media_transcript",
        link_pass=False)
    log.info("summary written: %s", written.get("id"))
    return written.get("id")
