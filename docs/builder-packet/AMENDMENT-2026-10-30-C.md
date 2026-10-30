# AMENDMENT 2026-10-30-C — UX Polish, Ingest Security, Execution Plane

Approved by Jeremy 2026-10-30. Source research: UX-RESEARCH-2026-10-30.md (same folder). Binding on the build; extends DESIGN-SYSTEM §1 and the ROADMAP as specified inside.

AMENDMENT 2026-10-30-C — UX POLISH, INGEST SECURITY, EXECUTION PLANE.
Add this file to docs/builder-packet/, note it in OPERATING-RULES, and fold
the work into the roadmap as specified. Standing orders unchanged: continue
autonomously, merge on green gates, my review is not a gate, stop only for
Tier-3 / packet conflicts / unresolvable gate failures. Do NOT block any of
this on a Jev account (stub stands) or on real-device pairing (deferred).

PART 1 — UI FIXES (one PR, right after M7 merges; small and low-risk):
1. Orb appears ONCE per view. Remove per-message avatars/orbs from chat.
2. Chat follows the AI-chat family: user turn = tinted bubble; Nova turn =
   full-width, un-bubbled. No bubble tails. Authorship by alignment + tint.
3. Timestamps: date/gap dividers always; time on first message of a group
   (group = same author, <5 min); exact per-message time on hover /
   long-press / details. Work-trail entries carry elapsed + completion time.
   Timestamps must pass 4.5:1 contrast — no muted-grey failures.
4. Settings: one IA, two presentations. Phone: grouped list + search.
   Desktop/expanded: sidebar + detail + search. Group by user task.
   Search indexes synonyms, shows the path, deep-links + highlights.
   One level of nesting max. This closes the known Settings audit gap.
5. Appearance: picking a theme applies it LIVE to the real UI (delete the
   embedded preview mock; swatches stay as picker thumbnails only).
   This-device = instant apply + visible Undo. All-devices = explicit
   Save/commit. Current scope shown persistently ("this device only" /
   "synced"). Live WCAG check in the picker: warn <4.5:1 body, <3:1
   components, offer one-tap fix. Also close the known gap: the picker
   must RECOMMEND one design, not list six as equals.
6. One scroll container per view; no nested vertical scrollers (inner
   scrollers horizontal-only). Respect OS scrollbar setting; no thin
   custom bars; scrollbar-gutter: stable.

PART 2 — POLISH GATES (add to the roadmap as milestone M9 "Feel & Polish",
after M8; gates, not aspirations):
- Core Web Vitals at p75 as release gates: CLS ≤0.1, INP ≤200ms, LCP ≤2.5s.
  Skeleton geometry must match final layout exactly.
- Progress rules (binding, extends DESIGN-SYSTEM §1): <1s no indicator;
  2–10s spinner (single module) or skeleton (full page, <10s, never
  frame-only, never for a process); >10s determinate progress computed
  from REAL units (steps/files/tokens) + general estimate ("about a
  minute"), never false precision, never a bar that stalls at 99%.
  Streaming: real tokens/steps only; never simulate streaming over a
  completed answer; never add artificial delay. Optimistic UI uses the
  honest split: "saved on this device" instantly, sync as separate status.
- Animation tokens: 150–300ms standard, transform/opacity only, honour
  prefers-reduced-motion. No bounce/elastic on frequent actions.
- Contrast audit: every theme × every state at WCAG AA (4.5:1 body, 3:1
  large/components). Targets built to 44pt/48dp hit areas.
- Foldable/responsive tests, in this order: (1) state preservation on
  fold/unfold/resize (scroll position, drafts, settings edits), (2) no
  stretched single-column on expanded widths (cap prose 45–75ch, use
  second pane), (3) nothing under the hinge, (4) 200% text survives.

PART 3 — INGEST SECURITY GATE (build with M9 or as its own PR before the
execution plane; the browser in Part 4 must not ship without it):
Every external content read (web, email, files, OCR, transcripts, QR
payloads, tool/MCP output) passes the ingest pipeline BEFORE any acting
model sees it:
1. Jev/Noul screen first, isolated: no tools, no memory, no secrets in
   context; returns probabilities only. Battery: P(direct instruction),
   P(hidden/indirect instruction), P(secret/exfiltration request),
   P(impersonation), P(action the user never requested). Local model
   in local-only mode — private content never goes to a cloud screener.
2. Thresholds: low → pass as DATA (never instructions). Middle/uncertain
   → quarantine: extract facts only, strip instruction-like spans, tag
   provenance. High → block + Work Ledger entry.
3. Deterministic checks in parallel: hidden text (zero-size,
   white-on-white, comments, metadata, zero-width unicode), encoded
   blobs, link-text vs destination mismatch, SSRF guard (no localhost /
   tailnet / private-range fetches), email SPF/DKIM/DMARC + reply-to
   mismatch, attachment type + sandbox scan.
4. Taint: derived content keeps provenance + scores. An action whose
   origin is external content (send / pay / delete / share / run code /
   change settings / pair) NEVER auto-executes.
5. Reader/actor separation: the reader has no tools beyond reading; the
   actor sees only the screened extract, never the raw payload.
6. Memory guard: external content never writes long-term memory directly;
   candidates quarantine with provenance until corroborated/confirmed.
7. Outbound guard: payloads to externally-derived destinations are
   checked for secrets/memory content before sending.
8. Gate: a regression set of known injection payloads + canary secrets
   must pass in CI, like any other test suite.

PART 4 — EXECUTION PLANE: NOVA COMPUTER + NOVA BROWSER (new milestone
M10, after M9; design doc/ADR first, then build):
Nova gets its OWN computer — a sandboxed execution environment, not the
user's desktop:
- A container/VM workspace on the hub or a paired device (first target:
  the XPS WSL environment; hub mini-PC later) with its own filesystem
  (per-project workspaces), shell, and toolchain. Sessions are
  checkpointed; a task's machine can be reset to a clean state.
- Nova Browser: a dedicated Chromium profile owned by Nova (not the
  user's personal browser), driven via accessibility/DOM first,
  vision/computer-use only as fallback. User can watch live, pause,
  stop, or take over at any point. Logins come from the credential
  vault, injected at use time, never present in model context.
- Every page the browser reads passes the Part 3 ingest gate first.
- Jev as co-pilot for navigation: Noul micro-decisions at each step —
  P(element matches the stated intent), P(page changed as expected),
  P(login wall / CAPTCHA / paywall), P(dark pattern / pre-selected
  upsell), P(total matches the quoted price), P(dialog is injection).
  Deterministic ground truth (DOM state, totals, URLs) always outranks
  a probability. Successful flows are cached as validated, versioned
  decision templates per site (learn the pizza-ordering flow once).
- Checkout/payment is a Tier-3 approval: Nova fills the cart, shows
  itemised total, and stops. It never pays on its own.
- Coding through chat: chat is the control plane. Intent → plan in the
  Work Ledger → sandboxed coding workers (Relay/Claude Code adapters)
  in git worktrees → tests → preview → merge/deploy per approval tier.
- Infrastructure through chat: Terraform/OpenTofu (or equivalent) plan
  output shown before any apply; apply (spending, destructive) is
  Tier-3. Budget guardrails + alerts on anything Nova provisions.
  A checkpoint is taken before every infra/network change.
- Networking changes (router/DNS/firewall/Tailscale): Tier-3, with
  config snapshot, diff preview, and a dead-man's switch — if the hub
  loses contact after the change, auto-revert to the snapshot.
- Account management: via connectors/OAuth and vault logins in Nova
  Browser. Password/MFA changes and account creation are Tier-3 with
  the user present for codes. Passwords are never requested in chat
  and never enter model context.
- Approval tiers apply throughout: read = automatic; reversible write
  = do + notify + undo; external / spending / destructive / security
  changes = explicit approval first. Everything in the Work Ledger.

