"""An eval's scratch person: the one definition (S42b Task 24).

Every eval case runs its turn as a fresh scratch person — runner.scratch_person
writes one per case: a guest whose name starts with SCRATCH_PERSON_NAME. Two
places must recognise exactly those people and no one else, and both read
this module, never a copy of it:

  * runner._sweep_orphan_scratch_people deletes them (a case killed before its
    teardown leaves one behind);
  * scheduler.tick_once never claims a timer one of them owns, so no timer an
    eval replay sets can fire on the real system.

A leaf: it imports nothing from app (pinned), so the scheduler reads the
definition without loading the eval harness.
"""

from __future__ import annotations

SCRATCH_PERSON_NAME = "__eval_scratch__"
SCRATCH_PERSON_ROLE = "guest"


def is_scratch_person(row: str) -> str:
    """The SQL that is true for exactly the scratch people. `row` names the
    people row in the caller's statement: the table itself, or its alias.

    starts_with(), never LIKE, so the name's own underscores are never read
    back as wildcards. The two values are written in as literals; neither
    holds a quote or a backslash (pinned), so the fragment is safe to splice
    into a statement."""
    return (
        f"({row}.role = '{SCRATCH_PERSON_ROLE}' "
        f"AND starts_with({row}.name, '{SCRATCH_PERSON_NAME}'))"
    )
