"""The gates manifest resolves to real code and real pinning tests.

    docker compose exec backend python tests/test_gates_manifest.py
    PYTHONPATH=backend python backend/tests/test_gates_manifest.py   (CI)

Slice 1 (2026-08-25, docs/DECISIONS.md): app/gates.py is an evidence-backed
INVENTORY of the mechanical enforcement points this build claims — not the
authorization mechanism, not a completeness proof. What this suite pins is
the inventory's integrity contract, per the approved amendments:

  1. Every manifest entry carries its required fields and a known status.
  2. Every entry's owner symbol imports, and every listed pinning-test path
     exists — a gate whose module or suite was renamed goes red HERE, the
     day it happens, instead of the manifest rotting into folklore.
  3. Every enforcement point has exactly one active/transitional entry.
  4. A retired/superseded entry must name superseded_by, a rationale, and a
     test pinning the replacement or preserved behavior — controls leave
     with a paper trail.

Deliberately NOT pinned: an entry-count ratchet. Gates may be consolidated
or intentionally retired as the canonical evaluator (TA-2) arrives; the
reviewable diff of app/gates.py is the control for that, not a number here.
"""

import sys

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def main() -> int:
    from app import gates

    print("gates manifest integrity:")

    check("manifest is non-empty", bool(gates.MANIFEST))

    problems = gates.verify()
    for p in problems:
        check(f"verify: {p}", False)
    check("verify() reports no discrepancies", not problems,
          f"{len(problems)} problem(s)" if problems else "")

    # The structural rules verify() enforces are themselves worth pinning:
    # a future edit that weakens verify() should fail here, not pass quietly.
    broken = [{"id": "x", "owner": "app.gates:nope", "property": "p",
               "enforcement_point": "e", "tests": ["tests/no_such_test.py"],
               "status": "retired", "evidence": "ev"}]
    real, gates.MANIFEST = gates.MANIFEST, broken
    try:
        found = gates.verify()
    finally:
        gates.MANIFEST = real
    check("verify() catches a dangling owner symbol",
          any("no symbol" in p for p in found))
    check("verify() catches a missing pinning test",
          any("does not exist" in p for p in found))
    check("verify() demands a paper trail for retired entries",
          any("superseded_by" in p for p in found)
          and any("rationale" in p for p in found))

    dupes = [dict(real[0], id="a"), dict(real[0], id="b")]
    real, gates.MANIFEST = gates.MANIFEST, dupes
    try:
        found = gates.verify()
    finally:
        gates.MANIFEST = real
    check("verify() refuses two live entries on one enforcement point",
          any("more than one" in p for p in found))

    # report() is advisory: whatever the manifest holds, it must not raise.
    broken2 = [{"id": "y"}]
    real, gates.MANIFEST = gates.MANIFEST, broken2
    try:
        gates.report()
        check("report() never raises, even on a broken manifest", True)
    except Exception as exc:   # noqa: BLE001
        check("report() never raises, even on a broken manifest", False,
              repr(exc))
    finally:
        gates.MANIFEST = real

    print(f"\n{'FAIL' if FAILURES else 'PASS'}: "
          f"{len(FAILURES)} failure(s)")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
