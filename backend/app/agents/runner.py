"""Agent runner - executes a single agent turn with tool loop."""

import logging
import json
from typing import AsyncIterator, Optional
from app.llm import router as llm_router
from app.tools import registry as tool_registry
from app.memory.memory import memory

log = logging.getLogger(__name__)


async def run_agent_turn_streaming(agent_config: dict, messages: list, tools_list: list,
                                   dispatch_depth: int = 0) -> AsyncIterator[dict]:
    """Run a single agent turn with streaming response and tool use.

    Yields:
        - {"type": "text", "text": "..."} for text deltas
        - {"type": "tool_call", "tool_call": {...}} for tool calls
        - {"type": "done"} when complete
        - {"type": "error", "error": "..."} on error
    """
    agent_id = agent_config.get("id")
    model = agent_config.get("model")
    system_prompt = agent_config.get("system_prompt")

    if not system_prompt or not model:
        yield {"type": "error", "error": "Missing agent config: system_prompt or model"}
        return

    # Build the messages list with system prompt
    full_messages = [{"role": "system", "content": system_prompt}] + messages

    # Prepare tools for the LLM
    llm_tools = None
    if tools_list:
        llm_tools = tools_list

    # Stream the LLM response
    full_response = ""
    tool_calls = []
    accumulated_tool_call = None

    try:
        async for chunk in llm_router.stream_chat(full_messages, model, llm_tools):
            if chunk.get("type") == "text":
                text = chunk["text"]
                full_response += text
                yield {"type": "text", "text": text}

            elif chunk.get("type") == "tool_call":
                tool_call = chunk["tool_call"]
                # Accumulate tool calls (they may come in pieces)
                if accumulated_tool_call is None:
                    accumulated_tool_call = tool_call
                else:
                    # Merge with accumulated
                    if "arguments" in tool_call and accumulated_tool_call:
                        accumulated_tool_call["arguments"] = accumulated_tool_call.get("arguments", "") + tool_call.get("arguments", "")

            elif chunk.get("type") == "done":
                # Finalize any accumulated tool call
                if accumulated_tool_call:
                    tool_calls.append(accumulated_tool_call)
                    accumulated_tool_call = None

                yield {"type": "done"}

            elif chunk.get("error"):
                log.error(f"LLM error: {chunk['error']}")
                yield {"type": "error", "error": chunk["error"]}
                return

    except Exception as e:
        log.error(f"Error during agent turn: {e}")
        yield {"type": "error", "error": str(e)}
        return

    # Execute any tool calls
    if tool_calls:
        for tool_call in tool_calls:
            tool_name = tool_call.get("name", "")
            tool_args = tool_call.get("arguments", {})

            if isinstance(tool_args, str):
                try:
                    tool_args = json.loads(tool_args)
                except json.JSONDecodeError:
                    tool_args = {}

            log.info(f"Agent executing tool: {tool_name}")

            context = {
                "agent_id": agent_id,
                "dispatch_depth": dispatch_depth,
            }

            # Execute the tool
            tool_result = await tool_registry.execute_tool(tool_name, tool_args, context)

            yield {"type": "tool_result", "tool_name": tool_name, "result": tool_result}

            # Check if this was a dispatch request
            try:
                result_json = json.loads(tool_result)
                if isinstance(result_json, dict) and result_json.get("type") == "dispatch":
                    # Dispatch to another agent
                    dispatch_agent = {
                        "id": result_json.get("agent_id"),
                        "system_prompt": result_json.get("system_prompt"),
                        "model": result_json.get("model"),
                    }
                    dispatch_message = result_json.get("message", "")

                    log.info(f"Dispatching to agent: {result_json.get('agent_name')}")

                    # Create a new message list for the dispatched agent
                    dispatch_messages = [{"role": "user", "content": dispatch_message}]

                    # Stream the dispatched agent's response
                    async for dispatched_chunk in run_agent_turn_streaming(
                        dispatch_agent, dispatch_messages, [], dispatch_depth + 1
                    ):
                        yield dispatched_chunk

            except (json.JSONDecodeError, TypeError):
                # Not a dispatch, continue
                pass
