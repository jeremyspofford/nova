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

Pure: nothing here reads a device or a file. The gateway's one reader of
the hub's own devices is engines.bundled_devices (ruling C1), which hands
its readings to these functions.

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
