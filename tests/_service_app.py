"""Import a specific Nova service's `app.*` package in isolation.

Every backend service has a top-level package literally named `app`
(orchestrator/app, cortex/app, memory-service/app, …) with overlapping
submodule names (app.db, app.config, app.main). Importing two services' `app`
in one pytest session collides on sys.modules — and because orchestrator/app is
a namespace package while cortex/app is a regular one, the regular package
silently shadows the namespace whenever both dirs are on sys.path.

`service_app(name)` gives a test the RIGHT service's app package for the
duration of a `with` block, then fully restores sys.path and sys.modules so the
next test (same or different service) starts clean. Use it for any test that
imports service code directly rather than hitting the HTTP API.

    with service_app("orchestrator") as import_module:
        db = import_module("app.db")
        idem = import_module("app.tool_idempotency")
"""
from __future__ import annotations

import contextlib
import importlib
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Every dir that ships a top-level `app` package. Used to strip *other*
# services off sys.path so their `app` can't shadow or merge with the target's.
_SERVICE_DIRS = {
    "orchestrator", "cortex", "memory-service", "chat-api", "recovery",
    "knowledge-worker", "voice-service", "intel-worker", "browser-worker",
}
_EXTRA_PATHS = ("nova-contracts", "nova-worker-common")


@contextlib.contextmanager
def service_app(service: str):
    """Yield importlib.import_module with only `service`'s `app` resolvable."""
    if service not in _SERVICE_DIRS:
        raise ValueError(f"unknown service {service!r}")

    root = str(REPO / service)
    extras = [str(REPO / p) for p in _EXTRA_PATHS]
    other_roots = {str(REPO / s) for s in _SERVICE_DIRS if s != service}

    saved_path = list(sys.path)
    saved_mods = {k: v for k, v in sys.modules.items() if k == "app" or k.startswith("app.")}

    # Purge any cached `app` so the next import re-resolves against our path.
    for k in list(sys.modules):
        if k == "app" or k.startswith("app."):
            del sys.modules[k]

    # Make ONLY this service provide `app`.
    sys.path[:] = [p for p in sys.path if p not in other_roots]
    for p in [root, *extras]:
        if p not in sys.path:
            sys.path.insert(0, p)

    try:
        yield importlib.import_module
    finally:
        sys.path[:] = saved_path
        for k in list(sys.modules):
            if k == "app" or k.startswith("app."):
                del sys.modules[k]
        sys.modules.update(saved_mods)
