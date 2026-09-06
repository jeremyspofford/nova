"""ollama's own facts about every installed model (POST /api/show), read
into the catalogue's fact shape.

The rules these tests defend: a fact ollama did not state is ABSENT (its
capability list is a manifest, not a denial); every fact says it is
`declared` by `ollama-show`; the fan-out is bounded and cached by the
/api/tags digest (content-addressed, so a re-pull invalidates by itself);
one failing show is a note on that name in ollama's words, never a raise
that empties the whole listing.
"""
from __future__ import annotations

import copy

import pytest
from starlette.responses import PlainTextResponse

from app.adapters import ollama
from app.adapters.base import ProviderRefused
from app.main import app
from tests.fakes import QWEN3_8B_SHOW, FakeOllama

DECLARED = {"basis": "declared", "source": "ollama-show"}

OLLAMA_URL = "http://ollama.test"


@pytest.fixture(autouse=True)
def _fresh_cache():
    ollama.SHOW_CACHE.clear()
    yield
    ollama.SHOW_CACHE.clear()


def _shows(fake: FakeOllama) -> list[str]:
    return [body["model"] for path, body in fake.seen if path == "/api/show"]


# ── show_to_facts, pure ──────────────────────────────────────────────────


def test_show_to_facts_reads_the_live_qwen3_8b_shape():
    facts, capabilities = ollama.show_to_facts(QWEN3_8B_SHOW)

    assert facts == {
        "params_b": {"value": 8.19, **DECLARED},
        "quant": {"value": "Q4_K_M", **DECLARED},
        "context_length": {"value": 40960, **DECLARED},
        "family": {"value": "qwen3", **DECLARED},
        "license": {"value": "Apache License", **DECLARED},
    }
    # parent_model is "" on this row — an empty string is not a fact.
    assert "parent_model" not in facts
    assert capabilities == {
        "completion": {"value": True, **DECLARED},
        "tools": {"value": True, **DECLARED},
        "thinking": {"value": True, **DECLARED},
    }
    # Not listed is not stated — never `False`.
    for absent in ("vision", "embedding", "insert", "image", "audio"):
        assert absent not in capabilities


def test_parent_model_is_a_fact_when_stated():
    show = copy.deepcopy(QWEN3_8B_SHOW)
    show["details"]["parent_model"] = "qwen3:8b"
    facts, _ = ollama.show_to_facts(show)
    assert facts["parent_model"] == {"value": "qwen3:8b", **DECLARED}


def test_the_context_key_is_namespaced_by_the_architecture():
    show = {
        "model_info": {
            "general.architecture": "llama",
            "llama.context_length": 131072,
            "llama.embedding_length": 4096,
        }
    }
    facts, _ = ollama.show_to_facts(show)
    assert facts["context_length"]["value"] == 131072


def test_without_an_architecture_the_first_context_length_key_is_used():
    facts, _ = ollama.show_to_facts(
        {"model_info": {"gemma3.embedding_length": 2560, "gemma3.context_length": 131072}}
    )
    assert facts["context_length"]["value"] == 131072
    # An architecture whose namespaced key is missing falls back the same way.
    facts, _ = ollama.show_to_facts(
        {"model_info": {"general.architecture": "clip", "gemma3.context_length": 8192}}
    )
    assert facts["context_length"]["value"] == 8192
    # No such key at all: absent, never zero.
    facts, _ = ollama.show_to_facts({"model_info": {"general.architecture": "clip"}})
    assert "context_length" not in facts


@pytest.mark.parametrize(
    ("parameter_size", "expected"),
    [("8.2B", 8.2), ("30.5B", 30.5), ("494.03M", 0.49), ("1.2T", 1200.0), ("unknown", None)],
)
def test_params_come_from_parameter_size_when_the_count_is_absent(parameter_size, expected):
    facts, _ = ollama.show_to_facts({"details": {"parameter_size": parameter_size}})
    if expected is None:
        assert "params_b" not in facts
    else:
        assert facts["params_b"] == {"value": expected, **DECLARED}


def test_the_parameter_count_beats_the_rounded_size_label():
    facts, _ = ollama.show_to_facts(
        {
            "details": {"parameter_size": "8.2B"},
            "model_info": {"general.parameter_count": 8190735360},
        }
    )
    assert facts["params_b"]["value"] == 8.19


def test_an_empty_show_states_nothing():
    assert ollama.show_to_facts({}) == ({}, {})
    # Wrong types are not facts either.
    assert ollama.show_to_facts(
        {"details": "x", "model_info": [], "capabilities": "tools", "license": 3}
    ) == ({}, {})


def test_license_is_the_first_non_empty_line_only():
    facts, _ = ollama.show_to_facts({"license": "\n\n   MIT License\n\nCopyright (c) 2024\n"})
    assert facts["license"] == {"value": "MIT License", **DECLARED}


# ── tags_to_models extras ────────────────────────────────────────────────


def test_tags_to_models_carries_digest_modified_at_and_context_length():
    rows = ollama.tags_to_models(
        {
            "models": [
                {
                    "name": "qwen3:8b",
                    "model": "qwen3:8b",
                    "modified_at": "2026-08-30T12:00:00.000000-07:00",
                    "size": 5225388164,
                    "digest": "sha256:abc",
                    "details": {
                        "parent_model": "",
                        "format": "gguf",
                        "family": "qwen3",
                        "families": ["qwen3"],
                        "parameter_size": "8.2B",
                        "quantization_level": "Q4_K_M",
                        "context_length": 40960,
                        "embedding_length": 4096,
                    },
                },
                {"name": "bare:1b"},
            ]
        }
    )
    assert rows[0] == {
        "id": "qwen3:8b",
        "owned_by": "ollama",
        "size_bytes": 5225388164,
        "family": "qwen3",
        "parameter_size": "8.2B",
        "quantization_level": "Q4_K_M",
        "digest": "sha256:abc",
        "modified_at": "2026-08-30T12:00:00.000000-07:00",
        "context_length": 40960,
    }
    # A row that states none of them carries none of them.
    assert rows[1] == {"id": "bare:1b", "owned_by": "ollama"}


# ── show, over the wire ──────────────────────────────────────────────────


async def test_show_returns_ollamas_body_and_refuses_in_its_words(mount_backend):
    fake = FakeOllama(tags=("qwen3:8b",))
    mount_backend(OLLAMA_URL, fake.app)

    body = await ollama.show(app, OLLAMA_URL, "qwen3:8b")
    assert body["capabilities"] == ["completion", "tools", "thinking"]
    assert fake.seen[-1] == ("/api/show", {"model": "qwen3:8b"})

    with pytest.raises(ProviderRefused) as refused:
        await ollama.show(app, OLLAMA_URL, "ghost:1b")
    assert refused.value.status == 404
    assert refused.value.detail == "model 'ghost:1b' not found"


async def test_a_non_json_show_is_refused_not_parsed_into_facts(mount_backend):
    class Html(FakeOllama):
        async def _show(self, request):
            await self._record(request)
            return PlainTextResponse("<html>proxy error</html>")

    mount_backend(OLLAMA_URL, Html().app)
    with pytest.raises(ProviderRefused) as refused:
        await ollama.show(app, OLLAMA_URL, "qwen3:8b")
    assert refused.value.status == 502
    assert "non-JSON" in refused.value.detail


async def test_an_unreachable_ollama_is_a_502_with_the_reason():
    with pytest.raises(ProviderRefused) as refused:
        await ollama.show(app, "http://127.0.0.1:1", "qwen3:8b")
    assert refused.value.status == 502
    assert "could not reach ollama at http://127.0.0.1:1" in refused.value.detail


# ── facts_for_installed ──────────────────────────────────────────────────


async def test_facts_for_installed_reads_every_row_and_labels_the_fetch(mount_backend):
    fake = FakeOllama(tags=("qwen3:8b", "mistral:7b"))
    mount_backend(OLLAMA_URL, fake.app)
    rows = [{"id": "qwen3:8b", "digest": "sha256:a"}, {"id": "mistral:7b", "digest": "sha256:b"}]

    out = await ollama.facts_for_installed(app, OLLAMA_URL, rows)

    assert set(out) == {"qwen3:8b", "mistral:7b"}
    qwen = out["qwen3:8b"]
    assert qwen["facts"]["family"] == {"value": "qwen3", **DECLARED}
    assert qwen["capabilities"]["tools"] == {"value": True, **DECLARED}
    assert qwen["cached"] is False and qwen["note"] is None and qwen["fetched_at"]
    # The derived mistral row's context key is `mistral.context_length`.
    assert out["mistral:7b"]["facts"]["context_length"]["value"] == 40960
    assert out["mistral:7b"]["facts"]["family"]["value"] == "mistral"
    assert sorted(_shows(fake)) == ["mistral:7b", "qwen3:8b"]


async def test_a_second_call_is_served_from_the_digest_cache(mount_backend):
    fake = FakeOllama(tags=("qwen3:8b", "qwen3:4b"))
    mount_backend(OLLAMA_URL, fake.app)
    rows = [{"id": "qwen3:8b", "digest": "sha256:a"}, {"id": "qwen3:4b", "digest": "sha256:b"}]

    first = await ollama.facts_for_installed(app, OLLAMA_URL, rows)
    assert len(_shows(fake)) == 2
    second = await ollama.facts_for_installed(app, OLLAMA_URL, rows)

    # ZERO new /api/show calls, and the ORIGINAL fetch time, marked cached.
    assert len(_shows(fake)) == 2
    for name in ("qwen3:8b", "qwen3:4b"):
        assert second[name]["cached"] is True
        assert second[name]["fetched_at"] == first[name]["fetched_at"]
        assert second[name]["facts"] == first[name]["facts"]
        assert second[name]["capabilities"] == first[name]["capabilities"]

    # A re-pull changes the digest: exactly that one row is fetched again.
    rows[0]["digest"] = "sha256:a-repulled"
    third = await ollama.facts_for_installed(app, OLLAMA_URL, rows)
    assert _shows(fake)[2:] == ["qwen3:8b"]
    assert third["qwen3:8b"]["cached"] is False
    assert third["qwen3:4b"]["cached"] is True


async def test_a_cached_answer_cannot_be_poisoned_by_a_caller(mount_backend):
    fake = FakeOllama(tags=("qwen3:8b",))
    mount_backend(OLLAMA_URL, fake.app)
    rows = [{"id": "qwen3:8b", "digest": "sha256:a"}]
    first = await ollama.facts_for_installed(app, OLLAMA_URL, rows)
    first["qwen3:8b"]["facts"]["family"]["value"] = "tampered"
    second = await ollama.facts_for_installed(app, OLLAMA_URL, rows)
    assert second["qwen3:8b"]["facts"]["family"]["value"] == "qwen3"


async def test_the_fakes_own_tags_rows_flow_through_to_the_digest_cache(mount_backend, monkeypatch):
    """End to end: /api/tags → tags_to_models → facts_for_installed keys the
    cache by the digest /api/tags stated, so the real listing's rows are
    what a second call is served from."""
    monkeypatch.setenv("OLLAMA_URL", OLLAMA_URL)
    fake = FakeOllama(tags=("qwen3:8b", "qwen3:4b"))
    mount_backend(OLLAMA_URL, fake.app)
    listing = await ollama.ADAPTER.list_models(app, {"name": "ollama", "adapter": "ollama"})
    assert all(row["digest"].startswith("sha256:") for row in listing.models)
    assert listing.models[0]["context_length"] == 40960

    await ollama.facts_for_installed(app, OLLAMA_URL, listing.models)
    again = await ollama.facts_for_installed(app, OLLAMA_URL, listing.models)
    assert len(_shows(fake)) == 2
    assert all(entry["cached"] for entry in again.values())

    # The re-pull, as ollama would report it: a new digest on /api/tags.
    fake.tag_rows["qwen3:8b"] = {"digest": "sha256:" + "f" * 64}
    listing = await ollama.ADAPTER.list_models(app, {"name": "ollama", "adapter": "ollama"})
    after = await ollama.facts_for_installed(app, OLLAMA_URL, listing.models)
    assert _shows(fake)[2:] == ["qwen3:8b"]
    assert after["qwen3:8b"]["cached"] is False and after["qwen3:4b"]["cached"] is True


async def test_a_row_without_a_digest_is_fetched_every_time_and_never_cached(mount_backend):
    fake = FakeOllama(tags=("qwen3:8b",))
    mount_backend(OLLAMA_URL, fake.app)
    rows = [{"id": "qwen3:8b"}]
    await ollama.facts_for_installed(app, OLLAMA_URL, rows)
    out = await ollama.facts_for_installed(app, OLLAMA_URL, rows)
    assert len(_shows(fake)) == 2
    assert out["qwen3:8b"]["cached"] is False
    assert out["qwen3:8b"]["facts"]["family"]["value"] == "qwen3"
    assert len(ollama.SHOW_CACHE) == 0


async def test_one_failing_show_is_a_note_on_that_name_never_a_raise(mount_backend):
    fake = FakeOllama(tags=("qwen3:8b", "ghost:1b"))
    del fake.show["ghost:1b"]
    mount_backend(OLLAMA_URL, fake.app)
    rows = [{"id": "qwen3:8b", "digest": "sha256:a"}, {"id": "ghost:1b", "digest": "sha256:g"}]

    out = await ollama.facts_for_installed(app, OLLAMA_URL, rows)

    ghost = out["ghost:1b"]
    assert ghost["facts"] == {} and ghost["capabilities"] == {}
    assert ghost["cached"] is False
    assert ghost["note"] == "model 'ghost:1b' not found"
    assert ghost["fetched_at"]
    assert out["qwen3:8b"]["facts"]["family"]["value"] == "qwen3"
    assert out["qwen3:8b"]["note"] is None

    # A refusal is not a fact about the content: it is retried next time.
    await ollama.facts_for_installed(app, OLLAMA_URL, rows)
    assert _shows(fake).count("ghost:1b") == 2
    assert _shows(fake).count("qwen3:8b") == 1


async def test_a_dead_ollama_notes_every_row_and_still_returns():
    rows = [{"id": "a:1b", "digest": "sha256:a"}, {"id": "b:1b", "digest": "sha256:b"}]
    out = await ollama.facts_for_installed(app, "http://127.0.0.1:1", rows)
    assert set(out) == {"a:1b", "b:1b"}
    for entry in out.values():
        assert entry["facts"] == {}
        assert "could not reach ollama at http://127.0.0.1:1" in entry["note"]


async def test_the_fan_out_never_has_more_than_four_shows_in_flight(mount_backend):
    names = tuple(f"model{i}:1b" for i in range(9))
    fake = FakeOllama(tags=names, show_delay_s=0.02)
    mount_backend(OLLAMA_URL, fake.app)
    rows = [{"id": name, "digest": f"sha256:{i}"} for i, name in enumerate(names)]

    out = await ollama.facts_for_installed(app, OLLAMA_URL, rows)

    assert len(out) == 9
    assert fake.show_max_in_flight == ollama.SHOW_CONCURRENCY == 4


async def test_rows_without_a_name_are_skipped_not_shown(mount_backend):
    fake = FakeOllama(tags=("qwen3:8b",))
    mount_backend(OLLAMA_URL, fake.app)
    out = await ollama.facts_for_installed(app, OLLAMA_URL, [{"digest": "sha256:x"}, {}])
    assert out == {}
    assert _shows(fake) == []
