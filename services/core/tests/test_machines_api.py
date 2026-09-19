"""S40 — GET/PATCH /api/v1/machines: the Settings tile's surface over the
gateway's engines. The switch answers with what the gateway READS BACK."""

from __future__ import annotations

from tests import fakes
from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db


def _machine(**over) -> dict:
    out = {
        "name": "hub",
        "lifecycle": "always_on",
        "serving": True,
        "state": "ready",
        "reason": None,
        "observed_at": fakes.ENGINE_AT,
        "compute": fakes.ENGINE_GPU,
        "runtime": "container",
        "models": [{"name": "qwen3:8b", "size_bytes": 5_225_388_164}],
    }
    out.update(over)
    return out


async def test_the_tile_lists_every_machine_in_one_shape(owner_client, mount_peers):
    gateway = FakeGateway(engines=[fakes.engine_view()])
    mount_peers(gateway=gateway)
    resp = await owner_client.get("/api/v1/machines")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"machines": [_machine()]}
    assert gateway.queries[-1] == b"live=false"
    await owner_client.get("/api/v1/machines", params={"live": "true"})
    assert gateway.queries[-1] == b"live=true"


async def test_the_switch_answers_with_what_the_gateway_reads_back(owner_client, mount_peers):
    gateway = FakeGateway(engines=[fakes.engine_view()])
    mount_peers(gateway=gateway)
    resp = await owner_client.patch("/api/v1/machines/hub", json={"serving": False})
    assert resp.status_code == 200, resp.text
    assert resp.json() == _machine(serving=False, state="switched_off")
    assert gateway.seen[-2:] == [
        ("/admin/engines/hub", {"serving": False}),
        ("/admin/engines/hub", None),
    ]


async def test_a_switch_that_did_not_stick_is_shown_as_it_reads(owner_client, mount_peers):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()], engine_put_sticks=False))
    resp = await owner_client.patch("/api/v1/machines/hub", json={"serving": False})
    assert resp.status_code == 200 and resp.json()["serving"] is True


async def test_an_unknown_machine_is_a_404_in_the_gateways_words(owner_client, mount_peers):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    resp = await owner_client.patch("/api/v1/machines/dell", json={"serving": False})
    assert resp.status_code == 404 and resp.json() == {"error": "no engine named 'dell'"}


async def test_a_body_without_a_true_or_false_serving_flips_nothing(owner_client, mount_peers):
    gateway = FakeGateway(engines=[fakes.engine_view()])
    mount_peers(gateway=gateway)
    resp = await owner_client.patch("/api/v1/machines/hub", json={})
    assert resp.status_code == 422
    # A string is not a switch position: lax coercion would read "no" as false.
    for wrong in ("no", "false", 0, None):
        resp = await owner_client.patch("/api/v1/machines/hub", json={"serving": wrong})
        assert resp.status_code == 422, wrong
    assert gateway.seen == []


async def test_a_gateway_that_names_no_engines_is_a_stated_502(owner_client, mount_peers):
    mount_peers(gateway=FakeGateway())
    resp = await owner_client.get("/api/v1/machines")
    assert resp.status_code == 502 and "did not name its engines" in resp.json()["error"]


async def test_the_surface_needs_a_session(client):
    assert (await client.get("/api/v1/machines")).status_code == 401
    assert (await client.patch("/api/v1/machines/hub", json={"serving": False})).status_code == 401
