"""coverage() over the REAL v4 stack, from captured fixtures.

design-verdict.md §12.3: the compose render alone is not enough. port-v3's
drift alarm had only a compose fixture, and the anonymous volume that breaks
every backup exists ONLY in `docker inspect` output — so that suite passed
while the product refused. Every fixture here comes from a command
(fixtures/refresh.sh), never from a hand-written table, and the dispositions
are read by the SHIPPED deploy/compose_read.sh rather than by a second parser
written for the test.

If this file goes red after a compose edit, the fixtures are stale: run
deploy/backup/fixtures/refresh.sh in the same commit as the edit.
"""

import json

import pytest
from conftest import FIXTURES, compose_read

from novabundle import SEGMENT_POLICY, CoverageRefused, carried_entries, coverage

RENDER = FIXTURES / "compose-v5.3.0.yaml"


def load(name):
    with open(FIXTURES / name, encoding="utf-8") as fh:
        return json.load(fh)


def env_fact():
    """The live .env's KEY NAMES, from cited readings — never a guess.

    The five generated secrets are SECRET_KEYS (deploy/install.sh:29). The two
    keys the live .env carries and .env.example does not are the measured pair
    in s41/measurements.md R7, and they are the whole reason `# nova-backup:`
    declarations may sit on a commented-out key.
    """
    declarations = {}
    pending = None
    for line in (FIXTURES.parent.parent / ".env.example").read_text().splitlines():
        if line.startswith("# nova-backup:"):
            pending = line.split(":", 1)[1].split()[0]
            continue
        stripped = line.lstrip("#").strip()
        if "=" in stripped and stripped.split("=", 1)[0].replace("_", "").isalnum():
            if pending:
                declarations[stripped.split("=", 1)[0]] = pending
            pending = None
            continue
        pending = None
    return {
        "env_file": "/repo/deploy/.env",
        "keys": [
            "POSTGRES_PASSWORD",
            "CORE_TOKEN",
            "CORE_GATEWAY_TOKEN",
            "CORE_MEMORY_TOKEN",
            "SEARXNG_SECRET",
            "COMPOSE_FILE",
            "INSTANCE_SECRET",
        ],
        "declarations": declarations,
    }


def real_facts(containers="containers-v4.json"):
    return {
        "raw": load("raw-v4.json"),
        "config": load("compose-v5.3.0.json"),
        "dispositions": json.loads(compose_read("dispositions_json", RENDER.read_text())),
        "containers": load(containers),
        "git": load("git-v4.json"),
        "reachable": load("reachable-v4.json"),
        "env": env_fact(),
        "databases": load("databases-v4.json"),
    }


# ── the headline ────────────────────────────────────────────────────────────


def test_the_real_v4_stack_covers_itself():
    entries, refusals = coverage(real_facts(), "routine")
    assert [f"{r.code} {r.subject}" for r in refusals] == []
    assert entries


def test_every_entry_of_the_real_stack_is_classified_with_a_reason():
    entries, _ = coverage(real_facts(), "routine")
    for e in entries:
        assert e.disposition, f"{e.kind} {e.name} was not classified"
        if e.disposition.startswith("exclude-"):
            assert e.reason.strip(), f"{e.kind} {e.name} is {e.disposition} with no reason"


def test_the_anonymous_searxng_volume_is_classified_from_docker_inspect_alone():
    """The fixture that port-v3 C2 proves is missing. This entry exists in no
    compose render at all: only `docker inspect` can see it."""
    entries, _ = coverage(real_facts(), "routine")
    anon = [e for e in entries if e.kind == "anon"]
    assert [(e.service, e.name, e.disposition) for e in anon] == [
        ("searxng", "/var/cache/searxng", "exclude-ephemeral")
    ]
    assert anon[0].full_name and len(anon[0].full_name) == 64


def test_the_carried_set_is_exactly_what_the_compose_file_says():
    entries, _ = coverage(real_facts(), "routine")
    carried = sorted(e.name for e in entries if e.kind == "volume" and e.disposition == "include")
    assert carried == ["v4_memdata", "v4_workspace"]
    dumped = [e.name for e in entries if e.kind == "volume" and e.disposition == "dump-pg"]
    assert dumped == ["v4_pgdata"]


def test_the_three_databases_are_the_ones_the_server_reported():
    entries, _ = coverage(real_facts(), "routine")
    assert sorted(e.name for e in entries if e.kind == "database") == [
        "nova_core",
        "nova_gateway",
        "nova_memory",
    ]


def test_move_mode_adds_the_node_identity_and_nothing_else():
    routine, _ = coverage(real_facts(), "routine")
    facts = real_facts()
    facts["reachable"]["volumes"]["v4_tailscale"] = {"exists": True, "ok": True, "detail": ""}
    moved, refusals = coverage(facts, "move")
    assert [r.code for r in refusals] == []

    def carried(entries):
        return {e.name for e in entries if e.disposition == "include"}

    assert carried(moved) - carried(routine) == {"v4_tailscale"}


# ── the same machine's other truth ──────────────────────────────────────────


def test_the_v3_leftovers_under_this_project_name_really_do_refuse():
    """Not a fixture somebody wrote to make R4 fire: these are the containers
    `docker ps -a --filter label=com.docker.compose.project=nova` returns on
    the Dell today. v3's stack was renamed to project `nova-v3`, but the
    containers it created before that are still LABELLED `nova`, so a backup
    run there has state under its own project label that this compose file
    cannot account for."""
    foreign = load("containers-foreign-v4.json")
    if not foreign["containers"]:
        pytest.skip("this host has no foreign container under the project label")
    facts = real_facts(containers="containers-foreign-v4.json")
    _, refusals = coverage(facts, "routine")
    codes = {r.code for r in refusals}
    assert codes == {"R4_UNDECLARED_LIVE_MOUNT"}
    assert any("config_files" in r.detail for r in refusals)


def test_the_real_ignored_path_capture_is_segment_caught_not_refused():
    """port-v3 M10, from the real `git status --porcelain --ignored=matching`:
    the scan emits `.superpowers/sdd/...`, because `.superpowers/` is not in
    .gitignore — the ignore comes from a nested .gitignore one level down. An
    exact-path table misses it and the backup refuses in this worktree."""
    lines = [
        line.rstrip("/")
        for line in (FIXTURES / "ignored-paths.txt").read_text().splitlines()
        if line.strip()
    ]
    assert any(p.startswith(".superpowers/sdd/") for p in lines), (
        "the captured ignored-path list no longer carries a nested .superpowers "
        "path; re-capture it or this test proves nothing"
    )
    facts = real_facts()
    facts["git"]["paths"].update({p: "unknown" for p in lines})
    _, refusals = coverage(facts, "routine")
    assert [r.code for r in refusals] == [], (
        f"a real ignored path fell through SEGMENT_POLICY to R2: {[r.subject for r in refusals]}"
    )


def test_every_captured_ignored_path_has_a_segment_row_that_explains_it():
    lines = [
        line.rstrip("/")
        for line in (FIXTURES / "ignored-paths.txt").read_text().splitlines()
        if line.strip()
    ]
    for path in lines:
        hit = [s for s in path.split("/") if s in SEGMENT_POLICY]
        assert hit, f"{path} matches no SEGMENT_POLICY row"


# ── the fixtures themselves ─────────────────────────────────────────────────


def test_the_fixtures_were_captured_from_one_checkout():
    """A compose render from one machine beside a container capture from
    another proves nothing: every bind would look undeclared. refresh.sh
    normalises both to /repo, and this is the check that it did."""
    config = load("compose-v5.3.0.json")
    for svc in config["services"].values():
        for mount in svc.get("volumes") or []:
            if mount.get("type") == "bind":
                assert mount["source"].startswith("/repo/"), mount["source"]


def test_no_fixture_carries_a_home_directory_or_a_tailnet_name():
    """This repo is public."""
    for name in (
        "compose-v5.3.0.yaml",
        "compose-v5.3.0.json",
        "containers-v4.json",
        "raw-v4.json",
        "git-v4.json",
        "reachable-v4.json",
        "ignored-paths.txt",
    ):
        text = (FIXTURES / name).read_text()
        assert "/home/" not in text, f"{name} carries a home directory"
        assert ".ts.net" not in text, f"{name} carries a tailnet name"


def test_reclassifying_a_real_bind_as_state_demands_a_probe():
    """The reviewer's reproduction, over the real captures: declare the
    gateway's ../data bind `include` and the backup must not proceed until
    something has measured that this host can read it. Before the fix this
    returned refusals: [] with the bind in the carried set and nothing in
    reachable.files touching it."""
    facts = real_facts()
    facts["dispositions"]["binds"]["gateway"]["/data"] = {
        "disposition": "include",
        "reason": "suppose a later slice decides this is state",
        "source": "/repo/data",
        "read_only": True,
    }
    entries, refusals = coverage(facts, "routine")
    r = next(x for x in refusals if x.code == "R6_UNREACHABLE")
    assert "/repo/data" in r.subject
    with pytest.raises(CoverageRefused):
        carried_entries((entries, refusals))
