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

## Follow-up ruling, 2026-11-09: automations and schedules

The integrator asked: the ruling speaks of calls the person asks for, but the connector runs every
service call at `service_tier`, including one an automation or schedule starts (a rule that unlocks
the door at 6 pm). Should those run without asking too, or ask first?

Owner answer, verbatim:

> 1 yes run freely.

5. **Home Assistant calls an automation or schedule starts are tier 1 too.** They run without an
   approval, act and report, like a call the person asks for: the person made the rule. This is
   what the connector already does (it runs every call at `service_tier`), so no code changes.
   The constraints above still hold where they apply: a run that has read outside content still
   asks before a Home Assistant call, and the `service_tier` and `tier3_domains` settings raise
   every call, whoever starts it.

The owner also agreed to a Settings screen for approval tiers, design first.

## Follow-up rulings, 2026-11-09: who may loosen, and the direction

The Approvals compositions found that any paired phone or browser, not only one allowed to
approve, can loosen Home Assistant's settings, and that turning a chat step to "Without asking"
takes one click with no confirmation. Owner answers, verbatim:

> Any decice should be able to change home assistant settings

> Yes. We should allow nova to do things without asking. Actually, she should be able to do most or all without asking, or at least have settings to allow that

6. **Any paired device may change Home Assistant's settings.** The route stays open to any paired
   person, as it is; on Nova's own screen a loosening still confirms with the passkey, like every
   confirmation there.
7. **A chat-step switch turns on with one click.** No confirmation is added.
8. **Direction: Nova should be able to do most or all things without asking, or at least have
   settings that allow it.** Each capability's tier becomes a setting the owner can lower to
   "does it and tells you"; defaults stay where they are until the owner changes them. The
   integrator proposed three floors no setting removes, for the owner to keep or overrule: Nova
   never presses pay; after outside content a guarded step asks (it stops a message Nova read
   from acting as the owner); and the vault stays tier 3, by decision 2.
