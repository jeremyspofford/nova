"""Sizing a pull honestly, before ollama starts downloading.

`POST /admin/pull`'s first line used to read a `size_gb` someone typed
into curated_models.json — a number that went stale the day a tag was
re-pushed, and that did not exist at all for anything off the curated
list. Now the size is DERIVED from the source ollama itself downloads
from: the registry manifest for a library tag (ollama fetches every layer,
so the sum of the layers is the download), the Hugging Face sibling for an
`hf.co/org/repo[:quant]` ref (plus the mmproj projector ollama fetches
alongside it). Whatever cannot be sized says WHY — never a stale number
dressed as a measurement. The metadata fetch is bounded so it can delay a
pull's first line by at most METADATA_BUDGET_S; a timeout is stated too.
"""

from __future__ import annotations

import asyncio
import logging
import re

from app import hf_hub, ollama_registry
from app.adapters.base import ProviderRefused

logger = logging.getLogger("gateway")

# What ollama accepts as a model string: a name, a namespace/name, an
# hf.co/org/repo path, optionally :tag. Checked BEFORE anything is called,
# so a stray string never becomes a URL path or an ollama request.
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-/]*(:[A-Za-z0-9._\-]+)?$")
METADATA_BUDGET_S = 10.0
HUB_PREFIXES = ("hf.co/", "huggingface.co/")

SOURCE_HUB = hf_hub.SOURCE_KEY
SOURCE_REGISTRY = ollama_registry.SOURCE_KEY


def validate_model(model) -> str:
    if not isinstance(model, str) or not MODEL_RE.match(model):
        raise ValueError(
            "model must look like name[:tag], namespace/name[:tag] or hf.co/org/repo[:quant] "
            f"(letters, digits, '.', '_', '-', '/') — got {model!r}"
        )
    return model


def canonical_ref(model: str) -> str:
    """One key per download, however the ref was spelled: a Hub ref lower-
    cased with its quant (the default named as such, since ollama pulls the
    same Q4_K_M for `hf.co/o/r` and `hf.co/o/r:Q4_K_M`), a registry ref as
    `namespace/name:tag` with the library namespace and `latest` made
    explicit. `validate_model` runs first."""
    if is_hub_ref(model):
        org, repo, quant = split_hub_ref(model)
        return f"hf.co/{org}/{repo}:{quant or hf_hub.DEFAULT_QUANT}".lower()
    try:
        ref = ollama_registry.split_ref(model)
    except (ollama_registry.NotARegistryRef, ValueError):
        return model  # another registry's ref: ollama decides; the string is the key
    return f"{ref.namespace}/{ref.name}:{ref.tag}"


def is_hub_ref(model: str) -> bool:
    return model.lower().startswith(HUB_PREFIXES)


def split_hub_ref(model: str) -> tuple[str, str, str | None]:
    """`hf.co/org/repo[:quant]` -> (org, repo, quant or None)."""
    path, colon, quant = model.partition(":")
    segments = path.split("/")
    if len(segments) != 3:
        raise ValueError(
            f"{model!r} is not a Hugging Face reference — expected hf.co/org/repo[:quant]"
        )
    org, repo = hf_hub.validate_repo_ref(segments[1], segments[2])
    return org, repo, (quant if colon and quant else None)


def _unknown(model: str, why: str, resolved: dict | None = None) -> dict:
    return {
        "size_bytes": None,
        "size_source": None,
        "resolved": resolved or {},
        "note": f"model size for {model!r} is unknown — {why}",
    }


async def pull_size(app, model: str) -> dict:
    """{size_bytes, size_source, resolved, note} for a model string ollama
    would pull. `size_bytes` is None exactly when `note` says why; `resolved`
    carries whatever the source stated of {quant, family, params_b} (and
    `mmproj_bytes` when a projector is part of the download). Bounded to
    METADATA_BUDGET_S so the metadata can never hold a pull hostage."""
    try:
        return await asyncio.wait_for(_pull_size(app, model), METADATA_BUDGET_S)
    except TimeoutError:
        return _unknown(model, f"sizing it took longer than {METADATA_BUDGET_S:g}s")


async def _pull_size(app, model: str) -> dict:
    if is_hub_ref(model):
        return await _hub_size(app, model)
    try:
        ollama_registry.split_ref(model)
    except ollama_registry.NotARegistryRef as exc:
        return _unknown(model, f"{exc}; it is neither an ollama library tag nor an hf.co ref")
    except ValueError as exc:
        return _unknown(model, str(exc))
    return await _registry_size(app, model)


async def _hub_size(app, model: str) -> dict:
    try:
        org, repo, wanted = split_hub_ref(model)
    except ValueError as exc:
        return _unknown(model, str(exc))
    try:
        detail = await hf_hub.repo_detail(app, org, repo)
    except ProviderRefused as exc:  # RateLimited included — its detail names the wait
        return _unknown(model, exc.detail)
    gguf = detail.data.get("gguf") if isinstance(detail.data.get("gguf"), dict) else {}
    resolved: dict = {}
    if isinstance(gguf.get("architecture"), str) and gguf["architecture"]:
        resolved["family"] = gguf["architecture"]
    total = gguf.get("total")
    if isinstance(total, int | float) and not isinstance(total, bool) and total > 0:
        resolved["params_b"] = round(total / 1e9, 2)

    quants = hf_hub.quants_of(detail.siblings)
    if not quants:
        return _unknown(model, f"hf.co/{org}/{repo} has no GGUF files", resolved)
    available = ", ".join(q["tag"] for q in quants)
    if wanted is not None:
        chosen = hf_hub.find_quant(quants, wanted)
        if chosen is None:
            return _unknown(
                model,
                f"hf.co/{org}/{repo} has no quant {wanted!r}; available: {available}",
                resolved,
            )
    else:
        chosen = next((q for q in quants if q["is_default"]), None)
        if chosen is None:
            return _unknown(
                model,
                f"pick a quant: hf.co/{org}/{repo} has no {hf_hub.DEFAULT_QUANT} to default to; "
                f"available: {available}",
                resolved,
            )
    resolved["quant"] = chosen["tag"]
    if chosen["size_bytes"] is None:
        return _unknown(model, f"Hugging Face states no size for {chosen['filename']}", resolved)
    size = chosen["size_bytes"]
    if chosen.get("mmproj_bytes") is not None:
        # ollama fetches the projector too — it is part of the download.
        resolved["mmproj_bytes"] = chosen["mmproj_bytes"]
        size += chosen["mmproj_bytes"]
    return {"size_bytes": size, "size_source": SOURCE_HUB, "resolved": resolved, "note": None}


async def _registry_size(app, model: str) -> dict:
    try:
        parsed = await ollama_registry.manifest(app, model)
    except ProviderRefused as exc:
        return _unknown(model, exc.detail)
    resolved: dict = {}
    note = None
    if not parsed.config_digest:
        note = "the manifest states no config digest — quant, family and params unstated"
    else:
        try:
            cfg = await ollama_registry.config(app, model, parsed.config_digest)
        except (ProviderRefused, ValueError) as exc:
            # The size is still the manifest's; quant/family/params are
            # unstated, and the preflight line SAYS so rather than leaving
            # an empty `resolved` to be read as "nothing to resolve".
            logger.warning("registry config for %s unreadable: %s", model, exc)
            detail = exc.detail if isinstance(exc, ProviderRefused) else str(exc)
            note = f"the registry's config blob could not be read — {detail}"
        else:
            facts = ollama_registry.manifest_to_facts(parsed, cfg)
            resolved = {
                key: facts[key]["value"] for key in ("quant", "family", "params_b") if key in facts
            }
    return {
        "size_bytes": parsed.total_bytes,
        "size_source": SOURCE_REGISTRY,
        "resolved": resolved,
        "note": note,
    }
