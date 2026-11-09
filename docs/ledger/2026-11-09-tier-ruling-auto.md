**2026-11-09 · Approvals · The owner's follow-up: home changes from automations and schedules run freely too**
- What changed: asked whether a Home Assistant call an automation or schedule starts should also run without asking, the owner answered "yes run freely". Recorded in INPUT-2026-11-09-TIER-RULING.md as decision 5, and the smart-home plan's "not ruled on" note now says so. The connector already runs every call at service_tier whoever starts it, so no code changes.
- What you can now do: rely on a rule like "unlock the door at 6 pm" running on its own and being reported.
- Still unfinished: the approval-tiers Settings screen the owner agreed to is being designed first.
- Checked: docs only; ledger-files, check-changelog and agent-pointers pass.
