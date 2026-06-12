"""Unit tests: council proposer selection + run mechanics. Fake litellm, no network."""
from types import SimpleNamespace

import pytest
from app import council
from app.config import settings


def fake_manifest(models):
    async def _get(force=False):
        return {"models": models}
    return _get


def fake_discovery(by_endpoint):
    async def _disc(ep, force=False):
        return [{"id": m, "registered": True} for m in by_endpoint.get(ep["id"], [])]
    return _disc


def eps(*ids):
    return [
        {"id": i, "name": i, "engine": "ollama", "url": f"http://{i}:11434",
         "lifecycle": "always-on", "wol_mac_secret": None, "enabled": True}
        for i in ids
    ]


MANIFEST = [
    {"ollama_id": "big:32b", "roles": ["completion"], "cloud": False,
     "scores": {"agent": 4, "reasoning": 4}},
    {"ollama_id": "mid:7b", "roles": ["completion"], "cloud": False,
     "scores": {"agent": 3, "reasoning": 3}},
    {"ollama_id": "tiny:1b", "roles": ["completion"], "cloud": False,
     "scores": {"agent": 2, "reasoning": 1}},
    {"ollama_id": "embed", "roles": ["embedding"], "cloud": False, "scores": None},
]


@pytest.mark.asyncio
async def test_selects_distinct_models_by_score(monkeypatch):
    monkeypatch.setattr(council, "get_manifest", fake_manifest(MANIFEST))
    monkeypatch.setattr(council, "discover_endpoint_models",
                        fake_discovery({"a": ["mid:7b", "embed"], "b": ["big:32b", "mid:7b"]}))
    monkeypatch.setattr(council.ep_mod, "routable", lambda: eps("a", "b"))

    out = await council.select_proposers(3)
    assert [p["model"] for p in out][:2] == ["big:32b", "mid:7b"]
    assert out[0]["endpoint"] == "b"      # big:32b only lives on endpoint b
    assert out[1]["endpoint"] == "a"      # mid:7b deduped to its first sighting
    assert len(out) == 3                  # third seat filled by jitter fallback
    assert out[2]["model"] == settings.local_completion_model


@pytest.mark.asyncio
async def test_embedding_models_never_propose(monkeypatch):
    monkeypatch.setattr(council, "get_manifest", fake_manifest(MANIFEST))
    monkeypatch.setattr(council, "discover_endpoint_models", fake_discovery({"a": ["embed"]}))
    monkeypatch.setattr(council.ep_mod, "routable", lambda: eps("a"))

    out = await council.select_proposers(2)
    assert all(p["model"] == settings.local_completion_model for p in out)


@pytest.mark.asyncio
async def test_no_endpoints_raises(monkeypatch):
    monkeypatch.setattr(council, "get_manifest", fake_manifest(MANIFEST))
    monkeypatch.setattr(council, "discover_endpoint_models", fake_discovery({}))
    monkeypatch.setattr(council.ep_mod, "routable", lambda: [])
    monkeypatch.setattr(council.selector, "local_candidates", lambda: [])

    with pytest.raises(council.CouncilUnavailable):
        await council.select_proposers(3)


def _fake_completion_factory(answers: dict[str, str]):
    """litellm.acompletion fake keyed by model id (after openai/ prefix strip)."""
    calls = []

    async def fake(model, messages, **kwargs):
        calls.append({"model": model, "messages": messages, **kwargs})
        text = answers.get(model.removeprefix("openai/"), "fallback answer")
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5),
        )
    return fake, calls


@pytest.mark.asyncio
async def test_run_council_aggregates_with_seed(monkeypatch):
    monkeypatch.setattr(council, "get_manifest", fake_manifest(MANIFEST))
    monkeypatch.setattr(council, "discover_endpoint_models",
                        fake_discovery({"a": ["big:32b", "mid:7b", "tiny:1b"]}))
    monkeypatch.setattr(council.ep_mod, "routable", lambda: eps("a"))
    fake, calls = _fake_completion_factory({
        "big:32b": "CHAIR SYNTHESIS",   # also the chair (best score)
        "mid:7b": "proposal B",
        "tiny:1b": "proposal C",
    })
    monkeypatch.setattr(council.litellm, "acompletion", fake)

    final, meta = await council.run_council(
        [{"role": "user", "content": "question?"}], max_tokens=100,
        seed_proposal="the draft",
    )
    assert final == "CHAIR SYNTHESIS"
    assert meta["aggregator"] == "big:32b"
    assert meta["seeded"] is True
    assert len(meta["proposers"]) == 3
    assert meta["capped"] is False
    # The chair saw the draft labeled as the live assistant's.
    chair_call = calls[-1]
    chair_text = chair_call["messages"][-1]["content"]
    assert "the draft" in chair_text and "live assistant" in chair_text
    assert "proposal B" in chair_text


@pytest.mark.asyncio
async def test_aggregation_failure_returns_best_proposal(monkeypatch):
    monkeypatch.setattr(council, "get_manifest", fake_manifest(MANIFEST))
    monkeypatch.setattr(council, "discover_endpoint_models",
                        fake_discovery({"a": ["big:32b", "mid:7b"]}))
    monkeypatch.setattr(council.ep_mod, "routable", lambda: eps("a"))

    call_n = {"n": 0}

    async def flaky(model, messages, **kwargs):
        call_n["n"] += 1
        if call_n["n"] > 3:  # proposals (3) succeed, the chair call fails
            raise RuntimeError("chair died")
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=f"proposal {call_n['n']}"))],
            usage=None,
        )
    monkeypatch.setattr(council.litellm, "acompletion", flaky)

    final, meta = await council.run_council(
        [{"role": "user", "content": "q"}], max_tokens=50,
    )
    assert final.startswith("proposal")
    assert meta["aggregator"] is None
    assert meta["capped"] is True
