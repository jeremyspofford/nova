"""Lane B rails: the two ways write_memory silently destroyed a memory.

Both were reachable from a normal chat turn and both reported success:

  * a create whose title slugged onto an existing note wrote straight over
    it — body gone, maintained_by/about gone — and still answered
    {"status": "written"}
  * item_id only had to resolve inside data/memory and end in .md, so
    'journals/2026-07-24.md' or 'soul.md' could have its whole body replaced,
    while delete_memory_item has always refused to touch either

Runs against a real temp memory dir, no DB and no model.

    docker compose exec backend python tests/test_memory_integrity.py
"""

import asyncio
import shutil
import sys
import tempfile

sys.path.insert(0, "/app/backend")

from app.memory import memory as memory_mod                 # noqa: E402

SCRATCH = tempfile.mkdtemp(prefix="nova-lane-b-")
FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def test_slug_collision():
    print("a colliding title never flattens the note already there")
    mem = memory_mod.OkfMemory(base_dir=SCRATCH)

    first = await mem.write("The original body, hard-won.", type="topic",
                            title="Shared Title", description="first",
                            maintained_by="nightly-digest", link_pass=False)
    check("the first write lands", first["status"] == "written", str(first))
    doc_id = first["id"]

    second = await mem.write("Something else entirely.", type="topic",
                             title="Shared Title", description="second",
                             link_pass=False)
    check("the second is refused, not silently applied",
          second["status"] == "exists", str(second.get("status")))
    check("it hands back the id needed to append or replace",
          second.get("id") == doc_id, str(second.get("id")))
    check("the error tells the model both ways forward",
          "append=true" in second.get("error", ""))

    kept = await mem.read_item(doc_id)
    check("the original body survived",
          "hard-won" in kept["content"], kept["content"][:40])
    check("the original provenance survived",
          kept["frontmatter"].get("maintained_by") == "nightly-digest")

    # the deliberate paths still work
    appended = await mem.write("An added line.", type="topic", title="Shared Title",
                               item_id=doc_id, append=True, link_pass=False)
    check("appending to it works", appended["status"] == "appended", str(appended))
    both = await mem.read_item(doc_id)
    check("append kept the original AND added the new",
          "hard-won" in both["content"] and "An added line." in both["content"])

    replaced = await mem.write("Deliberate replacement.", type="topic",
                               title="Shared Title", item_id=doc_id, link_pass=False)
    check("a pinned replace still works", replaced["status"] == "written", str(replaced))

    # mechanical writers that own their slug opt out
    owned = await mem.write("Refreshed transcript.", type="topic",
                            title="Shared Title", replace=True, link_pass=False)
    check("replace=True overwrites on purpose", owned["status"] == "written", str(owned))


async def test_pinned_targets():
    print("item_id cannot reach outside the concept directories")
    mem = memory_mod.OkfMemory(base_dir=SCRATCH)

    await mem.write("A thing that happened today.", type="journal")
    journals = [p for p, _ in mem.store.iter_files() if p.startswith("journals/")]
    check("a journal exists to aim at", bool(journals), str(journals))

    before = mem.store.read_file(journals[0])[1]
    res = await mem.write("REPLACED", type="topic", title="whatever",
                          item_id=journals[0], link_pass=False)
    check("replacing a journal is refused", res["status"] == "error", str(res))
    check("the refusal explains the rule", "record of what happened" in res.get("error", ""))
    after = mem.store.read_file(journals[0])[1]
    check("the journal body is untouched", before == after)

    # soul.md sits at the root, not under a concept dir
    (mem.store.base_dir / "soul.md").write_text("---\ntype: soul\n---\n\nWho Nova is.\n")
    res = await mem.write("REPLACED", type="topic", title="whatever",
                          item_id="soul.md", link_pass=False)
    check("replacing soul.md is refused", res["status"] == "error", str(res))
    check("soul.md is untouched",
          "Who Nova is." in (mem.store.base_dir / "soul.md").read_text())

    res = await mem.write("x", type="topic", title="y",
                          item_id="../../etc/passwd", link_pass=False)
    check("traversal is still refused", res["status"] == "error", str(res))

    # the concept dirs still accept a pin
    made = await mem.write("A skill.", type="skill", title="Lane B Skill",
                           link_pass=False)
    res = await mem.write("Updated skill.", type="skill", title="Lane B Skill",
                          item_id=made["id"], link_pass=False)
    check("pinning a skill still works", res["status"] == "written", str(res))


async def main():
    await test_slug_collision()
    print()
    await test_pinned_targets()
    print()
    shutil.rmtree(SCRATCH, ignore_errors=True)
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
