"""An allow-listed host may be anywhere except Nova herself.

    docker compose exec backend python tests/test_http_tool_egress.py

`execute_http_tool` used to gate outbound requests on the allow-listed
HOSTNAME alone — it never resolved the target. So a name approved under a
goal (manage_tool_hosts + manage_tools) that resolved to 127.0.0.1 dialled
the backend's own :8000, where `main._is_local` grants the tokenless path and
/api/v1/auth/token answers with the admin token (verified live 2026-08-05:
200, a 48-character token, no Authorization header). Tool results are never
redacted, so that body lands in model context, the SSE stream and the 30-day
`messages` rows. 169.254.169.254 and http://postgres:5432 were the same hole.

The obvious fix — `net_guard.validate_target` — would have deleted the
feature instead of fixing it: it passes only globally routable addresses, and
`router.lan` on 192.168.x.x is the canonical allow-listed host (migration
067, `_manage_tool_hosts`'s docstring, and the approval card in scopes.py all
name reaching YOUR OWN NETWORK as the point). So the LAN case below is the
regression that matters most: a guard that also refuses the router is not a
fix, it is the feature removed with extra steps.

The stack half is not stubbed anywhere it can be real. Section 3 asks the
running install where its own services live and requires every address the
auth middleware trusts to be refused here — the two cannot drift, and no
container name is written down in either place.
"""

import asyncio
import socket
import sys

sys.path.insert(0, "/app/backend")

import httpx                                                 # noqa: E402

from app import net_guard                                    # noqa: E402
from app.tools import http_executor                          # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


class resolving:
    """Pin chosen names to chosen addresses; everything else resolves for real.

    Real DNS still has to work underneath: the stack set is derived by
    resolving this install's own service names, and stubbing that out would
    test the stub.
    """

    def __init__(self, mapping: dict[str, str]):
        self.mapping = mapping
        self.real = socket.getaddrinfo

    def __enter__(self):
        real, mapping = self.real, self.mapping

        def fake(host, port, *a, **kw):
            if host in mapping:
                addr = mapping[host]
                family = socket.AF_INET6 if ":" in addr else socket.AF_INET
                sockaddr = (addr, port or 0) if family == socket.AF_INET else (addr, port or 0, 0, 0)
                return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)]
            return real(host, port, *a, **kw)

        socket.getaddrinfo = fake
        return self

    def __exit__(self, *exc):
        socket.getaddrinfo = self.real
        return False


def refuse(url: str) -> str | None:
    return asyncio.run(net_guard.validate_offstack_target(url))


# ── 1. the targets that are Nova, however they were named ──────────────────

def test_names_pointing_back_at_nova_are_refused():
    print("1. an approved name that resolves inward is refused")
    cases = [
        ("127.0.0.1", "the backend's own :8000 — the admin-token path"),
        ("127.0.0.53", "anywhere in 127.0.0.0/8, not just .1"),
        ("::1", "loopback over v6"),
        ("169.254.169.254", "cloud instance metadata"),
        ("169.254.1.1", "link-local generally, not one magic address"),
        ("0.0.0.0", "the unspecified address"),
        ("::ffff:127.0.0.1", "loopback wearing a v4-mapped v6 wrapper"),
    ]
    for addr, why in cases:
        with resolving({"router.lan": addr}):
            reason = refuse("http://router.lan/api")
        check(f"{addr} refused ({why})", reason is not None, (reason or "")[:90])


def test_the_scheme_and_the_unresolvable_still_refuse():
    print("2. the non-address refusals survive")
    check("file:// is refused", refuse("file:///etc/passwd") is not None)
    with resolving({}):
        check("an unresolvable host is a refusal, not an exception",
              (refuse("http://nx.invalid/x") or "").startswith("cannot resolve"))

    # Measured 2026-08-05: getaddrinfo answers an over-long DNS label with
    # UnicodeError from the idna codec, not gaierror, and UnicodeError is not
    # an OSError — so both policies RAISED here rather than refusing, out of
    # functions whose docstrings promise they never do. The host reaching
    # either one is a string a model chose.
    long_label = "http://" + "a" * 70 + ".example.com/x"
    for policy in (net_guard.validate_offstack_target, net_guard.validate_target):
        try:
            out = asyncio.run(policy(long_label))
            ok = (out or "").startswith("cannot resolve")
        except Exception as e:  # noqa: BLE001 — the defect under test
            ok, out = False, f"RAISED {type(e).__name__}"
        check(f"{policy.__name__} refuses an unresolvable label, never raises",
              ok, str(out)[:70])


# ── 3. the stack set, derived from the running install ─────────────────────

def test_the_stack_set_is_derived_and_covers_what_auth_trusts():
    print("3. the stack's own addresses, asked of the install itself")
    stack, nets = net_guard._resolve_stack()
    if not stack and not nets:
        print("  NOTE  no stack addresses derived — this is not running "
              "inside the compose network, so sections 3 and 4 cannot "
              "enforce here. Run it with `docker compose exec backend`.")
        return

    # THE INVARIANT: every address the auth middleware treats as this machine
    # (or as a proxy speaking for it) is refused as a tool target. These are
    # read from main, not copied, so the two cannot disagree.
    try:
        from app.main import _LOCAL_IPS, _proxy_ips
        trusted = list(_LOCAL_IPS) + list(_proxy_ips())
    except Exception as e:  # noqa: BLE001
        check("main's trusted addresses are readable", False, str(e)[:80])
        trusted = []
    for addr in trusted:
        check(f"{addr} refused — auth grants it the tokenless path",
              net_guard._offstack_reason(addr, stack, nets) is not None)

    # A peer with NO entry in the configuration — the service someone adds to
    # compose tomorrow. This is what the attached-network source is for, and
    # the reason it sits alongside the resolved names rather than instead of
    # them: neither source alone is the whole install.
    for net in nets[:1]:
        unnamed = str(net.network_address + 250)
        check(f"{unnamed} refused — an unnamed peer on the stack's network",
              unnamed not in stack
              and net_guard._offstack_reason(unnamed, stack, nets) is not None)

    # Compose peers, by the names an http_call tool would be given.
    for name in ("postgres", "backend", "searxng"):
        try:
            addr = socket.getaddrinfo(name, None, proto=socket.IPPROTO_TCP)[0][4][0]
        except OSError:
            print(f"  NOTE  {name} does not resolve here; skipped")
            continue
        check(f"{name} ({addr}) refused — it is a service of this install",
              net_guard._offstack_reason(addr, stack, nets) is not None)

    # THE SAME QUESTION WITH THE NETWORK SOURCE REMOVED. Every compose peer
    # sits inside the attached /16, so the four checks above would all still
    # pass if the name sources had silently stopped deriving anything at all
    # — a settings field renamed, `model_dump` handing back a URL type
    # instead of a str. These two are structural: postgres is named by
    # settings.database_url and `backend` is this container's own address, so
    # each pins one source on its own rather than the union.
    for name, source in (("postgres", "settings.database_url"),
                         ("backend", "this container's own address")):
        try:
            addr = socket.getaddrinfo(name, None, proto=socket.IPPROTO_TCP)[0][4][0]
        except OSError:
            print(f"  NOTE  {name} does not resolve here; skipped")
            continue
        check(f"{name} refused with the network source removed — {source}",
              net_guard._offstack_reason(addr, stack, ()) is not None, addr)


# ── 4. the regression that matters most ────────────────────────────────────

def test_the_lan_is_still_reachable():
    print("4. the LAN — the whole reason tool_host_allowlist exists")
    cases = [
        ("192.168.1.1", "router.lan, the example in _manage_tool_hosts"),
        ("192.168.86.20", "a NAS on the same LAN"),
        ("10.13.37.5", "RFC1918 /8"),
        ("172.31.255.9", "RFC1918 /12, outside this install's bridge"),
        ("100.101.120.14", "a tailnet peer (CGNAT)"),
    ]
    for addr, why in cases:
        with resolving({"router.lan": addr}):
            reason = refuse("http://router.lan/api")
        check(f"{addr} PERMITTED ({why})", reason is None, (reason or "")[:90])

    check("a public host is still permitted",
          refuse("https://api.github.com/") is None)

    # And the strict policy is untouched: this is a second, narrower guard,
    # not a loosening of the one fetch_url and mcp_client use.
    with resolving({"router.lan": "192.168.1.1"}):
        strict = asyncio.run(net_guard.validate_target("http://router.lan/api"))
    check("validate_target still refuses the LAN (the policies stay distinct)",
          strict is not None)


# ── 5. the guard is actually wired into the executor ───────────────────────

class _FakeResponse:
    status_code = 200
    text = "LAN-BODY"


class _FakeClient:
    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def request(self, method, url, headers=None, json=None):
        DIALLED.append(url)
        return _FakeResponse()


class _FakeHttpx:
    AsyncClient = _FakeClient
    HTTPError = httpx.HTTPError


DIALLED: list[str] = []


def _run_tool(url: str) -> str:
    """execute_http_tool with the allow-list satisfied and the socket faked."""
    real_allowed, real_httpx = http_executor.host_allowed, http_executor.httpx
    http_executor.host_allowed = lambda host: _true()
    http_executor.httpx = _FakeHttpx
    try:
        return asyncio.run(http_executor.execute_http_tool(
            {"name": "probe", "execution_spec": {"method": "GET", "url_template": url}}, {}))
    finally:
        http_executor.host_allowed, http_executor.httpx = real_allowed, real_httpx


async def _true():
    return True


def test_the_executor_refuses_before_it_dials():
    print("5. execute_http_tool applies the guard, and does it before dialling")
    DIALLED.clear()
    with resolving({"router.lan": "127.0.0.1"}):
        out = _run_tool("http://router.lan:8000/api/v1/auth/token")
    check("an allow-listed host on loopback is refused by the tool",
          out.startswith("Error:") and "loopback" in out, out[:110])
    check("no request was made", DIALLED == [], str(DIALLED))

    DIALLED.clear()
    with resolving({"metadata.internal": "169.254.169.254"}):
        out = _run_tool("http://metadata.internal/latest/meta-data/")
    check("cloud metadata is refused by the tool", out.startswith("Error:"), out[:110])
    check("no request was made", DIALLED == [], str(DIALLED))

    DIALLED.clear()
    with resolving({"router.lan": "192.168.1.1"}):
        out = _run_tool("http://router.lan/api/status")
    check("the LAN request still goes out and returns its body",
          out == "LAN-BODY", out[:110])
    check("the request really was dialled", DIALLED == ["http://router.lan/api/status"],
          str(DIALLED))


def main() -> int:
    for t in (test_names_pointing_back_at_nova_are_refused,
              test_the_scheme_and_the_unresolvable_still_refuse,
              test_the_stack_set_is_derived_and_covers_what_auth_trusts,
              test_the_lan_is_still_reachable,
              test_the_executor_refuses_before_it_dials):
        t()
        print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
