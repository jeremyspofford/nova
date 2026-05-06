#!/usr/bin/env python3
"""Capture EXPLAIN ANALYZE baselines for activation + consolidation queries.

Connects to the LIVE `nova` database (not nova_test) via asyncpg. Runs
the four baseline queries the spec requires, captures their plans verbatim,
and writes a baselines markdown doc for human interpretation.

Re-run after Sprint 2 / Sprint 3 with --suffix to capture post-refactor plans.

Usage:
    cd memory-service
    uv run scripts/perf_baseline.py
    uv run scripts/perf_baseline.py --suffix post-sprint-2
    POSTGRES_DB_NAME=nova_other uv run scripts/perf_baseline.py
"""

from __future__ import annotations

import argparse
import asyncio
import os
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path

import asyncpg

BASELINES_DOC = Path(__file__).resolve().parent.parent.parent / (
    "docs/superpowers/specs/2026-05-05-memory-perf-explain-baselines.md"
)


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


async def _explain(conn: asyncpg.Connection, label: str, sql: str) -> str:
    """Run EXPLAIN (ANALYZE, BUFFERS, VERBOSE) on sql; return formatted output."""
    rows = await conn.fetch(f"EXPLAIN (ANALYZE, BUFFERS, VERBOSE) {sql}")
    plan = "\n".join(r["QUERY PLAN"] for r in rows)
    return f"### {label}\n\n```\n{plan}\n```\n"


async def _seed_ids(conn: asyncpg.Connection, n: int) -> list[str]:
    """Pick n stable seed engram IDs for the recursive-arm baseline."""
    rows = await conn.fetch(
        "SELECT id::text AS id FROM engrams "
        "WHERE NOT superseded AND embedding IS NOT NULL "
        "ORDER BY id LIMIT $1",
        n,
    )
    return [r["id"] for r in rows]


def _vector_literal(dim: int = 768, value: float = 0.1) -> str:
    """halfvec literal (cast at SQL level): '[0.1, 0.1, ...]' (768 components)."""
    return "[" + ",".join([f"{value}"] * dim) + "]"


async def _run() -> dict[str, str]:
    cfg = _conn_kwargs()
    conn = await asyncpg.connect(**cfg)
    try:
        engram_count = await conn.fetchval(
            "SELECT count(*) FROM engrams WHERE NOT superseded"
        )
        edge_count = await conn.fetchval("SELECT count(*) FROM engram_edges")
        pg_version = await conn.fetchval("SELECT version()")

        seeds = await _seed_ids(conn, 5)
        if len(seeds) < 5:
            sys.exit(f"[perf_baseline] Need >=5 engrams; found {len(seeds)}")
        seed3 = seeds[:3]

        results: dict[str, str] = {}

        embedding_lit = _vector_literal()
        seed_sql = f"""
            SELECT e.id,
                   (
                       (1 - (e.embedding <=> CAST('{embedding_lit}' AS halfvec)))
                       * CASE e.source_type
                           WHEN 'chat' THEN 1.5
                           WHEN 'consolidation' THEN 1.2
                           WHEN 'knowledge' THEN 0.7
                           WHEN 'intel' THEN 0.5
                           ELSE 1.0
                         END
                       * COALESCE(e.confidence, 0.5)
                   )::real AS boosted_sim
            FROM engrams e
            WHERE NOT e.superseded
              AND e.embedding IS NOT NULL
              AND e.tenant_id = '00000000-0000-0000-0000-000000000001'
              AND e.source_type IN ('chat', 'consolidation', 'self_reflection')
              AND e.activation >= 0.01
            ORDER BY boosted_sim DESC
            LIMIT 4
        """
        results["seed"] = await _explain(
            conn, "Baseline 1 — Seed query (personal branch, LIMIT 4)", seed_sql
        )

        seed_array = ",".join(f"'{s}'" for s in seeds)
        recursive_sql = f"""
            WITH RECURSIVE activation_spread AS (
                SELECT id, 0.5::real AS activation, 0 AS hop, ARRAY[id] AS path
                FROM engrams WHERE id IN ({seed_array})
                UNION ALL
                SELECT
                    neighbor.id,
                    LEAST(1.0, spread.activation * edge.weight * 0.6)::real AS activation,
                    spread.hop + 1,
                    spread.path || neighbor.id
                FROM activation_spread spread
                JOIN engram_edges edge ON (edge.source_id = spread.id OR edge.target_id = spread.id)
                JOIN engrams neighbor ON neighbor.id = CASE
                    WHEN edge.source_id = spread.id THEN edge.target_id
                    ELSE edge.source_id
                END
                WHERE spread.hop < 3
                  AND NOT neighbor.superseded
                  AND edge.relation != 'contradicts'
                  AND NOT (neighbor.id = ANY(spread.path))
                  AND (spread.activation * edge.weight * 0.6) > 0.1
            )
            SELECT count(*), max(hop), avg(array_length(path, 1)) FROM activation_spread
        """
        results["recursive"] = await _explain(
            conn,
            "Baseline 2 — Activation recursive arm (3 hops, 5 seeds)",
            recursive_sql,
        )

        ids3_array = "ARRAY[" + ",".join(f"'{s}'" for s in seed3) + "]"
        deep_sql = f"""
            SELECT DISTINCT e.id::text, e.type, e.content
            FROM engram_edges ee
            JOIN engrams e ON e.id = CASE
                WHEN ee.source_id = ANY(CAST({ids3_array} AS uuid[])) THEN ee.target_id
                ELSE ee.source_id
            END
            WHERE (ee.source_id = ANY(CAST({ids3_array} AS uuid[]))
                OR ee.target_id = ANY(CAST({ids3_array} AS uuid[])))
              AND ee.relation IN ('instance_of', 'part_of')
              AND NOT e.superseded
              AND e.id != ALL(CAST({ids3_array} AS uuid[]))
        """
        results["deep"] = await _explain(
            conn, "Baseline 3 — Deep-mode follow-up", deep_sql
        )

        cartesian_sql = """
            SELECT e1.id AS id1, e2.id AS id2,
                   1 - (e1.embedding <=> e2.embedding) AS similarity
            FROM engrams e1
            JOIN engrams e2 ON e2.id > e1.id
              AND e2.type = e1.type
              AND e2.source_type = e1.source_type
              AND NOT e2.superseded
              AND NOT e1.superseded
              AND e1.embedding IS NOT NULL
              AND e2.embedding IS NOT NULL
              AND 1 - (e1.embedding <=> e2.embedding) > 0.88
            LIMIT 20
        """
        results["cartesian"] = await _explain(
            conn, "Baseline 4 — Consolidation merge cartesian", cartesian_sql
        )

        results["_meta"] = (
            f"## Setup\n\n"
            f"- Captured: {datetime.now(timezone.utc).isoformat()}\n"
            f"- Host: {socket.gethostname()}\n"
            f"- Database: {cfg['database']} (live nova)\n"
            f"- Engram count (NOT superseded): {engram_count}\n"
            f"- Edge count: {edge_count}\n"
            f"- Postgres: {pg_version}\n"
            f"- Probe vector: 768d x 0.1 (synthetic; plan shape representative)\n"
            f"- Seed engram IDs (recursive baseline): {seeds}\n\n"
        )

        return results
    finally:
        await conn.close()


def _render(results: dict[str, str], suffix: str | None) -> str:
    title = (
        "# Memory Perf — EXPLAIN Baselines (2026-05-05)"
        if not suffix
        else f"# Memory Perf — EXPLAIN ({suffix.replace('-', ' ').title()})"
    )
    sections = [
        title,
        "",
        results["_meta"],
        results["seed"],
        "**Plan summary:** [fill in: Index Scan on idx_engrams_hnsw / re-rank cost / total time]",
        "",
        "**P6 verdict:** [DISMISS — HNSW dominates] | [ADD INDEX — re-rank scan is X% of time]",
        "",
        results["recursive"],
        "**Plan summary:** [fill in: scan strategy on engram_edges, total time, rows examined]",
        "",
        "**P1 main-arm verdict:** REWRITE (always — this is the cliff)",
        "",
        results["deep"],
        "**Plan summary:** [fill in: does idx_edges_structural get picked? total time]",
        "",
        "**P1 deep-mode verdict:** [LEAVE ALONE — partial index works] | [REWRITE — partial index unused]",
        "",
        results["cartesian"],
        "**Plan summary:** [fill in: Nested Loop with sequential scan, total rows x loops, time]",
        "",
        "**P2 verdict:** REWRITE (always — this is the second cliff)",
        "",
        "## Decisions taken from this baseline",
        "",
        "- P1 main arm: REWRITE",
        "- P1 deep mode: [decision]",
        "- P2 cartesian: REWRITE",
        "- P6 composite index: [decision with quoted % evidence]",
        "",
    ]
    return "\n".join(sections)


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture EXPLAIN ANALYZE baselines.")
    parser.add_argument("--suffix", type=str, default=None)
    parser.add_argument("--out", type=str, default=None)
    args = parser.parse_args()

    results = asyncio.run(_run())
    rendered = _render(results, args.suffix)

    if args.out:
        out_path = Path(args.out)
    elif args.suffix:
        out_path = BASELINES_DOC.with_name(
            BASELINES_DOC.stem + f"-{args.suffix}" + BASELINES_DOC.suffix
        )
    else:
        out_path = BASELINES_DOC

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(rendered)
    print(f"[perf_baseline] wrote {out_path}")


if __name__ == "__main__":
    main()
