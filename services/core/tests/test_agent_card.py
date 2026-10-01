"""The card's one-liners (S42b P18): core is their one generator. The POSIX
one is RUN here, under dash when it exists, against shims — the text that
ships is the text that is tested — and under bash and zsh as well, the shells
a Linux terminal and macOS's Terminal paste into. The PowerShell one is
checked for the shape PowerShell 5.1 can run (no && or ||), its exact text is
pinned, and its quoting is read here without pwsh; parsing it with
PowerShell's own parser runs in CI (Task 30, F10), so core's suite never
carries a skip for it.

Every value a command carries goes in as it stands, so one that would need
quoting in sh or PowerShell is refused, never escaped: the owner pastes the
result into a shell as himself."""

from __future__ import annotations

import hashlib
import shutil
import subprocess
from pathlib import Path

import pytest

from app import agent_card, agent_dist

ORIGIN = "https://nova.fake-tailnet.ts.net"
FAKE_NOVAD = '#!/bin/sh\necho "$@" > "$RECORD"\n'


def _build(sha: str, target: tuple[str, str] = ("linux", "amd64")) -> agent_dist.Build:
    """A build whose `target` file has `sha`; every other file a sum of its own."""
    files = {}
    for goos, arch in agent_dist.TARGETS:
        own = (
            sha if (goos, arch) == target else hashlib.sha256(f"{goos}{arch}".encode()).hexdigest()
        )
        files[agent_dist.file_key(goos, arch)] = {
            "name": agent_dist.file_name(goos, arch),
            "sha256": own,
            "size": 1,
        }
    return agent_dist.Build(version="aaaaaaaaaaaa", built_at="", go="", files=files)


@pytest.fixture
def world(tmp_path):
    """A PATH with a fake uname and curl, and the fake build curl "downloads"."""
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    (bin_ / "uname").write_text(
        '#!/bin/sh\ncase "$1" in -m) echo "$UNAME_M";; *) echo Linux;; esac\n'
    )
    (bin_ / "curl").write_text(
        '#!/bin/sh\nout=""\nurl=""\n'
        'while [ $# -gt 0 ]; do case "$1" in '
        '-o) out="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac; done\n'
        'echo "$out" > "$CURL_OUT"\necho "$url" > "$CURL_URL"\ncp "$FAKE_BUILD" "$out"\n'
    )
    for f in bin_.iterdir():
        f.chmod(0o755)
    fake = tmp_path / "novad.build"
    fake.write_text(FAKE_NOVAD)
    home = tmp_path / "home"
    home.mkdir()
    temp = tmp_path / "temp"
    temp.mkdir()
    return {
        "bin": bin_,
        "fake": fake,
        "sha": hashlib.sha256(fake.read_bytes()).hexdigest(),
        "record": tmp_path / "record",
        "curl_out": tmp_path / "curl_out",
        "curl_url": tmp_path / "curl_url",
        "home": home,
        "temp": temp,
    }


def _run(
    world, command: str, uname_m: str = "x86_64", shell: str | None = None
) -> subprocess.CompletedProcess:
    shell = shell or shutil.which("dash") or "/bin/sh"
    env = {
        "PATH": f"{world['bin']}:/usr/bin:/bin",
        "UNAME_M": uname_m,
        "FAKE_BUILD": str(world["fake"]),
        "RECORD": str(world["record"]),
        "CURL_OUT": str(world["curl_out"]),
        "CURL_URL": str(world["curl_url"]),
        # Contained: mktemp's directory lands in the test's own tmp, and no
        # rc file of the person running the suite is read (zsh reads ~/.zshenv).
        "HOME": str(world["home"]),
        "TMPDIR": str(world["temp"]),
    }
    return subprocess.run(
        [shell, "-c", command], env=env, capture_output=True, text=True, timeout=30
    )


def _forget(world) -> None:
    for key in ("record", "curl_out", "curl_url"):
        world[key].unlink(missing_ok=True)


def test_the_linux_command_downloads_checks_installs_and_cleans_up(world):
    cmd = agent_card.commands(_build(world["sha"]), origin=ORIGIN, code="ABCD-2345")["linux"]
    done = _run(world, cmd)
    assert done.returncode == 0, done.stderr
    assert world["record"].read_text().strip() == f"install --hub {ORIGIN} --code ABCD-2345"
    assert world["curl_url"].read_text().strip() == f"{ORIGIN}/api/v1/agent/dist/novad-linux-amd64"
    downloaded = Path(world["curl_out"].read_text().strip())
    assert downloaded.parent.parent == world["temp"], "downloaded into a fresh temp directory"
    assert not downloaded.parent.exists(), (
        "the download is deleted afterwards (never left in Downloads)"
    )


def test_a_download_whose_sha256_does_not_match_is_never_run(world):
    cmd = agent_card.commands(_build("0" * 64), origin=ORIGIN, code="ABCD-2345")["linux"]
    done = _run(world, cmd)
    assert done.returncode != 0 and not world["record"].exists()
    downloaded = Path(world["curl_out"].read_text().strip())
    assert not downloaded.parent.exists(), "a refused download is deleted too"


def test_a_machine_with_no_build_is_told_cannot(world):
    cmd = agent_card.commands(_build(world["sha"]), origin=ORIGIN, code="ABCD-2345")["linux"]
    done = _run(world, cmd, uname_m="armv7l")
    assert done.returncode != 0 and "cannot: Nova's agent has no build for armv7l" in done.stderr
    assert not world["record"].exists() and not world["curl_out"].exists()
    assert list(world["temp"].iterdir()) == [], "the temp directory is deleted when nothing ran"


@pytest.mark.parametrize(
    ("os_key", "goos", "uname_m", "arch"),
    [
        ("linux", "linux", "x86_64", "amd64"),
        ("linux", "linux", "aarch64", "arm64"),
        ("macos", "darwin", "arm64", "arm64"),
        ("macos", "darwin", "x86_64", "amd64"),
    ],
)
def test_the_posix_commands_run_in_the_shells_they_are_pasted_into(
    world, os_key, goos, uname_m, arch
):
    """dash is the strictest POSIX sh; bash is a Linux terminal's; zsh is
    macOS Terminal's (and many a Linux user's). Each one present runs the
    line for real: the right file is fetched, its sum checked (sha256sum on
    Linux, shasum on macOS) and the install run. dash and bash are on every
    Linux this suite runs on; zsh runs wherever it is installed."""
    cmd = agent_card.commands(_build(world["sha"], (goos, arch)), origin=ORIGIN, code="ABCD-2345")[
        os_key
    ]
    ran = []
    for shell in ("dash", "bash", "zsh"):
        path = shutil.which(shell)
        if path is None:
            continue
        _forget(world)
        done = _run(world, cmd, uname_m=uname_m, shell=path)
        assert done.returncode == 0, (shell, done.stderr)
        assert world["record"].read_text().strip() == f"install --hub {ORIGIN} --code ABCD-2345", (
            shell
        )
        assert (
            world["curl_url"].read_text().strip()
            == f"{ORIGIN}/api/v1/agent/dist/novad-{goos}-{arch}"
        )
        assert list(world["temp"].iterdir()) == [], shell
        ran.append(shell)
    assert {"dash", "bash"} <= set(ran), ran


@pytest.mark.parametrize(("os_key", "goos"), [("linux", "linux"), ("macos", "darwin")])
def test_a_download_that_does_not_match_is_never_run_in_any_of_those_shells(world, os_key, goos):
    cmd = agent_card.commands(_build("0" * 64, (goos, "amd64")), origin=ORIGIN, code="ABCD-2345")[
        os_key
    ]
    ran = []
    for shell in ("dash", "bash", "zsh"):
        path = shutil.which(shell)
        if path is None:
            continue
        _forget(world)
        done = _run(world, cmd, shell=path)
        assert done.returncode != 0, shell
        assert world["curl_out"].exists() and not world["record"].exists(), shell
        assert list(world["temp"].iterdir()) == [], shell
        ran.append(shell)
    assert {"dash", "bash"} <= set(ran), ran


def test_the_hubs_own_agent_gets_its_loopback_first():
    cmd = agent_card.commands(
        _build("a" * 64), origin=agent_card.LOOPBACK, hubs=[agent_card.LOOPBACK, ORIGIN], code=None
    )["linux"]
    assert f"install --hub {agent_card.LOOPBACK} --hub {ORIGIN};" in cmd and "--code" not in cmd
    assert f'"{agent_card.LOOPBACK}/api/v1/agent/dist/novad-linux-$a"' in cmd


def test_the_windows_command_is_powershell_5_1_and_checks_before_it_runs():
    build = _build("a" * 64)
    cmd = agent_card.commands(build, origin=ORIGIN, code=agent_card.CODE_SLOT)["windows"]
    assert "&&" not in cmd and "||" not in cmd
    assert cmd.index("Get-FileHash -Algorithm SHA256") < cmd.index("& $f install")
    for arch in ("amd64", "arm64"):
        assert build.file_for("windows", arch)["sha256"] in cmd
    assert f"--hub {ORIGIN} --code {agent_card.CODE_SLOT}" in cmd
    assert cmd.rstrip().endswith(
        "Remove-Item -Recurse -Force -LiteralPath $d -ErrorAction SilentlyContinue }"
    )


# The Windows line, whole (F10: pwsh parses it in CI, Task 30; here its text is
# the pin, so any change to it is a deliberate one). Fix round 1 moved it: the
# arch is the MACHINE's, PROCESSOR_ARCHITEW6432 first.
WINDOWS_LINE = (
    "$d=Join-Path $env:TEMP ('nova-'+[guid]::NewGuid()); "
    "$null=New-Item -ItemType Directory -Path $d; "
    "try { $p=$env:PROCESSOR_ARCHITEW6432; if(-not $p){$p=$env:PROCESSOR_ARCHITECTURE}; "
    "$a=@{AMD64='amd64';ARM64='arm64'}[$p]; "
    'if(-not $a){throw "cannot: Nova\'s agent has no build for $p"}; '
    "$h=@{amd64='<AMD>';arm64='<ARM>'}[$a]; $f=Join-Path $d 'novad.exe'; "
    "curl.exe -fsSL -o $f "
    '"https://nova.fake-tailnet.ts.net/api/v1/agent/dist/novad-windows-$a.exe"; '
    "if($LASTEXITCODE -ne 0){throw 'the download failed'}; "
    "if((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash -ne $h)"
    '{throw "the download\'s sha256 does not match - not run"}; '
    "& $f install --hub https://nova.fake-tailnet.ts.net --code ABCD-2345; "
    'if($LASTEXITCODE -ne 0){throw "novad install failed (exit $LASTEXITCODE)"} '
    "} finally { Remove-Item -Recurse -Force -LiteralPath $d -ErrorAction SilentlyContinue }"
)


def _windows_build() -> agent_dist.Build:
    build = _build("a" * 64)
    files = dict(build.files)
    files["windows-amd64"] = {**files["windows-amd64"], "sha256": "1" * 64}
    files["windows-arm64"] = {**files["windows-arm64"], "sha256": "2" * 64}
    return agent_dist.Build(version=build.version, built_at="", go="", files=files)


def test_the_windows_command_reads_the_machines_arch_not_a_32_bit_shells():
    """Fix round 1: a 32-bit PowerShell on x64 or ARM64 Windows (SysWOW64)
    reads PROCESSOR_ARCHITECTURE as x86, so the line would say "no build for
    x86" on a machine that has one. PROCESSOR_ARCHITEW6432 holds the
    machine's own arch there; it is read first, and the native value only
    when it is unset — with no && or || (PowerShell 5.1)."""
    cmd = agent_card.commands(_build("a" * 64), origin=ORIGIN, code="ABCD-2345")["windows"]
    reads = "$p=$env:PROCESSOR_ARCHITEW6432; if(-not $p){$p=$env:PROCESSOR_ARCHITECTURE}; "
    assert reads in cmd
    assert cmd.index(reads) < cmd.index("$a=@{AMD64='amd64';ARM64='arm64'}[$p]")
    assert "[$env:PROCESSOR_ARCHITECTURE]" not in cmd
    assert 'throw "cannot: Nova\'s agent has no build for $p"' in cmd


def test_the_windows_command_is_exactly_this_line():
    cmd = agent_card.commands(_windows_build(), origin=ORIGIN, code="ABCD-2345")["windows"]
    assert cmd == WINDOWS_LINE.replace("<AMD>", "1" * 64).replace("<ARM>", "2" * 64)


def _powershell_quoting(cmd: str) -> list[str]:
    """What would leave PowerShell's tokenizer mid-string or mid-block, read
    without pwsh: every '…' (with '' inside) and "…" (with `x or "" inside)
    closes, no "…" holds a $( ) subexpression this reader does not follow,
    and (), {} and [] balance outside the strings. Returns what is wrong."""
    wrong: list[str] = []
    opened = {"(": 0, "{": 0, "[": 0}
    closes = {")": "(", "}": "{", "]": "["}
    i = 0
    while i < len(cmd):
        c = cmd[i]
        if c == "'":
            j = i + 1
            while True:
                k = cmd.find("'", j)
                if k == -1:
                    return [*wrong, f"a ' opened at {i} never closes"]
                if cmd[k + 1 : k + 2] == "'":
                    j = k + 2
                    continue
                break
            i = k + 1
            continue
        if c == '"':
            j = i + 1
            while j < len(cmd) and cmd[j] != '"':
                if cmd[j] == "`":
                    j += 1
                elif cmd.startswith("$(", j):
                    wrong.append(f"a subexpression inside the string at {i}")
                j += 1
            if j >= len(cmd):
                return [*wrong, f'a " opened at {i} never closes']
            i = j + 1
            continue
        if c in opened:
            opened[c] += 1
        elif c in closes:
            opened[closes[c]] -= 1
            if opened[closes[c]] < 0:
                wrong.append(f"{c} at {i} closes nothing")
        i += 1
    wrong += [f"{n} {o} never closed" for o, n in opened.items() if n > 0]
    return wrong


@pytest.mark.parametrize("code", ["ABCD-2345", agent_card.CODE_SLOT, None])
@pytest.mark.parametrize("hubs", [None, [agent_card.LOOPBACK, ORIGIN]])
def test_the_windows_commands_quoting_closes_whatever_it_carries(code, hubs):
    cmd = agent_card.commands(_build("a" * 64), origin=ORIGIN, hubs=hubs, code=code)["windows"]
    assert _powershell_quoting(cmd) == []


def test_the_quoting_reader_sees_a_broken_line():
    """The reader above is a check only if it can fail: each break is seen."""
    good = WINDOWS_LINE
    assert _powershell_quoting(good) == []
    assert _powershell_quoting(good.replace("'novad.exe'", "'novad.exe")) != []
    assert _powershell_quoting(good.replace("\"the download's", "the download's")) != []
    assert _powershell_quoting(good.replace("finally {", "finally ")) != []
    assert _powershell_quoting(good.replace("(Get-FileHash", "Get-FileHash")) != []


def test_every_command_is_one_line():
    for code in ("ABCD-2345", agent_card.CODE_SLOT, None):
        for os_key, cmd in agent_card.commands(_build("a" * 64), origin=ORIGIN, code=code).items():
            assert "\n" not in cmd and "\r" not in cmd, os_key


def test_the_mac_command_uses_shasum():
    cmd = agent_card.commands(_build("a" * 64), origin=ORIGIN, code="ABCD-2345")["macos"]
    assert "shasum -a 256 -c -" in cmd and "novad-darwin-$a" in cmd


# -- what a command carries goes in as it stands, or not at all ----------------


@pytest.mark.parametrize(
    "origin",
    [
        "https://nova.fake-tailnet.ts.net; rm -rf ~",
        'https://nova.fake-tailnet.ts.net" & calc.exe & "',
        "https://nova.fake-tailnet.ts.net/$(id)",
        "https://nova.fake-tailnet.ts.net\nid",
        "https://nova.fake-tailnet.ts.net/add",
        "ftp://nova.fake-tailnet.ts.net",
        "",
    ],
)
def test_an_origin_a_command_cannot_carry_as_it_stands_is_refused(origin):
    with pytest.raises(ValueError, match="not one a command can carry"):
        agent_card.commands(_build("a" * 64), origin=origin, code="ABCD-2345")
    with pytest.raises(ValueError, match="not one a command can carry"):
        agent_card.commands(
            _build("a" * 64), origin=ORIGIN, hubs=[ORIGIN, origin], code="ABCD-2345"
        )


@pytest.mark.parametrize(
    "code", ["ABCD 2345", "$(id)", "AB;CD", "-x", "abcd-2345", "ABCD-", "`id`"]
)
def test_a_code_a_command_cannot_carry_as_it_stands_is_refused(code):
    with pytest.raises(ValueError, match="not one a command can carry") as refused:
        agent_card.commands(_build("a" * 64), origin=ORIGIN, code=code)
    assert code not in str(refused.value), "a refusal never echoes what might be a code"


def test_a_build_whose_sum_a_command_cannot_carry_is_refused():
    build = _build("a" * 64)
    files = dict(build.files)
    files["windows-arm64"] = {**files["windows-arm64"], "sha256": "'; calc.exe; '"}
    with pytest.raises(ValueError, match="windows-arm64 sha256 is not one a command can carry"):
        agent_card.commands(
            agent_dist.Build("aaaaaaaaaaaa", "", "", files), origin=ORIGIN, code="ABCD-2345"
        )
    files.pop("windows-arm64")
    with pytest.raises(ValueError, match="windows-arm64 sha256 is not one a command can carry"):
        agent_card.commands(
            agent_dist.Build("aaaaaaaaaaaa", "", "", files), origin=ORIGIN, code="ABCD-2345"
        )


def test_each_os_carries_its_one_note():
    """W1 (Task 1's P0-20 reading picks W1 or W2; ruled W1 until it is read):
    the Windows note claims nothing about Smart App Control. L1 (Task 3,
    measured): the Linux card says nothing extra."""
    assert agent_card.notes() == {
        "linux": "",
        "macos": "",
        "windows": (
            "Nova's agent is unsigned for now (owner decision 12); a download by curl.exe "
            "carries no mark for SmartScreen to ask about."
        ),
    }
    assert tuple(agent_card.notes()) == agent_card.OS_KEYS
