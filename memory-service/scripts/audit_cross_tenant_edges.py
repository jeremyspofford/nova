#!/usr/bin/env python3
"""Audit cross-tenant edges in the live engram_edges table.

If count == 0: no cleanup migration needed; activation tenant-filter fix is safe.
If count > 0: prints a per-tenant-pair breakdown and recommends a cleanup migration.

Connects to LIVE nova DB via POSTGRES_* env vars (defaults match docker-compose).

Usage:
    cd memory-service
    uv run scripts/audit_cross_tenant_edges.py
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import asyncpg


def _autoload_env() -> None:
    """Load repo-root .env if present so POSTGRES_PASSWORD overrides apply."""
    env_file = Path(__file__).resolve().parent.parent.parent / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _conn_kwargs() -> dict:
    _autoload_env()
    return {
        "user": os.environ.get("POSTGRES_USER", "nova"),
        "password": os.environ.get("POSTGRES_PASSWORD", "nova_dev_password"),
        "host": os.environ.get("POSTGRES_HOST", "localhost"),
        "port": int(os.environ.get("POSTGRES_PORT", "5432")),
        "database": os.environ.get("POSTGRES_DB_NAME", "nova"),
    }


async def _audit() -> None:
    conn = await asyncpg.connect(**_conn_kwargs())
    try:
        total = await conn.fetchval("""
            SELECT count(*) FROM engram_edges ee
            JOIN engrams es ON es.id = ee.source_id
            JOIN engrams et ON et.id = ee.target_id
            WHERE es.tenant_id <> et.tenant_id
        """)
        print(f"\nCross-tenant edges in live data: {total}")

        if total == 0:
            print("\nVerdict: NO cleanup migration needed.")
            print("Activation tenant-filter fix is safe to ship in Sprint 2.")
            return

        print(f"\n{total} cross-tenant edges found. Diagnosing...\n")
        rows = await conn.fetch("""
            SELECT es.tenant_id::text AS source_tenant,
                   et.tenant_id::text AS target_tenant,
                   count(*) AS edge_count,
                   array_agg(DISTINCT ee.relation ORDER BY ee.relation) AS relations
            FROM engram_edges ee
            JOIN engrams es ON es.id = ee.source_id
            JOIN engrams et ON et.id = ee.target_id
            WHERE es.tenant_id <> et.tenant_id
            GROUP BY es.tenant_id, et.tenant_id
            ORDER BY edge_count DESC
        """)
        for r in rows:
            print(
                f"  {r['source_tenant']} -> {r['target_tenant']}: "
                f"{r['edge_count']} edges, relations={r['relations']}"
            )

        print(
            "\nVerdict: cleanup migration required before Sprint 2.\n"
            "See task plan Step 3 for the SQL cleanup migration template."
        )
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(_audit())
