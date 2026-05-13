# memory-service/app/embed.py
import logging

import httpx

from .config import settings

logger = logging.getLogger(__name__)

_degraded: bool = True
_dim: int | None = None
_http: httpx.AsyncClient | None = None


def _client() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=30.0)
    return _http


async def probe_and_lock(pool) -> int | None:
    """Probe llm-gateway for embedding capability. Lock dimension in app_config."""
    global _degraded, _dim

    row = await pool.fetchrow(
        "SELECT value FROM app_config WHERE key = 'embedding_dim'"
    )
    if row:
        _dim = int(row["value"])
        _degraded = False
        logger.info("Embedding dimension locked to %d from app_config", _dim)
        try:
            r = await _client().post(
                f"{settings.llm_gateway_url}/embed",
                json={"input": "probe", "model": "auto"},
                timeout=10.0,
            )
            if r.status_code == 200:
                live_dim = len(r.json()["embedding"])
                if live_dim != _dim:
                    logger.warning(
                        "Embedding dimension mismatch: locked=%d, gateway=%d. "
                        "Clear app_config.embedding_dim and restart to switch providers.",
                        _dim, live_dim,
                    )
        except Exception:
            pass
        return _dim

    try:
        r = await _client().post(
            f"{settings.llm_gateway_url}/embed",
            json={"input": "probe", "model": "auto"},
            timeout=10.0,
        )
        r.raise_for_status()
        data = r.json()
        _dim = len(data["embedding"])
        await pool.execute(
            "INSERT INTO app_config (key, value) VALUES ('embedding_dim', $1) ON CONFLICT DO NOTHING",
            str(_dim),
        )
        _degraded = False
        logger.info("Embedding provider ready, dimension=%d", _dim)
        return _dim
    except Exception as exc:
        logger.warning("Embedding provider unavailable: %s — starting in degraded mode", exc)
        _degraded = True
        return None


def is_degraded() -> bool:
    return _degraded


async def embed_text(text: str) -> list[float] | None:
    """Embed a text string. Returns None if degraded or if the call fails."""
    if _degraded:
        return None
    try:
        r = await _client().post(
            f"{settings.llm_gateway_url}/embed",
            json={"input": text, "model": "auto"},
            timeout=30.0,
        )
        r.raise_for_status()
        return r.json()["embedding"]
    except Exception as exc:
        logger.warning("embed_text failed: %s", exc)
        return None


async def close() -> None:
    global _http
    if _http:
        await _http.aclose()
        _http = None
