"""A turn that goes in circles stops; a productive one never does (turn-cap T3).

The owner's turn c042afa1 (2026-10-07, "start it") made 20 different,
informative device calls and was cut off by a fixed count of 20. T3 is the
check that replaces the count as the normal stop: `chat.RoundProgress`, one per
turn, fed each dispatched round's calls and their tool-message results. It
says STOP_REPEATED_CALL when one call (name + canonical arguments) reaches its
SAME_CALL_LIMIT-th dispatch, and STOP_NO_NEW_RESULTS after STALE_ROUNDS_LIMIT
consecutive rounds that returned nothing new: every result of such a round is
text already returned earlier this turn (by any call, after whitespace is
normalised). An "Error:" result is news when its text is new: novad reports a
missing binary as one, and hunting for a binary is real progress. Pure: no DB,
no model.
"""

from __future__ import annotations

import builtins
import copy
import dataclasses
import json
import socket

import pytest

from app import agents, chat, tools, traces
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import _agent_turn, _create, _owner, _reply
from tests.test_chat_tools import _say, _set, whole_call
from tests.test_chat_tools import text as text_delta

# c042afa1-b3b3-4d45-95f4-4de0ad1b9c39, read read-only from the live nova_core
# turn_spans on 2026-10-07: every tool span that reached its executor plus the
# unasked device_info, in started_at order, as (name, args_redacted, result_head).
# One call per round. 19 distinct device_run args, 19 distinct heads, none
# Error-prefixed.
C042AFA1_ROUNDS = [
    (
        "device_info",
        {"device": "DELL-XPS-8950"},
        "DELL-XPS-8950 system info:\n"
        "host=DELL-XPS-8950; os=Windows 11 Pro 25H2 (build 26200); disk C:\\Users\\jerem "
        "free 440.5 GiB of 952.8 GiB; mem available 43.0 GiB of 63.7 GiB; uptime=0d 19h 8m; "
        "home=C:\\Users\\jerem; desktop=C:\\Users\\jerem\\OneDrive\\Desktop\n"
        "(the agent was not asked to look again — an unasked check never makes it probe — so "
        "the lines below on how it runs are as probed at 2026-10-07T16:27:37",
    ),
    (
        "device_run",
        {
            "argv": [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-Command ollama -ErrorAction SilentlyContinue | Select-Object "
                "-ExpandProperty Source; Get-Process ollama -ErrorAction SilentlyContinue",
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['powershell', '-NoProfile', '-Command', 'Get-Command ollama "
        "-ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source; Get-Process "
        "ollama -ErrorAction SilentlyContinue'] — exit 1\n"
        "\n"
        "[process exited with code 1]",
    ),
    (
        "device_run",
        {
            "argv": [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-ChildItem -Path @($env:LOCALAPPDATA, $env:ProgramFiles, "
                "${env:ProgramFiles(x86)}) -Filter 'ollama.exe' -Recurse -ErrorAction "
                "SilentlyContinue | Select-Object -ExpandProperty FullName",
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['powershell', '-NoProfile', '-Command', \"Get-ChildItem "
        "-Path @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}) -Filter "
        "'ollama.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty "
        'FullName"] — exit 1\n'
        "\n"
        "[process exited with code 1]",
    ),
    (
        "device_run",
        {
            "argv": [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-ChildItem -Path $env:LOCALAPPDATA -Filter 'ollama.exe' -Recurse "
                "-ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName",
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['powershell', '-NoProfile', '-Command', \"Get-ChildItem "
        "-Path $env:LOCALAPPDATA -Filter 'ollama.exe' -Recurse -ErrorAction SilentlyContinue "
        '| Select-Object -ExpandProperty FullName"] — exit 1\n'
        "\n"
        "[process exited with code 1]",
    ),
    (
        "device_run",
        {
            "argv": ["wsl.exe", "-d", "Ubuntu-26.04", "--exec", "which", "ollama"],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['wsl.exe', '-d', 'Ubuntu-26.04', '--exec', 'which', 'ollama'] — "
        "exit 1\n"
        "\n"
        "[process exited with code 1]",
    ),
    (
        "device_run",
        {
            "argv": [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-Process | Select-Object -ExpandProperty ProcessName",
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['powershell', '-NoProfile', '-Command', 'Get-Process | "
        "Select-Object -ExpandProperty ProcessName'] — exit 0\n"
        "1Password\r\n"
        "1Password\r\n"
        "1Password\r\n"
        "1Password-BrowserSupport\r\n"
        "1Password-BrowserSupport\r\n"
        "1Password-Crash-Handler\r\n"
        "AggregatorHost\r\n"
        "AppActions\r\n"
        "ApplicationFrameHost\r\n"
        "audiodg\r\n"
        "backgroundTaskHost\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "brave\r\n"
        "browser_helper\r\n"
        "claude\r\n"
        "claude\r\n"
        "claude\r\n"
        "clau",
    ),
    (
        "device_run",
        {
            "argv": ["powershell", "-NoProfile", "-Command", "tailscale serve status"],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['powershell', '-NoProfile', '-Command', 'tailscale serve "
        "status'] — exit 0\n"
        "|-- tcp://dell-xps-8950-windows.tailba0abb.ts.net:11435 (tailnet only)\n"
        "|-- tcp://100.122.40.93:11435\n"
        "|-- tcp://[fd7a:115c:a1e0::8c39:285d]:11435\n"
        "|--> tcp://127.0.0.1:11434\n"
        "\n"
        "https://dell-xps-8950-windows.tailba0abb.ts.net (tailnet only)\n"
        "|-- / proxy http://127.0.0.1:8080\n"
        "\n",
    ),
    (
        "device_run",
        {
            "argv": [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-ChildItem -Path \"C:\\Program Files\" -Filter '*ollama*' -Recurse "
                "-ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName",
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['powershell', '-NoProfile', '-Command', 'Get-ChildItem -Path "
        "\"C:\\\\Program Files\" -Filter \\'*ollama*\\' -Recurse -ErrorAction "
        "SilentlyContinue | Select-Object -ExpandProperty FullName'] — exit 1\n"
        "\n"
        "[process exited with code 1]",
    ),
    (
        "device_run",
        {
            "argv": [
                "powershell",
                "-NoProfile",
                "-Command",
                'Test-Path "C:\\Users\\jerem\\AppData\\Local\\Programs\\Ollama\\ollama.exe"',
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['powershell', '-NoProfile', '-Command', 'Test-Path "
        '"C:\\\\Users\\\\jerem\\\\AppData\\\\Local\\\\Programs\\\\Ollama\\\\ollama.exe"\'] — '
        "exit 0\n"
        "False\r\n",
    ),
    (
        "device_run",
        {
            "argv": [
                "powershell",
                "-NoProfile",
                "-Command",
                'Get-ChildItem -Path "C:\\Users\\jerem\\AppData\\Local\\Programs" '
                "-Directory | Select-Object -ExpandProperty Name",
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['powershell', '-NoProfile', '-Command', 'Get-ChildItem -Path "
        '"C:\\\\Users\\\\jerem\\\\AppData\\\\Local\\\\Programs" -Directory | Select-Object '
        "-ExpandProperty Name'] — exit 0\n"
        "@littlebirddesktop\r\n"
        "CD Projekt Red\r\n"
        "Common\r\n"
        "Greenshot\r\n"
        "LM Studio\r\n"
        "Microsoft VS Code\r\n"
        "Notta\r\n"
        "Nova\r\n"
        "Obsidian\r\n"
        "Opera\r\n"
        "Reolink\r\n",
    ),
    (
        "device_run",
        {
            "argv": [
                "powershell",
                "-NoProfile",
                "-Command",
                'Test-Path "C:\\Users\\jerem\\.ollama"',
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['powershell', '-NoProfile', '-Command', 'Test-Path "
        '"C:\\\\Users\\\\jerem\\\\.ollama"\'] — exit 0\n'
        "False\r\n",
    ),
    (
        "device_run",
        {
            "argv": [
                "wsl.exe",
                "-d",
                "Ubuntu-26.04",
                "--exec",
                "sh",
                "-c",
                'find /home /usr -name "*ollama*" 2>/dev/null',
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['wsl.exe', '-d', 'Ubuntu-26.04', '--exec', 'sh', '-c', 'find "
        '/home /usr -name "*ollama*" 2>/dev/null\'] — exit 1\n'
        "/home/jeremy/.local/share/nvim/lazy/codecompanion.nvim/lua/codecompanion/adapters/http/ollama\n"
        "/home/jeremy/.local/share/nvim/lazy/codecompanion.nvim/tests/adapters/http/stubs/ollama_reasoning_no_streaming_LOCAL_38366.txt\n"
        "/home/jeremy/.local/share/nvim/lazy/codecompanion.nvim/tests/adapters/http/stubs/output/ollama_tools_no_params.lua\n"
        "/home/jeremy/.local/share/nvim/la",
    ),
    (
        "device_run",
        {
            "argv": [
                "wsl.exe",
                "-d",
                "Ubuntu-26.04",
                "--exec",
                "/home/jeremy/.local/share/mise/installs/ollama/0.30.10/bin/ollama",
                "--version",
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['wsl.exe', '-d', 'Ubuntu-26.04', '--exec', "
        "'/home/jeremy/.local/share/mise/installs/ollama/0.30.10/bin/ollama', '--version'] — "
        "exit 0\n"
        "Warning: could not connect to a running Ollama instance\n"
        "Warning: client version is 0.30.10\n",
    ),
    (
        "device_run",
        {
            "argv": [
                "wsl.exe",
                "-d",
                "Ubuntu-26.04",
                "--exec",
                "systemctl",
                "--user",
                "list-unit-files",
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['wsl.exe', '-d', 'Ubuntu-26.04', '--exec', 'systemctl', "
        "'--user', 'list-unit-files'] — exit 0\n"
        "UNIT FILE                                        STATE     PRESET\n"
        "app-snap\\x2duserd\\x2dautostart@autostart.service generated -\n"
        "at-spi-dbus-bus.service                          static    -\n"
        "dbus.service                                     static    -\n"
        "dconf.service                                    static    -\n"
        "dirmngr.service                                  static    -\n"
        "gpg-agent.servic",
    ),
    (
        "device_run",
        {
            "argv": [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-Service | Where-Object { $_.Name -match 'ollama|lmstudio' -or "
                "$_.DisplayName -match 'ollama|lmstudio' }",
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['powershell', '-NoProfile', '-Command', \"Get-Service | "
        "Where-Object { $_.Name -match 'ollama|lmstudio' -or $_.DisplayName -match "
        "'ollama|lmstudio' }\"] — exit 0\n"
        "(no output)",
    ),
    (
        "device_run",
        {
            "argv": [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-Service -Name *ollama* -ErrorAction SilentlyContinue",
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['powershell', '-NoProfile', '-Command', 'Get-Service -Name "
        "*ollama* -ErrorAction SilentlyContinue'] — exit 0\n"
        "(no output)",
    ),
    (
        "device_run",
        {
            "argv": [
                "wsl.exe",
                "-d",
                "Ubuntu-26.04",
                "--exec",
                "cat",
                "/home/jeremy/.claude/projects/-home-jeremy-workspace-nova/memory/ollama-container-shadows-host.md",
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['wsl.exe', '-d', 'Ubuntu-26.04', '--exec', 'cat', "
        "'/home/jeremy/.claude/projects/-home-jeremy-workspace-nova/memory/ollama-container-shadows-host.md'] "  # noqa: E501 (recorded verbatim)
        "— exit 0\n"
        "---\n"
        "name: ollama-container-shadows-host\n"
        'description: "Bundled Ollama container binds 127.0.0.1:11434 and shadows a '
        'host/Windows Ollama, hiding its models"\n'
        "metadata: \n"
        "  node_type: memory\n"
        "  type: reference\n"
        "  originSessionId: c7663ecc-569e-4f7b-8e87-a061e336ab4d\n"
        "---\n"
        "\n"
        "When `COMPOSE_PROFILES` includes `inference-ollama`, the",
    ),
    (
        "device_run",
        {
            "argv": ["wsl.exe", "-d", "Ubuntu-26.04", "--exec", "docker", "ps", "-a"],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['wsl.exe', '-d', 'Ubuntu-26.04', '--exec', 'docker', 'ps', '-a'] "
        "— exit 0\n"
        "CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES\n",
    ),
    (
        "device_run",
        {
            "argv": ["powershell", "-NoProfile", "-Command", "winget list --id Ollama.Ollama"],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['powershell', '-NoProfile', '-Command', 'winget list --id "
        "Ollama.Ollama'] — exit 1\n"
        "No installed package found matching input criteria.\r\n"
        "\n"
        "[process exited with code 1]",
    ),
    (
        "device_run",
        {
            "argv": [
                "powershell",
                "-NoProfile",
                "-Command",
                "winget list | Select-String -Pattern 'ollama|lm studio'",
            ],
            "device": "DELL-XPS-8950",
        },
        "DELL-XPS-8950 ran ['powershell', '-NoProfile', '-Command', \"winget list | "
        "Select-String -Pattern 'ollama|lm studio'\"] — exit 0\n"
        "(no output)",
    ),
]


def _call(name: str, arguments, i: int = 0) -> chat.ToolCall:
    if not isinstance(arguments, str):
        arguments = json.dumps(arguments)
    return chat.ToolCall(id=f"call_{i}", name=name, arguments=arguments)


def _err(what: str = "nope") -> str:
    return f"{tools.ERROR_PREFIX}{what}"


def _fresh_round(progress: chat.RoundProgress, i: int) -> str | None:
    """A round with one never-seen call returning a never-seen non-Error result."""
    return progress.after_round([_call("read_file", {"path": f"/fresh/{i}"}, i)], [f"body {i}"])


def _error_round(progress: chat.RoundProgress, i: int) -> str | None:
    """A round with one never-seen call that fails with a never-seen error."""
    return progress.after_round(
        [_call("read_file", {"path": f"/missing/{i}"}, i)], [_err(f"no /missing/{i}")]
    )


SEEN = _err("no such file")


def _seed(progress: chat.RoundProgress) -> str | None:
    """The round that first returns SEEN (news: its text is new)."""
    return progress.after_round([_call("read_file", {"path": "/seed"}, 0)], [SEEN])


def _stale_round(progress: chat.RoundProgress, i: int) -> str | None:
    """A round with one never-seen call returning SEEN again (call _seed first)."""
    return progress.after_round([_call("read_file", {"path": f"/again/{i}"}, i)], [SEEN])


# The heads novad's missing-binary failures return, as seen live on the Dell
# (turn_spans result_head, read read-only 2026-10-07): Error-prefixed, each a
# real finding while she hunts for a binary.
NOT_FOUND_BINARIES = ["nvidia-smi", "pip3", "tree", "qrencode", "ollama", "docker"]


def _not_found(binary: str) -> str:
    return (
        f'{tools.ERROR_PREFIX}DELL-XPS-8950: could not run "{binary}": '
        f'exec: "{binary}": executable file not found in $PATH'
    )


# -- C1 named outcome ----------------------------------------------------------


def test_the_outcomes_and_thresholds_are_named_module_constants():
    assert chat.STOP_REPEATED_CALL == "repeated_call"
    assert chat.STOP_NO_NEW_RESULTS == "no_new_results"
    # The one place the values are pinned (reasons in the tracker's PLAN Log).
    assert chat.SAME_CALL_LIMIT == 3
    assert chat.STALE_ROUNDS_LIMIT == 3


def test_a_round_with_news_returns_none():
    assert _fresh_round(chat.RoundProgress(), 1) is None


def test_after_round_returns_only_none_or_a_named_reason():
    progress = chat.RoundProgress()
    outcomes = [_seed(progress)]
    outcomes += [_stale_round(progress, i) for i in range(chat.STALE_ROUNDS_LIMIT)]
    assert set(outcomes) <= {None, chat.STOP_REPEATED_CALL, chat.STOP_NO_NEW_RESULTS}
    assert outcomes[-1] == chat.STOP_NO_NEW_RESULTS


# -- C2 repeated call ------------------------------------------------------------


def test_the_limit_th_dispatch_across_rounds_stops_even_with_new_results_each_time():
    progress = chat.RoundProgress()
    outcomes = [
        progress.after_round([_call("device_run", {"argv": ["date"]}, i)], [f"Tue 16:4{i}"])
        for i in range(chat.SAME_CALL_LIMIT)
    ]
    assert outcomes[:-1] == [None] * (chat.SAME_CALL_LIMIT - 1)
    assert outcomes[-1] == chat.STOP_REPEATED_CALL


def test_the_limit_th_dispatch_within_one_round_stops():
    progress = chat.RoundProgress()
    calls = [_call("device_run", {"argv": ["date"]}, i) for i in range(chat.SAME_CALL_LIMIT)]
    results = [f"Tue 16:4{i}" for i in range(chat.SAME_CALL_LIMIT)]
    assert progress.after_round(calls, results) == chat.STOP_REPEATED_CALL


def test_one_dispatch_short_of_the_limit_never_stops():
    progress = chat.RoundProgress()
    outcomes = []
    for i in range(chat.SAME_CALL_LIMIT - 1):
        outcomes.append(
            progress.after_round([_call("device_run", {"argv": ["ps"]}, i)], [f"ps {i}"])
        )
        outcomes.append(_fresh_round(progress, i))
    for i in range(10):
        outcomes.append(_fresh_round(progress, 100 + i))
    assert outcomes == [None] * len(outcomes)


@pytest.mark.parametrize(
    "variants",
    [
        ['{"a": 1, "b": [1, 2]}', '{"b": [1, 2], "a": 1}', '{"b":[1,2],"a":1}'],
        ['{"path": "/x"}', '{ "path" : "/x" }', '{\n  "path": "/x"\n}'],
    ],
    ids=["key-order", "whitespace"],
)
def test_json_arguments_differing_only_in_order_or_whitespace_are_one_key(variants):
    progress = chat.RoundProgress()
    variants = (variants * chat.SAME_CALL_LIMIT)[: chat.SAME_CALL_LIMIT]
    outcomes = [progress.after_round([_call("t", v, i)], [f"r{i}"]) for i, v in enumerate(variants)]
    assert outcomes[-1] == chat.STOP_REPEATED_CALL
    assert outcomes[:-1] == [None] * (chat.SAME_CALL_LIMIT - 1)


def test_arguments_that_do_not_parse_compare_as_their_raw_string():
    same = chat.RoundProgress()
    outcomes = [
        same.after_round([_call("t", "not json {", i)], [f"r{i}"])
        for i in range(chat.SAME_CALL_LIMIT)
    ]
    assert outcomes[-1] == chat.STOP_REPEATED_CALL

    differ = chat.RoundProgress()
    raws = [f"not json {' ' * i}{{" for i in range(chat.SAME_CALL_LIMIT)]
    outcomes = [differ.after_round([_call("t", raw, i)], [f"r{i}"]) for i, raw in enumerate(raws)]
    assert outcomes == [None] * chat.SAME_CALL_LIMIT


def test_the_same_arguments_under_another_tool_name_are_another_key():
    progress = chat.RoundProgress()
    names = [f"tool_{i}" for i in range(chat.SAME_CALL_LIMIT)]
    outcomes = [
        progress.after_round([_call(n, {"path": "/x"}, i)], [f"r{i}"]) for i, n in enumerate(names)
    ]
    assert outcomes == [None] * chat.SAME_CALL_LIMIT


def test_the_key_ignores_the_call_id_and_the_markup_flag():
    progress = chat.RoundProgress()
    calls = [
        chat.ToolCall(id=f"x{i}", name="t", arguments='{"a": 1}', from_markup=bool(i % 2))
        for i in range(chat.SAME_CALL_LIMIT)
    ]
    assert (
        progress.after_round(calls, [_err(f"{i}") for i in range(chat.SAME_CALL_LIMIT)])
        == chat.STOP_REPEATED_CALL
    )


def test_dict_arguments_are_keyed_like_their_json_string():
    """The Assumptions' key: dict arguments are dumped the same canonical way
    as a JSON string, so a dict, the same dict in another key order and its
    JSON text are one key (coverage: kills str(dict) and an unsorted dump)."""
    progress = chat.RoundProgress()
    forms = [{"b": [1, 2], "a": 1}, {"a": 1, "b": [1, 2]}, '{"b": [1, 2], "a": 1}']
    forms = (forms * chat.SAME_CALL_LIMIT)[: chat.SAME_CALL_LIMIT]
    outcomes = [
        progress.after_round([chat.ToolCall(id=f"d{i}", name="t", arguments=f)], [f"r{i}"])
        for i, f in enumerate(forms)
    ]
    assert outcomes[:-1] == [None] * (chat.SAME_CALL_LIMIT - 1)
    assert outcomes[-1] == chat.STOP_REPEATED_CALL


def test_a_refused_call_still_counts_as_a_dispatch_of_its_key():
    progress = chat.RoundProgress()
    calls = [_call("device_run", {"argv": ["start"]}, i) for i in range(chat.SAME_CALL_LIMIT)]
    results = [_err("out of tool rounds") for _ in calls]
    assert progress.after_round(calls, results) == chat.STOP_REPEATED_CALL


# -- C3 stale rounds -------------------------------------------------------------


def test_limit_consecutive_rounds_of_already_seen_text_stop_on_the_last():
    progress = chat.RoundProgress()
    outcomes = [_seed(progress)]
    outcomes += [_stale_round(progress, i) for i in range(chat.STALE_ROUNDS_LIMIT)]
    assert outcomes[:-1] == [None] * chat.STALE_ROUNDS_LIMIT
    assert outcomes[-1] == chat.STOP_NO_NEW_RESULTS


def test_distinct_missing_binary_errors_are_news_and_never_stop():
    """The VERIFY FAIL shape: hunting for ollama by probing binaries that are
    not on the Dell's PATH. Every head is Error-prefixed and every one is new,
    so the hunt is progress, however many rounds in a row it fails."""
    assert len(NOT_FOUND_BINARIES) > chat.STALE_ROUNDS_LIMIT
    progress = chat.RoundProgress()
    outcomes = [
        progress.after_round(
            [_call("device_run", {"argv": [b, "--version"], "device": "DELL-XPS-8950"}, i)],
            [_not_found(b)],
        )
        for i, b in enumerate(NOT_FOUND_BINARIES)
    ]
    assert outcomes == [None] * len(NOT_FOUND_BINARIES)


def test_distinct_errors_are_news_whatever_they_say():
    progress = chat.RoundProgress()
    outcomes = [_error_round(progress, i) for i in range(chat.STALE_ROUNDS_LIMIT + 3)]
    assert outcomes == [None] * len(outcomes)


def test_rounds_repeating_earlier_text_stop_whether_errors_or_not():
    """Errors and non-errors alike: once each round only returns text the turn
    has already seen (from any call), STALE_ROUNDS_LIMIT of them stop it."""
    progress = chat.RoundProgress()
    missing, body = _not_found("nvidia-smi"), "the same listing"
    outcomes = [
        progress.after_round([_call("device_run", {"argv": ["nvidia-smi"]}, 0)], [missing]),
        progress.after_round([_call("read_file", {"path": "/a"}, 1)], [body]),
    ]
    repeats = [missing, body] * chat.STALE_ROUNDS_LIMIT
    for i, text in enumerate(repeats[: chat.STALE_ROUNDS_LIMIT]):
        outcomes.append(
            progress.after_round([_call("read_file", {"path": f"/other/{i}"}, 10 + i)], [text])
        )
    assert outcomes[:-1] == [None] * (len(outcomes) - 1)
    assert outcomes[-1] == chat.STOP_NO_NEW_RESULTS


def test_text_differing_only_in_whitespace_is_already_seen():
    progress = chat.RoundProgress()
    variants = ["line one\nline two", "line one  line two", " line one\n\tline two \n"]
    outcomes = [progress.after_round([_call("read_file", {"path": "/w"}, 0)], [variants[0]])]
    for i in range(chat.STALE_ROUNDS_LIMIT):
        outcomes.append(
            progress.after_round(
                [_call("read_file", {"path": f"/w/{i}"}, 1 + i)], [variants[i % len(variants)]]
            )
        )
    assert outcomes[:-1] == [None] * chat.STALE_ROUNDS_LIMIT
    assert outcomes[-1] == chat.STOP_NO_NEW_RESULTS


@pytest.mark.parametrize(
    "variants",
    [
        [
            "ollama serve running",
            "ollamaserve running",
            "ollama serverunning",
            "ollamaserverunning",
        ],
        ["STATUS Running", "status running", "Status Running", "STATUS RUNNING"],
    ],
    ids=["a-space-removed", "letter-case"],
)
def test_text_differing_in_more_than_whitespace_runs_is_new(variants):
    """Whitespace normalisation only: collapsing a run of whitespace to one
    space is the whole comparison. Text that differs by a removed space or by
    letter case is a different result, so it is news (coverage: a looser key,
    every space removed or case folded, would call these rounds stale)."""
    assert len(variants) > chat.STALE_ROUNDS_LIMIT
    progress = chat.RoundProgress()
    outcomes = [
        progress.after_round([_call("device_run", {"argv": ["ps", str(i)]}, i)], [text])
        for i, text in enumerate(variants)
    ]
    assert outcomes == [None] * len(variants)


def test_one_round_with_news_resets_the_stale_run():
    progress = chat.RoundProgress()
    outcomes = [_seed(progress)]
    outcomes += [_stale_round(progress, i) for i in range(chat.STALE_ROUNDS_LIMIT - 1)]
    outcomes.append(_fresh_round(progress, 0))
    outcomes += [_stale_round(progress, 100 + i) for i in range(chat.STALE_ROUNDS_LIMIT - 1)]
    assert outcomes == [None] * len(outcomes)
    assert _stale_round(progress, 999) == chat.STOP_NO_NEW_RESULTS


def test_one_round_with_a_new_error_resets_the_stale_run():
    progress = chat.RoundProgress()
    outcomes = [_seed(progress)]
    outcomes += [_stale_round(progress, i) for i in range(chat.STALE_ROUNDS_LIMIT - 1)]
    outcomes.append(_error_round(progress, 0))
    outcomes += [_stale_round(progress, 100 + i) for i in range(chat.STALE_ROUNDS_LIMIT - 1)]
    assert outcomes == [None] * len(outcomes)
    assert _stale_round(progress, 999) == chat.STOP_NO_NEW_RESULTS


def test_a_result_already_returned_for_the_same_key_is_not_new():
    progress = chat.RoundProgress()
    keys = [_call("read_file", {"path": f"/k/{i}"}, i) for i in range(chat.STALE_ROUNDS_LIMIT)]
    first = [progress.after_round([c], [f"same body {i}"]) for i, c in enumerate(keys)]
    assert first == [None] * chat.STALE_ROUNDS_LIMIT
    again = [progress.after_round([c], [f"same body {i}"]) for i, c in enumerate(keys)]
    assert again[:-1] == [None] * (chat.STALE_ROUNDS_LIMIT - 1)
    assert again[-1] == chat.STOP_NO_NEW_RESULTS


def test_a_changed_result_for_the_same_key_is_new():
    progress = chat.RoundProgress()
    keys = [_call("read_file", {"path": f"/k/{i}"}, i) for i in range(chat.STALE_ROUNDS_LIMIT)]
    outcomes = [progress.after_round([c], [f"v1 {i}"]) for i, c in enumerate(keys)]
    outcomes += [progress.after_round([c], [f"v2 {i}"]) for i, c in enumerate(keys)]
    assert outcomes == [None] * len(outcomes)


def test_the_same_text_from_another_key_is_not_new():
    """Seen is turn-wide: a text any earlier call returned is not news."""
    progress = chat.RoundProgress()
    outcomes = [
        progress.after_round([_call("read_file", {"path": f"/k/{i}"}, i)], ["identical body"])
        for i in range(chat.STALE_ROUNDS_LIMIT + 1)
    ]
    assert outcomes[:-1] == [None] * chat.STALE_ROUNDS_LIMIT
    assert outcomes[-1] == chat.STOP_NO_NEW_RESULTS


@pytest.mark.parametrize(
    "result",
    [
        "DELL ran ['which', 'ollama'] — exit 1\n\n[process exited with code 1]",
        "error: lowercase is not the prefix",
        " Error: a leading space is not the prefix",
        "Errors: plural is not the prefix",
        "the run said Error: deep inside",
    ],
    ids=["nonzero-exit", "lowercase", "leading-space", "plural", "mid-text"],
)
def test_a_result_not_starting_with_the_error_prefix_is_news_whatever_it_says(result):
    progress = chat.RoundProgress()
    outcomes = [
        progress.after_round([_call("device_run", {"argv": ["x", str(i)]}, i)], [f"{result} #{i}"])
        for i in range(chat.STALE_ROUNDS_LIMIT + 3)
    ]
    assert outcomes == [None] * len(outcomes)


def test_a_round_with_any_new_result_is_not_stale():
    progress = chat.RoundProgress()
    outcomes = []
    for i in range(chat.STALE_ROUNDS_LIMIT + 3):
        calls = [
            _call("read_file", {"path": f"/missing/{i}"}, 2 * i),
            _call("read_file", {"path": f"/fresh/{i}"}, 2 * i + 1),
        ]
        outcomes.append(progress.after_round(calls, [_err("gone"), f"body {i}"]))
    assert outcomes == [None] * len(outcomes)


def test_a_new_result_before_an_already_seen_one_still_makes_the_round_news():
    """Any new result makes the round news, wherever it sits: a result already
    seen for its key AFTER it in the same round does not take that back
    (coverage: the [error, fresh] order above cannot tell)."""
    progress = chat.RoundProgress()
    n = chat.STALE_ROUNDS_LIMIT + 3
    olds = [_call("read_file", {"path": f"/old/{i}"}, i) for i in range(n)]
    outcomes = [progress.after_round([c], [f"old body {i}"]) for i, c in enumerate(olds)]
    for i, old in enumerate(olds):
        calls = [_call("read_file", {"path": f"/fresh/{i}"}, 100 + i), old]
        outcomes.append(progress.after_round(calls, [f"body {i}", f"old body {i}"]))
    assert outcomes == [None] * len(outcomes)


def test_a_refusal_repeating_an_earlier_text_is_stale():
    """A refusal is judged by its text like any result: the first one is new,
    the same refusal again is not."""
    progress = chat.RoundProgress()
    outcomes = [
        progress.after_round(
            [_call("device_run", {"argv": [str(i)]}, i)],
            [_err("device_run is not a tool this round has (refused)")],
        )
        for i in range(chat.STALE_ROUNDS_LIMIT + 1)
    ]
    assert outcomes[:-1] == [None] * chat.STALE_ROUNDS_LIMIT
    assert outcomes[-1] == chat.STOP_NO_NEW_RESULTS


# -- C4 c042afa1 is never stopped ------------------------------------------------


def test_the_c042afa1_fixture_has_the_recorded_shape():
    runs = [r for r in C042AFA1_ROUNDS if r[0] == "device_run"]
    assert C042AFA1_ROUNDS[0][0] == "device_info"
    assert len(runs) == 19
    assert len({json.dumps(a, sort_keys=True) for _, a, _ in runs}) == 19
    assert len({h for _, _, h in runs}) == 19
    assert not any(h.startswith(tools.ERROR_PREFIX) for _, _, h in C042AFA1_ROUNDS)


def test_c042afa1_round_by_round_is_never_stopped():
    progress = chat.RoundProgress()
    outcomes = [
        progress.after_round([_call(name, args, i)], [head])
        for i, (name, args, head) in enumerate(C042AFA1_ROUNDS)
    ]
    assert outcomes == [None] * len(C042AFA1_ROUNDS)


def test_c042afa1_with_every_result_a_distinct_nonzero_exit_is_never_stopped():
    progress = chat.RoundProgress()
    outcomes = [
        progress.after_round([_call(name, args, i)], [f"DELL-XPS-8950 ran step {i} — exit 1"])
        for i, (name, args, _) in enumerate(C042AFA1_ROUNDS)
    ]
    assert outcomes == [None] * len(C042AFA1_ROUNDS)


# -- C5 pure and isolated --------------------------------------------------------


def test_after_round_does_no_io_and_leaves_its_inputs_alone(monkeypatch):
    def _no_io(*_a, **_k):
        raise AssertionError("after_round did I/O")

    monkeypatch.setattr(builtins, "open", _no_io)
    monkeypatch.setattr(socket.socket, "connect", _no_io)
    progress = chat.RoundProgress()
    calls = [_call("t", {"a": 1}, i) for i in range(chat.SAME_CALL_LIMIT)]
    results = [_err("x") for _ in calls]
    calls_before, results_before = copy.deepcopy(calls), list(results)
    calls_tuple = tuple(calls)
    assert progress.after_round(calls_tuple, tuple(results)) == chat.STOP_REPEATED_CALL
    assert calls == calls_before
    assert results == results_before


def test_two_instances_share_no_state():
    a, b = chat.RoundProgress(), chat.RoundProgress()
    outcomes = []
    for i in range(chat.SAME_CALL_LIMIT - 1):
        outcomes.append(a.after_round([_call("t", {"k": 1}, i)], [_err("a")]))
        outcomes.append(b.after_round([_call("t", {"k": 1}, i)], [_err("b")]))
    assert outcomes == [None] * len(outcomes)
    assert a.after_round([_call("t", {"k": 1})], ["fresh"]) == chat.STOP_REPEATED_CALL


def test_the_same_sequence_on_a_fresh_instance_gives_the_same_outcomes():
    def feed() -> list[str | None]:
        progress = chat.RoundProgress()
        out = [_fresh_round(progress, 0), _seed(progress)]
        out += [_stale_round(progress, i) for i in range(chat.STALE_ROUNDS_LIMIT)]
        return out

    first, second = feed(), feed()
    assert first == second
    assert first[-1] == chat.STOP_NO_NEW_RESULTS


# -- assumptions -----------------------------------------------------------------


def test_mismatched_calls_and_results_raise():
    with pytest.raises(ValueError):
        chat.RoundProgress().after_round([_call("t", {}), _call("u", {})], ["only one"])


def test_results_with_no_calls_raise():
    """A round of results with no calls is a wiring bug too, and must fail
    loudly rather than read as an empty round (coverage: zip(strict=True)
    alone never sees it, because an empty round returns before the zip)."""
    with pytest.raises(ValueError):
        chat.RoundProgress().after_round([], ["orphan result"])


def test_an_empty_round_returns_none_and_leaves_the_stale_run_unchanged():
    progress = chat.RoundProgress()
    assert progress.after_round([], []) is None
    outcomes = [_seed(progress)]
    outcomes += [_stale_round(progress, i) for i in range(chat.STALE_ROUNDS_LIMIT - 1)]
    outcomes.append(progress.after_round([], []))
    assert outcomes == [None] * len(outcomes)
    assert _stale_round(progress, 999) == chat.STOP_NO_NEW_RESULTS


# -- C6 precedence ---------------------------------------------------------------


def test_a_round_meeting_both_conditions_says_repeated_call():
    progress = chat.RoundProgress()
    key = {"argv": ["start"]}
    outcomes = [
        progress.after_round(
            [_call("device_run", key, i) for i in range(chat.SAME_CALL_LIMIT - 1)],
            [_err("refused") for _ in range(chat.SAME_CALL_LIMIT - 1)],
        )
    ]
    # The first round's "refused" is new text; the next rounds repeat it, so
    # the last call below is both the key's limit-th and the run's limit-th.
    outcomes += [
        progress.after_round([_call("read_file", {"path": f"/r/{i}"}, 10 + i)], [_err("refused")])
        for i in range(chat.STALE_ROUNDS_LIMIT - 1)
    ]
    assert outcomes == [None] * len(outcomes)
    assert (
        progress.after_round([_call("device_run", key)], [_err("refused")])
        == chat.STOP_REPEATED_CALL
    )


# == T4: the circling stop in `_run_turn`, and round_stop on every stopped turn ==
#
# T3's detector wired into the loop: after each dispatched round, one per-turn
# RoundProgress reads that round's calls and their tool-message results. A stop
# ends the loop like the ceiling does (out_of_rounds), runs T2's narration path
# with a nudge and a note true to the reason, and every stopped turn files one
# `round_stop` span. These run the real funnel against a scripted gateway, so
# they need the database (unlike the pure sections above).

PROBE = "t4_probe"
PROBE_SCHEMA = {
    "type": "object",
    "properties": {"q": {"type": "string"}},
    "required": ["q"],
    "additionalProperties": False,
}
PROSE = "Here is what I found."
NOTE_REPEATED = "[stopped after {n} tool rounds: the same call was repeated]"
NOTE_NO_NEW = "[stopped after {n} tool rounds: the last rounds brought nothing new]"
NOTE_CEILING = "[stopped after {n} tool rounds without finishing]"


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


def _arm_probe(monkeypatch, answer) -> list[str]:
    """A registered read tool whose executor returns answer(q, n) for its n-th
    run this test (0-based); the list it returns holds each q it ran with."""
    ran: list[str] = []

    async def probe(args: dict, ctx: ToolContext) -> str:
        ran.append(args["q"])
        return answer(args["q"], len(ran) - 1)

    monkeypatch.setitem(
        tools.REGISTRY, PROBE, Tool(PROBE, "d", PROBE_SCHEMA, probe, reads_only=True)
    )
    return ran


def _probe(call_id: str, q: str) -> dict:
    return whole_call(call_id, PROBE, {"q": q})


def _probe_rounds(*qs: str) -> tuple:
    return tuple((_probe(f"c{i}", q),) for i, q in enumerate(qs, start=1))


def _meta(value) -> dict:
    return value if isinstance(value, dict) else json.loads(value)


async def _spans_of(pool, turn_id=None) -> list[traces.Span]:
    if turn_id is None:
        turn_id = await pool.fetchval("SELECT id FROM turns ORDER BY started_at DESC LIMIT 1")
    rows = await pool.fetch(
        "SELECT kind, name, started_at, duration_ms, meta FROM turn_spans "
        "WHERE turn_id = $1 ORDER BY started_at",
        turn_id,
    )
    return [
        traces.Span(
            kind=row["kind"],
            name=row["name"],
            started_at=row["started_at"],
            duration_ms=row["duration_ms"],
            meta=_meta(row["meta"]),
        )
        for row in rows
    ]


def _stops(spans) -> list[dict]:
    return [dict(s.meta) for s in spans if s.kind == "round_stop"]


def _stop_held(stops: list[dict], reason: str, rounds: int) -> None:
    assert len(stops) == 1, stops
    assert stops[0].get("reason") == reason
    assert stops[0].get("rounds") == rounds
    assert type(stops[0].get("rounds")) is int


async def _stored(pool) -> str:
    return await pool.fetchval(
        "SELECT content FROM messages WHERE role = 'assistant' ORDER BY created_at DESC LIMIT 1"
    )


def _texts(sent: list) -> list[str]:
    return [f["t"] for f in sent if isinstance(f, dict) and "t" in f]


def _last_system(payload: dict) -> str | None:
    last = payload["messages"][-1]
    return last.get("content") if last.get("role") == "system" else None


async def _narration_held(pool, gateway, *, tool_rounds: int, refused: int = 0) -> None:
    """Exactly one toolless narration round 0 after `tool_rounds` tool rounds;
    each call it asked for was refused, none dispatched; the turn is ok."""
    assert gateway.calls == tool_rounds + 1
    assert gateway.payloads[tool_rounds].get("tools") in (None, [])
    assert await pool.fetchval("SELECT status FROM turns ORDER BY started_at DESC LIMIT 1") == "ok"
    spans = await _spans_of(pool)
    narration = [s for s in spans if s.kind == "llm_call" and s.meta.get("round") == 0]
    assert len(narration) == 1
    assert narration[0].meta.get("tools_advertised") is False
    assert (
        len([s for s in spans if s.kind == "tool" and s.meta.get("refused_out_of_rounds")])
        == refused
    )


async def _run_probes(owner_client, mount_peers, rounds: tuple, *, limit: int):
    gateway = ScriptedGateway(rounds=rounds)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "agents.max_tool_rounds", limit)
    sent = await _say(owner_client, "find it")
    return gateway, sent


# -- T4 C1/C2/C3: the two circling stops ----------------------------------------


@requires_db
async def test_the_same_call_a_third_time_ends_the_turn_after_its_tools_ran(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C1 repeated_call, C2 note, C3 span, C4 circling below the ceiling wins.
    Each run returns new text, so only the repeat stops it: the third call runs,
    no fourth tool round is asked for, the narration answers, the note says why."""
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")

    gateway, sent = await _run_probes(
        owner_client, mount_peers, (*_probe_rounds("a", "a", "a"), (text_delta(PROSE),)), limit=10
    )

    assert ran == ["a", "a", "a"]
    await _narration_held(pool, gateway, tool_rounds=3)
    stored = await _stored(pool)
    assert stored == f"{PROSE}\n\n{NOTE_REPEATED.format(n=3)}"
    assert "".join(_texts(sent)) == stored
    _stop_held(_stops(await _spans_of(pool)), chat.STOP_REPEATED_CALL, 3)


@requires_db
async def test_three_rounds_that_bring_nothing_new_end_the_turn(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C1 no_new_results: four different calls, every one answering the same
    text. Round 1 is news, rounds 2-4 are stale, so the turn stops after round
    4's tools ran, with the reason in the note and in the span."""
    ran = _arm_probe(monkeypatch, lambda q, n: "nothing there")

    gateway, sent = await _run_probes(
        owner_client,
        mount_peers,
        (*_probe_rounds("a", "b", "c", "d"), (text_delta(PROSE),)),
        limit=10,
    )

    assert ran == ["a", "b", "c", "d"]
    await _narration_held(pool, gateway, tool_rounds=4)
    stored = await _stored(pool)
    assert stored == f"{PROSE}\n\n{NOTE_NO_NEW.format(n=4)}"
    assert "".join(_texts(sent)) == stored
    _stop_held(_stops(await _spans_of(pool)), chat.STOP_NO_NEW_RESULTS, 4)


def _circling_narrations() -> dict:
    return {
        # (narration round, calls it asks for); None: the script ends, so the
        # narration call fails at the gateway.
        "fails-at-the-gateway": (None, 0),
        "is-silent": ((), 0),
        "asks-for-a-tool-on-the-wire": ((_probe("n1", "b"),), 1),
    }


@requires_db
@pytest.mark.parametrize("case", list(_circling_narrations()), ids=list(_circling_narrations()))
async def test_a_circling_stop_whose_narration_does_not_answer_gets_the_statement_then_its_note(
    case, owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C2 with T2: the statement of what the tools returned, a blank line, then
    the circling note; streamed == stored; the narration's call never runs."""
    narration, narration_calls = _circling_narrations()[case]
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    rounds = _probe_rounds("a", "a", "a")
    if narration is not None:
        rounds = (*rounds, narration)

    gateway, sent = await _run_probes(owner_client, mount_peers, rounds, limit=10)

    assert ran == ["a", "a", "a"]
    spans = await _spans_of(pool)
    statement = chat.tool_results_statement(spans)
    assert isinstance(statement, str)
    assert "a result #2" in statement
    stored = await _stored(pool)
    assert stored == f"{statement}\n\n{NOTE_REPEATED.format(n=3)}"
    assert "".join(_texts(sent)) == stored
    await _narration_held(pool, gateway, tool_rounds=3, refused=narration_calls)
    _stop_held(_stops(spans), chat.STOP_REPEATED_CALL, 3)


@requires_db
async def test_a_circling_stops_nudge_does_not_say_every_round_was_used(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C2: OUT_OF_ROUNDS_NUDGE says she used every tool round, which is false
    for a circling stop below the ceiling. Its nudge says no further tool will
    run this turn instead."""
    _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")

    gateway, _sent = await _run_probes(
        owner_client, mount_peers, (*_probe_rounds("a", "a", "a"), (text_delta(PROSE),)), limit=10
    )

    assert gateway.calls == 4
    nudge = _last_system(gateway.payloads[3])
    assert isinstance(nudge, str), "the narration round carried no closing nudge"
    assert nudge != chat.OUT_OF_ROUNDS_NUDGE
    assert "every tool round" not in nudge
    assert "no further tool" in nudge.lower()


@requires_db
async def test_c042afa1_runs_to_the_ceiling_and_the_ceiling_stop_is_unchanged(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C1 c042afa1's shape (20 distinct calls, the live heads as results) is
    never stopped as circling; C2 the ceiling's nudge and note are byte-for-byte
    today's; C3 it files one round_stop, reason ceiling, rounds = the limit.
    Round 20's call is the ceiling's and does not run (C4)."""
    heads = [head for _name, _args, head in C042AFA1_ROUNDS]
    assert len(heads) == 20
    ran = _arm_probe(monkeypatch, lambda q, n: heads[int(q)])

    gateway, sent = await _run_probes(
        owner_client,
        mount_peers,
        (*_probe_rounds(*(str(i) for i in range(20))), (text_delta(PROSE),)),
        limit=20,
    )

    assert ran == [str(i) for i in range(19)]
    await _narration_held(pool, gateway, tool_rounds=20)
    assert _last_system(gateway.payloads[20]) == chat.OUT_OF_ROUNDS_NUDGE
    stored = await _stored(pool)
    assert stored == f"{PROSE}\n\n{NOTE_CEILING.format(n=20)}"
    assert "".join(_texts(sent)) == stored
    _stop_held(_stops(await _spans_of(pool)), "ceiling", 20)


# -- T4 C4: circling and the ceiling do not fight --------------------------------


@requires_db
async def test_the_ceiling_still_stops_before_dispatch_when_a_repeat_reaches_it(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C4: at a limit of 3 the third identical call is the ceiling's round, so
    it never runs and never counts as a repeat: the stop is the ceiling's, and
    only the ceiling's."""
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")

    _gateway, _sent = await _run_probes(
        owner_client, mount_peers, (*_probe_rounds("a", "a", "a"), (text_delta(PROSE),)), limit=3
    )

    assert ran == ["a", "a"]
    assert await _stored(pool) == f"{PROSE}\n\n{NOTE_CEILING.format(n=3)}"
    _stop_held(_stops(await _spans_of(pool)), "ceiling", 3)


@requires_db
async def test_only_a_stopped_turn_files_a_round_stop_and_turns_share_no_progress(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C3 + C4: a turn that answered files no round_stop. Its two calls of
    q=a are its own: the next turn's count starts at zero, so that turn stops
    at ITS third call (round 3), not at its first."""
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    gateway = ScriptedGateway(
        rounds=(
            *_probe_rounds("a", "a"),
            (text_delta("First answer."),),
            *_probe_rounds("a", "a", "a"),
            (text_delta(PROSE),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "agents.max_tool_rounds", 10)

    await _say(owner_client, "find it")
    first = await pool.fetchval("SELECT id FROM turns ORDER BY started_at DESC LIMIT 1")
    await _say(owner_client, "find it again")

    assert ran == ["a"] * 5
    assert _stops(await _spans_of(pool, first)) == []
    second = await _spans_of(pool)
    _stop_held(_stops(second), chat.STOP_REPEATED_CALL, 3)
    assert await _stored(pool) == f"{PROSE}\n\n{NOTE_REPEATED.format(n=3)}"


@requires_db
async def test_a_circling_stop_gates_the_deferral_redirect(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C1: a circling stop sets out_of_rounds, so a narration that defers ("let
    me search") earns no redirect round, exactly as on a ceiling stop (see
    test_chat_tools::test_the_deferral_redirect_is_gated_on_the_round_cap)."""
    _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    defer = "Let me search the web for the rest of that."

    gateway, _sent = await _run_probes(
        owner_client, mount_peers, (*_probe_rounds("a", "a", "a"), (text_delta(defer),)), limit=10
    )

    assert gateway.calls == 4  # a fifth would be the deferral redirect
    spans = await _spans_of(pool)
    assert [s.name for s in spans if s.kind == "guard"] == []
    assert await _stored(pool) == f"{defer}\n\n{NOTE_REPEATED.format(n=3)}"


# -- T4 C5: delegated agents share it --------------------------------------------


@requires_db
async def test_an_agent_turn_that_circles_gets_the_statement_its_note_and_the_span(
    pool, mount_peers, workspace
):
    """C5 + C3: an agent turn through the same funnel repeats get_time a third
    time below its row's ceiling of 10 and is stopped as repeated_call; its
    narration is silent, so its reply is the statement then the circling note.
    The new span kind changes nothing run_facts or turn_usage read."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers, max_tool_rounds=10)
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "get_time", {}),),
            (whole_call("c2", "get_time", {}),),
            (whole_call("c3", "get_time", {}),),
            (),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _frames = await _agent_turn(pool, agent, owner, "what time is it")

    assert gateway.calls == 4
    stops = _stops(turn.spans)
    _stop_held(stops, chat.STOP_REPEATED_CALL, 3)
    statement = chat.tool_results_statement(turn.spans)
    assert isinstance(statement, str)
    assert await _reply(pool, turn.id) == f"{statement}\n\n{NOTE_REPEATED.format(n=3)}"
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "ok"

    without = dataclasses.replace(turn, spans=[s for s in turn.spans if s.kind != "round_stop"])
    assert chat.turn_usage(turn.spans) == chat.turn_usage(without.spans)
    facts = agents.run_facts(
        agent, turn, status="ok", seconds=1.0, usage=chat.turn_usage(turn.spans)
    )
    assert facts == agents.run_facts(
        agent, without, status="ok", seconds=1.0, usage=chat.turn_usage(without.spans)
    )
    assert facts.rounds == 4
    assert facts.calls_failed == 0


@requires_db
async def test_a_row_capped_agent_turn_files_a_ceiling_stop_with_the_rows_rounds(
    pool, mount_peers, workspace
):
    """C5: the row's rounds stay its ceiling (1, against an argument of 5), and
    that stop files reason ceiling with rounds = the row's value."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers, max_tool_rounds=1)
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "get_time", {}),),
            (text_delta("late"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _frames = await _agent_turn(pool, agent, owner, "what time is it", max_tool_rounds=5)

    assert gateway.calls == 2
    _stop_held(_stops(turn.spans), "ceiling", 1)
    assert await _reply(pool, turn.id) == f"late\n\n{NOTE_CEILING.format(n=1)}"


# -- T4 COVERAGE: what the loop feeds the detector, and who files no span ---------


@requires_db
async def test_results_that_differ_only_past_a_span_head_are_news(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C1: the detector reads each call's FULL tool message, never its span head
    (cut at 500 chars). Four results that share their first 600 chars and differ
    after are four new results, so the turn runs to its own answer, unstopped."""
    ran = _arm_probe(monkeypatch, lambda q, n: "x" * 600 + f" tail {q}")

    gateway, sent = await _run_probes(
        owner_client,
        mount_peers,
        (*_probe_rounds("a", "b", "c", "d"), (text_delta(PROSE),)),
        limit=10,
    )

    assert ran == ["a", "b", "c", "d"]
    assert gateway.calls == 5
    assert await _stored(pool) == PROSE
    assert _stops(await _spans_of(pool)) == []


@requires_db
async def test_a_round_of_two_calls_feeds_both_results_in_call_order(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C1: a round's results are messages[before:], one per call. Two calls per
    round, each run a new text: the pair's third round is the third call of
    q=a and of q=b, so the stop is repeated_call at round 3, after both ran."""
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    pair = lambda r: (_probe(f"a{r}", "a"), _probe(f"b{r}", "b"))  # noqa: E731

    gateway, _sent = await _run_probes(
        owner_client, mount_peers, (pair(1), pair(2), pair(3), (text_delta(PROSE),)), limit=10
    )

    assert ran == ["a", "b"] * 3
    await _narration_held(pool, gateway, tool_rounds=3)
    assert await _stored(pool) == f"{PROSE}\n\n{NOTE_REPEATED.format(n=3)}"
    _stop_held(_stops(await _spans_of(pool)), chat.STOP_REPEATED_CALL, 3)


@requires_db
async def test_a_tool_message_missing_from_a_round_fails_the_turn_never_skipped(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C1: one tool message per call is an invariant; a round whose results do
    not line up with its calls is a bug, so the turn fails loudly rather than
    the detector skipping the round and the turn running on unchecked."""
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    real = chat._dispatch_calls

    async def drops_a_result(turn, tool_ctx, calls, messages, emit, **kwargs):
        out = await real(turn, tool_ctx, calls, messages, emit, **kwargs)
        assert messages[-1]["role"] == "tool"
        messages.pop()
        return out

    monkeypatch.setattr(chat, "_dispatch_calls", drops_a_result)

    gateway, _sent = await _run_probes(
        owner_client, mount_peers, (*_probe_rounds("a", "b"), (text_delta(PROSE),)), limit=10
    )

    assert ran == ["a"]
    assert gateway.calls == 1
    assert await pool.fetchval("SELECT status FROM turns ORDER BY started_at DESC LIMIT 1") == (
        "error"
    )
    assert _stops(await _spans_of(pool)) == []


@requires_db
async def test_a_turn_that_fails_after_tool_rounds_files_no_round_stop(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C3: a round_stop is a ROUND stop. Two tool rounds, then the model's
    round fails at the gateway: the turn failed, it was not stopped."""
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")

    gateway, _sent = await _run_probes(owner_client, mount_peers, _probe_rounds("a", "b"), limit=10)

    assert ran == ["a", "b"]
    assert gateway.calls == 3
    assert await pool.fetchval("SELECT status FROM turns ORDER BY started_at DESC LIMIT 1") != (
        "ok"
    )
    assert _stops(await _spans_of(pool)) == []


@requires_db
async def test_a_turn_he_stops_after_tool_rounds_files_no_round_stop(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C3: his Stop is not a round stop. The second round's call reports
    progress until he presses Stop; the turn is `stopped` and files none."""
    import asyncio

    steps: list[int] = []

    async def probe(args: dict, ctx: ToolContext) -> str:
        if args["q"] != "slow":
            return f"{args['q']} result"
        for i in range(400):
            steps.append(i)
            ctx.progress(f"step {i}")
            await asyncio.sleep(0.005)
        return "finished"

    monkeypatch.setitem(
        tools.REGISTRY, PROBE, Tool(PROBE, "d", PROBE_SCHEMA, probe, reads_only=True)
    )
    gateway = ScriptedGateway(rounds=(*_probe_rounds("a", "slow"), (text_delta(PROSE),)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "agents.max_tool_rounds", 10)

    turn = asyncio.create_task(
        owner_client.post("/api/v1/chat/stream", json={"message": "find it"})
    )
    while len(steps) < 3:
        await asyncio.sleep(0.005)
    turn_id = await pool.fetchval("SELECT id FROM turns WHERE status IS NULL")
    stop = await owner_client.post(f"/api/v1/chat/turns/{turn_id}/stop")
    assert stop.status_code == 200, stop.text
    await asyncio.wait_for(turn, timeout=10)
    await asyncio.wait_for(chat.drain_background(), timeout=10)

    assert len(steps) < 400
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id) == "stopped"
    assert _stops(await _spans_of(pool, turn_id)) == []
