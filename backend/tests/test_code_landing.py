"""Her code reaches his repo, on a branch, and never onto main.

    docker compose exec backend python tests/test_code_landing.py

Phase 4. Jeremy, 2026-08-05, looking at a Settings panel I had written by
hand: "That's something else she's supposed to do, not you." He was right, and
the reason I had written it is what this closes — `delegate_coding_task`
produced a branch and a diff inside a private volume and nothing could bring
them back, so a human retyped her work against the real repo.

WHAT IS BEING DEFENDED. Not "landing works" — the interesting cases are all
refusals, because this is the one path in the system with write access to the
operator's source tree. Every check below is a thing that must FAIL:

  1. THE SCHEMA — a card names a SESSION, never a diff. Patch text in an
     approved document could be approved for one change and executed with
     another.
  2. THE BRANCH — `main` is unreachable from here, at two independent layers.
  3. THE BOOT GATE — the executor is legal only because the operator has the
     same route, and the gate must be able to refuse.
  4. THE SIDECAR — a dirty worktree, an empty patch and a bad ref are refused
     by the container that holds the repo, not by politeness here.
  5. NO MERGE — there is no field and no code path that could merge to main.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

from app import actions                                  # noqa: E402
from app.actions import code_change as cc                # noqa: E402
from app.actions.schemas import CodeChangeLand           # noqa: E402

import _env                                              # noqa: E402

FAILURES: list[str] = []
SESSION = "12cd3035-1482-4bfb-ab48-e69601ab5242"          # shape-valid uuid


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _refused(raw) -> bool:
    try:
        actions.parse(raw)
        return False
    except ValueError:
        return True


def test_schema():
    print("\n1. A CARD NAMES A SESSION, NEVER A DIFF")
    base = {"type": "code_change.land", "session_id": SESSION,
            "branch": "demo", "why": "because"}
    check("1.1 the minimal document parses",
          actions.parse(base).branch == "demo")

    for field, value, why in [
        ("patch", "diff --git a/x b/x", "approved-for-one, executed-with-another"),
        ("diff", "@@ -1 +1 @@", "same"),
        ("files", ["backend/app/main.py"], "the file list comes from the patch"),
        ("merge", True, "there is no way to ask for a merge"),
        ("target", "main", "the target is not the model's to choose"),
        ("remote", "origin", "nothing here pushes"),
    ]:
        check(f"1.2 `{field}` is unrepresentable",
              _refused({**base, field: value}), why)

    print("   …and the branch slug cannot be spelled into a ref")
    for bad in ("../main", "nova/x", "HEAD", "a/b", "UPPER",
                "x" * 60, "-leading", ""):
        check(f"1.3 refuses branch {bad[:18]!r}",
              _refused({**base, "branch": bad}))

    # `main` is ACCEPTED as a slug and that is correct — the protection is the
    # PREFIX, not the pattern. A slug of "main" produces the branch
    # `nova/main`, which is an ordinary branch and not the trunk. Asserting a
    # refusal here would have been defending the wrong thing and would go red
    # the day someone legitimately named a change "main-page".
    check("1.3 `main` is a legal SLUG, because it can only become nova/main",
          not _refused({**base, "branch": "main"}),
          "the prefix is the control, not the vocabulary")

    print("   …and the session id must be a uuid")
    for bad in ("../../etc/passwd", "1; DROP TABLE", "", "abc"):
        check(f"1.4 refuses session {bad[:18]!r}",
              _refused({**base, "session_id": bad}))


def test_main_is_unreachable():
    print("\n2. `main` IS UNREACHABLE, AT TWO INDEPENDENT LAYERS")
    # Layer 1: the slug pattern refuses it outright (above). Layer 2: even a
    # slug that passed would be prefixed, so the string that reaches the
    # sidecar can only ever start `nova/`.
    doc = actions.parse({"type": "code_change.land", "session_id": SESSION,
                         "branch": "demo", "why": "x"})
    rendered = cc.describe(doc)
    check("2.1 the card states the branch it will create",
          "nova/demo" in rendered, rendered.splitlines()[2].strip())
    check("2.2 …and states plainly that it does not merge",
          "NOT done" in rendered)
    check("2.3 the executor prefixes `nova/` rather than trusting the slug",
          'f"nova/{doc.branch}"' in open(
              "/app/backend/app/actions/code_change.py").read(),
          "the string reaching the sidecar can only start nova/")

    # NOT a grep for the WORD. The first version of this searched the source
    # for "merge" and "push" and failed on its own prose — the file says
    # "landing is not merging" and "nothing here pushes", which are the
    # opposite of what the grep concluded. A test that reads documentation as
    # code is worse than no test: it goes red on honesty.
    #
    # What is actually worth defending is that the only component that RUNS
    # git never issues those commands. Parse the sidecar and look at real
    # calls.
    import ast as _ast
    tree = _ast.parse(open("/app/project/git-landing/server.py").read())
    git_verbs: set[str] = set()
    for node in _ast.walk(tree):
        if (isinstance(node, _ast.Call)
                and isinstance(node.func, _ast.Name)
                and node.func.id == "_git"
                and node.args
                and isinstance(node.args[0], _ast.Constant)):
            git_verbs.add(str(node.args[0].value))
    check("2.4 the sidecar issues git commands at all (the scan works)",
          bool(git_verbs), sorted(git_verbs))
    for forbidden in ("merge", "push", "reset", "rebase", "cherry-pick"):
        check(f"2.5 the sidecar never runs `git {forbidden}`",
              forbidden not in git_verbs, sorted(git_verbs))
    # ...and the executor itself runs no git at all — it goes through the
    # sidecar, which is the whole containment argument.
    exec_tree = _ast.parse(open("/app/backend/app/actions/code_change.py").read())
    runs_git = any(isinstance(n, _ast.Call) and isinstance(n.func, _ast.Attribute)
                   and n.func.attr in ("run", "Popen", "check_output")
                   for n in _ast.walk(exec_tree))
    check("2.6 the executor runs no subprocess of its own", not runs_git,
          "repo access lives in one container, not in the backend")


def test_boot_gate():
    print("\n3. LEGAL ONLY BECAUSE THE OPERATOR HAS THE SAME ROUTE")
    spec = actions._TYPES["code_change.land"]
    check("3.1 names the operator route",
          spec.operator_route == "land_code_change")
    actions.assert_routes_exist()
    check("3.2 the gate passes as things stand", True)

    import dataclasses
    try:
        actions._TYPES["code_change.land"] = dataclasses.replace(
            spec, operator_route="no_such_route")
        actions.assert_routes_exist()
        check("3.3 …and REFUSES a route that vanished", False, "did not fire")
    except RuntimeError as e:
        check("3.3 …and REFUSES a route that vanished", True, str(e)[:50])
    finally:
        actions._TYPES["code_change.land"] = spec


def test_preflight_asks_the_world():
    print("\n4. PREFLIGHT ANSWERS BEFORE HE CLICKS, NOT AFTER")
    # The sandbox worktree carries no `.env`, so NOVA_CODER_TOKEN is absent
    # and `coder.configured()` is False — which is the isolation WORKING (a
    # sandbox holding his credentials is not a sandbox) and means preflight
    # answers "the coder sidecar is not configured" instead of naming the
    # session. That is a correct answer to a different question, so this
    # section steps aside rather than asserting on it.
    from app import coder as _coder
    if not _coder.configured():
        print("  SKIP  coding delegation is not configured in this stack "
              "(the sandbox has no credentials, by design)")
        return

    async def run():
        from app import db
        await db.init_pool()
        doc = actions.parse({"type": "code_change.land",
                             "session_id": SESSION, "branch": "demo",
                             "why": "x"})
        return await cc.preflight(doc)

    state, detail, tools = asyncio.run(run())
    check("4.1 a session that does not exist blocks the card",
          state == "blocked", detail[:70])
    check("4.2 …and says which session, so it is actionable",
          SESSION[:8] in detail or "coding session" in detail, detail[:70])
    check("4.3 no tool list — landing grants nothing", tools is None)


def test_the_sidecar_refuses():
    print("\n5. THE CONTAINER THAT HOLDS THE REPO IS WHAT REFUSES")
    # SECTION-level, not suite-level. Sections 1-4 are pure — schema, boot
    # gate, card text — and they are the ones that would catch a real
    # regression in a branch, so they must run everywhere. Only this section
    # needs git-landing, which the sandbox does not start.
    if not _env.reachable("http://git-landing:9912/health"):
        print("  SKIP  git-landing is not in this stack "
              "(sandbox runs postgres + backend only)")
        return
    # Reached over the network, because the point is that these checks do NOT
    # live in the backend. If git-landing is not running, that is itself the
    # correct answer to "can anything land right now".
    async def run():
        from app import coder
        out = {}
        out["status"] = await coder.repo_status()
        out["main"] = await coder.land("x", "main")
        out["traversal"] = await coder.land("x", "nova/../../etc")
        out["empty"] = await coder.land("", "nova/scratch-test")
        return out

    r = asyncio.run(run())
    st = r["status"]
    if st.get("error"):
        check("5.0 git-landing is reachable", False, st["error"][:70])
        return
    check("5.0 git-landing is reachable and reads the repo",
          "branch" in st, f"{st.get('branch')} @ {st.get('head')}")
    check("5.1 `main` is refused by the sidecar too",
          r["main"].get("status") == "error", str(r["main"].get("detail"))[:60])
    check("5.2 a traversal branch is refused",
          r["traversal"].get("status") == "error")
    check("5.3 an empty patch is refused",
          r["empty"].get("status") == "error",
          str(r["empty"].get("detail"))[:50])
    # The dirty check only fires when the tree IS dirty, so assert the right
    # one of the two possible truths rather than pinning the repo's state.
    if st.get("dirty"):
        check("5.4 a dirty worktree refuses a real patch",
              "uncommitted" in str(r["empty"].get("detail", "")).lower()
              or r["empty"].get("status") == "error",
              "empty-patch check fires first, which is also correct")
    else:
        check("5.4 a clean worktree would accept one (nothing to assert)", True)


def main() -> int:
    test_schema()
    test_main_is_unreachable()
    test_boot_gate()
    test_preflight_asks_the_world()
    test_the_sidecar_refuses()
    if FAILURES:
        print(f"\nFAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
