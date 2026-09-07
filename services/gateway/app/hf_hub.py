"""Hugging Face Hub, read live: the GGUF repos ollama can pull as
`hf.co/{org}/{repo}[:{quant}]`.

Everything here is DERIVED from the Hub's own API in the shapes verified
live on 2026-09-06 (quoted on each function) and labelled with where and
when it was fetched. A fact the Hub did not state is absent, never guessed.

The Hub's anonymous quota is 500 requests per 5-minute FIXED window per
IP — a 429 beyond it, with headers like `ratelimit: "api";r=499;t=104` and
`ratelimit-policy: "fixed window";"api";q=500;w=300` — and that IP is the
whole household's egress. So this process refuses BEFORE the call that
would overrun it (a sliding window of the same size never admits more
calls in any 300 s span than a fixed one would, so staying inside it here
keeps us inside theirs), and a 429 that arrives anyway is stated with the
Hub's own Retry-After — never retried silently, never masked as "no
results". Search pages are cached 60 s, repo details 10 min; a cached
answer keeps its ORIGINAL fetched_at and is marked cached.
"""

from __future__ import annotations

import math
import os
import re
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

import httpx

from app.adapters.base import ProviderRefused, http_client, reason, refusal_detail
from app.cache import TTLCache
from app.catalog_row import base_row

HF_BASE = "https://huggingface.co"
HF_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)
BUDGET_LIMIT = 500
BUDGET_WINDOW_S = 300
SORTS = ("downloads", "likes", "trendingScore", "lastModified")
PAGE_LIMIT_MAX = 50
QUERY_MAX_CHARS = 200
SEARCH_TTL_S = 60
DETAIL_TTL_S = 600
# The seven expand[] params of the verified query, in its order.
EXPANDS = ("gguf", "downloads", "likes", "lastModified", "tags", "pipeline_tag", "gated")
SOURCE_KEY = "hf-hub"
SOURCE_URL = f"{HF_BASE}/api/models"
DEFAULT_QUANT = "Q4_K_M"  # ollama's own default when a repo carries it

CURSOR_RE = re.compile(r"^[A-Za-z0-9_=-]+$")
SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
CODING_NAME_PATTERN = r"coder|code(?!x)|codestral|starcoder|devstral"
CODING_NAME_RE = re.compile(CODING_NAME_PATTERN, re.IGNORECASE)
VISION_TAG_RE = re.compile(r"vision|(?:^|[-_])vl(?:$|[-_])", re.IGNORECASE)
# "…-00001-of-00002.gguf": one quant split across files.
PART_RE = re.compile(r"-\d{5}-of-\d{5}$")


def _now() -> str:
    return datetime.now(UTC).isoformat()


class RateLimited(ProviderRefused):
    """The Hub's quota would be, or was, exceeded. `retry_after_s` is when a
    retry could succeed: the Hub's own Retry-After / ratelimit header on a
    real 429, else the local window. A ProviderRefused(429), so every
    caller that already states a refusal states this one too."""

    def __init__(self, retry_after_s: int, detail: str) -> None:
        super().__init__(429, detail)
        self.retry_after_s = retry_after_s


class Budget:
    """A sliding window of request timestamps that refuses BEFORE the call
    which would make it `limit` calls in `window_s`. Process-local by
    design: the gateway is the one process on this host that talks to the
    Hub, and the quota it guards is per egress IP."""

    def __init__(
        self,
        limit: int = BUDGET_LIMIT,
        window_s: float = BUDGET_WINDOW_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.limit = limit
        self.window_s = window_s
        self._clock = clock
        self._stamps: deque[float] = deque()

    def _prune(self, now: float) -> None:
        while self._stamps and self._stamps[0] <= now - self.window_s:
            self._stamps.popleft()

    def remaining(self) -> int:
        self._prune(self._clock())
        return max(self.limit - len(self._stamps), 0)

    def resets_in_s(self) -> int:
        """Seconds until the oldest call in the window ages out — when the
        window is full, exactly how long a caller has to wait."""
        now = self._clock()
        self._prune(now)
        if not self._stamps:
            return 0
        return max(math.ceil(self._stamps[0] + self.window_s - now), 0)

    def reserve(self) -> None:
        now = self._clock()
        self._prune(now)
        if len(self._stamps) >= self.limit:
            wait = self.resets_in_s()
            raise RateLimited(
                wait,
                f"Hugging Face allows {self.limit} anonymous requests per {self.window_s:g}s "
                f"from this address and this gateway has used them — retry in {wait}s",
            )
        self._stamps.append(now)

    def snapshot(self) -> dict:
        return {"remaining": self.remaining(), "resets_in_s": self.resets_in_s()}

    def reset(self) -> None:
        self._stamps.clear()


BUDGET = Budget()
SEARCH_CACHE = TTLCache(SEARCH_TTL_S)
DETAIL_CACHE = TTLCache(DETAIL_TTL_S)


def clear() -> None:
    """Forget every cached page and detail and the request window — for
    tests, and for an operator who wants the next read to be live."""
    SEARCH_CACHE.clear()
    DETAIL_CACHE.clear()
    BUDGET.reset()


@dataclass
class HfPage:
    """One page of GGUF repos, labelled: `rows` are the Hub's own entries
    verbatim (see `to_catalog_row` for the mapping), `next_cursor` is the
    opaque token the Hub advertised for the next page (None on the last),
    `budget` is what this process may still spend on the Hub."""

    rows: list[dict]
    next_cursor: str | None
    fetched_at: str
    cached: bool
    budget: dict


@dataclass
class HfRepo:
    """One repo's detail (`?blobs=true`): `data` verbatim, `siblings` the
    file list every quant option is derived from."""

    id: str
    data: dict
    siblings: list[dict]
    fetched_at: str
    cached: bool


def _validate_search(query: str, sort: str, cursor: str | None, limit: int) -> None:
    """Every argument is checked before a URL is built — a bad one is a
    ValueError the route turns into a 400, never a request the Hub refuses
    (and charges against the quota)."""
    if not isinstance(query, str):
        raise ValueError("query must be a string")
    if len(query) > QUERY_MAX_CHARS:
        raise ValueError(f"query is longer than {QUERY_MAX_CHARS} characters")
    if sort not in SORTS:
        raise ValueError(f"sort must be one of {', '.join(SORTS)} — got {sort!r}")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= PAGE_LIMIT_MAX:
        raise ValueError(f"limit must be an integer from 1 to {PAGE_LIMIT_MAX} — got {limit!r}")
    if cursor is not None and (not isinstance(cursor, str) or not CURSOR_RE.match(cursor)):
        raise ValueError("cursor must be the opaque token a previous page returned as next_cursor")


def query_params(query: str, sort: str, cursor: str | None, limit: int) -> list[tuple[str, str]]:
    """EXACTLY the query verified live on 2026-09-06:
    GET /api/models?filter=gguf&search=<q>&sort=<sort>&direction=-1&limit=<n>
    &expand[]=gguf&expand[]=downloads&expand[]=likes&expand[]=lastModified
    &expand[]=tags&expand[]=pipeline_tag&expand[]=gated (+&cursor=<opaque>).
    Pinned by test_hf_hub — a drift here is a different (or empty) listing."""
    params = [
        ("filter", "gguf"),
        ("search", query),
        ("sort", sort),
        ("direction", "-1"),
        ("limit", str(limit)),
    ]
    params.extend(("expand[]", name) for name in EXPANDS)
    if cursor is not None:
        params.append(("cursor", cursor))
    return params


def _retry_after_s(resp: httpx.Response) -> int:
    """When the Hub says a retry could succeed: its Retry-After, else the
    `t=` (seconds to reset) of its `ratelimit: "api";r=499;t=104` header,
    else the whole window — the Hub's own words before any local guess."""
    raw = (resp.headers.get("retry-after") or "").strip()
    if raw.isdigit():
        return int(raw)
    match = re.search(r"(?:^|;)\s*t=(\d+)", resp.headers.get("ratelimit") or "")
    if match:
        return int(match.group(1))
    return BUDGET_WINDOW_S


async def _get(app, path: str, params: list[tuple[str, str]]) -> httpx.Response:
    """One budgeted GET against the Hub. The budget is reserved BEFORE the
    call; a transport failure or a 429 is stated in the Hub's words."""
    BUDGET.reserve()
    client = http_client(app, HF_TIMEOUT, base_url=HF_BASE)
    try:
        async with client as c:
            resp = await c.get(path, params=params)
    except httpx.HTTPError as exc:
        raise ProviderRefused(502, f"could not reach Hugging Face — {reason(exc)}") from exc
    if resp.status_code == 429:
        wait = _retry_after_s(resp)
        raise RateLimited(
            wait,
            f"Hugging Face rate-limited this address ({refusal_detail(resp)}) — retry in {wait}s",
        )
    return resp


def next_cursor_of(link_header: str | None) -> str | None:
    """The `cursor` query param of the Link header's rel="next" URL, e.g.
    `link: <https://huggingface.co/api/models?...&cursor=eyJ...>; rel="next"`.
    No Link, or no rel="next" in it, means the last page. A next link that
    carries no usable cursor is a shape this code does not understand — a
    loud refusal, never a silent "no more pages"."""
    if not link_header:
        return None
    for part in link_header.split(","):
        match = re.search(r"<([^>]+)>", part)
        if match is None or not re.search(r'rel="?next"?', part):
            continue
        cursors = parse_qs(urlsplit(match.group(1)).query).get("cursor") or []
        if len(cursors) == 1 and CURSOR_RE.match(cursors[0]):
            return cursors[0]
        raise ProviderRefused(
            502, "Hugging Face's next-page link carries no cursor this gateway can use"
        )
    return None


async def search(
    app, *, query: str, sort: str = "downloads", cursor: str | None = None, limit: int = 30
) -> HfPage:
    """One page of GGUF repos matching `query`, sorted by `sort` descending.
    Cached 60 s by (query, sort, cursor, limit) — a hit keeps the original
    fetched_at and is marked cached, and costs nothing against the budget."""
    _validate_search(query, sort, cursor, limit)
    key = (query, sort, cursor, limit)
    hit = SEARCH_CACHE.get(key)
    if hit is not None:
        page, _fetched_at = hit
        return replace(page, cached=True, budget=BUDGET.snapshot())
    resp = await _get(app, "/api/models", query_params(query, sort, cursor, limit))
    if resp.status_code != 200:
        raise ProviderRefused(
            resp.status_code,
            f"Hugging Face refused the search ({resp.status_code}): {refusal_detail(resp)}",
        )
    try:
        body = resp.json()
    except ValueError as exc:
        raise ProviderRefused(502, f"Hugging Face answered non-JSON to the search: {exc}") from exc
    if not isinstance(body, list):
        raise ProviderRefused(502, "Hugging Face answered the search with something not a list")
    rows = [row for row in body if isinstance(row, dict) and isinstance(row.get("id"), str)]
    fetched_at = _now()
    page = HfPage(
        rows=rows,
        next_cursor=next_cursor_of(resp.headers.get("link")),
        fetched_at=fetched_at,
        cached=False,
        budget=BUDGET.snapshot(),
    )
    SEARCH_CACHE.put(key, page, fetched_at)
    return page


def validate_repo_ref(org: str, repo: str) -> tuple[str, str]:
    """Both path segments are checked against ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$
    before any URL is built, so a ref can never become a path traversal or
    a query of its own."""
    for label, value in (("org", org), ("repo", repo)):
        if not isinstance(value, str) or not SEGMENT_RE.match(value):
            raise ValueError(
                f"{label} must be letters, digits, '.', '_' or '-' (1-96 chars, starting with a "
                f"letter or digit) — got {value!r}"
            )
    return org, repo


async def repo_detail(app, org: str, repo: str) -> HfRepo:
    """GET /api/models/{org}/{repo}?blobs=true — the row plus `siblings`
    [{rfilename, size, lfs{sha256, size}}] (verified 2026-09-06; non-LFS
    files have no `lfs`). 404 and gated (401/403) answers are refusals in
    the Hub's words. Cached 10 min."""
    validate_repo_ref(org, repo)
    key = (org, repo)
    hit = DETAIL_CACHE.get(key)
    if hit is not None:
        detail, _fetched_at = hit
        return replace(detail, cached=True)
    resp = await _get(app, f"/api/models/{org}/{repo}", [("blobs", "true")])
    if resp.status_code == 404:
        raise ProviderRefused(
            404, f"'{org}/{repo}' was not found on Hugging Face ({refusal_detail(resp)})"
        )
    if resp.status_code in (401, 403):
        raise ProviderRefused(
            resp.status_code,
            f"'{org}/{repo}' is gated or private on Hugging Face ({resp.status_code}): "
            f"{refusal_detail(resp)}",
        )
    if resp.status_code != 200:
        raise ProviderRefused(
            resp.status_code,
            f"Hugging Face refused '{org}/{repo}' ({resp.status_code}): {refusal_detail(resp)}",
        )
    try:
        body = resp.json()
    except ValueError as exc:
        raise ProviderRefused(
            502, f"Hugging Face answered non-JSON for '{org}/{repo}': {exc}"
        ) from exc
    if not isinstance(body, dict):
        raise ProviderRefused(
            502, f"Hugging Face answered '{org}/{repo}' with something not an object"
        )
    siblings = [
        s
        for s in body.get("siblings") or []
        if isinstance(s, dict) and isinstance(s.get("rfilename"), str)
    ]
    fetched_at = _now()
    detail = HfRepo(
        id=body.get("id") if isinstance(body.get("id"), str) else f"{org}/{repo}",
        data=body,
        siblings=siblings,
        fetched_at=fetched_at,
        cached=False,
    )
    DETAIL_CACHE.put(key, detail, fetched_at)
    return detail


# ── pure: siblings -> quant options ────────────────────────────────────────


def _size_of(sibling: dict) -> int | None:
    size = sibling.get("size")
    if not isinstance(size, int | float) or isinstance(size, bool):
        lfs = sibling.get("lfs")
        size = lfs.get("size") if isinstance(lfs, dict) else None
    if isinstance(size, int | float) and not isinstance(size, bool) and size >= 0:
        return int(size)
    return None


def _stem(rfilename: str) -> str:
    """The basename without `.gguf` and without a `-00001-of-00002` part
    suffix — what is left names the quant."""
    base = os.path.basename(rfilename)
    stem = base[: -len(".gguf")]
    return PART_RE.sub("", stem)


def _last_token(stem: str) -> str:
    """The last '-' or '.' separated token — the quant on the common
    `Model-Q4_K_M.gguf` / `model.Q4_K_M.gguf` layouts."""
    return re.split(r"[-.]", stem)[-1]


def _shared_prefix(stems: list[str]) -> str:
    """The prefix every stem shares, snapped back to a '-' or '.' boundary
    so `Model-Q4_K_M` and `Model-Q4_K_S` yield `Q4_K_M`/`Q4_K_S`, never
    `M`/`S`. Derived from the files present, not from a list of known
    quant names — so `UD-Q4_K_XL` and `Q4_K_XL` stay distinct when a repo
    ships both."""
    prefix = os.path.commonprefix(stems)
    cut = max(prefix.rfind("-"), prefix.rfind("."))
    return prefix[: cut + 1] if cut >= 0 else ""


def quants_of(siblings: list[dict]) -> list[dict]:
    """Every pullable quant in a repo's `siblings`: one option per
    `*.gguf` that is not an `mmproj-*` projector, multi-part files grouped
    under one option with their sizes summed. `is_default` marks Q4_K_M
    when the repo has it (ollama's own rule for `hf.co/org/repo` with no
    tag); no other quant is ever promoted to default. When a projector
    sibling exists every option carries `mmproj_bytes` — ollama fetches it
    alongside the weights, so a free-space check that ignored it would be
    short by that much (the largest projector when there are several,
    since which one ollama picks is not stated). `sha256` is stated only
    for a single-file quant; a multi-part option has one per part and no
    stated whole-file digest, so it carries `parts` instead."""
    ggufs = [s for s in siblings if s["rfilename"].lower().endswith(".gguf")]
    projectors = [s for s in ggufs if os.path.basename(s["rfilename"]).lower().startswith("mmproj")]
    weights = [s for s in ggufs if s not in projectors]
    stems = [_stem(s["rfilename"]) for s in weights]
    prefix = _shared_prefix(stems) if len(set(stems)) > 1 else ""

    groups: dict[str, dict] = {}
    for stem, sibling in zip(stems, weights, strict=True):
        tag = stem[len(prefix) :] if prefix and stem.startswith(prefix) else ""
        if not tag:
            tag = _last_token(stem) or stem
        group = groups.setdefault(
            tag,
            {
                "tag": tag,
                "filename": sibling["rfilename"],
                "size_bytes": 0,
                "sha256": None,
                "parts": 0,
                "is_default": False,
            },
        )
        group["parts"] += 1
        size = _size_of(sibling)
        if size is None or group["size_bytes"] is None:
            group["size_bytes"] = None  # one unstated part makes the whole unstated
        else:
            group["size_bytes"] += size
        lfs = sibling.get("lfs")
        digest = lfs.get("sha256") if isinstance(lfs, dict) else None
        group["sha256"] = digest if group["parts"] == 1 and isinstance(digest, str) else None

    for tag, group in groups.items():
        group["is_default"] = tag.upper() == DEFAULT_QUANT

    if projectors:
        stated = [_size_of(p) for p in projectors]
        stated = [s for s in stated if s is not None]
        mmproj_bytes = max(stated) if stated else None
        for group in groups.values():
            group["mmproj_bytes"] = mmproj_bytes

    return sorted(
        groups.values(),
        key=lambda g: (g["size_bytes"] is None, g["size_bytes"] or 0, g["tag"]),
    )


def find_quant(quants: list[dict], wanted: str) -> dict | None:
    """The option a typed `:quant` names: its tag, case-insensitively (the
    tag is case-insensitive to ollama), else its full filename (a filename
    also works as the tag), else the one option whose stem ends in the
    typed token. None when nothing matches — the caller lists what does."""
    needle = wanted.lower()
    for quant in quants:
        if quant["tag"].lower() == needle:
            return quant
    for quant in quants:
        if os.path.basename(quant["filename"]).lower() == needle:
            return quant
    suffixes = ("-" + needle, "." + needle)
    ending = [q for q in quants if _stem(q["filename"]).lower().endswith(suffixes)]
    return ending[0] if len(ending) == 1 else None


# ── pure: a Hub entry -> the one catalogue row shape ───────────────────────


def _fact(
    value, *, basis: str = "declared", source: str = SOURCE_KEY, note: str | None = None
) -> dict:
    fact = {"value": value, "basis": basis, "source": source}
    if note is not None:
        fact["note"] = note
    return fact


def _vision_note(entry: dict, tags: list[str], quants: list[dict] | None) -> str | None:
    if entry.get("pipeline_tag") == "image-text-to-text":
        return "pipeline_tag is image-text-to-text"
    for tag in tags:
        if VISION_TAG_RE.search(tag):
            return f"tag {tag!r} names vision"
    if quants and any("mmproj_bytes" in q for q in quants):
        return "mmproj-*.gguf sibling present"
    return None


def to_catalog_row(
    entry: dict, fetched_at: str, *, cached: bool = False, quants: list[dict] | None = None
) -> dict:
    """A Hub row (the search page's, or the detail's) in the plan's
    CatalogRow shape. Facts the GGUF header declares (`gguf.total`,
    `context_length`, `architecture`, `chat_template`) and the Hub's own
    counters are `declared`; everything read off a name or a template is
    `inferred` and says from what — the UI dashes those and keeps them out
    of filters by default. `gated` is the Hub's value verbatim (false |
    "auto" | "manual"). `quants` (from `quants_of`, on a detail) adds the
    `pull` block and the mmproj-sibling vision inference."""
    repo_id = entry["id"]
    model = f"hf.co/{repo_id}"
    gguf = entry.get("gguf") if isinstance(entry.get("gguf"), dict) else {}
    tags = [t for t in entry.get("tags") or [] if isinstance(t, str)]

    facts: dict[str, dict] = {}
    total = gguf.get("total")
    if isinstance(total, int | float) and not isinstance(total, bool) and total > 0:
        facts["params_b"] = _fact(round(total / 1e9, 2))
    context = gguf.get("context_length")
    if isinstance(context, int) and not isinstance(context, bool) and context > 0:
        facts["context_length"] = _fact(context)
    if isinstance(gguf.get("architecture"), str) and gguf["architecture"]:
        facts["family"] = _fact(gguf["architecture"])
    for key, field_name in (
        ("downloads", "downloads"),
        ("likes", "likes"),
        ("trending", "trendingScore"),
        ("last_modified", "lastModified"),
    ):
        if entry.get(field_name) is not None:
            facts[key] = _fact(entry[field_name])
    if "gated" in entry:
        facts["gated"] = _fact(entry["gated"])
    licence = next((t.partition(":")[2] for t in tags if t.startswith("license:")), None)
    if licence:
        facts["license"] = _fact(licence)

    capabilities: dict[str, dict] = {}
    template = gguf.get("chat_template")
    if isinstance(template, str) and template.strip():
        capabilities["chat"] = _fact(True)
        if "tools" in template or "tool_call" in template:
            capabilities["tools"] = _fact(
                True, basis="inferred", note="chat_template mentions tools"
            )
    vision = _vision_note(entry, tags, quants)
    if vision is not None:
        capabilities["vision"] = _fact(True, basis="inferred", note=vision)

    suitability: dict[str, dict] = {}
    if CODING_NAME_RE.search(repo_id):
        suitability["coding"] = _fact(
            True, basis="inferred", source="name", note=f"name matches /{CODING_NAME_PATTERN}/i"
        )

    row = base_row(f"ollama:{model}", "ollama", model, repo_id.rpartition("/")[2], "hub")
    # The Hub cannot know what THIS host has installed: `installed` stays
    # None here and the catalogue routes derive it from ollama's own tags.
    row["sources"] = [
        {"key": SOURCE_KEY, "url": SOURCE_URL, "fetched_at": fetched_at, "cached": cached}
    ]
    row["facts"] = facts
    row["capabilities"] = capabilities
    row["suitability"] = suitability
    row["actions"] = ["pull"]
    if quants is not None:
        row["pull"] = {"target": model, "quants": quants}
    return row
