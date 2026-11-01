# Evidence: capture screening, job 1, the review of #271

**What was reviewed:** #271 at `2063c4d8`, by an independent reviewer.
**The plan:** `docs/plans/capture-screening-consumers.md`, "The review".
**The probes:** the reviewer's `p1-rules.ts` (the list and the patterns), `p2-core.ts` (the real core, nine scenarios, stand-ins on loopback only) and `p3-pieces.ts`, kept outside the repo.

**The method:**
1. One failing test per finding, in `tests/core/capture-screening-review.test.ts`, committed on its own (`25455763`).
2. Then the fixes.
3. Then `src/` and `ui/` were restored to the test commit, and the same tests were run against them ("reverted").

| Test | Before the fixes | After | Reverted |
|---|---|---|---|
| review 1: an at-cap old row is redacted in place, trusted or not | fail: "the key isn't kept in clear" | pass | fail |
| review 2: title and address judged; an exclude clears them | fail: "a password in the title excludes" | pass | fail |
| review 3: title and address scrubbed before the cut | fail: "no part of the token is stored" | pass | fail |
| review 4: the list (vaults, banks, apps, bundle ids, titles, no false positives) | fail: vault.bitwarden.com not recognised | pass | fail |
| review 4: allow-back per source | fail: `allow` not a setting | pass | fail |
| review 5: a memory made before the check is listed | fail: nothing listed | pass | fail |
| review 6: no starving, backoff with a limit, a true notice | fail: "a newer event isn't starved" | pass | fail |
| review 7: one tick at a time; one proposal per event | fail: triage ran more than once | pass | fail |
| review 8: the content-hash cache, per source | fail: asked twice for the same words | pass | fail |
| review 8: records go with their event; a keyed state hash | fail: "keyed per home" | pass | fail |
| minor: stream and rules after the check | fail: "nothing before the check" | pass | fail |
| minor: a held record says hold | fail: the record said index | pass | fail |

**Totals:** 12 of 12 failed before the fixes, 12 of 12 pass after, and 12 of 12 fail with the fixes reverted.

One test changed after the test commit. Review 6 counted the stand-in's requests, but the stand-in counts only the requests it accepts. It now counts decision records instead (one per ask). The behaviour it checks didn't change.

## The reviewer's probes, after the fixes

- **titleCut:** the title's token is stored as `[redacted: access t…`, cut after the redaction, and no part of the token is on disk. The address the same way.
- **titleNotScreened:**
  - the password in the title and address excludes the item, and its text, title and address are all null; the canary is on no file;
  - health details in the title hold the item;
  - the model's state shows "Window title: … Address: …".
- **stream:** the subscriber sees one event, already `exclude`, with no words.
- **swap:**
  - the build changes under the same tag, so the pin refuses the answer; the item is held as a failure and tried again later;
  - after the seat refreshes, nothing trusted can check: `holding` shows it as held, with the owner's notice and "This build of Tev1 4B hasn't passed the check for captured text".
- **race:** an item forgotten mid-check is skipped; the other is held when trust is lost mid-pass.
- **headOfLine:**
  - pass 0 holds the 20 that fail;
  - pass 1 indexes the short one, so it isn't starved;
  - passes 2 and 3 ask nothing, because the failures are backing off;
  - the reason says a trusted model is set up but didn't answer, not "add the Tev1 4B model".
- **ticks:** four overlapping ticks run triage once and leave one proposal.
- **oldMemory:**
  - the event is redacted in place and the memory is listed for review;
  - the memory itself still holds the key until the person acts: by design, a listing, not a rewrite (see the plan's limits).
- **capOverflow:**
  - untrusted: held, the key isn't in clear, and it is on no file;
  - trusted: redact, within the cap, and on no file.
- **firstRun:** the first pass indexes once the seat is probed.
- **p1:** every listed vault, bank, app and bundle id is recognised. `databank.org`, "Keeper Standings" and "Riverbank Notes" aren't. The patterns take 1 to 24 ms on a million characters of adversarial text.

## Checks

The `npm run check` and `scripts/ui-test.sh` results and CI are in the PR's comments for the head that carries this page.
