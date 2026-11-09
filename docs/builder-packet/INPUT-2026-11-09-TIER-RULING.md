# Owner ruling: approval tiers for Home Assistant, the vault, paired phones and browser sign-ins (2026-11-09)

Date: 2026-11-09. Source: Jeremy's direct chat instruction to the integrator.

Owner input, verbatim:

> Home assistant should be tier 0 or 1. If I ask nova to unlock the door, it should just do it. Vault should be tier 3. Paired phones, no I don't think so. Browser sign-ins, probably tier 0 or 1. If they have access to a credential, they should be able to use it freely.

The owner also asked: "these can all be changed later in settings right?"

## Decisions

1. **Home Assistant is tier 1 (act and report).** A service call the person asks for runs without
   an approval and is recorded in the Work Ledger as act-and-report, with Nova's own read-back from
   Home Assistant as the evidence. No domain needs a tier-3 confirmation by default (the default
   list of tier-3 domains is empty; locks and alarms are no longer on it). The list stays a
   setting, so the owner can put domains back, and the service tier itself is a setting (1 by
   default, 2 to ask first again). A failed read-back still holds the task rather than calling
   again.
2. **The vault is tier 3.** Deleting a secret needs `{confirm: true}`, with a passkey on Nova's own
   screen, like every tier-3 route. Starting a new vault stays tier 3 and is limited to devices
   allowed to approve.
3. **Paired phones: no change.** A paired device allowed to approve confirms a tier-3 route with
   `{confirm: true}` and no passkey, as before.
4. **Browser sign-ins are tier 1.** Using a saved sign-in in a browser task no longer raises the
   task's tier by itself: the sign-in step, and ordinary typing, choosing and clicking on the
   task's declared sites, are tier 1. Checkout and account changes keep their tiers (tier 3), and
   so does forgetting a site (tier 3: it deletes data, consistent with the vault ruling).

## The integrator's two constraints, told to the owner

- **The outside-content (taint) protection stays.** In a run that has read outside content (mail,
  web pages and the rest; `src/runner.js`, the ingest gate's guarded steps), the steps it gates
  still ask the person, whatever their tier. A Home Assistant call from such a run asks first.
- **Payments are unchanged.** A browser checkout still stops at the itemised total, and Nova never
  presses pay.

## What this overrides

NOVA-SPEC §6 lists "changing devices/home state" under tier 2 (ask first). The owner overrides
that for Home Assistant: a call the person asks for directly is tier 1. The spec text should be
amended to say so (see the integrator's report for the exact place).
