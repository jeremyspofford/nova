# Plan: capture screening, job 1, switched on (Track 1)

**Sources (binding):**
- The owner's decision on screening capture-derived text, `docs/builder-packet/INPUT-2026-10-31-CAPTURE-SCREENING-DECISION.md`, as recorded in the Decision Service ADR §2.1 (`docs/plans/decision-service.md`).
- The owner's newer decision, **option B** (PR #269, ADR §2.1): on a device with no trusted model, captured text is held, not kept, after the deterministic rules.
- The template, `capture-sensitive` v1 (#264, `src/core/decision-service/templates/capture-sensitive.ts`). Its plan, `docs/plans/ds2-capture-sensitive.md`, has the "NOTES for Track 1" this plan follows.
- The independent review of #271 at `2063c4d8`: nine should-fix findings and some minor ones. See "The review" below, and the evidence page `docs/evidence/capture-screening-review.md`.

**Track:** Track 1. It owns the consumers: capture's intake, the screening pass, the holding area, the timeline, the migration and these records. The template's questions, fields, state and rule are unchanged, so its eval verdict stands. Three things in its file changed for the review:
- its sensitive-app list;
- its no-answer default, from index to hold (option B);
- its header comment.

None of the three is part of the wording a verdict is tied to (`registry.wordingOf`).

## What happens to a captured event now

1. **Nova's own rules, at intake, with no model call** (`Capture.ingest`):
   - **A known sensitive app or site is dropped like a private window.** It is counted as `sensitive_app` and never stored.
     - **What counts:** a password manager, a banking or payment app, a password manager's web vault, or a bank's site.
     - **How it's recognised:** by the app's name (normalised, so bundle ids, `.exe` and look-alike characters are read too), by the address (the vault hosts and major banks by registrable domain), or by a window title whose first or last part is a password manager's name.
     - **One list:** it is the template's own `sensitiveApp`, exported from the service's `index.ts`, so capture and the template can't drift.
     - **Best effort**, and the person's own exclusions come first.
     - **Wrongly dropped:** the person can let an app or site back in, for one source or for all, in Settings › Capture. It is the `allow` setting, checked like the exclusions and at the same tier.
   - **The pattern rules** (`findSecrets`: keys, tokens, private keys, passwords, Luhn-valid cards, mod-97 IBANs, SSNs, high-entropy secrets) run on the words, the window title and the address. Each field is redacted whole and only then cut to its length, so a secret across the cut is never half-kept. Only the kinds are kept.
   - The event is stored as `unscreened`: held until it's checked.
2. **Then the check** (`Capture.screen`, in every capture tick between the pull and triage, and on `POST /capture/screen`; one pass at a time):
   - **Nova's rules again first,** over all three fields of every event the pass takes, old rows included. What they find is redacted and saved before any model is asked, so a row the model can't check still keeps no detected secret in clear.
   - **What the model reads:** `capture-sensitive` reads the window title and the address with the words, under plain labels inside its `text` field. Its fields are unchanged, so its verdict stands. A row too long for one check with them is checked twice: the title and address, then the words.
   - **The cache:** the same words (spacing evened out) from the same source and app within a day reuse the earlier trusted decision. The key is an HMAC with this home's own key (kept in the vault) of the source, the app, the address and the words. It never crosses sources, and it can't be confirmed by guessing a short text.
   - **The outcome is applied:**

   | Outcome | What happens | May it be triaged or remembered? |
   |---|---|---|
   | **index** | stays as stored | yes |
   | **redact** | the redacted fields stay | yes, redacted |
   | **hold** | kept only until retention deletes it | no |
   | **exclude** | the words, title and address are cleared and scrubbed; the row stays (time, app, source) | no |

   - Redact also applies when Nova's rules redacted something and the model said all no: the stricter wins.
   - A finding that only shows up across two fields can't be placed, so the item is excluded: the stricter course.
   - **Scrubbing** is done once per pass, the way a forget does it: a write-ahead-log checkpoint, then every backup cleaned of the rows.
   - **Stream readers and event rules** hear about an event once it is checked (index, redact, hold or exclude), never before. A held event is heard about when it is released.
3. **With no trusted answer** (option B): the event is **held**, unless Nova's own rules excluded it.
   - **What "no trusted answer" means:** no seat with a passing verdict for `capture-sensitive` v1 on its exact model answered. That covers no Tev1, Tev1 off, an Ollama too old, or a size or build that didn't pass.
   - **The record:** the template's default is now `hold`, so the decision record says hold, not index.
   - **Two kinds of held:**
     - **Nothing trusted can check it here:** it waits, isn't asked again on each pass, and is checked once a trusted model can answer.
     - **A trusted model is set up but didn't answer for it:** for example, the request was too large, or a build swapped under the same tag. It is tried again after 10 minutes, then doubling up to a day, at most 5 times. After that it stays held until retention.
   - **No starving:** each pass takes the events with the fewest tries first, so failures never starve newer events.
   - **Retention** deletes held events like any capture.
   - **No evidence-only asks:** an untrusted seat is never asked for evidence on captured text.
   - **No words:** an event with no words, title or address has nothing for a model to read, so it is indexed with no model check. A sensitive app still excludes it.

**Promotion is gated in one place** (`#rememberable`): `promote` and `accept` refuse an event that isn't `index` or `redact` (409), in words. Triage (`propose`, one pass at a time) reads only those, and the proposals list and count show only those. A suggestion made before an event was held isn't deleted; it shows again once the event is released. **The owner's open question** is whether the person may keep a held item. The strict default stays: they may not. An override at tier 2, shown with the item's words, would be added in `#rememberable`.

**Memories made before the check** (an older Nova promoted an event that a later check finds holds a secret, or holds or excludes):
- They are listed for the person in the Capture view under "Memories to look at again" (`GET /capture/memory-review`), with the reason and the memory shown redacted, never with a value.
- The person can forget the memory, or keep it as it is (`POST /capture/memory-review/{id}/keep`).
- Nova doesn't rewrite a memory itself: a correction keeps the old record in its history, and forgetting the chain would take the event with it.

## The holding area and the timeline

- **`GET /capture/holding`** and `status().screening`: `held` (waiting for a trusted model), `failing` (a trusted model didn't answer), `unscreened`, `trusted`, the notice, and what stands in the way.
- **The owner's notice, word for word,** shows only when it is true, that is, when events are held and nothing trusted can check them here: "This device can’t check captured text for private details yet, so it’s being held, not kept. Add the Tev1 4B model to fix that." One plain line about this device follows it. For example:
  - Tev1 switched off;
  - Ollama unreachable or too old;
  - Tev1 not downloaded;
  - "This build of Tev1 4B hasn’t passed the check for captured text";
  - "tev1:0.8b is installed, but it didn’t pass the check for captured text; Tev1 4B did".
- **The Capture view:**
  - **The "Held until checked" card:** the count, said plainly: "not added to memory or suggested. Their words are kept on your devices like the rest of capture, and deleted with it after N days, checked or not." Then the notice when it is true, what stands in the way, a line for items a trusted model couldn't check, and a link to Settings › Models.
  - **The "Memories to look at again" card,** when any are listed.
  - **Each event's label,** in Nova's own words, never a model's:
    - "Held until it’s checked" (unscreened) and "Held: not checked yet" (held). A held item's reason is on the card above, unless it is a failure, which shows its own.
    - "Redacted: a card number and a cloud access key" (the label names what).
    - "Sensitive: held, not added to memory", with the reason "Nova’s check found a person’s health details in it. It is kept only until capture retention deletes it." When the model wasn't sure: "Nova’s check wasn’t sure it’s free of private details. …"
    - "Sensitive: excluded, text not kept", with the reason "Nova’s check found a password in it, so its words weren’t kept."
  - **Behind a tap:** a held or sensitive item's window title and address are behind "Show what was captured", with its words, not in the line above. An excluded item has none.
  - **How this was checked:** every item opens to this. It shows the template and version, what Nova's rules redacted and where, the seat and pinned model that answered (or that none trusted did), the scores, the decision id and time, and the capture source.
  - **Buttons:** Remember shows only on index and redact. Forget is always there.
- **Settings › Capture:**
  - **The counts:** each source's counts say "N from a password manager or bank" beside the other drops that were never stored.
  - **"Never captured":** names password managers and banking apps and sites, "recognised by their names and addresses: also a best effort".
  - **What happens before text is kept,** worded to the evidence: shapes are blanked out in the words, the title and the address; then "a model on this computer or your own network" checks the rest (the Tev1 seat takes only a local or private address). Until a model trusted for that has checked it, captured text is "held: kept on your devices like the rest of capture, not added to memory".
  - **"Let back in":** the allow-back list and form.

## Provenance on each event

`capture_event.sensitivity_detail` (JSON) holds:
- the template and version;
- the capture source;
- Nova's rules: the kinds redacted and the fields they were in;
- the decision: its id, outcome, seat, pinned model, trust, quality, the four scores, their bands, findings (kinds only) and the time. It is marked `cached` when it was reused from an earlier decision;
- `records`: every decision record made about the event;
- `memory_review`, when it applies.

`sensitivity_decision` is the latest `decision_record` id. That record, which isn't replicated, holds the rest: privacy mode, egress, failures, field names and the verdict reference.
- **The state hash:** for capture text (the capture template, or capture-derived text in another template), the record's state hash is an HMAC with this home's key (`hmac:<hex>`), or `withheld` when there is no key. Never a plain hash.
- **No record outlives its item:** a forget or retention sweep deletes all of an event's records and any cached decision they made. Retention also prunes the `capture` subsystem's older records and the cache.

## The migration

**`0022_capture_sensitivity.sql`.** The orb PR (#263) keeps 0021 and merges first; this one is renumbered on the merge after it.

It adds these columns to `capture_event`:
- `sensitivity` (`unscreened | held | index | redact | hold | exclude`, default `unscreened`);
- `sensitivity_why`, `sensitivity_decision`, `sensitivity_detail`, `sensitivity_at`;
- `sensitivity_tries` and `sensitivity_next`, for backing off.

It also adds:
- an index on `(sensitivity, at)`;
- the `capture_screen_cache` table, which isn't replicated: a standby that becomes hub checks again;
- a unique index on `capture_proposal (event_id) WHERE state = 'proposed'`, after removing any older duplicates.

What else changes:
- **Older rows** become `unscreened`, so the next pass checks them, rules first.
- **Replication:** `capture_event`'s insert and update triggers are made again with the seven columns, which are registered in `ADDED_COLUMNS[22]`. The sync-skew test covers them.

## Routing

- **Unchanged, and enforced by `DecisionService.cloudAllowed`:** capture text never goes to a cloud seat in local-first or local-only, and in cloud mode only with that source's own opt-in.
- **The opt-in isn't built:** the core passes no `captureCloud`, so it is always off.
- **The test** sets Jev up with its key and the screening opt-in on, and even gives it a passing verdict for `capture-sensitive`. In all three modes, nothing captured reaches Jev, no remote receipt is written, and the record says why.

## The review (2063c4d8)

Each finding got a failing test first, in `tests/core/capture-screening-review.test.ts` (12 tests; the test commit is `25455763`). The fixes followed. Then, with `src/` and `ui/` restored to the test commit, all 12 fail again. The per-item results are in `docs/evidence/capture-screening-review.md`.

| # | Finding | Reproduced | Fix | Test |
|---|---|---|---|---|
| 1 | An at-cap old row is never redacted | yes (capOverflow) | Nova's rules on every field before every check, redact then cut | review 1 |
| 2 | Title and address are neither judged nor cleared | yes (titleNotScreened) | the check reads them; exclude clears all three; the title is behind the tap | review 2; UI |
| 3 | Title and address are cut before they're scrubbed | yes (titleCut) | scrub whole, then cut | review 3 |
| 4 | The sensitive-app list | yes (p1) | vaults, banks by domain, apps and bundle ids, titles, precise matching; allow-back | review 4 (×2); UI |
| 5 | Old memories aren't rechecked | yes (oldMemory) | "Memories to look at again" | review 5; UI |
| 6 | Head-of-line blocking; the notice is wrong | yes (headOfLine) | fewest tries first, backoff, a limit of 5; the notice only when true | review 6 |
| 7 | Ticks overlap | yes (ticks) | single-flight tick and triage; a unique open-proposal index | review 7 |
| 8 | No cache; records not pruned; a plain hash | yes | HMAC cache per source; records forgotten and swept; HMAC state hash | review 8 (×2) |
| 9 | The migration number | – | 0022, after the orb's 0021 | sync-skew |
| minor | Stream and rules fired before the check | yes (stream) | fired after the check | minor 1 |
| minor | A held record says index | yes | template default hold; header fixed | minor 2 |
| minor | UI wording | – | "Held until checked"; "checked or not"; "on this computer or your own network"; "Held: not checked yet" | UI |
| minor | Suggestions lost when an event is held | – | no longer deleted; shown again on release | – |
| minor | Verdict files re-read on every call | – | cached until a file's time or size changes | – |

## Tests (stand-ins only in CI)

**`tests/core/capture-screening.test.ts`** (10 tests), end to end through capture's intake (a Screenpipe pull and a device's inbox), with the Tev1 stand-in (`tests/support/capture-check.ts`):
- sensitive apps dropped at intake;
- every outcome, including an exclude clearing all three fields;
- canaries never reach the model, memory or the archive in clear;
- old rows redacted in place by Nova's rules before their check;
- provenance;
- option B, both with an untrusted Tev1 and with no Tev1;
- release once trusted;
- retention;
- no cloud seat in any mode;
- a tick screens before triage.

**`tests/core/capture-screening-review.test.ts`** (12 tests): one per review finding, as in the table.

**`tests/core/capture-sensitive.test.ts`:** the template with no trusted answer now holds; its pattern still redacts.

**`tests/core/sync-skew.test.ts`:** `capture_event` is registered. A standby a release behind gets capture events without the seven columns, and a current standby gets them.

**`tests/ui/capture-screening.test.ts`** (the UI gate, Chromium, real server):
- **With a trusted check:**
  - the four verdicts in the timeline;
  - a held item's title and words behind the tap;
  - an excluded item with no words;
  - "How this was checked";
  - the memory review card, redacted, then kept;
  - "Let back in" in Settings › Capture.
- **With no model (option B):**
  - the "Held until checked" card with the owner's notice word for word, and the honest count line;
  - every item held, with no Remember and no title in its line;
  - no sideways scrolling at 1280 and 375 px.

**Existing tests that remember captured events** now run with a trusted stand-in check. In process that's the Tev1 stand-in; for a real server it's `fake-ollama.js`'s optional `/v1/systemone`, at the passed build's digest.

**A real `tev1:4b` smoke check** (opt-in, local, not CI; 2026-10-31): the real core, its committed verdicts, and the local Ollama 0.40.13 with `tev1:4b@7954dce2…`. Nothing was pulled or changed. Six synthetic items were checked in 1.5 s:
- the plan and the recipe were indexed;
- the health and finance notes were held;
- the wifi password and the test card were redacted by the rules at intake, then held as unsure.

That run was before the review changes (title and address in the state). It shows the wiring works; it isn't an eval.

## Limits

- **Nobody can override a hold.** Promotion is refused for held events, even by the person, which is the strict reading of option B. An override is the owner's call; the code has one place for it.
- **The wait for a check:** events wait up to one capture tick (10 s by default) before they are checked.
- **The device's own queue** (`src/device/queue.ts`) holds a device agent's capture in clear until it reaches the hub's intake.
- **What the eval measured:** the check now reads the title and the address inside its `text`. The eval measured words alone, so how well it judges titles and addresses is unmeasured. The verdict still applies, since it is tied to the template's wording, which is unchanged.
- **Old memories are listed, not rewritten.** A memory made from an event before the check keeps its words until the person forgets it.
- **Standby backups:** backups a standby made before the hub redacted or excluded an event still hold the old words, until that backup rotates out. A forget reaches them; a redaction doesn't.
- **An older standby promoted to hub** (one without this migration) would triage held events. A standby a release behind is #272's concern; this is only noted here.
- **Recall-path screening (job 2)** is a separate job.
- **Speed:** a pass checks 20 events, one or two decisions each. A long backlog takes several ticks to release once a model is trusted.
- **Scrubbing removes the whole row from backups,** as a forget does, not only its old words.
- **The list's known gaps:** a sign-in app such as BankID, and apps it doesn't name. It is a best effort.

## Records

- `docs/LEDGER.md` `## Decisions`: the entry for this change, and the review.
- `docs/builder-packet/CAPABILITY-INVENTORY.md`: the Decision Service and Capture rows.
- `docs/evidence/capture-screening-review.md`: the review's per-item results.

## The plain-language entry (for the coordinator)

> **Captured text is checked for private details before Nova keeps it**
> - What changed: before anything captured from your screen or a recording is kept, Nova's own rules run first. Password managers, banking and payment apps, password vaults and banks' websites are never kept. Anything shaped like a key, a password or a card number is blanked out, in the words, the window's title and the web address, before it's saved. Then a small model on this computer or your own network checks the rest for passwords, keys, and someone's money or health details. Anything it flags is held back from memory, or its words aren't kept, and the Capture page says which and why. Nothing is deleted without showing you. Until a model Nova trusts for this has checked something, it's held: kept with the rest of your capture but not added to memory. If no such model is on this computer, the Capture page says so and what fixes it ("Add the Tev1 4B model").
> - What you can now do: open any captured item to see how it was checked. Remember what was checked; forget anything. If Nova wrongly kept out an app (a sports app called "Keeper", say), let it back in from Settings › Capture. If you remembered something from capture before this check existed and it turns out to hold a password or a private detail, the Capture page lists it for you to forget or keep.
> - Still unfinished: what's held can't be remembered, even by you, until it's checked. Whether you should be able to override that is your call. A per-source switch that would let cloud mode send captured text to the cloud for checking isn't built, so captured text is only ever checked on your own devices. Checking what Nova recalls from capture before a model reads it is the next job.
