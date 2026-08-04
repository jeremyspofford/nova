"""OKF-style markdown file store. Every memory item is a real file on disk."""

import hashlib
import logging
import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from app import timefmt
from app.memory import provenance

log = logging.getLogger(__name__)

TYPE_DIRS = {"topic": "topics", "skill": "skills", "journal": "journals", "source": "sources"}

# Where a PINNED write (doc_id=...) may land. write_concept replaces a file's
# whole body, and only concepts are things you refresh. journals/ are the
# record of what happened — delete_memory_item already refuses to touch them
# — and soul.md sits at the root and is identity, not a note. The old guard
# was "inside the memory dir, ends in .md, exists", so an item_id of
# 'journals/2026-07-24.md' or 'soul.md' silently replaced either one.
_PINNABLE_DIRS = {TYPE_DIRS[t] for t in ("topic", "skill", "source")}

_WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")


def write_text_atomic(path: Path, text: str) -> None:
    """Write `text` to `path` without following a link and without a torn read.

    The same contract the Files editor's save uses, in one place so the two
    cannot drift: a random temp name so it cannot be pre-placed, O_EXCL so an
    existing name is an error rather than a target, O_NOFOLLOW so a symlink
    is refused rather than followed, and os.replace so a reader never sees a
    half-written note.
    """
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            os.write(fd, text.encode("utf-8"))
        finally:
            os.close(fd)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _slugify(title: str) -> str:
    slug = re.sub(r"[^\w\s-]", "", title.lower()).strip()
    return re.sub(r"[\s_]+", "-", slug) or "untitled"


class OkfStore:
    def __init__(self, base_dir: str):
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)
        for d in TYPE_DIRS.values():
            (self.base_dir / d).mkdir(exist_ok=True)

    # ── frontmatter ──────────────────────────────────────────────────────

    @staticmethod
    def parse_frontmatter(content: str) -> tuple[dict, str]:
        if not content.startswith("---"):
            return {}, content
        m = re.match(r"^---\n(.*?)\n---\n?(.*)", content, re.DOTALL)
        if not m:
            return {}, content
        fm_text, body = m.groups()
        fm: dict = {}
        for line in fm_text.split("\n"):
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            fm[key.strip()] = value.strip().strip("\"'")
        return fm, body.strip()

    @staticmethod
    def render_frontmatter(fm: dict) -> str:
        lines = ["---"]
        for key, value in fm.items():
            if isinstance(value, bool):
                value = str(value).lower()
            elif isinstance(value, (list, tuple)):
                value = "[" + ", ".join(str(v) for v in value) + "]"
            lines.append(f"{key}: {value}")
        lines.append("---")
        return "\n".join(lines)

    # ── writes ───────────────────────────────────────────────────────────

    def write_concept(self, title: str, content: str, concept_type: str = "topic",
                      metadata: Optional[dict] = None,
                      doc_id: Optional[str] = None, replace: bool = False) -> str:
        """Write a concept file. Returns the doc id (relative path).

        doc_id pins the write to an existing CONCEPT file (in-place update even
        when the title differs) — it must resolve inside the memory dir, live
        under one of _PINNABLE_DIRS, and already exist.

        Without doc_id this creates, and a taken slug raises FileExistsError
        rather than flattening whatever is there. replace=True opts out, for
        mechanical writers that own their slug.
        """
        fm = dict(metadata or {})
        fm.setdefault("type", concept_type)
        fm.setdefault("title", title)
        fm["timestamp"] = datetime.now(timezone.utc).isoformat()

        if doc_id:
            pinned = (self.base_dir / doc_id).resolve()
            base = self.base_dir.resolve()
            if not (pinned.is_relative_to(base) and pinned.suffix == ".md"
                    and pinned.exists()):
                raise FileNotFoundError(f"memory item '{doc_id}' not found")
            rel = pinned.relative_to(base)
            if len(rel.parts) != 2 or rel.parts[0] not in _PINNABLE_DIRS:
                raise PermissionError(
                    f"'{doc_id}' is not a concept item — only "
                    f"{'/, '.join(sorted(_PINNABLE_DIRS))}/ items can be "
                    f"rewritten. Journals are the record of what happened; "
                    f"append to them instead of replacing them.")
            path = pinned
            # In-place updates preserve frontmatter keys the caller doesn't
            # set: data-level markers (maintained_by, about, hand-added keys)
            # must survive a REFRESH, not just an append.
            existing, _body = self.parse_frontmatter(path.read_text())
            fm = {**existing, **fm}
            # ORIGIN IS MONOTONE — the same law append_concept states below.
            # A caller-wins merge is right for hand-added keys and wrong for
            # this one: OkfMemory.write supplies source_type on every call and
            # _write_memory sends the literal "tool" for every caller, so a
            # REFRESH of an ingested transcript rewrote its stamp from
            # media_transcript (third_party) to tool (first_party). That is a
            # silent trust RAISE, performed by a feature built to preserve
            # frontmatter. One document on disk had already been laundered
            # this way before this landed.
            #
            # Compare TIERS, not the raw stamps: lower_of ranks tiers, and
            # handing it source_type strings collapses every one of them to
            # third_party — which would also block a legitimate demotion.
            prior_st, new_st = existing.get("source_type"), fm.get("source_type")
            if prior_st and new_st and prior_st != new_st:
                new_tier = provenance.tier(new_st)
                if provenance.lower_of(provenance.tier(prior_st),
                                       new_tier) != new_tier:
                    fm["source_type"] = prior_st
        else:
            subdir = TYPE_DIRS.get(concept_type, "topics")
            path = self.base_dir / subdir / f"{_slugify(title)}.md"
            if path.exists() and not replace:
                # A create whose slug is already taken used to write straight
                # over the other note — body gone, maintained_by/about gone,
                # and memory.write still answered {"status": "written"}. The
                # caller decides now: append to it, pin an item_id to replace
                # it deliberately, or pick a different title.
                raise FileExistsError(str(path.relative_to(self.base_dir)))
        path.write_text(f"{self.render_frontmatter(fm)}\n\n{content}\n")
        log.info("Memory write: %s", path)
        return str(path.relative_to(self.base_dir.resolve() if path.is_absolute()
                                    else self.base_dir))

    def append_concept(self, doc_id: str, content: str,
                       prepend: bool = False, world_read: bool = False) -> str:
        """Add content to an existing concept file, preserving its body and
        frontmatter (timestamp bumped). The mechanical half of running
        logs/digests: the caller sends ONLY the delta, so generation cost
        stays constant no matter how large the document grows. prepend=True
        puts the delta at the TOP of the body instead — for latest-first
        documents like news digests."""
        base = self.base_dir.resolve()
        path = (self.base_dir / doc_id).resolve()
        if not (path.is_relative_to(base) and path.suffix == ".md"
                and path.is_file()):
            raise FileNotFoundError(f"memory item '{doc_id}' not found")
        fm, body = self.parse_frontmatter(path.read_text())
        fm["timestamp"] = datetime.now(timezone.utc).isoformat()
        # ORIGIN IS MONOTONE: an append may lower a document's trust, never
        # raise it. This method preserves the target's frontmatter, so
        # without this an agent holding fetched web content could append into
        # a first-party note and have the delta inherit its stamp —
        # laundering, in a single call, using a feature built for digests.
        if world_read:
            fm["world_read"] = True
        new_body = (f"{content.strip()}\n\n{body}" if prepend
                    else f"{body}\n\n{content.strip()}")
        path.write_text(f"{self.render_frontmatter(fm)}\n\n{new_body}\n")
        log.info("Memory %s: %s", "prepend" if prepend else "append", path)
        return str(path.relative_to(base))

    def append_journal(self, date: str, content: str) -> str:
        """Append a dated entry to the day's journal. Returns the doc id."""
        path = self.base_dir / TYPE_DIRS["journal"] / f"{date}.md"
        # Header stamps are read by the operator — local wall-clock time, not
        # UTC (a 10:44 AM chat was landing as "## 14:44", 2026-07-17).
        stamp = timefmt.fmt_clock(timefmt.now_local())
        entry = f"## {stamp}\n\n{content.strip()}\n"
        if not path.exists():
            fm = self.render_frontmatter({
                "type": "journal", "title": f"Journal {date}", "date": date,
                # A journal is a TRANSCRIPT: it can quote a page the model
                # just read, and it can quote Nova's own mistaken claims
                # back to her a day later. Stamped so the index does not
                # have to infer it, and so journals written before this
                # still land as untrusted by the fail-closed default.
                "source_type": "conversation",
            })
            path.write_text(f"{fm}\n\n{entry}")
        else:
            with path.open("a") as f:
                f.write(f"\n{entry}")
        return str(path.relative_to(self.base_dir))

    # ── journal entries: reading and forgetting one (roadmap #22) ────────
    #
    # A journal is one file per day grown by raw append, so an entry has no
    # storage object of its own and no id. These two methods are the first
    # and only parser of that shape, and they exist because "forget that
    # document" was false: a turn where Nova quoted a payslip was permanent,
    # retrieved into later prompts, and removable only by destroying the
    # whole day.
    #
    # ADDRESSING IS BY CONTENT HASH, never by the `## <stamp>` heading.
    # Measured on the live corpus: 2026-08-01 has 42 headings and 14 distinct
    # ones, 2026-07-17 has 90 and 48. A stamp identifies between one and
    # eight entries, so a deletion keyed on it would silently take unrelated
    # turns with it. The hash also survives the operator flipping
    # `nova.time_format`, which has already changed the heading format on
    # disk twice (files before 2026-07-18 use 24h, later ones 12h, and
    # 2026-07-13 has no heading at all).

    _ENTRY_RE = re.compile(r"^## (.+?)$", re.M)

    def _journal_path(self, doc_id: str) -> Optional[Path]:
        """A journal path, or None. Same traversal guard as read_file — ids
        arrive from the API — plus a hard restriction to journals/, so this
        splicing path can never be aimed at a topic, a skill or soul.md."""
        path = (self.base_dir / doc_id).resolve()
        journals = (self.base_dir / TYPE_DIRS["journal"]).resolve()
        if (not path.is_relative_to(journals) or path.suffix != ".md"
                or not path.is_file()):
            return None
        return path

    def journal_entries(self, doc_id: str) -> list[dict]:
        """Every entry in a journal, with a stable content address.

        The `ordinal` is positional and only meaningful against the file as
        it is RIGHT NOW; `sha256` is what a caller should hold on to.
        """
        path = self._journal_path(doc_id)
        if not path:
            return []
        fm, body = self.parse_frontmatter(path.read_text())
        out = []
        marks = list(self._ENTRY_RE.finditer(body))
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(body)
            text = body[m.start():end].rstrip()
            out.append({
                "ordinal": i,
                "stamp": m.group(1).strip(),
                "text": text,
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
            })
        # A file whose first block predates the heading convention (2026-07-13)
        # has body text before any `## ` — surface it rather than pretending
        # the file starts at the first heading, or it can never be forgotten.
        head = body[:marks[0].start()].strip() if marks else body.strip()
        if head:
            out.insert(0, {"ordinal": -1, "stamp": "(no heading)", "text": head,
                           "sha256": hashlib.sha256(head.encode()).hexdigest()})
        return out

    def excise_journal_entry(self, doc_id: str, sha256: str,
                             tombstone: str) -> Optional[dict]:
        """Remove ONE entry from a journal, leaving a tombstone in its place.

        Returns the removed entry, or None if no entry has that hash — which
        is also what happens when the operator is acting on a stale view,
        and is why the caller must treat None as "nothing was removed"
        rather than as success.

        A tombstone rather than a silent splice: a hole in a transcript is
        its own kind of lie, and an operator scrolling last Tuesday should
        be able to see that something was taken out and when.
        """
        path = self._journal_path(doc_id)
        if not path:
            return None
        raw = path.read_text()
        fm, body = self.parse_frontmatter(raw)
        for entry in self.journal_entries(doc_id):
            if entry["sha256"] != sha256:
                continue
            replacement = f"## {entry['stamp']}\n\n> {tombstone}\n"
            new_body = body.replace(entry["text"], replacement.rstrip(), 1)
            if new_body == body:                     # nothing matched; refuse
                return None
            tmp = path.with_suffix(".part")
            tmp.write_text(f"{self.render_frontmatter(fm)}\n\n{new_body.strip()}\n")
            os.replace(tmp, path)                    # atomic: never a half file
            return entry
        return None

    # ── reads ────────────────────────────────────────────────────────────

    def read_file(self, doc_id: str) -> Optional[tuple[dict, str]]:
        # doc_ids come from LLM tool calls and API paths — refuse traversal.
        path = (self.base_dir / doc_id).resolve()
        if (not path.is_relative_to(self.base_dir.resolve())
                or path.suffix != ".md" or not path.is_file()):
            return None
        return self.parse_frontmatter(path.read_text())

    def delete_file(self, doc_id: str) -> bool:
        # same traversal guard as read_file — ids arrive from the API
        path = (self.base_dir / doc_id).resolve()
        if (not path.is_relative_to(self.base_dir.resolve())
                or path.suffix != ".md" or not path.is_file()):
            return False
        path.unlink()
        return True

    def unlink_references(self, title: str) -> list[tuple[str, float]]:
        """Rewrite [[wiki-links]] pointing at `title` into plain text in every
        file. Called after a delete so no surviving memory links to a document
        that no longer exists.

        One line, because deleting a note and retitling one are the same
        rewrite aimed at different outcomes, and two implementations of it
        would eventually disagree about what counts as the same title. The
        matcher, the mtime preservation and the reason for it now live in
        app.memory.links; the (doc_id, mtime) shape is kept so delete_item is
        untouched.
        """
        from app.memory import links
        return [(doc_id, mtime)
                for doc_id, mtime, _n, ok in links.apply(self, title, None) if ok]

    def normalize_source_transcript(self, doc_id: str, tags: list[str],
                                    link_title: str) -> Optional[float]:
        """Repair an already-ingested followed-source transcript so it clusters
        by its SOURCE only: set its frontmatter tags to the canonical source-only
        set `tags` (dropping the fuzzy topical tags the write-time link pass added
        before source clustering became authoritative), append a
        `Source: [[link_title]]` link to the body, and strip any fuzzy
        `Related:` cross-link line. The file mtime is PRESERVED (mirrors
        unlink_references) — a repair re-tag is not new knowledge and must not
        trip recency cues (fresh flares, planet sizing). Returns the (unchanged)
        mtime when it wrote, else None (already normalized or not found)."""
        base = self.base_dir.resolve()
        path = (self.base_dir / doc_id).resolve()
        if not (path.is_relative_to(base) and path.suffix == ".md"
                and path.is_file()):
            return None
        fm, body = self.parse_frontmatter(path.read_text())
        changed = False
        if self.extract_tags(fm) != tags:
            fm["tags"] = list(tags)
            changed = True
        kept = [ln for ln in body.split("\n")
                if not ln.strip().lower().startswith("related:")]
        if len(kept) != body.split("\n").__len__():
            body = "\n".join(kept).rstrip()
            changed = True
        if f"[[{link_title}]]".lower() not in body.lower():
            body = f"{body}\n\nSource: [[{link_title}]]"
            changed = True
        if not changed:
            return None
        stat = path.stat()
        path.write_text(f"{self.render_frontmatter(fm)}\n\n{body}\n")
        os.utime(path, (stat.st_atime, stat.st_mtime))
        log.info("Memory source-anchor: normalized %s -> %s", doc_id, tags)
        return stat.st_mtime

    def iter_files(self) -> list[tuple[str, float]]:
        """All markdown files as (doc_id, mtime)."""
        out = []
        for subdir in TYPE_DIRS.values():
            for p in (self.base_dir / subdir).glob("*.md"):
                out.append((str(p.relative_to(self.base_dir)), p.stat().st_mtime))
        return sorted(out)

    def get_stats(self) -> dict:
        counts = {t: len(list((self.base_dir / d).glob("*.md")))
                  for t, d in TYPE_DIRS.items()}
        counts["total_items"] = sum(counts.values())
        return counts

    # ── graph extraction (Phase E) ───────────────────────────────────────

    @staticmethod
    def extract_links(body: str) -> list[str]:
        return _WIKILINK_RE.findall(body)

    @staticmethod
    def extract_tags(fm: dict) -> list[str]:
        raw = fm.get("tags", "")
        if not raw:
            return []
        return [t.strip() for t in raw.strip("[]").split(",") if t.strip()]
