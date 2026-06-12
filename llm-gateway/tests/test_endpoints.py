"""Unit tests: endpoint pool validation, persistence, routing candidates."""
import pytest
from app import endpoints as ep_mod
from app import selector
from app.config import settings


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "runtime_dir", str(tmp_path))
    ep_mod._memo = None
    yield tmp_path
    ep_mod._memo = None


def two_endpoints():
    return [
        {"id": "default", "name": "mini-pc", "engine": "ollama-host",
         "url": "http://host.docker.internal:11434", "lifecycle": "always-on", "enabled": True},
        {"id": "dell-gpu", "name": "dell", "engine": "ollama",
         "url": "http://dell.local:11434/", "lifecycle": "wake-on-lan",
         "wol_mac_secret": "dell_wol_mac", "enabled": True},
    ]


def test_no_file_synthesizes_env_default(runtime):
    eps = ep_mod.list_endpoints()
    assert len(eps) == 1
    ep = eps[0]
    assert ep["id"] == "default"
    assert ep["url"] == settings.local_inference_url
    assert ep["engine"] == settings.nova_inference_backend
    assert ep["lifecycle"] == "always-on"


def test_save_load_round_trip(runtime):
    saved = ep_mod.save(two_endpoints())
    assert [e["id"] for e in saved] == ["default", "dell-gpu"]
    assert saved[1]["url"] == "http://dell.local:11434"  # trailing slash normalized
    assert (runtime / "endpoints.json").exists()
    assert [e["id"] for e in ep_mod.list_endpoints()] == ["default", "dell-gpu"]
    assert ep_mod.get("dell-gpu")["wol_mac_secret"] == "dell_wol_mac"
    assert ep_mod.get("nope") is None


@pytest.mark.parametrize("mutation,msg", [
    (lambda eps: eps[0].update(id="Bad Id!"), "invalid endpoint id"),
    (lambda eps: eps[1].update(id="default"), "duplicate"),
    (lambda eps: eps[0].update(engine="warp-drive"), "engine"),
    (lambda eps: eps[0].update(url="dell.local:11434"), "http"),
    (lambda eps: eps[0].update(lifecycle="sometimes"), "lifecycle"),
])
def test_validation_rejects(runtime, mutation, msg):
    eps = two_endpoints()
    mutation(eps)
    with pytest.raises(ValueError, match=msg):
        ep_mod.validate(eps)


def test_empty_pool_rejected(runtime):
    with pytest.raises(ValueError, match="at least one"):
        ep_mod.validate([])


def test_routable_filters_disabled_and_on_demand(runtime):
    eps = two_endpoints()
    eps.append({"id": "burst", "name": "runpod", "engine": "vllm",
                "url": "http://burst:8000", "lifecycle": "on-demand", "enabled": True})
    eps.append({"id": "off", "name": "off", "engine": "ollama",
                "url": "http://off:11434", "lifecycle": "always-on", "enabled": False})
    ep_mod.save(eps)
    assert [e["id"] for e in ep_mod.routable()] == ["default", "dell-gpu"]


def test_by_api_base_strips_v1(runtime):
    ep_mod.save(two_endpoints())
    assert ep_mod.by_api_base("http://dell.local:11434/v1")["id"] == "dell-gpu"
    assert ep_mod.by_api_base("http://host.docker.internal:11434/v1")["id"] == "default"
    assert ep_mod.by_api_base("http://elsewhere:9999/v1") is None


def test_local_candidates_one_per_routable_endpoint(runtime):
    ep_mod.save(two_endpoints())
    cands = selector.local_candidates()
    assert len(cands) == 2
    model = settings.local_completion_model
    assert cands[0][0] == f"openai/{model}"
    assert cands[0][1]["api_base"] == "http://host.docker.internal:11434/v1"
    assert cands[1][1]["api_base"] == "http://dell.local:11434/v1"


def test_degenerate_default_matches_prepool_candidate(runtime):
    """The single synthesized endpoint must produce exactly the pre-pool candidate."""
    legacy = selector._local_candidate()
    pool = selector.local_candidates()
    if legacy is None:
        assert pool == []
    else:
        assert pool == [legacy]
