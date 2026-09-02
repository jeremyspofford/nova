"""The device socket: a WebSocket a paired machine holds open, and the hub that
sends it signed commands and awaits real results.

Nothing here decides WHO may call WHAT — that is the kernel (policy.authorize),
which the device tools ride like every other tool. This module is the transport
under those tools: it authenticates the socket, keeps the live registry the
tools send through, and turns "accepted by transport" into "the device actually
answered" — because only a `result` frame the device itself sent ever resolves a
command. A timeout, a dropped socket, a revoked device: each is a stated
DeviceRefused, never a guess that it worked.

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
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
import uuid
from datetime import UTC, datetime

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric import ed25519
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app import db, devices, envelopes, governance

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
#     ready      {last_seq: int | null}
#     auth_error {reason}                        then close 4401
#     command    {envelope, sig}                  (envelopes.build / sign)
#   device -> core
#     auth       {device_id, sig: hex(sign(raw nonce)), home_dir?: str}
#                home_dir is OPTIONAL and additive (novad ≥ this change sends
#                os.UserHomeDir()): stored on the device row AFTER the
#                signature verifies, so an already-enrolled device gets it on
#                its next connect. It is a suggestion the grants editor offers
#                as the first fs root — it never widens a grant by itself, and
#                junk is dropped (devices.clean_home_dir), never a refusal.
#     heartbeat  {ts}                            -> devices.last_seen = now()
#     result     {envelope_id, ok, output, exit_code, error}
#     audit      {entries: [_ENTRY_KEYS...]}     (ingest_audit)

# WebSocket close codes in the application-private 4000-4999 range. 4401 mirrors
# HTTP 401 (the challenge did not authenticate); 4403 mirrors 403 (the row is
# gone from under a live socket — a revoke).
AUTH_FAILED_CLOSE = 4401
REVOKED_CLOSE = 4403

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

    # registry ---------------------------------------------------------------
    def register(self, device_id: str | uuid.UUID, conn: object) -> None:
        did = str(device_id)
        self._conns[did] = conn
        self._pending.setdefault(did, {})

    def unregister(self, device_id: str | uuid.UUID, conn: object) -> None:
        """Drop this conn only if it is still the registered one — a device that
        reconnected onto a new socket must not have its live entry torn out by
        the old socket's cleanup."""
        did = str(device_id)
        if self._conns.get(did) is not conn:
            return
        del self._conns[did]
        for fut in self._pending.pop(did, {}).values():
            if not fut.done():
                fut.set_exception(
                    devices.DeviceRefused("the device disconnected before it answered")
                )

    def is_connected(self, device_id: str | uuid.UUID) -> bool:
        return str(device_id) in self._conns

    def connected_ids(self) -> set[str]:
        return set(self._conns)

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
    ) -> dict:
        """Send one signed command and await the device's own result.

        get_live is re-read here even though the tool already resolved the row:
        a revoke between name-resolution and dispatch must refuse, and the socket
        may still be draining. `name` rides in for the refusal text only. Only a
        `result` frame resolves the returned payload; a timeout or a missing
        socket raises DeviceRefused, which the tool restates as a ToolFailure."""
        did = str(device_id)
        row = await devices.get_live(pool, _as_uuid(device_id))
        if row is None:
            raise devices.DeviceRefused(f"device {name!r} is not paired or has been revoked")
        conn = self._conns.get(did)
        if conn is None:
            raise devices.DeviceRefused(
                f"device {name!r} is not connected — its tile is stale; check it is "
                "powered on and online"
            )
        key = await devices.signing_key(pool)
        envelope = envelopes.build(did, capability, args)
        sig = envelopes.sign(key, envelope)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending.setdefault(did, {})[envelope["envelope_id"]] = fut
        try:
            try:
                await conn.send({"type": "command", "envelope": envelope, "sig": sig})
            except Exception as exc:
                # The socket died between the in-hub check and the write. A send
                # that failed did NOT reach the device, so it must read exactly
                # like a missing socket — the same stale-tile refusal — never as
                # an unexpected crash the model has to decode.
                raise devices.DeviceRefused(
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
        machine drops immediately rather than at its next heartbeat. Returns
        True only if a live socket was actually closed."""
        did = str(device_id)
        conn = self._conns.pop(did, None)
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


async def authenticate(conn: object, pool) -> object | None:
    """Challenge the socket and return the device row on success, else None.

    Sends the nonce and core's pubkey; the device must return a valid signature
    over the raw nonce with the key its live row pins. A revoked device has no
    live row, so this is where its reconnect is refused — by the absence of the
    row, not a flag. The auth frame's optional `home_dir` (see the frame
    contract above) is recorded only once the signature has verified."""
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
        await _auth_error(conn, "no such device, or it has been revoked")
        return None

    sig = frame.get("sig")
    if not isinstance(sig, str) or not verify_nonce(row["pubkey"], nonce, sig):
        await _auth_error(conn, "the challenge signature did not verify")
        return None

    # Only past the signature: the frame is now the device's own word. The
    # optional home_dir is stored for the grants editor to suggest; a frame
    # without it (an older daemon) changes nothing.
    if "home_dir" in frame:
        await devices.record_home_dir(pool, device_id, frame.get("home_dir"))

    last_seq = await pool.fetchval(
        "SELECT max(seq) FROM device_audit WHERE device_id = $1", device_id
    )
    await conn.send({"type": "ready", "last_seq": last_seq})
    return row


# -- audit ingestion ---------------------------------------------------------


async def _audit_break(
    pool,
    device_id: uuid.UUID,
    seq: int,
    expected_prev: str | None,
    got_prev: str,
    *,
    expected_hash: str | None = None,
    got_hash: str | None = None,
) -> None:
    meta: dict = {
        "device_id": str(device_id),
        "seq": seq,
        "expected_prev": expected_prev,
        "got_prev": got_prev,
    }
    if expected_hash is not None:
        meta["expected_hash"] = expected_hash
        meta["got_hash"] = got_hash
    logger.error(
        "device audit chain break: device=%s seq=%s expected_prev=%s got_prev=%s",
        device_id,
        seq,
        expected_prev,
        got_prev,
    )
    await governance.append(
        pool, kind=governance.DEVICE_AUDIT_BREAK, subject_ref=device_id, meta=meta
    )


async def ingest_audit(pool, device_id: str | uuid.UUID, entries: list) -> dict:
    """Verify and store a replayed audit batch, in seq order, stopping at the
    first break.

    For each entry: prev_hash must equal the stored hash of seq-1 (or "" at seq
    0), and recomputing the entry's own hash must reproduce it. A mismatch does
    NOT store past the break — it writes DEVICE_AUDIT_BREAK and returns, leaving
    the socket alive (the operator decides what a tampered device means).
    Good entries are stored with ON CONFLICT DO NOTHING, so replaying a batch
    core already has is a no-op."""
    device_uuid = _as_uuid(device_id)
    ordered = sorted(
        (e for e in entries if isinstance(e, dict) and isinstance(e.get("seq"), int)),
        key=lambda e: e["seq"],
    )
    stored = 0
    for entry in ordered:
        seq = entry["seq"]
        got_prev = entry.get("prev_hash") or ""
        claimed_hash = entry.get("hash")
        without_hash = {k: v for k, v in entry.items() if k != "hash"}

        if seq == 0:
            expected_prev: str | None = ""
        else:
            expected_prev = await pool.fetchval(
                "SELECT hash FROM device_audit WHERE device_id = $1 AND seq = $2",
                device_uuid,
                seq - 1,
            )
        if expected_prev is None:
            # seq-1 is neither stored nor earlier in this batch: a gap.
            await _audit_break(pool, device_uuid, seq, None, got_prev)
            return {"stored": stored, "break": seq}
        if got_prev != expected_prev:
            await _audit_break(pool, device_uuid, seq, expected_prev, got_prev)
            return {"stored": stored, "break": seq}
        recomputed = chain_hash(got_prev, without_hash)
        if recomputed != claimed_hash:
            await _audit_break(
                pool,
                device_uuid,
                seq,
                expected_prev,
                got_prev,
                expected_hash=recomputed,
                got_hash=claimed_hash,
            )
            return {"stored": stored, "break": seq}

        await pool.execute(
            "INSERT INTO device_audit (device_id, seq, prev_hash, hash, ts, envelope_id, "
            "capability, summary, ok, exit_code) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) "
            "ON CONFLICT (device_id, seq) DO NOTHING",
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
        )
        stored += 1
    return {"stored": stored, "break": None}


# -- the connection lifecycle ------------------------------------------------


async def _handle_frame(pool, device_id: uuid.UUID, frame: object) -> None:
    if not isinstance(frame, dict):
        return
    kind = frame.get("type")
    if kind == "heartbeat":
        await pool.execute("UPDATE devices SET last_seen = now() WHERE id = $1", device_id)
    elif kind == "result":
        envelope_id = frame.get("envelope_id")
        if isinstance(envelope_id, str):
            hub.resolve(device_id, envelope_id, frame)
    elif kind == "audit":
        entries = frame.get("entries")
        if isinstance(entries, list):
            await ingest_audit(pool, device_id, entries)
    else:
        logger.info("device %s sent an unknown frame type %r", device_id, kind)


async def serve(conn: object, pool) -> None:
    """One socket's whole life: authenticate, join the hub, pump frames, leave.

    Operates on a conn abstraction (send/receive/close) so the exact same code
    serves a real Starlette WebSocket and an in-process fake — the protocol is
    tested without a socket, and T5's fake device drives this directly."""
    row = await authenticate(conn, pool)
    if row is None:
        return
    device_id = row["id"]
    hub.register(device_id, conn)
    try:
        while True:
            try:
                frame = await conn.receive()
            except ConnectionClosed:
                break
            await _handle_frame(pool, device_id, frame)
    finally:
        hub.unregister(device_id, conn)


# -- the route ---------------------------------------------------------------


class WebSocketConn:
    """Adapts a Starlette WebSocket to the conn abstraction the hub speaks. A
    WebSocketDisconnect becomes ConnectionClosed so serve() unwinds identically
    to the fake."""

    def __init__(self, websocket: WebSocket) -> None:
        self._ws = websocket

    async def send(self, frame: dict) -> None:
        await self._ws.send_json(frame)

    async def receive(self) -> dict:
        try:
            return await self._ws.receive_json()
        except WebSocketDisconnect as exc:
            raise ConnectionClosed() from exc

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
    await serve(WebSocketConn(websocket), pool)
