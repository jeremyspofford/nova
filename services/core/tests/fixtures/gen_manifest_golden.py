"""Write apps/novad/internal/install/testdata/manifest_golden.json — what
core's own signer makes of a build, for novad's Go suite to read back.

The golden file is the manifest's contract between the two languages (S42b
P19), the way envelope_vectors.json is the command envelope's:

  * apps/novad/internal/install/manifest_golden_test.go serves the golden
    response to CheckManifest: its signature must be trusted, and one changed
    byte in the manifest must not be;
  * services/core/tests/test_agent_dist.py builds the document again here,
    through agent_dist.signed_manifest, and fails when the committed file is
    stale — so a change to what core signs cannot pass without the Go side
    being run against it.

When that Python test goes red, core's manifest moved. Regenerate with

    cd services/core && uv run python tests/fixtures/gen_manifest_golden.py

and run novad's Go suite: it is the Go test that says whether the agent
still trusts what core now signs. Never regenerate to quiet the Go side.

The signing key is a THROWAWAY test key from a fixed, legible seed — never
core's real key, which is generated per install and lives in the
core_signing_key table. It reaches the real signer by standing in for
devices.signing_key for this one call. The build is six fake files laid out
as agent-dist writes one, so no hash here is a real build's.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
import tempfile
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app import agent_dist, devices  # noqa: E402  (after the path insert, deliberately)

# Exactly 32 bytes, an ed25519 seed. A test key: it signs this fixture and
# nothing else.
SEED = b"nova-s42b-manifest-golden-key!!!"
GOLDEN = (
    Path(__file__).resolve().parents[4]
    / "apps"
    / "novad"
    / "internal"
    / "install"
    / "testdata"
    / "manifest_golden.json"
)
VERSION = "aaaaaaaaaaaa"
BUILT_AT = "2026-09-28T12:00:00Z"
GO = "go1.27.1"
COMMENT = (
    "Written by services/core/tests/fixtures/gen_manifest_golden.py: core's own signer "
    "(agent_dist.signed_manifest) over a fake build, with a throwaway TEST key — never "
    "core's real key. manifest_golden_test.go holds novad's CheckManifest to it; "
    "test_agent_dist.py fails when it is stale. Do not edit by hand."
)


def fixture_key() -> ed25519.Ed25519PrivateKey:
    if len(SEED) != 32:
        raise ValueError(f"the seed must be 32 bytes, got {len(SEED)}")
    return ed25519.Ed25519PrivateKey.from_private_bytes(SEED)


def _lay_out(root: Path) -> None:
    """Six fake files, their manifest and the current pointer — agent-dist's
    layout (deploy/agent-dist/build.sh), which agent_dist.current() reads."""
    build = root / VERSION
    build.mkdir()
    files = {}
    for goos, arch in agent_dist.TARGETS:
        name = agent_dist.file_name(goos, arch)
        body = f"novad for {goos}/{arch} - a test fixture, not a build\n".encode()
        (build / name).write_bytes(body)
        files[agent_dist.file_key(goos, arch)] = {
            "name": name,
            "sha256": hashlib.sha256(body).hexdigest(),
            "size": len(body),
        }
    manifest = {"v": 1, "version": VERSION, "built_at": BUILT_AT, "go": GO, "files": files}
    (build / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (root / "current").write_text(VERSION + "\n", encoding="utf-8")


async def _fixture_signing_key(_pool) -> ed25519.Ed25519PrivateKey:
    return fixture_key()


async def golden_document() -> dict:
    """The golden document, made by the real signer over the fake build."""
    with tempfile.TemporaryDirectory() as tmp, pytest.MonkeyPatch.context() as patch:
        root = Path(tmp)
        _lay_out(root)
        patch.setenv(agent_dist.DIST_DIR_ENV, str(root))
        patch.setattr(devices, "signing_key", _fixture_signing_key)
        response = await agent_dist.signed_manifest(None)
    return {
        "_comment": COMMENT,
        "public_key_hex": fixture_key().public_key().public_bytes_raw().hex(),
        "response": response,
    }


def render(document: dict) -> str:
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> None:
    GOLDEN.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN.write_text(render(asyncio.run(golden_document())), encoding="utf-8")
    print(f"wrote {GOLDEN.relative_to(GOLDEN.parents[5])}")


if __name__ == "__main__":
    main()
