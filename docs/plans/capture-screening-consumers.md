# Plan: capture screening, job 1, switched on (Track 1)

**Sources (binding):**
- The owner's decision on screening capture-derived text, `docs/builder-packet/INPUT-2026-10-31-CAPTURE-SCREENING-DECISION.md`, as recorded in the Decision Service ADR §2.1 (`docs/plans/decision-service.md`).
- The owner's newer decision, **option B** (PR #269, ADR §2.1): on a device with no trusted model, captured text is held, not kept, after the deterministic rules.
- The template, `capture-sensitive` v1 (#264, `src/core/decision-service/templates/capture-sensitive.ts`). Its plan, `docs/plans/ds2-capture-sensitive.md`, has the "NOTES for Track 1" this plan follows.

**Track:** Track 1. It owns the consumers: capture's intake, the screening pass, the holding area, the timeline, the migration and these records. The template, its eval and its verdicts are unchanged.

## What happens to a captured event now

1. **Nova's own rules, at intake, with no model call** (`Capture.ingest`):
   - **A known sensitive app or site** (a password manager, a banking app or site) is dropped like a private window. It is counted as `sensitive_app` and never stored. It uses the template's own `sensitiveApp`, exported from the service's `index.ts`, so the two lists can't drift.
   - The person's own exclusions come first, as the template says.
   - **The pattern rules** (`findSecrets`: keys, tokens, private keys, passwords, Luhn-valid cards, mod-97 IBANs, SSNs, high-entropy secrets) run on the text, the window title and the address. Whatever they find is redacted before the row is written, and before the text is cut to its length, so a secret is never cut in half and missed. Only the kinds are kept.
   - The event is stored as `unscreened`: held until it's checked.
2. **Then the model** (`Capture.screen`, in every capture tick between the pull and triage, and on `POST /capture/screen`): `capture-sensitive` is asked of the Decision Service with `subsystem: 'capture'`, the capture source, and `shadow: false`. The service runs the template's rules again (a second wall, for events stored before this) and routes the rest. Its outcome is applied:

   | Outcome | What happens | May it be triaged or remembered? |
   |---|---|---|
   | **index** | stays as stored | yes |
   | **redact** | the redacted text stays; any finding in old stored text is redacted in place and scrubbed | yes, redacted |
   | **hold** | kept only until retention deletes it | no |
   | **exclude** | the text is cleared and scrubbed; the row stays (time, app, source) | no |

   - Redact also applies when Nova's intake rules redacted something and the model said all no: the stricter outcome wins.
   - Scrubbing is as a forget does it: a write-ahead-log checkpoint, and every backup cleaned of the row.
3. **With no trusted answer** (option B): the event is **held**, unless Nova's own rules excluded it. "No trusted answer" means no seat with a passing verdict for `capture-sensitive` v1 on its exact model answered. That covers no Tev1, Tev1 off, an Ollama too old, or a size or build that didn't pass.
   - **Where it waits:** in the holding area. It is never triaged, proposed or remembered, and it isn't asked again on each pass.
   - **When it's released:** once `screening()` says a trusted model can answer on this device, the next pass checks held events too, oldest first, 20 a pass.
   - **When it expires:** retention deletes it like any capture.
   - **No evidence-only asks:** an untrusted seat is never asked for evidence on captured text.

**Promotion is gated:** `promote` and `accept` refuse an event that isn't `index` or `redact` (409), in words. Triage (`propose`) reads only those, and the proposals list and count show only those. A person can't remember a held event either. That follows from the owner's option B, which the DS2 plan put as "it switches capture indexing off for now".

## The holding area and the timeline

- **`GET /capture/holding`** and `status().screening`: how many events are held and unscreened, whether a trusted model can check now, the notice, and what stands in the way.
- **The notice is the owner's, word for word:** "This device can’t check captured text for private details yet, so it’s being held, not kept. Add the Tev1 4B model to fix that."
  - Each held event's reason is the notice plus one plain line about this device. For example: Tev1 switched off; Ollama unreachable or too old; Tev1 not downloaded; "This build of Tev1 4B hasn’t passed the check for captured text"; "tev1:0.8b is installed, but it didn’t pass the check for captured text; Tev1 4B did".
- **The Capture view:**
  - **A "Held, not kept" card** with the count, the notice, that line, and a link to Settings › Models.
  - **Each event's label,** in Nova's own words, never a model's:
    - "Held until it’s checked" (unscreened) and "Held, not kept: not checked yet" (held). Their reason is the holding card's notice, so it isn't repeated on each item.
    - "Redacted: a card number and a cloud access key" (the label names what was redacted).
    - "Sensitive: held, not added to memory", with the reason "Nova’s check found a person’s health details in it. It is kept only until capture retention deletes it." When the model wasn't sure: "Nova’s check wasn’t sure it’s free of private details. …"
    - "Sensitive: excluded, text not kept", with the reason "Nova’s check found a password in it, so its words weren’t kept."
  - **The words behind a tap:** a held event's words are behind "Show what was captured". An excluded event has none.
  - **How it was checked:** every item opens to "How this was checked": the template and version, what Nova's rules redacted and where, the seat and pinned model that answered (or that none trusted did), the scores, the decision id and time, and the capture source.
  - **Remember** shows only on index and redact. **Forget** is always there.
- **Settings › Capture:**
  - The source's counts say "N from a password manager or bank" with the other drops that were never stored.
  - "Never captured" names password managers and banking apps and sites ("also a best effort").
  - One sentence says what happens before captured text is kept, worded to the evidence: shapes blanked out; a model on this device checks the rest; held until a model this device trusts has checked it.

## Provenance on each event

`capture_event.sensitivity_detail` (JSON) holds:
- the template and version;
- the capture source;
- Nova's intake rules: the kinds redacted and the fields they were in;
- the decision: its id, outcome, seat, pinned model, trust, quality, the four scores, their bands, the template's own findings (kinds only) and the time.

`sensitivity_decision` is the `decision_record` id. That record, which isn't replicated, holds the rest: privacy mode, egress, failures (why no seat answered), the state's hash and the verdict reference. No value a rule caught is ever stored.

## The migration

**`0022_capture_sensitivity.sql`** (the next free number when this merged: M10f's 0020 and the orb's 0021 came first). It adds `capture_event.sensitivity` (`unscreened | held | index | redact | hold | exclude`, default `unscreened`), `sensitivity_why`, `sensitivity_decision`, `sensitivity_detail`, `sensitivity_at`, and an index on `(sensitivity, at)`.
- **Older rows** become `unscreened`, so the next pass checks them, rules first.
- **Replication:**
  - `capture_event` replicates, so its insert and update triggers are made again with the new columns.
  - The five columns are registered in `ADDED_COLUMNS[22]` (`mesh/sync.ts`, M10f's mechanism), so a hub leaves them out for a standby a release behind.
  - `capture_event` is in the sync-skew test's table list.

## Routing

- **Unchanged and enforced by `DecisionService.cloudAllowed`:** capture text never goes to a cloud seat in local-first or local-only, and in cloud mode only with that source's own opt-in.
- **The opt-in isn't built:** the core passes no `captureCloud`, so it is always off.
- **The test** sets Jev up with its key and the screening opt-in on, and even gives it a passing verdict for `capture-sensitive`. In all three modes, nothing captured reaches Jev, no remote receipt is written, and the record says why.

## Tests (stand-ins only in CI)

**`tests/core/capture-screening.test.ts`**, end to end through capture's intake (a Screenpipe pull and a device's inbox), with the Tev1 stand-in (`tests/support/capture-check.ts`):
- **Sensitive apps dropped at intake:** 1Password, Bitwarden, a bank app, a banking site, and KeePassXC through the inbox. They are counted, nowhere under the home, and never asked of a model.
- **Every outcome,** in one run: index, redact, hold, exclude, and unsure holds. Each carries its reason. Only index and redact can be promoted, and the rest get a 409 in words. Triage never reads a held one. All five stay in the timeline.
- **Canary secrets never reach memory, the archive, its write-ahead log or the model in clear:** an AWS-shaped key, a GitHub-shaped token, a test card, and a password in a connection string, across the text, the title and the address.
- **An event stored before the rules** is redacted in place by the template's own rules, and scrubbed.
- **Provenance:** template v1, `tev1` and `tev1:4b@aaaa4b`, trust `verdict`, four scores and bands, the capture source, and the decision record (`subsystem: capture`, egress local).
- **Option B,** twice (a Tev1 that isn't trusted, and no Tev1 at all):
  - every event is held with the notice;
  - the card is still redacted;
  - `/capture/holding` reports the held events and the notice;
  - no evidence-only ask is made;
  - no re-ask while nothing is trusted;
  - nothing is triaged or remembered.
- **Release once trusted:** held events are decided on the next pass (index and hold), and the index one can then be remembered.
- **Retention:** a held event is swept with the rest of capture.
- **No cloud seat in local modes,** or in cloud mode without the opt-in.
- **A capture tick screens** before triage.

**`tests/ui/capture-screening.test.ts`** (the UI gate, Chromium, real server):
- **With a trusted check:** the four verdicts in the timeline, each label and reason; the held words behind a tap; no Remember on held or excluded items; no card number on the page; "How this was checked" with `capture-sensitive v1`, `tev1:4b@7954dce2…`, the scores and the source.
- **With no model (option B):** the holding card with the owner's notice word for word and the Settings › Models link; every item held with no Remember; no sideways scrolling at 1280 and 375 px.

**Existing tests that remember captured events** (`capture.test.ts`, `capture-review.test.ts`, `models.test.ts`, `ingest/core.test.ts`, the M6a and M6 day gates, the M6a UI test) now run with a trusted stand-in check:
- In process, the Tev1 stand-in plus a verdict store.
- For a real server, the Tev1 stand-in, or `fake-ollama.js`'s new optional `/v1/systemone`, listing tev1:4b at the build that passed. The server's committed verdicts trust it.

**A real `tev1:4b` run** is opt-in only and wasn't needed here: the template's own eval run (`NOVA_REAL_CAPTURE_SENSITIVE=1`) is unchanged.

## Limits

- **Promotion is refused for held events, even by the person.** That is the strict reading of option B ("held, not kept"). Whether a person may remember a held event deliberately, after a warning, is the owner's call.
- **Pull to check:** events wait up to one capture tick (10 s by default) between being taken in and being checked. Until then they are `unscreened`, which counts as held.
- **The device's own queue** (`src/device/queue.ts`) holds a device agent's capture in clear until it reaches the hub's intake, where the rules run.
- **`capture.stream`** subscribers (none in Nova today) get events at intake, before the model's check. The event carries its `sensitivity`, so a reader must honour it.
- **No content-hash cache:** the same text from the same source is checked again.
- **Recall-path screening (job 2)** is a separate job, not part of this one.
- **The pass's speed:** 20 events a pass, one decision each. A long backlog of held events takes several ticks to release once a model is trusted.
- **Scrubbing removes the whole row from backups** (as a forget does), not only its old words.

## Records

- `docs/LEDGER.md` `## Decisions`: the entry for this change.
- `docs/builder-packet/CAPABILITY-INVENTORY.md`: the Decision Service and Capture rows.

## The plain-language entry (for the coordinator)

> **Captured text is checked for private details before Nova keeps it**
> - What changed: before anything captured from your screen or a recording is kept, Nova's own rules run first. Password managers and banking apps and sites are never kept, and anything shaped like a key, a password or a card number is blanked out before it's saved. Then a small model on this computer checks the rest for passwords, keys, and someone's money or health details. Anything it flags is held back from memory, or its words aren't kept, and the Capture page says which and why. Nothing is deleted without showing you. On a computer without a model Nova trusts for this, captured text is held, not kept: the Capture page says so, and says what fixes it ("Add the Tev1 4B model").
> - What you can now do: open any captured item to see how it was checked. Remember what was checked; forget anything.
> - Still unfinished: what's held can't be remembered, even by you, until it's checked. Whether you should be able to override that is your call. A per-source switch that would let cloud mode send captured text to the cloud for checking isn't built, so captured text is only ever checked on your own machine. Checking what Nova recalls from capture before a model reads it is the next job.
