"""Idempotency ledger for side-effecting agent tools.

Nova's crash-recovery machinery is *designed* to re-run work:
  - the reaper re-pushes tasks stuck in 'queued' (reaper.py) and
  - the pipeline checkpoint system re-enters a stage that crashed before
    save_checkpoint().

Both are safe for pure recomputation. They are NOT safe for a stage that
already fired an irreversible, outward-facing tool call — replaying it opens a
second PR, pushes a branch again, sends a duplicate phone push. This module
guards exactly that window.

Protocol (claim → commit → rollback):
  1. CLAIM: INSERT a row (status='in_progress') keyed by
     sha256(task_id : tool_name : canonical_args). ON CONFLICT DO NOTHING.
  2. If the claim was won, run the tool, then COMMIT the result
     (status='done', result=<tool output>).
  3. If the tool raises, ROLLBACK the claim (DELETE) so a legitimate retry
     can happen — a transient failure must not permanently block the action.
  4. On replay, the row already exists:
       - status='done'        → return the cached result, do NOT re-execute.
       - status='in_progress' → a prior attempt's fate is UNKNOWN (crashed
         between claim and commit). For irreversible actions we err toward NOT
         repeating and surface the ambiguity so the agent/operator can verify.

Keying contract (deliberate): the key is (task_id, tool_name, canonical_args)
with NO call ordinal. This means "at most once per task per identical args" for
the wrapped tools. For this hand-picked set that semantic is correct, not a
limitation — two identical `github_create_pr` calls in one task is a duplicate,
not intent; an identical `github_push_branch` is idempotent anyway. Tools where
a legitimate same-args repeat is meaningful (run_shell, write_file) are
deliberately NOT wrapped — see IDEMPOTENT_TOOLS below.
"""

from __future__ import annotations

import hashlib
import json
import logging

from .db import get_pool

logger = logging.getLogger(__name__)

# ── Wrapped tool set ─────────────────────────────────────────────────────────
#
# Only irreversible / outward-facing tools whose "at most once per task per
# identical args" semantics are correct. Read-only tools (search_memory,
# git_status, …) need no ledger — the key computation would be pure overhead.
#
# Deliberately EXCLUDED and why:
#   run_shell        — arg-hash idempotency would suppress legitimate intended
#                      re-runs (e.g. `git add -A` across stages); resume-safety
#                      for shell belongs at checkpoint granularity, not here.
#   write_file       — naturally idempotent (same path+content → same state).
#   store_web_credential — overwrite semantics, idempotent.
#   config rule/skill create/update/delete — low blast radius; create is
#                      name-unique so a double-create fails loud, not silent.
#   checkpoint / github_external — already gated (consent/approval) with their
#                      own audit trail; resuming a checkpoint is legitimate.
IDEMPOTENT_TOOLS: frozenset[str] = frozenset({
    "github_create_pr",
    "github_push_branch",
    "github_create_branch",
    "git_commit",
    "send_push",
    "create_recommendation",
})


def _canonical_args(arguments: dict) -> str:
    """Stable JSON encoding of tool arguments (sorted keys) for hashing."""
    try:
        return json.dumps(arguments, sort_keys=True, default=str, separators=(",", ":"))
    except (TypeError, ValueError):
        # Unserializable args → fall back to repr; still deterministic enough
        # to dedupe an identical replay of the same call.
        return repr(sorted(arguments.items())) if isinstance(arguments, dict) else repr(arguments)


def _key(task_id: str, tool_name: str, arguments: dict) -> str:
    raw = f"{task_id}:{tool_name}:{_canonical_args(arguments)}"
    return hashlib.sha256(raw.encode()).hexdigest()


async def run_idempotent(task_id: str, tool_name: str, arguments: dict, fn) -> str:
    """Execute ``fn`` at most once per (task_id, tool_name, args).

    ``fn`` is an awaitable returning the tool's result string. Returns the
    tool's result (fresh on first execution, cached on replay).

    Fails OPEN: if the ledger DB is unreachable we run the tool rather than
    block an agent on infra trouble — the ledger is a safety net over the
    recovery paths, not a hard gate on normal operation.
    """
    key = _key(task_id, tool_name, arguments)
    pool = get_pool()

    # ── 1. CLAIM ─────────────────────────────────────────────────────────────
    try:
        async with pool.acquire() as conn:
            claimed = await conn.fetchrow(
                """
                INSERT INTO tool_execution_log (idempotency_key, task_id, tool_name)
                VALUES ($1, $2::uuid, $3)
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING idempotency_key
                """,
                key, task_id, tool_name,
            )
    except Exception as e:
        logger.warning(
            "Idempotency claim failed for %s (task %s): %s — executing without ledger",
            tool_name, task_id, e,
        )
        return await fn()

    # ── 4. REPLAY (claim lost — a row already existed) ───────────────────────
    if claimed is None:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status, result FROM tool_execution_log WHERE idempotency_key = $1",
                key,
            )
        if row and row["status"] == "done":
            logger.info(
                "Idempotent replay: %s already completed for task %s — returning cached result",
                tool_name, task_id,
            )
            return row["result"] or ""
        # status == 'in_progress': a prior attempt crashed between claim and
        # commit. We cannot know whether the side effect fired. For irreversible
        # tools, prefer NOT repeating and surface the ambiguity.
        logger.warning(
            "Idempotent replay: %s for task %s has an unfinished prior attempt "
            "(fate unknown) — NOT repeating the action",
            tool_name, task_id,
        )
        return (
            f"[idempotency] '{tool_name}' was already attempted for this task and its "
            f"outcome is unconfirmed (the prior run did not record completion). The "
            f"action was NOT repeated to avoid a duplicate side effect. Verify whether "
            f"it took effect before retrying."
        )

    # ── 2/3. EXECUTE then COMMIT (or ROLLBACK on failure) ────────────────────
    try:
        result = await fn()
    except Exception:
        # Roll the claim back so a legitimate retry isn't permanently blocked.
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    "DELETE FROM tool_execution_log WHERE idempotency_key = $1 AND status = 'in_progress'",
                    key,
                )
        except Exception as e:
            logger.error(
                "Failed to roll back idempotency claim for %s (task %s): %s — "
                "a legitimate retry of this call will now be suppressed",
                tool_name, task_id, e,
            )
        raise

    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE tool_execution_log
                   SET status = 'done', result = $2, completed_at = NOW()
                 WHERE idempotency_key = $1
                """,
                key, result,
            )
    except Exception as e:
        # The side effect already happened; we just couldn't cache the result.
        # A subsequent replay will see 'in_progress' and conservatively skip —
        # which is the safe direction for an irreversible action.
        logger.warning(
            "Idempotency commit failed for %s (task %s): %s — result not cached",
            tool_name, task_id, e,
        )

    return result
