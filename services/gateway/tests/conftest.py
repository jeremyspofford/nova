"""Fixtures for the DB-backed gateway suites.

Every gateway concern that touches postgres (backend_config, probes) needs
a real one: TEST_DATABASE_URL, same contract as Task 1's migration test.
Unset means skip with a stated reason — never a pass that proved nothing.
"""

from __future__ import annotations

import os

import asyncpg
import pytest
from httpx import ASGITransport, AsyncClient

from app import backends, db
from app.main import MIGRATIONS_DIR, app
from app.migrations_runner import run_migrations

TEST_DSN = os.environ.get("TEST_DATABASE_URL", "")
SKIP_REASON = "TEST_DATABASE_URL not set — no dockerized postgres available for this run"
requires_db = pytest.mark.skipif(not TEST_DSN, reason=SKIP_REASON)

SERVICE_TOKEN = "test-service-token"
BASE_URL = "http://test"

# The hub `hub_machine` describes: synthetic, the repo is public.
HUB_GPU_UUID = "GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"
HUB_GPU = f"gpu:cuda:{HUB_GPU_UUID}"
HUB_CPU = "cpu:12th-gen-intel-core-i9-12900k|24c|31g"

_TABLES = (
    "routes",
    "provider_walls",
    "usage_events",
    "spend_caps",
    "provider_prices",
    "probes",
    # S40 (migration 009): before `providers`, whose rows they hang off —
    # left out, the suite's rebuild would keep an FK-less `engines` table.
    "engine_models",
    "engines",
    "providers",
)

_schema_built = False


async def _build_schema() -> None:
    """Drop anything this suite owns, then migrate from empty."""
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(f"DROP TABLE IF EXISTS {', '.join(_TABLES)} CASCADE")
        await conn.execute("DROP TABLE IF EXISTS schema_migrations")
    finally:
        await conn.close()
    await run_migrations(TEST_DSN, MIGRATIONS_DIR)


@pytest.fixture
async def pool(monkeypatch):
    """A live pool over a freshly truncated schema, with the default
    backend_config row already in place (mirrors what lifespan does on a
    real startup)."""
    global _schema_built
    monkeypatch.setenv("DATABASE_URL", TEST_DSN)
    if not _schema_built:
        await _build_schema()
        _schema_built = True
    p = await db.init_pool()
    await p.execute(f"TRUNCATE {', '.join(_TABLES)} RESTART IDENTITY CASCADE")
    await backends.ensure_default_row(p)
    try:
        yield p
    finally:
        await db.close_pool()


@pytest.fixture
async def client(pool, monkeypatch):
    """ASGI client with the service bearer configured (the normal state)."""
    monkeypatch.setenv("SERVICE_TOKEN", SERVICE_TOKEN)
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url=BASE_URL,
        headers={"Authorization": f"Bearer {SERVICE_TOKEN}"},
    ) as c:
        yield c


@pytest.fixture
def mount_backend():
    """Point a base URL (an OLLAMA_URL value, or a remote/cloud config's
    url) at a local ASGI fake — gateway's real outbound httpx client
    reaches it via app.state.peer_transports, with no socket anywhere."""
    from tests.fakes import StreamingASGITransport

    def _mount(url: str, fake_app) -> None:
        transports = dict(getattr(app.state, "peer_transports", {}))
        transports[url] = StreamingASGITransport(fake_app)
        app.state.peer_transports = transports

    yield _mount
    app.state.peer_transports = {}


@pytest.fixture
def mount_transport():
    """Mount a raw httpx transport at a base URL — for a peer that fails in a
    way no ASGI app can (a connection that is never accepted). Shares
    mount_backend's registry and its teardown."""

    def _mount(url: str, transport) -> None:
        transports = dict(getattr(app.state, "peer_transports", {}))
        transports[url] = transport
        app.state.peer_transports = transports

    yield _mount
    app.state.peer_transports = {}


@pytest.fixture(autouse=True)
def fresh_upstream_caches():
    """S10a's live-source caches (Hub pages and details, registry
    manifests), the Hub request budget, and every engine's cached reading
    (S40) are process-local — cleared around every test so a page one test
    fetched can never answer another's assertion, and no test starts with a
    spent budget. S40 adds ollama's /api/show answers too: they are
    content-addressed by digest and the fakes derive a digest from the tag
    name, so one test's faked capabilities would otherwise answer another's
    (the routing standby reads them)."""
    from app import engines, hf_hub, ollama_registry
    from app.adapters import ollama

    def _clear() -> None:
        hf_hub.clear()
        ollama_registry.clear()
        engines.clear_cache()
        ollama.SHOW_CACHE.clear()

    _clear()
    yield
    _clear()


@pytest.fixture(autouse=True)
def no_devices_under_the_desk(request, monkeypatch, tmp_path):
    """No test reads the hardware under the desk (S40, ruling E10): a test
    that passes because of this machine's card or CPU measures nothing. The
    hub's /proc is an empty directory, so its CPU is stated unreadable, and
    its card answers with a stated reason, never this machine's nvidia-smi.
    A test that needs a machine asks for `hub_machine`.

    tests/test_devices_vram.py tests the real reader, so its read_vram is
    left alone. Matched by file name: pytest loads these modules by their
    basename (`test_devices_vram`), never as `tests.test_devices_vram`."""
    from app import devices_vram, engines

    empty = tmp_path / "no-proc"
    empty.mkdir()
    monkeypatch.setattr(engines, "PROC_DIR", empty)
    if request.path.name == "test_devices_vram.py":
        return

    async def _no_card() -> devices_vram.Vram:
        return devices_vram.Vram(reason="the test suite reads no card")

    monkeypatch.setattr(devices_vram, "read_vram", _no_card)


@pytest.fixture
def hub_machine(monkeypatch, tmp_path):
    """The hub as a known machine (opt-in, E10): a 24-thread i9 with 31 GiB
    of RAM (HUB_CPU) and one RTX 3090 (HUB_GPU). Returns `{"reading": Vram}`:
    a test swaps the card by assigning another reading (a
    `devices_vram.parse(...)`, or a `Vram` with a reason), and changes the
    CPU by rewriting the files under `engines.PROC_DIR`."""
    from app import devices_vram, engines

    proc = tmp_path / "proc"
    proc.mkdir()
    (proc / "cpuinfo").write_text(
        "processor\t: 0\nmodel name\t: 12th Gen Intel(R) Core(TM) i9-12900K\n"
    )
    (proc / "meminfo").write_text("MemTotal:       32767128 kB\nMemAvailable: 1 kB\n")
    monkeypatch.setattr(engines, "PROC_DIR", proc)
    monkeypatch.setattr(engines, "_nproc", lambda: 24)
    card = {
        "reading": devices_vram.parse(
            f"24576, 2662, 21914, 3, {HUB_GPU_UUID}, NVIDIA GeForce RTX 3090\n"
        )
    }

    async def _read() -> devices_vram.Vram:
        return card["reading"]

    monkeypatch.setattr(devices_vram, "read_vram", _read)
    engines.clear_cache()
    return card
