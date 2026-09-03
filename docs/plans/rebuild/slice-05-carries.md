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

## The DoD — MET mechanically; LIVE WALK 2026-09-03 (owner, remote, local model)
Walked from another machine over the tailnet/public gate: (2) default-grant
refusal + grant flip — seen on day 1; (3) "how much disk is free" → 905.6 GiB
real number via device_info; (4) device_run auto after the owner's disposition
flip; the honest-OFFLINE half of (5): with novad stopped she checked
(device_info refused not-connected, fact recorded), confirmed via device_list,
said offline plainly, NO correction — then online again → real number; the
listing: tree missing → honest refusal → adapted to find in one turn, no XML,
no dangling intent. Not walked: revoke (6), kill-network staleness timing,
apps.launch. Web label bug found and FIXED (30eecb60): the `{activity}` error frame now
carries the tool's stated `reason` (≤160 chars, ERROR_PREFIX-stripped) and
the bubble renders `<tool>: <reason>` / `<tool> failed`; "did not finish" is
reserved for a genuinely interrupted stream. Carry: the generic "failed
unexpectedly — <exc>" path now surfaces ≤160 chars of an exception to the
browser — no credential-bearing tool exists yet; revisit when the secrets
store lands.

### (original close-out note)
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

## Third post-close wave (2026-09-02, later) — "still offline" with no check; the cap ate the answer

Trace: "try again" → ZERO tool calls, the reply parroted an earlier (then-true)
"offline" from history — a claim about LIVE state with no check this turn,
and it was ingested. "The device is online." → she checked (tree not
installed — honest), adapted to find (exit 0), then burned the 6-round cap on
a leaked-XML device name + `which tree`; the reply was ONLY the cap note.
Fixed in 29994e29 + 2bd4f981 + review-fix 0e689d53 (adversarial review: 1
Critical + 4 Important, all executed repros; core 968):
- **state_claim guard**: a claim about a paired device's live connectivity
  ("the device is still offline", "<name> is online") with no device check
  this turn is REPLACE-class with ONE guard-vetted retry (same generalized
  `_claim_redirect`, one budget, gated on nothing-ran / not-out-of-rounds /
  no card raised). Precision-first: subject = a paired NAME or "the/your/
  this/that device" only (bare laptop/machine/computer nouns fired on ANY
  computer — removed); state words narrowed to unambiguous connectivity
  (up/down/available/"connected to the projector" were false positives —
  removed; `connected` only at clause end/"right now"/"to the network").
  **A refusal that DETERMINED connectivity is a check** (the Critical: when
  the device is really offline every tool refuses "not connected", and the
  honest "it's offline" was being corrected into a lie) — mechanically via
  `ToolContext.facts_sink`: `_require_connected` records {device, connected}
  for both outcomes, `_run_tool` copies it into span meta["facts"], the
  guard reads it as data. Fired-and-not-redirected → never ingested.
- **The round cap runs one tool-less narration round** so the answer the
  work earned is delivered, then the note; backend notes survive any
  REPLACE composition; the deferral redirect is gated on out_of_rounds;
  tool calls in any closed round are refused with a span, never dropped.

Carries from this wave:
- Accepted misses, pinned as a deliberate list (ACCEPTED_MISSES in
  test_state_guard.py): "it's offline" (bare pronoun), "the device is back",
  "both devices are offline", "the device is down/up right now", "not
  responding", "I ran a check — the device is offline" (intent token).
- A device NAMED a common word ("office", "home") arms the guard on unrelated
  prose — semantic; a naming caveat for the pairing UI.
- (CLOSED same day, cc49d17a) `facts_sink` was written in one place; an AST
  allow-list pin now walks app/ for every connectivity read (is_connected,
  connected_ids, _conns.get) and requires each site to record or be a
  documented reporter — mutation-tested (an unlisted call reddens it). It
  immediately found the hub's send-time re-check recording nothing; fixed
  (a socket dying between precheck and send now ends the span's facts on
  connected:false). Also: the vacuous headline C1 test (its sentence carried
  the intent verb "check") re-pointed so it discriminates; the doubled fact
  on a fully successful call deduped (last-entry only, so real transitions
  still record).
- Device READ tools are ephemeral, so a state-claim redirect that succeeds via
  device_list/device_info is still not ingested (correct — "offline" must not
  become durable knowledge); only device_run/write/launch turns ingest.
- The web drops `{correction}` SSE frames as an unknown type (ruling S2-R6),
  so guard corrections reach the screen only via the persisted reconcile,
  never live — the operator watches the wrong text stream and then flips.
  Render correction frames (replace the streamed text) in a web polish pass.
- The local model (muse-glimmer) keeps leaking `<atem:parameter …>` XML into
  a JSON arg (refused cleanly, costs a round each time) and re-checks
  (`which tree`) — model quality; measure it with the S4 harness; consider
  agents.max_tool_rounds 6 → 8 for it (owner's dial).
- One false "still offline" line from 23:51 was ingested into memory before
  the guard existed; there is no operator surface to see or correct memory
  in v4 yet (the memory-surface slice's motivating carry). Mechanically
  neutralised: the guard refuses any unchecked state claim regardless of
  what recall surfaces.

## Fourth post-close wave (2026-09-03) — a tool call written as TEXT became the reply

Trace: the consent guard's retry worked (device_run tree → "not found",
honest), then in the tool-less closing round the model wanted `find`, had no
tool to call, and EMITTED THE CALL AS XML TEXT (`<atem:function_calls>…`); it
passed all honesty guards (an attempted action is not a lie) and was
persisted as the answer. The local model (muse-glimmer) speaks Claude-style
XML tool syntax under pressure. Commits 966b08e3..0655ee1a (core 1039):
- **Markup in reply text is never an answer**: a pure parser recognises
  Claude-style `<P:function_calls>` blocks (any namespace) and Hermes
  `<tool_call>{json}</tool_call>`; in every round the parsed calls are
  REFUSED via the shared `_refuse_call` with a stated, retryable reason
  ("you wrote a tool call as text — re-issue it as a tool call"), the markup
  is stripped, an honest backend note survives REPLACE when nothing else
  remains, and `_persist_assistant`/memory-ingest strip any unquoted
  readable markup by construction. Quoted examples (fenced code, blockquote,
  inline code) are masked and stored byte-for-byte.
- **RULING (controller, 09-03): tool-call markup is NEVER DISPATCHED, in any
  round.** The first cut parsed open-round markup into real calls; three
  adversarial reviews in a row found a Critical in that half — a fenced
  "here is what a call looks like" EXECUTED; a nested quoted block bled its
  `argv` onto a live call; the fence/quote mask then blanked structural
  tags out of the doubt check so `["rm","-rf","/"]` migrated between
  invokes and ran. Each fix moved the hole; the refuse-and-note half held
  under every attack. So the dispatch path was removed (one refusal line in
  `_dispatch_calls`, the single place every call passes), the doubt/residue
  machinery deleted, and "prose cannot cause an action" is now the same rule
  as precision-first. See memory [[prose-never-causes-an-action]].
- Migration 015 backfills pre-014 rows to plumbing (the continuation
  template anchored both ends; the waiting-note; assistant rows carrying
  markup) so the choreography and the stored XML reply stop poisoning
  history. The inline-code regex was superlinear on a backtick run (12k →
  11.8 s, event-loop blocking) — bounded to 1–3 backticks / 2,000 chars,
  20k backticks pinned < 50 ms.

Carries from this wave:
- The live screen still streams the raw XML deltas before the scan runs;
  only the durable record is clean (the same web gap as corrections not
  rendering live — a new frame type the web honours, or buffering per round).
- A block whose only invoke is unreadable, or a real block wholly inside an
  unmatched backtick pair / unterminated fence, is left as inert text (an
  XML fragment may show; it can never act).
- Migration 015's markup clause can mark a prose mention of
  `</function_calls>` as plumbing and misses bare-invoke/casing variants —
  one-time, under-inclusive direction, stated in the SQL header.
- "try again" → she checked (good) then ASKED which directory instead of
  acting on an explicit instruction — a deferral-by-question the deferral
  guard does not cover; unobserved cost, note only.

## Public access wave (2026-09-03) — the owner on a device without Tailscale

Need: reach Nova from a browser on a machine that cannot run Tailscale, with
"an access token of some kind". Shipped (05a1c0c9 gate; ba8e7810 healthz +
device-WS carve-out; 81a68e9e + ae0d7705 the markup-scan bound + its
correction):
- **Pre-auth token gate** in the web nginx (template + envsubst filtered to
  `^NOVA_`): with `NOVA_PUBLIC_GATE_TOKEN` set, every browser-facing location
  (SPA, assets, /api/*) is 401 with a neutral "Access" page unless cookie
  `nova_gate` equals the token; `GET /gate?token=<T>` sets it (HttpOnly,
  Secure, SameSite=Lax, 30d) and 302s home; blank token = gate off
  (byte-equivalent to before). Pinned by apps/web/gate_test.sh (29 curl
  checks against throwaway containers, in CI). Verified live on :3000 and
  through Cloudflare's edge.
- **Two deliberate carve-outs**, each mechanically justified: `/healthz`
  (static "ok", self-only — the compose healthcheck now targets it; `GET /`
  read UNHEALTHY behind the gate) and `location = /api/v1/devices/ws` (the
  device socket is self-authenticating — core's ed25519 challenge — so the
  cookie gate only locked out legitimate daemons: enabling the gate knocked
  the owner's paired device OFFLINE because novad had been enrolled against
  http://localhost:3000). Lesson: before gating an origin, enumerate its
  NON-browser clients.
- **Tunnel**: a cloudflared quick tunnel (no account) on the WSL host →
  random `*.trycloudflare.com` URL; temporary, changes on restart. The
  tailnet URL https://nova.tailba0abb.ts.net also serves v4 now (the old
  nova4 tailscale node reconnected to nova_default) — interim for S5b.
- **Markup-scan bound**: the quadratic on repeated unclosed openers is killed
  by an O(n) closing-tag presence pre-check (7.7 s → 7 ms at 256 KB); the
  first cut's small body caps silenced realistic large calls (a >4 KB
  device_write_file markup call leaked as raw XML — the original bug) and
  were replaced by a 1 MiB body bound (200/300 KiB calls recognised +
  stripped, no orphan wrapper tags) — which the next review showed was NOT a
  bound either (33k fake openers with one closer >1 MiB away → 1.8 s, 40k →
  47 s). The real bound (bc691e87): a HARD SCAN WINDOW — only the first 1 MiB
  is ever matched, the remainder returned untouched and marked unparsed;
  with window == body cap a closer inside the window is always reached on the
  first attempt, so cost is O(window) by construction (100k openers / 5.4 MiB
  → 29 ms). Lesson: a per-attempt cap is not a bound when the attempt COUNT
  scales with input; bound the input.

Carries:
- Pairing a NEW device through the gated public origin is unsupported
  (/api/v1/devices/enroll stays gated; pair via localhost/tailnet). S5b/S6
  decide whether enroll joins the carve-outs (it is code-gated + rate-
  limited by construction).
- The login rate limiter is per-IP; behind a tunnel every visitor is a CF
  edge IP → a global 5/15 min window (fails closed). Reading X-Forwarded-For
  from a TRUSTED proxy only is the S5b fix.
- The session cookie is still `secure=False`; works over HTTPS but should
  derive Secure from X-Forwarded-Proto (S5b).
- The quick tunnel is a process on the host, not a compose service: it dies
  with the box and its URL rotates — S5b's tailscale service (+ Funnel for a
  stable public hostname) is the durable shape; the gate stays in front.
- The cap-raise commit (ae0d7705) shipped to core via a `--build`
  dependency side effect before its re-review finished; use `--no-deps`
  when redeploying one service.

## Day-3 wave (2026-09-03) — "Checking…" with no action; corpus v2; the window's edges

Trace: "show me my workspace directory structure" → "Got it. Checking the
workspace…" (zero tool calls); "how much disk is free on DELL-XPS-8950?" →
"I'll check the disk usage for you." (zero tool calls). Neither the
commitment-form deferral guard (needs a web/fetch phrasing after "I'll") nor
any other guard saw them. Both models pass agent_quality v1 7/7 — v1 (the S3
walk's failures) is blind to this week's five shapes.
- **bare_intent guard** (70d7c54e, 1f50b993, e04db9f0): a reply that is ONLY
  an acknowledgment/intent to act — present-progressive ("Checking…"),
  stock ("On it", "One sec"), or first-person future ("I'll check/look
  into/run <object>") — with no successful tool span is a deferral: one
  guard-vetted retry with tools via the shared `_claim_redirect` (single
  budget; gated on out_of_rounds/card_raised), else an honest note that
  NEVER says "did not" when the retry's tool actually ran (derived from
  spans: "[I ran <tool> but could not report…]"). Precision held under two
  adversarial rounds (hedges, questions, content-bearing, past tense) after
  narrowing `run`/`look`/`get` to command-shaped objects with idiom-head
  lookaheads ("run out of/late/to", "look forward to", "get back to") and
  dropping `see`. Mutual exclusion with deferral_check pinned.
- **Markup scan window, corrected twice** (8eb80bd6, 07217168): a call whose
  wrapper closer straddles the 1 MiB edge is left intact+unparsed (never
  half-stripped); the dangling-opener rule that achieved it is gated on
  actual truncation, because ungated it let a prose mention of
  `<function_calls>` silence a real call later (raw XML persisted — the
  original bug by a mundane trigger). Residual: inside a truncated (>1 MiB)
  reply, an in-window prose mention still suppresses later free invokes.
- **agent_quality v2** (d2d1e868): 12 cases, suite_version 2, device-free —
  the five observed shapes as mechanical contracts (tool_succeeded /
  reply_matches(\d) / guard_absent(consent_claim) / reply_absent
  (function_calls) / tool_called), setups mirroring the real poisoning.
  v2's `no-fabricated-pending-workspace-read` case required tool_succeeded,
  which punished an honest "no such file" read against the eval workspace's
  own missing fixture; fixed to tool_called and the whole corpus bumped to
  suite_version 3 (see docs/plans/rebuild/slice-04-carries.md and
  test_eval_corpus.py). The owner re-measures both models on v3 after the
  redeploy.
- Ops: novad moved to a systemd user unit (survives restarts once
  `loginctl enable-linger` is run with sudo); each review/impl agent now uses
  its own scratch database (concurrent suites on one DB raced TRUNCATEs).

Carries:
- The truncated-window prose-mention suppression above (only for >1 MiB
  replies; inert direction).
- `chat.py` sets no max_tokens on ordinary rounds — a repetition-looping
  model can still produce multi-MiB replies; the scan is O(window) now, but
  a token ceiling is the upstream fix (owner's dial via settings later).
- Bare-intent misses are the accepted precision trade: "I'll see about
  that.", "I'll get back to you shortly." (genuine later-promises).
- The local model (muse-glimmer) produced five distinct fabrication shapes
  in three days; each is now caught mechanically at the cost of a redirect
  round. Corpus v2 is the instrument; the owner decides the model.
