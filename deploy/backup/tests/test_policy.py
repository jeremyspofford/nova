"""The declarations themselves: both directions, each its own failure.

design-verdict.md §6.7 is the argument this file enforces. The banned
`BACKUP_EXCLUDE_DATA` shape failed in two directions silently — a thing in the
stack that the list did not name was skipped, and a name in the list that
matched nothing in the stack was invisible. Here:

  * a volume in the compose file with no disposition reddens the unit suite
    BEFORE the operator ever meets the runtime refusal, and
  * a disposition naming a volume the file does not declare reddens it too.

No docker. The raw text is this repo's own deploy/docker-compose.yml; the
rendered half comes from the checked-in fixture, which refresh.sh regenerates
from that same file.
"""

import re

import pytest
from conftest import COMPOSE_FILE, FIXTURES, compose_read

from novabundle import DISPOSITIONS, ENV_DISPOSITIONS, SEGMENT_POLICY

RENDER = FIXTURES / "compose-v5.3.0.yaml"
ENV_EXAMPLE = COMPOSE_FILE.parent / ".env.example"


def raw_volume_keys():
    return compose_read("raw_volume_keys", COMPOSE_FILE.read_text()).split()


def raw_service_keys():
    return compose_read("raw_service_keys", COMPOSE_FILE.read_text()).split()


def rendered_volume_dispositions():
    """{key: (disposition, reason)} from the YAML render."""
    text = RENDER.read_text()
    out = {}
    for key in compose_read("cfg_volume_keys", text).split():
        line = compose_read(f'cfg_volume_disposition "{key}"', text).rstrip("\n")
        if line:
            disposition, _, reason = line.partition("\t")
            out[key] = (disposition, reason)
    return out


def rendered_bind_dispositions():
    text = RENDER.read_text()
    out = {}
    for svc in compose_read("cfg_service_keys", text).split():
        for line in compose_read(f'cfg_mounts "{svc}"', text).splitlines():
            parts = line.split("\t")
            if len(parts) < 6 or parts[0] != "bind":
                continue
            out[(svc, parts[2])] = (parts[1], parts[4], parts[5])
    return out


def rendered_anon_dispositions():
    text = RENDER.read_text()
    out = {}
    for svc in compose_read("cfg_service_keys", text).split():
        for line in compose_read(f'cfg_anon "{svc}"', text).splitlines():
            target, _, rest = line.partition("\t")
            disposition, _, reason = rest.partition("\t")
            out[(svc, target)] = (disposition, reason)
    return out


def env_declarations():
    """{key: disposition} from `# nova-backup:` lines in .env.example.

    The same rule render_env applies: the declaration is the comment line
    IMMEDIATELY above the key, and a commented-out key counts, because
    COMPOSE_FILE and INSTANCE_SECRET are written into a real .env by something
    other than this file.
    """
    out, pending = {}, None
    for line in ENV_EXAMPLE.read_text().splitlines():
        m = re.match(r"^# nova-backup:\s*(\S+)", line)
        if m:
            pending = m.group(1)
            continue
        m = re.match(r"^#?\s*([A-Za-z_][A-Za-z0-9_]*)=", line)
        if m:
            if pending:
                out[m.group(1)] = pending
            pending = None
            continue
        pending = None
    return out


# ── the compose file ────────────────────────────────────────────────────────


def test_every_volume_the_file_declares_has_a_disposition():
    declared = set(raw_volume_keys())
    have = set(rendered_volume_dispositions())
    missing = sorted(declared - have)
    assert not missing, (
        f"{missing} are declared under `volumes:` in {COMPOSE_FILE.name} with no "
        "x-nova-backup row. Adding one here is what stops the operator meeting "
        "R2_UNCLASSIFIED at backup time instead."
    )


def test_every_disposition_names_a_volume_the_file_declares():
    declared = set(raw_volume_keys())
    extra = sorted(set(rendered_volume_dispositions()) - declared)
    assert not extra, f"{extra} carry an x-nova-backup row and are declared nowhere."


def test_every_volume_disposition_is_one_of_the_eight():
    for key, (disposition, _) in rendered_volume_dispositions().items():
        assert disposition in DISPOSITIONS, f"{key}: {disposition!r}"


def test_every_volume_exclude_carries_a_reason():
    for key, (disposition, reason) in rendered_volume_dispositions().items():
        if disposition.startswith("exclude-"):
            assert reason.strip(), f"{key} is {disposition} with no reason"


def test_every_bind_in_the_render_carries_a_disposition_and_a_reason():
    binds = rendered_bind_dispositions()
    assert binds, "the render shows no bind at all, which is not this compose file"
    for (svc, target), (source, disposition, reason) in binds.items():
        assert disposition in DISPOSITIONS, f"{svc} at {target} ({source}): {disposition!r}"
        if disposition.startswith("exclude-"):
            assert reason.strip(), f"{svc} at {target} is {disposition} with no reason"


def test_every_anon_row_is_legal_and_reasoned():
    anon = rendered_anon_dispositions()
    assert anon, (
        "no service carries an x-nova-backup-anon row. searxng's image declares "
        "/etc/searxng and /var/cache/searxng, and the second is live on this "
        "machine as an anonymous volume — without a row, every backup refuses."
    )
    for (svc, target), (disposition, reason) in anon.items():
        assert disposition in DISPOSITIONS, f"{svc} at {target}: {disposition!r}"
        assert reason.strip(), f"{svc} at {target} has no reason"


def test_searxng_declares_the_anonymous_volume_that_is_live_on_this_machine():
    """port-v3 C2. It exists ONLY in `docker inspect` output: compose never
    names an image-declared volume, so it has no entry under `volumes:`."""
    assert ("searxng", "/var/cache/searxng") in rendered_anon_dispositions()


def test_the_dispositions_cover_every_v4_volume_by_name():
    """Not a restatement of the two-direction test: this pins the SET, so a
    volume quietly dropped from the compose file is as loud as one added."""
    assert sorted(raw_volume_keys()) == [
        "v4_memdata",
        "v4_models",
        "v4_ollama",
        "v4_pgdata",
        "v4_tailscale",
        "v4_workspace",
    ]


def test_exactly_one_volume_is_dump_pg_and_it_is_the_database_one():
    by_disposition = {}
    for key, (disposition, _) in rendered_volume_dispositions().items():
        by_disposition.setdefault(disposition, []).append(key)
    assert by_disposition.get("dump-pg") == ["v4_pgdata"]
    assert by_disposition.get("move-only") == ["v4_tailscale"]
    assert sorted(by_disposition.get("include", [])) == ["v4_memdata", "v4_workspace"]


# ── .env.example ────────────────────────────────────────────────────────────


def test_every_key_in_the_example_has_a_declaration():
    declarations = env_declarations()
    undeclared = []
    for line in ENV_EXAMPLE.read_text().splitlines():
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", line)
        if m and m.group(1) not in declarations:
            undeclared.append(m.group(1))
    assert not undeclared, f"{undeclared} have no `# nova-backup:` line above them"


def test_every_env_declaration_is_one_of_the_three():
    for key, value in env_declarations().items():
        assert value in ENV_DISPOSITIONS, f"{key}: {value!r}"


@pytest.mark.parametrize("key,expected", [("COMPOSE_FILE", "host"), ("INSTANCE_SECRET", "drop")])
def test_the_two_keys_only_a_real_env_carries_are_declared(key, expected):
    """s41/measurements.md R7, measured on the live stack 2026-09-21: the live
    deploy/.env carries exactly two keys .env.example does not. Without a
    declaration the first real `./install backup` refuses."""
    assert env_declarations().get(key) == expected


def test_the_secrets_install_sh_generates_all_travel():
    declarations = env_declarations()
    for key in (
        "POSTGRES_PASSWORD",
        "CORE_TOKEN",
        "CORE_GATEWAY_TOKEN",
        "CORE_MEMORY_TOKEN",
        "SEARXNG_SECRET",
    ):
        assert declarations.get(key) == "carry", key


def test_this_machines_own_settings_never_travel():
    declarations = env_declarations()
    for key in ("COMPOSE_FILE", "COMPOSE_PROFILES", "NOVA_WEB_ADDR", "NOVA_TAILSCALE_ADDR"):
        assert declarations.get(key) == "host", key
    assert declarations.get("TS_AUTHKEY") == "host"


# ── SEGMENT_POLICY ──────────────────────────────────────────────────────────


def test_every_segment_policy_row_carries_a_reason_and_a_legal_disposition():
    assert SEGMENT_POLICY
    for segment, row in SEGMENT_POLICY.items():
        assert row["disposition"] in DISPOSITIONS, segment
        assert row["disposition"].startswith("exclude-"), (
            f"{segment} is {row['disposition']}: a segment row may only ever EXCLUDE. "
            "Including by segment name would carry something nobody looked at."
        )
        assert row["reason"].strip(), segment


def test_segment_policy_names_no_path():
    for segment in SEGMENT_POLICY:
        assert "/" not in segment, (
            f"{segment!r} is a path, not a segment. An exact path row is what missed "
            "`.superpowers/sdd/.gitignore` in port-v3 (verdict §6.4)."
        )
