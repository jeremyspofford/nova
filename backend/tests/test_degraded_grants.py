"""A grant that resolves to nothing is a degradation, and it had no signal.

    docker compose exec backend python tests/test_degraded_grants.py

`maintainer`'s entire read surface is one MCP sidecar. Stop it and seven
granted tools vanish from her resolved toolset: main dispatches to her, she
has nothing to work with, and the reply reads as incompetence rather than as a
service being down. The agent row still says she can. Only the resolution says
she cannot, and nothing compared the two.

Verified live while building this — stopping mcp-runner and refreshing the
server status produced exactly `maintainer DEGRADED (7)`, all seven named, and
starting it again cleared the warning with no reset. It also found a real one
nobody had noticed: `main` holds `retry_ingest_job`, which resolves to no
callable tool at all.

The comparison is per GRANT ENTRY, not per resolved name, and that is the
whole subtlety: one `mcp:server:*` entry expands to many tools and `db:*` to
whatever exists, so a set difference would report nonsense in both directions.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

from app.tools import registry as tr                 # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def run(allowed, *, db_tools=None, mcp_tools=None):
    """degraded_grants with both resolvers injected — no DB, no sidecar."""
    async def _db():
        return dict.fromkeys(db_tools or [], {"name": "x"})

    async def _mcp():
        return dict.fromkeys(mcp_tools or [], {"name": "x"})

    real_db, real_mcp = tr._load_db_tools, tr._load_mcp_tools
    tr._load_db_tools, tr._load_mcp_tools = _db, _mcp
    try:
        return asyncio.run(tr.degraded_grants({"allowed_tools": allowed}))
    finally:
        tr._load_db_tools, tr._load_mcp_tools = real_db, real_mcp


def main() -> int:
    builtin = next(iter(tr.BUILTIN_TOOLS))

    print("1. the maintainer case — an MCP server that stopped answering")
    mcp_grants = ["mcp:nova-src/read_text_file", "mcp:nova-src/list_directory"]
    check("with the server connected, nothing is degraded",
          run([builtin, *mcp_grants], mcp_tools=mcp_grants) == [])
    check("with it gone, every granted MCP tool is named",
          run([builtin, *mcp_grants], mcp_tools=[]) == mcp_grants,
          str(run([builtin, *mcp_grants], mcp_tools=[])))
    check("...and the builtin beside them is NOT dragged in with it",
          builtin not in run([builtin, *mcp_grants], mcp_tools=[]))

    print("2. a wildcard server grant is one entry, not many")
    check("a live wildcard resolves",
          run(["mcp:nova-src:*"], mcp_tools=["mcp:nova-src/read_text_file"]) == [])
    check("a dead wildcard is reported once, as the entry it is",
          run(["mcp:nova-src:*"], mcp_tools=[]) == ["mcp:nova-src:*"])

    print("3. db:* is a wildcard over a set, never a broken grant")
    check("db:* with no DB tools is not flagged — an install with none is "
          "normal, and crying wolf there teaches you to ignore this",
          run(["db:*"], db_tools=[]) == [])
    check("a NAMED db tool that has gone is flagged",
          run(["some_db_tool"], db_tools=[]) == ["some_db_tool"])
    check("...and is not flagged while it exists",
          run(["some_db_tool"], db_tools=["some_db_tool"]) == [])

    print("4. the shapes that must never be flagged")
    check("unrestricted (None) has no grant entries to break",
          run(None) == [])
    check("an empty grant list has nothing to break", run([]) == [])
    check("a plain builtin never degrades", run([builtin]) == [])

    print("5. order and identity are preserved, so the message is readable")
    out = run(["mcp:a/one", builtin, "mcp:b/two"], mcp_tools=[])
    check("only the broken entries, in the order granted",
          out == ["mcp:a/one", "mcp:b/two"], str(out))

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
