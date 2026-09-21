"""The RAW compose text, parsed by the same YAML parser compose uses on it.

design-verdict.md §6.1: the DECLARED set comes from the raw text and can come
from nowhere else, because compose PRUNES a volume no rendered service mounts
out of every render. The dispositions still come from the YAML render
(`config --format json` strips every nested `x-` key). This file is about the
first half only — the parser, not the source.

Until 2026-09-21 that parser was hand-written in POSIX awk in
deploy/compose_read.sh. Four fix rounds produced six defects in it, each one a
real bind that a real `docker compose config` resolves and the reader did not
see, each in a different place. s41/rulings.md moved the parse to PyYAML, here,
where the pack container already is.

EVERY case below was measured against real `docker compose` v5.3.0 over a
throwaway file first (s41/measurements.md R8) — what compose ACCEPTS and what
it RESOLVES each spelling to. The tests then say the reader agrees with that
measurement. Nothing here is a guess about YAML or about compose.

The awk reader's answer for each case is in R8's table too: eight of these
produced NO ROW AT ALL — a silent skip in the one mechanism whose whole purpose
is to refuse rather than skip.
"""

import json
import pathlib
import re

import pytest
from conftest import COMPOSE_FILE, FIXTURES

from novabundle import (
    load_facts,
    raw_compose_fact,
    raw_compose_rows,
)

HEAD = "name: nova\nservices:\n  a:\n    image: alpine\n"


def rows_of(text, where="probe.yml"):
    """{(kind, service, name): (disposition, has_reason)} for one document."""
    out = {}
    for row in raw_compose_rows(text, where):
        out[(row["kind"], row["service"], row["name"])] = (
            row["disposition"],
            bool(row["reason"]),
        )
    return out


def binds(text):
    return {name for (kind, _, name) in rows_of(text) if kind == "bind"}


def cannots(text):
    return [k for k in rows_of(text) if k[0] == "unreadable"]


# ── the item spellings, each measured through real compose ──────────────────


def test_short_syntax_is_a_bind():
    """measured: `- ../x:/A` -> type bind, source /tmp/x."""
    assert binds(HEAD + "    volumes:\n      - ../x:/A\n") == {"/A"}


def test_block_long_syntax_is_a_bind_and_carries_its_disposition():
    """measured: `- type: bind` + source/target -> type bind."""
    text = HEAD + (
        "    volumes:\n"
        "      - type: bind\n"
        "        source: ../x\n"
        "        target: /B\n"
        "        x-nova-backup: exclude-code\n"
        "        x-nova-backup-reason: in git\n"
    )
    assert rows_of(text)[("bind", "a", "/B")] == ("exclude-code", True)


def test_a_single_line_flow_mapping_is_a_bind():
    """measured: `- {type: bind, source: ../x, target: /C}` -> type bind."""
    assert binds(HEAD + "    volumes:\n      - {type: bind, source: ../x, target: /C}\n") == {"/C"}


def test_a_flow_mapping_may_span_lines():
    """measured: the same item wrapped over three lines -> type bind."""
    text = (
        HEAD + "    volumes:\n      - {type: bind,\n         source: ../x,\n         target: /D}\n"
    )
    assert binds(text) == {"/D"}


def test_a_flow_sequence_is_read_not_refused():
    """measured: `volumes: [ "named:/E1", {type: bind, …} ]` -> one volume
    mount and one bind. The awk reader called the whole line `unreadable` —
    an honest cannot, but the items were still invisible."""
    text = (
        HEAD + '    volumes: [ "named:/E1", {type: bind, source: ../x, target: /E2} ]\n'
        "volumes:\n  named:\n"
    )
    rows = rows_of(text)
    assert binds(text) == {"/E2"}
    assert ("bind", "a", "/E1") not in rows
    assert not cannots(text)


def test_a_flow_sequence_on_the_following_line_is_read_too():
    """measured: legal compose, and the awk reader saw NOTHING at 8 spaces —
    the case its `unreadable` rule was added for, in the one spelling that
    rule could not reach."""
    text = HEAD + '    volumes:\n        [ "named:/E1", "../x:/E2" ]\nvolumes:\n  named:\n'
    assert binds(text) == {"/E2"}
    assert not cannots(text)


@pytest.mark.parametrize("indent", ["    ", "      ", "        "])
def test_list_items_at_any_legal_indentation(indent):
    """measured: a block sequence under `volumes:` may be indented 4, 6 or 8
    spaces and compose resolves all three identically. The awk reader matched
    `^      - ` literally and saw nothing at 4 or at 8."""
    assert binds(HEAD + f"    volumes:\n{indent}- ../x:/F\n") == {"/F"}


def test_a_whole_mount_spec_in_one_variable_is_a_stated_cannot():
    """measured: `- ${MOUNTSPEC}` with MOUNTSPEC=../whole:/H resolves to a
    real bind. Nothing in the raw text can say so — not even the target — so
    this is the case that must be SAID, not skipped. The awk reader's
    colon-less branch swallowed it as an anonymous volume."""
    text = HEAD + "    volumes:\n      - ${MOUNTSPEC}\n"
    assert cannots(text), "an item whose whole spec is a variable must be stated"
    assert not binds(text)
    assert "${MOUNTSPEC}" in cannots(text)[0][2]


def test_an_unbalanced_brace_in_a_quoted_reason_does_not_swallow_the_list():
    """The round-3 regression, measured: compose renders all three binds. The
    awk brace-depth scan never returned to zero, so the flow item AND every
    following item in the list vanished — a correctly written bind made
    invisible by a brace in a prose string."""
    text = HEAD + (
        "    volumes:\n"
        "      - {type: bind, source: ../x, target: /I1,\n"
        '         x-nova-backup: exclude-code, x-nova-backup-reason: "a { brace"}\n'
        "      - ../y:/I2\n"
        "      - ../z:/I3\n"
    )
    assert binds(text) == {"/I1", "/I2", "/I3"}
    assert rows_of(text)[("bind", "a", "/I1")] == ("exclude-code", True)


def test_a_brace_in_a_trailing_comment_does_not_swallow_the_list():
    """The same regression, second spelling: measured, compose renders both."""
    text = HEAD + (
        "    volumes:\n"
        "      - {type: bind, source: ../x, target: /J1}  # a { comment\n"
        "      - ../y:/J2\n"
    )
    assert binds(text) == {"/J1", "/J2"}


def test_anchors_and_aliases_are_read():
    """measured: compose resolves an aliased mount list. The awk reader had no
    notion of an anchor at all and called `volumes: *m` unreadable."""
    text = (
        "name: nova\n"
        "x-mounts: &m\n"
        "  - ../x:/K1\n"
        "  - type: bind\n"
        "    source: ../y\n"
        "    target: /K2\n"
        "services:\n  a:\n    image: alpine\n    volumes: *m\n"
    )
    assert binds(text) == {"/K1", "/K2"}


def test_a_merge_key_is_read():
    """measured: `<<: *base` gives the service the base's mounts, and compose
    renders the bind. The awk reader saw nothing."""
    text = (
        "name: nova\n"
        "x-base: &base\n"
        "  image: alpine\n"
        "  volumes:\n"
        "    - ../x:/K3\n"
        "services:\n  a:\n    <<: *base\n"
    )
    assert binds(text) == {"/K3"}


# ── the other direction: a named volume is never a bind ─────────────────────


@pytest.mark.parametrize(
    "item,target",
    [
        ("named:/L1", "/L1"),
        ("named:/L2:ro", "/L2"),
        ("{type: volume, source: named, target: /M}", "/M"),
    ],
)
def test_a_named_volume_is_never_reported_as_a_bind(item, target):
    """measured: all three resolve to type volume. Reporting one as an
    undeclared bind would refuse a correct backup — the false red that teaches
    people to route around a tripwire."""
    text = HEAD + f"    volumes:\n      - {item}\nvolumes:\n  named:\n"
    rows = rows_of(text)
    assert ("bind", "a", target) not in rows
    assert ("interp", "a", target) not in rows
    assert ("volume", "", "named") in rows


def test_an_inline_anonymous_volume_is_not_a_bind():
    """measured: `- /var/lib/anon` with no colon resolves to an ANONYMOUS
    volume (type volume, no source), not a bind. Its only name is in
    containers.json, where an undeclared one is refused R2."""
    text = HEAD + "    volumes:\n      - /var/lib/anon\n"
    assert not binds(text)
    assert not cannots(text)


def test_a_source_with_a_slash_in_it_is_a_bind():
    """measured twice: a volume KEY may not contain `/` (compose rejects
    `volumes: {sub/dir: {}}` outright), so a source that holds one can only
    ever be a path."""
    assert binds(HEAD + "    volumes:\n      - ${D}/sub:/U\n") == {"/U"}


# ── interpolation: reconciled, never guessed and never forbidden ────────────


def test_a_wholly_interpolated_source_is_undecidable():
    """measured BOTH ways: `${VOLNAME}:/P` is a named volume when VOLNAME
    holds a name and a bind when it holds a path. The raw text cannot know.
    Guessing `bind` reddens a correct file; guessing `volume` hides an
    undeclared one; `interp` is the third honest answer, and the render
    settles it."""
    rows = rows_of(HEAD + "    volumes:\n      - ${VOLNAME}:/P\n")
    assert ("interp", "a", "/P") in rows
    assert ("bind", "a", "/P") not in rows


@pytest.mark.parametrize("item", ["$DIR:/t", "${NOPE:-../fallback}:/t"])
def test_every_interpolation_spelling_is_undecidable(item):
    """measured: compose expands `$DIR` and `${VAR:-default}` alike."""
    assert ("interp", "a", "/t") in rows_of(HEAD + f"    volumes:\n      - {item}\n")


def test_an_interpolated_target_is_a_stated_cannot():
    """measured: `- ../x:$TGT` is a real bind, and the TARGET is the key every
    row is compared by. The awk reader emitted a row keyed by the literal
    `$TGT`, which matches nothing in any render."""
    text = HEAD + "    volumes:\n      - ../x:$TGT\n"
    assert cannots(text)
    assert ("bind", "a", "$TGT") not in rows_of(text)


# ── what the parser genuinely cannot decide, it says ────────────────────────


def test_long_syntax_without_a_type_is_a_stated_cannot():
    """measured: compose REJECTS it — `services.a.volumes.0 must be a string`
    — so there is no resolved mount to agree with and no kind to infer."""
    text = HEAD + "    volumes:\n      - source: ../x\n        target: /O\n"
    assert cannots(text)


def test_a_volumes_block_that_is_not_a_list_is_a_stated_cannot():
    """measured: compose rejects both (`services.a.volumes must be a array`)."""
    assert cannots(HEAD + "    volumes:\n")
    assert cannots(HEAD + "    volumes:\n      /t: ../x\n")


def test_an_empty_mount_list_is_not_a_refusal():
    """The other half of a control that must not cry wolf: `volumes: []` is
    legal, measured, and means no mounts. The awk reader called it unreadable,
    which is a red on a correct file."""
    assert not cannots(HEAD + "    volumes: []\n")


def test_a_disposition_written_where_nothing_reads_it_is_a_stated_cannot():
    """There are exactly three places a disposition lives (§6.2). A row
    written anywhere else is read by nothing — not by this parser and not by
    the render — so it is stated rather than ignored."""
    text = HEAD + "    x-nova-backup: include\n    volumes:\n      - ../x:/t\n"
    bad = [k for k in cannots(text) if "x-nova-backup" in k[2]]
    assert bad, "a disposition on a service root is read by nothing"


@pytest.mark.parametrize(
    "text,why",
    [
        ("name: nova\nservices:\n  a:\n   image: x\n     bad: y\n", "invalid YAML"),
        ("name: nova\n---\nname: other\n", "more than one document"),
        ("- a\n- b\n", "not a mapping"),
        ("", "empty"),
    ],
)
def test_text_that_is_not_one_compose_document_is_a_stated_refusal(text, why):
    """A parse that fails is a REFUSAL with the parser's own words in it, not
    an empty result that reads as `this file declares nothing`."""
    with pytest.raises(ValueError) as excinfo:
        raw_compose_rows(text, "probe.yml")
    assert "probe.yml" in str(excinfo.value), why


# ── the declared set, over every file in COMPOSE_FILE ───────────────────────

# The same probe pair deploy/backup_test.sh renders through real compose: a
# volume `vol_three` that no service mounts (PRUNED from both renders), and a
# second file carrying a service and a volume that exist only there — the
# shape the GPU overlay makes real.
BASE = (FIXTURES / "probe-compose.yml").read_text()
OVERLAY = (FIXTURES / "probe-compose.overlay.yml").read_text()


def test_the_declared_set_is_the_union_of_every_file():
    fact = raw_compose_fact([("base.yml", BASE), ("overlay.yml", OVERLAY)])
    assert fact["services"] == ["alpha", "beta"]
    assert fact["volumes"] == ["vol_one", "vol_three", "vol_two"]
    assert fact["compose_files"] == ["base.yml", "overlay.yml"]


def test_a_volume_no_service_mounts_is_still_declared():
    """The whole reason this side reads the raw text: compose PRUNES
    `vol_three` out of `config`, out of `config --format json` and out of
    `config --volumes` alike, and a declared volume nothing mounts is the
    exact case coverage exists to catch."""
    assert "vol_three" in raw_compose_fact([("base.yml", BASE)])["volumes"]


def test_a_services_own_mount_list_is_not_a_declaration():
    """`- vol_one:/one` sits under a service. A reader keyed on the word
    `volumes` alone reports `/one` as a declared volume."""
    fact = raw_compose_fact([("base.yml", BASE)])
    assert fact["volumes"] == ["vol_one", "vol_three"]
    assert fact["services"] == ["alpha"]


def test_the_probe_pairs_dispositions_are_read_from_every_position():
    """The probe carries an `x-` key at each of the four positions one can
    occupy. All four are read from the raw text here; deploy/backup_test.sh
    pins what each RENDER does with them."""
    rows = {}
    for row in raw_compose_fact([("base.yml", BASE), ("overlay.yml", OVERLAY)])["rows"]:
        rows[(row["kind"], row["service"], row["name"])] = (row["disposition"], bool(row["reason"]))
    assert rows[("volume", "", "vol_one")] == ("include", True)
    assert rows[("volume", "", "vol_three")] == ("include", True)
    assert rows[("volume", "", "vol_two")] == ("exclude-ephemeral", True)
    assert rows[("bind", "alpha", "/b")] == ("exclude-code", True)
    assert rows[("anon", "alpha", "/var/cache/thing")] == ("exclude-ephemeral", True)
    assert ("bind", "alpha", "/one") not in rows
    assert not [k for k in rows if k[0] == "unreadable"]


def test_the_project_name_is_the_one_compose_would_use():
    """measured on compose v5.3.0, both orders: with `-f first -f second` the
    project is `second` — the LAST file that declares a name wins, and a file
    that declares none does not clear it. The awk reader took the FIRST, so a
    GPU overlay that named the project made every backup refuse R0."""
    first = ("first.yml", "name: first\nservices:\n  a:\n    image: alpine\n")
    second = ("second.yml", "name: second\nservices:\n  b:\n    image: alpine\n")
    nameless = ("third.yml", "services:\n  c:\n    image: alpine\n")
    assert raw_compose_fact([first, second])["project"] == "second"
    assert raw_compose_fact([second, first])["project"] == "first"
    assert raw_compose_fact([first, nameless])["project"] == "first"


# ── the three places a disposition lives (§6.2) ─────────────────────────────


def test_the_parser_reads_all_three_places_a_disposition_lives():
    text = """\
name: nova
services:
  a:
    image: alpine
    x-nova-backup-anon:
      /var/cache/x:
        disposition: exclude-ephemeral
        reason: a cache
    volumes:
      - type: bind
        source: ../src
        target: /bind
        x-nova-backup: exclude-code
        x-nova-backup-reason: in git
volumes:
  vol:
    x-nova-backup: include
    x-nova-backup-reason: the notes
"""
    rows = rows_of(text)
    assert rows[("volume", "", "vol")] == ("include", True)
    assert rows[("bind", "a", "/bind")] == ("exclude-code", True)
    assert rows[("anon", "a", "/var/cache/x")] == ("exclude-ephemeral", True)


def test_a_folded_reason_comes_back_as_its_whole_text():
    """`>-` is the form every reason in deploy/docker-compose.yml uses. Its
    text lives on the lines BELOW the key, so the awk reader could only ever
    report presence; the YAML parser returns the joined string."""
    text = (
        "name: nova\nvolumes:\n  vol:\n    x-nova-backup: include\n"
        "    x-nova-backup-reason: >-\n      the notes, which are\n      two lines\n"
    )
    row = next(r for r in raw_compose_rows(text, "p.yml") if r["kind"] == "volume")
    assert row["reason"] == "the notes, which are two lines"


# ── on the REAL file, not only on a probe ───────────────────────────────────

REAL_TEXT = COMPOSE_FILE.read_text()

# The splice point: the memory service's one mount line, found rather than
# typed. A literal line here is a test that goes red the day someone edits
# that line for an unrelated reason — a red on a correct file, which is the
# thing this whole mechanism must not do, even in its own tests.
_ANCHOR_RE = re.compile(r"^(?P<indent> +)- (?P<item>\S+:/data/memory)\n", re.M)
_ANCHOR_MATCH = _ANCHOR_RE.search(REAL_TEXT)
assert _ANCHOR_MATCH, (
    f"{COMPOSE_FILE} no longer mounts anything at /data/memory. These tests "
    "splice each mount spelling in beside that line; re-point _ANCHOR_RE at "
    "whichever mount line they should splice beside now."
)
ANCHOR = _ANCHOR_MATCH.group(0)
ITEM = _ANCHOR_MATCH.group("item")

# Every spelling, spliced into the real deploy/docker-compose.yml in place of
# the memory service's one mount line. Each REPLACEMENT was run through real
# `docker compose config` first (s41/measurements.md R8): compose accepts it
# and resolves the added bind. Each must then produce a correct row here —
# never silence. `expected` is the row the ADDED bind must come back as.
REAL_CASES = {
    "short": (ANCHOR + "      - ../newstate:/newstate\n", "/newstate"),
    "block": (
        ANCHOR + "      - type: bind\n        source: ../newstate\n        target: /newstate\n",
        "/newstate",
    ),
    "flow_one_line": (
        ANCHOR + "      - {type: bind, source: ../newstate, target: /newstate}\n",
        "/newstate",
    ),
    "flow_spanning": (
        ANCHOR
        + "      - {type: bind,\n         source: ../newstate,\n         target: /newstate}\n",
        "/newstate",
    ),
    "flow_sequence": (f'      [ "{ITEM}", "../newstate:/newstate" ]\n', "/newstate"),
    "four_spaces": (f"    - {ITEM}\n    - ../newstate:/newstate\n", "/newstate"),
    "eight_spaces": (f"        - {ITEM}\n        - ../newstate:/newstate\n", "/newstate"),
    "braced_reason": (
        ANCHOR + "      - {type: bind, source: ../newstate, target: /newstate,\n"
        '         x-nova-backup: exclude-code, x-nova-backup-reason: "a { brace"}\n'
        "      - ../after:/after\n",
        "/after",
    ),
    "braced_comment": (
        ANCHOR + "      - {type: bind, source: ../newstate, target: /newstate}  # a { comment\n"
        "      - ../after:/after\n",
        "/after",
    ),
}


@pytest.mark.parametrize("name", sorted(REAL_CASES))
def test_every_spelling_added_to_the_real_file_is_seen(name):
    """The end the operator meets. A bind added to deploy/docker-compose.yml
    in ANY spelling compose accepts must come back as a row with no
    disposition — which is what makes the next `./install backup` refuse R2
    instead of carrying an unclassified mount."""
    replacement, target = REAL_CASES[name]
    rows = rows_of(REAL_TEXT.replace(ANCHOR, replacement, 1), str(COMPOSE_FILE))
    assert ("bind", "memory", target) in rows, f"{name}: the added bind is invisible"
    assert rows[("bind", "memory", target)] == ("", False)
    # ...and the mount that was already there is still not read as a bind.
    assert ("volume", "", "v4_memdata") in rows
    assert ("bind", "memory", "/data/memory") not in rows


def test_a_whole_spec_variable_added_to_the_real_file_is_stated():
    """measured: `- ${MOUNTSPEC}` is a real bind. It cannot be read, so it is
    said — the difference between a cannot and a silent skip."""
    text = REAL_TEXT.replace(ANCHOR, ANCHOR + "      - ${MOUNTSPEC}\n", 1)
    assert [k for k in cannots(text) if k[1] == "memory"]


def test_the_real_file_itself_is_read_whole():
    """No case in deploy/docker-compose.yml is a cannot, and its declared set
    is the one the rest of the suite pins."""
    fact = raw_compose_fact([(str(COMPOSE_FILE), REAL_TEXT)])
    assert fact["project"] == "nova"
    assert fact["volumes"] == [
        "v4_memdata",
        "v4_models",
        "v4_ollama",
        "v4_pgdata",
        "v4_tailscale",
        "v4_workspace",
    ]
    assert [r for r in fact["rows"] if r["kind"] == "unreadable"] == []


# ── the fact on disk: what backup.sh stages, what load_facts reads ──────────


def test_load_facts_derives_the_raw_fact_from_the_staged_text(tmp_path):
    facts = tmp_path / "facts"
    (facts / "compose").mkdir(parents=True)
    (facts / "compose" / "000.yml").write_text(BASE)
    (facts / "compose" / "001.yml").write_text(OVERLAY)
    (facts / "compose" / "files.json").write_text(
        json.dumps(
            {
                "compose_files": [
                    {"source": "/repo/deploy/docker-compose.yml", "staged": "000.yml"},
                    {"source": "/repo/deploy/docker-compose.gpu.yml", "staged": "001.yml"},
                ]
            }
        )
    )
    raw = load_facts(str(facts))["raw"]
    assert raw["project"] == "novaxprobe"
    assert raw["volumes"] == ["vol_one", "vol_three", "vol_two"]
    assert raw["compose_files"] == [
        "/repo/deploy/docker-compose.yml",
        "/repo/deploy/docker-compose.gpu.yml",
    ]


def test_a_staged_file_that_does_not_parse_becomes_an_error_fact(tmp_path):
    """R0, not a crash and not an empty set: coverage collects every refusal
    in one run, so an unreadable compose file has to arrive as a fact that
    says so."""
    facts = tmp_path / "facts"
    (facts / "compose").mkdir(parents=True)
    (facts / "compose" / "000.yml").write_text("services:\n  a:\n   image: x\n     bad: y\n")
    (facts / "compose" / "files.json").write_text(
        json.dumps({"compose_files": [{"source": "/repo/x.yml", "staged": "000.yml"}]})
    )
    raw = load_facts(str(facts))["raw"]
    assert "error" in raw
    assert "/repo/x.yml" in raw["error"]


def test_a_missing_stage_is_a_missing_fact(tmp_path):
    facts = tmp_path / "facts"
    facts.mkdir()
    assert "raw" not in load_facts(str(facts))


# ── the interpreter this parser needs (s41/rulings.md 2026-09-21) ───────────


def test_pyyaml_is_in_the_core_images_runtime_closure():
    """novabundle.py runs inside the already-built core image, so `import
    yaml` there is load-bearing. The ruling cited services/core/pyproject.toml
    line 31 — which is in the DEV group, and the image is built with
    `uv sync --frozen --no-dev`. What actually puts PyYAML in the image is
    `uvicorn[standard]`, whose `standard` extra depends on it.

    That is a real dependency and it is locked, but it is not a stated one, so
    this is the line of code that goes red the day it stops being true —
    rather than the pack step failing on a machine at backup time.
    """
    core = pathlib.Path(__file__).resolve().parents[3] / "services" / "core"
    lock = (core / "uv.lock").read_text()
    runtime = re.search(
        r'^name = "uvicorn"$.*?^\[package\.optional-dependencies\]$\n^standard = \[$(.*?)^\]$',
        lock,
        re.S | re.M,
    )
    assert runtime, "services/core/uv.lock no longer locks uvicorn's `standard` extra"
    assert '{ name = "pyyaml" }' in runtime.group(1), (
        "uvicorn[standard] no longer pulls PyYAML into the core image's runtime "
        "closure, and novabundle.py imports yaml. Declare pyyaml in "
        "services/core/pyproject.toml's `dependencies` and re-lock."
    )
    # The RUNTIME table, not the file. The image is built with
    # `uv sync --frozen --no-dev`, so a `uvicorn[standard]` that has moved
    # into `[dependency-groups] dev`, or been commented out, puts nothing in
    # the image — and a whole-file substring check passes for both. Measured
    # 2026-09-21: commenting the line out of `[project] dependencies` left
    # the old assertion green.
    assert "uvicorn[standard]" in runtime_dependencies(core / "pyproject.toml"), (
        "services/core's [project] dependencies no longer asks for uvicorn's `standard` "
        "extra, so nothing puts PyYAML in the image novabundle.py runs in. (A dev-group "
        "entry does not count: the image is built with `uv sync --frozen --no-dev`.)"
    )


def runtime_dependencies(pyproject):
    """The `[project] dependencies` array, by name, ignoring comments.

    Hand-parsed rather than `tomllib`-parsed so this reads the same on any
    interpreter the suites run under, and so a commented-out line is visibly
    excluded rather than invisibly so.
    """
    names = []
    section = None
    in_deps = False
    for line in pyproject.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]") and "=" not in stripped:
            section, in_deps = stripped, False
            continue
        if section == "[project]" and re.match(r"^dependencies\s*=\s*\[", stripped):
            in_deps = True
            continue
        if in_deps:
            if stripped.startswith("]"):
                in_deps = False
                continue
            if stripped.startswith("#"):
                continue
            found = re.match(r'^"([^"]+)"', stripped)
            if found:
                names.append(found.group(1))
    return names


# ── a document this parser is not handed (task-1-rereview4.md section F) ────
#
# Compose's top-level `include:` merges another file's WHOLE document, its
# `volumes:` block included. That file is not in COMPOSE_FILE, so backup.sh
# never stages it and this parser never sees it; and a volume no rendered
# service mounts is pruned from every render, so the render side cannot see it
# either. Measured on compose v5.3.0 and on the shipped parser: a volume
# declared there, carrying `x-nova-backup: include`, produced NO refusal and
# NO row. That is the silent skip this module exists to prevent, so it is a
# stated cannot.

INCLUDING = """name: nova
include:
  - inc.yml
services:
  a:
    image: alpine
    volumes:
      - v4_pgdata:/d
volumes:
  v4_pgdata:
    x-nova-backup: dump-pg
    x-nova-backup-reason: db
"""


def test_a_top_level_include_is_a_stated_refusal_not_a_skip():
    with pytest.raises(Exception) as caught:
        raw_compose_fact([("main.yml", INCLUDING)])
    assert "include" in str(caught.value)
    assert "inc.yml" in str(caught.value)
    assert "COMPOSE_FILE" in str(caught.value)


def test_the_include_refusal_reaches_coverage_as_a_fact_error(tmp_path):
    """Not an exception the run dies on: R0, beside every other refusal, so
    one run names them all."""
    stage = tmp_path / "facts" / "compose"
    stage.mkdir(parents=True)
    (stage / "0.yml").write_text(INCLUDING)
    (stage / "files.json").write_text(
        json.dumps({"files": [{"path": "/repo/deploy/docker-compose.yml", "staged": "0.yml"}]})
    )
    facts = load_facts(str(tmp_path / "facts"))
    assert "include" in facts["raw"]["error"]


@pytest.mark.parametrize(
    "spelling",
    [
        "include:\n  - inc.yml\n",
        "include:\n  - path: inc.yml\n",
        "include:\n  - path:\n      - inc.yml\n      - over.yml\n",
        "include: inc.yml\n",
    ],
)
def test_every_include_spelling_is_refused(spelling):
    with pytest.raises(Exception) as caught:
        raw_compose_rows("name: nova\n" + spelling + HEAD.split("\n", 1)[1], "main.yml")
    assert "inc.yml" in str(caught.value)


def test_a_service_extending_a_file_this_reader_is_not_handed_is_refused():
    """`extends: file:` cannot bring a top-level volume, but it can bring a
    BIND this text does not show — same shape, same answer."""
    text = "name: nova\nservices:\n  a:\n    extends:\n      file: other.yml\n      service: b\n"
    with pytest.raises(Exception) as caught:
        raw_compose_rows(text, "main.yml")
    assert "other.yml" in str(caught.value)


def test_extends_within_this_file_is_not_refused():
    text = (
        "name: nova\n"
        "services:\n"
        "  base:\n    image: alpine\n    volumes:\n      - ../x:/N\n"
        "  a:\n    extends:\n      service: base\n"
    )
    assert binds(text) == {"/N"}


def test_the_v4_compose_file_uses_neither_key():
    doc = COMPOSE_FILE.read_text()
    assert "\ninclude:" not in doc
    assert "extends:" not in doc
