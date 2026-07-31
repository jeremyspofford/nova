"""The ACP wire, hand-rolled — one session over stdio JSON-RPC.

Lifted from the phase-0 spike driver, which is the version that was actually
measured against `@agentclientprotocol/claude-agent-acp` 0.64.0 rather than
inferred from the spec. Hand-rolled on purpose: the framing is one JSON object
per line and the whole surface Nova needs is four methods, so an SDK would add
a dependency and a version to track without removing any work.

PROTOCOL VERSION IS PINNED. ACP v2 was published in draft eleven days before
this was written and changes the turn model (`session/prompt` returns `{}` on
acceptance; completion arrives as a `state_update`), renames `authenticate` to
`auth/login`, and deletes `session/set_mode`. The v2 announcement's own
guidance is to gate on version negotiation and not ship it by default. So this
speaks v1, states that it does, and will fail loudly rather than silently
half-work if an agent ever answers with something else.

The client capabilities declared here are honest about what phase 0 found:
`fs` mediation is NOT claimed, because claiming it changes nothing (the agent
made zero `fs/*` calls in every measured case and used its own in-process
tools) and because v2 removes the surface entirely. Nothing downstream should
be built on it.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import threading
import time
from typing import Callable

log = logging.getLogger("coder.acp")

PROTOCOL_VERSION = 1
AGENT_CMD = os.environ.get(
    "CODER_AGENT_CMD",
    "node /app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
).split()


class AcpSession:
    def __init__(self, cwd: str, mode: str, on_update: Callable[[dict], None]):
        self.cwd = cwd
        self.mode = mode
        self.on_update = on_update
        self.session_id: str | None = None
        self._q: "queue.Queue[dict]" = queue.Queue()
        self._nid = 0
        self._closed = False
        self.proc = subprocess.Popen(
            AGENT_CMD, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1, env=self._env())
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()

    def _env(self) -> dict:
        """The agent's own credential and nothing else.

        `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` point the Claude Agent SDK
        at any Anthropic-Messages-shaped endpoint. Phase 0 drove a full turn
        through OpenRouter's on Nova's existing key, and through it reached
        Gemini, GPT, Kimi and Llama — so the coder is provider-agnostic by
        construction and needs no credential Nova did not already have.

        NOTE the base URL takes no `/v1`: the SDK appends `/v1/messages`.
        """
        env = dict(os.environ)
        for leak in ("NOVA_AUTH_TOKEN", "NOVA_CODER_TOKEN", "DATABASE_URL",
                     "POSTGRES_PASSWORD", "NOVA_MCP_RUNNER_TOKEN"):
            env.pop(leak, None)
        return env

    # -- plumbing ----------------------------------------------------------
    def _read(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self._q.put(json.loads(line))
            except json.JSONDecodeError:
                log.debug("non-json from agent: %s", line[:200])

    def _read_err(self):
        for line in self.proc.stderr:
            if line.strip():
                log.info("[agent] %s", line.rstrip()[:300])

    def _send(self, method: str, params: dict) -> int:
        self._nid += 1
        self.proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "id": self._nid, "method": method,
             "params": params}) + "\n")
        self.proc.stdin.flush()
        return self._nid

    def _reply(self, mid: int, result: dict):
        self.proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "id": mid, "result": result}) + "\n")
        self.proc.stdin.flush()

    def _pump(self, want: int, deadline: float) -> dict | None:
        """Collect frames until the response to `want`, or the wall clock."""
        while time.time() < deadline and not self._closed:
            try:
                m = self._q.get(timeout=1)
            except queue.Empty:
                continue
            if "method" in m and "id" in m:
                self._on_agent_call(m)
            elif "method" in m:
                self.on_update({"method": m["method"], "params": m.get("params")})
            elif m.get("id") == want:
                return m
        return None

    # -- adjudication ------------------------------------------------------
    @staticmethod
    def _paths_in(node, out: list[str] | None = None) -> list[str]:
        """Every path the request names, found by KEY NAME rather than by a
        list of tool shapes.

        Tools name their arguments `path`, `file_path`, `filePath`,
        `abs_path`, `notebook_path`... The common factor is the substring, so
        that is what this matches — a new tool with a new path-shaped argument
        is covered the day it appears, whereas a list of known tools would go
        stale silently and fail OPEN, which is the direction that costs.
        """
        out = [] if out is None else out
        if isinstance(node, dict):
            for k, v in node.items():
                if "path" in k.lower() and isinstance(v, str) and v:
                    out.append(v)
                else:
                    AcpSession._paths_in(v, out)
        elif isinstance(node, list):
            for item in node:
                AcpSession._paths_in(item, out)
        return out

    def _decide(self, params: dict) -> tuple[bool, str]:
        """Approve only what lands inside this session's private clone.

        Mechanical and derived: resolve every path the request names and
        compare it against the clone root. No model is consulted — `auto` mode
        is refused at the broker precisely because it consults one.

        Fails CLOSED. A request naming no path at all is denied, because that
        is what a command execution looks like and an allowlisted command set
        is phase 3. `realpath` is what makes a symlink out of the workspace a
        denial rather than a bypass.
        """
        paths = self._paths_in(params)
        if not paths:
            return False, "names no path (command execution lands in phase 3)"
        root = os.path.realpath(self.cwd)
        for p in paths:
            rp = os.path.realpath(p if os.path.isabs(p)
                                  else os.path.join(self.cwd, p))
            if rp != root and not rp.startswith(root + os.sep):
                return False, f"escapes the workspace: {p}"
        return True, f"inside the workspace ({len(paths)} path(s))"

    def _on_agent_call(self, m: dict):
        """The agent asking US something.

        Phase 0 measured that denial genuinely prevents the action with this
        adapter, so this is real defence-in-depth — but only defence-in-depth:
        asking is `MAY` in the spec, so an agent that simply never asks is
        compliant and this code never runs. The container is the boundary.
        """
        method = m.get("method", "")
        params = m.get("params") or {}
        if "requestPermission" not in method and "request_permission" not in method:
            self._reply(m["id"], {})
            return

        ok, why = self._decide(params)
        opts = params.get("options", []) or []

        def pick(*needles):
            for o in opts:
                blob = f"{o.get('kind', '')} {o.get('optionId', '')}".lower()
                if any(n in blob for n in needles):
                    return o
            return None

        # allow_once, never allow_always: a standing grant is a grant we stop
        # seeing, and every call should be adjudicated on its own paths.
        choice = pick("allow_once", "allow") if ok else pick("reject", "deny")
        self.on_update({"permission": "allowed" if ok else "denied",
                        "why": why,
                        "tool": (params.get("toolCall") or {}).get("title")
                        or params.get("title") or "(unnamed)"})
        if choice:
            self._reply(m["id"], {"outcome": {"outcome": "selected",
                                              "optionId": choice["optionId"]}})
        else:
            # No option we recognise — refuse rather than guess.
            self._reply(m["id"], {"outcome": {"outcome": "cancelled"}})

    # -- the four methods Nova needs ---------------------------------------
    def initialize(self, timeout: int = 60):
        rid = self._send("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            # fs mediation deliberately NOT claimed — see module docstring
            "clientCapabilities": {"fs": {"readTextFile": False,
                                          "writeTextFile": False}},
        })
        r = self._pump(rid, time.time() + timeout)
        if not r or "result" not in r:
            raise RuntimeError(f"ACP initialize failed: {r}")
        got = r["result"].get("protocolVersion")
        if got != PROTOCOL_VERSION:
            raise RuntimeError(
                f"agent negotiated protocol v{got}, this broker speaks "
                f"v{PROTOCOL_VERSION}. Refusing rather than half-working — "
                f"v2 changes the turn model and deletes session/set_mode.")
        return r["result"]

    def new_session(self, timeout: int = 60):
        rid = self._send("session/new", {"cwd": self.cwd, "mcpServers": []})
        r = self._pump(rid, time.time() + timeout)
        if not r or "result" not in r:
            raise RuntimeError(f"session/new failed: {r}")
        self.session_id = r["result"]["sessionId"]
        if self.mode != "default":
            mid = self._send("session/set_mode",
                             {"sessionId": self.session_id, "modeId": self.mode})
            self._pump(mid, time.time() + 30)
        return self.session_id

    def prompt(self, text: str, deadline: float) -> str | None:
        """Run one turn. Returns the stopReason, or None if the clock won."""
        rid = self._send("session/prompt", {
            "sessionId": self.session_id,
            "prompt": [{"type": "text", "text": text}]})
        r = self._pump(rid, deadline)
        if r is None:
            # Cancellation in ACP is cooperative; a wall clock that asks nicely
            # is not a wall clock. Kill the process.
            self.close()
            return None
        return (r.get("result") or {}).get("stopReason")

    def close(self):
        self._closed = True
        if self.proc.poll() is None:
            self.proc.kill()
