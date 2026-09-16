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
him; `seen_at` is a read receipt and `muted` is a NOISE preference (stop
telling me about this until it clears) — neither permits or forbids
anything (owner ruling 2026-09-03).

THE MUTE IS A CONDITION, NOT A ROW (S25.1, 2026-09-16). It lives in
`notice_mutes`, keyed on `(check_name, finding_key)`. It used to be the row
holding its fingerprint, and that fingerprint is a hash of the FACTS — so
`work_failing_timers` muted at two failures came back as a fresh, unmuted
card at three, because `consecutive_failures` had moved. The condition had
not changed; the count had. A new reading of a silenced condition is now
born muted, and the only things that end a silence are an explicit unmute
and the condition CLEARING — the latter in the same statement as the clear,
so a cleared row can never leave a gag behind that nobody can find to
lift.

Every write reads back what it claims. Each state transition sets its
evidence in the SAME UPDATE that sets the state — the migration's CHECKs
demand a time for delivered/muted and a reason for failed, so a
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
    "first_seen_at, last_seen_at, cleared_at, delivered_at, seen_at, muted_at, "
    # S24: WHICH chat row carried this to him. A room hangs off a message,
    # so without this the Inbox's "talk about this" has nothing to open one
    # against. The value was always in hand at delivery time — the chat rung
    # reads the row back to prove the delivery landed — and was being spent
    # on an audit string.
    "delivered_message_id"
)

# raised (written, nobody told yet) -> delivered | failed, or muted (stop
# telling me until it clears). Orthogonal to all four: cleared_at, which is
# about the CONDITION rather than the news, and seen_at, which is about HIM.
RAISED = "raised"
DELIVERED = "delivered"
FAILED = "failed"
MUTED = "muted"
# S25.1.3: there is no `seen` state, and its absence is the fix. "He read
# it" is `seen_at`, a timestamp; duplicating it as a state gave reading a
# card a SECOND meaning — it silently left DELIVERABLE_STATES, so opening
# something in the Inbox removed it from every future digest. `cleared`
# already means "this stopped being true" and `muted` already means "stop
# telling me"; a third meaning in between was where the confusion came from.
STATES = (RAISED, DELIVERED, FAILED, MUTED)

# What the digest still owes him, as far as the STATE says. FAILED is in here
# on purpose: a delivery that failed left nobody told, so a repeat of it is not
# a repeat — and since a fold never moves a row back off `failed`, a query that
# read only `raised` let ONE failed push suppress a still-true finding forever.
# The state is now the WHOLE of it (S25.1.3): `deliverable` used to also
# require the row to be unread, which made reading a card a way to silence
# it forever — while the urgent push path read different columns and pushed
# it anyway. Two paths, two meanings, one control.
DELIVERABLE_STATES = (RAISED, FAILED)

# What the Inbox badge counts: news he has not read. DERIVED from
# DELIVERABLE_STATES plus what landed and is waiting to be opened, so the
# badge and the digest cannot drift apart. MUTED is absent because it is a
# preference he already expressed. What he has READ leaves by the _UNREAD
# clause below, which only this count applies — the digest does not, because
# a read receipt stops nothing (S25.1.3).
UNSEEN_STATES = (*DELIVERABLE_STATES, DELIVERED)

# What "he has not read it" is, in SQL. The Inbox badge is the only thing
# that filters on it now.
#
# It used to be in `deliverable()` too, under an owner-facing ruling of
# 2026-09-08 that a failed delivery he read himself had reached him. REVERSED
# 2026-09-16 (S25 Q1): the same clause also meant that opening ANY unread
# card in the Inbox dropped it from every future digest, silently and
# permanently, while the urgent push path read different columns and would
# still push it. The digest is noisier for it — a live condition he has read
# and not acted on is listed again tomorrow — and that is the honest trade.
_UNREAD = "seen_at IS NULL"

# A LIVE notice is one whose condition is still true. Every fold, every
# clear and the digest's own query are scoped to these, because a cleared row
# is history: migration 022's unique index is partial on this predicate, so
# the cleared row keeps its story while the same facts returning insert a
# FRESH notice instead of folding onto it.
_LIVE = "cleared_at IS NULL"

# "Still owed", in SQL, and the ONE place it is spelled. `deliverable()`
# SELECTs it and the digest's standing tail is its complement
# (beats._standing_predicate), so the two halves of one message are disjoint
# BY CONSTRUCTION — which only holds while both read this fragment rather
# than each spelling its own. $1 is the state list.
OWED = f"{_LIVE} AND state = ANY($1::text[])"

# What may be cleared: any live row, MUTED INCLUDED (changed 2026-09-16).
#
# A muted row used to be uncleanable, and the reason was sound under the old
# design: the mute WAS the row holding its fingerprint, so clearing it would
# have freed that fingerprint and let identical facts raise a fresh, unmuted
# card — "the condition blinked off and on" defeating the silence.
#
# The mute now lives in `notice_mutes`, keyed on the CONDITION rather than on
# one reading of it, so clearing the row no longer touches the silence. And
# the owner's ruling (Q3) is that the silence should lift when the condition
# genuinely stops being true: a mute is about something currently true, and a
# condition that returns months later is news. That is also what makes muting
# an URGENT condition safe (Q5) — the silence lasts exactly as long as the
# thing he already knows about.
#
# Both writers of cleared_at share this one predicate, so the rule is a line
# of SQL rather than a habit.
_CLEARABLE = _LIVE

# Forgetting a mute, in SQL: delete the key for a condition this statement
# has just finished clearing — UNLESS a live row for that same condition
# remains.
#
# FOUND BY THE WALK (2026-09-16). The mute keys on the CONDITION and this
# rule was being applied per ROW, so one beat could do both halves at once:
# `record` raises a row for the new facts while `reconcile` clears the old
# one, whose fingerprint the check no longer returns — and the clear took
# the silence the new row depends on. He muted a timer at four failures, the
# fifth arrived silent (the state is stamped at insert) and yet nothing was
# in the muted view to un-mute, and the sixth would have come back as a
# fresh unmuted card.
#
# `n.id NOT IN (SELECT id FROM cleared)` is load-bearing: a data-modifying
# CTE reads the snapshot from BEFORE the statement, so the rows being
# cleared right now still look live to this subquery. Excluding them by id
# is what makes "is anything still standing" mean what it says.
_FORGET_THE_MUTE = (
    "DELETE FROM notice_mutes m USING cleared c "
    " WHERE m.check_name = c.check_name AND m.finding_key = c.finding_key "
    "   AND NOT EXISTS ("
    "     SELECT 1 FROM notices n "
    "      WHERE n.check_name = c.check_name AND n.finding_key = c.finding_key "
    f"       AND n.{_LIVE} AND n.id NOT IN (SELECT id FROM cleared))"
)

# Unmuting has to put the row back into the state its own evidence supports,
# because the state before the mute is not stored anywhere and remembering it
# would be a second, weaker copy of the same fact. The precedence is the one
# the transitions themselves use: a delivery is `delivered`; a FAILED
# delivery stays failed, because a read receipt does not make a push that
# never landed have landed; otherwise it is still waiting for the digest.
# (Before that ordering, mute-then-unmute laundered `failed` into `seen` and
# lost the only record that nobody was told. There is no `seen` state to
# launder into any more — S25.1.3 — but the ordering is still what decides
# between `delivered` and `failed`, so it stays.)
#
# `seen_at` is deliberately absent from the CASE. Whether he has read a row
# is not a state and never was: it is a timestamp the unmute leaves exactly
# where it is.
_STATE_FROM_EVIDENCE = (
    "CASE WHEN delivered_at IS NOT NULL THEN 'delivered' "
    "WHEN failed_reason IS NOT NULL THEN 'failed' "
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
    # WHICH chat row carried it to him (S24). The column has been selected
    # since that slice and was not on this dataclass until S25.2.4 needed
    # it: a room hangs off a message, so this is the whole of what makes
    # "talk about this" possible — and its absence is the honest reason a
    # notice nobody was told about has nowhere to talk.
    delivered_message_id: uuid.UUID | None

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
            delivered_message_id=record["delivered_message_id"],
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
    # BORN MUTED IF HE ALREADY SILENCED THIS CONDITION (S25.1). The mute
    # lives on (check_name, finding_key), so a reading with different facts
    # — a failure count that went up — is the same silenced condition rather
    # than a fresh unmuted card. Decided in SQL, in the same statement that
    # writes the row: a mute read first and applied after is a window two
    # beats can both pass through.
    #
    # `last_seen_at` is NOT bumped for a muted row. That was written when the
    # Inbox ordered by it and a silent fold pushed the thing he silenced to
    # the top of the list; S25.1.2 moved the ordering onto when he was TOLD
    # (_TOLD_AT), so this is no longer what holds that property up. It stays
    # because the column now means what it says on a silenced row — the last
    # time anything about this reached him — and because a muted row that
    # keeps climbing any list is the failure this slice is about.
    row = await pool.fetchrow(
        f"INSERT INTO notices (turn_id, firing_id, check_name, finding_key, fingerprint, "
        f"title, facts, urgent, state, muted_at) "
        f"SELECT $1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, "
        f"       CASE WHEN m.finding_key IS NULL THEN 'raised' ELSE 'muted' END, "
        f"       CASE WHEN m.finding_key IS NULL THEN NULL ELSE now() END "
        f"  FROM (SELECT 1) AS one "
        f"  LEFT JOIN notice_mutes m ON m.check_name = $3 AND m.finding_key = $4 "
        f"ON CONFLICT (fingerprint) WHERE {_LIVE} DO UPDATE "
        f"SET repeats = notices.repeats + 1, "
        f"    last_seen_at = CASE WHEN notices.state = 'muted' "
        f"                        THEN notices.last_seen_at ELSE now() END "
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
        f"WITH cleared AS ("
        f"  UPDATE notices SET cleared_at = now() WHERE id = $1 AND {_CLEARABLE} "
        f"  RETURNING {_COLUMNS}"
        f"), lifted AS ("
        # THE SILENCE LIFTS WITH THE CONDITION (owner ruling 2026-09-16, Q3).
        # A mute is about something that is CURRENTLY true; a condition that
        # comes back months later is news again. This is also what makes
        # muting an URGENT condition safe (Q5) — the silence lasts exactly as
        # long as the thing he already knows about, and no longer.
        f"  {_FORGET_THE_MUTE}"
        f") SELECT * FROM cleared",
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
    # Reachable only if `_CLEARABLE` grows a term again; a muted notice is
    # clearable since 2026-09-16. Kept as a stated refusal rather than
    # deleted, so a future narrowing of that predicate says why it refused
    # instead of returning a silent None.
    raise NoticeError(
        f"notice {notice_id} could not be cleared and is neither missing nor already "
        "cleared — the clearable predicate refused it"
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

    Muted rows ARE cleared, and clearing lifts their silence (2026-09-16,
    owner ruling Q3). The mute lives on the condition in `notice_mutes`, so
    a condition that genuinely stopped being true takes its mute with it —
    and comes back as news if it ever returns. Both writers of `cleared_at`
    share `_CLEARABLE` and both delete the mute, so the rule is SQL in two
    places rather than a habit in none.
    """
    _registered(check_name)
    rows = await pool.fetch(
        f"WITH cleared AS ("
        f"UPDATE notices SET cleared_at = now() "
        f"WHERE check_name = $1 AND {_CLEARABLE} AND NOT (fingerprint = ANY($2::text[])) "
        f"RETURNING {_COLUMNS}"
        f"), lifted AS ("
        # The silence goes with the condition — see the docstring above and
        # `clear`, which does the same thing for one row.
        f"  {_FORGET_THE_MUTE}"
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


async def mark_delivered(
    pool: asyncpg.Pool,
    notice_id: uuid.UUID,
    *,
    delivery: dict,
    message_id: uuid.UUID | None = None,
) -> Notice:
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
    # `message_id` is written whenever the chat rung produced one. None is a
    # real answer, not a missing one: a notice pushed to a device and never
    # written to chat HAS no message, so it has no room — and the Inbox must
    # say so rather than offer a control that opens nothing.
    return await _update(
        pool,
        notice_id,
        f"{_state_keeping(DELIVERED, kept=(MUTED,))}, delivered_at = now(), "
        "delivery = $2::jsonb, delivered_message_id = $3",
        delivery,
        message_id,
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

    IT WRITES NOTHING BUT THE TIMESTAMP (S25.1.3). It used to also move the
    row to a `seen` state, and that is what made "I read this" and "stop
    telling me about this" the same button: leaving `raised` meant leaving
    DELIVERABLE_STATES, so a card he opened in the Inbox was dropped from
    every future digest — permanently, silently, and while the urgent push
    path went on pushing it because it reads different columns.

    A read receipt stops nothing now. The row keeps saying what actually
    happened to it — `raised` (nobody delivered it yet), `delivered`, or
    `failed` (a channel was tried and nobody was told) — and `seen_at` says,
    separately, that he has laid eyes on it. The badge counts the timestamp;
    the digest does not read it at all. To stop hearing about something
    there is `set_muted`, which says so in one word.
    """
    return await _update(pool, notice_id, "seen_at = COALESCE(seen_at, now())")


async def set_muted(
    pool: asyncpg.Pool,
    notice_id: uuid.UUID,
    muted: bool,
    *,
    muted_by: uuid.UUID | None = None,
) -> Notice:
    """Stop telling him about this CONDITION, or start again.

    Muting is a noise preference and nothing else: it permits nothing and
    forbids nothing (owner ruling 2026-09-03).

    IT KEYS ON THE CONDITION, not on one reading of it. Until 2026-09-16 the
    mute was the row, holding its fingerprint — and the fingerprint is a hash
    of the FACTS, so `work_failing_timers` muted at two failures came back
    unmuted at three because `consecutive_failures` had moved. The condition
    had not changed. `finding_key` is the half that names it, and that is
    what `notice_mutes` holds.

    `muted_by` is null for a mute SHE made (S25 Q2). The Inbox says which,
    because a silence he did not ask for must not look like one he did.

    Unmuting derives the state from the evidence on the row rather than from
    a remembered previous state, so a notice that was never delivered goes
    back to `raised` and is picked up by the next digest, while one a channel
    reported comes back `delivered`. Whether he had READ it is not part of
    that derivation: it is `seen_at`, which an unmute leaves alone.
    """
    row = await pool.fetchrow(
        "SELECT check_name, finding_key FROM notices WHERE id = $1", notice_id
    )
    if row is None:
        raise NoticeError(f"no notice with id {notice_id} exists — nothing was written")
    if muted:
        await pool.execute(
            "INSERT INTO notice_mutes (check_name, finding_key, muted_by) "
            "VALUES ($1, $2, $3) ON CONFLICT (check_name, finding_key) "
            "DO UPDATE SET muted_at = now(), muted_by = EXCLUDED.muted_by",
            row["check_name"],
            row["finding_key"],
            muted_by,
        )
        return await _update(pool, notice_id, "state = 'muted', muted_at = now()")
    await pool.execute(
        "DELETE FROM notice_mutes WHERE check_name = $1 AND finding_key = $2",
        row["check_name"],
        row["finding_key"],
    )
    return await _update(pool, notice_id, f"state = {_STATE_FROM_EVIDENCE}, muted_at = NULL")


async def muted_keys(pool: asyncpg.Pool, check_name: str) -> set[str]:
    """Every condition of this check he has silenced. Read once per beat
    rather than per finding: a check with forty findings must not become
    forty queries."""
    rows = await pool.fetch(
        "SELECT finding_key FROM notice_mutes WHERE check_name = $1", check_name
    )
    return {row["finding_key"] for row in rows}


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

    And NOT `seen_at IS NULL` — not any more (S25.1.3). That third condition
    made opening a card in the Inbox a permanent silencer, so the two
    conditions above are the whole of it: a live condition nobody has
    successfully told him about is still owed, however many times he has
    looked at it. It leaves this set when it clears (it stopped being true)
    or when he mutes it (he asked to stop hearing about it) — the two things
    that already had that meaning.
    """
    rows = await pool.fetch(
        f"SELECT {_COLUMNS} FROM notices WHERE {OWED} ORDER BY first_seen_at",
        list(DELIVERABLE_STATES),
    )
    return [Notice.from_row(row) for row in rows]


# When he was TOLD, which is what the Inbox sorts by (S25.1.2). `delivered_at`
# where a delivery landed, `first_seen_at` where none has yet — never
# `last_seen_at`, which a fold bumps. A fold is the CHECK seeing the condition
# again; ordering by it sorted the page by how noisy each finding was, so
# muting something made it the top card.
_TOLD_AT = "COALESCE(delivered_at, first_seen_at)"

# "This condition is silenced", in SQL — read from `notice_mutes`, which IS
# the mute, and never from the `muted_at` stamp on the row. The two part
# company the moment a condition clears: clearing forgets the mute and leaves
# the stamp, because the stamp is the row's history. A view keyed on the
# stamp would keep a cleared row in the muted list forever, offering to
# unmute a silence that is already over.
_SILENCED = (
    "EXISTS (SELECT 1 FROM notice_mutes m WHERE m.check_name = notices.check_name "
    "AND m.finding_key = notices.finding_key)"
)


async def recent(pool: asyncpg.Pool, limit: int = 50, *, muted: bool = False) -> list[Notice]:
    """The Inbox's page: most recently TOLD first.

    Cleared rows are included — the Inbox is the record of what she noticed,
    and "this was true and is not any more" is part of it. `cleared_at` on
    the row is what the page renders it by.

    Muted rows are NOT, unless asked for by `muted=True`. They are behind a
    filter rather than deleted because a silence he cannot find is a silence
    he cannot lift: the muted view is the only place an unmute can be
    clicked. One flag and one query, so the two views cannot drift into
    disagreeing about what is muted — the same row set, partitioned.
    """
    # The muted view is LIVE silenced rows. Cleared ones stay out of it even
    # while their condition is silenced by a newer reading: a cleared row is
    # history, there is nothing to lift on it, and one condition would
    # otherwise show up twice — as the reading that cleared and the reading
    # that replaced it. The default view keeps its cleared rows, because
    # "this was true and is not any more" is the record.
    where = f"{_SILENCED} AND {_LIVE}" if muted else f"NOT {_SILENCED}"
    rows = await pool.fetch(
        f"SELECT {_COLUMNS} FROM notices WHERE {where} ORDER BY {_TOLD_AT} DESC LIMIT $1",
        limit,
    )
    return [Notice.from_row(row) for row in rows]


# The views `listing()` offers, and what each one MEANS in SQL. Spelled once
# here so her tool and the Inbox page cannot come to mean different things by
# the same word — "unread" has to be the same set she is shown and the same
# set the badge counts.
VIEWS: dict[str, str] = {
    # What he has not read, of what is STILL TRUE and not silenced.
    #
    # `_LIVE` is here because a walk found it missing (2026-09-16): without
    # it, every condition that had ever cleared and never been opened came
    # back as unread, and "what is in my inbox?" was answered with a memory
    # problem and an agent that had both stopped being true weeks earlier —
    # with a real tool call on the trace behind the sentence. News he has
    # not read is the subject here; that something cleared is the record,
    # and `cleared` below is where it is read.
    #
    # `_SILENCED` rather than the state, so a row born muted is absent from
    # here the way it is absent from the page.
    "unread": f"{_LIVE} AND {_UNREAD} AND NOT {_SILENCED}",
    # What he silenced and has not lifted — the only place an unmute can be
    # asked for, which is why it is a view and not a deletion. Live, for the
    # same reason `recent(muted=True)` is: there is nothing to lift on a row
    # whose condition has already stopped.
    "muted": f"{_SILENCED} AND {_LIVE}",
    # Conditions that STOPPED being true. Not "handled": nobody did anything,
    # a check simply stopped finding it.
    "cleared": "cleared_at IS NOT NULL",
    "all": "true",
}


async def listing(
    pool: asyncpg.Pool,
    *,
    view: str = "unread",
    check_name: str | None = None,
    limit: int = 50,
) -> list[Notice]:
    """One page of the Inbox, for her rather than for the page — the rows
    behind the digest she wrote, so she can answer a question about it.

    Newest TELLING first, like the page (_TOLD_AT), because the order she
    reads them in is the order he was told and not a ranking of how noisy
    each condition is.

    A view this does not know, or a check nobody registered, is a stated
    CANNOT naming what it does know. Both would otherwise return [] — which
    reads as "there is nothing", the quietest possible wrong answer, and the
    one she would then repeat to him as a fact.
    """
    if view not in VIEWS:
        known = ", ".join(sorted(VIEWS))
        raise NoticeError(f"no view called {view!r} — it is one of: {known}")
    if check_name is not None:
        # The same sentence `reconcile` refuses with, from the same helper —
        # one definition of "that check does not exist".
        _registered(check_name)
    where = VIEWS[view]
    params: list[object] = [max(1, int(limit))]
    if check_name is not None:
        params.append(check_name)
        where = f"{where} AND check_name = $2"
    rows = await pool.fetch(
        f"SELECT {_COLUMNS} FROM notices WHERE {where} ORDER BY {_TOLD_AT} DESC LIMIT $1",
        *params,
    )
    return [Notice.from_row(row) for row in rows]


async def mutes(pool: asyncpg.Pool) -> dict[tuple[str, str], uuid.UUID | None]:
    """Every silence in force, and WHO asked for it — his person id, or None
    for one she made herself (S25 Q2).

    The whole table in one read: it holds one row per silenced condition, and
    a page that asked per-row would be forty queries to render a list. The
    Inbox renders the difference because a silence he did not ask for must
    not be indistinguishable from one he did — that is how a mute stops
    being a preference and becomes something that happened to him.
    """
    rows = await pool.fetch("SELECT check_name, finding_key, muted_by FROM notice_mutes")
    return {(r["check_name"], r["finding_key"]): r["muted_by"] for r in rows}


async def get(pool: asyncpg.Pool, notice_id: uuid.UUID) -> Notice:
    """One row, or a stated CANNOT naming the id. The same sentence every
    other helper here refuses a missing row with, so a caller reading "no
    notice with id … exists" never has to know which call produced it."""
    row = await pool.fetchrow(f"SELECT {_COLUMNS} FROM notices WHERE id = $1", notice_id)
    if row is None:
        raise NoticeError(f"no notice with id {notice_id} exists — nothing was written")
    return Notice.from_row(row)


async def muted_count(pool: asyncpg.Pool) -> int:
    """How many rows the muted filter holds, so the filter can say so. A tab
    reading "Muted" with no number is a tab nobody clicks, and the rows
    behind it stay invisible for the life of the box — which is the same
    outcome as deleting them, reached quietly."""
    # Counted over exactly what the muted VIEW returns (live and silenced),
    # so the number on the tab and the length of the list behind it cannot
    # disagree — a count that outruns its own list is how a tab starts
    # claiming silences nobody can find.
    return await pool.fetchval(f"SELECT count(*) FROM notices WHERE {_SILENCED} AND {_LIVE}")


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
