"""Test-only cleanup for suite-generated governance events (Slice 2.1).

THE NARROW, DOCUMENTED EXCEPTION to the production append-only contract
(docs/DECISIONS.md D-031): a test suite that drives real governance-producing
paths must remove ONLY its own explicitly identified probe rows, in its
`finally` block, and assert zero remain. Production code never deletes from
governance_events — pinned by test_governance_ledger.py, which also pins
that nothing under app/ references this module.

Deliberately narrow API — the selectors are the ONLY ways to address rows:

  - exact ``subject_ids`` (the default and preferred selector);
  - ``subject_prefixes`` restricted to the RESERVED test namespaces below;
  - ``kinds`` (payload 'kind') restricted to the reserved test kinds below;
  - and EVERY operation is bounded by ``after_id`` — the ledger high-water
    mark captured at suite start — so no historical row (anything that
    existed before this run) can ever be touched, whatever the selectors.

There is no way to pass an arbitrary LIKE pattern, delete by event type,
delete by time range, or delete by actor. ``purge`` returns the exact ids
it deleted (ids only — payload values are never logged or returned).
"""

import asyncio

#: Subject prefixes reserved for test probes (test_recommendation_actions).
RESERVED_SUBJECT_PREFIXES = ("scratch-t13-", "scratch-t14-")
#: Consent kinds reserved for test probes (test_consent_burn, ledger suite).
RESERVED_KINDS = ("test.burn", "test.gov")


async def start_watermark(conn) -> int:
    """The ledger high-water mark at suite start. Everything this suite may
    later delete must have id GREATER than this — historical rows are
    structurally out of reach."""
    return await conn.fetchval(
        "SELECT coalesce(max(id), 0) FROM governance_events")


def _where(after_id, subject_ids, subject_prefixes, kinds):
    if not (subject_ids or subject_prefixes or kinds):
        raise ValueError("gov cleanup needs at least one selector — "
                         "a bare after_id would be a broad delete")
    for p in subject_prefixes:
        if p not in RESERVED_SUBJECT_PREFIXES:
            raise ValueError(f"prefix {p!r} is not a reserved test namespace")
    for k in kinds:
        if k not in RESERVED_KINDS:
            raise ValueError(f"kind {k!r} is not a reserved test kind")
    sel, args = [], [int(after_id)]

    def ref(v):
        args.append(v)
        return f"${len(args)}"

    if subject_ids:
        sel.append(f"subject_id = ANY({ref(list(subject_ids))}::text[])")
    for p in subject_prefixes:
        sel.append(f"subject_id LIKE {ref(p + '%')}")
    if kinds:
        sel.append(f"payload->>'kind' = ANY({ref(list(kinds))}::text[])")
    return f"id > $1 AND ({' OR '.join(sel)})", args


async def purge(conn, *, after_id, subject_ids=(), subject_prefixes=(),
                kinds=()) -> list[int]:
    """Delete this suite's own probe events; returns the exact deleted ids."""
    where, args = _where(after_id, subject_ids, subject_prefixes, kinds)
    rows = await conn.fetch(
        f"DELETE FROM governance_events WHERE {where} RETURNING id", *args)
    ids = [r["id"] for r in rows]
    if ids:
        print(f"  gov-cleanup: deleted event id(s) {ids}")
    return ids


async def drain(conn, *, after_id, subject_ids=(), subject_prefixes=(),
                kinds=(), timeout_s: float = 2.0) -> list[int]:
    """purge() until quiet — for suites whose events arrive from
    fire-and-forget background tasks. Two consecutive empty passes (or the
    timeout) end the loop."""
    deleted: list[int] = []
    quiet = 0
    waited = 0.0
    while quiet < 2 and waited <= timeout_s:
        got = await purge(conn, after_id=after_id, subject_ids=subject_ids,
                          subject_prefixes=subject_prefixes, kinds=kinds)
        deleted += got
        quiet = quiet + 1 if not got else 0
        if quiet < 2:
            await asyncio.sleep(0.2)
            waited += 0.2
    return deleted


async def remaining(conn, *, after_id, subject_ids=(), subject_prefixes=(),
                    kinds=()) -> int:
    where, args = _where(after_id, subject_ids, subject_prefixes, kinds)
    return await conn.fetchval(
        f"SELECT count(*) FROM governance_events WHERE {where}", *args)


async def start_marks(conn) -> tuple[int, object]:
    """(ledger high-water id, DB clock now()) at suite start — the bounds
    every later deletion is scoped by."""
    return (await start_watermark(conn), await conn.fetchval("SELECT now()"))


async def drain_pair(conn, *, gov_after_id, legacy_after_ts, subject_ids=(),
                     subject_prefixes=(), timeout_s: float = 2.0) -> tuple[int, list[int]]:
    """For suites whose capability events arrive from fire-and-forget
    background tasks: repeatedly sweep THIS RUN'S late-arriving legacy
    capability_events rows (bounded by the suite's start timestamp) and
    their governance mirrors (bounded by the start watermark), until two
    quiet passes or timeout. Same reserved-namespace validation as purge();
    historical rows are out of reach by both bounds."""
    for p in subject_prefixes:
        if p not in RESERVED_SUBJECT_PREFIXES:
            raise ValueError(f"prefix {p!r} is not a reserved test namespace")
    if not (subject_ids or subject_prefixes):
        raise ValueError("drain_pair needs subject selectors")
    sel, args = [], [legacy_after_ts]
    if subject_ids:
        args.append(list(subject_ids))
        sel.append(f"subject = ANY(${len(args)}::text[])")
    for p in subject_prefixes:
        args.append(p + "%")
        sel.append(f"subject LIKE ${len(args)}")
    legacy_sql = (f"DELETE FROM capability_events "
                  f"WHERE at > $1 AND ({' OR '.join(sel)})")
    legacy_n, gov_ids, quiet, waited = 0, [], 0, 0.0
    while quiet < 2 and waited <= timeout_s:
        tag = await conn.execute(legacy_sql, *args)
        n = int(tag.rsplit(" ", 1)[-1])
        got = await purge(conn, after_id=gov_after_id,
                          subject_ids=subject_ids,
                          subject_prefixes=subject_prefixes)
        legacy_n += n
        gov_ids += got
        quiet = quiet + 1 if (n == 0 and not got) else 0
        if quiet < 2:
            await asyncio.sleep(0.2)
            waited += 0.2
    return legacy_n, gov_ids


async def remaining_pair(conn, *, gov_after_id, legacy_after_ts,
                         subject_ids=(), subject_prefixes=()) -> int:
    """Suite-owned rows still present in either table, run-bounded."""
    sel, args = [], [legacy_after_ts]
    if subject_ids:
        args.append(list(subject_ids))
        sel.append(f"subject = ANY(${len(args)}::text[])")
    for p in subject_prefixes:
        args.append(p + "%")
        sel.append(f"subject LIKE ${len(args)}")
    legacy = await conn.fetchval(
        f"SELECT count(*) FROM capability_events "
        f"WHERE at > $1 AND ({' OR '.join(sel)})", *args)
    gov = await remaining(conn, after_id=gov_after_id,
                          subject_ids=subject_ids,
                          subject_prefixes=subject_prefixes)
    return legacy + gov
