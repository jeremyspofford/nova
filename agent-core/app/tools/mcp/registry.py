"""Boot all enabled stdio MCP servers from the DB at agent-core startup."""
import logging

from .lifecycle import start_server

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
        try:
            await start_server(
                server_id=server_id,
                command=row["command"],
                args=list(row["args"] or []),
                env=dict(row["env"] or {}),
                working_dir=row["working_dir"],
            )
        except Exception as exc:
            logger.warning("MCP server %s (%s) failed to start: %s", row["name"], server_id[:8], exc)
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE mcp_servers SET last_error = $1 WHERE id = $2",
                    str(exc), row["id"],
                )
