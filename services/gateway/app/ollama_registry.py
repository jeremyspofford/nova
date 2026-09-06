"""registry.ollama.ai, read live: what a library tag would download.

Verified live on 2026-09-06: GET /v2/{namespace}/{name}/manifests/{tag}
(anonymous; "library" is the namespace of official tags; the tag defaults
to "latest") answers a Docker v2 manifest as text/plain — `config`
{digest, size} plus `layers` [{mediaType, digest, size}], where the
`application/vnd.ollama.image.model` layer is the weights and the others
are template / license / params — with a Docker-Content-Digest header.
GET .../blobs/{config digest} is {"model_format": "gguf", "model_family":
"qwen3", "model_families": [...], "model_type": "8.2B", "file_type":
"Q4_K_M", "architecture": "amd64", ...} — and that "architecture" is the
CPU arch, never the model's, so `family` reads `model_family`. The
registry cannot be enumerated (.../tags/list is 404), a 404 manifest
means the tag is not in the library, and `hf.co/...` refs are not registry
refs at all (the registry 404s them) — they are a different source.

Every fact leaves here labelled `declared` by `ollama-registry`; a cached
manifest keeps its original fetched_at and is marked cached (1 h).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, replace
from datetime import UTC, datetime

import httpx

from app.adapters.base import ProviderRefused, http_client, reason, refusal_detail
from app.hf_hub import TTLCache

REGISTRY_BASE = "https://registry.ollama.ai"
REGISTRY_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)
MANIFEST_ACCEPT = "application/vnd.docker.distribution.manifest.v2+json"
MODEL_LAYER = "application/vnd.ollama.image.model"
MANIFEST_TTL_S = 3600
SOURCE_KEY = "ollama-registry"
SOURCE_URL = f"{REGISTRY_BASE}/v2"
REGISTRY_HOST = "registry.ollama.ai"
HUB_PREFIXES = ("hf.co/", "huggingface.co/")

SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
PARAMS_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([BbMm])\s*$")


class NotARegistryRef(ValueError):
    """The string names a model somewhere other than registry.ollama.ai
    (a Hugging Face repo, a foreign registry) — a fact about the ref, not a
    malformed one."""


@dataclass(frozen=True)
class Ref:
    namespace: str
    name: str
    tag: str

    @property
    def path(self) -> str:
        return f"{self.namespace}/{self.name}/{self.tag}"


def split_ref(model: str) -> Ref:
    """`qwen3:8b` -> library/qwen3/8b; `qwen3` -> tag latest;
    `user/name:tag` keeps the namespace; `registry.ollama.ai/ns/name:tag`
    drops its own host. `hf.co/...` and `huggingface.co/...` raise
    NotARegistryRef (ollama pulls those from the Hub); a malformed segment
    is a ValueError — every segment is checked against
    ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ before it can become a URL."""
    if not isinstance(model, str) or not model:
        raise ValueError("model must be a non-empty string")
    if model.lower().startswith(HUB_PREFIXES):
        raise NotARegistryRef(f"{model!r} is a Hugging Face reference, not an ollama library tag")
    path, colon, tag = model.partition(":")
    if not colon:
        tag = "latest"
    segments = path.split("/")
    if len(segments) == 3:
        if segments[0].lower() != REGISTRY_HOST:
            raise NotARegistryRef(
                f"{model!r} names the registry {segments[0]!r}, not {REGISTRY_HOST}"
            )
        segments = segments[1:]
    if len(segments) == 1:
        namespace, name = "library", segments[0]
    elif len(segments) == 2:
        namespace, name = segments
    else:
        raise ValueError(
            f"{model!r} is not a model reference — expected name[:tag] or namespace/name[:tag]"
        )
    for segment in (namespace, name, tag):
        if not SEGMENT_RE.match(segment):
            raise ValueError(
                f"{model!r}: {segment!r} is not a valid reference segment (letters, digits, "
                "'.', '_' or '-', 1-128 chars, starting with a letter or digit)"
            )
    return Ref(namespace, name, tag)


@dataclass
class Manifest:
    """A parsed registry manifest. `weights_bytes` is the model layer alone
    (None when the manifest has none — a fact, not a zero); `total_bytes`
    is every layer, which is what ollama downloads; `digest` is the
    Docker-Content-Digest header when the registry sent one."""

    model: str
    ref: Ref
    layers: list[dict]
    weights_bytes: int | None
    total_bytes: int
    config_digest: str | None
    config_size: int | None
    digest: str | None
    fetched_at: str
    cached: bool


MANIFEST_CACHE = TTLCache(MANIFEST_TTL_S)
CONFIG_CACHE = TTLCache(MANIFEST_TTL_S)


def clear() -> None:
    MANIFEST_CACHE.clear()
    CONFIG_CACHE.clear()


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _size(value) -> int | None:
    if isinstance(value, int | float) and not isinstance(value, bool) and value >= 0:
        return int(value)
    return None


def parse_manifest(model: str, ref: Ref, body: dict, digest: str | None) -> Manifest:
    """Pure: the manifest body (plus the response's digest header) into a
    Manifest. A body without a `layers` list, or a layer without a stated
    size, is a ValueError — a total that silently skipped a layer would
    read as a smaller download than the real one."""
    if not isinstance(body, dict) or not isinstance(body.get("layers"), list):
        raise ValueError("the manifest carries no layers list")
    layers: list[dict] = []
    weights: list[int] = []
    total = 0
    for layer in body["layers"]:
        if not isinstance(layer, dict):
            raise ValueError("a manifest layer is not an object")
        size = _size(layer.get("size"))
        if size is None:
            raise ValueError(f"manifest layer {layer.get('digest')!r} states no size")
        entry = {
            "mediaType": layer.get("mediaType"),
            "digest": layer.get("digest"),
            "size": size,
        }
        layers.append(entry)
        total += size
        if entry["mediaType"] == MODEL_LAYER:
            weights.append(size)
    config = body.get("config") if isinstance(body.get("config"), dict) else {}
    config_digest = config.get("digest") if isinstance(config.get("digest"), str) else None
    return Manifest(
        model=model,
        ref=ref,
        layers=layers,
        weights_bytes=sum(weights) if weights else None,
        total_bytes=total,
        config_digest=config_digest,
        config_size=_size(config.get("size")),
        digest=digest if isinstance(digest, str) and digest else None,
        fetched_at=_now(),
        cached=False,
    )


async def _get(
    app, path: str, *, accept: str | None = None, follow_redirects: bool = False
) -> httpx.Response:
    headers = {"Accept": accept} if accept else None
    client = http_client(app, REGISTRY_TIMEOUT, base_url=REGISTRY_BASE, headers=headers)
    try:
        async with client as c:
            return await c.get(path, follow_redirects=follow_redirects)
    except httpx.HTTPError as exc:
        raise ProviderRefused(
            502, f"could not reach the ollama registry at {REGISTRY_BASE} — {reason(exc)}"
        ) from exc


async def manifest(app, model: str) -> Manifest:
    """GET /v2/{ns}/{name}/manifests/{tag}. 404 means the tag is not in
    the library — said in those words; any other refusal carries the
    registry's own. Cached 1 h by ref."""
    ref = split_ref(model)
    hit = MANIFEST_CACHE.get(ref.path)
    if hit is not None:
        found, _fetched_at = hit
        return replace(found, model=model, cached=True)
    resp = await _get(
        app, f"/v2/{ref.namespace}/{ref.name}/manifests/{ref.tag}", accept=MANIFEST_ACCEPT
    )
    if resp.status_code == 404:
        raise ProviderRefused(
            404, f"{model!r} is not in the ollama library (registry answered 404)"
        )
    if resp.status_code != 200:
        raise ProviderRefused(
            resp.status_code,
            f"the ollama registry refused {model!r} ({resp.status_code}): {refusal_detail(resp)}",
        )
    try:
        body = resp.json()  # served as text/plain; the bytes are JSON
    except ValueError as exc:
        raise ProviderRefused(
            502, f"the ollama registry answered a non-JSON manifest for {model!r}: {exc}"
        ) from exc
    try:
        parsed = parse_manifest(model, ref, body, resp.headers.get("docker-content-digest"))
    except ValueError as exc:
        raise ProviderRefused(502, f"the manifest for {model!r} is unreadable — {exc}") from exc
    MANIFEST_CACHE.put(ref.path, parsed, parsed.fetched_at)
    return parsed


async def config(app, model: str, config_digest: str) -> dict:
    """GET /v2/{ns}/{name}/blobs/{config digest} — {model_format,
    model_family, model_families, model_type, file_type, architecture}.
    Content-addressed, so cached by digest.

    Followed to the blob store: a live run on 2026-09-06 showed the
    registry answers a blob GET with a 307 Temporary Redirect to its store
    (the manifest answers 200 directly), and httpx does not follow
    redirects unless told — without this the config read "failed" on
    every tag and quant / family / params were silently absent."""
    ref = split_ref(model)
    if not isinstance(config_digest, str) or not DIGEST_RE.match(config_digest):
        raise ValueError(f"{config_digest!r} is not a sha256 digest")
    hit = CONFIG_CACHE.get(config_digest)
    if hit is not None:
        return dict(hit[0])
    resp = await _get(
        app, f"/v2/{ref.namespace}/{ref.name}/blobs/{config_digest}", follow_redirects=True
    )
    if resp.status_code == 404:
        raise ProviderRefused(
            404, f"the config blob {config_digest} for {model!r} is not in the registry"
        )
    if resp.status_code != 200:
        raise ProviderRefused(
            resp.status_code,
            f"the ollama registry refused the config of {model!r} ({resp.status_code}): "
            f"{refusal_detail(resp)}",
        )
    try:
        body = resp.json()
    except ValueError as exc:
        raise ProviderRefused(
            502, f"the config blob for {model!r} is not JSON: {exc}"
        ) from exc
    if not isinstance(body, dict):
        raise ProviderRefused(502, f"the config blob for {model!r} is not an object")
    CONFIG_CACHE.put(config_digest, body, _now())
    return dict(body)


def parse_params_b(model_type) -> float | None:
    """`model_type` "8.2B" -> 8.2, "235B" -> 235.0, "500M" -> 0.5; anything
    else is not a parameter count this code understands — absent."""
    if not isinstance(model_type, str):
        return None
    match = PARAMS_RE.match(model_type)
    if match is None:
        return None
    value = float(match.group(1))
    return value if match.group(2).upper() == "B" else round(value / 1000, 3)


def _fact(value) -> dict:
    return {"value": value, "basis": "declared", "source": SOURCE_KEY}


def manifest_to_facts(parsed: Manifest, cfg: dict | None) -> dict:
    """The catalogue facts a manifest (and its config blob) declares:
    size_bytes (every layer — the download), weights_bytes (the model
    layer), digest (the manifest's), quant (`file_type`), params_b
    (`model_type`), family (`model_family` — never the blob's
    `architecture`, which is the CPU's). Each is absent when unstated."""
    facts = {"size_bytes": _fact(parsed.total_bytes)}
    if parsed.weights_bytes is not None:
        facts["weights_bytes"] = _fact(parsed.weights_bytes)
    if parsed.digest:
        facts["digest"] = _fact(parsed.digest)
    if cfg:
        if isinstance(cfg.get("file_type"), str) and cfg["file_type"]:
            facts["quant"] = _fact(cfg["file_type"])
        params_b = parse_params_b(cfg.get("model_type"))
        if params_b is not None:
            facts["params_b"] = _fact(params_b)
        if isinstance(cfg.get("model_family"), str) and cfg["model_family"]:
            facts["family"] = _fact(cfg["model_family"])
    return facts
