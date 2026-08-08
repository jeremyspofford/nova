"""One-hop expansion follows real edges, never categories, never trust holes.

    docker compose exec backend python tests/test_memory_graph_expansion.py

BM25 seeds the retrieval set; the already-computed edges — [[wikilinks]]
riding on the index, shared SPECIFIC subject tags — may pull in a bounded
number of neighbours. ONE hop, never more: subjects.py measured (permutation
null, 400 shuffles) that cross-cluster relations in this corpus are rarer
than chance — the corpus is channel silos — so a multi-hop walk would circle
inside a silo. The rails under test:

  * tagtiers decides bridging. A SEED_FLOOR/structural tag ("zoo") must
    never connect unrelated notes (the founding Bear-Mountain incident),
    and ENTITY tags (a followed channel's tag) must not expand either —
    channel membership is the silo, and expanding along it pulls an
    arbitrary sibling video.
  * the origins trust filter applies to neighbours exactly as to hits — a
    third-party neighbour must NOT ride into an actor-holding turn through
    the expansion door.
  * the neighbour count is capped, and journals are not expanded from.
"""

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def run() -> None:
    from app.memory.memory import OkfMemory, sandbox
    from app.memory import provenance

    tmp = Path(tempfile.mkdtemp(prefix="nova-hop-"))
    try:
        mem = OkfMemory(base_dir=str(tmp))
        await mem.startup()
        with sandbox(mem):
            # A seed note that wiki-links to a neighbour nothing queries for
            await mem.write("Axolotl regeneration notes. See [[Lab Protocols]].",
                            type="topic", title="Axolotl Research",
                            tags=["axolotl"], link_pass=False)
            await mem.write("Centrifuge speeds and reagent storage rules.",
                            type="topic", title="Lab Protocols",
                            tags=["lab-protocols"], link_pass=False)

            r = await mem.context("axolotl regeneration")
            check("an outgoing [[wikilink]] neighbour is pulled in",
                  "topics/lab-protocols.md" in r["memory_ids"],
                  str(r["memory_ids"]))

            # Incoming link direction: querying the TARGET pulls the LINKER
            r = await mem.context("centrifuge reagent storage")
            check("an incoming wikilink neighbour is pulled in",
                  "topics/axolotl-research.md" in r["memory_ids"],
                  str(r["memory_ids"]))

            # ── structural tags never expand ────────────────────────────
            await mem.write("Bear Mountain has a small petting zoo area.",
                            type="topic", title="Bear Mountain Zoo Area",
                            tags=["zoo"], link_pass=False)
            await mem.write("Me at the zoo was the first YouTube video.",
                            type="topic", title="Me At The Zoo Video",
                            tags=["zoo"], link_pass=False)
            r = await mem.context("bear mountain petting area")
            check("a SEED_FLOOR tag ('zoo') bridges nothing",
                  "topics/me-at-the-zoo-video.md" not in r["memory_ids"],
                  str(r["memory_ids"]))

            # ── entity (channel) tags never expand — that is the silo ───
            await mem.write("Channel index for TechTalks.", type="source",
                            title="TechTalks Channel",
                            tags=["src-techtalks"], link_pass=False)
            await mem.write("Video about ostrich farming economics.",
                            type="topic", title="Ostrich Farming Video",
                            tags=["src-techtalks"], source_type="media_transcript",
                            link_pass=False)
            await mem.write("Video about submarine cable repair.",
                            type="topic", title="Submarine Cable Video",
                            tags=["src-techtalks"], source_type="media_transcript",
                            link_pass=False)
            r = await mem.context("ostrich farming economics")
            check("a channel tag pulls no sibling video",
                  "topics/submarine-cable-video.md" not in r["memory_ids"],
                  str(r["memory_ids"]))

            # ── a shared SPECIFIC subject tag does expand ───────────────
            await mem.write("Fermentation timing for sourdough starters.",
                            type="topic", title="Sourdough Timing",
                            tags=["sourdough"], link_pass=False)
            await mem.write("Hydration ratios and flour choice.",
                            type="topic", title="Sourdough Hydration",
                            tags=["sourdough"], link_pass=False)
            r = await mem.context("fermentation timing starters")
            check("a shared specific subject tag expands one hop",
                  "topics/sourdough-hydration.md" in r["memory_ids"],
                  str(r["memory_ids"]))

            # ── the trust filter has no back door ───────────────────────
            await mem.write("Quilting stitch patterns overview. See [[Fetched Quilt Page]].",
                            type="topic", title="Quilting Notes",
                            tags=["quilting"], link_pass=False)
            await mem.write("A fetched page about quilt patterns.",
                            type="topic", title="Fetched Quilt Page",
                            tags=["quilting"], source_type="media_transcript",
                            link_pass=False)
            actor = {provenance.FIRST_PARTY, provenance.CONVERSATION}
            r = await mem.context("quilting stitch patterns", origins=actor)
            check("a third-party neighbour never reaches an actor turn",
                  "topics/fetched-quilt-page.md" not in r["memory_ids"],
                  str(r["memory_ids"]))
            check("...while the trusted seed still shows",
                  "topics/quilting-notes.md" in r["memory_ids"])

            # ── bounded: at most _NEIGHBOUR_LIMIT extras ────────────────
            body = "Beekeeping frames and hive inspection cadence"
            await mem.write(body + ".", type="topic", title="Beekeeping Core",
                            tags=["beekeeping"], link_pass=False)
            for i in range(6):
                await mem.write(f"Hive note variant {i} on winter feeding.",
                                type="topic", title=f"Beekeeping Extra {i}",
                                tags=["beekeeping"], link_pass=False)
            r = await mem.context("hive inspection cadence frames")
            seeds = mem._ranked("hive inspection cadence frames",
                                5, None)
            check("expansion adds at most the neighbour cap",
                  len(r["memory_ids"]) <= len(seeds) + mem._NEIGHBOUR_LIMIT,
                  f"{len(r['memory_ids'])} vs {len(seeds)} seeds")

            # ── an empty seed set expands to nothing ────────────────────
            r = await mem.context("xylophone maintenance grommet")
            check("no seeds, no neighbours", r["memory_ids"] == [],
                  str(r["memory_ids"]))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    asyncio.run(run())
