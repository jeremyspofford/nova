"""Agent runner — a real bounded tool loop.

run_agent() streams typed events:
    {"type": "text", "text": str}              top-level agent's answer deltas
    {"type": "activity", "kind": str, ...}     tool/dispatch progress (any depth)
    {"type": "final", "text": str}             the agent's complete final answer
    {"type": "error", "error": str}

dispatch_to_agent is executed inline here (not in the tool registry) so the
sub-agent's own tool loop can stream activity through the same event channel.
Sub-agents get their own allowed_tools, minus dispatch — depth is capped at 1.
"""

import json
import logging
from typing import AsyncIterator, Optional

from app.config import settings
from app.llm import router as llm_router
from app.memory.memory import memory
from app.tools import registry as tool_registry

log = logging.getLogger(__name__)

MAX_DISPATCH_DEPTH = 1


async def _build_system_prompt(agent: dict, query: str) -> str:
    parts = [agent["system_prompt"]]
    try:
        mem = await memory.context(query)
        if mem["context"]:
            parts.append(f"## Relevant Memories\n{mem['context']}")
        skills = await memory.skills_context(query)
        if skills["context"]:
            parts.append(f"## Applicable Skills\n{skills['context']}")
    except Exception:
        log.exception("Memory retrieval failed; continuing without context")
    return "\n\n".join(parts)


async def run_agent(agent: dict, turn_messages: list[dict], *,
                    dispatch_depth: int = 0) -> AsyncIterator[dict]:
    """Run one agent turn (with tool rounds) and stream events.

    turn_messages: chat-format messages for this turn (history + new user msg),
    WITHOUT a system message — that is assembled here so dispatched agents get
    the same memory/skills injection as the main agent.
    """
    query = next((m["content"] for m in reversed(turn_messages)
                  if m["role"] == "user"), "")
    system_prompt = await _build_system_prompt(agent, query)
    messages = [{"role": "system", "content": system_prompt}] + list(turn_messages)

    exclude = {"dispatch_to_agent"} if dispatch_depth >= MAX_DISPATCH_DEPTH else set()
    tools = await tool_registry.get_agent_tools(agent, exclude=exclude)

    ctx = {"agent_id": agent.get("id"), "agent_name": agent.get("name"),
           "dispatch_depth": dispatch_depth,
           "granted": {t["function"]["name"] for t in tools}}

    final_text = ""

    for round_no in range(settings.max_tool_rounds):
        round_text = ""
        tool_calls: list[dict] = []
        errored = False

        async for event in llm_router.stream_chat(messages, agent["model"],
                                                  tools or None):
            etype = event.get("type")
            if etype == "text":
                round_text += event["text"]
                if dispatch_depth == 0:
                    yield {"type": "text", "text": event["text"]}
            elif etype == "tool_calls":
                tool_calls = event["tool_calls"]
            elif etype == "error":
                yield {"type": "error", "error": event["error"]}
                errored = True
                break

        if errored:
            return

        final_text += round_text

        if not tool_calls:
            break  # final answer reached

        # Record the assistant turn that requested the tools
        messages.append({
            "role": "assistant",
            "content": round_text or None,
            "tool_calls": [{"id": tc["id"], "type": "function",
                            "function": {"name": tc["name"],
                                         "arguments": tc["arguments"]}}
                           for tc in tool_calls],
        })

        for tc in tool_calls:
            name = tc["name"]
            try:
                args = json.loads(tc["arguments"]) if tc["arguments"] else {}
            except json.JSONDecodeError:
                args = {}

            yield {"type": "activity", "kind": "tool_start", "name": name,
                   "agent": agent.get("name"), "detail": _brief(args)}

            if name == "dispatch_to_agent":
                result = ""
                async for sub in _run_dispatch(args, dispatch_depth):
                    if sub["type"] == "final":
                        result = sub["text"]
                    elif sub["type"] in ("activity", "error"):
                        yield sub
                if not result:
                    result = "Error: dispatched agent produced no result"
            else:
                result = await tool_registry.execute_tool(name, args, ctx)

            yield {"type": "activity", "kind": "tool_result", "name": name,
                   "agent": agent.get("name"), "detail": result[:200]}

            messages.append({"role": "tool", "tool_call_id": tc["id"],
                             "content": result[:8000]})
    else:
        note = "\n\n[Stopped: reached the tool-round limit for one turn.]"
        final_text += note
        if dispatch_depth == 0:
            yield {"type": "text", "text": note}

    yield {"type": "final", "text": final_text}


async def _run_dispatch(args: dict, parent_depth: int) -> AsyncIterator[dict]:
    """Inline execution of dispatch_to_agent: run the target agent as a nested turn."""
    from app.agents import registry as agent_registry  # late import (cycle-safe)

    agent_name = args.get("agent_name", "")
    message = args.get("message", "")
    if not agent_name or not message:
        yield {"type": "final",
               "text": "Error: agent_name and message are both required"}
        return
    if parent_depth >= MAX_DISPATCH_DEPTH:
        yield {"type": "final",
               "text": "Error: dispatch depth limit reached — cannot dispatch further"}
        return

    agent = await agent_registry.get_agent_by_name(agent_name)
    if not agent or not agent["enabled"]:
        yield {"type": "final",
               "text": f"Error: agent '{agent_name}' not found or disabled. "
                       f"Use list_agents to see the index."}
        return

    yield {"type": "activity", "kind": "dispatch", "name": agent_name,
           "agent": agent_name, "detail": message[:200]}
    log.info("Dispatch -> %s (depth %d)", agent_name, parent_depth + 1)

    sub_final = ""
    async for event in run_agent(agent, [{"role": "user", "content": message}],
                                 dispatch_depth=parent_depth + 1):
        if event["type"] == "final":
            sub_final = event["text"]
        elif event["type"] == "activity":
            yield event
        elif event["type"] == "error":
            sub_final = f"Error from {agent_name}: {event['error']}"

    yield {"type": "final", "text": sub_final or f"[{agent_name} returned nothing]"}


def _brief(args: dict) -> str:
    try:
        return json.dumps(args)[:200]
    except Exception:
        return ""
