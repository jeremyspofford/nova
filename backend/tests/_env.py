"""Where am I running, and is the thing this suite needs actually here?

Shared by the suites that cannot answer their question everywhere. Two kinds
of dependency, and they are different:

  * `in_sandbox()` — this stack is the sandbox boot gate, not the operator's
    install. A suite asking "do the live agent grants still match the
    snapshot?" has no meaningful answer against a fresh database, and failing
    tells nobody anything about the branch under test.

  * `reachable(url)` — a sidecar the suite needs is not in this stack. The
    sandbox runs postgres and backend only, on purpose: everything else would
    contend for the GPU, hold the operator's ntfy topic, or take a tailnet
    name.

SKIPPING IS NOT HIDING, and the distinction is the whole reason this file is
small and loud. A skipped suite is reported by `run_all.py` under its own
heading with the reason attached, it exits 77 rather than 0 so nothing reads
it as a pass, and it still RUNS in production where its question means
something. What is being avoided is a red result that does not mean "your
change is wrong" — because a gate that cries wolf is a gate everybody learns
to click past, which is worse than no gate at all.
"""

from __future__ import annotations

import os
import sys

#: `run_all.py` reads this as "skipped, with a reason", distinct from pass
#: and from fail. 77 is the conventional EX_* value for exactly this.
SKIP = 77


def in_sandbox() -> bool:
    """Is this the sandbox boot gate rather than the operator's install?

    Set by the generated override in the worktree, so it is a fact about the
    stack rather than something a test can talk itself into.
    """
    return os.environ.get("NOVA_SANDBOX") == "1"


def reachable(url: str, timeout: float = 3.0) -> bool:
    """Can this stack reach that service at all? No exceptions, ever."""
    import urllib.error
    import urllib.request
    try:
        urllib.request.urlopen(url, timeout=timeout)
        return True
    except urllib.error.HTTPError:
        return True          # it answered; the status is not the question
    except Exception:        # noqa: BLE001
        return False


def skip(reason: str) -> None:
    """Report a skip and exit. Prints to stdout so `run_all` can quote it."""
    print(f"SKIPPED: {reason}")
    sys.exit(SKIP)
