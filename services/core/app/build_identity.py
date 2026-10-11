"""Which build this process is (S32): the commit and the content hash of the
source the image was built from.

The Dockerfile bakes both into the image as ENV (NOVA_BUILD_SHA,
NOVA_CONTENT_HASH) from build args ./install passes. Read on every call, never
cached. A value that is not exactly a full git object id (40 or 64 lowercase
hex) is reported as None: an empty arg, "unknown", a short SHA or a padded
string must never read as a build. One copy per service, since every service
has its own top-level `app` package.
"""

from __future__ import annotations

import os
import re

_FULL_OBJECT_ID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")


def _object_id(var: str) -> str | None:
    value = os.environ.get(var, "")
    return value if _FULL_OBJECT_ID.fullmatch(value) else None


def build_identity() -> dict[str, str | None]:
    return {
        "build_sha": _object_id("NOVA_BUILD_SHA"),
        "content_hash": _object_id("NOVA_CONTENT_HASH"),
    }
