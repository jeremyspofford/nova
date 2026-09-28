"""POST /v1/systemone (decision-role spec §1): typed questions for the
decisions role, walked through the SAME loop as chat.

Pins: the body goes to the winning link's {base_url}/systemone unchanged but
for `model`, which becomes the link's own id, with the provider's own key; the
answer comes back with the ledger's usage and the route, X-Nova-Served-By and
X-Nova-Route; the call is metered under the decisions role (OpenRouter's
stated cost; a local link has no dollars); a refusing link is walled and the
same request falls to the next; a decision server that cannot be reached is
walled and the next request passes it undialled; an empty chain is a 503 in
words that dials nothing; a body with no questions, or another role, is a 400;
a provider's own 4xx is relayed and walls nothing.

And: a link that serves no typed questions is passed over for the request,
never walled, its words in the route, and the next link answers — whether its
endpoint has no /systemone (a 404 or 405 there: an OpenAI-compatible provider
such as Groq carries chat only) or it answered 200 with a body that is not a
JSON object, which is still metered with its error and never read as a
success; a decision server that answers again after a wall is unwalled like a
cloud link; a decision that got no answer at all is metered under the role and
its turn, and so is one whose caller named no role; a body that is not typed
questions is a 400 in its words; a decision's usage is read by the same rules
as a completion's."""

from __future__ import annotations

import json
from decimal import Decimal
from urllib.parse import unquote

import httpx
import pytest

from app import backends, engines, routing
from app import usage as ledger
from tests.conftest import requires_db
from tests.fakes import FailingTransport, FakeOllama, FakeOpenAICompat

pytestmark = requires_db

JEV = "~typesafe/jev-latest"
KEV = "dell-kev:kev-latest"
GROQ = "groq:llama-3.3-70b"
TURN = "2d6f1a4e-9b1c-4c1e-8f3a-5b7e0c2d9a11"
STATE = '{"owner_message": "How do I get you on my phone"}'
QUESTIONS = {"acts": {"type": "noul", "instructions": "Does answering need doing something?"}}
EMPTY = (
    "no model in the 'decisions' chain can serve right now — the decisions chain is empty, "
    "so no decision model is set (add one in Settings → Routing)"
)
NO_QUESTIONS = "questions must be a non-empty object — the typed questions a decision model answers"
# A 200 that is not an answer: what a proxy in front of the server says.
HTML = b"<html>upstream warming up</html>"
NOT_AN_ANSWER = (
    "dell-kev answered 200 at http://kev.test/v1/systemone but not a JSON object — "
    "not a decision server"
)
UNREADABLE = "the answer is not a JSON object, so no answers can be read from it"


@pytest.fixture
async def local(pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(tags=("qwen3:8b",))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    engines.clear_cache()
    return fake


async def _openrouter(client, mount_backend) -> FakeOpenAICompat:
    fake = FakeOpenAICompat(
        accepts_key="sk-1", models_body={"object": "list", "data": [{"id": JEV}]}
    )
    mount_backend("http://openrouter.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "openrouter",
            "adapter": "openai-chat",
            "base_url": "http://openrouter.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    assert resp.status_code == 200, resp.text
    return fake


async def _kev(client, mount_backend) -> FakeOpenAICompat:
    fake = FakeOpenAICompat(
        models_body={"models": [{"name": "kev-latest"}]},
        systemone_usage={"input_tokens": 900, "output_tokens": 12},
    )
    mount_backend("http://kev.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "dell-kev",
            "adapter": "systemone",
            "base_url": "http://kev.test/v1",
            "auth_shape": "none",
            "local": True,
        },
    )
    assert resp.status_code == 200, resp.text
    return fake


async def _groq(client, mount_backend, status: int) -> FakeOpenAICompat:
    """An OpenAI-compatible provider whose server has no typed questions: its
    adapter carries both protocols, and /systemone answers `status`."""
    fake = FakeOpenAICompat(
        accepts_key="gk-1",
        models_body={"object": "list", "data": [{"id": "llama-3.3-70b"}]},
        systemone_status=status,
    )
    mount_backend("http://groq.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "groq",
            "adapter": "openai-chat",
            "base_url": "http://groq.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "gk-1",
        },
    )
    assert resp.status_code == 200, resp.text
    return fake


async def _chain(client, *links: str) -> None:
    resp = await client.put("/admin/routes/decisions", json={"chain": list(links)})
    assert resp.status_code == 200, resp.text


async def _decide(client, **body):
    return await client.post(
        "/v1/systemone",
        json={"state": STATE, "questions": QUESTIONS, **body},
        headers={"X-Nova-Role": "decisions", "X-Nova-Purpose": "chat", "X-Nova-Turn-Id": TURN},
    )


def _asked(fake: FakeOpenAICompat) -> list[dict | None]:
    return [body for path, body in fake.seen if path == "/v1/systemone"]


async def test_a_decision_goes_to_the_first_link_with_its_own_model_id_and_key(
    client, pool, local, mount_backend
):
    jev = await _openrouter(client, mount_backend)
    await _chain(client, f"openrouter:{JEV}")

    resp = await _decide(client)

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    assert resp.headers["x-nova-route"] == "role=decisions;link=1"
    body = resp.json()
    assert body["answers"] == jev.systemone_answers
    assert body["usage"]["cost_usd"] == 1e-05
    assert body["usage"]["cost_basis"] == "provider-reported"
    assert (body["usage"]["prompt_tokens"], body["usage"]["completion_tokens"]) == (40, 6)
    assert body["route"] == {
        "role": "decisions",
        "link": 1,
        "reason": None,
        "served_by": f"openrouter:{JEV}",
        "standby": False,
    }
    # Unchanged but for `model`, which is the LINK's own id.
    assert _asked(jev) == [{"state": STATE, "questions": QUESTIONS, "model": JEV}]
    assert jev.seen_auth[-1] == "Bearer sk-1"
    (row,) = await pool.fetch(
        "SELECT kind, role, purpose, provider, model, prompt_tokens, completion_tokens, "
        "cost_usd, cost_basis, local, turn_id::text AS turn FROM usage_events"
    )
    assert (row["kind"], row["role"], row["purpose"]) == ("completion", "decisions", "chat")
    assert (row["provider"], row["model"], row["turn"]) == ("openrouter", JEV, TURN)
    assert (row["prompt_tokens"], row["completion_tokens"]) == (40, 6)
    assert row["cost_usd"] == Decimal("0.00001") and row["cost_basis"] == "provider-reported"
    assert row["local"] is False


async def test_a_local_decision_server_is_metered_with_no_dollars(
    client, pool, local, mount_backend
):
    kev = await _kev(client, mount_backend)
    await _chain(client, KEV)

    resp = await _decide(client)

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == KEV
    usage = resp.json()["usage"]
    assert usage["cost_usd"] is None and usage["local"] is True
    assert _asked(kev) == [{"state": STATE, "questions": QUESTIONS, "model": "kev-latest"}]
    (row,) = await pool.fetch("SELECT local, cost_usd, prompt_tokens FROM usage_events")
    assert row["local"] is True and row["cost_usd"] is None and row["prompt_tokens"] == 900


async def test_a_refusing_first_link_is_walled_and_the_same_request_falls_to_the_next(
    client, pool, local, mount_backend
):
    kev = await _kev(client, mount_backend)
    jev = await _openrouter(client, mount_backend)
    await _chain(client, KEV, f"openrouter:{JEV}")
    kev.systemone_status = 503

    resp = await _decide(client)

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    route = resp.json()["route"]
    assert route["link"] == 2 and f"{KEV}: {KEV} refused this request" in route["reason"]
    walls = await pool.fetch("SELECT provider, model, status FROM provider_walls")
    assert [(w["provider"], w["model"], w["status"]) for w in walls] == [
        ("dell-kev", "kev-latest", 503)
    ]
    rows = await pool.fetch("SELECT kind, provider, status, role FROM usage_events ORDER BY id")
    assert [(r["kind"], r["provider"], r["status"], r["role"]) for r in rows] == [
        ("refusal", "dell-kev", 503, "decisions"),
        ("completion", "openrouter", 200, "decisions"),
    ]
    assert len(_asked(jev)) == 1


async def test_a_decision_server_that_cannot_be_reached_is_walled_and_then_passed_undialled(
    client, pool, local, mount_backend, mount_transport
):
    """Review focus 3. The Dell asleep: the first request dials Kev, fails to
    connect, walls it and is answered by Jev; the next request goes straight
    to Jev without dialling the dead box — the wall, not the socket, decides."""
    await _kev(client, mount_backend)
    await _openrouter(client, mount_backend)
    await _chain(client, KEV, f"openrouter:{JEV}")
    down = FailingTransport(httpx.ConnectError)
    mount_transport("http://kev.test", down)

    first = await _decide(client)

    assert first.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    walls = await pool.fetch("SELECT provider, model, status FROM provider_walls")
    assert [(w["provider"], w["model"], w["status"]) for w in walls] == [
        ("dell-kev", "kev-latest", 502)
    ]
    dialled = len(down.requests)
    assert dialled == 1

    second = await _decide(client)

    assert second.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    assert len(down.requests) == dialled, "a walled decision server is not dialled again"
    assert "walled for another" in second.json()["route"]["reason"]


async def test_an_empty_decisions_chain_is_a_503_in_words_that_dials_nothing(
    client, pool, local, mount_backend
):
    """Review focus 1, at the endpoint: no decision model set — every install's
    first state — is a stated 503, and no provider (and no chat model) is asked."""
    jev = await _openrouter(client, mount_backend)
    await client.put("/admin/routes/chat", json={"chain": [f"openrouter:{JEV}", "hub:qwen3:8b"]})

    resp = await _decide(client)

    assert resp.status_code == 503
    assert resp.json()["error"] == EMPTY
    assert _asked(jev) == []
    assert not [p for p, _ in local.seen if p.endswith("/chat/completions")]
    assert await pool.fetchval("SELECT count(*) FROM usage_events") == 0


async def test_a_requested_model_is_link_one_as_it_is_for_chat(client, pool, local, mount_backend):
    kev = await _kev(client, mount_backend)
    await _openrouter(client, mount_backend)
    await _chain(client, f"openrouter:{JEV}")

    resp = await _decide(client, model=KEV)

    assert resp.headers["x-nova-served-by"] == KEV
    assert _asked(kev)[-1]["model"] == "kev-latest"


async def test_a_providers_own_refusal_about_the_request_is_relayed_and_walls_nothing(
    client, pool, local, mount_backend
):
    kev = await _kev(client, mount_backend)
    await _chain(client, KEV)
    kev.systemone_status = 422

    resp = await _decide(client)

    assert resp.status_code == 422
    assert resp.json()["error"]["message"] == "refused (422)"
    assert await pool.fetch("SELECT provider FROM provider_walls") == []
    (row,) = await pool.fetch("SELECT kind, status, error FROM usage_events")
    assert (row["kind"], row["status"], row["error"]) == ("refusal", 422, "refused (422)")


async def test_a_body_without_questions_or_another_role_is_refused_before_any_call(
    client, pool, local, mount_backend
):
    jev = await _openrouter(client, mount_backend)
    await _chain(client, f"openrouter:{JEV}")

    none = await client.post("/v1/systemone", json={"state": STATE})
    other = await client.post(
        "/v1/systemone",
        json={"state": STATE, "questions": QUESTIONS},
        headers={"X-Nova-Role": "chat"},
    )

    assert none.status_code == 400
    assert none.json()["error"] == NO_QUESTIONS
    assert other.status_code == 400
    assert other.json()["error"] == (
        "POST /v1/systemone serves the decisions role — X-Nova-Role named 'chat'"
    )
    assert _asked(jev) == []


@pytest.mark.parametrize("status", [404, 405])
async def test_a_link_with_no_typed_questions_is_passed_over_unwalled_and_the_next_answers(
    client, pool, local, mount_backend, status
):
    """An openai-chat provider carries both protocols by its adapter, but
    Groq, OpenAI and the rest have no /systemone: relaying their 404 would
    strand every link behind them. The link is passed over for THIS request —
    never walled, since nothing was learned about its key or its health —
    the route says why, and the next link answers."""
    groq = await _groq(client, mount_backend, status)
    jev = await _openrouter(client, mount_backend)
    await _chain(client, GROQ, f"openrouter:{JEV}")

    resp = await _decide(client)

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    said = f"groq answered {status} at http://groq.test/v1/systemone — refused ({status})"
    route = resp.json()["route"]
    assert route["link"] == 2 and f"{GROQ}: {said}" in route["reason"]
    header = dict(part.split("=", 1) for part in resp.headers["x-nova-route"].split(";"))
    assert header["link"] == "2" and unquote(header["reason"]) == route["reason"]
    assert await pool.fetch("SELECT provider FROM provider_walls") == []
    rows = await pool.fetch(
        "SELECT kind, provider, status, role, error FROM usage_events ORDER BY id"
    )
    assert [(r["kind"], r["provider"], r["status"], r["role"]) for r in rows] == [
        ("refusal", "groq", status, "decisions"),
        ("completion", "openrouter", 200, "decisions"),
    ]
    assert rows[0]["error"] == said
    assert (len(_asked(groq)), len(_asked(jev))) == (1, 1)

    again = await _decide(client)

    assert again.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    assert len(_asked(groq)) == 2, "passed over for one request, never walled"


async def test_a_chain_whose_only_link_has_no_typed_questions_is_a_503_in_its_words(
    client, pool, local, mount_backend
):
    await _groq(client, mount_backend, 404)
    await _chain(client, GROQ)

    resp = await _decide(client)

    assert resp.status_code == 503
    assert resp.json()["error"] == (
        "no model in the 'decisions' chain can serve right now — "
        f"{GROQ}: groq answered 404 at http://groq.test/v1/systemone — refused (404)"
    )
    assert await pool.fetch("SELECT provider FROM provider_walls") == []


async def test_a_decision_that_got_no_answer_is_metered_under_the_role_and_its_turn(
    client, pool, local, mount_backend, mount_transport
):
    """The Spend page shows decision spend under the role, and a trace reads a
    turn's calls by its id: a decision server that never answered is a refusal
    row with both, in the words the walk walled it with."""
    await _kev(client, mount_backend)
    await _chain(client, KEV)
    mount_transport("http://kev.test", FailingTransport(httpx.ConnectError))

    resp = await _decide(client)

    assert resp.status_code == 503
    (row,) = await pool.fetch(
        "SELECT kind, status, role, purpose, turn_id::text AS turn, provider, model, "
        "served_by, local, cost_usd, error FROM usage_events"
    )
    assert (row["kind"], row["status"], row["role"], row["purpose"], row["turn"]) == (
        "refusal",
        502,
        "decisions",
        "chat",
        TURN,
    )
    assert (row["provider"], row["model"], row["served_by"]) == ("dell-kev", "kev-latest", KEV)
    assert row["local"] is True and row["cost_usd"] is None
    assert row["error"].startswith("could not reach dell-kev at http://kev.test/v1 — ConnectError")


async def test_an_answer_that_is_not_a_json_object_is_passed_over_and_the_next_link_answers(
    client, pool, local, mount_backend
):
    """A 200 no answers can be read from — an HTML page from a proxy in front
    of the Dell — is no decision server's answer. Relayed, it would end every
    decision at that link and Jev would never be asked. It is passed over for
    the request, never walled, its words in the route; it is still metered,
    with its error; and the next link answers."""
    kev = await _kev(client, mount_backend)
    jev = await _openrouter(client, mount_backend)
    await _chain(client, KEV, f"openrouter:{JEV}")
    kev.systemone_raw = HTML

    resp = await _decide(client)

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    assert resp.json()["answers"] == jev.systemone_answers
    route = resp.json()["route"]
    assert route["link"] == 2 and f"{KEV}: {NOT_AN_ANSWER}" in route["reason"]
    assert await pool.fetch("SELECT provider FROM provider_walls") == []
    rows = await pool.fetch(
        "SELECT kind, provider, status, role, error FROM usage_events ORDER BY id"
    )
    assert [(r["kind"], r["provider"], r["status"], r["role"]) for r in rows] == [
        ("completion", "dell-kev", 200, "decisions"),
        ("completion", "openrouter", 200, "decisions"),
    ]
    assert [r["error"] for r in rows] == [UNREADABLE, None]


async def test_an_answer_that_is_not_a_json_object_is_never_read_as_a_success(
    client, pool, local, mount_backend
):
    """A success clears a decision server's lapsed wall (the next test); an
    unreadable 200 is not one. Kev's lapsed wall is left exactly as it was:
    not cleared as if Kev had answered, and not climbed as if it had refused."""
    kev = await _kev(client, mount_backend)
    await _openrouter(client, mount_backend)
    await _chain(client, KEV, f"openrouter:{JEV}")
    await routing.record_refusal(pool, {"name": "dell-kev"}, 502, "asleep", model="kev-latest")
    await pool.execute("UPDATE provider_walls SET walled_until = now() - interval '1 minute'")
    before = [dict(w) for w in await pool.fetch("SELECT * FROM provider_walls")]
    kev.systemone_raw = HTML

    resp = await _decide(client)

    assert resp.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    assert len(_asked(kev)) == 1, "the lapsed wall let Kev be asked"
    assert [dict(w) for w in await pool.fetch("SELECT * FROM provider_walls")] == before


@pytest.mark.parametrize("raw", [HTML, b'["acts", 0.91]'])
async def test_a_chain_whose_only_link_answers_no_json_object_is_a_503_in_its_words(
    client, pool, local, mount_backend, raw
):
    """With nothing behind it, the walk says why — never the unreadable body
    under a 200. The call is still metered, with its error, and walls nothing."""
    kev = await _kev(client, mount_backend)
    await _chain(client, KEV)
    kev.systemone_raw = raw

    resp = await _decide(client)

    assert resp.status_code == 503
    assert resp.json()["error"] == (
        f"no model in the 'decisions' chain can serve right now — {KEV}: {NOT_AN_ANSWER}"
    )
    (row,) = await pool.fetch(
        "SELECT kind, status, role, error, prompt_tokens, completion_tokens FROM usage_events"
    )
    assert (row["kind"], row["status"], row["role"]) == ("completion", 200, "decisions")
    assert row["error"] == UNREADABLE
    assert (row["prompt_tokens"], row["completion_tokens"]) == (None, None)
    assert await pool.fetch("SELECT provider FROM provider_walls") == []


async def test_a_decision_server_that_answers_again_is_unwalled_and_its_ladder_starts_over(
    client, pool, local, mount_backend, mount_transport
):
    """Kev is local but not an engine: a clean answer clears its wall the way
    it clears a walled cloud link's. Were the lapsed wall kept, its strikes
    would only ever climb — after three outages, every blip on the Dell would
    wall Kev for 30 minutes."""
    kev = await _kev(client, mount_backend)
    await _chain(client, KEV)
    mount_transport("http://kev.test", FailingTransport(httpx.ConnectError))
    assert (await _decide(client)).status_code == 503
    walls = await pool.fetch("SELECT provider, model, status, strikes FROM provider_walls")
    assert [tuple(w) for w in walls] == [("dell-kev", "kev-latest", 502, 1)]
    await pool.execute("UPDATE provider_walls SET walled_until = now() - interval '1 minute'")
    mount_backend("http://kev.test", kev.app)  # the Dell is awake again

    resp = await _decide(client)

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == KEV
    assert await pool.fetch("SELECT provider FROM provider_walls") == []

    mount_transport("http://kev.test", FailingTransport(httpx.ConnectError))
    assert (await _decide(client)).status_code == 503
    strikes = await pool.fetch("SELECT strikes FROM provider_walls")
    assert [w["strikes"] for w in strikes] == [1], "the next blip is a first outage again"


async def test_a_decision_with_no_role_header_is_still_metered_under_the_decisions_role(
    client, pool, local, mount_backend
):
    """The endpoint decides the protocol, and so the role: a caller that sent
    no X-Nova-Role is walked through the decisions chain AND metered under it,
    so the Spend page never shows a decision under no role."""
    await _openrouter(client, mount_backend)
    await _chain(client, f"openrouter:{JEV}")

    resp = await client.post(
        "/v1/systemone",
        json={"state": STATE, "questions": QUESTIONS},
        headers={"X-Nova-Purpose": "chat", "X-Nova-Turn-Id": TURN},
    )

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-route"] == "role=decisions;link=1"
    (row,) = await pool.fetch("SELECT role, purpose, turn_id::text AS turn FROM usage_events")
    assert (row["role"], row["purpose"], row["turn"]) == ("decisions", "chat", TURN)


@pytest.mark.parametrize(
    ("content", "said"),
    [
        (
            b"{",
            "request body is not valid JSON: Expecting property name enclosed in double "
            "quotes: line 1 column 2 (char 1)",
        ),
        (b'["state", "questions"]', "request body must be a JSON object"),
        (json.dumps({"state": STATE, "questions": {}}).encode(), NO_QUESTIONS),
        (json.dumps({"state": STATE, "questions": ["acts"]}).encode(), NO_QUESTIONS),
    ],
    ids=["invalid-json", "not-an-object", "empty-questions", "questions-not-an-object"],
)
async def test_a_body_that_is_not_typed_questions_is_a_400_in_its_words(
    client, pool, local, mount_backend, content, said
):
    jev = await _openrouter(client, mount_backend)
    await _chain(client, f"openrouter:{JEV}")

    resp = await client.post(
        "/v1/systemone",
        content=content,
        headers={"Content-Type": "application/json", "X-Nova-Role": "decisions"},
    )

    assert resp.status_code == 400
    assert resp.json()["error"] == said
    assert _asked(jev) == []
    assert await pool.fetchval("SELECT count(*) FROM usage_events") == 0


def test_a_decisions_usage_is_read_by_the_rules_a_completions_is():
    """TypeSafe's `input_tokens`/`output_tokens` are the ledger's prompt and
    completion counts; everything else is read exactly as a chat completion's
    usage is — on a bring-your-own-key provider the cost is the upstream's
    charge, never OpenRouter's $0 — and what was not stated stays None."""
    byok = ledger.decision_captured(
        {
            "answers": {},
            "usage": {
                "input_tokens": 40,
                "output_tokens": 6,
                "cost": 0,
                "is_byok": True,
                "cost_details": {"upstream_inference_cost": 0.0002},
            },
        }
    )
    assert (byok.prompt_tokens, byok.completion_tokens) == (40, 6)
    assert byok.cost == Decimal("0.0002") and byok.byok is True

    silent = ledger.decision_captured({"answers": {}})
    assert (silent.prompt_tokens, silent.completion_tokens, silent.cost) == (None, None, None)
    refused = ledger.decision_captured({"error": {"message": "No endpoints found", "code": 404}})
    assert refused.error == "No endpoints found"
    assert ledger.decision_captured(["not", "an", "object"]) == ledger.Captured()
