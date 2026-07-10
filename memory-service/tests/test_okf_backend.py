"""Unit tests for the OKF markdown backend — no services required.

Covers OKF v0.1 conformance obligations:
- every concept file has parseable frontmatter with non-empty `type`
- unknown frontmatter keys survive round-trips
- broken links are tolerated
- reserved index.md / log.md follow the spec structure
plus backend behavior: journal routing, concept writes, BM25 retrieval,
feedback, provenance, and index self-heal after direct file edits.

Run: pytest memory-service/tests/test_okf_backend.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

# Settings reads .env / env vars — make the bundle root a temp dir per test
# via the OkfBackend(root=...) constructor arg instead.
os.environ.setdefault("NOVA_ADMIN_SECRET", "test-secret")

from app.backends.okf.backend import OkfBackend  # noqa: E402
from app.backends.okf.store import (  # noqa: E402
    extract_links,
    parse_document,
    serialize_document,
    slugify,
)


@pytest.fixture()
def backend(tmp_path: Path) -> OkfBackend:
    return OkfBackend(root=tmp_path / "memory")


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(scope="session", autouse=True)
def _event_loop_policy():
    asyncio.set_event_loop(asyncio.new_event_loop())


# ── OKF conformance ──────────────────────────────────────────────────────────


class TestOkfConformance:
    def test_bundle_skeleton(self, backend: OkfBackend):
        root = backend.store.root
        assert (root / "index.md").exists()
        assert (root / "log.md").exists()
        fm, _ = parse_document((root / "index.md").read_text())
        assert fm.get("okf_version") == "0.1"

    def test_concept_files_have_type_frontmatter(self, backend: OkfBackend):
        run(backend.write("Jeremy prefers teal.", source_type="chat",
                          metadata={"okf": {"type": "preference", "title": "Color preference"}}))
        run(backend.write("raw chat line", source_type="chat"))
        for p in backend.store.concept_files():
            fm, _ = parse_document(p.read_text())
            assert fm.get("type"), f"{p} missing type frontmatter"

    def test_unknown_frontmatter_survives_roundtrip(self):
        doc = serialize_document(
            {"type": "note", "title": "T", "x_custom_field": {"a": 1}}, "body"
        )
        fm, body = parse_document(doc)
        assert fm["x_custom_field"] == {"a": 1}
        doc2 = serialize_document(fm, body)
        fm2, _ = parse_document(doc2)
        assert fm2["x_custom_field"] == {"a": 1}

    def test_broken_links_tolerated(self, backend: OkfBackend):
        run(backend.write(
            "See [missing](/topics/nonexistent.md) and [web](https://x.com).",
            source_type="chat",
            metadata={"okf": {"type": "note", "title": "Linky"}},
        ))
        links = extract_links("[missing](/topics/nonexistent.md)")
        assert links == ["/topics/nonexistent.md"]
        resolved = backend.store.resolve_link("topics/linky.md", "/topics/nonexistent.md")
        assert resolved is None  # broken → None, not an exception

    def test_index_md_entry_format(self, backend: OkfBackend):
        run(backend.write("body", source_type="chat",
                          metadata={"okf": {"type": "note", "title": "My Note",
                                            "description": "a note"}}))
        idx = (backend.store.root / "topics" / "index.md").read_text()
        assert "* [My Note](/topics/my-note.md) - a note" in idx

    def test_log_md_newest_first(self, backend: OkfBackend):
        run(backend.write("b1", source_type="chat",
                          metadata={"okf": {"type": "note", "title": "First"}}))
        run(backend.write("b2", source_type="chat",
                          metadata={"okf": {"type": "note", "title": "Second"}}))
        content = (backend.store.root / "log.md").read_text()
        assert content.index("Second") < content.index("First")


# ── Backend behavior ─────────────────────────────────────────────────────────


class TestWriteRouting:
    def test_untitled_writes_go_to_journal(self, backend: OkfBackend):
        result = run(backend.write("User asked about GPU setup.", source_type="chat"))
        assert result.item_ids[0].startswith("journal/")
        content = backend.store.read(result.item_ids[0])
        assert content is not None
        fm, body = content
        assert fm["type"] == "journal"
        assert "— chat" in body or "chat" in body

    def test_typed_writes_create_concepts(self, backend: OkfBackend):
        result = run(backend.write(
            "Nova runs as a docker compose stack.",
            source_type="tool",
            metadata={"okf": {"type": "project", "title": "Nova Architecture",
                              "tags": ["nova", "docker"]}},
        ))
        assert result.items_created == 1
        assert result.item_ids == ["projects/nova-architecture.md"]

    def test_second_write_same_title_appends(self, backend: OkfBackend):
        meta = {"okf": {"type": "note", "title": "Same Topic"}}
        run(backend.write("first", source_type="chat", metadata=meta))
        result = run(backend.write("second", source_type="chat", metadata=meta))
        assert result.items_updated == 1
        _fm, body = backend.store.read("topics/same-topic.md")
        assert "first" in body and "second" in body and "## Update" in body

    def test_trust_defaults(self, backend: OkfBackend):
        run(backend.write("x", source_type="intel",
                          metadata={"okf": {"type": "note", "title": "Trusty"}}))
        fm, _ = backend.store.read("topics/trusty.md")
        assert fm["nova_trust"] == 0.7


class TestRetrieval:
    def test_context_finds_relevant_file(self, backend: OkfBackend):
        run(backend.write(
            "Jeremy's GPU is an RTX 4090 with 24GB VRAM, used for local inference.",
            source_type="chat",
            metadata={"okf": {"type": "note", "title": "GPU Setup"}},
        ))
        run(backend.write(
            "The dashboard uses Tailwind with a stone/teal palette.",
            source_type="chat",
            metadata={"okf": {"type": "note", "title": "Design System"}},
        ))
        ctx = run(backend.context("what gpu does jeremy have for inference"))
        assert "topics/gpu-setup.md" in ctx.memory_ids
        assert "RTX 4090" in ctx.context
        assert ctx.retrieval_log_id

    def test_context_includes_root_index(self, backend: OkfBackend):
        run(backend.write("body", source_type="chat",
                          metadata={"okf": {"type": "note", "title": "Anything"}}))
        ctx = run(backend.context("anything"))
        assert "Memory Index" in ctx.context

    def test_empty_bundle_context(self, backend: OkfBackend):
        ctx = run(backend.context("whatever"))
        assert ctx.memory_ids == []

    def test_feedback_boosts_ranking(self, backend: OkfBackend):
        for i in range(2):
            run(backend.write(
                f"Note about docker networking variant {i}.",
                source_type="chat",
                metadata={"okf": {"type": "note", "title": f"Docker Net {i}"}},
            ))
        before = run(backend.context("docker networking"))
        loser = before.memory_ids[-1]
        for _ in range(5):
            run(backend.feedback(loser, 1.0))
        after = run(backend.context("docker networking"))
        assert after.memory_ids[0] == loser

    def test_mark_used_at_retrieval(self, backend: OkfBackend):
        run(backend.write("kubernetes cluster settings", source_type="chat",
                          metadata={"okf": {"type": "note", "title": "K8s"}}))
        ctx = run(backend.context("kubernetes", mark_used=True))
        entry = backend.index._load()["files"]["topics/k8s.md"]
        assert entry["score"] > 0


class TestSelfHeal:
    def test_direct_file_edit_is_picked_up(self, backend: OkfBackend):
        run(backend.write("original text about postgres", source_type="chat",
                          metadata={"okf": {"type": "note", "title": "DB Notes"}}))
        # Human edits the file directly (no backend involvement)
        p = backend.store.root / "topics" / "db-notes.md"
        fm, body = parse_document(p.read_text())
        p.write_text(serialize_document(fm, body + "\nzanzibar elephants"))
        os.utime(p, (p.stat().st_mtime + 5, p.stat().st_mtime + 5))

        ctx = run(backend.context("zanzibar elephants"))
        assert "topics/db-notes.md" in ctx.memory_ids

    def test_deleted_file_drops_out(self, backend: OkfBackend):
        run(backend.write("ephemeral note about xylophones", source_type="chat",
                          metadata={"okf": {"type": "note", "title": "Xylo"}}))
        assert run(backend.context("xylophones")).memory_ids
        (backend.store.root / "topics" / "xylo.md").unlink()
        assert "topics/xylo.md" not in run(backend.context("xylophones")).memory_ids


class TestProvenanceStats:
    def test_provenance(self, backend: OkfBackend):
        run(backend.write("body", source_type="chat", session_id="sess-1",
                          metadata={"okf": {"type": "note", "title": "Prov"}}))
        prov = run(backend.provenance("topics/prov.md"))
        assert prov["source_kind"] == "chat"
        assert prov["trust_score"] == 0.95
        assert prov["title"] == "Prov"

    def test_provenance_missing(self, backend: OkfBackend):
        assert run(backend.provenance("topics/nope.md"))["error"] == "not found"

    def test_stats(self, backend: OkfBackend):
        run(backend.write("body", source_type="chat",
                          metadata={"okf": {"type": "note", "title": "S1"}}))
        stats = run(backend.stats())
        assert stats["provider_name"] == "okf"
        assert stats["total_items"] == 2  # the written note + the seeded soul

    def test_explain(self, backend: OkfBackend):
        run(backend.write("the mitochondria is the powerhouse of the cell",
                          source_type="chat",
                          metadata={"okf": {"type": "note", "title": "Bio"}}))
        out = run(backend.explain("topics/bio.md", "mitochondria powerhouse"))
        assert "mitochondria" in out["matched_fragments"][0]


class TestMaintenance:
    def test_reindex(self, backend: OkfBackend):
        run(backend.write("body", source_type="chat",
                          metadata={"okf": {"type": "note", "title": "R1"}}))
        out = run(backend.reindex())
        assert out["status"] == "ok" and out["reindexed"] >= 1

    def test_journal_retention(self, backend: OkfBackend, tmp_path):
        result = run(backend.write("old entry", source_type="chat"))
        journal = backend.store.abs(result.item_ids[0])
        # Age the file past the retention window
        old = journal.stat().st_mtime - 90 * 86400
        os.utime(journal, (old, old))
        out = run(backend.consolidate())
        assert out["journals_archived"] == 1
        assert (backend.store.root / "journal" / "archive" / journal.name).exists()


class TestSoulSeed:
    def test_soul_seeded_and_in_graph(self, backend: OkfBackend):
        assert (backend.store.root / "self" / "soul.md").exists()
        g = run(backend.graph())
        souls = [n for n in g["nodes"] if n["type"] == "self"]
        assert len(souls) == 1
        assert souls[0]["title"] == "Soul"
        assert souls[0]["id"] == "self/soul.md"


class TestJournalNoiseGate:
    """Near-identical digests (same text modulo numbers) must not flood the
    journal — cortex no-op cycles are the canonical offender."""

    def _entries(self, backend: OkfBackend, memory_id: str) -> int:
        body = backend.store.abs(memory_id).read_text()
        return body.count("\n## ")

    def test_repeat_modulo_digits_suppressed(self, backend: OkfBackend):
        first = run(backend.write(
            "Cortex cycle #28673: Drive 'serve' won (urgency 0.20). No stale goals.",
            source_type="cortex"))
        second = run(backend.write(
            "Cortex cycle #28674: Drive 'serve' won (urgency 0.21). No stale goals.",
            source_type="cortex"))
        assert first.item_ids and not second.item_ids
        assert self._entries(backend, first.item_ids[0]) == 1

    def test_novel_text_not_suppressed(self, backend: OkfBackend):
        first = run(backend.write("Decided to use pgvector for search.",
                                  source_type="cortex"))
        second = run(backend.write("User prefers the galaxy view by default.",
                                   source_type="cortex"))
        assert first.item_ids and second.item_ids
        assert self._entries(backend, first.item_ids[0]) == 2

    def test_sources_keyed_separately(self, backend: OkfBackend):
        run(backend.write("status: 3 items processed", source_type="cortex"))
        other = run(backend.write("status: 3 items processed", source_type="intel"))
        assert other.item_ids

    def test_concept_writes_never_suppressed(self, backend: OkfBackend):
        meta = {"okf": {"type": "note", "title": "Same title"}}
        first = run(backend.write("identical body 1", source_type="chat", metadata=meta))
        second = run(backend.write("identical body 1", source_type="chat", metadata=meta))
        assert first.item_ids and second.item_ids


def test_slugify():
    assert slugify("Hello, World!") == "hello-world"
    assert slugify("  ") == "untitled"
    assert len(slugify("x" * 200)) <= 60
