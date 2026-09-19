"""The stack's own health — THE ONLY FAMILY THAT MAY DECLARE `urgent`.

Jeremy set the urgent list and it has one entry: the stack being down. A
service unreachable, the database refusing, the chat model gone. Money over a
cap waits for the digest; a scheduled task that paused itself waits for the
digest; her having changed something waits for the digest. Because that list
is one family and every fact in it is verified from a SOCKET or a ROW rather
than a sentence, an urgent notice may arrive at any hour — the volume is
bounded by the list, not by a clock. tests/test_checks.py asserts that the set
of urgent checks in the registry is exactly this module's, so adding a second
urgent family is a deliberate act with a red test attached.

Each subject is its own check, and that is the point: a peer whose link is
unconfigured, a gateway that will not answer, an engine that could not be
asked are all "could not check THIS", and a shared CheckRun would have to
choose between reporting a false all-clear for the others or a false
could-not-run for the ones that answered. Separate checks let each subject
tell the truth about itself.
"""

from __future__ import annotations

import asyncio

import httpx

from app import machines, peers, settings_store
from app.checks import CannotCheck, Check, Finding, run_cache

# A health probe is one request and no work: a peer that cannot answer it in
# five seconds is down as far as a turn is concerned.
HEALTH_TIMEOUT = httpx.Timeout(connect=5.0, read=5.0, write=5.0, pool=5.0)
# The catalogue assembles every engine's /api/tags and every provider's
# listing, so it is allowed longer — the gateway bounds its own fan-out.
CATALOG_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=5.0, pool=5.0)
# The database is local and the query is `SELECT 1`; two seconds of silence is
# a database that is not answering, not a slow one.
DB_DEADLINE_S = 2.0

# The path both peers serve their liveness on (services/gateway/app/main.py
# and services/memory/app/main.py). A 200 here is the whole claim: the process
# is up and answering HTTP.
HEALTH_PATH = "/health/live"

# Whether an ENGINE answers is the gateway's own reading of it (GET
# /admin/engines through app/machines.py). Core has no route to any engine —
# the gateway is the only thing that talks to one — and which providers ARE
# engines is whatever that list says, never a name written here (S40: the
# bundled one is `hub`; S44 adds one per machine).

# Where the catalogue and the engine list are shared for the length of ONE
# beat (checks.run_cache).
CATALOGUE_KEY = "stack.catalogue"
ENGINES_KEY = "stack.engines"


async def _probe(app, label: str, link: peers.Link) -> list[Finding]:
    """One peer's /health/live, as a socket fact.

    An unconfigured link raises CannotCheck: there is no address to probe, so
    nothing was learned about the peer, and saying "down" would be as untrue
    as saying "up".
    """
    try:
        url, _token = peers.peer_config(link)
    except peers.PeerUnconfigured as exc:
        raise CannotCheck(f"the {label} link is not configured — {exc}") from exc
    try:
        async with peers.client(app, link, HEALTH_TIMEOUT) as client:
            resp = await client.get(HEALTH_PATH)
    except httpx.HTTPError as exc:
        return [_down(label, url, peers.reason(exc))]
    if resp.status_code != 200:
        return [_down(label, url, f"answered HTTP {resp.status_code} on {HEALTH_PATH}")]
    return []


def _down(label: str, url: str, why: str) -> Finding:
    """One unreachable thing, naming the peer and the reason.

    `url` is in the facts because it is what was actually probed — the fact
    that makes the finding checkable — and it changes only when the deployment
    does. The reason is in the facts too: it is derived from the exception,
    not composed prose, and a peer that starts failing differently (refusing
    instead of timing out) IS new news worth saying again.
    """
    return Finding(
        key=f"peer_down:{label}",
        title=f"{label} did not answer {HEALTH_PATH} — {why}",
        facts={"peer": label, "url": url, "probe": HEALTH_PATH, "reason": why},
    )


async def gateway(app, pool) -> list[Finding]:
    return await _probe(app, "gateway", peers.GATEWAY)


async def memory(app, pool) -> list[Finding]:
    return await _probe(app, "memory", peers.MEMORY)


async def database(app, pool) -> list[Finding]:
    """`SELECT 1`, with a deadline.

    Worth checking even though the beat needed the database to get here: the
    pool can be exhausted or the server can start refusing between the beat's
    own write and this probe, and a stated finding is how the owner learns
    that rather than from a chat turn dying later.
    """
    try:
        answer = await asyncio.wait_for(pool.fetchval("SELECT 1"), DB_DEADLINE_S)
    except TimeoutError:
        return [
            Finding(
                key="database_down",
                title=f"the database did not answer SELECT 1 within {DB_DEADLINE_S:g}s",
                facts={"probe": "SELECT 1", "reason": f"no answer within {DB_DEADLINE_S:g}s"},
            )
        ]
    except Exception as exc:  # noqa: BLE001 — a refusing database is the finding, not a crash
        why = f"{type(exc).__name__}: {exc}".strip()
        return [
            Finding(
                key="database_down",
                title=f"the database refused SELECT 1 — {why}",
                facts={"probe": "SELECT 1", "reason": why},
            )
        ]
    if answer != 1:
        # Cannot happen against postgres; if it ever does, the row is what is
        # wrong and reporting "fine" would be reporting success unchecked.
        return [
            Finding(
                key="database_down",
                title=f"the database answered SELECT 1 with {answer!r}",
                facts={"probe": "SELECT 1", "reason": f"answered {answer!r}, not 1"},
            )
        ]
    return []


async def _shared(app, key: str, fetch):
    """One fetch per beat per key, shared by every check that reads it.

    What is cached is the in-flight TASK, not its result: callers start within
    microseconds of each other, so caching the result alone would have them
    both miss and both fetch. A caller that hits its own deadline is shielded
    out of the await rather than cancelling the fetch another is waiting on.
    """
    cache = run_cache()
    task = cache.get(key)
    if not isinstance(task, asyncio.Task):
        task = asyncio.ensure_future(fetch(app))
        task.add_done_callback(_settled)
        cache[key] = task
    return await asyncio.shield(task)


async def _catalogue(app) -> dict:
    """The gateway's /admin/catalog, assembled ONCE per beat.

    stack_chat_model reads this body and run_all runs the stack checks
    concurrently. It is the most expensive read the family makes: the gateway
    answers it by fanning out to every engine's /api/tags and to every
    configured provider's listing.

    The checks that share a beat's readings stay separate CHECKS and share
    only the FETCH, rather than folding into one check with two findings. A
    shared CheckRun would have to pick a single verdict for two different
    subjects, and the interesting case is exactly when those differ: when an
    engine does not answer, "the engine is down" is an urgent FINDING and "is
    the chat model installed" is a check that COULD NOT RUN. One CheckRun can
    say only one of those, so folding would buy the same saving at the price
    of a false all-clear for one subject or a false could-not-run for the
    other — which is the defect this slice exists to prevent. The module
    docstring above is the same argument.
    """
    return await _shared(app, CATALOGUE_KEY, _fetch_catalogue)


async def _engines(app) -> list[dict]:
    """The gateway's engine list, read ONCE per beat: stack_ollama always,
    stack_chat_model only when it has a missing model to explain."""
    return await _shared(app, ENGINES_KEY, _fetch_engines)


async def _fetch_engines(app) -> list[dict]:
    """The list as the gateway last observed it (`live=False`: a beat never
    wakes a machine to ask). Unreadable is CannotCheck — an empty list read as
    "every engine answered" is the false all-clear this family refuses."""
    try:
        return await machines.plant().engines(app, live=False)
    except machines.PlantUnavailable as exc:
        raise CannotCheck(
            f"the gateway could not be asked which machines run models — {exc}"
        ) from exc


def _settled(task: asyncio.Task) -> None:
    """Read a shared fetch's outcome so a failure nobody awaited does not
    surface as an "exception was never retrieved" warning. Nothing is hidden:
    every caller that awaits the task still gets the exception, and a caller
    that was cancelled before it could already records its own deadline as the
    reason it did not run."""
    if not task.cancelled():
        task.exception()


async def _fetch_catalogue(app) -> dict:
    """The actual GET. Every failure shape raises CannotCheck: an unreachable
    gateway means nothing was learned about the installed models, and an
    empty catalogue read as "nothing installed" is exactly the silent
    fallback this slice forbids."""
    try:
        async with peers.client(app, peers.GATEWAY, CATALOG_TIMEOUT) as client:
            resp = await client.get("/admin/catalog")
    except peers.PeerUnconfigured as exc:
        raise CannotCheck(f"the gateway link is not configured — {exc}") from exc
    except httpx.HTTPError as exc:
        raise CannotCheck(f"the gateway could not be reached — {peers.reason(exc)}") from exc
    if resp.status_code != 200:
        raise CannotCheck(f"the gateway answered HTTP {resp.status_code} for its model catalogue")
    try:
        body = resp.json()
    except ValueError as exc:
        raise CannotCheck("the gateway's model catalogue was not JSON") from exc
    if not isinstance(body, dict):
        raise CannotCheck("the gateway's model catalogue was not an object")
    return body


def _embedder_down(view: dict) -> bool:
    """The bundled engine, switched off, that the gateway ASKED and that did
    not answer. The switch stops chat routing only: the bundled engine is
    still the embedder (D8 — memory embeds straight against it), so it going
    down while switched off is recall failing, not the owner's choice. Read
    from the view's own `builtin` and `answered`, never a name kept here."""
    return (
        view.get("state") == "switched_off"
        and view.get("builtin") is True
        and view.get("answered") is False
    )


async def ollama(app, pool) -> list[Finding]:
    """Does every machine that runs models answer the gateway?

    Read from the gateway's own engine list (S40) — one finding per engine
    that did not answer, keyed by its name. Two states are deliberately NOT
    findings. `switched_off` is the owner's switch: a machine he told to stop
    running models is not down, and an urgent push at 3am saying so would be
    the lie — EXCEPT the bundled engine when the gateway asked it and it did
    not answer, because it still embeds for memory while switched off
    (`_embedder_down`); that finding carries serving=false so its title says
    both. `unobserved` is a machine that sleeps on its own and was not
    contacted: nothing was learned about it, and it is never woken just to be
    checked.
    """
    findings: list[Finding] = []
    for view in await _engines(app):
        down = view.get("state") == "unreachable"
        switched_off = _embedder_down(view)
        if not (down or switched_off):
            continue
        name = view["name"]
        why = str(view.get("reason") or "").strip() or "the gateway stated no reason"
        facts = {"peer": name, "reason": why, "basis": "the gateway's own engine reading"}
        title = f"{name} did not answer the gateway — {why}"
        if switched_off:
            facts["serving"] = False
            title = f"{name} is switched off and not answering the gateway — {why}"
        findings.append(Finding(key=f"peer_down:{name}", title=title, facts=facts))
    return findings


def _row_for(body: dict, wanted: str) -> dict | None:
    """The catalogue row for the configured chat model, or None.

    Matched three ways because chat.model is written three ways: a qualified
    id (`hub:qwen3:8b`, `openrouter:openai/gpt-x`) is the row's own `id`; a
    bare tag (`qwen3:8b`) is a LOCAL row's `model` — local in the catalogue's
    own word (`kind`), on whichever engine lists it; and a tag with no
    version (`qwen3`) is the same row's `model` with `:latest` appended, the
    way ollama itself resolves it.
    """
    bare = {wanted, f"{wanted}:latest"}
    for row in body.get("rows") or []:
        if not isinstance(row, dict):
            continue
        if row.get("id") == wanted:
            return row
        if row.get("kind") == "local" and row.get("model") in bare:
            return row
    return None


async def _silent_listings(app, body: dict, wanted: str) -> list[tuple[str, str]]:
    """The listings that could have named `wanted` and did not answer, as
    (name, reason). Which ones: the provider an id names before its first
    colon when the catalogue has a source for it (`hub:…` -> hub,
    `openrouter:…` -> openrouter); otherwise — a bare tag, which resolves on
    an engine — every engine the gateway lists. An engine is silent when its
    catalogue source failed OR the gateway's own reading says it did not
    answer (a switched-off engine still lists what it has)."""
    sources = {s.get("key"): s for s in body.get("sources") or [] if isinstance(s, dict)}
    head, sep, _rest = wanted.partition(":")
    views: dict[str, dict] = {}
    if sep and head in sources:
        asked = [head]
    else:
        views = {view["name"]: view for view in await _engines(app)}
        asked = [head] if sep and head in views else sorted(views)
    silent: list[tuple[str, str]] = []
    for name in asked:
        source, view = sources.get(name), views.get(name)
        if source is not None and source.get("ok") is not True:
            silent.append((name, str(source.get("note") or "no reason stated").strip()))
        elif view is not None and view.get("state") not in ("ready", "switched_off"):
            silent.append((name, str(view.get("reason") or view.get("state")).strip()))
    return silent


async def chat_model(app, pool) -> list[Finding]:
    """Is the model core asks for on every turn actually there?

    An unset chat.model is a real finding, not a shrug: the scheduler refuses
    every scheduled turn without one ("no chat model is set (Settings →
    Models), so the instruction cannot run"), which is the stack being down
    for everything she was asked to do on a timer.

    A model the catalogue does not list is a finding UNLESS a listing that
    could have named it did not answer — then the catalogue is missing those
    rows and "not installed" would be an accusation derived from a missing
    source. That is stated as a check that could not run instead.
    """
    wanted = str(await settings_store.read_value(pool, "chat.model") or "").strip()
    if not wanted:
        # Verified from the settings row alone — the gateway is not asked,
        # because there is no model to ask it about and a gateway that happened
        # to be down would otherwise hide a fact that is true either way.
        return [
            Finding(
                key="chat_model_unset",
                title=(
                    "no chat model is set (Settings → Models) — every scheduled turn refuses "
                    "until one is"
                ),
                facts={"setting": "chat.model", "value": "", "reason": "unset"},
            )
        ]
    body = await _catalogue(app)
    row = _row_for(body, wanted)
    if row is None:
        silent = await _silent_listings(app, body, wanted)
        if silent:
            who = "; ".join(f"{name} ({why})" for name, why in silent)
            raise CannotCheck(
                f"{who} did not answer the gateway, so the catalogue lists no installed model "
                f"to compare {wanted!r} against"
            )
        return [
            Finding(
                key=f"chat_model_missing:{wanted}",
                title=f"the chat model {wanted} is not in the gateway's catalogue",
                facts={
                    "setting": "chat.model",
                    "model": wanted,
                    "reason": "the gateway's catalogue lists no such model",
                },
            )
        ]
    # `installed` is stated only for local rows: a cloud row's presence in its
    # provider's own listing IS its availability, and there is nothing to
    # install. So only an explicit False is a finding — never a missing key
    # read as "no".
    if row.get("installed") is False:
        return [
            Finding(
                key=f"chat_model_missing:{wanted}",
                title=f"the chat model {wanted} is listed but not installed",
                facts={
                    "setting": "chat.model",
                    "model": wanted,
                    "row_id": row.get("id"),
                    "reason": "the gateway's catalogue lists it as not installed",
                },
            )
        ]
    return []


CHECKS: tuple[Check, ...] = (
    Check(
        name="stack_gateway",
        describe="The model gateway answers its health path.",
        urgent=True,
        run=gateway,
    ),
    Check(
        name="stack_memory",
        describe="The memory service answers its health path.",
        urgent=True,
        run=memory,
    ),
    Check(
        name="stack_ollama",
        describe=(
            "Every machine that runs models answers the gateway — one switched off is left "
            "alone, except the bundled one, which still embeds for memory."
        ),
        urgent=True,
        run=ollama,
    ),
    Check(
        name="stack_database",
        describe="The database answers a query.",
        urgent=True,
        run=database,
    ),
    Check(
        name="stack_chat_model",
        describe="The configured chat model is present in the gateway's catalogue.",
        urgent=True,
        run=chat_model,
    ),
)

# The names this module registers, exported so the urgent-set pin in
# tests/test_checks.py is derived from the family itself rather than retyped
# beside it.
NAMES: tuple[str, ...] = tuple(check.name for check in CHECKS)
