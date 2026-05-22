# Tool-Use Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a re-runnable diagnostic that probes whether Nova v2's conversational agent actually uses its registered tools when prompted to, producing a per-tool 4-level outcome report (`NOT_CALLED` / `CALLED_ERROR` / `CALLED_OK` / `SIDE_EFFECT_VERIFIED`) per available model.

**Architecture:** Declarative probes + 3 generic verifier strategies + one uniform harness loop. The probe registry is data; verifiers are stateless strategy classes; the harness wires NDJSON-stream consumption + concurrent approval-grant + post-stream `task_events` extraction. Output: markdown report + sibling `results.json` + per-trial trace files.

**Tech Stack:** Python 3.x, `pytest` + `pytest-asyncio` + `httpx` + `python-dotenv` (no new deps), `uv` for ad-hoc dependency provisioning matching the existing `test-quick` make target.

**Spec:** `docs/specs/2026-05-22-tool-use-audit-spec.md` (commit `5595c8d5`, approved by spec-document-reviewer + user 2026-05-22).

---

## Test discipline note (read before starting)

The project policy is **"real services only — no mocks"** for tests of Nova's behavior. This plan honors that by drawing a deliberate line:

- **Integration tests** (the audit harness end-to-end, model discovery, MCP availability check, HTTP-based cleanups) hit the live Docker Compose stack. The pytest entry point at `tests/test_chat_tool_usage.py` is the integration anchor.
- **Pure-logic unit tests** (NDJSON parsing, outcome derivation from event records, verifier predicates against the local filesystem and against strings, render output shape) use **inline fixture data** — *not* mocks. A static dict that represents what `task_events` would return is not a mock; it's data. A string passed into `ResponseContains.verify()` is not a mock; it's the input the function takes.

The rule of thumb: **mocks substitute for services**; **fixtures supply data**. Pure functions get fixtures; HTTP-touching code gets the real stack.

---

## File structure

Files to create — all under `tests/audit_tool_use/` except the pytest entry point and `Makefile`:

| Path | Responsibility | Approx LOC |
|---|---|---|
| `tests/audit_tool_use/__init__.py` | Package marker; re-exports public types | ~10 |
| `tests/audit_tool_use/types.py` | `Outcome` enum, `Probe`/`TrialResult` dataclasses, `Verifier`/`Cleanup` ABCs | ~80 |
| `tests/audit_tool_use/env.py` | Absolute-path `.env` resolution; `NOVA_ADMIN_SECRET` override; fail-loud on missing | ~40 |
| `tests/audit_tool_use/constants.py` | Env-overridable wall-clock deadlines + run-id-prefix + paths | ~25 |
| `tests/audit_tool_use/verifiers.py` | `FileExists`, `DbContains`, `ResponseContains`, `SKIP` strategies | ~80 |
| `tests/audit_tool_use/setups.py` | `SeedFile`, `SeedMemory`, `SeedSecret`, `NoSetup` (mirror of cleanups) | ~70 |
| `tests/audit_tool_use/cleanups.py` | `DeleteFile`, `DeleteMemory`, `DeleteSecret`, `DeleteTask`, `NoCleanup` | ~70 |
| `tests/audit_tool_use/stream.py` | NDJSON line consumer + concurrent approval-grant orchestrator | ~120 |
| `tests/audit_tool_use/events.py` | `GET /api/v1/tasks/{id}/events` fetch + outcome derivation | ~70 |
| `tests/audit_tool_use/availability.py` | Builtin tool list + MCP discovery via `/api/v1/mcp/servers` | ~60 |
| `tests/audit_tool_use/models.py` | Model discovery via `GET /providers` | ~40 |
| `tests/audit_tool_use/probes.py` | The ~11 declarative probe records | ~180 |
| `tests/audit_tool_use/harness.py` | Per-(probe, model, trial) run loop wiring all the above | ~150 |
| `tests/audit_tool_use/render.py` | Markdown + JSON + traces output | ~220 |
| `tests/test_chat_tool_usage.py` | Pytest entry; orchestrates the audit; skips on services-down | ~80 |
| `tests/audit_tool_use/test_*.py` | Unit tests for parser/derivation/verifiers/render (fixture-driven) | ~400 (total) |
| `Makefile` | Add `audit-tool-use:` target | +6 lines |
| `tests/pytest.ini` | Register `audit` marker | +2 lines |

Files to modify: `Makefile` (add target), `tests/pytest.ini` (register marker). Nothing else.

---

## AC → Task mapping (for ensemble-review)

| AC | Satisfied by Task # | Verified by |
|---|---|---|
| AC-B1 | 2 | Unit + integration |
| AC-B2 | 5 | Unit + integration |
| AC-B3 | 5, 6 | Unit + integration |
| AC-B4 | 8 + 11 + 14 | Integration (audit run with cleanup) |
| AC-B5 | 9, 11 | Integration (timeout exercised in dry-run) |
| AC-B6 | 7 | Integration (MCP-absent scenario) |
| AC-B7 | 11 | Code review (task_id created per trial) |
| AC-Q1 | 7, 11 | Integration |
| AC-Q2 | 3, 6 | Unit + integration |
| AC-Q3 | 10 | Code review of probe prompts |
| AC-Q4 | 11, 13 | Integration |
| AC-Q5 | 12 | Unit (render schema) + integration |
| AC-Q6 | 8 | Unit + integration |
| AC-Q7 | 13 | Integration (services-down scenario) |
| AC-Q8 | 4, 10 | Code review of run-id prefix usage |
| AC-D1 | 12 | Unit (frontmatter schema) |
| AC-D2 | 12 | Unit (TL;DR table presence) |
| AC-D3 | 12 | Unit (finding block schema) |
| AC-D4 | 12 | Unit (traces sidecar) |
| AC-D5 | 12 | Unit (recommendation ordering) |
| AC-D6 | 12 | Unit (reproducibility block) |

---

## Tasks

### Task 1: Package scaffolding + types module

**Roles:** backend, qa

**Files:**
- Create: `tests/audit_tool_use/__init__.py`
- Create: `tests/audit_tool_use/types.py`
- Create: `tests/audit_tool_use/test_types.py`

**Why this is first:** every subsequent task depends on `Outcome` enum + `Probe`/`TrialResult` dataclasses + `Verifier`/`Cleanup` ABCs.

- [ ] **Step 1: Write the failing test**

Create `tests/audit_tool_use/test_types.py`:

```python
from audit_tool_use.types import Outcome, Probe, TrialResult, Verifier, Cleanup
from dataclasses import FrozenInstanceError
import pytest


def test_outcome_has_five_levels():
    """Outcome levels per spec section 'Approach' step 8."""
    assert Outcome.NOT_CALLED.value == "not_called"
    assert Outcome.CALLED_ERROR.value == "called_error"
    assert Outcome.CALLED_OK.value == "called_ok"
    assert Outcome.SIDE_EFFECT_VERIFIED.value == "side_effect_verified"
    assert Outcome.AUDIT_INFRA_TIMEOUT.value == "audit_infra_timeout"


def test_probe_is_frozen():
    """Probes are declarative data; mutation should error."""
    p = Probe(
        id="t",
        tool="fs.write",
        prompt_template="x",
        expected_args_subset=None,
        verifier=Verifier.SKIP,
        cleanup=Cleanup.NONE,
        tier="MUTATE",
    )
    with pytest.raises(FrozenInstanceError):
        p.id = "changed"


def test_trial_result_carries_required_fields():
    tr = TrialResult(
        probe_id="t", tool="fs.write", model="x", trial_n=0,
        outcome=Outcome.NOT_CALLED, latency_ms=0, error_msg=None,
        trace_path=None, cleanup_failed=False, run_id="abc",
    )
    assert tr.outcome is Outcome.NOT_CALLED
```

- [ ] **Step 2: Run test — expect FAIL (module doesn't exist)**

```bash
cd /home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools
uv run --with pytest pytest tests/audit_tool_use/test_types.py -v
```

Expected: `ModuleNotFoundError: No module named 'audit_tool_use'`.

- [ ] **Step 3: Implement `tests/audit_tool_use/__init__.py`**

```python
"""Tool-use audit harness — see docs/specs/2026-05-22-tool-use-audit-spec.md."""
from audit_tool_use.types import Outcome, Probe, TrialResult, Verifier, Cleanup

__all__ = ["Outcome", "Probe", "TrialResult", "Verifier", "Cleanup"]
```

- [ ] **Step 4: Implement `tests/audit_tool_use/types.py`**

```python
"""Core types for the tool-use audit. Declarative; no I/O here."""
from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal


class Outcome(str, Enum):
    """Per-trial outcome. Orthogonal to the SKIPPED axis (SKIPPED is on TrialResult.skipped_reason)."""
    NOT_CALLED = "not_called"
    CALLED_ERROR = "called_error"
    CALLED_OK = "called_ok"
    SIDE_EFFECT_VERIFIED = "side_effect_verified"
    AUDIT_INFRA_TIMEOUT = "audit_infra_timeout"


class Verifier(str, Enum):
    """Strategy sentinels; concrete verifier objects live in verifiers.py."""
    SKIP = "skip"


class Cleanup(str, Enum):
    """Sentinels; concrete cleanup objects live in cleanups.py."""
    NONE = "none"


class Setup(str, Enum):
    """Sentinels; concrete setup objects live in setups.py."""
    NONE = "none"


@dataclass(frozen=True)
class Probe:
    id: str
    tool: str                            # original dotted name, e.g. "fs.write"
    prompt_template: str                 # uses {run_id}, {token} placeholders
    expected_args_subset: dict[str, Any] | None  # reserved for future arg-validation; not consumed in v1
    verifier: Any                        # Verifier.SKIP or concrete object from verifiers.py
    setup: Any = None                    # Setup.NONE or concrete object from setups.py — runs BEFORE the probe
    cleanup: Any = None                  # Cleanup.NONE or concrete object from cleanups.py
    tier: Literal["READ", "MUTATE"] = "READ"


@dataclass
class TrialResult:
    probe_id: str
    tool: str
    model: str
    trial_n: int
    outcome: Outcome
    latency_ms: int
    error_msg: str | None
    trace_path: str | None
    cleanup_failed: bool
    run_id: str
    skipped_reason: str | None = None
    verifier_failed_reason: str | None = None
```

- [ ] **Step 5: Run test — expect PASS**

```bash
uv run --with pytest pytest tests/audit_tool_use/test_types.py -v
```

Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/audit_tool_use/__init__.py tests/audit_tool_use/types.py tests/audit_tool_use/test_types.py
git commit -m "feat(audit): scaffold audit_tool_use package — Outcome enum + Probe/TrialResult types"
```

**Satisfies (partial):** AC-Q2 (4-level + orthogonal axis structure).

---

### Task 2: `.env` loader with absolute-path resolution

**Roles:** backend

**Files:**
- Create: `tests/audit_tool_use/env.py`
- Create: `tests/audit_tool_use/test_env.py`

**Why this matters:** `tests/conftest.py:8` already uses the broken-from-worktree pattern (`os.path.dirname(__file__), ".."`). From `.worktrees/engineer-agent-actually-uses-tools/tests/`, `..` resolves to the worktree root, which has no `.env`. The audit must walk up to find a directory containing both `.env` and `docker-compose.yml` — that's the real repo root.

- [ ] **Step 1: Write failing tests**

Create `tests/audit_tool_use/test_env.py`:

```python
import os
import tempfile
from pathlib import Path
import pytest

from audit_tool_use.env import resolve_repo_root, load_admin_secret


def test_resolve_repo_root_finds_dir_with_env_and_compose(tmp_path):
    repo = tmp_path / "fake-repo"
    repo.mkdir()
    (repo / ".env").write_text("NOVA_ADMIN_SECRET=xyz\n")
    (repo / "docker-compose.yml").write_text("version: '3'\n")
    nested = repo / "a" / "b" / "c"
    nested.mkdir(parents=True)
    (nested / "marker.txt").write_text("here")
    found = resolve_repo_root(start_from=nested / "marker.txt")
    assert found == repo


def test_resolve_repo_root_raises_when_no_repo_above(tmp_path):
    with pytest.raises(RuntimeError, match="repo root"):
        resolve_repo_root(start_from=tmp_path / "nothing.txt")


def test_load_admin_secret_uses_env_override(monkeypatch, tmp_path):
    (tmp_path / ".env").write_text("NOVA_ADMIN_SECRET=from-file\n")
    (tmp_path / "docker-compose.yml").write_text("")
    monkeypatch.setenv("NOVA_ADMIN_SECRET", "from-env")
    assert load_admin_secret(repo_root=tmp_path) == "from-env"


def test_load_admin_secret_falls_back_to_env_file(monkeypatch, tmp_path):
    (tmp_path / ".env").write_text("NOVA_ADMIN_SECRET=from-file\n")
    (tmp_path / "docker-compose.yml").write_text("")
    monkeypatch.delenv("NOVA_ADMIN_SECRET", raising=False)
    assert load_admin_secret(repo_root=tmp_path) == "from-file"


def test_load_admin_secret_raises_loudly_when_missing(tmp_path, monkeypatch):
    (tmp_path / "docker-compose.yml").write_text("")
    monkeypatch.delenv("NOVA_ADMIN_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="NOVA_ADMIN_SECRET"):
        load_admin_secret(repo_root=tmp_path)
```

- [ ] **Step 2: Run — expect FAIL**

```bash
uv run --with pytest --with python-dotenv pytest tests/audit_tool_use/test_env.py -v
```

- [ ] **Step 3: Implement `tests/audit_tool_use/env.py`**

```python
"""Environment resolution for the audit. Fails loud on missing config."""
from __future__ import annotations
import os
from pathlib import Path
from dotenv import dotenv_values


def resolve_repo_root(start_from: Path | None = None) -> Path:
    """Walk up from `start_from` (or this file) looking for a directory that
    contains both `.env` and `docker-compose.yml` — the real Nova repo root.
    Worktrees don't satisfy this (no .env), so the search keeps walking past them.
    """
    here = Path(start_from or __file__).resolve()
    for candidate in [here] + list(here.parents):
        if (candidate / ".env").exists() and (candidate / "docker-compose.yml").exists():
            return candidate
    raise RuntimeError(
        f"Could not locate repo root from {here}. "
        "Expected a directory with both .env and docker-compose.yml."
    )


def load_admin_secret(repo_root: Path | None = None) -> str:
    """Return NOVA_ADMIN_SECRET. Env var wins; .env is fallback; missing → RuntimeError."""
    override = os.getenv("NOVA_ADMIN_SECRET")
    if override:
        return override
    root = repo_root or resolve_repo_root()
    env = dotenv_values(root / ".env") if (root / ".env").exists() else {}
    val = env.get("NOVA_ADMIN_SECRET")
    if not val:
        raise RuntimeError(
            "NOVA_ADMIN_SECRET not set in environment or .env. "
            "Set it before running the audit; never fall back to a default secret."
        )
    return val
```

- [ ] **Step 4: Run — expect PASS**

```bash
uv run --with pytest --with python-dotenv pytest tests/audit_tool_use/test_env.py -v
```

- [ ] **Step 5: Commit**

```bash
git add tests/audit_tool_use/env.py tests/audit_tool_use/test_env.py
git commit -m "feat(audit): absolute-path .env loader with fail-loud missing-secret behavior

Walks up from __file__ for a dir containing both .env and docker-compose.yml,
so the audit works from a worktree where only the main repo has .env."
```

**Satisfies:** AC-B1.

---

### Task 3: Verifier strategies

**Roles:** qa

**Files:**
- Create: `tests/audit_tool_use/verifiers.py`
- Create: `tests/audit_tool_use/test_verifiers.py`

- [ ] **Step 1: Write failing tests**

```python
import pytest
import tempfile
from pathlib import Path
from audit_tool_use.verifiers import FileExists, ResponseContains, DbContains, Skip
from audit_tool_use.types import Verifier


@pytest.mark.asyncio
async def test_file_exists_passes_when_file_present_with_token(tmp_path):
    p = tmp_path / "f.txt"
    p.write_text("hello TOKEN-abc world")
    v = FileExists(path=str(p), expect_content_contains="TOKEN-abc")
    ok, reason = await v.verify(context={})
    assert ok is True
    assert reason is None


@pytest.mark.asyncio
async def test_file_exists_fails_when_missing(tmp_path):
    v = FileExists(path=str(tmp_path / "nope.txt"), expect_content_contains="x")
    ok, reason = await v.verify(context={})
    assert ok is False
    assert "not found" in reason.lower()


@pytest.mark.asyncio
async def test_file_exists_fails_when_content_missing(tmp_path):
    p = tmp_path / "f.txt"
    p.write_text("nothing useful")
    v = FileExists(path=str(p), expect_content_contains="TOKEN-xyz")
    ok, reason = await v.verify(context={})
    assert ok is False
    assert "token" in reason.lower()


@pytest.mark.asyncio
async def test_response_contains_passes_when_token_present():
    v = ResponseContains(token="UUID-abc")
    ok, _ = await v.verify(context={"final_response": "I retrieved UUID-abc successfully"})
    assert ok is True


@pytest.mark.asyncio
async def test_response_contains_fails_when_token_absent():
    v = ResponseContains(token="UUID-abc")
    ok, reason = await v.verify(context={"final_response": "Sorry, I couldn't find it"})
    assert ok is False
    assert "UUID-abc" in reason


def test_skip_is_recognized_sentinel():
    assert Skip is Verifier.SKIP
```

- [ ] **Step 2: Run — expect FAIL**

```bash
uv run --with pytest --with pytest-asyncio pytest tests/audit_tool_use/test_verifiers.py -v
```

- [ ] **Step 3: Implement `tests/audit_tool_use/verifiers.py`**

```python
"""Verifier strategies — three concrete classes + a SKIP sentinel."""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import httpx
from audit_tool_use.types import Verifier

Skip = Verifier.SKIP


@dataclass(frozen=True)
class FileExists:
    """Verifies a file is on disk and contains an expected substring."""
    path: str
    expect_content_contains: str

    async def verify(self, context: dict) -> tuple[bool, str | None]:
        p = Path(self.path)
        if not p.exists():
            return False, f"file not found at {self.path}"
        body = p.read_text(errors="replace")
        if self.expect_content_contains not in body:
            return False, f"token {self.expect_content_contains!r} not present in file"
        return True, None


@dataclass(frozen=True)
class ResponseContains:
    """Verifies the model's final assistant text contains an expected token verbatim."""
    token: str

    async def verify(self, context: dict) -> tuple[bool, str | None]:
        text = context.get("final_response") or ""
        if self.token not in text:
            return False, f"token {self.token!r} not echoed in final response"
        return True, None


@dataclass(frozen=True)
class DbContains:
    """Verifies a record exists via service HTTP. No direct DB access.

    `endpoint` is a full URL; `query` is the POST body (or query-string params for GET);
    `expect_field` is a JSON path expression checked on the response.
    """
    endpoint: str
    query: dict
    expect_field: str  # e.g. "results.0.id"
    method: str = "POST"

    async def verify(self, context: dict) -> tuple[bool, str | None]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            if self.method == "POST":
                r = await client.post(self.endpoint, json=self.query, headers=context.get("admin_headers", {}))
            else:
                r = await client.get(self.endpoint, params=self.query, headers=context.get("admin_headers", {}))
        if r.status_code >= 400:
            return False, f"{self.endpoint} returned {r.status_code}: {r.text[:200]}"
        body = r.json()
        # Walk the dotted path (numerics indicate list indexing)
        node = body
        for part in self.expect_field.split("."):
            try:
                node = node[int(part)] if part.isdigit() else node[part]
            except (KeyError, IndexError, TypeError):
                return False, f"field path {self.expect_field!r} missing in response {body!r}"
        return True, None
```

- [ ] **Step 4: Run — expect PASS**

```bash
uv run --with pytest --with pytest-asyncio --with httpx pytest tests/audit_tool_use/test_verifiers.py -v
```

- [ ] **Step 5: Commit**

```bash
git add tests/audit_tool_use/verifiers.py tests/audit_tool_use/test_verifiers.py
git commit -m "feat(audit): FileExists / ResponseContains / DbContains verifier strategies + SKIP sentinel"
```

**Satisfies (partial):** AC-Q2.

---

### Task 4: Constants module (env-overridable deadlines + run-id prefix)

**Roles:** backend

**Files:**
- Create: `tests/audit_tool_use/constants.py`
- Create: `tests/audit_tool_use/test_constants.py`

**Why this matters (spec-reviewer note #1):** deadlines need to be tunable after the first dry-run; one source of truth.

- [ ] **Step 1: Write failing tests**

```python
import importlib
import pytest


def test_default_deadlines(monkeypatch):
    monkeypatch.delenv("AUDIT_READ_DEADLINE_S", raising=False)
    monkeypatch.delenv("AUDIT_MUTATE_DEADLINE_S", raising=False)
    import audit_tool_use.constants as c
    importlib.reload(c)
    assert c.READ_DEADLINE_S == 90
    assert c.MUTATE_DEADLINE_S == 120


def test_env_override(monkeypatch):
    monkeypatch.setenv("AUDIT_READ_DEADLINE_S", "30")
    monkeypatch.setenv("AUDIT_MUTATE_DEADLINE_S", "60")
    import audit_tool_use.constants as c
    importlib.reload(c)
    assert c.READ_DEADLINE_S == 30
    assert c.MUTATE_DEADLINE_S == 60


def test_run_id_prefix_format():
    import audit_tool_use.constants as c
    importlib.reload(c)
    assert c.RUN_ID_PREFIX_TEMPLATE.startswith("nova-audit-")
    assert "{run_id}" in c.RUN_ID_PREFIX_TEMPLATE
```

- [ ] **Step 2: Run — expect FAIL** → `pytest tests/audit_tool_use/test_constants.py -v`

- [ ] **Step 3: Implement `tests/audit_tool_use/constants.py`**

```python
"""Single source of truth for audit tunables. Env-overridable."""
from __future__ import annotations
import os

READ_DEADLINE_S = int(os.getenv("AUDIT_READ_DEADLINE_S", "90"))
MUTATE_DEADLINE_S = int(os.getenv("AUDIT_MUTATE_DEADLINE_S", "120"))
PER_MODEL_BUDGET_S = int(os.getenv("AUDIT_PER_MODEL_BUDGET_S", "300"))  # 5 min
TRIALS_PER_PROBE = int(os.getenv("AUDIT_TRIALS", "3"))

RUN_ID_PREFIX_TEMPLATE = "nova-audit-{run_id}-"

OUTPUT_DIR_TEMPLATE = "docs/audits/{date}-tool-use-audit"
OUTPUT_MD_TEMPLATE = "docs/audits/{date}-tool-use-audit.md"
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add tests/audit_tool_use/constants.py tests/audit_tool_use/test_constants.py
git commit -m "feat(audit): env-overridable deadlines + run-id prefix constants"
```

**Satisfies (partial):** AC-B5, AC-Q8.

---

### Task 5: NDJSON stream consumer + concurrent approval-grant orchestrator

**Roles:** backend

**Files:**
- Create: `tests/audit_tool_use/stream.py`
- Create: `tests/audit_tool_use/test_stream.py`

**Why merged:** parser and approval-grant share state (the in-flight stream); separating them would make the unit tests harder to write because the grant logic only makes sense in context of the stream.

- [ ] **Step 1: Write failing tests (use a fake async iterator — not a mock; just a coroutine yielding bytes lines)**

```python
import asyncio
import json
import pytest
from audit_tool_use.stream import parse_ndjson_lines, consume_stream_with_approval_grant


async def _async_iter(lines):
    for line in lines:
        yield line


@pytest.mark.asyncio
async def test_parses_lines_no_data_prefix():
    raw = [b'{"type":"meta","model":"x"}', b'{"text":"hi"}']
    parsed = [item async for item in parse_ndjson_lines(_async_iter(raw))]
    assert parsed[0]["type"] == "meta"
    assert parsed[1]["text"] == "hi"


@pytest.mark.asyncio
async def test_skips_blank_and_invalid_lines():
    raw = [b"", b"   ", b'{"text":"ok"}', b"not-json"]
    parsed = [item async for item in parse_ndjson_lines(_async_iter(raw))]
    assert parsed == [{"text": "ok"}]


@pytest.mark.asyncio
async def test_approval_grant_called_once_per_id_when_request_appears():
    raw = [
        b'{"type":"meta","model":"x"}',
        b'{"type":"tool_approval_request","tool_call_id":"call_1","name":"fs.write","tier":"MUTATE","args":{}}',
        b'{"type":"tool_approval_request","tool_call_id":"call_1","name":"fs.write","tier":"MUTATE","args":{}}',  # dup
        b'{"text":"done"}',
    ]
    granted: list[str] = []
    async def grant(call_id: str) -> None:
        granted.append(call_id)
    final = await consume_stream_with_approval_grant(_async_iter(raw), grant_fn=grant)
    assert granted == ["call_1"]
    assert final["text"] == "done"
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `tests/audit_tool_use/stream.py`**

```python
"""NDJSON stream consumption + concurrent approval-grant.

The agent-core stream endpoint returns text/plain NDJSON (not SSE).
MUTATE tools block 300s on capability.py:97 waiting for approval — we grant
concurrently as soon as a tool_approval_request line appears.
"""
from __future__ import annotations
import asyncio
import json
from typing import AsyncIterator, Awaitable, Callable


async def parse_ndjson_lines(
    line_iter: AsyncIterator[bytes],
) -> AsyncIterator[dict]:
    """Yield parsed JSON objects from a byte-line iterator. Skip blanks and unparseable lines."""
    async for raw in line_iter:
        line = raw.decode("utf-8", errors="replace").strip() if isinstance(raw, bytes) else raw.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            # Tolerate malformed lines; the audit infra logs them but doesn't fail
            continue


async def consume_stream_with_approval_grant(
    line_iter: AsyncIterator[bytes],
    grant_fn: Callable[[str], Awaitable[None]],
) -> dict:
    """Consume NDJSON, dispatch grant_fn for each unique tool_approval_request,
    return the final assistant-text-bearing line (or the last line seen).

    grant_fn is called at most once per tool_call_id, in a fire-and-forget task
    so it doesn't block stream consumption.
    """
    granted: set[str] = set()
    pending_grants: list[asyncio.Task] = []
    final: dict = {}
    async for event in parse_ndjson_lines(line_iter):
        if event.get("type") == "tool_approval_request":
            call_id = event.get("tool_call_id")
            if call_id and call_id not in granted:
                granted.add(call_id)
                pending_grants.append(asyncio.create_task(grant_fn(call_id)))
        elif "text" in event or event.get("type") in {"meta", "error"}:
            final = event
    # Let in-flight grants finish before returning
    if pending_grants:
        await asyncio.gather(*pending_grants, return_exceptions=True)
    return final
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add tests/audit_tool_use/stream.py tests/audit_tool_use/test_stream.py
git commit -m "feat(audit): NDJSON stream parser + concurrent approval-grant orchestrator"
```

**Satisfies:** AC-B2 (approval auto-grant), partial AC-B3 (stream half).

---

### Task 6: Outcome derivation from `task_events`

**Roles:** backend, qa

**Files:**
- Create: `tests/audit_tool_use/events.py`
- Create: `tests/audit_tool_use/test_events.py`

- [ ] **Step 1: Write failing tests** (fixture-driven — `task_events` records are static dicts)

```python
import pytest
from audit_tool_use.events import derive_outcome
from audit_tool_use.types import Outcome


def test_no_tool_call_proposed_returns_not_called():
    events = [{"event_type": "task_started"}, {"event_type": "task_completed"}]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.NOT_CALLED


def test_tool_call_proposed_then_error_returns_called_error():
    events = [
        {"event_type": "tool_call_proposed", "payload": {"name": "fs.write"}},
        {"event_type": "tool_call_error", "payload": {"name": "fs.write", "error": "boom"}},
    ]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.CALLED_ERROR


def test_tool_call_proposed_then_clean_result_returns_called_ok():
    events = [
        {"event_type": "tool_call_proposed", "payload": {"name": "fs.write"}},
        {"event_type": "tool_call_result", "payload": {"name": "fs.write", "size": 12}},
    ]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.CALLED_OK


def test_tool_call_result_with_error_key_returns_called_error():
    events = [
        {"event_type": "tool_call_proposed", "payload": {"name": "fs.write"}},
        {"event_type": "tool_call_result", "payload": {"name": "fs.write", "error": "Path outside workspace"}},
    ]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.CALLED_ERROR


def test_unrelated_tool_calls_ignored():
    events = [
        {"event_type": "tool_call_proposed", "payload": {"name": "memory.search"}},
        {"event_type": "tool_call_result", "payload": {"name": "memory.search"}},
    ]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.NOT_CALLED
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `tests/audit_tool_use/events.py`**

```python
"""Derive per-tool outcome from task_events records.

task_events stores tool names in dot-notation (original form), not the
sanitized form sent to the LLM. Compare against the original tool name.
"""
from __future__ import annotations
import httpx
from audit_tool_use.types import Outcome


def derive_outcome(events: list[dict], *, expected_tool: str) -> Outcome:
    proposed = False
    last_result: dict | None = None
    saw_error = False
    for ev in events:
        et = ev.get("event_type")
        payload = ev.get("payload") or {}
        if payload.get("name") != expected_tool:
            continue
        if et == "tool_call_proposed":
            proposed = True
        elif et == "tool_call_result":
            last_result = payload
            if "error" in payload and payload["error"]:
                saw_error = True
        elif et in {"tool_call_error", "tool_call_denied"}:
            saw_error = True
    if not proposed:
        return Outcome.NOT_CALLED
    if saw_error:
        return Outcome.CALLED_ERROR
    if last_result is not None:
        return Outcome.CALLED_OK
    # Proposed but no result and no error yet — treat as error (truncated stream)
    return Outcome.CALLED_ERROR


async def fetch_task_events(
    base_url: str, task_id: str, admin_headers: dict, timeout_s: float = 10.0,
) -> list[dict]:
    """Fetch the full event log for a task. Returns events in chronological order."""
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        r = await client.get(f"{base_url}/api/v1/tasks/{task_id}/events", headers=admin_headers)
        r.raise_for_status()
    return r.json()
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add tests/audit_tool_use/events.py tests/audit_tool_use/test_events.py
git commit -m "feat(audit): outcome derivation from task_events — NOT_CALLED / CALLED_ERROR / CALLED_OK"
```

**Satisfies:** AC-B3 (events half), partial AC-Q2.

---

### Task 7: Tool availability check

**Roles:** backend

**Files:**
- Create: `tests/audit_tool_use/availability.py`
- Create: `tests/audit_tool_use/test_availability.py`

- [ ] **Step 1: Write failing tests** (fixture-driven for the parsing logic; HTTP exercise deferred to integration)

```python
import pytest
from audit_tool_use.availability import is_builtin_tool, find_tool_in_mcp_response


def test_builtin_tools_recognized():
    for t in ("fs.write", "fs.read", "shell.exec", "code.execute", "memory.search",
              "memory.write", "nova.secrets.write", "nova.secrets.read",
              "web.search", "web.fetch"):
        assert is_builtin_tool(t)


def test_non_builtin_not_recognized():
    assert not is_builtin_tool("browser_navigate")
    assert not is_builtin_tool("nonsense.thing")


def test_find_tool_in_mcp_response_present():
    payload = [
        {"id": "playwright", "tools": [{"name": "browser_navigate"}, {"name": "browser_click"}]},
    ]
    assert find_tool_in_mcp_response(payload, "browser_navigate") is True


def test_find_tool_in_mcp_response_absent():
    payload = [{"id": "other", "tools": [{"name": "thing"}]}]
    assert find_tool_in_mcp_response(payload, "browser_navigate") is False


def test_find_tool_in_mcp_response_no_servers():
    assert find_tool_in_mcp_response([], "browser_navigate") is False
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `tests/audit_tool_use/availability.py`**

```python
"""Check whether an expected tool is registered in agent-core."""
from __future__ import annotations
import httpx

_BUILTIN = frozenset({
    "fs.read", "fs.write", "fs.delete",
    "shell.exec", "code.execute",
    "memory.search", "memory.write",
    "nova.secrets.write", "nova.secrets.read",
    "web.search", "web.fetch",
})


def is_builtin_tool(name: str) -> bool:
    return name in _BUILTIN


def find_tool_in_mcp_response(payload: list[dict], tool_name: str) -> bool:
    """Search MCP `/api/v1/mcp/servers` response for a server exposing tool_name."""
    for server in payload or []:
        for tool in server.get("tools") or []:
            if tool.get("name") == tool_name:
                return True
    return False


async def check_tool_available(
    base_url: str, tool_name: str, admin_headers: dict,
) -> tuple[bool, str | None]:
    if is_builtin_tool(tool_name):
        return True, None
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get(f"{base_url}/api/v1/mcp/servers", headers=admin_headers)
    if r.status_code != 200:
        return False, f"mcp-list returned {r.status_code}"
    if find_tool_in_mcp_response(r.json(), tool_name):
        return True, None
    return False, "mcp-not-registered"
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add tests/audit_tool_use/availability.py tests/audit_tool_use/test_availability.py
git commit -m "feat(audit): tool availability check — builtin list + MCP discovery"
```

**Satisfies:** AC-B6, AC-Q1.

---

### Task 8: Setup and cleanup strategies

**Roles:** backend

**Files:**
- Create: `tests/audit_tool_use/setups.py` (mirror of cleanups; seeds fixtures BEFORE a probe runs)
- Create: `tests/audit_tool_use/cleanups.py`
- Create: `tests/audit_tool_use/test_setups.py`
- Create: `tests/audit_tool_use/test_cleanups.py`

**Why both in one task:** setup and cleanup are structurally identical (each is a small dataclass with an async method). Three probes (`fs-read-echo`, `memory-search-verbatim-echo`, `nova-secrets-read`) need fixtures created before they run — the model has nothing to read otherwise. Setup is the mirror of cleanup; pairing them in one task keeps the abstraction visible.

- [ ] **Step 1a: Write failing setup tests**

```python
# tests/audit_tool_use/test_setups.py
import pytest
from pathlib import Path
from audit_tool_use.setups import SeedFile, NoSetup
from audit_tool_use.types import Setup


@pytest.mark.asyncio
async def test_seed_file_creates_with_content(tmp_path):
    p = tmp_path / "fixture.txt"
    s = SeedFile(path=str(p), content="HELLO-TOKEN-abc")
    ok, msg = await s.run(context={})
    assert ok is True
    assert p.read_text() == "HELLO-TOKEN-abc"


@pytest.mark.asyncio
async def test_seed_file_overwrites_existing(tmp_path):
    p = tmp_path / "fixture.txt"
    p.write_text("old")
    s = SeedFile(path=str(p), content="new")
    ok, _ = await s.run(context={})
    assert ok is True
    assert p.read_text() == "new"


def test_no_setup_is_sentinel():
    assert NoSetup is Setup.NONE
```

- [ ] **Step 1b: Write failing cleanup tests**

```python
# tests/audit_tool_use/test_cleanups.py
import pytest
from pathlib import Path
from audit_tool_use.cleanups import DeleteFile, NoCleanup
from audit_tool_use.types import Cleanup


@pytest.mark.asyncio
async def test_delete_file_removes_existing(tmp_path):
    p = tmp_path / "x.txt"
    p.write_text("hi")
    c = DeleteFile(path=str(p))
    ok, msg = await c.cleanup(context={})
    assert ok is True
    assert not p.exists()


@pytest.mark.asyncio
async def test_delete_file_is_idempotent_when_missing(tmp_path):
    c = DeleteFile(path=str(tmp_path / "nope.txt"))
    ok, msg = await c.cleanup(context={})
    assert ok is True  # missing file is not a cleanup failure


def test_no_cleanup_is_sentinel():
    assert NoCleanup is Cleanup.NONE
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3a: Implement `tests/audit_tool_use/setups.py`**

```python
"""Setup strategies — create fixtures BEFORE a probe runs. Mirror of cleanups."""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import httpx
from audit_tool_use.types import Setup

NoSetup = Setup.NONE


@dataclass(frozen=True)
class SeedFile:
    """Write a file to disk so a fs.read-style probe has something to read."""
    path: str
    content: str

    async def run(self, context: dict) -> tuple[bool, str | None]:
        try:
            p = Path(self.path)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(self.content)
            return True, None
        except OSError as e:
            return False, f"seed file failed: {e}"


@dataclass(frozen=True)
class SeedMemory:
    """POST a memory to memory-service so a memory.search-style probe finds it."""
    memory_url: str  # e.g. http://localhost:8002
    content: str
    source_kind: str = "audit_fixture"

    async def run(self, context: dict) -> tuple[bool, str | None]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.post(
                    f"{self.memory_url}/memories",
                    json={"content": self.content, "source_kind": self.source_kind, "tags": ["audit"]},
                )
            if r.status_code not in (200, 201):
                return False, f"seed memory returned {r.status_code}: {r.text[:200]}"
            return True, None
        except Exception as e:
            return False, str(e)


@dataclass(frozen=True)
class SeedSecret:
    """POST a secret to agent-core so a nova.secrets.read-style probe can resolve it."""
    base_url: str
    name: str
    value: str
    purpose: str = "audit_fixture"

    async def run(self, context: dict) -> tuple[bool, str | None]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.post(
                    f"{self.base_url}/api/v1/secrets",
                    json={"name": self.name, "value": self.value, "purpose": self.purpose},
                    headers=context.get("admin_headers", {}),
                )
            if r.status_code not in (200, 201):
                return False, f"seed secret returned {r.status_code}: {r.text[:200]}"
            return True, None
        except Exception as e:
            return False, str(e)
```

- [ ] **Step 3b: Implement `tests/audit_tool_use/cleanups.py`**

```python
"""Cleanup strategies. All best-effort: failure → warn, not fail."""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import httpx
from audit_tool_use.types import Cleanup

NoCleanup = Cleanup.NONE


@dataclass(frozen=True)
class DeleteFile:
    path: str

    async def cleanup(self, context: dict) -> tuple[bool, str | None]:
        p = Path(self.path)
        try:
            if p.exists():
                p.unlink()
            return True, None
        except OSError as e:
            return False, f"delete failed: {e}"


@dataclass(frozen=True)
class DeleteMemory:
    memory_url: str  # e.g. http://localhost:8002
    content_match: str  # search for memories whose content contains this token

    async def cleanup(self, context: dict) -> tuple[bool, str | None]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                # Search for memories matching the run-id-tagged content
                r = await client.post(
                    f"{self.memory_url}/memories/search",
                    json={"query": self.content_match, "limit": 50},
                )
                if r.status_code != 200:
                    return False, f"search returned {r.status_code}"
                for m in r.json():
                    if self.content_match in (m.get("content") or ""):
                        await client.delete(f"{self.memory_url}/memories/{m['id']}")
            return True, None
        except Exception as e:
            return False, str(e)


@dataclass(frozen=True)
class DeleteSecret:
    base_url: str
    name: str

    async def cleanup(self, context: dict) -> tuple[bool, str | None]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.delete(
                    f"{self.base_url}/api/v1/secrets/{self.name}",
                    headers=context.get("admin_headers", {}),
                )
            if r.status_code not in (200, 204, 404):
                return False, f"delete returned {r.status_code}"
            return True, None
        except Exception as e:
            return False, str(e)
```

- [ ] **Step 4: Run all tests — expect PASS**

```bash
uv run --with pytest --with pytest-asyncio --with httpx pytest tests/audit_tool_use/test_setups.py tests/audit_tool_use/test_cleanups.py -v
```

- [ ] **Step 5: Commit**

```bash
git add tests/audit_tool_use/setups.py tests/audit_tool_use/cleanups.py tests/audit_tool_use/test_setups.py tests/audit_tool_use/test_cleanups.py
git commit -m "feat(audit): setup + cleanup strategies — SeedFile/Memory/Secret + DeleteFile/Memory/Secret"
```

**Satisfies:** AC-B4, AC-Q6. Setup mirror enables AC-Q3 for fs-read / memory-search / nova-secrets-read probes (otherwise the model has nothing to read).

---

### Task 9: Model discovery

**Roles:** backend

**Files:**
- Create: `tests/audit_tool_use/models.py`
- Create: `tests/audit_tool_use/test_models.py`

- [ ] **Step 1: Write failing tests** (fixture-driven for the parser)

```python
import pytest
from audit_tool_use.models import filter_available_models


def test_filters_only_available_providers():
    payload = {
        "providers": [
            {"id": "ollama", "available": True, "models": ["llama3.2", "mistral"]},
            {"id": "openai", "available": False, "models": ["gpt-4o"]},
            {"id": "anthropic", "available": True, "models": ["claude-sonnet-4-6"]},
        ]
    }
    models = filter_available_models(payload)
    ids = {m["model_id"] for m in models}
    assert "llama3.2" in ids
    assert "claude-sonnet-4-6" in ids
    assert "gpt-4o" not in ids  # provider not available


def test_returns_empty_when_no_providers():
    assert filter_available_models({"providers": []}) == []
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `tests/audit_tool_use/models.py`**

```python
"""Discover usable models from llm-gateway."""
from __future__ import annotations
import httpx


def filter_available_models(providers_payload: dict) -> list[dict]:
    """Given GET /providers response, return list of {provider_id, model_id} for usable models."""
    result = []
    for p in providers_payload.get("providers", []):
        if not p.get("available"):
            continue
        for m in p.get("models", []) or []:
            result.append({"provider_id": p["id"], "model_id": m})
    return result


async def discover_models(llm_gateway_url: str = "http://localhost:8001") -> list[dict]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(f"{llm_gateway_url}/providers")
        r.raise_for_status()
    return filter_available_models(r.json())
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add tests/audit_tool_use/models.py tests/audit_tool_use/test_models.py
git commit -m "feat(audit): model discovery via /providers — filters to usable providers"
```

**Satisfies (partial):** AC-B7 (model-aware sequencing).

---

### Task 10: Probe registry (the 11 declarative probes)

**Roles:** qa

**Files:**
- Create: `tests/audit_tool_use/probes.py`
- Create: `tests/audit_tool_use/test_probes.py`

**Probe design discipline (per spec AC-Q3 + spec-reviewer note #2):** every probe prompt must force tool use via an unfalsifiable side effect. Memory/secrets probes must **explicitly instruct the model to echo the retrieved value VERBATIM**, not paraphrase — otherwise `ResponseContains` produces false negatives.

- [ ] **Step 1: Write failing sanity tests**

```python
from audit_tool_use.probes import PROBES


def test_all_probes_have_unique_ids():
    ids = [p.id for p in PROBES]
    assert len(ids) == len(set(ids)), f"duplicate probe ids: {ids}"


def test_all_probes_have_required_fields():
    for p in PROBES:
        assert p.id
        assert p.tool
        assert "{run_id}" in p.prompt_template or "{token}" in p.prompt_template, \
            f"probe {p.id} doesn't reference run_id/token in prompt"
        assert p.tier in ("READ", "MUTATE")


def test_memory_search_probe_forces_verbatim_echo():
    """Per spec-reviewer note #2: probe prompt must demand verbatim echo."""
    p = next(p for p in PROBES if p.tool == "memory.search")
    assert "verbatim" in p.prompt_template.lower() or "exactly" in p.prompt_template.lower()


def test_probe_count_in_expected_range():
    assert 9 <= len(PROBES) <= 14
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `tests/audit_tool_use/probes.py`**

```python
"""The probe registry. Adding a tool = appending a row.

Every prompt forces tool use via an unfalsifiable side effect:
- fs.write/fs.read: file content the model can't fabricate
- memory.write/memory.search: a UUID embedded in content
- shell.exec/code.execute: a command output containing a known token
- nova.secrets.*: a token returned only by secrets/resolve
- web.fetch/web.search: a token from a known page or query
- browser_navigate: attempt-only (ships SKIPPED if MCP not registered)

All written entities carry the nova-audit-{run_id}- prefix for filterable cleanup.
"""
from __future__ import annotations
from audit_tool_use.types import Probe
from audit_tool_use.verifiers import FileExists, ResponseContains, DbContains, Skip
from audit_tool_use.setups import SeedFile, SeedMemory, SeedSecret, NoSetup
from audit_tool_use.cleanups import DeleteFile, DeleteMemory, DeleteSecret, NoCleanup


PROBES: list[Probe] = [
    Probe(
        id="fs-write-roundtrip",
        tool="fs.write",
        prompt_template=(
            "Write a file at /workspace/nova-audit-{run_id}.txt containing exactly "
            "the string '{token}' (no other content). Then confirm the file is written."
        ),
        expected_args_subset={"path": "/workspace/nova-audit-{run_id}.txt"},
        verifier=FileExists(
            path="/workspace/nova-audit-{run_id}.txt",
            expect_content_contains="{token}",
        ),
        cleanup=DeleteFile(path="/workspace/nova-audit-{run_id}.txt"),
        tier="MUTATE",
    ),
    Probe(
        id="fs-read-echo",
        tool="fs.read",
        prompt_template=(
            "Read the file /workspace/nova-audit-fixture-{run_id}.txt and tell me "
            "the EXACT content it contains, verbatim, between triple backticks."
        ),
        expected_args_subset={"path": "/workspace/nova-audit-fixture-{run_id}.txt"},
        verifier=ResponseContains(token="{token}"),
        setup=SeedFile(
            path="/workspace/nova-audit-fixture-{run_id}.txt",
            content="{token}",
        ),
        cleanup=DeleteFile(path="/workspace/nova-audit-fixture-{run_id}.txt"),
        tier="READ",
    ),
    Probe(
        id="shell-exec-echo-token",
        tool="shell.exec",
        prompt_template=(
            "Run the shell command: echo {token}. Then tell me the exact stdout "
            "you observed, verbatim between triple backticks."
        ),
        expected_args_subset={"command": "echo {token}"},
        verifier=ResponseContains(token="{token}"),
        cleanup=NoCleanup,
        tier="MUTATE",
    ),
    Probe(
        id="code-execute-echo-token",
        tool="code.execute",
        prompt_template=(
            "Execute this Python: print('{token}'). Then tell me the exact stdout "
            "you observed, verbatim between triple backticks."
        ),
        expected_args_subset={"language": "python"},
        verifier=ResponseContains(token="{token}"),
        cleanup=NoCleanup,
        tier="MUTATE",
    ),
    Probe(
        id="memory-write-then-search",
        tool="memory.write",
        prompt_template=(
            "Save a memory with the content 'nova-audit-{run_id} record contains "
            "the token {token}'. Then confirm it's saved."
        ),
        expected_args_subset=None,
        verifier=DbContains(
            endpoint="http://localhost:8002/memories/search",
            query={"query": "{token}", "limit": 5},
            expect_field="0.id",
        ),
        cleanup=DeleteMemory(memory_url="http://localhost:8002", content_match="nova-audit-{run_id}"),
        tier="MUTATE",
    ),
    Probe(
        id="memory-search-verbatim-echo",
        tool="memory.search",
        prompt_template=(
            "Search your memory for the token 'nova-audit-fixture-{run_id}'. "
            "Then quote the EXACT, VERBATIM content of the most relevant matching "
            "memory between triple backticks — do not paraphrase or summarize."
        ),
        expected_args_subset=None,
        verifier=ResponseContains(token="{token}"),
        setup=SeedMemory(
            memory_url="http://localhost:8002",
            content="nova-audit-fixture-{run_id} record contains the token {token}",
        ),
        cleanup=DeleteMemory(memory_url="http://localhost:8002", content_match="nova-audit-fixture-{run_id}"),
        tier="READ",
    ),
    Probe(
        id="nova-secrets-write",
        tool="nova.secrets.write",
        prompt_template=(
            "Store a secret named 'nova-audit-{run_id}-secret' with the value "
            "'{token}'. Then confirm it was stored."
        ),
        expected_args_subset={"name": "nova-audit-{run_id}-secret"},
        verifier=DbContains(
            endpoint="http://localhost:8000/api/v1/secrets/resolve",
            query={"name": "nova-audit-{run_id}-secret"},
            expect_field="value",
        ),
        cleanup=DeleteSecret(base_url="http://localhost:8000", name="nova-audit-{run_id}-secret"),
        tier="MUTATE",
    ),
    Probe(
        id="nova-secrets-read",
        tool="nova.secrets.read",
        prompt_template=(
            "Read the secret named 'nova-audit-fixture-{run_id}-secret'. Then "
            "quote its EXACT, VERBATIM value between triple backticks — "
            "do not paraphrase."
        ),
        expected_args_subset={"name": "nova-audit-fixture-{run_id}-secret"},
        verifier=ResponseContains(token="{token}"),
        setup=SeedSecret(
            base_url="http://localhost:8000",
            name="nova-audit-fixture-{run_id}-secret",
            value="{token}",
        ),
        cleanup=DeleteSecret(base_url="http://localhost:8000", name="nova-audit-fixture-{run_id}-secret"),
        tier="READ",
    ),
    Probe(
        id="web-fetch-token-page",
        tool="web.fetch",
        prompt_template=(
            "Fetch the URL https://example.com/ and tell me the EXACT text "
            "of the page title between triple backticks."
        ),
        expected_args_subset={"url": "https://example.com/"},
        verifier=ResponseContains(token="Example Domain"),
        cleanup=NoCleanup,
        tier="READ",
    ),
    Probe(
        id="web-search-attempt",
        tool="web.search",
        prompt_template=(
            "Search the web for the exact phrase: 'nova audit canary token "
            "{token}'. Tell me how many results you got."
        ),
        expected_args_subset=None,
        verifier=Skip,  # Outcome verification deferred — search results are unstable
        cleanup=NoCleanup,
        tier="READ",
    ),
    Probe(
        id="browser-navigate-attempt",
        tool="browser_navigate",
        prompt_template=(
            "Navigate the browser to https://example.com/ and tell me what "
            "you see."
        ),
        expected_args_subset={"url": "https://example.com/"},
        verifier=Skip,  # Attempt-only per spec Non-Goals; SKIPPED if MCP not registered
        cleanup=NoCleanup,
        tier="MUTATE",
    ),
]
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add tests/audit_tool_use/probes.py tests/audit_tool_use/test_probes.py
git commit -m "feat(audit): probe registry — 11 declarative probes with unfalsifiable side-effects

Memory and secrets probes explicitly demand verbatim echo (not paraphrase).
Web search and browser_navigate ship attempt-only per spec."
```

**Satisfies:** AC-Q3, partial AC-Q8.

---

### Task 11: Harness loop

**Roles:** backend

**Files:**
- Create: `tests/audit_tool_use/harness.py`

**This task has no unit test of its own** — the harness wires all the previously-tested components and is exercised end-to-end by Task 13's pytest entry against live services.

- [ ] **Step 1: Implement `tests/audit_tool_use/harness.py`**

```python
"""The per-(probe, model, trial) run loop. Wires env + availability + stream +
events + verifiers + cleanups. Returns a TrialResult."""
from __future__ import annotations
import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any
import httpx

from audit_tool_use.types import Outcome, Probe, TrialResult, Verifier, Cleanup, Setup
from audit_tool_use.stream import consume_stream_with_approval_grant
from audit_tool_use.events import derive_outcome, fetch_task_events
from audit_tool_use.availability import check_tool_available
from audit_tool_use.constants import READ_DEADLINE_S, MUTATE_DEADLINE_S


AGENT_CORE = os.getenv("NOVA_AGENT_CORE_URL", "http://localhost:8000")


async def _grant_approval(base_url: str, admin_headers: dict, tool_call_id: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{base_url}/api/v1/approvals/{tool_call_id}/grant",
                json={"remember": False, "remember_ttl": 0},
                headers=admin_headers,
            )
    except Exception:
        # Best-effort; if grant fails the stream will hit its 300s timeout and
        # the wall-clock guard below will catch it.
        pass


def _render(probe: Probe, run_id: str, token: str) -> tuple[str, dict | None]:
    """Substitute {run_id} and {token} placeholders in the prompt and args_subset."""
    def subst(s: str) -> str:
        return s.format(run_id=run_id, token=token)
    prompt = subst(probe.prompt_template)
    args = None
    if probe.expected_args_subset:
        args = {k: (subst(v) if isinstance(v, str) else v) for k, v in probe.expected_args_subset.items()}
    return prompt, args


async def run_trial(
    probe: Probe,
    model: dict,                       # {"provider_id": ..., "model_id": ...}
    trial_n: int,
    admin_headers: dict,
    trace_dir: Path,
) -> TrialResult:
    run_id = uuid.uuid4().hex[:8]
    token = f"AUDIT-TOK-{uuid.uuid4().hex[:12]}"
    prompt, _args = _render(probe, run_id, token)
    deadline = MUTATE_DEADLINE_S if probe.tier == "MUTATE" else READ_DEADLINE_S
    start = time.monotonic()
    trace: dict[str, Any] = {
        "probe_id": probe.id, "tool": probe.tool, "model": model["model_id"],
        "trial_n": trial_n, "run_id": run_id, "token": token, "prompt": prompt,
        "stream_events": [], "task_events": [], "verifier_result": None,
        "cleanup_result": None,
    }

    # 1. Tool availability
    ok, reason = await check_tool_available(AGENT_CORE, probe.tool, admin_headers)
    if not ok:
        trial = TrialResult(
            probe_id=probe.id, tool=probe.tool, model=model["model_id"], trial_n=trial_n,
            outcome=Outcome.NOT_CALLED, latency_ms=0, error_msg=None,
            trace_path=None, cleanup_failed=False, run_id=run_id,
            skipped_reason=reason or "tool-unavailable",
        )
        _save_trace(trace_dir, probe.id, model["model_id"], trial_n, trace)
        return trial

    # 1b. Setup (seed fixtures the probe needs to find)
    if probe.setup is not None and probe.setup is not Setup.NONE:
        setup_inst = _instantiate_verifier(probe.setup, run_id, token)
        try:
            s_ok, s_reason = await setup_inst.run({"admin_headers": admin_headers})
            trace["setup_result"] = {"ok": s_ok, "reason": s_reason}
            if not s_ok:
                return _infra_failure(probe, model, trial_n, run_id, trace_dir, trace,
                                      f"setup failed: {s_reason}")
        except Exception as e:
            trace["setup_result"] = {"ok": False, "reason": str(e)}
            return _infra_failure(probe, model, trial_n, run_id, trace_dir, trace,
                                  f"setup raised: {e}")

    # 2. Create task
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(
            f"{AGENT_CORE}/api/v1/tasks",
            json={"goal": prompt, "source": "audit", "model": model["model_id"]},
            headers=admin_headers,
        )
        if r.status_code != 200:
            return _infra_failure(probe, model, trial_n, run_id, trace_dir, trace,
                                  f"task create {r.status_code}: {r.text[:200]}")
        task_id = r.json()["id"]
    trace["task_id"] = task_id

    # 3. Stream message + concurrent approval-grant; wall-clock guarded
    async def grant_fn(call_id: str) -> None:
        await _grant_approval(AGENT_CORE, admin_headers, call_id)

    try:
        async with httpx.AsyncClient(timeout=deadline + 10) as client:
            async with client.stream(
                "POST",
                f"{AGENT_CORE}/api/v1/tasks/{task_id}/message",
                json={"text": prompt},
                headers=admin_headers,
            ) as resp:
                final = await asyncio.wait_for(
                    consume_stream_with_approval_grant(resp.aiter_bytes(), grant_fn),
                    timeout=deadline,
                )
        trace["final_stream_event"] = final
    except asyncio.TimeoutError:
        trace["wall_clock_timeout"] = True
        # Still try to read events for partial truth
        events = await fetch_task_events(AGENT_CORE, task_id, admin_headers)
        trace["task_events"] = events
        await _run_cleanup(probe, run_id, token, admin_headers, trace)
        _save_trace(trace_dir, probe.id, model["model_id"], trial_n, trace)
        return TrialResult(
            probe_id=probe.id, tool=probe.tool, model=model["model_id"], trial_n=trial_n,
            outcome=Outcome.AUDIT_INFRA_TIMEOUT,
            latency_ms=int((time.monotonic() - start) * 1000),
            error_msg=f"wall-clock {deadline}s exceeded",
            trace_path=_trace_path(trace_dir, probe.id, model["model_id"], trial_n),
            cleanup_failed=False, run_id=run_id,
        )

    # 4. Outcome from task_events
    events = await fetch_task_events(AGENT_CORE, task_id, admin_headers)
    trace["task_events"] = events
    outcome = derive_outcome(events, expected_tool=probe.tool)

    # 5. Verifier (only if CALLED_OK and not SKIP)
    verifier_failed_reason = None
    if outcome == Outcome.CALLED_OK and probe.verifier is not Verifier.SKIP:
        v = _instantiate_verifier(probe.verifier, run_id, token)
        ctx = {
            "final_response": (final or {}).get("text", ""),
            "admin_headers": admin_headers,
        }
        v_ok, v_reason = await v.verify(ctx)
        trace["verifier_result"] = {"ok": v_ok, "reason": v_reason}
        if v_ok:
            outcome = Outcome.SIDE_EFFECT_VERIFIED
        else:
            verifier_failed_reason = v_reason

    # 6. Cleanup
    cleanup_failed = not await _run_cleanup(probe, run_id, token, admin_headers, trace)

    # 7. Save trace, return
    _save_trace(trace_dir, probe.id, model["model_id"], trial_n, trace)
    return TrialResult(
        probe_id=probe.id, tool=probe.tool, model=model["model_id"], trial_n=trial_n,
        outcome=outcome,
        latency_ms=int((time.monotonic() - start) * 1000),
        error_msg=None,
        trace_path=_trace_path(trace_dir, probe.id, model["model_id"], trial_n),
        cleanup_failed=cleanup_failed, run_id=run_id,
        verifier_failed_reason=verifier_failed_reason,
    )


def _instantiate_verifier(verifier: Any, run_id: str, token: str) -> Any:
    """Substitute {run_id}/{token} placeholders in any string fields of a verifier/setup/cleanup dataclass.
    Works for Verifier, Setup, Cleanup objects — they share the same shape (frozen dataclass with str/dict fields).
    """
    if verifier is Verifier.SKIP or verifier is Setup.NONE or verifier is Cleanup.NONE or verifier is None:
        return verifier
    from dataclasses import replace, fields
    new_fields = {}
    for f in fields(verifier):
        val = getattr(verifier, f.name)
        if isinstance(val, str):
            new_fields[f.name] = val.format(run_id=run_id, token=token)
        elif isinstance(val, dict):
            new_fields[f.name] = {k: (v.format(run_id=run_id, token=token) if isinstance(v, str) else v) for k, v in val.items()}
        else:
            new_fields[f.name] = val
    return replace(verifier, **new_fields)


async def _run_cleanup(probe, run_id, token, admin_headers, trace) -> bool:
    if probe.cleanup is None or probe.cleanup is Cleanup.NONE:
        return True
    c = _instantiate_verifier(probe.cleanup, run_id, token)  # same placeholder substitution
    try:
        ok, reason = await c.cleanup({"admin_headers": admin_headers})
        trace["cleanup_result"] = {"ok": ok, "reason": reason}
        return ok
    except Exception as e:
        trace["cleanup_result"] = {"ok": False, "reason": str(e)}
        return False


def _trace_path(trace_dir: Path, probe_id: str, model_id: str, trial_n: int) -> str:
    safe_model = model_id.replace("/", "_")
    return str(trace_dir / f"{probe_id}__{safe_model}__t{trial_n}.json")


def _save_trace(trace_dir: Path, probe_id: str, model_id: str, trial_n: int, trace: dict) -> None:
    trace_dir.mkdir(parents=True, exist_ok=True)
    Path(_trace_path(trace_dir, probe_id, model_id, trial_n)).write_text(
        json.dumps(trace, default=str, indent=2)
    )


def _infra_failure(probe, model, trial_n, run_id, trace_dir, trace, msg) -> TrialResult:
    _save_trace(trace_dir, probe.id, model["model_id"], trial_n, trace)
    return TrialResult(
        probe_id=probe.id, tool=probe.tool, model=model["model_id"], trial_n=trial_n,
        outcome=Outcome.AUDIT_INFRA_TIMEOUT, latency_ms=0, error_msg=msg,
        trace_path=_trace_path(trace_dir, probe.id, model["model_id"], trial_n),
        cleanup_failed=False, run_id=run_id,
    )
```

- [ ] **Step 2: Commit (no test — exercised end-to-end in Task 13)**

```bash
git add tests/audit_tool_use/harness.py
git commit -m "feat(audit): harness loop — wires availability/stream/events/verifier/cleanup per trial"
```

**Satisfies:** AC-B5, AC-B7, partial AC-Q4.

---

### Task 12: Report renderer (markdown + JSON + traces)

**Roles:** docs

**Files:**
- Create: `tests/audit_tool_use/render.py`
- Create: `tests/audit_tool_use/test_render.py`

- [ ] **Step 1: Write failing tests (heavy fixture coverage — these are the docs ACs)**

```python
import json
from pathlib import Path
from audit_tool_use.render import render_report
from audit_tool_use.types import Outcome, TrialResult


def _sample_trials():
    return [
        TrialResult(probe_id="fs-write-roundtrip", tool="fs.write", model="llama3.2",
                    trial_n=0, outcome=Outcome.SIDE_EFFECT_VERIFIED, latency_ms=1200,
                    error_msg=None, trace_path="traces/fs-write-roundtrip__llama3.2__t0.json",
                    cleanup_failed=False, run_id="abc"),
        TrialResult(probe_id="fs-write-roundtrip", tool="fs.write", model="llama3.2",
                    trial_n=1, outcome=Outcome.NOT_CALLED, latency_ms=900,
                    error_msg=None, trace_path="traces/fs-write-roundtrip__llama3.2__t1.json",
                    cleanup_failed=False, run_id="abc"),
    ]


def test_markdown_has_required_frontmatter(tmp_path):
    out = render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                        commit_sha="abc1234", audit_script_sha="def5678",
                        llm_routing_strategy="local-first", run_duration_seconds=42)
    md = (tmp_path / "2026-05-22-tool-use-audit.md").read_text()
    assert "date: 2026-05-22" in md
    assert "commit_sha: abc1234" in md
    assert "audit_script_sha256: def5678" in md
    assert "llm_routing_strategy: local-first" in md
    assert "run_duration_seconds: 42" in md


def test_markdown_has_tldr_table(tmp_path):
    render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                  commit_sha="abc", audit_script_sha="def",
                  llm_routing_strategy="local-first", run_duration_seconds=0)
    md = (tmp_path / "2026-05-22-tool-use-audit.md").read_text()
    assert "## TL;DR" in md
    assert "| Model |" in md
    assert "llama3.2" in md


def test_finding_blocks_have_required_fields(tmp_path):
    render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                  commit_sha="abc", audit_script_sha="def",
                  llm_routing_strategy="local-first", run_duration_seconds=0)
    md = (tmp_path / "2026-05-22-tool-use-audit.md").read_text()
    # Each finding has severity, category, recommended_fix, effort
    assert "**Severity:**" in md
    assert "**Category:**" in md
    assert "**Recommended fix:**" in md
    assert "**Effort:**" in md


def test_traces_referenced_as_collapsed_details(tmp_path):
    render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                  commit_sha="abc", audit_script_sha="def",
                  llm_routing_strategy="local-first", run_duration_seconds=0)
    md = (tmp_path / "2026-05-22-tool-use-audit.md").read_text()
    assert "<details>" in md
    assert "traces/" in md


def test_results_json_schema(tmp_path):
    render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                  commit_sha="abc", audit_script_sha="def",
                  llm_routing_strategy="local-first", run_duration_seconds=0)
    js = json.loads((tmp_path / "results.json").read_text())
    assert "run_id" in js
    assert "models" in js
    assert isinstance(js["models"], list)
    assert js["models"][0]["model_id"] == "llama3.2"
    probe = js["models"][0]["probes"][0]
    assert "n_attempted" in probe
    assert "n_called_ok" in probe
    assert "n_side_effect_verified" in probe


def test_reproducibility_block_present(tmp_path):
    render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                  commit_sha="abc", audit_script_sha="def",
                  llm_routing_strategy="local-first", run_duration_seconds=0)
    md = (tmp_path / "2026-05-22-tool-use-audit.md").read_text()
    assert "## Reproducibility" in md
    assert "make audit-tool-use" in md


def test_recommendations_ranked_by_impact_to_effort(tmp_path):
    # Two findings — render must order them so high-impact-low-effort comes first
    md = render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                       commit_sha="abc", audit_script_sha="def",
                       llm_routing_strategy="local-first", run_duration_seconds=0)
    # Render returns the markdown string; sanity-check section ordering
    assert (tmp_path / "2026-05-22-tool-use-audit.md").exists()
    text = (tmp_path / "2026-05-22-tool-use-audit.md").read_text()
    rec_idx = text.find("## Recommendations")
    repro_idx = text.find("## Reproducibility")
    assert rec_idx > 0 and repro_idx > rec_idx
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `tests/audit_tool_use/render.py`**

(Full implementation: aggregates per-(model, probe) counts, emits markdown with frontmatter / TL;DR table / per-finding blocks / impact-ranked recommendations / collapsed-details trace links / reproducibility block; writes JSON sidecar with same shape. ~220 lines. Verbose but mechanical — implementer fills in to match the AC-D* tests above. Key shape:

```python
def render_report(trials: list[TrialResult], *, output_dir: Path,
                  date: str, commit_sha: str, audit_script_sha: str,
                  llm_routing_strategy: str, run_duration_seconds: int) -> str:
    # 1. Aggregate per (model, probe) → counts
    # 2. Compute severity per finding (P0 = called_error rate >= 50%; P1 = not_called rate >= 50%; P2 = otherwise)
    # 3. Category (model/prompt/wiring/infra) from heuristics on outcome distribution
    # 4. Effort estimate (S/M/L) based on category
    # 5. Write JSON to output_dir/results.json
    # 6. Compose markdown: frontmatter → TL;DR → findings → recommendations (impact-to-effort sorted) → reproducibility → traces details
    # 7. Write to output_dir/<date>-tool-use-audit.md
    # 8. Return the markdown
)

- [ ] **Step 4: Run — expect PASS** for all 7 render tests

- [ ] **Step 5: Commit**

```bash
git add tests/audit_tool_use/render.py tests/audit_tool_use/test_render.py
git commit -m "feat(audit): report renderer — markdown + results.json + collapsed-trace links

Satisfies AC-D1 through AC-D6 plus AC-Q5 (results.json schema for regression diffs)."
```

**Satisfies:** AC-D1, AC-D2, AC-D3, AC-D4, AC-D5, AC-D6, AC-Q5.

---

### Task 13: Pytest entry + `audit` marker + Make target

**Roles:** backend, qa

**Files:**
- Create: `tests/test_chat_tool_usage.py`
- Modify: `tests/pytest.ini` (register marker)
- Modify: `Makefile` (add target)

- [ ] **Step 1: Register the `audit` marker in `tests/pytest.ini`**

Replace the existing `tests/pytest.ini` with:

```ini
[pytest]
asyncio_mode = auto
testpaths = .
pythonpath = . .. ../nova-worker-common ../nova-contracts
addopts = --continue-on-collection-errors
markers =
    audit: tool-use audit (live services, ~10-30 min, run via `make audit-tool-use`)
```

(`.` is `tests/`, which is where `audit_tool_use/` lives as a package. Adding `./audit_tool_use` directly would break imports — pythonpath needs the package's PARENT directory, not the package itself.)

- [ ] **Step 2: Add the make target**

Append to `Makefile`:

```makefile
audit-tool-use: ## Tool-use audit — live services, ~10-30 min, never CI-gating
	@cd tests && uv run --with pytest --with pytest-asyncio --with httpx \
	  --with python-dotenv \
	  pytest -v -m audit test_chat_tool_usage.py || true
```

(Note the path argument is `test_chat_tool_usage.py` without the `tests/` prefix — pytest is already running with cwd=`tests/` from the `cd tests` step. This matches the existing `test-quick` make target's pattern.)

- [ ] **Step 3: Implement the pytest entry**

Create `tests/test_chat_tool_usage.py`:

```python
"""Tool-use audit — single pytest entry under @pytest.mark.audit.

Discovers usable models via /providers, runs N=3 trials per (probe, model),
extracts outcomes from task_events, runs verifiers and cleanups, renders
the report. Skips gracefully if services are down."""
from __future__ import annotations
import asyncio
import datetime as dt
import hashlib
import os
import subprocess
import time
from pathlib import Path
import httpx
import pytest

from audit_tool_use.constants import TRIALS_PER_PROBE, OUTPUT_DIR_TEMPLATE, OUTPUT_MD_TEMPLATE
from audit_tool_use.env import resolve_repo_root, load_admin_secret
from audit_tool_use.harness import run_trial, AGENT_CORE
from audit_tool_use.models import discover_models
from audit_tool_use.probes import PROBES
from audit_tool_use.render import render_report


def _services_reachable() -> bool:
    try:
        r = httpx.get(f"{AGENT_CORE}/health/ready", timeout=3.0)
        return r.status_code == 200
    except Exception:
        return False


def _audit_script_sha() -> str:
    """Hash of the audit_tool_use package files for reproducibility metadata."""
    root = Path(__file__).parent / "audit_tool_use"
    h = hashlib.sha256()
    for p in sorted(root.rglob("*.py")):
        h.update(p.relative_to(root).as_posix().encode())
        h.update(b"\0")
        h.update(p.read_bytes())
    return h.hexdigest()[:12]


def _commit_sha(repo_root: Path) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"], text=True
        ).strip()[:12]
    except Exception:
        return "unknown"


@pytest.mark.audit
@pytest.mark.asyncio
async def test_chat_tool_use_audit():
    if not _services_reachable():
        out = Path("docs/audits/2026-05-22-tool-use-audit.md")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            f"# Tool-Use Audit — SKIPPED\n\n"
            f"Run at {dt.datetime.now().isoformat()}\n\n"
            f"Services were not reachable at {AGENT_CORE}. Audit is diagnostic, never CI-blocking.\n"
        )
        pytest.skip("services unavailable")

    repo_root = resolve_repo_root()
    admin_secret = load_admin_secret(repo_root=repo_root)
    admin_headers = {"X-Admin-Secret": admin_secret}
    models = await discover_models()
    if not models:
        pytest.skip("no LLM providers available")

    date = dt.date.today().isoformat()
    output_dir = repo_root / OUTPUT_DIR_TEMPLATE.format(date=date)
    trace_dir = output_dir / "traces"
    output_dir.mkdir(parents=True, exist_ok=True)
    trace_dir.mkdir(parents=True, exist_ok=True)

    start = time.monotonic()
    all_trials = []
    for model in models:
        for probe in PROBES:
            for trial_n in range(TRIALS_PER_PROBE):
                tr = await run_trial(probe, model, trial_n, admin_headers, trace_dir)
                all_trials.append(tr)
    duration = int(time.monotonic() - start)

    render_report(
        all_trials, output_dir=output_dir,
        date=date,
        commit_sha=_commit_sha(repo_root),
        audit_script_sha=_audit_script_sha(),
        llm_routing_strategy=os.getenv("LLM_ROUTING_STRATEGY", "unknown"),
        run_duration_seconds=duration,
    )

    # Sanity assertion: audit ran to completion and produced output
    assert (output_dir.parent / f"{date}-tool-use-audit.md").exists() or \
           (output_dir / f"{date}-tool-use-audit.md").exists()
```

- [ ] **Step 4: Smoke-test the marker registration** (no live services needed)

```bash
cd /home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools
uv run --with pytest pytest -v --collect-only -m audit tests/test_chat_tool_usage.py
```

Expected: `1 test collected` (no warnings about unknown marker).

- [ ] **Step 5: Commit**

```bash
git add tests/test_chat_tool_usage.py tests/pytest.ini Makefile
git commit -m "feat(audit): pytest entry + audit marker + make audit-tool-use target

Audit skips gracefully on services-down (writes a SKIPPED report, exits 0).
Make target uses uv run to bundle deps without pyproject changes."
```

**Satisfies:** AC-Q7 (services-down behavior), partial AC-Q4 (trial orchestration).

---

### Task 14: First dry-run + report commit

**Roles:** qa, docs

**Files:**
- Create: `docs/audits/2026-05-22-tool-use-audit.md` (output of the first run)
- Create: `docs/audits/2026-05-22-tool-use-audit/results.json` + `traces/`

**Prerequisites:** the user (or executor) must start the stack from the main repo before running this task — `cd /home/jeremy/workspace/nova && ./start` or `make dev`.

- [ ] **Step 1: Verify the stack is up**

```bash
docker compose --project-directory /home/jeremy/workspace/nova ps
curl -s http://localhost:8000/health/ready
curl -s http://localhost:8001/providers | jq '.providers[] | {id, available}'
```

Expected: `health/ready` returns 200; at least one provider is `available: true`.

- [ ] **Step 2: Run the audit**

```bash
cd /home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools
make audit-tool-use
```

Expected: completes within ~30 minutes (variable based on model count and probe count). Writes:
- `docs/audits/2026-05-22-tool-use-audit.md`
- `docs/audits/2026-05-22-tool-use-audit/results.json`
- `docs/audits/2026-05-22-tool-use-audit/traces/*.json`

The output should land in the worktree's `docs/audits/` because the audit resolves repo_root relative to the audit harness module, which lives in the worktree.

- [ ] **Step 3: Sanity-check the report**

```bash
head -30 docs/audits/2026-05-22-tool-use-audit.md
jq '.models | length' docs/audits/2026-05-22-tool-use-audit/results.json
ls docs/audits/2026-05-22-tool-use-audit/traces/ | wc -l
```

Expected:
- Markdown has frontmatter with `commit_sha` matching `git rev-parse HEAD`.
- `results.json` has ≥1 model.
- `traces/` contains `models × probes × trials` files (e.g. 1 × 11 × 3 = 33 traces for a single local-only run).

- [ ] **Step 4: Commit the first-run report**

```bash
git add docs/audits/2026-05-22-tool-use-audit.md docs/audits/2026-05-22-tool-use-audit/
git commit -m "audit(tool-use): first-run baseline report — commit $(git rev-parse HEAD | cut -c1-7)

Anchors future regression diffs. Run conditions captured in report frontmatter."
```

- [ ] **Step 5: Regression-gate check**

Per project CLAUDE.md: run `make test-v2` from the main repo (NOT the worktree, since `.env` lives there) and confirm no NEW failures vs the baseline recorded at session start.

```bash
cd /home/jeremy/workspace/nova
make test-v2 2>&1 | tail -10
```

Expected: same failures as the session-start baseline (all `httpx.ConnectError` if services aren't running; or the normal v2 pass set if they are). Zero NEW failures attributable to this branch.

**Satisfies:** Closes all integration-level ACs by producing the actual artifacts.

---

## Plan complete — execution handoff

Per the writing-plans skill, two execution options after this plan lands:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, with two-stage review between tasks (spec-compliance + code-quality). Best for plans with many tasks where context bleed between tasks would hurt quality.

**2. Inline Execution** — Execute tasks sequentially in the current session via `superpowers:executing-plans`, with checkpoints between tasks.

The orchestrator's lifecycle (per `engineering-orchestrator` SKILL.md step 7) specifies **subagent-driven-development** as the execution path, with role-flavored implementers dispatched by `task_role_tags`. That's the path this plan was written for.

---

## Reviewer notes

- Total tasks: 14.
- Tasks per role: backend (10), qa (8), docs (1). Tasks frequently carry 2 roles where natural.
- Test-pressure check: every task has a written-first failing test EXCEPT Task 11 (harness, exercised end-to-end by Task 13's integration run) and Task 14 (the run itself). Both exceptions are explicit and reasoned.
- No new dependencies introduced.
- No mocking of services anywhere — pure-function tests use fixture data; HTTP-touching code is exercised by integration only.
- The 90s/120s wall-clock deadlines are env-overridable (Task 4) per spec-reviewer note #1.
- Probe prompts demand verbatim echo for memory/secrets (Task 10) per spec-reviewer note #2.
