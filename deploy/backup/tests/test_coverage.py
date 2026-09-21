"""coverage() — every refusal code, and the one property that matters most.

design-verdict.md §6.3 is the algorithm, §6.6 the refusal. No docker, no live
stack, no network: every case is a fact dict built here.

The property the whole slice rests on: a refusal NEVER downgrades to a skip.
Each case asserts both halves — the refusal is raised, AND the entry it is
about is still in `entries` carrying its reason, so the operator is told what
was found rather than handed a bundle that quietly lacks it.
"""

import copy

import pytest

from novabundle import SEGMENT_POLICY, CoverageRefused, carried_entries, coverage

PROJECT = "nova"


def base_facts():
    """A stack that covers itself: the smallest fact set with zero refusals."""
    return {
        "raw": {
            "project": PROJECT,
            "compose_files": ["/repo/deploy/docker-compose.yml"],
            "services": ["postgres", "memory", "searxng"],
            "volumes": ["v4_pgdata", "v4_memdata", "v4_tailscale"],
        },
        "config": {
            "name": PROJECT,
            "services": {
                "postgres": {
                    "image": "postgres:16",
                    "volumes": [
                        {
                            "type": "volume",
                            "source": "v4_pgdata",
                            "target": "/var/lib/postgresql/data",
                        },
                        {
                            "type": "bind",
                            "source": "/repo/deploy/postgres-init",
                            "target": "/docker-entrypoint-initdb.d",
                            "read_only": True,
                        },
                    ],
                },
                "memory": {
                    "image": "nova-memory",
                    "volumes": [
                        {"type": "volume", "source": "v4_memdata", "target": "/data/memory"}
                    ],
                },
                "searxng": {"image": "searxng/searxng:latest", "volumes": []},
            },
            "volumes": {
                "v4_pgdata": {"name": "nova_v4_pgdata"},
                "v4_memdata": {"name": "nova_v4_memdata"},
                "v4_tailscale": {"name": "nova_v4_tailscale"},
            },
        },
        "dispositions": {
            "volumes": {
                "v4_pgdata": {"disposition": "dump-pg", "reason": "a live file copy is torn"},
                "v4_memdata": {"disposition": "include", "reason": "the notes"},
                "v4_tailscale": {"disposition": "move-only", "reason": "two nodes flap"},
            },
            "binds": {
                "postgres": {
                    "/docker-entrypoint-initdb.d": {
                        "disposition": "exclude-code",
                        "reason": "in git",
                        "source": "/repo/deploy/postgres-init",
                        "read_only": True,
                    }
                }
            },
            "anon": {
                "searxng": {
                    "/var/cache/searxng": {
                        "disposition": "exclude-ephemeral",
                        "reason": "a search cache",
                    }
                }
            },
        },
        "containers": {
            "containers": [
                {
                    "id": "aaa",
                    "name": "nova-memory-1",
                    "service": "memory",
                    "state": "running",
                    "config_files": "/repo/deploy/docker-compose.yml",
                    "mounts": [
                        {
                            "Type": "volume",
                            "Name": "nova_v4_memdata",
                            "Destination": "/data/memory",
                            "RW": True,
                        }
                    ],
                },
                {
                    "id": "bbb",
                    "name": "nova-searxng-1",
                    "service": "searxng",
                    "state": "running",
                    "config_files": "/repo/deploy/docker-compose.yml",
                    "mounts": [
                        {
                            "Type": "volume",
                            "Name": "a" * 64,
                            "Destination": "/var/cache/searxng",
                            "RW": True,
                        }
                    ],
                },
            ]
        },
        "git": {
            "work_tree": True,
            "root": "/repo",
            "paths": {
                "deploy/.env": "ignored",
                "deploy/docker-compose.yml": "tracked",
                "deploy/postgres-init": "tracked",
            },
        },
        "env": {
            "env_file": "/repo/deploy/.env",
            "keys": ["POSTGRES_PASSWORD", "COMPOSE_FILE", "INSTANCE_SECRET"],
            "declarations": {
                "POSTGRES_PASSWORD": "carry",
                "COMPOSE_FILE": "host",
                "INSTANCE_SECRET": "drop",
                "TS_AUTHKEY": "host",
            },
        },
        "databases": {"databases": [{"name": "nova_core", "owner": "core"}]},
        "reachable": {
            "volumes": {"v4_memdata": {"exists": True, "ok": True, "detail": ""}},
            "files": {"deploy/.env": {"exists": True, "ok": True, "detail": ""}},
        },
    }


def codes(refusals):
    return [r.code for r in refusals]


def entry_for(entries, kind, name):
    for e in entries:
        if e.kind == kind and e.name == name:
            return e
    raise AssertionError(f"no {kind} entry named {name!r} in {[(e.kind, e.name) for e in entries]}")


# ── the clean baseline ──────────────────────────────────────────────────────


def test_a_stack_that_covers_itself_has_no_refusals():
    entries, refusals = coverage(base_facts(), "routine")
    assert codes(refusals) == []
    assert entries


def test_the_baseline_classifies_each_source_it_was_given():
    entries, _ = coverage(base_facts(), "routine")
    assert entry_for(entries, "volume", "v4_memdata").disposition == "include"
    assert entry_for(entries, "volume", "v4_pgdata").disposition == "dump-pg"
    assert entry_for(entries, "anon", "/var/cache/searxng").disposition == "exclude-ephemeral"
    assert entry_for(entries, "bind", "/repo/deploy/postgres-init").disposition == "exclude-code"
    assert entry_for(entries, "path", "deploy/.env").disposition == "include"
    assert entry_for(entries, "path", "deploy/docker-compose.yml").disposition == "exclude-code"
    assert entry_for(entries, "env", "POSTGRES_PASSWORD").disposition == "carry"
    assert entry_for(entries, "database", "nova_core").disposition == "dump-pg"


def test_the_full_volume_name_is_read_from_the_render_never_assembled():
    f = base_facts()
    f["config"]["volumes"]["v4_memdata"]["name"] = "someone_elses_name"
    entries, refusals = coverage(f, "routine")
    assert codes(refusals) == []
    assert entry_for(entries, "volume", "v4_memdata").full_name == "someone_elses_name"


# ── R0_FACT_UNREADABLE ──────────────────────────────────────────────────────


def test_R0_a_missing_fact_is_a_refusal_not_an_empty_one():
    f = base_facts()
    del f["containers"]
    _, refusals = coverage(f, "routine")
    assert "R0_FACT_UNREADABLE" in codes(refusals)
    assert "containers" in refusals[0].subject


def test_R0_a_renderer_that_could_not_be_asked_carries_its_stderr():
    f = base_facts()
    f["git"] = {"error": "fatal: not a git repository", "paths": {}}
    _, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R0_FACT_UNREADABLE")
    assert "fatal: not a git repository" in r.detail


def test_R0_not_a_git_work_tree_is_its_own_sentence():
    f = base_facts()
    f["git"] = {"work_tree": False, "root": "/repo", "paths": {}}
    _, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R0_FACT_UNREADABLE")
    assert "not a git work tree" in r.detail


def test_R0_a_render_of_another_project_is_refused():
    f = base_facts()
    f["config"]["name"] = "nova-v3"
    _, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R0_FACT_UNREADABLE")
    assert "nova-v3" in r.detail and "nova" in r.detail


# ── R1_PROFILE_GAP ──────────────────────────────────────────────────────────


def test_R1_refuses_when_the_render_is_missing_a_raw_service():
    f = base_facts()
    del f["config"]["services"]["searxng"]
    _, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R1_PROFILE_GAP")
    assert "searxng" in r.subject
    assert "profile" in r.detail


# ── R2_UNCLASSIFIED ─────────────────────────────────────────────────────────


def test_R2_refuses_an_undeclared_volume_and_keeps_the_entry():
    f = base_facts()
    f["raw"]["volumes"].append("v4_vectors")
    f["config"]["volumes"]["v4_vectors"] = {"name": "nova_v4_vectors"}
    f["config"]["services"]["memory"]["volumes"].append(
        {"type": "volume", "source": "v4_vectors", "target": "/data/vectors"}
    )
    entries, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R2_UNCLASSIFIED")
    assert "v4_vectors" in r.subject and "nova_v4_vectors" in r.subject
    assert entry_for(entries, "volume", "v4_vectors").disposition == ""
    with pytest.raises(CoverageRefused):
        carried_entries(coverage(f, "routine"))


def test_R2_names_all_eight_legal_dispositions_in_the_fix():
    f = base_facts()
    f["dispositions"]["volumes"]["v4_memdata"]["disposition"] = "keep-it-i-guess"
    _, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R2_UNCLASSIFIED")
    for value in (
        "include",
        "dump-pg",
        "move-only",
        "exclude-code",
        "exclude-redownload",
        "exclude-derived",
        "exclude-ephemeral",
        "exclude-declined",
    ):
        assert value in r.fix
    assert "keep-it-i-guess" in r.detail


def test_R2_refuses_an_exclude_without_a_reason():
    f = base_facts()
    f["dispositions"]["volumes"]["v4_pgdata"] = {"disposition": "exclude-code", "reason": "  "}
    _, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R2_UNCLASSIFIED")
    assert "reason" in r.detail
    assert "v4_pgdata" in r.subject


def test_an_include_needs_no_reason():
    f = base_facts()
    f["dispositions"]["volumes"]["v4_memdata"] = {"disposition": "include", "reason": ""}
    _, refusals = coverage(f, "routine")
    assert codes(refusals) == []


def test_R2_refuses_a_declared_volume_the_render_pruned():
    """shell-first C2: declared, mounted by no service, absent from every render."""
    f = base_facts()
    f["raw"]["volumes"].append("v4_orphan")
    entries, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R2_UNCLASSIFIED")
    assert "v4_orphan" in r.subject
    assert "mounted by no service" in r.detail
    assert "deploy/docker-compose.yml" in r.detail
    assert entry_for(entries, "volume", "v4_orphan").disposition == ""


def test_R2_refuses_an_anonymous_volume_with_no_service_declaration():
    """port-v3 C2: the volume that exists ONLY in docker inspect output."""
    f = base_facts()
    del f["dispositions"]["anon"]["searxng"]
    entries, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R2_UNCLASSIFIED")
    assert "searxng" in r.subject and "/var/cache/searxng" in r.subject
    assert "the image declares this volume" in r.detail
    assert "x-nova-backup-anon" in r.fix
    assert entry_for(entries, "anon", "/var/cache/searxng").disposition == ""


def test_an_anonymous_volume_is_keyed_by_service_and_target_not_by_its_id():
    """The 64-hex id changes on every recreate, so it can never be the key."""
    f = base_facts()
    f["containers"]["containers"][1]["mounts"][0]["Name"] = "b" * 64
    _, refusals = coverage(f, "routine")
    assert codes(refusals) == []


def test_R2_refuses_a_bind_with_no_disposition():
    f = base_facts()
    del f["dispositions"]["binds"]["postgres"]
    entries, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R2_UNCLASSIFIED")
    assert "/repo/deploy/postgres-init" in r.subject
    assert "x-nova-backup" in r.fix
    assert entry_for(entries, "bind", "/repo/deploy/postgres-init").disposition == ""


def test_R2_refuses_a_mount_of_a_volume_the_compose_file_does_not_declare():
    f = base_facts()
    f["config"]["services"]["memory"]["volumes"].append(
        {"type": "volume", "source": "v4_undeclared", "target": "/x"}
    )
    _, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R2_UNCLASSIFIED")
    assert "v4_undeclared" in r.subject


def test_R2_refuses_an_env_key_nothing_declares():
    f = base_facts()
    f["env"]["keys"].append("SOME_NEW_KEY")
    entries, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R2_UNCLASSIFIED")
    assert "SOME_NEW_KEY" in r.subject
    assert ".env.example" in r.fix
    assert entry_for(entries, "env", "SOME_NEW_KEY").disposition == ""


def test_R2_refuses_a_host_path_git_calls_unknown():
    f = base_facts()
    f["git"]["paths"]["deploy/mystery.dat"] = "unknown"
    entries, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R2_UNCLASSIFIED")
    assert "deploy/mystery.dat" in r.subject
    assert entry_for(entries, "path", "deploy/mystery.dat").disposition == ""


def test_git_unknown_is_a_refusal_not_an_include():
    f = base_facts()
    f["git"]["paths"]["deploy/mystery.dat"] = "unknown"
    entries, refusals = coverage(f, "routine")
    assert refusals
    assert entry_for(entries, "path", "deploy/mystery.dat").disposition != "include"


# ── SEGMENT_POLICY ──────────────────────────────────────────────────────────


def test_segment_policy_catches_a_nested_superpowers_path():
    """port-v3 M10: an exact-path table misses `.superpowers/sdd/.gitignore`,
    which is what the real scan emits, because `.superpowers/` is not in
    .gitignore — the ignore comes from a nested .gitignore one level down.
    A SEGMENT means the same thing wherever it appears."""
    f = base_facts()
    f["git"]["paths"]["deploy/.superpowers/sdd/.gitignore"] = "unknown"
    entries, refusals = coverage(f, "routine")
    assert codes(refusals) == []
    e = entry_for(entries, "path", "deploy/.superpowers/sdd/.gitignore")
    assert e.disposition.startswith("exclude-")
    assert e.reason


def test_segment_policy_beats_git_so_a_bundle_never_contains_a_bundle():
    f = base_facts()
    f["git"]["paths"]["deploy/backups/nova-backup-old.tar"] = "ignored"
    entries, refusals = coverage(f, "routine")
    assert codes(refusals) == []
    assert entry_for(entries, "path", "deploy/backups/nova-backup-old.tar").disposition.startswith(
        "exclude-"
    )


def test_every_segment_policy_row_is_a_legal_disposition_with_a_reason():
    for segment, row in SEGMENT_POLICY.items():
        assert segment == segment.strip() and segment
        assert row["disposition"] in ("exclude-ephemeral", "exclude-declined"), segment
        assert row["reason"].strip(), segment


# ── R3_INTERPOLATION ────────────────────────────────────────────────────────


def test_R3_refuses_an_unexpanded_variable_and_never_applies_the_compose_default():
    f = base_facts()
    f["config"]["services"]["memory"]["volumes"].append(
        {"type": "bind", "source": "${NOVA_EXTRA_DIR:-/var/tmp/x}", "target": "/extra"}
    )
    entries, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R3_INTERPOLATION")
    assert "NOVA_EXTRA_DIR" in r.subject
    e = entry_for(entries, "bind", "${NOVA_EXTRA_DIR:-/var/tmp/x}")
    assert e.disposition == ""
    assert "/var/tmp/x" not in [x.name for x in entries]


def test_R3_catches_the_bare_dollar_form_too():
    f = base_facts()
    f["config"]["services"]["memory"]["volumes"].append(
        {"type": "bind", "source": "$HOME/nova", "target": "/extra"}
    )
    _, refusals = coverage(f, "routine")
    assert "R3_INTERPOLATION" in codes(refusals)


# ── R4_UNDECLARED_LIVE_MOUNT ────────────────────────────────────────────────


def test_R4_refuses_a_live_mount_compose_does_not_name():
    f = base_facts()
    f["containers"]["containers"][0]["mounts"].append(
        {"Type": "volume", "Name": "nova_kokoro_models", "Destination": "/models", "RW": True}
    )
    entries, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R4_UNDECLARED_LIVE_MOUNT")
    assert "nova_kokoro_models" in r.subject
    assert "nova-memory-1" in r.detail
    assert entry_for(entries, "live-volume", "nova_kokoro_models").disposition == ""


def test_R4_refuses_a_live_bind_the_render_does_not_name():
    f = base_facts()
    f["containers"]["containers"][0]["mounts"].append(
        {"Type": "bind", "Source": "/srv/elsewhere", "Destination": "/repo", "RW": True}
    )
    _, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R4_UNDECLARED_LIVE_MOUNT")
    assert "/srv/elsewhere" in r.subject


def test_R4_names_the_config_files_label_so_a_foreign_leftover_is_recognisable():
    f = base_facts()
    f["containers"]["containers"].append(
        {
            "id": "ccc",
            "name": "nova-kokoro-1",
            "service": "kokoro",
            "state": "exited",
            "config_files": "/elsewhere/docker-compose.yml",
            "mounts": [
                {
                    "Type": "volume",
                    "Name": "nova_kokoro_models",
                    "Destination": "/models",
                    "RW": True,
                }
            ],
        }
    )
    _, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R4_UNDECLARED_LIVE_MOUNT")
    assert "/elsewhere/docker-compose.yml" in r.detail


def test_an_exited_container_is_read_too():
    f = base_facts()
    f["containers"]["containers"][0]["state"] = "exited"
    f["containers"]["containers"][0]["mounts"].append(
        {"Type": "volume", "Name": "nova_ntfy_cache", "Destination": "/c", "RW": True}
    )
    _, refusals = coverage(f, "routine")
    assert "R4_UNDECLARED_LIVE_MOUNT" in codes(refusals)


def test_the_project_prefix_is_stripped_from_the_container_side_only():
    """v3 stripped both sides: `nova_state` became `state`, the two sources
    then disagreed in opposite directions and one volume became two refusals
    (backup_coverage.py:455-461)."""
    f = base_facts()
    f["raw"]["volumes"].append("nova_v4_memdata")
    f["config"]["volumes"]["nova_v4_memdata"] = {"name": "nova_nova_v4_memdata"}
    f["config"]["services"]["memory"]["volumes"].append(
        {"type": "volume", "source": "nova_v4_memdata", "target": "/odd"}
    )
    f["dispositions"]["volumes"]["nova_v4_memdata"] = {"disposition": "include", "reason": "x"}
    f["reachable"]["volumes"]["nova_v4_memdata"] = {"exists": True, "ok": True, "detail": ""}
    _, refusals = coverage(f, "routine")
    assert codes(refusals) == []


# ── R5_VOLUME_MISSING / R6_UNREACHABLE ──────────────────────────────────────


def test_R5_an_include_volume_with_no_volume_on_this_host():
    f = base_facts()
    f["reachable"]["volumes"]["v4_memdata"] = {
        "exists": False,
        "ok": False,
        "detail": "no such volume",
    }
    entries, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R5_VOLUME_MISSING")
    assert "nova_v4_memdata" in r.subject
    assert entry_for(entries, "volume", "v4_memdata").disposition == "include"


def test_R6_an_include_volume_the_backup_cannot_read():
    f = base_facts()
    f["reachable"]["volumes"]["v4_memdata"] = {
        "exists": True,
        "ok": False,
        "detail": "`docker run -v nova_v4_memdata:/probe:ro postgres:16 find /probe` exited 125",
    }
    _, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R6_UNREACHABLE")
    assert "exited 125" in r.detail
    assert "worse than no bundle" in r.detail


def test_R6_an_include_volume_with_no_reachability_reading_at_all():
    """Silence is not coverage: a source nothing probed is not a source proven
    readable."""
    f = base_facts()
    del f["reachable"]["volumes"]["v4_memdata"]
    _, refusals = coverage(f, "routine")
    assert "R6_UNREACHABLE" in codes(refusals)


def test_R6_an_include_class_file_the_backup_cannot_read():
    f = base_facts()
    f["reachable"]["files"]["deploy/.env"] = {
        "exists": True,
        "ok": False,
        "detail": "not readable by this user",
    }
    _, refusals = coverage(f, "routine")
    assert "R6_UNREACHABLE" in codes(refusals)


def test_an_excluded_volume_is_never_probed_for_reachability():
    f = base_facts()
    f["dispositions"]["volumes"]["v4_memdata"] = {
        "disposition": "exclude-declined",
        "reason": "not this time",
    }
    del f["reachable"]["volumes"]["v4_memdata"]
    _, refusals = coverage(f, "routine")
    assert codes(refusals) == []


# ── R7_NO_DATABASES ─────────────────────────────────────────────────────────


def test_R7_refuses_when_the_database_list_is_empty():
    f = base_facts()
    f["databases"]["databases"] = []
    _, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R7_NO_DATABASES")
    assert "no database" in r.detail.lower()


def test_every_database_is_carried_with_no_per_database_disposition():
    f = base_facts()
    f["databases"]["databases"].append({"name": "nova_newthing", "owner": "core"})
    entries, refusals = coverage(f, "routine")
    assert codes(refusals) == []
    assert entry_for(entries, "database", "nova_newthing").disposition == "dump-pg"


# ── mode overlay ────────────────────────────────────────────────────────────


def test_carries_v4_tailscale_only_in_move_mode():
    f = base_facts()
    entries, refusals = coverage(f, "routine")
    assert entry_for(entries, "volume", "v4_tailscale").disposition == "move-only"
    assert entry_for(entries, "volume", "v4_tailscale") not in carried_entries((entries, refusals))

    f = base_facts()
    f["reachable"]["volumes"]["v4_tailscale"] = {"exists": True, "ok": True, "detail": ""}
    entries, refusals = coverage(f, "move")
    e = entry_for(entries, "volume", "v4_tailscale")
    assert e.disposition == "include"
    assert "--move" in e.reason
    assert e in carried_entries((entries, refusals))


def test_move_mode_probes_the_move_only_volume_for_reachability():
    _, refusals = coverage(base_facts(), "move")
    assert "R6_UNREACHABLE" in codes(refusals)


def test_an_unknown_mode_is_refused_rather_than_treated_as_routine():
    with pytest.raises(ValueError):
        coverage(base_facts(), "sort-of-a-move")


# ── env dispositions ────────────────────────────────────────────────────────


def test_env_carries_only_the_carry_disposition():
    entries, refusals = coverage(base_facts(), "routine")
    assert codes(refusals) == []
    carried = [e.name for e in entries if e.kind == "env" and e.disposition == "carry"]
    assert "POSTGRES_PASSWORD" in carried
    for absent in ("COMPOSE_FILE", "INSTANCE_SECRET", "TS_AUTHKEY", "NOVA_SUBNET"):
        assert absent not in carried


def test_env_declarations_that_name_no_live_key_are_not_entries():
    entries, _ = coverage(base_facts(), "routine")
    names = [e.name for e in entries if e.kind == "env"]
    assert "TS_AUTHKEY" not in names


# ── the property the slice rests on ─────────────────────────────────────────


def test_a_refusal_never_downgrades_to_a_skip():
    """Two halves, deliberately asserted together: the set that WOULD be
    carried is empty, and asking for it raises. A coverage that returned a
    shorter include list and a warning would pass one of these."""
    f = base_facts()
    f["raw"]["volumes"].append("v4_vectors")
    f["config"]["volumes"]["v4_vectors"] = {"name": "nova_v4_vectors"}
    f["config"]["services"]["memory"]["volumes"].append(
        {"type": "volume", "source": "v4_vectors", "target": "/data/vectors"}
    )
    result = coverage(f, "routine")
    assert not result.may_backup
    with pytest.raises(CoverageRefused) as exc:
        carried_entries(result)
    assert "R2_UNCLASSIFIED" in str(exc.value)


def test_may_backup_is_false_whenever_refusals_is_non_empty():
    f = base_facts()
    f["databases"]["databases"] = []
    result = coverage(f, "routine")
    assert result.refusals and result.may_backup is False


def test_every_refusal_is_collected_so_one_run_names_them_all():
    f = base_facts()
    f["raw"]["volumes"].append("v4_orphan")
    f["databases"]["databases"] = []
    f["env"]["keys"].append("MYSTERY")
    f["reachable"]["volumes"]["v4_memdata"] = {"exists": False, "ok": False, "detail": "gone"}
    _, refusals = coverage(f, "routine")
    assert {"R2_UNCLASSIFIED", "R5_VOLUME_MISSING", "R7_NO_DATABASES"} <= set(codes(refusals))
    assert len([c for c in codes(refusals) if c == "R2_UNCLASSIFIED"]) >= 2


def test_coverage_does_not_mutate_the_facts_it_was_given():
    f = base_facts()
    before = copy.deepcopy(f)
    coverage(f, "routine")
    assert f == before


def test_the_refusal_text_is_the_house_shape():
    from novabundle import render_refusals

    f = base_facts()
    f["raw"]["volumes"].append("v4_orphan")
    _, refusals = coverage(f, "routine")
    text = render_refusals(refusals)
    assert text.startswith("Error: ")
    assert "No bundle was written." in text
    assert "R2_UNCLASSIFIED" in text
    assert "1 refusal." in text
    assert "./install backup" in text


def test_a_live_bind_is_matched_by_service_and_destination_not_by_host_path():
    """Measured 2026-09-21 from the checkout that owns the live stack:
    nova-postgres-1 reports its initdb bind as
    /run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/<distro>/<hash>
    while the render says the real host path. Docker Desktop rewrites the
    Source it reports, so matching on it refuses every backup on this host."""
    f = base_facts()
    f["containers"]["containers"].append(
        {
            "id": "ddd",
            "name": "nova-postgres-1",
            "service": "postgres",
            "state": "running",
            "config_files": "/repo/deploy/docker-compose.yml",
            "mounts": [
                {
                    "Type": "bind",
                    "Source": "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/D/0bad0bad",
                    "Destination": "/docker-entrypoint-initdb.d",
                    "RW": False,
                }
            ],
        }
    )
    entries, refusals = coverage(f, "routine")
    assert codes(refusals) == []
    assert not [e for e in entries if e.kind == "live-bind"]


def test_a_live_bind_at_a_destination_the_service_does_not_declare_still_refuses():
    f = base_facts()
    f["containers"]["containers"].append(
        {
            "id": "eee",
            "name": "nova-postgres-1",
            "service": "postgres",
            "state": "running",
            "config_files": "/repo/deploy/docker-compose.yml",
            "mounts": [
                {
                    "Type": "bind",
                    "Source": "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/D/0bad0bad",
                    "Destination": "/somewhere-else",
                    "RW": True,
                }
            ],
        }
    )
    _, refusals = coverage(f, "routine")
    r = next(x for x in refusals if x.code == "R4_UNDECLARED_LIVE_MOUNT")
    assert "/somewhere-else" in r.detail
