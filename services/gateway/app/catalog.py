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
from app.catalog_row import BASES, ROW_KEYS, base_row, fact  # noqa: F401 — the shared shape

logger = logging.getLogger("gateway")

_base_row = base_row

SOURCE_TAGS = "ollama-tags"
SOURCE_SHOW = ollama.SHOW_SOURCE
SOURCE_CURATED = "curated"
SOURCE_PROBE = "probe"
SOURCE_LISTING = "provider-listing"
SOURCE_NAME = "name"

CODING_NAME_RE = re.compile(hf_hub.CODING_NAME_PATTERN, re.IGNORECASE)


def _now() -> str:
    return datetime.now(UTC).isoformat()


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


def _iso(value) -> str | None:
    return value.isoformat() if hasattr(value, "isoformat") else value


def local_row(
    tags_row: dict,
    shown: dict | None,
    curated_entry: dict | None,
    probe_row: dict | None,
    fit_probe: dict | None,
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
        if shown.get("note"):
            row["note"] = f"/api/show failed — {shown['note']}"
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
    # The measured VRAM fact is the newest READING (the probe fit reads — the
    # same query /admin/suggest uses), dated by that probe, even when a newer
    # OK probe without a reading is the row's probe block above.
    if fit_probe is not None and fit_probe.get("vram_mb") is not None:
        facts["vram_gb"] = fact(
            round(fit_probe["vram_mb"] / 1024, 1),
            "measured",
            SOURCE_PROBE,
            at=_iso(fit_probe.get("created_at")),
        )
    row["fit"] = _fit_for(curated_entry, fit_probe, fit_ctx)
    # check_update: an installed model can be compared against its source
    # (POST /admin/catalog/drift) — the page derives the button from this.
    row["actions"] = ["use", "probe", "check_update", "remove"]
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
    # The slug was checked against the library on `verified_at`; the
    # use_cases were written on `use_cases_verified_at` — two facts, two
    # dates, and a tag never wears the other's.
    use_cases_at = entry.get("use_cases_verified_at")
    row["sources"].append({"key": SOURCE_CURATED, "url": "curated_models.json", "verified_at": at})
    if entry.get("label"):
        row["label"] = entry["label"]
    if entry.get("note"):
        # A failure note already on the row (an /api/show that did not
        # answer) stays in front; the vetted note follows it.
        row["note"] = f"{row['note']} · {entry['note']}" if row["note"] else entry["note"]
    facts = row["facts"]
    if "params_b" not in facts and isinstance(entry.get("params_b"), int | float):
        facts["params_b"] = fact(float(entry["params_b"]), "vetted", SOURCE_CURATED, at=at)
    if "vram_gb" not in facts and isinstance(entry.get("min_vram_gb"), int | float):
        facts["vram_gb"] = fact(float(entry["min_vram_gb"]), "vetted", SOURCE_CURATED, at=at)
    for use in entry.get("use_cases") or []:
        _put_suitability(
            row["suitability"], use, fact(True, "vetted", SOURCE_CURATED, at=use_cases_at)
        )


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
    """The newest OK probe of the BUNDLED ollama per name (kind='ollama' —
    a second ollama host registered as a provider probes the same bare tag
    and must not lend its numbers to the local row), with latency and time
    for the row's `probe` block. Fit does NOT read this: it reads
    admin._latest_probes (newest with a VRAM reading), the same query
    /admin/suggest uses, so the two verdicts agree by construction."""
    if not names:
        return {}
    rows = await pool.fetch(
        "SELECT DISTINCT ON (model) model, vram_mb, latency_ms, created_at FROM probes "
        "WHERE model = ANY($1) AND ok = true AND kind = 'ollama' "
        "ORDER BY model, created_at DESC",
        names,
    )
    return {row["model"]: dict(row) for row in rows}


SHOW_DEADLINE_S = 15.0


def _show_timed_out(names: list[str]) -> dict[str, dict]:
    note = f"/api/show did not answer within {SHOW_DEADLINE_S:g} s"
    return {
        name: {"facts": {}, "capabilities": {}, "fetched_at": _now(), "cached": False, "note": note}
        for name in names
    }


async def build(
    app,
    pool,
    *,
    fit_context: Callable,
    listing_for: Callable,
    latest_probes: Callable,
) -> dict:
    """The whole catalogue. `fit_context(app, pool)`, `listing_for(app,
    pool, row)` and `latest_probes(pool, names)` are admin.py's own helpers,
    passed in so this module owns no HTTP and the numbers agree with
    /admin/suggest by construction. The local section (tags + show) and the
    provider listings run CONCURRENTLY, and the show fan-out is bounded by
    SHOW_DEADLINE_S — a stalled ollama yields rows with /api/tags facts and
    a stated note, never a page that times out at core."""
    fetched_at = _now()
    sources: list[dict] = []
    rows: list[dict] = []
    curated = curated_mod.load_curated()
    by_slug = {entry["slug"]: entry for entry in curated}
    fit_ctx = await fit_context(app, pool)

    async def local_section() -> tuple[list[dict], list[dict], set[str]]:
        builtin = await providers.get_row(pool, "ollama")
        base_url = providers.base_url_of(builtin)
        try:
            tags = await ollama.ADAPTER.list_models(app, builtin)
        except ProviderRefused as exc:
            failed_source = {"key": "ollama", "ok": False, "rows": 0, "note": exc.detail}
            return [{**failed_source, "fetched_at": fetched_at}], [], set()
        names = [m["id"] for m in tags.models]
        note = None
        try:
            shown = await asyncio.wait_for(
                ollama.facts_for_installed(app, base_url, tags.models), SHOW_DEADLINE_S
            )
        except TimeoutError:
            shown = _show_timed_out(names)
            note = f"/api/show did not answer within {SHOW_DEADLINE_S:g} s — /api/tags facts only"
        probe_blocks = await _probes_by_model(pool, names)
        fit_probes = await latest_probes(pool, names)
        local_rows = [
            local_row(
                tags_row,
                shown.get(tags_row["id"]),
                by_slug.get(tags_row["id"]),
                probe_blocks.get(tags_row["id"]),
                fit_probes.get(tags_row["id"]),
                fit_ctx,
                tags_fetched_at=tags.fetched_at,
            )
            for tags_row in tags.models
        ]
        failed = sum(1 for v in shown.values() if v.get("note"))
        if failed and note is None:
            note = f"/api/show failed for {failed} model(s)"
        source = {"key": "ollama", "ok": True, "rows": len(tags.models)}
        source["fetched_at"] = tags.fetched_at
        if note:
            source["note"] = note
        return [source], local_rows, set(names)

    async def one(provider_row: dict) -> tuple[dict, list[dict]]:
        name = provider_row["name"]
        failed = {"key": name, "ok": False, "rows": 0, "fetched_at": fetched_at}
        try:
            listing = await listing_for(app, pool, provider_row)
        except ListingUnavailable as exc:
            return {**failed, "note": str(exc)}, []
        except ProviderRefused as exc:
            return {**failed, "note": exc.detail}, []
        except Exception as exc:  # a bug or a DB error: NAMED, never an anonymous "provider"
            logger.exception("catalogue: provider %s raised", name)
            return {**failed, "note": f"the listing raised — {adapters.reason(exc)}"}, []
        return (
            {"key": name, "ok": True, "rows": len(listing.models)}
            | {"fetched_at": listing.fetched_at},
            [cloud_row(provider_row, m, listing.fetched_at) for m in listing.models],
        )

    provider_rows = [r for r in await providers.list_rows(pool) if not r["builtin"]]
    local, *provider_results = await asyncio.gather(
        local_section(), *(one(r) for r in provider_rows)
    )
    local_sources, local_rows, installed_tags = local
    sources.extend(local_sources)
    rows.extend(local_rows)

    library = [entry for entry in curated if entry["slug"] not in installed_tags]
    fit_probes = await latest_probes(pool, [entry["slug"] for entry in library])
    for entry in library:
        rows.append(library_row(entry, fit_ctx, fit_probes.get(entry["slug"])))
    sources.append(
        {"key": SOURCE_CURATED, "ok": True, "rows": len(library), "url": "curated_models.json"}
    )

    for source, provider_models in provider_results:
        sources.append(source)
        rows.extend(provider_models)

    return {"fetched_at": fetched_at, "sources": sources, "rows": rows}


# ── Hugging Face and the registry, as rows ────────────────────────────────


def hf_page_rows(page: hf_hub.HfPage, installed_names: set[str] | None) -> list[dict]:
    rows = [
        hf_hub.to_catalog_row(entry, page.fetched_at, cached=page.cached) for entry in page.rows
    ]
    for row in rows:
        mark_hub_installed(row, installed_names)
    return rows


def hf_repo_row(repo: hf_hub.HfRepo, installed_names: set[str] | None) -> dict:
    quants = hf_hub.quants_of(repo.siblings)
    # A detail body without `id` still maps under the ref that was asked for.
    row = hf_hub.to_catalog_row(
        {**repo.data, "id": repo.id}, repo.fetched_at, cached=repo.cached, quants=quants
    )
    mark_hub_installed(row, installed_names)
    return row


def mark_hub_installed(row: dict, installed_names: set[str] | None) -> None:
    """`installed` on a Hub row is THIS host's fact, never the Hub's: True
    when ollama's own tags list the repo under any quant (`hf.co/org/repo:
    Q4_K_M`), naming the installed tag(s); False when the tags were read
    and the repo is not among them; None (unstated) when they could not be
    read."""
    if installed_names is None:
        return
    prefix = f"{row['model']}:"
    hits = sorted(n for n in installed_names if n == row["model"] or n.startswith(prefix))
    if hits:
        row["installed"] = True
        row["note"] = "installed as " + ", ".join(hits)
    else:
        row["installed"] = False


async def installed_names(app, pool) -> set[str] | None:
    """What the bundled ollama lists right now, or None when it could not be
    asked — the caller then leaves `installed` unstated rather than False."""
    try:
        builtin = await providers.get_row(pool, "ollama")
        listing = await ollama.ADAPTER.list_models(app, builtin)
    except (ProviderRefused, providers.UnknownProvider):
        return None
    return {m["id"] for m in listing.models}


async def resolve_ref(app, model: str) -> dict:
    """What a typed ref would pull, resolved live BEFORE any bytes move:
    a Hub repo's quants, or the registry manifest's size/quant/family."""
    model = pulls.validate_model(model)
    if pulls.is_hub_ref(model):
        org, repo, quant = pulls.split_hub_ref(model)
        detail = await hf_hub.repo_detail(app, org, repo)
        row = hf_repo_row(detail, None)  # a preview: installed is the catalogue's to say
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
    cfg = None
    cfg_note = None
    if not manifest.config_digest:
        cfg_note = "the manifest states no config digest — quant, family and params unstated"
    else:
        try:
            cfg = await ollama_registry.config(app, model, manifest.config_digest)
        except (ProviderRefused, ValueError) as exc:
            detail = exc.detail if isinstance(exc, ProviderRefused) else str(exc)
            cfg_note = f"the registry's config blob could not be read — {detail}"
    facts = ollama_registry.manifest_to_facts(manifest, cfg)
    return {
        "model": model,
        "source": ollama_registry.SOURCE_KEY,
        "fetched_at": manifest.fetched_at,
        "facts": facts,
        "pull": None,
        **({"note": cfg_note} if cfg_note else {}),
    }


# ── drift: has the source moved since this was pulled? ────────────────────

WEIGHTS_FROM = re.compile(r"^FROM\s+\S*?sha256[-:]([0-9a-f]{64})\s*$", re.M | re.I)
DRIFT_BASIS = "weights-digest"


def installed_weights_digest(show: dict) -> str | None:
    """The weights blob THIS install runs from, read off /api/show's own
    Modelfile (`FROM /root/.ollama/models/blobs/sha256-<hex>`). Verified
    2026-09-07 on the live stack: that hex equals the registry manifest's
    `application/vnd.ollama.image.model` layer digest for a library tag,
    and the GGUF's `lfs.sha256` for an hf.co pull — so it is the ONE value
    comparable across all three, where the /api/tags digest (a manifest
    hash) is not. None when the Modelfile states no blob."""
    modelfile = show.get("modelfile")
    if not isinstance(modelfile, str):
        return None
    match = WEIGHTS_FROM.search(modelfile)
    return f"sha256:{match.group(1).lower()}" if match else None


def installed_name(tags_models: list[dict], model: str) -> str | None:
    """The tag ollama lists for `model` (itself, or its `:latest` form)."""
    names = {m["id"] for m in tags_models}
    for candidate in (model, f"{model}:latest"):
        if candidate in names:
            return candidate
    return None


async def _upstream_weights(app, name: str) -> tuple[str | None, str, str | None]:
    """(digest, source key, note) for what the source ships NOW: the Hub
    file's sha256 for an hf.co name (the installed quant, else ollama's
    default), the registry manifest's model layer for a library tag."""
    if pulls.is_hub_ref(name):
        org, repo, quant = pulls.split_hub_ref(name)
        detail = await hf_hub.repo_detail(app, org, repo)
        quants = hf_hub.quants_of(detail.siblings)
        # ollama stores a pull typed without a quant as `:latest` — that IS
        # the default quant, not a file called latest (live, 2026-09-07).
        wanted = quant if quant and quant.lower() != "latest" else hf_hub.DEFAULT_QUANT
        chosen = hf_hub.find_quant(quants, wanted)
        if chosen is None:
            return None, hf_hub.SOURCE_KEY, f"{org}/{repo} no longer lists a {wanted} file"
        if not chosen.get("sha256"):
            return None, hf_hub.SOURCE_KEY, f"the Hub states no sha256 for {chosen['filename']}"
        return f"sha256:{chosen['sha256']}", hf_hub.SOURCE_KEY, None
    manifest = await ollama_registry.manifest(app, name)
    for layer in manifest.layers:
        if layer.get("mediaType") == ollama_registry.MODEL_LAYER and layer.get("digest"):
            return str(layer["digest"]).lower(), ollama_registry.SOURCE_KEY, None
    return None, ollama_registry.SOURCE_KEY, "the registry manifest carries no model layer"


async def check_drift(app, pool, model: str) -> dict:
    """Has the source's weights blob changed since `model` was pulled?
    Compares the installed Modelfile's blob digest with the source's
    current one. NEVER pulls, never re-resolves the tag to another model:
    `moved` is True/False only when both digests were read, else None with
    the reason. The catalogue's `drift` block is exactly this shape."""
    model = pulls.validate_model(model)
    builtin = await providers.get_row(pool, "ollama")
    listing = await ollama.ADAPTER.list_models(app, builtin)
    name = installed_name(listing.models, model)
    if name is None:
        raise NotInstalled(f"{model!r} is not installed on the bundled ollama")
    checked_at = _now()
    show = await ollama.show(app, providers.base_url_of(builtin), name)
    installed = installed_weights_digest(show)
    result = {
        "model": name,
        "checked_at": checked_at,
        "installed_digest": installed,
        "upstream_digest": None,
        "moved": None,
        "basis": DRIFT_BASIS,
        "source": None,
    }
    if installed is None:
        result["note"] = "ollama's Modelfile states no weights blob for this model"
        return result
    try:
        upstream, source, note = await _upstream_weights(app, name)
    except hf_hub.RateLimited as exc:  # a ProviderRefused too: named first
        result["note"] = f"the source could not be read — {exc.detail}"
        result["retry_after_s"] = exc.retry_after_s
        return result
    except ProviderRefused as exc:
        result["note"] = f"the source could not be read — {exc.detail}"
        return result
    result["source"] = source
    result["upstream_digest"] = upstream
    if upstream is None:
        result["note"] = note
        return result
    result["moved"] = upstream != installed
    return result


class NotInstalled(LookupError):
    pass
