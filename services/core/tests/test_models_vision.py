"""S28 — the list Settings offers when he picks a vision model.

Derived from the same catalogue and the same helper the TURN uses, so the
set he chooses from and the set she picks within cannot disagree. A page
that built its own list would offer him a model the turn then declined.
"""

from __future__ import annotations

from tests import fakes
from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db


def _row(model: str, *caps: str, installed: bool = True) -> dict:
    return {
        "id": f"ollama:{model}",
        "installed": installed,
        "capabilities": {c: {"value": True} for c in caps},
    }


async def test_only_installed_models_that_report_vision_are_offered(owner_client, mount_peers):
    mount_peers(
        gateway=FakeGateway(
            catalog_body={
                "rows": [
                    _row("qwen3:8b", "completion", "tools"),
                    _row("gemma4:12b", "completion", "vision"),
                    _row("llava:34b", "vision", installed=False),
                ]
            }
        )
    )

    resp = await owner_client.get("/api/v1/models/vision")

    assert resp.status_code == 200, resp.text
    # Without the catalogue's prefix: this is what the settings row holds and
    # what a person reads.
    assert resp.json()["models"] == ["gemma4:12b"]
    assert "reason" not in resp.json()


async def test_a_box_with_nothing_that_can_see_offers_nothing(owner_client, mount_peers):
    mount_peers(gateway=FakeGateway(catalog_body={"rows": [_row("qwen3:8b", "completion")]}))

    resp = await owner_client.get("/api/v1/models/vision")

    assert resp.json() == {"models": []}


async def test_an_unreadable_catalogue_says_so_rather_than_reading_as_none(
    owner_client, mount_peers
):
    """An empty list and an unreadable catalogue are different facts. Without
    the reason the page would render "no model here can see images" for a
    request that simply failed — the same defect the live walk found in the
    turn itself."""
    mount_peers(gateway=FakeGateway(catalog_body={"fetched_at": "now"}))

    body = (await owner_client.get("/api/v1/models/vision")).json()

    assert body["models"] == []
    assert "could not be read" in body["reason"]


async def test_the_list_needs_a_session(client):
    assert (await client.get("/api/v1/models/vision")).status_code == 401
