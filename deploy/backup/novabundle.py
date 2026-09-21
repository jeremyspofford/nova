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
import base64
import calendar
import gzip
import hashlib
import io
import json
import os
import posixpath
import re
import secrets
import shutil
import stat
import struct
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any, NamedTuple

# The raw compose text is parsed HERE, by the same kind of parser compose
# itself uses on it, rather than by hand in awk on the host (s41/rulings.md,
# 2026-09-21). PyYAML is in this image's runtime closure through
# `uvicorn[standard]`; tests/test_raw_compose.py is the line of code that goes
# red the day that stops being true. An import failure here is a loud stop, on
# purpose: the alternative is a parser that degrades to reading nothing, which
# is the silent skip this whole module exists to prevent.
import yaml

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

# What each fact IS on disk, so a refusal names something the operator can go
# and look at. `raw` is the odd one out: the shell stages the compose TEXT and
# this module parses it, so there is no raw.json (s41/rulings.md 2026-09-21).
FACT_FILES = dict.fromkeys(FACT_NAMES)
for _name in FACT_NAMES:
    FACT_FILES[_name] = f"{_name}.json"
FACT_FILES["raw"] = "the compose text staged in facts/compose/"

# A fact whose renderer failed can come back well-formed and EMPTY, and an
# empty structure refuses nothing at all: no container means step 5 never
# runs, and §6.1 says containers.json is the ONLY source that can see an
# image-declared volume; no raw service means the R1 profile-gap check passes
# vacuously. `[ -s ]` in the shell catches an empty FILE and none of these.
#
# "An empty-but-successful fact is a failure, not nothing to carry" — §6.1.
NON_EMPTY_FACTS = (
    ("raw", "services", "the compose text names no service"),
    ("raw", "volumes", "the compose text declares no volume"),
    ("config", "services", "the render has no service in it"),
    ("config", "volumes", "the render has no volume in it"),
    (
        "containers",
        "containers",
        "docker reported no container under this project's label. That is the only "
        "source that can see a volume an image declares, so an empty list removes a "
        "whole refusal rather than reporting a stack with nothing in it",
    ),
    ("env", "keys", "the .env carries no key at all"),
    ("git", "paths", "the scan found no host file under any scan root"),
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
                f"{FACT_FILES[name]} was not rendered, so this run cannot say what "
                "the stack holds.",
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
                    f"{FACT_FILES[name]} records that its renderer could not be asked: "
                    f"{fact['error']}",
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

    # 0b. A fact that came back structurally empty is a reading that failed.
    for fact_name, key, why in NON_EMPTY_FACTS:
        if not (facts[fact_name].get(key) or []):
            refusals.append(
                Refusal(
                    R0,
                    f"fact {fact_name}.{key}",
                    f"{FACT_FILES[fact_name]} parsed and `{key}` is empty: {why}. An "
                    "empty-but-successful fact is a failure, not nothing to carry.",
                    "fix: re-run ./install backup and read the renderer's own error, and "
                    "check that the stack this backup is about is the stack that is running.",
                )
            )

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

    # ...and the containers fact must be about the same project as the render.
    # Both are rendered from the same run and both are on disk, so a
    # disagreement means one of them is a reading of something else.
    containers_project = containers.get("project")
    if containers_project is not None and containers_project != cfg_project:
        refusals.append(
            Refusal(
                R0,
                "project name",
                f"containers.json was filtered on the label `{containers_project}` and the "
                f"render calls this project `{cfg_project}`. The live mounts in that fact "
                "are not this stack's.",
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
    # Keyed by SERVICE, not flat: a flat set lets any container mounting any
    # declared source at any destination pass, whatever service it belongs to.
    declared_bind_targets: dict[tuple[str, str], Entry] = {}
    declared_bind_sources: dict[tuple[str, str], Entry] = {}
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
            declared_bind_targets[(svc, target)] = entry
            declared_bind_sources[(svc, source)] = entry
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
                                f"               {dest}:\n"
                                "                 disposition: <one of the eight>\n"
                                '                 reason: "<why>"',
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
                declared = declared_bind_targets.get((svc, dest))
                by_source = declared_bind_sources.get((svc, src))
                if declared is not None or by_source is not None:
                    # Matched. If docker's Source is not the path the render
                    # resolved, say so on the entry rather than merely
                    # tolerating it: the bundle's facts then carry both paths,
                    # and an operator reading the plan can see that the host
                    # directory under a declared mount is not where this
                    # checkout thinks it is. Two live causes on this machine —
                    # Docker Desktop rewriting the source it reports, and a
                    # stack created from a different checkout of this same
                    # repo (verdict §10.1's `sibling`) — and coverage cannot
                    # tell them apart, so it states the fact instead of
                    # guessing which one it is looking at.
                    if declared is not None and src and src != declared.name:
                        declared.detail.setdefault("live_mounts", []).append(
                            {
                                "container": cname,
                                "reported_source": src,
                                "reported_destination": dest,
                                "matched_by": "service+destination",
                                "source_matches_render": False,
                            }
                        )
                    elif declared is None and by_source is not None:
                        # Matched on the source alone: the bytes are accounted
                        # for, because that source is a declared bind carrying
                        # a disposition — but this service mounts it somewhere
                        # the compose file never says. Same principle as the
                        # arm above: state the fact where you cannot refuse on
                        # it, rather than passing in silence.
                        by_source.detail.setdefault("live_mounts", []).append(
                            {
                                "container": cname,
                                "reported_source": src,
                                "reported_destination": dest,
                                "matched_by": "service+source",
                                "destination_matches_render": False,
                            }
                        )
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


# ── the raw compose text (§6.1) ──────────────────────────────────────────────
#
# THE DECLARED SET, and the one reading that looks at the file a human edits.
# It cannot come from a render: compose PRUNES a volume no rendered service
# mounts out of `config`, out of `config --format json` and out of
# `config --volumes` alike (measured on v5.3.0 and v5.5.1, s41/measurements.md
# R2), and a declared volume nothing mounts is the exact case coverage exists
# to catch. The DISPOSITIONS still come from the YAML render, because the JSON
# render strips every nested `x-` key — two sources, neither a style
# preference, and this file changes the parser rather than either source.
#
# Until 2026-09-21 this parse was hand-written in POSIX awk in
# deploy/compose_read.sh. Four fix rounds found six defects in it, each a real
# bind that real compose resolves and the reader did not see, each in a
# different place — the pattern that says the architecture is wrong rather
# than the line (s41/rulings.md). deploy/backup.sh now STAGES the bytes of
# every file in COMPOSE_FILE and this side parses them.
#
# What the parser may not do is skip. Anything it cannot decide comes back as
# an `unreadable` row naming what it could not read — a stated cannot — and
# anything that is not one compose document at all raises, which coverage
# turns into R0 rather than into an empty declared set.

RAW_STAGE_DIR = "compose"
RAW_STAGE_MANIFEST = "files.json"

DISPOSITION_KEY = "x-nova-backup"
REASON_KEY = "x-nova-backup-reason"
ANON_KEY = "x-nova-backup-anon"

# Every mount `type` compose accepts. `bind` is the only one that can carry a
# disposition of its own: a named volume's lives under `volumes:` and an
# image-declared one's under the service's x-nova-backup-anon block (§6.2).
MOUNT_TYPES = ("bind", "volume", "tmpfs", "npipe", "cluster", "image")

_INTERPOLATION = re.compile(r"\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*")


class ComposeTextError(ValueError):
    """The staged text is not one compose document, and says which file."""


def _row(kind, service, name, disposition="", reason="", where=""):
    return {
        "kind": kind,
        "service": service,
        "name": name,
        "disposition": disposition,
        "reason": reason,
        "where": where,
    }


def _text(value: Any) -> str:
    """A scalar as the reader uses it. A non-string (a number, a list, None)
    is not a disposition or a reason, and silently str()ing one would invent
    a declaration nobody wrote."""
    return value if isinstance(value, str) else ""


def mount_kind(source: str) -> str:
    """Which side of a mount a SOURCE is, by the rule compose applies AFTER
    interpolation. Measured against compose v5.3.0, every row of
    s41/measurements.md R8:

      starts with `.`, `/` or `~`        -> bind
      holds a literal `/` anywhere else  -> bind, because a volume NAME may
                                            not contain `/` at all (compose
                                            rejects `volumes: {"sub/dir": {}}`)
      otherwise, and holds a `$`         -> INTERP: undecidable here
      otherwise                          -> a named volume

    `interp` is the honest third answer and it is why this reader does not
    simply refuse an interpolated source. `${VOLNAME}:/t` is a named volume
    when the variable holds a name and a bind when it holds a path — measured
    both ways. Guessing `bind` reddens a correct file, which is what teaches
    people to route around a tripwire; guessing `volume` hides an undeclared
    one. The render settles it: raw text says what EXISTS, the render says
    what it RESOLVES TO.
    """
    if not source:
        return "unreadable"
    if source[0] in "./~":
        return "bind"
    if "/" in _INTERPOLATION.sub("", source):
        return "bind"
    if "$" in source:
        return "interp"
    return "volume"


def split_mount_spec(spec: str) -> list[str]:
    """`<source>:<target>[:<mode>]`, split on the colons that separate them.

    Not `spec.split(":")`: `${VAR:-/default}` carries a colon of its own and
    compose expands it before splitting anything. Measured — compose resolves
    `- ${NOPE:-../fallback}:/t` to a bind at /t — and a naive split reads the
    source as `${NOPE` and the target as `-../fallback}`.
    """
    parts: list[str] = []
    current: list[str] = []
    depth = 0
    index = 0
    while index < len(spec):
        char = spec[index]
        if char == "$" and spec[index + 1 : index + 2] == "{":
            depth += 1
            current.append("${")
            index += 2
            continue
        if char == "}" and depth:
            depth -= 1
        elif char == ":" and depth == 0:
            parts.append("".join(current))
            current = []
            index += 1
            continue
        current.append(char)
        index += 1
    parts.append("".join(current))
    return parts


def _string_mount(item: str, service: str, where: str) -> list[dict]:
    """A short-syntax item, `<source>:<target>[:<mode>]`."""
    parts = split_mount_spec(item)
    if len(parts) == 1:
        if "$" in item:
            # `- ${MOUNTSPEC}` carrying a whole `src:tgt`. Measured: compose
            # resolves it to a real bind. Nothing here can know even the
            # TARGET, which is the key every row is compared by, so this is
            # said rather than guessed or swallowed.
            return [
                _row(
                    "unreadable",
                    service,
                    f"`- {item}` (the whole mount spec is a variable)",
                    where=where,
                )
            ]
        # No colon and no variable: an inline ANONYMOUS volume, measured —
        # not a bind. The only place its name exists is containers.json,
        # where an undeclared one is refused R4.
        return []
    if len(parts) > 3:
        return [
            _row(
                "unreadable",
                service,
                f"`- {item}` (too many colons; compose rejects it)",
                where=where,
            )
        ]
    source, target = parts[0], parts[1]
    if not source or not target:
        return [
            _row("unreadable", service, f"`- {item}` (empty section between colons)", where=where)
        ]
    if "$" in target:
        # The target is what a row is KEYED by, so an interpolated one cannot
        # be compared against anything. Measured: compose resolves it fine.
        return [
            _row("unreadable", service, f"`- {item}` (the target is interpolated)", where=where)
        ]
    kind = mount_kind(source)
    if kind in ("bind", "interp"):
        return [_row(kind, service, target, where=where)]
    return []


def _mapping_mount(item: dict, service: str, where: str) -> list[dict]:
    """A long-syntax item. Block mapping and flow mapping are the same thing
    to a YAML parser, which is why three of the six awk defects were one bug
    here."""
    target = item.get("target")
    disposition = _text(item.get(DISPOSITION_KEY))
    reason = _text(item.get(REASON_KEY))
    mtype = item.get("type")
    if not isinstance(target, str) or not target:
        return [_row("unreadable", service, "a long-syntax mount with no `target:`", where=where)]
    if "$" in target:
        return [
            _row(
                "unreadable",
                service,
                f"a long-syntax mount whose target `{target}` is interpolated",
                where=where,
            )
        ]
    if not isinstance(mtype, str) or not mtype:
        # Measured: compose REJECTS a long-syntax mount with no `type:`
        # (`services.a.volumes.0 must be a string`), so there is no resolved
        # mount to agree with and no kind to infer.
        return [
            _row(
                "unreadable",
                service,
                f"a long-syntax mount at {target} with no `type:`",
                where=where,
            )
        ]
    if mtype == "bind":
        return [_row("bind", service, target, disposition, reason, where)]
    if mtype in MOUNT_TYPES:
        if disposition or reason:
            # A disposition written on a non-bind mount is read by nothing:
            # dispositions.json carries only binds, and a named volume's row
            # lives under `volumes:`. Saying so beats ignoring it.
            return [
                _row(
                    "unreadable",
                    service,
                    f"`{DISPOSITION_KEY}` on a `{mtype}` mount at {target} is read by nothing",
                    where=where,
                )
            ]
        return []
    return [
        _row("unreadable", service, f"a mount at {target} of unknown type `{mtype}`", where=where)
    ]


def _walk_keys(node: Any, path: tuple = ()):
    """Every mapping key in the document, with the path it sits at."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield path, key
            yield from _walk_keys(value, path + (key,))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _walk_keys(value, path + (index,))


def _reads_this_disposition(path: tuple) -> bool:
    """The three places §6.2 says a disposition lives, and no others."""
    if len(path) == 3 and path[0] == "volumes" and path[2] in (DISPOSITION_KEY, REASON_KEY):
        return True
    if len(path) == 3 and path[0] == "services" and path[2] == ANON_KEY:
        return True
    return (
        len(path) == 5
        and path[0] == "services"
        and path[2] == "volumes"
        and isinstance(path[3], int)
        and path[4] in (DISPOSITION_KEY, REASON_KEY)
    )


def _misplaced_dispositions(doc: dict, where: str) -> list[dict]:
    """An `x-nova-backup*` row written where nothing reads it.

    Not a hypothetical: the rows are hand-written prose in a YAML file, the
    three legal homes are at three different depths, and neither this reader
    nor the render would ever mention a misplaced one. A declaration nobody
    reads looks exactly like a declaration that works.
    """
    rows = []
    for path, key in _walk_keys(doc):
        if not isinstance(key, str) or not key.startswith(DISPOSITION_KEY):
            continue
        full = path + (key,)
        if _reads_this_disposition(full):
            continue
        service = path[1] if len(path) > 1 and path[0] == "services" else ""
        where_written = ".".join(str(part) for part in full)
        rows.append(
            _row(
                "unreadable",
                service,
                f"`{where_written}` is a disposition nothing reads",
                where=where,
            )
        )
    return rows


def compose_document_rows(doc: dict, where: str) -> list[dict]:
    """Every disposition-bearing thing one compose document declares:

    volume     <key>                      its x-nova-backup row, if any
    bind       <service> <target>         the long form's own row, if any
    interp     <service> <target>         a source only the render can settle
    anon       <service> <target>         an x-nova-backup-anon row
    unreadable <service> <what>           a STATED cannot, never a skip
    """
    rows: list[dict] = []

    volumes = doc.get("volumes")
    if volumes is not None:
        if not isinstance(volumes, dict):
            rows.append(
                _row("unreadable", "", "the top-level `volumes:` is not a mapping", where=where)
            )
        else:
            for key, value in volumes.items():
                if not isinstance(key, str):
                    rows.append(
                        _row(
                            "unreadable",
                            "",
                            f"a volume key that is not a name: {key!r}",
                            where=where,
                        )
                    )
                    continue
                if value is None:
                    rows.append(_row("volume", "", key, where=where))
                elif isinstance(value, dict):
                    rows.append(
                        _row(
                            "volume",
                            "",
                            key,
                            _text(value.get(DISPOSITION_KEY)),
                            _text(value.get(REASON_KEY)),
                            where,
                        )
                    )
                else:
                    rows.append(
                        _row(
                            "unreadable",
                            "",
                            f"volume `{key}` is declared as a {type(value).__name__}",
                            where=where,
                        )
                    )

    services = doc.get("services")
    if services is not None:
        if not isinstance(services, dict):
            rows.append(
                _row("unreadable", "", "the top-level `services:` is not a mapping", where=where)
            )
            services = {}
        for name, body in sorted(services.items(), key=lambda kv: str(kv[0])):
            service = str(name)
            if body is None:
                continue
            if not isinstance(body, dict):
                rows.append(
                    _row(
                        "unreadable",
                        service,
                        f"the service is a {type(body).__name__}, not a mapping",
                        where=where,
                    )
                )
                continue

            anon = body.get(ANON_KEY)
            if anon is not None:
                if not isinstance(anon, dict):
                    rows.append(
                        _row("unreadable", service, f"`{ANON_KEY}:` is not a mapping", where=where)
                    )
                else:
                    for target, entry in anon.items():
                        if isinstance(entry, dict):
                            rows.append(
                                _row(
                                    "anon",
                                    service,
                                    str(target),
                                    _text(entry.get("disposition")),
                                    _text(entry.get("reason")),
                                    where,
                                )
                            )
                        else:
                            rows.append(
                                _row(
                                    "unreadable",
                                    service,
                                    f"`{ANON_KEY}: {target}` is not a mapping",
                                    where=where,
                                )
                            )

            if "volumes" in body:
                mounts = body.get("volumes")
                if not isinstance(mounts, list):
                    # Measured: compose rejects both `volumes:` (null) and a
                    # mapping (`services.a.volumes must be a array`). An empty
                    # LIST is legal and means no mounts, so it is not a row.
                    rows.append(
                        _row(
                            "unreadable", service, "`volumes:` is not a list of mounts", where=where
                        )
                    )
                else:
                    for item in mounts:
                        if isinstance(item, str):
                            rows.extend(_string_mount(item, service, where))
                        elif isinstance(item, dict):
                            rows.extend(_mapping_mount(item, service, where))
                        else:
                            rows.append(
                                _row(
                                    "unreadable",
                                    service,
                                    f"a mount item that is a {type(item).__name__}",
                                    where=where,
                                )
                            )

    rows.extend(_misplaced_dispositions(doc, where))
    return rows


def load_compose_document(text: str, where: str) -> dict:
    """One compose document, or a refusal that names the file and says why."""
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ComposeTextError(f"{where}: {' '.join(str(exc).split())}") from None
    if doc is None:
        raise ComposeTextError(
            f"{where}: parses to nothing. An empty compose file is a reading that "
            "failed, not a stack with nothing in it."
        )
    if not isinstance(doc, dict):
        raise ComposeTextError(
            f"{where}: parses to a {type(doc).__name__}, not a compose document."
        )
    _refuse_unfollowable_merges(doc, where)
    return doc


def _named_files(value: Any) -> list[str]:
    """Whatever `include:` or `extends: file:` names, flattened to strings."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        out: list[str] = []
        for key in ("path", "file"):
            out.extend(_named_files(value.get(key)))
        return out
    if isinstance(value, list):
        out = []
        for item in value:
            out.extend(_named_files(item))
        return out
    return []


def _refuse_unfollowable_merges(doc: dict, where: str) -> None:
    """A compose file that merges a document this parser is not handed.

    Compose's top-level `include:` merges another file's WHOLE document,
    top-level `volumes:` and all. That file is not in `COMPOSE_FILE`, so
    backup.sh never stages it and this parser never sees it — and a volume no
    rendered service mounts is pruned from every render, so the render side
    cannot see it either. A volume the operator declared, carrying
    `x-nova-backup: include`, would then be absent from the plan with nothing
    saying so: exactly the silent skip this module exists to prevent.
    Measured on compose v5.3.0 and on this parser
    (.superpowers/sdd/slice-41-portable-hub/task-1-rereview4.md, section F).

    So it is a STATED CANNOT, never a key that is skipped. `deploy/docker-
    compose.yml` uses neither key today; the refusal is what keeps it that
    way, or makes the day it changes loud.
    """
    if "include" in doc:
        named = _named_files(doc["include"]) or ["(unreadable)"]
        raise ComposeTextError(
            f"{where}: carries a top-level `include:` naming {', '.join(named)}. "
            "Compose merges that file's whole document — its `volumes:` block too — and "
            "this reader is handed only the files in COMPOSE_FILE, so anything declared "
            "there would be carried by nothing and refused by nothing. "
            "Fix: merge it into this file, or add it to COMPOSE_FILE so it is staged and "
            "parsed like every other compose file."
        )
    services = doc.get("services")
    if isinstance(services, dict):
        for name, body in sorted(services.items(), key=lambda kv: str(kv[0])):
            if not isinstance(body, dict):
                continue
            extends = body.get("extends")
            named = _named_files(extends.get("file")) if isinstance(extends, dict) else []
            if named:
                raise ComposeTextError(
                    f"{where}: service `{name}` extends a service in {', '.join(named)}, "
                    "which this reader is not handed, so any mount it brings is invisible "
                    "here. Fix: merge that service into this file, or add the file to "
                    "COMPOSE_FILE."
                )


def raw_compose_rows(text: str, where: str) -> list[dict]:
    return compose_document_rows(load_compose_document(text, where), where)


def raw_compose_fact(files: list[tuple[str, str]]) -> dict[str, Any]:
    """The `raw` fact of §6.1, from the text of every file in COMPOSE_FILE.

    `files` is [(source path, text)] in COMPOSE_FILE order, which is the order
    a bare `docker compose` on this host merges them in.
    """
    project = ""
    services: set[str] = set()
    volumes: set[str] = set()
    rows: list[dict] = []
    for where, text in files:
        doc = load_compose_document(text, where)
        # Measured on compose v5.3.0, both orders: the LAST file that declares
        # a `name:` wins, and a file that declares none does not clear it.
        name = doc.get("name")
        if isinstance(name, str) and name.strip():
            project = name.strip()
        for section, into in (("services", services), ("volumes", volumes)):
            block = doc.get(section)
            if isinstance(block, dict):
                into.update(str(key) for key in block)
        rows.extend(compose_document_rows(doc, where))
    return {
        "project": project,
        "compose_files": [where for where, _ in files],
        "services": sorted(services),
        "volumes": sorted(volumes),
        "rows": rows,
    }


def read_compose_stage(facts_dir: str) -> list[tuple[str, str]]:
    """The text backup.sh staged, in COMPOSE_FILE order.

    The shell copies bytes and writes the manifest; it parses nothing.
    """
    stage = os.path.join(facts_dir, RAW_STAGE_DIR)
    with open(os.path.join(stage, RAW_STAGE_MANIFEST), encoding="utf-8") as fh:
        manifest = json.load(fh)
    entries = manifest.get("compose_files") if isinstance(manifest, dict) else None
    if not isinstance(entries, list) or not entries:
        raise ComposeTextError(
            f"{stage}/{RAW_STAGE_MANIFEST} names no compose file, so there is no "
            "declared set to read."
        )
    files = []
    for entry in entries:
        source = entry.get("source") if isinstance(entry, dict) else None
        staged = entry.get("staged") if isinstance(entry, dict) else None
        if not isinstance(source, str) or not isinstance(staged, str) or not staged:
            raise ComposeTextError(
                f"{stage}/{RAW_STAGE_MANIFEST} carries an entry that names no file: {entry!r}"
            )
        if os.path.basename(staged) != staged or staged.startswith("."):
            raise ComposeTextError(
                f"{stage}/{RAW_STAGE_MANIFEST} names a staged file outside the stage: {staged!r}"
            )
        with open(os.path.join(stage, staged), encoding="utf-8") as fh:
            files.append((source, fh.read()))
    return files


# ── facts on disk ───────────────────────────────────────────────────────────


def raw_fact_on_disk(facts_dir: str) -> dict[str, Any] | None:
    """The `raw` fact, DERIVED here from the text backup.sh staged.

    Every other fact is a JSON file the shell wrote. This one is the compose
    text itself, parsed on this side (s41/rulings.md 2026-09-21), so the shell
    stages bytes and hand-parses no YAML. `None` means nothing was staged at
    all, which coverage reports as R0 like any other missing fact.
    """
    try:
        files = read_compose_stage(facts_dir)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        return {"error": f"{exc}"}
    try:
        return raw_compose_fact(files)
    except ComposeTextError as exc:
        return {"error": f"{exc}"}


def load_facts(facts_dir: str) -> dict[str, Any]:
    """Read the fact files backup.sh rendered.

    A file that is absent or does not parse becomes an `error` fact rather
    than an exception, so ONE run can report every unreadable fact alongside
    every other refusal instead of dying on the first.
    """
    facts: dict[str, Any] = {}
    for name in FACT_NAMES:
        if name == "raw":
            raw = raw_fact_on_disk(facts_dir)
            if raw is not None:
                facts[name] = raw
            continue
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


# ══ THE BUNDLE ══════════════════════════════════════════════════════════════
#
# design-verdict.md §5 (the bundle format), §7 (crypto). Ported from v3's
# backend/app/backup_crypto.py with the NOVAENC1 wire format BYTE FOR BYTE
# unchanged, so a v3-written payload still opens — pinned by a v3-written
# fixture in tests/test_novaenc.py rather than by this sentence.
#
# Nothing below reads a fact or a disposition. It is handed a staged tree and
# a manifest and it turns them into one file; the only thing it decides is
# whether what it produced is what it said it produced.


# ── NOVAENC1 (§7.1) ─────────────────────────────────────────────────────────

MAGIC = b"NOVAENC1"

# The WRITER's scrypt cost. ~34 MB per derivation, chosen so nova_restore.py
# derives the same key with nothing but the standard library (§7.1).
SCRYPT_N, SCRYPT_R, SCRYPT_P = 1 << 15, 8, 1
DKLEN = 32

# What a READER will pay for, checked BEFORE any allocation and separately
# from the writer's cost. A decryptor must allocate 128*r*n bytes before the
# first authentication check can run, so a tampered header naming an absurd
# cost otherwise makes an honest reader allocate gigabytes — or name a cost
# hashlib refuses under our own maxmem, turning "tampered" into a bare
# ValueError (backend/app/backup_crypto.py:57-64).
MAX_N, MAX_R, MAX_P = 1 << 18, 16, 4
KDF_MEM_CAP = 128 * 1024 * 1024
SCRYPT_MAXMEM = 256 * 1024 * 1024

CHUNK = 4 * 1024 * 1024
MAX_CHUNK = 64 * 1024 * 1024
MAX_HEADER = 4096
TAG_LEN = 16

# ONE sentence for every decryption failure, identical here and in
# nova_restore.py and pinned character-for-character by test_novaenc.py.
# GCM genuinely cannot distinguish a wrong passphrase from a corrupt file,
# and pretending otherwise is what produces "the passphrase must be right,
# so the file must be broken" at 3am (§7.1).
BAD_DECRYPT = (
    "decryption failed — wrong passphrase, or the file is corrupt, truncated "
    "or tampered with (GCM cannot tell these apart)"
)

# 64 known bytes, sealed under the same passphrase with their OWN fresh salt,
# so a decryptor and a passphrase are proven before a payload byte is read.
KAT_PLAINTEXT = (b"nova NOVAENC1 known-answer test vector v1 " * 2)[:64]
assert len(KAT_PLAINTEXT) == 64


class CryptoError(Exception):
    """Wrong passphrase, or the file is corrupt/tampered/truncated, or a
    header this reader will not obey. Never a bare ValueError, never a bare
    MemoryError — a stranded operator needs a sentence, not a traceback."""


def derive_key(passphrase: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    if not passphrase:
        raise CryptoError("an empty passphrase is not a passphrase")
    return hashlib.scrypt(
        passphrase.encode("utf-8"), salt=salt, n=n, r=r, p=p, maxmem=SCRYPT_MAXMEM, dklen=DKLEN
    )


def _aad(header_bytes: bytes, index: int, final: bool) -> bytes:
    """magic ‖ header ‖ uint64be(index) ‖ final flag.

    Authenticates the header AND the frame's position in the sequence, which
    is what makes a truncated file fail instead of quietly yielding a shorter
    archive — the one that matters for a backup.
    """
    return MAGIC + header_bytes + struct.pack(">Q", index) + (b"\x01" if final else b"\x00")


def _nonce(prefix: bytes, index: int) -> bytes:
    return prefix + struct.pack(">Q", index)


def is_encrypted(path: str) -> bool:
    try:
        with open(path, "rb") as fh:
            return fh.read(len(MAGIC)) == MAGIC
    except OSError:
        return False


def parse_header(fh) -> dict[str, Any]:
    """The KDF/cipher parameters, WITHOUT the key, from an open file left
    positioned at the first frame.

    Every value here is attacker-writable until the first frame
    authenticates, so each is validated as a REFUSAL and the cost caps are
    checked before `derive_key` is ever called.
    """
    if fh.read(len(MAGIC)) != MAGIC:
        raise CryptoError("not a NOVAENC1 file")
    raw = fh.read(4)
    if len(raw) != 4:
        raise CryptoError("truncated before the header")
    hlen = struct.unpack(">I", raw)[0]
    if hlen > MAX_HEADER:
        raise CryptoError("implausible header size — corrupt or tampered")
    hbytes = fh.read(hlen)
    if len(hbytes) != hlen:
        raise CryptoError("truncated inside the header")
    try:
        header = json.loads(hbytes.decode("utf-8"))
    except ValueError as exc:
        raise CryptoError(f"header is not JSON: {exc}") from exc
    if not isinstance(header, dict):
        raise CryptoError("header is not a JSON object — corrupt or tampered")
    # LOWERCASE "aes-256-gcm". backend/app/backup_crypto.py:119 rejects any
    # other spelling as `unsupported format`, so writing "AES-256-GCM" here
    # would break the stated ability to open a v3-written payload.
    if (
        header.get("v") != 1
        or header.get("cipher") != "aes-256-gcm"
        or header.get("kdf") != "scrypt"
    ):
        raise CryptoError(f"unsupported format: {header}")
    n, r, p = header.get("n", 0), header.get("r", 0), header.get("p", 0)
    if not (
        isinstance(n, int)
        and isinstance(r, int)
        and isinstance(p, int)
        and not isinstance(n, bool)
        and not isinstance(r, bool)
        and not isinstance(p, bool)
        and 0 < n <= MAX_N
        and 0 < r <= MAX_R
        and 0 < p <= MAX_P
        and (n & (n - 1)) == 0
        and 128 * r * n <= KDF_MEM_CAP
    ):
        raise CryptoError(
            f"scrypt cost n={n} r={r} p={p} is outside what this reader will pay for "
            "— the header may be tampered with"
        )
    chunk = header.get("chunk")
    if not (isinstance(chunk, int) and not isinstance(chunk, bool) and 0 < chunk <= MAX_CHUNK):
        raise CryptoError("implausible chunk size — corrupt or tampered")
    for field_name, length in (("salt", 16), ("nonce_prefix", 4)):
        value = header.get(field_name)
        try:
            if len(bytes.fromhex(value)) != length:
                raise ValueError
        except (TypeError, ValueError):
            raise CryptoError(
                f"header {field_name} is not {length} bytes of hex — corrupt or tampered"
            ) from None
    header["_bytes"] = hbytes
    return header


def read_header(path: str) -> dict[str, Any]:
    with open(path, "rb") as fh:
        return parse_header(fh)


def _read_frame(fh, chunk: int) -> bytes | None:
    raw = fh.read(4)
    if not raw:
        return None
    if len(raw) != 4:
        raise CryptoError("truncated mid-frame")
    clen = struct.unpack(">I", raw)[0]
    if not (TAG_LEN <= clen <= chunk + TAG_LEN):
        raise CryptoError(f"implausible frame of {clen} bytes — corrupt")
    ct = fh.read(clen)
    if len(ct) != clen:
        raise CryptoError("truncated inside a frame")
    return ct


def encrypt_stream(fin, fout, passphrase: str, size: int, chunk: int = CHUNK) -> dict[str, Any]:
    """`size` plaintext bytes from `fin` into `fout` as NOVAENC1.

    Returns the header that was written (without `_bytes`), because the
    caller needs its salt to derive the cleartext fingerprint (§7.4).
    """
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    salt, prefix = secrets.token_bytes(16), secrets.token_bytes(4)
    header = {
        "v": 1,
        "cipher": "aes-256-gcm",
        "kdf": "scrypt",
        "n": SCRYPT_N,
        "r": SCRYPT_R,
        "p": SCRYPT_P,
        "salt": salt.hex(),
        "nonce_prefix": prefix.hex(),
        "chunk": chunk,
    }
    hbytes = json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8")
    aes = AESGCM(derive_key(passphrase, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P))
    fout.write(MAGIC)
    fout.write(struct.pack(">I", len(hbytes)))
    fout.write(hbytes)
    index, done = 0, 0
    while True:
        plain = fin.read(chunk)
        done += len(plain)
        # `final` is decided by POSITION, never by a short read: the last
        # frame of an exact-multiple file is full length
        # (backend/app/backup_crypto.py:169-171).
        final = done >= size
        ct = aes.encrypt(_nonce(prefix, index), plain, _aad(hbytes, index, final))
        fout.write(struct.pack(">I", len(ct)))
        fout.write(ct)
        index += 1
        if final:
            break
    if done != size:
        raise CryptoError(f"read {done} plaintext bytes but was told to expect {size}")
    return header


def decrypt_stream(fin, fout, passphrase: str) -> dict[str, Any]:
    """NOVAENC1 from `fin` into `fout`. Any failure raises CryptoError and
    leaves `fout` incomplete; every caller here works in a temp dir precisely
    so a half-decrypted file can never be mistaken for a finished one."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    header = parse_header(fin)
    hbytes = header.pop("_bytes")
    try:
        salt = bytes.fromhex(header["salt"])
        prefix = bytes.fromhex(header["nonce_prefix"])
        aes = AESGCM(derive_key(passphrase, salt, header["n"], header["r"], header["p"]))
    except CryptoError:
        raise
    except Exception as exc:  # noqa: BLE001 — belt and braces over parse_header
        raise CryptoError(f"unusable header: {type(exc).__name__}: {exc}") from exc
    index, written = 0, 0
    frame = _read_frame(fin, header["chunk"])
    if frame is None:
        raise CryptoError("no ciphertext at all — the file is truncated")
    while frame is not None:
        # Finality at READ time is decided by LOOKAHEAD: the next frame
        # header is read before this one is decrypted, so the last frame's
        # AAD carries the final flag and a truncation fails authentication
        # (backend/app/backup_crypto.py:203-213).
        nxt = _read_frame(fin, header["chunk"])
        final = nxt is None
        try:
            plain = aes.decrypt(_nonce(prefix, index), frame, _aad(hbytes, index, final))
        except Exception as exc:  # noqa: BLE001 — InvalidTag, deliberately widened
            raise CryptoError(BAD_DECRYPT) from exc
        fout.write(plain)
        written += len(plain)
        frame, index = nxt, index + 1
    header["bytes"] = written
    return header


def encrypt_file(src: str, dst: str, passphrase: str, chunk: int = CHUNK) -> dict[str, Any]:
    size = os.stat(src).st_size
    with open(src, "rb") as fin, open(dst, "wb") as fout:
        return encrypt_stream(fin, fout, passphrase, size, chunk)


def decrypt_file(src: str, dst: str, passphrase: str) -> dict[str, Any]:
    with open(src, "rb") as fin, open(dst, "wb") as fout:
        return decrypt_stream(fin, fout, passphrase)


def encrypt_bytes(data: bytes, passphrase: str, chunk: int = CHUNK) -> bytes:
    out = io.BytesIO()
    encrypt_stream(io.BytesIO(data), out, passphrase, len(data), chunk)
    return out.getvalue()


def decrypt_bytes(blob: bytes, passphrase: str) -> bytes:
    out = io.BytesIO()
    decrypt_stream(io.BytesIO(blob), out, passphrase)
    return out.getvalue()


def generate_passphrase() -> str:
    """160 bits, grouped for a human writing it on paper: 8 groups of 4
    lowercase base32 characters.

    Generated HERE and never by `openssl rand 20` captured with `$( )`: bash
    drops NUL bytes and strips trailing newlines from a command substitution,
    so roughly one generated passphrase in thirteen would silently carry less
    than 160 bits, undetectably (§7.2).
    """
    raw = base64.b32encode(secrets.token_bytes(20)).decode("ascii").lower()
    return "-".join(raw[i : i + 4] for i in range(0, 32, 4))


def key_fingerprint(
    passphrase: str, salt: bytes, n: int = SCRYPT_N, r: int = SCRYPT_R, p: int = SCRYPT_P
) -> str:
    """sha256(scrypt(passphrase, THIS FILE'S salt))[:12] — §7.4.

    NOT sha256(passphrase)[:12]. That form is v3's, it lives in cleartext
    meta, and it lets an attacker holding the bundle test candidates at one
    unsalted SHA-256 each and pay scrypt once for the confirmed hit —
    annulling the entire work factor against an operator-chosen passphrase.
    Under this form each guess costs one scrypt, which is the whole point of
    having one.
    """
    return hashlib.sha256(derive_key(passphrase, salt, n, r, p)).hexdigest()[:12]


def passphrase_sha256_12(passphrase: str) -> str:
    """The RAW form, kept ONLY inside the encrypted manifest — behind the
    thing it identifies (§7.4). Never written to meta.json."""
    return hashlib.sha256(passphrase.encode("utf-8")).hexdigest()[:12]


def file_fingerprint(path: str, passphrase: str) -> str:
    header = read_header(path)
    return key_fingerprint(
        passphrase, bytes.fromhex(header["salt"]), header["n"], header["r"], header["p"]
    )


FINGERPRINT_KIND = "scrypt-key"


# ── hashing (§5.5) ──────────────────────────────────────────────────────────


def sha256_file(path: str) -> tuple[str, int]:
    h, total = hashlib.sha256(), 0
    with open(path, "rb") as fh:
        while True:
            block = fh.read(1 << 20)
            if not block:
                break
            h.update(block)
            total += len(block)
    return h.hexdigest(), total


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _mode_octal(mode: int) -> str:
    """GNU find's `%#m`: octal with a leading 0, and a bare `0` for zero."""
    bits = mode & 0o7777
    return "0" if bits == 0 else f"0{bits:o}"


def tree_listing(root: str) -> str:
    """§5.5's listing, byte-identical to what step 12's container produces.

        d 0755 0 0 ./people
        f 0644 1000 1000 ./people/example
        l 0777 1000 1000 ./people/current
        <sha256>  ./people/example/a-note.md

    Type, mode, uid and gid for EVERY entry first, all LC_ALL=C sorted, then
    one content-hash line per regular file. A `find . -type f` listing alone
    cannot detect a missing symlink, a lost empty directory or a changed
    mode, all of which are inside the tar.
    """
    meta: list[str] = []
    hashes: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(dirnames + filenames):
            full = os.path.join(dirpath, name)
            rel = "./" + os.path.relpath(full, root).replace(os.sep, "/")
            st = os.lstat(full)
            if stat.S_ISLNK(st.st_mode):
                kind = "l"
            elif stat.S_ISDIR(st.st_mode):
                kind = "d"
            elif stat.S_ISREG(st.st_mode):
                kind = "f"
            else:
                raise BundleError(f"{rel}: a listing cannot describe a {stat.S_IFMT(st.st_mode):o}")
            meta.append(f"{kind} {_mode_octal(st.st_mode)} {st.st_uid} {st.st_gid} {rel}")
            if kind == "l":
                # WHERE a link points is data. §5.5's four columns record that
                # a link exists and nothing about its target, so repointing
                # `./people/current` from one person's notes to another's
                # passed pack, verify and the reader. A backup that cannot
                # notice its own data being repointed is not verifying it.
                meta.append(f"L {rel} -> {os.readlink(full)}")
            if kind == "f":
                digest, _ = sha256_file(full)
                hashes.append(f"{digest}  {rel}")
    meta.sort()
    hashes.sort()
    lines = meta + hashes
    return "".join(line + "\n" for line in lines)


def parse_listing(
    listing: str,
) -> tuple[dict[str, str], dict[str, str], dict[str, str], list[str]]:
    """(metadata per ./path, sha256 per ./path, link target per ./path, bad lines).

    Parses rather than regenerates, on purpose: the listing that ships is
    written by `find` + `sha256sum` inside a container (§9.1 step 12) and this
    side must not have to reproduce that byte for byte to be able to check it.

    Three line kinds, and the third is new:

        d 0755 0 0 ./people                       type, mode, uid, gid
        L ./people/current -> example             a symlink's TARGET
        <sha256>  ./people/example/a-note.md      a regular file's content

    `L` is a separate line rather than a sixth column so the four-column lines
    are untouched: `%y %#m %U %G %p` still produces them, and the container
    adds one more pass. The target is last and split off the RIGHT, so a path
    containing ` -> ` still parses.
    """
    meta: dict[str, str] = {}
    hashes: dict[str, str] = {}
    links: dict[str, str] = {}
    problems: list[str] = []
    for line in listing.splitlines():
        if not line:
            continue
        if line.startswith("L "):
            path, sep, target = line[2:].rpartition(" -> ")
            if not sep:
                problems.append(f"{line!r}: unreadable listing line")
                continue
            links[path] = target
        elif line[:1] in ("d", "f", "l") and line[1:2] == " ":
            parts = line.split(" ", 4)
            if len(parts) != 5:
                problems.append(f"{line!r}: unreadable listing line")
                continue
            meta[parts[4]] = " ".join(parts[:4])
        else:
            digest, _, path = line.partition("  ")
            if not path:
                problems.append(f"{line!r}: unreadable listing line")
                continue
            hashes[path] = digest
    return meta, hashes, links, problems


def tar_member_record(member: tarfile.TarInfo) -> tuple[str, str]:
    """(`<kind> <mode> <uid> <gid>`, the link target) from the ARCHIVE'S own
    records rather than from the filesystem it was extracted onto."""
    return tar_member_metadata(member), member.linkname if member.issym() else ""


def tar_member_metadata(member: tarfile.TarInfo) -> str:
    """`<kind> <mode> <uid> <gid>` in §5.5's spelling, from the ARCHIVE'S own
    records rather than from the filesystem it was extracted onto."""
    if member.issym():
        kind = "l"
    elif member.isdir():
        kind = "d"
    elif member.isreg() or member.islnk():
        kind = "f"
    else:
        kind = "?"
    return f"{kind} {_mode_octal(member.mode)} {member.uid} {member.gid}"


def archived_tree_metadata(members, prefix: str) -> dict[str, tuple[str, str]]:
    """The recorded (metadata, link target) of every member under `prefix`."""
    stripped = prefix.rstrip("/") + "/"
    out: dict[str, tuple[str, str]] = {}
    for member in members:
        name = member.name
        if not name.startswith(stripped):
            continue
        out["./" + name[len(stripped) :]] = tar_member_record(member)
    return out


def verify_tree_against_listing(
    root: str, listing: str, archived: dict[str, tuple[str, str]] | None = None
) -> list[str]:
    """Every difference between a carried tree and its recorded listing.

    **Type, mode, uid and gid are compared against what the TAR RECORDS, not
    against what extraction produced**, and `archived` is that record. This is
    not a nicety. CPython's `data` extraction filter masks mode to `& 0o755`
    and drops uid/gid entirely, and `os.chown` during extraction is a no-op
    unless the extracting process is root — so an extracted tree can NEVER
    carry what `find -printf "%y %#m %U %G %p"` recorded on the live volume.
    Measured on 3.12.13: `f 0664 1000 1000` comes back `f 0644 <extractor>
    <extractor>`. Comparing the filesystem refused three entries of an
    ordinary markdown volume, and a `--move` bundle — uid 1000 for
    v4_memdata, root for v4_tailscale — could not be verified by ANY single
    extracting uid.

    Content is still re-derived from the extracted bytes, because that is the
    half extraction reproduces faithfully and the half that matters most.

    `archived=None` falls back to `lstat`, for a tree that did not come out of
    a tar at all (the drill re-derives one inside a container).
    """
    want_meta, want_hash, want_link, problems = parse_listing(listing)
    got: dict[str, tuple[str, str]] = dict(archived) if archived is not None else {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(dirnames + filenames):
            full = os.path.join(dirpath, name)
            rel = "./" + os.path.relpath(full, root).replace(os.sep, "/")
            if archived is None:
                st = os.lstat(full)
                kind = (
                    "l"
                    if stat.S_ISLNK(st.st_mode)
                    else "d"
                    if stat.S_ISDIR(st.st_mode)
                    else "f"
                    if stat.S_ISREG(st.st_mode)
                    else "?"
                )
                got[rel] = (
                    f"{kind} {_mode_octal(st.st_mode)} {st.st_uid} {st.st_gid}",
                    os.readlink(full) if kind == "l" else "",
                )
            if os.path.isfile(full) and not os.path.islink(full):
                digest, _ = sha256_file(full)
                if rel not in want_hash:
                    problems.append(f"{rel}: in the archive, absent from the listing")
                elif want_hash[rel] != digest:
                    problems.append(f"{rel}: content does not match its recorded checksum")
    for rel, want in sorted(want_meta.items()):
        record = got.get(rel)
        if record is None:
            problems.append(f"{rel}: named in the listing, absent from the archive")
            continue
        if record[0] != want:
            problems.append(
                f"{rel}: type/mode/uid/gid is `{record[0]}`, the listing recorded `{want}`"
            )
        if want.startswith("l "):
            if rel not in want_link:
                # Not a skip: a listing that names a link and records no
                # target cannot answer the question this check exists for.
                problems.append(f"{rel}: is a symlink and the listing records no target for it")
            elif want_link[rel] != record[1]:
                problems.append(
                    f"{rel}: points at `{record[1]}`, the listing recorded `{want_link[rel]}`"
                )
    for rel in sorted(set(got) - set(want_meta)):
        problems.append(f"{rel}: in the archive, absent from the listing")
    for rel in sorted(set(want_hash) - set(got)):
        problems.append(f"{rel}: named in the listing, absent from the archive")
    for rel in sorted(set(want_link) - set(want_meta)):
        problems.append(f"{rel}: the listing records a target for an entry it does not name")
    return sorted(set(problems))


# ── safe_extract (§9.2 step 5) ──────────────────────────────────────────────


class BundleError(Exception):
    """The archive is not what the manifest says it is, or a member of it is
    not something this code will write to disk."""


_ALWAYS_REFUSED = {
    tarfile.CHRTYPE: "a character device",
    tarfile.BLKTYPE: "a block device",
    tarfile.FIFOTYPE: "a fifo",
}


def _member_escapes(name: str) -> str:
    if name.startswith("/") or (len(name) > 1 and name[1] == ":"):
        return "an absolute path"
    parts = name.replace("\\", "/").split("/")
    if ".." in parts:
        return "a `..` component"
    return ""


def _link_escapes(member_name: str, target: str) -> str:
    """A link target that leaves the extraction root. An INTERNAL symlink is
    legitimate — §5.2 carries volume trees as plain members and §5.5's own
    example listing has one (`l 0777 … ./people/current`) — so the refusal is
    about escape, not about the entry type."""
    if target.startswith("/"):
        return "an absolute target"
    base = posixpath.dirname(member_name)
    resolved = posixpath.normpath(posixpath.join(base, target))
    if resolved == ".." or resolved.startswith("../"):
        return "a target outside the archive"
    return ""


def check_member(member) -> str:
    """Why this member will not be written to disk, or "" if it may be."""
    bad = _member_escapes(member.name)
    if bad:
        return f"{member.name}: {bad}"
    if member.type in _ALWAYS_REFUSED:
        return f"{member.name}: {_ALWAYS_REFUSED[member.type]}"
    if member.issym() or member.islnk():
        bad = _member_escapes(member.linkname) if member.islnk() else ""
        if bad:
            return f"{member.name}: a hard link to {bad}"
        bad = _link_escapes(member.name, member.linkname)
        if bad:
            kind = "a hard link" if member.islnk() else "a symlink"
            return f"{member.name}: {kind} with {bad}"
    return ""


def _ancestors(name: str) -> list[str]:
    parts = posixpath.normpath(name).split("/")
    return ["/".join(parts[:i]) for i in range(1, len(parts))]


def members_refusal(members) -> str:
    """Why this SET of members will not be extracted, or "".

    `check_member` judges each member alone, and that is not enough: a
    two-hop chain passes it and escapes anyway. `dir/x -> ".."` normalises to
    `"."` (contained); `dir/x/up -> ".."` normalises to `"dir"` (contained);
    `dir/x/up/PWNED` holds no `..` at all — but by the time it is written,
    `dir/x` is already a symlink to the root, so `dir/x/up` points at the
    root's PARENT. Measured: all four members return "" from check_member,
    and with the filter removed the file lands outside the destination.

    So the containment rule is enforced over the sequence: no member's path
    may pass THROUGH a member this archive has already declared a symlink.
    No legitimate archive does that — neither `tar -cf` nor python's
    `tarfile.add` follows a symlink, so a real tree never names a path
    through one.
    """
    symlinks: set[str] = set()
    for member in members:
        bad = check_member(member)
        if bad:
            return bad
        name = posixpath.normpath(member.name)
        for ancestor in _ancestors(name):
            # Case-folded as well as exact: on a case-insensitive filesystem
            # — APFS by default, and NTFS — `DIR/x` and `dir/x` are the same
            # path, so an exact-match set lets the next hop of a chain in
            # under a different spelling. Folding costs nothing on a
            # case-sensitive filesystem except refusing an archive carrying
            # two entries that differ only in case, which fails closed.
            if ancestor in symlinks or ancestor.lower() in symlinks:
                return (
                    f"{member.name}: its path goes through `{ancestor}`, which this same "
                    "archive declares a symlink — a chain like that escapes the target "
                    "one hop at a time"
                )
        if member.issym():
            symlinks.add(name)
            symlinks.add(name.lower())
    return ""


def safe_extract(tar: tarfile.TarFile, dest: str, members=None) -> list:
    """Extract, or refuse by name.

    No member escapes the target: no absolute path, no `..`, no link that
    resolves outside, no chain of links that gets there in two hops, no
    device node and no fifo. Proven with an adversarial tar built in
    tests/test_bundle_verify.py, not by argument — and proven with the
    extraction filter FORCED OFF, because `restore.sh` accepts python3 >= 3.9
    and the refusal has to be ours rather than the interpreter's.
    """
    chosen = list(tar.getmembers() if members is None else members)
    bad = members_refusal(chosen)
    if bad:
        raise BundleError(f"bundle member refused — {bad}")
    os.makedirs(dest, exist_ok=True)
    try:
        tar.extractall(dest, members=chosen, filter="data")
    except TypeError:  # python < 3.12 has no `filter` keyword
        # Nothing above us clears them on this path, and this code extracts
        # as root inside the pack container.
        for member in chosen:
            member.mode &= 0o777
        tar.extractall(dest, members=chosen)
    return chosen


# ── MANIFEST.json (§5.3) ────────────────────────────────────────────────────
#
# Loading is STRICT: a documented key that is absent, or a value of the wrong
# type, raises rather than defaulting, and an unknown key is an error —
# because a manifest this code does not fully understand is not a manifest it
# may restore from. `null` is a value, not an absence.

MANIFEST_FORMAT = "nova-backup/2"
BUNDLE_VERSION = 2
OUTER_VERSION = 1
TRANSPORTS = ("local", "tailnet", "removable")
MIGRATION_MATCHES = ("content",)
MEMBER_KINDS = ("db", "counts", "migrations", "listing", "tree", "file", "env")

# The GUCs every digest in a bundle is measured under, pinned with SET LOCAL
# in the SAME statement as the measurement (§9.1 step 9). A key restore does
# not know is a refusal: a digest measured under an unknown frame is not
# comparable (measurement-frames-outlive-their-code).
SESSION_GUCS = (
    "DateStyle",
    "IntervalStyle",
    "TimeZone",
    "bytea_output",
    "extra_float_digits",
    "lc_numeric",
)

STAMP_RE = re.compile(r"^[0-9]{8}T[0-9]{6}Z$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
HEX40_RE = re.compile(r"^[0-9a-f]{40}$")
HEX12_RE = re.compile(r"^[0-9a-f]{12}$")
SELFTEST_RE = re.compile(r"^nova_selftest_[0-9a-f]{8}$")
# Docker's own volume-name charset, and a conservative database-name one.
VOLUME_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$")
DB_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$")
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def path_refusal(value: Any, what: str) -> str:
    """Why this manifest path will not be joined onto anything, or "".

    EVERY path in a manifest is treated as hostile. It arrives inside
    `payload.enc`, which means whoever wrote it had the passphrase — and a
    bundle someone hands you along with its passphrase is exactly the case
    §7.6 and §9.2 contemplate. `safe_extract` already decided that a bundle's
    own bytes do not get to name a path on this machine; these are the paths
    that were not going through `safe_extract`.
    """
    if not isinstance(value, str) or not value:
        return f"{what} is not a path"
    if "\x00" in value or "\\" in value:
        return f"{what} {value!r} holds a NUL or a backslash"
    if value.startswith("/") or value.startswith("~"):
        return f"{what} {value!r} is absolute"
    if len(value) > 1 and value[1] == ":":
        return f"{what} {value!r} names a drive"
    parts = value.rstrip("/").split("/")
    if any(part in ("", ".", "..") for part in parts):
        return f"{what} {value!r} has an empty, `.` or `..` segment"
    return ""


def restore_to_refusal(value: Any) -> str:
    """`db:<name>` | `volume:<full name>` | a relative path, and nothing else.

    An unknown form refuses (§5.3). So, now, does a known form carrying a
    traversal: `volume:../../x` was accepted by the old shape check, and
    nova_restore.py joined it straight onto --out.
    """
    if not isinstance(value, str) or not value:
        return "restore_to is not a string"
    if value.startswith("db:"):
        name = value[3:]
        if not DB_NAME_RE.match(name):
            return f"restore_to {value!r} does not name a database"
        return ""
    if value.startswith("volume:"):
        name = value[7:]
        if not VOLUME_NAME_RE.match(name):
            return f"restore_to {value!r} does not name a docker volume"
        return ""
    return path_refusal(value, "restore_to")


class ManifestError(Exception):
    """The manifest is absent a documented key, carries one this code does
    not know, or holds a value of the wrong type."""


def _spec_str(spec: Any) -> str:
    if isinstance(spec, type):
        return spec.__name__
    return spec[0]


def _check(value: Any, spec: Any, where: str, problems: list[str]) -> None:
    if isinstance(spec, type):
        if spec is int and isinstance(value, bool):
            problems.append(f"{where}: expected int, got bool")
        elif not isinstance(value, spec):
            problems.append(f"{where}: expected {spec.__name__}, got {type(value).__name__}")
        return
    kind = spec[0]
    if kind == "opt":
        if value is None:
            return
        _check(value, spec[1], where, problems)
    elif kind == "exact":
        if value != spec[1]:
            problems.append(f"{where}: expected {spec[1]!r}, got {value!r}")
    elif kind == "one_of":
        if value not in spec[1]:
            problems.append(f"{where}: {value!r} is not one of {', '.join(map(str, spec[1]))}")
    elif kind == "re":
        if not isinstance(value, str) or not spec[1].match(value):
            problems.append(f"{where}: {value!r} does not match {spec[2]}")
    elif kind == "list":
        if not isinstance(value, list):
            problems.append(f"{where}: expected list, got {type(value).__name__}")
            return
        for i, item in enumerate(value):
            _check(item, spec[1], f"{where}[{i}]", problems)
    elif kind == "obj":
        if not isinstance(value, dict):
            problems.append(f"{where}: expected object, got {type(value).__name__}")
            return
        for key, sub in spec[1].items():
            if key not in value:
                problems.append(f"{where}.{key}: missing")
            else:
                _check(value[key], sub, f"{where}.{key}", problems)
        for key in value:
            if key not in spec[1]:
                problems.append(f"{where}.{key}: unknown key")
    elif kind == "exact_keys_str":
        if not isinstance(value, dict):
            problems.append(f"{where}: expected object, got {type(value).__name__}")
            return
        for key in spec[1]:
            if key not in value:
                problems.append(f"{where}.{key}: missing")
            elif not isinstance(value[key], str):
                problems.append(f"{where}.{key}: expected str")
        for key in value:
            if key not in spec[1]:
                problems.append(f"{where}.{key}: unknown key")
    elif kind == "nonempty_str":
        if not isinstance(value, str):
            problems.append(f"{where}: expected str, got {type(value).__name__}")
        elif not value.strip():
            problems.append(f"{where}: is empty, and this field is never empty")
    else:  # pragma: no cover — a spec this function does not implement
        raise AssertionError(f"unknown spec {kind!r}")


_HEX64 = ("re", HEX64_RE, "64 hex")
_HEX12 = ("re", HEX12_RE, "12 hex")
_STR_LIST = ("list", str)

MANIFEST_SPEC: dict[str, Any] = {
    "format": ("exact", MANIFEST_FORMAT),
    "bundle_version": ("exact", BUNDLE_VERSION),
    "created_at": ("re", STAMP_RE, "%Y%m%dT%H%M%SZ"),
    "mode": ("one_of", MODES),
    "transport": ("one_of", TRANSPORTS),
    "migration_match": ("one_of", MIGRATION_MATCHES),
    "source": (
        "obj",
        {
            "host": str,
            "os": str,
            "repo_sha": ("opt", ("re", HEX40_RE, "40 hex")),
            "repo_dirty": ("opt", bool),
            "project": ("nonempty_str",),
            "compose_files": _STR_LIST,
            "profiles": _STR_LIST,
            "docker_version": str,
            "compose_version": str,
            "pack_image_id": str,
        },
    ),
    "postgres": (
        "obj",
        {
            "server_version": str,
            "server_version_num": int,
            "pg_dump_version": str,
            "pg_dump_major": int,
            "container_image": str,
            "container_image_id": str,
        },
    ),
    "session": ("exact_keys_str", SESSION_GUCS),
    "databases": (
        "list",
        (
            "obj",
            {
                "name": ("nonempty_str",),
                "owner": ("nonempty_str",),
                "dump_member": str,
                "dump_bytes": int,
                "dump_sha256": _HEX64,
                "counts_member": str,
                "migrations_member": str,
                "tables": int,
                "rows": int,
                "selftest": (
                    "obj",
                    {
                        "scratch_db": ("re", SELFTEST_RE, "^nova_selftest_[0-9a-f]{8}$"),
                        "tables_compared": int,
                        "equal": ("exact", True),
                    },
                ),
            },
        ),
    ),
    "volumes": (
        "list",
        (
            "obj",
            {
                "key": ("nonempty_str",),
                "full_name": ("nonempty_str",),
                "disposition": ("one_of", DISPOSITIONS),
                "prefix": ("nonempty_str",),
                "listing_member": ("nonempty_str",),
                "listing_sha256": _HEX64,
                "entries": int,
                "files": int,
                "bytes": int,
                "restore_to": ("nonempty_str",),
            },
        ),
    ),
    "binds": (
        "list",
        (
            "obj",
            {
                "source": ("nonempty_str",),
                "target": ("nonempty_str",),
                "service": ("nonempty_str",),
                "disposition": ("one_of", DISPOSITIONS),
                "reason": str,
            },
        ),
    ),
    "files": (
        "list",
        (
            "obj",
            {
                "member": ("nonempty_str",),
                "origin": ("nonempty_str",),
                "restore_to": ("nonempty_str",),
                "mode": int,
                "bytes": int,
                "sha256": _HEX64,
            },
        ),
    ),
    "env_keys": _STR_LIST,
    "members": (
        "list",
        (
            "obj",
            {
                "path": ("nonempty_str",),
                "origin": ("nonempty_str",),
                "kind": ("one_of", MEMBER_KINDS),
                "bytes": int,
                "sha256": _HEX64,
                "restore_to": ("nonempty_str",),
            },
        ),
    ),
    "member_count": int,
    "excluded": (
        "list",
        (
            "obj",
            {
                "kind": ("nonempty_str",),
                "name": ("nonempty_str",),
                "disposition": ("one_of", DISPOSITIONS),
                "reason": ("nonempty_str",),
            },
        ),
    ),
    "coverage": (
        "obj",
        {
            "sources": _STR_LIST,
            "services": _STR_LIST,
            "entries": int,
            "refusals": ("list", dict),
        },
    ),
    "identity": (
        "obj",
        {
            "core_signing_key_sha256": ("opt", _HEX64),
            "tailnet_dns_name": ("opt", str),
            "tailnet_state_carried": bool,
            "device_count": int,
            "people_count": int,
        },
    ),
    "encryption": (
        "obj",
        {
            "container": ("exact", "NOVAENC1"),
            "cipher": ("exact", "aes-256-gcm"),
            "kdf": ("exact", "scrypt"),
            "n": int,
            "r": int,
            "p": int,
            "dklen": int,
            "chunk": int,
            "fingerprint_kind": ("exact", FINGERPRINT_KIND),
            "passphrase_sha256_12": _HEX12,
            "passphrase_source": ("nonempty_str",),
        },
    ),
    "reader_sha256": _HEX64,
}


def load_manifest(data: Any) -> dict[str, Any]:
    """§5.3's manifest, or a refusal that names every problem at once."""
    if not isinstance(data, dict):
        raise ManifestError(f"the manifest is a {type(data).__name__}, not an object")
    # v3's shape, refused BY NAME rather than by a type error twelve fields
    # later: its manifest.json has none of §5.3's structure and an operator
    # holding one needs to be told which tool opens it.
    if data.get("bundle_version") == 1:
        raise ManifestError(
            "bundle_version 1 is v3's bundle shape, which this tool does not restore. "
            "Open it with v3's scripts/nova_restore.py."
        )
    problems: list[str] = []
    _check(data, ("obj", MANIFEST_SPEC), "manifest", problems)
    if problems:
        raise ManifestError("; ".join(sorted(problems)))
    if data["member_count"] != len(data["members"]):
        raise ManifestError(
            f"manifest.member_count is {data['member_count']} and manifest.members holds "
            f"{len(data['members'])} rows"
        )
    if data["coverage"]["refusals"]:
        raise ManifestError(
            "manifest.coverage.refusals is not empty — a written bundle never carries a refusal"
        )
    for row in data["excluded"]:
        if not row["reason"].strip():
            raise ManifestError(f"excluded {row['name']}: every exclusion carries a reason")
    seen: set[str] = set()
    for row in data["members"]:
        if row["path"] in seen:
            raise ManifestError(f"manifest.members names {row['path']} twice")
        seen.add(row["path"])
    bad = _path_refusals(data)
    if bad:
        raise ManifestError("; ".join(bad))
    return data


def _path_refusals(data: dict[str, Any]) -> list[str]:
    """Every path-shaped value in the manifest, checked as hostile input."""
    bad: list[str] = []
    for i, row in enumerate(data["members"]):
        bad.append(path_refusal(row["path"], f"members[{i}].path"))
        bad.append(restore_to_refusal(row["restore_to"]))
    for i, row in enumerate(data["volumes"]):
        bad.append(path_refusal(row["prefix"], f"volumes[{i}].prefix"))
        bad.append(path_refusal(row["listing_member"], f"volumes[{i}].listing_member"))
        bad.append(restore_to_refusal(row["restore_to"]))
        if not VOLUME_NAME_RE.match(row["full_name"]):
            bad.append(f"volumes[{i}].full_name {row['full_name']!r} is not a volume name")
        if not VOLUME_NAME_RE.match(row["key"]):
            bad.append(f"volumes[{i}].key {row['key']!r} is not a compose key")
    for i, row in enumerate(data["files"]):
        bad.append(path_refusal(row["member"], f"files[{i}].member"))
        bad.append(path_refusal(row["origin"], f"files[{i}].origin"))
        bad.append(restore_to_refusal(row["restore_to"]))
    for i, row in enumerate(data["databases"]):
        for field_name in ("dump_member", "counts_member", "migrations_member"):
            bad.append(path_refusal(row[field_name], f"databases[{i}].{field_name}"))
        if not DB_NAME_RE.match(row["name"]):
            bad.append(f"databases[{i}].name {row['name']!r} is not a database name")
    for key in data["env_keys"]:
        if not isinstance(key, str) or not ENV_KEY_RE.match(key):
            bad.append(f"env_keys carries {key!r}, which is not a variable name")
    return [problem for problem in bad if problem]


def load_manifest_text(text: str) -> dict[str, Any]:
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise ManifestError(f"the manifest is not JSON: {exc}") from exc
    return load_manifest(data)


def dump_manifest(manifest: dict[str, Any]) -> str:
    """Written in §5.3's documented key order, so a human diffing two
    manifests reads them in the order the design documents them."""
    ordered = {key: manifest[key] for key in MANIFEST_SPEC}
    return json.dumps(ordered, indent=2, sort_keys=False) + "\n"


# ── meta.json (§5.4) — cleartext, UNAUTHENTICATED, advisory ─────────────────
#
# The rule, stated in README.txt and enforced in nova_restore.py: NOTHING
# THAT SURVIVES A FAILED DECRYPT IS DECIDED BY meta.json. It exists to list
# bundles without a passphrase, to choose a decryptor backend, to print the
# `docker pull` lines — and for the one named exception, choosing WHICH
# passphrase to try, which nothing else can answer before a decrypt (§2
# rejection 5). Every other value it duplicates is re-read from the
# authenticated manifest and compared; a disagreement is a refusal.

META_DUPLICATES = (
    ("format", "format"),
    ("bundle_version", "bundle_version"),
    ("created_at", "created_at"),
    ("mode", "mode"),
    ("transport", "transport"),
    ("source_host", None),
    ("member_count", "member_count"),
    ("reader_sha256", "reader_sha256"),
)


def build_meta(
    manifest: dict[str, Any],
    *,
    payload_bytes: int,
    payload_sha256: str,
    fingerprint: str,
    crypto_image: str,
    fallback_image: str,
    needs_images: list[str],
    chunk: int,
) -> dict[str, Any]:
    enc = manifest["encryption"]
    return {
        "outer_version": OUTER_VERSION,
        "encrypted": True,
        "format": manifest["format"],
        "bundle_version": manifest["bundle_version"],
        "created_at": manifest["created_at"],
        "mode": manifest["mode"],
        "transport": manifest["transport"],
        "source_host": manifest["source"]["host"],
        "member_count": manifest["member_count"],
        "bytes_payload": payload_bytes,
        "payload_sha256": payload_sha256,
        "passphrase_fingerprint": fingerprint,
        "fingerprint_kind": FINGERPRINT_KIND,
        "crypto": {
            "container": "NOVAENC1",
            "cipher": "aes-256-gcm",
            "kdf": "scrypt",
            "n": enc["n"],
            "r": enc["r"],
            "p": enc["p"],
            "chunk": chunk,
        },
        "crypto_image": crypto_image,
        "fallback_image": fallback_image,
        "needs_images": list(needs_images),
        "reader_sha256": manifest["reader_sha256"],
    }


def meta_disagreements(meta: dict[str, Any], manifest: dict[str, Any]) -> list[str]:
    """Every field cleartext meta duplicates from the authenticated manifest
    and got wrong. A disagreement is a refusal, never a preference."""
    out = []
    for meta_key, manifest_key in META_DUPLICATES:
        if manifest_key is None:
            continue
        if meta.get(meta_key) != manifest[manifest_key]:
            out.append(
                f"meta.{meta_key} is {meta.get(meta_key)!r} and the manifest says "
                f"{manifest[manifest_key]!r}"
            )
    if meta.get("source_host") != manifest["source"]["host"]:
        out.append(
            f"meta.source_host is {meta.get('source_host')!r} and the manifest says "
            f"{manifest['source']['host']!r}"
        )
    if meta.get("fingerprint_kind") != FINGERPRINT_KIND:
        out.append(
            f"meta.fingerprint_kind is {meta.get('fingerprint_kind')!r}, which this reader "
            f"does not know — it will not compare the wrong thing"
        )
    return out


# ── the archives (§5.1, §5.2) ───────────────────────────────────────────────

INNER_MANIFEST = "MANIFEST.json"
OUTER_README = "README.txt"
OUTER_READER = "nova_restore.py"
OUTER_SCRIPT = "restore.sh"
OUTER_KAT_SHA = "kat.sha256"
OUTER_KAT = "kat.enc"
OUTER_META = "meta.json"
OUTER_PAYLOAD = "payload.enc"

# Forced, not alphabetical (§5.1): member 7 is incompressible AEAD ciphertext
# and members 1-6 are under 60 KB together, so `tar -xOf <bundle> restore.sh`
# works on a many-GB file without streaming past the payload.
OUTER_ORDER = (
    OUTER_README,
    OUTER_READER,
    OUTER_SCRIPT,
    OUTER_KAT_SHA,
    OUTER_KAT,
    OUTER_META,
    OUTER_PAYLOAD,
)
OUTER_CLEARTEXT = OUTER_ORDER[:4] + (OUTER_META,)


def _tar_filter(info: tarfile.TarInfo) -> tarfile.TarInfo:
    """Numeric owner only. §5.2: python's tarfile records numeric uid/gid/mode
    directly, so restore extracts with --numeric-owner and a name that does
    not exist on the target can never silently become uid 0."""
    info.uname = ""
    info.gname = ""
    return info


def build_inner_archive(stage: str, manifest: dict[str, Any], out_path: str) -> int:
    """MANIFEST.json FIRST, then every member in the manifest's order.

    First because gzip cannot seek: listing a bundle otherwise means
    decompressing everything ahead of the member you want, and v3 measured
    3.4 s of pointless decompression on a 167 MB bundle before the order was
    forced (backend/app/backup_snapshot.py:298-305).
    """
    inner_root = os.path.join(stage, "inner")
    manifest_path = os.path.join(stage, INNER_MANIFEST)
    if not os.path.isfile(manifest_path):
        raise BundleError(f"{manifest_path}: the manifest to pack is not there")
    emitted = 0
    with open(out_path, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
                tar.add(manifest_path, arcname=INNER_MANIFEST, filter=_tar_filter)
                for row in manifest["members"]:
                    path = row["path"]
                    src = os.path.join(inner_root, path.rstrip("/"))
                    if row["kind"] == "tree":
                        if not os.path.isdir(src):
                            raise BundleError(
                                f"{path}: the manifest names a tree that is not there"
                            )
                        tar.add(src, arcname=path.rstrip("/"), recursive=True, filter=_tar_filter)
                    else:
                        if not os.path.isfile(src):
                            raise BundleError(
                                f"{path}: the manifest names a member that is not there"
                            )
                        tar.add(src, arcname=path, filter=_tar_filter)
                    emitted += 1
    return emitted


def build_outer_bundle(out_path: str, members: list[tuple[str, str]], mtime: int) -> None:
    """The outer tar, in §5.1's forced order, created O_EXCL and 0600 before
    the first byte: the bundle holds every secret this machine has."""
    names = [name for name, _ in members]
    if names != list(OUTER_ORDER):
        raise BundleError(f"outer members are {names}, and §5.1 forces {list(OUTER_ORDER)}")
    try:
        fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        # O_EXCL, not "overwrite if present": two runs in the same second
        # otherwise both compute the same <final> and one clobbers the very
        # bundle the other is publishing.
        raise BundleError(
            f"{out_path} already exists. This step never overwrites: pick another name, or "
            "let the caller's collision loop append -2."
        ) from exc
    except OSError as exc:
        raise BundleError(f"{out_path}: {exc}") from exc
    with os.fdopen(fd, "wb") as raw:
        with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
            for name, src in members:
                info = tarfile.TarInfo(name)
                info.size = os.stat(src).st_size
                info.mode = 0o600
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = mtime
                with open(src, "rb") as fh:
                    tar.addfile(info, fh)


def read_outer_member(bundle: str, name: str) -> bytes:
    with open_outer_tar(bundle) as tar:
        try:
            extracted = tar.extractfile(name)
        except KeyError:
            raise BundleError(f"{os.path.basename(bundle)} has no {name}") from None
        if extracted is None:
            raise BundleError(f"{name} is not a regular file in {os.path.basename(bundle)}")
        return extracted.read()


# ── verification (§9.1 steps 17 and 20, §9.2 step 5) ────────────────────────


def verify_inner(
    root: str, manifest: dict[str, Any], archived: dict[str, tuple[str, str]] | None = None
) -> list[str]:
    """Every member's sha256 RE-DERIVED from the extracted bytes.

    Deliberately not trusting the numbers the manifest recorded moments ago:
    the sha256-equality of a file the writer just wrote proves the writer can
    hash, and nothing else.

    `archived` is the tar's own `<kind> <mode> <uid> <gid>` per member, which
    is what a tree's listing is compared against — extraction cannot
    reproduce either half. `open_inner` returns it.
    """
    problems: list[str] = []
    accounted: set[str] = {INNER_MANIFEST}
    by_prefix = {v["prefix"]: v for v in manifest["volumes"]}
    for row in manifest["members"]:
        path = row["path"]
        target = os.path.join(root, path.rstrip("/"))
        if row["kind"] == "tree":
            if not os.path.isdir(target):
                problems.append(f"{path}: named in the manifest, absent from the archive")
                continue
            volume = by_prefix.get(path)
            if volume is None:
                problems.append(f"{path}: a tree member with no volumes[] row to describe it")
                continue
            listing_path = os.path.join(root, volume["listing_member"])
            if not os.path.isfile(listing_path):
                problems.append(
                    f"{volume['listing_member']}: the listing this tree is checked "
                    f"against is absent"
                )
                continue
            digest, _ = sha256_file(listing_path)
            if digest != row["sha256"]:
                problems.append(
                    f"{path}: its listing does not match the hash recorded for the tree"
                )
            if digest != volume["listing_sha256"]:
                problems.append(f"{path}: its listing does not match volumes[].listing_sha256")
            with open(listing_path, encoding="utf-8") as fh:
                listing = fh.read()
            under = archived_tree_metadata_from(archived, path) if archived is not None else None
            problems.extend(
                f"{path}{p.lstrip('./')}" if p.startswith("./") else f"{path}: {p}"
                for p in verify_tree_against_listing(target, listing, under)
            )
            for dirpath, _dirs, files in os.walk(target):
                for name in files:
                    full = os.path.join(dirpath, name)
                    accounted.add(os.path.relpath(full, root).replace(os.sep, "/"))
            continue
        if not os.path.isfile(target):
            problems.append(f"{path}: named in the manifest, absent from the archive")
            continue
        accounted.add(path)
        digest, size = sha256_file(target)
        if digest != row["sha256"]:
            problems.append(f"{path}: content does not match its recorded checksum")
        if size != row["bytes"]:
            problems.append(f"{path}: {size} bytes, the manifest recorded {row['bytes']}")
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            rel = os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/")
            if rel not in accounted:
                problems.append(f"{rel}: in the archive and named by no member of the manifest")
    return sorted(set(problems))


def archived_tree_metadata_from(
    archived: dict[str, tuple[str, str]], prefix: str
) -> dict[str, tuple[str, str]]:
    """The `archived` map narrowed to one tree prefix, keyed ./path."""
    stripped = prefix.rstrip("/") + "/"
    return {
        "./" + name[len(stripped) :]: value
        for name, value in archived.items()
        if name.startswith(stripped)
    }


def open_inner(path: str, dest: str) -> tuple[dict[str, Any], dict[str, tuple[str, str]]]:
    """Extract the inner archive into `dest`; return (manifest, archived).

    `archived` is `<kind> <mode> <uid> <gid>` per member name, taken from the
    TAR HEADERS before extraction touches them.

    The exception handler is broad on purpose: a truncated gzip raises
    EOFError, which is neither TarError nor OSError, and a narrower catch
    turns "corrupt" into an uncaught crash
    (backend/app/backup_snapshot.py:420-427).
    """
    try:
        with tarfile.open(path, "r:gz") as tar:
            first = tar.next()
            if first is None or first.name != INNER_MANIFEST:
                raise BundleError(
                    f"the inner archive's first member is "
                    f"{'nothing' if first is None else first.name!r}, and §5.2 forces "
                    f"{INNER_MANIFEST}"
                )
            extracted = tar.extractfile(first)
            if extracted is None:
                raise BundleError(f"{INNER_MANIFEST} is not a regular file")
            manifest = load_manifest_text(extracted.read().decode("utf-8"))
            tar.members = []
            members = safe_extract(tar, dest)
            archived = {m.name: tar_member_record(m) for m in members}
    except (BundleError, ManifestError, CryptoError):
        raise
    except Exception as exc:  # noqa: BLE001 — EOFError, TarError, OSError, zlib
        raise BundleError(
            f"the inner archive could not be read: {type(exc).__name__}: {exc}"
        ) from exc
    return manifest, archived


def _payload_into(src: str, passphrase: str, work: str) -> str:
    inner = os.path.join(work, "inner.tgz")
    decrypt_file(src, inner, passphrase)
    return inner


def kat_gate(kat_enc: bytes, kat_sha256: str, passphrase: str) -> None:
    """The known-answer test: 64 known bytes under the real passphrase with
    their OWN fresh salt. This is what lets a wrong passphrase be refused
    BEFORE a payload byte is read, instead of half-decrypting."""
    plain = decrypt_bytes(kat_enc, passphrase)
    if sha256_bytes(plain) != kat_sha256.strip():
        raise CryptoError(BAD_DECRYPT)


def open_outer_tar(bundle: str):
    """The outer tar, or a stated refusal.

    A truncated or damaged outer tar raises tarfile.ReadError, which is
    neither CryptoError nor BundleError — and a traceback naming a python
    module is not what a stranded operator needs. Every way this file can be
    unreadable states the same kind of sentence.
    """
    return _OuterTar(bundle)


class _OuterTar:
    """A tarfile whose every read states a refusal instead of raising a
    tarfile error. `tarfile.open` succeeds on a file truncated after the
    first member header and only fails when the member list is walked, so
    wrapping the open alone would still leave a bare ReadError in front of
    the operator."""

    def __init__(self, bundle: str):
        self.bundle = bundle
        try:
            self.tar = tarfile.open(bundle, "r:")
        except tarfile.TarError as exc:
            raise self._refusal(exc) from exc
        except OSError as exc:
            raise BundleError(f"{bundle}: {exc}") from exc

    def _refusal(self, exc: Exception) -> BundleError:
        return BundleError(
            f"{os.path.basename(self.bundle)} is not a readable tar: "
            f"{type(exc).__name__}: {exc}. It is truncated or damaged — check the copy "
            "that produced it."
        )

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.tar.close()
        return False

    def __getattr__(self, name):
        attribute = getattr(self.tar, name)
        if not callable(attribute):
            return attribute

        def guarded(*args, **kwargs):
            try:
                return attribute(*args, **kwargs)
            except tarfile.TarError as exc:
                raise self._refusal(exc) from exc
            except (EOFError, OSError) as exc:
                raise self._refusal(exc) from exc

        return guarded


def verify_bundle(
    bundle: str, passphrase: str, work: str, *, reader_dir: str | None = None
) -> dict:
    """Open a finished bundle and check everything in it against itself.

    The KAT runs BEFORE a single payload byte is written anywhere. That is
    what the known-answer test is for: on a many-GB bundle read off a
    removable drive, a wrong passphrase must cost nothing but one scrypt.
    """
    with open_outer_tar(bundle) as tar:
        names = [m.name for m in tar.getmembers()]
        if names != list(OUTER_ORDER):
            raise BundleError(f"outer members are {names}, and §5.1 forces {list(OUTER_ORDER)}")
        blobs = {}
        for name in OUTER_ORDER:
            if name == OUTER_PAYLOAD:
                continue
            handle = tar.extractfile(name)
            blobs[name] = b"" if handle is None else handle.read()
        kat_gate(blobs[OUTER_KAT], blobs[OUTER_KAT_SHA].decode("utf-8"), passphrase)
        payload = os.path.join(work, OUTER_PAYLOAD)
        safe_extract(tar, work, members=[tar.getmember(OUTER_PAYLOAD)])
    meta = json.loads(blobs[OUTER_META].decode("utf-8"))
    payload_sha256, payload_bytes = sha256_file(payload)
    inner = _payload_into(payload, passphrase, work)
    root = os.path.join(work, "inner")
    os.makedirs(root, mode=0o700, exist_ok=True)
    manifest, archived = open_inner(inner, root)
    problems = verify_inner(root, manifest, archived)
    problems.extend(meta_disagreements(meta, manifest))
    if meta.get("payload_sha256") != payload_sha256:
        problems.append("meta.payload_sha256 does not match the payload this bundle carries")
    if meta.get("bytes_payload") != payload_bytes:
        problems.append("meta.bytes_payload does not match the payload this bundle carries")
    reader_sha256 = sha256_bytes(blobs[OUTER_READER])
    if reader_sha256 != manifest["reader_sha256"]:
        problems.append(
            "the nova_restore.py inside this bundle is not the one manifest.reader_sha256 names"
        )
    if reader_dir is not None:
        for name in (OUTER_READER, OUTER_SCRIPT):
            with open(os.path.join(reader_dir, name), "rb") as fh:
                if fh.read() != blobs[name]:
                    problems.append(f"{name} in the bundle is not byte-identical to the git copy")
    return {
        "manifest": manifest,
        "meta": meta,
        "problems": problems,
        "payload_sha256": payload_sha256,
        "reader_sha256": reader_sha256,
        "root": root,
    }


# ── plan: assembling MANIFEST.json (§9.1 step 15) ───────────────────────────
#
# Everything the SHELL knows and this side cannot derive arrives in one fact
# file, `facts/manifest-base.json`; everything that can be derived from the
# staged tree and from coverage() is derived here, so the two can never
# disagree about what the bundle holds.

PLAN_BASE = "manifest-base.json"
PLAN_BASE_KEYS = (
    "created_at",
    "mode",
    "transport",
    "source",
    "postgres",
    "session",
    "databases",
    "identity",
    "passphrase_source",
    "excluded",
)


def _listing_counts(path: str) -> tuple[int, int]:
    """(every entry, regular files only) from a §5.5 listing file."""
    entries = files = 0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            if line[:1] in ("d", "f", "l") and line[1:2] == " ":
                entries += 1
                if line[:1] == "f":
                    files += 1
    return entries, files


def _tree_bytes(root: str) -> int:
    total = 0
    for dirpath, _dirs, names in os.walk(root):
        for name in names:
            full = os.path.join(dirpath, name)
            st = os.lstat(full)
            if stat.S_ISREG(st.st_mode):
                total += st.st_size
    return total


def build_manifest(
    base: dict[str, Any],
    stage: str,
    entries: list[Entry],
    services: list[str],
    *,
    passphrase: str,
    reader_path: str,
    chunk: int = CHUNK,
) -> dict[str, Any]:
    missing = [key for key in PLAN_BASE_KEYS if key not in base]
    if missing:
        raise ManifestError(f"facts/{PLAN_BASE} is missing {', '.join(missing)}")
    unknown = [key for key in base if key not in PLAN_BASE_KEYS]
    if unknown:
        raise ManifestError(
            f"facts/{PLAN_BASE} carries keys this tool does not know: {', '.join(sorted(unknown))}"
        )
    mode = base["mode"]
    inner = os.path.join(stage, "inner")
    carried_class = list(INCLUDE_CLASS) + ([CARRY_ON_MOVE] if mode == "move" else [])

    volumes: list[dict[str, Any]] = []
    members: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = list(base["excluded"])

    for entry in sorted(entries, key=lambda e: (e.kind, e.name)):
        if entry.disposition.startswith("exclude-") or (
            entry.disposition == CARRY_ON_MOVE and mode != "move"
        ):
            excluded.append(
                {
                    "kind": entry.kind,
                    "name": entry.name,
                    "disposition": entry.disposition,
                    "reason": entry.reason,
                }
            )

    for db in base["databases"]:
        for key, kind in (
            ("dump_member", "db"),
            ("counts_member", "counts"),
            ("migrations_member", "migrations"),
        ):
            path = db[key]
            target = os.path.join(inner, path)
            if not os.path.isfile(target):
                raise BundleError(f"{path}: facts/{PLAN_BASE} names it and it is not staged")
            digest, size = sha256_file(target)
            members.append(
                {
                    "path": path,
                    "origin": f"postgres:{db['name']}",
                    "kind": kind,
                    "bytes": size,
                    "sha256": digest,
                    "restore_to": f"db:{db['name']}",
                }
            )

    for entry in sorted(entries, key=lambda e: e.name):
        if entry.kind not in ("volume", "anon") or entry.disposition not in carried_class:
            continue
        key = entry.name
        full_name = entry.full_name or key
        prefix = f"volumes/{key}/"
        listing_member = f"listings/{key}.sha256"
        listing_path = os.path.join(inner, listing_member)
        tree_path = os.path.join(inner, "volumes", key)
        if not os.path.isfile(listing_path):
            raise BundleError(
                f"{listing_member}: volume `{key}` is carried and its listing is not staged"
            )
        if not os.path.isdir(tree_path):
            raise BundleError(f"{prefix}: volume `{key}` is carried and its tree is not staged")
        listing_sha256, listing_bytes = sha256_file(listing_path)
        count_entries, count_files = _listing_counts(listing_path)
        volumes.append(
            {
                "key": key,
                "full_name": full_name,
                "disposition": entry.disposition,
                "prefix": prefix,
                "listing_member": listing_member,
                "listing_sha256": listing_sha256,
                "entries": count_entries,
                "files": count_files,
                "bytes": _tree_bytes(tree_path),
                "restore_to": f"volume:{full_name}",
            }
        )
        members.append(
            {
                "path": listing_member,
                "origin": f"volume:{full_name}",
                "kind": "listing",
                "bytes": listing_bytes,
                "sha256": listing_sha256,
                "restore_to": f"volume:{full_name}",
            }
        )
        members.append(
            {
                "path": prefix,
                "origin": f"volume:{full_name}",
                "kind": "tree",
                "bytes": volumes[-1]["bytes"],
                # §5.5: a tree has no single file to hash, so its recorded
                # hash is its LISTING file's bytes, and the listing is what
                # restore diffs against.
                "sha256": listing_sha256,
                "restore_to": f"volume:{full_name}",
            }
        )

    files: list[dict[str, Any]] = []
    files_root = os.path.join(inner, "files")
    for dirpath, dirnames, names in os.walk(files_root):
        dirnames.sort()
        for name in sorted(names):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, files_root).replace(os.sep, "/")
            digest, size = sha256_file(full)
            files.append(
                {
                    "member": f"files/{rel}",
                    "origin": rel,
                    "restore_to": rel,
                    "mode": os.stat(full).st_mode & 0o777,
                    "bytes": size,
                    "sha256": digest,
                }
            )
    files.sort(key=lambda row: row["member"])
    for row in files:
        members.append(
            {
                "path": row["member"],
                "origin": row["origin"],
                "kind": "file",
                "bytes": row["bytes"],
                "sha256": row["sha256"],
                "restore_to": row["restore_to"],
            }
        )

    env_keys: list[str] = []
    env_member = "env/carried.env"
    env_path = os.path.join(inner, env_member)
    if os.path.isfile(env_path):
        with open(env_path, encoding="utf-8") as fh:
            for line in fh:
                key = line.split("=", 1)[0].strip()
                if key and not key.startswith("#"):
                    env_keys.append(key)
        digest, size = sha256_file(env_path)
        members.append(
            {
                "path": env_member,
                "origin": "deploy/.env",
                "kind": "env",
                "bytes": size,
                "sha256": digest,
                "restore_to": "deploy/.env",
            }
        )

    binds = [
        {
            "source": entry.name,
            "target": entry.target or "",
            "service": entry.service or "",
            "disposition": entry.disposition,
            "reason": entry.reason,
        }
        for entry in sorted(entries, key=lambda e: (e.name, e.service or "", e.target or ""))
        if entry.kind == "bind"
    ]

    reader_sha256, _ = sha256_file(reader_path)
    manifest = {
        "format": MANIFEST_FORMAT,
        "bundle_version": BUNDLE_VERSION,
        "created_at": base["created_at"],
        "mode": mode,
        "transport": base["transport"],
        "migration_match": "content",
        "source": base["source"],
        "postgres": base["postgres"],
        "session": base["session"],
        "databases": base["databases"],
        "volumes": volumes,
        "binds": binds,
        "files": files,
        "env_keys": env_keys,
        "members": members,
        "member_count": len(members),
        "excluded": excluded,
        "coverage": {
            "sources": sorted(FACT_NAMES),
            "services": sorted(services),
            "entries": len(entries),
            "refusals": [],
        },
        "identity": base["identity"],
        "encryption": {
            "container": "NOVAENC1",
            "cipher": "aes-256-gcm",
            "kdf": "scrypt",
            "n": SCRYPT_N,
            "r": SCRYPT_R,
            "p": SCRYPT_P,
            "dklen": DKLEN,
            "chunk": chunk,
            "fingerprint_kind": FINGERPRINT_KIND,
            "passphrase_sha256_12": passphrase_sha256_12(passphrase),
            "passphrase_source": base["passphrase_source"],
        },
        "reader_sha256": reader_sha256,
    }
    return load_manifest(manifest)


# ── the passphrase reaches exactly one place: stdin (§7.5) ──────────────────


def read_passphrase(stream=None) -> str:
    """The first line of stdin, consumed before anything else.

    Never argv, never `-e` (which `docker inspect` would show for the
    container's lifetime), never a positional argument, never a file the
    container mounts. This is also why the design refuses `openssl enc`
    outright: `openssl enc` and `openssl kdf` take the key in argv, so a
    shell-native cipher would put the backup passphrase in `ps` output.
    """
    line = (sys.stdin if stream is None else stream).readline()
    if not line:
        raise CryptoError("no passphrase on stdin — nothing was piped in")
    if line.endswith("\n"):
        line = line[:-1]
    if line.endswith("\r"):
        line = line[:-1]
    if not line:
        raise CryptoError("an empty passphrase is not a passphrase")
    return line


DEFAULT_CRYPTO_IMAGE = "nova-core"
DEFAULT_FALLBACK_IMAGE = "python:3.12-slim"
DEFAULT_NEEDS_IMAGES = ("postgres:16", "python:3.12-slim")


def _here(name: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), name)


def render_readme(template: str, values: dict[str, str]) -> str:
    text = template
    for key, value in values.items():
        text = text.replace(f"@{key}@", value)
    left = re.findall(r"@[A-Z_]+@", text)
    if left:
        raise BundleError(f"README.txt.in still holds {', '.join(sorted(set(left)))}")
    return text


# ── CLI verbs ───────────────────────────────────────────────────────────────


def cmd_genpass(args: argparse.Namespace) -> int:
    sys.stdout.write(generate_passphrase() + "\n")
    return 0


def cmd_kat(args: argparse.Namespace) -> int:
    """§9.1 step 14: prove THIS image can do NOVAENC1 with THIS passphrase,
    before anything is written."""
    passphrase = read_passphrase()
    blob = encrypt_bytes(KAT_PLAINTEXT, passphrase)
    back = decrypt_bytes(blob, passphrase)
    if back != KAT_PLAINTEXT:
        sys.stderr.write("Error: this image round-tripped NOVAENC1 to different bytes\n")
        return 1
    header = parse_header(io.BytesIO(blob))
    json.dump(
        {
            "kat": "ok",
            "container": "NOVAENC1",
            "cipher": "aes-256-gcm",
            "fingerprint": key_fingerprint(passphrase, bytes.fromhex(header["salt"])),
            "fingerprint_kind": FINGERPRINT_KIND,
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


def cmd_fingerprint(args: argparse.Namespace) -> int:
    """The CLEARTEXT fingerprint of §7.4 — derived from the scrypt KEY under
    one file's own salt, never from the passphrase."""
    passphrase = read_passphrase()
    if args.file:
        sys.stdout.write(file_fingerprint(args.file, passphrase) + "\n")
        return 0
    salt = bytes.fromhex(args.salt)
    if len(salt) != 16:
        sys.stderr.write("Error: --salt is 16 bytes of hex\n")
        return 1
    sys.stdout.write(key_fingerprint(passphrase, salt) + "\n")
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    passphrase = read_passphrase()
    facts = load_facts(args.facts)
    base_path = os.path.join(args.facts, PLAN_BASE)
    try:
        with open(base_path, encoding="utf-8") as fh:
            base = json.load(fh)
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"Error: {base_path}: {exc}\n")
        return 2
    entries, refusals = coverage(facts, base.get("mode", args.mode))
    if refusals:
        sys.stderr.write(render_refusals(refusals) + "\n")
        return 3
    services = list(facts["config"].get("services") or {})
    manifest = build_manifest(
        base,
        args.stage,
        entries,
        services,
        passphrase=passphrase,
        reader_path=args.reader or _here(OUTER_READER),
        chunk=args.chunk,
    )
    out = args.out or os.path.join(args.stage, INNER_MANIFEST)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(dump_manifest(manifest))
    json.dump(
        {
            "manifest": out,
            "member_count": manifest["member_count"],
            "volumes": len(manifest["volumes"]),
            "databases": len(manifest["databases"]),
            "excluded": len(manifest["excluded"]),
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


def cmd_pack(args: argparse.Namespace) -> int:
    """§9.1 steps 16, 18 and 19: the inner archive, the payload, the outer
    tar built as `<final>.part` with O_EXCL and mode 0600, and the chown the
    operator's own verification depends on."""
    passphrase = read_passphrase()
    stage = args.stage
    reader_dir = args.reader_dir or os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(stage, INNER_MANIFEST), encoding="utf-8") as fh:
        manifest = load_manifest_text(fh.read())
    if manifest["encryption"]["passphrase_sha256_12"] != passphrase_sha256_12(passphrase):
        sys.stderr.write(
            "Error: this manifest was planned under a different passphrase. Re-run `plan` "
            "with the passphrase this run will seal the bundle with.\n"
        )
        return 1

    inner_tgz = os.path.join(stage, "inner.tgz")
    emitted = build_inner_archive(stage, manifest, inner_tgz)
    if emitted != manifest["member_count"]:
        os.unlink(inner_tgz)
        sys.stderr.write(
            f"Error: packed {emitted} members and manifest.member_count is "
            f"{manifest['member_count']}\n"
        )
        return 1

    payload = os.path.join(stage, OUTER_PAYLOAD)
    chunk = manifest["encryption"]["chunk"]
    header = encrypt_file(inner_tgz, payload, passphrase, chunk)
    payload_sha256, payload_bytes = sha256_file(payload)

    kat_blob = encrypt_bytes(KAT_PLAINTEXT, passphrase)
    kat_salt = bytes.fromhex(parse_header(io.BytesIO(kat_blob))["salt"])
    # The cleartext fingerprint is derived under KAT.ENC's salt: it is the
    # one NOVAENC1 file in the bundle a reader can open whole before it has
    # chosen to spend anything on the payload (§7.4).
    fingerprint = key_fingerprint(passphrase, kat_salt)
    meta = build_meta(
        manifest,
        payload_bytes=payload_bytes,
        payload_sha256=payload_sha256,
        fingerprint=fingerprint,
        crypto_image=args.crypto_image,
        fallback_image=args.fallback_image,
        needs_images=args.needs_image or list(DEFAULT_NEEDS_IMAGES),
        chunk=chunk,
    )

    work = os.path.join(stage, "outer")
    os.makedirs(work, mode=0o700, exist_ok=True)
    final_name = os.path.basename(args.out)
    if final_name.endswith(".part"):
        final_name = final_name[: -len(".part")]
    with open(os.path.join(reader_dir, "README.txt.in"), encoding="utf-8") as fh:
        template = fh.read()
    readme = render_readme(
        template,
        {
            "BUNDLE": final_name,
            "CREATED_AT": manifest["created_at"],
            "HOST": manifest["source"]["host"],
            "FINGERPRINT": fingerprint,
            "READER_SHA256": manifest["reader_sha256"],
            "NEEDS_IMAGES": " ".join(meta["needs_images"]),
        },
    )
    staged: list[tuple[str, str]] = []
    for name, blob in (
        (OUTER_README, readme.encode("utf-8")),
        (OUTER_KAT_SHA, (sha256_bytes(KAT_PLAINTEXT) + "\n").encode("utf-8")),
        (OUTER_KAT, kat_blob),
        (OUTER_META, (json.dumps(meta, indent=2) + "\n").encode("utf-8")),
    ):
        path = os.path.join(work, name)
        with open(path, "wb") as fh:
            fh.write(blob)
        staged.append((name, path))
    # nova_restore.py and restore.sh travel BYTE-IDENTICAL to their git
    # copies — no templating, no stamping — so one published digest covers
    # every bundle for a given commit (§7.6).
    for name in (OUTER_READER, OUTER_SCRIPT):
        staged.append((name, os.path.join(reader_dir, name)))
    staged.append((OUTER_PAYLOAD, payload))
    by_name = dict(staged)
    build_outer_bundle(args.out, [(n, by_name[n]) for n in OUTER_ORDER], _stamp_epoch(manifest))

    if args.uid is not None and args.gid is not None:
        os.chown(args.out, args.uid, args.gid)
        st = os.stat(args.out)
        if (st.st_uid, st.st_gid) != (args.uid, args.gid):
            os.unlink(args.out)
            sys.stderr.write(
                f"Error: the chown to {args.uid}:{args.gid} did not take — the operator could "
                f"not read back the file this container wrote\n"
            )
            return 1
    st = os.stat(args.out)
    if stat.S_IMODE(st.st_mode) != 0o600:
        os.unlink(args.out)
        sys.stderr.write(f"Error: {args.out} is mode {stat.S_IMODE(st.st_mode):o}, not 600\n")
        return 1
    digest, size = sha256_file(args.out)
    json.dump(
        {
            "path": args.out,
            "bytes": size,
            "sha256": digest,
            "mode": "600",
            "uid": st.st_uid,
            "gid": st.st_gid,
            "member_count": manifest["member_count"],
            "payload_sha256": payload_sha256,
            "payload_bytes": payload_bytes,
            "payload_salt": header["salt"],
            "passphrase_fingerprint": fingerprint,
            "fingerprint_kind": FINGERPRINT_KIND,
            "reader_sha256": manifest["reader_sha256"],
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


def _stamp_epoch(manifest: dict[str, Any]) -> int:
    return calendar.timegm(time.strptime(manifest["created_at"], "%Y%m%dT%H%M%SZ"))


def cmd_verify(args: argparse.Namespace) -> int:
    """§9.1 step 17 (--payload, before the outer tar exists) and §9.1 step 20
    / §9.2 step 5 (--bundle, the finished file)."""
    passphrase = read_passphrase()
    work = tempfile.mkdtemp(prefix="novabundle-verify-")
    os.chmod(work, 0o700)
    try:
        if args.bundle:
            result = verify_bundle(args.bundle, passphrase, work, reader_dir=args.reader_dir)
            manifest, problems = result["manifest"], result["problems"]
        else:
            inner = _payload_into(args.payload, passphrase, work)
            root = os.path.join(work, "inner")
            os.makedirs(root, mode=0o700, exist_ok=True)
            manifest, archived = open_inner(inner, root)
            problems = verify_inner(root, manifest, archived)
        if problems:
            sys.stderr.write("Error: this bundle does not verify:\n")
            for problem in problems:
                sys.stderr.write(f"  {problem}\n")
            return 1
        json.dump(
            {
                "verified": True,
                "members": manifest["member_count"],
                "volumes": len(manifest["volumes"]),
                "databases": len(manifest["databases"]),
                "created_at": manifest["created_at"],
                "reader_sha256": manifest["reader_sha256"],
            },
            sys.stdout,
        )
        sys.stdout.write("\n")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=False)


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

    gen = sub.add_parser("genpass", help="a fresh 160-bit passphrase on stdout")
    gen.set_defaults(func=cmd_genpass)

    kat = sub.add_parser("kat", help="prove THIS image can do NOVAENC1 with THIS passphrase")
    kat.set_defaults(func=cmd_kat)

    fpr = sub.add_parser("fingerprint", help="the 12-hex cleartext fingerprint (§7.4)")
    group = fpr.add_mutually_exclusive_group(required=True)
    group.add_argument("--salt", help="16 bytes of hex — the salt to derive under")
    group.add_argument("--file", help="a NOVAENC1 file whose header salt to derive under")
    fpr.set_defaults(func=cmd_fingerprint)

    plan = sub.add_parser("plan", help="assemble MANIFEST.json from the facts and the stage")
    plan.add_argument("--facts", required=True)
    plan.add_argument("--stage", required=True, help="the staging directory holding inner/")
    plan.add_argument("--out", default=None, help="default: <stage>/MANIFEST.json")
    plan.add_argument("--mode", default="routine", choices=list(MODES))
    plan.add_argument("--reader", default=None, help="nova_restore.py, for reader_sha256")
    plan.add_argument("--chunk", type=int, default=CHUNK)
    plan.set_defaults(func=cmd_plan)

    pack = sub.add_parser("pack", help="the inner archive, the payload and the outer tar")
    pack.add_argument("--stage", required=True)
    pack.add_argument("--out", required=True, help="the <final>.part path, in $OUT")
    pack.add_argument("--reader-dir", default=None, help="where nova_restore.py and restore.sh are")
    pack.add_argument("--uid", type=int, default=None, help="NOVA_HOST_UID")
    pack.add_argument("--gid", type=int, default=None, help="NOVA_HOST_GID")
    pack.add_argument("--crypto-image", default=DEFAULT_CRYPTO_IMAGE)
    pack.add_argument("--fallback-image", default=DEFAULT_FALLBACK_IMAGE)
    pack.add_argument("--needs-image", action="append", default=None)
    pack.set_defaults(func=cmd_pack)

    ver = sub.add_parser("verify", help="re-derive every member's hash from the bytes on disk")
    target = ver.add_mutually_exclusive_group(required=True)
    target.add_argument("--bundle", help="a finished outer tar")
    target.add_argument("--payload", help="a NOVAENC1 payload, before the outer tar exists")
    ver.add_argument("--reader-dir", default=None, help="assert the carried reader is this one")
    ver.set_defaults(func=cmd_verify)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (CryptoError, BundleError, ManifestError, CoverageRefused) as exc:
        # A stated refusal, never a traceback: the person reading this is
        # restoring at 3am and needs a sentence.
        sys.stderr.write(f"Error: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
