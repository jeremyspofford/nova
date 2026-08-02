"""Forgetting ONE journal entry, so "forget that document" is true.

    docker compose exec backend python tests/test_journal_forget.py

Before this, a turn where Nova quoted a document was permanent. Journals are
append-only, one file per day; `delete_memory_item` refuses them because
"journals are the audit trail" — a good reason, and it stays; and the only
affordance that existed destroyed a WHOLE DAY. Measured on the live ledger,
journals appear in 122 of 695 retrieval spans, so the quoted document really
does keep coming back.

The two properties that make this real rather than theatre:

  * addressing is by CONTENT HASH, never by the `## <stamp>` heading —
    measured on the live corpus, 2026-08-01 carries 43 entries under 15
    distinct stamps, so a deletion keyed on the heading would take unrelated
    turns with it;
  * the INDEX is rebuilt from the shortened file. BM25 scores a whole file
    as one document, so a removal that leaves the postings alone has deleted
    nothing that matters — the entry still ranks and still surfaces.
"""

import asyncio
import shutil
import sys
import tempfile

sys.path.insert(0, "/app/backend")

from app.memory.memory import OkfMemory                      # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def main():
    scratch = tempfile.mkdtemp(prefix="nova-journal-forget-")
    try:
        mem = OkfMemory(scratch)   # a sandbox: own store, index and lock
        await mem.startup()

        # three entries, two sharing a stamp — the collision that makes
        # timestamp addressing unsafe, reproduced deliberately
        for text in ("User: hello\n\nNova: hi there",
                     "User: read this\n\nNova: it says SALSIFY-4471",
                     "User: unrelated\n\nNova: about something else"):
            await mem.write(text, type="journal", source_type="chat")

        from app import timefmt
        doc_id = f"journals/{timefmt.now_local().date().isoformat()}.md"

        print("1. entries are addressable, and by content")
        entries = await mem.journal_entries(doc_id)
        check("all three entries are listed", len(entries) == 3, str(len(entries)))
        check("each carries a content hash",
              all(len(e["sha256"]) == 64 for e in entries))
        check("hashes are distinct even when stamps collide",
              len({e["sha256"] for e in entries}) == 3,
              f"{len({e['stamp'] for e in entries})} distinct stamps")

        print("\n2. the entry is retrievable before it is forgotten")
        hits = mem.index.search("SALSIFY", type_filter={"journal"}, top_k=5)
        check("the index matches a token unique to that entry", bool(hits), str(hits))

        print("\n3. forgetting removes it from the FILE and the INDEX")
        target = next(e for e in entries if "SALSIFY" in e["text"])
        removed = await mem.forget_journal_entry(doc_id, target["sha256"],
                                                 "no longer relevant")
        check("the removed entry is returned", removed is not None)
        body = (mem.store.read_file(doc_id) or ({}, ""))[1]
        check("the text is gone from the file", "SALSIFY" not in body)
        check("the OTHER entries survive",
              "hi there" in body and "something else" in body)
        hits = mem.index.search("SALSIFY", type_filter={"journal"}, top_k=5)
        check("and the INDEX no longer matches it — without this the entry "
              "still ranks and still reaches the prompt", not hits, str(hits))

        print("\n4. what is left behind is honest")
        check("a tombstone marks the removal", "removed by the operator" in body,
              body[body.find("removed by"):][:70])
        check("...carrying the operator's reason", "no longer relevant" in body)
        check("...and NOT the text it removed", "SALSIFY" not in body)

        print("\n5. a stale or wrong hash removes NOTHING")
        again = await mem.forget_journal_entry(doc_id, target["sha256"], "")
        check("forgetting the same hash twice is not success the second time",
              again is None, str(again))
        bogus = await mem.forget_journal_entry(doc_id, "0" * 64, "")
        check("an unknown hash removes nothing", bogus is None)
        body2 = (mem.store.read_file(doc_id) or ({}, ""))[1]
        check("...and the file is untouched by the failed attempts",
              body2 == body)

        print("\n6. the path is confined to journals")
        # the splice must never be aimable at a topic, a skill or soul.md
        await mem.write("a topic body", type="topic", title="Some Topic")
        check("a topic id lists no entries (refused by _journal_path)",
              await mem.journal_entries("topics/some-topic.md") == [])
        check("...and cannot be spliced",
              await mem.forget_journal_entry("topics/some-topic.md", "0" * 64, "")
              is None)
        check("traversal is refused",
              await mem.journal_entries("journals/../soul.md") == [])
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    asyncio.run(main())
