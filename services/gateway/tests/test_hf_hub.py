"""app/hf_hub.py — the Hugging Face Hub read live, in the shapes verified
on 2026-09-06.

No socket anywhere: FakeHFHub is mounted by origin on the real app, so
the exact query string, pagination and refusal handling under test are
the real client's. The fixture rows and sibling lists below are the live
shapes, trimmed."""
from __future__ import annotations

import pytest

from app import hf_hub
from app.adapters import ProviderRefused
from app.main import app
from tests.fakes import FakeHFHub

CODER_ROW = {
    "id": "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    "likes": 964,
    "downloads": 12639566,
    "tags": [
        "gguf",
        "qwen3",
        "text-generation",
        "license:apache-2.0",
        "conversational",
        "base_model:Qwen/Qwen3-Coder-30B-A3B-Instruct",
    ],
    "pipeline_tag": "text-generation",
    "library_name": "transformers",
    "createdAt": "2025-07-31T05:00:00.000Z",
    "lastModified": "2025-08-02T12:00:00.000Z",
    "gated": False,
    "gguf": {
        "total": 30532122624,
        "architecture": "qwen3moe",
        "context_length": 262144,
        "chat_template": "{%- if tools %}{{ tools }}{%- endif %}<|im_start|>{{ message.role }}",
        "eos_token": "<|im_end|>",
        "totalFileSize": 17310784672,
    },
}

GATED_VISION_ROW = {
    "id": "google/gemma-4-12b-it-qat-GGUF",
    "likes": 12,
    "downloads": 5000,
    "tags": ["gguf", "gemma4", "image-text-to-text", "license:gemma"],
    "pipeline_tag": "image-text-to-text",
    "lastModified": "2026-08-30T00:00:00.000Z",
    "gated": "auto",
    "gguf": {"total": 12000000000, "architecture": "gemma4", "context_length": 131072},
}

BASE_ROW = {  # a base model: no chat template, no counters expanded
    "id": "someone/Base-7B-GGUF",
    "tags": ["gguf"],
    "gguf": {"total": 7000000000, "architecture": "llama"},
}

SHA = "a" * 64

SIBLINGS = [
    {"rfilename": ".gitattributes", "size": 3854},
    {"rfilename": "README.md", "size": 12000},
    {
        "rfilename": "BF16/Qwen3-Coder-30B-A3B-Instruct-BF16-00001-of-00002.gguf",
        "blobId": "b1",
        "size": 30_000_000_000,
        "lfs": {"sha256": "b" * 64, "size": 30_000_000_000, "pointerSize": 136},
    },
    {
        "rfilename": "BF16/Qwen3-Coder-30B-A3B-Instruct-BF16-00002-of-00002.gguf",
        "blobId": "b2",
        "size": 19_655_154_016,
        "lfs": {"sha256": "c" * 64, "size": 19_655_154_016, "pointerSize": 136},
    },
    {
        "rfilename": "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
        "blobId": "q4",
        "size": 18_556_686_336,
        "lfs": {"sha256": SHA, "size": 18_556_686_336, "pointerSize": 136},
    },
    {
        "rfilename": "Qwen3-Coder-30B-A3B-Instruct-IQ2_XS.gguf",
        "blobId": "iq2",
        "size": 9_000_000_000,
        "lfs": {"sha256": "d" * 64, "size": 9_000_000_000, "pointerSize": 136},
    },
    {
        "rfilename": "Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf",
        "blobId": "ud",
        "size": 19_000_000_000,
        "lfs": {"sha256": "e" * 64, "size": 19_000_000_000, "pointerSize": 136},
    },
    {
        "rfilename": "mmproj-F16.gguf",
        "blobId": "mm",
        "size": 900_000_000,
        "lfs": {"sha256": "f" * 64, "size": 900_000_000, "pointerSize": 135},
    },
]

EXACT_QUERY = (
    "filter=gguf&search=qwen3&sort=downloads&direction=-1&limit=30"
    "&expand%5B%5D=gguf&expand%5B%5D=downloads&expand%5B%5D=likes&expand%5B%5D=lastModified"
    "&expand%5B%5D=tags&expand%5B%5D=pipeline_tag&expand%5B%5D=gated"
)


@pytest.fixture
def hub(mount_backend):
    def _mount(**kwargs) -> FakeHFHub:
        fake = FakeHFHub(**kwargs)
        mount_backend(hf_hub.HF_BASE, fake.app)
        return fake

    return _mount


# ── search: the exact verified query, paging, validation ───────────────────


async def test_search_builds_exactly_the_verified_query(hub):
    """The query verified live on 2026-09-06, byte for byte. A drift here is
    a different listing (or an empty one) with no error to say so."""
    fake = hub(pages=([CODER_ROW],))

    page = await hf_hub.search(app, query="qwen3")

    assert fake.seen == [("/api/models", EXACT_QUERY)]
    assert page.rows == [CODER_ROW]
    assert page.cached is False
    assert page.next_cursor is None
    assert page.budget == {"remaining": hf_hub.BUDGET_LIMIT - 1, "resets_in_s": 300}


async def test_search_pages_with_the_cursor_from_the_link_header(hub):
    fake = hub(pages=([CODER_ROW], [GATED_VISION_ROW], [BASE_ROW]))

    first = await hf_hub.search(app, query="q", limit=1)
    assert first.next_cursor == "cursor-1"

    second = await hf_hub.search(app, query="q", limit=1, cursor=first.next_cursor)
    assert second.rows == [GATED_VISION_ROW]
    assert second.next_cursor == "cursor-2"
    assert fake.seen[-1][1].endswith("&cursor=cursor-1")

    last = await hf_hub.search(app, query="q", limit=1, cursor=second.next_cursor)
    assert last.rows == [BASE_ROW]
    assert last.next_cursor is None


async def test_a_next_link_without_a_cursor_is_a_loud_refusal():
    """A pagination shape this code does not understand must not read as
    "last page" — that would silently truncate every search."""
    with pytest.raises(ProviderRefused, match="carries no cursor"):
        hf_hub.next_cursor_of('<https://huggingface.co/api/models?limit=3>; rel="next"')
    assert hf_hub.next_cursor_of(None) is None
    assert hf_hub.next_cursor_of('<https://huggingface.co/x?cursor=abc>; rel="prev"') is None


@pytest.mark.parametrize(
    "kwargs",
    [
        {"sort": "popular"},
        {"sort": "Downloads"},
        {"limit": 0},
        {"limit": 51},
        {"limit": True},
        {"cursor": "not an opaque token"},
        {"cursor": "a/b"},
        {"cursor": ""},
        {"query": "x" * 201},
    ],
)
async def test_search_refuses_a_bad_argument_before_any_request(hub, kwargs):
    fake = hub(pages=([CODER_ROW],))
    args = {"query": "q", **kwargs}

    with pytest.raises(ValueError):
        await hf_hub.search(app, **args)

    assert fake.seen == []
    assert hf_hub.BUDGET.remaining() == hf_hub.BUDGET_LIMIT


async def test_every_sort_the_hub_accepts_is_accepted(hub):
    fake = hub(pages=([CODER_ROW],))
    for sort in hf_hub.SORTS:
        await hf_hub.search(app, query="q", sort=sort)
    assert [q.split("&sort=")[1].split("&")[0] for _, q in fake.seen] == list(hf_hub.SORTS)


# ── the budget: refused before, stated after ───────────────────────────────


async def test_a_429_is_stated_with_the_hubs_retry_after_and_never_retried(hub):
    fake = hub(status=429, headers={"Retry-After": "42"})

    with pytest.raises(hf_hub.RateLimited) as exc:
        await hf_hub.search(app, query="q")

    assert exc.value.retry_after_s == 42
    assert exc.value.status == 429
    assert "retry in 42s" in exc.value.detail
    assert len(fake.seen) == 1


async def test_a_429_without_retry_after_reads_the_ratelimit_header_then_the_window(hub):
    fake = hub(status=429, headers={"ratelimit": '"api";r=0;t=104'})
    with pytest.raises(hf_hub.RateLimited) as exc:
        await hf_hub.search(app, query="q")
    assert exc.value.retry_after_s == 104

    fake.headers = {}
    with pytest.raises(hf_hub.RateLimited) as exc:
        await hf_hub.search(app, query="q2")
    assert exc.value.retry_after_s == hf_hub.BUDGET_WINDOW_S


async def test_the_local_budget_refuses_the_call_that_would_overrun_the_window(
    hub, monkeypatch
):
    """The Hub's quota is 500 per 300 s per IP — the household's IP. The
    call that would be the 501st is refused HERE, before it leaves, with
    the wait; once the window slides past the oldest call, it goes."""
    fake = hub(pages=([CODER_ROW],))
    now = [1000.0]
    monkeypatch.setattr(
        hf_hub, "BUDGET", hf_hub.Budget(limit=3, window_s=300, clock=lambda: now[0])
    )

    for index in range(3):
        now[0] += 10
        await hf_hub.search(app, query=f"q{index}")
    assert hf_hub.BUDGET.snapshot() == {"remaining": 0, "resets_in_s": 280}

    with pytest.raises(hf_hub.RateLimited) as exc:
        await hf_hub.search(app, query="q-refused")
    assert exc.value.retry_after_s == 280
    assert len(fake.seen) == 3, "the refused call must never reach the Hub"

    now[0] += 281
    page = await hf_hub.search(app, query="q-refused")
    assert page.rows == [CODER_ROW]
    assert len(fake.seen) == 4


# ── caching: the original fetched_at, marked cached ────────────────────────


async def test_a_cached_page_keeps_its_original_fetched_at_and_says_so(hub, monkeypatch):
    fake = hub(pages=([CODER_ROW],))
    now = [0.0]
    monkeypatch.setattr(hf_hub, "SEARCH_CACHE", hf_hub.TTLCache(60, clock=lambda: now[0]))

    first = await hf_hub.search(app, query="qwen3")
    now[0] = 59
    again = await hf_hub.search(app, query="qwen3")

    assert again.cached is True and first.cached is False
    assert again.fetched_at == first.fetched_at
    assert again.rows == first.rows
    assert len(fake.seen) == 1
    assert again.budget["remaining"] == first.budget["remaining"], "a hit costs nothing"

    now[0] = 61
    refetched = await hf_hub.search(app, query="qwen3")
    assert refetched.cached is False
    assert len(fake.seen) == 2


async def test_the_cache_key_is_the_whole_query(hub):
    fake = hub(pages=([CODER_ROW], [BASE_ROW]))
    await hf_hub.search(app, query="q", limit=1)
    await hf_hub.search(app, query="q", limit=2)
    await hf_hub.search(app, query="q", limit=1, sort="likes")
    await hf_hub.search(app, query="q", limit=1, cursor="cursor-1")
    assert len(fake.seen) == 4


# ── repo detail ────────────────────────────────────────────────────────────


async def test_repo_detail_fetches_blobs_and_is_cached_ten_minutes(hub, monkeypatch):
    fake = hub(repos={CODER_ROW["id"]: {**CODER_ROW, "siblings": SIBLINGS}})
    now = [0.0]
    monkeypatch.setattr(hf_hub, "DETAIL_CACHE", hf_hub.TTLCache(600, clock=lambda: now[0]))

    detail = await hf_hub.repo_detail(app, "unsloth", "Qwen3-Coder-30B-A3B-Instruct-GGUF")

    assert fake.seen == [("/api/models/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", "blobs=true")]
    assert detail.id == CODER_ROW["id"]
    assert detail.siblings == SIBLINGS
    assert detail.cached is False

    now[0] = 599
    again = await hf_hub.repo_detail(app, "unsloth", "Qwen3-Coder-30B-A3B-Instruct-GGUF")
    assert again.cached is True and again.fetched_at == detail.fetched_at
    assert len(fake.seen) == 1

    now[0] = 601
    await hf_hub.repo_detail(app, "unsloth", "Qwen3-Coder-30B-A3B-Instruct-GGUF")
    assert len(fake.seen) == 2


async def test_repo_detail_404_and_gated_are_refusals_in_the_hubs_words(hub):
    hub(
        refusals={
            "meta-llama/Llama-4-GGUF": (
                403,
                {"error": "Access to model meta-llama/Llama-4-GGUF is restricted"},
            )
        }
    )

    with pytest.raises(ProviderRefused) as exc:
        await hf_hub.repo_detail(app, "nobody", "nothing")
    assert exc.value.status == 404
    assert "'nobody/nothing' was not found on Hugging Face" in exc.value.detail

    with pytest.raises(ProviderRefused) as exc:
        await hf_hub.repo_detail(app, "meta-llama", "Llama-4-GGUF")
    assert exc.value.status == 403
    assert "gated" in exc.value.detail
    assert "restricted" in exc.value.detail


@pytest.mark.parametrize(
    ("org", "repo"), [("..", "x"), ("a/b", "x"), ("", "x"), ("x", "-dash"), ("x", "y" * 97)]
)
async def test_repo_detail_validates_the_path_segments_before_any_request(hub, org, repo):
    fake = hub()
    with pytest.raises(ValueError):
        await hf_hub.repo_detail(app, org, repo)
    assert fake.seen == []


# ── pure: siblings -> quants ───────────────────────────────────────────────


def test_quants_of_on_a_live_shaped_sibling_list():
    quants = hf_hub.quants_of(SIBLINGS)
    by_tag = {q["tag"]: q for q in quants}

    assert set(by_tag) == {"IQ2_XS", "Q4_K_M", "UD-Q4_K_XL", "BF16"}, "no README, no mmproj"
    # Multi-part BF16: one option, sizes summed, no single-file digest.
    bf16 = by_tag["BF16"]
    assert bf16["size_bytes"] == 30_000_000_000 + 19_655_154_016
    assert bf16["parts"] == 2
    assert bf16["sha256"] is None
    assert bf16["filename"].endswith("-00001-of-00002.gguf")
    # A single file carries its own digest.
    q4 = by_tag["Q4_K_M"]
    assert q4["size_bytes"] == 18_556_686_336
    assert q4["sha256"] == SHA
    assert q4["parts"] == 1
    # ollama's default, and only that one.
    assert [q["tag"] for q in quants if q["is_default"]] == ["Q4_K_M"]
    # The projector rides along on every option — ollama fetches it too.
    assert all(q["mmproj_bytes"] == 900_000_000 for q in quants)
    # Sorted by size, smallest first — what a picker wants.
    assert [q["tag"] for q in quants] == ["IQ2_XS", "Q4_K_M", "UD-Q4_K_XL", "BF16"]


def test_quants_of_without_a_projector_or_a_q4_k_m():
    quants = hf_hub.quants_of(
        [
            {"rfilename": "llama-2-7b.Q5_K_S.gguf", "size": 5, "lfs": {"sha256": "1" * 64}},
            {"rfilename": "llama-2-7b.Q8_0.gguf", "size": 8, "lfs": {"sha256": "2" * 64}},
        ]
    )
    assert [q["tag"] for q in quants] == ["Q5_K_S", "Q8_0"]
    assert not any(q["is_default"] for q in quants), "no Q4_K_M means no default"
    assert not any("mmproj_bytes" in q for q in quants)


def test_quants_of_a_single_file_repo_reads_the_tail_token():
    [only] = hf_hub.quants_of([{"rfilename": "model-q4_k_m.gguf", "size": 3}])
    assert only["tag"] == "q4_k_m"
    assert only["is_default"] is True, "ollama's default match is case-insensitive"


def test_quants_of_leaves_an_unstated_size_absent():
    [only] = hf_hub.quants_of([{"rfilename": "model-Q4_K_M.gguf"}])
    assert only["size_bytes"] is None


def test_find_quant_matches_tag_then_filename_case_insensitively():
    quants = hf_hub.quants_of(SIBLINGS)
    assert hf_hub.find_quant(quants, "q4_k_m")["tag"] == "Q4_K_M"
    assert hf_hub.find_quant(quants, "ud-q4_k_xl")["tag"] == "UD-Q4_K_XL"
    assert hf_hub.find_quant(quants, "qwen3-coder-30b-a3b-instruct-iq2_xs.gguf")["tag"] == "IQ2_XS"
    assert hf_hub.find_quant(quants, "Q4_K_XL")["tag"] == "UD-Q4_K_XL", "unique stem ending"
    assert hf_hub.find_quant(quants, "Q6_K") is None


# ── pure: a Hub entry -> the catalogue row ─────────────────────────────────


def test_to_catalog_row_labels_declared_facts_and_inferred_guesses():
    row = hf_hub.to_catalog_row(CODER_ROW, "2026-09-06T10:00:00+00:00")

    assert row["id"] == "ollama:hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF"
    assert row["provider"] == "ollama"
    assert row["model"] == "hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF"
    assert row["label"] == "Qwen3-Coder-30B-A3B-Instruct-GGUF"
    assert row["kind"] == "hub"
    assert row["installed"] is False
    assert row["sources"] == [
        {
            "key": "hf-hub",
            "url": "https://huggingface.co/api/models",
            "fetched_at": "2026-09-06T10:00:00+00:00",
            "cached": False,
        }
    ]
    declared = {"basis": "declared", "source": "hf-hub"}
    assert row["facts"] == {
        "params_b": {"value": 30.53, **declared},
        "context_length": {"value": 262144, **declared},
        "family": {"value": "qwen3moe", **declared},
        "downloads": {"value": 12639566, **declared},
        "likes": {"value": 964, **declared},
        "last_modified": {"value": "2025-08-02T12:00:00.000Z", **declared},
        "gated": {"value": False, **declared},
        "license": {"value": "apache-2.0", **declared},
    }
    assert row["capabilities"] == {
        "chat": {"value": True, **declared},
        "tools": {
            "value": True,
            "basis": "inferred",
            "source": "hf-hub",
            "note": "chat_template mentions tools",
        },
    }
    assert row["suitability"] == {
        "coding": {
            "value": True,
            "basis": "inferred",
            "source": "name",
            "note": "name matches /coder|code(?!x)|codestral|starcoder|devstral/i",
        }
    }
    assert "pull" not in row


def test_to_catalog_row_keeps_gated_verbatim_and_infers_vision_from_the_pipeline_tag():
    row = hf_hub.to_catalog_row(GATED_VISION_ROW, "t", cached=True)

    assert row["facts"]["gated"] == {"value": "auto", "basis": "declared", "source": "hf-hub"}
    assert row["facts"]["license"]["value"] == "gemma"
    assert row["capabilities"]["vision"] == {
        "value": True,
        "basis": "inferred",
        "source": "hf-hub",
        "note": "pipeline_tag is image-text-to-text",
    }
    assert "chat" not in row["capabilities"], "no chat_template stated, nothing claimed"
    assert row["suitability"] == {}
    assert row["sources"][0]["cached"] is True


def test_to_catalog_row_states_nothing_the_hub_did_not():
    row = hf_hub.to_catalog_row(BASE_ROW, "t")
    assert set(row["facts"]) == {"params_b", "family"}
    assert row["capabilities"] == {}
    assert row["suitability"] == {}


def test_to_catalog_row_infers_vision_from_a_tag_or_a_projector_sibling():
    tagged = hf_hub.to_catalog_row({**BASE_ROW, "tags": ["gguf", "qwen2_vl"]}, "t")
    assert tagged["capabilities"]["vision"]["note"] == "tag 'qwen2_vl' names vision"

    quants = hf_hub.quants_of(SIBLINGS)
    with_pull = hf_hub.to_catalog_row(BASE_ROW, "t", quants=quants)
    assert with_pull["capabilities"]["vision"]["note"] == "mmproj-*.gguf sibling present"
    assert with_pull["pull"] == {"target": "hf.co/someone/Base-7B-GGUF", "quants": quants}


@pytest.mark.parametrize(
    ("name", "coding"),
    [
        ("Qwen/Qwen2.5-Coder-7B-GGUF", True),
        ("mistralai/Codestral-22B-GGUF", True),
        ("bigcode/starcoder2-GGUF", True),
        ("mistralai/Devstral-Small-GGUF", True),
        ("x/CodeLlama-GGUF", True),
        ("openai/codex-mini-GGUF", False),
        ("x/Qwen3-8B-GGUF", False),
    ],
)
def test_coding_is_inferred_from_the_name_only(name, coding):
    row = hf_hub.to_catalog_row({"id": name, "gguf": {}}, "t")
    assert ("coding" in row["suitability"]) is coding
