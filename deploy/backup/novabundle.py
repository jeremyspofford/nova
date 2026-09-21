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
    return doc


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
