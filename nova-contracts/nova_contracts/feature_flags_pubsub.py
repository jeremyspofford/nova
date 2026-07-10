"""Redis pubsub invalidation subscriber for the feature-flag SDK.

Each flag-consuming service runs one PubsubSubscriber registered as a
named asyncio.Task in its FastAPI lifespan (per backend blocker B4).
On every message received on `nova:flags:invalidate`, the subscriber
triggers a fresh `warm_cache_from_http` call, which repopulates the
in-process cache and persists to the per-service cache file.

The class is invalidation-channel generic: pass `channel` and an async
`handler` to reuse the same reconnect loop for other invalidation
streams (FU-009 uses it for `nova:secrets:invalidate` in the
llm-gateway). Without a `handler` it keeps its original feature-flags
behavior.

Design notes:

- **Why full re-warm on every invalidate, not per-key refetch?** Flag
  flips are rare; full warm is bounded cost (~50ms in practice) and
  keeps the cache internally consistent. Per-key refetch would be a
  v2 optimization if measurements justify it.

- **`.value()` stays sync (B1).** Refetch happens in the async pubsub
  task, not in the value-read path.

- **Reconnect on disconnect.** The listen loop catches Redis connection
  errors, flips `is_connected` to False, sleeps briefly, and re-subscribes.
  `is_connected` is the signal exposed via `GET /health/ready`
  (per SRE blocker SR4).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable

import httpx
from redis.asyncio import Redis as AsyncRedis
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import RedisError

from nova_contracts.feature_flags_http import warm_cache_from_http

logger = logging.getLogger(__name__)

INVALIDATE_CHANNEL = "nova:flags:invalidate"
RECONNECT_DELAY_SECONDS = 5.0


class PubsubSubscriber:
    """One per service. Created in lifespan startup, stopped in lifespan
    shutdown (call .stop() and await it). Re-subscribes automatically on
    Redis disconnect."""

    def __init__(
        self,
        *,
        redis_url: str,
        http_client: httpx.AsyncClient | None = None,
        base_url: str = "",
        channel: str = INVALIDATE_CHANNEL,
        reconnect_delay: float = RECONNECT_DELAY_SECONDS,
        handler: Callable[[str], Awaitable[None]] | None = None,
        catch_up_on_subscribe: bool = False,
    ) -> None:
        """`handler` (async, receives the published key hint) replaces the
        default feature-flags re-warm; `http_client` + `base_url` are only
        required without one. `catch_up_on_subscribe` runs the handler once
        after every (re)subscribe so messages missed while disconnected are
        reconciled rather than lost (pubsub is fire-and-forget)."""
        if handler is None and http_client is None:
            raise ValueError("PubsubSubscriber needs a handler or an http_client")
        self._redis_url = redis_url
        self._http_client = http_client
        self._base_url = base_url
        self._channel = channel
        self._reconnect_delay = reconnect_delay
        self._handler = handler
        self._catch_up_on_subscribe = catch_up_on_subscribe

        self._task: asyncio.Task[None] | None = None
        self._stopping = False
        self._connected = False

    @property
    def is_connected(self) -> bool:
        """True if the subscriber is currently subscribed and reading.
        Surfaced via GET /health/ready so operators can see when
        invalidation propagation is degraded (SR4)."""
        return self._connected

    async def start(self) -> None:
        """Begin listening on the invalidation channel. Returns once the
        background task is scheduled (not necessarily once subscribed —
        is_connected reflects subscription state)."""
        if self._task is not None:
            raise RuntimeError("PubsubSubscriber already started")
        self._stopping = False
        self._task = asyncio.create_task(
            self._listen_with_reconnect(),
            name=f"invalidation-pubsub:{self._channel}",
        )

    async def stop(self) -> None:
        """Cancel the listen task and close pubsub connections.

        Idempotent — safe to call repeatedly."""
        self._stopping = True
        self._connected = False
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _listen_with_reconnect(self) -> None:
        """Top-level loop: subscribe, listen, on error log + sleep + retry."""
        while not self._stopping:
            try:
                await self._listen_once()
            except asyncio.CancelledError:
                raise
            except (RedisConnectionError, RedisError, OSError) as exc:
                self._connected = False
                logger.warning(
                    "flag_pubsub_disconnected channel=%s reason=%s "
                    "retry_in=%ss",
                    self._channel, exc, self._reconnect_delay,
                )
            except Exception:
                self._connected = False
                logger.exception(
                    "flag_pubsub_unexpected_error channel=%s retry_in=%ss",
                    self._channel, self._reconnect_delay,
                )
            if self._stopping:
                return
            try:
                await asyncio.sleep(self._reconnect_delay)
            except asyncio.CancelledError:
                raise

    async def _listen_once(self) -> None:
        """One subscribe + listen cycle. Returns cleanly when the
        connection drops (caller decides whether to retry)."""
        async with AsyncRedis.from_url(self._redis_url) as redis:
            pubsub = redis.pubsub()
            try:
                await pubsub.subscribe(self._channel)
                self._connected = True
                logger.info(
                    "flag_pubsub_subscribed channel=%s base_url=%s",
                    self._channel, self._base_url,
                )
                if self._catch_up_on_subscribe:
                    await self._invoke_handler("__subscribe_catch_up__")
                async for message in pubsub.listen():
                    if message.get("type") != "message":
                        continue
                    await self._handle_invalidation(message)
            finally:
                self._connected = False
                with contextlib.suppress(Exception):
                    await pubsub.unsubscribe(self._channel)
                with contextlib.suppress(Exception):
                    await pubsub.aclose()

    async def _handle_invalidation(self, message: dict) -> None:
        """Invalidation handler. Logs the source, then runs the handler
        (custom, or the default flags cache re-warm). Handler failures are
        non-fatal — state keeps its current values until the next success."""
        raw = message.get("data")
        key_hint = (
            raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
        )
        logger.info(
            "flag_invalidation_received channel=%s key_hint=%r",
            self._channel, key_hint,
        )
        await self._invoke_handler(key_hint)

    async def _invoke_handler(self, key_hint: str) -> None:
        try:
            if self._handler is not None:
                await self._handler(key_hint)
            else:
                await warm_cache_from_http(self._http_client, self._base_url)
        except Exception:
            logger.exception(
                "flag_invalidation_rewarm_failed channel=%s key_hint=%r",
                self._channel, key_hint,
            )
