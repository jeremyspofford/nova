"""`python -m app.devices_cli mint --name N` (S42b P23).

The pairing code ./install hands the hub machine's own agent — through the
agent's environment, never a log line. Minted with no person: on a first
install nobody has registered yet. A name that a live device already has
gets a RE-PAIR code bound to that device (decision 4), so a reinstall keeps
the machine's row and history. Prints one JSON line: {"code", "expires_at",
"repair"}. Exit 1, with the reason on stderr, when the code cannot be minted.

The name is held to the device-name rules BEFORE it is looked up. `hub` is
the bundled engine's name (D8), in any case or padding, so it is refused
with what to do instead — on the re-pair path too, where a row named before
D8 reserved it could otherwise match — and nothing is minted under any other
name in its place.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from app import db, devices

# How ./install is told the machine's name when its hostname will not do.
NAME_ENV = "NOVA_HUB_AGENT_NAME"


def _name(name: str) -> str:
    """`name` as the registry will take it, or DeviceRefused. The reserved
    word gets its own refusal: the operator running ./install can act on it."""
    if devices._reserved(name):
        raise devices.DeviceRefused(
            f"this machine's agent cannot be named {name.strip()!r} — that is the bundled "
            f"engine's name (hub decision D8); name it after the machine: {NAME_ENV}=<a name> "
            "./install"
        )
    return devices._clean_name(name)


async def _mint(pool, name: str) -> dict:
    name = _name(name)
    row = await devices.get_live_by_name(pool, name)
    minted = await devices.mint_pairing_code(
        pool,
        created_by=None,
        device_id=row["id"] if row is not None else None,
        name=None if row is not None else name,
    )
    return {**minted, "repair": row is not None}


async def run(argv: list[str], *, pool=None) -> int:
    """The verb. `pool` is the caller's (a test's); without one this opens
    core's own from DATABASE_URL and closes it before returning."""
    parser = argparse.ArgumentParser(prog="python -m app.devices_cli")
    verbs = parser.add_subparsers(dest="verb", required=True)
    mint = verbs.add_parser("mint", help="a pairing code for the hub machine's own agent")
    mint.add_argument("--name", required=True, help="the machine's name")
    args = parser.parse_args(argv)
    own = pool is None
    if own:
        pool = await db.get_pool()
    try:
        out = await _mint(pool, args.name)
    except devices.DeviceRefused as exc:
        print(f"devices_cli: cannot: {exc.reason}", file=sys.stderr)
        return 1
    finally:
        if own:
            await db.close_pool()
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(sys.argv[1:])))
