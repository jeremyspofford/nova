"""The check registry: what Nova looks at on a beat, and what she found.

A CHECK is CODE. It reads rows or sockets and returns FINDINGS — never a
model call, never a sentence a model wrote. That is what makes a finding
safe to wake someone with: its evidence is a row or a socket, not a claim.

Two rules here are load-bearing, both from measured v3 failures:

1. **Urgency is a property of the CHECK, declared in code.** `Check.urgent`
   is the whole of it, and `run_all` OVERWRITES `Finding.urgent` with the
   check's declaration on every finding it passes on. So a check author who
   writes `urgent=True` inside a family that did not declare it changes
   nothing, and neither does anything a model writes. Exactly one family —
   the stack being down (app/checks/stack.py) — declares it, and
   tests/test_checks.py pins that set, so adding a second is a deliberate
   act that reddens a test.

2. **A fingerprint is computed from the DERIVED FACTS a check returns**, never
   from the sentence about them. v3 hashed the model's own text and one model
   re-worded two findings into fourteen phone pushes in eight hours
   (2026-08-08). `fingerprint()` hashes canonical JSON of `{key, facts}` with
   sorted keys, so a re-ordered dict is the same news and a changed value is
   new news. A check therefore puts in `facts` what MAKES the condition true
   and keeps the live measurement in the `title` — a figure that moves every
   hour inside the fingerprint is the v3 failure in a new costume.

A check that could not run is never "all clear". `CheckRun.ran` is False with
`reason` in words whenever the probe could not be made, so the beat that reads
these can compute quiet rather than claim it — `quiet()` here is that
computation, and it is deliberately not vacuous: a run with no checks in it is
NOT quiet, because nothing was checked. Raising `CannotCheck` is how a check
says so deliberately; any other exception says the same thing with the
exception's own words, because a check that crashed also checked nothing.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Awaitable, Callable, Sequence
from contextvars import ContextVar
from dataclasses import dataclass, replace

logger = logging.getLogger("core")

# One check's whole budget. A probe that hangs must not hold the beat behind
# it — the S9 carry, taken here as well as around the firing, because a beat
# runs several checks and one stalled socket would delay every other finding.
CHECK_DEADLINE_S = 60.0


class CannotCheck(RuntimeError):
    """The probe could not be made at all, in words.

    Not a failure of the thing being watched — a failure to LOOK at it: the
    gateway could not be reached to ask about ollama, the ledger did not
    answer, there is not enough history yet to compute a mean. It becomes
    CheckRun(ran=False, reason=...), which stops the beat calling itself
    quiet. The alternative — returning no findings — would read as all clear,
    which is the lie this whole slice exists to prevent.
    """


@dataclass(frozen=True)
class Finding:
    """One thing a check found, in facts and in one code-composed sentence.

    `key` is stable per SUBJECT ("timer_failing:<uuid>", "agent_over_cap:
    <name>", "peer_down:gateway"), so two findings about the same thing share
    it. `facts` is the evidence, and is what the fingerprint is computed over.
    `title` is a sentence the check composed naming the subject and the
    number; it is never hashed, so wording may change without re-raising.
    `urgent` is set by run_all from the CHECK's declaration — whatever a check
    puts here is overwritten.
    """

    key: str
    title: str
    facts: dict
    urgent: bool = False


@dataclass(frozen=True)
class CheckRun:
    """What one check did on one beat.

    ran=False means the probe could not run; `reason` says why in words. A
    beat is QUIET only when every CheckRun.ran is True and no findings — a
    check that did not run is never "all clear".
    """

    check: str
    ran: bool
    reason: str | None
    findings: tuple[Finding, ...] = ()


@dataclass(frozen=True)
class Check:
    """A registered family of facts, and whether it may wake someone.

    `run(app, pool)` returns the findings; raising says the probe could not be
    made. `describe` is one plain line for the digest and the Inbox, so a
    reader never has to open the code to learn what was watched.
    """

    name: str
    describe: str
    urgent: bool
    run: Callable[..., Awaitable[list[Finding]]]


REGISTRY: dict[str, Check] = {}


def register(check: Check) -> Check:
    """Add a check to the registry. A duplicate name is a bug, not a silent
    overwrite — two families sharing a name would make one of them invisible
    and its findings would be attributed to the other."""
    if check.name in REGISTRY:
        raise ValueError(f"a check named {check.name!r} is already registered")
    REGISTRY[check.name] = check
    return check


def register_all(checks: Sequence[Check]) -> None:
    for check in checks:
        register(check)


def check_names() -> list[str]:
    """Every registered check's name, sorted."""
    return sorted(REGISTRY)


def urgent_names() -> list[str]:
    """The checks that may interrupt the digest, DERIVED from the registry —
    never a list someone maintains beside it."""
    return sorted(name for name, check in REGISTRY.items() if check.urgent)


def quiet(runs: Sequence[CheckRun]) -> tuple[bool, str | None]:
    """Is this beat QUIET — and when it is not, why not, in words.

    Quiet is COMPUTED here, in code, so that no reply can claim it. It is true
    only when every check RAN and none of them found anything. Three
    consequences, each of them a defect this closes:

      * a check that could not run makes the beat not quiet and names itself
        with its reason. "All clear" from a probe that was never made is the
        v3 incident this slice exists to prevent, and it is the reason a beat
        reports `incomplete` rather than nothing;
      * an EMPTY run is not vacuously quiet. `all(...)` over no checks is
        True, which would let a registry that failed to import — or a caller
        that filtered every check away — report a perfect night having looked
        at nothing. No check having run IS the finding, so it is stated;
      * the reason is derived from the runs themselves, so a family added to
        the registry appears in it with no edit here.

    What it CANNOT see is a caller that failed after a check ran cleanly — a
    beat whose notice writes were refused, say. That caller holds a fact this
    function was never given, and must fold it into its own verdict; a check
    that looked cleanly is all there is to read here.

    Returns (True, None) or (False, why).
    """
    if not runs:
        return False, "no check ran — nothing was checked"
    unrun = [run for run in runs if not run.ran]
    found = [run for run in runs if run.findings]
    if not unrun and not found:
        return True, None
    parts: list[str] = []
    if found:
        total = sum(len(run.findings) for run in found)
        parts.append(f"{total} finding(s) from {', '.join(run.check for run in found)}")
    if unrun:
        # A CheckRun cannot be ran=False without a reason (every path through
        # _wrapped writes one), but a caller may hand us a hand-built one, and
        # "could not run, no reason given" is still more honest than a blank.
        parts.append(
            f"{len(unrun)} check(s) could not run: "
            + "; ".join(f"{run.check} — {run.reason or 'no reason stated'}" for run in unrun)
        )
    return False, ". ".join(parts)


# One beat's scratch, and nothing longer. See run_cache().
_RUN_CACHE: ContextVar[dict[str, object] | None] = ContextVar("nova_check_run_cache", default=None)


def run_cache() -> dict[str, object]:
    """Scratch shared by every check in ONE run, and by nothing else.

    Two checks can need the same expensive answer: stack_ollama and
    stack_chat_model both read the gateway's whole model catalogue, which the
    gateway assembles by fanning out to ollama's /api/tags and to every
    configured provider's listing. Without this they build it twice for one
    beat's worth of facts.

    The lifetime is exactly one `run_all`/`run_one` call. run_all sets the dict
    before it gathers, so the tasks it spawns inherit a context pointing at the
    SAME dict and share whatever one of them fetched, and it resets afterwards
    so two beats an hour apart never share an answer — a cached probe is a
    probe that was not made this beat, which is the thing this slice refuses to
    let anyone report as a fact. Outside a run there is no cache at all: this
    hands back a fresh dict nobody else holds, so a check called directly
    always looks for itself.
    """
    cache = _RUN_CACHE.get()
    return {} if cache is None else cache


def fingerprint(finding: Finding) -> str:
    """sha256 over canonical JSON of {"key", "facts"}, keys sorted.

    The facts, and only the facts. `title` is deliberately absent: it is the
    sentence, and hashing sentences is the v3 bug. Sorting is recursive
    (json.dumps sort_keys), so a dict built in a different order is the same
    news and folds onto the row already raised.

    `default=str` is a serialisation detail, not a fallback that hides
    anything: a Decimal, UUID or datetime that reached `facts` hashes as its
    own text, deterministically. Every check in this package composes plain
    JSON values, which is also what the notices `facts jsonb` column stores.
    """
    payload = json.dumps(
        {"key": finding.key, "facts": finding.facts},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _reason(exc: BaseException) -> str:
    """A short, honest description of why a check could not run."""
    text = str(exc).strip()
    if isinstance(exc, CannotCheck):
        # Already written for a reader — the class name would add nothing.
        return text or "the check stated no reason"
    if isinstance(exc, TimeoutError):
        return f"the check did not finish within {CHECK_DEADLINE_S:g}s"
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


def _declared(check: Check, findings: object) -> tuple[Finding, ...]:
    """The findings as the REGISTRY declares them, or a stated failure.

    This is the line of code that refuses when a check author is wrong:
    `urgent` is taken from the Check, so a family that did not declare
    urgency cannot produce an urgent finding however it builds the value.
    A finding with no key or no title is refused too — a notice with a blank
    key could never fold onto anything and a blank title says nothing to the
    person it wakes.
    """
    if not isinstance(findings, list | tuple):
        raise TypeError(f"{check.name} returned {type(findings).__name__}, not a list of findings")
    out: list[Finding] = []
    for finding in findings:
        if not isinstance(finding, Finding):
            raise TypeError(f"{check.name} returned {type(finding).__name__}, not a Finding")
        if not finding.key.strip() or not finding.title.strip():
            raise ValueError(f"{check.name} returned a finding with no key or no title")
        out.append(
            finding if finding.urgent == check.urgent else replace(finding, urgent=check.urgent)
        )
    return tuple(out)


async def _wrapped(check: Check, app, pool) -> CheckRun:
    """One check, run so that nothing it does can stop the beat.

    Every exception becomes ran=False with the reason in words — never a
    crash that loses the other checks, and never a silent skip that would
    let the beat read as quiet.
    """
    try:
        raw = await asyncio.wait_for(check.run(app, pool), CHECK_DEADLINE_S)
        return CheckRun(check=check.name, ran=True, reason=None, findings=_declared(check, raw))
    except Exception as exc:  # noqa: BLE001 — every failure shape is stated, none escapes
        reason = _reason(exc)
        logger.warning("check %s could not run — %s", check.name, reason)
        return CheckRun(check=check.name, ran=False, reason=reason, findings=())


async def run_all(app, pool) -> list[CheckRun]:
    """Every registered check, concurrently, in name order.

    Concurrent because a stalled peer must not delay the findings of the
    checks that would have answered; wrapped one by one because a check that
    raises must cost only its own result. The list is in `check_names()`
    order so two beats read the same way.

    The run cache is set HERE and reset after, so it covers exactly this beat:
    the tasks gather spawns copy this context and therefore share the one dict
    (see run_cache), and the next beat starts with nothing carried over.
    """
    names = check_names()
    token = _RUN_CACHE.set({})
    try:
        return list(await asyncio.gather(*(_wrapped(REGISTRY[name], app, pool) for name in names)))
    finally:
        _RUN_CACHE.reset(token)


async def run_one(app, pool, name: str) -> CheckRun:
    """One check by name. An unregistered name is a CheckRun that did not run,
    naming the live registry — the caller asked about something real to it, and
    a KeyError here would say less than the list of what exists."""
    check = REGISTRY.get(name)
    if check is None:
        return CheckRun(
            check=name,
            ran=False,
            reason=f"no check named {name!r} is registered — {', '.join(check_names()) or 'none'}",
            findings=(),
        )
    # Its own cache: one check asked for on its own is its own whole run, and
    # must not read an answer a previous call fetched.
    token = _RUN_CACHE.set({})
    try:
        return await _wrapped(check, app, pool)
    finally:
        _RUN_CACHE.reset(token)


# Registered at import, at the BOTTOM, so each family can import Check/Finding/
# CannotCheck from this module while it is still being defined. Importing
# app.checks is what makes the registry complete — there is no separate "wire
# it up" step to forget (the v3 lesson: a capability nobody registered is
# invisible from the code and obvious the moment it is asked for).
from app.checks import money, stack, work  # noqa: E402

register_all(stack.CHECKS)
register_all(work.CHECKS)
register_all(money.CHECKS)

__all__ = [
    "CHECK_DEADLINE_S",
    "REGISTRY",
    "CannotCheck",
    "Check",
    "CheckRun",
    "Finding",
    "check_names",
    "fingerprint",
    "money",
    "quiet",
    "register",
    "register_all",
    "run_all",
    "run_cache",
    "run_one",
    "stack",
    "urgent_names",
    "work",
]
