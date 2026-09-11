"""Her model tools: search the catalogue, pull a model into the bundled ollama.

Both read the SAME gateway routes the Models page reads (`/admin/catalog`,
`/admin/catalog/hf`, `/admin/pull`), so what she sees and what the owner
sees never diverge. Every fact in a search result carries its basis IN
WORDS ("ollama declares", "inferred from the name", "measured on this GPU
2026-09-05", "vetted 2026-09-06") — the row shape's `{value, basis, source}`
rendered for a model that will repeat it. Absent facts are absent: a model
whose size no source stated is "size not stated", never 0.

A pull is the one tool here that changes the machine. It streams ollama's
own progress lines into the turn (ToolContext.progress → an activity frame
with `detail`) and is a success ONLY when, after ollama's literal
`success` line, the re-read catalogue lists the model as installed — that
row's digest and size are what the result line states. The stream's word
alone never makes it a success (the same rule the Models page follows).
"""

from __future__ import annotations

import json
import logging

import httpx

from app import db, peers, settings_store
from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure

logger = logging.getLogger("core")

CATALOG_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=5.0, pool=5.0)
# A pull streams for minutes; the READ timeout is per chunk — ollama reports
# progress every few hundred ms, so two silent minutes is a dead stream, not
# a slow one.
PULL_TIMEOUT = httpx.Timeout(connect=5.0, read=120.0, write=10.0, pool=5.0)

DEFAULT_RESULTS = 10
MAX_RESULTS = 25
SCOPES = ("installed", "local", "cloud", "hf", "all")
CAPABILITIES = ("tools", "vision", "audio", "thinking", "embedding")
SORTS = ("size", "context", "price", "downloads", "name")
HF_SORTS = {"downloads": "downloads", "likes": "likes", "name": "downloads"}
LOCAL_PROVIDER = "ollama"

# How a source is named when a fact is read out — words, never the key.
SOURCE_WORDS = {
    "ollama-tags": "ollama",
    "ollama-show": "ollama",
    "provider-listing": "the provider's listing",
    "hf-hub": "Hugging Face",
    "curated": "our curated list",
    "probe": "a probe on this GPU",
    "core-evals": "the quality suite",
    "ollama-registry": "the ollama registry",
    "name": "the name",
}


# ── the gateway ──────────────────────────────────────────────────────────


def _gateway(ctx: ToolContext, timeout: httpx.Timeout) -> httpx.AsyncClient:
    try:
        return peers.client(ctx.app, peers.GATEWAY, timeout)
    except peers.PeerUnconfigured as exc:
        raise ToolFailure(f"the model gateway is not configured — {exc}") from exc


def _error_of(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return f"{response.status_code} {response.reason_phrase}".strip()
    if isinstance(body, dict) and body.get("error"):
        return str(body["error"])
    return f"{response.status_code} {response.reason_phrase}".strip()


async def _get(ctx: ToolContext, path: str, params: dict | None = None) -> dict:
    """One gateway GET as JSON; every failure a stated ToolFailure that
    names the route, so "I could not search" is never mistaken for an
    empty list."""
    try:
        async with _gateway(ctx, CATALOG_TIMEOUT) as client:
            response = await client.get(path, params=params)
    except httpx.TimeoutException as exc:
        raise ToolFailure(
            f"the model gateway did not answer {path} within {CATALOG_TIMEOUT.read:g} s"
        ) from exc
    except httpx.HTTPError as exc:
        raise ToolFailure(f"could not reach the model gateway — {peers.reason(exc)}") from exc
    if response.status_code == 429:
        detail = _error_of(response)
        try:
            wait = response.json().get("retry_after_s")
        except ValueError:
            wait = None
        suffix = f" — retry in {wait} s" if isinstance(wait, int | float) else ""
        raise ToolFailure(f"rate-limited: {detail}{suffix}")
    if response.status_code != 200:
        raise ToolFailure(f"the model gateway refused {path} — {_error_of(response)}")
    try:
        body = response.json()
    except ValueError as exc:
        raise ToolFailure(f"the model gateway answered {path} with something not JSON") from exc
    if not isinstance(body, dict):
        raise ToolFailure(f"the model gateway answered {path} with something not an object")
    return body


async def _catalog(ctx: ToolContext) -> dict:
    """The catalogue with core's MEASURED layer joined in, exactly as
    GET /api/v1/models/catalog serves the page."""
    # Imported here, not at module top: models_catalog -> evals.runner ->
    # chat -> tools, and this module IS part of tools — a top-level import
    # is a circular import the moment `app.tools` is imported first.
    from app import models_catalog
    from app.evals import runner

    body = await _get(ctx, "/admin/catalog")
    try:
        pool = await db.get_pool()
        measured = await runner.measured_by_model(pool)
    except Exception as exc:  # the measured layer is core's own; its absence is stated
        logger.warning("model_catalog_search: measured layer unavailable: %s", exc)
        body.setdefault("sources", []).append(
            {"key": "core-evals", "ok": False, "rows": 0, "note": f"not read — {exc}"}
        )
        return body
    return models_catalog.decorate(body, measured, read_at=models_catalog.now_iso())


# ── reading a row out loud ───────────────────────────────────────────────


def _words(fact: dict) -> str:
    """The basis, in words a reader can weigh."""
    basis = fact.get("basis")
    source = SOURCE_WORDS.get(str(fact.get("source")), str(fact.get("source")))
    at = str(fact.get("at") or "")[:10]
    if basis == "declared":
        return f"{source} declares"
    if basis == "inferred":
        note = fact.get("note")
        return f"inferred: {note}" if note else f"inferred from {source}"
    if basis == "vetted":
        return f"vetted {at}".strip()
    if basis == "measured":
        return f"measured by {source} {at}".strip()
    return str(basis)


def _gb(size_bytes: object) -> str | None:
    if not isinstance(size_bytes, int | float):
        return None
    return f"{size_bytes / 1024**3:.1f} GB"


def _fact_line(key: str, fact: dict) -> str | None:
    value = fact.get("value")
    if key == "size_bytes":
        shown = _gb(value)
    elif key == "params_b":
        shown = f"{value}B params" if isinstance(value, int | float) else None
    elif key == "context_length":
        shown = f"{value:,} context" if isinstance(value, int) else None
    elif key == "price_prompt":
        shown = f"${value * 1e6:.2f}/1M in" if isinstance(value, int | float) else None
    elif key == "price_completion":
        shown = f"${value * 1e6:.2f}/1M out" if isinstance(value, int | float) else None
    elif key == "vram_gb":
        shown = f"{value} GB VRAM" if isinstance(value, int | float) else None
    elif key in ("quant", "family", "license"):
        shown = f"{key} {value}" if value else None
    elif key == "downloads":
        shown = f"{value:,} downloads" if isinstance(value, int) else None
    else:
        return None
    return f"{shown} ({_words(fact)})" if shown else None


FACT_ORDER = (
    "size_bytes",
    "params_b",
    "quant",
    "context_length",
    "price_prompt",
    "price_completion",
    "vram_gb",
    "family",
    "license",
    "downloads",
)


def _tag(key: str, fact: dict) -> str:
    name = key.split(":")[0]
    value = fact.get("value")
    if isinstance(value, bool):
        shown = name if value else f"no {name}"
    elif isinstance(value, int | float):
        shown = f"{name} {value * 100:.0f}%" if 0 <= value <= 1 else f"{name} {value:g}"
    elif value is None:
        shown = f"{name} unmeasured"
    else:
        shown = f"{name} {value}"
    return f"{shown} ({_words(fact)})"


def _fit_words(fit: dict | None) -> str | None:
    if not isinstance(fit, dict) or not fit.get("verdict"):
        return None
    verdict = str(fit["verdict"]).replace("_", " ")
    source = fit.get("source")
    if source == "verified":
        return f"fit: {verdict} (measured on your GPU)"
    if source == "estimated":
        return f"fit: {verdict} (estimated from the vetted VRAM figure)"
    reason = fit.get("reason")
    return f"fit: {verdict}" + (f" ({reason})" if reason else "")


def describe_row(row: dict) -> str:
    """One model as one line: id, label, state, then every fact and tag with
    its basis in words. Absent facts are simply not there."""
    state = []
    if row.get("installed") is True:
        state.append("installed")
    elif row.get("installed") is False:
        state.append("not installed")
    state.append(str(row.get("kind")))
    facts = row.get("facts") or {}
    parts = [line for key in FACT_ORDER if key in facts and (line := _fact_line(key, facts[key]))]
    caps = [_tag(k, f) for k, f in (row.get("capabilities") or {}).items() if isinstance(f, dict)]
    suits = [_tag(k, f) for k, f in (row.get("suitability") or {}).items() if isinstance(f, dict)]
    fit = _fit_words(row.get("fit"))
    label = row.get("label") or row.get("id")
    head = f"{row.get('id')} — {label} [{', '.join(state)}]"
    segments = []
    if parts:
        segments.append("; ".join(parts))
    if caps:
        segments.append("capabilities: " + ", ".join(caps))
    if suits:
        segments.append("suitability: " + ", ".join(suits))
    if fit:
        segments.append(fit)
    if row.get("note"):
        segments.append(f"note: {row['note']}")
    return head + (": " + " | ".join(segments) if segments else ": no facts stated")


# ── filtering ─────────────────────────────────────────────────────────────


def _in_scope(row: dict, scope: str) -> bool:
    kind, installed = row.get("kind"), row.get("installed")
    if scope == "installed":
        return kind == "local" and installed is True
    if scope == "local":
        return kind == "local"
    if scope == "cloud":
        return kind == "cloud"
    if scope == "hf":
        return kind == "hub"
    return True


def _number(row: dict, key: str) -> float | None:
    fact = (row.get("facts") or {}).get(key)
    value = fact.get("value") if isinstance(fact, dict) else None
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _matches_text(row: dict, query: str) -> bool:
    if not query:
        return True
    hay = " ".join(str(row.get(k) or "") for k in ("id", "label", "model", "provider")).lower()
    family = (row.get("facts") or {}).get("family", {})
    if isinstance(family, dict):
        hay += " " + str(family.get("value") or "").lower()
    return all(word in hay for word in query.lower().split())


def apply_filters(rows: list[dict], args: dict) -> tuple[list[dict], dict[str, int]]:
    """Rows matching every filter, plus a count of rows a NUMERIC filter
    excluded because the fact was not stated — said, never silently
    dropped (the same rule the page's facets follow)."""
    hidden = {"size": 0, "context": 0, "price": 0}
    requires = [c for c in (args.get("requires") or []) if c in CAPABILITIES]
    query = str(args.get("query") or "").strip()
    scope = args.get("scope") or "all"
    kept: list[dict] = []
    for row in rows:
        if not _in_scope(row, scope):
            continue
        if scope != "hf" and not _matches_text(row, query):
            continue
        caps = row.get("capabilities") or {}
        if any(
            not (isinstance(caps.get(c), dict) and caps[c].get("value") is True) for c in requires
        ):
            continue
        max_gb = args.get("max_size_gb")
        if isinstance(max_gb, int | float):
            size = _number(row, "size_bytes")
            if size is None:
                hidden["size"] += 1
                continue
            if size > max_gb * 1024**3:
                continue
        min_context = args.get("min_context")
        if isinstance(min_context, int | float):
            context = _number(row, "context_length")
            if context is None:
                hidden["context"] += 1
                continue
            if context < min_context:
                continue
        max_price = args.get("max_price_per_m")
        if isinstance(max_price, int | float):
            price = _number(row, "price_prompt")
            if price is None:
                hidden["price"] += 1
                continue
            if price * 1e6 > max_price:
                continue
        kept.append(row)
    return kept, hidden


def _sort_key(sort: str):
    absent = float("inf")

    def key(row: dict):
        if sort == "size":
            v = _number(row, "size_bytes")
        elif sort == "context":
            v = _number(row, "context_length")
            v = -v if v is not None else None
        elif sort == "price":
            v = _number(row, "price_prompt")
        elif sort == "downloads":
            v = _number(row, "downloads")
            v = -v if v is not None else None
        else:
            return (0, str(row.get("label") or row.get("id")).lower())
        return (1 if v is None else 0, absent if v is None else v)

    return key


def sort_rows(rows: list[dict], sort: str | None) -> list[dict]:
    if sort in SORTS:
        return sorted(rows, key=_sort_key(sort))
    # Default: installed first, then local, cloud, hub; name within.
    order = {"local": 0, "cloud": 1, "hub": 2}
    return sorted(
        rows,
        key=lambda r: (
            0 if r.get("installed") is True else 1,
            order.get(str(r.get("kind")), 3),
            str(r.get("label") or r.get("id")).lower(),
        ),
    )


# ── model_catalog_search ─────────────────────────────────────────────────


async def model_catalog_search(args: dict, ctx: ToolContext) -> str:
    scope = args.get("scope") or "all"
    if scope not in SCOPES:
        raise ToolFailure(f"scope must be one of {', '.join(SCOPES)}")
    query = str(args.get("query") or "").strip()
    limit = int(args.get("limit") or DEFAULT_RESULTS)
    limit = max(1, min(limit, MAX_RESULTS))
    sort = args.get("sort")
    if sort is not None and sort not in SORTS:
        raise ToolFailure(f"sort must be one of {', '.join(SORTS)}")

    rows: list[dict] = []
    notes: list[str] = []
    if scope != "hf":
        body = await _catalog(ctx)
        rows.extend(r for r in body.get("rows") or [] if isinstance(r, dict))
        for source in body.get("sources") or []:
            if isinstance(source, dict) and source.get("ok") is False:
                notes.append(f"{source.get('key')} could not be read — {source.get('note')}")
    if scope in ("hf", "all") and query:
        page = await _get(
            ctx,
            "/admin/catalog/hf",
            {"q": query, "sort": HF_SORTS.get(str(sort), "downloads"), "limit": str(limit)},
        )
        seen = {r.get("id") for r in rows}
        rows.extend(
            r for r in page.get("rows") or [] if isinstance(r, dict) and r.get("id") not in seen
        )
    elif scope == "hf":
        raise ToolFailure("a Hugging Face search needs a query — scope 'hf' searches by words")

    kept, hidden = apply_filters(rows, args)
    kept = sort_rows(kept, sort)
    shown = kept[:limit]
    lines = [f"{i}. {describe_row(row)}" for i, row in enumerate(shown, 1)]
    head = (
        f"{len(kept)} model(s) match"
        + (f" — showing {len(shown)}" if len(kept) > len(shown) else "")
        + (f' for "{query}"' if query else "")
        + f" (scope {scope})."
    )
    hidden_lines = [
        f"{n} model(s) state no {what} and were left out by the {what} filter"
        for what, n in hidden.items()
        if n
    ]
    if not shown:
        head = (
            f"No model matched{' ' + repr(query) if query else ''} in scope {scope}."
            if not hidden_lines
            else f"No model matched in scope {scope}."
        )
    out = [head, *hidden_lines, *lines]
    if notes:
        out.append("Sources that could not be read: " + "; ".join(notes))
    if shown:
        out.append(
            "Every fact names its basis: 'declares' is the source's own statement, "
            "'inferred' is a guess from a name or template, 'vetted' is hand-checked "
            "on that date, 'measured' was run on this machine."
        )
    return "\n".join(out)


# ── model_pull ────────────────────────────────────────────────────────────


def _target_of(model: str) -> str:
    """The bare ref ollama pulls. A cloud-qualified id is refused: only
    the bundled ollama can pull, and a cloud model needs no pull."""
    model = model.strip()
    if not model:
        raise ToolFailure("model_pull needs a model reference, e.g. qwen3:4b or hf.co/org/repo")
    provider, sep, rest = model.partition(":")
    if sep and provider == LOCAL_PROVIDER and rest:
        return rest
    if sep and rest and provider.isalnum() and "/" not in provider and "." not in provider:
        # `openrouter:openai/gpt-x` — a registered cloud provider's model.
        # A bare `qwen3:4b` also has this shape; ollama tags never carry a
        # slash BEFORE the colon while cloud ids usually do, so only refuse
        # when the remainder looks like a provider path.
        if "/" in rest and not rest.startswith("hf.co/") and not rest.startswith("huggingface.co/"):
            raise ToolFailure(
                f"{model!r} is a cloud provider's model — only the bundled ollama can pull, "
                "and a cloud model is used directly, never pulled"
            )
    return model


def _preflight_words(line: dict, target: str) -> str:
    if line.get("note"):
        return str(line["note"])
    size = line.get("required_gb")
    free = line.get("free_gb")
    source = line.get("size_source")
    return f"{size} GB needed, {free} GB free" + (f" (size from {source})" if source else "")


def _installed_row(catalog: dict, target: str) -> dict | None:
    wanted = {target, f"{target}:latest"}
    for row in catalog.get("rows") or []:
        if (
            isinstance(row, dict)
            and row.get("kind") == "local"
            and row.get("installed") is True
            and row.get("provider") == LOCAL_PROVIDER
            and row.get("model") in wanted
        ):
            return row
    return None


def _progress_pct(line: dict) -> int | None:
    """The whole-percent fraction this pull line reports, or None when it
    carries no byte count to compute one from.

    ONE computation, used by both the words and the number on the frame (S15),
    so a bar can never sit at a different percentage than the sentence beside
    it — two formulas here truncated and rounded differently.
    """
    total, done = line.get("total"), line.get("completed")
    if isinstance(total, int) and total > 0 and isinstance(done, int):
        return min(100, max(0, int(done * 100 / total)))
    return None


def _progress_words(target: str, line: dict) -> str:
    pct = _progress_pct(line)
    if pct is None:
        return f"{str(line.get('status') or 'pulling')} — {target}"
    return f"pulling {target} — {pct}% ({_gb(line['completed'])} of {_gb(line['total'])})"


async def _send(ctx: ToolContext, method: str, path: str, **kwargs) -> tuple[int, dict]:
    """One gateway call whose body is JSON either way (a refusal carries
    `error`); transport failures are stated ToolFailures."""
    try:
        async with _gateway(ctx, CATALOG_TIMEOUT) as client:
            response = await client.request(method, path, **kwargs)
    except httpx.TimeoutException as exc:
        raise ToolFailure(
            f"the model gateway did not answer {path} within {CATALOG_TIMEOUT.read:g} s"
        ) from exc
    except httpx.HTTPError as exc:
        raise ToolFailure(f"could not reach the model gateway — {peers.reason(exc)}") from exc
    try:
        body = response.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    return response.status_code, body


async def model_check_update(args: dict, ctx: ToolContext) -> str:
    """Has the source moved since this model was pulled? The gateway
    compares the installed weights digest with the source's current one
    and never pulls; this reads the answer out in words."""
    target = _target_of(str(args.get("model") or ""))
    status, body = await _send(ctx, "POST", "/admin/catalog/drift", json={"model": target})
    if status == 404:
        raise ToolFailure(f"{target} is not installed — nothing to compare")
    if status != 200:
        raise ToolFailure(f"the update check was refused — {body.get('error') or status}")
    name = body.get("model") or target
    installed = str(body.get("installed_digest") or "")[:19]
    upstream = str(body.get("upstream_digest") or "")[:19]
    source = SOURCE_WORDS.get(str(body.get("source")), str(body.get("source")))
    if body.get("moved") is True:
        return (
            f"{name} has moved upstream: this install runs {installed}…, {source} now ships "
            f"{upstream}…. Nothing was downloaded — call model_pull with the same name to "
            "update it."
        )
    if body.get("moved") is False:
        return (
            f"{name} is up to date: the installed weights ({installed}…) are what {source} "
            f"ships now (checked {str(body.get('checked_at') or '')[:19]})."
        )
    note = body.get("note") or "no reason given"
    wait = body.get("retry_after_s")
    return (
        f"Could not tell whether {name} has moved — {note}"
        + (f" (retry in {wait} s)" if isinstance(wait, int | float) else "")
        + ". Nothing was downloaded."
    )


async def model_remove(args: dict, ctx: ToolContext) -> str:
    """Remove an installed model from the bundled ollama. The gateway
    verifies against /api/tags before it says removed; the current chat
    model is refused (a cannot: the next turn would have nothing to run)."""
    target = _target_of(str(args.get("model") or ""))
    pool = await db.get_pool()
    current = await settings_store.read_value(pool, "chat.model")
    bare = str(current or "").removeprefix(f"{LOCAL_PROVIDER}:")
    if bare and bare in (target, f"{target}:latest") or target in (bare, f"{bare}:latest"):
        raise ToolFailure(
            f"{target} is the current chat model (chat.model = {current!r}) — switch to "
            "another model first, then remove it"
        )
    status, body = await _send(ctx, "DELETE", "/admin/models", params={"model": target})
    if status == 404:
        raise ToolFailure(f"{target} is not installed — nothing to remove")
    if status != 200:
        raise ToolFailure(f"the removal failed — {body.get('error') or status}")
    if body.get("verified") is not True:
        raise ToolFailure(f"the gateway did not verify the removal of {target}: {body}")
    return (
        f"Removed {body.get('removed') or target} — verified against ollama's own list; "
        f"{body.get('installed_now')} model(s) remain installed."
    )


async def model_pull(args: dict, ctx: ToolContext) -> str:
    target = _target_of(str(args.get("model") or ""))
    progress = ctx.progress
    saw_success = False
    preflight: str | None = None
    # Per LAYER, not per pull: ollama downloads a model as several blobs and
    # reports each one's own 0→100. Keeping one high-water mark for the whole
    # turn meant the first layer to finish silenced every layer after it, so a
    # multi-blob pull showed a bar that reached some number and then stopped
    # moving while the download carried on. Found by walking a real pull.
    last_pct: dict[str, int] = {}
    last_words: str | None = None

    def report(words: str, pct: int | None = None) -> None:
        # Consecutive identical reports (a layer with no byte count yet
        # repeats its status line) are one frame, not twenty.
        #
        # A line that KNOWS its fraction reports the number beside the words
        # (S15), because the chat draws a determinate bar and prose cannot be
        # parsed for one. A line that does not — the preflight, a manifest with
        # no byte count — stays a bare string and renders as words alone, so
        # the bar never invents a position it was not told.
        nonlocal last_words
        if progress is None or words == last_words:
            return
        last_words = words
        progress(words if pct is None else {"detail": words, "percent": pct})

    try:
        async with _gateway(ctx, PULL_TIMEOUT) as client:
            async with client.stream("POST", "/admin/pull", json={"model": target}) as upstream:
                if upstream.status_code != 200:
                    await upstream.aread()
                    raise ToolFailure(f"the pull was refused — {_error_of(upstream)}")
                async for raw in upstream.aiter_lines():
                    if not raw.strip():
                        continue
                    try:
                        line = json.loads(raw)
                    except ValueError:
                        continue
                    if not isinstance(line, dict):
                        continue
                    if line.get("error"):
                        raise ToolFailure(f"the pull failed — {line['error']}")
                    if line.get("status") == "preflight":
                        preflight = _preflight_words(line, target)
                        if line.get("ok") is False:
                            raise ToolFailure(
                                f"the pull cannot fit: {target} needs about "
                                f"{line.get('required_gb')} GB and only {line.get('free_gb')} GB "
                                "is free on the models volume"
                            )
                        report(f"pulling {target} — {preflight}")
                        continue
                    if line.get("status") == "success":
                        saw_success = True
                        continue
                    if progress is not None:
                        words = _progress_words(target, line)
                        pct = _progress_pct(line)
                        # One frame per whole percentage point REACHED, per layer,
                        # which caps a layer at 100 frames and still moves a bar
                        # smoothly. A line with no fraction yet (a manifest)
                        # reports its words and is deduped by them instead.
                        layer = str(line.get("status") or "pulling")
                        if pct is None:
                            report(words)
                        elif pct > last_pct.get(layer, -1):
                            last_pct[layer] = pct
                            report(words, pct)
    except httpx.TimeoutException as exc:
        raise ToolFailure(
            f"the pull stream went quiet for {PULL_TIMEOUT.read:g} s — {target} is not "
            "confirmed installed"
        ) from exc
    except httpx.HTTPError as exc:
        raise ToolFailure(f"the pull stream failed — {peers.reason(exc)}") from exc

    if not saw_success:
        raise ToolFailure(
            f"the download stream ended without ollama reporting success — {target} is not "
            "confirmed installed"
        )

    # ollama said success. The catalogue is the fact.
    report(f"ollama reported success — checking the catalogue for {target}")
    catalog = await _catalog(ctx)
    row = _installed_row(catalog, target)
    if row is None:
        raise ToolFailure(
            f"ollama reported success but the catalogue does not list {target} as installed"
        )
    facts = row.get("facts") or {}
    bits = [
        line
        for key in ("size_bytes", "quant", "params_b")
        if key in facts and (line := _fact_line(key, facts[key]))
    ]
    digest = facts.get("digest", {}).get("value") if isinstance(facts.get("digest"), dict) else None
    result = f"Pulled {row['id']} — the catalogue now lists it as installed"
    if bits:
        result += ": " + "; ".join(bits)
    if digest:
        result += f"; digest {str(digest)[:19]}…"
    if preflight:
        result += f". Preflight: {preflight}"
    result += "."

    if args.get("set_as_chat_model"):
        pool = await db.get_pool()
        value = row["id"]
        await settings_store.write_setting(
            settings_store.SettingWrite(key="chat.model", value=value)
        )
        read_back = await settings_store.read_value(pool, "chat.model")
        if read_back != value:
            raise ToolFailure(
                f"{result} But chat.model did not read back as {value} (it reads {read_back!r}) — "
                "the model is installed and NOT set as the chat model"
            )
        result += f" chat.model is now {value} (read back)."
    return result


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="model_catalog_search",
        description=(
            "List and filter the models Nova can run or reach: what is installed on "
            "the local ollama, the curated picks that can be pulled, every registered "
            "cloud provider's models, and (with a query) Hugging Face GGUF repos. "
            "Every fact comes with its basis in words — declared by the source, "
            "inferred, vetted on a date, or measured on this machine. Use it for "
            "'what models do we have', 'which ones can use tools', 'find a small "
            "coding model under 3 GB', before any pull."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Words to match in the id, label or family; required for scope 'hf'."
                    ),
                },
                "scope": {
                    "type": "string",
                    "enum": list(SCOPES),
                    "description": (
                        "installed | local (installed + pullable picks) | cloud | hf (Hugging "
                        "Face search) | all (default)."
                    ),
                },
                "requires": {
                    "type": "array",
                    "items": {"type": "string", "enum": list(CAPABILITIES)},
                    "description": "Capabilities every result must state as true.",
                },
                "max_size_gb": {
                    "type": "number",
                    "minimum": 0,
                    "description": (
                        "Only models whose stated size is at most this many GB. Models with "
                        "no stated size are left out and counted — Hugging Face search rows "
                        "state no size until a quant is picked, so filter those by params "
                        "instead."
                    ),
                },
                "min_context": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Only models whose stated context length is at least this.",
                },
                "max_price_per_m": {
                    "type": "number",
                    "minimum": 0,
                    "description": (
                        "Cloud only: prompt price at most this many dollars per million tokens."
                    ),
                },
                "sort": {
                    "type": "string",
                    "enum": list(SORTS),
                    "description": (
                        "size (small first), context (large first), price (cheap first), "
                        "downloads, name."
                    ),
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_RESULTS,
                    "description": f"How many to list (default {DEFAULT_RESULTS}).",
                },
            },
            "additionalProperties": False,
        },
        executor=model_catalog_search,
        reads_only=True,
        ephemeral=True,
        result_kind=RESULT_KIND_LISTING,
    ),
    Tool(
        name="model_pull",
        description=(
            "Download a model into the local ollama so it can be used: a library tag "
            "like qwen3:4b, a namespaced user/model:tag, or a Hugging Face GGUF repo "
            "as hf.co/org/repo[:QUANT]. Downloads gigabytes and reports progress as it "
            "runs. The result line states what the catalogue lists as installed "
            "(size, quant, digest) — say what was pulled only from that line. Cloud "
            "models are never pulled; use them directly."
        ),
        parameters={
            "type": "object",
            "properties": {
                "model": {
                    "type": "string",
                    "description": (
                        "The reference to pull: qwen3:4b or hf.co/unsloth/Qwen3-4B-GGUF:Q4_K_M."
                    ),
                },
                "set_as_chat_model": {
                    "type": "boolean",
                    "description": (
                        "After a confirmed install, make it the chat model (chat.model = "
                        "ollama:<model>), read back."
                    ),
                },
            },
            "required": ["model"],
            "additionalProperties": False,
        },
        executor=model_pull,
    ),
    Tool(
        name="model_check_update",
        description=(
            "Check whether an installed local model has a newer version at its source "
            "(the ollama registry or Hugging Face) by comparing the installed weights "
            "digest with what the source ships now. Never downloads anything; to update, "
            "call model_pull with the same name afterwards."
        ),
        parameters={
            "type": "object",
            "properties": {
                "model": {
                    "type": "string",
                    "description": "An installed model, e.g. qwen3:8b or hf.co/org/repo:Q4_K_M.",
                },
            },
            "required": ["model"],
            "additionalProperties": False,
        },
        executor=model_check_update,
        reads_only=True,
        ephemeral=True,
    ),
    Tool(
        name="model_remove",
        description=(
            "Remove an installed model from the local ollama, freeing its disk space. "
            "Verified against ollama's own list before it is reported removed. The "
            "current chat model cannot be removed — switch first. Cloud models are never "
            "removed (there is nothing on disk)."
        ),
        parameters={
            "type": "object",
            "properties": {
                "model": {"type": "string", "description": "The installed model to remove."},
            },
            "required": ["model"],
            "additionalProperties": False,
        },
        executor=model_remove,
    ),
)
