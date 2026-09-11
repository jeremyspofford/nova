"""The gates manifest — an evidence-backed inventory of Nova's mechanical
enforcement points, with a verifier and an advisory boot report.

WHAT THIS IS, AND IS NOT (Slice 1 approval, 2026-08-25 — see
docs/DECISIONS.md): this manifest is an inventory and verification aid. It is
NOT the canonical authorization mechanism, NOT proof of complete coverage,
and NOT a claim that any listed control is correct or effective. The policy
kernel that will make authorization decisions (decision TA-2) is future,
separately-approved work. Until then this file answers one question
mechanically: "which enforcement points does this build claim to have, and
does each still resolve to real code and a real pinning test?"

Rules the verifier holds (from the Slice 1 amendments):

  - Every enforcement point named here has exactly one entry whose status is
    ``active`` or ``transitional`` — no point is double-claimed.
  - Every entry's owner symbol imports, and every listed pinning-test path
    exists on disk. A gate whose test was renamed breaks loudly here rather
    than rotting silently.
  - A ``retired`` or ``superseded`` entry must carry ``superseded_by``, a
    ``rationale``, and at least one test pinning the replacement or the
    preserved behavior — controls leave the manifest with a paper trail,
    never by deletion alone.
  - There is deliberately NO entry-count ratchet: gates may later be
    consolidated or retired as the canonical evaluator arrives; the diff of
    this file is the review surface for that.

``report()`` is advisory only: structured logs, no secrets, no user-visible
output, and it must never affect boot, requests, or any authorization
outcome (same posture as main._report_stale_grants).
"""

from __future__ import annotations

import importlib
import logging
from pathlib import Path

log = logging.getLogger(__name__)

STATUSES = ("active", "transitional", "planned_replacement",
            "superseded", "retired")

#: The backend root (…/backend), for resolving pinning-test paths.
_BACKEND = Path(__file__).resolve().parents[1]

_REQUIRED = ("id", "owner", "property", "enforcement_point", "tests",
             "status", "evidence")

#: One entry per mechanical enforcement point. ``owner`` is
#: "module:symbol"; ``tests`` are paths relative to backend/.
MANIFEST: list[dict] = [
    {
        "id": "grant-check",
        "owner": "app.tools.registry:execute_tool",
        "property": "an agent can only call tools it has been granted",
        "enforcement_point": "execute_tool gate 1 (grant resolution)",
        "tests": ["tests/test_eval_grants.py", "tests/test_inlined_grants.py"],
        "status": "active",
        "evidence": "tools/registry.py:793; grants snapshot evals/tasks/granted.json",
    },
    {
        "id": "containment-invariant",
        "owner": "app.tools.registry:is_actor",
        "property": "no turn both holds untrusted-origin text and executes an actor tool",
        "enforcement_point": "execute_tool gate 2 (containment)",
        "tests": ["tests/test_containment.py"],
        "status": "active",
        "evidence": "tools/registry.py:564 is_actor / ACTOR_TOOLS:463",
    },
    {
        "id": "goal-gate",
        "owner": "app.tools.scopes:needs_goal",
        "property": "capability-creating verbs run only against an active goal approving them, with an atomic action spend",
        "enforcement_point": "execute_tool gate 3 (goal scope)",
        "tests": ["tests/test_goal_gate_card.py", "tests/test_goals.py",
                  "tests/test_improvement_lane.py"],
        "status": "active",
        "evidence": "tools/registry.py:864-960; goals.spend; scopes.GOAL_SCOPED_TOOLS",
    },
    {
        "id": "rules-engine",
        "owner": "app.rules:check",
        "property": "operator-authored block/warn rules apply to tool calls; engine errors fail open, rule matches never do",
        "enforcement_point": "execute_tool gate 4 (rules)",
        "tests": ["tests/test_inlined_grants.py"],
        "status": "active",
        "evidence": "rules.py:57 check; tools/registry.py:962-978",
    },
    {
        "id": "fixture-intercept",
        "owner": "app.tools.fixtures:intercept",
        "property": "eval replay serves recorded results below the gates and above every executor, so no eval touches the world",
        "enforcement_point": "execute_tool gate 5 (eval fixtures)",
        "tests": ["tests/test_eval_harness.py", "tests/test_eval_servability.py"],
        "status": "active",
        "evidence": "tools/fixtures.py:324; tools/registry.py:982",
    },
    {
        "id": "consent-burn",
        "owner": "app.consents:validate_and_use",
        "property": "a guarded action consumes exactly one approved, unexpired consent, burned in a single UPDATE",
        "enforcement_point": "consents.validate_and_use (tool-layer check-and-burn)",
        "tests": ["tests/test_consent_burn.py", "tests/test_consent_visibility.py"],
        "status": "active",
        "evidence": "consents.py:181; TTL+burn in the WHERE clause",
    },
    {
        "id": "landing-tripwire",
        "owner": "app.tripwire:may_land_unattended",
        "property": "a patch touching protected paths (including this tripwire) cannot land unattended; unparseable diffs are refused",
        "enforcement_point": "code_change verify-and-land gate 4 (tripwire)",
        "tests": ["tests/test_tripwire.py"],
        "status": "active",
        "evidence": "tripwire.py:166; PROTECTED:41 includes its own source",
    },
    {
        "id": "landing-gate-order",
        "owner": "app.actions.code_change:_step_verify_and_land",
        "property": "autonomous landing requires sandbox ok, then review, then eval floor (unmeasured is not a pass), then tripwire — in that order, keyed to one commit",
        "enforcement_point": "code_change verify-and-land step",
        "tests": ["tests/test_code_landing.py", "tests/test_build_loop.py"],
        "status": "active",
        "evidence": "actions/code_change.py:902; BUILD_STEPS:1013",
    },
    {
        "id": "guest-route-deny",
        "owner": "app.guests:route_is_guest_ok",
        "property": "guest tokens reach only routes explicitly marked guest-ok; everything else is refused by default",
        "enforcement_point": "auth middleware (guest route gating)",
        "tests": ["tests/test_guest_auth_matrix.py"],
        "status": "active",
        "evidence": "guests.py:459; main.py:394 auth_middleware",
    },
    {
        "id": "prompt-slot-allowlist",
        "owner": "app.agents.runner:_PromptSlots",
        "property": "prompt slots are default-deny for non-operator audiences; an undeclared slot raises rather than leaks",
        "enforcement_point": "system-prompt assembly (slot admission)",
        "tests": ["tests/test_guest_sessions.py"],
        "status": "active",
        "evidence": "agents/runner.py:933; built after the 2026-08-07 guest slot leak",
    },
    {
        "id": "sidecar-auth",
        "owner": "app.sidecar_auth:git_landing_headers",
        "property": "privileged sidecars receive a bearer token from one helper module; a bare call site is caught mechanically",
        "enforcement_point": "backend -> git-landing / inference-control HTTP calls",
        "tests": ["tests/test_sidecar_auth.py"],
        "status": "active",
        "evidence": "sidecar_auth.py:26; AST call-site scan in the suite",
    },
    {
        "id": "spend-ceilings",
        "owner": "app.spend:may_start",
        "property": "the improve lane cannot start work past its daily pass/token/usd ceilings or through an active wall; local endpoints are not charged",
        "enforcement_point": "spend.may_start / spend.active_wall (pre-work refusal)",
        "tests": ["tests/test_spend_metering.py", "tests/test_improve_walls.py"],
        "status": "active",
        "evidence": "spend.py:375 may_start / :319 active_wall",
    },
    {
        "id": "host-allowlist",
        "owner": "app.main:host_allowlist_middleware",
        "property": "requests with unexpected Host headers or browser cross-site posture are refused (DNS-rebinding defence)",
        "enforcement_point": "HTTP middleware (host allowlist)",
        "tests": ["tests/test_security_rails.py"],
        "status": "active",
        "evidence": "main.py:486",
    },
]


def verify() -> list[str]:
    """Return a list of human-readable discrepancies (empty = clean).

    Import- and filesystem-level only: no DB, no network, no side effects.
    """
    problems: list[str] = []
    seen_ids: set[str] = set()
    live_points: dict[str, list[str]] = {}

    for entry in MANIFEST:
        eid = entry.get("id", "<missing id>")
        for field in _REQUIRED:
            if not entry.get(field):
                problems.append(f"{eid}: missing required field {field!r}")
        if eid in seen_ids:
            problems.append(f"{eid}: duplicate id")
        seen_ids.add(eid)

        status = entry.get("status")
        if status not in STATUSES:
            problems.append(f"{eid}: unknown status {status!r}")

        owner = entry.get("owner", "")
        if ":" not in owner:
            problems.append(f"{eid}: owner {owner!r} is not 'module:symbol'")
        else:
            mod_name, symbol = owner.split(":", 1)
            try:
                mod = importlib.import_module(mod_name)
                if not hasattr(mod, symbol):
                    problems.append(f"{eid}: {mod_name} has no symbol {symbol!r}")
            except Exception as exc:   # noqa: BLE001 — report, never raise
                problems.append(f"{eid}: owner import failed: {exc!r:.120}")

        for rel in entry.get("tests", []):
            if not (_BACKEND / rel).is_file():
                problems.append(f"{eid}: pinning test {rel!r} does not exist")

        if status in ("retired", "superseded"):
            if not entry.get("superseded_by"):
                problems.append(f"{eid}: {status} entry lacks superseded_by")
            if not entry.get("rationale"):
                problems.append(f"{eid}: {status} entry lacks rationale")
            if not entry.get("tests"):
                problems.append(f"{eid}: {status} entry lists no test pinning "
                                "the replacement/preserved behavior")
        elif status in ("active", "transitional"):
            point = entry.get("enforcement_point", "")
            live_points.setdefault(point, []).append(eid)

    for point, ids in live_points.items():
        if len(ids) > 1:
            problems.append(
                f"enforcement point {point!r} claimed by more than one "
                f"active/transitional entry: {', '.join(sorted(ids))}")

    return problems


def report() -> None:
    """Advisory boot report — structured logs only, never fatal, never
    user-visible, affects no decision (same posture as _report_stale_grants).
    """
    try:
        problems = verify()
        counts: dict[str, int] = {}
        for entry in MANIFEST:
            status = entry.get("status", "<missing>")
            counts[status] = counts.get(status, 0) + 1
        summary = ", ".join(f"{k}={v}" for k, v in sorted(counts.items()))
        if problems:
            for p in problems:
                log.error("GATES MANIFEST: %s", p)
            log.error("gates manifest: %d entries (%s), %d discrepancies",
                      len(MANIFEST), summary, len(problems))
        else:
            log.info("gates manifest: %d entries (%s), no discrepancies",
                     len(MANIFEST), summary)
    except Exception:   # noqa: BLE001 — an advisory report must never stop boot
        log.exception("gates manifest report failed")
