import asyncio

import pytest
import redis.asyncio as redis_async

from screenpipe_bridge.app.runtime_config import RuntimeConfig

REDIS_URL = "redis://localhost:6379/1"


@pytest.mark.asyncio
async def test_runtime_config_picks_up_change_within_poll_interval():
    r = redis_async.from_url(REDIS_URL)
    await r.set("nova:config:capture.session_max_minutes", "30")

    cfg = RuntimeConfig(redis=r, poll_interval_seconds=1)
    await cfg.start()
    try:
        assert await cfg.get_int("capture.session_max_minutes", 30) == 30

        await r.set("nova:config:capture.session_max_minutes", "45")
        await asyncio.sleep(1.5)

        assert await cfg.get_int("capture.session_max_minutes", 30) == 45
    finally:
        await cfg.stop()
        await r.delete("nova:config:capture.session_max_minutes")
        await r.aclose()
