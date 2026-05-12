"""Filesystem tools: read, write, delete."""
import shutil
from pathlib import Path
from ..registry import tool, Tier
from ..context import ToolContext


@tool(tier=Tier.READ, timeout_s=10, name="fs.read")
async def fs_read(path: str, *, ctx: ToolContext) -> dict:
    """Read a file's content or list a directory's entries."""
    p = Path(path)
    if not p.exists():
        return {"error": f"Not found: {path}"}
    if p.is_dir():
        return {"type": "directory", "path": path, "entries": [str(e) for e in sorted(p.iterdir())]}
    content = p.read_text(errors="replace")
    return {"type": "file", "path": path, "content": content, "size": p.stat().st_size}


@tool(tier=Tier.MUTATE, reversible=True, cap_scope="fs:write:{path}", timeout_s=10, name="fs.write")
async def fs_write(path: str, content: str, *, ctx: ToolContext) -> dict:
    """Write text content to a file. Creates parent directories if needed."""
    p = Path(path)
    snapshot_id = None
    if ctx.snapshot and p.exists():
        snapshot_id = await ctx.snapshot(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return {"path": path, "bytes_written": len(content.encode()), "snapshot_id": snapshot_id}


@tool(tier=Tier.DESTRUCT, cap_scope="fs:delete:{path}", timeout_s=10, name="fs.delete")
async def fs_delete(path: str, *, ctx: ToolContext) -> dict:
    """Delete a file or directory recursively. Irreversible."""
    p = Path(path)
    if not p.exists():
        return {"error": f"Not found: {path}"}
    if p.is_dir():
        shutil.rmtree(path)
    else:
        p.unlink()
    return {"deleted": path}
