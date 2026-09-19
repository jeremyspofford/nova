# S40b carries: what the honesty guards leave for later

Found and **deliberately not fixed in S40b**, each with a reason. The review
trail is in the SDD ledger; the rulings are collected in
[`s40b/rulings.md`](s40b/rulings.md).

## The guards' own limits

- **A machine is a subject only if it served this turn or was read this turn.** So a claim about a machine that neither served nor was read (a second machine, before S44) is not checked at all. The gateway's live machine list would fix it; that arrives with S44.
- **Positive claims never fire.** By construction, every derived machine has either a read or a served round, so "hub is ready" cannot be corrected. The design pins this as a property.
- **A history label on the line above a served or memory claim is still corrected.** Their cut reads the claim's own clause. The machinery stops growing here by ruling.
- **Case-exact machine names.** "Hub is offline." and "The hub is offline." are accepted misses.
- **A negative key/value status line** ("- Serving: Off") is not a claim shape.
- **"Away from home, hub is unreachable."** is still corrected: "away" is not in the scope prepositions. Pre-existing to the follow-up, recorded not widened.
- **Bare "No model was used."** and "No model was needed." with no served-by header are accepted misses (the pinned reason is in `test_served_guard.py`).
- **`stack_claim` still fires on "Your notes say the model is down."** Attribution cuts were added to the three new guards, not to `stack_claim`.
- **The history-label machinery has a long tail.** Each fix round produced new edge cases. If it keeps growing, the recorded alternative is a stamp-based check: compare the reading's own timestamp with the turn's start, instead of parsing how she labelled it.

## Evidence and arming

- **The eval cases still name `machine_status`** rather than the derived read set (`machine_status`, `inference_health`, `route_explain`). The choice is stated in the case comment.
- **Arming is chat and eval turns only.** Scheduled, beat and agent turns are not checked: precision was never measured there.
- **The real-traffic measurement covers what is armed.** Of 662-663 replies, the machine branch and the served, memory and stack guards were armed on 474 (440 eval + 34 chat); the other 188 (beat and agent) exercised only the device branch.

## Performance

- **`_TRAILING_SIZE` is fixed, and the sweep now runs 200 and 1,500 characters.** The 1,500-character sweep found three more quadratic patterns (`_CLAUSE_SPLIT`, `_FAULT_COPULA`, `_IN_USE_LIMITED`), all fixed.
- **Every guard still runs synchronously in core's event loop.** The timing sweep is the control. If a guard ever needs unbounded work, it belongs off the loop.

## Prompts and history

- **Stamps cost context.** Each stamp is about 98 characters against `HISTORY_CHAR_BUDGET` (8,000). In a conversation where every turn reads something live, that is real. Measure before changing.
- **A leading stamp she copies is stripped at the persist boundary; a trailing one is not.**

## Found by the S40b walk

- **She does not know which physical machine `hub` is.** In the walk she said `hub` is "almost certainly not your Dell … a separate machine I can only see through the gateway". It is the Dell's own bundled container. Hedged, so no guard applies, and no fact in her toolset says otherwise. Machine identity (hostname, and the agent's own facts) arrives with S44.
- **The replay did not recur.** Asked the same question that produced it, she called `machine_status` and reported a live reading. The stamp appears to be doing the work the guard exists to catch, which is the right order: the truth half first, the guard as the backstop.
