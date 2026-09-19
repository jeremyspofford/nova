# S40 plan, part: T1 and T2 (gateway migration 009, compute identity, engines, builtin rename)

## What 009 rewrites and what it keeps

I checked every provider-name column in gateway migrations 001–008 at HEAD `6abf58fa`.

| Table.column | Where | Holds | 009 does |
|---|---|---|---|
| `providers.name` | 003:15 | the builtin row `'ollama'` (003:50) | **Renames** it to `hub`. This only runs while a builtin named `ollama` exists. |
| `provider_walls.provider` | 006:18 (FK, no ON UPDATE) | walls | **Deletes** the `ollama` rows. They are transient, and the FK would block the rename. |
| `routes.chain` | 006:11 (jsonb array of `provider:model`) | the owner's links | **Rewrites** `ollama:X` to `hub:X`. A resulting duplicate is kept once, at its first position. |
| `spend_caps.provider` | 005:48 (no FK) | owner setting | **Renames** `ollama` to `hub`. Any rows already keyed `hub` are deleted first: they can only be left over from a deleted provider. |
| `provider_prices.provider` | 005:59 (no FK) | owner, listing or curated prices | Same treatment as `spend_caps`. These rows are inert for a local provider (`usage.py:315`). Left as `ollama`, they would attach to any future provider named `ollama`. |
| `usage_events.provider`, `served_by` | 005:16-18 | ledger | **Kept** as `ollama`. It was true when written. `served_on` is added and stays NULL. |
| `probes.kind` / new `probes.provider` | 002:14, new | ledger | `kind` is kept. `provider` is backfilled with `'ollama'` where `kind='ollama'` (that row served them). `compute`, `runtime` and `path` stay NULL, so fit never reads these rows (the 008 precedent). |
| `providers.default_model` | 003:25 | a bare tag on its own row | Untouched. |

## Contract notes

Nothing in the fixed contract is impossible. Two things need saying:

1. **`BUILTIN` lives in `providers.py`.**
   - `engines.py` must import `providers`, so `BUILTIN = "hub"` is defined in `providers.py` and `engines.BUILTIN = providers.BUILTIN` (the same object).
   - `LIBRARY = "library"` and `RESERVED_NAMES` sit next to it. T4 should use `providers.LIBRARY` for `library:{slug}`.
2. **`bundled_accelerators(vram_reading: dict)` needs more than `uuid,name`.**
   - It needs every card's uuid and the card count. Otherwise two cards, one of which printed no uuid, would stamp the other one.
   - So `Vram.as_dict()` gains `uuid`, `name`, `uuids`, `cards` and `absent`, all additive.
   - `absent` is true only when there is no `nvidia-smi` in the container (no GPU passed through). It is what makes `fit_frame` `"ram"`. A GPU that exists but cannot be read stays `"vram"` and gets fit `unknown`; it is never treated as RAM.

**Extras that go beyond the contract (additive):**
- `engines.UnknownEngine(LookupError)`, `engines.to_public(row)`, `engines.forget(name)` (T3 uses it after a `ProviderUnreachable`), and `engines.resident(app, row)`.
- `engines.resident` is admin's `_resident_models` made per-row. Its entries also carry `size` and `size_vram`, which T3/T4 need for `served_on`. T4 should point `admin._resident_models` at it.
- `GET /admin/engines/{name}` also accepts `?live=`.

**Design choices:**
- `EngineView.compute` means: *the `served_on` a model fully resident on this engine would be stamped with*. That is the key fit reads probes by.
  - No GPU passed through gives `cpu:…`.
  - Exactly one nameable card gives `gpu:cuda:…`.
  - Otherwise it is `None`.
- The D10 text says a container's `cpu:` comes from `docker info`. The gateway has no docker socket. Instead it reads `/proc` inside the gateway container, which shares the docker host with the bundled ollama and gives the same `NCPU`/`MemTotal`.

## Sequencing (read before running)

- T1's migration renames the builtin, but the code still seeds `'ollama'`.
  - After T1, every gateway test that uses the `pool` fixture errors with `CheckViolationError … providers_hub_is_the_builtin`, raised from `ensure_builtin`.
  - T1's commit is green only on its own targeted tests. T2's commit restores the full gateway suite.
  - T1 and T2 are executed back to back and pushed together; do not bisect between them.
- T2 also does a **name-only bridge** at the seven hard-coded `get_row(pool, "ollama")` sites that T3/T4 own: `routing.py:291,367`, `catalog.py:340,463,574` and `admin.py:665,1141`, plus `admin.py:702-703`. This keeps T3 and T4 starting from a green suite; they replace those lines with per-engine logic.
- **Leave the worktree's unrelated uncommitted core changes unstaged:** `services/core/app/chat.py`, `pyproject.toml`, `uv.lock`, `tests/test_chat_agents.py`, `tests/test_timers_api.py` and `tests/test_chat_background.py`. Every `git add` below is by path.

---

### Task 1: gateway migration 009 + `compute_id` + golden vectors + `devices_vram` uuid/name

**Files:**
- Create: `services/gateway/migrations/009_engines.sql`
- Create: `services/gateway/app/compute_id.py`
- Create: `docs/contracts/compute_id_vectors.json` (the `docs/contracts/` directory is new)
- Modify: `services/gateway/app/devices_vram.py`
  - `:25-42` docstring (add a section)
  - `:60` `_QUERY`
  - `:63-103` `Vram`
  - `:106-141` `parse`
  - `:153-163` `read_vram`
- Modify: `services/gateway/tests/conftest.py:26-34` (`_TABLES`)
- Modify: `services/gateway/tests/test_providers.py`
  - `:562` (`_migrate_to` drop list)
  - `:653`
  - `:663-683` (the migration-003 expectations now pass through 009)
- Test: create `services/gateway/tests/test_compute_id.py` and `services/gateway/tests/test_migration_009_engines.py`; modify `services/gateway/tests/test_devices_vram.py` (`:101-122` moves, new tests appended)

**Interfaces:**
- Consumes: nothing new.
- Produces, in `compute_id`:
  - `CPU_RE`, `GPU_RE`, `MAX_DEVICES = 4`
  - `def cpu_slug(cpuinfo_text: str, meminfo_text: str, nproc: int) -> str` (raises `ValueError` when it cannot name the CPU)
  - `def gpu_cuda(uuid: str) -> str`
  - `def served_on(size: int | None, size_vram: int | None, accelerators: list[str], cpu: str | None) -> str | None`
  - `def parse(value: str) -> list[str]`
  - `def bundled_accelerators(vram_reading: dict) -> list[str]`
- Produces, in `devices_vram`:
  - `Vram` gains `.uuid .name .uuids .cards .absent`.
  - `as_dict()` gains the keys `uuid, name, uuids, cards, absent`.
  - `_QUERY = "memory.total,memory.used,memory.free,utilization.gpu,uuid,name"`.
- Produces, in the database:
  - providers: `hub` is the builtin; constraints `providers_name_not_reserved`, `providers_hub_is_the_builtin` and `providers_engine_link_has_token`.
  - `engines` and `engine_models` tables.
  - `probes.provider/compute/runtime/path` with `probes_runtime_is_known`, `probes_path_is_known`, `probes_compute_not_empty` and index `probes_compute_model`.
  - `usage_events.served_on` with `usage_served_on_not_empty`.

- [ ] **Step 0: scratch DB for this task**
```bash
docker exec nova-scratch-pg psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='nova_gateway_s40_t1'" | grep -q 1 || docker exec nova-scratch-pg createdb -U postgres nova_gateway_s40_t1
```

- [ ] **Step 1: write the golden vectors** — `docs/contracts/compute_id_vectors.json` (arithmetic checked: 32767128 kB→31, 16106744→15, 16252928→16 (exactly 15.5), 16252927→15, 65755000→63, 131915000→126, 8245632→8)
```json
{
  "version": 1,
  "about": "D10 compute identity (docs/plans/rebuild/hub/r2-integration.md). services/gateway/tests/test_compute_id.py reads this file now; the Go agent's tests read the same file from S44, so both implementations are pinned by the same cases. Every uuid, CPU and memory size here is synthetic: the repo is public.",
  "grammar": "served_on := dev(\"+\"dev)* sorted, unique, at most 4, at most one cpu; dev := gpu:cuda:<uuid|pci-vvvv-dddd|<GiB>g> | gpu:rocm:<uuid|pci-vvvv-dddd|<GiB>g> | gpu:vulkan:pci-vvvv-dddd|<GiB>g | gpu:metal:<chip>|<gc>gc|<GiB>g | cpu:<slug>|<n>c|<GiB>g",
  "gib_rounding": "half up: floor(MemTotal_kB / 1048576 + 0.5)",
  "max_devices": 4,
  "cpu_slug": [
    {"name": "x86 in a WSL2 VM", "cpuinfo": "processor\t: 0\nvendor_id\t: GenuineIntel\nmodel\t\t: 151\nmodel name\t: 12th Gen Intel(R) Core(TM) i9-12900K\n", "meminfo": "MemTotal:       32767128 kB\nMemFree:         1048576 kB\n", "nproc": 24, "expect": "cpu:12th-gen-intel-core-i9-12900k|24c|31g"},
    {"name": "mini PC", "cpuinfo": "processor\t: 0\nmodel name\t: Intel(R) N150\n", "meminfo": "MemTotal:       16106744 kB\n", "nproc": 4, "expect": "cpu:intel-n150|4c|15g"},
    {"name": "exactly half a GiB rounds up", "cpuinfo": "model name\t: Intel(R) N150\n", "meminfo": "MemTotal:       16252928 kB\n", "nproc": 4, "expect": "cpu:intel-n150|4c|16g"},
    {"name": "just under half rounds down", "cpuinfo": "model name\t: Intel(R) N150\n", "meminfo": "MemTotal:       16252927 kB\n", "nproc": 4, "expect": "cpu:intel-n150|4c|15g"},
    {"name": "AMD", "cpuinfo": "model name\t: AMD Ryzen 9 5900X 12-Core Processor\n", "meminfo": "MemTotal:       65755000 kB\n", "nproc": 24, "expect": "cpu:amd-ryzen-9-5900x-12-core-processor|24c|63g"},
    {"name": "trademarks and a clock speed", "cpuinfo": "model name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz\n", "meminfo": "MemTotal:      131915000 kB\n", "nproc": 56, "expect": "cpu:intel-xeon-cpu-e5-2680-v4-2-40ghz|56c|126g"},
    {"name": "arm64 with only a Model line", "cpuinfo": "processor\t: 0\nBogoMIPS\t: 108.00\n\nModel\t\t: Raspberry Pi 5 Model B Rev 1.0\n", "meminfo": "MemTotal:        8245632 kB\n", "nproc": 4, "expect": "cpu:raspberry-pi-5-model-b-rev-1-0|4c|8g"}
  ],
  "cpu_slug_errors": [
    {"name": "no model line", "cpuinfo": "processor\t: 0\n", "meminfo": "MemTotal: 16106744 kB\n", "nproc": 4},
    {"name": "no MemTotal", "cpuinfo": "model name\t: Intel(R) N150\n", "meminfo": "MemFree: 5 kB\n", "nproc": 4},
    {"name": "no CPUs", "cpuinfo": "model name\t: Intel(R) N150\n", "meminfo": "MemTotal: 16106744 kB\n", "nproc": 0},
    {"name": "a model that slugs to nothing", "cpuinfo": "model name\t: (R)(TM)\n", "meminfo": "MemTotal: 16106744 kB\n", "nproc": 4}
  ],
  "gpu_cuda": [
    {"name": "as nvidia-smi prints it", "uuid": "GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f", "expect": "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"},
    {"name": "upper-case hex", "uuid": "GPU-5F3B8B36-0D6E-4C1A-9F2E-7A1B2C3D4E5F", "expect": "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"},
    {"name": "padded", "uuid": " GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f ", "expect": "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"}
  ],
  "gpu_cuda_errors": ["[N/A]", "", "MIG-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f", "GPU-5f3b8b36", "5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"],
  "served_on": [
    {"name": "fully on the one GPU", "size": 5000000000, "size_vram": 5000000000, "accelerators": ["gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"], "cpu": "cpu:intel-n150|4c|15g", "expect": "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"},
    {"name": "partial offload names both", "size": 20000000000, "size_vram": 15000000000, "accelerators": ["gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"], "cpu": "cpu:intel-n150|4c|15g", "expect": "cpu:intel-n150|4c|15g+gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"},
    {"name": "size_vram 0 is the cpu even beside a GPU", "size": 5000000000, "size_vram": 0, "accelerators": ["gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"], "cpu": "cpu:intel-n150|4c|15g", "expect": "cpu:intel-n150|4c|15g"},
    {"name": "no accelerator, on the cpu", "size": 5000000000, "size_vram": 0, "accelerators": [], "cpu": "cpu:intel-n150|4c|15g", "expect": "cpu:intel-n150|4c|15g"},
    {"name": "more than one accelerator is omitted", "size": 5000000000, "size_vram": 5000000000, "accelerators": ["gpu:cuda:GPU-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"], "cpu": "cpu:intel-n150|4c|15g", "expect": null},
    {"name": "on a GPU nobody can name is omitted", "size": 5000000000, "size_vram": 5000000000, "accelerators": [], "cpu": "cpu:intel-n150|4c|15g", "expect": null},
    {"name": "partial with the cpu unknown is omitted", "size": 20000000000, "size_vram": 15000000000, "accelerators": ["gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"], "cpu": null, "expect": null},
    {"name": "no size_vram reading is omitted", "size": 5000000000, "size_vram": null, "accelerators": ["gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"], "cpu": "cpu:intel-n150|4c|15g", "expect": null},
    {"name": "on the cpu with the cpu unknown is omitted", "size": 5000000000, "size_vram": 0, "accelerators": [], "cpu": null, "expect": null},
    {"name": "size unknown cannot tell partial from full", "size": null, "size_vram": 5000000000, "accelerators": ["gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"], "cpu": "cpu:intel-n150|4c|15g", "expect": null},
    {"name": "size_vram above size is still fully on the GPU", "size": 4000000000, "size_vram": 5000000000, "accelerators": ["gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"], "cpu": "cpu:intel-n150|4c|15g", "expect": "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"}
  ],
  "parse_valid": [
    {"value": "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f", "expect": ["gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"]},
    {"value": "cpu:intel-n150|4c|15g+gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f", "expect": ["cpu:intel-n150|4c|15g", "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"]},
    {"value": "gpu:metal:apple-m2-max|38gc|64g", "expect": ["gpu:metal:apple-m2-max|38gc|64g"]},
    {"value": "gpu:rocm:GPU-5b2e33f4b5c4d7a9", "expect": ["gpu:rocm:GPU-5b2e33f4b5c4d7a9"]},
    {"value": "gpu:vulkan:pci-8086-46d0|15g", "expect": ["gpu:vulkan:pci-8086-46d0|15g"]},
    {"value": "gpu:cuda:pci-10de-2204|24g", "expect": ["gpu:cuda:pci-10de-2204|24g"]},
    {"value": "cpu:intel-n150|4c|15g+gpu:cuda:GPU-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d+gpu:cuda:GPU-1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d+gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f", "expect": ["cpu:intel-n150|4c|15g", "gpu:cuda:GPU-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "gpu:cuda:GPU-1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"]}
  ],
  "parse_invalid": [
    "",
    "gpu:cuda:GPU-5f3b8b36",
    "gpu:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f",
    "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f+cpu:intel-n150|4c|15g",
    "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f+gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f",
    "cpu:intel-n150|0c|15g",
    "cpu:Intel-N150|4c|15g",
    "cpu:amd-x|8c|16g+cpu:intel-n150|4c|15g",
    "gpu:vulkan:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f",
    "gpu:cuda:GPU-5F3B8B36-0D6E-4C1A-9F2E-7A1B2C3D4E5F",
    "tpu:x",
    "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f ",
    "cpu:intel-n150|4c|15g+",
    "cpu:intel-n150|4c|15g+gpu:cuda:GPU-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d+gpu:cuda:GPU-1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d+gpu:cuda:GPU-2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d+gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"
  ]
}
```

- [ ] **Step 2: failing test** — `services/gateway/tests/test_compute_id.py`
```python
"""app/compute_id.py — D10, the one grammar for which hardware produced a number.

Every shared case lives in docs/contracts/compute_id_vectors.json, the file the
Go agent's tests read from S44: both implementations are pinned by the SAME
cases, so neither can drift without a red test. bundled_accelerators is the
gateway's own reading (one nvidia-smi call), so its cases live here.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import compute_id, devices_vram

VECTORS_PATH = (
    Path(__file__).resolve().parents[3] / "docs" / "contracts" / "compute_id_vectors.json"
)
VECTORS = json.loads(VECTORS_PATH.read_text())
UUID_A = "GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"
UUID_B = "GPU-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"


def _named(cases: list[dict]) -> list[str]:
    return [case["name"] for case in cases]


def test_the_vectors_are_the_version_this_code_implements():
    assert VECTORS["version"] == 1
    assert VECTORS["max_devices"] == compute_id.MAX_DEVICES == 4


@pytest.mark.parametrize("case", VECTORS["cpu_slug"], ids=_named(VECTORS["cpu_slug"]))
def test_cpu_slug(case):
    got = compute_id.cpu_slug(case["cpuinfo"], case["meminfo"], case["nproc"])
    assert got == case["expect"]
    assert compute_id.CPU_RE.fullmatch(got)


@pytest.mark.parametrize(
    "case", VECTORS["cpu_slug_errors"], ids=_named(VECTORS["cpu_slug_errors"])
)
def test_a_cpu_it_cannot_name_is_refused_never_guessed(case):
    with pytest.raises(ValueError):
        compute_id.cpu_slug(case["cpuinfo"], case["meminfo"], case["nproc"])


@pytest.mark.parametrize("case", VECTORS["gpu_cuda"], ids=_named(VECTORS["gpu_cuda"]))
def test_gpu_cuda(case):
    assert compute_id.gpu_cuda(case["uuid"]) == case["expect"]


@pytest.mark.parametrize("uuid", VECTORS["gpu_cuda_errors"])
def test_a_uuid_that_is_not_one_is_refused(uuid):
    with pytest.raises(ValueError):
        compute_id.gpu_cuda(uuid)


@pytest.mark.parametrize("case", VECTORS["served_on"], ids=_named(VECTORS["served_on"]))
def test_the_stamp_rule(case):
    got = compute_id.served_on(case["size"], case["size_vram"], case["accelerators"], case["cpu"])
    assert got == case["expect"]
    if got is not None:
        assert "+".join(compute_id.parse(got)) == got


@pytest.mark.parametrize("case", VECTORS["parse_valid"], ids=[c["value"][:40] for c in VECTORS["parse_valid"]])
def test_parse(case):
    assert compute_id.parse(case["value"]) == case["expect"]


@pytest.mark.parametrize("value", VECTORS["parse_invalid"])
def test_parse_refuses_what_the_grammar_does_not_say(value):
    with pytest.raises(ValueError):
        compute_id.parse(value)


def test_served_on_refuses_a_device_outside_the_grammar():
    """Its inputs come from gpu_cuda/cpu_slug; anything else is a bug, and a
    bug must not become a row that means something new."""
    with pytest.raises(ValueError):
        compute_id.served_on(5, 5, ["gpu:GPU-x"], None)
    with pytest.raises(ValueError):
        compute_id.served_on(5, 0, [], "intel-n150")


def test_one_card_is_one_accelerator():
    reading = devices_vram.parse(f"24576, 2662, 21914, 3, {UUID_A}, NVIDIA GeForce RTX 3090\n")
    assert compute_id.bundled_accelerators(reading.as_dict()) == [f"gpu:cuda:{UUID_A}"]


def test_two_cards_are_two_accelerators_and_so_no_model_is_stamped_on_either():
    reading = devices_vram.parse(
        f"24576, 2662, 21914, 3, {UUID_A}, NVIDIA GeForce RTX 3090\n"
        f"8192, 100, 8092, 0, {UUID_B}, NVIDIA GeForce RTX 3060 Ti\n"
    ).as_dict()
    accelerators = compute_id.bundled_accelerators(reading)
    assert accelerators == sorted([f"gpu:cuda:{UUID_A}", f"gpu:cuda:{UUID_B}"])
    assert compute_id.served_on(5, 5, accelerators, "cpu:intel-n150|4c|15g") is None


def test_a_card_that_printed_no_uuid_makes_the_set_unnameable():
    """Naming only the card that did print one would stamp a model that may
    have run on the other: omitted, never guessed."""
    mixed = devices_vram.parse(
        f"24576, 2662, 21914, 3, {UUID_A}, NVIDIA GeForce RTX 3090\n8192, 100, 8092, 0, [N/A], X\n"
    )
    assert compute_id.bundled_accelerators(mixed.as_dict()) == []
    old_driver = devices_vram.parse("24576, 2662, 21914\n")
    assert compute_id.bundled_accelerators(old_driver.as_dict()) == []


def test_no_gpu_passed_through_is_no_accelerator():
    none = devices_vram.Vram(reason="nvidia-smi could not be run", absent=True)
    assert compute_id.bundled_accelerators(none.as_dict()) == []
```

- [ ] **Step 3: failing tests** — append to `services/gateway/tests/test_devices_vram.py`
```python
# ── Which card (S40, D10) ────────────────────────────────────────────────
#
# A measurement is only meaningful with the hardware it was taken on. The
# uuid names the card; `cards` counts every line nvidia-smi printed, so a
# card that printed no uuid is still a card; `absent` says there is no GPU
# at all, which is a different fact from "the GPU could not be read".

UUID = "GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"
UUID_B = "GPU-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"


def test_the_query_appends_uuid_and_name_after_utilisation():
    """Appended, never inserted: memory stays fields 1-3 and utilisation 4 on
    every driver, so an old answer still lines up field by field."""
    assert devices_vram._QUERY == "memory.total,memory.used,memory.free,utilization.gpu,uuid,name"


def test_the_card_says_which_card_it_is():
    vram = devices_vram.parse(f"24576, 2662, 21914, 3, {UUID}, NVIDIA GeForce RTX 3090\n")
    assert (vram.uuid, vram.name) == (UUID, "NVIDIA GeForce RTX 3090")
    assert vram.uuids == (UUID,) and vram.cards == 1 and vram.absent is False


def test_the_biggest_card_brings_its_own_uuid_and_every_card_is_listed():
    vram = devices_vram.parse(
        f"8192, 1000, 7192, 5, {UUID_B}, Small\n24576, 17663, 6913, 99, {UUID}, Big\n"
    )
    assert (vram.total_mb, vram.uuid, vram.name) == (24576, UUID, "Big")
    assert vram.uuids == (UUID_B, UUID) and vram.cards == 2


def test_a_name_with_a_comma_is_kept_whole():
    vram = devices_vram.parse(f"24576, 2662, 21914, 3, {UUID}, Some Card, Rev 2\n")
    assert vram.name == "Some Card, Rev 2"


def test_a_line_without_a_uuid_is_a_card_with_no_identity():
    vram = devices_vram.parse("24576, 2662, 21914, 3\n")
    assert vram.known and vram.cards == 1 and vram.uuids == () and vram.uuid is None


def test_an_unreadable_card_still_counts_as_a_card():
    vram = devices_vram.parse(f"[N/A], [N/A], [N/A], [N/A], {UUID_B}, Broken\n24576, 2662, 21914, 3, {UUID}, Big\n")
    assert vram.cards == 2 and vram.uuids == (UUID_B, UUID) and vram.uuid == UUID


async def test_no_binary_means_no_gpu_was_passed_through(monkeypatch):
    async def _missing(*args, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", "nvidia-smi")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _missing)
    vram = await devices_vram.read_vram()
    assert vram.absent is True and not vram.known and vram.cards == 0


async def test_a_binary_that_cannot_run_is_unknown_not_absent(monkeypatch):
    """The card is there and unreadable: saying "no GPU" about it would be
    the guess that fits a 24 GB model against system RAM."""

    async def _denied(*args, **kwargs):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _denied)
    vram = await devices_vram.read_vram()
    assert vram.absent is False and "Permission denied" in vram.reason
```
**Moves** in the same file: `test_a_good_read_answers_the_cards_numbers` (`:113-122`). The reading now says which card it is (S40, D10), so the expected dict grows:
```python
    assert vram.as_dict() == {
        "total_mb": 24576,
        "used_mb": 9662,
        "free_mb": 14914,
        "util_pct": None,
        "reason": None,
        # S40: three fields, no uuid — a card with no identity, counted.
        "uuid": None,
        "name": None,
        "uuids": [],
        "cards": 1,
        "absent": False,
    }
```

- [ ] **Step 4: failing test** — `services/gateway/tests/test_migration_009_engines.py`
```python
"""Migration 009 (S40): the bundled engine is `hub`, engines get their own
rows, and every measurement gains the columns that say what produced it.

The rule it encodes: SETTINGS follow the owner's intent (the row, its chain
links, its caps and prices are renamed); MEASUREMENTS keep the name that was
true when they were written (usage rows and probes still say 'ollama').
Walls are transient and go."""

from __future__ import annotations

import json
import shutil
from decimal import Decimal

import asyncpg
import pytest

import tests.conftest as conftest
from app.main import MIGRATIONS_DIR
from app.migrations_runner import run_migrations
from tests.conftest import TEST_DSN, requires_db

pytestmark = requires_db

MIGRATION = MIGRATIONS_DIR / "009_engines.sql"
GPU = "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"


async def _migrate_to(tmp_path, upto: int) -> None:
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            f"DROP TABLE IF EXISTS {', '.join(conftest._TABLES)}, backend_config CASCADE"
        )
        await conn.execute("DROP TABLE IF EXISTS schema_migrations")
    finally:
        await conn.close()
    partial = tmp_path / f"upto_{upto}"
    partial.mkdir(exist_ok=True)
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if int(path.name.split("_")[0]) <= upto:
            shutil.copy(path, partial / path.name)
    await run_migrations(TEST_DSN, partial)


@pytest.fixture
async def legacy(tmp_path):
    """A database exactly as S39 left it (001-008). Handed back afterwards:
    the next `pool` fixture rebuilds the suite's schema from empty."""
    await _migrate_to(tmp_path, 8)
    conn = await asyncpg.connect(TEST_DSN)
    try:
        yield conn
    finally:
        await conn.close()
        conftest._schema_built = False


async def _seed(conn) -> None:
    await conn.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key) VALUES "
        "('openrouter', 'openai-chat', 'https://openrouter.test/v1', 'static-bearer', 'sk-1')"
    )
    chains = {
        "chat": ["ollama:qwen3:4b", "openrouter:x/y", "qwen3:8b"],
        "judge": ["ollama:qwen3:8b"],
        # A stale `hub:` link (a provider since deleted) and its twin's rewrite
        # are the same link twice: kept once, where it came first.
        "scheduled": ["hub:qwen3:8b", "ollama:qwen3:8b", "ollama:qwen3:4b"],
        "vision": [],
    }
    for role, chain in chains.items():
        await conn.execute(
            "INSERT INTO routes (role, chain) VALUES ($1, $2::jsonb)", role, json.dumps(chain)
        )
    await conn.execute(
        "INSERT INTO provider_walls (provider, model, walled_until, reason, status) VALUES "
        "('ollama', 'qwen3.8:27b', now() + interval '1 hour', 'ollama:qwen3.8:27b refused', 502),"
        "('openrouter', '', now() + interval '1 hour', 'openrouter refused (402)', 402)"
    )
    await conn.execute(
        "INSERT INTO usage_events (provider, model, served_by, kind, purpose, duration_ms, "
        "local, status) VALUES ('ollama', 'qwen3:8b', 'ollama:qwen3:8b', 'completion', "
        "'chat', 1200, true, 200)"
    )
    await conn.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, frame) VALUES "
        "('qwen3:8b', 'ollama', true, 100, 9508, 'model'), "
        "('gpt-x', 'cloud', true, 300, NULL, 'model')"
    )
    await conn.execute(
        "INSERT INTO spend_caps (provider, monthly_usd) VALUES "
        "('ollama', 5), ('hub', 7), ('openrouter', 10)"
    )
    await conn.execute(
        "INSERT INTO provider_prices (provider, model, basis, prompt_usd_per_token, "
        "completion_usd_per_token, verified_at) VALUES "
        "('ollama', 'qwen3:8b', 'owner', 0.000001, 0.000002, now()), "
        "('hub', 'qwen3:8b', 'owner', 0.000009, 0.000009, now()), "
        "('openrouter', 'x/y', 'listing', 0.000001, 0.000002, now())"
    )


async def test_the_builtin_becomes_hub_its_settings_follow_and_history_keeps_its_name(legacy):
    await _seed(legacy)

    await run_migrations(TEST_DSN, MIGRATIONS_DIR)

    rows = await legacy.fetch(
        "SELECT name, adapter, builtin, is_default FROM providers ORDER BY name"
    )
    assert [tuple(r) for r in rows] == [
        ("hub", "ollama", True, True),
        ("openrouter", "openai-chat", False, False),
    ]
    chains = {
        r["role"]: json.loads(r["chain"]) for r in await legacy.fetch("SELECT role, chain FROM routes")
    }
    assert chains == {
        "chat": ["hub:qwen3:4b", "openrouter:x/y", "qwen3:8b"],
        "judge": ["hub:qwen3:8b"],
        "scheduled": ["hub:qwen3:8b", "hub:qwen3:4b"],
        "vision": [],
    }
    walls = await legacy.fetch("SELECT provider FROM provider_walls")
    assert [r["provider"] for r in walls] == ["openrouter"]
    usage = await legacy.fetchrow("SELECT provider, served_by, served_on FROM usage_events")
    assert tuple(usage) == ("ollama", "ollama:qwen3:8b", None)
    probes = await legacy.fetch(
        "SELECT model, kind, provider, compute, runtime, path FROM probes ORDER BY id"
    )
    assert [tuple(r) for r in probes] == [
        ("qwen3:8b", "ollama", "ollama", None, None, None),
        ("gpt-x", "cloud", None, None, None, None),
    ]
    caps = await legacy.fetch("SELECT provider, monthly_usd FROM spend_caps ORDER BY provider")
    assert [tuple(r) for r in caps] == [
        ("*", None),
        ("hub", Decimal("5.00")),
        ("openrouter", Decimal("10.00")),
    ]
    prices = await legacy.fetch(
        "SELECT provider, model, basis, prompt_usd_per_token FROM provider_prices "
        "ORDER BY provider"
    )
    assert [(r["provider"], r["model"], r["basis"]) for r in prices] == [
        ("hub", "qwen3:8b", "owner"),
        ("openrouter", "x/y", "listing"),
    ]
    assert prices[0]["prompt_usd_per_token"] == Decimal("0.000001")
    engine = await legacy.fetchrow(
        "SELECT provider, lifecycle, serving, hold_s, last_ready_at, last_tags, last_facts "
        "FROM engines"
    )
    assert tuple(engine) == ("hub", "always_on", True, 600, None, None, None)


async def _snapshot(conn) -> dict:
    async def rows(sql: str) -> list[tuple]:
        return [tuple(r) for r in await conn.fetch(sql)]

    return {
        "providers": await rows("SELECT name, builtin, is_default, updated_at FROM providers ORDER BY name"),
        "routes": await rows("SELECT role, chain, updated_at FROM routes ORDER BY role"),
        "engines": await rows("SELECT * FROM engines ORDER BY provider"),
        "caps": await rows("SELECT provider, monthly_usd FROM spend_caps ORDER BY provider"),
        "prices": await rows("SELECT provider, model, basis FROM provider_prices ORDER BY 1, 2, 3"),
        "probes": await rows("SELECT id, provider FROM probes ORDER BY id"),
        "constraints": await rows(
            "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid IN "
            "('providers'::regclass, 'engines'::regclass, 'engine_models'::regclass, "
            "'probes'::regclass, 'usage_events'::regclass) ORDER BY conname"
        ),
    }


async def test_running_009_a_second_time_changes_nothing(legacy):
    await _seed(legacy)
    await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    before = await _snapshot(legacy)

    await legacy.execute(MIGRATION.read_text())

    assert await _snapshot(legacy) == before


@pytest.mark.parametrize(
    ("name", "words"),
    [
        ("hub", 'a provider named "hub" already exists'),
        ("library", 'a provider named "library" already exists'),
    ],
)
async def test_a_provider_already_holding_a_reserved_name_stops_the_migration(
    legacy, name, words
):
    """A cloud provider called `hub` would be captured: its `hub:x` links would
    start meaning the bundled engine. Refused in words, nothing half-done."""
    await legacy.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape) "
        "VALUES ($1, 'openai-chat', 'https://x.test/v1', 'none')",
        name,
    )
    with pytest.raises(asyncpg.exceptions.RaiseError, match=words):
        await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    names = sorted(r["name"] for r in await legacy.fetch("SELECT name FROM providers"))
    assert names == sorted([name, "ollama"])
    assert (
        await legacy.fetchval(
            "SELECT count(*) FROM schema_migrations WHERE filename = '009_engines.sql'"
        )
        == 0
    )


async def test_the_new_rows_refuse_what_they_cannot_mean(legacy):
    await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    usage = (
        "INSERT INTO usage_events (provider, model, served_by, kind, purpose, duration_ms, "
        "local, status, served_on) VALUES ('hub', 'm', 'hub:m', 'completion', 'chat', 1, "
        "true, 200, '')"
    )
    refused = [
        (
            "INSERT INTO providers (name, adapter, base_url, auth_shape) "
            "VALUES ('library', 'openai-chat', 'https://x.test/v1', 'none')",
            "providers_name_not_reserved",
        ),
        (
            "INSERT INTO providers (name, adapter, base_url, auth_shape) "
            "VALUES ('dell', 'ollama', 'https://dell.test', 'none')",
            "providers_engine_link_has_token",
        ),
        (
            "INSERT INTO providers (name, adapter, base_url, auth_shape, builtin) "
            "VALUES ('box', 'ollama', '', 'none', true)",
            "providers_hub_is_the_builtin",
        ),
        ("UPDATE engines SET hold_s = 30", "engines_hold_s_bounded"),
        ("UPDATE engines SET hold_s = 1801", "engines_hold_s_bounded"),
        ("UPDATE engines SET lifecycle = 'sometimes'", "engines_lifecycle_is_known"),
        ("UPDATE engines SET last_tags = '{}'::jsonb", "engines_tags_dated"),
        ("UPDATE engines SET last_facts_at = now()", "engines_facts_dated"),
        (
            "INSERT INTO probes (model, kind, ok, runtime) VALUES ('m', 'ollama', true, 'docker')",
            "probes_runtime_is_known",
        ),
        (
            "INSERT INTO probes (model, kind, ok, path) VALUES ('m', 'ollama', true, 'local')",
            "probes_path_is_known",
        ),
        (
            "INSERT INTO probes (model, kind, ok, compute) VALUES ('m', 'ollama', true, '')",
            "probes_compute_not_empty",
        ),
        (usage, "usage_served_on_not_empty"),
    ]
    for sql, constraint in refused:
        with pytest.raises(asyncpg.exceptions.CheckViolationError, match=constraint):
            await legacy.execute(sql)
    # What the columns ARE for goes in.
    await legacy.execute(
        "INSERT INTO probes (model, kind, ok, provider, compute, runtime, path) VALUES "
        "('qwen3:8b', 'ollama', true, 'hub', $1, 'container', 'internal')",
        GPU,
    )
    await legacy.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key) "
        "VALUES ('dell', 'ollama', 'https://dell.test', 'static-bearer', 'tok')"
    )


async def test_an_engine_and_its_models_follow_their_provider_row(legacy):
    await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    await legacy.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key) "
        "VALUES ('dell', 'ollama', 'https://dell.test', 'static-bearer', 'tok')"
    )
    await legacy.execute("INSERT INTO engines (provider, lifecycle) VALUES ('dell', 'wake_on_lan')")
    await legacy.execute(
        "INSERT INTO engine_models (provider, name, digest, capabilities, context_length) "
        "VALUES ('dell', 'qwen3.8:27b', 'sha256:ab', $1::jsonb, 40960)",
        json.dumps(["completion", "tools"]),
    )
    await legacy.execute("UPDATE providers SET name = 'xps' WHERE name = 'dell'")
    assert await legacy.fetchval("SELECT provider FROM engines WHERE lifecycle = 'wake_on_lan'") == "xps"
    assert await legacy.fetchval("SELECT provider FROM engine_models") == "xps"
    await legacy.execute("DELETE FROM providers WHERE name = 'xps'")
    assert await legacy.fetchval("SELECT count(*) FROM engines WHERE provider = 'xps'") == 0
    assert await legacy.fetchval("SELECT count(*) FROM engine_models") == 0


async def test_fit_reads_probes_by_compute_through_an_index_of_its_own(legacy):
    await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    indexdef = await legacy.fetchval(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'probes_compute_model'"
    )
    assert "(compute, model, created_at DESC)" in indexdef
    assert "WHERE (ok AND (frame = 'model'::text))" in indexdef
```
**Existing tests this migration breaks, which move in this task:**
- `tests/conftest.py:26-34`: `_TABLES` gains `"engine_models", "engines"` (put them before `"providers"`). Reason: without them the suite's rebuild keeps an FK-less `engines` table.
- `tests/test_providers.py:562`: the `_migrate_to` drop list becomes `"DROP TABLE IF EXISTS providers, probes, backend_config, engines, engine_models CASCADE"`.
- `tests/test_providers.py:653`: becomes `assert by_name["hub"]["builtin"] is True and by_name["hub"]["is_default"] is False`. Reason: the whole set now includes 009, so the builtin 003 created arrives as `hub`.
- `tests/test_providers.py:663,683`: rename the test to `test_migration_003_then_009_on_a_fresh_or_ollama_install_leaves_hub_default` and expect `[("hub", True)]`.

- [ ] **Step 5: run red**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t1 uv run pytest tests/test_compute_id.py tests/test_devices_vram.py tests/test_migration_009_engines.py tests/test_providers.py -k "compute_id or vram or migration" -q
```
Expected failures:
- `test_compute_id.py` fails at collection (`ImportError: cannot import name 'compute_id'`).
- The devices_vram tests fail with `AttributeError: 'Vram' object has no attribute 'uuid'` and on the `_QUERY` assertion.
- The migration tests fail with `assert ('ollama', ...) == ('hub', ...)` or `relation "engines" does not exist`.
- The two migration-003 tests fail on `'hub'`.

- [ ] **Step 6: implement** — `services/gateway/app/compute_id.py`
```python
"""Compute identity (D10): the one grammar for which hardware produced a number.

Defined once, before any row carries it, because a measurement's meaning is
fixed by the row it was written into. A probe taken on the 3090 must never be
read as the N150's, and no migration can relabel history it cannot see
(docs/plans/rebuild/hub/r1-engines-design.md, "Model identity across the move").

    served_on := dev ("+" dev)*     sorted, unique, at most 4, at most one cpu
    dev       := gpu:cuda:<key> | gpu:rocm:<key> | gpu:vulkan:pci-vvvv-dddd|<GiB>g
               | gpu:metal:<chip>|<gc>gc|<GiB>g | cpu:<slug>|<n>c|<GiB>g
    key       := the CUDA/ROCm uuid, else pci-vvvv-dddd|<GiB>g

The stamp rule (`served_on`): size_vram == 0 -> the cpu alone; size_vram > 0
with exactly one accelerator -> that device, plus the cpu when size_vram <
size; anything else -> None. Omitted, never guessed. The runtime
(container|native|wsl) is recorded BESIDE it, never inside it.

docs/contracts/compute_id_vectors.json holds the golden vectors: the gateway's
tests read them now and the Go agent's tests read the same file from S44.
"""

from __future__ import annotations

import re

MAX_DEVICES = 4
_KIB_PER_GIB = 1024 * 1024
_SLUG = r"[a-z0-9]+(?:-[a-z0-9]+)*"
_COUNT = r"[1-9][0-9]*"
_CUDA_UUID = r"GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_ROCM_UUID = r"GPU-[0-9a-f]{16}"
_PCI = rf"pci-[0-9a-f]{{4}}-[0-9a-f]{{4}}\|{_COUNT}g"

CPU_RE = re.compile(rf"cpu:{_SLUG}\|{_COUNT}c\|{_COUNT}g")
GPU_RE = re.compile(
    rf"gpu:(?:cuda:(?:{_CUDA_UUID}|{_PCI})"
    rf"|rocm:(?:{_CUDA_UUID}|{_ROCM_UUID}|{_PCI})"
    rf"|vulkan:{_PCI}"
    rf"|metal:{_SLUG}\|{_COUNT}gc\|{_COUNT}g)"
)

# x86 kernels print `model name`; arm64 kernels without it print `Model`.
_MODEL_KEYS = ("model name", "Model")
_TRADEMARKS = re.compile(r"\((?:r|tm|c)\)")
_NOT_SLUG = re.compile(r"[^a-z0-9]+")


def _field(text: str, key: str) -> str | None:
    for line in text.splitlines():
        name, sep, value = line.partition(":")
        if sep and name.strip() == key and value.strip():
            return value.strip()
    return None


def _slugify(text: str) -> str:
    return _NOT_SLUG.sub("-", _TRADEMARKS.sub(" ", text.lower())).strip("-")


def cpu_slug(cpuinfo_text: str, meminfo_text: str, nproc: int) -> str:
    """`cpu:<slug>|<n>c|<GiB>g` from /proc/cpuinfo, /proc/meminfo and the
    logical CPU count. <GiB> is MemTotal rounded half UP (the same in Go).
    Raises ValueError when any part cannot be named — the caller omits it."""
    model = next((v for v in (_field(cpuinfo_text, k) for k in _MODEL_KEYS) if v), None)
    if model is None:
        raise ValueError("/proc/cpuinfo names no CPU model (no 'model name' or 'Model' line)")
    slug = _slugify(model)
    if not slug:
        raise ValueError(f"the CPU model {model!r} has nothing a slug can keep")
    total = _field(meminfo_text, "MemTotal")
    kib = total.split()[0] if total else ""
    if not kib.isdigit():
        raise ValueError("/proc/meminfo carries no MemTotal")
    gib = (2 * int(kib) + _KIB_PER_GIB) // (2 * _KIB_PER_GIB)
    if gib < 1:
        raise ValueError(f"MemTotal {kib} kB is under half a GiB")
    if not isinstance(nproc, int) or isinstance(nproc, bool) or nproc < 1:
        raise ValueError(f"a CPU count must be a positive integer — got {nproc!r}")
    return f"cpu:{slug}|{nproc}c|{gib}g"


def gpu_cuda(uuid: str) -> str:
    """`gpu:cuda:<uuid>` exactly as nvidia-smi prints it (`GPU-` + lower hex)."""
    text = uuid.strip() if isinstance(uuid, str) else ""
    if text[:4].upper() == "GPU-":
        text = "GPU-" + text[4:].lower()
    if not re.fullmatch(_CUDA_UUID, text):
        raise ValueError(f"not a CUDA device uuid: {uuid!r}")
    return f"gpu:cuda:{text}"


def _device(value: str) -> str:
    if not (CPU_RE.fullmatch(value) or GPU_RE.fullmatch(value)):
        raise ValueError(f"{value!r} is not a device in the D10 grammar")
    return value


def served_on(
    size: int | None, size_vram: int | None, accelerators: list[str], cpu: str | None
) -> str | None:
    """The stamp for one model on one engine (see the module docstring).
    `size`/`size_vram` are ollama's /api/ps numbers for that model — vendor
    neutral, and the truth about offload. None means omitted."""
    for accelerator in accelerators:
        if not GPU_RE.fullmatch(accelerator):
            raise ValueError(f"{accelerator!r} is not an accelerator in the D10 grammar")
    if cpu is not None and not CPU_RE.fullmatch(cpu):
        raise ValueError(f"{cpu!r} is not a cpu in the D10 grammar")
    if size_vram is None or size_vram < 0:
        return None
    if size_vram == 0:
        devices = [cpu] if cpu is not None else []
    elif len(accelerators) == 1:
        if size is None:
            return None  # partial offload cannot be told from full
        devices = [accelerators[0]]
        if size_vram < size:
            if cpu is None:
                return None  # half the set is not the set
            devices.append(cpu)
    else:
        return None  # none nameable, or more than one: which one is not known
    if not devices or len(devices) > MAX_DEVICES:
        return None
    return "+".join(sorted(devices))


def parse(value: str) -> list[str]:
    """The devices a served_on/compute value names, or ValueError."""
    if not isinstance(value, str) or not value:
        raise ValueError("an empty compute id names nothing")
    devices = value.split("+")
    if len(devices) > MAX_DEVICES:
        raise ValueError(f"more than {MAX_DEVICES} devices is omitted, never written")
    for device in devices:
        _device(device)
    if devices != sorted(set(devices)):
        raise ValueError("devices must be sorted and unique")
    if sum(device.startswith("cpu:") for device in devices) > 1:
        raise ValueError("one machine has one cpu entry")
    return devices


def bundled_accelerators(vram_reading: dict) -> list[str]:
    """The bundled engine's accelerator set from one devices_vram reading
    (`Vram.as_dict()`). The set is named only when EVERY card nvidia-smi
    listed printed a CUDA uuid; a nameless card makes it [] — and with
    size_vram > 0, served_on then omits rather than naming the wrong card."""
    uuids = list(vram_reading.get("uuids") or [])
    cards = vram_reading.get("cards") or 0
    if not cards or len(uuids) != cards:
        return []
    try:
        return sorted(gpu_cuda(uuid) for uuid in uuids)
    except ValueError:
        return []
```

- [ ] **Step 7: implement** — edits to `services/gateway/app/devices_vram.py`

Docstring: insert a section after `:41`:
```
## Which card (S40)
A number is only meaningful with the hardware it was taken on (D10,
app/compute_id.py). The reading therefore carries the biggest card's own
uuid and name, every card's uuid, and how many cards nvidia-smi listed — a
card that printed no uuid is still counted, because a set with a nameless
card in it cannot be named. `absent` says there is no nvidia-smi in this
container at all (no GPU passed through): a fact, and a different one from
"the card is there and could not be read".
```

`:60`:
```python
_QUERY = "memory.total,memory.used,memory.free,utilization.gpu,uuid,name"
```

Replace `Vram` (`:63-103`):
```python
class Vram:
    """One card's live memory, in MiB, or an honest reason it is unknown —
    plus which card it is (S40). A degraded reading is `total_mb is None`
    WITH a `reason`, never zeros and never a stale number."""

    __slots__ = (
        "total_mb", "used_mb", "free_mb", "util_pct", "reason",
        "uuid", "name", "uuids", "cards", "absent",
    )

    def __init__(
        self,
        total_mb: float | None = None,
        used_mb: float | None = None,
        free_mb: float | None = None,
        util_pct: float | None = None,
        reason: str | None = None,
        *,
        uuid: str | None = None,
        name: str | None = None,
        uuids: tuple[str, ...] | list[str] = (),
        cards: int = 0,
        absent: bool = False,
    ) -> None:
        self.total_mb = total_mb
        self.used_mb = used_mb
        self.free_mb = free_mb
        # None, never 0: a driver that did not report it has not told us the
        # card is idle.
        self.util_pct = util_pct
        self.reason = reason
        self.uuid = uuid
        self.name = name
        self.uuids = tuple(uuids)
        self.cards = cards
        self.absent = absent

    @property
    def known(self) -> bool:
        return self.total_mb is not None and self.free_mb is not None

    def as_dict(self) -> dict:
        return {
            "total_mb": self.total_mb,
            "used_mb": self.used_mb,
            "free_mb": self.free_mb,
            "util_pct": self.util_pct,
            "reason": self.reason,
            "uuid": self.uuid,
            "name": self.name,
            "uuids": list(self.uuids),
            "cards": self.cards,
            "absent": self.absent,
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Vram({self.as_dict()})"
```
The existing ruff format will re-wrap `__slots__`.

Replace the body of `parse` (`:119-141`) and keep its docstring. Add one sentence to that docstring: "Field 5 is the uuid and everything after it is the name (a name may hold a comma). Every line of three or more fields is a card, counted even when its memory is [N/A]."
```python
    best: tuple[float, float, float, float | None, str | None, str | None] | None = None
    cards = 0
    uuids: list[str] = []
    for line in stdout.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3:
            continue
        cards += 1
        uuid = parts[4] if len(parts) > 4 and parts[4].upper().startswith("GPU-") else None
        if uuid is not None:
            uuids.append(uuid)
        name = ", ".join(parts[5:]) or None
        try:
            total, used, free = (float(p) for p in parts[:3])
        except ValueError:
            continue
        if total <= 0:
            continue
        util: float | None = None
        if len(parts) > 3:
            try:
                util = float(parts[3].rstrip("% ").strip())
            except ValueError:
                util = None
        if best is None or total > best[0]:
            best = (total, used, free, util, uuid, name)
    if best is None:
        return Vram(reason="nvidia-smi printed no usable memory line", uuids=uuids, cards=cards)
    total, used, free, util, uuid, name = best
    return Vram(
        total_mb=total, used_mb=used, free_mb=free, util_pct=util,
        uuid=uuid, name=name, uuids=uuids, cards=cards,
    )
```

In `read_vram` (`:161-163`), replace the first `except` with:
```python
    except FileNotFoundError as exc:
        # No nvidia-smi in this container: no GPU was passed through
        # (deploy/docker-compose.gpu.yml not merged) — the engine runs on CPU.
        return Vram(reason=f"nvidia-smi could not be run — {exc}", absent=True)
    except (OSError, TimeoutError) as exc:
        return Vram(reason=f"nvidia-smi could not be run — {exc}")
```

- [ ] **Step 8: implement** — `services/gateway/migrations/009_engines.sql`
```sql
-- S40: engines, and what hardware produced a number (docs/plans/rebuild/hub-topology.md;
-- hub/r2-integration.md D8, D10, D21).
--
-- Owner decision 1 (2026-09-18): every model id names the MACHINE it runs on —
-- `hub:qwen3:8b` now, `dell:qwen3.8:27b` once the agent links the Dell (S44).
-- `ollama:x` names a program, not a machine, so the bundled engine's row is renamed
-- `hub` (D8: `hub` is always the bundled container, reached at OLLAMA_URL, and it
-- stays the embedder).
--
-- One rule decides every table that holds a provider name (001-008, checked at
-- 6abf58fa): SETTINGS follow the owner's intent; MEASUREMENTS keep the name that was
-- true when they were written.
--
--   renamed  providers.name 'ollama' -> 'hub'; routes.chain links 'ollama:X' -> 'hub:X'
--            (a link that becomes a duplicate is kept once, where it came first);
--            spend_caps / provider_prices rows, the owner's own settings for that row.
--            Both are inert for a local provider (usage_local_has_no_usd), but left
--            under 'ollama' they would apply to any FUTURE provider named 'ollama'.
--            Rows already keyed 'hub' can only be leftovers of a deleted provider (a
--            live one is refused below), so they go first rather than attach to the
--            bundled engine.
--   deleted  provider_walls for 'ollama': a wall is a transient refusal, not history,
--            and 006's FK has no ON UPDATE, so it would block the rename.
--   kept     usage_events.provider / served_by = 'ollama': that row DID serve those
--            calls under that name. probes keep kind='ollama', and the new `provider`
--            column records 'ollama' for them — the row that served, a fact — while
--            `compute` stays NULL: no code can know which card an old row ran on, so
--            fit never reads it (the 008 precedent).
--
-- Core's chat.model / chat.vision_model are rewritten by core's own 035_hub_engine.
-- Idempotent (007's rule): the rename block runs only while a builtin named 'ollama'
-- exists; everything else is IF NOT EXISTS or DROP-then-ADD.

-- What produced a number (D10, app/compute_id.py). NULL = not known: a legacy row, or
-- a stamp the rule omitted. Never guessed, never backfilled.
ALTER TABLE probes ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS compute text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS runtime text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS path text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS served_on text;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM providers WHERE name = 'hub' AND NOT builtin) THEN
        RAISE EXCEPTION 'migration 009: a provider named "hub" already exists, and "hub" is now the name of the bundled engine. Its hub:<model> chain links would silently start meaning the bundled engine, so nothing was changed. Rename or delete that provider, then start the gateway again.';
    END IF;
    IF EXISTS (SELECT 1 FROM providers WHERE name = 'library') THEN
        RAISE EXCEPTION 'migration 009: a provider named "library" already exists, and library:<slug> now names a model in the library, not a provider. Nothing was changed. Rename or delete that provider, then start the gateway again.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM providers WHERE name = 'ollama' AND builtin) THEN
        RETURN;
    END IF;

    DELETE FROM provider_walls WHERE provider = 'ollama';
    DELETE FROM spend_caps WHERE provider = 'hub';
    DELETE FROM provider_prices WHERE provider = 'hub';
    UPDATE spend_caps SET provider = 'hub' WHERE provider = 'ollama';
    UPDATE provider_prices SET provider = 'hub' WHERE provider = 'ollama';
    UPDATE probes SET provider = 'ollama' WHERE provider IS NULL AND kind = 'ollama';
    UPDATE providers SET name = 'hub', updated_at = now() WHERE name = 'ollama' AND builtin;

    UPDATE routes AS r
    SET chain = rewritten.chain, updated_at = now()
    FROM (
        SELECT firsts.role, jsonb_agg(firsts.link ORDER BY firsts.first_at) AS chain
        FROM (
            SELECT links.role, links.link, min(links.ord) AS first_at
            FROM (
                SELECT routes.role,
                       CASE
                           WHEN jsonb_typeof(t.item) = 'string'
                                AND starts_with(t.item #>> '{}', 'ollama:')
                           THEN to_jsonb('hub:' || substr(t.item #>> '{}', 8))
                           ELSE t.item
                       END AS link,
                       t.ord
                FROM routes
                CROSS JOIN LATERAL jsonb_array_elements(
                    CASE WHEN jsonb_typeof(routes.chain) = 'array'
                         THEN routes.chain ELSE '[]'::jsonb END
                ) WITH ORDINALITY AS t(item, ord)
            ) AS links
            GROUP BY links.role, links.link
        ) AS firsts
        GROUP BY firsts.role
    ) AS rewritten
    WHERE r.role = rewritten.role AND r.chain IS DISTINCT FROM rewritten.chain;
END $$;

-- One row per ENGINE: a providers row whose adapter is 'ollama'. The owner's settings
-- (lifecycle, serving, hold_s) and the last READY reading, kept for the moments nobody
-- can ask (a machine asleep, S46). A cached value without the time it was read is a
-- CHECK violation, not a row. There is no `compute` column: compute is derived per
-- process from a live reading (app/engines.py) — a database restored onto another
-- machine would otherwise carry a GPU it does not have.
CREATE TABLE IF NOT EXISTS engines (
    provider      text PRIMARY KEY REFERENCES providers (name) ON UPDATE CASCADE ON DELETE CASCADE,
    lifecycle     text NOT NULL DEFAULT 'always_on',
    serving       boolean NOT NULL DEFAULT true,
    hold_s        integer NOT NULL DEFAULT 600,
    last_ready_at timestamptz,
    last_tags     jsonb,
    last_tags_at  timestamptz,
    last_facts    jsonb,
    last_facts_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT engines_lifecycle_is_known CHECK (lifecycle IN ('always_on', 'wake_on_lan')),
    CONSTRAINT engines_hold_s_bounded CHECK (hold_s BETWEEN 60 AND 1800),
    CONSTRAINT engines_tags_dated CHECK ((last_tags IS NULL) = (last_tags_at IS NULL)),
    CONSTRAINT engines_facts_dated CHECK ((last_facts IS NULL) = (last_facts_at IS NULL))
);
INSERT INTO engines (provider)
SELECT name FROM providers WHERE adapter = 'ollama'
ON CONFLICT (provider) DO NOTHING;

-- What /api/show said about each model on each engine (capabilities, context length),
-- keyed by digest. `capabilities` NULL = /api/show stated none — not "none".
CREATE TABLE IF NOT EXISTS engine_models (
    provider       text NOT NULL REFERENCES engines (provider) ON UPDATE CASCADE ON DELETE CASCADE,
    name           text NOT NULL,
    digest         text,
    capabilities   jsonb,
    context_length integer CHECK (context_length > 0),
    read_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, name)
);

-- `hub` IS the builtin and the builtin IS `hub` (found by the flag, named by D8);
-- `library:` names catalogue rows; a non-builtin engine is reached with a token.
ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_name_not_reserved;
ALTER TABLE providers ADD CONSTRAINT providers_name_not_reserved CHECK (name <> 'library');
ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_hub_is_the_builtin;
ALTER TABLE providers ADD CONSTRAINT providers_hub_is_the_builtin CHECK (builtin = (name = 'hub'));
ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_engine_link_has_token;
ALTER TABLE providers ADD CONSTRAINT providers_engine_link_has_token CHECK (
    builtin OR adapter <> 'ollama'
    OR (auth_shape = 'static-bearer' AND coalesce(api_key, '') <> '')
);

ALTER TABLE probes DROP CONSTRAINT IF EXISTS probes_runtime_is_known;
ALTER TABLE probes ADD CONSTRAINT probes_runtime_is_known
    CHECK (runtime IN ('container', 'native', 'wsl'));
ALTER TABLE probes DROP CONSTRAINT IF EXISTS probes_path_is_known;
ALTER TABLE probes ADD CONSTRAINT probes_path_is_known
    CHECK (path IN ('internal', 'host', 'tailnet', 'headscale', 'lan'));
ALTER TABLE probes DROP CONSTRAINT IF EXISTS probes_compute_not_empty;
ALTER TABLE probes ADD CONSTRAINT probes_compute_not_empty CHECK (compute <> '');
-- Fit by (compute, model): a reading on one machine is never read for another.
CREATE INDEX IF NOT EXISTS probes_compute_model
    ON probes (compute, model, created_at DESC) WHERE ok AND frame = 'model';

ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_served_on_not_empty;
ALTER TABLE usage_events ADD CONSTRAINT usage_served_on_not_empty CHECK (served_on <> '');
```

- [ ] **Step 9: run green** (the same command as Step 5). Expected: every selected test passes. `test_compute_id.py` runs about 45 parametrized cases.

- [ ] **Step 10: the red window, stated.** Run the whole gateway suite once, to confirm the failure T2 fixes and nothing else:
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t1 uv run pytest -q -x --no-header 2>&1 | tail -5
```
Expected: the first `pool`-fixture test errors with `CheckViolationError: … "providers_hub_is_the_builtin"`. The cause is `providers.ensure_builtin` still seeding `'ollama'`, which T2 changes. Nothing else may fail.

- [ ] **Step 11: lint and format the edited files only**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && uv run ruff format app/compute_id.py app/devices_vram.py tests/test_compute_id.py tests/test_devices_vram.py tests/test_migration_009_engines.py tests/conftest.py tests/test_providers.py && uv run ruff check .
```

- [ ] **Step 12: commit**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff && git add docs/contracts/compute_id_vectors.json services/gateway/migrations/009_engines.sql services/gateway/app/compute_id.py services/gateway/app/devices_vram.py services/gateway/tests/test_compute_id.py services/gateway/tests/test_devices_vram.py services/gateway/tests/test_migration_009_engines.py services/gateway/tests/conftest.py services/gateway/tests/test_providers.py && git commit -m "feat(gateway): migration 009 — the bundled engine is hub, and a number says what ran it

S40 (hub-topology.md, D8/D10): ids name the machine, so the builtin
provider row is renamed hub and its chain links, caps and prices follow
it; usage rows and probes keep 'ollama', because that row served them.
New engines and engine_models tables, and probes/usage_events gain the
columns for compute identity. compute_id.py is the one D10 grammar;
docs/contracts/compute_id_vectors.json pins it for the Go agent too.
devices_vram reads each card's uuid and name.

The DB-backed suite is red until the next commit renames the startup
seed (providers_hub_is_the_builtin); the two land together.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: gateway `engines.py` + `engines_api.py` + the builtin rename (providers/backends/main) + name bridge

**Files:**
- Create: `services/gateway/app/engines.py`, `services/gateway/app/engines_api.py`
- Modify: `services/gateway/app/providers.py`
  - after `:27` (constants)
  - `:82-92` (`base_url_of`)
  - `:128-133` (`validate_shape` engine rule)
  - `:222-237` (`ensure_builtin`)
  - `:358-359` (`delete_row` wording)
- Modify: `services/gateway/app/backends.py`
  - `:56` (`legacy_view` provider)
  - `:74-79` (`resolve_base_url`)
  - `:105-115` (`_slug_for`)
  - `:124-125` (`_row_for`)
  - `:168-170` (`save_config`)
  - `:197-200` (docstring)
- Modify: `services/gateway/app/main.py:15,49-50` (router mount)
- Bridge (a name-only edit in files T3/T4 own):
  - `services/gateway/app/routing.py:291,367`
  - `services/gateway/app/catalog.py:340,463,574`
  - `services/gateway/app/admin.py:665,702-703,1141`
- Modify tests:
  - `services/gateway/tests/conftest.py:98-109`
  - `services/gateway/tests/fakes.py:218` (field), `:350-352` (`_tags`)
  - `services/gateway/tests/test_providers.py`, `test_routing.py`, `test_data_plane.py`, `test_usage.py`, `test_ollama_show.py`, `test_hardware_json_not_in_serving_path.py:29,35`
- Test: create `services/gateway/tests/test_engines.py`

**Interfaces:**
- Consumes (from T1):
  - `compute_id.cpu_slug`, `compute_id.bundled_accelerators`
  - `devices_vram.read_vram` with `.as_dict()` keys `uuids, cards, absent, name, uuid, total_mb, reason`
  - tables `engines`, `engine_models`
- Produces (contract):
  - `engines.BUILTIN = "hub"`
  - `@dataclass(frozen=True) class EngineView: name: str; lifecycle: str; serving: bool; state: str; reason: str | None; observed_at: str | None; tags: dict[str, int | None] | None; tags_as_of: str | None; compute: str | None; runtime: str | None; facts: dict`
  - `def is_engine(row: dict) -> bool`
  - `async def rows(pool) -> list[dict]`
  - `async def get(pool, name: str) -> dict` (raises `UnknownEngine(LookupError)`)
  - `async def observe(app, pool, row: dict, *, live: bool) -> EngineView`
  - `async def installed_sizes(app, pool, name: str) -> dict[str, int | None] | None`
  - `async def set_serving(pool, name: str, serving: bool) -> dict`
  - `def clear_cache() -> None`
  - Routes:
    - `GET /admin/engines?live=` returns `{"engines":[…]}`.
    - `GET /admin/engines/{name}` returns the view plus `vram` and `fit_frame`.
    - `PUT /admin/engines/{name}` with `{"serving": bool}` returns `engines.to_public(read-back row)`: `{name, builtin, is_default, lifecycle, serving, hold_s, last_ready_at, last_tags_at, last_facts_at, updated_at}`. It never carries `api_key` or `base_url`.
- Produces (additive):
  - In `engines`: `UnknownEngine`, `to_public(row)`, `forget(name)`, `resident(app, row) -> (list | None, reason | None)`. Resident entries are `{model, vram_mb, size, size_vram}`.
  - Constants: `READY_TTL_S=30`, `FAILURE_TTL_S=10`, `BUILTIN_RUNTIME="container"`, `PROC_DIR`.
  - In `providers`: `BUILTIN`, `LIBRARY`, `RESERVED_NAMES`.
  - `EngineView.facts` for the builtin is `{"gpu": {name, uuid, total_mb, cards} | None, "accelerators": [...], "cpu": str | None, "unreadable": [{item, reason}]}`.
- The `vram` block uses the exact keys the deleted `/admin/vram` answered: `total_mb, used_mb, free_mb, util_pct, reason, total_gb, free_gb, used_gb, resident, resident_reason, free_after_switch_gb`. It adds `uuid, name, uuids, cards, absent`.

- [ ] **Step 0: scratch DB** — as in T1 Step 0, with `nova_gateway_s40_t2`.

- [ ] **Step 1: failing tests for the rename** (edits to `tests/test_providers.py`)
  - Move `:87-95`: `names = {"hub", "openrouter"}` and assert `providers.split_model_id("hub:qwen3.8:27b", names) == ("hub", "qwen3.8:27b")`. (This is a doc-truth move; the old line still passes.)
  - Replace `:174-176` with:
```python
async def test_startup_seeds_the_bundled_engine_as_hub_and_default(pool):
    rows = await providers.list_rows(pool)
    assert [(r["name"], r["builtin"], r["is_default"]) for r in rows] == [("hub", True, True)]
    assert rows[0]["name"] == providers.BUILTIN
    engine = await pool.fetchrow("SELECT provider, lifecycle, serving, hold_s FROM engines")
    assert tuple(engine) == ("hub", "always_on", True, 600)
    # A second startup is a no-op: one builtin, one engine row.
    await providers.ensure_builtin(pool)
    assert await pool.fetchval("SELECT count(*) FROM providers WHERE builtin") == 1
    assert await pool.fetchval("SELECT count(*) FROM engines") == 1


def test_base_url_of_reads_the_env_only_for_the_bundled_engine(monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.live:11434/")
    builtin = {"adapter": "ollama", "builtin": True, "base_url": "http://stale.example"}
    assert providers.base_url_of(builtin) == "http://ollama.live:11434"
    # Another machine's engine (S44) is its stored address, never this host's env.
    node = {"adapter": "ollama", "builtin": False, "base_url": "https://dell.example:11435/"}
    assert providers.base_url_of(node) == "https://dell.example:11435"
    # The ollama adapter re-dresses the builtin as openai-chat at {OLLAMA_URL}/v1 to
    # chat (adapters/ollama.py completions); that row keeps builtin=True and its /v1.
    chat = {"adapter": "openai-chat", "builtin": True, "base_url": "http://ollama.live:11434/v1"}
    assert providers.base_url_of(chat) == "http://ollama.live:11434/v1"


def test_the_engine_adapter_is_refused_here_and_says_what_is_one():
    with pytest.raises(HTTPException) as excinfo:
        providers.validate_shape(
            {"adapter": "ollama", "base_url": "https://dell.example", "auth_shape": "none"}
        )
    assert excinfo.value.status_code == 400
    assert "'hub'" in excinfo.value.detail and "adapter=openai-chat" in excinfo.value.detail


async def test_the_wizard_never_names_a_cloud_provider_after_a_reserved_name(pool):
    for typed in ("Hub", "library", "ollama"):
        await backends.save_config(
            pool,
            {"kind": "cloud", "url": "http://x.test", "api_key": "sk-x", "model": "m",
             "provider": typed},
        )
        assert (await backends.read_config(pool))["provider"] == "cloud"
    assert sorted(r["name"] for r in await providers.list_rows(pool)) == ["cloud", "hub"]
```
  - Moves (reason: the builtin is now called `hub`):
    - `:194` becomes `["hub", "openrouter"]`.
    - `:226`, `:267`, `:752`, `:1077` become `["hub"]`.
    - `:270` is renamed to `test_create_refuses_a_duplicate_and_the_reserved_names`, and `:283-292` becomes:
```python
    for reserved in ("hub", "library"):
        refused = await client.post(
            "/admin/providers",
            json={"name": reserved, "adapter": "openai-chat", "base_url": "http://x/v1",
                  "auth_shape": "none"},
        )
        assert refused.status_code == 409
        assert "is reserved" in refused.json()["error"]
```
    - `:339` comment becomes "A bare model still goes to the default (hub), colon and all."
    - `:344` becomes `"hub:qwen3.8:27b"`.
    - `:373` becomes `client.delete("/admin/providers/hub")`.
    - `:378` becomes `client.put("/admin/providers/hub/default")`.
    - `:522` comment becomes "And back to the bundled engine: the cloud row stays registered, hub is default."
    - `:526` becomes `{"hub": True, "my-cloud": False}`.

- [ ] **Step 2: failing moves in the other suites** (reason for all: the builtin row is `hub`, so `served_by`, chain links and usage/wall provider names say `hub`):
  - `tests/test_routing.py`:
    - Replace every `"ollama:` with `"hub:`. This covers the chain links and served ids at `:91,92,120,133,135,143,177,183,321,325,348,360,386,389,401,402,405,410,416,420,424,425,431,439,442,459,465,466,470`.
    - Replace provider-name `"ollama"` with `"hub"` at `:192,226,231` (both occurrences), `:253,272,301,305,307,308,313,315`.
    - At `:350` the string becomes `"fell back to local standby hub:qwen3:8b (the bundled ollama's default model qwen3:8b)"`. The parenthetical is `routing.py:370`'s own text, which T3 rewrites.
    - Leave the fixture lines `:52-55` (`OLLAMA_URL`, `http://ollama.test`, `{"kind": "ollama", …}`, the backend *kind*) unchanged.
  - `tests/test_data_plane.py`: `:58` becomes `"hub:qwen3:8b"` and `:83` becomes `"hub:qwen3:4b"`.
  - `tests/test_usage.py`:
    - `:207` becomes `"provider": "hub"`.
    - `:495` becomes `provider["provider"] == "hub"`.
    - `:499` and `:504` become `"hub:qwen3:8b"`.
    - `:528` becomes `{"provider": "hub", …}`, still 400 because it is local.
    - `:539` becomes `providers.get_row(pool, "hub")`.
    - `:245` stays `'ollama'`: a raw historical row, which is exactly what 009 keeps.
  - `tests/test_ollama_show.py:276,287`: the row becomes `{"name": "hub", "adapter": "ollama", "builtin": True}`. Reason: `base_url_of` now reads `OLLAMA_URL` only for the builtin.
  - `tests/test_hardware_json_not_in_serving_path.py`:
    - `:29` becomes `from app import admin, catalog, engines, fit, routing, suggest`.
    - `:35` becomes `SERVING_MODULES = (fit, catalog, engines, routing, suggest)`.
    - Reason: engines now answers questions about the card while serving.

- [ ] **Step 3: run red**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t2 uv run pytest tests/test_providers.py tests/test_backends.py tests/test_routing.py tests/test_data_plane.py tests/test_usage.py tests/test_ollama_show.py -q
```
Expected:
- Every `pool` test errors with `CheckViolationError … providers_hub_is_the_builtin`.
- `test_hardware_json…` fails at import because `app.engines` does not exist yet (it passes after Step 9).
- `test_base_url_of_reads_the_env_only_for_the_bundled_engine` fails on the node row, because `OLLAMA_URL` is returned.
- `test_the_engine_adapter…` fails on the `'hub'` wording.
- `test_ollama_show::test_the_fakes_own_tags_rows…` passes (the old rule still reads the env).

- [ ] **Step 4: implement the rename**

`app/providers.py`, inserted after `:27`:
```python
#: D8: the bundled engine is always `hub`, the compose container reached at
#: OLLAMA_URL. engines.BUILTIN is this same name — it lives here because
#: engines.py imports this module, and ensure_builtin seeds it.
BUILTIN = "hub"
#: Library rows in the catalogue are `library:<slug>`; a provider by that name
#: would turn them into calls (migration 009, providers_name_not_reserved).
LIBRARY = "library"
RESERVED_NAMES = frozenset({BUILTIN, LIBRARY})
```

`base_url_of` (`:82-92`):
```python
def base_url_of(row: dict) -> str:
    """Where this provider's calls go.

    The bundled engine (builtin, adapter=ollama) always resolves to the live
    OLLAMA_URL, never a stored column — the sidecar's address is a fact of
    this host's compose file (S1's rule, kept). Every other row, including
    another machine's engine, is its stored address with a trailing slash
    dropped. BOTH conditions, not the flag alone: the ollama adapter
    re-dresses the builtin as an openai-chat row at `{OLLAMA_URL}/v1` to chat
    (adapters/ollama.py), and that row must keep its /v1.
    """
    if row.get("adapter") == "ollama" and row.get("builtin"):
        return os.environ.get("OLLAMA_URL", "").rstrip("/")
    return (row.get("base_url") or "").rstrip("/")
```

`validate_shape` `:128-133`:
```python
    if adapter == "ollama" and not (existing or {}).get("builtin"):
        raise HTTPException(
            status_code=400,
            detail=f"adapter=ollama is an engine, and the only engine here is the bundled "
            f"one ({BUILTIN!r}) — another machine's ollama is reached with "
            "adapter=openai-chat at its /v1 address",
        )
```

`ensure_builtin` `:222-237`:
```python
async def ensure_builtin(pool: asyncpg.Pool) -> None:
    """The startup seed: the bundled engine `hub` exists with its engines
    row, and SOMETHING is the default. Every statement is a no-op every
    startup after the first."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "INSERT INTO providers (name, adapter, base_url, auth_shape, builtin, local, "
                "is_default) VALUES ($1, 'ollama', '', 'none', true, true, "
                "NOT EXISTS (SELECT 1 FROM providers WHERE is_default)) "
                "ON CONFLICT (name) DO NOTHING",
                BUILTIN,
            )
            await conn.execute(
                "INSERT INTO engines (provider) SELECT name FROM providers "
                "WHERE adapter = 'ollama' ON CONFLICT (provider) DO NOTHING"
            )
            await conn.execute(
                "UPDATE providers SET is_default = true WHERE builtin "
                "AND NOT EXISTS (SELECT 1 FROM providers WHERE is_default)"
            )
```

`delete_row` `:359` becomes `detail=f"{name!r} is the bundled engine and cannot be deleted"`.

`app/backends.py`:
- `:56` becomes `"provider": None if row.get("builtin") else row["name"],`
- `:77-78`:
```python
    if view["kind"] == "ollama":
        return providers.base_url_of({"adapter": "ollama", "builtin": True})
```
- `:107-108` becomes `return providers.BUILTIN`.
- `:113` becomes `if not slug or slug == "ollama" or slug in providers.RESERVED_NAMES or not providers.NAME_RE.match(slug):`
- `:125`:
```python
        return {"adapter": "ollama", "base_url": "", "auth_shape": "none",
                "name": providers.BUILTIN, "builtin": True}
```
- `:168-170` becomes `if name == providers.BUILTIN:` and `await providers.set_default_model(pool, providers.BUILTIN, payload.get("model"))`.
- `:198-199` docstring becomes "the bundled engine `hub` exists with its engines row".

Bridge, name only (T3/T4 later replace these lines with per-engine logic):
- `routing.py:291` and `:367`, `catalog.py:340`, `:463` and `:574`, and `admin.py:665` and `:1141`: `providers.get_row(pool, "ollama")` becomes `providers.get_row(pool, providers.BUILTIN)`.
- `admin.py:702-703`:
```python
    if name in providers.RESERVED_NAMES:
        raise HTTPException(
            status_code=409,
            detail=f"{name!r} is reserved — {providers.BUILTIN!r} is the bundled engine and "
            f"{providers.LIBRARY!r} names the model library; pick another name",
        )
```

- [ ] **Step 5: run green** (the same command as Step 3, minus the hardware-json file). Expected: all pass.

- [ ] **Step 6: failing engine tests** — add `tags_status` to `tests/fakes.py`, clear the engines cache in `conftest.py`, and write `tests/test_engines.py`
  - `fakes.py`: after `:219` (`version_status: int = 200`) add `tags_status: int = 200`. Change `_tags` (`:350-352`) to:
```python
    async def _tags(self, request):
        await self._record(request)
        if self.tags_status != 200:
            return JSONResponse({"error": "ollama is not ready"}, status_code=self.tags_status)
        return JSONResponse({"models": [self._tag_row(name) for name in self.tags]})
```
  - `conftest.py:98-109`: the import becomes `from app import engines, hf_hub, ollama_registry`. Call `engines.clear_cache()` beside both `clear()` pairs, and extend the docstring: "…and every engine's cached reading (S40)".
  - `tests/test_engines.py`:
```python
"""app/engines.py and /admin/engines (S40): the bundled engine `hub`, observed.

An engine is a provider row with adapter=ollama plus its `engines` row. The
gateway STATES what an engine is doing — ready, unreachable, switched off,
unobserved — and decides nothing with it here. Every reading carries when it
was taken; a cached one carries its ORIGINAL time (app/cache.py's rail).

Every test fakes the card and the CPU (test_admin_suggest_fit's rule): a test
that passes because of the hardware under the desk measures nothing."""

from __future__ import annotations

import dataclasses
import json

import pytest

from app import devices_vram, engines, fit, providers
from app.main import app as gateway_app
from tests.conftest import requires_db
from tests.fakes import FakeOllama

pytestmark = requires_db

OLLAMA = "http://ollama.test"
UUID = "GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"
GPU = f"gpu:cuda:{UUID}"
CPU = "cpu:12th-gen-intel-core-i9-12900k|24c|31g"
NO_GPU = "nvidia-smi could not be run — [Errno 2] No such file or directory"


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch):
    fake = _Clock()
    monkeypatch.setattr(engines, "_clock", fake)
    return fake


@pytest.fixture
def machine(monkeypatch, tmp_path):
    (tmp_path / "cpuinfo").write_text(
        "processor\t: 0\nmodel name\t: 12th Gen Intel(R) Core(TM) i9-12900K\n"
    )
    (tmp_path / "meminfo").write_text("MemTotal:       32767128 kB\nMemAvailable: 1 kB\n")
    monkeypatch.setattr(engines, "PROC_DIR", tmp_path)
    monkeypatch.setattr(engines, "_nproc", lambda: 24)
    card = {
        "reading": devices_vram.parse(f"24576, 2662, 21914, 3, {UUID}, NVIDIA GeForce RTX 3090\n")
    }

    async def _read():
        return card["reading"]

    monkeypatch.setattr(devices_vram, "read_vram", _read)
    return card


@pytest.fixture
async def hub(pool, monkeypatch, mount_backend, machine, clock):
    monkeypatch.setenv("OLLAMA_URL", OLLAMA)
    fake = FakeOllama(tags=("qwen3:8b", "nomic-embed-text:latest"))
    mount_backend(OLLAMA, fake.app)
    return fake


def _tag_reads(fake) -> int:
    return sum(1 for path, _ in fake.seen if path == "/api/tags")


async def _observe(pool, name="hub", *, live=False) -> engines.EngineView:
    return await engines.observe(gateway_app, pool, await engines.get(pool, name), live=live)


async def _add_cloud(pool) -> None:
    await providers.insert_row(
        pool,
        "openrouter",
        {"adapter": "openai-chat", "base_url": "https://openrouter.test/v1",
         "auth_shape": "static-bearer", "api_key": "sk-1"},
    )


async def _add_sleeping_dell(pool) -> None:
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key, local) "
        "VALUES ('dell', 'ollama', 'http://dell.test', 'static-bearer', 'tok', true)"
    )
    await pool.execute(
        "INSERT INTO engines (provider, lifecycle, last_tags, last_tags_at) "
        "VALUES ('dell', 'wake_on_lan', $1::jsonb, '2026-09-18T03:00:00+00')",
        json.dumps({"qwen3.8:27b": 17000000000}),
    )


# ── the rows ─────────────────────────────────────────────────────────────


async def test_the_bundled_engine_is_hub_and_only_engines_are_engines(pool):
    [row] = await engines.rows(pool)
    assert row["name"] == engines.BUILTIN == "hub"
    assert row["builtin"] is True and engines.is_engine(row)
    assert (row["lifecycle"], row["serving"], row["hold_s"]) == ("always_on", True, 600)
    await _add_cloud(pool)
    assert [r["name"] for r in await engines.rows(pool)] == ["hub"]
    assert not engines.is_engine(await providers.get_row(pool, "openrouter"))
    for name in ("openrouter", "nope"):
        with pytest.raises(engines.UnknownEngine):
            await engines.get(pool, name)


# ── observe ──────────────────────────────────────────────────────────────


async def test_a_ready_engine_states_its_models_and_what_it_runs_on(pool, hub):
    view = await _observe(pool)
    assert (view.state, view.reason, view.serving, view.lifecycle) == (
        "ready", None, True, "always_on",
    )
    assert set(view.tags) == {"qwen3:8b", "nomic-embed-text:latest"}
    assert all(isinstance(size, int) and size > 0 for size in view.tags.values())
    assert (view.compute, view.runtime) == (GPU, "container")
    assert view.facts["accelerators"] == [GPU] and view.facts["cpu"] == CPU
    assert view.facts["gpu"]["name"] == "NVIDIA GeForce RTX 3090"
    assert view.facts["unreadable"] == []
    assert view.observed_at and view.tags_as_of
    stored = await pool.fetchrow(
        "SELECT last_ready_at, last_tags, last_tags_at, last_facts, last_facts_at "
        "FROM engines WHERE provider = 'hub'"
    )
    assert json.loads(stored["last_tags"]) == view.tags
    assert stored["last_ready_at"] == stored["last_tags_at"] == stored["last_facts_at"]
    assert json.loads(stored["last_facts"])["accelerators"] == [GPU]


async def test_a_failure_is_cached_ten_seconds_and_a_ready_reading_thirty(pool, hub, clock):
    """Before S40 a failed listing was never cached (routing.py:293-294 at
    0531b496), so every routed turn waited out the 10 s MODELS_TIMEOUT again."""
    hub.tags_status = 500
    first = await _observe(pool)
    assert first.state == "unreachable" and first.tags is None
    assert first.reason.startswith("hub could not be asked what is installed")
    hub.tags_status = 200
    clock.now = 1009.5
    again = await _observe(pool)
    assert again.state == "unreachable" and again.observed_at == first.observed_at
    assert _tag_reads(hub) == 1
    clock.now = 1010.0
    ready = await _observe(pool)
    assert ready.state == "ready" and _tag_reads(hub) == 2
    clock.now = 1039.5
    assert (await _observe(pool)).observed_at == ready.observed_at
    assert _tag_reads(hub) == 2
    clock.now = 1040.0
    await _observe(pool)
    assert _tag_reads(hub) == 3
    await _observe(pool, live=True)
    assert _tag_reads(hub) == 4


async def test_a_failed_reading_never_overwrites_the_last_good_one(pool, hub, clock):
    await _observe(pool)
    sql = "SELECT last_ready_at, last_tags FROM engines WHERE provider = 'hub'"
    good = tuple(await pool.fetchrow(sql))
    hub.tags_status = 500
    clock.now += engines.READY_TTL_S
    assert (await _observe(pool)).state == "unreachable"
    assert tuple(await pool.fetchrow(sql)) == good


async def test_switched_off_is_the_owners_word_and_takes_effect_at_once(pool, hub):
    await _observe(pool)
    stored = await engines.set_serving(pool, "hub", False)
    assert stored["serving"] is False
    assert await pool.fetchval("SELECT serving FROM engines WHERE provider = 'hub'") is False
    off = await _observe(pool)
    assert off.state == "switched_off" and "switched off" in off.reason
    assert set(off.tags) == {"qwen3:8b", "nomic-embed-text:latest"}  # installed ≠ used
    await engines.set_serving(pool, "hub", True)
    assert (await _observe(pool)).state == "ready"
    assert _tag_reads(hub) == 1, "the switch is read from the row, never waits out a cache"


async def test_set_serving_refuses_what_is_not_an_engine_or_not_a_bool(pool):
    with pytest.raises(engines.UnknownEngine):
        await engines.set_serving(pool, "nope", False)
    with pytest.raises(ValueError):
        await engines.set_serving(pool, "hub", "no")
    assert await pool.fetchval("SELECT serving FROM engines WHERE provider = 'hub'") is True


async def test_compute_is_derived_from_this_reading_never_from_the_row(pool, hub):
    """A database restored onto another machine carries the old machine's
    facts; the compute a number is stamped with must not."""
    stale = "gpu:cuda:GPU-00000000-0000-4000-8000-000000000000"
    await pool.execute(
        "UPDATE engines SET last_facts = $1::jsonb, last_facts_at = now() "
        "WHERE provider = 'hub'",
        json.dumps({"accelerators": [stale]}),
    )
    view = await _observe(pool, live=True)
    assert view.compute == GPU and view.facts["accelerators"] == [GPU]


async def test_no_gpu_passed_through_means_the_engine_runs_on_its_cpu(pool, hub, machine):
    machine["reading"] = devices_vram.Vram(reason=NO_GPU, absent=True)
    view = await _observe(pool, live=True)
    assert view.compute == CPU
    assert view.facts["gpu"] is None and view.facts["accelerators"] == []
    assert view.facts["unreadable"] == []  # no GPU is a fact, not a failed reading


async def test_a_gpu_it_cannot_read_or_single_out_is_omitted_never_guessed(pool, hub, machine):
    machine["reading"] = devices_vram.Vram(reason="nvidia-smi exited 9: Failed to initialize NVML")
    broken = await _observe(pool, live=True)
    assert broken.compute is None
    assert [u["item"] for u in broken.facts["unreadable"]] == ["gpu"]
    assert "NVML" in broken.facts["unreadable"][0]["reason"]
    other = "GPU-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
    machine["reading"] = devices_vram.parse(
        f"24576, 2662, 21914, 3, {UUID}, NVIDIA GeForce RTX 3090\n"
        f"8192, 100, 8092, 0, {other}, NVIDIA GeForce RTX 3060 Ti\n"
    )
    two = await _observe(pool, live=True)
    assert two.compute is None and len(two.facts["accelerators"]) == 2
    machine["reading"] = devices_vram.parse("24576, 2662, 21914, 3\n")
    nameless = await _observe(pool, live=True)
    assert nameless.compute is None
    assert [u["item"] for u in nameless.facts["unreadable"]] == ["gpu_identity"]


async def test_a_cpu_it_cannot_name_is_omitted_and_says_why(pool, hub):
    (engines.PROC_DIR / "cpuinfo").write_text("processor\t: 0\n")
    view = await _observe(pool, live=True)
    assert view.facts["cpu"] is None and view.compute == GPU
    assert [u["item"] for u in view.facts["unreadable"]] == ["cpu"]


async def test_installed_sizes_is_the_cached_listing_and_none_when_it_cannot_ask(pool, hub):
    sizes = await engines.installed_sizes(gateway_app, pool, "hub")
    assert set(sizes) == {"qwen3:8b", "nomic-embed-text:latest"}
    assert await engines.installed_sizes(gateway_app, pool, "hub") == sizes
    assert _tag_reads(hub) == 1
    engines.clear_cache()
    hub.tags_status = 500
    assert await engines.installed_sizes(gateway_app, pool, "hub") is None


async def test_a_wake_on_lan_engine_is_never_asked_unless_live(pool, hub, mount_backend):
    """S40 creates no such engine (they arrive with the agent); the state is
    pinned now so the vocabulary core reads never changes meaning later."""
    dell = FakeOllama(tags=("qwen3.8:27b",))
    mount_backend("http://dell.test", dell.app)
    await _add_sleeping_dell(pool)
    assert [r["name"] for r in await engines.rows(pool)] == ["hub", "dell"]
    view = await _observe(pool, "dell")
    assert (view.state, view.observed_at, view.compute, view.runtime) == (
        "unobserved", None, None, None,
    )
    assert view.tags == {"qwen3.8:27b": 17000000000}
    assert view.tags_as_of.startswith("2026-09-18T03:00:00")
    assert dell.seen == []
    live = await _observe(pool, "dell", live=True)
    assert live.state == "ready" and [path for path, _ in dell.seen] == ["/api/tags"]
```

- [ ] **Step 7: run red**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t2 uv run pytest tests/test_engines.py -q
```
Expected: a collection error, `ImportError: cannot import name 'engines' from 'app'`. The conftest autouse fixture fails the same way.

- [ ] **Step 8: implement** — `services/gateway/app/engines.py`
```python
"""Engines: the machines that run models, and what each is doing now (S40).

An ENGINE is a provider row with adapter=ollama plus its one-to-one `engines`
row (migration 009). The bundled one is always `hub` (D8: the compose
container at OLLAMA_URL, the embedder too); `builtin=true` finds it, never its
name. Other machines' engines arrive with the agent (S44) and change nothing
here but their rows.

## The gateway states; it never decides
`observe` answers "what is this engine doing": ready, unreachable, switched
off, or unobserved (a wake-on-LAN engine nobody asked recently — asking could
wake it). Routing, the catalogue and core read this answer; none of them gets
a second way to ask.

## Failures are cached too
Before S40 a failed listing was never cached (routing.py:293-294 at 0531b496),
so every routed turn waited the whole 10 s MODELS_TIMEOUT again. A ready
reading is kept READY_TTL_S, a failed one FAILURE_TTL_S; `live=True` always
asks again and refreshes the cache. A cached answer carries the time it was
ORIGINALLY read, never "now".

## Serving is the owner's switch, not a reading
The cache holds only what the engine SAID. `serving` comes from the row passed
in on every call, so flipping it takes effect on the very next observe,
whatever is cached — a switch that waited out a cache would be a switch that
lies.

## Compute is derived per process, never stored
`compute` is the D10 id (app/compute_id.py) a model fully resident on this
engine would be stamped with — the key fit reads probes by. It comes from this
observation's own readings (nvidia-smi through devices_vram, and /proc), never
from `last_facts`: a database restored onto another machine would otherwise
carry a GPU it does not have.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import asyncpg
import httpx

from app import adapters, compute_id, devices_vram, providers

BUILTIN = providers.BUILTIN
#: D8: the bundled engine is always the compose container.
BUILTIN_RUNTIME = "container"
READY_TTL_S = 30.0
FAILURE_TTL_S = 10.0
#: /api/ps is a cheap metadata read (admin.PS_TIMEOUT's figure).
PS_TIMEOUT = httpx.Timeout(5.0)
#: The bundled engine's CPU, read where the gateway runs: the gateway shares
#: the docker host with the bundled ollama, so this /proc IS that engine's
#: machine — the numbers `docker info` reports (NCPU, MemTotal), which D10
#: names as a container runtime's cpu source.
PROC_DIR = Path("/proc")

_COLUMNS = (
    "p.name, p.adapter, p.base_url, p.auth_shape, p.api_key, p.default_model, p.builtin, "
    "p.is_default, p.local, e.lifecycle, e.serving, e.hold_s, e.last_ready_at, e.last_tags, "
    "e.last_tags_at, e.last_facts, e.last_facts_at, e.updated_at"
)
_FROM = "FROM providers p JOIN engines e ON e.provider = p.name WHERE p.adapter = 'ollama'"


class UnknownEngine(LookupError):
    """No engine by that name: unknown, or a provider that is not an engine."""


@dataclass(frozen=True)
class EngineView:
    name: str
    lifecycle: str
    serving: bool
    state: str  # 'ready' | 'unreachable' | 'switched_off' | 'unobserved'
    reason: str | None
    observed_at: str | None
    tags: dict[str, int | None] | None
    tags_as_of: str | None
    compute: str | None
    runtime: str | None
    facts: dict


@dataclass(frozen=True)
class _Reading:
    """What the engine SAID at one instant — cached whole, TTL by `ok`."""

    ok: bool
    detail: str | None
    tags: dict[str, int | None] | None
    tags_as_of: str | None
    observed_at: str
    facts: dict
    compute: str | None
    runtime: str | None
    read_at_mono: float


_READINGS: dict[str, _Reading] = {}


def _clock() -> float:
    return time.monotonic()


def _nproc() -> int:
    return os.cpu_count() or 0


def clear_cache() -> None:
    _READINGS.clear()


def forget(name: str) -> None:
    """Drop one engine's cached reading (the data plane, after a
    connect-phase failure, so the next observe asks again)."""
    _READINGS.pop(name, None)


def is_engine(row: dict) -> bool:
    return row.get("adapter") == "ollama"


def _iso(value) -> str | None:
    if value is None:
        return None
    return value if isinstance(value, str) else value.isoformat()


def _decode(record) -> dict:
    row = dict(record)
    for key in ("last_tags", "last_facts"):
        if row.get(key) is not None:
            row[key] = json.loads(row[key])
    return row


async def rows(pool: asyncpg.Pool) -> list[dict]:
    """Every engine, builtin first: provider columns joined with engines'."""
    records = await pool.fetch(f"SELECT {_COLUMNS} {_FROM} ORDER BY p.builtin DESC, p.name")
    return [_decode(record) for record in records]


async def get(pool: asyncpg.Pool, name: str) -> dict:
    record = await pool.fetchrow(f"SELECT {_COLUMNS} {_FROM} AND p.name = $1", name)
    if record is None:
        raise UnknownEngine(name)
    return _decode(record)


def to_public(row: dict) -> dict:
    """An engine row, safe for the wire: no key and no address."""
    return {
        "name": row["name"],
        "builtin": bool(row["builtin"]),
        "is_default": bool(row["is_default"]),
        "lifecycle": row["lifecycle"],
        "serving": row["serving"],
        "hold_s": row["hold_s"],
        "last_ready_at": _iso(row["last_ready_at"]),
        "last_tags_at": _iso(row["last_tags_at"]),
        "last_facts_at": _iso(row["last_facts_at"]),
        "updated_at": _iso(row["updated_at"]),
    }


async def set_serving(pool: asyncpg.Pool, name: str, serving: bool) -> dict:
    """Store the owner's switch and return the row READ BACK from the
    database — the caller reports what is stored, never what it sent."""
    if not isinstance(serving, bool):
        raise ValueError(f"serving must be true or false — got {serving!r}")
    updated = await pool.fetchval(
        "UPDATE engines SET serving = $2, updated_at = now() WHERE provider = $1 "
        "RETURNING provider",
        name,
        serving,
    )
    if updated is None:
        raise UnknownEngine(name)
    return await get(pool, name)


async def resident(app, row: dict) -> tuple[list[dict] | None, str | None]:
    """(every model this engine's /api/ps reports resident, reason-if-not).

    Entries are `{model, vram_mb, size, size_vram}` — vram_mb for fit's
    free-after-switch, size/size_vram for the D10 stamp (compute_id.served_on).
    """
    base_url = providers.base_url_of(row)
    if not base_url:
        return None, "OLLAMA_URL is unset — cannot read what is resident"
    client = adapters.http_client(
        app, PS_TIMEOUT, base_url=base_url, headers=adapters.for_row(row).headers(row)
    )
    try:
        async with client as c:
            resp = await c.get("/api/ps")
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        return None, f"could not reach {row['name']}'s /api/ps — {adapters.reason(exc)}"
    out = []
    for entry in resp.json().get("models", []):
        size_vram = entry.get("size_vram")
        if size_vram is not None:
            out.append(
                {
                    "model": entry.get("name") or entry.get("model"),
                    "vram_mb": size_vram / (1024 * 1024),
                    "size": entry.get("size"),
                    "size_vram": size_vram,
                }
            )
    return out, None


async def _builtin_facts() -> tuple[dict, str | None]:
    """(facts, compute) for the bundled engine, read now."""
    reading = (await devices_vram.read_vram()).as_dict()
    accelerators = compute_id.bundled_accelerators(reading)
    unreadable: list[dict] = []
    try:
        cpu: str | None = compute_id.cpu_slug(
            (PROC_DIR / "cpuinfo").read_text(), (PROC_DIR / "meminfo").read_text(), _nproc()
        )
    except (OSError, ValueError) as exc:
        cpu = None
        unreadable.append({"item": "cpu", "reason": str(exc)})
    gpu = None
    if reading["cards"] and reading["total_mb"] is not None:
        gpu = {
            "name": reading["name"],
            "uuid": reading["uuid"],
            "total_mb": reading["total_mb"],
            "cards": reading["cards"],
        }
        if not accelerators:
            unreadable.append(
                {
                    "item": "gpu_identity",
                    "reason": "a card printed no CUDA uuid, so which card ran a model "
                    "cannot be named",
                }
            )
    elif not reading["absent"]:
        unreadable.append(
            {"item": "gpu", "reason": reading["reason"] or "nvidia-smi gave no reading"}
        )
    if reading["absent"]:
        compute = cpu  # no GPU passed through: every model runs on the CPU
    elif len(accelerators) == 1:
        compute = accelerators[0]
    else:
        compute = None  # a GPU is there but not nameable as exactly one card
    facts = {"gpu": gpu, "accelerators": accelerators, "cpu": cpu, "unreadable": unreadable}
    return facts, compute


async def _remember(pool: asyncpg.Pool, row: dict, tags: dict, at: str, facts: dict) -> None:
    """A READY reading, kept for the moments nobody can ask. A failure never
    overwrites the last good reading."""
    when = datetime.fromisoformat(at)
    if row["builtin"]:
        await pool.execute(
            "UPDATE engines SET last_ready_at = $2, last_tags = $3::jsonb, last_tags_at = $2, "
            "last_facts = $4::jsonb, last_facts_at = $2 WHERE provider = $1",
            row["name"], when, json.dumps(tags), json.dumps(facts),
        )
    else:
        await pool.execute(
            "UPDATE engines SET last_ready_at = $2, last_tags = $3::jsonb, last_tags_at = $2 "
            "WHERE provider = $1",
            row["name"], when, json.dumps(tags),
        )


async def _read(app, pool: asyncpg.Pool, row: dict) -> _Reading:
    if row["builtin"]:
        facts, compute = await _builtin_facts()
        runtime: str | None = BUILTIN_RUNTIME
    else:
        # Another machine's hardware is read by its own agent (S44); this
        # process can only see the hub, so nothing is guessed from here.
        facts, compute, runtime = {}, None, None
    try:
        listing = await adapters.for_row(row).list_models(app, row)
    except adapters.ProviderRefused as exc:
        return _Reading(
            ok=False, detail=exc.detail, tags=None, tags_as_of=None,
            observed_at=datetime.now(UTC).isoformat(), facts=facts, compute=compute,
            runtime=runtime, read_at_mono=_clock(),
        )
    tags = {model["id"]: model.get("size_bytes") for model in listing.models}
    await _remember(pool, row, tags, listing.fetched_at, facts)
    return _Reading(
        ok=True, detail=None, tags=tags, tags_as_of=listing.fetched_at,
        observed_at=listing.fetched_at, facts=facts, compute=compute, runtime=runtime,
        read_at_mono=_clock(),
    )


def _cached(name: str) -> _Reading | None:
    reading = _READINGS.get(name)
    if reading is None:
        return None
    ttl = READY_TTL_S if reading.ok else FAILURE_TTL_S
    if _clock() - reading.read_at_mono >= ttl:
        del _READINGS[name]
        return None
    return reading


def _switched_off(name: str) -> str:
    return f"{name} is switched off (serving=false): it runs no models until switched back on"


def _view(row: dict, reading: _Reading) -> EngineView:
    name = row["name"]
    if reading.ok:
        state, reason = ("ready", None) if row["serving"] else ("switched_off", _switched_off(name))
    else:
        unreachable = f"{name} could not be asked what is installed — {reading.detail}"
        if row["serving"]:
            state, reason = "unreachable", unreachable
        else:
            state, reason = "switched_off", f"{_switched_off(name)}; {unreachable}"
    return EngineView(
        name=name, lifecycle=row["lifecycle"], serving=row["serving"], state=state,
        reason=reason, observed_at=reading.observed_at, tags=reading.tags,
        tags_as_of=reading.tags_as_of, compute=reading.compute, runtime=reading.runtime,
        facts=reading.facts,
    )


def _unobserved(row: dict) -> EngineView:
    as_of = _iso(row["last_tags_at"])
    name = row["name"]
    if row["serving"]:
        state = "unobserved"
        reason = (
            f"{name} was not asked: it wakes on LAN and asking could wake it — what it last "
            f"listed is as of {as_of or 'never'}"
        )
    else:
        state, reason = "switched_off", _switched_off(name)
    return EngineView(
        name=name, lifecycle=row["lifecycle"], serving=row["serving"], state=state,
        reason=reason, observed_at=None, tags=row["last_tags"], tags_as_of=as_of,
        compute=None, runtime=None, facts=row["last_facts"] or {},
    )


async def observe(app, pool: asyncpg.Pool, row: dict, *, live: bool) -> EngineView:
    """What this engine is doing. `row` is an engine row (rows()/get()); a
    bare providers row is re-read, because `serving` must come from the
    stored switch, never a default."""
    if "serving" not in row:
        row = await get(pool, row["name"])
    reading = None if live else _cached(row["name"])
    if reading is None:
        if not live and row["lifecycle"] == "wake_on_lan":
            return _unobserved(row)
        reading = await _read(app, pool, row)
        _READINGS[row["name"]] = reading
    return _view(row, reading)


async def installed_sizes(app, pool: asyncpg.Pool, name: str) -> dict[str, int | None] | None:
    """{tag: download bytes} this engine lists (cached as observe caches);
    None when it could not be asked."""
    view = await observe(app, pool, await get(pool, name), live=False)
    return view.tags
```

- [ ] **Step 9: run green** (the Step 7 command). Expected: every test in `tests/test_engines.py` passes. Also run `tests/test_hardware_json_not_in_serving_path.py`, which passes now.

- [ ] **Step 10: failing API tests** — append to `tests/test_engines.py`
```python
# ── /admin/engines ───────────────────────────────────────────────────────


async def test_get_admin_engines_lists_every_engine_as_its_view(client, hub):
    resp = await client.get("/admin/engines")
    assert resp.status_code == 200
    [view] = resp.json()["engines"]
    assert set(view) == {field.name for field in dataclasses.fields(engines.EngineView)}
    assert (view["name"], view["state"], view["compute"], view["runtime"]) == (
        "hub", "ready", GPU, "container",
    )


async def test_live_1_asks_again_and_live_0_answers_from_the_cache(client, hub, clock):
    await client.get("/admin/engines")
    await client.get("/admin/engines?live=0")
    assert _tag_reads(hub) == 1
    await client.get("/admin/engines?live=1")
    assert _tag_reads(hub) == 2


async def test_one_engine_carries_its_card_in_admin_vrams_own_keys(client, hub, machine):
    hub.ps_models = [{"name": "qwen3:8b", "size": 6_000_000_000, "size_vram": 5_000_000_000}]
    body = (await client.get("/admin/engines/hub")).json()
    assert (body["name"], body["state"], body["fit_frame"]) == ("hub", "ready", "vram")
    vram = body["vram"]
    # The keys the deleted /admin/vram answered: core's readers move by path (T5).
    for key in (
        "total_mb", "used_mb", "free_mb", "util_pct", "reason", "total_gb", "free_gb",
        "used_gb", "resident", "resident_reason", "free_after_switch_gb",
    ):
        assert key in vram, key
    assert (vram["total_mb"], vram["uuid"], vram["cards"]) == (24576, UUID, 1)
    assert vram["resident"] == [
        {"model": "qwen3:8b", "vram_mb": 5_000_000_000 / (1024 * 1024),
         "size": 6_000_000_000, "size_vram": 5_000_000_000}
    ]
    assert vram["free_after_switch_gb"] == round(
        fit.free_gb_after_switch(21914, vram["resident"]), 1
    )
    machine["reading"] = devices_vram.Vram(reason=NO_GPU, absent=True)
    assert (await client.get("/admin/engines/hub")).json()["fit_frame"] == "ram"


async def test_another_machines_card_is_never_read_from_the_hub(client, pool, hub):
    await _add_sleeping_dell(pool)
    body = (await client.get("/admin/engines/dell")).json()
    assert body["state"] == "unobserved" and body["fit_frame"] == "ram"
    assert body["vram"]["total_mb"] is None and body["vram"]["resident"] is None
    assert "cannot read dell's card" in body["vram"]["reason"]


async def test_put_switches_serving_and_answers_with_the_row_read_back(client, pool, hub):
    resp = await client.put("/admin/engines/hub", json={"serving": False})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["name"], body["serving"], body["builtin"], body["lifecycle"]) == (
        "hub", False, True, "always_on",
    )
    assert "api_key" not in body and "base_url" not in body
    assert await pool.fetchval("SELECT serving FROM engines WHERE provider = 'hub'") is False
    [view] = (await client.get("/admin/engines")).json()["engines"]
    assert view["state"] == "switched_off"
    assert (await client.put("/admin/engines/hub", json={"serving": True})).json()["serving"]


@pytest.mark.parametrize(
    ("body", "words"),
    [
        ({}, "serving"),
        ({"serving": "no"}, "true or false"),
        ({"serving": None}, "true or false"),
        ({"serving": False, "lifecycle": "wake_on_lan"}, "cannot set lifecycle"),
    ],
)
async def test_put_refuses_what_it_cannot_set_and_writes_nothing(client, pool, hub, body, words):
    resp = await client.put("/admin/engines/hub", json=body)
    assert resp.status_code == 400 and words in resp.json()["error"]
    assert await pool.fetchval("SELECT serving FROM engines WHERE provider = 'hub'") is True


async def test_a_name_that_is_not_an_engine_is_a_404(client, pool, hub):
    await _add_cloud(pool)
    for name in ("nope", "openrouter"):
        assert (await client.get(f"/admin/engines/{name}")).status_code == 404
        put = await client.put(f"/admin/engines/{name}", json={"serving": False})
        assert put.status_code == 404 and put.json()["error"] == f"no engine named {name!r}"
```

- [ ] **Step 11: run red** (the Step 7 command). Expected: the new tests fail with `404 {"error":"Not Found"}` because the router is not mounted.

- [ ] **Step 12: implement** — `services/gateway/app/engines_api.py`, then mount it in `main.py`
```python
"""GET/PUT /admin/engines — every engine, one engine in full, and the owner's
serving switch (S40).

Replaces GET /admin/vram (deleted in T4): the card and what an engine holds
on it now live on the engine they belong to, under `vram`, in exactly the
keys /admin/vram answered — so its three readers in core move by path alone.
Reports, never decides (owner ruling 2026-09-03).
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Request

from app import db, devices_vram, engines
from app import fit as fit_mod

router = APIRouter(prefix="/admin", tags=["engines"])
logger = logging.getLogger("gateway")

SETTABLE = frozenset({"serving"})


def _not_found(name: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"no engine named {name!r}")


def _card(vram: devices_vram.Vram) -> dict:
    out = vram.as_dict()
    out["total_gb"] = round(vram.total_mb / 1024, 1) if vram.total_mb is not None else None
    out["free_gb"] = round(vram.free_mb / 1024, 1) if vram.free_mb is not None else None
    out["used_gb"] = round(vram.used_mb / 1024, 1) if vram.used_mb is not None else None
    return out


async def _vram(app, row: dict) -> tuple[dict, str]:
    """(the card block, fit_frame). Only the hub's own card is readable
    here; any other engine's card is read by its agent, never guessed from
    the hub's."""
    if not row["builtin"]:
        reason = f"cannot read {row['name']}'s card from the hub — only its own agent can"
        out = _card(devices_vram.Vram(reason=reason))
        out.update(resident=None, resident_reason=reason, free_after_switch_gb=None)
        accelerators = (row.get("last_facts") or {}).get("accelerators")
        return out, "vram" if accelerators else "ram"
    vram = await devices_vram.read_vram()
    out = _card(vram)
    resident, reason = await engines.resident(app, row)
    out["resident"] = resident
    out["resident_reason"] = reason
    out["free_after_switch_gb"] = (
        round(fit_mod.free_gb_after_switch(vram.free_mb, resident), 1)
        if resident is not None and vram.free_mb is not None
        else None
    )
    # No nvidia-smi in this container = no GPU passed through: models are
    # fitted against RAM. A card that exists but cannot be read stays the
    # VRAM frame — fit is then `unknown` with the card's own reason.
    return out, "ram" if vram.absent else "vram"


@router.get("/engines")
async def list_engines(request: Request, live: bool = False) -> dict:
    pool = await db.get_pool()
    views = [
        await engines.observe(request.app, pool, row, live=live)
        for row in await engines.rows(pool)
    ]
    return {"engines": [asdict(view) for view in views]}


@router.get("/engines/{name}")
async def get_engine(name: str, request: Request, live: bool = False) -> dict:
    pool = await db.get_pool()
    try:
        row = await engines.get(pool, name)
    except engines.UnknownEngine:
        raise _not_found(name) from None
    view = await engines.observe(request.app, pool, row, live=live)
    vram, frame = await _vram(request.app, row)
    return {**asdict(view), "vram": vram, "fit_frame": frame}


@router.put("/engines/{name}")
async def put_engine(name: str, request: Request) -> dict:
    raw = await request.body()
    try:
        body = json.loads(raw) if raw else {}
    except ValueError:
        raise HTTPException(status_code=400, detail="request body is not valid JSON") from None
    if not isinstance(body, dict) or not body:
        raise HTTPException(status_code=400, detail="the body must carry serving: true or false")
    extra = sorted(set(body) - SETTABLE)
    if extra:
        raise HTTPException(
            status_code=400,
            detail=f"cannot set {', '.join(extra)} on an engine — only serving can be set",
        )
    pool = await db.get_pool()
    try:
        stored = await engines.set_serving(pool, name, body.get("serving"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except engines.UnknownEngine:
        raise _not_found(name) from None
    logger.info("engine %s serving=%s", name, stored["serving"])
    return engines.to_public(stored)
```
In `main.py`:
- `:15` becomes `from app import admin, backends, data_plane, db, engines_api, usage`.
- After `:50`, add `app.include_router(engines_api.router)`.

- [ ] **Step 13: run green, then the whole gateway suite and lint**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p') && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s40_t2 uv run pytest -q
```
Expected: 0 failed, and no DB skips (`TEST_DATABASE_URL` is set). Then:
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway && uv run ruff format app/engines.py app/engines_api.py app/providers.py app/backends.py app/main.py app/routing.py app/catalog.py app/admin.py tests/conftest.py tests/fakes.py tests/test_engines.py tests/test_providers.py tests/test_routing.py tests/test_data_plane.py tests/test_usage.py tests/test_ollama_show.py tests/test_hardware_json_not_in_serving_path.py && uv run ruff check .
```

- [ ] **Step 14: commit**
```bash
cd /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff && git add services/gateway/app/engines.py services/gateway/app/engines_api.py services/gateway/app/providers.py services/gateway/app/backends.py services/gateway/app/main.py services/gateway/app/routing.py services/gateway/app/catalog.py services/gateway/app/admin.py services/gateway/tests/conftest.py services/gateway/tests/fakes.py services/gateway/tests/test_engines.py services/gateway/tests/test_providers.py services/gateway/tests/test_routing.py services/gateway/tests/test_data_plane.py services/gateway/tests/test_usage.py services/gateway/tests/test_ollama_show.py services/gateway/tests/test_hardware_json_not_in_serving_path.py && git commit -m "feat(gateway): engines — hub observed, failures cached, the owner's serving switch

S40: an engine is a provider row with adapter=ollama plus its engines
row; the bundled one is hub, found by builtin=true. engines.observe
states ready/unreachable/switched_off/unobserved, caches a ready reading
30 s and a failure 10 s (a failed listing used to be re-asked every
turn), and derives compute per process from nvidia-smi and /proc, never
from the stored facts. GET /admin/engines[/{name}] and PUT {serving},
which answers with the row read back; the per-engine vram block keeps
/admin/vram's keys. The startup seed, base_url_of, the wizard slugs and
the reserved names follow the rename; routing, catalog and admin look
the builtin up by name only until T3/T4 make them per-engine.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Hand-off to T3/T4/T5

- **Starting state for T3/T4:**
  - `routing.py:291,367`, `catalog.py:340,463,574` and `admin.py:665,1141` read `providers.get_row(pool, providers.BUILTIN)`; replace these with per-engine logic.
  - Still literal `ollama`, and T4 must move them:
    - catalog ids `f"ollama:{name}"` at `catalog.py:89,171` and `hf_hub.py:572`;
    - source keys `"ollama"` at `catalog.py:345,373`;
    - the probe `kind='ollama'` filters at `admin.py:252` and `catalog.py:299`.
  - T4 should also watch a name collision: the catalogue row `kind` `"hub"` (`catalog_row.py` `KINDS`) means the Hugging Face Hub, not the engine.
  - `routing.py:370` still says "the bundled ollama's default model"; T3 rewrites it.
- **T3:**
  - Use `engines.installed_sizes` and `engines.observe` (TTL caches included); delete `routing.TAGS_CACHE`.
  - The `switched_off` verdict comes from `view.state` or `row["serving"]`.
  - Compute `served_on` as `compute_id.served_on(entry["size"], entry["size_vram"], view.facts["accelerators"], view.facts["cpu"])` from `engines.resident(app, row)`. The runtime is `view.runtime`.
  - Call `engines.forget(name)` after a `ProviderUnreachable`.
  - Standby should read `embedding` from `engine_models`, which T4 writes.
- **T4:**
  - `admin._resident_models` should call `engines.resident`; delete `/admin/vram`.
  - Probes stamp `provider=row["name"]`, `compute=<served_on>`, `runtime=view.runtime` and `path='internal'` for the builtin.
  - Fit reads `WHERE compute = $view.compute`.
  - `engine_models` has no writer yet; the catalogue's `/api/show` is its single writer.
- **T5:** core's three `/admin/vram` readers switch to `GET /admin/engines/hub` and read `body["vram"]`, whose keys are unchanged.
- **T9 deploy precondition:** before deploying, run the read-only query `SELECT name FROM providers` on the live `nova_gateway`. If a provider is already named `hub` or `library`, 009 refuses and the gateway will not start (it says which one to rename).

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/migrations/009_engines.sql
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/engines.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/compute_id.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/providers.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/devices_vram.py