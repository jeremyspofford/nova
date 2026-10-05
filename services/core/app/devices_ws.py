"""The device socket: a WebSocket a paired machine holds open, and the hub that
sends it signed commands and awaits real results.

Nothing here decides anything: it authenticates the socket and carries signed
commands. This module is the transport under the device tools: it proves WHO
is on the other end, keeps the live registry the tools send through, and turns
"accepted by transport" into "the device actually answered" — because only a
`result` frame the device itself sent ever resolves a command. A timeout, a
dropped socket, a revoked device: each is a stated DeviceRefused, never a guess
that it worked.

Four mechanical properties live here, and each is code, not a request:

  * The socket authenticates by CHALLENGE, not by a bearer. Starlette's http
    middleware never sees a WebSocket connect, so the session/bearer layers are
    not in the path at all — the auth IS the nonce the device signs with its
    pinned key, verified against the row's pubkey. A revoked device has no live
    row (get_live -> None), so its reconnect fails at the challenge.
  * A command reaches a device only if the device is in the hub. No live socket
    is a STATED failure ("its tile is stale"), never an optimistic send into the
    void — the never-report-success rail, extended to a second machine.
  * A result resolves the pending future by envelope_id and by nothing else, so
    a stray or forged frame for an id core is not waiting on resolves nothing.
  * The device's own audit chain is verified into device_audit link by link; a
    break is a loud DEVICE_AUDIT_BREAK governance event naming the seq and never
    a silent reindex — a chain that quietly heals proves nothing afterward.

A re-pair (S42b decision 4) gives a live row a new key and moves its audit
epoch on in the same UPDATE. A socket is bound to the (key, epoch) pair of the
ONE row read it authenticated against: its audit lands in that epoch's chain
and no other, its heartbeats and facts write the row only while the row is
still at that epoch, and serve re-reads the row after the socket joins the hub
so a re-pair (or revoke) that landed mid-handshake drops it rather than
leaving the old key connected.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
import time
import uuid
from datetime import UTC, datetime

import asyncpg
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric import ed25519
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app import db, device_facts, devices, envelopes, governance, network

logger = logging.getLogger("core")

router = APIRouter()

# The challenge nonce is 32 raw bytes, sent as hex. The device signs the RAW
# bytes (not an envelope) with its pinned key — the simplest thing that proves
# the key, and it is the whole auth.
NONCE_BYTES = 32

# The frame contract (mirrored in apps/novad/internal/wire/envelope.go). Every
# frame is one JSON object with a "type"; unknown keys are ignored on both
# sides, so a field may be ADDED without a version bump.
#
#   core -> device
#     challenge  {nonce: hex(32 bytes), core_pubkey: hex}
#     ready      {last_seq: int | null}           the last seq core holds in the
#                row's CURRENT audit epoch — a re-paired key's chain starts at
#                null even though the old key's chain is still stored
#     auth_error {reason, proof?, sig?}           then close 4401. reason is
#                exactly "revoked" for a revoked device, and ONLY then paired
#                with a proof core signs ({kind, v, device_id, nonce}, plus
#                sig) — the agent verifies it against the key pinned at
#                enrollment before wiping (wire.VerifyRevokedProof, S42a).
#                An unknown device gets a different reason and no proof,
#                ever: core must never sign one for an id it merely does not
#                know, or a restored database that forgot a device would make
#                it wipe itself.
#     command    {envelope, sig}                  (envelopes.build / sign)
#   device -> core
#     auth       {device_id, sig: hex(sign(raw nonce)), facts?}
#                (an older novad also sends home_dir; it is one of the unknown
#                keys ignored above — nothing reads it)
#                facts: device_facts.validate_auth's shape, recorded only
#                after sig verifies, never a reason to refuse (S42a)
#     heartbeat  {ts}                            -> devices.last_seen = now()
#     result     {envelope_id, ok, output, exit_code, error}
#     audit      {entries: [_ENTRY_KEYS...]}     (ingest_audit)
#     facts      {net?, unreadable?, folders?, service?, elevation?, wsl_distros?,
#                probed_at?}                      (S42a/S42b; merged into facts,
#                a probe as one unit — device_facts.merge_frame)

# WebSocket close codes in the application-private 4000-4999 range. 4401 mirrors
# HTTP 401 (the challenge did not authenticate); 4403 mirrors 403 (the row is
# gone from under a live socket — a revoke — or no longer holds the key the
# socket authenticated with — a re-pair).
AUTH_FAILED_CLOSE = 4401
REVOKED_CLOSE = 4403

# P27: a frame that is not readable JSON — or not an object — becomes this one
# marker, which _handle_frame logs and drops. A frame never ends a session.
UNREADABLE_FRAME = "unreadable"

# The auth_error reasons. REVOKED_REASON is the ONE the agent treats as final
# (wipe, exit 78 — apps/novad client.ErrRevoked), so it is sent for a revoked
# row and nothing else: a restored database that forgot a device must never
# make that device wipe itself.
REVOKED_REASON = "revoked"
UNKNOWN_DEVICE_REASON = "no such device — it was never paired here, or its record is gone"

# The audit entry a daemon sends has exactly these keys; the chain hash is
# computed over all of them EXCEPT `hash`, canonicalised the SAME way the
# envelope is, so the Go daemon and this ingester agree byte for byte. Listed
# here for T3's reference — the hash itself is taken over "the entry minus its
# own hash key", whatever keys that is, so the recipe survives a field being
# added on both sides.
_ENTRY_KEYS = (
    "seq",
    "prev_hash",
    "hash",
    "ts",
    "envelope_id",
    "capability",
    "summary",
    "ok",
    "exit_code",
)


class ConnectionClosed(Exception):
    """The peer went away mid-read. The real adapter raises this on a Starlette
    WebSocketDisconnect and the fake conn raises it on feed_close, so serve()
    unwinds the same way whether the socket is real or in-process."""


class NotSent(devices.DeviceRefused):
    """Hub.command refused BEFORE anything reached the device's socket: no
    live row, no socket at the row's epoch, a row that moved past the epoch
    the caller prepared the command for, or a write that failed. Nothing was
    put on the wire, so nothing can have run there.

    Every other DeviceRefused from Hub.command — a timeout, a socket that
    dropped before its answer, a disconnect — comes AFTER the send, when the
    device may have acted. The difference is load-bearing for an update
    (S42b): a command that was sent and not answered may have staged a new
    build, so only the agent's reconnect can say what happened; one that was
    never sent can be said to have done nothing. Callers that need neither
    distinction catch DeviceRefused, as before."""


def _as_uuid(device_id: str | uuid.UUID) -> uuid.UUID:
    return device_id if isinstance(device_id, uuid.UUID) else uuid.UUID(str(device_id))


def verify_nonce(pubkey_hex: str, nonce: bytes, sig_hex: str) -> bool:
    """True only when `sig_hex` is this key's signature over the raw nonce bytes.

    Like envelopes.verify, every failure mode is False and none is an exception:
    a decision that can explode is one a caller wraps in a bare except and turns
    into a yes. This is the WS-challenge twin of envelopes.verify — that one
    verifies canonical bytes of a payload, this one verifies raw bytes."""
    try:
        key = ed25519.Ed25519PublicKey.from_public_bytes(bytes.fromhex(pubkey_hex))
        key.verify(bytes.fromhex(sig_hex), nonce)
    except (InvalidSignature, ValueError, TypeError):
        return False
    return True


def chain_hash(prev_hash: str, entry_without_hash: dict) -> str:
    """The device-audit chain link, defined once so the Go daemon computes the
    identical value.

        hash = sha256( prev_hash + canonical(entry_without_hash) ).hexdigest()

    where `canonical` is envelopes.canonical (sorted keys, tight separators,
    non-ASCII as \\uXXXX, HTML chars left literal) and `entry_without_hash` is
    the entry with its own `hash` key removed. prev_hash is "" for seq 0.
    Because prev_hash is ASCII hex (or ""), string-concatenating it before the
    canonical UTF-8 bytes and re-encoding is byte-identical to prepending its
    raw bytes — the Go side may implement either."""
    canonical_str = envelopes.canonical(entry_without_hash).decode("utf-8")
    return hashlib.sha256((prev_hash + canonical_str).encode("utf-8")).hexdigest()


# -- the hub -----------------------------------------------------------------


class Hub:
    """The live device registry: device_id -> its socket, plus the futures a
    command is awaiting. A process-global singleton (see `hub` below), like the
    db pool — there is exactly one set of live sockets per core process."""

    def __init__(self) -> None:
        self._conns: dict[str, object] = {}
        self._pending: dict[str, dict[str, asyncio.Future]] = {}
        # S42b: the audit epoch each registered socket authenticated at.
        # command() sends only over a socket at the row's CURRENT epoch, so a
        # socket a re-pair left behind never carries a command — not even in
        # the moment before serve's re-read drops it. serve always passes the
        # epoch; a bare socket a test registers without one is not checked.
        # register() itself refuses to move this number backward (T15
        # review): epochs only grow, so it is also what stops an old-key
        # socket from displacing a newer one that already joined.
        self._epochs: dict[str, int] = {}
        # S42b P10: when core last sent each device a command (monotonic
        # seconds) — what idle() reads, so the update job restarts an agent
        # only when that cuts nothing off.
        self._last_command: dict[str, float] = {}

    # registry ---------------------------------------------------------------
    def register(
        self, device_id: str | uuid.UUID, conn: object, *, epoch: int | None = None
    ) -> bool:
        """Join the hub as this device's one live socket. Returns False —
        nothing touched — when a socket at a HIGHER epoch is already
        registered: epochs only grow (a re-pair is the only thing that
        advances one), so that can only be an old-key socket whose
        authenticate() paused and resumed after a re-pair, once the new
        key's socket had already joined (T15 review). Displacing it would
        tear out the live connection from under the new socket, which stays
        open and heartbeating while the hub forgets it — exactly the bug a
        residual race left behind. A socket at an equal or higher epoch
        still replaces an older one, same as before (the ordinary
        reconnect). `epoch=None` — what a bare test registers — is never
        checked, and clears any epoch this device id was tracked under."""
        did = str(device_id)
        if epoch is not None:
            current = self._epochs.get(did)
            if current is not None and epoch < current:
                return False
        self._conns[did] = conn
        if epoch is None:
            self._epochs.pop(did, None)
        else:
            self._epochs[did] = epoch
        self._pending.setdefault(did, {})
        return True

    def unregister(self, device_id: str | uuid.UUID, conn: object) -> None:
        """Drop this conn only if it is still the registered one — a device that
        reconnected onto a new socket must not have its live entry torn out by
        the old socket's cleanup."""
        did = str(device_id)
        if self._conns.get(did) is not conn:
            return
        del self._conns[did]
        self._epochs.pop(did, None)
        for fut in self._pending.pop(did, {}).values():
            if not fut.done():
                fut.set_exception(
                    devices.DeviceRefused("the device disconnected before it answered")
                )

    def is_connected(self, device_id: str | uuid.UUID) -> bool:
        return str(device_id) in self._conns

    def connected_ids(self) -> set[str]:
        return set(self._conns)

    def in_flight(self, device_id: str | uuid.UUID) -> int:
        """Commands core sent this device that have not answered yet — the
        ones that end "cancelled" if its agent restarts now (S42b P25)."""
        return len(self._pending.get(str(device_id), {}))

    def idle(self, device_id: str | uuid.UUID, quiet_s: float) -> bool:
        """Connected, nothing in flight, and no command sent in the last
        quiet_s (S42b P10) — when restarting its agent cuts nothing off.
        False for a device with no socket: whether it is connected is
        stated elsewhere (agent_updates._connected), never from this."""
        did = str(device_id)
        if not self.is_connected(did) or self._pending.get(did):
            return False
        last = self._last_command.get(did)
        return last is None or time.monotonic() - last >= quiet_s

    def resolve(self, device_id: str | uuid.UUID, envelope_id: str, payload: dict) -> None:
        """A `result` frame arrived: resolve the future keyed by envelope_id and
        nothing else, so a frame for an id core is not awaiting resolves nothing."""
        fut = self._pending.get(str(device_id), {}).pop(envelope_id, None)
        if fut is not None and not fut.done():
            fut.set_result(payload)

    # commands ---------------------------------------------------------------
    async def command(
        self,
        pool,
        *,
        device_id: str | uuid.UUID,
        name: str,
        capability: str,
        args: dict,
        timeout: float,
        facts_sink: list[dict] | None = None,
        epoch: int | None = None,
    ) -> dict:
        """Send one signed command and await the device's own result.

        get_live is re-read here even though the tool already resolved the row:
        a revoke between name-resolution and dispatch must refuse, and the socket
        may still be draining. `name` rides in for the refusal text only. Only a
        `result` frame resolves the returned payload; a timeout or a missing
        socket raises DeviceRefused, which the tool restates as a ToolFailure.

        `facts_sink` (review N3) closes the one gap `_require_connected` cannot
        see: it determines connectivity inside the executor's `_admit`, but a
        socket can die in the window between that and this actual send — a
        race that check never observes. Both re-checks below ALSO determine
        connectivity (a connected=False the caller did not already know), so
        both record it here, the same {"device", "connected"} shape
        `_require_connected` uses, so a span's `facts` ends on the truth the
        refusal is actually reporting rather than staying stuck on the earlier
        stale True.

        A socket registered at an epoch the row has since moved past
        authenticated with a key the row no longer holds (a re-pair landed
        while it was joining): it is not this device's socket, so it reads as
        no socket at all, and nothing is signed or sent over it.

        `epoch` (S42b), when given, is the audit epoch of the row read the
        caller prepared this command from — an update composes its args from
        that agent's own facts, and a bootstrap's later steps run a file an
        earlier step checked ON THAT AGENT. If a re-pair has moved the row on
        since, the command is not sent to whatever agent holds the new key.

        Every refusal raised before the write is NotSent: nothing reached
        the device."""
        did = str(device_id)
        row = await devices.get_live(pool, _as_uuid(device_id))
        if row is None:
            raise NotSent(f"device {name!r} is not paired or has been revoked")
        current = row["audit_epoch"]
        if epoch is not None and current != epoch:
            raise NotSent(
                f"device {name!r} was re-paired after this command was prepared for its "
                "previous agent — nothing was sent to the agent that holds its new key"
            )
        conn = self._conns.get(did)
        if conn is None or self._epochs.get(did, current) != current:
            if facts_sink is not None:
                facts_sink.append({"device": name, "connected": False})
            raise NotSent(
                f"device {name!r} is not connected — its tile is stale; check it is "
                "powered on and online"
            )
        key = await devices.signing_key(pool)
        envelope = envelopes.build(did, capability, args)
        sig = envelopes.sign(key, envelope)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending.setdefault(did, {})[envelope["envelope_id"]] = fut
        try:
            # S42b P10: the update job's idle() reads this.
            self._last_command[did] = time.monotonic()
            try:
                await conn.send({"type": "command", "envelope": envelope, "sig": sig})
            except Exception as exc:
                # The socket died between the in-hub check and the write. A send
                # that failed did NOT reach the device, so it must read exactly
                # like a missing socket — the same stale-tile refusal — never as
                # an unexpected crash the model has to decode.
                if facts_sink is not None:
                    facts_sink.append({"device": name, "connected": False})
                raise NotSent(
                    f"device {name!r} is not connected — its tile is stale; check it is "
                    "powered on and online"
                ) from exc
            return await asyncio.wait_for(fut, timeout)
        except TimeoutError as exc:
            raise devices.DeviceRefused(
                f"device {name!r} did not answer within {int(timeout)}s"
            ) from exc
        finally:
            self._pending.get(did, {}).pop(envelope["envelope_id"], None)

    async def disconnect(self, device_id: str | uuid.UUID, reason: str) -> bool:
        """Kill a device's socket now — the revoke path calls this so a revoked
        machine drops immediately rather than at its next heartbeat, and a
        re-pair so the old key's socket does. Returns True only if a live
        socket was actually closed."""
        did = str(device_id)
        conn = self._conns.pop(did, None)
        self._epochs.pop(did, None)
        for fut in self._pending.pop(did, {}).values():
            if not fut.done():
                fut.set_exception(devices.DeviceRefused(f"device connection closed: {reason}"))
        if conn is None:
            return False
        try:
            await conn.close(REVOKED_CLOSE)
        except Exception:
            logger.warning("closing device socket %s failed", did, exc_info=True)
        return True


hub = Hub()


# -- authentication ----------------------------------------------------------


async def _auth_error(conn: object, reason: str) -> None:
    try:
        await conn.send({"type": "auth_error", "reason": reason})
        await conn.close(AUTH_FAILED_CLOSE)
    except Exception:
        logger.warning("sending auth_error failed", exc_info=True)


def revoked_proof(device_id: uuid.UUID | str, nonce_hex: str) -> dict:
    """The exact body core signs into a revoked auth_error's `proof`:
    {kind: "revoked", v: 1, device_id, nonce}. A free function, not inlined
    into `_auth_error_revoked`, so this wire shape and the committed
    cross-language vector (tests/test_envelopes.py,
    test_the_revoked_proof_vector_matches_devices_ws_shape) are built from
    the SAME place and cannot drift apart silently."""
    return {"kind": "revoked", "v": 1, "device_id": str(device_id), "nonce": nonce_hex}


async def _auth_error_revoked(conn: object, pool, device_id: uuid.UUID, nonce_hex: str) -> None:
    """The one auth_error that carries a proof: reason is REVOKED_REASON, and
    the proof (`revoked_proof`) is signed with core's OWN key (the same key
    every device pins at enrollment and verifies every command against),
    never the bare reason string. `nonce_hex` is THIS connection's own
    challenge nonce, so a proof cannot be replayed from a different
    handshake (apps/novad's wire.VerifyRevokedProof checks exactly this).

    Called only when the row IS revoked (revoked_at is set). An unknown id
    goes through the plain `_auth_error` above with no proof at all — core
    must never sign a proof for a device it merely does not know."""
    proof = revoked_proof(device_id, nonce_hex)
    key = await devices.signing_key(pool)
    reply = {
        "type": "auth_error",
        "reason": REVOKED_REASON,
        "proof": proof,
        "sig": envelopes.sign(key, proof),
    }
    try:
        await conn.send(reply)
        await conn.close(AUTH_FAILED_CLOSE)
    except Exception:
        logger.warning("sending revoked auth_error failed", exc_info=True)


async def authenticate(conn: object, pool) -> object | None:
    """Challenge the socket and return the device row on success, else None.

    Sends the nonce and core's pubkey; the device must return a valid signature
    over the raw nonce with the key its live row pins. A revoked device has no
    live row, so this is where its reconnect is refused — by the absence of the
    row, not a flag. A re-paired device's old key fails here too: the row now
    pins the new one.

    The returned row is the ONE read the socket authenticated against: its
    `audit_epoch` belongs to the key that verified, because a re-pair swaps
    both in one UPDATE. Everything this socket writes is bound to it."""
    nonce = secrets.token_bytes(NONCE_BYTES)
    core_pubkey = await devices.core_public_key_hex(pool)
    await conn.send({"type": "challenge", "nonce": nonce.hex(), "core_pubkey": core_pubkey})

    try:
        frame = await conn.receive()
    except ConnectionClosed:
        return None
    if not isinstance(frame, dict) or frame.get("type") != "auth":
        await _auth_error(conn, "expected an auth frame")
        return None

    try:
        device_id = uuid.UUID(str(frame.get("device_id")))
    except (ValueError, TypeError):
        await _auth_error(conn, "device_id is not a valid id")
        return None

    row = await devices.get_live(pool, device_id)
    if row is None:
        gone = await devices.get(pool, device_id)
        if gone is not None and gone["revoked_at"] is not None:
            sig = frame.get("sig")
            if not isinstance(sig, str) or not verify_nonce(gone["pubkey"], nonce, sig):
                # The signed proof goes only to whoever holds the revoked key
                # (S42a's carry): anyone else learns nothing and leaves no knock.
                await _auth_error(conn, "the challenge signature did not verify")
                return None
            # P28: the revoked agent is still running. Its knock is a record,
            # so "is it still running?" has an answer. No `AND audit_epoch`
            # here, unlike every live-row write below: a revoked row has no
            # live epoch to protect — get_live never returns it again for
            # ANY key, so nothing else can ever write onto it either.
            await pool.execute(
                "UPDATE devices SET last_refused_at = now() WHERE id = $1", device_id
            )
            await _auth_error_revoked(conn, pool, device_id, nonce.hex())
        else:
            await _auth_error(conn, UNKNOWN_DEVICE_REASON)
        return None

    sig = frame.get("sig")
    if not isinstance(sig, str) or not verify_nonce(row["pubkey"], nonce, sig):
        await _auth_error(conn, "the challenge signature did not verify")
        return None

    epoch = row["audit_epoch"]
    stored = await _record_auth_facts(pool, device_id, frame.get("facts"), epoch=epoch)
    try:
        # S42b P8: this connection decides the device's open update, if any —
        # from the facts it STORED (None when nothing was stored, so nothing
        # is decided) and only at this socket's own epoch (observe_connect).
        # Imported here: agent_updates imports this module (its hub).
        from app import agent_updates

        await agent_updates.observe_connect(pool, device_id, stored, epoch=epoch)
    except Exception:  # noqa: BLE001 — an update's bookkeeping never refuses a socket
        logger.exception("device %s: its open update could not be decided", device_id)
    # S42b P15: the door this socket came through, written only while the row
    # is still at `epoch` (the note above _record_auth_facts) — a re-pair
    # mid-handshake must not let this socket's door land on the rebound row.
    # NULL — conn has no `door` attribute, or door_of could not tell — is
    # stored exactly as told, never guessed.
    await pool.execute(
        "UPDATE devices SET last_transport = $2 WHERE id = $1 AND audit_epoch = $3",
        device_id,
        getattr(conn, "door", None),
        epoch,
    )

    last_seq = await pool.fetchval(
        "SELECT max(seq) FROM device_audit WHERE device_id = $1 AND epoch = $2",
        device_id,
        epoch,
    )
    await conn.send({"type": "ready", "last_seq": last_seq})
    return row


# -- audit ingestion ---------------------------------------------------------

# P27: what an audit entry must be for postgres to store it as sent. The chain
# hash covers exactly what the device sent, so core never repairs an entry —
# one it cannot store is a stated break, and nothing past it is stored.
_BIGINT = (-(2**63), 2**63 - 1)
_TS_RANGE = (0, 253_402_300_799)  # 1970-01-01 .. 9999-12-31T23:59:59Z
_ENTRY_TEXT_MAX = 4096


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _text_problem(value: object) -> str | None:
    """Why `value` is not text postgres can store or carry verbatim, or None.

    Fix round 2 (re-review of faabe935): shared by _entry_problem (names the
    field a problem belongs to) and _echoable_text (silently withholds an
    unsafe value rather than naming why) so the two check exactly the same
    shapes by construction. Fix round 1 added NUL/non-text/length checks to
    both independently and missed a lone UTF-16 surrogate in BOTH — nothing
    forced them to agree, so they drifted the same way at once. One
    definition now; a future postgres-hostile shape found in either caller
    is fixed for both. The UTF-8 encode is the real test for a surrogate:
    json.dumps with ensure_ascii=True (envelopes.canonical) happily escapes
    one to text without raising, so an isinstance/NUL/length check alone
    never catches it — only an actual encode attempt does (the same probe
    device_facts._encoded_size already uses, for the same reason)."""
    if not isinstance(value, str):
        return "is not text"
    if "\x00" in value:
        return "contains a NUL byte, which postgres cannot store"
    if len(value) > _ENTRY_TEXT_MAX:
        return f"is longer than {_ENTRY_TEXT_MAX} characters"
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return "contains an unpaired UTF-16 surrogate, which postgres cannot store"
    return None


def _entry_problem(entry: dict) -> str | None:
    """Why this audit entry cannot be stored as sent, or None."""
    seq = entry.get("seq")
    if not _is_int(seq) or not 0 <= seq <= _BIGINT[1]:
        return f"seq {seq!r} is not a non-negative 64-bit integer"
    ts = entry.get("ts")
    if not _is_int(ts) or not _TS_RANGE[0] <= ts <= _TS_RANGE[1]:
        return f"ts {ts!r} is not a time between 1970 and 9999"
    code = entry.get("exit_code")
    if code is not None and (not _is_int(code) or not _BIGINT[0] <= code <= _BIGINT[1]):
        return f"exit_code {code!r} does not fit a 64-bit integer"
    if not isinstance(entry.get("ok"), bool):
        return f"ok {entry.get('ok')!r} is not true or false"
    for key in ("envelope_id", "capability", "summary", "prev_hash", "hash"):
        value = entry.get(key)
        if value is None:
            continue
        problem = _text_problem(value)
        if problem is not None:
            return f"{key} {problem}"
    return None


def _echoable_text(value: object) -> str | None:
    """`value` if a governance event can safely carry it verbatim, else None.

    Fix round 1 (review of 2c1fbef0): a break must never echo the exact
    value that broke it — putting an entry's raw field straight into the
    break's own meta or log line can make the RECORD of the break fail the
    same way the entry did, silently losing the device.audit_break event
    the brief's Interfaces line promises."""
    return None if _text_problem(value) is not None else value


async def _audit_break(
    pool,
    device_id: uuid.UUID,
    seq: int | None,
    expected_prev: str | None,
    got_prev: str | None,
    *,
    epoch: int,
    expected_hash: str | None = None,
    got_hash: str | None = None,
    reason: str | None = None,
) -> None:
    # The epoch is named because a re-paired device has two chains that both
    # start at seq 0: a break that said only the seq could not be placed.
    meta: dict = {
        "device_id": str(device_id),
        "epoch": epoch,
        "seq": seq,
        "expected_prev": expected_prev,
        "got_prev": got_prev,
    }
    if expected_hash is not None:
        meta["expected_hash"] = expected_hash
        meta["got_hash"] = got_hash
    if reason is not None:
        meta["reason"] = reason
    logger.error(
        "device audit chain break: device=%s epoch=%s seq=%s expected_prev=%s got_prev=%s%s",
        device_id,
        epoch,
        seq,
        expected_prev,
        got_prev,
        f" reason={reason}" if reason is not None else "",
    )
    # A standalone event: the break records no state mutation of its own (the
    # bad entry is NOT stored), so it opens its own transaction to be durable.
    async with pool.acquire() as conn, conn.transaction():
        await governance.record_event(
            conn, kind=governance.DEVICE_AUDIT_BREAK, subject_ref=device_id, meta=meta
        )


async def ingest_audit(pool, device_id: str | uuid.UUID, entries: list, *, epoch: int = 0) -> dict:
    """Verify and store a replayed audit batch, in seq order, stopping at the
    first break.

    The batch belongs to ONE chain: `epoch`, the audit epoch of the row the
    sending socket authenticated against (serve passes it). A re-pair moves
    the row to a new epoch, so the new key's chain starts at seq 0 beside the
    old one, which stays stored as history; nothing here ever reads or writes
    across epochs.

    For each entry: prev_hash must equal the stored hash of seq-1 in the same
    epoch (or "" at seq 0), and recomputing the entry's own hash must
    reproduce it. A mismatch does NOT store past the break — it writes
    DEVICE_AUDIT_BREAK and returns, leaving the socket alive (the operator
    decides what a tampered device means). Good entries are stored with ON
    CONFLICT DO NOTHING, so replaying a batch core already has is a no-op.

    A verified entry postgres itself refuses (asyncpg.DataError — an
    out-of-range exit_code was the live case) also does NOT store past
    itself, and also leaves the socket alive — but writes no
    DEVICE_AUDIT_BREAK, since the chain was never tampered with; only an
    ERROR log names the device and seq."""
    device_uuid = _as_uuid(device_id)
    if not all(isinstance(e, dict) and _is_int(e.get("seq")) for e in entries):
        await _audit_break(
            pool,
            device_uuid,
            None,
            None,
            "",
            epoch=epoch,
            reason=(
                "a replayed batch carried an entry with no integer seq; nothing from it is stored"
            ),
        )
        return {"stored": 0, "break": None}
    ordered = sorted(entries, key=lambda e: e["seq"])
    stored = 0
    for entry in ordered:
        seq = entry["seq"]
        got_prev = entry.get("prev_hash") or ""
        claimed_hash = entry.get("hash")
        without_hash = {k: v for k, v in entry.items() if k != "hash"}

        problem = _entry_problem(entry)
        if problem is not None:
            # Fix round 1: got_prev is exactly what made THIS entry
            # unstorable when prev_hash is the field named above — never
            # echo it raw, or the break's own record can fail the same way.
            await _audit_break(
                pool,
                device_uuid,
                seq,
                None,
                _echoable_text(got_prev),
                epoch=epoch,
                reason=f"the entry cannot be stored: {problem}",
            )
            return {"stored": stored, "break": seq}

        if seq == 0:
            expected_prev: str | None = ""
        else:
            expected_prev = await pool.fetchval(
                "SELECT hash FROM device_audit WHERE device_id = $1 AND epoch = $2 AND seq = $3",
                device_uuid,
                epoch,
                seq - 1,
            )
        if expected_prev is None:
            # seq-1 is neither stored nor earlier in this batch: a gap.
            await _audit_break(pool, device_uuid, seq, None, _echoable_text(got_prev), epoch=epoch)
            return {"stored": stored, "break": seq}
        if got_prev != expected_prev:
            await _audit_break(
                pool, device_uuid, seq, expected_prev, _echoable_text(got_prev), epoch=epoch
            )
            return {"stored": stored, "break": seq}
        recomputed = chain_hash(got_prev, without_hash)
        if recomputed != claimed_hash:
            # Fix round 2: got_prev and claimed_hash (-> got_hash) are both
            # device-supplied — every _audit_break call site that passes a
            # device-supplied value passes it through _echoable_text, not
            # just the one the re-review happened to cite (the ruling: "one
            # rule for every site, so no future path can echo an unstorable
            # value"). expected_prev/expected_hash are core's own ("" or a
            # hash postgres already stored once, or one core just computed),
            # never device-supplied, so neither is filtered.
            await _audit_break(
                pool,
                device_uuid,
                seq,
                expected_prev,
                _echoable_text(got_prev),
                epoch=epoch,
                expected_hash=recomputed,
                got_hash=_echoable_text(claimed_hash),
            )
            return {"stored": stored, "break": seq}

        try:
            await pool.execute(
                "INSERT INTO device_audit (device_id, seq, prev_hash, hash, ts, envelope_id, "
                "capability, summary, ok, exit_code, epoch) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) "
                "ON CONFLICT (device_id, epoch, seq) DO NOTHING",
                device_uuid,
                seq,
                got_prev or None,
                claimed_hash,
                datetime.fromtimestamp(int(entry.get("ts") or 0), tz=UTC),
                entry.get("envelope_id"),
                entry.get("capability"),
                entry.get("summary"),
                bool(entry.get("ok")),
                entry.get("exit_code"),
                epoch,
            )
        except asyncpg.DataError as exc:
            # A poison entry (an out-of-range exit_code was the live case —
            # T3's Windows agent sent a uint32 DWORD too big for the int4
            # column of the day; anything else postgres refuses lands here
            # the same way) must never take the socket down. The hash still
            # verified — this is NOT a tamper detection, so no
            # DEVICE_AUDIT_BREAK governance event — it is postgres refusing
            # to store a value core's own chain already accepted as genuine.
            # Stop AT this entry: it is not stored (ON CONFLICT never ran),
            # and nothing after it in the batch is attempted, so the return
            # shape below never claims more than what actually landed.
            logger.error(
                "device %s: audit entry epoch=%s seq=%s not stored — postgres refused it: %s",
                device_uuid,
                epoch,
                seq,
                exc,
            )
            return {"stored": stored, "break": seq}
        stored += 1
    return {"stored": stored, "break": None}


# -- the connection lifecycle ------------------------------------------------


# Every write a socket makes to its device row carries `AND audit_epoch = $n`,
# the epoch of the row read it authenticated against (authenticate). A re-pair
# moves the epoch in the same UPDATE that swaps the key and clears the old
# agent's facts and last_seen, so a socket still open for the OLD key — its
# frames in flight before the drop lands, or one that authenticated just as the
# re-pair committed — stamps nothing on the rebound row: those columns describe
# the key the row holds now.


async def _record_auth_facts(pool, device_id: uuid.UUID, raw: object, *, epoch: int) -> dict | None:
    """Record the auth frame's facts — AFTER the signature verified — REPLACING
    what the device said before: a new connection is a fresh truth. Written
    only while the row is still at `epoch` (the note above).

    Returns the facts it STORED (S42b, for agent_updates.observe_connect), or
    None: absent, rejected, refused by postgres, or valid but stored nowhere
    because a re-pair moved the row past `epoch` — what was not recorded is
    never handed on as though it were.

    Facts that are ABSENT, REJECTED, or that postgres itself refuses
    (asyncpg.DataError — UntranslatableCharacterError, a NUL byte, is one
    instance of it; device_facts already catches the two known shapes before
    the write, so this is the belt-and-suspenders half) all take the SAME
    path: clear facts/facts_at to NULL/NULL rather than leave a PREVIOUS
    connection's identity facts in the row for the next facts frame to merge
    into and re-date "reported just now" — a misstatement exactly during an
    agent/core version skew (controller ruling revising P2). None of this is
    ever a reason to refuse the socket, and a facts frame still merges into
    the cleared (NULL) row afterward, so an agent's net section — its MACs,
    for wake — survives even without identity facts."""
    if raw is not None:
        try:
            clean = device_facts.validate_auth(raw)
        except device_facts.FactsRejected as exc:
            logger.warning("device %s: auth-frame facts not recorded — %s", device_id, exc.reason)
        else:
            try:
                status = await pool.execute(
                    "UPDATE devices SET facts = $2, facts_at = now() "
                    "WHERE id = $1 AND audit_epoch = $3",
                    device_id,
                    clean,
                    epoch,
                )
                # "UPDATE 0": the row moved past this socket's epoch — stored
                # nowhere, and the clear below would match nothing either.
                return clean if status == "UPDATE 1" else None
            except asyncpg.DataError as exc:
                logger.warning(
                    "device %s: auth-frame facts not recorded — postgres refused them: %s",
                    device_id,
                    exc,
                )
    await pool.execute(
        "UPDATE devices SET facts = NULL, facts_at = NULL WHERE id = $1 AND audit_epoch = $2",
        device_id,
        epoch,
    )
    return None


async def _record_facts_frame(pool, device_id: uuid.UUID, frame: dict, *, epoch: int) -> None:
    """MERGE a facts frame's sections into what the device said
    (device_facts.merge_frame), so the auth facts survive a frame that carries
    only net/unreadable — and a probe lands as ONE unit: a frame carrying
    probed_at replaces every probe section, and one without leaves them
    alone (Task 21 ruling; a jsonb `||` here kept an older probe's WSL list
    under a newer probe's time). Read and written in one transaction holding
    the row, so no other write lands between them; only while the row is
    still at `epoch`. A shape device_facts refuses, or one postgres itself
    refuses (asyncpg.DataError — the belt-and-suspenders half, beside
    device_facts already catching the two known postgres-hostile shapes
    before the write), is logged and dropped: never a reason to take the
    socket down."""
    try:
        sections = device_facts.validate_frame(frame)
    except device_facts.FactsRejected as exc:
        logger.warning("device %s: facts frame not recorded — %s", device_id, exc.reason)
        return
    if "probed_at" not in sections and any(k in sections for k in device_facts.PROBE_SECTIONS):
        logger.warning(
            "device %s: probe sections without probed_at not recorded — no time says when "
            "they were read",
            device_id,
        )
    try:
        async with pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                "SELECT facts FROM devices WHERE id = $1 AND audit_epoch = $2 FOR UPDATE",
                device_id,
                epoch,
            )
            if row is None:
                return  # a re-pair moved the row past this socket's epoch
            await conn.execute(
                "UPDATE devices SET facts = $2::jsonb, facts_at = now() "
                "WHERE id = $1 AND audit_epoch = $3",
                device_id,
                device_facts.merge_frame(row["facts"], sections),
                epoch,
            )
    except asyncpg.DataError as exc:
        logger.warning(
            "device %s: facts frame not recorded — postgres refused it: %s", device_id, exc
        )


async def _handle_frame(pool, device_id: uuid.UUID, frame: object, *, epoch: int = 0) -> None:
    """One frame from a socket authenticated at `epoch`: its audit lands in
    that epoch's chain, and its row writes hold only while the row is still
    there (the note above `_record_auth_facts`)."""
    if not isinstance(frame, dict):
        return
    kind = frame.get("type")
    if kind == "heartbeat":
        await pool.execute(
            "UPDATE devices SET last_seen = now() WHERE id = $1 AND audit_epoch = $2",
            device_id,
            epoch,
        )
    elif kind == "result":
        envelope_id = frame.get("envelope_id")
        if isinstance(envelope_id, str):
            hub.resolve(device_id, envelope_id, frame)
    elif kind == "audit":
        entries = frame.get("entries")
        if isinstance(entries, list):
            await ingest_audit(pool, device_id, entries, epoch=epoch)
    elif kind == "facts":
        await _record_facts_frame(pool, device_id, frame, epoch=epoch)
    else:
        logger.info("device %s sent an unknown frame type %r", device_id, kind)


async def _still_bound(pool, row) -> bool:
    """True while the device's live row still holds the key and audit epoch
    this socket authenticated against — False once a re-pair rebound it or a
    revoke ended it."""
    current = await devices.get_live(pool, row["id"])
    return (
        current is not None
        and current["pubkey"] == row["pubkey"]
        and current["audit_epoch"] == row["audit_epoch"]
    )


async def serve(conn: object, pool) -> None:
    """One socket's whole life: authenticate, join the hub, pump frames, leave.

    Operates on a conn abstraction (send/receive/close) so the exact same code
    serves a real Starlette WebSocket and an in-process fake — the protocol is
    tested without a socket, and T5's fake device drives this directly."""
    row = await authenticate(conn, pool)
    if row is None:
        return
    device_id = row["id"]
    epoch = row["audit_epoch"]
    if not hub.register(device_id, conn, epoch=epoch):
        # A socket at a higher epoch already holds the hub's entry for this
        # device: this one authenticated against a row snapshot a re-pair has
        # since moved past (T15 review). Refused before it could displace the
        # live connection, and never registered — so unregister() must not
        # run for it, unlike the _still_bound drop below.
        logger.warning(
            "device %s: a socket at a later epoch is already connected — dropped",
            device_id,
        )
        try:
            await conn.close(REVOKED_CLOSE)
        except Exception:
            logger.warning("closing device socket %s failed", device_id, exc_info=True)
        return
    try:
        # authenticate read the row before this socket joined the hub. A
        # re-pair or revoke that committed in between called hub.disconnect
        # while there was nothing to drop, and the socket would stay
        # connected for a key the row no longer holds. Joined first, read
        # second: whatever commits after this read finds the socket in the
        # hub and drops it there.
        if not await _still_bound(pool, row):
            logger.warning(
                "device %s: re-paired or revoked while this socket authenticated — dropped",
                device_id,
            )
            try:
                await conn.close(REVOKED_CLOSE)
            except Exception:
                logger.warning("closing device socket %s failed", device_id, exc_info=True)
            return
        while True:
            try:
                frame = await conn.receive()
            except ConnectionClosed:
                break
            try:
                await _handle_frame(pool, device_id, frame, epoch=epoch)
            except Exception:  # noqa: BLE001 — P27: one frame never ends a session
                kind = frame.get("type") if isinstance(frame, dict) else type(frame).__name__
                logger.exception(
                    "device %s: a %r frame could not be handled — dropped; the session stays up",
                    device_id,
                    kind,
                )
    finally:
        hub.unregister(device_id, conn)


# -- the route ---------------------------------------------------------------


class WebSocketConn:
    """Adapts a Starlette WebSocket to the conn abstraction the hub speaks. A
    WebSocketDisconnect becomes ConnectionClosed so serve() unwinds identically
    to the fake."""

    def __init__(self, websocket: WebSocket, door: str | None = None) -> None:
        self._ws = websocket
        self.door = door

    async def send(self, frame: dict) -> None:
        await self._ws.send_json(frame)

    async def receive(self) -> dict:
        try:
            return await self._ws.receive_json()
        except WebSocketDisconnect as exc:
            raise ConnectionClosed() from exc
        except (ValueError, KeyError, RecursionError) as exc:
            # Not JSON, a binary frame, or JSON nested past the recursion
            # limit: one unreadable frame, never the end of the socket (P27).
            logger.warning(
                "a device sent a frame that is not a readable JSON text frame (%s)",
                type(exc).__name__,
            )
            return {"type": UNREADABLE_FRAME}

    async def close(self, code: int = 1000) -> None:
        try:
            await self._ws.close(code=code)
        except RuntimeError:
            # Starlette raises if the socket is already closed — a revoke that
            # raced the client's own hang-up. Nothing left to do.
            pass


@router.websocket("/api/v1/devices/ws")
async def devices_ws_route(websocket: WebSocket) -> None:
    """The one WebSocket in core. Starlette's http identity_middleware never
    sees a WebSocket scope, so this route is unauthenticated by transport and
    authenticated by the challenge inside serve() — deliberately, not by an
    exemption anyone can widen (it is NOT in PUBLIC_PATHS)."""
    await websocket.accept()
    pool = await db.get_pool()
    peer = websocket.client.host if websocket.client else None
    door = network.door_of(peer, websocket.headers.get("x-real-ip"))
    await serve(WebSocketConn(websocket, door=door), pool)
