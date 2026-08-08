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

import hashlib
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
    #: Resume a previous session's work instead of starting from the trunk.
    #: The retry half of the build loop, and the reason it exists: every
    #: attempt used to clone the repo fresh, so a retry told "a previous
    #: attempt failed the sandbox, fix this" opened a checkout in which the
    #: failing change did not exist. The prompt described a world the agent
    #: was not in — worse than no retry at all, because it is a false premise
    #: rather than a repetition. Given this, the clone source is that
    #: session's own directory, so the broken code is really there and the
    #: agent can run the failing check itself.
    continue_from: str = ""
    #: What a patch is measured against. Not "the commit this clone started
    #: at": a resumed session starts at the PREVIOUS ATTEMPT's tip, and a
    #: patch measured from there would carry only the last delta while the
    #: sandbox and the landing both apply it to the trunk.
    base_ref: str = "main"


_sessions: dict[str, "Session"] = {}
_lock = threading.Lock()


#: Both spellings of "what this cost", as MEASURED off the wire rather than
#: taken from the docs. The adapter streams `usage_update` frames shaped
#: `{"sessionUpdate": "usage_update", "used": 52632, "size": 200000,
#: "cost": {"amount": 3.17, "currency": "USD"}}` — cumulative for the session,
#: so the last frame wins — and the phase-0 notes say the final prompt
#: response carries an `inputTokens`/`outputTokens` block. A meter that only
#: understood the documented spelling measured nothing for a week.
_TOKEN_KEYS = {
    "tokens_in": ("inputTokens", "input_tokens", "prompt_tokens",
                  "promptTokens"),
    "tokens_out": ("outputTokens", "output_tokens", "completion_tokens",
                   "completionTokens"),
    "cached_tokens": ("cachedReadTokens", "cached_read_tokens",
                      "cached_tokens", "cachedTokens"),
}


def _usage_figures(node) -> dict:
    """Every cost figure one update frame carries, normalized, possibly {}.

    Recursive by key shape rather than by frame layout, because the figures
    arrive nested differently per source: a streamed `usage_update` sits under
    `params.update`, a final response block under `usage`. An empty dict IS
    the answer for a frame that carries none — it must not count as a report.

    `cost` maps to `usd` only when the frame says USD; an amount in a currency
    this code does not recognise is dropped rather than mislabeled.
    """
    out: dict = {}
    if isinstance(node, dict):
        if node.get("sessionUpdate") == "usage_update":
            if isinstance(node.get("used"), (int, float)):
                out["context_used"] = int(node["used"])
            if isinstance(node.get("size"), (int, float)):
                out["context_size"] = int(node["size"])
            cost = node.get("cost")
            if (isinstance(cost, dict)
                    and isinstance(cost.get("amount"), (int, float))
                    and cost.get("currency", "USD") == "USD"):
                out["usd"] = float(cost["amount"])
        block = node.get("usage") if isinstance(node.get("usage"), dict) \
            else node
        for field, keys in _TOKEN_KEYS.items():
            for k in keys:
                v = block.get(k)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    out[field] = int(v)
                    break
        for v in node.values():
            out.update(_usage_figures(v))
    elif isinstance(node, list):
        for item in node:
            out.update(_usage_figures(item))
    return out


#: ONE CLONE PER REPOSITORY, kept and fetched. Every session used to run its
#: own `git clone`, so N tasks against one repo meant N copies of it on disk —
#: minutes and hundreds of megabytes each, and N drifting views of `main`.
#: A checkout is a thing you keep in sync, not a thing you make again.
REPOS = os.path.join(WORKSPACES, ".repos")

#: Serialises fetch and `worktree add` against a shared mirror. Two sessions
#: starting at once would otherwise race on the same refs and index.
_mirror_lock = threading.Lock()


def _mirror(repo: str) -> str:
    """The persistent checkout for `repo`, cloned once and fetched after that.

    Keyed by the URL rather than by workspace name, because the URL is what the
    broker is given and two workspaces pointing at the same repository should
    share the objects rather than duplicate them.

    A FETCH FAILURE IS AN ERROR, not a shrug. Working from a stale mirror would
    produce a patch against a `main` that moved days ago, and `git am` would
    then fail at landing time with a conflict nobody could explain.
    """
    key = hashlib.sha256(repo.encode()).hexdigest()[:16]
    path = os.path.join(REPOS, key)
    with _mirror_lock:
        if not os.path.isdir(os.path.join(path, ".git")):
            os.makedirs(REPOS, exist_ok=True)
            log.info("cloning %s -> %s (first time for this repo)", repo, path)
            subprocess.run(["git", "clone", "--no-hardlinks", repo, path],
                           capture_output=True, text=True, timeout=600,
                           check=True)
        else:
            r = subprocess.run(
                ["git", "-C", path, "fetch", "--prune", "origin"],
                capture_output=True, text=True, timeout=600)
            if r.returncode != 0:
                raise RuntimeError(
                    f"could not fetch {repo}: {r.stderr[:300]}. Refusing to "
                    f"work from a stale checkout — the patch would be measured "
                    f"against a trunk that has moved.")
    return path


class Session:
    """One coding task: a worktree of the shared clone, an agent, a deadline."""

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
        #: What the agent has reported spending, per-key last-frame-wins —
        #: the frames are cumulative for the session, so summing them would
        #: multiply the cost by the number of times it was reported.
        self.usage: dict = {}
        self.usage_frames = 0
        #: The pin THIS process was launched with, recorded per session
        #: rather than read from .env at question time: the operator can
        #: change the pin between sessions, and only the broker knows which
        #: value its agent actually ran under.
        self.model = os.environ.get("ANTHROPIC_MODEL", "")
        #: The trunk commit this session's work will be measured from. Set at
        #: clone time and never derived from HEAD, which on a resumed session
        #: is the previous attempt's tip.
        self.base_commit = ""

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
            self._checkout()
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

    def _checkout(self):
        """A worktree of the ONE clone this repository gets, never a new copy.

        The repository is cloned the first time it is seen and FETCHED after
        that; each session is a `git worktree` off it. Cloning per session was
        minutes and hundreds of megabytes each time, N copies of one repo on
        disk, and N views of `main` that drifted apart as they aged.

        WHY A WORKTREE IS FINE HERE, when capability-and-containment.md
        (2026-07-25) rejected it. That argument is about MOUNTING a worktree
        into a container: its `.git` is a `gitdir:` pointer to an absolute path
        in the parent, so "just the worktree" would need the parent's `.git`
        writable at the same path on the other side of the boundary. Nothing
        crosses a boundary here — mirror and worktree are both inside this
        container's private volume at the same absolute paths, and the
        containment argument was never about the two of them, it was about the
        host. The agent still cannot leave the container.
        """
        os.makedirs(WORKSPACES, exist_ok=True)
        mirror = _mirror(self.spec.repo)

        # The trunk, freshly fetched. Read from the mirror rather than from the
        # session tree, because on a resumed session HEAD is the previous
        # attempt's tip and a patch measured from there carries only its last
        # delta — while the sandbox and the landing both apply it to `main`.
        r = subprocess.run(["git", "-C", mirror, "rev-parse",
                            f"origin/{self.spec.base_ref}"],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise RuntimeError(
                f"{self.spec.repo} has no origin/{self.spec.base_ref}: "
                f"{r.stderr[:200]}")
        self.base_commit = r.stdout.strip()

        start = f"origin/{self.spec.base_ref}"
        if self.spec.continue_from:
            # Resume from the previous session's BRANCH, which lives in the
            # shared mirror and therefore outlives its worktree — strictly
            # better than the directory this used to depend on. The name is the
            # one `__init__` derives, so it is recoverable without the
            # in-memory session map that a restart empties.
            prev = _sessions.get(self.spec.continue_from)
            start = (prev.branch if prev
                     else f"nova/{self.spec.continue_from[:8]}")
            # FAILS RATHER THAN FALLING BACK to the trunk: a session that says
            # it is resuming and quietly is not hands the agent a clean tree
            # while its prompt describes a change that is not in it.
            check = subprocess.run(["git", "-C", mirror, "rev-parse",
                                    "--verify", start],
                                   capture_output=True, text=True, timeout=60)
            if check.returncode != 0:
                raise RuntimeError(
                    f"cannot resume session {self.spec.continue_from}: no "
                    f"branch {start} in this repository, so there is nothing "
                    f"to continue from. Start a fresh attempt instead of "
                    f"pretending to resume one.")

        with _mirror_lock:
            r = subprocess.run(
                ["git", "-C", mirror, "worktree", "add", "-b", self.branch,
                 self.dir, start],
                capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise RuntimeError(f"could not create a worktree for "
                               f"{self.branch}: {r.stderr[:300]}")
        self._git("config", "user.email", "nova@localhost")
        self._git("config", "user.name", "Nova")

    def _saw(self, update: dict):
        """One update, into the record AND the meter — a single path, so a
        frame the snapshot can show is a frame the meter has counted."""
        self.updates.append(update)
        got = _usage_figures(update)
        if got:
            self.usage_frames += 1
            self.usage.update(got)

    def _drive(self):
        self.acp = AcpSession(cwd=self.dir, mode=self.spec.mode,
                              on_update=self._saw)
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
        # ASK GIT WHERE ITS DIRECTORY IS. In a worktree `.git` is a FILE — a
        # `gitdir:` pointer — so joining `.git/info` onto the working directory
        # raises ENOTDIR, which is exactly how the first worktree-backed
        # session died: the agent wrote the file, `_capture` blew up before the
        # commit, and the session reported `failed` with nothing to land.
        common = self._git("rev-parse", "--git-common-dir").strip()
        if not os.path.isabs(common):
            common = os.path.join(self.dir, common)
        excl = os.path.join(common, "info", "exclude")
        os.makedirs(os.path.dirname(excl), exist_ok=True)
        # Idempotent, because the common dir is now SHARED by every worktree of
        # this repository: appending per session would grow the file forever.
        have = open(excl).read() if os.path.exists(excl) else ""
        missing = [p for p in self._NEVER_COMMIT if p not in have]
        if missing:
            with open(excl, "a") as f:
                f.write("\n" + "\n".join(missing) + "\n")
        self._git("rm", "-r", "--cached", "-q", "--ignore-unmatch",
                  "--", "__pycache__", ".pytest_cache", check=False)
        self._git("add", "-A")
        status = self._git("status", "--porcelain")
        if status.strip():
            self._git("commit", "-m", f"nova: {self.spec.task[:60]}")
            self.commit = self._git("rev-parse", "HEAD").strip()
        # FROM THE TRUNK, not from the previous commit. On a resumed session
        # HEAD~1 is the last attempt's work, and a diffstat that excluded it
        # would describe a fraction of what the patch actually carries.
        self.diffstat = self._git("diff", "--stat",
                                  f"{self.base_commit or 'HEAD~1'}..HEAD",
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
            # So "attempt 2 resumed attempt 1" is a recorded fact rather than
            # something a reader infers from timestamps.
            "resumed_from": self.spec.continue_from or None,
            "base_commit": self.base_commit,
            "diffstat": self.diffstat.strip(),
            "updates": len(self.updates),
            "denials": denials,
            "commands": commands,
            "elapsed_s": round(time.time() - self.started, 1),
            "budget_s": self.budget_s,
            # What this session has SPENT, aggregated from the ACP usage
            # frames rather than left to fall out of the twelve-update tail
            # window. None — not zeros — when no frame ever carried figures:
            # the backend writes that to the ledger as unmetered, and a zero
            # here would read as free.
            "model": self.model,
            "usage": ({**self.usage, "frames": self.usage_frames}
                      if self.usage_frames else None),
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

    MEASURED FROM THE TRUNK, so a resumed session hands out the whole series
    rather than its last commit. Both consumers apply this to `main` — the
    sandbox stages `main + patch` and landing creates a branch off HEAD — so a
    patch carrying only attempt 3's delta would be checked and landed without
    the two attempts it was written on top of.
    """
    _guard(authorization)
    s = _sessions.get(sid)
    if not s:
        raise HTTPException(404, "no such session")
    if not s.commit:
        return {"id": s.id, "state": s.state, "patch": "", "commit": "",
                "note": "this session produced no commit — nothing to land"}
    try:
        text = s._git("format-patch", "--stdout",
                      f"{s.base_commit or 'HEAD~1'}..HEAD")
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
        # A WORKTREE IS REMOVED, NOT DELETED. `rmtree` would leave the mirror
        # holding a registration for a directory that no longer exists, and
        # every later `worktree add` would warn about it. The BRANCH is kept
        # deliberately: it is the only durable record of the work, and it is
        # what a later session resumes from.
        try:
            mirror = _mirror(s.spec.repo)
            subprocess.run(["git", "-C", mirror, "worktree", "remove",
                            "--force", s.dir],
                           capture_output=True, text=True, timeout=120)
            subprocess.run(["git", "-C", mirror, "worktree", "prune"],
                           capture_output=True, text=True, timeout=60)
        except Exception:                            # noqa: BLE001
            log.exception("could not remove the worktree for %s", sid)
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
