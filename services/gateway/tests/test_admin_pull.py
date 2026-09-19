"""POST /admin/pull — ollama-only, a preflight line always first (the
download's size DERIVED live from the registry manifest or the Hugging
Face sibling, or a note saying why not), then the real ollama progress
stream verbatim.

The first line's contract from S1 holds: `status: preflight`, then either
`required_gb` / `free_gb` / `ok` or a `note`. S10a added `size_source`,
`size_bytes` and `resolved` beside them. Every pull is sized upstream
before it starts, so this module mounts both upstream fakes for every
test — no test here can reach the real internet whichever ref it pulls."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from app import admin, backends, engines, hf_hub, ollama_registry, pulls
from tests.conftest import requires_db
from tests.fakes import FakeHFHub, FakeOllama, FakeOllamaRegistry

pytestmark = requires_db

CONFIG_DIGEST = "sha256:" + "c" * 64
MANIFEST = {
    "schemaVersion": 2,
    "config": {"digest": CONFIG_DIGEST, "size": 487},
    "layers": [
        {
            "mediaType": "application/vnd.ollama.image.model",
            "digest": "sha256:a",
            "size": 5225374496,
        },  # noqa: E501
        {"mediaType": "application/vnd.ollama.image.template", "digest": "sha256:b", "size": 1574},
        {"mediaType": "application/vnd.ollama.image.license", "digest": "sha256:c", "size": 11343},
        {"mediaType": "application/vnd.ollama.image.params", "digest": "sha256:d", "size": 96},
    ],
}
MANIFEST_TOTAL = 5225374496 + 1574 + 11343 + 96
CONFIG = {
    "model_family": "qwen3",
    "model_type": "8.2B",
    "file_type": "Q4_K_M",
    "architecture": "amd64",  # the CPU's, never the model's
}

REPO = "unsloth/Qwen3-8B-GGUF"
REPO_DETAIL = {
    "id": REPO,
    "gated": False,
    "tags": ["gguf", "qwen3"],
    "gguf": {"total": 8190735360, "architecture": "qwen3", "context_length": 40960},
    "siblings": [
        {"rfilename": "README.md", "size": 100},
        {"rfilename": "Qwen3-8B-Q4_K_M.gguf", "size": 5_030_000_000, "lfs": {"sha256": "1" * 64}},
        {"rfilename": "Qwen3-8B-BF16.gguf", "size": 16_400_000_000, "lfs": {"sha256": "2" * 64}},
        {"rfilename": "mmproj-F16.gguf", "size": 600_000_000, "lfs": {"sha256": "3" * 64}},
    ],
}
NO_DEFAULT_REPO = "someone/Odd-GGUF"
NO_DEFAULT_DETAIL = {
    "id": NO_DEFAULT_REPO,
    "gguf": {"architecture": "llama"},
    "siblings": [
        {"rfilename": "odd-Q5_K_S.gguf", "size": 5},
        {"rfilename": "odd-Q8_0.gguf", "size": 8},
    ],
}


def _lines(body: bytes) -> list[dict]:
    return [json.loads(line) for line in body.decode().splitlines() if line]


@pytest.fixture(autouse=True)
def upstreams(mount_backend):
    registry = FakeOllamaRegistry(
        manifests={"library/qwen3/8b": MANIFEST}, blobs={CONFIG_DIGEST: CONFIG}
    )
    hub = FakeHFHub(repos={REPO: REPO_DETAIL, NO_DEFAULT_REPO: NO_DEFAULT_DETAIL})
    mount_backend(ollama_registry.REGISTRY_BASE, registry.app)
    mount_backend(hf_hub.HF_BASE, hub.app)
    return SimpleNamespace(registry=registry, hub=hub)


@pytest.fixture
async def ollama(pool, monkeypatch, mount_backend):
    """The active backend is the bundled ollama, at a fake that streams two
    progress lines."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(pull_lines=('{"status":"pulling","completed":1}', '{"status":"success"}'))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})
    return fake


# ── the S1 contract, unchanged ─────────────────────────────────────────────


async def test_pull_streams_ollamas_progress_lines_through_after_a_preflight_line(client, ollama):
    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    lines = _lines(resp.content)
    assert lines[0]["status"] == "preflight"
    assert lines[1:] == [
        {"status": "pulling", "completed": 1},
        {"status": "success"},
    ]
    assert ollama.seen[-1] == ("/api/pull", {"model": "qwen3:8b"})


async def test_pull_preflight_states_the_free_space_check_for_a_known_size(
    client, ollama, monkeypatch, tmp_path
):
    monkeypatch.setattr(admin, "MODELS_DIR", tmp_path)

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})  # in the fake registry

    lines = _lines(resp.content)
    assert lines[0]["status"] == "preflight"
    assert "required_gb" in lines[0]
    assert "free_gb" in lines[0]
    assert "ok" in lines[0]


async def test_a_tag_the_registry_has_never_heard_of_does_not_start_a_download(client, ollama):
    """Replaces a test that pinned the opposite (S15, 2026-09-11).

    It used to assert that a model the registry answered 404 for went on to
    stream a successful pull — true only because the fake ollama succeeds at
    everything. Against the real one it fails, after the download has apparently
    started, in ollama's words rather than in ours. The owner hit exactly that
    with `gemma4:26b-a4b`.

    A 404 from the registry is not "could not size it", it is "that tag does not
    exist", and the difference is the whole fix.
    """
    resp = await client.post("/admin/pull", json={"model": "totally-unknown-model"})

    assert resp.status_code == 404, resp.text
    assert "not in the ollama library (registry answered 404)" in resp.text
    assert ollama.seen == []


async def test_pull_unreachable_ollama_is_a_stated_502(client, pool, monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    assert resp.status_code == 502
    assert "error" in resp.json()


async def test_pull_ollama_refusal_is_passed_through(client, pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    mount_backend("http://ollama.test", FakeOllama(pull_status=404).app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/pull", json={"model": "does-not-exist"})

    assert resp.status_code == 404


# ── S10a: sized live, labelled with its source ─────────────────────────────


async def test_a_registry_ref_is_sized_from_the_manifest(client, ollama, monkeypatch, tmp_path):
    """ollama downloads every layer, so the size is their sum; what the
    config blob states of quant / family / params rides along."""
    monkeypatch.setattr(admin, "MODELS_DIR", tmp_path)

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    line = _lines(resp.content)[0]
    assert line["size_source"] == "ollama-registry"
    assert line["size_bytes"] == MANIFEST_TOTAL
    assert line["required_gb"] == round(MANIFEST_TOTAL / 1024**3, 2)
    assert line["resolved"] == {"quant": "Q4_K_M", "family": "qwen3", "params_b": 8.2}
    assert line["ok"] is (line["free_gb"] >= line["required_gb"])
    assert "note" not in line


async def test_an_hf_pull_is_sized_from_the_default_quant_sibling(
    client, ollama, monkeypatch, tmp_path, upstreams
):
    """No quant named: ollama's default is Q4_K_M when the repo has it —
    plus the mmproj projector ollama fetches alongside."""
    monkeypatch.setattr(admin, "MODELS_DIR", tmp_path)

    resp = await client.post("/admin/pull", json={"model": f"hf.co/{REPO}"})

    lines = _lines(resp.content)
    assert lines[0]["size_source"] == "hf-hub"
    assert lines[0]["size_bytes"] == 5_030_000_000 + 600_000_000
    assert lines[0]["resolved"] == {
        "family": "qwen3",
        "params_b": 8.19,
        "quant": "Q4_K_M",
        "mmproj_bytes": 600_000_000,
    }
    assert "required_gb" in lines[0] and "ok" in lines[0]
    assert upstreams.hub.seen == [(f"/api/models/{REPO}", "blobs=true")]
    assert ollama.seen[-1] == ("/api/pull", {"model": f"hf.co/{REPO}"}), "the ref goes as typed"


async def test_an_hf_pull_with_an_explicit_quant_is_sized_from_that_sibling(
    client, ollama, monkeypatch, tmp_path
):
    monkeypatch.setattr(admin, "MODELS_DIR", tmp_path)

    resp = await client.post("/admin/pull", json={"model": f"hf.co/{REPO}:bf16"})

    line = _lines(resp.content)[0]
    assert line["size_bytes"] == 16_400_000_000 + 600_000_000
    assert line["resolved"]["quant"] == "BF16", "the tag is case-insensitive, like ollama's"
    assert ollama.seen[-1] == ("/api/pull", {"model": f"hf.co/{REPO}:bf16"})


async def test_an_hf_pull_naming_a_quant_the_repo_lacks_says_so(client, ollama):
    resp = await client.post("/admin/pull", json={"model": f"hf.co/{REPO}:Q6_K"})

    line = _lines(resp.content)[0]
    assert "required_gb" not in line
    assert f"hf.co/{REPO} has no quant 'Q6_K'; available: Q4_K_M, BF16" in line["note"]
    assert line["resolved"] == {"family": "qwen3", "params_b": 8.19}, "still what the repo states"


async def test_an_hf_pull_with_no_default_quant_asks_for_one(client, ollama):
    resp = await client.post("/admin/pull", json={"model": f"hf.co/{NO_DEFAULT_REPO}"})

    line = _lines(resp.content)[0]
    assert "required_gb" not in line
    assert "pick a quant" in line["note"]
    assert "Q5_K_S, Q8_0" in line["note"]


async def test_an_hf_pull_of_a_repo_the_hub_refuses_carries_its_words(client, ollama, upstreams):
    upstreams.hub.refusals["meta-llama/Llama-4-GGUF"] = (
        403,
        {"error": "Access to model meta-llama/Llama-4-GGUF is restricted"},
    )

    gated = await client.post("/admin/pull", json={"model": "hf.co/meta-llama/Llama-4-GGUF"})
    assert "restricted" in _lines(gated.content)[0]["note"]

    missing = await client.post("/admin/pull", json={"model": "hf.co/nobody/nothing"})
    assert "'nobody/nothing' was not found on Hugging Face" in _lines(missing.content)[0]["note"]


async def test_a_hub_rate_limit_is_a_note_with_the_wait_and_the_pull_proceeds(
    client, ollama, upstreams
):
    upstreams.hub.status = 429
    upstreams.hub.headers = {"Retry-After": "77"}

    resp = await client.post("/admin/pull", json={"model": f"hf.co/{REPO}"})

    lines = _lines(resp.content)
    assert "retry in 77s" in lines[0]["note"]
    assert lines[-1] == {"status": "success"}


async def test_registry_down_is_a_note_with_the_reason_and_the_line_is_still_first(
    client, ollama, monkeypatch
):
    monkeypatch.setattr(ollama_registry, "REGISTRY_BASE", "http://127.0.0.1:1")

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    lines = _lines(resp.content)
    assert lines[0]["status"] == "preflight"
    assert "could not reach the ollama registry" in lines[0]["note"]
    assert "skipping the free-space check" in lines[0]["note"]
    assert "required_gb" not in lines[0]
    assert lines[1:] == [{"status": "pulling", "completed": 1}, {"status": "success"}]


async def test_the_metadata_fetch_is_bounded_and_a_timeout_is_stated(
    client, ollama, monkeypatch, upstreams
):
    monkeypatch.setattr(pulls, "METADATA_BUDGET_S", 0.05)
    upstreams.registry.delay_s = 0.5

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    lines = _lines(resp.content)
    assert "longer than 0.05s" in lines[0]["note"]
    assert lines[-1] == {"status": "success"}


async def test_a_ref_that_is_neither_library_nor_hub_says_so(client, ollama, upstreams):
    resp = await client.post("/admin/pull", json={"model": "ghcr.io/x/y:1"})

    line = _lines(resp.content)[0]
    assert "unknown" in line["note"]
    assert "neither an ollama library tag nor an hf.co ref" in line["note"]
    assert upstreams.registry.seen == [] and upstreams.hub.seen == []


# ── S10a: the refusals a pull can state ────────────────────────────────────


async def test_a_tag_the_library_does_not_have_is_refused_before_ollama_is_called(
    client, ollama, upstreams
):
    """2026-09-11: the owner asked for `gemma4:26b-a4b`, which is not a tag.

    The registry had already answered 404 — the preflight said so in the first
    line — and the pull went ahead to ollama anyway, to fail there in ollama's
    words after the stream had opened. Refuse before the act (rail 9), in the
    gateway's own sentence, and NAME what the curated list does have under that
    model, because "not found" alone leaves him guessing at the spelling.

    The registry cannot be enumerated (.../tags/list is 404), so the near
    misses come from the curated file — the one list of tags this box actually
    vouches for — and the sentence says that is where they came from.
    """
    # The fake registry holds library/qwen3/8b and nothing else, so this 404s
    # the way the real registry did for `gemma4:26b-a4b`.
    resp = await client.post("/admin/pull", json={"model": "qwen3:404b"})

    assert resp.status_code == 404, resp.text
    said = resp.text
    assert "qwen3:404b" in said
    assert "not in the ollama library" in said
    # Named from the curated list, which holds other qwen3 tags, and the
    # sentence says that is where they came from.
    assert "curated list has" in said
    assert "qwen3:" in said.split("curated list has", 1)[1]
    assert ollama.seen == [], "ollama was called for a tag the registry had already refused"


@pytest.mark.parametrize(
    "model",
    [
        "../etc",
        "-bad",
        "qwen3:8b:extra",
        "qwen3 8b",
        "hf.co/org/repo?x=1",
        "",
        42,
        "a:b/c",
        # S40: an engine prefix is split off BEFORE the ref is validated, so
        # the ref still gets exactly one colon of its own — and an engine
        # named with no model is no ref at all.
        "hub:qwen3:8b:extra",
        "hub:",
    ],
)
async def test_a_malformed_model_string_is_a_400_before_anything_is_called(
    client, ollama, upstreams, model
):
    resp = await client.post("/admin/pull", json={"model": model})

    assert resp.status_code == 400
    assert ollama.seen == []
    assert upstreams.registry.seen == [] and upstreams.hub.seen == []


async def test_a_second_pull_of_the_same_model_while_one_streams_is_a_409(
    client, pool, monkeypatch, mount_backend
):
    """A cannot, not a may-not: ollama would run two downloads against the
    same blobs and the second stream's progress would be a story about the
    first. The refusal names when the first started; finishing releases it."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    gate = asyncio.Event()
    fake = FakeOllama(pull_gate=gate)
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    first = asyncio.create_task(client.post("/admin/pull", json={"model": "qwen3:8b"}))
    for _ in range(500):
        if fake.seen and ("hub", "library/qwen3:8b") in admin._PULLS_IN_FLIGHT:
            break
        await asyncio.sleep(0.01)
    # S40: keyed per machine — the same ref onto two machines is two downloads.
    assert ("hub", "library/qwen3:8b") in admin._PULLS_IN_FLIGHT, (
        "keyed on the ENGINE and the CANONICAL ref"
    )

    second = await client.post("/admin/pull", json={"model": "qwen3:8b"})
    assert second.status_code == 409
    assert "'qwen3:8b' has been in flight since 20" in second.json()["error"]
    # The same download spelled another way is the same pull.
    spelled = await client.post("/admin/pull", json={"model": "library/qwen3:8b"})
    assert spelled.status_code == 409
    assert len([p for p, _ in fake.seen if p == "/api/pull"]) == 1, "never reached ollama"

    gate.set()
    resp = await first
    assert resp.status_code == 200
    assert _lines(resp.content)[-1] == {"status": "success"}
    assert admin._PULLS_IN_FLIGHT == {}

    again = await client.post("/admin/pull", json={"model": "qwen3:8b"})
    assert again.status_code == 200


async def test_a_pull_ollama_refuses_releases_the_in_flight_slot(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    mount_backend("http://ollama.test", FakeOllama(pull_status=404).app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/pull", json={"model": "does-not-exist"})

    assert resp.status_code == 404
    assert admin._PULLS_IN_FLIGHT == {}


def test_canonical_ref_folds_the_spellings_of_one_download_together():
    """`qwen3:8b`, `library/qwen3:8b` and `qwen3:8b` with the default tag
    spelled are one registry download; a Hub ref is case-insensitive and
    its default quant is named, since ollama pulls the same Q4_K_M whether
    or not it is typed."""
    assert pulls.canonical_ref("qwen3:8b") == "library/qwen3:8b"
    assert pulls.canonical_ref("library/qwen3:8b") == "library/qwen3:8b"
    assert pulls.canonical_ref("qwen3") == "library/qwen3:latest"
    assert pulls.canonical_ref("someone/model:tag") == "someone/model:tag"
    assert pulls.canonical_ref(f"hf.co/{REPO}") == pulls.canonical_ref(f"HF.co/{REPO}:Q4_K_M")
    assert pulls.canonical_ref(f"hf.co/{REPO}:Q8_0") != pulls.canonical_ref(f"hf.co/{REPO}")
    assert pulls.canonical_ref("ghcr.io/x/y:1") == "ghcr.io/x/y:1"
    # ollama stores a quant-less Hub pull as `:latest`: the same download.
    assert pulls.canonical_ref(f"hf.co/{REPO}:latest") == pulls.canonical_ref(f"hf.co/{REPO}")


async def test_an_unreadable_registry_config_is_said_on_the_preflight_line(
    client, ollama, upstreams
):
    """The manifest still sizes the pull; quant/family/params are unstated
    and the line SAYS why, rather than an empty `resolved` reading as
    'nothing to resolve'."""
    ollama_registry.clear()  # the config is content-addressed; an earlier test cached it
    upstreams.registry.blobs = {}

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    line = _lines(resp.content)[0]
    assert line["status"] == "preflight" and line["size_source"] == pulls.SOURCE_REGISTRY
    assert "resolved" not in line
    assert "config blob could not be read" in line["note"]
    assert _lines(resp.content)[-1] == {"status": "success"}


# ── S40: a pull is about a machine ─────────────────────────────────────────


async def test_a_cloud_default_no_longer_blocks_a_pull_to_the_machine(client, pool, ollama):
    """Replaces test_pull_is_refused_for_a_non_ollama_backend (S40, on purpose).

    That pinned "pull is only supported for the ollama backend" — a rule about
    which provider was the DEFAULT, from when the default was the only backend.
    A pull is about a machine: with a cloud default the hub still runs models,
    and a bare ref means the one machine there is."""
    await backends.save_config(
        pool, {"kind": "cloud", "url": "https://x", "api_key": "sk-x", "model": "m"}
    )

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    assert _lines(resp.content)[0]["engine"] == "hub"
    assert ollama.seen[-1] == ("/api/pull", {"model": "qwen3:8b"})


async def test_a_cloud_providers_prefix_names_no_machine(client, pool, ollama):
    await backends.save_config(
        pool, {"kind": "cloud", "url": "https://x", "api_key": "sk-x", "model": "m"}
    )

    resp = await client.post("/admin/pull", json={"model": "cloud:qwen3:8b"})

    assert resp.status_code == 400
    assert "'cloud' is not a machine that runs models" in resp.json()["error"]
    assert ollama.seen == []


async def test_a_bare_ref_with_two_machines_is_refused_naming_both(
    client, ollama, second_engine, upstreams
):
    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    assert resp.status_code == 400
    error = resp.json()["error"]
    assert "hub:qwen3:8b" in error and "dell:qwen3:8b" in error
    assert ollama.seen == [] and second_engine.seen == []
    assert upstreams.registry.seen == [], "refused before anything was sized"


async def test_a_library_rows_own_id_pulls_its_model_onto_the_machine(client, pool, ollama):
    """(S40 fix wave C2) A curated pick no machine holds is listed as
    `library:<tag>` (and a Hub row as `library:hf.co/…`), and a client that
    pulls a row sends the row's id. `library` names no machine: the id is the
    model after it, bound for the one machine there is — exactly as a bare
    ref is."""
    resp = await client.post("/admin/pull", json={"model": "library:qwen3:8b"})

    assert resp.status_code == 200, resp.text
    assert _lines(resp.content)[0]["engine"] == "hub"
    assert ollama.seen[-1] == ("/api/pull", {"model": "qwen3:8b"})


async def test_a_library_id_with_two_machines_is_refused_naming_both(
    client, ollama, second_engine, upstreams
):
    resp = await client.post("/admin/pull", json={"model": "library:qwen3:8b"})

    assert resp.status_code == 400
    error = resp.json()["error"]
    assert "hub:qwen3:8b" in error and "dell:qwen3:8b" in error
    assert "library:" not in error.split("name it:")[-1]
    assert ollama.seen == [] and second_engine.seen == []


async def test_a_qualified_pull_goes_to_that_machine(
    client, ollama, second_engine, monkeypatch, tmp_path
):
    monkeypatch.setattr(admin, "MODELS_DIR", tmp_path)

    resp = await client.post("/admin/pull", json={"model": "dell:qwen3:8b"})

    assert resp.status_code == 200
    line = _lines(resp.content)[0]
    assert line["engine"] == "dell" and line["size_source"] == "ollama-registry"
    assert "required_gb" not in line, "this hub's disk is not dell's"
    assert "free space on dell cannot be read from this hub" in line["note"]
    assert second_engine.seen[-1] == ("/api/pull", {"model": "qwen3:8b"})
    assert not any(path == "/api/pull" for path, _ in ollama.seen)


async def test_the_same_ref_onto_two_machines_is_two_pulls(
    client, pool, monkeypatch, mount_backend, second_engine
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    gate = asyncio.Event()
    hub = FakeOllama(pull_gate=gate)
    mount_backend("http://ollama.test", hub.app)

    first = asyncio.create_task(client.post("/admin/pull", json={"model": "hub:qwen3:8b"}))
    for _ in range(500):
        if ("hub", "library/qwen3:8b") in admin._PULLS_IN_FLIGHT:
            break
        await asyncio.sleep(0.01)
    assert ("hub", "library/qwen3:8b") in admin._PULLS_IN_FLIGHT

    onto_dell = await client.post("/admin/pull", json={"model": "dell:qwen3:8b"})
    assert onto_dell.status_code == 200, "a download onto dell is not the hub's download"
    again = await client.post("/admin/pull", json={"model": "hub:qwen3:8b"})
    assert again.status_code == 409
    assert "on hub" in again.json()["error"]

    gate.set()
    assert (await first).status_code == 200
    assert admin._PULLS_IN_FLIGHT == {}


async def test_a_finished_pull_forgets_that_machines_cached_tags(client, ollama, monkeypatch):
    """Routing reads installed tags through the engines cache (30 s when
    ready): a model just pulled must not read `not_installed` for that long.
    Only the machine that changed is forgotten (the other engines keep their
    readings — S40 ruling C11's rule)."""
    forgotten: list[str] = []
    monkeypatch.setattr(engines, "forget", forgotten.append)

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    assert _lines(resp.content)[-1] == {"status": "success"}
    assert forgotten == ["hub"]
