"""Bearer auth on the two privileged sidecars (ROADMAP #44 item 1).

    docker compose exec backend python tests/test_sidecar_auth.py
    PYTHONPATH=backend python backend/tests/test_sidecar_auth.py   (CI)

`git-landing` is the only container that can write branches into the
operator's repository; `inference-control` holds the docker socket, which is
root on the host. Until 2026-08-08 both answered ANY container on the compose
network — the 2026-08-07 review called closing that the precondition for #47
rail 6. The pattern is mcp-runner's: one shared token per sidecar,
`Authorization: Bearer`, constant-time compare on the server.

What is pinned here, and why each half matters:

  1. The sidecar servers themselves, driven over real HTTP (the modules are
     plain stdlib servers, imported from the mounted checkout and booted on
     an ephemeral port). A configured sidecar refuses everything but /health
     without the token; the UNSET posture accepts — that is the one logged
     exception, chosen over mcp-runner's refuse-all because refuse-all would
     blank every status surface on an install whose .env was never wired.
  2. The backend's header helpers: token -> header, no token -> NO header
     (the sidecar is the thing that refuses, never an invented credential).
  3. The call sites, scanned mechanically: ~15 sites across eight files talk
     to inference-control, and a header each builds by hand is a header one
     forgets. New bare call sites fail this suite the day they are written.
  4. The compose contract: the vars actually reach both sidecars AND the
     backend, because a token set in .env that compose never passes through
     is auth that silently never happened.
"""

import importlib.util
import re
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []

#: The repo root: mounted at /app/project in the backend container; the
#: parents[2] fallback covers CI, which runs from the checkout itself.
ROOT = next((p for p in (Path("/app/project"),
                         Path(__file__).resolve().parents[2], Path.cwd())
             if (p / "git-landing" / "server.py").is_file()), None)
#: The backend source, for the call-site scan — always present wherever this
#: suite can run at all.
APP = Path(__file__).resolve().parents[1] / "app"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _load(name: str, rel: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _serve(mod):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), mod.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def _sidecar_server_checks():
    print("1. the sidecar servers enforce the token (live HTTP)")
    if ROOT is None:
        print("  NOTE  the checkout is not reachable from this container — "
              "the server half of this suite enforces in CI, which runs "
              "run_all.py from the repo root on every push.")
        return
    import httpx

    gl = _load("gl_server", "git-landing/server.py")
    ic = _load("ic_server", "inference-control/server.py")

    for mod, label in ((gl, "git-landing"), (ic, "inference-control")):
        src = (ROOT / label / "server.py").read_text()
        check(f"{label} compares in constant time (hmac.compare_digest)",
              "hmac.compare_digest" in src)

    # ── git-landing, token configured ───────────────────────────────────
    gl._TOKEN = "s3cret-gl"
    srv, base = _serve(gl)
    try:
        with httpx.Client(timeout=10.0) as c:
            r = c.get(f"{base}/health")
            check("git-landing /health answers without a token",
                  r.status_code == 200, str(r.status_code))
            r = c.get(f"{base}/status")
            check("git-landing /status refuses a bare request",
                  r.status_code == 401, str(r.status_code))
            r = c.get(f"{base}/status",
                      headers={"Authorization": "Bearer wrong"})
            check("git-landing /status refuses a wrong token",
                  r.status_code == 401, str(r.status_code))
            r = c.get(f"{base}/status",
                      headers={"Authorization": "bearer s3cret-gl"})
            check("git-landing accepts the token (scheme case-insensitive)",
                  r.status_code == 200, str(r.status_code))
            r = c.post(f"{base}/land", json={})
            check("git-landing POST /land refuses a bare request "
                  "(the repo-write verb)",
                  r.status_code == 401, str(r.status_code))
            r = c.post(f"{base}/land", json={},
                       headers={"Authorization": "Bearer s3cret-gl"})
            check("...and with the token the request reaches the handler "
                  "(empty patch -> its own 409, not a 401)",
                  r.status_code == 409 and "empty" in r.text,
                  f"{r.status_code} {r.text[:80]}")
    finally:
        srv.shutdown()

    # ── git-landing, token UNSET: accept (the one logged exception) ─────
    gl._TOKEN = ""
    srv, base = _serve(gl)
    try:
        with httpx.Client(timeout=10.0) as c:
            r = c.get(f"{base}/status")
            check("git-landing with NO configured token still answers "
                  "(migration posture: accept + log, never silent refusal)",
                  r.status_code == 200, str(r.status_code))
    finally:
        srv.shutdown()

    # ── inference-control, token configured ─────────────────────────────
    ic._TOKEN = "s3cret-ic"
    srv, base = _serve(ic)
    try:
        with httpx.Client(timeout=10.0) as c:
            r = c.get(f"{base}/health")
            check("inference-control /health answers without a token",
                  r.status_code == 200, str(r.status_code))
            r = c.get(f"{base}/status")
            check("inference-control /status refuses a bare request",
                  r.status_code == 401, str(r.status_code))
            r = c.post(f"{base}/start")
            check("inference-control POST /start refuses a bare request "
                  "(the docker verb)",
                  r.status_code == 401, str(r.status_code))
            r = c.get(f"{base}/not-a-route",
                      headers={"Authorization": "Bearer wrong"})
            check("auth is checked BEFORE routing (wrong token on an unknown "
                  "path is 401, not 404 — no route map to probe for free)",
                  r.status_code == 401, str(r.status_code))
            r = c.get(f"{base}/not-a-route",
                      headers={"Authorization": "Bearer s3cret-ic"})
            check("...and with the token the same path reaches routing (404)",
                  r.status_code == 404, str(r.status_code))
    finally:
        srv.shutdown()

    # ── inference-control, token UNSET ──────────────────────────────────
    ic._TOKEN = ""
    srv, base = _serve(ic)
    try:
        with httpx.Client(timeout=10.0) as c:
            r = c.get(f"{base}/not-a-route")
            check("inference-control with NO configured token still routes",
                  r.status_code == 404, str(r.status_code))
    finally:
        srv.shutdown()


def _helper_checks():
    print("2. the backend helpers present the token, or honestly nothing")
    from app import sidecar_auth
    from app.config import settings

    saved = (settings.nova_git_landing_token,
             settings.nova_inference_control_token)
    try:
        settings.nova_git_landing_token = "abc123"
        settings.nova_inference_control_token = "def456"
        check("git-landing token becomes an Authorization header",
              sidecar_auth.git_landing_headers()
              == {"Authorization": "Bearer abc123"})
        check("inference-control token becomes an Authorization header",
              sidecar_auth.inference_control_headers()
              == {"Authorization": "Bearer def456"})
        settings.nova_git_landing_token = ""
        settings.nova_inference_control_token = ""
        check("an unset token sends NO header (the sidecar decides its own "
              "unconfigured posture; the backend never invents a credential)",
              sidecar_auth.git_landing_headers() == {}
              and sidecar_auth.inference_control_headers() == {})
    finally:
        (settings.nova_git_landing_token,
         settings.nova_inference_control_token) = saved


def _call_site_scan():
    print("3. no call site talks to a sidecar without the header (scan)")
    # Every `.get(`/`.post(` whose URL is built from inference_control_url
    # must carry sidecar_auth within the same call. A 500-char window is a
    # tripwire, not a proof — but every honest call fits in it, and a caller
    # who builds the URL in a variable first should be adding themselves to
    # this scan, not routing around it.
    scanned = 0
    for py in sorted(APP.rglob("*.py")):
        if py.name == "sidecar_auth.py":
            continue
        text = py.read_text()
        for m in re.finditer(r"\.(?:get|post)\(", text):
            head = text[m.end():m.end() + 120]
            if "inference_control_url" not in head:
                continue
            scanned += 1
            window = text[m.start():m.start() + 500]
            line = text[:m.start()].count("\n") + 1
            check(f"{py.name}:{line} sends the inference-control token",
                  "sidecar_auth" in window)
    check("the scan found the call sites at all (>= 10 — an empty scan "
          "would be a green light that checked nothing)", scanned >= 10,
          f"scanned {scanned}")

    # sysmon's health probe builds `{base}{path}`, which the pattern above
    # cannot see — its header is derived from the URL being probed, and that
    # exact derivation is what gets pinned.
    sysmon = (APP / "sysmon.py").read_text()
    check("sysmon._probe derives the header from the probed base URL",
          "base == settings.inference_control_url" in sysmon)

    print("4. coder.py is git-landing's ONLY client, and it sends the token")
    offenders = [py.name for py in sorted(APP.rglob("*.py"))
                 if py.name != "coder.py"
                 and ("NOVA_GIT_LANDING_URL" in py.read_text()
                      or "git-landing:9912" in py.read_text())]
    check("no app module besides coder.py reaches git-landing directly "
          "(one client means one place the header can be forgotten)",
          not offenders, str(offenders))
    coder = (APP / "coder.py").read_text()
    n = coder.count("sidecar_auth.git_landing_headers()")
    check("coder.py's three git-landing paths (land, repo_status, the "
          "sandbox _post helper) all attach the header", n >= 3, f"found {n}")


def _compose_checks():
    print("5. compose actually delivers the tokens (a var .env sets but "
          "compose never passes is auth that silently never happened)")
    if ROOT is None:
        print("  NOTE  no checkout mounted — enforced in CI, like section 1.")
        return
    import yaml
    doc = yaml.safe_load((ROOT / "docker-compose.yml").read_text())
    services = doc.get("services") or {}

    def env_of(name):
        return (services.get(name) or {}).get("environment") or {}

    for svc, var in (("backend", "NOVA_GIT_LANDING_TOKEN"),
                     ("backend", "NOVA_INFERENCE_CONTROL_TOKEN"),
                     ("git-landing", "NOVA_GIT_LANDING_TOKEN"),
                     ("inference-control", "NOVA_INFERENCE_CONTROL_TOKEN")):
        check(f"{svc} receives {var} from .env",
              env_of(svc).get(var) == "${%s:-}" % var,
              str(env_of(svc).get(var)))


def main() -> int:
    for section in (_sidecar_server_checks, _helper_checks,
                    _call_site_scan, _compose_checks):
        section()
        print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
