"""The notices store: one piece of news, written down before anyone is told.

A NOTICE (migration 022) is one thing a check found. The row is written
BEFORE any delivery is attempted and the delivery outcome is written back
onto it, so a channel that is disabled, unconfigured or broken leaves an
honest record instead of silence. Everything that writes `notices` lives
here; the beat that produces findings is app/beats.py and the checks that
find them are app/checks/.

Three properties this module exists to hold, each from a measured failure:

* **The fingerprint is computed from the DERIVED FACTS a check returned**,
  never from the sentence about them — `checks.fingerprint(finding)` is the
  one implementation and `record` is its only caller here. v3 hashed the
  model's own text and one model re-worded two findings into fourteen phone
  pushes in eight hours (2026-08-08). A finding may speak again only when
  the world changes, and the model gets no vote in what "changed" means.

* **The fold is ONE statement.** `INSERT … ON CONFLICT (fingerprint) DO
  UPDATE … RETURNING *, (xmax = 0) AS is_new` — so two beats racing on the
  same fact cannot double-raise it, and the caller learns from postgres
  itself (xmax is zero only on a row this statement inserted) whether it
  made a new notice or landed on an old one. A read-then-write would have a
  window between the two, and an hourly beat plus a "Run now" click is
  exactly how that window gets found.

* **A condition that FINISHES is written down too.** `state` says what
  happened to the news; `cleared_at` says what happened to the CONDITION,
  and they are orthogonal. A check that RAN and no longer finds a notice's
  facts has watched that condition clear (`reconcile`), and the unique index
  is partial on `cleared_at IS NULL`, so the fingerprint is free again and
  the same fault returning is NEWS rather than a fold onto a row from last
  week. Without that, "one live row per fingerprint" quietly means "tell him
  once, ever": a fixed thing that broke again folded onto a stale row and he
  was never told. A check that did NOT run clears nothing — a probe that
  could not be made has watched nothing.

Nothing here is an authorization. `state` tracks whether the news reached
him and whether he wants to keep hearing it: muting is a NOISE preference
(stop telling me until the facts change) and `seen` is a read receipt —
neither permits or forbids anything (owner ruling 2026-09-03). A muted row
still occupies its fingerprint, which IS the mute: the same facts fold onto
it silently, changed facts are a different fingerprint and so a fresh,
unmuted row, and a mute is never cleared, so it holds that fingerprint for
as long as it stands.

Every write reads back what it claims. Each state transition sets its
evidence in the SAME UPDATE that sets the state — the migration's CHECKs
demand a time for delivered/seen/muted and a reason for failed, so a
half-written transition is refused by postgres rather than stored as a
state nobody can prove. A helper that touches no row raises `NoticeError`
instead of returning quietly: "I marked it delivered" must not be a
sentence about a row that was not there.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import asyncpg

from app import checks

# Every read, every RETURNING and the upsert name the same columns, so a
# notice is the same shape wherever it was fetched.
_COLUMNS = (
    "id, turn_id, firing_id, check_name, finding_key, fingerprint, title, facts, urgent, "
    "acted, acted_turn_id, acted_note, repeats, state, delivery, failed_reason, "
    "first_seen_at, last_seen_at, cleared_at, delivered_at, seen_at, muted_at"
)

# raised (written, nobody told yet) -> delivered | failed, and then seen (he
# opened it) or muted (stop telling me until the facts change). Orthogonal to
# all five: cleared_at, which is about the CONDITION rather than the news.
RAISED = "raised"
DELIVERED = "delivered"
FAILED = "failed"
SEEN = "seen"
MUTED = "muted"
STATES = (RAISED, DELIVERED, FAILED, SEEN, MUTED)

# What the digest still owes him, as far as the STATE says. FAILED is in here
# on purpose: a delivery that failed left nobody told, so a repeat of it is not
# a repeat — and since a fold never moves a row back off `failed`, a query that
# read only `raised` let ONE failed push suppress a still-true finding forever.
# The state is only half of it: `deliverable` also requires the row to be
# unread (_UNREAD), because a failed notice he has since opened in the Inbox
# has reached him after all.
DELIVERABLE_STATES = (RAISED, FAILED)

# What the Inbox badge counts: news he has not read. DERIVED from
# DELIVERABLE_STATES plus what landed and is waiting to be opened, so the
# badge and the digest cannot drift apart — and both queries filter on the same
# _UNREAD clause. MUTED is absent because it is a preference he already
# expressed, SEEN because he read it.
UNSEEN_STATES = (*DELIVERABLE_STATES, DELIVERED)

# What "nobody has told him" is, in SQL, and the ONE place it is spelled: the
# digest's query and the Inbox badge both read it, so the two can never drift
# into disagreeing about whether he has read something. A notice he has SEEN is
# no longer deliverable whatever its delivery state — a failed delivery he then
# read in the Inbox has been told to him by his own eyes, and re-listing it in
# tomorrow's digest would read as a repeat (owner-facing ruling, 2026-09-08).
_UNREAD = "seen_at IS NULL"

# A LIVE notice is one whose condition is still true. Every fold, every
# clear and the digest's own query are scoped to these, because a cleared row
# is history: migration 022's unique index is partial on this predicate, so
# the cleared row keeps its story while the same facts returning insert a
# FRESH notice instead of folding onto it.
_LIVE = "cleared_at IS NULL"

# What may be cleared: a live row that is not muted. A muted row is NEVER
# cleared — a mute means "stop telling me about this until the facts change",
# and identical facts are the same fingerprint whether or not the condition
# blinked off and on in between, so the muted row holds its fingerprint for
# as long as the mute stands. Both writers of cleared_at share this one
# predicate, so that rule is a line of SQL rather than a habit.
_CLEARABLE = f"{_LIVE} AND state <> '{MUTED}'"

# Unmuting has to put the row back into the state its own evidence supports,
# because the state before the mute is not stored anywhere and remembering it
# would be a second, weaker copy of the same fact. The precedence is the one
# the transitions themselves use: a delivery he then read is `seen`; a
# delivery he has not read is `delivered`; a FAILED delivery stays failed
# even when he has since opened the row, because a read receipt does not make
# a push that never landed have landed; otherwise it is still waiting for the
# digest. (Before that ordering, mute-then-unmute laundered `failed` into
# `seen` and lost the only record that nobody was told.)
_STATE_FROM_EVIDENCE = (
    "CASE WHEN delivered_at IS NOT NULL AND seen_at IS NOT NULL THEN 'seen' "
    "WHEN delivered_at IS NOT NULL THEN 'delivered' "
    "WHEN failed_reason IS NOT NULL THEN 'failed' "
    "WHEN seen_at IS NOT NULL THEN 'seen' "
    "ELSE 'raised' END"
)


def _state_keeping(state: str, *, kept: tuple[str, ...]) -> str:
    """`state = <new>`, except where the row already holds a state this
    transition has no right to erase. Built from the constants above, so a
    transition cannot spell one of them differently.

    MUTED is kept by all three transitions: a mute is a preference the owner
    set and only an explicit unmute lifts it (v3 lost mutes and re-armed a
    nag forever). FAILED is kept by `mark_seen` as well: "nobody was told" is
    a fact about a delivery, and him opening the Inbox row does not make the
    failed push have happened. The evidence is written either way — the
    receipt is `seen_at`, the mute is `muted_at` — so nothing is lost by
    leaving the state where it is.
    """
    keep = ", ".join(f"'{s}'" for s in kept)
    return f"state = CASE WHEN state IN ({keep}) THEN state ELSE '{state}' END"


class NoticeError(Exception):
    """A stated reason something could not be written: a check nobody
    registered, a transition with no evidence behind it, an id that names no
    row. The text is meant to be shown as-is. Never a refusal on the owner's
    behalf — every one of these is a CANNOT, not a MAY NOT."""


@dataclass(frozen=True)
class Notice:
    id: uuid.UUID
    # The beat turn that first found it and that turn's firing. Both survive
    # the turn being swept (ON DELETE SET NULL), so a notice can always say
    # where it came from, and both keep the FIRST sighting: a fold records
    # that the facts are still true, not a new provenance.
    turn_id: uuid.UUID | None
    firing_id: uuid.UUID | None
    check_name: str
    finding_key: str
    fingerprint: str
    title: str
    facts: dict[str, Any]
    urgent: bool
    acted: bool
    acted_turn_id: uuid.UUID | None
    acted_note: str | None
    # How many times a check has returned these exact facts. A SIGHTING
    # count, not a delivery count — whether he was ever told is `state`.
    repeats: int
    state: str
    delivery: dict[str, Any]
    failed_reason: str | None
    first_seen_at: datetime
    last_seen_at: datetime
    # When a check that RAN stopped finding these facts. Not a state: the
    # condition finished, whatever anyone was or was not told about it.
    cleared_at: datetime | None
    delivered_at: datetime | None
    seen_at: datetime | None
    muted_at: datetime | None

    @classmethod
    def from_row(cls, record: asyncpg.Record) -> Notice:
        """One place a row becomes a Notice. `facts` and `delivery` are jsonb
        and arrive as dicts already — the pool's codec (app/db.py) decodes
        jsonb with json.loads both ways, the same way timers reads `payload`
        and traces reads a span's `meta`."""
        return cls(
            id=record["id"],
            turn_id=record["turn_id"],
            firing_id=record["firing_id"],
            check_name=record["check_name"],
            finding_key=record["finding_key"],
            fingerprint=record["fingerprint"],
            title=record["title"],
            facts=record["facts"],
            urgent=record["urgent"],
            acted=record["acted"],
            acted_turn_id=record["acted_turn_id"],
            acted_note=record["acted_note"],
            repeats=record["repeats"],
            state=record["state"],
            delivery=record["delivery"],
            failed_reason=record["failed_reason"],
            first_seen_at=record["first_seen_at"],
            last_seen_at=record["last_seen_at"],
            cleared_at=record["cleared_at"],
            delivered_at=record["delivered_at"],
            seen_at=record["seen_at"],
            muted_at=record["muted_at"],
        )


# ── writing one down ───────────────────────────────────────────────────────


def _registered(check_name: str) -> checks.Check:
    """The registry's entry for this name, or a stated CANNOT naming what is
    registered. The check name on a notice is DERIVED from the registry at
    write time, never free text a model chose — a notice whose source cannot
    be opened is a claim with no trace behind it, and a name nobody
    registered would clear nothing while reading as "nothing had cleared"."""
    check = checks.REGISTRY.get(check_name)
    if check is None:
        known = ", ".join(checks.check_names()) or "nothing is registered"
        raise NoticeError(
            f"no check named {check_name!r} is registered, so a notice could not say where it "
            f"came from and nothing was written or cleared under it — registered checks: {known}"
        )
    return check


def _facts_json(finding: checks.Finding) -> str:
    """The facts serialised the way the column will store them, by the SAME
    rules `checks.fingerprint` hashes them: sorted keys and `default=str`.
    The row and its fingerprint therefore describe the same facts — a Decimal
    or a datetime that reached `facts` is stored as the text it hashed as,
    rather than raising inside the pool's jsonb codec (which has no
    `default`) and losing the row.

    `allow_nan=False` is the one deliberate difference, and it is why this
    function exists rather than a bare parameter. `json.dumps` writes NaN and
    Infinity happily and `fingerprint` accepts them; jsonb refuses them. Such
    a check would have hashed fine, blown up on the INSERT, and gone on
    failing every hour with no row written and nobody told. It is refused
    here instead, in words, at the boundary — a stated CANNOT.
    """
    try:
        return json.dumps(
            finding.facts, sort_keys=True, separators=(",", ":"), default=str, allow_nan=False
        )
    except (TypeError, ValueError) as exc:
        raise NoticeError(
            f"the facts of finding {finding.key!r} cannot be stored as jsonb "
            f"({type(exc).__name__}: {exc}) — a check must return values json can hold, so "
            "this finding was written down nowhere"
        ) from exc


async def record(
    pool: asyncpg.Pool,
    finding: checks.Finding,
    *,
    check_name: str,
    turn_id: uuid.UUID | None,
    firing_id: uuid.UUID | None,
) -> tuple[Notice, bool]:
    """Write the finding down, or fold it onto the row that already holds
    these facts. Returns (row, is_new).

    ONE statement, so two beats racing on the same fact cannot both raise it:
    postgres serialises them on the unique index and the loser's INSERT
    becomes the UPDATE. `is_new` comes from `xmax = 0` — the system column is
    zero only on a row this statement inserted — so the caller is told what
    happened by the database rather than by a second query that could see a
    different world.

    The conflict target carries the index predicate (`WHERE cleared_at IS
    NULL`) because migration 022's unique index is partial: a fold may only
    land on a LIVE row. Once a condition has cleared, its fingerprint is free
    and the same facts returning insert a fresh notice with `repeats` back at
    1 — which is the whole point, because a fixed thing that breaks again is
    news, not a fold onto a row from last week.

    A fold bumps `repeats` and `last_seen_at` and touches nothing else. It
    does not move `turn_id`/`firing_id` (the row says where it came FROM), it
    does not re-write `title` or `facts` (identical facts, by definition of
    the fingerprint), and it does not touch `state`: a row still `raised`
    stays deliverable and the digest will pick it up, and a row already
    delivered or muted stays that way and the caller delivers nothing. That
    is the whole noise control — suppression is countable (`repeats`) and
    never silent (the firing's record says which notice it folded onto).

    Three refusals, all stated CANNOTs:

    * `check_name` must name a registered check. The migration says this
      column is derived from the registry at write time, never free text —
      an unknown name means a caller invented one, and a notice whose source
      cannot be opened is a claim with no trace behind it.
    * A finding may not be urgent unless its check family declares urgency
      in code. Urgency is a property of the CHECK (owner's list has exactly
      one entry, the stack being down) and never a word anyone writes about
      a finding, so a family that did not declare it cannot smuggle one
      through. Read live from the registry, so the day a second family is
      declared urgent it works here with no edit.
    * The facts must be storable as jsonb (`_facts_json`). A check whose
      facts the column cannot take would otherwise hash fine and fail on the
      INSERT every hour, with no row written and nobody told.
    """
    check = _registered(check_name)
    if finding.urgent and not check.urgent:
        raise NoticeError(
            f"check {check_name!r} does not declare urgency, so its finding {finding.key!r} "
            "cannot be urgent — urgency is declared by the check family in code"
        )
    # Serialised here and cast in SQL rather than handed to the pool's jsonb
    # codec, so what is stored is what `fingerprint` hashed — see _facts_json.
    facts_json = _facts_json(finding)
    row = await pool.fetchrow(
        f"INSERT INTO notices (turn_id, firing_id, check_name, finding_key, fingerprint, "
        f"title, facts, urgent) VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8) "
        f"ON CONFLICT (fingerprint) WHERE {_LIVE} DO UPDATE "
        f"SET repeats = notices.repeats + 1, last_seen_at = now() "
        f"RETURNING {_COLUMNS}, (xmax = 0) AS is_new",
        turn_id,
        firing_id,
        check_name,
        finding.key,
        checks.fingerprint(finding),
        finding.title,
        facts_json,
        finding.urgent,
    )
    return Notice.from_row(row), row["is_new"]


# ── when the condition stops being true ────────────────────────────────────


async def clear(pool: asyncpg.Pool, notice_id: uuid.UUID) -> Notice:
    """Stamp `cleared_at`: this condition has finished, and its fingerprint
    is free again.

    That freedom is the point. The unique index is partial on `cleared_at IS
    NULL`, so a cleared row keeps its whole history while the next sighting
    of the same facts writes a NEW notice — a fixed thing that breaks again
    is news. Nothing about the news itself moves: `state` still says whether
    he was ever told, because he either was or was not.

    Three stated CANNOTs rather than a quiet no-op, because "it cleared" must
    never be said about a row that did not move: no such notice; already
    cleared (the caller is working from a stale read); or MUTED, which holds
    its fingerprint for as long as the mute stands.
    """
    row = await pool.fetchrow(
        f"UPDATE notices SET cleared_at = now() WHERE id = $1 AND {_CLEARABLE} "
        f"RETURNING {_COLUMNS}",
        notice_id,
    )
    if row is not None:
        return Notice.from_row(row)
    # It did not move. Say which of the three reasons it was, from the row.
    existing = await pool.fetchrow("SELECT state, cleared_at FROM notices WHERE id = $1", notice_id)
    if existing is None:
        raise NoticeError(f"no notice with id {notice_id} exists — nothing was written")
    # cleared_at first: a row can be both (muted after it cleared), and the
    # timestamp is the more useful fact when it is there.
    if existing["cleared_at"] is not None:
        raise NoticeError(
            f"notice {notice_id} was already cleared at {existing['cleared_at']} — "
            "nothing was written"
        )
    raise NoticeError(
        f"notice {notice_id} is muted and a muted notice is never cleared — a mute means stop "
        "telling me about this until the facts change, and identical facts are the same "
        "fingerprint whether or not the condition blinked off and on in between"
    )


async def reconcile(
    pool: asyncpg.Pool, *, check_name: str, live_fingerprints: set[str]
) -> list[Notice]:
    """Close every live notice of a check that RAN whose facts it no longer
    finds. Returns what it cleared, oldest first, so the digest can say "and
    these cleared" from rows rather than from a memory of them.

    `live_fingerprints` is every fingerprint THIS check produced on THIS beat.
    Anything live under its name that is absent from that set has stopped
    being true; an empty set is the ordinary case of a check that ran and
    found nothing, and clears everything it had raised.

    **Only for a check that actually ran.** A probe that could not be made has
    watched nothing, so a `CheckRun` with `ran=False` must never reach here —
    clearing on a failed probe would be the all-clear-that-checked-nothing
    defect in its quietest form: the row would go away and its condition would
    still be true. The caller (the watch beat) holds that side of the line;
    what this function refuses is the other half, a name nobody registered,
    which would clear nothing and return an empty list that reads as "nothing
    had cleared".

    Muted rows are excluded by `_CLEARABLE`, the same predicate `clear` uses,
    so the mute rule is enforced once in SQL rather than remembered twice.
    """
    _registered(check_name)
    rows = await pool.fetch(
        f"WITH cleared AS ("
        f"UPDATE notices SET cleared_at = now() "
        f"WHERE check_name = $1 AND {_CLEARABLE} AND NOT (fingerprint = ANY($2::text[])) "
        f"RETURNING {_COLUMNS}"
        f") SELECT {_COLUMNS} FROM cleared ORDER BY first_seen_at",
        check_name,
        sorted(live_fingerprints),
    )
    return [Notice.from_row(row) for row in rows]


# ── what happened to it afterwards ─────────────────────────────────────────


async def _update(pool: asyncpg.Pool, notice_id: uuid.UUID, sets: str, *args: Any) -> Notice:
    """Apply one transition and return the row postgres actually wrote.

    The returned Notice is the read-back: a caller that says "delivered"
    says it from this row, not from having called the function. An id that
    names no row updates nothing, and that must be loud — a helper that
    returned None here would let a delivery be reported against a notice
    that does not exist.
    """
    row = await pool.fetchrow(
        f"UPDATE notices SET {sets} WHERE id = $1 RETURNING {_COLUMNS}", notice_id, *args
    )
    if row is None:
        raise NoticeError(f"no notice with id {notice_id} exists — nothing was written")
    return Notice.from_row(row)


async def mark_delivered(pool: asyncpg.Pool, notice_id: uuid.UUID, *, delivery: dict) -> Notice:
    """Record that a channel took it, with that channel's own receipt.

    The receipt may not be empty: `delivered` means a named channel said so,
    and "accepted by transport" is only a delivery if something can be shown
    for it. State and time move in one UPDATE because the migration's CHECK
    refuses a delivered row with no `delivered_at` — the evidence is not
    optional.

    A muted row records the receipt and stays MUTED, the same way `mark_seen`
    does. Delivering to a channel is not the owner asking to hear about this
    again, and a delivery that silently lifted his mute is the v3 re-armed
    nag with extra steps — the timestamps and the receipt are written either
    way, so nothing about what happened is lost.
    """
    if not delivery:
        raise NoticeError(
            "a delivery receipt cannot be empty — 'delivered' is only true when a channel "
            "reported it, so mark_delivered records that channel's own result"
        )
    return await _update(
        pool,
        notice_id,
        f"{_state_keeping(DELIVERED, kept=(MUTED,))}, delivered_at = now(), delivery = $2::jsonb",
        delivery,
    )


async def mark_failed(pool: asyncpg.Pool, notice_id: uuid.UUID, reason: str) -> Notice:
    """Record that nobody was told, and why.

    A blank reason is refused here because the CHECK only demands a non-NULL
    one, and an empty string would satisfy the database while telling the
    operator nothing.

    `failed` is not a finished state: the notice stays in DELIVERABLE_STATES
    and the next digest owes it to him, because a repeat of something that
    never landed is not a repeat. A muted row keeps its mute, as everywhere
    else — the reason is still written onto it, so the record of the failure
    stands whether or not he wants to hear about the finding.
    """
    stated = (reason or "").strip()
    if not stated:
        raise NoticeError("a failed notice has to say why it failed — the reason was empty")
    return await _update(
        pool, notice_id, f"{_state_keeping(FAILED, kept=(MUTED,))}, failed_reason = $2", stated
    )


async def mark_seen(pool: asyncpg.Pool, notice_id: uuid.UUID) -> Notice:
    """Record that he opened it.

    The time is the FIRST read (COALESCE), so a second click is idempotent
    and the receipt keeps saying when he actually learned of it.

    A muted row records the read but stays muted: a mute is a preference he
    set and reading the row is not a request to hear about it again. v3 lost
    mutes and re-armed a nag forever, so the rule here is that nothing but
    an explicit unmute clears one.

    A FAILED row also keeps its state, for the same shape of reason: `failed`
    is the only record that nobody was TOLD by a channel, and him finding the
    row himself in the Inbox does not make the push that never landed have
    landed. The state therefore keeps saying so for as long as the row exists.

    It does stop being DELIVERABLE, though, and that is not a contradiction:
    the delivery failed and he read it anyway, so the news has reached him —
    putting it in tomorrow's digest would read as a repeat. `deliverable`
    filters on `seen_at IS NULL` for exactly that, and this timestamp is what
    the badge counts too.
    """
    return await _update(
        pool,
        notice_id,
        f"seen_at = COALESCE(seen_at, now()), {_state_keeping(SEEN, kept=(MUTED, FAILED))}",
    )


async def set_muted(pool: asyncpg.Pool, notice_id: uuid.UUID, muted: bool) -> Notice:
    """Stop telling him about these facts, or start again.

    Muting is a noise preference and nothing else: the row keeps its
    fingerprint, so the same facts keep folding onto it silently and CHANGED
    facts are a different fingerprint and so a new, unmuted notice. It
    permits nothing and forbids nothing.

    Unmuting derives the state from the evidence on the row rather than from
    a remembered previous state, so a notice that was never delivered goes
    back to `raised` and is picked up by the next digest, while one he had
    already read comes back as `seen`.
    """
    if muted:
        return await _update(pool, notice_id, "state = 'muted', muted_at = now()")
    return await _update(pool, notice_id, f"state = {_STATE_FROM_EVIDENCE}, muted_at = NULL")


async def mark_acted(
    pool: asyncpg.Pool, notice_id: uuid.UUID, *, turn_id: uuid.UUID, note: str
) -> Notice:
    """Record what she DID about it, and in which turn she did it.

    The flag, the turn and the note move together in one UPDATE: the
    migration's CHECK refuses `acted` with no turn id, and the note is
    refused here when blank, because "she acted" with nothing to read and no
    trace to open is a success claim nobody can check.
    """
    if turn_id is None:
        raise NoticeError(
            "acting on a notice has to name the turn that did it — that turn IS the evidence"
        )
    stated = (note or "").strip()
    if not stated:
        raise NoticeError("acting on a notice has to say what was done — the note was empty")
    return await _update(
        pool, notice_id, "acted = true, acted_turn_id = $2, acted_note = $3", turn_id, stated
    )


# ── reading them ───────────────────────────────────────────────────────────


async def deliverable(pool: asyncpg.Pool) -> list[Notice]:
    """Everything still true that he has not been told about, oldest first —
    what the digest composes from.

    Three conditions, all load-bearing.

    `state` in DELIVERABLE_STATES, which includes FAILED: a delivery that
    failed left nobody told, and since a fold never moves a row back off
    `failed`, reading only `raised` here let one failed push suppress a
    still-true finding forever.

    `cleared_at IS NULL`, because a condition that has finished is not a
    standing debt — the fact that it cleared is the reconcile's return value,
    said once.

    And `seen_at IS NULL`: a notice the owner has SEEN is no longer
    deliverable, whatever its delivery state. This is the one place the two
    halves meet. `mark_seen` deliberately leaves a FAILED row in state `failed`
    — that state is the only record that nobody was TOLD, and a read receipt
    does not make a push that never landed have landed — but the receipt itself
    is a fact about him: he read the row in the Inbox with his own eyes, so
    listing it again in tomorrow's digest would read to him as a repeat. The
    record of the failure stands on the row; the debt does not.
    """
    rows = await pool.fetch(
        f"SELECT {_COLUMNS} FROM notices WHERE {_LIVE} AND {_UNREAD} "
        f"AND state = ANY($1::text[]) ORDER BY first_seen_at",
        list(DELIVERABLE_STATES),
    )
    return [Notice.from_row(row) for row in rows]


async def recent(pool: asyncpg.Pool, limit: int = 50) -> list[Notice]:
    """The Inbox's page: most recently SEEN BY A CHECK first (last_seen_at),
    so a finding that is still true today sits above one that stopped
    recurring last week, whatever order they were first raised in.

    Cleared rows are included — the Inbox is the record of what she noticed,
    and "this was true and is not any more" is part of it. `cleared_at` on
    the row is what the page renders it by."""
    rows = await pool.fetch(
        f"SELECT {_COLUMNS} FROM notices ORDER BY last_seen_at DESC LIMIT $1", limit
    )
    return [Notice.from_row(row) for row in rows]


async def unseen_count(pool: asyncpg.Pool) -> int:
    """The badge, counted by the server from UNSEEN_STATES rather than
    guessed by the page from whatever rows it happens to be holding.

    `seen_at IS NULL` as well as the state set, because `mark_seen` leaves a
    failed row in state `failed` on purpose — the read receipt is the
    timestamp, so that is what "unread" is counted from. A notice whose
    condition has since cleared still counts until he reads it: he was never
    told, and that it happened at all is the news.
    """
    return await pool.fetchval(
        f"SELECT count(*) FROM notices WHERE state = ANY($1::text[]) AND {_UNREAD}",
        list(UNSEEN_STATES),
    )
