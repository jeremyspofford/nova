"""In-process fakes for the device WS hub, so the protocol is testable with no
socket.

`FakeWSConn` is the connection abstraction the hub speaks to: `send` records
every frame core puts on the wire (a deny leaving ZERO frames is asserted off
`sent`), `receive` yields frames the test feeds, and `close` records the close
code. It is the same shape the real `devices_ws.WebSocketConn` adapter wraps a
Starlette WebSocket in, so a test drives `devices_ws.serve` against this exactly
as a real daemon would drive the route.

`FakeDevice` is the other half: a keypair plus the challenge->auth->result
protocol a real novad performs. T5 grows this into the full fake device that
walks enroll -> command -> audit; this is the seed with just enough to
authenticate and answer commands.
"""
from __future__ import annotations

import asyncio
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
    `command_result` builds the `result` frame a daemon returns for a command.
    """

    key: ed25519.Ed25519PrivateKey = field(
        default_factory=ed25519.Ed25519PrivateKey.generate
    )

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
