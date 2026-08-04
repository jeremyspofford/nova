"""Whether the services that make up this install are actually running.

Written 2026-08-03, from a turn where she was asked to check SearXNG and
answered *"SearXNG is not healthy — it's completely unreachable"* while it was
serving 200s. She was not hallucinating. `diagnose`'s `services` key was
`sysmon._reaches()`, which reports exactly two things — the shared Postgres
and the memory directory — so SearXNG was ABSENT from the list, and she read
absence as failure. Her own words: *"the diagnose output shows no SearXNG
entry in the services list (only pg and memory are listed as running)"*.

That is the failure this module exists to remove, and it is worth naming
precisely, because the retry fix that landed the same day made it possible:
before, a turn that could not see went quiet; now it calls a tool and reports
what the tool implies. Fixing the silence without giving her an instrument
moved the failure from "says nothing" to "says something wrong", which is the
worse of the two. `diagnostics` already declares the rule this broke — HONEST
ABOUT ABSENCE — and then broke it.

Two sources, because neither alone is the truth:

  containers   the sidecar's `docker ps -a` over this compose project. This is
               the only source that can see a service that is DOWN, and the
               only one carrying `State.Error` — the sentence that names why.
               A dead container does not answer probes; it does not appear in
               them either.

  probes       `sysmon.health()`. A container reports "running" while its
               healthcheck has been failing for an hour, and a process can
               accept a socket while answering 500s. Reachability is the only
               thing that settles whether it WORKS.

The backend never holds the docker socket — `inference-control` is the sole
holder by design, and this goes through its fixed-verb `/containers`. That is
a containment property, not a preference: a backend that could drive docker
could stop the guardian.
"""

from __future__ import annotations

import logging
from typing import Optional

log = logging.getLogger(__name__)

# The tools whose RESULT carries a real reading of service state. Declared
# here, beside the function that produces it, so `service_claims` never holds
# a second list that can drift: a third tool that starts returning this is
# added on the line below the code that made it true, and the detector goes
# quiet for it by itself.
EVIDENCE_TOOLS = frozenset({"service_status", "diagnose"})


def _is_one_off(name: str, service: Optional[str], project: str) -> bool:
    """A container that is not THE service, despite carrying its label.

    `docker compose run backend ...` produces a container labelled
    `service=backend` with a random name like `cranky_bhaskara`. One is live on
    this box right now. Grouping by label alone therefore reports two backends
    and makes "is backend up?" ambiguous — and a leftover one-off that exited
    would read as the service being down. Compose names the real thing
    `<project>-<service>-<n>`, so the test is the name, derived from the two
    labels docker already wrote.
    """
    return bool(service) and not name.startswith(f"{project}-{service}-")


async def _containers(project: str) -> Optional[list[dict]]:
    """Container facts from the sidecar, or None when it cannot be reached.

    None is not an empty list. An empty list would say "this install has no
    services", which is the same shape of lie this module was written to stop.
    """
    import httpx
    from app.config import settings
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(f"{settings.inference_control_url}/containers")
            r.raise_for_status()
            return r.json().get("containers") or []
    except Exception as e:  # noqa: BLE001
        log.warning("service_health: sidecar /containers unavailable: %s", e)
        return None


async def status() -> dict:
    """Every service in this install, what state it is in, and what is wrong."""
    import os

    from app import sysmon

    project = os.environ.get("COMPOSE_PROJECT_NAME") or "nova"
    rows = await _containers(project)

    try:
        probes = (await sysmon.health()).get("services") or []
    except Exception as e:  # noqa: BLE001 — one source failing is not both
        log.warning("service_health: probes failed: %s", e)
        probes = []
    by_name = {str(p.get("name")): p for p in probes}

    services: list[dict] = []
    one_offs: list[dict] = []
    for c in rows or []:
        name, svc = str(c.get("name") or ""), c.get("service")
        entry = {
            "service": svc or name,
            "container": name,
            "state": c.get("state"),
            "health": c.get("health"),
            "status": c.get("status"),
        }
        if c.get("exit_code") is not None:
            entry["exit_code"] = c["exit_code"]
        # VERBATIM. Docker's own sentence ("error while creating mount source
        # path…") is the diagnosis; paraphrasing it is how it stopped being one.
        if c.get("error"):
            entry["error"] = c["error"]
        (one_offs if _is_one_off(name, svc, project) else services).append(entry)

    # Reachability, attached where the names line up. A probe with no container
    # (or the reverse) is kept rather than dropped — a mismatch is information.
    for s in services:
        probe = by_name.pop(s["service"], None)
        if probe:
            s["reachable"] = bool(probe.get("ok"))
            if probe.get("ms") is not None:
                s["response_ms"] = probe["ms"]
            if probe.get("detail"):
                s["unreachable_detail"] = probe["detail"]
    unmatched = [
        {"service": n, "container": None, "state": None,
         "reachable": bool(p.get("ok")), "response_ms": p.get("ms"),
         "unreachable_detail": p.get("detail"),
         "note": "probed by URL; not a container in this compose project"}
        for n, p in by_name.items()]

    down = [s for s in services if s.get("state") and s["state"] != "running"]
    unhealthy = [s for s in services if s.get("health") == "unhealthy"]
    unreachable = [s for s in services + unmatched if s.get("reachable") is False]
    # A stopped container also fails its probe, and saying "running but not
    # answering" about a container that has exited is the same species of
    # confidently-wrong sentence this module exists to stop — it was the first
    # thing this printed when a service was actually stopped. The probe result
    # stays in `unreachable` because it is a fact; only the prose is narrowed
    # to services that really are up.
    _down_names = {s["service"] for s in down}
    still_running_but_silent = [s for s in unreachable
                                if s["service"] not in _down_names]

    out: dict = {
        "project": project,
        "services": sorted(services + unmatched,
                           key=lambda s: str(s.get("service") or "")),
        "running": sum(1 for s in services if s.get("state") == "running"),
        "not_running": [s["service"] for s in down],
        "unhealthy": [s["service"] for s in unhealthy],
        "unreachable": [s["service"] for s in unreachable],
    }
    if one_offs:
        out["one_off_containers"] = one_offs
        out["one_off_note"] = (
            "Left behind by `docker compose run`. They carry a service label "
            "but are not that service — do not read their state as the "
            "service's.")

    if rows is None:
        # The one answer that must never be silent. Without this the caller
        # sees zero services and no explanation, which is precisely the
        # absence-read-as-failure that produced "SearXNG is unreachable".
        out["container_view"] = "UNAVAILABLE"
        out["note"] = (
            "The inference-control sidecar could not be reached, so NOTHING "
            "here is known about container state — a service could be stopped "
            "and this would not show it. Only the URL probes below are real. "
            "Do not report a service as up or down on this reading.")
    elif not (down or unhealthy or unreachable):
        out["note"] = (
            f"All {out['running']} containers in project '{project}' are "
            "running, none is unhealthy, and every probed endpoint answered. "
            "If something is failing it is not at this layer.")
    else:
        parts = []
        if down:
            parts.append(", ".join(
                f"{s['service']} is {s['state']}"
                + (f" (exit {s['exit_code']})" if s.get("exit_code") is not None else "")
                + (f": {s['error']}" if s.get("error") else "")
                for s in down))
        if unhealthy:
            parts.append("failing its healthcheck: "
                         + ", ".join(s["service"] for s in unhealthy))
        if still_running_but_silent:
            parts.append("running but not answering: "
                         + ", ".join(s["service"]
                                     for s in still_running_but_silent))
        out["note"] = ". ".join(parts) + "."
    return out
