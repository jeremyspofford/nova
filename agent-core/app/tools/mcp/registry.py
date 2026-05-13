"""Boot all enabled stdio MCP servers from the DB at agent-core startup."""
import logging

from . import mcp_manager

logger = logging.getLogger(__name__)


async def boot_mcp_servers(pool) -> None:
    """Load enabled stdio MCP rows and bring each up. Failures are isolated."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, name, command, args, env, working_dir "
            "FROM mcp_servers WHERE enabled = true AND transport = 'stdio'"
        )
    for row in rows:
        server_id = str(row["id"])
        server_name = row["name"]
        mcp_manager.register_server_meta(
            server_name, server_id,
            command=row["command"],
            args=list(row["args"] or []),
            raw_env=dict(row["env"] or {}),
            cwd=row["working_dir"],
        )
        try:
            await mcp_manager.ensure_running(server_id, server_name)
        except Exception as exc:
            logger.warning("MCP server %s (%s) failed to start: %s", server_name, server_id[:8], exc)
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE mcp_servers SET last_error = $1 WHERE id = $2",
                    str(exc), row["id"],
                )
