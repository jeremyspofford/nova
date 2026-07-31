"""The two egress verbs must not disagree about what "private" means.

    docker compose exec backend python tests/test_egress_ranges.py

`allow_internet_egress` opens 0.0.0.0/0 minus `_PRIVATE`. `allow_host_egress`
grants one address and refuses anything `_is_private` says is public. Those
are two answers to one question, and on 2026-07-31 they disagreed:

    100.64.0.0/10 (CGNAT, i.e. the whole tailnet) is `is_private=False`

so the host verb refused a single tailnet peer as "not private" and pointed
the operator at the blanket verb — which then handed over all nine, while its
approval card said "your LAN and the Nova stack stay blocked". Measured from a
policed pod at the time: the Nova API answered 401 and ntfy answered 200.

The invariant below is what makes that unrepresentable. It is not a list of
ranges someone has to remember to update — it asks `ipaddress` about every
address the host verb would accept and requires the internet verb to already
exclude it. A new special-purpose range added to Python fails this test
before it can become a hole.
"""

import ipaddress
import sys

sys.path.insert(0, "/app/backend")

from app import workloads                                    # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _excluded(addr: str) -> bool:
    """Is this address inside the internet verb's except-set?"""
    ip = ipaddress.ip_address(addr)
    return any(ip in ipaddress.ip_network(c) for c in workloads._PRIVATE)


def test_the_two_verbs_agree():
    """THE INVARIANT: nothing the host verb calls private is reachable
    through the internet verb. Enumerated from ipaddress, not from a list."""
    print("1. every not-globally-routable address is excluded from `internet`")
    probes = [
        ("100.101.120.14", "a tailnet peer (CGNAT) — the one that broke"),
        ("100.64.0.1",     "CGNAT lower bound"),
        ("100.127.255.254", "CGNAT upper bound"),
        ("10.0.0.5",       "RFC1918 /8"),
        ("172.18.0.11",    "the docker bridge — nova-postgres lives here"),
        ("192.168.1.10",   "RFC1918 /16, the LAN"),
        ("169.254.169.254", "cloud metadata"),
        ("127.0.0.1",      "loopback"),
        ("198.18.0.1",     "benchmarking"),
        ("240.0.0.1",      "reserved"),
    ]
    for addr, why in probes:
        net = ipaddress.ip_network(f"{addr}/32")
        if net.is_global:
            continue                    # only non-global addresses are in scope
        check(f"{addr} excluded from the internet grant ({why})",
              _excluded(addr))
        check(f"{addr} accepted by allow_host_egress ({why})",
              workloads._is_private(f"{addr}/32"))


def test_public_addresses_still_refused_by_host():
    """The host verb must stay unable to reach the internet by another name."""
    print("2. `host` still refuses public addresses")
    for addr, why in [("8.8.8.8", "public resolver"),
                      ("140.82.121.4", "github"),
                      ("1.1.1.1", "public resolver")]:
        check(f"{addr} refused by allow_host_egress ({why})",
              not workloads._is_private(f"{addr}/32"), why)
        check(f"{addr} NOT excluded from the internet grant ({why})",
              not _excluded(addr), why)


def test_every_listed_range_is_actually_non_global():
    """No entry may quietly blackhole real internet the operator asked for."""
    print("3. every range in _PRIVATE is genuinely not globally routable")
    for cidr in workloads._PRIVATE:
        net = ipaddress.ip_network(cidr)
        check(f"{cidr} is not globally routable", not net.is_global, cidr)


def main() -> int:
    for t in (test_the_two_verbs_agree,
              test_public_addresses_still_refused_by_host,
              test_every_listed_range_is_actually_non_global):
        t()
        print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
