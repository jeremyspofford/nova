from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .buffer import buffer_event, replay_buffer
from .session import WebSocketSession
from ..voice.barge_in import handle_barge_in
from ..voice.pipeline import run_voice_turn
from ..config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


def _log_task_exc(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception():
        logger.error("background task failed: %s", task.exception())


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    # Auth check before accepting — must be done before ws.accept()
    secret = ws.headers.get("x-admin-secret") or ws.query_params.get("secret")
    if settings.admin_secret and secret != settings.admin_secret:
        await ws.close(code=1008, reason="Unauthorized")
        return
    await ws.accept()
    session_id = str(uuid.uuid4())
    session = WebSocketSession(ws=ws, session_id=session_id)
    sessions = ws.app.state.sessions
    redis = ws.app.state.redis
    http_agent = ws.app.state.http_agent
    http_voice = ws.app.state.http_voice
    sessions.add(session)
    audio_buffer: list[bytes] = []

    try:
        while True:
            raw = await ws.receive()
            if "bytes" in raw:
                audio_buffer.append(raw["bytes"])
                continue
            text = raw.get("text", "")
            if not text:
                continue
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue
            msg_type = msg.get("type")

            if msg_type == "connect":
                task_id = msg.get("resume_task_id") or str(uuid.uuid4())
                session.task_id = task_id
                replayed = await replay_buffer(redis, task_id, session)
                await session.send_json(
                    {"type": "connected", "task_id": task_id, "replayed_events": replayed}
                )

            elif msg_type == "message":
                task_id = msg.get("task_id") or session.task_id
                text_input = msg.get("text", "")
                model = msg.get("model") or None
                content = msg.get("content") or None
                web_search = bool(msg.get("web_search", False))
                deep_research = bool(msg.get("deep_research", False))
                output_style = msg.get("output_style") or None
                custom_instructions = msg.get("custom_instructions") or None
                if task_id and text_input:
                    event = {"type": "message", "text": text_input}
                    await buffer_event(redis, task_id, event)
                    await sessions.broadcast_to_task(task_id, event)
                    t = asyncio.create_task(
                        _dispatch_text_turn(
                            session, task_id, text_input, http_agent, redis, sessions,
                            model=model, content=content, web_search=web_search,
                            deep_research=deep_research, output_style=output_style,
                            custom_instructions=custom_instructions,
                        )
                    )
                    t.add_done_callback(_log_task_exc)

            elif msg_type == "voice_turn_start":
                task_id = msg.get("task_id") or session.task_id
                if task_id:
                    session.task_id = task_id
                    session.tts_cancelled = False
                    sessions.claim_audio(session_id, task_id)
                    audio_buffer.clear()

            elif msg_type == "audio_chunk":
                chunk = base64.b64decode(msg.get("data", ""))
                audio_buffer.append(chunk)

            elif msg_type == "voice_turn_end":
                if audio_buffer and session.task_id:
                    combined = b"".join(audio_buffer)
                    audio_buffer.clear()
                    t = asyncio.create_task(run_voice_turn(session, combined, http_agent, http_voice))
                    t.add_done_callback(_log_task_exc)

            elif msg_type == "barge_in":
                task_id = msg.get("task_id") or session.task_id
                if task_id:
                    await handle_barge_in(session, task_id, http_agent)

            elif msg_type == "approve_tool":
                tool_call_id = msg.get("tool_call_id")
                remember = msg.get("scope") == "task"
                if tool_call_id:
                    await http_agent.post(
                        f"/api/v1/approvals/{tool_call_id}/grant",
                        json={"remember": remember, "remember_ttl": 3600},
                    )

            elif msg_type == "deny_tool":
                tool_call_id = msg.get("tool_call_id")
                if tool_call_id:
                    await http_agent.post(
                        f"/api/v1/approvals/{tool_call_id}/deny",
                        json={},
                    )

    except WebSocketDisconnect:
        logger.info("disconnected: session=%s task=%s", session_id, session.task_id)
    finally:
        sessions.remove(session_id)


async def _dispatch_text_turn(
    session, task_id, text, http_agent, redis, sessions,
    model=None, content=None, web_search=False, deep_research=False,
    output_style=None, custom_instructions=None,
):
    body: dict = {"text": text}
    if model:
        body["model"] = model
    if content is not None:
        body["content"] = content
    if web_search:
        body["web_search"] = True
    if deep_research:
        body["deep_research"] = True
    if output_style:
        body["output_style"] = output_style
    if custom_instructions:
        body["custom_instructions"] = custom_instructions
    try:
        async with http_agent.stream(
            "POST",
            f"/api/v1/tasks/{task_id}/message",
            json=body,
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue

                chunk_type = chunk.get("type")
                if chunk_type:
                    # Typed event (tool_approval_request, tool_result, etc.)
                    # Forward directly to connected clients — don't buffer these
                    # since their lifecycle is managed by the approval flow.
                    await sessions.broadcast_to_task(task_id, {**chunk, "task_id": task_id})
                else:
                    text_content = chunk.get("text", "")
                    if text_content:
                        event = {"type": "response_chunk", "text": text_content, "task_id": task_id}
                        await buffer_event(redis, task_id, event)
                        await sessions.broadcast_to_task(task_id, event)

        final = {"type": "response_final", "task_id": task_id}
        await buffer_event(redis, task_id, final)
        await sessions.broadcast_to_task(task_id, final)
    except Exception as exc:
        logger.error("text turn error task=%s: %s", task_id, exc)
        await session.send_json(
            {"type": "task_status", "task_id": task_id, "status": "error"}
        )
