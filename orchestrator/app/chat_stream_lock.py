"""Per-conversation chat stream lock — cancel-and-replace semantics.

One response streams per conversation at a time. Historically a second send
got a bare 409 ("Nova is currently responding") until a 120s TTL lapsed —
which read as "chat is broken" whenever a slow local model held a stream
for minutes, and the TTL gap let retries stack concurrent streams onto the
same starved backend.

Now the lock is a **token**: a new send atomically takes the lock over
(last-write-wins, like every chat product's stop-and-resend) and the
superseded stream notices its token is gone at its next ownership check —
within ~LOCK_CHECK_INTERVAL_S — emits a final `superseded` event, and
stops. A live stream refreshes the TTL on each check, so the lock tracks
actual streaming, while the TTL stays as the backstop for a process that
died without releasing.

All mutations are atomic (SET ... GET / Lua compare-ops) so two
simultaneous sends resolve to exactly one owner.
"""
from __future__ import annotations

import logging
import uuid

from app.store import get_redis

log = logging.getLogger(__name__)

LOCK_TTL_S = 120           # backstop only — a live stream keeps refreshing
LOCK_CHECK_INTERVAL_S = 5.0  # how often a stream verifies ownership + refreshes

# if I still own the lock: refresh TTL and report 1; else report 0
_REFRESH_LUA = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  redis.call('expire', KEYS[1], ARGV[2])
  return 1
end
return 0
"""

# delete only my own lock — never a successor's
_RELEASE_LUA = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""


def lock_key(conversation_or_session_id: str) -> str:
    return f"nova:chat:streaming:{conversation_or_session_id}"


async def acquire(key: str) -> tuple[str, bool]:
    """Take the stream lock for a conversation, superseding any holder.

    Returns (token, superseded) — superseded is True when an in-flight
    stream owned the lock; it will stop at its next ownership check.
    """
    token = uuid.uuid4().hex
    prev = await get_redis().set(key, token, ex=LOCK_TTL_S, get=True)
    if prev:
        log.info("Chat stream lock %s taken over (superseding in-flight stream)", key)
    return token, bool(prev)


async def still_owner_and_refresh(key: str, token: str) -> bool:
    """True while this stream owns the lock (refreshes the TTL as a side
    effect). False means a newer send took over — stop streaming.

    Fails open: if Redis is unreachable the stream keeps going; the lock
    self-expires and a concurrent send simply won't be blocked.
    """
    try:
        return bool(await get_redis().eval(_REFRESH_LUA, 1, key, token, str(LOCK_TTL_S)))
    except Exception as e:
        log.debug("Stream lock refresh failed (%s) — continuing", e)
        return True


async def release(key: str, token: str) -> None:
    """Release the lock iff this stream still owns it."""
    try:
        await get_redis().eval(_RELEASE_LUA, 1, key, token)
    except Exception:
        pass  # TTL backstop cleans up
