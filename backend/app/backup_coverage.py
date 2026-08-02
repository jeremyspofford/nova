"""What a backup must contain — DERIVED, never listed (roadmap #31, phase 1).

No bundle is produced here. This module answers one question: *what
persistent state does this stack have, and is every bit of it accounted
for?* It refuses rather than guessing, and that refusal is the entire point.

WHY THIS EXISTS RATHER THAN A LIST OF DIRECTORIES
-------------------------------------------------
Three places in this repo already carry a hand-maintained list of Nova's
state — `docs/plans/data-backups.md`, ROADMAP #31, and `secret_store.py`'s
own docstring — and on 2026-08-02 **all three were stale, in different
ways**. Measured against the live stack, the backup plan (12 days old) was
missing five tiers:

  * `./data/attachments` — the content-addressed original bytes of every
    document the operator attached. The DB dump carries the attachments
    INDEX and none of the BYTES, so a spec-conformant restore yields a table
    whose every row reads `present: false`. The photographed letter is gone
    and the operator finds out afterwards.
  * `/state/secret.key` — the spec says `./data/secret.key`, a path that
    does not exist and never will (`/app/data` is the container's overlay;
    `secret_store.py` documents the correction). A literal implementation
    archives a nonexistent file and reports success.
  * `/state/instance_id` — the spec thinks `/state` holds one file. It holds
    four. Every metric, trace and alert row is attributed to this id.
  * `./data/runtime` — the k8s ServiceAccount token, whose mere PRESENCE is
    the feature switch for the workload tools.
  * `.env` — the Postgres password and the auth token, and no container
    mounts it at all.

A list that is wrong five ways after twelve days is not a control. So the
set is derived from signals that move when the stack moves:

  1. INVENTORY — the union of the merged compose project (all profiles, so
     services that are DOWN still count) and the live mounts of every
     container in the project, including exited ones. Neither source alone
     is sufficient and both were measured: compose misses image-declared and
     anonymous volumes; container enumeration misses everything not running.
  2. BINDS — classified by git. A bind under the project that is TRACKED is
     code and restorable from the repo; a bind that is IGNORED is operator
     state and must be in the bundle. This is what kills the
     `./data/attachments` class of miss: the day that mount landed it would
     have been included with no code change at all, because it is gitignored.
  3. NAMED VOLUMES — the one maintained table, because git cannot see inside
     a volume. An entry that is not in it does not default to "skip"; it
     REFUSES.

`docker volume ls --filter label=com.docker.compose.project=nova` was
measured and rejected as an inventory source: it misses `nova_postgres_data`
outright (the volume predates compose labelling volumes) while including a
stale volume no compose file references. A backup derived from it omits the
database and reports success.
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional

log = logging.getLogger(__name__)

# ── dispositions ─────────────────────────────────────────────────────────

INCLUDE = "include"                # operator state; must be in the bundle
INCLUDE_PG = "include_via_pg_dump"  # a live PGDATA copy is torn; dump it
EXCLUDE_CODE = "exclude_code"      # in git; restore it from the repo
EXCLUDE_REDOWNLOAD = "exclude_redownloadable"
EXCLUDE_EPHEMERAL = "exclude_ephemeral"
EXCLUDE_DECLINED = "exclude_declined"   # deliberately out, with a reason
UNCLASSIFIED = "unclassified"      # the refusal state — never a default

_INCLUDING = {INCLUDE, INCLUDE_PG}

# Named volumes are the ONLY hand-maintained table in this module, because a
# volume has no git status to read. Each entry carries its reason so the
# operator can disagree with a decision rather than discover it. An entry
# absent from this table is UNCLASSIFIED and refuses — it does not fall
# through to "skip", which is how a new store goes missing quietly.
VOLUME_POLICY: dict[str, tuple[str, str]] = {
    "postgres_data": (
        INCLUDE_PG,
        "the core database. Copying a live PGDATA directory yields a torn "
        "snapshot, so this tier is captured by pg_dump and never as files."),
    "nova_state": (
        INCLUDE,
        "the per-host control volume: the secrets master key, the instance "
        "id, the model-store path, the ntfy base url. Taken WHOLE rather "
        "than file by file, so the next control file written beside them is "
        "covered without an edit here. Losing secret.key makes every "
        "encrypted secret unrecoverable, and it exists nowhere else."),
    "tailscale_state": (
        INCLUDE,
        "the tailnet node identity and private key. TS_AUTHKEY is consumed "
        "once, so losing this means re-authenticating the node by hand."),
    "ollama_models": (
        EXCLUDE_REDOWNLOAD,
        "local model weights — measured at 24.8 GB across the three model "
        "volumes. Re-pullable from the registry, so a bundle carrying them "
        "would be two orders of magnitude larger to save a download. The "
        "cost is real and worth stating: a restore on a disconnected machine "
        "comes up with no local inference until the pulls finish."),
    "whisper_models": (
        EXCLUDE_REDOWNLOAD,
        "speech-to-text weights, re-pullable. Same trade as ollama_models: a "
        "restored machine has no local transcription until it re-downloads."),
    "kokoro_models": (
        EXCLUDE_REDOWNLOAD,
        "text-to-speech weights, re-pullable. Same trade as ollama_models: a "
        "restored machine cannot speak until it re-downloads."),
    "ntfy_cache": (
        EXCLUDE_EPHEMERAL,
        "the notification server's delivery cache. It regenerates itself, "
        "and the only loss is undelivered messages queued at the moment of "
        "the snapshot — which a restore hours later would deliver as stale."),
    "coder_workspaces": (
        EXCLUDE_DECLINED,
        "disposable clones. `docker volume rm` is the documented cleanup "
        "story for them. NOTE this is a real gap and not a free one: a "
        "coding session records a commit_sha and no diff, so a restored DB "
        "can name commits that exist in no clone."),
}

# A bind whose source still contains an unexpanded ${VAR} was rendered
# without the environment that defines it. The compose DEFAULT must never be
# used: the one bind that uses a variable here is the memory store, so
# quietly falling back to `./data/memory` when NOVA_MEMORY_DIR points at a
# NAS would snapshot the wrong directory and pass every checksum it computed.
_UNEXPANDED = re.compile(r"\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*")
_ANON_RE = re.compile(r"[0-9a-f]{64}")


@dataclass
class Entry:
    """One persistent location and what we decided about it."""
    kind: str                      # "bind" | "volume"
    name: str                      # host path, or the volume's short name
    disposition: str
    reason: str
    sources: set = field(default_factory=set)   # where we learned about it
    mounted_at: Optional[str] = None
    service: Optional[str] = None

    @property
    def included(self) -> bool:
        return self.disposition in _INCLUDING

    def as_dict(self) -> dict:
        return {"kind": self.kind, "name": self.name,
                "disposition": self.disposition, "reason": self.reason,
                "sources": sorted(self.sources),
                "mounted_at": self.mounted_at, "included": self.included}


@dataclass
class Refusal:
    """Why no bundle may be produced. Carries what to DO about it — a
    refusal the operator cannot act on is just an outage."""
    code: str
    subject: str
    detail: str

    def as_dict(self) -> dict:
        return {"code": self.code, "subject": self.subject, "detail": self.detail}


# Host paths that are NOT operator state. The second maintained table, and
# it exists for the same reason as VOLUME_POLICY: the filesystem cannot tell
# a cache from a corpus. Unknown still REFUSES — this table only records
# decisions already made, so the operator classifies a path once instead of
# seeing it in every report forever.
PATH_POLICY: dict[str, tuple[str, str]] = {
    ".env": (INCLUDE,
             "POSTGRES_PASSWORD, NOVA_AUTH_TOKEN and every provider key. No "
             "container mounts it, so no docker-derived signal can see it — "
             "and a restore without it cannot open its own database."),
    ".claude": (EXCLUDE_DECLINED,
                "the coding assistant's own session state, not Nova's. "
                "Deliberately out: it is large, churny, and belongs to the "
                "tool rather than to the system being backed up."),
    ".worktrees": (EXCLUDE_DECLINED,
                   "scratch checkouts of this same repo; restorable from git"),
    "data": (EXCLUDE_DECLINED,
             "the parent of the individual data stores, each of which is "
             "classified on its own. Listed here so the PARENT does not "
             "refuse while its children are already covered — and so a NEW "
             "child still refuses, because it is matched on its own path."),
    "data/backups": (
        EXCLUDE_DECLINED,
        "the bundles themselves. Archiving the output directory into its own "
        "output makes every bundle contain all the previous ones — growth is "
        "geometric and the second backup is already twice the size it should "
        "be. Copy bundles off this machine instead; that is what they are "
        "for, and a backup that only lives inside the thing it backs up is "
        "not one."),
    "tools/wake-training/data": (
        INCLUDE,
        "54 MB of wake-word training corpus — positive, negative, "
        "out-of-distribution and room-simulated audio, plus the extracted "
        "features and manifest for \"hey nova\". Reproducible only by "
        "re-running the whole training pipeline, which needs the TTS voices "
        "and the room simulator. Treated as operator-produced state."),
    # Exact paths, not bare names: `dist` and `mockups` are generic enough
    # that matching them anywhere would repeat the `data` mistake above.
    "frontend/dist": (EXCLUDE_CODE,
                      "a build output; `npm run build` reproduces it"),
    "frontend/public/mockups": (
        EXCLUDE_DECLINED,
        "design mockups served statically. Gitignored, and a real judgement "
        "call rather than an obvious one — they are operator-authored but "
        "belong to the design lane, and losing them costs iterations of "
        "artwork rather than anything Nova needs to run."),
    "frontend/tsconfig.tsbuildinfo": (EXCLUDE_EPHEMERAL, "a TypeScript build cache"),
    "frontend/tsconfig.node.tsbuildinfo": (EXCLUDE_EPHEMERAL, "a TypeScript build cache"),
    "frontend/vite.config.js": (
        EXCLUDE_EPHEMERAL,
        "the compiled twin of the tracked vite.config.ts"),
}

# ── the secret tier ──────────────────────────────────────────────────────
#
# These hold CREDENTIALS, not data: the Postgres password and the API keys
# (.env), the master key every encrypted secret is sealed with
# (/state/secret.key, inside nova_state), and the tailnet node's private key.
#
# A bundle containing them is exactly as sensitive as the secrets themselves
# — and a backup's whole purpose is to be COPIED somewhere else, which is the
# one thing you would never do with a file full of API keys. So they are OUT
# by default, and the bundle records that they are out so a restore can say
# what it cannot do rather than failing mysteriously.
#
# The cost is real and must be stated rather than buried: a secrets-free
# bundle cannot bring up a working system on its own. It restores the data;
# the operator supplies the credentials. That is the correct default for a
# file whose reason to exist is to live somewhere other than this machine.
SECRET_TIER = {"bind:.env", "volume:nova_state", "volume:tailscale_state"}


def is_secret(entry: "Entry", project_dir: str = "") -> bool:
    """Whether this entry holds credentials.

    Volume names arrive with or without the compose project prefix depending
    on which inventory source saw them, so the match tolerates it the same
    way `_volume_key` does — an exact-string test here silently let the
    master key into a bundle when the name came through as
    `nova_nova_state`.
    """
    name = _rel_to(entry.name, project_dir)
    if entry.kind == "volume":
        return any(name == v or name.endswith("_" + v) or name.endswith("-" + v)
                   for v in (s.split(":", 1)[1] for s in SECRET_TIER
                             if s.startswith("volume:")))
    return f"{entry.kind}:{name}" in SECRET_TIER


# Not filesystem state at all. A socket has no bytes to archive, and a
# device node restored onto another machine is meaningless.
NON_STATE_BINDS = {"/var/run/docker.sock", "/dev", "/proc", "/sys"}

# ANONYMOUS volumes — declared by an image, never named in a compose file.
# They cannot be keyed by name: docker mints a fresh 64-hex id every time the
# container is recreated, so any name-based entry here would go stale the
# next `up -d` and start refusing again. Keyed by (service, destination),
# which is stable across recreates.
ANON_POLICY: dict[tuple[str, str], tuple[str, str]] = {
    ("searxng", "/etc/searxng"): (
        EXCLUDE_CODE,
        "searxng's generated runtime config. The operator-authored source is "
        "searxng/settings.yml, which is tracked in git, and SEARXNG_SECRET "
        "lives in .env, which this bundle includes — so the volume is "
        "reproducible from things that ARE backed up."),
    ("searxng", "/var/cache/searxng"): (
        EXCLUDE_EPHEMERAL, "a search result cache; regenerates on use"),
}


# Names that mean the same thing WHEREVER they appear, so `coder/__pycache__`
# inherits the decision without an entry per directory. Kept deliberately
# short and unambiguous: a generic name here is a silent-exclusion bug.
#
# `data` was in this set for about an hour and it cost exactly the failure
# this module exists to prevent: `tools/wake-training/data` — 54 MB of
# wake-word corpus, positive/negative/room-simulated audio and extracted
# features, reproducible only by re-running the whole training pipeline —
# matched the segment `data` and was silently excluded. The entry was meant
# for the top-level `./data` parent. A name that is generic enough to appear
# anywhere is not safe to match anywhere.
SEGMENT_POLICY: dict[str, tuple[str, str]] = {
    "__pycache__": (EXCLUDE_EPHEMERAL, "compiled bytecode; regenerates"),
    ".venv": (EXCLUDE_REDOWNLOAD, "installable from pyproject.toml"),
    "node_modules": (EXCLUDE_REDOWNLOAD, "installable from the lockfile"),
    ".ruff_cache": (EXCLUDE_EPHEMERAL, "a linter cache; regenerates on use"),
    ".pytest_cache": (EXCLUDE_EPHEMERAL, "a test-runner cache"),
}


def _path_policy(rel: str) -> Optional[tuple[str, str]]:
    """Policy for a project-relative path.

    EXACT match first, then the small set of segment names that are
    unambiguous anywhere. Anything else returns None and therefore REFUSES —
    which is the point: an unrecognised path is a decision waiting to be
    made, not a thing to skip.
    """
    if rel in PATH_POLICY:
        return PATH_POLICY[rel]
    if rel.endswith(".egg-info"):
        return (EXCLUDE_EPHEMERAL, "a build artifact")
    for seg in rel.split("/"):
        if seg in SEGMENT_POLICY:
            return SEGMENT_POLICY[seg]
    return None


def _canonical_volume(name: str, project: str) -> str:
    """Strip the compose project prefix so the two inventory sources agree."""
    for prefix in ((project + "_", project + "-") if project else ()):
        if name.startswith(prefix):
            return name[len(prefix):]
    return name


def _volume_key(name: str) -> str:
    """Match a volume by its compose-declared name, tolerating the project
    prefix docker adds (`nova_postgres_data` vs `postgres_data`)."""
    for key in VOLUME_POLICY:
        if name == key or name.endswith("_" + key) or name.endswith("-" + key):
            return key
    return ""


def _rel_to(path: str, project_dir: str) -> str:
    p = path.rstrip("/")
    if project_dir and p.startswith(project_dir):
        return p[len(project_dir):].lstrip("/")
    return p


def classify(inventory: Iterable[dict], *,
             git_status: Callable[[str], str],
             self_service: str = "backup-runner",
             project_dir: str = "") -> tuple[list[Entry], list[Refusal]]:
    """Inventory -> (entries, refusals).

    `git_status(path)` returns "tracked", "ignored" or "unknown" for a host
    path. It is injected rather than shelled out to here so the decision
    table is testable without a repo, and so the caller controls which git
    binary and which working tree answer.

    An inventory item is `{"kind", "name", "source", "mounted_at", "service"}`.
    """
    entries: dict[tuple[str, str], Entry] = {}
    refusals: list[Refusal] = []

    for item in inventory:
        kind, name = item["kind"], item["name"]
        # The runner's own service mounts the output directory and every
        # store it reads. Left in, it makes the bundle a backup source
        # (recursive growth) and double-counts every tier.
        if item.get("service") == self_service:
            continue
        if kind == "volume" and item.get("source") == "container":
            # compose speaks the DECLARED name (`nova_state`); the container
            # view carries the project prefix (`nova_nova_state`). Normalise
            # only the container side — stripping both turns `nova_state`
            # into `state` and the two sources disagree in opposite
            # directions, which is how one volume became two refusals.
            name = _canonical_volume(name, item.get("project", ""))
        key = (kind, name)
        entry = entries.get(key)
        if entry is None:
            entry = Entry(kind=kind, name=name, disposition=UNCLASSIFIED,
                          reason="not yet classified",
                          mounted_at=item.get("mounted_at"),
                          service=item.get("service"))
            entries[key] = entry
        entry.sources.add(item.get("source", "unknown"))

    for entry in entries.values():
        if entry.kind == "volume":
            if _ANON_RE.fullmatch(entry.name):
                decided = ANON_POLICY.get((entry.service or "", entry.mounted_at or ""))
                if decided:
                    entry.disposition, entry.reason = decided
                else:
                    entry.disposition = UNCLASSIFIED
                    entry.reason = (
                        f"an ANONYMOUS volume declared by the "
                        f"{entry.service or '?'} image at "
                        f"{entry.mounted_at or '?'}. It has no name to look "
                        f"up, so classify it in ANON_POLICY by (service, "
                        f"destination) — that key survives the container "
                        f"being recreated, which the volume's id does not.")
                continue
            key = _volume_key(entry.name)
            if key:
                entry.disposition, entry.reason = VOLUME_POLICY[key]
            else:
                entry.disposition = UNCLASSIFIED
                entry.reason = (
                    "a named volume with no entry in VOLUME_POLICY. Git "
                    "cannot see inside a volume, so this is the one thing "
                    "that must be decided by hand — add it to the table as "
                    "include or exclude, with a reason.")
            continue

        # binds
        if (entry.name in NON_STATE_BINDS or entry.name.startswith("/dev/")
                or entry.name.endswith(".sock")):
            entry.disposition = EXCLUDE_DECLINED
            entry.reason = ("a socket or device node, not stored bytes — "
                            "there is nothing here to archive or restore")
            continue
        if _UNEXPANDED.search(entry.name):
            entry.disposition = UNCLASSIFIED
            entry.reason = (
                f"the compose source still contains an unexpanded variable "
                f"({entry.name}). The environment that defines it was not "
                f"present when the project was rendered. Refusing rather "
                f"than applying the compose default, because the default "
                f"would silently snapshot a different directory than the "
                f"one in use.")
            continue
        # An EXPLICIT decision beats the git heuristic. Without this, a
        # bind that is gitignored — which the output directory necessarily
        # is — gets included by the general rule no matter what the policy
        # says about it, and the bundle ends up containing every previous
        # bundle.
        decided = _path_policy(_rel_to(entry.name, project_dir))
        if decided:
            entry.disposition, entry.reason = decided
            continue
        status = git_status(entry.name)
        if status == "ignored":
            entry.disposition = INCLUDE
            entry.reason = ("gitignored operator state under the project — "
                            "it exists nowhere but this machine")
        elif status == "tracked":
            entry.disposition = EXCLUDE_CODE
            entry.reason = "tracked in git; restore it from the repository"
        else:
            entry.disposition = UNCLASSIFIED
            entry.reason = (
                "a bind outside the project directory, so git has no opinion "
                "on it. Decide explicitly: operator state to include, or a "
                "host path that is not ours to back up.")

    ordered = sorted(entries.values(), key=lambda e: (e.kind, e.name))
    for entry in ordered:
        if entry.disposition == UNCLASSIFIED:
            refusals.append(Refusal(
                code="R1_UNCLASSIFIED", subject=f"{entry.kind}:{entry.name}",
                detail=entry.reason))
    return ordered, refusals


def check_reachable(entries: Iterable[Entry],
                    readable: Callable[[str], bool]) -> list[Refusal]:
    """R2 — everything we intend to include must actually be readable.

    The runner's own mount list is hand-written and therefore exactly the
    kind of list this module exists to distrust. This is what keeps it
    honest: it is hand-written but SELF-CHECKING, and it fails closed. If
    compose declares a location the runner cannot read, no bundle is
    produced and the refusal names what to mount.
    """
    out = []
    for entry in entries:
        if entry.disposition != INCLUDE or entry.kind != "bind":
            # pg_dump reaches the database over the network, and a named
            # volume has no host path to stat — its reachability is whether
            # the runner mounts it, checked against the runner's own
            # mountinfo rather than by existence of a name.
            continue
        if not readable(entry.name):
            out.append(Refusal(
                code="R2_UNREACHABLE", subject=f"{entry.kind}:{entry.name}",
                detail=(f"classified for inclusion but the backup runner "
                        f"cannot read it. Add it to the backup-runner "
                        f"service's mounts (read-only) — a bundle that "
                        f"silently omits a tier is worse than no bundle.")))
    return out


def host_state_entries(ignored_paths: Iterable[str], project_dir: str) -> list[Entry]:
    """Host state the POLICY says to include, as real entries.

    `.env` is the whole reason this exists: it holds the Postgres password
    and the auth token, no container mounts it, and a restore without it
    cannot open its own database. Nothing derived from docker can see it.
    """
    out = []
    for path in ignored_paths:
        p = path.rstrip("/")
        rel = p[len(project_dir):].lstrip("/") if project_dir and p.startswith(project_dir) else p
        decided = _path_policy(rel)
        if decided and decided[0] == INCLUDE:
            out.append(Entry(kind="bind", name=p, disposition=INCLUDE,
                             reason=decided[1], sources={"host-state"}))
    return out


def check_uncovered_host_state(ignored_paths: Iterable[str],
                               entries: Iterable[Entry],
                               project_dir: str = "") -> list[Refusal]:
    """R5 — operator state on the host that NO container mounts.

    Without this the enumerator's universe is only as wide as
    docker-compose.yml, so it can only report gaps compose already knows
    about. `.env` is the case that proves it: it holds POSTGRES_PASSWORD and
    NOVA_AUTH_TOKEN, nothing mounts it, and it is invisible to every other
    signal here.
    """
    covered = {e.name.rstrip("/") for e in entries if e.included}
    out = []
    for path in ignored_paths:
        p = path.rstrip("/")
        if any(p == c or p.startswith(c + "/") for c in covered):
            continue
        rel = p[len(project_dir):].lstrip("/") if project_dir and p.startswith(project_dir) else p
        decided = _path_policy(rel)
        if decided:
            continue     # classified either way, with a reason on record
        out.append(Refusal(
            code="R5_UNCOVERED_HOST_STATE", subject=p,
            detail=("gitignored state in the project directory that no "
                    "container mounts, so nothing else here can see it. "
                    "Classify it: include it in the bundle, or record why "
                    "it is deliberately out.")))
    return out


def prune_nested(entries: list[Entry]) -> list[Entry]:
    """Reduce included binds to maximal non-overlapping roots.

    Archiving both `./data` and `./data/memory` writes the memory tree
    twice and doubles the bundle for no benefit.
    """
    roots = sorted((e for e in entries if e.kind == "bind" and e.included),
                   key=lambda e: len(e.name))
    drop: set[str] = set()
    for i, outer in enumerate(roots):
        for inner in roots[i + 1:]:
            if inner.name.rstrip("/").startswith(outer.name.rstrip("/") + "/"):
                drop.add(inner.name)
    return [e for e in entries if not (e.kind == "bind" and e.name in drop)]


def report(inventory: Iterable[dict], *, git_status, ignored_paths=(),
           readable=None, self_service="backup-runner",
           project_dir: str = "", include_secrets: bool = False) -> dict:
    """The whole coverage answer, including whether a snapshot may proceed."""
    entries, refusals = classify(inventory, git_status=git_status,
                                 self_service=self_service,
                                 project_dir=project_dir)
    entries = entries + host_state_entries(ignored_paths, project_dir)
    entries = prune_nested(entries)
    if not include_secrets:
        for e in entries:
            if e.included and is_secret(e, project_dir):
                e.disposition = EXCLUDE_DECLINED
                e.reason = (
                    "CREDENTIALS, held out so this bundle is safe to copy off "
                    "the machine. The cost: a restore from it cannot open the "
                    "database or decrypt any stored secret on its own — keep "
                    "your .env and the master key somewhere separate, and "
                    "supply them at restore time. Turn on Settings → Backups "
                    "→ 'include credentials' to embed them, which makes every "
                    "copy of this bundle as sensitive as the keys themselves.")
    if readable is not None:
        refusals += check_reachable(entries, readable)
    refusals += check_uncovered_host_state(ignored_paths, entries, project_dir)
    return {
        "entries": [e.as_dict() for e in entries],
        "refusals": [r.as_dict() for r in refusals],
        # The operator-facing headline. False means NO bundle is produced —
        # not a partial one, and not one with a warning attached, because a
        # partial bundle that lists as restorable is the failure this whole
        # module exists to prevent.
        "may_snapshot": not refusals,
        "included": sorted(e.name for e in entries if e.included),
    }
