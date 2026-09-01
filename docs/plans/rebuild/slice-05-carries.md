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
