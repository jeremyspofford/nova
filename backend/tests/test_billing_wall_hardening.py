"""Two ways the billing-wall guard could quietly betray the operator.

    docker compose exec backend python tests/test_billing_wall_hardening.py

Both come out of the adversarial review of the 2026-08-07 billing lane, and
both are the same defect shape this codebase keeps finding: a control that
FAILS SILENTLY reads exactly like a control that held.

1. The cooldown that stops the next pass from walking into the same 402 is a
   single `spend_ledger` row and nothing else. `spend.record` catches its own
   exceptions and returns `{"error": ...}`. If `_record_wall` ignores that,
   a failed insert removes the guard without a word, and the next heartbeat
   tick five minutes later re-runs the wall — the exact measured loop the
   guard exists to end. So `_record_wall` returns whether it persisted, and
   `_stop_on_wall` tells the operator when it did not.

2. The provider's own error text names the key in a URL path
   (`.../keys/<hex>`), and this lane copied that text into three new persisted
   places. The scrubber masked query-string keys and known token shapes but
   not an id sitting in the PATH. Now it does — keeping the console URL
   readable so the operator still knows where to go, masking only the id.
"""

import sys

sys.path.insert(0, "/app/backend")

from app import redact                                    # noqa: E402
from app.actions import code_change                       # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


print("\n1. a failed cooldown write is surfaced, not swallowed")

# _record_wall must report whether the row landed. Both branches, via a stub
# spend.record — the real one catches and returns {"error": ...} on failure.
import app.spend as spend                                 # noqa: E402


class _Doc:
    goal_id = None


async def _call_record(result):
    real = spend.record
    try:
        async def fake(*a, **k):
            return result
        spend.record = fake

        class _Fault:
            reason = "billing"
            status = 402

            def operator_note(self):
                return "the key is out of monthly limit"
        return await code_change._record_wall(
            "improve", _Doc(), _Fault(), attempt=1, run_id=None)
    finally:
        spend.record = real


import asyncio                                             # noqa: E402

armed_ok = asyncio.get_event_loop().run_until_complete(
    _call_record({"id": "abc", "metered": False}))
check("a successful ledger write reports the cooldown ARMED", armed_ok is True)

armed_fail = asyncio.get_event_loop().run_until_complete(
    _call_record({"id": None, "error": "not recorded"}))
check("a FAILED ledger write reports the cooldown did NOT arm",
      armed_fail is False)

check("_stop_on_wall takes a cooldown_armed argument at all",
      "cooldown_armed" in code_change._stop_on_wall.__code__.co_varnames)


print("\n2. a key id in a URL path is masked, structure kept")

# The two real shapes from the incident and the finding.
for raw in [
    "adjust the limit at https://openrouter.ai/workspaces/default/keys/"
    "10788e94091aa6b74936a5b8947459d949812195dcab9d0a012088c5d07161f5 now",
    "visit https://openrouter.ai/settings/keys/"
    "10788e94-3c2f-4a1b-9d0e-abcdef123456 and raise it",
]:
    scrubbed = redact.scrub_text(raw)
    check("the key id is gone", "10788e94" not in scrubbed, scrubbed[:70])
    check("...but the console URL is still readable",
          "openrouter.ai" in scrubbed and "/keys/" in scrubbed, scrubbed[:70])

# And it does NOT over-reach onto innocent paths.
check("a short path segment after /keys/ is untouched",
      "list" in redact.scrub_text("GET https://api.x.com/v1/keys/list"),
      redact.scrub_text("GET https://api.x.com/v1/keys/list"))
check("the word api-keys with no id is untouched",
      "api-keys" in redact.scrub_text("open the api-keys/ page"))

# The scrubber is idempotent — running it twice must not double-mask or eat
# the anchor.
once = redact.scrub_text("keys/10788e94091aa6b74936a5b8947459d94981219")
check("idempotent", redact.scrub_text(once) == once, once)

print()
if FAILURES:
    print(f"FAILED: {len(FAILURES)}")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all checks passed")
