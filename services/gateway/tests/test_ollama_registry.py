"""app/ollama_registry.py — registry.ollama.ai read live, in the shapes
verified on 2026-09-06 (a qwen3:8b manifest and its config blob, trimmed).

FakeOllamaRegistry is mounted by origin on the real app; nothing here
opens a socket except the one test that points REGISTRY_BASE at a closed
port to see the failure stated."""
from __future__ import annotations

import pytest

from app import ollama_registry as reg
from app.adapters import ProviderRefused
from app.main import app
from tests.fakes import FakeOllamaRegistry

CONFIG_DIGEST = "sha256:" + "c" * 64
WEIGHTS_DIGEST = "sha256:" + "a" * 64
MANIFEST_DIGEST = "sha256:" + "9" * 64

MANIFEST = {
    "schemaVersion": 2,
    "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
    "config": {
        "mediaType": "application/vnd.docker.container.image.v1+json",
        "digest": CONFIG_DIGEST,
        "size": 487,
    },
    "layers": [
        {
            "mediaType": "application/vnd.ollama.image.model",
            "digest": WEIGHTS_DIGEST,
            "size": 5225374496,
        },
        {
            "mediaType": "application/vnd.ollama.image.template",
            "digest": "sha256:" + "1" * 64,
            "size": 1574,
        },
        {
            "mediaType": "application/vnd.ollama.image.license",
            "digest": "sha256:" + "2" * 64,
            "size": 11343,
        },
        {
            "mediaType": "application/vnd.ollama.image.params",
            "digest": "sha256:" + "3" * 64,
            "size": 96,
        },
    ],
}
TOTAL = 5225374496 + 1574 + 11343 + 96

CONFIG = {
    "model_format": "gguf",
    "model_family": "qwen3",
    "model_families": ["qwen3"],
    "model_type": "8.2B",
    "file_type": "Q4_K_M",
    "architecture": "amd64",
    "os": "linux",
    "rootfs": {"type": "layers", "diff_ids": [WEIGHTS_DIGEST]},
}


@pytest.fixture
def registry(mount_backend):
    fake = FakeOllamaRegistry(
        manifests={"library/qwen3/8b": MANIFEST, "jeremy/custom/latest": MANIFEST},
        blobs={CONFIG_DIGEST: CONFIG},
        digests={"library/qwen3/8b": MANIFEST_DIGEST},
    )
    mount_backend(reg.REGISTRY_BASE, fake.app)
    return fake


# ── split_ref ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("qwen3:8b", ("library", "qwen3", "8b")),
        ("qwen3", ("library", "qwen3", "latest")),
        ("qwen3.8:27b", ("library", "qwen3.8", "27b")),
        ("user/name:tag", ("user", "name", "tag")),
        ("user/name", ("user", "name", "latest")),
        ("registry.ollama.ai/library/qwen3:8b", ("library", "qwen3", "8b")),
    ],
)
def test_split_ref_reads_ollamas_reference_forms(model, expected):
    ref = reg.split_ref(model)
    assert (ref.namespace, ref.name, ref.tag) == expected
    assert ref.path == "/".join(expected)


@pytest.mark.parametrize(
    "model",
    ["hf.co/unsloth/Qwen3-8B-GGUF", "HF.co/x/y:Q4_K_M", "huggingface.co/x/y", "ghcr.io/x/y:1"],
)
def test_split_ref_says_when_a_ref_is_not_the_ollama_registrys(model):
    with pytest.raises(reg.NotARegistryRef):
        reg.split_ref(model)


@pytest.mark.parametrize(
    "model", ["", "-bad:tag", "qwen3:", "qwen3:8b:extra", "a/b/c/d", "qwen3:" + "x" * 129, "a b"]
)
def test_split_ref_refuses_a_malformed_segment(model):
    with pytest.raises(ValueError):
        reg.split_ref(model)


# ── manifest ───────────────────────────────────────────────────────────────


async def test_manifest_parses_layers_and_carries_the_registrys_digest(registry):
    parsed = await reg.manifest(app, "qwen3:8b")

    path, headers = registry.seen[0]
    assert path == "/v2/library/qwen3/manifests/8b"
    assert headers["accept"] == "application/vnd.docker.distribution.manifest.v2+json"
    assert parsed.weights_bytes == 5225374496
    assert parsed.total_bytes == TOTAL
    assert parsed.config_digest == CONFIG_DIGEST
    assert parsed.config_size == 487
    assert parsed.digest == MANIFEST_DIGEST
    assert [layer["mediaType"] for layer in parsed.layers] == [
        "application/vnd.ollama.image.model",
        "application/vnd.ollama.image.template",
        "application/vnd.ollama.image.license",
        "application/vnd.ollama.image.params",
    ]
    assert parsed.cached is False
    assert parsed.ref.path == "library/qwen3/8b"


async def test_manifest_without_a_digest_header_states_none(registry):
    parsed = await reg.manifest(app, "jeremy/custom")
    assert parsed.digest is None
    assert registry.seen[-1][0] == "/v2/jeremy/custom/manifests/latest"


async def test_a_404_says_the_tag_is_not_in_the_library(registry):
    with pytest.raises(ProviderRefused) as exc:
        await reg.manifest(app, "qwen3:999b")
    assert exc.value.status == 404
    assert exc.value.detail == "'qwen3:999b' is not in the ollama library (registry answered 404)"


async def test_another_refusal_carries_the_registrys_status_and_words(registry):
    registry.status = 503
    with pytest.raises(ProviderRefused) as exc:
        await reg.manifest(app, "qwen3:8b")
    assert exc.value.status == 503
    assert "503" in exc.value.detail


async def test_an_unreachable_registry_is_a_stated_502(monkeypatch):
    monkeypatch.setattr(reg, "REGISTRY_BASE", "http://127.0.0.1:1")
    with pytest.raises(ProviderRefused) as exc:
        await reg.manifest(app, "qwen3:8b")
    assert exc.value.status == 502
    assert "could not reach the ollama registry" in exc.value.detail


async def test_a_hub_ref_never_reaches_the_registry(registry):
    with pytest.raises(reg.NotARegistryRef):
        await reg.manifest(app, "hf.co/unsloth/Qwen3-8B-GGUF")
    assert registry.seen == []


async def test_manifest_is_cached_an_hour_with_its_original_fetched_at(registry, monkeypatch):
    now = [0.0]
    monkeypatch.setattr(reg, "MANIFEST_CACHE", reg.TTLCache(3600, clock=lambda: now[0]))

    first = await reg.manifest(app, "qwen3:8b")
    now[0] = 3599
    again = await reg.manifest(app, "qwen3:8b")
    assert again.cached is True
    assert again.fetched_at == first.fetched_at
    assert again.total_bytes == first.total_bytes
    assert len(registry.seen) == 1

    now[0] = 3601
    await reg.manifest(app, "qwen3:8b")
    assert len(registry.seen) == 2


def test_parse_manifest_refuses_a_layer_without_a_size():
    """A total that silently skipped a layer would read as a smaller
    download than the real one."""
    body = {"layers": [{"mediaType": reg.MODEL_LAYER, "digest": "sha256:x"}]}
    with pytest.raises(ValueError, match="states no size"):
        reg.parse_manifest("m", reg.split_ref("m"), body, None)
    with pytest.raises(ValueError, match="no layers"):
        reg.parse_manifest("m", reg.split_ref("m"), {"schemaVersion": 2}, None)


def test_parse_manifest_without_a_model_layer_leaves_weights_absent():
    body = {"layers": [{"mediaType": "application/vnd.ollama.image.params", "size": 96}]}
    parsed = reg.parse_manifest("m", reg.split_ref("m"), body, None)
    assert parsed.weights_bytes is None
    assert parsed.total_bytes == 96


# ── config + facts ─────────────────────────────────────────────────────────


async def test_config_fetches_the_blob_and_facts_read_model_family_not_architecture(registry):
    parsed = await reg.manifest(app, "qwen3:8b")
    cfg = await reg.config(app, "qwen3:8b", parsed.config_digest)

    assert registry.seen[-1][0] == f"/v2/library/qwen3/blobs/{CONFIG_DIGEST}"
    facts = reg.manifest_to_facts(parsed, cfg)
    declared = {"basis": "declared", "source": "ollama-registry"}
    assert facts == {
        "size_bytes": {"value": TOTAL, **declared},
        "weights_bytes": {"value": 5225374496, **declared},
        "digest": {"value": MANIFEST_DIGEST, **declared},
        "quant": {"value": "Q4_K_M", **declared},
        "params_b": {"value": 8.2, **declared},
        "family": {"value": "qwen3", **declared},
    }
    assert "amd64" not in str(facts), "the blob's architecture is the CPU's, never the model's"


async def test_config_follows_the_registrys_307_to_its_blob_store(registry):
    """Seen live on 2026-09-06: the blob GET is a 307 to another host.
    Not following it left quant / family / params silently absent on
    every registry-sized pull."""
    registry.redirect_blobs = True
    parsed = await reg.manifest(app, "qwen3:8b")

    cfg = await reg.config(app, "qwen3:8b", parsed.config_digest)

    assert cfg["file_type"] == "Q4_K_M"
    assert [p for p, _ in registry.seen][1:] == [
        f"/v2/library/qwen3/blobs/{CONFIG_DIGEST}",
        f"/store/{CONFIG_DIGEST}",
    ]


async def test_config_is_content_addressed_and_cached(registry):
    parsed = await reg.manifest(app, "qwen3:8b")
    await reg.config(app, "qwen3:8b", parsed.config_digest)
    await reg.config(app, "qwen3:8b", parsed.config_digest)
    assert len([p for p, _ in registry.seen if "/blobs/" in p]) == 1


async def test_config_refuses_a_non_digest_before_any_request(registry):
    with pytest.raises(ValueError):
        await reg.config(app, "qwen3:8b", "../../etc/passwd")
    with pytest.raises(ValueError):
        await reg.config(app, "qwen3:8b", "sha256:short")
    assert registry.seen == []


async def test_a_missing_config_blob_is_a_stated_404(registry):
    with pytest.raises(ProviderRefused) as exc:
        await reg.config(app, "qwen3:8b", "sha256:" + "0" * 64)
    assert exc.value.status == 404


def test_manifest_to_facts_without_a_config_states_only_the_manifests_facts():
    parsed = reg.parse_manifest("qwen3:8b", reg.split_ref("qwen3:8b"), MANIFEST, None)
    facts = reg.manifest_to_facts(parsed, None)
    assert set(facts) == {"size_bytes", "weights_bytes"}


@pytest.mark.parametrize(
    ("model_type", "expected"),
    [
        ("8.2B", 8.2),
        ("235B", 235.0),
        ("1.7B", 1.7),
        ("500M", 0.5),
        ("30.5b", 30.5),
        ("large", None),
        (None, None),
    ],
)
def test_parse_params_b(model_type, expected):
    assert reg.parse_params_b(model_type) == expected
