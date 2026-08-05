"""Applies an approved patch to the host repo. On a branch. Never on main.

Phase 4, and the reason it is its own container is the reason
`inference-control` is: the dangerous capability lives in ONE place with a
FIXED VERB LIST, rather than being handed to the backend where every other
code path could reach it.

The capability here is WRITE ACCESS TO THE OPERATOR'S REPOSITORY. The backend
deliberately does not have it — `/app/project` is mounted read-only — and it
must not gain it, because the backend is the process a poisoned web page
talks to. This container never runs a model, never takes an instruction from
one, and exposes exactly three verbs.

WHAT IT REFUSES, MECHANICALLY, AND WHY EACH ONE IS HERE

  * `main` is not a landing target, ever. Nova's code arrives on a branch and
    the operator merges it — that is the review, and a merge is a decision
    only he makes. `_BRANCH_OK` also refuses anything that is not a plain
    `nova/<slug>` name, so a branch cannot be spelled `../..` or `HEAD`.
  * It never pushes. There is no remote credential in this container.
  * It refuses a dirty worktree. Applying a patch on top of uncommitted work
    silently mixes her change with his, and the commit that results belongs to
    neither. He is told to stash or commit, which is a sentence he can act on.
  * It applies with `git am --3way` and ABORTS on conflict, leaving the repo
    exactly as it was. A half-applied patch on the operator's machine is the
    outcome with no recovery story.

The patch text arrives as a parameter and that is unavoidable — it is the
payload. Everything dangerous about it is bounded by the two facts above: it
lands on a fresh branch off the current HEAD, and a conflict rolls the whole
thing back.
"""

import json
import logging
import os
import re
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("git-landing")

REPO = os.environ.get("NOVA_REPO_DIR", "/repo")
PORT = int(os.environ.get("PORT", "9912"))

# `nova/` prefixed, lowercase, no traversal, no refspec punctuation. The
# prefix is not decoration: it makes every branch this container can create
# identifiable as machine-authored at a glance in `git branch`.
_BRANCH_OK = re.compile(r"^nova/[a-z0-9][a-z0-9._-]{0,60}$")

_lock = threading.Lock()


def _trust_repo() -> None:
    """Tell git this bind-mounted repo is safe to operate on.

    Git refuses a repository owned by a different uid ("dubious ownership"),
    which is always true across a bind mount: the files are the operator's and
    this container is not. The check exists to stop a user being tricked into
    running hooks from someone else's repo — it is not a boundary this
    container relies on, because the boundary here is that only ONE directory
    is mounted and only three verbs exist.
    """
    subprocess.run(["git", "config", "--global", "--add", "safe.directory", REPO],
                   capture_output=True, text=True, timeout=30)


def _git(*args, check=True, cwd=REPO) -> str:
    proc = subprocess.run(["git", *args], cwd=cwd, capture_output=True,
                          text=True, timeout=120)
    if check and proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout)[-400:].strip())
    return proc.stdout


def _status() -> dict:
    """What the repo looks like right now. Read-only."""
    try:
        branch = _git("rev-parse", "--abbrev-ref", "HEAD").strip()
        dirty = bool(_git("status", "--porcelain").strip())
        head = _git("rev-parse", "--short", "HEAD").strip()
        branches = [b.strip().lstrip("* ").strip()
                    for b in _git("branch", "--list", "nova/*").splitlines()
                    if b.strip()]
        return {"branch": branch, "head": head, "dirty": dirty,
                "nova_branches": branches, "repo": REPO}
    except Exception as e:                       # noqa: BLE001
        return {"error": str(e)[:300], "repo": REPO}


def _land(patch: str, branch: str, base: str = "") -> dict:
    """Create `branch` off HEAD and apply `patch` to it. Never touches main.

    Returns what happened, in the operator's terms. A failure leaves the repo
    on the branch it started on with nothing applied.
    """
    if not patch.strip():
        return {"status": "error", "detail": "the patch is empty"}
    if not _BRANCH_OK.match(branch or ""):
        return {"status": "error",
                "detail": (f"branch {branch!r} is not allowed — it must look "
                           f"like nova/<name>, lowercase, no slashes beyond "
                           f"the first")}

    with _lock:
        st = _status()
        if st.get("error"):
            return {"status": "error", "detail": st["error"]}
        if st["dirty"]:
            return {"status": "error",
                    "detail": ("the repository has uncommitted changes. "
                               "Landing on top of them would mix this change "
                               "with yours and the commit would belong to "
                               "neither — commit or stash first.")}
        started_on = st["branch"]
        if started_on == branch:
            return {"status": "error",
                    "detail": f"already on {branch}; nothing to do"}
        try:
            _git("checkout", "-b", branch, base or "HEAD")
        except RuntimeError as e:
            return {"status": "error", "detail": f"could not create {branch}: {e}"}

        patch_file = "/tmp/nova-landing.patch"
        with open(patch_file, "w") as f:
            f.write(patch if patch.endswith("\n") else patch + "\n")
        try:
            _git("am", "--3way", "--keep-cr", patch_file)
        except RuntimeError as e:
            # ABORT AND GO BACK. A half-applied patch on his machine is the
            # outcome with no recovery story, so a conflict is a clean no-op
            # plus a sentence saying so.
            _git("am", "--abort", check=False)
            _git("checkout", started_on, check=False)
            _git("branch", "-D", branch, check=False)
            return {"status": "error",
                    "detail": (f"the patch did not apply cleanly and nothing "
                               f"was changed — the repo is back on "
                               f"{started_on}. {e}")}
        head = _git("rev-parse", "--short", "HEAD").strip()
        files = _git("diff", "--name-only", f"{started_on}..{branch}").split()
        # Back to where he was. He asked for a branch, not a checkout switch
        # under his feet while he is working.
        _git("checkout", started_on, check=False)
        log.info("landed %s on %s (%s)", head, branch, ", ".join(files[:6]))
        return {"status": "ok", "branch": branch, "commit": head,
                "files": files, "returned_to": started_on,
                "detail": (f"applied to {branch} ({head}); your working copy "
                           f"is still on {started_on}. Review with "
                           f"`git diff {started_on}..{branch}` and merge when "
                           f"you are happy.")}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/status":
            return self._send(200, _status())
        if self.path == "/health":
            return self._send(200, {"ok": True, "repo": REPO})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/land":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:                   # noqa: BLE001
            return self._send(400, {"error": f"unreadable body: {e}"})
        out = _land(str(body.get("patch") or ""), str(body.get("branch") or ""),
                    str(body.get("base") or ""))
        return self._send(200 if out.get("status") == "ok" else 409, out)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    _trust_repo()
    log.info("git-landing on :%d for %s", PORT, REPO)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
