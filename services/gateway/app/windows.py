"""The context window a provider's listing DECLARES per model (S38b T5).

A cloud link has no /api/ps: the window it is served with is not readable.
Its listing states a `context_length` (the normalized listing row's key,
openai_chat.normalize_models / the Anthropic listing), and that is kept here
on every listing fetch, so a completion is stated a window without fetching
a listing. A declared window is the provider's word, never a reading: the
gateway states it marked `declared`, and only for a link whose origin states
no served window (data_plane.served_stamp)."""

from __future__ import annotations

import asyncpg


def declared_lengths(models: list[dict]) -> dict[str, int]:
    """{model id: declared context_length} for every listed model stating a
    positive whole number. Anything else states no window (absent, never 0)."""
    out: dict[str, int] = {}
    for m in models:
        if not isinstance(m, dict) or not m.get("id"):
            continue
        length = m.get("context_length")
        if isinstance(length, int) and not isinstance(length, bool) and length > 0:
            out[str(m["id"])] = length
    return out


async def record_listing_windows(pool: asyncpg.Pool, provider: str, models: list[dict]) -> int:
    """The provider's declared windows become exactly what THIS listing
    stated: rows for models it no longer lists (or that no longer state a
    length) are deleted, the rest written. One transaction."""
    lengths = declared_lengths(models)
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "DELETE FROM provider_windows "
                "WHERE provider = $1 AND NOT (model = ANY($2::text[]))",
                provider,
                list(lengths),
            )
            if lengths:
                await conn.executemany(
                    "INSERT INTO provider_windows (provider, model, context_length, read_at) "
                    "VALUES ($1, $2, $3, now()) ON CONFLICT (provider, model) DO UPDATE SET "
                    "context_length = EXCLUDED.context_length, read_at = now()",
                    [(provider, model, length) for model, length in lengths.items()],
                )
    return len(lengths)


async def declared_window(pool: asyncpg.Pool, provider: str, model: str) -> int | None:
    """The window `provider`'s last listing declared for `model`, or None."""
    return await pool.fetchval(
        "SELECT context_length FROM provider_windows WHERE provider = $1 AND model = $2",
        provider,
        model,
    )
