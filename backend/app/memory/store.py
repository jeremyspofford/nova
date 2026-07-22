"""OKF-style markdown file store. Every memory item is a real file on disk."""

import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from app import timefmt

log = logging.getLogger(__name__)

TYPE_DIRS = {"topic": "topics", "skill": "skills", "journal": "journals", "source": "sources"}

_WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")


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
                      doc_id: Optional[str] = None) -> str:
        """Write (or overwrite) a concept file. Returns the doc id (relative path).

        doc_id pins the write to an existing file (in-place update even when the
        title differs) — it must resolve inside the memory dir and already exist.
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
            path = pinned
            # In-place updates preserve frontmatter keys the caller doesn't
            # set: data-level markers (maintained_by, about, hand-added keys)
            # must survive a REFRESH, not just an append.
            existing, _body = self.parse_frontmatter(path.read_text())
            fm = {**existing, **fm}
        else:
            subdir = TYPE_DIRS.get(concept_type, "topics")
            path = self.base_dir / subdir / f"{_slugify(title)}.md"
        path.write_text(f"{self.render_frontmatter(fm)}\n\n{content}\n")
        log.info("Memory write: %s", path)
        return str(path.relative_to(self.base_dir.resolve() if path.is_absolute()
                                    else self.base_dir))

    def append_concept(self, doc_id: str, content: str,
                       prepend: bool = False) -> str:
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
            })
            path.write_text(f"{fm}\n\n{entry}")
        else:
            with path.open("a") as f:
                f.write(f"\n{entry}")
        return str(path.relative_to(self.base_dir))

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
        that no longer exists. Matching mirrors graph resolution (title,
        case-insensitive). File mtimes are preserved — a mechanical unlink is
        not new knowledge and must not trip recency cues (fresh flares,
        planet sizing). Returns (doc_id, mtime) for each changed file."""
        target = title.lower().strip()
        changed: list[tuple[str, float]] = []
        for doc_id, _mtime in self.iter_files():
            path = self.base_dir / doc_id
            text = path.read_text()
            new = _WIKILINK_RE.sub(
                lambda m: m.group(1) if m.group(1).lower().strip() == target
                else m.group(0),
                text)
            if new == text:
                continue
            stat = path.stat()
            path.write_text(new)
            os.utime(path, (stat.st_atime, stat.st_mtime))
            changed.append((doc_id, stat.st_mtime))
            log.info("Memory unlink: removed [[%s]] from %s", title, doc_id)
        return changed

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
