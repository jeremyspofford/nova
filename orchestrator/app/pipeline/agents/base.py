"""
Base agent class shared by all quartet pipeline agents.

Every agent:
  1. Receives a PipelineState (accumulated outputs from prior stages)
  2. Builds a message list for the LLM
  3. Calls think_json() to get a structured response with automatic retry-on-bad-JSON
  4. Returns a typed output dict

The think_json() retry pattern (from arialabs/nova):
  - Attempt 1: send messages, parse JSON
  - On parse failure: append {role:assistant, bad_output} + {role:user, corrective_msg}
  - Attempt 2: LLM now sees its own mistake and the correction instruction
  - This is significantly more effective than re-sending the same prompt
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pydantic import BaseModel

logger = logging.getLogger(__name__)

THINK_JSON_MAX_ATTEMPTS = 2


# ── Pipeline state ─────────────────────────────────────────────────────────────

@dataclass
class PipelineState:
    """Accumulated context as each agent in the pipeline completes."""
    task_input: str                             # original user request
    completed: dict[str, Any] = field(default_factory=dict)   # role → output dict
    flags: set[str]            = field(default_factory=set)    # "guardrail_blocked", etc.
    task_tags: list[str]       = field(default_factory=list)   # ["code", "config", …]
    complexity: str | None     = None                          # "simple", "moderate", "complex"


# ── Run condition evaluator ────────────────────────────────────────────────────

def should_agent_run(condition: dict | None, state: PipelineState) -> bool:
    """
    Evaluate a run_condition JSONB dict against the current pipeline state.
    Returns True if the agent should run, False to skip it.

    Supported condition types:
      {"type": "always"}                                    → always run (default)
      {"type": "never"}                                     → soft-disable
      {"type": "on_flag",  "flag":  "guardrail_blocked"}   → run if flag is set
      {"type": "has_tag",  "tag":   "code"}                → run if task has this tag
      {"type": "on_pass"}                                   → run if code_review passed
      {"type": "on_fail"}                                   → run if any failure flag set
      {"type": "and", "conditions": [...]}                  → all must be true
      {"type": "or",  "conditions": [...]}                  → any must be true
    """
    if not condition:
        return True

    ctype = condition.get("type", "always")

    if ctype == "always":
        return True
    if ctype == "never":
        return False
    if ctype == "on_flag":
        return condition.get("flag", "") in state.flags
    if ctype == "not_flag":
        return condition.get("flag", "") not in state.flags
    if ctype == "has_tag":
        return condition.get("tag", "") in state.task_tags
    if ctype == "on_pass":
        return "code_review_passed" in state.flags
    if ctype == "on_fail":
        return bool(state.flags & {"guardrail_blocked", "code_review_rejected"})
    if ctype == "and":
        return all(should_agent_run(c, state) for c in condition.get("conditions", []))
    if ctype == "or":
        return any(should_agent_run(c, state) for c in condition.get("conditions", []))

    logger.warning(f"Unknown run_condition type '{ctype}' — defaulting to run")
    return True


# ── Base agent ────────────────────────────────────────────────────────────────

class BaseAgent:
    """
    Base class for all pipeline agents.

    Subclasses implement:
      - ROLE: str            class-level role name
      - DEFAULT_SYSTEM: str  fallback system prompt if pod_agents.system_prompt is null
      - async run(state, agent_cfg, task_id) → dict
    """

    ROLE: str = "base"
    DEFAULT_SYSTEM: str = "You are a helpful AI agent."

    def __init__(
        self,
        model: str,
        system_prompt: str | None = None,
        allowed_tools: list[str] | None = None,
        temperature: float = 0.3,
        max_tokens: int = 4096,
        fallback_models: list[str] | None = None,
        tier: str | None = None,
        task_type: str | None = None,
        tool_context: dict | None = None,
    ) -> None:
        from datetime import date
        self.model          = model
        base_prompt         = system_prompt or self.DEFAULT_SYSTEM
        self.system_prompt  = f"Current date: {date.today().isoformat()}\n\n{base_prompt}"
        self.allowed_tools  = allowed_tools  # None = all tools; [] = no tools
        self.temperature    = temperature
        self.max_tokens     = max_tokens
        self.fallback_models = fallback_models or []
        self.tier           = tier       # Routing tier hint for llm-gateway
        self.task_type      = task_type  # Task type for outcome tracking
        # tool_context: scope info forwarded to credentialed tool dispatch.
        # Carries tenant_id, user_id, task_id, credential_id, actor_kind/id —
        # consumed by github_external (and future credentialed tools) so they
        # route through the capability platform's consent gate + secret vault
        # rather than crashing on a missing 'secret' kwarg.
        self.tool_context   = tool_context or {}
        # Usage accumulator — populated by _call_llm_full()
        self._usage = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "llm_calls": 0}
        # Training data log — populated by _call_llm_full() when training logging is enabled
        self._training_log: list[dict] = []
        # Last raw LLM output — set by think_json on parse failure for post-mortem
        self._last_raw_output: str | None = None

    # ── LLM call ──────────────────────────────────────────────────────────────

    async def _call_llm_full(self, messages: list[dict]) -> tuple[str, str]:
        """
        Call the LLM gateway and return (content, model_used).

        Tries self.model first, then each entry in self.fallback_models in order.
        Accumulates token usage into self._usage and appends to self._training_log.
        """
        from ...clients import get_llm_client

        client = get_llm_client()
        models_to_try = [self.model, *self.fallback_models]
        last_exc: Exception | None = None

        for model in models_to_try:
            try:
                payload = {
                    "model":       model,
                    "messages":    messages,
                    "temperature": self.temperature,
                    "max_tokens":  self.max_tokens,
                }
                if self.tier:
                    payload["tier"] = self.tier
                if self.task_type:
                    payload["task_type"] = self.task_type
                response = await client.post("/complete", json=payload)
                response.raise_for_status()
                data = response.json()
                was_fallback = model != self.model
                if was_fallback:
                    logger.warning(
                        "[%s] Primary model '%s' failed — used fallback '%s'",
                        self.ROLE, self.model, model,
                    )

                # Use the gateway's resolved model (handles tier routing / auto)
                resolved_model = data.get("model") or model

                # Accumulate usage
                in_tokens = data.get("input_tokens", 0) or 0
                out_tokens = data.get("output_tokens", 0) or 0
                cost = data.get("cost_usd", 0.0) or 0.0
                self._usage["input_tokens"] += in_tokens
                self._usage["output_tokens"] += out_tokens
                self._usage["cost_usd"] += cost
                self._usage["llm_calls"] += 1
                self._usage["model"] = resolved_model

                content = data["content"]

                # Training log entry
                self._training_log.append({
                    "messages": messages,
                    "response": content,
                    "model": resolved_model,
                    "input_tokens": in_tokens,
                    "output_tokens": out_tokens,
                    "cost_usd": cost,
                    "was_fallback": was_fallback,
                    "temperature": self.temperature,
                })

                return content, resolved_model
            except Exception as exc:
                last_exc = exc
                logger.warning("[%s] Model '%s' failed: %s", self.ROLE, model, exc)

        raise RuntimeError(
            f"[{self.ROLE}] All models failed. "
            f"Primary='{self.model}' fallbacks={self.fallback_models}. "
            f"Last error: {last_exc}"
        ) from last_exc

    async def _call_llm(self, messages: list[dict]) -> str:
        """Call the LLM gateway and return the raw text response."""
        content, _ = await self._call_llm_full(messages)
        return content

    # ── think_json ────────────────────────────────────────────────────────────

    async def think_json(
        self,
        messages: list[dict],
        purpose: str = "",
        output_schema: type[BaseModel] | None = None,
    ) -> dict:
        """
        Call the LLM and parse the response as JSON.

        On parse failure: appends the bad response as an assistant turn + a
        corrective user turn and retries once. The model sees its own mistake
        and the explicit correction instruction — much more effective than
        blind retry.

        If output_schema is provided, the parsed dict is validated against the
        Pydantic model. On validation failure, coercion is attempted (strict=False).
        If coercion fails, the LLM is retried with the schema appended to the prompt.
        """
        for attempt in range(THINK_JSON_MAX_ATTEMPTS):
            raw = await self._call_llm(messages)

            # Strip markdown code fences if the model wrapped the JSON
            cleaned = raw.strip()
            if cleaned.startswith("```"):
                lines = cleaned.splitlines()
                cleaned = "\n".join(
                    ln for ln in lines
                    if not ln.strip().startswith("```")
                ).strip()

            try:
                parsed = json.loads(cleaned)
            except json.JSONDecodeError as exc:
                if attempt + 1 >= THINK_JSON_MAX_ATTEMPTS:
                    logger.error(
                        f"[{self.ROLE}] think_json failed after {THINK_JSON_MAX_ATTEMPTS} "
                        f"attempts{' ('+purpose+')' if purpose else ''}: {exc}"
                    )
                    # Store raw LLM output for post-mortem debugging
                    self._last_raw_output = raw
                    raise ValueError(
                        f"Agent {self.ROLE} could not produce valid JSON: {exc}"
                    ) from exc

                logger.warning(
                    f"[{self.ROLE}] JSON parse error on attempt {attempt + 1}, retrying with feedback"
                )
                # Append bad output + corrective message before retry
                messages = messages + [
                    {"role": "assistant", "content": raw},
                    {
                        "role": "user",
                        "content": (
                            f"Your previous response was not valid JSON ({exc}). "
                            "Please respond ONLY with valid JSON — no markdown fences, "
                            "no preamble, no explanation. Just the JSON object."
                        ),
                    },
                ]
                continue

            # ── Schema validation (if provided) ──────────────────────────
            if output_schema is None:
                return parsed

            return await self._validate_schema(
                parsed, raw, messages, output_schema, purpose,
            )

        raise RuntimeError("think_json: unreachable")   # satisfies type checker

    async def _validate_schema(
        self,
        parsed: dict,
        raw_response: str,
        messages: list[dict],
        output_schema: type[BaseModel],
        purpose: str,
    ) -> dict:
        """
        Validate parsed JSON against a Pydantic schema.

        1. Try model_validate (non-strict — allows coercion).
        2. On failure, retry the LLM once with the schema definition appended.
        3. If the retry also fails validation, raise ValueError so the upstream
           _run_agent exception handler can route to the pod's on_failure policy.

        Fail-closed: returning a best-effort dict here lets downstream agents
        (especially Code Review) silently ship on permissive .get() defaults —
        e.g. a Code Review result that should have been "reject" but didn't
        match the schema would leak out as verdict="pass" via .get("verdict", "pass").
        """
        from pydantic import ValidationError

        # Attempt 1: validate/coerce the parsed dict
        try:
            validated = output_schema.model_validate(parsed)
            return validated.model_dump()
        except ValidationError as exc:
            logger.warning(
                "[%s] Schema validation failed%s: %s",
                self.ROLE,
                f" ({purpose})" if purpose else "",
                exc,
            )

        # Attempt 2: retry LLM with schema definition appended
        schema_json = json.dumps(output_schema.model_json_schema(), indent=2)
        retry_messages = messages + [
            {"role": "assistant", "content": raw_response},
            {
                "role": "user",
                "content": (
                    "Your previous response did not match the required schema. "
                    f"Please respond with valid JSON matching this exact schema:\n\n"
                    f"```json\n{schema_json}\n```\n\n"
                    "Respond ONLY with the JSON object — no markdown fences, "
                    "no preamble, no explanation."
                ),
            },
        ]

        retry_raw: str | None = None
        try:
            retry_raw = await self._call_llm(retry_messages)
            retry_cleaned = retry_raw.strip()
            if retry_cleaned.startswith("```"):
                lines = retry_cleaned.splitlines()
                retry_cleaned = "\n".join(
                    ln for ln in lines
                    if not ln.strip().startswith("```")
                ).strip()

            retry_parsed = json.loads(retry_cleaned)
            validated = output_schema.model_validate(retry_parsed)
            return validated.model_dump()
        except (json.JSONDecodeError, ValidationError) as exc:
            logger.error(
                "[%s] Schema validation retry also failed%s: %s — raising",
                self.ROLE,
                f" ({purpose})" if purpose else "",
                exc,
            )
            # Store raw LLM output for post-mortem debugging — the executor's
            # exception handler reads this and persists it to agent_sessions.output.
            self._last_raw_output = retry_raw if retry_raw is not None else raw_response
            # Fail-closed: raise so _run_agent's exception handler can route to
            # the pod's on_failure policy (abort / skip / escalate). Matches the
            # contract think_json already uses on JSON parse exhaustion above.
            raise ValueError(
                f"Agent {self.ROLE} could not produce schema-valid output "
                f"after retry"
                + (f" ({purpose})" if purpose else "")
                + f": {exc}"
            ) from exc

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _system_message(self) -> dict:
        return {"role": "system", "content": self.system_prompt}

    @staticmethod
    def _user_message(content: str) -> dict:
        return {"role": "user", "content": content}

    @staticmethod
    def _elapsed(start: float) -> int:
        """Return milliseconds since start."""
        return int((time.monotonic() - start) * 1000)
