"""_PARALLEL_TOOLS is derived, and the declaration it derives from is true.

    docker compose exec backend python tests/test_parallel_tools.py

The set used to be nine names typed by hand, under a comment that admitted the
flaw out loud: "New read-only builtins do NOT join this set automatically;
adding one is a deliberate decision." It is now read off the `reads_only`
declaration beside each tool, which makes that flag load-bearing in THREE
places at once — `registry.unattended_tools`, the deferral guard's forced
round, and concurrency.

That is the point, not a risk: a wrong flag is now a write performed unasked
AND a write racing itself, so it has two chances to be caught instead of one.

IT HAS ALREADY BEEN WRONG ONCE. `check_coding_session` shipped carrying
`reads_only: True` and a description reading "Read-only.", while
`coder.refresh` issues `UPDATE coding_sessions SET … WHERE id = $1`
(coder.py:248-256) from both the 404 branch — persisting a TERMINAL
state='failed' that stops every later poll — and the success branch. Nothing
failed; one consumer had no reason to look. §3 pins it, and §7 is the general
form: a static reach scan that fails the day any read-only builtin can get to
a write.

Layers, in order of what would hurt most if it broke:

  1. THE DERIVATION — it is derived at all, and from the right source.
  2. NO SILENT REGRESSION — the nine that shipped are all still in.
  3. THE KNOWN LIAR — check_coding_session is not read-only, and says so.
  4. THE FENCE — nothing in a batch is an actor, so a taint set mid-batch
     cannot refuse a sibling that is already running.
  5. CAPS — every cap names a tool that can actually batch, and the
     semaphore is observed to bind, not merely declared.
  6. THE BATCHING RULE — order preserved, a mutating call ends a run.
  7. THE INVARIANT — no read-only builtin reaches a write, with a control
     proving the scanner is wired to something.
"""

import ast
import asyncio
import pathlib
import re
import sys

sys.path.insert(0, "/app/backend")

from app.agents import runner                                # noqa: E402
from app.tools import fixtures, scopes                       # noqa: E402
from app.tools import registry as tool_registry              # noqa: E402
from app.tools.builtin import BUILTIN_TOOLS                  # noqa: E402

FAILURES: list[str] = []

READS_ONLY = {n for n, s in BUILTIN_TOOLS.items() if s.get("reads_only")}

# What shipped before the derivation. Not a spec — a FLOOR. The derivation is
# allowed to widen this set and never to shrink it silently.
SHIPPED_NINE = {"web_search", "fetch_url", "get_weather", "search_memory",
                "read_memory_item", "list_agents", "list_models",
                "list_followed_sources", "list_stale_topics"}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


# ── 1. the derivation ────────────────────────────────────────────────────

def test_derivation():
    print("1. the set is derived, not typed")
    check("_PARALLEL_TOOLS == reads_only - _PARALLEL_EXCLUDE",
          runner._PARALLEL_TOOLS == READS_ONLY - runner._PARALLEL_EXCLUDE,
          str(sorted(runner._PARALLEL_TOOLS ^ (READS_ONLY - runner._PARALLEL_EXCLUDE))))
    # A stale exclusion is dead text pretending to be a control.
    check("every exclusion names a tool that is actually read-only",
          runner._PARALLEL_EXCLUDE <= READS_ONLY,
          str(sorted(runner._PARALLEL_EXCLUDE - READS_ONLY)))
    # The exclusion set holds COST. A write parked there would be a lie told
    # in the wrong file: it would leave unattended_tools and the deferral
    # guard still believing the tool is safe to run unasked.
    check("nothing is excluded because it mutates — that belongs out of reads_only",
          not (runner._PARALLEL_EXCLUDE & tool_registry.ACTOR_TOOLS),
          str(sorted(runner._PARALLEL_EXCLUDE & tool_registry.ACTOR_TOOLS)))
    # MCP and DB tools are read-only by an operator's claim about a remote,
    # not by a traced audit. They must not leak in through the derivation.
    check("nothing outside BUILTIN_TOOLS is in the set",
          runner._PARALLEL_TOOLS <= set(BUILTIN_TOOLS),
          str(sorted(runner._PARALLEL_TOOLS - set(BUILTIN_TOOLS))))
    # The runner executes these itself; they never reach execute_tool.
    for inlined in ("dispatch_to_agent", "find_mcp_tools"):
        check(f"{inlined} can never batch",
              inlined not in runner._PARALLEL_TOOLS)


# ── 2. no silent regression ──────────────────────────────────────────────

def test_no_regression():
    print("2. the nine that shipped are all still parallel")
    lost = SHIPPED_NINE - runner._PARALLEL_TOOLS
    check("no shipped parallel tool dropped out", not lost, str(sorted(lost)))
    gained = runner._PARALLEL_TOOLS - SHIPPED_NINE
    print(f"     newly parallel ({len(gained)}): {sorted(gained)}")
    check("the derivation actually widened the set", bool(gained))


# ── 3. the known liar ────────────────────────────────────────────────────

def test_check_coding_session():
    print("3. check_coding_session writes, and no longer claims otherwise")
    spec = BUILTIN_TOOLS["check_coding_session"]
    check("it is not declared read-only", not spec.get("reads_only"))
    check("it cannot batch",
          "check_coding_session" not in runner._PARALLEL_TOOLS)
    check("its description no longer says 'read-only'",
          "read-only" not in spec["description"].lower(),
          spec["description"][:80])
    # and the thing that makes it a writer is still there, so this test is
    # about a real hazard rather than a historical one
    from app import coder
    check("coder.refresh still persists broker state (the reason)",
          "_update" in coder.refresh.__code__.co_names
          or any("_update" in n for n in coder.refresh.__code__.co_names))


# ── 4. the containment fence still holds mid-batch ───────────────────────

def test_fence():
    print("4. no batch member can be refused while the batch runs")
    # search_memory / read_memory_item / list_memory set ctx['untrusted_context']
    # INSIDE their executor, i.e. while siblings are already in flight — so a
    # concurrent sibling is NOT fenced by that taint. This is safe only
    # because the fence refuses `is_actor` calls and no batch member is one.
    # Asserted rather than assumed: if it ever stops being true, the taint
    # becomes a live race and this is what says so.
    actors = {n for n in runner._PARALLEL_TOOLS if tool_registry.is_actor(n)}
    check("no parallel-safe tool is an actor", not actors, str(sorted(actors)))
    check("no parallel-safe tool sits behind a goal",
          not (runner._PARALLEL_TOOLS & scopes.GOAL_SCOPED_TOOLS),
          str(sorted(runner._PARALLEL_TOOLS & scopes.GOAL_SCOPED_TOOLS)))
    check("no parallel-safe tool is refused outright in an eval replay",
          not (runner._PARALLEL_TOOLS & fixtures.NEVER_EXECUTE),
          str(sorted(runner._PARALLEL_TOOLS & fixtures.NEVER_EXECUTE)))


# ── 5. caps ──────────────────────────────────────────────────────────────

def test_caps():
    print("5. every cap names a tool that can batch, and the semaphore binds")
    dead = set(runner._TOOL_CONCURRENCY_CAPS) - runner._PARALLEL_TOOLS
    check("no cap on a tool that never batches", not dead, str(sorted(dead)))
    check("web_search stays at the measured 2",
          runner._TOOL_CONCURRENCY_CAPS.get("web_search") == 2)
    check("fetch_url stays uncapped",
          "fetch_url" not in runner._TOOL_CONCURRENCY_CAPS)
    for n in ("list_models", "list_stale_topics", "service_status",
              "list_workloads", "memory_usage_report"):
        check(f"{n} is capped at 1",
              runner._TOOL_CONCURRENCY_CAPS.get(n) == 1)

    # OBSERVED, not inferred from the dict: three concurrent calls to a cap-1
    # tool must never overlap in real time.
    peak = {"now": 0, "max": 0}

    async def fake_execute(name, args, ctx):
        peak["now"] += 1
        peak["max"] = max(peak["max"], peak["now"])
        await asyncio.sleep(0.05)
        peak["now"] -= 1
        return "ok"

    async def go():
        real = tool_registry.execute_tool
        tool_registry.execute_tool = fake_execute
        try:
            batch = [({"id": f"c{i}", "name": "service_status"}, {})
                     for i in range(3)]
            results: dict[str, str] = {}
            async for _ev in runner._run_tools_parallel(
                    batch, {}, "main", 3, results):
                pass
            return results
        finally:
            tool_registry.execute_tool = real

    results = asyncio.run(go())
    check("a cap-1 tool never overlaps itself", peak["max"] == 1, str(peak["max"]))
    check("every tool_call id still got a result", len(results) == 3,
          str(sorted(results)))


# ── 6. the batching rule ─────────────────────────────────────────────────

def test_batching_rule():
    print("6. runs are consecutive; malformed and mutating calls end them")

    def entry(name, malformed=False):
        return ({"id": name, "name": name}, {}, malformed)

    check("a well-formed read batches",
          runner._is_parallel_safe(entry("search_memory")))
    check("a malformed read never batches",
          not runner._is_parallel_safe(entry("search_memory", malformed=True)))
    check("a write never batches",
          not runner._is_parallel_safe(entry("write_memory")))
    check("an excluded read never batches",
          not runner._is_parallel_safe(entry("diagnose")))
    check("a newly-derived read does batch",
          runner._is_parallel_safe(entry("list_goals")))

    # The run must not span a mutating call — that is what keeps the model's
    # create-then-append sequences in the order it asked for.
    parsed = [entry("search_memory"), entry("write_memory"), entry("list_goals")]
    runs, i = [], 0
    while i < len(parsed):
        if runner._is_parallel_safe(parsed[i]):
            j = i
            while j < len(parsed) and runner._is_parallel_safe(parsed[j]):
                j += 1
            runs.append((i, j))
            i = j
        else:
            i += 1
    check("a mutating call splits the run", runs == [(0, 1), (2, 3)], str(runs))


# ── 7. THE INVARIANT: no read-only builtin reaches a write ───────────────
#
# A static reach scan from each read-only tool's executor through app/*,
# looking for the leaves the human audit looked for: write SQL in a string
# literal, a background-task spawn, a filesystem write, a non-GET HTTP verb.
#
# Deliberately OVER-INCLUSIVE — cross-module name resolution here is
# approximate — and _LEDGER is the review record that absorbs the false
# positives. Every entry carries WHY it is allowed. An unledgered hit fails
# this suite, which is the whole point: the day someone declares a tool
# read-only and it can reach a write, this refuses.

_APP = pathlib.Path("/app/backend/app")
# Trailing \b on TRUNCATE is not cosmetic: without it the word "truncated" in
# an ordinary error string ("stored value is truncated or empty",
# secret_store.py:214) reads as a TRUNCATE statement, and the ledger fills up
# with entries excusing writes that do not exist. A ledger of imaginary writes
# is how a real one gets waved through.
_WRITE_SQL = re.compile(
    r"\b(INSERT\s+INTO|UPDATE\s+[\"\w]|DELETE\s+FROM|TRUNCATE\b|"
    r"CREATE\s+(TABLE|INDEX)|DROP\s+|ALTER\s+)", re.IGNORECASE)
_WRITE_CALLS = {"spawn",                                     # bg.spawn
                "write_text", "write_bytes", "mkdir", "unlink", "rmtree",
                "post", "put", "patch"}                      # httpx verbs

# "module.function:leaf" -> why this write is allowed on a read-only path.
#
# ONE PATH, four leaves. `diagnose` -> `diagnostics.report` ->
# `registry.degraded_grants` -> `_load_mcp_tools` -> `bg.spawn(_bg())` ->
# `mcp_servers.refresh`, which reconnects each stale server (a POST) and
# writes what it learns, resolving the server's credentials on the way (which
# stamps `last_used_at`).
#
# Allowed because `diagnose` cannot CAUSE it. The spawn is TTL-gated (15 min
# default) and in-flight-deduped, and `get_agent_tools` calls the same
# `_load_mcp_tools` while building the toolset for EVERY turn — before any
# tool runs. Verified the trigger conditions are nested, not merely similar:
# `degraded_grants` loads MCP tools only when some allowed_tools entry starts
# with "mcp:" (registry.py:254), which is a strict subset of
# `get_agent_tools`'s condition that allowed_tools is not None
# (registry.py:300-303). Any turn where diagnose would trigger a refresh has
# already triggered it.
#
# This is the one entry, and it is a real write behind a real argument. If a
# second one ever appears here, read it with suspicion — the honest fix for a
# tool that writes is to take its `reads_only` away, as check_coding_session's
# was.
_REFRESH_PATH = ("on the TTL-gated MCP refresh spawned by _load_mcp_tools, "
                 "which get_agent_tools already takes every turn before any "
                 "tool runs — diagnose cannot cause a refresh the turn did "
                 "not already cause")
_LEDGER = {
    "tools.registry._load_mcp_tools:spawn": _REFRESH_PATH,
    "mcp_servers.refresh:SQL": _REFRESH_PATH,
    "mcp_client._stdio_connect_and_list:post": _REFRESH_PATH,
    "secret_store.resolve:SQL": _REFRESH_PATH + " (stamps last_used_at)",
}


def _index():
    mods, imports = {}, {}
    for p in sorted(_APP.rglob("*.py")):
        name = str(p.relative_to(_APP).with_suffix("")).replace("/", ".")
        try:
            tree = ast.parse(p.read_text())
        except (SyntaxError, UnicodeDecodeError):
            continue
        mods[name], imports[name] = {}, {}
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                mods[name][node.name] = node
            elif isinstance(node, ast.ImportFrom) and (node.module or "").startswith("app"):
                for a in node.names:
                    mod = (node.module or "")[len("app."):] if node.module != "app" else ""
                    imports[name][a.asname or a.name] = (
                        f"{mod}.{a.name}" if mod else a.name)
            elif isinstance(node, ast.Import):
                for a in node.names:
                    if a.name.startswith("app."):
                        imports[name][a.asname or a.name.split(".")[-1]] = \
                            a.name[len("app."):]
    return mods, imports


_MODS, _IMPORTS = _index()


def _docstring_nodes(fn) -> set[int]:
    """id()s of the string constants that are DOCSTRINGS, anywhere inside fn.

    Both defects this fixes were found by the control in 7b failing rather
    than by review. Without it, `goals.active` — whose docstring explains at
    length that its housekeeping UPDATE was DELETED — was reported as
    containing an UPDATE. A scanner that reads prose about writes as writes
    trains you to ledger real ones away.
    """
    out = set()
    for node in ast.walk(fn):
        body = getattr(node, "body", None)
        if isinstance(body, list) and body:
            first = body[0]
            if (isinstance(first, ast.Expr)
                    and isinstance(first.value, ast.Constant)
                    and isinstance(first.value.value, str)):
                out.add(id(first.value))
    return out


def _module_of(mod: str, name: str):
    """Resolve a bare name used as `name.attr(...)` to a module we indexed.

    Handles the two shapes this codebase uses: `from app import goals` (the
    name IS the module) and `from app.memory.memory import memory` (the name
    is an OBJECT living in a module). The second is why the 7b control
    failed at first — `write_memory` calls `memory.write(...)` on a singleton,
    so a module-only resolver walked straight past the entire memory store
    and reported it write-free.
    """
    target = _IMPORTS.get(mod, {}).get(name)
    if not target:
        return None
    if target in _MODS:
        return target
    parent = target.rsplit(".", 1)[0]
    return parent if parent in _MODS else None


def _neighbours(mod: str) -> list[str]:
    """Modules this one imports, plus itself.

    The fallback target for a call whose receiver we cannot type —
    `self.store.write(...)`, `self.index.search(...)`. Without it the walk
    stopped at the first instance attribute, which is most of the memory
    store: `memory.write` reaches its SQL and its file writes only through
    `self.store`, so the control in 7b came back clean on a tool whose entire
    job is writing. Over-inclusive on purpose — the ledger absorbs the false
    positives, and a scan that under-reports is worse than one that nags.
    """
    out = {mod}
    for target in _IMPORTS.get(mod, {}).values():
        if target in _MODS:
            out.add(target)
        else:
            parent = target.rsplit(".", 1)[0]
            if parent in _MODS:
                out.add(parent)
    return sorted(out)


def _reaches(fn_name: str) -> set[str]:
    """Write-shaped leaves reachable from tools.builtin.<fn_name>."""
    hits: set[str] = set()
    seen: set[tuple] = set()

    def walk(mod, fn, depth):
        key = (mod, fn)
        if key in seen or depth > 10 or fn not in _MODS.get(mod, {}):
            return
        seen.add(key)
        node = _MODS[mod][fn]
        docs = _docstring_nodes(node)
        for sub in ast.walk(node):
            if (isinstance(sub, ast.Constant) and isinstance(sub.value, str)
                    and id(sub) not in docs):
                if _WRITE_SQL.search(sub.value):
                    hits.add(f"{mod}.{fn}:SQL")
            if not isinstance(sub, ast.Call):
                continue
            f = sub.func
            if isinstance(f, ast.Attribute):
                attr = f.attr
            elif isinstance(f, ast.Name):
                attr = f.id
            else:
                continue
            if attr in _WRITE_CALLS:
                hits.add(f"{mod}.{fn}:{attr}")
            if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name):
                target = _module_of(mod, f.value.id)
                if target:
                    walk(target, attr, depth + 1)
                # A BARE NAME THAT IS NOT AN IMPORT IS A LOCAL, and a local
                # can be anything. Guessing here is what made `_cache.update(…)`
                # — a dict method — resolve to `llm.providers.update` and
                # `curated_models.update`, and report list_models as reaching
                # two SQL writes it cannot reach. Locals stop the walk.
                continue
            if isinstance(f, ast.Name) and attr in _MODS.get(mod, {}):
                walk(mod, attr, depth + 1)
                continue
            # An ATTRIBUTE receiver (`self.store.write`, `self.index.search`)
            # is the shape the fallback exists for: we cannot type it, but it
            # is a structural member rather than a scratch variable, so
            # over-reaching into the modules in scope is the safe direction.
            if isinstance(f, ast.Attribute):
                for cand in _neighbours(mod):
                    if attr in _MODS.get(cand, {}):
                        walk(cand, attr, depth + 1)

    walk("tools.builtin", fn_name, 0)
    return hits


def test_no_hidden_writes():
    print("7. INVARIANT — no read-only builtin reaches a write")
    live: set[str] = set()
    for tool in sorted(READS_ONLY):
        hits = _reaches(BUILTIN_TOOLS[tool]["execute"].__name__)
        live |= hits
        unledgered = {h for h in hits if h not in _LEDGER}
        check(f"{tool} reaches no unledgered write", not unledgered,
              str(sorted(unledgered)))
    stale = set(_LEDGER) - live
    check("no stale ledger entries (an excuse for a write that is gone)",
          not stale, str(sorted(stale)))


def test_scanner_control():
    print("7b. the scanner is wired to something")
    # If a known writer comes back clean, §7's greens prove nothing.
    for writer in ("write_memory", "check_coding_session"):
        hits = _reaches(BUILTIN_TOOLS[writer]["execute"].__name__)
        check(f"{writer} trips the write scan", bool(hits),
              str(sorted(hits))[:120])


def main() -> int:
    test_derivation()
    test_no_regression()
    test_check_coding_session()
    test_fence()
    test_caps()
    test_batching_rule()
    test_no_hidden_writes()
    test_scanner_control()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:6]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
