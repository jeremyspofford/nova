from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.voice.pipeline import run_voice_turn
from app.ws.session import WebSocketSession


def make_session(session_id="s1"):
    ws = AsyncMock()
    s = WebSocketSession(ws=ws, session_id=session_id)
    s.task_id = "task-001"
    s.is_audio_owner = True
    return s


@pytest.mark.asyncio
async def test_voice_turn_sends_transcript_partial_then_final():
    session = make_session()
    sent_types = []

    async def capture(data):
        sent_types.append(data["type"])

    session.send_json = capture

    async def fake_stt(audio, http):
        yield {"text": "Hell", "is_final": False}
        yield {"text": "Hello", "is_final": True}

    async def fake_llm(text, http, task_id):
        yield "Hi there"

    async def fake_tts(text, http):
        return
        yield  # make it an async generator

    with patch("app.voice.pipeline._stt_stream", fake_stt), \
         patch("app.voice.pipeline._llm_stream", fake_llm), \
         patch("app.voice.pipeline._tts_stream", fake_tts):
        await run_voice_turn(session, b"\x00", MagicMock(), MagicMock())

    assert "transcript_partial" in sent_types
    assert "transcript_final" in sent_types


@pytest.mark.asyncio
async def test_voice_turn_stops_tts_on_barge_in():
    session = make_session()
    session.tts_cancelled = True

    async def fake_stt(audio, http):
        yield {"text": "Hello", "is_final": True}

    async def fake_llm(text, http, task_id):
        yield "response text"

    async def fake_tts(text, http):
        yield b"\xff"

    with patch("app.voice.pipeline._stt_stream", fake_stt), \
         patch("app.voice.pipeline._llm_stream", fake_llm), \
         patch("app.voice.pipeline._tts_stream", fake_tts):
        await run_voice_turn(session, b"\x00", MagicMock(), MagicMock())

    session.ws.send_bytes.assert_not_awaited()


@pytest.mark.asyncio
async def test_voice_turn_sends_audio_chunks_when_owner():
    session = make_session()
    session.tts_cancelled = False
    session.is_audio_owner = True
    audio_chunks = []
    session.ws.send_bytes = AsyncMock(side_effect=lambda c: audio_chunks.append(c))

    async def fake_stt(audio, http):
        yield {"text": "Hello", "is_final": True}

    async def fake_llm(text, http, task_id):
        yield "response"

    async def fake_tts(text, http):
        yield b"\xaa\xbb"

    with patch("app.voice.pipeline._stt_stream", fake_stt), \
         patch("app.voice.pipeline._llm_stream", fake_llm), \
         patch("app.voice.pipeline._tts_stream", fake_tts):
        await run_voice_turn(session, b"\x00", MagicMock(), MagicMock())

    assert b"\xaa\xbb" in audio_chunks
