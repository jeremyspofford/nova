"""devices_cli (S42b P23): the pairing code ./install hands the hub machine's
own agent — minted with no person (nobody may have registered yet), named
after the machine, and a re-pair code when that name is already paired.

A pairing code is a credential, and these codes are real ones (in the test
database, for ten minutes). So no test here ever prints one, failing or not:
  * what devices_cli printed is taken off capsys at once — pytest reports
    captured output only for a test that fails, and only what was not read;
  * it travels sealed (_Printed): pytest's traceback shows a helper's
    arguments by their repr, and this repr shows no text;
  * its code is swapped for its shape and its hash before anything is
    asserted, and every assert compares plain names, never the line;
  * a paired machine is set up by a row, not by spending a code.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from app import devices, devices_cli
from tests.conftest import TEST_DSN, requires_db

pytestmark = requires_db

CORE_DIR = Path(__file__).resolve().parents[1]
_CODE = re.compile(f"[{devices.PAIRING_CODE_ALPHABET}]{{{devices.PAIRING_CODE_LENGTH}}}")


class _Printed:
    """Output that may hold a pairing code, sealed: its repr — what pytest
    shows of a helper's arguments when an assert in it fails — is a count."""

    def __init__(self, text: str) -> None:
        self.text = text

    def __repr__(self) -> str:
        return f"<{len(self.text.splitlines())} printed line(s), not shown: a code may be in them>"


def _minted(printed: _Printed) -> dict:
    """The one JSON line devices_cli printed, its code replaced by whether it
    has a code's shape and by its hash (what pairing_codes stores)."""
    lines = printed.text.splitlines()
    n = len(lines)
    assert n == 1
    try:
        out = json.loads(lines[0])
    except ValueError:
        out = None
    is_object = isinstance(out, dict)
    assert is_object
    code = out.pop("code", None)
    out["code_shape"] = isinstance(code, str) and bool(_CODE.fullmatch(code))
    out["code_hash"] = devices.hash_code(code) if isinstance(code, str) else None
    return out


async def _paired(pool, name: str) -> uuid.UUID:
    """A live machine called `name`, as a row — no code spent to make it."""
    return await pool.fetchval(
        "INSERT INTO devices (name, platform, hostname, pubkey) "
        "VALUES ($1, 'linux', 'host', $2) RETURNING id",
        name,
        os.urandom(32).hex(),
    )


async def _latest_code(pool):
    return await pool.fetchrow(
        "SELECT name, device_id, created_by, code_hash, expires_at FROM pairing_codes "
        "ORDER BY created_at DESC LIMIT 1"
    )


def _module(name: str) -> subprocess.CompletedProcess:
    """What ./install runs in core's container, as a process of its own."""
    return subprocess.run(
        [sys.executable, "-m", "app.devices_cli", "mint", "--name", name],
        cwd=CORE_DIR,
        env={**os.environ, "DATABASE_URL": TEST_DSN},
        capture_output=True,
        text=True,
        timeout=60,
    )


async def test_mint_prints_one_json_line_with_a_code_for_a_new_name(pool, capsys):
    rc = await devices_cli.run(["mint", "--name", "minipc"], pool=pool)
    printed = _Printed(capsys.readouterr().out)
    assert rc == 0
    out = _minted(printed)
    assert set(out) == {"code_shape", "code_hash", "expires_at", "repair"}
    assert out["code_shape"] is True and out["repair"] is False
    row = await _latest_code(pool)
    assert (row["name"], row["device_id"], row["created_by"]) == ("minipc", None, None)
    # The code printed is the code stored (hashed), and so is its expiry.
    assert row["code_hash"] == out["code_hash"]
    assert row["expires_at"].isoformat() == out["expires_at"]


async def test_mint_for_a_paired_name_is_a_re_pair_code(pool, capsys):
    device_id = await _paired(pool, "minipc")
    rc = await devices_cli.run(["mint", "--name", "minipc"], pool=pool)
    printed = _Printed(capsys.readouterr().out)
    assert rc == 0
    out = _minted(printed)
    assert out["repair"] is True
    row = await _latest_code(pool)
    assert (row["device_id"], row["name"], row["created_by"]) == (device_id, None, None)
    assert row["code_hash"] == out["code_hash"]


async def test_the_name_is_cleaned_before_it_is_looked_up(pool, capsys):
    """A padded name finds the machine it names: the re-pair keeps its row."""
    device_id = await _paired(pool, "minipc")
    rc = await devices_cli.run(["mint", "--name", "  minipc "], pool=pool)
    printed = _Printed(capsys.readouterr().out)
    assert rc == 0
    assert _minted(printed)["repair"] is True
    assert (await _latest_code(pool))["device_id"] == device_id


@pytest.mark.parametrize("name", ["hub", "HUB", " Hub "])
async def test_hub_is_refused_as_a_name(pool, capsys, name):
    """C1: never `hub`, in any case or padding — a stated cannot naming the
    reserved word and what to do, and no code, under that name or another."""
    rc = await devices_cli.run(["mint", "--name", name], pool=pool)
    said = capsys.readouterr()
    nothing_printed = said.out == ""
    assert (rc, nothing_printed) == (1, True)
    assert said.err.startswith("devices_cli: cannot:")
    assert "'hub'" in said.err.casefold() and "bundled engine" in said.err
    assert "NOVA_HUB_AGENT_NAME=<a name> ./install" in said.err
    assert await pool.fetchval("SELECT count(*) FROM pairing_codes") == 0


async def test_a_machine_already_called_hub_gets_no_re_pair_code_either(pool, capsys):
    """A row named `hub` before D8 reserved it: the name is refused before it
    is looked up, so no re-pair code is minted for that row either."""
    await _paired(pool, "hub")
    rc = await devices_cli.run(["mint", "--name", "hub"], pool=pool)
    said = capsys.readouterr()
    nothing_printed = said.out == ""
    assert (rc, nothing_printed) == (1, True)
    assert "devices_cli: cannot:" in said.err
    assert await pool.fetchval("SELECT count(*) FROM pairing_codes") == 0


@pytest.mark.parametrize("name", ["", "two\nlines", "x" * 65])
async def test_a_name_the_registry_cannot_take_is_a_stated_cannot(pool, capsys, name):
    rc = await devices_cli.run(["mint", "--name", name], pool=pool)
    said = capsys.readouterr()
    nothing_printed = said.out == ""
    assert (rc, nothing_printed) == (1, True)
    assert said.err.startswith("devices_cli: cannot:")
    assert await pool.fetchval("SELECT count(*) FROM pairing_codes") == 0


async def test_the_module_run_as_a_process_prints_the_one_line_and_nothing_else(pool):
    """The process opens its own pool from DATABASE_URL and closes it, and
    stdout is exactly the one JSON line ./install reads the code from."""
    proc = _module("procbox")
    rc, err, printed = proc.returncode, proc.stderr, _Printed(proc.stdout)
    assert (rc, err) == (0, "")
    out = _minted(printed)
    assert out["code_shape"] is True and out["repair"] is False
    row = await _latest_code(pool)
    assert (row["name"], row["created_by"], row["code_hash"]) == ("procbox", None, out["code_hash"])


async def test_the_process_answers_a_refusal_on_stderr_with_exit_1(pool):
    proc = _module("Hub")
    rc, nothing_printed, err = proc.returncode, proc.stdout == "", proc.stderr
    assert (rc, nothing_printed) == (1, True)
    assert err.startswith("devices_cli: cannot:") and "'Hub'" in err
    assert await pool.fetchval("SELECT count(*) FROM pairing_codes") == 0
