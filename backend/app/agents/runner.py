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

import asyncio
import json
import logging
import time
from contextlib import AsyncExitStack
from typing import AsyncIterator, Optional

from app import narration, settings_store, timefmt, trace
from app.agents import context_trim
from app.llm import router as llm_router
from app.memory.memory import memory
from app.tools import registry as tool_registry

log = logging.getLogger(__name__)

MAX_DISPATCH_DEPTH = 1
MAIN_AGENT = "main"  # the agent that IS the assistant — the only soul-wearer

# ── persona-layer phase 1 (docs/plans/persona-layer.md): the runner owns
# prompt assembly in fixed slots — ROLE → FACTS → CONTEXT → LAST WORD.
# Small models obey the END of the prompt, so what lands last is a design
# decision, never an accident. Only Nova gets the soul; specialists are
# their own entities and end with the house rules instead.

# Nova's default channel register (typed chat). Voice turns pass their own
# via system_suffix, which replaces this. Short on purpose — the soul
# carries the full statement; this is the recency-position echo of it.
_TYPED_REGISTER = (
    '## Register\n'
    'Reply as yourself — someone in the room, not a report generator. Size '
    'the answer to the question: simple question, one plain sentence. No '
    'emoji, no sign-offs, no restating the question; structure only when '
    'the answer genuinely is a list or comparison. "thanks" gets '
    '"Anytime.", never "You\'re welcome! Is there anything else I can help '
    'you with today?".'
)

# Specialists' last word: operating norms earned from real incidents (the
# narration incident, the stale-journal platform incident) plus the output
# contract — their reader is Nova, not the operator.
_HOUSE_RULES = (
    "## House rules\n"
    "You are one of {name}'s specialist agents. Your reply goes to {name} "
    "(another model), not to the operator: be dense, structured, and "
    "complete — facts, findings, and references, no pleasantries, no "
    "offers of further help.\n"
    "Act, don't narrate: if you say you are doing something, make the tool "
    "call in the same turn; never claim work you have not started.\n"
    "Memories and journals describe the PAST — for current state, trust "
    "the live facts above and your tools. Say plainly what you don't know "
    "or couldn't do."
)


def _now_block() -> str:
    """The current date/time in the operator's timezone — injected fresh every
    turn so Nova never has to guess the date from memories (it got the weekday
    wrong doing that). The server clock is UTC, so the tz setting wins.

    Phrased as bare data + imperatives: the old "This is the authoritative
    current time" sentence read like an answer, and small voice models
    parroted it verbatim into spoken replies (2026-07-16). Nothing in this
    block should work as a standalone answer sentence."""
    now = timefmt.now_local()
    return ("## Current date and time\n"
            f"{now:%A, %B %-d, %Y}, {timefmt.fmt_clock(now)} {now:%Z}\n"
            "Fresh each turn — trust it over memories or conversation for "
            "all date/time reasoning. If asked the time or date, answer "
            f"with just that, said naturally (\"It's "
            f"{timefmt.fmt_clock(now, ampm=False)}.\"), then "
            "stop — no timezone, no source, none of this section's wording.")


def _model_block(agent: dict) -> str:
    """Which LLM this agent runs on — the binding is resolved on every
    request anyway; hiding it from the agent turned "what model are you?"
    into a dispatch and a shrug (2026-07-17). Same de-quotable shape as
    the date block. Per-agent, so dispatched specialists see their own."""
    raw = agent.get("model") or ""
    if not raw:
        return ""
    model = llm_router.effective_model(raw)
    provider, _, mid = model.partition(":")
    where = {"openrouter": "cloud, via OpenRouter",
             "ollama": "local, via Ollama"}.get(provider, provider)
    swapped = ("" if model == raw else
               " (no OpenRouter key — swapped to the local fallback)")
    return ("## Model (live)\n"
            f"{mid} — {where}{swapped}. Resolved fresh this turn; bindings "
            "live in Settings → Agents.\n"
            "If asked what model you are or run on, answer with just the "
            f"model name, said naturally (\"I'm running on {mid}.\"), then "
            "stop — trust this block over memories, and never claim you "
            "can't check.")


# hardware detection shells out (nvidia-smi) and hits the DB — cache the
# rendered block; hardware changes on the order of reboots, not turns
_platform_cache: tuple[float, str] | None = None
_PLATFORM_TTL_S = 300


async def _platform_block() -> str:
    """Live platform facts — the date-block pattern applied to hardware.

    Exists because Nova asserted stale journal memories as current platform
    state ("GPU passthrough is broken" while detection reported the GPU
    fine — 2026-07-17, ROADMAP item 12). Memories describe the past; this
    block is the present. Empty string on detection failure: a missing
    block must never break a turn."""
    global _platform_cache
    now = time.monotonic()
    if _platform_cache and now - _platform_cache[0] < _PLATFORM_TTL_S:
        return _platform_cache[1]
    try:
        from app import hardware
        hw = await hardware.detect()
        if hw.get("gpu_name"):
            gpu = f"{hw['gpu_name']}, {hw['vram_total_gb']} GB VRAM"
        elif hw.get("unified_gpu"):
            gpu = "unified memory (Apple-class, sized by system RAM)"
        elif hw.get("nvidia_runtime"):
            gpu = "NVIDIA runtime present (VRAM not yet measured)"
        else:
            gpu = "none (CPU-only inference)"
        block = (
            "## Platform facts (live)\n"
            f"GPU: {gpu}. RAM: {hw.get('sizing_ram_gb') or '?'} GB. "
            f"CPU cores: {hw.get('cpu_cores') or '?'}. Detected fresh this "
            "turn, not remembered.\n"
            "If memories or journals disagree with these numbers, the "
            "memories are outdated — detection is working, so never claim "
            "it is broken or ask the operator for these specs. Memories "
            "describe the PAST: problems in them may be long fixed, and "
            "features they call missing may have shipped since. For current "
            "platform state (hardware, installed models, available "
            "capabilities), trust this block and your tools, never a memory.")
        _platform_cache = (now, block)
        return block
    except Exception:
        log.exception("Platform facts unavailable; continuing without them")
        return ""


_entities_cache: tuple[float, str] | None = None
_ENTITIES_TTL_S = 15


async def _entities_block() -> str:
    """Live platform entities — the _platform_block pattern extended to
    rules/agents/automations. Exists because main (a 9B) confidently
    narrated invented rule deletions from a polluted conversation instead
    of looking (2026-07-20 overnight, ROADMAP #12/#29). Models rarely
    hallucinate about text sitting in front of them. Empty string on
    failure: a missing block must never break a turn."""
    global _entities_cache
    now = time.monotonic()
    if _entities_cache and now - _entities_cache[0] < _ENTITIES_TTL_S:
        return _entities_cache[1]
    try:
        from app import automations as automations_store, rules as rules_store
        from app.agents import registry as agent_registry
        rule_rows = await rules_store.list_rules()
        rules_line = ", ".join(
            f"{r['name']} [{r['action']}{', system' if r['is_system'] else ''}"
            f"{', DISABLED' if not r['enabled'] else ''}]"
            for r in rule_rows) or "none"
        agent_rows = await agent_registry.list_agents(enabled_only=False)
        agents_line = ", ".join(
            f"{a['name']}{' [DISABLED]' if not a.get('enabled', True) else ''}"
            for a in agent_rows) or "none"
        auto_rows = await automations_store.list_automations()
        autos_line = ", ".join(
            f"{a['name']} ({'DISABLED' if not a['enabled'] else a.get('last_status') or 'never ran'})"
            for a in auto_rows) or "none"
        block = (
            "## Platform state (live, fetched this turn — not remembered)\n"
            f"Guardrail rules ({len(rule_rows)}): {rules_line}\n"
            f"Agents ({len(agent_rows)}): {agents_line}\n"
            f"Automations ({len(auto_rows)}): {autos_line}\n"
            "This list is complete and current. Anything not on it does not "
            "exist right now, no matter what the conversation says — claims "
            "there about deletions or changes may be stale or wrong. Never "
            "assert rule/agent/automation state beyond this block without "
            "calling the matching tool in THIS turn.")
        _entities_cache = (now, block)
        return block
    except Exception:
        log.exception("Entities snapshot unavailable; continuing without it")
        return ""


async def _mcp_index_block(agent: dict) -> str:
    """Phase 2 lazy loading (docs/plans/mcp-client.md): one line per MCP
    server granted to this agent but not always_inject — its tool defs
    aren't in this turn's toolset at all, only this index line is, plus
    the find_mcp_tools meta-tool (added in get_agent_tools whenever this
    index is non-empty) to pull real defs in on demand. Empty string (no
    block) when the agent has no lazy MCP grants."""
    try:
        counts = await tool_registry.lazy_mcp_index(agent)
    except Exception:
        log.exception("MCP index lookup failed; continuing without it")
        return ""
    if not counts:
        return ""
    lines = "\n".join(f"- server `{name}`: {n} tool{'s' if n != 1 else ''}"
                      for name, n in sorted(counts.items()))
    return ("## MCP servers (not loaded — call find_mcp_tools to search and "
            "load matching tools into THIS turn)\n" + lines)


# Speaker tiers (docs/plans/speaker-id.md). Non-operator voices run with a
# narrowed toolset from the operator-controlled `voice.family_tools`
# allowlist (default: web search only) — consuming Nova is fine, changing
# her is not: no manage_* (rules/skills/automations), no memory writes, no
# settings, and NEVER dispatch (a sub-agent must not be an escape hatch).
# Enforced mechanically below, at the same layer as tool grants;
# recognition can only ever NARROW, never widen.
_RESTRICTED_ROLES = {"kid", "guest", "unknown"}
# not grantable to family voices no matter what the allowlist says
_FAMILY_HARD_EXCLUDE = {"dispatch_to_agent"}


def _family_allowed(available: set[str]) -> set[str]:
    """The family-tier toolset: the operator's `voice.family_tools` patterns
    intersected with what the agent actually has. Entries ending in `*`
    match by prefix (so `mcp:*` covers every connected MCP tool). Pure
    narrowing — nothing the agent lacks can appear here."""
    raw = str(settings_store.get("voice.family_tools") or "web_search")
    patterns = [p.strip() for p in raw.split(",") if p.strip()]
    out: set[str] = set()
    for name in available:
        for p in patterns:
            if (p.endswith("*") and name.startswith(p[:-1])) or name == p:
                out.add(name)
                break
    return out - _FAMILY_HARD_EXCLUDE


_KID_REGISTER = (
    "## Speaking with a child\n"
    "You're talking with {name}, a kid from the household. Use simple, warm "
    "words and short sentences. Stay on kid-appropriate topics and gently "
    "steer away from anything that isn't. Never bring up the operator's "
    "private or work matters, and never explain or negotiate your own "
    "restrictions — just be helpful and kind. Requests to change how you "
    "work (rules, automations, skills, settings) are for the operator only "
    "— deflect gently.")

_KNOWN_GUEST_REGISTER = (
    "## Speaking with a household member\n"
    "You're talking with {name} — an enrolled household member, not the "
    "operator. Be your normal helpful self: answer questions, search, use "
    "what you know. But changes to how you work — rules, automations, "
    "skills, settings, memory edits — are for the operator only; decline "
    "those politely and suggest they ask the operator.")

_UNKNOWN_REGISTER = (
    "## Speaking with a guest\n"
    "You don't recognize this voice as an enrolled household member. Be "
    "friendly and general, and early on, ask who you're speaking with. Don't "
    "share household or operator details. When they tell you their name, "
    "call remember_speaker with it — from then on you'll recognize their "
    "voice and greet them properly. They stay a guest either way; roles are "
    "the operator's to change.")


def _speaker_block(speaker: dict | None) -> str:
    """FACTS block: who the current voice turn belongs to. Same idiom as
    _now_block — live data, imperative, empty when there's nothing to say."""
    if not speaker:
        return ""
    role = speaker.get("role")
    lines = ["## Who you're speaking with (live)"]
    if role == "unknown":
        lines.append("An unrecognized voice — not an enrolled household "
                     "member. Address them as a guest.")
    else:
        lines.append(f"{speaker.get('name')} — role: {role}.")
        if speaker.get("persona_notes"):
            lines.append(speaker["persona_notes"])
    return "\n".join(lines)


def _speaker_register(speaker: dict | None) -> str:
    """LAST-WORD register composed AFTER the channel register — never
    replacing it. Operator (and no-speaker) turns add nothing. An enrolled
    guest is a KNOWN person (wife, friend) — only truly unrecognized
    voices get the ask-who-this-is treatment."""
    role = (speaker or {}).get("role")
    name = (speaker or {}).get("name") or "someone"
    if role == "kid":
        return _KID_REGISTER.format(name=name)
    if role == "guest":
        return _KNOWN_GUEST_REGISTER.format(name=name)
    if role == "unknown":
        return _UNKNOWN_REGISTER
    return ""


async def _build_system_prompt(agent: dict, query: str, *,
                               include_index: bool = False,
                               conversation_summary: str | None = None,
                               system_suffix: str | None = None,
                               speaker: dict | None = None) -> str:
    """Slot-based prompt assembly — persona-layer phase 1.

    ROLE → FACTS → CONTEXT → LAST WORD, in that order, always. The agent
    supplies only its ROLE slot (its system_prompt); everything after it is
    owned here, so no agent prompt can bury the last word. Nova (the main
    agent) ends with identity + channel register; specialists are their own
    entities and end with the house rules — they never wear the soul (five
    agents each told "I am Nova" was a real identity confusion, and their
    replies are read by Nova, not the operator).
    """
    name = settings_store.get("nova.assistant_name") or "Nova"
    is_nova = agent.get("name") == MAIN_AGENT

    # ROLE — the one slot the agent controls
    parts = [agent["system_prompt"]]

    # FACTS — fresh every turn; bare data + imperatives (de-quotable).
    # The clock is the LAST facts block on purpose: it changes every minute,
    # and sitting ahead of the stable blocks it invalidated any provider
    # prefix cache across turns. It must still never displace the LAST WORD
    # slots — recency there is owned by the register.
    model_block = _model_block(agent)
    if model_block:
        parts.append(model_block)
    platform = await _platform_block()
    if platform:
        parts.append(platform)
    entities = await _entities_block()
    if entities:
        parts.append(entities)
    mcp_index = await _mcp_index_block(agent)
    if mcp_index:
        parts.append(mcp_index)
    spk = _speaker_block(speaker)
    if spk:
        parts.append(spk)
    parts.append(_now_block())

    # CONTEXT — specialist index, memories, skills, rolling summary
    if include_index:
        # An agent that can dispatch always SEES the index — "remember to
        # check" proved unreliable in live testing.
        try:
            from app.agents import registry as agent_registry
            others = [a for a in await agent_registry.list_agents(enabled_only=True)
                      if a["name"] != agent.get("name")]
            if others:
                lines = "\n".join(f"- {a['name']}: {a['description']}" for a in others)
                parts.append(
                    "## Available specialists (dispatch_to_agent)\n" + lines
                    + "\n"
                    "A dispatch message is that specialist's ONLY context — "
                    "it sees nothing of this conversation or of other "
                    "specialists' replies. When a dispatch builds on findings "
                    "you already have (an earlier specialist's reply, your own "
                    "tool results), include those findings in the message "
                    "itself so the specialist works from them instead of "
                    "re-researching what is already known.")
        except Exception:
            log.exception("Agent index injection failed; continuing without it")
    try:
        async with trace.span("stage", "memory_retrieval") as sp:
            mem = await memory.context(query)
            if mem["context"]:
                parts.append(f"## Relevant Memories\n{mem['context']}")
            skills = await memory.skills_context(query)
            if skills["context"]:
                parts.append(f"## Applicable Skills\n{skills['context']}")
            sp["memory_chars"] = len(mem["context"])
            sp["skills_chars"] = len(skills["context"])
    except Exception:
        log.exception("Memory retrieval failed; continuing without context")
    if conversation_summary:
        parts.append("## Conversation so far (running summary)\n"
                     + conversation_summary)

    # LAST WORD — identity + register for Nova, house rules for specialists
    if is_nova:
        try:
            soul = await memory.soul(name)
            if soul:
                parts.append(f"## Who I am\n{soul}")
        except Exception:
            log.exception("Soul read failed; continuing without identity block")
        # Authoritative name, asserted AFTER the persona so it wins any
        # lingering reference — the soul is rewritten to match, this is the
        # backstop.
        parts.append(f"## Your name\nYour name is {name}. If asked your "
                     f"name, answer exactly \"{name}\".")
        # channel register: the caller's suffix (voice) or the typed default
        parts.append(system_suffix or _TYPED_REGISTER)
    else:
        parts.append(_HOUSE_RULES.format(name=name))
        if system_suffix:
            parts.append(system_suffix)
    # speaker register composes AFTER the channel register — the very last
    # word for non-operator voices; operator turns append nothing
    reg = _speaker_register(speaker)
    if reg:
        parts.append(reg)
    return "\n\n".join(parts)


# ── parallel same-round tool calls (docs/plans/turn-speed.md, phase 1) ────
#
# A WHITELIST, never a blacklist: only tools that (a) mutate nothing and
# (b) carry no same-round ordering contract may overlap. Everything else —
# every write, dispatch_to_agent, find_mcp_tools (it mutates the live
# toolset), every MCP/DB/http_call tool — runs sequentially in the model's
# call order, because the model relies on that order (create-then-append
# memory sequences, the per-chunk ingest flow) and serialized writes gain
# no wall-clock from parallelism anyway. New read-only builtins do NOT
# join this set automatically; adding one is a deliberate decision.
_PARALLEL_TOOLS = frozenset({
    "web_search", "fetch_url", "get_weather", "search_memory",
    "read_memory_item", "list_agents", "list_models",
    "list_followed_sources", "list_stale_topics",
})

# Per-tool ceilings INSIDE a batch, under the global concurrency budget.
# web_search is capped because SearXNG proxies rate-limited upstream
# engines. Measured 2026-07-24 on this box, five real queries: uncapped
# (5 at once) returned NOTHING — all five failed both searxng and the
# keyless DDG fallback in 0.6s; capped at 2 returned the same providers and
# the same results as running them one at a time, in 3.0s vs 4.7s. Two it
# is. fetch_url is deliberately uncapped (distinct hosts; overlapping is
# exactly where the timeout-stacking win lives).
_TOOL_CONCURRENCY_CAPS = {"web_search": 2}

# The tool-result guarantee's last resort: a missing tool message for a
# tool_call id is a provider 400 that kills the turn mid-research, so every
# id gets a string even if its task vanished without one.
_NO_RESULT = ("Error: this tool call produced no result (it was interrupted). "
              "Nothing was completed — re-issue it if you still need it.")


def _is_parallel_safe(entry: tuple[dict, dict, bool]) -> bool:
    """(tool_call, args, malformed) -> may this call share a round with its
    neighbours? Malformed calls never qualify: they take the sequential
    path that hands the model a correctable error."""
    tc, _args, malformed = entry
    return not malformed and tc["name"] in _PARALLEL_TOOLS


async def _run_tool(name: str, args: dict, ctx: dict,
                    agent_name: str | None) -> str:
    """Execute one tool inside its own trace span — shared by the sequential
    path and the parallel batch so both write identical audit rows. Opening
    the span inside the child task (not around the gather) is what keeps the
    parent chain right: task creation copies the contextvar context."""
    async with trace.span("tool", name) as tsp:
        tsp["agent"] = agent_name
        tsp["args"] = trace.redact_args(args)
        result = await tool_registry.execute_tool(name, args, ctx)
        tsp["result_size"] = len(result)
        tsp["result_head"] = trace.redact_text(result)
    return result


async def _cancel_and_drain(tasks: list[asyncio.Task]) -> None:
    """Cancel every still-running child and AWAIT it. The awaiting half is
    the point: it is what lets each child's `finally` run, so trace.span
    stamps status=cancelled + finished_at and the ledger still shows what
    was in flight. Without it a client disconnect (or an interject, which
    makes this the COMMON path — ChatPanel aborts the fetch and fires the
    next turn immediately) leaves orphaned tasks doing real network work
    with no audit rows.

    Runs while the caller is already unwinding, and never raises: the
    original exception propagates from the caller, never from here. One
    bounded wait, so a wedged child can never hang the unwind."""
    pending = [t for t in tasks if not t.done()]
    for t in pending:
        t.cancel()
    if not pending:
        return
    try:
        await asyncio.wait(pending, timeout=5.0)
    except asyncio.CancelledError:
        # Our own cancel scope is dead. Under Starlette/anyio that means
        # EVERY await here raises immediately (observed live: a client
        # disconnect), so we cannot wait for the children ourselves — hand
        # them to a detached task, which is outside that scope and can.
        # The children are already cancelled either way; this is what still
        # closes their spans.
        try:
            asyncio.ensure_future(_await_all(pending))
        except RuntimeError:
            pass  # loop is shutting down; the cancels above still stand
        return
    still = [t for t in tasks if not t.done()]
    if still:
        log.warning("Tool tasks did not finish cancelling: %s",
                    [t.get_name() for t in still])


async def _await_all(tasks: list[asyncio.Task]) -> None:
    await asyncio.gather(*tasks, return_exceptions=True)


async def _run_tools_parallel(batch: list[tuple[dict, dict]], ctx: dict,
                              agent_name: str | None, concurrency: int,
                              results: dict[str, str]) -> AsyncIterator[dict]:
    """Run a run of consecutive read-only tool calls concurrently.

    Yields the same activity events the sequential path does: every
    tool_start up front in the model's call order, then each tool_result as
    it lands. Results are collected into `results` (keyed by tool_call id)
    for the caller to append as tool messages in call order — completion
    order must never reorder the transcript.
    """
    queue: asyncio.Queue = asyncio.Queue()
    slots = asyncio.Semaphore(concurrency)
    # per-batch, not module-level: no cross-turn state, no event-loop binding
    caps = {tc["name"]: asyncio.Semaphore(min(_TOOL_CONCURRENCY_CAPS[tc["name"]],
                                              concurrency))
            for tc, _ in batch if tc["name"] in _TOOL_CONCURRENCY_CAPS}

    async def _one(tc: dict, args: dict) -> None:
        name = tc["name"]
        result: str | None = None
        try:
            async with AsyncExitStack() as stack:
                # per-tool cap FIRST so a queued web_search doesn't sit on a
                # global slot another tool could be using
                if name in caps:
                    await stack.enter_async_context(caps[name])
                await stack.enter_async_context(slots)
                result = await _run_tool(name, args, ctx, agent_name)
        except asyncio.CancelledError:
            raise  # cancellation is not a result; the span is already stamped
        except Exception as e:  # noqa: BLE001 — a tool must never kill the turn
            log.exception("Tool %s failed inside a parallel batch", name)
            result = f"Error executing {name}: {e}"
        finally:
            if result is not None:
                results[tc["id"]] = result
            # exactly one queue message per task, on EVERY exit path
            # (finally runs for BaseException too) — the loop below reads
            # one message per task, so a child that died without producing
            # one would otherwise leave it waiting forever
            queue.put_nowait((tc, args, result))  # unbounded: never blocks

    tasks: list[asyncio.Task] = []
    try:
        # tasks first, then the start events: the work begins immediately
        # instead of waiting on the consumer to pull each event off the SSE
        # stream, and a close during the start events still finds real tasks
        # to cancel rather than orphaning them a line later
        tasks = [asyncio.create_task(_one(tc, args), name=f"tool:{tc['name']}")
                 for tc, args in batch]
        for tc, args in batch:
            yield {"type": "activity", "kind": "tool_start", "name": tc["name"],
                   "agent": agent_name, "args": _brief(args),
                   "detail": _brief(args)}
        for _ in range(len(tasks)):
            tc, args, result = await queue.get()
            if result is None:      # child died without producing one
                log.warning("Tool %s produced no result", tc["name"])
                continue
            # the args brief rides the result event too: five simultaneous
            # "web_search" lines are otherwise indistinguishable
            yield {"type": "activity", "kind": "tool_result", "name": tc["name"],
                   "agent": agent_name, "args": _brief(args),
                   "detail": result[:200]}
    finally:
        await _cancel_and_drain(tasks)


async def run_agent(agent: dict, turn_messages: list[dict], *,
                    dispatch_depth: int = 0,
                    conversation_summary: str | None = None,
                    system_suffix: str | None = None,
                    automation: str | None = None,
                    speaker: dict | None = None) -> AsyncIterator[dict]:
    """Run one agent turn (with tool rounds) and stream events.

    turn_messages: chat-format messages for this turn (history + new user msg),
    WITHOUT a system message — that is assembled here so dispatched agents get
    the same memory/skills injection as the main agent.
    conversation_summary: rolling summary of turns aged out of the verbatim
    window (top-level chat only; dispatch sub-turns are self-contained).
    system_suffix: the channel register, landing in the prompt's LAST slot
    where it wins small-model recency bias (voice brevity; patched into the
    front of the agent prompt it got buried mid-prompt and ignored). For
    Nova it replaces the typed-chat default register.
    automation: name of the automation this turn runs inside (None for chat).
    Rides the tool ctx — never the prompt — so tools can record run
    provenance mechanically (write_memory stamps maintained_by on created
    topics); propagates through dispatch so a sub-agent's writes carry it too.
    speaker: who the voice turn belongs to (docs/plans/speaker-id.md) —
    {id, name, role, persona_notes?}. Non-operator roles get a hard tool
    clamp here (search only, no dispatch) plus a persona block/register;
    None (typed chat, or recognition off) is exactly the old behavior.
    """
    query = next((m["content"] for m in reversed(turn_messages)
                  if m["role"] == "user"), "")
    if isinstance(query, list):
        # multimodal turn (image attachments) — the text part drives memory
        # search and prompt assembly; the image parts go to the model as-is
        query = " ".join(p.get("text", "") for p in query
                         if isinstance(p, dict) and p.get("type") == "text")

    exclude = {"dispatch_to_agent"} if dispatch_depth >= MAX_DISPATCH_DEPTH else set()
    tools = await tool_registry.get_agent_tools(agent, exclude=exclude)
    speaker_role = (speaker or {}).get("role")
    if speaker_role in _RESTRICTED_ROLES:
        # the tier clamp: intersect with the operator's family allowlist,
        # never extend — with no voiceprints enrolled this branch is
        # unreachable and behavior is exactly the single-operator behavior
        available = {t["function"]["name"] for t in tools}
        allowed = _family_allowed(available)
        tools = [t for t in tools if t["function"]["name"] in allowed]
        if speaker_role == "unknown":
            # the introduce-yourself path: grant remember_speaker for this
            # turn only — all it can do is create a GUEST profile from the
            # voice already being heard (auto-enrollment, speaker-id.md)
            if not any(t["function"]["name"] == "remember_speaker" for t in tools):
                tools.append(tool_registry.builtin_def("remember_speaker"))
    can_dispatch = any(t["function"]["name"] == "dispatch_to_agent" for t in tools)

    async with trace.span("stage", "build_prompt") as psp:
        system_prompt = await _build_system_prompt(
            agent, query, include_index=can_dispatch,
            conversation_summary=conversation_summary, system_suffix=system_suffix,
            speaker=speaker)
        psp["prompt_chars"] = len(system_prompt)
        psp["agent"] = agent.get("name")
    messages = [{"role": "system", "content": system_prompt}] + list(turn_messages)

    ctx = {"agent_id": agent.get("id"), "agent_name": agent.get("name"),
           "dispatch_depth": dispatch_depth, "automation": automation,
           "speaker_role": speaker_role,
           "granted": {t["function"]["name"] for t in tools}}

    final_text = ""
    calls_made = 0
    # phase 2 bookkeeping: which tool results may never be trimmed (a
    # specialist's report IS the turn's product) and which go first (raw web
    # output the model can always re-fetch)
    dispatch_result_ids: set[str] = set()
    bulk_result_ids: set[str] = set()

    max_rounds = int(settings_store.get("agents.max_tool_rounds") or 10)
    for round_no in range(max_rounds):
        round_text = ""
        tool_calls: list[dict] = []
        errored = False

        async with trace.span(
                "llm_call", llm_router.effective_model(agent["model"])) as lsp:
            lsp["agent"] = agent.get("name")
            lsp["round"] = round_no + 1
            # overflow protection, immediately before the request is built:
            # a no-op under the ceiling, and never removes or reorders a
            # message (an orphaned tool_call is a provider 400)
            context_trim.trim_transcript(
                messages, model=llm_router.effective_model(agent["model"]),
                exempt_ids=dispatch_result_ids, bulk_ids=bulk_result_ids,
                detail=lsp)
            async for event in llm_router.stream_chat(messages, agent["model"],
                                                      tools or None):
                etype = event.get("type")
                if etype == "text":
                    round_text += event["text"]
                    if dispatch_depth == 0:
                        yield {"type": "text", "text": event["text"]}
                elif etype == "tool_calls":
                    tool_calls = event["tool_calls"]
                elif etype == "usage":
                    u = event.get("usage") or {}
                    lsp["prompt_tokens"] = u.get("prompt_tokens")
                    lsp["completion_tokens"] = u.get("completion_tokens")
                    # provider-reported prefix-cache hits (OpenAI-compat
                    # `prompt_tokens_details.cached_tokens`) — the ledger
                    # evidence for whether prompt-order changes actually
                    # buy cached prefills (turn-speed phase 0)
                    det = u.get("prompt_tokens_details") or {}
                    if isinstance(det, dict) and det.get("cached_tokens") is not None:
                        lsp["cached_tokens"] = det["cached_tokens"]
                elif etype == "error":
                    lsp["error"] = event["error"]
                    yield {"type": "error", "error": event["error"]}
                    errored = True
                    break
            lsp["completion_chars"] = len(round_text)
            lsp["tool_calls_requested"] = len(tool_calls)

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

        # Args are parsed up front because the read-only/mutating partition
        # below is decided per call: a malformed one executes nothing and
        # always takes the sequential path.
        parsed: list[tuple[dict, dict, bool]] = []
        for tc in tool_calls:
            try:
                parsed.append((tc, json.loads(tc["arguments"])
                               if tc["arguments"] else {}, False))
            except json.JSONDecodeError:
                parsed.append((tc, {}, True))

        # 1 = exactly the old sequential loop (the flag's default), so the
        # revert is a settings change, not a deploy. Read per turn.
        concurrency = max(1, int(settings_store.get("agents.tool_concurrency") or 1))

        i = 0
        while i < len(parsed):
            # a RUN of consecutive read-only calls overlaps; any mutating
            # call ends the run, so nothing is ever reordered across one
            if concurrency > 1 and _is_parallel_safe(parsed[i]):
                j = i
                while j < len(parsed) and _is_parallel_safe(parsed[j]):
                    j += 1
                if j - i > 1:
                    batch = [(t, a) for t, a, _ in parsed[i:j]]
                    calls_made += len(batch)
                    results: dict[str, str] = {}
                    gather = _run_tools_parallel(batch, ctx, agent.get("name"),
                                                 concurrency, results)
                    try:
                        async for ev in gather:
                            yield ev
                    finally:
                        # an exception (GeneratorExit from a client
                        # disconnect, CancelledError from an interject)
                        # propagating out of `async for` leaves the inner
                        # generator suspended for GC to finalize later —
                        # closing it here is what actually runs its
                        # cancel-and-await contract, in this task, now
                        await gather.aclose()
                    # tool-result guarantee: one tool message per tool_call
                    # id, in the MODEL'S call order — completion order must
                    # never reorder the transcript, and a missing id is a
                    # provider 400 that kills the turn mid-research
                    for bt, _ba in batch:
                        if bt["name"] in context_trim._BULK_TOOLS:
                            bulk_result_ids.add(bt["id"])
                        messages.append(
                            {"role": "tool", "tool_call_id": bt["id"],
                             "content": results.get(bt["id"], _NO_RESULT)[:8000]})
                    i = j
                    continue

            tc, args, malformed = parsed[i]
            i += 1
            calls_made += 1
            name = tc["name"]
            if malformed:
                # broken argument JSON used to execute as {} — a silent
                # wrong invocation (write_memory with no content). Give the
                # model an error result it can correct next round instead;
                # every tool_call id still gets its tool message.
                result = (f"Error: the arguments for {name} were not valid "
                          "JSON. Nothing was executed — re-issue the call "
                          "with corrected arguments.")
                yield {"type": "activity", "kind": "tool_start", "name": name,
                       "agent": agent.get("name"),
                       "args": (tc["arguments"] or "")[:200],
                       "detail": (tc["arguments"] or "")[:200]}
                async with trace.span("tool", name) as tsp:
                    tsp["agent"] = agent.get("name")
                    tsp["error"] = "malformed_arguments"
                    tsp["args"] = trace.redact_text(tc["arguments"] or "", 2000)
                    tsp["result_size"] = len(result)
                    tsp["result_head"] = result
                yield {"type": "activity", "kind": "tool_result", "name": name,
                       "agent": agent.get("name"),
                       "args": (tc["arguments"] or "")[:200],
                       "detail": result[:200]}
                messages.append({"role": "tool", "tool_call_id": tc["id"],
                                 "content": result})
                continue

            yield {"type": "activity", "kind": "tool_start", "name": name,
                   "agent": agent.get("name"), "args": _brief(args),
                   "detail": _brief(args)}

            if name in context_trim._BULK_TOOLS:
                bulk_result_ids.add(tc["id"])

            if name == "dispatch_to_agent":
                result = ""
                # the specialist's report is the turn's product — exempt from
                # overflow trimming no matter how old it gets
                dispatch_result_ids.add(tc["id"])
                # the sub-agent's own spans nest under this one (parent_span_id)
                async with trace.span(
                        "dispatch", args.get("agent_name", "")) as dsp:
                    dsp["message"] = trace.redact_text(
                        args.get("message") or "", 200)
                    async for sub in _run_dispatch(args, dispatch_depth,
                                                   automation):
                        if sub["type"] == "final":
                            result = sub["text"]
                        elif sub["type"] in ("activity", "error"):
                            yield sub
                    if not result:
                        result = "Error: dispatched agent produced no result"
                    dsp["result_size"] = len(result)
                # the specialist's reply, near-full (matches the 2000-char
                # tool-row persistence cap) — the chat trace renders it as an
                # expandable "← <agent> replied" item
                yield {"type": "activity", "kind": "agent_reply",
                       "name": args.get("agent_name", ""),
                       "agent": args.get("agent_name", ""),
                       "detail": result[:2000]}
            elif name == "find_mcp_tools":
                # phase 2 lazy loading: mutate the LIVE round's toolset —
                # tools/ctx["granted"] are otherwise fixed for the whole
                # turn, but a found tool must be callable next round.
                async with trace.span("tool", name) as tsp:
                    tsp["agent"] = agent.get("name")
                    tsp["args"] = trace.redact_args(args)
                    query = str(args.get("query", ""))
                    found = await tool_registry.search_lazy_mcp_tools(agent, query)
                    have = {t["function"]["name"] for t in tools}
                    new_defs = [d for d in found if d["function"]["name"] not in have]
                    tools.extend(new_defs)
                    ctx["granted"] = {t["function"]["name"] for t in tools}
                    result = ("Loaded: " + ", ".join(
                        d["function"]["name"] for d in new_defs)) if new_defs \
                        else f"No unloaded MCP tools matched '{query}'."
                    tsp["result_size"] = len(result)
                yield {"type": "activity", "kind": "tool_result", "name": name,
                       "agent": agent.get("name"), "args": _brief(args),
                       "detail": result[:200]}
            else:
                result = await _run_tool(name, args, ctx, agent.get("name"))
                yield {"type": "activity", "kind": "tool_result", "name": name,
                       "agent": agent.get("name"), "args": _brief(args),
                       "detail": result[:200]}

            messages.append({"role": "tool", "tool_call_id": tc["id"],
                             "content": result[:8000]})
    else:
        note = "\n\n[Stopped: reached the tool-round limit for one turn.]"
        final_text += note
        if dispatch_depth == 0:
            yield {"type": "text", "text": note}

    # narration detector: text that announces actions + zero tool calls =
    # the described work silently never happened. Make it loud.
    snippet = narration.detect(final_text, calls_made)
    if snippet:
        yield {"type": "activity", "kind": "narration",
               "name": agent.get("name", ""), "agent": agent.get("name"),
               "detail": f"announced an action but called no tool (matched {snippet!r})"}
        log.warning("Narration detected: agent=%s model=%s matched=%r",
                    agent.get("name"), agent.get("model"), snippet)
        asyncio.ensure_future(memory.write(
            f"Narration detected: agent '{agent.get('name')}' on model "
            f"{agent.get('model')} announced an action but called no tool "
            f"this turn (matched {snippet!r}). The described work did NOT "
            f"happen.", type="journal", source_type="system"))

    yield {"type": "final", "text": final_text}


async def _run_dispatch(args: dict, parent_depth: int,
                        automation: str | None = None) -> AsyncIterator[dict]:
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
                                 dispatch_depth=parent_depth + 1,
                                 automation=automation):
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
