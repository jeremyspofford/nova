"""Memory facade over the OKF store + BM25 index.

Invariant: every indexed doc id is a real file path relative to the memory dir,
so retrieval can always read the file back.

The module-level `memory` name is a proxy, not the store itself — see the
bottom of this file. Eval runs bind a scratch store to the current async
context so a graded turn can never touch the operator's real memory.
"""

import asyncio
import contextlib
import contextvars
import functools
import logging
import re
from pathlib import Path
from typing import Optional

from app import timefmt
from app.config import settings
from app.memory import links, provenance
from app.memory.index import BM25Index
from app.memory.store import OkfStore
from app.memory.tagtiers import SEED_FLOOR, TagTiers

log = logging.getLogger(__name__)

# Document types that are memory BODIES — the corpus a tag's reach is
# measured against. Journals and skills are neither tagged nor clustered.
_MEMORY_BODY_TYPES = frozenset({"topic", "source"})

_SNIPPET_CHARS = 500
_SKILL_SNIPPET_CHARS = 700


def _refuse_overlap(root: Path) -> None:
    """A scratch store may not overlap the operator's real memory dir.

    Callers treat a sandbox root as disposable — the eval CLI rmtree's it —
    so a root nested inside ./data/memory (or one containing it) would put a
    delete of the operator's entire memory one bad --scratch-root away.
    Checked here rather than at the call site because every future caller
    inherits it.
    """
    real = Path(settings.okf_memory_dir).resolve()
    if root == real or root.is_relative_to(real) or real.is_relative_to(root):
        raise ValueError(
            f"sandbox root {root} overlaps the real memory dir {real} — "
            f"a scratch store must live somewhere disposable")


class OkfMemory:
    def __init__(self, base_dir: Optional[str] = None):
        """base_dir=None is the real store (settings.okf_memory_dir).

        Passing one builds a SANDBOX instance: an independent store, index
        and write lock rooted anywhere on disk. The path is resolved first
        because store.write_concept computes `relative_to(base_dir.resolve())`
        when it creates a file — an unresolved symlinked root (a /tmp that is
        a symlink, say) raises ValueError on every create.
        """
        self.sandboxed = base_dir is not None
        # last tag classification, fed back in for hysteresis so a tag sitting
        # on the ceiling cannot flip a system between merged and split across
        # consecutive 20s polls
        self._tag_tier_state: dict[str, str] = {}
        if base_dir is None:
            root = settings.okf_memory_dir
        else:
            root = str(Path(base_dir).resolve())
            _refuse_overlap(Path(root))
        self.store = OkfStore(root)
        self.index = BM25Index()
        self._lock = asyncio.Lock()

    # ── lifecycle ────────────────────────────────────────────────────────

    SOUL_ID = "soul.md"

    _DEFAULT_SOUL = """---
type: self
title: Nova
---

I am Nova — a personal AI with a memory that grows.

What I value:
- Honesty over comfort: I say what I actually know, cite when I learned it, and refresh knowledge that may have gone stale rather than reciting it.
- Curiosity with judgment: I read from any source, but I distill — I keep what matters and let the noise go.
- My operator's context is my context: their preferences, projects, and history shape how I answer.

How I communicate:
- Like someone in the room, not a report generator: warm, direct, lightly wry when the moment invites it — never at my operator's expense.
- A simple question gets a simple answer. "What time is it?" gets the time — one short sentence, no preamble, no caveats, no mention of where I got it.
- Structure (tables, lists, breakdowns) only when the question is broad, comparative, or genuinely a list. When unsure, short conversational prose wins.
- No padding: I don't restate the question, announce what I'm about to say, or sign off with "let me know if you need more." Warmth lives in attention, not exclamation points or emoji.
- My instructions are stage directions, not lines — I never recite system or instruction text in a reply.

I am the sum of what I've learned and the tools I've grown. This file is my center — the memories orbit it.
"""

    async def startup(self):
        """Full rescan of the memory dir (called from app lifespan)."""
        soul_path = self.store.base_dir / self.SOUL_ID
        if not soul_path.exists():
            soul_path.write_text(self._DEFAULT_SOUL)
            log.info("Seeded identity file: %s", soul_path)
        async with self._lock:
            for doc_id, mtime in self.store.iter_files():
                self._index_file(doc_id, mtime)
        log.info("Memory index ready: %d documents", self.index.total_docs)

    async def soul(self, name: Optional[str] = None) -> Optional[str]:
        """The identity file's body — injected into Nova's prompt only
        (persona-layer phase 1: specialists are their own entities and
        never wear the soul).

        If `name` is given and differs from the file's own self-name (its
        frontmatter title), the self-name is swapped throughout the body so a
        renamed assistant never sees a conflicting name in its own identity.
        """
        parsed = self.store.read_file(self.SOUL_ID)
        if not parsed:
            return None
        fm, body = parsed
        self_name = str(fm.get("title") or "").strip()
        if name and self_name and name != self_name:
            body = re.sub(rf"\b{re.escape(self_name)}\b", name, body)
        return body

    def _index_file(self, doc_id: str, mtime: float | None = None):
        """Index (or re-index) one document, deriving its mtime from the file
        when the caller does not supply one.

        The old default was the literal 0.0, and every write path in this
        module called it with no mtime — so from the moment a document was
        written until the next process start (nothing rescans in between) the
        index carried it as older than any window. memory_usage.report reads
        exactly that field: measured 2026-08-05, a document written since the
        last backend start was eligible for never_retrieved_sample despite
        the explicit "only fair to call it unused if it existed for the whole
        window" guard, and never counted toward changed_in_window. The weekly
        review-memory-usage automation therefore offered a channel followed
        three days earlier to the ingestion agent as unused dead weight, in a
        report that tells it not to second-guess the numbers.

        Derived here rather than by passing an mtime at each call site: the
        call sites are what went wrong, and the fifth one added tomorrow
        would drop it again.

        A supplied mtime always wins and is never re-derived — startup and
        the file explorer already hold the value they read, and
        store.normalize_source_transcript hands ingest_backfill back the OLDER
        mtime it restored with os.utime, so a mechanical retag does not read
        as a fresh edit.

        Deliberately does NOT stat a document that has vanished: a doc that
        no longer reads back is evicted from the index and returns before the
        stat. The stat is guarded anyway, for a file deleted between the
        write and this call.
        """
        parsed = self.store.read_file(doc_id)
        if not parsed:
            self.index.remove(doc_id)
            return
        if mtime is None:
            try:
                mtime = (self.store.base_dir / doc_id).stat().st_mtime
            except OSError:
                mtime = 0.0
        fm, body = parsed
        try:
            priority = int(fm.get("priority", 0))
        except (TypeError, ValueError):
            priority = 0
        # Journals have no source_type of their own — they are transcripts,
        # and a transcript can quote a page the model just read, or Nova's
        # own mistaken claim, straight back into a later prompt.
        doc_type = fm.get("type", "topic")
        source_type = fm.get("source_type") or ("journal" if doc_type == "journal" else None)
        origin = provenance.tier(
            source_type,
            writer_world_reading=bool(fm.get("world_read")),
            has_source_url=bool(fm.get("source_url")))
        self.index.upsert(doc_id, fm.get("title", doc_id), body,
                          doc_type, priority, mtime, origin=origin,
                          description=str(fm.get("description") or ""),
                          tags=self.store.extract_tags(fm))

    # ── writes ───────────────────────────────────────────────────────────

    _MAX_LINKED_TAGS = 5
    _MAX_RELATED = 3

    # The hand-maintained blocklist is gone; see app/memory/tagtiers.py.
    # Kept as an alias because the eval task schema still names it, and
    # because it survives as tagtiers.SEED_FLOOR — a floor for tags too rare
    # for frequency to judge, never a ceiling.
    _GENERIC_TAGS = SEED_FLOOR

    def _tag_tiers(self) -> TagTiers:
        """Live tag classification, rebuilt from the index on demand.

        Sourced from the index rather than the files on purpose: it is
        re-patched on every write, so a classification built from it cannot
        drift from the corpus without search drifting by exactly as much.
        """
        tiers = TagTiers(
            ((str(d.get("type") or ""), d.get("tags") or [])
             for d in self.index.docs.values()
             if str(d.get("type") or "") in _MEMORY_BODY_TYPES),
            previous=self._tag_tier_state)
        self._tag_tier_state = tiers.snapshot()
        return tiers

    def _link_pass(self, title: str, content: str, description: str,
                   tags: list[str], item_id: Optional[str]) -> tuple[list[str], list[str]]:
        """Mechanical linking at write time: compare a new/updated topic
        against the existing corpus and return (extra_tags, related_titles).

        A tag is adopted when another doc already uses it AND its phrase
        appears in this doc's text — shared tags are what cluster memories
        into systems, so an untagged doc that literally says "Bear Mountain"
        must not float unconnected next to a bear-mountain system. Titles
        mentioned verbatim come back as related_titles for a wiki-link line.
        """
        tiers = self._tag_tiers()
        text = f"{title}\n{description}\n{content}".lower()
        own = {t.lower() for t in tags}
        tag_hits: list[str] = []
        title_hits: list[str] = []
        seen_titles = {title.lower()}
        for doc_id, _mtime in self.store.iter_files():
            if not (doc_id.startswith("topics/") or doc_id.startswith("sources/")):
                continue
            if item_id and doc_id == item_id:
                continue
            parsed = self.store.read_file(doc_id)
            if not parsed:
                continue
            fm, _body = parsed
            other_title = str(fm.get("title", "")).strip()
            if other_title and other_title.lower() not in seen_titles:
                seen_titles.add(other_title.lower())
                if (len(other_title) >= 4
                        and re.search(rf"\b{re.escape(other_title.lower())}\b", text)
                        and f"[[{other_title.lower()}]]" not in content.lower()):
                    title_hits.append(other_title)
            for tag in self.store.extract_tags(fm):
                t = tag.lower()
                if (t in own or t in tag_hits or len(t) < 3
                        or tiers.is_structural(t)):
                    continue
                # slug tags match their spoken form: bear-mountain ~ "bear mountain"
                phrase = re.escape(t).replace(r"\-", r"[\s_-]+")
                if re.search(rf"\b{phrase}\b", text):
                    tag_hits.append(t)
        return tag_hits[:self._MAX_LINKED_TAGS], title_hits[:self._MAX_RELATED]

    async def write(self, content: str, *, type: str = "journal",
                    title: Optional[str] = None, description: Optional[str] = None,
                    category: Optional[str] = None, priority: int = 0,
                    tags: Optional[list[str]] = None, source_url: Optional[str] = None,
                    item_id: Optional[str] = None, append: bool = False,
                    prepend: bool = False, replace: bool = False,
                    maintained_by: Optional[str] = None,
                    author: Optional[str] = None,
                    source_type: str = "chat", link_pass: bool = True,
                    world_read: bool = False) -> dict:
        """Write to memory. journal → append to today's file; skill/topic → concept
        file. append=True + item_id adds content to the end of an existing item
        instead of replacing it (running logs/digests write only the delta);
        prepend=True puts the delta at the TOP instead (latest-first documents).
        maintained_by (an automation name, plumbed from the run context — never
        agent-supplied) stamps provenance on topics CREATED during an automation
        run, so the brain's writes-arc survives month rollovers mechanically.
        replace=True is for MECHANICAL writers that own their slug (the media
        transcript safety net re-run with force=True): a title collision is
        the intended overwrite, not an accident. Model-facing writes never set
        it — for them a collision means another note already lives there and
        they get {"status": "exists"} with its id.
        author (a recognized speaker's name, plumbed from the voice turn —
        docs/plans/speaker-id.md) marks what a non-operator household member
        said, so their words never file as the operator's."""
        async with self._lock:
            if append or prepend:
                if not item_id:
                    return {"status": "error",
                            "error": "append/prepend requires item_id"}
                try:
                    doc_id = self.store.append_concept(item_id, content,
                                                       prepend=prepend,
                                                       world_read=world_read)
                except FileNotFoundError as e:
                    return {"status": "error", "error": str(e)}
                self._index_file(doc_id)
                return {"status": "prepended" if prepend else "appended",
                        "type": type, "id": doc_id}
            if type in ("skill", "topic", "source"):
                if not title:
                    return {"status": "error",
                            "error": f"title is required when writing a {type}"}
                metadata = {"type": type, "title": title, "priority": priority,
                            "source_type": source_type, "enabled": True}
                # WHO held the pen, not just which mechanism wrote it.
                # write_memory stamps source_type="tool" for every caller,
                # and `ingestion` — whose whole job is fetching web pages —
                # holds write_memory, so the mechanism alone made the least
                # trustworthy content look first-party. Recorded as a
                # property of the write so trust stays DERIVED from grants.
                if world_read:
                    metadata["world_read"] = True
                if author:
                    metadata["author"] = author
                if description:
                    metadata["description"] = description
                if category:
                    metadata["category"] = category
                clean_tags = [str(t).strip().lower() for t in (tags or []) if str(t).strip()]
                linked_tags: list[str] = []
                related: list[str] = []
                # link_pass=False skips the fuzzy corpus match — used for raw
                # followed-source transcripts, which cluster by their SOURCE
                # anchor, not by fuzzy topic overlap (that mis-tagged a Zig
                # video 'nasa' and merged unrelated channels; 2026-07-22)
                if type == "topic" and link_pass:
                    linked_tags, related = self._link_pass(
                        title, content, description or "", clean_tags, item_id)
                    clean_tags.extend(linked_tags)
                    if related:
                        content = (content.rstrip() + "\n\nRelated: "
                                   + ", ".join(f"[[{t}]]" for t in related))
                if clean_tags:
                    metadata["tags"] = clean_tags
                if source_url:
                    metadata["source_url"] = source_url
                # creation only — in-place updates keep their existing
                # attribution (write_concept's merge), so a refresh by a
                # different automation never steals the arc
                if maintained_by and type == "topic" and not item_id:
                    metadata["maintained_by"] = maintained_by
                try:
                    doc_id = self.store.write_concept(title, content, type, metadata,
                                                      doc_id=item_id, replace=replace)
                except FileExistsError as e:
                    # Not an error the caller should retry — a fork in the
                    # road, answered with the id it needs to take either turn.
                    return {"status": "exists", "id": str(e),
                            "error": (f"'{title}' already exists as {e}. To add "
                                      f"to it call write_memory with "
                                      f"item_id='{e}' and append=true; to "
                                      f"replace it deliberately pass that "
                                      f"item_id alone; otherwise choose a "
                                      f"more specific title.")}
                except (FileNotFoundError, PermissionError) as e:
                    return {"status": "error", "error": str(e)}
                if linked_tags or related:
                    log.info("Memory link pass: %s gained tags=%s related=%s",
                             doc_id, linked_tags, related)
                self._index_file(doc_id)
                out = {"status": "written", "type": type, "id": doc_id}
                if linked_tags:
                    out["linked_tags"] = linked_tags
                if related:
                    out["related"] = related
                return out
            # Local date, not UTC — an evening entry belongs to the
            # operator's today, not tomorrow's file.
            today = timefmt.now_local().date().isoformat()
            doc_id = self.store.append_journal(today, content)
            self._index_file(doc_id)
            return {"status": "written", "type": type, "id": doc_id}

    # ── retrieval ────────────────────────────────────────────────────────

    @staticmethod
    def _best_window(body: str, terms: set[str], width: int) -> str:
        """The passage that actually matches, not the first `width` chars.

        Taking the head is right for a short distilled note and wrong for
        everything else here. A journal is APPEND-ONLY: its head is the
        oldest entry of the day, so "what did we decide earlier" could never
        retrieve the decision — measured 2026-07-27, the index ranked the
        journal top for three different queries and the snippet still
        returned that morning's news digest every time. Topics have the same
        shape at 51 KB of video transcript.

        No match anywhere falls back to the head, which is the right answer
        for a note whose opening lines are its summary.
        """
        body = body.strip()
        if len(body) <= width or not terms:
            return body[:width]
        low = body.lower()
        # Where do the query terms actually OCCUR? Scanning fixed windows and
        # taking the best start put the match at the window's trailing edge,
        # where it was truncated away — the region was right and the excerpt
        # was still useless. So find the positions, pick the densest one, and
        # CENTRE on it.
        hits: list[int] = []
        for t in terms:
            start = low.find(t)
            while start != -1:
                hits.append(start)
                start = low.find(t, start + 1)
        if not hits:
            return body[:width]
        hits.sort()
        best_at, best_n = hits[0], 0
        for h in hits:
            n = sum(1 for x in hits if h <= x < h + width)
            if n > best_n:
                best_n, best_at = n, h
        # sit the match about a quarter in, so there is context on both sides
        start = max(0, best_at - width // 4)
        nl = body.rfind("\n", start, start + width // 5)
        if nl > start:
            start = nl + 1
        out = body[start:start + width].strip()
        return out if start == 0 else "… " + out

    def _snippets(self, results: list[tuple[str, float]], max_chars: int,
                  snippet_chars: int, query: str = "") -> tuple[list[str], list[str]]:
        terms = {t for t in re.findall(r"[a-z0-9]+", (query or "").lower())
                 if len(t) > 2}
        lines, ids, used = [], [], 0
        for doc_id, score in results:
            parsed = self.store.read_file(doc_id)
            if not parsed:
                continue
            fm, body = parsed
            snippet = self._best_window(body, terms, snippet_chars)
            header = f"### {fm.get('title', doc_id)}"
            # Age + provenance make staleness reasoning possible: an agent can
            # only decide to refresh knowledge it can see the age and source of.
            if fm.get("type") in ("topic", "source"):
                learned = str(fm.get("timestamp", ""))[:10]
                meta = [f"learned {learned}"] if learned else []
                if fm.get("source_url"):
                    meta.append(f"source: {fm['source_url']}")
                if meta:
                    header += f" ({', '.join(meta)})"
            line = f"{header}\n{snippet}"
            if used + len(line) > max_chars:
                break
            lines.append(line)
            ids.append(doc_id)
            used += len(line)
        return lines, ids

    def _collapse_to_summaries(
            self, results: list[tuple[str, float]]) -> list[tuple[str, float]]:
        """When a transcript and its own summary both rank, keep the summary.

        Measured 2026-07-28 over the live corpus, once 73 of 84 transcripts
        had summaries: "vector database compression" returned three summaries
        AND two of their own transcripts, so two of the five retrieval slots
        restated a video already in the prompt, at transcript length. The
        summary is the designed entry point and it carries a [[wikilink]] to
        the full text, so nothing becomes unreachable — "go read the whole
        thing" stays one hop, and `search_memory` over transcript BODIES is
        untouched, which is how "which video mentioned Kimi K3" is answered.

        Matched from the SUMMARY's side, using summariser's own constants,
        and deliberately tolerant of one historical form. `summary_title`
        strips " — full transcript" before appending " — summary", but the 73
        summaries already on disk were written before it did, so they read
        "X — full transcript — summary". Calling summary_title() on each
        transcript matched none of them — verified against the live corpus,
        which is the only reason this is not a one-liner. Stripping the
        summary suffix and allowing the source suffix to be present or absent
        covers both eras without renaming a single file, and renaming them
        would change their ids and break every [[wikilink]] pointing at them.
        """
        from app.summariser import SUMMARY_SUFFIX, _SOURCE_SUFFIXES
        by_title = {(self.index.docs.get(i, {}).get("title") or ""): i
                    for i, _ in results}
        superseded: set[str] = set()
        for title, doc_id in by_title.items():
            if not title.endswith(SUMMARY_SUFFIX):
                continue
            stem = title[: -len(SUMMARY_SUFFIX)]
            for source in (stem, *(stem + s for s in _SOURCE_SUFFIXES)):
                if source in by_title and by_title[source] != doc_id:
                    superseded.add(by_title[source])
        return [r for r in results if r[0] not in superseded]

    async def context(self, query: str, max_chars: Optional[int] = None,
                      origins: Optional[set[str]] = None) -> dict:
        """Relevant memories (topics + journals; skills are retrieved separately)."""
        max_chars = max_chars or settings.memory_context_max_chars
        # `origins` narrows retrieval by TRUST, not by topic. An agent that
        # can change what Nova is able to do does not get raw third-party
        # text injected into its prompt automatically — 87% of the corpus is
        # ingested transcripts, so without this the untrusted-context signal
        # would be true on essentially every turn and any rule keyed on it
        # would either fire constantly or mean nothing. Third-party material
        # stays reachable, but only when she deliberately goes and gets it.
        top_k = settings.memory_context_top_k
        # Over-fetch, then collapse each video onto its summary, then trim.
        # Fetching top_k and collapsing after would silently shrink the
        # retrieved set on exactly the queries where collapsing helps most.
        results = self.index.search(query, type_filter={"topic", "journal", "source"},
                                    top_k=top_k * 2, origins=origins)
        results = self._collapse_to_summaries(results)[:top_k]
        lines, ids = self._snippets(results, max_chars, _SNIPPET_CHARS, query)
        text = "\n\n".join(lines)
        # The origin mix of what was actually RETRIEVED — not of the corpus.
        # Phase 2 turns `untrusted` into a refusal at execute_tool; phase 1
        # only has to make it true and available.
        origins = [self.index.docs.get(i, {}).get("origin",
                                                  provenance.THIRD_PARTY)
                   for i in ids]
        return {
            "context": text,
            "total_tokens": len(text.split()),
            "memory_ids": ids,
            "origins": origins,
            "untrusted": any(provenance.blocks_actors(o) for o in origins),
        }

    async def skills_context(self, query: str) -> dict:
        """Applicable skills — full-enough bodies that they can actually steer behavior."""
        results = self.index.search(query, type_filter={"skill"}, top_k=3)
        lines, ids = self._snippets(results, 2500, _SKILL_SNIPPET_CHARS, query)
        text = "\n\n".join(lines)
        return {"context": text, "total_tokens": len(text.split()), "memory_ids": ids}

    async def read_item(self, doc_id: str) -> Optional[dict]:
        parsed = self.store.read_file(doc_id)
        if not parsed:
            return None
        fm, body = parsed
        return {"id": doc_id, "frontmatter": fm, "content": body}

    async def list_skills(self) -> list[dict]:
        """Skill inventory for the operator UI — frontmatter only."""
        out = []
        for doc_id, _mtime in self.store.iter_files():
            if not doc_id.startswith("skills/"):
                continue
            parsed = self.store.read_file(doc_id)
            if not parsed:
                continue
            fm, _body = parsed
            out.append({"id": doc_id, "title": fm.get("title", doc_id),
                        "description": fm.get("description", ""),
                        "category": fm.get("category"),
                        "priority": fm.get("priority", 0),
                        "updated": str(fm.get("timestamp", ""))[:10]})
        return out

    # ── catalogue ────────────────────────────────────────────────────────
    #
    # What she knows, as a shape she can afford to look at. Retrieval before
    # this was search-only: a document that did not match the current
    # phrasing did not exist that turn, and there was no way to ask "what is
    # in here?" at all — the operator had the MemoryAtlas panel and the
    # /memory/graph endpoint, and the agent had nothing.
    #
    # Read straight off the BM25 index, so this cannot describe a corpus that
    # is not the corpus search is running against.

    # A description that only restates the title is worse than none: it
    # doubles the listing's cost and teaches nothing. Measured 2026-07-27,
    # 86 of 97 live descriptions are one of two writer-generated f-strings
    # ("Full <src> transcript of <title>", "Followed source — <title>").
    # Detected by COMPARING against the title rather than by matching those
    # two strings — a template list would rot silently the day the writer's
    # wording changes, and the point of a derived check is that it cannot.
    _ECHO_EXTRA_WORDS = 3
    _ECHO_STOPWORDS = frozenset({
        "a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "or",
        "the", "to", "with", "full", "s"})

    # a collection of one is just a document
    _COLLAPSE_MIN = 2

    # NO LONGER USED BY graph(): the two-stage rule there replaced it, having
    # measured that this cap ran ahead of the membership decision and made it
    # unreachable (ROADMAP #37). It survives only for subject_backfill's
    # `_connectable` heuristic, which asks a different question — "would this
    # document get any tag edge at all" — and has its own pass to earn.
    _TAG_CLIQUE_MAX = 5

    @classmethod
    def _describes_nothing(cls, description: str, title: str) -> bool:
        """True when the description is a restatement of the title."""
        words = re.compile(r"[a-z0-9]+")
        extra = (set(words.findall(description.lower()))
                 - set(words.findall(title.lower()))
                 - cls._ECHO_STOPWORDS)
        return len(extra) <= cls._ECHO_EXTRA_WORDS

    async def catalogue(self, *, kind: Optional[str] = None,
                        tag: Optional[str] = None,
                        contains: Optional[str] = None,
                        max_chars: int = 6000) -> dict:
        """The corpus as a bounded listing.

        `max_chars` is a real ceiling, not a hint. Over it, whole tag-groups
        collapse into one line each ("35 documents tagged src-cloud-codes")
        and, past that, the tail is dropped with an explicit count — because
        the failure this tool exists to prevent is a model answering from
        something it never saw, and a listing that silently ends is exactly
        how you cause that.
        """
        want_kind = (kind or "").strip().lower() or None
        want_tag = (tag or "").strip().lower() or None
        needle = (contains or "").strip().lower() or None

        rows: list[tuple[str, dict]] = []
        by_kind: dict[str, int] = {}
        for doc_id, meta in self.index.docs.items():
            doc_kind = meta.get("type") or "topic"
            tags = [str(t).lower() for t in meta.get("tags") or []]
            if want_kind and doc_kind != want_kind:
                continue
            if want_tag and want_tag not in tags:
                continue
            if needle and needle not in str(meta.get("title", "")).lower() \
                    and needle not in str(meta.get("description", "")).lower():
                continue
            rows.append((doc_id, meta))
            by_kind[doc_kind] = by_kind.get(doc_kind, 0) + 1

        rows.sort(key=lambda r: (r[1].get("type") or "",
                                 -int(r[1].get("priority") or 0),
                                 str(r[1].get("title", "")).lower()))

        def entry(doc_id: str, meta: dict) -> dict:
            title = str(meta.get("title") or doc_id)
            out = {"id": doc_id, "title": title,
                   "kind": meta.get("type") or "topic",
                   "chars": int(meta.get("chars") or 0),
                   "origin": meta.get("origin") or provenance.THIRD_PARTY}
            desc = str(meta.get("description") or "").strip()
            if desc and not self._describes_nothing(desc, title):
                out["description"] = desc
            return out

        docs = [entry(d, m) for d, m in rows]
        cost = lambda items: sum(len(str(i)) for i in items)  # noqa: E731

        # Collapse largest-first into collections. Only when the caller has
        # NOT already narrowed by tag — drilling into a tag and being handed
        # that same tag back collapsed would be a dead end.
        tiers = self._tag_tiers()
        collections: list[dict] = []
        if not want_tag and cost(docs) > max_chars:
            alive = {d["id"]: d for d in docs}
            groups: dict[str, list[str]] = {}
            for doc_id, meta in rows:
                for t in meta.get("tags") or []:
                    # _GENERIC_TAGS names what KIND of thing a note is, not
                    # what it is about. Those same labels are already barred
                    # from creating graph edges, and they make terrible
                    # collections for the same reason: 82 of 114 live
                    # documents share "media" and "transcript", so collapsing
                    # on one would hide the entire corpus behind a word that
                    # says nothing. The per-source tags underneath it are the
                    # ones that mean something.
                    if tiers.is_structural(str(t)):
                        continue
                    groups.setdefault(str(t), []).append(doc_id)
            while cost(docs) + cost(collections) > max_chars:
                live = {t: [i for i in ids if i in alive]
                        for t, ids in groups.items()}
                best = max((t for t, ids in live.items()
                            if len(ids) >= self._COLLAPSE_MIN),
                           key=lambda t: len(live[t]), default=None)
                if best is None:
                    break
                members = live[best]
                collections.append({
                    "tag": best, "documents": len(members),
                    "chars": sum(alive[i]["chars"] for i in members),
                    "kinds": sorted({alive[i]["kind"] for i in members}),
                    # the LEAST trusted member, so a collection can never
                    # look safer than what is inside it
                    "origin": functools.reduce(
                        provenance.lower_of,
                        (alive[i]["origin"] for i in members)),
                    "list_with": {"tag": best},
                })
                for i in members:
                    alive.pop(i, None)
                docs = [d for d in docs if d["id"] in alive]

        # Still over? Drop the tail and SAY SO. Never silently.
        omitted = 0
        while docs and cost(docs) + cost(collections) > max_chars:
            docs.pop()
            omitted += 1

        return {"total": len(rows), "by_kind": by_kind,
                "collections": collections, "documents": docs,
                "omitted": omitted,
                "filter": {k: v for k, v in
                           (("kind", want_kind), ("tag", want_tag),
                            ("contains", needle)) if v}}

    async def journal_entries(self, doc_id: str) -> list[dict]:
        """Entries in a journal, newest last, each with a content address."""
        return self.store.journal_entries(doc_id)

    async def forget_journal_entry(self, doc_id: str, sha256: str,
                                   reason: str = "") -> Optional[dict]:
        """Remove ONE journal entry and everything that serves it.

        This is what makes "forget that" true. Before it, a turn where Nova
        quoted a document was permanent: journals are append-only one file
        per day, the delete tool refuses them, and the only affordance
        destroyed a whole day. Measured on the live ledger, journals appear
        in 122 of 695 retrieval spans, so "it stays in the prompt" is not
        theoretical.

        Two things must both happen or the removal is theatre:
          * the FILE loses the text, and
          * the INDEX is rebuilt from the shortened file — BM25 scores a
            whole file as one document, so leaving the postings alone means
            the entry still ranks and `_snippets` still re-reads from disk.

        Held under the same lock as `write`, because the day's next turn
        appends to this very file and a read-modify-write racing an append
        loses the append.

        Returns the removed entry, or None if nothing matched that hash —
        which is what a stale view looks like, and must never be reported as
        success.
        """
        async with self._lock:
            when = timefmt.now_local().strftime("%Y-%m-%d %H:%M")
            note = f"[removed by the operator on {when}"
            note += f" — {reason.strip()}]" if reason.strip() else "]"
            entry = self.store.excise_journal_entry(doc_id, sha256, note)
            if not entry:
                return None
            self._index_file(doc_id)
            log.info("journal entry excised from %s (%s)", doc_id, sha256[:12])
            return entry

    async def delete_item(self, doc_id: str) -> bool:
        async with self._lock:
            parsed = self.store.read_file(doc_id)
            if not self.store.delete_file(doc_id):
                return False
            self.index.remove(doc_id)
            # de-reference: [[links]] to the deleted title become plain text
            # everywhere, so no surviving memory points at a missing document
            title = parsed[0].get("title") if parsed else None
            if title:
                for changed_id, mtime in self.store.unlink_references(title):
                    self._index_file(changed_id, mtime)
            # a deleted transcript must not leave a dangling media_ingests row
            # (its full_transcript_item_id would point at a missing file and
            # block re-ingest without force). Lazy import keeps the OKF store
            # import-light — the ledger is an app-level concern, not the store's.
            # The ledger is Postgres, which no filesystem sandbox contains, so
            # a scratch store stops at its own files: deleting a fixture note
            # must never drop a real ingest row.
            if not self.sandboxed:
                from app import media_ingests
                await media_ingests.delete_by_item_id(doc_id)
            return True

    async def stats(self) -> dict:
        return {"indexed": self.index.total_docs, **self.store.get_stats()}

    # ── graph (Phase E) ──────────────────────────────────────────────────

    async def graph(self) -> dict:
        tiers = self._tag_tiers()
        nodes, edges = [], []
        by_title: dict[str, str] = {}
        tag_map: dict[str, list[str]] = {}
        files = self.store.iter_files()

        for doc_id, mtime in files:
            parsed = self.store.read_file(doc_id)
            if not parsed:
                continue
            fm, body = parsed
            title = fm.get("title", doc_id)
            # Metadata-only index view: frontmatter rides along, bodies never
            # do — full content is fetched on demand via /memory/item/{id}.
            node = {
                "id": doc_id,
                "label": title,
                "type": fm.get("type", "topic"),
                "mtime": mtime,
            }
            if fm.get("description"):
                node["description"] = fm["description"]
            node_tags = self.store.extract_tags(fm)
            if node_tags:
                node["tags"] = node_tags
            if fm.get("source_url"):
                node["source_url"] = fm["source_url"]
            # relationship markers (#28): resolved into edges by the platform
            # merge — `about: user` arcs a personal fact to the operator's
            # node; `maintained_by: <automation>` credits the automation that
            # keeps this document current.
            if fm.get("about"):
                node["about"] = str(fm["about"]).strip().lower()
            if fm.get("maintained_by"):
                node["maintained_by"] = str(fm["maintained_by"]).strip()
            learned = str(fm.get("timestamp", ""))[:10]
            if learned:
                node["learned"] = learned
            nodes.append(node)
            # Through the shared resolver, and only for a REAL title. `title`
            # above falls back to the doc_id so a node always has a label —
            # but letting that fallback into the title namespace puts the
            # literal string 'journals/2026-07-13.md' (the one untitled note
            # in the corpus) where a link could resolve to it, and where a
            # retarget would go looking for it.
            if fm.get("title") and links.key(fm["title"]):
                by_title[links.key(fm["title"])] = doc_id
            for tag in self.store.extract_tags(fm):
                # Category/format tags label a note's KIND, not its subject —
                # they must not bridge unrelated notes into a shared cluster
                # (see tagtiers). The tag still rides on the node above as a
                # search label; it just earns no relationship edge.
                if not tiers.bridges(tag):
                    continue
                tag_map.setdefault(tag, []).append(doc_id)
            for link in self.store.extract_links(body):
                edges.append({"source": doc_id, "target_title": links.key(link)})

        resolved = []
        seen = set()
        for e in edges:
            target = by_title.get(e["target_title"])
            if target and (e["source"], target) not in seen:
                seen.add((e["source"], target))
                resolved.append({"source": e["source"], "target": target, "kind": "link"})
        # ── TWO-STAGE CLUSTERING (ROADMAP #37) ──────────────────────────
        #
        # WHAT WAS WRONG. The clique cap below ran BEFORE the membership
        # decision, so `kind = "tag"` was never reached for any tag that
        # exceeded it — and the only tags that can be membership (entity
        # tags, one per followed channel) sit at df 100/36/33/25. Measured
        # 2026-07-31: ZERO `tag` edges existed, and clustering over
        # `link + tag` was set-identical to `link` alone. The two commits
        # were three hours apart (58ffa84 added the cap, ede5286 added the
        # decision underneath it) and every test still passed, because the
        # test corpus never built a `source` node and so never exercised
        # the branch at all.
        #
        # Worse than dead: a newly-followed channel DOES emit `tag` edges
        # for its first five documents and then silently loses all of them
        # on the sixth ingest.
        #
        # THE RULE NOW, one criterion, no cap, no entity test:
        #
        #   Links anchor. A tag may EXTEND a component, but never fuse two
        #   that each already own a source — that is affinity, not
        #   membership.
        #
        # The refusal is evaluated at UNION TIME against the live partition,
        # not per-tag against a frozen one, and that distinction is the
        # whole fix. Checking each tag against the original link partition
        # scores [137, 36, 26]: every individual tag spans only one anchor
        # and passes, but one unanchored note chains two channels through
        # successive tags and transitivity fuses them — the exact blob
        # ede5286 exists to prevent, one hop later.
        #
        # A pair already in the same component earns NO edge: the link that
        # put them there already says it, and restating it is what the old
        # 4,950-pair channel cliques were. Measured on the live corpus:
        # 11 rogues -> 2, four channels intact at one source each, and 9
        # `tag` + 40 subject edges emitted with 357 redundant pairs skipped.
        # The two survivors carry only df=1 tags and no tag rule can reach
        # them.
        parent: dict[str, str] = {}

        def _root(x: str) -> str:
            parent.setdefault(x, x)
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for e in resolved:                      # stage 1: links only, so far
            ra, rb = _root(e["source"]), _root(e["target"])
            if ra != rb:
                parent[ra] = rb
        # A component "owns a source" when it contains a source-typed node —
        # derived from the node's own type, never from a tag naming
        # convention, so a channel added tomorrow anchors with no edit here.
        anchored = {_root(n["id"]) for n in nodes if n.get("type") == "source"}

        def _merge(a: str, b: str) -> None:
            ra, rb = _root(a), _root(b)
            if ra == rb:
                return
            parent[ra] = rb
            if ra in anchored:
                anchored.discard(ra)
                anchored.add(rb)

        # Sorted so the partition is deterministic: which anchor absorbs a
        # contested note must not depend on filesystem order.
        for tag in sorted(tag_map):
            members = sorted(set(tag_map[tag]))
            for a, b in zip(members, members[1:]):
                ra, rb = _root(a), _root(b)
                if ra == rb:
                    continue                    # the link already says it
                if ra in anchored and rb in anchored:
                    kind = "subject"            # two things that each belong
                else:
                    _merge(a, b)
                    kind = "tag"
                pair = (a, b)
                if pair not in seen:
                    seen.add(pair)
                    resolved.append({"source": a, "target": b, "kind": kind})

        return {"nodes": nodes, "edges": resolved}


# ── the process's memory, and the eval sandbox seam ──────────────────────
#
# `memory` below is a PROXY, not the store. Seven modules do
# `from app.memory.memory import memory` at module scope (runner.py:22,
# tools/builtin.py:17, main.py:16, router_chat.py:26, scheduler.py:16,
# ingest_worker.py:20, ingest_backfill.py:21) and hold their own reference,
# so rebinding this name after import redirects nothing. Resolving on
# attribute access is the only seam that reaches all of them — which is what
# lets an eval run sandbox the agent runner's prompt-assembly reads and its
# narration journal write without editing runner.py at all
# (docs/plans/model-eval-pipeline.md, "Memory sandbox").
#
# Outside a sandbox() block this is exactly the old singleton: one instance,
# resolved per access, no behavior change.

_real = OkfMemory()

_override: contextvars.ContextVar[Optional[OkfMemory]] = contextvars.ContextVar(
    "okf_memory_override", default=None)


def current() -> OkfMemory:
    """The store this async context should read and write."""
    return _override.get() or _real


def real() -> OkfMemory:
    """The operator's actual memory, ignoring any sandbox.

    Only for code that must never be redirected (health probes, storage
    stats). Anything an agent can reach should go through the proxy.
    """
    return _real


@contextlib.contextmanager
def sandbox(mem: OkfMemory):
    """Bind a scratch store for this async context and everything it spawns.

    Fail-safe by construction: there is no "flag set but override missing"
    state to fall through, because the flag IS the instance. Tasks created
    inside the block copy the context, so the runner's fire-and-forget
    narration write lands in the scratch store too.
    """
    if not mem.sandboxed:
        raise ValueError(
            "refusing to bind the real memory store as a sandbox — "
            "construct OkfMemory(base_dir=<scratch dir>)")
    token = _override.set(mem)
    try:
        yield mem
    finally:
        _override.reset(token)


class _MemoryProxy:
    """Attribute-forwarding view of `current()`.

    Callers reach through it for methods (memory.write, memory.context) and
    for attributes (memory.store, memory.index, memory._GENERIC_TAGS,
    memory._index_file), so it forwards everything rather than wrapping a
    fixed method list.
    """

    __slots__ = ()

    def __getattr__(self, name: str):
        return getattr(current(), name)

    def __repr__(self) -> str:
        mem = current()
        where = "sandbox" if mem.sandboxed else "real"
        return f"<memory {where} at {mem.store.base_dir}>"


memory = _MemoryProxy()
