"""Funnel publishes ONE port, and it is not the phone's.

    docker compose exec backend python tests/test_guest_funnel_config.py

`tailscale/serve.json` is where a guest link becomes reachable from the
public internet, and JSON has no comments — so the reasoning for its shape
lives here, next to the assertions that hold it.

WHY A SEPARATE PORT. Tailscale Funnel permits 443, 8443 and 10000. The
obvious move is to funnel 443, which is already proxying `web:80` — and it is
the wrong one twice over:

  * :443 is THE PHONE PATH. This repo has taken the phone down twice through
    changes to this container (a single-file bind mount that would not
    re-mount after an edit, 2026-08-05; a recreate that wiped tailnet auth and
    the serve config). Turning the operator's own route into the public one
    means every future change to public exposure is a change to the surface
    he depends on daily.
  * Turning Funnel OFF should be deleting one key, not editing the route the
    house uses. On :10000 the two concerns are separable by construction.

:8443 is ntfy's and stays private — a public push endpoint is a spam relay
with a hostname.

WHY THIS IS SAFE TO POINT AT `web:80`. It is the same origin the tailnet
already reaches, so the wall is `auth_middleware`, not the network: no token
is 401, an admin token is the operator, and a `novaguest_` token is a guest
clamped to five routes (test_guest_auth_matrix.py proves each of those over
the real middleware stack). Funnel traffic arrives via the tailscale
container, so nginx's `X-Real-IP` is that container's compose address and
`_is_local` is False — the trusted-localhost path is unreachable from the
internet without anyone having to remember to disable it.

THE STANDING TRAP, restated because it has cost real downtime: this container
is never recreated by automation. Applying a serve-config change means poking
the running tailscaled, not `docker compose up -d tailscale`, and the config
directory is mounted as a DIRECTORY — a single-file bind resolves to an inode
at container-create time, so editing this file would break the mount.
"""

import json
import sys
from pathlib import Path

FAILURES: list[str] = []
#: The repo root is mounted at /app/project in the backend container
#: (test_compose_contract.py reads it the same way). Not derived from
#: __file__: this suite must fail loudly if the mount moves rather than
#: quietly find nothing to check.
CONFIG = Path("/app/project/tailscale/serve.json")
FUNNEL_PORTS = {"443", "8443", "10000"}     # what tailscale actually permits


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def main() -> int:
    if not CONFIG.exists():
        # The repo root is mounted at /app in the backend container; if that
        # ever stops being true this suite must say so rather than pass by
        # finding nothing to check.
        print(f"FAILED: {CONFIG} not found — this suite checks a file it "
              f"could not read, which is not a pass")
        return 1
    cfg = json.loads(CONFIG.read_text())

    print("1. the funnel exists and names exactly one port")
    funnel = cfg.get("AllowFunnel") or {}
    check("AllowFunnel is declared", bool(funnel), str(funnel))
    ports = {k.rsplit(":", 1)[-1] for k in funnel}
    check("it publishes exactly one port", len(ports) == 1, str(ports))
    check("that port is one tailscale allows", ports <= FUNNEL_PORTS, str(ports))
    check("it is 10000, not the phone's 443", ports == {"10000"}, str(ports))
    check("every funnelled key is enabled (no decorative false)",
          all(v is True for v in funnel.values()), str(funnel))

    print("2. the routes the household uses stay private")
    check("the phone path :443 is NOT funnelled",
          not any(k.endswith(":443") for k in funnel), str(list(funnel)))
    check("ntfy :8443 is NOT funnelled — a public push endpoint is a relay",
          not any(k.endswith(":8443") for k in funnel), str(list(funnel)))
    check("Home Assistant :8123 is NOT funnelled",
          not any(k.endswith(":8123") for k in funnel), str(list(funnel)))

    print("3. the funnelled port actually serves the app")
    web = cfg.get("Web") or {}
    key = next(iter(funnel))
    handler = ((web.get(key) or {}).get("Handlers") or {}).get("/") or {}
    check("the funnelled host:port has a Web handler", bool(handler), str(web.keys()))
    check("...proxying the one-origin web service, where auth lives",
          handler.get("Proxy") == "http://web:80", str(handler))
    check("...and its TCP entry terminates TLS",
          (cfg.get("TCP") or {}).get("10000", {}).get("HTTPS") is True,
          str(cfg.get("TCP")))

    print("4. nothing else regressed")
    check(":443 still proxies web:80 (the phone path)",
          (((web.get("${TS_CERT_DOMAIN}:443") or {}).get("Handlers") or {})
           .get("/") or {}).get("Proxy") == "http://web:80")
    check(":8123 is still a TCP forward, not an HTTP proxy",
          (cfg.get("TCP") or {}).get("8123", {}).get("TCPForward")
          == "home-assistant:8123", str(cfg.get("TCP", {}).get("8123")))

    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:6]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
