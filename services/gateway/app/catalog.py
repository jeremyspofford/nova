"""The model catalogue: every source mapped into ONE row shape.

Assembles, with no HTTP of its own: installed models on every engine
(each engine's own /api/tags + /api/show, ids `{engine}:{tag}`, one source
per engine keyed by its name — S40), the curated picks no engine holds
(`library:{slug}`, the vetted layer), and every registered provider's
listing. Each row is
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
import json
import logging
import re
from collections.abc import Callable
from datetime import UTC, datetime

from app import adapters, engines, hf_hub, ollama_registry, providers, pulls
from app import curated as curated_mod
from app import fit as fit_mod
from app.adapters import (
    ListingUnavailable,
    ProviderRefused,
    ollama,
    openai_chat,
)
from app.catalog_row import (  # noqa: F401 — the shared shape
    BASES,
    LIBRARY,
    ROW_KEYS,
    base_row,
    fact,
)

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
    engine: str,
) -> dict:
    """One installed model from ONE engine's own state (+ the vetted layer).
    Its id is `{engine}:{tag}` — what a chain link or chat.model names it by
    (S40, D21)."""
    name = tags_row["id"]
    row = _base_row(f"{engine}:{name}", engine, name, name, "local")
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
            # Where it ran (D10): the card, or `cpu:…+gpu:…` for a partly
            # offloaded run; None when the stamp was omitted.
            "compute": probe_row.get("compute"),
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
    # The installed model's own download size — a fact about THIS host's
    # copy, preferred over a hand-written integer when there is no probe
    # (S22, see fit.py's precedence). Taken from `fit_ctx`, the ONE map
    # /admin/suggest reads too, so the two surfaces cannot size the same
    # model differently.
    row["fit"] = _fit_for(curated_entry, fit_probe, fit_ctx, size_bytes=fit_ctx["sizes"].get(name))
    # check_update: an installed model can be compared against its source
    # (POST /admin/catalog/drift) — the page derives the button from this.
    row["actions"] = ["use", "probe", "check_update", "remove"]
    return row


def library_row(curated_entry: dict, fit_ctx: dict, probe_row: dict | None) -> dict:
    """A curated pick that no engine holds: the vetted layer is all there is
    until it is pulled (or resolved live from the registry). It is on no
    machine, so its id is `library:{slug}` (S40) — never an engine's."""
    slug = curated_entry["slug"]
    row = _base_row(f"{LIBRARY}:{slug}", LIBRARY, slug, curated_entry.get("label") or slug, "local")
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


def _fit_for(
    curated_entry: dict | None,
    probe_row: dict | None,
    fit_ctx: dict,
    *,
    size_bytes: int | None = None,
) -> dict:
    """The verdict, or an honest `unknown` when there is nothing at all to
    size the model by — no probe, no download size, not in the curated
    list."""
    free_gb, total_gb, reason = fit_ctx["free_gb"], fit_ctx["total_gb"], fit_ctx["reason"]
    has_probe = probe_row is not None and probe_row.get("vram_mb") is not None
    if curated_entry is None and not has_probe and not size_bytes:
        return fit_mod.compute_fit(
            None,
            free_gb,
            total_gb,
            source=fit_mod.SOURCE_ESTIMATED,
            reason="no estimate — not in the curated list, never probed, size unstated",
        )
    needed_gb, source = fit_mod.needed_gb_for(curated_entry or {}, probe_row, size_bytes)
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


async def _probes_by_model(pool, names: list[str], provider: str) -> dict[str, dict]:
    """The newest OK probe per name taken ON THIS ENGINE (`probes.provider`,
    stamped since migration 009 — a second machine probes the same bare tag
    and must not lend its numbers to this engine's row), with latency, time
    and the compute it ran on for the row's `probe` block. A row from before
    009 names no engine and is nobody's until re-probed. Fit does NOT read
    this: it reads admin._latest_probes (keyed by compute), the same query
    /admin/suggest uses, so the two verdicts agree by construction."""
    if not names:
        return {}
    rows = await pool.fetch(
        "SELECT DISTINCT ON (model) model, vram_mb, latency_ms, compute, created_at FROM probes "
        "WHERE model = ANY($1) AND provider = $2 AND ok = true "
        "ORDER BY model, created_at DESC",
        names,
        provider,
    )
    return {row["model"]: dict(row) for row in rows}


def _read_at(value: object) -> datetime:
    """When an /api/show answer was read: its own `fetched_at` — a cached
    answer keeps the time it was ORIGINALLY read (app/cache.py's rail), so a
    row never claims a fresher reading than happened."""
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            pass
    return datetime.now(UTC)


async def _remember_models(
    pool, engine: str, tags_models: list[dict], shown: dict[str, dict]
) -> None:
    """What THIS engine's /api/show said about each model it lists, kept in
    `engine_models` (S40 ruling G1): the digest the answer is about, the
    capabilities ollama declared (NULL when it declared none — never "none"),
    the context length it stated, and when it was read. One row per (engine,
    name), updated on every read. A show that failed or timed out said
    nothing, so nothing is written for it: a row is only ever what was read."""
    records = []
    for tags_row in tags_models:
        name = tags_row["id"]
        answer = shown.get(name)
        if answer is None or answer.get("note"):
            continue
        capabilities = [
            key
            for key, entry in (answer.get("capabilities") or {}).items()
            if isinstance(entry, dict) and entry.get("value") is True
        ]
        context = ((answer.get("facts") or {}).get("context_length") or {}).get("value")
        records.append(
            (
                engine,
                name,
                tags_row.get("digest"),
                json.dumps(capabilities) if capabilities else None,
                context if isinstance(context, int) and context > 0 else None,
                _read_at(answer.get("fetched_at")),
            )
        )
    if not records:
        return
    await pool.executemany(
        "INSERT INTO engine_models (provider, name, digest, capabilities, context_length, "
        "read_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6) ON CONFLICT (provider, name) DO UPDATE "
        "SET digest = EXCLUDED.digest, capabilities = EXCLUDED.capabilities, "
        "context_length = EXCLUDED.context_length, read_at = EXCLUDED.read_at",
        records,
    )


SHOW_DEADLINE_S = 15.0


def _show_timed_out(names: list[str]) -> dict[str, dict]:
    note = f"/api/show did not answer within {SHOW_DEADLINE_S:g} s"
    return {
        name: {"facts": {}, "capabilities": {}, "fetched_at": _now(), "cached": False, "note": note}
        for name in names
    }


# The fit context when no machine here runs models: every verdict `unknown`,
# saying why (library rows still list — they are pullable once one exists).
_NO_ENGINE = {
    "engine": None,
    "compute": None,
    "fit_frame": None,
    "free_gb": None,
    "total_gb": None,
    "reason": "no machine here runs models",
    "sizes": {},
}


async def build(
    app,
    pool,
    *,
    fit_context: Callable,
    listing_for: Callable,
    latest_probes: Callable,
) -> dict:
    """The whole catalogue. `fit_context(app, pool, engine_row)`,
    `listing_for(app, pool, row)` and `latest_probes(pool, names, *,
    compute)` are admin.py's own helpers, passed in so this module owns no
    HTTP and the numbers agree with /admin/suggest by construction. One
    section per ENGINE (S40), each its own source keyed by the engine's name
    (`kind: "engine"`), and the provider listings, all CONCURRENTLY; the
    show fan-out is bounded by SHOW_DEADLINE_S — a stalled ollama yields
    rows with /api/tags facts and a stated note, never a page that times out
    at core. Library rows are the curated picks no engine lists; their fit
    is the builtin's — the machine a bare pull lands on while it is the only
    one (S44 adds a fit per engine)."""
    fetched_at = _now()
    sources: list[dict] = []
    rows: list[dict] = []
    curated = curated_mod.load_curated()
    by_slug = {entry["slug"]: entry for entry in curated}
    engine_rows = await engines.rows(pool)
    contexts = await asyncio.gather(*(fit_context(app, pool, r) for r in engine_rows))
    fit_by_engine = {r["name"]: ctx for r, ctx in zip(engine_rows, contexts, strict=True)}

    async def engine_section(engine_row: dict) -> tuple[dict, list[dict], set[str] | None]:
        engine = engine_row["name"]
        fit_ctx = fit_by_engine[engine]
        try:
            tags = await ollama.ADAPTER.list_models(app, engine_row)
        except ProviderRefused as exc:
            failed = {"key": engine, "kind": "engine", "ok": False, "rows": 0, "note": exc.detail}
            return {**failed, "fetched_at": fetched_at}, [], None
        names = [m["id"] for m in tags.models]
        note = None
        try:
            shown = await asyncio.wait_for(
                ollama.facts_for_installed(app, providers.base_url_of(engine_row), tags.models),
                SHOW_DEADLINE_S,
            )
        except TimeoutError:
            shown = _show_timed_out(names)
            note = f"/api/show did not answer within {SHOW_DEADLINE_S:g} s — /api/tags facts only"
        await _remember_models(pool, engine, tags.models, shown)
        probe_blocks = await _probes_by_model(pool, names, engine)
        fit_probes = await latest_probes(pool, names, compute=fit_ctx["compute"])
        local_rows = [
            local_row(
                tags_row,
                shown.get(tags_row["id"]),
                by_slug.get(tags_row["id"]),
                probe_blocks.get(tags_row["id"]),
                fit_probes.get(tags_row["id"]),
                fit_ctx,
                tags_fetched_at=tags.fetched_at,
                engine=engine,
            )
            for tags_row in tags.models
        ]
        failed = sum(1 for v in shown.values() if v.get("note"))
        if failed and note is None:
            note = f"/api/show failed for {failed} model(s)"
        source = {"key": engine, "kind": "engine", "ok": True, "rows": len(tags.models)}
        source["fetched_at"] = tags.fetched_at
        if note:
            source["note"] = note
        return source, local_rows, set(names)

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

    # A machine that runs models is an engine section, never a cloud listing.
    cloud_rows = [r for r in await providers.list_rows(pool) if not engines.is_engine(r)]
    results = await asyncio.gather(
        *(engine_section(r) for r in engine_rows), *(one(r) for r in cloud_rows)
    )
    installed_anywhere: set[str] = set()
    for source, local_rows, installed in results[: len(engine_rows)]:
        sources.append(source)
        rows.extend(local_rows)
        installed_anywhere |= installed or set()

    library = [entry for entry in curated if entry["slug"] not in installed_anywhere]
    library_ctx = fit_by_engine[engine_rows[0]["name"]] if engine_rows else _NO_ENGINE
    fit_probes = await latest_probes(
        pool, [entry["slug"] for entry in library], compute=library_ctx["compute"]
    )
    for entry in library:
        rows.append(library_row(entry, library_ctx, fit_probes.get(entry["slug"])))
    sources.append(
        {"key": SOURCE_CURATED, "ok": True, "rows": len(library), "url": "curated_models.json"}
    )

    for source, provider_models in results[len(engine_rows) :]:
        sources.append(source)
        rows.extend(provider_models)

    return {"fetched_at": fetched_at, "sources": sources, "rows": rows}


# ── Hugging Face and the registry, as rows ────────────────────────────────


def hf_page_rows(page: hf_hub.HfPage, installed: dict[str, set[str] | None] | None) -> list[dict]:
    rows = [
        hf_hub.to_catalog_row(entry, page.fetched_at, cached=page.cached) for entry in page.rows
    ]
    for row in rows:
        mark_hub_installed(row, installed)
    return rows


def hf_repo_row(repo: hf_hub.HfRepo, installed: dict[str, set[str] | None] | None) -> dict:
    quants = hf_hub.quants_of(repo.siblings)
    # A detail body without `id` still maps under the ref that was asked for.
    row = hf_hub.to_catalog_row(
        {**repo.data, "id": repo.id}, repo.fetched_at, cached=repo.cached, quants=quants
    )
    mark_hub_installed(row, installed)
    return row


def mark_hub_installed(row: dict, installed: dict[str, set[str] | None] | None) -> None:
    """`installed` on a Hub row is a fact about THIS hub's machines, never
    the Hub's: True when any engine's own tags list the repo under any quant
    (`hf.co/org/repo:Q4_K_M`), naming each as `{engine}:{tag}` — the id to
    use; False when every engine's tags were read and none lists it; None
    (unstated) when one could not be read and none that could lists it."""
    if not installed:
        return
    prefix = f"{row['model']}:"
    hits = sorted(
        f"{engine}:{name}"
        for engine, names in installed.items()
        for name in names or ()
        if name == row["model"] or name.startswith(prefix)
    )
    if hits:
        row["installed"] = True
        row["note"] = "installed as " + ", ".join(hits)
    elif all(names is not None for names in installed.values()):
        row["installed"] = False


async def installed_names(app, pool) -> dict[str, set[str] | None]:
    """{engine: what it lists right now, or None when it could not be asked}
    — one entry per machine that runs models, read live. A machine that
    could not be asked leaves `installed` unstated rather than False."""
    out: dict[str, set[str] | None] = {}
    for engine_row in await engines.rows(pool):
        try:
            listing = await ollama.ADAPTER.list_models(app, engine_row)
        except ProviderRefused:
            out[engine_row["name"]] = None
        else:
            out[engine_row["name"]] = {m["id"] for m in listing.models}
    return out


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
    builtin = await providers.get_row(pool, providers.BUILTIN)
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
