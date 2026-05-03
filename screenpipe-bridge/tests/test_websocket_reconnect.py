import asyncio

import pytest

from app.screenpipe_client import ScreenpipeClient
from fixtures.fake_screenpipe import FakeScreenpipe


@pytest.mark.asyncio
async def test_websocket_reconnects_after_disconnect():
    fake = FakeScreenpipe()
    await fake.start()
    received: list[dict] = []
    client = ScreenpipeClient(
        url=fake.url, api_key=None,
        on_event=lambda evt: received.append(evt),
    )
    await client.start()
    try:
        await fake.emit_ocr(app_name="A", window_name="W1", text="first")
        await asyncio.sleep(0.5)
        assert any(e["data"]["text"] == "first" for e in received)

        await fake.disconnect_all()
        await asyncio.sleep(2.0)  # let exponential backoff retry

        await fake.emit_ocr(app_name="A", window_name="W1", text="second")
        await asyncio.sleep(0.5)
        assert any(e["data"]["text"] == "second" for e in received)
    finally:
        await client.stop()
        await fake.stop()


@pytest.mark.asyncio
async def test_websocket_sends_authorization_header():
    fake = FakeScreenpipe()
    fake.require_auth("test-api-key")
    await fake.start()
    received: list[dict] = []
    client = ScreenpipeClient(
        url=fake.url, api_key="test-api-key",
        on_event=lambda evt: received.append(evt),
    )
    await client.start()
    try:
        await fake.emit_ocr(app_name="A", window_name="W1", text="auth-ok")
        await asyncio.sleep(0.5)
        assert any(e["data"]["text"] == "auth-ok" for e in received)
    finally:
        await client.stop()
        await fake.stop()
