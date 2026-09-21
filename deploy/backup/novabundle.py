#!/usr/bin/env python3
"""The container-side worker for Nova's backups.

It runs inside a throwaway container of the ALREADY-BUILT core image, with
**no docker socket**, reading the facts `deploy/backup.sh` rendered into
`$STAGE/facts/*.json`. It never shells out and it imports nothing from this
repo — the only thing it is handed is JSON on disk and a passphrase on stdin.

This file holds two halves that do not talk to each other:

  coverage   what this module decides may be backed up, and what it REFUSES.
             Everything below, plus SEGMENT_POLICY and the eight refusal
             codes. No crypto, no tar, no passphrase.

  the bundle NOVAENC1, the tar builder, the member hasher, the manifest
             writer/validator and safe_extract. Added beside coverage; it
             consumes coverage's entries and adds nothing to them.

design-verdict.md §6 is the authority for the coverage half: §6.1 the facts,
§6.2 where a disposition lives, §6.3 the algorithm, §6.4 host paths, §6.6 the
exact refusal.

The one sentence the whole thing exists for: **a volume, bind, host path,
.env key or database this stack holds and nothing has classified REFUSES the
run by name.** A silent skip is the defect; the refusal is the product.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Any, NamedTuple

# ── the closed set of dispositions (§6.2) ───────────────────────────────────
#
# Order matters only for the refusal text, which lists them all so the
# operator never has to go and find the vocabulary.

CARRY_VERBATIM = "include"
CARRY_AS_DUMP = "dump-pg"
CARRY_ON_MOVE = "move-only"

DISPOSITIONS = (
    CARRY_VERBATIM,
    CARRY_AS_DUMP,
    CARRY_ON_MOVE,
    "exclude-code",
    "exclude-redownload",
    "exclude-derived",
    "exclude-ephemeral",
    "exclude-declined",
)

# Carried as bytes, so the backup must prove it can READ it (§6.3 steps 10-11).
# `dump-pg` is deliberately not here: that tier is captured by pg_dump against
# the live server, never by copying the volume's files, so probing the volume
# would prove nothing about the thing that is actually carried.
INCLUDE_CLASS = (CARRY_VERBATIM,)

MODES = ("routine", "move")

# ── .env dispositions (§6.2) ────────────────────────────────────────────────

ENV_DISPOSITIONS = ("carry", "host", "drop")

# ── SEGMENT_POLICY (§6.4) ───────────────────────────────────────────────────
#
# A SEGMENT, not a path: a name that means the same thing wherever it appears
# in a tree. port-v3 listed `.superpowers` as an exact repo-relative row and
# the real scan emits `.superpowers/sdd/.gitignore`, because `.superpowers/`
# is not in .gitignore at all — the ignore comes from a nested .gitignore one
# level down. An exact-match table misses that and the backup refuses in this
# worktree today.
#
# This is the ONE table in the coverage half, and it is bounded on purpose:
# everything it does not name falls to git (tracked -> exclude-code, ignored
# -> include, neither -> R2_UNCLASSIFIED). There is no catch-all, because a
# catch-all is the silent skip this whole mechanism exists to prevent.
#
# `deploy/README.md` documents that a row added here needs a reason, and
# tests/test_policy.py is the line of code that refuses one without.

SEGMENT_POLICY = {
    ".git": {
        "disposition": "exclude-declined",
        "reason": "the repository's own object store; the code comes back from the remote.",
    },
    ".claude": {
        "disposition": "exclude-declined",
        "reason": "this machine's tooling state, not Nova's.",
    },
    ".superpowers": {
        "disposition": "exclude-declined",
        "reason": "this machine's tooling state, not Nova's.",
    },
    ".worktrees": {
        "disposition": "exclude-declined",
        "reason": "other checkouts of this same repository.",
    },
    "backups": {
        "disposition": "exclude-declined",
        "reason": "where bundles are written; carried, a bundle would contain "
        "every previous bundle.",
    },
    "__pycache__": {
        "disposition": "exclude-ephemeral",
        "reason": "compiled python, regenerated on import.",
    },
    ".venv": {
        "disposition": "exclude-ephemeral",
        "reason": "a virtualenv, rebuilt from the lockfile.",
    },
    "venv": {
        "disposition": "exclude-ephemeral",
        "reason": "a virtualenv, rebuilt from the lockfile.",
    },
    "node_modules": {
        "disposition": "exclude-ephemeral",
        "reason": "installed packages, rebuilt from the lockfile.",
    },
    ".ruff_cache": {"disposition": "exclude-ephemeral", "reason": "a linter cache."},
    ".pytest_cache": {"disposition": "exclude-ephemeral", "reason": "a test-runner cache."},
    ".mypy_cache": {"disposition": "exclude-ephemeral", "reason": "a type-checker cache."},
    "dist": {"disposition": "exclude-ephemeral", "reason": "build output, regenerated."},
    "build": {"disposition": "exclude-ephemeral", "reason": "build output, regenerated."},
    "dev-dist": {"disposition": "exclude-ephemeral", "reason": "build output, regenerated."},
    ".egg-info": {"disposition": "exclude-ephemeral", "reason": "packaging metadata, regenerated."},
}

# ── refusal codes (§6.6) ────────────────────────────────────────────────────

R0 = "R0_FACT_UNREADABLE"
R1 = "R1_PROFILE_GAP"
R2 = "R2_UNCLASSIFIED"
R3 = "R3_INTERPOLATION"
R4 = "R4_UNDECLARED_LIVE_MOUNT"
R5 = "R5_VOLUME_MISSING"
R6 = "R6_UNREACHABLE"
R7 = "R7_NO_DATABASES"

REFUSAL_CODES = (R0, R1, R2, R3, R4, R5, R6, R7)

# The six facts of §6.1, plus the two §6.3 needs and §6.1 does not name:
# `env` for step 7's .env keys and `databases` for step 8's R7.
FACT_NAMES = (
    "raw",
    "dispositions",
    "config",
    "containers",
    "git",
    "reachable",
    "env",
    "databases",
)

ANON_VOLUME_NAME = re.compile(r"^[0-9a-f]{64}$")
UNEXPANDED = re.compile(r"\$\{|\$[A-Za-z_]")

_FIX_DISPOSITIONS = """             x-nova-backup: {a} | {b} | {c} | {d} |
                            {e} |
                            {f} | {g} |
                            {h}
             x-nova-backup-reason: "<why>"     (required for every exclude-*)""".format(
    **dict(zip("abcdefgh", DISPOSITIONS, strict=True))
)


class CoverageRefused(Exception):
    """Raised when something asks for the carried set of a refused run.

    This is the mechanical half of "a refusal never downgrades to a skip": a
    caller that ignores `may_backup` and reaches for the entries anyway gets
    an exception, not a shorter list.
    """


@dataclass
class Entry:
    """One thing this stack holds, and what the backup does with it.

    `disposition` is "" exactly when nothing classified it — that entry is
    always accompanied by a refusal, and it STAYS in the list so the run can
    say what it found rather than what it kept.
    """

    kind: str
    name: str
    disposition: str = ""
    reason: str = ""
    service: str | None = None
    target: str | None = None
    full_name: str | None = None
    source: str = ""
    detail: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        d = {
            "kind": self.kind,
            "name": self.name,
            "disposition": self.disposition,
            "reason": self.reason,
            "service": self.service,
            "target": self.target,
            "full_name": self.full_name,
            "source": self.source,
        }
        if self.detail:
            d["detail"] = self.detail
        return d


@dataclass
class Refusal:
    code: str
    subject: str
    detail: str
    fix: str = ""

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "subject": self.subject, "detail": self.detail, "fix": self.fix}


class Coverage(NamedTuple):
    """`entries, refusals = coverage(facts, mode)` — the verdict's §6.3 shape,
    with `may_backup` derived rather than stored, so the two can never drift."""

    entries: list[Entry]
    refusals: list[Refusal]

    @property
    def may_backup(self) -> bool:
        return not self.refusals


def carried_entries(result: Coverage | tuple[list[Entry], list[Refusal]]) -> list[Entry]:
    """The entries a bundle would carry as bytes — or an exception.

    Never a shorter list with a warning (backend/app/backup_coverage.py:686-693
    is the shape this refuses to be).
    """
    entries, refusals = result[0], result[1]
    if refusals:
        raise CoverageRefused(
            f"{len(refusals)} refusal(s): " + ", ".join(sorted({r.code for r in refusals}))
        )
    return [e for e in entries if e.disposition in INCLUDE_CLASS or e.disposition == CARRY_AS_DUMP]


# ── the algorithm (§6.3) ────────────────────────────────────────────────────


def coverage(facts: dict[str, Any], mode: str) -> Coverage:
    """Classify everything this stack holds, and collect every refusal.

    Every refusal is collected — never the first one — so one run names them
    all and one edit of the compose file fixes them all.
    """
    if mode not in MODES:
        raise ValueError(f"unknown mode {mode!r}; expected one of {', '.join(MODES)}")

    entries: list[Entry] = []
    refusals: list[Refusal] = []

    # 0. Every fact must be present and readable. A fact that could not be
    #    rendered is R0: coverage has nothing to be right about.
    missing = [name for name in FACT_NAMES if not isinstance(facts.get(name), dict)]
    for name in missing:
        refusals.append(
            Refusal(
                R0,
                f"fact {name}",
                f"{name}.json was not rendered, so this run cannot say what the stack holds.",
                "fix: re-run ./install backup and read the renderer's own error above.",
            )
        )
    for name in FACT_NAMES:
        fact = facts.get(name)
        if isinstance(fact, dict) and fact.get("error"):
            refusals.append(
                Refusal(
                    R0,
                    f"fact {name}",
                    f"{name}.json records that its renderer could not be asked: {fact['error']}",
                    "",
                )
            )
    if missing:
        return Coverage(entries, refusals)

    raw = facts["raw"]
    config = facts["config"]
    disp = facts["dispositions"]
    containers = facts["containers"]
    git = facts["git"]
    reachable = facts["reachable"]
    env = facts["env"]
    databases = facts["databases"]

    # 1. The render must be a render of THIS checkout's compose text.
    raw_project = raw.get("project", "")
    cfg_project = config.get("name", "")
    if raw_project != cfg_project:
        refusals.append(
            Refusal(
                R0,
                "project name",
                f"the render calls this project `{cfg_project}` and the checkout's own "
                f"compose text calls it `{raw_project}`. One of them is not this stack.",
                "",
            )
        )

    cfg_services = config.get("services") or {}
    cfg_volumes = config.get("volumes") or {}
    raw_services = list(raw.get("services") or [])
    raw_volumes = list(raw.get("volumes") or [])
    compose_files = list(raw.get("compose_files") or [])
    where = compose_files[0] if compose_files else "the compose file"

    # 2. Gap check. A service the raw text declares and the render does not
    #    show means the render is not of the whole file — which is what
    #    catches a compose build that treats `*` as an ordinary profile name.
    for svc in raw_services:
        if svc not in cfg_services:
            refusals.append(
                Refusal(
                    R1,
                    f"service {svc}",
                    f"declared in {where} and absent from the render, so a profile this "
                    f"build did not include owns state nothing here can see.",
                    "fix: render with every profile (`--profile '*'`), and check that this "
                    "compose version does not treat `*` as an ordinary profile name.",
                )
            )

    # 3. Declared volumes. The declared set is the RAW text's, never a render's.
    volume_entries: dict[str, Entry] = {}
    for key in raw_volumes:
        rendered = cfg_volumes.get(key)
        row = (disp.get("volumes") or {}).get(key) or {}
        entry = Entry(
            kind="volume",
            name=key,
            full_name=(rendered or {}).get("name"),
            source="raw",
        )
        volume_entries[key] = entry
        entries.append(entry)

        if rendered is None:
            refusals.append(
                Refusal(
                    R2,
                    f"volume {key}",
                    f"declared in {where} and mounted by no service. Compose prunes such a "
                    "volume out of every render, so nothing downstream can see it — and a "
                    "volume nothing mounts still holds whatever was written to it.",
                    "fix: mount it from the service that owns it, or delete the declaration.",
                )
            )
            continue

        bad = _classify_declared(row)
        if bad:
            refusals.append(
                Refusal(
                    R2,
                    f"volume {key}  ({entry.full_name})",
                    bad,
                    "fix: in "
                    + where
                    + ", under `volumes: "
                    + key
                    + ":` add\n"
                    + _FIX_DISPOSITIONS,
                )
            )
            continue
        entry.disposition = row["disposition"]
        entry.reason = row.get("reason", "")

    # 4. Mounts, as the render resolves them.
    bind_sources: set[str] = set()
    declared_bind_targets: set[tuple[str, str]] = set()
    for svc in sorted(cfg_services):
        for mount in cfg_services[svc].get("volumes") or []:
            mtype = mount.get("type")
            source = mount.get("source", "")
            target = mount.get("target", "")
            if mtype == "tmpfs":
                continue
            if mtype == "volume":
                if source not in volume_entries:
                    entries.append(
                        Entry(
                            kind="volume", name=source, service=svc, target=target, source="config"
                        )
                    )
                    refusals.append(
                        Refusal(
                            R2,
                            f"volume {source}",
                            f"mounted by service `{svc}` at {target} and declared nowhere under "
                            f"`volumes:` in {where}.",
                            "fix: declare it, with a disposition:\n" + _FIX_DISPOSITIONS,
                        )
                    )
                    continue
                e = volume_entries[source]
                if e.service is None:
                    e.service, e.target = svc, target
                e.detail.setdefault("mounts", []).append(
                    {"service": svc, "target": target, "read_only": bool(mount.get("read_only"))}
                )
                continue
            if mtype != "bind":
                continue

            declared_bind_targets.add((svc, target))
            entry = Entry(
                kind="bind",
                name=source,
                service=svc,
                target=target,
                source="config",
                detail={"read_only": bool(mount.get("read_only"))},
            )
            entries.append(entry)
            if UNEXPANDED.search(source):
                refusals.append(
                    Refusal(
                        R3,
                        f"bind {source}",
                        f"service `{svc}` mounts it at {target} and the render still carries an "
                        "unexpanded variable. The compose default is NOT applied here on "
                        "purpose: it would snapshot a different directory than the one in use "
                        "and then pass every checksum it computed.",
                        "fix: set the variable in deploy/.env, or give the mount a literal source.",
                    )
                )
                continue
            bind_sources.add(source)
            row = ((disp.get("binds") or {}).get(svc) or {}).get(target) or {}
            bad = _classify_declared(row)
            if bad:
                refusals.append(
                    Refusal(
                        R2,
                        f"bind {source}",
                        f"mounted by service `{svc}` at {target}. " + bad,
                        f"fix: in {where}, write this mount in LONG syntax under "
                        f"`services: {svc}: volumes:` — only the long form can carry the two "
                        "rows — and add\n" + _FIX_DISPOSITIONS,
                    )
                )
                continue
            entry.disposition = row["disposition"]
            entry.reason = row.get("reason", "")

    # 5. Live mounts, from docker itself: the anonymous and image-declared
    #    volumes compose never names, and anything under this project's label
    #    that the compose file does not account for. Exited containers count.
    declared_full_names = {
        (v or {}).get("name") for v in cfg_volumes.values() if isinstance(v, dict)
    }
    seen_anon: set[tuple[str, str]] = set()
    for container in containers.get("containers") or []:
        svc = container.get("service") or ""
        cname = container.get("name") or container.get("id", "?")
        config_files = container.get("config_files") or ""
        for mount in container.get("mounts") or []:
            mtype = mount.get("Type")
            dest = mount.get("Destination", "")
            if mtype == "volume":
                name = mount.get("Name", "")
                if ANON_VOLUME_NAME.match(name):
                    # Keyed by (service, destination) — the 64-hex id is new on
                    # every recreate, so it can never be the key.
                    if (svc, dest) in seen_anon:
                        continue
                    seen_anon.add((svc, dest))
                    row = ((disp.get("anon") or {}).get(svc) or {}).get(dest) or {}
                    entry = Entry(
                        kind="anon",
                        name=dest,
                        service=svc,
                        target=dest,
                        full_name=name,
                        source="containers",
                    )
                    entries.append(entry)
                    bad = _classify_declared(row)
                    if bad:
                        refusals.append(
                            Refusal(
                                R2,
                                f"anonymous volume  service `{svc}` at {dest}",
                                "the image declares this volume; compose never names it, so it "
                                "has no entry under `volumes:` to carry a disposition. " + bad,
                                f"fix: in {where}, under `services: {svc}:` add\n"
                                "             x-nova-backup-anon:\n"
                                f"               {dest}: {{disposition: <one of the eight>, "
                                'reason: "<why>"}',
                            )
                        )
                        continue
                    entry.disposition = row["disposition"]
                    entry.reason = row.get("reason", "")
                    continue

                stripped = name
                prefix = f"{cfg_project}_"
                if stripped.startswith(prefix):
                    stripped = stripped[len(prefix) :]
                if name in declared_full_names or stripped in volume_entries:
                    continue
                entries.append(
                    Entry(
                        kind="live-volume", name=name, service=svc, target=dest, source="containers"
                    )
                )
                refusals.append(
                    Refusal(
                        R4,
                        f"live volume {name}",
                        f"container `{cname}` (project label `{cfg_project}`, config_files "
                        f"`{config_files}`) mounts it at {dest}, and {where} declares no volume "
                        "of that name. It holds bytes this backup would not carry.",
                        "fix: if it belongs to this stack, declare it; if it belongs to another "
                        "project that shares this project NAME, remove that container or "
                        "relabel it — `./install` names and offers to remove such leftovers.",
                    )
                )
                continue

            if mtype == "bind":
                src = mount.get("Source", "")
                # Matched by (service, destination), NOT by host path.
                #
                # Measured on this machine 2026-09-21, from the checkout that
                # actually owns the live stack: nova-postgres-1's initdb bind
                # reports Source=/run/desktop/mnt/host/wsl/docker-desktop-bind-
                # mounts/<distro>/<hash> while the render says the real host
                # path. Docker Desktop's file-sharing layer rewrites the source
                # it reports, so a Source-equality test — which is what §6.3
                # step 5 says literally — refuses EVERY backup on this host,
                # correct stack and all. The target is not rewritten, and the
                # service is read from the container's own compose label, so
                # the pair still catches what R4 is for: a container of some
                # other project under this project's name, and a mount at a
                # destination this compose file never declares. The Source
                # docker reported is kept on the entry so the two are
                # comparable by eye when they disagree.
                if src in bind_sources or (svc, dest) in declared_bind_targets:
                    continue
                entries.append(
                    Entry(
                        kind="live-bind",
                        name=src,
                        service=svc,
                        target=dest,
                        source="containers",
                        detail={"reported_source": src},
                    )
                )
                refusals.append(
                    Refusal(
                        R4,
                        f"live bind {src}",
                        f"container `{cname}` (project label `{cfg_project}`, config_files "
                        f"`{config_files}`) mounts it at {dest}, and {where} declares no bind "
                        f"on service `{svc}` at that destination.",
                        "fix: if it belongs to this stack, declare the mount in long syntax "
                        "with a disposition; if it belongs to another project that shares this "
                        "project NAME, remove that container or relabel it.",
                    )
                )

    # 6. Host paths under a scan root: a segment table first, then git.
    if not git.get("error"):
        if not git.get("work_tree"):
            refusals.append(
                Refusal(
                    R0,
                    "git",
                    f"{git.get('root') or 'the scan root'} is not a git work tree, so nothing "
                    "here can say which host files are code that comes back from the remote "
                    "and which are state with no other copy.",
                    "fix: run the backup from the checkout, not from a copy of it.",
                )
            )
        for path in sorted(git.get("paths") or {}):
            status = git["paths"][path]
            entry = Entry(kind="path", name=path, source="git")
            entries.append(entry)
            seg = _segment_hit(path)
            if seg:
                entry.disposition = SEGMENT_POLICY[seg]["disposition"]
                entry.reason = f"`{seg}` " + SEGMENT_POLICY[seg]["reason"]
                entry.detail["segment"] = seg
                continue
            if status == "tracked":
                entry.disposition = "exclude-code"
                entry.reason = "in git; it comes back from the remote with the checkout."
            elif status == "ignored":
                entry.disposition = CARRY_VERBATIM
                entry.reason = (
                    "not in git and under a scan root, so this file exists only on this host."
                )
            else:
                refusals.append(
                    Refusal(
                        R2,
                        f"host path {path}",
                        f"git says neither tracked nor ignored ({status!r}), so nothing says "
                        "whether it comes back from the remote or exists only here.",
                        "fix: commit it, add it to .gitignore, or add its directory name to "
                        "SEGMENT_POLICY in deploy/backup/novabundle.py with a reason.",
                    )
                )

    # 7. .env keys. The declaration lives in .env.example, above the key.
    declarations = env.get("declarations") or {}
    for key in list(env.get("keys") or []):
        entry = Entry(kind="env", name=key, source="env")
        entries.append(entry)
        declared = declarations.get(key)
        if declared not in ENV_DISPOSITIONS:
            refusals.append(
                Refusal(
                    R2,
                    f".env key {key}",
                    f"{env.get('env_file', 'deploy/.env')} carries it and deploy/.env.example "
                    + (
                        f"declares it `{declared}`, which is not one of "
                        f"{', '.join(ENV_DISPOSITIONS)}."
                        if declared
                        else "declares nothing for it. Its VALUE is never read here, only its "
                        "name — but a secret nothing has classified is a secret that would "
                        "either travel or be lost without anyone deciding."
                    ),
                    "fix: in deploy/.env.example, on the comment line immediately above "
                    f"`{key}=` (a commented-out key is fine), add\n"
                    "             # nova-backup: carry | host | drop",
                )
            )
            continue
        entry.disposition = declared
        entry.reason = {
            "carry": "the same Nova wherever it runs, so it travels in the bundle.",
            "host": "belongs to this machine; the target's own install writes its own.",
            "drop": "declared dead; carried nowhere.",
        }[declared]

    # 8. Databases. Every database on the server is carried and there is no
    #    per-database disposition, so a database a later slice adds cannot be
    #    silently dropped.
    db_list = list(databases.get("databases") or [])
    if not db_list:
        refusals.append(
            Refusal(
                R7,
                "databases",
                "the server reported no database to carry. Nova's state is three databases, "
                "so an empty list is a reading that failed, not a stack with nothing in it.",
                "fix: check that postgres is running and that the query reached it.",
            )
        )
    for db in db_list:
        entries.append(
            Entry(
                kind="database",
                name=db.get("name", ""),
                disposition=CARRY_AS_DUMP,
                reason="every database on the server is carried; there is no per-database "
                "disposition, so a database a later slice adds cannot be silently dropped.",
                source="pg",
                detail={"owner": db.get("owner")},
            )
        )

    # 9. Mode overlay. The ONLY mode-dependent rule, and the reason says so.
    if mode == "move":
        for entry in entries:
            if entry.disposition == CARRY_ON_MOVE:
                entry.disposition = CARRY_VERBATIM
                entry.reason = (
                    entry.reason + "  Carried because this run is `--move`; a routine backup "
                    "leaves it behind."
                )

    # 10/11. Reachability and existence, for EVERY include-class source — the
    # literal words of §6.3 step 10, and not "every include-class volume".
    # carried_entries() returns an entry of any kind whose disposition is
    # `include`, so a rule that probes one or two kinds leaves the others
    # carried with nothing having proved them readable. That is the silent
    # skip this module exists to prevent, one level up from the one it
    # already catches.
    probes = {
        "volumes": reachable.get("volumes") or {},
        "files": reachable.get("files") or {},
    }
    for entry in entries:
        if entry.disposition not in INCLUDE_CLASS:
            continue
        rule = _probe_rule(entry)
        if rule is None:
            # Not "skip": a kind that can be carried and cannot be probed is a
            # gap in THIS file, and it refuses rather than passing quietly.
            refusals.append(
                Refusal(
                    R6,
                    f"{entry.kind} {entry.name}",
                    f"classified as state to carry, and nothing here knows how to probe a "
                    f"{entry.kind}. A tier nobody measured is not a tier proven readable.",
                    "fix: give this kind a row in _probe_rule() and a probe in "
                    "deploy/backup.sh's render_reachable.",
                )
            )
            continue
        which, key, label, missing_code = rule
        probe = probes[which].get(key)
        if probe is None:
            refusals.append(
                Refusal(
                    R6,
                    label,
                    "classified as state to carry, and nothing probed whether this host can "
                    "read it. A tier nobody measured is not a tier proven readable.",
                    "",
                )
            )
            continue
        if not probe.get("exists"):
            refusals.append(
                Refusal(
                    missing_code,
                    label,
                    "is to be carried and it is not on this host: "
                    f"{probe.get('detail', '')}. Either what owns it has never run, or it "
                    "was removed.",
                    "",
                )
            )
            continue
        if not probe.get("ok"):
            refusals.append(
                Refusal(
                    R6,
                    label,
                    "classified as state to carry, but the backup cannot read it: "
                    f"{probe.get('detail', '')}. A bundle that silently omits a tier is "
                    "worse than no bundle.",
                    "",
                )
            )

    entries.sort(key=lambda e: (e.kind, e.name))
    refusals.sort(key=lambda r: (REFUSAL_CODES.index(r.code), r.subject))
    return Coverage(entries, refusals)


def _probe_rule(entry: Entry) -> tuple[str, str, str, str] | None:
    """(which half of reachable.json, the key in it, the label, the absent code).

    reachable.json is keyed by what a probe can actually address: a named
    volume by its compose KEY, an anonymous one by the 64-hex name docker gave
    it (it has no compose key — that is what makes it anonymous), and a host
    path or a bind by the path itself. `None` means this kind is not a source
    of bytes, which the caller turns into a refusal rather than a skip.
    """
    if entry.kind == "volume":
        return ("volumes", entry.name, f"volume {entry.name}  ({entry.full_name})", R5)
    if entry.kind == "anon":
        return (
            "volumes",
            entry.full_name or "",
            f"anonymous volume  service `{entry.service}` at {entry.name}",
            R5,
        )
    if entry.kind == "path":
        return ("files", entry.name, f"host path {entry.name}", R6)
    if entry.kind == "bind":
        return (
            "files",
            entry.name,
            f"bind {entry.name}  (service `{entry.service}` at {entry.target})",
            R6,
        )
    return None


def _classify_declared(row: dict[str, Any]) -> str:
    """ "" when the row is a legal declaration, else the sentence that says why not."""
    value = (row or {}).get("disposition")
    if not value:
        return (
            "Nothing says what a backup should do with it, so this backup will not claim to "
            "be complete. Git cannot see inside a volume, so this is the one thing that must "
            "be decided by hand."
        )
    if value not in DISPOSITIONS:
        return (
            f"its disposition is `{value}`, which is not one of the eight. An unknown value is "
            "not a default — it is a typo that would otherwise decide what happens to data."
        )
    if value.startswith("exclude-") and not (row.get("reason") or "").strip():
        return (
            f"it is `{value}` with no reason. Every exclude-* must say why, because the reason "
            "is what a restore prints when the operator asks what is missing."
        )
    return ""


def _segment_hit(path: str) -> str | None:
    """The first path segment that SEGMENT_POLICY names, or None.

    `.egg-info` is matched as a suffix as well as a whole name, because that is
    how the directory is actually spelled (`nova_core.egg-info`).
    """
    for segment in path.split("/"):
        if segment in SEGMENT_POLICY:
            return segment
        if segment.endswith(".egg-info"):
            return ".egg-info"
    return None


# ── the refusal (§6.6) ──────────────────────────────────────────────────────


def render_refusals(refusals: list[Refusal]) -> str:
    """The exact text a refused run prints to stderr.

    `Error:` is the house prefix for a stated refusal. The first two lines say
    what was NOT done, because "no bundle" and "nothing was touched" are two
    different reassurances and an operator needs both.
    """
    out = [
        "Error: this stack has state the backup cannot account for. No bundle was written.",
        "Nothing was stopped, dumped or written.",
        "",
    ]
    for r in refusals:
        out.append(f"  {r.code}   {r.subject}")
        for line in _wrap(r.detail, 72):
            out.append(f"      {line}")
        if r.fix:
            out.extend(f"      {line}" for line in r.fix.splitlines())
        out.append("")
    n = len(refusals)
    out.append(
        f"{n} refusal{'' if n == 1 else 's'}. Decide each one, then run `./install backup` again."
    )
    return "\n".join(out)


def _wrap(text: str, width: int) -> list[str]:
    lines: list[str] = []
    for paragraph in text.splitlines():
        current = ""
        for word in paragraph.split():
            if current and len(current) + 1 + len(word) > width:
                lines.append(current)
                current = word
            else:
                current = f"{current} {word}".strip()
        lines.append(current)
    return lines


# ── facts on disk ───────────────────────────────────────────────────────────


def load_facts(facts_dir: str) -> dict[str, Any]:
    """Read the fact files backup.sh rendered.

    A file that is absent or does not parse becomes an `error` fact rather
    than an exception, so ONE run can report every unreadable fact alongside
    every other refusal instead of dying on the first.
    """
    facts: dict[str, Any] = {}
    for name in FACT_NAMES:
        path = os.path.join(facts_dir, f"{name}.json")
        try:
            with open(path, encoding="utf-8") as fh:
                loaded = json.load(fh)
        except FileNotFoundError:
            continue
        except (OSError, ValueError) as exc:
            facts[name] = {"error": f"{path}: {exc}"}
            continue
        if not isinstance(loaded, dict):
            facts[name] = {"error": f"{path}: expected a JSON object, got {type(loaded).__name__}"}
            continue
        facts[name] = loaded
    return facts


# ── CLI ─────────────────────────────────────────────────────────────────────
#
# Exit codes, uniform across every verb (design-verdict.md §9): 0 verified,
# 1 a verification failed, 2 the environment could not be asked, 3 refused
# before anything was touched.


def cmd_coverage(args: argparse.Namespace) -> int:
    facts = load_facts(args.facts)
    entries, refusals = coverage(facts, args.mode)
    if refusals:
        sys.stderr.write(render_refusals(refusals) + "\n")
        return 3
    json.dump(
        {
            "may_backup": True,
            "mode": args.mode,
            "entries": [e.as_dict() for e in entries],
            "refusals": [],
        },
        sys.stdout,
        indent=2,
        sort_keys=False,
    )
    sys.stdout.write("\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="novabundle.py", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    cov = sub.add_parser("coverage", help="classify this stack, or refuse")
    cov.add_argument("--facts", required=True, help="the directory backup.sh rendered facts into")
    cov.add_argument("--mode", default="routine", choices=list(MODES))
    cov.set_defaults(func=cmd_coverage)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
