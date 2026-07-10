"""
OKF bundle store — file I/O, frontmatter, index.md/log.md maintenance.

All writes go through this module so the bundle stays OKF-conformant:
every concept file carries parseable YAML frontmatter with a non-empty
`type`, unknown frontmatter keys survive round-trips, and the reserved
index.md / log.md files follow the spec's structure.

Humans and agents may also edit files directly with any editor/file tool;
the BM25 index self-heals on mtime drift (see index.py), so direct edits
are a supported path, not an error.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

import yaml

log = logging.getLogger(__name__)

# One lock per store instance serializes writes (index.md/log.md contention).
# Reads are lock-free.

RESERVED_FILENAMES = {"index.md", "log.md"}

# `type` frontmatter → bundle directory. Unknown types land in topics/.
TYPE_DIRS = {
    "person": "people",
    "people": "people",
    "project": "projects",
    "preference": "preferences",
    "source": "sources",
    "journal": "journal",
    "reflection": "reflections",
    "self": "self",
}
DEFAULT_DIR = "topics"

# Seeded once by ensure_bundle: the identity anchor the Brain graph grows from.
# Nova (and the operator) edit it like any concept file; curation links back to
# it as concepts mature.
SOUL_TEMPLATE = """\
---
type: self
title: Soul
description: Who Nova is — identity, values, operating principles. The graph grows from here.
timestamp: '{ts}'
nova_source_kind: system
nova_trust: 1.0
---

# Soul

I am Nova — a self-directed agent running on this machine. This file anchors my
identity inside my own memory; the brain graph grows outward from it.

## Values

- Be genuinely useful to my operator; earn trust with receipts.
- Prefer durable knowledge over noise — distill, link, prune.
- Act within my rails: consent gates, budgets, reversibility.

## Operating principles

- When I learn something durable, I write it down and LINK it.
- Concepts that shape how I act should link back to this file.
"""

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(text: str, max_len: int = 60) -> str:
    slug = _SLUG_RE.sub("-", text.lower()).strip("-")
    return slug[:max_len].rstrip("-") or "untitled"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── Frontmatter ──────────────────────────────────────────────────────────────


def parse_document(text: str) -> tuple[dict, str]:
    """Split a concept document into (frontmatter dict, body).

    Tolerant per OKF consumer obligations: missing/broken frontmatter
    yields an empty dict rather than an error.
    """
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    raw = text[3:end]
    body = text[end + 4 :].lstrip("\n")
    try:
        fm = yaml.safe_load(raw)
        if not isinstance(fm, dict):
            return {}, text
        return fm, body
    except yaml.YAMLError:
        return {}, text


def serialize_document(frontmatter: dict, body: str) -> str:
    """Re-assemble a concept document, preserving all frontmatter keys."""
    fm = yaml.safe_dump(
        frontmatter, sort_keys=False, allow_unicode=True, default_flow_style=False
    ).strip()
    return f"---\n{fm}\n---\n\n{body.strip()}\n"


# ── Link extraction (untyped directed edges per OKF) ─────────────────────────

_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)\s]+)\)")


def extract_links(body: str) -> list[str]:
    """Bundle-internal .md links from a document body.

    Absolute links (leading /) are bundle-root-relative; relative links
    are returned as-is for the caller to resolve against the source file.
    External URLs are skipped.
    """
    out = []
    for _label, target in _LINK_RE.findall(body):
        if target.startswith(("http://", "https://", "mailto:")):
            continue
        target = target.split("#", 1)[0]
        if target.endswith(".md"):
            out.append(target)
    return out


class OkfStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.nova_dir = self.root / ".nova"
        self._lock = asyncio.Lock()

    # ── Bootstrap ────────────────────────────────────────────────────────

    def ensure_bundle(self) -> None:
        """Create the bundle skeleton if missing (idempotent)."""
        self.root.mkdir(parents=True, exist_ok=True)
        self.nova_dir.mkdir(exist_ok=True)
        root_index = self.root / "index.md"
        if not root_index.exists():
            root_index.write_text(
                "---\nokf_version: \"0.1\"\n---\n\n# Nova Memory\n\n"
                "Nova's long-term memory as an OKF markdown bundle. "
                "Concept files carry YAML frontmatter; links between files "
                "are the knowledge graph.\n",
                encoding="utf-8",
            )
        log_file = self.root / "log.md"
        if not log_file.exists():
            log_file.write_text("# Change Log\n", encoding="utf-8")
        soul = self.root / "self" / "soul.md"
        if not soul.exists():
            soul.parent.mkdir(exist_ok=True)
            soul.write_text(SOUL_TEMPLATE.format(ts=_iso()), encoding="utf-8")
            self._regenerate_indices(soul.parent)

    # ── Path helpers ─────────────────────────────────────────────────────

    def rel(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()

    def abs(self, memory_id: str) -> Path:
        """Resolve a bundle-relative memory id to an absolute path, refusing
        traversal outside the bundle."""
        p = (self.root / memory_id.lstrip("/")).resolve()
        if not p.is_relative_to(self.root.resolve()):
            raise ValueError(f"memory id escapes bundle: {memory_id}")
        return p

    def dir_for_type(self, type_: str) -> Path:
        return self.root / TYPE_DIRS.get(type_.lower().strip(), DEFAULT_DIR)

    def concept_files(self) -> list[Path]:
        """All concept documents: every .md except reserved index/log files
        and the .nova dir."""
        out = []
        for p in sorted(self.root.rglob("*.md")):
            if p.name in RESERVED_FILENAMES:
                continue
            if ".nova" in p.parts:
                continue
            out.append(p)
        return out

    # ── Reads ────────────────────────────────────────────────────────────

    def read(self, memory_id: str) -> tuple[dict, str] | None:
        p = self.abs(memory_id)
        if not p.exists() or not p.is_file():
            return None
        return parse_document(p.read_text(encoding="utf-8", errors="replace"))

    def root_index_body(self, max_chars: int = 6000) -> str:
        p = self.root / "index.md"
        if not p.exists():
            return ""
        _fm, body = parse_document(p.read_text(encoding="utf-8", errors="replace"))
        return body[:max_chars]

    def resolve_link(self, from_id: str, target: str) -> str | None:
        """Resolve an OKF link (absolute-from-root or relative) to a
        bundle-relative id; None for broken links (tolerated per spec)."""
        try:
            if target.startswith("/"):
                p = self.abs(target)
            else:
                p = (self.abs(from_id).parent / target).resolve()
                if not p.is_relative_to(self.root.resolve()):
                    return None
        except ValueError:
            return None
        return self.rel(p) if p.exists() else None

    # ── Writes ───────────────────────────────────────────────────────────

    async def write_concept(
        self,
        *,
        type_: str,
        title: str,
        body: str,
        description: str = "",
        tags: list[str] | None = None,
        resource: str | None = None,
        extra_frontmatter: dict | None = None,
        target: str | None = None,
    ) -> tuple[str, bool]:
        """Create a concept file, or append to an existing one.

        Returns (memory_id, created). `target` forces a specific
        bundle-relative path (used by revise/append flows).
        """
        async with self._lock:
            if target:
                path = self.abs(target)
            else:
                path = self.dir_for_type(type_) / f"{slugify(title)}.md"

            created = not path.exists()
            path.parent.mkdir(parents=True, exist_ok=True)

            if created:
                fm: dict = {"type": type_ or "note", "title": title}
                if description:
                    fm["description"] = description
                if tags:
                    fm["tags"] = list(tags)
                if resource:
                    fm["resource"] = resource
                fm["timestamp"] = _iso()
                for k, v in (extra_frontmatter or {}).items():
                    if v is not None:
                        fm[k] = v
                path.write_text(serialize_document(fm, body), encoding="utf-8")
            else:
                fm, existing_body = parse_document(
                    path.read_text(encoding="utf-8", errors="replace")
                )
                stamp = _now().strftime("%Y-%m-%d")
                new_body = f"{existing_body.rstrip()}\n\n## Update {stamp}\n\n{body.strip()}\n"
                fm["timestamp"] = _iso()  # last meaningful change per spec
                if tags:
                    fm["tags"] = sorted(set(fm.get("tags") or []) | set(tags))
                fm.setdefault("type", type_ or "note")
                path.write_text(serialize_document(fm, new_body), encoding="utf-8")

            memory_id = self.rel(path)
            self._append_log(
                f"**{'Creation' if created else 'Update'}** [{fm.get('title', title)}](/{memory_id})"
                + (f" - {description}" if description and created else "")
            )
            self._regenerate_indices(path.parent)
            return memory_id, created

    async def append_journal(
        self,
        text: str,
        *,
        source_kind: str,
        occurred_at: datetime | None = None,
        extra_frontmatter: dict | None = None,
    ) -> str:
        """Append a digest entry to today's journal file (the high-volume
        inbox — curated into topics/ by the nightly curation goal)."""
        async with self._lock:
            ts = occurred_at or _now()
            day = ts.strftime("%Y-%m-%d")
            path = self.root / "journal" / f"{day}.md"
            path.parent.mkdir(parents=True, exist_ok=True)

            if not path.exists():
                fm = {
                    "type": "journal",
                    "title": f"Journal {day}",
                    "description": "Raw memory inbox — distilled nightly into topic files",
                    "timestamp": _iso(ts),
                }
                for k, v in (extra_frontmatter or {}).items():
                    if v is not None:
                        fm[k] = v
                path.write_text(serialize_document(fm, f"# Journal {day}\n"), encoding="utf-8")
                self._regenerate_indices(path.parent)

            entry = f"\n## {ts.strftime('%H:%M')} — {source_kind}\n\n{text.strip()}\n"
            with path.open("a", encoding="utf-8") as f:
                f.write(entry)

            # Journal files churn constantly; update timestamp in place.
            fm, body = parse_document(path.read_text(encoding="utf-8", errors="replace"))
            fm["timestamp"] = _iso(ts)
            path.write_text(serialize_document(fm, body), encoding="utf-8")
            return self.rel(path)

    async def update_file(self, memory_id: str, frontmatter: dict, body: str) -> bool:
        """Replace a concept file's frontmatter + body in place (edit flow).

        Reserved files are refused. The file must already exist — creation
        goes through write_concept so type→directory routing stays in one
        place. Returns False if the file doesn't exist.
        """
        async with self._lock:
            path = self.abs(memory_id)
            rel = self.rel(path)
            if rel in ("index.md", "log.md"):
                raise ValueError(f"{rel} is a reserved bundle file")
            if not path.exists() or not path.is_file():
                return False
            path.write_text(serialize_document(frontmatter, body), encoding="utf-8")
            self._append_log(f"**Edit** [{frontmatter.get('title', rel)}](/{rel})")
            self._regenerate_indices(path.parent)
            return True

    async def delete_file(self, memory_id: str) -> bool:
        """Delete a bundle file by its bundle-relative id.

        Reserved files (index.md, log.md) are refused; abs() already refuses
        paths outside the bundle. Returns False if the file doesn't exist.
        """
        async with self._lock:
            path = self.abs(memory_id)
            rel = self.rel(path)
            if rel in ("index.md", "log.md"):
                raise ValueError(f"{rel} is a reserved bundle file")
            if not path.exists() or not path.is_file():
                return False
            fm, _body = parse_document(
                path.read_text(encoding="utf-8", errors="replace")
            )
            path.unlink()
            self._append_log(f"**Deletion** {fm.get('title', rel)} (/{rel})")
            self._regenerate_indices(path.parent)
            return True

    # ── Reserved files (index.md / log.md) ───────────────────────────────

    def _append_log(self, line: str) -> None:
        """Prepend an entry under today's ISO date heading (newest first)."""
        log_path = self.root / "log.md"
        today = _now().strftime("%Y-%m-%d")
        content = log_path.read_text(encoding="utf-8") if log_path.exists() else "# Change Log\n"

        heading = f"## {today}"
        if heading in content:
            content = content.replace(f"{heading}\n", f"{heading}\n\n* {line}\n", 1)
        else:
            # Insert new date section right after the H1 (newest first)
            lines = content.split("\n")
            insert_at = 1
            for i, ln in enumerate(lines):
                if ln.startswith("## "):
                    insert_at = i
                    break
                if ln.startswith("# "):
                    insert_at = i + 1
            lines[insert_at:insert_at] = ["", heading, "", f"* {line}"]
            content = "\n".join(lines)
        log_path.write_text(content, encoding="utf-8")

    def _index_entry(self, path: Path) -> str | None:
        try:
            fm, _ = parse_document(path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            return None
        title = fm.get("title") or path.stem
        desc = fm.get("description") or ""
        rel = "/" + self.rel(path)
        return f"* [{title}]({rel})" + (f" - {desc}" if desc else "")

    def _regenerate_indices(self, changed_dir: Path) -> None:
        """Rewrite the per-directory index.md and the root index.md.

        Root index groups by directory, caps entries per section, and stays
        under ~200 lines (it is always injected into context).
        """
        # Per-directory index (skip root — handled below with grouping)
        if changed_dir != self.root:
            entries = [
                e for p in sorted(changed_dir.glob("*.md"))
                if p.name not in RESERVED_FILENAMES and (e := self._index_entry(p))
            ]
            (changed_dir / "index.md").write_text(
                f"# {changed_dir.name.title()}\n\n" + "\n".join(entries) + "\n",
                encoding="utf-8",
            )

        # Root index — sections per directory, newest-timestamp first, capped.
        sections: list[str] = []
        per_section_cap = 15
        for d in sorted(p for p in self.root.iterdir() if p.is_dir() and p.name != ".nova"):
            files = [p for p in sorted(d.glob("*.md")) if p.name not in RESERVED_FILENAMES]
            if not files:
                continue

            def _ts(p: Path) -> str:
                fm, _ = parse_document(p.read_text(encoding="utf-8", errors="replace"))
                return str(fm.get("timestamp") or "")

            files.sort(key=_ts, reverse=True)
            shown = [e for p in files[:per_section_cap] if (e := self._index_entry(p))]
            more = len(files) - per_section_cap
            section = f"## {d.name.title()}\n\n" + "\n".join(shown)
            if more > 0:
                section += f"\n* … {more} more in [/{d.name}/index.md](/{d.name}/index.md)"
            sections.append(section)

        root_body = (
            "# Nova Memory\n\n"
            "Nova's long-term memory. Concept files carry YAML frontmatter; "
            "links between files are the knowledge graph. Use memory tools "
            "(search_memory, recall_topic, remember) for detail.\n\n"
            + "\n\n".join(sections)
            + "\n"
        )
        (self.root / "index.md").write_text(
            '---\nokf_version: "0.1"\n---\n\n' + root_body, encoding="utf-8"
        )
