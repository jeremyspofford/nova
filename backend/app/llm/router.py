"""LLM routing — resolves 'slug:<model>' to a client via the provider registry.

'ollama:<model>' is the built-in local provider (its URL is a runtime setting);
every other prefix names a row in the provider registry (`llm/providers.py`).
Reads are synchronous off the provider cache, so no caller had to become async.
"""

import logging
from typing import TYPE_CHECKING, AsyncIterator, Optional

from app.llm import providers
from app.llm.openai_compat import OpenAICompatClient

if TYPE_CHECKING:  # the runtime import stays inside _resolve_local; this is
    # only so the quoted annotation there names something that exists.
    from app.llm.ollama_native import OllamaNativeClient

log = logging.getLogger(__name__)


def effective_model(model: str) -> str:
    """Swap a cloud model to the local fallback when its provider isn't
    configured (no key, or disabled). Local (ollama) models pass through."""
    if ":" not in model:
        return model
    slug = model.split(":", 1)[0]
    if slug == "ollama":
        return model
    if not providers.is_configured(slug):
        from app import settings_store
        name = str(settings_store.get("inference.local_fallback_model") or "").strip()
        if not name:
            # Interpolating an empty setting produced the model id "ollama:",
            # which no provider can serve — the call then failed on a name the
            # operator never chose and cannot find in any binding. Returning
            # the model UNCHANGED makes the failure name their real setting.
            log.warning("provider %r is not configured and no local fallback "
                        "is set; leaving %s unchanged", slug, model)
            return model
        # A local name carries its own colon ("qwen3:8b" — a TAG separator,
        # not a provider prefix), so the prefix is added by name, never by
        # testing for ":". The setting is ollama-scoped by definition; a value
        # that already carries the prefix is used as-is rather than doubled.
        fallback = name if name.startswith("ollama:") else f"ollama:{name}"
        log.info("provider '%s' not configured; %s -> %s", slug, model, fallback)
        return fallback
    return model


def is_local(model: str) -> bool:
    return model.split(":", 1)[0] == "ollama"


# Model families whose prompt cache must be asked for. Everyone else on this
# list of providers — OpenAI, Grok, Groq, DeepSeek, Moonshot, Z.AI — caches
# common prefixes automatically and charges nothing to mark one, so sending a
# breakpoint to them is dead weight in the payload. MEASURED on this install,
# last 5 days: ingestion on z-ai/glm cached 61.7% of its prompt tokens and
# main 60.1%, with no breakpoint ever sent. claude-haiku over the same period
# reported 0% — it reports the field faithfully and there was nothing to
# report, because Anthropic caches only what an explicit `cache_control` marks.
_ASKS_FOR_CACHE = ("anthropic/", "google/", "qwen/")
# ...and the same families reached as their own provider row rather than
# through OpenRouter. Matched on the API HOST, not on the slug: the slug is
# whatever the operator typed when they added the provider.
_ASKS_FOR_CACHE_HOSTS = ("api.anthropic.com", "generativelanguage.googleapis.com")


def supports_cache_control(model: str) -> bool:
    """Whether this model needs to be TOLD where its reusable prefix ends.

    False is the safe answer everywhere: a provider that caches
    automatically loses nothing, and ollama — which has no server-side
    prompt cache to address at all, only a resident KV cache belonging to
    one loaded runner — must keep receiving a flat string, because that is
    what `ollama_native.to_ollama_messages` translates byte-for-byte.
    """
    slug, _, name = model.partition(":")
    if slug == "ollama" or not name:
        return False
    if slug == "openrouter":
        return name.startswith(_ASKS_FOR_CACHE)
    row = providers.get(slug) or {}
    host = str(row.get("base_url") or "")
    return any(h in host for h in _ASKS_FOR_CACHE_HOSTS)


def _resolve_local(model_name: str) -> tuple["OllamaNativeClient", str]:
    """Local models go through ollama's OWN api, not its OpenAI shim.

    The shim silently drops both controls a local model needs — `think` and
    `options.num_ctx` (measured; see llm/ollama_native.py). Same event
    vocabulary out, so nothing upstream can tell the difference.
    """
    from app import settings_store
    from app.llm.ollama_native import OllamaNativeClient
    base = str(settings_store.get("inference.ollama_url")).rstrip("/")
    timeout = float(settings_store.get("inference.ollama_timeout_s") or 300)
    return OllamaNativeClient(base, timeout=timeout), model_name


def _resolve(model: str) -> tuple[OpenAICompatClient, str]:
    if ":" not in model:
        raise ValueError(f"Unknown model format: {model!r} (expected 'slug:model')")
    slug, name = model.split(":", 1)
    if slug == "ollama":
        from app import settings_store
        base = str(settings_store.get("inference.ollama_url")).rstrip("/")
        # A cold local model can take minutes to load off disk (model_warmer
        # already budgets 300s for exactly this); the blanket 120s fires
        # spuriously on the first call after a swap and reads as a dead
        # server. Applies to reads too — this is a first-byte deadline.
        timeout = float(settings_store.get("inference.ollama_timeout_s") or 300)
        return OpenAICompatClient(f"{base}/v1", "ollama", timeout=timeout), name
    row = providers.get(slug)
    if not row:
        raise ValueError(f"Unknown provider {slug!r} in model {model!r} "
                         f"(add it in Settings → Models → Providers)")
    return (OpenAICompatClient(row["base_url"], providers.resolve_key(row),
                               extra_headers=row["extra_headers"]),
            name)


async def window_for(model: str) -> Optional[int]:
    """The window this model's next call gets — local or cloud, one answer.

    THE SECOND SOURCE OF TRUTH THIS REPLACES was not hypothetical: the
    trimmer sized against `local_context.cached()` while the refusal sized
    against `local_context.effective_window()`, and the two disagreed
    whenever the cached value was stale. Resolving once per call and passing
    the number down means the transcript the trimmer declares safe is the
    transcript the refusal measures.
    """
    if is_local(model):
        return await local_window(model)
    from app.agents import context_trim
    return context_trim.model_context(model)


async def local_window(model: str) -> Optional[int]:
    from app import local_context
    return await local_context.effective_window(model)


async def _refuse_local_overflow(model: str, messages: list,
                                 window: Optional[int] = None) -> Optional[dict]:
    """Refuse a local call whose prompt cannot fit, instead of letting the
    server silently drop the front of it.

    Ollama truncates an oversized prompt from the HEAD, which is where the
    system prompt lives — the agent quietly loses its role, its rails and
    its tool contract, and answers anyway. That is the worst failure shape
    there is: no error, no log line, just a worse answer.

    Measured 2026-07-24 on ollama 0.31.2: `options.num_ctx` sent to the
    OpenAI-compatible /v1 endpoint is IGNORED (probe showed n_ctx stayed at
    the server default). Re-measured 2026-07-31: on the NATIVE /api/chat
    endpoint — the path chat actually takes — it is honoured verbatim, and
    it is what `local_context` sends. So the window is per call, and this
    refuses against that window rather than a server-wide number.
    """
    from app.agents import context_trim
    # Refuse against the window this call will ACTUALLY get — what we sized
    # it to, or failing that what ollama reports it already loaded. Resolved
    # by the caller and passed in, so the trimmer and this refusal are two
    # readings of ONE number rather than two probes minutes apart. Nothing
    # resident and nothing measurable means nobody knows the window, and a
    # refusal invented on a guess is worse than the call.
    limit = (window if window is not None else await local_window(model)) or 0
    if limit <= 0:
        return None
    # leave the same completion headroom the trimmer reserves — with the same
    # floor it applies, or the two disagree on every window under 6,000
    usable = max(2000, limit - context_trim._COMPLETION_HEADROOM)
    estimate = context_trim.estimate_tokens(messages)
    if estimate <= usable:
        return None
    log.error("local prompt overflow: ~%d tokens vs num_ctx %d for %s",
              estimate, limit, model)
    return {
        "type": "error",
        # State the RESERVE. Without it this named two numbers that appear to
        # permit the call — 4,212 against a window of 8,192 — and left the
        # reader hunting a bug in the comparison. The usable figure is the
        # one the refusal is actually about.
        "error": (f"This prompt is about {estimate:,} tokens, and {model} has "
                  f"{usable:,} usable — a window of {limit:,} less the "
                  f"{context_trim._COMPLETION_HEADROOM:,} reserved for the "
                  f"reply. The window is the largest whose KV cache fits in "
                  f"free VRAM beside the weights, so it shrinks when other "
                  f"models are resident. Sending this would silently truncate "
                  f"the system prompt, so the call was refused. Free VRAM to "
                  f"raise the window (it is measured, not configured), "
                  f"shorten the turn, or move this agent to a cloud model."),
        "error_class": "prompt_too_long", "status_code": None}


async def resolve_thinking(model: str, preference: str) -> Optional[bool]:
    """Turn an agent's auto/on/off preference into a `think` value, or None
    to send nothing at all.

    Capability comes from the SERVER (llm/capabilities.py), never from the
    model's name — a hardcoded list of which models reason is wrong the day
    a new one is pulled, and wrong silently. Three rules:

      auto            -> None. Send nothing; the model does what it does.
                         This is exactly the behavior that shipped before
                         this setting existed.
      on/off, capable -> the boolean.
      on/off, not capable (or unknown) -> None, with a log line. Asking a
                         model that cannot reason to think is not an error
                         worth failing a turn over.
    """
    if preference not in ("on", "off"):
        return None
    if not is_local(model):
        # `think` is ollama's extension; a cloud provider's reasoning
        # controls are its own and are not wired here yet
        return None
    from app.llm import capabilities
    capable = await capabilities.supports(model, "thinking")
    if capable:
        return preference == "on"
    log.info("thinking=%s ignored for %s (server reports capability: %s)",
             preference, model, capable)
    return None


async def stream_chat(messages: list, model: str,
                      tools: Optional[list] = None,
                      thinking: str = "auto") -> AsyncIterator[dict]:
    target = effective_model(model)
    think = await resolve_thinking(target, thinking)
    if think is False and tools:
        # Suppressing the reasoning pass collapses tool selection on smaller
        # local models. Measured 2026-07-30 against the real 20-tool schema,
        # n=8 per arm: qwen3:8b answering a question whose tool it HELD called
        # it 8/8 with think unset and 0/8 with think=false once the voice
        # brevity suffix was in the prompt. Drop either leg and it is 8/8
        # again; qwen3:14b is 8/8 throughout. A turn that carries tools is a
        # turn that may need to pick one, so it never gets think=false.
        #
        # Derived from this request — the tools are right here. No model list
        # to maintain, and it self-retires for any model that stops needing it
        # only when someone measures that and removes this.
        log.info("thinking=off dropped for %s: turn carries %d tool(s)",
                 target, len(tools))
        think = None
    if is_local(target):
        from app import local_context
        from app.agents import context_trim
        # ONE resolution for this call: the refusal below and the trimmer
        # upstream both measure against this number.
        window = await local_window(target)
        refusal = await _refuse_local_overflow(target, messages, window)
        if refusal:
            yield refusal
            return
        client, model_name = _resolve_local(target.split(":", 1)[1])
        # Per model, from what it supports and what fits — see local_context.
        # DELIBERATELY `resolve`, not `window`: `effective_window` falls back
        # to the RESIDENT model's context_length when nothing could be
        # measured, and feeding that back as num_ctx turns "we could not
        # measure it, so ollama decides" into "pin it to whatever happens to
        # be loaded" — which on this box means an outside call leaves a model
        # at 262,144 and Nova then forces 262,144. Guaranteed spill.
        num_ctx = await local_context.resolve(target)
        async for event in client.stream(
                messages, model_name, tools, include_usage=True, think=think,
                num_ctx=num_ctx or None,
                # the second control: the refusal above is the primary one,
                # and it cannot fire on the paths where nobody knows the
                # window. This is how a cut that happened anyway becomes a
                # fact rather than a worse answer.
                expect_prompt_tokens=context_trim.estimate_tokens(messages)):
            yield event
        # Did that window actually fit? ollama does not fail when the KV
        # cache overflows — it moves part of the model into system RAM and
        # answers slowly. Reading /api/ps afterwards turns that into a fact,
        # and the next call for this model comes back smaller.
        await local_context.note_spill(target)
        return
    client, model_name = _resolve(target)
    # include_usage: exact token counts in a final usage chunk — feeds the
    # turn ledger; providers that don't support it simply omit the event
    async for event in client.stream(messages, model_name, tools,
                                     include_usage=True):
        yield event
