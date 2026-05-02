"""Singleton-elected GitHub polling worker.

Even with webhook self-bootstrapping, events get dropped (transient errors,
revoked webhooks, brand-new watched repos before bootstrap). This worker
periodically queries GitHub for failed runs on watched repos and emits the
same ci.workflow_run.failure stimulus that webhooks produce.

Singleton election via Redis lease — only one orchestrator instance polls
at a time. Lease TTL = 300s (5 min); refresh every 60s; non-leader
instances wait and retry.

For each watched repo:
  - Find max(workflow_run.id) we've already seen via cortex_poll_state table.
  - Query /repos/{repo}/actions/runs?status=failure&per_page=10.
  - For each new run (id > last_seen_id), push a stimulus via Redis (same
    payload shape webhook receiver uses). Update last_seen_id.

Polling interval: per-repo from cortex_watched_repos.polling_interval_min,
default 15. The worker iterates all enabled repos each cycle; it doesn't
schedule per-repo. Coarse but simple.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from uuid import uuid4

import httpx
from redis.asyncio import Redis

# app.config and app.db are imported lazily so this module can be imported in
# test environments that only have redis/httpx installed (no pydantic_settings,
# asyncpg, cryptography, etc.).  The lazy imports happen at the call site that
# actually needs them — _poll_cycle and _poll_one_repo — not at module load.

logger = logging.getLogger(__name__)

LEASE_KEY = "nova:poll:github:lease"
LEASE_TTL_SECONDS = 300
POLL_CYCLE_SLEEP = 60  # seconds between polling cycles for the leader

_DEFAULT_REDIS_URL = "redis://redis:6379/2"


class GitHubPoller:
    """Singleton-elected poller. Run as a long-lived asyncio task."""

    def __init__(self, redis_url: str | None = None, cortex_redis_url: str | None = None):
        self.redis_url = redis_url or os.environ.get("REDIS_URL", _DEFAULT_REDIS_URL)
        self.cortex_redis_url = cortex_redis_url or os.environ.get("CORTEX_REDIS_URL", "redis://redis:6379/5")
        self.instance_id = str(uuid4())
        self.redis: Redis | None = None
        self._stop_event = asyncio.Event()

    async def start(self):
        self.redis = Redis.from_url(self.redis_url, decode_responses=True)
        try:
            while not self._stop_event.is_set():
                try:
                    is_leader = await self._acquire_or_refresh_lease()
                    if is_leader:
                        await self._poll_cycle()
                    await asyncio.wait_for(self._stop_event.wait(), timeout=POLL_CYCLE_SLEEP)
                except asyncio.TimeoutError:
                    continue  # normal — go again
                except Exception:
                    logger.exception("polling cycle failed; sleeping before retry")
                    await asyncio.sleep(30)
        finally:
            if self.redis:
                await self.redis.aclose()

    async def stop(self):
        self._stop_event.set()

    async def _acquire_or_refresh_lease(self) -> bool:
        """Try to acquire (or refresh if held). Returns True if this instance is the leader."""
        # First try to acquire
        ok = await self.redis.set(LEASE_KEY, self.instance_id, nx=True, ex=LEASE_TTL_SECONDS)
        if ok:
            logger.info("polling lease acquired by %s", self.instance_id)
            return True
        # Already held — check if it's us
        current = await self.redis.get(LEASE_KEY)
        if current == self.instance_id:
            await self.redis.expire(LEASE_KEY, LEASE_TTL_SECONDS)
            return True
        return False

    async def _poll_cycle(self):
        """One pass over all enabled watched repos."""
        from app.db import get_pool
        pool = get_pool()
        async with pool.acquire() as conn:
            repos = await conn.fetch(
                """
                SELECT id, tenant_id, credential_id, repo, polling_interval_min
                FROM cortex_watched_repos
                WHERE enabled = true
                  AND trigger_mode IN ('webhook_with_polling_fallback','polling_only')
                """
            )
        for repo_row in repos:
            try:
                await self._poll_one_repo(repo_row, _pool=pool)
            except Exception:
                logger.exception("polling failed for %s", repo_row["repo"])

    async def _poll_one_repo(self, repo_row, _pool=None):
        """Poll one repo for failed runs and push stimuli.

        _pool: optional asyncpg pool override (for tests). Production uses get_pool().
        """
        from app.capabilities import credentials as cred_db  # lazy — avoids crypto import at module load
        from app.config import settings
        from app.db import get_pool
        pool = _pool if _pool is not None else get_pool()
        # Resolve PAT
        secret = await cred_db.get_secret(
            pool,
            tenant_id=repo_row["tenant_id"],
            cred_id=repo_row["credential_id"],
            actor="polling_worker",
        )
        if not secret:
            logger.warning("polling: no secret for credential %s", repo_row["credential_id"])
            return
        # Read last_seen_id
        async with pool.acquire() as conn:
            last_seen = await conn.fetchval(
                "SELECT last_run_id FROM cortex_poll_state WHERE watched_repo_id=$1",
                repo_row["id"],
            )
            last_seen = last_seen or 0
        # Query GitHub
        api_base = settings.github_api_base_url
        async with httpx.AsyncClient(
            base_url=api_base.rstrip("/"),
            headers={
                "Authorization": f"Bearer {secret}",
                "Accept": "application/vnd.github+json",
            },
            timeout=15,
        ) as client:
            resp = await client.get(
                f"/repos/{repo_row['repo']}/actions/runs",
                params={"status": "failure", "per_page": 10},
            )
            if resp.status_code != 200:
                logger.warning(
                    "polling: GitHub returned %s for %s", resp.status_code, repo_row["repo"]
                )
                return
            runs = resp.json().get("workflow_runs", [])
        # Push stimuli for new runs
        new_max = last_seen
        cortex_redis = Redis.from_url(self.cortex_redis_url, decode_responses=True)
        try:
            for run in runs:
                run_id = run.get("id")
                if not run_id or run_id <= last_seen:
                    continue
                stimulus = {
                    "type": "ci.workflow_run.failure",
                    "tenant_id": str(repo_row["tenant_id"]),
                    "credential_id": str(repo_row["credential_id"]),
                    "repo": repo_row["repo"],
                    "run_id": run_id,
                    "head_sha": run.get("head_sha"),
                    "head_branch": run.get("head_branch"),
                    "workflow_name": run.get("name"),
                    "html_url": run.get("html_url"),
                    "source": "polling",
                }
                await cortex_redis.lpush("cortex:stimuli", json.dumps(stimulus))
                if run_id > new_max:
                    new_max = run_id
        finally:
            await cortex_redis.aclose()
        # Update poll state
        if new_max > last_seen:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO cortex_poll_state (watched_repo_id, last_run_id, last_polled_at)
                    VALUES ($1, $2, now())
                    ON CONFLICT (watched_repo_id) DO UPDATE
                    SET last_run_id = EXCLUDED.last_run_id, last_polled_at = now()
                    """,
                    repo_row["id"],
                    new_max,
                )
