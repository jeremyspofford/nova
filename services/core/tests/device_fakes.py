"""In-process fakes for the device WS hub, so the protocol is testable with no
socket.

`FakeWSConn` is the connection abstraction the hub speaks to: `send` records
every frame core puts on the wire (a deny leaving ZERO frames is asserted off
`sent`), `receive` yields frames the test feeds, and `close` records the close
code. It is the same shape the real `devices_ws.WebSocketConn` adapter wraps a
Starlette WebSocket in, so a test drives `devices_ws.serve` against this exactly
as a real daemon would drive the route.

`FakeDevice` is the other half: a keypair plus the challenge->auth->result
protocol a real novad performs. T2 seeded it with just enough to authenticate
and answer one command; T5 (this) grew it into the full fake device that walks
enroll -> handshake -> command -> audit end to end against `devices_ws.serve`,
so the DoD tripwire drives the real ASGI/socket code path with no model and no
real socket. It is deliberately HONEST: `answer_command` verifies core's
signature over the envelope (envelopes.verify) before it will return a result,
and every command it answers appends a real hash-chained audit entry — it never
rubber-stamps, so a test that reaches past it has proven the envelope was real
and the chain joins up.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

from cryptography.hazmat.primitives.asymmetric import ed25519

from app import devices_ws, envelopes

_CLOSED = object()


class FakeWSConn:
    """A connection the hub can send to and receive from, backed by queues.

    `sent` is the ordered list of every frame core sent — the wire, for
    assertions. `next_sent()` awaits the next one (for a driver that must react
    to a challenge). Frames from the "device" are pushed with `feed`; `feed_close`
    (or `close`) makes the next `receive` raise ConnectionClosed, the same signal
    the real adapter raises on WebSocketDisconnect.
    """

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed_code: int | None = None
        self._outbound: asyncio.Queue = asyncio.Queue()
        self._incoming: asyncio.Queue = asyncio.Queue()

    async def send(self, frame: dict) -> None:
        self.sent.append(frame)
        self._outbound.put_nowait(frame)

    async def receive(self) -> dict:
        item = await self._incoming.get()
        if item is _CLOSED:
            raise devices_ws.ConnectionClosed()
        return item

    async def close(self, code: int = 1000) -> None:
        self.closed_code = code
        # Unblock a serve loop parked in receive() so it can unwind.
        self._incoming.put_nowait(_CLOSED)

    # -- test driver side --------------------------------------------------
    async def next_sent(self) -> dict:
        return await self._outbound.get()

    def feed(self, frame: dict) -> None:
        self._incoming.put_nowait(frame)

    def feed_close(self) -> None:
        self._incoming.put_nowait(_CLOSED)


@dataclass
class FakeDevice:
    """A device's ed25519 key and the protocol moves a real daemon makes.

    `pubkey_hex` is what an enroll binds; `sign_nonce` answers the WS challenge;
    `result` builds the `result` frame a daemon returns for a command. The T5
    growth adds the moves that make a WHOLE lifecycle testable against
    `devices_ws.serve`: `handshake` runs challenge->auth->ready (pinning core's
    key the way a real daemon pins it at connect), and `answer_command` verifies
    the envelope, returns a settable result, and appends a valid hash-chained
    audit entry — the same chain `devices_ws.ingest_audit` verifies into
    `device_audit`, so the device's own log and core's stored ledger are asserted
    to AGREE, never just core's word for it.
    """

    key: ed25519.Ed25519PrivateKey = field(
        default_factory=ed25519.Ed25519PrivateKey.generate
    )
    # Set from the enroll result before the handshake — a real daemon knows its
    # own id from enrollment. Left None until then so a handshake without an
    # enroll fails loud rather than signing for nobody.
    device_id: str | None = None
    # Pinned from the challenge, TOFU-style, the moment the socket connects — the
    # key `answer_command` then verifies every command's signature against.
    core_pubkey_hex: str | None = None
    # The device's own hash chain, exactly as a real novad keeps it: a monotonic
    # seq and the running prev_hash. `audit_log` is what the device BELIEVES it
    # sent, for asserting core stored precisely that, in order.
    _seq: int = 0
    _prev_hash: str = ""
    audit_log: list[dict] = field(default_factory=list)

    @property
    def pubkey_hex(self) -> str:
        return self.key.public_key().public_bytes_raw().hex()

    def sign_nonce(self, nonce_hex: str) -> str:
        """Sign the raw challenge bytes — not an envelope, the nonce itself."""
        return self.key.sign(bytes.fromhex(nonce_hex)).hex()

    def verify_command(self, core_pubkey_hex: str, frame: dict) -> bool:
        """A real daemon verifies core's signature over the envelope before it
        acts; the fake proves the hub signed with core's key."""
        return envelopes.verify(core_pubkey_hex, frame["envelope"], frame["sig"])

    @staticmethod
    def result(
        envelope: dict,
        *,
        ok: bool = True,
        output: str = "",
        exit_code: int | None = 0,
        error: str | None = None,
    ) -> dict:
        return {
            "type": "result",
            "envelope_id": envelope["envelope_id"],
            "ok": ok,
            "output": output,
            "exit_code": exit_code,
            "error": error,
        }

    # -- the full protocol (grown for T5) -----------------------------------

    async def handshake(self, conn: FakeWSConn) -> dict:
        """Drive `serve()`'s challenge -> auth -> ready over `conn` and return
        the `ready` frame.

        Pins `core_pubkey_hex` from the challenge (a real daemon TOFU-pins it),
        then signs the RAW nonce with its own key and sends the `auth` frame —
        so reaching `ready` proves the socket authenticated BY KEY, never by any
        exemption. Requires `device_id` (set it from the enroll result first).
        """
        challenge = await conn.next_sent()
        assert challenge["type"] == "challenge", challenge
        self.core_pubkey_hex = challenge["core_pubkey"]
        if self.device_id is None:
            raise AssertionError("set device_id from the enroll result before the handshake")
        conn.feed(
            {
                "type": "auth",
                "device_id": str(self.device_id),
                "sig": self.sign_nonce(challenge["nonce"]),
            }
        )
        return await conn.next_sent()

    def _audit_entry(
        self, envelope: dict, *, ok: bool, exit_code: int | None, summary: str
    ) -> dict:
        """The next hash-chained entry for a command, advancing the device's own
        chain. The hash is `devices_ws.chain_hash` — the exact recipe the
        ingester recomputes — so a real (not fabricated) chain is what core
        stores and verifies."""
        without = {
            "seq": self._seq,
            "prev_hash": self._prev_hash,
            "ts": int(time.time()),
            "envelope_id": envelope["envelope_id"],
            "capability": envelope["capability"],
            "summary": summary,
            "ok": bool(ok),
            "exit_code": exit_code,
        }
        entry = {**without, "hash": devices_ws.chain_hash(self._prev_hash, without)}
        self._seq += 1
        self._prev_hash = entry["hash"]
        self.audit_log.append(entry)
        return entry

    async def answer_command(
        self,
        conn: FakeWSConn,
        *,
        ok: bool = True,
        output: str = "",
        exit_code: int | None = 0,
        error: str | None = None,
        summary: str = "ok",
        emit_audit: bool = True,
    ) -> dict:
        """Await the next `command` frame, VERIFY core's signature over the
        envelope, feed back the `result`, and append a valid hash-chained
        `audit` entry for it — then return the command frame so the caller can
        assert the envelope crossed the wire signed.

        The verify is the honesty: a real daemon acts on bytes core signed, not
        on the wire's say-so, so a signature that does not verify raises here
        rather than being rubber-stamped. Only call while the socket is
        authenticated (after `handshake`), so `core_pubkey_hex` is pinned."""
        frame = await conn.next_sent()
        assert frame["type"] == "command", frame
        if self.core_pubkey_hex is None:
            raise AssertionError("answer_command before handshake — no core key pinned to verify")
        if not self.verify_command(self.core_pubkey_hex, frame):
            raise AssertionError("core's signature did not verify — the device refuses to act")
        envelope = frame["envelope"]
        conn.feed(self.result(envelope, ok=ok, output=output, exit_code=exit_code, error=error))
        if emit_audit:
            conn.feed(
                {
                    "type": "audit",
                    "entries": [
                        self._audit_entry(envelope, ok=ok, exit_code=exit_code, summary=summary)
                    ],
                }
            )
        return frame

    def broken_audit_entry(
        self,
        envelope: dict,
        *,
        ok: bool = True,
        exit_code: int | None = 0,
        summary: str = "tampered",
    ) -> dict:
        """An audit entry at the device's NEXT seq whose prev_hash cannot join
        the stored chain — for asserting the ingester writes a
        `device.audit_break` and stores nothing past it. Its own hash is
        internally consistent (so it fails on the prev_hash link, not the
        recompute), and it does NOT advance the honest chain (audit_log/_seq/
        _prev_hash are left untouched)."""
        without = {
            "seq": self._seq,
            "prev_hash": "deadbeef",
            "ts": int(time.time()),
            "envelope_id": envelope["envelope_id"],
            "capability": envelope["capability"],
            "summary": summary,
            "ok": bool(ok),
            "exit_code": exit_code,
        }
        return {**without, "hash": devices_ws.chain_hash("deadbeef", without)}
