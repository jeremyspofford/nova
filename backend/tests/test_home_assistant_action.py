"""Approving a card starts Home Assistant. Roadmap #35.

    docker compose exec backend python tests/test_home_assistant_action.py

Jeremy, 2026-08-05: "She needs to be able to go and do things on her own,
figure it out, without me needing to do it for her while she explains to me
like she's google what to do step by step."

The honest answer was no, and the reason was not a missing tool. The only
place she had full freedom was her Kubernetes namespace, fenced by Pod
Security and default-deny egress — which is exactly why Home Assistant
cannot see his LAN from in there. The obvious fix, a general "deploy this
compose YAML" verb, would have handed her the host: compose has no admission
controller, so host mounts, host networking and root are one manifest away.

He chose typed executors. This suite defends the four boundaries that
decision rests on, and every one of them is a thing that must FAIL:

  1. THE SCHEMA — image, ports, volumes, YAML are unrepresentable. Not
     validated away: absent, so they cannot be written down.
  2. THE BOOT GATE — the executor names an operator route that exists. If
     someone deletes the route, the backend must refuse to start rather than
     leave her a capability he does not have.
  3. THE TIMEZONE — his setting beats her plan, and the two paths to the
     same effect apply the same clock.
  4. THE REPORT — a start that does not settle says so, and does not claim
     success. The whole lane is worth nothing if what replaces "want me to?"
     is a confident invention.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

from app import actions, settings_store            # noqa: E402
from app.actions import home_assistant as ha       # noqa: E402
from app.actions.schemas import HomeAssistantDeploy  # noqa: E402

import _env                                        # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _doc(**kw):
    return actions.parse({"type": "home_assistant.deploy",
                          "why": "Jeremy asked for it", **kw})


def test_schema():
    print("\n1. THE DANGEROUS FIELDS ARE UNREPRESENTABLE")
    for field, value, why in [
        ("image", "evil:latest", "a chosen image is a chosen program"),
        ("volumes", ["/:/host"], "a host mount is the whole machine"),
        ("ports", ["0.0.0.0:80:80"], "a chosen bind is a chosen exposure"),
        ("manifest", "apiVersion: v1", "no YAML reaches the host, ever"),
        ("network_mode", "host", "host networking is the fence, removed"),
        ("command", "sh -c 'curl evil'", "there is no command field anywhere"),
        ("privileged", True, "the one flag that ends all of it"),
    ]:
        try:
            actions.parse({"type": "home_assistant.deploy", "why": "x",
                           field: value})
            check(f"1.1 `{field}` is refused", False, "ACCEPTED")
        except ValueError as e:
            check(f"1.1 `{field}` is refused", True, f"{why} — {str(e)[:40]}")

    print("   …and the timezone cannot carry a payload")
    for bad in ("../../etc/passwd", "a; rm -rf /", "$(whoami)", "a" * 80,
                "America/New_York\nEurope/London"):
        try:
            actions.parse({"type": "home_assistant.deploy", "why": "x",
                           "timezone": bad})
            check(f"1.2 refuses {bad[:22]!r}", False, "ACCEPTED")
        except ValueError:
            check(f"1.2 refuses {bad[:22]!r}", True)

    check("1.3 the minimal plan is just a reason",
          _doc().timezone == "America/New_York")
    check("1.4 `why` is required — a card with no reason is not a card",
          _refused({"type": "home_assistant.deploy"}))


def _refused(raw) -> bool:
    try:
        actions.parse(raw)
        return False
    except ValueError:
        return True


def test_boot_gate():
    print("\n2. THE EXECUTOR IS LEGAL ONLY BECAUSE THE OPERATOR ROUTE EXISTS")
    spec = actions._TYPES["home_assistant.deploy"]
    check("2.1 registered with an operator route",
          spec.operator_route == "home_assistant_control")
    actions.assert_routes_exist()
    check("2.2 assert_routes_exist passes as things stand", True)

    # AND IT MUST BE ABLE TO FAIL. A boot gate nobody has seen refuse is a
    # comment. Point one type at a route that does not exist and the backend
    # has to refuse to start.
    # dataclasses.replace, NOT a hand-built Spec. The first version listed the
    # fields it knew about, so when `steps` was added for phase 3 this swap
    # silently dropped it — the restore put back a Spec with no executor at
    # all and 2.4 failed on a registry the test itself had broken. A field
    # added tomorrow rides along now.
    import dataclasses
    try:
        actions._TYPES["home_assistant.deploy"] = dataclasses.replace(
            spec, operator_route="no_such_route_at_all")
        actions.assert_routes_exist()
        check("2.3 …and it would REFUSE a route that vanished", False,
              "boot gate did not fire")
    except RuntimeError as e:
        check("2.3 …and it would REFUSE a route that vanished", True,
              str(e)[:60])
    finally:
        actions._TYPES["home_assistant.deploy"] = spec

    check("2.4 an executor exists, so the card promises a real button",
          actions.is_executable({"type": "home_assistant.deploy", "why": "x"}))


def test_card_text():
    print("\n3. THE CARD STATES THE LIMIT HE WILL HIT FIRST")
    text = actions.describe({"type": "home_assistant.deploy", "why": "x",
                             "timezone": "Europe/London"})
    check("3.1 names the timezone he is approving", "Europe/London" in text)
    check("3.2 names where it will be", "8123" in text)
    check("3.3 says devices are IP-only, on the card, not in support later",
          "IP-addressable" in text)
    check("3.4 …and names the two he will actually try",
          "Zigbee" in text and ("mDNS" in text or "SSDP" in text))


def test_timezone_authority():
    print("\n4. HIS SETTING BEATS HER PLAN")
    if not _env.reachable("http://inference-control:9911/home/status"):
        print("  SKIP  inference-control is not in this stack")
        return
    before = settings_store.get("home.timezone")
    try:
        settings_store._cache["home.timezone"] = "Europe/London"
        state, detail, _ = asyncio.run(ha.preflight(_doc(timezone="Asia/Tokyo")))
        check("4.1 a disagreement is surfaced BEFORE he approves",
              "Europe/London" in detail and "Asia/Tokyo" in detail, detail[:70])
        check("4.2 …and it is still ready, not blocked — his value just wins",
              state == "ready", state)
        check("4.3 write_timezone publishes HIS value, not the plan's",
              ha.write_timezone() == "Europe/London")
    finally:
        settings_store._cache["home.timezone"] = before
        ha.write_timezone()

    state, detail, _ = asyncio.run(ha.preflight(_doc(timezone="Mars/Olympus")))
    check("4.4 a timezone that is not real blocks the card", state == "blocked",
          detail[:60])


def test_preflight_reads_the_world():
    print("\n5. PREFLIGHT ASKS THE SIDECAR, NOT THE MODEL")
    if not _env.reachable("http://inference-control:9911/home/status"):
        print("  SKIP  inference-control is not in this stack")
        return
    state, detail, tools = asyncio.run(ha.preflight(_doc()))
    check("5.1 it reached the sidecar and formed a verdict",
          state in ("ready", "blocked"), f"{state}: {detail[:60]}")
    check("5.2 no tool list — this action grants nothing", tools is None)
    # STATE-AGNOSTIC on purpose. The first version of this listed the strings
    # it expected — "absent", "not created" — and went red the moment the
    # container had been started and stopped once, reporting `exited`. The
    # claim worth defending is that the sentence came from the sidecar rather
    # than from the model, and the way to check that is that it names the
    # state the sidecar is reporting right now.
    import asyncio as _a
    import httpx
    from app.config import settings as _s

    async def _live():
        from app import sidecar_auth
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get(f"{_s.inference_control_url}/home/status",
                            headers=sidecar_auth.inference_control_headers())
        return r.json()

    live = _a.run(_live())
    expect = ("already running" if live.get("running")
              else str(live.get("state") or "not created"))
    check("5.3 the verdict describes the REAL current state",
          expect in detail, f"expected {expect!r} in {detail[:60]!r}")


def test_failure_is_reported_as_failure():
    print("\n6. A START THAT DOES NOT SETTLE SAYS SO")

    from app.config import settings
    from app.task_steps import StepContext

    seen: list[tuple] = []

    async def record(name, status, detail=""):
        seen.append((name, status, detail))

    # Point the step at a sidecar that is not there. The whole lane is about
    # replacing "want me to?" with action; it is worth nothing if what
    # replaces it is a confident claim that something happened.
    ctx = StepContext(record=record)
    real = settings.inference_control_url
    err = None
    try:
        settings.inference_control_url = "http://127.0.0.1:9"   # closed port
        asyncio.run(ha._step_start(_doc(), {"id": "test"}, ctx))
    except Exception as e:                              # noqa: BLE001
        err = e
    finally:
        settings.inference_control_url = real

    check("6.1 an unreachable sidecar RAISES rather than returning success",
          err is not None, type(err).__name__ if err else "returned normally")
    # The worker turns that into status='failed' with the message on the row —
    # `_process` is the only place that decides, so a step's whole job is to
    # be honest about not having worked.
    check("6.2 …and the reason names the sidecar, not something generic",
          err is not None and "sidecar" in str(err).lower(), str(err)[:80])


def test_steps_are_the_contract():
    print("\n7. THE RUN IS RESUMABLE STEPS, NOT ONE SHOT")
    spec = actions._TYPES["home_assistant.deploy"]
    names = [n for n, _ in (spec.steps or [])]
    check("7.1 registered as steps, not a single execute",
          bool(spec.steps) and spec.execute is None, str(names))
    check("7.2 the order is the one the work actually needs",
          names == ["timezone", "start", "wait", "trust-proxy", "verify"],
          str(names))
    # ORDERING IS LOAD-BEARING and not cosmetic: `trust-proxy` edits a config
    # file Home Assistant only writes during its FIRST boot, so it cannot run
    # before `wait`. Putting it earlier is a no-op that leaves the instance
    # unreachable from his phone, silently.
    check("7.3 trust-proxy comes after the wait, because the file does not "
          "exist until HA has booted once",
          names.index("trust-proxy") > names.index("wait"))
    check("7.4 verify is last — reachability is the claim being made",
          names[-1] == "verify")

    print("   …and a question is asked BEFORE anything is done")
    # NeedAnswer at the top of the FIRST step, so the re-run after his answer
    # repeats nothing. A step that asked halfway would redo its own first half
    # on resume, because an exception cannot be resumed.
    import inspect
    src = inspect.getsource(ha._step_timezone)
    check("7.5 the asking step raises before it starts anything",
          src.index("NeedAnswer") < src.index("write_timezone"))

    print("   …and a free-text answer is read, not demanded verbatim")
    for text, want in [("New York. America/New_York.", "America/New_York"),
                       ("Europe/London please", "Europe/London"),
                       ("America/New_York", "America/New_York")]:
        check(f"7.6 reads {text[:26]!r}", ha._first_zone(text) == want,
              str(ha._first_zone(text)))
    check("7.7 …but never GUESSES from a bare city name",
          ha._first_zone("we are in New York") is None,
          "a wrong zone is a wrong clock in every automation he writes")


def main() -> int:
    test_schema()
    test_boot_gate()
    test_card_text()
    test_timezone_authority()
    test_preflight_reads_the_world()
    test_failure_is_reported_as_failure()
    test_steps_are_the_contract()
    if FAILURES:
        print(f"\nFAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
