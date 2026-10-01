"""Her browser's engine as deployed (S38), pinned from the files a human edits:
what core can reach, what the engine may do, and where its state lives. Read
the way test_traces.py reads the grace period, from deploy/ and the
Dockerfiles, so a hand edit that drops a measured flag goes red here."""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
COMPOSE = yaml.safe_load((ROOT / "deploy" / "docker-compose.yml").read_text())
ENGINE_DOCKERFILE = (ROOT / "deploy" / "browser" / "Dockerfile").read_text()
PIN = (
    "mcr.microsoft.com/playwright/mcp:v0.0.82"
    "@sha256:77dccc5ce9e94cb8ae7ebea87ddbb6cd54b05760c4d63c54e16accf2726b8734"
)


def _service(name: str) -> dict:
    return COMPOSE["services"][name]


def _flag(command: list[str], name: str):
    """The value after `name` in the engine's arguments, True for a bare flag,
    None when it is absent."""
    if name not in command:
        return None
    at = command.index(name)
    following = command[at + 1] if at + 1 < len(command) else None
    if following is None or following.startswith("--"):
        return True
    return following


def _instructions(text: str) -> list[str]:
    return [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def test_the_image_is_the_pinned_digest_and_only_adds_the_two_folders():
    lines = _instructions(ENGINE_DOCKERFILE)
    assert lines[0] == f"FROM {PIN}"
    assert "RUN mkdir -p /profile /output && chown node:node /profile /output" in lines
    assert lines[-1] == "USER node"
    # The engine's own entrypoint stands: no second way to start it.
    assert not any(line.startswith(("ENTRYPOINT", "CMD", "EXPOSE", "VOLUME")) for line in lines)


def test_the_engine_publishes_no_port_and_is_built_from_its_folder():
    browser = _service("browser")
    assert "ports" not in browser
    assert browser["build"]["context"] == "./browser"
    assert browser.get("init") is True
    assert browser["restart"] == "unless-stopped"


def test_the_engine_runs_with_the_measured_flags():
    command = [str(part) for part in _service("browser")["command"]]
    assert _flag(command, "--port") == "8931"
    assert _flag(command, "--host") == "0.0.0.0"
    assert _flag(command, "--allowed-hosts") == "browser:8931,127.0.0.1:8931"
    assert _flag(command, "--no-webmcp") is True
    assert _flag(command, "--shared-browser-context") is True
    assert _flag(command, "--user-data-dir") == "/profile"
    assert _flag(command, "--output-dir") == "/output"
    assert _flag(command, "--output-max-size") == "2147483648"
    assert _flag(command, "--image-responses") == "omit"
    assert _flag(command, "--snapshot-mode") == "none"
    assert _flag(command, "--file-paths") == "absolute"
    assert _flag(command, "--timeout-navigation") == "45000"
    assert _flag(command, "--console-level") == "error"
    assert _flag(command, "--idle-timeout") == "3600000"
    for absent in ("--isolated", "--allow-unrestricted-file-access", "--caps", "--extension"):
        assert absent not in command, absent


def test_the_healthcheck_wants_exactly_the_400_a_bare_get_measures():
    check = _service("browser")["healthcheck"]
    assert check["test"][:3] == ["CMD", "node", "-e"]
    assert "http://127.0.0.1:8931/mcp" in check["test"][3]
    assert "r.status===400" in check["test"][3]


def test_the_profile_is_carried_and_the_output_is_not():
    volumes = COMPOSE["volumes"]
    assert volumes["v4_browser_profile"]["x-nova-backup"] == "include"
    assert volumes["v4_browser_profile"]["x-nova-backup-reason"].strip()
    assert volumes["v4_browser_output"]["x-nova-backup"] == "exclude-ephemeral"
    assert volumes["v4_browser_output"]["x-nova-backup-reason"].strip()
    mounts = _service("browser")["volumes"]
    assert "v4_browser_profile:/profile" in mounts
    assert "v4_browser_output:/output" in mounts


def test_core_sees_the_engine_output_and_knows_where_the_engine_is():
    core = _service("core")
    assert "v4_browser_output:/data/browser-output" in core["volumes"]
    assert core["environment"]["BROWSER_MCP_URL"] == "http://browser:8931/mcp"
    assert core["environment"]["BROWSER_OUTPUT_DIR"] == "/data/browser-output"
    # A missing engine is a stated failure in her tools, never a core that
    # will not start.
    assert "browser" not in (core.get("depends_on") or {})


def test_core_image_creates_the_output_mount_point_for_appuser():
    dockerfile = (ROOT / "services" / "core" / "Dockerfile").read_text()
    assert "mkdir -p /data/workspace /data/browser-output && chown -R appuser /data" in dockerfile
