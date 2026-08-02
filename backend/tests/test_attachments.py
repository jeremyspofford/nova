"""The attachment store's rails (roadmap #22b).

    docker compose exec backend python tests/test_attachments.py

Every check here defends one property, and each exists because the obvious
implementation gets it wrong:

  * identity is a UUID + content hash, NEVER the filename — two documents
    called `invoice.pdf` must not become one;
  * a missing mount REFUSES rather than writing the only copy of a document
    into a container layer;
  * the bytes are unlinked only by the LAST row that references them;
  * delete puts the row last, so a crash leaves a findable row rather than
    orphaned bytes plus a deletion receipt.
"""

import asyncio
import sys
import uuid

sys.path.insert(0, "/app/backend")

from app import attachments, db                              # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def main():
    await db.init_pool()
    created: list[str] = []
    try:
        print("1. identity is the content, never the name")
        a = await attachments.store(b"March invoice, total 100", name="invoice.pdf",
                                    mime="application/pdf", kind="doc")
        b = await attachments.store(b"July invoice, total 250", name="invoice.pdf",
                                    mime="application/pdf", kind="doc")
        created += [a["id"], b["id"]]
        check("two documents sharing a filename are two rows",
              a["id"] != b["id"], f"{a['id'][:8]} vs {b['id'][:8]}")
        check("...with different content addresses",
              a["sha256"] != b["sha256"])
        got_a = await attachments.read_bytes(a["id"])
        check("...and the first is UNTOUCHED by the second",
              got_a is not None and got_a[0] == b"March invoice, total 100",
              (got_a[0][:24].decode() if got_a else "gone"))

        print("\n2. the same bytes twice share one blob")
        c = await attachments.store(b"March invoice, total 100", name="copy.pdf",
                                    mime="application/pdf", kind="doc")
        created.append(c["id"])
        check("a re-upload is its own row", c["id"] != a["id"])
        check("...over the same blob", c["sha256"] == a["sha256"], c["sha256"][:12])

        print("\n3. the bytes survive until the LAST reference goes")
        await attachments.delete(c["id"])
        created.remove(c["id"])
        got = await attachments.read_bytes(a["id"])
        check("deleting one of two rows leaves the other readable",
              got is not None and got[0] == b"March invoice, total 100")
        await attachments.delete(a["id"])
        created.remove(a["id"])
        check("deleting the last reference removes the row",
              await attachments.get(a["id"]) is None)
        check("...and the blob with it",
              not attachments._blob_path(a["sha256"]).exists())

        print("\n4. a missing store REFUSES rather than writing into the container")
        real = attachments.STORE_DIR
        attachments.STORE_DIR = real.parent / "definitely-not-mounted"
        try:
            ok, why = attachments.store_available()
            check("store_available reports the mount as unusable", not ok, why[:60])
            raised = None
            try:
                await attachments.store(b"x" * 32, name="doomed.pdf",
                                        mime="application/pdf", kind="doc")
            except attachments.StoreUnavailable as e:
                raised = str(e)
            check("...and an upload raises rather than silently succeeding",
                  raised is not None, (raised or "wrote anyway")[:70])
        finally:
            attachments.STORE_DIR = real
        ok, _ = attachments.store_available()
        check("the real store is usable again", ok)

        print("\n5. caps and refusals")
        raised = None
        try:
            await attachments.store(b"z" * (attachments.MAX_BYTES + 1),
                                    name="huge.pdf", mime="application/pdf", kind="doc")
        except ValueError as e:
            raised = str(e)
        check("an oversized file is refused with a sentence naming the limit",
              raised is not None and "MB" in (raised or ""), (raised or "")[:70])
        raised = None
        try:
            await attachments.store(b"", name="empty.pdf", mime="", kind="doc")
        except ValueError as e:
            raised = str(e)
        check("an empty file is refused", raised is not None)

        print("\n6. usage is MEASURED from the disk, not tallied in a column")
        u = await attachments.usage()
        check("usage reports the store as healthy", u["store_ok"] and u["missing"] == 0,
              str({k: u[k] for k in ("documents", "missing", "store_ok")}))

        print("\n7. text carries the source that produced it")
        d = await attachments.store(b"scanned", name="scan.pdf", mime="application/pdf",
                                    kind="doc", text="READ BY OCR", text_source="ocr")
        created.append(d["id"])
        row = await attachments.get(d["id"])
        check("the source is stored alongside the text",
              row["text_source"] == "ocr" and row["text_content"] == "READ BY OCR",
              str(row["text_source"]))
        raised = None
        try:
            await attachments.store(b"bogus source", name="x.pdf", mime="",
                                    kind="doc", text="t", text_source="vibes")
        except Exception as e:
            raised = type(e).__name__
        check("an invented source is refused by the DATABASE, not by convention",
              raised is not None, raised or "accepted")
        # ...and the bytes written before that INSERT do not survive it. This
        # check exists because the first run of this suite LEFT one: bytes go
        # to disk before the row by design, so a rejected row stranded them.
        import hashlib
        stranded = hashlib.sha256(b"bogus source").hexdigest()
        check("...and the rejected write leaves no orphan bytes behind",
              not attachments._blob_path(stranded).exists(), stranded[:12])

        print("\n8. orphans are COUNTED, not assumed away")
        u = await attachments.usage()
        check("usage reports the orphan count as a measured fact",
              "orphans" in u, str(u.get("orphans")))
    finally:
        for i in created:
            try:
                await attachments.delete(i)
            except Exception:
                pass
        await db.close_pool()

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    asyncio.run(main())
