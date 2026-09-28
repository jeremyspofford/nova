"""The Jev Router switch (decision-role spec §4): an edit to a role's chain.

Pins: ON puts `openrouter:typesafe/jev-router` in place of the FIRST cloud
link and keeps that link; OFF puts it back exactly; a chain with only local
links gets the router after them, and OFF removes it; the state is DERIVED
from the chain, so a hand edit that drops the router turns the switch off and
forgets the kept link; ON twice is one switch; the switch is refused, in
words, where it cannot apply; the routes page says where it applies.

chat.model is link 1 of every chat and scheduled turn (core sends it ahead of
the chain), so a cloud chat.model IS their cloud link: on chat the router
takes its place — the answer names the chat model core must write, since
core is chat.model's one writer — and scheduled, which shares it, is switched
on chat. OFF always works: a kept link whose provider is gone is not put
back, and the answer says so."""

from __future__ import annotations

import logging

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


async def _roles(client, chat_model: str | None = None) -> dict[str, dict]:
    params = {"chat_model": chat_model} if chat_model is not None else None
    page = await client.get("/admin/routes", params=params)
    return {r["role"]: r for r in page.json()["roles"]}


async def _kept(pool, role: str) -> str | None:
    return await pool.fetchval("SELECT router_kept FROM routes WHERE role = $1", role)


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
    assert await pool.fetchval("SELECT router_kept FROM routes WHERE role = 'chat'") is None
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


# ── chat.model: link 1 of chat's and scheduled's turns ─────────────────────


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
    assert await _kept(pool, "chat") == PICKED
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
    assert await _kept(pool, "chat") is None
    assert (await _roles(client, chat_model=PICKED))["chat"]["chain"] == chain


async def test_a_chain_edit_while_the_router_is_the_chat_model_keeps_the_pick(client, pool, world):
    """The router sits in chat.model, not in the stored chain, so an edit to
    chat's fallbacks removes no router link: the pick stays kept, and OFF
    still puts it back."""
    await _switch(client, "chat", True, chat_model=PICKED)

    edit = await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})

    assert edit.status_code == 200, edit.text
    assert await _kept(pool, "chat") == PICKED
    assert (await _roles(client, chat_model=ROUTER))["chat"]["router"] == {
        "on": True,
        "kept": PICKED,
    }
    off = await _switch(client, "chat", False, chat_model=ROUTER)
    assert off.json()["chat_model"] == PICKED


async def test_off_is_refused_in_words_when_jev_router_was_picked_as_the_chat_model(
    client, pool, world
):
    """Jev Router picked by hand in chat: the switch reads on, and it replaced
    nothing, so there is nothing to put back — said, never a silent no-op."""
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
    # Kept as '' (it replaced nothing) is the same: nothing to put back.
    await pool.execute(
        "INSERT INTO routes (role, chain, router_kept) VALUES ('chat', '[]'::jsonb, '') "
        "ON CONFLICT (role) DO UPDATE SET router_kept = ''"
    )
    again = await _switch(client, "chat", False, chat_model=ROUTER)
    assert again.status_code == 400 and again.json()["error"] == words


async def test_scheduled_shares_the_chat_model_so_its_cloud_link_is_switched_on_chat(
    client, pool, world
):
    """Scheduled turns send chat.model as link 1 too. A cloud chat.model is
    chat's as much as scheduled's, so scheduled cannot swap it alone: refused
    in words, nothing stored. Once the router is the chat model, scheduled
    reads on and is switched off on chat. An agent's turns send no chat
    model, so the one passed is not its link."""
    await client.put("/admin/routes/scheduled", json={"chain": ["cerebras:llama"]})
    await client.put("/admin/routes/agent_coder", json={"chain": ["cerebras:llama"]})

    on = await _switch(client, "scheduled", True, chat_model=PICKED)

    assert on.status_code == 400
    assert on.json()["error"] == (
        f"scheduled's first link is the chat model, {PICKED}, a cloud model it shares with "
        "chat — switch Jev Router on for chat"
    )
    assert await _kept(pool, "scheduled") is None
    roles = await _roles(client, chat_model=ROUTER)
    assert roles["scheduled"]["chain"] == ["cerebras:llama"]
    assert roles["scheduled"]["router"] == {"on": True, "kept": None}
    assert roles["agent_coder"]["router"] == {"on": False, "kept": None}
    off = await _switch(client, "scheduled", False, chat_model=ROUTER)
    assert off.status_code == 400
    assert off.json()["error"] == (
        "scheduled's first link is the chat model, which is Jev Router — switch it off on chat"
    )
    agent = await _switch(client, "agent_coder", True, chat_model=PICKED)
    assert agent.json() == {
        "role": "agent_coder",
        "chain": [ROUTER],
        "router": {"on": True, "kept": "cerebras:llama"},
    }


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
    assert await _kept(pool, "chat") is None
    assert (await _roles(client))["chat"]["chain"] == [PICKED]


# ── OFF always works ───────────────────────────────────────────────────────


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
    assert await _kept(pool, "chat") is None
    assert any(
        r.levelno == logging.WARNING and "cerebras:llama" in r.getMessage() for r in caplog.records
    )


async def test_off_clears_the_chat_model_when_the_kept_picks_provider_is_gone_and_says_so(
    client, pool, world, caplog
):
    """The chat model the router replaced names a provider that is gone: it is
    not handed back to core as the chat model. The answer clears it (the
    gateway's default) and says so."""
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
    assert await _kept(pool, "chat") is None
    assert any(
        r.levelno == logging.WARNING and "cerebras:llama" in r.getMessage() for r in caplog.records
    )
