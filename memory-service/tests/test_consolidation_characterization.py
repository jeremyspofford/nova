"""Characterization tests for _merge_duplicates — lock current behavior.

Runs BEFORE the P2 HNSW-shortlist refactor in Task 3.3 to capture the
canonical merge outcome on a fixed 10-engram fixture (3 near-duplicates
+ 7 uniques). The post-refactor implementation must produce the same
merge result on the same input.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from app.engram.consolidation import _merge_duplicates
from sqlalchemy import text

from ._snapshot import assert_snapshot

SNAPSHOT_DIR = Path(__file__).parent / "fixtures" / "snapshots"


def _summarize_merge_state(rows):
    """Convert engram rows → JSON-friendly summary, sorted deterministically by content."""
    out = [
        {
            "content": r.content,
            "type": r.type,
            "source_type": r.source_type,
            "superseded": r.superseded,
            "access_count": r.access_count,
        }
        for r in rows
    ]
    out.sort(key=lambda d: (d["content"], d["superseded"]))
    return out


@pytest.mark.asyncio
async def test_merge_duplicates_three_near_dupes_seven_uniques(
    db_session, engram_factory
):
    """3 near-duplicate facts (high similarity, all type=fact + source_type=chat) plus
    7 unique facts. After _merge_duplicates: at most 2 of the 3 dupes are superseded;
    the highest-access-count one survives.
    """
    # Three near-duplicates: nearly identical embeddings (cosine sim >> 0.88)
    dup_emb_a = [0.5] * 768
    dup_emb_b = [0.5] * 767 + [0.501]  # tiny perturbation, cosine still ~1.0
    dup_emb_c = [0.5] * 766 + [0.501, 0.501]

    await engram_factory(content="dup-a", embedding=dup_emb_a, access_count=10)
    await engram_factory(content="dup-b", embedding=dup_emb_b, access_count=5)
    await engram_factory(content="dup-c", embedding=dup_emb_c, access_count=2)

    # Seven uniques: orthogonal embeddings (each in its own dimension)
    for i in range(7):
        emb = [0.0] * 768
        emb[i] = 1.0  # one-hot at position i
        await engram_factory(content=f"unique-{i}", embedding=emb, access_count=i)

    await db_session.flush()

    # Run _merge_duplicates — function modifies session state directly
    merged_count = await _merge_duplicates(db_session)
    await db_session.flush()

    # Capture final state of all engrams
    rows = await db_session.execute(
        text(
            "SELECT content, type, source_type, superseded, access_count "
            "FROM engrams ORDER BY content"
        )
    )
    fetched = list(rows)

    summary = {
        "merged_count": merged_count,
        "engrams": _summarize_merge_state(fetched),
    }
    assert_snapshot(
        summary, path=SNAPSHOT_DIR / "consolidation_merge_3dup_7unique.json"
    )
