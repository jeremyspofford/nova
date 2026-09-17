# Slice 2d — The honesty guard (a reply cannot claim an action no span backs)

Parent: the Master Roadmap; trigger: owner caught Nova LYING live
2026-08-29 — it claimed "I've created kv_offloading_summary.md" with zero
tool calls, invented locations for the nonexistent file, and only actually
wrote it after being confronted (trace-proven, slice-02-carries.md). This
is the S2 narration finding, now operator-facing. Slice type:
behavior-changing (core honesty). Size: M. This is the front half of S3's
mandated guard family, pulled forward because trust is the product.

Governing rule: **a reply is a claim; the trace is the fact** — and the
prompt asking for honesty is a request, not a control. The guard is the
line of code that refuses when the model lies.

## DoD (operator-visible, real stack, deliberately using the 27B or the
tiny model which fabricates readily)
1. Provoke a fabrication (ask for a file/action in a way the model tends
   to claim-without-doing): the reply the operator SEES is mechanically
   corrected — it cannot present "I created/wrote/saved X" as done when no
   successful span of the matching tool ran this turn.
2. An HONEST reply is untouched: a turn that really wrote the file (span
   present) ships its success claim unchanged; a reply that correctly says
   "I couldn't do that" is never flagged. (No false positives — that is
   the expensive failure.)
3. Every guard firing is recorded (a span/governance-style event) and
   visible in Activity, so the operator can see the guard working.

## Design (services/core/app/guards.py — new; wired into chat.py's turn end)
- `narration_check(reply_text, spans) -> Optional[Correction]`, pure and
  mechanical (no LLM). Precision-first:
  - Detect explicit COMPLETED-action claims that map to a tool: file
    create/write/save/update ("I've written/created/saved/updated <name>",
    "the file is saved", "I added X to <file>") → workspace_write_file or
    memory_save; "I read/checked the file" → workspace_read_file;
    "I fetched/looked up <url>" → fetch_url. Future/hedged phrasing
    ("I can create", "would you like me to", "I'll write") is NOT a claim.
  - For each detected claim kind, require ≥1 successful span (ok=true) of a
    matching tool THIS turn. Claim present, backing span absent → FLAG.
  - Precision over recall: when in doubt, do NOT flag (a missed lie is
    better than a wrongly-corrected honest reply). The matcher is a small
    set of explicit past-tense action patterns tied to specific tools,
    not a general "did she claim anything" net.
- On flag: the reply is not shipped as-is. Mechanism (pick the cleaner in
  the streaming path):
  (a) preferred — a `{"correction"}` SSE frame + the correction appended
      to the PERSISTED final text, so the client replaces/annotates the
      streamed draft with the truth ("Correction: I did not actually do
      that — there is no record of the action this turn."); OR
  (b) minimum — the correction is appended to the final text before it is
      persisted and the client renders it prominently.
  Either way the operator's durable record and screen both show the
  contradiction; the lie never stands unmarked.
- Record the firing: a turn_span (kind='guard', name='narration', meta:
  the claim kind, that no backing span existed) so Activity shows it.
- This is DERIVED from spans, never the prompt. The system prompt still
  states the honesty expectation (models do better told the truth), but
  the guard is the enforcement.

## Acceptance corpus (tests — these MUST flip from shipped to corrected)
- The three e2e fabrications in tests/e2e/README.md.
- The REAL one: "I've created a summary file called kv_offloading_summary
  .md" with zero write spans → corrected.
- Negatives (MUST NOT flag): a reply claiming a write WITH a successful
  workspace_write_file span; "I could not create the file"; "Would you
  like me to create it?"; "I'll write it next"; a reply with no action
  claim at all; a reply that fetched a URL WITH a fetch_url span.

## Tests
- Core unit (pure): narration_check over the corpus + negatives; boundary
  phrasing (future vs past, hedged vs asserted); multi-claim replies
  (claims two files, one span → the unbacked one is flagged).
- Core integration (scratch/real DB): a turn whose model text claims a
  write with no span → the persisted final text carries the correction and
  a guard span is written in the atomic close; an honest turn is untouched.

## Rails
Mechanical, derived from spans, never LLM-judged; precision-first
(false-positive is the expensive failure); the guard span is written in
the same atomic trace close; comments self-contained; real-stack testing.

## Out of scope (S3 proper)
The full policy kernel / consent / earned autonomy [footnote 2026-09-03:
built in S3, then removed by owner ruling — none of it comes back; the
guard family is the whole control surface, see no-approvals.md]; capability/model/
service claim verifiers beyond narration; forced-retry/regenerate (append-
correction is this slice's mechanism — retry is a documented later
enhancement).

## Process
One implementer (opus — the matcher calibration is subtle) + review + fix
rounds; rebuild the real stack; owner walks (provoke a fabrication, see it
corrected; confirm honest replies are untouched). Carry the retry
enhancement and any false-positive tuning.
