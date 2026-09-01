"""The command envelope: the only shape in which core may ask a device to act.

A paired machine executes nothing it is merely *told* over a socket. Every
command crosses as `{envelope, sig}`, where the envelope names exactly one
capability call and the signature is core's ed25519 key over its canonical
bytes. The daemon re-derives those bytes and verifies the signature ON THE
DEVICE before it does anything — so a compromised or confused component that
can reach the socket still cannot make a machine run a command, because it
cannot produce the signature. Mechanical over prompts, at the edge.

Three properties this module is responsible for, and one it is not:

  * canonical() is byte-identical to app.consents.args_hash's
    canonicalization (sorted keys, tight separators, default=str). One
    canonical-JSON in this service; a second one would drift and drift
    silently, since a mismatch shows up only as "the device refuses
    everything".
  * sign()/verify() operate on those bytes and nothing else, so key order in
    a dict is irrelevant and any value change invalidates the signature.
    verify() answers False for garbage rather than raising: a refusal is a
    return value here, never an exception a caller might forget to catch.
  * build() stamps issued_at/expires_at as epoch-SECOND INTEGERS. Not
    isoformat — the daemon (Go) reads them as int64, and the only place that
    mismatch would surface is on someone else's machine.

NOT this module's job: expiry, one-use replay defence and the deny-roots
check. Those are the daemon's, deliberately — they must hold even against a
core that has been talked into signing something, and a check that runs where
the key already is proves nothing about the edge.

tests/fixtures/envelope_vectors.json pins all of this across both languages:
the python suite and the Go suite assert the same committed bytes, so a drift
in either implementation reddens both.
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric import ed25519

# The envelope wire version. The daemon refuses a version it does not know
# rather than guessing at fields — bumping this is a deliberate, two-sided
# change.
ENVELOPE_VERSION = 1

# How long a signed command stays usable. Short on purpose: an envelope that
# leaks is only useful inside this window, and a command that took longer than
# a minute to arrive is one the operator has stopped expecting. The daemon
# allows ~120s of clock skew around it (its rule, its clock).
ENVELOPE_TTL_SECONDS = 60


def canonical(payload: dict[str, Any]) -> bytes:
    """The exact bytes that get signed.

    Identical to consents.args_hash's json.dumps arguments, on purpose: this
    service has ONE canonical form for "the same call", and both the consent
    binding and the device envelope must agree on it.

    Two choices here are load-bearing for the Go side and are pinned by the
    committed vectors: `ensure_ascii` stays at its default True (non-ASCII is
    written as \\uXXXX escapes, which Go's encoding/json does NOT do), and
    `<`, `>`, `&` are left as themselves (which Go's encoding/json DOES escape
    unless told not to). The daemon matches these bytes; the bytes do not move
    to suit the daemon.

    Byte-identity holds for every VALID-UTF-8 input. The one exception is a lone
    UTF-16 surrogate: json.dumps preserves it, but Go's json.Unmarshal decodes
    it to U+FFFD, so the daemon would re-derive different bytes. Such input is
    refused fail-closed BEFORE signing (see contains_lone_surrogate, enforced in
    the device-tool funnel), so it never reaches this function on the wire.
    """
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")


def contains_lone_surrogate(value: Any) -> bool:
    """True if `value` — a str, or a dict/list of them — holds a UTF-16 lone
    surrogate: a code point in U+D800..U+DFFF.

    This is the one input where canonical() is NOT byte-identical across the two
    languages. Python's json.dumps preserves a lone surrogate as a `\\udXXX`
    escape, so core would sign those bytes; but Go's json.Unmarshal decodes a
    lone surrogate to U+FFFD, so the daemon re-derives DIFFERENT canonical bytes
    and refuses with a mystery "signature did not verify". A Python str can only
    ever carry a surrogate singly (a valid astral character is a single code
    point outside this range, and there are no pairs inside a str), so any code
    point in the range is a lone surrogate. Scan for it BEFORE signing so the
    refusal names the bad input instead of surfacing as an opaque signature
    failure at the edge — fail-closed, and labelled.
    """
    if isinstance(value, str):
        return any(0xD800 <= ord(ch) <= 0xDFFF for ch in value)
    if isinstance(value, dict):
        return any(
            contains_lone_surrogate(k) or contains_lone_surrogate(v) for k, v in value.items()
        )
    if isinstance(value, (list, tuple)):
        return any(contains_lone_surrogate(item) for item in value)
    return False


def sign(private_key: ed25519.Ed25519PrivateKey, payload: dict[str, Any]) -> str:
    """Sign the canonical bytes of `payload`; returns the hex signature.

    ed25519 is deterministic, so the same payload and key always produce the
    same string — which is what lets a committed fixture pin it."""
    return private_key.sign(canonical(payload)).hex()


def verify(public_key_hex: str, payload: dict[str, Any], sig_hex: str) -> bool:
    """True only when `sig_hex` is this key's signature over these exact bytes.

    Every failure mode — a key that is not hex, a key of the wrong length, a
    signature that is not hex, a signature that simply does not match — is
    False. Never an exception: callers here and in T5's fake device treat this
    as the decision itself, and a decision that can explode is one that gets
    wrapped in a bare `except` and quietly turned into a yes."""
    try:
        key = ed25519.Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key_hex))
        key.verify(bytes.fromhex(sig_hex), canonical(payload))
    except (InvalidSignature, ValueError, TypeError):
        return False
    return True


def build(
    device_id: str | uuid.UUID,
    capability: str,
    args: dict[str, Any],
    ttl_seconds: int = ENVELOPE_TTL_SECONDS,
) -> dict[str, Any]:
    """One command, addressed to one device, valid for a short window.

    `envelope_id` is the daemon's one-use key: it keeps a seen-set spanning the
    validity window and refuses a repeat, so a captured envelope cannot be
    replayed even inside its TTL. `device_id` is stringified because the
    daemon compares it against its own id as a string, and because a uuid is
    not JSON.
    """
    issued_at = int(time.time())
    return {
        "v": ENVELOPE_VERSION,
        "envelope_id": str(uuid.uuid4()),
        "device_id": str(device_id),
        "capability": capability,
        "args": args,
        "issued_at": issued_at,
        "expires_at": issued_at + ttl_seconds,
    }
