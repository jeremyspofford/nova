"""A proposed change to Nova's own source, checked for the things that are
checkable here.

Phase 6a of `docs/plans/capability-acquisition.md`. The `maintainer` agent can
read the repository (phase 1); this is how a change it wants to make reaches
the operator — as a unified diff on a recommendation card, applied by nobody.

WHAT THIS DELIBERATELY DOES NOT DO, because it cannot do it honestly. It does
not tell you whether the patch APPLIES, COMPILES or PASSES TESTS. Those need a
complete, writable checkout, and the backend has neither: only `/app/backend`
and `/app/data` are mounted (no frontend, no repo root, no `.git`), and neither
`git` nor `patch` is in the image. A grader built against that would score
backend Python and silently ignore everything else — worse than no grader,
because a partial pass reads as a pass. The real one belongs with the private
clone that the ACP coding lane creates, and it will reuse the parse below.

So the checks here are the ones a read-only view genuinely supports:

  * it is a well-formed unified diff, not prose that looks like one
  * every file it claims to change EXISTS — the cheapest catch for a patch
    written against a remembered file rather than a read one, which is the
    likeliest failure for a model working from a 16k window
  * it is small enough for a human to review in one sitting

Everything else WAS the operator's eye. Phase 6b (2026-07-31) closed that:
`grade()` below hands the diff to the coder sidecar, which has a writable
clone, git and the test runners, and answers the three questions this module
cannot. The checkout moved rather than the check. A card with no grade still
says so plainly — an absent grade must never read like a clean one.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Optional

import httpx

from app import db
from app.config import settings

log = logging.getLogger(__name__)

# Where the backend can actually see the tree. Paths in a diff are
# repo-relative (`backend/app/foo.py`), and only the backend subtree is
# mounted, so anything outside it can be named but not confirmed.
_SOURCE_ROOT = "/app"
_VISIBLE_PREFIX = "backend/"

# A review that does not fit in one sitting does not happen. These are review
# ergonomics, not security — the security is that nothing applies this.
MAX_FILES = 8
MAX_LINES = 400

_FILE_RE = re.compile(r"^\+\+\+ (?:b/)?(\S+)", re.M)
_MINUS_RE = re.compile(r"^--- (?:a/)?(\S+)", re.M)
_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@", re.M)


def parse(diff: str) -> dict:
    """Structure of a unified diff, or why it is not one."""
    if not diff or not diff.strip():
        return {"ok": False, "detail": "the diff is empty"}
    targets = _FILE_RE.findall(diff)
    hunks = _HUNK_RE.findall(diff)
    if not targets or not _MINUS_RE.findall(diff):
        return {"ok": False,
                "detail": ("this is not a unified diff — it needs `--- a/path` "
                           "and `+++ b/path` headers. Produce it in the form "
                           "`git diff` emits.")}
    if not hunks:
        return {"ok": False,
                "detail": "no @@ hunk headers, so there is nothing to apply"}
    added = sum(1 for ln in diff.splitlines()
                if ln.startswith("+") and not ln.startswith("+++"))
    removed = sum(1 for ln in diff.splitlines()
                  if ln.startswith("-") and not ln.startswith("---"))
    return {"ok": True, "files": [t for t in targets if t != "/dev/null"],
            "hunks": len(hunks), "added": added, "removed": removed}


def review(diff: str) -> dict:
    """Everything checkable from here. Never claims the patch works."""
    parsed = parse(diff)
    if not parsed["ok"]:
        return {"status": "error", "detail": parsed["detail"]}

    files = parsed["files"]
    if len(files) > MAX_FILES:
        return {"status": "error",
                "detail": (f"{len(files)} files is too many to review in one "
                           f"go (limit {MAX_FILES}). Split it into changes "
                           f"that each stand alone.")}
    if parsed["added"] + parsed["removed"] > MAX_LINES:
        return {"status": "error",
                "detail": (f"{parsed['added'] + parsed['removed']} changed "
                           f"lines is past the {MAX_LINES}-line review limit. "
                           f"Propose the smallest change that is worth making.")}

    missing, unverifiable = [], []
    for path in files:
        if not path.startswith(_VISIBLE_PREFIX):
            # named but outside the mount — say so rather than pretend
            unverifiable.append(path)
            continue
        if not os.path.exists(os.path.join(_SOURCE_ROOT, path)):
            missing.append(path)
    if missing:
        return {"status": "error",
                "detail": ("these files do not exist: " + ", ".join(missing)
                           + ". Read the file before patching it — a diff "
                             "written from memory patches a file that is not "
                             "there.")}
    return {"status": "ok", "files": files, "hunks": parsed["hunks"],
            "added": parsed["added"], "removed": parsed["removed"],
            "unverified_paths": unverifiable}


def summary(result: dict, rationale: str) -> str:
    """The card body. States plainly what was NOT checked, because a review
    that implies more verification than it did is worse than none."""
    lines = [rationale.strip(), ""]
    lines.append(f"Touches {len(result['files'])} file(s), "
                 f"+{result['added']}/-{result['removed']} lines "
                 f"across {result['hunks']} hunk(s):")
    lines += [f"  {f}" for f in result["files"]]
    if result.get("unverified_paths"):
        lines.append("")
        lines.append("Outside the backend mount, so their existence could NOT "
                     "be confirmed: " + ", ".join(result["unverified_paths"]))
    lines.append("")
    lines.append("NOT CHECKED: whether this applies cleanly, compiles, or "
                 "passes tests — there is no writable checkout to try it in. "
                 "Nothing has been applied.")
    return "\n".join(lines)


# --- phase 6b: the mechanical grade ----------------------------------------

async def grade(diff: str, workspace: str = "nova",
                test_cmd: str = "") -> Optional[dict]:
    """Ask the coder sidecar whether this patch applies, compiles and passes.

    The three questions `review()` above says it cannot answer. It could not
    because the backend mounts only `/app/backend` and `/app/data` and has
    neither `git` nor `patch`; the coder sidecar has a writable clone, git,
    and the test runners, so the answer moves there rather than the checkout
    moving here.

    Returns None when delegation is not configured, and the CALLER must treat
    that as "not graded" rather than as a pass — which is why this returns
    None instead of an optimistic empty dict.
    """
    from app import coder
    if not coder.configured():
        return None
    async with db.acquire() as conn:
        ws = await conn.fetchrow(
            "SELECT git_url FROM workspaces WHERE name = $1 AND enabled",
            workspace)
    if not ws:
        return None
    try:
        async with httpx.AsyncClient(timeout=420.0) as client:
            resp = await client.post(
                f"{settings.coder_url}/grade", headers=coder._auth(),
                json={"repo": ws["git_url"], "patch": diff,
                      "test_cmd": test_cmd})
        if resp.status_code >= 400:
            return None
        return resp.json()
    except Exception:                                        # noqa: BLE001
        log.exception("patch grading failed")
        return None


def grade_summary(g: Optional[dict]) -> str:
    """The grade, in the operator's words, or an honest absence.

    A missing grade must never read like a clean one — that is the whole
    failure mode phase 6b was designed around, so the not-graded string says
    so in the same place a grade would have appeared.
    """
    if not g:
        return ("NOT MECHANICALLY GRADED — the coder sidecar is not running, "
                "so whether this applies, compiles or passes tests is "
                "unverified. Nothing has been applied.")
    lines = [f"MECHANICAL GRADE: {g.get('verdict', '?').upper()} — "
             f"{g.get('summary', '')}"]
    for name, st in (g.get("stages") or {}).items():
        detail = (st.get("detail") or "").strip().replace("\n", " ")
        lines.append(f"  {name}: {st.get('result')}"
                     + (f" — {detail[:160]}" if detail else ""))
    lines.append("Nothing has been applied; the operator decides.")
    return "\n".join(lines)
