# memory-service/app/extraction.py
"""Distill chat exchanges into structured, self-contained memories.

Raw transcript chunks were v1's core memory failure — context-free blobs that
ranked poorly and read worse. Extraction asks the LLM for durable statements
(facts, preferences, events, insights) instead. Failure of any kind falls back
to storing the original text verbatim: losing a memory is the one unacceptable
outcome.
"""
import json
import logging

import httpx

from .config import settings
from . import embed, store

logger = logging.getLogger(__name__)

VALID_KINDS = {"fact", "preference", "event", "insight"}
MAX_ITEMS = 5
MAX_INPUT_CHARS = 4000
DEDUP_SIMILARITY = 0.93

# Kept deliberately small and few-shot: this must work on 1.5-3B local models.
_SYSTEM_PROMPT = """\
You extract durable memories from a conversation exchange for a personal AI assistant.

Extract ONLY information THE USER STATED about themselves, their world, their \
preferences, or requests they made. NEVER extract claims, answers, or guesses the \
Assistant/Nova produced — the assistant can be wrong, and storing its claims as \
user facts poisons memory. Each memory must be a short, self-contained statement \
understandable without the conversation.

Output ONLY a JSON array, no other text. Max 5 items. Each item:
{"text": "...", "kind": "fact|preference|event|insight", "importance": 0.0-1.0}

importance: 0.9+ identity/strong preferences, 0.5-0.8 useful context, <0.5 minor.
If the user stated nothing worth remembering, output [].

Example input:
User: I'm allergic to peanuts btw, and I moved to Denver last month.
Assistant: Noted! How is the new city treating you?

Example output:
[{"text": "User is allergic to peanuts", "kind": "fact", "importance": 0.95},
 {"text": "User moved to Denver (as of last month)", "kind": "event", "importance": 0.7}]"""

# Distinctive fragments from the few-shot example. Small models sometimes
# bleed example content into their output; anything matching these is a
# bleed, never a real memory (observed live: "User's favorite color is
# green" invented from an earlier example's assistant line).
_EXAMPLE_FRAGMENTS = ("allergic to peanuts", "moved to denver")

_http: httpx.AsyncClient | None = None


def _client() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=settings.extraction_timeout_s)
    return _http


async def close() -> None:
    global _http
    if _http:
        await _http.aclose()
        _http = None


def _parse_items(raw: str) -> list[dict] | None:
    """Parse the LLM's JSON array. Returns None when unusable."""
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    # Some models wrap the array in prose — find the outermost brackets.
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(data, list):
        return None
    items: list[dict] = []
    for entry in data[:MAX_ITEMS]:
        if not isinstance(entry, dict):
            continue
        content = str(entry.get("text", "")).strip()
        if not content:
            continue
        kind = str(entry.get("kind", "fact")).strip().lower()
        if kind not in VALID_KINDS:
            kind = "fact"
        try:
            importance = float(entry.get("importance", 0.5))
        except (TypeError, ValueError):
            importance = 0.5
        importance = min(max(importance, 0.0), 1.0)
        items.append({"text": content, "kind": kind, "importance": importance})
    return items


def _split_exchange(content: str) -> tuple[str, str]:
    """Split a 'User: ...\\nNova: ...' exchange into (user_part, assistant_part).
    Content without that shape is treated as all-user."""
    for sep in ("\nNova:", "\nAssistant:", "\nassistant:"):
        if sep in content:
            user_part, assistant_part = content.split(sep, 1)
            return user_part, assistant_part
    return content, ""


def _words(text: str) -> set[str]:
    return {w for w in "".join(c if c.isalnum() else " " for c in text.lower()).split() if len(w) > 3}


def _assistant_sourced(item_text: str, user_part: str, assistant_part: str) -> bool:
    """True when an extracted claim's distinctive words trace to the assistant's
    turn rather than the user's. Deterministic backstop for the prompt rule —
    small models sometimes launder the assistant's answers into 'user facts'
    (observed: hallucinated favorite color stored as a 0.95 preference)."""
    if not assistant_part:
        return False
    item_words = _words(item_text)
    if not item_words:
        return False
    user_overlap = len(item_words & _words(user_part))
    assistant_overlap = len(item_words & _words(assistant_part))
    return assistant_overlap > user_overlap


async def _llm_extract(content: str) -> list[dict] | None:
    """One LLM call → parsed items, or None on any failure."""
    try:
        r = await _client().post(
            f"{settings.llm_gateway_url}/complete",
            json={
                "messages": [
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": content[:MAX_INPUT_CHARS]},
                ],
                "model": settings.extraction_model,
                "max_tokens": 500,
                "temperature": 0.1,
            },
        )
        r.raise_for_status()
        return _parse_items(r.json().get("content", ""))
    except Exception as exc:
        logger.warning("extraction LLM call failed: %s", exc)
        return None


async def _store_item(pool, item: dict, source_kind: str, source_uri: str | None) -> str:
    """Dedup-aware insert. The candidate vector is computed here once: it
    serves the dedup check AND gets stored directly, so extracted rows skip
    the embed queue entirely (and a dedup hit updates content+vector
    atomically — no stale-embedding window)."""
    vector = await embed.embed_text(item["text"]) if not embed.is_degraded() else None

    if vector is not None:
        dupes = await store.search_memories(
            pool, embedding=vector, query=item["text"], limit=1,
            min_similarity=DEDUP_SIMILARITY,
        )
        if dupes:
            dupe = dupes[0]
            await pool.execute(
                """
                UPDATE memories
                SET content = $2, embedding = $3,
                    importance = GREATEST(importance, $4),
                    used_count = used_count + 1, last_used = now()
                WHERE id = $1::uuid
                """,
                dupe["id"], item["text"], vector, item["importance"],
            )
            logger.debug("extraction dedup: refreshed %s", dupe["id"])
            return dupe["id"]

    return await store.write_memory(
        pool, item["text"], source_kind, source_uri,
        kind=item["kind"], importance=item["importance"],
        tags=[item["kind"]], embedding=vector,
    )


async def process_exchange(pool, redis, payload: dict) -> list[str]:
    """Extract memories from one exchange. Always stores something.

    Returns the stored memory ids (fallback row included)."""
    content = payload.get("content", "")
    source_kind = payload.get("source_kind", "chat")
    source_uri = payload.get("source_uri")
    if not content.strip():
        return []

    items = await _llm_extract(content)
    if items is None:
        items = await _llm_extract(content)  # one retry

    if items is None:
        # Lossless fallback: keep the verbatim exchange as a low-importance event.
        memory_id = await store.write_memory(
            pool, content, source_kind, source_uri, kind="event", importance=0.3,
        )
        try:
            await redis.rpush("memory:embed:queue", memory_id)
        except Exception as exc:
            logger.warning("failed to queue fallback memory for embedding: %s", exc)
        logger.info("extraction fell back to verbatim storage (%s)", memory_id)
        return [memory_id]

    user_part, assistant_part = _split_exchange(content)
    ids: list[str] = []
    for item in items:
        lowered = item["text"].lower()
        if any(frag in lowered for frag in _EXAMPLE_FRAGMENTS):
            logger.info("dropping few-shot-bleed extraction: %.60s", item["text"])
            continue
        if _assistant_sourced(item["text"], user_part, assistant_part):
            logger.info("dropping assistant-sourced extraction: %.60s", item["text"])
            continue
        try:
            ids.append(await _store_item(pool, item, source_kind, source_uri))
        except Exception as exc:
            logger.warning("failed to store extracted item %r: %s", item["text"][:60], exc)
    # All items stored without vectors (degraded embeds) still need embedding later.
    for mid in ids:
        try:
            has_vec = await pool.fetchval(
                "SELECT embedding IS NOT NULL FROM memories WHERE id = $1::uuid", mid
            )
            if not has_vec:
                await redis.rpush("memory:embed:queue", mid)
        except Exception:
            pass
    logger.info("extracted %d memories from exchange", len(ids))
    return ids
