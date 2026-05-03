"""Builds the engram ingestion payload from a finalized session and LPUSHes to Redis db0."""

import hashlib
import json
import logging

import redis.asyncio as redis_async

from app.session_aggregator import FocusSession
from app.tenant import DEFAULT_TENANT

logger = logging.getLogger(__name__)

_QUEUE_KEY = "engram:ingestion:queue"


class EngramProducer:
    def __init__(
        self,
        redis: redis_async.Redis,
        device_id: str = "primary",
        trust: float = 0.80,
        queue_key: str = _QUEUE_KEY,
    ):
        self._redis = redis
        self._device_id = device_id
        self._trust = trust
        self._queue_key = queue_key

    async def push(self, session: FocusSession) -> None:
        payload = self._build_payload(session)
        await self._redis.lpush(self._queue_key, json.dumps(payload))

    def _build_payload(self, session: FocusSession) -> dict:
        start_iso = session.started_at.isoformat()
        end_iso = session.ended_at.isoformat()
        title_time = session.started_at.strftime("%H:%M") + "-" + session.ended_at.strftime("%H:%M")
        window_hash = hashlib.sha256(
            f"{session.app}{session.window}{session.url or ''}".encode()
        ).hexdigest()[:12]
        title = f"{session.app} — {session.window} — {title_time}"
        if len(title) > 200:
            title = title[:197] + "..."
        return {
            "raw_text": session.content,
            "source_type": "screenpipe",
            "session_id": f"screenpipe:{self._device_id}:{start_iso}",
            "occurred_at": start_iso,
            "tenant_id": DEFAULT_TENANT,
            "metadata": {
                "app": session.app,
                "window": session.window,
                "url": session.url,
                "device_id": self._device_id,
                "captured_at_start": start_iso,
                "captured_at_end": end_iso,
                "word_count": session.word_count,
                "screenpipe_event_count": session.event_count,
            },
            "source_trust": self._trust,
            "source_uri": f"screenpipe://{self._device_id}/{start_iso}/{window_hash}",
            "source_title": title,
        }
