import json
import logging

logger = logging.getLogger(__name__)

_BUFFER_CAP = 100
_BUFFER_TTL = 3600


async def buffer_event(redis, task_id: str, event: dict) -> None:
    key = f"chat:task:{task_id}:buffer"
    await redis.rpush(key, json.dumps(event))
    await redis.ltrim(key, -_BUFFER_CAP, -1)
    await redis.expire(key, _BUFFER_TTL)


# Streaming events are persisted to DB and restored via history load — replaying
# them causes doubled text when the buffer grows across multiple exchanges.
_REPLAY_SKIP_TYPES = {"response_chunk", "response_final"}


async def replay_buffer(redis, task_id: str, session) -> int:
    key = f"chat:task:{task_id}:buffer"
    events = await redis.lrange(key, 0, -1)
    count = 0
    for raw in events:
        event = json.loads(raw)
        if event.get("type") not in _REPLAY_SKIP_TYPES:
            await session.send_json(event)
            count += 1
    return count
