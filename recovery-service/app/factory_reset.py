"""Factory reset — selective data wipe with granular preservation options.

Covers every user-data surface Nova accumulates: postgres tables, filesystem
blobs under /app/data/, per-service Redis state, and backup archives.

Scope decisions (PRIV-003, see docs/audits/2026-04-16-phase0/BACKLOG.md):
- Conservative defaults ("Selective Reset") — memory, API keys, linked accounts,
  platform config, auth, and backups are kept unless explicitly unchecked.
- Everything routinely accumulated (chat, tasks, cortex, intel, knowledge,
  runtime caches) wiped by default.
- schema_migrations and tenants are never in scope (would break reboot).
"""

import logging
from pathlib import Path
from typing import Any

from .backup import _backup_dir
from .db import get_pool
from .redis_client import get_redis_for_db

logger = logging.getLogger("nova.recovery.factory_reset")


# Category definitions. Each category maps to:
#   label              — short UI label
#   description        — one-line explanation of what's inside
#   default_keep       — True if preserved by default (Option A "Selective Reset")
#   destructive_warning— optional string shown prominently when user unchecks it
#   tables             — postgres tables (TRUNCATE CASCADE, order = child → parent)
#   filesystem         — absolute paths to clear (directory contents, not the dir)
#   redis              — list of (db_number, key_pattern) tuples; pattern '*' = FLUSHDB
#   backups            — True to delete backup archives in BACKUP_DIR
#
# Ordering within CATEGORIES matters only for UI display; wipe order is
# explicitly leaf-first at runtime.

CATEGORIES: dict[str, dict[str, Any]] = {
    # ── Wipe by default (Tier 2 — routine reset content) ────────────────────
    "chat_history": {
        "label": "Chat history",
        "description": "Conversations, messages, sessions, activity log, outcome scores",
        "default_keep": False,
        "tables": [
            "conversation_outcomes",
            "activity_events",
            "messages",
            "conversations",
            "agent_sessions",
        ],
        "filesystem": [],
        "redis": [
            (2, "nova:state:scored_conversations:*"),
            (2, "nova:state:chat_scorer_cursor"),
        ],
        "backups": False,
    },
    "task_pipeline_history": {
        "label": "Task & pipeline history",
        "description": "Tasks, artifacts, code reviews, guardrail findings, training logs, quality scores, friction log (incl. screenshots)",
        "default_keep": False,
        "tables": [
            "artifacts",
            "code_reviews",
            "guardrail_findings",
            "pipeline_training_logs",
            "quality_scores",
            "quality_benchmark_runs",
            "friction_log",
            "tasks",
        ],
        "filesystem": ["/app/data/friction-screenshots"],
        "redis": [
            (2, "nova:agent:*:tasks"),
            (2, "nova:queue:dead_letter"),
        ],
        "backups": False,
    },
    "cortex_state": {
        "label": "Cortex brain state",
        "description": "Goals, iterations, cortex state, reflections, comments",
        "default_keep": False,
        "tables": [
            "comments",
            "goal_iterations",
            "goal_tasks",
            "cortex_reflections",
            "cortex_state",
            "goals",
        ],
        "filesystem": [],
        "redis": [(5, "nova:state:*")],
        "backups": False,
    },
    "intel_data": {
        "label": "Intel feed data",
        "description": "Feed subscriptions, fetched items, recommendations",
        "default_keep": False,
        "tables": [
            "intel_recommendation_memories",
            "intel_recommendation_sources",
            "intel_recommendations",
            "intel_content_items_archive",
            "intel_content_items",
            "intel_feeds",
        ],
        "filesystem": [],
        "redis": [(6, "*")],
        "backups": False,
    },
    "knowledge_data": {
        "label": "Knowledge crawler data",
        "description": "Source configs, crawl log, page cache, encrypted credentials",
        "default_keep": False,
        "tables": [
            "knowledge_credential_audit",
            "knowledge_credentials",
            "knowledge_crawl_log",
            "knowledge_page_cache",
            "knowledge_sources",
        ],
        "filesystem": [],
        "redis": [(8, "*")],
        "backups": False,
    },
    "runtime_caches": {
        "label": "Runtime caches & queues",
        "description": "Embedding cache, model catalog, rate limits, ingestion queue",
        "default_keep": False,
        "tables": ["embedding_cache"],
        "filesystem": [],
        "redis": [
            (0, "nova:embed:*"),
            (0, "memory:ingestion:queue"),
            (1, "nova:cache:embed:*"),
            (1, "nova:model_catalog:*"),
            (1, "nova:ratelimit:*"),
        ],
        "backups": False,
    },

    # ── Kept by default (Tier 1 — valuable/destructive) ─────────────────────
    "memory_and_knowledge": {
        "label": "Memory & knowledge",
        "description": "The OKF markdown memory bundle — topics, people, projects, preferences, journal, retrieval index",
        "default_keep": True,
        "tables": [],
        "filesystem": ["/workspace/memory"],
        "redis": [],
        "backups": False,
    },
    "api_keys": {
        "label": "API keys",
        "description": "Nova-issued API keys for programmatic access",
        "default_keep": True,
        "tables": ["api_keys"],
        "filesystem": [],
        "redis": [],
        "backups": False,
    },
    "platform_config": {
        "label": "Platform config",
        "description": "LLM provider keys, runtime overrides, MCP servers, skills, rules, self-mod history",
        "default_keep": True,
        "tables": [
            "platform_config_audit",
            "platform_config",
            "mcp_servers",
            "agent_endpoints",
            "skills",
            "rules",
            "selfmod_prs",
        ],
        "filesystem": [],
        "redis": [
            (1, "nova:config:*"),
            (2, "nova:config:*"),
            (5, "nova:config:*"),
            (6, "nova:config:*"),
            (8, "nova:config:*"),
        ],
        "backups": False,
    },
    "users_and_auth": {
        "label": "Users & authentication",
        "description": "User accounts, refresh tokens, invite codes, RBAC audit log",
        "default_keep": True,
        "destructive_warning": "Logs you out and requires re-registration. All users on this instance are deleted. Tables with FK to users (chat history, linked accounts, comments) are also removed via CASCADE.",
        "tables": [
            "refresh_tokens",
            "invite_codes",
            "rbac_audit_log",
            "audit_log",
            "users",
        ],
        "filesystem": [],
        "redis": [],
        "backups": False,
    },
    "backups": {
        "label": "Backup archives",
        "description": "All nova-backup-*.tar.gz and nova-checkpoint-*.tar.gz files",
        "default_keep": True,
        "destructive_warning": "Recovery from today's corruption requires one of these archives. Only wipe if you have external copies.",
        "tables": [],
        "filesystem": [],
        "redis": [],
        "backups": True,
    },
}

# Runtime wipe order — leaf categories first, then things other categories
# cascade from. users_and_auth last so its CASCADE cleans anything else.
WIPE_ORDER: list[str] = [
    "runtime_caches",
    "intel_data",
    "knowledge_data",
    "cortex_state",
    "task_pipeline_history",
    "chat_history",
    "memory_and_knowledge",
    "platform_config",
    "api_keys",
    "backups",
    "users_and_auth",
]


async def _wipe_postgres(categories_to_wipe: list[str]) -> dict[str, Any]:
    """TRUNCATE CASCADE for each requested category. Per-category transaction."""
    pool = get_pool()
    per_category: dict[str, dict[str, Any]] = {}
    total_truncated = 0

    async with pool.acquire() as conn:
        for cat_key in categories_to_wipe:
            cat = CATEGORIES[cat_key]
            tables = cat.get("tables", [])
            if not tables:
                per_category[cat_key] = {"tables_truncated": 0, "error": None}
                continue

            truncated_here: list[str] = []
            try:
                async with conn.transaction():
                    existing = await conn.fetch(
                        "SELECT table_name FROM information_schema.tables "
                        "WHERE table_schema = 'public' AND table_name = ANY($1)",
                        tables,
                    )
                    existing_names = [r["table_name"] for r in existing]
                    if existing_names:
                        joined = ", ".join(existing_names)
                        await conn.execute(f"TRUNCATE TABLE {joined} CASCADE")
                        truncated_here = existing_names
                        logger.info("Truncated tables for %s: %s", cat_key, joined)
                    missing = set(tables) - set(existing_names)
                    if missing:
                        logger.debug("Skipped non-existent tables in %s: %s", cat_key, missing)
                per_category[cat_key] = {
                    "tables_truncated": len(truncated_here),
                    "tables": truncated_here,
                    "error": None,
                }
                total_truncated += len(truncated_here)
            except Exception as e:
                logger.warning("Postgres wipe failed for %s: %s", cat_key, e)
                per_category[cat_key] = {
                    "tables_truncated": 0,
                    "tables": [],
                    "error": str(e),
                }

    return {"per_category": per_category, "total_truncated": total_truncated}


async def _wipe_redis_pattern(db: int, pattern: str) -> int:
    """Delete all keys matching pattern on the given Redis DB. Returns count."""
    r = await get_redis_for_db(db)
    deleted = 0
    if pattern == "*":
        # Full flush of that DB — single-op, fastest.
        await r.flushdb()
        # FLUSHDB doesn't return a count; best-effort 0 for stat purposes.
        return 0

    batch: list[str] = []
    async for key in r.scan_iter(match=pattern, count=500):
        batch.append(key)
        if len(batch) >= 500:
            deleted += await r.delete(*batch)
            batch.clear()
    if batch:
        deleted += await r.delete(*batch)
    return deleted


async def _wipe_redis(categories_to_wipe: list[str]) -> dict[str, Any]:
    per_category: dict[str, dict[str, Any]] = {}
    total_deleted = 0

    for cat_key in categories_to_wipe:
        patterns = CATEGORIES[cat_key].get("redis", [])
        if not patterns:
            per_category[cat_key] = {"keys_deleted": 0, "error": None}
            continue

        deleted_here = 0
        errors: list[str] = []
        for db, pattern in patterns:
            try:
                n = await _wipe_redis_pattern(db, pattern)
                deleted_here += n
                logger.info("Redis wipe: db%d %s → %d key(s)", db, pattern, n)
            except Exception as e:
                logger.warning("Redis wipe failed for db%d %s: %s", db, pattern, e)
                errors.append(f"db{db} {pattern}: {e}")

        per_category[cat_key] = {
            "keys_deleted": deleted_here,
            "error": "; ".join(errors) if errors else None,
        }
        total_deleted += deleted_here

    return {"per_category": per_category, "total_keys_deleted": total_deleted}


def _wipe_directory_contents(path: Path) -> int:
    """Best-effort: remove all files under path (recursively), keep the dir itself.
    Returns count of files removed. Logs and continues on per-file failures."""
    if not path.exists() or not path.is_dir():
        return 0
    removed = 0
    for f in list(path.rglob("*")):
        if f.is_file() or f.is_symlink():
            try:
                f.unlink()
                removed += 1
            except OSError as e:
                logger.warning("Could not unlink %s: %s", f, e)
    # Clean up now-empty subdirectories (depth-first).
    for d in sorted(path.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if d.is_dir():
            try:
                d.rmdir()
            except OSError:
                pass
    return removed


def _wipe_filesystem(categories_to_wipe: list[str]) -> dict[str, Any]:
    per_category: dict[str, dict[str, Any]] = {}
    total_files_removed = 0

    for cat_key in categories_to_wipe:
        paths = CATEGORIES[cat_key].get("filesystem", [])
        removed_here = 0
        errors: list[str] = []
        for p in paths:
            try:
                removed_here += _wipe_directory_contents(Path(p))
                logger.info("Filesystem wipe: %s cleared", p)
            except Exception as e:
                logger.warning("Filesystem wipe failed for %s: %s", p, e)
                errors.append(f"{p}: {e}")

        per_category[cat_key] = {
            "files_removed": removed_here,
            "error": "; ".join(errors) if errors else None,
        }
        total_files_removed += removed_here

    return {"per_category": per_category, "total_files_removed": total_files_removed}


def _wipe_backups() -> dict[str, Any]:
    """Remove every backup archive in BACKUP_DIR. Returns count + bytes reclaimed."""
    d = _backup_dir()
    if not d.exists() or not d.is_dir():
        return {"files_removed": 0, "bytes_reclaimed": 0}

    files_removed = 0
    bytes_reclaimed = 0
    for f in list(d.glob("nova-backup-*.tar.gz")) + list(d.glob("nova-checkpoint-*.tar.gz")):
        try:
            bytes_reclaimed += f.stat().st_size
            f.unlink()
            files_removed += 1
            logger.info("Backup wipe: removed %s", f.name)
        except OSError as e:
            logger.warning("Could not remove backup %s: %s", f, e)
    return {"files_removed": files_removed, "bytes_reclaimed": bytes_reclaimed}


async def factory_reset(keep: set[str] | None = None) -> dict:
    """Wipe every category NOT in `keep`. Runs Redis → Postgres → Filesystem
    so that fast/reversible work finishes first and destructive FS work last.

    Returns a result envelope with per-category detail plus aggregate stats.
    """
    if keep is None:
        keep = {k for k, v in CATEGORIES.items() if v.get("default_keep")}

    unknown = keep - set(CATEGORIES.keys())
    if unknown:
        raise ValueError(f"Unknown category keys: {sorted(unknown)}")

    wipe_list = [k for k in WIPE_ORDER if k not in keep]
    kept_list = [k for k in CATEGORIES if k in keep]

    redis_result = await _wipe_redis(wipe_list)
    pg_result = await _wipe_postgres(wipe_list)
    fs_result = _wipe_filesystem(wipe_list)
    backup_result = (
        _wipe_backups() if "backups" in wipe_list else {"files_removed": 0, "bytes_reclaimed": 0}
    )

    errors: list[str] = []
    for src, per_cat in (
        ("postgres", pg_result["per_category"]),
        ("redis", redis_result["per_category"]),
        ("filesystem", fs_result["per_category"]),
    ):
        for cat_key, detail in per_cat.items():
            if detail.get("error"):
                errors.append(f"[{src}/{cat_key}] {detail['error']}")

    logger.info(
        "Factory reset complete — wiped %s, kept %s "
        "(tables=%d, redis_keys=%d, fs_files=%d, backups=%d)",
        wipe_list,
        kept_list,
        pg_result["total_truncated"],
        redis_result["total_keys_deleted"],
        fs_result["total_files_removed"],
        backup_result["files_removed"],
    )

    return {
        "wiped": wipe_list,
        "kept": kept_list,
        "errors": errors if errors else None,
        "stats": {
            "tables_truncated": pg_result["total_truncated"],
            "redis_keys_deleted": redis_result["total_keys_deleted"],
            "filesystem_files_removed": fs_result["total_files_removed"],
            "backup_files_removed": backup_result["files_removed"],
            "backup_bytes_reclaimed": backup_result["bytes_reclaimed"],
        },
        "detail": {
            "postgres": pg_result["per_category"],
            "redis": redis_result["per_category"],
            "filesystem": fs_result["per_category"],
            "backups": backup_result,
        },
    }


def get_categories() -> list[dict]:
    """Return available categories in UI display order with labels and defaults."""
    return [
        {
            "key": key,
            "label": cat["label"],
            "description": cat.get("description", ""),
            "default_keep": cat.get("default_keep", False),
            "destructive_warning": cat.get("destructive_warning"),
        }
        for key, cat in CATEGORIES.items()
    ]
