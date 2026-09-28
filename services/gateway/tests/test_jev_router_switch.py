"""The Jev Router switch (decision-role spec §4): an edit to a role's chain.

Pins: ON puts `openrouter:typesafe/jev-router` in place of the FIRST cloud
link and keeps that link; OFF puts it back exactly; a chain with only local
links gets the router after them, and OFF removes it; the state is DERIVED
from the chain, so a hand edit that drops the router turns the switch off and
forgets the kept link; ON twice is one switch; the switch is refused, in
words, where it cannot apply; the routes page says where it applies.

The state, read the same way everywhere: a role's EFFECTIVE chain is the
chat model core passes for it (link 1 of chat's, scheduled's and beat's
turns), then the stored chain its turns walk — chat's, for a role with none
of its own. Its cloud slot is the first link there that is Jev Router or on
a cloud provider, and the switch is on exactly when that slot holds Jev
Router — read off the link's own text, bare or after a provider, so a
deleted provider never turns it off. On chat a cloud chat model is that
slot: the answer names the chat model core must write (core is chat.model's
one writer), and a role that shares it is switched on chat. OFF always
works, and never doubles a link: a kept link whose provider is gone is not
put back, and the answer says so."""

from __future__ import annotations

import asyncio
import logging

import asyncpg
import pytest

from app import backends, engines
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

pytestmark = requires_db

ROUTER = "openrouter:typesafe/jev-router"
PICKED = "openrouter:anthropic/claude-x"


@pytest.fixture
async def world(client, pool, monkeypatch, mount_backend):
    """The bundled engine and two cloud providers: openrouter (which lists
    Jev Router) and cerebras."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    hub = FakeOllama(tags=("qwen3:8b",))
    mount_backend("http://ollama.test", hub.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    engines.clear_cache()
    for name in ("openrouter", "cerebras"):
        fake = FakeOpenAICompat(accepts_key="sk-1")
        mount_backend(f"http://{name}.test", fake.app)
        resp = await client.post(
            "/admin/providers",
            json={
                "name": name,
                "adapter": "openai-chat",
                "base_url": f"http://{name}.test/v1",
                "auth_shape": "static-bearer",
                "api_key": "sk-1",
            },
        )
        assert resp.status_code == 200, resp.text


async def _switch(client, role: str, on: bool, link: str = ROUTER, chat_model: str | None = None):
    body: dict = {"on": on, "link": link} if on else {"on": on}
    if chat_model is not None:
        body["chat_model"] = chat_model
    return await client.put(f"/admin/routes/{role}/jev-router", json=body)


async def _roles(
    client, chat_model: str | None = None, roles: str = "chat,scheduled"
) -> dict[str, dict]:
    """The routes page. `chat_model` is the pick core passes, applied to the
    roles core names as walking it (`chat_model_roles`)."""
    params = None
    if chat_model is not None:
        params = {"chat_model": chat_model, "chat_model_roles": roles}
    page = await client.get("/admin/routes", params=params)
    return {r["role"]: r for r in page.json()["roles"]}


async def _row(pool, role: str) -> tuple[str | None, str | None]:
    """(router_kept, router_kept_slot) as stored."""
    row = await pool.fetchrow(
        "SELECT router_kept, router_kept_slot FROM routes WHERE role = $1", role
    )
    return (row["router_kept"], row["router_kept_slot"]) if row else (None, None)


async def test_on_takes_the_first_cloud_links_place_and_off_puts_it_back(client, pool, world):
    await client.put(
        "/admin/routes/chat", json={"chain": ["hub:qwen3:8b", PICKED, "cerebras:llama"]}
    )

    on = await _switch(client, "chat", True)

    assert on.status_code == 200, on.text
    assert on.json() == {
        "role": "chat",
        "chain": ["hub:qwen3:8b", ROUTER, "cerebras:llama"],
        "router": {"on": True, "kept": PICKED},
    }
    assert (await _roles(client))["chat"]["router"] == {"on": True, "kept": PICKED}

    off = await _switch(client, "chat", False)

    assert off.json() == {
        "role": "chat",
        "chain": ["hub:qwen3:8b", PICKED, "cerebras:llama"],
        "router": {"on": False, "kept": None},
    }


async def test_over_only_local_links_the_router_goes_after_them_and_off_removes_it(
    client, pool, world
):
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})

    on = (await _switch(client, "chat", True)).json()
    assert on["chain"] == ["hub:qwen3:8b", ROUTER]
    assert on["router"] == {"on": True, "kept": ""}

    off = (await _switch(client, "chat", False)).json()
    assert off["chain"] == ["hub:qwen3:8b"] and off["router"] == {"on": False, "kept": None}


async def test_a_hand_edit_that_drops_the_router_turns_it_off_and_forgets_the_kept_link(
    client, pool, world
):
    """Review focus 5. The owner removes the router link in the chain editor
    and later flips the switch off: nothing stale comes back, nothing doubles."""
    await client.put("/admin/routes/chat", json={"chain": [PICKED]})
    await _switch(client, "chat", True)

    await client.put("/admin/routes/chat", json={"chain": ["cerebras:llama"]})

    assert (await _roles(client))["chat"]["router"] == {"on": False, "kept": None}
    assert await _row(pool, "chat") == (None, None)
    off = await _switch(client, "chat", False)
    assert off.status_code == 200
    assert off.json() == {
        "role": "chat",
        "chain": ["cerebras:llama"],
        "router": {"on": False, "kept": None},
    }


async def test_switching_on_twice_is_one_switch(client, pool, world):
    await client.put("/admin/routes/scheduled", json={"chain": [PICKED]})

    await _switch(client, "scheduled", True)
    again = (await _switch(client, "scheduled", True)).json()

    assert again["chain"] == [ROUTER]
    assert again["router"] == {"on": True, "kept": PICKED}


async def test_the_switch_is_refused_in_words_where_it_cannot_apply(client, pool, world):
    for role in ("decisions", "judge", "coding"):
        resp = await _switch(client, role, True)
        assert resp.status_code == 400
        assert resp.json()["error"] == (
            f"the Jev Router switch is for the chat, scheduled and agent roles — not {role}"
        )
    empty = await _switch(client, "scheduled", True)
    assert empty.status_code == 400
    assert empty.json()["error"] == (
        "scheduled has no chain of its own — it walks the chat chain; switch Jev Router on "
        "for chat, or give scheduled its own chain first"
    )
    nolink = await client.put("/admin/routes/chat/jev-router", json={"on": True})
    assert nolink.status_code == 400
    assert nolink.json()["error"] == (
        "link is required to switch Jev Router on — the provider:model that serves "
        "typesafe/jev-router"
    )
    wrong = await _switch(client, "chat", True, link=PICKED)
    assert wrong.status_code == 400
    assert wrong.json()["error"] == (
        f"{PICKED!r} is not Jev Router — the link must be <provider>:typesafe/jev-router "
        "on a registered provider"
    )
    garbled = await client.put("/admin/routes/chat/jev-router", json={"on": "yes"})
    assert garbled.status_code == 400
    assert garbled.json()["error"] == "on (true or false) is required"
    not_text = await client.put(
        "/admin/routes/chat/jev-router", json={"on": True, "link": ROUTER, "chat_model": 7}
    )
    assert not_text.status_code == 400
    assert not_text.json()["error"] == "chat_model must be a string"


async def test_the_routes_page_says_where_the_switch_applies(client, pool, world):
    await client.put("/admin/routes/agent_coder", json={"chain": ["cerebras:llama"]})

    roles = await _roles(client)

    for role in ("chat", "scheduled", "agent_coder"):
        assert roles[role]["router"] == {"on": False, "kept": None}, role
    for role in ("judge", "decisions", "coding", "vision"):
        assert roles[role]["router"] is None, role


async def test_the_append_cases_empty_kept_reads_back_from_the_page_and_the_row(
    client, pool, world
):
    """Over only local links the router replaced nothing: kept is '' — on,
    with nothing to put back — on the page and in the row, never None."""
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})
    await _switch(client, "chat", True)

    assert (await _roles(client))["chat"]["router"] == {"on": True, "kept": ""}
    assert await _row(pool, "chat") == ("", "chain")


async def test_off_never_doubles_a_link_the_chain_already_holds(client, pool, world):
    """The owner hand-edits the kept link back into the chain behind the
    router. OFF removes the router rather than put a second copy back."""
    await client.put("/admin/routes/chat", json={"chain": [PICKED]})
    await _switch(client, "chat", True)
    edit = await client.put("/admin/routes/chat", json={"chain": [ROUTER, PICKED]})
    assert edit.status_code == 200, edit.text

    off = await _switch(client, "chat", False)

    assert off.json() == {"role": "chat", "chain": [PICKED], "router": {"on": False, "kept": None}}
    assert await _row(pool, "chat") == (None, None)


# ── chat.model: link 1 of the turns core names ─────────────────────────────


async def test_a_cloud_chat_model_is_chats_cloud_link_so_the_router_becomes_the_chat_model(
    client, pool, world
):
    """chat.model is link 1 of every chat turn, so a cloud chat.model IS chat's
    cloud link. ON keeps the pick and answers with the chat model core must
    write; OFF answers with the pick to put back. Neither touches the chain."""
    chain = ["hub:qwen3:8b", "cerebras:llama"]
    await client.put("/admin/routes/chat", json={"chain": chain})

    on = await _switch(client, "chat", True, chat_model=PICKED)

    assert on.status_code == 200, on.text
    assert on.json() == {
        "role": "chat",
        "chain": chain,
        "router": {"on": True, "kept": PICKED},
        "chat_model": ROUTER,
    }
    assert await _row(pool, "chat") == (PICKED, "chat_model")
    # Core has written chat.model; the page, told it, reads the switch on.
    page = (await _roles(client, chat_model=ROUTER))["chat"]
    assert page["chain"] == chain and page["router"] == {"on": True, "kept": PICKED}
    # Asked again, it is already on: nothing changes, and no chat model to write.
    again = await _switch(client, "chat", True, chat_model=ROUTER)
    assert again.json() == {"role": "chat", "chain": chain, "router": {"on": True, "kept": PICKED}}

    off = await _switch(client, "chat", False, chat_model=ROUTER)

    assert off.status_code == 200, off.text
    assert off.json() == {
        "role": "chat",
        "chain": chain,
        "router": {"on": False, "kept": None},
        "chat_model": PICKED,
    }
    assert (await _roles(client, chat_model=PICKED))["chat"]["chain"] == chain


async def test_the_chat_model_off_keeps_the_pick_until_core_has_written_it(client, pool, world):
    """OFF on the chat model only asks core to write the pick back. Until it
    has, chat.model is still the router and the switch still reads on, so the
    pick stays kept: OFF asked again answers the same."""
    await _switch(client, "chat", True, chat_model=PICKED)
    first = await _switch(client, "chat", False, chat_model=ROUTER)
    assert first.json()["chat_model"] == PICKED

    assert (await _roles(client, chat_model=ROUTER))["chat"]["router"] == {
        "on": True,
        "kept": PICKED,
    }
    second = await _switch(client, "chat", False, chat_model=ROUTER)

    assert second.status_code == 200, second.text
    assert second.json() == first.json()
    assert await _row(pool, "chat") == (PICKED, "chat_model")
    # Written: the page reads off and shows no kept link.
    assert (await _roles(client, chat_model=PICKED))["chat"]["router"] == {
        "on": False,
        "kept": None,
    }


async def test_off_while_off_forgets_a_stale_kept_link(client, pool, world):
    """Once core has written the pick back, the switch reads off and the pick
    it kept is stale: OFF asked while off forgets it."""
    await _switch(client, "chat", True, chat_model=PICKED)
    await _switch(client, "chat", False, chat_model=ROUTER)

    off = await _switch(client, "chat", False, chat_model=PICKED)

    assert off.json() == {"role": "chat", "chain": [], "router": {"on": False, "kept": None}}
    assert await _row(pool, "chat") == (None, None)


async def test_a_bare_cloud_pick_is_kept_and_put_back_qualified(client, pool, world):
    """A bare chat.model is a model on the default provider. The pick is kept
    qualified, so OFF hands back the link that served, and a bare id is
    never mistaken later for a provider that is gone."""
    assert (await client.put("/admin/providers/openrouter/default")).status_code == 200

    on = await _switch(client, "chat", True, chat_model="anthropic/claude-x")

    assert on.status_code == 200, on.text
    assert on.json()["router"] == {"on": True, "kept": PICKED}
    assert on.json()["chat_model"] == ROUTER
    assert await _row(pool, "chat") == (PICKED, "chat_model")
    off = await _switch(client, "chat", False, chat_model=ROUTER)
    assert off.json() == {
        "role": "chat",
        "chain": [],
        "router": {"on": False, "kept": None},
        "chat_model": PICKED,
    }


async def test_a_bare_jev_router_chat_model_reads_on_and_off_hands_the_pick_back(
    client, pool, world
):
    """chat.model can name Jev Router bare, with no provider: a model on the
    default provider. It is Jev Router all the same: the switch reads on, and
    OFF hands back the pick it kept."""
    bare = "typesafe/jev-router"
    await _switch(client, "chat", True, chat_model=PICKED)

    assert (await _roles(client, chat_model=bare))["chat"]["router"] == {
        "on": True,
        "kept": PICKED,
    }
    off = await _switch(client, "chat", False, chat_model=bare)

    assert off.status_code == 200, off.text
    assert off.json() == {
        "role": "chat",
        "chain": [],
        "router": {"on": False, "kept": None},
        "chat_model": PICKED,
    }


async def test_a_chain_edit_while_the_router_is_the_chat_model_keeps_the_pick(client, pool, world):
    """The router sits in chat.model, not in the stored chain, so an edit to
    chat's fallbacks removes no router link: the pick stays kept, and OFF
    still puts it back."""
    await _switch(client, "chat", True, chat_model=PICKED)

    edit = await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})

    assert edit.status_code == 200, edit.text
    assert await _row(pool, "chat") == (PICKED, "chat_model")
    assert (await _roles(client, chat_model=ROUTER))["chat"]["router"] == {
        "on": True,
        "kept": PICKED,
    }
    off = await _switch(client, "chat", False, chat_model=ROUTER)
    assert off.json()["chat_model"] == PICKED


async def test_removing_a_router_the_owner_typed_into_the_chain_keeps_the_chat_models_pick(
    client, pool, world
):
    """With the router as the chat model, a router the owner also typed into
    the stored chain was never the switch's. Removing it forgets nothing: the
    pick was kept for the chat model, and OFF still hands it back."""
    await _switch(client, "chat", True, chat_model=PICKED)
    await client.put("/admin/routes/chat", json={"chain": [ROUTER]})
    await client.put("/admin/routes/chat", json={"chain": []})

    off = await _switch(client, "chat", False, chat_model=ROUTER)

    assert off.status_code == 200, off.text
    assert off.json()["chat_model"] == PICKED
    assert await _row(pool, "chat") == (PICKED, "chat_model")


async def test_a_router_a_cloud_chat_model_displaced_reads_off_and_on_moves_it_to_the_chat_model(
    client, pool, world
):
    """Switched on while chat.model was local, the router took a stored link's
    place. The owner then picks a cloud chat model: link 1, in front of the
    router, so the switch reads off. ON moves the router to the chat model,
    putting the stored link back first (a role never holds two routers the
    switch placed), and OFF hands the pick back: the stored chain ends as it
    was before the first ON."""
    before = ["hub:qwen3:8b", "cerebras:llama"]
    await client.put("/admin/routes/chat", json={"chain": before})
    placed = await _switch(client, "chat", True, chat_model="hub:qwen3:8b")
    assert placed.json()["chain"] == ["hub:qwen3:8b", ROUTER]

    assert (await _roles(client, chat_model=PICKED))["chat"]["router"] == {
        "on": False,
        "kept": None,
    }
    on = await _switch(client, "chat", True, chat_model=PICKED)

    assert on.status_code == 200, on.text
    assert on.json() == {
        "role": "chat",
        "chain": before,
        "router": {"on": True, "kept": PICKED},
        "chat_model": ROUTER,
    }
    assert await _row(pool, "chat") == (PICKED, "chat_model")
    off = await _switch(client, "chat", False, chat_model=ROUTER)
    assert off.json() == {
        "role": "chat",
        "chain": before,
        "router": {"on": False, "kept": None},
        "chat_model": PICKED,
    }
    assert (await _roles(client, chat_model=PICKED))["chat"]["chain"] == before


async def test_off_while_off_puts_back_what_a_displaced_router_replaced(client, pool, world):
    """The router the switch placed in the stored chain, displaced from the
    cloud slot by a cloud chat model: the switch reads off, and OFF asked
    then puts back the link it replaced rather than forget it."""
    before = ["hub:qwen3:8b", "cerebras:llama"]
    await client.put("/admin/routes/chat", json={"chain": before})
    await _switch(client, "chat", True, chat_model="hub:qwen3:8b")

    off = await _switch(client, "chat", False, chat_model=PICKED)

    assert off.json() == {"role": "chat", "chain": before, "router": {"on": False, "kept": None}}
    assert await _row(pool, "chat") == (None, None)


async def test_off_is_refused_in_words_when_jev_router_was_picked_as_the_chat_model(
    client, pool, world
):
    """Jev Router picked by hand in chat: the switch reads on, and it replaced
    nothing there, so there is nothing to put back — said, never a silent
    no-op. A link the switch kept for the stored chain is not one for the
    chat model."""
    assert (await _roles(client, chat_model=ROUTER))["chat"]["router"] == {
        "on": True,
        "kept": None,
    }
    words = (
        "Jev Router is the chat model, picked in chat — the switch replaced nothing there, "
        "so there is nothing to put back; pick a chat model in chat"
    )

    off = await _switch(client, "chat", False, chat_model=ROUTER)

    assert off.status_code == 400
    assert off.json()["error"] == words
    await client.put("/admin/routes/chat", json={"chain": [PICKED]})
    await _switch(client, "chat", True)
    again = await _switch(client, "chat", False, chat_model=ROUTER)
    assert again.status_code == 400 and again.json()["error"] == words
    assert await _row(pool, "chat") == (PICKED, "chain")


async def test_chat_with_no_chain_and_no_chat_model_is_refused_in_words(client, pool, world):
    """With no chain and no chat model, chat answers with the gateway's
    default model; a router appended as its only link would displace it."""
    words = (
        "chat has no chain and no chat model, so it answers with the gateway's default "
        "model — pick a chat model or give chat a chain first"
    )
    bodies = (
        {"on": True, "link": ROUTER},
        {"on": True, "link": ROUTER, "chat_model": ""},
        {"on": True, "link": ROUTER, "chat_model": None},
    )
    for body in bodies:
        resp = await client.put("/admin/routes/chat/jev-router", json=body)
        assert resp.status_code == 400, body
        assert resp.json()["error"] == words
    assert (await _roles(client))["chat"]["chain"] == []
    assert await _row(pool, "chat") == (None, None)


async def test_scheduled_shares_the_chat_model_so_its_cloud_link_is_switched_on_chat(
    client, pool, world
):
    """Scheduled turns send chat.model as link 1 too. A cloud chat.model is
    chat's as much as scheduled's, so scheduled cannot swap it alone: refused
    in words, nothing stored. Once the router is the chat model, scheduled
    reads on and is switched off on chat. The page applies the pick to the
    roles core names, and no other."""
    await client.put("/admin/routes/scheduled", json={"chain": ["cerebras:llama"]})
    await client.put("/admin/routes/agent_coder", json={"chain": ["cerebras:llama"]})

    on = await _switch(client, "scheduled", True, chat_model=PICKED)

    assert on.status_code == 400
    assert on.json()["error"] == (
        f"scheduled's first link is the chat model, {PICKED}, a cloud model it shares with "
        "chat — switch Jev Router on for chat"
    )
    assert await _row(pool, "scheduled") == (None, None)
    roles = await _roles(client, chat_model=ROUTER)
    assert roles["scheduled"]["chain"] == ["cerebras:llama"]
    assert roles["scheduled"]["router"] == {"on": True, "kept": None}
    assert roles["agent_coder"]["router"] == {"on": False, "kept": None}
    off = await _switch(client, "scheduled", False, chat_model=ROUTER)
    assert off.status_code == 400
    assert off.json()["error"] == (
        "scheduled's first link is the chat model, which is Jev Router — switch it off on chat"
    )
    # An agent's turns send no chat model, so core passes none: its switch
    # edits its own chain.
    agent = await _switch(client, "agent_coder", True)
    assert agent.json() == {
        "role": "agent_coder",
        "chain": [ROUTER],
        "router": {"on": True, "kept": "cerebras:llama"},
    }


async def test_a_role_with_no_chain_of_its_own_reads_the_switch_off_the_chat_chain_it_walks(
    client, pool, world
):
    """Scheduled with no chain of its own walks chat's, so its switch is read
    there: on when chat's router is its cloud slot, and never with a kept
    link, which is chat's. Nothing there is scheduled's to change: its OFF is
    refused in words pointing at chat's switch, its ON answers as on and
    writes nothing, and after chat's OFF it reads off."""
    local = "hub:qwen3:8b"
    await client.put("/admin/routes/chat", json={"chain": [local, "cerebras:llama"]})
    await _switch(client, "chat", True, chat_model=local)

    roles = await _roles(client, chat_model=local)

    assert roles["scheduled"]["chain"] == []
    assert roles["scheduled"]["router"] == {"on": True, "kept": None}
    off = await _switch(client, "scheduled", False, chat_model=local)
    assert off.status_code == 400
    assert off.json()["error"] == (
        "scheduled has no chain of its own — it walks the chat chain; switch Jev Router off "
        "for chat"
    )
    on = await _switch(client, "scheduled", True, chat_model=local)
    assert on.status_code == 200, on.text
    assert on.json() == {"role": "scheduled", "chain": [], "router": {"on": True, "kept": None}}
    assert await pool.fetchval("SELECT count(*) FROM routes WHERE role = 'scheduled'") == 0
    await _switch(client, "chat", False, chat_model=local)
    assert (await _roles(client, chat_model=local))["scheduled"]["router"] == {
        "on": False,
        "kept": None,
    }


async def test_beat_walks_the_chat_model_when_core_passes_it(client, pool, world):
    """Core's beat turns send chat.model as link 1 too. The gateway keeps no
    list of such roles: a chat model core passes for a role is that role's
    link 1, and the page applies it to the roles core names."""
    await client.put("/admin/routes/beat", json={"chain": ["hub:qwen3:8b"]})

    refused = await _switch(client, "beat", True, chat_model=PICKED)

    assert refused.status_code == 400
    assert refused.json()["error"] == (
        f"beat's first link is the chat model, {PICKED}, a cloud model it shares with "
        "chat — switch Jev Router on for chat"
    )
    assert await _row(pool, "beat") == (None, None)
    await _switch(client, "chat", True, chat_model=PICKED)
    named = await _roles(client, chat_model=ROUTER, roles="chat,scheduled,beat")
    assert named["beat"]["router"] == {"on": True, "kept": None}
    assert (await _roles(client, chat_model=ROUTER))["beat"]["router"] == {
        "on": False,
        "kept": None,
    }
    off = await _switch(client, "beat", False, chat_model=ROUTER)
    assert off.status_code == 400
    assert off.json()["error"] == (
        "beat's first link is the chat model, which is Jev Router — switch it off on chat"
    )


async def test_a_local_chat_model_leaves_the_switch_editing_the_stored_chain(client, pool, world):
    """A local chat.model is not a cloud link: on chat and on scheduled the
    router takes the stored chain's first cloud link, exactly as with no chat
    model, and the answer names no chat model to write."""
    for role in ("chat", "scheduled"):
        await client.put(f"/admin/routes/{role}", json={"chain": [PICKED]})

        on = await _switch(client, role, True, chat_model="hub:qwen3:8b")
        off = await _switch(client, role, False, chat_model="hub:qwen3:8b")

        assert on.json() == {
            "role": role,
            "chain": [ROUTER],
            "router": {"on": True, "kept": PICKED},
        }
        assert off.json() == {
            "role": role,
            "chain": [PICKED],
            "router": {"on": False, "kept": None},
        }


async def test_a_router_link_on_a_provider_that_cannot_chat_is_refused_by_name(
    client, pool, world, mount_backend
):
    """The link is the role's chat link from then on — on chat, the chat
    model itself — so one whose provider answers only typed questions is
    refused before anything is stored or handed to core."""
    fake = FakeOpenAICompat(models_body={"models": [{"name": "kev-latest"}]})
    mount_backend("http://kev.test", fake.app)
    kev = await client.post(
        "/admin/providers",
        json={
            "name": "dell-kev",
            "adapter": "systemone",
            "base_url": "http://kev.test/v1",
            "auth_shape": "none",
            "local": True,
        },
    )
    assert kev.status_code == 200, kev.text
    await client.put("/admin/routes/chat", json={"chain": [PICKED]})

    for chat_model in (None, PICKED):
        bad = await _switch(
            client, "chat", True, link="dell-kev:typesafe/jev-router", chat_model=chat_model
        )
        assert bad.status_code == 400
        assert bad.json()["error"] == (
            "link 'dell-kev:typesafe/jev-router' cannot serve the chat role — dell-kev "
            "answers typed questions — this role needs chat"
        )
    assert await _row(pool, "chat") == (None, None)
    assert (await _roles(client))["chat"]["chain"] == [PICKED]


async def test_a_kept_link_is_stored_with_its_slot_or_not_at_all(pool):
    """A row cannot hold a kept link without the slot it belongs to, a slot
    with nothing kept, or a slot the switch does not have."""
    refused = [
        (
            "INSERT INTO routes (role, chain, router_kept) VALUES ('chat', '[]', 'x')",
            "routes_router_kept_pair_check",
        ),
        (
            "INSERT INTO routes (role, chain, router_kept_slot) VALUES ('chat', '[]', 'chain')",
            "routes_router_kept_pair_check",
        ),
        (
            "INSERT INTO routes (role, chain, router_kept, router_kept_slot) "
            "VALUES ('chat', '[]', 'x', 'elsewhere')",
            "routes_router_kept_slot_check",
        ),
    ]
    for sql, constraint in refused:
        with pytest.raises(asyncpg.exceptions.CheckViolationError, match=constraint):
            await pool.execute(sql)


async def test_a_chain_edit_the_switch_and_a_delete_on_one_role_wait_for_each_other(
    client, pool, world
):
    """Each reads the role's row and writes it back, or deletes it, so none
    may run between another's read and write: a switch must never re-insert
    a row a delete has just removed. Each holds the role's lock for the whole
    of it — seen here by holding that lock from outside and watching each
    wait for it. The first runs on a role with no row yet, where a row lock
    would lock nothing."""
    await client.put("/admin/routes/agent_coder", json={"chain": [PICKED]})
    for role, act in (
        ("chat", lambda: client.put("/admin/routes/chat", json={"chain": [PICKED]})),
        ("chat", lambda: _switch(client, "chat", True)),
        ("agent_coder", lambda: client.delete("/admin/routes/agent_coder")),
    ):
        async with pool.acquire() as conn:
            held = conn.transaction()
            await held.start()
            await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1::text))", f"routes:{role}")
            task = asyncio.create_task(act())
            await asyncio.sleep(0.3)
            waited = not task.done()
            await held.rollback()
        resp = await asyncio.wait_for(task, 5)
        assert waited, role
        assert resp.status_code == 200, resp.text


# ── OFF always works ───────────────────────────────────────────────────────


async def test_a_deleted_router_provider_still_reads_on_and_off_puts_the_pick_back(
    client, pool, world
):
    """A Jev Router link is read off its own text, so deleting the provider
    that served it never turns the switch off or loses what it kept — in the
    stored chain or in the chat model."""
    await client.put("/admin/routes/scheduled", json={"chain": ["cerebras:llama"]})
    await _switch(client, "scheduled", True)
    await _switch(client, "chat", True, chat_model="cerebras:qwen")
    assert (await client.delete("/admin/providers/openrouter")).status_code == 200

    roles = await _roles(client, chat_model=ROUTER, roles="chat")

    assert roles["scheduled"]["router"] == {"on": True, "kept": "cerebras:llama"}
    assert roles["chat"]["router"] == {"on": True, "kept": "cerebras:qwen"}
    scheduled = await _switch(client, "scheduled", False)
    assert scheduled.json() == {
        "role": "scheduled",
        "chain": ["cerebras:llama"],
        "router": {"on": False, "kept": None},
    }
    chat = await _switch(client, "chat", False, chat_model=ROUTER)
    assert chat.json() == {
        "role": "chat",
        "chain": [],
        "router": {"on": False, "kept": None},
        "chat_model": "cerebras:qwen",
    }


async def test_off_removes_the_router_when_the_kept_links_provider_is_gone_and_says_so(
    client, pool, world, caplog
):
    """The link the router replaced names a provider the owner has since
    deleted. Putting it back would be refused as a link to nothing, so the
    router is removed instead, the kept link forgotten, and the answer says
    what was not put back. Only the link put back is judged: another link on
    the deleted provider stays as the owner stored it and stops nothing."""
    caplog.set_level(logging.WARNING, logger="gateway")
    await client.put(
        "/admin/routes/chat", json={"chain": ["hub:qwen3:8b", "cerebras:llama", "cerebras:qwen"]}
    )
    await _switch(client, "chat", True)
    assert (await client.delete("/admin/providers/cerebras")).status_code == 200

    off = await _switch(client, "chat", False)

    assert off.status_code == 200, off.text
    assert off.json() == {
        "role": "chat",
        "chain": ["hub:qwen3:8b", "cerebras:qwen"],
        "router": {"on": False, "kept": None},
        "note": "the link Jev Router replaced, cerebras:llama, names a provider that no "
        "longer exists, so it was not put back",
    }
    assert await _row(pool, "chat") == (None, None)
    assert any(
        r.levelno == logging.WARNING and "cerebras:llama" in r.getMessage() for r in caplog.records
    )


async def test_off_clears_the_chat_model_when_the_kept_picks_provider_is_gone_and_says_so(
    client, pool, world, caplog
):
    """The chat model the router replaced names a provider that is gone: it is
    not handed back to core as the chat model. The answer clears it (the
    gateway's default) and says so; the pick stays kept, as on every chat
    model OFF, until core has written the chat model."""
    caplog.set_level(logging.WARNING, logger="gateway")
    await _switch(client, "chat", True, chat_model="cerebras:llama")
    assert (await client.delete("/admin/providers/cerebras")).status_code == 200

    off = await _switch(client, "chat", False, chat_model=ROUTER)

    assert off.status_code == 200, off.text
    assert off.json() == {
        "role": "chat",
        "chain": [],
        "router": {"on": False, "kept": None},
        "chat_model": "",
        "note": "the chat model Jev Router replaced, cerebras:llama, names a provider that no "
        "longer exists, so the chat model is cleared — pick one in chat",
    }
    assert await _row(pool, "chat") == ("cerebras:llama", "chat_model")
    assert any(
        r.levelno == logging.WARNING and "cerebras:llama" in r.getMessage() for r in caplog.records
    )
