# Bundle Ollama by Default Implementation Plan

> **SUPERSEDED (2026-07-03):** Bundled inference returned in a different shape — four
> compose-profile services (`inference-ollama`, `inference-vllm`, `inference-sglang`,
> `inference-llamacpp`) with a `docker-compose.gpu.yml` overlay, managed by the recovery
> service (Settings → Local Inference). The `local-ollama` profile described below never
> shipped in this form. See `docker-compose.yml` and
> `website/src/content/docs/nova/docs/inference-backends.md` for the current design.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Nova with a bundled Ollama service that starts by default in `hybrid` and `local-only` modes (cloud-only mode skips it entirely), so a fresh `make dev` runs the full agent pipeline against local AI without any external setup — and users who don't want local inference don't pay for the image pull.

**Architecture:** Introduce a single user-facing inference mode (`NOVA_INFERENCE_MODE` ∈ `{hybrid, local-only, cloud-only}`) that `scripts/setup.sh` prompts for on first run and translates into two derived `.env` values: `COMPOSE_PROFILES` (whether the bundled `ollama` service is in the active profile set — i.e. whether it ships and starts) and `LLM_ROUTING_STRATEGY` (how the gateway picks providers). The existing `profiles: ["local-ollama"]` gate on the `ollama` service stays — it is the mechanism that makes "don't ship" work for cloud-only mode. Strip the brittle `auto`/`host` URL probe in `llm-gateway/app/config.py` since the bundled service is reachable at the stable internal hostname `http://ollama:11434`. `llm-gateway`'s `depends_on: ollama (healthy)` is added unconditionally — Compose silently ignores a `depends_on` whose target is profiled out, so cloud-only mode is safe.

**Mode → Behavior table:**

| Mode | `COMPOSE_PROFILES` | `LLM_ROUTING_STRATEGY` | Bundled Ollama |
|---|---|---|---|
| `local-only` | `local-ollama` | `local-only` | starts, only path |
| `hybrid` (default) | `local-ollama` | `local-first` | starts, falls back to cloud |
| `cloud-only` | (no `local-ollama`) | `cloud-only` | not pulled, not started |

**Tech Stack:** Docker Compose, Python (FastAPI + pytest), bash (`scripts/setup.sh`).

**Out of scope (handled in follow-on Plan 2):** Runtime UI for switching the inference target (mode + external URL + start/stop bundled Ollama via the recovery service). Consolidating the dual runtime config schemas (`inference.url` vs `llm.ollama_url`).

---

## File Structure

**Modify:**
- `docker-compose.yml` — Keep `profiles: ["local-ollama"]` on the `ollama` service (the gate is the mechanism that lets cloud-only mode skip the image entirely). Add `ollama: { condition: service_healthy }` to `llm-gateway`'s `depends_on` — Compose silently ignores deps for profiled-out services, so this is safe under cloud-only. Update the comment block above the `ollama:` service to describe the new mode-driven activation.
- `llm-gateway/app/config.py` — Replace the body of `_resolve_ollama_url` (lines 10-48) with a simple back-compat shim: `auto` and `host` map to the bundled URL `http://ollama:11434`; everything else passes through unchanged. Remove the `import subprocess` at the top.
- `.env.example` — Add `NOVA_INFERENCE_MODE=hybrid` plus the derived `COMPOSE_PROFILES=local-ollama` and `LLM_ROUTING_STRATEGY=local-first` so a fresh clone has a working default before anyone runs the wizard.
- `scripts/setup.sh` — Replace lines 83-107 (magic URL resolution + `USE_LOCAL_OLLAMA` profile gating) with a first-run mode-selection prompt that writes `NOVA_INFERENCE_MODE`, `COMPOSE_PROFILES`, `LLM_ROUTING_STRATEGY` to `.env`. Idempotent: if `NOVA_INFERENCE_MODE` is already set (re-run, CI, or `.env.example` baseline), the prompt is skipped. The model-pull loop now no-ops when bundled Ollama isn't in active profiles, and enforces `required: true` failures only when it does run.
- `models.yaml` — Promote `qwen2.5:1.5b` to `required: true` (only enforced under `local-only`/`hybrid`). Remove the "comment out all chat models" comment — the new mode mechanism makes that decision explicit.
- `tests/conftest.py` — Add a `local_ollama_active` boolean fixture (resolved from the active `COMPOSE_PROFILES`) and a `requires_local_ollama` pytest marker that skips Ollama-dependent tests cleanly under cloud-only.
- `website/src/content/docs/nova/docs/inference-backends.md` — Document the three modes; remove host-Ollama setup steps.
- `website/src/content/docs/nova/docs/quickstart.md` — Document the first-run mode prompt.

**Create:**
- `llm-gateway/tests/test_config_resolution.py` — Unit tests for `_resolve_ollama_url`.
- `tests/test_bundled_ollama.py` — Integration tests: bundled Ollama service is in active compose, reachable from llm-gateway, gateway `/complete` round-trips against it (skipped under cloud-only via the marker).
- `tests/test_inference_modes.py` — Mode-selection tests: setup.sh writes the right `.env` values for each of the 3 modes; cloud-only mode does not pull or start the `ollama` service.

**Existing tests that must continue to pass:**
- `tests/test_inference_backends.py` — Hardware detection, vLLM provider registration, gateway inflight counter.
- `tests/test_llm_gateway.py` — Gateway behavior.
- `tests/test_health_cascade.py` — All services healthy together.
- `tests/test_health.py` — Per-service health endpoints.

---

## Tasks

### Task 1: Unit test the simplified URL resolver

**Files:**
- Create: `llm-gateway/tests/test_config_resolution.py`

- [ ] **Step 1: Ensure the llm-gateway test directory exists (idempotent)**

```bash
mkdir -p llm-gateway/tests && touch llm-gateway/tests/__init__.py
git status llm-gateway/tests/__init__.py
```

If `git status` shows `__init__.py` as untracked, include it in the final commit; if it was already tracked or already empty, nothing to add.

- [ ] **Step 2: Write the failing test**

Create `llm-gateway/tests/test_config_resolution.py`:

```python
"""Unit tests for OLLAMA_BASE_URL resolution."""
from __future__ import annotations

from app.config import _resolve_ollama_url


class TestResolveOllamaUrl:
    """Verify back-compat behavior of OLLAMA_BASE_URL aliases."""

    def test_literal_url_passes_through(self):
        url = "http://192.168.0.50:11434"
        assert _resolve_ollama_url(url) == url

    def test_auto_resolves_to_bundled(self):
        """'auto' is a back-compat alias for the bundled compose service URL."""
        assert _resolve_ollama_url("auto") == "http://ollama:11434"

    def test_host_resolves_to_bundled(self):
        """'host' is a back-compat alias for the bundled compose service URL."""
        assert _resolve_ollama_url("host") == "http://ollama:11434"

    def test_external_lan_url_passes_through(self):
        """A user-provided LAN URL must pass through unchanged."""
        url = "http://192.168.12.10:11434"
        assert _resolve_ollama_url(url) == url

    def test_https_url_passes_through(self):
        """An HTTPS cloud URL must pass through unchanged."""
        url = "https://ollama.example.com"
        assert _resolve_ollama_url(url) == url

    def test_no_subprocess_calls_during_resolution(self, monkeypatch):
        """Resolution must NOT shell out — that was the old probe logic."""
        import subprocess
        called = {"count": 0}
        original_run = subprocess.run

        def fake_run(*args, **kwargs):
            called["count"] += 1
            return original_run(*args, **kwargs)

        monkeypatch.setattr(subprocess, "run", fake_run)
        _resolve_ollama_url("auto")
        _resolve_ollama_url("host")
        _resolve_ollama_url("http://ollama:11434")
        assert called["count"] == 0, "URL resolution must not call subprocess"

    def test_subprocess_no_longer_imported_by_module(self):
        """Catch a partial revert: app.config must not re-import subprocess."""
        import importlib
        import app.config as cfg_mod
        importlib.reload(cfg_mod)
        assert "subprocess" not in dir(cfg_mod), (
            "subprocess must not be a module attribute of app.config — "
            "this catches an accidental revert of the resolver simplification"
        )
```

- [ ] **Step 3: Run the test — it must fail**

```bash
cd llm-gateway && python -m pytest tests/test_config_resolution.py -v
```

Expected: FAIL on `test_no_subprocess_calls_during_resolution` (current impl calls `subprocess.run` for `auto`/`host`). Some tests may pass coincidentally if the WSL2 probe falls through to the fallback URL.

- [ ] **Step 4: Replace the implementation in `llm-gateway/app/config.py`**

Replace the existing `_resolve_ollama_url` function (lines 10-48) with:

```python
def _resolve_ollama_url(raw: str) -> str:
    """Resolve OLLAMA_BASE_URL.

    'auto' and 'host' are back-compat aliases for the bundled compose service URL.
    Any other value is treated as a literal URL and passes through unchanged.
    """
    if raw in ("auto", "host"):
        return "http://ollama:11434"
    return raw
```

Also remove the now-unused `import subprocess` line near the top of the file.

- [ ] **Step 5: Run the tests — they must pass**

```bash
cd llm-gateway && python -m pytest tests/test_config_resolution.py -v
```

Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add llm-gateway/app/config.py llm-gateway/tests/test_config_resolution.py llm-gateway/tests/__init__.py
git commit -m "refactor(llm-gateway): simplify OLLAMA_BASE_URL resolver

'auto'/'host' are now back-compat aliases for the bundled service URL.
Removes the brittle subprocess-based host probing — bundled Ollama is the default."
```

---

### Task 2: Update the compose comment block to describe mode-driven activation

The `profiles: ["local-ollama"]` gate stays — it is the mechanism that makes cloud-only mode possible (services in inactive profiles aren't pulled or started). What changes is the comment that explains how the profile gets activated: previously "set `--profile` manually," now "set by the setup wizard via `COMPOSE_PROFILES` in `.env`."

**Files:**
- Modify: `docker-compose.yml:65-67` (just the comment block above `ollama:`)

- [ ] **Step 1: Verify the current comment block**

```bash
sed -n '65,68p' docker-compose.yml
```

Expected: three comment lines starting with `# Ollama for local model serving — optional...`.

- [ ] **Step 2: Edit `docker-compose.yml`**

**Replace** lines 65-67:
```yaml
  # Ollama for local model serving — optional, use profiles: ["local-ollama"]
  # For remote Ollama (e.g. Dell PC on LAN), set OLLAMA_BASE_URL in .env instead.
  # vLLM would replace this for production (profiles: ["prod"])
```

**With:**
```yaml
  # Ollama for local model serving. Activated by the `local-ollama` profile,
  # which the setup wizard adds to COMPOSE_PROFILES in .env when the user picks
  # `hybrid` or `local-only` mode (the default). Cloud-only mode leaves the
  # profile out, so this service is not pulled or started.
  # To point Nova at an external Ollama/vLLM instance, set OLLAMA_BASE_URL in
  # .env to a literal URL (e.g. http://192.168.12.10:11434). A runtime UI for
  # swapping the inference target without a restart is coming soon.
```

Leave line 70 (`profiles: ["local-ollama"]`) **unchanged**.

- [ ] **Step 3: Verify the gate still works under both modes**

```bash
# Without the profile (cloud-only behavior), ollama should NOT be in services
COMPOSE_PROFILES="" docker compose config --services 2>&1 | grep -c '^ollama$'
# With the profile, ollama IS in services
COMPOSE_PROFILES=local-ollama docker compose config --services 2>&1 | grep -c '^ollama$'
```

Expected: `0` then `1`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "docs(compose): describe mode-driven local-ollama activation

The profile gate is now driven by NOVA_INFERENCE_MODE via setup.sh writing
COMPOSE_PROFILES into .env. Hybrid/local-only modes activate the profile;
cloud-only mode leaves it out so the service is never pulled or started."
```

---

### Task 3: Wait for Ollama to be healthy before starting the LLM gateway (when active)

This task adds `ollama` to `llm-gateway.depends_on` unconditionally. Compose's documented behavior is that `depends_on` entries pointing at services excluded by the active profile set are silently ignored — so cloud-only mode (where `local-ollama` is not active) won't fail to start.

**Files:**
- Modify: `docker-compose.yml` — `llm-gateway.depends_on` block (currently around line 85)

- [ ] **Step 1: Verify the current llm-gateway depends_on**

```bash
awk '/^  llm-gateway:/{flag=1} flag && /^  [a-z]/ && !/^  llm-gateway:/{flag=0} flag' docker-compose.yml | grep -A 5 "depends_on:"
```

Expected: only `redis: condition: service_healthy`.

- [ ] **Step 2: Edit `docker-compose.yml`**

Find the `llm-gateway:` service block. In its `depends_on:` block (the one with `redis:`), add an `ollama` entry below `redis`:

```yaml
    depends_on:
      redis:
        condition: service_healthy
      ollama:
        condition: service_healthy
```

- [ ] **Step 3: Verify the dependency is registered**

```bash
docker compose config llm-gateway 2>&1 | grep -A 6 "depends_on:" | head -10
```

Expected: both `redis` and `ollama` listed with `condition: service_healthy`.

- [ ] **Step 4: Smoke test the boot sequence in hybrid mode**

`qwen2.5:1.5b` is ~1 GB; first-run pulls can take several minutes on consumer connections. Poll instead of sleeping a fixed duration. This step assumes `.env` already has `COMPOSE_PROFILES=local-ollama` (set in Task 5 by the wizard, or seeded from `.env.example`).

```bash
make down && make dev
# Wait up to 10 minutes for the bundled Ollama to come up healthy
deadline=$(( $(date +%s) + 600 ))
until [ "$(docker compose ps ollama --format '{{.State}}|{{.Health}}' 2>/dev/null)" = "running|healthy" ]; do
  [ $(date +%s) -gt $deadline ] && { echo "TIMED OUT waiting for ollama"; exit 1; }
  sleep 5
done
echo "ollama ready."
# Wait for the starter model to actually be present
until docker compose exec -T ollama ollama list 2>/dev/null | grep -q '^qwen2.5:1.5b'; do
  [ $(date +%s) -gt $deadline ] && { echo "TIMED OUT waiting for qwen2.5:1.5b pull"; exit 1; }
  sleep 5
done
echo "qwen2.5:1.5b pulled."
docker compose ps ollama llm-gateway
```

Expected: both containers `Up` and `healthy`, and `qwen2.5:1.5b` listed in `ollama list`. If this times out, check `docker compose logs ollama` for pull errors.

- [ ] **Step 4.5: Smoke test the boot sequence in cloud-only mode**

Verify that `depends_on: ollama` does NOT block startup when the profile is inactive.

```bash
make down
COMPOSE_PROFILES="" docker compose up -d redis llm-gateway
deadline=$(( $(date +%s) + 60 ))
until [ "$(docker compose ps llm-gateway --format '{{.Health}}' 2>/dev/null)" = "healthy" ]; do
  [ $(date +%s) -gt $deadline ] && { echo "TIMED OUT waiting for llm-gateway"; docker compose ps; exit 1; }
  sleep 2
done
docker compose ps llm-gateway ollama 2>&1 | head -10
```

Expected: `llm-gateway` reaches `healthy` quickly; `ollama` does not appear in `docker compose ps` (it was excluded by the empty profile set). Then return the stack to default state for subsequent tasks: `make down && make dev`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(compose): llm-gateway waits for ollama service health

Ensures the gateway does not start serving requests before the bundled
inference engine is ready."
```

---

### Task 4: Integration test — bundled Ollama is in the active stack and reachable (skipped under cloud-only)

**Files:**
- Modify: `tests/conftest.py` — add `local_ollama_active` fixture and a `requires_local_ollama` marker.
- Create: `tests/test_bundled_ollama.py`

- [ ] **Step 0: Add the skip marker and fixture to `tests/conftest.py`**

Read the top of the existing conftest first to find a good insertion point:

```bash
head -40 tests/conftest.py
```

Then add (near the other helper fixtures):

```python
import os

def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "requires_local_ollama: skip if the local-ollama compose profile is not active",
    )


def _local_ollama_in_profiles() -> bool:
    """True iff `local-ollama` is in the active COMPOSE_PROFILES.

    Resolution order:
    1. `COMPOSE_PROFILES` from os.environ (set by Compose-aware shells, CI, tests).
    2. The `.env` file at repo root (what `make dev` reads). pytest does not
       auto-load `.env`, so without this fallback every test marked
       `requires_local_ollama` would silently skip in normal local runs.
    """
    raw = os.environ.get("COMPOSE_PROFILES")
    if raw is None:
        from pathlib import Path
        env_path = Path(__file__).resolve().parent.parent / ".env"
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if line.startswith("COMPOSE_PROFILES="):
                    raw = line.split("=", 1)[1]
                    break
    raw = raw or ""
    return "local-ollama" in [p.strip() for p in raw.split(",") if p.strip()]


@pytest.fixture(scope="session")
def local_ollama_active() -> bool:
    return _local_ollama_in_profiles()


def pytest_collection_modifyitems(config, items):
    """Apply the skip marker globally — skip requires_local_ollama tests
    automatically under cloud-only mode."""
    if _local_ollama_in_profiles():
        return
    skip_no_ollama = pytest.mark.skip(reason="local-ollama profile is not active")
    for item in items:
        if "requires_local_ollama" in item.keywords:
            item.add_marker(skip_no_ollama)
```

- [ ] **Step 1: Look at how other integration tests use fixtures**

```bash
head -40 tests/conftest.py
grep -nE "llm_gateway|admin_headers" tests/conftest.py | head -10
```

This tells you the fixture names available (e.g. `llm_gateway: httpx.AsyncClient`).

- [ ] **Step 2: Write the integration test**

Create `tests/test_bundled_ollama.py`:

```python
"""Integration tests for the bundled Ollama service.

Verifies that:
1. The ollama service IS in the active stack when local-ollama profile is active.
2. The ollama service IS NOT in the active stack under cloud-only mode (empty profiles).
3. The llm-gateway container can resolve and reach `http://ollama:11434`.
4. A /complete call with `LLM_ROUTING_STRATEGY=local-only` is actually served by
   the bundled Ollama — not silently masked by a cloud fallback.

Tests in this module marked `requires_local_ollama` are skipped under cloud-only
mode by the marker logic in conftest.py. The cloud-only inversion test does NOT
carry that marker — it must run in every mode.
"""
from __future__ import annotations

import os
import subprocess

import httpx
import pytest


@pytest.mark.requires_local_ollama
class TestBundledOllamaCompose:
    """Compose-level checks that the bundled service ships when local-ollama is active."""

    def test_ollama_in_active_services(self):
        """With local-ollama profile active, ollama appears in compose services."""
        result = subprocess.run(
            ["docker", "compose", "config", "--services"],
            capture_output=True, text=True, check=True,
        )
        services = result.stdout.strip().splitlines()
        assert "ollama" in services, (
            f"ollama service is missing under local-ollama profile. "
            f"Got: {services}"
        )

    def test_llm_gateway_depends_on_ollama_health(self):
        """llm-gateway must wait for ollama to be healthy before starting."""
        result = subprocess.run(
            ["docker", "compose", "config", "llm-gateway"],
            capture_output=True, text=True, check=True,
        )
        assert "ollama:" in result.stdout
        # Both redis and ollama should be required-healthy
        assert result.stdout.count("condition: service_healthy") >= 2


class TestCloudOnlyExcludesOllama:
    """Verify that cloud-only mode does NOT pull or start ollama."""

    def test_ollama_excluded_under_empty_profiles(self):
        """COMPOSE_PROFILES='' must not list the ollama service."""
        env = {**os.environ, "COMPOSE_PROFILES": ""}
        result = subprocess.run(
            ["docker", "compose", "config", "--services"],
            capture_output=True, text=True, check=True, env=env,
        )
        services = result.stdout.strip().splitlines()
        assert "ollama" not in services, (
            f"ollama appeared in cloud-only services list: {services}"
        )


@pytest.fixture
async def local_only_routing(redis_client):
    """Pin the gateway to local-only routing for the duration of one test.

    Without this, /complete may silently fall back to a cloud provider when
    Ollama is slow or the model is mid-pull, causing this test to "pass for
    the wrong reason".
    """
    prev = await redis_client.get("nova:config:llm.routing_strategy")
    await redis_client.set("nova:config:llm.routing_strategy", "local-only")
    try:
        yield
    finally:
        if prev is None:
            await redis_client.delete("nova:config:llm.routing_strategy")
        else:
            await redis_client.set("nova:config:llm.routing_strategy", prev)


@pytest.mark.requires_local_ollama
class TestBundledOllamaReachability:
    """Run-time checks that the gateway can talk to the bundled service."""

    async def test_gateway_resolves_bundled_ollama(self, llm_gateway: httpx.AsyncClient):
        """/health/ready should report ollama as reachable, not 'unreachable'."""
        r = await llm_gateway.get("/health/ready")
        assert r.status_code == 200
        data = r.json()
        ollama_state = data.get("checks", {}).get("ollama", "")
        assert "unreachable" not in ollama_state, (
            f"Gateway cannot reach bundled Ollama: {ollama_state}"
        )

    async def test_gateway_uses_internal_ollama_url(self, llm_gateway: httpx.AsyncClient):
        """The gateway's resolved Ollama URL must be the internal compose hostname."""
        # Either /health/ready or a dedicated diagnostic endpoint exposes the resolved URL.
        # If neither does, fall back to inspecting Settings via a debug endpoint.
        r = await llm_gateway.get("/health/ready")
        body = r.json()
        # The 'ollama' check string is set in health.py to include the URL it probed.
        # If the format differs, adjust this assertion to match.
        url_hint = str(body.get("checks", {}).get("ollama", ""))
        # Accept any of the canonical bundled forms; reject host.docker.internal
        assert "host.docker.internal" not in url_hint, (
            f"Gateway is still resolving to host.docker.internal — bundled fix incomplete. Got: {url_hint}"
        )

    async def test_gateway_complete_actually_served_by_ollama(
        self, llm_gateway: httpx.AsyncClient, local_only_routing
    ):
        """A /complete call under local-only routing must succeed — proving the
        bundled path works end-to-end without cloud fallback."""
        # Pre-pull the model to avoid first-run pull races. Idempotent.
        subprocess.run(
            ["docker", "compose", "exec", "-T", "ollama", "ollama", "pull", "qwen2.5:1.5b"],
            check=False, timeout=600,
        )
        r = await llm_gateway.post(
            "/complete",
            json={
                "model": "qwen2.5:1.5b",
                "messages": [
                    {"role": "user", "content": "Reply with exactly the word: OK"}
                ],
                "max_tokens": 10,
            },
            timeout=300.0,
        )
        assert r.status_code == 200, (
            f"complete returned {r.status_code} under local-only routing — "
            f"bundled Ollama path is broken. Body: {r.text[:300]}"
        )
        body = r.json()
        # Under local-only, success here means Ollama served the call (no fallback was tried).
        assert body.get("content"), "Expected non-empty completion content"
        # Pricing should be zero for local inference (no per-token cost).
        cost = body.get("cost_usd", 0)
        assert cost == 0 or cost == 0.0, (
            f"Non-zero cost ({cost}) under local-only routing suggests a cloud "
            f"provider served this request — bundled Ollama path was bypassed."
        )
```

Note: this test depends on a `redis_client` fixture in `tests/conftest.py`. If no such fixture exists yet, add one (or use an in-test `redis.asyncio.from_url(...)` connection scoped to the orchestrator's Redis db 1, where `nova:config:*` lives).

- [ ] **Step 3: Run the new integration test**

The test pre-pulls the model itself, so no need to sleep first.

```bash
make dev   # if not already running
# Wait for ollama service to be healthy before invoking pytest
deadline=$(( $(date +%s) + 600 ))
until [ "$(docker compose ps ollama --format '{{.Health}}' 2>/dev/null)" = "healthy" ]; do
  [ $(date +%s) -gt $deadline ] && { echo "TIMED OUT waiting for ollama"; exit 1; }
  sleep 5
done
NOVA_TEST_BASE_URL=http://localhost python -m pytest tests/test_bundled_ollama.py -v
```

Expected under hybrid: 6 passed (2 compose checks marked `requires_local_ollama` + 1 cloud-only inversion test always running + 3 reachability checks marked `requires_local_ollama`). Under cloud-only: 1 passed (just the cloud-only inversion), 5 skipped.

- [ ] **Step 4: Commit**

```bash
git add tests/test_bundled_ollama.py
git commit -m "test(integration): verify bundled Ollama starts and is reachable from gateway

Covers compose-level service registration and runtime /complete round-trip
through the bundled inference engine."
```

---

### Task 5: First-run mode wizard in `scripts/setup.sh`

This task replaces the host-Ollama probing logic with a first-run mode-selection prompt and idempotent `.env` mutation.

**Files:**
- Modify: `scripts/setup.sh:83-107` (delete the URL resolver + `USE_LOCAL_*` gating)
- Modify: `scripts/setup.sh` (add mode wizard near the top of execution, after `.env` is loaded but before any compose / model-pull work)
- Delete: `scripts/resolve-ollama-url.sh` (orphaned)

- [ ] **Step 1: Verify the current branching logic**

```bash
sed -n '83,108p' scripts/setup.sh
```

Confirms the magic-URL resolution and `USE_LOCAL_OLLAMA` profile-based gating that we're replacing.

- [ ] **Step 2: Add helpers and the test fast-path flag**

Near the top of `scripts/setup.sh` (after the existing `set -euo pipefail` and `SCRIPT_DIR`), add (a) a `--derive-mode-only` arg parser used by Task 6.5's tests, and (b) a helper that updates a key in `.env` without duplicating it:

```bash
# ── Test fast-path: --derive-mode-only exits after the env-derivation block,
#    used by tests/test_inference_modes.py to verify mode→env mapping
#    without pulling models or starting Docker.
DERIVE_MODE_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --derive-mode-only) DERIVE_MODE_ONLY=true ;;
  esac
done
```

Then the `.env` mutation helper:

```bash
# Idempotent: replace the line setting KEY=... in .env, or append it if absent.
# Comments and other lines are preserved.
upsert_env() {
  local key="$1"
  local value="$2"
  local file="${ENV_FILE:-.env}"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    # macOS/BSD sed needs -i ''; GNU sed needs -i. Use a temp file for portability.
    local tmp; tmp=$(mktemp)
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$file" > "$tmp"
    mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# Add or remove a single token from a comma-separated list in COMPOSE_PROFILES.
# Preserves any other tokens already present.
compose_profiles_set() {
  local action="$1"   # add | remove
  local token="$2"
  local current; current=$(grep -m1 '^COMPOSE_PROFILES=' "${ENV_FILE:-.env}" 2>/dev/null | cut -d= -f2- || true)
  # Split, dedupe, then act
  local IFS=','
  local -a parts=()
  for p in $current; do p=$(echo "$p" | xargs); [ -n "$p" ] && parts+=("$p"); done
  local out=()
  local found=false
  for p in "${parts[@]}"; do
    if [ "$p" = "$token" ]; then found=true; [ "$action" = "remove" ] && continue; fi
    out+=("$p")
  done
  if [ "$action" = "add" ] && [ "$found" = false ]; then out+=("$token"); fi
  upsert_env COMPOSE_PROFILES "$(IFS=,; echo "${out[*]}")"
}
```

- [ ] **Step 3: Add the mode wizard logic**

Replace lines 83-107 (the URL resolver + `USE_LOCAL_*` block) with:

```bash
# ── Inference mode selection ─────────────────────────────────────────────────
# NOVA_INFERENCE_MODE is the user-facing knob: hybrid | local-only | cloud-only.
# It derives COMPOSE_PROFILES (whether to ship+start bundled Ollama) and
# LLM_ROUTING_STRATEGY (how the gateway picks providers). Settings UI can
# change this later; setup.sh asks once if it's not already set.

if [ -z "${NOVA_INFERENCE_MODE:-}" ] && [ -t 0 ]; then
  # Interactive first-run prompt
  echo ""
  echo "Nova can run with local AI, cloud AI, or both."
  echo ""
  echo "  [1] hybrid     — bundle Ollama for local AI, fall back to cloud (recommended)"
  echo "  [2] local-only — bundle Ollama, never use cloud (privacy/offline-friendly)"
  echo "  [3] cloud-only — no bundled Ollama, only use cloud APIs (lighter setup)"
  echo ""
  echo "You can change this anytime in Settings → AI & Models."
  printf "Choice [1/2/3] (default 1): "
  read -r choice
  case "${choice:-1}" in
    2) NOVA_INFERENCE_MODE=local-only ;;
    3) NOVA_INFERENCE_MODE=cloud-only ;;
    *) NOVA_INFERENCE_MODE=hybrid ;;
  esac
elif [ -z "${NOVA_INFERENCE_MODE:-}" ]; then
  # Non-interactive (CI, automation): default to hybrid
  NOVA_INFERENCE_MODE=hybrid
fi

# Validate
case "$NOVA_INFERENCE_MODE" in
  hybrid|local-only|cloud-only) ;;
  *) echo "ERROR: invalid NOVA_INFERENCE_MODE='$NOVA_INFERENCE_MODE'. Must be one of: hybrid, local-only, cloud-only." >&2; exit 2 ;;
esac

# Derive operational truth
case "$NOVA_INFERENCE_MODE" in
  hybrid)
    compose_profiles_set add local-ollama
    upsert_env LLM_ROUTING_STRATEGY local-first
    USE_LOCAL_OLLAMA=true
    ;;
  local-only)
    compose_profiles_set add local-ollama
    upsert_env LLM_ROUTING_STRATEGY local-only
    USE_LOCAL_OLLAMA=true
    ;;
  cloud-only)
    compose_profiles_set remove local-ollama
    upsert_env LLM_ROUTING_STRATEGY cloud-only
    USE_LOCAL_OLLAMA=false
    ;;
esac
upsert_env NOVA_INFERENCE_MODE "$NOVA_INFERENCE_MODE"

USE_LOCAL_VLLM=false
USE_LOCAL_SGLANG=false
case "${COMPOSE_PROFILES:-}" in
  *local-vllm*)    USE_LOCAL_VLLM=true ;;
esac
case "${COMPOSE_PROFILES:-}" in
  *local-sglang*)  USE_LOCAL_SGLANG=true ;;
esac

echo "  Inference mode: $NOVA_INFERENCE_MODE"

# Test fast-path exit. Must come AFTER all upsert_env calls so the test can
# observe the derived values, but BEFORE any Docker/model work below.
if [ "$DERIVE_MODE_ONLY" = "true" ]; then
  exit 0
fi
```

- [ ] **Step 4: Update the model-pull loop to no-op under cloud-only**

Find the existing model-pull loop (search for `pull_on_startup` or `ollama pull`). Wrap it in `if $USE_LOCAL_OLLAMA; then ... fi` so cloud-only skips it entirely. Inside the loop, also enforce the `required` field (this is the part promised by Task 6):

```bash
if [ "$USE_LOCAL_OLLAMA" = "true" ]; then
  # ... existing model-pull loop ...
  # For each entry, parse name and required, then:
  if ! ollama pull "$model_name"; then
    if [ "$required" = "true" ]; then
      echo "ERROR: required model '$model_name' failed to pull. Aborting setup." >&2
      exit 1
    else
      echo "WARN: optional model '$model_name' failed to pull — continuing." >&2
    fi
  fi
else
  echo "  Skipping model pulls (cloud-only mode)."
fi
```

The exact YAML-parse code to keep depends on the existing implementation — match its style (yq vs python3 vs awk).

- [ ] **Step 5: Verify the script parses cleanly**

```bash
bash -n scripts/setup.sh && echo OK
```

Expected: `OK`.

- [ ] **Step 6: Remove the now-orphaned `scripts/resolve-ollama-url.sh`**

```bash
grep -rn "resolve-ollama-url" --include="*.sh" --include="*.py" --include="*.yml" --include="Makefile" . | grep -v "^docs/plans/"
```

Expected: no references after the `setup.sh` change (occurrences in this plan document don't count). If clean:

```bash
git rm scripts/resolve-ollama-url.sh
```

- [ ] **Step 7: Smoke test all three modes (non-interactive)**

```bash
# Backup the user's current .env
cp .env .env.backup

# Hybrid mode
NOVA_INFERENCE_MODE=hybrid bash scripts/setup.sh
grep -E '^(NOVA_INFERENCE_MODE|COMPOSE_PROFILES|LLM_ROUTING_STRATEGY)=' .env
# Expected: hybrid, COMPOSE_PROFILES contains local-ollama, LLM_ROUTING_STRATEGY=local-first

# Local-only
cp .env.backup .env
NOVA_INFERENCE_MODE=local-only bash scripts/setup.sh
grep -E '^(NOVA_INFERENCE_MODE|COMPOSE_PROFILES|LLM_ROUTING_STRATEGY)=' .env
# Expected: local-only, COMPOSE_PROFILES contains local-ollama, LLM_ROUTING_STRATEGY=local-only

# Cloud-only
cp .env.backup .env
NOVA_INFERENCE_MODE=cloud-only bash scripts/setup.sh
grep -E '^(NOVA_INFERENCE_MODE|COMPOSE_PROFILES|LLM_ROUTING_STRATEGY)=' .env
# Expected: cloud-only, COMPOSE_PROFILES does NOT contain local-ollama, LLM_ROUTING_STRATEGY=cloud-only

# Re-run idempotency check
NOVA_INFERENCE_MODE=hybrid bash scripts/setup.sh
NOVA_INFERENCE_MODE=hybrid bash scripts/setup.sh
grep -c "^NOVA_INFERENCE_MODE=" .env
# Expected: 1 (no duplication)

# Mode-change preserves other profiles
cp .env.backup .env
# Seed COMPOSE_PROFILES with multiple values
sed -i.bak '/^COMPOSE_PROFILES=/d' .env && echo "COMPOSE_PROFILES=local-ollama,bridges" >> .env
NOVA_INFERENCE_MODE=cloud-only bash scripts/setup.sh
grep "^COMPOSE_PROFILES=" .env
# Expected: COMPOSE_PROFILES=bridges (local-ollama removed, bridges preserved)

# Restore the user's .env
mv .env.backup .env
```

- [ ] **Step 8: Commit**

```bash
git add scripts/setup.sh scripts/resolve-ollama-url.sh
git commit -m "feat(setup): add inference-mode wizard, derive COMPOSE_PROFILES + routing

NOVA_INFERENCE_MODE (hybrid | local-only | cloud-only) is the user-facing
knob. setup.sh prompts on first run, derives COMPOSE_PROFILES (controls
whether bundled Ollama ships and starts) and LLM_ROUTING_STRATEGY
(controls how the gateway picks providers), and writes both to .env
idempotently. Re-runs with NOVA_INFERENCE_MODE already set skip the
prompt. The orphaned resolve-ollama-url.sh helper is removed."
```

---

### Task 6: Mark `qwen2.5:1.5b` as required, verify the enforcement from Task 5

The actual enforcement (parse the `required` field, fail on a `required: true` pull error) was added by Task 5. This task flips the YAML flag and confirms the failure path works end-to-end.

**Files:**
- Modify: `models.yaml`

- [ ] **Step 1: Read the current state**

```bash
grep -B1 -A4 "qwen2.5:1.5b" models.yaml
```

- [ ] **Step 2: Edit `models.yaml`**

Find the `qwen2.5:1.5b` entry. Change `required: false` to `required: true`. Also remove the comment block "If you've configured Cerebras, Groq, Anthropic API, etc. in .env, you can comment out all chat models" — under the new mode mechanism, that decision is made via `NOVA_INFERENCE_MODE`, not by editing this file.

- [ ] **Step 3: Smoke test the failure path under hybrid mode**

Inject a bogus required entry and confirm `setup.sh` exits non-zero:

```bash
cp models.yaml models.yaml.bak
yq -i '.ollama.pull_on_startup += [{"name": "definitely-not-a-real-model", "required": true, "description": "test"}]' models.yaml
NOVA_INFERENCE_MODE=hybrid bash scripts/setup.sh; echo "EXIT=$?"
mv models.yaml.bak models.yaml
```

Expected: a clear `ERROR: required model 'definitely-not-a-real-model' failed to pull` message, then `EXIT=1`.

- [ ] **Step 4: Smoke test the success path under cloud-only mode**

Confirm cloud-only mode skips the model loop entirely (so a missing optional model doesn't fail anything):

```bash
NOVA_INFERENCE_MODE=cloud-only bash scripts/setup.sh; echo "EXIT=$?"
```

Expected: `Skipping model pulls (cloud-only mode).` is printed, `EXIT=0`. Restore your previous mode after: `NOVA_INFERENCE_MODE=<your-mode> bash scripts/setup.sh`.

- [ ] **Step 5: Verify the real path works under hybrid**

```bash
NOVA_INFERENCE_MODE=hybrid bash scripts/setup.sh
docker compose exec -T ollama ollama list | grep -E "^(qwen2.5:1.5b|nomic-embed-text)"
```

Expected: both `qwen2.5:1.5b` and `nomic-embed-text` listed.

- [ ] **Step 6: Commit**

```bash
git add models.yaml
git commit -m "feat(models): qwen2.5:1.5b is required for hybrid/local-only modes

Combined with the required-enforcement added to setup.sh, this guarantees
a CPU-friendly chat model is present after setup whenever bundled Ollama
is active. Cloud-only mode skips the model loop entirely."
```

---

### Task 6.5: Integration test — each mode produces the right `.env` and the right running services

**Files:**
- Create: `tests/test_inference_modes.py`

- [ ] **Step 1: Write the failing test**

```python
"""Integration tests for the three NOVA_INFERENCE_MODE settings.

Verifies that setup.sh writes the correct .env values and that the resulting
docker-compose graph matches expectations for each mode.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


def _read_env_var(env_path: Path, key: str) -> str | None:
    """Return the value of KEY in a .env-style file, or None if absent."""
    if not env_path.exists():
        return None
    for line in env_path.read_text().splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1]
    return None


@pytest.fixture
def isolated_env(tmp_path):
    """Run setup.sh against a temporary copy of the repo's .env files."""
    env_path = tmp_path / ".env"
    if (REPO_ROOT / ".env").exists():
        shutil.copy(REPO_ROOT / ".env", env_path)
    elif (REPO_ROOT / ".env.example").exists():
        shutil.copy(REPO_ROOT / ".env.example", env_path)
    return env_path


@pytest.mark.parametrize("mode,expected_strategy,expects_local_ollama", [
    ("hybrid", "local-first", True),
    ("local-only", "local-only", True),
    ("cloud-only", "cloud-only", False),
])
def test_setup_writes_correct_env(isolated_env, mode, expected_strategy, expects_local_ollama):
    """Each mode must write the correct LLM_ROUTING_STRATEGY and COMPOSE_PROFILES."""
    env = {**os.environ, "NOVA_INFERENCE_MODE": mode, "ENV_FILE": str(isolated_env)}
    # Run only the mode-derivation portion of setup.sh — full setup is too slow for a unit test.
    # The script supports `--derive-mode-only` (added in Task 5 if not already present).
    result = subprocess.run(
        ["bash", str(REPO_ROOT / "scripts/setup.sh"), "--derive-mode-only"],
        env=env, capture_output=True, text=True, cwd=REPO_ROOT,
    )
    assert result.returncode == 0, f"setup.sh failed: {result.stderr[:500]}"

    assert _read_env_var(isolated_env, "NOVA_INFERENCE_MODE") == mode
    assert _read_env_var(isolated_env, "LLM_ROUTING_STRATEGY") == expected_strategy
    profiles = _read_env_var(isolated_env, "COMPOSE_PROFILES") or ""
    profile_set = {p.strip() for p in profiles.split(",") if p.strip()}
    if expects_local_ollama:
        assert "local-ollama" in profile_set, f"local-ollama missing from {profiles!r}"
    else:
        assert "local-ollama" not in profile_set, f"local-ollama present under {mode!r}: {profiles!r}"


def test_setup_idempotent(isolated_env):
    """Re-running setup.sh with the same mode must not duplicate keys in .env."""
    env = {**os.environ, "NOVA_INFERENCE_MODE": "hybrid", "ENV_FILE": str(isolated_env)}
    for _ in range(3):
        subprocess.run(
            ["bash", str(REPO_ROOT / "scripts/setup.sh"), "--derive-mode-only"],
            env=env, check=True, cwd=REPO_ROOT,
        )
    content = isolated_env.read_text()
    assert content.count("\nNOVA_INFERENCE_MODE=") + (
        1 if content.startswith("NOVA_INFERENCE_MODE=") else 0
    ) == 1, f"NOVA_INFERENCE_MODE duplicated in:\n{content}"
```

- [ ] **Step 2: Verify the `--derive-mode-only` flag from Task 5 is in place**

Task 5 added a `--derive-mode-only` flag and an early-exit so tests can validate mode-derivation without pulling models or hitting Docker. Confirm it's present:

```bash
grep -n "DERIVE_MODE_ONLY" scripts/setup.sh
```

Expected: at least the parser block (`for arg in "$@"`) near the top and the `if [ "$DERIVE_MODE_ONLY" = "true" ]` exit guard after the wizard derivation.

- [ ] **Step 3: Run the new tests**

```bash
python -m pytest tests/test_inference_modes.py -v
```

Expected: 4 passed (3 parametrized + 1 idempotency).

- [ ] **Step 4: Commit**

```bash
git add tests/test_inference_modes.py scripts/setup.sh
git commit -m "test(modes): cover all three NOVA_INFERENCE_MODE outcomes

Adds tests/test_inference_modes.py and a --derive-mode-only fast path in
setup.sh so the test suite can validate mode-derivation without pulling
models or starting Docker."
```

---

### Task 7: Run the full test suite and confirm no regressions

- [ ] **Step 1: Restart the stack cleanly under hybrid mode and wait for readiness**

This task assumes `.env` has `NOVA_INFERENCE_MODE=hybrid` (the default after Task 5). For cloud-only validation, see Step 5 at the end.

```bash
make down && make dev
deadline=$(( $(date +%s) + 600 ))
until [ "$(docker compose ps ollama --format '{{.Health}}' 2>/dev/null)" = "healthy" ] \
   && [ "$(docker compose ps llm-gateway --format '{{.Health}}' 2>/dev/null)" = "healthy" ] \
   && docker compose exec -T ollama ollama list 2>/dev/null | grep -q '^qwen2.5:1.5b'; do
  [ $(date +%s) -gt $deadline ] && { echo "TIMED OUT"; docker compose ps; exit 1; }
  sleep 5
done
echo "stack ready."
```

- [ ] **Step 2: Run the full integration suite**

```bash
make test
```

Expected: all tests pass. Watch specifically for `test_inference_backends.py`, `test_llm_gateway.py`, `test_health_cascade.py`, `test_bundled_ollama.py`.

- [ ] **Step 3: Confirm the gateway is actually pointed at the bundled service (not a host fallback)**

```bash
curl -s http://localhost:8001/health/ready | python3 -m json.tool
```

Expected: the `ollama` check string contains `ollama:11434` (the internal compose hostname), NOT `host.docker.internal` or `192.168.*` or any IP. If it shows a host-style URL, the resolver simplification (Task 1) didn't take effect.

- [ ] **Step 4: Submit a real pipeline task under local-only routing and confirm it completes**

Pin routing to local-only first so a successful completion is unambiguous proof the bundled path works:

```bash
docker compose exec -T redis redis-cli -n 1 SET nova:config:llm.routing_strategy local-only
SECRET=$(grep '^NOVA_ADMIN_SECRET=' .env | cut -d= -f2-)
RESP=$(curl -s -m 30 -X POST http://localhost:8000/api/v1/pipeline/tasks \
  -H "Content-Type: application/json" -H "X-Admin-Secret: $SECRET" \
  -d '{"user_input":"What is 7 times 8? Reply with just the number.","metadata":{"source":"plan-validation"}}')
TASK_ID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['task_id'])")
for i in $(seq 1 60); do
  STATUS=$(curl -s -H "X-Admin-Secret: $SECRET" "http://localhost:8000/api/v1/pipeline/tasks/$TASK_ID" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))")
  echo "[t+$((i*5))s] $STATUS"
  case "$STATUS" in completed|failed|cancelled) break;; esac
  sleep 5
done
curl -s -H "X-Admin-Secret: $SECRET" "http://localhost:8000/api/v1/pipeline/tasks/$TASK_ID" | python3 -m json.tool
# Restore default routing
docker compose exec -T redis redis-cli -n 1 SET nova:config:llm.routing_strategy local-first
```

Expected: `status: completed`, `total_cost_usd: 0.000000` (zero cost = local inference, definitive proof a cloud provider didn't serve this), `output` contains "56".

- [ ] **Step 5: Validate cloud-only mode does not start Ollama**

Switch to cloud-only and confirm bundled Ollama is not in the running stack. (Skip this step if you don't have any working cloud provider keys configured — the goal here is just to verify the COMPOSE_PROFILES gating, not to actually run an agent task under cloud-only.)

```bash
make down
NOVA_INFERENCE_MODE=cloud-only bash scripts/setup.sh
make dev
sleep 10
docker compose ps ollama 2>&1 | head -3
docker compose ps llm-gateway --format '{{.Health}}'
```

Expected: `ollama` does not appear in `docker compose ps` (only services from active profiles do), and `llm-gateway` reports `healthy`. Then return to your previous mode: `make down && NOVA_INFERENCE_MODE=hybrid bash scripts/setup.sh && make dev`.

- [ ] **Step 6: If everything passes, no commit needed**

This task is a verification gate, not a code change. If any step fails, return to the relevant earlier task and fix the root cause; do not paper over with config tweaks.

---

### Task 8: Update website docs to reflect the new default

**Files:**
- Modify: `website/src/content/docs/nova/docs/inference-backends.md`
- Modify: `website/src/content/docs/nova/docs/quickstart.md`

- [ ] **Step 1: Read the current docs**

```bash
sed -n '1,80p' website/src/content/docs/nova/docs/inference-backends.md
```

- [ ] **Step 2: Edit `inference-backends.md`**

Add a top-level "Inference modes" section that documents the three `NOVA_INFERENCE_MODE` values (hybrid, local-only, cloud-only) — what each one ships, what each one routes through, and how to switch (re-run `setup.sh` or set `NOVA_INFERENCE_MODE` and run setup non-interactively).

Update the existing "Local Inference" / Ollama section to describe Ollama as bundled under hybrid/local-only modes. Remove host-install steps. Mention that external Ollama/vLLM targets can be configured by setting `OLLAMA_BASE_URL` in `.env` (with a "runtime UI for swapping the inference target is coming soon" note — do NOT promise a specific UI path that doesn't exist yet).

- [ ] **Step 2b: Edit `quickstart.md` (single pass)**

Two changes in one edit:
1. Remove the "install Ollama on your host" step — the new flow is `./scripts/setup.sh` → answer the mode prompt → wait for models to pull → done.
2. Show the first-run mode prompt as part of the expected setup walkthrough. Note that hybrid is the default if the user just hits enter.

- [ ] **Step 3: Build the website to verify no broken links**

```bash
cd website && npm run build
```

Expected: build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
cd /home/jeremy/workspace/nova
git add website/src/content/docs/nova/docs/inference-backends.md website/src/content/docs/nova/docs/quickstart.md
git commit -m "docs: document NOVA_INFERENCE_MODE and bundled Ollama default

Adds an inference-modes section, removes the host-install instructions,
and forward-references the upcoming dashboard UI for swapping the
inference target."
```

---

### Task 9: Add a changelog entry

**Files:**
- Create: `website/src/content/changelog/2026-04-28-bundled-ollama.md`

- [ ] **Step 1: Look at an existing changelog entry for the format**

```bash
ls website/src/content/changelog/ | tail -5
cat website/src/content/changelog/$(ls website/src/content/changelog/ | tail -1)
```

- [ ] **Step 2: Write the entry**

Match the existing frontmatter and style. Keep it user-facing, not implementation-detailed:

```markdown
---
title: Inference modes — bundled Ollama by default
date: 2026-04-28
tags: [inference, setup]
---

Nova now asks how you'd like to use it on first run, and ships sensible
defaults for each option:

- **hybrid** (default) — bundles Ollama for local AI, falls back to cloud
  providers when needed. Best of both worlds.
- **local-only** — bundles Ollama, never uses cloud. Privacy-first or
  offline-friendly.
- **cloud-only** — does not bundle Ollama at all (no image pull, no
  container). Lightest footprint, requires cloud API keys.

You can change modes at any time by re-running `./scripts/setup.sh` or
setting `NOVA_INFERENCE_MODE` and re-running non-interactively. A
dashboard UI to switch modes (and point Nova at an external Ollama /
vLLM instance like `http://192.168.x.y:11434`) without a restart is
coming soon.

**Heads-up for existing installs:** if your `.env` previously had
`OLLAMA_BASE_URL=auto` or `OLLAMA_BASE_URL=host` and you depended on the
gateway probing your host's Ollama instance (Windows/macOS native install,
remote LAN box, etc.), those values now resolve to the bundled service
(`http://ollama:11434`) instead. To keep using your host's Ollama, set
`OLLAMA_BASE_URL` to a literal URL — e.g.
`OLLAMA_BASE_URL=http://host.docker.internal:11434` for a same-host install,
or `OLLAMA_BASE_URL=http://192.168.x.y:11434` for a LAN box.
```

- [ ] **Step 3: Commit**

```bash
git add website/src/content/changelog/2026-04-28-bundled-ollama.md
git commit -m "docs(changelog): bundled Ollama default"
```

---

## Verification Checklist

After all tasks complete, the following must all be true:

- [ ] With `COMPOSE_PROFILES=local-ollama`, `docker compose config --services` lists `ollama`
- [ ] With `COMPOSE_PROFILES=""`, `docker compose config --services` does NOT list `ollama`
- [ ] `make dev` under hybrid mode brings up `ollama` and `llm-gateway` healthy within 10 minutes from a clean state
- [ ] `make dev` under cloud-only mode brings up `llm-gateway` healthy without ever attempting to pull or start `ollama`
- [ ] `tests/test_bundled_ollama.py` passes under hybrid (5 tests run + 1 cloud-only inversion test)
- [ ] `tests/test_bundled_ollama.py` skips Ollama-dependent tests under cloud-only (cloud-only inversion test still runs)
- [ ] `tests/test_inference_modes.py` passes (4 tests)
- [ ] `tests/test_inference_backends.py` still passes
- [ ] `tests/test_llm_gateway.py` still passes
- [ ] `tests/test_health_cascade.py` still passes
- [ ] `llm-gateway/tests/test_config_resolution.py` passes (7 unit tests)
- [ ] Under hybrid mode, a pipeline task ("7 times 8") submitted via `/api/v1/pipeline/tasks` with `LLM_ROUTING_STRATEGY=local-only` completes successfully with `total_cost_usd: 0.000000`
- [ ] `/health/ready` reports the gateway resolved Ollama at the internal `ollama:11434` hostname (not host.docker.internal or any IP)
- [ ] `setup.sh` exits non-zero when a `required: true` model fails to pull (under hybrid/local-only)
- [ ] `setup.sh` skips the model-pull loop under cloud-only mode
- [ ] `setup.sh` is idempotent: running it 3x with the same `NOVA_INFERENCE_MODE` produces no duplicate keys in `.env`
- [ ] `scripts/resolve-ollama-url.sh` is removed (file no longer exists)
- [ ] Website builds without errors (`cd website && npm run build`)
- [ ] Changelog entry documents all three modes plus the back-compat warning

---

## Rollback Plan

Each task is its own commit. If something breaks at runtime:

1. `git log --oneline` to find the offending commit.
2. `git revert <hash>` for the smallest revert that gets the stack back to working state.
3. The compose change (Task 2) is the only one that affects the runtime stack — reverting just that commit and `make dev` again restores the previous "Ollama is profile-gated" behavior.

The unit-test changes (Task 1), test additions (Task 4), `setup.sh` changes (Task 5), and docs (Tasks 8/9) have no runtime effect on the stack.
