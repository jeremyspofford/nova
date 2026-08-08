"""Approve brings Home Assistant up. Roadmap #35.

The narrow half of a decision Jeremy made on 2026-08-05. He asked why Nova
could not just go and set things up, and the honest answer was that the only
place she has full freedom — her Kubernetes namespace — is fenced off by Pod
Security and default-deny egress, which is exactly why Home Assistant cannot
see his LAN from in there. The obvious fix, a general "deploy this compose
YAML" verb, would have handed her the host: compose has no admission
controller, so host mounts, host networking and root are all one manifest
away.

He chose typed executors instead. So:

  * the service block lives in `docker-compose.yml`, in git, reviewed;
  * the sidecar that runs it exposes `/home/up` and `/home/down` and nothing
    parameterized, because it holds the docker socket;
  * `HomeAssistantDeploy` has no image, no ports, no volumes and no YAML —
    the dangerous fields are UNREPRESENTABLE, which is the property
    `schemas.py` exists for;
  * and this file drives it through the SAME operator route the human
    presses, which is what `assert_routes_exist()` checks at boot.

What Nova actually decides is whether to raise the card and what to say on
it. That is a real decision and it is the whole feature: she works out that
the thing is wanted, works out that it is reachable, and puts one click in
front of him — rather than explaining docker to him for 168 words, which is
what she did before this existed.
"""

from __future__ import annotations

import logging
import re
import zoneinfo
from typing import Optional

import httpx

from app import capability_events as ce
from app import settings_store, sidecar_auth
from app.actions.schemas import HomeAssistantDeploy
from app.task_steps import NeedAnswer
from app.config import settings

log = logging.getLogger(__name__)

# Long, and deliberately so: the first `up` pulls ~1.5GB and Home Assistant
# builds its frontend before it answers. The sidecar returns 202 immediately
# and does the work on its own thread, so this bounds the HANDOFF, never the
# pull. `_await_running` is what bounds the wait.
_CALL_TIMEOUT_S = 15.0
# How long to watch for the container after the sidecar accepts. Well inside
# actions' DEFAULT_EXECUTE_TIMEOUT_S so this reports a real state rather than
# being killed mid-poll.
_SETTLE_TRIES = 20
_SETTLE_SLEEP_S = 5.0


# Where the socket-holding sidecar reads the operator's timezone from. It has
# no database and must never grow one, so the shared `/state` volume is the
# channel — the same one the ntfy base-url uses. The sidecar mounts /state
# READ-ONLY: the setting is the backend's to own.
STATE_HOME_TZ_FILE = "/state/home_timezone"

# WHAT THIS EXECUTOR ALREADY COVERS, so a goal proposal for it can be
# redirected. Declared beside the executor, like every other capability
# statement in this codebase, and read by `propose_goal` through
# `actions.covered_by()` — never a list in the tool.
#
# Measured 2026-08-05, twice, after the compose path shipped and worked: asked
# to get Home Assistant running, she proposed a `deploy_workload` goal for her
# Kubernetes namespace. Nothing was wrong with the reasoning — that IS how she
# stands a service up — but it is the wrong home for this one, for the reason
# she herself gave the first time anyone asked: the namespace cannot see the
# LAN. The one-click path existed and she had no way to find it.
#
# A prompt sentence would have been the obvious fix and the wrong one: it
# holds until the model is under pressure, and this codebase has three
# incidents saying so.
COVERS = re.compile(r"home[\s_-]?assistant|\bhass\b|\bhomeassistant\b",
                    re.IGNORECASE)


def write_timezone() -> str:
    """Publish `home.timezone` to the sidecar. Returns what was written.

    LIVES HERE, and `router_chat` imports it rather than the reverse. The
    executor needs it and this package may not reach back into the app —
    `actions/__init__` forbids an `agents.runner` import at any depth, and
    `router_chat` pulls the runner in transitively, so calling into it from
    an executor would satisfy the letter of that rule while breaking what it
    is for.

    Non-fatal on failure: a missing file means the compose default applies,
    which is a wrong clock rather than a broken deploy. Refusing to start
    Home Assistant over a timezone would be the worse trade.
    """
    import os
    tz = str(settings_store.get("home.timezone") or "").strip()
    if not tz:
        return ""
    try:
        os.makedirs(os.path.dirname(STATE_HOME_TZ_FILE), exist_ok=True)
        with open(STATE_HOME_TZ_FILE, "w") as f:
            f.write(tz)
    except OSError:
        log.warning("could not write %s; Home Assistant will use the compose "
                    "default timezone", STATE_HOME_TZ_FILE)
        return ""
    return tz


HA_CONFIG_DIR = "/app/data/home-assistant"
HA_CONFIG_FILE = f"{HA_CONFIG_DIR}/configuration.yaml"

# The compose network. Home Assistant refuses a proxied request unless it is
# told which proxy to believe, and this is the only one that reaches it.
_TRUSTED_PROXY_CIDR = "172.18.0.0/16"

_HTTP_BLOCK = f"""
# Added by Nova (roadmap #35) so this instance is reachable from the
# operator's other devices over the tailnet. Home Assistant answers 400 to
# any request carrying X-Forwarded-For until a proxy is trusted, so without
# this it works on the host and is dead from a phone.
#
# The CIDR is the docker compose network, which is the only route in: the
# published port is bound to 127.0.0.1 and the tailscale container proxies
# from inside. Widening it would not add reachability, only trust.
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - {_TRUSTED_PROXY_CIDR}
"""


def ensure_proxy_trust() -> str:
    """Teach Home Assistant to trust the tailnet proxy. Returns what it did.

    IDEMPOTENT and CONSERVATIVE: appends only when the file has no `http:`
    key at all. If the operator has written his own `http:` block — a cert, a
    different proxy, an IP ban list — this leaves it alone and says so,
    because merging YAML someone else is maintaining is how you silently
    delete their configuration.

    Runs BEFORE the container starts, so the setting is live on first boot
    rather than needing a restart nobody knows to do.
    """
    import os
    import re as _re
    if not os.path.isdir(HA_CONFIG_DIR):
        return "config directory not mounted — skipped"
    try:
        with open(HA_CONFIG_FILE) as f:
            body = f.read()
    except FileNotFoundError:
        # NEVER CREATE IT. Home Assistant writes its own configuration.yaml on
        # first boot — `default_config:`, the frontend themes, the includes
        # for automations and scripts — and only if the file is absent. An
        # earlier version of this function wrote the `http:` block into the
        # gap, which would have left HA booting against a config with no
        # default_config and none of its includes. Nothing would have said so.
        return ("configuration.yaml does not exist yet — Home Assistant "
                "writes it on first boot; trust is applied on the next start")
    except OSError as e:
        return f"could not read configuration.yaml ({e}) — skipped"

    if _re.search(r"^http:", body, _re.MULTILINE):
        return "left alone — configuration.yaml already has an `http:` block"
    try:
        with open(HA_CONFIG_FILE, "a") as f:
            f.write(_HTTP_BLOCK)
    except OSError as e:
        return f"could not write configuration.yaml ({e}) — skipped"
    return f"trusted the tailnet proxy ({_TRUSTED_PROXY_CIDR})"


def describe(doc: HomeAssistantDeploy) -> str:
    return "\n".join([
        "Start Home Assistant",
        "    Service     home-assistant (compose profile `home`)",
        f"    Timezone    {doc.timezone}",
        "    Address     http://127.0.0.1:8123 — and over your tailnet",
        "    Config      ./data/home-assistant, on this machine",
        # SAY WHAT IT CANNOT DO. The operator is approving a smart-home hub;
        # the thing he will try first is pairing a device, and the honest
        # limit belongs on the card rather than in the first support
        # conversation. #35 locked this scope deliberately.
        "    Devices     IP-addressable only. No mDNS/SSDP discovery and no "
        "Zigbee/Z-Wave — the container is on the compose bridge, not your "
        "LAN, and USB radios are not passed through under WSL2.",
    ])


async def preflight(doc: HomeAssistantDeploy, *, operator: bool = False
                    ) -> tuple[str, str, None]:
    """Can this actually run, right now?

    Three questions, cheapest first, and each one is a thing a model can be
    confidently wrong about: is the timezone real, is the sidecar there, and
    is it already running.
    """
    try:
        zoneinfo.ZoneInfo(doc.timezone)
    except Exception:
        return ("blocked",
                f"unknown timezone {doc.timezone!r} — Home Assistant needs an "
                f"IANA zone name like America/New_York", None)

    # The operator's own setting wins a disagreement, and says so on the card.
    # `home.timezone` is where he sets it in the UI; a model filling in the
    # schema default has guessed, and a card that silently applied the guess
    # would put the wrong sunset in his automations.
    configured = str(settings_store.get("home.timezone") or "").strip()
    if configured and configured != doc.timezone:
        return ("ready",
                f"your configured timezone is {configured}, not the "
                f"{doc.timezone} in this plan — approving uses {configured} "
                f"(Settings → Home changes it)", None)

    try:
        async with httpx.AsyncClient(timeout=_CALL_TIMEOUT_S) as client:
            r = await client.get(f"{settings.inference_control_url}/home/status",
                                 headers=sidecar_auth.inference_control_headers())
        r.raise_for_status()
        state = r.json()
    except httpx.HTTPError as e:
        return ("blocked",
                f"the docker-control sidecar is unreachable ({e}) — nothing "
                f"can be started until it is up", None)

    if state.get("running"):
        return ("ready",
                f"Home Assistant is already running at "
                f"{state.get('url') or 'http://127.0.0.1:8123'}; approving "
                f"will restart it with timezone {doc.timezone}", None)
    return ("ready",
            f"the sidecar is reachable and home-assistant is "
            f"{state.get('state') or 'not created'}; approving pulls the "
            f"image on first run, which takes a few minutes", None)


async def _await_running(step) -> tuple[bool, str]:
    """Watch until the container reports running, or give up honestly.

    Returns (running, detail). Never raises: a poll that fails is a fact to
    report, and the deployment may well have succeeded anyway — the operator
    needs the difference between "it is up" and "I could not tell", and a
    traceback gives him neither.
    """
    import asyncio
    last = "no answer from the sidecar"
    for _ in range(_SETTLE_TRIES):
        await asyncio.sleep(_SETTLE_SLEEP_S)
        try:
            async with httpx.AsyncClient(timeout=_CALL_TIMEOUT_S) as client:
                r = await client.get(
                    f"{settings.inference_control_url}/home/status",
                    headers=sidecar_auth.inference_control_headers())
            r.raise_for_status()
            state = r.json()
        except httpx.HTTPError as e:
            last = f"sidecar unreachable while waiting: {e}"
            continue
        if state.get("error"):
            return False, str(state["error"])[:300]
        if state.get("running"):
            return True, str(state.get("url") or "http://127.0.0.1:8123")
        last = f"state {state.get('state') or 'unknown'}"
    return False, (f"still not running after "
                   f"{int(_SETTLE_TRIES * _SETTLE_SLEEP_S)}s — {last}")




# ── the run, as steps ────────────────────────────────────────────────────────
#
# Phase 3. This was one `execute()` that did the whole thing, and every one of
# these steps was a shell command I ran by hand on 2026-08-05 — start it, wait
# for it, make it trust the proxy, check Jeremy could actually open it. He
# named that as the failure:
#
#     "when we hit friction with nova, you need to fix nova to give her the
#      capabilities to do so, otherwise it's just you fucking doing it and
#      nova is just a fancy stupid ai."
#
# So the steps below drive the SAME sidecar endpoints her `service_logs` and
# `check_service_reachable` tools use. Nothing here reaches for anything she
# could not reach herself.
#
# Each is resumable at its own cursor and each is safe to repeat, because the
# worker advances the cursor AFTER the side effect — a crash mid-step repeats
# that step rather than skipping it, and skipping is the failure you cannot
# recover from.


def _first_zone(text: str) -> Optional[str]:
    """The first real IANA zone in a sentence, or None.

    Scans for `Area/Location` tokens and asks `zoneinfo` about each — so the
    list of valid zones is the system's, never one maintained here. Bare city
    names ("New York") deliberately do NOT match: there is no unambiguous
    mapping, and guessing one wrong puts a silently wrong clock in every
    automation he writes. Re-asking costs a sentence.
    """
    import re as _re
    for token in _re.findall(r"\b[A-Za-z][A-Za-z_+-]*(?:/[A-Za-z0-9_+-]+){1,2}\b",
                             text or ""):
        try:
            zoneinfo.ZoneInfo(token)
            return token
        except Exception:                    # noqa: BLE001 — not a zone, try next
            continue
    return None


async def _step_timezone(doc, rec, ctx) -> str:
    """Publish the timezone the container will boot with.

    ASKS FIRST, and asks only when it genuinely cannot decide: `home.timezone`
    unset AND the plan carrying nothing but the schema default. Any other
    combination has an answer already and a question would be friction.
    """
    configured = str(settings_store.get("home.timezone") or "").strip()
    if not configured:
        given = ctx.answered("timezone")
        if not given:
            raise NeedAnswer("timezone", (
                "Starting Home Assistant — one thing first. What timezone is "
                "the house in? It drives every 'at sunset' automation and the "
                "history graphs, and I'd rather not guess. I'll use "
                "America/New_York if that's right; otherwise give me an IANA "
                "name like Europe/London."))
        # READ IT LIKE A PERSON WOULD. The answer arrives as whatever he
        # typed into chat — "we're in New York", "New York. America/New_York.",
        # "Europe/London" — because it is a sentence to a colleague, not a
        # form field. The first version of this required the WHOLE message to
        # be a valid zone and re-asked at "New York. America/New_York.", which
        # contains the answer twice. Asking a person to restate something he
        # already said is the friction this phase exists to remove.
        #
        # Still VALIDATED, never guessed: a token only counts if zoneinfo
        # resolves it. A wrong zone is a wrong clock in every automation he
        # writes afterwards, so an unrecognisable answer re-asks rather than
        # picking something plausible.
        cleaned = _first_zone(given)
        if not cleaned:
            raise NeedAnswer("timezone", (
                f"I couldn't find a timezone in {given.strip()[:60]!r} — I "
                f"need the IANA name, like America/New_York or Europe/London. "
                f"Which one is the house in?"))
        await settings_store.set_value("home.timezone", cleaned)
    tz = write_timezone() or doc.timezone
    return f"timezone {tz}"


async def _step_start(doc, rec, ctx) -> str:
    """Ask the sidecar to bring the profile up. Returns immediately; the wait
    is the next step, so a slow pull cannot look like a hang."""
    # Wrapped, because this message becomes the run's `error` and the line the
    # operator reads on the card. httpx's own text is "All connection attempts
    # failed", which names nothing he can act on — and the thing that is down
    # (the docker-control sidecar) is the whole reason nothing started.
    try:
        async with httpx.AsyncClient(timeout=_CALL_TIMEOUT_S) as client:
            r = await client.post(f"{settings.inference_control_url}/home/up",
                                  headers=sidecar_auth.inference_control_headers())
    except httpx.HTTPError as e:
        raise RuntimeError(
            f"the docker-control sidecar is unreachable ({e}) — nothing was "
            f"started; it holds the docker socket and is the only thing that "
            f"can bring a service up") from e
    if r.status_code not in (200, 202):
        try:
            detail = r.json().get("error", r.text)
        except ValueError:
            detail = r.text
        raise RuntimeError(f"the sidecar refused to start it: {str(detail)[:300]}")
    return "sidecar accepted; pulling and starting"


async def _step_wait(doc, rec, ctx) -> str:
    """Wait for the container to report running.

    The loop I ran by hand. A first start pulls ~1.5GB and builds the
    frontend, so this is minutes, not seconds — and a run that reported
    success before the container was up would be exactly the confident
    invention this codebase keeps catching.
    """
    running, detail = await _await_running(ctx.record)
    if not running:
        raise RuntimeError(
            f"started, but it has not reported healthy yet: {detail}. First "
            f"boot pulls ~1.5GB; it may still be coming up.")
    return f"running at {detail}"


async def _step_trust_proxy(doc, rec, ctx) -> str:
    """Make it accept requests through the tailnet, then restart if that
    changed anything.

    On a FIRST deploy the config file does not exist until Home Assistant has
    booted once, so this cannot run before `_step_wait` — which is the whole
    reason it is its own step rather than a line inside the start.
    """
    outcome = ensure_proxy_trust()
    if not outcome.startswith("trusted"):
        return outcome
    async with httpx.AsyncClient(timeout=_CALL_TIMEOUT_S) as client:
        await client.post(f"{settings.inference_control_url}/home/up",
                          headers=sidecar_auth.inference_control_headers())
    running, detail = await _await_running(ctx.record)
    if not running:
        raise RuntimeError(f"{outcome}, but the restart has not settled: {detail}")
    return f"{outcome}; restarted and running at {detail}"


async def _step_verify(doc, rec, ctx) -> dict:
    """Can he actually open it, from another device?

    The last thing I did by hand, and the one that matters to him: "I'm not at
    that device, I need to see things like this from other devices." Running
    is not reachable — on 2026-08-05 it was healthy, published, and still
    unreachable over the tailnet in three different ways.
    """
    async with httpx.AsyncClient(timeout=90.0) as client:
        r = await client.get(f"{settings.inference_control_url}/reachable",
                             params={"service": "home-assistant"},
                             headers=sidecar_auth.inference_control_headers())
    data = r.json() if r.status_code == 200 else {}
    local = [x for x in (data.get("local") or []) if x.get("http_status")]
    routes = data.get("tailnet_routes") or []
    # MATCH THE URL, don't take the last word. `tailscale serve status` prints
    # "|-- tcp://nova.x.ts.net:8123 (TLS terminated, tailnet only)", so
    # split()[-1] is "only)" — which is exactly what the first run reported
    # back as the address to open. A confidently wrong URL is worse than none:
    # he tries it, it fails, and the deploy looked like it lied.
    url = ""
    for line in routes:
        m = re.search(r"\b(?:tcp|https?)://[A-Za-z0-9.-]+\.ts\.net(?::\d+)?", line)
        if m:
            url = m.group(0)
            break
    if url.startswith("tcp://"):
        # TLS is terminated at tailscale, so the scheme he types is https
        url = "https://" + url[len("tcp://"):]

    ce.record(ce.WORKLOAD, "home-assistant", "up", actor="agent",
              detail={"timezone": str(settings_store.get("home.timezone") or ""),
                      "recommendation": str(rec.get("id") or "")})

    if not local:
        return {"status": "ok", "url": None,
                "detail": ("Home Assistant is running, but nothing answered on "
                           "its published port yet — give it a minute and check "
                           "again.")}
    where = url or "http://127.0.0.1:8123"
    return {"status": "ok", "url": where,
            "detail": (f"Home Assistant is running and reachable at {where}"
                       + ("" if url else
                          " — on this machine only; tailscale is not serving "
                          "it, so another device cannot reach it yet."))}


STEPS = [
    ("timezone", _step_timezone),
    ("start", _step_start),
    ("wait", _step_wait),
    ("trust-proxy", _step_trust_proxy),
    ("verify", _step_verify),
]
