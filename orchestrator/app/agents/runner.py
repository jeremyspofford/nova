"""
AgentRunner — executes a single agent turn:
  1. Retrieve relevant memories + live platform state (async, parallel)
  2. Build the prompt with token budget allocation
  3. Call LLM Gateway — handles tool-use loop internally until final answer
  4. Store new memories from the conversation
  5. Log usage (fire-and-forget — never blocks response)
  6. Return the response
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import Callable
from datetime import datetime, timezone
from uuid import UUID

from app.clients import get_llm_client, get_memory_client_async
from app.config import settings
from app.stimulus import emit_stimulus
from app.store import get_redis
from app.tool_permissions import resolve_effective_tools
from app.tools import execute_tool, get_all_tools
from app.tools.checkpoint_tools import CHECKPOINT_TOOL_NAME, HumanCheckpointPending
from nova_contracts import (
    CompleteRequest,
    Message,
    TaskResult,
    TaskStatus,
    ToolCallRef,
)

log = logging.getLogger(__name__)

# Markdown links to external http(s) URLs, e.g. [Blog post](https://…). Used to
# detect fabricated citations when no web tool actually ran (see the guard in
# run_agent_turn_streaming).
_CITATION_LINK_RE = re.compile(r"\[[^\]]+\]\(https?://[^)]+\)")

# Replay-streaming of an already-generated answer (the tool-reuse path): reveal
# it in small chunks so it looks like a live stream. ~48 chars every 15ms ≈
# 3k chars/sec — fast enough to feel snappy, smooth enough to read as it lands.
_REPLAY_CHUNK = 48
_REPLAY_DELAY_S = 0.015

# web_search/web_fetch results are formatted as "N. Title\n   https://url\n ...".
# This pulls (title, url) pairs so the UI can show where data came from.
_SOURCE_TITLE_RE = re.compile(r"^\s*\d+\.\s+(.+?)\s*$")
_SOURCE_URL_RE = re.compile(r"https?://[^\s)]+")


def _parse_checkpoint_pending(result: str) -> dict | None:
    """Return the checkpoint payload if a tool result is a pending checkpoint."""
    try:
        data = json.loads(result)
    except (TypeError, ValueError):
        return None
    if (
        isinstance(data, dict)
        and data.get("status") == "checkpoint_pending"
        and data.get("approval_id")
    ):
        return data
    return None


def _extract_web_sources(result: str, limit: int = 8) -> list[dict]:
    """Parse (title, url) pairs from a web tool's formatted result text."""
    if not result:
        return []
    sources: list[dict] = []
    lines = result.split("\n")
    for i, line in enumerate(lines):
        m = _SOURCE_TITLE_RE.match(line)
        if not m:
            continue
        title = m.group(1).strip()
        # URL is usually on the next line (or on the title line itself).
        url = None
        for probe in (line, lines[i + 1] if i + 1 < len(lines) else ""):
            um = _SOURCE_URL_RE.search(probe)
            if um:
                url = um.group(0).rstrip(".,)")
                break
        if url:
            sources.append({"title": title[:120] or url, "url": url})
        if len(sources) >= limit:
            break
    # Fallback: a plain list of URLs with no numbered titles (e.g. web_fetch).
    if not sources:
        seen = set()
        for um in _SOURCE_URL_RE.finditer(result):
            u = um.group(0).rstrip(".,)")
            if u not in seen:
                seen.add(u)
                sources.append({"title": u, "url": u})
            if len(sources) >= limit:
                break
    return sources


async def run_agent_turn(
    agent_id: str,
    task_id: UUID,
    session_id: str,
    messages: list[dict],
    model: str,
    system_prompt: str,
    api_key_id: UUID | None = None,
    explicit_model: bool = False,
    agent_name: str = "Chat",
    tenant_id: str | None = None,
    skip_memory_storage: bool = False,
) -> TaskResult:
    """Execute one agent turn: memory retrieval → LLM call → memory storage → usage log.

    tenant_id threads through to the memory-service /context call, the
    ingestion queue payload, and /mark-used feedback (FC-001). When the caller
    is an API key, derive it from AuthenticatedKey.tenant_id at the router.

    skip_memory_storage skips the ingestion-queue push of the user/assistant
    exchange. Used by the quality benchmark runner so synthetic conversations
    don't pollute production memory (their seeded items carry a
    benchmark_run_id for teardown, but the live exchanges would not).
    """
    from app.usage import log_usage

    started_at = datetime.now(timezone.utc)

    try:
        from nova_contracts import extract_text_content

        user_messages = [m for m in messages if m.get("role") == "user"]
        query = extract_text_content(user_messages[-1]["content"]) if user_messages else ""

        # Heartbeat for PERF-003 phase 2: lets memory-service consolidation
        # defer LLM-heavy phases while the user is actively chatting.
        _bump_activity_heartbeat()

        # Notify Cortex of new user message (fire-and-forget)
        try:
            await emit_stimulus("message.received", {
                "session_id": session_id,
                "preview": query[:100] if query else "",
            })
        except Exception as e:
            # Best-effort side channel — but log so a broken stimulus bus
            # (which silences the live brain view + cortex reactions) leaves a trace.
            log.debug("stimulus emit failed: %s", e)

        # 1. Resolve tool permissions (fast DB read — before the gather)
        effective_tools, disabled_groups = await resolve_effective_tools()

        # 2. Fetch context concurrently (+ intelligent routing when auto-model)
        from app.model_classifier import classify_and_resolve

        async def _noop_classify():
            return (None, None)

        classify_coro = classify_and_resolve(query) if (not explicit_model and query) else _noop_classify()

        nova_ctx, (category, classified_model) = await asyncio.gather(
            _build_nova_context(model, agent_id, session_id, effective_tools, disabled_groups),
            classify_coro,
        )

        # Memory fetch — mode-dependent (outside gather so we can branch)
        if settings.memory_retrieval_mode == "tools":
            # Lightweight priming — agent uses memory tools for depth
            memory_ctx = await _get_domain_priming(session_id)
            _mem_count, _memory_ids, _memory_summaries, _retrieval_log_id = 0, [], [], None
        else:
            # Legacy: full 40% context injection
            memory_ctx, _mem_count, _memory_ids, _memory_summaries, _retrieval_log_id = await _get_memory_context(
                agent_id, query, session_id, tenant_id=tenant_id,
            )

        if classified_model:
            model = classified_model

        # 3. Build prompt
        prompt_messages = _build_prompt(system_prompt, nova_ctx, memory_ctx, messages, model=model)

        # 4. LLM call with tool loop
        assistant_content, input_tokens, output_tokens, cost_usd = await _run_tool_loop(
            messages=prompt_messages,
            model=model,
            metadata={"agent_id": agent_id, "task_id": str(task_id), "session_id": session_id},
            tools=effective_tools,
        )

        # 4. Store exchange in episodic memory (skipped for benchmark runs)
        if not skip_memory_storage:
            await _store_exchange(agent_id, session_id, query, assistant_content, tenant_id=tenant_id)

        # 4b. Mark memories as used (usage signal for ranking feedback)
        await _mark_memories_used(_memory_ids, _retrieval_log_id, tenant_id=tenant_id)

        completed_at = datetime.now(timezone.utc)
        duration_ms = int((completed_at - started_at).total_seconds() * 1000)

        # 5. Log usage — fire-and-forget, no await
        _usage_meta = {"task_type": "chat"}
        if _memory_ids:
            _usage_meta["memory_ids"] = _memory_ids
        log_usage(
            api_key_id=api_key_id,
            agent_id=UUID(agent_id),
            session_id=session_id,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost_usd,
            duration_ms=duration_ms,
            metadata=_usage_meta,
            agent_name=agent_name,
        )

        return TaskResult(
            task_id=task_id,
            agent_id=UUID(agent_id),
            status=TaskStatus.completed,
            response=assistant_content,
            started_at=started_at,
            completed_at=completed_at,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

    except Exception as e:
        log.error("Agent turn failed for task %s: %s", task_id, e, exc_info=True)
        return TaskResult(
            task_id=task_id,
            agent_id=UUID(agent_id),
            status=TaskStatus.failed,
            error=str(e),
            started_at=started_at,
        )


async def run_agent_turn_streaming(
    agent_id: str,
    task_id: UUID,
    session_id: str,
    messages: list[dict],
    model: str,
    system_prompt: str,
    api_key_id: UUID | None = None,
    skip_tool_preresolution: bool = False,
    explicit_model: bool = False,
    guest_mode: bool = False,
    allowed_tools: list[str] | None = None,
    agent_name: str = "Chat",
    tenant_id: str | None = None,
):
    """Streaming variant — yields text deltas as they arrive from the LLM.

    Tool-use strategy: by default, resolve tool-call rounds non-streaming
    (fast, tool calls rarely produce large output), then stream the final
    answer turn.

    When skip_tool_preresolution=True (used by interactive chat), tools are
    passed directly to the streaming call — the model can use them inline
    without an extra non-streaming round-trip. This cuts first-token latency
    roughly in half for conversational messages.

    When guest_mode=True, context retrieval (nova_context, memory) and tools
    are skipped entirely — the model receives only the system prompt and user
    messages with no platform state or tool access.
    """
    from app.usage import log_usage
    from nova_contracts import extract_text_content

    started_at = datetime.now(timezone.utc)
    user_messages = [m for m in messages if m.get("role") == "user"]
    query = extract_text_content(user_messages[-1]["content"]) if user_messages else ""

    # Heartbeat for PERF-003 phase 2 — see run_agent_turn above.
    _bump_activity_heartbeat()

    # Notify Cortex of new user message (fire-and-forget)
    try:
        await emit_stimulus("message.received", {
            "session_id": session_id,
            "preview": query[:100] if query else "",
        })
    except Exception as e:
        log.debug("stimulus emit failed: %s", e)

    category = None
    _memory_ids: list[str] = []
    _retrieval_log_id: str | None = None

    # Resolve tool permissions before context build (fast DB read)
    effective_tools, disabled_groups = await resolve_effective_tools(allowed_tools)

    if guest_mode:
        # Guest isolation: no context, no memory, no tools, no classification
        nova_ctx = ""
        memory_ctx = ""
        memory_count = 0
        yield json.dumps({"status": {"step": "model", "state": "done", "detail": model}})
    else:
        # Intelligent routing: classify in parallel with context retrieval
        from app.model_classifier import classify_and_resolve

        will_classify = not explicit_model and query

        async def _noop_classify():
            return (None, None)

        classify_coro = classify_and_resolve(query) if will_classify else _noop_classify()

        # Emit "running" status for parallel steps before the gather
        if will_classify:
            yield json.dumps({"status": {"step": "classifying", "state": "running"}})
        yield json.dumps({"status": {"step": "memory", "state": "running"}})

        # Wrap coroutines to track individual timings
        async def _timed(coro):
            t = time.monotonic()
            result = await coro
            return result, int((time.monotonic() - t) * 1000)

        (nova_ctx, _ctx_ms), ((category, classified_model), cls_ms) = await asyncio.gather(
            _timed(_build_nova_context(model, agent_id, session_id, effective_tools, disabled_groups)),
            _timed(classify_coro),
        )

        # Memory fetch — mode-dependent (outside gather so we can branch)
        if settings.memory_retrieval_mode == "tools":
            _mem_t = time.monotonic()
            memory_ctx = await _get_domain_priming(session_id)
            mem_ms = int((time.monotonic() - _mem_t) * 1000)
            memory_count, _memory_ids, _memory_summaries, _retrieval_log_id = 0, [], [], None
        else:
            _mem_t = time.monotonic()
            memory_ctx, memory_count, _memory_ids, _memory_summaries, _retrieval_log_id = await _get_memory_context(
                agent_id, query, session_id, tenant_id=tenant_id,
            )
            mem_ms = int((time.monotonic() - _mem_t) * 1000)

        # Emit "done" status with per-step timings
        if will_classify:
            yield json.dumps({"status": {"step": "classifying", "state": "done", "detail": category or "general", "elapsed_ms": cls_ms}})
        mem_detail = f"{memory_count} memor{'y' if memory_count == 1 else 'ies'}" if memory_count else "no memories"
        mem_status: dict = {"step": "memory", "state": "done", "detail": mem_detail, "elapsed_ms": mem_ms}
        if _memory_ids:
            mem_status["memory_ids"] = _memory_ids
        if _memory_summaries:
            mem_status["memory_summaries"] = _memory_summaries
        yield json.dumps({"status": mem_status})

        if classified_model:
            model = classified_model

        # Emit model selection status
        yield json.dumps({"status": {"step": "model", "state": "done", "detail": model}})

    prompt_messages = _build_prompt(system_prompt, nova_ctx, memory_ctx, messages, model=model)

    resolved_content = ""  # answer the tool loop produced (non-guest path)
    if guest_mode:
        # Guest mode: no tools at all
        streaming_messages = prompt_messages
        used_tools = False
    else:
        # Resolve tool calls before streaming the final response.
        # The tool loop calls the LLM, executes any tool calls, feeds results
        # back, and repeats up to 5 rounds. The final text is then streamed.
        # Tool status events are yielded in real-time via an asyncio.Queue so
        # the dashboard sidebar shows each tool call as it happens.
        tool_queue: asyncio.Queue[str] = asyncio.Queue()

        async def _push_tool_status(status: dict) -> None:
            await tool_queue.put(json.dumps({"status": status}))

        async def _push_thinking(text: str) -> None:
            # The model's planning prose from a tool round ("I'll search for
            # X…"). Streamed to the UI as a live thinking block — previously
            # this text was silently discarded.
            await tool_queue.put(json.dumps({"think": text}))

        resolve_task = asyncio.create_task(_resolve_tool_rounds(
            messages=prompt_messages,
            model=model,
            metadata={"agent_id": agent_id, "session_id": session_id},
            tools=effective_tools,
            on_tool_status=_push_tool_status,
            on_thinking=_push_thinking,
        ))

        # Drain tool status events while the tool loop runs concurrently
        while not resolve_task.done():
            try:
                event = await asyncio.wait_for(tool_queue.get(), timeout=0.05)
                yield event
            except asyncio.TimeoutError:
                continue

        # Propagate any exception from the tool loop
        streaming_messages, used_tools, resolved_content = resolve_task.result()

        # Drain any remaining queued events
        while not tool_queue.empty():
            yield tool_queue.get_nowait()

    # Did a web tool actually execute this turn? Used by the fabricated-citation
    # guard below: a weak model often narrates "search results" and invents URLs
    # without ever calling web_search. Tool result messages carry role="tool"
    # and the tool name.
    web_tool_ran = any(
        getattr(m, "role", None) == "tool"
        and getattr(m, "name", None) in ("web_search", "web_fetch", "browser_open",
                                         "browser_snapshot", "browser_navigate")
        for m in streaming_messages
    )

    # Final streaming turn: we want a text answer, not another tool call.
    # Tool rounds were already resolved above, so offering tools here lets a
    # weak model emit yet another tool call — which streams zero text and the
    # user sees nothing after the tool status. Anthropic's API *requires*
    # tools= to be present whenever the message history references tool_use
    # content, so we keep them for claude models; every other provider (local
    # models like ollama/lmstudio, OpenAI-compatible endpoints) gets an empty
    # tool list, forcing a text response.
    llm_client = get_llm_client()
    full_response: list[str] = []
    stream_input_tokens = 0
    stream_output_tokens = 0
    stream_cost_usd: float | None = None

    if used_tools and resolved_content.strip():
        # The tool loop already produced the final answer (the model stopped
        # calling tools and wrote a response). Stream that directly instead of
        # re-generating — a second pass doubles latency and, on slow local
        # models, often times out before producing any text. This is the
        # common path once a tool has run.
        yield json.dumps({"status": {"step": "generating", "state": "running", "model": model, "category": category}})
        full_response.append(resolved_content)
        # Replay-stream the already-generated answer in small chunks so it
        # appears progressively (like a live token stream) instead of dumping
        # 1000+ chars at once. The content is real; only the reveal is paced.
        for i in range(0, len(resolved_content), _REPLAY_CHUNK):
            yield resolved_content[i:i + _REPLAY_CHUNK]
            await asyncio.sleep(_REPLAY_DELAY_S)
    else:
        # Final streaming turn: we want a text answer, not another tool call.
        # Anthropic's API *requires* tools= present when the message history
        # references tool_use content, so we keep them for claude models; every
        # other provider (local models, OpenAI-compatible endpoints) gets an
        # empty tool list, forcing a text response.
        is_anthropic = model.startswith("claude")
        final_tools = effective_tools if (used_tools and is_anthropic) else []
        complete_req = CompleteRequest(
            model=model,
            messages=streaming_messages,
            tools=final_tools,
            stream=True,
            metadata={"agent_id": agent_id, "session_id": session_id},
        )

        # Emit generating status (replaces old meta event — info is carried by status steps)
        yield json.dumps({"status": {"step": "generating", "state": "running", "model": model, "category": category}})

        async with llm_client.stream("POST", "/stream", json=complete_req.model_dump()) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line or line == "data: [DONE]":
                    continue
                if line.startswith("data: "):
                    chunk_data = json.loads(line[6:])
                    if "error" in chunk_data:
                        raise RuntimeError(
                            f"LLM Gateway error ({chunk_data.get('provider', 'unknown')}): "
                            f"{chunk_data['error']}"
                        )
                delta = chunk_data.get("delta", "")
                if delta:
                    full_response.append(delta)
                    yield delta
                # Capture token counts from the final chunk (sent by providers)
                if chunk_data.get("input_tokens") is not None:
                    stream_input_tokens = chunk_data["input_tokens"]
                if chunk_data.get("output_tokens") is not None:
                    stream_output_tokens = chunk_data["output_tokens"]
                if chunk_data.get("cost_usd") is not None:
                    stream_cost_usd = chunk_data["cost_usd"]

    # Empty-stream fallback: if the model produced no text (e.g. it tried to
    # emit another tool call instead of answering, or returned an empty turn),
    # do one text-only non-streaming completion so the user never gets silence
    # after the tool status. Tools are stripped to force a textual answer.
    if not full_response:
        log.warning(
            "Streaming turn produced no text (model=%s, used_tools=%s) — "
            "falling back to a text-only completion", model, used_tools,
        )
        try:
            fallback_req = CompleteRequest(
                model=model,
                messages=streaming_messages,
                tools=[],
                metadata={"agent_id": agent_id, "session_id": session_id},
            )
            fb = await llm_client.post("/complete", json=fallback_req.model_dump())
            fb.raise_for_status()
            fb_data = fb.json()
            text = fb_data.get("content", "") or ""
            if text:
                full_response.append(text)
                yield text
                if fb_data.get("input_tokens") is not None:
                    stream_input_tokens = fb_data["input_tokens"]
                if fb_data.get("output_tokens") is not None:
                    stream_output_tokens = fb_data["output_tokens"]
                if fb_data.get("cost_usd") is not None:
                    stream_cost_usd = fb_data["cost_usd"]
        except Exception as e:
            log.warning("Empty-stream fallback completion failed: %s", e)

    # Fabricated-citation guard: if the model cited external URLs (markdown
    # links) but no web/browser tool actually ran this turn, those links are
    # invented — a model can't know real current URLs without fetching them.
    # Append an honest disclaimer so users don't trust (or click) fake sources.
    # Runs only when the answer contains markdown http links, so normal
    # answers are untouched.
    if full_response and not web_tool_ran:
        answer_text = "".join(full_response)
        fabricated = _CITATION_LINK_RE.findall(answer_text)
        if fabricated:
            log.warning(
                "Response cited %d external URL(s) but no web tool ran "
                "(model=%s) — appending unverified-citations note",
                len(fabricated), model,
            )
            note = (
                "\n\n---\n"
                "> ⚠️ **Unverified:** I did not run a live web search this turn, "
                "so the link(s) above were generated from memory and may be "
                "inaccurate or dead. Turn on web search (or ask me to search) "
                "for verified, current sources."
            )
            full_response.append(note)
            yield note

    if full_response:
        await _store_exchange(agent_id, session_id, query, "".join(full_response), tenant_id=tenant_id)
        await _mark_memories_used(_memory_ids, _retrieval_log_id, tenant_id=tenant_id)

    completed_at = datetime.now(timezone.utc)
    duration_ms = int((completed_at - started_at).total_seconds() * 1000)
    _usage_meta = {"task_type": "chat"}
    if _memory_ids:
        _usage_meta["memory_ids"] = _memory_ids
    log_usage(
        api_key_id=api_key_id,
        agent_id=UUID(agent_id),
        session_id=session_id,
        model=model,
        input_tokens=stream_input_tokens,
        output_tokens=stream_output_tokens,
        cost_usd=stream_cost_usd,
        duration_ms=duration_ms,
        metadata=_usage_meta,
        agent_name=agent_name,
    )

    # Phase 4b: Pre-warm memory cache for the next message in this session
    if settings.memory_prewarm_enabled and not guest_mode and query:
        asyncio.create_task(_prewarm_memory(session_id, query, tenant_id=tenant_id))


async def _get_domain_priming(session_id: str) -> str:
    """Fetch lightweight domain awareness for agent priming.

    Returns a ~200-token summary of what Nova knows (topics, source titles,
    counts) — enough for the agent to know what to look up via memory tools,
    without consuming significant context.
    """
    try:
        memory_client = await get_memory_client_async()

        lines = []

        # The bundle's root index (empty-query context) is the overview the
        # OKF backend maintains for exactly this purpose.
        resp = await memory_client.post(
            "/api/v1/memory/context",
            json={"query": "", "session_id": session_id},
        )
        if resp.status_code == 200:
            ctx = resp.json().get("context", "")
            if ctx:
                lines.append("## Your Knowledge")
                lines.append(ctx)

        lines.append("Use your memory tools (search_memory, recall_topic, read_memory) to retrieve details, and remember() to store durable learnings.")
        return "\n".join(lines)
    except Exception as e:
        log.warning("Domain priming fetch failed: %s", e)
        return ""


async def _get_memory_context(
    agent_id: str,
    query: str,
    session_id: str = "",
    tenant_id: str | None = None,
) -> tuple[str, int, list[str], list[dict], str | None]:
    """Fetch memory context for prompt assembly.

    Calls the neutral /context endpoint which returns a formatted prompt
    string. Returns (context_string, section_count, memory_ids,
    memory_summaries, retrieval_log_id).
    """
    if not query:
        return "", 0, [], [], None

    # Check pre-warmed cache first (Phase 4b optimization)
    if settings.memory_prewarm_enabled and session_id:
        try:
            redis = get_redis()
            cache_key = f"nova:memory_cache:{session_id}"
            cached = await redis.get(cache_key)
            if cached:
                await redis.delete(cache_key)  # One-shot: consume after use
                data = json.loads(cached)
                context = data.get("context", "")
                if context:
                    meta = data.get("metadata", {})
                    sections = meta.get("sections", {})
                    section_count = sum(1 for v in sections.values() if v) or 1
                    memory_ids = data.get("memory_ids", [])
                    memory_summaries = meta.get("memory_summaries", [])
                    retrieval_log_id = data.get("retrieval_log_id")
                    log.debug("Memory cache hit for session %s", session_id)
                    return context, section_count, memory_ids, memory_summaries, retrieval_log_id
        except Exception as e:
            log.debug("Memory cache lookup failed (falling through): %s", e)

    memory_client = await get_memory_client_async()
    try:
        body = {"query": query, "session_id": session_id}
        if tenant_id:
            body["tenant_id"] = tenant_id
        resp = await memory_client.post(
            "/api/v1/memory/context",
            json=body,
        )
        if resp.status_code != 200:
            return "", 0, [], [], None
        data = resp.json()
        context = data.get("context", "")
        if not context:
            return "", 0, [], [], None
        meta = data.get("metadata", {})
        sections = meta.get("sections", {})
        section_count = sum(1 for v in sections.values() if v) or 1
        memory_ids = data.get("memory_ids", [])
        memory_summaries = meta.get("memory_summaries", [])
        retrieval_log_id = data.get("retrieval_log_id")
        return context, section_count, memory_ids, memory_summaries, retrieval_log_id
    except Exception as e:
        log.warning("Memory retrieval failed: %s", e)
        return "", 0, [], [], None


async def _prewarm_memory(session_id: str, query: str, tenant_id: str | None = None) -> None:
    """Pre-fetch memory context for likely follow-up queries in this session.

    Called as a fire-and-forget task after a chat response is fully streamed.
    The result is cached in Redis so the next _get_memory_context() call for
    the same session gets a near-instant cache hit instead of waiting for the
    memory-service round-trip.
    """
    try:
        redis = get_redis()
        cache_key = f"nova:memory_cache:{session_id}"

        # Fetch fresh context from memory-service
        memory_client = await get_memory_client_async()
        body = {"query": query, "session_id": session_id}
        if tenant_id:
            body["tenant_id"] = tenant_id
        resp = await memory_client.post(
            "/api/v1/memory/context",
            json=body,
        )
        if resp.status_code == 200:
            await redis.setex(
                cache_key,
                settings.memory_prewarm_ttl_seconds,
                json.dumps(resp.json()),
            )
            log.debug("Pre-warmed memory cache for session %s", session_id)
    except Exception as e:
        log.debug("Memory pre-warm failed (non-critical): %s", e)


async def _get_platform_identity() -> tuple[str, str]:
    """
    Load the AI name and persona from platform_config.
    Returns (name, persona). Defaults to ("Nova", "") on any failure.
    """
    from app.db import get_pool
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT key, value #>> '{}' AS val "
                "FROM platform_config WHERE key IN ('nova.name', 'nova.persona')"
            )
        result = {r["key"]: r["val"] for r in rows}
        raw_name = result.get("nova.name") or "Nova"
        raw_persona = result.get("nova.persona") or ""
        # Strip one layer of JSON quoting if double-encoded
        name = json.loads(raw_name) if raw_name.startswith('"') else raw_name
        persona = json.loads(raw_persona) if raw_persona.startswith('"') else raw_persona
        return str(name).strip(), str(persona).strip()
    except Exception as exc:
        log.debug("Could not load platform identity: %s", exc)
        return "Nova", ""


async def _safe_list_agents(agent_id: str) -> str:
    """Format the active agents list, returning a safe fallback on error."""
    from app.store import list_agents
    try:
        all_agents = await list_agents()
        active = [a for a in all_agents if a.status.value != "stopped"]
        if active:
            lines = []
            for a in sorted(active, key=lambda x: x.created_at):
                marker = " <- YOU" if str(a.id) == agent_id else ""
                lines.append(
                    f"  - {a.config.name}  id={a.id}"
                    f"  model={a.config.model}  status={a.status.value}{marker}"
                )
            return "\n".join(lines)
        return "  (none registered yet)"
    except Exception as e:
        log.warning("Could not fetch agent list for nova_context: %s", e)
        return "  (unavailable)"


async def _safe_list_goals() -> str:
    """Load active/paused goals for injection into the chat context."""
    try:
        from app.db import get_pool
        pool = get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT title, status, priority, progress, iteration "
                "FROM goals WHERE status IN ('active', 'paused') "
                "ORDER BY priority ASC, created_at ASC LIMIT 10"
            )
        if not rows:
            return ""
        lines = ["\n\n### Active Goals"]
        for r in rows:
            pct = round(r["progress"] * 100)
            lines.append(
                f"  - [{r['status']}] {r['title']}  "
                f"(priority={r['priority']}, progress={pct}%, iter={r['iteration']})"
            )
        return "\n".join(lines)
    except Exception as e:
        log.debug("Could not load goals for context: %s", e)
        return ""


def _format_tool_list(tools: list) -> str:
    """Generate a concise tool list for the system prompt from effective tools.

    Groups tools by their registry group and formats as:
      Group: tool_name — first sentence of description
    MCP tools are grouped under their server name.
    """
    from app.tools import get_registry

    # Build group membership lookup from registry
    tool_to_group: dict[str, str] = {}
    group_order: list[str] = []
    for g in get_registry():
        group_order.append(g.name)
        for t in g.tools:
            tool_to_group[t.name] = g.name

    # Categorize effective tools
    grouped: dict[str, list[str]] = {}
    for t in tools:
        if t.name.startswith("mcp__"):
            parts = t.name.split("__")
            group = f"MCP: {parts[1]}" if len(parts) >= 2 else "MCP"
        else:
            group = tool_to_group.get(t.name, "Other")
        grouped.setdefault(group, [])
        # First sentence of description
        desc = (t.description or "").split(".")[0].strip()
        entry = f"{t.name} — {desc}" if desc else t.name
        grouped[group].append(entry)

    # Format: registry groups first (in order), then MCP groups sorted
    lines: list[str] = []
    seen: set[str] = set()
    for group_name in group_order:
        if group_name in grouped:
            tools_str = ", ".join(grouped[group_name])
            lines.append(f"  {group_name}: {tools_str}")
            seen.add(group_name)
    for group_name in sorted(grouped.keys()):
        if group_name not in seen:
            tools_str = ", ".join(grouped[group_name])
            lines.append(f"  {group_name}: {tools_str}")

    return "\n".join(lines) if lines else "  (no tools available)"


def _sandbox_context() -> str:
    """Build a context string describing the current sandbox tier and its implications."""
    from app.tools.sandbox import SandboxTier, get_root, get_sandbox

    tier = get_sandbox()
    root = str(get_root()) if tier != SandboxTier.isolated else "(none)"

    descriptions = {
        SandboxTier.workspace: (
            f"Sandbox tier: workspace\n"
            f"Filesystem root: {root}  (all file/shell paths are relative to this)\n"
            f"You have access to the user's workspace directory. "
            f"You cannot access files outside this directory."
        ),
        SandboxTier.home: (
            f"Sandbox tier: home (home directory access)\n"
            f"Filesystem root: {root}  (all file/shell paths are relative to this)\n"
            f"You have access to the user's home directory on the host. "
            f"You can read and modify personal files, dotfiles, and local projects. "
            f"Be careful with changes that could affect the user's environment."
        ),
        SandboxTier.isolated: (
            "Sandbox tier: isolated (no filesystem access)\n"
            "You have no filesystem or shell access. You can only respond with text."
        ),
    }
    base = descriptions.get(tier, f"Sandbox tier: {tier.value}\nFilesystem root: {root}")

    from app.tools.sandbox import NOVA_SOURCE_ROOT, is_self_modification_enabled
    if is_self_modification_enabled():
        base += (
            f"\n\nSelf-modification: ENABLED\n"
            f"Nova source code: {NOVA_SOURCE_ROOT}  (read/write access to Nova's own services)\n"
            f"Scratch workspace: {NOVA_SOURCE_ROOT}/workspace  (clone repos, build artifacts, temp work)\n"
            f"Changes to Nova's code take effect after the affected service restarts."
        )

    return base


def _build_self_knowledge(name: str) -> str:
    """Compact self-knowledge for interactive chat prompts.

    Deliberately small. Large system prompts drown small local models and burn
    context budget; the previous ~110-line architecture essay measurably hurt
    tool-use reliability. Detailed platform knowledge belongs in Nova's memory
    (read on demand), not injected on every turn.

    Teaches the model that run_shell is its universal capability, so the tiny
    three-tool surface still covers hardware inspection, web access, and git.

    Only injected when settings.self_knowledge_enabled is True (default).
    Pipeline agents do NOT receive this — they have focused, role-specific prompts.
    """
    return (
        "## About Me\n"
        f"I am {name}, a self-directed AI assistant running as a local Docker stack. "
        "I operate on a real filesystem with a real shell, so I can take action — "
        "not just talk about it.\n"
        "\n"
        "## How I Act\n"
        "My tools are read_file, write_file, and run_shell. run_shell is my "
        "universal capability: anything beyond a plain file read/write, I do by "
        "running a command. For example —\n"
        "- Inspect hardware: `nvidia-smi`, `nproc`, `free -h`, `df -h`, `uname -a`\n"
        "- Search the web: `curl -s 'https://html.duckduckgo.com/html/?q=<query>'`\n"
        "- Find code/files: `rg <pattern>`, `ls`, `find`\n"
        "- Version control: `git status`, `git diff`, `git commit`\n"
        "- Run tests, builds, linters, or any other CLI tool\n"
        "\n"
        "## How I Think\n"
        "- Act, don't ask. If a request needs information a tool can get me, I run "
        "the tool instead of asking the user or guessing.\n"
        "- Verify before asserting. I check the filesystem or shell for facts about "
        "my own state rather than making claims from memory.\n"
        "- Admit uncertainty. If I cannot verify something, I say so plainly.\n"
    )


async def _build_nova_context(
    model: str, agent_id: str, session_id: str,
    effective_tools: list | None = None,
    disabled_groups: set[str] | None = None,
) -> str:
    """
    Build the context blocks injected into every system prompt.

    Order (static -> dynamic for prompt cache hit rate):
      1. ## Identity          - name + persona from platform_config
      2. ## About Me           - platform self-knowledge (architecture, diagnostics)
      3. ## Platform Context   - tools, active agents, session info
      4. ## Response Style     - formatting rules
    """
    # Load identity, agent list, and active goals concurrently
    (name, persona), agents_block, goals_block = await asyncio.gather(
        _get_platform_identity(),
        _safe_list_agents(agent_id),
        _safe_list_goals(),
    )

    # 1. Identity block
    identity_lines = [
        "## Identity",
        f"Your name is {name}.",
    ]
    if persona:
        identity_lines.append("")
        identity_lines.append(persona)
    identity_block = "\n".join(identity_lines)

    # 2. Platform context — tool list is generated dynamically from effective tools
    tool_list_block = _format_tool_list(effective_tools or get_all_tools())

    # Disabled groups notice — lets Nova explain WHY it can't do something
    disabled_notice = ""
    if disabled_groups:
        from app.tools import get_registry
        group_labels = {g.name: g.display_name for g in get_registry()}
        disabled_labels = [group_labels.get(g, g) for g in sorted(disabled_groups)]
        disabled_notice = (
            f"\n\n### Disabled tool groups\n"
            f"The following capabilities are disabled by your admin: {', '.join(disabled_labels)}.\n"
            f"If a user asks you to do something that requires a disabled tool, explain that "
            f"the capability is disabled in Settings and suggest they re-enable it."
        )

    from datetime import date
    platform_block = (
        f"## Platform Context\n"
        f"- Current date:  {date.today().isoformat()}\n"
        f"- Your model:    {model}\n"
        f"- Your agent ID: {agent_id}\n"
        f"- Session ID:    {session_id}\n"
        f"\n### Active agents in this instance:\n"
        f"{agents_block}\n"
        f"\n### Tools available to you:\n"
        f"{tool_list_block}\n"
        f"\n### Filesystem access\n"
        f"{_sandbox_context()}\n"
        f"Shell timeout: {settings.shell_timeout_seconds}s\n"
        f"Answer model-identity questions using 'Your model' above (never guess)."
        f"{disabled_notice}"
        f"{goals_block}"
    )

    # 3. Response style
    style_block = (
        "## Response Style\n"
        "This is a professional developer tool. Follow these rules in every response:\n"
        "- No emoji except as explicit status indicators\n"
        "- No markdown bold/italic for single characters or trivial emphasis\n"
        "- Do not bold the word 'I' or wrap single letters in ** markers\n"
        "- Use plain prose for explanations; tables for structured data; code blocks for code\n"
        "- Be concise and precise - prefer one clear sentence over three vague ones\n"
        "- Never add filler phrases like 'Great question!', 'Certainly!', or 'Of course!'"
    )

    # Self-knowledge block — gives Nova awareness of its own architecture and
    # diagnostic tools so it investigates failures instead of asking the user.
    # Gated on config flag (default: enabled) and only injected for interactive
    # chat — pipeline agents call run_agent_turn_raw which skips this entirely.
    self_knowledge_block = ""
    if settings.self_knowledge_enabled:
        self_knowledge_block = f"\n\n{_build_self_knowledge(name)}"

    # Inject active skills
    skills_block = ""
    try:
        from app.skills import resolve_skills
        skills_block = await resolve_skills()
        if skills_block:
            skills_block = f"\n\n{skills_block}"
    except Exception as e:
        log.debug("Failed to resolve skills: %s", e)

    return f"{identity_block}{self_knowledge_block}{skills_block}\n\n{platform_block}\n\n{style_block}"


async def _resolve_tool_rounds(
    messages: list[Message],
    model: str,
    metadata: dict,
    max_rounds: int = 5,
    tools: list | None = None,
    on_tool_status: Callable | None = None,
    on_thinking: Callable | None = None,
) -> tuple[list[Message], bool, str]:
    """
    Execute any tool-call rounds the LLM requests, returning the enriched
    message list plus the final text the loop produced.

    Returns (messages_with_tool_history, used_tools_flag, final_content).
    final_content is the model's answer once it stopped calling tools — the
    caller can stream it directly instead of re-generating (which matters a
    lot for slow local models, where a second generation can time out).
    """
    content, _, _, _, current, used_tools = await _run_tool_loop(
        messages=messages,
        model=model,
        metadata=metadata,
        tools=tools,
        max_rounds=max_rounds,
        return_messages=True,
        on_tool_status=on_tool_status,
        on_thinking=on_thinking,
    )
    return current, used_tools, content or ""


async def run_agent_turn_raw(
    system_prompt: str,
    user_message: str,
    model: str,
    tools: list | None = None,
    temperature: float = 0.3,
    max_tokens: int = 4096,
    max_rounds: int = 10,
    return_usage: bool = False,
    tool_context: dict | None = None,
    initial_messages: list[Message] | None = None,
) -> str | tuple[str, int, int, float | None]:
    """
    Lightweight agent turn for pipeline stages (ContextAgent, TaskAgent).

    Runs the full tool-use loop and returns the final assistant text.
    No memory retrieval/storage, no usage logging — the pipeline executor
    handles those concerns at the task level.

    Args:
        system_prompt:  Agent's system prompt
        user_message:   User request / constructed prompt
        model:          LLM model identifier (e.g. "llama3.2")
        tools:          Tool definitions to pass to the LLM.
                        None  → ALL_TOOLS  (full access)
                        []    → no tools   (text-only)
                        [...]  → explicit subset
        temperature:    Sampling temperature from pod_agents config
        max_tokens:     Max output tokens from pod_agents config
        max_rounds:     Max tool-use rounds before forcing a final answer
        return_usage:   If True, returns (content, in_tokens, out_tokens, cost_usd)
        initial_messages: Resume a previously-parked conversation instead of
                        building a fresh [system, user] pair — used by the
                        human-checkpoint resume path. Must already contain a
                        tool result for every tool_use.

    Returns:
        The final assistant text response, or a tuple with usage if return_usage=True.
    """
    if initial_messages is not None:
        messages = list(initial_messages)
    else:
        messages = [
            Message(role="system", content=system_prompt),
            Message(role="user",   content=user_message),
        ]
    content, in_tokens, out_tokens, cost_usd = await _run_tool_loop(
        messages=messages,
        model=model,
        metadata={},
        tools=tools,
        temperature=temperature,
        max_tokens=max_tokens,
        max_rounds=max_rounds,
        tool_context=tool_context,
    )
    if return_usage:
        return content, in_tokens, out_tokens, cost_usd
    return content


async def _run_tool_loop(
    messages: list[Message],
    model: str,
    metadata: dict,
    tools: list | None = None,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    max_rounds: int = 5,
    return_messages: bool = False,
    on_tool_status: Callable | None = None,
    on_thinking: Callable | None = None,
    tool_context: dict | None = None,
) -> tuple[str, int, int, float | None] | tuple[str, int, int, float | None, list[Message], bool]:
    """
    Non-streaming tool loop — used by run_agent_turn, run_agent_turn_raw, and _resolve_tool_rounds.
    Returns (content, input_tokens, output_tokens, cost_usd) from the final completion.
    When return_messages=True, also returns (messages, used_tools) for streaming pre-resolution.

    Args:
        tools:  Callers must pass explicit tool list (from resolve_effective_tools).
                None → all tools (fallback for callers that don't manage permissions).
                [] → no tools.
        on_tool_status:  Optional async callback for emitting tool execution status
                         events to the SSE stream.
        on_thinking:  Optional async callback receiving the model's planning
                      prose from tool rounds (the text it writes alongside a
                      tool call), for live display as "thinking".
    """
    effective_tools = get_all_tools() if tools is None else tools
    llm_client = get_llm_client()
    current = list(messages)
    last_completion: dict = {}
    used_tools = False

    for round_num in range(max_rounds):
        req = CompleteRequest(
            model=model,
            messages=current,
            tools=effective_tools,
            temperature=temperature,
            max_tokens=max_tokens,
            metadata=metadata,
        )
        resp = await llm_client.post("/complete", json=req.model_dump())
        resp.raise_for_status()
        last_completion = resp.json()

        tool_calls = last_completion.get("tool_calls", [])
        if not tool_calls:
            break

        if settings.agent_single_tool_call and len(tool_calls) > 1:
            # Local templates that render only one tool call per turn would
            # 400 on replaying this history — keep the first call, the model
            # re-requests the rest next round.
            log.info("Truncating %d parallel tool calls to 1 (agent_single_tool_call)",
                     len(tool_calls))
            tool_calls = tool_calls[:1]

        used_tools = True
        log.info("Tool-use round %d: %d tool call(s)", round_num + 1, len(tool_calls))

        # Surface the model's planning prose (text it wrote alongside the tool
        # call, e.g. "I'll search for recent news…") as live thinking.
        round_prose = (last_completion.get("content") or "").strip()
        if round_prose and on_thinking:
            await on_thinking(round_prose)

        # Set assistant content from completion before delegating to helper
        current.append(Message(
            role="assistant",
            content=last_completion.get("content") or "",
            tool_calls=[
                ToolCallRef(id=tc["id"], name=tc["name"], arguments=tc.get("arguments", {}))
                for tc in tool_calls
            ],
        ))

        for tc_idx, tc in enumerate(tool_calls):
            # Summarize arguments for the "running" status
            args_summary = ""
            args = tc.get("arguments", {})
            if isinstance(args, dict):
                # Pick the most informative argument value as a brief summary
                for key in ("query", "topic", "name", "goal", "text", "url", "id"):
                    if key in args:
                        val = str(args[key])[:60]
                        args_summary = val
                        break
            if on_tool_status:
                await on_tool_status({"step": tc["name"], "state": "running", "detail": args_summary or tc["name"]})

            t0 = time.perf_counter()
            result = await execute_tool(tc["name"], tc.get("arguments", {}), context=tool_context)
            elapsed_ms = int((time.perf_counter() - t0) * 1000)

            # Human checkpoint: the tool created a pending approval — stop the
            # loop so the pipeline executor can park the task. The checkpoint
            # call's own result is deliberately NOT appended: the operator's
            # reply becomes that result on resume. Sibling calls later in this
            # round get synthetic 'skipped' results so every other tool_use id
            # stays answered when the conversation is replayed.
            if tc["name"] == CHECKPOINT_TOOL_NAME:
                pending = _parse_checkpoint_pending(result)
                if pending is not None:
                    for other in tool_calls[tc_idx + 1:]:
                        current.append(Message(
                            role="tool",
                            name=other["name"],
                            tool_call_id=other["id"],
                            content=json.dumps({
                                "status": "skipped",
                                "message": "Not executed — task parked for a human checkpoint. Re-issue this call after resuming if still needed.",
                            }),
                        ))
                    raise HumanCheckpointPending(
                        approval_id=pending["approval_id"],
                        tool_call_id=tc["id"],
                        reason=pending.get("reason", ""),
                        instructions=pending.get("instructions", ""),
                        messages=current,
                    )

            if on_tool_status:
                done_status = {"step": tc["name"], "state": "done", "detail": args_summary or tc["name"], "elapsed_ms": elapsed_ms}
                # Surface the web sources a search/fetch pulled so the user can
                # see (and click) where the answer's data came from.
                if tc["name"] in ("web_search", "web_fetch"):
                    sources = _extract_web_sources(result)
                    if sources:
                        done_status["sources"] = sources
                await on_tool_status(done_status)

            current.append(Message(
                role="tool",
                name=tc["name"],
                tool_call_id=tc["id"],
                content=result,
            ))

        # Tools for this round are done — the next model call is (usually) the
        # answer. Surface a "generating" step now so the UI shows live progress
        # during that generation instead of a silent gap. Harmless if the next
        # round turns out to be another tool call.
        if on_tool_status:
            await on_tool_status({"step": "generating", "state": "running"})

    base = (
        last_completion.get("content", ""),
        last_completion.get("input_tokens", 0),
        last_completion.get("output_tokens", 0),
        last_completion.get("cost_usd"),
    )
    if return_messages:
        return base + (current, used_tools)
    return base


def _build_prompt(
    system_prompt: str,
    nova_context: str,
    memory_context: str,
    messages: list[dict],
    model: str = "",
) -> list[Message]:
    """
    Assemble the full message list with context injected.

    System prompt order (static → dynamic for best prompt cache hit rate):
      1. Base system_prompt  — stable across all turns of a session
      2. Nova context block  — stable per session (model + agent/session IDs)
      3. Memory context      — dynamic, changes as memories accumulate

    For Anthropic models, uses content blocks with cache_control on the static
    prefix (system_prompt + nova_context) so subsequent calls in the same session
    reuse the cached prefix — saving ~50-90% on those tokens.
    """
    is_anthropic = model.startswith("claude")

    if is_anthropic:
        # Anthropic prompt caching: split into cacheable static prefix + dynamic suffix
        static_prefix = f"{system_prompt}\n\n{nova_context}"
        content_blocks = [
            {"type": "text", "text": static_prefix, "cache_control": {"type": "ephemeral"}},
        ]
        if memory_context:
            content_blocks.append({"type": "text", "text": memory_context})
        result = [Message(role="system", content=content_blocks)]
    else:
        sections = [system_prompt, nova_context]
        if memory_context:
            sections.append(memory_context)
        full_system = "\n\n".join(sections)
        result = [Message(role="system", content=full_system)]

    for m in messages:
        result.append(Message(role=m["role"], content=m["content"]))

    return result


# Tools-mode usage feedback needs no post-hoc extraction: memory tools call
# /api/v1/memory/context with mark_used=true, so the backend records usage at
# retrieval time (the agent explicitly asking IS the signal).
async def _store_exchange(
    agent_id: str,
    session_id: str,
    user_message: str,
    assistant_response: str,
    tenant_id: str | None = None,
) -> None:
    """Emit the exchange to the memory ingestion queue.

    The memory-service consumer picks this up asynchronously and routes it
    to the active backend's write().
    """
    await _emit_to_ingestion_queue(agent_id, session_id, user_message, assistant_response, tenant_id=tenant_id)


async def _mark_memories_used(
    memory_ids: list[str],
    retrieval_log_id: str | None,
    tenant_id: str | None = None,
) -> None:
    """Fire-and-forget: tell memory-service which memories were used.

    Initial heuristic: mark ALL context items as used — a coarse but
    functional ranking signal. Refinement can be added later.
    """
    if not retrieval_log_id or not memory_ids:
        return
    try:
        memory_client = await get_memory_client_async()
        body = {
            "retrieval_log_id": retrieval_log_id,
            "used_ids": memory_ids,
        }
        if tenant_id:
            body["tenant_id"] = tenant_id
        await memory_client.post(
            "/api/v1/memory/mark-used",
            json=body,
        )
    except Exception as e:
        log.debug("Failed to mark memories used: %s", e)


_ingestion_redis: object | None = None


def _get_ingestion_redis():
    """Get a Redis client for the memory ingestion queue (memory-service's DB 0)."""
    global _ingestion_redis
    if _ingestion_redis is None:
        import redis.asyncio as aioredis
        # Memory-service uses Redis DB 0 — push to the same DB it consumes from
        base_url = settings.redis_url.rsplit("/", 1)[0]  # strip /2
        _ingestion_redis = aioredis.from_url(f"{base_url}/0", decode_responses=True)
    return _ingestion_redis


def _bump_activity_heartbeat() -> None:
    """Fire-and-forget: write a chat-activity timestamp to memory-service's db0.

    Consolidation reads this key at cycle start; when it's within the
    configured idle window, Phase 2 + 2.5 (the LLM-heavy phases) skip
    so Ollama isn't serializing chat behind schema synthesis.
    Non-fatal on Redis error — worst case, the gate never trips and
    consolidation behaves as before.
    """
    try:
        redis = _get_ingestion_redis()
        # 15-minute TTL is plenty longer than any configured idle window
        # and keeps the key from sticking around after a long outage.
        asyncio.create_task(
            redis.set("nova:activity:last_chat_turn", str(time.time()), ex=900)
        )
    except Exception as e:
        log.debug("Failed to bump activity heartbeat: %s", e)


async def _emit_to_ingestion_queue(
    agent_id: str,
    session_id: str,
    user_message: str,
    assistant_response: str,
    tenant_id: str | None = None,
) -> None:
    """Push a conversation exchange to the memory ingestion queue via Redis LPUSH.

    The memory-service consumer picks it up asynchronously and routes it to
    the active backend's write().
    Pushes to Redis DB 0 (memory-service's DB) regardless of orchestrator's DB.
    """
    try:
        redis = _get_ingestion_redis()

        raw_text = f"User: {user_message}\n\nAssistant: {assistant_response}"
        payload_dict = {
            "raw_text": raw_text,
            "source_type": "chat",
            "source_id": agent_id,
            "session_id": session_id,
            "occurred_at": datetime.now(timezone.utc).isoformat(),
            "metadata": {"agent_id": agent_id, "session_id": session_id},
        }
        if tenant_id:
            payload_dict["tenant_id"] = tenant_id
        payload = json.dumps(payload_dict)
        await redis.lpush("memory:ingestion:queue", payload)
    except Exception as e:
        log.warning("Failed to emit to ingestion queue: %s", e)
