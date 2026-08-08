"""A no-op save writes NOTHING — recency signals must mean knowledge.

    docker compose exec backend python tests/test_memory_churn.py

Measured 2026-08-05 on the live corpus: an in-place update always restamped
frontmatter `timestamp`, so a save with no edits rewrote 203 of 214 topics
and moved the corpus's mean mtime forward 8.9 days. Every consumer of
recency — the index mtime the ranking now scores, "learned <date>" in
retrieval snippets, memory_usage's changed_in_window, the graph's fresh
flares — read that churn as knowledge. The ranking work (recency boost)
landed in the same change as this guard BECAUSE ranking on a poisoned
recency signal ranks on churn.

Also here: the first coverage `_link_pass` has ever had. It runs on every
model-facing topic write and had zero tests.
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

    tmp = Path(tempfile.mkdtemp(prefix="nova-churn-"))
    try:
        mem = OkfMemory(base_dir=str(tmp))
        await mem.startup()
        with sandbox(mem):
            # ── the churn guard ─────────────────────────────────────────
            body = "The marginal electricity rate is $0.237/kWh in Windham."
            r = await mem.write(body, type="topic", title="Electric Rates",
                                tags=["electricity"], link_pass=False)
            doc_id = r["id"]
            path = mem.store.base_dir / doc_id
            raw_before = path.read_text()
            mtime_before = path.stat().st_mtime
            ts_before = mem.store.read_file(doc_id)[0].get("timestamp")

            await asyncio.sleep(0.02)  # so a rewrite WOULD move mtime
            r2 = await mem.write(body, type="topic", title="Electric Rates",
                                 tags=["electricity"], item_id=doc_id,
                                 link_pass=False)
            check("a no-op update still reports success", r2["status"] == "written",
                  str(r2))
            check("...but the file bytes are untouched",
                  path.read_text() == raw_before)
            check("...the timestamp is preserved",
                  mem.store.read_file(doc_id)[0].get("timestamp") == ts_before)
            check("...and mtime did not move (nothing was written)",
                  path.stat().st_mtime == mtime_before,
                  f"{mtime_before} -> {path.stat().st_mtime}")

            # a REAL edit — one changed character — still restamps
            r3 = await mem.write(body + "!", type="topic", title="Electric Rates",
                                 tags=["electricity"], item_id=doc_id,
                                 link_pass=False)
            check("a one-character change writes", r3["status"] == "written")
            check("...and restamps the timestamp",
                  mem.store.read_file(doc_id)[0].get("timestamp") != ts_before)

            # a metadata-only change (priority) is also a real change
            ts_after_edit = mem.store.read_file(doc_id)[0].get("timestamp")
            await mem.write(body + "!", type="topic", title="Electric Rates",
                            tags=["electricity"], priority=3,
                            item_id=doc_id, link_pass=False)
            fm = mem.store.read_file(doc_id)[0]
            check("a frontmatter-only change writes and restamps",
                  fm.get("priority") == "3"
                  and fm.get("timestamp") != ts_after_edit)

            # append is a real change and must keep bumping the timestamp
            ts4 = mem.store.read_file(doc_id)[0].get("timestamp")
            await mem.write("Delivery rate went up.", type="topic",
                            item_id=doc_id, append=True)
            check("append still restamps (it is a real change)",
                  mem.store.read_file(doc_id)[0].get("timestamp") != ts4)

            # ── the flagship no-op: link_pass ON, corpus around it ──────
            await mem.write("Bear Mountain trail conditions and parking.",
                            type="topic", title="Bear Mountain",
                            tags=["bear-mountain"], link_pass=False)
            r5 = await mem.write("Hiked near bear mountain today; loved it.",
                                 type="topic", title="Hike Log Note",
                                 tags=[])
            hike_id = r5["id"]
            hike_path = mem.store.base_dir / hike_id
            hike_raw = hike_path.read_text()
            hike_mtime = hike_path.stat().st_mtime
            await asyncio.sleep(0.02)
            # the exact shape that rewrote 203/214: re-save the same content
            # with the link pass ON — its adopted tags and Related line must
            # reproduce byte-identically, so the guard sees a no-op
            r6 = await mem.write("Hiked near bear mountain today; loved it.",
                                 type="topic", title="Hike Log Note",
                                 tags=[], item_id=hike_id)
            check("re-save with link_pass on is byte-stable",
                  hike_path.read_text() == hike_raw, str(r6))
            check("...and did not move mtime",
                  hike_path.stat().st_mtime == hike_mtime)

            # ── _link_pass itself (first-ever coverage) ─────────────────
            check("link_pass adopted the corpus tag whose phrase appears",
                  "bear-mountain" in (r5.get("linked_tags") or []),
                  str(r5))

            # a structural (SEED_FLOOR) tag is never adopted even when the
            # word appears verbatim — the founding Bear-Mountain/zoo incident
            await mem.write("The zoo has pandas.", type="topic",
                            title="City Zoo Note", tags=["zoo"], link_pass=False)
            r7 = await mem.write("We went to the zoo after the museum.",
                                 type="topic", title="Weekend Outing", tags=[])
            check("a SEED_FLOOR tag ('zoo') is never adopted",
                  "zoo" not in (r7.get("linked_tags") or []), str(r7))

            # a verbatim title mention becomes a Related: [[wikilink]]
            r8 = await mem.write("Compare with Bear Mountain for parking.",
                                 type="topic", title="Parking Comparison",
                                 tags=[])
            body8 = mem.store.read_file(r8["id"])[1]
            check("a mentioned title comes back as related",
                  "Bear Mountain" in (r8.get("related") or []), str(r8))
            check("...and lands as a Related: [[wikilink]] line",
                  "[[Bear Mountain]]" in body8, body8[-80:])

            # an already-linked title is not re-related (no duplicate line)
            r9 = await mem.write("See [[Bear Mountain]] for parking details.",
                                 type="topic", title="Parking Two", tags=[])
            check("an existing [[wikilink]] is not re-added",
                  not (r9.get("related")), str(r9))

            # tags the doc already carries are not adopted twice
            r10 = await mem.write("More about bear mountain snowfall.",
                                  type="topic", title="Snow Report",
                                  tags=["bear-mountain"])
            check("an own tag is not re-adopted",
                  "bear-mountain" not in (r10.get("linked_tags") or []), str(r10))

            # caps hold: at most 5 adopted tags, at most 3 related titles
            for i in range(7):
                await mem.write(f"note body {i}", type="topic",
                                title=f"Capsubject{i} Note",
                                tags=[f"capsubject{i}-x", f"capsubject{i}-y"],
                                link_pass=False)
                # second doc per tag so the tag is SPECIFIC, not inert
                await mem.write(f"more capsubject{i}-x and capsubject{i}-y",
                                type="topic", title=f"Capsubject{i} Extra",
                                tags=[f"capsubject{i}-x", f"capsubject{i}-y"],
                                link_pass=False)
            mention_all = " ".join(
                f"capsubject{i}-x capsubject{i}-y Capsubject{i} Note" for i in range(7))
            r11 = await mem.write(mention_all, type="topic",
                                  title="Everything Mention", tags=[])
            check("adopted tags cap at 5",
                  len(r11.get("linked_tags") or []) <= 5, str(r11.get("linked_tags")))
            check("related titles cap at 3",
                  len(r11.get("related") or []) <= 3, str(r11.get("related")))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    asyncio.run(run())
