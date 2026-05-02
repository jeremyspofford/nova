"""Minimal in-process fake of the GitHub REST API for integration tests.

Networking note: the fake-github server binds on 0.0.0.0 so that the orchestrator
Docker container can reach it via host.docker.internal (mapped to host-gateway in
docker-compose.yml under the orchestrator service). The test replaces 127.0.0.1 with
host.docker.internal in the base URL before passing it to the /test endpoint.
"""
from __future__ import annotations

import asyncio
import contextlib
import socket

import uvicorn
from fastapi import FastAPI, Header, HTTPException


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.get("/user")
    async def get_user(authorization: str | None = Header(None)):
        if not authorization or not authorization.startswith("Bearer ghp_"):
            raise HTTPException(401, "Bad credentials")
        token = authorization.removeprefix("Bearer ")
        if token == "ghp_revoked_token":
            raise HTTPException(401, "Bad credentials")
        if token == "ghp_invalid_scope":
            raise HTTPException(403, "Token has insufficient scopes")
        return {"login": "fake-user", "id": 1}

    return app


class FakeGitHubServer:
    """Fake GitHub API on a local ephemeral port for tests."""

    def __init__(self):
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
            _build_app(), host="0.0.0.0", port=self.port, log_level="warning"
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
