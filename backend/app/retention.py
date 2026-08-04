"""Prune the bookkeeping tables that nothing else prunes.

Traces, resource samples and automation runs already retire themselves. These
four did not, and they only grow:

    messages (role='tool')  one row per activity event, so several per turn.
                            Measured on the live DB 2026-07-24: 1,301 tool
                            rows against 384 user + 346 assistant — ~64% of
                            the table, and the largest table in the database.
    consents                decided and expired cards stay forever.
    monitor_alerts          migration 047 says "prune freely"; nothing did.
    recommendations         decided ones accumulate.

Only FINISHED rows go, and conversation turns are never touched — the user
and assistant messages ARE the conversation. Tool rows are an audit trail of
work already recorded in the turn ledger, and since load_history now takes
its row cap over user/assistant only, dropping old ones costs the model
nothing at all.

Same shape as trace.maybe_prune: piggyback the scheduler tick, self-limit to
once a day, leader-gated by the caller, and never raise — a failed prune
retries tomorrow and nothing depends on it having run.
"""

import logging
import time

from app import db

log = logging.getLogger(__name__)

_last_prune = 0.0
_PRUNE_EVERY_S = 24 * 3600

# (label, SQL) — each takes $1 = the cutoff interval in days, as text.
_SWEEPS = [
    ("tool audit rows",
     "DELETE FROM messages WHERE role = 'tool' "
     "  AND created_at < now() - ($1 || ' days')::interval"),
    ("decided consents",
     "DELETE FROM consents WHERE status <> 'pending' "
     "  AND created_at < now() - ($1 || ' days')::interval"),
    ("cleared alerts",
     "DELETE FROM monitor_alerts WHERE cleared_at IS NOT NULL "
     "  AND cleared_at < now() - ($1 || ' days')::interval"),
    # 'seen' and 'later' are UNDECIDED — recommendations._ACTIONABLE says so,
    # and 'later' is the operator asking the banner to stop showing a card he
    # still means to answer. The old predicate here was `status <> 'new'`,
    # which made clicking Later schedule the card for deletion.
    ("decided recommendations",
     "DELETE FROM recommendations WHERE status NOT IN ('new', 'seen', 'later') "
     "  AND created_at < now() - ($1 || ' days')::interval"),
]


async def maybe_prune():
    global _last_prune
    now = time.monotonic()
    if _last_prune and now - _last_prune < _PRUNE_EVERY_S:
        return
    _last_prune = now
    from app import settings_store   # late: avoids an import cycle at boot
    days = str(int(settings_store.get("retention.audit_days") or 30))
    for label, sql in _SWEEPS:
        try:
            async with db.acquire() as conn:
                result = await conn.execute(sql, days)
            if not result.endswith(" 0"):
                log.info("Audit retention: %s — %s (older than %s days)",
                         label, result, days)
        except Exception:
            # one bad sweep must not stop the others
            log.exception("audit retention sweep failed: %s", label)
