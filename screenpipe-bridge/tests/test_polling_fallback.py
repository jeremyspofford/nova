import asyncio

import pytest

from app.screenpipe_client import ScreenpipeClient
from fixtures.fake_screenpipe import FakeScreenpipe


@pytest.mark.asyncio
async def test_falls_back_to_polling_when_ws_unavailable():
    """After repeated WS failures, the client polls /search and still delivers events."""
    fake = FakeScreenpipe()
    await fake.start()
    received: list[dict] = []
    client = ScreenpipeClient(
        url=fake.url,
        api_key=None,
        on_event=lambda evt: received.append(evt),
        ws_failures_before_polling=2,
        polling_interval_seconds=0.3,
        backoff_schedule_override=[0.05, 0.05, 0.05, 0.05, 0.05],
        startup_connect_timeout=1.0,
    )
    # Force WS to fail by closing connections immediately
    original_handler = fake._ws_handler

    async def reject(websocket):
        await websocket.close(code=1011)

    fake._ws_handler = reject

    await client.start()
    try:
        # Pre-populate an event in the fake's search store so polling has something to find
        await fake.emit_ocr(app_name="A", window_name="W1", text="poll-me")
        # Wait long enough for: 2 WS failures + first poll + delivery
        await asyncio.sleep(2.0)

        assert any(
            (e.get("data", {}).get("text") == "poll-me")
            for e in received
        ), f"Expected poll-me event in received, got: {received}"
    finally:
        fake._ws_handler = original_handler
        await client.stop()
        await fake.stop()
