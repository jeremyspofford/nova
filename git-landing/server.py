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
# Running as the operator's uid (see docker-compose) means $HOME may not exist
# in this image, and `git config --global` needs somewhere to write. /tmp is
# per-container and disposable, which is exactly right for a trust setting
# that has to be re-applied on every start anyway.
os.environ.setdefault("HOME", "/tmp")
os.environ.setdefault("GIT_CONFIG_GLOBAL", "/tmp/.gitconfig")
PORT = int(os.environ.get("PORT", "9912"))

# `nova/` prefixed, lowercase, no traversal, no refspec punctuation. The
# prefix is not decoration: it makes every branch this container can create
# identifiable as machine-authored at a glance in `git branch`.
_BRANCH_OK = re.compile(r"^nova/[a-z0-9][a-z0-9._-]{0,60}$")

_lock = threading.Lock()


def _serve_repo_readonly() -> None:
    """Serve the operator's repo, read-only, on the compose network.

    THE BLOCKER THIS FIXES, found by running phase 4 end to end. The coding
    agent's workspace pointed at `https://github.com/jeremyspofford/nova.git`,
    so it cloned GITHUB — while Jeremy's actual repository was three commits
    ahead and unpushed. Asked to edit a file created that day, the agent got a
    clone that did not contain it, changed nothing, and finished `done` with
    no commit. That is the worst shape a failure can take: it looks like
    success.

    So she clones from HERE, and "her code is written against his real HEAD"
    becomes true by construction rather than by remembering to push.

    READ-ONLY, and not by convention. `git daemon` does not enable
    `receive-pack` unless told to, and it is not told to — nothing can push
    into his repository through this port. Landing still goes through `/land`,
    which creates a branch and applies a patch under the refusals above.

    Bound to the compose network only: the service publishes no ports, exactly
    like `inference-control`. `--export-all` because the alternative is a
    marker file inside his `.git`, and writing into `.git` to enable a
    read-only feature is the wrong trade.
    """
    import socket
    import time
    try:
        proc = subprocess.Popen(
            # NO --base-path. With one, a client asking for `/repo` resolves
            # to `//repo` and the daemon answers "no such repository" — and
            # the doubled slash also defeats the `safe.directory` entry for
            # the exact path. Without it the client path is used as given and
            # matches the whitelist argument below, which is the only
            # repository this daemon will ever serve.
            ["git", "daemon", "--reuseaddr", "--export-all",
             "--informative-errors", REPO],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except Exception as e:                       # noqa: BLE001
        log.warning("could not start git daemon (non-fatal): %s", e)
        return

    # VERIFY IT IS LISTENING before saying so. Popen succeeds whenever the
    # BINARY runs, and `git daemon` is a separate alpine package — without it
    # git exits immediately with "not a git command" while this function
    # logged "serving read-only on :9418". A startup line that reports success
    # it did not check is the same defect this codebase keeps finding in the
    # model, and it is no more acceptable here.
    for _ in range(20):
        if proc.poll() is not None:
            err = (proc.stderr.read() or b"").decode()[-200:].strip()
            log.warning("git daemon exited immediately (non-fatal): %s", err)
            return
        try:
            with socket.create_connection(("127.0.0.1", 9418), timeout=0.5):
                log.info("git daemon serving %s read-only on :9418", REPO)
                return
        except OSError:
            time.sleep(0.25)
    log.warning("git daemon did not start listening on :9418 (non-fatal)")


def _trust_repo() -> None:
    """Tell git this bind-mounted repo is safe to operate on.

    Git refuses a repository owned by a different uid ("dubious ownership"),
    which is always true across a bind mount: the files are the operator's and
    this container is not. The check exists to stop a user being tricked into
    running hooks from someone else's repo — it is not a boundary this
    container relies on, because the boundary here is that only ONE directory
    is mounted and only three verbs exist.
    """
    for path in (REPO, "*"):
        # `*` as well as the exact path, because `git daemon` resolves the
        # same repository under a different string (`--base-path=/` plus
        # `/repo` gives `//repo/.git`) and refuses it again. Enumerating the
        # spellings would be a list that breaks the next time a path is
        # composed differently.
        #
        # Safe HERE and nowhere else: this container mounts exactly one
        # directory and its whole API is three verbs over the compose network.
        # The boundary is what is reachable, not which paths git will consent
        # to read.
        subprocess.run(["git", "config", "--global", "--add",
                        "safe.directory", path],
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


def _worktree(branch: str, remove: bool = False) -> dict:
    """Check a `nova/<slug>` branch out into `.worktrees/sandbox-<slug>`.

    The sandbox's first step. A worktree rather than a second clone because it
    shares the object store — a checkout is seconds and a few hundred KB
    instead of a full copy of history — and INSIDE the repo under
    `.worktrees/`, which is this project's own stated policy and is
    gitignored.

    Note what this does NOT do: run anything. Creating the tree and running a
    stack from it are separate capabilities in separate containers, because
    this one holds repository write access and the other holds the docker
    socket. Neither should hold both.
    """
    if not _BRANCH_OK.match(branch or ""):
        return {"status": "error",
                "detail": f"branch {branch!r} must look like nova/<name>"}
    slug = branch.split("/", 1)[1]
    path = f"{REPO}/.worktrees/sandbox-{slug}"
    with _lock:
        if remove:
            _git("worktree", "remove", "--force", path, check=False)
            _git("worktree", "prune", check=False)
            return {"status": "ok", "removed": path}
        try:
            _git("rev-parse", "--verify", branch)
        except RuntimeError:
            return {"status": "error", "detail": f"no such branch: {branch}"}
        # Idempotent: a leftover tree from a previous run is replaced rather
        # than failing the whole check, because a sandbox that cannot start
        # because of its own debris is worse than no sandbox.
        _git("worktree", "remove", "--force", path, check=False)
        _git("worktree", "prune", check=False)
        try:
            _git("worktree", "add", "--detach", path, branch)
        except RuntimeError as e:
            return {"status": "error", "detail": f"could not create worktree: {e}"}
        head = _git("rev-parse", "--short", "HEAD", cwd=path).strip()
        # THE SANDBOX OVERRIDE, written here because this is the container
        # with repository write access — the one that runs the stack mounts
        # the repo read-only and got EROFS trying to produce it, which is the
        # split doing its job.
        #
        # Only PORTS need overriding, and why the rest does not is the
        # interesting part: compose resolves `./data/...` against the project
        # directory, which is this worktree, and a worktree contains no
        # `data/` (it is gitignored). So every data bind lands in a fresh
        # empty directory beside the candidate code and the sandbox gets its
        # own memory, attachments and workspace by construction. Volumes are
        # namespaced by `-p nova-sandbox` for the same reason.
        #
        # Published ports are the one thing that cannot isolate itself: they
        # are host-global, so the sandbox postgres collided with the live one
        # on 127.0.0.1:5432 and the whole stack refused to start. Nothing
        # outside needs to reach a sandbox — its suite runs inside it — so the
        # correct number of published ports is zero.
        try:
            with open(f"{path}/docker-compose.sandbox.yml", "w") as f:
                f.write(
                    "# Generated for the sandbox boot gate. Disposable: it\n"
                    "# lives in a worktree that is removed with the run.\n"
                    "services:\n"
                    "  postgres:\n    ports: !reset []\n"
                    # `web` publishes 127.0.0.1:8080 and would collide with
                    # the live one exactly as postgres collided on 5432. The
                    # e2e browser reaches it over the sandbox's OWN compose
                    # network by alias, so nothing needs a host port.
                    "  web:\n    ports: !reset []\n"
                    "  backend:\n"
                    "    ports: !reset []\n"
                    "    environment:\n"
                    # THE STACK DECLARES ITSELF. Some suites are about the
                    # LIVE install — that the operator's real agent grants
                    # still match a snapshot, that a sidecar answers — and
                    # against a fresh database with no sidecars they fail for
                    # reasons that have nothing to do with the branch being
                    # tested. A failure that does not mean "your change is
                    # wrong" trains everyone to ignore the gate.
                    #
                    # So the environment says where it is and those suites
                    # SKIP, visibly and counted separately. Skipping is not
                    # hiding: `run_all` prints what was skipped and why, and
                    # the same suites still run in production where their
                    # question is meaningful.
                    '      NOVA_SANDBOX: "1"\n'
                    # Chat tests write real turns into a real journal, so they
                    # are opt-in — see e2e/test_chat_turn.py. The sandbox is
                    # the one place they should ALWAYS run: its database is
                    # thrown away with the stack, so there is no record of his
                    # to pollute. (The reply half still skips there: no model
                    # credential, by design.)
                    '  e2e:\n    environment:\n      NOVA_E2E_CHAT: "1"\n')
        except OSError as e:
            return {"status": "error",
                    "detail": f"could not write the sandbox override: {e}"}
    log.info("worktree %s -> %s (%s)", branch, path, head)
    return {"status": "ok", "path": path, "branch": branch, "head": head,
            "slug": slug}


def _drop_branch(branch: str) -> dict:
    """Delete a `nova/<slug>` branch. Only ever one this container made.

    Exists for the scratch branches the boot gate stages — "main plus her
    patch" has to be produced to be tested, and a red check must not leave a
    branch behind for the operator to find later and wonder about.

    The same `_BRANCH_OK` pattern guards it, so `main` is not deletable here
    any more than it is landable. Refuses the CURRENT branch outright: git
    would refuse anyway, and a clear sentence beats git's.
    """
    if not _BRANCH_OK.match(branch or ""):
        return {"status": "error",
                "detail": f"branch {branch!r} must look like nova/<name>"}
    with _lock:
        st = _status()
        if st.get("branch") == branch:
            return {"status": "error",
                    "detail": f"{branch} is checked out; not deleting it"}
        _git("branch", "-D", branch, check=False)
    return {"status": "ok", "deleted": branch}


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
        if self.path not in ("/land", "/worktree", "/worktree/remove",
                             "/branch/remove"):
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:                   # noqa: BLE001
            return self._send(400, {"error": f"unreadable body: {e}"})
        if self.path == "/land":
            out = _land(str(body.get("patch") or ""),
                        str(body.get("branch") or ""),
                        str(body.get("base") or ""))
        elif self.path == "/branch/remove":
            out = _drop_branch(str(body.get("branch") or ""))
        else:
            out = _worktree(str(body.get("branch") or ""),
                            remove=self.path.endswith("/remove"))
        return self._send(200 if out.get("status") == "ok" else 409, out)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    _trust_repo()
    _serve_repo_readonly()
    log.info("git-landing on :%d for %s", PORT, REPO)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
