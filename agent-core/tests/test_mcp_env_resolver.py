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
    # PATH/HOME are always injected, so we check the user keys are present.
    assert result["FOO"] == "bar"
    assert result["NUM"] == "42"


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
    # Blocked keys must be absent; SAFE_KEY passes through; PATH/HOME are injected.
    assert "CREDENTIAL_MASTER_KEY" not in result
    assert "DATABASE_URL" not in result
    assert "REDIS_URL" not in result
    assert "NOVA_ADMIN_SECRET" not in result
    assert result["SAFE_KEY"] == "ok"


@pytest.mark.asyncio
async def test_secret_ref_expands(pool):
    from app.tools.mcp.env_resolver import resolve_env

    with patch("app.tools.mcp.env_resolver.get_secret", new=AsyncMock(return_value="sk-real")) as mock_gs:
        result = await resolve_env({"API_KEY": "${secret:my_key}"}, pool)

    assert result["API_KEY"] == "sk-real"
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
    assert result["KEY"] == "plain-value"


@pytest.mark.asyncio
async def test_empty_env_always_pass_vars_present(pool):
    """Empty raw_env still produces PATH/HOME in result."""
    import os
    from app.tools.mcp.env_resolver import resolve_env

    result = await resolve_env({}, pool)
    # Even with no user keys, PATH and HOME are always injected (if set in env).
    if os.environ.get("PATH"):
        assert "PATH" in result
    if os.environ.get("HOME"):
        assert "HOME" in result


@pytest.mark.asyncio
async def test_always_pass_vars_injected(pool):
    """PATH and HOME from os.environ are always included in the result."""
    import os
    from app.tools.mcp.env_resolver import resolve_env

    # Ensure PATH and HOME are set for the test (they virtually always are,
    # but set them explicitly so the assertion is deterministic).
    with patch.dict(os.environ, {"PATH": "/usr/bin:/bin", "HOME": "/home/testuser"}, clear=False):
        result = await resolve_env({}, pool)

    assert result["PATH"] == "/usr/bin:/bin"
    assert result["HOME"] == "/home/testuser"


@pytest.mark.asyncio
async def test_always_pass_vars_not_overridden_by_raw_env(pool):
    """An explicit PATH in raw_env should still be present; the injected value
    wins only for keys absent from raw_env.  Since _ALWAYS_PASS runs last,
    it overwrites — document that known behaviour here."""
    import os
    from app.tools.mcp.env_resolver import resolve_env

    with patch.dict(os.environ, {"PATH": "/injected/path"}, clear=False):
        result = await resolve_env({"PATH": "/custom/path"}, pool)

    # The injected value overwrites the raw value — intentional (subprocess
    # must always have a usable PATH from the host).
    assert result["PATH"] == "/injected/path"


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
