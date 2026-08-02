"""The Files tab's refusals, and the reindex that keeps a hand edit honest.

    docker compose exec backend python tests/test_files_explorer.py

Two properties are worth defending here, and neither is a preference.

THE ALLOWLIST. A path is reachable only if it resolves inside exactly one
DECLARED root. The test that matters is not "does ../.. get rejected" — it
is that a SYMLINK planted inside a root cannot read out of it, because the
backend container now mounts the whole repo read-only at /app/project for
the backup coverage scan, and `.env` sits at the top of it. resolve() runs
before the containment test for exactly this reason.

THE SAVE IS BYTE-FAITHFUL. Routing an editor through memory.write() would
adopt up to five corpus tags into frontmatter, append a `Related:` line to
the body and restamp `timestamp` — measured at 203 of 214 live topics
changed by a save with no edits. So the explorer writes raw bytes and then
calls the one function that keeps the in-process BM25 index consistent.
There is no watcher and no reindex-on-read: skip that call and search goes
quietly stale while the universe graph (which re-reads disk) looks fine, so
"it showed up in the graph" can never be the evidence.
"""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def refuses(label, coro, *, status=None, contains=None):
    """A refusal is only a control if it refuses for the right reason."""
    from fastapi import HTTPException
    try:
        await coro
    except HTTPException as e:
        ok = (status is None or e.status_code == status) and \
             (contains is None or contains.lower() in str(e.detail).lower())
        check(label, ok, f"{e.status_code}: {str(e.detail)[:70]}")
        return
    check(label, False, "no refusal raised")


async def run() -> None:
    from app import db
    from app.config import settings
    from app.memory.memory import OkfMemory, sandbox
    import app.router_files as rf

    # A rename asks the ledger whether anything points at the old path, so
    # this suite needs the real pool. The query is a read-only count; the
    # notes it renames live in the scratch store above.
    await db.init_pool()

    tmp = Path(tempfile.mkdtemp(prefix="files-explorer-"))
    mem_dir, ws_dir, outside = tmp / "memory", tmp / "workspace", tmp / "outside"
    for d in (mem_dir, ws_dir, outside):
        d.mkdir(parents=True)
    for sub in ("topics", "skills", "sources", "journals"):
        (mem_dir / sub).mkdir()
    (mem_dir / "soul.md").write_text("---\ntype: soul\ntitle: Nova\n---\n\nI am Nova.\n")
    (outside / "secret.txt").write_text("PROVIDER_KEY=sk-do-not-read\n")

    # Built BEFORE settings are repointed: OkfMemory refuses a scratch root
    # that overlaps `settings.okf_memory_dir`, and once that setting names
    # this temp dir the scratch store overlaps itself.
    scratch = OkfMemory(base_dir=str(mem_dir))
    settings.okf_memory_dir = str(mem_dir)
    settings.workspace_dir = str(ws_dir)
    with sandbox(scratch):
        print("\n-- confinement --")
        await refuses("traversal out of a root",
                      rf.read_file(root="workspace", path="../outside/secret.txt"),
                      status=400, contains="leaves its root")
        await refuses("an absolute path is not quietly relativised",
                      rf.read_file(root="workspace", path="/etc/passwd"),
                      status=400, contains="relative")
        await refuses("an undeclared root does not exist",
                      rf.list_dir(root="source", path=""), status=404)
        await refuses("nor does one named by traversal",
                      rf.list_dir(root="../../etc", path=""), status=404)

        # The one that matters: the repo (and .env) is mounted in this
        # container, so a symlink is a real reach, not a hypothetical.
        os.symlink(outside / "secret.txt", ws_dir / "escape.txt")
        await refuses("a symlink cannot read out of its root",
                      rf.read_file(root="workspace", path="escape.txt"),
                      status=400, contains="leaves its root")
        listed = [e["name"] for e in (await rf.list_dir(root="workspace", path=""))["entries"]]
        check("and it is not even listed", "escape.txt" not in listed, str(listed))

        print("\n-- memory is shaped by what the store can see --")
        await refuses("soul.md is identity, not a note",
                      rf.write_content(rf.WriteBody(root="memory", path="soul.md", content="x")),
                      status=403, contains="settings")
        await refuses("journals are the record of what happened",
                      rf.write_content(rf.WriteBody(
                          root="memory", path="journals/2026-08-02.md", content="x")),
                      status=403)
        await refuses("a subfolder would hold notes she cannot find",
                      rf.new_folder(rf.PathBody(root="memory", path="topics/nested")),
                      status=403, contains="two levels deep")
        await refuses("and a nested note cannot be written either",
                      rf.write_content(rf.WriteBody(
                          root="memory", path="topics/a/b.md", content="x")), status=403)
        await refuses("memory holds markdown",
                      rf.write_content(rf.WriteBody(
                          root="memory", path="topics/x.txt", content="x")), status=403)
        await refuses("the type dirs are structure, not files",
                      rf.delete_item(root="memory", path="topics"), status=403)
        await refuses("documents have no address space to write to",
                      rf.write_content(rf.WriteBody(
                          root="documents", path="doc/x", content="x")), status=400)

        print("\n-- a save writes exactly what it was given --")
        note = ("---\ntype: topic\ntitle: Operator Profile\n"
                "tags: [operator-profile, windham-maine]\n"
                "timestamp: 2026-07-24T14:57:22.768924+00:00\n---\n\n"
                "Lives in Windham. Runs ollama on an nvidia gpu.\n")
        p = mem_dir / "topics" / "operator-profile.md"
        p.write_text(note)
        await rf.write_content(rf.WriteBody(
            root="memory", path="topics/operator-profile.md", content=note))
        after = p.read_text()
        check("bytes are identical after a no-op save", after == note,
              f"{len(note)} -> {len(after)}")
        check("no tags were adopted into frontmatter",
              "ollama" not in after.split("---")[1], "link pass stayed out")
        check("the timestamp was not restamped",
              "2026-07-24T14:57:22.768924+00:00" in after)
        check("and no Related: line was appended", "Related:" not in after)

        print("\n-- every mutation ends in a reindex --")
        await rf.new_file(rf.PathBody(root="memory", path="topics/probe.md"))
        check("create indexes the new note", "topics/probe.md" in scratch.index.docs)

        await rf.write_content(rf.WriteBody(
            root="memory", path="topics/probe.md",
            content="---\ntype: topic\ntitle: Probe\n---\n\nquixotic sentinel term.\n"))
        check("an edit re-upserts the BODY, not just the count",
              "quixotic" in scratch.index.postings,
              "this is the one a missing reindex loses silently")
        check("and the new title with it",
              scratch.index.docs["topics/probe.md"]["title"] == "Probe")
        check("mtime is carried into the index, not left at 0.0",
              scratch.index.docs["topics/probe.md"]["mtime"] > 0)

        await rf.rename(rf.RenameBody(root="memory", path="topics/probe.md", to="probe2.md"))
        check("rename evicts the old id", "topics/probe.md" not in scratch.index.docs)
        check("and indexes the new one", "topics/probe2.md" in scratch.index.docs)

        await rf.delete_item(root="memory", path="topics/probe2.md")
        check("delete evicts it", "topics/probe2.md" not in scratch.index.docs)
        check("and takes the term with it", "quixotic" not in scratch.index.postings)

        print("\n-- workspace is an ordinary directory --")
        await rf.new_folder(rf.PathBody(root="workspace", path="proj/sub"))
        await rf.new_file(rf.PathBody(root="workspace", path="proj/sub/n.txt"))
        await rf.write_content(rf.WriteBody(
            root="workspace", path="proj/sub/n.txt", content="line1\nline2\n"))
        got = await rf.read_file(root="workspace", path="proj/sub/n.txt")
        check("nesting is allowed where nothing indexes it",
              got["text"] == "line1\nline2\n", repr(got["text"]))
        await refuses("a non-empty folder says how much is in it",
                      rf.delete_item(root="workspace", path="proj"),
                      status=409, contains="holds")
        await rf.delete_item(root="workspace", path="proj", recursive=True)
        check("and goes when that is confirmed", not (ws_dir / "proj").exists())

        print("\n-- the root is not an item in the tree --")
        # '', '.', './' and 'sub/..' all resolve to the root and used to pass
        # containment through the `p != base` escape hatch, so a delete with
        # an empty path was an rmtree of the whole Workspace.
        (ws_dir / "keep.txt").write_text("do not lose me\n")
        for spelling in ("", ".", "./", "sub/.."):
            await refuses(f"delete of the root spelled {spelling!r}",
                          rf.delete_item(root="workspace", path=spelling, recursive=True),
                          status=400, contains="root of the tree")
        check("and the tree is still there", (ws_dir / "keep.txt").exists())
        await refuses("nor can the root be renamed",
                      rf.rename(rf.RenameBody(root="workspace", path="", to="gone")),
                      status=400, contains="root of the tree")

        print("\n-- a mutation acts on what was NAMED, never on a link --")
        # The read direction refuses a link out of the root (above). The WRITE
        # direction is the one that mattered: a link is followed, so it wrote
        # somewhere the operator never named — and /app/backend is mounted rw.
        # A link pointing OUT is refused twice over: as a link here (the walk
        # runs first) and by containment if it ever got past. The READ path
        # still answers "leaves its root", which is the honest answer there.
        os.symlink(outside / "secret.txt", ws_dir / "out.txt")
        await refuses("write through a link out of the root",
                      rf.write_content(rf.WriteBody(
                          root="workspace", path="out.txt", content="owned")),
                      status=400, contains="link")
        await refuses("and reading it is still refused by containment",
                      rf.read_file(root="workspace", path="out.txt"),
                      status=400, contains="leaves its root")

        # A link pointing INSIDE resolves cleanly and passes containment — it
        # is the one only _refuse_links catches, and the one that made rename
        # move a file nobody named.
        (ws_dir / "real.txt").write_text("the real file\n")
        os.symlink(ws_dir / "real.txt", ws_dir / "alias.txt")
        await refuses("write through an in-root link",
                      rf.write_content(rf.WriteBody(
                          root="workspace", path="alias.txt", content="owned")),
                      status=400, contains="link")
        await refuses("rename of an in-root link",
                      rf.rename(rf.RenameBody(root="workspace", path="alias.txt", to="b.txt")),
                      status=400, contains="link")
        await refuses("delete through an in-root link",
                      rf.delete_item(root="workspace", path="alias.txt"),
                      status=400, contains="link")
        (ws_dir / "realdir").mkdir()
        os.symlink(ws_dir / "realdir", ws_dir / "aliasdir")
        await refuses("write through an in-root linked PARENT",
                      rf.write_content(rf.WriteBody(
                          root="workspace", path="aliasdir/x.txt", content="owned")),
                      status=400, contains="link")
        check("the file the link pointed at is untouched",
              (ws_dir / "real.txt").read_text() == "the real file\n")
        check("and nothing outside the root was written",
              (outside / "secret.txt").read_text() == "PROVIDER_KEY=sk-do-not-read\n")

        # The save's temp file is DERIVED from a confined path, so a link
        # pre-placed at the old predictable name used to redirect the write.
        # The name is now unguessable AND opened O_EXCL|O_NOFOLLOW.
        os.symlink(outside / "secret.txt", ws_dir / ".target.md.tmp")
        await rf.write_content(rf.WriteBody(
            root="workspace", path="target.md", content="mine\n"))
        check("a link at the OLD temp name cannot capture a save",
              (outside / "secret.txt").read_text() == "PROVIDER_KEY=sk-do-not-read\n"
              and (ws_dir / "target.md").read_text() == "mine\n")

        print("\n-- indexed is asked of the index, not guessed from the path --")
        # A note that reached disk out of band is shape-eligible and absent
        # from the index. Inferring the flag from the path shape reported the
        # exact opposite of the thing the flag exists to warn about.
        (mem_dir / "topics" / "out-of-band.md").write_text(
            "---\ntype: topic\ntitle: Out Of Band\n---\n\nnever indexed.\n")
        entries = {e["name"]: e for e in
                   (await rf.list_dir(root="memory", path="topics"))["entries"]}
        check("a file written behind the API's back reads as NOT indexed",
              entries["out-of-band.md"].get("indexed") is False)
        await rf.write_content(rf.WriteBody(
            root="memory", path="topics/out-of-band.md",
            content="---\ntype: topic\ntitle: Out Of Band\n---\n\nnow indexed.\n"))
        entries = {e["name"]: e for e in
                   (await rf.list_dir(root="memory", path="topics"))["entries"]}
        check("and as indexed once saved through the explorer",
              entries["out-of-band.md"].get("indexed") is True)
        souls = [e for e in (await rf.list_dir(root="memory", path=""))["entries"]
                 if e["name"] == "soul.md"]
        check("soul.md carries no flag at all, on either surface",
              souls and "indexed" not in souls[0])
        check("and none when opened either",
              (await rf.read_file(root="memory", path="soul.md"))["indexed"] is None)

        print("\n-- documents are addressed by id --")
        await refuses("a kind folder is not a document",
                      rf.read_file(root="documents", path="doc"), status=400)
        await refuses("and cannot be deleted",
                      rf.delete_item(root="documents", path="doc"), status=400)

        print("\n-- binary and oversize refuse in a sentence --")
        (ws_dir / "b.bin").write_bytes(b"\x89PNG\x00\x01\x02binary")
        got = await rf.read_file(root="workspace", path="b.bin")
        check("a binary file is reported, not decoded", got["kind"] == "binary",
              got.get("reason", ""))
        (ws_dir / "big.txt").write_bytes(b"x" * (rf.MAX_TEXT_BYTES + 1))
        await refuses("an oversize file names the limit",
                      rf.read_file(root="workspace", path="big.txt"),
                      status=413, contains="too big")

    await db.close_pool()


def main() -> int:
    asyncio.run(run())
    if FAILURES:
        print(f"\nFAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
