"""Where a memory came from, as a fact the retrieval layer can act on.

Phase 1 of docs/plans/capability-and-containment.md. Nothing here decides
policy — that is phase 2's reader/actor split. This is the plumbing that
makes the decision POSSIBLE: an origin on every document, carried into the
index, and monotone under append.

THE TIERS

  first_party   the operator's own material — what they told Nova, what
                Nova concluded, a skill they wrote
  conversation  a chat transcript. Neither verified nor foreign: it can
                quote a web page the model just read, and it can quote
                Nova's own mistaken claims back to her. Journals are this.
  third_party   text Nova fetched from the world — a page, a transcript, a
                followed source
  unknown       no stamp. Treated as third_party, because a rail that fails
                OPEN on missing data is not a rail. Every document written
                before this existed lands here, which is correct: nothing
                verified them.

WHY `source_type` ALONE WAS NOT ENOUGH

`write_memory` stamps `source_type="tool"` for every caller, and the
`ingestion` agent — whose whole job is fetching web pages and distilling
them — holds `write_memory`. So the most reliably untrusted content in the
system carried the most trusted-looking stamp. The writer is now recorded
alongside the mechanism, so trust can be DERIVED from what that agent was
granted rather than from a maintained list of agent names.
"""

from __future__ import annotations

from typing import Optional

FIRST_PARTY = "first_party"
CONVERSATION = "conversation"
THIRD_PARTY = "third_party"

# higher is more trusted; used only to keep append monotone
_RANK = {THIRD_PARTY: 0, CONVERSATION: 1, FIRST_PARTY: 2}

# the `source_type` values actually written in this codebase
_SOURCE_TYPE_TIER = {
    "media_transcript": THIRD_PARTY,
    "subscription": THIRD_PARTY,
    "chat": CONVERSATION,
    "conversation": CONVERSATION,
    "journal": CONVERSATION,
    "tool": FIRST_PARTY,      # narrowed below by who was holding the pen
}

# An agent that can reach the world writes third-party content, whatever
# mechanism it used. DERIVED from grants, not a list of agent names: grant
# fetch_url to something new and its writes are correctly distrusted with no
# edit here, which is the only version of this that survives contact.
WORLD_READING_TOOLS = {"fetch_url", "web_search", "ingest_media",
                       "poll_sources", "follow_source"}


def writer_is_world_reading(writer_tools: Optional[list[str]]) -> bool:
    """True when the writing agent could have fetched what it wrote."""
    if writer_tools is None:      # unrestricted — it holds everything
        return True
    return bool(WORLD_READING_TOOLS & set(writer_tools))


def tier(source_type: Optional[str], writer_world_reading: bool = False,
         has_source_url: bool = False) -> str:
    """The trust tier of a document. Unknown is third_party, on purpose.

    `has_source_url` settles the documents written before the writer was
    recorded. A source_url means "this content came from that URL", which is
    third-party provenance stated in the document's own frontmatter — and it
    is not a small correction: 9 of the 13 topics stamped source_type="tool"
    on 2026-07-27 carried one, because `ingestion` fetched them and
    write_memory stamps "tool" for every caller. Without this they would all
    have counted as the operator's own material.

    That evidence demotes ANY tier above third_party, not only first_party,
    and the difference is not academic: `OkfMemory.write` defaults to
    source_type="chat", so a caller passing a source_url without naming a
    source_type produced a CONVERSATION-tier document holding fetched text —
    and conversation deliberately does not disarm the actor tools. No live
    document hit this on 2026-07-27; it was reachable by default, which is
    the kind of hole that lands months later in a call site nobody re-reads.
    """
    base = _SOURCE_TYPE_TIER.get((source_type or "").strip().lower(), THIRD_PARTY)
    if base != THIRD_PARTY and (writer_world_reading or has_source_url):
        return THIRD_PARTY
    return base


def lower_of(a: Optional[str], b: Optional[str]) -> str:
    """The LESS trusted of two tiers.

    Origin is monotone: an append may lower a document's trust, never raise
    it. `append_concept` preserves the target's frontmatter, so without this
    an agent holding untrusted content could append into a trusted note and
    have the delta inherit the trusted stamp — laundering, in one call.
    """
    ta = a if a in _RANK else THIRD_PARTY
    tb = b if b in _RANK else THIRD_PARTY
    return ta if _RANK[ta] <= _RANK[tb] else tb


def is_trusted(t: Optional[str]) -> bool:
    """First-party only. Used where the question is 'did the operator or
    Nova author this', e.g. deciding what to auto-retrieve."""
    return t == FIRST_PARTY


def blocks_actors(t: Optional[str]) -> bool:
    """Does holding this text disarm the capability-changing tools?

    THIRD_PARTY only — raw text Nova fetched from the world. Not
    `conversation`, and the distinction is load-bearing rather than
    generous: journals are retrieved on essentially every turn, so keying
    the fence on "anything not first-party" tainted every turn and blocked
    Nova from listing her own automations. A control that fires always is
    the same as no control, except that it also breaks the product.

    Unknown still counts, because unknown is third_party by construction.

    THE RESIDUAL, stated rather than papered over: a journal is a transcript
    and can quote a page the model read aloud, so injected text can reach a
    later turn second-hand. It arrives as a quotation inside a conversation
    rather than as a document presented as knowledge, which is weaker — and
    phase 4's consent gate is what covers the high-value verbs regardless.
    """
    return (t or THIRD_PARTY) == THIRD_PARTY
