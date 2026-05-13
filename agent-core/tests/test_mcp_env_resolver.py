"""Tests for app.tools.mcp.env_resolver."""
import pytest
from unittest.mock import AsyncMock, patch


@pytest.fixture
def pool():
    return object()  # real pool not needed — get_secret is patched


@pytest.mark.asyncio
async def test_plain_values_pass_through(pool):
    from app.tools.mcp.env_resolver import resolve_env

    result = await resolve_env({"FOO": "bar", "NUM": "42"}, pool)
    assert result == {"FOO": "bar", "NUM": "42"}


@pytest.mark.asyncio
async def test_blocked_keys_are_stripped(pool):
    from app.tools.mcp.env_resolver import resolve_env

    raw = {
        "CREDENTIAL_MASTER_KEY": "secret",
        "DATABASE_URL": "postgres://...",
        "REDIS_URL": "redis://...",
        "NOVA_ADMIN_SECRET": "s3cr3t",
        "SAFE_KEY": "ok",
    }
    result = await resolve_env(raw, pool)
    assert result == {"SAFE_KEY": "ok"}


@pytest.mark.asyncio
async def test_secret_ref_expands(pool):
    from app.tools.mcp.env_resolver import resolve_env

    with patch("app.tools.mcp.env_resolver.get_secret", new=AsyncMock(return_value="sk-real")) as mock_gs:
        result = await resolve_env({"API_KEY": "${secret:my_key}"}, pool)

    assert result == {"API_KEY": "sk-real"}
    mock_gs.assert_awaited_once()


@pytest.mark.asyncio
async def test_secret_ref_not_found_raises(pool):
    from app.tools.mcp.env_resolver import resolve_env

    with patch("app.tools.mcp.env_resolver.get_secret", new=AsyncMock(return_value=None)):
        with pytest.raises(RuntimeError, match="secret not found"):
            await resolve_env({"API_KEY": "${secret:missing}"}, pool)


@pytest.mark.asyncio
async def test_non_ref_string_not_looked_up(pool):
    from app.tools.mcp.env_resolver import resolve_env

    with patch("app.tools.mcp.env_resolver.get_secret", new=AsyncMock()) as mock_gs:
        result = await resolve_env({"KEY": "plain-value"}, pool)

    mock_gs.assert_not_awaited()
    assert result == {"KEY": "plain-value"}


@pytest.mark.asyncio
async def test_empty_env_returns_empty(pool):
    from app.tools.mcp.env_resolver import resolve_env

    result = await resolve_env({}, pool)
    assert result == {}


@pytest.mark.asyncio
async def test_mixed_blocked_and_secret(pool):
    from app.tools.mcp.env_resolver import resolve_env

    with patch("app.tools.mcp.env_resolver.get_secret", new=AsyncMock(return_value="resolved")) as mock_gs:
        result = await resolve_env(
            {"DATABASE_URL": "postgres://...", "API_KEY": "${secret:my_key}", "SAFE": "ok"},
            pool,
        )

    assert "DATABASE_URL" not in result
    assert result["API_KEY"] == "resolved"
    assert result["SAFE"] == "ok"
    mock_gs.assert_awaited_once()
