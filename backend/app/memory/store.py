"""OKF-style markdown file store. Every memory item is a real file on disk."""

import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

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
        else:
            subdir = TYPE_DIRS.get(concept_type, "topics")
            path = self.base_dir / subdir / f"{_slugify(title)}.md"
        path.write_text(f"{self.render_frontmatter(fm)}\n\n{content}\n")
        log.info("Memory write: %s", path)
        return str(path.relative_to(self.base_dir.resolve() if path.is_absolute()
                                    else self.base_dir))

    def append_journal(self, date: str, content: str) -> str:
        """Append a dated entry to the day's journal. Returns the doc id."""
        path = self.base_dir / TYPE_DIRS["journal"] / f"{date}.md"
        stamp = datetime.now(timezone.utc).strftime("%H:%M")
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
