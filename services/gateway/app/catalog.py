"""The model catalogue: every source mapped into ONE row shape.

Assembles, with no HTTP of its own: installed local models (ollama
/api/tags + /api/show), the curated picks not installed (the vetted
layer), and every registered provider's listing. Each row is
`CatalogRow` — every fact `{value, basis, source}` with `basis ∈ declared |
inferred | vetted | measured` and `source` a key into the row's
`sources[]`, each stamped with when it answered. A fact a source did not
state is ABSENT, never null-as-zero, never guessed. A source that fails
contributes `ok: false` with its own words and the page still renders.

The row shape is pinned by tests/test_catalog.py — extending it is a
deliberate move, never an accident (the same rule as every other pinned
suite here).
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Callable
from datetime import UTC, datetime

from app import adapters, hf_hub, ollama_registry, providers, pulls
from app import curated as curated_mod
from app import fit as fit_mod
from app.adapters import (
    ListingUnavailable,
    ProviderRefused,
    ollama,
    openai_chat,
)

logger = logging.getLogger("gateway")

ROW_KEYS = frozenset(
    {
        "id",
        "provider",
        "model",
        "label",
        "kind",
        "installed",
        "note",
        "sources",
        "facts",
        "capabilities",
        "suitability",
        "fit",
        "probe",
        "drift",
        "pull",
        "actions",
    }
)
BASES = frozenset({"declared", "inferred", "vetted", "measured"})

SOURCE_TAGS = "ollama-tags"
SOURCE_SHOW = ollama.SHOW_SOURCE
SOURCE_CURATED = "curated"
SOURCE_PROBE = "probe"
SOURCE_LISTING = "provider-listing"
SOURCE_NAME = "name"

CODING_NAME_RE = re.compile(hf_hub.CODING_NAME_PATTERN, re.IGNORECASE)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def fact(value, basis: str, source: str, **extra) -> dict:
    entry = {"value": value, "basis": basis, "source": source}
    entry.update({k: v for k, v in extra.items() if v is not None})
    return entry


def _base_row(id_: str, provider: str, model: str, label: str, kind: str) -> dict:
    return {
        "id": id_,
        "provider": provider,
        "model": model,
        "label": label,
        "kind": kind,
        "installed": None,
        "note": None,
        "sources": [],
        "facts": {},
        "capabilities": {},
        "suitability": {},
        "fit": None,
        "probe": None,
        "drift": None,
        "pull": None,
        "actions": [],
    }


def _coding_inferred(name: str) -> dict | None:
    if CODING_NAME_RE.search(name):
        return fact(True, "inferred", SOURCE_NAME, note="name matches /coder|code/")
    return None


def _put_suitability(suitability: dict, name: str, entry: dict) -> None:
    """One entry per (name, basis): the key is `name` unless another basis
    already holds it, then `name:<basis>` — so a declared benchmark and an
    inferred name-match for the same word both survive, each labelled."""
    if name not in suitability:
        suitability[name] = entry
    elif suitability[name]["basis"] != entry["basis"]:
        suitability[f"{name}:{entry['basis']}"] = entry


# ── local rows ────────────────────────────────────────────────────────────


def local_row(
    tags_row: dict,
    shown: dict | None,
    curated_entry: dict | None,
    probe_row: dict | None,
    fit_ctx: dict,
    *,
    tags_fetched_at: str,
) -> dict:
    """One installed model from ollama's own state (+ the vetted layer)."""
    name = tags_row["id"]
    row = _base_row(f"ollama:{name}", "ollama", name, name, "local")
    row["installed"] = True
    row["sources"].append(
        {"key": SOURCE_TAGS, "url": "ollama /api/tags", "fetched_at": tags_fetched_at}
    )
    facts = row["facts"]
    if isinstance(tags_row.get("size_bytes"), int):
        facts["size_bytes"] = fact(tags_row["size_bytes"], "declared", SOURCE_TAGS)
    if tags_row.get("digest"):
        facts["digest"] = fact(tags_row["digest"], "declared", SOURCE_TAGS)
    if tags_row.get("modified_at"):
        facts["modified_at"] = fact(tags_row["modified_at"], "declared", SOURCE_TAGS)
    if shown is not None:
        row["sources"].append(
            {
                "key": SOURCE_SHOW,
                "url": "ollama /api/show",
                "fetched_at": shown.get("fetched_at"),
                "cached": bool(shown.get("cached")),
                **({"ok": False, "note": shown["note"]} if shown.get("note") else {}),
            }
        )
        facts.update(shown.get("facts") or {})
        row["capabilities"].update(shown.get("capabilities") or {})
    # tags carry a context length too, as a fallback when show said none
    if "context_length" not in facts and isinstance(tags_row.get("context_length"), int):
        facts["context_length"] = fact(tags_row["context_length"], "declared", SOURCE_TAGS)
    if "family" not in facts and tags_row.get("family"):
        facts["family"] = fact(tags_row["family"], "declared", SOURCE_TAGS)
    if "quant" not in facts and tags_row.get("quantization_level"):
        facts["quant"] = fact(tags_row["quantization_level"], "declared", SOURCE_TAGS)

    caps = row["capabilities"]
    suit = row["suitability"]
    if caps.get("completion", {}).get("value") and not caps.get("embedding", {}).get("value"):
        suit["chat"] = fact(True, "declared", SOURCE_SHOW, note="completion without embedding")
    if caps.get("thinking", {}).get("value"):
        suit["reasoning"] = fact(True, "declared", SOURCE_SHOW, note="capabilities: thinking")
    coding = _coding_inferred(name)
    if coding:
        _put_suitability(suit, "coding", coding)
    _annotate(row, curated_entry)
    if probe_row is not None:
        row["probe"] = {
            "ok": True,
            "latency_ms": probe_row.get("latency_ms"),
            "vram_mb": probe_row.get("vram_mb"),
            "created_at": probe_row["created_at"].isoformat()
            if hasattr(probe_row.get("created_at"), "isoformat")
            else probe_row.get("created_at"),
        }
        row["sources"].append(
            {"key": SOURCE_PROBE, "url": "gateway probes", "fetched_at": row["probe"]["created_at"]}
        )
        if probe_row.get("vram_mb") is not None:
            facts["vram_gb"] = fact(
                round(probe_row["vram_mb"] / 1024, 1),
                "measured",
                SOURCE_PROBE,
                at=row["probe"]["created_at"],
            )
    row["fit"] = _fit_for(curated_entry, probe_row, fit_ctx)
    row["actions"] = ["use", "probe"]
    return row


def library_row(curated_entry: dict, fit_ctx: dict, probe_row: dict | None) -> dict:
    """A curated pick that is not installed: the vetted layer is all there
    is until it is pulled (or resolved live from the registry)."""
    slug = curated_entry["slug"]
    row = _base_row(f"ollama:{slug}", "ollama", slug, curated_entry.get("label") or slug, "local")
    row["installed"] = False
    _annotate(row, curated_entry)
    row["fit"] = _fit_for(curated_entry, probe_row, fit_ctx)
    row["actions"] = ["pull"]
    return row


def _annotate(row: dict, entry: dict | None) -> None:
    """The vetted layer: label, note, use_cases, and numeric facts ONLY where
    nothing declared or measured already stands (declared always wins)."""
    if not entry:
        return
    at = entry.get("verified_at")
    row["sources"].append({"key": SOURCE_CURATED, "url": "curated_models.json", "verified_at": at})
    if entry.get("label"):
        row["label"] = entry["label"]
    if entry.get("note"):
        row["note"] = entry["note"]
    facts = row["facts"]
    if "params_b" not in facts and isinstance(entry.get("params_b"), int | float):
        facts["params_b"] = fact(float(entry["params_b"]), "vetted", SOURCE_CURATED, at=at)
    if "vram_gb" not in facts and isinstance(entry.get("min_vram_gb"), int | float):
        facts["vram_gb"] = fact(float(entry["min_vram_gb"]), "vetted", SOURCE_CURATED, at=at)
    for use in entry.get("use_cases") or []:
        _put_suitability(row["suitability"], use, fact(True, "vetted", SOURCE_CURATED, at=at))


def _fit_for(curated_entry: dict | None, probe_row: dict | None, fit_ctx: dict) -> dict:
    """The existing whole-card verdict, or an honest `unknown` when there is
    neither a curated estimate nor a probe to size the model by."""
    free_gb, total_gb, reason = fit_ctx["free_gb"], fit_ctx["total_gb"], fit_ctx["reason"]
    has_probe = probe_row is not None and probe_row.get("vram_mb") is not None
    if curated_entry is None and not has_probe:
        return fit_mod.compute_fit(
            None,
            free_gb,
            total_gb,
            source=fit_mod.SOURCE_ESTIMATED,
            reason="no estimate — not in the curated list and never probed",
        )
    needed_gb, source = fit_mod.needed_gb_for(curated_entry or {"min_vram_gb": None}, probe_row)
    return fit_mod.compute_fit(needed_gb, free_gb, total_gb, source=source, reason=reason)


# ── cloud rows ────────────────────────────────────────────────────────────


def cloud_row(provider_row: dict, model: dict, fetched_at: str, *, cached: bool = False) -> dict:
    """One model of a registered provider's listing, from the NORMALIZED
    listing row (`openai_chat.normalize_models` / the Anthropic listing)."""
    name = provider_row["name"]
    model_id = str(model["id"])
    row = _base_row(
        f"{name}:{model_id}", name, model_id, str(model.get("name") or model_id), "cloud"
    )
    row["sources"].append(
        {
            "key": SOURCE_LISTING,
            "url": f"{name} /models",
            "fetched_at": fetched_at,
            "cached": cached,
        }
    )
    facts = row["facts"]
    if isinstance(model.get("context_length"), int):
        facts["context_length"] = fact(model["context_length"], "declared", SOURCE_LISTING)
    if isinstance(model.get("max_output_tokens"), int):
        facts["max_output_tokens"] = fact(model["max_output_tokens"], "declared", SOURCE_LISTING)
    pricing = model.get("pricing")
    if isinstance(pricing, dict):
        if isinstance(pricing.get("prompt"), int | float):
            facts["price_prompt"] = fact(float(pricing["prompt"]), "declared", SOURCE_LISTING)
        if isinstance(pricing.get("completion"), int | float):
            facts["price_completion"] = fact(
                float(pricing["completion"]), "declared", SOURCE_LISTING
            )
    if model.get("hugging_face_id"):
        facts["hugging_face_id"] = fact(model["hugging_face_id"], "declared", SOURCE_LISTING)
    if model.get("expiration_date"):
        facts["expiration_date"] = fact(model["expiration_date"], "declared", SOURCE_LISTING)
    if provider_row["adapter"] == "anthropic-messages":
        row["capabilities"].update(
            {k: v for k, v in (model.get("capabilities_declared") or {}).items()}
        )
        row["suitability"]["chat"] = fact(
            True, "declared", SOURCE_LISTING, note="a messages listing"
        )
    else:
        capabilities, suitability = openai_chat.listing_capabilities(model)
        row["capabilities"].update(capabilities)
        row["suitability"].update(suitability)
    coding = _coding_inferred(model_id)
    if coding:
        _put_suitability(row["suitability"], "coding", coding)
    row["actions"] = ["use"]
    return row


# ── assembly ──────────────────────────────────────────────────────────────


async def _probes_by_model(pool, names: list[str]) -> dict[str, dict]:
    """The newest OK probe row per name — with latency and time, for the
    row's `probe` block (admin._latest_probes keeps vram only, for fit)."""
    if not names:
        return {}
    rows = await pool.fetch(
        "SELECT DISTINCT ON (model) model, vram_mb, latency_ms, created_at FROM probes "
        "WHERE model = ANY($1) AND ok = true "
        "ORDER BY model, created_at DESC",
        names,
    )
    return {row["model"]: dict(row) for row in rows}


async def build(app, pool, *, fit_context: Callable, listing_for: Callable) -> dict:
    """The whole catalogue. `fit_context(app, pool)` and
    `listing_for(app, pool, row)` are admin.py's own helpers, passed in so
    this module owns no HTTP and the numbers agree with /admin/suggest by
    construction."""
    fetched_at = _now()
    sources: list[dict] = []
    rows: list[dict] = []
    curated = curated_mod.load_curated()
    by_slug = {entry["slug"]: entry for entry in curated}
    fit_ctx = await fit_context(app, pool)

    builtin = await providers.get_row(pool, "ollama")
    base_url = providers.base_url_of(builtin)
    installed_names: set[str] = set()
    try:
        tags = await ollama.ADAPTER.list_models(app, builtin)
    except ProviderRefused as exc:
        sources.append(
            {"key": "ollama", "ok": False, "rows": 0, "note": exc.detail, "fetched_at": fetched_at}
        )
    else:
        shown = await ollama.facts_for_installed(app, base_url, tags.models)
        names = [m["id"] for m in tags.models]
        probes = await _probes_by_model(pool, names)
        for tags_row in tags.models:
            name = tags_row["id"]
            installed_names.add(name)
            rows.append(
                local_row(
                    tags_row,
                    shown.get(name),
                    by_slug.get(name),
                    probes.get(name),
                    fit_ctx,
                    tags_fetched_at=tags.fetched_at,
                )
            )
        failed = sum(1 for v in shown.values() if v.get("note"))
        sources.append(
            {
                "key": "ollama",
                "ok": True,
                "rows": len(tags.models),
                "fetched_at": tags.fetched_at,
                **({"note": f"/api/show failed for {failed} model(s)"} if failed else {}),
            }
        )

    library = [entry for entry in curated if entry["slug"] not in installed_names]
    probes = await _probes_by_model(pool, [entry["slug"] for entry in library])
    for entry in library:
        rows.append(library_row(entry, fit_ctx, probes.get(entry["slug"])))
    sources.append(
        {"key": SOURCE_CURATED, "ok": True, "rows": len(library), "url": "curated_models.json"}
    )

    provider_rows = [r for r in await providers.list_rows(pool) if not r["builtin"]]

    async def one(provider_row: dict) -> tuple[dict, list[dict]]:
        name = provider_row["name"]
        try:
            listing = await listing_for(app, pool, provider_row)
        except ListingUnavailable as exc:
            return {
                "key": name,
                "ok": False,
                "rows": 0,
                "note": str(exc),
                "fetched_at": fetched_at,
            }, []
        except ProviderRefused as exc:
            return {
                "key": name,
                "ok": False,
                "rows": 0,
                "note": exc.detail,
                "fetched_at": fetched_at,
            }, []
        return (
            {
                "key": name,
                "ok": True,
                "rows": len(listing.models),
                "fetched_at": listing.fetched_at,
            },
            [cloud_row(provider_row, m, listing.fetched_at) for m in listing.models],
        )

    for result in await asyncio.gather(*(one(r) for r in provider_rows), return_exceptions=True):
        if isinstance(result, BaseException):
            logger.exception("catalogue: a provider listing raised", exc_info=result)
            sources.append(
                {"key": "provider", "ok": False, "rows": 0, "note": adapters.reason(result)}
            )
            continue
        source, provider_models = result
        sources.append(source)
        rows.extend(provider_models)

    return {"fetched_at": fetched_at, "sources": sources, "rows": rows}


# ── Hugging Face and the registry, as rows ────────────────────────────────


def hf_page_rows(page: hf_hub.HfPage) -> list[dict]:
    return [
        hf_hub.to_catalog_row(entry, page.fetched_at, cached=page.cached) for entry in page.rows
    ]


def hf_repo_row(repo: hf_hub.HfRepo) -> dict:
    quants = hf_hub.quants_of(repo.siblings)
    return hf_hub.to_catalog_row(repo.data, repo.fetched_at, cached=repo.cached, quants=quants)


async def resolve_ref(app, model: str) -> dict:
    """What a typed ref would pull, resolved live BEFORE any bytes move:
    a Hub repo's quants, or the registry manifest's size/quant/family."""
    model = pulls.validate_model(model)
    if pulls.is_hub_ref(model):
        org, repo, quant = pulls.split_hub_ref(model)
        detail = await hf_hub.repo_detail(app, org, repo)
        row = hf_repo_row(detail)
        note = None
        if quant and not hf_hub.find_quant(row["pull"]["quants"], quant):
            note = f"{org}/{repo} has no quant {quant!r}; available: " + ", ".join(
                q["tag"] for q in row["pull"]["quants"]
            )
        return {
            "model": model,
            "source": hf_hub.SOURCE_KEY,
            "fetched_at": detail.fetched_at,
            "facts": row["facts"],
            "pull": row["pull"],
            **({"note": note} if note else {}),
        }
    manifest = await ollama_registry.manifest(app, model)
    try:
        cfg = await ollama_registry.config(app, model, manifest.config_digest)
    except ProviderRefused as exc:
        cfg = None
        cfg_note = f"the registry's config blob could not be read — {exc.detail}"
    else:
        cfg_note = None
    facts = ollama_registry.manifest_to_facts(manifest, cfg)
    return {
        "model": model,
        "source": ollama_registry.SOURCE_KEY,
        "fetched_at": manifest.fetched_at,
        "facts": facts,
        "pull": None,
        **({"note": cfg_note} if cfg_note else {}),
    }
