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


async def replay_buffer(redis, task_id: str, session) -> int:
    key = f"chat:task:{task_id}:buffer"
    events = await redis.lrange(key, 0, -1)
    for raw in events:
        await session.send_json(json.loads(raw))
    return len(events)
