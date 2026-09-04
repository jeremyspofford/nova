"""The command envelope: canonical bytes, an ed25519 signature, and the
committed vectors both languages assert.

Deliberately DB-free. These are the bytes a Go daemon on another machine will
re-derive and verify, so the one suite that pins them must not be skippable
because postgres was not reachable — `tests/fixtures/envelope_vectors.json` is
the contract between services/core/app/envelopes.py and apps/novad's
internal/wire, and a changed byte has to redden something everywhere.

What is pinned here:

  * canonical() is THE canonical JSON of this service (sorted keys, tight
    separators, default=str, ensure_ascii), pinned against the committed
    vectors alone — no second canonicalizer exists for it to agree with;
  * a signature is over those exact bytes, so reordering keys changes nothing
    and changing any value changes everything;
  * verify() answers False for tampering and for malformed input — it never
    raises, because a caller that has to wrap it in try/except will eventually
    forget to, and a crash is not a refusal;
  * build() emits epoch-SECOND integers, not isoformat strings: the daemon
    reads issued_at/expires_at as int64.
"""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric import ed25519

from app import envelopes

VECTORS_PATH = Path(__file__).parent / "fixtures" / "envelope_vectors.json"


def _vectors() -> dict:
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


# -- canonical bytes ---------------------------------------------------


def test_canonical_hashes_to_the_committed_vectors_bytes():
    """The one canonical-JSON in this service, pinned to the committed vectors
    alone: hashing what canonical() emits for each vector's payload equals
    hashing the vector's committed canonical string. A separators/sort change
    in canonical() reddens this before any device silently refuses everything."""
    for vector in _vectors()["vectors"]:
        ours = hashlib.sha256(envelopes.canonical(vector["payload"])).hexdigest()
        committed = hashlib.sha256(vector["canonical"].encode("utf-8")).hexdigest()
        assert ours == committed, vector["note"]


def test_canonical_is_key_order_independent():
    scrambled = {"c": 3, "a": 1, "b": 2}
    sorted_form = {"a": 1, "b": 2, "c": 3}
    assert envelopes.canonical(scrambled) == envelopes.canonical(sorted_form)
    assert envelopes.canonical(scrambled) == b'{"a":1,"b":2,"c":3}'


def test_canonical_has_no_incidental_whitespace():
    assert envelopes.canonical({"a": 1, "b": [1, 2]}) == b'{"a":1,"b":[1,2]}'


def test_canonical_escapes_non_ascii_and_leaves_html_alone():
    """The two known python/Go divergences, pinned in bytes: python escapes
    non-ASCII (ensure_ascii) and does NOT escape <>& ; Go's encoding/json does
    the exact opposite by default. The daemon has to match THESE bytes."""
    out = envelopes.canonical({"s": "café <b>&"})
    assert out == b'{"s":"caf\\u00e9 <b>&"}'


def test_canonical_stringifies_what_json_cannot_carry():
    """default=str, same as args_hash: a uuid or a datetime in args must not
    explode at signing time — it serializes as its string form."""
    device = uuid.UUID("00000000-0000-0000-0000-0000000000ab")
    assert envelopes.canonical({"d": device}) == b'{"d":"' + str(device).encode() + b'"}'


# -- sign / verify -----------------------------------------------------


def test_sign_then_verify_round_trips():
    key = ed25519.Ed25519PrivateKey.generate()
    pub = key.public_key().public_bytes_raw().hex()
    payload = {"capability": "system.info", "args": {}}
    sig = envelopes.sign(key, payload)
    assert envelopes.verify(pub, payload, sig) is True


def test_a_signature_survives_key_reordering_because_it_signs_canonical_bytes():
    key = ed25519.Ed25519PrivateKey.generate()
    pub = key.public_key().public_bytes_raw().hex()
    sig = envelopes.sign(key, {"a": 1, "b": 2})
    assert envelopes.verify(pub, {"b": 2, "a": 1}, sig) is True


def test_a_tampered_payload_fails_verification():
    key = ed25519.Ed25519PrivateKey.generate()
    pub = key.public_key().public_bytes_raw().hex()
    sig = envelopes.sign(key, {"capability": "fs.read", "args": {"path": "/etc/hosts"}})
    tampered = {"capability": "fs.read", "args": {"path": "/etc/shadow"}}
    assert envelopes.verify(pub, tampered, sig) is False


def test_another_keys_signature_fails_verification():
    signer = ed25519.Ed25519PrivateKey.generate()
    other = ed25519.Ed25519PrivateKey.generate()
    payload = {"a": 1}
    sig = envelopes.sign(signer, payload)
    assert envelopes.verify(other.public_key().public_bytes_raw().hex(), payload, sig) is False


def test_verify_refuses_malformed_input_instead_of_raising():
    key = ed25519.Ed25519PrivateKey.generate()
    pub = key.public_key().public_bytes_raw().hex()
    payload = {"a": 1}
    sig = envelopes.sign(key, payload)

    assert envelopes.verify("not-hex", payload, sig) is False
    assert envelopes.verify("aabb", payload, sig) is False  # right alphabet, wrong length
    assert envelopes.verify("", payload, sig) is False
    assert envelopes.verify(pub, payload, "not-hex") is False
    assert envelopes.verify(pub, payload, "") is False


# -- build -------------------------------------------------------------


def test_build_emits_epoch_second_integers_not_isoformat():
    """Go reads these as int64. An isoformat string here is a cross-language
    break that would only show up on the device."""
    before = int(time.time())
    env = envelopes.build("dev-1", "system.info", {}, ttl_seconds=60)
    after = int(time.time())

    assert env["v"] == 1
    assert isinstance(env["issued_at"], int)
    assert isinstance(env["expires_at"], int)
    assert before <= env["issued_at"] <= after
    assert env["expires_at"] == env["issued_at"] + 60


def test_build_carries_the_call_and_a_fresh_one_use_id():
    env = envelopes.build("dev-1", "fs.read", {"path": "/tmp/a"})
    assert env["device_id"] == "dev-1"
    assert env["capability"] == "fs.read"
    assert env["args"] == {"path": "/tmp/a"}
    # envelope_id is the daemon's one-use key: it must be a fresh uuid string
    # every call, never reused, and never a non-string Go has to guess at.
    assert isinstance(env["envelope_id"], str)
    uuid.UUID(env["envelope_id"])
    assert envelopes.build("dev-1", "fs.read", {})["envelope_id"] != env["envelope_id"]


def test_build_stringifies_a_uuid_device_id():
    device_id = uuid.uuid4()
    assert envelopes.build(device_id, "system.info", {})["device_id"] == str(device_id)


def test_build_has_exactly_the_wire_fields():
    """The daemon decodes this into a struct. An extra field silently added
    here is a field the device ignores while core believes it was honoured."""
    assert set(envelopes.build("d", "system.info", {})) == {
        "v",
        "envelope_id",
        "device_id",
        "capability",
        "args",
        "issued_at",
        "expires_at",
    }


def test_a_built_envelope_signs_and_verifies_whole():
    key = ed25519.Ed25519PrivateKey.generate()
    env = envelopes.build("dev-1", "shell.exec", {"argv": ["echo", "hi"]})
    sig = envelopes.sign(key, env)
    assert envelopes.verify(key.public_key().public_bytes_raw().hex(), env, sig) is True


# -- the committed cross-language vectors ------------------------------


def test_the_vectors_public_key_is_the_seeds_public_key():
    data = _vectors()
    key = ed25519.Ed25519PrivateKey.from_private_bytes(bytes.fromhex(data["seed_hex"]))
    assert key.public_key().public_bytes_raw().hex() == data["public_key_hex"]


def test_every_vector_canonicalizes_and_signs_to_the_committed_bytes():
    """The cross-language pin. apps/novad's Go suite asserts the SAME file: if
    either implementation drifts a byte, both suites go red rather than one
    machine silently refusing every command the other signs."""
    data = _vectors()
    key = ed25519.Ed25519PrivateKey.from_private_bytes(bytes.fromhex(data["seed_hex"]))
    assert len(data["vectors"]) >= 3

    for vector in data["vectors"]:
        payload = vector["payload"]
        assert envelopes.canonical(payload).decode("utf-8") == vector["canonical"]
        # ed25519 is deterministic, so the signature is a fixed string too.
        assert envelopes.sign(key, payload) == vector["sig_hex"]
        assert envelopes.verify(data["public_key_hex"], payload, vector["sig_hex"]) is True


def test_the_vectors_cover_the_cases_that_break_interop():
    """Empty args, non-ASCII + HTML-ish text, and a key-order-scrambled
    payload. The third is the one that proves canonicalization happened: its
    committed canonical bytes are NOT the order the payload is written in."""
    vectors = _vectors()["vectors"]
    assert vectors[0]["payload"]["args"] == {}

    unicode_canonical = vectors[1]["canonical"]
    assert "\\u00" in unicode_canonical  # non-ASCII escaped, as python does
    assert "<" in unicode_canonical  # angle brackets NOT escaped
    assert "\\u003c" not in unicode_canonical  # ...which is what Go does by default

    scrambled = vectors[2]
    assert list(scrambled["payload"]) != sorted(scrambled["payload"])
    assert scrambled["canonical"].startswith('{"args":')
