"""Minimal in-process fake of the GitHub REST API for integration tests.

Networking note: the fake-github server binds on 0.0.0.0 so that the orchestrator
Docker container can reach it via host.docker.internal (mapped to host-gateway in
docker-compose.yml under the orchestrator service). The test replaces 127.0.0.1 with
host.docker.internal in the base URL before passing it to the /test endpoint.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import socket
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse


def load_scenario(name: str) -> dict:
    """Load a fake-github scenario by name from the scenarios/ directory."""
    base = Path(__file__).parent / "scenarios"
    with open(base / f"{name}.json") as f:
        return json.load(f)


def _build_app(scenarios: dict | None = None) -> FastAPI:
    app = FastAPI()
    state = {"scenarios": scenarios or {}}

    # Per-token scope sets — keyed on prefix so existing tests keep working.
    # Real GitHub returns scopes as a comma-separated `X-OAuth-Scopes` header.
    _TOKEN_SCOPES: dict[str, str] = {
        "ghp_minimal_scopes": "repo",
        "ghp_full_scopes": "repo, workflow, admin:repo_hook",
    }
    _DEFAULT_SCOPES = "repo, workflow, admin:repo_hook"

    @app.get("/user")
    async def get_user(authorization: str | None = Header(None)):
        if not authorization or not authorization.startswith("Bearer ghp_"):
            raise HTTPException(401, "Bad credentials")
        token = authorization.removeprefix("Bearer ")
        if token == "ghp_revoked_token":
            raise HTTPException(401, "Bad credentials")
        if token == "ghp_invalid_scope":
            raise HTTPException(403, "Token has insufficient scopes")
        scope_str = _TOKEN_SCOPES.get(token, _DEFAULT_SCOPES)
        return JSONResponse(
            {"login": "fake-user", "id": 1},
            headers={"X-OAuth-Scopes": scope_str},
        )

    @app.get("/repos/{owner}/{repo}/actions/runs")
    async def list_runs(owner: str, repo: str, status: str | None = None, branch: str | None = None):
        runs = list(state["scenarios"].get("workflow_runs", []))
        if status and status != "all":
            runs = [r for r in runs if r.get("conclusion") == status or r.get("status") == status]
        if branch:
            runs = [r for r in runs if r.get("head_branch") == branch]
        return {"total_count": len(runs), "workflow_runs": runs}

    @app.get("/repos/{owner}/{repo}/actions/runs/{run_id}")
    async def get_run(owner: str, repo: str, run_id: int):
        for r in state["scenarios"].get("workflow_runs", []):
            if r.get("id") == run_id:
                return r
        raise HTTPException(404, "run not found")

    @app.get("/repos/{owner}/{repo}/actions/runs/{run_id}/logs")
    async def get_logs(owner: str, repo: str, run_id: int):
        log_text = state["scenarios"].get("logs", {}).get(str(run_id), "")
        # Real GitHub returns a zip; for tests we return plain text in a JSON envelope
        return {"text": log_text}

    @app.get("/repos/{owner}/{repo}/pulls/{pr_number}")
    async def get_pull(owner: str, repo: str, pr_number: int):
        """Stub PR — only enough for compare_to_main to find PR head_sha."""
        return {
            "number": pr_number,
            "head": {"sha": f"sha-of-pr-{pr_number}", "ref": "feature-x"},
            "base": {"sha": "main-sha", "ref": "main"},
        }

    @app.post("/repos/{owner}/{repo}/pulls")
    async def create_pull(owner: str, repo: str, body: dict):
        """Create a fake PR. Captures the optional _test_patch for test inspection."""
        pulls = state.setdefault("created_pulls", [])
        pr_number = len(pulls) + 100  # start numbering at 100 to avoid collisions
        pull = {
            "number": pr_number,
            "title": body.get("title", ""),
            "body": body.get("body", ""),
            "head": {"ref": body.get("head", "")},
            "base": {"ref": body.get("base", "")},
            "html_url": f"http://fake-github/{owner}/{repo}/pull/{pr_number}",
            "_test_patch": body.get("_test_patch"),
        }
        pulls.append(pull)
        return pull

    @app.post("/repos/{owner}/{repo}/issues/{issue_number}/comments")
    async def create_comment(owner: str, repo: str, issue_number: int, body: dict):
        comments = state.setdefault("created_comments", [])
        comment_id = len(comments) + 1000
        comment = {
            "id": comment_id,
            "body": body.get("body", ""),
            "html_url": (
                f"http://fake-github/{owner}/{repo}"
                f"/issues/{issue_number}#issuecomment-{comment_id}"
            ),
        }
        comments.append(comment)
        return comment

    @app.post("/repos/{owner}/{repo}/hooks")
    async def create_hook(owner: str, repo: str, body: dict):
        """Create a hook. Stores config (including secret) and returns the hook object."""
        hooks = state.setdefault("hooks", {})
        next_id = state.setdefault("next_hook_id", 1000000)
        state["next_hook_id"] = next_id + 1
        config = body.get("config", {})
        hook = {
            "id": next_id,
            "name": body["name"],
            "active": body.get("active", True),
            "events": body.get("events", []),
            "config": config,
        }
        hooks[next_id] = hook
        return hook

    @app.delete("/repos/{owner}/{repo}/hooks/{hook_id}")
    async def delete_hook(owner: str, repo: str, hook_id: int):
        state.setdefault("hooks", {}).pop(hook_id, None)
        return {}

    @app.post("/_test/ping_responses")
    async def set_ping_response(body: dict):
        """Pin the ``/repos/.../hooks/{hook_id}/pings`` response status for a
        hook_id (T2-04 health-ping seam test override).

        With this override set, the ping route returns the configured status
        with an empty body — no signed delivery is performed. Without it, the
        route falls back to the legacy 200 + ``{ok, delivered_status}`` shape
        used by ``test_capability_webhooks.py`` (which fires real HMAC
        roundtrips through the receiver).
        """
        hook_id = int(body["hook_id"])
        status_code = int(body["status_code"])
        overrides = state.setdefault("ping_responses", {})
        overrides[hook_id] = status_code
        return {"hook_id": hook_id, "status_code": status_code}

    @app.post("/repos/{owner}/{repo}/hooks/{hook_id}/pings")
    async def ping_hook(owner: str, repo: str, hook_id: int):
        """Ping a hook on GitHub.

        Two modes:
          * Override mode (T2-04 health check): if ``state["ping_responses"]``
            has an entry for this ``hook_id``, return that status code with an
            empty body. Real GitHub returns 204 for a healthy ping.
          * Legacy mode (older webhook tests): fire an HMAC-signed delivery at
            the hook's configured URL and return ``{ok, delivered_status}``.
        """
        # T2-04 override: skip the delivery and return the canned status.
        overrides = state.get("ping_responses") or {}
        if hook_id in overrides:
            status_code = overrides[hook_id]
            # 204 is real GitHub's healthy response. Don't return a body.
            if status_code == 204:
                return JSONResponse(content=None, status_code=204)
            raise HTTPException(status_code=status_code, detail="ping override")

        hook = state.get("hooks", {}).get(hook_id)
        if not hook:
            raise HTTPException(status_code=404, detail="hook not found")
        secret = hook["config"].get("secret", "")
        target_url = hook["config"].get("url", "")
        payload = json.dumps({"zen": "test ping", "hook_id": hook_id}).encode()
        sig = "sha256=" + hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                target_url,
                content=payload,
                headers={
                    "X-GitHub-Event": "ping",
                    "X-Hub-Signature-256": sig,
                    "Content-Type": "application/json",
                },
            )
        return {"ok": True, "delivered_status": resp.status_code}

    @app.post("/repos/{owner}/{repo}/hooks/{hook_id}/workflow_run_failure")
    async def fire_workflow_run_failure(owner: str, repo: str, hook_id: int, body: dict | None = None):
        """Fire a workflow_run failure event to the hook's target URL.

        Sends an HMAC-signed workflow_run payload with conclusion=failure.
        Used by integration tests to trigger the cortex CI triage stimulus path.
        """
        hook = state.get("hooks", {}).get(hook_id)
        if not hook:
            raise HTTPException(status_code=404, detail="hook not found")
        secret = hook["config"].get("secret", "")
        target_url = hook["config"].get("url", "")

        body = body or {}
        run_id = body.get("run_id", 9999001)
        head_sha = body.get("head_sha", "abc123def456")
        head_branch = body.get("head_branch", "feature-triage-test")
        workflow_name = body.get("workflow_name", "tests")

        event_payload = json.dumps({
            "workflow_run": {
                "id": run_id,
                "name": workflow_name,
                "head_sha": head_sha,
                "head_branch": head_branch,
                "conclusion": "failure",
                "status": "completed",
                "html_url": (
                    f"http://fake-github/{owner}/{repo}/actions/runs/{run_id}"
                ),
            }
        }).encode()

        sig = "sha256=" + hmac.new(secret.encode(), event_payload, hashlib.sha256).hexdigest()
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                target_url,
                content=event_payload,
                headers={
                    "X-GitHub-Event": "workflow_run",
                    "X-Hub-Signature-256": sig,
                    "Content-Type": "application/json",
                },
            )
        return {"ok": True, "delivered_status": resp.status_code, "run_id": run_id}

    return app


class FakeGitHubServer:
    """Fake GitHub API on a local ephemeral port for tests."""

    def __init__(self, scenarios: dict | None = None):
        self.scenarios = scenarios
        self.port = self._free_port()
        self._task: asyncio.Task | None = None
        self._server: uvicorn.Server | None = None

    @staticmethod
    def _free_port() -> int:
        with contextlib.closing(socket.socket()) as s:
            s.bind(("0.0.0.0", 0))
            return s.getsockname()[1]

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def start(self):
        config = uvicorn.Config(
            _build_app(scenarios=self.scenarios), host="0.0.0.0", port=self.port, log_level="warning"
        )
        self._server = uvicorn.Server(config)
        self._task = asyncio.create_task(self._server.serve())
        for _ in range(50):
            await asyncio.sleep(0.05)
            if self._server.started:
                return
        raise RuntimeError("fake-github failed to start")

    async def stop(self):
        if self._server:
            self._server.should_exit = True
        if self._task:
            await self._task
