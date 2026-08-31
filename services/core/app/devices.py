"""The device registry: key custody, pairing, grants, revoke.

A paired machine is a key core has bound to a name, plus the capabilities an
operator granted that name. Nothing in this module asks anyone to behave; every
property it holds is held by a statement:

  * signing_key — core's ed25519 key, created ONCE and read forever after.
    Every enrolled device pins it at pairing, so regenerating it would silently
    invalidate every command core signs from then on. The create is
    INSERT ... ON CONFLICT DO NOTHING followed by a re-read, so two requests
    racing the first call both end up with the key that is actually in the
    database rather than one of them holding a key nobody stored.
  * mint_pairing_code / enroll — the one unauthenticated write in core. The
    code is shown once and stored hashed; the burn is the consents idiom, ONE
    UPDATE whose WHERE clause (unused, unexpired, matching hash) is the whole
    check. Enrollment and its governance event share a transaction, so a name
    collision rolls the burn back and the operator retries with the same code.
  * set_grants — capabilities are checked against KNOWN_CAPABILITIES and
    fs_roots against absoluteness before anything is written. A typo'd grant is
    worse than a missing one: it reads as granted in Settings and refuses
    forever at the device, with nothing anywhere naming the typo.
  * revoke — stamps revoked_at. get_live stops answering (which is how T2's hub
    refuses the socket), rename and grants refuse, the name frees up, and the
    row stays so the audit trail survives the grant.

Refusals are raised as DeviceRefused carrying the reason and the status the API
should state. They are deliberately exceptions rather than None returns: enroll
alone has five distinct ways to be refused, and collapsing them into a single
falsy value would leave the operator reading "enrollment failed" while the
actual cause — a name already taken — sits in nobody's output.
"""
from __future__ import annotations

import hashlib
import re
import secrets
import uuid
from typing import Any

import asyncpg
from cryptography.hazmat.primitives.asymmetric import ed25519

from app import governance

# The capabilities slice 5 defines. A grant may only name one of these — the
# set is the contract between the operator's checkboxes (T4), core's tools (T2)
# and the daemon's executors (T3), and a name outside it can only ever be a
# typo, because the daemon has no code for it.
KNOWN_CAPABILITIES = frozenset(
    {
        "system.info",
        "system.notify",
        "fs.read",
        "fs.write",
        "fs.list",
        "shell.exec",
        "apps.launch",
        "apps.list",
    }
)

# What a freshly paired machine may do: report on itself, nothing more. The
# column default in migration 011 is the real enforcement; this constant exists
# so the API and the tests can name it.
DEFAULT_CAPABILITIES = ["system.info"]

PAIRING_CODE_TTL_SECONDS = 10 * 60
PAIRING_CODE_LENGTH = 8
# No 0/O, no 1/I/L: this is read off a screen and retyped into a terminal on
# another machine, and a lookalike turns a working code into a support call.
PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

_PUBKEY_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_NAME_LENGTH = 64

# Refusing rename/grants on a revoked device is 409, not 410: the record is
# still there and still listed (GET /devices shows it with revoked_at set), so
# "Gone" would be a lie about the resource. The request conflicts with the
# device's current state — which is exactly what 409 says.
_REVOKED_STATUS = 409


class DeviceRefused(Exception):
    """A stated refusal from the registry, carrying the words the operator
    sees and the status devices_api should answer with. Anything raised from
    this module that is NOT this is a bug, and the API says so differently."""

    def __init__(self, reason: str, *, status_code: int = 400) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status_code = status_code


# The burn, lifted from consents.validate_and_use: the inner SELECT claims one
# unused, unexpired, matching code with FOR UPDATE SKIP LOCKED (so two daemons
# racing the same code take different rows or none), and the UPDATE spends it.
# No row out means no valid code — nothing is spent and nothing is enrolled.
_BURN_CODE_SQL = """
UPDATE pairing_codes SET used_at = now()
WHERE id = (
    SELECT id FROM pairing_codes
    WHERE code_hash = $1
      AND used_at IS NULL
      AND expires_at > now()
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING id, created_by
"""

_INSERT_DEVICE_SQL = """
INSERT INTO devices (name, platform, hostname, pubkey, owner_person)
VALUES ($1, $2, $3, $4, $5)
RETURNING *
"""


def device_spec(row: asyncpg.Record | dict) -> dict:
    """The shape every device route returns and T4 renders.

    `connected` is included from day one so the web contract does not change
    under T4's feet when T2's hub lands. It is false here because it IS false:
    no hub exists yet, so nothing is connected, and `last_seen` (NULL until the
    first heartbeat) is the only liveness fact core has. T2 overwrites this
    field from live hub membership — never from a stored flag.
    """
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "platform": row["platform"],
        "hostname": row["hostname"],
        "capabilities": row["capabilities"],
        "fs_roots": row["fs_roots"],
        "enrolled_at": row["enrolled_at"].isoformat(),
        "last_seen": row["last_seen"].isoformat() if row["last_seen"] else None,
        "revoked_at": row["revoked_at"].isoformat() if row["revoked_at"] else None,
        "connected": False,
    }


# -- core's signing key ------------------------------------------------


async def signing_key(pool: asyncpg.Pool) -> ed25519.Ed25519PrivateKey:
    """Core's ed25519 private key, creating it on the very first call.

    The re-read after the insert is the point: ON CONFLICT DO NOTHING means the
    loser of a race writes nothing, and returning the key it generated anyway
    would hand out a key that is not core's. It reads the winner's instead."""
    stored = await pool.fetchval("SELECT private_key_hex FROM core_signing_key WHERE id = 1")
    if stored is None:
        generated = ed25519.Ed25519PrivateKey.generate()
        await pool.execute(
            "INSERT INTO core_signing_key (id, private_key_hex) VALUES (1, $1) "
            "ON CONFLICT (id) DO NOTHING",
            generated.private_bytes_raw().hex(),
        )
        stored = await pool.fetchval("SELECT private_key_hex FROM core_signing_key WHERE id = 1")
    if stored is None:
        # The insert reported no error and the row is still absent. Returning
        # the generated key here would sign commands with a key no device
        # pinned; failing loudly is the only honest option.
        raise RuntimeError("core signing key could not be stored or read — refusing to sign")
    return ed25519.Ed25519PrivateKey.from_private_bytes(bytes.fromhex(stored))


async def core_public_key_hex(pool: asyncpg.Pool) -> str:
    """What a device pins at pairing and verifies every envelope against."""
    key = await signing_key(pool)
    return key.public_key().public_bytes_raw().hex()


# -- pairing codes -----------------------------------------------------


def normalize_code(code: str) -> str:
    """A code is read off a screen and retyped. Case, spaces and the dashes a
    human adds are noise; what is left is what must match."""
    return re.sub(r"[\s-]", "", code).upper()


def hash_code(code: str) -> str:
    """Codes are stored only as this. The plaintext exists in one HTTP
    response and nowhere else."""
    return hashlib.sha256(normalize_code(code).encode("utf-8")).hexdigest()


async def mint_pairing_code(pool: asyncpg.Pool, *, created_by: uuid.UUID) -> dict:
    """Mint a single-use code and return it in the clear — ONCE."""
    code = "".join(secrets.choice(PAIRING_CODE_ALPHABET) for _ in range(PAIRING_CODE_LENGTH))
    expires_at = await pool.fetchval(
        "INSERT INTO pairing_codes (code_hash, created_by, expires_at) "
        "VALUES ($1, $2, now() + make_interval(secs => $3)) RETURNING expires_at",
        hash_code(code),
        created_by,
        PAIRING_CODE_TTL_SECONDS,
    )
    return {"code": code, "expires_at": expires_at.isoformat()}


# -- enrollment --------------------------------------------------------


def _clean_pubkey(pubkey: str) -> str:
    candidate = (pubkey or "").strip().lower()
    if not _PUBKEY_RE.match(candidate):
        raise DeviceRefused(
            "pubkey must be an ed25519 public key as 64 hex characters (32 raw bytes)"
        )
    return candidate


def _clean_name(name: str) -> str:
    candidate = (name or "").strip()
    if not candidate:
        raise DeviceRefused("a device needs a name — it is how you and Nova address the machine")
    if len(candidate) > _MAX_NAME_LENGTH:
        raise DeviceRefused(f"device name is longer than {_MAX_NAME_LENGTH} characters")
    return candidate


async def enroll(
    pool: asyncpg.Pool,
    *,
    code: str,
    pubkey: str,
    name: str,
    platform: str,
    hostname: str,
) -> dict:
    """Spend a pairing code to bind this key to this name, and hand back core's
    own key so each side has pinned the other.

    Shape validation happens BEFORE the burn, so a mistyped key does not cost
    the operator their code. Everything after the burn shares one transaction
    with the governance event, so a name collision (caught from the partial
    unique index — a pre-SELECT would be a race) rolls the burn back too.

    Core's own key is resolved FIRST, for the same reason: the daemon is only
    enrolled once it holds core_pubkey, so failing to produce it after the burn
    would leave a device row whose machine can never verify a command and whose
    code is already spent. Order it before, and that failure costs nothing.
    """
    clean_pubkey = _clean_pubkey(pubkey)
    clean_name = _clean_name(name)
    clean_platform = (platform or "").strip() or "unknown"
    clean_hostname = (hostname or "").strip() or "unknown"
    core_pubkey = await core_public_key_hex(pool)

    async with pool.acquire() as conn:
        try:
            async with conn.transaction():
                burned = await conn.fetchrow(_BURN_CODE_SQL, hash_code(code))
                if burned is None:
                    raise DeviceRefused(
                        "that pairing code is not usable — it is unknown, expired, "
                        "or already used. Mint a new one in Settings -> Devices.",
                        status_code=403,
                    )
                row = await conn.fetchrow(
                    _INSERT_DEVICE_SQL,
                    clean_name,
                    clean_platform,
                    clean_hostname,
                    clean_pubkey,
                    burned["created_by"],
                )
                await governance.record_event(
                    conn,
                    kind=governance.DEVICE_ENROLLED,
                    actor=str(burned["created_by"]) if burned["created_by"] else None,
                    subject_ref=row["id"],
                    meta={
                        "name": clean_name,
                        "platform": clean_platform,
                        "hostname": clean_hostname,
                        "pubkey": clean_pubkey,
                        "capabilities": row["capabilities"],
                    },
                )
        except asyncpg.UniqueViolationError as exc:
            raise DeviceRefused(
                f"a device named {clean_name!r} is already enrolled — "
                "pick another name, or revoke that one first",
                status_code=409,
            ) from exc

    return {"device_id": str(row["id"]), "name": row["name"], "core_pubkey": core_pubkey}


# -- lookups -----------------------------------------------------------


async def get(pool: asyncpg.Pool, device_id: uuid.UUID) -> asyncpg.Record | None:
    """Any device, revoked or not — the audit view."""
    return await pool.fetchrow("SELECT * FROM devices WHERE id = $1", device_id)


async def get_live(pool: asyncpg.Pool, device_id: uuid.UUID) -> asyncpg.Record | None:
    """A device that may still act. T2's hub authenticates against this, so a
    revoked device is refused by the ABSENCE of a row rather than by a flag
    someone downstream has to remember to read."""
    return await pool.fetchrow(
        "SELECT * FROM devices WHERE id = $1 AND revoked_at IS NULL", device_id
    )


async def get_live_by_name(pool: asyncpg.Pool, name: str) -> asyncpg.Record | None:
    """Resolve the name a person (or the model, via T2's tools) used. The
    partial unique index guarantees at most one live match."""
    return await pool.fetchrow(
        "SELECT * FROM devices WHERE name = $1 AND revoked_at IS NULL", name
    )


async def list_devices(pool: asyncpg.Pool) -> list[dict]:
    """Every device, revoked ones included and marked as such — a machine that
    was revoked is part of what the operator needs to see."""
    rows = await pool.fetch("SELECT * FROM devices ORDER BY enrolled_at DESC")
    return [device_spec(row) for row in rows]


async def _live_or_refuse(conn: asyncpg.Connection, device_id: uuid.UUID) -> asyncpg.Record:
    row = await conn.fetchrow("SELECT * FROM devices WHERE id = $1", device_id)
    if row is None:
        raise DeviceRefused(f"no device {device_id}", status_code=404)
    if row["revoked_at"] is not None:
        raise DeviceRefused(
            f"{row['name']} was revoked — a revoked device cannot be edited, "
            "only re-paired with a new code",
            status_code=_REVOKED_STATUS,
        )
    return row


# -- rename ------------------------------------------------------------


async def rename(pool: asyncpg.Pool, *, device_id: uuid.UUID, name: str) -> dict:
    """Rename a live device. Writes no governance event on purpose: a label
    change grants nothing, and a ledger that records every keystroke is one
    nobody reads when a grant actually moves."""
    clean = _clean_name(name)
    async with pool.acquire() as conn:
        try:
            async with conn.transaction():
                await _live_or_refuse(conn, device_id)
                row = await conn.fetchrow(
                    "UPDATE devices SET name = $2 WHERE id = $1 RETURNING *", device_id, clean
                )
        except asyncpg.UniqueViolationError as exc:
            raise DeviceRefused(
                f"a device named {clean!r} is already enrolled", status_code=409
            ) from exc
    return device_spec(row)


# -- grants ------------------------------------------------------------


def clean_capabilities(capabilities: Any) -> list[str]:
    """Sorted, deduplicated, and every name a known one.

    Sorted so a before/after diff in the ledger is about what changed rather
    than the order the checkboxes were clicked. The unknown-name refusal names
    the offender: a typo'd capability reads as granted in Settings and refuses
    forever at the device, and nothing else would ever say why."""
    if not isinstance(capabilities, list) or any(not isinstance(c, str) for c in capabilities):
        raise DeviceRefused("capabilities must be a list of capability names")
    unknown = sorted(set(capabilities) - KNOWN_CAPABILITIES)
    if unknown:
        raise DeviceRefused(
            f"unknown capability {', '.join(repr(u) for u in unknown)} — "
            f"known capabilities are {', '.join(sorted(KNOWN_CAPABILITIES))}"
        )
    return sorted(set(capabilities))


def clean_fs_roots(fs_roots: Any) -> list[str]:
    """Absolute paths only, no traversal.

    T2 authorises a filesystem call by prefix-checking the requested path
    against these. A relative root, or one containing `..`, makes that check
    decide nothing — so the refusal is here, where the root is written, not at
    the call site where it would be a silent pass."""
    if not isinstance(fs_roots, list) or any(not isinstance(p, str) for p in fs_roots):
        raise DeviceRefused("fs_roots must be a list of absolute paths")
    cleaned: list[str] = []
    for raw in fs_roots:
        path = raw.strip()
        if not path.startswith("/"):
            raise DeviceRefused(f"fs root {raw!r} is not an absolute path")
        if ".." in path.split("/"):
            raise DeviceRefused(f"fs root {raw!r} contains '..' — give the resolved path instead")
        cleaned.append(path.rstrip("/") or "/")
    return sorted(set(cleaned))


async def set_grants(
    pool: asyncpg.Pool,
    *,
    device_id: uuid.UUID,
    capabilities: Any,
    fs_roots: Any,
    actor: str,
) -> dict:
    """Replace this device's grants wholesale, recording what they were.

    Wholesale rather than add/remove because that is what the operator's editor
    submits, and a partial update would leave "what does this machine have now"
    answerable only by replaying a history. The before/after in the governance
    event is what makes the change readable afterwards."""
    clean_caps = clean_capabilities(capabilities)
    clean_roots = clean_fs_roots(fs_roots)
    async with pool.acquire() as conn, conn.transaction():
        before = await _live_or_refuse(conn, device_id)
        row = await conn.fetchrow(
            "UPDATE devices SET capabilities = $2::jsonb, fs_roots = $3::jsonb "
            "WHERE id = $1 RETURNING *",
            device_id,
            clean_caps,
            clean_roots,
        )
        await governance.record_event(
            conn,
            kind=governance.DEVICE_GRANTS_CHANGED,
            actor=actor,
            subject_ref=device_id,
            meta={
                "name": row["name"],
                "before": {
                    "capabilities": before["capabilities"],
                    "fs_roots": before["fs_roots"],
                },
                "after": {"capabilities": clean_caps, "fs_roots": clean_roots},
            },
        )
    return device_spec(row)


# -- revoke ------------------------------------------------------------


async def revoke(pool: asyncpg.Pool, *, device_id: uuid.UUID, actor: str) -> dict:
    """Stamp revoked_at. The UPDATE's own WHERE clause refuses a second revoke,
    so a repeat changes nothing AND writes no second event — saying "revoked"
    twice would put an act in the ledger that did not happen."""
    async with pool.acquire() as conn, conn.transaction():
        exists = await conn.fetchval("SELECT name FROM devices WHERE id = $1", device_id)
        if exists is None:
            raise DeviceRefused(f"no device {device_id}", status_code=404)
        row = await conn.fetchrow(
            "UPDATE devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL "
            "RETURNING *",
            device_id,
        )
        if row is None:
            raise DeviceRefused(
                f"{exists} was already revoked", status_code=_REVOKED_STATUS
            )
        await governance.record_event(
            conn,
            kind=governance.DEVICE_REVOKED,
            actor=actor,
            subject_ref=device_id,
            meta={"name": row["name"], "pubkey": row["pubkey"]},
        )
    return device_spec(row)
