"""OKF markdown file store for memory."""

import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)


class OkfStore:
    """Manages OKF markdown files in a directory."""

    def __init__(self, base_dir: str):
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

        # Create type directories
        self.topics_dir = self.base_dir / "topics"
        self.skills_dir = self.base_dir / "skills"
        self.journals_dir = self.base_dir / "journals"
        self.sources_dir = self.base_dir / "sources"

        for d in [self.topics_dir, self.skills_dir, self.journals_dir, self.sources_dir]:
            d.mkdir(exist_ok=True)

    def _parse_frontmatter(self, content: str) -> tuple[dict, str]:
        """Parse YAML-like frontmatter from markdown."""
        if not content.startswith("---"):
            return {}, content

        match = re.match(r"^---\n(.*?)\n---\n(.*)", content, re.DOTALL)
        if not match:
            return {}, content

        fm_text, body = match.groups()
        frontmatter = {}

        for line in fm_text.split("\n"):
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            frontmatter[key.strip()] = value.strip().strip('"\'')

        return frontmatter, body.strip()

    def _render_frontmatter(self, fm: dict) -> str:
        """Render frontmatter to YAML-like format."""
        lines = ["---"]
        for key, value in fm.items():
            if isinstance(value, bool):
                value = str(value).lower()
            lines.append(f"{key}: {value}")
        lines.append("---")
        return "\n".join(lines)

    def write_concept(self, title: str, content: str, concept_type: str = "topic", metadata: Optional[dict] = None) -> str:
        """Write a concept file (topic, skill, etc.)."""
        metadata = metadata or {}
        metadata.setdefault("type", concept_type)
        metadata.setdefault("title", title)
        metadata.setdefault("timestamp", datetime.utcnow().isoformat())

        # Determine directory based on type
        if concept_type == "skill":
            target_dir = self.skills_dir
        elif concept_type == "journal":
            target_dir = self.journals_dir
        else:
            target_dir = self.topics_dir

        # Slugify title for filename
        slug = re.sub(r"[^\w\s-]", "", title.lower()).replace(" ", "-")
        filepath = target_dir / f"{slug}.md"

        # Render file content
        fm = self._render_frontmatter(metadata)
        file_content = f"{fm}\n\n{content}"

        filepath.write_text(file_content)
        log.info(f"Wrote concept: {filepath}")
        return str(filepath.relative_to(self.base_dir))

    def append_journal(self, date: str, content: str) -> str:
        """Append to a journal file for a specific date."""
        filepath = self.journals_dir / f"{date}.md"

        # Initialize if doesn't exist
        if not filepath.exists():
            fm = self._render_frontmatter({"type": "journal", "date": date, "timestamp": datetime.utcnow().isoformat()})
            filepath.write_text(f"{fm}\n\n{content}")
        else:
            current = filepath.read_text()
            filepath.write_text(f"{current}\n\n{content}")

        log.info(f"Appended to journal: {filepath}")
        return str(filepath.relative_to(self.base_dir))

    def read_file(self, rel_path: str) -> Optional[tuple[dict, str]]:
        """Read a file and parse frontmatter."""
        filepath = self.base_dir / rel_path
        if not filepath.exists():
            return None
        content = filepath.read_text()
        return self._parse_frontmatter(content)

    def list_files(self, concept_type: Optional[str] = None) -> list[str]:
        """List all concept files, optionally filtered by type."""
        if concept_type == "skill":
            source_dir = self.skills_dir
        elif concept_type == "journal":
            source_dir = self.journals_dir
        elif concept_type == "topic":
            source_dir = self.topics_dir
        else:
            # List all
            files = []
            for d in [self.topics_dir, self.skills_dir, self.journals_dir]:
                files.extend([str(f.relative_to(self.base_dir)) for f in d.glob("*.md")])
            return sorted(files)

        return sorted([str(f.relative_to(self.base_dir)) for f in source_dir.glob("*.md")])

    def get_stats(self) -> dict:
        """Get statistics about stored content."""
        topics = list(self.topics_dir.glob("*.md"))
        skills = list(self.skills_dir.glob("*.md"))
        journals = list(self.journals_dir.glob("*.md"))

        return {
            "total_items": len(topics) + len(skills) + len(journals),
            "topics": len(topics),
            "skills": len(skills),
            "journals": len(journals),
        }
