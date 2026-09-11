"""S10a-3: her model tools — model_catalog_search and model_pull.

Pins: every fact in a search result names its basis in words; a numeric
filter that drops rows lacking the fact SAYS how many; scope 'hf' reaches
the Hub route with the query and a 429 is a stated failure, never an empty
list; an unreachable gateway is a failure, never "no models"; a pull
refuses a cloud id before touching the gateway, states a preflight that
does not fit with the numbers, relays ollama's own error, reports progress
through the context, and is a SUCCESS only when the re-read catalogue
lists the model — with set_as_chat_model read back."""

from __future__ import annotations

import pytest

from app.main import app
from app.tools import models
from app.tools.base import ERROR_PREFIX, ToolContext, ToolFailure
from tests import fakes
from tests.conftest import requires_db


def fact(value, basis="declared", source="ollama-show", **extra):
    return {"value": value, "basis": basis, "source": source, **extra}


INSTALLED = {
    "id": "ollama:qwen3:8b",
    "provider": "ollama",
    "model": "qwen3:8b",
    "label": "Qwen3 8B",
    "kind": "local",
    "installed": True,
    "note": None,
    "sources": [{"key": "ollama-show", "fetched_at": "2026-09-07T10:00:00+00:00"}],
    "facts": {
        "size_bytes": fact(5_225_388_164, source="ollama-tags"),
        "digest": fact("sha256:801dca2ad3f2a1b9c0d0", source="ollama-tags"),
        "params_b": fact(8.19),
        "quant": fact("Q4_K_M"),
        "context_length": fact(40960),
    },
    "capabilities": {"tools": fact(True), "thinking": fact(True)},
    "suitability": {
        "chat": fact(True, "vetted", "curated", at="2026-09-06"),
        "coding:inferred": fact(True, "inferred", "name", note="name matches /coder/"),
        "agent_quality": fact(0.857, "measured", "core-evals", at="2026-09-04T00:00:00Z"),
    },
    "fit": {"verdict": "comfortable", "source": "verified", "reason": None},
    "probe": None,
    "drift": None,
    "pull": None,
    "actions": ["use", "probe"],
}
LIBRARY = {
    **INSTALLED,
    "id": "ollama:qwen3:4b",
    "model": "qwen3:4b",
    "label": "Qwen3 4B",
    "installed": False,
    "facts": {"params_b": fact(4.0, "vetted", "curated", at="2026-08-29")},
    "capabilities": {},
    "suitability": {"chat": fact(True, "vetted", "curated", at="2026-09-06")},
    "fit": {"verdict": "comfortable", "source": "estimated", "reason": None},
    "actions": ["pull"],
}
CLOUD = {
    **INSTALLED,
    "id": "openrouter:openai/gpt-6-astra",
    "provider": "openrouter",
    "model": "openai/gpt-6-astra",
    "label": "OpenAI: GPT-6 Astra",
    "kind": "cloud",
    "installed": None,
    "sources": [{"key": "provider-listing", "fetched_at": "2026-09-07T10:00:00+00:00"}],
    "facts": {
        "context_length": fact(1_050_000, source="provider-listing"),
        "price_prompt": fact(1e-05, source="provider-listing"),
        "price_completion": fact(5e-05, source="provider-listing"),
    },
    "capabilities": {
        "tools": fact(True, source="provider-listing"),
        "vision": fact(True, source="provider-listing"),
    },
    "suitability": {"coding": fact(76.9, source="provider-listing", note="third-party")},
    "fit": None,
    "actions": ["use"],
}
HUB = {
    **INSTALLED,
    "id": "ollama:hf.co/unsloth/Qwen3-Coder-GGUF",
    "model": "hf.co/unsloth/Qwen3-Coder-GGUF",
    "label": "Qwen3-Coder-GGUF",
    "kind": "hub",
    "installed": False,
    "sources": [{"key": "hf-hub", "fetched_at": "2026-09-07T10:00:00+00:00"}],
    "facts": {
        "params_b": fact(30.5, source="hf-hub"),
        "downloads": fact(12_639_566, source="hf-hub"),
    },
    "capabilities": {
        "tools": fact(True, "inferred", "hf-hub", note="chat_template mentions tools")
    },
    "suitability": {"coding": fact(True, "inferred", "name", note="name matches /coder/")},
    "fit": None,
    "actions": ["pull"],
}
CATALOG = {
    "fetched_at": "2026-09-07T10:00:00+00:00",
    "sources": [
        {"key": "ollama", "ok": True, "rows": 1, "fetched_at": "2026-09-07T10:00:00+00:00"},
        {"key": "openrouter", "ok": True, "rows": 1, "fetched_at": "2026-09-07T10:00:00+00:00"},
        {
            "key": "anthropic",
            "ok": False,
            "rows": 0,
            "note": "the listing was refused (401): invalid x-api-key",
        },
    ],
    "rows": [CLOUD, LIBRARY, INSTALLED],
}
HF_PAGE = {
    "rows": [HUB],
    "next_cursor": None,
    "fetched_at": "2026-09-07T10:00:00+00:00",
    "cached": False,
    "budget": {"remaining": 498, "resets_in_s": 300},
}
PULLED_4B = {
    **LIBRARY,
    "installed": True,
    "facts": {
        "size_bytes": fact(2_497_293_444, source="ollama-tags"),
        "quant": fact("Q4_K_M"),
        "params_b": fact(4.02),
        "digest": fact("sha256:2bfd38a7daaf6cd0d3", source="ollama-tags"),
    },
    "actions": ["use", "probe"],
}


@pytest.fixture
def gateway(mount_peers, tmp_path):
    fake = fakes.FakeGateway(catalog_body=CATALOG, hf_body=HF_PAGE)
    mount_peers(gateway=fake)
    reports: list[str | dict] = []
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path, progress=reports.append)
    return fake, ctx, reports


async def _run(executor, ctx, **args) -> tuple[str, bool]:
    try:
        return await executor(args, ctx), True
    except ToolFailure as exc:
        return f"{ERROR_PREFIX}{exc}", False


# ── model_catalog_search ─────────────────────────────────────────────────


async def test_search_lists_every_row_with_its_basis_in_words(gateway):
    fake, ctx, _ = gateway
    text, ok = await _run(models.model_catalog_search, ctx)
    assert ok, text
    lines = text.splitlines()
    assert lines[0].startswith("3 model(s) match")
    # Installed first; then the rest.
    assert lines[1].startswith("1. ollama:qwen3:8b — Qwen3 8B [installed, local]")
    assert "4.9 GB (ollama declares)" in lines[1]
    assert "8.19B params (ollama declares)" in lines[1]
    assert "40,960 context (ollama declares)" in lines[1]
    assert "tools (ollama declares)" in lines[1]
    assert "coding (inferred: name matches /coder/)" in lines[1]
    assert "chat (vetted 2026-09-06)" in lines[1]
    assert "agent_quality 86% (measured by the quality suite 2026-09-04)" in lines[1]
    assert "fit: comfortable (measured on your GPU)" in lines[1]
    cloud = next(line for line in lines if "openrouter:openai/gpt-6-astra" in line)
    assert "$10.00/1M in (the provider's listing declares)" in cloud
    assert "coding 76.9 (the provider's listing declares)" in cloud
    assert "size" not in cloud.split("[")[1].split("]")[1].split("|")[0] or "GB" not in cloud
    # A source that failed is said, in its words.
    assert "anthropic could not be read — the listing was refused (401)" in text
    assert "Every fact names its basis" in text
    assert [p for p, _ in fake.seen] == ["/admin/catalog"]


async def test_filters_exclude_by_capability_and_count_rows_lacking_a_number(gateway):
    _, ctx, _ = gateway
    text, ok = await _run(models.model_catalog_search, ctx, requires=["tools"])
    assert ok
    assert "2 model(s) match" in text and "qwen3:4b" not in text

    text, ok = await _run(models.model_catalog_search, ctx, max_size_gb=3)
    assert ok
    assert text.startswith("No model matched in scope all.")
    assert "2 model(s) state no size and were left out by the size filter" in text

    text, ok = await _run(models.model_catalog_search, ctx, scope="cloud", max_price_per_m=1)
    assert ok and "No model matched" in text and "left out by the price filter" not in text

    text, ok = await _run(models.model_catalog_search, ctx, scope="installed")
    assert ok and "1 model(s) match" in text and "qwen3:8b" in text


async def test_scope_hf_searches_the_hub_with_the_query_and_a_429_is_a_failure(gateway):
    fake, ctx, _ = gateway
    text, ok = await _run(models.model_catalog_search, ctx, query="qwen coder", scope="hf")
    assert ok, text
    assert "hf.co/unsloth/Qwen3-Coder-GGUF" in text
    assert "tools (inferred: chat_template mentions tools)" in text
    assert "12,639,566 downloads (Hugging Face declares)" in text
    assert b"q=qwen+coder" in fake.queries[-1]

    text, ok = await _run(models.model_catalog_search, ctx, scope="hf")
    assert not ok and "needs a query" in text

    fake.hf_status = 429
    fake.hf_body = {
        "error": "Hugging Face rate-limited this address — retry in 42s",
        "retry_after_s": 42,
    }
    text, ok = await _run(models.model_catalog_search, ctx, query="qwen", scope="hf")
    assert not ok
    assert text.startswith(f"{ERROR_PREFIX}rate-limited: Hugging Face rate-limited")
    assert "retry in 42 s" in text


async def test_scope_all_with_a_query_merges_the_hub_page_and_matches_text(gateway):
    fake, ctx, _ = gateway
    text, ok = await _run(models.model_catalog_search, ctx, query="coder")
    assert ok, text
    assert [p for p, _ in fake.seen] == ["/admin/catalog", "/admin/catalog/hf"]
    # The catalogue's own rows do not match "coder"; the Hub row does.
    assert "1 model(s) match" in text and "Qwen3-Coder-GGUF" in text


async def test_an_unreachable_gateway_is_a_stated_failure_not_an_empty_list(monkeypatch, tmp_path):
    monkeypatch.setenv("GATEWAY_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("CORE_GATEWAY_TOKEN", "t")
    app.state.peer_transports = {}
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)
    text, ok = await _run(models.model_catalog_search, ctx)
    assert not ok and "could not reach the model gateway" in text


async def test_bad_scope_and_sort_are_refused_in_words(gateway):
    _, ctx, _ = gateway
    text, ok = await _run(models.model_catalog_search, ctx, scope="everything")
    assert not ok and "scope must be one of" in text
    text, ok = await _run(models.model_catalog_search, ctx, sort="vibes")
    assert not ok and "sort must be one of" in text


# ── model_pull ────────────────────────────────────────────────────────────


async def test_a_cloud_id_is_refused_before_the_gateway_is_touched(gateway):
    fake, ctx, _ = gateway
    text, ok = await _run(models.model_pull, ctx, model="openrouter:openai/gpt-6-astra")
    assert not ok and "only the bundled ollama can pull" in text
    assert fake.seen == []
    text, ok = await _run(models.model_pull, ctx, model="   ")
    assert not ok and "needs a model reference" in text


async def test_a_preflight_that_does_not_fit_is_a_failure_with_the_numbers(gateway):
    fake, ctx, reports = gateway
    fake.pull_lines = (
        '{"status":"preflight","required_gb":30.0,"free_gb":12.0,"ok":false,"size_bytes":1,"size_source":"ollama-registry"}',
        '{"status":"pulling"}',
        '{"status":"success"}',
    )
    text, ok = await _run(models.model_pull, ctx, model="ollama:huge:70b")
    assert not ok
    assert "needs about 30.0 GB and only 12.0 GB is free" in text
    assert fake.seen[-1] == ("/admin/pull", {"model": "huge:70b"})


async def test_ollamas_error_line_is_relayed_in_its_words(gateway):
    fake, ctx, _ = gateway
    fake.pull_lines = (
        '{"status":"preflight","required_gb":2.3,"free_gb":100,"ok":true}',
        '{"error":"pull model manifest: file does not exist"}',
    )
    text, ok = await _run(models.model_pull, ctx, model="nope:1b")
    assert not ok and "the pull failed — pull model manifest: file does not exist" in text


async def test_a_quiet_stream_is_not_a_success(gateway):
    fake, ctx, _ = gateway
    fake.pull_lines = (
        '{"status":"preflight","ok":true,"required_gb":2.3,"free_gb":100}',
        '{"status":"pulling manifest"}',
    )
    text, ok = await _run(models.model_pull, ctx, model="qwen3:4b")
    assert not ok and "ended without ollama reporting success" in text


async def test_a_confirmed_pull_reports_progress_and_states_what_the_catalogue_lists(gateway):
    fake, ctx, reports = gateway
    fake.pull_lines = (
        '{"status":"preflight","required_gb":2.3,"free_gb":100,"ok":true,"size_bytes":2497293444,"size_source":"ollama-registry"}',
        '{"status":"pulling manifest"}',
        '{"status":"pulling manifest"}',
        '{"status":"pulling sha256:2bfd","total":2497293444,"completed":249729345}',
        '{"status":"pulling sha256:2bfd","total":2497293444,"completed":274702278}',
        '{"status":"pulling sha256:2bfd","total":2497293444,"completed":1248646723}',
        '{"status":"pulling sha256:2bfd","total":2497293444,"completed":2497293444}',
        '{"status":"success"}',
    )
    # The catalogue read AFTER the pull lists the model as installed.
    fake.catalog_body = {**CATALOG, "rows": [CLOUD, PULLED_4B, INSTALLED]}

    text, ok = await _run(models.model_pull, ctx, model="qwen3:4b")

    assert ok, text
    assert text.startswith("Pulled ollama:qwen3:4b — the catalogue now lists it as installed: ")
    assert "2.3 GB (ollama declares)" in text and "quant Q4_K_M (ollama declares)" in text
    assert "digest sha256:2bfd38a7daaf" in text
    assert "Preflight: 2.3 GB needed, 100 GB free (size from ollama-registry)" in text
    assert "chat.model" not in text
    assert [p for p, _ in fake.seen] == ["/admin/pull", "/admin/catalog"]
    # Progress: the preflight, one report per whole percentage point reached,
    # then the catalogue check. The lines that know a fraction report it as a
    # NUMBER beside the words (S15), because a bar cannot be drawn from prose;
    # the lines that do not (preflight, a manifest with no byte count) stay
    # plain strings and render as words alone.
    assert reports[0] == "pulling qwen3:4b — 2.3 GB needed, 100 GB free (size from ollama-registry)"
    assert reports.count("pulling manifest — qwen3:4b") == 1, "identical reports are one frame"
    # The fourth pull line is still 10% (it is 10.99 of a percent, truncated),
    # so it reaches no new point and sends no frame — the bar would not move.
    assert [r for r in reports if isinstance(r, dict)] == [
        {"detail": "pulling qwen3:4b — 10% (0.2 GB of 2.3 GB)", "percent": 10},
        {"detail": "pulling qwen3:4b — 50% (1.2 GB of 2.3 GB)", "percent": 50},
        {"detail": "pulling qwen3:4b — 100% (2.3 GB of 2.3 GB)", "percent": 100},
    ]
    # The number on the frame is the number in the words, always — one formula.
    for dict_report in (r for r in reports if isinstance(r, dict)):
        assert f"{dict_report['percent']}%" in dict_report["detail"]
    assert reports[-1] == "ollama reported success — checking the catalogue for qwen3:4b"


async def test_every_layer_of_a_pull_reports_its_own_progress(gateway):
    """A real pull is several blobs, each with its own 0→100.

    Found by walking a live pull: one high-water mark for the whole call meant
    the first layer to finish silenced every layer after it — the bar reached a
    number and then sat there while gigabytes kept arriving. The mark is per
    layer, so the second blob reports from its own start.
    """
    fake, ctx, reports = gateway
    fake.pull_lines = (
        '{"status":"preflight","required_gb":2.3,"free_gb":100,"ok":true}',
        '{"status":"pulling sha256:aaaa","total":1000,"completed":500}',
        '{"status":"pulling sha256:aaaa","total":1000,"completed":1000}',
        # A second blob, starting over. Under the old rule neither line reported.
        '{"status":"pulling sha256:bbbb","total":1000,"completed":300}',
        '{"status":"pulling sha256:bbbb","total":1000,"completed":900}',
        '{"status":"success"}',
    )
    fake.catalog_body = {**CATALOG, "rows": [CLOUD, PULLED_4B, INSTALLED]}

    text, ok = await _run(models.model_pull, ctx, model="qwen3:4b")
    assert ok, text
    assert [r["percent"] for r in reports if isinstance(r, dict)] == [50, 100, 30, 90]


async def test_a_success_line_the_catalogue_does_not_confirm_is_a_failure(gateway):
    fake, ctx, _ = gateway
    fake.pull_lines = (
        '{"status":"preflight","ok":true,"required_gb":2.3,"free_gb":100}',
        '{"status":"success"}',
    )
    text, ok = await _run(models.model_pull, ctx, model="qwen3:4b")
    assert not ok
    assert "ollama reported success but the catalogue does not list qwen3:4b as installed" in text


async def test_a_refused_pull_is_the_gateways_words(gateway):
    fake, ctx, _ = gateway
    fake.pull_status = 409
    fake.pull_body = {
        "error": (
            "a pull of 'qwen3:4b' has been in flight since 2026-09-07T10:00:00 — "
            "wait for it to finish"
        )
    }
    text, ok = await _run(models.model_pull, ctx, model="qwen3:4b")
    assert not ok and "the pull was refused — a pull of 'qwen3:4b' has been in flight" in text


@requires_db
async def test_set_as_chat_model_writes_the_setting_and_reads_it_back(gateway, pool):
    fake, ctx, _ = gateway
    fake.pull_lines = (
        '{"status":"preflight","ok":true,"required_gb":2.3,"free_gb":100}',
        '{"status":"success"}',
    )
    fake.catalog_body = {**CATALOG, "rows": [CLOUD, PULLED_4B, INSTALLED]}

    text, ok = await _run(models.model_pull, ctx, model="qwen3:4b", set_as_chat_model=True)

    assert ok, text
    assert text.endswith(" chat.model is now ollama:qwen3:4b (read back).")
    row = await pool.fetchrow("SELECT value FROM settings WHERE key = 'chat.model'")
    assert row["value"] == "ollama:qwen3:4b"


# ── model_check_update / model_remove (the follow-ups) ────────────────────


async def test_check_update_reads_the_gateways_verdict_out_in_words(gateway):
    fake, ctx, _ = gateway
    digest_a, digest_b = "sha256:" + "a" * 64, "sha256:" + "b" * 64
    fake.admin_body = {
        "model": "qwen3:8b",
        "checked_at": "2026-09-07T12:00:00+00:00",
        "installed_digest": digest_a,
        "upstream_digest": digest_a,
        "moved": False,
        "basis": "weights-digest",
        "source": "ollama-registry",
    }
    text, ok = await _run(models.model_check_update, ctx, model="ollama:qwen3:8b")
    assert ok and text.startswith("qwen3:8b is up to date: the installed weights (sha256:a")
    assert "the ollama registry ships now" in text
    assert fake.seen[-1] == ("/admin/catalog/drift", {"model": "qwen3:8b"})

    fake.admin_body = {**fake.admin_body, "upstream_digest": digest_b, "moved": True}
    text, ok = await _run(models.model_check_update, ctx, model="qwen3:8b")
    assert ok and "has moved upstream" in text and "Nothing was downloaded" in text
    assert "call model_pull with the same name" in text

    fake.admin_body = {
        **fake.admin_body,
        "upstream_digest": None,
        "moved": None,
        "note": "the source could not be read — timed out",
        "retry_after_s": 30,
    }
    text, ok = await _run(models.model_check_update, ctx, model="qwen3:8b")
    assert ok and text.startswith(
        "Could not tell whether qwen3:8b has moved — the source could not be read"
    )
    assert "(retry in 30 s)" in text

    fake.admin_status = 404
    fake.admin_body = {"error": "'nope:1b' is not installed"}
    text, ok = await _run(models.model_check_update, ctx, model="nope:1b")
    assert not ok and "not installed — nothing to compare" in text
    text, ok = await _run(models.model_check_update, ctx, model="openrouter:openai/gpt-x")
    assert not ok and "only the bundled ollama" in text


@requires_db
async def test_remove_is_verified_by_the_gateway_and_refuses_the_current_chat_model(gateway, pool):
    fake, ctx, _ = gateway
    fake.admin_body = {"removed": "qwen3:4b", "verified": True, "installed_now": 1}
    text, ok = await _run(models.model_remove, ctx, model="qwen3:4b")
    assert (
        ok
        and text
        == "Removed qwen3:4b — verified against ollama's own list; 1 model(s) remain installed."
    )
    path, _ = fake.seen[-1]
    assert path == "/admin/models" and fake.queries[-1] == b"model=qwen3%3A4b"

    # A 200 without the gateway's verification is not "removed".
    fake.admin_body = {"removed": "qwen3:4b"}
    text, ok = await _run(models.model_remove, ctx, model="qwen3:4b")
    assert not ok and "did not verify" in text

    # The current chat model: a cannot, stated, before the gateway is called.
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('chat.model', '\"ollama:qwen3:8b\"'::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    )
    calls = len(fake.seen)
    text, ok = await _run(models.model_remove, ctx, model="qwen3:8b")
    assert not ok and "is the current chat model" in text
    assert len(fake.seen) == calls
    text, ok = await _run(models.model_remove, ctx, model="openrouter:openai/gpt-x")
    assert not ok and "only the bundled ollama" in text
