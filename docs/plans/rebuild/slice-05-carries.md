# Slice 5 — Agent daemon v1 (novad): close-out + carries

Written at S5 code-complete (2026-08-31). S5 shipped on rebuild/v4 (never
pushed): the first code in the tree that runs OUTSIDE the compose stack, on a
paired machine. Authority leaves core only as ed25519 one-use signed envelopes
verified ON the device; the LLM never talks to the daemon (only core does,
through the same dispatch→policy.authorize funnel as every other tool).

## Commits (SDD: 5 tasks, per-task review + fix loop, whole-branch final review)
- **T1** device registry + pairing + ed25519 envelopes: 410b7f7a..bbbdc2c6
  (+ ruling R1 lint cleanup 120a5ed0). migration 011.
- **T2** WS hub + 9 device tools + schema items.type + migration 012:
  edd5c54c..639dc787, fix f7a3a699 (fs `..`-traversal tripwire + stated
  send-failure). Tripwires moved deliberately: tool registry 8→17;
  action_classes now 6 device auto / 3 device consent (device_run,
  device_write_file, device_launch_app — the irreversible set).
- **T3** novad (Go): 812ab221..f8a2863a, fix 01b5de61 (refusal-audit + TOFU
  tripwires; astral test; utf8 truncation; mechanical read cap; symlinked
  deny-roots). Go 1.27, sole dep coder/websocket, byte-identical canonical
  encoder pinned against the committed fixture, hash-chained audit.
- **T4** Settings→Devices web: 972db617..70029a11, fix 29e39b5e (device-scoped
  checkbox id — the cross-toggle bug; unmount tripwire; backend-matching `..`
  refusal; grant list no longer trimmed to the rendered set). Tile liveness
  DERIVED from last_seen freshness + a 15s poll; nginx WS location.
- **T5** DoD tripwire + e2e: 61630f2f..63532ae5. test_devices_e2e.py — a
  model-independent walk of all six DoD outcomes with an HONEST FakeDevice
  (verifies core's signature 3 ways, real hash-chained audit) driving the real
  devices_ws.serve socket path; 16-devices.spec.ts authored-not-run.
- **Final fix wave** (whole-branch review, SHIP-WITH-FIXES): 424f5be7,
  d3607d0e, 025aa648 — I1 seen-set spans the validity window not the
  connection; M2 device_write_file 256 KiB stated cap both sides; M1
  lone-surrogate args refused on core before signing (code matches comment).

Suites at close: core 794 / novad 47 (+ -race) / web 385, 0 skips; ruff + vet
+ gofmt clean; the committed envelope vectors + chain-hash vector + the DoD
tripwire green.

## The DoD — MET mechanically, PENDING the owner's live walk
The six DoD outcomes are proven MECHANICALLY end-to-end by test_devices_e2e.py
(a fake device speaking the real protocol against serve(); a deny is asserted
to leave ZERO command frames AND no device_audit row — the "Activity proves
nothing ran" bar, on a second machine). The LIVE half — Jeremy pairing a real
laptop, "how much disk is free?", deny/approve "open Firefox", kill the network
— is the OWNER's gate and is PENDING his time. Build/enroll/run instructions
are in .superpowers/sdd/slice-05-daemon/task-5-report.md §"How to run the live
walk" (novad build via mise go 1.27; enroll against :8000 direct, or the :3000
origin once the rebuilt web with the WS nginx location is deployed).

## Carries (final-review-agreed; each named to its owner)

- **M3 — audit reset-to-0 drops exactly one entry silently (S6/hardening).** If
  the daemon's local audit JSONL is lost while core still holds last_seq=N, the
  daemon reopens at seq 0; ingest hardcodes expected_prev="" at seq 0, the new
  self-consistent hash verifies, and `ON CONFLICT (device_id, seq) DO NOTHING`
  drops it with NO device.audit_break (the break fires only on the *second*
  post-reset command). One-command-wide window; the command still ran and core
  has its turn_span + signed-envelope record, so "did it run" is answerable
  server-side. Close when the daemon signals a chain reset on reconnect (a
  distinct frame), so core can open a fresh chain deliberately instead of
  silently coalescing.
- **M4 — a symlink INSIDE a granted fs_root pointing to a non-deny path is
  followed (S6/hardening; DOCUMENTED design, not a regression).** Core's
  allow-boundary is lexical (posixpath.normpath prefix); the device re-checks
  only deny-roots, not fs_roots. So `/granted/root/link → /etc/passwd` passes
  both. ~/.ssh, ~/.gnupg and the daemon's own custody dirs stay protected
  (deny-roots resolves symlinks symmetrically). Requires a pre-planted symlink
  (local access). The design is "lexical allow-boundary + deny backstop";
  making the device re-verify the resolved target is under a granted root would
  close it.
- **M5 — hub + enroll-limiter are in-memory process globals (whenever core
  scales out).** Correct for the pinned single-core household deployment; a
  multi-worker core would give N× hub registries and N× enroll budgets. Note it
  if core ever runs >1 worker.
- **T1#1 — the enroll rate-limiter's "only a 403 increments" has no tripwire
  test.** The limiter is adequate (a shape-valid request is required before the
  burn, so a bad-code test always 403s and is counted; 5/15min globally makes
  31^8 brute force infeasible), but the property isn't pinned. Add the one-line
  test that a 400/409 refusal does NOT increment the window.
- **T4#5 — nginx WS location hardcodes `Connection: upgrade`** instead of the
  `map $connection_upgrade` idiom. Safe because the location is WS-dedicated
  (single upstream); revisit only if one location ever proxies both WS and
  non-WS.
- **T4#6 (pre-existing, not S5) — ui/Input emits aria-describedby
  "undefined-error"** when only aria-label is set; lives in ui/Input.tsx, fix
  when that component is next touched.
- **Smaller deferrals:** T1 degenerate-input 422 vs house {error} shape
  (service-wide pydantic pattern); T1 grants_changed on a no-op resubmit;
  T1 pairing_codes never pruned + no code_hash-collision guard; T5 e2e
  one-liner selector is origin-sensitive (config.baseUrl vs
  window.location.origin) — expect it on first live run; T5 FakeDevice
  _seq/_prev_hash underscore dataclass kwargs (cosmetic).

## Owner-facing / operational notes for the walk
- A revoke leaves the daemon RETRYING on the 30s-capped backoff (each attempt
  refused at the challenge) rather than exiting — a re-grant heals without a
  restart (T3's stated default; flip to exit-on-4403 is a one-liner if wanted).
- apps.launch reports the launcher dispatched, not that the window appeared —
  the visible window is the human's confirmation. apps.launch / system.notify
  need a graphical session (DISPLAY/DBUS); run `novad run` in a desktop
  terminal for the walk (systemd-user + linger is the always-on path, S6
  hardens the graphical-session wiring).
- Staleness rides core's clock (last_seen on heartbeat receipt), threshold 60s
  + 15s poll, so a killed network reads stale in ~60–75s.

## Process
SDD per task (implementer opus; reviewers opus, re-reviews sonnet/opus scaled
to the diff); each task reviewed for spec + quality with a fix loop; a
whole-branch adversarial final review (opus) → one fix wave → one scoped
re-review; every review that ran a suite ran it for real (reviewers reran Go +
core + web and mutation-tested load-bearing tripwires). Commits on rebuild/v4
never pushed. A process lesson recorded to memory: a mutation-testing reviewer
that edits files must not run concurrently with another agent in the same
worktree — its revert/restore races with the other agent (it resolved cleanly
here by luck).

## Post-close fix wave (2026-09-02) — the device-tool friction from the owner's first walk

The owner's live walk (local model muse-glimmer, device DELL-XPS-8950) exposed
four mechanical gaps; fixed in e9afa46a..676d554f (verified by an adversarial
reviewer + a replay verifier that mutation-proved each fix site against the
exact observed sequences; core 841 / novad 48 / web 395).
- **Precheck before the kernel** (e9afa46a): `Tool.precheck` runs after schema
  validation and BEFORE `policy.authorize` and may ONLY refuse (D-012 intact).
  Device tools precheck paired→connected→granted→fs-path, so a card is never
  raised — and an approval never burned — for a call that cannot run (the 23:48
  wasted approval; the 23:58 card raised for a garbage device name). The
  executor keeps the same checks (defence in depth).
- **A raised card closes the tool loop** (1d1440ac): one tool-less narration
  round, then the turn ends — no wandering to the round cap, so the owner's
  approve lands after streaming and the web auto-continue fires (one click).
- **fs grants need a root; the device's home is suggested** (ad1adea6,
  migration 013 `devices.home_dir`): `set_grants` refuses fs.* with empty
  fs_roots (stated, no ledger row); novad reports home_dir at enroll and in the
  auth frame (additive optional field); the grants editor suggests it.
- **Owner disposition control** (59608403): `PUT /api/v1/autonomy/{class}`
  {auto|consent|deny} + a per-class selector in Settings→Autonomy, governance
  kind `autonomy.disposition_set` (before/after, actor). Operator-set auto has
  seeded-auto semantics (earned=false, never self-demotes). This is the lever
  for the owner's zero-approvals direction: seeds stay conservative for new
  installs; the owner flips his own instance, logged.

Carries from this wave (all Minor, final-review-agreed):
- Two deterministic args-only refusals still sit BEHIND the kernel: the
  256 KiB write cap and the lone-surrogate guard. A consent-tier oversize write
  raises a card and burns the approval on retry (same class as the 23:48
  defect, one refusal over); a lone surrogate makes `raise_consent` fail on the
  jsonb (fail-closed, but as a retryable "could not authorize"). Move both into
  the device precheck.
- Precheck-first means an attempt at a class the owner set to `deny` on an
  ungranted device is refused by the device layer and never reaches the kernel
  → no `policy.denied` row for that attempt (the tool span still records it).
- `PENDING_APPROVAL_NOTE` ("[waiting for your approval before continuing]") is
  persisted as the assistant text when the narration round emits only tool
  calls — true, but it is the shape [[consent-loop-context-poisoning]] names;
  watch whether the local model parrots "still waiting" on "Go ahead" instead
  of re-calling the tool.
- `clean_home_dir` bounds shape (absolute, no `..`) but not length or control
  chars — a device could store a huge/odd home_dir that the UI then offers as a
  root. Add a length cap + reject control chars.
- `PUT /autonomy/{class}` is `require_person`-gated only (any role, or the
  service bearer) and grants a STANDING auto — widens the S8 role-ceiling carry
  (owner-only is a one-line gate once roles exist; single-account today).
- Same-round trailing tool calls after a card-raising call still dispatch
  (only subsequent rounds close). Unobserved shape; close if it shows up.
- Docs: slice-05-daemon.md's "per-device layer inside the executor" and "12
  migrations" are superseded by this section.

## Second post-close wave (2026-09-02, later) — "try again" did nothing

The owner's next exchange (local model): "try again" on a device command →
the reply's whole stance was a fabricated "still awaiting your approval"
(no card pending, no tool call); the consent guard caught and replaced it,
but nothing retried and the correction promised a card that auto-tier
classes never raise. Root cause: approval choreography in history
("You're approved: … go ahead now", "[waiting for your approval…]") that a
weak model pattern-completes — [[consent-loop-context-poisoning]] again.
Fixed in dce3d19a, 7577f0a9, 532d3a34 + review-fix ea40afcf (adversarial
review found 1 Critical + 3 Important, all reproduced by execution and fixed;
re-review mutation-checked each; core 860 / web 397):
- **A fired consent guard now RETRIES once** (one regeneration, tools
  available, the truth stated) — but ONLY when the turn has no successful
  tool span and is not out of rounds (no double side effects, never past the
  operator's cap), and the regeneration must pass the FULL mechanical guard
  set (live consent re-check, narration against live spans, capability)
  before it may replace the durable text; otherwise the correction persists
  and the turn stays plumbing (not ingested). The nudge is derived and
  raises rather than state an untrue fact. Shares the single redirect budget.
- **Correction wording is mechanism-neutral** (no promise of a card).
- **Choreography is plumbing** (migration 014 `messages.kind`): the web
  sends `continuation_of` (consent id); core marks the continuation user
  message plumbing ONLY when the consent is this conversation's, this
  person's, and approved (scoped lookup — an unscoped id could hide any
  message from history); note-only replies are plumbing; history_window and
  its query exclude plumbing; a plumbing user message makes the turn
  plumbing (never ingested).

Carries from this wave:
- The redirect gate is blunt: ANY successful tool span this turn blocks the
  retry, even when the fabricated claim is about a different action than the
  one that ran (a search then a false "awaiting" about a device command).
  Safe side; narrowing needs the claim tied to an action class.
- `continuation_of` non-string values still 422 (string coercion only);
  unreachable from the web client. Coerce anything non-string to None.
- The capability leg of the regen check has no dedicated tripwire test (the
  narration leg does); add one.
- A regen that honestly says "awaiting" after the redirect itself raised a
  card persists as kind='chat' (only the exact note is marked plumbing) —
  memory is safe (turn is plumbing) but that narration replays into later
  history windows.
- The Approvals-page resume loads the ACTIVE conversation, so a card from
  another conversation falls back to kind='chat' (correct fail-open; the S3
  "cross-page continuation targets the active conversation" carry).
- The consent_claim guard span now wraps the whole redirect (seconds), so it
  reads as guard latency in Activity; a separate redirect_ms meta would fix it.
- Dead belt-and-braces loop after `assert memory.ingests == []` in
  test_chat_consent.py.
