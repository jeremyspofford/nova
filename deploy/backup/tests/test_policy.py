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


def _rows(text):
    """{(kind, owner, name): (disposition, has_reason)} — the shape both the
    raw file and the render are reduced to, so they can be compared."""
    out = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        kind, owner, name, disposition, reason = line.split("\t")
        out[(kind, owner, name)] = (disposition, reason == "yes")
    return out


def raw_rows_all():
    """Every row raw_dispositions emits for the real file, `interp` and
    `unreadable` included."""
    return _rows(compose_read("raw_dispositions", COMPOSE_FILE.read_text()))


def raw_rows():
    """Every disposition deploy/docker-compose.yml ITSELF declares.

    This is the only reader in the suite that looks at the file a human edits;
    everything else reads the checked-in render, which is a capture. Deleting
    a row from the real file and leaving the capture alone has to be loud.

    `interp` and `unreadable` rows are left out of the SET comparison: the
    first is a mount whose kind only the render can settle, and the second is
    a stated cannot. Each has its own test below, so leaving them out here
    drops nothing on the floor.
    """
    return {k: v for k, v in raw_rows_all().items() if k[0] in ("volume", "bind", "anon")}


def rendered_rows():
    """The same set, as the checked-in render shows it."""
    text = RENDER.read_text()
    out = {}
    for key in compose_read("cfg_volume_keys", text).split():
        line = compose_read(f'cfg_volume_disposition "{key}"', text).rstrip("\n")
        disposition, _, reason = line.partition("\t")
        out[("volume", "", key)] = (disposition, bool(reason.strip()))
    for svc in compose_read("cfg_service_keys", text).split():
        for line in compose_read(f'cfg_mounts "{svc}"', text).splitlines():
            parts = line.split("\t")
            if len(parts) < 6 or parts[0] != "bind":
                continue
            out[("bind", svc, parts[2])] = (parts[4], bool(parts[5].strip()))
        for line in compose_read(f'cfg_anon "{svc}"', text).splitlines():
            target, _, rest = line.partition("\t")
            disposition, _, reason = rest.partition("\t")
            out[("anon", svc, target)] = (disposition, bool(reason.strip()))
    return out


def raw_service_keys():
    return compose_read("raw_service_keys", COMPOSE_FILE.read_text()).split()


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


def test_the_render_declares_exactly_what_the_file_declares():
    """The tripwire the rest of the suite hangs off.

    Every other disposition assertion reads the checked-in render. That render
    is a capture, so on its own it says nothing about the file the operator
    edits: deleting searxng's x-nova-backup-anon block, or v4_memdata's two
    rows, or the ../searxng bind's two rows, left this whole suite green while
    the next real backup refused R2. Compared in both directions, the same
    edit is red before it is committed — and so is a fixture nobody refreshed.
    """
    raw, rendered = raw_rows(), rendered_rows()
    only_in_file = {k: raw[k] for k in raw if k not in rendered}
    only_in_render = {k: rendered[k] for k in rendered if k not in raw}
    differing = {k: (raw[k], rendered[k]) for k in raw if k in rendered and raw[k] != rendered[k]}
    assert not (only_in_file or only_in_render or differing), (
        f"{COMPOSE_FILE} and {RENDER.name} disagree.\n"
        f"  only in the file:   {only_in_file}\n"
        f"  only in the render: {only_in_render}\n"
        f"  different:          {differing}\n"
        "Run deploy/backup/fixtures/refresh.sh, in the same commit as the edit."
    )


def test_every_volume_the_file_declares_has_a_disposition():
    missing = sorted(
        name
        for (kind, _, name), (disposition, _) in raw_rows().items()
        if kind == "volume" and not disposition
    )
    assert not missing, (
        f"{missing} are declared under `volumes:` in {COMPOSE_FILE.name} with no "
        "x-nova-backup row. Adding one here is what stops the operator meeting "
        "R2_UNCLASSIFIED at backup time instead."
    )


def test_every_disposition_names_a_volume_the_file_declares():
    declared = set(raw_volume_keys())
    extra = sorted(
        name for (kind, _, name) in raw_rows() if kind == "volume" and name not in declared
    )
    assert not extra, f"{extra} carry an x-nova-backup row and are declared nowhere."


def test_every_disposition_in_the_file_is_one_of_the_eight():
    for (kind, owner, name), (disposition, _) in raw_rows().items():
        assert disposition in DISPOSITIONS, f"{kind} {owner} {name}: {disposition!r}"


def test_every_exclude_in_the_file_carries_a_reason():
    for (kind, owner, name), (disposition, has_reason) in raw_rows().items():
        if disposition.startswith("exclude-"):
            assert has_reason, f"{kind} {owner} {name} is {disposition} with no reason"


def test_the_file_declares_every_bind_it_mounts():
    binds = {k: v for k, v in raw_rows().items() if k[0] == "bind"}
    assert binds, f"{COMPOSE_FILE.name} declares no bind at all, which is not this file"
    undeclared = sorted(f"{owner} at {name}" for (_, owner, name), (d, _) in binds.items() if not d)
    assert not undeclared, (
        f"{undeclared} are long-syntax binds with no x-nova-backup row. A bind with no "
        "disposition refuses every backup."
    )


def test_the_file_declares_every_anon_row_it_opens():
    anon = {k: v for k, v in raw_rows().items() if k[0] == "anon"}
    assert anon, (
        "no service carries an x-nova-backup-anon row. searxng's image declares "
        "/etc/searxng and /var/cache/searxng, and the second is live on this "
        "machine as an anonymous volume — without a row, every backup refuses."
    )
    for (_, owner, name), (disposition, has_reason) in anon.items():
        assert disposition, f"{owner} at {name} opens an anon row and declares nothing"
        assert has_reason, f"{owner} at {name} has no reason"


def test_searxng_declares_the_anonymous_volume_that_is_live_on_this_machine():
    """port-v3 C2. It exists ONLY in `docker inspect` output: compose never
    names an image-declared volume, so it has no entry under `volumes:`."""
    assert ("anon", "searxng", "/var/cache/searxng") in raw_rows()


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
    for (kind, _, name), (disposition, _) in raw_rows().items():
        if kind == "volume":
            by_disposition.setdefault(disposition, []).append(name)
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


# ── NF-2: both spellings of a bind, not just the one the file happens to use ─
#
# F1 closed "a disposition deleted from the real file". It did not close "a
# bind ADDED to the real file in short syntax": compose resolves
# `- ../newstate:/newstate` to exactly the same mount as the long form, with
# no x-nova-backup row, and the next real backup refuses R2 — while both
# suites stayed green. The compose file's own header says only the long form
# can carry the rows; that was a convention nothing enforced.

SHORT_BIND = """\
name: nova
services:
  memory:
    image: nova-memory
    volumes:
      - v4_memdata:/data/memory
      - ../newstate:/newstate
      - /etc/localtime:/etc/localtime:ro
      - ~/somewhere:/home-relative
      - ${SOME_DIR}/x:/interpolated
volumes:
  v4_memdata:
    x-nova-backup: include
    x-nova-backup-reason: the notes
"""


def short_bind_rows():
    return _rows(compose_read("raw_dispositions", SHORT_BIND))


def test_raw_dispositions_reports_a_short_syntax_bind_as_undeclared():
    rows = short_bind_rows()
    assert ("bind", "memory", "/newstate") in rows
    assert rows[("bind", "memory", "/newstate")] == ("", False)


def test_raw_dispositions_reports_every_spelling_of_a_host_path():
    """compose's own rule: a short-syntax source is a bind when it starts with
    `.`, `/`, `~` or `$`, and a named volume otherwise."""
    rows = short_bind_rows()
    for target in ("/newstate", "/etc/localtime", "/home-relative", "/interpolated"):
        assert ("bind", "memory", target) in rows, target


def test_raw_dispositions_does_not_call_a_named_volume_a_bind():
    """The other direction, and the reason this cannot just match every short
    mount: `- v4_memdata:/data/memory` is a named volume, it carries its
    disposition under `volumes:`, and reporting it as an undeclared bind would
    refuse every backup."""
    rows = short_bind_rows()
    assert ("bind", "memory", "/data/memory") not in rows
    assert ("volume", "", "v4_memdata") in rows


def test_a_short_syntax_bind_added_to_the_real_file_would_be_caught():
    """The end the operator meets: whichever spelling is used, the
    'every bind is declared' test is what fires."""
    rows = short_bind_rows()
    undeclared = sorted(
        name for (kind, _, name), (d, _) in rows.items() if kind == "bind" and not d
    )
    assert undeclared == ["/etc/localtime", "/home-relative", "/interpolated", "/newstate"]


# ── NF-3: the fix the product prints must be a fix the product accepts ──────


def test_pasting_the_anon_fix_the_product_prints_produces_a_file_it_can_read():
    """Not "the text looks right" — the text is taken from the refusal, an
    operator's two substitutions are applied to it, it is spliced into a real
    copy of deploy/docker-compose.yml, and the shipped reader is run over the
    result. Before this, that produced a correct compose file that reddened
    three tests, which is exactly what teaches people to route around a
    tripwire.
    """
    from test_coverage import base_facts

    from novabundle import coverage

    facts = base_facts()
    del facts["dispositions"]["anon"]["searxng"]
    _, refusals = coverage(facts, "routine")
    fix = next(r for r in refusals if "anonymous volume" in r.subject).fix

    # What an operator does with it: take the YAML under the "fix:" line,
    # de-indent it, and fill in the two placeholders.
    block = [line for line in fix.splitlines() if line.strip()][1:]
    margin = min(len(line) - len(line.lstrip()) for line in block)
    pasted = "\n".join("    " + line[margin:] for line in block)
    pasted = pasted.replace("<one of the eight>", "exclude-ephemeral")
    pasted = pasted.replace('"<why>"', '"a search result cache"')

    # Start from the file as it is WHEN the refusal fires: the anon block is
    # the thing that is missing. Leaving the real one in place would let its
    # declared rows mask the pasted ones.
    stripped, dropping = [], False
    for line in COMPOSE_FILE.read_text().splitlines(keepends=True):
        if line.startswith("    x-nova-backup-anon:"):
            dropping = True
            continue
        if dropping:
            if line.strip() and len(line) - len(line.lstrip()) <= 4:
                dropping = False
            else:
                continue
        stripped.append(line)
    without_anon = "".join(stripped)
    assert "x-nova-backup-anon" not in without_anon
    assert ("anon", "searxng", "/var/cache/searxng") not in _rows(
        compose_read("raw_dispositions", without_anon)
    )

    patched = without_anon.replace("  searxng:\n", "  searxng:\n" + pasted + "\n", 1)
    rows = _rows(compose_read("raw_dispositions", patched))

    assert rows[("anon", "searxng", "/var/cache/searxng")] == ("exclude-ephemeral", True)
    # ...and every rule test_policy applies to the real file holds for it.
    # Over the same kinds raw_rows() compares: an `interp` row carries no
    # disposition by construction and an `unreadable` row is a stated cannot,
    # so asserting "declared" over those would fail on a correct file.
    rows = {k: v for k, v in rows.items() if k[0] in ("volume", "bind", "anon")}
    for (kind, owner, name), (disposition, has_reason) in rows.items():
        assert disposition, f"{kind} {owner} {name} came back undeclared after the paste"
        assert disposition in DISPOSITIONS, f"{kind} {owner} {name}: {disposition!r}"
        if disposition.startswith("exclude-"):
            assert has_reason, f"{kind} {owner} {name} is {disposition} with no reason"


# ── The mount grammar, enumerated against real compose rather than guessed ──
#
# Measured with `docker compose config` (v5.3.0) over a throwaway file
# carrying every spelling, because "both spellings" turned out to be three and
# guessing a fourth is how this goes round again. What compose accepts under a
# service's `volumes:`:
#
#   the LIST may be a block sequence (`- …` lines) or a FLOW sequence
#   (`volumes: [ … ]`), and each ITEM may be
#     1. a scalar          `- name:/t`, `- ./src:/t`, `- /abs:/t:ro`, `- /abs`
#     2. a block mapping   `- type: bind` + `source:`/`target:` beneath
#     3. a flow mapping    `- {type: bind, source: ./src, target: /t}`
#
# and an item's SOURCE is a bind, after interpolation, when it starts with
# `.`, `/` or `~`, or contains `/` anywhere; otherwise it is a named volume.
# Measured, each one:
#     named_one:/t            -> volume        ./src:/t        -> bind
#     /etc/hostname:/t        -> bind          ~/x:/t          -> bind
#     .hidden:/t              -> bind          named:/t:ro     -> volume
#     ${VOLNAME}:/t           -> VOLUME        ${DIR}/sub:/t   -> bind
#     /var/lib/x  (no colon)  -> ANONYMOUS volume, not a bind
#
# Two of those are undecidable from the raw text and are handled as such:
# a wholly-interpolated source (`${VOLNAME}:/t` can be either, measured both
# ways) is reported `interp` and reconciled against the render; a flow
# SEQUENCE is reported `unreadable`, a stated cannot rather than a silent skip.

GRAMMAR = """\
name: nova
services:
  a:
    image: alpine
    volumes:
      - named_one:/short-named
      - ./src:/short-rel
      - /etc/hostname:/short-abs
      - .hidden:/short-dot
      - named_two:/short-mode:ro
      - /var/lib/anon-inline
      - ${VOLNAME}:/interp-whole
      - ${DIRNAME}/sub:/interp-prefix
      - {type: bind, source: ../flowsrc, target: /flow-map}
      - {type: volume, source: named_three, target: /flow-vol}
      - {type: bind, source: ../flowdecl, target: /flow-declared,
         x-nova-backup: exclude-code, x-nova-backup-reason: "in git"}
      - type: bind
        source: ../blocksrc
        target: /block-map
volumes:
  named_one:
  named_two:
  named_three:
"""


def grammar_rows():
    return _rows(compose_read("raw_dispositions", GRAMMAR))


def test_the_reader_reports_every_bind_spelling_compose_accepts():
    rows = grammar_rows()
    binds = {name for (kind, _, name) in rows if kind == "bind"}
    assert binds == {
        "/short-rel",
        "/short-abs",
        "/short-dot",
        "/interp-prefix",
        "/flow-map",
        "/flow-declared",
        "/block-map",
    }


def test_a_flow_mapping_item_carries_its_disposition_like_any_other():
    """New 2: `- {type: bind, …}` is a third spelling, and it produced no row
    at all — a bind added that way to the real file left both suites green."""
    rows = grammar_rows()
    assert rows[("bind", "a", "/flow-map")] == ("", False)
    assert rows[("bind", "a", "/flow-declared")] == ("exclude-code", True)


def test_a_wholly_interpolated_source_is_reported_undecidable_not_guessed():
    """New 3: compose applies the bind rule AFTER interpolation, so
    `${VOLNAME}:/t` is a named volume when VOLNAME is a name and a bind when
    it is a path — measured both ways. Calling it a bind is a false RED on a
    correct file, which is what teaches people to route around a tripwire."""
    rows = grammar_rows()
    assert ("bind", "a", "/interp-whole") not in rows
    assert rows[("interp", "a", "/interp-whole")] == ("", False)
    # ...while an interpolation with a literal `/` in it IS decidable.
    assert ("bind", "a", "/interp-prefix") in rows


def test_a_named_volume_is_never_reported_as_a_bind():
    rows = grammar_rows()
    for target in ("/short-named", "/short-mode", "/flow-vol"):
        assert ("bind", "a", target) not in rows, target
        assert ("interp", "a", target) not in rows, target


def test_an_inline_anonymous_volume_is_not_a_bind():
    """`- /var/lib/x` with no colon is an ANONYMOUS VOLUME, measured. It is
    seen live through containers.json and refused R2 there, which is the only
    place its name exists."""
    rows = grammar_rows()
    assert not [k for k in rows if k[2] == "/var/lib/anon-inline"]


FLOW_SEQUENCE = """\
name: nova
services:
  a:
    image: alpine
    volumes: [ "named_one:/one", {type: bind, source: ../two, target: /two} ]
volumes:
  named_one:
"""

FLOW_SEQUENCE_NEXT_LINE = """\
name: nova
services:
  a:
    image: alpine
    volumes:
      [ "named_one:/one" ]
volumes:
  named_one:
"""


def test_a_list_form_this_reader_cannot_read_is_a_stated_cannot():
    """A flow SEQUENCE is legal compose and this reader does not parse it.
    Saying so out loud is the difference between a cannot and a silent skip:
    every item in it would otherwise be invisible, which is the New 2 defect
    with a bigger blast radius."""
    for text in (FLOW_SEQUENCE, FLOW_SEQUENCE_NEXT_LINE):
        rows = _rows(compose_read("raw_dispositions", text))
        assert [k for k in rows if k[0] == "unreadable"], text


def test_the_real_compose_file_uses_no_form_the_reader_cannot_read():
    bad = [f"{owner}: {name}" for (kind, owner, name) in raw_rows_all() if kind == "unreadable"]
    assert not bad, (
        f"{bad} — deploy/docker-compose.yml writes a mount list in a form "
        "raw_dispositions cannot read, so every item in it is invisible to this suite."
    )


def test_every_undecidable_mount_in_the_real_file_is_settled_by_the_render():
    """Reconciled, not forbidden.

    An interpolated mount source is legal compose and may be either kind, so
    a test that simply refused one would be a red on a correct file — the
    thing New 3 was about, in a new place. Instead the render settles it: the
    raw text is the authority on what EXISTS, the render on what it RESOLVES
    TO. Today the real file has none, so this passes over an empty set; the
    case above exercises all three branches on a synthetic pair.
    """
    interp = [k for k in raw_rows_all() if k[0] == "interp"]
    render_mounts = {}
    text = RENDER.read_text()
    for svc in compose_read("cfg_service_keys", text).split():
        for line in compose_read(f'cfg_mounts "{svc}"', text).splitlines():
            parts = line.split("\t")
            if len(parts) >= 3:
                render_mounts[(svc, parts[2])] = parts[0]

    unresolved, undeclared = [], []
    for kind, svc, target in interp:
        resolved = render_mounts.get((svc, target))
        if resolved is None:
            unresolved.append(f"{svc} at {target}")
        elif resolved == "bind" and not raw_rows_all()[(kind, svc, target)][0]:
            undeclared.append(f"{svc} at {target}")
    assert not unresolved, (
        f"{unresolved} are mounts the file declares and the render does not show. "
        "Run deploy/backup/fixtures/refresh.sh, in the same commit as the edit."
    )
    assert not undeclared, (
        f"{undeclared} resolve to BINDS and carry no x-nova-backup row. Write them "
        "in long syntax, which is the only form that can carry one."
    )


def test_an_undecidable_source_is_reconciled_against_the_render():
    """The rule, stated once: the raw text is the authority on what EXISTS,
    the render is the authority on what it RESOLVES TO.

    Run over a synthetic pair rather than the real file, which has no
    interpolated mount today, so the reconciliation is exercised rather than
    merely available. Three outcomes, and each is the honest one:
      render says volume  -> nothing to declare, the raw row is satisfied
      render says bind    -> it needs a disposition like any other bind
      render says nothing -> the fixture is stale, and that is the alarm
    """
    raw = _rows(compose_read("raw_dispositions", GRAMMAR))
    interp = {k for k in raw if k[0] == "interp"}
    assert interp == {("interp", "a", "/interp-whole")}

    def reconcile(render_mounts):
        unresolved, undeclared = [], []
        for _, svc, target in interp:
            kind = render_mounts.get((svc, target))
            if kind is None:
                unresolved.append((svc, target))
            elif kind == "bind" and not raw[("interp", svc, target)][0]:
                undeclared.append((svc, target))
        return unresolved, undeclared

    assert reconcile({("a", "/interp-whole"): "volume"}) == ([], [])
    assert reconcile({("a", "/interp-whole"): "bind"}) == ([], [("a", "/interp-whole")])
    assert reconcile({}) == ([("a", "/interp-whole")], [])


MULTILINE_FLOW = """\
name: nova
services:
  a:
    image: alpine
    volumes:
      - {type: bind,
         source: ../spread,
         target: /spread,
         x-nova-backup: exclude-code,
         x-nova-backup-reason: "in git"}
      - {type: bind, source: ../plain, target: /plain}
"""


def test_a_flow_mapping_may_span_lines():
    """YAML lets a flow mapping wrap, and the first version of this reader
    read only the opening line — so a bind written that way was invisible and
    the item after it was read with the wrapped item's leftovers. Brace depth
    decides where it ends."""
    rows = _rows(compose_read("raw_dispositions", MULTILINE_FLOW))
    assert rows[("bind", "a", "/spread")] == ("exclude-code", True)
    assert rows[("bind", "a", "/plain")] == ("", False)
