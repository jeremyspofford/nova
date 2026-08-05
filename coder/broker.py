"""coder — the ACP session broker (docs/plans/acp-coding-delegation.md, phase 1).

Nova is an ACP *client*: she drives an existing coding agent rather than
carrying a coding harness of her own. This process is the bridge. It spawns
`@agentclientprotocol/claude-agent-acp` as a subprocess, speaks JSON-RPC to it
over stdio, and exposes a narrow fixed HTTP API to the backend on the compose
network — the inference-control shape, where nothing that matters is
parameterized by the request.

WHY THE CONTAINER IS THE BOUNDARY, and not the protocol. The plan hoped ACP's
client-side filesystem mediation would let this broker "enforce worktree
confinement at the protocol level, not just the container level". Phase 0
measured it on 2026-07-31 and the hope did not survive:

  * asking permission is `MAY` in the spec, never `MUST`, and
    `session/request_permission` is not even in the agent baseline MUST list —
    an agent that never asks is fully compliant
  * an agent can move ITSELF into a non-asking mode and merely notify, with
    no client veto
  * declining the `fs` capability changed nothing: across every case the agent
    made zero `fs/*` calls and used its own in-process Read/Write/Edit/Bash,
    which reach the OS directly. `cwd` is not a boundary — in
    `bypassPermissions` the agent wrote outside it on the first try
  * ACP v2 (draft, 2026-07-20) deletes the client filesystem surface outright,
    collapsing the client method set from nine to two

So the agent's permission layer is a promise, and this codebase's rule is that
a promise is not a control. It is kept as real defence-in-depth — denial
genuinely prevented the write when measured — but the line that refuses when
the agent is wrong is this container: no host mounts, a private clone volume,
non-root, read-only root filesystem, dropped capabilities.

WHAT THIS PROCESS ENFORCES MECHANICALLY, rather than describing:

  1. `_ALLOWED_MODES`. Phase 0 escaped the workspace under `bypassPermissions`
     and stayed contained under `default` and `dontAsk`. So the escaping modes
     are refused HERE, at the spawn, on every request — not documented as
     unwise. `auto` is refused for a second reason: it is "use a model
     classifier to approve/deny permission prompts", which is an LLM
     adjudicating permissions, the exact shape refused everywhere else here.
  2. A shared secret. `NOVA_CODER_TOKEN` must match; unset means refuse
     everything, because a token that defaults to off is not a control. This
     is the lesson mcp-runner learned the hard way on 2026-07-31 — the
     allow-list guarded the registration route and the process that actually
     called exec checked nothing.
  3. A wall clock. Every session gets a deadline and is killed at it, because
     cancellation in ACP is cooperative and a cooperative stop is not a stop.

WHAT THIS PROCESS DOES NOT HOLD: NOVA_AUTH_TOKEN, the database URL, the Docker
socket, or any host mount. It holds one credential — the coding agent's own
model key — and nothing else. It has no published ports.
"""

from __future__ import annotations

import hmac
import logging
import os
import shutil
import subprocess
import threading
import time
import uuid

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from acp import AcpSession

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("coder")

app = FastAPI()

TOKEN = os.environ.get("NOVA_CODER_TOKEN", "")
WORKSPACES = os.environ.get("CODER_WORKSPACES", "/workspaces")
DEFAULT_BUDGET_S = int(os.environ.get("CODER_SESSION_BUDGET_S", "1800"))

# The two modes phase 0 measured as contained. Everything else is refused.
#
#   default   agent asks; we answer. Contained when we deny (measured).
#   dontAsk   deny unless pre-approved. Contained, and the mode that matches
#             the sandboxed-autonomous design.
#
# Refused, and why each is not a judgement call:
#   bypassPermissions  wrote outside the workspace on the first attempt
#   auto               an LLM classifier deciding permissions
#   acceptEdits        auto-accepts file edits without asking
#   plan               harmless, but produces no work; not a session shape
_ALLOWED_MODES = frozenset({"default", "dontAsk"})


def _authorized(header: str | None) -> bool:
    """Constant-time compare; an unset token refuses everything."""
    if not TOKEN:
        return False
    supplied = (header or "").removeprefix("Bearer ").strip()
    return bool(supplied) and hmac.compare_digest(supplied, TOKEN)


def _guard(authorization: str | None):
    if not TOKEN:
        raise HTTPException(503, "NOVA_CODER_TOKEN is not configured; "
                                 "this broker refuses every request until it is")
    if not _authorized(authorization):
        raise HTTPException(401, "bad or missing broker token")


class StartSession(BaseModel):
    repo: str                      # path or URL the broker clones FROM
    task: str                      # what the agent is asked to do
    branch: str = ""               # branch to create; derived when empty
    mode: str = "dontAsk"
    budget_s: int = 0


_sessions: dict[str, "Session"] = {}
_lock = threading.Lock()


class Session:
    """One coding task: a private clone, an agent subprocess, a deadline."""

    def __init__(self, spec: StartSession):
        self.id = str(uuid.uuid4())
        self.spec = spec
        self.state = "starting"
        self.error: str | None = None
        self.updates: list[dict] = []
        self.branch = spec.branch or f"nova/{self.id[:8]}"
        self.dir = os.path.join(WORKSPACES, self.id)
        self.budget_s = spec.budget_s or DEFAULT_BUDGET_S
        self.started = time.time()
        self.deadline = self.started + self.budget_s
        self.acp: AcpSession | None = None
        self.diffstat = ""
        self.commit = ""
        self.timed_out = False

    # -- lifecycle ---------------------------------------------------------
    #: States nothing may overwrite. A session an operator stopped must keep
    #: saying "killed": the worker thread unwinds a moment later and used to
    #: relabel it "failed", which tells the operator their own action was a
    #: malfunction. Same for the wall clock — a budget that expired is a stop,
    #: not a breakage, and `error` carries which one it was.
    _TERMINAL = frozenset({"killed"})

    def _settle(self, state: str, error: str | None = None):
        if self.state in self._TERMINAL:
            return
        self.state = state
        if error:
            self.error = error

    def run(self):
        try:
            self._clone()
            self._settle("running")
            self._drive()
            self._capture()
            self._settle("killed" if self.timed_out else
                         ("failed" if self.error else "done"))
        except Exception as e:                       # noqa: BLE001
            log.exception("session %s failed", self.id)
            self._settle("failed", str(e)[:500])
        finally:
            if self.acp:
                self.acp.close()

    def _git(self, *args: str, check=True) -> str:
        r = subprocess.run(["git", *args], cwd=self.dir, capture_output=True,
                           text=True, timeout=180)
        if check and r.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)}: {r.stderr[:300]}")
        return r.stdout

    def _clone(self):
        """A PRIVATE clone, never a mounted worktree.

        docs/plans/capability-and-containment.md, 2026-07-25: a git worktree is
        not a portable containment unit — its `.git` is a `gitdir:` pointer to
        an absolute path in the parent repo, and commits inside it write refs
        into the parent's `.git/refs/heads`. Mounting "just the worktree" would
        require the parent `.git` writable at the same absolute path inside the
        container, which is the opposite of confinement.
        """
        os.makedirs(WORKSPACES, exist_ok=True)
        subprocess.run(["git", "clone", "--no-hardlinks", self.spec.repo, self.dir],
                       capture_output=True, text=True, timeout=600, check=True)
        self._git("checkout", "-b", self.branch)
        self._git("config", "user.email", "nova@localhost")
        self._git("config", "user.name", "Nova")

    def _drive(self):
        self.acp = AcpSession(cwd=self.dir, mode=self.spec.mode,
                              on_update=self.updates.append)
        self.acp.initialize()
        self.acp.new_session()
        stop, err = self.acp.prompt(self.spec.task, deadline=self.deadline)
        if err:
            # Distinct from the clock on purpose — see AcpSession.prompt.
            self.error = f"the coding agent returned an error: {err}"
        elif stop is None:
            self.timed_out = True
            self.error = f"killed at the {self.budget_s}s wall clock"

    #: Never committed, whatever the repo's own .gitignore says. A session runs
    #: the tests it just wrote, so build artefacts appear in the tree; a scratch
    #: repo with no .gitignore then commits `__pycache__/*.pyc` into the diff the
    #: operator is supposed to review. The reviewable diff is the deliverable,
    #: so noise in it is a defect rather than an untidiness.
    _NEVER_COMMIT = ("__pycache__/", "*.pyc", ".pytest_cache/", "node_modules/",
                     ".ruff_cache/", "*.egg-info/")

    def _capture(self):
        """The deliverable is a branch and a diff. Nothing here merges or pushes."""
        excl = os.path.join(self.dir, ".git", "info", "exclude")
        os.makedirs(os.path.dirname(excl), exist_ok=True)
        with open(excl, "a") as f:
            f.write("\n" + "\n".join(self._NEVER_COMMIT) + "\n")
        self._git("rm", "-r", "--cached", "-q", "--ignore-unmatch",
                  "--", "__pycache__", ".pytest_cache", check=False)
        self._git("add", "-A")
        status = self._git("status", "--porcelain")
        if status.strip():
            self._git("commit", "-m", f"nova: {self.spec.task[:60]}")
            self.commit = self._git("rev-parse", "HEAD").strip()
        self.diffstat = self._git("diff", "--stat", "HEAD~1..HEAD",
                                  check=False) if self.commit else ""

    def snapshot(self) -> dict:
        # Denials are promoted out of the update stream and into the report.
        # A refusal the operator never sees is the same defect as a tool that
        # narrates work it did not do: the session looks like it simply chose
        # not to run the tests, when in fact it was stopped. Phase 3's review
        # surface is mostly this field.
        denials = [{"why": u.get("why"), "tool": u.get("tool")}
                   for u in self.updates if u.get("permission") == "denied"]
        # And what it WAS allowed to run. "Did it actually run the tests?" is
        # the first question a reviewer asks, and the answer must not be the
        # agent's own account of itself — that is a claim, and this codebase
        # already learned that `commands_run` as LLM self-report is worth
        # nothing. These are the commands the adjudicator approved, recorded
        # where it approved them.
        commands = [u.get("tool") for u in self.updates
                    if u.get("permission") == "allowed" and u.get("tool")]
        return {
            "id": self.id, "state": self.state, "error": self.error,
            "branch": self.branch, "commit": self.commit,
            "diffstat": self.diffstat.strip(),
            "updates": len(self.updates),
            "denials": denials,
            "commands": commands,
            "elapsed_s": round(time.time() - self.started, 1),
            "budget_s": self.budget_s,
            "tail": self.updates[-12:],
        }


@app.post("/session")
def start(spec: StartSession, authorization: str | None = Header(default=None)):
    _guard(authorization)
    if spec.mode not in _ALLOWED_MODES:
        # Refused HERE, at the spawn, on every request — the phase-0
        # measurement is what makes this a control and not advice.
        raise HTTPException(400, (
            f"permission mode '{spec.mode}' is refused. Allowed: "
            f"{', '.join(sorted(_ALLOWED_MODES))}. `bypassPermissions` was "
            f"measured writing outside the workspace, and `auto` decides "
            f"permissions with a model classifier."))
    s = Session(spec)
    with _lock:
        _sessions[s.id] = s
    threading.Thread(target=s.run, daemon=True, name=f"coder-{s.id[:8]}").start()
    log.info("session %s started: mode=%s budget=%ss", s.id, spec.mode, s.budget_s)
    return {"id": s.id, "state": s.state, "branch": s.branch}


@app.get("/session/{sid}")
def get(sid: str, authorization: str | None = Header(default=None)):
    _guard(authorization)
    s = _sessions.get(sid)
    if not s:
        raise HTTPException(404, "no such session")
    return s.snapshot()


@app.get("/session/{sid}/patch")
def patch(sid: str, authorization: str | None = Header(default=None)):
    """The session's work as a patch, so it can LEAVE this container.

    Phase 4. Until now the deliverable was "a branch and a diff" living in a
    private clone inside a named volume, which is a safe place and also a
    place nothing can reach — so every change Nova wrote had to be re-typed by
    a human against the real repo. That is the failure Jeremy named on
    2026-08-05: the capability exists, a person does the work anyway, and she
    stays exactly as unable.

    Still nothing here merges or pushes. This hands out TEXT. What lands it is
    a separate, operator-approved action against the host repo, and the branch
    it creates is never `main`.

    `git format-patch` rather than `git diff` on purpose: it carries the commit
    message and authorship, so what lands is attributable to the session that
    wrote it rather than appearing as an anonymous working-tree change.
    """
    _guard(authorization)
    s = _sessions.get(sid)
    if not s:
        raise HTTPException(404, "no such session")
    if not s.commit:
        return {"id": s.id, "state": s.state, "patch": "", "commit": "",
                "note": "this session produced no commit — nothing to land"}
    try:
        text = s._git("format-patch", "--stdout", "HEAD~1..HEAD")
    except Exception as e:                       # noqa: BLE001
        raise HTTPException(500, f"could not format the patch: {e}")
    return {"id": s.id, "state": s.state, "commit": s.commit,
            "branch": s.branch, "diffstat": s.diffstat.strip(),
            "patch": text}


@app.post("/session/{sid}/kill")
def kill(sid: str, authorization: str | None = Header(default=None)):
    _guard(authorization)
    s = _sessions.get(sid)
    if not s:
        raise HTTPException(404, "no such session")
    if s.acp:
        s.acp.close()
    s.error = s.error or "killed by operator"
    s.state = "killed"          # set LAST: _settle() treats it as terminal
    log.info("session %s killed", sid)
    return s.snapshot()


@app.delete("/session/{sid}")
def cleanup(sid: str, authorization: str | None = Header(default=None)):
    _guard(authorization)
    s = _sessions.pop(sid, None)
    if s:
        if s.acp:
            s.acp.close()
        shutil.rmtree(s.dir, ignore_errors=True)
    return {"status": "removed"}


class GradePatch(BaseModel):
    repo: str
    patch: str
    test_cmd: str = ""


@app.post("/grade")
def grade_patch(spec: GradePatch, authorization: str | None = Header(default=None)):
    """Mechanically grade a proposed patch — capability-acquisition 6b.

    Synchronous, unlike `/session`: this clones, applies and runs tests, which
    is seconds-to-a-minute rather than the minutes a coding session takes, and
    a caller that has to poll for a yes/no would just poll in a tight loop.

    Same container, same allow-list, same private-clone discipline. The job
    directory is removed whatever happens — a grader that accumulated
    checkouts would fill the volume the sessions need.
    """
    _guard(authorization)
    from grade import grade
    return grade(spec.repo, spec.patch, spec.test_cmd)


@app.get("/health")
def health():
    """Deliberately unauthenticated and deliberately says nothing useful:
    reachability only, so compose can wait on it without the check itself
    becoming an information leak."""
    return {"ok": True, "configured": bool(TOKEN)}
