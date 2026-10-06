"""The card's one command per OS (S42b P18). Core is their ONE generator: the
chat card carries them filled, and the public manifest carries them with a
{CODE} slot for /add and Settings, which put the code in client-side (the code
never travels to the server from /add).

Each command downloads the hub's build to a fresh temp directory, checks its
sha256 BEFORE anything runs, runs `novad install`, and deletes the download
whatever happened — never left in Downloads (the owner, 2026-09-28). POSIX
sh (dash-safe, and run under bash and zsh too) for Linux and macOS; one line
of PowerShell 5.1 (no && or ||) for Windows. `install` then moves the binary
to the user's own folder and proves the agent came up.

The owner pastes a command into a shell as himself, so every value it
carries — an origin, a hub, the code, a sha256 — goes in as it stands only
when it needs no quoting in sh or PowerShell; anything else is refused
(ValueError), never escaped. What core passes always qualifies: an origin is
network.address()'s https://<MagicDNS name> or LOOPBACK, a code comes from
the pairing alphabet, and a sum from a checked manifest."""

from __future__ import annotations

import re
from collections.abc import Sequence

from app.agent_dist import Build

CODE_SLOT = "{CODE}"
OS_KEYS: tuple[str, ...] = ("linux", "macos", "windows")
LOOPBACK = "http://127.0.0.1:3000"
# Task 1's P0-20 reading (on the Dell) picks W1 or W2. Until it is read this
# is W1, by ruling (2026-10-01): it claims nothing about Smart App Control,
# so it stays true either way. W2 — if the reading shows Smart App Control
# blocks the unsigned exe — is "cannot: Smart App Control is on and blocks
# unsigned programs; Nova's agent is unsigned for now (owner decision 12).",
# and the constant changes before the walk (Task 32 re-checks).
WINDOWS_NOTE = (
    "Nova's agent is unsigned for now (owner decision 12); a download by curl.exe carries "
    "no mark for SmartScreen to ask about."
)
# L1 — chosen by Task 3 (self-linger without sudo, measured 2026-09-28 in
# docs/plans/rebuild/hub-p0-measurements.md): an active session may enable
# its own linger, so the Linux card says nothing extra. L2 would be "Starting
# at boot needs `sudo loginctl enable-linger $USER` once."
LINUX_NOTE = ""

# What a command may carry as it stands (see the module docstring).
_ORIGIN = re.compile(r"https?://[A-Za-z0-9.-]+(?::[0-9]{1,5})?")
_CODE = re.compile(r"[A-Z0-9]+(?:-[A-Z0-9]+)*")
_SHA256 = re.compile(r"[0-9a-f]{64}")


def notes() -> dict[str, str]:
    """The one sentence each OS's command carries beside it on the card and
    on /add (Task 28) — "" where there is nothing to say."""
    return {"linux": LINUX_NOTE, "macos": "", "windows": WINDOWS_NOTE}


def _carried(value: object, pattern: re.Pattern[str], what: str) -> str:
    """`value`, when a command can carry it as it stands; otherwise
    ValueError. The value is never echoed: it may be a code."""
    if not (isinstance(value, str) and pattern.fullmatch(value)):
        raise ValueError(f"{what} is not one a command can carry")
    return value


def _sums(build: Build, goos: str) -> tuple[str, str]:
    """`goos`'s amd64 and arm64 sha256 in `build`, each one a command can carry."""
    amd, arm = (
        _carried(
            (build.file_for(goos, arch) or {}).get("sha256"), _SHA256, f"the {goos}-{arch} sha256"
        )
        for arch in ("amd64", "arm64")
    )
    return amd, arm


def _hubs(hubs: Sequence[str]) -> str:
    return " ".join(f"--hub {h}" for h in hubs)


def _code(code: str | None) -> str:
    return f" --code {code}" if code else ""


def _posix(goos: str, build: Build, origin: str, hubs: Sequence[str], code: str | None) -> str:
    amd, arm = _sums(build, goos)
    check = "sha256sum -c -" if goos == "linux" else "shasum -a 256 -c -"
    return (
        "d=$(mktemp -d) && case $(uname -m) in "
        f"x86_64|amd64) a=amd64 h={amd};; aarch64|arm64) a=arm64 h={arm};; "
        '*) echo "cannot: Nova\'s agent has no build for $(uname -m)" >&2; a=;; esac && '
        f'[ -n "$a" ] && curl -fsSL -o "$d/novad" "{origin}/api/v1/agent/dist/novad-{goos}-$a" && '
        f'echo "$h  $d/novad" | {check} && chmod 0755 "$d/novad" && '
        f'"$d/novad" install {_hubs(hubs)}{_code(code)}; s=$?; rm -rf "$d"; [ "$s" -eq 0 ]'
    )


def _powershell(build: Build, origin: str, hubs: Sequence[str], code: str | None) -> str:
    amd, arm = _sums(build, "windows")
    return (
        "$d=Join-Path $env:TEMP ('nova-'+[guid]::NewGuid()); "
        "$null=New-Item -ItemType Directory -Path $d; "
        # The MACHINE's arch: a 32-bit PowerShell on x64 or ARM64 Windows
        # reads PROCESSOR_ARCHITECTURE as x86, and PROCESSOR_ARCHITEW6432
        # holds the real one there (fix round 1).
        "try { $p=$env:PROCESSOR_ARCHITEW6432; if(-not $p){$p=$env:PROCESSOR_ARCHITECTURE}; "
        "$a=@{AMD64='amd64';ARM64='arm64'}[$p]; "
        'if(-not $a){throw "cannot: Nova\'s agent has no build for $p"}; '
        f"$h=@{{amd64='{amd}';arm64='{arm}'}}[$a]; $f=Join-Path $d 'novad.exe'; "
        f'curl.exe -fsSL -o $f "{origin}/api/v1/agent/dist/novad-windows-$a.exe"; '
        "if($LASTEXITCODE -ne 0){throw 'the download failed'}; "
        "if((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash -ne $h)"
        '{throw "the download\'s sha256 does not match - not run"}; '
        f"& $f install {_hubs(hubs)}{_code(code)}; "
        'if($LASTEXITCODE -ne 0){throw "novad install failed (exit $LASTEXITCODE)"} '
        "} finally { Remove-Item -Recurse -Force -LiteralPath $d -ErrorAction SilentlyContinue }"
    )


def commands(
    build: Build, *, origin: str, hubs: Sequence[str] | None = None, code: str | None = None
) -> dict[str, str]:
    """The one command for each OS. `origin` is where it downloads from;
    `hubs` are the agent's locators in order (default: the origin alone);
    `code` is the pairing code, CODE_SLOT, or None to keep a live pairing."""
    origin = _carried(origin, _ORIGIN, "the origin")
    hubs = [_carried(h, _ORIGIN, "a hub") for h in hubs] if hubs else [origin]
    if code is not None and code != CODE_SLOT:
        code = _carried(code, _CODE, "the pairing code")
    return {
        "linux": _posix("linux", build, origin, hubs, code),
        "macos": _posix("darwin", build, origin, hubs, code),
        "windows": _powershell(build, origin, hubs, code),
    }
