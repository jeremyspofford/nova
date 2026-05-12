import json
import pytest
from app.ws.buffer import buffer_event, replay_buffer


class MockRedis:
    def __init__(self):
        self._data: dict = {}

    async def rpush(self, key, value):
        self._data.setdefault(key, []).append(value)

    async def ltrim(self, key, start, end):
        lst = self._data.get(key, [])
        if end == -1:
            self._data[key] = lst[start:]
        else:
            self._data[key] = lst[start:end + 1]

    async def expire(self, key, ttl):
        pass

    async def lrange(self, key, start, end):
        lst = self._data.get(key, [])
        if end == -1:
            return lst[start:]
        return lst[start:end + 1]


@pytest.mark.asyncio
async def test_buffer_event_pushes_to_redis():
    redis = MockRedis()
    await buffer_event(redis, "task-001", {"type": "response_chunk", "text": "hi"})
    key = "chat:task:task-001:buffer"
    assert len(redis._data[key]) == 1
    assert json.loads(redis._data[key][0])["type"] == "response_chunk"


@pytest.mark.asyncio
async def test_buffer_capped_at_100():
    redis = MockRedis()
    for i in range(110):
        await buffer_event(redis, "task-002", {"n": i})
    key = "chat:task:task-002:buffer"
    assert len(redis._data[key]) == 100
    assert json.loads(redis._data[key][-1])["n"] == 109


@pytest.mark.asyncio
async def test_replay_sends_buffered_events_in_order():
    redis = MockRedis()
    events = [{"type": "response_chunk", "text": f"word{i}"} for i in range(3)]
    for e in events:
        await buffer_event(redis, "task-003", e)
    received = []

    class FakeSession:
        async def send_json(self, data):
            received.append(data)

    count = await replay_buffer(redis, "task-003", FakeSession())
    assert count == 3
    assert received[0]["text"] == "word0"
    assert received[2]["text"] == "word2"
