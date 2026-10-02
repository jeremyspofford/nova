"""The device registry: key custody, pairing, revoke.

A paired machine is a key core has bound to a name — identity, and nothing
more. v4 makes no authorization decisions (owner ruling 2026-09-03): there is
no per-device capability list, no filesystem root and no grant here, and a
paired device runs whatever core signs. Nothing in this module asks anyone to
behave; every property it holds is held by a statement:

  * signing_key — core's ed25519 key, created ONCE and read forever after.
    Every enrolled device pins it at pairing, so regenerating it would silently
    invalidate every command core signs from then on. The create is
    INSERT ... ON CONFLICT DO NOTHING followed by a re-read, so two requests
    racing the first call both end up with the key that is actually in the
    database rather than one of them holding a key nobody stored.
  * mint_pairing_code / enroll — the one unauthenticated write in core. The
    code is shown once and stored hashed; the burn is ONE UPDATE whose WHERE
    clause (unused, unexpired, matching hash) is the whole check. It proves
    WHO is pairing — the person who minted the code — never what the machine
    may do. Enrollment and its governance event share a transaction, so a name
    collision rolls the burn back and the operator retries with the same code.
  * re-pair (S42b decision 4) — a code minted for ONE live device rebinds that
    row to the enrolling key instead of inserting one: name, owner and history
    stay, and the audit epoch moves on in the same UPDATE that swaps the key.
    The row is fixed when the code is minted; nothing the enrolling caller
    sends can point it at another.
  * revoke — stamps revoked_at. get_live stops answering (which is how the
    hub refuses the socket), rename refuses, the name frees up, and the row
    stays so the audit trail survives the device.

Refusals are raised as DeviceRefused carrying the reason and the status the API
should state. They are deliberately exceptions rather than None returns: enroll
alone has several distinct ways to be refused, and collapsing them into a single
falsy value would leave the operator reading "enrollment failed" while the
actual cause — a name already taken — sits in nobody's output.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import uuid

import asyncpg
from cryptography.hazmat.primitives.asymmetric import ed25519

from app import device_facts, governance

PAIRING_CODE_TTL_SECONDS = 10 * 60
PAIRING_CODE_LENGTH = 8
# No 0/O, no 1/I/L: this is read off a screen and retyped into a terminal on
# another machine, and a lookalike turns a working code into a support call.
PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

_PUBKEY_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_NAME_LENGTH = 64

# D8: `hub` is the bundled engine's name, and machine_status groups engines
# and agents by name — a device called hub would read as the engine.
RESERVED_NAMES = frozenset({"hub"})

# Refusing a rename on a revoked device is 409, not 410: the record is still
# there and still listed (GET /devices shows it with revoked_at set), so "Gone"
# would be a lie about the resource. The request conflicts with the device's
# current state — which is exactly what 409 says.
_REVOKED_STATUS = 409


class DeviceRefused(Exception):
    """A stated refusal from the registry, carrying the words the operator
    sees and the status devices_api should answer with. Anything raised from
    this module that is NOT this is a bug, and the API says so differently."""

    def __init__(self, reason: str, *, status_code: int = 400) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status_code = status_code


# The burn: the inner SELECT claims one unused, unexpired, matching code with
# FOR UPDATE SKIP LOCKED (so two daemons racing the same code take different
# rows or none), and the UPDATE spends it. No row out means no valid code —
# nothing is spent and nothing is enrolled. This is identity (which minted code
# this machine holds), not permission: it decides who paired, never what runs.
# It returns the code's binding (S42b): the one device a re-pair code rebinds,
# or the name a new machine takes — both fixed when the code was minted.
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
RETURNING id, created_by, device_id, name
"""

_INSERT_DEVICE_SQL = """
INSERT INTO devices (name, platform, hostname, pubkey, owner_person)
VALUES ($1, $2, $3, $4, $5)
RETURNING *
"""

# A re-pair (decision 4): the live row takes the new key, platform and host;
# its reported facts and door clear (they described the old agent); the audit
# epoch moves on so the new key's chain starts at seq 0. The CTE reads the old
# key before the update, for the ledger. Key and epoch move in this ONE
# statement, so no reader ever sees the new key on the old epoch or the
# reverse — and a socket that authenticated against one row read holds a
# matching pair (devices_ws). A row revoked since the code was minted matches
# nothing, and enroll refuses.
_REBIND_SQL = """
WITH old AS (SELECT pubkey FROM devices WHERE id = $1 AND revoked_at IS NULL FOR UPDATE)
UPDATE devices d
   SET pubkey = $2, platform = $3, hostname = $4, facts = NULL, facts_at = NULL,
       last_seen = NULL, last_transport = NULL, audit_epoch = d.audit_epoch + 1
  FROM old
 WHERE d.id = $1 AND d.revoked_at IS NULL
RETURNING d.*, old.pubkey AS old_pubkey
"""


def device_spec(
    row: asyncpg.Record | dict, *, hub_version: str | None = None, last_update: dict | None = None
) -> dict:
    """The shape every device route returns and the web tile renders.

    `connected` is included from day one so the web contract does not change
    under T4's feet when T2's hub lands. It is false here because it IS false:
    no hub exists yet, so nothing is connected, and `last_seen` (NULL until the
    first heartbeat) is the only liveness fact core has. T2 overwrites this
    field from live hub membership — never from a stored flag.

    `hub_version` and `last_update` are core's own records, not stored on the
    row itself (S42b) — a caller that has not read them passes nothing, and
    `build_state` and `last_update` read as "unknown" / None rather than lie.
    """
    facts = row.get("facts")
    facts_at = row.get("facts_at")
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "platform": row["platform"],
        "hostname": row["hostname"],
        "enrolled_at": row["enrolled_at"].isoformat(),
        "last_seen": row["last_seen"].isoformat() if row["last_seen"] else None,
        "revoked_at": row["revoked_at"].isoformat() if row["revoked_at"] else None,
        "connected": False,
        # S42a: what the agent OBSERVED about its machine (device_facts), for
        # the tile. Facts, never grants — roles are derived on read and are
        # not part of this shape.
        "os": device_facts.os_label(facts),
        "wsl": device_facts.in_wsl(facts),
        "agent_version": device_facts.agent_version(facts),
        "facts_at": facts_at.isoformat() if facts_at else None,
        # S42b: the door (P15), how it starts (P4), and its build against the
        # hub's (decision 2).
        "hub": row.get("last_transport") == "host",
        "door": row.get("last_transport"),
        "mode": ((facts or {}).get("agent") or {}).get("mode") if isinstance(facts, dict) else None,
        "starts": device_facts.starts(facts),
        "build_state": device_facts.build_state(device_facts.agent_version(facts), hub_version)[
            "state"
        ],
        "hub_version": hub_version,
        "last_update": last_update,
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


async def mint_pairing_code(
    pool: asyncpg.Pool,
    *,
    created_by: uuid.UUID | None,
    device_id: uuid.UUID | None = None,
    name: str | None = None,
) -> dict:
    """Mint a single-use code and return it in the clear — ONCE.

    `device_id` makes it a RE-PAIR code (S42b decision 4): whoever enrolls
    with it within ten minutes becomes that live machine — its row, name and
    history — under a new key. `name` is the name a NEW machine takes (a card
    that names it); a re-pair keeps the row's own. `created_by` is None only
    for ./install's hub agent before anyone has registered (devices_cli)."""
    clean_name = None
    if device_id is not None:
        row = await pool.fetchrow("SELECT name, revoked_at FROM devices WHERE id = $1", device_id)
        if row is None:
            raise DeviceRefused(f"no device {device_id}", status_code=404)
        if row["revoked_at"] is not None:
            raise DeviceRefused(
                f"{row['name']} was revoked — a revoked machine cannot be re-paired; pair it "
                "again with a new code",
                status_code=_REVOKED_STATUS,
            )
        if _reserved(row["name"]):
            # A row named before D8 reserved the name: a re-pair keeps the
            # row's name, so it would keep reading as the bundled engine.
            raise DeviceRefused(
                f"{row['name']!r} cannot be re-paired under that name — it is the bundled "
                "engine's name (hub decision D8); rename the machine first, then re-pair it",
                status_code=409,
            )
    elif name is not None:
        clean_name = _clean_name(name)
    code = "".join(secrets.choice(PAIRING_CODE_ALPHABET) for _ in range(PAIRING_CODE_LENGTH))
    expires_at = await pool.fetchval(
        "INSERT INTO pairing_codes (code_hash, created_by, expires_at, device_id, name) "
        "VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5) RETURNING expires_at",
        hash_code(code),
        created_by,
        PAIRING_CODE_TTL_SECONDS,
        device_id,
        clean_name,
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


def _reserved(name: str) -> bool:
    """D8, defined once: a name that reads as the bundled engine's, however
    it is cased or padded."""
    return name.strip().casefold() in RESERVED_NAMES


def _clean_name(name: str) -> str:
    candidate = (name or "").strip()
    if not candidate:
        raise DeviceRefused("a device needs a name — it is how you and Nova address the machine")
    if len(candidate) > _MAX_NAME_LENGTH:
        raise DeviceRefused(f"device name is longer than {_MAX_NAME_LENGTH} characters")
    if _reserved(candidate):
        raise DeviceRefused(
            f"a machine cannot be named {candidate!r} — that is the bundled engine's name "
            "(hub decision D8); name it after the machine itself"
        )
    return candidate


def _clean_platform(platform: str) -> str:
    """The OS the agent says it runs — Go's runtime.GOOS — or a refusal.
    Before S42a any text was stored (every agent sent "linux"); migration 036's
    CHECK now holds devices.platform to the known values, and this is where a
    new row is held to them. Checked BEFORE the code is spent, like the key.

    The refusal echoes what was sent, clipped to 64 characters: enroll is
    core's one unauthenticated route (T2), so this string is attacker
    controlled and must not be echoed back unbounded."""
    candidate = (platform or "").strip().lower()
    if candidate not in device_facts.PLATFORMS:
        raise DeviceRefused(
            f"platform must be one of {', '.join(device_facts.PLATFORMS)} (the agent's own "
            f"runtime.GOOS), got {(platform or '')[:64]!r}"
        )
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
    """Spend a pairing code to bind this key to a machine, and hand back core's
    own key so each side has pinned the other.

    What the code was minted for decides which machine (S42b). A re-pair code
    rebinds its one live row — name, owner and history kept, the audit epoch
    moved on — and says so (`repaired`). Any other code inserts a new row,
    named by the code when it carries a name and by the agent otherwise
    (P14). The agent's name is checked only when it IS the name the row
    takes: the card's command carries no --name, so the agent sends its
    hostname, and that must never refuse a code that decides the name itself.

    Shape validation of the key and platform happens BEFORE the burn, so a
    mistyped key does not cost the operator their code. Everything after the
    burn shares one transaction with the governance event, so every refusal
    there — the agent's name, a name collision (caught from the partial unique
    index — a pre-SELECT would be a race), a machine revoked since its re-pair
    code was minted — rolls the burn back too.

    Core's own key is resolved FIRST, for the same reason: the daemon is only
    enrolled once it holds core_pubkey, so failing to produce it after the burn
    would leave a device row whose machine can never verify a command and whose
    code is already spent. Order it before, and that failure costs nothing.
    """
    clean_pubkey = _clean_pubkey(pubkey)
    clean_platform = _clean_platform(platform)
    clean_hostname = (hostname or "").strip() or "unknown"
    core_pubkey = await core_public_key_hex(pool)

    async with pool.acquire() as conn, conn.transaction():
        burned = await conn.fetchrow(_BURN_CODE_SQL, hash_code(code))
        if burned is None:
            raise DeviceRefused(
                "that pairing code is not usable — it is unknown, expired, "
                "or already used. Mint a new one in Settings -> Devices.",
                status_code=403,
            )
        actor = str(burned["created_by"]) if burned["created_by"] else None
        repaired = burned["device_id"] is not None
        if repaired:
            row = await conn.fetchrow(
                _REBIND_SQL, burned["device_id"], clean_pubkey, clean_platform, clean_hostname
            )
            if row is None:
                raise DeviceRefused(
                    "that machine was revoked after this code was made, so it cannot be "
                    "re-paired — pair it again with a new code from Settings -> Devices",
                    status_code=_REVOKED_STATUS,
                )
            # An update still `sent` went to the agent the OLD key belongs to:
            # nothing can confirm it now, and the new key's first connection
            # must never decide it (agent_updates.end_open_attempt) — ended in
            # this same commit. Imported here: agent_updates imports this
            # module.
            from app import agent_updates

            await agent_updates.end_open_attempt(
                conn, row["id"], reason=agent_updates.REPAIRED_REASON
            )
            await governance.record_event(
                conn,
                kind=governance.DEVICE_REPAIRED,
                actor=actor,
                subject_ref=row["id"],
                meta={
                    "name": row["name"],
                    "old_pubkey": row["old_pubkey"],
                    "new_pubkey": clean_pubkey,
                    "epoch": row["audit_epoch"],
                    "platform": clean_platform,
                    "hostname": clean_hostname,
                },
            )
        else:
            named_by_code = burned["name"] is not None
            name_used = burned["name"] if named_by_code else _clean_name(name)
            try:
                row = await conn.fetchrow(
                    _INSERT_DEVICE_SQL,
                    name_used,
                    clean_platform,
                    clean_hostname,
                    clean_pubkey,
                    burned["created_by"],
                )
            except asyncpg.UniqueViolationError as exc:
                # The agent cannot pick another name when the code chose it,
                # so the way out names what can actually be done.
                remedy = (
                    f"this code names the machine {name_used!r}, so rename or revoke that one "
                    "first, or mint a code that names it differently"
                    if named_by_code
                    else "pick another name, or revoke that one first"
                )
                raise DeviceRefused(
                    f"a device named {name_used!r} is already enrolled — {remedy}",
                    status_code=409,
                ) from exc
            await governance.record_event(
                conn,
                kind=governance.DEVICE_ENROLLED,
                actor=actor,
                subject_ref=row["id"],
                meta={
                    "name": name_used,
                    "platform": clean_platform,
                    "hostname": clean_hostname,
                    "pubkey": clean_pubkey,
                },
            )

    return {
        "device_id": str(row["id"]),
        "name": row["name"],
        "core_pubkey": core_pubkey,
        "repaired": repaired,
    }


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
    return await pool.fetchrow("SELECT * FROM devices WHERE name = $1 AND revoked_at IS NULL", name)


# Task 16 fix round 1, I3: the ONE place this lateral join is written —
# it used to be duplicated verbatim here and in machines.py, nothing ran
# it against a real agent_updates row, and a silent drift between the two
# copies would have read "never updated" rather than failing anything.
_DEVICES_WITH_LAST_UPDATE_SELECT = """
SELECT d.*, u.version AS u_version, u.outcome AS u_outcome, u.reason AS u_reason,
       COALESCE(u.outcome_at, u.sent_at) AS u_at
  FROM devices d
  LEFT JOIN LATERAL (
      SELECT * FROM agent_updates a WHERE a.device_id = d.id ORDER BY a.sent_at DESC LIMIT 1
  ) u ON true
"""


async def rows_with_last_update(pool: asyncpg.Pool, *, live_only: bool) -> list[asyncpg.Record]:
    """Every device row, each with its latest agent_updates row's columns
    (u_version/u_outcome/u_reason/u_at) joined in by one lateral join per
    query, never one per device. `live_only` is machines.GatewayPlant.agents'
    need (live devices only, by name); `list_devices` below wants every
    device, revoked included, by enrollment. Read with `_last_update`."""
    if live_only:
        sql = _DEVICES_WITH_LAST_UPDATE_SELECT + " WHERE d.revoked_at IS NULL ORDER BY d.name"
    else:
        sql = _DEVICES_WITH_LAST_UPDATE_SELECT + " ORDER BY d.enrolled_at DESC"
    return await pool.fetch(sql)


def _last_update(row: asyncpg.Record | dict) -> dict | None:
    """The device's latest update attempt (S42b decision 2), from
    `rows_with_last_update`'s lateral join — None when the device has
    never had one. `row["u_version"]`, not `.get` (Task 16 fix round 1,
    I3): a row fetched WITHOUT that join is missing the column entirely,
    and this fails loudly (KeyError) rather than silently reading "never
    updated"."""
    if row["u_version"] is None:
        return None
    return {
        "version": row["u_version"],
        "outcome": row["u_outcome"],
        "at": row["u_at"].isoformat() if row["u_at"] else None,
        "reason": row["u_reason"],
    }


async def list_devices(pool: asyncpg.Pool, *, hub_version: str | None = None) -> list[dict]:
    """Every device, revoked ones included and marked as such — a machine that
    was revoked is part of what the operator needs to see. Each device's
    latest update attempt rides along from one lateral join rather than a
    query per device."""
    rows = await rows_with_last_update(pool, live_only=False)
    return [
        device_spec(row, hub_version=hub_version, last_update=_last_update(row)) for row in rows
    ]


async def _live_or_refuse(conn: asyncpg.Connection, device_id: uuid.UUID) -> asyncpg.Record:
    row = await conn.fetchrow("SELECT * FROM devices WHERE id = $1", device_id)
    if row is None:
        raise DeviceRefused(f"no device {device_id}", status_code=404)
    if row["revoked_at"] is not None:
        raise DeviceRefused(
            f"{row['name']} was revoked — a revoked device cannot be edited, "
            "only paired again with a new code",
            status_code=_REVOKED_STATUS,
        )
    return row


# -- rename ------------------------------------------------------------


async def rename(pool: asyncpg.Pool, *, device_id: uuid.UUID, name: str) -> dict:
    """Rename a live device. Writes no governance event on purpose: a label
    change binds no key and revokes nothing, and a ledger that records every
    keystroke is one nobody reads when a device actually pairs or goes."""
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
            raise DeviceRefused(f"{exists} was already revoked", status_code=_REVOKED_STATUS)
        # A revoked agent can never connect to confirm an update still `sent`
        # to it, so it is decided here, in this commit — and P9's one slot is
        # free for every other machine at once (agent_updates.end_open_attempt).
        # Imported here: agent_updates imports this module.
        from app import agent_updates

        await agent_updates.end_open_attempt(conn, device_id, reason=agent_updates.REVOKED_REASON)
        await governance.record_event(
            conn,
            kind=governance.DEVICE_REVOKED,
            actor=actor,
            subject_ref=device_id,
            meta={"name": row["name"], "pubkey": row["pubkey"]},
        )
    return device_spec(row)
