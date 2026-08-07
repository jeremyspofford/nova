"""Where the backup passphrase comes from (roadmap #31, decision b).

Jeremy, 2026-08-02: "Eventually it'll get it from a secrets manager. Could
be the one that is shipped, an mcp server, application such as 1password,
or a cloud secrets manager like aws secrets manager." So this is an
INTERFACE from day one — a named source that answers "what is the
passphrase right now" — and not a settings read with providers bolted on
later. Today there is one source; the seam is the point.

`local` keeps the passphrase in Nova's own encrypted secret store, which
has one honest consequence the operator must act on: the stored copy is
sealed with the master key at /state/secret.key, ON THIS MACHINE, INSIDE
THE BUNDLE. If the machine dies, Nova's copy of the passphrase dies inside
the thing it encrypts. So `maybe_nag` raises a standing card until he
confirms he has recorded it somewhere else — the card is the mechanism, not
a sentence in a prompt, and deciding it is the acknowledgment.

The nag follows `secret_store.maybe_nudge_rotation` exactly: the dedupe key
carries a fingerprint of the passphrase, so an unchanged passphrase can
never nag twice, and a ROTATED one raises a genuinely new card.
"""

import asyncio
import hashlib
import logging
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

log = logging.getLogger(__name__)

SECRET_NAME = "backup-passphrase"


class PassphraseUnavailable(Exception):
    """No passphrase means NO BUNDLE — the caller refuses rather than
    writing a complete, unencrypted copy of every credential on the stack."""


_create_lock = asyncio.Lock()


async def _local() -> str:
    """Nova's own secret store, creating the passphrase on first use.

    Get-or-create is serialised TWICE: an asyncio lock for this process,
    and a Postgres advisory lock for every other one — POST /api/v1/backups
    has no leader gate, and a second instance (a worktree backend against
    the same database is a real thing here) racing this create would leave
    one of them encrypting a bundle with a passphrase the upsert just
    overwrote: a bundle whose key exists nowhere. With the advisory lock,
    exactly one creator ever writes; everyone else re-reads.
    """
    from app import secret_store

    async def stored() -> Optional[str]:
        # None ONLY on SecretMissing — the row definitively absent. Any
        # other SecretError means the row EXISTS and cannot be read (the
        # master key changed or is unreadable), and put() upserts: reading
        # that as absence would generate a REPLACEMENT over the passphrase
        # that still seals every existing bundle, and backups would keep
        # reporting green with nothing restorable behind them.
        try:
            return await secret_store.reveal(SECRET_NAME)
        except secret_store.SecretMissing:
            return None
        except secret_store.SecretError as e:
            raise PassphraseUnavailable(
                f"the backup passphrase (secret '{SECRET_NAME}') exists but "
                f"cannot be read: {e} No bundle is written until this is "
                f"settled — restore the original master key, or delete the "
                f"secret in Settings -> Secrets to accept a NEW passphrase, "
                f"knowing every existing bundle then opens only with your "
                f"recorded copy of the old one.") from e

    phrase = await stored()
    if phrase is not None:
        return phrase
    async with _create_lock:
        from app import db
        async with db.acquire() as conn, conn.transaction():
            # held until the transaction ends, across ALL instances
            await conn.execute(
                "SELECT pg_advisory_xact_lock("
                "hashtext('nova:backup-passphrase:create'))")
            # secret_store.put uses its own pool connection, which is
            # fine: the advisory lock serialises CREATORS, and re-reading
            # inside the lock means a loser of the outer race becomes a
            # reader here rather than a second writer.
            phrase = await stored()
            if phrase is not None:
                return phrase
            from app import backup_crypto
            phrase = backup_crypto.generate_passphrase()
            await secret_store.put(
                SECRET_NAME, phrase,
                description="Encrypts every backup bundle. Record it OFF "
                            "this machine: the stored copy is inside the "
                            "very thing it encrypts, so on the day it is "
                            "needed, this row is gone.")
        log.warning("generated a backup passphrase (secret '%s') — the "
                    "operator must record it off-machine", SECRET_NAME)
        try:
            from app import capability_events as ce
            ce.record(ce.AUTOMATION, "backups", "passphrase_generated",
                      actor="the scheduler",
                      detail={"secret": SECRET_NAME, "source": "local"})
        except Exception:  # noqa: BLE001 — bookkeeping never blocks a backup
            log.exception("could not record the passphrase generation")
        return phrase


@dataclass(frozen=True)
class Source:
    name: str
    description: str
    resolve: Callable[[], Awaitable[str]]


# The seam. A future secrets-manager integration registers here — and the
# `backups.passphrase_source` setting's options are asserted against this
# dict by a test, so adding a source without offering it (or offering one
# that does not exist) is a red suite, not a silent divergence.
SOURCES: dict[str, Source] = {
    "local": Source(
        "local",
        "Nova keeps the passphrase in her encrypted secret store. Simple, "
        "but the stored copy lives inside what it encrypts — record it "
        "off-machine.",
        _local),
}


async def resolve() -> str:
    """The passphrase, from whichever source the operator has configured."""
    from app import settings_store
    name = str(settings_store.get("backups.passphrase_source") or "local")
    src = SOURCES.get(name)
    if src is None:
        raise PassphraseUnavailable(
            f"backups.passphrase_source is {name!r}, which this build does "
            f"not provide (available: {', '.join(sorted(SOURCES))})")
    try:
        return await src.resolve()
    except PassphraseUnavailable:
        raise
    except Exception as e:  # noqa: BLE001 — any source failure means refuse
        raise PassphraseUnavailable(
            f"the {name!r} passphrase source failed: {e}") from e


def fingerprint(passphrase: str) -> str:
    """Identifies WHICH passphrase without carrying it. Used in the nag's
    dedupe key and shown beside bundles, so 'which passphrase opens this
    file' is answerable years later without storing the answer."""
    return hashlib.sha256(passphrase.encode("utf-8")).hexdigest()[:12]


async def confirmation(passphrase: Optional[str] = None) -> dict:
    """Where the operator stands on recording the passphrase off-machine.

    Read from the recommendations row for the CURRENT passphrase's
    fingerprint — the card is the acknowledgment, so its status is the
    fact, and there is no second boolean to drift from it.
    """
    from app import db, secret_store
    if passphrase is None:
        try:
            passphrase = await secret_store.reveal(SECRET_NAME)
        except secret_store.SecretError:
            return {"state": "unset", "fingerprint": None}
    fp = fingerprint(passphrase)
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, status FROM recommendations WHERE dedupe_key = $1",
            f"backup-passphrase:{fp}")
    if row and row["status"] == "approved":
        state = "confirmed"
    elif row and row["status"] == "dismissed":
        state = "declined"
    else:
        state = "unconfirmed"
    return {"state": state, "fingerprint": fp,
            "card_id": str(row["id"]) if row else None}


_last_nag_check: Optional[float] = None


async def maybe_nag() -> int:
    """The standing nag (decision b). Leader-gated by the caller, self-limits
    to daily, and raises ONE card per passphrase — see maybe_nudge_rotation
    for why a key that exists in ANY status is skipped: create() would
    refresh an undecided card and re-ping his devices every day."""
    global _last_nag_check
    import time
    now = time.monotonic()
    if _last_nag_check and now - _last_nag_check < 24 * 3600:
        return 0
    _last_nag_check = now
    from app import db, secret_store
    try:
        phrase = await secret_store.reveal(SECRET_NAME)
    except secret_store.SecretError:
        return 0            # nothing exists yet, so there is nothing to record
    except Exception:  # noqa: BLE001 — a nag never costs the scheduler tick
        log.exception("could not read the backup passphrase for the nag")
        return 0
    fp = fingerprint(phrase)
    key = f"backup-passphrase:{fp}"
    try:
        async with db.acquire() as conn:
            if await conn.fetchrow(
                    "SELECT 1 FROM recommendations WHERE dedupe_key = $1", key):
                return 0
    except Exception:  # noqa: BLE001 — same rule: the tick survives the nag
        log.exception("could not check for an existing passphrase card")
        return 0
    from app import recommendations
    try:
        await recommendations.create(
            "note", "Record the backup passphrase somewhere off this machine",
            "Every backup bundle is now encrypted with a passphrase Nova "
            "keeps in her secret store — which is itself inside the bundle. "
            "If this machine dies, Nova's copy dies with the machine, and "
            "the bundles become unopenable exactly when they are needed.\n\n"
            "Reveal it in Settings → Backups (or Settings → Secrets, "
            f"'{SECRET_NAME}'), write it down somewhere that is not this "
            "computer — paper, a password manager on your phone — and then "
            "approve this card to confirm. Approving means: 'I hold a copy "
            "that does not depend on this machine.' Dismissing means Nova "
            "stops asking, and the risk stands.",
            source="backups", dedupe_key=key)
        log.info("raised the record-your-backup-passphrase card (%s)", fp)
        return 1
    except ValueError:
        return 0            # rate-limited; it will be raised on a later day
    except Exception:  # noqa: BLE001 — the tick survives the nag
        log.exception("could not raise the passphrase card")
        return 0
