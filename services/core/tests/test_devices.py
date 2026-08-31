"""The device registry: key custody, pairing codes, enrollment, grants, revoke.

Everything a paired machine is allowed to be is a row in this database, read
live. The pins here are the ones that would let a machine act when it should
not:

  * a pairing code is burned by ONE SQL UPDATE whose WHERE clause is the whole
    check (the consents.validate_and_use idiom) — expired, reused and unknown
    codes are refused by the statement, not by a branch above it;
  * a fresh device gets `["system.info"]` and NOTHING else, from the column
    default, so forgetting to pass capabilities cannot widen a grant;
  * grants only ever hold names from the known set, and fs_roots only absolute
    paths — the model never edits these, but the operator API does, and a typo
    that silently became a grant would be invisible;
  * revoking is final for that record: rename and grants refuse, get_live goes
    None (which is how T2's hub refuses a revoked device's socket), and the
    burned pairing code cannot be spent again to walk back in.

The API half of this file (further down) additionally pins that enroll is the
ONE route in core reachable without an identity, and that it is rate-limited.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime

import asyncpg
import pytest

from app import devices, envelopes
from app.identity import Person
from tests.conftest import requires_db

pytestmark = requires_db

PUBKEY_A = "a" * 64
PUBKEY_B = "b" * 64


async def _owner(pool) -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )
    return Person(id=pid, name="jeremy", role="owner")


async def _enrolled(pool, person, *, name="laptop", pubkey=PUBKEY_A) -> dict:
    minted = await devices.mint_pairing_code(pool, created_by=person.id)
    return await devices.enroll(
        pool,
        code=minted["code"],
        pubkey=pubkey,
        name=name,
        platform="linux",
        hostname="thinkpad",
    )


async def _events(pool, kind: str) -> list:
    return await pool.fetch(
        "SELECT actor, subject_ref, meta FROM governance_events WHERE kind = $1 "
        "ORDER BY created_at",
        kind,
    )


# -- core's signing key ------------------------------------------------


async def test_the_signing_key_is_created_once_and_then_read(pool):
    """Every enrolled device pins this key at pairing. Regenerating it would
    silently invalidate every command core ever signs again, so it is created
    exactly once and read forever after."""
    await pool.execute("DELETE FROM core_signing_key")

    first = await devices.signing_key(pool)
    second = await devices.signing_key(pool)

    assert first.private_bytes_raw() == second.private_bytes_raw()
    assert await pool.fetchval("SELECT count(*) FROM core_signing_key") == 1


async def test_concurrent_first_calls_converge_on_one_key(pool):
    """Two requests can race the very first call. ON CONFLICT DO NOTHING plus a
    re-read means the loser adopts the winner's key instead of handing out a
    key that is not in the database."""
    await pool.execute("DELETE FROM core_signing_key")

    keys = await asyncio.gather(*(devices.signing_key(pool) for _ in range(8)))

    assert len({k.private_bytes_raw() for k in keys}) == 1
    assert await pool.fetchval("SELECT count(*) FROM core_signing_key") == 1


async def test_the_public_key_belongs_to_the_stored_private_key(pool):
    """What a device pins at pairing must verify what core signs afterwards."""
    public_hex = await devices.core_public_key_hex(pool)
    key = await devices.signing_key(pool)
    payload = envelopes.build("dev", "system.info", {})
    assert envelopes.verify(public_hex, payload, envelopes.sign(key, payload)) is True


async def test_the_single_row_check_refuses_a_second_key(pool):
    """A second key row would mean two answers to "which key is core's". The
    CHECK (id = 1) makes that unrepresentable, not merely unwritten."""
    await devices.signing_key(pool)
    with pytest.raises(asyncpg.exceptions.CheckViolationError):
        await pool.execute(
            "INSERT INTO core_signing_key (id, private_key_hex) VALUES (2, $1)", "ff" * 32
        )


# -- pairing codes -----------------------------------------------------


async def test_a_minted_code_is_shown_once_and_stored_only_hashed(pool):
    person = await _owner(pool)
    minted = await devices.mint_pairing_code(pool, created_by=person.id)

    assert len(minted["code"]) == devices.PAIRING_CODE_LENGTH
    assert set(minted["code"]) <= set(devices.PAIRING_CODE_ALPHABET)
    # No lookalikes: an operator retyping this off a screen must not have to
    # decide between O and 0 or l and 1.
    assert not (set(devices.PAIRING_CODE_ALPHABET) & set("O01ILl"))

    stored = await pool.fetchrow("SELECT code_hash, created_by, used_at FROM pairing_codes")
    assert stored["code_hash"] == devices.hash_code(minted["code"])
    assert minted["code"] not in stored["code_hash"]
    assert stored["created_by"] == person.id
    assert stored["used_at"] is None


async def test_a_minted_code_expires_within_the_stated_window(pool):
    person = await _owner(pool)
    minted = await devices.mint_pairing_code(pool, created_by=person.id)
    remaining = await pool.fetchval(
        "SELECT EXTRACT(EPOCH FROM (expires_at - now())) FROM pairing_codes"
    )
    assert 0 < remaining <= devices.PAIRING_CODE_TTL_SECONDS
    # The operator is shown a deadline, so it crosses the wire as a parseable
    # timestamp rather than "10 minutes" the UI has to guess the origin of.
    assert datetime.fromisoformat(minted["expires_at"]).tzinfo is not None


# -- enrollment --------------------------------------------------------


async def test_enroll_binds_the_pubkey_and_returns_cores_own_key(pool):
    """TOFU, both directions, in one exchange: core learns the device's key and
    the device learns core's."""
    person = await _owner(pool)
    result = await _enrolled(pool, person)

    assert result["name"] == "laptop"
    assert result["core_pubkey"] == await devices.core_public_key_hex(pool)
    row = await devices.get(pool, uuid.UUID(result["device_id"]))
    assert row["pubkey"] == PUBKEY_A
    assert row["platform"] == "linux"
    assert row["hostname"] == "thinkpad"
    assert row["owner_person"] == person.id
    assert row["revoked_at"] is None
    assert row["last_seen"] is None


async def test_a_fresh_device_may_only_report_system_info(pool):
    """The roadmap's default grant. It comes from the column default, so a
    caller that forgets to pass capabilities cannot accidentally widen it."""
    person = await _owner(pool)
    result = await _enrolled(pool, person)
    row = await devices.get(pool, uuid.UUID(result["device_id"]))
    assert row["capabilities"] == ["system.info"]
    assert row["fs_roots"] == []


async def test_enrollment_burns_the_code_and_records_who_authorised_it(pool):
    person = await _owner(pool)
    result = await _enrolled(pool, person)

    assert await pool.fetchval("SELECT used_at IS NOT NULL FROM pairing_codes") is True
    events = await _events(pool, "device.enrolled")
    assert len(events) == 1
    # The actor is the person who MINTED the code — the enrolling caller has no
    # identity at all, so the only authorisation in the arc is the mint.
    assert events[0]["actor"] == str(person.id)
    assert str(events[0]["subject_ref"]) == result["device_id"]
    assert events[0]["meta"]["name"] == "laptop"
    assert events[0]["meta"]["pubkey"] == PUBKEY_A


async def test_a_reused_code_is_refused(pool):
    person = await _owner(pool)
    minted = await devices.mint_pairing_code(pool, created_by=person.id)
    await devices.enroll(
        pool, code=minted["code"], pubkey=PUBKEY_A, name="one", platform="linux", hostname="h"
    )

    with pytest.raises(devices.DeviceRefused):
        await devices.enroll(
            pool, code=minted["code"], pubkey=PUBKEY_B, name="two", platform="linux", hostname="h"
        )
    assert await pool.fetchval("SELECT count(*) FROM devices") == 1


async def test_an_expired_code_is_refused(pool):
    person = await _owner(pool)
    minted = await devices.mint_pairing_code(pool, created_by=person.id)
    await pool.execute("UPDATE pairing_codes SET expires_at = now() - interval '1 second'")

    with pytest.raises(devices.DeviceRefused):
        await devices.enroll(
            pool, code=minted["code"], pubkey=PUBKEY_A, name="x", platform="linux", hostname="h"
        )
    assert await pool.fetchval("SELECT count(*) FROM devices") == 0
    assert await pool.fetchval("SELECT used_at IS NULL FROM pairing_codes") is True


async def test_an_unknown_code_is_refused(pool):
    with pytest.raises(devices.DeviceRefused):
        await devices.enroll(
            pool, code="ZZZZZZZZ", pubkey=PUBKEY_A, name="x", platform="linux", hostname="h"
        )
    assert await pool.fetchval("SELECT count(*) FROM devices") == 0


async def test_a_code_is_accepted_however_the_operator_retypes_it(pool):
    """It is read off a screen and typed into a terminal. Case and the spaces a
    human adds are noise; the code itself is what must match."""
    person = await _owner(pool)
    minted = await devices.mint_pairing_code(pool, created_by=person.id)
    typed = f" {minted['code'].lower()} "

    result = await devices.enroll(
        pool, code=typed, pubkey=PUBKEY_A, name="x", platform="linux", hostname="h"
    )
    assert result["device_id"]


async def test_a_pubkey_that_is_not_32_raw_bytes_of_hex_is_refused(pool):
    person = await _owner(pool)
    for bad in ("", "xyz", "a" * 63, "a" * 65, "g" * 64, "A" * 63 + "!"):
        minted = await devices.mint_pairing_code(pool, created_by=person.id)
        with pytest.raises(devices.DeviceRefused):
            await devices.enroll(
                pool, code=minted["code"], pubkey=bad, name="x", platform="linux", hostname="h"
            )
    assert await pool.fetchval("SELECT count(*) FROM devices") == 0
    # A refused pubkey must not spend the code — the operator retries with the
    # same one.
    assert await pool.fetchval("SELECT count(*) FROM pairing_codes WHERE used_at IS NULL") == 6


async def test_an_uppercase_pubkey_is_stored_lowercase(pool):
    """The daemon and core compare these as strings. One case, decided here."""
    person = await _owner(pool)
    result = await _enrolled(pool, person, pubkey="AB" * 32)
    row = await devices.get(pool, uuid.UUID(result["device_id"]))
    assert row["pubkey"] == "ab" * 32


async def test_a_nameless_device_is_refused(pool):
    person = await _owner(pool)
    minted = await devices.mint_pairing_code(pool, created_by=person.id)
    with pytest.raises(devices.DeviceRefused):
        await devices.enroll(
            pool, code=minted["code"], pubkey=PUBKEY_A, name="   ", platform="linux", hostname="h"
        )


async def test_two_live_devices_cannot_share_a_name(pool):
    """The name is how the model and the operator address a machine ("read the
    file on laptop"). Two answers to that is an ambiguity no prose can fix."""
    person = await _owner(pool)
    await _enrolled(pool, person, name="laptop")
    minted = await devices.mint_pairing_code(pool, created_by=person.id)

    with pytest.raises(devices.DeviceRefused):
        await devices.enroll(
            pool,
            code=minted["code"],
            pubkey=PUBKEY_B,
            name="laptop",
            platform="linux",
            hostname="h",
        )
    assert await pool.fetchval("SELECT count(*) FROM devices") == 1
    # The name collision rolled the whole enrollment back, code included — the
    # operator retries with a different name and the same code.
    assert await pool.fetchval("SELECT count(*) FROM pairing_codes WHERE used_at IS NULL") == 1


async def test_revoking_frees_the_name_for_a_re_pairing(pool):
    """Reinstalling a laptop should not force it to be called laptop-2 forever.
    The unique index is partial on revoked_at IS NULL for exactly this."""
    person = await _owner(pool)
    first = await _enrolled(pool, person, name="laptop")
    await devices.revoke(pool, device_id=uuid.UUID(first["device_id"]), actor=str(person.id))

    second = await _enrolled(pool, person, name="laptop", pubkey=PUBKEY_B)
    assert second["device_id"] != first["device_id"]


# -- lookups -----------------------------------------------------------


async def test_get_live_stops_answering_once_a_device_is_revoked(pool):
    """This is the lookup T2's hub authenticates a socket against: a revoked
    device is not a device you can connect as, and the refusal is the absence
    of a row rather than a flag someone has to remember to read."""
    person = await _owner(pool)
    enrolled = await _enrolled(pool, person, name="laptop")
    device_id = uuid.UUID(enrolled["device_id"])

    assert await devices.get_live(pool, device_id) is not None
    assert await devices.get_live_by_name(pool, "laptop") is not None

    await devices.revoke(pool, device_id=device_id, actor=str(person.id))

    assert await devices.get_live(pool, device_id) is None
    assert await devices.get_live_by_name(pool, "laptop") is None
    # The record itself survives — the audit trail must not vanish with it.
    assert await devices.get(pool, device_id) is not None


async def test_listing_reports_the_stored_state_and_never_a_fake_green(pool):
    person = await _owner(pool)
    await _enrolled(pool, person, name="laptop")

    listed = await devices.list_devices(pool)
    assert len(listed) == 1
    spec = listed[0]
    assert spec["name"] == "laptop"
    assert spec["capabilities"] == ["system.info"]
    assert spec["fs_roots"] == []
    assert spec["revoked_at"] is None
    # A device that has never been seen says so. T4 renders "never", not a dot.
    assert spec["last_seen"] is None
    # T2's hub owns this field; while no hub exists, nothing is connected and
    # false is the truth rather than a placeholder.
    assert spec["connected"] is False
    assert set(spec) == {
        "id",
        "name",
        "platform",
        "hostname",
        "capabilities",
        "fs_roots",
        "enrolled_at",
        "last_seen",
        "revoked_at",
        "connected",
    }


# -- rename ------------------------------------------------------------


async def test_rename_changes_the_name_and_nothing_else(pool):
    person = await _owner(pool)
    enrolled = await _enrolled(pool, person, name="laptop")
    device_id = uuid.UUID(enrolled["device_id"])

    spec = await devices.rename(pool, device_id=device_id, name="thinkpad")
    assert spec["name"] == "thinkpad"
    row = await devices.get(pool, device_id)
    assert row["pubkey"] == PUBKEY_A
    assert row["capabilities"] == ["system.info"]


async def test_rename_onto_a_live_name_is_refused(pool):
    person = await _owner(pool)
    first = await _enrolled(pool, person, name="laptop")
    await _enrolled(pool, person, name="desktop", pubkey=PUBKEY_B)

    with pytest.raises(devices.DeviceRefused):
        await devices.rename(pool, device_id=uuid.UUID(first["device_id"]), name="desktop")


async def test_renaming_an_unknown_device_is_refused(pool):
    with pytest.raises(devices.DeviceRefused):
        await devices.rename(pool, device_id=uuid.uuid4(), name="ghost")


# -- grants ------------------------------------------------------------


async def test_grants_are_stored_and_recorded_with_the_before_and_after(pool):
    person = await _owner(pool)
    enrolled = await _enrolled(pool, person, name="laptop")
    device_id = uuid.UUID(enrolled["device_id"])

    spec = await devices.set_grants(
        pool,
        device_id=device_id,
        capabilities=["fs.read", "system.info"],
        fs_roots=["/home/jeremy/notes"],
        actor=str(person.id),
    )
    assert spec["capabilities"] == ["fs.read", "system.info"]
    assert spec["fs_roots"] == ["/home/jeremy/notes"]

    events = await _events(pool, "device.grants_changed")
    assert len(events) == 1
    assert events[0]["actor"] == str(person.id)
    assert events[0]["meta"]["before"] == {"capabilities": ["system.info"], "fs_roots": []}
    assert events[0]["meta"]["after"] == {
        "capabilities": ["fs.read", "system.info"],
        "fs_roots": ["/home/jeremy/notes"],
    }


async def test_capabilities_are_stored_sorted_and_deduplicated(pool):
    """So a before/after diff in the ledger is about what changed, not about
    the order the checkboxes were clicked in."""
    person = await _owner(pool)
    enrolled = await _enrolled(pool, person)
    spec = await devices.set_grants(
        pool,
        device_id=uuid.UUID(enrolled["device_id"]),
        capabilities=["fs.read", "system.info", "fs.read"],
        fs_roots=[],
        actor=str(person.id),
    )
    assert spec["capabilities"] == ["fs.read", "system.info"]


async def test_an_unknown_capability_name_is_refused(pool):
    """A typo'd grant is worse than a missing one: it looks granted in the UI
    and refuses forever at the device, with nothing naming the typo."""
    person = await _owner(pool)
    enrolled = await _enrolled(pool, person)
    device_id = uuid.UUID(enrolled["device_id"])

    with pytest.raises(devices.DeviceRefused) as excinfo:
        await devices.set_grants(
            pool,
            device_id=device_id,
            capabilities=["fs.raed"],
            fs_roots=[],
            actor=str(person.id),
        )
    assert "fs.raed" in excinfo.value.reason
    row = await devices.get(pool, device_id)
    assert row["capabilities"] == ["system.info"]
    assert await _events(pool, "device.grants_changed") == []


async def test_the_known_capability_set_is_exactly_the_slice_five_names(pool):
    """Eight capabilities behind T2's nine tools (device_list reads core's own
    database and needs no capability at all). Moving this set is a two-sided
    change — core signs for it, the daemon has code for it — so it is pinned
    rather than left to drift."""
    assert devices.KNOWN_CAPABILITIES == frozenset(
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


async def test_a_relative_or_traversing_fs_root_is_refused(pool):
    """fs_roots is a prefix check at call time (T2). A relative path or one
    containing .. makes that check meaningless."""
    person = await _owner(pool)
    enrolled = await _enrolled(pool, person)
    device_id = uuid.UUID(enrolled["device_id"])

    for bad in ("home/jeremy", "", "/home/jeremy/../../etc", "~/notes"):
        with pytest.raises(devices.DeviceRefused):
            await devices.set_grants(
                pool,
                device_id=device_id,
                capabilities=["fs.read"],
                fs_roots=[bad],
                actor=str(person.id),
            )
    row = await devices.get(pool, device_id)
    assert row["fs_roots"] == []


async def test_setting_grants_on_an_unknown_device_is_refused(pool):
    with pytest.raises(devices.DeviceRefused):
        await devices.set_grants(
            pool, device_id=uuid.uuid4(), capabilities=[], fs_roots=[], actor="someone"
        )


# -- revoke ------------------------------------------------------------


async def test_revoke_stamps_the_row_and_records_the_event(pool):
    person = await _owner(pool)
    enrolled = await _enrolled(pool, person, name="laptop")
    device_id = uuid.UUID(enrolled["device_id"])

    spec = await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    assert spec["revoked_at"] is not None

    events = await _events(pool, "device.revoked")
    assert len(events) == 1
    assert events[0]["actor"] == str(person.id)
    assert str(events[0]["subject_ref"]) == enrolled["device_id"]
    assert events[0]["meta"]["name"] == "laptop"


async def test_a_revoked_device_refuses_rename_and_grants(pool):
    person = await _owner(pool)
    enrolled = await _enrolled(pool, person)
    device_id = uuid.UUID(enrolled["device_id"])
    await devices.revoke(pool, device_id=device_id, actor=str(person.id))

    with pytest.raises(devices.DeviceRefused):
        await devices.rename(pool, device_id=device_id, name="zombie")
    with pytest.raises(devices.DeviceRefused):
        await devices.set_grants(
            pool,
            device_id=device_id,
            capabilities=["shell.exec"],
            fs_roots=[],
            actor=str(person.id),
        )
    row = await devices.get(pool, device_id)
    assert row["capabilities"] == ["system.info"]


async def test_revoking_twice_is_refused_rather_than_reported_as_done(pool):
    """The second call changed nothing. Saying "revoked" anyway would put a
    second event in the ledger for an act that did not happen."""
    person = await _owner(pool)
    enrolled = await _enrolled(pool, person)
    device_id = uuid.UUID(enrolled["device_id"])
    await devices.revoke(pool, device_id=device_id, actor=str(person.id))

    with pytest.raises(devices.DeviceRefused):
        await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    assert len(await _events(pool, "device.revoked")) == 1


async def test_revoking_an_unknown_device_is_refused(pool):
    with pytest.raises(devices.DeviceRefused):
        await devices.revoke(pool, device_id=uuid.uuid4(), actor="someone")


async def test_a_revoked_devices_burned_code_cannot_walk_back_in(pool):
    """Revoke has to survive the daemon still holding its key and its code. The
    code was spent at the first enrollment and stays spent."""
    person = await _owner(pool)
    minted = await devices.mint_pairing_code(pool, created_by=person.id)
    enrolled = await devices.enroll(
        pool, code=minted["code"], pubkey=PUBKEY_A, name="laptop", platform="linux", hostname="h"
    )
    await devices.revoke(
        pool, device_id=uuid.UUID(enrolled["device_id"]), actor=str(person.id)
    )

    with pytest.raises(devices.DeviceRefused):
        await devices.enroll(
            pool,
            code=minted["code"],
            pubkey=PUBKEY_A,
            name="laptop",
            platform="linux",
            hostname="h",
        )
    assert await pool.fetchval("SELECT count(*) FROM devices WHERE revoked_at IS NULL") == 0


# ======================================================================
# /api/v1/devices — the operator's routes, and the one public one
# ======================================================================


async def _api_enrol(client, code: str, **overrides) -> object:
    body = {
        "code": code,
        "pubkey": PUBKEY_A,
        "name": "laptop",
        "platform": "linux",
        "hostname": "thinkpad",
    }
    body.update(overrides)
    return await client.post("/api/v1/devices/enroll", json=body)


async def _api_code(owner_client) -> str:
    resp = await owner_client.post("/api/v1/devices/pairing-code")
    assert resp.status_code == 200, resp.text
    return resp.json()["code"]


# -- auth --------------------------------------------------------------


async def test_every_device_route_except_enroll_needs_an_identity(client, pool):
    """Minting a pairing code is the authorisation for an entire machine. If
    that route were reachable without an identity, enrollment being public
    would stop meaning anything."""
    device_id = uuid.uuid4()
    assert (await client.post("/api/v1/devices/pairing-code")).status_code == 401
    assert (await client.get("/api/v1/devices")).status_code == 401
    rename = await client.patch(f"/api/v1/devices/{device_id}", json={"name": "x"})
    assert rename.status_code == 401
    grants = await client.put(
        f"/api/v1/devices/{device_id}/grants", json={"capabilities": [], "fs_roots": []}
    )
    assert grants.status_code == 401
    assert (await client.post(f"/api/v1/devices/{device_id}/revoke")).status_code == 401


async def test_enroll_is_reachable_with_no_identity_at_all(client, pool):
    """The daemon has no cookie and no bearer — the pairing code IS its
    credential. This is the only write in core that works unauthenticated, so
    it is pinned rather than assumed. `client` here carries neither: the
    service bearer is configured in the environment but never sent, and every
    other route on this router answers 401 to it (test above)."""
    person = await _owner(pool)
    minted = await devices.mint_pairing_code(pool, created_by=person.id)

    resp = await _api_enrol(client, minted["code"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["device_id"]


# -- POST /pairing-code -------------------------------------------------


async def test_minting_returns_the_code_once_and_an_expiry(owner_client, pool):
    resp = await owner_client.post("/api/v1/devices/pairing-code")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"code", "expires_at"}
    assert len(body["code"]) == devices.PAIRING_CODE_LENGTH
    assert await pool.fetchval("SELECT count(*) FROM pairing_codes") == 1


# -- POST /enroll ------------------------------------------------------


async def test_enroll_returns_the_device_id_name_and_cores_pubkey(owner_client, pool):
    """The daemon writes core_pubkey to disk and verifies every envelope
    against it from then on, so the response shape is a wire contract."""
    resp = await _api_enrol(owner_client, await _api_code(owner_client))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"device_id", "name", "core_pubkey"}
    assert body["name"] == "laptop"
    assert body["core_pubkey"] == await devices.core_public_key_hex(pool)
    uuid.UUID(body["device_id"])


async def test_enrolling_with_a_used_code_is_a_stated_refusal(owner_client):
    code = await _api_code(owner_client)
    assert (await _api_enrol(owner_client, code)).status_code == 200

    again = await _api_enrol(owner_client, code, name="second", pubkey=PUBKEY_B)
    assert again.status_code == 403
    assert "pairing code" in again.json()["error"]


async def test_enrolling_with_an_expired_code_is_refused(owner_client, pool):
    code = await _api_code(owner_client)
    await pool.execute("UPDATE pairing_codes SET expires_at = now() - interval '1 second'")
    resp = await _api_enrol(owner_client, code)
    assert resp.status_code == 403
    assert await pool.fetchval("SELECT count(*) FROM devices") == 0


async def test_enrolling_a_malformed_pubkey_is_refused_without_spending_the_code(
    owner_client, pool
):
    code = await _api_code(owner_client)
    resp = await _api_enrol(owner_client, code, pubkey="nope")
    assert resp.status_code == 400
    assert "pubkey" in resp.json()["error"]
    assert await pool.fetchval("SELECT used_at IS NULL FROM pairing_codes") is True


async def test_enrolling_a_taken_name_is_a_409(owner_client):
    assert (await _api_enrol(owner_client, await _api_code(owner_client))).status_code == 200
    clash = await _api_enrol(owner_client, await _api_code(owner_client), pubkey=PUBKEY_B)
    assert clash.status_code == 409
    assert "already enrolled" in clash.json()["error"]


async def test_repeated_bad_codes_from_one_address_are_rate_limited(owner_client, pool):
    """Enrollment is the one unauthenticated write in core, so a wrong code has
    to cost something. Only the code refusal counts: a name collision is an
    operator typing a name twice, not somebody guessing."""
    from app import devices_api

    for _ in range(devices_api.MAX_ENROLL_FAILURES):
        assert (await _api_enrol(owner_client, "ZZZZZZZZ")).status_code == 403

    blocked = await _api_enrol(owner_client, "ZZZZZZZZ")
    assert blocked.status_code == 429
    assert "too many" in blocked.json()["error"]

    # A real code is refused too while the window is open — failing closed is
    # the point, and this instance pairs a machine every few months.
    assert (await _api_enrol(owner_client, await _api_code(owner_client))).status_code == 429
    assert await pool.fetchval("SELECT count(*) FROM devices") == 0


async def test_a_successful_enrollment_clears_the_failure_window(owner_client, pool):
    from app import devices_api

    for _ in range(devices_api.MAX_ENROLL_FAILURES - 1):
        assert (await _api_enrol(owner_client, "ZZZZZZZZ")).status_code == 403

    assert (await _api_enrol(owner_client, await _api_code(owner_client))).status_code == 200
    # The window is clear, so the next mistake starts a fresh count instead of
    # tripping the limiter on the operator's second machine.
    assert (await _api_enrol(owner_client, "ZZZZZZZZ", name="two")).status_code == 403


# -- GET /devices ------------------------------------------------------


async def test_listing_is_empty_before_anything_is_paired(owner_client):
    resp = await owner_client.get("/api/v1/devices")
    assert resp.status_code == 200
    assert resp.json() == {"devices": []}


async def test_listing_returns_the_full_tile_shape(owner_client):
    await _api_enrol(owner_client, await _api_code(owner_client))
    resp = await owner_client.get("/api/v1/devices")
    assert resp.status_code == 200
    (device,) = resp.json()["devices"]
    assert device["name"] == "laptop"
    assert device["platform"] == "linux"
    assert device["hostname"] == "thinkpad"
    assert device["capabilities"] == ["system.info"]
    assert device["fs_roots"] == []
    assert device["last_seen"] is None
    assert device["revoked_at"] is None
    assert device["connected"] is False


async def test_a_revoked_device_is_still_listed_and_says_so(owner_client):
    enrolled = (await _api_enrol(owner_client, await _api_code(owner_client))).json()
    await owner_client.post(f"/api/v1/devices/{enrolled['device_id']}/revoke")

    (device,) = (await owner_client.get("/api/v1/devices")).json()["devices"]
    assert device["revoked_at"] is not None


# -- PATCH /{id} -------------------------------------------------------


async def test_rename_returns_the_updated_device(owner_client):
    enrolled = (await _api_enrol(owner_client, await _api_code(owner_client))).json()
    resp = await owner_client.patch(
        f"/api/v1/devices/{enrolled['device_id']}", json={"name": "thinkpad"}
    )
    assert resp.status_code == 200
    assert resp.json()["device"]["name"] == "thinkpad"


async def test_renaming_an_unknown_device_is_a_404(owner_client):
    resp = await owner_client.patch(f"/api/v1/devices/{uuid.uuid4()}", json={"name": "ghost"})
    assert resp.status_code == 404


# -- PUT /{id}/grants --------------------------------------------------


async def test_setting_grants_returns_the_updated_device(owner_client, pool):
    enrolled = (await _api_enrol(owner_client, await _api_code(owner_client))).json()
    resp = await owner_client.put(
        f"/api/v1/devices/{enrolled['device_id']}/grants",
        json={"capabilities": ["system.info", "fs.read"], "fs_roots": ["/home/jeremy/notes"]},
    )
    assert resp.status_code == 200
    device = resp.json()["device"]
    assert device["capabilities"] == ["fs.read", "system.info"]
    assert device["fs_roots"] == ["/home/jeremy/notes"]

    events = await _events(pool, "device.grants_changed")
    assert len(events) == 1
    # The person who clicked it, not "the system".
    me = (await owner_client.get("/api/v1/auth/me")).json()["person"]["id"]
    assert events[0]["actor"] == me


async def test_an_unknown_capability_is_refused_by_name(owner_client, pool):
    enrolled = (await _api_enrol(owner_client, await _api_code(owner_client))).json()
    resp = await owner_client.put(
        f"/api/v1/devices/{enrolled['device_id']}/grants",
        json={"capabilities": ["fs.raed"], "fs_roots": []},
    )
    assert resp.status_code == 400
    assert "fs.raed" in resp.json()["error"]
    row = await devices.get(pool, uuid.UUID(enrolled["device_id"]))
    assert row["capabilities"] == ["system.info"]


async def test_a_relative_fs_root_is_refused(owner_client):
    enrolled = (await _api_enrol(owner_client, await _api_code(owner_client))).json()
    resp = await owner_client.put(
        f"/api/v1/devices/{enrolled['device_id']}/grants",
        json={"capabilities": ["fs.read"], "fs_roots": ["notes"]},
    )
    assert resp.status_code == 400
    assert "absolute" in resp.json()["error"]


# -- POST /{id}/revoke -------------------------------------------------


async def test_revoke_marks_the_device_and_then_refuses_edits(owner_client, pool):
    enrolled = (await _api_enrol(owner_client, await _api_code(owner_client))).json()
    device_id = enrolled["device_id"]

    resp = await owner_client.post(f"/api/v1/devices/{device_id}/revoke")
    assert resp.status_code == 200
    assert resp.json()["device"]["revoked_at"] is not None

    rename = await owner_client.patch(f"/api/v1/devices/{device_id}", json={"name": "zombie"})
    assert rename.status_code == 409
    assert "revoked" in rename.json()["error"]

    grants = await owner_client.put(
        f"/api/v1/devices/{device_id}/grants",
        json={"capabilities": ["shell.exec"], "fs_roots": []},
    )
    assert grants.status_code == 409

    # And it can no longer connect: get_live is what T2's hub authenticates on.
    assert await devices.get_live(pool, uuid.UUID(device_id)) is None


async def test_revoking_twice_is_a_stated_refusal(owner_client):
    enrolled = (await _api_enrol(owner_client, await _api_code(owner_client))).json()
    first = await owner_client.post(f"/api/v1/devices/{enrolled['device_id']}/revoke")
    assert first.status_code == 200
    second = await owner_client.post(f"/api/v1/devices/{enrolled['device_id']}/revoke")
    assert second.status_code == 409


async def test_the_whole_arc_reads_back_off_the_governance_ledger(owner_client, pool):
    """DoD 6: enrolled -> grants_changed -> revoked, in order, off the ledger
    rather than off anything's prose."""
    enrolled = (await _api_enrol(owner_client, await _api_code(owner_client))).json()
    await owner_client.put(
        f"/api/v1/devices/{enrolled['device_id']}/grants",
        json={"capabilities": ["fs.read"], "fs_roots": ["/home/jeremy"]},
    )
    await owner_client.post(f"/api/v1/devices/{enrolled['device_id']}/revoke")

    kinds = [
        r["kind"]
        for r in await pool.fetch(
            "SELECT kind FROM governance_events WHERE subject_ref = $1 ORDER BY created_at",
            uuid.UUID(enrolled["device_id"]),
        )
    ]
    assert kinds == ["device.enrolled", "device.grants_changed", "device.revoked"]
