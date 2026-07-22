"""Memory facade over the OKF store + BM25 index.

Invariant: every indexed doc id is a real file path relative to the memory dir,
so retrieval can always read the file back.
"""

import asyncio
import logging
import re
from typing import Optional

from app import timefmt
from app.config import settings
from app.memory.index import BM25Index
from app.memory.store import OkfStore

log = logging.getLogger(__name__)

_SNIPPET_CHARS = 500
_SKILL_SNIPPET_CHARS = 700


class OkfMemory:
    def __init__(self):
        self.store = OkfStore(settings.okf_memory_dir)
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

    def _index_file(self, doc_id: str, mtime: float = 0.0):
        parsed = self.store.read_file(doc_id)
        if not parsed:
            self.index.remove(doc_id)
            return
        fm, body = parsed
        try:
            priority = int(fm.get("priority", 0))
        except (TypeError, ValueError):
            priority = 0
        self.index.upsert(doc_id, fm.get("title", doc_id), body,
                          fm.get("type", "topic"), priority, mtime)

    # ── writes ───────────────────────────────────────────────────────────

    _MAX_LINKED_TAGS = 5
    _MAX_RELATED = 3

    # Tags that name what KIND or FORMAT a note is, not what it is ABOUT.
    # Fine as search/filter labels, but they must NEVER create graph edges or
    # be auto-adopted: two notes sharing "zoo" or "transcript" only fall in the
    # same broad category — they are not related. This is the exact class of
    # bug where a Bear Mountain hiking attraction got tag-bridged to the "Me at
    # the zoo" YouTube video through the coincidental word "zoo", and where the
    # ingestion pipeline's own "media"/"transcript" tags chained together
    # unrelated videos (a moon-landing clip, a commencement speech, an elephant
    # video). Named-entity tags (bear-mountain, nasa, voyager, me-at-the-zoo)
    # are deliberately NOT here — those name a specific subject and SHOULD
    # cluster. The distinction is common-noun/category vs. named entity; extend
    # this set as new generic tags surface (it is a label list, not config).
    _GENERIC_TAGS = frozenset({
        # format / medium (several of these are auto-applied at ingest time)
        "media", "transcript", "transcripts", "video", "audio", "image",
        "photo", "photograph", "article", "document", "note", "notes",
        "summary", "digest", "overview", "guide", "reference", "data",
        "source", "sources", "tool", "tools", "content",
        # broad kinds of place / thing
        "zoo", "museum", "museums", "park", "state-park", "facilities",
        "visitor-info", "recreation", "hiking", "trail", "trails", "nature",
        "animals", "travel", "food", "music", "art", "people", "places",
        # broad subject areas
        "history", "science", "technology", "tech", "news", "sports",
        "sports-news", "tech-news", "ai-news", "culture", "internet-culture",
        "entertainment", "education", "politics", "business", "finance",
        "misc", "general", "info", "information",
        # broad geographies — a shared state/country/region is a LOCATION
        # category, not a shared subject: Bear Mountain State Park and the NY
        # Giants are both "new-york" yet wholly unrelated. Add specific broad
        # places as they recur (a city/state/country almost never means two
        # notes are about the same thing).
        "new-york", "new-york-city", "nyc", "united-states", "usa", "us",
        "america", "california", "texas", "florida", "europe", "asia",
        "africa", "world", "global",
    })

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
                        or t in self._GENERIC_TAGS):
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
                    prepend: bool = False,
                    maintained_by: Optional[str] = None,
                    source_type: str = "chat", link_pass: bool = True) -> dict:
        """Write to memory. journal → append to today's file; skill/topic → concept
        file. append=True + item_id adds content to the end of an existing item
        instead of replacing it (running logs/digests write only the delta);
        prepend=True puts the delta at the TOP instead (latest-first documents).
        maintained_by (an automation name, plumbed from the run context — never
        agent-supplied) stamps provenance on topics CREATED during an automation
        run, so the brain's writes-arc survives month rollovers mechanically."""
        async with self._lock:
            if append or prepend:
                if not item_id:
                    return {"status": "error",
                            "error": "append/prepend requires item_id"}
                try:
                    doc_id = self.store.append_concept(item_id, content,
                                                       prepend=prepend)
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
                                                      doc_id=item_id)
                except FileNotFoundError as e:
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

    def _snippets(self, results: list[tuple[str, float]], max_chars: int,
                  snippet_chars: int) -> tuple[list[str], list[str]]:
        lines, ids, used = [], [], 0
        for doc_id, score in results:
            parsed = self.store.read_file(doc_id)
            if not parsed:
                continue
            fm, body = parsed
            snippet = body[:snippet_chars].strip()
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

    async def context(self, query: str, max_chars: Optional[int] = None) -> dict:
        """Relevant memories (topics + journals; skills are retrieved separately)."""
        max_chars = max_chars or settings.memory_context_max_chars
        results = self.index.search(query, type_filter={"topic", "journal", "source"},
                                    top_k=settings.memory_context_top_k)
        lines, ids = self._snippets(results, max_chars, _SNIPPET_CHARS)
        text = "\n\n".join(lines)
        return {
            "context": text,
            "total_tokens": len(text.split()),
            "memory_ids": ids,
        }

    async def skills_context(self, query: str) -> dict:
        """Applicable skills — full-enough bodies that they can actually steer behavior."""
        results = self.index.search(query, type_filter={"skill"}, top_k=3)
        lines, ids = self._snippets(results, 2500, _SKILL_SNIPPET_CHARS)
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
            return True

    async def stats(self) -> dict:
        return {"indexed": self.index.total_docs, **self.store.get_stats()}

    # ── graph (Phase E) ──────────────────────────────────────────────────

    async def graph(self) -> dict:
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
            by_title[title.lower()] = doc_id
            for tag in self.store.extract_tags(fm):
                # generic category/format tags label a note's KIND, not its
                # subject — they must not bridge unrelated notes into a shared
                # cluster (see _GENERIC_TAGS). The tag still rides on the node
                # above as a search label; it just earns no relationship edge.
                if tag.lower() in self._GENERIC_TAGS:
                    continue
                tag_map.setdefault(tag, []).append(doc_id)
            for link in self.store.extract_links(body):
                edges.append({"source": doc_id, "target_title": link.lower()})

        resolved = []
        seen = set()
        for e in edges:
            target = by_title.get(e["target_title"])
            if target and (e["source"], target) not in seen:
                seen.add((e["source"], target))
                resolved.append({"source": e["source"], "target": target, "kind": "link"})
        for tag, members in tag_map.items():
            for i in range(len(members) - 1):
                pair = (members[i], members[i + 1])
                if pair not in seen:
                    seen.add(pair)
                    resolved.append({"source": pair[0], "target": pair[1], "kind": "tag"})

        return {"nodes": nodes, "edges": resolved}


memory = OkfMemory()
