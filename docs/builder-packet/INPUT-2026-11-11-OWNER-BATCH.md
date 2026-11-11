# INPUT 2026-11-11 — Owner batch: QA/UX loop and queue items 1–8 (owner direction, verbatim)

Filed verbatim as received (Jeremy, via Muse, 2026-11-11). The source file had sha256
`7a8efdb6a164de8aa90e60b31865d88497f94bfc819994ede7224622528d7fcf` (7,350 bytes); everything below the rule
is that file, byte for byte. Its reconciliation with the ledger, the ADRs and the open issues, with
the conflicts flagged and the owner's ruling list, is beside it:
[nova-owner-batch-reconciliation-2026-11-11.md](nova-owner-batch-reconciliation-2026-11-11.md).

---

Preamble (owner, same message):
This batch queues BEHIND the work already in flight — #499 CI/merge, the
scroll fix just ordered, #494's comparison. Those finish under their
existing orders. This batch governs what comes next; flag any conflict
with the ledger rather than dropping in-flight work.

OWNER BATCH — 2026-11-11 (Jeremy, via Muse). File into the packet, reconcile with
the ledger (ledger wins on conflicts — flag any conflict back, don't silently
resolve it), and work the queue in order under the standing orders: keep going
through milestones, merge as gates pass, never stop at a milestone boundary to
ask what's next. Items marked [DESIGN FIRST] produce a design/spec PR plus a
ruling list for the owner — no implementation until the owner rules. Everything
else is build-and-merge under the existing gates. Value per token cost governs
ordering inside the queue.
CROSS-CUTTING — QA/UX LOOP (standing, starts now, not a queue slot):
Four roles, run per-merge and on a schedule, not as one-off audits:
(1) WALKER (QA engineer): exercises the served app by interaction — typing,
completing flows, failure postures (offline, empty states, first-run, denied
permissions) — across the posture matrix; findings ship with evidence, severity,
repro steps. (2) DESIGNER (UX engineer): turns findings into compositions/specs
judged against the reference board and design system; "easy to use" is measured
(task success on core flows, time-to-complete, existing CLS/INP/contrast gates),
not asserted. (3) VERIFIER: a different seat re-walks the fixed build on the
served preview and confirms; nobody grades their own work. (4) BUILDER: you —
implement only findings that survive review or owner ruling; every confirmed
defect becomes a permanent probe. Findings are proposals until ruled. Budget
rule: rank findings by user impact per token.
QUEUE:

1. [BUILD] SCREEN CAPTURE, first-party. Behind the Nova Capture API, Screenpipe
   ingest as the first source. Captured memories land in the review queue
   (F-034 discipline: triage/digest only until confirmed). Desktop first; iOS
   cannot passively capture other apps and is out of scope as a capture source.
2. [DESIGN FIRST] SELF-INVESTIGATION / AUTO-FIX LOOP. Nova opens an incident on
   itself: detect (health, failed tasks, red checks) → gather evidence →
   diagnose → fix inside approval tiers → verify → journal. Capability- and
   invariant-based ("a scheduled task failed", "a check went red"), never
   per-known-bug scripts. Every auto-fix ships with a regression test and a
   rollback or it doesn't ship. Owner's D5 semantics apply: a failed task is
   "Needs you" amber only after the fix attempt fails or hits a tier boundary.
3. [BUILD] WORK SYSTEM — promote Relay's pipeline as the spec; do not rebuild
   it. Relay v0.8 already implements: editable task plan with acceptance
   criteria written BEFORE work starts → isolated-worktree worker → validation
   in a fresh process with false-pass guards (empty/skipped-only runs FAIL) →
   consented build stage → browser-verifier evidence → acceptance gate
   requiring exact tree-hash match between validated and reviewed bytes.
   Nova's work system generalises it: stages compose per task type (code:
   tests+build+browser evidence; research: source-check + second-model pass;
   settings change: re-read of served state; trivial: solo run). Invariants at
   every scale: acceptance criteria precede implementation; the implementer
   never verifies its own work; durable role profiles (Relay's profile
   contract: roles grant no permissions; runs snapshot the profile used).
   Coding runs it literally via the Relay adapter; other task types run
   lighter compositions of the same stages.
4. [DESIGN FIRST] FEATURE PACKS. Capabilities (Coding, Media generation,
   Smart home, Capture, others as they land) that can be enabled, disabled,
   and downloaded. A disabled pack leaves ZERO UI trace — no nav entries, no
   greyed placeholders, no settings stubs. Precedent to study: legacy Nova's
   feature-flags runbook and 2026-05-05 feature-flags design (on the Dell,
   arialabs/nova v0.1.0-alpha tree) — flags are the mechanism, packs are the
   product surface; do not confuse the two. The Coding pack governs Relay and
   coding-agent surfaces. MCP connections (e.g. Higgsfield, below) attach to
   packs, not to core.
5. [BUILD] PAIRING CLOCK FIX. The Nov 7 failure: pairing codes expire in ~7
   minutes, approval windows in ~2 — real-device pairing died on the clocks.
   Lengthen/repair the windows within the security design (hub-side approval
   remains the real gate). This unblocks item 6 and is a desk-session test
   with the owner.
6. [BUILD — after 5] NATIVE iOS SPOKE APP. Sideloadable build for the owner's
   phone first (paid developer signing); PWA remains the cross-device surface.
   The app is a spoke: it pairs, it does not capture.
7. [DESIGN FIRST] DOMAIN + INGRESS + BUNDLED MESH. Public name:
   nova.arialabs.ai. The domain is a name, not reachability: design a gated
   public ingress (console auth in front) while the tailnet stays the private
   path. Bundled networking: ship Headscale (BSD-3, open-source Tailscale
   control-plane implementation, works with official Tailscale clients) on
   the hub, on from first boot, as Nova's own mesh; hosted Tailscale remains
   the zero-config alternative. Note Headscale lacks Serve/Funnel equivalents
   — the ingress must be Nova's own work.
8. [BUILD — sequenced with the queue] VISIBLE UI + IMMERSIVE MEMORY (the
   "Brain"). The immersive memory surface ports the LEGACY experience onto
   the current graph: legacy arialabs/nova v0.1.0-alpha had a full-viewport
   3D memory graph (ForceGraph3D) — memories as luminous stars (importance →
   brightness), color modes by cluster / engram type / importance, a Topic
   Map (clusters as super-nodes sized by memory count, click to drill in),
   designed for live reaction to retrieval. Port the experience; do NOT port
   the legacy engine: no pgvector (bundled SQLite takes no extensions —
   settled in ADR #481), and nodes remain pointers to records, never content
   copies, so deletion stays absolute. Two independent reviews of the legacy
   tree (Muse's and Astra's) are in flight; their merged findings will be
   filed as the reference input for this item — design against them, not
   against this paragraph. Settings hierarchy inversion and the collapsed-rail
   literal "v" are already-filed defects and belong to this item's first PR.

ATTACHMENT — MEDIA GENERATION (to item 4): Higgsfield MCP is the first media
pack candidate. Facts (verified 2026-11-11): official hosted MCP server,
OAuth sign-in, 30+ image/video models; clips capped at 15 seconds and silent;
MCP generations always consume paid credits (plan "unlimited" generations are
web-only). It attaches as an optional MCP connection behind privacy/egress
screening; in local-only mode it does not exist.
STANDING REMINDERS (already rules — restated because this batch touches all
three): Nova's own computer/browser only, never the owner's personal browser;
progress is what's SERVED (version endpoint is ground truth), never merge
counts; when a decision is the owner's, return it as a labelled ruling list —
do not decide it in the owner's place.
