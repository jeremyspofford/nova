"""Distil any document too long to be read whole — docs/plans/transcript-summaries.md.

Started life summarising YouTube transcripts, which is how it was needed:
followed-source ingestion wrote 82 verbatim transcripts and distilled none of
them, because `ingest_media` writes the transcript then asks the agent to
CHUNK it ("never summarize away content") while follow/poll calls
`_ingest_media_core` and stops, deliberately, to keep a batch fast.

It is general now because nothing here should be built for one operator's
corpus — "she's supposed to be able to do things that she's not specifically
configured to do". A video transcript is just the long document that happened
to arrive first.

EVERYTHING MEDIA-SPECIFIC IS DERIVED FROM THE SOURCE, not passed in. The
document's own frontmatter says what it is, where it came from and how far it
is trusted; the caller supplies an id and a model. So this works unchanged on
a fetched article, a pasted spec, or a 40k-token digest.

Three properties worth stating:

* A SUMMARY IS NEVER MORE TRUSTED THAN ITS SOURCE, and never more trusted
  than `conversation` — a model wrote it, so it cannot be first_party even
  when its source is. The first half stops a distillation of fetched text
  from shedding its origin; the second stops a paraphrase from acquiring the
  operator's authority.
* THE SOURCE IS NEVER REPLACED. The summary links back by item id. For
  transcripts specifically, BM25 over the body is how "which video mentioned
  X" gets answered, and a summary cannot stand in for that.
* NOTHING IS WRITTEN THAT THE SOURCE DOES NOT SUPPORT. See grounding.py — the
  first summary this module ever produced invented a company, under a system
  prompt telling it not to.
"""

from __future__ import annotations

import logging
import re
from typing import Optional

log = logging.getLogger(__name__)

# Share of the summarising model's window one part may fill. Well under the
# read fraction: this prompt carries instructions and, on the combine pass,
# every part summary alongside.
_PART_FRACTION = 0.30

# A "summary" this close to its source is not a summary — the model echoed
# the document back, which is a real and quiet failure mode. Rejected rather
# than written: a 40k-token note titled "summary" is worse than no note.
_MAX_SUMMARY_RATIO = 0.5

SUMMARY_SUFFIX = " — summary"

# Suffixes the ingest path already appends. Stripped before the summary's own
# suffix goes on, or a title reads "X — full transcript — summary", which is
# both clumsy and misleading: the document is a summary OF a transcript, not
# a transcript that is also a summary. Derived from the writer's own naming
# (see _ingest_media_core), not from arbitrary trimming.
_SOURCE_SUFFIXES = (" — full transcript",)


def summary_title(source_title: str) -> str:
    """The title a summary of `source_title` should carry."""
    for suffix in _SOURCE_SUFFIXES:
        if source_title.endswith(suffix):
            source_title = source_title[: -len(suffix)]
            break
    return f"{source_title}{SUMMARY_SUFFIX}"

# What to call the source in the prompt. Telling the model it is reading
# speech-to-text genuinely improves the result — it drops filler and sponsor
# reads — so the noun is kept, but it is READ OFF the document rather than
# assumed by the caller. An unrecognised kind is simply "document", which is
# the honest default and needs no entry here.
_KIND_NOUNS = {
    "media_transcript": "video transcript",
    "subscription": "syndicated article",
    "journal": "conversation journal",
}

_SYSTEM = (
    "You summarise documents. Report only what the document actually says. "
    "Do not add context, corrections or background from your own knowledge, "
    "and do not resolve a claim you cannot verify from the text in front of "
    "you — if the document is unclear, vague, or is making a claim rather "
    "than showing evidence, say so plainly. Attribute claims to the author "
    "or speaker rather than stating them as fact.")

_ONE_PASS = (
    "Summarise this {noun}.\n\n"
    "Write the FIRST line as a single sentence naming what it is about and "
    "what it claims — no label, no prefix, just the sentence, and do not end "
    "it by announcing a list.\n"
    "Then a blank line, then the summary itself: what is covered, the "
    "specific claims made, anything named, and anything concrete enough to "
    "act on. Keep the specifics — names, numbers, versions. Drop filler, "
    "sponsor reads and self-promotion.\n\n"
    "{NOUN}:\n{body}")

_PART = (
    "This is part {n} of {total} of one {noun}. Summarise ONLY this part. "
    "Keep names, numbers, versions and specific claims; drop filler. Do not "
    "speculate about what the other parts contain.\n\n"
    "PART {n}/{total}:\n{body}")

_COMBINE = (
    "Below are summaries of the {total} sequential parts of one {noun}, in "
    "order. Merge them into one summary of the whole thing.\n\n"
    "Write the FIRST line as a single sentence naming what it is about and "
    "what it claims — no label, no prefix, and do not end it by announcing a "
    "list.\n"
    "Then a blank line, then the merged summary. Keep every specific claim, "
    "name, number and version. Remove repetition across parts. Do not add "
    "anything that is not in the part summaries.\n\nPART SUMMARIES:\n{body}")

_REGROUND = (
    "These terms appear in your summary but NOT anywhere in the source you "
    "were given:\n\n{terms}\n\n"
    "You invented them. Rewrite the summary with every one of them removed, "
    "along with any claim that depended on them. Change nothing else — keep "
    "the same structure, and keep the first line as the one-sentence "
    "description. If removing them leaves a section empty, drop the section."
    "\n\nYOUR SUMMARY:\n{draft}")


_SUBJECTS = (
    "List the 2 to 4 SPECIFIC SUBJECTS this text is about, as short "
    "kebab-case tags.\n\n"
    "A subject is a named thing another document could also be about — "
    "model-context-protocol, rate-limiting, rust, kv-cache, tailwind. NOT the "
    "kind of thing this is (video, transcript, tutorial, news), NOT a broad "
    "field (technology, ai, programming, software), NOT the title restated.\n"
    "Only subjects the text actually discusses. Output the tags on one line, "
    "comma separated, nothing else.\n\nTEXT:\n{body}")

_TAG_RE = re.compile(r"[a-z0-9][a-z0-9-]{1,38}")

# What a subject tag must not be. Broad fields and formats name a category,
# and a category earns no graph edge (see memory.graph) — so a tag from this
# list is a wasted call at best and misleading in a listing at worst.
_NOT_A_SUBJECT = frozenset({
    "video", "transcript", "tutorial", "news", "guide", "overview", "review",
    "technology", "tech", "ai", "artificial-intelligence", "programming",
    "software", "development", "coding", "computer-science", "engineering",
    "tools", "tips", "learning", "education", "content", "media", "general",
})


async def subject_tags(text: str, source: str, model: str) -> list[str]:
    """Specific subjects `text` is about, each one verified against `source`.

    THIS IS WHY THE GRAPH IS EMPTY. A followed-source video is written with
    tags ["media", "transcript", "src-<channel>", "<title-slug>"] — the first
    two are generic, the third has 65 members and names a category, and the
    fourth is derived from the title so it is unique to that one video. Every
    ingested video therefore arrives sharing no subject with anything, and
    the batch path never runs the agent that would have assigned one. Fixing
    the chain edges made the graph honest; this is what gives it anything
    true to say.

    Grounded like everything else here: a subject that does not appear in the
    source is dropped rather than trusted, because a fabricated tag does not
    merely mislabel one document — it invents a RELATIONSHIP between every
    document that gets it.
    """
    from app import grounding
    raw = await _complete(
        [{"role": "system", "content": _SYSTEM},
         {"role": "user", "content": _SUBJECTS.format(body=text)}], model)
    if not raw:
        return []
    source_norm = grounding._norm(source)
    out: list[str] = []
    for candidate in _TAG_RE.findall(raw.lower().replace(",", " ")):
        if candidate in _NOT_A_SUBJECT or candidate in out:
            continue
        # every word of the tag has to be IN the source, or it is invented
        if all(grounding._norm(w) in source_norm
               for w in candidate.split("-") if len(w) > 2):
            out.append(candidate)
    return out[:4]


class ProviderExhausted(RuntimeError):
    """The provider will refuse every further call until a human acts.

    Distinguished from a transient failure because retrying is not merely
    useless, it is harmful. On 2026-07-28 an OpenRouter budget cap returned
    403 for every request and a supervisor loop retried roughly two thousand
    times, hammering the endpoint and hiding the real cause behind a wall of
    "skipped (no usable summary)". A caller iterating over documents has to
    be able to tell "this one failed" from "stop".
    """


# Provider messages that mean a human must intervene. Matched on the text
# because the status code does not distinguish them: 403 is also a bad key,
# and 429 is sometimes a monthly cap rather than a burst limit.
_TERMINAL = ("budget", "quota", "insufficient", "credit",
             "payment", "billing", "suspended", "unauthorized")


async def _complete(messages: list[dict], model: str) -> Optional[str]:
    """One non-streaming completion. None on a transient failure.

    Raises ProviderExhausted when the provider has refused in a way that the
    next call will hit identically.
    """
    from app.llm import router as llm_router
    out: list[str] = []
    async for event in llm_router.stream_chat(messages, model, tools=None):
        kind = event.get("type")
        if kind == "text":
            out.append(event.get("text") or "")
        elif kind == "error":
            detail = str(event.get("error") or "")
            log.warning("summary: model call failed on %s: %s", model,
                        detail[:200])
            if any(word in detail.lower() for word in _TERMINAL):
                raise ProviderExhausted(detail[:300])
            return None
    text = "".join(out).strip()
    return text or None


def _split(text: str) -> tuple[str, str]:
    """(one-line description, body).

    The description lands in the catalogue, so it has to stand alone. The
    first attempt took the whole first line and produced "...for coding
    tasks. The main points are:" — a lead-in to a list that is not there,
    which is worse than the template descriptions removed in c54f26f. A
    trailing clause that announces what follows is dropped.
    """
    lines = [ln.strip() for ln in text.splitlines()]
    first = next((ln for ln in lines if ln), "")
    rest = text.split(first, 1)[1].strip() if first else text
    head = first.lstrip("#*- ").strip()
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", head) if s.strip()]
    while sentences and sentences[-1].rstrip().endswith(":"):
        sentences.pop()
    return _clip(" ".join(sentences).strip() or head), (rest or text)


def _clip(desc: str, limit: int = 240) -> str:
    """Cut at a WORD boundary, and say that it was cut.

    A hard `[:240]` produced "...matching the right workload to the right
    proc" in the live catalogue — a description that ends mid-word reads as
    corrupt data rather than as an abbreviation, and the catalogue is the
    one surface she scans to decide what to read in full.
    """
    if len(desc) <= limit:
        return desc
    cut = desc[:limit - 1]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit // 2 else cut).rstrip(" ,;:") + "…"


def summary_source_type(source_type: Optional[str], has_url: bool) -> str:
    """The source_type to stamp so the summary lands at the right tier.

    A summary is model-authored, so it can never be first_party — not even
    when its source is the operator's own note. And it can never be more
    trusted than what it came from. `provenance.lower_of` gives the second
    half; capping at CONVERSATION gives the first.
    """
    from app.memory import provenance
    tier = provenance.tier(source_type, has_source_url=has_url)
    wanted = provenance.lower_of(tier, provenance.CONVERSATION)
    if wanted == provenance.THIRD_PARTY:
        # keep the source's own stamp so the reason stays legible on disk
        return source_type or "media_transcript"
    return "chat"


async def _safe_subjects(text: str, source: str, model: str) -> list[str]:
    """subject_tags, but a failure costs tags rather than the whole summary."""
    try:
        tags = await subject_tags(text, source, model)
        if tags:
            log.info("summary subjects: %s", ", ".join(tags))
        return tags
    except ProviderExhausted:
        raise                      # the caller must still stop, not retry
    except Exception:  # noqa: BLE001
        log.debug("subject tagging failed; writing without them", exc_info=True)
        return []


async def summarise(item_id: str, *, model: str) -> Optional[str]:
    """Write one summary document for `item_id`. Returns its id, or None.

    Everything except the model is read off the source. Returns None rather
    than raising for every failure mode — the caller is usually a queue that
    has already succeeded at something more important.
    """
    from app import grounding
    from app.agents import context_trim
    from app.memory.memory import memory

    item = await memory.read_item(item_id)
    if not item:
        log.warning("summary: %s is gone", item_id)
        return None
    fm = item.get("frontmatter") or {}
    body = (item.get("content") or "").strip()
    if not body:
        return None

    title = str(fm.get("title") or item_id)
    if title.endswith(SUMMARY_SUFFIX):
        # summarising a summary compounds every distortion in it, and there is
        # no source left to check the result against
        log.info("summary: %s is already a summary; skipping", item_id)
        return None

    source_type = str(fm.get("source_type") or "") or None
    url = str(fm.get("source_url") or "")
    noun = _KIND_NOUNS.get(source_type or "", "document")

    cap = max(4000, int(context_trim.ceiling_for(model) * _PART_FRACTION)
              * context_trim._CHARS_PER_TOKEN)
    parts = context_trim.paginate(body, cap)

    if len(parts) == 1:
        text = await _complete(
            [{"role": "system", "content": _SYSTEM},
             {"role": "user", "content": _ONE_PASS.format(
                 noun=noun, NOUN=noun.upper(), body=parts[0])}], model)
    else:
        # Map then reduce — the read-part / summarise / continue shape, with
        # the risk that shape always carries: a fabricated part summary
        # becomes "the source" for the combine pass, which cannot see the
        # original. The grounding gate below checks the FINAL text against the
        # whole document, which is what closes that.
        log.info("summary: %s is %d parts on %s", item_id, len(parts), model)
        pieces = []
        for n, part in enumerate(parts, 1):
            got = await _complete(
                [{"role": "system", "content": _SYSTEM},
                 {"role": "user", "content": _PART.format(
                     n=n, total=len(parts), noun=noun, body=part)}], model)
            if got:
                pieces.append(f"[part {n}/{len(parts)}]\n{got}")
        if not pieces:
            return None
        text = await _complete(
            [{"role": "system", "content": _SYSTEM},
             {"role": "user", "content": _COMBINE.format(
                 total=len(parts), noun=noun, body="\n\n".join(pieces))}],
            model)

    if not text:
        return None

    # The grounding gate. The system prompt already says "report only what the
    # document actually says", and the first summary written under it invented
    # a vendor — so the prompt is not the control, this is. One correction
    # pass naming exactly what was not found, then refuse. A document with no
    # summary is a gap; a document with a fabricated summary is a falsehood
    # that outranks its own source in search, because it is shorter and denser.
    invented = grounding.ungrounded(text, body)
    if invented:
        log.warning("summary: %d unsupported terms in %s (%s) — asking for a "
                    "correction", len(invented), item_id, ", ".join(invented[:6]))
        fixed = await _complete(
            [{"role": "system", "content": _SYSTEM},
             # the source is deliberately NOT resent: the task is to delete
             # what was never in it, which needs the draft, not the original
             {"role": "user", "content": _REGROUND.format(
                 terms="\n".join(f"- {t}" for t in invented), draft=text)}],
            model)
        if fixed:
            text = fixed
        invented = grounding.ungrounded(text, body)
        if invented:
            log.warning("summary REFUSED for %s — still unsupported after a "
                        "correction pass: %s", item_id, ", ".join(invented[:6]))
            return None

    if len(text) > len(body) * _MAX_SUMMARY_RATIO:
        log.warning("summary: rejected for %s — %d chars against a %d-char "
                    "source is a copy, not a summary",
                    item_id, len(text), len(body))
        return None

    description, summary_body = _split(text)
    # [[wikilink]], not a code-quoted path. The graph resolves links by title
    # into real edges (memory.graph), so the backticked id the first version
    # wrote left every summary floating beside its source with no edge to it —
    # they only appeared related because they shared tags, which is the same
    # coincidental bridging _GENERIC_TAGS exists to prevent. The id stays too:
    # the link is for the graph, the id is what read_memory_item takes.
    note = (f"Summary of [[{title}]].\n\n"
            f"This is a summary, not the source. The full text is "
            f"[[{title}]] — read it with `{item_id}`."
            + (f"\nOriginal: {url}" if url else "") + "\n\n" + summary_body)

    written = await memory.write(
        note, type="topic", replace=True,
        title=summary_title(title),
        description=description,
        category=str(fm.get("category") or "knowledge"),
        # The source's own tags keep the summary clustered with it and its
        # channel — plus SUBJECT tags, which are the only ones that can
        # connect it to a different document. Derived from the summary and
        # checked against the source; failure here costs tags, never the
        # summary.
        tags=list(memory.index.docs.get(item_id, {}).get("tags") or [])
        + await _safe_subjects(summary_body, body, model),
        source_url=url or None,
        source_type=summary_source_type(source_type, bool(url)),
        link_pass=False)
    log.info("summary written: %s", written.get("id"))
    return written.get("id")
