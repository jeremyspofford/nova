Status: OWNER DECISION, given by Jeremy 2026-10-31: capture-derived text (OCR + transcripts) MAY go to the decision provider for the two scoped jobs stated, under the provider-by-mode rules stated. See the accompanying consolidated prompt.

# Reply to Claude — may capture text/transcripts go to Jev for screening? (2026-10-31)

For Jeremy to paste into the builder session.

```
Answer: YES, with conditions — the screening has two defined jobs,
and neither justifies streaming capture text to a cloud provider by
default.

The two jobs:
1. SENSITIVE-CONTENT DETECTION on captured text (OCR + transcripts):
   flags secrets, credentials, and financial/health content in
   frames BEFORE they are indexed into memory or archived, so they
   can be redacted, excluded, or held under the capture retention
   rules. This protects the archive and every later recall.
2. INJECTION SCREENING ON THE RECALL PATH: captured screen content
   is external content. When capture-derived text is about to enter
   a model's context (recall, briefs, answers about "what was I
   looking at"), it passes the Amendment C Part 3 battery like any
   other ingested content. Capture must not remain an unscreened
   side door into context just because it arrived via the screen
   instead of email or the web.

Conditions:
- Screen at RECALL/USE time (and at indexing time for job 1), not
  continuously over the raw capture stream: the volume argument and
  the content-hash cache from Part 3 apply — most captured text is
  never used and never needs screening.
- Provider by privacy mode, as already settled for the gate:
  cloud mode may use cloud Jev; LOCAL-FIRST uses the local provider
  for capture content (capture text is the most sensitive class
  Nova holds — treat it as private content under the existing rule,
  never shipped to cloud Jev to check it); local-only is local only.
- Cloud shipment of capture text in cloud mode is per-source
  OPT-IN, off by default, and the setting says what it does in
  plain words ("screen text from this capture source may be sent
  to the decision provider for safety checks").
- Deterministic checks stay first: known sensitive apps/windows
  (password managers, banking) pause or exclude capture without
  any model call, per the capture design. Jev handles the grey
  area deterministic rules can't see (secrets inside ordinary
  documents and pages), it does not replace the structural rules.
- Screening verdicts are logged with the capture item's provenance
  (template version, provider, scores) like every Decision Service
  call, and a "sensitive" verdict on a frame is visible in the
  capture timeline — never a silent deletion.

Record this where the Decision Service ADR lists the Part 3
gate's content classes: add "capture-derived text (OCR and
transcripts)" as a screened class with the two jobs and the
provider rules above.
```
