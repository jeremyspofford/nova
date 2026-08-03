"""Whether a service is up, and the sentences that must never be said.

    docker compose exec backend python tests/test_service_health.py

On 2026-08-03 Nova was asked to check SearXNG and reported it "completely
unreachable" while it was serving 200s. She was reading `diagnose`, whose
`services` key listed exactly two entries — postgres and the memory directory
— and searxng was not among them. Her own words: *"the diagnose output shows
no SearXNG entry in the services list (only pg and memory are listed as
running)"*. She read the tool correctly. The tool implied something false.

So the properties defended here are mostly about what is SAID, not what is
gathered. Every one of them is a sentence that was, or could have been,
confidently wrong:

1. ABSENCE IS NEVER A VERDICT. When the container view cannot be read, the
   result must say so and must refuse to conclude. This is the original bug.
2. A STOPPED CONTAINER IS NOT "RUNNING BUT NOT ANSWERING". A down container
   also fails its probe; the first real run of this module printed exactly
   that sentence about an exited container.
3. DOCKER'S ERROR IS VERBATIM. `State.Error` names the cause ("mount failed");
   a paraphrase is not a diagnosis.
4. A `compose run` LEFTOVER IS NOT THE SERVICE. One is live on this box right
   now, labelled service=backend.

`status()` reads two sources, so both are injected here. Nothing in this file
touches the live sidecar or the live stack.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

from app import service_health as sh              # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def run(containers, probes=None):
    """status() with both sources injected. containers=None => sidecar down.

    Both are patched at the attribute the code actually reads, so neither the
    sidecar nor a live socket is touched. `status()` does `from app import
    sysmon` at CALL time, which resolves the package attribute — patching
    sys.modules would silently not take, and the test would pass against the
    real prober while claiming to be hermetic.
    """
    from app import sysmon

    async def _containers(project):
        return containers

    async def _health():
        return {"services": probes or []}

    real_containers, real_health = sh._containers, sysmon.health
    sh._containers, sysmon.health = _containers, _health
    try:
        return asyncio.run(sh.status())
    finally:
        sh._containers, sysmon.health = real_containers, real_health


def c(service, state="running", **kw):
    return {"name": f"nova-{service}-1", "service": service, "state": state,
            "status": kw.pop("status", "Up 2 days"), "health": kw.pop("health", None),
            "exit_code": kw.pop("exit_code", None), "error": kw.pop("error", None),
            **kw}


def main() -> int:
    print("1. absence is never a verdict — the original bug")
    out = run(None, probes=[{"name": "searxng", "ok": True, "ms": 5}])
    check("the container view is flagged UNAVAILABLE, not reported as empty",
          out.get("container_view") == "UNAVAILABLE", str(out.get("container_view")))
    check("and the note REFUSES to conclude anything about up/down",
          "do not report a service as up or down" in out["note"].lower(),
          out["note"][:70])
    check("no service is listed as not_running on the strength of it",
          out["not_running"] == [], str(out["not_running"]))

    print("2. a stopped container is not 'running but not answering'")
    out = run([c("kokoro", state="exited", exit_code=0,
                 status="Exited (0) 3 seconds ago")],
              probes=[{"name": "kokoro", "ok": False, "detail": "Name or service not known"}])
    check("it is reported as exited, with the code",
          "kokoro is exited (exit 0)" in out["note"], out["note"])
    check("and NOT described as running — the sentence this printed for real",
          "running but not answering" not in out["note"], out["note"])
    check("the failed probe is still recorded as a fact",
          out["unreachable"] == ["kokoro"], str(out["unreachable"]))

    print("3. a service that is up but silent IS named that way")
    out = run([c("searxng")],
              probes=[{"name": "searxng", "ok": False, "detail": "timeout"}])
    check("running + failing probe reads as 'running but not answering'",
          "running but not answering: searxng" in out["note"], out["note"])

    print("4. docker's own error text survives verbatim")
    err = ("error while creating mount source path "
           "'/run/desktop/mnt/host/wsl/docker-desktop/settings.json': mkdir ...")
    out = run([c("searxng", state="exited", exit_code=127, error=err,
                 status="Exited (127) 43 hours ago")])
    entry = next(s for s in out["services"] if s["service"] == "searxng")
    check("the error is carried unaltered — it IS the diagnosis",
          entry.get("error") == err, (entry.get("error") or "")[:48])
    check("and it reaches the note the model reads",
          err in out["note"], out["note"][:60])
    check("with the exit code beside it",
          entry.get("exit_code") == 127, str(entry.get("exit_code")))

    print("5. a `compose run` leftover is not the service")
    out = run([c("backend"),
               {"name": "cranky_bhaskara", "service": "backend",
                "state": "exited", "status": "Exited (1) 2 days ago",
                "health": None, "exit_code": 1, "error": None}])
    check("the stray is separated out, not counted as a service",
          [s["service"] for s in out["services"]] == ["backend"],
          str([s["service"] for s in out["services"]]))
    check("an EXITED stray never makes the real service look down — the "
          "failure mode of grouping by label alone",
          out["not_running"] == [], str(out["not_running"]))
    check("but it is still shown, so it can be cleaned up",
          out["one_off_containers"][0]["container"] == "cranky_bhaskara")

    print("6. all clear says so, rather than returning an empty object")
    out = run([c("backend", health="healthy"), c("postgres", health="healthy")],
              probes=[{"name": "backend", "ok": True, "ms": 3}])
    check("the healthy note states the count and the scope",
          "All 2 containers" in out["note"] and "are running" in out["note"],
          out["note"][:60])
    check("nothing is listed as wrong",
          not out["not_running"] and not out["unhealthy"] and not out["unreachable"])

    print("7. a probed endpoint with no container is kept, and labelled")
    out = run([c("backend")], probes=[{"name": "inference", "ok": True, "ms": 9}])
    entry = next(s for s in out["services"] if s["service"] == "inference")
    check("it is not silently dropped",
          entry["reachable"] is True and entry["container"] is None)
    check("and it says why it has no container",
          "not a container in this compose project" in entry["note"])

    print("8. an unhealthy container is named even while 'running'")
    out = run([c("web", health="unhealthy", status="Up 2 days (unhealthy)")])
    check("healthcheck failure is surfaced, not hidden by state=running",
          out["unhealthy"] == ["web"] and "failing its healthcheck" in out["note"],
          out["note"])

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
