"""
Engram decomposition pipeline — extracts structured engrams from raw text.

Uses a Haiku-class model with structured output to decompose conversation
turns into atomic memory nodes (engrams) with typed relationships.
"""

from __future__ import annotations

import json
import logging

import httpx
from app.config import settings
from nova_contracts.engram import DecompositionResult

log = logging.getLogger(__name__)

# Cache the resolved model so we don't probe every call.
# Set to None to force re-resolution (e.g. after config change via dashboard).
_resolved_model: str | None = None
_resolved_model_source: str | None = None  # "redis", "env", "probe" — for logging


def clear_model_cache() -> None:
    """Force re-resolution on next decompose() call. Called when config changes."""
    global _resolved_model, _resolved_model_source
    _resolved_model = None
    _resolved_model_source = None


async def resolve_model(model: str) -> str:
    """Resolve 'auto' to a concrete model by asking the gateway what's available.

    Resolution order:
      1. Redis nova:config:engram.decomposition_model (set via dashboard Settings)
      2. Env var ENGRAM_DECOMPOSITION_MODEL (bootstrap fallback)
      3. Gateway model resolution endpoint
      4. Probe common local models
    """
    global _resolved_model
    if model != "auto":
        return model
    if _resolved_model:
        return _resolved_model

    # Check Redis for dashboard-configured model (db1 = config DB)
    try:
        import json as _json

        import redis.asyncio as aioredis
        from app.config import settings as _settings

        config_redis_url = _settings.redis_url.rsplit("/", 1)[0] + "/1"
        r = aioredis.from_url(config_redis_url, decode_responses=True)
        try:
            raw = await r.get("nova:config:engram.decomposition_model")
            if raw:
                val = _json.loads(raw) if raw.startswith('"') else raw
                if val and val != "auto":
                    _resolved_model = val
                    log.info("Decomposition model from platform config: %s", val)
                    return _resolved_model
        finally:
            await r.aclose()
    except Exception:
        pass  # Redis unavailable — continue to other resolution methods

    # Try the gateway's model resolution endpoint
    try:
        async with httpx.AsyncClient(
            base_url=settings.llm_gateway_url, timeout=5.0
        ) as c:
            r = await c.get("/v1/models/resolve")
            if r.status_code == 200:
                _resolved_model = r.json().get("model", "")
                if _resolved_model:
                    log.info("Auto-resolved decomposition model: %s", _resolved_model)
                    return _resolved_model
    except Exception:
        pass

    # Fallback: probe common local models (ordered by structured output quality)
    for candidate in [
        "qwen2.5:7b",
        "qwen2.5",
        "qwen3:8b",
        "mistral",
        "llama3.2",
        "llama3.1:8b",
    ]:
        try:
            async with httpx.AsyncClient(
                base_url=settings.llm_gateway_url, timeout=10.0
            ) as c:
                r = await c.post(
                    "/complete",
                    json={
                        "model": candidate,
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 1,
                    },
                )
                if r.status_code == 200:
                    _resolved_model = candidate
                    log.info(
                        "Auto-resolved decomposition model via probe: %s", candidate
                    )
                    return _resolved_model
        except Exception:
            continue

    log.warning("Could not auto-resolve decomposition model, using llama3.1:8b")
    _resolved_model = "llama3.1:8b"
    return _resolved_model


DECOMPOSITION_SYSTEM_PROMPT_CHAT = """You are a memory decomposition engine. Extract structured knowledge from a conversation between a user and an AI assistant.

FOCUS: Extract information the USER STATES about themselves — their identity, preferences, knowledge, decisions, and experiences. The assistant's responses are context, not knowledge.

CRITICAL — ASKING vs STATING:
- A user ASKING about something ("What is X?", "Tell me about Y", "How does Z work?") is NOT a fact or preference about the user. Do NOT create engrams like "The user is interested in X" or "The user wants to know about Y" from questions.
- Only create engrams from things the user STATES or DECLARES: "I work at Aria Labs", "I prefer Python over Go", "I'm studying for AWS certification".
- Questions reveal the conversation topic, not the user's identity. Skip them.
- Exception: if a question reveals context ("How do I fix the auth bug I introduced yesterday?"), extract the stated fact ("User introduced an auth bug") but NOT "user is interested in auth bugs".

OUTPUT FORMAT: Valid JSON (no markdown fences). Return a DecompositionResult:
{
  "engrams": [...],
  "relationships": [...],
  "contradictions": []
}

ENGRAM GUIDELINES:
- Each engram should be a SELF-CONTAINED statement of 1-3 sentences
- Include enough context that the engram makes sense on its own, without needing other engrams
- DO NOT split closely related facts into separate engrams — keep them together
- BAD: "Jeremy founded Aria Labs" + "Aria Labs was founded in 2025" + "Aria Labs builds AI"
- GOOD: "Jeremy founded Aria Labs in 2025 to build autonomous AI platforms"
- Entity engrams (type=entity) are the exception — these should be atomic identifiers

TYPES:
- fact: Self-contained statement about the user or their world (1-3 sentences, include context)
- entity: Atomic identifier — a person, place, project, tool, concept (name only, keep short)
- preference: User preference with rationale ("prefers X because Y") — ONLY from explicit user statements, never inferred from questions
- episode: Something that happened, with context ("on date X, user did Y because Z")
- procedure: How to do something the user described (steps together, not split)

ANTI-PATTERNS — do NOT create engrams like these:
- "The user wants to know about X" (this is a question, not a fact)
- "The user is interested in X" (unless they explicitly said "I'm interested in X")
- "The user is asking about X" (questions are ephemeral, not identity)

IMPORTANCE (0.0-1.0):
- 0.9: Core identity, critical decisions, strong preferences
- 0.7: Significant facts, project details, professional context
- 0.5: Normal conversational facts
- 0.3: Minor details, passing mentions

TEMPORAL VALIDITY:
- For each engram, assess if it's time-sensitive:
  - "permanent": definitions, identities, math facts
  - "dated": news, releases, current events, versions
  - "unknown": can't determine

RELATIONSHIPS: Connect engrams that have meaningful associations. Use:
- related_to, caused_by, enables, part_of, instance_of, preceded, analogous_to

CONTRADICTIONS: If a new statement contradicts something the user previously said, flag it.

If the conversation is just greetings, one-off questions with no self-revealing context, or contains no extractable knowledge, return {"engrams": [], "relationships": [], "contradictions": []}.
"""

DECOMPOSITION_SYSTEM_PROMPT_INTEL = """You are a memory decomposition engine. Extract structured knowledge from external content (news articles, blog posts, forum discussions, documentation).

CRITICAL: This is THIRD-PARTY content, not the user speaking. Do NOT attribute statements as user preferences. Attribute to the source ("according to the article", "the author argues").

OUTPUT FORMAT: Valid JSON (no markdown fences). Return a DecompositionResult.

ENGRAM GUIDELINES:
- Each engram should be a SELF-CONTAINED statement of 1-3 sentences
- Include source attribution within the engram text itself
- Preserve key details: names, dates, versions, metrics
- BAD: "GPT-5 was released" + "GPT-5 has 10T parameters" + "GPT-5 was released in March"
- GOOD: "OpenAI released GPT-5 in March 2026 with 10T parameters, marking a significant scale increase"

TYPES: fact (objective claims), entity (people/orgs/tools), episode (events with dates), procedure (how-to), preference (community sentiment — attribute to source)

IMPORTANCE: 0.9=major announcements, 0.7=significant developments, 0.5=normal news, 0.3=minor updates

TEMPORAL VALIDITY: Most intel content is "dated" — include the timeframe in the engram text.
"""

DECOMPOSITION_USER_TEMPLATE = (
    "Decompose this into structured engrams. For each engram, include a "
    "temporal_validity field ('permanent', 'dated', or 'unknown').\n\n{raw_text}"
)

SOURCE_SUMMARY_PROMPT = """Summarize this content in exactly ONE paragraph (3-5 sentences).
Focus on: what this content IS (article, conversation, documentation), its main topic,
key takeaways, and any important names/dates/facts. This summary will be used to help
decide whether this source is relevant to a future question.

Content to summarize:
{content}"""


# Valid enum values from nova-contracts EdgeRelation
_VALID_RELATIONS = {
    "caused_by",
    "related_to",
    "contradicts",
    "preceded",
    "enables",
    "part_of",
    "instance_of",
    "analogous_to",
}


def _sanitize_decomposition(parsed: dict) -> None:
    """Fix common LLM output issues before Pydantic validation.

    LLMs (especially small ones) invent creative relationship types like
    'inspired_by', 'supports', 'contrasts_with' that aren't in the enum.
    Rather than rejecting the entire result (losing valid engrams), coerce
    unknown relations to 'related_to' and fix malformed contradictions.
    """
    # Coerce invalid relation types and fix field name variants
    clean_rels = []
    for rel in parsed.get("relationships", []):
        if not isinstance(rel, dict):
            continue
        if rel.get("relation") not in _VALID_RELATIONS:
            rel["relation"] = "related_to"
        # LLMs sometimes use source/target instead of from_index/to_index
        if "from_index" not in rel and "source" in rel:
            rel["from_index"] = rel.pop("source")
        if "to_index" not in rel and "target" in rel:
            rel["to_index"] = rel.pop("target")
        # Drop relationships missing required index fields
        if "from_index" in rel and "to_index" in rel:
            # Ensure indices are integers
            try:
                rel["from_index"] = int(rel["from_index"])
                rel["to_index"] = int(rel["to_index"])
                clean_rels.append(rel)
            except (ValueError, TypeError):
                continue
    parsed["relationships"] = clean_rels

    # Fix malformed contradictions (LLM sometimes uses 'engram_indices' instead of
    # the expected 'new_index' + 'existing_content_hint' fields)
    clean_contradictions = []
    for c in parsed.get("contradictions", []):
        if not isinstance(c, dict):
            continue
        if "new_index" in c and "existing_content_hint" in c:
            clean_contradictions.append(c)
        # else: drop malformed contradiction rather than failing validation
    parsed["contradictions"] = clean_contradictions


def _get_system_prompt(source_type: str) -> str:
    """Select decomposition prompt based on content source."""
    if source_type in ("intel", "knowledge"):
        return DECOMPOSITION_SYSTEM_PROMPT_INTEL
    return DECOMPOSITION_SYSTEM_PROMPT_CHAT


async def decompose(raw_text: str, source_type: str = "chat") -> DecompositionResult:
    """Call LLM Gateway to decompose raw text into structured engrams.

    Returns a DecompositionResult with engrams, relationships, and contradictions.
    On any failure, returns an empty result (never crashes the ingestion pipeline).
    """
    if not raw_text.strip():
        return DecompositionResult()

    try:
        model = await resolve_model(settings.engram_decomposition_model)

        system_prompt = _get_system_prompt(source_type)

        async with httpx.AsyncClient(
            base_url=settings.llm_gateway_url, timeout=60.0
        ) as client:
            resp = await client.post(
                "/complete",
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {
                            "role": "user",
                            "content": DECOMPOSITION_USER_TEMPLATE.format(
                                raw_text=raw_text
                            ),
                        },
                    ],
                    "temperature": 0.1,
                    "max_tokens": 4000,
                },
            )
            resp.raise_for_status()
            data = resp.json()

        content = data.get("content", "")
        if isinstance(content, list):
            content = content[0].get("text", "") if content else ""

        content = content.strip()
        # Strip markdown code fences if present
        if content.startswith("```"):
            lines = content.split("\n")
            content = "\n".join(
                lines[1:-1] if lines[-1].strip() == "```" else lines[1:]
            )

        parsed = json.loads(content)
        _sanitize_decomposition(parsed)
        return DecompositionResult.model_validate(parsed)

    except json.JSONDecodeError:
        log.warning("Failed to parse decomposition response as JSON")
        return DecompositionResult()
    except Exception:
        log.exception("Decomposition LLM call failed")
        return DecompositionResult()
