"""S28 — the list Settings offers when he picks a vision model.

Derived from the same catalogue and the same helper the TURN uses, so the
set he chooses from and the set she picks within cannot disagree. A page
that built its own list would offer him a model the turn then declined.
"""

from __future__ import annotations

from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db


def _row(
    model: str, *caps: str, installed: bool = True, provider: str = "ollama", kind: str = "local"
) -> dict:
    # Every key the gateway's catalog_row.base_row publishes that this route
    # reads: id, provider, model, kind.
    return {
        "id": f"{provider}:{model}",
        "provider": provider,
        "model": model,
        "kind": kind,
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


async def test_a_local_row_is_offered_bare_and_a_cloud_row_keeps_its_provider(
    owner_client, mount_peers
):
    """Ruling E6 (S40). The picker writes what this returns into
    chat.vision_model. A local row's bare model resolves on whichever machine
    holds it; a cloud model's own name (`openai/gpt-4o`) resolves NOWHERE
    without its provider, so it is offered whole — never stripped at its first
    colon the way a catalogue id is for display."""
    mount_peers(
        gateway=FakeGateway(
            catalog_body={
                "rows": [
                    _row("gemma4:12b", "vision", provider="hub"),
                    _row("openai/gpt-4o", "vision", provider="openrouter", kind="cloud"),
                    _row("openai/gpt-x", "completion", provider="openrouter", kind="cloud"),
                ]
            }
        )
    )

    body = (await owner_client.get("/api/v1/models/vision")).json()

    assert body == {"models": ["gemma4:12b", "openrouter:openai/gpt-4o"]}
