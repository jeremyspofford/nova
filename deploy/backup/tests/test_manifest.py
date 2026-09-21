"""MANIFEST.json (design-verdict.md §5.3).

Loading is STRICT on purpose: a documented key that is absent, or a value of
the wrong type, RAISES rather than defaulting, and an unknown key is an
error — because a manifest this code does not fully understand is not a
manifest it may restore from. `null` is a value, not an absence.

Every restore decision reads this file, so the cost of a soft read here is
paid at the worst possible moment.
"""

import copy
import json

import pytest
from bundle_fixtures import BASE, PASSPHRASE, make_stage, plan

import novabundle as nb


@pytest.fixture
def manifest(tmp_path):
    return plan(make_stage(tmp_path))


# ── the documented shape ────────────────────────────────────────────────────


def test_every_documented_field_is_present_with_its_documented_type(manifest):
    assert sorted(manifest) == sorted(nb.MANIFEST_SPEC)
    assert nb.load_manifest(copy.deepcopy(manifest)) == manifest


def test_the_stated_constants_are_stated(manifest):
    assert manifest["format"] == "nova-backup/2"
    assert manifest["bundle_version"] == 2
    assert manifest["migration_match"] == "content"
    assert manifest["encryption"]["container"] == "NOVAENC1"
    assert manifest["encryption"]["cipher"] == "aes-256-gcm"
    assert manifest["encryption"]["fingerprint_kind"] == "scrypt-key"


@pytest.mark.parametrize("key", sorted(nb.MANIFEST_SPEC))
def test_a_missing_field_raises_rather_than_defaulting(manifest, key):
    broken = copy.deepcopy(manifest)
    del broken[key]
    with pytest.raises(nb.ManifestError) as caught:
        nb.load_manifest(broken)
    assert key in str(caught.value)


def test_an_unknown_top_level_key_is_an_error(manifest):
    broken = copy.deepcopy(manifest)
    broken["restore_with_sudo"] = True
    with pytest.raises(nb.ManifestError) as caught:
        nb.load_manifest(broken)
    assert "restore_with_sudo" in str(caught.value)


def test_an_unknown_nested_key_is_an_error(manifest):
    broken = copy.deepcopy(manifest)
    broken["source"]["ssh_key"] = "…"
    with pytest.raises(nb.ManifestError) as caught:
        nb.load_manifest(broken)
    assert "ssh_key" in str(caught.value)


@pytest.mark.parametrize(
    "path,value",
    [
        (("member_count",), "17"),
        (("postgres", "server_version_num"), "160010"),
        (("identity", "device_count"), None),
        (("identity", "tailnet_state_carried"), "no"),
        (("source", "compose_files"), "/abs/deploy/docker-compose.yml"),
        (("env_keys",), {"POSTGRES_PASSWORD": "…"}),
        (("created_at",), "2026-09-21T14:30:02Z"),
        (("mode",), "drill"),
        (("transport",), "usb"),
        (("reader_sha256",), "not-a-digest"),
        (("session",), {"TimeZone": "UTC"}),
    ],
)
def test_a_value_of_the_wrong_type_raises(manifest, path, value):
    broken = copy.deepcopy(manifest)
    target = broken
    for step in path[:-1]:
        target = target[step]
    target[path[-1]] = value
    with pytest.raises(nb.ManifestError):
        nb.load_manifest(broken)


def test_null_is_a_value_not_an_absence(manifest):
    """`repo_sha: null` is legitimate — git could not be read. `repo_sha`
    ABSENT is not, and the two must not land in the same branch."""
    ok = copy.deepcopy(manifest)
    ok["source"]["repo_sha"] = None
    ok["source"]["repo_dirty"] = None
    ok["identity"]["core_signing_key_sha256"] = None
    assert nb.load_manifest(ok)
    missing = copy.deepcopy(manifest)
    del missing["source"]["repo_sha"]
    with pytest.raises(nb.ManifestError):
        nb.load_manifest(missing)


def test_bundle_version_1_is_refused_by_name(manifest):
    """v3's shape. An operator holding one needs to be told which tool opens
    it, not a type error twelve fields later."""
    old = copy.deepcopy(manifest)
    old["bundle_version"] = 1
    with pytest.raises(nb.ManifestError) as caught:
        nb.load_manifest(old)
    assert "v3" in str(caught.value)
    assert "bundle_version 1" in str(caught.value)


def test_member_count_must_equal_the_members(manifest):
    broken = copy.deepcopy(manifest)
    broken["member_count"] += 1
    with pytest.raises(nb.ManifestError):
        nb.load_manifest(broken)


def test_a_written_bundle_never_carries_a_refusal(manifest):
    broken = copy.deepcopy(manifest)
    broken["coverage"]["refusals"] = [{"code": "R2_UNCLASSIFIED"}]
    with pytest.raises(nb.ManifestError):
        nb.load_manifest(broken)


def test_every_exclusion_carries_a_reason(manifest):
    assert manifest["excluded"], "excluded is MANDATORY and never empty-by-omission"
    for row in manifest["excluded"]:
        assert row["reason"].strip()
    broken = copy.deepcopy(manifest)
    broken["excluded"][0]["reason"] = "   "
    with pytest.raises(nb.ManifestError):
        nb.load_manifest(broken)


def test_the_selftest_name_matches_the_pattern_asserted_before_every_drop(manifest):
    broken = copy.deepcopy(manifest)
    broken["databases"][0]["selftest"]["scratch_db"] = "nova_verify_a1b2c3d4"
    with pytest.raises(nb.ManifestError):
        nb.load_manifest(broken)


def test_a_self_test_that_was_not_equal_is_not_a_written_bundle(manifest):
    broken = copy.deepcopy(manifest)
    broken["databases"][0]["selftest"]["equal"] = False
    with pytest.raises(nb.ManifestError):
        nb.load_manifest(broken)


def test_an_unknown_restore_to_form_refuses(manifest):
    broken = copy.deepcopy(manifest)
    broken["members"][0]["restore_to"] = "/etc/passwd"
    with pytest.raises(nb.ManifestError):
        nb.load_manifest(broken)


def test_an_unknown_session_guc_refuses(manifest):
    """A digest measured under a frame this reader does not know is not
    comparable — measurement-frames-outlive-their-code."""
    broken = copy.deepcopy(manifest)
    broken["session"]["client_encoding"] = "UTF8"
    with pytest.raises(nb.ManifestError):
        nb.load_manifest(broken)


def test_the_six_pinned_gucs_are_the_six(manifest):
    assert sorted(manifest["session"]) == sorted(nb.SESSION_GUCS)


# ── what a manifest must never carry ────────────────────────────────────────


def _values(node):
    if isinstance(node, dict):
        for value in node.values():
            yield from _values(value)
    elif isinstance(node, list):
        for item in node:
            yield from _values(item)
    else:
        yield node


def test_no_value_anywhere_equals_a_value_in_the_carried_env(tmp_path, manifest):
    """The manifest names the key set; the values live in env/carried.env,
    inside the ciphertext. A value that leaked into the manifest would be
    inside the ciphertext too — but it would also be in every listing, every
    drill report and every paste of a manifest into a bug report."""
    stage = make_stage(tmp_path)
    secrets = set()
    for line in (stage / "inner" / "env" / "carried.env").read_text().splitlines():
        if "=" in line:
            secrets.add(line.split("=", 1)[1])
    assert secrets
    leaked = [v for v in _values(manifest) if isinstance(v, str) and v in secrets]
    assert not leaked, f"the manifest carries {leaked}, which are .env VALUES"


def test_env_keys_holds_names_only(manifest):
    assert manifest["env_keys"] == ["POSTGRES_PASSWORD", "CORE_TOKEN"]
    for key in manifest["env_keys"]:
        assert "=" not in key


def test_the_signing_key_fingerprint_is_a_digest_and_not_the_key(manifest):
    value = manifest["identity"]["core_signing_key_sha256"]
    assert value is None or (len(value) == 64 and int(value, 16) >= 0)
    ok = copy.deepcopy(manifest)
    ok["identity"]["core_signing_key_sha256"] = None
    assert nb.load_manifest(ok), "no device has ever paired is legitimate, and is null"
    broken = copy.deepcopy(manifest)
    broken["identity"]["core_signing_key_sha256"] = "302e020100300506032b657004220420" * 2 + "ff"
    with pytest.raises(nb.ManifestError):
        nb.load_manifest(broken)


def test_the_raw_passphrase_digest_lives_only_inside_the_manifest(manifest):
    """sha256(passphrase)[:12] is kept ONLY here, behind the thing it
    identifies. §7.4: in cleartext it would let an attacker holding the
    bundle test candidates at one unsalted hash each."""
    assert manifest["encryption"]["passphrase_sha256_12"] == nb.passphrase_sha256_12(PASSPHRASE)


# ── the base fact the shell renders ─────────────────────────────────────────


def test_a_base_missing_a_key_refuses_by_name(tmp_path):
    stage = make_stage(tmp_path)
    base = copy.deepcopy(BASE)
    del base["identity"]
    with pytest.raises(nb.ManifestError) as caught:
        plan(stage, base=base)
    assert "identity" in str(caught.value)


def test_a_base_carrying_an_unknown_key_refuses_by_name(tmp_path):
    stage = make_stage(tmp_path)
    base = copy.deepcopy(BASE)
    base["skip_verification"] = True
    with pytest.raises(nb.ManifestError) as caught:
        plan(stage, base=base)
    assert "skip_verification" in str(caught.value)


def test_a_carried_volume_with_no_staged_tree_refuses(tmp_path):
    import shutil

    stage = make_stage(tmp_path)
    shutil.rmtree(stage / "inner" / "volumes" / "v4_memdata")
    with pytest.raises(nb.BundleError) as caught:
        plan(stage)
    assert "v4_memdata" in str(caught.value)


def test_the_manifest_round_trips_through_json(manifest):
    assert nb.load_manifest_text(nb.dump_manifest(manifest)) == manifest
    assert json.loads(nb.dump_manifest(manifest)) == manifest
